/**
 * Health probe v29 (v1.42, Doi T5) — suc khoe tung provider (mock probe).
 *
 * Moi provider co lich su probe (ring buffer): trang thai hien tai,
 * do tre do duoc, so loi lien tiep, lan loi cuoi, uptime ratio.
 * Prober duoc host inject — mac dinh la mock probe xac dinh (hash ten
 * provider -> do tre gia), KHONG goi network that, KHONG doc key.
 *
 * Khac healthProbeV116 (probe endpoint local loopback that qua HTTP):
 * v29 probe o muc PROVIDER (openai/gemini/anthropic/xai/ollama...),
 * dung mock de router co the ra quyet dinh ma khong phu thuoc mang.
 */

/** Trang thai suc khoe mot provider. */
export type ProviderHealthStatusV29 = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/** Ket qua mot lan probe (mock). */
export interface ProviderProbeResultV29 {
  provider: string;
  status: ProviderHealthStatusV29;
  /** true = probe tra loi (ke ca loi ung dung — khac voi khong tra loi). */
  reachable: boolean;
  /** Do tre do duoc (ms). */
  latencyMs: number;
  /** Loi ngan (neu co). */
  error?: string;
  checkedAt: number;
}

/** Ket qua tra ve tu prober (host/mock). */
export interface MockProbeOutcomeV29 {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Prober: host cung cap (mock trong test/tool). */
export type MockProberV29 = (provider: string) => Promise<MockProbeOutcomeV29> | MockProbeOutcomeV29;

/** Lich su suc khoe mot provider. */
export interface ProviderHealthRecordV29 {
  provider: string;
  status: ProviderHealthStatusV29;
  lastLatencyMs: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalProbes: number;
  totalFailures: number;
  /** Ti le probe thanh cong trong lich su giu lai (0..1). */
  uptimeRatio: number | null;
  /** So probe giu trong lich su (ring buffer). */
  historySize: number;
}

/** Nguong trang thai (ms). */
export const HEALTH_SLOW_THRESHOLD_MS_V29 = 1500;
export const HEALTH_MAX_HISTORY_V29 = 50;
/** So loi lien tiep thi danh unhealthy. */
export const HEALTH_UNHEALTHY_FAILURES_V29 = 3;

/** Hash xac dinh (FNV-1a) — mock latency on dinh theo ten provider. */
export function hashStringV29(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Mock prober mac dinh: do tre gia xac dinh theo ten provider
 * (120ms + hash % 680), khong goi network. Provider trong danh sach
 * `failProviders` se tra loi that bai (de test fallback/health).
 */
export function defaultMockProberV29(failProviders: string[] = []): MockProberV29 {
  const failSet = new Set(failProviders);
  return (provider: string): MockProbeOutcomeV29 => {
    if (failSet.has(provider)) {
      return { ok: false, latencyMs: 0, error: `mock probe that bai cho provider "${provider}".` };
    }
    const latencyMs = 120 + (hashStringV29(provider) % 680);
    return { ok: true, latencyMs };
  };
}

/** Tinh trang thai tu ket qua probe + lich su loi lien tiep. */
export function deriveProviderStatusV29(
  outcome: MockProbeOutcomeV29,
  consecutiveFailures: number,
  slowThresholdMs: number = HEALTH_SLOW_THRESHOLD_MS_V29,
): ProviderHealthStatusV29 {
  if (!outcome.ok) {
    return consecutiveFailures + 1 >= HEALTH_UNHEALTHY_FAILURES_V29 ? 'unhealthy' : 'degraded';
  }
  if (outcome.latencyMs >= slowThresholdMs) return 'degraded';
  return 'healthy';
}

/**
 * Tracker suc khoe provider.
 *
 * - probeProvider: chay prober (mock), ghi lich su, cap nhat status.
 * - probeAll: probe nhieu provider, tra tung ket qua + provider khoe nhat.
 * - summary / healthiestProviders / staleProviders: cho router + UI.
 */
export class ProviderHealthTrackerV29 {
  private history = new Map<string, ProviderProbeResultV29[]>();
  private lastError = new Map<string, string | null>();
  private consecutiveFailures = new Map<string, number>();
  private readonly slowThresholdMs: number;
  private readonly maxHistory: number;

  constructor(
    private readonly now: () => number = () => Date.now(),
    options: { slowThresholdMs?: number; maxHistory?: number } = {},
  ) {
    this.slowThresholdMs = options.slowThresholdMs ?? HEALTH_SLOW_THRESHOLD_MS_V29;
    this.maxHistory = options.maxHistory ?? HEALTH_MAX_HISTORY_V29;
  }

  /** Probe mot provider (mock prober mac dinh neu khong truyen). */
  async probeProvider(provider: string, prober: MockProberV29 = defaultMockProberV29()): Promise<ProviderProbeResultV29> {
    if (!provider || provider.trim() === '') throw new Error('provider khong duoc rong.');
    const checkedAt = this.now();
    let outcome: MockProbeOutcomeV29;
    try {
      outcome = await prober(provider);
    } catch (err) {
      outcome = { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
    }
    const prevFailures = this.consecutiveFailures.get(provider) ?? 0;
    const status = deriveProviderStatusV29(outcome, prevFailures, this.slowThresholdMs);
    const result: ProviderProbeResultV29 = {
      provider,
      status,
      reachable: outcome.ok,
      latencyMs: outcome.latencyMs,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      checkedAt,
    };
    const list = this.history.get(provider) ?? [];
    list.push(result);
    while (list.length > this.maxHistory) list.shift();
    this.history.set(provider, list);
    this.consecutiveFailures.set(provider, outcome.ok ? 0 : prevFailures + 1);
    this.lastError.set(provider, outcome.ok ? null : (outcome.error ?? 'probe that bai.'));
    return result;
  }

  /** Probe nhieu provider (tuan tu — tra ket qua tung provider). */
  async probeAll(providers: string[], prober?: MockProberV29): Promise<ProviderProbeResultV29[]> {
    const results: ProviderProbeResultV29[] = [];
    for (const provider of providers) {
      results.push(await this.probeProvider(provider, prober));
    }
    return results;
  }

  /** Lich su probe cua mot provider (ban sao). */
  historyFor(provider: string): ProviderProbeResultV29[] {
    return [...(this.history.get(provider) ?? [])];
  }

  /** Ban ghi suc khoe hien tai cua mot provider. */
  recordFor(provider: string): ProviderHealthRecordV29 {
    const list = this.history.get(provider) ?? [];
    const last = list.length > 0 ? list[list.length - 1] : undefined;
    const failures = list.filter((r) => !r.reachable).length;
    return {
      provider,
      status: last ? last.status : 'unknown',
      lastLatencyMs: last ? last.latencyMs : null,
      lastCheckedAt: last ? last.checkedAt : null,
      lastError: this.lastError.get(provider) ?? null,
      consecutiveFailures: this.consecutiveFailures.get(provider) ?? 0,
      totalProbes: list.length,
      totalFailures: failures,
      uptimeRatio: list.length > 0 ? (list.length - failures) / list.length : null,
      historySize: list.length,
    };
  }

  /** Tat ca provider da probe. */
  providers(): string[] {
    return [...this.history.keys()];
  }

  /** Provider co dang khoe khong (healthy moi tinh la khoe). */
  isProviderHealthy(provider: string): boolean {
    return this.recordFor(provider).status === 'healthy';
  }

  /** Provider khoe nhat truoc (healthy -> do tre thap -> uptime cao). */
  healthiestProviders(): ProviderHealthRecordV29[] {
    const rank = (s: ProviderHealthStatusV29): number =>
      s === 'healthy' ? 0 : s === 'degraded' ? 1 : s === 'unknown' ? 2 : 3;
    return this.providers()
      .map((p) => this.recordFor(p))
      .sort((a, b) => {
        if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
        const aLat = a.lastLatencyMs ?? Number.POSITIVE_INFINITY;
        const bLat = b.lastLatencyMs ?? Number.POSITIVE_INFINITY;
        if (aLat !== bLat) return aLat - bLat;
        return (b.uptimeRatio ?? 0) - (a.uptimeRatio ?? 0);
      });
  }

  /** Provider da lau khong probe (qua maxAgeMs) — can probe lai. */
  staleProviders(maxAgeMs: number, now?: number): string[] {
    const at = now ?? this.now();
    return this.providers().filter((p) => {
      const rec = this.recordFor(p);
      return rec.lastCheckedAt === null || at - rec.lastCheckedAt > maxAgeMs;
    });
  }

  /** Tom tat suc khoe toan bo provider. */
  summary(): {
    totalProviders: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
    unknown: number;
    worstStatus: ProviderHealthStatusV29;
    records: ProviderHealthRecordV29[];
  } {
    const records = this.providers().map((p) => this.recordFor(p));
    const count = (s: ProviderHealthStatusV29): number => records.filter((r) => r.status === s).length;
    const worst: ProviderHealthStatusV29 = count('unhealthy') > 0
      ? 'unhealthy'
      : count('degraded') > 0
        ? 'degraded'
        : count('healthy') > 0
          ? 'healthy'
          : 'unknown';
    return {
      totalProviders: records.length,
      healthy: count('healthy'),
      degraded: count('degraded'),
      unhealthy: count('unhealthy'),
      unknown: count('unknown'),
      worstStatus: worst,
      records,
    };
  }

  /** Xoa lich su mot provider. */
  clearProvider(provider: string): void {
    this.history.delete(provider);
    this.lastError.delete(provider);
    this.consecutiveFailures.delete(provider);
  }

  /** Xoa toan bo lich su. */
  clearAll(): void {
    this.history.clear();
    this.lastError.clear();
    this.consecutiveFailures.clear();
  }
}
