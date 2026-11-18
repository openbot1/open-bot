/**
 * Eval Harness v3 — scorer (v1.35, Đội T4).
 *
 * Chấm điểm xác định, không LLM judge:
 * - Điểm trial = tổng weight test đạt kỳ vọng / tổng weight (0..1).
 * - Điểm flake-adjusted: test nào flaky trong trial (chạy lại cho kết
 *   quả khác) thì chỉ tính một nửa weight — điểm không được hưởng lợi
 *   từ may rủi. Trial không có test flaky thì điểm flake-adjusted
 *   bằng điểm thường.
 * - pass@k: xác suất ít nhất 1 trong k trial pass, ước tính từ tỉ lệ
 *   trial pass p theo công thức 1-(1-p)^k (k = số trial đã chạy).
 * - Wilson 95% CI cho trial pass rate toàn suite — báo cáo kèm khoảng
 *   tin cậy để không đọc sai một suite nhỏ (vd 2/3 pass không có
 *   nghĩa là model đạt 67% thật).
 * - Chi phí ước tính theo bảng giá model (USD/1M token); model lạ
 *   dùng giá fallback và ghi rõ `unknown-eval-agent` trong trace.
 */

import type {
  EvalHarnessV3SuiteResult,
  EvalHarnessV3TaskResult,
  EvalHarnessV3TestResult,
  EvalHarnessV3TrialResult,
} from './types.js';

/** Giá fallback khi không biết model (USD / 1M token). */
export const EVAL_HARNESS_V3_FALLBACK_INPUT_USD_PER_1M = 3;
export const EVAL_HARNESS_V3_FALLBACK_OUTPUT_USD_PER_1M = 15;

/** Model mặc định khi executor không báo model. */
export const EVAL_HARNESS_V3_DEFAULT_COST_MODEL = 'unknown-eval-agent';

/** Bảng giá một số model phổ biến (USD/1M token) — cập nhật thủ công, chỉ để ước tính. */
export const EVAL_HARNESS_V3_COST_TABLE: Readonly<Record<string, { input: number; output: number }>> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 0.8, output: 4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'grok-4': { input: 3, output: 15 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
};

/** Ước tính chi phí USD cho một trial từ số token + model. */
export function estimateEvalHarnessV3CostUsd(
  inputTokens: number,
  outputTokens: number,
  model?: string,
): number {
  const pricing =
    model !== undefined ? EVAL_HARNESS_V3_COST_TABLE[model] : undefined;
  const inputRate = pricing?.input ?? EVAL_HARNESS_V3_FALLBACK_INPUT_USD_PER_1M;
  const outputRate = pricing?.output ?? EVAL_HARNESS_V3_FALLBACK_OUTPUT_USD_PER_1M;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}

/** Điểm có trọng số của một trial (0..1). */
export function scoreEvalHarnessV3Trial(tests: EvalHarnessV3TestResult[]): number {
  const total = tests.reduce((sum, t) => sum + t.weight, 0);
  if (total === 0) return 0;
  const got = tests.reduce((sum, t) => sum + (t.expectationMet ? t.weight : 0), 0);
  return got / total;
}

/**
 * Điểm flake-adjusted của một trial: test flaky chỉ tính nửa weight
 * khi đạt (và không trừ khi fail — flaky fail vẫn tính 0 như thường).
 * Mục đích: điểm số không được "ăn may" nhờ test không ổn định.
 */
export function scoreEvalHarnessV3TrialFlakeAdjusted(tests: EvalHarnessV3TestResult[]): number {
  const total = tests.reduce((sum, t) => sum + t.weight, 0);
  if (total === 0) return 0;
  const got = tests.reduce((sum, t) => {
    if (!t.expectationMet) return sum;
    return sum + (t.flaky === true ? t.weight / 2 : t.weight);
  }, 0);
  return got / total;
}

/** Kết quả chấm một trial (điểm thường + điểm flake-adjusted). */
export interface EvalHarnessV3TrialScore {
  score: number;
  flakeAdjustedScore: number;
  passedTests: number;
  totalTests: number;
  flakyTests: number;
}

export function scoreEvalHarnessV3TrialFull(tests: EvalHarnessV3TestResult[]): EvalHarnessV3TrialScore {
  return {
    score: scoreEvalHarnessV3Trial(tests),
    flakeAdjustedScore: scoreEvalHarnessV3TrialFlakeAdjusted(tests),
    passedTests: tests.filter((t) => t.expectationMet).length,
    totalTests: tests.length,
    flakyTests: tests.filter((t) => t.flaky === true).length,
  };
}

/**
 * Ước tính pass@k từ tỉ lệ trial pass p: 1-(1-p)^k.
 * p=0 → 0, p=1 → 1, k<=1 → p. Đây là ước tính (không phải đếm tổ hợp
 * chính xác như pass@k của SWE-bench với n>k) — đủ cho báo cáo nhanh
 * của harness, và được ghi rõ trong render.
 */
export function estimatePassAtK(passRate: number, k: number): number {
  if (k <= 1) return passRate;
  if (passRate <= 0) return 0;
  if (passRate >= 1) return 1;
  return 1 - Math.pow(1 - passRate, k);
}

/** Kết quả chấm một task (gộp N trial). */
export interface EvalHarnessV3TaskScore {
  passRate: number;
  meanScore: number;
  meanFlakeAdjustedScore: number;
  passAtK: number;
  meanDurationMs: number;
  meanCostUsd: number;
  guardrailTrips: number;
}

export function scoreEvalHarnessV3Task(trials: EvalHarnessV3TrialResult[]): EvalHarnessV3TaskScore {
  const n = Math.max(1, trials.length);
  const passedTrials = trials.filter((t) => t.status === 'pass').length;
  const passRate = trials.length === 0 ? 0 : passedTrials / trials.length;
  return {
    passRate,
    meanScore: trials.reduce((s, t) => s + t.score, 0) / n,
    meanFlakeAdjustedScore:
      trials.reduce((s, t) => s + scoreEvalHarnessV3TrialFlakeAdjusted(t.tests), 0) / n,
    passAtK: estimatePassAtK(passRate, trials.length),
    meanDurationMs: trials.reduce((s, t) => s + t.durationMs, 0) / n,
    meanCostUsd: trials.reduce((s, t) => s + t.estimatedCostUsd, 0) / n,
    guardrailTrips: trials.reduce((s, t) => s + (t.guardrailTrips?.length ?? 0), 0),
  };
}

/**
 * Khoảng tin cậy Wilson 95% cho một tỉ lệ (p = successes/n).
 * n=0 → [0, 1] (không có dữ liệu, không kết luận được gì).
 */
export function wilsonCi95V3(
  successes: number,
  trials: number,
): { lower: number; upper: number } {
  if (trials <= 0) return { lower: 0, upper: 1 };
  const z = 1.96;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials);
  const lower = Math.max(0, (centre - margin) / denominator);
  const upper = Math.min(1, (centre + margin) / denominator);
  return { lower, upper };
}

/** Tạo runId ổn định cho một lần chạy suite. */
export function newEvalHarnessV3RunId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `eval-harness-v3-${Date.now().toString(36)}-${random}`;
}

/** Gộp kết quả các task thành SuiteResult (tính CI + flake-adjusted + trip). */
export function aggregateEvalHarnessV3SuiteResults(
  suiteId: string,
  agentLabel: string,
  taskResults: EvalHarnessV3TaskResult[],
  startedAt: number,
  runId?: string,
): EvalHarnessV3SuiteResult {
  const finishedAt = Date.now();
  const allTrials = taskResults.flatMap((t) => t.trials);
  const passedTrials = allTrials.filter((t) => t.status === 'pass').length;
  const tasksAllPass = taskResults.filter(
    (t) => t.trials.length > 0 && t.trials.every((trial) => trial.status === 'pass'),
  ).length;
  const trialPassRate = allTrials.length === 0 ? 0 : passedTrials / allTrials.length;
  return {
    suiteId,
    runId: runId ?? newEvalHarnessV3RunId(),
    agentLabel,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    tasks: taskResults,
    taskPassRate: taskResults.length === 0 ? 0 : tasksAllPass / taskResults.length,
    trialPassRate,
    meanScore:
      taskResults.length === 0
        ? 0
        : taskResults.reduce((s, t) => s + t.meanScore, 0) / taskResults.length,
    meanFlakeAdjustedScore:
      taskResults.length === 0
        ? 0
        : taskResults.reduce((s, t) => s + t.meanFlakeAdjustedScore, 0) / taskResults.length,
    trialPassRateCi95: wilsonCi95V3(passedTrials, allTrials.length),
    totalCostUsd: allTrials.reduce((s, t) => s + t.estimatedCostUsd, 0),
    totalTrialMs: allTrials.reduce((s, t) => s + t.durationMs, 0),
    guardrailTripCount: allTrials.reduce((s, t) => s + (t.guardrailTrips?.length ?? 0), 0),
  };
}

/** So sánh 2 số điểm: chênh lệch tuyệt đối + hướng thay đổi. */
export function scoreDelta(
  current: number,
  baseline: number,
): { delta: number; direction: 'up' | 'down' | 'same' } {
  const delta = current - baseline;
  if (Math.abs(delta) < 1e-9) return { delta, direction: 'same' };
  return { delta, direction: delta > 0 ? 'up' : 'down' };
}

/** Render kết quả suite thành text đọc được (CLI/tool). */
export function renderEvalHarnessV3SuiteText(result: EvalHarnessV3SuiteResult): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [
    `Eval Harness v3 suite ${result.suiteId} (run ${result.runId}, agent ${result.agentLabel})`,
    `  trial pass rate: ${pct(result.trialPassRate)} (95% CI ${pct(result.trialPassRateCi95.lower)}–${pct(result.trialPassRateCi95.upper)})`,
    `  task pass rate: ${pct(result.taskPassRate)} (${result.tasks.length} tasks)`,
    `  mean score: ${pct(result.meanScore)} (flake-adjusted ${pct(result.meanFlakeAdjustedScore)})`,
    `  duration: ${result.durationMs}ms, total trial time ${result.totalTrialMs}ms`,
    `  total cost: $${result.totalCostUsd.toFixed(4)}`,
    `  guardrail trips: ${result.guardrailTripCount}`,
  ];
  for (const task of result.tasks) {
    lines.push(
      `  - ${task.taskId}: pass ${pct(task.passRate)} (pass@${task.trials.length} ${pct(task.passAtK)}), score ${pct(task.meanScore)}, ${task.guardrailTrips} trips`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Render tóm tắt một task thành text (dùng trong report/gate). */
export function renderEvalHarnessV3TaskText(task: EvalHarnessV3TaskResult): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [
    `Task ${task.taskId} (${task.taskName}, ${task.kind}, ${task.difficulty})`,
    `  pass rate ${pct(task.passRate)}, mean score ${pct(task.meanScore)}, flake-adjusted ${pct(task.meanFlakeAdjustedScore)}, pass@${task.trials.length} ${pct(task.passAtK)}`,
    `  mean duration ${Math.round(task.meanDurationMs)}ms, mean steps ${task.meanSteps.toFixed(1)}, mean cost $${task.meanCostUsd.toFixed(4)}, guardrail trips ${task.guardrailTrips}`,
  ];
  for (const trial of task.trials) {
    lines.push(`  - ${trial.trialId}: ${trial.status} score ${pct(trial.score)} (${trial.passedTests}/${trial.totalTests} tests) — ${trial.reason}`);
  }
  return `${lines.join('\n')}\n`;
}
