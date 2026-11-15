/**
 * OpenRouter / Fireworks AI provider tests (v1.08, Đội T4 — node:test,
 * mock fetch only, NO live calls, NO real keys).
 *
 * Covers (mirrors providers-deepseek-groq-mistral-v098.test.mjs):
 *  - provider classes: id / label / baseUrl / defaultModel / known models
 *  - createProvider('openrouter' | 'fireworks') builds them
 *  - PROVIDERS meta: needsKey + defaultBaseUrl (feeds Settings defaults
 *    + Vault namespace 'provider' automatically)
 *  - chat() via mock fetch: correct endpoint + Authorization header +
 *    model, and the reply parses (incl. a tool call)
 *  - listModels() falls back to KNOWN_MODELS when /models fails
 *  - ModelRegistry catalogue: defaults + fallbacks + known models
 *  - old openai-compatible presets still resolve (back-compat)
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/providers-v108-openrouter-fireworks.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FireworksProvider,
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_MODEL,
  FIREWORKS_KNOWN_MODELS,
  OpenRouterProvider,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_KNOWN_MODELS,
  PROVIDERS,
  createProvider,
} from '../packages/core/dist/providers/index.js';
import { ModelRegistry } from '../packages/core/dist/models/registry.js';
import { resolvePreset } from '../packages/core/dist/models/presets.js';

const CASES = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    knownModels: [
      'openrouter/auto',
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.5-flash',
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-4o-mini',
      'deepseek/deepseek-chat',
    ],
    fallback: 'openrouter/auto',
    ProviderClass: OpenRouterProvider,
    consts: [OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODEL, OPENROUTER_KNOWN_MODELS],
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    knownModels: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/llama-v3p1-8b-instruct',
      'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507',
      'accounts/fireworks/models/deepseek-v3p1',
      'accounts/fireworks/models/kimi-k2-instruct',
      'accounts/fireworks/models/gpt-oss-120b',
    ],
    fallback: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    ProviderClass: FireworksProvider,
    consts: [FIREWORKS_BASE_URL, FIREWORKS_DEFAULT_MODEL, FIREWORKS_KNOWN_MODELS],
  },
];

for (const c of CASES) {
  test(`providers v108: ${c.id} class has the right id/baseUrl/default/known models`, () => {
    assert.equal(c.consts[0], c.baseUrl);
    assert.equal(c.consts[1], c.defaultModel);
    assert.deepEqual([...c.consts[2]], c.knownModels);
    const provider = new c.ProviderClass({ id: c.id, label: c.label, apiKey: 'test-key' });
    assert.equal(provider.id, c.id);
    assert.equal(provider.label, c.label);
    // Custom baseUrl / defaultModel are respected, not forced.
    const custom = new c.ProviderClass({
      id: c.id,
      label: c.label,
      apiKey: 'test-key',
      baseUrl: 'https://example.com/v1',
      defaultModel: 'custom-model',
    });
    assert.equal(custom.defaultModel, 'custom-model');
  });

  test(`providers v108: createProvider('${c.id}') + PROVIDERS meta`, () => {
    const provider = createProvider({ id: c.id, label: c.label, apiKey: 'test-key' });
    assert.ok(provider instanceof c.ProviderClass);
    assert.equal(provider.id, c.id);
    const meta = PROVIDERS.find((p) => p.id === c.id);
    assert.ok(meta, `PROVIDERS must list ${c.id}`);
    assert.equal(meta.label, c.label);
    assert.equal(meta.defaultModel, c.defaultModel);
    assert.equal(meta.defaultBaseUrl, c.baseUrl);
    assert.equal(meta.needsKey, true);
    assert.equal(meta.kind, undefined, 'API provider, not CLI');
  });

  test(`providers v108: ${c.id} chat() hits the right endpoint with the key (mock fetch)`, async () => {
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `hello from ${c.id}`,
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
      const provider = new c.ProviderClass({ id: c.id, label: c.label, apiKey: 'test-key-123' });
      const res = await provider.chat({
        model: c.defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, `${c.baseUrl}/chat/completions`);
      const headers = seen[0].init.headers;
      const auth = headers.Authorization ?? headers.authorization;
      assert.equal(auth, 'Bearer test-key-123');
      const body = JSON.parse(seen[0].init.body);
      assert.equal(body.model, c.defaultModel);
      assert.equal(body.messages[0].content, 'hi');
      assert.equal(res.text, `hello from ${c.id}`);
      assert.equal(res.toolCalls?.length, 1);
      assert.equal(res.toolCalls[0].name, 'echo');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`providers v108: ${c.id} listModels() returns the live catalog (mock fetch)`, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.equal(String(url), `${c.baseUrl}/models`);
      return new Response(
        JSON.stringify({ data: [{ id: 'live-model-a' }, { id: 'live-model-b' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    try {
      const provider = new c.ProviderClass({ id: c.id, label: c.label, apiKey: 'k' });
      assert.deepEqual(await provider.listModels(), ['live-model-a', 'live-model-b']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`providers v108: ${c.id} listModels() falls back to known models when /models fails`, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    try {
      const provider = new c.ProviderClass({ id: c.id, label: c.label, apiKey: 'k' });
      const models = await provider.listModels();
      assert.deepEqual(models, c.knownModels);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`providers v108: registry catalogue for ${c.id} (defaults + fallback + models)`, () => {
    const registry = new ModelRegistry();
    assert.equal(registry.getDefault(c.id), c.defaultModel);
    assert.equal(registry.getFallback(c.id), c.fallback);
    const ids = registry.listModels(c.id).map((m) => m.id);
    for (const model of c.knownModels) assert.ok(ids.includes(model), `${c.id} catalogue must include ${model}`);
  });
}

test('providers v108: old openai-compatible presets still resolve (back-compat)', () => {
  assert.equal(resolvePreset('openrouter')?.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(resolvePreset('fireworks')?.defaultModel, 'accounts/fireworks/models/llama-v3p3-70b-instruct');
  // The dedicated provider and the preset agree on base URL + default.
  for (const c of CASES) {
    assert.equal(resolvePreset(c.id)?.baseUrl, c.baseUrl);
    assert.equal(resolvePreset(c.id)?.defaultModel, c.defaultModel);
  }
});

test('providers v108: Fireworks model ids keep the full accounts/fireworks/models/ form', () => {
  for (const model of FIREWORKS_KNOWN_MODELS) {
    assert.ok(
      model.startsWith('accounts/fireworks/models/'),
      `Fireworks model id must be full-form, got ${model}`,
    );
  }
});

test('providers v108: unknown provider id still throws', () => {
  assert.throws(() => createProvider({ id: 'nope', label: 'Nope' }), /Không rõ provider id/);
});
