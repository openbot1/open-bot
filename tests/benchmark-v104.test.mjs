/**
 * Tests for the benchmark harness (packages/core/src/observability/benchmark.ts).
 *
 * Covers config/task/outcome validation, percentile math, per-config
 * summaries (accuracy/latency/cost), running the same tasks across
 * configs, winners per metric, uniquely-passed / failed-by-all
 * detection, runner errors (a failing cell does not crash the run),
 * and Markdown rendering.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/benchmark-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  benchmarkReportToMarkdown,
  percentile,
  runBenchmark,
  summarizeBenchmarkConfig,
  validateBenchmarkConfig,
  validateBenchmarkOutcome,
  validateBenchmarkTask,
} from '../packages/core/dist/observability/benchmark.js';

const CONFIGS = [
  { id: 'cfg-fast', label: 'Fast · Scripted', model: 'local:fast', harness: 'scripted' },
  { id: 'cfg-accurate', label: 'Accurate · CodeAct', model: 'gpt-5', harness: 'codeact' },
  { id: 'cfg-unknown', label: 'Unknown price · CLI', model: 'mystery-model-xyz', harness: 'cli' },
];
const TASKS = [
  { id: 't1', title: 'Task one' },
  { id: 't2', title: 'Task two' },
  { id: 't3', title: 'Task three' },
];

/** Deterministic runner: outcome depends only on (config, task). */
function makeRunner() {
  return async (config, task) => {
    if (config.id === 'cfg-fast') {
      // Fast + cheap, passes t1 and t3, slow-ish on t2 and fails it.
      if (task.id === 't2') return { passed: false, durationMs: 800, inputTokens: 100, outputTokens: 50 };
      return { passed: true, durationMs: 200, inputTokens: 100, outputTokens: 50 };
    }
    if (config.id === 'cfg-accurate') {
      // Passes everything, but slow and token-hungry.
      return { passed: true, durationMs: 2000, inputTokens: 2000, outputTokens: 1000 };
    }
    // Unknown-price model: passes t1 only.
    return { passed: task.id === 't1', durationMs: 500, inputTokens: 300, outputTokens: 100 };
  };
}

test('benchmark: validation rejects bad configs/tasks/outcomes', () => {
  assert.throws(() => validateBenchmarkConfig({}), /id/);
  assert.throws(() => validateBenchmarkConfig({ ...CONFIGS[0], model: '' }), /model/);
  assert.throws(() => validateBenchmarkTask({ id: 'x' }), /title/);
  assert.throws(() => validateBenchmarkOutcome({ passed: 'yes', durationMs: 1, inputTokens: 0, outputTokens: 0 }), /boolean/);
  assert.throws(() => validateBenchmarkOutcome({ passed: true, durationMs: -1, inputTokens: 0, outputTokens: 0 }), /durationMs/);
  assert.throws(() => validateBenchmarkOutcome({ passed: true, durationMs: 1, inputTokens: 0 }), /outputTokens/);
});

test('benchmark: percentile interpolates (p50/p95)', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([0, 100], 50), 50);
  assert.ok(Math.abs(percentile([0, 10, 20, 30], 95) - 28.5) < 1e-9, 'p95 interpolates to 28.5 (float tolerance)');
  assert.throws(() => percentile([1, 2], 101), /between 0 and 100/);
});

test('benchmark: summarizeBenchmarkConfig aggregates one config', () => {
  const cells = [
    { configId: 'c1', taskId: 't1', passed: true, durationMs: 100, inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    { configId: 'c1', taskId: 't2', passed: false, durationMs: 300, inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    { configId: 'c1', taskId: 't3', passed: true, durationMs: 200, inputTokens: 10, outputTokens: 5, costUsd: null },
  ];
  const summary = summarizeBenchmarkConfig({ id: 'c1', label: 'C1', model: 'gpt-5', harness: 'codeact' }, cells);
  assert.equal(summary.tasksRun, 3);
  assert.equal(summary.tasksPassed, 2);
  assert.equal(summary.accuracy, 2 / 3);
  assert.equal(summary.meanLatencyMs, 200);
  assert.equal(summary.totalInputTokens, 30);
  assert.equal(summary.costIncomplete, true, 'one cell without a price makes cost incomplete');
  assert.equal(summary.costPerPassedTaskUsd, 0.001);
  const empty = summarizeBenchmarkConfig({ id: 'c1', label: 'C1', model: 'gpt-5', harness: 'codeact' }, []);
  assert.equal(empty.accuracy, null);
  assert.equal(empty.meanLatencyMs, null);
  assert.equal(empty.totalCostUsd, null);
});

test('benchmark: runBenchmark compares configs on the same tasks', async () => {
  const report = await runBenchmark(CONFIGS, TASKS, makeRunner());
  assert.equal(report.cells.length, 9, '3 configs x 3 tasks');
  assert.equal(report.tasks.length, 3);
  const byId = Object.fromEntries(report.summaries.map((s) => [s.configId, s]));
  assert.equal(byId['cfg-fast'].tasksPassed, 2);
  assert.equal(byId['cfg-accurate'].tasksPassed, 3);
  assert.equal(byId['cfg-accurate'].accuracy, 1);
  assert.equal(byId['cfg-unknown'].tasksPassed, 1);
  // Local model costs $0 by definition.
  assert.equal(byId['cfg-fast'].totalCostUsd, 0);
  assert.equal(byId['cfg-fast'].costIncomplete, false);
  // Unknown-price model: cost null, flagged incomplete.
  assert.equal(byId['cfg-unknown'].totalCostUsd, null);
  assert.equal(byId['cfg-unknown'].costIncomplete, true);
  // Winners: accurate wins accuracy, fast wins latency AND cost.
  assert.equal(report.winners.accuracy, 'cfg-accurate');
  assert.equal(report.winners.latency, 'cfg-fast');
  assert.equal(report.winners.cost, 'cfg-fast');
  // t2 is passed only by cfg-accurate (unique); nothing fails for all.
  assert.deepEqual(report.failedByAll, []);
  assert.deepEqual(report.uniquelyPassed, [{ taskId: 't2', configId: 'cfg-accurate' }]);
});

test('benchmark: failed-by-all tasks and runner errors', async () => {
  const tasks = [...TASKS, { id: 't-hard', title: 'Impossible task' }];
  const runner = async (config, task) => {
    if (task.id === 't-hard') return { passed: false, durationMs: 10, inputTokens: 0, outputTokens: 0 };
    if (config.id === 'cfg-fast' && task.id === 't2') throw new Error('runner crashed');
    return { passed: true, durationMs: 100, inputTokens: 10, outputTokens: 5 };
  };
  const report = await runBenchmark(CONFIGS, tasks, runner);
  assert.deepEqual(report.failedByAll, ['t-hard']);
  const crashed = report.cells.find((c) => c.configId === 'cfg-fast' && c.taskId === 't2');
  assert.equal(crashed.passed, false, 'a throwing runner becomes a failed cell, not a crashed benchmark');
  assert.equal(report.summaries.find((s) => s.configId === 'cfg-fast').tasksPassed, 2);
});

test('benchmark: duplicate ids and empty inputs are rejected', async () => {
  await assert.rejects(() => runBenchmark([], TASKS, makeRunner()), /at least one config/);
  await assert.rejects(() => runBenchmark(CONFIGS, [], makeRunner()), /at least one task/);
  await assert.rejects(
    () => runBenchmark([CONFIGS[0], CONFIGS[0]], TASKS, makeRunner()),
    /unique/,
  );
  await assert.rejects(
    () => runBenchmark(CONFIGS, [TASKS[0], TASKS[0]], makeRunner()),
    /unique/,
  );
});

test('benchmark: Markdown report shows all three axes', async () => {
  const report = await runBenchmark(CONFIGS, TASKS, makeRunner());
  const md = benchmarkReportToMarkdown(report);
  assert.match(md, /# Benchmark report/);
  assert.match(md, /Accuracy \| Mean latency \| p95 latency \| Total cost/);
  assert.match(md, /Fast · Scripted/);
  assert.match(md, /66\.7% \(2\/3\)/);
  assert.match(md, /Winners — accuracy: \*\*Accurate · CodeAct\*\*/);
  assert.match(md, /Uniquely passed tasks/);
  assert.match(md, /never invented/);
});
