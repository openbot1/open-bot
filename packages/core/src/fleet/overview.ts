/**
 * Fleet overview v3 — one fleet-wide picture for the console.
 *
 * The v2 console shows one row per bot. The overview answers the
 * fleet-level questions on top of the same data (pure projection of
 * FleetStatusView[] + quotas + alerts, no new disk reads):
 *
 * - totals: workspaces by state, allocated vs actually used CPU/RAM/
 *   disk, quota alerts by level;
 * - top consumers: the bots using the most RAM/disk/CPU-seconds;
 * - capacity forecast: for each resource, a straight-line projection
 *   from the usage samples (least-squares slope over time) says when
 *   the fleet runs out — or honestly reports 'unknown' when there are
 *   too few samples, the slope is flat/negative, or the resource was
 *   never measured. A forecast is an estimate, never a promise, and
 *   the UI must label it as such.
 *
 * All inputs are plain data; nothing here touches the registry, the
 * service manager, or the network.
 */

import type { FleetStatusView, FleetUsageSample } from './types';
import type { BotQuota, QuotaAlert } from './quotas';

/** Fleet-wide totals for one resource. */
export interface FleetResourceTotals {
  /** Sum of what workspaces were allocated. */
  allocated: number;
  /** Sum of the latest measured use (null when nothing was measured). */
  used: number | null;
  /** Used / allocated — null when nothing was measured. */
  usedPercent: number | null;
  /** How many workspaces contributed a measurement. */
  measuredWorkspaces: number;
}

/** One bot's share of fleet use, for the top-consumer lists. */
export interface FleetTopConsumer {
  workspaceId: string;
  name: string;
  /** Bytes (RAM/disk) or CPU seconds, depending on the list. */
  used: number;
  /** Share of the fleet total for that resource (0..1). */
  share: number;
}

/** Capacity forecast for one resource (linear projection). */
export interface FleetCapacityForecast {
  resource: 'cpu' | 'ram' | 'disk';
  /** Epoch ms when the fleet is projected to run out — null when unknown. */
  runsOutAt: number | null;
  /** Days from `at` until projected exhaustion — null when unknown. */
  daysUntilFull: number | null;
  /** Why there is no forecast (e.g. 'not-enough-samples'). */
  reason?: string;
  /** Slope the forecast is based on (units per day) — null when unknown. */
  growthPerDay: number | null;
  /** Samples the forecast used. */
  samplesUsed: number;
}

/** The whole fleet in one object (what the console overview tab renders). */
export interface FleetOverview {
  workspaces: number;
  byServiceState: Record<string, number>;
  byWorkspaceStatus: Record<string, number>;
  cpu: FleetResourceTotals;
  ram: FleetResourceTotals;
  disk: FleetResourceTotals;
  quotas: { total: number; enabled: number };
  alerts: { warning: number; breach: number };
  topRam: FleetTopConsumer[];
  topDisk: FleetTopConsumer[];
  topCpuSeconds: FleetTopConsumer[];
  forecasts: FleetCapacityForecast[];
  computedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FORECAST_MIN_SAMPLES = 3;
const FORECAST_MIN_SPAN_MS = DAY_MS;

function totalsFor(
  statuses: FleetStatusView[],
  allocated: (s: FleetStatusView) => number,
  used: (s: FleetStatusView) => number | null,
): FleetResourceTotals {
  let allocatedSum = 0;
  let usedSum = 0;
  let measured = 0;
  for (const status of statuses) {
    allocatedSum += allocated(status);
    const u = used(status);
    if (u !== null && Number.isFinite(u) && u >= 0) {
      usedSum += u;
      measured += 1;
    }
  }
  return {
    allocated: allocatedSum,
    used: measured === 0 ? null : usedSum,
    usedPercent: measured === 0 || allocatedSum <= 0 ? null : Math.min(1, usedSum / allocatedSum),
    measuredWorkspaces: measured,
  };
}

function topConsumers(
  statuses: FleetStatusView[],
  used: (s: FleetStatusView) => number | null,
  limit = 5,
): FleetTopConsumer[] {
  const rows = statuses
    .map((s) => ({ s, u: used(s) }))
    .filter((r): r is { s: FleetStatusView; u: number } => r.u !== null && r.u > 0);
  const total = rows.reduce((sum, r) => sum + r.u, 0);
  if (total <= 0) return [];
  return rows
    .map((r) => ({
      workspaceId: r.s.workspace.id,
      name: r.s.workspace.name,
      used: r.u,
      share: r.u / total,
    }))
    .sort((a, b) => b.used - a.used)
    .slice(0, limit);
}

/**
 * Least-squares slope of (time, value) points, in units per day.
 * Returns null when the points do not span enough time or are degenerate.
 */
export function linearGrowthPerDay(points: Array<{ at: number; value: number }>): number | null {
  if (points.length < FORECAST_MIN_SAMPLES) return null;
  const sorted = [...points].sort((a, b) => a.at - b.at);
  if (sorted[sorted.length - 1].at - sorted[0].at < FORECAST_MIN_SPAN_MS) return null;
  const n = sorted.length;
  const xs = sorted.map((p) => p.at / DAY_MS);
  const ys = sorted.map((p) => p.value);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

/**
 * Forecast when one resource runs out, from dated fleet-total samples.
 * `totals` is the fleet-wide total use at each sample time (e.g. sum of
 * RSS across workspaces). `limit` is the fleet-wide allocation.
 * Returns a null forecast with a reason when the data cannot support one.
 */
export function forecastResource(
  resource: 'cpu' | 'ram' | 'disk',
  totals: Array<{ at: number; value: number }>,
  limit: number,
  at: number = Date.now(),
): FleetCapacityForecast {
  const base: FleetCapacityForecast = {
    resource,
    runsOutAt: null,
    daysUntilFull: null,
    growthPerDay: null,
    samplesUsed: totals.length,
  };
  if (totals.length < FORECAST_MIN_SAMPLES) {
    return { ...base, reason: 'not-enough-samples' };
  }
  const latest = [...totals].sort((a, b) => a.at - b.at)[totals.length - 1];
  if (latest.value >= limit) {
    return { ...base, growthPerDay: 0, reason: 'already-full' };
  }
  const slope = linearGrowthPerDay(totals);
  if (slope === null) {
    return { ...base, reason: 'not-enough-timespan' };
  }
  if (slope <= 0) {
    return { ...base, growthPerDay: slope, reason: 'not-growing' };
  }
  const days = (limit - latest.value) / slope;
  return {
    ...base,
    growthPerDay: slope,
    runsOutAt: Math.round(at + days * DAY_MS),
    daysUntilFull: Math.round(days * 10) / 10,
  };
}

/** Sum usage samples into fleet-wide totals per resource, per sample time. */
export function fleetTotalSeries(
  samplesByBot: Record<string, FleetUsageSample[]>,
): {
  ram: Array<{ at: number; value: number }>;
  disk: Array<{ at: number; value: number }>;
} {
  const ramByAt = new Map<number, number>();
  const diskByAt = new Map<number, number>();
  for (const samples of Object.values(samplesByBot)) {
    for (const s of samples) {
      if (s.rssBytes !== null) ramByAt.set(s.at, (ramByAt.get(s.at) ?? 0) + s.rssBytes);
      if (s.diskBytes !== null) diskByAt.set(s.at, (diskByAt.get(s.at) ?? 0) + s.diskBytes);
    }
  }
  const toSeries = (map: Map<number, number>): Array<{ at: number; value: number }> =>
    [...map.entries()].map(([at, value]) => ({ at, value })).sort((a, b) => a.at - b.at);
  return { ram: toSeries(ramByAt), disk: toSeries(diskByAt) };
}

/**
 * Build the fleet overview from console data. `samplesByBot` is optional:
 * without it, forecasts report 'not-enough-samples' instead of guessing.
 */
export function buildFleetOverview(
  statuses: FleetStatusView[],
  quotas: BotQuota[],
  alerts: QuotaAlert[],
  samplesByBot: Record<string, FleetUsageSample[]> = {},
  at: number = Date.now(),
): FleetOverview {
  const byServiceState: Record<string, number> = {};
  const byWorkspaceStatus: Record<string, number> = {};
  for (const s of statuses) {
    byServiceState[s.service.state] = (byServiceState[s.service.state] ?? 0) + 1;
    byWorkspaceStatus[s.workspace.status] = (byWorkspaceStatus[s.workspace.status] ?? 0) + 1;
  }
  const cpu = totalsFor(
    statuses,
    (s) => s.workspace.cpuCores,
    (s) => (s.usage?.cpuSecondsMax ?? null) as number | null,
  );
  const ram = totalsFor(
    statuses,
    (s) => s.workspace.ramBytes,
    (s) => s.usage?.rssBytesLatest ?? null,
  );
  const disk = totalsFor(
    statuses,
    (s) => s.workspace.diskBytes,
    (s) => s.usage?.diskBytesLatest ?? null,
  );
  const series = fleetTotalSeries(samplesByBot);
  return {
    workspaces: statuses.length,
    byServiceState,
    byWorkspaceStatus,
    cpu,
    ram,
    disk,
    quotas: { total: quotas.length, enabled: quotas.filter((q) => q.enabled).length },
    alerts: {
      warning: alerts.filter((a) => a.level === 'warning').length,
      breach: alerts.filter((a) => a.level === 'breach').length,
    },
    topRam: topConsumers(statuses, (s) => s.usage?.rssBytesLatest ?? null),
    topDisk: topConsumers(statuses, (s) => s.usage?.diskBytesLatest ?? null),
    topCpuSeconds: topConsumers(statuses, (s) => s.usage?.cpuSecondsMax ?? null),
    forecasts: [
      forecastResource('ram', series.ram, ram.allocated, at),
      forecastResource('disk', series.disk, disk.allocated, at),
    ],
    computedAt: at,
  };
}
