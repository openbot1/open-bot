/**
 * model-refresh-v105.test.mjs — model list tự refresh (v1.05, Đội T3).
 * Mọi fetch đều mock — KHÔNG gọi API thật.
 * Run: build core rồi `node --test tests/model-refresh-v105.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelRefreshService,
  cleanModelIds,
  createAnthropicModelFetcher,
  createGeminiModelFetcher,
  createOllamaModelFetcher,
  createOpenAiCompatibleModelFetcher,
} from '../packages/core/dist/models/refresh.js';
import { ModelRegistry } from '../packages/core/dist/models/registry.js';
import { createOllamaRefreshService } from '../packages/core/dist/models/refresh.js';

const OLLAMA_TAGS = { models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }] };
const OPENAI_MODELS = { data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { id: 'gpt-5' }] };

function mockFetch(body, ok = true, status = 200) {
  return async () => ({
    ok,
    status,
    json: async () => body,
  });
}

test('model refresh: cleanModelIds trim + bỏ trùng + bỏ rỗng', () => {
  assert.deepEqual(cleanModelIds([' a ', 'a', '', 'b', 42, null]), ['a', 'b']);
  assert.deepEqual(cleanModelIds('khong-phai-mang'), []);
});

test('model refresh: Ollama fetcher parse /api/tags, bỏ trùng', async () => {
  let seenUrl = '';
  const fetcher = createOllamaModelFetcher('http://127.0.0.1:11434', async (url) => {
    seenUrl = url;
    return { ok: true, status: 200, json: async () => OLLAMA_TAGS };
  });
  const models = await fetcher('ollama');
  assert.match(seenUrl, /\/api\/tags$/);
  assert.deepEqual(models, ['llama3.1:8b', 'qwen2.5:7b']);
});

test('model refresh: Ollama fetcher sai provider -> throw', async () => {
  const fetcher = createOllamaModelFetcher('http://127.0.0.1:11434', mockFetch(OLLAMA_TAGS));
  await assert.rejects(() => fetcher('openai'), /không hỗ trợ/);
});

test('model refresh: Ollama fetcher HTTP lỗi -> throw rõ', async () => {
  const fetcher = createOllamaModelFetcher(
    'http://127.0.0.1:11434',
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
  );
  await assert.rejects(() => fetcher('ollama'), /HTTP 500/);
});

test('model refresh: OpenAI-compatible fetcher parse /v1/models + gửi Authorization', async () => {
  let seenHeaders = {};
  let seenUrl = '';
  const fetcher = createOpenAiCompatibleModelFetcher('https://api.example.com/v1', 'sk-test', async (url, init) => {
    seenUrl = url;
    seenHeaders = init.headers ?? {};
    return { ok: true, status: 200, json: async () => OPENAI_MODELS };
  });
  const models = await fetcher('openai');
  assert.match(seenUrl, /\/v1\/models$/);
  assert.equal(seenHeaders['Authorization'], 'Bearer sk-test');
  assert.deepEqual(models, ['gpt-5', 'gpt-5-mini']);
});

test('model refresh: Gemini fetcher parse /v1beta/models, bỏ tiền tố models/', async () => {
  let seenUrl = '';
  const fetcher = createGeminiModelFetcher('https://generativelanguage.googleapis.com', 'key-123', async (url) => {
    seenUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] }),
    };
  });
  const models = await fetcher('gemini');
  assert.match(seenUrl, /\/v1beta\/models\?key=key-123/);
  assert.deepEqual(models, ['gemini-2.5-flash', 'gemini-2.5-pro']);
});

test('model refresh: Gemini fetcher sai provider / thiếu key -> throw', async () => {
  const fetcher = createGeminiModelFetcher('https://example.com', 'k', mockFetch({ models: [] }));
  await assert.rejects(() => fetcher('openai'), /không hỗ trợ/);
  const noKey = createGeminiModelFetcher('https://example.com', '', mockFetch({ models: [] }));
  await assert.rejects(() => noKey('gemini'), /cần API key/);
});

test('model refresh: Anthropic fetcher gửi x-api-key + anthropic-version, parse data', async () => {
  let seenHeaders = {};
  let seenUrl = '';
  const fetcher = createAnthropicModelFetcher('sk-ant-1', async (url, init) => {
    seenUrl = url;
    seenHeaders = init.headers ?? {};
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-sonnet-4-5' }] }),
    };
  });
  const models = await fetcher('anthropic');
  assert.equal(seenUrl, 'https://api.anthropic.com/v1/models');
  assert.equal(seenHeaders['x-api-key'], 'sk-ant-1');
  assert.equal(seenHeaders['anthropic-version'], '2023-06-01');
  assert.deepEqual(models, ['claude-haiku-4-5', 'claude-sonnet-4-5']);
});

test('model refresh: service refresh + cache + status', async () => {
  let now = 1_000_000;
  let calls = 0;
  const service = new ModelRefreshService({
    ttlMs: 60_000,
    fetchers: {
      ollama: async () => {
        calls += 1;
        return ['m1', 'm2'];
      },
    },
    source: 'ollama',
    now: () => now,
  });
  const entry = await service.refresh('ollama');
  assert.deepEqual(entry.models, ['m1', 'm2']);
  assert.equal(entry.updatedAt, 1_000_000);
  assert.equal(calls, 1);
  const status = service.getStatus('ollama');
  assert.equal(status.modelCount, 2);
  assert.equal(status.stale, false);
  assert.equal(status.refreshing, false);
  // list() trong TTL: trả cache, không fetch lại.
  assert.deepEqual(await service.list('ollama'), ['m1', 'm2']);
  assert.equal(calls, 1);
});

test('model refresh: quá TTL -> list() refresh nền, trả cache cũ ngay', async () => {
  let now = 1_000_000;
  let calls = 0;
  const service = new ModelRefreshService({
    ttlMs: 1000,
    fetchers: {
      ollama: async () => {
        calls += 1;
        return calls === 1 ? ['m-old'] : ['m-new'];
      },
    },
    now: () => now,
  });
  assert.deepEqual((await service.refresh('ollama')).models, ['m-old']);
  assert.equal(calls, 1);
  now += 2000; // quá TTL
  const listed = await service.list('ollama');
  assert.deepEqual(listed, ['m-old']); // trả cache cũ ngay, không đợi
  assert.equal(calls, 2); // đã kích refresh nền
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await service.list('ollama'), ['m-new']);
});

test('model refresh: fetch lỗi -> cache cũ giữ nguyên + lastError ghi rõ', async () => {
  let fail = false;
  const service = new ModelRefreshService({
    ttlMs: 60_000,
    fetchers: {
      ollama: async () => {
        if (fail) throw new Error('ollama chết');
        return ['m1'];
      },
    },
  });
  await service.refresh('ollama');
  fail = true;
  await assert.rejects(() => service.refresh('ollama'), /ollama chết/);
  const cached = service.getCached('ollama');
  assert.deepEqual(cached.models, ['m1']);
  assert.match(cached.lastError, /ollama chết/);
  // list() vẫn trả cache cũ.
  assert.deepEqual(await service.list('ollama'), ['m1']);
});

test('model refresh: không có fetcher -> throw rõ', async () => {
  const service = new ModelRefreshService({});
  await assert.rejects(() => service.refresh('openai'), /Không có fetcher/);
});

test('model refresh: refreshAll — lỗi một provider không chặn provider khác', async () => {
  const service = new ModelRefreshService({
    fetchers: {
      ollama: async () => ['m1'],
      openai: async () => { throw new Error('key sai'); },
    },
  });
  const results = await service.refreshAll(['ollama', 'openai']);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /key sai/);
});

test('model refresh: seed + stale tính theo TTL', () => {
  let now = 1000;
  const service = new ModelRefreshService({ ttlMs: 5000, now: () => now });
  service.seed('ollama', ['a'], 'builtin');
  assert.equal(service.getStatus('ollama').stale, false);
  now = 7000;
  assert.equal(service.getStatus('ollama').stale, true);
});

test('model refresh: auto-refresh start/stop', async () => {
  let calls = 0;
  const service = new ModelRefreshService({
    ttlMs: 1,
    fetchers: { ollama: async () => { calls += 1; return ['m']; } },
  });
  assert.equal(service.autoRefreshRunning, false);
  service.startAutoRefresh(['ollama'], 20);
  assert.equal(service.autoRefreshRunning, true);
  // Chờ tới khi có >= 2 lần refresh nền (deadline 2s — máy bận có thể
  // làm timer 20ms trễ, nên không assert theo thời gian cố định).
  const deadline = Date.now() + 2000;
  while (calls < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  service.stopAutoRefresh();
  assert.equal(service.autoRefreshRunning, false);
  assert.ok(calls >= 2, `cần >= 2 lần refresh nền, thực tế ${calls}`);
});

test('model refresh: nối registry — Ollama refresh xong vào discovered (local)', async () => {
  const registry = new ModelRegistry({});
  const service = createOllamaRefreshService(registry, {
    fetchFn: mockFetch(OLLAMA_TAGS),
  });
  await service.refresh('ollama');
  const models = registry.listModels('ollama').map((m) => m.id);
  assert.ok(models.includes('llama3.1:8b'), 'model Ollama đã pull phải vào registry');
  assert.ok(models.includes('qwen2.5:7b'));
});
