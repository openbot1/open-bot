/**
 * Sandbox v2 — kill switch + lifetime cap (v1.34, Đội T2).
 *
 * One KillSwitch per run. It can fire from four sources:
 *  - `ui` — the user pressed Kill in the UI.
 *  - `policy` — a policy violation tripped it (e.g. a dangerous
 *    syscall attempt while the policy says "kill on violation").
 *  - `timeout` — the run exceeded its per-run timeout.
 *  - `manual` — host code / an operator tripped it.
 *  - `lifetime-cap` — the run hit its maximum lifetime (the cap
 *    itself is enforced by LifetimeCap below).
 *
 * Once fired, the switch stays fired: `trip()` after the first fire
 * is a no-op that returns the ORIGINAL source (so the run report
 * always names the first cause, not the loudest one). `reset()` is
 * only for reuse of the object in tests — production code creates
 * one switch per run and never resets it.
 *
 * Cleanup: the switch owns a registry of cleanup callbacks
 * (kill process group, delete temp dir, revoke tokens, close the
 * gate). `runCleanup()` runs every callback exactly once, in
 * reverse registration order, collecting errors instead of throwing
 * on the first one — a failing cleanup must never hide the kill.
 *
 * LifetimeCap is the wall-clock watchdog: created with a cap in ms,
 * it fires the switch when the deadline passes. The runner polls it;
 * it never spawns its own timer thread that could outlive the run
 * (the runner owns the timer and passes the switch in).
 */

import { SandboxV2KilledError } from './types';
import type { SandboxV2KillSource } from './types';

/** A registered cleanup callback. Errors are collected, never thrown. */
export type SandboxV2CleanupFn = () => void | Promise<void>;

/** One cleanup result (for the run report). */
export interface SandboxV2CleanupResult {
  /** Label given at registration. */
  label: string;
  /** True when the callback ran without throwing. */
  ok: boolean;
  /** Error message when it threw (undefined when ok). */
  error?: string;
}

/** Options for a kill switch. */
export interface KillSwitchOptions {
  /** Run id the switch belongs to (for error messages + reports). */
  runId: string;
  /** Called exactly once, on the first trip (before cleanup runs). */
  onTrip?: (source: SandboxV2KillSource, reason: string) => void;
}

/**
 * Kill switch for one run. Synchronous trip (safe to call from a
 * signal handler, a policy callback or a timeout): listeners run
 * synchronously, cleanup runs async via `runCleanup()`.
 */
export class KillSwitch {
  readonly runId: string;
  private fired = false;
  private fireSource?: SandboxV2KillSource;
  private fireReason = '';
  private firedAtMs?: number;
  private readonly listeners = new Set<(source: SandboxV2KillSource, reason: string) => void>();
  private readonly cleanups: Array<{ label: string; fn: SandboxV2CleanupFn }> = [];
  private cleanupDone = false;
  private readonly onTrip?: KillSwitchOptions['onTrip'];

  constructor(options: KillSwitchOptions) {
    this.runId = options.runId;
    this.onTrip = options.onTrip;
  }

  /** True after the first trip, forever (until reset). */
  get isFired(): boolean {
    return this.fired;
  }

  /** Source of the first trip (undefined while unfired). */
  get source(): SandboxV2KillSource | undefined {
    return this.fireSource;
  }

  /** Human-readable reason of the first trip. */
  get reason(): string {
    return this.fireReason;
  }

  /** Epoch ms of the first trip (undefined while unfired). */
  get firedAt(): number | undefined {
    return this.firedAtMs;
  }

  /**
   * Trip the switch. First trip wins; later trips return false and
   * change nothing. Listeners + onTrip run synchronously so the
   * caller can kill the child process in the same tick.
   */
  trip(source: SandboxV2KillSource, reason: string): boolean {
    if (this.fired) return false;
    this.fired = true;
    this.fireSource = source;
    this.fireReason = reason;
    this.firedAtMs = Date.now();
    for (const listener of [...this.listeners]) {
      try {
        listener(source, reason);
      } catch {
        // A listener must never break the kill path.
      }
    }
    try {
      this.onTrip?.(source, reason);
    } catch {
      // Same: the kill path never throws.
    }
    return true;
  }

  /** Subscribe to the trip (runs synchronously on trip). Returns an unsubscribe fn. */
  onTripped(listener: (source: SandboxV2KillSource, reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Throw a SandboxV2KilledError when fired (checked before each tool call / step). */
  throwIfFired(): void {
    if (this.fired) {
      throw new SandboxV2KilledError(
        `Run ${this.runId} was killed (${this.fireSource ?? 'unknown'}): ${this.fireReason}`,
        this.fireSource ?? 'manual',
      );
    }
  }

  /** Register a cleanup callback (runs in reverse order at kill time). */
  registerCleanup(label: string, fn: SandboxV2CleanupFn): void {
    this.cleanups.push({ label, fn });
  }

  /** Number of registered cleanup callbacks. */
  cleanupCount(): number {
    return this.cleanups.length;
  }

  /**
   * Run every cleanup callback exactly once (reverse registration
   * order). Safe to call twice — the second call is a no-op.
   * Never throws; per-callback errors are returned.
   */
  async runCleanup(): Promise<SandboxV2CleanupResult[]> {
    if (this.cleanupDone) return [];
    this.cleanupDone = true;
    const results: SandboxV2CleanupResult[] = [];
    for (const { label, fn } of [...this.cleanups].reverse()) {
      try {
        await fn();
        results.push({ label, ok: true });
      } catch (err) {
        results.push({ label, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /** Test-only reuse: clear the fired state (production code never calls this). */
  reset(): void {
    this.fired = false;
    this.fireSource = undefined;
    this.fireReason = '';
    this.firedAtMs = undefined;
    this.cleanupDone = false;
  }
}

/** Options for the lifetime watchdog. */
export interface LifetimeCapOptions {
  /** Run id (for messages). */
  runId: string;
  /** Max lifetime, ms. Must be positive. */
  maxLifetimeMs: number;
  /** Kill switch to trip when the cap is hit. */
  killSwitch: KillSwitch;
  /** Clock override for tests. */
  nowFn?: () => number;
}

/**
 * Lifetime watchdog. `check()` returns true while the run is inside
 * its lifetime; on the first check past the deadline it trips the
 * kill switch with source `lifetime-cap` and returns false. The
 * runner calls `check()` on a timer and before each step — the cap
 * is wall-clock, so a runaway child cannot dodge it by being busy.
 */
export class LifetimeCap {
  readonly runId: string;
  readonly maxLifetimeMs: number;
  private readonly killSwitch: KillSwitch;
  private readonly nowFn: () => number;
  private readonly startedAtMs: number;
  private tripped = false;

  constructor(options: LifetimeCapOptions) {
    if (options.maxLifetimeMs <= 0) {
      throw new Error('maxLifetimeMs must be positive');
    }
    this.runId = options.runId;
    this.maxLifetimeMs = options.maxLifetimeMs;
    this.killSwitch = options.killSwitch;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.startedAtMs = this.nowFn();
  }

  /** Epoch ms the run started (cap clock). */
  get startedAt(): number {
    return this.startedAtMs;
  }

  /** Absolute deadline, epoch ms. */
  get deadlineMs(): number {
    return this.startedAtMs + this.maxLifetimeMs;
  }

  /** Ms remaining until the deadline (negative when over). */
  remainingMs(nowMs: number = this.nowFn()): number {
    return this.deadlineMs - nowMs;
  }

  /** True when the deadline has passed (does not trip the switch by itself). */
  isExpired(nowMs: number = this.nowFn()): boolean {
    return nowMs >= this.deadlineMs;
  }

  /**
   * Check the cap now. Returns false + trips the kill switch on the
   * first expired check; returns true while inside the lifetime.
   */
  check(nowMs: number = this.nowFn()): boolean {
    if (this.isExpired(nowMs)) {
      if (!this.tripped) {
        this.tripped = true;
        this.killSwitch.trip(
          'lifetime-cap',
          `Run ${this.runId} hit its lifetime cap of ${this.maxLifetimeMs}ms`,
        );
      }
      return false;
    }
    return true;
  }
}

/** Convenience: trip a switch from an AbortSignal (UI cancel / caller abort). */
export function linkAbortSignalToKillSwitch(signal: AbortSignal, killSwitch: KillSwitch): () => void {
  const onAbort = (): void => {
    killSwitch.trip('manual', 'AbortSignal fired (caller cancelled the run)');
  };
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
  };
}
