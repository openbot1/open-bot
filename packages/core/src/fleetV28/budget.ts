/**
 * Conversation budget meter (v1.41, Team T6) — fleet v28.
 *
 * OpenHands Canvas 1.38 (survey `docs/repo-survey-v141.md` §3)
 * added conversation budget meters. Open-bot already has a
 * harness-level meter (`../risk/budget.ts`: `ConversationBudgetMeter`,
 * warns at 80%, exceeds at the cap) and a view contract
 * (`../conversation/budgetMeterView.ts`: five levels ok/watch/
 * warning/critical/exceeded). This module is the fleet layer on top
 * of that idea, scoped per conversation and aggregated per profile:
 *
 * - One meter per conversation: input/output tokens + cost in USD,
 *   priced per model from a pricing table (USD per 1k tokens).
 *   Unknown models fall back to a default price and are flagged
 *   (`priced: false`) so an unpriced model never silently reports
 *   $0 as if it were free.
 * - Warn threshold (default 80% of the cap) + hard cap: recording
 *   usage that would push the cost past the cap is REFUSED
 *   (`accepted: false, blocked: true`) — the conversation cannot
 *   spend past its cap. A meter without a cap never blocks.
 * - Levels mirror the view contract: ok < 70% watch < 80% warning
 *   < 90% critical < 100% exceeded; `blocked` is reported
 *   separately when a record was refused.
 * - Alerts: `listAlerts` returns every meter at/over its warn
 *   threshold, with its level and remaining budget.
 * - Reports: `dailyReport` / `weeklyReport` aggregate cost +
 *   tokens per profile and per conversation for a calendar day /
 *   week (UTC dates, `YYYY-MM-DD`), with a top-spender list. The
 *   report is a pure snapshot — it never mutates the meters.
 * - History: every accepted record appends a `FleetV28BudgetEntry`
 *   (day-stamped) so reports are computed from entries, not from
 *   live counters that a reset could erase.
 *
 * Money is rounded to 6 decimals (micro-dollar precision); token
 * counts are integers. All time flows through explicit `nowMs` /
 * date parameters so tests are deterministic.
 */

/** Price for one model (USD per 1,000 tokens). */
export interface FleetV28ModelPrice {
  /** Model id (e.g. `gpt-4o`). */
  model: string;
  /** USD per 1k input tokens. */
  inputPer1kUsd: number;
  /** USD per 1k output tokens. */
  outputPer1kUsd: number;
}

/** Built-in pricing table (indicative list prices; host may override). */
export const FLEET_V28_DEFAULT_PRICING: readonly FleetV28ModelPrice[] = [
  { model: 'gpt-4o', inputPer1kUsd: 0.0025, outputPer1kUsd: 0.01 },
  { model: 'gpt-4o-mini', inputPer1kUsd: 0.00015, outputPer1kUsd: 0.0006 },
  { model: 'claude-sonnet-4', inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 },
  { model: 'claude-haiku-4', inputPer1kUsd: 0.0008, outputPer1kUsd: 0.004 },
  { model: 'gemini-2.5-flash', inputPer1kUsd: 0.0003, outputPer1kUsd: 0.0025 },
  { model: 'gemini-2.5-pro', inputPer1kUsd: 0.00125, outputPer1kUsd: 0.01 },
  { model: 'grok-4', inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 },
  { model: 'llama-3.3-70b', inputPer1kUsd: 0.00035, outputPer1kUsd: 0.0004 },
];

/** Fallback price for an unknown model (flagged, never silently $0). */
export const FLEET_V28_FALLBACK_PRICE: FleetV28ModelPrice = {
  model: '*',
  inputPer1kUsd: 0.002,
  outputPer1kUsd: 0.008,
};

/** Warn threshold: warn at 80% of the cap (mirrors the harness meter). */
export const FLEET_V28_BUDGET_WARN_RATIO = 0.8;
/** Watch threshold: start paying attention at 70%. */
export const FLEET_V28_BUDGET_WATCH_RATIO = 0.7;
/** Critical threshold: about to stop at 90%. */
export const FLEET_V28_BUDGET_CRITICAL_RATIO = 0.9;

/** Meter level (mirrors `BudgetMeterLevel` in `../conversation/budgetMeterView`). */
export type FleetV28BudgetLevel = 'ok' | 'watch' | 'warning' | 'critical' | 'exceeded';

/** Level for a used/cap ratio (null cap = never over). The level is
 * derived from the ROUNDED percent (1 decimal, the same number the
 * meter displays as `percentUsed`) so the level and the displayed
 * percent can never disagree over a float rounding edge (e.g.
 * 0.09/0.1 is 0.899999… in binary, but displays as 90%). */
export function fleetV28BudgetLevel(usedUsd: number, capUsd: number | null): FleetV28BudgetLevel {
  if (capUsd === null || capUsd <= 0) return 'ok';
  const percent = Math.round((usedUsd / capUsd) * 1000) / 10;
  if (percent >= 100) return 'exceeded';
  if (percent >= FLEET_V28_BUDGET_CRITICAL_RATIO * 100) return 'critical';
  if (percent >= FLEET_V28_BUDGET_WARN_RATIO * 100) return 'warning';
  if (percent >= FLEET_V28_BUDGET_WATCH_RATIO * 100) return 'watch';
  return 'ok';
}

/** One accepted usage record (day-stamped for reports). */
export interface FleetV28BudgetEntry {
  /** Conversation the spend belongs to. */
  conversationId: string;
  /** Owning profile. */
  profileId: string;
  /** Model that produced the tokens. */
  model: string;
  /** Input tokens in this record. */
  inputTokens: number;
  /** Output tokens in this record. */
  outputTokens: number;
  /** Cost of this record, USD. */
  costUsd: number;
  /** Whether the model had a known price (false = fallback price used). */
  priced: boolean;
  /** UTC date of the record (`YYYY-MM-DD`). */
  day: string;
  /** When the record was made, ms epoch. */
  atMs: number;
}

/** Live meter for one conversation. */
export interface FleetV28BudgetMeter {
  /** Conversation id. */
  conversationId: string;
  /** Owning profile. */
  profileId: string;
  /** Model of the latest record (empty = no usage yet). */
  model: string;
  /** Total input tokens this conversation. */
  inputTokens: number;
  /** Total output tokens this conversation. */
  outputTokens: number;
  /** Total cost, USD. */
  costUsd: number;
  /** Hard cap, USD (null = no cap). */
  capUsd: number | null;
  /** Warn threshold as a ratio of the cap (default 0.8). */
  warnAt: number;
  /** Meter level right now. */
  level: FleetV28BudgetLevel;
  /** Cost remaining before the cap (null = no cap). */
  remainingUsd: number | null;
  /** Percent of the cap used (null = no cap). */
  percentUsed: number | null;
  /** Whether any record used the fallback price. */
  hasUnpricedUsage: boolean;
  /** How many records were refused by the hard cap. */
  blockedRecords: number;
  /** When the meter was created, ms epoch. */
  createdAtMs: number;
  /** When the meter last changed, ms epoch. */
  updatedAtMs: number;
}

/** Result of `recordUsage`. */
export interface FleetV28RecordResult {
  /** Whether the record was accepted. */
  accepted: boolean;
  /** True when the hard cap refused the record. */
  blocked: boolean;
  /** Cost of the refused/accepted record, USD. */
  costUsd: number;
  /** Meter after the record (unchanged when refused). */
  meter: FleetV28BudgetMeter;
  /** Human-readable reason when refused (null when accepted). */
  reason: string | null;
}

/** One alert (a meter at/over its warn threshold). */
export interface FleetV28BudgetAlert {
  /** Conversation id. */
  conversationId: string;
  /** Owning profile. */
  profileId: string;
  /** Meter level. */
  level: FleetV28BudgetLevel;
  /** Cost so far, USD. */
  costUsd: number;
  /** Cap, USD (null = no cap — never alerted). */
  capUsd: number | null;
  /** Cost remaining, USD. */
  remainingUsd: number;
  /** Percent of the cap used. */
  percentUsed: number;
  /** Human-readable one-liner (English). */
  message: string;
}

/** One row of a report (per profile or per conversation). */
export interface FleetV28BudgetReportRow {
  /** Profile id (per-profile rows) or conversation id (per-conversation rows). */
  id: string;
  /** Cost, USD. */
  costUsd: number;
  /** Total tokens. */
  tokens: number;
  /** Input tokens. */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** How many usage records. */
  records: number;
}

/** A daily / weekly budget report (pure snapshot). */
export interface FleetV28BudgetReport {
  /** Report kind. */
  kind: 'daily' | 'weekly';
  /** Period label (`YYYY-MM-DD` for daily, `YYYY-MM-DD..YYYY-MM-DD` for weekly). */
  period: string;
  /** Total cost in the period, USD. */
  totalCostUsd: number;
  /** Total tokens in the period. */
  totalTokens: number;
  /** How many usage records. */
  records: number;
  /** How many conversations spent in the period. */
  conversations: number;
  /** Spend per profile (highest first). */
  byProfile: FleetV28BudgetReportRow[];
  /** Top conversations by cost (highest first, max 10). */
  topConversations: FleetV28BudgetReportRow[];
}

/** Round money to 6 decimals (micro-dollar precision). */
export function roundFleetV28Usd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Cost of a token count at a per-1k price. */
export function priceFleetV28Tokens(tokens: number, per1kUsd: number): number {
  return roundFleetV28Usd((tokens / 1000) * per1kUsd);
}

/** UTC date (`YYYY-MM-DD`) for an epoch ms. */
export function fleetV28DayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Add `days` to a `YYYY-MM-DD` date (UTC). Returns the new date string. */
export function fleetV28AddDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Validate a token count (integer >= 0). */
export function fleetV28TokensValid(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * Conversation budget store.
 *
 * Holds one meter per conversation plus the entry history reports
 * are computed from. Pricing is a lookup table the host may extend
 * (`setModelPrice`); unknown models use the fallback price and are
 * flagged so the UI can show "estimated" instead of a false exact
 * number.
 */
export class FleetV28BudgetStore {
  private readonly meters = new Map<string, FleetV28BudgetMeter>();
  private readonly entries: FleetV28BudgetEntry[] = [];
  private readonly pricing = new Map<string, FleetV28ModelPrice>();

  constructor(pricing: readonly FleetV28ModelPrice[] = FLEET_V28_DEFAULT_PRICING) {
    for (const p of pricing) this.pricing.set(p.model, { ...p });
  }

  /** Price for a model (fallback when unknown) + whether it was known. */
  priceFor(model: string): { price: FleetV28ModelPrice; priced: boolean } {
    const found = this.pricing.get(model);
    if (found) return { price: { ...found }, priced: true };
    return { price: { ...FLEET_V28_FALLBACK_PRICE }, priced: false };
  }

  /** Set / override the price of a model (validated). */
  setModelPrice(price: FleetV28ModelPrice): { ok: boolean; reasons?: string[] } {
    const reasons: string[] = [];
    if (typeof price.model !== 'string' || price.model.trim() === '') reasons.push('model must be a non-empty string.');
    if (typeof price.inputPer1kUsd !== 'number' || price.inputPer1kUsd < 0) reasons.push('inputPer1kUsd must be a number >= 0.');
    if (typeof price.outputPer1kUsd !== 'number' || price.outputPer1kUsd < 0) reasons.push('outputPer1kUsd must be a number >= 0.');
    if (reasons.length > 0) return { ok: false, reasons };
    this.pricing.set(price.model, { ...price });
    return { ok: true };
  }

  /** List known model prices (sorted by model). */
  listPricing(): FleetV28ModelPrice[] {
    return [...this.pricing.values()].sort((a, b) => a.model.localeCompare(b.model));
  }

  /** Get a conversation's meter (undefined when absent). Returns a copy. */
  getMeter(conversationId: string): FleetV28BudgetMeter | undefined {
    const m = this.meters.get(conversationId);
    return m ? { ...m } : undefined;
  }

  /** List meters (highest cost first), optionally filtered by profile. */
  listMeters(profileId?: string): FleetV28BudgetMeter[] {
    const all = [...this.meters.values()].map((m) => ({ ...m }));
    const filtered = profileId ? all.filter((m) => m.profileId === profileId) : all;
    return filtered.sort((a, b) => b.costUsd - a.costUsd || a.conversationId.localeCompare(b.conversationId));
  }

  /**
   * Create or fetch a meter (no usage yet). A meter with a cap of
   * `null` has no cap; `warnAt` defaults to 0.8.
   */
  ensureMeter(
    conversationId: string,
    profileId: string,
    opts: { capUsd?: number | null; warnAt?: number; nowMs?: number } = {},
  ): FleetV28BudgetMeter {
    const nowMs = opts.nowMs ?? Date.now();
    const existing = this.meters.get(conversationId);
    if (existing) return { ...existing };
    const capUsd = opts.capUsd ?? null;
    const meter: FleetV28BudgetMeter = {
      conversationId,
      profileId,
      model: '',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      capUsd,
      warnAt: opts.warnAt ?? FLEET_V28_BUDGET_WARN_RATIO,
      level: 'ok',
      remainingUsd: capUsd,
      percentUsed: null,
      hasUnpricedUsage: false,
      blockedRecords: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.meters.set(conversationId, meter);
    return { ...meter };
  }

  /**
   * Set (or clear) a conversation's hard cap. `capUsd` null clears
   * the cap; a cap must be > 0. Returns false when the meter does
   * not exist or the cap is invalid.
   */
  setCap(
    conversationId: string,
    capUsd: number | null,
    nowMs: number = Date.now(),
  ): { ok: boolean; meter?: FleetV28BudgetMeter; reasons?: string[] } {
    const meter = this.meters.get(conversationId);
    if (!meter) return { ok: false, reasons: [`No budget meter for conversation "${conversationId}".`] };
    if (capUsd !== null && (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd <= 0)) {
      return { ok: false, reasons: ['capUsd must be null or a number > 0.'] };
    }
    meter.capUsd = capUsd;
    meter.updatedAtMs = nowMs;
    refreshMeterDerived(meter);
    return { ok: true, meter: { ...meter } };
  }

  /** Set a meter's warn threshold (ratio 0..1, exclusive of 0 and 1). */
  setWarnAt(
    conversationId: string,
    warnAt: number,
    nowMs: number = Date.now(),
  ): { ok: boolean; meter?: FleetV28BudgetMeter; reasons?: string[] } {
    const meter = this.meters.get(conversationId);
    if (!meter) return { ok: false, reasons: [`No budget meter for conversation "${conversationId}".`] };
    if (typeof warnAt !== 'number' || !Number.isFinite(warnAt) || warnAt <= 0 || warnAt >= 1) {
      return { ok: false, reasons: ['warnAt must be a number between 0 and 1 (exclusive).'] };
    }
    meter.warnAt = warnAt;
    meter.updatedAtMs = nowMs;
    refreshMeterDerived(meter);
    return { ok: true, meter: { ...meter } };
  }

  /**
   * Record token usage for a conversation.
   *
   * - Invalid token counts / ids are refused (accepted false,
   *   blocked false, reason explains).
   * - Usage that would push the cost past a hard cap is REFUSED
   *   (accepted false, blocked true, `blockedRecords` + 1) — the
   *   meter is unchanged and no entry is written.
   * - Otherwise the meter and the entry history are updated and
   *   the record is returned accepted.
   */
  recordUsage(
    conversationId: string,
    profileId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    nowMs: number = Date.now(),
  ): FleetV28RecordResult {
    // NOTE: use the LIVE stored meter, not the copy `ensureMeter`
    // returns — mutating the copy would silently drop the record.
    if (!this.meters.has(conversationId)) this.ensureMeter(conversationId, profileId, { nowMs });
    const meter = this.meters.get(conversationId) as FleetV28BudgetMeter;
    const refuse = (reason: string, blocked: boolean): FleetV28RecordResult => {
      if (blocked) meter.blockedRecords += 1;
      meter.updatedAtMs = nowMs;
      return { accepted: false, blocked, costUsd: 0, meter: { ...meter }, reason };
    };
    if (typeof model !== 'string' || model.trim() === '') {
      return refuse('model must be a non-empty string.', false);
    }
    if (!fleetV28TokensValid(inputTokens) || !fleetV28TokensValid(outputTokens)) {
      return refuse('inputTokens and outputTokens must be integers >= 0.', false);
    }
    if (inputTokens === 0 && outputTokens === 0) {
      return refuse('At least one of inputTokens / outputTokens must be > 0.', false);
    }
    const { price, priced } = this.priceFor(model);
    const costUsd = roundFleetV28Usd(
      priceFleetV28Tokens(inputTokens, price.inputPer1kUsd) +
        priceFleetV28Tokens(outputTokens, price.outputPer1kUsd),
    );
    if (meter.capUsd !== null && roundFleetV28Usd(meter.costUsd + costUsd) > meter.capUsd) {
      return refuse(
        `Hard cap reached: this record would cost $${costUsd.toFixed(4)} but only $${roundFleetV28Usd(meter.capUsd - meter.costUsd).toFixed(4)} remains of the $${meter.capUsd.toFixed(2)} cap.`,
        true,
      );
    }
    meter.model = model;
    meter.inputTokens += inputTokens;
    meter.outputTokens += outputTokens;
    meter.costUsd = roundFleetV28Usd(meter.costUsd + costUsd);
    if (!priced) meter.hasUnpricedUsage = true;
    meter.updatedAtMs = nowMs;
    refreshMeterDerived(meter);
    this.entries.push({
      conversationId,
      profileId,
      model,
      inputTokens,
      outputTokens,
      costUsd,
      priced,
      day: fleetV28DayOf(nowMs),
      atMs: nowMs,
    });
    return { accepted: true, blocked: false, costUsd, meter: { ...meter }, reason: null };
  }

  /** Reset one conversation's meter (counters to zero, history kept for reports). */
  resetMeter(conversationId: string, nowMs: number = Date.now()): boolean {
    const meter = this.meters.get(conversationId);
    if (!meter) return false;
    meter.inputTokens = 0;
    meter.outputTokens = 0;
    meter.costUsd = 0;
    meter.model = '';
    meter.hasUnpricedUsage = false;
    meter.blockedRecords = 0;
    meter.updatedAtMs = nowMs;
    refreshMeterDerived(meter);
    return true;
  }

  /** Remove a meter entirely (its entries stay in report history). */
  removeMeter(conversationId: string): boolean {
    return this.meters.delete(conversationId);
  }

  /** Meters at/over their warn threshold (highest percent first). */
  listAlerts(): FleetV28BudgetAlert[] {
    const alerts: FleetV28BudgetAlert[] = [];
    for (const meter of this.meters.values()) {
      if (meter.capUsd === null || meter.percentUsed === null) continue;
      if (meter.percentUsed / 100 < meter.warnAt) continue;
      const remaining = roundFleetV28Usd(meter.capUsd - meter.costUsd);
      alerts.push({
        conversationId: meter.conversationId,
        profileId: meter.profileId,
        level: meter.level,
        costUsd: meter.costUsd,
        capUsd: meter.capUsd,
        remainingUsd: remaining,
        percentUsed: meter.percentUsed,
        message:
          meter.level === 'exceeded'
            ? `Conversation ${meter.conversationId} exceeded its $${meter.capUsd.toFixed(2)} budget cap ($${meter.costUsd.toFixed(4)} spent).`
            : `Conversation ${meter.conversationId} used ${meter.percentUsed}% of its $${meter.capUsd.toFixed(2)} budget ($${meter.costUsd.toFixed(4)} spent, $${remaining.toFixed(4)} left).`,
      });
    }
    return alerts.sort((a, b) => b.percentUsed - a.percentUsed);
  }

  /** Total spend across all meters (live counters). */
  totalCostUsd(): number {
    let total = 0;
    for (const m of this.meters.values()) total += m.costUsd;
    return roundFleetV28Usd(total);
  }

  /** Total tokens across all meters (live counters). */
  totalTokens(): number {
    let total = 0;
    for (const m of this.meters.values()) total += m.inputTokens + m.outputTokens;
    return total;
  }

  /** Daily report for one UTC date (from entry history). */
  dailyReport(day: string): FleetV28BudgetReport {
    return this.buildReport('daily', day, [day]);
  }

  /** Weekly report for the 7 days starting at `weekStart` (UTC `YYYY-MM-DD`). */
  weeklyReport(weekStart: string): FleetV28BudgetReport {
    const days: string[] = [];
    for (let i = 0; i < 7; i += 1) days.push(fleetV28AddDays(weekStart, i));
    return this.buildReport('weekly', `${days[0]}..${days[6]}`, days);
  }

  /** Entry history (newest first), optionally filtered by profile/day. */
  listEntries(filter: { profileId?: string; day?: string } = {}): FleetV28BudgetEntry[] {
    return this.entries
      .filter((e) => (!filter.profileId || e.profileId === filter.profileId) && (!filter.day || e.day === filter.day))
      .map((e) => ({ ...e }))
      .reverse();
  }

  private buildReport(kind: 'daily' | 'weekly', period: string, days: string[]): FleetV28BudgetReport {
    const daySet = new Set(days);
    const inPeriod = this.entries.filter((e) => daySet.has(e.day));
    const byProfile = new Map<string, FleetV28BudgetReportRow>();
    const byConversation = new Map<string, FleetV28BudgetReportRow>();
    let totalCostUsd = 0;
    let totalTokens = 0;
    for (const e of inPeriod) {
      totalCostUsd = roundFleetV28Usd(totalCostUsd + e.costUsd);
      totalTokens += e.inputTokens + e.outputTokens;
      const p = byProfile.get(e.profileId) ?? {
        id: e.profileId,
        costUsd: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        records: 0,
      };
      p.costUsd = roundFleetV28Usd(p.costUsd + e.costUsd);
      p.tokens += e.inputTokens + e.outputTokens;
      p.inputTokens += e.inputTokens;
      p.outputTokens += e.outputTokens;
      p.records += 1;
      byProfile.set(e.profileId, p);
      const c = byConversation.get(e.conversationId) ?? {
        id: e.conversationId,
        costUsd: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        records: 0,
      };
      c.costUsd = roundFleetV28Usd(c.costUsd + e.costUsd);
      c.tokens += e.inputTokens + e.outputTokens;
      c.inputTokens += e.inputTokens;
      c.outputTokens += e.outputTokens;
      c.records += 1;
      byConversation.set(e.conversationId, c);
    }
    const byProfileRows = [...byProfile.values()].sort((a, b) => b.costUsd - a.costUsd);
    const topConversations = [...byConversation.values()]
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 10);
    return {
      kind,
      period,
      totalCostUsd,
      totalTokens,
      records: inPeriod.length,
      conversations: byConversation.size,
      byProfile: byProfileRows,
      topConversations,
    };
  }
}

/** Recompute level / remaining / percent from cost + cap. */
function refreshMeterDerived(meter: FleetV28BudgetMeter): void {
  meter.level = fleetV28BudgetLevel(meter.costUsd, meter.capUsd);
  if (meter.capUsd === null) {
    meter.remainingUsd = null;
    meter.percentUsed = null;
  } else {
    meter.remainingUsd = roundFleetV28Usd(meter.capUsd - meter.costUsd);
    meter.percentUsed = Math.round((meter.costUsd / meter.capUsd) * 1000) / 10;
  }
}
