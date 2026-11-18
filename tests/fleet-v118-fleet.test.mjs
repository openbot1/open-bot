/**
 * Fleet v15 tests (v1.18, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Health scoring: perfect sample → 100/excellent; high CPU/RAM →
 *   lower score + reasons; stale heartbeat → 0 heartbeat factor;
 *   trend from recent scores; grade boundaries; no-GPU node.
 * - Capacity forecast: growth → days until full + tightest resource;
 *   no growth → Infinity/ok; unknown disk without samples; urgent
 *   vs watch thresholds.
 * - Safe drain: all tasks movable + headroom OK → drains; destination
 *   would exceed headroom → blocked, snapshot unchanged; blocked task
 *   (nowhere to go) → blocked.
 * - Rebalance: overloaded node sheds tasks to least-loaded node,
 *   expected loads drop below max, apply moves tasks for real,
 *   still-overloaded listed when nothing can move.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v118-fleet.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateFleetV14Task,
  applyFleetV14HealthCheck,
  createFleetV14Snapshot,
  heartbeatFleetV14Node,
  registerFleetV14Node,
} from '../packages/core/dist/fleetV14/index.js';
import {
  applyFleetV15Rebalance,
  buildFleetV15Overview,
  fleetV15HealthGrade,
  forecastFleetV15Capacity,
  planFleetV15Rebalance,
  safeDrainFleetV15Node,
  scoreFleetV15FleetHealth,
  scoreFleetV15NodeHealth,
} from '../packages/core/dist/fleetV15/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function cap(over = {}) {
  return { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 16384, diskTotalMb: 500_000, maxTasks: 4, ...over };
}

function addNode(snap, id, over = {}, labels = {}) {
  const res = registerFleetV14Node(
    snap,
    { nodeId: id, hostname: `${id}.local`, fingerprint: `fp-${id}`, labels, capacity: cap(over) },
    'admin',
    T0,
  );
  assert.equal(res.ok, true, res.reason);
  return heartbeatFleetV14Node(res.snapshot, id, T0);
}

function sample(over = {}) {
  return {
    at: T0,
    cpuFraction: 0.1,
    ramFraction: 0.1,
    vramFraction: 0.1,
    diskFreeMb: 100_000,
    heartbeatAt: T0,
    recentTaskErrors: 0,
    ...over,
  };
}

function task(id, over = {}) {
  return {
    taskId: id, kind: 'bot', cpuCores: 1, ramMb: 1024, vramMb: 0,
    priority: 1, requiredLabels: {}, allowedNodeIds: [], createdBy: 'u1', createdAt: T0, ...over,
  };
}

test('fleet v15: health scoring (perfect, stressed, stale heartbeat, trend, grades)', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a');
  const node = snap.nodes[0];
  const perfect = scoreFleetV15NodeHealth(node, sample(), [], T0);
  assert.equal(perfect.score, 100);
  assert.equal(perfect.grade, 'excellent');
  assert.deepEqual(perfect.reasons, ['all signals healthy']);
  assert.equal(perfect.trend, 'stable');

  const stressed = scoreFleetV15NodeHealth(node, sample({ cpuFraction: 0.95, ramFraction: 0.9, recentTaskErrors: 3 }), [], T0);
  assert.ok(stressed.score < 60, `stressed score should be low, got ${stressed.score}`);
  assert.ok(stressed.reasons.some((r) => r.includes('CPU')));
  assert.ok(stressed.reasons.some((r) => r.includes('RAM')));
  assert.ok(stressed.reasons.some((r) => r.includes('task errors')));
  assert.equal(stressed.factors.errors, 40);

  const stale = scoreFleetV15NodeHealth(node, sample({ heartbeatAt: T0 - 10 * 60 * 1000 }), [], T0);
  assert.equal(stale.factors.heartbeat, 0);
  assert.ok(stale.reasons.some((r) => r.includes('heartbeat')));

  // Trend: rising recent scores → improving; falling → declining.
  const improving = scoreFleetV15NodeHealth(node, sample(), [60, 65, 70, 80], T0);
  assert.equal(improving.trend, 'improving');
  const declining = scoreFleetV15NodeHealth(node, sample({ cpuFraction: 0.9 }), [95, 90, 85, 80], T0);
  assert.equal(declining.trend, 'declining');

  // Grade boundaries.
  assert.equal(fleetV15HealthGrade(95), 'excellent');
  assert.equal(fleetV15HealthGrade(80), 'good');
  assert.equal(fleetV15HealthGrade(60), 'fair');
  assert.equal(fleetV15HealthGrade(40), 'poor');
  assert.equal(fleetV15HealthGrade(10), 'critical');

  // No-GPU node: vram factor is 100 and weight moves to RAM.
  const noGpu = { ...node, capacity: cap({ vramTotalMb: 0 }) };
  const scored = scoreFleetV15NodeHealth(noGpu, sample({ vramFraction: 1 }), [], T0);
  assert.equal(scored.factors.vram, 100);
  assert.equal(scored.score, 100);

  // Fleet scoring sorts worst first and skips nodes without samples.
  const scores = scoreFleetV15FleetHealth(snap, { 'node-a': sample({ cpuFraction: 0.9 }) });
  assert.equal(scores.length, 1);
  assert.equal(scores[0].nodeId, 'node-a');
  assert.equal(scoreFleetV15FleetHealth(snap, {}).length, 0);
});

test('fleet v15: capacity forecast (growth, no growth, unknown disk, thresholds)', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a');
  snap = addNode(snap, 'node-b');
  // No health samples → disk unknown.
  const noData = forecastFleetV15Capacity(snap, { cpuCoresPerDay: 1, ramMbPerDay: 1000, vramMbPerDay: 0, diskMbPerDay: 1000, tasksPerDay: 0.1 }, T0);
  const disk = noData.resources.find((r) => r.resource === 'disk');
  assert.equal(disk.status, 'unknown');
  assert.equal(disk.daysUntilFull, null);
  // No growth at all → Infinity, ok (disk is 'unknown' without samples).
  const flat = forecastFleetV15Capacity(snap, { cpuCoresPerDay: 0, ramMbPerDay: 0, vramMbPerDay: 0, diskMbPerDay: 0, tasksPerDay: 0 }, T0);
  assert.equal(flat.daysUntilFirstFull, Number.POSITIVE_INFINITY);
  assert.ok(flat.resources.filter((r) => r.status !== 'unknown').every((r) => r.status === 'ok'));

  // Add a disk sample via health check, then forecast with fast RAM growth.
  const checked = applyFleetV14HealthCheck(snap, 'node-a', sample());
  snap = checked.snapshot;
  const fast = forecastFleetV15Capacity(snap, { cpuCoresPerDay: 0.1, ramMbPerDay: 10_000, vramMbPerDay: 0, diskMbPerDay: 100, tasksPerDay: 0 }, T0);
  // Total RAM 65536 MB, used 0 → 6.5 days at 10k/day → urgent, tightest = ram.
  assert.equal(fast.tightestResource, 'ram');
  assert.ok(fast.daysUntilFirstFull < 14);
  assert.equal(fast.resources.find((r) => r.resource === 'ram').status, 'urgent');
  assert.match(fast.summary, /ram fills first/);
  // Slow growth → watch/ok.
  const slow = forecastFleetV15Capacity(snap, { cpuCoresPerDay: 0, ramMbPerDay: 2000, vramMbPerDay: 0, diskMbPerDay: 0, tasksPerDay: 0 }, T0);
  assert.equal(slow.resources.find((r) => r.resource === 'ram').status, 'watch');
  assert.ok(slow.daysUntilFirstFull > 14 && slow.daysUntilFirstFull < 45);
});

test('fleet v15: safe drain (headroom OK drains; headroom breach blocks; nowhere-to-go blocks)', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a');
  snap = addNode(snap, 'node-b');
  // One small task on node-a.
  snap = allocateFleetV14Task(snap, task('t1'), T0).snapshot;
  assert.equal(snap.tasks[0].nodeId, 'node-a');
  const ok = safeDrainFleetV15Node(snap, 'node-a', 'maintenance', 'admin', 0.15, T0);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.snapshot.nodes.find((n) => n.nodeId === 'node-a').status, 'draining');
  assert.equal(ok.plan.migrations.length, 1);
  assert.equal(ok.checks[0].safe, true);

  // Fill node-b to the brim so it cannot take the task with headroom.
  let full = createFleetV14Snapshot(T0);
  full = addNode(full, 'node-a');
  full = addNode(full, 'node-b');
  full = allocateFleetV14Task(full, task('t1'), T0).snapshot; // node-a
  full = allocateFleetV14Task(full, task('t2', { cpuCores: 7, ramMb: 30000 }), T0).snapshot; // node-b (nearly full)
  const blocked = safeDrainFleetV15Node(full, 'node-a', 'maintenance', 'admin', 0.15, T0);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /headroom|nowhere/);
  assert.equal(blocked.snapshot.nodes.find((n) => n.nodeId === 'node-a').status, 'active', 'snapshot unchanged when blocked');
  assert.equal(blocked.checks.some((c) => !c.safe), true, 'headroom check flags the unsafe move');
  assert.ok(blocked.checks[0].destLoadAfter > 0.85);

  // Single node fleet: task has nowhere to go.
  let solo = createFleetV14Snapshot(T0);
  solo = addNode(solo, 'node-a');
  solo = allocateFleetV14Task(solo, task('t1'), T0).snapshot;
  const soloRes = safeDrainFleetV15Node(solo, 'node-a', 'maintenance', 'admin', 0.15, T0);
  assert.equal(soloRes.ok, false);
  assert.match(soloRes.reason, /nowhere to go/);

  // Unknown node.
  assert.equal(safeDrainFleetV15Node(snap, 'nope', 'x', 'admin', 0.15, T0).ok, false);
});

test('fleet v15: rebalance moves load off overloaded nodes', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a', { maxTasks: 4 });
  snap = addNode(snap, 'node-b', { maxTasks: 4 });
  // Overload node-a: 4 tasks × 2 cores = 8/8 cores (load 1.0).
  for (let i = 0; i < 4; i++) {
    const res = allocateFleetV14Task(snap, task(`t${i}`, { cpuCores: 2, ramMb: 2048, allowedNodeIds: ['node-a'] }), T0);
    assert.equal(res.ok, true, res.reason);
    snap = res.snapshot;
  }
  assert.equal(snap.nodes.find((n) => n.nodeId === 'node-a').runningTaskIds.length, 4);
  // Lift the node pin (constraints changed) so rebalance may move them.
  snap = {
    ...snap,
    tasks: snap.tasks.map((t) => ({ ...t, task: { ...t.task, allowedNodeIds: [] } })),
  };
  const plan = planFleetV15Rebalance(snap, 0.7, 0.05);
  assert.ok(plan.moves.length >= 2, `expected >= 2 moves, got ${plan.moves.length}: ${plan.summary}`);
  assert.ok(plan.moves.every((m) => m.fromNodeId === 'node-a' && m.toNodeId === 'node-b'));
  assert.ok(plan.moves.every((m) => m.toLoadAfter <= 0.7), 'destination stays under max load');
  assert.equal(plan.stillOverloaded.length, 0);
  const applied = applyFleetV15Rebalance(snap, plan, 'admin', T0);
  assert.equal(applied.ok, true, applied.reason);
  assert.equal(applied.appliedMoves.length, plan.moves.length);
  const afterA = applied.snapshot.nodes.find((n) => n.nodeId === 'node-a');
  assert.ok(afterA.runningTaskIds.length < 4, 'node-a shed tasks');

  // Balanced fleet: no moves.
  let calm = createFleetV14Snapshot(T0);
  calm = addNode(calm, 'node-a');
  calm = addNode(calm, 'node-b');
  calm = allocateFleetV14Task(calm, task('t1'), T0).snapshot;
  const calmPlan = planFleetV15Rebalance(calm, 0.7, 0.05);
  assert.equal(calmPlan.moves.length, 0);
  assert.equal(applyFleetV15Rebalance(calm, calmPlan, 'admin', T0).ok, true);
});

test('fleet v15: overview summary', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a');
  snap = addNode(snap, 'node-b');
  const scores = scoreFleetV15FleetHealth(snap, { 'node-a': sample(), 'node-b': sample({ cpuFraction: 0.5 }) });
  const forecast = forecastFleetV15Capacity(snap, { cpuCoresPerDay: 0, ramMbPerDay: 0, vramMbPerDay: 0, diskMbPerDay: 0, tasksPerDay: 0 }, T0);
  const rebalance = planFleetV15Rebalance(snap);
  const overview = buildFleetV15Overview(snap, scores, forecast, rebalance);
  assert.equal(overview.nodeCount, 2);
  assert.equal(overview.activeNodeCount, 2);
  assert.ok(overview.avgHealthScore > 0);
  assert.equal(overview.worstNodeId, 'node-b');
  assert.match(overview.summary, /Fleet v15:/);
});
