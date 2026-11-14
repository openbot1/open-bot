/**
 * Tests for fleet dispatch v2 (packages/core/src/fleet/dispatch.ts).
 *
 * Covers job submission/validation, dispatch to the best alive node
 * (dead nodes never chosen), claim/complete/fail/retry lifecycle,
 * reassigning dead-node jobs, work stealing (idle node pulls from a
 * busy node, never from an idle one), and the dispatch summary.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-dispatch-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  cancelJob,
  claimJob,
  completeJob,
  dispatchJob,
  failJob,
  findFleetJob,
  findStealableJobs,
  listFleetJobs,
  loadFleetJobs,
  reassignDeadNodeJobs,
  stealWork,
  submitJob,
  summarizeDispatch,
  validateSubmitJobInput,
} from '../packages/core/dist/fleet/dispatch.js';
import {
  loadFleetNodes,
  recordNodeHeartbeat,
  registerFleetNode,
} from '../packages/core/dist/fleet/nodes.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-dispatch-'));
}

const GB = 1024 ** 3;
const T0 = 1_790_000_000_000;

const RES = { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB };
const LOAD_IDLE = { runningJobs: 0, queuedJobs: 0, cpuUsedFraction: 0.1, ramUsedBytes: 1 * GB };
const LOAD_BUSY = { runningJobs: 4, queuedJobs: 5, cpuUsedFraction: 0.9, ramUsedBytes: 7 * GB };

function jobInput(overrides = {}) {
  return { botId: 'bot-a', kind: 'bot-run', summary: 'run bot-a', resources: RES, ...overrides };
}

function setupNodes(dir) {
  const local = registerFleetNode(dir, {
    hostname: 'local', host: '127.0.0.1', port: 18080, role: 'worker',
    cpuCores: 4, ramBytes: 8 * GB, diskBytes: 100 * GB,
  });
  const lan = registerFleetNode(dir, {
    hostname: 'lan', host: '192.168.1.10', port: 18081, role: 'worker',
    cpuCores: 4, ramBytes: 8 * GB, diskBytes: 100 * GB,
  });
  recordNodeHeartbeat(dir, local.id, LOAD_IDLE, T0);
  recordNodeHeartbeat(dir, lan.id, LOAD_IDLE, T0);
  return { local, lan };
}

// --- validation / submission -------------------------------------------------

test('fleet dispatch: validateSubmitJobInput rejects bad input', () => {
  assert.throws(() => validateSubmitJobInput({}), /botId/);
  assert.throws(() => validateSubmitJobInput(jobInput({ kind: 'teleport' })), /kind/);
  assert.throws(() => validateSubmitJobInput(jobInput({ summary: '' })), /summary/);
  assert.throws(() => validateSubmitJobInput(jobInput({ resources: { cpuCores: 0, ramBytes: 1, diskBytes: 1 } })), /cpuCores/);
  assert.throws(() => validateSubmitJobInput(jobInput({ maxAttempts: 0 })), /maxAttempts/);
  assert.throws(() => validateSubmitJobInput(jobInput({ maxAttempts: 11 })), /maxAttempts/);
});

test('fleet dispatch: submit / find / list / cancel round-trip', () => {
  const dir = tmpDir();
  assert.deepEqual(loadFleetJobs(dir), []);
  const job = submitJob(dir, jobInput(), T0);
  assert.equal(job.id.startsWith('fj-'), true);
  assert.equal(job.status, 'queued');
  assert.equal(job.nodeId, null);
  assert.equal(job.attempts, 0);
  assert.equal(job.maxAttempts, 3);
  assert.equal(job.history[0].event, 'submitted');
  assert.equal(findFleetJob(dir, job.id)?.summary, 'run bot-a');
  assert.equal(findFleetJob(dir, 'fj-nope'), null);
  assert.equal(listFleetJobs(dir).length, 1);
  assert.equal(listFleetJobs(dir, { status: 'running' }).length, 0);
  const cancelled = cancelJob(dir, job.id, T0 + 1000);
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => cancelJob(dir, job.id, T0 + 2000), /only queued jobs can be cancelled/);
  assert.throws(() => submitJob(dir, jobInput({ id: job.id }), T0), /already exists/);
});

// --- dispatch + lifecycle ------------------------------------------------------

test('fleet dispatch: dispatch picks loopback node, claim/complete lifecycle', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  const job = submitJob(dir, jobInput(), T0);
  const result = dispatchJob(dir, job.id, T0 + 1000);
  assert.equal(result.node?.id, local.id, 'loopback node should win over an identical LAN node');
  assert.equal(result.job.nodeId, local.id);
  assert.equal(result.job.status, 'queued');
  assert.equal(result.job.history.at(-1).event, 'dispatched');
  // Wrong node cannot claim; right node can.
  assert.throws(() => claimJob(dir, job.id, lan.id, T0 + 2000), /assigned to node/);
  const claimed = claimJob(dir, job.id, local.id, T0 + 2000);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  assert.throws(() => dispatchJob(dir, job.id, T0 + 3000), /only queued jobs can be dispatched/);
  const done = completeJob(dir, job.id, local.id, T0 + 5000);
  assert.equal(done.status, 'done');
  assert.equal(done.finishedAt, T0 + 5000);
  assert.throws(() => completeJob(dir, job.id, local.id, T0 + 6000), /only running jobs can complete/);
});

test('fleet dispatch: no alive node leaves the job queued', () => {
  const dir = tmpDir();
  const job = submitJob(dir, jobInput(), T0);
  const result = dispatchJob(dir, job.id, T0);
  assert.equal(result.node, null);
  assert.match(result.reason, /no alive node/);
  assert.equal(result.job.status, 'queued');
  assert.equal(result.job.nodeId, null);
  // Claim without dispatch is rejected.
  assert.throws(() => claimJob(dir, job.id, 'fn-nope', T0), /has not been dispatched/);
});

test('fleet dispatch: fail retries until maxAttempts, then failed', () => {
  const dir = tmpDir();
  const { local } = setupNodes(dir);
  const job = submitJob(dir, jobInput({ maxAttempts: 2 }), T0);
  dispatchJob(dir, job.id, T0);
  claimJob(dir, job.id, local.id, T0);
  const retried = failJob(dir, job.id, local.id, 'boom', T0 + 1000);
  assert.equal(retried.status, 'queued', 'first failure requeues (attempt 1/2)');
  assert.equal(retried.lastError, 'boom');
  assert.equal(retried.history.at(-1).event, 'retried');
  claimJob(dir, job.id, local.id, T0 + 2000);
  const failed = failJob(dir, job.id, local.id, 'boom again', T0 + 3000);
  assert.equal(failed.status, 'failed', 'second failure exhausts attempts');
  assert.equal(failed.history.at(-1).event, 'failed');
});

// --- dead nodes -----------------------------------------------------------------

test('fleet dispatch: reassignDeadNodeJobs requeues jobs of dead nodes', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  const jobLocal = submitJob(dir, jobInput({ botId: 'bot-local' }), T0);
  const jobLan = submitJob(dir, jobInput({ botId: 'bot-lan' }), T0);
  dispatchJob(dir, jobLocal.id, T0);
  dispatchJob(dir, jobLan.id, T0);
  // Both went to loopback; move the LAN job onto the LAN node manually
  // by dispatching after the loopback node dies.
  // Kill the loopback node (no heartbeat for 60s) and reassign.
  recordNodeHeartbeat(dir, lan.id, LOAD_IDLE, T0 + 60_000);
  const reassigned = reassignDeadNodeJobs(dir, T0 + 60_000);
  assert.equal(reassigned.length, 2, 'both jobs were on the dead loopback node');
  assert.ok(reassigned.every((j) => j.status === 'queued' && j.nodeId === null));
  assert.equal(reassigned[0].history.at(-1).event, 'reassigned');
  // After reassign, dispatch goes to the live LAN node.
  const again = dispatchJob(dir, jobLocal.id, T0 + 61_000);
  assert.equal(again.node?.id, lan.id);
  // Nothing more to reassign.
  assert.deepEqual(reassignDeadNodeJobs(dir, T0 + 61_000), []);
  const summary = summarizeDispatch(dir, T0 + 61_000);
  assert.equal(summary.deadNodes, 1);
  assert.equal(summary.queued, 2, 'jobLocal is queued on LAN, jobLan still queued undispatch');
  assert.equal(summary.strandedOnDeadNodes, 0, 'no job is stranded after reassign');
});

// --- work stealing ----------------------------------------------------------------

test('fleet dispatch: stealWork — idle node pulls from a busy node only', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  // LAN node is busy (5 queued), loopback node is idle.
  recordNodeHeartbeat(dir, lan.id, LOAD_BUSY, T0);
  recordNodeHeartbeat(dir, local.id, LOAD_IDLE, T0);
  const job1 = submitJob(dir, jobInput({ botId: 'bot-1' }), T0);
  const job2 = submitJob(dir, jobInput({ botId: 'bot-2' }), T0 + 1);
  // Force both jobs onto the busy LAN node by dispatching while the
  // loopback node is temporarily "dead" — simpler: dispatch normally
  // (loopback wins) then simulate: reassign via direct manipulation is
  // not allowed, so dispatch one job, claim it on loopback, and put the
  // other on LAN by killing loopback heartbeats first.
  // Step 1: dispatch job1 to loopback, claim + complete it (frees loopback).
  dispatchJob(dir, job1.id, T0);
  claimJob(dir, job1.id, local.id, T0);
  completeJob(dir, job1.id, local.id, T0 + 1000);
  // Step 2: make loopback look dead so job2 dispatches to LAN.
  // Re-register heartbeats: loopback stale (31s old), LAN fresh + busy.
  recordNodeHeartbeat(dir, local.id, LOAD_IDLE, T0 - 31_000);
  recordNodeHeartbeat(dir, lan.id, LOAD_BUSY, T0 + 2000);
  const dispatched = dispatchJob(dir, job2.id, T0 + 2000);
  assert.equal(dispatched.node?.id, lan.id, 'stale loopback loses to fresh LAN node');
  // Step 3: loopback heartbeats again (idle) and steals job2 from busy LAN.
  recordNodeHeartbeat(dir, local.id, LOAD_IDLE, T0 + 3000);
  const stolen = stealWork(dir, local.id, undefined, T0 + 3000);
  assert.notEqual(stolen, null);
  assert.equal(stolen?.id, job2.id);
  assert.equal(stolen?.nodeId, local.id);
  assert.equal(stolen?.stolenFrom, lan.id);
  assert.equal(stolen?.history.at(-1).event, 'stolen');
  // Nothing left to steal.
  assert.equal(stealWork(dir, local.id, undefined, T0 + 4000), null);
  const summary = summarizeDispatch(dir, T0 + 4000);
  assert.equal(summary.stolen, 1);
});

test('fleet dispatch: findStealableJobs does not steal from an idle node', () => {
  const dir = tmpDir();
  const { local, lan } = setupNodes(dir);
  const job = submitJob(dir, jobInput(), T0);
  dispatchJob(dir, job.id, T0); // goes to loopback (idle)
  // LAN node is idle too — nothing is stealable.
  const stealable = findStealableJobs(loadFleetJobs(dir), loadFleetNodes(dir), lan.id, undefined, T0);
  assert.deepEqual(stealable, []);
  // Unknown thief node throws.
  assert.throws(() => stealWork(dir, 'fn-nope', undefined, T0), /not registered/);
});

test('fleet dispatch: summarizeDispatch counts by status', () => {
  const dir = tmpDir();
  const { local } = setupNodes(dir);
  const a = submitJob(dir, jobInput({ botId: 'a' }), T0);
  const b = submitJob(dir, jobInput({ botId: 'b' }), T0);
  const c = submitJob(dir, jobInput({ botId: 'c' }), T0);
  dispatchJob(dir, a.id, T0);
  claimJob(dir, a.id, local.id, T0);
  completeJob(dir, a.id, local.id, T0 + 1000);
  cancelJob(dir, b.id, T0);
  const summary = summarizeDispatch(dir, T0);
  assert.equal(summary.total, 3);
  assert.equal(summary.done, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.queued, 1);
  assert.equal(summary.running, 0);
  assert.equal(summary.deadNodes, 0);
  assert.equal(summary.strandedOnDeadNodes, 0);
  void c;
});
