/**
 * Test v1.06 T2: server-directed tasks (node:test).
 * Local only: fake task transport + real McpTaskManager, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v106-server-directed-tasks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isServerDirectedTaskTerminal,
  parseServerDirectedTaskNotification,
  ServerDirectedTaskWatcher,
  SERVER_DIRECTED_TASK_NOTIFICATIONS,
} from '../packages/core/dist/mcp/serverDirectedTasks.js';
import { McpTaskManager } from '../packages/core/dist/mcp/taskManager.js';

/**
 * Fake Tasks-extension transport (2026-07-28): each task has a scripted
 * status sequence; tasks/get walks it; tasks/cancel marks cancelled.
 */
function fakeTaskTransport(scripts = {}) {
  const tasks = new Map();
  const calls = [];
  const transport = {
    calls,
    tasks,
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === 'tasks/get') {
        const task = tasks.get(params.taskId);
        if (!task) throw new Error(`no such task ${params.taskId}`);
        const next = task.sequence[Math.min(task.index, task.sequence.length - 1)];
        task.index += 1;
        return { taskId: params.taskId, status: next.status, pollInterval: 5, result: next.result };
      }
      if (method === 'tasks/cancel') {
        const task = tasks.get(params.taskId);
        if (task) task.cancelled = true;
        return { taskId: params.taskId, status: 'cancelled' };
      }
      if (method === 'tasks/update') {
        return { taskId: params.taskId, status: 'working', pollInterval: 5 };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  for (const [id, sequence] of Object.entries(scripts)) {
    tasks.set(id, { sequence, index: 0, cancelled: false });
  }
  return transport;
}

function watcherWithServer(scripts = {}, options = {}) {
  const manager = new McpTaskManager({ maxTracked: 10 });
  const transport = fakeTaskTransport(scripts);
  const events = [];
  const watcher = new ServerDirectedTaskWatcher({
    manager,
    onEvent: (e) => events.push(e),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
  });
  watcher.registerServer('srv-tasks', { transport, specVersion: '2026-07-28' });
  return { manager, transport, events, watcher };
}

test('server-directed tasks: notification method names', () => {
  assert.equal(SERVER_DIRECTED_TASK_NOTIFICATIONS.created, 'notifications/tasks/created');
  assert.equal(SERVER_DIRECTED_TASK_NOTIFICATIONS.updated, 'notifications/tasks/updated');
  assert.equal(SERVER_DIRECTED_TASK_NOTIFICATIONS.cancelled, 'notifications/tasks/cancelled');
  assert.equal(isServerDirectedTaskTerminal('completed'), true);
  assert.equal(isServerDirectedTaskTerminal('failed'), true);
  assert.equal(isServerDirectedTaskTerminal('cancelled'), true);
  assert.equal(isServerDirectedTaskTerminal('working'), false);
  assert.equal(isServerDirectedTaskTerminal('input_required'), false);
});

test('server-directed tasks: parse notification — defaults + errors', () => {
  const parsed = parseServerDirectedTaskNotification({
    taskId: 't-1',
    status: 'working',
    pollInterval: 250,
    method: 'tools/call',
    label: 'Long job',
  });
  assert.equal(parsed.data.taskId, 't-1');
  assert.equal(parsed.data.status, 'working');
  assert.equal(parsed.data.pollInterval, 250);
  assert.equal(parsed.label, 'Long job');
  const minimal = parseServerDirectedTaskNotification({ taskId: 't-2', status: 'completed' });
  assert.equal(minimal.method, 'tools/call');
  assert.equal(minimal.label, 'Task t-2');
  assert.throws(() => parseServerDirectedTaskNotification({ status: 'working' }), /taskId/);
  assert.throws(() => parseServerDirectedTaskNotification({ taskId: 't', status: 'weird' }), /trạng thái/);
  assert.throws(() => parseServerDirectedTaskNotification('nope'), /object/);
});

test('server-directed tasks: created notification adopts + polls to completion', async () => {
  const { manager, events, watcher } = watcherWithServer({
    'task-1': [{ status: 'working' }, { status: 'completed', result: { text: 'done!' } }],
  });
  const handled = watcher.handleNotification('srv-tasks', 'notifications/tasks/created', {
    taskId: 'task-1',
    status: 'working',
    pollInterval: 5,
    method: 'tools/call',
    label: 'Summarize',
  });
  assert.equal(handled, true);
  assert.equal(watcher.adopted, 1);
  const snapshot = await manager.waitFor('srv-tasks:task-1');
  assert.equal(snapshot.status, 'completed');
  assert.deepEqual(snapshot.result, { text: 'done!' });
  assert.equal(snapshot.label, 'Summarize');
  assert.equal(events.some((e) => e.kind === 'adopted' && e.taskId === 'task-1'), true);
});

test('server-directed tasks: duplicate created notification is ignored', async () => {
  const { manager, events, watcher } = watcherWithServer({
    'task-1': [{ status: 'completed', result: 42 }],
  });
  const params = { taskId: 'task-1', status: 'working', pollInterval: 5 };
  watcher.handleNotification('srv-tasks', 'notifications/tasks/created', params);
  const second = watcher.handleNotification('srv-tasks', 'notifications/tasks/created', params);
  assert.equal(second, true);
  assert.equal(watcher.adopted, 1);
  assert.equal(events.filter((e) => e.kind === 'duplicate').length, 1);
  const snapshot = await manager.waitFor('srv-tasks:task-1');
  assert.equal(snapshot.status, 'completed');
});

test('server-directed tasks: adoptTaskFromResult picks up a handle in a tool result', async () => {
  const { manager, watcher } = watcherWithServer({
    'task-9': [{ status: 'completed', result: 'from-result' }],
  });
  const adopted = watcher.adoptTaskFromResult('srv-tasks', 'tools/call', {
    taskId: 'task-9',
    status: 'working',
    pollInterval: 5,
  });
  assert.ok(adopted);
  assert.equal(adopted.taskId, 'task-9');
  const snapshot = await manager.waitFor('srv-tasks:task-9');
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.result, 'from-result');
  // A plain result is not a task — nothing adopted.
  assert.equal(
    watcher.adoptTaskFromResult('srv-tasks', 'tools/call', { content: [{ text: 'hi' }] }),
    null,
  );
  assert.equal(
    watcher.adoptTaskFromResult('srv-tasks', 'tools/call', { taskId: 'x', status: 'bogus' }),
    null,
  );
});

test('server-directed tasks: updated notification polls immediately', async () => {
  const { manager, transport, events, watcher } = watcherWithServer({
    'task-2': [{ status: 'working' }, { status: 'completed', result: 'v2' }],
  });
  watcher.handleNotification('srv-tasks', 'notifications/tasks/created', {
    taskId: 'task-2',
    status: 'working',
    pollInterval: 5000,
    label: 'Slow job',
  });
  // Give the manager loop a moment, then simulate a server update.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const getsBefore = transport.calls.filter((c) => c.method === 'tasks/get').length;
  watcher.handleNotification('srv-tasks', 'notifications/tasks/updated', {
    taskId: 'task-2',
    status: 'working',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const getsAfter = transport.calls.filter((c) => c.method === 'tasks/get').length;
  assert.ok(getsAfter > getsBefore, 'updated should trigger an extra poll');
  assert.equal(events.some((e) => e.kind === 'updated' && e.taskId === 'task-2'), true);
  const snapshot = await manager.waitFor('srv-tasks:task-2');
  assert.equal(snapshot.status, 'completed');
});

test('server-directed tasks: cancelled notification stops the local wait', async () => {
  const { manager, transport, events, watcher } = watcherWithServer({
    'task-3': [{ status: 'working' }, { status: 'working' }],
  });
  watcher.handleNotification('srv-tasks', 'notifications/tasks/created', {
    taskId: 'task-3',
    status: 'working',
    pollInterval: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  watcher.handleNotification('srv-tasks', 'notifications/tasks/cancelled', {
    taskId: 'task-3',
    reason: 'user asked the server to stop',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const snapshot = manager.get('srv-tasks:task-3');
  assert.equal(snapshot.status, 'cancelled');
  assert.equal(events.some((e) => e.kind === 'cancelled' && e.taskId === 'task-3'), true);
  assert.equal(transport.tasks.get('task-3').cancelled, true);
});

test('server-directed tasks: unknown server / invalid params are events, not throws', () => {
  const { events, watcher } = watcherWithServer({});
  assert.equal(
    watcher.handleNotification('srv-ghost', 'notifications/tasks/created', {
      taskId: 't-x',
      status: 'working',
    }),
    true,
  );
  assert.equal(events.some((e) => e.kind === 'unknown-server'), true);
  assert.equal(watcher.adopted, 0);
  assert.equal(
    watcher.handleNotification('srv-tasks', 'notifications/tasks/created', { nope: true }),
    true,
  );
  assert.equal(events.some((e) => e.kind === 'invalid'), true);
  assert.equal(watcher.handleNotification('srv-tasks', 'notifications/other', {}), false);
});

test('server-directed tasks: register/unregister server, getTask, cancelTask', async () => {
  const { manager, watcher } = watcherWithServer({
    'task-5': [{ status: 'completed', result: 'ok' }],
  });
  assert.equal(watcher.serverCount, 1);
  watcher.handleNotification('srv-tasks', 'notifications/tasks/created', {
    taskId: 'task-5',
    status: 'working',
    pollInterval: 5,
  });
  assert.ok(watcher.getTask('srv-tasks', 'task-5'));
  assert.equal(watcher.listTasks().length, 1);
  const snapshot = await manager.waitFor('srv-tasks:task-5');
  assert.equal(snapshot.status, 'completed');
  assert.equal(watcher.unregisterServer('srv-tasks'), true);
  assert.equal(watcher.serverCount, 0);
  assert.equal(watcher.unregisterServer('srv-tasks'), false);
  const cancelled = await watcher.cancelTask('srv-tasks', 'task-5');
  assert.equal(cancelled.status, 'completed');
});
