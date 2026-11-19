/**
 * Cost ledger v30 (v1.44, Team T4).
 *
 * What v29 got wrong and v30 fixes:
 *
 *   - v29 billed audio minutes only. A realtime turn also
 *     spends LLM text tokens (the LLM leg, tool-call text,
 *     proactive audio text). v30 bills a minute + token
 *     hybrid: audio minutes at per-minute rates *and* text
 *     tokens at a per-1k-token rate, each slice tagged with
 *     its kind (input-audio / output-audio / proactive-audio
 *     / text-tokens) so the report can say where the money
 *     went.
 *   - v29 only rolled up per day (for the daily cap). v30
 *     rolls up per day, per week and per month, and enforces
 *     a budget *envelope* at each level: a soft warn and a
 *     hard cap per session, per day and per month. Hitting a
 *     hard cap stops further billing at that level (the
 *     minutes are still recorded, honestly, at $0).
 *   - v29 could only say what was spent. v30 forecasts: from
 *     the spend so far today it projects the rest of the day
 *     (linear run-rate), and from the month so far it
 *     projects the month-end total, with a flag when the
 *     projection would breach a cap.
 *   - v29 exported Markdown only. v30 exports an itemised
 *     per-session statement as Markdown, CSV and JSON, so
 *     the host can show the user exactly what each session
 *     cost, slice by slice.
 *
 * Nothing here dials a provider or reads a key: the ledger
 * only multiplies minutes and tokens by rates. All clocks
 * virtual (the caller passes `atMs`).
 */

import {
  VOICE_V30_COST_DAILY_CAP_DEFAULT_USD,
  VOICE_V30_COST_DAILY_WARN_DEFAULT_USD,
  VOICE_V30_COST_MONTHLY_CAP_DEFAULT_USD,
  VOICE_V30_COST_MONTHLY_WARN_DEFAULT_USD,
  VOICE_V30_COST_SESSION_CAP_DEFAULT_USD,
  VOICE_V30_COST_SESSION_WARN_DEFAULT_USD,
  VOICE_V30_RATE_TABLE_DEFAULT,
  costForMinutesV30,
  costForTokensV30,
  dayKeyV30,
  formatUsdV30,
  monthKeyV30,
  rateForModelV30,
  round4V30,
  weekKeyV30,
  type VoiceV30Budget,
  type VoiceV30CostAlert,
  type VoiceV30CostEntry,
  type VoiceV30CostKind,
  type VoiceV30ModelId,
  type VoiceV30RateEntry,
} from './types';

export interface CostLedgerV30Options {
  /** Rate table (defaults to the survey planning table). */
  rates?: VoiceV30RateEntry[];
  /** Per-session budget envelope (0 cap = unlimited). */
  sessionBudget?: VoiceV30Budget;
  /** Daily budget envelope (0 cap = unlimited). */
  dailyBudget?: VoiceV30Budget;
  /** Monthly budget envelope (0 cap = unlimited). */
  monthlyBudget?: VoiceV30Budget;
  /** Called when an alert fires. */
  onAlert?: (alert: VoiceV30CostAlert) => void;
}

export interface VoiceV30CostSessionMeter {
  sessionId: string;
  modelId: VoiceV30ModelId;
  startedAtMs: number;
  lastTickAtMs: number;
  inputMs: number;
  outputMs: number;
  proactiveMs: number;
  tokens: number;
  usd: number;
  usdByKind: Record<VoiceV30CostKind, number>;
  capped: boolean;
  warned: boolean;
}

export interface VoiceV30CostReport {
  sessions: number;
  entries: number;
  totalMinutes: number;
  totalInputMinutes: number;
  totalOutputMinutes: number;
  totalProactiveMinutes: number;
  totalTokens: number;
  totalUsd: number;
  usdByKind: Record<VoiceV30CostKind, number>;
  byModel: Record<string, { minutes: number; tokens: number; usd: number; sessions: number }>;
  bySession: Record<string, { minutes: number; tokens: number; usd: number; modelId: string }>;
  byDay: Record<string, { minutes: number; usd: number; sessions: number }>;
  byWeek: Record<string, { minutes: number; usd: number }>;
  byMonth: Record<string, { minutes: number; usd: number }>;
  alerts: number;
  cappedSessions: string[];
}

export interface VoiceV30CostEstimate {
  modelId: VoiceV30ModelId;
  minutes: number;
  tokens: number;
  usdPerMinute: number;
  usdPerKiloToken: number | null;
  estimatedUsd: number;
  withinSessionCap: boolean;
  withinDailyCap: boolean;
  withinMonthlyCap: boolean;
  note: string;
}

export interface VoiceV30CostForecast {
  atMs: number;
  dayKey: string;
  spentTodayUsd: number;
  projectedDayUsd: number;
  monthKey: string;
  spentMonthUsd: number;
  projectedMonthUsd: number;
  wouldBreachDailyCap: boolean;
  wouldBreachMonthlyCap: boolean;
}

export function defaultCostLedgerV30Options(): CostLedgerV30Options {
  return {
    rates: [...VOICE_V30_RATE_TABLE_DEFAULT],
    sessionBudget: { warnAtUsd: VOICE_V30_COST_SESSION_WARN_DEFAULT_USD, capUsd: VOICE_V30_COST_SESSION_CAP_DEFAULT_USD },
    dailyBudget: { warnAtUsd: VOICE_V30_COST_DAILY_WARN_DEFAULT_USD, capUsd: VOICE_V30_COST_DAILY_CAP_DEFAULT_USD },
    monthlyBudget: { warnAtUsd: VOICE_V30_COST_MONTHLY_WARN_DEFAULT_USD, capUsd: VOICE_V30_COST_MONTHLY_CAP_DEFAULT_USD },
  };
}

export class CostLedgerV30 {
  private rates: VoiceV30RateEntry[];
  private readonly sessionBudget: VoiceV30Budget;
  private readonly dailyBudget: VoiceV30Budget;
  private readonly monthlyBudget: VoiceV30Budget;
  private readonly onAlert?: (alert: VoiceV30CostAlert) => void;

  private readonly meters = new Map<string, VoiceV30CostSessionMeter>();
  private readonly entries: VoiceV30CostEntry[] = [];
  private readonly alerts: VoiceV30CostAlert[] = [];
  /** Spend keyed by UTC date / week / month. */
  private readonly dailySpend = new Map<string, number>();
  private readonly weeklySpend = new Map<string, number>();
  private readonly monthlySpend = new Map<string, number>();

  constructor(opts: CostLedgerV30Options = {}) {
    this.rates = (opts.rates ?? [...VOICE_V30_RATE_TABLE_DEFAULT]).map((r) => ({ ...r }));
    this.sessionBudget = opts.sessionBudget ?? { warnAtUsd: VOICE_V30_COST_SESSION_WARN_DEFAULT_USD, capUsd: VOICE_V30_COST_SESSION_CAP_DEFAULT_USD };
    this.dailyBudget = opts.dailyBudget ?? { warnAtUsd: VOICE_V30_COST_DAILY_WARN_DEFAULT_USD, capUsd: VOICE_V30_COST_DAILY_CAP_DEFAULT_USD };
    this.monthlyBudget = opts.monthlyBudget ?? { warnAtUsd: VOICE_V30_COST_MONTHLY_WARN_DEFAULT_USD, capUsd: VOICE_V30_COST_MONTHLY_CAP_DEFAULT_USD };
    this.onAlert = opts.onAlert;
  }

  /** Current rate table (copies). */
  getRates(): VoiceV30RateEntry[] {
    return this.rates.map((r) => ({ ...r }));
  }

  /** Override one model's minute rate (marks it overridden). */
  overrideRate(modelId: VoiceV30ModelId, usdPerMinute: number, source = 'host override'): VoiceV30RateEntry {
    if (!Number.isFinite(usdPerMinute) || usdPerMinute < 0) throw new Error('Rate must be a non-negative number');
    const existing = this.rates.find((r) => r.modelId === modelId);
    if (existing) {
      existing.usdPerMinute = usdPerMinute;
      existing.usdPerMinuteInput = null;
      existing.usdPerMinuteOutput = null;
      existing.source = source;
      existing.overridden = true;
      return { ...existing };
    }
    const entry: VoiceV30RateEntry = {
      modelId,
      usdPerMinute,
      usdPerMinuteInput: null,
      usdPerMinuteOutput: null,
      usdPerKiloToken: null,
      source,
      overridden: true,
    };
    this.rates.push(entry);
    return { ...entry };
  }

  /** Override one model's token rate (USD per 1k tokens). */
  overrideTokenRate(modelId: VoiceV30ModelId, usdPerKiloToken: number, source = 'host override'): VoiceV30RateEntry {
    if (!Number.isFinite(usdPerKiloToken) || usdPerKiloToken < 0) throw new Error('Token rate must be a non-negative number');
    const existing = this.rates.find((r) => r.modelId === modelId);
    if (existing) {
      existing.usdPerKiloToken = usdPerKiloToken;
      existing.source = source;
      existing.overridden = true;
      return { ...existing };
    }
    const entry: VoiceV30RateEntry = {
      modelId,
      usdPerMinute: 0,
      usdPerMinuteInput: null,
      usdPerMinuteOutput: null,
      usdPerKiloToken,
      source,
      overridden: true,
    };
    this.rates.push(entry);
    return { ...entry };
  }

  /** Start metering a session (idempotent: starting twice keeps the first meter). */
  startSession(sessionId: string, modelId: VoiceV30ModelId, atMs: number): VoiceV30CostSessionMeter {
    const existing = this.meters.get(sessionId);
    if (existing) return this.copyMeter(existing);
    const meter: VoiceV30CostSessionMeter = {
      sessionId,
      modelId,
      startedAtMs: atMs,
      lastTickAtMs: atMs,
      inputMs: 0,
      outputMs: 0,
      proactiveMs: 0,
      tokens: 0,
      usd: 0,
      usdByKind: { 'input-audio': 0, 'output-audio': 0, 'proactive-audio': 0, 'text-tokens': 0 },
      capped: false,
      warned: false,
    };
    this.meters.set(sessionId, meter);
    return this.copyMeter(meter);
  }

  /**
   * Meter one slice of a session: audio minutes by kind plus
   * text tokens for the LLM leg. Minutes are billed per
   * second (ms / 60000). Once a session is capped, further
   * slices cost $0 and are still recorded (minutes stay
   * honest). Hard caps apply in order: session, day, month —
   * the tightest one wins.
   */
  tick(
    sessionId: string,
    slice: { inputMs?: number; outputMs?: number; proactiveMs?: number; tokens?: number },
    atMs: number,
  ): VoiceV30CostEntry[] {
    const meter = this.meters.get(sessionId);
    if (!meter) return [];
    const inputMs = slice.inputMs ?? 0;
    const outputMs = slice.outputMs ?? 0;
    const proactiveMs = slice.proactiveMs ?? 0;
    const tokens = slice.tokens ?? 0;
    if (inputMs < 0 || outputMs < 0 || proactiveMs < 0 || tokens < 0) {
      throw new Error('Tick values must not be negative');
    }
    const entry = rateForModelV30(this.rates, meter.modelId);
    const out: VoiceV30CostEntry[] = [];
    const pushSlice = (kind: VoiceV30CostKind, minutes: number, tokenCount: number, rawUsd: number): void => {
      const usd = meter.capped ? 0 : this.applyCaps(meter, rawUsd, atMs);
      const costEntry: VoiceV30CostEntry = {
        sessionId,
        modelId: meter.modelId,
        kind,
        startedAtMs: meter.lastTickAtMs,
        endedAtMs: atMs,
        minutes: round4V30(minutes),
        tokens: tokenCount,
        usd,
      };
      this.entries.push(costEntry);
      out.push({ ...costEntry });
      meter.usd = round4V30(meter.usd + usd);
      meter.usdByKind[kind] = round4V30(meter.usdByKind[kind] + usd);
    };
    if (inputMs > 0 || outputMs > 0) {
      if (inputMs > 0) {
        const inRate = entry ? (entry.usdPerMinuteInput ?? entry.usdPerMinute) : 0;
        pushSlice('input-audio', inputMs / 60_000, 0, costForMinutesV30(inputMs / 60_000, inRate));
      }
      if (outputMs > 0) {
        const outRate = entry ? (entry.usdPerMinuteOutput ?? entry.usdPerMinute) : 0;
        pushSlice('output-audio', outputMs / 60_000, 0, costForMinutesV30(outputMs / 60_000, outRate));
      }
    }
    if (proactiveMs > 0) {
      const rate = entry ? (entry.usdPerMinuteOutput ?? entry.usdPerMinute) : 0;
      pushSlice('proactive-audio', proactiveMs / 60_000, 0, costForMinutesV30(proactiveMs / 60_000, rate));
    }
    if (tokens > 0) {
      pushSlice('text-tokens', 0, tokens, entry ? costForTokensV30(tokens, entry.usdPerKiloToken) : 0);
    }
    meter.inputMs += inputMs;
    meter.outputMs += outputMs;
    meter.proactiveMs += proactiveMs;
    meter.tokens += tokens;
    meter.lastTickAtMs = atMs;
    this.checkAlerts(meter, atMs);
    return out;
  }

  /** Stop metering a session; the meter stays readable. */
  stopSession(sessionId: string, atMs: number): VoiceV30CostSessionMeter | null {
    const meter = this.meters.get(sessionId);
    if (!meter) return null;
    meter.lastTickAtMs = atMs;
    return this.copyMeter(meter);
  }

  getMeter(sessionId: string): VoiceV30CostSessionMeter | null {
    const meter = this.meters.get(sessionId);
    return meter ? this.copyMeter(meter) : null;
  }

  listMeters(): VoiceV30CostSessionMeter[] {
    return [...this.meters.values()].map((m) => this.copyMeter(m));
  }

  entriesSoFar(): VoiceV30CostEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Estimate the cost of `minutes` + `tokens` on a model (before spending). */
  estimate(modelId: VoiceV30ModelId, minutes: number, tokens: number, atMs: number): VoiceV30CostEstimate {
    const entry = rateForModelV30(this.rates, modelId);
    const rate = entry?.usdPerMinute ?? 0;
    const tokenRate = entry?.usdPerKiloToken ?? null;
    const estimatedUsd = round4V30(
      costForMinutesV30(minutes, rate) + costForTokensV30(tokens, tokenRate),
    );
    const daySpent = this.dailySpend.get(dayKeyV30(atMs)) ?? 0;
    const monthSpent = this.monthlySpend.get(monthKeyV30(atMs)) ?? 0;
    return {
      modelId,
      minutes,
      tokens,
      usdPerMinute: rate,
      usdPerKiloToken: tokenRate,
      estimatedUsd,
      withinSessionCap: this.sessionBudget.capUsd <= 0 || estimatedUsd <= this.sessionBudget.capUsd,
      withinDailyCap: this.dailyBudget.capUsd <= 0 || daySpent + estimatedUsd <= this.dailyBudget.capUsd,
      withinMonthlyCap: this.monthlyBudget.capUsd <= 0 || monthSpent + estimatedUsd <= this.monthlyBudget.capUsd,
      note:
        entry === null
          ? `No rate configured for ${modelId} — estimated $0`
          : entry.overridden
            ? `Rate overridden by the host (${entry.source})`
            : `Planning rate (${entry.source})`,
    };
  }

  /**
   * Forecast the run-rate: today's spend so far, projected
   * linearly to the end of the day, and the month's spend so
   * far projected to month-end. A projection is only a
   * straight line from history — never a promise.
   */
  forecast(atMs: number): VoiceV30CostForecast {
    const d = new Date(atMs);
    const day = dayKeyV30(atMs);
    const month = monthKeyV30(atMs);
    const spentToday = this.dailySpend.get(day) ?? 0;
    const spentMonth = this.monthlySpend.get(month) ?? 0;
    const msIntoDay = d.getUTCHours() * 3_600_000 + d.getUTCMinutes() * 60_000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();
    const dayFraction = Math.max(1 / 1440, msIntoDay / 86_400_000);
    const projectedDay = round4V30(spentToday / dayFraction);
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const monthFraction = Math.max(1 / daysInMonth, d.getUTCDate() / daysInMonth);
    const projectedMonth = round4V30(spentMonth / monthFraction);
    const forecastValue: VoiceV30CostForecast = {
      atMs,
      dayKey: day,
      spentTodayUsd: round4V30(spentToday),
      projectedDayUsd: projectedDay,
      monthKey: month,
      spentMonthUsd: round4V30(spentMonth),
      projectedMonthUsd: projectedMonth,
      wouldBreachDailyCap: this.dailyBudget.capUsd > 0 && projectedDay > this.dailyBudget.capUsd,
      wouldBreachMonthlyCap: this.monthlyBudget.capUsd > 0 && projectedMonth > this.monthlyBudget.capUsd,
    };
    if ((forecastValue.wouldBreachDailyCap || forecastValue.wouldBreachMonthlyCap) &&
      !this.alerts.some((a) => a.level === 'forecast' && a.sessionId === '')) {
      this.fireAlert({
        atMs,
        sessionId: '',
        level: 'forecast',
        message: `Run-rate projection ${formatUsdV30(projectedDay)} today / ${formatUsdV30(projectedMonth)} this month would breach a cap`,
        usdSoFar: round4V30(spentToday + spentMonth),
      });
    }
    return forecastValue;
  }

  alertsSoFar(): VoiceV30CostAlert[] {
    return this.alerts.map((a) => ({ ...a }));
  }

  report(): VoiceV30CostReport {
    const byModel: VoiceV30CostReport['byModel'] = {};
    const bySession: VoiceV30CostReport['bySession'] = {};
    const byDay: VoiceV30CostReport['byDay'] = {};
    const byWeek: VoiceV30CostReport['byWeek'] = {};
    const byMonth: VoiceV30CostReport['byMonth'] = {};
    const usdByKind: Record<VoiceV30CostKind, number> = { 'input-audio': 0, 'output-audio': 0, 'proactive-audio': 0, 'text-tokens': 0 };
    let totalMinutes = 0;
    let totalInputMinutes = 0;
    let totalOutputMinutes = 0;
    let totalProactiveMinutes = 0;
    let totalTokens = 0;
    let totalUsd = 0;
    for (const entry of this.entries) {
      totalMinutes += entry.minutes;
      totalTokens += entry.tokens;
      totalUsd += entry.usd;
      usdByKind[entry.kind] = round4V30(usdByKind[entry.kind] + entry.usd);
      if (entry.kind === 'input-audio') totalInputMinutes += entry.minutes;
      if (entry.kind === 'output-audio') totalOutputMinutes += entry.minutes;
      if (entry.kind === 'proactive-audio') totalProactiveMinutes += entry.minutes;
      const m = byModel[entry.modelId] ?? { minutes: 0, tokens: 0, usd: 0, sessions: 0 };
      m.minutes = round4V30(m.minutes + entry.minutes);
      m.tokens += entry.tokens;
      m.usd = round4V30(m.usd + entry.usd);
      byModel[entry.modelId] = m;
      const s = bySession[entry.sessionId] ?? { minutes: 0, tokens: 0, usd: 0, modelId: entry.modelId };
      s.minutes = round4V30(s.minutes + entry.minutes);
      s.tokens += entry.tokens;
      s.usd = round4V30(s.usd + entry.usd);
      bySession[entry.sessionId] = s;
      const day = dayKeyV30(entry.endedAtMs);
      const dd = byDay[day] ?? { minutes: 0, usd: 0, sessions: 0 };
      dd.minutes = round4V30(dd.minutes + entry.minutes);
      dd.usd = round4V30(dd.usd + entry.usd);
      byDay[day] = dd;
      const week = weekKeyV30(entry.endedAtMs);
      const ww = byWeek[week] ?? { minutes: 0, usd: 0 };
      ww.minutes = round4V30(ww.minutes + entry.minutes);
      ww.usd = round4V30(ww.usd + entry.usd);
      byWeek[week] = ww;
      const month = monthKeyV30(entry.endedAtMs);
      const mm = byMonth[month] ?? { minutes: 0, usd: 0 };
      mm.minutes = round4V30(mm.minutes + entry.minutes);
      mm.usd = round4V30(mm.usd + entry.usd);
      byMonth[month] = mm;
    }
    for (const modelId of Object.keys(byModel)) {
      byModel[modelId].sessions = new Set(
        this.entries.filter((e) => e.modelId === modelId).map((e) => e.sessionId),
      ).size;
    }
    for (const day of Object.keys(byDay)) {
      byDay[day].sessions = new Set(
        this.entries.filter((e) => dayKeyV30(e.endedAtMs) === day).map((e) => e.sessionId),
      ).size;
    }
    return {
      sessions: this.meters.size,
      entries: this.entries.length,
      totalMinutes: round4V30(totalMinutes),
      totalInputMinutes: round4V30(totalInputMinutes),
      totalOutputMinutes: round4V30(totalOutputMinutes),
      totalProactiveMinutes: round4V30(totalProactiveMinutes),
      totalTokens,
      totalUsd: round4V30(totalUsd),
      usdByKind,
      byModel,
      bySession,
      byDay,
      byWeek,
      byMonth,
      alerts: this.alerts.length,
      cappedSessions: [...this.meters.values()].filter((m) => m.capped).map((m) => m.sessionId),
    };
  }

  /** Itemised statement for one session (Markdown). */
  statementMarkdown(sessionId: string): string {
    const meter = this.meters.get(sessionId);
    const rows = this.entries.filter((e) => e.sessionId === sessionId);
    if (!meter && rows.length === 0) return `# Voice cost statement (v30)\n\nNo such session: ${sessionId}`;
    const lines = [
      `# Voice cost statement (v30) — ${sessionId}`,
      '',
      `- Model: ${meter?.modelId ?? rows[0]?.modelId ?? 'unknown'}`,
      `- Audio in: ${round4V30((meter?.inputMs ?? 0) / 60_000)} min, out: ${round4V30((meter?.outputMs ?? 0) / 60_000)} min, proactive: ${round4V30((meter?.proactiveMs ?? 0) / 60_000)} min`,
      `- Text tokens: ${meter?.tokens ?? 0}`,
      `- Total: ${formatUsdV30(meter?.usd ?? 0)}${meter?.capped ? ' (capped — further audio billed $0)' : ''}`,
      '',
      '| kind | minutes | tokens | USD |',
      '| --- | --- | --- | --- |',
    ];
    for (const row of rows) {
      lines.push(`| ${row.kind} | ${row.minutes} | ${row.tokens} | ${formatUsdV30(row.usd)} |`);
    }
    return lines.join('\n');
  }

  /** Itemised statement for one session (CSV). */
  statementCsv(sessionId: string): string {
    const rows = this.entries.filter((e) => e.sessionId === sessionId);
    const lines = ['sessionId,modelId,kind,startedAtMs,endedAtMs,minutes,tokens,usd'];
    for (const row of rows) {
      lines.push(`${row.sessionId},${row.modelId},${row.kind},${row.startedAtMs},${row.endedAtMs},${row.minutes},${row.tokens},${row.usd}`);
    }
    return lines.join('\n');
  }

  /** Whole-ledger report as JSON (string). */
  toJson(): string {
    return JSON.stringify(this.report(), null, 2);
  }

  /** Export the report as Markdown. */
  toMarkdown(): string {
    const r = this.report();
    const lines = [
      '# Voice cost report (v30)',
      '',
      `- Sessions: ${r.sessions}`,
      `- Billed minutes: ${r.totalMinutes} (in ${r.totalInputMinutes} / out ${r.totalOutputMinutes} / proactive ${r.totalProactiveMinutes})`,
      `- Text tokens: ${r.totalTokens}`,
      `- Total spend: ${formatUsdV30(r.totalUsd)}`,
      `- Alerts: ${r.alerts}`,
      '',
      '## By kind',
    ];
    for (const [kind, usd] of Object.entries(r.usdByKind)) {
      lines.push(`- ${kind}: ${formatUsdV30(usd)}`);
    }
    lines.push('', '## By model');
    for (const [modelId, row] of Object.entries(r.byModel)) {
      lines.push(`- ${modelId}: ${row.minutes} min, ${row.tokens} tokens, ${formatUsdV30(row.usd)}, ${row.sessions} session(s)`);
    }
    lines.push('', '## By day');
    for (const [day, row] of Object.entries(r.byDay)) {
      lines.push(`- ${day}: ${row.minutes} min, ${formatUsdV30(row.usd)}, ${row.sessions} session(s)`);
    }
    lines.push('', '## By month');
    for (const [month, row] of Object.entries(r.byMonth)) {
      lines.push(`- ${month}: ${row.minutes} min, ${formatUsdV30(row.usd)}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.meters.clear();
    this.entries.length = 0;
    this.alerts.length = 0;
    this.dailySpend.clear();
    this.weeklySpend.clear();
    this.monthlySpend.clear();
  }

  private copyMeter(meter: VoiceV30CostSessionMeter): VoiceV30CostSessionMeter {
    return { ...meter, usdByKind: { ...meter.usdByKind } };
  }

  /**
   * Apply the budget envelopes to one raw slice price: the
   * session cap, then the daily cap, then the monthly cap —
   * the tightest one wins. Records the spend in all three
   * rollups and marks the meter capped when any cap binds.
   */
  private applyCaps(meter: VoiceV30CostSessionMeter, rawUsd: number, atMs: number): number {
    if (rawUsd <= 0) return 0;
    let usd = rawUsd;
    if (this.sessionBudget.capUsd > 0 && meter.usd + usd > this.sessionBudget.capUsd) {
      usd = round4V30(Math.max(0, this.sessionBudget.capUsd - meter.usd));
      meter.capped = true;
    }
    if (this.dailyBudget.capUsd > 0) {
      const day = dayKeyV30(atMs);
      const spent = this.dailySpend.get(day) ?? 0;
      if (spent + usd > this.dailyBudget.capUsd) {
        usd = round4V30(Math.max(0, this.dailyBudget.capUsd - spent));
        meter.capped = true;
      }
    }
    if (this.monthlyBudget.capUsd > 0) {
      const month = monthKeyV30(atMs);
      const spent = this.monthlySpend.get(month) ?? 0;
      if (spent + usd > this.monthlyBudget.capUsd) {
        usd = round4V30(Math.max(0, this.monthlyBudget.capUsd - spent));
        meter.capped = true;
      }
    }
    const day = dayKeyV30(atMs);
    const week = weekKeyV30(atMs);
    const month = monthKeyV30(atMs);
    this.dailySpend.set(day, round4V30((this.dailySpend.get(day) ?? 0) + usd));
    this.weeklySpend.set(week, round4V30((this.weeklySpend.get(week) ?? 0) + usd));
    this.monthlySpend.set(month, round4V30((this.monthlySpend.get(month) ?? 0) + usd));
    return usd;
  }

  private checkAlerts(meter: VoiceV30CostSessionMeter, atMs: number): void {
    if (!meter.warned && this.sessionBudget.warnAtUsd > 0 && meter.usd >= this.sessionBudget.warnAtUsd) {
      meter.warned = true;
      this.fireAlert({
        atMs,
        sessionId: meter.sessionId,
        level: 'warning',
        message: `Session spend ${formatUsdV30(meter.usd)} passed the ${formatUsdV30(this.sessionBudget.warnAtUsd)} warning threshold`,
        usdSoFar: meter.usd,
      });
    }
    if (meter.capped) {
      const already = this.alerts.some(
        (a) => a.sessionId === meter.sessionId && a.level === 'cap-reached',
      );
      if (!already) {
        this.fireAlert({
          atMs,
          sessionId: meter.sessionId,
          level: 'cap-reached',
          message: `Session spend capped at ${formatUsdV30(meter.usd)} — further audio is not billed`,
          usdSoFar: meter.usd,
        });
      }
    }
  }

  private fireAlert(alert: VoiceV30CostAlert): void {
    this.alerts.push(alert);
    this.onAlert?.({ ...alert });
  }
}

export function createCostLedgerV30(opts: CostLedgerV30Options = {}): CostLedgerV30 {
  return new CostLedgerV30(opts);
}
