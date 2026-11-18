/**
 * Tests for the Harbor eval tools (packages/tools/src/evalV111Tools.ts)
 * — v1.11, Đội T2.
 *
 * Covers: registry wiring (all 9 names in ALL_TOOLS exactly once,
 * ALL_TOOLS 368, binding keeps 368 with no duplicates), the unbound
 * placeholder message, and bound execution against a temp userData
 * dir (list/validate/run task/run suite/export rollout/profiles/
 * report — all end to end, real sandbox runs, real JSONL on disk).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/eval-v111-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  EVAL_V111_TOOL_NAMES,
  EVAL_V111_TOOLS,
  createEvalV111Tools,
  isEvalV111ToolName,
} from '../packages/tools/dist/evalV111Tools.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-v111-tools-'));
}

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly one tool named ${name}, got ${found.length}`);
  return found[0];
}

async function runTool(tools, name, args, ctx) {
  const tool = toolByName(tools, name);
  const raw = await tool.execute(args, ctx);
  assert.equal(typeof raw, 'string');
  return raw;
}

test('registry wiring: all 9 eval v111 tools in ALL_TOOLS exactly once (491 total)', () => {
  assert.equal(EVAL_V111_TOOL_NAMES.length, 9);
  assert.equal(ALL_TOOLS.length, 899); // v1.14 merge: 453 + 38 = 500; v1.13: 402 + 51 = 453; v1.11 merge: 289 + 70 = 359 // v1.36 re-pin: 825 + 74 = 899.
  for (const name of EVAL_V111_TOOL_NAMES) {
    assert.equal(ALL_TOOLS.filter((t) => t.definition.name === name).length, 1, name);
    assert.ok(isEvalV111ToolName(name));
  }
  assert.equal(isEvalV111ToolName('eval_v3_run_suite'), false);
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
});

test('createDefaultTools binding keeps 491 tools with no duplicates', () => {
  const base = tmpDir();
  const bound = createDefaultTools({ getEvalV111BaseDir: () => base });
  assert.equal(bound.length, 899); // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, 899); // v1.36 re-pin: 825 + 74 = 899.
  const plain = createDefaultTools();
  assert.equal(plain.length, 899); // v1.36 re-pin: 825 + 74 = 899.
});

test('unbound placeholders explain themselves instead of guessing paths', async () => {
  const ctx = CTX(tmpDir());
  for (const name of EVAL_V111_TOOL_NAMES) {
    const out = await runTool(EVAL_V111_TOOLS, name, name === 'eval_v111_run_task' ? { taskId: 'hello-file' } : name === 'eval_v111_set_profile' ? { profileId: 'coding' } : name === 'eval_v111_profile_for_task' ? { kind: 'coding' } : {}, ctx);
    assert.ok(out.startsWith('Error:'), `${name} should error unbound, got: ${out.slice(0, 80)}`);
    assert.ok(out.includes('not configured'), `${name}: ${out.slice(0, 120)}`);
  }
});

test('bound tools: list tasks + validate task (read-only, no sandbox needed)', async () => {
  const base = tmpDir();
  const tools = createEvalV111Tools(() => base);
  const ctx = CTX(base);
  const listed = JSON.parse(await runTool(tools, 'eval_v111_list_tasks', {}, ctx));
  assert.equal(listed.tasks.length, 4);
  assert.deepEqual(listed.tasks.map((t) => t.id), ['fix-add', 'hello-file', 'markdown-table', 'sum-csv']);
  const sumCsv = listed.tasks.find((t) => t.id === 'sum-csv');
  assert.deepEqual(sumCsv.tests, ['correct-sum', 'plain-number', 'result-exists']);
  assert.equal(sumCsv.totalWeight, 4);
  const filtered = JSON.parse(await runTool(tools, 'eval_v111_list_tasks', { kind: 'coding' }, ctx));
  assert.deepEqual(filtered.tasks.map((t) => t.id), ['fix-add', 'sum-csv']);
  const validated = JSON.parse(await runTool(tools, 'eval_v111_validate_task', { taskId: 'sum-csv' }, ctx));
  assert.equal(validated.valid, true);
  assert.deepEqual(validated.issues, []);
  const unknown = await runTool(tools, 'eval_v111_validate_task', { taskId: 'nope' }, ctx);
  assert.ok(unknown.startsWith('Error:'));
});

test('bound tools: run task with scripted agentFiles (reward 1) and noop baseline (reward 0)', async () => {
  const base = tmpDir();
  const tools = createEvalV111Tools(() => base);
  const ctx = CTX(base);
  const pass = JSON.parse(
    await runTool(tools, 'eval_v111_run_task', { taskId: 'hello-file', agentFiles: { 'greeting.txt': 'Hello, open-bot!\n' } }, ctx),
  );
  assert.equal(pass.executor, 'scripted');
  assert.equal(pass.passed, true);
  assert.equal(pass.reward, 1);
  assert.ok(fs.existsSync(pass.reportPath));
  const fail = JSON.parse(await runTool(tools, 'eval_v111_run_task', { taskId: 'hello-file' }, ctx));
  assert.equal(fail.executor, 'noop');
  assert.equal(fail.passed, false);
  assert.equal(fail.reward, 0);
  // Both rollouts are in the JSONL file.
  const rolloutsPath = path.join(base, 'eval-harbor', 'rollouts.jsonl');
  assert.ok(fs.existsSync(rolloutsPath));
  assert.equal(fs.readFileSync(rolloutsPath, 'utf-8').trim().split('\n').length, 2);
  const unknown = await runTool(tools, 'eval_v111_run_task', { taskId: 'nope' }, ctx);
  assert.ok(unknown.startsWith('Error:'));
});

test('bound tools: run suite + export rollout (rollout + sft) + report', async () => {
  const base = tmpDir();
  const tools = createEvalV111Tools(() => base);
  const ctx = CTX(base);
  const suite = JSON.parse(
    await runTool(tools, 'eval_v111_run_suite', {
      agentFilesByTask: {
        'hello-file': { 'greeting.txt': 'Hello, open-bot!\n' },
        'sum-csv': { 'result.txt': '50\n' },
        'fix-add': { 'calc.py': 'def add(a, b):\n    return a + b\n' },
        'markdown-table': { 'report.md': '# R\n\n| A | B |\n|---|---|\n| Bánh mì | 15000 |\n| Cà phê | 20000 |\n| Trà sữa | 30000 |\n\n65000\n' },
      },
    }, ctx),
  );
  assert.equal(suite.passed, 4);
  assert.equal(suite.failed, 0);
  assert.equal(suite.passRate, 1);
  assert.equal(suite.meanReward, 1);
  assert.ok(suite.markdown.includes('# Harbor eval report'));
  assert.ok(fs.existsSync(suite.suitePath));
  const exported = JSON.parse(await runTool(tools, 'eval_v111_export_rollout', { format: 'rollout' }, ctx));
  assert.equal(exported.valid, true);
  assert.equal(exported.stats.rollouts, 4);
  assert.equal(exported.stats.passRate, 1);
  assert.equal(exported.stats.byTask['sum-csv'].rollouts, 1);
  const sft = JSON.parse(await runTool(tools, 'eval_v111_export_rollout', { format: 'sft' }, ctx));
  assert.ok(fs.existsSync(sft.sftPath));
  assert.ok(sft.sftLines >= 4);
  const badFormat = await runTool(tools, 'eval_v111_export_rollout', { format: 'nope' }, ctx);
  assert.ok(badFormat.startsWith('Error:'));
  const report = JSON.parse(await runTool(tools, 'eval_v111_report', {}, ctx));
  assert.equal(report.runs, 4);
  assert.equal(report.passRate, 1);
  assert.ok(report.markdown.includes('sum-csv'));
});

test('bound tools: profiles list/set/for-task end to end', async () => {
  const base = tmpDir();
  const tools = createEvalV111Tools(() => base);
  const ctx = CTX(base);
  const listed = JSON.parse(await runTool(tools, 'eval_v111_list_profiles', {}, ctx));
  assert.equal(listed.profiles.length, 6);
  assert.deepEqual(listed.profiles.map((p) => p.id), ['coding', 'research', 'writing', 'review', 'general', 'data']);
  const coding = listed.profiles.find((p) => p.id === 'coding');
  assert.equal(coding.enabled, true);
  assert.equal(coding.model, '');
  const picked = JSON.parse(await runTool(tools, 'eval_v111_profile_for_task', { kind: 'coding' }, ctx));
  assert.equal(picked.profileId, 'coding');
  assert.equal(picked.provider, 'ollama');
  assert.equal(picked.modelResolved, false);
  assert.ok(picked.systemPrompt.length > 20);
  const disabled = JSON.parse(await runTool(tools, 'eval_v111_set_profile', { profileId: 'writing', enabled: false }, ctx));
  assert.equal(disabled.enabled, false);
  const withModel = JSON.parse(
    await runTool(tools, 'eval_v111_set_profile', { profileId: 'coding', provider: 'ollama', model: 'qwen3:8b' }, ctx),
  );
  assert.equal(withModel.model, 'qwen3:8b');
  const pickedAfter = JSON.parse(await runTool(tools, 'eval_v111_profile_for_task', { kind: 'coding' }, ctx));
  assert.equal(pickedAfter.model, 'qwen3:8b');
  assert.equal(pickedAfter.modelResolved, true);
  const badKind = await runTool(tools, 'eval_v111_profile_for_task', { kind: 'nope' }, ctx);
  assert.ok(badKind.startsWith('Error:'));
  const badProfile = await runTool(tools, 'eval_v111_set_profile', { profileId: 'nope', enabled: true }, ctx);
  assert.ok(badProfile.startsWith('Error:'));
  const modelWithoutProvider = await runTool(tools, 'eval_v111_set_profile', { profileId: 'coding', model: 'x' }, ctx);
  assert.ok(modelWithoutProvider.startsWith('Error:'));
});
