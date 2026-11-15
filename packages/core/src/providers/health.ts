/**
 * Provider health dashboard (v1.08, Đội T4).
 *
 * One monitor watches every configured LLM provider and answers the
 * three questions the Settings → Providers UI needs:
 *
 *   1. Is this provider up right now? (`up` / `degraded` / `down` /
 *      `unknown` — never checked yet)
 *   2. How slow is it? (latency of the last probe + history)
 *   3. What broke last, and is quota running out? (last error +
 *      rate-limit quota parsed from response headers)
 *
 * Design rules (same as the rest of the provider layer):
 * - The monitor NEVER calls a provider itself: the host injects a
 *   `probe` function (in production: `createProvider(...).listModels()`
 *   timed + header capture; in tests: a stub). No key ever passes
 *   through this module — the probe closes over whatever credential
 *   the host already holds.
 * - Probing is cheap and read-only: `GET /models` only, never a chat
 *   completion (no tokens spent, no side effect on the provider).
 * - A single failed probe is `degraded`, not `down` — networks flap.
 *   `down` needs `downAfterFailures` consecutive failures (default 2).
 *   Recovery needs one success. Alerts fire ONLY on transitions
 *   (up → down, down → up, ...), never on every failed probe, so a
 *   dead provider does not spam the UI.
 * - Quota is best-effort: parsed from standard rate-limit headers
 *   when the probe reports them (`parseQuotaHeaders`). Many providers
 *   do not expose quota on `/models` at all — then `quota` stays
 *   undefined and the UI shows "không rõ", never a guessed number.
 * - All state is in memory. The host persists snapshots if it wants
 *   history across restarts; this module does not touch the disk.
 * - Timer uses a `setTimeout` chain (like ComposioPollScheduler) and
 *   `unref`, so monitoring never keeps the process alive.
 */

/** Health of one provider, as the UI renders it. */
export type ProviderHealthStatus = 'unknown' | 'up' | 'degraded' | 'down';

/** What one probe of one provider found. Returned by the injected probe. */
export interface ProviderHealthProbeResult {
  /** True when the probe reached the provider and got a usable answer. */
  ok: boolean;
  /**
   * Round-trip time, ms. When omitted the monitor measures it from
   * its own clock instead (probe + monitor must share the clock for
   * that to be meaningful — tests inject both).
   */
  latencyMs?: number;
  /** Short error text when ok is false (already sanitised — no key). */
  error?: string;
  /** HTTP status of the probe when the probe knows it. */
  statusCode?: number;
  /** Rate-limit quota the probe observed (undefined = provider did not report any). */
  quota?: ProviderHealthQuota;
}

/** Rate-limit quota observed on a probe (all fields optional). */
export interface ProviderHealthQuota {
  /** Requests (or tokens) left in the current window. */
  remaining?: number;
  /** Size of the window the provider reports. */
  limit?: number;
  /** ms epoch when the window resets (undefined = provider did not say). */
  resetAtMs?: number;
}

/** One recorded probe, kept for history + uptime math. */
export interface ProviderHealthSample {
  providerId: string;
  checkedAtMs: number;
  ok: boolean;
  latencyMs: number;
  error?: string;
  statusCode?: number;
  quota?: ProviderHealthQuota;
}

/** Kinds of alert the monitor emits (transition-only, see header). */
export type ProviderHealthAlertKind = 'down' | 'recovered' | 'degraded' | 'quota-low';

/** One alert: a status transition (or quota crossing) worth showing. */
export interface ProviderHealthAlert {
  id: string;
  providerId: string;
  kind: ProviderHealthAlertKind;
  message: string;
  atMs: number;
  latencyMs?: number;
  error?: string;
}

/** Everything the UI needs for one provider row. */
export interface ProviderHealthSnapshot {
  providerId: string;
  label: string;
  status: ProviderHealthStatus;
  lastLatencyMs?: number;
  lastCheckedAtMs?: number;
  lastError?: string;
  lastStatusCode?: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  checksTotal: number;
  failuresTotal: number;
  /** Share of kept samples that succeeded (null = never checked). */
  uptimePct: number | null;
  samplesKept: number;
  quota?: ProviderHealthQuota;
  /** True when the last known quota is at/below the low threshold. */
  quotaLow: boolean;
}

/** Rolled-up numbers for the dashboard header. */
export interface ProviderHealthSummary {
  total: number;
  up: number;
  degraded: number;
  down: number;
  unknown: number;
  worstLatencyMs?: number;
  worstProviderId?: string;
  quotaLowProviders: string[];
}

export type ProviderHealthProbeFn = (
  providerId: string,
) => Promise<ProviderHealthProbeResult>;

export type ProviderHealthAlertListener = (alert: ProviderHealthAlert) => void;

/** Consecutive failures before `degraded` becomes `down`. */
export const PROVIDER_HEALTH_DOWN_AFTER_FAILURES = 2;
/** Remaining quota at/below this count is "low" (when a limit is known). */
export const PROVIDER_HEALTH_QUOTA_LOW_THRESHOLD = 10;
/** Samples kept per provider (ring buffer — old samples drop). */
export const PROVIDER_HEALTH_MAX_SAMPLES = 120;
/** Alerts kept (ring buffer — old alerts drop). */
export const PROVIDER_HEALTH_MAX_ALERTS = 100;
/** Default probe interval for `start()` (5 minutes — cheap GET /models). */
export const PROVIDER_HEALTH_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/** Minimum probe interval (30 s — shorter would hammer the provider). */
export const PROVIDER_HEALTH_MIN_INTERVAL_MS = 30 * 1000;

export interface ProviderHealthMonitorOptions {
  /** How to probe one provider (host-injected — see header). Required. */
  probe: ProviderHealthProbeFn;
  /** Display labels by provider id (defaults to the id itself). */
  labels?: Record<string, string>;
  /** Clock, injectable for tests (defaults to Date.now). */
  now?: () => number;
  /** Extra alert sink besides subscribe() (defaults to none). */
  onAlert?: ProviderHealthAlertListener;
  /** Consecutive failures before `down` (default 2, min 1). */
  downAfterFailures?: number;
  /** Remaining quota at/below this is "low" (default 10). */
  quotaLowThreshold?: number;
  /** Samples kept per provider (default 120). */
  maxSamplesPerProvider?: number;
  /** Alerts kept (default 100). */
  maxAlerts?: number;
}

interface ProviderHealthState {
  status: ProviderHealthStatus;
  samples: ProviderHealthSample[];
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  checksTotal: number;
  failuresTotal: number;
  quota?: ProviderHealthQuota;
  quotaLow: boolean;
  lastError?: string;
  lastStatusCode?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse rate-limit quota from response headers (case-insensitive).
 * Understands the shapes providers actually send:
 * - `x-ratelimit-remaining` / `x-ratelimit-limit` (OpenAI, Groq,
 *   Together, Fireworks, OpenRouter, DeepSeek, Mistral, ...)
 * - `x-ratelimit-reset`: seconds-until-reset OR epoch seconds/ms
 *   (disambiguated by magnitude: > 1e12 = ms epoch, > 1e9 = s epoch,
 *   otherwise seconds from now)
 * - `retry-after` (seconds) as a reset fallback when nothing else
 *   is present — only when a remaining/limit was also found, so a
 *   bare `retry-after` never invents a quota object.
 * Returns undefined when no quota header is present at all.
 */
export function parseQuotaHeaders(
  headers: Record<string, string>,
  nowMs: number = Date.now(),
): ProviderHealthQuota | undefined {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = value;
  }
  const readNumber = (name: string): number | undefined => {
    const raw = lower[name];
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const remaining = readNumber('x-ratelimit-remaining');
  const limit = readNumber('x-ratelimit-limit');
  const resetRaw = readNumber('x-ratelimit-reset');
  const retryAfter = readNumber('retry-after');
  if (remaining === undefined && limit === undefined && resetRaw === undefined) {
    return undefined;
  }
  let resetAtMs: number | undefined;
  if (resetRaw !== undefined) {
    if (resetRaw > 1e12) resetAtMs = resetRaw;
    else if (resetRaw > 1e9) resetAtMs = resetRaw * 1000;
    else resetAtMs = nowMs + resetRaw * 1000;
  } else if (retryAfter !== undefined && (remaining !== undefined || limit !== undefined)) {
    resetAtMs = nowMs + retryAfter * 1000;
  }
  const quota: ProviderHealthQuota = {};
  if (remaining !== undefined) quota.remaining = remaining;
  if (limit !== undefined) quota.limit = limit;
  if (resetAtMs !== undefined) quota.resetAtMs = resetAtMs;
  return quota;
}

/** Human label for a status (log/alert text — UI strings live in i18n). */
export function providerHealthStatusLabel(status: ProviderHealthStatus): string {
  switch (status) {
    case 'up':
      return 'up';
    case 'degraded':
      return 'degraded';
    case 'down':
      return 'down';
    case 'unknown':
      return 'unknown';
  }
}

export class ProviderHealthMonitor {
  private readonly probe: ProviderHealthProbeFn;
  private readonly labels: Record<string, string>;
  private readonly now: () => number;
  private readonly onAlert?: ProviderHealthAlertListener;
  private readonly downAfterFailures: number;
  private readonly quotaLowThreshold: number;
  private readonly maxSamplesPerProvider: number;
  private readonly maxAlerts: number;
  private readonly states = new Map<string, ProviderHealthState>();
  private readonly alerts: ProviderHealthAlert[] = [];
  private readonly listeners = new Set<ProviderHealthAlertListener>();
  private alertSeq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerProviderIds: string[] = [];
  private timerIntervalMs = PROVIDER_HEALTH_DEFAULT_INTERVAL_MS;
  private timerStopped = true;

  constructor(options: ProviderHealthMonitorOptions) {
    if (typeof options.probe !== 'function') {
      throw new Error('ProviderHealthMonitor needs a probe function.');
    }
    this.probe = options.probe;
    this.labels = { ...(options.labels ?? {}) };
    this.now = options.now ?? Date.now;
    this.onAlert = options.onAlert;
    const downAfter = options.downAfterFailures ?? PROVIDER_HEALTH_DOWN_AFTER_FAILURES;
    this.downAfterFailures = Number.isFinite(downAfter) && downAfter >= 1 ? Math.floor(downAfter) : PROVIDER_HEALTH_DOWN_AFTER_FAILURES;
    const quotaLow = options.quotaLowThreshold ?? PROVIDER_HEALTH_QUOTA_LOW_THRESHOLD;
    this.quotaLowThreshold = Number.isFinite(quotaLow) && quotaLow >= 0 ? quotaLow : PROVIDER_HEALTH_QUOTA_LOW_THRESHOLD;
    const maxSamples = options.maxSamplesPerProvider ?? PROVIDER_HEALTH_MAX_SAMPLES;
    this.maxSamplesPerProvider = Number.isFinite(maxSamples) && maxSamples >= 1 ? Math.floor(maxSamples) : PROVIDER_HEALTH_MAX_SAMPLES;
    const maxAlerts = options.maxAlerts ?? PROVIDER_HEALTH_MAX_ALERTS;
    this.maxAlerts = Number.isFinite(maxAlerts) && maxAlerts >= 1 ? Math.floor(maxAlerts) : PROVIDER_HEALTH_MAX_ALERTS;
  }

  /** Probe one provider now and record the result. Never throws for a probe failure — that IS the data. */
  async check(providerId: string): Promise<ProviderHealthSnapshot> {
    const id = String(providerId ?? '').trim();
    if (!id) throw new Error('check() needs a non-empty provider id.');
    const state = this.stateFor(id);
    const previousStatus = state.status;
    const wasQuotaLow = state.quotaLow;
    const startedAt = this.now();
    let result: ProviderHealthProbeResult;
    try {
      result = await this.probe(id);
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!isRecord(result) || typeof result.ok !== 'boolean') {
      result = { ok: false, error: 'probe returned an invalid result' };
    }
    const latencyMs =
      typeof result.latencyMs === 'number' && Number.isFinite(result.latencyMs) && result.latencyMs >= 0
        ? result.latencyMs
        : Math.max(0, this.now() - startedAt);
    const checkedAtMs = this.now();
    const sample: ProviderHealthSample = {
      providerId: id,
      checkedAtMs,
      ok: result.ok,
      latencyMs,
      ...(result.error ? { error: result.error } : {}),
      ...(typeof result.statusCode === 'number' ? { statusCode: result.statusCode } : {}),
      ...(result.quota ? { quota: { ...result.quota } } : {}),
    };
    state.samples.push(sample);
    if (state.samples.length > this.maxSamplesPerProvider) {
      state.samples.splice(0, state.samples.length - this.maxSamplesPerProvider);
    }
    state.checksTotal += 1;
    if (result.ok) {
      state.consecutiveSuccesses += 1;
      state.consecutiveFailures = 0;
      state.lastError = undefined;
      state.lastStatusCode = result.statusCode;
      state.status = 'up';
    } else {
      state.consecutiveFailures += 1;
      state.consecutiveSuccesses = 0;
      state.failuresTotal += 1;
      state.lastError = result.error ?? 'probe failed';
      state.lastStatusCode = result.statusCode;
      state.status =
        state.consecutiveFailures >= this.downAfterFailures ? 'down' : 'degraded';
    }
    if (result.quota) {
      state.quota = { ...result.quota };
      state.quotaLow =
        typeof result.quota.remaining === 'number' &&
        result.quota.remaining <= this.quotaLowThreshold;
    }
    // Transition-only alerts (see header): a dead provider alerts
    // once when it dies and once when it recovers — never per probe.
    if (state.status !== previousStatus) {
      if (state.status === 'down') {
        this.emitAlert(id, 'down', `Provider ${this.labelFor(id)} is down: ${state.lastError ?? 'probe failed'}`, checkedAtMs, latencyMs, state.lastError);
      } else if (state.status === 'degraded' && previousStatus === 'up') {
        this.emitAlert(id, 'degraded', `Provider ${this.labelFor(id)} is degraded: ${state.lastError ?? 'probe failed'}`, checkedAtMs, latencyMs, state.lastError);
      } else if (state.status === 'up' && (previousStatus === 'down' || previousStatus === 'degraded')) {
        this.emitAlert(id, 'recovered', `Provider ${this.labelFor(id)} recovered after ${state.consecutiveSuccesses} successful probe(s).`, checkedAtMs, latencyMs);
      }
    }
    if (state.quotaLow && !wasQuotaLow && state.quota?.remaining !== undefined) {
      this.emitAlert(
        id,
        'quota-low',
        `Provider ${this.labelFor(id)} quota is low: ${state.quota.remaining} remaining.`,
        checkedAtMs,
        latencyMs,
      );
    }
    return this.snapshotFor(id, state);
  }

  /** Probe every listed provider in sequence (one slow provider never blocks the others' results — each check is independent). */
  async checkAll(providerIds: string[]): Promise<ProviderHealthSnapshot[]> {
    const snapshots: ProviderHealthSnapshot[] = [];
    for (const id of providerIds) {
      snapshots.push(await this.check(id));
    }
    return snapshots;
  }

  /** Current snapshot for one provider (`unknown` when never checked). */
  getSnapshot(providerId: string): ProviderHealthSnapshot {
    const id = String(providerId ?? '').trim();
    if (!id) throw new Error('getSnapshot() needs a non-empty provider id.');
    return this.snapshotFor(id, this.stateFor(id));
  }

  /** Current snapshots for the given providers (defaults to every provider ever checked). */
  getAllSnapshots(providerIds?: string[]): ProviderHealthSnapshot[] {
    const ids = providerIds ?? [...this.states.keys()];
    return ids.map((id) => this.getSnapshot(id));
  }

  /** Newest-first probe history for one provider (up to `limit`, default 20). */
  getHistory(providerId: string, limit = 20): ProviderHealthSample[] {
    const id = String(providerId ?? '').trim();
    const state = this.states.get(id);
    if (!state) return [];
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 20;
    return [...state.samples].slice(-safeLimit).reverse().map((s) => ({ ...s, quota: s.quota ? { ...s.quota } : undefined }));
  }

  /** Newest-first alerts (up to `limit`, default 50). */
  getAlerts(limit = 50): ProviderHealthAlert[] {
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 50;
    return [...this.alerts].slice(-safeLimit).reverse().map((a) => ({ ...a }));
  }

  /** Dashboard header numbers for the given providers (defaults to every provider ever checked). */
  summary(providerIds?: string[]): ProviderHealthSummary {
    const snapshots = this.getAllSnapshots(providerIds);
    const out: ProviderHealthSummary = {
      total: snapshots.length,
      up: 0,
      degraded: 0,
      down: 0,
      unknown: 0,
      quotaLowProviders: [],
    };
    for (const snap of snapshots) {
      out[snap.status] += 1;
      if (snap.lastLatencyMs !== undefined) {
        if (out.worstLatencyMs === undefined || snap.lastLatencyMs > out.worstLatencyMs) {
          out.worstLatencyMs = snap.lastLatencyMs;
          out.worstProviderId = snap.providerId;
        }
      }
      if (snap.quotaLow) out.quotaLowProviders.push(snap.providerId);
    }
    return out;
  }

  /** Subscribe to transition alerts. Returns an unsubscribe function. */
  subscribe(listener: ProviderHealthAlertListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Forget recorded state. With an id: that provider goes back to
   * `unknown` (samples + its alerts dropped). Without one: everything
   * is forgotten. Does NOT stop a running timer (use stop()).
   */
  reset(providerId?: string): void {
    if (providerId === undefined) {
      this.states.clear();
      this.alerts.length = 0;
      return;
    }
    const id = String(providerId).trim();
    this.states.delete(id);
    for (let i = this.alerts.length - 1; i >= 0; i -= 1) {
      if (this.alerts[i]?.providerId === id) this.alerts.splice(i, 1);
    }
  }

  /**
   * Start periodic probing of the given providers (default every 5
   * minutes, clamped to >= 30 s). Safe to call twice — the second call
   * restarts the timer with the new list/interval. The timer is
   * unref'd and never keeps the process alive.
   */
  start(providerIds: string[], intervalMs: number = PROVIDER_HEALTH_DEFAULT_INTERVAL_MS): void {
    this.stop();
    this.timerProviderIds = providerIds.map((id) => String(id).trim()).filter(Boolean);
    this.timerIntervalMs =
      Number.isFinite(intervalMs) && intervalMs >= PROVIDER_HEALTH_MIN_INTERVAL_MS
        ? intervalMs
        : PROVIDER_HEALTH_MIN_INTERVAL_MS;
    this.timerStopped = false;
    this.scheduleNext();
  }

  /** Stop periodic probing (in-flight probe still finishes). */
  stop(): void {
    this.timerStopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** True while the periodic timer is armed. */
  isRunning(): boolean {
    return !this.timerStopped;
  }

  private scheduleNext(): void {
    if (this.timerStopped) return;
    this.timer = setTimeout(() => {
      void this.checkAll(this.timerProviderIds)
        .catch(() => undefined)
        .finally(() => this.scheduleNext());
    }, this.timerIntervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as unknown as { unref(): void }).unref();
    }
  }

  private stateFor(providerId: string): ProviderHealthState {
    let state = this.states.get(providerId);
    if (!state) {
      state = {
        status: 'unknown',
        samples: [],
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        checksTotal: 0,
        failuresTotal: 0,
        quotaLow: false,
      };
      this.states.set(providerId, state);
    }
    return state;
  }

  private labelFor(providerId: string): string {
    return this.labels[providerId] ?? providerId;
  }

  private snapshotFor(providerId: string, state: ProviderHealthState): ProviderHealthSnapshot {
    const last = state.samples[state.samples.length - 1];
    const successes = state.samples.filter((s) => s.ok).length;
    const snapshot: ProviderHealthSnapshot = {
      providerId,
      label: this.labelFor(providerId),
      status: state.status,
      consecutiveFailures: state.consecutiveFailures,
      consecutiveSuccesses: state.consecutiveSuccesses,
      checksTotal: state.checksTotal,
      failuresTotal: state.failuresTotal,
      uptimePct: state.samples.length > 0 ? Math.round((successes / state.samples.length) * 1000) / 10 : null,
      samplesKept: state.samples.length,
      quotaLow: state.quotaLow,
    };
    if (last) {
      snapshot.lastLatencyMs = last.latencyMs;
      snapshot.lastCheckedAtMs = last.checkedAtMs;
      if (last.error !== undefined) snapshot.lastError = last.error;
      if (last.statusCode !== undefined) snapshot.lastStatusCode = last.statusCode;
    } else if (state.lastError !== undefined) {
      snapshot.lastError = state.lastError;
    }
    if (state.quota) snapshot.quota = { ...state.quota };
    return snapshot;
  }

  private emitAlert(
    providerId: string,
    kind: ProviderHealthAlertKind,
    message: string,
    atMs: number,
    latencyMs?: number,
    error?: string,
  ): void {
    this.alertSeq += 1;
    const alert: ProviderHealthAlert = {
      id: `${providerId}-${kind}-${atMs}-${this.alertSeq}`,
      providerId,
      kind,
      message,
      atMs,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(error !== undefined ? { error } : {}),
    };
    this.alerts.push(alert);
    if (this.alerts.length > this.maxAlerts) {
      this.alerts.splice(0, this.alerts.length - this.maxAlerts);
    }
    this.onAlert?.(alert);
    for (const listener of [...this.listeners]) {
      try {
        listener(alert);
      } catch {
        // A broken listener must never break monitoring.
      }
    }
  }
}
