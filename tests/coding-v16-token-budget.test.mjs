/**
 * Tests cho coding agent v16 — token budget meter (v1.38, Đội T4).
 *
 * Chạy thật: meter thật trong bộ nhớ (không gọi model/mạng).
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v16-token-budget.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TokenBudgetMeter,
  V16_DEFAULT_TASK_BUDGET,
  renderV16BudgetStatus,
  renderV16SessionReport,
  v16BudgetAdvice,
  v16BudgetForecast,
  v16BudgetStatusFor,
  v16EstimateTokens,
  v16SampleFromJsonl,
  v16SampleToJsonl,
  v16SamplesFromJsonl,
  v16SessionReport,
  v16SumSamples,
  v16TokensByHarness,
  v16ValidateBudget,
  v16ValidateSample,
} from '../packages/core/dist/index.js';

function sample(over = {}) {
  return {
    taskId: 'task-1',
    step: 1,
    kind: 'model',
    promptTokens: 100,
    completionTokens: 50,
    at: 1000,
    ...over,
  };
}

test('token estimate: empty = 0, chars/4 rounded up', () => {
  assert.equal(v16EstimateTokens(''), 0);
  assert.equal(v16EstimateTokens('abcd'), 1);
  assert.equal(v16EstimateTokens('abcde'), 2);
  assert.equal(v16EstimateTokens('x'.repeat(400)), 100);
});

test('validate sample/budget: reject bad input', () => {
  assert.throws(() => v16ValidateSample(sample({ promptTokens: -1 })), /promptTokens/);
  assert.throws(() => v16ValidateSample(sample({ taskId: '' })), /taskId/);
  assert.throws(() => v16ValidateSample(sample({ step: 1.5 })), /step/);
  assert.throws(() => v16ValidateBudget({ id: 'b', limitTokens: 0 }), /limitTokens/);
  assert.throws(
    () => v16ValidateBudget({ id: 'b', limitTokens: 100, warnAtPercent: 90, blockAtPercent: 80 }),
    /warnAtPercent/,
  );
  assert.doesNotThrow(() => v16ValidateBudget({ id: 'b', limitTokens: 100 }));
});

test('sum samples: totals + preamble split', () => {
  const total = v16SumSamples([
    sample({ kind: 'preamble', promptTokens: 829, completionTokens: 0, at: 900 }),
    sample({ at: 1000 }),
    sample({ step: 2, promptTokens: 200, completionTokens: 100, at: 1100 }),
  ]);
  assert.equal(total.taskId, 'task-1');
  assert.equal(total.promptTokens, 1129);
  assert.equal(total.completionTokens, 150);
  assert.equal(total.totalTokens, 1279);
  assert.equal(total.samples, 3);
  assert.equal(total.preambleTokens, 829);
  assert.equal(total.firstAt, 900);
  assert.equal(total.lastAt, 1100);
  assert.deepEqual(v16SumSamples([]), {
    taskId: '',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    samples: 0,
    preambleTokens: 0,
    firstAt: 0,
    lastAt: 0,
  });
});

test('meter: record + total + session total + clear', () => {
  const meter = new TokenBudgetMeter({ now: () => 5000 });
  meter.record(sample());
  meter.record(sample({ taskId: 'task-2', promptTokens: 10, completionTokens: 5 }));
  assert.equal(meter.total('task-1').totalTokens, 150);
  assert.equal(meter.sessionTotal().totalTokens, 165);
  assert.deepEqual(meter.taskIds().sort(), ['task-1', 'task-2']);
  assert.equal(meter.clearTask('task-2'), 1);
  assert.equal(meter.total('task-2').totalTokens, 0);
  assert.equal(meter.sessionTotal().totalTokens, 150);
  meter.reset();
  assert.equal(meter.sessionTotal().totalTokens, 0);
});

test('meter: recordText estimates tokens from text', () => {
  const meter = new TokenBudgetMeter({ now: () => 6000 });
  const s = meter.recordText('t', 1, 'model', 'abcd'.repeat(25), 'efgh'.repeat(25), { model: 'm', harness: 'minimal' });
  assert.equal(s.promptTokens, 25);
  assert.equal(s.completionTokens, 25);
  assert.equal(s.model, 'm');
  assert.equal(s.harness, 'minimal');
});

test('budget status: ok / warn / blocked + projection', () => {
  const budget = { id: 'b', limitTokens: 1000, warnAtPercent: 80, blockAtPercent: 100 };
  const ok = v16BudgetStatusFor(budget, 100, 2);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.usedPercent, 10);
  assert.equal(ok.remainingTokens, 900);
  assert.equal(ok.projectedStepsLeft, 18);
  assert.equal(ok.avgTokensPerStep, 50);
  assert.equal(ok.overLimit, false);
  const warn = v16BudgetStatusFor(budget, 850, 5);
  assert.equal(warn.state, 'warn');
  assert.equal(warn.projectedStepsLeft, 0);
  const blocked = v16BudgetStatusFor(budget, 1000, 10);
  assert.equal(blocked.state, 'blocked');
  const over = v16BudgetStatusFor(budget, 1200, 10);
  assert.equal(over.state, 'blocked');
  assert.equal(over.overLimit, true);
  assert.equal(over.remainingTokens, -200);
  const fresh = v16BudgetStatusFor(budget, 0, 0);
  assert.equal(fresh.projectedStepsLeft, null);
  assert.equal(fresh.avgTokensPerStep, null);
  assert.match(renderV16BudgetStatus(warn), /WARN/);
  assert.match(renderV16BudgetStatus(blocked), /BLOCKED/);
});

test('meter: status/isBlocked/recordAndCheck flow', () => {
  const meter = new TokenBudgetMeter();
  meter.setBudget({ id: 'task-1', limitTokens: 200, warnAtPercent: 50, blockAtPercent: 100 });
  assert.equal(meter.status('missing'), null);
  assert.equal(meter.isBlocked('task-1'), false);
  meter.record(sample({ promptTokens: 120, completionTokens: 0 }));
  assert.equal(meter.status('task-1')?.state, 'warn');
  const checked = meter.recordAndCheck(sample({ step: 2, promptTokens: 100, completionTokens: 0 }), 'task-1');
  assert.equal(checked?.state, 'blocked');
  assert.equal(meter.isBlocked('task-1'), true);
  assert.deepEqual(v16BudgetAdvice(meter.status('task-1')), [
    'Budget task-1 blocked at 110% — stop model calls, condense history, or raise the limit.',
  ]);
  assert.deepEqual(v16BudgetAdvice(v16BudgetStatusFor({ id: 'x', limitTokens: 100 }, 10, 1)), []);
});

test('budget forecast: burn rate projection + urgent flag', () => {
  const budget = { id: 'b', limitTokens: 1000 };
  const f = v16BudgetForecast(budget, 800, 8);
  assert.equal(f.avgTokensPerStep, 100);
  assert.equal(f.stepsUntilExhausted, 2);
  assert.equal(f.urgent, true);
  assert.equal(f.remainingTokens, 200);
  assert.match(f.text, /2 step\(s\) left/);
  const fresh = v16BudgetForecast(budget, 0, 0);
  assert.equal(fresh.stepsUntilExhausted, null);
  assert.equal(fresh.urgent, false);
  assert.match(fresh.text, /no steps measured/);
  const done = v16BudgetForecast(budget, 1000, 10);
  assert.equal(done.stepsUntilExhausted, 0);
  assert.match(done.text, /exhausted/);
  assert.throws(() => v16BudgetForecast(budget, -1, 1), /usedTokens/);
});

test('session report: tasks + by harness + preamble share', () => {
  const meter = new TokenBudgetMeter();
  meter.record(sample({ kind: 'preamble', promptTokens: 829, completionTokens: 0, harness: 'minimal' }));
  meter.record(sample({ harness: 'minimal' }));
  meter.record(sample({ taskId: 'task-2', harness: 'claude-code', promptTokens: 16600, completionTokens: 0 }));
  meter.setBudget({ id: 'task-1', limitTokens: 10000 });
  const report = v16SessionReport(meter);
  assert.equal(report.session.totalTokens, 829 + 150 + 16600);
  assert.equal(report.tasks[0]?.taskId, 'task-2');
  assert.equal(report.byHarness[0]?.harness, 'claude-code');
  assert.equal(report.heaviestTask, 'task-2');
  assert.equal(report.heaviestHarness, 'claude-code');
  assert.equal(report.budgets.length, 1);
  assert.ok(report.preambleSharePercent > 0 && report.preambleSharePercent < 100);
  const text = renderV16SessionReport(report);
  assert.match(text, /Token session:/);
  assert.match(text, /Heaviest task: task-2/);
  const byHarness = v16TokensByHarness(meter.samples('task-1'));
  assert.equal(byHarness.length, 1);
  assert.equal(byHarness[0]?.preambleTokens, 829);
});

test('JSONL round-trip: sample -> line -> sample; bad lines counted', () => {
  const s = sample({ model: 'm', harness: 'minimal' });
  const line = v16SampleToJsonl(s);
  assert.ok(line.endsWith('\n'));
  assert.deepEqual(v16SampleFromJsonl(line), s);
  assert.equal(v16SampleFromJsonl(''), null);
  assert.equal(v16SampleFromJsonl('not json'), null);
  assert.equal(v16SampleFromJsonl(JSON.stringify({ taskId: 'x' })), null);
  const { samples, badLines } = v16SamplesFromJsonl(`${line}\nbad line\n${line}`);
  assert.equal(samples.length, 2);
  assert.equal(badLines, 1);
});

test('default task budget is 50k tokens', () => {
  assert.equal(V16_DEFAULT_TASK_BUDGET.limitTokens, 50000);
  assert.equal(V16_DEFAULT_TASK_BUDGET.warnAtPercent, 80);
  assert.equal(V16_DEFAULT_TASK_BUDGET.blockAtPercent, 100);
});
