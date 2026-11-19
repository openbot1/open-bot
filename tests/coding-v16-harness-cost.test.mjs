/**
 * Tests cho coding agent v16 — harness cost estimator (v1.38, Đội T4).
 *
 * Chạy thật: estimator thật trong bộ nhớ (không gọi model/mạng).
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v16-harness-cost.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HarnessCostEstimator,
  V16_DEFAULT_HARNESS_PROFILES,
  V16_DEFAULT_MODEL_PRICES,
  renderV16CostAccuracyReport,
  renderV16FlakinessSummary,
  v16AnalyzeFlakiness,
  v16BuildCostAccuracyReport,
  v16CompareHarness,
  v16CostsByModel,
  v16FindPrice,
  v16PriceRun,
  v16RecommendHarness,
  v16SummarizeFlakiness,
} from '../packages/core/dist/index.js';

function record(estimator, over = {}) {
  return estimator.record({
    taskId: 't1',
    harnessId: 'minimal',
    model: 'claude-sonnet-4',
    score: 1,
    promptTokens: 1000,
    completionTokens: 500,
    steps: 5,
    ...over,
  });
}

test('price run: USD from per-million prices', () => {
  const price = { model: 'm', inputPerMillion: 3, outputPerMillion: 15 };
  assert.equal(v16PriceRun(1_000_000, 0, price), 3);
  assert.equal(v16PriceRun(0, 1_000_000, price), 15);
  assert.equal(v16PriceRun(1000, 500, price), 0.0105);
  assert.throws(() => v16PriceRun(-1, 0, price), /promptTokens/);
  assert.equal(v16FindPrice(V16_DEFAULT_MODEL_PRICES, 'Claude-Sonnet-4')?.model, 'claude-sonnet-4');
  assert.equal(v16FindPrice(V16_DEFAULT_MODEL_PRICES, 'nope'), undefined);
});

test('default profiles/prices: minimal preamble 829, claude-code 16600', () => {
  const minimal = V16_DEFAULT_HARNESS_PROFILES.find((p) => p.id === 'minimal');
  const cc = V16_DEFAULT_HARNESS_PROFILES.find((p) => p.id === 'claude-code');
  const oc = V16_DEFAULT_HARNESS_PROFILES.find((p) => p.id === 'opencode');
  assert.equal(minimal?.preambleTokens, 829);
  assert.equal(cc?.preambleTokens, 16600);
  assert.equal(oc?.preambleTokens, 7000);
  assert.ok(V16_DEFAULT_MODEL_PRICES.length >= 5);
});

test('estimator: record validates + prices from table + unknown model cost 0', () => {
  const est = new HarnessCostEstimator({ now: () => 7000 });
  const r = record(est);
  assert.equal(r.totalTokens, 1500);
  assert.equal(r.costUsd, 0.0105);
  assert.equal(r.passed, true);
  assert.equal(r.at, 7000);
  const unknown = record(est, { taskId: 't2', model: 'mystery-model-9' });
  assert.equal(unknown.costUsd, 0);
  assert.equal(unknown.note, 'unknown-model-price');
  const fail = record(est, { taskId: 't3', score: 0.5 });
  assert.equal(fail.passed, false);
  assert.throws(() => record(est, { score: 1.5 }), /score/);
  assert.throws(() => record(est, { taskId: '' }), /taskId/);
  assert.throws(() => record(est, { promptTokens: -5 }), /promptTokens/);
  assert.equal(est.allRecords().length, 3);
  assert.equal(est.recordsForTask('t1').length, 1);
  est.clearRecords();
  assert.equal(est.allRecords().length, 0);
});

test('estimator: setPrice / setProfile / preambleCostUsd', () => {
  const est = new HarnessCostEstimator();
  est.setPrice({ model: 'cheap-1', inputPerMillion: 1, outputPerMillion: 1 });
  assert.equal(est.priceRun(1_000_000, 0, 'cheap-1'), 1);
  assert.equal(est.priceRun(100, 100, 'unknown-model'), 0);
  assert.throws(() => est.setPrice({ model: '', inputPerMillion: 1, outputPerMillion: 1 }), /model/);
  assert.throws(() => est.setPrice({ model: 'x', inputPerMillion: -1, outputPerMillion: 1 }), /non-negative/);
  est.setProfile({ id: 'huge', label: 'Huge', preambleTokens: 20000, toolCount: 50 });
  assert.equal(est.getProfile('huge')?.toolCount, 50);
  assert.equal(est.listProfiles().length, V16_DEFAULT_HARNESS_PROFILES.length + 1);
  // Preamble cost: 16600 input tokens @ $3/1M = $0.0498.
  assert.equal(est.preambleCostUsd('claude-code', 'claude-sonnet-4'), 0.0498);
  assert.equal(est.preambleCostUsd('nope', 'claude-sonnet-4'), null);
  assert.equal(est.preambleCostUsd('minimal', 'unknown-model'), null);
  assert.throws(() => est.setProfile({ id: '', label: 'x', preambleTokens: 0, toolCount: 0 }), /id/);
});

test('compare harness: pass rate, $/task, score/$, tokens per pass', () => {
  const est = new HarnessCostEstimator();
  record(est);
  record(est, { taskId: 't2', score: 0 });
  const c = v16CompareHarness('minimal', est.allRecords());
  assert.equal(c?.tasks, 2);
  assert.equal(c?.passRate, 0.5);
  assert.equal(c?.avgScore, 0.5);
  assert.equal(c?.avgTokensPerTask, 1500);
  assert.equal(c?.avgCostPerTaskUsd, 0.0105);
  assert.equal(c?.totalCostUsd, 0.021);
  assert.equal(c?.scorePerDollar, 47.62);
  assert.equal(c?.tokensPerPass, 1500);
  assert.equal(v16CompareHarness('nobody', est.allRecords()), null);
  const allFail = new HarnessCostEstimator();
  record(allFail, { score: 0 });
  assert.equal(v16CompareHarness('minimal', allFail.allRecords())?.tokensPerPass, null);
  assert.equal(v16CompareHarness('minimal', allFail.allRecords())?.passRate, 0);
});

test('cost/accuracy report: 3x cost, ~0 score gap => buys tokens not accuracy', () => {
  const est = new HarnessCostEstimator();
  // minimal: 1500 tokens/task ($0.0105), score 1. claude-code: 8500 tokens/task ($0.0315 = 3x), same score.
  record(est, { taskId: 't1' });
  record(est, { taskId: 't2' });
  record(est, { taskId: 't1', harnessId: 'claude-code', promptTokens: 8000, completionTokens: 500 });
  record(est, { taskId: 't2', harnessId: 'claude-code', promptTokens: 8000, completionTokens: 500 });
  const report = est.report(['minimal', 'claude-code']);
  assert.equal(report.comparisons.length, 2);
  assert.equal(report.maxCostRatio, 3);
  assert.equal(report.maxScoreGap, 0);
  assert.equal(report.cheapestPerPass, 'minimal');
  assert.equal(report.mostEfficient, 'minimal');
  assert.equal(report.highestScore, 'minimal');
  assert.match(report.verdict, /buys tokens, not accuracy/);
  const text = renderV16CostAccuracyReport(report);
  assert.match(text, /minimal \| 2 \| 100%/);
  assert.match(text, /Max cost ratio: 3x/);
  assert.throws(() => v16BuildCostAccuracyReport([], [], ['minimal']), /task id/);
  assert.throws(() => v16BuildCostAccuracyReport([], ['t1'], []), /harness id/);
  assert.throws(() => v16BuildCostAccuracyReport([], ['t1'], ['minimal']), /No cost records/);
});

test('recommend harness: cheapest meeting min score; none meeting => null', () => {
  const est = new HarnessCostEstimator();
  record(est, { taskId: 't1' });
  record(est, { taskId: 't2' });
  record(est, { taskId: 't1', harnessId: 'claude-code', promptTokens: 4000, completionTokens: 500, score: 1 });
  record(est, { taskId: 't2', harnessId: 'claude-code', promptTokens: 4000, completionTokens: 500, score: 0.5 });
  const report = est.report();
  const rec = v16RecommendHarness(report, 0.7);
  assert.equal(rec.harnessId, 'minimal');
  assert.equal(rec.costPerTaskUsd, 0.0105);
  assert.equal(rec.qualifying.length, 2);
  assert.ok((rec.savedVsMostExpensiveUsd ?? 0) > 0);
  assert.match(rec.reason, /cheapest/);
  const none = v16RecommendHarness(report, 1);
  assert.equal(none.harnessId, 'minimal');
  const impossible = v16RecommendHarness(report, 1);
  assert.equal(impossible.harnessId, 'minimal');
  const empty = v16RecommendHarness(
    { generatedAt: 0, taskIds: [], harnessIds: [], comparisons: [], cheapestPerPass: null, highestScore: null, mostEfficient: null, maxCostRatio: null, maxScoreGap: null, verdict: '' },
    0.5,
  );
  assert.equal(empty.harnessId, null);
  assert.match(empty.reason, /No harness has cost data/);
  assert.throws(() => v16RecommendHarness(report, 1.5), /minScore/);
});

test('flakiness: rerun flips detected, spread measured', () => {
  const est = new HarnessCostEstimator();
  record(est, { taskId: 't1', score: 1 });
  record(est, { taskId: 't1', score: 0, note: 'rerun-2' });
  record(est, { taskId: 't2', score: 1 });
  record(est, { taskId: 't2', score: 1, note: 'rerun-2' });
  record(est, { taskId: 't3', score: 1 });
  const flakes = v16AnalyzeFlakiness(est.allRecords());
  assert.equal(flakes.length, 2);
  const t1 = flakes.find((f) => f.taskId === 't1');
  assert.equal(t1?.flipped, true);
  assert.equal(t1?.passes, 1);
  assert.equal(t1?.scoreSpread, 1);
  const t2 = flakes.find((f) => f.taskId === 't2');
  assert.equal(t2?.flipped, false);
  const summary = v16SummarizeFlakiness(flakes);
  assert.equal(summary.tasksRerun, 2);
  assert.equal(summary.tasksFlipped, 1);
  assert.equal(summary.flipRate, 0.5);
  assert.equal(summary.noisiestTask, 't1');
  assert.match(renderV16FlakinessSummary(summary), /flip rate 50/);
  assert.equal(renderV16FlakinessSummary(v16SummarizeFlakiness([])), 'No task was rerun — flakiness unknown.');
});

test('costs by model: totals sorted by cost desc', () => {
  const est = new HarnessCostEstimator();
  record(est, { model: 'gemini-2.5-flash', promptTokens: 1000, completionTokens: 0 });
  record(est, { model: 'claude-sonnet-4' });
  const byModel = v16CostsByModel(est.allRecords());
  assert.equal(byModel.length, 2);
  assert.equal(byModel[0]?.model, 'claude-sonnet-4');
  assert.equal(byModel[1]?.model, 'gemini-2.5-flash');
  assert.equal(byModel[0]?.tasks, 1);
  assert.ok((byModel[0]?.totalCostUsd ?? 0) > (byModel[1]?.totalCostUsd ?? 0));
});
