/**
 * Provider refresh scheduling for voice v24 (v1.37, Team T5).
 *
 * The dynamic catalogue is only as fresh as its last probe:
 * a provider that was online an hour ago may be offline
 * now, and the picker must not keep showing the stale
 * "online". The refresh scheduler owns the *when*:
 *
 *   - a per-provider TTL (how long a probe stays fresh;
 *     unconfigured providers are never "due" — there is
 *     nothing to refresh until the user configures them);
 *   - a due list at any virtual time, worst (most stale)
 *     first, so the host probes the stalest provider first;
 *   - a refresh round: given the probe results the host
 *     just measured, record which providers refreshed,
 *     which failed, and which are still due;
 *   - consecutive-failure backoff: a provider that keeps
 *     failing gets a longer TTL before its next probe is
 *     due, so a dead provider does not burn a probe slot
 *     every round (backoff is capped).
 *
 * The scheduler never probes anything itself: the host
 * measures and passes results in. All clocks virtual.
 */
import { round2V24, type VoiceV24ProviderStatus } from './types';

export interface ProviderRefreshV24Options {
  /** A probe stays fresh for this long (default 60000 ms). */
  ttlMs: number;
  /** Base backoff added per consecutive failure (default 30000 ms). */
  backoffBaseMs: number;
  /** Max backoff (default 600000 ms = 10 min). */
  backoffMaxMs: number;
  /** Max providers reported as due in one call (default 50). */
  maxDue: number;
}

export function defaultProviderRefreshV24Options(): ProviderRefreshV24Options {
  return { ttlMs: 60000, backoffBaseMs: 30000, backoffMaxMs: 600000, maxDue: 50 };
}

export function validateProviderRefreshV24Options(
  o: Partial<ProviderRefreshV24Options>,
): string[] {
  const errors: string[] = [];
  if (o.ttlMs !== undefined && !(o.ttlMs > 0 && o.ttlMs <= 3600000)) {
    errors.push('ttlMs must be > 0 and <= 3600000');
  }
  if (o.backoffBaseMs !== undefined && !(o.backoffBaseMs >= 0 && o.backoffBaseMs <= 3600000)) {
    errors.push('backoffBaseMs must be >= 0 and <= 3600000');
  }
  if (o.backoffMaxMs !== undefined && !(o.backoffMaxMs >= 0 && o.backoffMaxMs <= 86400000)) {
    errors.push('backoffMaxMs must be >= 0 and <= 86400000');
  }
  if (
    o.backoffBaseMs !== undefined &&
    o.backoffMaxMs !== undefined &&
    o.backoffMaxMs < o.backoffBaseMs
  ) {
    errors.push('backoffMaxMs must be >= backoffBaseMs');
  }
  if (o.maxDue !== undefined && (!Number.isInteger(o.maxDue) || o.maxDue < 1 || o.maxDue > 1000)) {
    errors.push('maxDue must be an integer 1..1000');
  }
  return errors;
}

/** Per-provider refresh state the scheduler tracks. */
export interface VoiceV24RefreshState {
  providerId: string;
  lastProbeAtMs: number | null;
  lastProbeOk: boolean | null;
  consecutiveFailures: number;
  nextDueAtMs: number | null;
  /** Effective TTL including backoff, ms. */
  effectiveTtlMs: number;
}

/** One provider due for a refresh, most stale first. */
export interface VoiceV24RefreshDue {
  providerId: string;
  lastProbeAtMs: number | null;
  /** ms overdue (0 when never probed — due now, not overdue). */
  overdueMs: number;
  nextDueAtMs: number | null;
}

/** Result of one refresh round. */
export interface VoiceV24RefreshRound {
  atMs: number;
  refreshed: string[];
  failed: string[];
  stillDue: string[];
}

export function createProviderRefreshSchedulerV24(
  opts: Partial<ProviderRefreshV24Options> = {},
): ProviderRefreshSchedulerV24 {
  return new ProviderRefreshSchedulerV24(opts);
}

export class ProviderRefreshSchedulerV24 {
  private readonly opts: ProviderRefreshV24Options;
  private readonly states = new Map<string, VoiceV24RefreshState>();
  private rounds = 0;

  constructor(opts: Partial<ProviderRefreshV24Options> = {}) {
    const errors = validateProviderRefreshV24Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid ProviderRefreshSchedulerV24 options: ${errors.join('; ')}`);
    }
    const merged = { ...defaultProviderRefreshV24Options(), ...opts };
    if (merged.backoffMaxMs < merged.backoffBaseMs) {
      throw new Error('Invalid ProviderRefreshSchedulerV24 options: backoffMaxMs must be >= backoffBaseMs');
    }
    this.opts = merged;
  }

  options(): ProviderRefreshV24Options {
    return { ...this.opts };
  }

  /** Register a provider for refresh tracking (idempotent). */
  track(providerId: string): void {
    if (typeof providerId !== 'string' || providerId.length === 0) {
      throw new Error('providerId must be a non-empty string');
    }
    if (!this.states.has(providerId)) {
      this.states.set(providerId, {
        providerId,
        lastProbeAtMs: null,
        lastProbeOk: null,
        consecutiveFailures: 0,
        nextDueAtMs: null,
        effectiveTtlMs: this.opts.ttlMs,
      });
    }
  }

  /** Stop tracking a provider. True when it was tracked. */
  untrack(providerId: string): boolean {
    return this.states.delete(providerId);
  }

  trackedIds(): string[] {
    return [...this.states.keys()].sort();
  }

  /** Effective TTL for a provider (base TTL + capped failure backoff). */
  effectiveTtlMs(providerId: string): number {
    const state = this.states.get(providerId);
    if (state === undefined) throw new Error(`Provider "${providerId}" is not tracked`);
    return state.effectiveTtlMs;
  }

  /** Record one host-measured probe result. */
  recordProbe(providerId: string, atMs: number, ok: boolean): VoiceV24RefreshState {
    this.track(providerId);
    const state = this.states.get(providerId) as VoiceV24RefreshState;
    state.lastProbeAtMs = atMs;
    state.lastProbeOk = ok;
    state.consecutiveFailures = ok ? 0 : state.consecutiveFailures + 1;
    const backoff = Math.min(
      this.opts.backoffMaxMs,
      this.opts.backoffBaseMs * state.consecutiveFailures,
    );
    state.effectiveTtlMs = this.opts.ttlMs + backoff;
    state.nextDueAtMs = atMs + state.effectiveTtlMs;
    return { ...state };
  }

  stateOf(providerId: string): VoiceV24RefreshState | null {
    const state = this.states.get(providerId);
    return state === undefined ? null : { ...state };
  }

  /** True when the provider's probe is due at `atMs`. */
  isDue(providerId: string, atMs: number, configured = true): boolean {
    const state = this.states.get(providerId);
    if (state === undefined) return false;
    // Unconfigured providers have nothing to refresh.
    if (!configured) return false;
    if (state.lastProbeAtMs === null) return true;
    return atMs >= (state.nextDueAtMs ?? 0);
  }

  /** Providers due for a refresh at `atMs`, most stale first. */
  dueList(atMs: number, configured: (providerId: string) => boolean = () => true): VoiceV24RefreshDue[] {
    const out: VoiceV24RefreshDue[] = [];
    for (const state of this.states.values()) {
      if (!configured(state.providerId)) continue;
      if (!this.isDue(state.providerId, atMs, true)) continue;
      out.push({
        providerId: state.providerId,
        lastProbeAtMs: state.lastProbeAtMs,
        overdueMs:
          state.lastProbeAtMs === null
            ? 0
            : Math.max(0, atMs - (state.nextDueAtMs ?? atMs)),
        nextDueAtMs: state.nextDueAtMs,
      });
    }
    out.sort((a, b) => {
      // Never-probed first, then most overdue.
      if (a.lastProbeAtMs === null && b.lastProbeAtMs !== null) return -1;
      if (a.lastProbeAtMs !== null && b.lastProbeAtMs === null) return 1;
      return b.overdueMs - a.overdueMs || a.providerId.localeCompare(b.providerId);
    });
    return out.slice(0, this.opts.maxDue);
  }

  /**
   * Close one refresh round: record the probe results the
   * host just measured and report what is still due.
   */
  recordRound(
    results: readonly { providerId: string; ok: boolean }[],
    atMs: number,
    configured: (providerId: string) => boolean = () => true,
  ): VoiceV24RefreshRound {
    const refreshed: string[] = [];
    const failed: string[] = [];
    for (const result of results) {
      this.recordProbe(result.providerId, atMs, result.ok);
      if (result.ok) refreshed.push(result.providerId);
      else failed.push(result.providerId);
    }
    this.rounds += 1;
    return {
      atMs,
      refreshed,
      failed,
      stillDue: this.dueList(atMs, configured).map((d) => d.providerId),
    };
  }

  roundsCompleted(): number {
    return this.rounds;
  }

  /** Share of tracked providers with a fresh probe at `atMs` (0..1, 0 when none tracked). */
  freshness(providerIds: readonly string[], atMs: number, configured: (providerId: string) => boolean = () => true): number {
    const relevant = providerIds.filter((id) => configured(id));
    if (relevant.length === 0) return 0;
    const fresh = relevant.filter((id) => !this.isDue(id, atMs, true)).length;
    return round2V24(fresh / relevant.length);
  }

  reset(): void {
    this.states.clear();
    this.rounds = 0;
  }

  summary(atMs: number): string {
    const due = this.dueList(atMs).length;
    const tracked = this.states.size;
    return `${tracked} providers tracked, ${due} due for refresh, ${this.rounds} refresh rounds completed.`;
  }
}

/** Status type re-exported for callers that only import this module. */
export type { VoiceV24ProviderStatus };
