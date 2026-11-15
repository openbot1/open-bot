/**
 * Tests for the Harbor eval runner (packages/core/src/eval/harborRunner.ts
 * + harborReport.ts) — v1.11, Đội T2.
 *
 * Runs the real built-in tasks inside the real BotBoxManager sandbox
 * (bwrap on this Linux VM when available, otherwise plain run with
 * isolation reported honestly — the test asserts the reported
 * isolation matches reality, never a fake "isolated").
 *
 * Covers: scripted executor passes all 4 sample tasks (reward 1),
 * noop executor fails them (reward 0, honest baseline), a partially
 * correct agent gets a partial weighted reward, suite aggregation,
 * report persistence, markdown rendering, and the no-executor error.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-v111-harbor-runner.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { builtinHarborTasks, getBuiltinHarborTask } from '../packages/core/dist/eval/harborLibrary.js';
import {
  HarborRunner,
  getHarborReportsDir,
  harborBoxBotId,
  listHarborRunReports,
  noopHarborExecutor,
  saveHarborRunResult,
  saveHarborSuiteResult,
  scriptedHarborExecutor,
} from '../packages/core/dist/eval/harborRunner.js';
import {
  aggregateHarborResults,
  formatHarborRunSummary,
  renderHarborReportMarkdown,
} from '../packages/core/dist/eval/harborReport.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-harbor-run-'));
}

test('harborBoxBotId sanitizes task ids for directory names', () => {
  assert.equal(harborBoxBotId('sum-csv'), 'eval-sum-csv');
  assert.equal(harborBoxBotId('weird id!'), 'eval-weird-id-');
});

test('runner with scripted executor: hello-file passes with reward 1', async () => {
  const dir = tmpDir();
  const task = getBuiltinHarborTask('hello-file');
  assert.ok(task);
  const runner = new HarborRunner({
    baseDir: dir,
    executor: scriptedHarborExecutor({ 'greeting.txt': 'Hello, open-bot!\n' }),
  });
  const result = await runner.runTask(task, { profileId: 'general' });
  assert.equal(result.passed, true);
  assert.equal(result.reward, 1);
  assert.equal(result.testRun.passedCount, 2);
  assert.equal(result.error, null);
  assert.equal(result.rollout.taskId, 'hello-file');
  assert.equal(result.rollout.reward, 1);
  assert.ok(typeof result.isolation === 'string' && result.isolation.length > 0);
  assert.ok(result.durationMs >= 0);
  // The box dir is cleaned up after the run (keepBox=false default).
  assert.equal(fs.existsSync(path.join(dir, 'boxes', 'eval-hello-file')), false);
});

test('runner with scripted executor: sum-csv + fix-add + markdown-table all pass', async () => {
  const dir = tmpDir();
  const runner = new HarborRunner({
    baseDir: dir,
    executor: async (ctx) => {
      if (ctx.task.meta.id === 'sum-csv') return scriptedHarborExecutor({ 'result.txt': '50\n' })(ctx);
      if (ctx.task.meta.id === 'fix-add') {
        return scriptedHarborExecutor({
          'calc.py': 'def add(a, b):\n    return a + b\n\n\ndef subtract(a, b):\n    return a - b\n',
        })(ctx);
      }
      return scriptedHarborExecutor({
        'report.md': '# Report\n\n| Item | Price |\n| --- | ---: |\n| Bánh mì | 15000 |\n| Cà phê | 20000 |\n| Trà sữa | 30000 |\n\nTotal: 65000\n',
      })(ctx);
    },
  });
  for (const id of ['sum-csv', 'fix-add', 'markdown-table']) {
    const task = getBuiltinHarborTask(id);
    assert.ok(task, id);
    const result = await runner.runTask(task);
    assert.equal(result.passed, true, `${id}: ${JSON.stringify(result.testRun)}`);
    assert.equal(result.reward, 1, id);
  }
});

test('runner with noop executor: reward 0 for every sample task (honest baseline)', async () => {
  const dir = tmpDir();
  const runner = new HarborRunner({ baseDir: dir, executor: noopHarborExecutor });
  for (const task of builtinHarborTasks()) {
    const result = await runner.runTask(task);
    assert.equal(result.passed, false, task.meta.id);
    assert.equal(result.reward, 0, task.meta.id);
    assert.equal(result.error, null, task.meta.id);
    assert.equal(result.testRun.passedCount, 0, task.meta.id);
  }
});

test('runner: partially correct agent gets a partial weighted reward', async () => {
  const dir = tmpDir();
  const task = getBuiltinHarborTask('sum-csv');
  assert.ok(task);
  // result.txt exists but with the wrong sum: 2/4 weight (result-exists + plain-number).
  const runner = new HarborRunner({
    baseDir: dir,
    executor: scriptedHarborExecutor({ 'result.txt': '41\n' }),
  });
  const result = await runner.runTask(task);
  assert.equal(result.passed, false);
  assert.equal(result.reward, 0.5);
  assert.deepEqual(
    result.testRun.perTest.map((t) => [t.name, t.passed]),
    [['correct-sum', false], ['plain-number', true], ['result-exists', true]],
  );
});

test('runner without an executor throws a clear error instead of faking a run', async () => {
  const dir = tmpDir();
  const task = getBuiltinHarborTask('hello-file');
  assert.ok(task);
  const runner = new HarborRunner({ baseDir: dir });
  await assert.rejects(() => runner.runTask(task), /executor/);
});

test('runner rejects an invalid task instead of running it', async () => {
  const dir = tmpDir();
  const task = getBuiltinHarborTask('hello-file');
  assert.ok(task);
  const runner = new HarborRunner({ baseDir: dir, executor: noopHarborExecutor });
  await assert.rejects(
    () => runner.runTask({ ...task, meta: { ...task.meta, testWeights: {} } }),
    /không hợp lệ/,
  );
});

test('runSuite: sequential run of all 4 tasks, aggregate + save + markdown', async () => {
  const dir = tmpDir();
  const runner = new HarborRunner({
    baseDir: path.join(dir, 'eval-harbor'),
    executor: async (ctx) => {
      const files = {
        'hello-file': { 'greeting.txt': 'Hello, open-bot!\n' },
        'sum-csv': { 'result.txt': '50\n' },
        'fix-add': { 'calc.py': 'def add(a, b):\n    return a + b\n' },
        'markdown-table': { 'report.md': '# R\n\n| A | B |\n|---|---|\n| Bánh mì | 15000 |\n| Cà phê | 20000 |\n| Trà sữa | 30000 |\n\n65000\n' },
      };
      return scriptedHarborExecutor(files[ctx.task.meta.id] ?? {})(ctx);
    },
  });
  const suite = await runner.runSuite(builtinHarborTasks(), { profileId: 'coding' });
  assert.equal(suite.results.length, 4);
  assert.equal(suite.passed, 4);
  assert.equal(suite.passRate, 1);
  assert.equal(suite.meanReward, 1);
  assert.ok(suite.durationMs >= 0);
  const suitePath = saveHarborSuiteResult(dir, suite);
  assert.ok(fs.existsSync(suitePath));
  for (const result of suite.results) {
    const reportPath = saveHarborRunResult(dir, result);
    assert.ok(fs.existsSync(reportPath));
  }
  assert.equal(listHarborRunReports(dir).length, 5);
  assert.equal(getHarborReportsDir(dir), path.join(dir, 'eval-harbor-reports'));
  const aggregate = aggregateHarborResults(suite.results);
  assert.equal(aggregate.runs, 4);
  assert.equal(aggregate.passRate, 1);
  assert.equal(aggregate.byTask.length, 4);
  assert.equal(aggregate.byProfile.length, 1);
  assert.equal(aggregate.byProfile[0].profileId, 'coding');
  const markdown = renderHarborReportMarkdown(aggregate);
  assert.ok(markdown.includes('# Harbor eval report'));
  assert.ok(markdown.includes('sum-csv'));
  assert.ok(markdown.includes('Pass rate: 100.0%'));
  const summary = formatHarborRunSummary(suite.results[0]);
  assert.ok(summary.includes('[PASS]'));
  assert.ok(summary.includes('reward=1.000'));
});

test('aggregateHarborResults: empty input is a valid zero report', () => {
  const aggregate = aggregateHarborResults([]);
  assert.equal(aggregate.runs, 0);
  assert.equal(aggregate.passRate, 0);
  assert.equal(aggregate.meanReward, 0);
  assert.deepEqual(aggregate.byTask, []);
  assert.ok(renderHarborReportMarkdown(aggregate).includes('Runs: 0'));
});
