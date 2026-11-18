/**
 * Tests for Eval Harness v3 registry + regression gate + tools + i18n
 * (v1.35, Đội T4): `packages/core/src/evalHarnessV3/registry.ts` +
 * `regressionGate.ts` + `packages/tools/src/evalHarnessV3Tools.ts` +
 * `apps/desktop/src/renderer/i18n/locales/`.
 *
 * Covers: registry (register/list/find, set version bump on change,
 * resolve with missing tasks, delete set, save/load round-trip,
 * render), gate (no baseline passes, oracle baseline vs noop run
 * FAILs with findings, thresholds off pass, version mismatch,
 * history append/read, baseline/report save/load), tools (all 8 names
 * in ALL_TOOLS exactly once, unbound placeholder NOT_WIRED, bound
 * list/validate/run task/run suite/run set/baseline/gate/trace with a
 * scripted oracle plan -> pass; noop -> fail; gate FAIL after a
 * regression), `createDefaultTools` binding without duplicates, and
 * `evalHarness.v3.*` keys present in all 6 locales.
 *
 * Runs the sample suite with real `node` in temp containers (fast, no
 * network, no Docker, no model). Run after building tools (which
 * builds core first):
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/eval-harness-v3-scorer-gate-registry-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  EVAL_HARNESS_V3_TOOL_NAMES,
  EVAL_HARNESS_V3_TOOLS,
  createEvalHarnessV3Tools,
} from '../packages/tools/dist/evalHarnessV3Tools.js';
import {
  BUILTIN_EVAL_HARNESS_V3_SUITE,
  EvalHarnessV3Registry,
  appendEvalHarnessV3GateHistory,
  buildEvalHarnessV3Baseline,
  checkEvalHarnessV3Regression,
  loadEvalHarnessV3Baseline,
  loadEvalHarnessV3Registry,
  loadEvalHarnessV3Report,
  noopEvalHarnessV3Executor,
  readEvalHarnessV3GateHistory,
  renderEvalHarnessV3GateText,
  renderEvalHarnessV3RegistryText,
  runEvalHarnessV3Suite,
  saveEvalHarnessV3Baseline,
  saveEvalHarnessV3Registry,
  saveEvalHarnessV3Report,
  scriptedEvalHarnessV3Executor,
} from '../packages/core/dist/evalHarnessV3/index.js';

const CTX = { workspaceDir: '/tmp', signal: undefined };
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-harness-v3-gate-'));
}

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly one tool named ${name}, got ${found.length}`);
  return found[0];
}

function toolNames(tools) {
  return tools.map((t) => t.definition.name);
}

/** Scripted plan solving every sample task (== oracle solutions). */
const ORACLE_PLAN = {
  'v3-sample-add': {
    files: { 'add.js': 'function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n' },
    commands: [],
    steps: 3,
    inputTokens: 1000,
    outputTokens: 200,
  },
  'v3-sample-greet': { files: { 'hello.txt': 'HELLO EVAL\n' }, commands: [], steps: 1, inputTokens: 500, outputTokens: 50 },
  'v3-sample-sum': { files: { 'sum.txt': '60\n' }, commands: [], steps: 2, inputTokens: 800, outputTokens: 100 },
  'v3-sample-guardrail': { files: { 'report.txt': 'builds: 12\nfailures: 2\n' }, commands: [], steps: 2, inputTokens: 600, outputTokens: 80 },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('registry: register/list/find tasks, set version bumps on change', () => {
  const registry = new EvalHarnessV3Registry();
  registry.registerTasks(BUILTIN_EVAL_HARNESS_V3_SUITE.tasks);
  assert.equal(registry.size().tasks, 4);
  assert.equal(registry.listTasks()[0]?.id, 'v3-sample-add');
  assert.equal(registry.findTasks({ kind: 'issue-patch' }).length, 1);
  assert.equal(registry.findTasks({ tag: 'guardrail' }).length, 1);
  assert.equal(registry.findTasks({ difficulty: 'medium' }).length, 1);
  const entry = registry.getEntry('v3-sample-add');
  assert.deepEqual(entry?.setIds, []);
  const set = registry.upsertSet({
    id: 'v3-smoke',
    name: 'Smoke',
    description: 'Fast set.',
    taskIds: ['v3-sample-add', 'v3-sample-greet'],
    tags: ['smoke'],
  });
  assert.equal(set.version, 1);
  assert.equal(registry.getEntry('v3-sample-add')?.setIds.includes('v3-smoke'), true);
  // Same task list -> version stays; changed list -> version bumps.
  const same = registry.upsertSet({
    id: 'v3-smoke', name: 'Smoke', description: 'Fast set.',
    taskIds: ['v3-sample-add', 'v3-sample-greet'],
  });
  assert.equal(same.version, 1);
  const changed = registry.upsertSet({
    id: 'v3-smoke', name: 'Smoke', description: 'Fast set.',
    taskIds: ['v3-sample-add', 'v3-sample-greet', 'v3-sample-sum'],
  });
  assert.equal(changed.version, 2);
  assert.throws(
    () => registry.upsertSet({ id: 'Bad ID!', name: 'x', description: 'x', taskIds: [] }),
    /không hợp lệ/,
  );
});

test('registry: resolve set reports missing tasks, unregister removes from sets', () => {
  const registry = new EvalHarnessV3Registry();
  registry.registerTasks(BUILTIN_EVAL_HARNESS_V3_SUITE.tasks);
  registry.upsertSet({
    id: 'v3-mixed', name: 'Mixed', description: 'Has a ghost.',
    taskIds: ['v3-sample-add', 'v3-ghost'],
  });
  const resolved = registry.resolveEvalSet('v3-mixed');
  assert.equal(resolved.tasks.length, 1);
  assert.deepEqual(resolved.missing, ['v3-ghost']);
  assert.throws(() => registry.resolveEvalSet('v3-nope'), /Không có eval set/);
  assert.equal(registry.unregisterTask('v3-sample-add'), true);
  assert.equal(registry.resolveEvalSet('v3-mixed').tasks.length, 0);
  assert.equal(registry.deleteSet('v3-mixed'), true);
  assert.equal(registry.deleteSet('v3-mixed'), false);
});

test('registry: save/load round-trip preserves tasks and sets', () => {
  const dir = tmpDir();
  try {
    const registry = new EvalHarnessV3Registry();
    registry.registerTasks(BUILTIN_EVAL_HARNESS_V3_SUITE.tasks);
    registry.upsertSet({
      id: 'v3-sample', name: 'Sample', description: 'All.',
      taskIds: ['v3-sample-add', 'v3-sample-greet', 'v3-sample-sum', 'v3-sample-guardrail'],
    });
    const filePath = saveEvalHarnessV3Registry(dir, registry);
    assert.ok(fs.existsSync(filePath));
    const { registry: loaded, skipped } = loadEvalHarnessV3Registry(dir);
    assert.equal(skipped.length, 0);
    assert.equal(loaded.size().tasks, 4);
    assert.equal(loaded.size().sets, 1);
    assert.equal(loaded.resolveEvalSet('v3-sample').tasks.length, 4);
    assert.match(renderEvalHarnessV3RegistryText(loaded), /v3-sample/);
    // Corrupt file -> empty registry + skipped note, no throw.
    fs.writeFileSync(filePath, '{bad json', 'utf8');
    const broken = loadEvalHarnessV3Registry(dir);
    assert.equal(broken.registry.size().tasks, 0);
    assert.equal(broken.skipped.length, 1);
    assert.deepEqual(loadEvalHarnessV3Registry(tmpDir()).registry.size(), { tasks: 0, sets: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

test('gate: no baseline passes; oracle baseline vs noop run fails with findings', async () => {
  const oracleResult = await runEvalHarnessV3Suite(
    BUILTIN_EVAL_HARNESS_V3_SUITE,
    scriptedEvalHarnessV3Executor(ORACLE_PLAN),
    { trials: 1, concurrency: 2, agentLabel: 'scripted-oracle' },
  );
  assert.equal(oracleResult.trialPassRate, 1);
  const noBaseline = checkEvalHarnessV3Regression(null, oracleResult);
  assert.equal(noBaseline.passed, true);
  assert.equal(noBaseline.noBaseline, true);

  const baseline = buildEvalHarnessV3Baseline(oracleResult);
  const noopResult = await runEvalHarnessV3Suite(
    BUILTIN_EVAL_HARNESS_V3_SUITE,
    noopEvalHarnessV3Executor,
    { trials: 1, concurrency: 2, agentLabel: 'noop' },
  );
  assert.equal(noopResult.trialPassRate, 0);
  const gate = checkEvalHarnessV3Regression(baseline, noopResult);
  assert.equal(gate.passed, false);
  assert.equal(gate.noBaseline, false);
  assert.equal(gate.baselineRunId, baseline.runId);
  assert.ok(gate.findings.some((f) => f.kind === 'suite-pass-rate'));
  assert.ok(gate.findings.some((f) => f.kind === 'task-pass-rate'));
  assert.ok(gate.findings.some((f) => f.kind === 'mean-score'));
  assert.match(renderEvalHarnessV3GateText(gate), /FAIL/);
  // Same result vs its own baseline passes.
  const sameGate = checkEvalHarnessV3Regression(baseline, oracleResult);
  assert.equal(sameGate.passed, true);
  assert.match(renderEvalHarnessV3GateText(sameGate), /PASS/);
  // All thresholds off -> noop run passes the gate.
  const offGate = checkEvalHarnessV3Regression(baseline, noopResult, {
    suitePassRateDrop: null,
    taskPassRateDrop: null,
    meanScoreDrop: null,
    maxCostIncreaseUsd: null,
    maxDurationIncreaseMs: null,
    maxGuardrailTrips: null,
  });
  assert.equal(offGate.passed, true);
});

test('gate: version mismatch and wrong suite are reported, not silently passed', async () => {
  const oracleResult = await runEvalHarnessV3Suite(
    BUILTIN_EVAL_HARNESS_V3_SUITE,
    scriptedEvalHarnessV3Executor(ORACLE_PLAN),
    { trials: 1, concurrency: 2, agentLabel: 'scripted-oracle' },
  );
  const baseline = buildEvalHarnessV3Baseline(oracleResult, 1);
  const mismatch = checkEvalHarnessV3Regression(baseline, oracleResult, undefined, 2);
  assert.equal(mismatch.passed, false);
  assert.equal(mismatch.versionMismatch, true);
  assert.ok(mismatch.findings.some((f) => f.kind === 'version-mismatch'));
  const otherSuite = { ...oracleResult, suiteId: 'v3-other' };
  const wrongSuite = checkEvalHarnessV3Regression(baseline, otherSuite);
  assert.equal(wrongSuite.passed, false);
  assert.equal(wrongSuite.versionMismatch, true);
});

test('gate: baseline/report save+load round-trip, history append+read', async () => {
  const dir = tmpDir();
  try {
    const result = await runEvalHarnessV3Suite(
      BUILTIN_EVAL_HARNESS_V3_SUITE,
      scriptedEvalHarnessV3Executor(ORACLE_PLAN),
      { trials: 1, concurrency: 2, agentLabel: 'scripted-oracle' },
    );
    const baseline = buildEvalHarnessV3Baseline(result);
    const baselinePath = saveEvalHarnessV3Baseline(dir, baseline);
    assert.ok(fs.existsSync(baselinePath));
    assert.deepEqual(loadEvalHarnessV3Baseline(dir)?.runId, baseline.runId);
    assert.equal(loadEvalHarnessV3Baseline(tmpDir()), null);
    const reportPath = saveEvalHarnessV3Report(dir, result);
    assert.ok(fs.existsSync(reportPath));
    assert.equal(loadEvalHarnessV3Report(dir, result.runId)?.suiteId, 'v3-sample');
    assert.equal(loadEvalHarnessV3Report(dir, 'no-such-run'), null);
    const gate = checkEvalHarnessV3Regression(baseline, result);
    const historyPath = appendEvalHarnessV3GateHistory(dir, gate);
    assert.ok(fs.existsSync(historyPath));
    const history = readEvalHarnessV3GateHistory(dir);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.passed, true);
    assert.equal(history[0]?.suiteId, 'v3-sample');
    assert.deepEqual(readEvalHarnessV3GateHistory(tmpDir()), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

test('registry: all 8 eval harness v3 tools in ALL_TOOLS exactly once', () => {
  for (const name of EVAL_HARNESS_V3_TOOL_NAMES) {
    assert.ok(toolNames(ALL_TOOLS).includes(name), `ALL_TOOLS missing ${name}`);
    assert.equal(toolNames(ALL_TOOLS).filter((n) => n === name).length, 1, `${name} duplicated`);
  }
  assert.equal(EVAL_HARNESS_V3_TOOLS.length, 8);
  const names = new Set(toolNames(ALL_TOOLS));
  assert.equal(names.size, toolNames(ALL_TOOLS).length, 'ALL_TOOLS has duplicate tool names');
});

test('unbound placeholder tools return NOT_WIRED', async () => {
  const list = toolByName(EVAL_HARNESS_V3_TOOLS, 'eval_harness_v3_list_tasks');
  const out = await list.execute({}, CTX);
  assert.match(out, /not configured/);
  const run = toolByName(EVAL_HARNESS_V3_TOOLS, 'eval_harness_v3_run_task');
  assert.match(await run.execute({ taskId: 'v3-sample-add' }, CTX), /not configured/);
});

test('createDefaultTools binds the v3 tools without duplicates', async () => {
  const dir = tmpDir();
  try {
    const bound = createDefaultTools({ getEvalHarnessV3BaseDir: () => dir });
    for (const name of EVAL_HARNESS_V3_TOOL_NAMES) {
      assert.equal(toolNames(bound).filter((n) => n === name).length, 1, `${name} duplicated after binding`);
    }
    const names = new Set(toolNames(bound));
    assert.equal(names.size, toolNames(bound).length);
    const list = toolByName(bound, 'eval_harness_v3_list_tasks');
    const out = JSON.parse(await list.execute({}, CTX));
    assert.equal(out.count, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound list_tasks lists 4 sample tasks with container + guardrail info', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV3Tools(() => dir);
    const out = JSON.parse(await toolByName(tools, 'eval_harness_v3_list_tasks').execute({}, CTX));
    assert.equal(out.count, 4);
    const kinds = out.tasks.map((t) => t.kind).sort();
    assert.deepEqual(kinds, ['issue-patch', 'state-check', 'state-check', 'state-check']);
    assert.ok(out.tasks.every((t) => t.hasOracle === true));
    assert.ok(out.tasks.every((t) => t.container.image === 'node:22-slim'));
    const guardrail = out.tasks.find((t) => t.id === 'v3-sample-guardrail');
    assert.deepEqual(guardrail.guardrails.deniedTools, ['delete_file', 'run_shell']);
    const filtered = JSON.parse(
      await toolByName(tools, 'eval_harness_v3_list_tasks').execute({ kind: 'issue-patch' }, CTX),
    );
    assert.equal(filtered.count, 1);
    assert.equal(filtered.tasks[0].id, 'v3-sample-add');
    const withRegistry = JSON.parse(
      await toolByName(tools, 'eval_harness_v3_list_tasks').execute({ includeRegistry: true }, CTX),
    );
    assert.match(withRegistry.registry, /v3-sample/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound validate_task: valid sample task, oracle check, unknown task errors', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV3Tools(() => dir, { agentFiles: ORACLE_PLAN });
    const validate = toolByName(tools, 'eval_harness_v3_validate_task');
    const out = JSON.parse(await validate.execute({ taskId: 'v3-sample-add', checkOracle: true, oracleRepeats: 1 }, CTX));
    assert.equal(out.valid, true);
    assert.equal(out.oracleValid, true);
    assert.match(out.text, /VALID/);
    const bad = await validate.execute({ taskId: 'v3-nope' }, CTX);
    assert.match(bad, /No Eval Harness v3 task/);
    const noArgs = await validate.execute({}, CTX);
    assert.match(noArgs, /Provide taskId/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound run_task: oracle plan passes, noop fails, leaky plan trips guardrail', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV3Tools(() => dir, { agentFiles: ORACLE_PLAN });
    const run = toolByName(tools, 'eval_harness_v3_run_task');
    const pass = JSON.parse(
      await run.execute({ taskId: 'v3-sample-add', trials: 1 }, CTX),
    );
    assert.equal(pass.agentLabel, 'scripted');
    assert.equal(pass.passRate, 1);
    assert.equal(pass.trials[0]?.status, 'pass');
    assert.equal(typeof pass.traceRunId, 'string');

    const noopTools = createEvalHarnessV3Tools(() => dir);
    const fail = JSON.parse(
      await toolByName(noopTools, 'eval_harness_v3_run_task').execute({ taskId: 'v3-sample-add', trials: 1 }, CTX),
    );
    assert.equal(fail.agentLabel, 'noop');
    assert.equal(fail.passRate, 0);

    const leakyTools = createEvalHarnessV3Tools(() => dir, {
      agentFiles: {
        'v3-sample-guardrail': {
          files: { 'report.txt': 'key sk-abcdefghijklmnop1234\n' },
          commands: [],
          steps: 1,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
    });
    const tripped = JSON.parse(
      await toolByName(leakyTools, 'eval_harness_v3_run_task').execute({ taskId: 'v3-sample-guardrail', trials: 1 }, CTX),
    );
    assert.equal(tripped.trials[0]?.status, 'guardrail-trip');
    assert.match(tripped.guardrailTripsText, /output-secret-leak/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound run_suite + run_set + trace: suite passes, set resolves, traces readable', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV3Tools(() => dir, { agentFiles: ORACLE_PLAN });
    const suiteOut = JSON.parse(
      await toolByName(tools, 'eval_harness_v3_run_suite').execute({ trials: 1, concurrency: 2 }, CTX),
    );
    assert.equal(suiteOut.trialPassRate, 1);
    assert.equal(suiteOut.tasks.length, 4);
    assert.ok(fs.existsSync(suiteOut.reportPath));
    assert.ok(fs.existsSync(suiteOut.tracePath));

    const setOut = JSON.parse(
      await toolByName(tools, 'eval_harness_v3_run_set').execute({ setId: 'v3-smoke', trials: 1 }, CTX),
    );
    assert.equal(setOut.setId, 'v3-smoke');
    assert.equal(setOut.tasks.length, 2);
    assert.equal(setOut.trialPassRate, 1);
    assert.deepEqual(setOut.missingTaskIds, []);
    const unknownSet = await toolByName(tools, 'eval_harness_v3_run_set').execute({ setId: 'v3-nope' }, CTX);
    assert.match(unknownSet, /Không có eval set/);

    const traceOut = JSON.parse(
      await toolByName(tools, 'eval_harness_v3_trace').execute({ runId: suiteOut.runId }, CTX),
    );
    assert.equal(traceOut.count, 4);
    assert.equal(traceOut.trials.length, 4);
    assert.ok(traceOut.trials.every((t) => t.outcome === 'pass'));
    const firstTrial = traceOut.trials[0];
    const detail = JSON.parse(
      await toolByName(tools, 'eval_harness_v3_trace').execute({ runId: suiteOut.runId, trialId: firstTrial.trialId }, CTX),
    );
    assert.equal(detail.trace.trialId, firstTrial.trialId);
    assert.match(detail.text, /Trace /);
    const missingRun = await toolByName(tools, 'eval_harness_v3_trace').execute({ runId: 'no-such-run' }, CTX);
    assert.match(missingRun, /No traces for run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound baseline then gate: oracle baseline passes, noop run fails the gate', async () => {
  const dir = tmpDir();
  try {
    const oracleTools = createEvalHarnessV3Tools(() => dir, { agentFiles: ORACLE_PLAN });
    const baselineOut = JSON.parse(
      await toolByName(oracleTools, 'eval_harness_v3_baseline').execute({ trials: 1 }, CTX),
    );
    assert.equal(baselineOut.trialPassRate, 1);
    assert.ok(fs.existsSync(baselineOut.baselinePath));

    const gatePass = JSON.parse(
      await toolByName(oracleTools, 'eval_harness_v3_gate').execute({ trials: 1 }, CTX),
    );
    assert.equal(gatePass.passed, true);
    assert.equal(gatePass.noBaseline, false);
    assert.match(gatePass.text, /PASS/);

    const noopTools = createEvalHarnessV3Tools(() => dir);
    const gateFail = JSON.parse(
      await toolByName(noopTools, 'eval_harness_v3_gate').execute({ trials: 1 }, CTX),
    );
    assert.equal(gateFail.passed, false);
    assert.ok(gateFail.findings.some((f) => f.kind === 'suite-pass-rate'));
    assert.match(gateFail.text, /FAIL/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound gate with no baseline passes and saves one', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV3Tools(() => dir, { agentFiles: ORACLE_PLAN });
    const gate = JSON.parse(
      await toolByName(tools, 'eval_harness_v3_gate').execute({ trials: 1 }, CTX),
    );
    assert.equal(gate.passed, true);
    assert.equal(gate.noBaseline, true);
    assert.ok(fs.existsSync(path.join(dir, 'eval-harness-v3', 'baseline.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

test('i18n: evalHarness.v3.* keys present in all 6 locales', () => {
  const expected = [
    'evalHarness.v3.title',
    'evalHarness.v3.subtitle',
    'evalHarness.v3.listTasks',
    'evalHarness.v3.validateTask',
    'evalHarness.v3.runTask',
    'evalHarness.v3.runSuite',
    'evalHarness.v3.runSet',
    'evalHarness.v3.baseline',
    'evalHarness.v3.gate',
    'evalHarness.v3.gatePass',
    'evalHarness.v3.gateFail',
    'evalHarness.v3.noBaseline',
    'evalHarness.v3.passRate',
    'evalHarness.v3.meanScore',
    'evalHarness.v3.trials',
    'evalHarness.v3.duration',
    'evalHarness.v3.steps',
    'evalHarness.v3.estimatedCost',
    'evalHarness.v3.issuePatch',
    'evalHarness.v3.stateCheck',
    'evalHarness.v3.difficulty',
    'evalHarness.v3.oracleValid',
    'evalHarness.v3.oracleInvalid',
    'evalHarness.v3.noSandboxWarning',
    'evalHarness.v3.taskPassed',
    'evalHarness.v3.taskFailed',
    'evalHarness.v3.suite',
    'evalHarness.v3.task',
    'evalHarness.v3.guardrailTrip',
    'evalHarness.v3.guardrailTrips',
    'evalHarness.v3.trace',
    'evalHarness.v3.passAtK',
    'evalHarness.v3.flakeAdjustedScore',
    'evalHarness.v3.registry',
    'evalHarness.v3.container',
  ];
  const keySets = [];
  for (const locale of ['vi', 'en', 'es', 'fr', 'ja', 'zh']) {
    const data = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`),
        'utf8',
      ),
    );
    for (const key of expected) {
      assert.equal(typeof data[key], 'string', `${locale} missing ${key}`);
      assert.ok(data[key].length > 0, `${locale} empty ${key}`);
    }
    assert.notEqual(data['evalHarness.v3.title'], data['evalHarness.v3.subtitle']);
    keySets.push(new Set(Object.keys(data).filter((k) => k.startsWith('evalHarness.v3.'))));
  }
  // Same v3 key set in every locale.
  for (const set of keySets.slice(1)) {
    assert.deepEqual([...set].sort(), [...keySets[0]].sort());
  }
});
