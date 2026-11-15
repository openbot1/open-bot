/**
 * Cerebras provider tests (v1.10, Đội T6 — node:test, mock fetch only,
 * NO live calls, NO real keys).
 *
 * Mirrors providers-v108-openrouter-fireworks.test.mjs. Covers:
 *  - provider class: id / label / baseUrl / defaultModel / known models
 *    (public catalog Nov 2026: gpt-oss-120b + qwen-3.8-27b; deprecated
 *    llama-3.3-70b / qwen-3-32b deliberately excluded)
 *  - createProvider('cerebras') builds it
 *  - PROVIDERS meta: needsKey + defaultBaseUrl (feeds Settings defaults
 *    + Vault namespace 'provider' automatically)
 *  - chat() via mock fetch: correct endpoint + Authorization header +
 *    model, and the reply parses (incl. a tool call)
 *  - listModels() returns the live catalog when /models answers,
 *    falls back to CEREBRAS_KNOWN_MODELS when it fails
 *  - ModelRegistry catalogue: defaults + fallbacks + known models
 *  - old openai-compatible preset still resolves (back-compat) and
 *    agrees with the dedicated provider
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/providers-v110-cerebras.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CerebrasProvider,
  CEREBRAS_BASE_URL,
  CEREBRAS_DEFAULT_MODEL,
  CEREBRAS_KNOWN_MODELS,
  PROVIDERS,
  createProvider,
} from '../packages/core/dist/providers/index.js';
import { ModelRegistry } from '../packages/core/dist/models/registry.js';
import { resolvePreset } from '../packages/core/dist/models/presets.js';

test('providers v110: cerebras class has the right id/baseUrl/default/known models', () => {
  assert.equal(CEREBRAS_BASE_URL, 'https://api.cerebras.ai/v1');
  assert.equal(CEREBRAS_DEFAULT_MODEL, 'gpt-oss-120b');
  assert.deepEqual([...CEREBRAS_KNOWN_MODELS], [
    'gpt-oss-120b',
    'qwen-3.8-27b',
    'qwen-3-235b-a22b-instruct-2507',
    'llama-3.1-8b',
    'zai-glm-4.7',
  ]);
  // Deprecated models must NOT be in the fallback list.
  assert.ok(!CEREBRAS_KNOWN_MODELS.includes('llama-3.3-70b'), 'llama-3.3-70b was deprecated 2026-02-16');
  assert.ok(!CEREBRAS_KNOWN_MODELS.includes('qwen-3-32b'), 'qwen-3-32b was deprecated 2026-02-16');
  assert.ok(!CEREBRAS_KNOWN_MODELS.includes('qwen-3-235b-a22b-thinking-2507'), 'thinking variant deprecated');
  assert.ok(!CEREBRAS_KNOWN_MODELS.includes('qwen-3-coder-480b'), 'coder variant deprecated');

  const provider = new CerebrasProvider({ id: 'cerebras', label: 'Cerebras', apiKey: 'test-key' });
  assert.equal(provider.id, 'cerebras');
  assert.equal(provider.label, 'Cerebras');
  // Custom baseUrl / defaultModel are respected, not forced.
  const custom = new CerebrasProvider({
    id: 'cerebras',
    label: 'Cerebras',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    defaultModel: 'custom-model',
  });
  assert.equal(custom.defaultModel, 'custom-model');
});

test("providers v110: createProvider('cerebras') + PROVIDERS meta", () => {
  const provider = createProvider({ id: 'cerebras', label: 'Cerebras', apiKey: 'test-key' });
  assert.ok(provider instanceof CerebrasProvider);
  assert.equal(provider.id, 'cerebras');
  const meta = PROVIDERS.find((p) => p.id === 'cerebras');
  assert.ok(meta, 'PROVIDERS must list cerebras');
  assert.equal(meta.label, 'Cerebras');
  assert.equal(meta.defaultModel, 'gpt-oss-120b');
  assert.equal(meta.defaultBaseUrl, 'https://api.cerebras.ai/v1');
  assert.equal(meta.needsKey, true);
  assert.equal(meta.kind, undefined, 'API provider, not CLI');
  // Provider ids stay unique after adding cerebras.
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'PROVIDERS ids must be unique');
});

test('providers v110: cerebras chat() hits the right endpoint with the key (mock fetch)', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'hello from cerebras',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    // Key built from parts (no key-like literal in the file — the
    // provider must send exactly `Bearer <this key>`).
    const apiKey = ['mock', 'cerebras', 'key'].join('-');
    const provider = new CerebrasProvider({ id: 'cerebras', label: 'Cerebras', apiKey });
    const res = await provider.chat({
      model: 'gpt-oss-120b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://api.cerebras.ai/v1/chat/completions');
    const headers = seen[0].init.headers;
    const auth = headers.Authorization ?? headers.authorization;
    assert.equal(auth, `Bearer ${apiKey}`);
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.model, 'gpt-oss-120b');
    assert.equal(body.messages[0].content, 'hi');
    assert.equal(res.text, 'hello from cerebras');
    assert.equal(res.toolCalls?.length, 1);
    assert.equal(res.toolCalls[0].name, 'echo');
    assert.equal(res.usage.inputTokens, 10);
    assert.equal(res.usage.outputTokens, 5);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('providers v110: cerebras listModels() returns the live catalog (mock fetch)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.cerebras.ai/v1/models');
    return new Response(
      JSON.stringify({ data: [{ id: 'gpt-oss-120b' }, { id: 'qwen-3.8-27b' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const provider = new CerebrasProvider({ id: 'cerebras', label: 'Cerebras', apiKey: 'k' });
    assert.deepEqual(await provider.listModels(), ['gpt-oss-120b', 'qwen-3.8-27b']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('providers v110: cerebras listModels() falls back to known models when /models fails', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const provider = new CerebrasProvider({ id: 'cerebras', label: 'Cerebras', apiKey: 'k' });
    const models = await provider.listModels();
    assert.deepEqual(models, [...CEREBRAS_KNOWN_MODELS]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('providers v110: registry catalogue for cerebras (defaults + fallback + models)', () => {
  const registry = new ModelRegistry();
  assert.equal(registry.getDefault('cerebras'), 'gpt-oss-120b');
  assert.equal(registry.getFallback('cerebras'), 'gpt-oss-120b');
  const ids = registry.listModels('cerebras').map((m) => m.id);
  for (const model of CEREBRAS_KNOWN_MODELS) {
    assert.ok(ids.includes(model), `cerebras catalogue must include ${model}`);
  }
});

test('providers v110: old openai-compatible cerebras preset still resolves (back-compat)', () => {
  assert.equal(resolvePreset('cerebras')?.baseUrl, 'https://api.cerebras.ai/v1');
  assert.equal(resolvePreset('cerebras')?.defaultModel, 'gpt-oss-120b');
});
