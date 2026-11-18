/**
 * Tests for Eval Harness v2 scorer + regression gate (v1.34, Đội T4):
 * `packages/core/src/evalHarnessV2/scorer.ts` +
 * `regressionGate.ts`.
 *
 * Covers: 4-dimension trial scoring, cost estimate (known model via
 * repo price table vs fallback rate vs zero tokens), Wilson 95% CI
 * (empty, perfect, partial), OTel trace link (Tracer -> traceToOtel,
 * span attributes carry test results, trace cost estimate),
 * suite aggregation, baseline save/load round-trip (local JSON),
 * gate PASS on no baseline, gate FAIL naming the regressed task when
 * pass rate drops past threshold, gate PASS when drop is within
 * threshold, duration/cost rises only warn (never fail the gate),
 * and gate text rendering.
 *
 * No sandbox runs here (pure scoring/gate logic, fast).
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-harness-v2-scorer-gate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EVAL_HARNESS_V2_SAMPLE_TASK_ADD,
  EVAL_HARNESS_V2_SAMPLE_TASK_GREET,
  EVAL_HARNESS_V2_SAMPLE_TASK_SUM,
  aggregateSuiteResults,
  buildEvalHarnessV2Baseline,
  buildEvalTrialTrace,
  checkEvalHarnessV2Regression,
  DEFAULT_EVAL_HARNESS_V2_GATE_THRESHOLDS,
  estimateEvalCostUsd,
  estimateTrialTraceCostUsd,
  getEvalHarnessV2BaselinePath,
  loadEvalHarnessV2Baseline,
  renderEvalHarnessV2GateText,
  renderEvalHarnessV2SuiteText,
  saveEvalHarnessV2Baseline,
  saveEvalHarnessV2Report,
  scoreEvalHarnessV2Task,
  scoreEvalHarnessV2Trial,
  trialTraceToOtel,
  wilsonCi95,
} from '../packages/core/dist/evalHarnessV2/index.js';

function makeTrial(overrides = {}) {
  return {
    trialId: 'v2-sample-add-t0',
    taskId: 'v2-sample-add',
    trialIndex: 0,
    status: 'pass',
    score: 1,
    tests: [
      {
        testId: 'add-returns-sum',
        name: 'add() returns sum',
        group: 'fail-to-pass',
        basePassed: false,
        afterPassed: true,
        expectationMet: true,
        weight: 2,
        durationMs: 50,
        stdout: 'add() OK',
      },
      {
        testId: 'add-module-loads',
        name: 'add.js loads',
        group: 'pass-to-pass',
        basePassed: null,
        afterPassed: true,
        expectationMet: true,
        weight: 1,
        durationMs: 10,
        stdout: 'loads',
      },
    ],
    passedTests: 2,
    totalTests: 2,
    durationMs: 120,
    steps: 3,
    inputTokens: 1000,
    outputTokens: 200,
    estimatedCostUsd: 0.001,
    sandboxed: false,
    sandboxWarning: 'No bwrap.',
    reason: 'All tests met.',
    startedAt: Date.now() - 120,
    finishedAt: Date.now(),
    ...overrides,
  };
}

function makeTaskResult(task, trials) {
  const passed = trials.filter((t) => t.status === 'pass').length;
  return {
    taskId: task.id,
    taskName: task.name,
    kind: task.kind,
    difficulty: task.difficulty,
    trials,
    passRate: trials.length === 0 ? 0 : passed / trials.length,
    meanScore: trials.reduce((s, t) => s + t.score, 0) / Math.max(1, trials.length),
    meanDurationMs: trials.reduce((s, t) => s + t.durationMs, 0) / Math.max(1, trials.length),
    meanSteps: trials.reduce((s, t) => s + t.steps, 0) / Math.max(1, trials.length),
    meanCostUsd: trials.reduce((s, t) => s + t.estimatedCostUsd, 0) / Math.max(1, trials.length),
  };
}

function makeSuiteResult(taskResults, runId = 'run-test-1') {
  return aggregateSuiteResults('v2-sample', 'scripted', taskResults, Date.now() - 1000, runId);
}

test('scoreEvalHarnessV2Trial returns all 4 dimensions', () => {
  const score = scoreEvalHarnessV2Trial(makeTrial());
  assert.equal(score.correctness, 1);
  assert.equal(score.passed, true);
  assert.equal(score.status, 'pass');
  assert.equal(score.durationMs, 120);
  assert.equal(score.steps, 3);
  assert.equal(score.estimatedCostUsd, 0.001);
  assert.equal(score.inputTokens, 1000);
  const failed = scoreEvalHarnessV2Trial(makeTrial({ status: 'fail', score: 0.5 }));
  assert.equal(failed.passed, false);
  assert.equal(failed.correctness, 0.5);
});

test('scoreEvalHarnessV2Task aggregates trials', () => {
  const taskResult = makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [
    makeTrial(),
    makeTrial({ trialId: 'v2-sample-add-t1', status: 'fail', score: 0 }),
  ]);
  const score = scoreEvalHarnessV2Task(taskResult);
  assert.equal(score.passRate, 0.5);
  assert.equal(score.meanCorrectness, 0.5);
  assert.equal(score.trials, 2);
});

test('estimateEvalCostUsd: zero tokens costs zero', () => {
  assert.equal(estimateEvalCostUsd(0, 0), 0);
  assert.equal(estimateEvalCostUsd(0, 0, 'gpt-4o'), 0);
});

test('estimateEvalCostUsd: unknown model uses fallback rate', () => {
  // Fallback: $3/1M in + $15/1M out.
  const cost = estimateEvalCostUsd(1_000_000, 1_000_000, 'some-unknown-model-xyz');
  assert.equal(cost, 18);
  const small = estimateEvalCostUsd(1000, 200);
  assert.equal(small, 0.003 + 0.003);
});

test('estimateEvalCostUsd: known model uses repo price table', () => {
  const cost = estimateEvalCostUsd(1000, 1000, 'gpt-4o');
  assert.ok(cost > 0 && cost < 0.1, `gpt-4o 1k/1k should be small, got ${cost}`);
  assert.notEqual(cost, 0.003 + 0.015, 'known model must not use the fallback rate');
});

test('wilsonCi95: empty data is maximally uncertain', () => {
  assert.deepEqual(wilsonCi95(0, 0), { lower: 0, upper: 1 });
});

test('wilsonCi95: perfect 10/10 has high lower bound, upper 1', () => {
  const ci = wilsonCi95(10, 10);
  assert.equal(ci.upper, 1);
  assert.ok(ci.lower > 0.65 && ci.lower < 1, `lower=${ci.lower}`);
});

test('wilsonCi95: 5/10 contains 0.5', () => {
  const ci = wilsonCi95(5, 10);
  assert.ok(ci.lower < 0.5 && ci.upper > 0.5, JSON.stringify(ci));
});

test('buildEvalTrialTrace links trial to OTel via repo Tracer', () => {
  const trial = makeTrial();
  const trace = buildEvalTrialTrace(trial, EVAL_HARNESS_V2_SAMPLE_TASK_ADD, 'gpt-4o');
  assert.equal(trace.runId, trial.trialId);
  assert.equal(trace.botId, 'eval-harness-v2:v2-sample-add');
  // Root span + 1 llm span + 2 test spans.
  assert.equal(trace.spans.length, 4);
  const llmSpan = trace.spans.find((s) => s.kind === 'llm');
  assert.ok(llmSpan, 'should have an llm span carrying tokens');
  assert.equal(llmSpan.attributes.model, 'gpt-4o');
  assert.equal(llmSpan.attributes.inputTokens, 1000);
  const testSpan = trace.spans.find((s) => s.name === 'test:add-returns-sum');
  assert.ok(testSpan, 'should have a span per test');
  assert.equal(testSpan.attributes.passed, true);
  // OTel conversion keeps the trace id.
  const otel = trialTraceToOtel(trace);
  assert.equal(otel.scopeSpans[0].spans.length, 4);
  assert.equal(otel.scopeSpans[0].spans[0].traceId.length, 32);
  // Trace cost estimate matches the repo price table path.
  const traceCost = estimateTrialTraceCostUsd(trace);
  assert.ok(traceCost > 0, `trace cost should be > 0, got ${traceCost}`);
});

test('buildEvalTrialTrace without tokens has no llm span', () => {
  const trial = makeTrial({ inputTokens: 0, outputTokens: 0 });
  const trace = buildEvalTrialTrace(trial, EVAL_HARNESS_V2_SAMPLE_TASK_ADD);
  assert.equal(trace.spans.filter((s) => s.kind === 'llm').length, 0);
  assert.equal(estimateTrialTraceCostUsd(trace), 0);
});

test('aggregateSuiteResults computes pass rates + CI + totals', () => {
  const suite = makeSuiteResult([
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [makeTrial()]),
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_GREET, [
      makeTrial({ trialId: 'v2-sample-greet-t0', taskId: 'v2-sample-greet', status: 'fail', score: 0 }),
    ]),
  ]);
  assert.equal(suite.taskPassRate, 0.5);
  assert.equal(suite.trialPassRate, 0.5);
  assert.equal(suite.meanScore, 0.5);
  assert.ok(suite.trialPassRateCi95.lower < 0.5 && suite.trialPassRateCi95.upper > 0.5);
  assert.equal(suite.totalCostUsd, 0.002);
  assert.match(renderEvalHarnessV2SuiteText(suite), /v2-sample-add/);
  assert.match(renderEvalHarnessV2SuiteText(suite), /Trial pass rate: 50\.0%/);
});

test('baseline save/load round-trips locally', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-harness-v2-base-'));
  try {
    assert.equal(loadEvalHarnessV2Baseline(base), null);
    const suite = makeSuiteResult([
      makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [makeTrial()]),
    ]);
    const baseline = buildEvalHarnessV2Baseline(suite);
    const savedPath = saveEvalHarnessV2Baseline(base, baseline);
    assert.equal(savedPath, getEvalHarnessV2BaselinePath(base));
    const loaded = loadEvalHarnessV2Baseline(base);
    assert.equal(loaded.suiteId, 'v2-sample');
    assert.equal(loaded.trialPassRate, 1);
    assert.equal(loaded.perTask['v2-sample-add'].passRate, 1);
    const reportPath = saveEvalHarnessV2Report(base, suite);
    assert.ok(fs.existsSync(reportPath));
    assert.ok(JSON.parse(fs.readFileSync(reportPath, 'utf8')).runId === 'run-test-1');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('gate passes with no baseline (first run)', () => {
  const suite = makeSuiteResult([
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [makeTrial()]),
  ]);
  const gate = checkEvalHarnessV2Regression(null, suite);
  assert.equal(gate.passed, true);
  assert.equal(gate.noBaseline, true);
  assert.deepEqual(gate.findings, []);
  assert.match(renderEvalHarnessV2GateText(gate), /PASS \(chưa có baseline/);
});

test('gate FAILS and names the regressed task when pass rate drops past threshold', () => {
  const baselineSuite = makeSuiteResult([
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [makeTrial()]),
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_GREET, [
      makeTrial({ trialId: 'v2-sample-greet-t0', taskId: 'v2-sample-greet' }),
    ]),
  ]);
  const baseline = buildEvalHarnessV2Baseline(baselineSuite);
  const currentSuite = makeSuiteResult(
    [
      makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [makeTrial()]),
      makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_GREET, [
        makeTrial({ trialId: 'v2-sample-greet-t0', taskId: 'v2-sample-greet', status: 'fail', score: 0 }),
      ]),
    ],
    'run-test-2',
  );
  const gate = checkEvalHarnessV2Regression(baseline, currentSuite);
  assert.equal(gate.passed, false);
  assert.ok(gate.findings.some((f) => f.level === 'fail' && f.scope === 'v2-sample-greet'));
  assert.ok(gate.findings.some((f) => f.level === 'fail' && f.scope === 'suite'));
  const text = renderEvalHarnessV2GateText(gate);
  assert.match(text, /FAIL/);
  assert.match(text, /v2-sample-greet/);
});

test('gate PASSES when the drop is within threshold', () => {
  const baselineSuite = makeSuiteResult([
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [
      makeTrial(),
      makeTrial({ trialId: 'v2-sample-add-t1' }),
    ]),
  ]);
  const baseline = buildEvalHarnessV2Baseline(baselineSuite);
  // 2/2 -> 1/2 is a 0.5 drop: too big. Use 10 trials: 10/10 -> 9/10 = 0.1 drop on
  // task (threshold 0.10, strictly greater fails) and 0.1 suite drop (> 0.05 fails).
  // So instead check a small drop: baseline 1.0, current 0.96 via 25 trials.
  const manyPass = Array.from({ length: 24 }, (_, i) =>
    makeTrial({ trialId: `v2-sample-add-t${i}` }),
  );
  const oneFail = makeTrial({ trialId: 'v2-sample-add-t24', status: 'fail', score: 0 });
  const currentSuite = makeSuiteResult(
    [makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [...manyPass, oneFail])],
    'run-test-3',
  );
  // Task drop 0.04 < 0.10 threshold -> no task fail; suite drop 0.04 < 0.05 -> no suite fail.
  const gate = checkEvalHarnessV2Regression(baseline, currentSuite);
  assert.equal(gate.passed, true);
  assert.equal(gate.findings.filter((f) => f.level === 'fail').length, 0);
});

test('duration/cost rises only warn, never fail the gate', () => {
  const baselineSuite = makeSuiteResult([
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [makeTrial({ durationMs: 100, estimatedCostUsd: 0.001 })]),
  ]);
  const baseline = buildEvalHarnessV2Baseline(baselineSuite);
  const currentSuite = makeSuiteResult(
    [
      makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [
        makeTrial({ durationMs: 10_000, estimatedCostUsd: 0.01 }),
      ]),
    ],
    'run-test-4',
  );
  const gate = checkEvalHarnessV2Regression(baseline, currentSuite);
  assert.equal(gate.passed, true);
  assert.ok(gate.findings.some((f) => f.level === 'warn' && f.metric === 'meanDurationMs'));
  assert.ok(gate.findings.some((f) => f.level === 'warn' && f.metric === 'meanCostUsd'));
  assert.equal(gate.findings.filter((f) => f.level === 'fail').length, 0);
});

test('gate ignores tasks missing from the current suite', () => {
  const baselineSuite = makeSuiteResult([
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [makeTrial()]),
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_SUM, [makeTrial({ trialId: 't', taskId: 'v2-sample-sum' })]),
  ]);
  const baseline = buildEvalHarnessV2Baseline(baselineSuite);
  const currentSuite = makeSuiteResult([
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [makeTrial()]),
  ]);
  const gate = checkEvalHarnessV2Regression(baseline, currentSuite);
  assert.equal(gate.passed, true);
});

test('gate thresholds are customizable', () => {
  const baselineSuite = makeSuiteResult([
    makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [makeTrial()]),
  ]);
  const baseline = buildEvalHarnessV2Baseline(baselineSuite);
  const currentSuite = makeSuiteResult(
    [makeTaskResult(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, [makeTrial({ status: 'fail', score: 0 })])],
    'run-test-5',
  );
  const strict = checkEvalHarnessV2Regression(baseline, currentSuite, {
    ...DEFAULT_EVAL_HARNESS_V2_GATE_THRESHOLDS,
    suitePassRateDrop: 0,
    taskPassRateDrop: 0,
  });
  assert.equal(strict.passed, false);
  const lenient = checkEvalHarnessV2Regression(baseline, currentSuite, {
    ...DEFAULT_EVAL_HARNESS_V2_GATE_THRESHOLDS,
    suitePassRateDrop: 1,
    taskPassRateDrop: 1,
  });
  assert.equal(lenient.passed, true);
});
