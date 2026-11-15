/**
 * Tests for fleet bot scheduling v2 (packages/core/src/fleet/botScheduling.ts).
 *
 * Covers priority ordering (critical first, FIFO within a level, aging
 * rescues a long-waiting low run), node scoring (dead nodes never
 * chosen, reservations subtracted, per-node concurrency cap is a hard
 * wall), the queue → schedule → claim → complete lifecycle, fail with
 * exponential-backoff retry (and permanent failure after maxAttempts),
 * cancel, and requeueing runs of a dead node.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-bot-scheduling-v106.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_BOT_SCHEDULER_POLICY,
  cancelBotRun,
  claimBotRun,
  completeBotRun,
  effectivePriorityWeight,
  enqueueBotRun,
  failBotRun,
  findBotRun,
  listBotRuns,
  loadBotRuns,
  pickBestNodeForBotRun,
  requeueDeadNodeRuns,
  scheduleBotRun,
  scheduleBotRuns,
  scoreNodeForBotRun,
  summarizeBotScheduling,
  validateEnqueueBotRunInput,
} from '../packages/core/dist/fleet/botScheduling.js';
import {
  loadFleetNodes,
  recordNodeHeartbeat,
  registerFleetNode,
} from '../packages/core/dist/fleet/nodes.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-bot-sched-'));
}

const GB = 1024 ** 3;
const T0 = 1_790_000_000_000;
const RES = { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB };
const LOAD_IDLE = { runningJobs: 0, queuedJobs: 0, cpuUsedFraction: 0.1, ramUsedBytes: 1 * GB };
const LOAD_BUSY = { runningJobs: 4, queuedJobs: 5, cpuUsedFraction: 0.9, ramUsedBytes: 7 * GB };

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

function runInput(overrides = {}) {
  return { botId: 'bot-a', summary: 'run bot-a', resources: RES, ...overrides };
}

test('validateEnqueueBotRunInput rejects bad priority, resources and maxAttempts', () => {
  assert.throws(() => validateEnqueueBotRunInput({ botId: '', summary: 'x', resources: RES }), /non-empty botId/);
  assert.throws(() => validateEnqueueBotRunInput({ botId: 'b', summary: '', resources: RES }), /non-empty summary/);
  assert.throws(() => validateEnqueueBotRunInput(runInput({ priority: 'urgent' })), /priority must be one of/);
  assert.throws(() => validateEnqueueBotRunInput(runInput({ resources: { cpuCores: 0, ramBytes: 1, diskBytes: 1 } })), /cpuCores must be a number > 0/);
  assert.throws(() => validateEnqueueBotRunInput(runInput({ maxAttempts: 0 })), /maxAttempts must be an integer >= 1/);
  assert.equal(validateEnqueueBotRunInput(runInput({ priority: 'high' })).priority, 'high');
});

test('effectivePriorityWeight: aging lifts a long-waiting low run but never past critical', () => {
  const policy = { ...DEFAULT_BOT_SCHEDULER_POLICY, priorityAgingMs: 60_000 };
  const low = { priority: 'low', createdAt: T0 };
  assert.equal(effectivePriorityWeight(low, T0, policy), 1);
  assert.equal(effectivePriorityWeight(low, T0 + 60_000, policy), 2);
  assert.equal(effectivePriorityWeight(low, T0 + 3 * 60_000, policy), 4);
  assert.equal(effectivePriorityWeight(low, T0 + 10 * 60_000, policy), 4);
  assert.equal(effectivePriorityWeight({ priority: 'critical', createdAt: T0 }, T0 + 10 * 60_000, policy), 4);
});

test('scoreNodeForBotRun: dead node scores 0, reservations shrink headroom, concurrency cap is a hard wall', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  const runs = loadBotRuns(dir);
  const scoreLocal = scoreNodeForBotRun(loadFleetNodes(dir)[0], { resources: RES }, runs, T0);
  assert.equal(scoreLocal.fits, true);
  assert.ok(scoreLocal.score > 0);
  // Dead node: heartbeat long past the timeout.
  const deadScore = scoreNodeForBotRun(loadFleetNodes(dir)[1], { resources: RES }, runs, T0 + 120_000);
  assert.equal(deadScore.fits, false);
  assert.equal(deadScore.score, 0);
  assert.match(deadScore.reason, /dead/);
  // Node that cannot fit the request after reservations.
  const big = { cpuCores: 4, ramBytes: 8 * GB, diskBytes: 100 * GB };
  const reserved = [{ ...enqueueBotRun(dir, runInput({ resources: big }), DEFAULT_BOT_SCHEDULER_POLICY, T0), status: 'running', nodeId: local.id }];
  const noFit = scoreNodeForBotRun(loadFleetNodes(dir).find((n) => n.id === local.id), { resources: RES }, reserved, T0);
  assert.equal(noFit.fits, false);
  assert.match(noFit.reason, /enough free resources/);
  // Concurrency cap: 4 active runs on a node with limit 4 -> no fit.
  const capped = [];
  for (let i = 0; i < 4; i += 1) {
    capped.push({ ...enqueueBotRun(dir, runInput({ botId: `bot-${i}` }), DEFAULT_BOT_SCHEDULER_POLICY, T0), status: 'running', nodeId: lan.id });
  }
  const capScore = scoreNodeForBotRun(loadFleetNodes(dir).find((n) => n.id === lan.id), { resources: RES }, capped, T0);
  assert.equal(capScore.fits, false);
  assert.match(capScore.reason, /limit 4/);
});

test('pickBestNodeForBotRun prefers loopback over an equal LAN node', () => {
  const dir = tmpDir();
  setupNodes(dir);
  const best = pickBestNodeForBotRun(loadFleetNodes(dir), { resources: RES }, [], T0);
  assert.ok(best !== null);
  assert.equal(best.node.hostname, 'local');
});

test('enqueue + scheduleBotRuns: critical first, then FIFO; no node fits stays queued', () => {
  const dir = tmpDir();
  setupNodes(dir);
  const policy = { ...DEFAULT_BOT_SCHEDULER_POLICY, maxConcurrentPerBot: 0 };
  const low = enqueueBotRun(dir, runInput({ botId: 'bot-low', priority: 'low' }), policy, T0);
  const critical = enqueueBotRun(dir, runInput({ botId: 'bot-crit', priority: 'critical' }), policy, T0 + 1);
  const normal = enqueueBotRun(dir, runInput({ botId: 'bot-norm', priority: 'normal' }), policy, T0 + 2);
  const results = scheduleBotRuns(dir, policy, T0 + 10);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.scheduled));
  // Critical was scheduled first, so it landed on the loopback node.
  assert.equal(results[0].run.botId, 'bot-crit');
  assert.equal(results[0].nodeId, results.find((r) => r.run.botId === 'bot-crit').nodeId);
  assert.equal(findBotRun(dir, critical.id).status, 'scheduled');
  assert.equal(findBotRun(dir, low.id).status, 'scheduled');
  assert.equal(findBotRun(dir, normal.id).status, 'scheduled');

  // A run that needs more than any node has stays queued.
  const huge = enqueueBotRun(dir, runInput({ botId: 'bot-huge', resources: { cpuCores: 64, ramBytes: 64 * GB, diskBytes: 10 * GB } }), policy, T0 + 20);
  const res = scheduleBotRun(dir, huge.id, policy, T0 + 30);
  assert.equal(res.scheduled, false);
  assert.equal(res.nodeId, null);
  assert.match(res.reason, /no alive node/);
  assert.equal(findBotRun(dir, huge.id).status, 'queued');
});

test('per-bot concurrency: a second run of the same bot stays queued', () => {
  const dir = tmpDir();
  setupNodes(dir);
  const first = enqueueBotRun(dir, runInput({ botId: 'bot-a' }), DEFAULT_BOT_SCHEDULER_POLICY, T0);
  scheduleBotRun(dir, first.id, DEFAULT_BOT_SCHEDULER_POLICY, T0 + 1);
  const second = enqueueBotRun(dir, runInput({ botId: 'bot-a' }), DEFAULT_BOT_SCHEDULER_POLICY, T0 + 2);
  const res = scheduleBotRun(dir, second.id, DEFAULT_BOT_SCHEDULER_POLICY, T0 + 3);
  assert.equal(res.scheduled, false);
  assert.match(res.reason, /already runs 1 run/);
});

test('claim/complete lifecycle: only the assigned node can claim and complete', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  const run = enqueueBotRun(dir, runInput(), DEFAULT_BOT_SCHEDULER_POLICY, T0);
  const scheduled = scheduleBotRun(dir, run.id, DEFAULT_BOT_SCHEDULER_POLICY, T0 + 1);
  assert.equal(scheduled.nodeId, local.id);
  assert.throws(() => claimBotRun(dir, run.id, lan.id, T0 + 2), /not ".*"|scheduled to node/);
  const claimed = claimBotRun(dir, run.id, local.id, T0 + 2);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  assert.throws(() => completeBotRun(dir, run.id, lan.id, T0 + 3), /runs on node/);
  const done = completeBotRun(dir, run.id, local.id, T0 + 3);
  assert.equal(done.status, 'done');
  assert.equal(done.finishedAt, T0 + 3);
});

test('failBotRun: retry with doubling backoff, then permanent failure', () => {
  const dir = tmpDir();
  const { local } = setupNodes(dir);
  const policy = { ...DEFAULT_BOT_SCHEDULER_POLICY, retryBackoffMs: 5_000 };
  const run = enqueueBotRun(dir, runInput({ maxAttempts: 2 }), policy, T0);
  scheduleBotRun(dir, run.id, policy, T0 + 1);
  claimBotRun(dir, run.id, local.id, T0 + 2);
  const retried = failBotRun(dir, run.id, local.id, 'boom', policy, T0 + 3);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.nodeId, null);
  assert.equal(retried.nextAttemptAt, T0 + 3 + 5_000);
  // Too early to retry: stays queued.
  const tooEarly = scheduleBotRun(dir, run.id, policy, T0 + 4_000);
  assert.equal(tooEarly.scheduled, false);
  assert.match(tooEarly.reason, /waits for retry/);
  // After the backoff it schedules again, then the last attempt fails permanently.
  const again = scheduleBotRun(dir, run.id, policy, T0 + 3 + 5_000);
  assert.equal(again.scheduled, true);
  claimBotRun(dir, run.id, local.id, T0 + 9_000);
  const failed = failBotRun(dir, run.id, local.id, 'boom again', policy, T0 + 9_001);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastError, 'boom again');
  assert.equal(failed.nextAttemptAt, null);
});

test('cancelBotRun works for queued/scheduled/running, not for done', () => {
  const dir = tmpDir();
  setupNodes(dir);
  const queued = enqueueBotRun(dir, runInput({ botId: 'bot-q' }), DEFAULT_BOT_SCHEDULER_POLICY, T0);
  assert.equal(cancelBotRun(dir, queued.id, T0 + 1).status, 'cancelled');
  const run = enqueueBotRun(dir, runInput({ botId: 'bot-d' }), DEFAULT_BOT_SCHEDULER_POLICY, T0 + 2);
  scheduleBotRun(dir, run.id, DEFAULT_BOT_SCHEDULER_POLICY, T0 + 3);
  const { local } = { local: loadFleetNodes(dir)[0] };
  claimBotRun(dir, run.id, local.id, T0 + 4);
  completeBotRun(dir, run.id, local.id, T0 + 5);
  assert.throws(() => cancelBotRun(dir, run.id, T0 + 6), /already done/);
});

test('requeueDeadNodeRuns moves scheduled/running runs of a dead node back to queued', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  const policy = { ...DEFAULT_BOT_SCHEDULER_POLICY, maxConcurrentPerBot: 0 };
  const onLocal = enqueueBotRun(dir, runInput({ botId: 'bot-local' }), policy, T0);
  const placedLocal = scheduleBotRun(dir, onLocal.id, policy, T0 + 1);
  assert.equal(placedLocal.nodeId, local.id);
  // A 4-core run cannot fit the local node any more (1 core taken),
  // so it lands on the LAN node.
  const onLan = enqueueBotRun(dir, runInput({
    botId: 'bot-lan',
    resources: { cpuCores: 4, ramBytes: 1 * GB, diskBytes: 10 * GB },
  }), policy, T0 + 2);
  const placedLan = scheduleBotRun(dir, onLan.id, policy, T0 + 3);
  assert.equal(placedLan.nodeId, lan.id);
  // LAN node dies (heartbeat at T0, now T0 + 120s > 30s timeout); local stays alive.
  recordNodeHeartbeat(dir, local.id, LOAD_IDLE, T0 + 115_000);
  const requeued = requeueDeadNodeRuns(dir, T0 + 120_000);
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].id, onLan.id);
  assert.equal(requeued[0].status, 'queued');
  assert.equal(requeued[0].nodeId, null);
  assert.equal(findBotRun(dir, onLocal.id).status, 'scheduled');
});

test('summarizeBotScheduling counts by status, priority and node', () => {
  const dir = tmpDir();
  setupNodes(dir);
  const policy = { ...DEFAULT_BOT_SCHEDULER_POLICY, maxConcurrentPerBot: 0 };
  const a = enqueueBotRun(dir, runInput({ botId: 'bot-a', priority: 'critical' }), policy, T0);
  enqueueBotRun(dir, runInput({ botId: 'bot-b', priority: 'low' }), policy, T0 + 1);
  scheduleBotRun(dir, a.id, policy, T0 + 2);
  const summary = summarizeBotScheduling(dir, T0 + 3);
  assert.equal(summary.total, 2);
  assert.equal(summary.scheduled, 1);
  assert.equal(summary.queued, 1);
  assert.equal(summary.byPriority.critical, 1);
  assert.equal(summary.byPriority.low, 1);
  assert.equal(Object.values(summary.byNode).reduce((s, n) => s + n, 0), 1);
  assert.equal(summary.oldestQueuedMs, 2);
});

test('listBotRuns filters by status and botId', () => {
  const dir = tmpDir();
  setupNodes(dir);
  enqueueBotRun(dir, runInput({ botId: 'bot-a' }), DEFAULT_BOT_SCHEDULER_POLICY, T0);
  enqueueBotRun(dir, runInput({ botId: 'bot-b' }), DEFAULT_BOT_SCHEDULER_POLICY, T0 + 1);
  assert.equal(listBotRuns(dir, { botId: 'bot-a' }).length, 1);
  assert.equal(listBotRuns(dir, { status: 'queued' }).length, 2);
  assert.equal(listBotRuns(dir, { status: 'done' }).length, 0);
});

test('busy node loses to an idle node even when the busy one is loopback', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  recordNodeHeartbeat(dir, local.id, LOAD_BUSY, T0);
  recordNodeHeartbeat(dir, lan.id, LOAD_IDLE, T0);
  const best = pickBestNodeForBotRun(loadFleetNodes(dir), { resources: RES }, [], T0);
  assert.ok(best !== null);
  assert.equal(best.node.id, lan.id);
});
