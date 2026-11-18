/**
 * Coding agent v11 — eval harness v2 (kiểu SWE-bench, có trọng số).
 *
 * Nối eval harness v9 (task mẫu + pass@k + lưu/so sánh lần chạy)
 * và eval theo phiên bản của v10: v2 thêm 3 thứ mà v9/v10 chưa có:
 *
 *   1. Partial credit: mỗi test có TRỌNG SỐ + loại fail-to-pass /
 *      pass-to-pass — task không chỉ pass/fail mà còn có điểm
 *      0..1 (tổng weight test pass / tổng weight), để thấy agent
 *      "gần đúng" tới đâu thay vì chỉ biết đúng/sai.
 *   2. Flaky detection: chạy lặp toàn bộ task một lần nữa và so
 *      sánh kết quả — task đổi trạng thái pass giữa 2 lần chạy thì
 *      đánh dấu `flaky` (test không ổn định, không phải agent giỏi
 *      hay dở) thay vì tin mù một lần chạy.
 *   3. Baseline regression: so sánh với báo cáo baseline (phiên
 *      bản trước) và liệt kê rõ `regressions` (task từng pass nay
 *      fail) vs `improvements` — phiên bản mới không được thụt lùi
 *      trong im lặng.
 *
 * Chạy task: tạo repo tạm bằng git thật (init + commit fixture),
 * apply patch agent nộp bằng `git apply`, chạy từng test bằng argv
 * (không shell), chấm theo exit code từng test — kế thừa quy tắc
 * chấm của v5/v9, không chấm theo nội dung output. Không gọi model
 * thật, không gọi mạng; agent mẫu scripted sửa đúng 2/3 task để
 * demo pass@k < 100% (như v9/v10).
 *
 * Giới hạn trung thực: repo tạm dùng git thật nên cần `git` trên
 * PATH; không phải Docker sandbox thật — chỉ dùng task tự viết/tin
 * cậy. Token agent không báo thì ước lượng chars/4 và đánh dấu
 * `tokensEstimated: true`.
 */

import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runV9Git, runV9GitOrThrow } from '../codingV9/gitAtomic';
import { CodingV11Error } from './types';
import type {
  V11EvalAgentAttempt,
  V11EvalAttemptResult,
  V11EvalComparison,
  V11EvalReport,
  V11EvalTask,
  V11EvalTaskSummary,
  V11EvalTestResult,
} from './types';

/** Số attempt mặc định mỗi task (k của pass@k). */
export const V11_EVAL_DEFAULT_ATTEMPTS = 3;
/** Số attempt tối đa mỗi task. */
export const V11_EVAL_MAX_ATTEMPTS = 10;
/** Số task tối đa mỗi suite. */
export const V11_EVAL_MAX_TASKS_PER_SUITE = 100;
/** Số ký tự output test giữ lại trong report khi fail. */
export const V11_EVAL_FAILURE_EXCERPT_CHARS = 2000;
/** Timeout mặc định mỗi lệnh test, ms. */
export const V11_EVAL_DEFAULT_TEST_TIMEOUT_MS = 30_000;
/** Hệ số ước lượng token khi agent không báo (chars / 4). */
export const V11_EVAL_TOKEN_CHARS_PER_TOKEN = 4;
/** Tên suite mặc định. */
export const V11_EVAL_SUITE_NAME = 'coding-v11-sample-suite';
/** Tên file report chi tiết trong thư mục version. */
export const V11_EVAL_DETAIL_FILE = 'report.json';

/** Kết quả agent nộp cho một attempt (patch + số liệu tự báo). */
export type V11EvalAgentFn = (
  task: V11EvalTask,
  attempt: number,
) => Promise<V11EvalAgentAttempt> | V11EvalAgentAttempt;

/** Validate một task eval v2 (throw CodingV11Error khi sai). */
export function validateV11EvalTask(task: V11EvalTask): void {
  if (!task || typeof task.id !== 'string' || task.id.trim() === '') {
    throw new CodingV11Error('eval-task-invalid', 'Eval v11: task thiếu id.');
  }
  if (!task.files || Object.keys(task.files).length === 0) {
    throw new CodingV11Error('eval-task-invalid', `Eval v11: task "${task.id}" không có file fixture.`);
  }
  if (!Array.isArray(task.tests) || task.tests.length === 0) {
    throw new CodingV11Error('eval-task-invalid', `Eval v11: task "${task.id}" không có test nào.`);
  }
  if (!task.tests.some((t) => t.kind === 'fail-to-pass')) {
    throw new CodingV11Error(
      'eval-task-invalid',
      `Eval v11: task "${task.id}" cần ít nhất một test fail-to-pass.`,
    );
  }
  for (const test of task.tests) {
    if (typeof test.name !== 'string' || test.name.trim() === '') {
      throw new CodingV11Error('eval-task-invalid', `Eval v11: task "${task.id}" có test thiếu tên.`);
    }
    if (!Array.isArray(test.command) || test.command.length === 0) {
      throw new CodingV11Error('eval-task-invalid', `Eval v11: test "${test.name}" thiếu command.`);
    }
    if (test.weight !== undefined && (typeof test.weight !== 'number' || test.weight <= 0)) {
      throw new CodingV11Error('eval-task-invalid', `Eval v11: test "${test.name}" có weight không hợp lệ.`);
    }
  }
}

/** Tên version agent hợp lệ: chữ/số/`-`/`.`/`_` (để làm tên thư mục). */
export function v11SafeVersionName(version: string): string {
  const cleaned = version.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '').slice(0, 64);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    throw new CodingV11Error('eval-version-invalid', `Eval v11: tên phiên bản không hợp lệ: "${version}".`);
  }
  return cleaned;
}

/** Ghi file (tạo thư mục cha khi cần). */
function writeFixtureFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

/** Chạy một lệnh argv (không shell) với timeout, trả exit code + output. */
function runCommand(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), { cwd, shell: false, env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Process đã thoát.
      }
    }, Math.max(1000, timeoutMs));
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 20_000) stdout = stdout.slice(0, 20_000);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 20_000) stderr = stderr.slice(0, 20_000);
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\nspawn error: ${err.message}`, durationMs: Date.now() - started, timedOut: false });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? -1 : (code ?? -1), stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
  });
}

/**
 * Chạy MỘT attempt của một task: tạo repo tạm (git thật) → apply
 * patch → chạy từng test có trọng số → chấm điểm partial credit.
 */
export async function runV11EvalAttempt(
  task: V11EvalTask,
  attempt: V11EvalAgentAttempt,
  attemptNo: number,
  options: { testTimeoutMs?: number } = {},
): Promise<V11EvalAttemptResult> {
  validateV11EvalTask(task);
  const timeoutMs = options.testTimeoutMs ?? V11_EVAL_DEFAULT_TEST_TIMEOUT_MS;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-v11-'));
  try {
    for (const [rel, content] of Object.entries(task.files)) writeFixtureFile(tmpDir, rel, content);
    const gitOpts = { workingDir: tmpDir, timeoutMs, authorName: 'open-bot-eval-v11', authorEmail: 'eval-v11@open-bot.local' };
    await runV9GitOrThrow(['init', '--quiet'], gitOpts);
    await runV9GitOrThrow(['add', '-A'], gitOpts);
    await runV9GitOrThrow(['commit', '--quiet', '-m', 'fixture'], gitOpts);
    if (!attempt.patch || attempt.patch.trim() === '') {
      return {
        attempt: attemptNo,
        passed: false,
        score: 0,
        tests: [],
        roundsUsed: attempt.roundsUsed,
        tokensIn: attempt.tokensIn,
        tokensOut: attempt.tokensOut,
        error: 'Agent không nộp patch.',
      };
    }
    const patchPath = path.join(tmpDir, 'agent.patch');
    fs.writeFileSync(patchPath, attempt.patch, 'utf8');
    const applied = await runV9Git(['apply', '--whitespace=nowarn', 'agent.patch'], gitOpts);
    if (applied.exitCode !== 0) {
      return {
        attempt: attemptNo,
        passed: false,
        score: 0,
        tests: [],
        roundsUsed: attempt.roundsUsed,
        tokensIn: attempt.tokensIn,
        tokensOut: attempt.tokensOut,
        error: `Patch không áp được: ${(applied.stderr || applied.stdout).trim().slice(0, 500) || `git apply exit ${applied.exitCode}`}`,
      };
    }
    const results: V11EvalTestResult[] = [];
    let weightPassed = 0;
    let weightTotal = 0;
    let allFailToPass = true;
    for (const test of task.tests) {
      const weight = test.weight ?? 1;
      weightTotal += weight;
      const run = await runCommand(test.command, tmpDir, timeoutMs);
      const passed = !run.timedOut && run.exitCode === 0;
      if (passed) weightPassed += weight;
      if (test.kind === 'fail-to-pass' && !passed) allFailToPass = false;
      results.push({
        name: test.name,
        kind: test.kind,
        weight,
        passed,
        durationMs: run.durationMs,
        failureExcerpt: passed
          ? undefined
          : `${run.timedOut ? 'timeout' : `exit ${run.exitCode}`}: ${(run.stderr || run.stdout).trim().slice(-V11_EVAL_FAILURE_EXCERPT_CHARS) || '(no output)'}`,
      });
    }
    return {
      attempt: attemptNo,
      passed: allFailToPass,
      score: weightTotal > 0 ? weightPassed / weightTotal : 0,
      tests: results,
      roundsUsed: attempt.roundsUsed,
      tokensIn: attempt.tokensIn,
      tokensOut: attempt.tokensOut,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Thư mục tạm không dọn được — không chặn kết quả.
    }
  }
}

/** Chạy toàn bộ MỘT task (k attempt) + phát hiện flaky khi yêu cầu. */
async function runV11EvalTask(
  task: V11EvalTask,
  agent: V11EvalAgentFn,
  attemptsPerTask: number,
  options: { testTimeoutMs?: number; detectFlaky?: boolean },
): Promise<V11EvalTaskSummary> {
  const attempts: V11EvalAttemptResult[] = [];
  for (let attemptNo = 1; attemptNo <= attemptsPerTask; attemptNo++) {
    const submitted = await agent(task, attemptNo);
    const tokensEstimated = submitted.tokensEstimated ?? false;
    const normalized: V11EvalAgentAttempt = {
      ...submitted,
      tokensIn: submitted.tokensIn || Math.ceil(submitted.patch.length / V11_EVAL_TOKEN_CHARS_PER_TOKEN),
      tokensOut: submitted.tokensOut || 0,
      tokensEstimated,
    };
    attempts.push(await runV11EvalAttempt(task, normalized, attemptNo, options));
  }
  const anyPass = attempts.some((a) => a.passed);
  const bestScore = attempts.reduce((max, a) => Math.max(max, a.score), 0);
  let flaky = false;
  let flakyDetail: string | undefined;
  if (options.detectFlaky) {
    // Chạy lặp toàn bộ task một lần nữa, so sánh trạng thái pass.
    const repeat: V11EvalAttemptResult[] = [];
    for (let attemptNo = 1; attemptNo <= attemptsPerTask; attemptNo++) {
      const submitted = await agent(task, attemptNo);
      repeat.push(await runV11EvalAttempt(task, submitted, attemptNo, options));
    }
    const repeatAnyPass = repeat.some((a) => a.passed);
    const repeatBestScore = repeat.reduce((max, a) => Math.max(max, a.score), 0);
    if (repeatAnyPass !== anyPass) {
      flaky = true;
      flakyDetail = `Lần chạy 1: ${anyPass ? 'pass' : 'fail'} (best score ${bestScore.toFixed(2)}), lần chạy 2: ${repeatAnyPass ? 'pass' : 'fail'} (best score ${repeatBestScore.toFixed(2)}) — kết quả không ổn định.`;
    } else if (Math.abs(repeatBestScore - bestScore) > 0.34) {
      flaky = true;
      flakyDetail = `Điểm partial credit đổi nhiều giữa 2 lần chạy: ${bestScore.toFixed(2)} → ${repeatBestScore.toFixed(2)}.`;
    }
  }
  return { taskId: task.id, title: task.title, anyPass, bestScore, attempts, flaky, flakyDetail };
}

export interface V11EvalSuiteOptions {
  /** Số attempt mỗi task (k của pass@k). Mặc định 3. */
  attemptsPerTask?: number;
  /** Timeout mỗi lệnh test, ms. */
  testTimeoutMs?: number;
  /** Có chạy lặp để phát hiện flaky không (mặc định false — tốn gấp đôi thời gian). */
  detectFlaky?: boolean;
  /** Thư mục lưu report (mặc định: thư mục tạm, không lưu). */
  evalDir?: string;
  /** Phiên bản agent (dùng làm tên thư mục khi lưu). */
  agentVersion?: string;
}

/**
 * Chạy cả suite eval v2: k attempt/task, pass@k + partial credit +
 * flaky, lưu report theo phiên bản khi có evalDir.
 */
export async function runV11EvalSuite(
  tasks: readonly V11EvalTask[],
  agent: V11EvalAgentFn,
  options: V11EvalSuiteOptions = {},
): Promise<V11EvalReport> {
  if (tasks.length === 0) {
    throw new CodingV11Error('eval-task-invalid', 'Eval v11: suite rỗng, không có task nào.');
  }
  if (tasks.length > V11_EVAL_MAX_TASKS_PER_SUITE) {
    throw new CodingV11Error(
      'eval-task-invalid',
      `Eval v11: suite có ${tasks.length} task, vượt giới hạn ${V11_EVAL_MAX_TASKS_PER_SUITE}.`,
    );
  }
  const attemptsPerTask = Math.min(
    Math.max(1, options.attemptsPerTask ?? V11_EVAL_DEFAULT_ATTEMPTS),
    V11_EVAL_MAX_ATTEMPTS,
  );
  const agentVersion = options.agentVersion ?? 'v11';
  const startedAt = new Date().toISOString();
  const summaries: V11EvalTaskSummary[] = [];
  for (const task of tasks) {
    summaries.push(await runV11EvalTask(task, agent, attemptsPerTask, options));
  }
  const taskCount = summaries.length;
  const tasksPassed = summaries.filter((s) => s.anyPass).length;
  const allAttempts = summaries.flatMap((s) => s.attempts);
  const attemptsPassed = allAttempts.filter((a) => a.passed).length;
  const avgScore = summaries.reduce((sum, s) => sum + s.bestScore, 0) / Math.max(1, taskCount);
  const avgRounds = allAttempts.reduce((sum, a) => sum + a.roundsUsed, 0) / Math.max(1, allAttempts.length);
  const avgTokens =
    allAttempts.reduce((sum, a) => sum + a.tokensIn + a.tokensOut, 0) / Math.max(1, allAttempts.length);
  const report: V11EvalReport = {
    version: 2,
    agentVersion,
    suiteName: V11_EVAL_SUITE_NAME,
    passAtK: taskCount > 0 ? tasksPassed / taskCount : 0,
    attemptPassRate: allAttempts.length > 0 ? attemptsPassed / allAttempts.length : 0,
    avgScore,
    avgRounds,
    avgTokens,
    taskCount,
    tasksPassed,
    attemptsPerTask,
    flakyTasks: summaries.filter((s) => s.flaky).length,
    startedAt,
    finishedAt: new Date().toISOString(),
    tasks: summaries,
    detailFile: V11_EVAL_DETAIL_FILE,
  };
  if (options.evalDir) {
    saveV11EvalReport(options.evalDir, report);
  }
  return report;
}

/* ================================================================== */
/* Task mẫu + agent mẫu                                                */
/* ================================================================== */

/**
 * 3 task mẫu (repo JS nhỏ + test `node --test` thật). Agent mẫu
 * scripted sửa đúng 2/3 task để demo pass@k < 100%.
 */
export const V11_EVAL_SAMPLE_TASKS: readonly V11EvalTask[] = [
  {
    id: 'v11-sample-add',
    title: 'Cộng hai số',
    description: 'Sửa hàm add(a, b) trong src/math.mjs để trả về tổng đúng.',
    files: {
      'src/math.mjs': `export function add(a, b) {\n  return 0;\n}\n`,
      'test/math.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\n\ntest('add: 1 + 2 = 3', () => assert.equal(add(1, 2), 3));\ntest('add: 0 + 0 = 0', () => assert.equal(add(0, 0), 0));\ntest('add: số âm', () => assert.equal(add(-1, -2), -3));\n`,
    },
    tests: [
      { name: 'add', kind: 'fail-to-pass', command: ['node', '--test', 'test/math.test.mjs'], weight: 2 },
      { name: 'add-smoke', kind: 'pass-to-pass', command: ['node', '-e', "import('./src/math.mjs').then((m) => { if (typeof m.add !== 'function') process.exit(1); })"], weight: 1 },
    ],
  },
  {
    id: 'v11-sample-capitalize',
    title: 'Viết hoa chữ đầu',
    description: 'Sửa hàm capitalize(s) trong src/text.mjs để viết hoa chữ cái đầu tiên.',
    files: {
      'src/text.mjs': `export function capitalize(s) {\n  return s;\n}\n`,
      'test/text.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { capitalize } from '../src/text.mjs';\n\ntest('capitalize: hello → Hello', () => assert.equal(capitalize('hello'), 'Hello'));\ntest('capitalize: chuỗi rỗng', () => assert.equal(capitalize(''), ''));\n`,
    },
    tests: [
      { name: 'capitalize', kind: 'fail-to-pass', command: ['node', '--test', 'test/text.test.mjs'], weight: 1 },
    ],
  },
  {
    id: 'v11-sample-max',
    title: 'Số lớn nhất trong mảng',
    description: 'Sửa hàm maxOf(arr) trong src/array.mjs để trả về số lớn nhất.',
    files: {
      'src/array.mjs': `export function maxOf(arr) {\n  return arr[0];\n}\n`,
      'test/array.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { maxOf } from '../src/array.mjs';\n\ntest('maxOf: [1, 5, 3] → 5', () => assert.equal(maxOf([1, 5, 3]), 5));\ntest('maxOf: mảng 1 phần tử', () => assert.equal(maxOf([7]), 7));\ntest('maxOf: số âm', () => assert.equal(maxOf([-2, -9, -1]), -1));\n`,
    },
    tests: [
      { name: 'maxOf', kind: 'fail-to-pass', command: ['node', '--test', 'test/array.test.mjs'], weight: 1 },
    ],
  },
];

/** Patch mẫu đúng cho task add (diff unified, áp bằng `git apply`). */
export const V11_SAMPLE_PATCH_ADD = `--- a/src/math.mjs
+++ b/src/math.mjs
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return 0;
+  return a + b;
 }
`;

/** Patch mẫu đúng cho task capitalize. */
export const V11_SAMPLE_PATCH_CAPITALIZE = `--- a/src/text.mjs
+++ b/src/text.mjs
@@ -1,3 +1,3 @@
 export function capitalize(s) {
-  return s;
+  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
 }
`;

/** Patch mẫu SAI cho task max (trả số nhỏ nhất — demo agent sai). */
export const V11_SAMPLE_PATCH_MAX_WRONG = `--- a/src/array.mjs
+++ b/src/array.mjs
@@ -1,3 +1,3 @@
 export function maxOf(arr) {
-  return arr[0];
+  return Math.min(...arr);
 }
`;

/**
 * Agent mẫu scripted: nộp patch đúng cho 2 task đầu, patch sai cho
 * task max — để demo pass@k = 2/3 và partial credit.
 */
export function scriptedV11Agent(task: V11EvalTask, _attempt: number): V11EvalAgentAttempt {
  const patch =
    task.id === 'v11-sample-add'
      ? V11_SAMPLE_PATCH_ADD
      : task.id === 'v11-sample-capitalize'
        ? V11_SAMPLE_PATCH_CAPITALIZE
        : V11_SAMPLE_PATCH_MAX_WRONG;
  return { patch, roundsUsed: 1, tokensIn: 120, tokensOut: 80, model: 'scripted-v11', tokensEstimated: false };
}

/* ================================================================== */
/* Lưu / đọc / so sánh report                                         */
/* ================================================================== */

/** Lưu report eval v2 vào `<evalDir>/<version>/report.json`. */
export function saveV11EvalReport(evalDir: string, report: V11EvalReport): string {
  const version = v11SafeVersionName(report.agentVersion);
  const dir = path.join(evalDir, version);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, V11_EVAL_DETAIL_FILE);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}

/** Đọc report eval v2 của một phiên bản (null khi chưa có). */
export function loadV11EvalReport(evalDir: string, agentVersion: string): V11EvalReport | null {
  const version = v11SafeVersionName(agentVersion);
  const filePath = path.join(evalDir, version, V11_EVAL_DETAIL_FILE);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as V11EvalReport;
    if (data.version !== 2 || !Array.isArray(data.tasks)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Liệt kê các phiên bản agent đã có report (mới nhất trước). */
export function listV11EvalVersions(evalDir: string): string[] {
  try {
    return fs
      .readdirSync(evalDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => loadV11EvalReport(evalDir, name) !== null)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Tóm tắt một report eval v2 thành một dòng (để bảng so sánh). */
export function v11SummarizeEvalReport(report: V11EvalReport): string {
  return `${report.agentVersion}: pass@k ${(report.passAtK * 100).toFixed(0)}% (${report.tasksPassed}/${report.taskCount}), avg score ${report.avgScore.toFixed(2)}, attempt pass ${(report.attemptPassRate * 100).toFixed(0)}%, flaky ${report.flakyTasks}`;
}

/** So sánh hai báo cáo eval v2 (cũ vs mới), liệt kê regression. */
export function compareV11EvalReports(older: V11EvalReport, newer: V11EvalReport): V11EvalComparison {
  const olderById = new Map(older.tasks.map((t) => [t.taskId, t]));
  const newerById = new Map(newer.tasks.map((t) => [t.taskId, t]));
  const changedTasks: V11EvalComparison['changedTasks'] = [];
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const [taskId, newerTask] of newerById) {
    const olderTask = olderById.get(taskId);
    if (!olderTask) continue;
    if (olderTask.anyPass !== newerTask.anyPass || Math.abs(olderTask.bestScore - newerTask.bestScore) > 1e-9) {
      changedTasks.push({
        taskId,
        olderAnyPass: olderTask.anyPass,
        newerAnyPass: newerTask.anyPass,
        olderBestScore: olderTask.bestScore,
        newerBestScore: newerTask.bestScore,
      });
    }
    if (olderTask.anyPass && !newerTask.anyPass) regressions.push(taskId);
    if (!olderTask.anyPass && newerTask.anyPass) improvements.push(taskId);
  }
  return {
    olderVersion: older.agentVersion,
    newerVersion: newer.agentVersion,
    passAtKDelta: newer.passAtK - older.passAtK,
    avgScoreDelta: newer.avgScore - older.avgScore,
    attemptPassRateDelta: newer.attemptPassRate - older.attemptPassRate,
    changedTasks,
    regressions,
    improvements,
  };
}

/** Render bảng so sánh các phiên bản agent (markdown). */
export function renderV11EvalVersionTable(reports: readonly V11EvalReport[]): string {
  const lines = [
    '| version | pass@k | avg score | attempt pass | tasks | flaky |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const report of reports) {
    lines.push(
      `| ${report.agentVersion} | ${(report.passAtK * 100).toFixed(0)}% | ${report.avgScore.toFixed(2)} | ${(report.attemptPassRate * 100).toFixed(0)}% | ${report.tasksPassed}/${report.taskCount} | ${report.flakyTasks} |`,
    );
  }
  return lines.join('\n');
}

/** Render so sánh hai phiên bản thành text ngắn (để log/UI). */
export function renderV11EvalComparison(comparison: V11EvalComparison): string {
  const lines = [
    `Eval v11: ${comparison.olderVersion} → ${comparison.newerVersion}: pass@k ${comparison.passAtKDelta >= 0 ? '+' : ''}${(comparison.passAtKDelta * 100).toFixed(1)}%, avg score ${comparison.avgScoreDelta >= 0 ? '+' : ''}${comparison.avgScoreDelta.toFixed(2)}.`,
  ];
  if (comparison.regressions.length > 0) {
    lines.push(`REGRESSION: ${comparison.regressions.join(', ')} (từng pass, nay fail).`);
  }
  if (comparison.improvements.length > 0) {
    lines.push(`Cải thiện: ${comparison.improvements.join(', ')}.`);
  }
  if (comparison.changedTasks.length === 0) lines.push('Không task nào đổi trạng thái.');
  return lines.join('\n');
}

/** Id chạy duy nhất cho thư mục tạm (không dùng làm tên file report). */
export function v11NewEvalRunId(): string {
  return `v11eval-${crypto.randomBytes(6).toString('hex')}`;
}
