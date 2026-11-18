/**
 * Eval Harness v3 — parallel runner + trial loop (v1.35, Đội T4).
 *
 * Mỗi trial chạy trong container theo spec của task, có guardrail ở
 * 3 điểm và trace quyết định ghi lại từng bước:
 *
 * 1. Input guardrail (instruction + issue) — trip block → trial dừng
 *    ngay với status `guardrail-trip`, không chạy agent.
 * 2. Materialize input (repo snapshot + environment) + setup container.
 * 3. Base test (chỉ issue-patch): fail-to-pass phải fail trước patch.
 * 4. Chạy executor với timeout + AbortSignal (như v2).
 * 5. Tool guardrail trên các tool call executor báo cáo + output
 *    guardrail trên files/commands agent trả về — trip block → trial
 *    dừng với status `guardrail-trip`, KHÔNG áp patch của agent.
 * 6. Áp kết quả agent: ghi files rồi chạy commands trong container.
 * 7. Chấm bằng test xác định; test fail được chạy lại tối đa
 *    FLAKE_RETRIES lần để phát hiện flaky (kết quả lần đầu mới
 *    quyết định pass/fail — chạy lại chỉ để gắn cờ flaky, điểm
 *    flake-adjusted ở scorer.ts sẽ trừ nửa weight test flaky).
 * 8. Trace: mọi bước trên đều là span — mở trace là thấy trial
 *    dừng ở đâu và vì sao.
 *
 * Runner KHÔNG gọi model trực tiếp — host/CLI bind executor thật.
 * Trial không bao giờ throw vì agent/test fail — fail là kết quả;
 * chỉ throw khi tạo workdir lỗi (lỗi hệ thống).
 */

import {
  createEvalHarnessV3TrialWorkDir,
  removeEvalHarnessV3TrialWorkDir,
  runContainerSetup,
  runInEvalContainer,
  writeEvalHarnessV3FilesToWorkDir,
} from './sandbox.js';
import {
  aggregateEvalHarnessV3SuiteResults,
  estimateEvalHarnessV3CostUsd,
  estimatePassAtK,
  scoreEvalHarnessV3Trial,
  scoreEvalHarnessV3TrialFlakeAdjusted,
} from './scorer.js';
import {
  EvalHarnessV3TripwireError,
  checkEvalInput,
  checkEvalOutput,
  checkEvalToolCall,
} from './guardrails.js';
import { EvalHarnessV3TraceBuilder } from './tracing.js';
import type {
  EvalHarnessV3GuardrailTrip,
  EvalHarnessV3SuiteResult,
  EvalHarnessV3Task,
  EvalHarnessV3TaskResult,
  EvalHarnessV3TestResult,
  EvalHarnessV3Trace,
  EvalHarnessV3TrialResult,
  EvalHarnessV3TrialStatus,
} from './types.js';
import {
  EVAL_HARNESS_V3_DEFAULT_CONCURRENCY,
  EVAL_HARNESS_V3_DEFAULT_FLAKE_RETRIES,
  EVAL_HARNESS_V3_DEFAULT_MAX_TRIALS,
  defaultEvalHarnessV3TestGroup,
  normalizeContainerSpec,
} from './types.js';

/** Một tool call agent đã gọi (executor báo cáo để tool guardrail kiểm tra). */
export interface EvalHarnessV3ToolCall {
  /** Tên tool, vd `read_file`. */
  name: string;
  /** Tham số tool call. */
  args?: Record<string, unknown>;
}

/** Kết quả agent trả về sau một trial: file + lệnh + tool call agent đã làm. */
export interface EvalHarnessV3AgentResult {
  /** File agent tạo/ghi đè (đường dẫn tương đối → nội dung). */
  files: Record<string, string>;
  /** Lệnh agent chạy trong workdir (sau khi ghi files), vd tạo file bằng script. */
  commands?: string[];
  /** Tool call agent đã gọi (để tool guardrail kiểm tra sau khi chạy). */
  toolCalls?: EvalHarnessV3ToolCall[];
  /** Số bước/tool call agent đã dùng. */
  steps: number;
  /** Token input ước tính (0 khi executor không biết). */
  inputTokens: number;
  /** Token output ước tính (0 khi executor không biết). */
  outputTokens: number;
}

/** Executor chạy agent trên một trial. Nhận AbortSignal để huỷ khi timeout. */
export type EvalHarnessV3Executor = (
  task: EvalHarnessV3Task,
  workDir: string,
  trialIndex: number,
  signal: AbortSignal,
) => Promise<EvalHarnessV3AgentResult>;

/** Executor no-op: agent không làm gì — dùng để đo baseline "không làm gì cũng fail". */
export const noopEvalHarnessV3Executor: EvalHarnessV3Executor = async () => ({
  files: {},
  commands: [],
  toolCalls: [],
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
});

/**
 * Executor scripted: mỗi task id map tới kết quả agent định trước
 * (files + commands + toolCalls + steps/tokens). Dùng cho test + CLI
 * chạy bộ task mẫu local-first mà không cần model thật. Task không có
 * trong plan → no-op (báo rõ qua `steps: 0`, không giả vờ agent đã chạy).
 */
export function scriptedEvalHarnessV3Executor(
  plan: Record<string, EvalHarnessV3AgentResult>,
): EvalHarnessV3Executor {
  return async (task) => {
    const entry = plan[task.id];
    if (entry === undefined) {
      return { files: {}, commands: [], toolCalls: [], steps: 0, inputTokens: 0, outputTokens: 0 };
    }
    return {
      files: { ...(entry.files ?? {}) },
      commands: [...(entry.commands ?? [])],
      toolCalls: [...(entry.toolCalls ?? [])],
      steps: entry.steps ?? 0,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
    };
  };
}

export interface EvalHarnessV3RunnerOptions {
  /** Số trial mỗi task (mặc định = task.maxTrials ?? 3). */
  trials?: number;
  /** Số trial chạy song song tối đa (mặc định 4, tối đa 32). */
  concurrency?: number;
  /** Timeout mỗi trial (ms) — mặc định = task.timeoutMs. */
  timeoutMs?: number;
  /** Giữ lại workdir sau trial để debug (mặc định false = xoá). */
  keepWorkDir?: boolean;
  /** Callback sau mỗi trial xong (để CLI/UI cập nhật tiến độ). */
  onTrial?: (trial: EvalHarnessV3TrialResult) => void;
  /** Callback sau mỗi trace xong (để tool lưu JSONL). */
  onTrace?: (trace: EvalHarnessV3Trace) => void;
  /** Signal huỷ toàn bộ lần chạy (Ctrl-C / gate). */
  signal?: AbortSignal;
  /** Model dùng để ước tính chi phí (vd 'gpt-4o', 'claude-sonnet-4'). */
  model?: string;
  /** Chế độ chạy guardrail: parallel (mặc định) hay sequential. */
  guardrailMode?: 'parallel' | 'sequential';
  /** Số lần chạy lại test fail để phát hiện flaky (mặc định 2). */
  flakeRetries?: number;
  /** Bỏ qua input guardrail (chỉ dùng khi debug task — trace ghi rõ). */
  skipInputGuardrail?: boolean;
}

async function runTestsWithFlakeCheck(
  task: EvalHarnessV3Task,
  workDir: string,
  baseResults: Map<string, boolean> | null,
  flakeRetries: number,
  trace: EvalHarnessV3TraceBuilder,
  trialSpanId: string,
): Promise<{ tests: EvalHarnessV3TestResult[]; sandboxWarning?: string }> {
  const tests: EvalHarnessV3TestResult[] = [];
  let sandboxWarning: string | undefined;
  const container = normalizeContainerSpec(task.container);
  for (const test of task.tests) {
    const testStarted = Date.now();
    const timeoutMs = Math.min(test.timeoutMs ?? task.timeoutMs, task.timeoutMs);
    const group = test.group ?? defaultEvalHarnessV3TestGroup(task.kind);
    const testSpanId = trace.startSpan('test', `test:${test.id}`, trialSpanId, { group, weight: test.weight ?? 1 });
    const first = await runInEvalContainer(test.command, workDir, container, timeoutMs);
    if (first.sandboxWarning !== undefined) sandboxWarning = first.sandboxWarning;
    let afterPassed = first.passed;
    let flaky = false;
    let runs = 1;
    // Test fail (hoặc test cho phép retry) được chạy lại để phát hiện
    // flaky: kết quả lần sau khác lần đầu → gắn cờ flaky. Kết quả
    // lần ĐẦU mới quyết định pass/fail (xác định, không ăn may).
    if (test.retryOnFlake !== false && flakeRetries > 0) {
      for (let retry = 0; retry < flakeRetries; retry += 1) {
        const again = await runInEvalContainer(test.command, workDir, container, timeoutMs);
        runs += 1;
        if (again.passed !== first.passed) {
          flaky = true;
          break;
        }
      }
    }
    const basePassed = baseResults?.get(test.id) ?? null;
    const expectationMet =
      group === 'fail-to-pass' ? basePassed === false && afterPassed : afterPassed;
    trace.endSpan(
      testSpanId,
      first.setupError !== undefined ? 'error' : expectationMet ? 'pass' : 'fail',
      first.setupError ?? (expectationMet ? undefined : `test ${test.id} không đạt kỳ vọng${flaky ? ' (flaky)' : ''}`),
      { exitCode: first.exitCode ?? -1, runs, flaky },
    );
    tests.push({
      testId: test.id,
      name: test.name,
      group,
      basePassed,
      afterPassed,
      expectationMet,
      weight: test.weight ?? 1,
      durationMs: Date.now() - testStarted,
      stdout: first.stdout,
      ...(first.passed ? {} : { stderr: first.stderr }),
      ...(first.timedOut ? { timedOut: true } : {}),
      ...(flaky ? { flaky: true } : {}),
      runs,
    });
  }
  return { tests, sandboxWarning };
}

/**
 * Chạy MỘT trial của một task. Không bao giờ throw vì agent/test fail —
 * fail là kết quả; chỉ throw khi tạo workdir lỗi (lỗi hệ thống).
 */
export async function runEvalHarnessV3Trial(
  task: EvalHarnessV3Task,
  executor: EvalHarnessV3Executor,
  trialIndex: number,
  options: EvalHarnessV3RunnerOptions = {},
): Promise<EvalHarnessV3TrialResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? task.timeoutMs;
  const trialId = `${task.id}-t${trialIndex}`;
  const guardrailMode = options.guardrailMode ?? task.guardrails?.mode ?? 'parallel';
  const flakeRetries = options.flakeRetries ?? EVAL_HARNESS_V3_DEFAULT_FLAKE_RETRIES;
  const trace = new EvalHarnessV3TraceBuilder(task.id, trialId, trialIndex);
  const trialSpanId = trace.startSpan('trial', `trial:${trialId}`, undefined, {
    kind: task.kind,
    difficulty: task.difficulty,
  });
  const workDir = createEvalHarnessV3TrialWorkDir('eval-harness-v3-trial-');
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let status: EvalHarnessV3TrialStatus = 'fail';
  let reason = '';
  let tests: EvalHarnessV3TestResult[] = [];
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let sandboxed = false;
  let sandboxWarning: string | undefined;
  let containerBackend: EvalHarnessV3TrialResult['containerBackend'] = 'local';
  let guardrailTrips: EvalHarnessV3GuardrailTrip[] | undefined;
  let traceFinished = false;

  const finishTrace = (finalStatus: EvalHarnessV3TrialStatus): EvalHarnessV3Trace => {
    trace.endSpan(trialSpanId, finalStatus === 'pass' ? 'pass' : finalStatus === 'guardrail-trip' ? 'trip' : finalStatus === 'timeout' ? 'timeout' : finalStatus === 'error' ? 'error' : finalStatus === 'cancelled' ? 'cancelled' : 'fail', reason === '' ? undefined : reason);
    const finished = trace.finish(finalStatus);
    traceFinished = true;
    options.onTrace?.(finished);
    return finished;
  };

  try {
    if (controller.signal.aborted) {
      status = 'cancelled';
      reason = 'Trial bị huỷ trước khi chạy.';
    } else {
      // 1. Input guardrail — trip block thì dừng ngay, không chạy agent.
      if (!options.skipInputGuardrail && task.guardrails?.enabled !== false) {
        const guardSpanId = trace.startSpan('guardrail', 'guardrail:input', trialSpanId);
        const check = checkEvalInput(task, guardrailMode);
        if (check.trips.length > 0) guardrailTrips = [...(guardrailTrips ?? []), ...check.trips];
        trace.endSpan(guardSpanId, check.blocked ? 'trip' : 'pass', check.blocked ? 'Input guardrail trip.' : undefined, { checked: check.checked, trips: check.trips.length });
        if (check.blocked) {
          throw new EvalHarnessV3TripwireError(check.trips.filter((t) => t.severity === 'block'));
        }
      }

      // 2. Materialize input + setup container.
      const matSpanId = trace.startSpan('materialize', 'materialize:input', trialSpanId);
      writeEvalHarnessV3FilesToWorkDir(workDir, {
        ...(task.input.repoSnapshot ?? {}),
        ...(task.input.environmentFiles ?? {}),
      });
      const container = normalizeContainerSpec(task.container);
      const setupError = await runContainerSetup(container, workDir, timeoutMs);
      trace.endSpan(matSpanId, setupError !== undefined ? 'error' : 'pass', setupError, { files: Object.keys(task.input.repoSnapshot ?? {}).length + Object.keys(task.input.environmentFiles ?? {}).length });
      if (setupError !== undefined) {
        status = 'error';
        reason = `Lỗi setup container: ${setupError.slice(0, 300)}`;
      } else {
        // 3. Base test (chỉ issue-patch): fail-to-pass phải fail trước patch.
        let baseResults: Map<string, boolean> | null = null;
        if (task.kind === 'issue-patch') {
          baseResults = new Map();
          for (const test of task.tests) {
            const group = test.group ?? defaultEvalHarnessV3TestGroup(task.kind);
            if (group !== 'fail-to-pass') continue;
            const baseSpanId = trace.startSpan('base-test', `base-test:${test.id}`, trialSpanId);
            const res = await runInEvalContainer(
              test.command,
              workDir,
              container,
              Math.min(test.timeoutMs ?? task.timeoutMs, task.timeoutMs),
            );
            if (res.sandboxWarning !== undefined) sandboxWarning = res.sandboxWarning;
            containerBackend = res.backend;
            sandboxed = res.backend !== 'local';
            trace.endSpan(baseSpanId, res.passed ? 'fail' : 'pass', res.passed ? 'fail-to-pass pass sẵn trước patch (task có thể vô nghĩa)' : undefined, { exitCode: res.exitCode ?? -1 });
            baseResults.set(test.id, res.passed);
          }
        }

        // 4. Chạy executor với timeout.
        const execSpanId = trace.startSpan('executor', 'executor:agent', trialSpanId);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let agent: EvalHarnessV3AgentResult | null = null;
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
        trace.endSpan(execSpanId, agent !== null ? 'pass' : executorError !== null ? 'error' : 'timeout', executorError ?? (agent !== null ? undefined : 'Executor không trả kết quả trước timeout.'), { steps: agent?.steps ?? 0 });

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
          // 5a. Tool guardrail trên tool call agent báo cáo.
          if (task.guardrails?.enabled !== false && (agent.toolCalls ?? []).length > 0) {
            const toolSpanId = trace.startSpan('guardrail', 'guardrail:tool', trialSpanId);
            let toolBlocked = false;
            for (const call of agent.toolCalls ?? []) {
              const check = checkEvalToolCall(task, call.name, call.args ?? {}, steps, guardrailMode);
              if (check.trips.length > 0) guardrailTrips = [...(guardrailTrips ?? []), ...check.trips];
              if (check.blocked) {
                toolBlocked = true;
                trace.endSpan(toolSpanId, 'trip', `Tool guardrail trip: ${call.name}.`, { tool: call.name });
                throw new EvalHarnessV3TripwireError(check.trips.filter((t) => t.severity === 'block'));
              }
            }
            if (!toolBlocked) trace.endSpan(toolSpanId, 'pass', undefined, { calls: (agent.toolCalls ?? []).length });
          }
          // 5b. Output guardrail trên files/commands agent trả về.
          if (task.guardrails?.enabled !== false) {
            const outSpanId = trace.startSpan('guardrail', 'guardrail:output', trialSpanId);
            const check = checkEvalOutput(task, agent.files ?? {}, agent.commands ?? [], guardrailMode);
            if (check.trips.length > 0) guardrailTrips = [...(guardrailTrips ?? []), ...check.trips];
            trace.endSpan(outSpanId, check.blocked ? 'trip' : 'pass', check.blocked ? 'Output guardrail trip.' : undefined, { checked: check.checked, trips: check.trips.length });
            if (check.blocked) {
              throw new EvalHarnessV3TripwireError(check.trips.filter((t) => t.severity === 'block'));
            }
          }
          // 6. Áp kết quả agent: ghi files rồi chạy commands.
          writeEvalHarnessV3FilesToWorkDir(workDir, agent.files ?? {});
          let commandFailed: string | null = null;
          for (const command of agent.commands ?? []) {
            const cmdSpanId = trace.startSpan('agent-command', `agent-command:${command.slice(0, 60)}`, trialSpanId);
            const res = await runInEvalContainer(command, workDir, container, timeoutMs);
            if (res.sandboxWarning !== undefined) sandboxWarning = res.sandboxWarning;
            containerBackend = res.backend;
            sandboxed = res.backend !== 'local';
            trace.endSpan(cmdSpanId, res.passed ? 'pass' : 'fail', res.passed ? undefined : `exit ${String(res.exitCode)}`, { exitCode: res.exitCode ?? -1 });
            if (!res.passed) {
              commandFailed = `Lệnh agent fail (exit ${String(res.exitCode)}): "${command.slice(0, 120)}"`;
              break;
            }
          }
          // 7. Chấm bằng test xác định (kèm phát hiện flaky).
          const judged = await runTestsWithFlakeCheck(task, workDir, baseResults, flakeRetries, trace, trialSpanId);
          tests = judged.tests;
          if (judged.sandboxWarning !== undefined) sandboxWarning = judged.sandboxWarning;
          const scoreSpanId = trace.startSpan('score', 'score:trial', trialSpanId);
          const score = scoreEvalHarnessV3Trial(tests);
          const flakeAdjusted = scoreEvalHarnessV3TrialFlakeAdjusted(tests);
          trace.endSpan(scoreSpanId, score === 1 ? 'pass' : 'fail', undefined, { score, flakeAdjusted });
          if (commandFailed !== null) {
            status = 'fail';
            reason = commandFailed;
          } else if (score === 1) {
            status = 'pass';
            reason = `Tất cả ${tests.length} test đạt kỳ vọng.`;
          } else {
            status = 'fail';
            const passedCount = tests.filter((t) => t.expectationMet).length;
            const failed = tests.filter((t) => !t.expectationMet).map((t) => t.testId);
            reason = `${passedCount}/${tests.length} test đạt — fail: ${failed.join(', ')}.`;
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof EvalHarnessV3TripwireError) {
      status = 'guardrail-trip';
      guardrailTrips = [...(guardrailTrips ?? []), ...err.trips.filter((t) => !(guardrailTrips ?? []).some((g) => g.guardrailId === t.guardrailId && g.trippedAt === t.trippedAt))];
      reason = `Guardrail tripwire dừng trial: ${err.trips.map((t) => t.guardrailId).join(', ')}.`;
    } else {
      // Lỗi hệ thống (ghi file, tạo workdir...) — trial error, không crash suite.
      status = 'error';
      reason = `Lỗi trial: ${(err as Error).message.slice(0, 300)}`;
    }
  } finally {
    if (options.signal !== undefined) {
      options.signal.removeEventListener('abort', onOuterAbort);
    }
    if (!options.keepWorkDir) removeEvalHarnessV3TrialWorkDir(workDir);
  }

  const finishedAt = Date.now();
  const passedTests = tests.filter((t) => t.expectationMet).length;
  const finishedTrace = traceFinished ? undefined : finishTrace(status);
  const trial: EvalHarnessV3TrialResult = {
    trialId,
    taskId: task.id,
    trialIndex,
    status,
    score: scoreEvalHarnessV3Trial(tests),
    tests,
    passedTests,
    totalTests: tests.length,
    durationMs: finishedAt - startedAt,
    steps,
    inputTokens,
    outputTokens,
    estimatedCostUsd: estimateEvalHarnessV3CostUsd(inputTokens, outputTokens, options.model),
    containerBackend,
    sandboxed,
    ...(sandboxWarning !== undefined ? { sandboxWarning } : {}),
    ...(finishedTrace !== undefined ? { traceId: finishedTrace.traceId } : {}),
    ...(guardrailTrips !== undefined && guardrailTrips.length > 0 ? { guardrailTrips } : {}),
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

/** Gộp các trial của một task thành EvalHarnessV3TaskResult. */
export function aggregateEvalHarnessV3TaskTrials(
  task: EvalHarnessV3Task,
  trials: EvalHarnessV3TrialResult[],
): EvalHarnessV3TaskResult {
  const n = Math.max(1, trials.length);
  const passedTrials = trials.filter((t) => t.status === 'pass').length;
  const passRate = trials.length === 0 ? 0 : passedTrials / trials.length;
  return {
    taskId: task.id,
    taskName: task.name,
    kind: task.kind,
    difficulty: task.difficulty,
    trials,
    passRate,
    meanScore: trials.reduce((s, t) => s + t.score, 0) / n,
    meanFlakeAdjustedScore:
      trials.reduce((s, t) => s + scoreEvalHarnessV3TrialFlakeAdjusted(t.tests), 0) / n,
    passAtK: estimatePassAtK(passRate, trials.length),
    meanDurationMs: trials.reduce((s, t) => s + t.durationMs, 0) / n,
    meanSteps: trials.reduce((s, t) => s + t.steps, 0) / n,
    meanCostUsd: trials.reduce((s, t) => s + t.estimatedCostUsd, 0) / n,
    guardrailTrips: trials.reduce((s, t) => s + (t.guardrailTrips?.length ?? 0), 0),
  };
}

/** Chạy một task N trial (song song trong giới hạn concurrency). */
export async function runEvalHarnessV3Task(
  task: EvalHarnessV3Task,
  executor: EvalHarnessV3Executor,
  options: EvalHarnessV3RunnerOptions = {},
): Promise<EvalHarnessV3TaskResult> {
  const trialsCount = options.trials ?? task.maxTrials ?? EVAL_HARNESS_V3_DEFAULT_MAX_TRIALS;
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? EVAL_HARNESS_V3_DEFAULT_CONCURRENCY, 32),
  );
  const jobs = Array.from({ length: trialsCount }, (_, i) => () =>
    runEvalHarnessV3Trial(task, executor, i, options),
  );
  const trials = await runPool(jobs, concurrency);
  return aggregateEvalHarnessV3TaskTrials(task, trials);
}

/** Chạy nhiều task (mỗi task N trial), pool chung giới hạn concurrency. */
export async function runEvalHarnessV3Tasks(
  tasks: EvalHarnessV3Task[],
  executor: EvalHarnessV3Executor,
  options: EvalHarnessV3RunnerOptions = {},
): Promise<EvalHarnessV3TaskResult[]> {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? EVAL_HARNESS_V3_DEFAULT_CONCURRENCY, 32),
  );
  const jobs = tasks.map((task) => () => runEvalHarnessV3Task(task, executor, {
    ...options,
    // Trial trong task đã pool riêng; task-level pool chạy tuần tự
    // từng task để không nhân concurrency (task × trial) quá tải máy.
    concurrency: 1,
  }));
  return runPool(jobs, concurrency);
}

/** Gộp kết quả các task thành SuiteResult (aggregation ở scorer.ts tính CI). */
export function buildEvalHarnessV3SuiteResult(
  suiteId: string,
  agentLabel: string,
  taskResults: EvalHarnessV3TaskResult[],
  startedAt: number,
  runId?: string,
): EvalHarnessV3SuiteResult {
  return aggregateEvalHarnessV3SuiteResults(suiteId, agentLabel, taskResults, startedAt, runId);
}
