/**
 * Router local v115 tools tests (v1.15, Doi T3 — node:test, no network,
 * no GPU, no real model).
 *
 * Covers:
 * - Registry: all 10 router-local tools in ALL_TOOLS, unique names,
 *   no duplicates; ROUTER_LOCAL_V115_TOOLS order matches the names list.
 * - Catalogue tools: list (12 models, family/useCase/RAM filters),
 *   validate (allowed + blocked unknown model).
 * - Route decide: simple-chat -> local, invalid kind -> Error string.
 * - Budget tools: set (global + per-bot, bad period/limit rejected),
 *   spend record (bad kind rejected), report (totals + status).
 * - Gateway key tool: creates a key, secret starts with obk_.
 * - Model tools without a real Ollama daemon: load -> Error string
 *   (never throws), status answers with backends/models/RAM,
 *   unload unknown -> ok:false.
 * - Tool arg validation: missing required args return Error strings,
 *   never throw.
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/router-local-v115-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ALL_TOOLS } from '../packages/tools/dist/tools.js';
import {
  ROUTER_LOCAL_V115_TOOL_NAMES,
  ROUTER_LOCAL_V115_TOOLS,
  createDefaultRouterLocalV115State,
  createRouterLocalV115Tools,
  isRouterLocalV115ToolName,
} from '../packages/tools/dist/routerLocalV115Tools.js';

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tools, name, args) {
  return toolByName(tools, name).execute(args, {});
}

function parse(result) {
  assert.ok(!result.startsWith('Error:'), `expected JSON, got ${result}`);
  return JSON.parse(result);
}

test('router local v115 tools: 10 tools in ALL_TOOLS, unique names', () => {
  assert.equal(ROUTER_LOCAL_V115_TOOLS.length, 10);
  assert.deepEqual(
    ROUTER_LOCAL_V115_TOOLS.map((t) => t.definition.name),
    [...ROUTER_LOCAL_V115_TOOL_NAMES],
  );
  for (const name of ROUTER_LOCAL_V115_TOOL_NAMES) {
    assert.equal(
      ALL_TOOLS.filter((t) => t.definition.name === name).length,
      1,
      `${name} must appear exactly once in ALL_TOOLS`,
    );
    assert.equal(isRouterLocalV115ToolName(name), true);
  }
  assert.equal(isRouterLocalV115ToolName('router_local_khong_co'), false);
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  for (const tool of ROUTER_LOCAL_V115_TOOLS) {
    assert.equal(tool.needsApproval, false);
    assert.ok(tool.definition.description.length > 0);
  }
});

test('catalog list: 12 models + filters', async () => {
  const tools = createRouterLocalV115Tools(createDefaultRouterLocalV115State());
  const all = parse(await run(tools, 'router_local_catalog_list', {}));
  assert.equal(all.total, 12);
  assert.equal(all.models.length, 12);
  assert.ok(all.models.every((m) => m.licenseAllowed === true));
  const qwen = parse(await run(tools, 'router_local_catalog_list', { family: 'qwen3' }));
  assert.equal(qwen.total, 6);
  assert.ok(qwen.models.every((m) => m.family === 'qwen3'));
  const code = parse(await run(tools, 'router_local_catalog_list', { useCase: 'code' }));
  assert.ok(code.total >= 4);
  assert.ok(code.models.every((m) => m.useCases.includes('code')));
  const small = parse(await run(tools, 'router_local_catalog_list', { fitsRamGB: 5 }));
  assert.ok(small.total > 0);
  assert.ok(small.models.every((m) => m.ramRequiredGB <= 5));
  assert.ok(!small.models.some((m) => m.id === 'qwen3-32b'));
  const qwen4b = all.models.find((m) => m.id === 'qwen3-4b');
  assert.equal(qwen4b.license, 'Apache License 2.0');
  assert.equal(qwen4b.ollamaTag, 'qwen3:4b');
  assert.equal(qwen4b.ramRequiredGB, 4.5);
});

test('catalog validate: allowed + unknown model error', async () => {
  const tools = createRouterLocalV115Tools(createDefaultRouterLocalV115State());
  const ok = parse(await run(tools, 'router_local_catalog_validate', { modelId: 'llama-3.2-3b' }));
  assert.equal(ok.allowed, true);
  assert.equal(ok.kind, 'community');
  assert.ok(ok.warnings.length > 0);
  const ghost = await run(tools, 'router_local_catalog_validate', { modelId: 'khong-co' });
  assert.ok(ghost.startsWith('Error:'));
  const missing = await run(tools, 'router_local_catalog_validate', {});
  assert.ok(missing.startsWith('Error:'));
  assert.match(missing, /modelId/);
});

test('route decide: simple-chat -> local, invalid kind -> Error', async () => {
  const tools = createRouterLocalV115Tools(createDefaultRouterLocalV115State());
  const d = parse(await run(tools, 'router_local_route_decide', {
    kind: 'simple-chat', promptTokens: 100, qualityNeed: 0.3,
  }));
  assert.equal(d.chosen.kind, 'local');
  assert.ok(d.explanation.includes(d.chosen.modelId));
  const heavy = parse(await run(tools, 'router_local_route_decide', {
    kind: 'code', promptTokens: 12000, needsToolUse: true, qualityNeed: 0.95,
  }));
  assert.equal(heavy.chosen.kind, 'cloud');
  const bad = await run(tools, 'router_local_route_decide', { kind: 'khong-co' });
  assert.ok(bad.startsWith('Error:'));
  const missing = await run(tools, 'router_local_route_decide', {});
  assert.ok(missing.startsWith('Error:'));
});

test('budget set/report/spend: end-to-end on fresh state', async () => {
  const tools = createRouterLocalV115Tools(createDefaultRouterLocalV115State());
  const set = parse(await run(tools, 'router_local_budget_set', {
    period: 'monthly', limitUsd: 10, botId: 'bot1',
  }));
  assert.equal(set.budget.limitUsd, 10);
  assert.equal(set.status.state, 'ok');
  const rec = parse(await run(tools, 'router_local_spend_record', {
    botId: 'bot1', modelId: 'grok-4.7', kind: 'cloud', promptTokens: 1000, completionTokens: 1000,
  }));
  assert.ok(Math.abs(rec.record.costUsd - 0.006) < 1e-12);
  const report = parse(await run(tools, 'router_local_budget_report', { period: 'monthly', botId: 'bot1' }));
  assert.equal(report.totalCalls, 1);
  assert.ok(Math.abs(report.totalUsd - 0.006) < 1e-12);
  assert.equal(report.byModel[0].modelId, 'grok-4.7');
  assert.equal(report.status.state, 'ok');
  // Bad inputs -> Error strings.
  const badPeriod = await run(tools, 'router_local_budget_set', { period: 'yearly', limitUsd: 1 });
  assert.ok(badPeriod.startsWith('Error:'));
  const badLimit = await run(tools, 'router_local_budget_set', { period: 'daily', limitUsd: -1 });
  assert.ok(badLimit.startsWith('Error:'));
  const badKind = await run(tools, 'router_local_spend_record', {
    botId: 'b', modelId: 'm', kind: 'khong-co', promptTokens: 1, completionTokens: 1,
  });
  assert.ok(badKind.startsWith('Error:'));
  const badReport = await run(tools, 'router_local_budget_report', { period: 'weekly' });
  assert.ok(badReport.startsWith('Error:'));
});

test('gateway key create: secret once, hint stored', async () => {
  const tools = createRouterLocalV115Tools(createDefaultRouterLocalV115State());
  const created = parse(await run(tools, 'router_local_gateway_key_create', { botId: 'bot9', limitUsd: 3 }));
  assert.ok(created.secret.startsWith('obk_'));
  assert.ok(created.keyHint.includes('...'));
  assert.equal(created.gatewayPort, 11880);
  assert.match(created.note, /Vault/);
  const missing = await run(tools, 'router_local_gateway_key_create', {});
  assert.ok(missing.startsWith('Error:'));
});

test('model tools without a real Ollama daemon: load errors, status answers', async () => {
  const tools = createRouterLocalV115Tools(createDefaultRouterLocalV115State());
  // Khong co Ollama that tren may test — load phai bao loi ro, khong throw.
  const load = await run(tools, 'router_local_model_load', { modelId: 'qwen3-4b' });
  assert.ok(load.startsWith('Error:') || JSON.parse(load).ok === false);
  const loadBadBackend = await run(tools, 'router_local_model_load', { modelId: 'qwen3-4b', backend: 'khong-co' });
  assert.ok(loadBadBackend.startsWith('Error:'));
  // Model chua tung load -> unload bao ok:false.
  const unload = parse(await run(tools, 'router_local_model_unload', { modelId: 'qwen3-8b' }));
  assert.equal(unload.ok, false);
  const status = parse(await run(tools, 'router_local_model_status', {}));
  assert.ok(Array.isArray(status.backends));
  assert.equal(status.backends[0].kind, 'ollama');
  assert.equal(status.backends[0].healthy, false);
  assert.equal(status.loadedCount, 0);
  assert.equal(status.maxLoadedModels, 2);
  assert.ok(status.ram.totalGB > 0);
  assert.equal(status.gatewayStarted, true);
});

test('tools share one state per factory call, separate states are isolated', async () => {
  const stateA = createDefaultRouterLocalV115State();
  const stateB = createDefaultRouterLocalV115State();
  const toolsA = createRouterLocalV115Tools(stateA);
  const toolsB = createRouterLocalV115Tools(stateB);
  await run(toolsA, 'router_local_spend_record', {
    botId: 'x', modelId: 'qwen3-4b', kind: 'local', promptTokens: 1000, completionTokens: 0,
  });
  const reportA = parse(await run(toolsA, 'router_local_budget_report', { period: 'monthly' }));
  const reportB = parse(await run(toolsB, 'router_local_budget_report', { period: 'monthly' }));
  assert.equal(reportA.totalCalls, 1);
  assert.equal(reportB.totalCalls, 0);
});
