/**
 * Tests for v1.41 (Team T2) — Tasks extension v10:
 * packages/core/src/protocolsV10/mcpTasksV10.ts
 *
 * Covers:
 *  - state machine (legal/illegal transitions, terminal
 *    states never move, cancel from non-terminal only)
 *  - priorities + ready queue order (highest priority
 *    first, oldest first within a priority)
 *  - dependencies (waiting until deps complete, release on
 *    completion, unknown dependency refused, restore
 *    refuses dependency cycles)
 *  - progress reporting (working only, 0–100 only)
 *  - input rounds (request while working, answer resumes,
 *    answering without an open round refused)
 *  - retry policy (retryable failure retries with backoff,
 *    non-retryable fails immediately, retries counted)
 *  - completion embeds the result; engine runs the highest
 *    priority ready task; unknown handler fails the task
 *  - overdue input wait is swept (fails loudly)
 *  - counts, events, snapshot / restore round-trip
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v10-tasks.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV10TaskEngine,
  McpV10TaskStore,
  McpV10TasksRetryableError,
  mcpV10TaskIsTerminal,
  mcpV10TaskTransitionAllowed,
} from '../packages/core/dist/index.js';

test('state machine: legal transitions, terminal states are final', () => {
  assert.equal(mcpV10TaskTransitionAllowed('submitted', 'working'), true);
  assert.equal(mcpV10TaskTransitionAllowed('submitted', 'waiting'), true);
  assert.equal(mcpV10TaskTransitionAllowed('waiting', 'submitted'), true);
  assert.equal(mcpV10TaskTransitionAllowed('waiting', 'working'), true);
  assert.equal(mcpV10TaskTransitionAllowed('working', 'input-required'), true);
  assert.equal(mcpV10TaskTransitionAllowed('input-required', 'working'), true);
  assert.equal(mcpV10TaskTransitionAllowed('working', 'completed'), true);
  assert.equal(mcpV10TaskTransitionAllowed('completed', 'working'), false);
  assert.equal(mcpV10TaskTransitionAllowed('failed', 'submitted'), false);
  assert.equal(mcpV10TaskTransitionAllowed('submitted', 'completed'), false);
  assert.equal(mcpV10TaskIsTerminal('completed'), true);
  assert.equal(mcpV10TaskIsTerminal('failed'), true);
  assert.equal(mcpV10TaskIsTerminal('canceled'), true);
  assert.equal(mcpV10TaskIsTerminal('waiting'), false);
});

test('create: waiting when dependencies exist, unknown dependency refused', () => {
  const store = new McpV10TaskStore();
  const a = store.create({ toolName: 'echo' });
  assert.equal(a.state, 'submitted');
  const b = store.create({ toolName: 'echo', dependsOn: [a.id], priority: 'high' });
  assert.equal(b.state, 'waiting');
  assert.equal(b.priority, 'high');
  assert.throws(() => store.create({ toolName: 'echo', dependsOn: ['task-v10-999'] }), /unknown task/);
  assert.throws(() => store.create({ toolName: '' }), /non-empty string/);
  assert.equal(store.dependenciesMet(b.id), false);
  assert.equal(store.readyQueue().length, 1);
  assert.equal(store.readyQueue()[0].id, a.id);
});

test('dependencies release: completing a dependency unblocks the waiter', () => {
  const store = new McpV10TaskStore();
  const a = store.create({ toolName: 'echo' });
  const b = store.create({ toolName: 'echo', dependsOn: [a.id] });
  store.transition(store.get(a.id), 'working');
  store.complete(a.id, { ok: true });
  assert.equal(store.get(a.id).result.ok, true);
  const released = store.get(b.id);
  assert.equal(released.state, 'submitted');
  assert.equal(store.dependenciesMet(b.id), true);
  assert.equal(store.readyQueue().length, 1);
});

test('ready queue: highest priority first, oldest first within a priority', () => {
  const store = new McpV10TaskStore();
  const low = store.create({ toolName: 'echo', priority: 'low' });
  const urgent = store.create({ toolName: 'echo', priority: 'urgent' });
  const normal = store.create({ toolName: 'echo', priority: 'normal' });
  const high = store.create({ toolName: 'echo', priority: 'high' });
  const order = store.readyQueue().map((t) => t.id);
  assert.deepEqual(order, [urgent.id, high.id, normal.id, low.id]);
});

test('progress: working only, 0-100 only', () => {
  const store = new McpV10TaskStore();
  const task = store.create({ toolName: 'echo' });
  assert.throws(() => store.reportProgress(task.id, 50), /not "working"/);
  store.transition(store.get(task.id), 'working');
  const updated = store.reportProgress(task.id, 42, 'halfway');
  assert.equal(updated.progress, 42);
  assert.equal(updated.progressMessage, 'halfway');
  assert.throws(() => store.reportProgress(task.id, 101), /0 to 100/);
  assert.throws(() => store.reportProgress(task.id, -1), /0 to 100/);
  assert.equal(store.eventsFor(task.id).filter((e) => e.kind === 'progress').length, 1);
});

test('input rounds: request while working, answer resumes, double answer refused', () => {
  const store = new McpV10TaskStore();
  const task = store.create({ toolName: 'echo' });
  assert.throws(() => store.requestInput(task.id, { reason: 'x', fields: [] }), /not "working"/);
  store.transition(store.get(task.id), 'working');
  const round = store.requestInput(task.id, { reason: 'need a name', fields: [{ name: 'who', type: 'string' }] });
  assert.equal(round.round, 1);
  assert.equal(store.get(task.id).state, 'input-required');
  const resumed = store.provideInput(task.id, { who: 'Huy' });
  assert.equal(resumed.state, 'working');
  assert.equal(resumed.rounds[0].response.who, 'Huy');
  assert.ok(typeof resumed.rounds[0].answeredAtMs === 'number');
  assert.throws(() => store.provideInput(task.id, { who: 'x' }), /not "input-required"/);
});

test('cancel: from non-terminal only; terminal cancel refused', () => {
  const store = new McpV10TaskStore();
  const task = store.create({ toolName: 'echo' });
  const canceled = store.cancel(task.id, 'user asked');
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.cancelReason, 'user asked');
  assert.throws(() => store.cancel(task.id), /already "canceled"/);
  const done = store.create({ toolName: 'echo' });
  store.transition(store.get(done.id), 'working');
  store.complete(done.id, 1);
  assert.throws(() => store.cancel(done.id), /already "completed"/);
  assert.throws(() => store.transition(store.get(done.id), 'working'), /cannot move/);
});

test('sweep: overdue input wait fails loudly', () => {
  const store = new McpV10TaskStore({ inputTimeoutMs: 1000 });
  const task = store.create({ toolName: 'echo' });
  store.transition(store.get(task.id), 'working');
  store.requestInput(task.id, { reason: 'x', fields: [{ name: 'a', type: 'string' }] });
  assert.deepEqual(store.sweepOverdue(Date.now() + 500), []);
  const swept = store.sweepOverdue(Date.now() + 5000);
  assert.equal(swept.length, 1);
  assert.equal(swept[0].state, 'failed');
  assert.match(swept[0].error, /expired/);
});

test('engine: runs the highest-priority ready task, embeds the result', async () => {
  const engine = new McpV10TaskEngine();
  engine.registerHandler('add', (task) => task.args.a + task.args.b);
  const low = engine.submit({ toolName: 'add', args: { a: 1, b: 1 }, priority: 'low' });
  const high = engine.submit({ toolName: 'add', args: { a: 10, b: 20 }, priority: 'high' });
  const done = await engine.runNext();
  assert.equal(done.id, high.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.result, 30);
  const done2 = await engine.runNext();
  assert.equal(done2.id, low.id);
  assert.equal(done2.result, 2);
  assert.equal(await engine.runNext(), undefined);
  assert.equal(engine.isRunning(high.id), false);
});

test('engine: unknown handler fails the task; non-retryable error fails immediately', async () => {
  const engine = new McpV10TaskEngine();
  const task = engine.submit({ toolName: 'missing-tool' });
  const done = await engine.runNext();
  assert.equal(done.id, task.id);
  assert.equal(done.state, 'failed');
  assert.match(done.error, /No handler/);
  engine.registerHandler('boom', () => {
    throw new Error('permanent');
  });
  const t2 = engine.submit({ toolName: 'boom', retryPolicy: { maxRetries: 3 } });
  const failed = await engine.runNext();
  assert.equal(failed.id, t2.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retriesUsed, 0);
});

test('engine: retryable failure retries with backoff, then succeeds', async () => {
  const engine = new McpV10TaskEngine();
  let attempts = 0;
  engine.registerHandler('flaky', () => {
    attempts += 1;
    if (attempts < 3) throw new McpV10TasksRetryableError('transient');
    return 'third time';
  });
  const task = engine.submit({ toolName: 'flaky', retryPolicy: { maxRetries: 3, backoffMs: 1 } });
  const done = await engine.runNext();
  assert.equal(done.state, 'completed');
  assert.equal(done.result, 'third time');
  assert.equal(attempts, 3);
  assert.equal(engine.store.get(task.id).retriesUsed, 2);
});

test('engine: progress + input round inside a handler', async () => {
  const engine = new McpV10TaskEngine();
  engine.registerHandler('asker', (task, controls) => {
    controls.reportProgress(50, 'halfway');
    if (task.rounds.length === 0) {
      controls.requestInput({ reason: 'need input', fields: [{ name: 'x', type: 'string' }] });
      return 'waiting';
    }
    return `got ${task.rounds[0].response.x}`;
  });
  const task = engine.submit({ toolName: 'asker' });
  const first = await engine.runNext();
  assert.equal(first.state, 'input-required');
  assert.equal(first.progress, 50);
  engine.provideInput(task.id, { x: 'hello' });
  const second = await engine.runNext();
  assert.equal(second.state, 'completed');
  assert.equal(second.result, 'got hello');
});

test('counts, events, snapshot / restore round-trip; restore refuses cycles', () => {
  const store = new McpV10TaskStore();
  const a = store.create({ toolName: 'echo' });
  const b = store.create({ toolName: 'echo', dependsOn: [a.id] });
  assert.deepEqual(store.counts(), {
    submitted: 1, waiting: 1, working: 0, 'input-required': 0, completed: 0, failed: 0, canceled: 0,
  });
  const snap = store.snapshot();
  const restored = new McpV10TaskStore();
  restored.restore(snap);
  assert.equal(restored.list().length, 2);
  assert.equal(restored.get(b.id).dependsOn[0], a.id);
  assert.ok(store.eventsFor(a.id).some((e) => e.kind === 'created'));
  const cyclic = new McpV10TaskStore();
  assert.throws(
    () =>
      cyclic.restore([
        { ...snap[0], dependsOn: [snap[1].id] },
        { ...snap[1], dependsOn: [snap[0].id] },
      ]),
    /dependency cycle/,
  );
});
