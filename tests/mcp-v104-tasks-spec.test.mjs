/**
 * Test v1.04 T2: Tasks extension spec gating (node:test).
 * Local only: pure gating functions + the built-in McpServer driven
 * over `handleJsonRpc` (no transport, no network).
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v104-tasks-spec.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkTasksMethodAllowed,
  describeTasksSpecVersion,
  isTasksMethodRemovedIn2026,
  resolveTasksSpecVersion,
  tasksGetReturnsResult,
  tasksMethodsFor,
  tasksRemovedMethodNote,
  tasksUpdateSupported,
  MCP_TASKS_METHODS_2026,
  McpTasksSpecError,
} from '../packages/core/dist/mcp/tasksSpec.js';
import { McpServer } from '../packages/core/dist/mcp/server.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(server, id, method, params) {
  return server.handleJsonRpc({ jsonrpc: '2.0', id, method, params });
}

async function initialize(server) {
  const res = await rpc(server, 0, 'initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(res.error, undefined);
}

test('gating: 2026 removes tasks/list + tasks/result, keeps get/update/cancel', () => {
  assert.deepEqual([...tasksMethodsFor('2026-07-28')], MCP_TASKS_METHODS_2026);
  assert.equal(isTasksMethodRemovedIn2026('tasks/list'), true);
  assert.equal(isTasksMethodRemovedIn2026('tasks/result'), true);
  assert.equal(isTasksMethodRemovedIn2026('tasks/get'), false);
  assert.equal(tasksGetReturnsResult('2026-07-28'), true);
  assert.equal(tasksGetReturnsResult('2025-11-25'), false);
  assert.equal(tasksUpdateSupported('2026-07-28'), true);
  assert.equal(tasksUpdateSupported('2025-11-25'), false);

  const blocked = checkTasksMethodAllowed('tasks/list', '2026-07-28');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.error instanceof McpTasksSpecError);
  assert.match(blocked.error.message, /tasks\/get/);
  assert.equal(checkTasksMethodAllowed('tasks/get', '2026-07-28').allowed, true);
  assert.equal(checkTasksMethodAllowed('tasks/result', '2025-11-25').allowed, true);
  assert.equal(checkTasksMethodAllowed('tasks/nope', '2026-07-28').allowed, false);
});

test('resolveTasksSpecVersion: unknown input defaults to 2026-07-28', () => {
  assert.equal(resolveTasksSpecVersion(undefined), '2026-07-28');
  assert.equal(resolveTasksSpecVersion('bogus'), '2026-07-28');
  assert.equal(resolveTasksSpecVersion('2025-11-25'), '2025-11-25');
  assert.match(tasksRemovedMethodNote('tasks/result'), /tasks\/get/);
  assert.match(describeTasksSpecVersion('2026-07-28'), /không có tasks\/list/);
});

test('server: tasks shape follows negotiated version — 2025 client keeps 2025 tasks (compat)', async () => {
  const server = new McpServer({ name: 'test-2025-negotiated' });
  // No explicit tasksSpecVersion: initialize with 2025-11-25 must
  // keep tasks/list + tasks/result working (old clients must not break).
  const res = await rpc(server, 0, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'old', version: '1' },
  });
  assert.equal(res.error, undefined);
  assert.equal(server.getTasksSpecVersion(), '2025-11-25');
  const listed = await rpc(server, 1, 'tasks/list', {});
  assert.equal(listed.error, undefined);
  assert.deepEqual(listed.result.tasks, []);
});

test('server 2026 (default): tasks/list + tasks/result answer -32601 with migration hint', async () => {
  const server = new McpServer({ name: 'test-2026' });
  // Before any negotiation the effective version is the server
  // default (2025); after initialize with 2026-07-28 it is 2026.
  assert.equal(server.getTasksSpecVersion(), '2025-11-25');
  await initialize(server);
  assert.equal(server.getTasksSpecVersion(), '2026-07-28');

  const list = await rpc(server, 1, 'tasks/list', {});
  assert.equal(list.error.code, -32601);
  assert.match(list.error.message, /tasks\/list.*đã bị bỏ/);
  assert.match(list.error.message, /tasks\/get/);

  const result = await rpc(server, 2, 'tasks/result', { taskId: 'nope' });
  assert.equal(result.error.code, -32601);
  assert.match(result.error.message, /tasks\/result.*đã bị bỏ/);
});

test('server 2025: tasks/list + tasks/result still served (compat)', async () => {
  const server = new McpServer({ name: 'test-2025', tasksSpecVersion: '2025-11-25' });
  assert.equal(server.getTasksSpecVersion(), '2025-11-25');
  await initialize(server);

  const list = await rpc(server, 1, 'tasks/list', {});
  assert.equal(list.error, undefined);
  assert.deepEqual(list.result.tasks, []);

  // Unknown task on the 2025 shape: -32602 (invalid params), not -32601.
  const result = await rpc(server, 2, 'tasks/result', { taskId: 'missing' });
  assert.equal(result.error.code, -32602);
});

test('server 2026: tasks/get returns the final result on completion; tasks/update feeds input_required', async () => {
  const server = new McpServer({ name: 'test-2026-flow' });
  await initialize(server);

  const handle = server.submitLongTask('tools/call', { name: 'ask' }, async (ctx) => {
    const input = await ctx.requestInput('Tên của bạn?');
    return { greeting: `xin chào ${input['name'] ?? '?'}` };
  });
  // The runner parks synchronously during submit (requestInput sets
  // input_required before the first await), so the returned handle
  // may already be parked — either state is a correct start.
  assert.ok(handle.status === 'working' || handle.status === 'input_required');

  // Wait until the runner parks in input_required.
  for (let i = 0; i < 50; i++) {
    const got = await rpc(server, 10, 'tasks/get', { taskId: handle.taskId });
    if (got.result.status === 'input_required') break;
    await sleep(10);
  }
  const parked = await rpc(server, 11, 'tasks/get', { taskId: handle.taskId });
  assert.equal(parked.result.status, 'input_required');

  const updated = await rpc(server, 12, 'tasks/update', {
    taskId: handle.taskId,
    input: { name: 'Huy' },
  });
  assert.equal(updated.error, undefined);
  assert.equal(updated.result.status, 'working');

  // tasks/get now returns the final result directly (2026 shape).
  for (let i = 0; i < 50; i++) {
    const got = await rpc(server, 13, 'tasks/get', { taskId: handle.taskId });
    if (got.result.status === 'completed') break;
    await sleep(10);
  }
  const done = await rpc(server, 14, 'tasks/get', { taskId: handle.taskId });
  assert.equal(done.result.status, 'completed');
  assert.deepEqual(done.result.result, { greeting: 'xin chào Huy' });
});

test('server: MRTR tool result passes through tools/call unwrapped', async () => {
  const server = new McpServer({
    name: 'test-mrtr-server',
    tools: [
      {
        name: 'ask-city',
        description: 'Asks for the city, then answers.',
        handler: (args) => {
          if (!args['city']) {
            return {
              resultType: 'needs_input',
              need: { prompt: 'City?' },
              roundTripId: 'rt-city',
            };
          }
          return `weather in ${args['city']}`;
        },
      },
    ],
  });
  await initialize(server);

  const first = await rpc(server, 1, 'tools/call', { name: 'ask-city', arguments: {} });
  assert.equal(first.error, undefined);
  assert.equal(first.result.resultType, 'needs_input');
  assert.equal(first.result.roundTripId, 'rt-city');
  assert.equal(first.result.content, undefined);

  const second = await rpc(server, 2, 'tools/call', {
    name: 'ask-city',
    arguments: { city: 'Hanoi' },
  });
  assert.equal(second.result.content[0].text, 'weather in Hanoi');
});
