/**
 * Protocols v7 — A2A v1.0.1 task lifecycle tests (v1.38, Team T2).
 *
 * Covers packages/core/src/protocolsV7/a2aTaskV7.ts:
 * state machine (legal/illegal transitions, terminal states),
 * store (create/get/list/counts/push configs/snapshot/restore/
 * prune), engine (submit/start/cancel/resume/input-required/
 * timeouts/overdue sweep/push delivery).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v138-a2a-task.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2aV7TaskEngine,
  A2aV7TaskStore,
  buildA2aV7Message,
  a2aV7TextPart,
  isA2aV7TaskTerminal,
  isA2aV7TaskTransitionLegal,
  summarizeA2aV7Task,
} from '../packages/core/dist/index.js';

const echoRunner = async (task) => {
  const first = task.history.find((m) => m.role === 'user');
  const text = first?.parts.find((p) => p.kind === 'text')?.text ?? '';
  return { text: `done: ${text}` };
};

test('state machine: legal transitions only, terminal states are final', () => {
  assert.equal(isA2aV7TaskTransitionLegal('submitted', 'working'), true);
  assert.equal(isA2aV7TaskTransitionLegal('submitted', 'failed'), true);
  assert.equal(isA2aV7TaskTransitionLegal('submitted', 'completed'), false);
  assert.equal(isA2aV7TaskTransitionLegal('working', 'input-required'), true);
  assert.equal(isA2aV7TaskTransitionLegal('input-required', 'working'), true);
  assert.equal(isA2aV7TaskTransitionLegal('input-required', 'completed'), false);
  assert.equal(isA2aV7TaskTerminal('completed'), true);
  assert.equal(isA2aV7TaskTerminal('failed'), true);
  assert.equal(isA2aV7TaskTerminal('canceled'), true);
  assert.equal(isA2aV7TaskTerminal('rejected'), true);
  assert.equal(isA2aV7TaskTerminal('working'), false);
  assert.equal(isA2aV7TaskTerminal('input-required'), false);
});

test('store: create/get/list/counts + illegal transition throws', () => {
  const store = new A2aV7TaskStore();
  const a = store.create({ message: 'hello', tenant: 'acme' });
  assert.equal(a.status, 'submitted');
  assert.equal(a.tenant, 'acme');
  assert.equal(a.history.length, 1);
  assert.equal(a.history[0].role, 'user');
  assert.equal(store.get(a.id).id, a.id);
  assert.equal(store.get('nope'), null);
  assert.equal(store.size(), 1);
  assert.throws(() => store.create({ id: a.id }), /already exists/);
  const b = store.create({ message: 'second' });
  assert.equal(store.list().length, 2);
  assert.equal(store.list({ tenant: 'acme' }).length, 1);
  assert.equal(store.list({ status: 'submitted' }).length, 2);
  assert.equal(store.list({ limit: 1 }).length, 1);
  assert.deepEqual(store.countsByStatus(), {
    submitted: 2, working: 0, 'input-required': 0, completed: 0, failed: 0, canceled: 0, rejected: 0,
  });
  assert.throws(() => store.transition(a.id, 'completed'), /cannot move/);
  const working = store.transition(a.id, 'working', 'started');
  assert.equal(working.status, 'working');
  assert.equal(working.statusHistory.length, 2);
  assert.equal(store.transition(a.id, 'completed', 'ok').status, 'completed');
  assert.throws(() => store.transition(a.id, 'working'), /cannot move/);
  assert.throws(() => store.addMessage(a.id, buildA2aV7Message('user', [a2aV7TextPart('late')], a.id, a.contextId)), /takes no more messages/);
  assert.match(summarizeA2aV7Task(store.get(b.id)), /submitted/);
});

test('store: artifacts + push configs + snapshot/restore + prune', () => {
  const store = new A2aV7TaskStore();
  const task = store.create({ message: 'build it' });
  const artifact = {
    artifactId: 'art-1', name: 'report.md', parts: [a2aV7TextPart('# report')], createdAtMs: Date.now(),
  };
  store.addArtifact(task.id, artifact);
  assert.equal(store.get(task.id).artifacts.length, 1);
  assert.throws(() => store.addArtifact(task.id, artifact), /already exists/);
  const config = store.addPushConfig(task.id, 'https://hooks.example.com/task', { states: ['completed'] });
  assert.equal(config.taskId, task.id);
  assert.equal(store.listPushConfigs(task.id).length, 1);
  assert.throws(() => store.addPushConfig(task.id, 'ftp://bad.example.com'), /Push URL/);
  assert.equal(store.removePushConfig(task.id, config.id), true);
  assert.equal(store.removePushConfig(task.id, config.id), false);
  assert.throws(() => store.listPushConfigs('nope'), /does not exist/);
  // Snapshot / restore round-trip.
  store.transition(task.id, 'working');
  store.transition(task.id, 'completed');
  const snap = store.snapshot();
  const restored = new A2aV7TaskStore();
  assert.equal(restored.restore(snap), 1);
  assert.equal(restored.get(task.id).status, 'completed');
  assert.equal(restored.get(task.id).artifacts.length, 1);
  assert.throws(() => restored.restore('not json'), /not valid JSON/);
  assert.throws(() => restored.restore('{"x":1}'), /must be a JSON array/);
  assert.throws(() => restored.restore('[{"id":"x"}]'), /invalid id or status/);
  // Prune terminal tasks older than the threshold.
  assert.equal(restored.pruneTerminal(0, Date.now() + 1000), 1);
  assert.equal(restored.size(), 0);
});

test('engine: submit runs to completed with the runner result', async () => {
  const store = new A2aV7TaskStore();
  const engine = new A2aV7TaskEngine(store, echoRunner);
  const running = engine.submit({ message: 'hello world' });
  const finished = await running.done;
  assert.equal(finished.status, 'completed');
  assert.equal(finished.history.length, 2);
  assert.equal(finished.history[1].parts[0].text, 'done: hello world');
  assert.equal(engine.isRunning(running.taskId), false);
  assert.equal(engine.runningTaskIds().length, 0);
});

test('engine: runner failure marks the task failed (with the error as the reason)', async () => {
  const store = new A2aV7TaskStore();
  const engine = new A2aV7TaskEngine(store, async () => { throw new Error('boom'); });
  const finished = await engine.submit({ message: 'x' }).done;
  assert.equal(finished.status, 'failed');
  assert.match(finished.statusHistory.at(-1).message, /boom/);
});

test('engine: input-required pauses, resume continues with the answer', async () => {
  const store = new A2aV7TaskStore();
  let calls = 0;
  const engine = new A2aV7TaskEngine(store, async (task) => {
    calls += 1;
    if (calls === 1) return { text: '', needsInput: true, inputPrompt: 'Which color?' };
    const answer = task.history.filter((m) => m.role === 'user').at(-1).parts[0].text;
    return { text: `you said ${answer}` };
  });
  const first = await engine.submit({ message: 'paint it' }).done;
  assert.equal(first.status, 'input-required');
  assert.equal(first.statusHistory.at(-1).message, 'Which color?');
  const second = await engine.resume(first.id, 'blue').done;
  assert.equal(second.status, 'completed');
  assert.equal(second.history.at(-1).parts[0].text, 'you said blue');
  assert.equal(calls, 2);
  assert.throws(() => engine.resume(first.id, 'again'), /not input-required/);
});

test('engine: cancel aborts the runner and marks the task canceled', async () => {
  const store = new A2aV7TaskStore();
  let aborted = false;
  const engine = new A2aV7TaskEngine(store, async (_task, signal) => {
    await new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve(null); }, { once: true });
      setTimeout(resolve, 5000);
    });
    if (signal.aborted) throw new Error('aborted');
    return { text: 'never' };
  });
  const running = engine.submit({ message: 'slow job' });
  // Let the runner start, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const canceled = engine.cancel(running.taskId, 'user changed mind');
  assert.equal(canceled.status, 'canceled');
  const finished = await running.done;
  assert.equal(finished.status, 'canceled');
  assert.equal(aborted, true);
  assert.throws(() => engine.cancel(running.taskId), /already canceled/);
});

test('engine: start on a completed task throws; submit with unknown tenant is rejected by a scoped engine', async () => {
  const store = new A2aV7TaskStore();
  const engine = new A2aV7TaskEngine(store, echoRunner, { tenant: 'acme' });
  const finished = await engine.submit({ message: 'hi', tenant: 'acme' }).done;
  assert.equal(finished.status, 'completed');
  assert.throws(() => engine.start(finished.id), /cannot start/);
  assert.throws(() => engine.submit({ message: 'hi', tenant: 'other' }), /tenant/);
});

test('engine: push delivery fires on state changes; failures are logged, not fatal', async () => {
  const store = new A2aV7TaskStore();
  const delivered = [];
  const engine = new A2aV7TaskEngine(store, echoRunner, {
    onPush: async (config, task) => {
      if (config.url.includes('flaky')) throw new Error('webhook down');
      delivered.push({ url: config.url, state: task.status });
    },
  });
  const task = store.create({ message: 'notify me' });
  store.addPushConfig(task.id, 'https://hooks.example.com/ok');
  store.addPushConfig(task.id, 'https://hooks.example.com/flaky');
  const finished = await engine.start(task.id).done;
  assert.equal(finished.status, 'completed');
  assert.ok(delivered.some((d) => d.state === 'completed'));
  const log = engine.getPushLog();
  assert.ok(log.some((e) => e.delivered === true));
  assert.ok(log.some((e) => e.delivered === false && e.error === 'webhook down'));
});

test('engine: sweep overdue fails tasks past their deadline', () => {
  const store = new A2aV7TaskStore();
  const engine = new A2aV7TaskEngine(store, echoRunner);
  const task = store.create({ message: 'late', timeoutMs: 1 });
  assert.equal(store.isOverdue(task.id, Date.now() + 1000), true);
  assert.equal(engine.sweepOverdue(Date.now() + 1000), 1);
  assert.equal(store.get(task.id).status, 'failed');
  assert.equal(engine.sweepOverdue(), 0);
});
