/**
 * Latency budget dashboard v13 (v1.14, Đội T5 — voice
 * realtime v13).
 *
 * v1.05's latency pipeline *measures* each leg of the voice
 * path (capture → VAD → STT → LLM → TTS → playback) and reports
 * p50 / p95 / p99. It never says whether a leg is *too slow*.
 * v13 adds the budget: every stage gets a millisecond budget,
 * every sample is judged against it, and the dashboard shows
 * budget vs reality per stage plus a per-turn report:
 *
 *   stage     budget   p50   p95   max   over
 *   vad        120 ms  80    110   140    1/40
 *   stt        400 ms  310   520   900    3/40  ⚠
 *   llm       1500 ms  900  1400  2100    2/40  ⚠
 *   tts        600 ms  420   580   640    1/40
 *   playback   150 ms  90    120   130    0/40
 *   e2e       2500 ms  1800  2400  2900   1/40  ⚠
 *
 * An alert fires (once per stage per turn, then again only
 * after the stage recovers) when a sample exceeds its budget,
 * so the panel can flag the slow leg while the call is still
 * running instead of in a post-mortem. Budgets are
 * configurable per session: a local Whisper + Edge TTS setup
 * gets tighter budgets than a cloud realtime API.
 *
 * Pure + clock-injectable: the dashboard only records numbers
 * the caller measured; it never invents a sample. Stages the
 * caller cannot observe stay "not measured".
 */

import type { VoiceLatencyStage } from './latencyPipeline';

/** Stages the dashboard budgets (the pipeline's six + end-to-end). */
export type LatencyBudgetV13Stage = VoiceLatencyStage | 'e2e';

/** The budgeted stages, in pipeline order. */
export const LATENCY_BUDGET_V13_STAGES: readonly LatencyBudgetV13Stage[] = [
  'capture',
  'vad',
  'stt',
  'llm',
  'tts',
  'playback',
  'e2e',
];

/** Budgets (ms) for every stage. */
export type LatencyBudgetV13Budgets = Record<LatencyBudgetV13Stage, number>;

/** One recorded sample. */
export interface LatencyBudgetV13Sample {
  turnId: string;
  stage: LatencyBudgetV13Stage;
  ms: number;
  atMs: number;
}

/** Per-stage report: budget vs measured reality. */
export interface LatencyBudgetV13StageReport {
  stage: LatencyBudgetV13Stage;
  budgetMs: number;
  samples: number;
  /** Null when the stage was never measured. */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
  /** Samples over budget. */
  over: number;
  /** Share of samples over budget (0..1, 0 when none). */
  overRate: number;
  /** True when the p95 is over budget (the stage is systematically slow). */
  overBudget: boolean;
}

/** One turn's latency, stage by stage. */
export interface LatencyBudgetV13TurnReport {
  turnId: string;
  atMs: number;
  /** Ms per stage (only stages the caller recorded). */
  stages: Partial<Record<LatencyBudgetV13Stage, number>>;
  /** End-to-end ms when the caller recorded it (null otherwise). */
  e2eMs: number | null;
  /** Stages over budget in this turn. */
  over: LatencyBudgetV13Stage[];
  /** True when any stage is over budget. */
  hasOverrun: boolean;
}

/** An over-budget alert. */
export interface LatencyBudgetV13Alert {
  turnId: string;
  stage: LatencyBudgetV13Stage;
  ms: number;
  budgetMs: number;
  /** How far over budget (ms). */
  overMs: number;
  atMs: number;
  /** 'sample' = one slow sample; 'p95' = the stage's p95 crossed its budget. */
  kind: 'sample' | 'p95';
}

/** Options for the dashboard. */
export interface LatencyBudgetV13Options {
  /** Per-stage budgets (ms); anything not given keeps its default. */
  budgets?: Partial<LatencyBudgetV13Budgets>;
  /** Max samples kept per stage (default 500). */
  maxSamplesPerStage?: number;
  /** Max turn reports kept (default 100). */
  maxTurns?: number;
}

/** Counters for one dashboard. */
export interface LatencyBudgetV13Stats {
  samples: number;
  turns: number;
  alerts: number;
  /** Turns with at least one stage over budget. */
  overrunTurns: number;
  /** Worst stage by over-rate (null when nothing measured). */
  worstStage: LatencyBudgetV13Stage | null;
  /** Highest over-rate across stages (0 when none). */
  worstOverRate: number;
}

/** Events emitted by the dashboard. */
export type LatencyBudgetV13Event =
  | { kind: 'alert'; alert: LatencyBudgetV13Alert }
  | { kind: 'turn-recorded'; report: LatencyBudgetV13TurnReport };

export type LatencyBudgetV13EventSink = (event: LatencyBudgetV13Event) => void;

/** Default budgets (ms): a cascaded local-first pipeline. */
export function defaultLatencyBudgetV13Budgets(): LatencyBudgetV13Budgets {
  return {
    capture: 50,
    vad: 120,
    stt: 400,
    llm: 1500,
    tts: 600,
    playback: 150,
    e2e: 2500,
  };
}

export function defaultLatencyBudgetV13Options(): { budgets: LatencyBudgetV13Budgets; maxSamplesPerStage: number; maxTurns: number } {
  return { budgets: defaultLatencyBudgetV13Budgets(), maxSamplesPerStage: 500, maxTurns: 100 };
}

export function validateLatencyBudgetV13Options(options: LatencyBudgetV13Options): { budgets: LatencyBudgetV13Budgets; maxSamplesPerStage: number; maxTurns: number } {
  const base = defaultLatencyBudgetV13Options();
  const budgets: LatencyBudgetV13Budgets = { ...base.budgets };
  if (options.budgets !== undefined) {
    if (typeof options.budgets !== 'object' || options.budgets === null) {
      throw new Error('Latency budget v13 budgets must be an object.');
    }
    for (const key of Object.keys(options.budgets)) {
      if (!LATENCY_BUDGET_V13_STAGES.includes(key as LatencyBudgetV13Stage)) {
        throw new Error(`Latency budget v13 unknown stage "${key}".`);
      }
    }
    for (const stage of LATENCY_BUDGET_V13_STAGES) {
      const value = options.budgets[stage];
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value <= 0 || value > 600000) {
        throw new Error(`Latency budget v13 budget for "${stage}" must be a finite number in (0, 600000].`);
      }
      budgets[stage] = Math.floor(value);
    }
  }
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Latency budget v13 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    budgets,
    maxSamplesPerStage: Math.floor(num(options.maxSamplesPerStage, base.maxSamplesPerStage, 'maxSamplesPerStage', 1, 100000)),
    maxTurns: Math.floor(num(options.maxTurns, base.maxTurns, 'maxTurns', 1, 10000)),
  };
}

/** Percentile of a sorted sample list (linear interpolation). Returns null when empty. */
export function percentileV13(sortedMs: number[], p: number): number | null {
  if (sortedMs.length === 0) return null;
  if (p <= 0) return sortedMs[0] as number;
  if (p >= 100) return sortedMs[sortedMs.length - 1] as number;
  const rank = (p / 100) * (sortedMs.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sortedMs[low] as number;
  const highValue = sortedMs[high] as number;
  return Math.round(lowValue + (highValue - lowValue) * (rank - low));
}

/** Build one stage's report from its samples and budget. Pure. */
export function stageReportV13(stage: LatencyBudgetV13Stage, samplesMs: number[], budgetMs: number): LatencyBudgetV13StageReport {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const over = samplesMs.filter((ms) => ms > budgetMs).length;
  const p95 = percentileV13(sorted, 95);
  return {
    stage,
    budgetMs,
    samples: samplesMs.length,
    p50Ms: percentileV13(sorted, 50),
    p95Ms: p95,
    maxMs: sorted.length === 0 ? null : (sorted[sorted.length - 1] as number),
    meanMs: sorted.length === 0 ? null : Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    over,
    overRate: samplesMs.length === 0 ? 0 : Math.round((over / samplesMs.length) * 100) / 100,
    overBudget: p95 !== null && p95 > budgetMs,
  };
}

/**
 * Latency budget dashboard: record stage samples and whole
 * turns, judge each against its budget, and alert on overruns.
 * One alert per stage per turn for single slow samples; a p95
 * alert fires when a stage's p95 crosses its budget and the
 * stage was previously under it.
 */
export class LatencyBudgetV13 {
  private readonly budgets: LatencyBudgetV13Budgets;
  private readonly maxSamplesPerStage: number;
  private readonly maxTurns: number;
  private readonly sink: LatencyBudgetV13EventSink | null;
  private readonly samples = new Map<LatencyBudgetV13Stage, number[]>();
  private readonly turns = new Map<string, Partial<Record<LatencyBudgetV13Stage, number>>>();
  private readonly turnOrder: string[] = [];
  private readonly turnReports: LatencyBudgetV13TurnReport[] = [];
  private readonly sampleAlertedTurns = new Set<string>();
  private readonly p95Alerted = new Set<LatencyBudgetV13Stage>();
  private alerts = 0;
  private overrunTurns = 0;

  constructor(options: LatencyBudgetV13Options = {}, sink: LatencyBudgetV13EventSink | null = null) {
    const validated = validateLatencyBudgetV13Options(options);
    this.budgets = validated.budgets;
    this.maxSamplesPerStage = validated.maxSamplesPerStage;
    this.maxTurns = validated.maxTurns;
    this.sink = sink;
    for (const stage of LATENCY_BUDGET_V13_STAGES) this.samples.set(stage, []);
  }

  getBudgets(): LatencyBudgetV13Budgets {
    return { ...this.budgets };
  }

  /** Change one stage's budget (ms). Returns the new budget. */
  setBudget(stage: LatencyBudgetV13Stage, ms: number): number {
    if (!LATENCY_BUDGET_V13_STAGES.includes(stage)) {
      throw new Error(`Latency budget v13 unknown stage "${stage}".`);
    }
    if (!Number.isFinite(ms) || ms <= 0 || ms > 600000) {
      throw new Error('Latency budget v13 budget must be a finite number in (0, 600000].');
    }
    this.budgets[stage] = Math.floor(ms);
    return this.budgets[stage];
  }

  /**
   * Record one stage sample. Fires a `sample` alert (once per
   * stage per turn) when the sample is over budget, and a `p95`
   * alert when the stage's p95 crosses its budget.
   */
  recordStage(sample: LatencyBudgetV13Sample): LatencyBudgetV13StageReport {
    if (!LATENCY_BUDGET_V13_STAGES.includes(sample.stage)) {
      throw new Error(`Latency budget v13 unknown stage "${sample.stage}".`);
    }
    if (!Number.isFinite(sample.ms) || sample.ms < 0) {
      throw new Error('Latency budget v13 sample ms must be a finite number >= 0.');
    }
    const list = this.samples.get(sample.stage) as number[];
    list.push(Math.round(sample.ms));
    if (list.length > this.maxSamplesPerStage) list.splice(0, list.length - this.maxSamplesPerStage);
    const turn = this.turns.get(sample.turnId) ?? {};
    turn[sample.stage] = Math.round(sample.ms);
    this.turns.set(sample.turnId, turn);
    if (!this.turnOrder.includes(sample.turnId)) this.turnOrder.push(sample.turnId);

    const budgetMs = this.budgets[sample.stage];
    if (sample.ms > budgetMs) {
      const key = `${sample.turnId}:${sample.stage}`;
      if (!this.sampleAlertedTurns.has(key)) {
        this.sampleAlertedTurns.add(key);
        this.alerts += 1;
        this.sink?.({
          kind: 'alert',
          alert: { turnId: sample.turnId, stage: sample.stage, ms: Math.round(sample.ms), budgetMs, overMs: Math.round(sample.ms - budgetMs), atMs: sample.atMs, kind: 'sample' },
        });
      }
    }
    const report = stageReportV13(sample.stage, list, budgetMs);
    if (report.overBudget && !this.p95Alerted.has(sample.stage)) {
      this.p95Alerted.add(sample.stage);
      this.alerts += 1;
      this.sink?.({
        kind: 'alert',
        alert: { turnId: sample.turnId, stage: sample.stage, ms: report.p95Ms as number, budgetMs, overMs: (report.p95Ms as number) - budgetMs, atMs: sample.atMs, kind: 'p95' },
      });
    } else if (!report.overBudget) {
      // The stage recovered: a future p95 crossing alerts again.
      this.p95Alerted.delete(sample.stage);
    }
    return report;
  }

  /** Record a whole turn at once (stages + optional e2e). Emits a turn report. */
  recordTurn(turnId: string, stages: Partial<Record<LatencyBudgetV13Stage, number>>, atMs: number): LatencyBudgetV13TurnReport {
    for (const [stage, ms] of Object.entries(stages)) {
      this.recordStage({ turnId, stage: stage as LatencyBudgetV13Stage, ms: ms as number, atMs });
    }
    const recorded = this.turns.get(turnId) ?? {};
    const over = (Object.keys(recorded) as LatencyBudgetV13Stage[]).filter(
      (stage) => (recorded[stage] as number) > this.budgets[stage],
    );
    const report: LatencyBudgetV13TurnReport = {
      turnId,
      atMs,
      stages: { ...recorded },
      e2eMs: recorded.e2e ?? null,
      over,
      hasOverrun: over.length > 0,
    };
    if (report.hasOverrun) this.overrunTurns += 1;
    this.turnReports.push(report);
    if (this.turnReports.length > this.maxTurns) this.turnReports.splice(0, this.turnReports.length - this.maxTurns);
    this.sink?.({ kind: 'turn-recorded', report });
    return { ...report, stages: { ...report.stages } };
  }

  /** Per-stage reports for every stage (budget vs reality). */
  getStageReports(): LatencyBudgetV13StageReport[] {
    return LATENCY_BUDGET_V13_STAGES.map((stage) =>
      stageReportV13(stage, this.samples.get(stage) as number[], this.budgets[stage]),
    );
  }

  /** Report for one stage. */
  getStageReport(stage: LatencyBudgetV13Stage): LatencyBudgetV13StageReport {
    if (!LATENCY_BUDGET_V13_STAGES.includes(stage)) {
      throw new Error(`Latency budget v13 unknown stage "${stage}".`);
    }
    return stageReportV13(stage, this.samples.get(stage) as number[], this.budgets[stage]);
  }

  /** Turn reports, oldest first (copies). */
  getTurnReports(): LatencyBudgetV13TurnReport[] {
    return this.turnReports.map((r) => ({ ...r, stages: { ...r.stages }, over: [...r.over] }));
  }

  /** Last turn report, or null when none. */
  getLastTurn(): LatencyBudgetV13TurnReport | null {
    const last = this.turnReports[this.turnReports.length - 1];
    return last ? { ...last, stages: { ...last.stages }, over: [...last.over] } : null;
  }

  getStats(): LatencyBudgetV13Stats {
    const reports = this.getStageReports();
    const measured = reports.filter((r) => r.samples > 0);
    const worst = measured.reduce<LatencyBudgetV13StageReport | null>(
      (acc, r) => (acc === null || r.overRate > acc.overRate ? r : acc),
      null,
    );
    return {
      samples: reports.reduce((a, r) => a + r.samples, 0),
      turns: this.turnReports.length,
      alerts: this.alerts,
      overrunTurns: this.overrunTurns,
      worstStage: worst ? worst.stage : null,
      worstOverRate: worst ? worst.overRate : 0,
    };
  }

  reset(): void {
    for (const stage of LATENCY_BUDGET_V13_STAGES) this.samples.set(stage, []);
    this.turns.clear();
    this.turnOrder.length = 0;
    this.turnReports.length = 0;
    this.sampleAlertedTurns.clear();
    this.p95Alerted.clear();
    this.alerts = 0;
    this.overrunTurns = 0;
  }
}

/** Create a latency budget dashboard (factory). */
export function createLatencyBudgetV13(options: LatencyBudgetV13Options = {}, sink: LatencyBudgetV13EventSink | null = null): LatencyBudgetV13 {
  return new LatencyBudgetV13(options, sink);
}

/** One-line summary of dashboard stats. */
export function latencyBudgetV13Summary(stats: LatencyBudgetV13Stats): string {
  return (
    `Latency budget v13: ${stats.samples} samples, ${stats.turns} turns, ` +
    `${stats.overrunTurns} overrun turns, ${stats.alerts} alerts, ` +
    `worst stage ${stats.worstStage ?? '-'} (over-rate ${stats.worstOverRate})`
  );
}

/** Dashboard as Markdown (for the diagnostics panel). */
export function latencyBudgetV13Markdown(reports: LatencyBudgetV13StageReport[]): string {
  const lines = [
    '## Latency budget v13',
    '',
    '| stage | budget | p50 | p95 | max | over |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of reports) {
    const cell = (v: number | null): string => (v === null ? '-' : `${v} ms`);
    lines.push(
      `| ${r.stage} | ${r.budgetMs} ms | ${cell(r.p50Ms)} | ${cell(r.p95Ms)} | ${cell(r.maxMs)} | ${r.over}/${r.samples}${r.overBudget ? ' ⚠' : ''} |`,
    );
  }
  return lines.join('\n');
}
