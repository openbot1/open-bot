/**
 * Sandbox v3 — pause / resume lifecycle (v1.35, Team T2).
 *
 * A session is a small state machine:
 *
 *   created → running → paused → running → stopped
 *                  ↘ expired (lifetime cap / paused too long)
 *   created → stopped (cancelled before it ever ran)
 *   paused  → stopped (cancelled while frozen)
 *
 * `paused` is a real freeze, not a flag the runner may ignore: the
 * runner refuses to start any step while the session is paused and
 * reports the step as `skipped-paused`. Pausing also freezes the
 * idle clock — a paused session never auto-stops for idleness —
 * but it does NOT freeze the lifetime deadline: the hard cap keeps
 * ticking while paused, because a pause must never become a way to
 * outlive the session budget.
 *
 * A paused session that stays paused longer than `maxPauseMs`
 * expires (`paused-timeout`): frozen workspaces still hold disk
 * and a reservation, so they cannot sit forever. Every transition
 * is recorded with a timestamp and a reason, so the report can show
 * exactly when the session froze, why, and for how long.
 */

import type { SandboxV3EndReason, SandboxV3SessionState } from './types';

/** Default maximum time a session may stay paused: 15 minutes. */
export const SANDBOX_V3_DEFAULT_MAX_PAUSE_MS = 15 * 60 * 1000;

/** Hard maximum pause: 1 hour. */
export const SANDBOX_V3_MAX_PAUSE_MS = 60 * 60 * 1000;

/** One recorded lifecycle transition. */
export interface SandboxV3LifecycleEvent {
  /** When it happened (ms since epoch). */
  atMs: number;
  /** State before the transition. */
  from: SandboxV3SessionState;
  /** State after the transition. */
  to: SandboxV3SessionState;
  /** Why it happened (operator note, lifetime cause, ...). */
  reason: string;
}

/** Every legal transition, as a set of `from→to` pairs. */
export const SANDBOX_V3_LEGAL_TRANSITIONS: ReadonlySet<string> = new Set([
  'created→running',
  'created→stopped',
  'created→expired',
  'running→paused',
  'running→stopped',
  'running→expired',
  'paused→running',
  'paused→stopped',
  'paused→expired',
]);

/** True when `from → to` is a legal transition. */
export function canTransition(
  from: SandboxV3SessionState,
  to: SandboxV3SessionState,
): boolean {
  if (from === to) return false;
  return SANDBOX_V3_LEGAL_TRANSITIONS.has(`${from}→${to}`);
}

/** States a session may be in and still accept new steps. */
export function isLiveState(state: SandboxV3SessionState): boolean {
  return state === 'created' || state === 'running';
}

/** States from which no further transition is possible. */
export function isTerminalState(state: SandboxV3SessionState): boolean {
  return state === 'stopped' || state === 'expired';
}

export interface LifecycleControllerOptions {
  /** Starting state. Default `created`. */
  initialState?: SandboxV3SessionState;
  /** Max pause duration in ms. Default SANDBOX_V3_DEFAULT_MAX_PAUSE_MS. */
  maxPauseMs?: number;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

/**
 * One session's lifecycle controller. Owns the state, the pause
 * timer and the transition log. The runner asks it before every
 * step; the tools call `pause` / `resume` / `stop` on it.
 */
export class LifecycleController {
  private state: SandboxV3SessionState;
  private readonly maxPauseMs: number;
  private readonly nowMs: () => number;
  private pausedAtMs = 0;
  private totalPausedMs = 0;
  private pauseCount = 0;
  private endReason: SandboxV3EndReason | undefined;
  private endedAtMs = 0;
  private readonly events: SandboxV3LifecycleEvent[] = [];

  constructor(options: LifecycleControllerOptions = {}) {
    this.state = options.initialState ?? 'created';
    const requested = options.maxPauseMs ?? SANDBOX_V3_DEFAULT_MAX_PAUSE_MS;
    this.maxPauseMs = Math.min(
      Math.max(Math.floor(requested), 1000),
      SANDBOX_V3_MAX_PAUSE_MS,
    );
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Current state. */
  getState(): SandboxV3SessionState {
    return this.state;
  }

  /** Max pause duration in ms. */
  getMaxPauseMs(): number {
    return this.maxPauseMs;
  }

  /** When the current pause started (0 when not paused). */
  getPausedAtMs(): number {
    return this.pausedAtMs;
  }

  /** Total time spent paused across all pauses (ms). */
  getTotalPausedMs(): number {
    if (this.state === 'paused') {
      return this.totalPausedMs + (this.nowMs() - this.pausedAtMs);
    }
    return this.totalPausedMs;
  }

  /** How many times this session has been paused. */
  getPauseCount(): number {
    return this.pauseCount;
  }

  /** Why the session ended (undefined while live). */
  getEndReason(): SandboxV3EndReason | undefined {
    return this.endReason;
  }

  /** When the session ended (0 while live). */
  getEndedAtMs(): number {
    return this.endedAtMs;
  }

  /** Transition log, in order. */
  lifecycleEvents(): SandboxV3LifecycleEvent[] {
    return [...this.events];
  }

  /** True when a new step may start in the current state. */
  mayRunStep(): boolean {
    return this.state === 'running';
  }

  /** True when the session is currently paused. */
  isPaused(): boolean {
    return this.state === 'paused';
  }

  /** True when the session is in a terminal state. */
  isTerminal(): boolean {
    return isTerminalState(this.state);
  }

  /** Milliseconds left in the current pause before it expires (0 when not paused). */
  pauseRemainingMs(now?: number): number {
    if (this.state !== 'paused') return 0;
    const at = now ?? this.nowMs();
    return Math.max(0, this.pausedAtMs + this.maxPauseMs - at);
  }

  /** True when the current pause has outlived `maxPauseMs`. */
  isPauseExpired(now?: number): boolean {
    return this.state === 'paused' && this.pauseRemainingMs(now) <= 0;
  }

  /**
   * Move to `running`. Legal from `created` (first start) and from
   * `paused` (resume). Returns true on success, false when the
   * transition is illegal (state unchanged, event recorded).
   */
  start(reason = ''): boolean {
    return this.transition('running', reason === '' ? 'Session started' : reason);
  }

  /**
   * Freeze the session. Legal only from `running`. While paused,
   * no step runs and the idle clock is frozen. Returns true on
   * success.
   */
  pause(reason = ''): boolean {
    if (this.state !== 'running') {
      this.record(this.state, this.state, `Pause refused: session is ${this.state}`);
      return false;
    }
    const at = this.nowMs();
    const ok = this.transition('paused', reason === '' ? 'Session paused' : reason);
    if (ok) {
      this.pausedAtMs = at;
      this.pauseCount += 1;
    }
    return ok;
  }

  /**
   * Resume a paused session. Legal only from `paused`. Returns
   * true on success.
   */
  resume(reason = ''): boolean {
    if (this.state !== 'paused') {
      this.record(this.state, this.state, `Resume refused: session is ${this.state}`);
      return false;
    }
    const at = this.nowMs();
    this.totalPausedMs += at - this.pausedAtMs;
    this.pausedAtMs = 0;
    return this.transition('running', reason === '' ? 'Session resumed' : reason);
  }

  /**
   * Stop the session for good. Legal from `created`, `running`
   * and `paused`. Terminal: no transition out of `stopped`.
   */
  stop(reason = '', endReason: SandboxV3EndReason = 'killed'): boolean {
    if (isTerminalState(this.state)) return false;
    if (this.state === 'paused') {
      this.totalPausedMs += this.nowMs() - this.pausedAtMs;
      this.pausedAtMs = 0;
    }
    const ok = this.transition('stopped', reason === '' ? 'Session stopped' : reason);
    if (ok) {
      this.endReason = endReason;
      this.endedAtMs = this.nowMs();
    }
    return ok;
  }

  /**
   * Expire the session (lifetime cap, or a pause that ran too
   * long). Legal from `created`, `running` and `paused`. Terminal.
   */
  expire(reason = '', endReason: SandboxV3EndReason = 'lifetime-cap'): boolean {
    if (isTerminalState(this.state)) return false;
    if (this.state === 'paused') {
      this.totalPausedMs += this.nowMs() - this.pausedAtMs;
      this.pausedAtMs = 0;
    }
    const ok = this.transition('expired', reason === '' ? 'Session expired' : reason);
    if (ok) {
      this.endReason = endReason;
      this.endedAtMs = this.nowMs();
    }
    return ok;
  }

  /**
   * Evaluate the pause timer: when the current pause has outlived
   * `maxPauseMs`, expire the session with `paused-timeout` and
   * return true. Otherwise return false.
   */
  evaluatePauseExpiry(now?: number): boolean {
    if (!this.isPauseExpired(now)) return false;
    this.expire('Pause exceeded the maximum pause duration', 'auto-stopped');
    return true;
  }

  /** Summarise the lifecycle for a session report. */
  describe(now?: number): {
    state: SandboxV3SessionState;
    pausedAtMs: number;
    pauseRemainingMs: number;
    totalPausedMs: number;
    pauseCount: number;
    endReason?: SandboxV3EndReason;
    endedAtMs: number;
    transitions: number;
  } {
    return {
      state: this.state,
      pausedAtMs: this.pausedAtMs,
      pauseRemainingMs: this.pauseRemainingMs(now),
      totalPausedMs: this.getTotalPausedMs(),
      pauseCount: this.pauseCount,
      ...(this.endReason !== undefined ? { endReason: this.endReason } : {}),
      endedAtMs: this.endedAtMs,
      transitions: this.events.length,
    };
  }

  private transition(to: SandboxV3SessionState, reason: string): boolean {
    if (!canTransition(this.state, to)) {
      this.record(this.state, this.state, `Illegal transition ${this.state} → ${to} refused`);
      return false;
    }
    const from = this.state;
    this.state = to;
    this.record(from, to, reason);
    return true;
  }

  private record(
    from: SandboxV3SessionState,
    to: SandboxV3SessionState,
    reason: string,
  ): void {
    this.events.push({ atMs: this.nowMs(), from, to, reason });
  }
}

/**
 * Registry of live lifecycle controllers, keyed by session id.
 * The runner keeps one; the tools resolve a session through it.
 * Controllers are removed when their session reaches a terminal
 * state and the report has been read (explicit `remove`).
 */
export class LifecycleRegistry {
  private readonly controllers = new Map<string, LifecycleController>();

  /** Register a controller (throws when the id already exists). */
  add(sessionId: string, controller: LifecycleController): void {
    if (this.controllers.has(sessionId)) {
      throw new Error(`Lifecycle controller already registered for session "${sessionId}"`);
    }
    this.controllers.set(sessionId, controller);
  }

  /** Resolve a controller, or undefined when unknown. */
  get(sessionId: string): LifecycleController | undefined {
    return this.controllers.get(sessionId);
  }

  /** True when a controller exists for the session. */
  has(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  /** Remove a controller. Returns true when one existed. */
  remove(sessionId: string): boolean {
    return this.controllers.delete(sessionId);
  }

  /** Session ids currently registered. */
  ids(): string[] {
    return [...this.controllers.keys()];
  }

  /** Number of registered controllers. */
  size(): number {
    return this.controllers.size;
  }

  /** States of all registered sessions (for list endpoints). */
  states(): Array<{ sessionId: string; state: SandboxV3SessionState }> {
    return [...this.controllers.entries()].map(([sessionId, controller]) => ({
      sessionId,
      state: controller.getState(),
    }));
  }

  /**
   * Evaluate pause expiry for every registered session. Returns
   * the ids that expired in this pass.
   */
  evaluateAllPauseExpiries(now?: number): string[] {
    const expired: string[] = [];
    for (const [sessionId, controller] of this.controllers) {
      if (controller.evaluatePauseExpiry(now)) expired.push(sessionId);
    }
    return expired;
  }

  /** Remove every controller in a terminal state. Returns ids removed. */
  pruneTerminated(): string[] {
    const removed: string[] = [];
    for (const [sessionId, controller] of this.controllers) {
      if (controller.isTerminal()) {
        this.controllers.delete(sessionId);
        removed.push(sessionId);
      }
    }
    return removed;
  }
}
