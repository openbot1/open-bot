/**
 * Turn-taking state machine v5 (v1.18, Đội T5 — voice v17).
 *
 * v16 wired a session through wake → listen → think → speak, but
 * the states lived in the session as a plain field: any method
 * could set any state, nothing recorded which transition was
 * illegal, and a state could stick forever — a thinking state with
 * a dead LLM, a speaking state whose TTS never reported done, an
 * interrupted state nobody resumed. The panel could only guess.
 *
 * v17 makes the turn state explicit, event-driven and watched:
 *
 *   idle → listening ⇄ thinking ⇄ speaking
 *   speaking → interrupted → listening
 *   any live state → closed → idle (a new call reuses the machine)
 *
 *   - One table of legal transitions (`TURN_TAKING_V17_TRANSITIONS`).
 *     `handle()` takes a turn event — VAD speech start/end,
 *     barge-in, tool-done, sentence-end, reply start/done — and
 *     moves only when the table allows it. An illegal move is
 *     rejected (never throws) and counted, so a caller bug shows
 *     up in stats instead of silently corrupting the panel.
 *   - Every state has a timeout. `tick(atMs)` is the watchdog:
 *     listening with no speech for `listeningSilenceTimeoutMs`
 *     prompts the user and stays listening; thinking past
 *     `thinkingTimeoutMs` or speaking past `speakingMaxMs` or an
 *     interrupted state past `interruptedTimeoutMs` is a stuck
 *     state — the machine recovers to listening, emits `recovered`
 *     and counts it. A stuck turn can never hold the floor forever.
 *   - `force()` exists for exactly one case: recovery after an
 *     unexpected transport drop, where the session knows the real
 *     state better than the machine does. It is counted separately
 *     (`forced`) so it never hides in the normal numbers.
 *   - Every transition is recorded (from / to / reason / at) with
 *     a bounded history — the panel's "what just happened" and
 *     the diagnostics log read this, not a guess.
 *
 * Pure logic, no transport, no audio: the v17 session drives it
 * from VAD, barge-in, tool and TTS events. The clock is virtual
 * (`tick(atMs)` / event `atMs`); tests drive it with a fake clock.
 */

export type TurnTakingV17State = 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'closed';

/** The six turn states, in the order the UI lists them. */
export const TURN_TAKING_V17_STATES: readonly TurnTakingV17State[] = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'interrupted',
  'closed',
];

/** Legal transitions. Anything not listed here is rejected. */
export const TURN_TAKING_V17_TRANSITIONS: Readonly<Record<TurnTakingV17State, readonly TurnTakingV17State[]>> = {
  idle: ['listening', 'closed'],
  listening: ['thinking', 'speaking', 'interrupted', 'closed'],
  thinking: ['speaking', 'listening', 'interrupted', 'closed'],
  speaking: ['listening', 'interrupted', 'closed'],
  interrupted: ['listening', 'speaking', 'closed'],
  closed: ['idle', 'listening'],
};

/** True when the turn is live (a call is in progress). */
export function isTurnTakingV17Live(state: TurnTakingV17State): boolean {
  return state === 'listening' || state === 'thinking' || state === 'speaking' || state === 'interrupted';
}

/** True when the user can talk and be heard (the model is not speaking). */
export function isTurnTakingV17UserTurn(state: TurnTakingV17State): boolean {
  return state === 'listening' || state === 'interrupted';
}

/** True when the model is speaking (barge-in applies). */
export function isTurnTakingV17ModelSpeaking(state: TurnTakingV17State): boolean {
  return state === 'speaking';
}

/** Events the machine accepts, each with the virtual time it fired. */
export type TurnTakingV17EventKind =
  | 'connect'
  | 'vad-speech-start'
  | 'vad-speech-end'
  | 'vad-noise'
  | 'barge-in'
  | 'tool-done'
  | 'sentence-end'
  | 'reply-start'
  | 'reply-done'
  | 'disconnect'
  | 'reset';

export interface TurnTakingV17EventInput {
  kind: TurnTakingV17EventKind;
  atMs: number;
  reason?: string;
}

/** One recorded transition. */
export interface TurnTakingV17Transition {
  from: TurnTakingV17State;
  to: TurnTakingV17State;
  /** Why the transition happened (event kind, caller action, ...). */
  reason: string;
  /** True when this transition went through `force()` or a watchdog recovery. */
  forced: boolean;
  atMs: number;
}

export type TurnTakingV17MachineEvent =
  | { kind: 'turn-state'; transition: TurnTakingV17Transition }
  | { kind: 'turn-state-rejected'; from: TurnTakingV17State; to: TurnTakingV17State; reason: string; atMs: number }
  | { kind: 'turn-timeout'; state: TurnTakingV17State; atMs: number; reason: string }
  | { kind: 'turn-prompt'; atMs: number; reason: string }
  | { kind: 'turn-recovered'; transition: TurnTakingV17Transition };

export type TurnTakingV17EventSink = (event: TurnTakingV17MachineEvent) => void;

/** Result of asking for a transition. */
export type TurnTakingV17TransitionResult =
  | { ok: true; transition: TurnTakingV17Transition }
  | { ok: false; from: TurnTakingV17State; to: TurnTakingV17State; reason: string };

export interface TurnTakingV17Options {
  /** Starting state (default 'idle'). */
  initialState?: TurnTakingV17State;
  /** Silence in listening before prompting the user (ms, default 15000). */
  listeningSilenceTimeoutMs?: number;
  /** Thinking longer than this is stuck (ms, default 30000). */
  thinkingTimeoutMs?: number;
  /** Speaking longer than this is stuck (ms, default 120000). */
  speakingMaxMs?: number;
  /** Interrupted longer than this recovers to listening (ms, default 10000). */
  interruptedTimeoutMs?: number;
  /** Max history entries kept (default 100). */
  maxHistoryEntries?: number;
}

export function defaultTurnTakingV17Options(): Required<TurnTakingV17Options> {
  return {
    initialState: 'idle',
    listeningSilenceTimeoutMs: 15000,
    thinkingTimeoutMs: 30000,
    speakingMaxMs: 120000,
    interruptedTimeoutMs: 10000,
    maxHistoryEntries: 100,
  };
}

export function validateTurnTakingV17Options(options: TurnTakingV17Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof TurnTakingV17Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('listeningSilenceTimeoutMs', options.listeningSilenceTimeoutMs, 1000, 300000);
  check('thinkingTimeoutMs', options.thinkingTimeoutMs, 1000, 300000);
  check('speakingMaxMs', options.speakingMaxMs, 5000, 600000);
  check('interruptedTimeoutMs', options.interruptedTimeoutMs, 1000, 120000);
  check('maxHistoryEntries', options.maxHistoryEntries, 1, 10000);
  if (
    options.initialState !== undefined &&
    !(TURN_TAKING_V17_STATES as readonly string[]).includes(options.initialState)
  ) {
    errors.push(`unknown initialState "${options.initialState}"`);
  }
  return errors;
}

export interface TurnTakingV17Stats {
  state: TurnTakingV17State;
  /** ms spent in the current state (0 when the clock never moved). */
  msInState: number;
  transitions: number;
  rejected: number;
  forced: number;
  timeouts: number;
  recoveries: number;
  prompts: number;
  /** Transitions per target state (how often each state was entered). */
  entered: Record<TurnTakingV17State, number>;
  /** Turns completed (listening → thinking → speaking → listening cycles). */
  turnsCompleted: number;
  sentencesSpoken: number;
}

const EMPTY_ENTERED = (): Record<TurnTakingV17State, number> => ({
  idle: 0,
  listening: 0,
  thinking: 0,
  speaking: 0,
  interrupted: 0,
  closed: 0,
});

/**
 * The target state each event asks for, from each state. `null`
 * means "stay" (the event is noted but moves nothing); `undefined`
 * means "illegal here" (rejected and counted).
 */
const EVENT_TARGETS: Record<TurnTakingV17EventKind, Partial<Record<TurnTakingV17State, TurnTakingV17State | null>>> = {
  connect: { idle: 'listening', closed: 'listening' },
  'vad-speech-start': { listening: null, interrupted: 'listening', thinking: null, speaking: null },
  'vad-speech-end': { listening: 'thinking', thinking: null },
  'vad-noise': { listening: null, speaking: null, thinking: null, interrupted: null },
  'barge-in': { speaking: 'interrupted' },
  'tool-done': { thinking: null, speaking: null },
  'sentence-end': { speaking: null },
  'reply-start': { thinking: 'speaking', listening: 'speaking', interrupted: 'speaking', speaking: null },
  'reply-done': { speaking: 'listening' },
  disconnect: { listening: 'closed', thinking: 'closed', speaking: 'closed', interrupted: 'closed', idle: 'closed' },
  reset: { closed: 'idle', idle: null },
};

export class TurnTakingMachineV17 {
  private state: TurnTakingV17State;
  private stateSinceMs: number;
  private nowMs = 0;
  private readonly options: Required<TurnTakingV17Options>;
  private readonly sink: TurnTakingV17EventSink | undefined;
  private readonly history: TurnTakingV17Transition[] = [];
  private rejectedCount = 0;
  private forcedCount = 0;
  private timeouts = 0;
  private recoveries = 0;
  private prompts = 0;
  private lastPromptAtMs: number | undefined;
  private readonly entered: Record<TurnTakingV17State, number>;
  private turnsCompleted = 0;
  private sentencesSpoken = 0;

  constructor(options: TurnTakingV17Options = {}, sink?: TurnTakingV17EventSink) {
    const merged = { ...defaultTurnTakingV17Options(), ...options };
    const errors = validateTurnTakingV17Options(merged);
    if (errors.length > 0) throw new Error(`invalid turn-taking v17 options: ${errors.join('; ')}`);
    this.options = merged;
    this.sink = sink;
    this.state = merged.initialState;
    this.stateSinceMs = 0;
    this.entered = EMPTY_ENTERED();
    this.entered[this.state] = 1;
  }

  getState(): TurnTakingV17State {
    return this.state;
  }

  now(): number {
    return this.nowMs;
  }

  /** ms spent in the current state. */
  msInState(): number {
    return Math.max(0, this.nowMs - this.stateSinceMs);
  }

  /** True when `to` is a legal transition from the current state. */
  can(to: TurnTakingV17State): boolean {
    return TURN_TAKING_V17_TRANSITIONS[this.state].includes(to);
  }

  /**
   * Handle one turn event. A no-op event (target `null`) succeeds
   * without recording — VAD frames repeat and must not flood the
   * history. Anything illegal is rejected and counted.
   */
  handle(event: TurnTakingV17EventInput): TurnTakingV17TransitionResult {
    this.nowMs = Math.max(this.nowMs, event.atMs);
    const target = EVENT_TARGETS[event.kind]?.[this.state];
    if (target === undefined) {
      this.rejectedCount += 1;
      this.sink?.({
        kind: 'turn-state-rejected',
        from: this.state,
        to: this.state,
        reason: `event ${event.kind} is illegal in ${this.state}`,
        atMs: event.atMs,
      });
      return { ok: false, from: this.state, to: this.state, reason: `event ${event.kind} is illegal in ${this.state}` };
    }
    if (event.kind === 'sentence-end') this.sentencesSpoken += 1;
    if (target === null) {
      // Noted, no move — but the clock moved, so the watchdog
      // measures from the last real activity.
      this.stateSinceMs = this.nowMs;
      return {
        ok: true,
        transition: { from: this.state, to: this.state, reason: event.reason ?? event.kind, forced: false, atMs: event.atMs },
      };
    }
    return this.transition(target, event.reason ?? event.kind, event.atMs);
  }

  /** Move to `to` when the transition is legal. */
  transition(to: TurnTakingV17State, reason: string, atMs?: number): TurnTakingV17TransitionResult {
    if (atMs !== undefined) this.nowMs = Math.max(this.nowMs, atMs);
    if (to === this.state) {
      return {
        ok: true,
        transition: { from: this.state, to, reason, forced: false, atMs: this.nowMs },
      };
    }
    if (!this.can(to)) {
      this.rejectedCount += 1;
      this.sink?.({ kind: 'turn-state-rejected', from: this.state, to, reason, atMs: this.nowMs });
      return { ok: false, from: this.state, to, reason: `illegal transition ${this.state} -> ${to}` };
    }
    return { ok: true, transition: this.apply(to, reason, false, this.nowMs) };
  }

  /**
   * Move to `to` even when the transition is not in the table.
   * Recovery only (unexpected transport drop): counted separately
   * so a forced jump never hides in the normal numbers.
   */
  force(to: TurnTakingV17State, reason: string, atMs?: number): TurnTakingV17Transition {
    if (atMs !== undefined) this.nowMs = Math.max(this.nowMs, atMs);
    if (to === this.state) {
      return { from: this.state, to, reason, forced: true, atMs: this.nowMs };
    }
    this.forcedCount += 1;
    return this.apply(to, reason, true, this.nowMs);
  }

  /**
   * Watchdog: advance the virtual clock and recover stuck states.
   * Listening with no speech prompts the user (and stays
   * listening); a stuck thinking / speaking / interrupted state
   * recovers to listening. Returns the recovery transition, if any.
   */
  tick(atMs: number): TurnTakingV17Transition | undefined {
    this.nowMs = Math.max(this.nowMs, atMs);
    const inState = this.msInState();
    switch (this.state) {
      case 'listening': {
        if (inState >= this.options.listeningSilenceTimeoutMs) {
          this.timeouts += 1;
          this.prompts += 1;
          this.lastPromptAtMs = this.nowMs;
          this.stateSinceMs = this.nowMs;
          this.sink?.({ kind: 'turn-timeout', state: 'listening', atMs: this.nowMs, reason: 'silence in listening' });
          this.sink?.({ kind: 'turn-prompt', atMs: this.nowMs, reason: 'User has been silent — prompting.' });
        }
        return undefined;
      }
      case 'thinking': {
        if (inState >= this.options.thinkingTimeoutMs) return this.recover('thinking timed out (no reply)');
        return undefined;
      }
      case 'speaking': {
        if (inState >= this.options.speakingMaxMs) return this.recover('speaking timed out (TTS never finished)');
        return undefined;
      }
      case 'interrupted': {
        if (inState >= this.options.interruptedTimeoutMs) return this.recover('interrupted timed out (no resume)');
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /** Back to `idle`, keeping the history (a new call reuses this). */
  reset(reason = 'reset', atMs?: number): TurnTakingV17TransitionResult {
    if (atMs !== undefined) this.nowMs = Math.max(this.nowMs, atMs);
    if (this.state === 'idle') {
      return {
        ok: true,
        transition: { from: 'idle', to: 'idle', reason, forced: false, atMs: this.nowMs },
      };
    }
    if (this.state !== 'closed') this.apply('closed', reason, false, this.nowMs);
    return { ok: true, transition: this.apply('idle', reason, false, this.nowMs) };
  }

  /** History, oldest first (copies — callers cannot mutate it). */
  getHistory(): TurnTakingV17Transition[] {
    return this.history.map((h) => ({ ...h }));
  }

  /** Last transition, or null when nothing happened yet. */
  getLastTransition(): TurnTakingV17Transition | null {
    const last = this.history.at(-1);
    return last ? { ...last } : null;
  }

  lastPromptAt(): number | undefined {
    return this.lastPromptAtMs;
  }

  getStats(): TurnTakingV17Stats {
    return {
      state: this.state,
      msInState: this.msInState(),
      transitions: this.history.length,
      rejected: this.rejectedCount,
      forced: this.forcedCount,
      timeouts: this.timeouts,
      recoveries: this.recoveries,
      prompts: this.prompts,
      entered: { ...this.entered },
      turnsCompleted: this.turnsCompleted,
      sentencesSpoken: this.sentencesSpoken,
    };
  }

  summary(): string {
    const s = this.getStats();
    return `turn-taking v17: state=${s.state} (${s.msInState} ms), transitions=${s.transitions}, ` +
      `rejected=${s.rejected}, timeouts=${s.timeouts}, recoveries=${s.recoveries}, prompts=${s.prompts}, ` +
      `turns=${s.turnsCompleted}, sentences=${s.sentencesSpoken}`;
  }

  markdown(): string {
    const s = this.getStats();
    const lines = [
      '## Turn-taking v17',
      '',
      `- State: \`${s.state}\` (${s.msInState} ms in state); transitions: ${s.transitions}; rejected: ${s.rejected}; forced: ${s.forced}`,
      `- Timeouts: ${s.timeouts}; recoveries: ${s.recoveries}; prompts: ${s.prompts}`,
      `- Turns completed: ${s.turnsCompleted}; sentences spoken: ${s.sentencesSpoken}`,
      `- Entered: ${TURN_TAKING_V17_STATES.filter((st) => s.entered[st] > 0).map((st) => `${st}:${s.entered[st]}`).join(' ')}`,
      '',
      '| From | To | Reason | At |',
      '| --- | --- | --- | ---: |',
    ];
    for (const h of this.history.slice(-20)) {
      lines.push(`| ${h.from} | ${h.to} | ${h.reason} | ${h.atMs} ms |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private recover(reason: string): TurnTakingV17Transition {
    this.timeouts += 1;
    this.recoveries += 1;
    this.sink?.({ kind: 'turn-timeout', state: this.state, atMs: this.nowMs, reason });
    const transition = this.apply('listening', reason, true, this.nowMs);
    this.sink?.({ kind: 'turn-recovered', transition: { ...transition } });
    return transition;
  }

  private apply(to: TurnTakingV17State, reason: string, forced: boolean, atMs: number): TurnTakingV17Transition {
    const transition: TurnTakingV17Transition = { from: this.state, to, reason, forced, atMs };
    // A completed turn: speaking → listening.
    if (this.state === 'speaking' && to === 'listening') this.turnsCompleted += 1;
    this.state = to;
    this.stateSinceMs = atMs;
    this.entered[to] += 1;
    this.history.push(transition);
    if (this.history.length > this.options.maxHistoryEntries) {
      this.history.splice(0, this.history.length - this.options.maxHistoryEntries);
    }
    this.sink?.({ kind: 'turn-state', transition: { ...transition } });
    return transition;
  }
}

export function createTurnTakingMachineV17(
  options: TurnTakingV17Options = {},
  sink?: TurnTakingV17EventSink,
): TurnTakingMachineV17 {
  return new TurnTakingMachineV17(options, sink);
}

export function turnTakingV17Summary(machine: TurnTakingMachineV17): string {
  return machine.summary();
}

export function turnTakingV17Markdown(machine: TurnTakingMachineV17): string {
  return machine.markdown();
}
