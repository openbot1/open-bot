/**
 * Router v3 catalog + local-server tests (v1.18, Doi T3 — node:test,
 * no network, no GPU, no real model).
 *
 * Covers:
 * - Provider catalog (providersCatalog.ts): 100+ providers, unique
 *   ids, every entry well-formed, category classification, local
 *   providers need no key, search/limit.
 * - Presets (models/presets.ts): 90 OpenAI-compatible presets,
 *   unique ids, all well-formed (id/label/baseUrl/defaultModel).
 * - Local server parsers + probes (localServers.ts): OpenAI
 *   /v1/models, vLLM /health, llama.cpp /health, with a fake fetch
 *   (no real HTTP, loopback URLs only in code paths).
 * - Auto-register (probesToLocalModels) + health monitor
 *   (LocalHealthMonitor): periodic probing, consecutive failures,
 *   change listeners.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v3-catalog-local.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPATIBLE_PRESETS,
  CostTable,
  DEFAULT_LOCAL_SERVER_DEFS,
  LLAMACPP_DEFAULT_BASE_URL,
  LocalHealthMonitor,
  TEXTGEN_DEFAULT_BASE_URL,
  VLLM_DEFAULT_BASE_URL,
  categoryForPreset,
  isLocalPreset,
  listV3KeyedProviders,
  listV3LocalProviders,
  listV3Providers,
  listV3ProvidersByCategory,
  llamacppBaseUrlFromEnv,
  localKindLabel,
  localModelChatBaseUrl,
  localProviderId,
  parseLlamacppHealthResponse,
  parseOpenAiModelsResponse,
  parseVllmHealthResponse,
  presetToCatalogEntry,
  probeLlamacppEndpoint,
  probeLocalServer,
  probeTextgenEndpoint,
  probeVllmEndpoint,
  probesToLocalModels,
  resolveV3Provider,
  scanAllLocalServers,
  searchV3Providers,
  v3ProviderCount,
  vllmBaseUrlFromEnv,
} from '../packages/core/dist/index.js';

const CATEGORIES = ['gateway', 'inference-cloud', 'model-vendor', 'regional', 'local', 'dedicated', 'cli'];

// ---------------------------------------------------------------------------
// Provider catalog
// ---------------------------------------------------------------------------

test('catalog: 100+ providers, unique ids, every entry well-formed', () => {
  const providers = listV3Providers();
  assert.equal(v3ProviderCount(), providers.length);
  assert.ok(providers.length >= 100, `expected >= 100 providers, got ${providers.length}`);

  const ids = new Set();
  for (const p of providers) {
    assert.ok(p.id && typeof p.id === 'string', 'id');
    assert.ok(!ids.has(p.id), `duplicate provider id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.label && typeof p.label === 'string', `${p.id} label`);
    assert.equal(typeof p.baseUrl, 'string', `${p.id} baseUrl`);
    assert.ok(p.defaultModel && typeof p.defaultModel === 'string', `${p.id} defaultModel`);
    assert.ok(CATEGORIES.includes(p.category), `${p.id} category ${p.category}`);
    assert.equal(typeof p.local, 'boolean');
    assert.equal(typeof p.needsKey, 'boolean');
    assert.ok(['preset', 'dedicated', 'cli'].includes(p.source), `${p.id} source`);
    if (p.local) assert.equal(p.needsKey, false, `${p.id} local must not need a key`);
    if (p.source === 'cli') assert.equal(p.baseUrl, '', `${p.id} CLI has no HTTP baseUrl`);
    if (p.source === 'preset' && !p.local) assert.match(p.baseUrl, /^https:\/\//, `${p.id} remote preset uses https`);
  }
});

test('catalog: local providers are free in the cost table; keyed providers exist', () => {
  const table = new CostTable();
  for (const p of listV3LocalProviders()) {
    assert.equal(table.costPer1kTokensUsd(p.defaultModel, p.id), 0, `${p.id} local cost`);
  }
  assert.ok(listV3LocalProviders().length >= 10);
  assert.ok(listV3KeyedProviders().length >= 50);
  assert.ok(listV3ProvidersByCategory('cli').length >= 10);
  assert.ok(listV3ProvidersByCategory('gateway').length >= 10);
  assert.ok(listV3ProvidersByCategory('inference-cloud').length >= 10);
  assert.ok(listV3ProvidersByCategory('regional').length >= 10);
  for (const category of CATEGORIES) {
    assert.equal(
      listV3ProvidersByCategory(category).length,
      listV3Providers().filter((p) => p.category === category).length,
    );
  }
});

test('catalog: resolve + search', () => {
  const openrouter = resolveV3Provider('openrouter');
  assert.ok(openrouter);
  assert.equal(openrouter.category, 'gateway');
  assert.equal(openrouter.defaultModel.length > 0, true);
  assert.equal(resolveV3Provider('no-such-provider'), undefined);

  const groq = searchV3Providers('GROQ');
  assert.ok(groq.length >= 1);
  assert.ok(groq.every((p) => p.id.includes('groq') || p.label.toLowerCase().includes('groq')));
  assert.ok(searchV3Providers('groq', 1).length <= 1);
  assert.equal(searchV3Providers('', 3).length, 3);
  assert.deepEqual(searchV3Providers('zzz-no-match'), []);
});

test('catalog: preset classification + conversion', () => {
  const byId = new Map(COMPATIBLE_PRESETS.map((p) => [p.id, p]));
  assert.equal(categoryForPreset(byId.get('ollama-local')), 'local');
  assert.equal(categoryForPreset(byId.get('openrouter')), 'gateway');
  assert.equal(categoryForPreset(byId.get('groq')), 'inference-cloud');
  assert.equal(categoryForPreset(byId.get('moonshot')), 'regional');
  assert.equal(isLocalPreset(byId.get('ollama-local')), true);
  assert.equal(isLocalPreset(byId.get('openrouter')), false);

  const entry = presetToCatalogEntry(byId.get('groq'));
  assert.equal(entry.id, 'groq');
  assert.equal(entry.source, 'preset');
  assert.equal(entry.local, false);
  assert.equal(entry.needsKey, true);
  // A preset with a loopback baseUrl counts as local even without a list entry.
  assert.equal(isLocalPreset({ id: 'x', label: 'x', baseUrl: 'http://127.0.0.1:9999/v1', defaultModel: 'm' }), true);
  assert.equal(isLocalPreset({ id: 'x', label: 'x', baseUrl: 'not-a-url', defaultModel: 'm' }), false);
});

test('catalog: 90 presets, unique ids, all well-formed', () => {
  assert.equal(COMPATIBLE_PRESETS.length, 90);
  const ids = new Set();
  for (const p of COMPATIBLE_PRESETS) {
    assert.ok(!ids.has(p.id), `duplicate preset ${p.id}`);
    ids.add(p.id);
    assert.ok(p.label.length > 0);
    assert.match(p.baseUrl, /^https?:\/\//, `${p.id} baseUrl`);
    assert.ok(p.defaultModel.length > 0, `${p.id} defaultModel`);
  }
});

test('localServers: ids, labels, env baseUrls', () => {
  assert.equal(localProviderId('ollama'), 'local:ollama');
  assert.equal(localProviderId('vllm'), 'local:vllm');
  assert.equal(localKindLabel('ollama'), 'Ollama');
  assert.equal(localKindLabel('vllm'), 'vLLM');
  assert.equal(localKindLabel('lmstudio'), 'LM Studio');
  assert.equal(localKindLabel('llamacpp'), 'llama.cpp');
  assert.equal(localKindLabel('textgen'), 'text-generation-webui');
  assert.equal(VLLM_DEFAULT_BASE_URL, 'http://localhost:8000');
  assert.equal(LLAMACPP_DEFAULT_BASE_URL, 'http://localhost:8080');
  assert.equal(TEXTGEN_DEFAULT_BASE_URL, 'http://localhost:5000');
  assert.equal(vllmBaseUrlFromEnv({}), VLLM_DEFAULT_BASE_URL);
  assert.equal(vllmBaseUrlFromEnv({ VLLM_BASE_URL: 'http://127.0.0.1:9000' }), 'http://127.0.0.1:9000');
  assert.equal(vllmBaseUrlFromEnv({ VLLM_BASE_URL: '   ' }), VLLM_DEFAULT_BASE_URL);
  assert.equal(llamacppBaseUrlFromEnv({ LLAMACPP_BASE_URL: 'http://127.0.0.1:8081/' }), 'http://127.0.0.1:8081/');
  assert.equal(DEFAULT_LOCAL_SERVER_DEFS.length, 5);
  assert.deepEqual(
    DEFAULT_LOCAL_SERVER_DEFS.map((s) => s.kind),
    ['ollama', 'vllm', 'lmstudio', 'llamacpp', 'textgen'],
  );
  assert.ok(DEFAULT_LOCAL_SERVER_DEFS.every((s) => s.enabled));
});

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

test('localServers: parseOpenAiModelsResponse is defensive', () => {
  assert.deepEqual(parseOpenAiModelsResponse(null), []);
  assert.deepEqual(parseOpenAiModelsResponse({}), []);
  assert.deepEqual(parseOpenAiModelsResponse({ data: 'nope' }), []);
  const models = parseOpenAiModelsResponse({
    data: [
      { id: 'meta-llama/Llama-3.1-8B-Instruct', owned_by: 'vllm' },
      { id: '  ', owned_by: 'vllm' },
      { owned_by: 'vllm' },
      null,
      'junk',
      { id: 'qwen3:8b' },
    ],
  });
  assert.deepEqual(
    models.map((m) => m.id),
    ['meta-llama/Llama-3.1-8B-Instruct', 'qwen3:8b'],
  );
  assert.equal(models[0].displayName, 'Llama-3.1-8B-Instruct');
  assert.equal(models[1].displayName, 'qwen3:8b');
});

test('localServers: vLLM + llama.cpp health parsers', () => {
  assert.equal(parseVllmHealthResponse({ status: 'ok' }), true);
  assert.equal(parseVllmHealthResponse({ status: 'healthy' }), true);
  assert.equal(parseVllmHealthResponse(''), true); // empty 200 body
  assert.equal(parseVllmHealthResponse('  '), true);
  assert.equal(parseVllmHealthResponse({ status: 'loading' }), false);
  assert.equal(parseVllmHealthResponse(null), false);
  assert.equal(parseVllmHealthResponse(42), false);

  assert.equal(parseLlamacppHealthResponse({ status: 'ok' }), 'ok');
  assert.equal(parseLlamacppHealthResponse({ status: 'loading model' }), 'loading');
  assert.equal(parseLlamacppHealthResponse({ status: 'Loading...' }), 'loading');
  assert.equal(parseLlamacppHealthResponse({ status: 'error' }), 'error');
  assert.equal(parseLlamacppHealthResponse(null), 'error');
});

// ---------------------------------------------------------------------------
// Probes with a fake fetch (no real HTTP)
// ---------------------------------------------------------------------------

/** Minimal fetch stub: map URL -> JSON body (or Error to throw). */
function fakeFetch(routes) {
  return async (url) => {
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (route === undefined) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => route };
  };
}

const VLLM = 'http://localhost:8000';
const LLAMA = 'http://localhost:8080';
const TEXTGEN = 'http://localhost:5000';
const OLLAMA = 'http://localhost:11434';
const LMSTUDIO = 'http://localhost:1234';

test('localServers: probe vLLM ok + models; unreachable when /v1/models fails', async () => {
  const ok = await probeVllmEndpoint(
    fakeFetch({
      [`${VLLM}/health`]: { status: 'ok' },
      [`${VLLM}/v1/models`]: { data: [{ id: 'llama-3.1-8b' }, { id: 'qwen3:8b' }] },
    }),
  );
  assert.equal(ok.kind, 'vllm');
  assert.equal(ok.reachable, true);
  assert.equal(ok.healthy, true);
  assert.deepEqual(
    ok.models.map((m) => m.id),
    ['llama-3.1-8b', 'qwen3:8b'],
  );

  const down = await probeVllmEndpoint(fakeFetch({ [`${VLLM}/health`]: new Error('ECONNREFUSED') }));
  assert.equal(down.reachable, false);
  assert.equal(down.healthy, false);
  assert.deepEqual(down.models, []);
  assert.match(down.error ?? '', /vLLM/);

  // /health failing does not block the models list; healthy is just false.
  const noHealth = await probeVllmEndpoint(
    fakeFetch({ [`${VLLM}/v1/models`]: { data: [{ id: 'm1' }] } }),
  );
  assert.equal(noHealth.reachable, true);
  assert.equal(noHealth.healthy, false);
});

test('localServers: probe llama.cpp loading + textgen', async () => {
  const loading = await probeLlamacppEndpoint(
    fakeFetch({
      [`${LLAMA}/health`]: { status: 'loading model' },
      [`${LLAMA}/v1/models`]: { data: [{ id: 'ggml-model' }] },
    }),
  );
  assert.equal(loading.reachable, true);
  assert.equal(loading.healthy, false);
  assert.match(loading.error ?? '', /loading/);

  const ok = await probeLlamacppEndpoint(
    fakeFetch({
      [`${LLAMA}/health`]: { status: 'ok' },
      [`${LLAMA}/v1/models`]: { data: [{ id: 'ggml-model' }] },
    }),
  );
  assert.equal(ok.healthy, true);
  assert.equal(ok.error, undefined);

  const textgen = await probeTextgenEndpoint(
    fakeFetch({ [`${TEXTGEN}/v1/models`]: { data: [{ id: 'qwen2.5-7b-instruct' }] } }),
  );
  assert.equal(textgen.reachable, true);
  assert.equal(textgen.healthy, true);
  assert.equal(textgen.models[0].id, 'qwen2.5-7b-instruct');
});

test('localServers: probeLocalServer dispatches all 5 kinds', async () => {
  const fetchFn = fakeFetch({
    [`${OLLAMA}/api/tags`]: { models: [{ name: 'qwen3:8b', size: 5_000_000_000 }] },
    [`${OLLAMA}/api/ps`]: { models: [{ name: 'qwen3:8b' }] },
    [`${VLLM}/health`]: { status: 'ok' },
    [`${VLLM}/v1/models`]: { data: [{ id: 'vllm-model' }] },
    [`${LMSTUDIO}/v1/models`]: { data: [{ id: 'lmstudio-model' }] },
    [`${LLAMA}/health`]: { status: 'ok' },
    [`${LLAMA}/v1/models`]: { data: [{ id: 'llama-model' }] },
    [`${TEXTGEN}/v1/models`]: { data: [{ id: 'textgen-model' }] },
  });
  for (const kind of ['ollama', 'vllm', 'lmstudio', 'llamacpp', 'textgen']) {
    const probe = await probeLocalServer(kind, fetchFn);
    assert.equal(probe.kind, kind);
    assert.equal(probe.reachable, true, kind);
    assert.equal(probe.models.length, 1, kind);
  }
  const ollama = await probeLocalServer('ollama', fetchFn);
  assert.equal(ollama.models[0].running, true);
  assert.equal(ollama.models[0].sizeBytes, 5_000_000_000);
});

test('localServers: scanAllLocalServers tolerates per-server failure + disabled servers', async () => {
  const fetchFn = fakeFetch({
    [`${OLLAMA}/api/tags`]: { models: [{ name: 'qwen3:8b' }] },
    [`${OLLAMA}/api/ps`]: { models: [] },
    [`${LMSTUDIO}/v1/models`]: { data: [{ id: 'lm-model' }] },
  });
  const probes = await scanAllLocalServers({ fetchFn });
  assert.equal(probes.length, 5);
  const byKind = new Map(probes.map((p) => [p.kind, p]));
  assert.equal(byKind.get('ollama').reachable, true);
  assert.equal(byKind.get('lmstudio').reachable, true);
  assert.equal(byKind.get('vllm').reachable, false);
  assert.equal(byKind.get('llamacpp').reachable, false);
  assert.equal(byKind.get('textgen').reachable, false);

  // Disabled servers are not probed at all.
  const onlyOllama = await scanAllLocalServers({
    fetchFn,
    servers: [{ kind: 'ollama', baseUrl: OLLAMA, enabled: true }, { kind: 'vllm', baseUrl: VLLM, enabled: false }],
  });
  assert.deepEqual(
    onlyOllama.map((p) => p.kind),
    ['ollama'],
  );

  // A fetch that throws for every URL still yields a probe per server.
  const throwing = async () => {
    throw new Error('boom');
  };
  const allDown = await scanAllLocalServers({ fetchFn: throwing });
  assert.equal(allDown.length, 5);
  assert.ok(allDown.every((p) => !p.reachable));
});

test('localServers: probesToLocalModels dedupes, sorts, skips unreachable', () => {
  const models = probesToLocalModels([
    { kind: 'ollama', baseUrl: OLLAMA, reachable: true, healthy: true, models: [{ id: 'qwen3:8b' }, { id: 'qwen3:8b' }], probeLatencyMs: 1, probedAt: 100 },
    { kind: 'ollama', baseUrl: OLLAMA, reachable: true, healthy: true, models: [{ id: 'llama3.1:8b' }], probeLatencyMs: 1, probedAt: 100 },
    { kind: 'vllm', baseUrl: VLLM, reachable: false, healthy: false, models: [{ id: 'ghost' }], probeLatencyMs: 1, probedAt: 100 },
  ]);
  assert.deepEqual(
    models.map((m) => `${m.providerId}/${m.modelId}`),
    ['local:ollama/llama3.1:8b', 'local:ollama/qwen3:8b'],
  );
  assert.equal(models[0].capability.contextWindow > 0, true);
  assert.equal(localModelChatBaseUrl(models[0]), 'http://localhost:11434/v1');
  assert.equal(localModelChatBaseUrl({ ...models[0], baseUrl: 'http://localhost:11434/' }), 'http://localhost:11434/v1');
  assert.deepEqual(probesToLocalModels([]), []);
});

// ---------------------------------------------------------------------------
// Health monitor
// ---------------------------------------------------------------------------

test('localServers: LocalHealthMonitor tracks reachability + consecutive failures + listeners', async () => {
  let ollamaUp = true;
  const dynamicFetch = async (url) => {
    if (url.startsWith(`${OLLAMA}/api/tags`)) {
      if (!ollamaUp) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) };
    }
    if (url.startsWith(`${OLLAMA}/api/ps`)) return { ok: true, json: async () => ({ models: [] }) };
    return { ok: false, json: async () => ({}) };
  };
  const monitor = new LocalHealthMonitor({
    fetchFn: dynamicFetch,
    servers: [{ kind: 'ollama', baseUrl: OLLAMA, enabled: true }],
  });
  assert.equal(monitor.isRunning(), false);
  assert.equal(monitor.getHealth('ollama'), undefined);
  assert.deepEqual(monitor.snapshot(), []);

  const seen = [];
  const unsubscribe = monitor.onChange((h) => seen.push(h));
  const first = await monitor.checkNow();
  assert.equal(first.length, 1);
  assert.equal(first[0].reachable, true);
  assert.equal(first[0].modelCount, 1);
  assert.equal(first[0].consecutiveFailures, 0);
  assert.equal(monitor.reachableCount(), 1);
  assert.equal(seen.length, 1); // first probe counts as a change
  assert.deepEqual(monitor.getHealth('ollama').modelCount, 1);

  // Second identical probe: no listener call.
  await monitor.checkNow();
  assert.equal(seen.length, 1);

  // Server goes down: failures accumulate, listener fires once per change.
  ollamaUp = false;
  await monitor.checkNow();
  assert.equal(monitor.getHealth('ollama').reachable, false);
  assert.equal(monitor.getHealth('ollama').consecutiveFailures, 1);
  assert.equal(monitor.reachableCount(), 0);
  await monitor.checkNow();
  assert.equal(monitor.getHealth('ollama').consecutiveFailures, 2);
  assert.equal(seen.length, 2); // down-transition fired once; failure-count growth is not a change

  unsubscribe();
  ollamaUp = true;
  await monitor.checkNow();
  assert.equal(seen.length, 2); // unsubscribed: no more calls
  assert.equal(monitor.getHealth('ollama').reachable, true);
  assert.equal(monitor.getHealth('ollama').consecutiveFailures, 0);
});

test('localServers: LocalHealthMonitor start/stop runs the interval', async () => {
  const monitor = new LocalHealthMonitor({
    fetchFn: fakeFetch({}),
    servers: [{ kind: 'ollama', baseUrl: OLLAMA, enabled: true }],
    intervalMs: 20,
  });
  monitor.start();
  assert.equal(monitor.isRunning(), true);
  monitor.start(); // second start is a no-op
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(monitor.snapshot().length >= 1);
  monitor.stop();
  assert.equal(monitor.isRunning(), false);
  monitor.stop(); // second stop is a no-op
});
