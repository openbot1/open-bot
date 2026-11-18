/**
 * Tests for Eval Harness v2 tools + CLI wiring + i18n (v1.34, Đội T4):
 * `packages/tools/src/evalHarnessV2Tools.ts`, `apps/cli/src/cli.ts`
 * (`eval-harness` command), `apps/desktop/src/renderer/i18n/locales/`.
 *
 * Covers: registry membership (each of the 6 names exactly once in
 * ALL_TOOLS), the unbound placeholder message, bound execution against
 * a temp userData dir (list/validate/run task/run suite/baseline/gate
 * with a scripted oracle plan -> pass; noop -> fail; gate FAIL after
 * a regression), `createDefaultTools` binding without duplicates,
 * CLI source wiring (`eval-harness` + all 6 subcommands in help and
 * dispatch), and `evalHarness.v2.*` keys present in all 6 locales.
 *
 * Runs the sample suite with real `node` in temp sandboxes (fast, no
 * network, no Docker, no model). Run after building tools (which
 * builds core first):
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/eval-harness-v2-tools-cli.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  EVAL_HARNESS_V2_TOOL_NAMES,
  EVAL_HARNESS_V2_TOOLS,
  createEvalHarnessV2Tools,
} from '../packages/tools/dist/evalHarnessV2Tools.js';

const CTX = { workspaceDir: '/tmp', signal: undefined };
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-harness-v2-'));
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
const ORACLE_PLAN_JSON = JSON.stringify({
  'v2-sample-add': {
    files: { 'add.js': 'function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n' },
    commands: [],
    steps: 3,
    inputTokens: 1000,
    outputTokens: 200,
  },
  'v2-sample-greet': { files: { 'hello.txt': 'HELLO EVAL\n' }, commands: [], steps: 1, inputTokens: 500, outputTokens: 50 },
  'v2-sample-sum': { files: { 'sum.txt': '60\n' }, commands: [], steps: 2, inputTokens: 800, outputTokens: 100 },
});

const ORACLE_PLAN = JSON.parse(ORACLE_PLAN_JSON);

test('registry: all 6 eval harness v2 tools in ALL_TOOLS exactly once', () => {
  for (const name of EVAL_HARNESS_V2_TOOL_NAMES) {
    assert.ok(toolNames(ALL_TOOLS).includes(name), `ALL_TOOLS missing ${name}`);
    assert.equal(toolNames(ALL_TOOLS).filter((n) => n === name).length, 1, `${name} duplicated`);
  }
  assert.equal(EVAL_HARNESS_V2_TOOLS.length, 6);
  const names = new Set(toolNames(ALL_TOOLS));
  assert.equal(names.size, toolNames(ALL_TOOLS).length, 'ALL_TOOLS has duplicate tool names');
});

test('unbound placeholder tools return NOT_WIRED', async () => {
  const list = toolByName(EVAL_HARNESS_V2_TOOLS, 'eval_harness_v2_list_tasks');
  const out = await list.execute({}, CTX);
  assert.match(out, /not configured/);
  const run = toolByName(EVAL_HARNESS_V2_TOOLS, 'eval_harness_v2_run_task');
  assert.match(await run.execute({ taskId: 'v2-sample-add' }, CTX), /not configured/);
});

test('createDefaultTools binds the v2 tools without duplicates', async () => {
  const dir = tmpDir();
  try {
    const bound = createDefaultTools({ getEvalHarnessV2BaseDir: () => dir });
    for (const name of EVAL_HARNESS_V2_TOOL_NAMES) {
      assert.equal(toolNames(bound).filter((n) => n === name).length, 1, `${name} duplicated after binding`);
    }
    const names = new Set(toolNames(bound));
    assert.equal(names.size, toolNames(bound).length);
    const list = toolByName(bound, 'eval_harness_v2_list_tasks');
    const out = JSON.parse(await list.execute({}, CTX));
    assert.equal(out.count, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound list_tasks lists 3 sample tasks with kind + oracle flag', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV2Tools(() => dir);
    const out = JSON.parse(await toolByName(tools, 'eval_harness_v2_list_tasks').execute({}, CTX));
    assert.equal(out.count, 3);
    const kinds = out.tasks.map((t) => t.kind).sort();
    assert.deepEqual(kinds, ['issue-patch', 'state-check', 'state-check']);
    assert.ok(out.tasks.every((t) => t.hasOracle === true));
    const filtered = JSON.parse(
      await toolByName(tools, 'eval_harness_v2_list_tasks').execute({ kind: 'issue-patch' }, CTX),
    );
    assert.equal(filtered.count, 1);
    assert.equal(filtered.tasks[0].id, 'v2-sample-add');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound validate_task: valid sample task, unknown task errors', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV2Tools(() => dir);
    const validate = toolByName(tools, 'eval_harness_v2_validate_task');
    const ok = JSON.parse(await validate.execute({ taskId: 'v2-sample-add' }, CTX));
    assert.equal(ok.valid, true);
    assert.deepEqual(ok.issues, []);
    const oracle = JSON.parse(
      await validate.execute({ taskId: 'v2-sample-add', checkOracle: true }, CTX),
    );
    assert.equal(oracle.valid, true);
    assert.equal(oracle.oracleValid, true);
    const missing = await validate.execute({ taskId: 'v2-no-such-task' }, CTX);
    assert.match(missing, /No Eval Harness v2 task/);
    const neither = await validate.execute({}, CTX);
    assert.match(neither, /Provide taskId/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound run_task with oracle plan passes; noop fails', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV2Tools(() => dir);
    const run = toolByName(tools, 'eval_harness_v2_run_task');
    const passed = JSON.parse(
      await run.execute({ taskId: 'v2-sample-add', trials: 1, agentFilesJson: ORACLE_PLAN_JSON }, CTX),
    );
    assert.equal(passed.agentLabel, 'scripted');
    assert.equal(passed.passRate, 1);
    assert.equal(passed.trials[0].status, 'pass');
    const failed = JSON.parse(await run.execute({ taskId: 'v2-sample-add', trials: 1 }, CTX));
    assert.equal(failed.agentLabel, 'noop');
    assert.equal(failed.passRate, 0);
    const missing = await run.execute({ taskId: 'v2-no-such-task' }, CTX);
    assert.match(missing, /No Eval Harness v2 task/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound run_suite with oracle plan passes whole suite and saves a report', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV2Tools(() => dir);
    const runSuite = toolByName(tools, 'eval_harness_v2_run_suite');
    const result = JSON.parse(
      await runSuite.execute({ trials: 1, agentFilesJson: ORACLE_PLAN_JSON }, CTX),
    );
    assert.equal(result.suiteId, 'v2-sample');
    assert.equal(result.trialPassRate, 1);
    assert.equal(result.taskPassRate, 1);
    assert.ok(fs.existsSync(result.reportPath));
    assert.match(result.text, /Trial pass rate: 100\.0%/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound baseline + gate: first gate passes and saves baseline; regression fails gate', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV2Tools(() => dir);
    const baselineTool = toolByName(tools, 'eval_harness_v2_baseline');
    const gateTool = toolByName(tools, 'eval_harness_v2_gate');
    // Baseline with oracle plan (all pass).
    const baseline = JSON.parse(
      await baselineTool.execute({ trials: 1, agentFilesJson: ORACLE_PLAN_JSON }, CTX),
    );
    assert.equal(baseline.trialPassRate, 1);
    assert.ok(fs.existsSync(baseline.baselinePath));
    // Gate with the same oracle plan -> PASS.
    const gatePass = JSON.parse(
      await gateTool.execute({ trials: 1, agentFilesJson: ORACLE_PLAN_JSON }, CTX),
    );
    assert.equal(gatePass.passed, true);
    assert.equal(gatePass.noBaseline, false);
    // Gate with noop executor -> everything fails -> gate FAIL naming tasks.
    const gateFail = JSON.parse(await gateTool.execute({ trials: 1 }, CTX));
    assert.equal(gateFail.passed, false);
    assert.ok(gateFail.findings.some((f) => f.level === 'fail' && f.scope === 'suite'));
    assert.ok(gateFail.findings.some((f) => f.level === 'fail' && f.scope === 'v2-sample-add'));
    assert.match(gateFail.text, /FAIL/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound gate with no baseline passes and establishes one', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV2Tools(() => dir);
    const gate = JSON.parse(
      await toolByName(tools, 'eval_harness_v2_gate').execute({ trials: 1, agentFilesJson: ORACLE_PLAN_JSON }, CTX),
    );
    assert.equal(gate.passed, true);
    assert.equal(gate.noBaseline, true);
    assert.ok(fs.existsSync(path.join(dir, 'eval-harness-v2', 'baseline.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound tools accept a host executor override', async () => {
  const dir = tmpDir();
  try {
    const customExecutor = async () => ({
      files: { 'hello.txt': 'HELLO EVAL\n' },
      commands: [],
      steps: 9,
      inputTokens: 0,
      outputTokens: 0,
    });
    const tools = createEvalHarnessV2Tools(() => dir, { executor: customExecutor, agentLabel: 'custom-test' });
    const out = JSON.parse(
      await toolByName(tools, 'eval_harness_v2_run_task').execute({ taskId: 'v2-sample-greet', trials: 1 }, CTX),
    );
    assert.equal(out.agentLabel, 'custom-test');
    assert.equal(out.passRate, 1);
    assert.equal(out.trials[0].steps, 9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bound run_suite with agentFiles option (no per-call JSON) uses the option plan', async () => {
  const dir = tmpDir();
  try {
    const tools = createEvalHarnessV2Tools(() => dir, { agentFiles: ORACLE_PLAN });
    const out = JSON.parse(
      await toolByName(tools, 'eval_harness_v2_run_suite').execute({ trials: 1 }, CTX),
    );
    assert.equal(out.trialPassRate, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI wires eval-harness command: help + dispatch + handler', () => {
  const cliSource = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'cli', 'src', 'cli.ts'), 'utf8');
  assert.match(cliSource, /open-bot eval-harness list/);
  assert.match(cliSource, /open-bot eval-harness validate <taskId\|dir>/);
  assert.match(cliSource, /open-bot eval-harness run <taskId>/);
  assert.match(cliSource, /open-bot eval-harness suite/);
  assert.match(cliSource, /open-bot eval-harness baseline/);
  assert.match(cliSource, /open-bot eval-harness gate/);
  assert.match(cliSource, /if \(cmd === 'eval-harness'\)/);
  assert.match(cliSource, /async function cmdEvalHarnessV2/);
  assert.match(cliSource, /runEvalHarnessV2Suite/);
  assert.match(cliSource, /checkEvalHarnessV2Regression/);
});

test('i18n: evalHarness.v2.* keys present in all 6 locales', () => {
  const expected = [
    'evalHarness.v2.title',
    'evalHarness.v2.subtitle',
    'evalHarness.v2.listTasks',
    'evalHarness.v2.validateTask',
    'evalHarness.v2.runTask',
    'evalHarness.v2.runSuite',
    'evalHarness.v2.baseline',
    'evalHarness.v2.gate',
    'evalHarness.v2.gatePass',
    'evalHarness.v2.gateFail',
    'evalHarness.v2.noBaseline',
    'evalHarness.v2.passRate',
    'evalHarness.v2.meanScore',
    'evalHarness.v2.trials',
    'evalHarness.v2.duration',
    'evalHarness.v2.steps',
    'evalHarness.v2.estimatedCost',
    'evalHarness.v2.issuePatch',
    'evalHarness.v2.stateCheck',
    'evalHarness.v2.difficulty',
    'evalHarness.v2.oracleValid',
    'evalHarness.v2.oracleInvalid',
    'evalHarness.v2.noSandboxWarning',
    'evalHarness.v2.taskPassed',
    'evalHarness.v2.taskFailed',
    'evalHarness.v2.suite',
    'evalHarness.v2.task',
  ];
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
    assert.notEqual(data['evalHarness.v2.title'], data['evalHarness.v2.subtitle']);
  }
});
