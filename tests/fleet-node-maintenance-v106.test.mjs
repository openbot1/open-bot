/**
 * Tests for fleet node maintenance (packages/core/src/fleet/nodeMaintenance.ts)
 * and the bot-run dry-run plan (planBotRun in botScheduling.ts).
 *
 * Covers drain/undrain (flag survives reload, double-drain and
 * undrain-when-not-draining throw), draining nodes never receiving
 * new runs, requeueing drained-node runs, maintenance windows
 * (overlap rejection, due-now, prune), and planBotRun ranking
 * without writing anything.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-node-maintenance-v106.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  cancelMaintenanceWindow,
  drainFleetNode,
  isNodeDraining,
  loadMaintenanceWindows,
  maintenanceDueNow,
  nodesInMaintenance,
  pruneMaintenanceWindows,
  requeueDrainedNodeRuns,
  scheduleMaintenanceWindow,
  undrainFleetNode,
} from '../packages/core/dist/fleet/nodeMaintenance.js';
import {
  enqueueBotRun,
  findBotRun,
  planBotRun,
  scheduleBotRun,
  DEFAULT_BOT_SCHEDULER_POLICY,
} from '../packages/core/dist/fleet/botScheduling.js';
import {
  loadFleetNodes,
  recordNodeHeartbeat,
  registerFleetNode,
} from '../packages/core/dist/fleet/nodes.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-node-maint-'));
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
  return { local, lan };
}

test('drain/undrain: flag survives reload, double-drain and bad undrain throw', () => {
  const dir = tmpDir();
  const { local } = setupNodes(dir);
  assert.equal(isNodeDraining(local), false);
  const drained = drainFleetNode(dir, local.id, 'OS update', T0 + 1);
  assert.equal(isNodeDraining(drained), true);
  // Reload from disk: the flag must still be there.
  const reloaded = loadFleetNodes(dir).find((n) => n.id === local.id);
  assert.equal(isNodeDraining(reloaded), true);
  assert.equal(reloaded.drainReason, 'OS update');
  assert.throws(() => drainFleetNode(dir, local.id, 'again', T0 + 2), /already draining/);
  assert.throws(() => drainFleetNode(dir, local.id, '', T0 + 2), /non-empty reason/);
  const undrained = undrainFleetNode(dir, local.id, T0 + 3);
  assert.equal(isNodeDraining(undrained), false);
  assert.equal(loadFleetNodes(dir).find((n) => n.id === local.id).draining, undefined);
  assert.throws(() => undrainFleetNode(dir, local.id, T0 + 4), /not draining/);
  assert.throws(() => drainFleetNode(dir, 'fn-nope', 'x', T0), /not registered/);
});

test('a draining node never receives new bot runs', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  drainFleetNode(dir, local.id, 'RAM replacement', T0 + 1);
  const run = enqueueBotRun(dir, { botId: 'bot-a', summary: 'x', resources: RES }, DEFAULT_BOT_SCHEDULER_POLICY, T0 + 2);
  const res = scheduleBotRun(dir, run.id, DEFAULT_BOT_SCHEDULER_POLICY, T0 + 3);
  assert.equal(res.scheduled, true);
  // The loopback node is draining, so the run must land on the LAN node.
  assert.equal(res.nodeId, lan.id);
  // Drain the LAN node too: nothing can be scheduled any more.
  drainFleetNode(dir, lan.id, 'disk check', T0 + 4);
  const run2 = enqueueBotRun(dir, { botId: 'bot-b', summary: 'y', resources: RES }, DEFAULT_BOT_SCHEDULER_POLICY, T0 + 5);
  const res2 = scheduleBotRun(dir, run2.id, DEFAULT_BOT_SCHEDULER_POLICY, T0 + 6);
  assert.equal(res2.scheduled, false);
  assert.equal(findBotRun(dir, run2.id).status, 'queued');
});

test('requeueDrainedNodeRuns moves runs off a draining node and no-ops otherwise', () => {
  const dir = tmpDir();
  const { local } = setupNodes(dir);
  const policy = { ...DEFAULT_BOT_SCHEDULER_POLICY, maxConcurrentPerBot: 0 };
  const run = enqueueBotRun(dir, { botId: 'bot-a', summary: 'x', resources: RES }, policy, T0);
  scheduleBotRun(dir, run.id, policy, T0 + 1);
  // Not draining yet: no-op.
  assert.deepEqual(requeueDrainedNodeRuns(dir, local.id, T0 + 2), []);
  drainFleetNode(dir, local.id, 'maintenance', T0 + 3);
  const requeued = requeueDrainedNodeRuns(dir, local.id, T0 + 4);
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].id, run.id);
  assert.equal(requeued[0].status, 'queued');
  assert.equal(requeued[0].nodeId, null);
  assert.equal(requeued[0].attempts, 0);
  assert.throws(() => requeueDrainedNodeRuns(dir, 'fn-nope', T0), /not registered/);
});

test('maintenance windows: overlap rejected, due-now and prune work', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  const w1 = scheduleMaintenanceWindow(dir, {
    nodeId: local.id, startsAt: T0 + 3_600_000, endsAt: T0 + 7_200_000,
    reason: 'OS update', createdBy: 'admin',
  }, T0);
  assert.equal(w1.nodeId, local.id);
  assert.throws(() => scheduleMaintenanceWindow(dir, {
    nodeId: local.id, startsAt: T0 + 5_000_000, endsAt: T0 + 9_000_000, reason: 'overlap',
  }, T0), /overlaps an existing window/);
  // Same time on a DIFFERENT node is fine.
  const w2 = scheduleMaintenanceWindow(dir, {
    nodeId: lan.id, startsAt: T0 + 5_000_000, endsAt: T0 + 9_000_000, reason: 'disk check',
  }, T0);
  assert.equal(w2.nodeId, lan.id);
  assert.throws(() => scheduleMaintenanceWindow(dir, {
    nodeId: 'fn-nope', startsAt: T0, endsAt: T0 + 1, reason: 'x',
  }, T0), /not registered/);
  assert.throws(() => scheduleMaintenanceWindow(dir, {
    nodeId: local.id, startsAt: T0 + 10, endsAt: T0 + 10, reason: 'x',
  }, T0), /startsAt < endsAt/);
  // Due now: only w1 covers T0 + 4_000_000.
  const due = maintenanceDueNow(loadMaintenanceWindows(dir), T0 + 4_000_000);
  assert.equal(due.length, 1);
  assert.equal(due[0].id, w1.id);
  const nodes = nodesInMaintenance(dir, T0 + 6_000_000);
  assert.equal(nodes.length, 2);
  // Cancel w2, prune after both windows end.
  assert.equal(cancelMaintenanceWindow(dir, w2.id).id, w2.id);
  assert.throws(() => cancelMaintenanceWindow(dir, w2.id), /does not exist/);
  assert.equal(pruneMaintenanceWindows(dir, T0 + 8_000_000), 1);
  assert.equal(loadMaintenanceWindows(dir).length, 0);
});

test('planBotRun ranks nodes without writing anything', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  const before = fs.readdirSync(dir).sort();
  const plan = planBotRun(dir, { botId: 'bot-a', summary: 'x', resources: RES }, DEFAULT_BOT_SCHEDULER_POLICY, T0);
  assert.equal(plan.best.node.id, local.id);
  assert.equal(plan.candidates.length, 2);
  assert.ok(plan.candidates[0].fits);
  assert.ok(plan.candidates[0].score >= plan.candidates[1].score);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  // Nothing fits: best is null, candidates explain why.
  const huge = planBotRun(dir, {
    botId: 'bot-huge', summary: 'x',
    resources: { cpuCores: 64, ramBytes: 64 * GB, diskBytes: 10 * GB },
  }, DEFAULT_BOT_SCHEDULER_POLICY, T0);
  assert.equal(huge.best, null);
  assert.ok(huge.candidates.every((c) => !c.fits));
  // Draining node is ranked last / not fit.
  drainFleetNode(dir, local.id, 'maintenance', T0 + 1);
  const drained = planBotRun(dir, { botId: 'bot-a', summary: 'x', resources: RES }, DEFAULT_BOT_SCHEDULER_POLICY, T0 + 2);
  assert.equal(drained.best.node.id, lan.id);
  assert.equal(drained.candidates.find((c) => c.node.id === local.id).fits, false);
});
