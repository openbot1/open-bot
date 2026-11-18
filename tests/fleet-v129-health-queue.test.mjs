/**
 * Fleet health + job queue v19 tests (v1.29, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Health history: append keeps window + max samples (no mutate); points
 *   from v17 checks; stats (avg/min/max/stddev/uptime/level changes/
 *   flapping/trend via slope); empty history stats; slope null with < 2 points.
 * - Fleet score: task-weighted score, health distribution, worst/best node,
 *   empty fleet reports 100 with 0 nodes.
 * - Alerts: rule evaluation (score-below, fail-streak, flapping,
 *   degrading-trend, node-down, fleet-score-below, disabled rule skipped,
 *   node filter); raise dedupe + cooldown retrigger; ack/resolve;
 *   auto-resolve; open list ordering (critical first); summary counts.
 * - Job queue: enqueue + duplicate jobId throws + idempotency returns old
 *   job; effective priority with aging (capped at 9); peek order
 *   (priority, then FIFO); start/complete; fail -> retry with backoff then
 *   dead after maxAttempts; promote retries only after backoff; cancel;
 *   kill running -> dead; requeue dead resets attempts; remove finished only.
 * - Placement: node blocked reasons (not active, labels, taints, resources,
 *   slots); least-loaded pick; no node -> null + reasons.
 * - Queue stats: byStatus, queuedByPriority, waits, doneLastHour, ETA null
 *   without throughput; dead list newest first.
 *
 * Imports the BUILT core — build first:
 *   ./node_modules/.bin/tsc -p packages/core/tsconfig.json
 * then: node --test tests/fleet-v129-health-queue.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V19_ALERT_COOLDOWN_MS,
  appendFleetV19HealthPoint,
  autoResolveFleetV19Alerts,
  ackFleetV19Alert,
  createFleetV19AlertStore,
  emptyFleetV19NodeStats,
  evaluateFleetV19AlertRules,
  fleetV19PointFromV17Check,
  fleetV19SlopePerMin,
  listFleetV19OpenAlerts,
  raiseFleetV19Alerts,
  resolveFleetV19Alert,
  summarizeFleetV19NodeHistory,
  summarizeFleetV19Score,
  summarizeFleetV19Alerts,
  validateFleetV19HealthPoint,
} from '../packages/core/dist/fleetV19/fleetHealthV19.js';

import {
  cancelFleetV19Job,
  completeFleetV19Job,
  createFleetV19JobQueue,
  enqueueFleetV19Job,
  failFleetV19Job,
  fleetV19EffectivePriority,
  fleetV19NodeBlockedReason,
  fleetV19NodeLoad,
  fleetV19RetryBackoffMs,
  killFleetV19Job,
  listFleetV19DeadJobs,
  peekFleetV19NextJob,
  pickFleetV19NodeForJob,
  promoteFleetV19Retries,
  removeFleetV19Job,
  requeueFleetV19DeadJob,
  startFleetV19Job,
  summarizeFleetV19Queue,
} from '../packages/core/dist/fleetV19/jobQueueV19.js';

const T0 = Date.UTC(2026, 11, 17, 0, 0, 0);
const MIN = 60 * 1000;

function point(nodeId, score, health, at, failures = 0) {
  return { nodeId, score, health, consecutiveFailures: failures, at };
}

function statsFor(nodeId, scores, at = T0) {
  const points = scores.map((s, i) => point(nodeId, s, s >= 80 ? 'healthy' : s >= 50 ? 'degraded' : 'unhealthy', at + i * MIN));
  return summarizeFleetV19NodeHistory(nodeId, points);
}

// ---------------------------------------------------------------------------
// Health history + stats
// ---------------------------------------------------------------------------

test('health v19: append keeps window and max samples, does not mutate', () => {
  const h0 = {};
  const h1 = appendFleetV19HealthPoint(h0, point('n1', 90, 'healthy', T0));
  assert.equal(h0['n1'], undefined);
  assert.equal(h1['n1'].length, 1);
  let h = h1;
  for (let i = 1; i < 10; i++) {
    h = appendFleetV19HealthPoint(h, point('n1', 90 - i, 'healthy', T0 + i * MIN), { maxSamples: 3 });
  }
  assert.equal(h['n1'].length, 3);
  assert.equal(h['n1'][2].score, 81);
  // Window: points older than windowMs before the newest are dropped.
  const h2 = appendFleetV19HealthPoint(h, point('n1', 50, 'degraded', T0 + 10 * 60 * MIN), { windowMs: 5 * MIN });
  assert.equal(h2['n1'].length, 1);
});

test('health v19: validate rejects bad point', () => {
  assert.notEqual(validateFleetV19HealthPoint(point('', 90, 'healthy', T0)), '');
  assert.notEqual(validateFleetV19HealthPoint(point('n1', 101, 'healthy', T0)), '');
  assert.notEqual(validateFleetV19HealthPoint(point('n1', 90, 'bogus', T0)), '');
  assert.equal(validateFleetV19HealthPoint(point('n1', 90, 'healthy', T0)), '');
  assert.throws(() => appendFleetV19HealthPoint({}, point('n1', -1, 'healthy', T0)), /score/);
});

test('health v19: point from v17 check keeps fields', () => {
  const check = { nodeId: 'n1', health: 'degraded', score: 62, consecutiveFailures: 2, lastFailedProbe: null, reasons: ['liveness fail'], at: T0 };
  assert.deepEqual(fleetV19PointFromV17Check(check), {
    nodeId: 'n1', score: 62, health: 'degraded', consecutiveFailures: 2, at: T0,
  });
});

test('health v19: stats avg/min/max/uptime/level changes', () => {
  const stats = summarizeFleetV19NodeHistory('n1', [
    point('n1', 100, 'healthy', T0),
    point('n1', 80, 'healthy', T0 + MIN),
    point('n1', 40, 'unhealthy', T0 + 2 * MIN),
    point('n1', 90, 'healthy', T0 + 3 * MIN),
  ]);
  assert.equal(stats.samples, 4);
  assert.equal(stats.avgScore, 77.5);
  assert.equal(stats.minScore, 40);
  assert.equal(stats.maxScore, 100);
  assert.equal(stats.uptimePct, 75);
  assert.equal(stats.levelChanges, 2);
  assert.equal(stats.latestHealth, 'healthy');
  assert.equal(stats.windowStartAt, T0);
  assert.equal(stats.windowEndAt, T0 + 3 * MIN);
});

test('health v19: empty history stats are nulls + unknown trend', () => {
  const stats = emptyFleetV19NodeStats('n9');
  assert.equal(stats.samples, 0);
  assert.equal(stats.avgScore, null);
  assert.equal(stats.trend, 'unknown');
  assert.equal(stats.flapping, false);
  assert.deepEqual(summarizeFleetV19NodeHistory('n9', []), stats);
});

test('health v19: trend degrading on falling scores, improving on rising, volatile on swings', () => {
  const falling = summarizeFleetV19NodeHistory('n1', [100, 90, 80, 70, 60].map((s, i) => point('n1', s, 'healthy', T0 + i * MIN)));
  assert.equal(falling.trend, 'degrading');
  assert.ok((falling.slopePerMin ?? 0) < 0);
  const rising = summarizeFleetV19NodeHistory('n1', [60, 70, 80, 90, 100].map((s, i) => point('n1', s, 'healthy', T0 + i * MIN)));
  assert.equal(rising.trend, 'improving');
  const swing = summarizeFleetV19NodeHistory('n1', [
    point('n1', 100, 'healthy', T0),
    point('n1', 20, 'unhealthy', T0 + MIN),
    point('n1', 100, 'healthy', T0 + 2 * MIN),
    point('n1', 20, 'unhealthy', T0 + 3 * MIN),
    point('n1', 100, 'healthy', T0 + 4 * MIN),
  ]);
  assert.equal(swing.trend, 'volatile');
  assert.equal(swing.flapping, true);
  assert.equal(fleetV19SlopePerMin([point('n1', 50, 'healthy', T0)]), null);
  assert.equal(fleetV19SlopePerMin([]), null);
});

// ---------------------------------------------------------------------------
// Fleet score
// ---------------------------------------------------------------------------

test('health v19: fleet score is task-weighted with distribution', () => {
  const stats = new Map([
    ['a', statsFor('a', [90, 92])],
    ['b', statsFor('b', [60, 62])],
    ['c', statsFor('c', [100])],
  ]);
  const score = summarizeFleetV19Score(stats, new Map([['a', 4], ['b', 0], ['c', 1]]), T0);
  assert.equal(score.nodeCount, 3);
  assert.equal(score.byHealth.healthy, 2);
  assert.equal(score.byHealth.degraded, 1);
  assert.equal(score.worstNodeId, 'b');
  assert.equal(score.bestNodeId, 'c');
  assert.equal(score.weightedNodeCount, 2);
  // Weighted on LATEST scores: a(92*5) + b(62*1) + c(100*2) = 722 / 8 = 90.25 -> 90.3
  assert.equal(score.score, 90.3);
  const empty = summarizeFleetV19Score(new Map(), new Map(), T0);
  assert.equal(empty.score, 100);
  assert.equal(empty.nodeCount, 0);
  assert.equal(empty.healthyPct, 100);
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

function alertInput() {
  const stats = new Map([
    ['a', statsFor('a', [40, 42])],
    ['b', statsFor('b', [95, 96])],
  ]);
  const fleetScore = summarizeFleetV19Score(stats, new Map(), T0);
  return { statsByNode: stats, fleetScore, failStreakByNode: new Map([['a', 3], ['b', 0]]), at: T0 };
}

test('health v19: alert rules evaluate each kind, disabled skipped, node filter honored', () => {
  const input = alertInput();
  const rules = [
    { id: 'r-score', kind: 'score-below', level: 'warning', threshold: 50, enabled: true, cooldownMs: null, nodeIds: [] },
    { id: 'r-streak', kind: 'fail-streak', level: 'critical', threshold: 3, enabled: true, cooldownMs: null, nodeIds: [] },
    { id: 'r-down', kind: 'node-down', level: 'critical', threshold: 1, enabled: true, cooldownMs: null, nodeIds: [] },
    { id: 'r-fleet', kind: 'fleet-score-below', level: 'warning', threshold: 90, enabled: true, cooldownMs: null, nodeIds: [] },
    { id: 'r-off', kind: 'score-below', level: 'critical', threshold: 99, enabled: false, cooldownMs: null, nodeIds: [] },
    { id: 'r-filtered', kind: 'score-below', level: 'warning', threshold: 50, enabled: true, cooldownMs: null, nodeIds: ['zzz'] },
  ];
  const triggers = evaluateFleetV19AlertRules(rules, input);
  const keys = triggers.map((t) => `${t.rule.id}:${t.nodeId}`);
  assert.ok(keys.includes('r-score:a'));
  assert.ok(keys.includes('r-streak:a'));
  assert.ok(!keys.includes('r-down:a'));
  assert.ok(keys.includes('r-fleet:'));
  assert.ok(!keys.some((k) => k.startsWith('r-off')));
  assert.ok(!keys.some((k) => k.startsWith('r-filtered')));
});

test('health v19: alert lifecycle raise/dedupe/cooldown/ack/resolve/auto-resolve', () => {
  const input = alertInput();
  const rule = { id: 'r-score', kind: 'score-below', level: 'warning', threshold: 50, enabled: true, cooldownMs: 10 * MIN, nodeIds: [] };
  const triggers = evaluateFleetV19AlertRules([rule], input);
  assert.equal(triggers.length, 1);
  let store = createFleetV19AlertStore();
  store = raiseFleetV19Alerts(store, triggers, T0);
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].status, 'open');
  // Same trigger inside cooldown: no new alert, no retrigger count bump.
  store = raiseFleetV19Alerts(store, triggers, T0 + MIN);
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].retriggerCount, 0);
  // After cooldown: retrigger count bumps, still one alert.
  store = raiseFleetV19Alerts(store, triggers, T0 + 11 * MIN);
  assert.equal(store.alerts[0].retriggerCount, 1);
  const alertId = store.alerts[0].id;
  store = ackFleetV19Alert(store, alertId, 'u_admin', T0 + 12 * MIN);
  assert.equal(store.alerts[0].status, 'acked');
  assert.equal(store.alerts[0].ackedBy, 'u_admin');
  // Ack twice / ack resolved is a no-op for status.
  store = resolveFleetV19Alert(store, alertId, T0 + 13 * MIN);
  assert.equal(store.alerts[0].status, 'resolved');
  const afterAck = ackFleetV19Alert(store, alertId, 'u_admin', T0 + 14 * MIN);
  assert.equal(afterAck.alerts[0].status, 'resolved');
  // Auto-resolve: open alert whose condition cleared resolves.
  let store2 = raiseFleetV19Alerts(createFleetV19AlertStore(), triggers, T0);
  const res = autoResolveFleetV19Alerts(store2, [], T0 + MIN);
  assert.equal(res.resolvedCount, 1);
  assert.equal(res.store.alerts[0].status, 'resolved');
  store2 = res.store;
  const res2 = autoResolveFleetV19Alerts(store2, triggers, T0 + 2 * MIN);
  assert.equal(res2.resolvedCount, 0);
  void FLEET_V19_ALERT_COOLDOWN_MS;
});

test('health v19: open alerts sorted critical first, summary counts', () => {
  let store = createFleetV19AlertStore();
  const mk = (id, level) => ({
    rule: { id, kind: 'score-below', level, threshold: 50, enabled: true, cooldownMs: null, nodeIds: [] },
    nodeId: `n-${id}`,
    message: id,
  });
  store = raiseFleetV19Alerts(store, [mk('w1', 'warning'), mk('c1', 'critical'), mk('i1', 'info')], T0);
  const open = listFleetV19OpenAlerts(store);
  assert.deepEqual(open.map((a) => a.level), ['critical', 'warning', 'info']);
  const summary = summarizeFleetV19Alerts(store);
  assert.equal(summary.open, 3);
  assert.equal(summary.byLevel.critical, 1);
  store = resolveFleetV19Alert(store, open[2].id, T0 + MIN);
  assert.equal(summarizeFleetV19Alerts(store).resolved, 1);
});

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

function task(id, over = {}) {
  return {
    taskId: id, kind: 'run-bot', cpuCores: 1, ramMb: 1000, vramMb: 0,
    priority: 1, requiredLabels: {}, allowedNodeIds: [], createdBy: 'u_owner', createdAt: T0, ...over,
  };
}

function node(id, over = {}) {
  return {
    nodeId: id, hostname: `${id}.local`, fingerprint: `fp-${id}`, labels: {},
    capacity: { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 0, diskTotalMb: 500000, maxTasks: 4 },
    status: 'active', health: 'healthy', lastHeartbeatAt: T0, registeredAt: T0,
    drainStartedAt: null, maintenanceReason: '', usedRamMb: 0, usedVramMb: 0,
    usedCpuCores: 0, runningTaskIds: [], ...over,
  };
}

test('queue v19: enqueue, duplicate jobId throws, idempotency returns old job', () => {
  let q = createFleetV19JobQueue();
  const r1 = enqueueFleetV19Job(q, { jobId: 'j1', task: task('t1'), priority: 5, idempotencyKey: 'k1' }, T0);
  q = r1.queue;
  assert.equal(r1.duplicate, false);
  assert.equal(r1.job.status, 'queued');
  assert.throws(() => enqueueFleetV19Job(q, { jobId: 'j1', task: task('t1'), priority: 5 }, T0), /đã tồn tại/);
  const r2 = enqueueFleetV19Job(q, { jobId: 'j2', task: task('t2'), priority: 1, idempotencyKey: 'k1' }, T0);
  assert.equal(r2.duplicate, true);
  assert.equal(r2.job.jobId, 'j1');
  assert.equal(r2.queue.jobs.length, 1);
  assert.throws(
    () => enqueueFleetV19Job(q, { jobId: 'j3', task: task('t3'), priority: 99 }, T0),
    /priority/,
  );
});

test('queue v19: peek order is effective priority then FIFO; aging caps at 9', () => {
  let q = createFleetV19JobQueue();
  q = enqueueFleetV19Job(q, { jobId: 'low-old', task: task('t1'), priority: 1 }, T0).queue;
  q = enqueueFleetV19Job(q, { jobId: 'high-new', task: task('t2'), priority: 8 }, T0 + MIN).queue;
  q = enqueueFleetV19Job(q, { jobId: 'low-new', task: task('t3'), priority: 1 }, T0 + MIN).queue;
  assert.equal(peekFleetV19NextJob(q, T0 + MIN)?.jobId, 'high-new');
  // After 20 min the old low job ages: 1 + 20*0.5 = 11 -> capped 9, beats priority 8.
  assert.equal(peekFleetV19NextJob(q, T0 + 20 * MIN)?.jobId, 'low-old');
  const lowOld = q.jobs.find((j) => j.jobId === 'low-old');
  assert.equal(fleetV19EffectivePriority(lowOld, T0 + 20 * MIN), 9);
  assert.equal(fleetV19EffectivePriority(lowOld, T0), 1);
  assert.equal(peekFleetV19NextJob(createFleetV19JobQueue(), T0), null);
});

test('queue v19: start/complete happy path, wrong-state transitions throw', () => {
  let q = enqueueFleetV19Job(createFleetV19JobQueue(), { jobId: 'j1', task: task('t1'), priority: 5 }, T0).queue;
  assert.throws(() => completeFleetV19Job(q, 'j1', T0), /running/);
  q = startFleetV19Job(q, 'j1', 'node-a', T0 + MIN);
  assert.equal(q.jobs[0].status, 'running');
  assert.equal(q.jobs[0].attempts, 1);
  assert.equal(q.jobs[0].nodeId, 'node-a');
  assert.throws(() => startFleetV19Job(q, 'j1', 'node-a', T0 + MIN), /queued/);
  q = completeFleetV19Job(q, 'j1', T0 + 2 * MIN);
  assert.equal(q.jobs[0].status, 'done');
});

test('queue v19: fail retries with backoff then dead after maxAttempts', () => {
  assert.equal(fleetV19RetryBackoffMs(1), 30000 + 3000); // 30s + 10% jitter (odd attempt)
  assert.equal(fleetV19RetryBackoffMs(2), 60000); // 60s, no jitter (even attempt)
  assert.ok(fleetV19RetryBackoffMs(10) <= 30 * 60 * 1000 + 30 * 60 * 100);
  let q = enqueueFleetV19Job(createFleetV19JobQueue(), { jobId: 'j1', task: task('t1'), priority: 5, maxAttempts: 2 }, T0).queue;
  q = startFleetV19Job(q, 'j1', 'node-a', T0);
  q = failFleetV19Job(q, 'j1', 'boom', T0 + MIN);
  assert.equal(q.jobs[0].status, 'retrying');
  assert.equal(q.jobs[0].readyAt, T0 + MIN + 33000);
  // Promote before backoff expires: stays retrying.
  let promoted = promoteFleetV19Retries(q, T0 + MIN + 1000);
  assert.equal(promoted.promotedCount, 0);
  promoted = promoteFleetV19Retries(q, T0 + MIN + 33000);
  assert.equal(promoted.promotedCount, 1);
  q = promoted.queue;
  assert.equal(q.jobs[0].status, 'queued');
  q = startFleetV19Job(q, 'j1', 'node-a', T0 + 2 * MIN);
  q = failFleetV19Job(q, 'j1', 'boom again', T0 + 3 * MIN);
  assert.equal(q.jobs[0].status, 'dead'); // attempts(2) == maxAttempts(2)
  assert.equal(q.jobs[0].lastError, 'boom again');
  // Requeue resets attempts; remove only works on finished jobs.
  q = requeueFleetV19DeadJob(q, 'j1', T0 + 4 * MIN);
  assert.equal(q.jobs[0].status, 'queued');
  assert.equal(q.jobs[0].attempts, 0);
  assert.equal(q.jobs[0].requeueCount, 1);
  q = startFleetV19Job(q, 'j1', 'node-a', T0 + 5 * MIN);
  assert.throws(() => removeFleetV19Job(q, 'j1'), /đang hoạt động/);
  q = killFleetV19Job(q, 'j1', 'operator kill', T0 + 6 * MIN);
  assert.equal(q.jobs[0].status, 'dead');
  q = removeFleetV19Job(q, 'j1');
  assert.equal(q.jobs.length, 0);
});

test('queue v19: cancel queued/retrying, cancel running throws', () => {
  let q = enqueueFleetV19Job(createFleetV19JobQueue(), { jobId: 'j1', task: task('t1'), priority: 5 }, T0).queue;
  q = enqueueFleetV19Job(q, { jobId: 'j2', task: task('t2'), priority: 5 }, T0).queue;
  q = startFleetV19Job(q, 'j2', 'node-a', T0);
  assert.throws(() => cancelFleetV19Job(q, 'j2', 'nope', T0), /không hủy được/);
  q = cancelFleetV19Job(q, 'j1', 'user cancelled', T0 + MIN);
  assert.equal(q.jobs.find((j) => j.jobId === 'j1')?.status, 'cancelled');
});

test('queue v19: placement blocks on status/labels/taints/resources/slots, picks least-loaded', () => {
  const busy = node('busy', { runningTaskIds: ['x', 'y', 'z'], usedCpuCores: 7, usedRamMb: 30000 });
  const idle = node('idle', { labels: { gpu: 'true' } });
  const draining = node('draining', { status: 'draining' });
  const job = enqueueFleetV19Job(createFleetV19JobQueue(), {
    jobId: 'j1',
    task: task('t1', { requiredLabels: { gpu: 'true' }, cpuCores: 2, ramMb: 2000 }),
    priority: 5,
  }, T0).queue.jobs[0];
  assert.notEqual(fleetV19NodeBlockedReason(draining, job.task, [], []), '');
  assert.notEqual(fleetV19NodeBlockedReason(busy, job.task, [], []), '');
  assert.equal(fleetV19NodeBlockedReason(idle, job.task, [], []), '');
  // Taint blocks when the task has no toleration; toleration allows it.
  const taint = { key: 'gpu', value: 'reserved', effect: 'NoSchedule' };
  assert.notEqual(fleetV19NodeBlockedReason(idle, job.task, [taint], []), '');
  assert.equal(fleetV19NodeBlockedReason(idle, job.task, [taint], [{ key: 'gpu', value: '', effect: '' }]), '');
  // Least-loaded pick: idle (load 0) beats busy; with only busy nodes -> null + reasons.
  const picked = pickFleetV19NodeForJob(job, [busy, idle, draining], new Map(), []);
  assert.equal(picked.node?.nodeId, 'idle');
  const none = pickFleetV19NodeForJob(job, [busy, draining], new Map(), []);
  assert.equal(none.node, null);
  assert.ok(none.blockedReasons.length >= 2);
  assert.ok(fleetV19NodeLoad(idle) < fleetV19NodeLoad(busy));
});

test('queue v19: stats by status/priority, waits, ETA null without throughput', () => {
  let q = createFleetV19JobQueue();
  q = enqueueFleetV19Job(q, { jobId: 'j1', task: task('t1'), priority: 2 }, T0).queue;
  q = enqueueFleetV19Job(q, { jobId: 'j2', task: task('t2'), priority: 9 }, T0 + MIN).queue;
  const stats = summarizeFleetV19Queue(q, T0 + 10 * MIN);
  assert.equal(stats.total, 2);
  assert.equal(stats.byStatus.queued, 2);
  assert.equal(stats.queuedByPriority[2], 1);
  assert.equal(stats.queuedByPriority[9], 1);
  assert.equal(stats.oldestWaitMs, 10 * MIN);
  assert.equal(stats.avgWaitMs, Math.round((10 * MIN + 9 * MIN) / 2));
  assert.equal(stats.estimatedWaitMs, null); // no done jobs in the last hour
  assert.equal(stats.doneLastHour, 0);
  // With a done job in the last hour, ETA is estimated.
  q = startFleetV19Job(q, 'j1', 'node-a', T0 + 10 * MIN);
  q = completeFleetV19Job(q, 'j1', T0 + 11 * MIN);
  const stats2 = summarizeFleetV19Queue(q, T0 + 11 * MIN);
  assert.equal(stats2.doneLastHour, 1);
  assert.equal(stats2.estimatedWaitMs, 60 * 60 * 1000); // 1 queued / 1 per hour
  // Dead list newest first.
  let q2 = enqueueFleetV19Job(createFleetV19JobQueue(), { jobId: 'd1', task: task('t1'), priority: 1, maxAttempts: 0 }, T0).queue;
  q2 = enqueueFleetV19Job(q2, { jobId: 'd2', task: task('t2'), priority: 1, maxAttempts: 0 }, T0).queue;
  q2 = startFleetV19Job(q2, 'd1', 'node-a', T0);
  q2 = failFleetV19Job(q2, 'd1', 'x', T0 + MIN);
  q2 = startFleetV19Job(q2, 'd2', 'node-a', T0 + MIN);
  q2 = failFleetV19Job(q2, 'd2', 'x', T0 + 2 * MIN);
  assert.deepEqual(listFleetV19DeadJobs(q2).map((j) => j.jobId), ['d2', 'd1']);
});
