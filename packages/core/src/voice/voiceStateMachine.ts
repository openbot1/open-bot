/**
 * Realtime voice call state machine (v1.07, Team T5 — voice v4 + UI).
 *
 * v3/v4/v5 all had *implicit* call state: the panel guessed
 * listening/speaking from the last event kind, and the barge-in
 * controllers each kept their own private state (`idle` /
 * `listening` / `interrupted` in v4). Two guesses could disagree —
 * the panel could show "listening" while the v4 detector was still
 * in `interrupted`, and nothing recorded *when* a state started or
 * which transition was illegal.
 *
 * This module is the one explicit state for a v6 call:
 *
 *   idle → connecting → listening ⇄ speaking
 *   listening/speaking → interrupted → listening
 *   any live state → reconnecting → listening / speaking
 *   any live state → degraded → listening / reconnecting
 *   any state → ended → idle (a new call reuses the machine)
 *
 * Rules:
 *   - Only the transitions in `VOICE_CALL_TRANSITIONS` are legal.
 *     An illegal transition is rejected (never throws) and counted,
 *     so a caller bug shows up in stats instead of silently
 *     corrupting the panel.
 *   - `force()` exists for exactly one case: recovery after an
 *     unexpected transport drop, where the session knows the real
 *     state better than the machine does. It is counted separately
 *     (`forced`) so it never hides in the normal numbers.
 *   - Every transition is recorded (from / to / reason / at) with a
 *     bounded history — the panel's "what just happened" and the
 *     diagnostics log read this, not a guess.
 *   - Time in state is measured off the injected clock, so tests
 *     drive it with a fake clock and production uses `Date.now`.
 *
 * Pure logic, no transport, no audio: the v6 session drives it from
 * v4 events (see `voiceSessionV6.ts`).
 */

export type VoiceCallState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'interrupted'
  | 'reconnecting'
  | 'degraded'
  | 'ended';

/** The eight panel states, in the order the UI lists them. */
export const VOICE_CALL_STATES: readonly VoiceCallState[] = [
  'idle',
  'connecting',
  'listening',
  'speaking',
  'interrupted',
  'reconnecting',
  'degraded',
  'ended',
];

/** Legal transitions. Anything not listed here is rejected. */
export const VOICE_CALL_TRANSITIONS: Readonly<Record<VoiceCallState, readonly VoiceCallState[]>> = {
  idle: ['connecting', 'ended'],
  connecting: ['listening', 'speaking', 'reconnecting', 'degraded', 'ended'],
  listening: ['speaking', 'interrupted', 'reconnecting', 'degraded', 'ended'],
  speaking: ['listening', 'interrupted', 'reconnecting', 'degraded', 'ended'],
  interrupted: ['listening', 'speaking', 'reconnecting', 'degraded', 'ended'],
  reconnecting: ['listening', 'speaking', 'degraded', 'ended'],
  degraded: ['listening', 'reconnecting', 'ended'],
  ended: ['idle'],
};

/** True when the call is live (connected or trying to be). */
export function isVoiceCallLive(state: VoiceCallState): boolean {
  return (
    state === 'connecting' ||
    state === 'listening' ||
    state === 'speaking' ||
    state === 'interrupted' ||
    state === 'reconnecting' ||
    state === 'degraded'
  );
}

/** True when the user can talk and be heard (model is not speaking). */
export function isVoiceCallUserTurn(state: VoiceCallState): boolean {
  return state === 'listening' || state === 'interrupted';
}

/** True when the model is speaking (barge-in applies). */
export function isVoiceCallModelSpeaking(state: VoiceCallState): boolean {
  return state === 'speaking';
}

/** One recorded transition. */
export interface VoiceStateTransition {
  from: VoiceCallState;
  to: VoiceCallState;
  /** Why the transition happened (event kind, caller action, ...). */
  reason: string;
  /** True when this transition went through `force()`. */
  forced: boolean;
  at: number;
}

export type VoiceStateMachineEvent =
  | { kind: 'voice-state'; transition: VoiceStateTransition }
  | { kind: 'voice-state-rejected'; from: VoiceCallState; to: VoiceCallState; reason: string; at: number };

export type VoiceStateMachineEventSink = (event: VoiceStateMachineEvent) => void;

/** Result of asking for a transition. */
export type VoiceStateTransitionResult =
  | { ok: true; transition: VoiceStateTransition }
  | { ok: false; from: VoiceCallState; to: VoiceCallState; reason: string };

export interface VoiceStateMachineOptions {
  /** Starting state. Default 'idle'. */
  initialState?: VoiceCallState;
  /** Max history entries kept. Default 100. */
  maxHistoryEntries?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink (transitions + rejections). */
  onEvent?: VoiceStateMachineEventSink;
}

export interface VoiceStateMachineStats {
  state: VoiceCallState;
  /** ms spent in the current state (0 when the clock never moved). */
  msInState: number;
  transitions: number;
  rejected: number;
  forced: number;
  /** Transitions per target state (how often each state was entered). */
  entered: Record<VoiceCallState, number>;
}

const EMPTY_ENTERED = (): Record<VoiceCallState, number> => ({
  idle: 0,
  connecting: 0,
  listening: 0,
  speaking: 0,
  interrupted: 0,
  reconnecting: 0,
  degraded: 0,
  ended: 0,
});

export class VoiceStateMachine {
  private state: VoiceCallState;
  private stateSince: number;
  private readonly history: VoiceStateTransition[] = [];
  private readonly maxHistoryEntries: number;
  private readonly clock: () => number;
  private readonly onEvent: VoiceStateMachineEventSink | undefined;
  private rejectedCount = 0;
  private forcedCount = 0;
  private readonly entered: Record<VoiceCallState, number>;

  constructor(options: VoiceStateMachineOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.state = options.initialState ?? 'idle';
    this.stateSince = this.clock();
    this.maxHistoryEntries = Math.max(1, options.maxHistoryEntries ?? 100);
    this.onEvent = options.onEvent;
    this.entered = EMPTY_ENTERED();
    this.entered[this.state] = 1;
  }

  getState(): VoiceCallState {
    return this.state;
  }

  /** ms spent in the current state. */
  msInState(): number {
    return Math.max(0, this.clock() - this.stateSince);
  }

  /** True when `to` is a legal transition from the current state. */
  can(to: VoiceCallState): boolean {
    return VOICE_CALL_TRANSITIONS[this.state].includes(to);
  }

  /**
   * Move to `to` when the transition is legal. A no-op transition
   * (to the state we are already in) succeeds without recording —
   * v4 events repeat (two `audio` events in a row) and must not
   * flood the history. Anything else illegal is rejected.
   */
  transition(to: VoiceCallState, reason: string): VoiceStateTransitionResult {
    if (to === this.state) {
      return {
        ok: true,
        transition: { from: this.state, to, reason, forced: false, at: this.clock() },
      };
    }
    if (!this.can(to)) {
      this.rejectedCount += 1;
      const at = this.clock();
      this.emit({ kind: 'voice-state-rejected', from: this.state, to, reason, at });
      return { ok: false, from: this.state, to, reason: `illegal transition ${this.state} -> ${to}` };
    }
    return { ok: true, transition: this.apply(to, reason, false) };
  }

  /**
   * Move to `to` even when the transition is not in the table.
   * Recovery only (unexpected transport drop): counted separately
   * so a forced jump never hides in the normal numbers.
   */
  force(to: VoiceCallState, reason: string): VoiceStateTransition {
    if (to === this.state) {
      return { from: this.state, to, reason, forced: true, at: this.clock() };
    }
    this.forcedCount += 1;
    return this.apply(to, reason, true);
  }

  /** Back to `idle`, keeping the history (a new call reuses this). */
  reset(reason = 'reset'): VoiceStateTransitionResult {
    if (this.state === 'idle') {
      return {
        ok: true,
        transition: { from: 'idle', to: 'idle', reason, forced: false, at: this.clock() },
      };
    }
    // `ended -> idle` is legal; any live state goes through `ended`
    // first so the history shows the call actually ending.
    if (this.state !== 'ended') this.apply('ended', reason, false);
    return { ok: true, transition: this.apply('idle', reason, false) };
  }

  /** History, oldest first (copies — callers cannot mutate it). */
  getHistory(): VoiceStateTransition[] {
    return this.history.map((h) => ({ ...h }));
  }

  /** Last transition, or null when nothing happened yet. */
  getLastTransition(): VoiceStateTransition | null {
    const last = this.history.at(-1);
    return last ? { ...last } : null;
  }

  getStats(): VoiceStateMachineStats {
    return {
      state: this.state,
      msInState: this.msInState(),
      transitions: this.history.length,
      rejected: this.rejectedCount,
      forced: this.forcedCount,
      entered: { ...this.entered },
    };
  }

  private apply(to: VoiceCallState, reason: string, forced: boolean): VoiceStateTransition {
    const transition: VoiceStateTransition = {
      from: this.state,
      to,
      reason,
      forced,
      at: this.clock(),
    };
    this.state = to;
    this.stateSince = transition.at;
    this.entered[to] += 1;
    this.history.push(transition);
    if (this.history.length > this.maxHistoryEntries) {
      this.history.splice(0, this.history.length - this.maxHistoryEntries);
    }
    this.emit({ kind: 'voice-state', transition: { ...transition } });
    return transition;
  }

  private emit(event: VoiceStateMachineEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}

/** One-line summary for logs / diagnostics. */
export function voiceStateSummary(machine: VoiceStateMachine): string {
  const stats = machine.getStats();
  const entered = VOICE_CALL_STATES.filter((s) => stats.entered[s] > 0)
    .map((s) => `${s}:${stats.entered[s]}`)
    .join(' ');
  return (
    `state=${stats.state} (${stats.msInState}ms) ` +
    `transitions=${stats.transitions} rejected=${stats.rejected} forced=${stats.forced} ` +
    `entered[${entered}]`
  );
}
