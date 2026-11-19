/**
 * Tests for Eval Harness v4 history + regression (v1.44, Đội T2):
 * `packages/core/src/evalHarnessV4/history.ts` + `regression.ts`.
 *
 * Covers: history append/load (JSONL + per-run file), corrupt
 * line tolerance, run lookup, latest run, prune by maxRuns /
 * maxAgeDays, baseline pin/unpin/resolve (config > pinned >
 * previous), run comparison (delta, newly failing/passing tests,
 * added/removed tasks), regression detection (pass->fail blocker,
 * reward-drop blocker/major, new-failure minor, newly-flaky,
 * timeout, suite-drop, improvements), gate verdicts + exit codes,
 * text/markdown formatting.
 *
 * Pure + temp-dir disk only — no sandbox, no model.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-harness-v4-history-regression.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultEvalHarnessV4Config, defaultEvalHarnessV4Thresholds } from '../packages/core/dist/evalHarnessV4/config.js';
import {
  appendEvalHarnessV4RunRecord,
  compareEvalHarnessV4Runs,
  getEvalHarnessV4HistoryDir,
  latestEvalHarnessV4Run,
  listEvalHarnessV4RunIds,
  loadEvalHarnessV4History,
  loadEvalHarnessV4Run,
  pinEvalHarnessV4Baseline,
  pruneEvalHarnessV4History,
  readEvalHarnessV4Baseline,
  resolveEvalHarnessV4BaselineRun,
  summarizeEvalHarnessV4History,
  unpinEvalHarnessV4Baseline,
} from '../packages/core/dist/evalHarnessV4/history.js';
import {
  detectEvalHarnessV4Regressions,
  evalHarnessV4GateExitCode,
  formatEvalHarnessV4RegressionMarkdown,
  formatEvalHarnessV4RegressionText,
  gateEvalHarnessV4Regressions,
} from '../packages/core/dist/evalHarnessV4/regression.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-v4-history-'));
}

/** Một task result giả: 1 attempt, perTest cho trước, reward tính theo trọng số. */
function taskResult(taskId, perTest, opts = {}) {
  const totalWeight = perTest.reduce((sum, t) => sum + t.weight, 0);
  const passedWeight = perTest.filter((t) => t.passed).reduce((sum, t) => sum + t.weight, 0);
  const meanReward = totalWeight > 0 ? passedWeight / totalWeight : 0;
  const passed = opts.passed ?? meanReward === 1;
  const attempts = opts.attempts ?? [
    {
      attempt: 1,
      rolloutId: `roll-${taskId}-1`,
      startedAt: 1000,
      finishedAt: 1100,
      durationMs: 100,
      passed,
      reward: meanReward,
      perTest: perTest.map((t) => ({ ...t })),
      isolation: opts.isolation ?? 'none',
      testExitCode: passed ? 0 : 1,
      timedOut: opts.timedOut ?? false,
      error: opts.error ?? null,
      promptTokens: 0,
      completionTokens: 0,
    },
  ];
  const passes = attempts.filter((a) => a.passed).length;
  const rewards = attempts.map((a) => a.reward);
  return {
    taskId,
    taskVersion: 1,
    taskName: taskId,
    taskKind: 'coding',
    source: 'builtin-v4',
    attempts,
    passes,
    passed: passes > 0,
    allPassed: attempts.length > 0 && passes === attempts.length,
    flaky: passes > 0 && passes < attempts.length,
    meanReward: rewards.reduce((a, b) => a + b, 0) / rewards.length,
    bestReward: Math.max(...rewards),
    worstReward: Math.min(...rewards),
    meanDurationMs: 100,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    failingTests: [...new Set(attempts.flatMap((a) => a.perTest.filter((t) => !t.passed).map((t) => t.name)))].sort(),
  };
}

/** Một run record giả từ danh sách task result. */
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
    flakyTasks: tasks.filter((t) => t.flaky).length,
    isolationModes: ['none'],
    note: '',
  };
}

const ALL_PASS = [
  { name: 'file-exists', weight: 1, passed: true },
  { name: 'content-ok', weight: 2, passed: true },
];
const HALF_PASS = [
  { name: 'file-exists', weight: 1, passed: true },
  { name: 'content-ok', weight: 2, passed: false },
];
const ALL_FAIL = [
  { name: 'file-exists', weight: 1, passed: false },
  { name: 'content-ok', weight: 2, passed: false },
];

test('history: append + load + lookup + latest + list', () => {
  const dir = path.join(tmpDir(), 'eval-harness-v4');
  const r1 = runRecord('v4-run-1', 1000, [taskResult('fix-import', ALL_PASS)]);
  const r2 = runRecord('v4-run-2', 2000, [taskResult('fix-import', HALF_PASS)]);
  appendEvalHarnessV4RunRecord(dir, r1);
  appendEvalHarnessV4RunRecord(dir, r2);
  const { records, corruptLines, exists } = loadEvalHarnessV4History(dir);
  assert.equal(exists, true);
  assert.equal(corruptLines, 0);
  assert.equal(records.length, 2);
  assert.equal(records[0].runId, 'v4-run-1');
  assert.equal(records[1].runId, 'v4-run-2');
  assert.equal(loadEvalHarnessV4Run(dir, 'v4-run-1')?.meanReward, 1);
  assert.equal(loadEvalHarnessV4Run(dir, 'nope'), undefined);
  assert.equal(latestEvalHarnessV4Run(dir)?.runId, 'v4-run-2');
  assert.deepEqual(listEvalHarnessV4RunIds(dir), ['v4-run-2', 'v4-run-1']);
  // File runs/<id>.json tồn tại (đọc lại không cần quét JSONL).
  assert.ok(fs.existsSync(path.join(dir, 'runs', 'v4-run-1.json')));
  const summary = summarizeEvalHarnessV4History(dir);
  assert.equal(summary.runs, 2);
  assert.deepEqual(summary.taskIds, ['fix-import']);
  assert.equal(summary.latestRunId, 'v4-run-2');
});

test('history: corrupt JSONL lines are skipped, not fatal', () => {
  const dir = path.join(tmpDir(), 'eval-harness-v4');
  const r1 = runRecord('v4-run-1', 1000, [taskResult('fix-import', ALL_PASS)]);
  appendEvalHarnessV4RunRecord(dir, r1);
  fs.appendFileSync(path.join(dir, 'runs.jsonl'), 'this is not json\n{"runId": 42}\n', 'utf-8');
  const { records, corruptLines } = loadEvalHarnessV4History(dir);
  assert.equal(records.length, 1);
  assert.equal(corruptLines, 2);
  const empty = loadEvalHarnessV4History(path.join(tmpDir(), 'nope'));
  assert.equal(empty.exists, false);
  assert.equal(empty.records.length, 0);
});

test('history: prune by maxRuns keeps newest, prune by age drops old', () => {
  const dir = path.join(tmpDir(), 'eval-harness-v4');
  const now = 10_000_000;
  for (let i = 1; i <= 5; i++) {
    appendEvalHarnessV4RunRecord(dir, runRecord(`v4-run-${i}`, i * 1000, [taskResult('fix-import', ALL_PASS)]));
  }
  const pruned = pruneEvalHarnessV4History(dir, { maxRuns: 2, maxAgeDays: 0, now });
  assert.equal(pruned.removed, 3);
  assert.equal(pruned.kept, 2);
  assert.deepEqual(listEvalHarnessV4RunIds(dir), ['v4-run-5', 'v4-run-4']);
  assert.equal(fs.existsSync(path.join(dir, 'runs', 'v4-run-1.json')), false);
  // Prune theo tuổi: run cũ hơn 1 ngày bị xoá.
  const pruned2 = pruneEvalHarnessV4History(dir, { maxRuns: 0, maxAgeDays: 1, now: 1000 + 2 * 24 * 60 * 60 * 1000 });
  assert.equal(pruned2.removed, 2);
  assert.equal(loadEvalHarnessV4History(dir).records.length, 0);
});

test('history: baseline pin/unpin/resolve (config > pinned > previous)', () => {
  const dir = path.join(tmpDir(), 'eval-harness-v4');
  assert.equal(readEvalHarnessV4Baseline(dir), undefined);
  assert.equal(unpinEvalHarnessV4Baseline(dir), false);
  const r1 = runRecord('v4-run-1', 1000, [taskResult('fix-import', ALL_PASS)]);
  const r2 = runRecord('v4-run-2', 2000, [taskResult('fix-import', ALL_PASS)]);
  const r3 = runRecord('v4-run-3', 3000, [taskResult('fix-import', ALL_PASS)]);
  appendEvalHarnessV4RunRecord(dir, r1);
  appendEvalHarnessV4RunRecord(dir, r2);
  appendEvalHarnessV4RunRecord(dir, r3);
  pinEvalHarnessV4Baseline(dir, 'v4-run-1', 'good baseline');
  assert.equal(readEvalHarnessV4Baseline(dir)?.runId, 'v4-run-1');
  // Pinned thắng previous.
  assert.equal(resolveEvalHarnessV4BaselineRun(dir, '', 'v4-run-3')?.runId, 'v4-run-1');
  // Config thắng pinned.
  assert.equal(resolveEvalHarnessV4BaselineRun(dir, 'v4-run-2', 'v4-run-3')?.runId, 'v4-run-2');
  // Baseline đã prune thì fallback previous.
  assert.equal(resolveEvalHarnessV4BaselineRun(dir, 'v4-gone', 'v4-run-3')?.runId, 'v4-run-2');
  assert.equal(unpinEvalHarnessV4Baseline(dir), true);
  assert.equal(resolveEvalHarnessV4BaselineRun(dir, '', 'v4-run-3')?.runId, 'v4-run-2');
  // Run đầu tiên: không có baseline.
  const dir2 = path.join(tmpDir(), 'eval-harness-v4');
  appendEvalHarnessV4RunRecord(dir2, r1);
  assert.equal(resolveEvalHarnessV4BaselineRun(dir2, '', 'v4-run-1'), undefined);
});

test('history dir: override tuyệt đối thắng, rỗng thì dùng <baseDir>/eval-harness-v4', () => {
  assert.equal(getEvalHarnessV4HistoryDir('/data', ''), path.join('/data', 'eval-harness-v4'));
  assert.equal(getEvalHarnessV4HistoryDir('/data', 'custom'), path.join('/data', 'custom'));
  assert.equal(getEvalHarnessV4HistoryDir('/data', '/abs/hist'), '/abs/hist');
});

test('compare: delta reward, newly failing/passing tests, added/removed tasks', () => {
  const baseline = runRecord('v4-base', 1000, [
    taskResult('fix-import', ALL_PASS),
    taskResult('sort-lines', ALL_PASS),
  ]);
  const current = runRecord('v4-now', 2000, [
    taskResult('fix-import', HALF_PASS),
    taskResult('json-transform', ALL_PASS),
  ]);
  const comparison = compareEvalHarnessV4Runs(current, baseline);
  assert.equal(comparison.baselineRunId, 'v4-base');
  assert.deepEqual(comparison.addedTasks, ['json-transform']);
  assert.deepEqual(comparison.removedTasks, ['sort-lines']);
  const fixImport = comparison.deltas.find((d) => d.taskId === 'fix-import');
  assert.ok(fixImport);
  assert.equal(fixImport.baselineReward, 1);
  assert.equal(fixImport.currentReward, 1 / 3);
  assert.deepEqual(fixImport.newlyFailingTests, ['content-ok']);
  assert.deepEqual(fixImport.newlyPassingTests, []);
  const added = comparison.deltas.find((d) => d.taskId === 'json-transform');
  assert.equal(added?.inBaseline, false);
  assert.equal(added?.delta, null);
  // Baseline null: mọi task đều mới, delta null.
  const first = compareEvalHarnessV4Runs(current, null);
  assert.equal(first.baselineRunId, '');
  assert.equal(first.passRateDelta, null);
  assert.equal(first.meanRewardDelta, null);
});

test('regression: pass -> fail is a blocker new-failure', () => {
  const thresholds = defaultEvalHarnessV4Thresholds();
  const baseline = runRecord('v4-base', 1000, [taskResult('fix-import', ALL_PASS), taskResult('sort-lines', ALL_PASS)]);
  const current = runRecord('v4-now', 2000, [taskResult('fix-import', ALL_FAIL), taskResult('sort-lines', ALL_PASS)]);
  const report = detectEvalHarnessV4Regressions(current, baseline, thresholds);
  assert.equal(report.gate, 'block');
  assert.equal(report.bySeverity.blocker, 2); // 1 task blocker + 1 suite-drop (pass rate 1.0 -> 0.5)
  const fixImport = report.regressions.find((r) => r.taskId === 'fix-import');
  assert.ok(fixImport);
  assert.equal(fixImport.kind, 'new-failure');
  assert.equal(fixImport.severity, 'blocker');
  assert.deepEqual(fixImport.newlyFailingTests, ['content-ok', 'file-exists']);
  assert.equal(report.improvements.length, 0);
  assert.ok(report.gateReason.includes('block'));
  assert.equal(evalHarnessV4GateExitCode('block', true), 1);
  assert.equal(evalHarnessV4GateExitCode('block', false), 0);
  assert.equal(evalHarnessV4GateExitCode('warn', true), 0);
  assert.equal(evalHarnessV4GateExitCode('pass', true), 0);
});

test('regression: small reward drop is major, big drop is blocker', () => {
  const thresholds = defaultEvalHarnessV4Thresholds(); // maxRegressionDrop 0.05
  const baseline = runRecord('v4-base', 1000, [
    taskResult('a', ALL_PASS),
    taskResult('b', ALL_PASS),
    taskResult('c', ALL_PASS),
  ]);
  // Task a: reward 1 -> 2/3 (sụt 0.33, vẫn pass? reward 2/3 < 1 nên passed=false theo helper).
  // Để task vẫn pass khi reward sụt, dùng taskResult với passed: true ép.
  const smallDrop = taskResult('a', [
    { name: 't1', weight: 9, passed: true },
    { name: 't2', weight: 1, passed: false },
  ], { passed: true });
  assert.equal(smallDrop.meanReward, 0.9);
  const current = runRecord('v4-now', 2000, [smallDrop, taskResult('b', ALL_PASS), taskResult('c', ALL_PASS)]);
  const report = detectEvalHarnessV4Regressions(current, baseline, thresholds);
  // Sụt 0.10 >= 0.05 -> blocker (không có suite-drop vì pass rate vẫn 1.0).
  assert.equal(report.regressions.length, 1);
  assert.equal(report.regressions[0].kind, 'reward-drop');
  assert.equal(report.regressions[0].severity, 'blocker');
  assert.equal(report.gate, 'block');
  // Sụt nhỏ hơn ngưỡng: major, gate warn.
  const tinyDrop = taskResult('a', [
    { name: 't1', weight: 99, passed: true },
    { name: 't2', weight: 1, passed: false },
  ], { passed: true });
  const current2 = runRecord('v4-now2', 3000, [tinyDrop, taskResult('b', ALL_PASS), taskResult('c', ALL_PASS)]);
  const report2 = detectEvalHarnessV4Regressions(current2, baseline, thresholds);
  assert.equal(report2.regressions.length, 1);
  assert.equal(report2.regressions[0].severity, 'major');
  assert.equal(report2.gate, 'warn');
});

test('regression: new failing test on a still-passing task is minor', () => {
  const thresholds = defaultEvalHarnessV4Thresholds();
  const baseline = runRecord('v4-base', 1000, [taskResult('a', ALL_PASS)]);
  // Test mới fail nhưng trọng số 0? Không — trọng số phải > 0.
  // Dùng task có 2 attempt: attempt 1 pass hết, attempt 2 fail 1 test nhẹ
  // nhưng task vẫn pass nhờ attempt 1 (passed = có attempt pass).
  const attempt1 = taskResult('a', ALL_PASS).attempts[0];
  const attempt2 = taskResult('a', HALF_PASS, { passed: false }).attempts[0];
  attempt2.attempt = 2;
  const task = taskResult('a', ALL_PASS, { attempts: [attempt1, attempt2] });
  assert.equal(task.passed, true);
  assert.equal(task.flaky, true);
  const current = runRecord('v4-now', 2000, [task]);
  const report = detectEvalHarnessV4Regressions(current, baseline, thresholds);
  // Reward mean: (1 + 1/3)/2 = 2/3, sụt 1/3 >= ngưỡng -> blocker reward-drop,
  // kèm newly-flaky minor.
  assert.ok(report.regressions.some((r) => r.kind === 'reward-drop' && r.severity === 'blocker'));
  assert.ok(report.regressions.some((r) => r.kind === 'newly-flaky' && r.severity === 'minor'));
  assert.equal(report.gate, 'block');
});

test('regression: improvement is recorded, no regression, gate pass', () => {
  const thresholds = defaultEvalHarnessV4Thresholds();
  const baseline = runRecord('v4-base', 1000, [taskResult('a', HALF_PASS, { passed: false }), taskResult('b', ALL_PASS)]);
  const current = runRecord('v4-now', 2000, [taskResult('a', ALL_PASS), taskResult('b', ALL_PASS)]);
  const report = detectEvalHarnessV4Regressions(current, baseline, thresholds);
  assert.equal(report.regressions.length, 0);
  assert.equal(report.improvements.length, 1);
  assert.equal(report.improvements[0].taskId, 'a');
  assert.deepEqual(report.improvements[0].newlyPassingTests, ['content-ok']);
  assert.equal(report.gate, 'pass');
  assert.equal(gateEvalHarnessV4Regressions([], current, thresholds), 'pass');
});

test('regression: first run has no baseline, no regressions, gate pass', () => {
  const thresholds = defaultEvalHarnessV4Thresholds();
  const current = runRecord('v4-first', 1000, [taskResult('a', ALL_FAIL, { passed: false })]);
  const report = detectEvalHarnessV4Regressions(current, null, thresholds);
  assert.equal(report.regressions.length, 0);
  assert.equal(report.baselineRunId, '');
  // Suite fail hoàn toàn (pass rate 0 < min 0.8) thì gate vẫn block do ngưỡng suite.
  assert.equal(report.gate, 'block');
});

test('regression: timeout and error attempts are reported', () => {
  const thresholds = defaultEvalHarnessV4Thresholds();
  const baseline = runRecord('v4-base', 1000, [taskResult('a', ALL_PASS)]);
  const timedOut = taskResult('a', ALL_PASS, { timedOut: true, passed: true });
  const current = runRecord('v4-now', 2000, [timedOut]);
  const report = detectEvalHarnessV4Regressions(current, baseline, thresholds);
  assert.ok(report.regressions.some((r) => r.kind === 'timeout'));
  const text = formatEvalHarnessV4RegressionText(report);
  assert.ok(text.includes('timeout'));
  const md = formatEvalHarnessV4RegressionMarkdown(report);
  assert.ok(md.includes('## Eval Harness v4'));
  assert.ok(md.includes('| Task |'));
});

test('regression: suite thresholds block even without per-task regression', () => {
  const thresholds = { ...defaultEvalHarnessV4Thresholds(), minPassRate: 0.9, minMeanReward: 0.9 };
  const baseline = runRecord('v4-base', 1000, [taskResult('a', ALL_PASS)]);
  // current giống hệt baseline nhưng thresholds cao hơn? Không block.
  // Dùng current fail 1/2 task nhưng baseline cũng fail 1/2 (không hồi quy từng task).
  const base2 = runRecord('v4-base', 1000, [taskResult('a', ALL_PASS), taskResult('b', ALL_FAIL, { passed: false })]);
  const cur2 = runRecord('v4-now', 2000, [taskResult('a', ALL_PASS), taskResult('b', ALL_FAIL, { passed: false })]);
  const report = detectEvalHarnessV4Regressions(cur2, base2, thresholds);
  assert.equal(report.gate, 'block');
  assert.ok(report.gateReason.includes('pass rate'));
});
