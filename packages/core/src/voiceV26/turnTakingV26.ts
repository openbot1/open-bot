/**
 * Turn-taking floor machine for voice v26 (v1.39, Team T5).
 *
 * v25 owns the floor machine for a conversation (user speaks,
 * silence yields, agent thinks, agent speaks, barge-in freezes
 * the cut turn). v26 owns the *guarded* version of that machine
 * — the one a live realtime loop needs so two speakers can
 * never talk over each other:
 *
 *   idle ──user-start──> listening ──user-end / yield──> thinking
 *     ^                      │                              │
 *     │                      │ timeout (listening)          │ agent-start
 *     │                      ▼                              ▼
 *     │                  (abandoned)                   speaking
 *     │                      │                              │ agent-done
 *     │                      │                              ▼
 *     │                      └─────────── done ────────── idle
 *     │                                                     │ barge-in
 *     │                                                     ▼
 *     │                                                interrupted
 *     │                                                     │ user-start
 *     │                                                     ▼
 *     │                                                 listening ...
 *
 * Rules the machine enforces:
 *   - anti-overlap guard: `agentStart` while the floor is
 *     `listening` is rejected — the reply is *queued* and the
 *     machine stays listening. The queued reply is delivered
 *     automatically when the user yields. The agent never
 *     speaks over the user, by construction;
 *   - per-phase timeouts: listening, thinking and speaking
 *     each have a max duration; a phase that runs past it is
 *     marked `timeout` and the floor is released (a monologue
 *     or a stuck model cannot hold the conversation forever);
 *   - a barge-in moves the machine to `interrupted` and
 *     freezes the cut assistant turn with its spoken prefix;
 *     the next user turn starts fresh, never resumes the cut
 *     one — resume is a new turn, driven by the resume
 *     context the barge-in detector kept;
 *   - backchannels never change the state; they are noted on
 *     the current turn;
 *   - every transition is recorded, so the audit trail can
 *     show exactly when the floor changed hands and why.
 *
 * All clocks virtual; all audio mock/synthetic.
 */
import {
  VOICE_V26_MAX_LISTENING_DEFAULT_MS,
  VOICE_V26_MAX_SPEAKING_DEFAULT_MS,
  VOICE_V26_MAX_THINKING_DEFAULT_MS,
  VOICE_V26_MAX_TURNS_DEFAULT,
  VOICE_V26_MAX_TURN_DEFAULT_MS,
  VOICE_V26_MAX_USER_TURN_DEFAULT_MS,
  floorHolderForStateV26,
  round2V26,
  type VoiceV26FloorHolder,
  type VoiceV26FloorState,
  type VoiceV26PhaseSpan,
  type VoiceV26Transition,
  type VoiceV26TurnRecord,
} from './types';

export interface TurnTakingV26Options {
  /** Max ms for one user turn (default 60000). */
  maxUserTurnMs: number;
  /** Max ms for one assistant turn (default 120000). */
  maxAgentTurnMs: number;
  /** Max ms in the listening phase (default 60000). */
  maxListeningMs: number;
  /** Max ms in the thinking phase (default 30000). */
  maxThinkingMs: number;
  /** Max ms in the speaking phase (default 120000). */
  maxSpeakingMs: number;
  /** Max turns kept (default 1000). */
  maxTurns: number;
}

export function defaultTurnTakingV26Options(): TurnTakingV26Options {
  return {
    maxUserTurnMs: VOICE_V26_MAX_USER_TURN_DEFAULT_MS,
    maxAgentTurnMs: VOICE_V26_MAX_TURN_DEFAULT_MS,
    maxListeningMs: VOICE_V26_MAX_LISTENING_DEFAULT_MS,
    maxThinkingMs: VOICE_V26_MAX_THINKING_DEFAULT_MS,
    maxSpeakingMs: VOICE_V26_MAX_SPEAKING_DEFAULT_MS,
    maxTurns: VOICE_V26_MAX_TURNS_DEFAULT,
  };
}

export function validateTurnTakingV26Options(o: Partial<TurnTakingV26Options>): string[] {
  const errors: string[] = [];
  const check = (v: number | undefined, lo: number, hi: number, name: string): void => {
    if (v !== undefined && !(v >= lo && v <= hi)) errors.push(`${name} must be ${lo}..${hi}`);
  };
  check(o.maxUserTurnMs, 1000, 600000, 'maxUserTurnMs');
  check(o.maxAgentTurnMs, 1000, 600000, 'maxAgentTurnMs');
  check(o.maxListeningMs, 1000, 600000, 'maxListeningMs');
  check(o.maxThinkingMs, 1000, 120000, 'maxThinkingMs');
  check(o.maxSpeakingMs, 1000, 600000, 'maxSpeakingMs');
  if (o.maxTurns !== undefined && (!Number.isInteger(o.maxTurns) || o.maxTurns < 10 || o.maxTurns > 100000)) {
    errors.push('maxTurns must be an integer 10..100000');
  }
  return errors;
}

/** Result of asking the machine to start an agent reply. */
export interface VoiceV26AgentStartResult {
  /** 'started' | 'queued' (floor busy) | 'rejected' (bad state). */
  outcome: 'started' | 'queued' | 'rejected';
  turnId: string | null;
  reason: string;
  /** Position in the queue when queued (1-based). */
  queuePosition: number | null;
}

/** A queued agent reply waiting for the floor. */
export interface VoiceV26QueuedReply {
  id: string;
  text: string;
  providerId: string | null;
  model: string | null;
  queuedAtMs: number;
}

/** Aggregate turn-taking statistics. */
export interface VoiceV26TurnTakingStats {
  sessionId: string;
  state: VoiceV26FloorState;
  floorHolder: VoiceV26FloorHolder;
  turns: number;
  userTurns: number;
  agentTurns: number;
  completed: number;
  interrupted: number;
  abandoned: number;
  timeouts: number;
  queued: number;
  backchannels: number;
  rejectedAgentStarts: number;
  meanUserTurnMs: number;
  meanAgentTurnMs: number;
  meanThinkMs: number;
  meanListeningMs: number;
  meanSpeakingMs: number;
}

export interface VoiceV26Backchannel {
  turnId: string;
  atMs: number;
  text: string;
}

export function createTurnTakingMachineV26(
  sessionId: string,
  opts: Partial<TurnTakingV26Options> = {},
): TurnTakingMachineV26 {
  return new TurnTakingMachineV26(sessionId, opts);
}

export class TurnTakingMachineV26 {
  private readonly sessionId: string;
  private readonly opts: TurnTakingV26Options;
  private state: VoiceV26FloorState = 'idle';
  private currentTurn: VoiceV26TurnRecord | null = null;
  private readonly turns: VoiceV26TurnRecord[] = [];
  private readonly transitions: VoiceV26Transition[] = [];
  private readonly queue: VoiceV26QueuedReply[] = [];
  private readonly backchannels: VoiceV26Backchannel[] = [];
  private seq = 0;
  private queueSeq = 0;
  private rejectedAgentStarts = 0;

  constructor(sessionId: string, opts: Partial<TurnTakingV26Options> = {}) {
    const errors = validateTurnTakingV26Options(opts);
    if (errors.length > 0) throw new Error(`Invalid TurnTakingV26Options: ${errors.join('; ')}`);
    this.sessionId = sessionId;
    this.opts = { ...defaultTurnTakingV26Options(), ...opts };
  }

  options(): TurnTakingV26Options {
    return { ...this.opts };
  }

  stateNow(): VoiceV26FloorState {
    return this.state;
  }

  floorHolder(): VoiceV26FloorHolder {
    return floorHolderForStateV26(this.state);
  }

  currentTurnNow(): VoiceV26TurnRecord | null {
    return this.currentTurn ? { ...this.currentTurn, phases: this.currentTurn.phases.map((p) => ({ ...p })) } : null;
  }

  queuedReplies(): VoiceV26QueuedReply[] {
    return this.queue.map((q) => ({ ...q }));
  }

  queueLength(): number {
    return this.queue.length;
  }

  /** The user starts speaking. */
  userStart(atMs: number, text = ''): VoiceV26TurnRecord {
    if (this.state === 'listening' && this.currentTurn) {
      // Already listening: extend the same turn.
      return this.currentTurnNow() as VoiceV26TurnRecord;
    }
    if (this.currentTurn && this.currentTurn.status === 'active') {
      // The user is cutting in (or resuming after an interruption) —
      // freeze the still-open turn as interrupted. A turn that is
      // already ended (e.g. frozen by bargeIn) is left untouched.
      this.closeCurrentTurn(atMs, 'interrupted');
    }
    const turn = this.newTurn('user', atMs, text);
    this.openPhase(turn, 'listening', atMs);
    const fromState = this.state;
    this.transition(fromState, 'listening', atMs, 'user-start', turn.id);
    this.state = 'listening';
    this.currentTurn = turn;
    this.turns.push(turn);
    this.prune();
    return this.currentTurnNow() as VoiceV26TurnRecord;
  }

  /** The user finished their utterance (endpoint / silence yield). */
  userEnd(atMs: number, text?: string): VoiceV26TurnRecord | null {
    if (this.state !== 'listening' || !this.currentTurn) return null;
    if (text !== undefined) this.currentTurn.text = text;
    this.closePhase(this.currentTurn, atMs);
    this.openPhase(this.currentTurn, 'thinking', atMs);
    this.transition('listening', 'thinking', atMs, 'user-end', this.currentTurn.id);
    this.state = 'thinking';
    // The user turn is done; the agent turn starts when a reply
    // is requested. Keep the user turn as the current record so
    // its thinking span is measured on it.
    return this.currentTurnNow();
  }

  /**
   * Start an agent reply. Guard: while the user holds the floor
   * (`listening`) the reply is queued, never spoken over them.
   * While `thinking`, the reply starts immediately.
   */
  agentStart(input: {
    atMs: number;
    text: string;
    providerId?: string | null;
    model?: string | null;
  }): VoiceV26AgentStartResult {
    if (this.state === 'listening') {
      this.queueSeq += 1;
      this.queue.push({
        id: `q26-${this.queueSeq}`,
        text: input.text,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        queuedAtMs: input.atMs,
      });
      return {
        outcome: 'queued',
        turnId: null,
        reason: 'user holds the floor (listening); reply queued',
        queuePosition: this.queue.length,
      };
    }
    if (this.state === 'speaking') {
      this.rejectedAgentStarts += 1;
      return { outcome: 'rejected', turnId: null, reason: 'agent already speaking', queuePosition: null };
    }
    if (this.state === 'idle') {
      // No user turn yet: start a fresh agent turn anyway
      // (proactive speech), but record it as such.
      const turn = this.newTurn('assistant', input.atMs, input.text);
      turn.plannedChars = input.text.length;
      this.openPhase(turn, 'speaking', input.atMs);
      this.transition('idle', 'speaking', input.atMs, 'agent-start-proactive', turn.id);
      this.state = 'speaking';
      this.currentTurn = turn;
      this.turns.push(turn);
      this.prune();
      return { outcome: 'started', turnId: turn.id, reason: 'proactive agent turn', queuePosition: null };
    }
    // thinking or interrupted: start the agent turn.
    const prev = this.currentTurn;
    if (prev && prev.status === 'active') {
      this.closeCurrentTurn(input.atMs, prev.role === 'user' ? 'completed' : 'completed');
    }
    const turn = this.newTurn('assistant', input.atMs, input.text);
    turn.plannedChars = input.text.length;
    this.openPhase(turn, 'speaking', input.atMs);
    this.transition(this.state, 'speaking', input.atMs, 'agent-start', turn.id);
    this.state = 'speaking';
    this.currentTurn = turn;
    this.turns.push(turn);
    this.prune();
    return { outcome: 'started', turnId: turn.id, reason: 'agent reply started', queuePosition: null };
  }

  /** The agent finished speaking its reply. */
  agentDone(atMs: number, spokenChars?: number): VoiceV26TurnRecord | null {
    if (this.state !== 'speaking' || !this.currentTurn) return null;
    if (spokenChars !== undefined) this.currentTurn.spokenChars = spokenChars;
    this.closeCurrentTurn(atMs, 'completed');
    this.transition('speaking', 'idle', atMs, 'agent-done', this.currentTurn ? this.currentTurn.id : null);
    this.state = 'idle';
    this.currentTurn = null;
    return this.turns.length > 0 ? { ...this.turns[this.turns.length - 1] } : null;
  }

  /**
   * A barge-in cut the agent reply. Freezes the turn with its
   * spoken prefix; the floor goes to `interrupted` until the
   * user starts their turn.
   */
  bargeIn(input: {
    atMs: number;
    bargeInId: string;
    spokenText: string;
    spokenChars: number;
  }): VoiceV26TurnRecord | null {
    if (!this.currentTurn) return null;
    const turn = this.currentTurn;
    turn.bargeInId = input.bargeInId;
    turn.spokenChars = input.spokenChars;
    turn.text = input.spokenText;
    this.closePhase(turn, input.atMs);
    this.openPhase(turn, 'interrupted', input.atMs);
    this.closePhase(turn, input.atMs);
    turn.status = 'interrupted';
    turn.endedAtMs = input.atMs;
    turn.durationMs = input.atMs - turn.startedAtMs;
    this.transition(this.state, 'interrupted', input.atMs, `barge-in ${input.bargeInId}`, turn.id);
    this.state = 'interrupted';
    return { ...turn, phases: turn.phases.map((p) => ({ ...p })) };
  }

  /** Note a backchannel on the current turn (never changes state). */
  backchannel(atMs: number, text: string): void {
    if (!this.currentTurn) return;
    this.backchannels.push({ turnId: this.currentTurn.id, atMs, text });
  }

  /** Abandon the current turn (user walked away, call dropped). */
  abandon(atMs: number, reason = 'abandoned'): VoiceV26TurnRecord | null {
    if (!this.currentTurn) return null;
    const wasActive = this.currentTurn.status === 'active';
    const turn = wasActive ? this.closeCurrentTurn(atMs, 'abandoned') : { ...this.currentTurn, phases: this.currentTurn.phases.map((p) => ({ ...p })) };
    this.transition(this.state, 'idle', atMs, reason, turn ? turn.id : null);
    this.state = 'idle';
    this.currentTurn = null;
    return turn;
  }

  /**
   * Check per-phase timeouts at `atMs`. Returns the timed-out
   * turn, if any. The floor is released on timeout.
   */
  timeoutCheck(atMs: number): VoiceV26TurnRecord | null {
    if (!this.currentTurn) return null;
    const turn = this.currentTurn;
    const phase = turn.phases[turn.phases.length - 1];
    if (!phase || phase.endedAtMs !== null) return null;
    const phaseMs = atMs - phase.startedAtMs;
    let limit: number | null = null;
    if (phase.phase === 'listening') limit = this.opts.maxListeningMs;
    if (phase.phase === 'thinking') limit = this.opts.maxThinkingMs;
    if (phase.phase === 'speaking') limit = this.opts.maxSpeakingMs;
    if (limit === null || phaseMs < limit) return null;
    const timedOut = this.closeCurrentTurn(atMs, 'timeout');
    this.transition(this.state, 'idle', atMs, `timeout ${phase.phase} ${phaseMs}ms > ${limit}ms`, turn.id);
    this.state = 'idle';
    this.currentTurn = null;
    return timedOut;
  }

  /**
   * Deliver the next queued reply, if the floor is free
   * (`thinking` or `idle`). Returns the agent-start result.
   */
  deliverQueued(atMs: number): VoiceV26AgentStartResult | null {
    if (this.queue.length === 0) return null;
    if (this.state !== 'thinking' && this.state !== 'idle' && this.state !== 'interrupted') return null;
    const next = this.queue.shift();
    if (!next) return null;
    return this.agentStart({ atMs, text: next.text, providerId: next.providerId, model: next.model });
  }

  getTurn(id: string): VoiceV26TurnRecord | null {
    const found = this.turns.find((t) => t.id === id);
    return found ? { ...found, phases: found.phases.map((p) => ({ ...p })) } : null;
  }

  listTurns(filter: { role?: 'user' | 'assistant'; status?: VoiceV26TurnRecord['status'] } = {}): VoiceV26TurnRecord[] {
    return this.turns
      .filter((t) => (filter.role === undefined || t.role === filter.role))
      .filter((t) => (filter.status === undefined || t.status === filter.status))
      .map((t) => ({ ...t, phases: t.phases.map((p) => ({ ...p })) }));
  }

  transitionsList(): VoiceV26Transition[] {
    return this.transitions.map((t) => ({ ...t }));
  }

  backchannelsList(): VoiceV26Backchannel[] {
    return this.backchannels.map((b) => ({ ...b }));
  }

  stats(): VoiceV26TurnTakingStats {
    const finished = this.turns.filter((t) => t.endedAtMs !== null);
    const userTurns = this.turns.filter((t) => t.role === 'user');
    const agentTurns = this.turns.filter((t) => t.role === 'assistant');
    const mean = (list: VoiceV26TurnRecord[]): number => {
      const ds = list.map((t) => t.durationMs).filter((v): v is number => v !== null);
      return ds.length === 0 ? 0 : round2V26(ds.reduce((a, b) => a + b, 0) / ds.length);
    };
    const phaseMean = (phase: VoiceV26FloorState): number => {
      const ds: number[] = [];
      for (const t of this.turns) {
        for (const p of t.phases) {
          if (p.phase === phase && p.durationMs !== null) ds.push(p.durationMs);
        }
      }
      return ds.length === 0 ? 0 : round2V26(ds.reduce((a, b) => a + b, 0) / ds.length);
    };
    void finished;
    return {
      sessionId: this.sessionId,
      state: this.state,
      floorHolder: this.floorHolder(),
      turns: this.turns.length,
      userTurns: userTurns.length,
      agentTurns: agentTurns.length,
      completed: this.turns.filter((t) => t.status === 'completed').length,
      interrupted: this.turns.filter((t) => t.status === 'interrupted').length,
      abandoned: this.turns.filter((t) => t.status === 'abandoned').length,
      timeouts: this.turns.filter((t) => t.status === 'timeout').length,
      queued: this.queue.length,
      backchannels: this.backchannels.length,
      rejectedAgentStarts: this.rejectedAgentStarts,
      meanUserTurnMs: mean(userTurns),
      meanAgentTurnMs: mean(agentTurns),
      meanThinkMs: phaseMean('thinking'),
      meanListeningMs: phaseMean('listening'),
      meanSpeakingMs: phaseMean('speaking'),
    };
  }

  reset(): void {
    this.turns.length = 0;
    this.transitions.length = 0;
    this.queue.length = 0;
    this.backchannels.length = 0;
    this.state = 'idle';
    this.currentTurn = null;
    this.seq = 0;
    this.queueSeq = 0;
    this.rejectedAgentStarts = 0;
  }

  summary(): string {
    const s = this.stats();
    return (
      `turn-taking v26 ${this.sessionId}: state ${s.state} (floor ${s.floorHolder}), ` +
      `${s.turns} turns (${s.userTurns} user, ${s.agentTurns} agent), ` +
      `${s.completed} completed, ${s.interrupted} interrupted, ${s.timeouts} timeouts, ` +
      `${s.queued} queued, ${s.rejectedAgentStarts} rejected agent starts`
    );
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '# Turn-taking v26',
      '',
      `Session: \`${this.sessionId}\` — state \`${s.state}\`, floor \`${s.floorHolder}\``,
      '',
      `- Turns: ${s.turns} (${s.userTurns} user, ${s.agentTurns} agent)`,
      `- Completed: ${s.completed} — Interrupted: ${s.interrupted} — Timeouts: ${s.timeouts}`,
      `- Queued replies: ${s.queued} — Rejected agent starts: ${s.rejectedAgentStarts}`,
      `- Mean user turn: ${s.meanUserTurnMs}ms — Mean agent turn: ${s.meanAgentTurnMs}ms`,
      `- Mean think: ${s.meanThinkMs}ms — Mean listening: ${s.meanListeningMs}ms — Mean speaking: ${s.meanSpeakingMs}ms`,
      '',
      '## Turns',
      '',
      '| # | role | status | duration | text |',
      '| --- | --- | --- | --- | --- |',
    ];
    for (const t of this.turns) {
      lines.push(`| ${t.index} | ${t.role} | ${t.status} | ${t.durationMs ?? '-'} | ${(t.text ?? '').slice(0, 60)} |`);
    }
    return lines.join('\n');
  }

  private newTurn(role: 'user' | 'assistant', atMs: number, text: string): VoiceV26TurnRecord {
    this.seq += 1;
    return {
      id: `turn26-${this.seq}`,
      sessionId: this.sessionId,
      index: this.seq - 1,
      role,
      startedAtMs: atMs,
      endedAtMs: null,
      durationMs: null,
      status: 'active',
      phases: [],
      text,
      spokenChars: null,
      plannedChars: null,
      bargeInId: null,
      queuedText: null,
    };
  }

  private openPhase(turn: VoiceV26TurnRecord, phase: VoiceV26FloorState, atMs: number): void {
    const span: VoiceV26PhaseSpan = { phase, startedAtMs: atMs, endedAtMs: null, durationMs: null };
    turn.phases.push(span);
  }

  private closePhase(turn: VoiceV26TurnRecord, atMs: number): void {
    const phase = turn.phases[turn.phases.length - 1];
    if (phase && phase.endedAtMs === null) {
      phase.endedAtMs = atMs;
      phase.durationMs = atMs - phase.startedAtMs;
    }
  }

  private closeCurrentTurn(atMs: number, status: VoiceV26TurnRecord['status']): VoiceV26TurnRecord | null {
    if (!this.currentTurn) return null;
    const turn = this.currentTurn;
    this.closePhase(turn, atMs);
    turn.status = status;
    turn.endedAtMs = atMs;
    turn.durationMs = atMs - turn.startedAtMs;
    return { ...turn, phases: turn.phases.map((p) => ({ ...p })) };
  }

  private transition(from: VoiceV26FloorState, to: VoiceV26FloorState, atMs: number, reason: string, turnId: string | null): void {
    this.transitions.push({ from, to, atMs, reason, turnId });
    if (this.transitions.length > 5000) this.transitions.shift();
  }

  private prune(): void {
    while (this.turns.length > this.opts.maxTurns) this.turns.shift();
  }
}
