/**
 * Local model router registry/gateway tests (v1.15, Doi T3 — node:test).
 *
 * Covers (mock Ollama / llama.cpp servers in-process, no GPU/model):
 * - MockOllamaServer: /api/tags, /api/show, /api/pull, /v1/models,
 *   /v1/chat/completions echo xac dinh + usage, /health, 404.
 * - Registry (Ollama): load thanh cong qua mock, alreadyLoaded,
 *   chatCompletionsUrl, begin/endTask bao ve unload, unload that
 *   khi dang chay task, load model khong co trong catalogue, load
 *   khi Ollama chet -> failed + backoff sau 3 lan.
 * - Registry (Ollama pull): model chua co -> pull qua spawner gia
 *   -> load thanh cong.
 * - Registry (llama.cpp): spawn gia + health qua mock server o dung
 *   port registry cap -> loaded + pid; unload kill process gia.
 * - Registry LRU: maxLoadedModels=1, load model thu 2 evict model 1.
 * - Registry healthCheck + sweepIdle.
 * - Gateway: start loopback-only (tu choi non-loopback), auth key,
 *   sai bot, rate limit, budget gate chan, chat local qua mock +
 *   ghi spend, fallback sang cloud khi local loi, ghi spend cho
 *   backend phuc vu that.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-local-v115-registry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalBudgetTracker,
  LocalGateway,
  LocalModelRegistry,
  defaultSpawner,
  buildLocalModelProcessEnv,
  MockLlamaCppServer,
  MockOllamaServer,
  PolicyRouter,
  mockCountTokens,
} from '../packages/core/dist/router/local/index.js';

/** Spawner gia: khong chay process that, gia lap exit 0 sau 1 tick. */
function fakeSpawnerFactory(onSpawn) {
  return (command, args) => {
    if (onSpawn) onSpawn(command, args);
    let killed = false;
    const listeners = [];
    const proc = {
      pid: 4242,
      get killed() {
        return killed;
      },
      kill: () => {
        killed = true;
        return true;
      },
      on: (event, listener) => {
        if (event === 'exit') listeners.push(listener);
      },
    };
    // Gia lap exit 0 bat dong bo (cho pull flow).
    setTimeout(() => {
      if (!killed) {
        for (const l of listeners) l(0);
      }
    }, 5);
    return proc;
  };
}

/** Spawner gia khong bao gio exit (cho llama-server chay dai). */
function daemonSpawnerFactory() {
  return () => {
    let killed = false;
    return {
      pid: 7777,
      get killed() {
        return killed;
      },
      kill: () => {
        killed = true;
        return true;
      },
      on: () => {},
    };
  };
}

test('local model child env is allowlisted and excludes application credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-bot-router-env-'));
  try {
    const sourceEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      USERPROFILE: process.env.USERPROFILE ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? '',
      SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
      COMSPEC: process.env.COMSPEC ?? process.env.ComSpec ?? '',
      ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? '',
      CUDA_VISIBLE_DEVICES: '2',
      HIP_VISIBLE_DEVICES: '1',
      OPENAI_API_KEY: 'provider-secret',
      AWS_SECRET_ACCESS_KEY: 'cloud-secret',
      GITHUB_TOKEN: 'github-secret',
      RANDOM_APP_SETTING: 'must-not-pass',
      LD_PRELOAD: '/tmp/untrusted.so',
    };
    const env = buildLocalModelProcessEnv(sourceEnv);
    const outputPath = join(dir, 'child-env.json');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(process.env))`;
    const child = defaultSpawner(process.execPath, ['-e', script], { env });
    const exitCode = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(exitCode, 0);

    const childEnv = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(childEnv.PATH, sourceEnv.PATH);
    assert.equal(childEnv.CUDA_VISIBLE_DEVICES, '2');
    assert.equal(childEnv.HIP_VISIBLE_DEVICES, '1');
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
    assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(childEnv.GITHUB_TOKEN, undefined);
    assert.equal(childEnv.RANDOM_APP_SETTING, undefined);
    assert.equal(childEnv.LD_PRELOAD, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mock ollama: tags/show/pull/models/chat/health', async () => {
  const server = new MockOllamaServer({
    models: [{ name: 'qwen3:4b', sizeBytes: 2_500_000_000 }],
  });
  await server.start();
  try {
    assert.equal(mockCountTokens('hello world'), 2);
    assert.equal(mockCountTokens(''), 1);
    const tags = await (await fetch(`${server.baseUrl}/api/tags`)).json();
    assert.equal(tags.models.length, 1);
    assert.equal(tags.models[0].name, 'qwen3:4b');
    const show = await (await fetch(`${server.baseUrl}/api/show?name=qwen3:4b`)).json();
    assert.equal(show.model, 'qwen3:4b');
    const missing = await fetch(`${server.baseUrl}/api/show?name=khong-co`);
    assert.equal(missing.status, 404);
    // Pull them model moi.
    const pull = await fetch(`${server.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'llama3.2:3b' }),
    });
    assert.equal(pull.status, 200);
    assert.ok(server.listModelNames().includes('llama3.2:3b'));
    // Chat echo xac dinh + usage.
    const chat = await fetch(`${server.openAiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3:4b',
        messages: [{ role: 'user', content: 'xin chao' }],
      }),
    });
    const data = await chat.json();
    assert.equal(data.choices[0].message.content, '[mock:qwen3:4b] xin chao');
    assert.equal(data.usage.prompt_tokens, 2);
    assert.ok(data.usage.completion_tokens >= 1);
    const health = await (await fetch(`${server.baseUrl}/health`)).json();
    assert.equal(health.status, 'ok');
    const notFound = await fetch(`${server.baseUrl}/duong-khong-co`);
    assert.equal(notFound.status, 404);
    assert.ok(server.requests.length > 0);
  } finally {
    await server.stop();
  }
});

test('mock ollama: failChat tra 500', async () => {
  const server = new MockOllamaServer({
    models: [{ name: 'qwen3:4b', sizeBytes: 1, failChat: true }],
  });
  await server.start();
  try {
    const res = await fetch(`${server.openAiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 500);
  } finally {
    await server.stop();
  }
});

test('registry ollama: load/unload/beginTask bao ve', async () => {
  const server = new MockOllamaServer({
    models: [{ name: 'qwen3:4b', sizeBytes: 2_500_000_000 }],
  });
  await server.start();
  try {
    const registry = new LocalModelRegistry({
      ollamaBaseUrl: server.openAiBaseUrl,
      spawner: fakeSpawnerFactory(),
    });
    const loaded = await registry.load('qwen3-4b');
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.alreadyLoaded, false);
    assert.equal(loaded.endpoint, server.baseUrl);
    const again = await registry.load('qwen3-4b');
    assert.equal(again.ok, true);
    assert.equal(again.alreadyLoaded, true);
    assert.ok(registry.chatCompletionsUrl('qwen3-4b')?.endsWith('/v1/chat/completions'));
    // Task dang chay -> khong unload duoc.
    assert.equal(registry.beginTask('qwen3-4b'), true);
    assert.deepEqual(registry.unload('qwen3-4b'), { ok: false, error: 'Model "qwen3-4b" dang chay 1 task — khong the unload.' });
    registry.endTask('qwen3-4b');
    assert.deepEqual(registry.unload('qwen3-4b'), { ok: true });
    assert.equal(registry.chatCompletionsUrl('qwen3-4b'), undefined);
    // Unload model chua quan ly.
    assert.equal(registry.unload('qwen3-8b').ok, false);
    // Pin + status.
    await registry.load('qwen3-4b', { pin: true });
    assert.equal(registry.getInstance('qwen3-4b')?.pinned, true);
    const status = await registry.healthCheck();
    assert.equal(status.loadedCount, 1);
    assert.equal(status.backends[0].healthy, true);
    assert.equal(status.models[0].id, 'qwen3-4b');
    assert.ok(status.ram.totalBytes > 0);
  } finally {
    await server.stop();
  }
});

test('registry ollama: pull model chua co qua spawner gia', async () => {
  const server = new MockOllamaServer({
    models: [{ name: 'qwen3:4b', sizeBytes: 2_500_000_000 }],
  });
  await server.start();
  try {
    const spawned = [];
    const registry = new LocalModelRegistry({
      ollamaBaseUrl: server.openAiBaseUrl,
      spawner: fakeSpawnerFactory((cmd, args) => {
        spawned.push([cmd, ...args]);
        // Gia lap Ollama pull xong thi model xuat hien trong /api/tags.
        if (args[0] === 'pull') server.addModel({ name: args[1], sizeBytes: 2_000_000_000 });
      }),
    });
    const loaded = await registry.load('llama-3.2-3b');
    assert.equal(loaded.ok, true, loaded.error);
    assert.ok(spawned.some(([c, a]) => c === 'ollama' && a === 'pull'));
    assert.ok(server.listModelNames().includes('llama3.2:3b'));
  } finally {
    await server.stop();
  }
});

test('registry: load model khong co trong catalogue + Ollama chet -> failed + backoff', async () => {
  let now = Date.now();
  const registry = new LocalModelRegistry({
    ollamaBaseUrl: 'http://127.0.0.1:11999/v1',
    spawner: fakeSpawnerFactory(),
    http: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    now: () => now,
  });
  const ghost = await registry.load('khong-co');
  assert.equal(ghost.ok, false);
  assert.match(ghost.error, /catalogue/);
  // Ollama chet: 3 lan that -> lan 4 backoff.
  for (let i = 0; i < 3; i++) {
    const r = await registry.load('qwen3-4b');
    assert.equal(r.ok, false);
    assert.match(r.error, /Ollama daemon khong tra loi/);
  }
  const backed = await registry.load('qwen3-4b');
  assert.equal(backed.ok, false);
  assert.match(backed.error, /backoff/);
  // Qua 60s thi thu lai duoc (van that vi Ollama chet, nhung khong phai loi backoff).
  now += 61_000;
  const retry = await registry.load('qwen3-4b');
  assert.equal(retry.ok, false);
  assert.doesNotMatch(retry.error, /backoff/);
});

test('registry llamacpp: spawn gia + health qua mock o dung port', async () => {
  // Registry cap port tu 12100 — mock phai nghe dung port do.
  const server = new MockLlamaCppServer({ port: 12100, modelName: 'qwen3-4b' });
  await server.start();
  try {
    const registry = new LocalModelRegistry({
      spawner: daemonSpawnerFactory(),
      ggufDir: '/tmp/gguf-gia',
    });
    const loaded = await registry.load('qwen3-4b', { backend: 'llamacpp' });
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.endpoint, 'http://127.0.0.1:12100');
    assert.equal(registry.getInstance('qwen3-4b')?.pid, 7777);
    assert.ok(registry.chatCompletionsUrl('qwen3-4b')?.startsWith('http://127.0.0.1:12100'));
    const status = await registry.healthCheck();
    const cpp = status.backends.find((b) => b.kind === 'llamacpp');
    assert.ok(cpp);
    assert.equal(cpp.healthy, true);
    assert.equal(registry.unload('qwen3-4b').ok, true);
  } finally {
    await server.stop();
  }
});

test('registry LRU: maxLoadedModels=1 evict model cu khi load model moi', async () => {
  const server = new MockOllamaServer({
    models: [
      { name: 'qwen3:4b', sizeBytes: 2_500_000_000 },
      { name: 'llama3.2:3b', sizeBytes: 2_000_000_000 },
    ],
  });
  await server.start();
  try {
    const registry = new LocalModelRegistry({
      ollamaBaseUrl: server.openAiBaseUrl,
      spawner: fakeSpawnerFactory(),
      lru: { maxLoadedModels: 1 },
    });
    assert.equal((await registry.load('qwen3-4b')).ok, true);
    const second = await registry.load('llama-3.2-3b');
    assert.equal(second.ok, true);
    assert.deepEqual(second.evicted, ['qwen3-4b']);
    assert.equal(registry.getInstance('qwen3-4b')?.state, 'unloaded');
    assert.equal(registry.getInstance('llama-3.2-3b')?.state, 'loaded');
  } finally {
    await server.stop();
  }
});

test('registry sweepIdle: unload model idle qua nguong', async () => {
  const server = new MockOllamaServer({
    models: [{ name: 'qwen3:4b', sizeBytes: 2_500_000_000 }],
  });
  await server.start();
  try {
    const registry = new LocalModelRegistry({
      ollamaBaseUrl: server.openAiBaseUrl,
      spawner: fakeSpawnerFactory(),
      lru: { maxLoadedModels: 2, idleTimeoutMs: 1000 },
    });
    await registry.load('qwen3-4b');
    // Gia lap lastUsedAt cu bang cach doi 1.1s (idleTimeout 1s).
    await new Promise((r) => setTimeout(r, 1100));
    const swept = registry.sweepIdle();
    assert.deepEqual(swept, ['qwen3-4b']);
    assert.equal(registry.getInstance('qwen3-4b')?.state, 'unloaded');
  } finally {
    await server.stop();
  }
});

test('gateway: start loopback-only, auth, chat local + spend', async () => {
  const server = new MockOllamaServer({
    models: [{ name: 'qwen3:4b', sizeBytes: 2_500_000_000 }],
  });
  await server.start();
  try {
    const registry = new LocalModelRegistry({
      ollamaBaseUrl: server.openAiBaseUrl,
      spawner: fakeSpawnerFactory(),
    });
    const budget = new LocalBudgetTracker();
    const gateway = new LocalGateway({ registry, budget, policy: new PolicyRouter() });
    assert.deepEqual(gateway.start(), { ok: true });
    assert.equal(gateway.isStarted(), true);
    const { secret } = gateway.createKey('bot1', { limitUsd: 5 });
    // Sai key.
    const badKey = await gateway.chat({ apiKey: 'obk_sai', messages: [{ role: 'user', content: 'hi' }], botId: 'bot1' });
    assert.equal(badKey.ok, false);
    assert.match(badKey.error, /Virtual key/);
    // Key cua bot khac.
    const wrongBot = await gateway.chat({ apiKey: secret, messages: [{ role: 'user', content: 'hi' }], botId: 'bot2' });
    assert.equal(wrongBot.ok, false);
    assert.match(wrongBot.error, /khong phai "bot2"/);
    // Chat that qua mock local.
    const res = await gateway.chat({
      apiKey: secret,
      messages: [{ role: 'user', content: 'xin chao' }],
      botId: 'bot1',
      model: 'qwen3-4b',
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.servedBy, 'local');
    assert.equal(res.model, 'qwen3-4b');
    assert.equal(res.content, '[mock:qwen3:4b] xin chao');
    assert.ok(res.costUsd >= 0);
    assert.equal(budget.recordCount(), 1);
    assert.equal(budget.listRecords('bot1')[0].kind, 'local');
    // Messages rong.
    const empty = await gateway.chat({ apiKey: secret, messages: [], botId: 'bot1' });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /messages rong/);
  } finally {
    await server.stop();
  }
});

test('gateway: tu choi start khi baseUrl khong loopback', () => {
  const registry = new LocalModelRegistry({ ollamaBaseUrl: 'http://192.168.1.5:11434/v1' });
  const gateway = new LocalGateway({ registry, budget: new LocalBudgetTracker() });
  const started = gateway.start();
  assert.equal(started.ok, false);
  assert.match(started.error, /khong phai loopback/);
  assert.equal(gateway.isStarted(), false);
});

test('gateway: budget gate chan khi vuot + fallback sang cloud khi local loi', async () => {
  const server = new MockOllamaServer({
    models: [{ name: 'qwen3:4b', sizeBytes: 2_500_000_000, failChat: true }],
  });
  await server.start();
  try {
    const registry = new LocalModelRegistry({
      ollamaBaseUrl: server.openAiBaseUrl,
      spawner: fakeSpawnerFactory(),
    });
    const budget = new LocalBudgetTracker();
    budget.setGlobalBudget({ period: 'daily', limitUsd: 0.0001, warnAt: 0.5, blockOnExceed: true });
    const gateway = new LocalGateway({
      registry,
      budget,
      cloudChat: async ({ model, messages }) => ({
        content: `[cloud:${model}] ${messages.at(-1)?.content ?? ''}`,
        // 800k token x $0.0003/1k = $0.24 — vuot budget test $0.0001.
        promptTokens: 400000,
        completionTokens: 400000,
      }),
    });
    gateway.start();
    const { secret } = gateway.createKey('bot1', { limitUsd: 100 });
    // Local loi (mock 500) -> fallback cloud mock -> thanh cong.
    const res = await gateway.chat({
      apiKey: secret,
      messages: [{ role: 'user', content: 'code giup toi' }],
      botId: 'bot1',
      model: 'qwen3-4b',
      taskKind: 'code',
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.servedBy, 'cloud');
    assert.ok(res.fallbacksTried >= 1);
    assert.match(res.content, /^\[cloud:/);
    // Spend da ghi vuot budget cuc nho -> call sau bi chan.
    const blocked = await gateway.chat({
      apiKey: secret,
      messages: [{ role: 'user', content: 'hi' }],
      botId: 'bot1',
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /Budget/);
  } finally {
    await server.stop();
  }
});

test('gateway: rate limit theo key', async () => {
  const server = new MockOllamaServer({
    models: [{ name: 'qwen3:4b', sizeBytes: 2_500_000_000 }],
  });
  await server.start();
  try {
    const registry = new LocalModelRegistry({
      ollamaBaseUrl: server.openAiBaseUrl,
      spawner: fakeSpawnerFactory(),
    });
    const budget = new LocalBudgetTracker();
    const gateway = new LocalGateway({
      registry,
      budget,
      config: { rateLimitPerMinute: 1 },
    });
    gateway.start();
    const { secret } = gateway.createKey('bot1');
    const first = await gateway.chat({ apiKey: secret, messages: [{ role: 'user', content: 'hi' }], botId: 'bot1', model: 'qwen3-4b' });
    assert.equal(first.ok, true, first.error);
    const second = await gateway.chat({ apiKey: secret, messages: [{ role: 'user', content: 'hi' }], botId: 'bot1', model: 'qwen3-4b' });
    assert.equal(second.ok, false);
    assert.match(second.error, /Rate limit/);
  } finally {
    await server.stop();
  }
});
