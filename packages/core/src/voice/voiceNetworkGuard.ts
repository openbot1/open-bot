/**
 * Network guard for realtime voice (v1.07, Team T5 — voice v4 + UI).
 *
 * v3/v4 already reconnected after a drop (backoff + jitter in the
 * resilience controller), but they treated every failure the same:
 * a 401 (bad key — retrying never helps) got the same retries as a
 * reset socket (retrying usually helps), and while the transport
 * was down the call had no honest state — the panel kept showing
 * "listening" to a dead socket.
 *
 * This module is the *policy* around a failure, not the socket:
 *
 *   - `classifyVoiceNetworkError()` sorts a failure into a kind
 *     (`timeout` / `reset` / `dns` / `rate-limited` / `auth` /
 *     `server` / `unknown`) and says whether retrying can help.
 *     Auth failures never retry; rate-limit retries after the
 *     server's delay when one is given.
 *   - `VoiceNetworkGuard` counts consecutive failures and decides:
 *     `retry` (backoff delay, capped, deterministic jitter injected
 *     for tests), `degrade` (too many failures — the call falls
 *     back to degraded mode: local STT/TTS only, no provider
 *     round-trip, and the panel says so), or `give-up` (attempts
 *     exhausted, or an unretryable kind).
 *   - Degraded mode is explicit: `enterDegraded()` / `exitDegraded()`
 *     with reasons, and `noteSuccess()` after a probe recovers the
 *     call (`network-recovered`). A probe is any caller-supplied
 *     check (`probe(fn)`) — the guard never opens a socket itself.
 *   - Every decision is recorded (kind / attempt / delay / at) so
 *     the session log can show *why* a call degraded instead of
 *     just *that* it did.
 *
 * The guard never dials, never reads a key, never touches audio.
 * The v6 session owns the transport; the guard owns the decision.
 */

/** What kind of network failure this was. */
export type VoiceNetworkErrorKind =
  | 'timeout'
  | 'reset'
  | 'dns'
  | 'rate-limited'
  | 'auth'
  | 'server'
  | 'unknown';

/** What the guard wants the session to do about a failure. */
export type VoiceNetworkAction = 'retry' | 'degrade' | 'give-up';

/** One classified failure. */
export interface VoiceNetworkErrorInfo {
  kind: VoiceNetworkErrorKind;
  /** Human-readable message (the original error's, cleaned). */
  message: string;
  /** True when retrying the same request could succeed. */
  retryable: boolean;
  /** Retry delay the server asked for (ms, when it gave one). */
  retryAfterMs: number | null;
}

/** One guard decision, recorded. */
export interface VoiceNetworkDecision {
  action: VoiceNetworkAction;
  /** Kind of the failure that produced this decision. */
  kind: VoiceNetworkErrorKind;
  /** Consecutive failure count when this decision was made. */
  attempt: number;
  /** ms to wait before the retry (0 for degrade / give-up). */
  delayMs: number;
  /** Why this action (for the log / panel). */
  reason: string;
  at: number;
}

export type VoiceNetworkGuardEvent =
  | { kind: 'network-retry'; decision: VoiceNetworkDecision; at: number }
  | { kind: 'network-degraded'; decision: VoiceNetworkDecision; reason: string; at: number }
  | { kind: 'network-give-up'; decision: VoiceNetworkDecision; at: number }
  | { kind: 'network-recovered'; attemptsBefore: number; at: number };

export type VoiceNetworkGuardEventSink = (event: VoiceNetworkGuardEvent) => void;

export interface VoiceNetworkGuardOptions {
  /** Failures before the guard gives up entirely. Default 5. */
  maxAttempts?: number;
  /** Failures before degraded mode. Default 2 (must be <= maxAttempts). */
  degradeAfterAttempts?: number;
  /** First backoff delay (ms). Default 500. */
  baseDelayMs?: number;
  /** Backoff cap (ms). Default 8000. */
  maxDelayMs?: number;
  /** Jitter source (tests inject `() => 0` for determinism). */
  jitter?: () => number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink (retry / degrade / give-up / recovered). */
  onEvent?: VoiceNetworkGuardEventSink;
}

export interface VoiceNetworkGuardStats {
  /** Consecutive failures since the last success. */
  consecutiveFailures: number;
  totalFailures: number;
  totalRecoveries: number;
  degraded: boolean;
  /** Last failure kind (null when never failed). */
  lastKind: VoiceNetworkErrorKind | null;
  /** Last failure message (null when never failed). */
  lastMessage: string | null;
  decisions: number;
  gaveUp: boolean;
}

/** Default backoff base (ms) and cap (ms). */
export const VOICE_NETWORK_DEFAULT_BASE_DELAY_MS = 500;
export const VOICE_NETWORK_DEFAULT_MAX_DELAY_MS = 8000;
export const VOICE_NETWORK_DEFAULT_MAX_ATTEMPTS = 5;
export const VOICE_NETWORK_DEFAULT_DEGRADE_AFTER = 2;

/**
 * Sort a thrown value into a kind. Matches on `code` / `status` /
 * message text, in that order — a 401 is auth even when its message
 * says "timeout", and a message mentioning "rate limit" is
 * rate-limited even without a status.
 */
export function classifyVoiceNetworkError(error: unknown): VoiceNetworkErrorInfo {
  const raw =
    error instanceof Error
      ? error
      : typeof error === 'string'
        ? new Error(error)
        : new Error(String(error ?? 'unknown error'));
  const message = raw.message.trim() || 'Unknown network error';
  const lower = message.toLowerCase();
  const code = (raw as { code?: unknown }).code;
  const status = (raw as { status?: unknown; statusCode?: unknown }).status ??
    (raw as { statusCode?: unknown }).statusCode;
  const codeText = typeof code === 'string' ? code.toLowerCase() : '';
  const statusNum = typeof status === 'number' ? status : null;

  const retryAfter = (raw as { retryAfterMs?: unknown }).retryAfterMs;
  const retryAfterMs =
    typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.floor(retryAfter)
      : null;

  const info = (kind: VoiceNetworkErrorKind, retryable: boolean): VoiceNetworkErrorInfo => ({
    kind,
    message,
    retryable,
    retryAfterMs,
  });

  if (statusNum === 401 || statusNum === 403 || codeText.includes('auth') || /\b(auth|authentication|authorization|unauthorized|invalid api key)\b/.test(lower)) {
    return info('auth', false);
  }
  if (statusNum === 429 || codeText.includes('rate') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return info('rate-limited', true);
  }
  if (statusNum !== null && statusNum >= 500 && statusNum < 600) {
    return info('server', true);
  }
  if (codeText.includes('timeout') || codeText === 'etimedout' || lower.includes('timed out') || lower.includes('timeout')) {
    return info('timeout', true);
  }
  if (codeText === 'econnreset' || codeText === 'econnaborted' || codeText === 'econnrefused' || lower.includes('connection reset') || lower.includes('socket hang up') || lower.includes('connection refused')) {
    return info('reset', true);
  }
  if (codeText === 'enotfound' || codeText === 'eai_again' || lower.includes('getaddrinfo') || lower.includes('dns') || lower.includes('name not resolved')) {
    return info('dns', true);
  }
  return info('unknown', true);
}

export class VoiceNetworkGuard {
  private readonly maxAttempts: number;
  private readonly degradeAfterAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitter: () => number;
  private readonly clock: () => number;
  private readonly onEvent: VoiceNetworkGuardEventSink | undefined;
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private totalRecoveries = 0;
  private degraded = false;
  private gaveUp = false;
  private lastKind: VoiceNetworkErrorKind | null = null;
  private lastMessage: string | null = null;
  private readonly decisions: VoiceNetworkDecision[] = [];

  constructor(options: VoiceNetworkGuardOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? VOICE_NETWORK_DEFAULT_MAX_ATTEMPTS);
    const degradeAfter = options.degradeAfterAttempts ?? VOICE_NETWORK_DEFAULT_DEGRADE_AFTER;
    this.degradeAfterAttempts = Math.max(1, Math.min(degradeAfter, this.maxAttempts));
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? VOICE_NETWORK_DEFAULT_BASE_DELAY_MS);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? VOICE_NETWORK_DEFAULT_MAX_DELAY_MS);
    this.jitter = options.jitter ?? Math.random;
    this.clock = options.clock ?? Date.now;
    this.onEvent = options.onEvent;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  hasGivenUp(): boolean {
    return this.gaveUp;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /** Backoff delay for attempt N (1-based): base * 2^(N-1), capped, + jitter. */
  backoffDelayMs(attempt: number): number {
    const attemptNum = Math.max(1, attempt);
    const exponential = this.baseDelayMs * 2 ** (attemptNum - 1);
    const capped = Math.min(this.maxDelayMs, exponential);
    const jitterMs = Math.floor(this.jitter() * Math.min(250, capped));
    return capped + jitterMs;
  }

  /**
   * Record a failure and decide what the session should do.
   * Auth failures give up at once (retrying never helps); a
   * server-suggested `retryAfterMs` overrides the backoff; hitting
   * `degradeAfterAttempts` degrades; hitting `maxAttempts` gives up.
   */
  noteFailure(error: unknown): VoiceNetworkDecision {
    const info = classifyVoiceNetworkError(error);
    this.consecutiveFailures += 1;
    this.totalFailures += 1;
    this.lastKind = info.kind;
    this.lastMessage = info.message;
    const at = this.clock();
    let decision: VoiceNetworkDecision;
    if (!info.retryable) {
      this.gaveUp = true;
      decision = {
        action: 'give-up',
        kind: info.kind,
        attempt: this.consecutiveFailures,
        delayMs: 0,
        reason: `Unretryable failure (${info.kind}): ${info.message}`,
        at,
      };
      this.record(decision);
      this.emit({ kind: 'network-give-up', decision: { ...decision }, at });
      return decision;
    }
    if (this.consecutiveFailures >= this.maxAttempts) {
      this.gaveUp = true;
      decision = {
        action: 'give-up',
        kind: info.kind,
        attempt: this.consecutiveFailures,
        delayMs: 0,
        reason: `Gave up after ${this.consecutiveFailures} consecutive failures (${info.kind}).`,
        at,
      };
      this.record(decision);
      this.emit({ kind: 'network-give-up', decision: { ...decision }, at });
      return decision;
    }
    if (this.consecutiveFailures >= this.degradeAfterAttempts && !this.degraded) {
      this.degraded = true;
      decision = {
        action: 'degrade',
        kind: info.kind,
        attempt: this.consecutiveFailures,
        delayMs: 0,
        reason:
          `${this.consecutiveFailures} consecutive failures (${info.kind}) — ` +
          'degraded mode: local STT/TTS only, no provider round-trip.',
        at,
      };
      this.record(decision);
      this.emit({ kind: 'network-degraded', decision: { ...decision }, reason: decision.reason, at });
      return decision;
    }
    const delayMs = info.retryAfterMs ?? this.backoffDelayMs(this.consecutiveFailures);
    decision = {
      action: 'retry',
      kind: info.kind,
      attempt: this.consecutiveFailures,
      delayMs,
      reason: `Retry ${this.consecutiveFailures}/${this.maxAttempts} after ${delayMs}ms (${info.kind}).`,
      at,
    };
    this.record(decision);
    this.emit({ kind: 'network-retry', decision: { ...decision }, at });
    return decision;
  }

  /** Record a success: the failure streak resets; degraded mode recovers. */
  noteSuccess(): boolean {
    const wasDegraded = this.degraded;
    const attemptsBefore = this.consecutiveFailures;
    this.consecutiveFailures = 0;
    this.gaveUp = false;
    if (wasDegraded) {
      this.degraded = false;
      this.totalRecoveries += 1;
      this.emit({ kind: 'network-recovered', attemptsBefore, at: this.clock() });
    }
    return wasDegraded;
  }

  /** Enter degraded mode directly (caller observed the outage). */
  enterDegraded(reason: string): VoiceNetworkDecision {
    if (this.degraded) {
      return {
        action: 'degrade',
        kind: this.lastKind ?? 'unknown',
        attempt: this.consecutiveFailures,
        delayMs: 0,
        reason: 'Already degraded.',
        at: this.clock(),
      };
    }
    this.degraded = true;
    const decision: VoiceNetworkDecision = {
      action: 'degrade',
      kind: this.lastKind ?? 'unknown',
      attempt: this.consecutiveFailures,
      delayMs: 0,
      reason,
      at: this.clock(),
    };
    this.record(decision);
    this.emit({ kind: 'network-degraded', decision: { ...decision }, reason, at: decision.at });
    return decision;
  }

  /** Leave degraded mode (the transport is healthy again). */
  exitDegraded(reason = 'transport healthy'): boolean {
    if (!this.degraded) return false;
    this.degraded = false;
    this.consecutiveFailures = 0;
    this.totalRecoveries += 1;
    this.emit({ kind: 'network-recovered', attemptsBefore: 0, at: this.clock() });
    void reason;
    return true;
  }

  /**
   * Run a caller-supplied probe (a cheap transport check, a ping,
   * a re-dial attempt). A passing probe counts as success; a
   * failing probe counts as a failure and returns its decision.
   * The guard never opens a socket itself.
   */
  async probe(check: () => boolean | Promise<boolean>): Promise<{ ok: boolean; decision: VoiceNetworkDecision | null }> {
    let ok = false;
    try {
      ok = await check();
    } catch (error) {
      const decision = this.noteFailure(error);
      return { ok: false, decision };
    }
    if (!ok) {
      const decision = this.noteFailure(new Error('Network probe failed.'));
      return { ok: false, decision };
    }
    this.noteSuccess();
    return { ok: true, decision: null };
  }

  /** Decisions so far, oldest first (copies). */
  getDecisions(): VoiceNetworkDecision[] {
    return this.decisions.map((d) => ({ ...d }));
  }

  getStats(): VoiceNetworkGuardStats {
    return {
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.totalFailures,
      totalRecoveries: this.totalRecoveries,
      degraded: this.degraded,
      lastKind: this.lastKind,
      lastMessage: this.lastMessage,
      decisions: this.decisions.length,
      gaveUp: this.gaveUp,
    };
  }

  private record(decision: VoiceNetworkDecision): void {
    this.decisions.push(decision);
    if (this.decisions.length > 100) this.decisions.splice(0, this.decisions.length - 100);
  }

  private emit(event: VoiceNetworkGuardEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}

/** One-line summary for the panel / session log. */
export function voiceNetworkSummary(guard: VoiceNetworkGuard): string {
  const stats = guard.getStats();
  if (stats.totalFailures === 0) return 'network: no failures';
  return (
    `network: ${stats.consecutiveFailures} consecutive failure(s), ` +
    `${stats.totalFailures} total, ${stats.totalRecoveries} recoveries, ` +
    `degraded=${stats.degraded ? 'yes' : 'no'}, gaveUp=${stats.gaveUp ? 'yes' : 'no'}, ` +
    `last=${stats.lastKind ?? 'none'}`
  );
}
