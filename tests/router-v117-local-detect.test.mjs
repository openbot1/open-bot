/**
 * Local detect v2 tests (v1.17, Doi T3 — node:test).
 *
 * Covers:
 * - parseOllamaTagsResponse / parseOllamaPsResponse: shape that,
 *   field la/thieu bi bo qua, khong crash.
 * - parseLmStudioModelsResponse: OpenAI-compatible shape.
 * - inferParameterSize / mergeLocalModels / markRunningModels.
 * - probeOllamaEndpoint / probeLmStudioEndpoint (fake fetch):
 *   reachable + models, khong phan hoi -> reachable=false,
 *   fetch throw -> reachable=false.
 * - ollamaBaseUrlFromEnv / lmStudioBaseUrlFromEnv.
 * - SourceToggleStore: disable/enable/serialize/deserialize.
 * - cliProbeToLocalSource / endpointProbeToLocalSource.
 * - buildModelPickerEntries: ghi ro nguon + tai khoan, nguon tat
 *   thi enabled=false, sap xep model dang chay truoc.
 * - selectablePickerEntries: chi lay muc bat + kha dung.
 * - detectAllLocalSources (fake fetch + fake CLI runner): hop nhat
 *   Ollama + LM Studio + CLI, khong co fetch van bao not-checked.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v117-local-detect.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SourceToggleStore,
  buildModelPickerEntries,
  cliProbeToLocalSource,
  detectAllLocalSources,
  endpointProbeToLocalSource,
  inferParameterSize,
  lmStudioBaseUrlFromEnv,
  markRunningModels,
  mergeLocalModels,
  ollamaBaseUrlFromEnv,
  parseLmStudioModelsResponse,
  parseOllamaPsResponse,
  parseOllamaTagsResponse,
  probeLmStudioEndpoint,
  probeOllamaEndpoint,
  qualityHintForModel,
  selectablePickerEntries,
} from '../packages/core/dist/routerV2/index.js';

const ollamaTags = {
  models: [
    {
      name: 'qwen2.5:7b', size: 4_700_000_000, modified_at: '2026-11-01T00:00:00Z',
      details: { parameter_size: '7B', quantization_level: 'Q4_K_M', family: 'qwen2' },
    },
    { name: 'llama3.1:8b', size: 4_900_000_000, details: { parameter_size: '8B' } },
    { name: '', size: 1 }, // ten rong -> bo
    'not-an-object', // bo qua, khong crash
    { size: 5 }, // khong ten -> bo
  ],
};

test('parseOllamaTagsResponse: shape that + bo muc loi', () => {
  const models = parseOllamaTagsResponse(ollamaTags);
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'qwen2.5:7b');
  assert.equal(models[0].parameterSize, '7B');
  assert.equal(models[0].sizeBytes, 4_700_000_000);
  assert.equal(models[1].id, 'llama3.1:8b');
  assert.deepEqual(parseOllamaTagsResponse(null), []);
  assert.deepEqual(parseOllamaTagsResponse({}), []);
  assert.deepEqual(parseOllamaTagsResponse({ models: 'nope' }), []);
});

test('parseOllamaPsResponse: tap ten dang chay', () => {
  const running = parseOllamaPsResponse({ models: [{ name: 'qwen2.5:7b' }, { name: 'x' }] });
  assert.ok(running.has('qwen2.5:7b'));
  assert.equal(parseOllamaPsResponse(null).size, 0);
  assert.equal(parseOllamaPsResponse({ models: [{ noName: 1 }] }).size, 0);
});

test('parseLmStudioModelsResponse: OpenAI-compatible shape', () => {
  const models = parseLmStudioModelsResponse({
    data: [
      { id: 'lmstudio-community/qwen2.5-7b-instruct', owned_by: 'lmstudio' },
      { id: 'tiny-model' },
      { id: '' },
      null,
    ],
  });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'lmstudio-community/qwen2.5-7b-instruct');
  assert.equal(models[0].displayName, 'qwen2.5-7b-instruct');
  assert.equal(models[0].parameterSize, '7B');
  assert.equal(models[1].parameterSize, undefined);
  assert.deepEqual(parseLmStudioModelsResponse({ data: 'nope' }), []);
});

test('inferParameterSize: suy tu ten model', () => {
  assert.equal(inferParameterSize('qwen2.5:7b'), '7B');
  assert.equal(inferParameterSize('llama3.1:70b'), '70B');
  assert.equal(inferParameterSize('model-0.5b'), '0.5B');
  assert.equal(inferParameterSize('no-size-here'), undefined);
});

test('mergeLocalModels + markRunningModels', () => {
  const a = [{ id: 'm1', displayName: 'm1', sizeBytes: 100 }];
  const b = [{ id: 'm1', displayName: 'm1', running: true }, { id: 'm2', displayName: 'm2' }];
  const merged = mergeLocalModels(a, b);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((m) => m.id === 'm1').sizeBytes, 100);
  assert.equal(merged.find((m) => m.id === 'm1').running, true);
  const marked = markRunningModels(merged, new Set(['m2']));
  assert.equal(marked.find((m) => m.id === 'm2').running, true);
  assert.equal(marked.find((m) => m.id === 'm1').running, false);
});

function fakeFetch(routes) {
  return async (url) => {
    const handler = routes[url];
    if (handler instanceof Error) throw handler;
    if (handler === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => handler };
  };
}

test('probeOllamaEndpoint: reachable + models + running', async () => {
  const fetchFn = fakeFetch({
    'http://localhost:11434/api/tags': ollamaTags,
    'http://localhost:11434/api/ps': { models: [{ name: 'llama3.1:8b' }] },
  });
  const probe = await probeOllamaEndpoint(fetchFn);
  assert.equal(probe.kind, 'ollama');
  assert.equal(probe.reachable, true);
  assert.equal(probe.models.length, 2);
  assert.equal(probe.models.find((m) => m.id === 'llama3.1:8b').running, true);
  assert.equal(probe.models.find((m) => m.id === 'qwen2.5:7b').running, false);
});

test('probeOllamaEndpoint: khong phan hoi -> reachable=false', async () => {
  const fetchFn = fakeFetch({ 'http://localhost:11434/api/tags': new Error('ECONNREFUSED') });
  const probe = await probeOllamaEndpoint(fetchFn);
  assert.equal(probe.reachable, false);
  assert.deepEqual(probe.models, []);
  assert.match(probe.error ?? '', /did not respond/);
});

test('probeLmStudioEndpoint: reachable + khong phan hoi', async () => {
  const ok = await probeLmStudioEndpoint(fakeFetch({
    'http://localhost:1234/v1/models': { data: [{ id: 'model-a' }] },
  }));
  assert.equal(ok.reachable, true);
  assert.equal(ok.models[0].id, 'model-a');
  const down = await probeLmStudioEndpoint(fakeFetch({}));
  assert.equal(down.reachable, false);
});

test('ollamaBaseUrlFromEnv / lmStudioBaseUrlFromEnv', () => {
  assert.equal(ollamaBaseUrlFromEnv({}), 'http://localhost:11434');
  assert.equal(ollamaBaseUrlFromEnv({ OLLAMA_HOST: 'http://192.168.1.5:11434' }), 'http://192.168.1.5:11434');
  assert.equal(ollamaBaseUrlFromEnv({ OLLAMA_HOST: 'myhost:11434' }), 'http://myhost:11434');
  assert.equal(lmStudioBaseUrlFromEnv({}), 'http://localhost:1234');
  assert.equal(lmStudioBaseUrlFromEnv({ LM_STUDIO_URL: 'http://localhost:1234/' }), 'http://localhost:1234');
});

test('SourceToggleStore: disable/enable/serialize/deserialize', () => {
  const store = new SourceToggleStore();
  assert.equal(store.isEnabled('ollama'), true);
  store.disable('ollama');
  assert.equal(store.isEnabled('ollama'), false);
  assert.deepEqual(store.disabledIds(), ['ollama']);
  store.enable('ollama');
  assert.equal(store.isEnabled('ollama'), true);
  store.disable('cli:claude');
  const restored = SourceToggleStore.deserialize(store.serialize());
  assert.equal(restored.isEnabled('cli:claude'), false);
  assert.equal(restored.isEnabled('ollama'), true);
  const bad = SourceToggleStore.deserialize({ disabledSourceIds: [123, null, 'x'] });
  assert.deepEqual(bad.disabledIds(), ['x']);
  assert.deepEqual(SourceToggleStore.deserialize(null).disabledIds(), []);
});

test('cliProbeToLocalSource / endpointProbeToLocalSource', () => {
  const cli = cliProbeToLocalSource({
    kind: 'claude', label: 'Claude Code', exists: true, binaryPath: '/usr/bin/claude',
    version: '1.2.0', versionSupported: true, versionUntested: false,
    formatStatus: 'known', loggedIn: true, accountLabel: 'user@example.com',
    models: ['claude-sonnet-4.5'], warnings: [], enabled: true, probedAt: 0,
  }, true);
  assert.equal(cli.id, 'cli:claude');
  assert.equal(cli.available, true);
  assert.equal(cli.accountLabel, 'user@example.com');
  assert.equal(cli.models[0].id, 'claude-sonnet-4.5');

  const notInstalled = cliProbeToLocalSource({
    kind: 'codex', label: 'Codex CLI', exists: false, binaryPath: null,
    version: null, versionSupported: false, versionUntested: false,
    formatStatus: 'not-checked', loggedIn: null, models: [], warnings: [],
    enabled: false, probedAt: 0,
  }, false);
  assert.equal(notInstalled.available, false);
  assert.equal(notInstalled.unavailableReason, 'not-installed');

  const ep = endpointProbeToLocalSource({
    kind: 'lmstudio', baseUrl: 'http://localhost:1234', reachable: true,
    models: [{ id: 'm', displayName: 'm' }], probedAt: 0,
  }, true);
  assert.equal(ep.label, 'LM Studio');
  assert.equal(ep.available, true);
});

test('buildModelPickerEntries: nguon + tai khoan + toggle + sap xep', () => {
  const sources = [
    {
      id: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434',
      available: true, models: [
        { id: 'small:3b', displayName: 'small:3b', parameterSize: '3B' },
        { id: 'big:32b', displayName: 'big:32b', parameterSize: '32B', running: true },
      ], enabled: true,
    },
    {
      id: 'cli:claude', kind: 'cli', label: 'Claude Code', available: true,
      accountLabel: 'user@example.com',
      models: [{ id: 'claude-sonnet-4.5', displayName: 'claude-sonnet-4.5' }], enabled: false,
    },
  ];
  const entries = buildModelPickerEntries(sources);
  assert.equal(entries.length, 3);
  // Model dang chay len truoc.
  assert.equal(entries[0].id, 'ollama:big:32b');
  const claudeEntry = entries.find((e) => e.sourceId === 'cli:claude');
  assert.equal(claudeEntry.accountLabel, 'user@example.com');
  assert.equal(claudeEntry.sourceLabel, 'Claude Code');
  assert.equal(claudeEntry.enabled, false); // nguon bi tat
  assert.equal(claudeEntry.available, true);
  // Quality hint: model lon hon thi cao hon.
  assert.ok(qualityHintForModel({ id: 'x', displayName: 'x', parameterSize: '32B' }, 'ollama') >
    qualityHintForModel({ id: 'y', displayName: 'y', parameterSize: '3B' }, 'ollama'));
  const selectable = selectablePickerEntries(entries);
  assert.equal(selectable.length, 2);
  assert.ok(selectable.every((e) => e.enabled && e.available));
});

test('detectAllLocalSources: hop nhat Ollama + LM Studio + CLI', async () => {
  const fetchFn = fakeFetch({
    'http://localhost:11434/api/tags': ollamaTags,
    'http://localhost:11434/api/ps': { models: [] },
    'http://localhost:1234/v1/models': { data: [{ id: 'lm-model' }] },
  });
  const toggles = new SourceToggleStore();
  toggles.disable('lmstudio');
  const sources = await detectAllLocalSources({
    fetchFn,
    toggles,
    cliFinder: () => null, // khong co CLI nao cai tren may test
  });
  const ollama = sources.find((s) => s.id === 'ollama');
  assert.equal(ollama.available, true);
  assert.equal(ollama.models.length, 2);
  const lm = sources.find((s) => s.id === 'lmstudio');
  assert.equal(lm.available, true);
  assert.equal(lm.enabled, false); // bi tat
  assert.equal(lm.models[0].id, 'lm-model');
  const clis = sources.filter((s) => s.kind === 'cli');
  assert.equal(clis.length, 6);
  assert.ok(clis.every((c) => c.available === false));
});

test('detectAllLocalSources: khong co fetch -> not-checked', async () => {
  const sources = await detectAllLocalSources({ cliFinder: () => null });
  const ollama = sources.find((s) => s.id === 'ollama');
  assert.equal(ollama.available, false);
  assert.equal(ollama.unavailableReason, 'not-checked');
});
