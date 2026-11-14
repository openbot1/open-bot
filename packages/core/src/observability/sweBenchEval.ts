/**
 * SWE-bench-style local eval (v1.04, Team T6).
 *
 * Eval kiểu SWE-bench thu nhỏ, chạy trên repo local của user:
 *
 * - Mỗi task = problem statement + file setup + hai nhóm test chạy
 *   bằng LỆNH THẬT trong một workspace tạm:
 *   - `failToPass`: phải FAIL trước khi solver chạy và PASS sau khi
 *     solver chạy — chứng minh bug đã được sửa;
 *   - `passToPass`: phải PASS cả trước và sau — chống hồi quy.
 * - Task chỉ tính là `resolved` khi patch (thay đổi của solver) áp
 *   dụng được VÀ cả hai nhóm đều pass hết. Không có điểm từng phần.
 * - **Baseline check bắt buộc**: fail-to-pass được chạy TRƯỚC khi
 *   solver chạy. Nếu đã pass sẵn từ đầu thì task vô giá trị
 *   (`invalid-baseline`) — bị loại khỏi aggregate, không được tính
 *   là resolved.
 * - Solver là callback do caller cung cấp
 *   `(workspaceDir, task) => Promise<void>` — harness đo loop/harness
 *   của caller, không nhúng model cụ thể nào. Caller có thể nối
 *   solver thật (agent chạy model) hoặc solver scripted trong test.
 * - Chấm bằng chạy lệnh, KHÔNG chấm bằng LLM-as-judge, KHÔNG so
 *   sánh patch với đáp án mẫu.
 *
 * An toàn: mọi lệnh chạy trong thư mục tạm riêng của task (dưới
 * `os.tmpdir()` hoặc `workspacesDir` do caller chỉ định), có timeout
 * riêng cho từng lệnh và cho cả task; workspace tạm bị xóa sau khi
 * chạy trừ khi `keepWorkspaces: true`. Harness KHÔNG tự chạy lệnh
 * ngoài workspace tạm, KHÔNG chạm repo thật của user.
 *
 * Module này khác `coding/eval.ts` (v1.02): coding eval chạy scripted
 * reasoner của coding agent trong Workspace abstraction; module này
 * chạy LỆNH THẬT (test command) theo đúng phương pháp SWE-bench với
 * fail-to-pass/pass-to-pass + baseline check, solver là callback tự
 * do. Khác `observability/evalHarness.ts` (v1.03): evalHarness chấm
 * RECORDING đã ghi; module này CHẠY task thật rồi chấm kết quả chạy.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

/** Một lệnh test: chạy trong workspace tạm, chấm theo exit code. */
export interface SweTestCommand {
  /** Tên hiển thị (vd 'test-add'). */
  name: string;
  /** Lệnh + tham số (vd ['node', 'test.js']). */
  argv: string[];
  /** Exit code được coi là pass (mặc định 0). */
  expectExitCode?: number;
}

/** Một task eval kiểu SWE-bench (repo local). */
export interface SweBenchTask {
  /** Id ổn định (vd 'swe-add-001'). */
  id: string;
  title: string;
  /** Mô tả vấn đề đưa cho solver (issue text). */
  problemStatement: string;
  /** File tạo trong workspace trước khi chạy (đường dẫn tương đối → nội dung). */
  setupFiles?: Record<string, string>;
  /** Test phải fail trước, pass sau. */
  failToPass: SweTestCommand[];
  /** Test phải pass cả trước và sau. */
  passToPass: SweTestCommand[];
  /** Timeout cho từng lệnh test (ms, mặc định 30_000). */
  testTimeoutMs?: number;
  /** Timeout cho solver (ms, mặc định 120_000). */
  solverTimeoutMs?: number;
}

/** Kết quả chạy một lệnh test. */
export interface SweTestResult {
  name: string;
  argv: string[];
  passed: boolean;
  exitCode: number | null;
  /** True khi lệnh bị timeout (không tính là pass dù expectExitCode khớp). */
  timedOut: boolean;
  /** stdout/stderr gộp, cắt ngắn để report không phình. */
  output: string;
  durationMs: number;
}

/** Trạng thái cuối của một task. */
export type SweTaskStatus =
  | 'resolved'
  | 'not-resolved'
  | 'invalid-baseline'
  | 'solver-error'
  | 'solver-timeout';

/** Kết quả một task. */
export interface SweTaskResult {
  taskId: string;
  title: string;
  status: SweTaskStatus;
  /** True khi resolved (cả hai nhóm pass sau solver). */
  resolved: boolean;
  /** Kết quả fail-to-pass TRƯỚC khi solver chạy (baseline). */
  baselineFailToPass: SweTestResult[];
  /** Kết quả pass-to-pass TRƯỚC khi solver chạy (baseline). */
  baselinePassToPass: SweTestResult[];
  /** Kết quả fail-to-pass SAU khi solver chạy. */
  finalFailToPass: SweTestResult[];
  /** Kết quả pass-to-pass SAU khi solver chạy. */
  finalPassToPass: SweTestResult[];
  /** Lỗi của solver (nếu có). */
  solverError?: string;
  durationMs: number;
  /** Thư mục workspace tạm (chỉ còn khi keepWorkspaces). */
  workspaceDir?: string;
}

/** Báo cáo toàn bộ eval. */
export interface SweBenchReport {
  generatedAt: string;
  totalTasks: number;
  /** Task có baseline hợp lệ (đủ điều kiện tính điểm). */
  validTasks: number;
  resolvedTasks: number;
  /** % resolved trên task hợp lệ (null khi không có task hợp lệ). */
  resolveRate: number | null;
  invalidBaselineTasks: number;
  solverErrorTasks: number;
  tasks: SweTaskResult[];
  totalDurationMs: number;
}

/** Solver: nhận workspaceDir + task, tự sửa file trong workspace đó. */
export type SweSolver = (workspaceDir: string, task: SweBenchTask) => Promise<void>;

export interface SweRunnerOptions {
  /** Thư mục cha cho workspace tạm (mặc định os.tmpdir()). */
  workspacesDir?: string;
  /** Giữ workspace tạm sau khi chạy (mặc định false — xóa). */
  keepWorkspaces?: boolean;
  /** Timeout mặc định cho từng lệnh test (ms). */
  defaultTestTimeoutMs?: number;
  /** Timeout mặc định cho solver (ms). */
  defaultSolverTimeoutMs?: number;
}

export const DEFAULT_SWE_TEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SWE_SOLVER_TIMEOUT_MS = 120_000;
/** Giới hạn output mỗi lệnh test lưu trong report (ký tự). */
export const SWE_OUTPUT_LIMIT = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate một lệnh test (throw khi sai). */
export function validateSweTestCommand(raw: unknown): SweTestCommand {
  if (!isRecord(raw)) throw new Error('swe test command must be an object.');
  const { name, argv, expectExitCode } = raw;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('swe test command needs a non-empty name.');
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string' || a.length === 0)) {
    throw new Error(`swe test command "${name}" needs a non-empty argv of strings.`);
  }
  if (expectExitCode !== undefined && (!Number.isInteger(expectExitCode) || (expectExitCode as number) < 0 || (expectExitCode as number) > 255)) {
    throw new Error(`swe test command "${name}" expectExitCode must be an integer between 0 and 255.`);
  }
  return { name: name.trim(), argv: argv as string[], ...(expectExitCode !== undefined ? { expectExitCode: expectExitCode as number } : {}) };
}

/** Validate một task eval (throw khi sai). */
export function validateSweBenchTask(raw: unknown): SweBenchTask {
  if (!isRecord(raw)) throw new Error('swe-bench task must be an object.');
  const { id, title, problemStatement, setupFiles, failToPass, passToPass, testTimeoutMs, solverTimeoutMs } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error('swe-bench task needs a non-empty id.');
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('swe-bench task needs a non-empty title.');
  if (typeof problemStatement !== 'string' || problemStatement.trim().length === 0) {
    throw new Error('swe-bench task needs a non-empty problemStatement.');
  }
  if (!Array.isArray(failToPass) || failToPass.length === 0) {
    throw new Error(`swe-bench task "${id}" needs at least one failToPass test (otherwise it proves nothing).`);
  }
  if (!Array.isArray(passToPass)) throw new Error(`swe-bench task "${id}" passToPass must be an array.`);
  if (setupFiles !== undefined) {
    if (!isRecord(setupFiles)) throw new Error(`swe-bench task "${id}" setupFiles must be an object.`);
    for (const [rel, content] of Object.entries(setupFiles)) {
      if (typeof content !== 'string') throw new Error(`swe-bench task "${id}" setup file "${rel}" must be a string.`);
      if (rel.includes('..') || path.isAbsolute(rel)) {
        throw new Error(`swe-bench task "${id}" setup file "${rel}" must be a relative path inside the workspace.`);
      }
    }
  }
  if (testTimeoutMs !== undefined && (!Number.isInteger(testTimeoutMs) || (testTimeoutMs as number) <= 0)) {
    throw new Error('swe-bench task testTimeoutMs must be a positive integer.');
  }
  if (solverTimeoutMs !== undefined && (!Number.isInteger(solverTimeoutMs) || (solverTimeoutMs as number) <= 0)) {
    throw new Error('swe-bench task solverTimeoutMs must be a positive integer.');
  }
  return {
    id: id.trim(),
    title: title.trim(),
    problemStatement,
    ...(setupFiles !== undefined ? { setupFiles: setupFiles as Record<string, string> } : {}),
    failToPass: (failToPass as unknown[]).map(validateSweTestCommand),
    passToPass: (passToPass as unknown[]).map(validateSweTestCommand),
    ...(testTimeoutMs !== undefined ? { testTimeoutMs: testTimeoutMs as number } : {}),
    ...(solverTimeoutMs !== undefined ? { solverTimeoutMs: solverTimeoutMs as number } : {}),
  };
}

/** Chạy một lệnh trong cwd, có timeout. Không dùng shell (tránh injection). */
export function runTestCommand(cmd: SweTestCommand, cwd: string, timeoutMs: number): Promise<SweTestResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const expected = cmd.expectExitCode ?? 0;
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, output: string): void => {
      if (settled) return;
      settled = true;
      resolve({
        name: cmd.name,
        argv: cmd.argv,
        passed: !timedOut && exitCode === expected,
        exitCode,
        timedOut,
        output: output.length > SWE_OUTPUT_LIMIT ? `${output.slice(0, SWE_OUTPUT_LIMIT)}\n…(output truncated)` : output,
        durationMs: Date.now() - started,
      });
    };
    let child;
    try {
      child = spawn(cmd.argv[0], cmd.argv.slice(1), { cwd, shell: false, timeout: timeoutMs });
    } catch (err) {
      finish(null, `failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.stderr?.on('data', (d: Buffer) => chunks.push(d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Process đã thoát — bỏ qua.
      }
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (err) => {
      clearTimeout(timer);
      finish(null, `failed to spawn: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code, Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** Chạy một nhóm test tuần tự trong cwd. */
export async function runTestGroup(
  commands: SweTestCommand[],
  cwd: string,
  timeoutMs: number,
): Promise<SweTestResult[]> {
  const results: SweTestResult[] = [];
  for (const cmd of commands) {
    results.push(await runTestCommand(cmd, cwd, timeoutMs));
  }
  return results;
}

function allPassed(results: SweTestResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed);
}

function anyFailed(results: SweTestResult[]): boolean {
  return results.some((r) => !r.passed);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function createWorkspace(task: SweBenchTask, parentDir: string): string {
  const dir = fs.mkdtempSync(path.join(parentDir, `open-bot-swe-${task.id}-`));
  for (const [rel, content] of Object.entries(task.setupFiles ?? {})) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return dir;
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Dọn dẹp thất bại — để lại thư mục tạm, không làm fail eval.
  }
}

/**
 * Chạy một task: setup workspace → baseline (cả hai nhóm) → solver →
 * final (cả hai nhóm) → chấm resolved.
 */
export async function runSweBenchTask(
  rawTask: unknown,
  solver: SweSolver,
  options: SweRunnerOptions = {},
): Promise<SweTaskResult> {
  const task = validateSweBenchTask(rawTask);
  const started = Date.now();
  const testTimeout = task.testTimeoutMs ?? options.defaultTestTimeoutMs ?? DEFAULT_SWE_TEST_TIMEOUT_MS;
  const solverTimeout = task.solverTimeoutMs ?? options.defaultSolverTimeoutMs ?? DEFAULT_SWE_SOLVER_TIMEOUT_MS;
  const parentDir = options.workspacesDir ?? os.tmpdir();
  fs.mkdirSync(parentDir, { recursive: true });
  const workspaceDir = createWorkspace(task, parentDir);
  const keep = options.keepWorkspaces === true;
  try {
    const baselineFailToPass = await runTestGroup(task.failToPass, workspaceDir, testTimeout);
    const baselinePassToPass = await runTestGroup(task.passToPass, workspaceDir, testTimeout);
    // Baseline check: fail-to-pass phải fail ít nhất một test trước khi
    // solver chạy, và pass-to-pass phải pass hết. Nếu không, task vô
    // giá trị — không tính điểm, không chạy solver.
    const baselineValid = anyFailed(baselineFailToPass) && (task.passToPass.length === 0 || allPassed(baselinePassToPass));
    if (!baselineValid) {
      return {
        taskId: task.id,
        title: task.title,
        status: 'invalid-baseline',
        resolved: false,
        baselineFailToPass,
        baselinePassToPass,
        finalFailToPass: [],
        finalPassToPass: [],
        solverError: 'baseline invalid: fail-to-pass already passes, or pass-to-pass already fails before the solver runs.',
        durationMs: Date.now() - started,
        ...(keep ? { workspaceDir } : {}),
      };
    }
    try {
      await withTimeout(solver(workspaceDir, task), solverTimeout, 'solver');
    } catch (err) {
      const timedOut = err instanceof Error && /timed out/.test(err.message);
      return {
        taskId: task.id,
        title: task.title,
        status: timedOut ? 'solver-timeout' : 'solver-error',
        resolved: false,
        baselineFailToPass,
        baselinePassToPass,
        finalFailToPass: [],
        finalPassToPass: [],
        solverError: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
        ...(keep ? { workspaceDir } : {}),
      };
    }
    const finalFailToPass = await runTestGroup(task.failToPass, workspaceDir, testTimeout);
    const finalPassToPass = await runTestGroup(task.passToPass, workspaceDir, testTimeout);
    const resolved = allPassed(finalFailToPass) && (task.passToPass.length === 0 || allPassed(finalPassToPass));
    return {
      taskId: task.id,
      title: task.title,
      status: resolved ? 'resolved' : 'not-resolved',
      resolved,
      baselineFailToPass,
      baselinePassToPass,
      finalFailToPass,
      finalPassToPass,
      durationMs: Date.now() - started,
      ...(keep ? { workspaceDir } : {}),
    };
  } finally {
    if (!keep) removeDir(workspaceDir);
  }
}

/** Chạy nhiều task tuần tự, tổng hợp report. */
export async function runSweBenchSuite(
  tasks: unknown[],
  solver: SweSolver,
  options: SweRunnerOptions = {},
): Promise<SweBenchReport> {
  const started = Date.now();
  const results: SweTaskResult[] = [];
  for (const task of tasks) {
    results.push(await runSweBenchTask(task, solver, options));
  }
  const valid = results.filter((r) => r.status === 'resolved' || r.status === 'not-resolved');
  const resolved = valid.filter((r) => r.resolved).length;
  return {
    generatedAt: new Date().toISOString(),
    totalTasks: results.length,
    validTasks: valid.length,
    resolvedTasks: resolved,
    resolveRate: valid.length === 0 ? null : resolved / valid.length,
    invalidBaselineTasks: results.filter((r) => r.status === 'invalid-baseline').length,
    solverErrorTasks: results.filter((r) => r.status === 'solver-error' || r.status === 'solver-timeout').length,
    tasks: results,
    totalDurationMs: Date.now() - started,
  };
}

/** Render report thành Markdown (đọc được, không cần tool). */
export function sweBenchReportToMarkdown(report: SweBenchReport): string {
  const lines: string[] = [];
  lines.push('# SWE-bench-style eval report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Tasks: ${report.totalTasks} (valid ${report.validTasks}, invalid baseline ${report.invalidBaselineTasks}, solver errors ${report.solverErrorTasks})`);
  lines.push(
    `Resolved: ${report.resolvedTasks}/${report.validTasks}` +
      (report.resolveRate === null ? '' : ` (${(report.resolveRate * 100).toFixed(1)}%)`),
  );
  lines.push(`Total duration: ${(report.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('| Task | Status | Fail-to-pass (final) | Pass-to-pass (final) | Duration |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const task of report.tasks) {
    const ftp = task.finalFailToPass.length === 0 ? '—' : `${task.finalFailToPass.filter((r) => r.passed).length}/${task.finalFailToPass.length} pass`;
    const ptp = task.finalPassToPass.length === 0 ? '—' : `${task.finalPassToPass.filter((r) => r.passed).length}/${task.finalPassToPass.length} pass`;
    lines.push(`| ${task.taskId} | ${task.status} | ${ftp} | ${ptp} | ${(task.durationMs / 1000).toFixed(1)}s |`);
  }
  lines.push('');
  for (const task of report.tasks) {
    if (task.status === 'resolved') continue;
    lines.push(`## ${task.taskId} — ${task.status}`);
    lines.push('');
    if (task.solverError) lines.push(`Solver error: ${task.solverError}`);
    for (const result of [...task.finalFailToPass, ...task.finalPassToPass]) {
      lines.push(`- ${result.passed ? 'PASS' : 'FAIL'} ${result.name} (exit ${result.exitCode ?? 'n/a'}${result.timedOut ? ', timed out' : ''})`);
      if (!result.passed && result.output.trim().length > 0) {
        lines.push('  ```');
        lines.push(`  ${result.output.trim().split('\n').slice(0, 10).join('\n  ')}`);
        lines.push('  ```');
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Lưu report thành JSON (ghi đè atomic, mode 0600). */
export function saveSweBenchReport(report: SweBenchReport, filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  return filePath;
}
