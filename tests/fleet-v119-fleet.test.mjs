/**
 * Fleet v16 tests (v1.19, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Registration tokens: 32-char, one-shot, hostname-bound, TTL.
 * - Node registration: bad/used/expired token rejected, bad labels
 *   / capacity rejected, weight 1..100, node starts `joining`,
 *   weight stored in snapshot.
 * - Health check: fresh heartbeat + clean sample → healthy; stale
 *   heartbeat 60s/5m/15m → degraded/unhealthy/down; never
 *   heartbeat → down; disk < 1GB → unhealthy; missed-heartbeat
 *   counting; stale nodes (>24h down) listed for removal.
 * - Distribution: least-loaded / least-connections / smooth WRR
 *   (weight ratio respected over many picks), ineligible nodes
 *   skipped, distribute spreads tasks, no eligible node → null.
 * - Lifecycle: allowed transitions only, decommission blocked by
 *   running tasks unless forced, summary counts + stale list.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v119-fleet.test.mjs
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
  checkFleetV16NodeHealth,
  createFleetV16RegistrationToken,
  decommissionFleetV16Node,
  distributeFleetV16Tasks,
  fleetV16MissedHeartbeats,
  fleetV16NodeWeight,
  fleetV16StaleNodesToRemove,
  isFleetV16RegistrationTokenValid,
  pickFleetV16NodeForTask,
  registerFleetV16Node,
  summarizeFleetV16,
  transitionFleetV16NodeStatus,
  validateFleetV16NodeCapacity,
  validateFleetV16NodeLabels,
} from '../packages/core/dist/fleetV16/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const MIN = 60 * 1000;

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
    at: T0, cpuFraction: 0.1, ramFraction: 0.1, vramFraction: 0.1,
    diskFreeMb: 100_000, heartbeatAt: T0, recentTaskErrors: 0, ...over,
  };
}

function task(id, over = {}) {
  return {
    taskId: id, kind: 'bot', cpuCores: 1, ramMb: 1024, vramMb: 0,
    priority: 1, requiredLabels: {}, allowedNodeIds: [], createdBy: 'u1', createdAt: T0, ...over,
  };
}

test('fleet v16: registration tokens (one-shot, hostname, TTL)', () => {
  const tok = createFleetV16RegistrationToken('node-a.local', 60 * MIN, T0);
  assert.equal(tok.token.length, 32);
  assert.match(tok.token, /^[0-9a-f]{32}$/);
  assert.equal(tok.used, false);
  assert.equal(isFleetV16RegistrationTokenValid(tok, 'node-a.local', T0), true);
  assert.equal(isFleetV16RegistrationTokenValid(tok, 'other.local', T0), false, 'wrong hostname');
  assert.equal(isFleetV16RegistrationTokenValid(tok, 'node-a.local', T0 + 60 * MIN + 1), false, 'expired');
  assert.equal(isFleetV16RegistrationTokenValid({ ...tok, used: true }, 'node-a.local', T0), false, 'used');
  assert.equal(isFleetV16RegistrationTokenValid(createFleetV16RegistrationToken('', 60 * MIN, T0), 'anything.local', T0), true, 'empty expected hostname = any');
  // Entropy regression: the old hand-rolled LCG overflowed float64
  // and produced ~37% all-zero tokens with few unique values.
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = createFleetV16RegistrationToken('', 60 * MIN, T0).token;
    assert.match(t, /^[0-9a-f]{32}$/);
    assert.notEqual(t, '0'.repeat(32), 'token must not be all zeros');
    seen.add(t);
  }
  assert.ok(seen.size >= 190, `expected ~200 unique tokens, got ${seen.size}`);
});

test('fleet v16: labels + capacity validation', () => {
  assert.equal(validateFleetV16NodeLabels({ region: 'us-east-1', gpu: 'a100' }), '');
  assert.match(validateFleetV16NodeLabels({ 'Bad Key': 'x' }), /nhãn key/);
  assert.match(validateFleetV16NodeLabels({ ok: 'bad value!' }), /nhãn value/);
  assert.match(validateFleetV16NodeLabels({ ok: '' }), /nhãn value/);
  assert.equal(validateFleetV16NodeCapacity(cap()), '');
  assert.match(validateFleetV16NodeCapacity(cap({ cpuCores: 0 })), /cpuCores/);
  assert.match(validateFleetV16NodeCapacity(cap({ ramTotalMb: 1.5 })), /ramTotalMb/);
  assert.match(validateFleetV16NodeCapacity(cap({ vramTotalMb: -1 })), /vramTotalMb/);
  assert.match(validateFleetV16NodeCapacity(cap({ maxTasks: 0 })), /maxTasks/);
});

test('fleet v16: register node with token', () => {
  let snap = createFleetV14Snapshot(T0);
  const tok = createFleetV16RegistrationToken('node-a.local', 60 * MIN, T0);
  const bad = registerFleetV16Node(snap, [tok], {
    nodeId: 'node-a', hostname: 'node-a.local', fingerprint: 'fp-a', labels: {}, capacity: cap(), registrationToken: 'deadbeef'.repeat(4),
  }, T0);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /không tồn tại/);
  assert.equal(bad.snapshot.nodes.length, 0);
  const wrongHost = registerFleetV16Node(snap, [tok], {
    nodeId: 'node-a', hostname: 'other.local', fingerprint: 'fp-a', labels: {}, capacity: cap(), registrationToken: tok.token,
  }, T0);
  assert.equal(wrongHost.ok, false);
  const badWeight = registerFleetV16Node(snap, [tok], {
    nodeId: 'node-a', hostname: 'node-a.local', fingerprint: 'fp-a', labels: {}, capacity: cap(), registrationToken: tok.token, weight: 0,
  }, T0);
  assert.equal(badWeight.ok, false);
  assert.match(badWeight.error, /weight/);
  const ok = registerFleetV16Node(snap, [tok], {
    nodeId: 'node-a', hostname: 'node-a.local', fingerprint: 'fp-a', labels: { region: 'eu' }, capacity: cap(), registrationToken: tok.token, weight: 25,
  }, T0);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.snapshot.nodes[0].status, 'joining');
  assert.equal(ok.token.used, true);
  assert.equal(fleetV16NodeWeight(ok.snapshot, 'node-a'), 25);
  assert.equal(fleetV16NodeWeight(ok.snapshot, 'unknown'), 100, 'default weight');
  // Token is one-shot: second registration with the used token fails.
  const again = registerFleetV16Node(ok.snapshot, [ok.token], {
    nodeId: 'node-b', hostname: 'node-a.local', fingerprint: 'fp-b', labels: {}, capacity: cap(), registrationToken: tok.token,
  }, T0);
  assert.equal(again.ok, false);
});

test('fleet v16: health check (heartbeat staleness + sample)', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a');
  const node = snap.nodes[0];
  const fresh = checkFleetV16NodeHealth(node, sample(), 30 * 1000, T0);
  assert.equal(fresh.health, 'healthy');
  assert.equal(fresh.heartbeatAgeMs, 0);
  assert.equal(fresh.missedHeartbeats, 0);
  assert.deepEqual(fresh.reasons, []);
  // 61s late → degraded; 5m+ → unhealthy; 15m+ → down.
  assert.equal(checkFleetV16NodeHealth(node, sample(), 30 * 1000, T0 + 61 * 1000).health, 'degraded');
  assert.equal(checkFleetV16NodeHealth(node, sample(), 30 * 1000, T0 + 6 * MIN).health, 'unhealthy');
  assert.equal(checkFleetV16NodeHealth(node, sample(), 30 * 1000, T0 + 16 * MIN).health, 'down');
  // Missed heartbeats: 90s late at 30s interval → 3 missed.
  assert.equal(fleetV16MissedHeartbeats(node, 30 * 1000, T0 + 90 * 1000), 3);
  assert.equal(fleetV16MissedHeartbeats(node, 30 * 1000, T0 + 10 * 1000), 0);
  // Never heartbeat → down.
  const never = { ...node, lastHeartbeatAt: null };
  const neverCheck = checkFleetV16NodeHealth(never, sample(), 30 * 1000, T0);
  assert.equal(neverCheck.health, 'down');
  assert.equal(neverCheck.heartbeatAgeMs, null);
  assert.equal(fleetV16MissedHeartbeats(never, 30 * 1000, T0), 0);
  // Sample problems: disk < 1GB → unhealthy even with fresh heartbeat.
  assert.equal(checkFleetV16NodeHealth(node, sample({ diskFreeMb: 512 }), 30 * 1000, T0).health, 'unhealthy');
  // CPU/RAM > 95% → degraded.
  assert.equal(checkFleetV16NodeHealth(node, sample({ cpuFraction: 0.97 }), 30 * 1000, T0).health, 'degraded');
  // Stale node removal: down 24h+ → listed.
  const staleSnap = { ...snap, nodes: [{ ...node, health: 'down', lastHeartbeatAt: T0 - 25 * 60 * MIN }] };
  assert.deepEqual(fleetV16StaleNodesToRemove(staleSnap, T0).map((s) => s.nodeId), ['node-a']);
  const freshSnap = { ...snap, nodes: [{ ...node, health: 'down', lastHeartbeatAt: T0 - 60 * MIN }] };
  assert.deepEqual(fleetV16StaleNodesToRemove(freshSnap, T0), []);
});

test('fleet v16: distribution strategies', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a', { maxTasks: 10 });
  snap = addNode(snap, 'node-b', { maxTasks: 10 });
  // Load node-a with 3 tasks so least-loaded picks node-b.
  for (let i = 0; i < 3; i++) snap = allocateFleetV14Task(snap, task(`t${i}`, { allowedNodeIds: ['node-a'] }), T0).snapshot;
  assert.equal(pickFleetV16NodeForTask(snap, task('nx'), 'least-loaded').nodeId, 'node-b');
  assert.equal(pickFleetV16NodeForTask(snap, task('nx'), 'least-connections').nodeId, 'node-b');
  // WRR with weights 75/25 → over 40 picks, node-a gets ~3x node-b.
  let wSnap = createFleetV14Snapshot(T0);
  wSnap = addNode(wSnap, 'node-a', { maxTasks: 100 });
  wSnap = addNode(wSnap, 'node-b', { maxTasks: 100 });
  wSnap = { ...wSnap, v16Weights: { 'node-a': 75, 'node-b': 25 } };
  let wrr = null;
  const counts = { 'node-a': 0, 'node-b': 0 };
  for (let i = 0; i < 40; i++) {
    const pick = pickFleetV16NodeForTask(wSnap, task(`w${i}`), 'weighted-round-robin', wrr);
    assert.ok(pick.nodeId);
    counts[pick.nodeId]++;
    wrr = pick.wrrState;
  }
  assert.equal(counts['node-a'], 30, `WRR 75/25 over 40 picks, got ${JSON.stringify(counts)}`);
  assert.equal(counts['node-b'], 10);
  // No eligible node (all down) → null.
  const downSnap = { ...snap, nodes: snap.nodes.map((n) => ({ ...n, health: 'down' })) };
  const none = pickFleetV16NodeForTask(downSnap, task('nx'), 'least-loaded');
  assert.equal(none.nodeId, null);
  assert.match(none.reason, /không có node/);
  // Distribute spreads tasks across both nodes instead of piling one.
  let dSnap = createFleetV14Snapshot(T0);
  dSnap = addNode(dSnap, 'node-a', { maxTasks: 10 });
  dSnap = addNode(dSnap, 'node-b', { maxTasks: 10 });
  const dist = distributeFleetV16Tasks(dSnap, [task('d1'), task('d2'), task('d3'), task('d4')], 'least-connections');
  assert.equal(dist.unassigned.length, 0);
  const perNode = {};
  for (const a of dist.assignments) perNode[a.nodeId] = (perNode[a.nodeId] ?? 0) + 1;
  assert.equal(perNode['node-a'], 2);
  assert.equal(perNode['node-b'], 2);
});

test('fleet v16: lifecycle transitions + decommission + summary', () => {
  // Node without heartbeat yet: still `joining` → can go active.
  let raw = createFleetV14Snapshot(T0);
  const reg = registerFleetV14Node(
    raw,
    { nodeId: 'node-j', hostname: 'node-j.local', fingerprint: 'fp-j', labels: {}, capacity: cap() },
    'admin',
    T0,
  );
  assert.equal(reg.ok, true, reg.reason);
  assert.equal(reg.snapshot.nodes[0].status, 'joining');
  const joined = transitionFleetV16NodeStatus(reg.snapshot, 'node-j', 'active', '', T0);
  assert.equal(joined.ok, true, joined.error);
  // joining → removed IS allowed by the transition table (a node
  // that never heartbeated can be dropped); the task guard lives
  // in decommissionFleetV16Node, not here.
  assert.equal(transitionFleetV16NodeStatus(reg.snapshot, 'node-j', 'removed', '', T0).ok, true);

  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a');
  snap = addNode(snap, 'node-b');
  // Heartbeat already moved node-a to active; active → removed is not allowed.
  assert.equal(snap.nodes.find((n) => n.nodeId === 'node-a').status, 'active');
  assert.equal(transitionFleetV16NodeStatus(snap, 'node-a', 'removed', '', T0).ok, false);
  const toDrain = transitionFleetV16NodeStatus(snap, 'node-a', 'draining', '', T0);
  assert.equal(toDrain.ok, true, toDrain.error);
  assert.equal(toDrain.snapshot.nodes.find((n) => n.nodeId === 'node-a').drainStartedAt, T0);
  assert.equal(transitionFleetV16NodeStatus(snap, 'ghost', 'active', '', T0).ok, false);
  // Decommission: node-b has no tasks → ok; node-a with a task → blocked unless forced.
  snap = allocateFleetV14Task(toDrain.snapshot, task('t1', { allowedNodeIds: ['node-a'] }), T0).snapshot;
  // node-a is draining, allocate may have failed; place task directly if needed.
  let withTask = snap;
  if (withTask.nodes.find((n) => n.nodeId === 'node-a').runningTaskIds.length === 0) {
    withTask = { ...snap, nodes: snap.nodes.map((n) => (n.nodeId === 'node-a' ? { ...n, runningTaskIds: ['t1'] } : n)) };
  }
  const blocked = decommissionFleetV16Node(withTask, 'node-a');
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blockingTaskIds, ['t1']);
  const forced = decommissionFleetV16Node(withTask, 'node-a', true);
  assert.equal(forced.ok, true, forced.error);
  assert.equal(forced.snapshot.nodes.find((n) => n.nodeId === 'node-a').status, 'removed');
  assert.deepEqual(forced.blockingTaskIds, ['t1']);
  assert.equal(decommissionFleetV16Node(forced.snapshot, 'node-a').ok, false, 'already removed');
  const sum = summarizeFleetV16(forced.snapshot, T0);
  assert.equal(sum.totalNodes, 2);
  assert.equal(sum.byStatus.removed, 1);
  assert.equal(summarizeFleetV16(createFleetV14Snapshot(T0), T0).averageLoad, 0);
});
