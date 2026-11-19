/**
 * Per-minute cost accounting v29 (v1.42, Team T4).
 *
 * Every full-duplex session is metered in minutes and
 * priced from a configurable per-model rate table (see
 * `VOICE_V29_RATE_TABLE_DEFAULT` in types.ts — the
 * GPT-Live $0.05/min figure comes from the v1.42 survey;
 * the other entries are planning defaults the host must
 * override with its own contract rates). Nothing here
 * dials a provider or reads a key: the ledger only
 * multiplies minutes by rates.
 *
 * Metering is per-second granular: a session that ran
 * 90 seconds bills 1.5 minutes, not 2. Input minutes
 * (user speaking) and output minutes (agent speaking)
 * are tracked separately so split-rate models can price
 * them differently. Caps are enforced locally: a session
 * cap stops further billing (and reports the session as
 * capped), a daily cap does the same across sessions, and
 * a warning threshold fires an alert before the cap is
 * hit. Alerts never spend money — they only report.
 *
 * All clocks virtual (the caller passes `atMs`).
 */

import {
  VOICE_V29_COST_CAP_DEFAULT_USD,
  VOICE_V29_COST_WARN_DEFAULT_USD,
  VOICE_V29_RATE_TABLE_DEFAULT,
  costForMinutesV29,
  costForSliceV29,
  rateForModelV29,
  round4V29,
  type VoiceV29CostAlert,
  type VoiceV29CostEntry,
  type VoiceV29ModelId,
  type VoiceV29RateEntry,
} from './types';

export interface CostLedgerV29Options {
  /** Rate table (defaults to the survey planning table). */
  rates?: VoiceV29RateEntry[];
  /** Per-session spend cap (USD, 0 = unlimited). */
  sessionCapUsd?: number;
  /** Daily spend cap across all sessions (USD, 0 = unlimited). */
  dailyCapUsd?: number;
  /** Warn when a session passes this spend (USD). */
  warnAtUsd?: number;
  /** Called when an alert fires. */
  onAlert?: (alert: VoiceV29CostAlert) => void;
}

export interface VoiceV29CostSessionMeter {
  sessionId: string;
  modelId: VoiceV29ModelId;
  startedAtMs: number;
  lastTickAtMs: number;
  inputMs: number;
  outputMs: number;
  usd: number;
  capped: boolean;
  warned: boolean;
}

export interface VoiceV29CostReport {
  sessions: number;
  entries: number;
  totalMinutes: number;
  totalInputMinutes: number;
  totalOutputMinutes: number;
  totalUsd: number;
  byModel: Record<string, { minutes: number; usd: number; sessions: number }>;
  bySession: Record<string, { minutes: number; usd: number; modelId: string }>;
  alerts: number;
  cappedSessions: string[];
}

export interface VoiceV29CostEstimate {
  modelId: VoiceV29ModelId;
  minutes: number;
  usdPerMinute: number;
  estimatedUsd: number;
  withinSessionCap: boolean;
  withinDailyCap: boolean;
  note: string;
}

export function defaultCostLedgerV29Options(): CostLedgerV29Options {
  return {
    rates: [...VOICE_V29_RATE_TABLE_DEFAULT],
    sessionCapUsd: VOICE_V29_COST_CAP_DEFAULT_USD,
    dailyCapUsd: 0,
    warnAtUsd: VOICE_V29_COST_WARN_DEFAULT_USD,
  };
}

export class CostLedgerV29 {
  private rates: VoiceV29RateEntry[];
  private readonly sessionCapUsd: number;
  private readonly dailyCapUsd: number;
  private readonly warnAtUsd: number;
  private readonly onAlert?: (alert: VoiceV29CostAlert) => void;

  private readonly meters = new Map<string, VoiceV29CostSessionMeter>();
  private readonly entries: VoiceV29CostEntry[] = [];
  private readonly alerts: VoiceV29CostAlert[] = [];
  /** Daily spend keyed by UTC date (YYYY-MM-DD). */
  private readonly dailySpend = new Map<string, number>();

  constructor(opts: CostLedgerV29Options = {}) {
    this.rates = (opts.rates ?? [...VOICE_V29_RATE_TABLE_DEFAULT]).map((r) => ({ ...r }));
    this.sessionCapUsd = opts.sessionCapUsd ?? VOICE_V29_COST_CAP_DEFAULT_USD;
    this.dailyCapUsd = opts.dailyCapUsd ?? 0;
    this.warnAtUsd = opts.warnAtUsd ?? VOICE_V29_COST_WARN_DEFAULT_USD;
    this.onAlert = opts.onAlert;
  }

  /** Current rate table (copies). */
  getRates(): VoiceV29RateEntry[] {
    return this.rates.map((r) => ({ ...r }));
  }

  /** Override one model's rate (marks it overridden). */
  overrideRate(modelId: VoiceV29ModelId, usdPerMinute: number, source = 'host override'): VoiceV29RateEntry {
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
    const entry: VoiceV29RateEntry = {
      modelId,
      usdPerMinute,
      usdPerMinuteInput: null,
      usdPerMinuteOutput: null,
      source,
      overridden: true,
    };
    this.rates.push(entry);
    return { ...entry };
  }

  /** Start metering a session (idempotent: starting twice keeps the first meter). */
  startSession(sessionId: string, modelId: VoiceV29ModelId, atMs: number): VoiceV29CostSessionMeter {
    const existing = this.meters.get(sessionId);
    if (existing) return { ...existing };
    const meter: VoiceV29CostSessionMeter = {
      sessionId,
      modelId,
      startedAtMs: atMs,
      lastTickAtMs: atMs,
      inputMs: 0,
      outputMs: 0,
      usd: 0,
      capped: false,
      warned: false,
    };
    this.meters.set(sessionId, meter);
    return { ...meter };
  }

  /**
   * Meter a slice of a session: `inputMs` of user audio
   * and `outputMs` of agent audio since the last tick.
   * Minutes are billed per second (ms / 60000). Once a
   * session is capped, further slices cost $0 and are
   * still recorded (so the minutes stay honest).
   */
  tick(sessionId: string, inputMs: number, outputMs: number, atMs: number): VoiceV29CostEntry | null {
    const meter = this.meters.get(sessionId);
    if (!meter) return null;
    if (inputMs < 0 || outputMs < 0) throw new Error('Tick minutes must not be negative');
    const entry0 = rateForModelV29(this.rates, meter.modelId);
    const inputMinutes = inputMs / 60_000;
    const outputMinutes = outputMs / 60_000;
    let sliceUsd = 0;
    if (!meter.capped && entry0) {
      sliceUsd = costForSliceV29(inputMinutes, outputMinutes, entry0);
      // Enforce the session cap: bill only up to the cap.
      if (this.sessionCapUsd > 0 && meter.usd + sliceUsd > this.sessionCapUsd) {
        sliceUsd = round4V29(Math.max(0, this.sessionCapUsd - meter.usd));
        meter.capped = true;
      }
      // Enforce the daily cap the same way.
      if (this.dailyCapUsd > 0) {
        const day = dayKey(atMs);
        const spent = this.dailySpend.get(day) ?? 0;
        if (spent + sliceUsd > this.dailyCapUsd) {
          sliceUsd = round4V29(Math.max(0, this.dailyCapUsd - spent));
          meter.capped = true;
        }
        this.dailySpend.set(day, round4V29(spent + sliceUsd));
      }
    }
    meter.inputMs += inputMs;
    meter.outputMs += outputMs;
    meter.usd = round4V29(meter.usd + sliceUsd);
    meter.lastTickAtMs = atMs;
    const entry: VoiceV29CostEntry = {
      sessionId,
      modelId: meter.modelId,
      startedAtMs: meter.lastTickAtMs === atMs ? meter.startedAtMs : meter.lastTickAtMs,
      endedAtMs: atMs,
      inputMinutes: round4V29(inputMinutes),
      outputMinutes: round4V29(outputMinutes),
      usd: sliceUsd,
    };
    this.entries.push(entry);
    this.checkAlerts(meter, atMs);
    return { ...entry };
  }

  /** Stop metering a session; the meter stays readable. */
  stopSession(sessionId: string, atMs: number): VoiceV29CostSessionMeter | null {
    const meter = this.meters.get(sessionId);
    if (!meter) return null;
    meter.lastTickAtMs = atMs;
    return { ...meter };
  }

  getMeter(sessionId: string): VoiceV29CostSessionMeter | null {
    const meter = this.meters.get(sessionId);
    return meter ? { ...meter } : null;
  }

  listMeters(): VoiceV29CostSessionMeter[] {
    return [...this.meters.values()].map((m) => ({ ...m }));
  }

  /** Estimate the cost of `minutes` on a model (before spending). */
  estimate(modelId: VoiceV29ModelId, minutes: number, atMs: number): VoiceV29CostEstimate {
    const entry = rateForModelV29(this.rates, modelId);
    const rate = entry?.usdPerMinute ?? 0;
    const estimatedUsd = costForMinutesV29(minutes, rate);
    const daySpent = this.dailySpend.get(dayKey(atMs)) ?? 0;
    return {
      modelId,
      minutes,
      usdPerMinute: rate,
      estimatedUsd,
      withinSessionCap: this.sessionCapUsd <= 0 || estimatedUsd <= this.sessionCapUsd,
      withinDailyCap: this.dailyCapUsd <= 0 || daySpent + estimatedUsd <= this.dailyCapUsd,
      note:
        entry === null
          ? `No rate configured for ${modelId} — estimated $0`
          : entry.overridden
            ? `Rate overridden by the host (${entry.source})`
            : `Planning rate (${entry.source})`,
    };
  }

  alertsSoFar(): VoiceV29CostAlert[] {
    return this.alerts.map((a) => ({ ...a }));
  }

  report(): VoiceV29CostReport {
    const byModel: VoiceV29CostReport['byModel'] = {};
    const bySession: VoiceV29CostReport['bySession'] = {};
    let totalMinutes = 0;
    let totalInputMinutes = 0;
    let totalOutputMinutes = 0;
    let totalUsd = 0;
    for (const entry of this.entries) {
      const minutes = entry.inputMinutes + entry.outputMinutes;
      totalMinutes += minutes;
      totalInputMinutes += entry.inputMinutes;
      totalOutputMinutes += entry.outputMinutes;
      totalUsd += entry.usd;
      const m = byModel[entry.modelId] ?? { minutes: 0, usd: 0, sessions: 0 };
      m.minutes = round4V29(m.minutes + minutes);
      m.usd = round4V29(m.usd + entry.usd);
      byModel[entry.modelId] = m;
      const s = bySession[entry.sessionId] ?? { minutes: 0, usd: 0, modelId: entry.modelId };
      s.minutes = round4V29(s.minutes + minutes);
      s.usd = round4V29(s.usd + entry.usd);
      bySession[entry.sessionId] = s;
    }
    for (const modelId of Object.keys(byModel)) {
      byModel[modelId].sessions = new Set(
        this.entries.filter((e) => e.modelId === modelId).map((e) => e.sessionId),
      ).size;
    }
    return {
      sessions: this.meters.size,
      entries: this.entries.length,
      totalMinutes: round4V29(totalMinutes),
      totalInputMinutes: round4V29(totalInputMinutes),
      totalOutputMinutes: round4V29(totalOutputMinutes),
      totalUsd: round4V29(totalUsd),
      byModel,
      bySession,
      alerts: this.alerts.length,
      cappedSessions: [...this.meters.values()].filter((m) => m.capped).map((m) => m.sessionId),
    };
  }

  /** Export the report as Markdown. */
  toMarkdown(): string {
    const r = this.report();
    const lines = [
      '# Voice cost report (v29)',
      '',
      `- Sessions: ${r.sessions}`,
      `- Billed minutes: ${r.totalMinutes} (in ${r.totalInputMinutes} / out ${r.totalOutputMinutes})`,
      `- Total spend: $${r.totalUsd.toFixed(4)}`,
      `- Alerts: ${r.alerts}`,
      '',
      '## By model',
    ];
    for (const [modelId, row] of Object.entries(r.byModel)) {
      lines.push(`- ${modelId}: ${row.minutes} min, $${row.usd.toFixed(4)}, ${row.sessions} session(s)`);
    }
    lines.push('', '## By session');
    for (const [sessionId, row] of Object.entries(r.bySession)) {
      lines.push(`- ${sessionId} (${row.modelId}): ${row.minutes} min, $${row.usd.toFixed(4)}`);
    }
    return lines.join('\n');
  }

  private checkAlerts(meter: VoiceV29CostSessionMeter, atMs: number): void {
    if (!meter.warned && this.warnAtUsd > 0 && meter.usd >= this.warnAtUsd) {
      meter.warned = true;
      this.fireAlert({
        atMs,
        sessionId: meter.sessionId,
        level: 'warning',
        message: `Session spend $${meter.usd.toFixed(4)} passed the $${this.warnAtUsd} warning threshold`,
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
          message: `Session spend capped at $${meter.usd.toFixed(4)} — further audio is not billed`,
          usdSoFar: meter.usd,
        });
      }
    }
  }

  private fireAlert(alert: VoiceV29CostAlert): void {
    this.alerts.push(alert);
    this.onAlert?.({ ...alert });
  }
}

export function createCostLedgerV29(opts: CostLedgerV29Options = {}): CostLedgerV29 {
  return new CostLedgerV29(opts);
}

/** UTC date key (YYYY-MM-DD) for daily-cap accounting. */
export function dayKey(atMs: number): string {
  const d = new Date(atMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
