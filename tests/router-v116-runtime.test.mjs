/**
 * Router v2 runtime tests (v1.16, Doi T3 — node:test, no network,
 * no GPU, no real model/process).
 *
 * Covers (fake spawner / fake health checker / tmp GGUF files):
 * - ModelProcessManager: start/stop, crash isolation (1 model crash
 *   khong anh huong model khac), restart backoff nhan doi + tran,
 *   het luot restart -> failed, chay on dinh reset dem crash,
 *   stop chu dong khong restart.
 * - LruV2Cache: plan eviction theo byte (max-models / RAM / VRAM),
 *   khong evict active/resident/min-stay, sweep idle theo TTL.
 * - SwapGroupManager: add nhom (trung model / maxBytes am bi tu choi),
 *   groupHasRoom, planPreemption theo priority + LRU, resident khong
 *   bi preempt, default groups co embedder always-resident.
 * - LocalModelRouterV2: refreshDiscovery, load on-demand (evict khi
 *   vuot maxLoadedModels), load lai tra ngay, unload tu choi khi
 *   active, begin/endTask bao ve, sweepIdle, crash isolation o muc
 *   router, status snapshot.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v116-runtime.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GGUF_MAGIC,
  LocalModelRouterV2,
  LruV2Cache,
  ModelProcessManager,
  SwapGroupManager,
} from '../packages/core/dist/routerV2/index.js';

const GB = 1024 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake child process: kill() kich hoat listener 'exit'. */
function makeFakeSpawner(log) {
  return (binary, args, opts) => {
    const listeners = { exit: [], error: [] };
    const child = {
      pid: 1000 + log.length,
      killed: false,
      kill() {
        if (child.killed) return false;
        child.killed = true;
        for (const fn of [...listeners.exit]) fn(0, null);
        return true;
      },
      crash(code = 1) {
        child.killed = true;
        for (const fn of [...listeners.exit]) fn(code, null);
      },
      on(event, fn) {
        listeners[event].push(fn);
      },
    };
    log.push({ binary, args, port: opts.port, child });
    return child;
  };
}

/** Viet file GGUF toi thieu hop le, metadata nho de footprint nho (~256MB overhead). */
function writeMiniGguf(dir, name, sizeBytes) {
  const kvs = [
    ['general.name', 8, name.replace('.gguf', '')],
    ['general.architecture', 8, 'qwen3'],
    ['llama.context_length', 4, 512],
    ['llama.block_count', 4, 2],
    ['llama.attention.head_count_kv', 4, 1],
    ['llama.attention.head_count', 4, 1],
    ['llama.embedding_length', 4, 64],
  ];
  const parts = [];
  const header = Buffer.alloc(24);
  header.writeUInt32LE(GGUF_MAGIC, 0);
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(0n, 8);
  header.writeBigUInt64LE(BigInt(kvs.length), 16);
  parts.push(header);
  for (const [key, valueType, value] of kvs) {
    const keyBuf = Buffer.from(key, 'utf8');
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64LE(BigInt(keyBuf.length));
    parts.push(lenBuf, keyBuf);
    const typeBuf = Buffer.alloc(4);
    typeBuf.writeUInt32LE(valueType);
    parts.push(typeBuf);
    if (valueType === 8) {
      const vBuf = Buffer.from(value, 'utf8');
      const vLen = Buffer.alloc(8);
      vLen.writeBigUInt64LE(BigInt(vBuf.length));
      parts.push(vLen, vBuf);
    } else {
      const vBuf = Buffer.alloc(4);
      vBuf.writeUInt32LE(value);
      parts.push(vBuf);
    }
  }
  const meta = Buffer.concat(parts);
  const buf = Buffer.alloc(Math.max(sizeBytes, meta.length));
  meta.copy(buf);
  writeFileSync(join(dir, name), buf);
}

function makeModelDir() {
  const dir = mkdtempSync(join(tmpdir(), 'r2-rt-'));
  writeMiniGguf(dir, 'qwen3-4b.gguf', 1024);
  writeMiniGguf(dir, 'qwen3-1p7b.gguf', 512);
  writeMiniGguf(dir, 'nomic-embed-text.gguf', 256);
  return dir;
}

function makeRouter(spawnLog, opts = {}) {
  return new LocalModelRouterV2({
    config: {
      modelsDirs: [opts.modelsDir],
      presetPaths: [],
      maxLoadedModels: opts.maxLoadedModels ?? 2,
      maxRamBytes: opts.maxRamBytes ?? 0,
      // Test chay tren may it RAM trong: khong giu 10% cho he thong.
      reservedRamBytes: 0,
      idleTimeoutMs: opts.idleTimeoutMs ?? 10 * 60 * 1000,
      maxRestarts: opts.maxRestarts ?? 2,
      restartBackoffBaseMs: opts.backoffBaseMs ?? 5,
      restartBackoffMaxMs: opts.backoffMaxMs ?? 50,
      portStart: 18_200,
    },
    spawner: makeFakeSpawner(spawnLog),
    healthChecker: async () => true,
    swapGroups: opts.swapGroups,
    now: opts.now,
  });
}

// ---- ModelProcessManager ----

test('process manager: start/stop, backoff doubles and caps', () => {
  const log = [];
  const mgr = new ModelProcessManager({ spawner: makeFakeSpawner(log), maxRestarts: 3, backoffBaseMs: 100, backoffMaxMs: 250 });
  assert.equal(mgr.backoffForAttempt(1), 100);
  assert.equal(mgr.backoffForAttempt(2), 200);
  assert.equal(mgr.backoffForAttempt(3), 250); // capped
  assert.equal(mgr.backoffForAttempt(10), 250);
  assert.equal(mgr.start('m1', 'llama-server', ['-m', 'x'], 18100), true);
  assert.equal(mgr.start('m1', 'llama-server', ['-m', 'x'], 18100), false); // already running
  assert.equal(mgr.stop('m1'), true);
  assert.equal(mgr.stop('m1'), false);
  assert.equal(mgr.listProcesses().length, 0);
});

test('process manager: crash restarts with backoff, then fails after maxRestarts', async () => {
  const log = [];
  const events = [];
  const mgr = new ModelProcessManager({
    spawner: makeFakeSpawner(log),
    maxRestarts: 2,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    now: () => Date.now(),
  });
  mgr.onEvent((e) => events.push(e.type));
  mgr.start('m1', 'llama-server', ['-m', 'x'], 18100);
  assert.equal(log.length, 1);
  log[0].child.crash(1); // crash 1 -> restart 1
  assert.ok(events.includes('crashed'));
  await sleep(60);
  assert.ok(log.length >= 2, `expected restart, got ${log.length} spawns`);
  log[log.length - 1].child.crash(1); // crash 2 -> restart 2
  await sleep(60);
  assert.ok(log.length >= 3, `expected 2nd restart, got ${log.length} spawns`);
  log[log.length - 1].child.crash(1); // crash 3 -> het luot -> failed
  await sleep(30);
  const proc = mgr.getProcess('m1');
  assert.ok(proc);
  assert.equal(proc.state, 'failed');
  assert.ok(events.includes('failed'));
});

test('process manager: crash isolation — one model crash leaves the other running', async () => {
  const log = [];
  const mgr = new ModelProcessManager({ spawner: makeFakeSpawner(log), maxRestarts: 0, autoRestart: false });
  mgr.start('a', 'llama-server', ['-m', 'a'], 18100);
  mgr.start('b', 'llama-server', ['-m', 'b'], 18101);
  log[0].child.crash(1);
  await sleep(10);
  assert.equal(mgr.getProcess('a').state, 'crashed');
  assert.equal(mgr.getProcess('b').state, 'loading'); // chua bi anh huong
  assert.equal(mgr.getProcess('b').child.killed, false);
});

test('process manager: intentional stop never restarts', async () => {
  const log = [];
  const events = [];
  const mgr = new ModelProcessManager({ spawner: makeFakeSpawner(log), maxRestarts: 3, backoffBaseMs: 5 });
  mgr.onEvent((e) => events.push(e.type));
  mgr.start('m1', 'llama-server', ['-m', 'x'], 18100);
  mgr.stop('m1');
  await sleep(40);
  assert.equal(log.length, 1);
  assert.ok(!events.includes('crashed'));
});

// ---- LruV2Cache ----

function lruEntry(id, ram, lastUsed, extra = {}) {
  return {
    modelId: id, ramBytes: ram, vramBytes: extra.vram ?? 0,
    lastUsedAt: lastUsed, loadedAt: lastUsed - 120_000,
    activeTasks: extra.active ?? 0, resident: extra.resident ?? false,
    priority: extra.priority ?? 50,
  };
}

test('lru v2: evicts LRU first under max-models; never active/resident', () => {
  const cache = new LruV2Cache({ maxLoadedModels: 2, maxRamBytes: 0, idleTimeoutMs: 600_000, minStayMs: 0 });
  const now = 1_000_000;
  cache.add(lruEntry('old', 1 * GB, now - 5000));
  cache.add(lruEntry('new', 1 * GB, now - 1000));
  const plan = cache.planEviction(1 * GB, 0, { now });
  assert.equal(plan.reason, 'max-models');
  assert.deepEqual(plan.toUnload, ['old']);
  assert.equal(plan.enough, true);
});

test('lru v2: RAM eviction frees enough bytes; blocked listed', () => {
  const cache = new LruV2Cache({ maxLoadedModels: 10, maxRamBytes: 4 * GB, idleTimeoutMs: 600_000, minStayMs: 0 });
  const now = 1_000_000;
  cache.add(lruEntry('a', 2 * GB, now - 5000));
  cache.add(lruEntry('b', 1 * GB, now - 1000, { resident: true }));
  cache.add(lruEntry('c', 1 * GB, now - 2000, { active: 1 }));
  // Can them 1GB: 2+1+1+1 > 4 -> evict 'a' (2GB) la du.
  const plan = cache.planEviction(1 * GB, 0, { now });
  assert.equal(plan.reason, 'ram');
  assert.deepEqual(plan.toUnload, ['a']);
  assert.deepEqual(plan.blocked.sort(), ['b', 'c']);
  assert.equal(plan.enough, true);
});

test('lru v2: min-stay protects freshly loaded models unless forced', () => {
  const cache = new LruV2Cache({ maxLoadedModels: 1, maxRamBytes: 0, idleTimeoutMs: 600_000, minStayMs: 60_000 });
  const now = 1_000_000;
  cache.add({ modelId: 'fresh', ramBytes: 1 * GB, vramBytes: 0, lastUsedAt: now, loadedAt: now - 1000, activeTasks: 0, resident: false, priority: 50 });
  const plan = cache.planEviction(1 * GB, 0, { now });
  assert.deepEqual(plan.toUnload, []);
  assert.equal(plan.enough, false);
  const forced = cache.planEviction(1 * GB, 0, { now, force: true });
  assert.deepEqual(forced.toUnload, ['fresh']);
  // Load chu dong cua user duoc bo qua min-stay (khong can force).
  const userLoad = cache.planEviction(1 * GB, 0, { now, ignoreMinStay: true });
  assert.deepEqual(userLoad.toUnload, ['fresh']);
});

test('lru v2: sweepIdle returns only TTL-expired, non-resident, idle models', () => {
  const cache = new LruV2Cache({ maxLoadedModels: 5, maxRamBytes: 0, idleTimeoutMs: 60_000, minStayMs: 0 });
  const now = 1_000_000;
  cache.add(lruEntry('idle-old', 1 * GB, now - 120_000));
  cache.add(lruEntry('idle-resident', 1 * GB, now - 120_000, { resident: true }));
  cache.add(lruEntry('idle-active', 1 * GB, now - 120_000, { active: 2 }));
  cache.add(lruEntry('fresh', 1 * GB, now - 1000));
  assert.deepEqual(cache.sweepIdle(now), ['idle-old']);
});

// ---- SwapGroupManager ----

test('swap groups: validation, room check, preemption order', () => {
  const mgr = new SwapGroupManager();
  assert.equal(mgr.addGroup({ id: 'g1', label: 'G1', modelIds: ['a', 'b'], maxBytes: 4 * GB, residentPolicy: 'on-demand', priority: 10 }).ok, true);
  assert.equal(mgr.addGroup({ id: 'g2', label: 'G2', modelIds: ['b', 'c'], maxBytes: 4 * GB, residentPolicy: 'on-demand', priority: 10 }).ok, false); // 'b' overlap
  assert.equal(mgr.addGroup({ id: 'g3', label: 'G3', modelIds: ['x'], maxBytes: -1, residentPolicy: 'on-demand', priority: 10 }).ok, false);
  assert.equal(mgr.addGroup({ id: 'g4', label: 'G4', modelIds: [], maxBytes: 1, residentPolicy: 'on-demand', priority: 10 }).ok, false);
  assert.equal(mgr.groupOf('a').id, 'g1');
  assert.equal(mgr.isResidentByGroup('a'), false);

  mgr.markLoaded('a', 3 * GB);
  assert.equal(mgr.groupHasRoom('b', 2 * GB), false); // 3 + 2 > 4
  assert.equal(mgr.groupHasRoom('b', 1 * GB), true);
  const plan = mgr.planPreemption('b', 2 * GB, [
    { modelId: 'a', footprintBytes: 3 * GB, lastUsedAt: 100, activeTasks: 0, resident: false, priority: 10 },
  ]);
  assert.deepEqual(plan.toPreempt, ['a']);
  assert.equal(plan.enough, true);

  // Resident member is never preempted.
  const plan2 = mgr.planPreemption('b', 2 * GB, [
    { modelId: 'a', footprintBytes: 3 * GB, lastUsedAt: 100, activeTasks: 0, resident: true, priority: 10 },
  ]);
  assert.deepEqual(plan2.toPreempt, []);
  assert.equal(plan2.enough, false);
  assert.deepEqual(plan2.blocked, ['a']);
});

test('swap groups: default groups include always-resident embedders', () => {
  const groups = SwapGroupManager.defaultGroups();
  const embedders = groups.find((g) => g.id === 'embedders');
  assert.ok(embedders);
  assert.equal(embedders.residentPolicy, 'always');
  assert.ok(embedders.modelIds.includes('nomic-embed-text'));
  const mgr = new SwapGroupManager(groups);
  assert.equal(mgr.isResidentByGroup('nomic-embed-text'), true);
  assert.equal(mgr.isResidentByGroup('qwen3-4b'), false);
});

// ---- LocalModelRouterV2 ----

test('router: refreshDiscovery + load on-demand + reload returns existing', async () => {
  const dir = makeModelDir();
  const spawnLog = [];
  const router = makeRouter(spawnLog, { modelsDir: dir });
  const { models } = router.refreshDiscovery();
  assert.equal(models.length, 3);
  const first = await router.loadModel('qwen3-4b');
  assert.equal(first.ok, true);
  assert.equal(first.port, 18200);
  assert.equal(spawnLog.length, 1);
  assert.ok(spawnLog[0].args.includes('127.0.0.1'));
  const again = await router.loadModel('qwen3-4b');
  assert.equal(again.ok, true);
  assert.equal(spawnLog.length, 1); // khong spawn lai
  const missing = await router.loadModel('khong-co-model');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-found');
  router.shutdown();
});

test('router: maxLoadedModels evicts LRU model', async () => {
  const dir = makeModelDir();
  const spawnLog = [];
  const router = makeRouter(spawnLog, { modelsDir: dir, maxLoadedModels: 1 });
  router.refreshDiscovery();
  await router.loadModel('qwen3-4b');
  await sleep(5);
  const second = await router.loadModel('qwen3-1p7b');
  assert.equal(second.ok, true);
  assert.deepEqual(second.evicted, ['qwen3-4b']);
  const status = await router.status();
  assert.equal(status.loadedModels.length, 1);
  assert.equal(status.loadedModels[0].modelId, 'qwen3-1p7b');
  router.shutdown();
});

test('router: unload refuses active model; begin/endTask guards eviction', async () => {
  const dir = makeModelDir();
  const spawnLog = [];
  const router = makeRouter(spawnLog, { modelsDir: dir, maxLoadedModels: 1 });
  router.refreshDiscovery();
  await router.loadModel('qwen3-4b');
  assert.equal(router.beginTask('qwen3-4b'), true);
  assert.equal(router.unloadModel('qwen3-4b').ok, false);
  assert.equal(router.endTask('qwen3-4b'), true);
  assert.equal(router.unloadModel('qwen3-4b').ok, true);
  assert.equal(router.unloadModel('qwen3-4b').ok, false); // not-loaded
  router.shutdown();
});

test('router: crash isolation — one model crash does not unload the other', async () => {
  const dir = makeModelDir();
  const spawnLog = [];
  const router = makeRouter(spawnLog, {
    modelsDir: dir, maxLoadedModels: 2, maxRestarts: 0, backoffBaseMs: 5,
  });
  // Tat auto-restart bang cach dat maxRestarts 0 (manager van mo
  // 'failed' ngay sau crash dau tien, nhung model kia khong anh huong).
  router.refreshDiscovery();
  await router.loadModel('qwen3-4b');
  await router.loadModel('qwen3-1p7b');
  assert.equal(spawnLog.length, 2);
  spawnLog[0].child.crash(1);
  await sleep(30);
  const status = await router.status();
  const crashed = status.loadedModels.find((m) => m.modelId === 'qwen3-4b');
  const other = status.loadedModels.find((m) => m.modelId === 'qwen3-1p7b');
  assert.ok(crashed);
  assert.equal(crashed.state, 'failed');
  assert.ok(other);
  assert.ok(['loaded', 'loading'].includes(other.state));
  assert.equal(spawnLog[1].child.killed, false);
  router.shutdown();
});

test('router: sweepIdle unloads TTL-expired models only', async () => {
  const dir = makeModelDir();
  const spawnLog = [];
  let now = 1_000_000;
  const router = makeRouter(spawnLog, {
    modelsDir: dir, idleTimeoutMs: 60_000, now: () => now,
  });
  router.refreshDiscovery();
  await router.loadModel('qwen3-4b');
  assert.deepEqual(router.sweepIdle(), []);
  now += 120_000;
  assert.deepEqual(router.sweepIdle(), ['qwen3-4b']);
  router.shutdown();
});

test('router: setResident + status snapshot shape', async () => {
  const dir = makeModelDir();
  const spawnLog = [];
  const router = makeRouter(spawnLog, { modelsDir: dir });
  router.refreshDiscovery();
  await router.loadModel('nomic-embed-text');
  assert.equal(router.setResident('nomic-embed-text', true), true);
  const status = await router.status();
  assert.equal(status.discoveredModels, 3);
  assert.equal(status.loadedModels[0].resident, true);
  assert.ok(status.swapGroups.some((g) => g.id === 'embedders'));
  assert.ok(status.resources.totalRamBytes > 0);
  assert.equal(status.config.maxLoadedModels, 2);
  router.shutdown();
});
