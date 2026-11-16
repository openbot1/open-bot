/**
 * Turn-taking v12 (v1.13, Đội T5 — voice realtime v12).
 *
 * v11 owns the *floor* (who holds it, overlaps, nudges) but the
 * call's *phase* still lives in two places: the barge-in
 * controller's machine (idle/listening/thinking/speaking/ducked/
 * interrupted/cooldown) and the turn manager's floor. v12 unifies
 * them into one explicit turn machine, so the panel, the tools
 * and the session all read the same state:
 *
 *   idle ──▶ listening ──▶ thinking ──▶ speaking ──▶ listening
 *              │  ▲           │  ▲          │  ▲
 *              │  │           │  │          │  │
 *              └──┴─ interrupted ─┴─ cooldown ─┘
 *                     (user cut in)   (settle, then listen)
 *
 * Every transition goes through one guarded table
 * (`TURN_V12_TRANSITIONS`): an illegal move returns
 * `{ ok: false }` and is counted, never silently applied. The
 * log keeps the last 200 transitions with `from → to`, the
 * trigger and the virtual time.
 *
 * Silence timeouts are per-state, not global:
 * - `listening`: nobody has spoken for `listeningSilenceMs`
 *   (default 8 s) → `silence-timeout` + a nudge (up to
 *   `maxNudges`, then `call-idle` — the call stays open, it is
 *   never auto-ended).
 * - `thinking`: the model has not produced a reply for
 *   `thinkingTimeoutMs` (default 30 s) → `thinking-timeout`,
 *   back to `listening` (the user can rephrase instead of
 *   staring at a stuck spinner).
 * - `speaking`: no timeout — the agent finishes or is cut.
 * - `interrupted` / `cooldown`: the cooldown clock runs
 *   (`cooldownMs`, default 1.5 s) and then the machine returns
 *   to `listening` on its own.
 *
 * End-of-turn detection (`EndOfTurnDetectorV12`) decides *when*
 * a user turn is over from VAD events, on the same virtual
 * clock: a turn ends when trailing silence lasts
 * `trailingSilenceMs` (default 700 ms) after at least
 * `minSpeechMs` (default 300 ms) of speech. Shorter bursts are
 * classified, not mistaken for turns: under `minSpeechMs` is a
 * `backchannel` ("ừ", "vâng") when it is very short, a
 * `false-start` when it stops mid-word, and a `turn-merged`
 * when a short pause (under `mergePauseMs`, default 500 ms)
 * joins two bursts into one turn. A turn longer than
 * `maxTurnMs` (default 30 s) is force-ended with `turn-timeout`.
 *
 * No audio device, no network, no model: the machine only tracks
 * states, timers and decisions on the caller-owned virtual clock.
 */

/** Turn machine v12 states (the unified call phase). */
export type TurnV12State =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'cooldown';

/** Options for `TurnMachineV12`. */
export interface TurnMachineV12Options {
  /** Silence (ms) in `listening` before a timeout fires. */
  listeningSilenceMs?: number;
  /** Fire a nudge event on a listening silence timeout (default true). */
  nudgeOnSilence?: boolean;
  /** Max nudges per idle stretch before `call-idle` (default 2). */
  maxNudges?: number;
  /** Time (ms) in `thinking` before a thinking timeout fires. */
  thinkingTimeoutMs?: number;
  /** Cooldown (ms) after an interrupt before returning to `listening`. */
  cooldownMs?: number;
  /** Max transitions kept in the log (default 200). */
  maxTransitions?: number;
}

/** One logged state transition. */
export interface TurnV12Transition {
  from: TurnV12State;
  to: TurnV12State;
  trigger: string;
  atMs: number;
  ok: boolean;
  reason?: string;
}

/** Counters for one turn machine. */
export interface TurnMachineV12Stats {
  state: TurnV12State;
  turns: number;
  userTurns: number;
  agentTurns: number;
  interrupts: number;
  silenceTimeouts: number;
  nudges: number;
  thinkingTimeouts: number;
  illegalTransitions: number;
  /** Current state duration (ms, caller passes nowMs). */
  stateMs: number;
  /** Current idle stretch while listening (ms, 0 otherwise). */
  listeningIdleMs: number;
}

/** Events emitted by the turn machine. */
export type TurnMachineV12Event =
  | { kind: 'transition'; transition: TurnV12Transition }
  | { kind: 'turn-started'; turn: TurnV12Turn }
  | { kind: 'turn-ended'; turn: TurnV12Turn }
  | { kind: 'silence-timeout'; atMs: number; idleMs: number; nudge: number }
  | { kind: 'nudge'; atMs: number; nudge: number }
  | { kind: 'call-idle'; atMs: number; idleMs: number }
  | { kind: 'thinking-timeout'; atMs: number; thinkingMs: number };

export type TurnMachineV12EventSink = (event: TurnMachineV12Event) => void;

/** One completed turn. */
export interface TurnV12Turn {
  id: number;
  speaker: 'user' | 'agent';
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  /** How the turn ended. */
  endedBy: 'speech-end' | 'barge-in' | 'timeout' | 'drained' | 'manual' | 'thinking-timeout';
}

/**
 * Guarded transition table. `interrupted` is transient —
 * `tick()` moves it to `cooldown`, and `tick()` moves
 * `cooldown` back to `listening` when the cooldown expires.
 */
export const TURN_V12_TRANSITIONS: Record<TurnV12State, TurnV12State[]> = {
  idle: ['listening'],
  listening: ['thinking', 'speaking', 'interrupted', 'idle'],
  thinking: ['speaking', 'interrupted', 'listening', 'idle'],
  speaking: ['interrupted', 'listening', 'idle'],
  interrupted: ['cooldown', 'listening', 'idle'],
  cooldown: ['listening', 'idle'],
};

export const TURN_V12_STATES = [
  'idle', 'listening', 'thinking', 'speaking', 'interrupted', 'cooldown',
] as const;

export function isTurnV12State(value: unknown): value is TurnV12State {
  return typeof value === 'string' && (TURN_V12_STATES as readonly string[]).includes(value);
}

export function defaultTurnMachineV12Options(): Required<TurnMachineV12Options> {
  return {
    listeningSilenceMs: 8000,
    nudgeOnSilence: true,
    maxNudges: 2,
    thinkingTimeoutMs: 30000,
    cooldownMs: 1500,
    maxTransitions: 200,
  };
}

export function validateTurnMachineV12Options(options: TurnMachineV12Options): Required<TurnMachineV12Options> {
  const base = defaultTurnMachineV12Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Turn machine v12 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    listeningSilenceMs: num(options.listeningSilenceMs, base.listeningSilenceMs, 'listeningSilenceMs', 1000, 600000),
    nudgeOnSilence: options.nudgeOnSilence ?? base.nudgeOnSilence,
    maxNudges: Math.floor(num(options.maxNudges, base.maxNudges, 'maxNudges', 0, 20)),
    thinkingTimeoutMs: num(options.thinkingTimeoutMs, base.thinkingTimeoutMs, 'thinkingTimeoutMs', 1000, 600000),
    cooldownMs: num(options.cooldownMs, base.cooldownMs, 'cooldownMs', 0, 60000),
    maxTransitions: Math.floor(num(options.maxTransitions, base.maxTransitions, 'maxTransitions', 10, 10000)),
  };
}

/**
 * Unified turn machine: one guarded state machine for the whole
 * call phase, with per-state silence / thinking / cooldown
 * timeouts on the caller-owned virtual clock.
 */
export class TurnMachineV12 {
  private readonly options: Required<TurnMachineV12Options>;
  private readonly sink: TurnMachineV12EventSink | null;
  private state: TurnV12State = 'idle';
  private transitions: TurnV12Transition[] = [];
  private currentTurn: TurnV12Turn | null = null;
  private history: TurnV12Turn[] = [];
  private nextTurnId = 1;
  private stateEnteredAtMs = 0;
  private lastActivityAtMs = 0;
  private started = false;
  private nudgesThisStretch = 0;
  private callIdleFired = false;
  private silenceTimeouts = 0;
  private nudges = 0;
  private thinkingTimeouts = 0;
  private interrupts = 0;
  private illegalTransitions = 0;
  private cooldownUntilMs: number | null = null;
  private lastInterruptAtMs: number | null = null;

  constructor(options: TurnMachineV12Options = {}, sink: TurnMachineV12EventSink | null = null) {
    this.options = validateTurnMachineV12Options(options);
    this.sink = sink;
  }

  getOptions(): Required<TurnMachineV12Options> {
    return { ...this.options };
  }

  getState(): TurnV12State {
    return this.state;
  }

  getCurrentTurn(): TurnV12Turn | null {
    return this.currentTurn ? { ...this.currentTurn } : null;
  }

  getHistory(): TurnV12Turn[] {
    return this.history.map((t) => ({ ...t }));
  }

  getTransitions(): TurnV12Transition[] {
    return this.transitions.map((t) => ({ ...t }));
  }

  getStats(nowMs: number): TurnMachineV12Stats {
    return {
      state: this.state,
      turns: this.history.length,
      userTurns: this.history.filter((t) => t.speaker === 'user').length,
      agentTurns: this.history.filter((t) => t.speaker === 'agent').length,
      interrupts: this.interrupts,
      silenceTimeouts: this.silenceTimeouts,
      nudges: this.nudges,
      thinkingTimeouts: this.thinkingTimeouts,
      illegalTransitions: this.illegalTransitions,
      stateMs: Math.max(0, nowMs - this.stateEnteredAtMs),
      listeningIdleMs: this.state === 'listening' && this.started ? Math.max(0, nowMs - this.lastActivityAtMs) : 0,
    };
  }

  /**
   * Attempt a state move through the guarded table. Returns false
   * (and counts + logs it) when the move is illegal. A move to
   * the current state is a no-op that returns true.
   */
  transitionTo(to: TurnV12State, trigger: string, atMs: number): boolean {
    if (to === this.state) return true;
    const allowed = TURN_V12_TRANSITIONS[this.state] ?? [];
    if (!allowed.includes(to)) {
      this.illegalTransitions += 1;
      this.logTransition(this.state, to, trigger, atMs, false, `illegal: ${this.state} -> ${to}`);
      return false;
    }
    this.logTransition(this.state, to, trigger, atMs, true);
    this.state = to;
    this.stateEnteredAtMs = atMs;
    return true;
  }

  private logTransition(from: TurnV12State, to: TurnV12State, trigger: string, atMs: number, ok: boolean, reason?: string): void {
    const t: TurnV12Transition = { from, to, trigger, atMs, ok, ...(reason ? { reason } : {}) };
    this.transitions.push(t);
    if (this.transitions.length > this.options.maxTransitions) {
      this.transitions.splice(0, this.transitions.length - this.options.maxTransitions);
    }
    this.sink?.({ kind: 'transition', transition: { ...t } });
  }

  /** Open the call: idle → listening. */
  start(nowMs: number): boolean {
    this.started = true;
    this.lastActivityAtMs = nowMs;
    return this.transitionTo('listening', 'start', nowMs);
  }

  /** Mirror an outer state (e.g. the v11 barge-in machine) into this machine. */
  mirrorState(state: TurnV12State, atMs: number): boolean {
    return this.transitionTo(state, 'mirror', atMs);
  }

  /** The user starts speaking: listening → user turn (state stays `listening` until the turn ends). */
  beginUserTurn(nowMs: number): TurnV12Turn | null {
    if (this.state !== 'listening') return null;
    if (this.currentTurn?.speaker === 'user') return { ...this.currentTurn };
    this.lastActivityAtMs = nowMs;
    return this.openTurn('user', nowMs);
  }

  /** The user stops speaking: close the user turn, move to `thinking`. */
  endUserTurn(nowMs: number, endedBy: TurnV12Turn['endedBy'] = 'speech-end'): TurnV12Turn | null {
    if (this.state !== 'listening' || !this.currentTurn || this.currentTurn.speaker !== 'user') return null;
    const turn = this.closeTurn(nowMs, endedBy);
    this.lastActivityAtMs = nowMs;
    this.transitionTo('thinking', 'user-turn-ended', nowMs);
    return turn;
  }

  /** The agent starts speaking: thinking/listening → `speaking` + agent turn. */
  beginAgentTurn(nowMs: number): TurnV12Turn | null {
    if (this.state !== 'thinking' && this.state !== 'listening') return null;
    this.transitionTo('speaking', 'reply-started', nowMs);
    this.lastActivityAtMs = nowMs;
    return this.openTurn('agent', nowMs);
  }

  /** The agent stops speaking: close the agent turn, back to `listening`. */
  endAgentTurn(nowMs: number, endedBy: TurnV12Turn['endedBy'] = 'drained'): TurnV12Turn | null {
    if (this.state !== 'speaking' || !this.currentTurn || this.currentTurn.speaker !== 'agent') return null;
    const turn = this.closeTurn(nowMs, endedBy);
    this.lastActivityAtMs = nowMs;
    this.transitionTo('listening', 'reply-finished', nowMs);
    return turn;
  }

  /** The user cut in: speaking/thinking → `interrupted` (turn closed as barged-in). */
  interrupt(nowMs: number): boolean {
    if (this.state !== 'speaking' && this.state !== 'thinking' && this.state !== 'listening') return false;
    if (this.currentTurn) this.closeTurn(nowMs, 'barge-in');
    this.interrupts += 1;
    this.lastInterruptAtMs = nowMs;
    this.lastActivityAtMs = nowMs;
    return this.transitionTo('interrupted', 'interrupt', nowMs);
  }

  /** End the call: any state → idle. */
  endCall(nowMs: number): boolean {
    this.currentTurn = null;
    this.cooldownUntilMs = null;
    if (this.state === 'idle') return true;
    this.logTransition(this.state, 'idle', 'end-call', nowMs, true);
    this.state = 'idle';
    this.stateEnteredAtMs = nowMs;
    return true;
  }

  /**
   * Advance timers: `interrupted` → `cooldown` → `listening`
   * (cooldown runs from the interrupt itself), listening
   * silence timeout / nudge / call-idle, thinking timeout.
   * Returns the state after the tick.
   */
  tick(nowMs: number): TurnV12State {
    if (!this.started) return this.state;
    if (this.state === 'interrupted') {
      this.transitionTo('cooldown', 'interrupt-settled', nowMs);
      this.cooldownUntilMs = (this.lastInterruptAtMs ?? nowMs) + this.options.cooldownMs;
    }
    if (this.state === 'cooldown' && this.cooldownUntilMs !== null && nowMs >= this.cooldownUntilMs) {
      this.cooldownUntilMs = null;
      this.transitionTo('listening', 'cooldown-expired', nowMs);
    }
    if (this.state === 'listening') {
      const idleMs = nowMs - this.lastActivityAtMs;
      if (idleMs >= this.options.listeningSilenceMs) {
        if (this.nudgesThisStretch < this.options.maxNudges) {
          this.silenceTimeouts += 1;
          this.nudgesThisStretch += 1;
          this.nudges += 1;
          this.lastActivityAtMs = nowMs;
          this.sink?.({ kind: 'silence-timeout', atMs: nowMs, idleMs, nudge: this.nudgesThisStretch });
          if (this.options.nudgeOnSilence) {
            this.sink?.({ kind: 'nudge', atMs: nowMs, nudge: this.nudgesThisStretch });
          }
        } else if (!this.callIdleFired) {
          this.callIdleFired = true;
          this.sink?.({ kind: 'call-idle', atMs: nowMs, idleMs });
        }
      }
      return this.state;
    }
    if (this.state === 'thinking') {
      const thinkingMs = nowMs - this.stateEnteredAtMs;
      if (thinkingMs >= this.options.thinkingTimeoutMs) {
        this.thinkingTimeouts += 1;
        this.sink?.({ kind: 'thinking-timeout', atMs: nowMs, thinkingMs });
        this.transitionTo('listening', 'thinking-timeout', nowMs);
        this.lastActivityAtMs = nowMs;
      }
      return this.state;
    }
    return this.state;
  }

  /** Reset all state (new call). */
  reset(nowMs = 0): void {
    this.state = 'idle';
    this.transitions = [];
    this.currentTurn = null;
    this.history = [];
    this.nextTurnId = 1;
    this.stateEnteredAtMs = nowMs;
    this.lastActivityAtMs = nowMs;
    this.started = false;
    this.nudgesThisStretch = 0;
    this.callIdleFired = false;
    this.silenceTimeouts = 0;
    this.nudges = 0;
    this.thinkingTimeouts = 0;
    this.interrupts = 0;
    this.illegalTransitions = 0;
    this.cooldownUntilMs = null;
    this.lastInterruptAtMs = null;
  }

  private openTurn(speaker: 'user' | 'agent', nowMs: number): TurnV12Turn {
    const turn: TurnV12Turn = {
      id: this.nextTurnId,
      speaker,
      startedAtMs: nowMs,
      endedAtMs: nowMs,
      durationMs: 0,
      endedBy: 'speech-end',
    };
    this.nextTurnId += 1;
    this.currentTurn = turn;
    this.sink?.({ kind: 'turn-started', turn: { ...turn } });
    return turn;
  }

  private closeTurn(nowMs: number, endedBy: TurnV12Turn['endedBy']): TurnV12Turn | null {
    const turn = this.currentTurn;
    if (!turn) return null;
    turn.endedAtMs = nowMs;
    turn.durationMs = Math.max(0, nowMs - turn.startedAtMs);
    turn.endedBy = endedBy;
    this.currentTurn = null;
    this.history.push({ ...turn });
    this.sink?.({ kind: 'turn-ended', turn: { ...turn } });
    return turn;
  }
}

/** One-line summary of turn-machine v12 stats. */
export function turnMachineV12Summary(stats: TurnMachineV12Stats): string {
  return (
    `Turn machine v12: ${stats.state}, ${stats.turns} turns ` +
    `(user ${stats.userTurns}, agent ${stats.agentTurns}), ${stats.interrupts} interrupts, ` +
    `${stats.silenceTimeouts} silence timeouts, ${stats.nudges} nudges, ` +
    `${stats.thinkingTimeouts} thinking timeouts, ${stats.illegalTransitions} illegal transitions`
  );
}

/** Turn-machine v12 stats as Markdown (for the diagnostics panel). */
export function turnMachineV12Markdown(stats: TurnMachineV12Stats): string {
  const lines = [
    '## Turn machine v12',
    '',
    `- state: ${stats.state} (${stats.stateMs} ms in state)`,
    `- turns: ${stats.turns} (user ${stats.userTurns}, agent ${stats.agentTurns})`,
    `- interrupts: ${stats.interrupts}, silence timeouts: ${stats.silenceTimeouts}, nudges: ${stats.nudges}`,
    `- thinking timeouts: ${stats.thinkingTimeouts}, illegal transitions: ${stats.illegalTransitions}`,
    `- listening idle: ${stats.listeningIdleMs} ms`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// End-of-turn detector
// ---------------------------------------------------------------------------

/** Options for `EndOfTurnDetectorV12`. */
export interface EndOfTurnDetectorV12Options {
  /** Trailing silence (ms) that ends a turn (default 700). */
  trailingSilenceMs?: number;
  /** Minimum speech (ms) for a real turn (default 300). */
  minSpeechMs?: number;
  /** Pause (ms) below which two bursts merge into one turn (default 500). */
  mergePauseMs?: number;
  /** Longest a turn may run (ms, default 30000). */
  maxTurnMs?: number;
}

/** How a detected turn ended. */
export type EndOfTurnV12Reason =
  | 'silence'
  | 'backchannel'
  | 'false-start'
  | 'turn-merged'
  | 'turn-timeout';

/** One end-of-turn decision. */
export interface EndOfTurnV12Decision {
  kind: 'turn-ended' | 'backchannel' | 'false-start' | 'turn-merged' | 'turn-timeout' | 'turn-started';
  atMs: number;
  turnId: number;
  /** Speech duration of the turn so far (ms). */
  speechMs: number;
  /** Trailing silence observed (ms, 0 for turn-started). */
  silenceMs: number;
  reason: EndOfTurnV12Reason | 'speech-start';
}

/** Counters for one detector. */
export interface EndOfTurnDetectorV12Stats {
  turns: number;
  backchannels: number;
  falseStarts: number;
  merged: number;
  timeouts: number;
  speaking: boolean;
  currentSpeechMs: number;
  currentSilenceMs: number;
}

export type EndOfTurnDetectorV12EventSink = (decision: EndOfTurnV12Decision) => void;

export function defaultEndOfTurnDetectorV12Options(): Required<EndOfTurnDetectorV12Options> {
  return {
    trailingSilenceMs: 700,
    minSpeechMs: 300,
    mergePauseMs: 500,
    maxTurnMs: 30000,
  };
}

export function validateEndOfTurnDetectorV12Options(options: EndOfTurnDetectorV12Options): Required<EndOfTurnDetectorV12Options> {
  const base = defaultEndOfTurnDetectorV12Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`End-of-turn detector v12 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  const trailingSilenceMs = num(options.trailingSilenceMs, base.trailingSilenceMs, 'trailingSilenceMs', 100, 10000);
  const mergePauseMs = num(options.mergePauseMs, base.mergePauseMs, 'mergePauseMs', 0, 10000);
  if (mergePauseMs >= trailingSilenceMs) {
    throw new Error(`End-of-turn detector v12 mergePauseMs (${mergePauseMs}) must be < trailingSilenceMs (${trailingSilenceMs}).`);
  }
  return {
    trailingSilenceMs,
    minSpeechMs: num(options.minSpeechMs, base.minSpeechMs, 'minSpeechMs', 0, 10000),
    mergePauseMs,
    maxTurnMs: num(options.maxTurnMs, base.maxTurnMs, 'maxTurnMs', 1000, 600000),
  };
}

/**
 * End-of-turn detector: consumes VAD speech-start / speech-end
 * events on the virtual clock and decides when a user turn is
 * really over. A turn ends only after `trailingSilenceMs` of
 * silence — a short pause merges (`turn-merged`), a very short
 * burst is a `backchannel`, a burst that stops before
 * `minSpeechMs` is a `false-start`, and a turn that runs past
 * `maxTurnMs` is force-ended.
 *
 * The detector does NOT end a turn on speech-end alone: the
 * caller feeds `speechEnd` and then `tick()`s through the
 * silence; the decision fires when the trailing silence is long
 * enough. Feed `speechStart` again during the silence window
 * and the turn continues (merge).
 */
export class EndOfTurnDetectorV12 {
  private readonly options: Required<EndOfTurnDetectorV12Options>;
  private readonly sink: EndOfTurnDetectorV12EventSink | null;
  private speaking = false;
  private speechStartedAtMs: number | null = null;
  private silenceStartedAtMs: number | null = null;
  private turnId = 0;
  private turnSpeechMs = 0;
  private turnStarted = false;
  private endFired = false;
  private turns = 0;
  private backchannels = 0;
  private falseStarts = 0;
  private merged = 0;
  private timeouts = 0;

  constructor(options: EndOfTurnDetectorV12Options = {}, sink: EndOfTurnDetectorV12EventSink | null = null) {
    this.options = validateEndOfTurnDetectorV12Options(options);
    this.sink = sink;
  }

  getOptions(): Required<EndOfTurnDetectorV12Options> {
    return { ...this.options };
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  getStats(nowMs: number): EndOfTurnDetectorV12Stats {
    return {
      turns: this.turns,
      backchannels: this.backchannels,
      falseStarts: this.falseStarts,
      merged: this.merged,
      timeouts: this.timeouts,
      speaking: this.speaking,
      currentSpeechMs: this.speechStartedAtMs !== null ? Math.max(0, nowMs - this.speechStartedAtMs) + this.turnSpeechMs : this.turnSpeechMs,
      currentSilenceMs: this.silenceStartedAtMs !== null ? Math.max(0, nowMs - this.silenceStartedAtMs) : 0,
    };
  }

  /** VAD speech-start at `atMs`. */
  speechStart(atMs: number): EndOfTurnV12Decision | null {
    if (this.speaking) return null;
    // A new burst after the trailing silence already elapsed
    // means the old turn ended first — finalize it (turn-ended /
    // backchannel / false-start) before opening the new one.
    if (this.turnStarted && this.silenceStartedAtMs !== null && atMs - this.silenceStartedAtMs >= this.options.trailingSilenceMs) {
      this.tick(atMs);
    }
    this.speaking = true;
    // Resuming inside the trailing-silence window merges the
    // pause into the same turn. A pause below `mergePauseMs`
    // is a plain merge; a longer pause (still below the trailing
    // silence) continues the turn without a merge event.
    if (this.turnStarted && this.silenceStartedAtMs !== null) {
      const pauseMs = atMs - this.silenceStartedAtMs;
      if (pauseMs < this.options.trailingSilenceMs) {
        this.silenceStartedAtMs = null;
        this.speechStartedAtMs = atMs;
        this.endFired = false;
        if (pauseMs >= this.options.mergePauseMs) return null;
        this.merged += 1;
        const decision: EndOfTurnV12Decision = {
          kind: 'turn-merged', atMs, turnId: this.turnId, speechMs: this.turnSpeechMs, silenceMs: pauseMs, reason: 'turn-merged',
        };
        this.sink?.(decision);
        return decision;
      }
    }
    this.turnId += 1;
    this.turnStarted = true;
    this.turnSpeechMs = 0;
    this.silenceStartedAtMs = null;
    this.speechStartedAtMs = atMs;
    this.endFired = false;
    const decision: EndOfTurnV12Decision = {
      kind: 'turn-started', atMs, turnId: this.turnId, speechMs: 0, silenceMs: 0, reason: 'speech-start',
    };
    this.sink?.(decision);
    return decision;
  }

  /** VAD speech-end at `atMs` (trailing silence starts now). */
  speechEnd(atMs: number): void {
    if (!this.speaking) return;
    this.speaking = false;
    if (this.speechStartedAtMs !== null) {
      this.turnSpeechMs += Math.max(0, atMs - this.speechStartedAtMs);
      this.speechStartedAtMs = null;
    }
    this.silenceStartedAtMs = atMs;
  }

  /**
   * Advance the clock: fire the end-of-turn decision when the
   * trailing silence is long enough, or a turn-timeout when the
   * turn runs too long. Returns the decision fired, or null.
   */
  tick(nowMs: number): EndOfTurnV12Decision | null {
    if (!this.turnStarted || this.endFired) return null;
    // Max-turn timeout while still speaking.
    if (this.speaking && this.speechStartedAtMs !== null) {
      const speechMs = this.turnSpeechMs + Math.max(0, nowMs - this.speechStartedAtMs);
      if (speechMs >= this.options.maxTurnMs) {
        this.timeouts += 1;
        this.endFired = true;
        this.turns += 1;
        const decision: EndOfTurnV12Decision = {
          kind: 'turn-timeout', atMs: nowMs, turnId: this.turnId, speechMs, silenceMs: 0, reason: 'turn-timeout',
        };
        this.sink?.(decision);
        this.turnStarted = false;
        this.speechStartedAtMs = null;
        return decision;
      }
      return null;
    }
    if (this.silenceStartedAtMs === null) return null;
    const silenceMs = nowMs - this.silenceStartedAtMs;
    if (silenceMs < this.options.trailingSilenceMs) return null;
    this.endFired = true;
    const speechMs = this.turnSpeechMs;
    const turnId = this.turnId;
    if (speechMs < this.options.minSpeechMs) {
      // Too short to be a turn: a tiny burst is a backchannel,
      // a slightly longer one that stopped early is a false start.
      const veryShort = speechMs < this.options.minSpeechMs / 2;
      if (veryShort) this.backchannels += 1;
      else this.falseStarts += 1;
      const decision: EndOfTurnV12Decision = {
        kind: veryShort ? 'backchannel' : 'false-start',
        atMs: nowMs, turnId, speechMs, silenceMs,
        reason: veryShort ? 'backchannel' : 'false-start',
      };
      this.sink?.(decision);
      this.turnStarted = false;
      return decision;
    }
    this.turns += 1;
    const decision: EndOfTurnV12Decision = {
      kind: 'turn-ended', atMs: nowMs, turnId, speechMs, silenceMs, reason: 'silence',
    };
    this.sink?.(decision);
    this.turnStarted = false;
    return decision;
  }

  /** Reset all state. */
  reset(): void {
    this.speaking = false;
    this.speechStartedAtMs = null;
    this.silenceStartedAtMs = null;
    this.turnId = 0;
    this.turnSpeechMs = 0;
    this.turnStarted = false;
    this.endFired = false;
    this.turns = 0;
    this.backchannels = 0;
    this.falseStarts = 0;
    this.merged = 0;
    this.timeouts = 0;
  }
}

/** One-line summary of end-of-turn detector stats. */
export function endOfTurnDetectorV12Summary(stats: EndOfTurnDetectorV12Stats): string {
  return (
    `End-of-turn v12: ${stats.turns} turns, ${stats.backchannels} backchannels, ` +
    `${stats.falseStarts} false starts, ${stats.merged} merged, ${stats.timeouts} timeouts` +
    `${stats.speaking ? `, speaking ${stats.currentSpeechMs} ms` : ''}`
  );
}
