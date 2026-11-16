/**
 * Latency budget v2 (v1.15, Đội T5 — voice realtime v14).
 *
 * v13 budgets each stage and alerts on single slow samples and
 * p95 crossings — but it has no *session* view (which session
 * was slow, and how slow, end to end), no network stage (the
 * round trip to a cloud STT/TTS provider is invisible), no
 * severity (a 1 ms overrun and a 3× overrun alert the same
 * way), and no budget profiles (a local Whisper + Pocket TTS
 * setup and a cloud realtime API share one budget table).
 *
 * v14 wraps the v13 dashboard and adds, per session:
 *
 *   - a `network` stage (provider round-trip) alongside the
 *     seven v13 stages, so the budget table is capture / vad /
 *     stt / llm / tts / playback / network / e2e;
 *   - budget profiles: `local` (tight: on-device Whisper +
 *     Pocket TTS), `cloud` (default v13 budgets + network),
 *     `realtime` (speech-to-speech API, 700 ms e2e target) —
 *     plus a custom profile that overrides individual stages;
 *   - alert levels: `warn` (over budget) and `critical`
 *     (over `criticalFactor × budget`, default 1.5×, or the
 *     session p95 over budget twice in a row);
 *   - a per-session report: p50 / p95 / p99 per stage, budget
 *     compliance rate (share of turns inside budget), worst
 *     stage, and the alert history for that session;
 *   - a session percentile table the panel renders directly.
 *
 * Pure + clock-injectable like v13: the dashboard only records
 * numbers the caller measured; it never invents a sample and
 * never touches the network. The v13 dashboard stays the
 * source of truth for the global (all-session) stage reports;
 * v14 keeps the per-session breakdown on top of it.
 */

import {
  LatencyBudgetV13,
  percentileV13,
  stageReportV13,
  defaultLatencyBudgetV13Budgets,
  type LatencyBudgetV13Stage,
  type LatencyBudgetV13Budgets,
  type LatencyBudgetV13StageReport,
  type LatencyBudgetV13Alert,
  type LatencyBudgetV13Event,
} from './latencyBudgetV13';

/** Stages the v14 dashboard budgets (v13's seven + network). */
export type LatencyBudgetV14Stage = LatencyBudgetV13Stage | 'network';

/** The budgeted stages, in pipeline order. */
export const LATENCY_BUDGET_V14_STAGES: readonly LatencyBudgetV14Stage[] = [
  'capture',
  'vad',
  'stt',
  'llm',
  'tts',
  'playback',
  'network',
  'e2e',
];

/** Budgets (ms) for every v14 stage. */
export type LatencyBudgetV14Budgets = Record<LatencyBudgetV14Stage, number>;

/** Named budget profile. */
export type LatencyBudgetV14Profile = 'local' | 'cloud' | 'realtime' | 'custom';

/** The named profiles, in the order the picker shows them. */
export const LATENCY_BUDGET_V14_PROFILES: readonly LatencyBudgetV14Profile[] = [
  'local',
  'cloud',
  'realtime',
  'custom',
];

export function isLatencyBudgetV14Profile(value: unknown): value is LatencyBudgetV14Profile {
  return typeof value === 'string' && (LATENCY_BUDGET_V14_PROFILES as readonly string[]).includes(value);
}

/** Alert severity. */
export type LatencyBudgetV14AlertLevel = 'warn' | 'critical';

/** One v14 sample (stage sample tagged with its session). */
export interface LatencyBudgetV14Sample {
  sessionId: string;
  turnId: string;
  stage: LatencyBudgetV14Stage;
  ms: number;
  atMs: number;
}

/** A v14 alert: a v13 alert plus severity and session. */
export interface LatencyBudgetV14Alert {
  sessionId: string;
  turnId: string;
  stage: LatencyBudgetV14Stage;
  ms: number;
  budgetMs: number;
  overMs: number;
  level: LatencyBudgetV14AlertLevel;
  kind: 'sample' | 'p95';
  atMs: number;
  /** The v13 alert this was derived from (null for critical escalations). */
  source: LatencyBudgetV13Alert | null;
}

/** Per-stage report for one session: percentiles + compliance. */
export interface LatencyBudgetV14SessionStageReport {
  stage: LatencyBudgetV14Stage;
  budgetMs: number;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
  over: number;
  overRate: number;
  overBudget: boolean;
}

/** One session's latency report. */
export interface LatencyBudgetV14SessionReport {
  sessionId: string;
  profile: LatencyBudgetV14Profile;
  stages: LatencyBudgetV14SessionStageReport[];
  turns: number;
  /** Turns fully inside budget (every recorded stage under budget). */
  turnsInBudget: number;
  /** Share of turns inside budget (0..1, 0 when no turns). */
  complianceRate: number;
  /** Worst stage by over-rate (null when nothing measured). */
  worstStage: LatencyBudgetV14Stage | null;
  worstOverRate: number;
  alerts: number;
  criticalAlerts: number;
  /** End-to-end p50 / p95 (null when e2e was never recorded). */
  e2eP50Ms: number | null;
  e2eP95Ms: number | null;
}

/** Counters for one v14 dashboard. */
export interface LatencyBudgetV14Stats {
  sessions: number;
  samples: number;
  turns: number;
  alerts: number;
  criticalAlerts: number;
  /** Sessions whose compliance rate is below 1 (at least one overrun turn). */
  sessionsWithOverruns: number;
  /** Worst session by compliance rate (null when none). */
  worstSessionId: string | null;
  worstComplianceRate: number;
}

/** Options for the v14 dashboard. */
export interface LatencyBudgetV14Options {
  /** Budget profile (default 'cloud'). */
  profile?: LatencyBudgetV14Profile;
  /** Per-stage budget overrides (ms); applied on top of the profile. */
  budgets?: Partial<LatencyBudgetV14Budgets>;
  /** Over-budget factor that escalates a sample alert to critical (default 1.5). */
  criticalFactor?: number;
  /** Max samples kept per stage per session (default 500). */
  maxSamplesPerStage?: number;
  /** Max alert records kept (default 200). */
  maxAlerts?: number;
}

/** Events emitted by the v14 dashboard. */
export type LatencyBudgetV14Event =
  | { kind: 'alert'; alert: LatencyBudgetV14Alert }
  | { kind: 'v13'; event: LatencyBudgetV13Event }
  | { kind: 'session-report'; report: LatencyBudgetV14SessionReport };

export type LatencyBudgetV14EventSink = (event: LatencyBudgetV14Event) => void;

/** Budget tables per profile (ms). */
export function latencyBudgetV14ProfileBudgets(profile: LatencyBudgetV14Profile): LatencyBudgetV14Budgets {
  const v13 = defaultLatencyBudgetV13Budgets();
  switch (profile) {
    case 'local':
      // On-device Whisper + Pocket TTS: no network leg, tight e2e.
      return { ...v13, capture: 40, vad: 80, stt: 250, llm: 1200, tts: 350, playback: 120, network: 0, e2e: 1800 };
    case 'realtime':
      // Speech-to-speech API: the 550–700 ms e2e target from the
      // v1.15 survey; STT/LLM/TTS collapse into the API call, so
      // their individual budgets stay loose and e2e is strict.
      return { ...v13, capture: 40, vad: 60, stt: 200, llm: 300, tts: 200, playback: 100, network: 150, e2e: 700 };
    case 'cloud':
      return { ...v13, network: 250 };
    case 'custom':
      return { ...v13, network: 250 };
    default:
      throw new Error(`Latency budget v14 unknown profile "${profile as string}".`);
  }
}

export function defaultLatencyBudgetV14Options(): {
  profile: LatencyBudgetV14Profile;
  budgets: LatencyBudgetV14Budgets;
  criticalFactor: number;
  maxSamplesPerStage: number;
  maxAlerts: number;
} {
  return {
    profile: 'cloud',
    budgets: latencyBudgetV14ProfileBudgets('cloud'),
    criticalFactor: 1.5,
    maxSamplesPerStage: 500,
    maxAlerts: 200,
  };
}

export function validateLatencyBudgetV14Options(options: LatencyBudgetV14Options): {
  profile: LatencyBudgetV14Profile;
  budgets: LatencyBudgetV14Budgets;
  criticalFactor: number;
  maxSamplesPerStage: number;
  maxAlerts: number;
} {
  const base = defaultLatencyBudgetV14Options();
  const profile = options.profile ?? base.profile;
  if (!isLatencyBudgetV14Profile(profile)) {
    throw new Error(`Latency budget v14 profile must be one of ${LATENCY_BUDGET_V14_PROFILES.join(', ')}.`);
  }
  const budgets: LatencyBudgetV14Budgets = { ...latencyBudgetV14ProfileBudgets(profile) };
  if (options.budgets !== undefined) {
    if (typeof options.budgets !== 'object' || options.budgets === null) {
      throw new Error('Latency budget v14 budgets must be an object.');
    }
    for (const key of Object.keys(options.budgets)) {
      if (!LATENCY_BUDGET_V14_STAGES.includes(key as LatencyBudgetV14Stage)) {
        throw new Error(`Latency budget v14 unknown stage "${key}".`);
      }
    }
    for (const stage of LATENCY_BUDGET_V14_STAGES) {
      const value = options.budgets[stage];
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0 || value > 600000) {
        throw new Error(`Latency budget v14 budget for "${stage}" must be a finite number in [0, 600000].`);
      }
      budgets[stage] = Math.floor(value);
    }
  }
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Latency budget v14 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    profile,
    budgets,
    criticalFactor: num(options.criticalFactor, base.criticalFactor, 'criticalFactor', 1, 10),
    maxSamplesPerStage: Math.floor(num(options.maxSamplesPerStage, base.maxSamplesPerStage, 'maxSamplesPerStage', 1, 100000)),
    maxAlerts: Math.floor(num(options.maxAlerts, base.maxAlerts, 'maxAlerts', 1, 10000)),
  };
}

/** Build one session-stage report from its samples and budget. Pure. */
export function sessionStageReportV14(
  stage: LatencyBudgetV14Stage,
  samplesMs: number[],
  budgetMs: number,
): LatencyBudgetV14SessionStageReport {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const over = samplesMs.filter((ms) => ms > budgetMs).length;
  const p95 = percentileV13(sorted, 95);
  const base: LatencyBudgetV13StageReport = stageReportV13(stage as LatencyBudgetV13Stage, samplesMs, budgetMs);
  return {
    stage,
    budgetMs,
    samples: samplesMs.length,
    p50Ms: base.p50Ms,
    p95Ms: p95,
    p99Ms: percentileV13(sorted, 99),
    maxMs: base.maxMs,
    meanMs: base.meanMs,
    over,
    overRate: base.overRate,
    overBudget: base.overBudget,
  };
}

/**
 * Latency budget dashboard v2: a v13 dashboard for the global
 * stage view plus per-session samples, network stage, profiles
 * and warn/critical alerts. A `network` sample is recorded in
 * the v14 per-session store only — the v13 dashboard has no
 * network stage, so its global reports simply omit it.
 */
export class LatencyBudgetV14 {
  private readonly profile: LatencyBudgetV14Profile;
  private readonly budgets: LatencyBudgetV14Budgets;
  private readonly criticalFactor: number;
  private readonly maxSamplesPerStage: number;
  private readonly maxAlerts: number;
  private readonly sink: LatencyBudgetV14EventSink | null;
  private readonly v13: LatencyBudgetV13;
  /** sessionId -> stage -> samples */
  private readonly sessionSamples = new Map<string, Map<LatencyBudgetV14Stage, number[]>>();
  /** sessionId -> turnId -> stages recorded */
  private readonly sessionTurns = new Map<string, Map<string, Partial<Record<LatencyBudgetV14Stage, number>>>>();
  private readonly alerts: LatencyBudgetV14Alert[] = [];
  private criticalAlerts = 0;

  constructor(options: LatencyBudgetV14Options = {}, sink: LatencyBudgetV14EventSink | null = null) {
    const validated = validateLatencyBudgetV14Options(options);
    this.profile = validated.profile;
    this.budgets = validated.budgets;
    this.criticalFactor = validated.criticalFactor;
    this.maxSamplesPerStage = validated.maxSamplesPerStage;
    this.maxAlerts = validated.maxAlerts;
    this.sink = sink;
    const v13Budgets: LatencyBudgetV13Budgets = {
      capture: this.budgets.capture,
      vad: this.budgets.vad,
      stt: this.budgets.stt,
      llm: this.budgets.llm,
      tts: this.budgets.tts,
      playback: this.budgets.playback,
      e2e: this.budgets.e2e,
    };
    this.v13 = new LatencyBudgetV13(
      { budgets: v13Budgets, maxSamplesPerStage: this.maxSamplesPerStage },
      (event) => {
        if (event.kind === 'alert') this.onV13Alert(event.alert);
        this.sink?.({ kind: 'v13', event });
      },
    );
  }

  getProfile(): LatencyBudgetV14Profile {
    return this.profile;
  }

  getBudgets(): LatencyBudgetV14Budgets {
    return { ...this.budgets };
  }

  /** The wrapped v13 dashboard (global stage reports). */
  getV13(): LatencyBudgetV13 {
    return this.v13;
  }

  /** Change one stage's budget (ms). Returns the new budget. */
  setBudget(stage: LatencyBudgetV14Stage, ms: number): number {
    if (!LATENCY_BUDGET_V14_STAGES.includes(stage)) {
      throw new Error(`Latency budget v14 unknown stage "${stage}".`);
    }
    if (!Number.isFinite(ms) || ms < 0 || ms > 600000) {
      throw new Error('Latency budget v14 budget must be a finite number in [0, 600000].');
    }
    this.budgets[stage] = Math.floor(ms);
    if (stage !== 'network') this.v13.setBudget(stage, Math.max(1, this.budgets[stage]));
    return this.budgets[stage];
  }

  private sessionStore(sessionId: string): Map<LatencyBudgetV14Stage, number[]> {
    let store = this.sessionSamples.get(sessionId);
    if (!store) {
      store = new Map<LatencyBudgetV14Stage, number[]>();
      for (const stage of LATENCY_BUDGET_V14_STAGES) store.set(stage, []);
      this.sessionSamples.set(sessionId, store);
    }
    return store;
  }

  private pushAlert(alert: LatencyBudgetV14Alert): void {
    this.alerts.push(alert);
    if (this.alerts.length > this.maxAlerts) this.alerts.splice(0, this.alerts.length - this.maxAlerts);
    if (alert.level === 'critical') this.criticalAlerts += 1;
    this.sink?.({ kind: 'alert', alert: { ...alert } });
  }

  /** A v13 alert becomes a v14 alert (warn, or critical past the factor). */
  private onV13Alert(alert: LatencyBudgetV13Alert): void {
    const stage = alert.stage as LatencyBudgetV14Stage;
    const budgetMs = this.budgets[stage];
    const level: LatencyBudgetV14AlertLevel =
      alert.ms >= budgetMs * this.criticalFactor ? 'critical' : 'warn';
    // The session is unknown to v13 (its turn ids are global);
    // attribute the alert to the session that owns the turn when
    // the caller recorded the turn through v14, else 'unknown'.
    const sessionId = this.sessionIdForTurn(alert.turnId) ?? 'unknown';
    this.pushAlert({
      sessionId,
      turnId: alert.turnId,
      stage,
      ms: alert.ms,
      budgetMs,
      overMs: alert.overMs,
      level,
      kind: alert.kind,
      atMs: alert.atMs,
      source: alert,
    });
  }

  private sessionIdForTurn(turnId: string): string | null {
    for (const [sessionId, turns] of this.sessionTurns) {
      if (turns.has(turnId)) return sessionId;
    }
    return null;
  }

  /**
   * Record one stage sample for a session. `network` samples
   * stay in the v14 store; every other stage also feeds the
   * v13 dashboard (which fires its own sample/p95 alerts, and
   * v14 re-emits them with a level and session attached).
   */
  recordStage(sample: LatencyBudgetV14Sample): LatencyBudgetV14SessionStageReport {
    if (!LATENCY_BUDGET_V14_STAGES.includes(sample.stage)) {
      throw new Error(`Latency budget v14 unknown stage "${sample.stage}".`);
    }
    if (!Number.isFinite(sample.ms) || sample.ms < 0) {
      throw new Error('Latency budget v14 sample ms must be a finite number >= 0.');
    }
    if (!sample.sessionId.trim() || !sample.turnId.trim()) {
      throw new Error('Latency budget v14 sample needs a non-empty sessionId and turnId.');
    }
    const store = this.sessionStore(sample.sessionId);
    const list = store.get(sample.stage) as number[];
    list.push(Math.round(sample.ms));
    if (list.length > this.maxSamplesPerStage) list.splice(0, list.length - this.maxSamplesPerStage);
    let turns = this.sessionTurns.get(sample.sessionId);
    if (!turns) {
      turns = new Map();
      this.sessionTurns.set(sample.sessionId, turns);
    }
    const turn = turns.get(sample.turnId) ?? {};
    turn[sample.stage] = Math.round(sample.ms);
    turns.set(sample.turnId, turn);
    if (sample.stage === 'network') {
      // The network leg has no v13 counterpart: alert here.
      const budgetMs = this.budgets.network;
      if (sample.ms > budgetMs) {
        const level: LatencyBudgetV14AlertLevel =
          sample.ms >= budgetMs * this.criticalFactor ? 'critical' : 'warn';
        this.pushAlert({
          sessionId: sample.sessionId,
          turnId: sample.turnId,
          stage: 'network',
          ms: Math.round(sample.ms),
          budgetMs,
          overMs: Math.round(sample.ms - budgetMs),
          level,
          kind: 'sample',
          atMs: sample.atMs,
          source: null,
        });
      }
    } else {
      this.v13.recordStage({ turnId: sample.turnId, stage: sample.stage, ms: sample.ms, atMs: sample.atMs });
    }
    return sessionStageReportV14(sample.stage, list, this.budgets[sample.stage]);
  }

  /** Record a whole turn at once for a session (stages + optional e2e). */
  recordTurn(
    sessionId: string,
    turnId: string,
    stages: Partial<Record<LatencyBudgetV14Stage, number>>,
    atMs: number,
  ): LatencyBudgetV14SessionReport {
    for (const [stage, ms] of Object.entries(stages)) {
      this.recordStage({ sessionId, turnId, stage: stage as LatencyBudgetV14Stage, ms: ms as number, atMs });
    }
    return this.getSessionReport(sessionId);
  }

  /** Per-stage reports for one session (budget vs reality + p99). */
  getSessionStageReports(sessionId: string): LatencyBudgetV14SessionStageReport[] {
    const store = this.sessionSamples.get(sessionId);
    return LATENCY_BUDGET_V14_STAGES.map((stage) =>
      sessionStageReportV14(stage, store ? (store.get(stage) as number[]) : [], this.budgets[stage]),
    );
  }

  /** Full report for one session: percentiles, compliance, worst stage, alerts. */
  getSessionReport(sessionId: string): LatencyBudgetV14SessionReport {
    const report = this.buildSessionReport(sessionId);
    this.sink?.({ kind: 'session-report', report });
    return report;
  }

  private buildSessionReport(sessionId: string): LatencyBudgetV14SessionReport {
    const stages = this.getSessionStageReports(sessionId);
    const turns = this.sessionTurns.get(sessionId);
    const turnCount = turns ? turns.size : 0;
    let turnsInBudget = 0;
    if (turns) {
      for (const recorded of turns.values()) {
        const over = (Object.keys(recorded) as LatencyBudgetV14Stage[]).some(
          (stage) => (recorded[stage] as number) > this.budgets[stage],
        );
        if (!over) turnsInBudget += 1;
      }
    }
    const measured = stages.filter((r) => r.samples > 0);
    const worst = measured.reduce<LatencyBudgetV14SessionStageReport | null>(
      (acc, r) => (acc === null || r.overRate > acc.overRate ? r : acc),
      null,
    );
    const e2e = stages.find((r) => r.stage === 'e2e');
    const sessionAlerts = this.alerts.filter((a) => a.sessionId === sessionId);
    const report: LatencyBudgetV14SessionReport = {
      sessionId,
      profile: this.profile,
      stages,
      turns: turnCount,
      turnsInBudget,
      complianceRate: turnCount === 0 ? 0 : Math.round((turnsInBudget / turnCount) * 100) / 100,
      worstStage: worst ? worst.stage : null,
      worstOverRate: worst ? worst.overRate : 0,
      alerts: sessionAlerts.length,
      criticalAlerts: sessionAlerts.filter((a) => a.level === 'critical').length,
      e2eP50Ms: e2e ? e2e.p50Ms : null,
      e2eP95Ms: e2e ? e2e.p95Ms : null,
    };
    return report;
  }

  /** Reports for every session that recorded anything. */
  getAllSessionReports(): LatencyBudgetV14SessionReport[] {
    return [...this.sessionSamples.keys()].map((id) => this.buildSessionReport(id));
  }

  /** Alert history, oldest first (copies). */
  getAlerts(sessionId?: string): LatencyBudgetV14Alert[] {
    const list = sessionId === undefined ? this.alerts : this.alerts.filter((a) => a.sessionId === sessionId);
    return list.map((a) => ({ ...a }));
  }

  /** Critical alerts only. */
  getCriticalAlerts(sessionId?: string): LatencyBudgetV14Alert[] {
    return this.getAlerts(sessionId).filter((a) => a.level === 'critical');
  }

  getStats(): LatencyBudgetV14Stats {
    const reports = this.getAllSessionReports();
    const samples = reports.reduce((a, r) => a + r.stages.reduce((x, s) => x + s.samples, 0), 0);
    const worst = reports.reduce<LatencyBudgetV14SessionReport | null>(
      (acc, r) => (acc === null || (r.turns > 0 && r.complianceRate < acc.complianceRate) ? r : acc),
      null,
    );
    return {
      sessions: reports.length,
      samples,
      turns: reports.reduce((a, r) => a + r.turns, 0),
      alerts: this.alerts.length,
      criticalAlerts: this.criticalAlerts,
      sessionsWithOverruns: reports.filter((r) => r.complianceRate < 1 && r.turns > 0).length,
      worstSessionId: worst && worst.turns > 0 ? worst.sessionId : null,
      worstComplianceRate: worst && worst.turns > 0 ? worst.complianceRate : 0,
    };
  }

  reset(): void {
    this.sessionSamples.clear();
    this.sessionTurns.clear();
    this.alerts.length = 0;
    this.criticalAlerts = 0;
    this.v13.reset();
  }
}

/** Create a latency budget dashboard v2 (factory). */
export function createLatencyBudgetV14(
  options: LatencyBudgetV14Options = {},
  sink: LatencyBudgetV14EventSink | null = null,
): LatencyBudgetV14 {
  return new LatencyBudgetV14(options, sink);
}

/** One-line summary of v14 stats. */
export function latencyBudgetV14Summary(stats: LatencyBudgetV14Stats): string {
  return (
    `Latency budget v14: ${stats.sessions} sessions, ${stats.samples} samples, ${stats.turns} turns, ` +
    `${stats.alerts} alerts (${stats.criticalAlerts} critical), ` +
    `${stats.sessionsWithOverruns} sessions with overruns, ` +
    `worst session ${stats.worstSessionId ?? '-'} (compliance ${stats.worstComplianceRate})`
  );
}

/** One session's report as Markdown (for the diagnostics panel). */
export function latencyBudgetV14SessionMarkdown(report: LatencyBudgetV14SessionReport): string {
  const lines = [
    `## Latency budget v14 — session ${report.sessionId} (profile ${report.profile})`,
    '',
    `- turns: ${report.turns}, in budget: ${report.turnsInBudget} (compliance ${report.complianceRate})`,
    `- e2e p50: ${report.e2eP50Ms === null ? '-' : `${report.e2eP50Ms} ms`}, p95: ${report.e2eP95Ms === null ? '-' : `${report.e2eP95Ms} ms`}`,
    `- alerts: ${report.alerts} (${report.criticalAlerts} critical), worst stage: ${report.worstStage ?? '-'} (over-rate ${report.worstOverRate})`,
    '',
    '| stage | budget | p50 | p95 | p99 | max | over |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of report.stages) {
    const cell = (v: number | null): string => (v === null ? '-' : `${v} ms`);
    lines.push(
      `| ${r.stage} | ${r.budgetMs} ms | ${cell(r.p50Ms)} | ${cell(r.p95Ms)} | ${cell(r.p99Ms)} | ${cell(r.maxMs)} | ${r.over}/${r.samples}${r.overBudget ? ' ⚠' : ''} |`,
    );
  }
  return lines.join('\n');
}
