/**
 * Eval Harness v2 — parallel runner + trial loop (v1.34, Đội T4).
 *
 * Kiến trúc 3 lớp (theo survey §4): rollout worker stateless ở đây,
 * judge là test xác định (test.sh/lệnh shell, xem oracle.ts), aggregation
 * ở scorer.ts. Runner chỉ lo chạy trial và thu thập kết quả thô.
 *
 * - Executor: hàm agent nhận (task, workDir, trialIndex, signal) và trả
 *   về { files, commands?, steps, inputTokens, outputTokens }. Runner
 *   KHÔNG gọi model trực tiếp — host/CLI bind executor thật (CLI agent,
 *   scripted, noop). Nhờ đó chạy local-first, không cần API key.
 * - Mỗi trial = một workdir tạm riêng (stateless: không chia sẻ state
 *   giữa các trial), materialize input → đo base test (issue-patch) →
 *   chạy executor (timeout + AbortSignal) → áp files + chạy commands
 *   của agent → chạy test chấm → dọn workdir (trừ khi keepWorkDir).
 * - Chạy song song: pool có giới hạn concurrency (mặc định 4, tối đa
 *   32); trial treo bị timeout → status 'timeout', các trial khác vẫn
 *   chạy tiếp; trial lỗi executor → status 'error', không crash suite.
 * - Huỷ: AbortSignal bên ngoài (CLI Ctrl-C / gate) — trial đang chạy
 *   ghi status 'cancelled', các trial chưa bắt đầu không chạy nữa.
 */

import {
  createEvalTrialWorkDir,
  removeEvalTrialWorkDir,
  runInEvalSandbox,
  writeFilesToWorkDir,
} from './sandbox.js';
import { aggregateSuiteResults, estimateEvalCostUsd } from './scorer.js';
import type {
  EvalHarnessV2SuiteResult,
  EvalHarnessV2Task,
  EvalHarnessV2TaskResult,
  EvalHarnessV2TestResult,
  EvalHarnessV2TrialResult,
  EvalHarnessV2TrialStatus,
} from './types.js';
import {
  EVAL_HARNESS_V2_DEFAULT_CONCURRENCY,
  EVAL_HARNESS_V2_DEFAULT_MAX_TRIALS,
} from './types.js';

/** Kết quả agent trả về sau một trial: file + lệnh agent đã làm. */
export interface EvalHarnessV2AgentResult {
  /** File agent tạo/ghi đè (đường dẫn tương đối → nội dung). */
  files: Record<string, string>;
  /** Lệnh agent chạy trong workdir (sau khi ghi files), vd tạo file bằng script. */
  commands?: string[];
  /** Số bước/tool call agent đã dùng. */
  steps: number;
  /** Token input ước tính (0 khi executor không biết). */
  inputTokens: number;
  /** Token output ước tính (0 khi executor không biết). */
  outputTokens: number;
}

/** Executor chạy agent trên một trial. Nhận AbortSignal để huỷ khi timeout. */
export type EvalHarnessV2Executor = (
  task: EvalHarnessV2Task,
  workDir: string,
  trialIndex: number,
  signal: AbortSignal,
) => Promise<EvalHarnessV2AgentResult>;

/** Executor no-op: agent không làm gì — dùng để đo baseline "không làm gì cũng fail". */
export const noopEvalHarnessV2Executor: EvalHarnessV2Executor = async () => ({
  files: {},
  commands: [],
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
});

/**
 * Executor scripted: mỗi task id map tới kết quả agent định trước
 * (files + commands + steps/tokens). Dùng cho test + CLI chạy bộ task
 * mẫu local-first mà không cần model thật. Task không có trong plan →
 * no-op (báo rõ qua `steps: 0`, không giả vờ agent đã chạy).
 */
export function scriptedEvalHarnessV2Executor(
  plan: Record<string, EvalHarnessV2AgentResult>,
): EvalHarnessV2Executor {
  return async (task) => {
    const entry = plan[task.id];
    if (entry === undefined) {
      return { files: {}, commands: [], steps: 0, inputTokens: 0, outputTokens: 0 };
    }
    return {
      files: { ...(entry.files ?? {}) },
      commands: [...(entry.commands ?? [])],
      steps: entry.steps ?? 0,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
    };
  };
}

export interface EvalHarnessV2RunnerOptions {
  /** Số trial mỗi task (mặc định = task.maxTrials ?? 3). */
  trials?: number;
  /** Số trial chạy song song tối đa (mặc định 4, tối đa 32). */
  concurrency?: number;
  /** Timeout mỗi trial (ms) — mặc định = task.timeoutMs. */
  timeoutMs?: number;
  /** Giữ lại workdir sau trial để debug (mặc định false = xoá). */
  keepWorkDir?: boolean;
  /** Callback sau mỗi trial xong (để CLI/UI cập nhật tiến độ). */
  onTrial?: (trial: EvalHarnessV2TrialResult) => void;
  /** Signal huỷ toàn bộ lần chạy (Ctrl-C / gate). */
  signal?: AbortSignal;
  /** Model dùng để ước tính chi phí (vd 'gpt-4o', 'claude-sonnet-4'). */
  model?: string;
}

function weightedScore(tests: EvalHarnessV2TestResult[]): number {
  const total = tests.reduce((sum, t) => sum + t.weight, 0);
  if (total === 0) return 0;
  const got = tests.reduce((sum, t) => sum + (t.expectationMet ? t.weight : 0), 0);
  return got / total;
}

async function runTests(
  task: EvalHarnessV2Task,
  workDir: string,
  baseResults: Map<string, boolean> | null,
): Promise<{ tests: EvalHarnessV2TestResult[]; sandboxWarning?: string }> {
  const tests: EvalHarnessV2TestResult[] = [];
  let sandboxWarning: string | undefined;
  for (const test of task.tests) {
    const testStarted = Date.now();
    const timeoutMs = Math.min(test.timeoutMs ?? task.timeoutMs, task.timeoutMs);
    const group = test.group ?? (task.kind === 'issue-patch' ? 'fail-to-pass' : 'state-check');
    const res = await runInEvalSandbox(test.command, workDir, timeoutMs);
    if (res.sandboxWarning !== undefined) sandboxWarning = res.sandboxWarning;
    const basePassed = baseResults?.get(test.id) ?? null;
    const expectationMet =
      group === 'fail-to-pass' ? basePassed === false && res.passed : res.passed;
    tests.push({
      testId: test.id,
      name: test.name,
      group,
      basePassed,
      afterPassed: res.passed,
      expectationMet,
      weight: test.weight ?? 1,
      durationMs: Date.now() - testStarted,
      stdout: res.stdout,
      ...(res.passed ? {} : { stderr: res.stderr }),
      ...(res.timedOut ? { timedOut: true } : {}),
    });
  }
  return { tests, sandboxWarning };
}

/**
 * Chạy MỘT trial của một task. Không bao giờ throw vì agent/test fail —
 * fail là kết quả; chỉ throw khi tạo workdir lỗi (lỗi hệ thống).
 */
export async function runEvalHarnessV2Trial(
  task: EvalHarnessV2Task,
  executor: EvalHarnessV2Executor,
  trialIndex: number,
  options: EvalHarnessV2RunnerOptions = {},
): Promise<EvalHarnessV2TrialResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? task.timeoutMs;
  const trialId = `${task.id}-t${trialIndex}`;
  const workDir = createEvalTrialWorkDir('eval-harness-v2-trial-');
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let status: EvalHarnessV2TrialStatus = 'fail';
  let reason = '';
  let tests: EvalHarnessV2TestResult[] = [];
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let sandboxed = false;
  let sandboxWarning: string | undefined;

  try {
    if (controller.signal.aborted) {
      status = 'cancelled';
      reason = 'Trial bị huỷ trước khi chạy.';
    } else {
      // 1. Materialize input.
      writeFilesToWorkDir(workDir, {
        ...(task.input.repoSnapshot ?? {}),
        ...(task.input.environmentFiles ?? {}),
      });

      // 2. Base test (chỉ issue-patch): fail-to-pass phải fail trước patch.
      let baseResults: Map<string, boolean> | null = null;
      if (task.kind === 'issue-patch') {
        baseResults = new Map();
        for (const test of task.tests) {
          const group = test.group ?? 'fail-to-pass';
          if (group !== 'fail-to-pass') continue;
          const res = await runInEvalSandbox(
            test.command,
            workDir,
            Math.min(test.timeoutMs ?? task.timeoutMs, task.timeoutMs),
          );
          if (res.sandboxWarning !== undefined) sandboxWarning = res.sandboxWarning;
          baseResults.set(test.id, res.passed);
        }
      }

      // 3. Chạy executor với timeout: quá hạn → abort + status timeout.
      // Race executor với signal abort — nếu chỉ abort mà không race,
      // executor treo (promise không bao giờ settle) sẽ kẹt trial mãi.
      // (Executor có thể vẫn chạy nền sau khi bị abort — signal là
      // cách duy nhất để báo nó dừng; sandbox command đã có timeout
      // riêng nên không kẹt process hệ thống.)
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let agent: EvalHarnessV2AgentResult | null = null;
      let executorError: string | null = null;
      let abortedWhileRunning = false;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) {
          abortedWhileRunning = true;
          reject(new Error('__eval_aborted__'));
          return;
        }
        controller.signal.addEventListener(
          'abort',
          () => {
            abortedWhileRunning = true;
            reject(new Error('__eval_aborted__'));
          },
          { once: true },
        );
      });
      try {
        agent = await Promise.race([
          executor(task, workDir, trialIndex, controller.signal),
          abortPromise,
        ]);
      } catch (err) {
        if ((err as Error).message !== '__eval_aborted__') {
          executorError = (err as Error).message;
        }
      } finally {
        clearTimeout(timer);
      }

      if (abortedWhileRunning && agent === null && executorError === null) {
        if (options.signal?.aborted) {
          status = 'cancelled';
          reason = 'Trial bị huỷ trong lúc agent đang chạy.';
        } else {
          status = 'timeout';
          reason = `Trial timeout sau ${timeoutMs}ms (agent chưa trả kết quả).`;
        }
      } else if (executorError !== null) {
        status = 'error';
        reason = `Executor lỗi: ${executorError.slice(0, 300)}`;
      } else if (agent !== null) {
        steps = agent.steps;
        inputTokens = agent.inputTokens;
        outputTokens = agent.outputTokens;
        // 4. Áp kết quả agent: ghi files rồi chạy commands.
        writeFilesToWorkDir(workDir, agent.files ?? {});
        let commandFailed: string | null = null;
        for (const command of agent.commands ?? []) {
          const res = await runInEvalSandbox(command, workDir, timeoutMs);
          if (res.sandboxWarning !== undefined) sandboxWarning = res.sandboxWarning;
          if (!res.passed) {
            commandFailed = `Lệnh agent fail (exit ${String(res.exitCode)}): "${command.slice(0, 120)}"`;
            break;
          }
        }
        if (commandFailed !== null) {
          status = 'fail';
          reason = commandFailed;
          const judged = await runTests(task, workDir, baseResults);
          tests = judged.tests;
          if (judged.sandboxWarning !== undefined) sandboxWarning = judged.sandboxWarning;
        } else {
          // 5. Chấm bằng test xác định.
          const judged = await runTests(task, workDir, baseResults);
          tests = judged.tests;
          if (judged.sandboxWarning !== undefined) sandboxWarning = judged.sandboxWarning;
          sandboxed = true;
          const passedCount = tests.filter((t) => t.expectationMet).length;
          const score = weightedScore(tests);
          if (score === 1) {
            status = 'pass';
            reason = `Tất cả ${tests.length} test đạt kỳ vọng.`;
          } else {
            status = 'fail';
            const failed = tests.filter((t) => !t.expectationMet).map((t) => t.testId);
            reason = `${passedCount}/${tests.length} test đạt — fail: ${failed.join(', ')}.`;
          }
        }
      }
    }
  } catch (err) {
    // Lỗi hệ thống (ghi file, tạo workdir...) — trial error, không crash suite.
    status = 'error';
    reason = `Lỗi trial: ${(err as Error).message.slice(0, 300)}`;
  } finally {
    if (options.signal !== undefined) {
      options.signal.removeEventListener('abort', onOuterAbort);
    }
    if (!options.keepWorkDir) removeEvalTrialWorkDir(workDir);
  }

  const finishedAt = Date.now();
  const passedTests = tests.filter((t) => t.expectationMet).length;
  const trial: EvalHarnessV2TrialResult = {
    trialId,
    taskId: task.id,
    trialIndex,
    status,
    score: weightedScore(tests),
    tests,
    passedTests,
    totalTests: tests.length,
    durationMs: finishedAt - startedAt,
    steps,
    inputTokens,
    outputTokens,
    estimatedCostUsd: estimateEvalCostUsd(inputTokens, outputTokens, options.model),
    sandboxed,
    ...(sandboxWarning !== undefined ? { sandboxWarning } : {}),
    reason,
    startedAt,
    finishedAt,
  };
  options.onTrial?.(trial);
  return trial;
}

/** Chạy pool có giới hạn concurrency trên danh sách job async. */
async function runPool<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, async () => {
    while (next < jobs.length) {
      const idx = next;
      next += 1;
      results[idx] = await jobs[idx]!();
    }
  });
  await Promise.all(workers);
  return results;
}

/** Gộp các trial của một task thành EvalHarnessV2TaskResult. */
export function aggregateTaskTrials(
  task: EvalHarnessV2Task,
  trials: EvalHarnessV2TrialResult[],
): EvalHarnessV2TaskResult {
  const n = Math.max(1, trials.length);
  const passedTrials = trials.filter((t) => t.status === 'pass').length;
  return {
    taskId: task.id,
    taskName: task.name,
    kind: task.kind,
    difficulty: task.difficulty,
    trials,
    passRate: passedTrials / trials.length,
    meanScore: trials.reduce((s, t) => s + t.score, 0) / n,
    meanDurationMs: trials.reduce((s, t) => s + t.durationMs, 0) / n,
    meanSteps: trials.reduce((s, t) => s + t.steps, 0) / n,
    meanCostUsd: trials.reduce((s, t) => s + t.estimatedCostUsd, 0) / n,
  };
}

/** Chạy một task N trial (song song trong giới hạn concurrency). */
export async function runEvalHarnessV2Task(
  task: EvalHarnessV2Task,
  executor: EvalHarnessV2Executor,
  options: EvalHarnessV2RunnerOptions = {},
): Promise<EvalHarnessV2TaskResult> {
  const trialsCount = options.trials ?? task.maxTrials ?? EVAL_HARNESS_V2_DEFAULT_MAX_TRIALS;
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? EVAL_HARNESS_V2_DEFAULT_CONCURRENCY, 32),
  );
  const jobs = Array.from({ length: trialsCount }, (_, i) => () =>
    runEvalHarnessV2Trial(task, executor, i, options),
  );
  const trials = await runPool(jobs, concurrency);
  return aggregateTaskTrials(task, trials);
}

/** Chạy nhiều task (mỗi task N trial), pool chung giới hạn concurrency. */
export async function runEvalHarnessV2Tasks(
  tasks: EvalHarnessV2Task[],
  executor: EvalHarnessV2Executor,
  options: EvalHarnessV2RunnerOptions = {},
): Promise<EvalHarnessV2TaskResult[]> {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? EVAL_HARNESS_V2_DEFAULT_CONCURRENCY, 32),
  );
  const jobs = tasks.map((task) => () => runEvalHarnessV2Task(task, executor, {
    ...options,
    // Trial trong task đã pool riêng; task-level pool chạy tuần tự
    // từng task để không nhân concurrency (task × trial) quá tải máy.
    concurrency: 1,
  }));
  return runPool(jobs, concurrency);
}

/** Gộp kết quả các task thành SuiteResult (aggregation ở scorer.ts tính CI). */
export function buildSuiteResult(
  suiteId: string,
  agentLabel: string,
  taskResults: EvalHarnessV2TaskResult[],
  startedAt: number,
  runId?: string,
): EvalHarnessV2SuiteResult {
  return aggregateSuiteResults(suiteId, agentLabel, taskResults, startedAt, runId);
}
