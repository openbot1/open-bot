/**
 * SambaNova provider tests (v1.11, Đội T6 — node:test, mock fetch only,
 * NO live calls, NO real keys).
 *
 * Mirrors providers-v110-cerebras.test.mjs. Covers:
 *  - provider class: id / label / baseUrl / defaultModel / known models
 *    (public catalog Nov 2026: Meta-Llama-3.3-70B-Instruct default,
 *    Llama-4 Maverick/Scout, DeepSeek-R1-0528, Qwen3-32B,
 *    Qwen3-235B-A22B-Instruct-2507, Meta-Llama-3.1-8B-Instruct)
 *  - createProvider('sambanova') builds it
 *  - PROVIDERS meta: needsKey + defaultBaseUrl (feeds Settings defaults
 *    + Vault namespace 'provider' automatically)
 *  - chat() via mock fetch: correct endpoint + Authorization header +
 *    model, and the reply parses (incl. a tool call)
 *  - listModels() returns the live catalog when /models answers,
 *    falls back to SAMBANOVA_KNOWN_MODELS when it fails
 *  - ModelRegistry catalogue: defaults + fallbacks + known models
 *  - old openai-compatible preset still resolves (back-compat) and
 *    agrees with the dedicated provider
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/providers-sambanova-v111.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SambaNovaProvider,
  SAMBANOVA_BASE_URL,
  SAMBANOVA_DEFAULT_MODEL,
  SAMBANOVA_KNOWN_MODELS,
  PROVIDERS,
  createProvider,
} from '../packages/core/dist/providers/index.js';
import { ModelRegistry } from '../packages/core/dist/models/registry.js';
import { resolvePreset } from '../packages/core/dist/models/presets.js';

test('providers v111: sambanova class has the right id/baseUrl/default/known models', () => {
  assert.equal(SAMBANOVA_BASE_URL, 'https://api.sambanova.ai/v1');
  assert.equal(SAMBANOVA_DEFAULT_MODEL, 'Meta-Llama-3.3-70B-Instruct');
  assert.deepEqual([...SAMBANOVA_KNOWN_MODELS], [
    'Meta-Llama-3.3-70B-Instruct',
    'Llama-4-Maverick-17B-128E-Instruct',
    'Llama-4-Scout-17B-16E-Instruct',
    'DeepSeek-R1-0528',
    'Qwen3-32B',
    'Qwen3-235B-A22B-Instruct-2507',
    'Meta-Llama-3.1-8B-Instruct',
  ]);

  const provider = new SambaNovaProvider({ id: 'sambanova', label: 'SambaNova', apiKey: 'test-key' });
  assert.equal(provider.id, 'sambanova');
  assert.equal(provider.label, 'SambaNova');
  // Custom baseUrl / defaultModel are respected, not forced.
  const custom = new SambaNovaProvider({
    id: 'sambanova',
    label: 'SambaNova',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    defaultModel: 'custom-model',
  });
  assert.equal(custom.defaultModel, 'custom-model');
});

test("providers v111: createProvider('sambanova') + PROVIDERS meta", () => {
  const provider = createProvider({ id: 'sambanova', label: 'SambaNova', apiKey: 'test-key' });
  assert.ok(provider instanceof SambaNovaProvider);
  assert.equal(provider.id, 'sambanova');
  const meta = PROVIDERS.find((p) => p.id === 'sambanova');
  assert.ok(meta, 'PROVIDERS must list sambanova');
  assert.equal(meta.label, 'SambaNova');
  assert.equal(meta.defaultModel, 'Meta-Llama-3.3-70B-Instruct');
  assert.equal(meta.defaultBaseUrl, 'https://api.sambanova.ai/v1');
  assert.equal(meta.needsKey, true);
  assert.equal(meta.kind, undefined, 'API provider, not CLI');
  // Provider ids stay unique after adding sambanova.
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'PROVIDERS ids must be unique');
});

test('providers v111: sambanova chat() hits the right endpoint with the key (mock fetch)', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'hello from sambanova',
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
    const apiKey = ['mock', 'sambanova', 'key'].join('-');
    const provider = new SambaNovaProvider({ id: 'sambanova', label: 'SambaNova', apiKey });
    const res = await provider.chat({
      model: 'Meta-Llama-3.3-70B-Instruct',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://api.sambanova.ai/v1/chat/completions');
    const headers = seen[0].init.headers;
    const auth = headers.Authorization ?? headers.authorization;
    assert.equal(auth, `Bearer ${apiKey}`);
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.model, 'Meta-Llama-3.3-70B-Instruct');
    assert.equal(body.messages[0].content, 'hi');
    assert.equal(res.text, 'hello from sambanova');
    assert.equal(res.toolCalls?.length, 1);
    assert.equal(res.toolCalls[0].name, 'echo');
    assert.equal(res.usage.inputTokens, 10);
    assert.equal(res.usage.outputTokens, 5);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('providers v111: sambanova listModels() returns the live catalog (mock fetch)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.sambanova.ai/v1/models');
    return new Response(
      JSON.stringify({ data: [{ id: 'Meta-Llama-3.3-70B-Instruct' }, { id: 'Llama-4-Maverick-17B-128E-Instruct' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const provider = new SambaNovaProvider({ id: 'sambanova', label: 'SambaNova', apiKey: 'k' });
    assert.deepEqual(await provider.listModels(), ['Meta-Llama-3.3-70B-Instruct', 'Llama-4-Maverick-17B-128E-Instruct']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('providers v111: sambanova listModels() falls back to known models when /models fails', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const provider = new SambaNovaProvider({ id: 'sambanova', label: 'SambaNova', apiKey: 'k' });
    const models = await provider.listModels();
    assert.deepEqual(models, [...SAMBANOVA_KNOWN_MODELS]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('providers v111: registry catalogue for sambanova (defaults + fallback + models)', () => {
  const registry = new ModelRegistry();
  assert.equal(registry.getDefault('sambanova'), 'Meta-Llama-3.3-70B-Instruct');
  assert.equal(registry.getFallback('sambanova'), 'Meta-Llama-3.3-70B-Instruct');
  const ids = registry.listModels('sambanova').map((m) => m.id);
  for (const model of SAMBANOVA_KNOWN_MODELS) {
    assert.ok(ids.includes(model), `sambanova catalogue must include ${model}`);
  }
});

test('providers v111: old openai-compatible sambanova preset still resolves (back-compat)', () => {
  assert.equal(resolvePreset('sambanova')?.baseUrl, 'https://api.sambanova.ai/v1');
  assert.equal(resolvePreset('sambanova')?.defaultModel, 'Meta-Llama-3.3-70B-Instruct');
});
