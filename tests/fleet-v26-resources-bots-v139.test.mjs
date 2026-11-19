/**
 * Tests for fleet v26 resources + bots + health (v1.39, Team T6).
 *
 * Covers:
 * - Resources: host reserve math (CPU 25%/min 1 core, RAM 25%/min
 *   512 MiB), allocatable pool, admit/refuse (over CPU/RAM, disk
 *   unknown, duplicate bot, invalid quota), release, utilisation,
 *   JSON round-trip. Synthetic capacities keep the tests hermetic
 *   (the live `node:os` probe is only asserted sane, never exact).
 * - Bots: register (id rules, duplicates), the guarded transition
 *   table (illegal jumps refused), start/markStarted/stop/
 *   markStopped/pause/resume, heartbeat staleness, crash + restart
 *   cap (3 per 10 min, then manual), remove guard (live bots refuse),
 *   JSON round-trip.
 * - Health: scoring (heartbeat/state/quota/restarts/errors), bands,
 *   fleet roll-up (worst-first, averages, empty fleet).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v26-resources-bots-v139.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V26_VERSION,
  FleetV26BotRegistry,
  FleetV26ResourceAllocator,
  checkFleetV26BotHealth,
  checkFleetV26FleetHealth,
  computeFleetV26Allocatable,
  computeFleetV26HostReserve,
  isFleetV26EmptyQuota,
  probeFleetV26HostCapacity,
  summarizeFleetV26Bots,
  summarizeFleetV26Health,
  summarizeFleetV26Resources,
} from '../packages/core/dist/fleetV26/index.js';

const NOW = Date.UTC(2026, 10, 18, 10, 0, 0);

/** Synthetic host: 8 cores, 16 GiB RAM, 100 GiB disk free. */
function fakeCapacity() {
  return {
    cpuCores: 8,
    totalRamMB: 16384,
    freeRamMB: 12000,
    totalDiskMB: 102400,
    freeDiskMB: 80000,
    probedAtMs: NOW,
  };
}

function allocator() {
  return new FleetV26ResourceAllocator(fakeCapacity());
}

// --- resources -----------------------------------------------------------

test('resources v26: version + reserve math', () => {
  assert.equal(FLEET_V26_VERSION, 'v26');
  const cap = fakeCapacity();
  const reserve = computeFleetV26HostReserve(cap);
  assert.equal(reserve.cpuCores, 2); // 25% of 8
  assert.equal(reserve.ramMB, 4096); // 25% of 16384
  assert.equal(reserve.diskMB, 2048);
  const allocatable = computeFleetV26Allocatable(cap, reserve);
  assert.deepEqual(allocatable, { cpuCores: 6, ramMB: 12288, diskMB: 100352 });
  // Small host: reserve floors hold (min 1 core, min 512 MiB RAM).
  const small = computeFleetV26HostReserve({
    cpuCores: 2, totalRamMB: 1024, freeRamMB: 800,
    totalDiskMB: null, freeDiskMB: null, probedAtMs: NOW,
  });
  assert.equal(small.cpuCores, 1);
  assert.equal(small.ramMB, 512);
  assert.equal(small.diskMB, 0);
});

test('resources v26: probe is sane (live node:os, values only)', () => {
  const cap = probeFleetV26HostCapacity();
  assert.ok(cap.cpuCores >= 1);
  assert.ok(cap.totalRamMB > 0);
  assert.ok(cap.freeRamMB >= 0 && cap.freeRamMB <= cap.totalRamMB);
  assert.equal(cap.totalDiskMB, null); // no disk probe supplied
  assert.equal(cap.freeDiskMB, null);
  const withDisk = probeFleetV26HostCapacity(() => ({ totalDiskMB: 50000, freeDiskMB: 40000 }));
  assert.equal(withDisk.totalDiskMB, 50000);
  assert.equal(withDisk.freeDiskMB, 40000);
  const badDisk = probeFleetV26HostCapacity(() => { throw new Error('probe boom'); });
  assert.equal(badDisk.totalDiskMB, null); // a failing probe degrades to unknown, never throws
});

test('resources v26: allocate / refuse / release', () => {
  const alloc = allocator();
  assert.deepEqual(alloc.remaining(), { cpuCores: 6, ramMB: 12288, diskMB: 100352 });

  const ok = alloc.allocate({ botId: 'bot-a', cpuCores: 2, ramMB: 4096, diskMB: 10240 }, NOW);
  assert.equal(ok.admitted, true);
  assert.deepEqual(ok.reasons, ['ok']);
  assert.deepEqual(alloc.get('bot-a'), { botId: 'bot-a', cpuCores: 2, ramMB: 4096, diskMB: 10240, grantedAtMs: NOW });
  assert.deepEqual(alloc.remaining(), { cpuCores: 4, ramMB: 8192, diskMB: 90112 });

  // Duplicate bot: refused, state unchanged.
  const dup = alloc.allocate({ botId: 'bot-a', cpuCores: 0.5, ramMB: 128 }, NOW);
  assert.equal(dup.admitted, false);
  assert.ok(dup.reasons.includes('bot-already-allocated'));

  // Over CPU + over RAM in one request: both reasons reported.
  const over = alloc.allocate({ botId: 'bot-b', cpuCores: 5, ramMB: 9000 }, NOW);
  assert.equal(over.admitted, false);
  assert.ok(over.reasons.includes('cpu-over-allocatable'));
  assert.ok(over.reasons.includes('ram-over-allocatable'));
  assert.equal(alloc.get('bot-b'), undefined);

  // Invalid quota: negative + empty id.
  assert.equal(alloc.allocate({ botId: 'bot-c', cpuCores: -1 }, NOW).admitted, false);
  assert.equal(alloc.allocate({ botId: '', cpuCores: 1 }, NOW).admitted, false);
  assert.equal(isFleetV26EmptyQuota({ botId: 'x' }), true);
  assert.equal(isFleetV26EmptyQuota({ botId: 'x', cpuCores: 0.5 }), false);

  // Release returns the quota to the pool.
  assert.equal(alloc.release('bot-a'), true);
  assert.equal(alloc.release('bot-a'), false);
  assert.deepEqual(alloc.remaining(), { cpuCores: 6, ramMB: 12288, diskMB: 100352 });
});

test('resources v26: disk unknown refuses disk allocations', () => {
  const noDisk = new FleetV26ResourceAllocator({
    cpuCores: 4, totalRamMB: 8192, freeRamMB: 6000,
    totalDiskMB: null, freeDiskMB: null, probedAtMs: NOW,
  });
  assert.equal(noDisk.remaining().diskMB, null);
  const refused = noDisk.allocate({ botId: 'bot-d', cpuCores: 1, ramMB: 512, diskMB: 100 }, NOW);
  assert.equal(refused.admitted, false);
  assert.ok(refused.reasons.includes('disk-unknown'));
  // A disk-free request on the same host is fine.
  assert.equal(noDisk.allocate({ botId: 'bot-d', cpuCores: 1, ramMB: 512 }, NOW).admitted, true);
});

test('resources v26: utilisation + JSON round-trip + summary', () => {
  const alloc = allocator();
  alloc.allocate({ botId: 'bot-a', cpuCores: 3, ramMB: 6144, diskMB: 50176 }, NOW);
  const util = alloc.utilization();
  assert.equal(util.cpu, 0.5);
  assert.equal(util.ram, 0.5);
  assert.equal(util.disk, 0.5);
  assert.deepEqual(alloc.grantedTotals(), { cpuCores: 3, ramMB: 6144, diskMB: 50176, bots: 1 });

  const restored = FleetV26ResourceAllocator.fromJSON(alloc.toJSON());
  assert.deepEqual(restored.list(), alloc.list());
  assert.deepEqual(restored.remaining(), alloc.remaining());
  const summary = summarizeFleetV26Resources(alloc);
  assert.ok(summary.includes('8 cores'));
  assert.ok(summary.includes('1 bot(s)'));
});

// --- bots ---------------------------------------------------------------

test('bots v26: register + transition table', () => {
  const reg = new FleetV26BotRegistry();
  assert.equal(reg.register({ id: 'bad id!' }).ok, false);
  assert.equal(reg.register({ id: '' }).ok, false);
  const r = reg.register({ id: 'bot-a', name: 'Alpha', tags: ['nightly', 'nightly', ' data '] }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.to, 'registered');
  assert.equal(reg.register({ id: 'bot-a' }).ok, false); // duplicate
  const bot = reg.get('bot-a');
  assert.deepEqual(bot?.spec.tags, ['data', 'nightly']); // deduped + trimmed + sorted
  assert.equal(bot?.state, 'registered');

  // Illegal jump: registered -> paused is refused.
  const bad = reg.transition('bot-a', 'paused', NOW);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /cannot go from registered to paused/);
  assert.equal(reg.get('bot-a')?.state, 'registered');

  // Happy path: start -> markStarted -> pause -> resume -> stop -> markStopped.
  assert.equal(reg.start('bot-a', NOW).to, 'starting');
  assert.equal(reg.markStarted('bot-a', NOW + 1000).to, 'running');
  assert.equal(reg.get('bot-a')?.startedAtMs, NOW + 1000);
  assert.equal(reg.pause('bot-a', NOW + 2000).to, 'paused');
  assert.equal(reg.resume('bot-a', NOW + 3000).to, 'running');
  assert.equal(reg.stop('bot-a', NOW + 4000).to, 'stopping');
  assert.equal(reg.markStopped('bot-a', NOW + 5000).to, 'stopped');
  assert.equal(reg.uptimeMs('bot-a', NOW + 6000), null); // not running anymore

  // Unknown bot everywhere is a refusal, not a throw.
  assert.equal(reg.start('ghost').ok, false);
  assert.equal(reg.get('ghost'), undefined);
  assert.equal(reg.heartbeat('ghost'), false);
  assert.equal(reg.remove('ghost').ok, false);
});

test('bots v26: heartbeat staleness + crash + restart cap', () => {
  const reg = new FleetV26BotRegistry();
  reg.register({ id: 'bot-a', maxRestarts: 2, restartWindowMs: 600000 }, NOW);
  reg.start('bot-a', NOW);
  reg.markStarted('bot-a', NOW);
  assert.equal(reg.heartbeat('bot-a', NOW + 1000), true);
  assert.equal(reg.staleBots(NOW + 1000).length, 0);
  assert.equal(reg.staleBots(NOW + 6 * 60 * 1000).length, 1); // stale after 5 min

  // Crash -> restart (cap 2) -> crash -> restart -> crash -> restart refused.
  assert.equal(reg.reportCrash('bot-a', 'segfault', NOW + 2000).to, 'failed');
  assert.equal(reg.get('bot-a')?.lastError, 'segfault');
  assert.equal(reg.restart('bot-a', NOW + 3000).to, 'starting');
  reg.markStarted('bot-a', NOW + 4000);
  reg.reportCrash('bot-a', 'oom', NOW + 5000);
  assert.equal(reg.restart('bot-a', NOW + 6000).to, 'starting');
  reg.markStarted('bot-a', NOW + 7000);
  reg.reportCrash('bot-a', 'oom again', NOW + 8000);
  const capped = reg.restart('bot-a', NOW + 9000);
  assert.equal(capped.ok, false);
  assert.match(capped.message, /restart cap/);
  assert.equal(reg.get('bot-a')?.state, 'failed');

  // A fresh window resets the counter.
  const afterWindow = reg.restart('bot-a', NOW + 601000);
  assert.equal(afterWindow.ok, true);
  assert.equal(reg.get('bot-a')?.restartsInWindow, 1);

  // Remove: live bots refuse, failed/stopped bots go.
  reg.register({ id: 'bot-b' }, NOW);
  reg.start('bot-b', NOW);
  assert.equal(reg.remove('bot-b').ok, false); // starting = live
  assert.equal(reg.counts().total, 2);
  assert.equal(summarizeFleetV26Bots(reg).includes('2 bot(s)'), true);

  const json = FleetV26BotRegistry.fromJSON(reg.toJSON());
  assert.equal(json.counts().total, 2);
  assert.equal(json.get('bot-a')?.state, 'starting');
});

test('bots v26: quota attach/detach + list filters', () => {
  const reg = new FleetV26BotRegistry();
  reg.register({ id: 'bot-a', tags: ['nightly'] }, NOW);
  reg.register({ id: 'bot-b', tags: ['day'] }, NOW);
  assert.equal(reg.attachQuota('bot-a', { botId: 'bot-a', cpuCores: 1, ramMB: 512, diskMB: 0, grantedAtMs: NOW }), true);
  assert.equal(reg.attachQuota('bot-a', { botId: 'bot-b', cpuCores: 1, ramMB: 512, diskMB: 0, grantedAtMs: NOW }), false); // wrong bot
  assert.equal(reg.get('bot-a')?.quota?.ramMB, 512);
  assert.equal(reg.detachQuota('bot-a'), true);
  assert.equal(reg.get('bot-a')?.quota, null);
  assert.deepEqual(reg.listByTag('nightly').map((b) => b.spec.id), ['bot-a']);
  assert.deepEqual(reg.listByState('registered').map((b) => b.spec.id), ['bot-a', 'bot-b']);
});

// --- health --------------------------------------------------------------

test('health v26: scoring, bands, fleet roll-up', () => {
  const reg = new FleetV26BotRegistry();
  reg.register({ id: 'healthy-bot' }, NOW);
  reg.start('healthy-bot', NOW);
  reg.markStarted('healthy-bot', NOW);
  reg.heartbeat('healthy-bot', NOW);
  const h = checkFleetV26BotHealth(reg.get('healthy-bot'), null, NOW);
  assert.equal(h.score, 100);
  assert.equal(h.band, 'healthy');
  assert.equal(h.cause, 'Healthy.');
  assert.ok(h.checks.every((c) => c.verdict !== 'fail'));

  // Failed bot: state fail (40) + error warn (10) = 50 -> unhealthy.
  reg.register({ id: 'sick-bot' }, NOW);
  reg.start('sick-bot', NOW);
  reg.markStarted('sick-bot', NOW);
  reg.reportCrash('sick-bot', 'disk full', NOW);
  const sick = checkFleetV26BotHealth(reg.get('sick-bot'), null, NOW);
  assert.equal(sick.score, 50);
  assert.equal(sick.band, 'unhealthy');
  assert.match(sick.cause, /disk full/);

  // Over-quota usage fails the quota check.
  reg.register({ id: 'hog-bot' }, NOW);
  reg.attachQuota('hog-bot', { botId: 'hog-bot', cpuCores: 1, ramMB: 512, diskMB: 0, grantedAtMs: NOW });
  reg.start('hog-bot', NOW);
  reg.markStarted('hog-bot', NOW);
  const hog = checkFleetV26BotHealth(
    reg.get('hog-bot'),
    { botId: 'hog-bot', cpuCores: 2, ramMB: 400, diskMB: null, reportedAtMs: NOW },
    NOW,
  );
  assert.equal(hog.checks.find((c) => c.name === 'quota-usage')?.verdict, 'fail');
  assert.ok(hog.score < 100);

  const fleet = checkFleetV26FleetHealth(reg, {}, NOW);
  assert.equal(fleet.bots, 3);
  assert.equal(fleet.band, 'unhealthy');
  assert.equal(fleet.unhealthy, 1);
  assert.equal(fleet.worst[0].botId, 'sick-bot'); // worst first
  assert.ok(typeof fleet.averageScore === 'number');
  assert.ok(summarizeFleetV26Health(fleet).includes('unhealthy'));

  const empty = checkFleetV26FleetHealth(new FleetV26BotRegistry(), {}, NOW);
  assert.equal(empty.band, 'unknown');
  assert.equal(empty.averageScore, null);
  assert.equal(summarizeFleetV26Health(empty), 'No bots registered yet.');
});
