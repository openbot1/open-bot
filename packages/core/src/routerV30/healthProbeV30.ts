/**
 * Health probe v30 (v1.44, Doi T5) — kiem tra suc khoe dinh ky tung
 * provider / model, cache ket qua, hien thi trang thai.
 *
 * Noi tiep health probe v29 (mock prober): v30 them
 * - cache co TTL: ket qua probe duoc giu `cacheTtlMs`; trong TTL thi
 *   `getStatus` tra cache, khong probe lai (tranh spam provider).
 * - `needsProbe` — biet provider nao da stale va can probe lai (host
 *   goi theo lich, vd moi 5 phut, chi probe cai stale).
 * - dem loi lien tiep: 3 loi lien tiep -> down; 1 loi le -> degraded
 *   (khong nhay trang thai vi 1 lan cham mang).
 * - tom tat suc khoe: so provider healthy/degraded/down/unknown + model
 *   te nhat.
 *
 * Prober la ham host truyen vao (nhe: vd list-models hoac 1 cau ping
 * ngan). Prober mac dinh la mock tra 'unknown' — file nay KHONG tu goi
 * API live, KHONG doc credential.
 */

/** Trang thai suc khoe. */
export type ProviderHealthStatusV30 = 'healthy' | 'degraded' | 'down' | 'unknown';

/** Ket qua 1 lan probe. */
export interface HealthProbeResultV30 {
  provider: string;
  /** Model cu the (neu probe theo model). */
  modelId?: string;
  status: ProviderHealthStatusV30;
  /** Do tre probe (ms). */
  latencyMs: number;
  /** Luc probe (epoch ms). */
  checkedAt: number;
  /** Ghi chu (vd thong diep loi, hoac 'ok'). */
  detail: string;
  /** So loi lien tiep tinh den lan nay. */
  consecutiveFailures: number;
  /** Lan probe nay co that khong (de dem totalFailures). */
  failed?: boolean;
}

/** Nguong mac dinh. */
export const HEALTH_CACHE_TTL_MS_V30 = 5 * 60 * 1000;
export const HEALTH_DEGRADED_LATENCY_MS_V30 = 5000;
export const HEALTH_DOWN_AFTER_FAILURES_V30 = 3;

/** Prober nhe do host cung cap (tra ve status + latency + detail). */
export type HealthProberV30 = (
  provider: string,
  modelId?: string,
) => Promise<{
  ok: boolean;
  latencyMs: number;
  detail?: string;
}>;

/** Prober mac dinh (mock): khong goi mang, tra unknown de host thay the. */
export async function defaultMockProberV30(
  _provider: string,
  _modelId?: string,
): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  return { ok: false, latencyMs: 0, detail: 'no prober configured (mock)' };
}

/** Trang thai hien tai cua 1 provider/model (cache + dem loi). */
export interface TrackedHealthV30 {
  provider: string;
  modelId?: string;
  status: ProviderHealthStatusV30;
  latencyMs: number;
  checkedAt: number;
  detail: string;
  consecutiveFailures: number;
  /** Tong so lan probe. */
  totalProbes: number;
  /** Tong so lan that. */
  totalFailures: number;
}

/**
 * Tracker suc khoe — giu in-memory; host co the persist bang
 * `snapshotV30()` / `restoreV30()`.
 */
export class ProviderHealthTrackerV30 {
  private tracked = new Map<string, TrackedHealthV30>();
  /** TTL cache (ms) — trong TTL thi getStatus tra cache cu. */
  cacheTtlMs: number;

  constructor(cacheTtlMs = HEALTH_CACHE_TTL_MS_V30) {
    this.cacheTtlMs = cacheTtlMs;
  }

  private key(provider: string, modelId?: string): string {
    return modelId ? `${provider}::${modelId}` : provider;
  }

  /** Ghi ket qua 1 lan probe (cap nhat dem loi lien tiep + trang thai). */
  recordProbeResult(
    result: HealthProbeResultV30,
  ): TrackedHealthV30 {
    const key = this.key(result.provider, result.modelId);
    const prev = this.tracked.get(key);
    // Tin so loi lien tiep do caller tinh (probe() dem tu lich su);
    // recordProbeResult chi luu lai, khong tu tinh lai.
    const consecutiveFailures = result.consecutiveFailures;
    let status = result.status;
    if (result.status === 'unknown' && prev) status = prev.status;
    const entry: TrackedHealthV30 = {
      provider: result.provider,
      modelId: result.modelId,
      status,
      latencyMs: result.latencyMs,
      checkedAt: result.checkedAt,
      detail: result.detail,
      consecutiveFailures,
      totalProbes: (prev?.totalProbes ?? 0) + 1,
      totalFailures:
        (prev?.totalFailures ?? 0) +
        ((result.failed ?? result.status === 'down') ? 1 : 0),
    };
    this.tracked.set(key, entry);
    return entry;
  }

  /**
   * Probe 1 provider/model bang prober host dua vao, roi ghi ket qua.
   * Prober chi tra ok/latency — tracker tu xep loai: ok + nhanh ->
   * healthy; ok + cham (>= degraded threshold) -> degraded; that ->
   * down (dem loi lien tiep).
   */
  async probe(
    provider: string,
    prober: HealthProberV30,
    modelId?: string,
    now = Date.now(),
  ): Promise<TrackedHealthV30> {
    let raw: { ok: boolean; latencyMs: number; detail?: string };
    try {
      raw = await prober(provider, modelId);
    } catch (err) {
      raw = {
        ok: false,
        latencyMs: 0,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const prev = this.tracked.get(this.key(provider, modelId));
    const failures = raw.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
    let status: ProviderHealthStatusV30;
    if (!raw.ok) {
      status = failures >= HEALTH_DOWN_AFTER_FAILURES_V30 ? 'down' : 'degraded';
    } else if (raw.latencyMs >= HEALTH_DEGRADED_LATENCY_MS_V30) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }
    return this.recordProbeResult({
      provider,
      modelId,
      status,
      latencyMs: raw.latencyMs,
      checkedAt: now,
      detail: raw.detail ?? (raw.ok ? 'ok' : 'probe failed'),
      consecutiveFailures: failures,
      failed: !raw.ok,
    });
  }

  /** Trang thai hien tai (cache) — null neu chua probe bao gio. */
  getStatus(
    provider: string,
    modelId?: string,
  ): TrackedHealthV30 | null {
    return this.tracked.get(this.key(provider, modelId)) ?? null;
  }

  /** Provider/model nay co can probe lai khong (het TTL hoac chua co). */
  needsProbe(provider: string, modelId?: string, now = Date.now()): boolean {
    const entry = this.tracked.get(this.key(provider, modelId));
    if (!entry) return true;
    return now - entry.checkedAt > this.cacheTtlMs;
  }

  /** Probe hang loat chi cai nao stale (tra danh sach vua probe). */
  async probeStale(
    targets: Array<{ provider: string; modelId?: string }>,
    prober: HealthProberV30,
    now = Date.now(),
  ): Promise<TrackedHealthV30[]> {
    const out: TrackedHealthV30[] = [];
    for (const t of targets) {
      if (!this.needsProbe(t.provider, t.modelId, now)) continue;
      out.push(await this.probe(t.provider, prober, t.modelId, now));
    }
    return out;
  }

  /** Tat ca trang thai dang theo doi (sap xep theo provider/model). */
  allStatuses(): TrackedHealthV30[] {
    return [...this.tracked.values()].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        (a.modelId ?? '').localeCompare(b.modelId ?? ''),
    );
  }

  /** Tom tat suc khoe toan bo provider. */
  summary(): {
    total: number;
    healthy: number;
    degraded: number;
    down: number;
    unknown: number;
    /** Provider/model te nhat (nhieu loi lien tiep nhat). */
    worst: TrackedHealthV30 | null;
    /** Ti le healthy 0..1 (0 khi chua co gi). */
    healthyRatio: number;
  } {
    const all = this.allStatuses();
    let healthy = 0;
    let degraded = 0;
    let down = 0;
    let unknown = 0;
    let worst: TrackedHealthV30 | null = null;
    for (const e of all) {
      if (e.status === 'healthy') healthy += 1;
      else if (e.status === 'degraded') degraded += 1;
      else if (e.status === 'down') down += 1;
      else unknown += 1;
      if (!worst || e.consecutiveFailures > worst.consecutiveFailures) {
        worst = e;
      }
    }
    return {
      total: all.length,
      healthy,
      degraded,
      down,
      unknown,
      worst,
      healthyRatio: all.length === 0 ? 0 : healthy / all.length,
    };
  }

  /** Provider nao dang down (de router tranh). */
  downProviders(): string[] {
    return this.allStatuses()
      .filter((e) => e.status === 'down')
      .map((e) => e.provider);
  }

  /** Xoa trang thai 1 provider/model. */
  clear(provider: string, modelId?: string): void {
    this.tracked.delete(this.key(provider, modelId));
  }

  clearAll(): void {
    this.tracked.clear();
  }

  /** Snapshot de persist. */
  snapshotV30(): TrackedHealthV30[] {
    return this.allStatuses().map((e) => ({ ...e }));
  }

  /** Nap lai snapshot (chi nhan muc hop le). */
  restoreV30(snapshot: TrackedHealthV30[]): number {
    let restored = 0;
    for (const e of snapshot ?? []) {
      if (!e || typeof e.provider !== 'string' || !e.provider) continue;
      if (
        !['healthy', 'degraded', 'down', 'unknown'].includes(e.status)
      ) {
        continue;
      }
      this.tracked.set(this.key(e.provider, e.modelId), { ...e });
      restored += 1;
    }
    return restored;
  }
}

/** Danh sach provider mac dinh nen probe (tu catalog — host tu lay). */
export function healthProbeTargetsFromCatalogV30(
  providers: string[],
): Array<{ provider: string }> {
  return providers.map((provider) => ({ provider }));
}
