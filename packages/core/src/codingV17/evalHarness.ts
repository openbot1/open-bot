/**
 * Coding agent v17 — eval harness mở rộng.
 *
 * Ý tưởng học từ OpenHands 1.x verification stack (survey v139 §4:
 * "tạo code đã rẻ, nút thắt giờ là kiểm chứng" — critic-guided
 * selection nâng SWE-bench 57.9% → 73.8%) và từ eval harness v2/v3
 * trong repo (container spec + guardrails): task container hoá,
 * oracle rõ ràng, test xác định, chấm patch TRƯỚC KHI trình.
 *
 * Thiết kế của open-bot (không copy repo khác):
 *
 * - V17EvalTask: startFiles dựng workspace task trong tmpdir riêng,
 *   setupCommand chạy 1 lần, tests là oracle (lệnh + chuỗi kỳ vọng +
 *   exit code kỳ vọng). protectedFiles: file oracle (vd test gốc)
 *   patch không được đổi — đổi là vi phạm, gate fail ngay.
 * - Deterministic: mỗi test chạy trong env đã khoá (PATH tối thiểu,
 *   không biến ngẫu nhiên, TZ=UTC, LANG=C), timeout riêng; chạy lại
 *   `determinismRuns` lần, pass/fail phải giống nhau mới gọi là
 *   deterministic — test flaky bị gắn cờ, không được trình.
 * - Executor chích được: mặc định spawn /bin/sh -c trong tmpdir;
 *   host có thể chích executor chạy trong box bwrap (xem
 *   sandboxExec.ts — coding agent v17 dùng executor đó để eval cũng
 *   chạy trong bwrap thật).
 * - Gate: gatePassed = mọi test pass + không vi phạm protected +
 *   đủ requiredFiles + deterministic. Patch chỉ được trình khi gate
 *   pass.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { CodingV17Error } from './types';
import type { V17EvalReport, V17EvalTask, V17EvalTest, V17TestResult } from './types';

/** Timeout mặc định cho một test (ms). */
export const V17_DEFAULT_EVAL_TEST_TIMEOUT_MS = 30_000;
/** Timeout mặc định cho setup (ms). */
export const V17_DEFAULT_EVAL_SETUP_TIMEOUT_MS = 120_000;
/** Số lần chạy lại mặc định để chứng minh tính xác định. */
export const V17_DEFAULT_DETERMINISM_RUNS = 2;
/** Giới hạn output giữ lại mỗi test (ký tự). */
export const V17_EVAL_MAX_OUTPUT_CHARS = 20_000;

/** Kết quả thô của một lần chạy lệnh (executor trả về). */
export interface V17CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Executor chạy lệnh trong một cwd (chích được để chạy trong bwrap). */
export type V17CommandExecutor = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<V17CommandResult>;

/** Validate một test trong oracle. */
export function v17ValidateEvalTest(test: V17EvalTest): V17EvalTest {
  if (!test || typeof test !== 'object') {
    throw new CodingV17Error('eval-invalid', 'test phải là object.');
  }
  if (typeof test.id !== 'string' || test.id.trim() === '') {
    throw new CodingV17Error('eval-invalid', 'test.id không được rỗng.');
  }
  if (typeof test.command !== 'string' || test.command.trim() === '') {
    throw new CodingV17Error('eval-invalid', `test ${test.id}: command không được rỗng.`);
  }
  if (test.expectExitCode !== undefined) {
    if (!Number.isInteger(test.expectExitCode) || (test.expectExitCode as number) < 0) {
      throw new CodingV17Error('eval-invalid', `test ${test.id}: expectExitCode phải là số nguyên >= 0.`);
    }
  }
  if (test.timeoutMs !== undefined && (test.timeoutMs <= 0 || !Number.isFinite(test.timeoutMs))) {
    throw new CodingV17Error('eval-invalid', `test ${test.id}: timeoutMs phải > 0.`);
  }
  return {
    id: test.id,
    command: test.command,
    ...(test.expectContains !== undefined ? { expectContains: test.expectContains } : {}),
    ...(test.expectNotContains !== undefined ? { expectNotContains: test.expectNotContains } : {}),
    ...(test.expectExitCode !== undefined ? { expectExitCode: test.expectExitCode } : {}),
    ...(test.timeoutMs !== undefined ? { timeoutMs: test.timeoutMs } : {}),
  };
}

/** Validate toàn bộ eval task (oracle rõ ràng, test xác định). */
export function v17ValidateEvalTask(task: V17EvalTask): V17EvalTask {
  if (!task || typeof task !== 'object') {
    throw new CodingV17Error('eval-invalid', 'eval task phải là object.');
  }
  if (typeof task.id !== 'string' || task.id.trim() === '') {
    throw new CodingV17Error('eval-invalid', 'task.id không được rỗng.');
  }
  if (typeof task.title !== 'string' || task.title.trim() === '') {
    throw new CodingV17Error('eval-invalid', 'task.title không được rỗng.');
  }
  if (!task.startFiles || typeof task.startFiles !== 'object' || Array.isArray(task.startFiles)) {
    throw new CodingV17Error('eval-invalid', 'task.startFiles phải là object path -> nội dung.');
  }
  for (const [filePath, content] of Object.entries(task.startFiles)) {
    if (typeof content !== 'string') {
      throw new CodingV17Error('eval-invalid', `startFiles[${filePath}] phải là string.`);
    }
    v17AssertSafeEvalPath(filePath);
  }
  if (!Array.isArray(task.tests) || task.tests.length === 0) {
    throw new CodingV17Error('eval-no-tests', 'task.tests phải có ít nhất 1 test.');
  }
  const ids = new Set<string>();
  const tests = task.tests.map((t) => {
    const checked = v17ValidateEvalTest(t);
    if (ids.has(checked.id)) {
      throw new CodingV17Error('eval-invalid', `test id trùng: ${checked.id}.`);
    }
    ids.add(checked.id);
    return checked;
  });
  const determinismRuns = task.determinismRuns ?? V17_DEFAULT_DETERMINISM_RUNS;
  if (!Number.isInteger(determinismRuns) || determinismRuns < 1) {
    throw new CodingV17Error('eval-invalid', 'determinismRuns phải là số nguyên >= 1.');
  }
  for (const filePath of [...(task.requiredFiles ?? []), ...(task.protectedFiles ?? [])]) {
    v17AssertSafeEvalPath(filePath);
  }
  return {
    id: task.id,
    title: task.title,
    startFiles: { ...task.startFiles },
    ...(task.setupCommand !== undefined ? { setupCommand: task.setupCommand } : {}),
    tests,
    ...(task.requiredFiles !== undefined ? { requiredFiles: [...task.requiredFiles] } : {}),
    ...(task.protectedFiles !== undefined ? { protectedFiles: [...task.protectedFiles] } : {}),
    determinismRuns,
  };
}

/** Path trong eval workspace: tương đối, không thoát ra ngoài. */
export function v17AssertSafeEvalPath(filePath: string): void {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new CodingV17Error('eval-invalid', 'path trong eval task không được rỗng.');
  }
  if (path.isAbsolute(filePath) || filePath.split('/').includes('..')) {
    throw new CodingV17Error('eval-invalid', `path không an toàn trong eval workspace: ${filePath}.`);
  }
}

/** Ghi một tập file vào thư mục (tạo thư mục cha khi cần). */
export function v17WriteEvalFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [filePath, content] of Object.entries(files)) {
    v17AssertSafeEvalPath(filePath);
    const target = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
}

/** Executor mặc định: spawn /bin/sh -c trong cwd, env đã khoá. */
export function v17DefaultCommandExecutor(): V17CommandExecutor {
  return (command, cwd, timeoutMs) =>
    new Promise<V17CommandResult>((resolve) => {
      const startedAt = Date.now();
      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: os.homedir(),
          TZ: 'UTC',
          LANG: 'C',
          LC_ALL: 'C',
          NO_COLOR: '1',
        },
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < V17_EVAL_MAX_OUTPUT_CHARS) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < V17_EVAL_MAX_OUTPUT_CHARS) stderr += chunk.toString('utf8');
      });
      child.on('error', () => {
        resolve({
          exitCode: null,
          stdout: stdout.slice(0, V17_EVAL_MAX_OUTPUT_CHARS),
          stderr: stderr.slice(0, V17_EVAL_MAX_OUTPUT_CHARS),
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
      child.on('close', (code, signal) => {
        if (signal === 'SIGKILL' && Date.now() - startedAt >= timeoutMs) timedOut = true;
        resolve({
          exitCode: code,
          stdout: stdout.slice(0, V17_EVAL_MAX_OUTPUT_CHARS),
          stderr: stderr.slice(0, V17_EVAL_MAX_OUTPUT_CHARS),
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
}

/** Chấm một kết quả chạy lệnh theo oracle của test. */
export function v17ScoreTestResult(test: V17EvalTest, result: V17CommandResult): V17TestResult {
  const expectedExit = test.expectExitCode ?? 0;
  const combined = `${result.stdout}\n${result.stderr}`;
  let reason: string | undefined;
  if (result.timedOut) {
    reason = `timeout sau ${test.timeoutMs ?? V17_DEFAULT_EVAL_TEST_TIMEOUT_MS}ms.`;
  } else if (result.exitCode !== expectedExit) {
    reason = `exit code ${String(result.exitCode)} (kỳ vọng ${expectedExit}).`;
  } else if (test.expectContains !== undefined && !combined.includes(test.expectContains)) {
    reason = `output thiếu chuỗi kỳ vọng: ${JSON.stringify(test.expectContains)}.`;
  } else if (test.expectNotContains !== undefined && combined.includes(test.expectNotContains)) {
    reason = `output chứa chuỗi cấm: ${JSON.stringify(test.expectNotContains)}.`;
  }
  return {
    testId: test.id,
    passed: reason === undefined,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** So sánh 2 lần chạy: pass/fail từng test có giống nhau không. */
export function v17RunsAgree(first: readonly V17TestResult[], second: readonly V17TestResult[]): boolean {
  if (first.length !== second.length) return false;
  for (let i = 0; i < first.length; i += 1) {
    const a = first[i] as V17TestResult;
    const b = second[i] as V17TestResult;
    if (a.testId !== b.testId || a.passed !== b.passed) return false;
  }
  return true;
}

/**
 * Chạy một eval task trên một patch (patchFiles: path -> nội dung mới;
 * patch không liệt kê file start nào thì file đó giữ nguyên).
 *
 * - Dựng workspace task trong tmpdir riêng (xoá sau khi chạy).
 * - Áp patch, kiểm tra protectedFiles (so với startFiles) + requiredFiles.
 * - Chạy setup (nếu có), rồi chạy từng test; chạy lại determinismRuns
 *   lần để chứng minh tính xác định (chỉ lần đầu tính vào report).
 * - executor: mặc định local; host nên chích executor bwrap để task
 *   chạy trong box (xem sandboxExec.ts).
 */
export async function v17RunEvalTask(
  taskInput: V17EvalTask,
  patchFiles: Readonly<Record<string, string>>,
  options: {
    executor?: V17CommandExecutor;
    keepWorkspace?: boolean;
    isolation?: string;
  } = {},
): Promise<V17EvalReport> {
  const task = v17ValidateEvalTask(taskInput);
  const executor = options.executor ?? v17DefaultCommandExecutor();
  const startedAt = Date.now();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `open-bot-v17-eval-${task.id}-`));
  try {
    v17WriteEvalFiles(workspace, task.startFiles);
    // Áp patch (file mới/ghi đè; không xoá file start trừ khi patch ghi
    // nội dung rỗng kèm marker — ở đây patch chỉ ghi đè/thêm, xoá file
    // thực hiện bằng cách không liệt kê? Không: xoá cần tường minh nên
    // patchFiles dùng giá trị null? Giữ đơn giản: patch chỉ ghi/thêm.)
    for (const [filePath, content] of Object.entries(patchFiles)) {
      if (typeof content !== 'string') {
        throw new CodingV17Error('eval-invalid', `patchFiles[${filePath}] phải là string.`);
      }
      v17AssertSafeEvalPath(filePath);
    }
    v17WriteEvalFiles(workspace, patchFiles);
    // Oracle bảo vệ: protectedFiles không được đổi so với startFiles.
    const protectedViolations: string[] = [];
    for (const protectedFile of task.protectedFiles ?? []) {
      const original = task.startFiles[protectedFile];
      const currentPath = path.join(workspace, protectedFile);
      const current = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : undefined;
      if (original === undefined) {
        if (current !== undefined) protectedViolations.push(protectedFile);
      } else if (current !== original) {
        protectedViolations.push(protectedFile);
      }
    }
    // Required files phải tồn tại sau patch.
    const missingRequiredFiles: string[] = [];
    for (const required of task.requiredFiles ?? []) {
      if (!fs.existsSync(path.join(workspace, required))) missingRequiredFiles.push(required);
    }
    // Setup (chạy 1 lần, lỗi setup → mọi test được tính fail với lý do setup).
    let setupFailedReason: string | undefined;
    if (task.setupCommand) {
      const setup = await executor(
        task.setupCommand,
        workspace,
        V17_DEFAULT_EVAL_SETUP_TIMEOUT_MS,
      );
      if (setup.timedOut) setupFailedReason = 'setup timeout.';
      else if (setup.exitCode !== 0) {
        setupFailedReason = `setup fail (exit ${String(setup.exitCode)}): ${setup.stderr.slice(0, 500)}`;
      }
    }
    const runOnce = async (): Promise<V17TestResult[]> => {
      const results: V17TestResult[] = [];
      for (const test of task.tests) {
        if (setupFailedReason) {
          results.push({
            testId: test.id,
            passed: false,
            exitCode: null,
            stdout: '',
            stderr: '',
            durationMs: 0,
            timedOut: false,
            reason: setupFailedReason,
          });
          continue;
        }
        const raw = await executor(test.command, workspace, test.timeoutMs ?? V17_DEFAULT_EVAL_TEST_TIMEOUT_MS);
        results.push(v17ScoreTestResult(test, raw));
      }
      return results;
    };
    const firstRun = await runOnce();
    let deterministic = true;
    for (let run = 1; run < (task.determinismRuns ?? V17_DEFAULT_DETERMINISM_RUNS); run += 1) {
      const nextRun = await runOnce();
      if (!v17RunsAgree(firstRun, nextRun)) deterministic = false;
    }
    const passed = firstRun.filter((r) => r.passed).length;
    const failed = firstRun.length - passed;
    const gatePassed =
      failed === 0 &&
      protectedViolations.length === 0 &&
      missingRequiredFiles.length === 0 &&
      deterministic;
    return {
      taskId: task.id,
      patchFiles: Object.keys(patchFiles).sort(),
      results: firstRun,
      passed,
      failed,
      gatePassed,
      protectedViolations,
      missingRequiredFiles,
      deterministic,
      durationMs: Date.now() - startedAt,
      isolation: options.isolation ?? 'local-default-executor',
    };
  } finally {
    if (!options.keepWorkspace) {
      try {
        fs.rmSync(workspace, { recursive: true, force: true });
      } catch {
        // Dọn tmpdir lỗi thì bỏ qua (không hỏng report).
      }
    }
  }
}

/** Render eval report thành text. */
export function renderV17EvalReport(report: V17EvalReport): string {
  const lines = [
    `Eval ${report.taskId}: ${report.passed}/${report.passed + report.failed} test pass — gate ${report.gatePassed ? 'PASS' : 'FAIL'}.`,
    `Deterministic: ${report.deterministic ? 'yes' : 'NO (flaky — chạy lại cho kết quả khác)'}.`,
    `Isolation: ${report.isolation}. Thời gian: ${report.durationMs}ms.`,
  ];
  for (const result of report.results) {
    lines.push(
      `  ${result.passed ? 'PASS' : 'FAIL'} ${result.testId} (${result.durationMs}ms)${result.reason ? ` — ${result.reason}` : ''}`,
    );
  }
  if (report.protectedViolations.length > 0) {
    lines.push(`  Protected vi phạm: ${report.protectedViolations.join(', ')}.`);
  }
  if (report.missingRequiredFiles.length > 0) {
    lines.push(`  Required thiếu: ${report.missingRequiredFiles.join(', ')}.`);
  }
  return lines.join('\n');
}

/** Kết quả chạy một suite nhiều eval task trên cùng một patch. */
export interface V17EvalSuiteReport {
  /** Tên suite. */
  suiteId: string;
  /** Report từng task (theo thứ tự chạy). */
  reports: V17EvalReport[];
  /** Số task pass gate / tổng task. */
  tasksPassed: number;
  tasksTotal: number;
  /** Tổng test pass / tổng test. */
  testsPassed: number;
  testsTotal: number;
  /** true khi MỌI task đều pass gate. */
  suitePassed: boolean;
  /** Task nào fail gate. */
  failingTasks: string[];
  /** true khi mọi task đều deterministic. */
  allDeterministic: boolean;
  /** Tổng thời gian chạy suite (ms). */
  durationMs: number;
}

/**
 * Chạy một suite nhiều eval task trên cùng một patch (mỗi task có
 * workspace tmpdir riêng, chạy tuần tự để không tranh tài nguyên —
 * máy 1,5 CPU không chạy song song eval).
 * Trả aggregate report; suite chỉ pass khi mọi task pass gate.
 */
export async function v17RunEvalSuite(
  suiteId: string,
  tasks: readonly V17EvalTask[],
  patchFiles: Readonly<Record<string, string>>,
  options: {
    executor?: V17CommandExecutor;
    isolation?: string;
  } = {},
): Promise<V17EvalSuiteReport> {
  if (suiteId.trim() === '') {
    throw new CodingV17Error('eval-invalid', 'suiteId không được rỗng.');
  }
  if (tasks.length === 0) {
    throw new CodingV17Error('eval-no-tests', 'suite cần ít nhất 1 task.');
  }
  const startedAt = Date.now();
  const reports: V17EvalReport[] = [];
  for (const task of tasks) {
    reports.push(await v17RunEvalTask(task, patchFiles, options));
  }
  const tasksPassed = reports.filter((r) => r.gatePassed).length;
  const testsPassed = reports.reduce((a, r) => a + r.passed, 0);
  const testsTotal = reports.reduce((a, r) => a + r.passed + r.failed, 0);
  const failingTasks = reports.filter((r) => !r.gatePassed).map((r) => r.taskId);
  return {
    suiteId,
    reports,
    tasksPassed,
    tasksTotal: reports.length,
    testsPassed,
    testsTotal,
    suitePassed: tasksPassed === reports.length,
    failingTasks,
    allDeterministic: reports.every((r) => r.deterministic),
    durationMs: Date.now() - startedAt,
  };
}

/** Render eval suite report thành text. */
export function renderV17EvalSuiteReport(suite: V17EvalSuiteReport): string {
  const lines = [
    `Eval suite ${suite.suiteId}: ${suite.tasksPassed}/${suite.tasksTotal} tasks pass gate, ${suite.testsPassed}/${suite.testsTotal} tests pass — suite ${suite.suitePassed ? 'PASS' : 'FAIL'}.`,
    `Deterministic mọi task: ${suite.allDeterministic ? 'yes' : 'NO (có task flaky)'}. Thời gian: ${suite.durationMs}ms.`,
  ];
  for (const report of suite.reports) {
    lines.push(
      `  ${report.gatePassed ? 'PASS' : 'FAIL'} ${report.taskId}: ${report.passed}/${report.passed + report.failed} tests${report.deterministic ? '' : ' (NON-DETERMINISTIC)'}.`,
    );
  }
  if (suite.failingTasks.length > 0) {
    lines.push(`  Task fail gate: ${suite.failingTasks.join(', ')}.`);
  }
  return lines.join('\n');
}
