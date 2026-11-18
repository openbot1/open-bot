/**
 * Turn-taking state machine v21 (voice v21, v1.34 Team T5).
 *
 * A realtime voice session is always in exactly one turn state:
 *
 *   idle ──► listening ──► waiting ──► speaking ──► listening …
 *              ▲              │            │
 *              └──────────────┴── barge-in ┘
 *   waiting ──► confirming ──► waiting
 *   (speaking the confirmation prompt keeps the machine in
 *   confirming — the wait only ends on confirm-resolved; the
 *   result is then spoken from waiting, as usual.)
 *
 *   - idle: session open, nobody talking.
 *   - listening: the user is speaking (or may start); VAD is armed.
 *   - waiting: the user stopped; the model / tool call is working.
 *   - speaking: the agent is reading its reply out loud (TTS).
 *   - confirming: a side-effecting tool call is waiting for a
 *     spoken yes/no; the next user utterance is an answer, not a
 *     new request.
 *
 * Two things make this more than a toy enum:
 *
 *   - Overlap. Speech that starts while the agent is speaking is
 *     not a clean turn — it is an overlap, and the machine records
 *     it (who overlapped whom, for how long) so the barge-in
 *     engine can decide whether to cut the TTS. A short overlap
 *     (a backchannel "ừ", "yeah") is absorbed; a sustained one
 *     becomes a barge-in.
 *   - Latency. Every transition is timestamped on the virtual
 *     clock, so the machine can report response latency (user
 *     speech end → agent speech start) and turn durations — the
 *     numbers the eval and the monitor panel display.
 *
 * Invalid transitions are rejected with a reason instead of
 * silently corrupting state (e.g. `agentSpeakEnd` while idle).
 * The machine never touches audio; it only tracks state.
 */
import {
  round2V21,
  type VoiceV21EventSink,
  type VoiceV21TurnRecord,
  type VoiceV21TurnState,
} from './types';

export type VoiceV21TurnEventKind =
  | 'user-speech-start'
  | 'user-speech-end'
  | 'agent-speak-start'
  | 'agent-speak-end'
  | 'barge-in'
  | 'confirm-requested'
  | 'confirm-resolved'
  | 'timeout'
  | 'reset';

export interface VoiceV21TurnTransition {
  from: VoiceV21TurnState;
  to: VoiceV21TurnState;
  event: VoiceV21TurnEventKind;
  atMs: number;
  /** Why a transition was rejected (undefined when accepted). */
  rejectedReason?: string;
}

export interface VoiceV21OverlapRecord {
  atMs: number;
  /** Who was speaking when the overlap started. */
  interruptedState: VoiceV21TurnState;
  durationMs: number;
  /** True when the overlap became a barge-in. */
  becameBargeIn: boolean;
}

export interface VoiceV21TurnTakingOptions {
  /** Overlap longer than this is a barge-in candidate (default 400 ms). */
  overlapBargeInMs: number;
  /** Overlap at or below this is a backchannel, absorbed (default 150 ms). */
  backchannelMaxMs: number;
  /** Max time in `waiting` before a timeout transition (default 30_000 ms). */
  waitingTimeoutMs: number;
  /** Max turns kept in history (default 100). */
  maxTurns: number;
}

export function defaultTurnTakingV21Options(): VoiceV21TurnTakingOptions {
  return {
    overlapBargeInMs: 400,
    backchannelMaxMs: 150,
    waitingTimeoutMs: 30_000,
    maxTurns: 100,
  };
}

export function validateTurnTakingV21Options(o: Partial<VoiceV21TurnTakingOptions>): string[] {
  const e: string[] = [];
  if (o.overlapBargeInMs !== undefined && (o.overlapBargeInMs < 0 || o.overlapBargeInMs > 5000)) {
    e.push('overlapBargeInMs must be 0..5000');
  }
  if (o.backchannelMaxMs !== undefined && (o.backchannelMaxMs < 0 || o.backchannelMaxMs > 2000)) {
    e.push('backchannelMaxMs must be 0..2000');
  }
  if (o.waitingTimeoutMs !== undefined && (o.waitingTimeoutMs < 1000 || o.waitingTimeoutMs > 300_000)) {
    e.push('waitingTimeoutMs must be 1000..300000');
  }
  if (o.maxTurns !== undefined && (!Number.isInteger(o.maxTurns) || o.maxTurns < 1)) {
    e.push('maxTurns must be a positive integer');
  }
  return e;
}

export interface VoiceV21TurnTakingStats {
  state: VoiceV21TurnState;
  turns: number;
  overlaps: number;
  bargeIns: number;
  backchannels: number;
  invalidTransitions: number;
  /** Mean response latency (speech end → speak start), ms. */
  meanResponseLatencyMs: number;
  /** p95 response latency, ms. */
  p95ResponseLatencyMs: number;
  /** Mean user turn duration, ms. */
  meanUserTurnMs: number;
  /** Mean agent turn duration, ms. */
  meanAgentTurnMs: number;
}

/** Allowed transitions, by (from-state, event). */
const TRANSITIONS: Record<VoiceV21TurnState, Partial<Record<VoiceV21TurnEventKind, VoiceV21TurnState>>> = {
  idle: {
    'user-speech-start': 'listening',
    reset: 'idle',
  },
  listening: {
    'user-speech-start': 'listening',
    'user-speech-end': 'waiting',
    'barge-in': 'listening',
    'confirm-requested': 'confirming',
    timeout: 'idle',
    reset: 'idle',
  },
  waiting: {
    'agent-speak-start': 'speaking',
    'user-speech-start': 'listening',
    'confirm-requested': 'confirming',
    timeout: 'idle',
    reset: 'idle',
  },
  speaking: {
    'agent-speak-end': 'listening',
    'user-speech-start': 'listening',
    'barge-in': 'listening',
    'confirm-requested': 'confirming',
    timeout: 'idle',
    reset: 'idle',
  },
  confirming: {
    'confirm-resolved': 'waiting',
    // Speaking the confirmation prompt does not end the wait: the
    // session stays in confirming until the user answers. (Before,
    // agent-speak-start moved confirming → speaking and the prompt
    // ended in listening, so the session never looked confirming.)
    'agent-speak-start': 'confirming',
    'agent-speak-end': 'confirming',
    'user-speech-start': 'confirming',
    'user-speech-end': 'confirming',
    timeout: 'idle',
    reset: 'idle',
  },
};

function percentileSortedV21(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export class TurnTakingMachineV21 {
  private readonly opts: VoiceV21TurnTakingOptions;
  private readonly sink?: VoiceV21EventSink;
  private readonly sessionId: string;
  private state: VoiceV21TurnState = 'idle';
  private stateSinceMs = 0;
  private readonly transitions: VoiceV21TurnTransition[] = [];
  private readonly turns: VoiceV21TurnRecord[] = [];
  private readonly overlaps: VoiceV21OverlapRecord[] = [];
  private readonly responseLatencies: number[] = [];
  private readonly userTurnDurations: number[] = [];
  private readonly agentTurnDurations: number[] = [];
  private invalidTransitions = 0;
  private turnCounter = 0;
  private currentTurn: VoiceV21TurnRecord | null = null;
  private lastUserSpeechEndMs: number | null = null;
  private overlapStartMs: number | null = null;
  private overlapState: VoiceV21TurnState | null = null;

  constructor(sessionId: string, opts: Partial<VoiceV21TurnTakingOptions> = {}, sink?: VoiceV21EventSink) {
    this.sessionId = sessionId;
    this.opts = { ...defaultTurnTakingV21Options(), ...opts };
    this.sink = sink;
  }

  currentState(): VoiceV21TurnState {
    return this.state;
  }

  /**
   * Session is open and ready to listen, but nobody is speaking
   * yet: idle → listening without opening a user turn. (A plain
   * `user-speech-start` would open a turn for speech that never
   * happened and pollute the turn durations.)
   */
  setListening(atMs: number): VoiceV21TurnTransition {
    const from = this.state;
    if (from !== 'idle') {
      this.invalidTransitions += 1;
      const rejected: VoiceV21TurnTransition = {
        from,
        to: from,
        event: 'user-speech-start',
        atMs,
        rejectedReason: `setListening is only valid from "idle", not "${from}".`,
      };
      this.transitions.push(rejected);
      return rejected;
    }
    this.state = 'listening';
    this.stateSinceMs = atMs;
    const transition: VoiceV21TurnTransition = { from, to: 'listening', event: 'user-speech-start', atMs };
    this.transitions.push(transition);
    this.sink?.({
      kind: 'turn-state',
      atMs,
      sessionId: this.sessionId,
      detail: { from, to: 'listening', event: 'user-speech-start' },
    });
    return transition;
  }

  stateSince(): number {
    return this.stateSinceMs;
  }

  msInState(atMs: number): number {
    return Math.max(0, atMs - this.stateSinceMs);
  }

  history(): VoiceV21TurnTransition[] {
    return [...this.transitions];
  }

  turnHistory(): VoiceV21TurnRecord[] {
    return [...this.turns];
  }

  overlapHistory(): VoiceV21OverlapRecord[] {
    return [...this.overlaps];
  }

  /**
   * Feed one event into the machine. Returns the transition (with
   * `rejectedReason` set when the event does not apply in the
   * current state). Rejected events never change state.
   */
  handle(event: VoiceV21TurnEventKind, atMs: number, detail?: { text?: string; toolCallId?: string }): VoiceV21TurnTransition {
    const from = this.state;
    const to = TRANSITIONS[from]?.[event];
    if (to === undefined) {
      this.invalidTransitions += 1;
      const rejected: VoiceV21TurnTransition = {
        from,
        to: from,
        event,
        atMs,
        rejectedReason: `Event "${event}" is not valid in state "${from}".`,
      };
      this.transitions.push(rejected);
      return rejected;
    }
    // Overlap bookkeeping: user speech starting while the agent speaks.
    if (event === 'user-speech-start' && from === 'speaking') {
      this.overlapStartMs = atMs;
      this.overlapState = from;
    }
    if (event === 'user-speech-end' && this.overlapStartMs !== null) {
      this.closeOverlap(atMs, false);
    }
    if (event === 'barge-in') {
      this.closeOverlap(atMs, true);
    }
    // Turn records: open a user turn on speech start, close on speech end.
    if (event === 'user-speech-start' && this.currentTurn === null) {
      this.currentTurn = {
        id: `turn-${++this.turnCounter}`,
        role: 'user',
        text: detail?.text ?? '',
        atMs,
        durationMs: 0,
      };
    }
    if (event === 'user-speech-end' && this.currentTurn !== null && this.currentTurn.role === 'user') {
      this.currentTurn.durationMs = atMs - this.currentTurn.atMs;
      if (detail?.text !== undefined) this.currentTurn.text = detail.text;
      this.userTurnDurations.push(this.currentTurn.durationMs);
      this.pushTurn(this.currentTurn);
      this.currentTurn = null;
      this.lastUserSpeechEndMs = atMs;
    }
    if (event === 'agent-speak-start' && this.currentTurn === null) {
      this.currentTurn = {
        id: `turn-${++this.turnCounter}`,
        role: 'agent',
        text: detail?.text ?? '',
        atMs,
        durationMs: 0,
        toolCallId: detail?.toolCallId,
      };
      if (this.lastUserSpeechEndMs !== null) {
        this.responseLatencies.push(Math.max(0, atMs - this.lastUserSpeechEndMs));
        this.lastUserSpeechEndMs = null;
      }
    }
    if (event === 'agent-speak-end' && this.currentTurn !== null && this.currentTurn.role === 'agent') {
      this.currentTurn.durationMs = atMs - this.currentTurn.atMs;
      if (detail?.text !== undefined) this.currentTurn.text = detail.text;
      this.agentTurnDurations.push(this.currentTurn.durationMs);
      this.pushTurn(this.currentTurn);
      this.currentTurn = null;
    }
    if (event === 'barge-in' && this.currentTurn !== null && this.currentTurn.role === 'agent') {
      // The agent turn is cut: keep what was spoken, mark the cut.
      this.currentTurn.durationMs = atMs - this.currentTurn.atMs;
      if (detail?.text !== undefined) this.currentTurn.text = detail.text;
      this.currentTurn.bargeInCut = true;
      this.agentTurnDurations.push(this.currentTurn.durationMs);
      this.pushTurn(this.currentTurn);
      this.currentTurn = null;
    }
    this.state = to;
    this.stateSinceMs = atMs;
    const transition: VoiceV21TurnTransition = { from, to, event, atMs };
    this.transitions.push(transition);
    this.sink?.({
      kind: 'turn-state',
      atMs,
      sessionId: this.sessionId,
      detail: { from, to, event },
    });
    return transition;
  }

  private pushTurn(turn: VoiceV21TurnRecord): void {
    this.turns.push(turn);
    while (this.turns.length > this.opts.maxTurns) this.turns.shift();
  }

  private closeOverlap(atMs: number, becameBargeIn: boolean): void {
    if (this.overlapStartMs === null || this.overlapState === null) return;
    const durationMs = Math.max(0, atMs - this.overlapStartMs);
    this.overlaps.push({
      atMs: this.overlapStartMs,
      interruptedState: this.overlapState,
      durationMs,
      becameBargeIn,
    });
    this.overlapStartMs = null;
    this.overlapState = null;
  }

  /**
   * Classify a finished overlap: backchannel (short, absorbed),
   * overlap (sustained, recorded) or barge-in (long enough that
   * the agent should have stopped). Pure function of duration.
   */
  classifyOverlap(durationMs: number): 'backchannel' | 'overlap' | 'barge-in' {
    if (durationMs <= this.opts.backchannelMaxMs) return 'backchannel';
    if (durationMs >= this.opts.overlapBargeInMs) return 'barge-in';
    return 'overlap';
  }

  /** Fire a timeout transition when `waiting` overstays. Returns true when it fired. */
  checkWaitingTimeout(atMs: number): boolean {
    if (this.state === 'waiting' && atMs - this.stateSinceMs > this.opts.waitingTimeoutMs) {
      this.handle('timeout', atMs);
      return true;
    }
    return false;
  }

  /** The turn currently in progress, if any. */
  currentTurnRecord(): VoiceV21TurnRecord | null {
    return this.currentTurn === null ? null : { ...this.currentTurn };
  }

  stats(): VoiceV21TurnTakingStats {
    const mean = (xs: number[]): number =>
      xs.length === 0 ? 0 : round2V21(xs.reduce((s, x) => s + x, 0) / xs.length);
    const sorted = [...this.responseLatencies].sort((a, b) => a - b);
    return {
      state: this.state,
      turns: this.turns.length,
      overlaps: this.overlaps.length,
      bargeIns: this.overlaps.filter((o) => o.becameBargeIn).length,
      backchannels: this.overlaps.filter((o) => o.durationMs <= this.opts.backchannelMaxMs).length,
      invalidTransitions: this.invalidTransitions,
      meanResponseLatencyMs: mean(this.responseLatencies),
      p95ResponseLatencyMs: round2V21(percentileSortedV21(sorted, 95)),
      meanUserTurnMs: mean(this.userTurnDurations),
      meanAgentTurnMs: mean(this.agentTurnDurations),
    };
  }

  summary(): string {
    const s = this.stats();
    return `turn-taking: state=${s.state}, turns=${s.turns}, overlaps=${s.overlaps} ` +
      `(${s.bargeIns} barge-in, ${s.backchannels} backchannel), mean response latency ${s.meanResponseLatencyMs} ms ` +
      `(p95 ${s.p95ResponseLatencyMs} ms), invalid=${s.invalidTransitions}`;
  }
}

export function createTurnTakingMachineV21(
  sessionId: string,
  opts: Partial<VoiceV21TurnTakingOptions> = {},
  sink?: VoiceV21EventSink,
): TurnTakingMachineV21 {
  return new TurnTakingMachineV21(sessionId, opts, sink);
}
