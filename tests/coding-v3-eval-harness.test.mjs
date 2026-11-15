/**
 * Tests for coding agent v3 — eval harness (v1.10, Đội T4):
 * `packages/core/src/codingV3/evalHarness.ts` (Terminal-Bench style:
 * task + setup/test commands in a temp dir, pass/fail/error scoring).
 *
 * Sample tasks run for real (node -e in temp dirs) — no network, no
 * live services. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v3-eval-harness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  CodingV3EvalHarness,
  CODING_V3_SAMPLE_TASKS,
  CODING_V3_SAMPLE_TASK_ADD,
  CODING_V3_SAMPLE_TASK_CREATE,
  CODING_V3_SAMPLE_TASK_FIX,
} from '../packages/core/dist/codingV3/evalHarness.js';

const harness = new CodingV3EvalHarness();

test('sample tasks: all 3 run for real and pass', async () => {
  const report = await harness.runSuite(CODING_V3_SAMPLE_TASKS);
  assert.equal(report.totalTasks, 3);
  assert.equal(report.passed, 3, JSON.stringify(report.results.map((r) => [r.taskId, r.status, r.reason])));
  assert.equal(report.failed, 0);
  assert.equal(report.errored, 0);
  assert.equal(report.passRate, 1);
  assert.match(report.summary, /3\/3 task\(s\) pass/);
  for (const result of report.results) {
    assert.equal(result.workDirKept, false, 'temp dir deleted by default');
    assert.ok(result.durationMs >= 0);
  }
});

test('sample task add: single run passes, stdout captured', async () => {
  const result = await harness.runTask(CODING_V3_SAMPLE_TASK_ADD);
  assert.equal(result.status, 'pass');
  assert.equal(result.passedTests, 1);
  assert.equal(result.totalTests, 1);
  assert.match(result.tests[0].stdout, /add ok/);
  assert.equal(result.tests[0].exitCode, 0);
  assert.equal(result.tests[0].timedOut, false);
});

test('sample task fix: setup rewrites the buggy fixture, then test passes', async () => {
  const result = await harness.runTask(CODING_V3_SAMPLE_TASK_FIX);
  assert.equal(result.status, 'pass');
  assert.equal(result.setup.length, 1);
  assert.equal(result.setup[0].passed, true);
  assert.match(result.setup[0].stdout, /fixed/);
  assert.match(result.tests[0].stdout, /sub ok/);
});

test('sample task create: 2 test commands both pass', async () => {
  const result = await harness.runTask(CODING_V3_SAMPLE_TASK_CREATE);
  assert.equal(result.status, 'pass');
  assert.equal(result.tests.length, 2);
  assert.equal(result.passedTests, 2);
});

test('failing test command => status fail (not error)', async () => {
  const result = await harness.runTask({
    id: 'fail-task',
    title: 'Always fails',
    testCommands: [
      { name: 'exit 1', argv: [process.execPath, '-e', 'process.exit(1);'] },
    ],
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.tests[0].exitCode, 1);
  assert.equal(result.tests[0].passed, false);
  assert.match(result.reason, /exit 1/);
});

test('failing setup command => status error (infra, not a fail)', async () => {
  const result = await harness.runTask({
    id: 'setup-fail',
    title: 'Setup fails',
    setupCommands: [{ name: 'bad setup', argv: [process.execPath, '-e', 'process.exit(2);'] }],
    testCommands: [{ name: 'never runs', argv: [process.execPath, '-e', 'console.log("x")'] }],
  });
  assert.equal(result.status, 'error');
  assert.equal(result.setup[0].passed, false);
  assert.equal(result.tests.length, 0, 'tests do not run after setup failure');
  assert.match(result.reason, /Setup "bad setup" exit 2/);
});

test('timeout: a hanging test is killed and reported as fail + timedOut', async () => {
  const result = await harness.runTask({
    id: 'timeout-task',
    title: 'Hangs forever',
    timeoutMs: 500,
    testCommands: [{ name: 'sleep', argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000);'] }],
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.tests[0].timedOut, true);
  assert.ok(result.tests[0].durationMs < 5000, `killed promptly, took ${result.tests[0].durationMs}ms`);
});

test('fixtures are written before setup; keepWorkDir keeps the temp dir', async () => {
  const result = await harness.runTask(
    {
      id: 'fixture-task',
      title: 'Fixture check',
      fixtures: { 'data.txt': 'hello fixture\n' },
      testCommands: [
        {
          name: 'read fixture',
          argv: [process.execPath, '-e', `const fs = require('fs'); if (fs.readFileSync('./data.txt', 'utf8') !== 'hello fixture\\n') process.exit(1); console.log('fixture ok');`],
        },
      ],
    },
    { keepWorkDir: true },
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.workDirKept, true);
  assert.equal(fs.readFileSync(`${result.workDir}/data.txt`, 'utf8'), 'hello fixture\n');
  fs.rmSync(result.workDir, { recursive: true, force: true });
});

test('invalid task: no test commands, bad id, fixture escaping workDir are rejected', async () => {
  await assert.rejects(
    harness.runTask({ id: 'no-tests', title: 'x', testCommands: [] }),
    /ít nhất 1 test command/,
  );
  await assert.rejects(
    harness.runTask({ id: 'Bad ID!', title: 'x', testCommands: [{ name: 't', argv: ['node', '-e', ''] }] }),
    /chỉ dùng chữ thường/,
  );
  // Fixture thoát workDir: lỗi lúc chạy, trả result error (không throw).
  const escaped = await harness.runTask({
    id: 'escape-fixture',
    title: 'x',
    fixtures: { '../evil.txt': 'x' },
    testCommands: [{ name: 't', argv: [process.execPath, '-e', ''] }],
  });
  assert.equal(escaped.status, 'error');
  assert.match(escaped.reason, /thoát khỏi workDir/);
});

test('suite: an invalid task becomes an error result, the suite keeps running', async () => {
  const report = await harness.runSuite([
    CODING_V3_SAMPLE_TASK_ADD,
    { id: 'broken', title: 'Broken', testCommands: [] },
    CODING_V3_SAMPLE_TASK_CREATE,
  ]);
  assert.equal(report.totalTasks, 3);
  assert.equal(report.passed, 2);
  assert.equal(report.errored, 1);
  assert.equal(report.results[1].status, 'error');
});
