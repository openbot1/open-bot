/**
 * Eval Harness v2 — scorer 4 chiều + nối trace OTel + aggregation (v1.34, Đội T4).
 *
 * Scorer KHÔNG tự chế hệ trace mới: mỗi trial được ghi thành một
 * `Trace` bằng `Tracer` sẵn có của repo (tracing/tracer.ts) rồi convert
 * sang OTel bằng `traceToOtel` (observability/otel.ts). Chi phí ước
 * tính dùng bảng giá sẵn có (`estimateCostDetailed` trong
 * observability/cost.ts); model không rõ thì dùng giá fallback ghi rõ
 * trong code (không giả vờ là giá thật của model đó).
 *
 * 4 chiều chấm mỗi trial:
 * 1. Đúng/sai — điểm có trọng số 0..1 (tổng weight test đạt / tổng
 *    weight) + status pass/fail/timeout/cancelled/error.
 * 2. Thời gian — durationMs của trial.
 * 3. Số bước/tool call — steps executor báo cáo.
 * 4. Chi phí token ước tính — input/output tokens × giá model (USD).
 *
 * Aggregation theo từng suite: pass rate + khoảng tin cậy Wilson 95%
 * (chuẩn cho tỉ lệ pass trên số trial nhỏ — tốt hơn ±1.96·SE khi n
 * nhỏ), điểm trung bình, thời gian/bước/chi phí trung bình. Không có
 * LLM judge ở bất kỳ đâu: điểm chỉ từ test xác định.
 */

import { estimateCostDetailed, isKnownModel } from '../observability/cost.js';
import { estimateTraceCost, traceToOtel, type OtelResourceSpan } from '../observability/otel.js';
import { Tracer, type Trace } from '../tracing/tracer.js';
import type {
  EvalHarnessV2SuiteResult,
  EvalHarnessV2Task,
  EvalHarnessV2TaskResult,
  EvalHarnessV2TrialResult,
} from './types.js';

/** Giá fallback khi model không có trong bảng giá của repo (USD / 1M token). */
export const EVAL_HARNESS_V2_FALLBACK_INPUT_USD_PER_1M = 3;
export const EVAL_HARNESS_V2_FALLBACK_OUTPUT_USD_PER_1M = 15;

/** Model mặc định dùng khi executor không báo model (chỉ để ước tính chi phí). */
export const EVAL_HARNESS_V2_DEFAULT_COST_MODEL = 'unknown-eval-agent';

/**
 * Ước tính chi phí USD của một trial từ token. Model có trong bảng giá
 * của repo → dùng giá thật; model lạ/không rõ → giá fallback (ghi rõ
 * là ước tính, không phải giá thật của model đó).
 */
export function estimateEvalCostUsd(
  inputTokens: number,
  outputTokens: number,
  model?: string,
): number {
  const safeIn = Math.max(0, Math.floor(inputTokens) || 0);
  const safeOut = Math.max(0, Math.floor(outputTokens) || 0);
  if (safeIn === 0 && safeOut === 0) return 0;
  if (model !== undefined && model !== '' && isKnownModel(model)) {
    // costUsd null khi bảng giá không có model này → rơi xuống giá fallback bên dưới.
    const known = estimateCostDetailed(model, safeIn, safeOut).costUsd;
    if (known !== null) return known;
  }
  return (
    (safeIn * EVAL_HARNESS_V2_FALLBACK_INPUT_USD_PER_1M) / 1_000_000 +
    (safeOut * EVAL_HARNESS_V2_FALLBACK_OUTPUT_USD_PER_1M) / 1_000_000
  );
}

/** Điểm 4 chiều của một trial (đọc từ TrialResult, không chấm lại test). */
export interface EvalHarnessV2TrialScore {
  trialId: string;
  taskId: string;
  /** Chiều 1: đúng/sai — điểm có trọng số 0..1. */
  correctness: number;
  passed: boolean;
  status: EvalHarnessV2TrialResult['status'];
  /** Chiều 2: thời gian (ms). */
  durationMs: number;
  /** Chiều 3: số bước/tool call. */
  steps: number;
  /** Chiều 4: chi phí token ước tính (USD). */
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export function scoreEvalHarnessV2Trial(
  trial: EvalHarnessV2TrialResult,
): EvalHarnessV2TrialScore {
  return {
    trialId: trial.trialId,
    taskId: trial.taskId,
    correctness: trial.score,
    passed: trial.status === 'pass',
    status: trial.status,
    durationMs: trial.durationMs,
    steps: trial.steps,
    estimatedCostUsd: trial.estimatedCostUsd,
    inputTokens: trial.inputTokens,
    outputTokens: trial.outputTokens,
  };
}

/** Điểm 4 chiều gộp của một task (trung bình các trial + pass rate). */
export interface EvalHarnessV2TaskScore {
  taskId: string;
  passRate: number;
  meanCorrectness: number;
  meanDurationMs: number;
  meanSteps: number;
  meanCostUsd: number;
  trials: number;
}

export function scoreEvalHarnessV2Task(
  taskResult: EvalHarnessV2TaskResult,
): EvalHarnessV2TaskScore {
  return {
    taskId: taskResult.taskId,
    passRate: taskResult.passRate,
    meanCorrectness: taskResult.meanScore,
    meanDurationMs: taskResult.meanDurationMs,
    meanSteps: taskResult.meanSteps,
    meanCostUsd: taskResult.meanCostUsd,
    trials: taskResult.trials.length,
  };
}

/**
 * Ghi một trial thành Trace bằng Tracer sẵn có của repo, rồi trả về
 * Trace (caller convert sang OTel bằng trialTraceToOtel khi cần xuất).
 * Span gốc: trial; span con: một span 'tool' mỗi test + một span 'llm'
 * mang token/model để estimateTraceCost tính được chi phí.
 */
export function buildEvalTrialTrace(
  trial: EvalHarnessV2TrialResult,
  task: EvalHarnessV2Task,
  model?: string,
): Trace {
  const tracer = new Tracer({
    runId: trial.trialId,
    botId: `eval-harness-v2:${task.id}`,
  });
  const root = tracer.startSpan('tool', `eval-harness-v2:${task.id}`, {
    attributes: {
      taskId: task.id,
      trialId: trial.trialId,
      kind: task.kind,
      difficulty: task.difficulty,
      status: trial.status,
      score: trial.score,
      steps: trial.steps,
    },
  });
  if (trial.inputTokens > 0 || trial.outputTokens > 0) {
    const llm = tracer.startSpan('llm', model ?? EVAL_HARNESS_V2_DEFAULT_COST_MODEL, {
      parentSpanId: root.span.id,
      attributes: {
        model: model ?? EVAL_HARNESS_V2_DEFAULT_COST_MODEL,
        inputTokens: trial.inputTokens,
        outputTokens: trial.outputTokens,
      },
    });
    llm.finish({ inputTokens: trial.inputTokens, outputTokens: trial.outputTokens });
  }
  for (const test of trial.tests) {
    const span = tracer.startSpan('tool', `test:${test.testId}`, {
      parentSpanId: root.span.id,
      attributes: {
        testId: test.testId,
        group: test.group,
        passed: test.afterPassed,
        expectationMet: test.expectationMet,
        durationMs: test.durationMs,
      },
    });
    if (test.afterPassed) span.finish({ passed: true });
    else span.fail(test.stderr ?? `Test ${test.testId} fail.`);
  }
  if (trial.status === 'pass') root.finish({ score: trial.score, reason: trial.reason });
  else if (trial.status === 'error') root.fail(trial.reason);
  else root.finish({ score: trial.score, reason: trial.reason });
  return tracer.toTrace(trial.status === 'error' ? 'error' : 'ok');
}

/** Convert Trace của trial sang OTel resource span (để xuất/xem trong trace store). */
export function trialTraceToOtel(trace: Trace): OtelResourceSpan {
  return traceToOtel(trace);
}

/** Chi phí ước tính từ chính Trace (qua estimateTraceCost của repo). */
export function estimateTrialTraceCostUsd(trace: Trace): number {
  return estimateTraceCost(trace);
}

/**
 * Khoảng tin cậy Wilson 95% cho tỉ lệ pass (passed/n). Dùng z = 1.96.
 * Trả về [0, 1] khi n = 0 (không có dữ liệu — không giả vờ chắc chắn).
 */
export function wilsonCi95(
  passed: number,
  total: number,
): { lower: number; upper: number } {
  if (total <= 0) return { lower: 0, upper: 1 };
  const z = 1.96;
  const p = passed / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    lower: Math.max(0, (center - spread) / denom),
    upper: Math.min(1, (center + spread) / denom),
  };
}

function randomRunId(): string {
  return `eval-harness-v2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Gộp kết quả các task thành SuiteResult (điểm + CI theo từng suite). */
export function aggregateSuiteResults(
  suiteId: string,
  agentLabel: string,
  taskResults: EvalHarnessV2TaskResult[],
  startedAt: number,
  runId?: string,
): EvalHarnessV2SuiteResult {
  const finishedAt = Date.now();
  const allTrials = taskResults.flatMap((t) => t.trials);
  const passedTrials = allTrials.filter((t) => t.status === 'pass').length;
  const tasksPassed = taskResults.filter((t) => t.passRate === 1).length;
  const totalTrials = allTrials.length;
  const meanScore =
    totalTrials === 0 ? 0 : allTrials.reduce((s, t) => s + t.score, 0) / totalTrials;
  return {
    suiteId,
    runId: runId ?? randomRunId(),
    agentLabel,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    tasks: taskResults,
    taskPassRate: taskResults.length === 0 ? 0 : tasksPassed / taskResults.length,
    trialPassRate: totalTrials === 0 ? 0 : passedTrials / totalTrials,
    meanScore,
    trialPassRateCi95: wilsonCi95(passedTrials, totalTrials),
    totalCostUsd: allTrials.reduce((s, t) => s + t.estimatedCostUsd, 0),
    totalTrialMs: allTrials.reduce((s, t) => s + t.durationMs, 0),
  };
}

/** Render kết quả suite thành text đọc được (CLI/tool/UI in ra). */
export function renderEvalHarnessV2SuiteText(result: EvalHarnessV2SuiteResult): string {
  const lines: string[] = [];
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  lines.push(`Eval Harness v2 — suite ${result.suiteId} (${result.runId})`);
  lines.push(`Agent: ${result.agentLabel} — ${result.tasks.length} task, ${result.tasks.flatMap((t) => t.trials).length} trial, ${result.durationMs}ms`);
  lines.push(
    `Trial pass rate: ${pct(result.trialPassRate)} (95% CI ${pct(result.trialPassRateCi95.lower)}–${pct(result.trialPassRateCi95.upper)}), ` +
      `task pass rate: ${pct(result.taskPassRate)}, mean score: ${result.meanScore.toFixed(3)}, ` +
      `total cost: $${result.totalCostUsd.toFixed(4)}`,
  );
  for (const task of result.tasks) {
    lines.push(
      `\n[${task.kind}/${task.difficulty}] ${task.taskId} — pass ${pct(task.passRate)}, ` +
        `score ${task.meanScore.toFixed(3)}, ${task.meanDurationMs.toFixed(0)}ms/trial, ` +
        `${task.meanSteps.toFixed(1)} steps/trial, $${task.meanCostUsd.toFixed(4)}/trial`,
    );
    for (const trial of task.trials) {
      lines.push(
        `  ${trial.status === 'pass' ? 'PASS' : trial.status.toUpperCase()}  ${trial.trialId} ` +
          `score ${trial.score.toFixed(2)}, ${trial.durationMs}ms, ${trial.steps} steps, ` +
          `$${trial.estimatedCostUsd.toFixed(4)} — ${trial.reason}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
