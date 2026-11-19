/**
 * Tests for Eval Harness v4 flake analysis + abort + CSV export
 * (v1.44, Đội T2): `packages/core/src/evalHarnessV4/flake.ts`,
 * abort in `runner.ts`, CSV in `history.ts`, `flakes` CLI command.
 *
 * Covers: flake rate formula (0 at p=0/1, 1 at p=0.5), verdicts
 * (stable-pass/stable-fail/flaky/insufficient-data), per-task and
 * per-test flake over history, quarantine suggestions (threshold
 * + minRuns), always-failing detection, text/markdown formatting,
 * CSV export (header + rows, no blank lines), abort before start
 * and abort mid-suite (second task never runs), CLI `flakes`
 * command + invalid --threshold.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-harness-v4-flake-abort.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { noopHarborExecutor, scriptedHarborExecutor } from '../packages/core/dist/eval/harborRunner.js';
import { defaultEvalHarnessV4Config, defaultEvalHarnessV4Thresholds, evalHarnessV4ConfigJsonSchema, sampleEvalHarnessV4Config } from '../packages/core/dist/evalHarnessV4/config.js';
import {
  analyzeEvalHarnessV4Flakes,
  evalHarnessV4FlakeRate,
  evalHarnessV4FlakeVerdict,
  formatEvalHarnessV4FlakeMarkdown,
  formatEvalHarnessV4FlakeText,
  suggestEvalHarnessV4Quarantine,
} from '../packages/core/dist/evalHarnessV4/flake.js';
import {
  EvalHarnessV4AbortError,
  EvalHarnessV4Runner,
  isEvalHarnessV4AbortError,
} from '../packages/core/dist/evalHarnessV4/runner.js';
import { builtinEvalHarnessV4Tasks, getBuiltinEvalHarnessV4Task } from '../packages/core/dist/evalHarnessV4/builtinTasks.js';
import { exportEvalHarnessV4HistoryCsv } from '../packages/core/dist/evalHarnessV4/history.js';
import {
  executeEvalHarnessV4Command,
  parseEvalHarnessV4CliArgs,
} from '../packages/core/dist/evalHarnessV4/cli.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-v4-flake-'));
}

function taskResult(taskId, reward, passed, perTest = []) {
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
        perTest,
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
    failingTests: passed ? [] : perTest.filter((t) => !t.passed).map((t) => t.name),
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

test('flake rate: 0 at p=0/1, 1 at p=0.5, symmetric', () => {
  assert.equal(evalHarnessV4FlakeRate(0), 0);
  assert.equal(evalHarnessV4FlakeRate(1), 0);
  assert.equal(evalHarnessV4FlakeRate(0.5), 1);
  assert.ok(Math.abs(evalHarnessV4FlakeRate(0.25) - 0.5) < 1e-9);
  assert.ok(Math.abs(evalHarnessV4FlakeRate(0.75) - 0.5) < 1e-9);
  assert.equal(evalHarnessV4FlakeRate(Number.NaN), 0);
});

test('flake verdict: insufficient data, stable, flaky', () => {
  assert.equal(evalHarnessV4FlakeVerdict(0.5, 2, 3), 'insufficient-data');
  assert.equal(evalHarnessV4FlakeVerdict(1, 3, 3), 'stable-pass');
  assert.equal(evalHarnessV4FlakeVerdict(0, 3, 3), 'stable-fail');
  assert.equal(evalHarnessV4FlakeVerdict(0.5, 4, 3), 'flaky');
  assert.equal(evalHarnessV4FlakeVerdict(2 / 3, 3, 3), 'flaky');
});

test('flake analysis: flaky task quarantined, stable tasks not, always-failing listed', () => {
  const records = [
    runRecord('v4-r1', 1000, [taskResult('stable', 1, true), taskResult('flaky', 1, true), taskResult('dead', 0, false)]),
    runRecord('v4-r2', 2000, [taskResult('stable', 1, true), taskResult('flaky', 0, false), taskResult('dead', 0, false)]),
    runRecord('v4-r3', 3000, [taskResult('stable', 1, true), taskResult('flaky', 1, true), taskResult('dead', 0, false)]),
    runRecord('v4-r4', 4000, [taskResult('stable', 1, true), taskResult('flaky', 0, false), taskResult('dead', 0, false)]),
  ];
  const report = analyzeEvalHarnessV4Flakes(records, { quarantineThreshold: 0.5, minRuns: 3 });
  assert.equal(report.runs, 4);
  assert.equal(report.tasks.length, 3);
  const flaky = report.tasks.find((t) => t.taskId === 'flaky');
  assert.ok(flaky);
  assert.equal(flaky.verdict, 'flaky');
  assert.equal(flaky.passRate, 0.5);
  assert.equal(flaky.flakeRate, 1);
  assert.equal(flaky.quarantine, true);
  assert.ok(flaky.quarantineReason.includes('flaky'));
  const stable = report.tasks.find((t) => t.taskId === 'stable');
  assert.equal(stable?.verdict, 'stable-pass');
  assert.equal(stable?.quarantine, false);
  const dead = report.tasks.find((t) => t.taskId === 'dead');
  assert.equal(dead?.verdict, 'stable-fail');
  assert.equal(dead?.flakeRate, 0);
  assert.deepEqual(report.alwaysFailing, ['dead']);
  assert.deepEqual(suggestEvalHarnessV4Quarantine(report).map((q) => q.taskId), ['flaky']);
  const text = formatEvalHarnessV4FlakeText(report);
  assert.ok(text.includes('flaky'));
  assert.ok(text.includes('[quarantine]'));
  const md = formatEvalHarnessV4FlakeMarkdown(report);
  assert.ok(md.includes('## Eval Harness v4 — Flake report'));
  assert.ok(md.includes('| flaky | 4 | 50% | 1.00 | flaky | yes |'));
});

test('flake analysis: per-test flake pinpoints the unstable test', () => {
  const pass = (name) => ({ name, weight: 1, passed: true });
  const fail = (name) => ({ name, weight: 1, passed: false });
  const records = [
    runRecord('v4-r1', 1000, [taskResult('a', 1, true, [pass('t1'), pass('t2')])]),
    runRecord('v4-r2', 2000, [taskResult('a', 0.5, false, [pass('t1'), fail('t2')])]),
    runRecord('v4-r3', 3000, [taskResult('a', 1, true, [pass('t1'), pass('t2')])]),
    runRecord('v4-r4', 4000, [taskResult('a', 0.5, false, [pass('t1'), fail('t2')])]),
  ];
  const report = analyzeEvalHarnessV4Flakes(records);
  const t1 = report.tests.find((t) => t.testName === 't1');
  const t2 = report.tests.find((t) => t.testName === 't2');
  assert.equal(t1?.verdict, 'stable-pass');
  assert.equal(t2?.verdict, 'flaky');
  assert.equal(t2?.flakeRate, 1);
  // Test flaky nhất đứng đầu.
  assert.equal(report.tests[0].testName, 't2');
});

test('flake analysis: empty history and single run are insufficient-data', () => {
  const empty = analyzeEvalHarnessV4Flakes([]);
  assert.equal(empty.runs, 0);
  assert.deepEqual(empty.tasks, []);
  assert.deepEqual(empty.quarantine, []);
  const single = analyzeEvalHarnessV4Flakes([runRecord('v4-r1', 1000, [taskResult('a', 1, true)])]);
  assert.equal(single.tasks[0].verdict, 'insufficient-data');
  assert.equal(single.tasks[0].quarantine, false);
});

test('CSV export: header + one row per task per run, no blank lines', () => {
  const records = [
    runRecord('v4-r1', 1000, [taskResult('a', 1, true), taskResult('b', 0, false)]),
    runRecord('v4-r2', 2000, [taskResult('a', 0.5, false)]),
  ];
  const csv = exportEvalHarnessV4HistoryCsv(records);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'runId,startedAt,configName,taskId,taskVersion,attempts,passes,meanReward,passed,flaky,durationMs,promptTokens,completionTokens');
  assert.equal(lines.filter((l) => l === '').length, 1); // chỉ \n cuối file
  assert.equal(lines.filter((l) => l.startsWith('v4-r1')).length, 2);
  assert.equal(lines.filter((l) => l.startsWith('v4-r2')).length, 1);
  assert.ok(lines[1].includes(',a,1,1,1,1.0000,1,0,'));
  const emptyCsv = exportEvalHarnessV4HistoryCsv([]);
  assert.equal(emptyCsv.split('\n').length, 2); // header + \n cuối
});

test('abort: pre-aborted signal throws before any attempt', async () => {
  const dir = tmpDir();
  const controller = new AbortController();
  controller.abort();
  const runner = new EvalHarnessV4Runner({
    baseDir: dir,
    executor: noopHarborExecutor,
    signal: controller.signal,
  });
  const task = getBuiltinEvalHarnessV4Task('sort-lines');
  assert.ok(task);
  await assert.rejects(() => runner.runTaskWithRepeats(task), EvalHarnessV4AbortError);
  await assert.rejects(() => runner.runTaskWithRepeats(task), (err) => isEvalHarnessV4AbortError(err));
});

test('abort: mid-suite abort stops after the current task', async () => {
  const dir = tmpDir();
  const controller = new AbortController();
  let tasksDone = 0;
  const runner = new EvalHarnessV4Runner({
    baseDir: dir,
    executor: scriptedHarborExecutor({ 'sorted.txt': 'An\nHoa\nLan\nMinh\nTuan\n' }),
    signal: controller.signal,
    onTaskDone: () => {
      tasksDone += 1;
      controller.abort();
    },
  });
  const tasks = [getBuiltinEvalHarnessV4Task('sort-lines'), getBuiltinEvalHarnessV4Task('word-count')];
  assert.ok(tasks.every(Boolean));
  await assert.rejects(() => runner.runSuite(tasks), EvalHarnessV4AbortError);
  assert.equal(tasksDone, 1);
});

test('CLI flakes: empty history, invalid threshold, then real data', async () => {
  const baseDir = tmpDir();
  const cwd = tmpDir();
  const ctx = { baseDir, cwd };
  const empty = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['flakes']), ctx);
  assert.equal(empty.exitCode, 0);
  assert.ok(empty.stdout.includes('0 run'));
  const bad = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['flakes', '--threshold', '2']), ctx);
  assert.equal(bad.exitCode, 2);
  const unknown = parseEvalHarnessV4CliArgs(['flakes', '--bogus']);
  assert.ok(unknown.errors.length > 0);
  // Ghi 4 run tay (2 pass 2 fail) rồi chạy flakes: task flaky phải hiện.
  const { appendEvalHarnessV4RunRecord } = await import('../packages/core/dist/evalHarnessV4/history.js');
  const historyDir = path.join(baseDir, 'eval-harness-v4');
  for (let i = 1; i <= 4; i++) {
    const passed = i % 2 === 1;
    appendEvalHarnessV4RunRecord(historyDir, runRecord(`v4-r${i}`, i * 1000, [taskResult('flaky-task', passed ? 1 : 0, passed)]));
  }
  const report = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['flakes']), ctx);
  assert.equal(report.exitCode, 0);
  assert.ok(report.stdout.includes('flaky-task'));
  assert.ok(report.stdout.includes('[quarantine]'));
  assert.equal(report.json.tasks[0].taskId, 'flaky-task');
});

test('retry: transient executor error is retried, then passes', async () => {
  const dir = tmpDir();
  let calls = 0;
  const flakyExecutor = async (ctx) => {
    calls += 1;
    if (calls === 1) throw new Error('transient sandbox error');
    return scriptedHarborExecutor({ 'sorted.txt': 'An\nHoa\nLan\nMinh\nTuan\n' })(ctx);
  };
  const runner = new EvalHarnessV4Runner({
    baseDir: dir,
    executor: flakyExecutor,
    maxInfraRetries: 1,
  });
  const task = getBuiltinEvalHarnessV4Task('sort-lines');
  assert.ok(task);
  const result = await runner.runTaskWithRepeats(task);
  assert.equal(result.passed, true);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.retriesUsed, 1);
  assert.equal(result.attempts[0].error, 'transient sandbox error');
  assert.equal(result.attempts[1].passed, true);
});

test('retry: always-failing executor exhausts retries; test failure never retries', async () => {
  const dir = tmpDir();
  const alwaysFailing = async () => {
    throw new Error('sandbox down');
  };
  const runner = new EvalHarnessV4Runner({
    baseDir: dir,
    executor: alwaysFailing,
    maxInfraRetries: 2,
  });
  const task = getBuiltinEvalHarnessV4Task('sort-lines');
  assert.ok(task);
  const result = await runner.runTaskWithRepeats(task);
  assert.equal(result.passed, false);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.retriesUsed, 2);
  assert.ok(result.attempts.every((a) => a.error === 'sandbox down'));
  // Test fail (không phải lỗi hạ tầng) thì KHÔNG retry.
  const noopRunner = new EvalHarnessV4Runner({
    baseDir: tmpDir(),
    executor: noopHarborExecutor,
    maxInfraRetries: 2,
  });
  const noopResult = await noopRunner.runTaskWithRepeats(task);
  assert.equal(noopResult.passed, false);
  assert.equal(noopResult.attempts.length, 1);
  assert.equal(noopResult.retriesUsed, 0);
});

test('config JSON schema: describes every config field', () => {
  const schema = evalHarnessV4ConfigJsonSchema();
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema.required, ['version']);
  assert.equal(schema.properties.version.const, 4);
  assert.equal(schema.properties.repeats.maximum, 10);
  assert.equal(schema.properties.repeats.minimum, 1);
  assert.deepEqual(schema.properties.selection.properties.kinds.items.enum, ['coding', 'research', 'writing', 'review', 'general']);
  assert.deepEqual(schema.properties.output.properties.formats.items.enum, ['markdown', 'html', 'json']);
  assert.equal(schema.properties.thresholds.properties.maxRegressionDrop.default, 0.05);
  // Mọi key của sample config đều có trong schema.
  const sample = JSON.parse(JSON.stringify(sampleEvalHarnessV4Config()));
  for (const key of Object.keys(sample)) {
    assert.ok(key in schema.properties, `schema thiếu key ${key}`);
  }
});

test('CLI config --schema prints the JSON schema', async () => {
  const baseDir = tmpDir();
  const cwd = tmpDir();
  const result = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['config', '--schema']), { baseDir, cwd });
  assert.equal(result.exitCode, 0);
  assert.equal(result.json.properties.version.const, 4);
  assert.ok(result.stdout.includes('Eval Harness v4 config'));
});
