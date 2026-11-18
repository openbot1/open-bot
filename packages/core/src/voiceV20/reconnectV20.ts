/**
 * Reconnect + error handling v20 (voice v20, v1.28 Team T5).
 *
 * A realtime call fails in a handful of recognisable ways, and each
 * one wants a different response: a transient timeout is worth one
 * quick retry, a rate limit wants a patient backoff, an auth failure
 * is never worth retrying, a disconnect wants a full re-handshake.
 * This module owns that decision table, plus the machinery around
 * it: exponential backoff with jitter (deterministic, seeded, so
 * tests are stable), a circuit breaker that stops hammering a dead
 * provider, and a reconnect state machine that walks
 * idle → connecting → connected → (failed) → backing-off → retrying.
 *
 * Pure decision logic + virtual clock. No network, no key.
 */
import type { ProviderV20FailureMode } from './providersV20';

export type VoiceV20ErrorKind =
  | 'timeout'
  | 'rate-limited'
  | 'bad-audio'
  | 'auth'
  | 'overloaded'
  | 'disconnected'
  | 'provider-down'
  | 'no-provider'
  | 'protocol'
  | 'unknown';

export type VoiceV20ErrorAction = 'retry-now' | 'retry-backed-off' | 'failover' | 'abort' | 'ignore';

export interface VoiceV20Error {
  kind: VoiceV20ErrorKind;
  message: string;
  atMs: number;
  /** True when the error came from the provider side (not our bug). */
  providerSide: boolean;
  /** How many times this error has already been retried. */
  attempt: number;
  cause?: string;
}

/** Map a provider failure mode onto the error taxonomy. */
export function errorKindFromFailureModeV20(mode: ProviderV20FailureMode): VoiceV20ErrorKind {
  switch (mode) {
    case 'timeout': return 'timeout';
    case 'rate-limited': return 'rate-limited';
    case 'bad-audio': return 'bad-audio';
    case 'auth': return 'auth';
    case 'overloaded': return 'overloaded';
    case 'disconnected': return 'disconnected';
    default: return 'unknown';
  }
}

export function makeVoiceV20Error(
  kind: VoiceV20ErrorKind,
  message: string,
  atMs: number,
  attempt = 0,
  providerSide = true,
  cause?: string,
): VoiceV20Error {
  return { kind, message, atMs, providerSide, attempt, cause };
}

export interface ReconnectV20Options {
  /** Max retries for a retryable error before giving up. */
  maxRetries: number;
  /** First backoff delay, in ms. */
  baseDelayMs: number;
  /** Backoff multiplier per attempt. */
  backoffFactor: number;
  /** Backoff never exceeds this, in ms. */
  maxDelayMs: number;
  /** Jitter fraction 0..1 applied deterministically (seeded). */
  jitterFraction: number;
  /** Failures in a row that open the circuit breaker. */
  breakerOpenAfter: number;
  /** How long the breaker stays open before a half-open probe, in ms. */
  breakerOpenMs: number;
  /** Consecutive successes that close a half-open breaker. */
  breakerCloseAfter: number;
}

export function defaultReconnectV20Options(): ReconnectV20Options {
  return {
    maxRetries: 5,
    baseDelayMs: 250,
    backoffFactor: 2,
    maxDelayMs: 30000,
    jitterFraction: 0.2,
    breakerOpenAfter: 5,
    breakerOpenMs: 10000,
    breakerCloseAfter: 2,
  };
}

export function validateReconnectV20Options(o: Partial<ReconnectV20Options>): string[] {
  const e: string[] = [];
  if (o.maxRetries !== undefined && o.maxRetries < 0) e.push('maxRetries must be >= 0');
  if (o.baseDelayMs !== undefined && o.baseDelayMs < 0) e.push('baseDelayMs must be >= 0');
  if (o.backoffFactor !== undefined && o.backoffFactor < 1) e.push('backoffFactor must be >= 1');
  if (o.maxDelayMs !== undefined && o.maxDelayMs < 0) e.push('maxDelayMs must be >= 0');
  if (o.baseDelayMs !== undefined && o.maxDelayMs !== undefined && o.maxDelayMs < o.baseDelayMs) {
    e.push('maxDelayMs must be >= baseDelayMs');
  }
  if (o.jitterFraction !== undefined && (o.jitterFraction < 0 || o.jitterFraction > 1)) e.push('jitterFraction must be 0..1');
  if (o.breakerOpenAfter !== undefined && o.breakerOpenAfter < 1) e.push('breakerOpenAfter must be >= 1');
  if (o.breakerOpenMs !== undefined && o.breakerOpenMs < 0) e.push('breakerOpenMs must be >= 0');
  if (o.breakerCloseAfter !== undefined && o.breakerCloseAfter < 1) e.push('breakerCloseAfter must be >= 1');
  return e;
}

/**
 * What to do about an error, given how many times it has already
 * been retried. The table is the contract: auth and protocol errors
 * never retry; bad audio is ignored (one bad frame is not a call
 * failure); timeouts retry immediately once, then back off; rate
 * limits and overloads always back off; disconnects fail over to
 * another provider.
 */
export function decideErrorActionV20(err: VoiceV20Error, maxRetries: number): VoiceV20ErrorAction {
  if (err.attempt >= maxRetries) return 'abort';
  switch (err.kind) {
    case 'auth':
    case 'protocol':
      return 'abort';
    case 'bad-audio':
      return 'ignore';
    case 'timeout':
      return err.attempt === 0 ? 'retry-now' : 'retry-backed-off';
    case 'rate-limited':
    case 'overloaded':
      return 'retry-backed-off';
    case 'disconnected':
    case 'provider-down':
    case 'no-provider':
      return 'failover';
    case 'unknown':
    default:
      return 'retry-backed-off';
  }
}

/**
 * Deterministic backoff delay for an attempt (0-based): base *
 * factor^attempt, capped, with a seeded jitter so repeated runs
 * agree. The seed is the attempt number mixed with a fixed salt,
 * so the same attempt always yields the same delay.
 */
export function backoffDelayMsV20(o: ReconnectV20Options, attempt: number): number {
  const raw = o.baseDelayMs * Math.pow(o.backoffFactor, Math.max(0, attempt));
  const capped = Math.min(raw, o.maxDelayMs);
  if (o.jitterFraction <= 0) return Math.round(capped);
  // Deterministic pseudo-random in [0, 1) from the attempt number.
  const seed = (attempt * 2654435761 + 40503) >>> 0;
  const rand = ((seed ^ (seed >>> 15)) >>> 0) / 4294967296;
  const jitter = 1 - o.jitterFraction + rand * o.jitterFraction * 2;
  return Math.round(Math.min(capped * jitter, o.maxDelayMs));
}

export type CircuitBreakerV20State = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerV20Stats {
  state: CircuitBreakerV20State;
  failures: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedCount: number;
  rejectedWhileOpen: number;
  openedAtMs: number | null;
}

/**
 * Circuit breaker: after N consecutive failures the breaker opens
 * and calls are rejected immediately (no hammering); after the open
 * window it goes half-open and lets one probe through; enough
 * consecutive probe successes close it again, a failure re-opens it.
 */
export class CircuitBreakerV20 {
  private opts: ReconnectV20Options;
  private state: CircuitBreakerV20State = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private failures = 0;
  private openedCount = 0;
  private rejectedWhileOpen = 0;
  private openedAtMs: number | null = null;

  constructor(opts: Partial<ReconnectV20Options> = {}) {
    this.opts = { ...defaultReconnectV20Options(), ...opts };
  }

  get currentState(): CircuitBreakerV20State {
    return this.state;
  }

  /** True when a call may proceed at `nowMs` (advances open → half-open when due). */
  allowCall(nowMs: number): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.openedAtMs !== null && nowMs - this.openedAtMs >= this.opts.breakerOpenMs) {
        this.state = 'half-open';
        this.consecutiveSuccesses = 0;
        return true;
      }
      this.rejectedWhileOpen += 1;
      return false;
    }
    return true; // half-open: the probe is allowed
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'half-open') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.opts.breakerCloseAfter) {
        this.state = 'closed';
        this.consecutiveSuccesses = 0;
        this.openedAtMs = null;
      }
    } else if (this.state === 'closed') {
      this.consecutiveSuccesses = 0;
    }
  }

  recordFailure(nowMs: number): void {
    this.failures += 1;
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    if (this.state === 'half-open') {
      this.open();
      this.openedAtMs = nowMs;
      return;
    }
    if (this.state === 'closed' && this.consecutiveFailures >= this.opts.breakerOpenAfter) {
      this.open();
      this.openedAtMs = nowMs;
    }
  }

  private open(): void {
    this.state = 'open';
    this.openedCount += 1;
  }

  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.failures = 0;
    this.openedCount = 0;
    this.rejectedWhileOpen = 0;
    this.openedAtMs = null;
  }

  getStats(): CircuitBreakerV20Stats {
    return {
      state: this.state,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      openedCount: this.openedCount,
      rejectedWhileOpen: this.rejectedWhileOpen,
      openedAtMs: this.openedAtMs,
    };
  }
}

export type ReconnectV20Phase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'backing-off'
  | 'retrying'
  | 'failed';

export interface ReconnectV20Stats {
  phase: ReconnectV20Phase;
  attempts: number;
  retries: number;
  failovers: number;
  errors: number;
  lastErrorKind: VoiceV20ErrorKind | null;
  nextRetryAtMs: number | null;
  totalBackoffMs: number;
}

export type ReconnectV20EventKind =
  | 'phase'
  | 'error'
  | 'retry-scheduled'
  | 'failover-requested'
  | 'aborted';
export type ReconnectV20Event = {
  kind: ReconnectV20EventKind;
  atMs: number;
  detail?: Record<string, unknown>;
};
export type ReconnectV20EventSink = (event: ReconnectV20Event) => void;

/**
 * Reconnect state machine for one realtime connection. Feeds on
 * errors, decides the action via the table, schedules retries with
 * backoff, and asks for failover when the provider itself is the
 * problem. The circuit breaker gates every retry attempt.
 */
export class ReconnectManagerV20 {
  private opts: ReconnectV20Options;
  private sink?: ReconnectV20EventSink;
  private breaker: CircuitBreakerV20;
  private phase: ReconnectV20Phase = 'idle';
  private attempts = 0;
  private retries = 0;
  private failovers = 0;
  private errors = 0;
  private lastErrorKind: VoiceV20ErrorKind | null = null;
  private nextRetryAtMs: number | null = null;
  private totalBackoffMs = 0;

  constructor(opts: Partial<ReconnectV20Options> = {}, sink?: ReconnectV20EventSink) {
    this.opts = { ...defaultReconnectV20Options(), ...opts };
    this.sink = sink;
    this.breaker = new CircuitBreakerV20(this.opts);
  }

  get currentPhase(): ReconnectV20Phase { return this.phase; }
  get circuitBreaker(): CircuitBreakerV20 { return this.breaker; }

  connect(atMs: number): void {
    this.phase = 'connecting';
    this.attempts += 1;
    this.sink?.({ kind: 'phase', atMs, detail: { phase: 'connecting', attempt: this.attempts } });
  }

  connected(atMs: number): void {
    this.phase = 'connected';
    this.nextRetryAtMs = null;
    this.breaker.recordSuccess();
    this.sink?.({ kind: 'phase', atMs, detail: { phase: 'connected' } });
  }

  /**
   * Handle an error. Returns the action the caller should take and,
   * for backed-off retries, the virtual time of the next attempt.
   */
  handleError(err: VoiceV20Error): { action: VoiceV20ErrorAction; retryAtMs: number | null } {
    this.errors += 1;
    this.lastErrorKind = err.kind;
    this.breaker.recordFailure(err.atMs);
    this.sink?.({ kind: 'error', atMs: err.atMs, detail: { kind: err.kind, attempt: err.attempt, message: err.message } });
    const action = decideErrorActionV20(err, this.opts.maxRetries);
    if (action === 'ignore') return { action, retryAtMs: null };
    if (action === 'abort') {
      this.phase = 'failed';
      this.nextRetryAtMs = null;
      this.sink?.({ kind: 'aborted', atMs: err.atMs, detail: { kind: err.kind, attempt: err.attempt } });
      return { action, retryAtMs: null };
    }
    if (action === 'failover') {
      this.failovers += 1;
      this.phase = 'backing-off';
      const delay = backoffDelayMsV20(this.opts, err.attempt);
      this.totalBackoffMs += delay;
      this.nextRetryAtMs = err.atMs + delay;
      this.sink?.({ kind: 'failover-requested', atMs: err.atMs, detail: { kind: err.kind, retryAtMs: this.nextRetryAtMs } });
      return { action, retryAtMs: this.nextRetryAtMs };
    }
    if (action === 'retry-now') {
      if (!this.breaker.allowCall(err.atMs)) {
        this.phase = 'backing-off';
        this.nextRetryAtMs = err.atMs + this.opts.breakerOpenMs;
        return { action: 'retry-backed-off', retryAtMs: this.nextRetryAtMs };
      }
      this.retries += 1;
      this.phase = 'retrying';
      return { action, retryAtMs: err.atMs };
    }
    // retry-backed-off
    this.retries += 1;
    this.phase = 'backing-off';
    const delay = backoffDelayMsV20(this.opts, err.attempt);
    this.totalBackoffMs += delay;
    this.nextRetryAtMs = err.atMs + delay;
    this.sink?.({ kind: 'retry-scheduled', atMs: err.atMs, detail: { kind: err.kind, attempt: err.attempt, delayMs: delay, retryAtMs: this.nextRetryAtMs } });
    return { action, retryAtMs: this.nextRetryAtMs };
  }

  /** True when a scheduled retry is due at `nowMs` and the breaker allows it. */
  retryDue(nowMs: number): boolean {
    if (this.phase !== 'backing-off' || this.nextRetryAtMs === null) return false;
    if (nowMs < this.nextRetryAtMs) return false;
    return this.breaker.allowCall(nowMs);
  }

  /** The caller is performing the scheduled retry now. */
  startRetry(atMs: number): void {
    this.phase = 'retrying';
    this.attempts += 1;
    this.nextRetryAtMs = null;
    this.sink?.({ kind: 'phase', atMs, detail: { phase: 'retrying', attempt: this.attempts } });
  }

  reset(): void {
    this.phase = 'idle';
    this.attempts = 0;
    this.retries = 0;
    this.failovers = 0;
    this.errors = 0;
    this.lastErrorKind = null;
    this.nextRetryAtMs = null;
    this.totalBackoffMs = 0;
    this.breaker.reset();
  }

  getStats(): ReconnectV20Stats {
    return {
      phase: this.phase,
      attempts: this.attempts,
      retries: this.retries,
      failovers: this.failovers,
      errors: this.errors,
      lastErrorKind: this.lastErrorKind,
      nextRetryAtMs: this.nextRetryAtMs,
      totalBackoffMs: this.totalBackoffMs,
    };
  }
}

export function createReconnectManagerV20(
  opts: Partial<ReconnectV20Options> = {},
  sink?: ReconnectV20EventSink,
): ReconnectManagerV20 {
  return new ReconnectManagerV20(opts, sink);
}

export function reconnectV20Summary(m: ReconnectManagerV20): string {
  const s = m.getStats();
  return `Reconnect v20: phase ${s.phase}, ${s.attempts} attempts, ${s.retries} retries, ` +
    `${s.failovers} failovers, ${s.errors} errors, last ${s.lastErrorKind ?? 'none'}, ` +
    `breaker ${m.circuitBreaker.currentState}`;
}

export function reconnectV20Markdown(m: ReconnectManagerV20): string {
  const s = m.getStats();
  return `# Reconnect v20\n\n- Phase: ${s.phase}\n- Attempts: ${s.attempts}\n- Retries: ${s.retries}\n` +
    `- Failovers: ${s.failovers}\n- Errors: ${s.errors}\n- Last error: ${s.lastErrorKind ?? 'none'}\n` +
    `- Next retry at: ${s.nextRetryAtMs ?? 'none'}\n- Total backoff: ${s.totalBackoffMs}ms\n` +
    `- Circuit breaker: ${m.circuitBreaker.currentState}\n`;
}
