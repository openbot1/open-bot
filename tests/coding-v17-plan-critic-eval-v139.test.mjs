/**
 * Tests cho coding agent v17 — Plan Mode + critic + review skill +
 * eval harness mở rộng (v1.39, Đội T4).
 *
 * Chạy thật: plan state machine thật, critic scorer thật trên
 * trajectory/patch mẫu, review rules thật, eval task thật chạy lệnh
 * trong tmpdir (không gọi model/mạng, không cần bwrap).
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v17-plan-critic-eval-v139.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderV17EvalSuiteReport,
  renderV17Plan,
  v17BuildVerificationReport,
  v17CheckPlanDeviation,
  v17CompletePlanStep,
  v17ContainsDestructiveCommand,
  v17ContainsSecret,
  v17CountDiffLines,
  v17CreatePlan,
  v17FinishPlan,
  v17PlanAllStepsDone,
  v17RefinePlan,
  v17RejectPlan,
  v17RequirePlanForTask,
  v17ReviewPatch,
  v17RunEvalSuite,
  v17RunEvalTask,
  v17ScorePatch,
  v17ScoreTrajectory,
  v17TransitionPlan,
  v17ValidatePlan,
} from '../packages/core/dist/index.js';

function planFixture() {
  return v17CreatePlan('task-1', 'Thêm tính năng X', [
    { title: 'Viết code', files: ['src/a.ts'] },
    { title: 'Viết test', files: ['tests/a.test.mjs', 'src/a.ts'] },
  ], 1000);
}

test('plan: tạo plan đa file, state machine chỉ cho chuyển hợp lệ', () => {
  const plan = planFixture();
  assert.equal(plan.status, 'draft');
  assert.equal(plan.multiFile, true);
  assert.equal(plan.fileCount, 2);
  assert.equal(plan.steps[0].id, 'step-1');
  // draft -> approved trực tiếp: KHÔNG hợp lệ.
  assert.throws(() => v17TransitionPlan(plan, 'approved'), /không thể chuyển/);
  // draft -> awaiting-approval -> approved: hợp lệ.
  const submitted = v17TransitionPlan(plan, 'awaiting-approval', 1001);
  assert.equal(submitted.status, 'awaiting-approval');
  const approved = v17TransitionPlan(submitted, 'approved', 1002);
  assert.equal(approved.status, 'approved');
  // approved -> done trực tiếp: KHÔNG hợp lệ (phải building + xong hết bước).
  assert.throws(() => v17TransitionPlan(approved, 'done'), /không thể chuyển/);
  // done là trạng thái cuối: không chuyển đi đâu được.
  const building = v17TransitionPlan(approved, 'building', 1003);
  const s1 = v17CompletePlanStep(building, 'step-1', 1004);
  assert.equal(s1.status, 'building');
  assert.equal(s1.steps[0].done, true);
  const s2 = v17CompletePlanStep(s1, 'step-2', 1005);
  assert.equal(v17PlanAllStepsDone(s2), true);
  const done = v17FinishPlan(s2, 1006);
  assert.equal(done.status, 'done');
  assert.throws(() => v17TransitionPlan(done, 'draft'), /không thể chuyển/);
});

test('plan: refine ghi lịch sử + đổi bước; reject cần lý do; validate chặn plan rỗng', () => {
  const plan = planFixture();
  const refined = v17RefinePlan(plan, 'Tách bước test thành 2 bước', (steps) => [
    ...steps,
    { id: 'step-3', title: 'Chạy lint', files: ['src/a.ts'], done: false },
  ], 2000);
  assert.equal(refined.status, 'refining');
  assert.equal(refined.steps.length, 3);
  assert.deepEqual(refined.refinements, ['Tách bước test thành 2 bước']);
  assert.throws(() => v17RefinePlan(refined, '', (s) => s), /mô tả thay đổi/);
  const rejected = v17RejectPlan(plan, 'Task chưa rõ yêu cầu', 2001);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectReason, 'Task chưa rõ yêu cầu');
  assert.throws(() => v17RejectPlan(plan, ''), /cần lý do/);
  assert.throws(() => v17CreatePlan('t', 'x', []), /ít nhất 1 bước/);
  assert.throws(() => v17ValidatePlan({ ...plan, steps: [] }), /ít nhất 1 bước/);
  assert.match(renderV17Plan(plan), /Plan plan-task-1 \(draft\)/);
});

test('plan: gate đa file — thiếu plan hoặc plan chưa duyệt đều bị chặn; đơn file không bắt buộc', () => {
  const plan = planFixture();
  // Không plan + đa file -> lỗi multi-file-required.
  assert.throws(
    () => v17RequirePlanForTask(['src/a.ts', 'src/b.ts']),
    /bắt buộc phải có plan/,
  );
  // Có plan nhưng draft -> lỗi not-approved.
  assert.throws(
    () => v17RequirePlanForTask(['src/a.ts', 'src/b.ts'], plan),
    /cần plan đã approved/,
  );
  const approved = v17TransitionPlan(v17TransitionPlan(plan, 'awaiting-approval'), 'approved');
  assert.equal(v17RequirePlanForTask(['src/a.ts', 'src/b.ts'], approved)?.id, plan.id);
  // Đơn file: không bắt buộc, trả undefined.
  assert.equal(v17RequirePlanForTask(['src/a.ts']), undefined);
  // Deviation: file ngoài plan bị flag.
  const check = v17CheckPlanDeviation(approved, ['src/a.ts', 'src/other.ts']);
  assert.deepEqual(check.deviations, ['src/other.ts']);
  assert.deepEqual(check.inPlan, ['src/a.ts']);
});

function trajectoryFixture() {
  const base = { sessionId: 's1', at: 1000, prevHash: '', hash: 'a'.repeat(64) };
  const mk = (seq, kind, payload) => ({ ...base, seq, kind, payload });
  const events = [
    mk(0, 'session_start', { task: 'fix' }),
    mk(1, 'prompt', { text: 'fix it' }),
    mk(2, 'bash', { command: 'npm test' }),
    mk(3, 'bash_output', { exitCode: 0, stdout: 'ok' }),
    mk(4, 'file_write', { path: 'src/a.ts', content: 'export const a = 1;\n' }),
    mk(5, 'test_result', { result: { testId: 't1', passed: true, exitCode: 0, stdout: '', stderr: '', durationMs: 5, timedOut: false } }),
    mk(6, 'session_end', { reason: 'done' }),
  ];
  const state = {
    sessionId: 's1',
    eventsReplayed: 7,
    files: { 'src/a.ts': 'export const a = 1;\n' },
    deletedFiles: [],
    bashCommands: ['npm test'],
    compilerErrors: [],
    lastTestResult: { testId: 't1', passed: true, exitCode: 0, stdout: '', stderr: '', durationMs: 5, timedOut: false },
    ended: true,
    endReason: 'done',
  };
  return { events, state };
}

test('critic: trajectory tốt chấm cao + approve; trajectory lỗi chưa xử lý bị trừ điểm', () => {
  const { events, state } = trajectoryFixture();
  const good = v17ScoreTrajectory('s1', events, state);
  assert.ok(good.score >= 70, `good score ${good.score}`);
  assert.equal(good.verdict, 'approve');
  assert.equal(good.axes.completeness, 100);
  assert.equal(good.unresolvedErrors, 0);
  // Trajectory tệ: chưa kết thúc, test fail, lỗi compiler treo, bash lặp, secret lộ.
  const badEvents = [
    { sessionId: 's1', seq: 0, kind: 'prompt', at: 1, payload: { text: 'x' }, prevHash: '', hash: 'a'.repeat(64) },
    { sessionId: 's1', seq: 1, kind: 'bash', at: 2, payload: { command: 'npm test' }, prevHash: '', hash: 'b'.repeat(64) },
    { sessionId: 's1', seq: 2, kind: 'bash', at: 3, payload: { command: 'npm test' }, prevHash: '', hash: 'c'.repeat(64) },
    { sessionId: 's1', seq: 3, kind: 'compiler_error', at: 4, payload: { message: 'TS2345 type error' }, prevHash: '', hash: 'd'.repeat(64) },
    { sessionId: 's1', seq: 4, kind: 'bash', at: 5, payload: { command: 'echo "api_key=abcdefghijklmnop123456"' }, prevHash: '', hash: 'e'.repeat(64) },
  ];
  const badState = {
    sessionId: 's1',
    eventsReplayed: 5,
    files: {},
    deletedFiles: [],
    bashCommands: ['npm test', 'npm test', 'echo "api_key=abcdefghijklmnop123456"'],
    compilerErrors: ['TS2345 type error'],
    ended: false,
  };
  const bad = v17ScoreTrajectory('s1', badEvents, badState);
  assert.ok(bad.score < 70, `bad score ${bad.score}`);
  assert.equal(bad.unresolvedErrors, 1);
  assert.equal(bad.wastedSteps, 1);
  assert.ok(bad.reasons.some((r) => /secret/.test(r)));
  assert.throws(() => v17ScoreTrajectory('s1', [], badState), /không có event/);
});

test('critic: quét secret + lệnh phá hoại; đếm diff lines', () => {
  assert.equal(v17ContainsSecret('const k = "sk-abcdefghijklmnop123456";'), true);
  assert.equal(v17ContainsSecret('const hello = "world";'), false);
  assert.equal(v17ContainsDestructiveCommand('rm -rf /'), 'rm -rf thư mục gốc/home');
  assert.equal(v17ContainsDestructiveCommand('npm test'), undefined);
  assert.deepEqual(v17CountDiffLines('+a\n+b\n-c\n--- x\n+++ y\n'), { added: 2, removed: 1 });
});

test('critic patch + review: patch sạch + eval pass -> approve; patch chứa secret + thiếu test -> block/review FAIL', () => {
  const cleanPatch = { 'src/a.ts': 'export const a = 1;\n' };
  const cleanDiff = '--- a/src/a.ts\n+++ b/src/a.ts\n+export const a = 1;\n';
  const cleanReview = v17ReviewPatch(cleanPatch, cleanDiff);
  // Clean patch sửa code nhưng không kèm test -> warning missing-tests, vẫn PASS (không error).
  assert.equal(cleanReview.passed, true);
  assert.equal(cleanReview.errors, 0);
  assert.ok(cleanReview.findings.some((f) => f.rule === 'missing-tests'));
  const cleanScore = v17ScorePatch(
    { 'src/a.ts': 'export const a = 1;\n', 'tests/a.test.mjs': 'test ok' },
    `${cleanDiff}\n--- a/tests/a.test.mjs\n+++ b/tests/a.test.mjs\n+test ok\n`,
    { evalReport: { taskId: 't', patchFiles: [], results: [], passed: 1, failed: 0, gatePassed: true, protectedViolations: [], missingRequiredFiles: [], deterministic: true, durationMs: 1, isolation: 'local' } },
  );
  assert.equal(cleanScore.axes.correctness, 100);
  assert.ok(cleanScore.score >= 70);
  assert.equal(cleanScore.verdict, 'approve');

  const badPatch = { 'src/a.ts': 'const key = "sk-abcdefghijklmnop123456";\n', '.env': 'API_KEY=x\n' };
  const badDiff = '--- a/src/a.ts\n+++ b/src/a.ts\n+const key = "sk-abcdefghijklmnop123456";\n';
  const badReview = v17ReviewPatch(badPatch, badDiff);
  assert.equal(badReview.passed, false);
  assert.ok(badReview.errors >= 2);
  assert.ok(badReview.findings.some((f) => f.rule === 'secret-in-diff'));
  assert.ok(badReview.findings.some((f) => f.rule === 'sensitive-file'));
  const badScore = v17ScorePatch(badPatch, badDiff, {});
  assert.ok(badScore.score < 70);
  assert.throws(() => v17ScorePatch({}, ''), /patch rỗng/);
  assert.throws(() => v17ReviewPatch({}, ''), /patch rỗng/);
});

test('verification report: allPassed chỉ khi mọi tầng pass', () => {
  const { events, state } = trajectoryFixture();
  const score = v17ScoreTrajectory('s1', events, state);
  const ok = v17BuildVerificationReport('s1', { trajectoryScore: score });
  assert.equal(ok.allPassed, true);
  assert.equal(ok.presentable, true);
  assert.deepEqual(ok.failingLayers, []);
  const failing = v17BuildVerificationReport('s1', {
    trajectoryScore: score,
    review: { passed: false, findings: [], errors: 1, warnings: 0, notes: 0, filesReviewed: 1 },
    eval: { taskId: 't', patchFiles: [], results: [], passed: 0, failed: 1, gatePassed: false, protectedViolations: [], missingRequiredFiles: [], deterministic: true, durationMs: 1, isolation: 'local' },
  });
  assert.equal(failing.allPassed, false);
  assert.deepEqual(failing.failingLayers, ['review-skill', 'eval-gate']);
});

function evalTaskFixture() {
  return {
    id: 'task-hello',
    title: 'Viết file hello.txt chứa hello',
    startFiles: { 'hello.txt': 'hi\n', 'test.sh': '#!/bin/sh\ngrep -q hello hello.txt\n' },
    tests: [
      { id: 'has-hello', command: 'sh test.sh', expectContains: '', expectExitCode: 0 },
    ],
    protectedFiles: ['test.sh'],
    requiredFiles: ['hello.txt'],
    determinismRuns: 2,
  };
}

test('eval: patch đúng -> gate PASS; patch sai -> gate FAIL; đổi protected -> vi phạm', async () => {
  const task = evalTaskFixture();
  const pass = await v17RunEvalTask(task, { 'hello.txt': 'hello world\n' });
  assert.equal(pass.gatePassed, true);
  assert.equal(pass.passed, 1);
  assert.equal(pass.failed, 0);
  assert.equal(pass.deterministic, true);
  assert.deepEqual(pass.protectedViolations, []);
  const fail = await v17RunEvalTask(task, { 'hello.txt': 'bye\n' });
  assert.equal(fail.gatePassed, false);
  assert.equal(fail.failed, 1);
  assert.match(fail.results[0].reason ?? '', /exit code/);
  const violated = await v17RunEvalTask(task, {
    'hello.txt': 'hello\n',
    'test.sh': '#!/bin/sh\nexit 0\n',
  });
  assert.equal(violated.gatePassed, false);
  assert.deepEqual(violated.protectedViolations, ['test.sh']);
  const missing = await v17RunEvalTask(
    { ...task, requiredFiles: ['hello.txt', 'missing.txt'] },
    { 'hello.txt': 'hello\n' },
  );
  assert.deepEqual(missing.missingRequiredFiles, ['missing.txt']);
  assert.equal(missing.gatePassed, false);
});

test('eval: validate chặn task không test / test trùng id / path thoát workspace', async () => {
  await assert.rejects(() => v17RunEvalTask({ id: 'x', title: 't', startFiles: {}, tests: [] }, {}), /ít nhất 1 test/);
  await assert.rejects(
    () => v17RunEvalTask({ id: 'x', title: 't', startFiles: {}, tests: [{ id: 'a', command: 'true' }, { id: 'a', command: 'true' }] }, {}),
    /test id trùng/,
  );
  await assert.rejects(
    () => v17RunEvalTask({ id: 'x', title: 't', startFiles: { '../escape.txt': 'x' }, tests: [{ id: 'a', command: 'true' }] }, {}),
    /không an toàn/,
  );
});

test('eval: flaky test (kết quả đổi giữa 2 lần chạy) bị gắn cờ non-deterministic', async () => {
  let calls = 0;
  const flakyExecutor = async (command, cwd, timeoutMs) => {
    calls += 1;
    // Lần chạy đầu pass, lần sau fail (đếm theo số lần gọi test command).
    const pass = calls % 2 === 1;
    return { exitCode: pass ? 0 : 1, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
  };
  const task = {
    id: 'task-flaky',
    title: 'Flaky',
    startFiles: {},
    tests: [{ id: 'coin', command: 'true' }],
    determinismRuns: 2,
  };
  const report = await v17RunEvalTask(task, {}, { executor: flakyExecutor });
  assert.equal(report.deterministic, false);
  assert.equal(report.gatePassed, false);
});

test('eval suite: chạy nhiều task, aggregate đúng; suite fail khi 1 task fail', async () => {
  const suite = await v17RunEvalSuite('suite-1', [evalTaskFixture(), {
    id: 'task-second',
    title: 'Second',
    startFiles: { 'a.txt': 'a\n' },
    tests: [{ id: 'has-a', command: 'grep -q a a.txt' }],
  }], { 'hello.txt': 'hello\n' });
  assert.equal(suite.tasksTotal, 2);
  assert.equal(suite.tasksPassed, 2);
  assert.equal(suite.suitePassed, true);
  assert.equal(suite.allDeterministic, true);
  assert.match(renderV17EvalSuiteReport(suite), /suite PASS/);
  const failing = await v17RunEvalSuite('suite-2', [evalTaskFixture()], { 'hello.txt': 'bye\n' });
  assert.equal(failing.suitePassed, false);
  assert.deepEqual(failing.failingTasks, ['task-hello']);
  await assert.rejects(() => v17RunEvalSuite('s', [], {}), /ít nhất 1 task/);
});
