/**
 * Tests for Eval Harness v4 dashboard (v1.44, Đội T2):
 * `packages/core/src/evalHarnessV4/dashboard.ts`.
 *
 * Covers: slope (least squares) + direction from slope/halves,
 * per-task trend (flaky, always-failing, consecutive failures),
 * dashboard build from records (suite trend, worst/best lists,
 * latest regressions wired in, empty history), markdown render,
 * HTML render (standalone, escaped, contains all tasks, bar
 * chart), HTML escaping of hostile task ids/details.
 *
 * Pure computation — no disk, no sandbox, no model.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-harness-v4-dashboard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultEvalHarnessV4Config, defaultEvalHarnessV4Thresholds } from '../packages/core/dist/evalHarnessV4/config.js';
import {
  buildEvalHarnessV4Dashboard,
  buildEvalHarnessV4TaskTrend,
  computeEvalHarnessV4Slope,
  escapeEvalHarnessV4Html,
  renderEvalHarnessV4DashboardHtml,
  renderEvalHarnessV4DashboardMarkdown,
  trendDirectionFromHalves,
  trendDirectionFromSlope,
} from '../packages/core/dist/evalHarnessV4/dashboard.js';

function point(runId, at, reward, passed) {
  return { runId, at, reward, passed };
}

function taskResult(taskId, reward, passed) {
  return {
    taskId,
    taskVersion: 1,
    taskName: taskId,
    taskKind: 'coding',
    source: 'builtin-v4',
    attempts: [
      {
        attempt: 1,
        rolloutId: `roll-${taskId}`,
        startedAt: 1000,
        finishedAt: 1100,
        durationMs: 100,
        passed,
        reward,
        perTest: [],
        isolation: 'none',
        testExitCode: passed ? 0 : 1,
        timedOut: false,
        error: null,
        promptTokens: 0,
        completionTokens: 0,
      },
    ],
    passes: passed ? 1 : 0,
    passed,
    allPassed: passed,
    flaky: false,
    meanReward: reward,
    bestReward: reward,
    worstReward: reward,
    meanDurationMs: 100,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    failingTests: passed ? [] : ['content-ok'],
  };
}

function runRecord(runId, startedAt, tasks) {
  const passed = tasks.filter((t) => t.passed).length;
  return {
    format: 'eval-harness-v4',
    runId,
    configName: 'test',
    startedAt,
    finishedAt: startedAt + 1000,
    durationMs: 1000,
    configSnapshot: defaultEvalHarnessV4Config(),
    tasks,
    skipped: [],
    passed,
    failed: tasks.length - passed,
    total: tasks.length,
    passRate: tasks.length > 0 ? passed / tasks.length : 0,
    meanReward: tasks.length > 0 ? tasks.reduce((sum, t) => sum + t.meanReward, 0) / tasks.length : 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    flakyTasks: 0,
    isolationModes: ['none'],
    note: '',
  };
}

test('slope: flat, rising, falling, too few points', () => {
  assert.equal(computeEvalHarnessV4Slope([]), 0);
  assert.equal(computeEvalHarnessV4Slope([point('r1', 1, 0.5, false)]), 0);
  const flat = [point('r1', 1, 0.5, false), point('r2', 2, 0.5, false), point('r3', 3, 0.5, false)];
  assert.ok(Math.abs(computeEvalHarnessV4Slope(flat)) < 1e-9);
  const rising = [point('r1', 1, 0, false), point('r2', 2, 0.5, false), point('r3', 3, 1, true)];
  assert.ok(Math.abs(computeEvalHarnessV4Slope(rising) - 0.5) < 1e-9);
  const falling = [point('r1', 1, 1, true), point('r2', 2, 0.5, false), point('r3', 3, 0, false)];
  assert.ok(Math.abs(computeEvalHarnessV4Slope(falling) + 0.5) < 1e-9);
});

test('direction: slope epsilon and halves', () => {
  assert.equal(trendDirectionFromSlope(0.05), 'improving');
  assert.equal(trendDirectionFromSlope(-0.05), 'worsening');
  assert.equal(trendDirectionFromSlope(0.01), 'stable');
  assert.equal(trendDirectionFromSlope(0), 'stable');
  assert.equal(trendDirectionFromHalves([]), 'stable');
  assert.equal(trendDirectionFromHalves([0.5]), 'stable');
  assert.equal(trendDirectionFromHalves([0, 0, 1, 1]), 'improving');
  assert.equal(trendDirectionFromHalves([1, 1, 0, 0]), 'worsening');
  assert.equal(trendDirectionFromHalves([0.5, 0.5, 0.5, 0.5]), 'stable');
});

test('task trend: flaky, always-failing, consecutive failures, mean/last', () => {
  const flaky = buildEvalHarnessV4TaskTrend('a', 'a', [
    point('r1', 1, 1, true),
    point('r2', 2, 0, false),
    point('r3', 3, 1, true),
  ], 3);
  assert.equal(flaky.flaky, true);
  assert.equal(flaky.alwaysFailing, false);
  assert.equal(flaky.consecutiveFailures, 0);
  assert.equal(flaky.passRate, 2 / 3);
  assert.equal(flaky.runs, 3);
  assert.ok(Math.abs(flaky.meanReward - 2 / 3) < 1e-9);
  assert.equal(flaky.lastReward, 1);
  assert.equal(flaky.firstReward, 1);

  const failing = buildEvalHarnessV4TaskTrend('b', 'b', [
    point('r1', 1, 1, true),
    point('r2', 2, 0, false),
    point('r3', 3, 0, false),
    point('r4', 4, 0, false),
  ], 3);
  assert.equal(failing.flaky, true);
  assert.equal(failing.consecutiveFailures, 3);
  assert.equal(failing.alwaysFailing, true);
  assert.equal(failing.direction, 'worsening');

  const fresh = buildEvalHarnessV4TaskTrend('c', 'c', [], 3);
  assert.equal(fresh.runs, 0);
  assert.equal(fresh.lastReward, null);
  assert.equal(fresh.direction, 'stable');
});

test('dashboard: empty history renders without crashing', () => {
  const dashboard = buildEvalHarnessV4Dashboard([], { thresholds: defaultEvalHarnessV4Thresholds() });
  assert.equal(dashboard.runs, 0);
  assert.equal(dashboard.latestRunId, null);
  assert.equal(dashboard.gate, 'pass');
  assert.deepEqual(dashboard.tasks, []);
  const md = renderEvalHarnessV4DashboardMarkdown(dashboard);
  assert.ok(md.includes('# Eval Harness v4'));
  assert.ok(md.includes('0'));
  const html = renderEvalHarnessV4DashboardHtml(dashboard);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(!html.includes('http://') && !html.includes('https://'));
});

test('dashboard: suite trend, worsening/flaky/always-failing lists, latest regressions', () => {
  const thresholds = defaultEvalHarnessV4Thresholds();
  const records = [
    runRecord('v4-r1', 1000, [taskResult('good', 1, true), taskResult('bad', 1, true), taskResult('flaky', 1, true)]),
    runRecord('v4-r2', 2000, [taskResult('good', 1, true), taskResult('bad', 0.5, false), taskResult('flaky', 0, false)]),
    runRecord('v4-r3', 3000, [taskResult('good', 1, true), taskResult('bad', 0, false), taskResult('flaky', 1, true)]),
  ];
  const dashboard = buildEvalHarnessV4Dashboard(records, { thresholds });
  assert.equal(dashboard.runs, 3);
  assert.equal(dashboard.latestRunId, 'v4-r3');
  assert.equal(dashboard.suite.latestPassRate, 2 / 3);
  assert.equal(dashboard.suite.direction, 'worsening');
  assert.deepEqual(dashboard.flakyTasks, ['bad', 'flaky']);
  assert.deepEqual(dashboard.worseningTasks, ['bad']);
  assert.deepEqual(dashboard.improvingTasks, []);
  assert.deepEqual(dashboard.alwaysFailingTasks, []);
  // Run mới nhất so với run trước: bad sụt reward 0.5 -> 0 (blocker),
  // flaky từ fail thành pass (cải thiện).
  assert.ok(dashboard.latestRegressions.some((r) => r.taskId === 'bad' && r.kind === 'reward-drop' && r.severity === 'blocker'));
  assert.equal(dashboard.latestImprovements.length, 1);
  assert.equal(dashboard.latestImprovements[0].taskId, 'flaky');
  assert.equal(dashboard.gate, 'block'); // có blocker + pass rate 2/3 < min 0.8
  const good = dashboard.tasks.find((t) => t.taskId === 'good');
  assert.equal(good?.direction, 'stable');
  assert.equal(good?.passRate, 1);
  const bad = dashboard.tasks.find((t) => t.taskId === 'bad');
  assert.equal(bad?.direction, 'worsening');
  assert.equal(bad?.consecutiveFailures, 2);
  const md = renderEvalHarnessV4DashboardMarkdown(dashboard);
  assert.ok(md.includes('| good | 3 | 100% | 1.00 | 1.00 |'));
  assert.ok(md.includes('Flaky (lúc pass lúc fail'));
  const html = renderEvalHarnessV4DashboardHtml(dashboard);
  assert.ok(html.includes('<td>bad</td>'));
  assert.ok(html.includes('gate-block'));
  assert.ok(html.includes('class="bar"'));
});

test('dashboard: always-failing task appears after threshold runs', () => {
  const thresholds = { ...defaultEvalHarnessV4Thresholds(), alwaysFailingRuns: 2 };
  const records = [
    runRecord('v4-r1', 1000, [taskResult('dead', 0, false)]),
    runRecord('v4-r2', 2000, [taskResult('dead', 0, false)]),
  ];
  const dashboard = buildEvalHarnessV4Dashboard(records, { thresholds });
  assert.deepEqual(dashboard.alwaysFailingTasks, ['dead']);
  assert.equal(dashboard.gate, 'block');
});

test('dashboard: explicit baseline is used for latest regressions', () => {
  const thresholds = defaultEvalHarnessV4Thresholds();
  const r1 = runRecord('v4-r1', 1000, [taskResult('a', 1, true), taskResult('b', 1, true)]);
  const r2 = runRecord('v4-r2', 2000, [taskResult('a', 1, true), taskResult('b', 1, true)]);
  const r3 = runRecord('v4-r3', 3000, [taskResult('a', 0, false), taskResult('b', 1, true)]);
  // Baseline mặc định (run trước): a pass->fail = blocker.
  const d1 = buildEvalHarnessV4Dashboard([r1, r2, r3], { thresholds });
  assert.ok(d1.latestRegressions.some((r) => r.taskId === 'a' && r.severity === 'blocker'));
  assert.equal(d1.baselineRunId, 'v4-r2');
  // Baseline r1 (a vẫn pass ở r1): cũng blocker.
  const d2 = buildEvalHarnessV4Dashboard([r1, r2, r3], { baseline: r1, thresholds });
  assert.equal(d2.baselineRunId, 'v4-r1');
  assert.ok(d2.latestRegressions.some((r) => r.taskId === 'a'));
  // Không so hồi quy (baseline null + 1 run): không có hồi quy.
  const d3 = buildEvalHarnessV4Dashboard([r1], { baseline: null, thresholds });
  assert.equal(d3.latestRegressions.length, 0);
});

test('escapeHtml: hostile task ids do not break HTML', () => {
  assert.equal(escapeEvalHarnessV4Html('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeEvalHarnessV4Html('a & "b"'), 'a &amp; &quot;b&quot;');
  const dashboard = buildEvalHarnessV4Dashboard(
    [runRecord('v4-r1', 1000, [taskResult('x<script>', 1, true)])],
    { thresholds: defaultEvalHarnessV4Thresholds() },
  );
  const html = renderEvalHarnessV4DashboardHtml(dashboard);
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('x&lt;script&gt;'));
});

test('dashboard: per-test trends pinpoint the flaky test', () => {
  const thresholds = defaultEvalHarnessV4Thresholds();
  const withTests = (reward, passed, perTest) => ({
    ...taskResult('a', reward, passed),
    attempts: [
      {
        attempt: 1,
        rolloutId: 'roll-a',
        startedAt: 1000,
        finishedAt: 1100,
        durationMs: 100,
        passed,
        reward,
        perTest,
        isolation: 'none',
        testExitCode: passed ? 0 : 1,
        timedOut: false,
        error: null,
        promptTokens: 0,
        completionTokens: 0,
      },
    ],
  });
  const pass = (name) => ({ name, weight: 1, passed: true });
  const fail = (name) => ({ name, weight: 1, passed: false });
  const records = [
    runRecord('v4-r1', 1000, [withTests(1, true, [pass('stable-test'), pass('flaky-test')])]),
    runRecord('v4-r2', 2000, [withTests(0.5, false, [pass('stable-test'), fail('flaky-test')])]),
    runRecord('v4-r3', 3000, [withTests(1, true, [pass('stable-test'), pass('flaky-test')])]),
  ];
  const dashboard = buildEvalHarnessV4Dashboard(records, { thresholds });
  assert.equal(dashboard.testTrends.length, 2);
  assert.equal(dashboard.testTrends[0].testName, 'flaky-test');
  assert.equal(dashboard.testTrends[0].flaky, true);
  assert.equal(dashboard.testTrends[0].passRate, 2 / 3);
  assert.equal(dashboard.testTrends[1].testName, 'stable-test');
  assert.equal(dashboard.testTrends[1].flaky, false);
  const md = renderEvalHarnessV4DashboardMarkdown(dashboard);
  assert.ok(md.includes('## Test flaky nhất'));
  assert.ok(md.includes('a/flaky-test'));
});
