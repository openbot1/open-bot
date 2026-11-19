/**
 * Router local v118 — tools (v1.41, Doi T3, node:test).
 *
 * Covers (thuan, khong model that, khong network — executor gia):
 * - 15 ten duy nhat, needsApproval=false; co mat trong ALL_TOOLS;
 *   createDefaultTools({getRouterLocalV118State}) bind khong trung lap.
 * - tool_choice resolve / request params / capability matrix qua tool.
 * - Toolset create/update/cache-key qua tool: doi tool khong doi
 *   prefixKey (chung minh bang tool that).
 * - Thread lock/check qua tool.
 * - Script validate/run/audit qua tool (executor gia dang ky qua
 *   registerRouterLocalV118Executor; bot policy chan script khi
 *   allowScript=false).
 * - Bot policy get/set qua tool (policy sai bi tu choi).
 * - Cost route/report qua tool (ledger ghi + bao cao tiet kiem).
 * - Retry plan qua tool (429 co lich; 401 khong retry).
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/router-v118-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTER_LOCAL_V118_TOOL_NAMES,
  createDefaultRouterLocalV118State,
  createRouterLocalV118Tools,
  isRouterLocalV118ToolName,
  registerRouterLocalV118Executor,
} from '../packages/tools/dist/routerLocalV118Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tools, name, args) {
  const tool = toolByName(tools, name);
  const out = await tool.execute(args);
  assert.equal(typeof out, 'string');
  return out;
}

function runJson(tools, name, args) {
  return run(tools, name, args).then((out) => {
    assert.ok(!out.startsWith('Error:'), `${name} failed: ${out}`);
    return JSON.parse(out);
  });
}

function stateWithExecutors() {
  const state = createDefaultRouterLocalV118State();
  registerRouterLocalV118Executor(state, 'math_add', async (_name, args) => (args.a ?? 0) + (args.b ?? 0));
  registerRouterLocalV118Executor(state, 'text_upper', async (_name, args) => String(args.text ?? '').toUpperCase());
  return state;
}

test('registry: 15 tool duy nhat, co trong ALL_TOOLS, bind khong trung', () => {
  assert.equal(ROUTER_LOCAL_V118_TOOL_NAMES.length, 15);
  assert.equal(new Set(ROUTER_LOCAL_V118_TOOL_NAMES).size, 15);
  assert.equal(isRouterLocalV118ToolName('router_local_v118_tool_choice_resolve'), true);
  assert.equal(isRouterLocalV118ToolName('router_local_v117_midchat_route'), false);

  const tools = createRouterLocalV118Tools();
  assert.equal(tools.length, 15);
  for (const tool of tools) {
    assert.equal(tool.needsApproval, false, tool.definition.name);
    assert.ok(tool.definition.parameters);
  }

  const allNames = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of ROUTER_LOCAL_V118_TOOL_NAMES) {
    assert.ok(allNames.includes(name), `ALL_TOOLS thieu ${name}`);
  }

  // Bind qua createDefaultTools: moi ten xuat hien dung 1 lan.
  const bound = createDefaultTools({ getRouterLocalV118State: () => stateWithExecutors() });
  const boundNames = bound.map((t) => t.definition.name);
  for (const name of ROUTER_LOCAL_V118_TOOL_NAMES) {
    assert.equal(boundNames.filter((n) => n === name).length, 1, name);
  }
});

test('tools: tool_choice + request params + matrix', async () => {
  const tools = createRouterLocalV118Tools(stateWithExecutors());

  const resolved = await runJson(tools, 'router_local_v118_tool_choice_resolve', {
    provider: 'anthropic', modelId: 'claude-sonnet-5-5', requested: 'any',
  });
  assert.equal(resolved.enforced, 'auto');
  assert.equal(resolved.changed, true);

  const params = await runJson(tools, 'router_local_v118_request_params', {
    provider: 'anthropic', modelId: 'claude-opus-5-1', apiVersion: '2026-10-21',
    toolChoice: 'tool', toolName: 'search', temperature: 0.7, topP: 0.9,
    betaHeaders: ['inline-tools-2026-09-15'],
  });
  assert.equal(params.toolChoice.enforced, 'auto');
  assert.deepEqual(params.droppedSamplingParams.map((d) => d.name).sort(), ['temperature', 'top_p']);
  assert.deepEqual(params.betaHeaders, ['inline-tools-2026-09-15']);

  const matrix = await runJson(tools, 'router_local_v118_capability_matrix', {});
  assert.ok(matrix.matrix.includes('anthropic'));
  const one = await runJson(tools, 'router_local_v118_capability_matrix', {
    provider: 'ollama', modelId: 'qwen3-4b',
  });
  assert.deepEqual(one.capability.allowedModes, ['auto']);
});

test('tools: toolset + cache key + thread lock', async () => {
  const tools = createRouterLocalV118Tools(stateWithExecutors());

  const created = await runJson(tools, 'router_local_v118_toolset_create', {
    sessionId: 's1',
    tools: [
      { name: 'search', description: 'Search' },
      { name: 'read', description: 'Read' },
    ],
  });
  assert.equal(created.version, 1);
  assert.deepEqual(created.toolNames, ['read', 'search']);

  const keyBefore = await runJson(tools, 'router_local_v118_toolset_cache_key', {
    sessionId: 's1', systemPrompt: 'Be helpful.', modelId: 'claude-sonnet-5-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  const updated = await runJson(tools, 'router_local_v118_toolset_update', {
    sessionId: 's1', add: [{ name: 'calc', description: 'Calc' }],
  });
  assert.equal(updated.changed, true);
  assert.equal(updated.version, 2);
  const keyAfter = await runJson(tools, 'router_local_v118_toolset_cache_key', {
    sessionId: 's1', systemPrompt: 'Be helpful.', modelId: 'claude-sonnet-5-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.equal(keyBefore.prefixKey, keyAfter.prefixKey);
  assert.notEqual(keyBefore.toolKey, keyAfter.toolKey);

  // No-op update giu version.
  const noop = await runJson(tools, 'router_local_v118_toolset_update', {
    sessionId: 's1', remove: ['ghost'],
  });
  assert.equal(noop.changed, false);
  assert.equal(noop.version, 2);

  const locked = await runJson(tools, 'router_local_v118_thread_lock', {
    sessionId: 's1', threadId: 't1', action: 'lock',
  });
  assert.equal(locked.fingerprint, keyAfter.toolSetHash);
  const checkOk = await runJson(tools, 'router_local_v118_thread_lock', {
    sessionId: 's1', threadId: 't1', action: 'check',
  });
  assert.equal(checkOk.ok, true);
  await runJson(tools, 'router_local_v118_toolset_update', {
    sessionId: 's1', remove: ['calc'],
  });
  const checkBad = await runJson(tools, 'router_local_v118_thread_lock', {
    sessionId: 's1', threadId: 't1', action: 'check',
  });
  assert.equal(checkBad.ok, false);
  assert.equal(checkBad.wouldMismatch, true);

  const badAction = await run(tools, 'router_local_v118_thread_lock', {
    sessionId: 's1', threadId: 't1', action: 'explode',
  });
  assert.ok(badAction.startsWith('Error:'));
});

test('tools: script validate/run/audit + bot policy chan script', async () => {
  const state = stateWithExecutors();
  const tools = createRouterLocalV118Tools(state);

  const valid = await runJson(tools, 'router_local_v118_script_validate', {
    source: 'return call("math_add", {a: 1, b: 2});',
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.calledTools, ['math_add']);

  const invalid = await runJson(tools, 'router_local_v118_script_validate', {
    source: 'let x = process.env;',
  });
  assert.equal(invalid.ok, false);

  const ran = await runJson(tools, 'router_local_v118_script_run', {
    source: 'let a = call("math_add", {a: 20, b: 22}); let b = call("text_upper", {text: "done"}); return {a: a, b: b};',
  });
  assert.equal(ran.ok, true);
  assert.deepEqual(ran.returnValue, { a: 42, b: 'DONE' });
  assert.equal(ran.callsUsed, 2);

  const audit = await runJson(tools, 'router_local_v118_script_audit', {});
  assert.equal(audit.runs, 1);
  assert.equal(audit.count, 2);
  assert.equal(audit.entries[0].toolName, 'math_add');

  // Script loi -> fallback trong ket qua (khong phai Error: tool).
  const failed = await runJson(tools, 'router_local_v118_script_run', {
    source: 'return call("nope", {});',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.fallback.fallbackToNormalToolCalls, true);

  // Bot policy cam script.
  await runJson(tools, 'router_local_v118_bot_policy_set', { botId: 'bot-x', allowScript: false });
  const blocked = await run(tools, 'router_local_v118_script_run', {
    source: 'return 1;', botId: 'bot-x',
  });
  assert.ok(blocked.startsWith('Error:'));
  assert.ok(blocked.includes('allowScript'));
});

test('tools: bot policy get/set', async () => {
  const tools = createRouterLocalV118Tools(stateWithExecutors());

  const set = await runJson(tools, 'router_local_v118_bot_policy_set', {
    botId: 'bot-1', allowTools: ['search'], denyTools: ['danger'], maxToolsPerTurn: 5, note: 'test',
  });
  assert.equal(set.effective.botId, 'bot-1');
  assert.deepEqual(set.effective.allowTools, ['search']);
  assert.deepEqual(set.effective.denyTools, ['danger']);

  const get = await runJson(tools, 'router_local_v118_bot_policy_get', { botId: 'bot-1' });
  assert.equal(get.hasOwnPolicy, true);
  assert.equal(get.effective.maxToolsPerTurn, 5);

  const bad = await run(tools, 'router_local_v118_bot_policy_set', {
    botId: 'bot-2', maxToolsPerTurn: -3,
  });
  assert.ok(bad.startsWith('Error:'));

  const fresh = await runJson(tools, 'router_local_v118_bot_policy_get', { botId: 'bot-fresh' });
  assert.equal(fresh.hasOwnPolicy, false);
  assert.equal(fresh.effective.allowScript, true);
});

test('tools: cost route/report + retry plan', async () => {
  const tools = createRouterLocalV118Tools(stateWithExecutors());

  const route = await runJson(tools, 'router_local_v118_cost_route', {
    botId: 'bot-c', difficulty: 0.1,
  });
  assert.equal(route.chosenModelId, 'qwen3-0.6b');
  assert.equal(route.estimatedCostUsd, 0);

  const report = await runJson(tools, 'router_local_v118_cost_report', { botId: 'bot-c' });
  assert.equal(report.turns, 1);
  assert.equal(report.spentUsd, 0);
  assert.ok(report.wouldSpendUsd >= 0);

  const plan429 = await runJson(tools, 'router_local_v118_retry_plan', {
    provider: 'openai', status: 429, message: 'slow down', seed: 1,
  });
  assert.equal(plan429.kind, 'rate-limited');
  assert.equal(plan429.retryable, true);
  assert.equal(plan429.steps.length, 3);

  const plan400 = await runJson(tools, 'router_local_v118_retry_plan', {
    provider: 'anthropic', status: 400, message: 'tool_choice any is not supported',
  });
  assert.equal(plan400.action, 'retry-downgrade-tool-choice');
  assert.equal(plan400.steps.length, 1);

  const plan401 = await runJson(tools, 'router_local_v118_retry_plan', {
    provider: 'openai', status: 401, message: 'bad key',
  });
  assert.equal(plan401.retryable, false);
  assert.equal(plan401.steps.length, 0);
});
