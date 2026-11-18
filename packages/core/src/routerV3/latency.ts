/**
 * Latency tracker (v1.18, Doi T3) — do latency that, rolling window.
 *
 * Router v2 cham diem latency bang so uoc luong co dinh; router v3
 * do that: moi call thanh cong ghi mot mau (ms) vao window cua
 * provider+model (toi da 100 mau moi nhat), p50/p90 tinh tu window.
 * Mau loi khong tinh vao p50/p90 nhung tinh vao errorRate. Thuan,
 * khong I/O, `now` injectable de test.
 */

import type { LatencySample, LatencyStats } from './types';

/** So mau toi da giu trong window moi provider+model. */
export const LATENCY_WINDOW_SIZE = 100;

/** So mau toi thieu de p50/p90 co y nghia (it hon thi dung mean). */
export const LATENCY_MIN_SAMPLES = 3;

/** Khoa window: `${providerId}::${modelId}`. */
export function latencyKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/** Tinh percentile (0..100) tu mang so da sap xep tang dan. */
export function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, p));
  const index = Math.ceil((clamped / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))] ?? 0;
}

/** Tinh thong ke tu cac mau (mau loi chi tinh errorRate). */
export function statsFromSamples(samples: readonly LatencySample[], now: number): LatencyStats {
  const okLatencies = samples
    .filter((s) => s.ok && Number.isFinite(s.latencyMs) && s.latencyMs >= 0)
    .map((s) => s.latencyMs)
    .sort((a, b) => a - b);
  const total = samples.length;
  const errorCount = samples.filter((s) => !s.ok).length;
  if (okLatencies.length === 0) {
    return {
      count: 0,
      meanMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      minMs: 0,
      maxMs: 0,
      errorRate: total > 0 ? errorCount / total : 0,
      updatedAt: now,
    };
  }
  const sum = okLatencies.reduce((acc, v) => acc + v, 0);
  return {
    count: okLatencies.length,
    meanMs: sum / okLatencies.length,
    p50Ms: percentile(okLatencies, 50),
    p90Ms: percentile(okLatencies, 90),
    minMs: okLatencies[0] ?? 0,
    maxMs: okLatencies[okLatencies.length - 1] ?? 0,
    errorRate: total > 0 ? errorCount / total : 0,
    updatedAt: now,
  };
}

/**
 * LatencyTracker — window rolling per provider+model.
 * Ghi mau bang `record(providerId, modelId, latencyMs, ok)`; doc
 * thong ke bang `stats(...)`; latency uoc tinh de route bang
 * `estimatedLatencyMs(...)` (p50 khi du mau, mean khi it mau,
 * fallback khi chua co mau).
 */
export class LatencyTracker {
  private readonly windows = new Map<string, LatencySample[]>();
  private readonly windowSize: number;

  constructor(opts?: { windowSize?: number }) {
    this.windowSize = opts?.windowSize ?? LATENCY_WINDOW_SIZE;
  }

  /** Ghi mot mau latency (ms). Latency am / NaN bi bo. */
  record(providerId: string, modelId: string, latencyMs: number, ok = true, now: number = Date.now()): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    const key = latencyKey(providerId, modelId);
    const window = this.windows.get(key) ?? [];
    window.push({ latencyMs, ok, at: now });
    while (window.length > this.windowSize) window.shift();
    this.windows.set(key, window);
  }

  /** Thong ke cua mot provider+model (undefined khi chua co mau). */
  stats(providerId: string, modelId: string, now: number = Date.now()): LatencyStats | undefined {
    const window = this.windows.get(latencyKey(providerId, modelId));
    if (!window || window.length === 0) return undefined;
    return statsFromSamples(window, now);
  }

  /**
   * Latency uoc tinh (ms) de route: p50 khi du mau, mean khi it mau,
   * `fallbackMs` khi chua co mau nao.
   */
  estimatedLatencyMs(providerId: string, modelId: string, fallbackMs: number): number {
    const stats = this.stats(providerId, modelId);
    if (!stats || stats.count === 0) return fallbackMs;
    if (stats.count >= LATENCY_MIN_SAMPLES) return stats.p50Ms;
    return stats.meanMs;
  }

  /** So mau hien co cua mot provider+model. */
  sampleCount(providerId: string, modelId: string): number {
    return this.windows.get(latencyKey(providerId, modelId))?.length ?? 0;
  }

  /** Tat ca provider+model da co mau. */
  trackedKeys(): { providerId: string; modelId: string }[] {
    return [...this.windows.keys()].map((key) => {
      const [providerId, modelId] = key.split('::');
      return { providerId: providerId ?? '', modelId: modelId ?? '' };
    });
  }

  /** Xoa window cua mot provider+model. */
  clear(providerId: string, modelId: string): boolean {
    return this.windows.delete(latencyKey(providerId, modelId));
  }

  /** Xoa toan bo so do. */
  clearAll(): void {
    this.windows.clear();
  }

  /** Snapshot thong ke tat ca provider+model (de UI ve). */
  snapshot(now: number = Date.now()): Record<string, LatencyStats> {
    const out: Record<string, LatencyStats> = {};
    for (const [key, window] of this.windows) {
      out[key] = statsFromSamples(window, now);
    }
    return out;
  }
}
