/**
 * Pipeline v3 with per-stage latency budgets (v1.16, Đội T5 — voice v15).
 *
 * The research budget for a natural conversation (Stivers et al. PNAS
 * 2009: inter-turn gap 200–300 ms; >500 ms feels like lag; >1000 ms the
 * turn feels broken) is split across the pipeline stages the way
 * production voice stacks split it in 2026:
 *
 *   VAD 50–150 ms · STT 100–300 ms · LLM TTFT 300–800 ms ·
 *   TTS TTFA 75–200 ms · network ~100 ms · orchestrator 20–50 ms
 *
 * The *stage* budgets above are generous ceilings for each stage in
 * isolation; the *end-to-end* budget that matters to the user is
 * 500 ms (speech-end → first agent audio). A turn can pass every stage
 * budget and still breach e2e, so both are tracked and both alert.
 *
 * This module is pure measurement + policy, no audio device:
 *
 *   - `LatencyPipelineV15` records stage samples per turn, keeps
 *     per-stage p50/p95/p99, compliance rates and a rolling e2e p95;
 *   - alerts: `warn` when a stage exceeds its budget, `critical`
 *     when it exceeds 2× (or e2e exceeds 1000 ms — the "broken"
 *     threshold);
 *   - auto-degradation: when e2e p95 stays over the degrade threshold
 *     for N consecutive turns, the quality ladder steps down
 *     (`full` → `reduced` → `minimal` — e.g. switch TTS to the faster
 *     voice, drop the slow STT model, shorten the LLM context); when
 *     p95 recovers under the recover threshold for N turns it steps
 *     back up. Every step is an event, so the UI can say why the
 *     voice suddenly sounds plainer;
 *   - a per-session report (`sessionReport`) and markdown for the
 *     settings panel: worst stage, compliance rate, alert counts,
 *     current quality level.
 *
 * Determinism: every sample carries the caller's virtual ms; the
 * pipeline never reads a wall clock.
 */

export type PipelineStageV15 = 'vad' | 'stt' | 'llm' | 'tts' | 'network' | 'orchestrator';
export const PIPELINE_V15_STAGES: readonly PipelineStageV15[] = [
  'vad',
  'stt',
  'llm',
  'tts',
  'network',
  'orchestrator',
];

export type PipelineQualityV15 = 'full' | 'reduced' | 'minimal';
export const PIPELINE_V15_QUALITIES: readonly PipelineQualityV15[] = ['full', 'reduced', 'minimal'];

export type PipelineAlertLevelV15 = 'warn' | 'critical';

export interface PipelineBudgetsV15 {
  vadMs: number;
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  networkMs: number;
  orchestratorMs: number;
  /** Speech-end → first agent audio. */
  endToEndMs: number;
  /** e2e at/above this is "the turn feels broken". */
  brokenMs: number;
}

export function defaultPipelineBudgetsV15(): PipelineBudgetsV15 {
  return {
    vadMs: 150,
    sttMs: 300,
    llmMs: 800,
    ttsMs: 200,
    networkMs: 100,
    orchestratorMs: 50,
    endToEndMs: 500,
    brokenMs: 1000,
  };
}

export function validatePipelineBudgetsV15(budgets: PipelineBudgetsV15): string[] {
  const errors: string[] = [];
  const entries: [string, number][] = [
    ['vadMs', budgets.vadMs],
    ['sttMs', budgets.sttMs],
    ['llmMs', budgets.llmMs],
    ['ttsMs', budgets.ttsMs],
    ['networkMs', budgets.networkMs],
    ['orchestratorMs', budgets.orchestratorMs],
    ['endToEndMs', budgets.endToEndMs],
    ['brokenMs', budgets.brokenMs],
  ];
  for (const [name, value] of entries) {
    if (!Number.isFinite(value) || value <= 0) errors.push(`${name} must be a positive number`);
  }
  if (budgets.brokenMs <= budgets.endToEndMs) errors.push('brokenMs must be greater than endToEndMs');
  return errors;
}

export interface PipelineStageSampleV15 {
  turnId: string;
  stage: PipelineStageV15;
  ms: number;
  atMs: number;
}

export interface PipelineTurnSampleV15 {
  turnId: string;
  endToEndMs: number;
  atMs: number;
  stages: Partial<Record<PipelineStageV15, number>>;
}

export interface PipelineAlertV15 {
  level: PipelineAlertLevelV15;
  turnId: string;
  stage: PipelineStageV15 | 'end-to-end';
  ms: number;
  budgetMs: number;
  atMs: number;
  message: string;
}

export interface PipelineStageStatsV15 {
  stage: PipelineStageV15;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  budgetMs: number;
  overBudget: number;
  complianceRate: number;
}

export interface PipelineSessionReportV15 {
  turns: number;
  endToEndP50Ms: number;
  endToEndP95Ms: number;
  endToEndP99Ms: number;
  endToEndComplianceRate: number;
  stages: PipelineStageStatsV15[];
  worstStage: PipelineStageV15 | undefined;
  alerts: number;
  criticalAlerts: number;
  quality: PipelineQualityV15;
  degradations: number;
  recoveries: number;
}

export interface PipelineQualityStepV15 {
  from: PipelineQualityV15;
  to: PipelineQualityV15;
  turnId: string;
  atMs: number;
  endToEndP95Ms: number;
  reason: string;
}

export interface LatencyPipelineOptionsV15 {
  budgets?: Partial<PipelineBudgetsV15>;
  /** Consecutive over-threshold turns before stepping quality down. */
  degradeAfterTurns?: number;
  /** Consecutive under-threshold turns before stepping quality back up. */
  recoverAfterTurns?: number;
  /** p95 e2e above this degrades (default: the e2e budget). */
  degradeThresholdMs?: number;
  /** p95 e2e below this recovers (default: 80% of the e2e budget). */
  recoverThresholdMs?: number;
  /** Rolling window of turns used for p95 (default 20). */
  windowTurns?: number;
}

export interface LatencyPipelineDefaultsV15 {
  budgets: PipelineBudgetsV15;
  degradeAfterTurns: number;
  recoverAfterTurns: number;
  degradeThresholdMs: number;
  recoverThresholdMs: number;
  windowTurns: number;
}

export function defaultLatencyPipelineOptionsV15(): LatencyPipelineDefaultsV15 {
  return {
    budgets: defaultPipelineBudgetsV15(),
    degradeAfterTurns: 3,
    recoverAfterTurns: 5,
    degradeThresholdMs: 500,
    recoverThresholdMs: 400,
    windowTurns: 20,
  };
}

export function percentileV15(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index];
}

const QUALITY_ORDER: PipelineQualityV15[] = ['full', 'reduced', 'minimal'];

export function pipelineQualityStepDownV15(quality: PipelineQualityV15): PipelineQualityV15 {
  const idx = QUALITY_ORDER.indexOf(quality);
  return QUALITY_ORDER[Math.min(QUALITY_ORDER.length - 1, idx + 1)];
}

export function pipelineQualityStepUpV15(quality: PipelineQualityV15): PipelineQualityV15 {
  const idx = QUALITY_ORDER.indexOf(quality);
  return QUALITY_ORDER[Math.max(0, idx - 1)];
}

/** What each quality level means for the downstream stages. */
export function pipelineQualityPolicyV15(quality: PipelineQualityV15): {
  ttsVoice: 'high' | 'fast' | 'minimal';
  sttModel: 'accurate' | 'fast' | 'fast';
  llmMaxTokens: number;
  description: string;
} {
  switch (quality) {
    case 'full':
      return { ttsVoice: 'high', sttModel: 'accurate', llmMaxTokens: 1024, description: 'Full quality: accurate STT, high-quality TTS, full LLM reply.' };
    case 'reduced':
      return { ttsVoice: 'fast', sttModel: 'fast', llmMaxTokens: 512, description: 'Reduced: fast STT, fast TTS voice, shorter LLM reply.' };
    case 'minimal':
      return { ttsVoice: 'minimal', sttModel: 'fast', llmMaxTokens: 256, description: 'Minimal: fastest TTS, fast STT, short LLM reply — latency first.' };
  }
}

export type PipelineEventSinkV15 = (event: { kind: 'alert' | 'quality'; atMs: number; alert?: PipelineAlertV15; step?: PipelineQualityStepV15 }) => void;

export class LatencyPipelineV15 {
  readonly budgets: PipelineBudgetsV15;
  private readonly options: LatencyPipelineDefaultsV15;
  private readonly sink: PipelineEventSinkV15 | undefined;
  private readonly stageSamples = new Map<PipelineStageV15, number[]>();
  private readonly turnSamples: PipelineTurnSampleV15[] = [];
  private readonly alerts: PipelineAlertV15[] = [];
  private readonly qualitySteps: PipelineQualityStepV15[] = [];
  private quality: PipelineQualityV15 = 'full';
  private overStreak = 0;
  private underStreak = 0;
  private degradations = 0;
  private recoveries = 0;

  constructor(options: LatencyPipelineOptionsV15 = {}, sink?: PipelineEventSinkV15) {
    const defaults = defaultLatencyPipelineOptionsV15();
    this.options = {
      ...defaults,
      ...options,
      budgets: { ...defaults.budgets, ...(options.budgets ?? {}) },
    };
    const errors = validatePipelineBudgetsV15(this.options.budgets);
    if (errors.length > 0) throw new Error(`invalid pipeline budgets: ${errors.join('; ')}`);
    if (this.options.degradeAfterTurns < 1 || this.options.recoverAfterTurns < 1) {
      throw new Error('degradeAfterTurns and recoverAfterTurns must be >= 1');
    }
    this.budgets = this.options.budgets;
    this.sink = sink;
    for (const stage of PIPELINE_V15_STAGES) this.stageSamples.set(stage, []);
  }

  getQuality(): PipelineQualityV15 {
    return this.quality;
  }

  /** Record one stage of one turn; alerts immediately when over budget. */
  recordStage(turnId: string, stage: PipelineStageV15, ms: number, atMs: number): PipelineAlertV15 | undefined {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`stage ms must be >= 0, got ${ms}`);
    this.stageSamples.get(stage)?.push(ms);
    const budget = this.stageBudget(stage);
    if (ms <= budget) return undefined;
    const level: PipelineAlertLevelV15 = ms >= 2 * budget ? 'critical' : 'warn';
    const alert: PipelineAlertV15 = {
      level,
      turnId,
      stage,
      ms,
      budgetMs: budget,
      atMs,
      message: `${stage} took ${ms} ms (budget ${budget} ms)`,
    };
    this.alerts.push(alert);
    this.sink?.({ kind: 'alert', atMs, alert });
    return alert;
  }

  /** Record a finished turn (e2e = speech-end → first agent audio). */
  recordTurn(turn: PipelineTurnSampleV15): PipelineAlertV15 | undefined {
    this.turnSamples.push(turn);
    const window = this.turnSamples.slice(-this.options.windowTurns);
    for (const [stage, ms] of Object.entries(turn.stages) as [PipelineStageV15, number][]) {
      if (ms !== undefined) this.recordStage(turn.turnId, stage, ms, turn.atMs);
    }
    let alert: PipelineAlertV15 | undefined;
    if (turn.endToEndMs > this.budgets.endToEndMs) {
      const level: PipelineAlertLevelV15 = turn.endToEndMs >= this.budgets.brokenMs ? 'critical' : 'warn';
      alert = {
        level,
        turnId: turn.turnId,
        stage: 'end-to-end',
        ms: turn.endToEndMs,
        budgetMs: this.budgets.endToEndMs,
        atMs: turn.atMs,
        message: `end-to-end took ${turn.endToEndMs} ms (budget ${this.budgets.endToEndMs} ms)`,
      };
      this.alerts.push(alert);
      this.sink?.({ kind: 'alert', atMs: turn.atMs, alert });
    }
    const p95 = percentileV15(window.map((t) => t.endToEndMs), 95);
    this.updateQuality(turn.turnId, turn.atMs, p95);
    return alert;
  }

  stageStats(stage: PipelineStageV15): PipelineStageStatsV15 {
    const values = this.stageSamples.get(stage) ?? [];
    const budget = this.stageBudget(stage);
    const over = values.filter((v) => v > budget).length;
    return {
      stage,
      samples: values.length,
      p50Ms: percentileV15(values, 50),
      p95Ms: percentileV15(values, 95),
      p99Ms: percentileV15(values, 99),
      maxMs: values.length > 0 ? Math.max(...values) : 0,
      budgetMs: budget,
      overBudget: over,
      complianceRate: values.length > 0 ? (values.length - over) / values.length : 1,
    };
  }

  endToEndP95Ms(): number {
    const window = this.turnSamples.slice(-this.options.windowTurns);
    return percentileV15(window.map((t) => t.endToEndMs), 95);
  }

  alertsList(): PipelineAlertV15[] {
    return [...this.alerts];
  }

  qualityStepsList(): PipelineQualityStepV15[] {
    return [...this.qualitySteps];
  }

  sessionReport(): PipelineSessionReportV15 {
    const e2e = this.turnSamples.map((t) => t.endToEndMs);
    const stages = PIPELINE_V15_STAGES.map((s) => this.stageStats(s));
    const worst = stages.filter((s) => s.samples > 0).sort((a, b) => b.p95Ms - a.p95Ms)[0];
    const compliant = e2e.filter((v) => v <= this.budgets.endToEndMs).length;
    return {
      turns: this.turnSamples.length,
      endToEndP50Ms: percentileV15(e2e, 50),
      endToEndP95Ms: percentileV15(e2e, 95),
      endToEndP99Ms: percentileV15(e2e, 99),
      endToEndComplianceRate: e2e.length > 0 ? compliant / e2e.length : 1,
      stages,
      worstStage: worst?.stage,
      alerts: this.alerts.length,
      criticalAlerts: this.alerts.filter((a) => a.level === 'critical').length,
      quality: this.quality,
      degradations: this.degradations,
      recoveries: this.recoveries,
    };
  }

  summary(): string {
    const r = this.sessionReport();
    return `pipeline v15: ${r.turns} turns, e2e p50=${r.endToEndP50Ms}ms p95=${r.endToEndP95Ms}ms ` +
      `compliance=${Math.round(r.endToEndComplianceRate * 100)}% alerts=${r.alerts} (${r.criticalAlerts} critical) ` +
      `quality=${r.quality} worst=${r.worstStage ?? 'n/a'}`;
  }

  markdown(): string {
    const r = this.sessionReport();
    const lines = [
      '## Latency pipeline v15',
      '',
      `- Turns: ${r.turns}; e2e p50 ${r.endToEndP50Ms} ms, p95 ${r.endToEndP95Ms} ms, p99 ${r.endToEndP99Ms} ms`,
      `- e2e budget ${this.budgets.endToEndMs} ms — compliance ${Math.round(r.endToEndComplianceRate * 100)}%`,
      `- Quality: \`${r.quality}\` (${pipelineQualityPolicyV15(r.quality).description}) — degradations ${r.degradations}, recoveries ${r.recoveries}`,
      `- Alerts: ${r.alerts} (${r.criticalAlerts} critical); worst stage: ${r.worstStage ?? 'n/a'}`,
      '',
      '| Stage | Budget | p50 | p95 | p99 | Max | Over |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ];
    for (const s of r.stages) {
      lines.push(`| ${s.stage} | ${s.budgetMs} | ${s.p50Ms} | ${s.p95Ms} | ${s.p99Ms} | ${s.maxMs} | ${s.overBudget} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private stageBudget(stage: PipelineStageV15): number {
    switch (stage) {
      case 'vad': return this.budgets.vadMs;
      case 'stt': return this.budgets.sttMs;
      case 'llm': return this.budgets.llmMs;
      case 'tts': return this.budgets.ttsMs;
      case 'network': return this.budgets.networkMs;
      case 'orchestrator': return this.budgets.orchestratorMs;
    }
  }

  private updateQuality(turnId: string, atMs: number, p95: number): void {
    if (p95 > this.options.degradeThresholdMs) {
      this.overStreak += 1;
      this.underStreak = 0;
      if (this.overStreak >= this.options.degradeAfterTurns && this.quality !== 'minimal') {
        const from = this.quality;
        this.quality = pipelineQualityStepDownV15(this.quality);
        this.overStreak = 0;
        this.degradations += 1;
        const step: PipelineQualityStepV15 = {
          from,
          to: this.quality,
          turnId,
          atMs,
          endToEndP95Ms: p95,
          reason: `e2e p95 ${p95} ms > degrade threshold ${this.options.degradeThresholdMs} ms for ${this.options.degradeAfterTurns} turns`,
        };
        this.qualitySteps.push(step);
        this.sink?.({ kind: 'quality', atMs, step });
      }
      return;
    }
    if (p95 < this.options.recoverThresholdMs) {
      this.underStreak += 1;
      this.overStreak = 0;
      if (this.underStreak >= this.options.recoverAfterTurns && this.quality !== 'full') {
        const from = this.quality;
        this.quality = pipelineQualityStepUpV15(this.quality);
        this.underStreak = 0;
        this.recoveries += 1;
        const step: PipelineQualityStepV15 = {
          from,
          to: this.quality,
          turnId,
          atMs,
          endToEndP95Ms: p95,
          reason: `e2e p95 ${p95} ms < recover threshold ${this.options.recoverThresholdMs} ms for ${this.options.recoverAfterTurns} turns`,
        };
        this.qualitySteps.push(step);
        this.sink?.({ kind: 'quality', atMs, step });
      }
      return;
    }
    this.overStreak = 0;
    this.underStreak = 0;
  }
}

export function createLatencyPipelineV15(
  options: LatencyPipelineOptionsV15 = {},
  sink?: PipelineEventSinkV15,
): LatencyPipelineV15 {
  return new LatencyPipelineV15(options, sink);
}

export function latencyPipelineV15Summary(pipeline: LatencyPipelineV15): string {
  return pipeline.summary();
}

export function latencyPipelineV15Markdown(pipeline: LatencyPipelineV15): string {
  return pipeline.markdown();
}
