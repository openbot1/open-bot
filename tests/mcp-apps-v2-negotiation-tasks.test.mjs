/**
 * Test v1.14 T2: MCP Apps v2 — capability negotiation hai chiều +
 * Tasks poller chuẩn 2026-07-28 (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v2-negotiation-tasks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClientMetaExtensions,
  CapabilityNegotiatorV2,
  describeClientExtensions,
  fallbackMatrixV2,
  negotiateExtensionsV2,
  normalizeExtensionNames,
  parseServerExtensions,
  MCP_APPS_EXTENSION_2026,
} from '../packages/core/dist/mcp/capabilityNegotiationV2.js';
import { MCP_TASKS_EXTENSION_2026 } from '../packages/core/dist/mcp/tasksSpec.js';
import {
  isTaskTerminalV2,
  McpTasksPollerV2,
  normalizeTaskStatusV2,
  parseTaskPollSnapshot,
  pollTaskToCompletionV2,
} from '../packages/core/dist/mcp/tasksPollerV2.js';
import { McpTasksSpecError } from '../packages/core/dist/mcp/tasksSpec.js';

// ---------------------------------------------------------------------------
// Capability negotiation v2 — client declaration
// ---------------------------------------------------------------------------

test('negotiation v2: client declares both extensions by default', () => {
  const meta = buildClientMetaExtensions();
  const names = meta.map((e) => e.name);
  assert.ok(names.includes(MCP_APPS_EXTENSION_2026));
  assert.ok(names.includes(MCP_TASKS_EXTENSION_2026));
  const apps = meta.find((e) => e.name === MCP_APPS_EXTENSION_2026);
  assert.equal(apps.version, '2026-07-28');
  assert.equal(apps.capabilities.uiResources, true);
  assert.equal(apps.capabilities.templates, true);
  assert.equal(apps.capabilities.bridgeToolCalls, true);
  const tasks = meta.find((e) => e.name === MCP_TASKS_EXTENSION_2026);
  assert.equal(tasks.capabilities.polling, true);
  assert.equal(tasks.capabilities.update, true);
});

test('negotiation v2: client can opt out of one extension', () => {
  const meta = buildClientMetaExtensions({ apps: false });
  const names = meta.map((e) => e.name);
  assert.ok(!names.includes(MCP_APPS_EXTENSION_2026));
  assert.ok(names.includes(MCP_TASKS_EXTENSION_2026));
  const described = describeClientExtensions({ apps: false, tasks: true });
  assert.equal(described.apps, false);
  assert.equal(described.tasks, true);
});

test('negotiation v2: legacy apps extension name normalizes to ui', () => {
  assert.deepEqual(normalizeExtensionNames(['io.modelcontextprotocol/apps']), [
    MCP_APPS_EXTENSION_2026,
  ]);
  assert.deepEqual(
    normalizeExtensionNames(['io.modelcontextprotocol/tasks', { name: 'io.modelcontextprotocol/apps' }]),
    [MCP_TASKS_EXTENSION_2026, MCP_APPS_EXTENSION_2026],
  );
});

// ---------------------------------------------------------------------------
// Capability negotiation v2 — server parse + two-way negotiation
// ---------------------------------------------------------------------------

const FULL_DISCOVER = {
  protocolVersion: '2026-07-28',
  capabilities: {
    apps: { uiResources: true, templates: true, bridgeToolCalls: true },
    tasks: { specVersion: '2026-07-28', update: true, serverDirected: false },
  },
  extensions: [MCP_APPS_EXTENSION_2026, MCP_TASKS_EXTENSION_2026],
  serverInfo: { name: 'demo', version: '1.0.0' },
};

test('negotiation v2: both declare -> full, both enabled', () => {
  const parsed = parseServerExtensions(FULL_DISCOVER);
  assert.equal(parsed.apps, true);
  assert.equal(parsed.tasks, true);
  const neg = negotiateExtensionsV2('demo', {}, FULL_DISCOVER, '2026-07-28');
  assert.equal(neg.apps.enabled, true);
  assert.equal(neg.apps.level, 'full');
  assert.equal(neg.tasks.enabled, true);
  assert.equal(neg.tasks.level, 'full');
  assert.equal(neg.tasksSpecVersion, '2026-07-28');
  assert.deepEqual(neg.apps.effectivePieces, ['uiResources', 'templates', 'bridgeToolCalls']);
  assert.deepEqual(neg.notes, []);
});

test('negotiation v2: server declares nothing -> both disabled + fallback notes', () => {
  const neg = negotiateExtensionsV2('plain', {}, { protocolVersion: '2026-07-28', capabilities: {} }, '2026-07-28');
  assert.equal(neg.apps.enabled, false);
  assert.equal(neg.apps.level, 'none');
  assert.equal(neg.tasks.enabled, false);
  assert.equal(neg.tasks.level, 'none');
  assert.ok(neg.notes.some((n) => n.includes('Server không khai báo MCP Apps')));
  assert.ok(neg.notes.some((n) => n.includes('Server không khai báo Tasks')));
  const matrix = fallbackMatrixV2(neg, { app: true, task: true });
  assert.equal(matrix.renderApp, false);
  assert.equal(matrix.runAsTask, false);
  assert.ok(matrix.reasons.length >= 2);
});

test('negotiation v2: client opts out -> disabled even when server declares', () => {
  const neg = negotiateExtensionsV2('demo', { apps: false }, FULL_DISCOVER, '2026-07-28');
  assert.equal(neg.apps.enabled, false);
  assert.equal(neg.apps.clientDeclared, false);
  assert.equal(neg.apps.serverDeclared, true);
  assert.equal(neg.tasks.enabled, true);
  assert.ok(neg.notes.some((n) => n.includes('Client không khai báo MCP Apps')));
});

test('negotiation v2: server partial apps -> partial + missing pieces listed', () => {
  const discover = {
    protocolVersion: '2026-07-28',
    capabilities: { apps: { uiResources: true, templates: false, bridgeToolCalls: false } },
    extensions: [MCP_APPS_EXTENSION_2026],
  };
  const neg = negotiateExtensionsV2('partial', {}, discover, '2026-07-28');
  assert.equal(neg.apps.level, 'partial');
  assert.deepEqual(neg.apps.effectivePieces, ['uiResources']);
  assert.ok(neg.apps.missingPieces.includes('templates'));
  assert.ok(neg.apps.missingPieces.includes('bridgeToolCalls'));
  const matrix = fallbackMatrixV2(neg, { app: true });
  assert.equal(matrix.renderApp, true);
  assert.equal(matrix.useTemplate, false);
  assert.equal(matrix.useBridge, false);
  assert.ok(matrix.reasons.some((r) => r.includes('một phần')));
});

test('negotiation v2: server _meta.extensions also counts as declaration', () => {
  const discover = {
    protocolVersion: '2026-07-28',
    capabilities: {},
    _meta: { extensions: [{ name: MCP_TASKS_EXTENSION_2026 }] },
  };
  const parsed = parseServerExtensions(discover);
  assert.equal(parsed.tasks, true);
  assert.equal(parsed.apps, false);
  const neg = negotiateExtensionsV2('meta', {}, discover, '2026-07-28');
  assert.equal(neg.tasks.enabled, true);
  assert.equal(neg.apps.enabled, false);
});

test('negotiation v2: 2025 protocol -> tasks spec 2025 + note', () => {
  const neg = negotiateExtensionsV2(
    'old',
    {},
    { protocolVersion: '2025-11-25', capabilities: { tasks: true } },
    '2025-11-25',
  );
  assert.equal(neg.tasksSpecVersion, '2025-11-25');
  assert.ok(neg.notes.some((n) => n.includes('2025-11-25')));
});

test('negotiation v2: negotiator registry + downgrade on -32601', () => {
  const negotiator = new CapabilityNegotiatorV2();
  const neg = negotiator.negotiateStateless('demo', {}, FULL_DISCOVER, '2026-07-28');
  assert.equal(neg.tasks.level, 'full');
  negotiator.recordMethodNotFound('demo', 'tasks/update');
  assert.equal(negotiator.isDowngraded('demo', 'tasks/update'), true);
  const snap = negotiator.snapshot('demo');
  assert.equal(snap.tasksLevel, 'partial');
  assert.ok(snap.downgradedMethods.includes('tasks/update'));
  assert.ok(snap.effectiveAppsPieces.includes('templates'));
  negotiator.remove('demo');
  assert.equal(negotiator.get('demo'), undefined);
});

// ---------------------------------------------------------------------------
// Tasks poller v2 — status normalization + snapshot parsing
// ---------------------------------------------------------------------------

test('tasks poller v2: status normalization working->running, pending kept', () => {
  assert.equal(normalizeTaskStatusV2('working'), 'running');
  assert.equal(normalizeTaskStatusV2('pending'), 'pending');
  assert.equal(normalizeTaskStatusV2('running'), 'running');
  assert.equal(normalizeTaskStatusV2('input_required'), 'input_required');
  assert.equal(normalizeTaskStatusV2('completed'), 'completed');
  assert.throws(() => normalizeTaskStatusV2('bogus'), /không hợp lệ/);
  assert.equal(isTaskTerminalV2('completed'), true);
  assert.equal(isTaskTerminalV2('failed'), true);
  assert.equal(isTaskTerminalV2('cancelled'), true);
  assert.equal(isTaskTerminalV2('running'), false);
  assert.equal(isTaskTerminalV2('pending'), false);
});

test('tasks poller v2: parse snapshot with progressPercent + error', () => {
  const snap = parseTaskPollSnapshot(
    { taskId: 't1', status: 'working', progressPercent: 62, message: 'đang chạy', pollInterval: 500 },
    3,
  );
  assert.equal(snap.taskId, 't1');
  assert.equal(snap.status, 'running');
  assert.equal(snap.progress, 0.62);
  assert.equal(snap.progressMessage, 'đang chạy');
  assert.equal(snap.pollIntervalMs, 500);
  assert.equal(snap.pollCount, 3);
  const done = parseTaskPollSnapshot(
    { taskId: 't1', status: 'completed', result: { ok: true } },
    5,
  );
  assert.deepEqual(done.result, { ok: true });
  const failed = parseTaskPollSnapshot(
    { taskId: 't1', status: 'failed', error: 'boom' },
    2,
  );
  assert.equal(failed.error, 'boom');
});

// ---------------------------------------------------------------------------
// Tasks poller v2 — wire behavior with a fake transport
// ---------------------------------------------------------------------------

function fakeTransport(script) {
  // script: array of { status, progress?, result?, error? } returned per tasks/get call.
  const calls = [];
  let getIndex = 0;
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'tasks/get') {
        const step = script[Math.min(getIndex, script.length - 1)];
        getIndex += 1;
        return { taskId: params.taskId, status: step.status, ...(step.progress !== undefined ? { progress: step.progress } : {}), ...(step.result !== undefined ? { result: step.result } : {}), ...(step.error ? { error: step.error } : {}) };
      }
      if (method === 'tasks/update') {
        return { taskId: params.taskId, status: 'working', progress: 0.5 };
      }
      if (method === 'tasks/cancel') {
        return { taskId: params.taskId, status: 'cancelled' };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

test('tasks poller v2: pollOnce sends long-poll timeoutMs, waitForCompletion polls to done', async () => {
  const transport = fakeTransport([
    { status: 'pending' },
    { status: 'working', progress: 0.4 },
    { status: 'completed', result: { done: true } },
  ]);
  const poller = new McpTasksPollerV2(transport, { sleep: async () => {} });
  const events = [];
  const final = await poller.waitForCompletion('t-1', {
    longPollTimeoutMs: 5000,
    pollIntervalMs: 10,
    onProgress: (e) => events.push(e),
  });
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.result, { done: true });
  assert.equal(final.pollCount, 3);
  assert.equal(transport.calls.filter((c) => c.method === 'tasks/get').length, 3);
  assert.equal(transport.calls[0].params.timeoutMs, 5000);
  assert.equal(events.length, 3);
  assert.equal(events[0].status, 'pending');
  assert.equal(events[1].progress, 0.4);
});

test('tasks poller v2: input_required answered via tasks/update + inputProvider', async () => {
  const transport = fakeTransport([
    { status: 'input_required' },
    { status: 'completed', result: { answered: true } },
  ]);
  const poller = new McpTasksPollerV2(transport, { sleep: async () => {} });
  const final = await poller.waitForCompletion('t-2', {
    longPollTimeoutMs: 0,
    pollIntervalMs: 1,
    inputProvider: async () => ({ confirm: true }),
  });
  assert.equal(final.status, 'completed');
  assert.ok(transport.calls.some((c) => c.method === 'tasks/update' && c.params.input.confirm === true));
});

test('tasks poller v2: input_required without provider throws a clear error', async () => {
  const transport = fakeTransport([{ status: 'input_required' }]);
  const poller = new McpTasksPollerV2(transport, { sleep: async () => {} });
  await assert.rejects(
    () => poller.waitForCompletion('t-3', { longPollTimeoutMs: 0, pollIntervalMs: 1 }),
    /đang chờ input/,
  );
});

test('tasks poller v2: tasks/result is rejected with a spec error (removed in 2026)', () => {
  const transport = fakeTransport([]);
  const poller = new McpTasksPollerV2(transport);
  assert.throws(
    () => poller.fetchResultBlocking('t-4'),
    (err) => {
      assert.ok(err instanceof McpTasksSpecError);
      assert.equal(err.method, 'tasks/result');
      assert.match(err.message, /tasks\/get/);
      return true;
    },
  );
});

test('tasks poller v2: sendInput + cancel hit the right methods', async () => {
  const transport = fakeTransport([{ status: 'working' }]);
  const poller = new McpTasksPollerV2(transport);
  const updated = await poller.sendInput('t-5', { answer: 42 });
  assert.equal(updated.status, 'running');
  const cancelled = await poller.cancel('t-5');
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(transport.calls.some((c) => c.method === 'tasks/update'));
  assert.ok(transport.calls.some((c) => c.method === 'tasks/cancel'));
});

test('tasks poller v2: abort cancels the task and throws', async () => {
  const transport = fakeTransport([{ status: 'working' }, { status: 'working' }]);
  const controller = new AbortController();
  controller.abort();
  const poller = new McpTasksPollerV2(transport, { sleep: async () => {} });
  await assert.rejects(
    () => poller.waitForCompletion('t-6', { signal: controller.signal, pollIntervalMs: 1 }),
    /bị huỷ/,
  );
  assert.ok(transport.calls.some((c) => c.method === 'tasks/cancel'));
});

test('tasks poller v2: timeout throws after the deadline', async () => {
  let now = 0;
  const transport = fakeTransport([{ status: 'working' }]);
  const poller = new McpTasksPollerV2(transport, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  await assert.rejects(
    () =>
      poller.waitForCompletion('t-7', {
        timeoutMs: 100,
        pollIntervalMs: 60,
        longPollTimeoutMs: 0,
      }),
    /hết thời gian chờ/,
  );
});

test('tasks poller v2: pollTaskToCompletionV2 convenience helper works', async () => {
  const transport = fakeTransport([{ status: 'completed', result: 'ok' }]);
  const final = await pollTaskToCompletionV2(transport, 't-8', {
    longPollTimeoutMs: 0,
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  assert.equal(final.status, 'completed');
  assert.equal(final.result, 'ok');
});
