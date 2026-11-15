/**
 * MCP Tasks runner + tool host tests (v1.09, Team T3 — node:test, không mạng live).
 *
 * Covers packages/core/src/mcp/tasksRunner.ts + mcpAppsTasksTools.ts:
 *  - retryDelayMs: backoff nhân 2, chặn trần, jitter trong ±20%
 *  - isRetryableTaskError: lỗi transport retry được, abort/cancel không
 *  - McpTaskRunner.run: task 2026 chạy tới completed, lấy result từ
 *    tasks/get, progress event đúng (50% -> 100%), polls đếm đúng
 *  - runner: poll lỗi thoáng qua thì retry rồi vẫn xong
 *  - runner: timeout tổng -> failed + huỷ ở server
 *  - runner: cancel() huỷ task đang chạy
 *  - runner: resume/probe — task còn working thì re-attach, task lạ
 *    thì orphaned, resumeAll gom outcome
 *  - runner: hàng đợi maxConcurrent (2 task chạy song song tối đa)
 *  - McpAppsTasksToolHost: 8 tool — validate/open/list/close,
 *    negotiate/create/cancel/resume; tool lạ lỗi rõ; create khi
 *    server không hỗ trợ Tasks thì từ chối; open app lỗi HTML thì từ chối
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v109-tasks-runner.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpTaskRunner,
  isRetryableTaskError,
  retryDelayMs,
} from '../packages/core/dist/mcp/tasksRunner.js';
import { TaskError } from '../packages/core/dist/mcp/tasks.js';
import {
  McpAppsTasksToolHost,
  MCP_APPS_TASKS_TOOL_DEFINITIONS,
  MCP_APPS_TASKS_TOOL_NAMES,
} from '../packages/core/dist/mcp/mcpAppsTasksTools.js';

/** Fake MCP server: task đi qua các trạng thái đã script sẵn. */
class FakeTransport {
  constructor(script = {}) {
    this.script = script; // taskId -> trạng thái sẽ trả qua từng lần tasks/get
    this.calls = [];
    this.pollCount = new Map();
    this.failPollTimes = 0;
    this.cancelled = new Set();
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'tools/call') {
      const taskId = `task-${this.calls.filter((c) => c.method === 'tools/call').length}`;
      this.script[taskId] = this.script[taskId] ?? [{ status: 'working', progress: 0.5 }, { status: 'completed', result: { ok: true } }];
      this.pollCount.set(taskId, 0);
      return { taskId, status: 'working', pollInterval: 1 };
    }
    if (method === 'tasks/get') {
      const taskId = params.taskId;
      if (this.failPollTimes > 0) {
        this.failPollTimes -= 1;
        throw new Error('network blip');
      }
      if (!this.script[taskId]) throw new Error(`unknown task ${taskId}`);
      if (this.cancelled.has(taskId)) return { taskId, status: 'cancelled' };
      const idx = this.pollCount.get(taskId) ?? 0;
      const states = this.script[taskId];
      const state = states[Math.min(idx, states.length - 1)];
      this.pollCount.set(taskId, idx + 1);
      return { taskId, ...state, pollInterval: 1 };
    }
    if (method === 'tasks/result') {
      return { value: 42 };
    }
    if (method === 'tasks/cancel') {
      this.cancelled.add(params.taskId);
      return { taskId: params.taskId, status: 'cancelled' };
    }
    if (method === 'tasks/update') {
      return { taskId: params.taskId, status: 'working', pollInterval: 1 };
    }
    throw new Error(`unknown method ${method}`);
  }
}

const noSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// retry helpers
// ---------------------------------------------------------------------------

test('runner: retryDelayMs backoff nhân 2, chặn trần, jitter trong ±20%', () => {
  const policy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 };
  assert.equal(retryDelayMs(policy, 1, () => 0.5), 500);
  assert.equal(retryDelayMs(policy, 2, () => 0.5), 1000);
  assert.equal(retryDelayMs(policy, 3, () => 0.5), 2000);
  assert.ok(retryDelayMs(policy, 10, () => 0.5) <= 8000);
  const low = retryDelayMs(policy, 2, () => 0);
  const high = retryDelayMs(policy, 2, () => 1);
  assert.ok(low >= 800 && low <= 1000);
  assert.ok(high >= 1000 && high <= 1200);
});

test('runner: isRetryableTaskError — lỗi mạng retry được, abort/cancel không', () => {
  assert.equal(isRetryableTaskError(new Error('ECONNRESET')), true);
  assert.equal(isRetryableTaskError(new TaskError('poll thất bại')), true);
  assert.equal(isRetryableTaskError(new Error('aborted')), false);
  assert.equal(isRetryableTaskError(new TaskError('Task: task handle thiếu "taskId"')), false);
});

// ---------------------------------------------------------------------------
// run: happy path 2026
// ---------------------------------------------------------------------------

test('runner: task 2026 chạy tới completed, result từ tasks/get, progress đúng', async () => {
  const transport = new FakeTransport();
  const events = [];
  const runner = new McpTaskRunner({ sleep: noSleep, onProgress: (e) => events.push(e) });
  const outcome = await runner.run(transport, 'tools/call', { name: 'slow', arguments: {} }, { specVersion: '2026-07-28' });
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.result, { ok: true });
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.polls, 2);
  assert.equal(outcome.resumed, false);
  assert.equal(events.length, 2);
  assert.equal(events[0].progress, 50);
  assert.equal(events[0].status, 'working');
  assert.equal(events[1].status, 'completed');
});

test('runner: task 2025 lấy result qua tasks/result', async () => {
  const transport = new FakeTransport();
  transport.script = {};
  const runner = new McpTaskRunner({ sleep: noSleep });
  const outcome = await runner.run(transport, 'tools/call', {}, { specVersion: '2025-11-25' });
  // Script mặc định của FakeTransport trả completed kèm result trong
  // tasks/get; ở 2025 runner bỏ qua result đó và gọi tasks/result.
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.result, { value: 42 });
  assert.ok(transport.calls.some((c) => c.method === 'tasks/result'));
});

test('runner: poll lỗi thoáng qua thì retry rồi vẫn xong', async () => {
  const transport = new FakeTransport();
  transport.failPollTimes = 2;
  const runner = new McpTaskRunner({ sleep: noSleep, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 } });
  const outcome = await runner.run(transport, 'tools/call', {}, { specVersion: '2026-07-28' });
  assert.equal(outcome.status, 'completed');
});

test('runner: poll lỗi hoài thì ném lỗi sau khi hết retry', async () => {
  const transport = new FakeTransport();
  transport.failPollTimes = 100;
  const runner = new McpTaskRunner({ sleep: noSleep, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 } });
  await assert.rejects(
    () => runner.run(transport, 'tools/call', {}, { specVersion: '2026-07-28' }),
    /poll thất bại/,
  );
});

// ---------------------------------------------------------------------------
// timeout + cancel
// ---------------------------------------------------------------------------

test('runner: timeout tổng -> failed + gọi tasks/cancel ở server', async () => {
  let nowMs = 10_000;
  const transport = new FakeTransport();
  transport.script = {};
  // Task không bao giờ xong: tasks/get luôn working.
  const slow = new FakeTransport({ 'task-1': [{ status: 'working' }] });
  const runner = new McpTaskRunner({
    sleep: () => Promise.resolve(),
    now: () => nowMs,
    timeoutMs: 100,
  });
  // now() không tăng theo sleep giả — tăng tay sau mỗi lần poll bằng
  // cách bọc transport: mỗi lần tasks/get thì thời gian trôi 60ms.
  const origRequest = slow.request.bind(slow);
  slow.request = async (method, params) => {
    const out = await origRequest(method, params);
    if (method === 'tasks/get') nowMs += 60;
    return out;
  };
  const outcome = await runner.run(slow, 'tools/call', {}, { specVersion: '2026-07-28' });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /hết thời gian chờ/);
  assert.ok(slow.calls.some((c) => c.method === 'tasks/cancel'));
  void transport;
});

test('runner: cancel() huỷ task đang chạy', async () => {
  const transport = new FakeTransport({ 'task-1': [{ status: 'working' }, { status: 'working' }, { status: 'working' }] });
  const runner = new McpTaskRunner({ sleep: () => new Promise((r) => setTimeout(r, 5)) });
  const promise = runner.run(transport, 'tools/call', {}, { specVersion: '2026-07-28', pollIntervalMs: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runner.cancel('task-1'), true);
  assert.equal(runner.cancel('task-khong-co'), false);
  await assert.rejects(() => promise, /abort|huỷ|Abort/i);
});

// ---------------------------------------------------------------------------
// resume / probe
// ---------------------------------------------------------------------------

test('runner: probe task còn working thì resumed, task lạ thì orphaned', async () => {
  const transport = new FakeTransport({ 'task-9': [{ status: 'working', progress: 0.3 }, { status: 'completed', result: 'done!' }] });
  const runner = new McpTaskRunner({ sleep: noSleep });
  const probe = await runner.probeResumable(transport, {
    taskId: 'task-9', serverName: 'srv', method: 'tools/call', label: 'job', specVersion: '2026-07-28',
  });
  assert.equal(probe.outcome, 'resumed');
  const orphan = await runner.probeResumable(transport, {
    taskId: 'task-ghost', serverName: 'srv', method: 'tools/call', label: 'ghost', specVersion: '2026-07-28',
  });
  assert.equal(orphan.outcome, 'orphaned');
});

test('runner: resumeAll — task working chạy tiếp tới xong, task lạ báo orphaned', async () => {
  const transport = new FakeTransport({ 'task-9': [{ status: 'working' }, { status: 'completed', result: 'x' }] });
  const runner = new McpTaskRunner({ sleep: noSleep });
  const outcomes = await runner.resumeAll(transport, [
    { taskId: 'task-9', serverName: 'srv', method: 'tools/call', label: 'job', specVersion: '2026-07-28' },
    { taskId: 'task-ghost', serverName: 'srv', method: 'tools/call', label: 'ghost', specVersion: '2026-07-28' },
  ]);
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].status, 'completed');
  assert.equal(outcomes[0].resumed, true);
  assert.equal(outcomes[0].result, 'x');
  assert.equal(outcomes[1].status, 'failed');
  assert.match(outcomes[1].error, /orphaned/);
});

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

test('runner: maxConcurrent=1 xếp hàng FIFO — task 2 chỉ chạy sau task 1', async () => {
  const transport = new FakeTransport();
  const order = [];
  const slowTransport = {
    async request(method, params = {}) {
      if (method === 'tools/call') {
        const id = `t${order.length + 1}`;
        order.push(`create-${id}`);
        return { taskId: id, status: 'working', pollInterval: 1 };
      }
      if (method === 'tasks/get') {
        return { taskId: params.taskId, status: 'completed', result: params.taskId, pollInterval: 1 };
      }
      throw new Error(method);
    },
  };
  const runner = new McpTaskRunner({ maxConcurrent: 1, sleep: noSleep });
  const [o1, o2] = await Promise.all([
    runner.run(slowTransport, 'tools/call', {}, { specVersion: '2026-07-28' }),
    runner.run(slowTransport, 'tools/call', {}, { specVersion: '2026-07-28' }),
  ]);
  assert.equal(o1.status, 'completed');
  assert.equal(o2.status, 'completed');
  assert.deepEqual(order, ['create-t1', 'create-t2']);
  void transport;
});

// ---------------------------------------------------------------------------
// tool host
// ---------------------------------------------------------------------------

test('tools: đủ 8 tool definitions, tên đúng nhóm mcp_apps_*/mcp_tasks_*', () => {
  assert.equal(MCP_APPS_TASKS_TOOL_DEFINITIONS.length, 8);
  assert.deepEqual([...MCP_APPS_TASKS_TOOL_NAMES], [
    'mcp_apps_validate',
    'mcp_apps_open',
    'mcp_apps_list',
    'mcp_apps_close',
    'mcp_tasks_negotiate',
    'mcp_tasks_create',
    'mcp_tasks_cancel',
    'mcp_tasks_resume',
  ]);
  for (const def of MCP_APPS_TASKS_TOOL_DEFINITIONS) {
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.length > 10);
    assert.equal(def.parameters.type, 'object');
  }
});

test('tools: validate ok với HTML lành, lỗi với HTML chứa script ngoài', async () => {
  const host = new McpAppsTasksToolHost();
  const good = await host.runTool('mcp_apps_validate', { html: '<div><button>Hi</button></div>' });
  assert.equal(good.ok, true);
  assert.equal(good.data.valid, true);
  const bad = await host.runTool('mcp_apps_validate', { html: '<script src="https://evil.example.com/x.js"></script>' });
  assert.equal(bad.ok, false);
  assert.ok(bad.data.findings.some((f) => f.severity === 'blocking'));
});

test('tools: open app lành -> trả sessionId + sandbox; mở app lỗi -> từ chối; list/close', async () => {
  const host = new McpAppsTasksToolHost();
  const opened = await host.runTool('mcp_apps_open', {
    html: '<div><h1>Hi</h1></div>',
    title: 'Card',
    uri: 'ui://srv/card',
    toolName: 'demo',
    serverName: 'srv',
    allowedTools: ['read_file'],
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.data.sandbox, 'allow-scripts');
  assert.ok(opened.data.sessionId.startsWith('app-'));
  const list = await host.runTool('mcp_apps_list', {});
  assert.equal(list.data.count, 1);
  assert.equal(list.data.apps[0].sessionId, opened.data.sessionId);
  // Nonce không lộ qua list.
  assert.equal('nonce' in list.data.apps[0], false);
  const closed = await host.runTool('mcp_apps_close', { sessionId: opened.data.sessionId });
  assert.equal(closed.ok, true);
  const closedAgain = await host.runTool('mcp_apps_close', { sessionId: opened.data.sessionId });
  assert.equal(closedAgain.ok, false);

  const badOpen = await host.runTool('mcp_apps_open', { html: '<iframe src="https://evil.example.com"></iframe>' });
  assert.equal(badOpen.ok, false);
});

test('tools: negotiate trả mức hỗ trợ + notes', async () => {
  const host = new McpAppsTasksToolHost();
  const res = await host.runTool('mcp_tasks_negotiate', {
    serverName: 'srv',
    protocolVersion: '2026-07-28',
    capabilities: { apps: true, tasks: true },
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.tasksLevel, 'full');
  assert.equal(res.data.appsLevel, 'partial');
});

test('tools: create task chạy qua runner; thiếu transport thì lỗi rõ; server none-tasks thì từ chối', async () => {
  const host = new McpAppsTasksToolHost();
  const noTransport = await host.runTool('mcp_tasks_create', { serverName: 'srv', method: 'tools/call', params: {} });
  assert.equal(noTransport.ok, false);
  assert.match(noTransport.error, /Chưa có transport/);

  const transport = new FakeTransport();
  host.registerTransport('srv', transport);
  const created = await host.runTool('mcp_tasks_create', { serverName: 'srv', method: 'tools/call', params: { name: 'x' } });
  assert.equal(created.ok, true);
  assert.equal(created.data.status, 'completed');

  // Đàm phán none -> từ chối tạo task.
  await host.runTool('mcp_tasks_negotiate', { serverName: 'plain', protocolVersion: '2025-11-25', capabilities: {} });
  host.registerTransport('plain', new FakeTransport());
  const refused = await host.runTool('mcp_tasks_create', { serverName: 'plain', method: 'tools/call', params: {} });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /không hỗ trợ Tasks/);
});

test('tools: resume qua host — task working chạy tiếp, task lạ orphaned', async () => {
  const host = new McpAppsTasksToolHost();
  const transport = new FakeTransport({ 'task-9': [{ status: 'working' }, { status: 'completed', result: 'ok' }] });
  host.registerTransport('srv', transport);
  const res = await host.runTool('mcp_tasks_resume', {
    serverName: 'srv',
    tasks: [
      { taskId: 'task-9', method: 'tools/call', label: 'job', specVersion: '2026-07-28' },
      { taskId: 'task-ghost', method: 'tools/call', label: 'ghost', specVersion: '2026-07-28' },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.resumed, 1);
  assert.equal(res.data.orphaned, 1);
});

test('tools: tool lạ trả lỗi rõ, không throw', async () => {
  const host = new McpAppsTasksToolHost();
  const res = await host.runTool('mcp_khong_co', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /không tồn tại/);
  const cancel = await host.runTool('mcp_tasks_cancel', { taskId: 'nope' });
  assert.equal(cancel.ok, false);
});
