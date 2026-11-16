/**
 * Overlap handling v12 (v1.13, Đội T5 — voice realtime v12).
 *
 * v11 records that an overlap *happened* (user started while the
 * agent spoke) and ducks playback as a binary on/off. v12 owns
 * the whole overlap: *how long* both talked at once, *what* was
 * lost on each side, *who* kept the floor, and *how* the volume
 * moved while it happened.
 *
 *   agent speaking ──▶ user starts ──▶ OVERLAP (segment opens)
 *        │                  │               │
 *        │                  │               ├─ duck envelope: 1.0 ──▶
 *        │                  │               │   duckFactor over
 *        │                  │               │   duckRampMs, hold, ramp
 *        │                  │               │   back over resumeRampMs
 *        │                  │               │
 *        │                  ▼               ▼
 *        │             user wins (default) ──▶ agent cut, segment
 *        │             closes: agent words lost + user words kept
 *        │             agent keeps (backchannel) ──▶ user burst
 *        │             logged as a backchannel, agent continues
 *
 * Priority policy (`OverlapV12Policy`):
 * - `user-wins` (default): any confirmed user speech over the
 *   agent hands the floor to the user — the agent yields.
 * - `agent-keeps`: the agent keeps the floor unless the user
 *   speaks longer than `backchannelMs` with confidence at/above
 *   `minConfidence` — short / uncertain bursts are backchannels
 *   ("ừ", "vâng"), not turns.
 * - `confirm`: the overlap stays open until the caller resolves
 *   it explicitly (`resolveOverlap`) — for hosts that ask the
 *   user, or decide from the transcript.
 *
 * Ducking envelope: the playback volume is a piecewise-linear
 * ramp, not a switch — `volumeAt(atMs)` returns the exact
 * factor at any virtual time (1.0 → `duckFactor` over
 * `duckRampMs`, hold while the user speaks, back to 1.0 over
 * `resumeRampMs` after the user stops). The panel draws this
 * envelope; the session applies it to the TTS gain.
 *
 * Overlap log: every segment records start/end, duration, the
 * agent words overlapped (the caller supplies the cut word
 * index at resolve time), the user words overlapped (fed via
 * `noteUserWord`), the winner and the resolution reason — so
 * the agent knows exactly which part of its reply the user
 * never heard, and the diagnostics panel can show "bạn đã ngắt
 * 3 từ của bot trong 420 ms".
 *
 * No audio device, no network, no model: the tracker only
 * records timings, words and decisions on the caller-owned
 * virtual clock.
 */

/** Overlap priority policy. */
export type OverlapV12Policy = 'user-wins' | 'agent-keeps' | 'confirm';

/** Who kept the floor after an overlap. */
export type OverlapV12Winner = 'user' | 'agent' | 'unresolved';

/** Options for `OverlapTrackerV12`. */
export interface OverlapV12Options {
  /** Overlap priority policy (default `user-wins`). */
  policy?: OverlapV12Policy;
  /** Playback volume factor while ducked (0..1, default 0.35). */
  duckFactor?: number;
  /** Ramp-down time to the ducked volume (ms, default 120). */
  duckRampMs?: number;
  /** Ramp-up time back to full volume (ms, default 250). */
  resumeRampMs?: number;
  /** User speech below this length counts as a backchannel (ms, default 400). */
  backchannelMs?: number;
  /** Minimum confidence for user speech to win (0..1, default 0.5). */
  minConfidence?: number;
  /** Max overlap segments kept in the log (default 100). */
  maxSegments?: number;
}

/** One overlap segment (user + agent speaking at once). */
export interface OverlapV12Segment {
  id: number;
  startedAtMs: number;
  endedAtMs: number | null;
  /** Overlap duration so far / final (ms). */
  durationMs: number;
  /** Confidence of the user's speech that opened the overlap. */
  userConfidence: number;
  /** Agent words overlapped (filled at resolve time). */
  agentWordsLost: string[];
  /** User words spoken during the overlap. */
  userWords: string[];
  winner: OverlapV12Winner;
  /** Why the overlap resolved this way. */
  resolutionReason: string;
  /** Deepest duck factor reached during the overlap (0..1). */
  minVolume: number;
}

/** Counters for one tracker. */
export interface OverlapV12Stats {
  overlaps: number;
  open: boolean;
  userWins: number;
  agentKeeps: number;
  backchannels: number;
  /** Total overlapped ms across closed segments. */
  totalOverlapMs: number;
  /** Mean overlap duration (ms, 0 when none). */
  meanOverlapMs: number;
  /** Slowest overlap (ms, 0 when none). */
  maxOverlapMs: number;
  /** Agent words lost across all closed segments. */
  agentWordsLost: number;
  /** Current playback volume factor (caller passes nowMs). */
  volume: number;
}

/** Events emitted by the tracker. */
export type OverlapV12Event =
  | { kind: 'overlap-opened'; segment: OverlapV12Segment }
  | { kind: 'overlap-resolved'; segment: OverlapV12Segment }
  | { kind: 'duck-start'; atMs: number; factor: number }
  | { kind: 'duck-end'; atMs: number }
  | { kind: 'backchannel'; atMs: number; speechMs: number };

export type OverlapV12EventSink = (event: OverlapV12Event) => void;

export const OVERLAP_V12_POLICIES = ['user-wins', 'agent-keeps', 'confirm'] as const;

export function isOverlapV12Policy(value: unknown): value is OverlapV12Policy {
  return typeof value === 'string' && (OVERLAP_V12_POLICIES as readonly string[]).includes(value);
}

export function defaultOverlapV12Options(): Required<OverlapV12Options> {
  return {
    policy: 'user-wins',
    duckFactor: 0.35,
    duckRampMs: 120,
    resumeRampMs: 250,
    backchannelMs: 400,
    minConfidence: 0.5,
    maxSegments: 100,
  };
}

export function validateOverlapV12Options(options: OverlapV12Options): Required<OverlapV12Options> {
  const base = defaultOverlapV12Options();
  const policy = options.policy ?? base.policy;
  if (!isOverlapV12Policy(policy)) {
    throw new Error('Overlap v12 policy must be "user-wins", "agent-keeps" or "confirm".');
  }
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Overlap v12 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    policy,
    duckFactor: num(options.duckFactor, base.duckFactor, 'duckFactor', 0, 1),
    duckRampMs: num(options.duckRampMs, base.duckRampMs, 'duckRampMs', 0, 5000),
    resumeRampMs: num(options.resumeRampMs, base.resumeRampMs, 'resumeRampMs', 0, 5000),
    backchannelMs: num(options.backchannelMs, base.backchannelMs, 'backchannelMs', 0, 10000),
    minConfidence: num(options.minConfidence, base.minConfidence, 'minConfidence', 0, 1),
    maxSegments: Math.floor(num(options.maxSegments, base.maxSegments, 'maxSegments', 1, 1000)),
  };
}

/**
 * Ducking envelope: piecewise-linear playback volume over the
 * virtual clock. `duckAt(atMs)` starts the ramp down;
 * `resumeAt(atMs)` starts the ramp back up; `volumeAt(atMs)`
 * returns the exact factor at any time. Pure math — the panel
 * and the session share it.
 */
export class DuckEnvelopeV12 {
  private readonly duckFactor: number;
  private readonly duckRampMs: number;
  private readonly resumeRampMs: number;
  private duckStartedAtMs: number | null = null;
  private resumeStartedAtMs: number | null = null;
  private resumeFromFactor = 1;

  constructor(options: { duckFactor: number; duckRampMs: number; resumeRampMs: number }) {
    this.duckFactor = options.duckFactor;
    this.duckRampMs = options.duckRampMs;
    this.resumeRampMs = options.resumeRampMs;
  }

  /** Start ramping down to the ducked volume. */
  duckAt(atMs: number): void {
    if (this.duckStartedAtMs !== null && this.resumeStartedAtMs === null) return;
    this.duckStartedAtMs = atMs;
    this.resumeStartedAtMs = null;
  }

  /** Start ramping back up to full volume (from the current factor). */
  resumeAt(atMs: number): void {
    if (this.duckStartedAtMs === null) return;
    this.resumeFromFactor = this.volumeAt(atMs);
    this.resumeStartedAtMs = atMs;
  }

  /** Playback volume factor at `atMs` (1.0 = full volume). */
  volumeAt(atMs: number): number {
    if (this.duckStartedAtMs === null) return 1;
    if (this.resumeStartedAtMs !== null) {
      if (this.resumeRampMs === 0) return 1;
      const t = Math.min(1, Math.max(0, (atMs - this.resumeStartedAtMs) / this.resumeRampMs));
      return this.resumeFromFactor + (1 - this.resumeFromFactor) * t;
    }
    if (this.duckRampMs === 0) return this.duckFactor;
    const t = Math.min(1, Math.max(0, (atMs - this.duckStartedAtMs) / this.duckRampMs));
    return 1 + (this.duckFactor - 1) * t;
  }

  /** True while the envelope is below full volume. */
  isDucked(atMs: number): boolean {
    return this.volumeAt(atMs) < 1;
  }

  reset(): void {
    this.duckStartedAtMs = null;
    this.resumeStartedAtMs = null;
    this.resumeFromFactor = 1;
  }
}

/**
 * Overlap tracker: opens a segment when the user speaks over
 * the agent, drives the ducking envelope, and resolves the
 * segment (user wins / agent keeps) with an exact log of what
 * each side lost.
 */
export class OverlapTrackerV12 {
  private readonly options: Required<OverlapV12Options>;
  private readonly sink: OverlapV12EventSink | null;
  private readonly envelope: DuckEnvelopeV12;
  private agentSpeaking = false;
  private agentText = '';
  private agentWords: string[] = [];
  private current: OverlapV12Segment | null = null;
  private segments: OverlapV12Segment[] = [];
  private nextId = 1;
  private userSpeechStartedAtMs: number | null = null;
  /** True when the current user burst already won an overlap (user-wins resolved at speech-start). */
  private userWonThisBurst = false;
  private userWins = 0;
  private agentKeeps = 0;
  private backchannels = 0;

  constructor(options: OverlapV12Options = {}, sink: OverlapV12EventSink | null = null) {
    this.options = validateOverlapV12Options(options);
    this.sink = sink;
    this.envelope = new DuckEnvelopeV12({
      duckFactor: this.options.duckFactor,
      duckRampMs: this.options.duckRampMs,
      resumeRampMs: this.options.resumeRampMs,
    });
  }

  getOptions(): Required<OverlapV12Options> {
    return { ...this.options };
  }

  getEnvelope(): DuckEnvelopeV12 {
    return this.envelope;
  }

  /** Current playback volume factor at `atMs`. */
  volumeAt(atMs: number): number {
    return this.envelope.volumeAt(atMs);
  }

  isOverlapping(): boolean {
    return this.current !== null;
  }

  getCurrentSegment(): OverlapV12Segment | null {
    return this.current ? { ...this.current, agentWordsLost: [...this.current.agentWordsLost], userWords: [...this.current.userWords] } : null;
  }

  getSegments(): OverlapV12Segment[] {
    return this.segments.map((s) => ({ ...s, agentWordsLost: [...s.agentWordsLost], userWords: [...s.userWords] }));
  }

  getStats(nowMs: number): OverlapV12Stats {
    const closed = this.segments.filter((s) => s.endedAtMs !== null);
    const total = closed.reduce((a, s) => a + s.durationMs, 0);
    return {
      overlaps: this.segments.length,
      open: this.current !== null,
      userWins: this.userWins,
      agentKeeps: this.agentKeeps,
      backchannels: this.backchannels,
      totalOverlapMs: total,
      meanOverlapMs: closed.length > 0 ? Math.round(total / closed.length) : 0,
      maxOverlapMs: closed.length > 0 ? Math.max(...closed.map((s) => s.durationMs)) : 0,
      agentWordsLost: closed.reduce((a, s) => a + s.agentWordsLost.length, 0),
      volume: this.envelope.volumeAt(nowMs),
    };
  }

  /** The agent starts speaking a reply (its text, for the lost-words log). */
  noteAgentSpeaking(replyText: string, _atMs: number): void {
    this.agentSpeaking = true;
    this.agentText = replyText;
    this.agentWords = replyText.split(/\s+/).map((w) => w.trim()).filter((w) => w.length > 0);
  }

  /** The agent stops speaking (playback drained / interrupted). */
  noteAgentStopped(): void {
    this.agentSpeaking = false;
    this.agentText = '';
    this.agentWords = [];
  }

  /**
   * The user starts speaking. When the agent is speaking this
   * opens an overlap segment and starts the duck ramp; otherwise
   * it only starts the user-speech clock (for backchannel
   * classification at speech-end).
   */
  noteUserSpeechStart(atMs: number, confidence = 1): OverlapV12Segment | null {
    if (this.userSpeechStartedAtMs === null) this.userSpeechStartedAtMs = atMs;
    if (!this.agentSpeaking || this.current !== null) return this.current;
    const segment: OverlapV12Segment = {
      id: this.nextId,
      startedAtMs: atMs,
      endedAtMs: null,
      durationMs: 0,
      userConfidence: confidence,
      agentWordsLost: [],
      userWords: [],
      winner: 'unresolved',
      resolutionReason: '',
      minVolume: 1,
    };
    this.nextId += 1;
    this.current = segment;
    this.segments.push(segment);
    if (this.segments.length > this.options.maxSegments) {
      this.segments.splice(0, this.segments.length - this.options.maxSegments);
    }
    this.envelope.duckAt(atMs);
    this.sink?.({ kind: 'duck-start', atMs, factor: this.options.duckFactor });
    this.sink?.({ kind: 'overlap-opened', segment: { ...segment } });
    // `user-wins` resolves immediately on confirmed speech;
    // the other policies wait for the speech to end (or an
    // explicit resolve) so a backchannel never steals the floor.
    if (this.options.policy === 'user-wins' && confidence >= this.options.minConfidence) {
      this.resolveOverlap('user', atMs, 'user-wins policy: confirmed user speech over the agent');
      this.userWonThisBurst = true;
    }
    return this.current;
  }

  /** Feed one user word spoken during the overlap (partial STT). */
  noteUserWord(word: string): void {
    const clean = word.trim();
    if (!clean || !this.current) return;
    this.current.userWords.push(clean);
  }

  /**
   * The user stops speaking: with `agent-keeps` this is where
   * the segment resolves (backchannel vs real turn); with
   * `user-wins` the segment already resolved at speech-start
   * and this only ramps the volume back up.
   */
  noteUserSpeechEnd(atMs: number): OverlapV12Segment | null {
    const speechMs = this.userSpeechStartedAtMs !== null ? Math.max(0, atMs - this.userSpeechStartedAtMs) : 0;
    this.userSpeechStartedAtMs = null;
    if (!this.current) {
      // The burst already won its overlap at speech-start
      // (user-wins): it is a real turn, not a backchannel.
      if (this.userWonThisBurst) {
        this.userWonThisBurst = false;
        this.envelope.resumeAt(atMs);
        return null;
      }
      // No open overlap: a lone short burst is still a
      // backchannel worth counting for the panel.
      if (speechMs > 0 && speechMs < this.options.backchannelMs) {
        this.backchannels += 1;
        this.sink?.({ kind: 'backchannel', atMs, speechMs });
      }
      this.envelope.resumeAt(atMs);
      return null;
    }
    this.current.durationMs = Math.max(0, atMs - this.current.startedAtMs);
    if (this.current.winner !== 'unresolved') {
      // Already resolved at speech-start (user-wins): just
      // close the segment and ramp the volume back up.
      return this.closeSegment(atMs, 'user-wins policy: confirmed user speech over the agent');
    }
    if (this.options.policy === 'agent-keeps') {
      if (speechMs < this.options.backchannelMs || this.current.userConfidence < this.options.minConfidence) {
        this.backchannels += 1;
        this.sink?.({ kind: 'backchannel', atMs, speechMs });
        return this.resolveOverlap('agent', atMs, 'backchannel: short or low-confidence burst, agent keeps the floor');
      }
      return this.resolveOverlap('user', atMs, 'agent-keeps policy: sustained confident speech, user takes the floor');
    }
    // `confirm` policy: the caller resolves explicitly; the
    // speech-end only ramps the volume back up.
    this.envelope.resumeAt(atMs);
    return this.current;
  }

  /**
   * Resolve the open overlap explicitly. `agentCutWordIndex`
   * is the index of the word the agent was speaking when the
   * cut happened — every word from there on is logged as lost.
   */
  resolveOverlap(winner: 'user' | 'agent', atMs: number, reason: string, agentCutWordIndex?: number): OverlapV12Segment | null {
    if (!this.current) return null;
    if (this.current.winner !== 'unresolved') return this.closeSegment(atMs, reason);
    this.current.winner = winner;
    this.current.resolutionReason = reason;
    if (winner === 'user') this.userWins += 1;
    else this.agentKeeps += 1;
    if (typeof agentCutWordIndex === 'number' && agentCutWordIndex >= 0) {
      this.current.agentWordsLost = this.agentWords.slice(agentCutWordIndex);
    }
    return this.closeSegment(atMs, reason);
  }

  /** Reset all state. */
  reset(): void {
    this.agentSpeaking = false;
    this.agentText = '';
    this.agentWords = [];
    this.current = null;
    this.segments = [];
    this.nextId = 1;
    this.userSpeechStartedAtMs = null;
    this.userWonThisBurst = false;
    this.userWins = 0;
    this.agentKeeps = 0;
    this.backchannels = 0;
    this.envelope.reset();
  }

  private closeSegment(atMs: number, reason: string): OverlapV12Segment | null {
    const segment = this.current;
    if (!segment) return null;
    segment.endedAtMs = atMs;
    segment.durationMs = Math.max(0, atMs - segment.startedAtMs);
    segment.minVolume = this.options.duckFactor;
    if (!segment.resolutionReason) segment.resolutionReason = reason;
    if (segment.winner === 'unresolved') segment.winner = 'agent';
    this.current = null;
    this.envelope.resumeAt(atMs);
    this.sink?.({ kind: 'duck-end', atMs });
    this.sink?.({ kind: 'overlap-resolved', segment: { ...segment, agentWordsLost: [...segment.agentWordsLost], userWords: [...segment.userWords] } });
    return { ...segment, agentWordsLost: [...segment.agentWordsLost], userWords: [...segment.userWords] };
  }
}

/** Create an overlap tracker (factory). */
export function createOverlapTrackerV12(options: OverlapV12Options = {}, sink: OverlapV12EventSink | null = null): OverlapTrackerV12 {
  return new OverlapTrackerV12(options, sink);
}

/** One-line summary of overlap stats. */
export function overlapV12Summary(stats: OverlapV12Stats): string {
  return (
    `Overlap v12: ${stats.overlaps} overlaps (${stats.userWins} user wins, ${stats.agentKeeps} agent keeps, ` +
    `${stats.backchannels} backchannels), ${stats.totalOverlapMs} ms overlapped ` +
    `(mean ${stats.meanOverlapMs} ms, max ${stats.maxOverlapMs} ms), ` +
    `${stats.agentWordsLost} agent words lost, volume ×${stats.volume.toFixed(2)}${stats.open ? ', overlap open' : ''}`
  );
}

/** Overlap stats + segment log as Markdown (for the diagnostics panel). */
export function overlapV12Markdown(stats: OverlapV12Stats, segments: OverlapV12Segment[]): string {
  const lines = [
    '## Overlap v12',
    '',
    `- overlaps: ${stats.overlaps} (user wins ${stats.userWins}, agent keeps ${stats.agentKeeps}, backchannels ${stats.backchannels})`,
    `- overlapped: ${stats.totalOverlapMs} ms (mean ${stats.meanOverlapMs} ms, max ${stats.maxOverlapMs} ms)`,
    `- agent words lost: ${stats.agentWordsLost}`,
    `- volume: ×${stats.volume.toFixed(2)}${stats.open ? ' (overlap open)' : ''}`,
  ];
  for (const s of segments.slice(-10)) {
    lines.push(
      `- #${s.id} ${s.startedAtMs}–${s.endedAtMs ?? '?'} ms (${s.durationMs} ms): ${s.winner}` +
      (s.agentWordsLost.length > 0 ? `, agent lost "${s.agentWordsLost.join(' ')}"` : '') +
      (s.userWords.length > 0 ? `, user said "${s.userWords.join(' ')}"` : '') +
      (s.resolutionReason ? ` — ${s.resolutionReason}` : ''),
    );
  }
  return lines.join('\n');
}
