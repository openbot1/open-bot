/**
 * Tests for the eval runner v3 (packages/core/src/eval/runner.ts).
 *
 * Covers history persistence (missing file = empty, corrupt rows
 * dropped), running a suite end-to-end (report saved, comparison vs
 * previous run, regression alerts), comparing two reports (deltas
 * per metric/category, question moves), regression detection
 * (thresholds, per-category F1), and the run schedule
 * (due / next run).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-runner-v105.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BUILTIN_MEMORY_EVAL_DATASET,
  DEFAULT_REGRESSION_THRESHOLDS,
  InMemoryMockRetriever,
  checkMemoryEvalRegression,
  compareMemoryEvalReports,
  isEvalRunDue,
  listMemoryEvalHistory,
  nextScheduledRunMs,
  runMemoryEval,
  runMemoryEvalSuite,
  validateEvalRunnerConfig,
  validateRegressionThresholds,
} from '../packages/core/dist/eval/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-runner-'));
}

function makeReport(overrides = {}) {
  const base = {
    datasetId: 'builtin-memory-v1',
    datasetVersion: 1,
    retrieverName: 'mock-embedding-v1',
    retrieverVersion: 'v1',
    topK: 5,
    at: 1000,
    perQuestion: [
      { questionId: 'q1', category: 'recall', recall: 1, precision: 1, f1: 1, temporalAccuracy: null, multiHopScore: null, judgeScore: 1, retrievedExpectedIds: ['f1'], retrievedIds: ['f1'] },
      { questionId: 'q2', category: 'temporal', recall: 0.5, precision: 0.5, f1: 0.5, temporalAccuracy: 1, multiHopScore: null, judgeScore: 0.5, retrievedExpectedIds: ['f2'], retrievedIds: ['f2', 'f9'] },
    ],
    byCategory: [
      { category: 'recall', count: 1, recall: 1, precision: 1, f1: 1, temporalAccuracy: null, multiHopScore: null, judgeScore: 1 },
      { category: 'temporal', count: 1, recall: 0.5, precision: 0.5, f1: 0.5, temporalAccuracy: 1, multiHopScore: null, judgeScore: 0.5 },
      { category: 'multi-hop', count: 0, recall: 0, precision: 0, f1: 0, temporalAccuracy: null, multiHopScore: null, judgeScore: 0 },
    ],
    overall: { category: 'overall', count: 2, recall: 0.75, precision: 0.75, f1: 0.75, temporalAccuracy: 1, multiHopScore: null, judgeScore: 0.75 },
  };
  return { ...base, ...overrides };
}

test('history: missing file is empty, corrupt rows are dropped', () => {
  const dir = tmpDir();
  assert.deepEqual(listMemoryEvalHistory(dir), []);
  fs.writeFileSync(path.join(dir, 'eval-memory-history.json'), JSON.stringify([makeReport(), { nope: true }, makeReport({ at: 500 })]));
  const history = listMemoryEvalHistory(dir);
  assert.equal(history.length, 2);
  assert.equal(history[0].at, 500); // sorted oldest first
  assert.equal(history[1].at, 1000);
});

test('validateEvalRunnerConfig + thresholds', () => {
  const cfg = validateEvalRunnerConfig({ retrieverVersion: ' v2 ', topK: 3 });
  assert.equal(cfg.retrieverVersion, 'v2');
  assert.equal(cfg.topK, 3);
  assert.throws(() => validateEvalRunnerConfig({}), /retrieverVersion/);
  assert.throws(() => validateEvalRunnerConfig({ retrieverVersion: 'v1', topK: 0 }), /topK/);
  assert.throws(() => validateEvalRunnerConfig({ retrieverVersion: 'v1', schedule: { enabled: 'yes' } }), /enabled/);
  assert.deepEqual(validateRegressionThresholds({ f1Drop: 0.1 }), {
    ...DEFAULT_REGRESSION_THRESHOLDS,
    f1Drop: 0.1,
  });
  assert.throws(() => validateRegressionThresholds({ f1Drop: 2 }), /f1Drop/);
  assert.throws(() => validateRegressionThresholds('nope'), /object/);
});

test('compareMemoryEvalReports: deltas + question moves', () => {
  const baseline = makeReport({ retrieverVersion: 'v1', at: 1000 });
  const current = makeReport({
    retrieverVersion: 'v2',
    at: 2000,
    overall: { ...baseline.overall, f1: 0.85, recall: 0.9 },
    perQuestion: [
      { ...baseline.perQuestion[0], f1: 1 },
      { ...baseline.perQuestion[1], f1: 0.7 },
    ],
  });
  const cmp = compareMemoryEvalReports(baseline, current);
  assert.equal(cmp.baseline.retrieverVersion, 'v1');
  assert.equal(cmp.current.retrieverVersion, 'v2');
  assert.ok(Math.abs(cmp.overallDelta.f1 - 0.1) < 1e-9);
  assert.ok(Math.abs(cmp.overallDelta.recall - 0.15) < 1e-9);
  assert.equal(cmp.questionMoves.improved, 1);
  assert.equal(cmp.questionMoves.worsened, 0);
  assert.equal(cmp.questionMoves.unchanged, 1);
});

test('checkMemoryEvalRegression: no alerts when scores hold, alerts on a drop', () => {
  const good = makeReport({ retrieverVersion: 'v1', at: 1000 });
  const same = makeReport({ retrieverVersion: 'v2', at: 2000 });
  assert.deepEqual(checkMemoryEvalRegression([good, same]), []);
  // F1 drops 0.75 -> 0.60 (drop 0.15 > threshold 0.05).
  const bad = makeReport({
    retrieverVersion: 'v3',
    at: 3000,
    overall: { ...good.overall, f1: 0.6, recall: 0.6 },
    byCategory: good.byCategory.map((c) => ({ ...c, f1: c.f1 - 0.15, recall: c.recall - 0.15 })),
  });
  const alerts = checkMemoryEvalRegression([good, bad]);
  assert.ok(alerts.length >= 1);
  assert.ok(alerts.some((a) => a.metric === 'f1' && a.category === 'overall'));
  assert.ok(alerts.every((a) => a.drop < 0));
  // One run only -> no baseline -> no alerts.
  assert.deepEqual(checkMemoryEvalRegression([good]), []);
  // Different datasets are not compared.
  const other = makeReport({ datasetId: 'other', retrieverVersion: 'v9', at: 4000 });
  assert.deepEqual(checkMemoryEvalRegression([good, other]), []);
});

test('schedule: next run + due', () => {
  assert.equal(nextScheduledRunMs({ enabled: false, intervalMs: 1000, lastRunAt: 0 }), null);
  assert.equal(isEvalRunDue({ enabled: false, intervalMs: 1000, lastRunAt: 0 }, 999999), false);
  assert.equal(nextScheduledRunMs({ enabled: true, intervalMs: 1000, lastRunAt: null }, 5000), 5000);
  assert.equal(isEvalRunDue({ enabled: true, intervalMs: 1000, lastRunAt: null }, 5000), true);
  assert.equal(nextScheduledRunMs({ enabled: true, intervalMs: 1000, lastRunAt: 1000 }, 1500), 2000);
  assert.equal(isEvalRunDue({ enabled: true, intervalMs: 1000, lastRunAt: 1000 }, 1500), false);
  assert.equal(isEvalRunDue({ enabled: true, intervalMs: 1000, lastRunAt: 1000 }, 2000), true);
});

test('runMemoryEvalSuite: end-to-end run, history, comparison, alerts', async () => {
  const dir = tmpDir();
  const retriever = new InMemoryMockRetriever(BUILTIN_MEMORY_EVAL_DATASET.facts);
  const first = await runMemoryEvalSuite(dir, BUILTIN_MEMORY_EVAL_DATASET, retriever, {
    retrieverVersion: 'mock-v1',
    topK: 5,
    at: 1000,
  });
  assert.equal(first.report.retrieverVersion, 'mock-v1');
  assert.equal(first.history.length, 1);
  assert.equal(first.comparison, null);
  assert.deepEqual(first.alerts, []);
  assert.equal(listMemoryEvalHistory(dir).length, 1);

  // Second run with a worse retriever (topK 1) -> scores drop, alerts fire.
  const second = await runMemoryEvalSuite(dir, BUILTIN_MEMORY_EVAL_DATASET, retriever, {
    retrieverVersion: 'mock-v1-top1',
    topK: 1,
    at: 2000,
  });
  assert.equal(second.history.length, 2);
  assert.notEqual(second.comparison, null);
  // topK 1 must recall less than topK 5 (fewer facts retrieved);
  // F1 can go either way because topK 1 has higher precision, so
  // recall — not F1 — is the assertion here.
  assert.ok(second.comparison.overallDelta.recall < 0, 'topK 1 should recall less than topK 5');
  // The drop is real: topK 1 recall must be lower than topK 5.
  const firstReport = await runMemoryEval(BUILTIN_MEMORY_EVAL_DATASET, retriever, { topK: 5, at: 1000 });
  assert.ok(second.report.overall.recall < firstReport.overall.recall);
  assert.ok(second.alerts.length >= 1, 'expected at least one regression alert');
  assert.ok(second.alerts.every((a) => a.metric === 'f1' || a.metric === 'recall' || a.metric === 'temporalAccuracy' || a.metric === 'multiHopScore' || a.metric === 'judgeScore'));
  await assert.rejects(
    runMemoryEvalSuite(dir, BUILTIN_MEMORY_EVAL_DATASET, retriever, { retrieverVersion: '' }),
    /retrieverVersion/,
  );
});

test('pruneMemoryEvalHistory keeps only the newest N runs', async () => {
  const { pruneMemoryEvalHistory } = await import('../packages/core/dist/eval/index.js');
  const dir = tmpDir();
  const retriever = new InMemoryMockRetriever(BUILTIN_MEMORY_EVAL_DATASET.facts);
  for (let i = 0; i < 3; i++) {
    await runMemoryEvalSuite(dir, BUILTIN_MEMORY_EVAL_DATASET, retriever, {
      retrieverVersion: `mock-v${i}`,
      topK: 5,
      at: 1000 + i,
    });
  }
  assert.equal(listMemoryEvalHistory(dir).length, 3);
  assert.equal(pruneMemoryEvalHistory(dir, 2), 1);
  const kept = listMemoryEvalHistory(dir);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].retrieverVersion, 'mock-v1');
  assert.equal(pruneMemoryEvalHistory(dir, 5), 0);
  assert.throws(() => pruneMemoryEvalHistory(dir, 0), /keepLast/);
});

test('eval schedule store: set/get/due/mark/remove', async () => {
  const {
    setEvalSchedule,
    getEvalSchedule,
    listEvalSchedules,
    dueEvalSchedules,
    markEvalScheduleRun,
    removeEvalSchedule,
  } = await import('../packages/core/dist/eval/index.js');
  const dir = tmpDir();
  assert.deepEqual(listEvalSchedules(dir), []);
  const entry = setEvalSchedule(dir, 'builtin-memory-v1', { enabled: true, intervalMs: 1000, lastRunAt: null });
  assert.equal(entry.datasetId, 'builtin-memory-v1');
  assert.equal(entry.schedule.enabled, true);
  // Never run -> due immediately.
  assert.equal(dueEvalSchedules(dir, 5000).length, 1);
  // Mark a run at 5000 -> not due until 6000.
  markEvalScheduleRun(dir, 'builtin-memory-v1', 5000);
  assert.equal(dueEvalSchedules(dir, 5500).length, 0);
  assert.equal(dueEvalSchedules(dir, 6000).length, 1);
  // Disabled schedule is never due.
  setEvalSchedule(dir, 'builtin-memory-v1', { enabled: false });
  assert.equal(dueEvalSchedules(dir, 999999).length, 0);
  assert.notEqual(getEvalSchedule(dir, 'builtin-memory-v1'), null);
  assert.equal(getEvalSchedule(dir, 'other'), null);
  assert.equal(removeEvalSchedule(dir, 'builtin-memory-v1'), true);
  assert.equal(removeEvalSchedule(dir, 'builtin-memory-v1'), false);
  assert.deepEqual(listEvalSchedules(dir), []);
  assert.throws(() => setEvalSchedule(dir, '', {}), /datasetId/);
  assert.throws(() => markEvalScheduleRun(dir, 'ghost'), /no eval schedule/);
});
