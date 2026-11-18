/**
 * Fleet v17 tests (v1.20, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Probe health: all-pass probes score 100 healthy; a failing
 *   liveness probe drops the score and adds a reason; 2 consecutive
 *   failures degrade a healthy node; 5 consecutive failures make it
 *   unhealthy; stale heartbeat (v16) wins over good probes.
 * - Capacity: totals/free/bottleneck/headroom on a 2-node fleet;
 *   empty fleet reports zeros and bottleneck 'none'.
 * - Labels/taints: label validation (bad key, too many), taint
 *   validation (bad effect), toleration matching (empty value/effect
 *   = wildcard), NoSchedule blocks, PreferNoSchedule penalizes.
 * - Drain plan: tasks move to the least-loaded fitting node (label +
 *   taint + resources respected, already-planned moves consume
 *   capacity); unmovable tasks listed; unknown node = empty plan.
 * - NoExecute evictions: running tasks without toleration listed.
 * - Auto-scale: sustained high metric -> up (capped by maxNodes);
 *   sustained low metric -> down (floored by minNodes); cooldown
 *   blocks; disabled rule -> none; no samples -> none.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v120-fleet.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateFleetV14Task,
  createFleetV14Snapshot,
  heartbeatFleetV14Node,
  registerFleetV14Node,
} from '../packages/core/dist/fleetV14/index.js';

import {
  FLEET_V17_MAX_LABELS_PER_NODE,
  checkFleetV17Health,
  checkFleetV17NodeHealth,
  evaluateFleetV17ScaleRule,
  fleetV17NodeFree,
  fleetV17NodeMatchesLabels,
  fleetV17NodeToleratesTask,
  fleetV17NoExecuteEvictions,
  fleetV17TaintPenalty,
  fleetV17Tolerates,
  planFleetV17Drain,
  summarizeFleetV17Capacity,
  validateFleetV17Labels,
  validateFleetV17ProbeResult,
  validateFleetV17ScaleRule,
  validateFleetV17Taint,
} from '../packages/core/dist/fleetV17/index.js';

const T0 = Date.UTC(2026, 11, 16, 0, 0, 0);
const MIN = 60 * 1000;

function cap(over = {}) {
  return { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 0, diskTotalMb: 500_000, maxTasks: 4, ...over };
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

function probe(nodeId, kind, ok, at, detail = 'ok') {
  return { nodeId, kind, ok, latencyMs: 12, detail, at };
}

function twoNodeFleet() {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'n1', {}, { gpu: 'true' });
  snap = addNode(snap, 'n2', {}, {});
  return snap;
}

// ---------------------------------------------------------------------------
// Probe health
// ---------------------------------------------------------------------------

test('fleetV17 probe health: all-pass probes score 100 healthy', () => {
  const snap = twoNodeFleet();
  const node = snap.nodes.find((n) => n.nodeId === 'n1');
  const probes = [
    probe('n1', 'liveness', true, T0),
    probe('n1', 'readiness', true, T0),
    probe('n1', 'disk', true, T0, 'disk free 100GB'),
  ];
  const check = checkFleetV17NodeHealth(node, probes, T0 + 1000);
  assert.equal(check.health, 'healthy');
  assert.equal(check.score, 100);
  assert.equal(check.consecutiveFailures, 0);
  assert.equal(check.lastFailedProbe, null);
});

test('fleetV17 probe health: failing liveness drops score and adds reason', () => {
  const snap = twoNodeFleet();
  const node = snap.nodes.find((n) => n.nodeId === 'n1');
  const probes = [
    probe('n1', 'liveness', false, T0, 'agent ping timeout'),
    probe('n1', 'readiness', true, T0),
  ];
  const check = checkFleetV17NodeHealth(node, probes, T0 + 1000);
  // liveness 30 fail, readiness 25 pass -> 25/55 = 45.
  assert.equal(check.score, 45);
  assert.equal(check.health, 'unhealthy');
  assert.equal(check.consecutiveFailures, 1);
  assert.equal(check.lastFailedProbe.detail, 'agent ping timeout');
  assert.ok(check.reasons.some((r) => r.includes('liveness')));
});

test('fleetV17 probe health: 2 consecutive failures degrade, 5 make unhealthy', () => {
  const snap = twoNodeFleet();
  const node = snap.nodes.find((n) => n.nodeId === 'n1');
  const twoFails = [
    probe('n1', 'network', false, T0, 'timeout'),
    probe('n1', 'network', false, T0 + 1000, 'timeout'),
    probe('n1', 'liveness', true, T0),
    probe('n1', 'readiness', true, T0),
    probe('n1', 'disk', true, T0),
    probe('n1', 'model-server', true, T0),
  ];
  const degraded = checkFleetV17NodeHealth(node, twoFails, T0 + 2000);
  assert.equal(degraded.consecutiveFailures, 2);
  assert.equal(degraded.health, 'degraded');
  const fiveFails = [];
  for (let i = 0; i < 5; i++) fiveFails.push(probe('n1', 'network', false, T0 + i * 1000, 'timeout'));
  fiveFails.push(probe('n1', 'liveness', true, T0));
  const unhealthy = checkFleetV17NodeHealth(node, fiveFails, T0 + 6000);
  assert.equal(unhealthy.consecutiveFailures, 5);
  assert.equal(unhealthy.health, 'unhealthy');
});

test('fleetV17 probe health: stale heartbeat wins over good probes', () => {
  const snap = twoNodeFleet();
  const node = snap.nodes.find((n) => n.nodeId === 'n1');
  // Heartbeat at T0, check 2 hours later -> v16 says down.
  const probes = [probe('n1', 'liveness', true, T0 + 2 * 60 * MIN)];
  const check = checkFleetV17NodeHealth(node, probes, T0 + 2 * 60 * MIN);
  assert.equal(check.health, 'down');
  assert.ok(check.reasons.some((r) => r.includes('heartbeat')));
});

test('fleetV17 probe health: no probes reports heartbeat-only reason', () => {
  const snap = twoNodeFleet();
  const node = snap.nodes.find((n) => n.nodeId === 'n1');
  const check = checkFleetV17NodeHealth(node, [], T0 + 1000);
  assert.equal(check.health, 'healthy');
  assert.ok(check.reasons.some((r) => r.includes('chưa có probe')));
});

test('fleetV17 probe health: validate rejects bad probe', () => {
  assert.notEqual(validateFleetV17ProbeResult(probe('', 'liveness', true, T0)), '');
  assert.notEqual(
    validateFleetV17ProbeResult({ nodeId: 'n1', kind: 'bogus', ok: true, latencyMs: 1, detail: '', at: T0 }),
    '',
  );
  assert.equal(validateFleetV17ProbeResult(probe('n1', 'disk', true, T0)), '');
});

test('fleetV17 health for whole fleet skips removed nodes', () => {
  const snap = twoNodeFleet();
  const checks = checkFleetV17Health(snap, [], T0 + 1000);
  assert.equal(checks.length, 2);
  assert.deepEqual(checks.map((c) => c.nodeId).sort(), ['n1', 'n2']);
});

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

test('fleetV17 capacity: totals, bottleneck, headroom', () => {
  const snap = twoNodeFleet();
  const alloc = allocateFleetV14Task(snap, makeTask('t1', { cpuCores: 6, ramMb: 24000 }), T0);
  assert.equal(alloc.ok, true, alloc.reason);
  const summary = summarizeFleetV17Capacity(alloc.snapshot);
  assert.equal(summary.nodeCount, 2);
  assert.equal(summary.activeNodeCount, 2);
  assert.equal(summary.totalCpuCores, 16);
  assert.equal(summary.freeCpuCores, 10);
  assert.equal(summary.totalRamMb, 65536);
  assert.equal(summary.freeRamMb, 65536 - 24000);
  assert.equal(summary.runningTasks, 1);
  // cpu used 6/16 = 37.5%, ram used 24000/65536 = 36.6%, tasks 1/8 = 12.5%.
  assert.equal(summary.bottleneck, 'cpu');
  // headroom: min(floor(10/2)=5, floor(41536/4096)=10, 7) = 5.
  assert.equal(summary.mediumTasksHeadroom, 5);
  const node = alloc.snapshot.nodes.find((n) => n.nodeId === 'n1');
  const free = fleetV17NodeFree(node);
  assert.equal(free.maxTasks, 4 - node.runningTaskIds.length);
});

test('fleetV17 capacity: empty fleet reports zeros and bottleneck none', () => {
  const summary = summarizeFleetV17Capacity(createFleetV14Snapshot(T0));
  assert.equal(summary.nodeCount, 0);
  assert.equal(summary.bottleneck, 'none');
  assert.equal(summary.mediumTasksHeadroom, 0);
});

// ---------------------------------------------------------------------------
// Labels / taints
// ---------------------------------------------------------------------------

test('fleetV17 labels: validate key/value and max count', () => {
  assert.equal(validateFleetV17Labels({ gpu: 'true', zone: 'a' }), '');
  assert.notEqual(validateFleetV17Labels({ 'Bad Key': 'x' }), '');
  assert.notEqual(validateFleetV17Labels({ gpu: 'bad value!' }), '');
  const tooMany = {};
  for (let i = 0; i < FLEET_V17_MAX_LABELS_PER_NODE + 1; i++) tooMany[`k${i}`] = 'v';
  assert.notEqual(validateFleetV17Labels(tooMany), '');
  assert.equal(fleetV17NodeMatchesLabels({ gpu: 'true', zone: 'a' }, { gpu: 'true' }), true);
  assert.equal(fleetV17NodeMatchesLabels({ gpu: 'true' }, { gpu: 'false' }), false);
});

test('fleetV17 taints: validate, tolerate, block, penalty', () => {
  const taint = { key: 'gpu', value: 'reserved', effect: 'NoSchedule' };
  assert.equal(validateFleetV17Taint(taint), '');
  assert.notEqual(validateFleetV17Taint({ key: 'gpu', value: 'x', effect: 'Bogus' }), '');
  assert.equal(fleetV17Tolerates(taint, [{ key: 'gpu', value: '', effect: '' }]), true);
  assert.equal(fleetV17Tolerates(taint, [{ key: 'gpu', value: 'other', effect: '' }]), false);
  assert.equal(fleetV17Tolerates(taint, [{ key: 'gpu', value: 'reserved', effect: 'NoExecute' }]), false);
  const blocked = fleetV17NodeToleratesTask([taint], []);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockingTaints.length, 1);
  const prefer = { key: 'spot', value: 'true', effect: 'PreferNoSchedule' };
  assert.equal(fleetV17NodeToleratesTask([prefer], []).allowed, true);
  assert.equal(fleetV17TaintPenalty([prefer], []), 0.25);
  assert.equal(fleetV17TaintPenalty([prefer], [{ key: 'spot', value: '', effect: '' }]), 0);
});

// ---------------------------------------------------------------------------
// Drain plan
// ---------------------------------------------------------------------------

test('fleetV17 drain: tasks move to least-loaded fitting node', () => {
  let snap = twoNodeFleet();
  const a = allocateFleetV14Task(snap, makeTask('t1', { cpuCores: 1, ramMb: 1000 }), T0);
  assert.equal(a.ok, true, a.reason);
  snap = a.snapshot;
  // t1 allocated to n1 (first node). Drain n1 -> must move to n2.
  const plan = planFleetV17Drain(snap, 'n1', {}, {}, T0);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].taskId, 't1');
  assert.equal(plan.moves[0].fromNodeId, 'n1');
  assert.equal(plan.moves[0].toNodeId, 'n2');
  assert.equal(plan.unmovable.length, 0);
  assert.equal(plan.readyToComplete, true);
});

test('fleetV17 drain: label + taint respected, unmovable listed', () => {
  let snap = twoNodeFleet();
  const a = allocateFleetV14Task(
    snap,
    makeTask('tgpu', { cpuCores: 1, ramMb: 1000, requiredLabels: { gpu: 'true' } }),
    T0,
  );
  assert.equal(a.ok, true, a.reason);
  snap = a.snapshot;
  // n2 has no gpu label; n1 is the source -> no destination.
  const plan = planFleetV17Drain(snap, 'n1', {}, {}, T0);
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.unmovable.length, 1);
  assert.equal(plan.unmovable[0].taskId, 'tgpu');
  assert.equal(plan.readyToComplete, false);
  // Taint NoSchedule on n2 blocks a task without toleration.
  let snap2 = twoNodeFleet();
  const b = allocateFleetV14Task(snap2, makeTask('t2', { cpuCores: 1, ramMb: 1000 }), T0);
  assert.equal(b.ok, true, b.reason);
  snap2 = b.snapshot;
  const taints = { n2: [{ key: 'maint', value: 'yes', effect: 'NoSchedule' }] };
  const blocked = planFleetV17Drain(snap2, 'n1', taints, {}, T0);
  assert.equal(blocked.unmovable.length, 1);
  const tolerated = planFleetV17Drain(
    snap2, 'n1', taints, { t2: [{ key: 'maint', value: '', effect: '' }] }, T0,
  );
  assert.equal(tolerated.moves.length, 1);
  assert.equal(tolerated.moves[0].toNodeId, 'n2');
});

test('fleetV17 drain: unknown node returns empty plan', () => {
  const snap = twoNodeFleet();
  const plan = planFleetV17Drain(snap, 'nope', {}, {}, T0);
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.readyToComplete, false);
});

test('fleetV17 NoExecute evictions list untolerated running tasks', () => {
  let snap = twoNodeFleet();
  const a = allocateFleetV14Task(snap, makeTask('t1'), T0);
  assert.equal(a.ok, true, a.reason);
  snap = a.snapshot;
  const nodeId = snap.tasks[0].nodeId;
  const taints = { [nodeId]: [{ key: 'drain', value: 'now', effect: 'NoExecute' }] };
  const evictions = fleetV17NoExecuteEvictions(snap, taints, {});
  assert.equal(evictions.length, 1);
  assert.equal(evictions[0].taskId, 't1');
  const tolerated = fleetV17NoExecuteEvictions(
    snap, taints, { t1: [{ key: 'drain', value: '', effect: '' }] },
  );
  assert.equal(tolerated.length, 0);
});

// ---------------------------------------------------------------------------
// Auto-scale
// ---------------------------------------------------------------------------

function scaleRule(over = {}) {
  return {
    ruleId: 'r1', name: 'cpu-scale', metric: 'cpu',
    thresholdUp: 0.8, thresholdDown: 0.2, durationMs: 5 * MIN,
    scaleUpBy: 1, scaleDownBy: 1, minNodes: 1, maxNodes: 5,
    cooldownMs: 10 * MIN, enabled: true, ...over,
  };
}

function summaryWithCpu(usedFraction, nodes = 2) {
  return {
    nodeCount: nodes, activeNodeCount: nodes,
    totalCpuCores: 16, freeCpuCores: 16 * (1 - usedFraction),
    totalRamMb: 65536, freeRamMb: 32768,
    totalDiskMb: 1000000, freeTaskSlots: 6, totalTaskSlots: 8,
    runningTasks: 2, bottleneck: 'cpu', bottleneckUsage: usedFraction,
    mediumTasksHeadroom: 2,
  };
}

function samples(value, count, startAt) {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ at: startAt + i * MIN, value });
  return out;
}

test('fleetV17 auto-scale: sustained high cpu scales up', () => {
  const rule = scaleRule();
  const decision = evaluateFleetV17ScaleRule(
    rule, summaryWithCpu(0.9), samples(0.9, 6, T0), null, T0 + 5 * MIN,
  );
  assert.equal(decision.direction, 'up');
  assert.equal(decision.by, 1);
  assert.equal(decision.metricValue, 0.9);
});

test('fleetV17 auto-scale: sustained low cpu scales down, floored by minNodes', () => {
  const rule = scaleRule();
  const decision = evaluateFleetV17ScaleRule(
    rule, summaryWithCpu(0.1), samples(0.1, 6, T0), null, T0 + 5 * MIN,
  );
  assert.equal(decision.direction, 'down');
  const atMin = evaluateFleetV17ScaleRule(
    rule, summaryWithCpu(0.1, 1), samples(0.1, 6, T0), null, T0 + 5 * MIN,
  );
  assert.equal(atMin.direction, 'none');
  assert.ok(atMin.reason.includes('minNodes'));
});

test('fleetV17 auto-scale: cooldown, disabled, maxNodes, mixed samples block', () => {
  const rule = scaleRule();
  const cooling = evaluateFleetV17ScaleRule(
    rule, summaryWithCpu(0.9), samples(0.9, 6, T0), T0 + 4 * MIN, T0 + 5 * MIN,
  );
  assert.equal(cooling.direction, 'none');
  assert.ok(cooling.reason.includes('cooldown'));
  const disabled = evaluateFleetV17ScaleRule(
    scaleRule({ enabled: false }), summaryWithCpu(0.9), samples(0.9, 6, T0), null, T0 + 5 * MIN,
  );
  assert.equal(disabled.direction, 'none');
  const atMax = evaluateFleetV17ScaleRule(
    rule, summaryWithCpu(0.9, 5), samples(0.9, 6, T0), null, T0 + 5 * MIN,
  );
  assert.equal(atMax.direction, 'none');
  assert.ok(atMax.reason.includes('maxNodes'));
  const mixed = evaluateFleetV17ScaleRule(
    rule, summaryWithCpu(0.9),
    [...samples(0.9, 3, T0), ...samples(0.5, 3, T0 + 3 * MIN)], null, T0 + 5 * MIN,
  );
  assert.equal(mixed.direction, 'none');
  const noSamples = evaluateFleetV17ScaleRule(rule, summaryWithCpu(0.9), [], null, T0 + 5 * MIN);
  assert.equal(noSamples.direction, 'none');
});

test('fleetV17 auto-scale: validate rejects bad rule', () => {
  assert.notEqual(validateFleetV17ScaleRule(scaleRule({ thresholdDown: 0.9 })), '');
  assert.notEqual(validateFleetV17ScaleRule(scaleRule({ maxNodes: 0 })), '');
  assert.notEqual(validateFleetV17ScaleRule(scaleRule({ scaleUpBy: 0 })), '');
  assert.equal(validateFleetV17ScaleRule(scaleRule()), '');
});
