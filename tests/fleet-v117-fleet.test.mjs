/**
 * Fleet v14 tests (v1.17, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Registration: new node, duplicate id with different fingerprint
 *   rejected, same fingerprint re-register keeps tasks.
 * - Heartbeat: joining → active.
 * - Health check: stale heartbeat → down, high CPU/RAM → unhealthy,
 *   disk low → degraded/unhealthy, healthy sample clean.
 * - Allocation: least-loaded eligible node wins, label selector and
 *   resource limits enforced with clear reasons, no node → reason.
 * - Release: frees resources.
 * - Drain: blocks new tasks, migration plan moves tasks, blocked
 *   tasks listed, complete drain only when empty, undrain restores.
 * - Capacity report + event log sequence verification.
 * - Persistence: save/load round-trip, corrupt file → null.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v117-fleet.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  allocateFleetV14Task,
  applyFleetV14HealthCheck,
  buildFleetV14CapacityReport,
  completeFleetV14Drain,
  createFleetV14Snapshot,
  drainFleetV14Node,
  fleetV14NodeLoad,
  fleetV14NodesToRemove,
  heartbeatFleetV14Node,
  loadFleetV14Snapshot,
  migrateFleetV14Task,
  planFleetV14Drain,
  registerFleetV14Node,
  releaseFleetV14Task,
  removeFleetV14Node,
  saveFleetV14Snapshot,
  undrainFleetV14Node,
  verifyFleetV14EventLog,
} from '../packages/core/dist/fleetV14/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const MIN = 60 * 1000;

function tmpRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v14-')), 'fleet');
}

function cap(over = {}) {
  return { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 16384, diskTotalMb: 500_000, maxTasks: 4, ...over };
}

function addNode(snap, id, over = {}, labels = {}) {
  const res = registerFleetV14Node(
    snap,
    { nodeId: id, hostname: `${id}.local`, fingerprint: `fp-${id}`, labels, capacity: cap(over) },
    'u_owner',
    T0,
  );
  assert.equal(res.ok, true, res.reason);
  return heartbeatFleetV14Node(res.snapshot, id, T0);
}

function makeTask(id, over = {}) {
  return {
    taskId: id, kind: 'run-bot', cpuCores: 1, ramMb: 1000, vramMb: 0,
    priority: 1, requiredLabels: {}, allowedNodeIds: [], createdBy: 'u_owner', createdAt: T0, ...over,
  };
}

function sample(over = {}) {
  return {
    at: T0, cpuFraction: 0.2, ramFraction: 0.3, vramFraction: 0.1,
    diskFreeMb: 100_000, heartbeatAt: T0, recentTaskErrors: 0, ...over,
  };
}

test('registration: new node, duplicate fingerprint conflict, re-register keeps tasks', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a');
  assert.equal(snap.nodes.length, 1);
  assert.equal(snap.nodes[0].status, 'active');
  // Duplicate id, different fingerprint → rejected.
  const conflict = registerFleetV14Node(
    snap,
    { nodeId: 'node-a', hostname: 'other.local', fingerprint: 'fp-other', capacity: cap() },
    'u_owner',
    T0,
  );
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /different fingerprint/);
  // Same fingerprint → re-register (restart), status back to joining.
  const re = registerFleetV14Node(
    snap,
    { nodeId: 'node-a', hostname: 'node-a.local', fingerprint: 'fp-node-a', capacity: cap() },
    'u_owner',
    T0,
  );
  assert.equal(re.ok, true);
  assert.equal(re.outcome, 're-registered');
  assert.equal(re.snapshot.nodes[0].status, 'joining');
  // Bad capacity rejected.
  const bad = registerFleetV14Node(
    snap,
    { nodeId: 'node-b', hostname: 'b.local', fingerprint: 'fp-b', capacity: cap({ cpuCores: 0 }) },
    'u_owner',
    T0,
  );
  assert.equal(bad.ok, false);
});

test('health check: stale heartbeat down, high usage unhealthy, disk degraded, clean healthy', () => {
  let snap = addNode(createFleetV14Snapshot(T0), 'node-a');
  const clean = applyFleetV14HealthCheck(snap, 'node-a', sample());
  assert.equal(clean.check.health, 'healthy');
  assert.deepEqual(clean.check.reasons, ['all signals normal']);
  const hot = applyFleetV14HealthCheck(snap, 'node-a', sample({ cpuFraction: 0.95 }));
  assert.equal(hot.check.health, 'unhealthy');
  assert.match(hot.check.reasons.join(';'), /CPU 95%/);
  const warm = applyFleetV14HealthCheck(snap, 'node-a', sample({ ramFraction: 0.8 }));
  assert.equal(warm.check.health, 'degraded');
  const lowDisk = applyFleetV14HealthCheck(snap, 'node-a', sample({ diskFreeMb: 4000 }));
  assert.equal(lowDisk.check.health, 'unhealthy');
  const stale = applyFleetV14HealthCheck(snap, 'node-a', sample({ heartbeatAt: T0 - 10 * MIN }));
  assert.equal(stale.check.health, 'down');
  snap = stale.snapshot;
  assert.equal(snap.nodes[0].status, 'down');
  // Down too long → suggest remove.
  assert.deepEqual(fleetV14NodesToRemove(snap, T0 + 25 * 60 * MIN), ['node-a']);
  assert.deepEqual(fleetV14NodesToRemove(snap, T0 + 60 * MIN), []);
  // Unknown node → null check.
  assert.equal(applyFleetV14HealthCheck(snap, 'node-nope', sample()).check, null);
});

test('allocation: least-loaded wins, labels + resources enforced, reasons clear', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a', { ramTotalMb: 16384 });
  snap = addNode(snap, 'node-b', { ramTotalMb: 32768 }, { gpu: 'true' });
  // Load node-a first so node-b wins next allocation.
  const first = allocateFleetV14Task(snap, makeTask('t1', { ramMb: 12000 }), T0);
  assert.equal(first.ok, true);
  assert.equal(first.allocated.nodeId, 'node-a', 'tie broken by nodeId');
  snap = first.snapshot;
  const second = allocateFleetV14Task(snap, makeTask('t2', { ramMb: 1000 }), T0);
  assert.equal(second.allocated.nodeId, 'node-b', 'least-loaded node wins');
  snap = second.snapshot;
  // Label selector: only node-b has gpu=true.
  const gpu = allocateFleetV14Task(snap, makeTask('t3', { requiredLabels: { gpu: 'true' } }), T0);
  assert.equal(gpu.allocated.nodeId, 'node-b');
  snap = gpu.snapshot;
  // Too big for any node.
  const huge = allocateFleetV14Task(snap, makeTask('t4', { ramMb: 999_000 }), T0);
  assert.equal(huge.ok, false);
  assert.match(huge.reason, /not enough RAM/);
  // Duplicate task id rejected.
  const dup = allocateFleetV14Task(snap, makeTask('t1'), T0);
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /already allocated/);
  // Load check: node-b now carries t2+t3.
  const nodeB = snap.nodes.find((n) => n.nodeId === 'node-b');
  assert.ok(fleetV14NodeLoad(nodeB) > 0);
  // Release frees resources.
  snap = releaseFleetV14Task(snap, 't2', 'done', T0);
  const nodeBAfter = snap.nodes.find((n) => n.nodeId === 'node-b');
  assert.equal(nodeBAfter.runningTaskIds.includes('t2'), false);
  assert.equal(nodeBAfter.usedRamMb, 1000, 'only t3 RAM remains');
});

test('drain: blocks new tasks, plans migrations, complete only when empty, undrain restores', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a');
  snap = addNode(snap, 'node-b');
  const a1 = allocateFleetV14Task(snap, makeTask('t1'), T0);
  snap = a1.snapshot;
  const a2 = allocateFleetV14Task(snap, makeTask('t2'), T0);
  snap = a2.snapshot;
  // t1 on node-a, t2 on node-b (tie broken by nodeId, then load).
  const drained = drainFleetV14Node(snap, 'node-a', 'kernel upgrade', 'u_admin', T0);
  assert.equal(drained.ok, true);
  assert.equal(drained.plan.migrations.length + drained.plan.blocked.length, 1);
  snap = drained.snapshot;
  assert.equal(snap.nodes.find((n) => n.nodeId === 'node-a').status, 'draining');
  // New task cannot land on draining node.
  const t3 = allocateFleetV14Task(snap, makeTask('t3'), T0);
  assert.equal(t3.allocated.nodeId, 'node-b');
  snap = t3.snapshot;
  // Complete drain blocked while task remains.
  assert.equal(completeFleetV14Drain(snap, 'node-a', 'u_admin', T0).ok, false);
  // Migrate t1 to node-b, then complete.
  const plan = planFleetV14Drain(snap, 'node-a');
  assert.equal(plan.migrations.length, 1);
  assert.equal(plan.allMovable, true);
  const migrated = migrateFleetV14Task(snap, 't1', plan.migrations[0].toNodeId, 'u_admin', T0);
  assert.equal(migrated.ok, true);
  snap = migrated.snapshot;
  assert.equal(snap.nodes.find((n) => n.nodeId === 'node-a').runningTaskIds.length, 0);
  const done = completeFleetV14Drain(snap, 'node-a', 'u_admin', T0);
  assert.equal(done.ok, true);
  assert.equal(done.snapshot.nodes.find((n) => n.nodeId === 'node-a').status, 'maintenance');
  // Undrain back to active.
  const back = undrainFleetV14Node(done.snapshot, 'node-a', 'u_admin', T0);
  assert.equal(back.ok, true);
  assert.equal(back.snapshot.nodes.find((n) => n.nodeId === 'node-a').status, 'active');
  // Drain a node with a task nothing else can take → blocked list.
  let snap2 = createFleetV14Snapshot(T0);
  snap2 = addNode(snap2, 'node-a', {}, { gpu: 'true' });
  snap2 = addNode(snap2, 'node-b');
  const g = allocateFleetV14Task(snap2, makeTask('tg', { requiredLabels: { gpu: 'true' } }), T0);
  snap2 = g.snapshot;
  const plan2 = planFleetV14Drain(snap2, 'node-a');
  assert.equal(plan2.blocked.length, 1);
  assert.equal(plan2.allMovable, false);
  assert.match(plan2.blocked[0].blockedReason, /labels/);
});

test('capacity report + event log verification + persistence', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a');
  snap = addNode(snap, 'node-b');
  const a = allocateFleetV14Task(snap, makeTask('t1', { ramMb: 2000 }), T0);
  snap = a.snapshot;
  const report = buildFleetV14CapacityReport(snap);
  assert.equal(report.nodeCount, 2);
  assert.equal(report.activeNodeCount, 2);
  assert.equal(report.runningTaskCount, 1);
  assert.equal(report.usedRamMb, 2000);
  assert.equal(report.totalRamMb, 65536);
  assert.deepEqual(report.overloadedNodeIds, []);
  assert.equal(verifyFleetV14EventLog(snap.events).ok, true);
  const tampered = snap.events.map((e, i) => (i === 1 ? { ...e, seq: 99 } : e));
  assert.equal(verifyFleetV14EventLog(tampered).ok, false);
  // Remove node with running task rejected; after release ok.
  assert.equal(removeFleetV14Node(snap, 'node-a', 'u_owner', T0).ok, false);
  snap = releaseFleetV14Task(snap, 't1', 'done', T0);
  const removed = removeFleetV14Node(snap, 'node-a', 'u_owner', T0);
  assert.equal(removed.ok, true);
  assert.equal(removed.snapshot.nodes.find((n) => n.nodeId === 'node-a').status, 'removed');
  // Persistence.
  const root = tmpRoot();
  saveFleetV14Snapshot(root, removed.snapshot);
  const loaded = loadFleetV14Snapshot(root);
  assert.ok(loaded);
  assert.equal(loaded.nodes.length, 2);
  fs.writeFileSync(path.join(root, 'fleet-v117.json'), 'bad');
  assert.equal(loadFleetV14Snapshot(root), null);
});
