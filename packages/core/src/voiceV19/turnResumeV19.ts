/**
 * Open-turn resume v19 (v1.27, Đội T5 — voice v19).
 *
 * v18 checkpoints a turn when the barge-in cuts it, and a dropped
 * connection can reconnect and re-speak the remainder — but only
 * while the session object is alive. A real crash (or a dead
 * network mid-sentence) leaves an *open turn*: the user said half
 * a sentence, the agent said half a reply, and nobody remembers
 * where either half stopped. v19 keeps the open turn itself:
 *
 *   1. Partial transcripts. Every transcript fragment is stored
 *      as a segment (`seq`, speaker, text, time window, final
 *      flag) per turn. Segments arrive twice in practice (the
 *      live partial, then the final; the pre-crash flush, then
 *      the post-crash replay), so `appendSegment()` dedupes by
 *      sequence number, exact text, and *text overlap*: when a
 *      new fragment starts with the tail of what is already
 *      stored (or ends with its head), the overlap is merged,
 *      never doubled.
 *   2. Turn states. `open` → `interrupted` (network-lost /
 *      crash / barge-in / timeout) → `awaiting-confirmation` →
 *      `resumed` / `completed` / `dropped`. The turn never
 *      resumes on its own: `requestResume()` puts it in front
 *      of the user, and only `confirmResume()` continues it.
 *      The user picks the action — `resume` (continue from the
 *      cut point), `restart` (say the whole reply again),
 *      `summarise` (condense what was already said), or `drop`.
 *   3. Resume point. The merged transcript + spoken prefix +
 *      remaining reply text are computed from the segments and
 *      the checkpoint the session saved, so the agent continues
 *      mid-sentence instead of repeating (or skipping) words.
 *   4. Persistence. Turns export/import as JSON, so a turn
 *      interrupted by a crash can be restored by a fresh
 *      process and still asked about — "Bạn đang nói dở câu
 *      '...', có muốn tiếp tục không?"
 *
 * All clocks are virtual (`nowMs`, starts at 0); `tick(ms)`
 * advances them. No network, no sound card, no key.
 */

export type TurnResumeV19Speaker = 'user' | 'agent';

export type TurnResumeV19State =
  | 'open'
  | 'interrupted'
  | 'awaiting-confirmation'
  | 'resumed'
  | 'completed'
  | 'dropped';

export const TURN_RESUME_V19_STATES: readonly TurnResumeV19State[] = [
  'open',
  'interrupted',
  'awaiting-confirmation',
  'resumed',
  'completed',
  'dropped',
];

export function isTurnResumeV19State(value: unknown): value is TurnResumeV19State {
  return (
    typeof value === 'string' &&
    (TURN_RESUME_V19_STATES as readonly string[]).includes(value)
  );
}

export type TurnResumeV19InterruptReason = 'network-lost' | 'crash' | 'barge-in' | 'timeout';

export const TURN_RESUME_V19_INTERRUPT_REASONS: readonly TurnResumeV19InterruptReason[] = [
  'network-lost',
  'crash',
  'barge-in',
  'timeout',
];

export function isTurnResumeV19InterruptReason(value: unknown): value is TurnResumeV19InterruptReason {
  return (
    typeof value === 'string' &&
    (TURN_RESUME_V19_INTERRUPT_REASONS as readonly string[]).includes(value)
  );
}

export type TurnResumeV19Action = 'resume' | 'restart' | 'summarise' | 'drop';

export const TURN_RESUME_V19_ACTIONS: readonly TurnResumeV19Action[] = [
  'resume',
  'restart',
  'summarise',
  'drop',
];

export function isTurnResumeV19Action(value: unknown): value is TurnResumeV19Action {
  return (
    typeof value === 'string' &&
    (TURN_RESUME_V19_ACTIONS as readonly string[]).includes(value)
  );
}

/** One transcript fragment (partial or final) of a turn. */
export interface TurnResumeV19Segment {
  /** Monotonic per-turn sequence (dedupes replays of the same fragment). */
  seq: number;
  turnId: string;
  speaker: TurnResumeV19Speaker;
  text: string;
  startMs: number;
  endMs: number;
  final: boolean;
}

/** The stored record of one (possibly interrupted) turn. */
export interface TurnResumeV19Turn {
  id: string;
  sessionId: string;
  state: TurnResumeV19State;
  userText: string;
  replyText: string;
  /** Chars of the reply already spoken before the cut. */
  spokenChars: number;
  /** Reply text not yet spoken (computed on interrupt/resume). */
  remainingText: string;
  interruptReason: TurnResumeV19InterruptReason | undefined;
  /** Action the user confirmed (when resumed). */
  resumeAction: TurnResumeV19Action | undefined;
  /** Chars of userText confirmed as heard (resume point for the user side). */
  resumePointChars: number;
  createdAtMs: number;
  updatedAtMs: number;
  interruptedAtMs: number | undefined;
  confirmedAtMs: number | undefined;
  segments: TurnResumeV19Segment[];
}

/** What the user is asked before a turn continues. */
export interface TurnResumeV19Confirmation {
  turnId: string;
  sessionId: string;
  atMs: number;
  userText: string;
  spokenReply: string;
  remainingText: string;
  interruptReason: TurnResumeV19InterruptReason;
  /** The exact question the UI shows. */
  question: string;
  actions: readonly TurnResumeV19Action[];
}

/** What `confirmResume()` returns: how the turn continues. */
export interface TurnResumeV19ResumePlan {
  turnId: string;
  action: TurnResumeV19Action;
  /** User text to feed back into the session (merged, deduped). */
  userText: string;
  /** Agent text to speak next (remaining / full / summary / ''). */
  speakText: string;
  /** Where the reply restarts, in chars of replyText. */
  resumeAtChars: number;
  /** One-line summary when action is 'summarise'. */
  summary: string | undefined;
}

export interface TurnResumeV19StoreOptions {
  /** Max turns kept (default 50; oldest completed/dropped first out). */
  maxTurns?: number;
  /** Max segments kept per turn (default 200). */
  maxSegmentsPerTurn?: number;
  /** How long a confirmation stays valid (ms, default 120_000 = 2 min). */
  confirmTimeoutMs?: number;
}

export function defaultTurnResumeV19Options(): Required<TurnResumeV19StoreOptions> {
  return { maxTurns: 50, maxSegmentsPerTurn: 200, confirmTimeoutMs: 120_000 };
}

export function validateTurnResumeV19Options(options: TurnResumeV19StoreOptions): string[] {
  const errors: string[] = [];
  const check = (name: string, value: number | undefined, min: number, max: number): void => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || Math.floor(value) !== value) {
      errors.push(`${name} must be an integer, got ${String(value)}`);
    } else if (value < min || value > max) {
      errors.push(`${name} must be ${min}..${max}, got ${value}`);
    }
  };
  check('maxTurns', options.maxTurns, 1, 10_000);
  check('maxSegmentsPerTurn', options.maxSegmentsPerTurn, 1, 10_000);
  check('confirmTimeoutMs', options.confirmTimeoutMs, 1_000, 3_600_000);
  return errors;
}

/**
 * Longest overlap where the end of `a` equals the start of `b`
 * (word-boundary aware: the overlap must not cut a word in half
 * unless one side is a strict prefix of the other).
 */
export function textOverlapV19(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  for (let len = max; len > 0; len -= 1) {
    if (a.slice(a.length - len) !== b.slice(0, len)) continue;
    // Accept when the join is at a space, at a string edge, or the
    // shorter side is fully contained (a replayed prefix).
    const aBefore = a.length - len === 0 ? '' : a[a.length - len - 1];
    const bAfter = len === b.length ? '' : b[len];
    if (aBefore === '' || aBefore === ' ' || bAfter === '' || bAfter === ' ') return len;
    if (len === max) return len;
  }
  return 0;
}

/**
 * Merge a list of segments (one speaker, seq order) into one text,
 * dropping exact duplicates and overlapping repeats. Segments with
 * the same seq keep the *final* one when present, else the first.
 */
export function mergeSegmentsV19(segments: TurnResumeV19Segment[]): string {
  const bySeq = new Map<number, TurnResumeV19Segment>();
  for (const segment of segments) {
    const prev = bySeq.get(segment.seq);
    if (!prev) {
      bySeq.set(segment.seq, segment);
    } else if (segment.final && !prev.final) {
      bySeq.set(segment.seq, segment);
    }
    // Same seq + same finality: keep the first (a replayed flush).
  }
  const ordered = [...bySeq.values()].sort((x, y) => x.seq - y.seq || x.startMs - y.startMs);
  let merged = '';
  for (const segment of ordered) {
    const text = segment.text.trim();
    if (!text) continue;
    if (!merged) {
      merged = text;
      continue;
    }
    if (merged === text || merged.endsWith(text) || merged.includes(text)) continue;
    const overlap = textOverlapV19(merged, text);
    if (overlap > 0) {
      merged = merged + text.slice(overlap);
    } else if (merged.endsWith(text.slice(0, Math.min(text.length, merged.length)))) {
      merged = merged; // fully covered by the tail — nothing new.
    } else {
      merged = `${merged} ${text}`;
    }
  }
  return merged;
}

/** Summarise a spoken prefix for the 'summarise' resume action. */
export function summariseSpokenV19(spokenText: string, maxChars = 120): string {
  const trimmed = spokenText.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export interface TurnResumeV19Stats {
  nowMs: number;
  turns: number;
  open: number;
  interrupted: number;
  awaitingConfirmation: number;
  resumed: number;
  completed: number;
  dropped: number;
  segments: number;
  duplicatesDropped: number;
  overlapsMerged: number;
  confirmationsRequested: number;
  confirmationsExpired: number;
}

export class OpenTurnStoreV19 {
  private readonly options: Required<TurnResumeV19StoreOptions>;
  private nowMs = 0;
  private readonly turns = new Map<string, TurnResumeV19Turn>();
  private duplicatesDropped = 0;
  private overlapsMerged = 0;
  private confirmationsRequested = 0;
  private confirmationsExpired = 0;

  constructor(options: TurnResumeV19StoreOptions = {}) {
    const errors = validateTurnResumeV19Options(options);
    if (errors.length > 0) {
      throw new Error(`invalid open-turn resume v19 options: ${errors.join('; ')}`);
    }
    const defaults = defaultTurnResumeV19Options();
    this.options = {
      maxTurns: options.maxTurns ?? defaults.maxTurns,
      maxSegmentsPerTurn: options.maxSegmentsPerTurn ?? defaults.maxSegmentsPerTurn,
      confirmTimeoutMs: options.confirmTimeoutMs ?? defaults.confirmTimeoutMs,
    };
  }

  getOptions(): Required<TurnResumeV19StoreOptions> {
    return { ...this.options };
  }

  now(): number {
    return this.nowMs;
  }

  tick(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`tick(ms) must be >= 0, got ${ms}`);
    this.nowMs += Math.floor(ms);
    // Expire stale confirmations: awaiting-confirmation turns whose
    // deadline passed drop back to interrupted (the user never
    // answered — the turn is not lost, just no longer pending).
    for (const turn of this.turns.values()) {
      if (turn.state !== 'awaiting-confirmation') continue;
      if (
        turn.interruptedAtMs !== undefined &&
        this.nowMs - turn.interruptedAtMs > this.options.confirmTimeoutMs
      ) {
        turn.state = 'interrupted';
        turn.updatedAtMs = this.nowMs;
        this.confirmationsExpired += 1;
      }
    }
  }

  /** Start tracking a turn (idempotent: returns the existing turn when known). */
  openTurn(id: string, sessionId: string): TurnResumeV19Turn {
    if (!id) throw new Error('Turn id must be a non-empty string.');
    const existing = this.turns.get(id);
    if (existing) return existing;
    const turn: TurnResumeV19Turn = {
      id,
      sessionId,
      state: 'open',
      userText: '',
      replyText: '',
      spokenChars: 0,
      remainingText: '',
      interruptReason: undefined,
      resumeAction: undefined,
      resumePointChars: 0,
      createdAtMs: this.nowMs,
      updatedAtMs: this.nowMs,
      interruptedAtMs: undefined,
      confirmedAtMs: undefined,
      segments: [],
    };
    this.turns.set(id, turn);
    this.evictIfNeeded();
    return turn;
  }

  getTurn(id: string): TurnResumeV19Turn | undefined {
    const turn = this.turns.get(id);
    return turn ? copyTurnV19(turn) : undefined;
  }

  listTurns(): TurnResumeV19Turn[] {
    return [...this.turns.values()].map(copyTurnV19);
  }

  listOpenTurns(): TurnResumeV19Turn[] {
    return this.listTurns().filter(
      (t) => t.state === 'open' || t.state === 'interrupted' || t.state === 'awaiting-confirmation',
    );
  }

  private evictIfNeeded(): void {
    while (this.turns.size > this.options.maxTurns) {
      // Evict the oldest finished turn first; only evict an open one
      // when every turn is still open (capacity pressure, last resort).
      const finished = [...this.turns.values()].find(
        (t) => t.state === 'completed' || t.state === 'dropped',
      );
      const victim =
        finished ?? [...this.turns.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
      if (!victim) return;
      this.turns.delete(victim.id);
    }
  }

  /**
   * Append a transcript fragment. Returns the dedupe outcome so the
   * caller can log what was dropped and why.
   */
  appendSegment(segment: TurnResumeV19Segment): {
    accepted: boolean;
    deduped: 'none' | 'same-seq' | 'exact-duplicate' | 'overlap-merged';
    mergedText: string;
  } {
    const turn = this.turns.get(segment.turnId) ?? this.openTurn(segment.turnId, '');
    if (turn.state === 'completed' || turn.state === 'dropped') {
      return { accepted: false, deduped: 'none', mergedText: this.mergedTextFor(turn) };
    }
    const text = segment.text.trim();
    if (!text) {
      return { accepted: false, deduped: 'none', mergedText: this.mergedTextFor(turn) };
    }
    const sameSeq = turn.segments.find((s) => s.seq === segment.seq);
    if (sameSeq && sameSeq.text.trim() === text) {
      this.duplicatesDropped += 1;
      return { accepted: false, deduped: 'same-seq', mergedText: this.mergedTextFor(turn) };
    }
    const before = this.mergedTextFor(turn);
    if (before.includes(text) && text.length < before.length) {
      this.duplicatesDropped += 1;
      return { accepted: false, deduped: 'exact-duplicate', mergedText: before };
    }
    const overlap = textOverlapV19(before, text);
    turn.segments.push({ ...segment, text });
    while (turn.segments.length > this.options.maxSegmentsPerTurn) {
      turn.segments.shift();
    }
    turn.updatedAtMs = this.nowMs;
    this.recomputeTexts(turn);
    if (overlap > 0) this.overlapsMerged += 1;
    return {
      accepted: true,
      deduped: overlap > 0 ? 'overlap-merged' : 'none',
      mergedText: this.mergedTextFor(turn),
    };
  }

  /** Record the agent's reply text + how much of it was spoken. */
  setReply(turnId: string, replyText: string, spokenChars: number): TurnResumeV19Turn | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;
    turn.replyText = replyText;
    turn.spokenChars = Math.max(0, Math.min(spokenChars, replyText.length));
    turn.remainingText = replyText.slice(turn.spokenChars);
    turn.updatedAtMs = this.nowMs;
    return copyTurnV19(turn);
  }

  private mergedTextFor(turn: TurnResumeV19Turn): string {
    const userSegments = turn.segments.filter((s) => s.speaker === 'user');
    return mergeSegmentsV19(userSegments);
  }

  private recomputeTexts(turn: TurnResumeV19Turn): void {
    turn.userText = this.mergedTextFor(turn);
    const agentSegments = turn.segments.filter((s) => s.speaker === 'agent');
    if (agentSegments.length > 0) {
      const spoken = mergeSegmentsV19(agentSegments);
      if (!turn.replyText) turn.replyText = spoken;
      // The spoken prefix is whatever the agent segments say was
      // spoken; never claim more than the reply text holds.
      turn.spokenChars = Math.min(spoken.length, turn.replyText.length);
      turn.remainingText = turn.replyText.slice(turn.spokenChars);
    }
  }

  /**
   * Mark a turn interrupted (network lost / crash / barge-in /
   * timeout). Snapshots the partial transcript + spoken prefix so
   * the resume question can quote them back to the user.
   */
  interruptTurn(
    turnId: string,
    reason: TurnResumeV19InterruptReason,
  ): TurnResumeV19Turn | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;
    if (turn.state === 'completed' || turn.state === 'dropped') return copyTurnV19(turn);
    this.recomputeTexts(turn);
    turn.state = 'interrupted';
    turn.interruptReason = reason;
    turn.interruptedAtMs = this.nowMs;
    turn.resumePointChars = turn.userText.length;
    turn.remainingText = turn.replyText.slice(turn.spokenChars);
    turn.updatedAtMs = this.nowMs;
    return copyTurnV19(turn);
  }

  /** Put the interrupted turn in front of the user for confirmation. */
  requestResume(turnId: string): TurnResumeV19Confirmation | undefined {
    const turn = this.turns.get(turnId);
    if (!turn || turn.state !== 'interrupted') return undefined;
    this.recomputeTexts(turn);
    turn.state = 'awaiting-confirmation';
    turn.updatedAtMs = this.nowMs;
    this.confirmationsRequested += 1;
    const spokenReply = turn.replyText.slice(0, turn.spokenChars);
    const reasonLabel: Record<TurnResumeV19InterruptReason, string> = {
      'network-lost': 'mất mạng',
      crash: 'ứng dụng bị tắt đột ngột',
      'barge-in': 'bị ngắt lời',
      timeout: 'hết thời gian chờ',
    };
    return {
      turnId: turn.id,
      sessionId: turn.sessionId,
      atMs: this.nowMs,
      userText: turn.userText,
      spokenReply,
      remainingText: turn.remainingText,
      interruptReason: turn.interruptReason ?? 'timeout',
      question:
        `Lượt nói bị gián đoạn (${reasonLabel[turn.interruptReason ?? 'timeout']}). ` +
        (turn.userText
          ? `Bạn đang nói dở: "${turn.userText}". `
          : 'Bạn chưa nói hết câu. ') +
        (spokenReply
          ? `Tôi đã nói: "${summariseSpokenV19(spokenReply)}" — còn "${summariseSpokenV19(turn.remainingText)}" chưa nói. `
          : '') +
        'Có muốn tiếp tục từ chỗ bị ngắt không?',
      actions: TURN_RESUME_V19_ACTIONS,
    };
  }

  /**
   * The user confirmed: continue the turn per the chosen action.
   * Returns the resume plan, or undefined when the turn is not
   * awaiting confirmation.
   */
  confirmResume(turnId: string, action: TurnResumeV19Action): TurnResumeV19ResumePlan | undefined {
    const turn = this.turns.get(turnId);
    if (!turn || turn.state !== 'awaiting-confirmation') return undefined;
    if (!isTurnResumeV19Action(action)) return undefined;
    this.recomputeTexts(turn);
    turn.resumeAction = action;
    turn.confirmedAtMs = this.nowMs;
    turn.updatedAtMs = this.nowMs;
    const spokenReply = turn.replyText.slice(0, turn.spokenChars);
    if (action === 'drop') {
      turn.state = 'dropped';
      return {
        turnId: turn.id,
        action,
        userText: turn.userText,
        speakText: '',
        resumeAtChars: turn.spokenChars,
        summary: undefined,
      };
    }
    turn.state = 'resumed';
    if (action === 'resume') {
      return {
        turnId: turn.id,
        action,
        userText: turn.userText,
        speakText: turn.remainingText,
        resumeAtChars: turn.spokenChars,
        summary: undefined,
      };
    }
    if (action === 'restart') {
      return {
        turnId: turn.id,
        action,
        userText: turn.userText,
        speakText: turn.replyText,
        resumeAtChars: 0,
        summary: undefined,
      };
    }
    // summarise: condense what was already spoken, then continue.
    const summary = summariseSpokenV19(spokenReply);
    return {
      turnId: turn.id,
      action,
      userText: turn.userText,
      speakText: turn.remainingText,
      resumeAtChars: turn.spokenChars,
      summary: summary ? `Đã nói: ${summary}` : undefined,
    };
  }

  /** The user declined to continue: drop the turn (transcript kept for the log). */
  declineResume(turnId: string): TurnResumeV19Turn | undefined {
    const turn = this.turns.get(turnId);
    if (!turn || turn.state !== 'awaiting-confirmation') return undefined;
    turn.state = 'dropped';
    turn.resumeAction = 'drop';
    turn.updatedAtMs = this.nowMs;
    return copyTurnV19(turn);
  }

  /** Mark a resumed/completed turn finished. */
  completeTurn(turnId: string): TurnResumeV19Turn | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;
    if (turn.state === 'dropped') return copyTurnV19(turn);
    turn.state = 'completed';
    turn.updatedAtMs = this.nowMs;
    return copyTurnV19(turn);
  }

  /** Export one turn (JSON-able) for crash recovery. */
  exportTurn(turnId: string): TurnResumeV19Turn | undefined {
    return this.getTurn(turnId);
  }

  /** Import a turn exported earlier (idempotent by id). */
  importTurn(turn: TurnResumeV19Turn): boolean {
    if (!turn || typeof turn.id !== 'string' || !turn.id) return false;
    if (this.turns.has(turn.id)) return false;
    if (!isTurnResumeV19State(turn.state)) return false;
    const copy = copyTurnV19(turn);
    // An imported turn that was mid-flight comes back as
    // interrupted, never as silently open — the user must confirm.
    if (copy.state === 'open') copy.state = 'interrupted';
    if (copy.state === 'awaiting-confirmation') copy.state = 'interrupted';
    this.turns.set(copy.id, copy);
    this.evictIfNeeded();
    return true;
  }

  stats(): TurnResumeV19Stats {
    let open = 0;
    let interrupted = 0;
    let awaiting = 0;
    let resumed = 0;
    let completed = 0;
    let dropped = 0;
    let segments = 0;
    for (const turn of this.turns.values()) {
      segments += turn.segments.length;
      if (turn.state === 'open') open += 1;
      else if (turn.state === 'interrupted') interrupted += 1;
      else if (turn.state === 'awaiting-confirmation') awaiting += 1;
      else if (turn.state === 'resumed') resumed += 1;
      else if (turn.state === 'completed') completed += 1;
      else dropped += 1;
    }
    return {
      nowMs: this.nowMs,
      turns: this.turns.size,
      open,
      interrupted,
      awaitingConfirmation: awaiting,
      resumed,
      completed,
      dropped,
      segments,
      duplicatesDropped: this.duplicatesDropped,
      overlapsMerged: this.overlapsMerged,
      confirmationsRequested: this.confirmationsRequested,
      confirmationsExpired: this.confirmationsExpired,
    };
  }

  summary(): string {
    const s = this.stats();
    return (
      `open-turn resume v19: ${s.turns} turn(s) — ${s.open} open, ${s.interrupted} interrupted, ` +
      `${s.awaitingConfirmation} awaiting confirmation, ${s.resumed} resumed, ${s.completed} completed, ` +
      `${s.dropped} dropped; ${s.segments} segments, ${s.duplicatesDropped} duplicates dropped, ` +
      `${s.overlapsMerged} overlaps merged`
    );
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Open-turn resume v19',
      '',
      `- Turns: ${s.turns} (open ${s.open}, interrupted ${s.interrupted}, awaiting confirmation ${s.awaitingConfirmation}, resumed ${s.resumed}, completed ${s.completed}, dropped ${s.dropped}).`,
      `- Segments: ${s.segments}; duplicates dropped ${s.duplicatesDropped}; overlaps merged ${s.overlapsMerged}.`,
      `- Confirmations: requested ${s.confirmationsRequested}, expired ${s.confirmationsExpired}.`,
      '',
      '| Turn | Session | State | User text | Spoken / Remaining |',
      '|---|---|---|---|---|',
    ];
    for (const turn of this.turns.values()) {
      lines.push(
        `| ${turn.id} | ${turn.sessionId || '—'} | ${turn.state} | ${truncateV19(turn.userText, 40)} | ${turn.spokenChars} / ${turn.remainingText.length} chars |`,
      );
    }
    return lines.join('\n');
  }
}

export function createOpenTurnStoreV19(
  options: TurnResumeV19StoreOptions = {},
): OpenTurnStoreV19 {
  return new OpenTurnStoreV19(options);
}

function copyTurnV19(turn: TurnResumeV19Turn): TurnResumeV19Turn {
  return {
    ...turn,
    segments: turn.segments.map((s) => ({ ...s })),
  };
}

function truncateV19(text: string, max: number): string {
  if (text.length <= max) return text || '—';
  return `${text.slice(0, max - 1)}…`;
}
