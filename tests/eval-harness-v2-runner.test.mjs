/**
 * Tests for Eval Harness v2 runner (v1.34, Đội T4):
 * `packages/core/src/evalHarnessV2/runner.ts` + `sandbox.ts`.
 *
 * Covers: scripted executor passing the sample suite (oracle plan),
 * noop executor failing (honest baseline), wrong patch failing,
 * parallel trials (concurrency limit respected, all trials run),
 * timeout (hanging executor -> trial timeout, suite survives),
 * cancellation (pre-aborted signal -> trial cancelled),
 * executor error -> trial error (no crash), sandbox fallback warning
 * present when bwrap is missing, and suite aggregation counts.
 *
 * Runs real `node` in temp sandboxes (fast, no network, no Docker).
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-harness-v2-runner.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_EVAL_HARNESS_V2_SUITE,
  EVAL_HARNESS_V2_SAMPLE_TASK_ADD,
  EVAL_HARNESS_V2_SAMPLE_TASK_GREET,
  EVAL_HARNESS_V2_SAMPLE_TASK_SUM,
  aggregateTaskTrials,
  buildSuiteResult,
  isBwrapAvailable,
  noopEvalHarnessV2Executor,
  runEvalHarnessV2Task,
  runEvalHarnessV2Tasks,
  runEvalHarnessV2Trial,
  runEvalHarnessV2Suite,
  runInEvalSandbox,
  scriptedEvalHarnessV2Executor,
} from '../packages/core/dist/evalHarnessV2/index.js';

/** Scripted plan that solves every sample task (== oracle solutions). */
export const ORACLE_PLAN = {
  'v2-sample-add': {
    files: { 'add.js': 'function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n' },
    commands: [],
    steps: 3,
    inputTokens: 1000,
    outputTokens: 200,
  },
  'v2-sample-greet': {
    files: { 'hello.txt': 'HELLO EVAL\n' },
    commands: [],
    steps: 1,
    inputTokens: 500,
    outputTokens: 50,
  },
  'v2-sample-sum': {
    files: { 'sum.txt': '60\n' },
    commands: [],
    steps: 2,
    inputTokens: 800,
    outputTokens: 100,
  },
};

const oracleExecutor = scriptedEvalHarnessV2Executor(ORACLE_PLAN);

test('sandbox runs a trivial command and reports sandboxed flag honestly', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'eval-harness-v2-sandbox-'));
  try {
    const ok = await runInEvalSandbox('node -e "console.log(42)"', dir, 10_000);
    assert.equal(ok.passed, true);
    assert.equal(ok.exitCode, 0);
    assert.match(ok.stdout, /42/);
    assert.equal(ok.sandboxed, isBwrapAvailable());
    if (!ok.sandboxed) assert.match(ok.sandboxWarning ?? '', /bwrap/);
    const fail = await runInEvalSandbox('node -e "process.exit(3)"', dir, 10_000);
    assert.equal(fail.passed, false);
    assert.equal(fail.exitCode, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandbox rejects a missing workdir', async () => {
  await assert.rejects(() => runInEvalSandbox('echo hi', '/nonexistent-dir-xyz', 1000), /workdir/);
});

test('scripted executor with oracle plan passes sample add task (issue-patch)', async () => {
  const result = await runEvalHarnessV2Task(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, oracleExecutor, {
    trials: 2,
    concurrency: 2,
  });
  assert.equal(result.taskId, 'v2-sample-add');
  assert.equal(result.passRate, 1);
  assert.equal(result.meanScore, 1);
  assert.equal(result.trials.length, 2);
  for (const trial of result.trials) {
    assert.equal(trial.status, 'pass');
    assert.equal(trial.passedTests, 2);
    assert.equal(trial.totalTests, 2);
    // fail-to-pass must have failed on base, passed after patch.
    const ftp = trial.tests.find((t) => t.group === 'fail-to-pass');
    assert.equal(ftp.basePassed, false);
    assert.equal(ftp.afterPassed, true);
    assert.equal(ftp.expectationMet, true);
    assert.equal(trial.steps, 3);
    assert.equal(trial.inputTokens, 1000);
    assert.ok(trial.estimatedCostUsd >= 0);
    assert.equal(trial.sandboxed, isBwrapAvailable());
  }
});

test('scripted executor with oracle plan passes state-check tasks', async () => {
  const greet = await runEvalHarnessV2Task(EVAL_HARNESS_V2_SAMPLE_TASK_GREET, oracleExecutor, { trials: 1 });
  assert.equal(greet.passRate, 1);
  assert.equal(greet.trials[0].status, 'pass');
  const sum = await runEvalHarnessV2Task(EVAL_HARNESS_V2_SAMPLE_TASK_SUM, oracleExecutor, { trials: 1 });
  assert.equal(sum.passRate, 1);
  assert.equal(sum.trials[0].status, 'pass');
});

test('noop executor fails all sample tasks (honest baseline)', async () => {
  const result = await runEvalHarnessV2Task(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, noopEvalHarnessV2Executor, {
    trials: 1,
  });
  assert.equal(result.passRate, 0);
  assert.equal(result.trials[0].status, 'fail');
  assert.match(result.trials[0].reason, /fail/);
});

test('wrong patch fails: fail-to-pass stays failing', async () => {
  const wrongPlan = scriptedEvalHarnessV2Executor({
    'v2-sample-add': {
      files: { 'add.js': 'function add(a, b) { return a * b; }\nmodule.exports = { add };\n' },
      commands: [],
      steps: 1,
      inputTokens: 0,
      outputTokens: 0,
    },
  });
  const result = await runEvalHarnessV2Task(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, wrongPlan, { trials: 1 });
  assert.equal(result.passRate, 0);
  assert.equal(result.trials[0].tests.find((t) => t.group === 'fail-to-pass').expectationMet, false);
});

test('regression patch fails: pass-to-pass broken by patch', async () => {
  const breakingPlan = scriptedEvalHarnessV2Executor({
    'v2-sample-add': {
      files: {
        'add.js': 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n',
        'test-add.js': 'throw new Error("broken");\n',
      },
      commands: [],
      steps: 1,
      inputTokens: 0,
      outputTokens: 0,
    },
  });
  const result = await runEvalHarnessV2Task(EVAL_HARNESS_V2_SAMPLE_TASK_ADD, breakingPlan, { trials: 1 });
  assert.equal(result.passRate, 0);
  assert.equal(result.trials[0].score < 1, true);
});

test('runEvalHarnessV2Suite with oracle plan passes whole sample suite', async () => {
  const result = await runEvalHarnessV2Suite(BUILTIN_EVAL_HARNESS_V2_SUITE, oracleExecutor, {
    trials: 1,
    concurrency: 2,
    agentLabel: 'scripted-test',
    saveReport: false,
  });
  assert.equal(result.suiteId, 'v2-sample');
  assert.equal(result.agentLabel, 'scripted-test');
  assert.equal(result.tasks.length, 3);
  assert.equal(result.trialPassRate, 1);
  assert.equal(result.taskPassRate, 1);
  assert.equal(result.meanScore, 1);
  assert.ok(result.trialPassRateCi95.lower > 0.3, 'Wilson CI lower bound should be > 0.3 for 3/3');
  assert.equal(result.trialPassRateCi95.upper, 1);
});

test('parallel trials: concurrency limit respected, all trials run', async () => {
  let running = 0;
  let maxRunning = 0;
  const slowExecutor = async (task, workDir, trialIndex, signal) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 50));
    running -= 1;
    void task;
    void workDir;
    void trialIndex;
    void signal;
    return { files: { 'hello.txt': 'HELLO EVAL\n' }, commands: [], steps: 1, inputTokens: 0, outputTokens: 0 };
  };
  const result = await runEvalHarnessV2Task(EVAL_HARNESS_V2_SAMPLE_TASK_GREET, slowExecutor, {
    trials: 4,
    concurrency: 2,
  });
  assert.equal(result.trials.length, 4);
  assert.ok(maxRunning <= 2, `max concurrent trials ${maxRunning} exceeded limit 2`);
  assert.equal(result.passRate, 1);
});

test('hanging executor times out, trial marked timeout, suite survives', async () => {
  const hangingExecutor = () => new Promise(() => {});
  const task = { ...EVAL_HARNESS_V2_SAMPLE_TASK_GREET, timeoutMs: 5_000, maxTrials: 1 };
  const started = Date.now();
  const trial = await runEvalHarnessV2Trial(task, hangingExecutor, 0, {});
  assert.equal(trial.status, 'timeout');
  assert.match(trial.reason, /timeout/);
  assert.ok(Date.now() - started < 15_000, 'trial should time out near 5s, not hang');
  assert.ok(trial.durationMs >= 4_500, 'trial should have waited for the timeout');
});

test('pre-aborted signal cancels the trial before running', async () => {
  const controller = new AbortController();
  controller.abort();
  const trial = await runEvalHarnessV2Trial(
    EVAL_HARNESS_V2_SAMPLE_TASK_GREET,
    oracleExecutor,
    0,
    { signal: controller.signal },
  );
  assert.equal(trial.status, 'cancelled');
});

test('executor error becomes trial error, not a crash', async () => {
  const failingExecutor = async () => {
    throw new Error('agent exploded');
  };
  const result = await runEvalHarnessV2Task(EVAL_HARNESS_V2_SAMPLE_TASK_GREET, failingExecutor, {
    trials: 1,
  });
  assert.equal(result.trials[0].status, 'error');
  assert.match(result.trials[0].reason, /agent exploded/);
});

test('agent command failure fails the trial with a clear reason', async () => {
  const badCommandPlan = scriptedEvalHarnessV2Executor({
    'v2-sample-greet': {
      files: {},
      commands: ['node -e "process.exit(7)"'],
      steps: 1,
      inputTokens: 0,
      outputTokens: 0,
    },
  });
  const result = await runEvalHarnessV2Task(EVAL_HARNESS_V2_SAMPLE_TASK_GREET, badCommandPlan, {
    trials: 1,
  });
  assert.equal(result.trials[0].status, 'fail');
  assert.match(result.trials[0].reason, /Lệnh agent fail/);
});

test('aggregateTaskTrials + buildSuiteResult compute counts', () => {
  const trials = [
    { status: 'pass', score: 1, durationMs: 100, steps: 2, estimatedCostUsd: 0.01 },
    { status: 'fail', score: 0.5, durationMs: 200, steps: 3, estimatedCostUsd: 0.02 },
  ];
  const taskResult = aggregateTaskTrials(EVAL_HARNESS_V2_SAMPLE_TASK_GREET, trials);
  assert.equal(taskResult.passRate, 0.5);
  assert.equal(taskResult.meanScore, 0.75);
  assert.equal(taskResult.meanDurationMs, 150);
  const suite = buildSuiteResult('v2-test', 'noop', [taskResult], Date.now() - 1000, 'run-1');
  assert.equal(suite.runId, 'run-1');
  assert.equal(suite.trialPassRate, 0.5);
  assert.equal(suite.totalCostUsd, 0.03);
});

test('runEvalHarnessV2Tasks runs several tasks with a shared pool', async () => {
  const results = await runEvalHarnessV2Tasks(
    [EVAL_HARNESS_V2_SAMPLE_TASK_GREET, EVAL_HARNESS_V2_SAMPLE_TASK_SUM],
    oracleExecutor,
    { trials: 1, concurrency: 2 },
  );
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.passRate === 1));
});
