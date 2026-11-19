/**
 * Latency stats v30 (v1.44, Doi T5) — do tre DO DUOC theo model.
 *
 * Catalog v30 chi co `estimatedLatencyMs` khai bao; file nay luu so do
 * that: moi lan goi model xong, host ghi lai do tre that (ms) + thanh
 * cong hay that. Router dung EWMA + p50/p95 tu so do that, fallback ve
 * so khai bao khi chua co mau.
 *
 * - Mau cap theo model (toi da MAX_SAMPLES_V30 mau moi nhat).
 * - EWMA (alpha 0.3) phan anh nhanh thay doi gan day hon trung binh cong.
 * - p50/p95 tinh tren mau da sap xep (noi suy tuyen tinh).
 * - Chi phi: uoc tinh theo gia catalog + so token that (neu co).
 * Thuan logic, khong goi model that, khong goi mang.
 */
import {
  estimateModelCostV30,
  modelCatalogKeyV30,
  type ModelCatalogEntryV30,
} from './modelCatalogV30';

/** He so EWMA — mau moi chiem 30%. */
export const LATENCY_EWMA_ALPHA_V30 = 0.3;
/** So mau toi da giu lai moi model. */
export const MAX_LATENCY_SAMPLES_V30 = 200;
/** So mau toi thieu de p95 co y nghia. */
export const MIN_SAMPLES_FOR_P95_V30 = 10;

/** Mot mau do tre that. */
export interface LatencySampleV30 {
  /** Do tre (ms). */
  latencyMs: number;
  /** Lan goi co thanh cong khong (that thi van ghi do tre neu co). */
  success: boolean;
  /** Luc ghi mau (epoch ms). */
  at: number;
}

/** Thong ke do tre cua 1 model. */
export interface LatencyStatsV30 {
  provider: string;
  modelId: string;
  /** So mau da ghi. */
  samples: number;
  /** EWMA do tre (ms). */
  ewmaMs: number;
  /** Trung binh cong (ms). */
  meanMs: number;
  /** p50 (ms) — null khi chua co mau. */
  p50Ms: number | null;
  /** p95 (ms) — null khi chua du mau. */
  p95Ms: number | null;
  /** So lan that / tong so lan goi. */
  failures: number;
  /** Ti le that 0..1. */
  failureRate: number;
  /** Lan cap nhat cuoi (epoch ms). */
  lastUpdatedAt: number;
}

/** Tinh phan vi (percentile) tren mang so da sap xep, noi suy tuyen tinh. */
export function percentileRouterV30(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/** Tinh EWMA tu danh sach mau (theo thu tu ghi). */
export function ewmaV30(samples: LatencySampleV30[]): number {
  let ewma = 0;
  let first = true;
  for (const s of samples) {
    if (first) {
      ewma = s.latencyMs;
      first = false;
    } else {
      ewma = LATENCY_EWMA_ALPHA_V30 * s.latencyMs + (1 - LATENCY_EWMA_ALPHA_V30) * ewma;
    }
  }
  return ewma;
}

/**
 * Store do tre do duoc — giu in-memory, host co the persist bang cach
 * doc `snapshotV30()` / nap lai bang `restoreV30()`.
 */
export class LatencyStatsStoreV30 {
  private samplesByKey = new Map<string, LatencySampleV30[]>();

  /** Ghi 1 mau do tre that cho model. Mau qua cu bi cat (toi da 200). */
  record(
    provider: string,
    modelId: string,
    latencyMs: number,
    success = true,
    at = Date.now(),
  ): void {
    if (!provider || !modelId) return;
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    const key = modelCatalogKeyV30(provider, modelId);
    const list = this.samplesByKey.get(key) ?? [];
    list.push({ latencyMs, success, at });
    if (list.length > MAX_LATENCY_SAMPLES_V30) {
      list.splice(0, list.length - MAX_LATENCY_SAMPLES_V30);
    }
    this.samplesByKey.set(key, list);
  }

  /** Thong ke cua 1 model — null khi chua co mau nao. */
  stats(provider: string, modelId: string): LatencyStatsV30 | null {
    const key = modelCatalogKeyV30(provider, modelId);
    const samples = this.samplesByKey.get(key);
    if (!samples || samples.length === 0) return null;
    const sorted = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const failures = samples.filter((s) => !s.success).length;
    return {
      provider,
      modelId,
      samples: samples.length,
      ewmaMs: ewmaV30(samples),
      meanMs: mean,
      p50Ms: percentileRouterV30(sorted, 50),
      p95Ms:
        samples.length >= MIN_SAMPLES_FOR_P95_V30
          ? percentileRouterV30(sorted, 95)
          : null,
      failures,
      failureRate: failures / samples.length,
      lastUpdatedAt: samples[samples.length - 1].at,
    };
  }

  /**
   * Do tre hieu dung cua 1 model: EWMA neu co mau, khong thi so khai bao
   * trong catalog. Router luon dung ham nay (khong bao gio crash vi
   * thieu mau).
   */
  effectiveLatencyMs(
    entry: ModelCatalogEntryV30,
  ): { ms: number; measured: boolean; samples: number } {
    const s = this.stats(entry.provider, entry.modelId);
    if (!s) {
      return {
        ms: entry.estimatedLatencyMs,
        measured: false,
        samples: 0,
      };
    }
    return { ms: s.ewmaMs, measured: true, samples: s.samples };
  }

  /** Tat ca thong ke hien co (de hien thi / bao cao). */
  allStats(): LatencyStatsV30[] {
    const out: LatencyStatsV30[] = [];
    for (const key of this.samplesByKey.keys()) {
      const [provider, modelId] = key.split('::');
      const s = this.stats(provider, modelId);
      if (s) out.push(s);
    }
    return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
  }

  /** So model da co mau. */
  get modelCount(): number {
    return this.samplesByKey.size;
  }

  /** Xoa mau cua 1 model. */
  clear(provider: string, modelId: string): void {
    this.samplesByKey.delete(modelCatalogKeyV30(provider, modelId));
  }

  /** Xoa het mau. */
  clearAll(): void {
    this.samplesByKey.clear();
  }

  /** Snapshot de persist (host tu luu file). */
  snapshotV30(): Record<string, LatencySampleV30[]> {
    const out: Record<string, LatencySampleV30[]> = {};
    for (const [key, samples] of this.samplesByKey) {
      out[key] = samples.map((s) => ({ ...s }));
    }
    return out;
  }

  /** Nap lai snapshot da persist (chi nhan mau hop le). */
  restoreV30(snapshot: Record<string, LatencySampleV30[]>): number {
    let restored = 0;
    for (const [key, samples] of Object.entries(snapshot ?? {})) {
      if (!Array.isArray(samples)) continue;
      const valid = samples.filter(
        (s) =>
          s &&
          Number.isFinite(s.latencyMs) &&
          s.latencyMs >= 0 &&
          typeof s.success === 'boolean' &&
          Number.isFinite(s.at),
      );
      if (valid.length > 0) {
        this.samplesByKey.set(key, valid.slice(-MAX_LATENCY_SAMPLES_V30));
        restored += valid.length;
      }
    }
    return restored;
  }
}

/** Uoc tinh chi phi 1 lan goi theo entry catalog + token that (neu co). */
export function estimateCallCostV30(
  entry: ModelCatalogEntryV30,
  inputTokens: number,
  outputTokens: number,
): number {
  return estimateModelCostV30(entry, inputTokens, outputTokens);
}

/**
 * Diem latency chuan hoa 0..1 (1 = nhanh nhat): dua tren do tre hieu
 * dung so voi tran `maxLatencyMs` ma user chap nhan. Qua tran -> 0.
 */
export function latencyScoreV30(
  effectiveLatencyMs: number,
  maxLatencyMs: number,
): number {
  if (maxLatencyMs <= 0) return 1;
  if (effectiveLatencyMs >= maxLatencyMs) return 0;
  return 1 - effectiveLatencyMs / maxLatencyMs;
}

/**
 * Diem chi phi chuan hoa 0..1 (1 = re nhat): dua tren chi phi uoc tinh
 * so voi tran `maxCostUsd` ma user chap nhan. Qua tran -> 0.
 * Model mien phi (cost 0) luon duoc 1.
 */
export function costScoreV30(
  estimatedCostUsd: number,
  maxCostUsd: number,
): number {
  if (estimatedCostUsd <= 0) return 1;
  if (maxCostUsd <= 0) return 0;
  if (estimatedCostUsd >= maxCostUsd) return 0;
  return 1 - estimatedCostUsd / maxCostUsd;
}
