/**
 * Test v1.05 T2: Tasks lifecycle — progress events, server-directed
 * tasks, persistent task store (node:test, không mạng).
 *
 * Covers:
 *  - packages/core/src/mcp/taskProgress.ts: emitter, tracker,
 *    server-directed handler, push notification parse
 *  - packages/core/src/mcp/taskStorePersistent.ts: save/load JSON,
 *    interrupted tasks -> failed, corrupt file handling
 *  - packages/core/src/mcp/taskStore.ts restore()
 *
 * Build core trước:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v105-tasks-lifecycle.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  McpTaskProgressEmitter,
  McpTaskProgressTracker,
  ServerDirectedTaskHandler,
  checkServerDirectedMethodAllowed,
  parseServerDirectedTaskRequest,
  parseTaskHandleWithProgress,
} from '../packages/core/dist/mcp/taskProgress.js';
import { PersistentMcpTaskStore } from '../packages/core/dist/mcp/taskStorePersistent.js';
import { McpTaskStore } from '../packages/core/dist/mcp/taskStore.js';
import { TaskHandle, createTask } from '../packages/core/dist/mcp/tasks.js';
import { McpTaskManager } from '../packages/core/dist/mcp/taskManager.js';
import { createMcpDispatcher } from '../packages/core/dist/mcp/dispatcher.js';
import {
  buildMcpClientCapabilities,
  registerDefaultMcpClientHandlers,
} from '../packages/core/dist/mcp/clientHandlers.js';

function pollingTransport(statuses, resultPayload) {
  const calls = [];
  const counters = new Map();
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      const n = (counters.get(method) ?? 0) + 1;
      counters.set(method, n);
      if (method === 'tasks/get') {
        const status = statuses[Math.min(n - 1, statuses.length - 1)];
        const out = { taskId: 't-1', status, pollInterval: 1 };
        if (status === 'completed') out.result = resultPayload;
        if (status === 'working' && n === 2) {
          out.progress = 0.5;
          out.progressMessage = 'nửa chặng';
        }
        return out;
      }
      if (method === 'tasks/result') return resultPayload;
      if (method === 'tasks/cancel') return { taskId: 't-1', status: 'cancelled' };
      if (method === 'tasks/update') return { taskId: 't-1', status: 'working', pollInterval: 1 };
      if (method === 'tools/call') return { taskId: 't-1', status: 'working', pollInterval: 1 };
      throw new Error(`unexpected ${method}`);
    },
  };
}

test('emitter: subscribe/unsubscribe, wildcard, listener errors collected', () => {
  const emitter = new McpTaskProgressEmitter();
  const seen = [];
  const unsub = emitter.subscribe('t-1', (e) => seen.push(['t-1', e.kind]));
  emitter.subscribe('*', (e) => seen.push(['*', e.kind]));
  emitter.subscribe('t-2', () => {
    throw new Error('listener boom');
  });
  emitter.emit({
    taskId: 't-1',
    status: 'working',
    atMs: 0,
    source: 'poll',
    kind: 'status',
  });
  emitter.emit({
    taskId: 't-2',
    status: 'working',
    atMs: 0,
    source: 'poll',
    kind: 'status',
  });
  assert.deepEqual(seen, [
    ['t-1', 'status'],
    ['*', 'status'],
    ['*', 'status'],
  ]);
  assert.equal(emitter.listenerErrors.length, 1);
  assert.equal(emitter.listenerCount, 3);
  unsub();
  assert.equal(emitter.listenerCount, 2);
  emitter.clear();
  assert.equal(emitter.listenerCount, 0);
});

test('tracker: emits status + progress events, completes with result (2026)', async () => {
  const transport = pollingTransport(['working', 'working', 'completed'], { done: true });
  const handle = await createTask(
    transport,
    'tools/call',
    { name: 'slow', arguments: {} },
    { specVersion: '2026-07-28', pollIntervalMs: 1 },
  );
  const emitter = new McpTaskProgressEmitter();
  const events = [];
  emitter.subscribe('*', (e) => events.push(e));
  const tracker = new McpTaskProgressTracker(handle, emitter, { maxPollIntervalMs: 5 });
  const outcome = await tracker.trackToCompletion({ timeoutMs: 5000 });
  assert.deepEqual(outcome, { status: 'completed', result: { done: true } });
  assert.equal(tracker.isStopped, true);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('progress'));
  assert.ok(kinds.includes('terminal'));
  const progressEvent = events.find((e) => e.kind === 'progress');
  assert.equal(progressEvent.progress, 0.5);
  assert.equal(progressEvent.progressMessage, 'nửa chặng');
  assert.equal(progressEvent.source, 'poll');
  const terminal = events.find((e) => e.kind === 'terminal');
  assert.equal(terminal.status, 'completed');
});

test('tracker: failed task throws and emits terminal', async () => {
  const transport = pollingTransport(['working', 'failed'], null);
  const handle = await createTask(
    transport,
    'tools/call',
    { name: 'slow', arguments: {} },
    { specVersion: '2026-07-28', pollIntervalMs: 1 },
  );
  const emitter = new McpTaskProgressEmitter();
  const events = [];
  emitter.subscribe('*', (e) => events.push(e));
  const tracker = new McpTaskProgressTracker(handle, emitter, { maxPollIntervalMs: 5 });
  await assert.rejects(() => tracker.trackToCompletion({ timeoutMs: 5000 }), /báo thất bại/);
  assert.equal(events.at(-1).kind, 'terminal');
  assert.equal(events.at(-1).status, 'failed');
});

test('tracker: server push notification parsed and emitted', async () => {
  const transport = pollingTransport(['working'], null);
  const handle = new TaskHandle(
    transport,
    { taskId: 't-1', status: 'working', pollInterval: 1 },
    { specVersion: '2026-07-28' },
  );
  const emitter = new McpTaskProgressEmitter();
  const events = [];
  emitter.subscribe('*', (e) => events.push(e));
  const tracker = new McpTaskProgressTracker(handle, emitter);
  const ok = tracker.handlePushNotification('notifications/tasks/progress', {
    taskId: 't-1',
    status: 'working',
    progress: 0.25,
    progressMessage: 'đang xử lý',
  });
  assert.equal(ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'push');
  assert.equal(events[0].progress, 0.25);
  assert.equal(events[0].progressMessage, 'đang xử lý');
  // Wrong task id / wrong method are ignored.
  assert.equal(
    tracker.handlePushNotification('notifications/tasks/progress', {
      taskId: 'other',
      status: 'working',
    }),
    false,
  );
  assert.equal(tracker.handlePushNotification('notifications/message', {}), false);
  assert.equal(events.length, 1);
  // Terminal push stops the tracker.
  tracker.handlePushNotification('notifications/tasks/progress', {
    taskId: 't-1',
    status: 'completed',
    progress: 1,
  });
  assert.equal(tracker.isStopped, true);
  // buildProgressNotification round-trips.
  const note = McpTaskProgressTracker.buildProgressNotification('t-9', 'working', 0.3, 'x');
  assert.equal(note.method, 'notifications/tasks/progress');
  assert.equal(note.params.taskId, 't-9');
  assert.equal(note.params.progress, 0.3);
});

test('parseTaskHandleWithProgress splits progress fields', () => {
  const { handle, progress, progressMessage } = parseTaskHandleWithProgress({
    taskId: 't-1',
    status: 'working',
    progress: 0.7,
    progressMessage: 'gần xong',
  });
  assert.equal(handle.taskId, 't-1');
  assert.equal(progress, 0.7);
  assert.equal(progressMessage, 'gần xong');
  const plain = parseTaskHandleWithProgress({ taskId: 't-2', status: 'completed', result: 1 });
  assert.equal(plain.progress, undefined);
  assert.equal(plain.handle.result, 1);
});

test('server-directed task: parse + policy + handle + prune + cancelAll', async () => {
  const transport = pollingTransport(['working', 'completed'], { ok: 1 });
  const handler = new ServerDirectedTaskHandler(transport, {}, new McpTaskProgressEmitter());
  const req = parseServerDirectedTaskRequest({
    method: 'tools/call',
    params: { name: 'job', arguments: {} },
    label: 'job dài',
    serverTaskId: 'srv-1',
  });
  assert.equal(req.method, 'tools/call');
  assert.equal(req.label, 'job dài');
  assert.equal(req.serverTaskId, 'srv-1');
  assert.throws(
    () => parseServerDirectedTaskRequest({ method: '' }),
    /thiếu "method"/,
  );
  assert.throws(
    () => parseServerDirectedTaskRequest({ method: 'tools/call; rm -rf /' }),
    /không hợp lệ/,
  );

  // Policy: tools/call allowed by default; anything else denied.
  assert.deepEqual(checkServerDirectedMethodAllowed('tools/call'), { allowed: true });
  assert.equal(checkServerDirectedMethodAllowed('resources/read').allowed, false);
  assert.equal(
    checkServerDirectedMethodAllowed('tools/call', { deniedMethods: ['tools/call'] }).allowed,
    false,
  );

  const outcome = await handler.handle(
    { method: 'tools/call', params: { name: 'job', arguments: {} } },
    { specVersion: '2026-07-28' },
  );
  assert.equal(outcome.handle.taskId, 't-1');
  assert.equal(handler.runningCount, 1);
  assert.equal(handler.get('t-1'), outcome);
  assert.ok(outcome.tracker instanceof McpTaskProgressTracker);

  // Concurrency cap.
  const capped = new ServerDirectedTaskHandler(transport, { maxConcurrent: 1 });
  await capped.handle(
    { method: 'tools/call', params: { name: 'job', arguments: {} } },
    { specVersion: '2026-07-28' },
  );
  await assert.rejects(
    () =>
      capped.handle(
        { method: 'tools/call', params: { name: 'job', arguments: {} } },
        { specVersion: '2026-07-28' },
      ),
    /đang chạy/,
  );
  const cancelled = await capped.cancelAll();
  assert.deepEqual(cancelled.cancelled, ['t-1']);
  assert.equal(capped.runningCount, 0);
});

test('persistent store: save/load round-trip, interrupted -> failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tasks-v105-'));
  const filePath = path.join(dir, 'tasks.json');
  const store = new PersistentMcpTaskStore({ filePath, nowMs: () => 1000 });
  assert.equal(store.load(), 0);
  // Completed task (runner returns at once).
  const h1 = store.submit('tools/call', { name: 'a' }, async () => ({ done: 'a' }));
  assert.equal(h1.status, 'working');
  // Working task that never finishes before save.
  store.submit('tools/call', { name: 'b' }, async () => new Promise(() => undefined));
  await new Promise((r) => setTimeout(r, 20));
  const saved = store.save();
  assert.equal(saved, 2);
  assert.ok(fs.existsSync(filePath));
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.tasks.length, 2);

  const store2 = new PersistentMcpTaskStore({ filePath, nowMs: () => 2000 });
  const restored = store2.load();
  assert.equal(restored, 2);
  assert.equal(store2.recoveredInterruptedCount, 1);
  const tasks = store2.list();
  assert.equal(tasks.length, 2);
  const completed = tasks.find((t) => t.method === 'tools/call' && t.params.name === 'a');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { done: 'a' });
  const interrupted = tasks.find((t) => t.params.name === 'b');
  assert.equal(interrupted.status, 'failed');
  assert.match(interrupted.error, /server đã restart/);
  // toHandleData for a restored task works.
  const handleData = store2.toHandleData(interrupted);
  assert.equal(handleData.status, 'failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('persistent store: corrupt file -> empty store + onCorrupt, no crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tasks-v105-'));
  const filePath = path.join(dir, 'tasks.json');
  fs.writeFileSync(filePath, '{not json', 'utf8');
  let corruptCalled = false;
  const store = new PersistentMcpTaskStore({
    filePath,
    onCorrupt: () => {
      corruptCalled = true;
    },
  });
  assert.equal(store.load(), 0);
  assert.equal(corruptCalled, true);
  assert.equal(store.size, 0);
  // Missing file is fine too.
  const store2 = new PersistentMcpTaskStore({ filePath: path.join(dir, 'nope.json') });
  assert.equal(store2.load(), 0);
  // clearSnapshot removes the file.
  assert.equal(store.clearSnapshot(), true);
  assert.equal(store.clearSnapshot(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('persistent store: maxPersistedTasks caps the snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tasks-v105-'));
  const filePath = path.join(dir, 'tasks.json');
  const store = new PersistentMcpTaskStore({ filePath, maxPersistedTasks: 2, autosave: false });
  for (let i = 0; i < 4; i += 1) {
    store.submit('tools/call', { name: `t${i}` }, async () => i);
  }
  const saved = store.save();
  assert.equal(saved, 2);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(parsed.tasks.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('taskStore.restore: expired records skipped, overwrite works', () => {
  const store = new McpTaskStore({ nowMs: () => 5000 });
  const ok = store.restore({
    taskId: 'r-1',
    method: 'tools/call',
    params: {},
    status: 'completed',
    result: 7,
    createdAtMs: 1000,
    updatedAtMs: 2000,
    expiresAtMs: 10_000,
  });
  assert.equal(ok, true);
  assert.equal(store.get('r-1').result, 7);
  const expired = store.restore({
    taskId: 'r-2',
    method: 'tools/call',
    params: {},
    status: 'completed',
    createdAtMs: 1000,
    updatedAtMs: 2000,
    expiresAtMs: 4000,
  });
  assert.equal(expired, false);
  assert.throws(() => store.get('r-2'), /Unknown task/);
});

test('taskManager: progress flows into snapshot + origin recorded', async () => {
  const transport = pollingTransport(['working', 'working', 'completed'], { done: true });
  const manager = new McpTaskManager();
  const created = await manager.create(
    transport,
    'tools/call',
    { name: 'slow', arguments: {} },
    {
      serverName: 'srv',
      method: 'tools/call',
      label: 'slow job',
      specVersion: '2026-07-28',
      pollIntervalMs: 1,
      origin: 'server-directed',
    },
  );
  assert.equal(created.origin, 'server-directed');
  const final = await manager.waitFor(created.key);
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.result, { done: true });
  assert.equal(final.progress, 0.5);
  assert.equal(final.progressMessage, 'nửa chặng');
  assert.equal(final.origin, 'server-directed');
});

test('clientHandlers: tasks/create server-directed end-to-end via dispatcher', async () => {
  const transport = pollingTransport(['working', 'completed'], { ok: 1 });
  const dispatcher = createMcpDispatcher();
  const fakeClient = {
    getDispatcher: () => dispatcher,
    requestJsonRpc: (method, params) => transport.request(method, params),
  };
  const createdOutcomes = [];
  const registered = registerDefaultMcpClientHandlers(fakeClient, {
    serverName: 'srv',
    serverDirectedTasks: {
      specVersion: '2026-07-28',
      onTaskCreated: (outcome) => createdOutcomes.push(outcome),
    },
  });
  assert.ok(registered.serverDirectedTaskHandler);
  assert.ok('tasks' in registered.capabilities);
  assert.deepEqual(buildMcpClientCapabilities({ serverDirectedTasks: {} }).tasks, {});
  assert.deepEqual(buildMcpClientCapabilities({}).tasks, undefined);

  // Server asks client to create a task.
  const res = await dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method: 'tasks/create',
    params: { method: 'tools/call', params: { name: 'job', arguments: {} }, label: 'job dài' },
  });
  assert.equal(res.error, undefined);
  assert.equal(res.result.taskId, 't-1');
  assert.equal(res.result.status, 'working');
  assert.equal(createdOutcomes.length, 1);
  assert.equal(createdOutcomes[0].handle.taskId, 't-1');
  assert.equal(registered.serverDirectedTaskHandler.runningCount, 1);

  // Disallowed method -> JSON-RPC error, no task created.
  const denied = await dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 2,
    method: 'tasks/create',
    params: { method: 'resources/read', params: {} },
  });
  assert.ok(denied.error);
  assert.match(denied.error.message, /allowlist/);
  assert.equal(registered.serverDirectedTaskHandler.runningCount, 1);

  // Server pushes progress -> emitter gets it.
  const events = [];
  registered.serverDirectedTaskHandler.progressEmitter.subscribe('*', (e) => events.push(e));
  const note = await dispatcher.dispatch({
    jsonrpc: '2.0',
    method: 'notifications/tasks/progress',
    params: { taskId: 't-1', status: 'working', progress: 0.4, progressMessage: 'đang làm' },
  });
  assert.equal(note, null); // notification: no response
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, 't-1');
  assert.equal(events[0].progress, 0.4);
  assert.equal(events[0].source, 'push');
});
