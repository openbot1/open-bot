/**
 * Test v1.44 T3: Tasks v2 — DAG, retry/backoff, priority, concurrency,
 * artifacts, snapshot/restore, cancel, retryTask (node:test, no network).
 *
 * Covers:
 *   - packages/core/src/mcp/tasksV2.ts
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v144-t3-tasks-v2.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TaskV2Orchestrator,
  TasksV2Error,
  describeTaskV2Job,
  describeTaskV2Node,
  isTaskV2Terminal,
} from '../packages/core/dist/mcp/tasksV2.js';

/** Executor that succeeds, recording call order + concurrency. */
function makeRecorder(results = {}) {
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  const executor = async (node, signal, reportProgress) => {
    calls.push(node.id);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    reportProgress(0.5, 'halfway');
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      signal.throwIfAborted();
      if (node.id in results) return results[node.id];
      return { ok: node.id };
    } finally {
      running -= 1;
    }
  };
  return { executor, calls, get maxRunning() { return maxRunning; } };
}

/** Executor that fails `failTimes` times per task id, then succeeds. */
function makeFlaky(failTimes = {}) {
  const attempts = new Map();
  const delays = [];
  const executor = async (node) => {
    const n = (attempts.get(node.id) ?? 0) + 1;
    attempts.set(node.id, n);
    if (n <= (failTimes[node.id] ?? 0)) throw new Error(`boom ${node.id} #${n}`);
    return `done-${node.id}`;
  };
  return {
    executor,
    attempts,
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

test('addTask: validation — bad id, duplicate, unknown dep, self-dep, bad maxAttempts', () => {
  const job = new TaskV2Orchestrator('job-1', async () => 1);
  assert.throws(() => job.addTask({ id: 'BAD ID', serverName: 's', method: 'tools/call' }), TasksV2Error);
  assert.throws(() => job.addTask({ id: 'a', serverName: '', method: 'tools/call' }), TasksV2Error);
  assert.throws(() => job.addTask({ id: 'a', serverName: 's', method: '' }), TasksV2Error);
  job.addTask({ id: 'a', serverName: 's', method: 'tools/call' });
  assert.throws(() => job.addTask({ id: 'a', serverName: 's', method: 'tools/call' }), /trùng/);
  assert.throws(() => job.addTask({ id: 'b', serverName: 's', method: 'tools/call', dependsOn: ['ghost'] }), /chưa có/);
  assert.throws(() => job.addTask({ id: 'c', serverName: 's', method: 'tools/call', dependsOn: ['c'] }), /chính nó/);
  assert.throws(() => job.addTask({ id: 'd', serverName: 's', method: 'tools/call', maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => job.addTask({ id: 'e', serverName: 's', method: 'tools/call', maxAttempts: 11 }), /maxAttempts/);
  assert.equal(job.size, 1);
});

test('runAll: DAG order respected, dependents wait, job completes with artifacts', async () => {
  const { executor, calls } = makeRecorder();
  const job = new TaskV2Orchestrator('job-dag', executor, { concurrency: 3 });
  job.addTask({ id: 'fetch', serverName: 's', method: 'tools/call' });
  job.addTask({ id: 'parse', serverName: 's', method: 'tools/call', dependsOn: ['fetch'] });
  job.addTask({ id: 'report', serverName: 's', method: 'tools/call', dependsOn: ['parse'] });
  job.addTask({ id: 'side', serverName: 's', method: 'tools/call' });
  const status = await job.runAll();
  assert.equal(status, 'completed');
  assert.equal(job.jobStatus, 'completed');
  assert.ok(calls.indexOf('fetch') < calls.indexOf('parse'));
  assert.ok(calls.indexOf('parse') < calls.indexOf('report'));
  assert.equal(job.progress().done, 4);
  assert.equal(job.progress().fraction, 1);
  const artifact = job.getArtifactForTask('fetch');
  assert.ok(artifact);
  assert.deepEqual(artifact.result, { ok: 'fetch' });
  assert.equal(artifact.truncated, false);
  assert.match(describeTaskV2Job(job), /completed: 4\/4 xong/);
  assert.match(describeTaskV2Node(job.getNode('fetch')), /completed/);
});

test('runAll: priority orders ready tasks; concurrency is bounded', async () => {
  const rec = makeRecorder();
  const job = new TaskV2Orchestrator('job-prio', rec.executor, { concurrency: 1 });
  job.addTask({ id: 'low', serverName: 's', method: 'tools/call', priority: 1 });
  job.addTask({ id: 'high', serverName: 's', method: 'tools/call', priority: 10 });
  job.addTask({ id: 'mid', serverName: 's', method: 'tools/call', priority: 5 });
  await job.runAll();
  assert.deepEqual(rec.calls, ['high', 'mid', 'low']);
  assert.equal(rec.maxRunning, 1);

  const rec2 = makeRecorder();
  const job2 = new TaskV2Orchestrator('job-conc', rec2.executor, { concurrency: 2 });
  for (let i = 0; i < 5; i += 1) job2.addTask({ id: `t${i}`, serverName: 's', method: 'tools/call' });
  await job2.runAll();
  assert.ok(rec2.maxRunning <= 2);
  assert.ok(rec2.maxRunning >= 2);
});

test('runAll: failing task retries with backoff, then succeeds; dependents unblocked', async () => {
  const flaky = makeFlaky({ a: 2 });
  const job = new TaskV2Orchestrator('job-retry', flaky.executor, {
    concurrency: 1,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 1000,
    random: () => 0,
    sleep: flaky.sleep,
  });
  job.addTask({ id: 'a', serverName: 's', method: 'tools/call', maxAttempts: 3 });
  job.addTask({ id: 'b', serverName: 's', method: 'tools/call', dependsOn: ['a'] });
  const status = await job.runAll();
  assert.equal(status, 'completed');
  assert.equal(flaky.attempts.get('a'), 3);
  assert.deepEqual(flaky.delays, [100, 200]); // 100 * 2^0, 100 * 2^1, no jitter (random=0)
  assert.equal(job.getNode('a')?.attemptHistory.length, 3);
  assert.equal(job.getNode('b')?.status, 'completed');
});

test('runAll: task that exhausts retries fails; dependents are skipped, job is partial', async () => {
  const flaky = makeFlaky({ a: 99 });
  const events = [];
  const job = new TaskV2Orchestrator('job-fail', flaky.executor, {
    concurrency: 2,
    random: () => 0,
    sleep: flaky.sleep,
  });
  job.onEvent((e) => events.push(e.type));
  job.addTask({ id: 'a', serverName: 's', method: 'tools/call', maxAttempts: 2, label: 'Fetch' });
  job.addTask({ id: 'b', serverName: 's', method: 'tools/call', dependsOn: ['a'] });
  job.addTask({ id: 'c', serverName: 's', method: 'tools/call', dependsOn: ['b'] });
  job.addTask({ id: 'free', serverName: 's', method: 'tools/call' });
  const status = await job.runAll();
  assert.equal(status, 'partial');
  assert.equal(job.getNode('a')?.status, 'failed');
  assert.match(job.getNode('a')?.error ?? '', /boom a #2/);
  assert.equal(job.getNode('b')?.status, 'skipped');
  assert.equal(job.getNode('c')?.status, 'skipped');
  assert.equal(job.getNode('free')?.status, 'completed');
  assert.ok(events.includes('node-skipped'));
  assert.ok(events.includes('job-finished'));
  assert.equal(job.progress().failed, 1);
  assert.equal(job.progress().skipped, 2);
});

test('retryTask: failed node retries and unblocks skipped dependents', async () => {
  let failA = true;
  const executor = async (node) => {
    if (node.id === 'a' && failA) throw new Error('first run fails');
    return `ok-${node.id}`;
  };
  const job = new TaskV2Orchestrator('job-retry2', executor, { concurrency: 2 });
  job.addTask({ id: 'a', serverName: 's', method: 'tools/call', maxAttempts: 1 });
  job.addTask({ id: 'b', serverName: 's', method: 'tools/call', dependsOn: ['a'] });
  assert.equal(await job.runAll(), 'partial');
  failA = false;
  const node = await job.retryTask('a');
  assert.equal(node.status, 'completed');
  assert.equal(job.getNode('b')?.status, 'completed');
  assert.equal(job.jobStatus, 'completed');
  await assert.rejects(() => job.retryTask('b'), /Chỉ retry được task failed/);
  await assert.rejects(() => job.retryTask('ghost'), /Không có task/);
});

test('snapshot/restore: completed nodes + artifacts survive; unfinished nodes resume', async () => {
  const { executor } = makeRecorder();
  const job = new TaskV2Orchestrator('job-snap', executor, { concurrency: 1 });
  job.addTask({ id: 'a', serverName: 's', method: 'tools/call' });
  job.addTask({ id: 'b', serverName: 's', method: 'tools/call', dependsOn: ['a'] });
  await job.runAll();
  const snap = job.snapshot();
  assert.equal(snap.version, 1);
  assert.equal(snap.status, 'completed');

  const restored = TaskV2Orchestrator.restore(snap, executor);
  assert.equal(restored.getNode('a')?.status, 'completed');
  assert.deepEqual(restored.getArtifactForTask('a')?.result, { ok: 'a' });

  // A mid-flight snapshot: node b still waiting -> restores as waiting, resumes.
  const job2 = new TaskV2Orchestrator('job-snap2', executor, { concurrency: 1 });
  job2.addTask({ id: 'a', serverName: 's', method: 'tools/call' });
  job2.addTask({ id: 'b', serverName: 's', method: 'tools/call', dependsOn: ['a'] });
  const snap2 = job2.snapshot();
  const restored2 = TaskV2Orchestrator.restore(snap2, executor);
  assert.equal(await restored2.runAll(), 'completed');
  assert.throws(() => TaskV2Orchestrator.restore({ version: 2 }, executor), /version 1/);
});

test('cancel: queued nodes cancelled, running node aborts, job reports cancelled', async () => {
  const started = [];
  const executor = async (node, signal) => {
    started.push(node.id);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(`ok-${node.id}`), 200);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    });
  };
  const job = new TaskV2Orchestrator('job-cancel', executor, { concurrency: 1 });
  job.addTask({ id: 'a', serverName: 's', method: 'tools/call' });
  job.addTask({ id: 'b', serverName: 's', method: 'tools/call' });
  const run = job.runAll();
  await new Promise((resolve) => setTimeout(resolve, 30));
  job.cancel();
  const status = await run;
  assert.equal(status, 'cancelled');
  assert.equal(job.getNode('b')?.status, 'cancelled');
  assert.ok(['failed', 'cancelled'].includes(job.getNode('a')?.status ?? ''));
});

test('artifact truncation: oversized results are capped and flagged', async () => {
  const executor = async () => ({ blob: 'x'.repeat(5000) });
  const job = new TaskV2Orchestrator('job-big', executor, { maxArtifactBytes: 100 });
  job.addTask({ id: 'big', serverName: 's', method: 'tools/call' });
  await job.runAll();
  const artifact = job.getArtifactForTask('big');
  assert.equal(artifact?.truncated, true);
  assert.ok((artifact?.bytes ?? 0) <= 300);
});

test('isTaskV2Terminal covers the four terminal states', () => {
  assert.equal(isTaskV2Terminal('completed'), true);
  assert.equal(isTaskV2Terminal('failed'), true);
  assert.equal(isTaskV2Terminal('cancelled'), true);
  assert.equal(isTaskV2Terminal('skipped'), true);
  assert.equal(isTaskV2Terminal('running'), false);
  assert.equal(isTaskV2Terminal('queued'), false);
});
