/**
 * Tests for coding agent v5 — SWE-bench eval harness (v1.13, Doi T4):
 * `packages/core/src/codingV5/sweBenchEval.ts` (issue -> patch ->
 * test base/after, FAIL_TO_PASS / PASS_TO_PASS scoring, suite report,
 * save/load JSON).
 *
 * Runs the built-in sample tasks on real temp git repos — no
 * network. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v5-swe-eval.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODING_V5_SWE_SAMPLE_TASK_FIX_ADD,
  CODING_V5_SWE_SAMPLE_TASK_REGRESSION,
  CODING_V5_SWE_SAMPLE_TASK_WRONG_PATCH,
  CODING_V5_SWE_SAMPLE_TASKS,
  CodingV5SweHarness,
  compareCodingV5SweReports,
  listCodingV5SweReports,
  loadCodingV5SweReport,
  renderCodingV5SweComparison,
  renderCodingV5SweReport,
  saveCodingV5SweReport,
  validateCodingV5SweTask,
} from '../packages/core/dist/codingV5/sweBenchEval.js';

const harness = new CodingV5SweHarness();

test('sample task 1 (correct fix): PASS, failToPass met', async () => {
  const result = await harness.runTask(CODING_V5_SWE_SAMPLE_TASK_FIX_ADD);
  assert.equal(result.status, 'pass');
  assert.equal(result.patchApplied, true);
  assert.equal(result.failToPassPassed, 1);
  assert.equal(result.failToPassTotal, 1);
  assert.equal(result.workDirKept, false); // temp dir cleaned
  const run = result.tests[0];
  assert.equal(run.group, 'failToPass');
  assert.equal(run.basePassed, false); // failed on base (bug present)
  assert.equal(run.afterPassed, true); // passes after patch
  assert.equal(run.expectationMet, true);
  assert.match(result.reason, /Tat ca test cham diem dat/);
});

test('sample task 2 (wrong patch): FAIL, failToPass still failing', async () => {
  const result = await harness.runTask(CODING_V5_SWE_SAMPLE_TASK_WRONG_PATCH);
  assert.equal(result.status, 'fail');
  assert.equal(result.patchApplied, true);
  assert.equal(result.failToPassPassed, 0);
  assert.match(result.reason, /van fail sau patch/);
});

test('sample task 3 (regression): FAIL, passToPass broken by patch', async () => {
  const result = await harness.runTask(CODING_V5_SWE_SAMPLE_TASK_REGRESSION);
  assert.equal(result.status, 'fail');
  assert.equal(result.patchApplied, true);
  assert.equal(result.failToPassPassed, 1);
  assert.equal(result.passToPassPassed, 0);
  assert.match(result.reason, /bi pha vo sau patch/);
});

test('empty patch -> error (not fail), bad patch -> error', async () => {
  const empty = await harness.runTask({
    ...CODING_V5_SWE_SAMPLE_TASK_FIX_ADD,
    id: 'swe-empty-patch',
    patch: '',
  });
  assert.equal(empty.status, 'error');
  assert.equal(empty.patchApplied, false);
  assert.match(empty.reason, /Patch rong/);

  const bad = await harness.runTask({
    ...CODING_V5_SWE_SAMPLE_TASK_FIX_ADD,
    id: 'swe-bad-patch',
    patch:
      'diff --git a/nope.js b/nope.js\n--- a/nope.js\n+++ b/nope.js\n@@ -1 +1 @@\n-x\n+y\n',
  });
  assert.equal(bad.status, 'error');
  assert.equal(bad.patchApplied, false);
  assert.match(bad.reason, /khong apply duoc/);
});

test('validation: unknown test name, duplicate name, overlap -> error result in suite', async () => {
  const report = await harness.runSuite([
    {
      id: 'swe-bad-names',
      title: 'bad names',
      issue: 'x',
      patch: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n',
      testCommands: [{ name: 't1', argv: ['node', '-e', '1'] }],
      failToPass: ['no-such-test'],
      passToPass: [],
    },
    {
      ...CODING_V5_SWE_SAMPLE_TASK_FIX_ADD,
      id: 'swe-good-after-bad',
    },
  ]);
  assert.equal(report.totalTasks, 2);
  assert.equal(report.results[0].status, 'error');
  assert.match(report.results[0].reason, /khong ton tai/);
  assert.equal(report.results[1].status, 'pass');
});

test('runSuite on the 3 sample tasks: 1/3 pass, passRate 1/3, render + save/load', async (t) => {
  const report = await harness.runSuite(CODING_V5_SWE_SAMPLE_TASKS);
  assert.equal(report.totalTasks, 3);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 2);
  assert.equal(report.errored, 0);
  assert.equal(report.passRate, 1 / 3);
  assert.match(report.summary, /1\/3 task\(s\) pass/);
  const rendered = renderCodingV5SweReport(report);
  assert.match(rendered, /Pass rate: 33\.3%/);
  assert.match(rendered, /\[PASS\] swe-sample-fix-add/);
  assert.match(rendered, /\[FAIL\] swe-sample-wrong-patch/);
  assert.match(rendered, /\[FAIL\] swe-sample-regression/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-v5-swe-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saved = saveCodingV5SweReport(report, dir);
  assert.ok(fs.existsSync(saved));
  const loaded = loadCodingV5SweReport(saved);
  assert.equal(loaded.suiteId, report.suiteId);
  assert.equal(loaded.passed, 1);
  assert.deepEqual(
    loaded.results.map((r) => r.taskId),
    report.results.map((r) => r.taskId),
  );
  assert.throws(() => loadCodingV5SweReport(path.join(dir, 'nope.json')), /khong doc duoc|ENOENT/);
});

test('keepWorkDir keeps the temp repo for inspection', async (t) => {
  const result = await harness.runTask(CODING_V5_SWE_SAMPLE_TASK_FIX_ADD, { keepWorkDir: true });
  t.after(() => fs.rmSync(result.workDir, { recursive: true, force: true }));
  assert.equal(result.workDirKept, true);
  assert.ok(fs.existsSync(path.join(result.workDir, 'calc.js')));
  assert.ok(fs.existsSync(path.join(result.workDir, '.git')));
  assert.match(fs.readFileSync(path.join(result.workDir, 'calc.js'), 'utf8'), /return a \+ b/);
});

test('validateCodingV5SweTask accepts good tasks, rejects bad ones', () => {
  validateCodingV5SweTask(CODING_V5_SWE_SAMPLE_TASK_FIX_ADD);
  assert.throws(
    () => validateCodingV5SweTask({ ...CODING_V5_SWE_SAMPLE_TASK_FIX_ADD, failToPass: ['nope'] }),
    /khong ton tai/,
  );
  assert.throws(
    () =>
      validateCodingV5SweTask({
        ...CODING_V5_SWE_SAMPLE_TASK_FIX_ADD,
        testCommands: [
          { name: 'dup', argv: ['node', '-e', '1'] },
          { name: 'dup', argv: ['node', '-e', '1'] },
        ],
        failToPass: ['dup'],
      }),
    /cung name/,
  );
});

test('compare + list: report comparison finds fixed/regressed, list finds saved reports', async (t) => {
  const report = await harness.runSuite(CODING_V5_SWE_SAMPLE_TASKS);
  // Bao cao "sau": dao trang thai task 1 (pass -> fail) va task 2 (fail -> pass).
  const after = JSON.parse(JSON.stringify(report));
  after.suiteId = 'swe-suite-after';
  after.results[0].status = 'fail';
  after.results[1].status = 'pass';
  after.passed = 1;
  const cmp = compareCodingV5SweReports(report, after);
  assert.equal(cmp.passRateDelta, 0);
  assert.deepEqual(cmp.fixed, ['swe-sample-wrong-patch']);
  assert.deepEqual(cmp.regressed, ['swe-sample-fix-add']);
  assert.deepEqual(cmp.stillFailing, ['swe-sample-regression']);
  assert.deepEqual(cmp.onlyInBefore, []);
  assert.deepEqual(cmp.onlyInAfter, []);
  const rendered = renderCodingV5SweComparison(cmp);
  assert.match(rendered, /Fixed: swe-sample-wrong-patch/);
  assert.match(rendered, /Regressed: swe-sample-fix-add/);
  assert.match(rendered, /Still failing: swe-sample-regression/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-v5-swe-list-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(listCodingV5SweReports(dir), []);
  assert.deepEqual(listCodingV5SweReports(path.join(dir, 'nope')), []);
  saveCodingV5SweReport(report, dir);
  saveCodingV5SweReport(after, dir);
  const listed = listCodingV5SweReports(dir);
  assert.equal(listed.length, 2);
  assert.ok(listed.every((p) => p.endsWith('.json')));
});
