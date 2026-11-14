/**
 * Test v1.04 T2: client-side Tasks backend follows the negotiated
 * protocol version (node:test). Local only, fake JSON-RPC transports.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v104-tasks-client.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clientTasksSpecVersion,
  createTaskForClient,
} from '../packages/core/dist/mcp/clientAdapters.js';
import { tasksSpecVersionForProtocol } from '../packages/core/dist/mcp/tasks.js';

/** Fake client: only the surface the adapter reads. */
function fakeClient(protocolVersion, script) {
  const calls = [];
  return {
    calls,
    negotiatedProtocolVersion: protocolVersion,
    async requestJsonRpc(method, params) {
      calls.push({ method, params });
      const step = script[calls.length - 1];
      if (typeof step === 'function') return step(calls[calls.length - 1]);
      return step;
    },
  };
}

test('tasksSpecVersionForProtocol: only 2026-07-28 speaks Tasks 2026', () => {
  assert.equal(tasksSpecVersionForProtocol('2026-07-28'), '2026-07-28');
  assert.equal(tasksSpecVersionForProtocol('2025-11-25'), '2025-11-25');
  assert.equal(tasksSpecVersionForProtocol('2025-06-18'), '2025-11-25');
  assert.equal(tasksSpecVersionForProtocol(undefined), '2025-11-25');
});

test('clientTasksSpecVersion reads the negotiated protocol version', () => {
  assert.equal(clientTasksSpecVersion({ negotiatedProtocolVersion: '2026-07-28' }), '2026-07-28');
  assert.equal(clientTasksSpecVersion({ negotiatedProtocolVersion: '2025-11-25' }), '2025-11-25');
  assert.equal(clientTasksSpecVersion({}), '2025-11-25');
});

test('createTaskForClient on a 2026 client: result comes from tasks/get, never tasks/result', async () => {
  const client = fakeClient('2026-07-28', [
    // createTask: server returns a working handle at once.
    { taskId: 't-1', status: 'working', pollInterval: 1 },
    // waitForCompletion poll: completed, result inline (2026 shape).
    { taskId: 't-1', status: 'completed', pollInterval: 1, result: { answer: 42 } },
  ]);
  const handle = await createTaskForClient(client, 'tools/call', { name: 'slow' });
  assert.equal(handle.specVersion, '2026-07-28');
  const done = await handle.waitForCompletion({ timeoutMs: 5000 });
  assert.deepEqual(done, { status: 'completed', result: { answer: 42 } });
  const methods = client.calls.map((c) => c.method);
  assert.deepEqual(methods, ['tools/call', 'tasks/get']);
  assert.ok(!methods.includes('tasks/result'));
});

test('createTaskForClient on a 2025 client: result comes from blocking tasks/result', async () => {
  const client = fakeClient('2025-11-25', [
    { taskId: 't-2', status: 'working', pollInterval: 1 },
    { taskId: 't-2', status: 'completed', pollInterval: 1 },
    // tasks/result (blocking): the final result.
    { result: { answer: 7 } },
  ]);
  const handle = await createTaskForClient(client, 'tools/call', { name: 'slow' });
  assert.equal(handle.specVersion, '2025-11-25');
  const done = await handle.waitForCompletion({ timeoutMs: 5000 });
  assert.deepEqual(done, { status: 'completed', result: { result: { answer: 7 } } });
  const methods = client.calls.map((c) => c.method);
  assert.deepEqual(methods, ['tools/call', 'tasks/get', 'tasks/result']);
});

test('createTaskForClient: explicit specVersion overrides the negotiated one', async () => {
  const client = fakeClient('2026-07-28', [
    { taskId: 't-3', status: 'working', pollInterval: 1 },
    { taskId: 't-3', status: 'completed', pollInterval: 1 },
    { result: { answer: 1 } },
  ]);
  const handle = await createTaskForClient(client, 'tools/call', {}, { specVersion: '2025-11-25' });
  assert.equal(handle.specVersion, '2025-11-25');
  await handle.waitForCompletion({ timeoutMs: 5000 });
  assert.ok(client.calls.map((c) => c.method).includes('tasks/result'));
});

test('createTaskForClient on a 2026 client: sendInput uses tasks/update', async () => {
  const client = fakeClient('2026-07-28', [
    { taskId: 't-4', status: 'input_required', pollInterval: 1 },
    { taskId: 't-4', status: 'working', pollInterval: 1 },
  ]);
  const handle = await createTaskForClient(client, 'tools/call', { name: 'ask' });
  const updated = await handle.sendInput({ name: 'Huy' });
  assert.equal(updated.status, 'working');
  assert.equal(client.calls[1].method, 'tasks/update');
  assert.deepEqual(client.calls[1].params.input, { name: 'Huy' });
});
