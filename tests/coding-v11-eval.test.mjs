/**
 * Tests cho coding agent v11 (v1.19, Đội T2-TEST vòng 6): eval
 * harness v2 (`packages/core/src/codingV11/evalV11.ts`) — validate
 * task, partial credit theo trọng số, pass@k, phát hiện flaky,
 * baseline regression, lưu/đọc/so sánh report theo phiên bản.
 *
 * Chạy thật (không mock): git thật + `node --test` thật trong repo
 * tạm cho mỗi attempt. Không chạy build/typecheck/full-suite (máy
 * quá tải): dist bundle nhẹ bằng esbuild (gitignored, xem ghi chú
 * ở tests/coding-v11-codeact.test.mjs).
 *
 *   node --test tests/coding-v11-eval.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Eval tạo repo tạm bằng git thật — authorName/authorEmail của
// harness không tới được `git commit` nên cần identity qua env
// (cùng tiền lệ test v5).
process.env.GIT_AUTHOR_NAME ??= 'test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';

// LỖI THẬT CỦA HARNESS (báo coordinator, không sửa core ở đây):
// lệnh test của task mẫu là `node --test ...`. Khi file test này
// chạy dưới `node --test`, Node kế thừa NODE_TEST_CONTEXT /
// NODE_TEST_WORKER_ID vào tiến trình con nên inner runner nhận
// diện "chạy test lồng nhau" và SKIP file test, thoát 0 — eval
// báo pass GIẢ (đã tái hiện: patch sai vẫn passed=true, score=1).
// Xóa 2 biến này để lệnh `node --test` trong harness chạy thật.
delete process.env.NODE_TEST_CONTEXT;
delete process.env.NODE_TEST_WORKER_ID;

import {
  CodingV11Error,
  V11_EVAL_DEFAULT_ATTEMPTS,
  V11_EVAL_MAX_ATTEMPTS,
  V11_EVAL_MAX_TASKS_PER_SUITE,
  V11_EVAL_SAMPLE_TASKS,
  V11_SAMPLE_PATCH_ADD,
  V11_SAMPLE_PATCH_CAPITALIZE,
  V11_SAMPLE_PATCH_MAX_WRONG,
  compareV11EvalReports,
  listV11EvalVersions,
  loadV11EvalReport,
  renderV11EvalComparison,
  renderV11EvalVersionTable,
  runV11EvalAttempt,
  runV11EvalSuite,
  saveV11EvalReport,
  scriptedV11Agent,
  v11NewEvalRunId,
  v11SafeVersionName,
  v11SummarizeEvalReport,
  validateV11EvalTask,
} from '../packages/core/dist/codingV11/index.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const ADD_TASK = V11_EVAL_SAMPLE_TASKS[0];
const MAX_TASK = V11_EVAL_SAMPLE_TASKS[2];

/** Agent luôn nộp patch cho trước, bất kể task. */
function fixedAgent(patch) {
  return () => ({ patch, roundsUsed: 1, tokensIn: 100, tokensOut: 50, tokensEstimated: false });
}

/** Agent "hoàn hảo": patch đúng cho cả 3 task mẫu. */
function perfectAgent(task) {
  const patch =
    task.id === 'v11-sample-add'
      ? V11_SAMPLE_PATCH_ADD
      : task.id === 'v11-sample-capitalize'
        ? V11_SAMPLE_PATCH_CAPITALIZE
        : `--- a/src/array.mjs\n+++ b/src/array.mjs\n@@ -1,3 +1,3 @@\n export function maxOf(arr) {\n-  return arr[0];\n+  return Math.max(...arr);\n }\n`;
  return { patch, roundsUsed: 1, tokensIn: 100, tokensOut: 50, tokensEstimated: false };
}

test('v11NewEvalRunId: định dạng v11eval-<hex 12> và duy nhất', () => {
  assert.match(v11NewEvalRunId(), /^v11eval-[0-9a-f]{12}$/);
  assert.notEqual(v11NewEvalRunId(), v11NewEvalRunId());
});

test('validateV11EvalTask: ném lỗi khi task thiếu id/file/test/fail-to-pass/weight', () => {
  assert.throws(() => validateV11EvalTask({ id: '', files: { 'a.mjs': 'x' }, tests: [{ name: 't', kind: 'fail-to-pass', command: ['node'] }] }), CodingV11Error);
  assert.throws(() => validateV11EvalTask({ id: 't', files: {}, tests: [{ name: 't', kind: 'fail-to-pass', command: ['node'] }] }), /không có file fixture/);
  assert.throws(() => validateV11EvalTask({ id: 't', files: { 'a.mjs': 'x' }, tests: [] }), /không có test/);
  assert.throws(
    () => validateV11EvalTask({ id: 't', files: { 'a.mjs': 'x' }, tests: [{ name: 't', kind: 'pass-to-pass', command: ['node'] }] }),
    /ít nhất một test fail-to-pass/,
  );
  assert.throws(
    () => validateV11EvalTask({ id: 't', files: { 'a.mjs': 'x' }, tests: [{ name: '', kind: 'fail-to-pass', command: ['node'] }] }),
    /thiếu tên/,
  );
  assert.throws(
    () => validateV11EvalTask({ id: 't', files: { 'a.mjs': 'x' }, tests: [{ name: 't', kind: 'fail-to-pass', command: [] }] }),
    /thiếu command/,
  );
  assert.throws(
    () => validateV11EvalTask({ id: 't', files: { 'a.mjs': 'x' }, tests: [{ name: 't', kind: 'fail-to-pass', command: ['node'], weight: 0 }] }),
    /weight không hợp lệ/,
  );
  assert.throws(
    () => validateV11EvalTask({ id: 't', files: { 'a.mjs': 'x' }, tests: [{ name: 't', kind: 'fail-to-pass', command: ['node'], weight: -2 }] }),
    /weight không hợp lệ/,
  );
  // Task mẫu hợp lệ thì không ném.
  for (const t of V11_EVAL_SAMPLE_TASKS) validateV11EvalTask(t);
});

test('v11SafeVersionName: chuẩn hoá tên version làm tên thư mục', () => {
  assert.equal(v11SafeVersionName('v11.2'), 'v11.2');
  assert.equal(v11SafeVersionName('  v11-rc1 '), 'v11-rc1');
  assert.equal(v11SafeVersionName('a b/c'), 'a-b-c');
  assert.equal(v11SafeVersionName('...v11'), 'v11');
  assert.throws(() => v11SafeVersionName(''), CodingV11Error);
  assert.throws(() => v11SafeVersionName('...'), CodingV11Error);
  assert.throws(() => v11SafeVersionName('   '), CodingV11Error);
});

test('runV11EvalAttempt: patch đúng → passed, score 1 (cả fail-to-pass lẫn pass-to-pass)', async () => {
  const r = await runV11EvalAttempt(ADD_TASK, { patch: V11_SAMPLE_PATCH_ADD, roundsUsed: 2, tokensIn: 120, tokensOut: 80 }, 1);
  assert.equal(r.attempt, 1);
  assert.equal(r.passed, true);
  assert.equal(r.score, 1);
  assert.equal(r.tests.length, 2);
  assert.ok(r.tests.every((t) => t.passed));
  assert.equal(r.roundsUsed, 2);
  assert.equal(r.error, undefined);
});

test('runV11EvalAttempt: patch sai → passed false, score 0, có failureExcerpt', async () => {
  const r = await runV11EvalAttempt(MAX_TASK, { patch: V11_SAMPLE_PATCH_MAX_WRONG, roundsUsed: 1 }, 1);
  assert.equal(r.passed, false);
  assert.equal(r.score, 0);
  assert.equal(r.tests.length, 1);
  assert.equal(r.tests[0].passed, false);
  assert.match(r.tests[0].failureExcerpt, /exit 1/);
});

test('runV11EvalAttempt: không nộp patch / patch không áp được → passed false + error', async () => {
  const empty = await runV11EvalAttempt(ADD_TASK, { patch: '   ', roundsUsed: 1 }, 1);
  assert.equal(empty.passed, false);
  assert.equal(empty.score, 0);
  assert.deepEqual(empty.tests, []);
  assert.match(empty.error, /không nộp patch/);

  const bad = await runV11EvalAttempt(
    ADD_TASK,
    { patch: '--- a/src/nope.mjs\n+++ b/src/nope.mjs\n@@ -1,1 +1,1 @@\n-x\n+y\n', roundsUsed: 1 },
    1,
  );
  assert.equal(bad.passed, false);
  assert.match(bad.error, /Patch không áp được/);
});

test('runV11EvalAttempt: partial credit — sửa 1/2 test, weight 3+1 → score 0.75, passed false', async () => {
  const task = {
    id: 'v11-partial',
    title: 'Sửa add và sub',
    files: {
      'src/calc.mjs': 'export function add(a, b) { return 0; }\nexport function sub(a, b) { return 0; }\n',
    },
    tests: [
      { name: 'add', kind: 'fail-to-pass', command: ['node', '-e', "import('./src/calc.mjs').then((m) => { if (m.add(1, 2) !== 3) process.exit(1); })"], weight: 3 },
      { name: 'sub', kind: 'fail-to-pass', command: ['node', '-e', "import('./src/calc.mjs').then((m) => { if (m.sub(5, 2) !== 3) process.exit(1); })"], weight: 1 },
    ],
  };
  const patchOnlyAdd = `--- a/src/calc.mjs\n+++ b/src/calc.mjs\n@@ -1,2 +1,2 @@\n-export function add(a, b) { return 0; }\n+export function add(a, b) { return a + b; }\n export function sub(a, b) { return 0; }\n`;
  const r = await runV11EvalAttempt(task, { patch: patchOnlyAdd, roundsUsed: 1 }, 1);
  assert.equal(r.passed, false);
  assert.equal(r.score, 0.75);
  assert.equal(r.tests[0].passed, true);
  assert.equal(r.tests[1].passed, false);
});

test('runV11EvalSuite: scripted agent 2/3 task, attemptsPerTask=1', async () => {
  const report = await runV11EvalSuite(V11_EVAL_SAMPLE_TASKS, scriptedV11Agent, { attemptsPerTask: 1 });
  assert.equal(report.version, 2);
  assert.equal(report.taskCount, 3);
  assert.equal(report.tasksPassed, 2);
  assert.equal(report.passAtK, 2 / 3);
  assert.equal(report.attemptPassRate, 2 / 3);
  assert.equal(report.avgScore, 2 / 3);
  assert.equal(report.flakyTasks, 0);
  assert.equal(report.attemptsPerTask, 1);
  assert.equal(report.tasks[0].anyPass, true);
  assert.equal(report.tasks[0].bestScore, 1);
  assert.equal(report.tasks[2].anyPass, false);
  assert.equal(report.tasks[2].bestScore, 0);
  assert.equal(report.avgRounds, 1);
  assert.equal(report.avgTokens, 200);
});

test('runV11EvalSuite: attemptsPerTask kẹp trong [1, 10]; suite rỗng / quá lớn thì ném', async () => {
  const one = await runV11EvalSuite([ADD_TASK], fixedAgent(V11_SAMPLE_PATCH_ADD), { attemptsPerTask: 0 });
  assert.equal(one.attemptsPerTask, 1);
  assert.equal(one.tasks[0].attempts.length, 1);
  const capped = await runV11EvalSuite([ADD_TASK], fixedAgent(V11_SAMPLE_PATCH_ADD), { attemptsPerTask: 99 });
  assert.equal(capped.attemptsPerTask, V11_EVAL_MAX_ATTEMPTS);
  assert.equal(capped.tasks[0].attempts.length, V11_EVAL_MAX_ATTEMPTS);
  await assert.rejects(() => runV11EvalSuite([], scriptedV11Agent), /suite rỗng/);
  const tooMany = Array.from({ length: V11_EVAL_MAX_TASKS_PER_SUITE + 1 }, () => ADD_TASK);
  await assert.rejects(() => runV11EvalSuite(tooMany, scriptedV11Agent), /vượt giới hạn/);
});

test('runV11EvalSuite detectFlaky: agent đổi kết quả giữa 2 lần chạy → flaky', async () => {
  const calls = new Map();
  const flipAgent = (task) => {
    const n = (calls.get(task.id) ?? 0) + 1;
    calls.set(task.id, n);
    // Lần gọi đầu nộp patch đúng, các lần sau nộp patch sai.
    const patch = n === 1 ? V11_SAMPLE_PATCH_ADD : V11_SAMPLE_PATCH_MAX_WRONG;
    return { patch, roundsUsed: 1, tokensIn: 10, tokensOut: 5 };
  };
  const report = await runV11EvalSuite([ADD_TASK], flipAgent, { attemptsPerTask: 1, detectFlaky: true });
  assert.equal(report.tasks[0].anyPass, true);
  assert.equal(report.tasks[0].flaky, true);
  assert.match(report.tasks[0].flakyDetail, /Lần chạy 1: pass/);
  assert.equal(report.flakyTasks, 1);
});

test('runV11EvalSuite detectFlaky: agent ổn định → không flaky', async () => {
  const report = await runV11EvalSuite([ADD_TASK], scriptedV11Agent, { attemptsPerTask: 1, detectFlaky: true });
  assert.equal(report.tasks[0].flaky, false);
  assert.equal(report.flakyTasks, 0);
});

test('save/load/list report theo phiên bản', async () => {
  const evalDir = tmpDir('v11-eval-save-');
  const report = await runV11EvalSuite(V11_EVAL_SAMPLE_TASKS, scriptedV11Agent, {
    attemptsPerTask: 1,
    evalDir,
    agentVersion: 'v11-test',
  });
  const filePath = path.join(evalDir, 'v11-test', 'report.json');
  assert.equal(fs.existsSync(filePath), true);
  const loaded = loadV11EvalReport(evalDir, 'v11-test');
  assert.equal(loaded.agentVersion, 'v11-test');
  assert.equal(loaded.tasksPassed, report.tasksPassed);
  assert.equal(loaded.passAtK, report.passAtK);
  assert.deepEqual(listV11EvalVersions(evalDir), ['v11-test']);
  assert.equal(loadV11EvalReport(evalDir, 'khong-co'), null);
  assert.deepEqual(listV11EvalVersions(tmpDir('v11-eval-empty-')), []);
  // save trực tiếp trả về đúng đường dẫn file.
  const direct = saveV11EvalReport(evalDir, { ...report, agentVersion: 'v11-direct' });
  assert.equal(direct, path.join(evalDir, 'v11-direct', 'report.json'));
  assert.deepEqual(listV11EvalVersions(evalDir), ['v11-test', 'v11-direct']);
});

test('compareV11EvalReports: perfect agent cải thiện task max, không regression', async () => {
  const older = await runV11EvalSuite(V11_EVAL_SAMPLE_TASKS, scriptedV11Agent, { attemptsPerTask: 1 });
  const newer = await runV11EvalSuite(V11_EVAL_SAMPLE_TASKS, perfectAgent, { attemptsPerTask: 1 });
  const cmp = compareV11EvalReports(older, newer);
  assert.equal(cmp.olderVersion, 'v11');
  assert.equal(cmp.newerVersion, 'v11');
  assert.deepEqual(cmp.improvements, ['v11-sample-max']);
  assert.deepEqual(cmp.regressions, []);
  assert.ok(Math.abs(cmp.passAtKDelta - 1 / 3) < 1e-9);
  assert.ok(cmp.avgScoreDelta > 0);
  assert.equal(cmp.changedTasks.length, 1);
  assert.equal(cmp.changedTasks[0].taskId, 'v11-sample-max');
  assert.equal(cmp.changedTasks[0].olderAnyPass, false);
  assert.equal(cmp.changedTasks[0].newerAnyPass, true);
  const text = renderV11EvalComparison(cmp);
  assert.match(text, /Cải thiện: v11-sample-max/);
  assert.doesNotMatch(text, /REGRESSION/);
});

test('compareV11EvalReports: regression khi phiên bản mới làm hỏng task từng pass', async () => {
  const older = await runV11EvalSuite(V11_EVAL_SAMPLE_TASKS, perfectAgent, { attemptsPerTask: 1 });
  const newer = await runV11EvalSuite(V11_EVAL_SAMPLE_TASKS, scriptedV11Agent, { attemptsPerTask: 1 });
  const cmp = compareV11EvalReports(older, newer);
  assert.deepEqual(cmp.regressions, ['v11-sample-max']);
  assert.deepEqual(cmp.improvements, []);
  assert.ok(Math.abs(cmp.passAtKDelta + 1 / 3) < 1e-9);
  assert.match(renderV11EvalComparison(cmp), /REGRESSION: v11-sample-max/);
});

test('render bảng + tóm tắt: đúng số liệu pass@k / avg score / flaky', async () => {
  const report = await runV11EvalSuite(V11_EVAL_SAMPLE_TASKS, scriptedV11Agent, { attemptsPerTask: 1 });
  const table = renderV11EvalVersionTable([report]);
  assert.match(table, /\| version \| pass@k \| avg score \| attempt pass \| tasks \| flaky \|/);
  assert.match(table, /\| v11 \| 67% \| 0\.67 \| 67% \| 2\/3 \| 0 \|/);
  const summary = v11SummarizeEvalReport(report);
  assert.match(summary, /v11: pass@k 67% \(2\/3\), avg score 0\.67, attempt pass 67%, flaky 0/);
  assert.equal(V11_EVAL_DEFAULT_ATTEMPTS, 3);
});
