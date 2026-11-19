/**
 * Cascaded pipeline v29 (v1.42, Team T4).
 *
 * Two ways to turn user speech into agent speech, with a
 * measured latency budget for each (survey §4):
 *
 *   - cascaded STT -> LLM -> TTS, ~500–800 ms end to end.
 *     Each stage has its own budget (STT 250 ms, LLM
 *     350 ms, TTS 200 ms, total 800 ms) and every turn is
 *     measured against it. Stages that blow their budget
 *     are reported, and the pipeline can drop into
 *     degraded mode (fewer / shorter stages) when the
 *     budget is blown repeatedly.
 *   - direct speech-to-speech, ~300 ms total: one stage,
 *     no text in the middle.
 *
 * The pipeline is a mock: the caller injects stage
 * functions (or uses the built-in instant mocks) and the
 * measured durations come from the virtual clock the
 * caller passes in — nothing here records audio, calls a
 * model, or synthesises speech. What is real is the
 * accounting: per-stage samples, p50/p95, over-budget
 * detection, degraded-mode switching, and the report the
 * session and the UI read.
 */

import {
  VOICE_V29_CASCADED_BUDGET_LLM_MS,
  VOICE_V29_CASCADED_BUDGET_STT_MS,
  VOICE_V29_CASCADED_BUDGET_TOTAL_MS,
  VOICE_V29_CASCADED_BUDGET_TTS_MS,
  VOICE_V29_PIPELINE_DEGRADED_THRESHOLD_MS,
  VOICE_V29_S2S_BUDGET_TOTAL_MS,
  meanV29,
  percentileV29,
  round2V29,
  type VoiceV29PipelineMode,
  type VoiceV29PipelineStage,
  type VoiceV29PipelineTurn,
} from './types';

export interface CascadedPipelineV29Options {
  /** Per-stage budgets (ms). Defaults are the survey targets. */
  budgets?: Partial<Record<VoiceV29PipelineStage, number>>;
  /** Consecutive over-budget turns before degraded mode switches on. */
  degradedAfter?: number;
  /** Consecutive within-budget turns before degraded mode switches off. */
  recoverAfter?: number;
  /** Max turns kept in history. */
  maxTurns?: number;
  /** Mock STT: audio description -> transcript. */
  stt?: (input: string, atMs: number) => string | Promise<string>;
  /** Mock LLM: transcript -> reply text. */
  llm?: (transcript: string, atMs: number) => string | Promise<string>;
  /** Mock TTS: reply text -> spoken description. */
  tts?: (reply: string, atMs: number) => string | Promise<string>;
  /** Mock speech-to-speech: audio description -> spoken reply. */
  s2s?: (input: string, atMs: number) => string | Promise<string>;
}

export interface VoiceV29PipelineStats {
  turns: number;
  cascadedTurns: number;
  s2sTurns: number;
  withinBudget: number;
  withinBudgetPct: number;
  overBudgetTurns: number;
  degraded: boolean;
  consecutiveOverBudget: number;
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
  stageP50Ms: Partial<Record<VoiceV29PipelineStage, number>>;
  stageOverBudget: Partial<Record<VoiceV29PipelineStage, number>>;
}

export interface VoiceV29PipelineReport {
  stats: VoiceV29PipelineStats;
  budgets: Record<VoiceV29PipelineStage, number>;
  totalBudgetMs: number;
  recentTurns: VoiceV29PipelineTurn[];
}

export function defaultCascadedPipelineV29Options(): CascadedPipelineV29Options {
  return {
    budgets: {
      stt: VOICE_V29_CASCADED_BUDGET_STT_MS,
      llm: VOICE_V29_CASCADED_BUDGET_LLM_MS,
      tts: VOICE_V29_CASCADED_BUDGET_TTS_MS,
      's2s-direct': VOICE_V29_S2S_BUDGET_TOTAL_MS,
    },
    degradedAfter: 3,
    recoverAfter: 5,
    maxTurns: 500,
  };
}

let pipelineTurnCounter = 0;

/** Stage durations the caller measured (virtual clock, ms). */
export type VoiceV29MeasuredStages = Partial<Record<VoiceV29PipelineStage, number>>;

export class CascadedPipelineV29 {
  private readonly budgets: Record<VoiceV29PipelineStage, number>;
  private readonly degradedAfter: number;
  private readonly recoverAfter: number;
  private readonly maxTurns: number;
  private readonly sttFn: NonNullable<CascadedPipelineV29Options['stt']>;
  private readonly llmFn: NonNullable<CascadedPipelineV29Options['llm']>;
  private readonly ttsFn: NonNullable<CascadedPipelineV29Options['tts']>;
  private readonly s2sFn: NonNullable<CascadedPipelineV29Options['s2s']>;

  private readonly turns: VoiceV29PipelineTurn[] = [];
  private degraded = false;
  private consecutiveOverBudget = 0;
  private consecutiveWithinBudget = 0;

  constructor(opts: CascadedPipelineV29Options = {}) {
    const defaults = defaultCascadedPipelineV29Options();
    this.budgets = {
      stt: opts.budgets?.stt ?? defaults.budgets?.stt ?? VOICE_V29_CASCADED_BUDGET_STT_MS,
      llm: opts.budgets?.llm ?? defaults.budgets?.llm ?? VOICE_V29_CASCADED_BUDGET_LLM_MS,
      tts: opts.budgets?.tts ?? defaults.budgets?.tts ?? VOICE_V29_CASCADED_BUDGET_TTS_MS,
      's2s-direct': opts.budgets?.['s2s-direct'] ?? defaults.budgets?.['s2s-direct'] ?? VOICE_V29_S2S_BUDGET_TOTAL_MS,
    };
    this.degradedAfter = opts.degradedAfter ?? 3;
    this.recoverAfter = opts.recoverAfter ?? 5;
    this.maxTurns = opts.maxTurns ?? 500;
    this.sttFn = opts.stt ?? ((input: string) => `transcript of (${input.slice(0, 60)})`);
    this.llmFn = opts.llm ?? ((transcript: string) => `Reply to: ${transcript}`);
    this.ttsFn = opts.tts ?? ((reply: string) => `spoken: ${reply}`);
    this.s2sFn = opts.s2s ?? ((input: string) => `spoken reply to (${input.slice(0, 60)})`);
  }

  getBudgets(): Record<VoiceV29PipelineStage, number> {
    return { ...this.budgets };
  }

  setBudget(stage: VoiceV29PipelineStage, budgetMs: number): void {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Budget must be a positive number of ms');
    this.budgets[stage] = budgetMs;
  }

  /** Total budget for a mode (cascaded = stt+llm+tts, s2s = s2s-direct). */
  totalBudgetMs(mode: VoiceV29PipelineMode): number {
    if (mode === 'speech-to-speech') return this.budgets['s2s-direct'];
    return this.budgets.stt + this.budgets.llm + this.budgets.tts;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Record a turn with caller-measured stage durations.
   * The caller measured the stages (virtual clock); this
   * method only judges them against the budget and tracks
   * degraded mode. Use `runCascaded` / `runSpeechToSpeech`
   * to run the mock stages and measure automatically.
   */
  recordTurn(
    mode: VoiceV29PipelineMode,
    stageMs: VoiceV29MeasuredStages,
    startedAtMs: number,
    endedAtMs: number,
    inputText: string,
    outputText: string,
  ): VoiceV29PipelineTurn {
    pipelineTurnCounter += 1;
    const totalMs = Math.max(0, endedAtMs - startedAtMs);
    const overBudgetStages: VoiceV29PipelineStage[] = [];
    for (const stage of Object.keys(stageMs) as VoiceV29PipelineStage[]) {
      const measured = stageMs[stage];
      if (measured !== undefined && measured > this.budgets[stage]) overBudgetStages.push(stage);
    }
    const withinBudget = totalMs <= this.totalBudgetMs(mode) && overBudgetStages.length === 0;
    const turn: VoiceV29PipelineTurn = {
      id: `pipe-${pipelineTurnCounter}`,
      mode,
      startedAtMs,
      endedAtMs,
      stageMs: { ...stageMs },
      totalMs,
      withinBudget,
      overBudgetStages,
      degraded: this.degraded,
      inputText,
      outputText,
    };
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) this.turns.splice(0, this.turns.length - this.maxTurns);
    if (withinBudget) {
      this.consecutiveOverBudget = 0;
      this.consecutiveWithinBudget += 1;
      if (this.degraded && this.consecutiveWithinBudget >= this.recoverAfter) {
        this.degraded = false;
        this.consecutiveWithinBudget = 0;
      }
    } else {
      this.consecutiveWithinBudget = 0;
      this.consecutiveOverBudget += 1;
      if (!this.degraded && this.consecutiveOverBudget >= this.degradedAfter) {
        this.degraded = true;
        this.consecutiveOverBudget = 0;
      }
    }
    return { ...turn, stageMs: { ...turn.stageMs } };
  }

  /**
   * Run one cascaded turn through the mock stages. Stage
   * durations are measured on the virtual clock: the caller
   * advances `atMs` between stages (or the stage functions
   * report their own duration via the returned object).
   * In degraded mode the LLM stage is shortened (the mock
   * LLM returns a short reply) — the budget still applies.
   */
  async runCascaded(input: string, atMs: number, stageDurations: VoiceV29MeasuredStages = {}): Promise<VoiceV29PipelineTurn> {
    const sttMs = stageDurations.stt ?? 120;
    const llmMs = stageDurations.llm ?? (this.degraded ? 150 : 280);
    const ttsMs = stageDurations.tts ?? 140;
    const transcript = await this.sttFn(input, atMs + sttMs);
    const reply = await this.llmFn(this.degraded ? transcript.slice(0, 40) : transcript, atMs + sttMs + llmMs);
    const spoken = await this.ttsFn(reply, atMs + sttMs + llmMs + ttsMs);
    const total = sttMs + llmMs + ttsMs;
    return this.recordTurn(
      'cascaded',
      { stt: sttMs, llm: llmMs, tts: ttsMs },
      atMs,
      atMs + total,
      input,
      spoken,
    );
  }

  /** Run one direct speech-to-speech turn through the mock stage. */
  async runSpeechToSpeech(input: string, atMs: number, stageDurationMs = 180): Promise<VoiceV29PipelineTurn> {
    const spoken = await this.s2sFn(input, atMs + stageDurationMs);
    return this.recordTurn(
      'speech-to-speech',
      { 's2s-direct': stageDurationMs },
      atMs,
      atMs + stageDurationMs,
      input,
      spoken,
    );
  }

  recentTurns(limit = 20): VoiceV29PipelineTurn[] {
    return this.turns.slice(-limit).map((t) => ({ ...t, stageMs: { ...t.stageMs } }));
  }

  stats(): VoiceV29PipelineStats {
    const totals = this.turns.map((t) => t.totalMs);
    const within = this.turns.filter((t) => t.withinBudget).length;
    const stageP50Ms: Partial<Record<VoiceV29PipelineStage, number>> = {};
    const stageOverBudget: Partial<Record<VoiceV29PipelineStage, number>> = {};
    for (const stage of ['stt', 'llm', 'tts', 's2s-direct'] as const) {
      const samples = this.turns
        .map((t) => t.stageMs[stage])
        .filter((v): v is number => v !== undefined);
      if (samples.length > 0) stageP50Ms[stage] = Math.round(percentileV29(samples, 50));
      const over = this.turns.filter((t) => t.overBudgetStages.includes(stage)).length;
      if (over > 0) stageOverBudget[stage] = over;
    }
    return {
      turns: this.turns.length,
      cascadedTurns: this.turns.filter((t) => t.mode === 'cascaded').length,
      s2sTurns: this.turns.filter((t) => t.mode === 'speech-to-speech').length,
      withinBudget: within,
      withinBudgetPct: this.turns.length === 0 ? 100 : round2V29((within / this.turns.length) * 100),
      overBudgetTurns: this.turns.length - within,
      degraded: this.degraded,
      consecutiveOverBudget: this.consecutiveOverBudget,
      p50Ms: Math.round(percentileV29(totals, 50)),
      p95Ms: Math.round(percentileV29(totals, 95)),
      avgMs: Math.round(meanV29(totals)),
      stageP50Ms,
      stageOverBudget,
    };
  }

  report(): VoiceV29PipelineReport {
    return {
      stats: this.stats(),
      budgets: this.getBudgets(),
      totalBudgetMs: VOICE_V29_CASCADED_BUDGET_TOTAL_MS,
      recentTurns: this.recentTurns(10),
    };
  }

  /** Reset history and degraded mode (budgets are kept). */
  reset(): void {
    this.turns.length = 0;
    this.degraded = false;
    this.consecutiveOverBudget = 0;
    this.consecutiveWithinBudget = 0;
  }
}

export function createCascadedPipelineV29(opts: CascadedPipelineV29Options = {}): CascadedPipelineV29 {
  return new CascadedPipelineV29(opts);
}
