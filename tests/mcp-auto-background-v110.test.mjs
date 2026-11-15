/**
 * Test v1.10 T2: auto-background tasks cho tool call dài (node:test).
 * Local only, no live network: real timers, short thresholds.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-auto-background-v110.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AutoBackgroundError,
  isAutoBackgroundTasksEnabled,
  LocalBackgroundTaskRegistry,
  runToolCallAutoBackground,
  AUTO_BACKGROUND_DEFAULT_POLL_INTERVAL_MS,
  AUTO_BACKGROUND_DEFAULT_THRESHOLD_MS,
  AUTO_BACKGROUND_DEFAULT_TIMEOUT_MS,
  AUTO_BACKGROUND_TASKS_ENV_VAR,
} from '../packages/core/dist/mcp/autoBackgroundTasks.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('constants + env opt-in (default off, like Claude)', () => {
  assert.equal(AUTO_BACKGROUND_DEFAULT_THRESHOLD_MS, 1500);
  assert.equal(AUTO_BACKGROUND_DEFAULT_POLL_INTERVAL_MS, 250);
  assert.equal(AUTO_BACKGROUND_DEFAULT_TIMEOUT_MS, 120_000);
  assert.equal(isAutoBackgroundTasksEnabled({}), false);
  assert.equal(isAutoBackgroundTasksEnabled({ [AUTO_BACKGROUND_TASKS_ENV_VAR]: '1' }), true);
  assert.equal(isAutoBackgroundTasksEnabled({ [AUTO_BACKGROUND_TASKS_ENV_VAR]: 'true' }), true);
  assert.equal(isAutoBackgroundTasksEnabled({ [AUTO_BACKGROUND_TASKS_ENV_VAR]: 'TRUE' }), true);
  assert.equal(isAutoBackgroundTasksEnabled({ [AUTO_BACKGROUND_TASKS_ENV_VAR]: '0' }), false);
  assert.equal(isAutoBackgroundTasksEnabled({ [AUTO_BACKGROUND_TASKS_ENV_VAR]: 'yes' }), false);
});

test('fast call returns synchronously, backgrounded=false, no poll', async () => {
  const events = [];
  const out = await runToolCallAutoBackground(async () => 'quick', {
    thresholdMs: 500,
    pollIntervalMs: 50,
    taskId: 'bg-fast',
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.result, 'quick');
  assert.equal(out.backgrounded, false);
  assert.equal(out.polls, 0);
  assert.equal(out.taskId, 'bg-fast');
  assert.deepEqual(events.map((e) => e.kind), ['started', 'done']);
  assert.equal(events[1].backgrounded, false);
});

test('slow call goes to background, streams progress, returns result as sync', async () => {
  const events = [];
  const out = await runToolCallAutoBackground(
    async (ctx) => {
      await sleep(120);
      ctx.reportProgress(50, 'halfway');
      await sleep(120);
      ctx.reportProgress(100, 'done');
      return { answer: 42 };
    },
    {
      thresholdMs: 50,
      pollIntervalMs: 40,
      taskId: 'bg-slow',
      label: 'slow-tool',
      onEvent: (e) => events.push(e),
    },
  );
  assert.deepEqual(out.result, { answer: 42 });
  assert.equal(out.backgrounded, true);
  assert.ok(out.polls >= 1, `expected polls, got ${out.polls}`);
  assert.ok(out.durationMs >= 200, `expected >= 200ms, got ${out.durationMs}`);
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds[0], 'started');
  assert.ok(kinds.includes('backgrounded'), 'backgrounded event emitted');
  assert.ok(kinds.includes('progress'), 'progress events streamed');
  assert.equal(kinds[kinds.length - 1], 'done');
  const bg = events.find((e) => e.kind === 'backgrounded');
  assert.ok(bg.afterMs >= 50, 'backgrounded after threshold');
  const progress = events.filter((e) => e.kind === 'progress');
  assert.ok(progress.some((e) => e.percent === 50 && e.message === 'halfway'), 'reported progress flows through');
  assert.equal(events[events.length - 1].backgrounded, true);
});

test('fn error propagates unwrapped (fast and slow)', async () => {
  await assert.rejects(
    () => runToolCallAutoBackground(async () => {
      throw new Error('boom-fast');
    }, { thresholdMs: 500 }),
    /boom-fast/,
  );
  await assert.rejects(
    () => runToolCallAutoBackground(async () => {
      await sleep(120);
      throw new Error('boom-slow');
    }, { thresholdMs: 50, pollIntervalMs: 30 }),
    /boom-slow/,
  );
});

test('timeout aborts a never-ending call with AutoBackgroundError', async () => {
  await assert.rejects(
    () => runToolCallAutoBackground(
      async (ctx) => {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 60_000);
          t.unref?.();
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
        return 'never';
      },
      { thresholdMs: 20, pollIntervalMs: 20, timeoutMs: 150, taskId: 'bg-timeout' },
    ),
    (err) => err instanceof AutoBackgroundError && err.code === 'timeout' && err.taskId === 'bg-timeout',
  );
});

test('caller AbortSignal cancels a backgrounded call', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 120);
  await assert.rejects(
    () => runToolCallAutoBackground(
      async () => {
        await sleep(5000);
        return 'never';
      },
      { thresholdMs: 20, pollIntervalMs: 20, signal: controller.signal, taskId: 'bg-cancel' },
    ),
    (err) => err instanceof AutoBackgroundError && err.code === 'cancelled',
  );
});

test('registry: run tracks the job, get/list/cancel/remove work', async () => {
  const registry = new LocalBackgroundTaskRegistry();
  assert.equal(registry.size, 0);
  const outcome = await registry.run(async () => {
    await sleep(80);
    return 'reg-ok';
  }, { thresholdMs: 20, pollIntervalMs: 20, taskId: 'bg-reg-1', label: 'reg-test' });
  assert.equal(outcome.result, 'reg-ok');
  assert.equal(outcome.backgrounded, true);
  assert.equal(registry.size, 1);
  const job = registry.get('bg-reg-1');
  assert.equal(job.status, 'done');
  assert.equal(job.result, 'reg-ok');
  assert.equal(job.label, 'reg-test');
  assert.ok(job.finishedAtMs >= job.startedAtMs);
  assert.deepEqual(registry.list().map((j) => j.taskId), ['bg-reg-1']);
  assert.equal(registry.cancel('bg-reg-1'), false, 'done job cannot be cancelled');
  assert.equal(registry.remove('bg-reg-1'), true);
  assert.equal(registry.size, 0);
  assert.equal(registry.get('bg-reg-1'), undefined);
});

test('registry: cancel aborts a running job', async () => {
  const registry = new LocalBackgroundTaskRegistry();
  const promise = registry.run(async () => {
    await sleep(5000);
    return 'never';
  }, { thresholdMs: 20, pollIntervalMs: 20, taskId: 'bg-reg-cancel' });
  await sleep(80);
  assert.equal(registry.get('bg-reg-cancel').status, 'running');
  assert.equal(registry.cancel('bg-reg-cancel'), true);
  await assert.rejects(promise, (err) => err instanceof AutoBackgroundError && err.code === 'cancelled');
  assert.equal(registry.get('bg-reg-cancel').status, 'cancelled');
  assert.match(registry.get('bg-reg-cancel').error, /huỷ/);
});

test('registry: failed job records the error', async () => {
  const registry = new LocalBackgroundTaskRegistry();
  await assert.rejects(
    () => registry.run(async () => {
      throw new Error('job boom');
    }, { taskId: 'bg-reg-fail' }),
    /job boom/,
  );
  const job = registry.get('bg-reg-fail');
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'job boom');
});
