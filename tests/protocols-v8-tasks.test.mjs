/**
 * Tests for v1.39 (Team T2) — protocols v8 MCP Tasks extension:
 * packages/core/src/protocolsV8/mcpTasksV8.ts
 *
 * Covers:
 *  - state machine (legal transitions, terminal states are final,
 *    illegal transitions refused)
 *  - store: create / get / counts / report / sweep overdue /
 *    snapshot + restore / eviction cap
 *  - engine: submit returns immediately, echo runner completes
 *    with the result embedded in the Task object, failing runner
 *    fails the task, unknown tool fails the task
 *  - MRTR: runner asks for input -> input-required -> update
 *    resumes with the answer -> completed with the merged result
 *  - cancel: open task cancels, waiting runner is woken with a
 *    rejection, terminal task cancel is a no-op
 *  - task methods: only tasks/get | tasks/update | tasks/cancel
 *    (no tasks/result, no tasks/list)
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v8-tasks.test.mjs
 *
 * No network, no model. Async waits use short local timeouts only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV8TaskEngine,
  McpV8TaskStore,
  cloneMcpV8Task,
  mcpV8IsTaskMethod,
  mcpV8TaskIsTerminal,
  mcpV8TaskTransitionAllowed,
  MCP_V8_TASK_METHODS,
  MCP_V8_TASK_STATES,
  MCP_V8_TERMINAL_TASK_STATES,
} from '../packages/core/dist/index.js';

async function waitFor(predicate, timeoutMs = 2000, stepMs = 10) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test('task methods: only get/update/cancel — no blocking result, no list', () => {
  assert.deepEqual([...MCP_V8_TASK_METHODS].sort(), ['tasks/cancel', 'tasks/get', 'tasks/update']);
  assert.equal(mcpV8IsTaskMethod('tasks/get'), true);
  assert.equal(mcpV8IsTaskMethod('tasks/update'), true);
  assert.equal(mcpV8IsTaskMethod('tasks/cancel'), true);
  assert.equal(mcpV8IsTaskMethod('tasks/result'), false);
  assert.equal(mcpV8IsTaskMethod('tasks/list'), false);
  assert.equal(mcpV8IsTaskMethod('tools/call'), false);
});

test('state machine: legal transitions, terminal states are final', () => {
  assert.deepEqual([...MCP_V8_TASK_STATES].sort(), [
    'canceled', 'completed', 'failed', 'input-required', 'submitted', 'working',
  ]);
  assert.deepEqual([...MCP_V8_TERMINAL_TASK_STATES].sort(), ['canceled', 'completed', 'failed']);
  assert.equal(mcpV8TaskIsTerminal('completed'), true);
  assert.equal(mcpV8TaskIsTerminal('working'), false);
  assert.equal(mcpV8TaskTransitionAllowed('submitted', 'working'), true);
  assert.equal(mcpV8TaskTransitionAllowed('working', 'input-required'), true);
  assert.equal(mcpV8TaskTransitionAllowed('input-required', 'working'), true);
  assert.equal(mcpV8TaskTransitionAllowed('working', 'completed'), true);
  assert.equal(mcpV8TaskTransitionAllowed('completed', 'working'), false);
  assert.equal(mcpV8TaskTransitionAllowed('failed', 'working'), false);
  assert.equal(mcpV8TaskTransitionAllowed('canceled', 'working'), false);
  assert.equal(mcpV8TaskTransitionAllowed('submitted', 'completed'), false);
});

test('store: create / transition / report / counts / clone isolation', () => {
  let now = 1_000_000;
  const store = new McpV8TaskStore({ nowMs: () => now });
  const task = store.create('echo', { text: 'hi' }, 'team-a');
  assert.equal(task.status, 'submitted');
  assert.equal(task.tenant, 'team-a');
  assert.deepEqual(task.arguments, { text: 'hi' });
  assert.equal(task.createdAtMs, now);
  assert.equal(store.size(), 1);
  assert.deepEqual(store.counts(), {
    submitted: 1, working: 0, 'input-required': 0, completed: 0, failed: 0, canceled: 0,
  });

  const working = store.transition(task.taskId, 'working', { progress: 0.5, message: 'halfway' });
  assert.equal(working.status, 'working');
  assert.equal(working.progress, 0.5);
  const reported = store.report(task.taskId, 0.75, 'almost');
  assert.equal(reported.progress, 0.75);
  assert.throws(() => store.report(task.taskId, 1.5), /between 0 and 1/);
  assert.throws(() => store.transition(task.taskId, 'submitted'), /cannot move/);

  const done = store.transition(task.taskId, 'completed', { result: { echo: 'hi' }, progress: 1 });
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { echo: 'hi' });
  assert.equal(done.finishedAtMs, now);
  assert.throws(() => store.transition(task.taskId, 'working'), /cannot move from "completed"/);
  assert.throws(() => store.report(task.taskId, 0.5), /takes no more progress/);
  assert.throws(() => store.transition('nope', 'working'), /not known/);

  // Clone isolation: mutating a copy never touches the store.
  const copy = store.get(task.taskId);
  copy.status = 'working';
  assert.equal(store.get(task.taskId)?.status, 'completed');
  const cloned = cloneMcpV8Task(copy);
  cloned.arguments.text = 'mutated';
  assert.equal(store.get(task.taskId)?.arguments.text, 'hi');

  // byState + cancel of a terminal task is a no-op.
  assert.equal(store.byState('completed').length, 1);
  assert.equal(store.cancel(task.taskId).status, 'completed');
});

test('store: MRTR rounds + sweep overdue input waits', () => {
  let now = 2_000_000;
  const store = new McpV8TaskStore({ nowMs: () => now, inputTimeoutMs: 1000 });
  const task = store.create('ask', {});
  store.transition(task.taskId, 'working');
  const waiting = store.requestInput(task.taskId, { question: 'name?' });
  assert.equal(waiting.status, 'input-required');
  assert.equal(waiting.rounds.length, 1);
  assert.equal(waiting.rounds[0].round, 1);
  assert.deepEqual(waiting.rounds[0].request, { question: 'name?' });
  assert.throws(() => store.requestInput(task.taskId, { q: 'x' }), /only a working task/);
  const resumed = store.answerInput(task.taskId, { name: 'Huy' });
  assert.equal(resumed.status, 'working');
  assert.deepEqual(resumed.rounds[0].response, { name: 'Huy' });
  assert.throws(() => store.answerInput(task.taskId, { name: 'x' }), /only an input-required task/);

  // Second wait, then time passes: sweep fails it.
  store.requestInput(task.taskId, { question: 'again?' });
  now += 1001;
  const swept = store.sweepOverdue();
  assert.deepEqual(swept, [task.taskId]);
  assert.equal(store.get(task.taskId)?.status, 'failed');
  assert.match(store.get(task.taskId)?.error ?? '', /Timed out waiting for input/);
  assert.deepEqual(store.sweepOverdue(), []);
});

test('store: snapshot + restore round-trips; maxTasks evicts oldest terminal first', () => {
  const store = new McpV8TaskStore({ maxTasks: 3 });
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const t = store.create(`tool-${i}`, {});
    store.transition(t.taskId, 'working');
    store.transition(t.taskId, 'completed', { result: { i } });
    ids.push(t.taskId);
  }
  assert.equal(store.size(), 3);
  const extra = store.create('tool-3', {});
  assert.equal(store.size(), 3);
  assert.equal(store.get(ids[0]), undefined);
  assert.notEqual(store.get(extra.taskId), undefined);

  const snapshot = store.snapshot();
  const restored = new McpV8TaskStore();
  restored.restore(snapshot);
  assert.equal(restored.size(), 3);
  assert.deepEqual(restored.all().map((t) => t.toolName).sort(), ['tool-1', 'tool-2', 'tool-3']);
  const bad = new McpV8TaskStore();
  bad.restore([{ taskId: 'x', status: 'bogus-state' }]);
  assert.equal(bad.size(), 0);
});

test('engine: submit returns at once; echo completes with result embedded in the Task', async () => {
  const engine = new McpV8TaskEngine();
  engine.registerRunner('echo', async (_tool, args) => ({ echo: String(args.text ?? '') }));
  const task = engine.submit('echo', { text: 'hello' });
  assert.equal(task.status, 'submitted');
  assert.equal(task.toolName, 'echo');
  const done = await waitFor(() => {
    const t = engine.get(task.taskId);
    return t.status === 'completed' ? t : null;
  });
  assert.deepEqual(done.result, { echo: 'hello' });
  assert.equal(done.progress, 1);
  assert.equal(done.finishedAtMs !== undefined, true);
  assert.deepEqual(engine.counts().completed, 1);
});

test('engine: failing runner fails the task; unknown tool fails the task', async () => {
  const engine = new McpV8TaskEngine();
  engine.registerRunner('boom', async () => {
    throw new Error('runner exploded');
  });
  const bad = engine.submit('boom', {});
  const failed = await waitFor(() => {
    const t = engine.get(bad.taskId);
    return t.status === 'failed' ? t : null;
  });
  assert.equal(failed.error, 'runner exploded');

  const unknown = engine.submit('no-such-tool', {});
  const unknownFailed = await waitFor(() => {
    const t = engine.get(unknown.taskId);
    return t.status === 'failed' ? t : null;
  });
  assert.match(unknownFailed.error ?? '', /No runner registered/);
  assert.throws(() => engine.get('nope'), /not known/);
});

test('engine: MRTR round — ask, update, resume, complete with merged result', async () => {
  const engine = new McpV8TaskEngine();
  engine.registerRunner('ask-name', async (_tool, args, _task, control) => {
    control.report(0.5, 'asking');
    const answer = await control.askInput({ question: 'What is your name?', field: 'name' });
    return { greeting: `Hello, ${String(answer.name ?? 'stranger')}!`, original: String(args.text ?? '') };
  });
  const task = engine.submit('ask-name', { text: 'hi' });
  const waiting = await waitFor(() => {
    const t = engine.get(task.taskId);
    return t.status === 'input-required' ? t : null;
  });
  assert.equal(waiting.rounds.length, 1);
  assert.deepEqual(waiting.rounds[0].request, { question: 'What is your name?', field: 'name' });

  // Polling get() never blocks: it returns the current state immediately.
  assert.equal(engine.get(task.taskId).status, 'input-required');

  const resumed = engine.update(task.taskId, { name: 'Huy' });
  assert.equal(resumed.status, 'working');
  assert.deepEqual(resumed.rounds[0].response, { name: 'Huy' });
  const done = await waitFor(() => {
    const t = engine.get(task.taskId);
    return t.status === 'completed' ? t : null;
  });
  assert.deepEqual(done.result, { greeting: 'Hello, Huy!', original: 'hi' });
  assert.throws(() => engine.update(task.taskId, { name: 'x' }), /only an input-required task/);
});

test('engine: cancel wakes a waiting runner; cancel of terminal task is a no-op', async () => {
  const engine = new McpV8TaskEngine();
  let runnerRejected = false;
  engine.registerRunner('waiter', async (_tool, _args, _task, control) => {
    try {
      await control.askInput({ question: 'wait?' });
      return { waited: true };
    } catch {
      runnerRejected = true;
      throw new Error('canceled while waiting');
    }
  });
  const task = engine.submit('waiter', {});
  await waitFor(() => {
    const t = engine.get(task.taskId);
    return t.status === 'input-required' ? t : null;
  });
  const canceled = engine.cancel(task.taskId);
  assert.equal(canceled.status, 'canceled');
  await waitFor(() => runnerRejected);
  assert.equal(engine.get(task.taskId).status, 'canceled');
  // Second cancel is a no-op on the terminal task.
  assert.equal(engine.cancel(task.taskId).status, 'canceled');
  assert.equal(engine.cancel(task.taskId).status, 'canceled');
  assert.throws(() => engine.cancel('nope'), /not known/);
});

test('engine: runner that returns while input is still open fails the task (no leak)', async () => {
  const engine = new McpV8TaskEngine();
  engine.registerRunner('fire-and-forget', async (_tool, _args, _task, control) => {
    void control.askInput({ question: 'never answered' });
    return { done: true };
  });
  const task = engine.submit('fire-and-forget', {});
  const failed = await waitFor(() => {
    const t = engine.get(task.taskId);
    return t.status === 'failed' ? t : null;
  });
  assert.match(failed.error ?? '', /while input was still open/);
});

test('engine: sweepOverdue fails timed-out waiters and wakes runners', async () => {
  let now = 3_000_000;
  const engine = new McpV8TaskEngine({ nowMs: () => now, inputTimeoutMs: 500 });
  engine.registerRunner('waiter', async (_tool, _args, _task, control) => {
    await control.askInput({ question: 'wait?' });
    return { waited: true };
  });
  const task = engine.submit('waiter', {});
  await waitFor(() => {
    const t = engine.get(task.taskId);
    return t.status === 'input-required' ? t : null;
  });
  now += 501;
  const swept = engine.sweepOverdue();
  assert.deepEqual(swept, [task.taskId]);
  assert.equal(engine.get(task.taskId).status, 'failed');
});
