/**
 * Protocols v5 — background MCP tasks tests (v1.29, Team T2).
 *
 * Covers packages/core/src/protocolsV5/mcpBackgroundTasksV5.ts:
 * submit returns a placeholder tool_result immediately, the real
 * result arrives as a task_notification, statuses
 * pending/running/done/failed/cancelled, timeout + cancel,
 * needs-input marking, duplicate ids, listener replay for late
 * subscribers, prune/cancelAll, the env opt-in flag and the
 * direct fallback when background tasks are disabled.
 *
 * No network, no provider: the work is injected per task.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v129-bg-tasks.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BackgroundMcpTaskManager,
  MCP_BG_TASK_DEFAULT_TIMEOUT_MS,
  buildMcpBgTaskPlaceholder,
  isMcpBgTaskTerminal,
  isMcpBackgroundTasksEnabled,
  mapMcpTaskStatusV5,
  submitBackgroundOrDirect,
} from '../packages/core/dist/index.js';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until a task reaches a terminal status (or time out). */
async function waitForTerminal(manager, taskId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = manager.get(taskId);
    if (task && isMcpBgTaskTerminal(task.status)) return task;
    if (Date.now() > deadline) throw new Error(`Task ${taskId} did not finish in ${timeoutMs}ms (status ${task?.status}).`);
    await tick(5);
  }
}

test('wire statuses map onto agent-turn statuses', () => {
  assert.equal(mapMcpTaskStatusV5('working'), 'running');
  assert.equal(mapMcpTaskStatusV5('input_required'), 'running');
  assert.equal(mapMcpTaskStatusV5('completed'), 'done');
  assert.equal(mapMcpTaskStatusV5('failed'), 'failed');
  assert.equal(mapMcpTaskStatusV5('cancelled'), 'cancelled');
  assert.equal(isMcpBgTaskTerminal('done'), true);
  assert.equal(isMcpBgTaskTerminal('running'), false);
});

test('placeholder is well-formed and does not leak the result', () => {
  const p = buildMcpBgTaskPlaceholder('task-1', 'srv', 'search');
  assert.equal(p.kind, 'task_placeholder');
  assert.equal(p.taskId, 'task-1');
  assert.equal(p.status, 'running');
  assert.match(p.text, /task_notification/);
  assert.match(p.text, /do not call the tool again/i);
  assert.ok(p.pollIntervalMs > 0);
});

test('submit returns immediately; result arrives via task_notification', async () => {
  const manager = new BackgroundMcpTaskManager();
  const seen = [];
  manager.onNotification((n) => seen.push(n));

  const placeholder = manager.submit({
    serverName: 'srv',
    toolName: 'search',
    args: { q: 'hello' },
    run: async () => ({ hits: ['a', 'b'] }),
  });
  assert.equal(placeholder.kind, 'task_placeholder');
  assert.equal(placeholder.serverName, 'srv');
  // The placeholder is back before the work finished.
  assert.equal(manager.get(placeholder.taskId)?.status, 'running');

  const finished = await waitForTerminal(manager, placeholder.taskId);
  assert.equal(finished.status, 'done');
  assert.deepEqual(finished.result, { hits: ['a', 'b'] });
  assert.equal(finished.notificationCount, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'task_notification');
  assert.equal(seen[0].task_type, 'mcp_task');
  assert.equal(seen[0].status, 'done');
  assert.equal(seen[0].isTerminal, true);
  assert.deepEqual(seen[0].result, { hits: ['a', 'b'] });
  assert.equal(manager.activeCount, 0);
});

test('a failing run marks the task failed with the error message', async () => {
  const manager = new BackgroundMcpTaskManager();
  const seen = [];
  manager.onNotification((n) => seen.push(n));
  const placeholder = manager.submit({
    serverName: 'srv',
    toolName: 'boom',
    run: async () => {
      throw new Error('server exploded');
    },
  });
  const finished = await waitForTerminal(manager, placeholder.taskId);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error?.message ?? '', /server exploded/);
  assert.equal(seen[0].error?.code, 'error');
  assert.equal(seen[0].isTerminal, true);
});

test('timeout fails the task and aborts the work', async () => {
  let aborted = false;
  const manager = new BackgroundMcpTaskManager();
  const placeholder = manager.submit({
    serverName: 'srv',
    toolName: 'slow',
    timeoutMs: 30,
    run: async (signal) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
      return 'too late';
    },
  });
  const finished = await waitForTerminal(manager, placeholder.taskId);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.error?.code, 'timeout');
  assert.match(finished.error?.message ?? '', /30ms/);
  await tick(10);
  assert.equal(aborted, true);
});

test('cancel marks the task cancelled; cancelling again is a no-op', async () => {
  const manager = new BackgroundMcpTaskManager();
  const seen = [];
  manager.onNotification((n) => seen.push(n));
  const placeholder = manager.submit({
    serverName: 'srv',
    toolName: 'slow',
    timeoutMs: 60_000,
    run: async (signal) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
      return 'never';
    },
  });
  await tick(5);
  assert.equal(manager.cancel(placeholder.taskId, 'User changed their mind.'), true);
  assert.equal(manager.get(placeholder.taskId)?.status, 'cancelled');
  assert.equal(manager.get(placeholder.taskId)?.error?.code, 'cancelled');
  assert.equal(manager.cancel(placeholder.taskId), false);
  assert.equal(manager.cancel('no-such-task'), false);
  assert.equal(seen[0].status, 'cancelled');
  assert.equal(seen[0].isTerminal, true);
});

test('duplicate task ids are refused; unknown tasks throw on require()', () => {
  const manager = new BackgroundMcpTaskManager();
  manager.submit({ serverName: 'srv', toolName: 't', taskId: 'dup', run: async () => 1 });
  assert.throws(
    () => manager.submit({ serverName: 'srv', toolName: 't', taskId: 'dup', run: async () => 1 }),
    /already exists/,
  );
  assert.throws(() => manager.require('nope'), /Unknown background MCP task/);
  assert.equal(manager.get('nope'), undefined);
});

test('markNeedsInput keeps the task running but flags it; list/prune work', async () => {
  const manager = new BackgroundMcpTaskManager();
  const p1 = manager.submit({ serverName: 'srv', toolName: 'a', run: async () => 'A' });
  const p2 = manager.submit({ serverName: 'srv', toolName: 'b', run: async () => 'B' });
  assert.equal(manager.markNeedsInput(p1.taskId), true);
  assert.equal(manager.get(p1.taskId)?.needsInput, true);
  assert.equal(manager.get(p1.taskId)?.status, 'running');
  assert.equal(manager.markNeedsInput('nope'), false);
  await waitForTerminal(manager, p1.taskId);
  await waitForTerminal(manager, p2.taskId);
  assert.equal(manager.list('done').length, 2);
  assert.equal(manager.list('running').length, 0);
  assert.equal(manager.pruneFinished(), 2);
  assert.equal(manager.size, 0);
  assert.equal(manager.markNeedsInput(p1.taskId), false);
});

test('late listeners replay terminal notifications; cancelAll ends running tasks', async () => {
  const manager = new BackgroundMcpTaskManager();
  const p = manager.submit({ serverName: 'srv', toolName: 't', run: async () => 'done!' });
  await waitForTerminal(manager, p.taskId);
  const replayed = [];
  manager.onNotification((n) => replayed.push(n));
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].status, 'done');

  const slow = manager.submit({
    serverName: 'srv',
    toolName: 'slow',
    timeoutMs: 60_000,
    run: async (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve('x'))),
  });
  await tick(5);
  assert.equal(manager.cancelAll('Session ended.'), 1);
  assert.equal(manager.get(slow.taskId)?.status, 'cancelled');
});

test('env flag opts in; disabled mode runs inline and returns the real result', async () => {
  assert.equal(isMcpBackgroundTasksEnabled({}), false);
  assert.equal(isMcpBackgroundTasksEnabled({ OPENBOT_MCP_BACKGROUND_TASKS: '1' }), true);
  assert.equal(isMcpBackgroundTasksEnabled({ CLAUDE_AUTO_BACKGROUND_TASKS: '1' }), true);
  assert.equal(MCP_BG_TASK_DEFAULT_TIMEOUT_MS, 600_000);

  const manager = new BackgroundMcpTaskManager();
  const direct = await submitBackgroundOrDirect(manager, {
    enabled: false,
    serverName: 'srv',
    toolName: 'echo',
    run: async () => ({ ok: true }),
  });
  assert.equal(direct.kind, 'direct');
  assert.deepEqual(direct.result, { ok: true });
  assert.equal(manager.size, 0);

  const bg = await submitBackgroundOrDirect(manager, {
    enabled: true,
    serverName: 'srv',
    toolName: 'echo',
    run: async () => ({ ok: true }),
  });
  assert.equal(bg.kind, 'task_placeholder');
  const finished = await waitForTerminal(manager, bg.taskId);
  assert.equal(finished.status, 'done');
});
