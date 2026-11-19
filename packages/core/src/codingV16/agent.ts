/**
 * Coding agent v16 — CodingAgentV16: pipeline nối 6 lớp v16.
 *
 * Luồng một task: đặt budget (mặc định 50k token) → chạy minimal
 * harness từ script step (preamble gọn, cửa sổ file 100 dòng,
 * linter gate trước mỗi lần ghi, trim history khi vượt ngưỡng) →
 * ghi cost record (điểm do script quyết — không bịa) → trả report
 * gồm budget status + cost record + số lần trim/lint-block.
 * Không gọi model thật, không gọi mạng, không chạy shell thật ở
 * core — script IS the model (giống v14), fileApplier do caller
 * cấp (tool layer ghi đĩa thật).
 */

import { CodingV16Error } from './types';
import type {
  V16AgentReport,
  V16AgentState,
  V16BudgetStatus,
  V16CostAccuracyReport,
  V16FileWrite,
  V16MinimalConfig,
  V16MinimalStep,
  V16TokenBudget,
} from './types';
import { HarnessCostEstimator } from './harnessCost';
import { runV16Minimal, renderV16MinimalReport } from './minimalHarness';
import { TokenBudgetMeter, V16_DEFAULT_TASK_BUDGET, renderV16BudgetStatus } from './tokenBudget';

/** Input chạy CodingAgentV16. */
export interface V16RunAgentInput {
  runId: string;
  prompt: string;
  /** Script step (model giả lập) — bắt buộc. */
  steps: V16MinimalStep[];
  /** Ngân sách token (mặc định 50k). */
  budget?: V16TokenBudget;
  /** Cấu hình minimal harness. */
  config?: V16MinimalConfig;
  /** Model dùng để tính tiền cost record (mặc định 'claude-sonnet-4'). */
  model?: string;
  /** Điểm task (0..1) do script/caller quyết — mặc định 1 khi done, 0 khi chưa xong. */
  score?: number;
  /** Nội dung file hiện có (path -> content | null). */
  files?: Map<string, string | null>;
  /** Áp fileWrite ra ngoài (mặc định: chỉ cập nhật map files). */
  fileApplier?: (write: V16FileWrite, before: string | null) => string;
  /** Meter/estimator ngoài (mặc định: tạo mới). */
  meter?: TokenBudgetMeter;
  estimator?: HarnessCostEstimator;
}

/** Chạy CodingAgentV16 end-to-end từ script step. */
export function runV16Agent(input: V16RunAgentInput): V16AgentReport {
  if (typeof input.runId !== 'string' || input.runId.trim() === '') {
    throw new CodingV16Error('agent-invalid', 'Agent runId must be a non-empty string.');
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
    throw new CodingV16Error('agent-invalid', 'Agent prompt must be a non-empty string.');
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new CodingV16Error('agent-step-invalid', 'Agent needs at least one scripted step.');
  }
  const meter = input.meter ?? new TokenBudgetMeter();
  const estimator = input.estimator ?? new HarnessCostEstimator();
  const budget: V16TokenBudget = {
    ...V16_DEFAULT_TASK_BUDGET,
    ...(input.budget ?? {}),
    id: input.budget?.id ?? input.runId,
  };
  meter.setBudget(budget);
  const model = input.model ?? 'claude-sonnet-4';

  const { report: minimal, files } = runV16Minimal({
    runId: input.runId,
    prompt: input.prompt,
    steps: input.steps,
    config: input.config,
    files: input.files,
    fileApplier: input.fileApplier,
    meter,
    budgetTokens: budget.limitTokens,
  });
  void files;

  const budgetStatus = meter.status(budget.id, input.runId);
  const score = input.score ?? (minimal.done ? 1 : 0);
  if (typeof score !== 'number' || score < 0 || score > 1) {
    throw new CodingV16Error('agent-invalid', 'Agent score must be within [0, 1].');
  }
  const cost = estimator.record({
    taskId: input.runId,
    harnessId: 'minimal',
    model,
    score,
    promptTokens: minimal.promptTokens,
    completionTokens: minimal.completionTokens,
    steps: minimal.stepsRun,
    note: budgetStatus?.state === 'blocked' ? 'budget-blocked' : undefined,
  });

  const summary =
    `${renderV16MinimalReport(minimal)} ` +
    `${budgetStatus ? renderV16BudgetStatus(budgetStatus) : 'no budget'} ` +
    `Cost: $${cost.costUsd} (${minimal.totalTokens} tokens, score ${score}).`;
  return {
    runId: input.runId,
    prompt: input.prompt,
    stepsRun: minimal.stepsRun,
    done: minimal.done,
    minimal,
    budget: budgetStatus,
    cost,
    trims: [],
    summary,
  };
}

/** Trạng thái resume gọn của một agent report (để nối tiếp run sau). */
export function v16AgentStateFromReport(report: V16AgentReport): V16AgentState {
  return {
    runId: report.runId,
    prompt: report.prompt,
    stepsRun: report.stepsRun,
    done: report.done,
    totalTokens: report.minimal.totalTokens,
    budget: report.budget,
    filesWritten: [...report.minimal.filesWritten],
    lintBlocks: report.minimal.lintBlocks,
    trims: report.minimal.trims,
  };
}

/** Render report agent thành text. */
export function renderV16AgentReport(report: V16AgentReport): string {
  return report.summary;
}

/** Script helper: tạo step "done" rỗng (task đã xong trong 1 step). */
export function v16DoneStep(text: string): V16MinimalStep {
  return { text, done: true };
}

/** Script helper: tạo step bash-only (chạy lệnh, chưa done). */
export function v16BashStep(text: string, bashCommand: string, bashOutput: string): V16MinimalStep {
  return { text, bashCommand, bashOutput, done: false };
}

/** Input chạy tiếp một agent run đã dừng (resume). */
export interface V16ResumeAgentInput extends Omit<V16RunAgentInput, 'prompt'> {
  /** Trạng thái run trước (từ v16AgentStateFromReport). */
  resumeFrom: V16AgentState;
  /** Prompt mới (mặc định: prompt của run trước). */
  prompt?: string;
}

/**
 * Chạy tiếp CodingAgentV16 từ trạng thái đã lưu: meter/estimator
 * ngoài được tái dùng để token + chi phí cộng dồn (không đo lại từ
 * đầu); budget id giữ nguyên runId cũ. Chỉ chạy các step mới.
 */
export function runV16AgentResume(input: V16ResumeAgentInput): V16AgentReport {
  if (!input.resumeFrom || typeof input.resumeFrom.runId !== 'string') {
    throw new CodingV16Error('agent-invalid', 'Resume needs a V16AgentState with a runId.');
  }
  if (input.resumeFrom.done) {
    throw new CodingV16Error('agent-invalid', `Run ${input.resumeFrom.runId} is already done — nothing to resume.`);
  }
  if (!input.meter || !input.estimator) {
    throw new CodingV16Error(
      'agent-invalid',
      'Resume needs the same meter + estimator as the first run (pass them in).',
    );
  }
  const report = runV16Agent({
    ...input,
    runId: input.resumeFrom.runId,
    prompt: input.prompt ?? input.resumeFrom.prompt,
  });
  // Cộng dồn số step/token đã chạy trước vào report (meter đã cộng dồn).
  const priorSteps = input.resumeFrom.stepsRun;
  const priorTokens = input.resumeFrom.totalTokens;
  return {
    ...report,
    stepsRun: priorSteps + report.stepsRun,
    minimal: {
      ...report.minimal,
      stepsRun: priorSteps + report.minimal.stepsRun,
      promptTokens: report.minimal.promptTokens,
      completionTokens: report.minimal.completionTokens,
      totalTokens: priorTokens + report.minimal.totalTokens,
      filesWritten: [...input.resumeFrom.filesWritten, ...report.minimal.filesWritten],
      lintBlocks: input.resumeFrom.lintBlocks + report.minimal.lintBlocks,
      trims: input.resumeFrom.trims + report.minimal.trims,
    },
    summary:
      `Resumed run ${report.runId} (+${report.stepsRun} steps after ${priorSteps} prior, ` +
      `total ${priorTokens + report.minimal.totalTokens} tokens). ${report.summary}`,
  };
}

/** Tuỳ chọn cho CodingAgentV16 (class có trạng thái). */
export interface CodingAgentV16Options {
  /** Ngân sách mặc định cho mọi run (mặc định 50k token). */
  defaultBudget?: V16TokenBudget;
  /** Cấu hình minimal harness mặc định. */
  defaultConfig?: V16MinimalConfig;
  /** Model mặc định để tính tiền (mặc định 'claude-sonnet-4'). */
  defaultModel?: string;
}

/**
 * CodingAgentV16 — class có trạng thái quanh runV16Agent: giữ một
 * meter + một estimator dùng chung cho nhiều run (token + chi phí
 * cộng dồn qua các run), nhớ trạng thái từng run để resume, và cho
 * xem budget/cost bất cứ lúc nào. Tool layer dùng class này thay vì
 * gọi hàm rời rạc.
 */
export class CodingAgentV16 {
  readonly meter = new TokenBudgetMeter();
  readonly estimator = new HarnessCostEstimator();
  private readonly states = new Map<string, V16AgentState>();
  private readonly defaultBudget: V16TokenBudget;
  private readonly defaultConfig?: V16MinimalConfig;
  private readonly defaultModel: string;

  constructor(options: CodingAgentV16Options = {}) {
    this.defaultBudget = options.defaultBudget ?? { ...V16_DEFAULT_TASK_BUDGET };
    this.defaultConfig = options.defaultConfig;
    this.defaultModel = options.defaultModel ?? 'claude-sonnet-4';
  }

  /** Chạy một task mới từ script step. */
  run(input: Omit<V16RunAgentInput, 'meter' | 'estimator'>): V16AgentReport {
    const report = runV16Agent({
      ...input,
      budget: input.budget ?? { ...this.defaultBudget, id: input.runId },
      config: input.config ?? this.defaultConfig,
      model: input.model ?? this.defaultModel,
      meter: this.meter,
      estimator: this.estimator,
    });
    this.states.set(report.runId, v16AgentStateFromReport(report));
    return report;
  }

  /** Chạy tiếp một run chưa xong (cần đúng runId + meter/estimator chung). */
  resume(input: Omit<V16ResumeAgentInput, 'meter' | 'estimator' | 'resumeFrom'> & { runId: string }): V16AgentReport {
    const prior = this.states.get(input.runId);
    if (!prior) {
      throw new CodingV16Error('agent-invalid', `No saved state for run "${input.runId}" — run it first.`);
    }
    const report = runV16AgentResume({
      ...input,
      resumeFrom: prior,
      meter: this.meter,
      estimator: this.estimator,
    });
    this.states.set(report.runId, v16AgentStateFromReport(report));
    return report;
  }

  /** Trạng thái đã lưu của một run (undefined khi chưa chạy). */
  state(runId: string): V16AgentState | undefined {
    return this.states.get(runId);
  }

  /** Mọi runId đã chạy qua class này. */
  runIds(): string[] {
    return [...this.states.keys()];
  }

  /** Trạng thái ngân sách hiện tại của một run (null khi chưa đặt). */
  budgetStatus(runId: string): V16BudgetStatus | null {
    return this.meter.status(runId, runId);
  }

  /** Báo cáo cost/accuracy trên mọi task đã chạy qua class này. */
  costReport(): V16CostAccuracyReport {
    return this.estimator.report();
  }

  /** Xoá trạng thái run (giữ meter + estimator). */
  forgetRun(runId: string): boolean {
    return this.states.delete(runId);
  }

  /** Reset toàn bộ: meter + estimator + trạng thái run. */
  reset(): void {
    this.meter.reset();
    this.estimator.clearRecords();
    this.states.clear();
  }
}
