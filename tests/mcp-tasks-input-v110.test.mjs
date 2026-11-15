/**
 * Test v1.10 T2: Tasks extension — client tự trả lời input_required
 * qua tasks/update (node:test). Local only, no live network: fake
 * JSON-RPC transports + McpTaskStore thật.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-tasks-input-v110.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTask,
  runTaskWithInput,
  TaskError,
  TaskHandle,
} from '../packages/core/dist/mcp/tasks.js';
import { McpTaskRunner } from '../packages/core/dist/mcp/tasksRunner.js';
import { McpTaskStore } from '../packages/core/dist/mcp/taskStore.js';

/** Fake transport driven by a script of tasks/get answers. */
function scriptedTaskTransport(script) {
  let i = 0;
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'tools/call') {
        return { taskId: 'task-1', status: 'working', pollInterval: 1 };
      }
      const step = script[i];
      i += 1;
      if (typeof step === 'function') return step(calls[calls.length - 1]);
      if (step === undefined) throw new Error(`script exhausted at ${method}`);
      return step;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('waitForCompletion auto-answers input_required via onInputRequired (2026)', async () => {
  const transport = scriptedTaskTransport([
    { taskId: 'task-1', status: 'input_required', pollInterval: 1 },
    { taskId: 'task-1', status: 'working', pollInterval: 1 },
    { taskId: 'task-1', status: 'completed', result: { ok: 'done' }, pollInterval: 1 },
  ]);
  const handle = await createTask(transport, 'tools/call', { name: 't' }, { specVersion: '2026-07-28' });
  let providerCalls = 0;
  const out = await handle.waitForCompletion({
    maxPollIntervalMs: 5,
    onInputRequired: async (task) => {
      providerCalls += 1;
      assert.equal(task.taskId, 'task-1');
      assert.equal(task.status, 'input_required');
      return { city: 'Hanoi' };
    },
  });
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.result, { ok: 'done' });
  assert.equal(providerCalls, 1);
  // tasks/update was sent with the provider answer, between the polls.
  const update = transport.calls.find((c) => c.method === 'tasks/update');
  assert.ok(update, 'tasks/update called');
  assert.deepEqual(update.params, { taskId: 'task-1', input: { city: 'Hanoi' } });
  assert.ok(!transport.calls.some((c) => c.method === 'tasks/result'), 'no tasks/result in 2026');
});

test('waitForCompletion without provider still throws a clear error (2026)', async () => {
  const transport = scriptedTaskTransport([
    { taskId: 'task-1', status: 'input_required', pollInterval: 1 },
  ]);
  const handle = await createTask(transport, 'tools/call', { name: 't' }, { specVersion: '2026-07-28' });
  await assert.rejects(
    () => handle.waitForCompletion({ maxPollIntervalMs: 5 }),
    (err) => err instanceof TaskError && /sendInput/.test(err.message),
  );
});

test('waitForCompletion: input_required on 2025 backend still throws (no tasks/update there)', async () => {
  const transport = scriptedTaskTransport([
    { taskId: 'task-1', status: 'input_required', pollInterval: 1 },
  ]);
  const handle = await createTask(transport, 'tools/call', { name: 't' }, { specVersion: '2025-11-25' });
  await assert.rejects(
    () => handle.waitForCompletion({
      maxPollIntervalMs: 5,
      onInputRequired: async () => ({ x: 1 }),
    }),
    (err) => err instanceof TaskError && /2025-11-25/.test(err.message),
  );
});

test('waitForCompletion: maxInputRounds stops an endless input loop', async () => {
  const script = Array.from({ length: 30 }, () => ({ taskId: 'task-1', status: 'input_required', pollInterval: 1 }));
  const transport = scriptedTaskTransport(script);
  const handle = await createTask(transport, 'tools/call', { name: 't' }, { specVersion: '2026-07-28' });
  let providerCalls = 0;
  await assert.rejects(
    () => handle.waitForCompletion({
      maxPollIntervalMs: 1,
      maxInputRounds: 2,
      onInputRequired: async () => {
        providerCalls += 1;
        return { x: providerCalls };
      },
    }),
    (err) => err instanceof TaskError && /quá 2 vòng/.test(err.message),
  );
  assert.equal(providerCalls, 2);
});

test('waitForCompletion: provider throwing aborts the wait with that error', async () => {
  const transport = scriptedTaskTransport([
    { taskId: 'task-1', status: 'input_required', pollInterval: 1 },
  ]);
  const handle = await createTask(transport, 'tools/call', { name: 't' }, { specVersion: '2026-07-28' });
  await assert.rejects(
    () => handle.waitForCompletion({
      maxPollIntervalMs: 5,
      onInputRequired: async () => {
        throw new Error('user refused to answer');
      },
    }),
    /user refused to answer/,
  );
});

test('runTaskWithInput: one-line create + wait + auto-answer', async () => {
  const transport = scriptedTaskTransport([
    { taskId: 'task-1', status: 'input_required', pollInterval: 1 },
    { taskId: 'task-1', status: 'working', pollInterval: 1 },
    { taskId: 'task-1', status: 'completed', result: 'all-done', pollInterval: 1 },
  ]);
  const result = await runTaskWithInput(
    transport,
    'tools/call',
    { name: 't' },
    async () => ({ answer: 'yes' }),
    { specVersion: '2026-07-28', maxPollIntervalMs: 5 },
  );
  assert.equal(result, 'all-done');
  const update = transport.calls.find((c) => c.method === 'tasks/update');
  assert.deepEqual(update.params.input, { answer: 'yes' });
});

test('McpTaskRunner.run: inputProvider answers input_required and finishes', async () => {
  const transport = scriptedTaskTransport([
    { taskId: 'task-1', status: 'input_required', pollInterval: 1 },
    { taskId: 'task-1', status: 'working', pollInterval: 1 },
    { taskId: 'task-1', status: 'completed', result: { done: true }, pollInterval: 1 },
  ]);
  const runner = new McpTaskRunner({ sleep: () => Promise.resolve() });
  const outcome = await runner.run(transport, 'tools/call', { name: 't' }, {
    specVersion: '2026-07-28',
    pollIntervalMs: 1,
    inputProvider: async () => ({ city: 'Hanoi' }),
  });
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.result, { done: true });
  const update = transport.calls.find((c) => c.method === 'tasks/update');
  assert.deepEqual(update.params, { taskId: 'task-1', input: { city: 'Hanoi' } });
});

test('McpTaskRunner.run: input_required without provider rejects (not retried)', async () => {
  const transport = scriptedTaskTransport([
    { taskId: 'task-1', status: 'input_required', pollInterval: 1 },
  ]);
  const runner = new McpTaskRunner({ sleep: () => Promise.resolve() });
  // input_required without a provider is a semantic error, not a
  // transient one: the runner must fail at once with the real cause
  // (not retry the task and die on a confusing poll error).
  await assert.rejects(
    () => runner.run(transport, 'tools/call', { name: 't' }, {
      specVersion: '2026-07-28',
      pollIntervalMs: 1,
    }),
    (err) => err instanceof TaskError && /input_required/.test(err.message),
  );
  assert.equal(transport.calls.filter((c) => c.method === 'tools/call').length, 1, 'no retry of task creation');
});

// --- taskStore.update schema validation (audit patch v1.10) ---------------

test('taskStore.update validates input against the stored schema', async () => {
  const store = new McpTaskStore();
  const schema = {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  };
  let waiterResolved;
  const handle = store.submit('tools/call', { name: 't' }, async (ctx) => {
    const answer = await ctx.requestInput('Which city?', schema);
    waiterResolved = answer;
    return { done: answer.city };
  });
  // Wait until the task parks in input_required.
  for (let i = 0; i < 50 && store.get(handle.taskId).status !== 'input_required'; i += 1) {
    await sleep(10);
  }
  assert.equal(store.get(handle.taskId).status, 'input_required');
  // Wrong type / missing required field => rejected, task stays parked.
  assert.throws(
    () => store.update(handle.taskId, { city: 42 }),
    /không khớp schema/,
  );
  assert.throws(
    () => store.update(handle.taskId, {}),
    /không khớp schema/,
  );
  assert.equal(store.get(handle.taskId).status, 'input_required');
  // Valid input resumes the task.
  const updated = store.update(handle.taskId, { city: 'Hanoi' });
  assert.equal(updated.status, 'working');
  for (let i = 0; i < 50 && store.get(handle.taskId).status !== 'completed'; i += 1) {
    await sleep(10);
  }
  assert.equal(store.get(handle.taskId).status, 'completed');
  assert.deepEqual(store.get(handle.taskId).result, { done: 'Hanoi' });
  assert.deepEqual(waiterResolved, { city: 'Hanoi' });
});

test('taskStore.update without a schema still accepts any object', async () => {
  const store = new McpTaskStore();
  const handle = store.submit('tools/call', { name: 't' }, async (ctx) => {
    const answer = await ctx.requestInput('Anything?');
    return answer;
  });
  for (let i = 0; i < 50 && store.get(handle.taskId).status !== 'input_required'; i += 1) {
    await sleep(10);
  }
  const updated = store.update(handle.taskId, { free: 'form' });
  assert.equal(updated.status, 'working');
});

// --- TaskHandle.sendInput still guards the 2025 backend -------------------

test('TaskHandle.sendInput throws on the 2025 backend', async () => {
  const transport = scriptedTaskTransport([]);
  const handle = new TaskHandle(
    transport,
    { taskId: 'task-1', status: 'input_required' },
    { specVersion: '2025-11-25' },
  );
  await assert.rejects(
    () => handle.sendInput({ x: 1 }),
    (err) => err instanceof TaskError && /2025-11-25/.test(err.message),
  );
});
