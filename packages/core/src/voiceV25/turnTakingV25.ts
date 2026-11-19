/**
 * Turn-taking for voice v25 (v1.38, Team T5).
 *
 * The floor state machine for a live voice conversation.
 * One turn is one speaker segment — a user turn (listening
 * then silence-wait) followed by an assistant turn (thinking
 * then speaking) — and the machine owns who holds the floor
 * at any moment:
 *
 *   idle ──user starts──> user-speaking ──speech ends──> user-done
 *     ^                      (silence-wait)                  │
 *     │                       │ silence yields              │ silence yields
 *     │                       ▼                             ▼
 *     │                  agent-thinking ──reply starts──> agent-speaking
 *     │                       │                              │
 *     └──── reply done ──────┘                              │ barge-in
 *                                                            ▼
 *                                                       interrupted
 *                                                            │
 *                                              interrupting user starts
 *                                                            ▼
 *                                                      user-speaking ...
 *
 * Rules the machine enforces:
 *   - the floor belongs to the user while they speak and
 *     while the silence-wait runs; it passes to the agent
 *     only when the silence yields (the detector's yield
 *     event, or an explicit `silenceYielded` call) — the
 *     agent never starts thinking mid-utterance;
 *   - a turn that runs past its max duration is marked
 *     `timeout` and the floor is released (a monologue
 *     cannot hold the conversation forever);
 *   - a barge-in moves the machine to `interrupted` and
 *     freezes the cut assistant turn; the next user turn
 *     starts a fresh turn, never resumes the cut one;
 *   - backchannels (short user sounds while the agent
 *     speaks, already classified by v23) are noted on the
 *     current turn and never change the state — the agent
 *     keeps speaking.
 *
 * The machine records every turn with its phase spans
 * (listen / silence-wait / think / speak durations), so the
 * turn timers and the panel can render "turn 3 took 4.2s:
 * 0.8s listen, 1.1s think, 2.3s speak". All clocks virtual.
 */
import {
  clampV25,
  formatDurationV25,
  isValidVoiceV25Id,
  round2V25,
  VOICE_V25_MAX_TURN_DEFAULT_MS,
  VOICE_V25_MAX_USER_TURN_DEFAULT_MS,
  type VoiceV25FloorHolder,
  type VoiceV25PhaseSpan,
  type VoiceV25TurnPhase,
  type VoiceV25TurnRecord,
  type VoiceV25TurnStatus,
  type VoiceV25TurnTakingState,
} from './types';

export interface TurnTakingV25Options {
  /** Max ms for one user turn before it times out (default 60000). */
  maxUserTurnMs: number;
  /** Max ms for one assistant turn before it times out (default 120000). */
  maxAgentTurnMs: number;
  /** Max ms the agent may think before it must start speaking (default 30000). */
  maxThinkingMs: number;
  /** Max turns kept (oldest finished dropped, default 1000). */
  maxTurns: number;
}

export function defaultTurnTakingV25Options(): TurnTakingV25Options {
  return {
    maxUserTurnMs: VOICE_V25_MAX_USER_TURN_DEFAULT_MS,
    maxAgentTurnMs: VOICE_V25_MAX_TURN_DEFAULT_MS,
    maxThinkingMs: 30000,
    maxTurns: 1000,
  };
}

export function validateTurnTakingV25Options(o: Partial<TurnTakingV25Options>): string[] {
  const errors: string[] = [];
  if (o.maxUserTurnMs !== undefined && !(o.maxUserTurnMs >= 1000 && o.maxUserTurnMs <= 600000)) {
    errors.push('maxUserTurnMs must be 1000..600000');
  }
  if (o.maxAgentTurnMs !== undefined && !(o.maxAgentTurnMs >= 1000 && o.maxAgentTurnMs <= 600000)) {
    errors.push('maxAgentTurnMs must be 1000..600000');
  }
  if (o.maxThinkingMs !== undefined && !(o.maxThinkingMs >= 1000 && o.maxThinkingMs <= 120000)) {
    errors.push('maxThinkingMs must be 1000..120000');
  }
  if (o.maxTurns !== undefined && (!Number.isInteger(o.maxTurns) || o.maxTurns < 10 || o.maxTurns > 100000)) {
    errors.push('maxTurns must be an integer 10..100000');
  }
  return errors;
}

/** One backchannel noted on a turn (never changes the state). */
export interface VoiceV25Backchannel {
  turnId: string;
  atMs: number;
  text: string;
}

/** Aggregate turn-taking statistics for a session. */
export interface VoiceV25TurnTakingStats {
  sessionId: string;
  turns: number;
  userTurns: number;
  agentTurns: number;
  completed: number;
  interrupted: number;
  abandoned: number;
  timeouts: number;
  backchannels: number;
  meanUserTurnMs: number;
  meanAgentTurnMs: number;
  meanThinkMs: number;
  meanSilenceWaitMs: number;
  floorHolder: VoiceV25FloorHolder;
  state: VoiceV25TurnTakingState;
}

/** What a transition returns: the turn it opened/closed, if any. */
export interface VoiceV25Transition {
  ok: boolean;
  reason?: string;
  turn: VoiceV25TurnRecord | null;
  state: VoiceV25TurnTakingState;
  floorHolder: VoiceV25FloorHolder;
}

export function createTurnTakingManagerV25(
  sessionId: string,
  opts: Partial<TurnTakingV25Options> = {},
): TurnTakingManagerV25 {
  return new TurnTakingManagerV25(sessionId, opts);
}

export class TurnTakingManagerV25 {
  readonly sessionId: string;
  private readonly opts: TurnTakingV25Options;
  private state: VoiceV25TurnTakingState = 'idle';
  private readonly turns: VoiceV25TurnRecord[] = [];
  private readonly backchannels: VoiceV25Backchannel[] = [];
  private currentTurn: VoiceV25TurnRecord | null = null;
  private turnSeq = 0;
  private thinkingStartedAtMs: number | null = null;

  constructor(sessionId: string, opts: Partial<TurnTakingV25Options> = {}) {
    if (!isValidVoiceV25Id(sessionId)) throw new Error(`Invalid sessionId "${sessionId}"`);
    const errors = validateTurnTakingV25Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid TurnTakingManagerV25 options: ${errors.join('; ')}`);
    }
    this.sessionId = sessionId;
    this.opts = { ...defaultTurnTakingV25Options(), ...opts };
  }

  options(): TurnTakingV25Options {
    return { ...this.opts };
  }

  stateOf(): VoiceV25TurnTakingState {
    return this.state;
  }

  floorHolder(): VoiceV25FloorHolder {
    if (this.state === 'user-speaking' || this.state === 'user-done') return 'user';
    if (this.state === 'agent-thinking' || this.state === 'agent-speaking') return 'agent';
    return 'none';
  }

  currentTurnRecord(): VoiceV25TurnRecord | null {
    return this.currentTurn === null ? null : this.cloneTurn(this.currentTurn);
  }

  /** The user starts speaking (opens a user turn). */
  userStarted(atMs: number, text = ''): VoiceV25Transition {
    this.assertAtMs(atMs);
    if (this.state !== 'idle' && this.state !== 'interrupted') {
      return this.fail(`Cannot start a user turn while ${this.state}`);
    }
    const turn = this.openTurn('user', atMs, text);
    this.enterPhase(turn, 'listening', atMs);
    this.state = 'user-speaking';
    return this.ok(turn);
  }

  /** The user's speech ended (endpoint fired); silence-wait begins. */
  userSpeechEnded(atMs: number): VoiceV25Transition {
    this.assertAtMs(atMs);
    if (this.state !== 'user-speaking' || this.currentTurn === null) {
      return this.fail(`No user turn speaking (state ${this.state})`);
    }
    this.enterPhase(this.currentTurn, 'silence-wait', atMs);
    this.state = 'user-done';
    return this.ok(this.currentTurn);
  }

  /**
   * The silence yielded the floor: the user turn closes and
   * the agent starts thinking. Called by the silence
   * detector's yield event (or the host, explicitly).
   */
  silenceYielded(atMs: number): VoiceV25Transition {
    this.assertAtMs(atMs);
    if (this.state !== 'user-done' || this.currentTurn === null) {
      return this.fail(`No user turn waiting on silence (state ${this.state})`);
    }
    const closed = this.closeTurn(this.currentTurn, atMs, 'completed');
    this.currentTurn = null;
    this.thinkingStartedAtMs = atMs;
    this.state = 'agent-thinking';
    return this.ok(closed);
  }

  /** The agent starts speaking its reply (opens an assistant turn). */
  agentStartedReply(atMs: number, replyText: string, providerId: string | null = null, model: string | null = null): VoiceV25Transition {
    this.assertAtMs(atMs);
    if (this.state !== 'agent-thinking') {
      return this.fail(`Agent cannot start a reply while ${this.state}`);
    }
    if (typeof replyText !== 'string') throw new Error('replyText must be a string');
    const turn = this.openTurn('assistant', atMs, replyText);
    turn.plannedChars = replyText.length;
    turn.providerId = providerId;
    turn.model = model;
    // Thinking ran from the yield to now: close it as a phase
    // on the assistant turn so the think time is visible.
    const thinkSpan: VoiceV25PhaseSpan = {
      phase: 'thinking',
      startedAtMs: this.thinkingStartedAtMs ?? atMs,
      endedAtMs: atMs,
      durationMs: atMs - (this.thinkingStartedAtMs ?? atMs),
    };
    turn.phases.push(thinkSpan);
    this.enterPhase(turn, 'speaking', atMs);
    this.thinkingStartedAtMs = null;
    this.state = 'agent-speaking';
    return this.ok(turn);
  }

  /** The agent finished its reply; the floor is released. */
  agentFinishedReply(atMs: number): VoiceV25Transition {
    this.assertAtMs(atMs);
    if (this.state !== 'agent-speaking' || this.currentTurn === null) {
      return this.fail(`No agent turn speaking (state ${this.state})`);
    }
    const closed = this.closeTurn(this.currentTurn, atMs, 'completed');
    this.currentTurn = null;
    this.state = 'idle';
    return this.ok(closed);
  }

  /**
   * A barge-in cut the agent reply: freeze the assistant
   * turn as `interrupted` (spoken prefix kept in `text`,
   * `spokenChars` / `interruptedAtMs` set by the caller via
   * `recordInterruption`) and release the floor.
   */
  bargeIn(atMs: number, bargeInId: string): VoiceV25Transition {
    this.assertAtMs(atMs);
    if (this.state !== 'agent-speaking' || this.currentTurn === null) {
      return this.fail(`No agent turn to interrupt (state ${this.state})`);
    }
    if (!isValidVoiceV25Id(bargeInId)) throw new Error(`Invalid bargeInId "${bargeInId}"`);
    const turn = this.currentTurn;
    this.enterPhase(turn, 'interrupted', atMs);
    turn.bargeInId = bargeInId;
    turn.interruptedAtMs = atMs;
    const closed = this.closeTurn(turn, atMs, 'interrupted');
    this.currentTurn = null;
    this.state = 'interrupted';
    return this.ok(closed);
  }

  /**
   * Fill in what the barge-in cut: the spoken prefix and how
   * far the TTS engine got. Called with the barge-in
   * manager's stop result.
   */
  recordInterruption(turnId: string, spokenText: string, spokenChars: number, atMs: number): boolean {
    const turn = this.turns.find((t) => t.id === turnId);
    if (turn === undefined) return false;
    if (typeof spokenText !== 'string') throw new Error('spokenText must be a string');
    if (!Number.isInteger(spokenChars) || spokenChars < 0) {
      throw new Error('spokenChars must be an integer >= 0');
    }
    this.assertAtMs(atMs);
    turn.text = spokenText;
    turn.spokenChars = spokenChars;
    return true;
  }

  /** Note a backchannel on the current turn; the state never changes. */
  userBackchannel(atMs: number, text: string): boolean {
    this.assertAtMs(atMs);
    if (this.currentTurn === null) return false;
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('text must be a non-empty string');
    }
    this.backchannels.push({ turnId: this.currentTurn.id, atMs, text });
    return true;
  }

  /** Abandon the current turn (user hung up, session error, ...). */
  abandonTurn(atMs: number): VoiceV25Transition {
    this.assertAtMs(atMs);
    if (this.currentTurn === null) {
      return this.fail(`No current turn to abandon (state ${this.state})`);
    }
    const closed = this.closeTurn(this.currentTurn, atMs, 'abandoned');
    this.currentTurn = null;
    this.thinkingStartedAtMs = null;
    this.state = 'idle';
    return this.ok(closed);
  }

  /**
   * Check the current turn against its max duration at `atMs`.
   * Returns the timed-out turn (closed as `timeout`, floor
   * released) or null when nothing timed out.
   */
  timeoutCheck(atMs: number): VoiceV25TurnRecord | null {
    this.assertAtMs(atMs);
    // Thinking has no current turn (the user turn already
    // closed at the yield), so check it before the null guard.
    if (this.state === 'agent-thinking' && this.thinkingStartedAtMs !== null) {
      if (atMs - this.thinkingStartedAtMs < this.opts.maxThinkingMs) return null;
      // Thinking timed out: no turn to close, just release the floor.
      this.thinkingStartedAtMs = null;
      this.state = 'idle';
      return null;
    }
    if (this.currentTurn === null) return null;
    const elapsed = atMs - this.currentTurn.startedAtMs;
    if (this.currentTurn.role === 'user' && this.state === 'user-speaking') {
      if (elapsed < this.opts.maxUserTurnMs) return null;
    } else if (this.currentTurn.role === 'assistant' && this.state === 'agent-speaking') {
      if (elapsed < this.opts.maxAgentTurnMs) return null;
    } else {
      return null;
    }
    const closed = this.closeTurn(this.currentTurn, atMs, 'timeout');
    this.currentTurn = null;
    this.state = 'idle';
    return closed;
  }

  /** Add measured silence/speech ms to the current turn. */
  addTurnAudio(turnId: string, silenceMs: number, speechMs: number): boolean {
    const turn = this.turns.find((t) => t.id === turnId);
    if (turn === undefined) return false;
    if (silenceMs < 0 || speechMs < 0) throw new Error('silenceMs/speechMs must be >= 0');
    turn.silenceMs += silenceMs;
    turn.speechMs += speechMs;
    return true;
  }

  /** Record the longest single silence gap inside a turn. */
  noteLongestSilence(turnId: string, gapMs: number): boolean {
    const turn = this.turns.find((t) => t.id === turnId);
    if (turn === undefined) return false;
    if (gapMs < 0) throw new Error('gapMs must be >= 0');
    if (gapMs > turn.longestSilenceMs) turn.longestSilenceMs = gapMs;
    return true;
  }

  get(turnId: string): VoiceV25TurnRecord | null {
    const turn = this.turns.find((t) => t.id === turnId);
    return turn === undefined ? null : this.cloneTurn(turn);
  }

  list(filter: { role?: 'user' | 'assistant'; status?: VoiceV25TurnStatus } = {}): VoiceV25TurnRecord[] {
    return this.turns
      .filter((t) => filter.role === undefined || t.role === filter.role)
      .filter((t) => filter.status === undefined || t.status === filter.status)
      .map((t) => this.cloneTurn(t));
  }

  backchannelsList(turnId?: string): VoiceV25Backchannel[] {
    return this.backchannels
      .filter((b) => turnId === undefined || b.turnId === turnId)
      .map((b) => ({ ...b }));
  }

  stats(): VoiceV25TurnTakingStats {
    const userTurns = this.turns.filter((t) => t.role === 'user');
    const agentTurns = this.turns.filter((t) => t.role === 'assistant');
    const thinkMs = agentTurns.map((t) => this.phaseMs(t, 'thinking'));
    const silenceWaitMs = userTurns.map((t) => this.phaseMs(t, 'silence-wait'));
    const userDurations = userTurns.filter((t) => t.durationMs !== null).map((t) => t.durationMs as number);
    const agentDurations = agentTurns.filter((t) => t.durationMs !== null).map((t) => t.durationMs as number);
    return {
      sessionId: this.sessionId,
      turns: this.turns.length,
      userTurns: userTurns.length,
      agentTurns: agentTurns.length,
      completed: this.turns.filter((t) => t.status === 'completed').length,
      interrupted: this.turns.filter((t) => t.status === 'interrupted').length,
      abandoned: this.turns.filter((t) => t.status === 'abandoned').length,
      timeouts: this.turns.filter((t) => t.status === 'timeout').length,
      backchannels: this.backchannels.length,
      meanUserTurnMs: round2V25(this.mean(userDurations)),
      meanAgentTurnMs: round2V25(this.mean(agentDurations)),
      meanThinkMs: round2V25(this.mean(thinkMs)),
      meanSilenceWaitMs: round2V25(this.mean(silenceWaitMs)),
      floorHolder: this.floorHolder(),
      state: this.state,
    };
  }

  count(): number {
    return this.turns.length;
  }

  reset(): void {
    this.state = 'idle';
    this.turns.length = 0;
    this.backchannels.length = 0;
    this.currentTurn = null;
    this.turnSeq = 0;
    this.thinkingStartedAtMs = null;
  }

  private phaseMs(turn: VoiceV25TurnRecord, phase: VoiceV25TurnPhase): number {
    let total = 0;
    for (const span of turn.phases) {
      if (span.phase === phase && span.durationMs !== null) total += span.durationMs;
    }
    return total;
  }

  private mean(values: readonly number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private openTurn(role: 'user' | 'assistant', atMs: number, text: string): VoiceV25TurnRecord {
    this.turnSeq += 1;
    const turn: VoiceV25TurnRecord = {
      id: `turn-${this.turnSeq}`,
      sessionId: this.sessionId,
      index: this.turnSeq - 1,
      role,
      startedAtMs: atMs,
      endedAtMs: null,
      durationMs: null,
      status: 'active',
      phases: [],
      silenceMs: 0,
      speechMs: 0,
      longestSilenceMs: 0,
      text,
      spokenChars: null,
      plannedChars: null,
      bargeInId: null,
      interruptedAtMs: null,
      providerId: null,
      model: null,
    };
    this.turns.push(turn);
    this.currentTurn = turn;
    this.prune();
    return turn;
  }

  private enterPhase(turn: VoiceV25TurnRecord, phase: VoiceV25TurnPhase, atMs: number): void {
    const open = turn.phases[turn.phases.length - 1];
    if (open !== undefined && open.endedAtMs === null) {
      open.endedAtMs = atMs;
      open.durationMs = atMs - open.startedAtMs;
    }
    turn.phases.push({ phase, startedAtMs: atMs, endedAtMs: null, durationMs: null });
  }

  private closeTurn(turn: VoiceV25TurnRecord, atMs: number, status: VoiceV25TurnStatus): VoiceV25TurnRecord {
    const open = turn.phases[turn.phases.length - 1];
    if (open !== undefined && open.endedAtMs === null) {
      open.endedAtMs = atMs;
      open.durationMs = atMs - open.startedAtMs;
    }
    turn.endedAtMs = atMs;
    turn.durationMs = atMs - turn.startedAtMs;
    turn.status = status;
    return this.cloneTurn(turn);
  }

  private cloneTurn(turn: VoiceV25TurnRecord): VoiceV25TurnRecord {
    return { ...turn, phases: turn.phases.map((p) => ({ ...p })) };
  }

  private ok(turn: VoiceV25TurnRecord | null): VoiceV25Transition {
    return { ok: true, turn, state: this.state, floorHolder: this.floorHolder() };
  }

  private fail(reason: string): VoiceV25Transition {
    return { ok: false, reason, turn: null, state: this.state, floorHolder: this.floorHolder() };
  }

  private assertAtMs(atMs: number): void {
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
  }

  private prune(): void {
    while (this.turns.length > this.opts.maxTurns) {
      const idx = this.turns.findIndex((t) => t.status !== 'active');
      if (idx === -1) return;
      this.turns.splice(idx, 1);
    }
  }

  summary(): string {
    const s = this.stats();
    return (
      `Session ${this.sessionId}: ${s.turns} turns (${s.userTurns} user, ${s.agentTurns} agent), ` +
      `${s.completed} completed, ${s.interrupted} interrupted, ${s.timeouts} timeouts, ` +
      `${s.backchannels} backchannels; mean user turn ${formatDurationV25(s.meanUserTurnMs)}, ` +
      `mean agent turn ${formatDurationV25(s.meanAgentTurnMs)}, mean think ${formatDurationV25(s.meanThinkMs)}, ` +
      `mean silence-wait ${formatDurationV25(s.meanSilenceWaitMs)}; floor: ${s.floorHolder}, state: ${s.state}.`
    );
  }

  markdown(): string {
    const lines: string[] = [`# Voice v25 turn-taking — session ${this.sessionId}`, ''];
    lines.push(this.summary());
    if (this.turns.length > 0) {
      lines.push('', '| Turn | Role | Status | Duration | Think | Silence-wait | Text |');
      lines.push('| ---: | --- | --- | ---: | ---: | ---: | --- |');
      for (const t of this.turns) {
        lines.push(
          `| ${t.index} | ${t.role} | ${t.status} | ${t.durationMs === null ? 'active' : formatDurationV25(t.durationMs)} | ` +
          `${formatDurationV25(this.phaseMs(t, 'thinking'))} | ${formatDurationV25(this.phaseMs(t, 'silence-wait'))} | ` +
          `${t.text.slice(0, 40)}${t.text.length > 40 ? '…' : ''} |`,
        );
      }
    }
    return lines.join('\n');
  }
}

/** Clamp helper re-exported for callers that only import this module. */
export { clampV25 };
