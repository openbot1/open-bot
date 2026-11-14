/**
 * Context window manager — track a context window up to 1M tokens
 * (context engineering v2, v1.05 Team T4).
 *
 * The window is a list of *segments* (system prompt, anchors,
 * summaries, turns, tool results), each with a token estimate.
 * The manager:
 *
 *  - tracks total tokens and the usage ratio against the limit
 *    (default 1,000,000, the Gemini-class window; any model limit
 *    may be passed, inferred from the model name via the v1.02
 *    estimator),
 *  - raises threshold alerts at 50% / 80% / 95% (each fires once
 *    per crossing; `acknowledge` resets them after compaction),
 *  - evicts by priority when the window overflows: oldest turns and
 *    tool results first, then tier-3 summaries, tier-2, tier-1,
 *    then anchors — the system prompt is never evicted,
 *  - spills low-priority segments to disk (see `spillStore.ts`)
 *    when the in-RAM text budget is exceeded, instead of dropping
 *    them outright; spilled segments keep their metadata in memory
 *    and can be restored on demand.
 *
 * Everything is arithmetic on the v1.02 estimator — no model calls.
 */

import { effectiveContextLimit, estimateTokens } from './estimator';
import { SpillStore } from './spillStore';

/** What a segment holds. */
export type SegmentKind = 'system' | 'anchor' | 'summary' | 'turn' | 'tool-result';

/** One segment of the window. */
export interface ContextSegment {
  id: string;
  kind: SegmentKind;
  /** Compaction tier for summaries (1/2/3); undefined otherwise. */
  tier?: 1 | 2 | 3;
  /** Text content (kept in RAM until spilled). */
  text: string;
  /** Token estimate of the text (computed at add time). */
  tokens: number;
  /** Source turn/message ids (for the inspector + citations). */
  sourceIds: string[];
  /** Creation order (monotonic). */
  seq: number;
  /** True when the text lives on disk (see SpillStore). */
  spilled: boolean;
  at: string;
}

/** Thresholds the manager watches (ratios of the limit). */
export const WINDOW_THRESHOLDS = { warn50: 0.5, warn80: 0.8, warn95: 0.95 } as const;

export type ThresholdName = keyof typeof WINDOW_THRESHOLDS;

/** One threshold crossing (for alerts / UI). */
export interface ThresholdAlert {
  threshold: ThresholdName;
  ratio: number;
  usedTokens: number;
  limit: number;
  at: string;
}

export interface WindowManagerOptions {
  /** Model name (limit inferred) or explicit token limit. */
  model?: string;
  limitTokens?: number;
  /** RAM budget for segment text in bytes (default 64 MiB). */
  ramBudgetBytes?: number;
  /** Spill directory (required for disk spill; without it, spill is a no-op). */
  spillDir?: string;
  /** Tokens to reserve for the reply (default 4096). */
  reserveTokens?: number;
}

/** Eviction priority: lower evicts first. System is never evicted. */
const EVICTION_PRIORITY: Record<SegmentKind, number> = {
  'tool-result': 0,
  turn: 1,
  summary: 2,
  anchor: 3,
  system: 99,
};

/** Snapshot of the window for stats / inspector. */
export interface WindowStats {
  limit: number;
  usedTokens: number;
  reservedTokens: number;
  remainingTokens: number;
  usageRatio: number;
  fits: boolean;
  segmentCount: number;
  spilledCount: number;
  ramBytes: number;
  ramBudgetBytes: number;
  byKind: Record<SegmentKind, { count: number; tokens: number }>;
  byTier: Record<string, { count: number; tokens: number }>;
  thresholdsCrossed: ThresholdName[];
  evictedCount: number;
  spilledBytes: number;
}

export class ContextWindowManager {
  readonly limit: number;
  readonly ramBudgetBytes: number;
  readonly reserveTokens: number;
  private readonly spillStore?: SpillStore;
  private segments: ContextSegment[] = [];
  private seq = 0;
  private firedThresholds = new Set<ThresholdName>();
  private evictedCount = 0;

  constructor(options: WindowManagerOptions = {}) {
    this.limit = options.limitTokens ?? effectiveContextLimit(options.model ?? 'gemini-2.5-flash');
    this.ramBudgetBytes = options.ramBudgetBytes ?? 64 * 1024 * 1024;
    this.reserveTokens = options.reserveTokens ?? 4096;
    this.spillStore = options.spillDir ? new SpillStore(options.spillDir) : undefined;
  }

  /** All segments in insertion order (spilled ones keep metadata only). */
  list(): ContextSegment[] {
    return [...this.segments];
  }

  get size(): number {
    return this.segments.length;
  }

  get spilledCount(): number {
    return this.segments.filter((s) => s.spilled).length;
  }

  /** Total tokens across segments (spilled segments still count). */
  get usedTokens(): number {
    return this.segments.reduce((sum, s) => sum + s.tokens, 0);
  }

  get usageRatio(): number {
    return this.limit > 0 ? this.usedTokens / this.limit : 0;
  }

  /** RAM bytes held by in-memory segment text. */
  get ramBytes(): number {
    return this.segments
      .filter((s) => !s.spilled)
      .reduce((sum, s) => sum + Buffer.byteLength(s.text, 'utf8'), 0);
  }

  /**
   * Add a segment. Returns threshold alerts fired by this add
   * (each threshold fires once per crossing). When RAM is over
   * budget after the add, the lowest-priority in-memory segments
   * spill to disk automatically.
   */
  addSegment(input: {
    id: string;
    kind: SegmentKind;
    text: string;
    tier?: 1 | 2 | 3;
    sourceIds?: string[];
  }): ThresholdAlert[] {
    const segment: ContextSegment = {
      id: input.id,
      kind: input.kind,
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      text: input.text,
      tokens: estimateTokens(input.text),
      sourceIds: input.sourceIds ?? [],
      seq: this.seq++,
      spilled: false,
      at: new Date().toISOString(),
    };
    // Same id replaces the old segment (idempotent re-add).
    this.segments = this.segments.filter((s) => s.id !== input.id);
    this.segments.push(segment);
    this.spillToFitRam();
    return this.checkThresholds();
  }

  /** Remove a segment by id (true when found). */
  removeSegment(id: string): boolean {
    const before = this.segments.length;
    this.segments = this.segments.filter((s) => s.id !== id);
    if (this.spillStore?.has(id)) this.spillStore.drop(id);
    return this.segments.length < before;
  }

  /** Find a segment by id (undefined when absent). */
  getSegment(id: string): ContextSegment | undefined {
    return this.segments.find((s) => s.id === id);
  }

  /**
   * Check thresholds: returns alerts for thresholds crossed since
   * the last check (or since construction). A threshold fires once
   * until `acknowledgeThresholds` is called (e.g. after compaction).
   */
  checkThresholds(): ThresholdAlert[] {
    const alerts: ThresholdAlert[] = [];
    const ratio = this.usageRatio;
    (Object.keys(WINDOW_THRESHOLDS) as ThresholdName[]).forEach((name) => {
      if (ratio >= WINDOW_THRESHOLDS[name] && !this.firedThresholds.has(name)) {
        this.firedThresholds.add(name);
        alerts.push({
          threshold: name,
          ratio,
          usedTokens: this.usedTokens,
          limit: this.limit,
          at: new Date().toISOString(),
        });
      }
    });
    return alerts;
  }

  /** Thresholds currently crossed (whether or not already fired). */
  thresholdsCrossed(): ThresholdName[] {
    const ratio = this.usageRatio;
    return (Object.keys(WINDOW_THRESHOLDS) as ThresholdName[]).filter(
      (name) => ratio >= WINDOW_THRESHOLDS[name],
    );
  }

  /** Reset fired-threshold state (call after a compaction round). */
  acknowledgeThresholds(): void {
    this.firedThresholds.clear();
  }

  /**
   * Dry-run eviction: which segments *would* be evicted to free
   * `tokensToFree`, without touching the window. Same order as
   * `evictToFit` (lowest priority first, summaries highest tier
   * first, oldest first). Returns the planned ids + freed tokens.
   */
  planEviction(
    tokensToFree: number,
    options: { keepIds?: string[] } = {},
  ): { ids: string[]; freedTokens: number } {
    if (tokensToFree <= 0) return { ids: [], freedTokens: 0 };
    const keep = new Set(options.keepIds ?? []);
    const candidates = this.segments
      .filter((s) => s.kind !== 'system' && !keep.has(s.id))
      .sort((a, b) => {
        const pa = EVICTION_PRIORITY[a.kind];
        const pb = EVICTION_PRIORITY[b.kind];
        if (pa !== pb) return pa - pb;
        if (a.kind === 'summary' && b.kind === 'summary') {
          const ta = a.tier ?? 1;
          const tb = b.tier ?? 1;
          if (ta !== tb) return tb - ta;
        }
        return a.seq - b.seq;
      });
    const ids: string[] = [];
    let freed = 0;
    for (const candidate of candidates) {
      if (freed >= tokensToFree) break;
      ids.push(candidate.id);
      freed += candidate.tokens;
    }
    return { ids, freedTokens: freed };
  }

  /**
   * Compaction advice: when the window is at/over a threshold,
   * recommend a compaction round (how many tokens to free to get
   * back under the 80% band, and which segments a dry-run eviction
   * would drop). Below 50% there is nothing to do.
   */
  suggestCompaction(): {
    needed: boolean;
    reason: string;
    tokensToFree: number;
    evictionPlan: { ids: string[]; freedTokens: number };
  } {
    const ratio = this.usageRatio;
    const target = Math.floor(this.limit * 0.8);
    const tokensToFree = Math.max(0, this.usedTokens - target);
    if (ratio < 0.5) {
      return { needed: false, reason: 'window under 50% — no compaction needed', tokensToFree: 0, evictionPlan: { ids: [], freedTokens: 0 } };
    }
    if (ratio < 0.8) {
      return { needed: false, reason: 'window under 80% — compaction optional', tokensToFree: 0, evictionPlan: { ids: [], freedTokens: 0 } };
    }
    return {
      needed: true,
      reason: `window at ${Math.round(ratio * 100)}% — compact to get under 80%`,
      tokensToFree,
      evictionPlan: this.planEviction(tokensToFree),
    };
  }

  /**
   * Evict segments until `tokensToFree` are freed (or nothing is
   * evictable). Order: lowest priority first; within a priority,
   * oldest first, and for summaries the highest tier first (a
   * tier-3 session summary is the most compressed, so it goes
   * before a tier-1 turn summary). System segments and anchors
   * pinned by `keepIds` are never evicted. Returns the evicted ids.
   */
  evictToFit(tokensToFree: number, options: { keepIds?: string[] } = {}): string[] {
    if (tokensToFree <= 0) return [];
    const keep = new Set(options.keepIds ?? []);
    const candidates = this.segments
      .filter((s) => s.kind !== 'system' && !keep.has(s.id))
      .sort((a, b) => {
        const pa = EVICTION_PRIORITY[a.kind];
        const pb = EVICTION_PRIORITY[b.kind];
        if (pa !== pb) return pa - pb;
        // Same kind: summaries — higher tier evicts first.
        if (a.kind === 'summary' && b.kind === 'summary') {
          const ta = a.tier ?? 1;
          const tb = b.tier ?? 1;
          if (ta !== tb) return tb - ta;
        }
        return a.seq - b.seq;
      });
    const evicted: string[] = [];
    let freed = 0;
    for (const candidate of candidates) {
      if (freed >= tokensToFree) break;
      this.removeSegment(candidate.id);
      evicted.push(candidate.id);
      freed += candidate.tokens;
      this.evictedCount++;
    }
    return evicted;
  }

  /**
   * Spill lowest-priority in-memory segments to disk until RAM is
   * back under budget. Without a spill dir this is a no-op (the
   * manager keeps everything in RAM). Returns spilled ids.
   */
  spillToFitRam(): string[] {
    if (!this.spillStore || this.ramBytes <= this.ramBudgetBytes) return [];
    const candidates = this.segments
      .filter((s) => !s.spilled && s.kind !== 'system')
      .sort((a, b) => {
        const pa = EVICTION_PRIORITY[a.kind];
        const pb = EVICTION_PRIORITY[b.kind];
        if (pa !== pb) return pa - pb;
        return a.seq - b.seq;
      });
    const spilled: string[] = [];
    for (const candidate of candidates) {
      if (this.ramBytes <= this.ramBudgetBytes) break;
      this.spillStore.spill(candidate.id, {
        kind: candidate.kind,
        tier: candidate.tier,
        text: candidate.text,
        sourceIds: candidate.sourceIds,
        tokens: candidate.tokens,
        at: candidate.at,
      });
      candidate.text = '';
      candidate.spilled = true;
      spilled.push(candidate.id);
    }
    return spilled;
  }

  /**
   * Restore a spilled segment's text from disk (no-op when the
   * segment is in RAM or has no spill file). Returns true when the
   * text was restored.
   */
  restoreSegment(id: string): boolean {
    const segment = this.getSegment(id);
    if (!segment || !segment.spilled || !this.spillStore) return false;
    const record = this.spillStore.restore(id);
    if (!record) return false;
    const payload = record.payload as { text?: unknown };
    if (typeof payload.text !== 'string') return false;
    segment.text = payload.text;
    segment.spilled = false;
    this.spillStore.drop(id);
    return true;
  }

  /**
   * Restore every spilled segment from disk (e.g. before an
   * export, or when RAM budget grows). Returns the restored ids;
   * segments whose spill file is gone stay spilled.
   */
  restoreAllSpilled(): string[] {
    const restored: string[] = [];
    for (const segment of this.segments.filter((s) => s.spilled)) {
      if (this.restoreSegment(segment.id)) restored.push(segment.id);
    }
    return restored;
  }

  /** Full stats snapshot (for `window_stats` / inspector / UI). */
  stats(): WindowStats {
    const byKind: WindowStats['byKind'] = {
      system: { count: 0, tokens: 0 },
      anchor: { count: 0, tokens: 0 },
      summary: { count: 0, tokens: 0 },
      turn: { count: 0, tokens: 0 },
      'tool-result': { count: 0, tokens: 0 },
    };
    const byTier: Record<string, { count: number; tokens: number }> = {};
    for (const segment of this.segments) {
      byKind[segment.kind].count++;
      byKind[segment.kind].tokens += segment.tokens;
      if (segment.kind === 'summary') {
        const key = `tier${segment.tier ?? 1}`;
        byTier[key] = byTier[key] ?? { count: 0, tokens: 0 };
        byTier[key].count++;
        byTier[key].tokens += segment.tokens;
      }
    }
    const used = this.usedTokens;
    const remaining = this.limit - used - this.reserveTokens;
    return {
      limit: this.limit,
      usedTokens: used,
      reservedTokens: this.reserveTokens,
      remainingTokens: remaining,
      usageRatio: this.usageRatio,
      fits: remaining >= 0,
      segmentCount: this.segments.length,
      spilledCount: this.spilledCount,
      ramBytes: this.ramBytes,
      ramBudgetBytes: this.ramBudgetBytes,
      byKind,
      byTier,
      thresholdsCrossed: this.thresholdsCrossed(),
      evictedCount: this.evictedCount,
      spilledBytes: this.spillStore?.totalBytes() ?? 0,
    };
  }

  /** Segments grouped for the inspector tree (kind -> segments). */
  tree(): Array<{ kind: SegmentKind; segments: ContextSegment[] }> {
    const order: SegmentKind[] = ['system', 'anchor', 'summary', 'turn', 'tool-result'];
    return order.map((kind) => ({
      kind,
      segments: this.segments.filter((s) => s.kind === kind),
    }));
  }
}
