/**
 * Router v3 tools + i18n tests (v1.18, Doi T3 — node:test, no
 * network, no GPU, no real model).
 *
 * Covers:
 * - Registry (packages/tools/src/routerV3Tools.ts): all 10 tools
 *   in ALL_TOOLS exactly once, unique names, no duplicates;
 *   tool definitions carry parameters + required lists.
 * - Each tool end-to-end on a mock state (fake fetch for local
 *   scan, mock executor for chat): providers list + filters,
 *   capability check + alternative, cost estimate, rank, chat
 *   (guidance when no key, success with a mock executor),
 *   local scan + status, cost set, circuit status, latency stats.
 * - Argument validation: missing/wrong args return `Error: ...`
 *   strings, never throw.
 * - i18n: the 26 routerV3.* keys exist in all 6 locales,
 *   non-empty, placeholders match en.
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/router-v3-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  ROUTER_V3_TOOL_NAMES,
  createDefaultRouterV3State,
  createRouterV3Tools,
  isRouterV3ToolName,
} from '../packages/tools/dist/routerV3Tools.js';
import { UnifiedRouterV3, listV3Providers } from '../packages/core/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const ROUTER_V3_KEYS = [
  'routerV3.title',
  'routerV3.providersTitle',
  'routerV3.providersCount',
  'routerV3.rankTitle',
  'routerV3.capabilityCheck',
  'routerV3.capabilityMissing',
  'routerV3.suggestedAlternative',
  'routerV3.costEstimate',
  'routerV3.costFree',
  'routerV3.estimatedPrice',
  'routerV3.policyCheapest',
  'routerV3.policyFastest',
  'routerV3.policyBalanced',
  'routerV3.localScan',
  'routerV3.localScanning',
  'routerV3.localModels',
  'routerV3.localNoModels',
  'routerV3.localNotRunning',
  'routerV3.latencyTitle',
  'routerV3.circuitOpen',
  'routerV3.circuitClosed',
  'routerV3.retrying',
  'routerV3.fallbackActive',
  'routerV3.noProvider',
  'routerV3.chatFailed',
  'routerV3.providerDisabled',
];

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

/** Provider ids of every catalog entry except the given keep-list. */
function allBut(...keep) {
  return listV3Providers()
    .map((p) => p.id)
    .filter((id) => !keep.includes(id));
}

/** Fake fetch answering only the local-server endpoints we need. */
function fakeLocalFetch() {
  return async (url) => {
    if (url === 'http://localhost:11434/api/tags') {
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3:8b', size: 5_000_000_000 }] }) };
    }
    if (url === 'http://localhost:11434/api/ps') {
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) };
    }
    if (url === 'http://localhost:1234/v1/models') {
      return { ok: true, json: async () => ({ data: [{ id: 'lmstudio-model' }] }) };
    }
    return { ok: false, json: async () => ({}) };
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('routerV3 tools: 10 tools registered in ALL_TOOLS exactly once', () => {
  assert.equal(ROUTER_V3_TOOL_NAMES.length, 10);
  assert.equal(new Set(ROUTER_V3_TOOL_NAMES).size, 10);
  for (const name of ROUTER_V3_TOOL_NAMES) {
    assert.equal(isRouterV3ToolName(name), true);
    const found = ALL_TOOLS.filter((t) => t.definition.name === name);
    assert.equal(found.length, 1, `${name} registered ${found.length}x`);
    assert.ok(found[0].definition.description.length > 0);
    assert.equal(found[0].definition.parameters.type, 'object');
  }
  assert.equal(isRouterV3ToolName('router_v3_pick'), false); // older v3 tool, not ours
  assert.equal(isRouterV3ToolName('nope'), false);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(names.length, new Set(names).size, 'ALL_TOOLS has no duplicate names');
  // The three older router_v3_* tools from earlier waves are untouched.
  for (const old of ['router_v3_pick', 'router_v3_record_failure', 'router_v3_catalog']) {
    assert.equal(ALL_TOOLS.filter((t) => t.definition.name === old).length, 1, old);
  }
});

test('routerV3 tools: createDefaultTools binds them via getRouterV3State, never duplicates', () => {
  const state = createDefaultRouterV3State({ fetchFn: fakeLocalFetch() });
  const bound = createDefaultTools({ getRouterV3State: () => state });
  assert.equal(bound.length, ALL_TOOLS.length);
  assert.equal(bound.filter((t) => ROUTER_V3_TOOL_NAMES.includes(t.definition.name)).length, 10);
  const names = bound.map((t) => t.definition.name);
  assert.equal(names.length, new Set(names).size);
  // Without the wiring the placeholders are still there (same 10 names).
  const plain = createDefaultTools();
  assert.equal(plain.filter((t) => ROUTER_V3_TOOL_NAMES.includes(t.definition.name)).length, 10);
  // A null state keeps the placeholders too.
  const nullState = createDefaultTools({ getRouterV3State: () => null });
  assert.equal(nullState.filter((t) => ROUTER_V3_TOOL_NAMES.includes(t.definition.name)).length, 10);
});

// ---------------------------------------------------------------------------
// Providers / capability / cost / rank
// ---------------------------------------------------------------------------

test('routerV3 tools: providers_list filters + search', async () => {
  const tools = createRouterV3Tools(createDefaultRouterV3State());
  const all = parse(await run(tools, 'router_v3_providers_list', {}));
  assert.ok(all.total >= 100);
  assert.equal(all.providers.length, 100); // default limit

  const local = parse(await run(tools, 'router_v3_providers_list', { localOnly: true }));
  assert.ok(local.total >= 10);
  assert.ok(local.providers.every((p) => p.local));

  const gateways = parse(await run(tools, 'router_v3_providers_list', { category: 'gateway' }));
  assert.ok(gateways.total >= 10);
  assert.ok(gateways.providers.every((p) => p.category === 'gateway'));

  const groq = parse(await run(tools, 'router_v3_providers_list', { query: 'groq' }));
  assert.ok(groq.total >= 1);
  assert.ok(groq.providers.every((p) => p.id.includes('groq') || p.label.toLowerCase().includes('groq')));

  const limited = parse(await run(tools, 'router_v3_providers_list', { limit: 3 }));
  assert.equal(limited.providers.length, 3);
  assert.ok(limited.total >= 100);
});

test('routerV3 tools: capability_check ok / missing / alternative', async () => {
  const tools = createRouterV3Tools(createDefaultRouterV3State());
  const ok = parse(
    await run(tools, 'router_v3_capability_check', { modelId: 'gpt-4o', needsVision: true, needsToolCalling: true }),
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.missing, []);

  const missing = parse(
    await run(tools, 'router_v3_capability_check', { modelId: 'deepseek-r1', needsToolCalling: true }),
  );
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['toolCalling']);
  assert.ok(missing.suggestedAlternative);
  assert.notEqual(missing.suggestedAlternative, 'deepseek-r1');
  assert.match(missing.reason ?? '', /tool-calling/);
});

test('routerV3 tools: cost_estimate math, local free', async () => {
  const tools = createRouterV3Tools(createDefaultRouterV3State());
  const estimate = parse(
    await run(tools, 'router_v3_cost_estimate', { modelId: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
  );
  assert.equal(estimate.estimatedCostUsd, 0.75);
  assert.equal(estimate.inputPer1mUsd, 0.15);
  assert.equal(estimate.outputPer1mUsd, 0.6);
  assert.equal(estimate.estimatedPrice, false);

  const local = parse(
    await run(tools, 'router_v3_cost_estimate', {
      modelId: 'qwen3:8b',
      providerId: 'local:ollama',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }),
  );
  assert.equal(local.estimatedCostUsd, 0);
});

test('routerV3 tools: rank honours policy + requirements', async () => {
  const tools = createRouterV3Tools(createDefaultRouterV3State());
  const cheapest = parse(await run(tools, 'router_v3_rank', { policy: 'cheapest', limit: 5 }));
  assert.equal(cheapest.policy, 'cheapest');
  assert.equal(cheapest.ranked.length, 5);
  // rank covers preset providers only (91 = 106 catalog minus 13 CLI
  // minus 2 dedicated); CLI/dedicated have no HTTP executor.
  assert.ok(cheapest.total >= 90);
  assert.ok(cheapest.ranked.every((c) => typeof c.score === 'number' && typeof c.explanation === 'string'));

  const vision = parse(await run(tools, 'router_v3_rank', { needsVision: true, limit: 1000 }));
  assert.ok(vision.ranked.filter((c) => !c.excludedReason).every((c) => c.contextWindow > 0));
  const excluded = vision.ranked.filter((c) => c.excludedReason);
  assert.ok(excluded.length > 0);
  assert.ok(excluded.every((c) => c.excludedReason.startsWith('thieu-capability')));
});

test('routerV3 tools: cost_set overrides and validates', async () => {
  const tools = createRouterV3Tools(createDefaultRouterV3State());
  const set = parse(
    await run(tools, 'router_v3_cost_set', { modelId: 'my-model', inputPer1mUsd: 2, outputPer1mUsd: 4 }),
  );
  assert.equal(set.ok, true);
  const after = parse(
    await run(tools, 'router_v3_cost_estimate', { modelId: 'my-model', inputTokens: 1_000_000, outputTokens: 0 }),
  );
  assert.equal(after.estimatedCostUsd, 2);

  const providerSet = parse(
    await run(tools, 'router_v3_cost_set', { providerId: 'my-provider', inputPer1mUsd: 1, outputPer1mUsd: 1 }),
  );
  assert.equal(providerSet.ok, true);

  const negative = await run(tools, 'router_v3_cost_set', { modelId: 'x', inputPer1mUsd: -1, outputPer1mUsd: 1 });
  assert.ok(negative.startsWith('Error:'));
  const neither = await run(tools, 'router_v3_cost_set', { inputPer1mUsd: 1, outputPer1mUsd: 1 });
  assert.ok(neither.startsWith('Error:'));
});

// ---------------------------------------------------------------------------
// Chat (mock executor, no real API)
// ---------------------------------------------------------------------------

test('routerV3 tools: chat without a key returns guidance, never throws', async () => {
  // Simulate "no usable key": the executor rejects with auth for the
  // only enabled provider. The default executor is never invoked
  // here, so this test makes no network call at all.
  const router = new UnifiedRouterV3({
    config: { disabledProviders: allBut('groq'), maxRetriesPerProvider: 0 },
    executor: async () => {
      throw new Error('groq: HTTP 401 — invalid api key');
    },
    sleep: async () => {},
  });
  const state = { router, monitor: null, fetchFn: fakeLocalFetch(), apiKeys: {} };
  const tools = createRouterV3Tools(state);
  const result = parse(
    await run(tools, 'router_v3_chat', { prompt: 'hello', preferredProviderId: 'groq' }),
  );
  assert.equal(result.ok, false);
  assert.ok(typeof result.guidance === 'string' && result.guidance.length > 0);
  assert.match(result.guidance, /sai key/);
  assert.ok(Array.isArray(result.attempts) && result.attempts.length > 0);
  // The default state carries no keys by construction.
  assert.deepEqual(createDefaultRouterV3State().apiKeys, {});
});

test('routerV3 tools: chat with a mock executor succeeds via the router', async () => {
  const router = new UnifiedRouterV3({
    config: { disabledProviders: [] },
    executor: async (providerId) => ({ text: `mock from ${providerId}`, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }),
    sleep: async () => {},
  });
  const state = {
    router,
    monitor: null,
    fetchFn: fakeLocalFetch(),
    apiKeys: {},
  };
  const tools = createRouterV3Tools(state);
  const result = parse(await run(tools, 'router_v3_chat', { prompt: 'hello' }));
  assert.equal(result.ok, true);
  assert.match(result.text, /mock from /);
  assert.equal(result.servedByProviderId, result.attempts[0].providerId);
  assert.equal(typeof result.costUsd, 'number');
  assert.equal(result.attempts.length, 1);
});

// ---------------------------------------------------------------------------
// Local scan / status / circuit / latency
// ---------------------------------------------------------------------------

test('routerV3 tools: local_scan registers models; local_status reports them', async () => {
  const state = createDefaultRouterV3State({ fetchFn: fakeLocalFetch() });
  const tools = createRouterV3Tools(state);

  const before = parse(await run(tools, 'router_v3_local_status', {}));
  assert.equal(before.reachableCount, 0);
  assert.deepEqual(before.localModels, []);

  const scan = parse(await run(tools, 'router_v3_local_scan', {}));
  const byKind = new Map(scan.servers.map((s) => [s.kind, s]));
  assert.equal(byKind.get('ollama').reachable, true);
  assert.equal(byKind.get('ollama').modelCount, 1);
  assert.deepEqual(byKind.get('ollama').models, ['qwen3:8b']);
  assert.equal(byKind.get('lmstudio').reachable, true);
  assert.equal(byKind.get('lmstudio').modelCount, 1);
  assert.equal(byKind.get('vllm').reachable, false);
  assert.equal(scan.registeredLocalModels, 2);
  assert.equal(scan.localModels.length, 2);

  const after = parse(await run(tools, 'router_v3_local_status', { probeNow: true }));
  assert.equal(after.reachableCount, 2);
  assert.equal(after.localModels.length, 2);
  assert.ok(after.localModels.every((m) => m.providerId.startsWith('local:')));
  assert.ok(after.servers.some((s) => s.kind === 'ollama' && s.reachable));

  // Re-scanning does not duplicate registered models.
  const rescan = parse(await run(tools, 'router_v3_local_scan', {}));
  assert.equal(rescan.registeredLocalModels, 2);

  // kinds filter: only ollama is probed.
  const onlyOllama = parse(await run(tools, 'router_v3_local_scan', { kinds: ['ollama'] }));
  assert.equal(onlyOllama.servers.length, 1);
  assert.equal(onlyOllama.servers[0].kind, 'ollama');
});

test('routerV3 tools: circuit_status + latency_stats reflect router state', async () => {
  const state = createDefaultRouterV3State({ fetchFn: fakeLocalFetch() });
  const tools = createRouterV3Tools(state);

  const empty = parse(await run(tools, 'router_v3_circuit_status', {}));
  assert.deepEqual(empty.providers, []);
  const resetMissing = parse(
    await run(tools, 'router_v3_circuit_status', { providerId: 'groq', reset: true }),
  );
  assert.equal(resetMissing.reset, false);

  const noLatency = parse(await run(tools, 'router_v3_latency_stats', {}));
  assert.equal(noLatency.total, 0);
  assert.deepEqual(noLatency.entries, []);

  // Record latency samples directly on the router (no network), then
  // read them back through the tool.
  state.router.latencyTracker.record('groq', 'test-model', 120, true, Date.now());
  state.router.latencyTracker.record('groq', 'test-model', 140, true, Date.now());
  state.router.latencyTracker.record('groq', 'test-model', 200, false, Date.now());
  const after = parse(await run(tools, 'router_v3_latency_stats', {}));
  assert.equal(after.total, 1);
  assert.equal(after.entries[0].providerId, 'groq');
  assert.equal(after.entries[0].modelId, 'test-model');
  assert.equal(after.entries[0].stats.count, 2);
  assert.equal(after.entries[0].stats.meanMs, 130);
  assert.ok(Math.abs(after.entries[0].stats.errorRate - 1 / 3) < 1e-9);

  const one = parse(
    await run(tools, 'router_v3_latency_stats', { providerId: 'groq', modelId: 'test-model' }),
  );
  assert.equal(one.sampleCount, 3);
  assert.equal(one.stats.p50Ms, 120);

  // Open a circuit directly on the router, then read + reset it via the tool.
  const breaker = state.router.breakerFor('groq');
  breaker.recordFailure('boom', Date.now());
  breaker.recordFailure('boom', Date.now());
  breaker.recordFailure('boom', Date.now());
  const open = parse(await run(tools, 'router_v3_circuit_status', { providerId: 'groq' }));
  assert.equal(open.providers.length, 1);
  assert.equal(open.providers[0].state, 'open');
  assert.equal(open.providers[0].consecutiveFailures, 3);
  const reset = parse(await run(tools, 'router_v3_circuit_status', { providerId: 'groq', reset: true }));
  assert.equal(reset.reset, true);
  const closed = parse(await run(tools, 'router_v3_circuit_status', { providerId: 'groq' }));
  assert.equal(closed.providers[0].state, 'closed');
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

test('routerV3 tools: bad arguments return Error strings, never throw', async () => {
  const tools = createRouterV3Tools(createDefaultRouterV3State());
  const cases = [
    ['router_v3_capability_check', {}],
    ['router_v3_capability_check', { modelId: 42 }],
    ['router_v3_cost_estimate', { modelId: 'x' }],
    ['router_v3_cost_estimate', { modelId: 'x', inputTokens: 'a', outputTokens: 1 }],
    ['router_v3_chat', {}],
    ['router_v3_chat', { prompt: 42 }],
    ['router_v3_rank', { policy: 'cheapest', limit: 'x' }],
  ];
  for (const [name, args] of cases) {
    const result = await run(tools, name, args);
    assert.ok(result.startsWith('Error:'), `${name} ${JSON.stringify(args)} -> ${result}`);
  }
  // Unknown tool names are a test bug, not a tool error: assert the lookup fails loudly.
  assert.throws(() => toolByName(tools, 'router_v3_nope'), /missing tool/);
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('routerV3 i18n: 26 keys present in all 6 locales, non-empty', () => {
  assert.equal(ROUTER_V3_KEYS.length, 26);
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    for (const key of ROUTER_V3_KEYS) {
      assert.ok(key in data, `${locale} missing ${key}`);
      assert.equal(typeof data[key], 'string', `${locale}.${key} not a string`);
      assert.ok(data[key].trim().length > 0, `${locale}.${key} empty`);
    }
  }
});

test('routerV3 i18n: placeholders match en in every locale', () => {
  const en = loadLocale('en');
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    for (const key of ROUTER_V3_KEYS) {
      assert.deepEqual(
        placeholders(data[key]),
        placeholders(en[key]),
        `${locale}.${key} placeholders differ from en`,
      );
    }
  }
  // Spot-check the interpolated keys actually carry placeholders.
  assert.deepEqual(placeholders(en['routerV3.providersCount']), ['count']);
  assert.deepEqual(placeholders(en['routerV3.capabilityMissing']), ['missing']);
  assert.deepEqual(placeholders(en['routerV3.retrying']), ['attempt', 'max']);
});
