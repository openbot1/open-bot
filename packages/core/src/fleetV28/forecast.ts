/**
 * Budget forecast + burn rate + per-model breakdown (v1.41, Team T6) — fleet v28.
 *
 * The budget store (`budget.ts`) records what a conversation already
 * spent. This module answers what it WILL spend: pure functions over
 * the store's entry history (never mutating the store):
 *
 * - Burn rate: cost per day for a profile (or one conversation)
 *   over a window of N days ending on a given date — total cost in
 *   the window / number of days in the window that actually had
 *   spend (idle days do not dilute the rate: a profile that spends
 *   $10 on one day a week burns $10/day when active, not $1.43).
 * - Forecast: projected spend to a horizon date (e.g. month end)
 *   = burn rate * days remaining; projected total = spent so far +
 *   forecast. A forecast is only made when there are at least 2
 *   active days in the window — with less history the report says
 *   so instead of inventing a number.
 * - Days until cap: for each capped meter, days of runway left at
 *   the current burn rate (null = no cap, Infinity = zero burn).
 * - Per-model breakdown: cost + tokens + share per model across a
 *   window, highest first, with the unpriced (fallback) share
 *   called out separately so an estimate is never mistaken for an
 *   exact figure.
 * - Risk: `low` (projected under 70% of cap), `watch` (70–100%),
 *   `over` (projected past the cap) — the same thresholds as the
 *   meter levels, applied to the projection instead of the present.
 *
 * All dates are UTC `YYYY-MM-DD`; all money is rounded to 6
 * decimals like the store. Deterministic: every function takes its
 * window/horizon explicitly, so tests never depend on "today".
 */

import {
  fleetV28AddDays,
  roundFleetV28Usd,
  type FleetV28BudgetEntry,
  type FleetV28BudgetStore,
} from './budget';

/** Burn rate for one profile / conversation over a window. */
export interface FleetV28BurnRate {
  /** Whose burn rate this is (profile id, or conversation id). */
  id: string;
  /** Window start (inclusive, UTC `YYYY-MM-DD`). */
  windowStart: string;
  /** Window end (inclusive, UTC `YYYY-MM-DD`). */
  windowEnd: string;
  /** Days in the window with at least one entry. */
  activeDays: number;
  /** Total cost in the window, USD. */
  totalCostUsd: number;
  /** Total tokens in the window. */
  totalTokens: number;
  /** Cost per active day, USD (0 when no active day). */
  costPerDayUsd: number;
  /** Whether the rate is based on enough history (>= 2 active days). */
  reliable: boolean;
}

/** Projected spend to a horizon date. */
export interface FleetV28Forecast {
  /** Whose forecast this is. */
  id: string;
  /** Horizon date (inclusive). */
  horizon: string;
  /** Days from the window end to the horizon. */
  daysRemaining: number;
  /** Projected additional spend to the horizon, USD. */
  projectedAdditionalUsd: number;
  /** Spent so far (window total), USD. */
  spentSoFarUsd: number;
  /** Projected total at the horizon, USD. */
  projectedTotalUsd: number;
  /** Whether the forecast is reliable (burn rate reliable). */
  reliable: boolean;
  /** Human-readable note when unreliable (null when reliable). */
  note: string | null;
}

/** Runway for one capped meter at the current burn rate. */
export interface FleetV28CapRunway {
  /** Conversation id. */
  conversationId: string;
  /** Cap, USD. */
  capUsd: number;
  /** Spent so far, USD. */
  spentUsd: number;
  /** Remaining, USD. */
  remainingUsd: number;
  /** Burn rate, USD/day (profile-level rate when given, else 0). */
  burnPerDayUsd: number;
  /** Days until the cap at the burn rate (null = no burn, Infinity-safe as null). */
  daysUntilCap: number | null;
  /** Risk from the projection: low / watch / over. */
  risk: 'low' | 'watch' | 'over';
}

/** One row of a per-model cost breakdown. */
export interface FleetV28ModelBreakdownRow {
  /** Model id. */
  model: string;
  /** Cost, USD. */
  costUsd: number;
  /** Tokens. */
  tokens: number;
  /** Share of the window cost (0..1). */
  share: number;
  /** Whether any record for this model used the fallback price. */
  estimated: boolean;
  /** How many records. */
  records: number;
}

/** Group entries by day (`YYYY-MM-DD` -> entries). */
export function groupFleetV28EntriesByDay(entries: readonly FleetV28BudgetEntry[]): Map<string, FleetV28BudgetEntry[]> {
  const byDay = new Map<string, FleetV28BudgetEntry[]>();
  for (const e of entries) {
    const list = byDay.get(e.day) ?? [];
    list.push(e);
    byDay.set(e.day, list);
  }
  return byDay;
}

/** Days in a window (inclusive), as `YYYY-MM-DD` strings. */
export function fleetV28WindowDays(start: string, end: string): string[] {
  const days: string[] = [];
  let day = start;
  for (let guard = 0; guard < 366 && day <= end; guard += 1) {
    days.push(day);
    day = fleetV28AddDays(day, 1);
  }
  return days;
}

/**
 * Burn rate from entry history over a window. Idle days do not
 * dilute the rate (see the module doc): `costPerDayUsd` divides by
 * active days only.
 */
export function computeFleetV28BurnRate(
  id: string,
  entries: readonly FleetV28BudgetEntry[],
  windowStart: string,
  windowEnd: string,
): FleetV28BurnRate {
  const inWindow = entries.filter((e) => e.day >= windowStart && e.day <= windowEnd);
  const activeDays = new Set(inWindow.map((e) => e.day)).size;
  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const e of inWindow) {
    totalCostUsd = roundFleetV28Usd(totalCostUsd + e.costUsd);
    totalTokens += e.inputTokens + e.outputTokens;
  }
  return {
    id,
    windowStart,
    windowEnd,
    activeDays,
    totalCostUsd,
    totalTokens,
    costPerDayUsd: activeDays === 0 ? 0 : roundFleetV28Usd(totalCostUsd / activeDays),
    reliable: activeDays >= 2,
  };
}

/** Forecast spend to a horizon from a burn rate. */
export function forecastFleetV28Spend(rate: FleetV28BurnRate, horizon: string): FleetV28Forecast {
  const daysRemaining = Math.max(0, dayDiff(rate.windowEnd, horizon));
  const projectedAdditionalUsd = roundFleetV28Usd(rate.costPerDayUsd * daysRemaining);
  return {
    id: rate.id,
    horizon,
    daysRemaining,
    projectedAdditionalUsd,
    spentSoFarUsd: rate.totalCostUsd,
    projectedTotalUsd: roundFleetV28Usd(rate.totalCostUsd + projectedAdditionalUsd),
    reliable: rate.reliable,
    note: rate.reliable
      ? null
      : `Only ${rate.activeDays} active day(s) in the window — forecast is a rough guess, not a reliable projection.`,
  };
}

/** Days between two `YYYY-MM-DD` dates (end - start, UTC). */
export function dayDiff(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00.000Z`);
  const b = Date.parse(`${end}T00:00:00.000Z`);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/** Risk of a projection against a cap (same thresholds as meter levels). */
export function fleetV28ForecastRisk(projectedTotalUsd: number, capUsd: number | null): 'low' | 'watch' | 'over' {
  if (capUsd === null || capUsd <= 0) return 'low';
  const ratio = projectedTotalUsd / capUsd;
  if (ratio >= 1) return 'over';
  if (ratio >= 0.7) return 'watch';
  return 'low';
}

/**
 * Per-model cost breakdown over a window (highest cost first).
 * `estimated` is true when any record for the model used the
 * fallback price — the row is an estimate, not an exact figure.
 */
export function breakdownFleetV28ByModel(
  entries: readonly FleetV28BudgetEntry[],
  windowStart: string,
  windowEnd: string,
): FleetV28ModelBreakdownRow[] {
  const inWindow = entries.filter((e) => e.day >= windowStart && e.day <= windowEnd);
  const byModel = new Map<string, FleetV28ModelBreakdownRow>();
  let total = 0;
  for (const e of inWindow) {
    total = roundFleetV28Usd(total + e.costUsd);
    const row = byModel.get(e.model) ?? {
      model: e.model,
      costUsd: 0,
      tokens: 0,
      share: 0,
      estimated: false,
      records: 0,
    };
    row.costUsd = roundFleetV28Usd(row.costUsd + e.costUsd);
    row.tokens += e.inputTokens + e.outputTokens;
    row.records += 1;
    if (!e.priced) row.estimated = true;
    byModel.set(e.model, row);
  }
  const rows = [...byModel.values()];
  for (const row of rows) row.share = total === 0 ? 0 : Math.round((row.costUsd / total) * 1000) / 1000;
  return rows.sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Cap runway for every capped meter in the store, at each owning
 * profile's burn rate over the given window. Meters whose profile
 * has no burn rate get `daysUntilCap: null` (no spend to project).
 * Risk projects 30 days ahead at that burn rate.
 */
export function computeFleetV28CapRunways(
  store: FleetV28BudgetStore,
  windowStart: string,
  windowEnd: string,
): FleetV28CapRunway[] {
  const runways: FleetV28CapRunway[] = [];
  for (const meter of store.listMeters()) {
    if (meter.capUsd === null) continue;
    const profileEntries = store.listEntries({ profileId: meter.profileId });
    const rate = computeFleetV28BurnRate(meter.profileId, profileEntries, windowStart, windowEnd);
    const remaining = roundFleetV28Usd(meter.capUsd - meter.costUsd);
    const daysUntilCap =
      rate.costPerDayUsd <= 0 ? null : Math.floor((remaining / rate.costPerDayUsd) * 10) / 10;
    const projectedTotal = roundFleetV28Usd(meter.costUsd + rate.costPerDayUsd * 30);
    runways.push({
      conversationId: meter.conversationId,
      capUsd: meter.capUsd,
      spentUsd: meter.costUsd,
      remainingUsd: remaining,
      burnPerDayUsd: rate.costPerDayUsd,
      daysUntilCap,
      risk: fleetV28ForecastRisk(projectedTotal, meter.capUsd),
    });
  }
  return runways.sort((a, b) => (a.daysUntilCap ?? Number.POSITIVE_INFINITY) - (b.daysUntilCap ?? Number.POSITIVE_INFINITY));
}

/** One-line text summary of a forecast (for logs / diagnostics). */
export function summarizeFleetV28Forecast(forecast: FleetV28Forecast): string {
  const base = `${forecast.id}: spent $${forecast.spentSoFarUsd.toFixed(4)}, projected $${forecast.projectedTotalUsd.toFixed(4)} by ${forecast.horizon} (${forecast.daysRemaining} day(s) left)`;
  return forecast.reliable ? `${base}.` : `${base} — unreliable: ${forecast.note ?? ''}`;
}
