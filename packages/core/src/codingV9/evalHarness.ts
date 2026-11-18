/**
 * Eval harness nội bộ kiểu SWE-bench cho coding agent v9 (v1.17, Đội T4).
 *
 * Học ý tưởng SWE-bench (survey v1.17 §2): task mẫu (repo nhỏ +
 * test FAIL_TO_PASS / PASS_TO_PASS), chạy agent trên task, đo pass@k.
 * Tự thiết kế lại hoàn toàn, DÙNG LẠI harness chấm patch của v5
 * (`CodingV5SweHarness.runTask` — git tạm + apply patch + chạy test
 * + chấm theo đúng quy tắc FAIL_TO_PASS/PASS_TO_PASS) để không viết
 * lại logic chấm điểm:
 *
 * - Agent v9 được gọi qua `V9EvalAgentFn`: nhận task + số attempt,
 *   trả về `{ patch, roundsUsed, tokensIn, tokensOut, model }`.
 *   Agent không báo token thì ước lượng bằng chars/4 và đánh dấu
 *   `tokensEstimated: true` (trung thực, không giả vờ là số thật).
 * - Mỗi task chạy k attempt (k cấu hình được, mặc định 3):
 *   pass@k = số task có ≥1 attempt pass / tổng task. Ngoài ra còn
 *   đo attempt pass rate, vòng lặp trung bình, token trung bình.
 * - Kết quả lưu JSON từng lần chạy (`saveV9EvalReport`), đọc lại
 *   (`loadV9EvalReport`), so sánh hai lần chạy (`compareV9EvalReports`
 *   + `renderV9EvalComparison`) để thấy agent tiến bộ hay thụt lùi.
 * - 3 task mẫu đi kèm (`V9_EVAL_SAMPLE_TASKS`): repo JS nhỏ + test
 *   `node` thật, agent mẫu scripted (`scriptedV9Agent`) sửa đúng 2/3
 *   task để demo pass@k < 100% (agent mẫu cố tình sai 1 task).
 *
 * Giới hạn trung thực (kế thừa từ v5):
 * - Chấm theo exit code từng lệnh test, không chấm theo nội dung
 *   output; tên test phải khớp `name` của lệnh test.
 * - Repo tạm dùng git thật nên cần `git` trên PATH; không phải
 *   Docker sandbox thật — chỉ dùng task tự viết/tin cậy.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CodingV5SweHarness,
  validateCodingV5SweTask,
} from '../codingV5/sweBenchEval';
import type { CodingV5SweTask } from '../codingV5/sweBenchEval';
import { CodingV9Error } from './types';
import type {
  V9EvalAttemptResult,
  V9EvalComparison,
  V9EvalReport,
  V9EvalTaskStatus,
  V9EvalTaskSummary,
} from './types';

/** Số attempt mặc định mỗi task (k của pass@k). */
export const V9_EVAL_DEFAULT_ATTEMPTS = 3;
/** Số attempt tối đa mỗi task. */
export const V9_EVAL_MAX_ATTEMPTS = 10;
/** Số task tối đa mỗi suite. */
export const V9_EVAL_MAX_TASKS_PER_SUITE = 100;
/** Số ký tự patch tối đa giữ trong report (preview). */
export const V9_EVAL_PATCH_PREVIEW_CHARS = 2000;
/** Hệ số ước lượng token khi agent không báo (chars / 4). */
export const V9_EVAL_TOKEN_CHARS_PER_TOKEN = 4;

/** Kết quả agent nộp cho một attempt (patch + số liệu tự báo). */
export interface V9EvalAgentAttempt {
  /** Unified diff agent đề xuất (áp vào repo tạm bằng `git apply`). */
  patch: string;
  /** Số vòng sandbox loop agent đã dùng (0 khi không dùng loop). */
  roundsUsed?: number;
  /** Token vào (model báo); không có thì ước lượng. */
  tokensIn?: number;
  /** Token ra (model báo); không có thì ước lượng. */
  tokensOut?: number;
  /** Model agent dùng (vd `scripted`, `mock-gemini-flash`). */
  model?: string;
}

/** Hàm agent eval: task + attempt → patch + số liệu. */
export type V9EvalAgentFn = (
  task: CodingV5SweTask,
  attempt: number,
) => Promise<V9EvalAgentAttempt> | V9EvalAgentAttempt;

/** Tùy chọn chạy eval. */
export interface V9EvalRunOptions {
  /** Số attempt mỗi task (k). Mặc định 3. */
  attemptsPerTask?: number;
  /** Thư mục cha cho repo tạm (mặc định os.tmpdir()). */
  tmpBase?: string;
  /** Giữ repo tạm sau khi chạy (mặc định false: dọn). */
  keepWorkDir?: boolean;
  /** Tên suite (ghi vào report). */
  suiteName?: string;
  /** Timeout mỗi lệnh test, ms (ghi đè task.timeoutMs khi có). */
  timeoutMs?: number;
}

/** Ước lượng token từ độ dài text (chars / 4, làm tròn lên). */
export function v9EstimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / V9_EVAL_TOKEN_CHARS_PER_TOKEN));
}

/** Validate một task eval v9 (dùng validator của v5 + kiểm tra k). */
export function validateV9EvalTask(task: CodingV5SweTask): void {
  try {
    validateCodingV5SweTask(task);
  } catch (err) {
    throw new CodingV9Error(
      'eval-task-invalid',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!task.testCommands || task.testCommands.length === 0) {
    throw new CodingV9Error('eval-task-invalid', `Task ${task.id} needs at least one test command.`);
  }
  if (!task.failToPass || task.failToPass.length === 0) {
    throw new CodingV9Error(
      'eval-task-invalid',
      `Task ${task.id} needs at least one failToPass test.`,
    );
  }
}

/**
 * Chạy agent trên MỘT task, k attempt: mỗi attempt gọi agentFn lấy
 * patch rồi chấm bằng harness v5 (repo tạm riêng mỗi attempt).
 */
export async function runV9EvalTask(
  task: CodingV5SweTask,
  agentFn: V9EvalAgentFn,
  options: V9EvalRunOptions = {},
): Promise<V9EvalTaskSummary> {
  validateV9EvalTask(task);
  const k = Math.min(
    Math.max(1, Math.floor(options.attemptsPerTask ?? V9_EVAL_DEFAULT_ATTEMPTS)),
    V9_EVAL_MAX_ATTEMPTS,
  );
  const harness = new CodingV5SweHarness();
  const attempts: V9EvalAttemptResult[] = [];
  for (let attempt = 1; attempt <= k; attempt += 1) {
    const startedAt = Date.now();
    let agentOut: V9EvalAgentAttempt;
    try {
      agentOut = await agentFn(task, attempt);
    } catch (err) {
      attempts.push({
        taskId: task.id,
        attempt,
        status: 'error',
        roundsUsed: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensEstimated: false,
        model: '',
        reason: `Agent threw: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startedAt,
        patchPreview: '',
      });
      continue;
    }
    const patch = agentOut.patch ?? '';
    if (patch.trim() === '') {
      attempts.push({
        taskId: task.id,
        attempt,
        status: 'error',
        roundsUsed: Math.max(0, Math.floor(agentOut.roundsUsed ?? 0)),
        tokensIn: agentOut.tokensIn ?? v9EstimateTokens(task.issue),
        tokensOut: agentOut.tokensOut ?? 0,
        tokensEstimated: agentOut.tokensIn === undefined || agentOut.tokensOut === undefined,
        model: agentOut.model ?? '',
        reason: 'Agent returned an empty patch.',
        durationMs: Date.now() - startedAt,
        patchPreview: '',
      });
      continue;
    }
    const scored = await harness.runTask(
      { ...task, patch, timeoutMs: options.timeoutMs ?? task.timeoutMs },
      { tmpBase: options.tmpBase, keepWorkDir: options.keepWorkDir ?? false },
    );
    const tokensEstimated = agentOut.tokensIn === undefined || agentOut.tokensOut === undefined;
    attempts.push({
      taskId: task.id,
      attempt,
      status: scored.status as V9EvalTaskStatus,
      roundsUsed: Math.max(0, Math.floor(agentOut.roundsUsed ?? 0)),
      tokensIn: agentOut.tokensIn ?? v9EstimateTokens(task.issue + patch),
      tokensOut: agentOut.tokensOut ?? v9EstimateTokens(patch),
      tokensEstimated,
      model: agentOut.model ?? '',
      reason: scored.reason,
      durationMs: Date.now() - startedAt,
      patchPreview: patch.slice(0, V9_EVAL_PATCH_PREVIEW_CHARS),
    });
  }
  const passCount = attempts.filter((a) => a.status === 'pass').length;
  const withRounds = attempts.filter((a) => a.roundsUsed > 0);
  const avgRounds =
    withRounds.length > 0
      ? withRounds.reduce((s, a) => s + a.roundsUsed, 0) / withRounds.length
      : 0;
  const avgTokens =
    attempts.length > 0
      ? attempts.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0) / attempts.length
      : 0;
  return {
    taskId: task.id,
    title: task.title,
    attempts,
    anyPass: passCount > 0,
    passCount,
    avgRounds,
    avgTokens,
  };
}

/**
 * Chạy agent trên toàn bộ suite (nhiều task × k attempt), trả về
 * báo cáo tổng hợp (pass@k, attempt pass rate, vòng/token trung bình).
 */
export async function runV9EvalSuite(
  tasks: CodingV5SweTask[],
  agentFn: V9EvalAgentFn,
  options: V9EvalRunOptions = {},
): Promise<V9EvalReport> {
  if (tasks.length === 0) {
    throw new CodingV9Error('eval-task-invalid', 'Eval suite needs at least one task.');
  }
  if (tasks.length > V9_EVAL_MAX_TASKS_PER_SUITE) {
    throw new CodingV9Error(
      'eval-task-invalid',
      `Suite has ${tasks.length} task(s) — over the limit of ${V9_EVAL_MAX_TASKS_PER_SUITE}.`,
    );
  }
  const startedAt = new Date();
  const startedMs = Date.now();
  const attemptsPerTask = Math.min(
    Math.max(1, Math.floor(options.attemptsPerTask ?? V9_EVAL_DEFAULT_ATTEMPTS)),
    V9_EVAL_MAX_ATTEMPTS,
  );
  const summaries: V9EvalTaskSummary[] = [];
  for (const task of tasks) {
    summaries.push(await runV9EvalTask(task, agentFn, { ...options, attemptsPerTask }));
  }
  const tasksPassed = summaries.filter((s) => s.anyPass).length;
  const allAttempts = summaries.flatMap((s) => s.attempts);
  const attemptPassed = allAttempts.filter((a) => a.status === 'pass').length;
  const withRounds = allAttempts.filter((a) => a.roundsUsed > 0);
  const avgRounds =
    withRounds.length > 0
      ? withRounds.reduce((s, a) => s + a.roundsUsed, 0) / withRounds.length
      : 0;
  const avgTokens =
    allAttempts.length > 0
      ? allAttempts.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0) / allAttempts.length
      : 0;
  return {
    version: 1,
    suiteName: options.suiteName ?? 'coding-v9-sample',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    attemptsPerTask,
    taskCount: summaries.length,
    tasksPassed,
    passAtK: summaries.length > 0 ? tasksPassed / summaries.length : 0,
    attemptPassRate: allAttempts.length > 0 ? attemptPassed / allAttempts.length : 0,
    avgRounds,
    avgTokens,
    totalDurationMs: Date.now() - startedMs,
    tasks: summaries,
  };
}

/** Lưu báo cáo eval thành JSON (tên file theo suite + timestamp). */
export function saveV9EvalReport(report: V9EvalReport, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${report.suiteName}-${stamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
  return filePath;
}

/** Đọc lại báo cáo eval từ JSON. */
export function loadV9EvalReport(filePath: string): V9EvalReport {
  const text = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as V9EvalReport;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
    throw new CodingV9Error('eval-task-invalid', `Not a v9 eval report: ${filePath}`);
  }
  return parsed;
}

/** Liệt kê các file báo cáo eval trong một thư mục (mới nhất trước). */
export function listV9EvalReports(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f))
    .sort()
    .reverse();
}

/**
 * So sánh hai báo cáo eval (cũ vs mới): delta pass@k, attempt rate,
 * vòng/token trung bình, task đổi trạng thái, task thêm/bớt.
 */
export function compareV9EvalReports(
  older: V9EvalReport,
  newer: V9EvalReport,
  olderFile = '',
  newerFile = '',
): V9EvalComparison {
  const olderMap = new Map(older.tasks.map((t) => [t.taskId, t]));
  const newerMap = new Map(newer.tasks.map((t) => [t.taskId, t]));
  const changedTasks: V9EvalComparison['changedTasks'] = [];
  for (const [taskId, newerTask] of newerMap) {
    const olderTask = olderMap.get(taskId);
    if (olderTask && olderTask.anyPass !== newerTask.anyPass) {
      changedTasks.push({ taskId, olderAnyPass: olderTask.anyPass, newerAnyPass: newerTask.anyPass });
    }
  }
  return {
    olderFile,
    newerFile,
    passAtKDelta: newer.passAtK - older.passAtK,
    attemptPassRateDelta: newer.attemptPassRate - older.attemptPassRate,
    avgRoundsDelta: newer.avgRounds - older.avgRounds,
    avgTokensDelta: newer.avgTokens - older.avgTokens,
    changedTasks,
    addedTasks: [...newerMap.keys()].filter((id) => !olderMap.has(id)),
    removedTasks: [...olderMap.keys()].filter((id) => !newerMap.has(id)),
  };
}

/** Render so sánh eval thành markdown (dùng cho báo cáo / PR body). */
export function renderV9EvalComparison(comparison: V9EvalComparison): string {
  const sign = (n: number, digits = 3): string => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
  const lines: string[] = [];
  lines.push('## Eval comparison (coding agent v9)');
  lines.push('');
  if (comparison.olderFile) lines.push(`- Older: \`${comparison.olderFile}\``);
  if (comparison.newerFile) lines.push(`- Newer: \`${comparison.newerFile}\``);
  lines.push(`- pass@k delta: ${sign(comparison.passAtKDelta)}`);
  lines.push(`- attempt pass rate delta: ${sign(comparison.attemptPassRateDelta)}`);
  lines.push(`- avg rounds delta: ${sign(comparison.avgRoundsDelta, 1)}`);
  lines.push(`- avg tokens delta: ${sign(comparison.avgTokensDelta, 1)}`);
  lines.push('');
  if (comparison.changedTasks.length === 0) {
    lines.push('No task changed pass/fail status.');
  } else {
    lines.push('| Task | Before | After |');
    lines.push('| ---- | ------ | ----- |');
    for (const t of comparison.changedTasks) {
      lines.push(`| \`${t.taskId}\` | ${t.olderAnyPass ? 'pass' : 'fail'} | ${t.newerAnyPass ? 'pass' : 'fail'} |`);
    }
  }
  if (comparison.addedTasks.length > 0) {
    lines.push('');
    lines.push(`Added tasks: ${comparison.addedTasks.map((t) => `\`${t}\``).join(', ')}`);
  }
  if (comparison.removedTasks.length > 0) {
    lines.push('');
    lines.push(`Removed tasks: ${comparison.removedTasks.map((t) => `\`${t}\``).join(', ')}`);
  }
  return lines.join('\n');
}

/** Render một báo cáo eval thành markdown tóm tắt. */
export function renderV9EvalReport(report: V9EvalReport): string {
  const lines: string[] = [];
  lines.push(`## Eval report: ${report.suiteName}`);
  lines.push('');
  lines.push(`- pass@${report.attemptsPerTask}: ${report.tasksPassed}/${report.taskCount} (${(report.passAtK * 100).toFixed(1)}%)`);
  lines.push(`- attempt pass rate: ${(report.attemptPassRate * 100).toFixed(1)}%`);
  lines.push(`- avg rounds: ${report.avgRounds.toFixed(2)}`);
  lines.push(`- avg tokens/attempt: ${report.avgTokens.toFixed(0)}`);
  lines.push(`- duration: ${report.totalDurationMs}ms (${report.startedAt} → ${report.finishedAt})`);
  lines.push('');
  lines.push('| Task | Attempts | Pass | Avg rounds | Avg tokens |');
  lines.push('| ---- | -------- | ---- | ---------- | ---------- |');
  for (const t of report.tasks) {
    lines.push(
      `| \`${t.taskId}\` | ${t.attempts.length} | ${t.passCount} | ${t.avgRounds.toFixed(2)} | ${t.avgTokens.toFixed(0)} |`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Task mẫu + agent mẫu (scripted, không cần model thật)
// ---------------------------------------------------------------------------

const SAMPLE_ADD_FIXTURE = `export function add(a, b) {
  return a - b;
}

export function identity(x) {
  return x;
}
`;

const SAMPLE_ADD_TEST = `import { add, identity } from './util.mjs';
import assert from 'node:assert/strict';
assert.equal(add(2, 3), 5);
assert.equal(add(-1, 1), 0);
`;

const SAMPLE_ADD_PASSTO_PASS = `import { identity } from './util.mjs';
import assert from 'node:assert/strict';
assert.equal(identity(7), 7);
assert.equal(identity('x'), 'x');
`;

const SAMPLE_GREET_FIXTURE = `export function greet(name) {
  return 'hello';
}

export function shout(word) {
  return word.toUpperCase();
}
`;

const SAMPLE_GREET_TEST = `import { greet } from './util.mjs';
import assert from 'node:assert/strict';
assert.equal(greet('An'), 'hello An');
assert.equal(greet('Binh'), 'hello Binh');
`;

const SAMPLE_GREET_PASSTO_PASS = `import { shout } from './util.mjs';
import assert from 'node:assert/strict';
assert.equal(shout('hi'), 'HI');
`;

const SAMPLE_SORT_FIXTURE = `export function sortDesc(numbers) {
  return [...numbers].sort((a, b) => a - b);
}

export function first(numbers) {
  return numbers[0];
}
`;

const SAMPLE_SORT_TEST = `import { sortDesc } from './util.mjs';
import assert from 'node:assert/strict';
assert.deepEqual(sortDesc([3, 1, 2]), [3, 2, 1]);
assert.deepEqual(sortDesc([5]), [5]);
`;

const SAMPLE_SORT_PASSTO_PASS = `import { first } from './util.mjs';
import assert from 'node:assert/strict';
assert.equal(first([9, 8]), 9);
`;

/** Patch đúng cho task add (sửa `a - b` thành `a + b`). */
export const V9_SAMPLE_PATCH_ADD = `--- a/util.mjs
+++ b/util.mjs
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
`;

/** Patch đúng cho task greet (trả về tên). */
export const V9_SAMPLE_PATCH_GREET = `--- a/util.mjs
+++ b/util.mjs
@@ -1,3 +1,3 @@
 export function greet(name) {
-  return 'hello';
+  return 'hello ' + name;
 }
`;

/** Patch SAI cố tình cho task sort (đổi chiều sai: vẫn tăng dần). */
export const V9_SAMPLE_PATCH_SORT_WRONG = `--- a/util.mjs
+++ b/util.mjs
@@ -1,3 +1,3 @@
 export function sortDesc(numbers) {
-  return [...numbers].sort((a, b) => a - b);
+  return [...numbers].sort((a, b) => a - b);
 }
`;

/** 3 task eval mẫu của v9 (repo JS nhỏ + test `node` thật). */
export const V9_EVAL_SAMPLE_TASKS: CodingV5SweTask[] = [
  {
    id: 'v9-eval-add',
    title: 'Fix add() returning a - b instead of a + b',
    issue: 'add(2, 3) should return 5 but returns -1. Fix the add function in util.mjs.',
    fixtures: {
      'util.mjs': SAMPLE_ADD_FIXTURE,
      'test-fail.mjs': SAMPLE_ADD_TEST,
      'test-pass.mjs': SAMPLE_ADD_PASSTO_PASS,
    },
    patch: '',
    testCommands: [
      { name: 'fail-to-pass', argv: ['node', 'test-fail.mjs'] },
      { name: 'pass-to-pass', argv: ['node', 'test-pass.mjs'] },
    ],
    failToPass: ['fail-to-pass'],
    passToPass: ['pass-to-pass'],
    timeoutMs: 10_000,
  },
  {
    id: 'v9-eval-greet',
    title: 'Fix greet() ignoring the name argument',
    issue: "greet('An') should return 'hello An' but returns 'hello'. Fix greet in util.mjs.",
    fixtures: {
      'util.mjs': SAMPLE_GREET_FIXTURE,
      'test-fail.mjs': SAMPLE_GREET_TEST,
      'test-pass.mjs': SAMPLE_GREET_PASSTO_PASS,
    },
    patch: '',
    testCommands: [
      { name: 'fail-to-pass', argv: ['node', 'test-fail.mjs'] },
      { name: 'pass-to-pass', argv: ['node', 'test-pass.mjs'] },
    ],
    failToPass: ['fail-to-pass'],
    passToPass: ['pass-to-pass'],
    timeoutMs: 10_000,
  },
  {
    id: 'v9-eval-sort',
    title: 'Fix sortDesc() sorting ascending instead of descending',
    issue: 'sortDesc([3, 1, 2]) should return [3, 2, 1] but returns [1, 2, 3]. Fix sortDesc in util.mjs.',
    fixtures: {
      'util.mjs': SAMPLE_SORT_FIXTURE,
      'test-fail.mjs': SAMPLE_SORT_TEST,
      'test-pass.mjs': SAMPLE_SORT_PASSTO_PASS,
    },
    patch: '',
    testCommands: [
      { name: 'fail-to-pass', argv: ['node', 'test-fail.mjs'] },
      { name: 'pass-to-pass', argv: ['node', 'test-pass.mjs'] },
    ],
    failToPass: ['fail-to-pass'],
    passToPass: ['pass-to-pass'],
    timeoutMs: 10_000,
  },
];

/**
 * Agent mẫu scripted (không cần model thật): sửa đúng task add +
 * greet, nộp patch sai cho task sort (để demo pass@k < 100% và
 * thấy rõ task nào fail trong báo cáo so sánh).
 */
export function scriptedV9Agent(task: CodingV5SweTask, attempt: number): V9EvalAgentAttempt {
  void attempt;
  if (task.id === 'v9-eval-add') {
    return { patch: V9_SAMPLE_PATCH_ADD, roundsUsed: 1, model: 'scripted-v9' };
  }
  if (task.id === 'v9-eval-greet') {
    return { patch: V9_SAMPLE_PATCH_GREET, roundsUsed: 2, model: 'scripted-v9' };
  }
  return { patch: V9_SAMPLE_PATCH_SORT_WRONG, roundsUsed: 1, model: 'scripted-v9' };
}
