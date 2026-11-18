/**
 * Sandbox v3 — lifetime cap + auto-stop (v1.35, Team T2).
 *
 * A sandbox v3 session never lives forever. Every session gets a
 * hard deadline at creation time; when the wall clock passes it the
 * session stops itself (`lifetime-cap`), no operator action needed.
 * Two softer mechanisms sit in front of the hard cap:
 *
 *  - Grace window: when the deadline passes while a step is still
 *    running, the step gets a short grace period to finish cleanly
 *    (flush output, close files). A step that outlives the grace
 *    window is killed, not left running.
 *  - Heartbeat / idle auto-stop: a session that hears nothing from
 *    its owner for `idleTimeoutMs` is auto-stopped (`auto-stopped`),
 *    so abandoned sessions do not hold a workspace, a port or a
 *    budget forever. Every heartbeat resets the idle clock; every
 *    completed step counts as a heartbeat.
 *
 * Time source is injectable (`nowMs`) so tests can move the clock
 * without waiting. All decisions are pure functions of the clock:
 * given the same `nowMs`, the same cap always gives the same answer.
 * The cap can be shortened at any time; it can only be extended up
 * to the policy maximum, and every extension is recorded so the
 * report shows the session did not silently outlive its budget.
 */

import type { SandboxV3EndReason } from './types';

/** Default session lifetime: 30 minutes. */
export const SANDBOX_V3_DEFAULT_LIFETIME_MS = 30 * 60 * 1000;

/** Hard maximum lifetime for any session: 4 hours. */
export const SANDBOX_V3_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;

/** Default grace window after the deadline for an in-flight step. */
export const SANDBOX_V3_DEFAULT_GRACE_MS = 10_000;

/** Default idle timeout: 10 minutes without a heartbeat. */
export const SANDBOX_V3_DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Maximum idle timeout a policy may set: 1 hour. */
export const SANDBOX_V3_MAX_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Minimum lifetime a session may be created with: 1 minute. */
export const SANDBOX_V3_MIN_LIFETIME_MS = 60 * 1000;

/** Why the auto-stop fired (stable strings for reports). */
export type SandboxV3AutoStopCause =
  | 'lifetime-cap'
  | 'grace-expired'
  | 'idle-timeout'
  | 'manual';

/** One recorded lifetime event (extension, heartbeat loss, stop). */
export interface SandboxV3LifetimeEvent {
  /** When it happened (ms since epoch). */
  atMs: number;
  /** What happened. */
  kind: 'created' | 'extended' | 'shortened' | 'heartbeat' | 'grace-entered' | 'auto-stopped';
  /** Human-readable detail. */
  detail: string;
  /** Deadline after the event (ms since epoch). */
  deadlineMs: number;
}

/** Options for building a lifetime cap. */
export interface SandboxV3LifetimeCapOptions {
  /** Lifetime in ms from `startedAtMs`. Clamped to [min, max]. */
  lifetimeMs?: number;
  /** Grace window after the deadline for an in-flight step. */
  graceMs?: number;
  /** Idle timeout; 0 disables idle auto-stop. */
  idleTimeoutMs?: number;
  /** When the session started (ms since epoch). Default `Date.now()`. */
  startedAtMs?: number;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

/**
 * A session's lifetime cap. One instance per session; the runner
 * owns it and asks it before every step whether the session may
 * still run.
 */
export class SandboxV3LifetimeCap {
  private readonly startedAtMs: number;
  private deadlineMs: number;
  private readonly graceMs: number;
  private readonly idleTimeoutMs: number;
  private readonly nowMs: () => number;
  private lastHeartbeatMs: number;
  private graceEnteredAtMs = 0;
  private stopped = false;
  private stopCause: SandboxV3AutoStopCause | undefined;
  private readonly events: SandboxV3LifetimeEvent[] = [];

  constructor(options: SandboxV3LifetimeCapOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.startedAtMs = options.startedAtMs ?? this.nowMs();
    const lifetime = clampLifetime(options.lifetimeMs ?? SANDBOX_V3_DEFAULT_LIFETIME_MS);
    this.deadlineMs = this.startedAtMs + lifetime;
    this.graceMs = Math.max(0, options.graceMs ?? SANDBOX_V3_DEFAULT_GRACE_MS);
    const idle = options.idleTimeoutMs ?? SANDBOX_V3_DEFAULT_IDLE_TIMEOUT_MS;
    this.idleTimeoutMs = idle === 0 ? 0 : Math.min(Math.max(idle, 1000), SANDBOX_V3_MAX_IDLE_TIMEOUT_MS);
    this.lastHeartbeatMs = this.startedAtMs;
    this.record('created', `Lifetime ${lifetime}ms, deadline ${this.deadlineMs}, grace ${this.graceMs}ms, idle ${this.idleTimeoutMs}ms`);
  }

  /** When the session started. */
  getStartedAtMs(): number {
    return this.startedAtMs;
  }

  /** Current hard deadline (ms since epoch). */
  getDeadlineMs(): number {
    return this.deadlineMs;
  }

  /** Grace window in ms. */
  getGraceMs(): number {
    return this.graceMs;
  }

  /** Idle timeout in ms (0 = disabled). */
  getIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  /** Last heartbeat time (ms since epoch). */
  getLastHeartbeatMs(): number {
    return this.lastHeartbeatMs;
  }

  /** True once the cap has fired and the session is stopped. */
  isStopped(): boolean {
    return this.stopped;
  }

  /** Why the cap stopped the session (undefined while live). */
  getStopCause(): SandboxV3AutoStopCause | undefined {
    return this.stopCause;
  }

  /** Milliseconds left until the deadline (negative when past). */
  remainingMs(now?: number): number {
    return this.deadlineMs - (now ?? this.nowMs());
  }

  /** True when the wall clock has passed the deadline. */
  isExpired(now?: number): boolean {
    return this.remainingMs(now) <= 0;
  }

  /** Milliseconds left in the grace window (0 when not in grace). */
  graceRemainingMs(now?: number): number {
    const at = now ?? this.nowMs();
    if (this.graceEnteredAtMs === 0) return this.graceMs;
    return Math.max(0, this.graceEnteredAtMs + this.graceMs - at);
  }

  /** True when the session is inside the grace window. */
  inGrace(now?: number): boolean {
    const at = now ?? this.nowMs();
    return this.isExpired(at) && this.graceRemainingMs(at) > 0 && !this.stopped;
  }

  /**
   * True when a new step may start. A step may start only while the
   * session is live and the deadline has not passed; the grace
   * window lets an in-flight step FINISH, it never lets a new step
   * START.
   */
  mayStartStep(now?: number): boolean {
    return !this.stopped && !this.isExpired(now);
  }

  /** Record a heartbeat (owner activity, or a completed step). */
  heartbeat(now?: number): void {
    const at = now ?? this.nowMs();
    this.lastHeartbeatMs = at;
    this.record('heartbeat', `Heartbeat at ${at}`);
  }

  /** Milliseconds since the last heartbeat. */
  idleMs(now?: number): number {
    return (now ?? this.nowMs()) - this.lastHeartbeatMs;
  }

  /** True when the idle timeout has passed without a heartbeat. */
  isIdleExpired(now?: number): boolean {
    if (this.idleTimeoutMs === 0) return false;
    return this.idleMs(now) >= this.idleTimeoutMs;
  }

  /**
   * Shorten the deadline (always allowed) or extend it (clamped to
   * the hard maximum lifetime from session start — never past it).
   * Returns the new deadline. The minimum lifetime clamps creation
   * only, never an operator shorten.
   */
  setLifetime(lifetimeMs: number, reason = ''): number {
    const now = this.nowMs();
    if (this.stopped) return this.deadlineMs;
    const ms = Number.isFinite(lifetimeMs)
      ? Math.floor(lifetimeMs)
      : SANDBOX_V3_DEFAULT_LIFETIME_MS;
    const requested = this.startedAtMs + Math.max(0, Math.min(ms, SANDBOX_V3_MAX_LIFETIME_MS));
    const previous = this.deadlineMs;
    this.deadlineMs = requested;
    if (requested > previous) {
      this.record('extended', `Lifetime extended to ${requested - this.startedAtMs}ms${reason !== '' ? ` (${reason})` : ''}`);
    } else if (requested < previous) {
      this.record('shortened', `Lifetime shortened to ${requested - this.startedAtMs}ms${reason !== '' ? ` (${reason})` : ''}`);
    }
    void now;
    return this.deadlineMs;
  }

  /**
   * Enter the grace window (called by the runner when the deadline
   * passes mid-step). Returns true on the first entry, false when
   * already in grace.
   */
  enterGrace(now?: number): boolean {
    const at = now ?? this.nowMs();
    if (this.graceEnteredAtMs !== 0) return false;
    this.graceEnteredAtMs = at;
    this.record('grace-entered', `Deadline passed at ${at}; grace ${this.graceMs}ms`);
    return true;
  }

  /**
   * Evaluate whether the session must auto-stop right now. Returns
   * the cause, or undefined when the session may continue. The
   * order is deliberate: an expired grace window beats an idle
   * timeout (the deadline is the harder limit), and idle beats
   * nothing else. Calling this with an expired deadline and no
   * in-flight step stops the session immediately.
   */
  evaluateAutoStop(now?: number, stepInFlight = false): SandboxV3AutoStopCause | undefined {
    const at = now ?? this.nowMs();
    if (this.stopped) return this.stopCause;
    if (this.isExpired(at)) {
      if (!stepInFlight) {
        return this.stop('lifetime-cap', at);
      }
      if (this.graceEnteredAtMs === 0) this.enterGrace(at);
      if (this.graceRemainingMs(at) <= 0) {
        return this.stop('grace-expired', at);
      }
      return undefined;
    }
    if (this.isIdleExpired(at)) {
      return this.stop('idle-timeout', at);
    }
    return undefined;
  }

  /**
   * Stop the session now for a manual cause (operator / UI).
   * Returns the cause recorded.
   */
  manualStop(now?: number): SandboxV3AutoStopCause {
    return this.stop('manual', now ?? this.nowMs());
  }

  /** Lifetime events, in order (for the session report). */
  lifetimeEvents(): SandboxV3LifetimeEvent[] {
    return [...this.events];
  }

  /** Map the stop cause onto a session end reason. */
  endReason(): SandboxV3EndReason | undefined {
    if (!this.stopped || !this.stopCause) return undefined;
    switch (this.stopCause) {
      case 'lifetime-cap':
      case 'grace-expired':
        return 'lifetime-cap';
      case 'idle-timeout':
        return 'auto-stopped';
      case 'manual':
        return 'killed';
      default:
        return 'auto-stopped';
    }
  }

  /** Summarise the cap for a session report. */
  describe(now?: number): {
    startedAtMs: number;
    deadlineMs: number;
    remainingMs: number;
    graceMs: number;
    idleTimeoutMs: number;
    idleMs: number;
    stopped: boolean;
    stopCause?: SandboxV3AutoStopCause;
    events: number;
  } {
    const at = now ?? this.nowMs();
    return {
      startedAtMs: this.startedAtMs,
      deadlineMs: this.deadlineMs,
      remainingMs: this.remainingMs(at),
      graceMs: this.graceMs,
      idleTimeoutMs: this.idleTimeoutMs,
      idleMs: this.idleMs(at),
      stopped: this.stopped,
      ...(this.stopCause !== undefined ? { stopCause: this.stopCause } : {}),
      events: this.events.length,
    };
  }

  private stop(cause: SandboxV3AutoStopCause, at: number): SandboxV3AutoStopCause {
    if (!this.stopped) {
      this.stopped = true;
      this.stopCause = cause;
      this.record('auto-stopped', `Auto-stopped: ${cause} at ${at}`);
    }
    return cause;
  }

  private record(kind: SandboxV3LifetimeEvent['kind'], detail: string): void {
    this.events.push({
      atMs: this.nowMs(),
      kind,
      detail,
      deadlineMs: this.deadlineMs,
    });
  }
}

/** Clamp a requested lifetime into [min, max]. */
export function clampLifetime(lifetimeMs: number): number {
  if (!Number.isFinite(lifetimeMs)) return SANDBOX_V3_DEFAULT_LIFETIME_MS;
  return Math.min(
    Math.max(Math.floor(lifetimeMs), SANDBOX_V3_MIN_LIFETIME_MS),
    SANDBOX_V3_MAX_LIFETIME_MS,
  );
}

/** Deadline for a session starting at `startedAtMs`. */
export function computeDeadline(startedAtMs: number, lifetimeMs: number): number {
  return startedAtMs + clampLifetime(lifetimeMs);
}

/** Human-readable remaining time, e.g. `12m 30s`, `45s`, `expired`. */
export function formatRemainingMs(remainingMs: number): string {
  if (remainingMs <= 0) return 'expired';
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Pick the effective lifetime for a session from a policy cap and a
 * caller request: the smaller of the two, clamped into [min, max].
 * A caller can never ask for more than the policy allows.
 */
export function effectiveLifetimeMs(requestedMs: number, policyMaxMs: number): number {
  const policyCap = clampLifetime(policyMaxMs);
  const requested = clampLifetime(requestedMs);
  return Math.min(requested, policyCap);
}
