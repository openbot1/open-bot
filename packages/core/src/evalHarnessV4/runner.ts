/**
 * Suite runner của Eval Harness v4 (v1.44, Đội T2).
 *
 * Runner V4 điều phối `HarborRunner` (v1.11) — không chạy lại
 * sandbox hay chấm test.sh theo cách riêng:
 *
 *   - mỗi task chạy trong sandbox box RIÊNG (một box / task /
 *     attempt, box bị xoá sau khi chấm trừ khi `keepWorkspace`);
 *   - mỗi task chạy `repeats` lần TUẦN TỰ (máy 1,5 CPU không
 *     gánh song song sandbox nặng — giống quyết định của
 *     HarborRunner.runSuite);
 *   - executor bị giới hạn bởi `taskTimeoutMs` (HarborRunner chỉ
 *     timeout test.sh; V4 bọc executor bằng Promise.race để agent
 *     treo cũng không treo cả suite — attempt đó ghi lỗi timeout,
 *     suite vẫn chạy task sau);
 *   - sau mỗi task, gom các attempt thành `EvalHarnessV4TaskResult`
 *     (mean/best/worst reward, flaky khi lúc pass lúc fail);
 *   - sau cả suite, ghi run record vào lịch sử, prune run cũ,
 *     so hồi quy với baseline, build + render dashboard.
 *
 * Runner KHÔNG gọi model trực tiếp: executor do host cung cấp
 * (CLI dùng executor scripted/no-op; tool/UI bind executor chạy
 * agent loop thật). Không có executor → throw lỗi rõ, không giả
 * vờ agent đã chạy (phong cách HarborRunner).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  HarborRunner,
  noopHarborExecutor,
  type HarborAgentContext,
  type HarborAgentExecutor,
  type HarborRunResult,
} from '../eval/harborRunner';
import type { HarborTask } from '../eval/harborTask';
import { EVAL_HARNESS_V4_DASHBOARD_DIR, EVAL_HARNESS_V4_FORMAT } from './types';
import type {
  EvalHarnessV4Attempt,
  EvalHarnessV4Config,
  EvalHarnessV4Dashboard,
  EvalHarnessV4RegressionReport,
  EvalHarnessV4RunRecord,
  EvalHarnessV4TaskResult,
} from './types';
import { defaultEvalHarnessV4Config } from './config';
import {
  appendEvalHarnessV4RunRecord,
  getEvalHarnessV4HistoryDir,
  loadEvalHarnessV4History,
  pruneEvalHarnessV4History,
  resolveEvalHarnessV4BaselineRun,
} from './history';
import { detectEvalHarnessV4Regressions, evalHarnessV4GateExitCode } from './regression';
import {
  buildEvalHarnessV4Dashboard,
  renderEvalHarnessV4DashboardHtml,
  renderEvalHarnessV4DashboardMarkdown,
} from './dashboard';

/** Id run ổn định: `v4-20261119T051500-<6 ký tự hex>`. */
export function buildEvalHarnessV4RunId(now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '').replace('T', 'T').slice(0, 15);
  return `v4-${stamp}-${randomUUID().slice(0, 6)}`;
}

/** Số lần retry hạ tầng tối đa cho phép (chống config nhầm retry vô hạn). */
export const EVAL_HARNESS_V4_MAX_INFRA_RETRIES = 3 as const;

/** Gom các attempt của một task thành TaskResult (mean/best/worst/flaky). */
export function aggregateEvalHarnessV4Attempts(
  task: HarborTask,
  source: EvalHarnessV4TaskResult['source'],
  attempts: EvalHarnessV4Attempt[],
  retriesUsed = 0,
): EvalHarnessV4TaskResult {
  const passes = attempts.filter((a) => a.passed).length;
  const rewards = attempts.map((a) => a.reward);
  const meanReward = rewards.length > 0 ? rewards.reduce((a, b) => a + b, 0) / rewards.length : 0;
  const failing = new Set<string>();
  for (const attempt of attempts) {
    for (const test of attempt.perTest) {
      if (!test.passed) failing.add(test.name);
    }
  }
  return {
    taskId: task.meta.id,
    taskVersion: task.meta.version,
    taskName: task.meta.name,
    taskKind: task.meta.kind,
    source,
    attempts,
    passes,
    passed: passes > 0,
    allPassed: attempts.length > 0 && passes === attempts.length,
    flaky: passes > 0 && passes < attempts.length,
    meanReward,
    bestReward: rewards.length > 0 ? Math.max(...rewards) : 0,
    worstReward: rewards.length > 0 ? Math.min(...rewards) : 0,
    meanDurationMs: attempts.length > 0 ? attempts.reduce((sum, a) => sum + a.durationMs, 0) / attempts.length : 0,
    totalPromptTokens: attempts.reduce((sum, a) => sum + a.promptTokens, 0),
    totalCompletionTokens: attempts.reduce((sum, a) => sum + a.completionTokens, 0),
    failingTests: [...failing].sort(),
    retriesUsed,
  };
}

/** Chuyển một HarborRunResult thành một Attempt của V4. */
export function harborResultToEvalHarnessV4Attempt(
  result: HarborRunResult,
  attempt: number,
): EvalHarnessV4Attempt {
  return {
    attempt,
    rolloutId: result.rolloutId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    passed: result.passed,
    reward: result.reward,
    perTest: result.testRun.perTest.map((t) => ({ name: t.name, weight: t.weight, passed: t.passed })),
    isolation: result.isolation,
    testExitCode: result.testRun.exitCode,
    timedOut: result.testRun.timedOut || (result.error?.includes('timeout') ?? false),
    error: result.error,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
  };
}

/** Lỗi khi một lần chạy bị huỷ qua AbortSignal (phân biệt với lỗi task). */
export class EvalHarnessV4AbortError extends Error {
  constructor(message = 'Eval run đã bị huỷ (AbortSignal).') {
    super(message);
    this.name = 'EvalHarnessV4AbortError';
  }
}

/** True khi lỗi là do huỷ chạy (để CLI exit 130 thay vì báo lỗi run). */
export function isEvalHarnessV4AbortError(error: unknown): error is EvalHarnessV4AbortError {
  return error instanceof EvalHarnessV4AbortError;
}

/** Options khi chạy runner V4 (bổ sung cho config). */
export interface EvalHarnessV4RunnerOptions {
  /** Thư mục dữ liệu gốc (`<dataDir>` — chứa boxes + lịch sử V4). */
  baseDir: string;
  /** Executor chạy agent (bắt buộc để chạy task thật). */
  executor?: HarborAgentExecutor;
  /** Config V4 (mặc định = defaultEvalHarnessV4Config()). */
  config?: EvalHarnessV4Config;
  /** Ghi chú gắn vào run record (vd lý do chạy tay). */
  note?: string;
  /**
   * Signal huỷ chạy: runner kiểm tra GIỮA các attempt/task (không
   * ngắt giữa một attempt đang chạy — executor treo vẫn chờ timeout
   * của nó). Khi signal aborted, runner ném EvalHarnessV4AbortError
   * và dừng suite (không ghi lịch sử cho run dở dang).
   */
  signal?: AbortSignal;
  /**
   * Số vòng retry khi task lỗi hạ tầng (mặc định 0 = không retry).
   * Một vòng retry = chạy lại `repeats` attempt. Chỉ retry khi MỌI
   * attempt đều lỗi hạ tầng (executor error / timeout) — test fail
   * là kết quả thật, không retry. Tối đa 3 vòng.
   */
  maxInfraRetries?: number;
  /** Callback sau mỗi task (để CLI in tiến độ từng task). */
  onTaskDone?: (result: EvalHarnessV4TaskResult) => void;
  /** Callback sau mỗi attempt (để CLI in tiến độ chi tiết). */
  onAttemptDone?: (taskId: string, attempt: EvalHarnessV4Attempt) => void;
}

/** Kết quả đầy đủ của `runSuiteAndRecord` (record + hồi quy + dashboard). */
export interface EvalHarnessV4SuiteRun {
  record: EvalHarnessV4RunRecord;
  /** Đường dẫn file runs/<runId>.json đã ghi. */
  historyPath: string;
  /** Số run cũ đã prune khỏi lịch sử. */
  pruned: number;
  /** Báo cáo hồi quy so với baseline (null khi chưa có baseline). */
  regressionReport: EvalHarnessV4RegressionReport | null;
  /** Dashboard sau khi thêm run mới. */
  dashboard: EvalHarnessV4Dashboard;
  /** File dashboard đã render (theo config.output.formats). */
  dashboardPaths: string[];
  /** Exit code đề xuất cho CLI/CI (0 = pass/warn, 1 = block). */
  exitCode: number;
}

/**
 * Bọc executor bằng timeout: executor chạy quá `timeoutMs` thì
 * reject với lỗi timeout — HarborRunner bắt lỗi này thành
 * `result.error`, attempt ghi `timedOut: true`, suite không treo.
 * Executor gốc vẫn có thể chạy nền sau timeout (không kill được
 * từ đây — ghi rõ trong error để host biết mà dọn).
 */
export function withEvalHarnessV4Timeout(
  executor: HarborAgentExecutor,
  timeoutMs: number,
): HarborAgentExecutor {
  return async (ctx: HarborAgentContext) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Eval task "${ctx.task.meta.id}" timeout sau ${timeoutMs}ms (executor chưa trả về).`));
        }, timeoutMs);
        timer.unref?.();
      });
      return await Promise.race([executor(ctx), timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/** Runner suite V4: chạy Harbor task trong sandbox, lặp, gom, ghi sử. */
export class EvalHarnessV4Runner {
  private readonly baseDir: string;
  private readonly config: EvalHarnessV4Config;
  private readonly executor?: HarborAgentExecutor;
  private readonly note: string;
  private readonly signal?: AbortSignal;
  private readonly maxInfraRetries: number;
  private readonly onTaskDone?: (result: EvalHarnessV4TaskResult) => void;
  private readonly onAttemptDone?: (taskId: string, attempt: EvalHarnessV4Attempt) => void;

  constructor(options: EvalHarnessV4RunnerOptions) {
    this.baseDir = options.baseDir;
    this.config = options.config ?? defaultEvalHarnessV4Config();
    this.executor = options.executor;
    this.note = options.note ?? '';
    this.signal = options.signal;
    this.maxInfraRetries = Math.min(
      EVAL_HARNESS_V4_MAX_INFRA_RETRIES,
      Math.max(0, Math.floor(options.maxInfraRetries ?? 0)),
    );
    this.onTaskDone = options.onTaskDone;
    this.onAttemptDone = options.onAttemptDone;
  }

  /** Ném EvalHarnessV4AbortError khi signal đã aborted. */
  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw new EvalHarnessV4AbortError();
    }
  }

  /** Config đang dùng (để CLI/report in lại). */
  get resolvedConfig(): EvalHarnessV4Config {
    return this.config;
  }

  /** Thư mục lịch sử thực tế của runner này. */
  get historyDir(): string {
    return getEvalHarnessV4HistoryDir(this.baseDir, this.config.history.dir);
  }

  /**
   * Chạy một task `repeats` lần (tuần tự, mỗi lần một box mới),
   * cộng thêm tối đa `maxInfraRetries` vòng retry khi MỌI attempt
   * đều lỗi hạ tầng (executor error / timeout). Task validate fail
   * thì throw (caller phân biệt bằng HarborTaskError) — giống
   * HarborRunner.runTask.
   */
  async runTaskWithRepeats(
    task: HarborTask,
    options: {
      repeats?: number;
      source?: EvalHarnessV4TaskResult['source'];
      profileId?: string;
      systemPrompt?: string;
      model?: { provider: string; model: string };
    } = {},
  ): Promise<EvalHarnessV4TaskResult> {
    if (!this.executor) {
      throw new Error(
        'EvalHarnessV4Runner chưa có agent executor — host phải bind executor (vd executor chạy agent loop thật) trước khi chạy task.',
      );
    }
    const repeats = options.repeats ?? this.config.repeats;
    const source = options.source ?? 'builtin-v4';
    const taskTimeoutMs = this.config.taskTimeoutMs ?? task.meta.timeoutMs;
    const effectiveTask: HarborTask =
      this.config.taskTimeoutMs !== null
        ? { ...task, meta: { ...task.meta, timeoutMs: this.config.taskTimeoutMs } }
        : task;
    const timedExecutor = withEvalHarnessV4Timeout(this.executor, taskTimeoutMs);
    const harborRunner = new HarborRunner({
      baseDir: path.join(this.baseDir, 'eval-harness-v4', 'boxes'),
      executor: timedExecutor,
      testTimeoutMs: this.config.testTimeoutMs,
      keepBox: this.config.sandbox.keepWorkspace,
    });
    const profileId = options.profileId ?? this.config.profileId;
    const model = options.model ?? this.config.model;
    const attempts: EvalHarnessV4Attempt[] = [];
    let retriesUsed = 0;
    // Vòng chạy chính + tối đa maxInfraRetries vòng retry. Một vòng
    // retry chỉ chạy khi MỌI attempt của vòng trước đều lỗi hạ tầng
    // (error/timeout) — test fail là kết quả thật, không retry.
    for (let round = 0; round <= this.maxInfraRetries; round++) {
      const roundAttempts: EvalHarnessV4Attempt[] = [];
      for (let attempt = 1; attempt <= repeats; attempt++) {
        this.throwIfAborted();
        const result = await harborRunner.runTask(effectiveTask, {
          ...(profileId !== '' ? { profileId } : {}),
          ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
          ...(model !== null ? { model } : {}),
        });
        const attemptRecord = harborResultToEvalHarnessV4Attempt(result, attempts.length + roundAttempts.length + 1);
        roundAttempts.push(attemptRecord);
        this.onAttemptDone?.(task.meta.id, attemptRecord);
      }
      attempts.push(...roundAttempts);
      const infraFailed = roundAttempts.every((a) => a.error !== null || a.timedOut);
      if (!infraFailed || round === this.maxInfraRetries) break;
      retriesUsed += 1;
    }
    const taskResult = aggregateEvalHarnessV4Attempts(task, source, attempts, retriesUsed);
    this.onTaskDone?.(taskResult);
    return taskResult;
  }

  /**
   * Chạy một suite (tuần tự từng task) và trả về run record đầy
   * đủ — CHƯA ghi lịch sử (dùng `runSuiteAndRecord` để ghi).
   * Task lỗi setup (validate fail, thiếu executor) dừng cả suite
   * và throw; task fail test thì vẫn tiếp tục task sau.
   */
  async runSuite(
    tasks: readonly HarborTask[],
    options: {
      sources?: Map<string, EvalHarnessV4TaskResult['source']>;
      skipped?: { id: string; reason: string }[];
      profileId?: string;
      systemPrompt?: string;
      model?: { provider: string; model: string };
    } = {},
  ): Promise<EvalHarnessV4RunRecord> {
    const runId = buildEvalHarnessV4RunId();
    const startedAt = Date.now();
    const results: EvalHarnessV4TaskResult[] = [];
    for (const task of tasks) {
      this.throwIfAborted();
      const source = options.sources?.get(task.meta.id) ?? 'builtin-v4';
      results.push(
        await this.runTaskWithRepeats(task, {
          source,
          ...(options.profileId !== undefined ? { profileId: options.profileId } : {}),
          ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
        }),
      );
    }
    const finishedAt = Date.now();
    const passed = results.filter((r) => r.passed).length;
    const meanReward =
      results.length > 0 ? results.reduce((sum, r) => sum + r.meanReward, 0) / results.length : 0;
    const isolationModes = [...new Set(results.flatMap((r) => r.attempts.map((a) => a.isolation)))].sort();
    return {
      format: EVAL_HARNESS_V4_FORMAT,
      runId,
      configName: this.config.name,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      configSnapshot: this.config,
      tasks: results,
      skipped: options.skipped ?? [],
      passed,
      failed: results.length - passed,
      total: results.length,
      passRate: results.length > 0 ? passed / results.length : 0,
      meanReward,
      totalPromptTokens: results.reduce((sum, r) => sum + r.totalPromptTokens, 0),
      totalCompletionTokens: results.reduce((sum, r) => sum + r.totalCompletionTokens, 0),
      flakyTasks: results.filter((r) => r.flaky).length,
      isolationModes,
      note: this.note,
    };
  }

  /**
   * Chạy suite + ghi lịch sử + prune + so hồi quy + build/render
   * dashboard. Đây là entry point chính mà CLI gọi.
   */
  async runSuiteAndRecord(
    tasks: readonly HarborTask[],
    options: {
      sources?: Map<string, EvalHarnessV4TaskResult['source']>;
      skipped?: { id: string; reason: string }[];
      profileId?: string;
      systemPrompt?: string;
      model?: { provider: string; model: string };
    } = {},
  ): Promise<EvalHarnessV4SuiteRun> {
    const record = await this.runSuite(tasks, options);
    const historyDir = this.historyDir;
    const historyPath = appendEvalHarnessV4RunRecord(historyDir, record);
    const pruned = pruneEvalHarnessV4History(historyDir, {
      maxRuns: this.config.history.maxRuns,
      maxAgeDays: this.config.history.maxAgeDays,
    });
    const baseline = resolveEvalHarnessV4BaselineRun(historyDir, this.config.baselineRunId, record.runId);
    const regressionReport = baseline
      ? detectEvalHarnessV4Regressions(record, baseline, this.config.thresholds)
      : null;
    // Dashboard cần lịch sử SAU khi đã ghi run mới (kèm baseline đã resolve).
    const { records } = loadEvalHarnessV4History(historyDir);
    const dashboard = buildEvalHarnessV4Dashboard(records, {
      baseline: baseline ?? null,
      thresholds: this.config.thresholds,
    });
    const dashboardPaths = this.renderDashboardFiles(dashboard);
    const gate = regressionReport?.gate ?? 'pass';
    const exitCode = evalHarnessV4GateExitCode(gate, this.config.failOnRegression);
    return { record, historyPath, pruned: pruned.removed, regressionReport, dashboard, dashboardPaths, exitCode };
  }

  /** Render dashboard ra file theo config.output.formats. */
  renderDashboardFiles(dashboard: EvalHarnessV4Dashboard): string[] {
    const outputDir =
      this.config.output.dir !== ''
        ? path.isAbsolute(this.config.output.dir)
          ? this.config.output.dir
          : path.join(this.baseDir, this.config.output.dir)
        : path.join(this.historyDir, EVAL_HARNESS_V4_DASHBOARD_DIR);
    fs.mkdirSync(outputDir, { recursive: true });
    const stamp = dashboard.latestRunId ?? 'no-runs';
    const paths: string[] = [];
    for (const format of this.config.output.formats) {
      if (format === 'markdown') {
        const filePath = path.join(outputDir, `dashboard-${stamp}.md`);
        fs.writeFileSync(filePath, renderEvalHarnessV4DashboardMarkdown(dashboard), 'utf-8');
        paths.push(filePath);
      } else if (format === 'html') {
        const filePath = path.join(outputDir, `dashboard-${stamp}.html`);
        fs.writeFileSync(filePath, renderEvalHarnessV4DashboardHtml(dashboard), 'utf-8');
        paths.push(filePath);
      } else {
        const filePath = path.join(outputDir, `dashboard-${stamp}.json`);
        fs.writeFileSync(filePath, `${JSON.stringify(dashboard, null, 2)}\n`, 'utf-8');
        paths.push(filePath);
      }
    }
    return paths;
  }
}

/** Executor no-op của V4 (re-export để CLI dùng chung một import). */
export const noopEvalHarnessV4Executor = noopHarborExecutor;

/** Tóm tắt 1 dòng của một run record (CLI in sau khi chạy suite). */
export function formatEvalHarnessV4RunSummary(record: EvalHarnessV4RunRecord): string {
  return (
    `Eval v4 run ${record.runId}: ${record.passed}/${record.total} task pass ` +
    `(pass rate ${record.passRate.toFixed(2)}, mean reward ${record.meanReward.toFixed(2)}, ` +
    `${record.flakyTasks} flaky, ${record.durationMs}ms, isolation: ${record.isolationModes.join(', ') || 'none'}).`
  );
}
