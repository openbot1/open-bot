/**
 * Context v2 runtime — the session-scoped state the context_v2_*
 * tools operate on (context engineering v2, v1.05 Team T4).
 *
 * One runtime per bot session (created by the tools factory):
 *
 *  - a `ContextWindowManager` holding the live window segments,
 *  - a `CompactionPolicyStore` for the bot's policy,
 *  - a `CompactionScheduler` enforcing the policy `frequency`,
 *  - a `TierStore` persisting tiers across restarts,
 *  - a `TieredCompactor` for tiered compaction rounds,
 *  - the last tiered result + verified summaries + audit report, so
 *    the inspect / verify / export tools can read them without
 *    re-running a compaction.
 *
 * The runtime is in-memory plus optional files under the workspace
 * dir (`context-v2/policies.json`, `context-v2/schedule.json`,
 * `context-v2/tiers/`, `context-v2/spill/`). It never calls a model
 * and never touches the network. `compactTurns` is the main entry:
 * it compacts turns into tiers, verifies the tier summaries
 * against their sources, registers the summaries + anchors as
 * window segments, and evicts old turns when the window is over
 * its policy trigger. `maybeCompact` is the loop-facing entry: it
 * asks the scheduler first, so hourly/manual policies are honoured.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import {
  TieredCompactor,
  type CompactableTurn,
  type TieredCompactionResult,
  type TierSummary,
} from './tieredCompaction';
import {
  buildVerifiedSummary,
  claimsFromText,
  type VerifiedSummary,
  type VerificationSource,
} from './verifiedSummary';
import { ContextWindowManager } from './windowManager';
import {
  CompactionPolicyStore,
  defaultCompactionPolicy,
  estimateSavings,
  validatePolicy,
  type CompactionPolicy,
  type SavingsEstimate,
} from './compactionPolicy';
import { exportSnapshot, type ContextSnapshot } from './contextInspector';
import type { Anchor } from './anchors';
import { CompactionScheduler, type BotScheduleStatus, type ScheduleDecision } from './compactionScheduler';
import { TierStore, type StoredTiers } from './tierStore';
import { assemblePrompt, type AssembleOptions, type AssemblyResult } from './contextAssembly';
import {
  buildCompactionReport,
  type CompactionReport,
} from './compactionReport';

export interface ContextV2RuntimeOptions {
  /** Workspace dir of the bot (policies + spill live here). */
  workspaceDir?: string;
  /** Model name for the window limit (default gemini-2.5-flash = 1M). */
  model?: string;
  /** Explicit window limit override (tokens). */
  limitTokens?: number;
  /** RAM budget for segment text (bytes). */
  ramBudgetBytes?: number;
}

export interface CompactTurnsResult {
  compaction: TieredCompactionResult;
  /** Verified summaries (one per tier summary, claims graded). */
  verified: VerifiedSummary[];
  /** Window segment ids created by this round. */
  segmentIds: string[];
  /** Segment ids evicted to make room (policy trigger). */
  evictedSegmentIds: string[];
  /** Threshold alerts fired by this round. */
  alerts: Array<{ threshold: string; ratio: number }>;
  /** Audit report for this round. */
  report: CompactionReport;
}

/** Session-scoped context v2 state for one bot. */
export class ContextV2Runtime {
  readonly window: ContextWindowManager;
  readonly policies: CompactionPolicyStore | null;
  readonly scheduler: CompactionScheduler;
  readonly tiers: TierStore | null;
  private readonly compactor = new TieredCompactor();
  private readonly memoryPolicies = new Map<string, CompactionPolicy>();
  private lastCompaction: TieredCompactionResult | null = null;
  private lastVerified: VerifiedSummary[] = [];
  private lastReport: CompactionReport | null = null;
  private tierStore: { tier1: TierSummary[]; tier2: TierSummary[]; tier3: TierSummary[] } = {
    tier1: [],
    tier2: [],
    tier3: [],
  };
  private compactedAt: string | null = null;

  constructor(options: ContextV2RuntimeOptions = {}) {
    const spillDir = options.workspaceDir
      ? path.join(options.workspaceDir, 'context-v2', 'spill')
      : undefined;
    this.window = new ContextWindowManager({
      ...(options.model ? { model: options.model } : { model: 'gemini-2.5-flash' }),
      ...(options.limitTokens !== undefined ? { limitTokens: options.limitTokens } : {}),
      ...(options.ramBudgetBytes !== undefined ? { ramBudgetBytes: options.ramBudgetBytes } : {}),
      ...(spillDir ? { spillDir } : {}),
    });
    this.policies = options.workspaceDir
      ? new CompactionPolicyStore(path.join(options.workspaceDir, 'context-v2', 'policies.json'))
      : null;
    this.scheduler = new CompactionScheduler(
      options.workspaceDir
        ? path.join(options.workspaceDir, 'context-v2', 'schedule.json')
        : undefined,
    );
    this.tiers = options.workspaceDir
      ? new TierStore(path.join(options.workspaceDir, 'context-v2', 'tiers'))
      : null;
  }

  /** Policy for a bot (default when none saved / no store). */
  policyFor(botId: string): CompactionPolicy {
    if (this.policies) return this.policies.get(botId);
    return this.memoryPolicies.get(botId) ?? defaultCompactionPolicy(botId);
  }

  /** Save a bot's policy (to disk when a store exists, else in memory). */
  setPolicy(botId: string, patch: Partial<CompactionPolicy>): CompactionPolicy {
    if (this.policies) return this.policies.set(botId, patch);
    const errors = validatePolicy(patch);
    if (errors.length > 0) throw new Error(`invalid compaction policy: ${errors.join('; ')}`);
    const current = this.policyFor(botId);
    const next: CompactionPolicy = {
      ...current,
      ...patch,
      botId,
      updatedAt: new Date().toISOString(),
    };
    this.memoryPolicies.set(botId, next);
    return next;
  }

  /** Last tiered compaction result (null before any round). */
  get lastResult(): TieredCompactionResult | null {
    return this.lastCompaction;
  }

  /** Verified summaries from the last round. */
  get verifiedSummaries(): VerifiedSummary[] {
    return [...this.lastVerified];
  }

  /** All anchors kept across tiers from the last round. */
  get anchors(): Anchor[] {
    return this.lastCompaction?.anchors ?? [];
  }

  /** When the last compaction round ran (ISO, null when never). */
  get lastCompactedAt(): string | null {
    return this.compactedAt;
  }

  /** Audit report of the last round (null before any round). */
  get report(): CompactionReport | null {
    return this.lastReport;
  }

  /** Scheduler status for a bot (next allowed run, runs total). */
  scheduleStatus(botId: string): BotScheduleStatus {
    return this.scheduler.status(botId, this.policyFor(botId));
  }

  /** Preview what a bot's policy would save on a message list. */
  previewPolicy(
    botId: string,
    messages: Array<{ role: string; content?: string; id?: string }>,
  ): SavingsEstimate {
    return estimateSavings(messages, this.policyFor(botId));
  }

  /**
   * Loop-facing compaction gate: ask the scheduler whether a round
   * may run now (trigger + frequency). Returns the decision and,
   * when allowed, the round result. Manual/hourly policies are
   * honoured here — `compactTurns` below always runs.
   */
  maybeCompact(
    botId: string,
    turns: CompactableTurn[],
    options: { runId?: string } = {},
  ): { decision: ScheduleDecision; result: CompactTurnsResult | null } {
    const decision = this.scheduler.shouldCompact(botId, this.policyFor(botId), this.window.usageRatio);
    if (!decision.allowed) return { decision, result: null };
    const result = this.compactTurns(botId, turns, { trigger: 'scheduled', ...(options.runId ? { runId: options.runId } : {}) });
    return { decision, result };
  }

  /**
   * Assemble the prompt the model sees from the current window
   * (system + anchors + summaries + recent turns, within budget).
   */
  assemblePrompt(options: AssembleOptions = {}): AssemblyResult {
    return assemblePrompt(this.window.list(), options);
  }

  /**
   * Restore a bot's persisted tiers into the window (after a
   * restart): tier summaries become window segments again. Returns
   * how many summaries were restored.
   */
  restoreTiers(botId: string): { restored: number; lastCompactedAt: string | null } {
    if (!this.tiers) return { restored: 0, lastCompactedAt: null };
    const stored: StoredTiers = this.tiers.load(botId);
    let restored = 0;
    const register = (summary: TierSummary) => {
      this.window.addSegment({
        id: `seg-summary-${summary.id}`,
        kind: 'summary',
        text: summary.text,
        tier: summary.tier,
        sourceIds: summary.sourceIds,
      });
      restored++;
    };
    stored.tier1.forEach(register);
    stored.tier2.forEach(register);
    stored.tier3.forEach(register);
    this.tierStore.tier1 = [...stored.tier1];
    this.tierStore.tier2 = [...stored.tier2];
    this.tierStore.tier3 = [...stored.tier3];
    this.lastVerified = [...stored.verified];
    return { restored, lastCompactedAt: stored.lastCompactedAt };
  }

  /**
   * Compact turns into tiers. Steps: (1) tiered compaction, (2)
   * verify every tier summary against its source turns, (3) apply
   * the bot's retention policy to the tier store, (4) register the
   * new summaries + anchors as window segments, (5) when the window
   * is at/over the policy trigger, evict old turn segments.
   */
  compactTurns(
    botId: string,
    turns: CompactableTurn[],
    options: { trigger?: CompactionReport['trigger']; runId?: string } = {},
  ): CompactTurnsResult {
    const policy = this.policyFor(botId);
    const trigger = options.trigger ?? 'manual';
    const compaction = this.compactor.compact(turns);
    // Respect maxTier: drop tiers the policy does not allow.
    const tier1 = compaction.tier1;
    const tier2 = policy.maxTier >= 2 ? compaction.tier2 : [];
    const tier3 = policy.maxTier >= 3 ? compaction.tier3 : null;
    // Verify every kept summary against its source turns.
    const sources: VerificationSource[] = turns.map((turn) => ({
      id: turn.id,
      content: turn.content ?? '',
    }));
    const verified: VerifiedSummary[] = [];
    const verifyTier = (summaries: TierSummary[], tier: 1 | 2 | 3) => {
      for (const summary of summaries) {
        const claims = claimsFromText(summary.text, summary.sourceIds);
        verified.push(buildVerifiedSummary(claims, sources, { tier, topic: summary.topic }));
      }
    };
    verifyTier(tier1, 1);
    verifyTier(tier2, 2);
    if (tier3) verifyTier([tier3], 3);
    // Retention: merge into the tier store, roll up overflow.
    this.tierStore.tier1.push(...tier1);
    this.tierStore.tier2.push(...tier2);
    if (tier3) this.tierStore.tier3.push(tier3);
    this.compactor.applyRetention(this.tierStore);
    // Register summaries + anchors as window segments.
    const segmentIds: string[] = [];
    const register = (summary: TierSummary) => {
      const id = `seg-summary-${summary.id}`;
      this.window.addSegment({
        id,
        kind: 'summary',
        text: summary.text,
        tier: summary.tier,
        sourceIds: summary.sourceIds,
      });
      segmentIds.push(id);
    };
    tier1.forEach(register);
    tier2.forEach(register);
    if (tier3) register(tier3);
    for (const anchor of compaction.anchors) {
      const id = `seg-anchor-${anchor.id}`;
      this.window.addSegment({
        id,
        kind: 'anchor',
        text: anchor.text,
        sourceIds: anchor.sourceIds,
      });
      segmentIds.push(id);
    }
    // Evict old turns when at/over the trigger ratio.
    let evictedSegmentIds: string[] = [];
    const ratio = this.window.usageRatio;
    if (ratio >= policy.triggerRatio) {
      const overflow = this.window.usedTokens - Math.floor(this.window.limit * policy.triggerRatio);
      evictedSegmentIds = this.window.evictToFit(Math.max(0, overflow), { keepIds: segmentIds });
    }
    const alerts = this.window.checkThresholds().map((a) => ({ threshold: a.threshold, ratio: a.ratio }));
    this.lastCompaction = { ...compaction, tier2, tier3 };
    this.lastVerified = verified;
    this.compactedAt = new Date().toISOString();
    const report = buildCompactionReport({
      botId,
      ...(options.runId ? { runId: options.runId } : {}),
      trigger,
      compaction: this.lastCompaction,
      verified,
      segmentIds,
      evictedSegmentIds,
      thresholdAlerts: alerts.map((a) => a.threshold),
      windowAfter: this.window.stats(),
    });
    this.lastReport = report;
    this.scheduler.recordRun(botId, this.compactedAt);
    // Persist tiers so a restart restores them (no-op without a store).
    if (this.tiers) {
      this.tiers.save({
        botId,
        updatedAt: this.compactedAt,
        tier1: [...this.tierStore.tier1],
        tier2: [...this.tierStore.tier2],
        tier3: [...this.tierStore.tier3],
        verified: [...verified],
        anchors: [...compaction.anchors],
        lastCompactedAt: this.compactedAt,
      });
    }
    return {
      compaction: this.lastCompaction,
      verified,
      segmentIds,
      evictedSegmentIds,
      alerts,
      report,
    };
  }

  /** Add a raw turn as a window segment (feeds the inspector). */
  addTurnSegment(turn: { id: string; role: string; content?: string }): void {
    this.window.addSegment({
      id: `seg-turn-${turn.id}`,
      kind: 'turn',
      text: turn.content ?? '',
      sourceIds: [turn.id],
    });
  }

  /** Add the system prompt as a window segment (never evicted). */
  setSystemSegment(text: string): void {
    this.window.addSegment({ id: 'seg-system', kind: 'system', text, sourceIds: [] });
  }

  /** Export the current window (+ the bot's policy) as a snapshot. */
  snapshot(botId: string): ContextSnapshot {
    return exportSnapshot(this.window, { botId, policy: this.policyFor(botId) });
  }

  /** Unique id helper for tool-created segments. */
  static newId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }
}
