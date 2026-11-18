/**
 * Tests for the providers v2 tools (packages/tools/src/providersV108Tools.ts).
 *
 * Covers registry membership (each of the 17 names exactly once in
 * ALL_TOOLS), the unbound placeholder message, bound execution against
 * stubbed managers (health monitor, status poller, trigger-mapping
 * store, toolkit manager, status fetcher, stub provider factory), and
 * `createDefaultTools` binding without duplicates.
 *
 * Run after building tools (which builds core first):
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/providers-v108-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  PROVIDERS_V108_TOOL_NAMES,
  PROVIDERS_V108_TOOLS,
  createProvidersV108Tools,
} from '../packages/tools/dist/providersV108Tools.js';
import {
  ComposioToolkitConnectionManager,
  ComposioToolkitStatusPoller,
  ComposioTriggerMappingStore,
  ProviderHealthMonitor,
  BotMemory,
  defaultToolFactory,
} from '../packages/core/dist/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-providers-v108-tools-'));
}

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly one tool named ${name}, got ${found.length}`);
  return found[0];
}

function toolNames(tools) {
  return tools.map((t) => t.definition.name);
}

function makeBoundTools() {
  const monitor = new ProviderHealthMonitor({
    probe: async (id) => {
      if (id === 'down-provider') return { ok: false, latencyMs: 5, error: 'HTTP 503' };
      if (id === 'openrouter') return { ok: true, latencyMs: 42, quota: { remaining: 500, limit: 1000 } };
      return { ok: true, latencyMs: 10 };
    },
    // Labels come from the host (PROVIDERS meta); the monitor only falls
    // back to the id when the host passes none.
    labels: { openrouter: 'OpenRouter' },
  });
  const poller = new ComposioToolkitStatusPoller({
    fetchStatuses: async () => [
      { toolkit: 'gmail', status: 'active', accountLabel: 'a@example.com' },
      { toolkit: 'github', status: 'none' },
    ],
    toolkits: ['gmail', 'github'],
  });
  const store = new ComposioTriggerMappingStore();
  const manager = new ComposioToolkitConnectionManager();
  const fetcher = async () => [
    { toolkit: 'gmail', status: 'active', accountLabel: 'a@example.com' },
    { toolkit: 'github', status: 'none' },
  ];
  const tools = createProvidersV108Tools({
    getHealthMonitor: () => monitor,
    getToolkitStatusPoller: () => poller,
    getTriggerMappingStore: () => store,
    getToolkitConnectionManager: () => manager,
    getToolkitStatusFetcher: () => fetcher,
    getProviderApiKey: (id) => (id === 'openrouter' ? 'key-openrouter' : undefined),
    createProviderFn: (config) => ({
      id: config.id,
      label: config.label,
      listModels: async () => [`live-${config.id}-model-1`, `live-${config.id}-model-2`],
    }),
    listHealthProviderIds: () => ['openrouter', 'down-provider'],
  });
  return { tools, monitor, poller, store, manager };
}

test('providers v108 tools: all 17 are registered in ALL_TOOLS exactly once', () => {
  assert.equal(PROVIDERS_V108_TOOLS.length, 17);
  assert.deepEqual([...PROVIDERS_V108_TOOL_NAMES], [
    'composio_v2_toolkit_poll',
    'composio_v2_toolkit_status',
    'composio_v2_toolkit_enable',
    'composio_v2_toolkit_disable',
    'composio_v2_toolkit_health',
    'composio_v2_trigger_map',
    'composio_v2_trigger_unmap',
    'composio_v2_trigger_mappings',
    'provider_health_status',
    'provider_health_check',
    'provider_health_alerts',
    'provider_health_history',
    'provider_health_reset',
    'provider_openrouter_models',
    'provider_fireworks_models',
    'provider_openrouter_info',
    'provider_fireworks_info',
  ]);
  assert.deepEqual(toolNames(PROVIDERS_V108_TOOLS), [...PROVIDERS_V108_TOOL_NAMES]);
  for (const name of PROVIDERS_V108_TOOL_NAMES) {
    assert.equal(toolNames(ALL_TOOLS).filter((n) => n === name).length, 1, `${name} must appear exactly once in ALL_TOOLS`);
    const tool = toolByName(ALL_TOOLS, name);
    assert.equal(tool.definition.parameters.type, 'object');
  }
  assert.equal(new Set(toolNames(ALL_TOOLS)).size, ALL_TOOLS.length, 'no duplicate tool names in ALL_TOOLS');
  // The full agent registry (defaultToolFactory) counts every tool the
  // agent can call: 500 in v1.08 merge (428 v1.07 + 72: 14 memory_v9 + 10 coding_v2 + 12 harness_v4 + 17 providers_v2 + 9 voice_v7 + 10 fleet_v5).
  const ws = tmpDir();
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1');
    const names = toolNames(tools);
    assert.equal(names.length, 1274, `expected 1200 tools, got ${names.length}`); // v1.14 T2: 820 + 8 mcpAppsV2 = 828; v1.13 merge: 769 + 51 = 820; v1.11 merge: 640 + 70 = 710 // v1.36 re-pin: factory 1274 (ALL_TOOLS 899 + 375).
    assert.equal(new Set(names).size, names.length, 'duplicate tool names in the agent registry');
    for (const name of PROVIDERS_V108_TOOL_NAMES) assert.ok(names.includes(name), name);
  } finally {
    mem.close();
  }
});

test('providers v108 tools: write tools need approval, read tools do not', () => {
  const needsApproval = new Set([
    'composio_v2_toolkit_enable',
    'composio_v2_toolkit_disable',
    'composio_v2_trigger_map',
    'composio_v2_trigger_unmap',
    'provider_health_reset',
  ]);
  for (const tool of PROVIDERS_V108_TOOLS) {
    assert.equal(
      tool.needsApproval,
      needsApproval.has(tool.definition.name),
      `${tool.definition.name} needsApproval must be ${needsApproval.has(tool.definition.name)}`,
    );
  }
});

test('providers v108 tools: unbound placeholders explain themselves instead of guessing', async () => {
  for (const tool of PROVIDERS_V108_TOOLS) {
    const out = await tool.execute({});
    if (tool.definition.name.startsWith('provider_openrouter') || tool.definition.name.startsWith('provider_fireworks')) {
      // Models/info tools work unbound (public list + known fallback).
      assert.match(out, /OpenRouter|Fireworks AI/, `${tool.definition.name} must answer unbound`);
      assert.doesNotMatch(out, /key-openrouter|sk-/, 'must never print a key');
    } else {
      assert.match(out, /chưa được cấu hình/, `${tool.definition.name} must say it is not configured`);
    }
  }
});

test('providers v108 tools: unbound provider models answer without a key (live or fallback)', async () => {
  // The real createProvider + global fetch are used here: with no key
  // the endpoint either answers with its public catalog or fails and
  // listModels() falls back to the known models — either way the
  // placeholder answers with a header + key status, never a key.
  const out = await toolByName(PROVIDERS_V108_TOOLS, 'provider_fireworks_models').execute({});
  assert.match(out, /Fireworks AI models \(\d+/);
  assert.match(out, /API key: chưa cấu hình/);
  assert.doesNotMatch(out, /sk-/);
});

test('providers v108 tools: bound composio tools — poll, status, enable/disable, health', async () => {
  const { tools, poller, manager } = makeBoundTools();
  const pollOut = await toolByName(tools, 'composio_v2_toolkit_poll').execute({});
  assert.match(pollOut, /Đã poll 2 toolkit/);
  assert.match(pollOut, /Không có toolkit nào đổi trạng thái/);
  const statusOut = await toolByName(tools, 'composio_v2_toolkit_status').execute({});
  assert.match(statusOut, /gmail: active \(a@example\.com\)/);
  assert.match(statusOut, /github: none/);
  assert.match(statusOut, /Tổng quan kết nối/);
  assert.equal(poller.getStatus().totalPolls, 1);
  const disabled = await toolByName(tools, 'composio_v2_toolkit_disable').execute({ toolkit: 'slack' });
  assert.match(disabled, /Đã tắt toolkit slack/);
  assert.equal(manager.isEnabled('slack'), false);
  const enabled = await toolByName(tools, 'composio_v2_toolkit_enable').execute({ toolkit: 'slack' });
  assert.match(enabled, /Đã bật toolkit slack/);
  assert.equal(manager.isEnabled('slack'), true);
  const bad = await toolByName(tools, 'composio_v2_toolkit_enable').execute({ toolkit: 'not-a-toolkit' });
  assert.match(bad, /Error: Unknown Composio toolkit/);
  const healthOne = await toolByName(tools, 'composio_v2_toolkit_health').execute({ toolkit: 'gmail' });
  assert.match(healthOne, /gmail: bật — active/);
  const healthAll = await toolByName(tools, 'composio_v2_toolkit_health').execute({});
  assert.match(healthAll, /Health-check/);
  assert.match(healthAll, /active/);
});

test('providers v108 tools: bound trigger mapping tools — map, list, dry-run, unmap', async () => {
  const { tools, store } = makeBoundTools();
  const created = await toolByName(tools, 'composio_v2_trigger_map').execute({
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    actionKind: 'notify',
    target: 'New mail from {sender}',
    description: 'test mapping',
  });
  assert.match(created, /Đã tạo mapping map_/);
  assert.match(created, /GMAIL_NEW_GMAIL_MESSAGE → notify:New mail from \{sender\}/);
  assert.equal(store.count(), 1);
  const bad = await toolByName(tools, 'composio_v2_trigger_map').execute({
    triggerSlug: 'gmail_new',
    actionKind: 'notify',
    target: 'x',
  });
  assert.match(bad, /Error: Invalid trigger mapping/);
  const listed = await toolByName(tools, 'composio_v2_trigger_mappings').execute({
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    eventData: { sender: 'boss@example.com' },
  });
  assert.match(listed, /Trigger mappings \(1 cho GMAIL_NEW_GMAIL_MESSAGE\):/);
  assert.match(listed, /Dry-run resolve GMAIL_NEW_GMAIL_MESSAGE: 1 action/);
  assert.match(listed, /New mail from boss@example\.com/);
  const id = store.list()[0].id;
  const removed = await toolByName(tools, 'composio_v2_trigger_unmap').execute({ id });
  assert.match(removed, new RegExp(`Đã xoá mapping ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(store.count(), 0);
  const missing = await toolByName(tools, 'composio_v2_trigger_unmap').execute({ id });
  assert.match(missing, /Không có mapping/);
});

test('providers v108 tools: bound health tools — status, check, alerts, history, reset', async () => {
  const { tools, monitor } = makeBoundTools();
  const checked = await toolByName(tools, 'provider_health_check').execute({ providerId: 'openrouter' });
  assert.match(checked, /openrouter \(OpenRouter\): up — 42ms/);
  assert.match(checked, /quota còn 500\/1000/);
  const status = await toolByName(tools, 'provider_health_status').execute({});
  assert.match(status, /Provider health: 1 up, 0 degraded, 0 down, 1 chưa check/);
  assert.match(status, /openrouter \(OpenRouter\): up/);
  assert.match(status, /down-provider \(down-provider\): unknown/);
  // Drive down-provider down (2 consecutive failures) → alert appears.
  await toolByName(tools, 'provider_health_check').execute({ providerId: 'down-provider' });
  await toolByName(tools, 'provider_health_check').execute({ providerId: 'down-provider' });
  const alerts = await toolByName(tools, 'provider_health_alerts').execute({});
  assert.match(alerts, /\[down\] down-provider/);
  const history = await toolByName(tools, 'provider_health_history').execute({ providerId: 'openrouter' });
  assert.match(history, /Lịch sử openrouter/);
  assert.match(history, /ok 42ms/);
  const reset = await toolByName(tools, 'provider_health_reset').execute({ providerId: 'openrouter' });
  assert.match(reset, /Đã reset health của provider openrouter/);
  assert.equal(monitor.getSnapshot('openrouter').status, 'unknown');
  const emptyHistory = await toolByName(tools, 'provider_health_history').execute({ providerId: 'openrouter' });
  assert.match(emptyHistory, /chưa được probe lần nào/);
});

test('providers v108 tools: bound provider models/info tools use the stub factory + key flag', async () => {
  const { tools } = makeBoundTools();
  const models = await toolByName(tools, 'provider_openrouter_models').execute({});
  assert.match(models, /OpenRouter models \(2, live\):/);
  assert.match(models, /live-openrouter-model-1/);
  assert.match(models, /API key: đã cấu hình/);
  const fwModels = await toolByName(tools, 'provider_fireworks_models').execute({});
  assert.match(fwModels, /live-fireworks-model-1/);
  assert.match(fwModels, /API key: chưa cấu hình/);
  const info = await toolByName(tools, 'provider_openrouter_info').execute({});
  assert.match(info, /OpenRouter \(openrouter\)/);
  assert.match(info, /Base URL: https:\/\/openrouter\.ai\/api\/v1/);
  assert.match(info, /Model mặc định: openrouter\/auto/);
  assert.match(info, /API key: đã cấu hình/);
  assert.match(info, /openrouter\/auto/);
  const fwInfo = await toolByName(tools, 'provider_fireworks_info').execute({});
  assert.match(fwInfo, /Fireworks AI \(fireworks\)/);
  assert.match(fwInfo, /accounts\/fireworks\/models\/llama-v3p3-70b-instruct/);
});

test('providers v108 tools: missing required args throw (established arg pattern)', async () => {
  const { tools } = makeBoundTools();
  await assert.rejects(
    () => toolByName(tools, 'composio_v2_toolkit_enable').execute({}),
    /Thiếu tham số bắt buộc: "toolkit"/,
  );
  await assert.rejects(
    () => toolByName(tools, 'provider_health_check').execute({}),
    /Thiếu tham số bắt buộc: "providerId"/,
  );
});

test('providers v108 tools: createDefaultTools binding replaces placeholders without duplicates', () => {
  const { monitor, poller, store, manager } = makeBoundTools();
  const bound = createDefaultTools({
    getProvidersV108Opts: () => ({
      getHealthMonitor: () => monitor,
      getToolkitStatusPoller: () => poller,
      getTriggerMappingStore: () => store,
      getToolkitConnectionManager: () => manager,
    }),
  });
  assert.equal(bound.length, ALL_TOOLS.length);
  assert.equal(new Set(toolNames(bound)).size, bound.length);
  for (const name of PROVIDERS_V108_TOOL_NAMES) {
    assert.equal(toolNames(bound).filter((n) => n === name).length, 1, name);
  }
  // Without opts, createDefaultTools returns the placeholders untouched.
  const plain = createDefaultTools();
  assert.equal(plain.length, ALL_TOOLS.length);
  assert.deepEqual(toolNames(plain), toolNames(ALL_TOOLS));
});
