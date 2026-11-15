/**
 * Tests for fleet status v4 (packages/core/src/fleet/fleetStatus.ts).
 *
 * Covers per-node utilisation (reservations counted, unmeasured load
 * reported as null — never guessed as zero), per-bot rollups,
 * health warnings (dead node holding runs, over-concurrency, starving
 * queued runs, stale nodes, no alive node, failed runs) and the
 * one-line status summary.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-status-v106.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildFleetBotStatus,
  buildFleetStatus,
  fleetHealthWarnings,
  formatFleetStatusLine,
  nodeUtilization,
} from '../packages/core/dist/fleet/fleetStatus.js';
import {
  enqueueBotRun,
  scheduleBotRun,
  DEFAULT_BOT_SCHEDULER_POLICY,
} from '../packages/core/dist/fleet/botScheduling.js';
import {
  loadFleetNodes,
  recordNodeHeartbeat,
  registerFleetNode,
} from '../packages/core/dist/fleet/nodes.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-status-'));
}

const GB = 1024 ** 3;
const T0 = 1_790_000_000_000;
const RES = { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB };
const LOAD_IDLE = { runningJobs: 0, queuedJobs: 0, cpuUsedFraction: 0.1, ramUsedBytes: 1 * GB };

function setupNodes(dir, at = T0) {
  const local = registerFleetNode(dir, {
    hostname: 'local', host: '127.0.0.1', port: 18080, role: 'worker',
    cpuCores: 4, ramBytes: 8 * GB, diskBytes: 100 * GB,
  });
  const lan = registerFleetNode(dir, {
    hostname: 'lan', host: '192.168.1.20', port: 18080, role: 'worker',
    cpuCores: 4, ramBytes: 8 * GB, diskBytes: 100 * GB,
  });
  recordNodeHeartbeat(dir, local.id, LOAD_IDLE, at);
  recordNodeHeartbeat(dir, lan.id, LOAD_IDLE, at);
  // recordNodeHeartbeat returns the updated node (with lastLoad) —
  // return those, not the pre-heartbeat registration objects.
  const [localNow, lanNow] = [local.id, lan.id].map((id) =>
    loadFleetNodes(dir).find((n) => n.id === id),
  );
  return { local: localNow, lan: lanNow };
}

test('nodeUtilization counts reservations and reports unmeasured load as null', () => {
  const dir = tmpDir();
  const { local } = setupNodes(dir);
  // Node without any heartbeat load: cpuUsedFraction is null, not 0.
  const fresh = registerFleetNode(dir, {
    hostname: 'fresh', host: '192.168.1.21', port: 18081, role: 'worker',
    cpuCores: 2, ramBytes: 4 * GB, diskBytes: 50 * GB,
  });
  const { utilization } = nodeUtilization(fresh, [], 4);
  assert.equal(utilization.cpuUsedFraction, null);
  assert.equal(utilization.ramUsedBytes, null);
  assert.equal(utilization.activeRuns, 0);
  assert.equal(utilization.cpuReservedFraction, 0);

  const run = enqueueBotRun(dir, { botId: 'bot-a', summary: 'x', resources: RES }, DEFAULT_BOT_SCHEDULER_POLICY, T0);
  scheduleBotRun(dir, run.id, DEFAULT_BOT_SCHEDULER_POLICY, T0 + 1);
  const { utilization: after } = nodeUtilization(local, [{ ...run, status: 'scheduled', nodeId: local.id }], 4);
  assert.equal(after.activeRuns, 1);
  assert.equal(after.cpuReservedFraction, 0.25);
  assert.equal(after.ramReservedFraction, 0.125);
  assert.equal(after.cpuUsedFraction, 0.1);
});

test('buildFleetBotStatus rolls up runs per bot', () => {
  const runs = [
    { botId: 'bot-a', status: 'queued', createdAt: T0, nodeId: null },
    { botId: 'bot-a', status: 'running', createdAt: T0 + 1, nodeId: 'fn-1' },
    { botId: 'bot-a', status: 'failed', createdAt: T0 + 2, nodeId: 'fn-1', lastError: 'boom' },
    { botId: 'bot-b', status: 'done', createdAt: T0, nodeId: 'fn-2' },
  ];
  const status = buildFleetBotStatus('bot-a', runs);
  assert.equal(status.totalRuns, 3);
  assert.equal(status.queued, 1);
  assert.equal(status.running, 1);
  assert.equal(status.failed, 1);
  assert.equal(status.currentNodeId, 'fn-1');
  assert.equal(status.lastError, 'boom');
  assert.equal(status.lastRunAt, T0 + 2);
});

test('buildFleetStatus on an empty fleet has no warnings and zero counts', () => {
  const dir = tmpDir();
  const status = buildFleetStatus(dir, T0);
  assert.equal(status.counts.totalNodes, 0);
  assert.equal(status.counts.totalBots, 0);
  assert.equal(status.nodes.length, 0);
  assert.equal(status.warnings.length, 0);
  assert.equal(status.scheduling.total, 0);
  assert.match(formatFleetStatusLine(status), /nodes 0\/0 alive/);
});

test('buildFleetStatus reports liveness counts, per-bot status and a readable line', () => {
  const dir = tmpDir();
  setupNodes(dir);
  const policy = { ...DEFAULT_BOT_SCHEDULER_POLICY, maxConcurrentPerBot: 0 };
  const run = enqueueBotRun(dir, { botId: 'bot-a', summary: 'x', resources: RES }, policy, T0);
  scheduleBotRun(dir, run.id, policy, T0 + 1);
  enqueueBotRun(dir, { botId: 'bot-b', summary: 'y', resources: RES }, policy, T0 + 2);
  const status = buildFleetStatus(dir, T0 + 5);
  assert.equal(status.counts.totalNodes, 2);
  assert.equal(status.counts.aliveNodes, 2);
  assert.equal(status.counts.totalBots, 2);
  assert.equal(status.bots.find((b) => b.botId === 'bot-a').scheduled, 1);
  assert.equal(status.bots.find((b) => b.botId === 'bot-b').queued, 1);
  assert.equal(status.nodes.length, 2);
  assert.equal(status.warnings.length, 0);
  assert.match(formatFleetStatusLine(status), /nodes 2\/2 alive/);
  assert.match(formatFleetStatusLine(status), /queued=1/);
});

test('fleetHealthWarnings: dead node holding runs is critical', () => {
  const dir = tmpDir();
  const { local } = setupNodes(dir);
  // Local node died (last heartbeat T0, now T0+120s) but still holds a scheduled run.
  const warnings = fleetHealthWarnings(
    [{ ...local, lastHeartbeatAt: T0, lastLoad: LOAD_IDLE }],
    [{ botId: 'bot-a', status: 'scheduled', nodeId: local.id, createdAt: T0, resources: RES }],
    T0 + 120_000,
  );
  const dead = warnings.filter((w) => w.code === 'dead-node-has-runs');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].level, 'critical');
  assert.match(dead[0].message, /local/);
});

test('fleetHealthWarnings: no alive node, starving run, failed runs, over-concurrency', () => {
  const dir = tmpDir();
  const { local } = setupNodes(dir);
  const nodes = [{ ...local, lastHeartbeatAt: T0, lastLoad: LOAD_IDLE }];
  const runs = [
    { botId: 'bot-a', status: 'queued', nodeId: null, createdAt: T0, resources: RES },
    { botId: 'bot-b', status: 'failed', nodeId: local.id, createdAt: T0, resources: RES },
  ];
  const warnings = fleetHealthWarnings(nodes, runs, T0 + 10 * 60_000, { maxConcurrentPerNode: 0 });
  assert.ok(warnings.some((w) => w.code === 'no-alive-node' && w.level === 'critical'));
  assert.ok(warnings.some((w) => w.code === 'queued-run-starving' && w.botId === 'bot-a'));
  assert.ok(warnings.some((w) => w.code === 'failed-runs'));

  const overRuns = [
    { botId: 'bot-a', status: 'running', nodeId: local.id, createdAt: T0, resources: RES },
    { botId: 'bot-b', status: 'running', nodeId: local.id, createdAt: T0, resources: RES },
    { botId: 'bot-c', status: 'running', nodeId: local.id, createdAt: T0, resources: RES },
  ];
  const over = fleetHealthWarnings(
    [{ ...local, lastHeartbeatAt: T0 + 10 * 60_000 - 1000, lastLoad: LOAD_IDLE }],
    overRuns,
    T0 + 10 * 60_000,
    { maxConcurrentPerNode: 2 },
  );
  assert.ok(over.some((w) => w.code === 'node-over-concurrency'));
});

test('fleetHealthWarnings: stale node warns only after the stale threshold', () => {
  const dir = tmpDir();
  const { local } = setupNodes(dir);
  const node = { ...local, lastHeartbeatAt: T0, lastLoad: LOAD_IDLE };
  // 15s after the heartbeat the node is stale (10s threshold) but
  // below the 20s warning threshold: no warning yet.
  const early = fleetHealthWarnings([node], [], T0 + 15_000, { staleWarningMs: 20_000 });
  assert.equal(early.filter((w) => w.code === 'node-stale').length, 0);
  // 25s after the heartbeat the node is still stale (dead only at
  // 30s) and past the warning threshold: one warning.
  const late = fleetHealthWarnings([node], [], T0 + 25_000, { staleWarningMs: 20_000 });
  assert.equal(late.filter((w) => w.code === 'node-stale').length, 1);
});
