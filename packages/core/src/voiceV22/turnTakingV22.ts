/**
 * Turn-taking state machine v22 (voice v22, v1.35 Team T5).
 *
 * v21 tracked one state per session. v22 adds the floor: at
 * any moment exactly one party holds it (user, agent, or none),
 * and the machine arbitrates who gets it next.
 *
 *   idle ──► listening ──► waiting ──► speaking ──► listening …
 *              ▲              │            │
 *              └──────────────┴── barge-in ┘
 *   waiting ──► confirming ──► waiting / speaking
 *   listening/speaking ──► yielded ──► listening (floor given up)
 *   any ──► paused ──► listening (session paused / resumed)
 *
 *   - idle: session open, nobody talking.
 *   - listening: the user holds the floor (or may take it); VAD armed.
 *   - waiting: the user stopped; the model / tool call is working.
 *   - speaking: the agent holds the floor (TTS).
 *   - confirming: a side-effecting tool call waits for a spoken yes/no.
 *   - yielded: the agent gave the floor up mid-reply (duck-hard);
 *     the reply is held, not lost, and resumes when the user
 *     finishes — or is dropped when the user takes over.
 *   - paused: the session is parked (disconnect, manual pause);
 *     nothing speaks until it resumes.
 *
 * Two things make this more than a toy enum:
 *
 *   - Floor arbitration. `requestFloor` takes a party, a
 *     priority and a reason; the machine grants it, queues it,
 *     or refuses it with a reason. An interrupt outranks a
 *     duck; a duck outranks a polite yield request. Requests
 *     are logged so the panel can show who waited for whom.
 *   - Silence. A listening state that hears nothing for the
 *     silence window nudges the user ("are you still there?")
 *     once, then yields the floor to nobody; a waiting state
 *     that overstays its timeout returns to idle. Both are
 *     driven by the virtual clock the host advances.
 *
 * Invalid transitions are rejected with a reason instead of
 * silently corrupting state. The machine never touches audio;
 * it only tracks state and the floor.
 */
import {
  round2V22,
  type VoiceV22EventSink,
  type VoiceV22FloorHolder,
  type VoiceV22TurnRecord,
  type VoiceV22TurnState,
} from './types';

export type VoiceV22TurnEventKind =
  | 'user-speech-start'
  | 'user-speech-end'
  | 'agent-speak-start'
  | 'agent-speak-end'
  | 'barge-in'
  | 'duck-hard'
  | 'duck-soft'
  | 'yield'
  | 'resume-held'
  | 'pause'
  | 'resume'
  | 'confirm-requested'
  | 'confirm-resolved'
  | 'timeout'
  | 'silence-nudge'
  | 'reset';

export interface VoiceV22TurnTransition {
  from: VoiceV22TurnState;
  to: VoiceV22TurnState;
  event: VoiceV22TurnEventKind;
  atMs: number;
  /** Why a transition was rejected (undefined when accepted). */
  rejectedReason?: string;
}

export interface VoiceV22OverlapRecord {
  atMs: number;
  /** Who was speaking when the overlap started. */
  interruptedState: VoiceV22TurnState;
  durationMs: number;
  /** True when the overlap became a barge-in. */
  becameBargeIn: boolean;
  /** True when the overlap was absorbed as a backchannel. */
  backchannel: boolean;
}

export type VoiceV22FloorRequester = 'user' | 'agent' | 'system';
export type VoiceV22FloorPriority = 'polite' | 'duck' | 'interrupt';

export interface VoiceV22FloorRequest {
  id: string;
  requester: VoiceV22FloorRequester;
  priority: VoiceV22FloorPriority;
  reason: string;
  atMs: number;
  /** Granted, queued, or refused. */
  outcome: 'granted' | 'queued' | 'refused';
  /** Why a request was refused / queued. */
  note?: string;
}

export interface VoiceV22TurnTakingOptions {
  /** Overlap longer than this is a barge-in candidate (default 400 ms). */
  overlapBargeInMs: number;
  /** Overlap at or below this is a backchannel, absorbed (default 150 ms). */
  backchannelMaxMs: number;
  /** Max time in `waiting` before a timeout transition (default 30_000 ms). */
  waitingTimeoutMs: number;
  /** Silence in `listening` before a nudge (default 8000 ms). */
  silenceNudgeMs: number;
  /** Silence in `listening` before the floor is yielded to none (default 20_000 ms). */
  silenceYieldMs: number;
  /** Max turns kept in history (default 100). */
  maxTurns: number;
  /** Max floor requests kept (default 50). */
  maxFloorRequests: number;
}

export function defaultTurnTakingV22Options(): VoiceV22TurnTakingOptions {
  return {
    overlapBargeInMs: 400,
    backchannelMaxMs: 150,
    waitingTimeoutMs: 30_000,
    silenceNudgeMs: 8000,
    silenceYieldMs: 20_000,
    maxTurns: 100,
    maxFloorRequests: 50,
  };
}

export function validateTurnTakingV22Options(o: Partial<VoiceV22TurnTakingOptions>): string[] {
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
  if (o.silenceNudgeMs !== undefined && (o.silenceNudgeMs < 1000 || o.silenceNudgeMs > 120_000)) {
    e.push('silenceNudgeMs must be 1000..120000');
  }
  if (o.silenceYieldMs !== undefined && (o.silenceYieldMs < 1000 || o.silenceYieldMs > 300_000)) {
    e.push('silenceYieldMs must be 1000..300000');
  }
  if (o.silenceNudgeMs !== undefined && o.silenceYieldMs !== undefined && o.silenceYieldMs <= o.silenceNudgeMs) {
    e.push('silenceYieldMs must be above silenceNudgeMs');
  }
  if (o.maxTurns !== undefined && (!Number.isInteger(o.maxTurns) || o.maxTurns < 1)) {
    e.push('maxTurns must be a positive integer');
  }
  if (o.maxFloorRequests !== undefined && (!Number.isInteger(o.maxFloorRequests) || o.maxFloorRequests < 1)) {
    e.push('maxFloorRequests must be a positive integer');
  }
  return e;
}

export interface VoiceV22TurnTakingStats {
  state: VoiceV22TurnState;
  floor: VoiceV22FloorHolder;
  turns: number;
  overlaps: number;
  bargeIns: number;
  backchannels: number;
  ducks: number;
  yields: number;
  pauses: number;
  floorRequests: number;
  floorGrants: number;
  floorRefusals: number;
  invalidTransitions: number;
  silenceNudges: number;
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
const TRANSITIONS: Record<VoiceV22TurnState, Partial<Record<VoiceV22TurnEventKind, VoiceV22TurnState>>> = {
  idle: {
    'user-speech-start': 'listening',
    'agent-speak-start': 'speaking',
    resume: 'listening',
    reset: 'idle',
  },
  listening: {
    'user-speech-start': 'listening',
    'user-speech-end': 'waiting',
    'agent-speak-start': 'speaking',
    'barge-in': 'listening',
    'duck-hard': 'yielded',
    'duck-soft': 'listening',
    yield: 'yielded',
    pause: 'paused',
    'confirm-requested': 'confirming',
    'silence-nudge': 'listening',
    timeout: 'idle',
    reset: 'idle',
  },
  waiting: {
    'agent-speak-start': 'speaking',
    'user-speech-start': 'listening',
    pause: 'paused',
    'confirm-requested': 'confirming',
    timeout: 'idle',
    reset: 'idle',
  },
  speaking: {
    'agent-speak-end': 'listening',
    'user-speech-start': 'listening',
    'barge-in': 'listening',
    'duck-hard': 'yielded',
    'duck-soft': 'speaking',
    yield: 'yielded',
    pause: 'paused',
    'confirm-requested': 'confirming',
    timeout: 'idle',
    reset: 'idle',
  },
  confirming: {
    'confirm-resolved': 'waiting',
    'agent-speak-start': 'speaking',
    'user-speech-start': 'confirming',
    'user-speech-end': 'confirming',
    pause: 'paused',
    timeout: 'idle',
    reset: 'idle',
  },
  yielded: {
    'resume-held': 'speaking',
    'agent-speak-start': 'speaking',
    'user-speech-start': 'listening',
    'user-speech-end': 'listening',
    pause: 'paused',
    timeout: 'idle',
    reset: 'idle',
  },
  paused: {
    resume: 'listening',
    'user-speech-start': 'listening',
    'agent-speak-start': 'speaking',
    reset: 'idle',
  },
};

function percentileSortedV22(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

const PRIORITY_RANK: Record<VoiceV22FloorPriority, number> = { polite: 1, duck: 2, interrupt: 3 };

export class TurnTakingMachineV22 {
  private readonly opts: VoiceV22TurnTakingOptions;
  private readonly sink?: VoiceV22EventSink;
  private readonly sessionId: string;
  private state: VoiceV22TurnState = 'idle';
  private floor: VoiceV22FloorHolder = 'none';
  private stateSinceMs = 0;
  private readonly transitions: VoiceV22TurnTransition[] = [];
  private readonly turns: VoiceV22TurnRecord[] = [];
  private readonly overlaps: VoiceV22OverlapRecord[] = [];
  private readonly floorRequests: VoiceV22FloorRequest[] = [];
  private readonly responseLatencies: number[] = [];
  private readonly userTurnDurations: number[] = [];
  private readonly agentTurnDurations: number[] = [];
  private invalidTransitions = 0;
  private turnCounter = 0;
  private requestCounter = 0;
  private currentTurn: VoiceV22TurnRecord | null = null;
  private lastUserSpeechEndMs: number | null = null;
  private overlapStartMs: number | null = null;
  private overlapState: VoiceV22TurnState | null = null;
  private silenceNudges = 0;
  private nudgedAtMs: number | null = null;
  private heldReply: string | null = null;

  constructor(sessionId: string, opts: Partial<VoiceV22TurnTakingOptions> = {}, sink?: VoiceV22EventSink) {
    this.sessionId = sessionId;
    this.opts = { ...defaultTurnTakingV22Options(), ...opts };
    this.sink = sink;
  }

  currentState(): VoiceV22TurnState {
    return this.state;
  }

  currentFloor(): VoiceV22FloorHolder {
    return this.floor;
  }

  /**
   * Session is open and ready to listen, but nobody is speaking
   * yet: idle → listening without opening a user turn. (A plain
   * `user-speech-start` would open a turn for speech that never
   * happened and pollute the turn durations.)
   */
  setListening(atMs: number): VoiceV22TurnTransition {
    const from = this.state;
    if (from !== 'idle') {
      this.invalidTransitions += 1;
      const rejected: VoiceV22TurnTransition = {
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
    this.floor = 'user';
    this.stateSinceMs = atMs;
    const transition: VoiceV22TurnTransition = { from, to: 'listening', event: 'user-speech-start', atMs };
    this.transitions.push(transition);
    this.emitTurn(transition);
    return transition;
  }

  stateSince(): number {
    return this.stateSinceMs;
  }

  msInState(atMs: number): number {
    return Math.max(0, atMs - this.stateSinceMs);
  }

  history(): VoiceV22TurnTransition[] {
    return [...this.transitions];
  }

  turnHistory(): VoiceV22TurnRecord[] {
    return this.turns.map((t) => ({ ...t }));
  }

  overlapHistory(): VoiceV22OverlapRecord[] {
    return this.overlaps.map((o) => ({ ...o }));
  }

  floorRequestHistory(): VoiceV22FloorRequest[] {
    return this.floorRequests.map((r) => ({ ...r }));
  }

  private emitTurn(t: VoiceV22TurnTransition): void {
    this.sink?.({
      kind: 'turn-state',
      atMs: t.atMs,
      sessionId: this.sessionId,
      detail: { from: t.from, to: t.to, event: t.event, floor: this.floor },
    });
  }

  private setFloor(holder: VoiceV22FloorHolder, atMs: number): void {
    if (this.floor === holder) return;
    this.floor = holder;
    this.sink?.({ kind: 'floor', atMs, sessionId: this.sessionId, detail: { floor: holder } });
  }

  /**
   * Ask for the floor. An interrupt outranks everything and is
   * granted at once; a duck is granted when the agent holds the
   * floor (it yields) and queued otherwise; a polite request is
   * granted only when the floor is free, queued when the other
   * party is mid-turn, refused when the session is paused.
   */
  requestFloor(
    requester: VoiceV22FloorRequester,
    priority: VoiceV22FloorPriority,
    reason: string,
    atMs: number,
  ): VoiceV22FloorRequest {
    const id = `floor-${++this.requestCounter}`;
    let outcome: VoiceV22FloorRequest['outcome'];
    let note: string | undefined;
    const holder: VoiceV22FloorHolder = requester === 'system' ? 'none' : requester;
    if (this.state === 'paused') {
      outcome = 'refused';
      note = 'session is paused';
    } else if (priority === 'interrupt') {
      outcome = 'granted';
      this.setFloor(holder, atMs);
      note = 'interrupt outranks the current holder';
    } else if (this.floor === 'none' || this.floor === holder) {
      outcome = 'granted';
      this.setFloor(holder, atMs);
    } else if (priority === 'duck') {
      outcome = 'granted';
      this.setFloor(holder, atMs);
      note = 'duck yields the floor to the requester';
    } else {
      outcome = 'queued';
      note = `floor held by ${this.floor}`;
    }
    const request: VoiceV22FloorRequest = { id, requester, priority, reason, atMs, outcome, ...(note !== undefined ? { note } : {}) };
    this.floorRequests.push(request);
    while (this.floorRequests.length > this.opts.maxFloorRequests) this.floorRequests.shift();
    return { ...request };
  }

  /** Release the floor to nobody (end of a turn, no one waiting). */
  releaseFloor(atMs: number): void {
    this.setFloor('none', atMs);
  }

  /** Hold a reply text while the floor is yielded (duck-hard). */
  holdReply(text: string): void {
    this.heldReply = text;
  }

  heldReplyText(): string | null {
    return this.heldReply;
  }

  clearHeldReply(): void {
    this.heldReply = null;
  }

  /**
   * Feed one event into the machine. Returns the transition (with
   * `rejectedReason` set when the event does not apply in the
   * current state). Rejected events never change state.
   */
  handle(event: VoiceV22TurnEventKind, atMs: number, detail?: { text?: string; toolCallId?: string }): VoiceV22TurnTransition {
    const from = this.state;
    const to = TRANSITIONS[from]?.[event];
    if (to === undefined) {
      this.invalidTransitions += 1;
      const rejected: VoiceV22TurnTransition = {
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
      this.closeOverlap(atMs, false, false);
    }
    if (event === 'barge-in') {
      this.closeOverlap(atMs, true, false);
    }
    if (event === 'duck-hard' && detail?.text !== undefined) {
      this.holdReply(detail.text);
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
      this.setFloor('user', atMs);
    }
    if (event === 'user-speech-end' && this.currentTurn !== null && this.currentTurn.role === 'user') {
      this.currentTurn.durationMs = atMs - this.currentTurn.atMs;
      if (detail?.text !== undefined) this.currentTurn.text = detail.text;
      this.userTurnDurations.push(this.currentTurn.durationMs);
      this.pushTurn(this.currentTurn);
      this.currentTurn = null;
      this.lastUserSpeechEndMs = atMs;
      this.nudgedAtMs = null;
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
      this.setFloor('agent', atMs);
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
      this.setFloor('user', atMs);
    }
    if (event === 'barge-in' && this.currentTurn !== null && this.currentTurn.role === 'agent') {
      // The agent turn is cut: keep what was spoken, mark the cut.
      this.currentTurn.durationMs = atMs - this.currentTurn.atMs;
      if (detail?.text !== undefined) this.currentTurn.text = detail.text;
      this.currentTurn.bargeInCut = true;
      this.agentTurnDurations.push(this.currentTurn.durationMs);
      this.pushTurn(this.currentTurn);
      this.currentTurn = null;
      this.setFloor('user', atMs);
    }
    if (event === 'duck-hard' && this.currentTurn !== null && this.currentTurn.role === 'agent') {
      // The agent turn is held, not closed: it resumes later.
      this.currentTurn.durationMs = atMs - this.currentTurn.atMs;
      if (detail?.text !== undefined) this.currentTurn.text = detail.text;
      this.agentTurnDurations.push(this.currentTurn.durationMs);
      this.pushTurn({ ...this.currentTurn, bargeInCut: false });
      this.currentTurn = null;
      this.setFloor('user', atMs);
    }
    if (event === 'pause') {
      this.setFloor('none', atMs);
    }
    if (event === 'resume') {
      this.setFloor('user', atMs);
    }
    if (event === 'silence-nudge') {
      this.silenceNudges += 1;
      this.nudgedAtMs = atMs;
    }
    this.state = to;
    this.stateSinceMs = atMs;
    const transition: VoiceV22TurnTransition = { from, to, event, atMs };
    this.transitions.push(transition);
    this.emitTurn(transition);
    return transition;
  }

  private pushTurn(turn: VoiceV22TurnRecord): void {
    this.turns.push(turn);
    while (this.turns.length > this.opts.maxTurns) this.turns.shift();
  }

  private closeOverlap(atMs: number, becameBargeIn: boolean, backchannel: boolean): void {
    if (this.overlapStartMs === null || this.overlapState === null) return;
    const durationMs = Math.max(0, atMs - this.overlapStartMs);
    this.overlaps.push({
      atMs: this.overlapStartMs,
      interruptedState: this.overlapState,
      durationMs,
      becameBargeIn,
      backchannel,
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

  /**
   * Silence handling while listening: nudge once at the nudge
   * window, yield the floor at the yield window. Returns what
   * happened ('none' | 'nudged' | 'yielded').
   */
  checkSilence(atMs: number): 'none' | 'nudged' | 'yielded' {
    if (this.state !== 'listening') return 'none';
    const silentMs = atMs - this.stateSinceMs;
    if (silentMs >= this.opts.silenceYieldMs) {
      this.setFloor('none', atMs);
      return 'yielded';
    }
    if (silentMs >= this.opts.silenceNudgeMs && this.nudgedAtMs === null) {
      this.handle('silence-nudge', atMs);
      return 'nudged';
    }
    return 'none';
  }

  /** The turn currently in progress, if any. */
  currentTurnRecord(): VoiceV22TurnRecord | null {
    return this.currentTurn === null ? null : { ...this.currentTurn };
  }

  /** Restore turn history + counters after a resume (state comes from the resume engine). */
  restoreHistory(turns: VoiceV22TurnRecord[], atMs: number): void {
    this.turns.length = 0;
    for (const t of turns.slice(-this.opts.maxTurns)) this.turns.push({ ...t });
    this.turnCounter = this.turns.length;
    this.stateSinceMs = atMs;
  }

  /**
   * Restore state + floor directly after a resume. Bypasses
   * transition validation on purpose: the rebuilt state comes
   * from a checkpoint, not from a live event, so there may be
   * no legal event that reaches it (e.g. `paused` from `idle`).
   */
  restoreState(state: VoiceV22TurnState, floor: VoiceV22FloorHolder, atMs: number): void {
    const from = this.state;
    this.state = state;
    this.floor = floor;
    this.stateSinceMs = atMs;
    this.currentTurn = null;
    this.transitions.push({ from, to: state, event: 'resume', atMs });
    this.emitTurn({ from, to: state, event: 'resume', atMs });
  }

  stats(): VoiceV22TurnTakingStats {
    const mean = (xs: number[]): number =>
      xs.length === 0 ? 0 : round2V22(xs.reduce((s, x) => s + x, 0) / xs.length);
    const sorted = [...this.responseLatencies].sort((a, b) => a - b);
    return {
      state: this.state,
      floor: this.floor,
      turns: this.turns.length,
      overlaps: this.overlaps.length,
      bargeIns: this.overlaps.filter((o) => o.becameBargeIn).length,
      backchannels: this.overlaps.filter((o) => o.durationMs <= this.opts.backchannelMaxMs).length,
      ducks: this.transitions.filter((t) => t.event === 'duck-hard' || t.event === 'duck-soft').length,
      yields: this.transitions.filter((t) => t.event === 'yield').length,
      pauses: this.transitions.filter((t) => t.event === 'pause').length,
      floorRequests: this.floorRequests.length,
      floorGrants: this.floorRequests.filter((r) => r.outcome === 'granted').length,
      floorRefusals: this.floorRequests.filter((r) => r.outcome === 'refused').length,
      invalidTransitions: this.invalidTransitions,
      silenceNudges: this.silenceNudges,
      meanResponseLatencyMs: mean(this.responseLatencies),
      p95ResponseLatencyMs: round2V22(percentileSortedV22(sorted, 95)),
      meanUserTurnMs: mean(this.userTurnDurations),
      meanAgentTurnMs: mean(this.agentTurnDurations),
    };
  }

  summary(): string {
    const s = this.stats();
    return `turn-taking v22: state=${s.state}, floor=${s.floor}, turns=${s.turns}, overlaps=${s.overlaps} ` +
      `(${s.bargeIns} barge-in, ${s.backchannels} backchannel, ${s.ducks} ducks), floor ${s.floorGrants}/${s.floorRequests} granted, ` +
      `mean response latency ${s.meanResponseLatencyMs} ms (p95 ${s.p95ResponseLatencyMs} ms), invalid=${s.invalidTransitions}`;
  }
}

export function createTurnTakingMachineV22(
  sessionId: string,
  opts: Partial<VoiceV22TurnTakingOptions> = {},
  sink?: VoiceV22EventSink,
): TurnTakingMachineV22 {
  return new TurnTakingMachineV22(sessionId, opts, sink);
}

/** Priority rank for sorting floor requests (higher first). */
export function floorPriorityRankV22(priority: VoiceV22FloorPriority): number {
  return PRIORITY_RANK[priority];
}
