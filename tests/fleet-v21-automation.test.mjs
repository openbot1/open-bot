/**
 * Tests for durable automation v2 (v1.34, Đội T6).
 *
 * Covers:
 * - Event matching: exact, prefix.*, *.
 * - Backoff: exponential, capped at maxBackoffMs.
 * - Validation: bad trigger/action/maxAttempts rejected.
 * - Store (memory-only): add/list/get/remove, duplicate id throws.
 * - Run lifecycle: success schedules the next run and resets failures;
 *   failure schedules a retry with backoff; failures up to maxAttempts
 *   then dead-letter (no silent retry past the limit).
 * - Schedule triggers: runDue only runs due automations; event
 *   triggers: fireEvent only runs matching automations.
 * - Pause/resume: paused automations do not run; resume from
 *   dead-letter resets attempts and failures.
 * - Traces: every run writes started/succeeded/failed/retry/dead-letter
 *   traces; latest trace message is visible on the automation.
 * - Durability: file-backed store survives a reload; a run interrupted
 *   by a crash (status still `running` in the file) is resumed on load
 *   instead of being lost or double-run; an interrupted run already at
 *   maxAttempts goes to dead-letter on load.
 * - Snapshot round-trip: serialize() / fromSnapshot().
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v21-automation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AUTOMATION_V2_DEFAULTS,
  AutomationV2Store,
  automationV2BackoffMs,
  automationV2NextRetryAt,
  matchAutomationV2Event,
  validateDurableAutomationV2,
} from '../packages/core/dist/durable/automationV2.js';

const NOW = 1780000000000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-auto-v21-'));
}

function scheduleInput(id, overrides = {}) {
  return {
    id,
    name: `Automation ${id}`,
    trigger: { kind: 'schedule', intervalMs: 60000 },
    action: { kind: 'run-bot', botId: 'bot-1' },
    ...overrides,
  };
}

function eventInput(id, pattern, overrides = {}) {
  return {
    id,
    name: `Automation ${id}`,
    trigger: { kind: 'event', eventPattern: pattern },
    action: { kind: 'run-bot', botId: 'bot-1' },
    ...overrides,
  };
}

const succeed = async () => 'ok';
const failWith = (message) => async () => {
  throw new Error(message);
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('automation: event pattern matching (exact / prefix.* / *)', () => {
  assert.equal(matchAutomationV2Event('bot.completed', 'bot.completed'), true);
  assert.equal(matchAutomationV2Event('bot.completed', 'bot.failed'), false);
  assert.equal(matchAutomationV2Event('bot.*', 'bot.completed'), true);
  assert.equal(matchAutomationV2Event('bot.*', 'bot.sub.completed'), true);
  assert.equal(matchAutomationV2Event('bot.*', 'other.completed'), false);
  assert.equal(matchAutomationV2Event('*', 'anything.at.all'), true);
});

test('automation: backoff is exponential and capped', () => {
  assert.equal(automationV2BackoffMs(1, 1000, 60000), 1000);
  assert.equal(automationV2BackoffMs(2, 1000, 60000), 2000);
  assert.equal(automationV2BackoffMs(3, 1000, 60000), 4000);
  assert.equal(automationV2BackoffMs(10, 1000, 60000), 60000);
  assert.equal(automationV2BackoffMs(10, 500, 3000), 3000);
  assert.equal(automationV2NextRetryAt(2, 1000, 60000, NOW), NOW + 2000);
});

test('automation: defaults are sane (3 attempts, 1s base, 60s cap)', () => {
  assert.equal(AUTOMATION_V2_DEFAULTS.maxAttempts, 3);
  assert.equal(AUTOMATION_V2_DEFAULTS.baseBackoffMs, 1000);
  assert.equal(AUTOMATION_V2_DEFAULTS.maxBackoffMs, 60000);
});

test('automation: validateDurableAutomationV2 rejects bad input', () => {
  assert.deepEqual(validateDurableAutomationV2(scheduleInput('a1')), []);
  assert.ok(validateDurableAutomationV2({}).length > 0);
  assert.ok(validateDurableAutomationV2(scheduleInput('a1', { trigger: { kind: 'schedule', intervalMs: 0 } })).length > 0);
  assert.ok(validateDurableAutomationV2(scheduleInput('a1', { trigger: { kind: 'cron', expr: '* * * * *' } })).length > 0);
  assert.ok(validateDurableAutomationV2(scheduleInput('a1', { trigger: { kind: 'event', eventPattern: '' } })).length > 0);
  assert.ok(validateDurableAutomationV2(scheduleInput('a1', { action: { kind: 'run-bot', botId: '' } })).length > 0);
  assert.ok(validateDurableAutomationV2(scheduleInput('a1', { action: { kind: 'email', botId: 'bot-1' } })).length > 0);
  assert.ok(validateDurableAutomationV2(scheduleInput('a1', { maxAttempts: 0 })).length > 0);
});

// ---------------------------------------------------------------------------
// Store CRUD
// ---------------------------------------------------------------------------

test('automation store: add/list/get/remove, duplicate id throws', () => {
  const store = new AutomationV2Store(null);
  assert.equal(store.size, 0);
  const created = store.add(scheduleInput('a1'), NOW);
  assert.equal(created.status, 'idle');
  assert.equal(created.nextRunAt, NOW + 60000);
  assert.equal(created.maxAttempts, 3);
  assert.equal(store.size, 1);
  assert.equal(store.get('a1')?.name, 'Automation a1');
  assert.equal(store.get('nope'), undefined);
  assert.throws(() => store.add(scheduleInput('a1'), NOW), /đã tồn tại/);
  assert.throws(() => store.add(scheduleInput('bad', { trigger: { kind: 'schedule', intervalMs: -5 } }), NOW), /không hợp lệ/);
  // Event automations have no next run until an event fires.
  store.add(eventInput('a2', 'bot.*'), NOW);
  assert.equal(store.get('a2')?.nextRunAt, null);
  assert.equal(store.remove('a2'), true);
  assert.equal(store.remove('a2'), false);
  assert.equal(store.size, 1);
  // Copies are detached: mutating a returned object does not corrupt the store.
  const copy = store.get('a1');
  copy.status = 'dead-letter';
  assert.equal(store.get('a1')?.status, 'idle');
});

// ---------------------------------------------------------------------------
// Run lifecycle: success / retry / dead-letter
// ---------------------------------------------------------------------------

test('automation run: success resets failures and schedules the next run', async () => {
  const store = new AutomationV2Store(null);
  store.add(scheduleInput('a1'), NOW);
  await store.runOne('a1', succeed, NOW);
  const a = store.get('a1');
  assert.equal(a.status, 'idle');
  assert.equal(a.totalRuns, 1);
  assert.equal(a.totalSuccesses, 1);
  assert.equal(a.consecutiveFailures, 0);
  assert.equal(a.attempt, 0);
  assert.equal(a.lastSuccessAt, NOW);
  assert.equal(a.nextRunAt, NOW + 60000);
  assert.ok(a.traces.some((t) => t.kind === 'started'));
  assert.ok(a.traces.some((t) => t.kind === 'succeeded'));
});

test('automation run: failure schedules a retry with backoff, then success recovers', async () => {
  const store = new AutomationV2Store(null);
  store.add(scheduleInput('a1', { maxAttempts: 3, baseBackoffMs: 1000, maxBackoffMs: 60000 }), NOW);
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls <= 2) throw new Error(`boom ${calls}`);
    return 'ok';
  };
  await assert.rejects(() => store.runOne('a1', flaky, NOW), /boom 1/);
  let a = store.get('a1');
  assert.equal(a.status, 'waiting-retry');
  assert.equal(a.consecutiveFailures, 1);
  assert.equal(a.attempt, 1);
  assert.equal(a.nextRunAt, NOW + 1000);
  assert.equal(a.lastError, 'boom 1');
  assert.ok(a.traces.some((t) => t.kind === 'retry-scheduled'));

  await assert.rejects(() => store.runOne('a1', flaky, NOW + 1000), /boom 2/);
  a = store.get('a1');
  assert.equal(a.status, 'waiting-retry');
  assert.equal(a.nextRunAt, NOW + 1000 + 2000);

  await store.runOne('a1', flaky, NOW + 3000);
  a = store.get('a1');
  assert.equal(a.status, 'idle');
  assert.equal(a.consecutiveFailures, 0);
  assert.equal(a.totalRuns, 3);
  assert.equal(a.totalSuccesses, 1);
  assert.equal(calls, 3);
});

test('automation run: dead-letter after maxAttempts, no silent retry past the limit', async () => {
  const store = new AutomationV2Store(null);
  store.add(scheduleInput('a1', { maxAttempts: 2 }), NOW);
  await assert.rejects(() => store.runOne('a1', failWith('boom'), NOW), /boom/);
  assert.equal(store.get('a1')?.status, 'waiting-retry');
  await assert.rejects(() => store.runOne('a1', failWith('boom again'), NOW + 1000), /boom again/);
  const a = store.get('a1');
  assert.equal(a.status, 'dead-letter');
  assert.equal(a.nextRunAt, null);
  assert.equal(a.consecutiveFailures, 2);
  assert.ok(a.traces.some((t) => t.kind === 'dead-letter'));
  await assert.rejects(() => store.runOne('a1', succeed, NOW + 2000), /dead-letter/);
  assert.equal(store.get('a1')?.totalRuns, 2);
});

test('automation run: concurrent run of the same automation is refused', async () => {
  const store = new AutomationV2Store(null);
  store.add(scheduleInput('a1'), NOW);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = store.runOne('a1', async () => gate, NOW);
  await assert.rejects(() => store.runOne('a1', succeed, NOW), /đang chạy/);
  release();
  await first;
  assert.equal(store.get('a1')?.status, 'idle');
});

// ---------------------------------------------------------------------------
// Schedule + event triggers
// ---------------------------------------------------------------------------

test('automation schedule: runDue only runs due automations', async () => {
  const store = new AutomationV2Store(null);
  store.add(scheduleInput('due', { trigger: { kind: 'schedule', intervalMs: 1000 } }), NOW);
  store.add(scheduleInput('later', { trigger: { kind: 'schedule', intervalMs: 60000 } }), NOW);
  store.add(eventInput('on-event', 'bot.*'), NOW);
  let calls = 0;
  const counting = async () => {
    calls += 1;
  };
  const early = await store.runDue(counting, NOW + 500);
  assert.deepEqual(early, { run: 0, succeeded: 0, failed: 0 });
  assert.equal(calls, 0);
  const onTime = await store.runDue(counting, NOW + 1000);
  assert.deepEqual(onTime, { run: 1, succeeded: 1, failed: 0 });
  assert.equal(calls, 1);
  assert.equal(store.dueAutomations(NOW + 2000).length, 1);
});

test('automation schedule: runDue keeps going after one failure', async () => {
  const store = new AutomationV2Store(null);
  store.add(scheduleInput('bad', { trigger: { kind: 'schedule', intervalMs: 1000 } }), NOW);
  store.add(scheduleInput('good', { trigger: { kind: 'schedule', intervalMs: 1000 } }), NOW);
  const executor = async (automation) => {
    if (automation.id === 'bad') throw new Error('bad boom');
  };
  const result = await store.runDue(executor, NOW + 1000);
  assert.deepEqual(result, { run: 2, succeeded: 1, failed: 1 });
  assert.equal(store.get('bad')?.status, 'waiting-retry');
  assert.equal(store.get('good')?.status, 'idle');
});

test('automation event: fireEvent only runs matching automations', async () => {
  const store = new AutomationV2Store(null);
  store.add(eventInput('watcher', 'bot.*'), NOW);
  store.add(eventInput('other', 'deploy.*'), NOW);
  const ran = [];
  const executor = async (automation) => {
    ran.push(automation.id);
  };
  const hit = await store.fireEvent('bot.completed', executor, NOW);
  assert.deepEqual(hit, { matched: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(ran, ['watcher']);
  const miss = await store.fireEvent('deploy.done', executor, NOW);
  assert.equal(miss.matched, 1);
  assert.deepEqual(ran, ['watcher', 'other']);
});

// ---------------------------------------------------------------------------
// Pause / resume
// ---------------------------------------------------------------------------

test('automation pause/resume: paused automations do not run; resume from dead-letter resets', async () => {
  const store = new AutomationV2Store(null);
  store.add(scheduleInput('a1', { maxAttempts: 1 }), NOW);
  store.pause('a1', NOW);
  assert.equal(store.get('a1')?.status, 'paused');
  assert.ok(store.get('a1')?.traces.some((t) => t.kind === 'paused'));
  await assert.rejects(() => store.runOne('a1', succeed, NOW), /paused/);
  assert.deepEqual(store.dueAutomations(NOW + 60000), []);
  store.resumeManual('a1', NOW);
  assert.equal(store.get('a1')?.status, 'idle');
  await store.runOne('a1', succeed, NOW);
  assert.equal(store.get('a1')?.status, 'idle');

  // Dead-letter resume resets attempts/failures so it can run again.
  await assert.rejects(() => store.runOne('a1', failWith('boom'), NOW + 1000), /boom/);
  assert.equal(store.get('a1')?.status, 'dead-letter');
  store.resumeManual('a1', NOW + 2000);
  const a = store.get('a1');
  assert.equal(a.status, 'idle');
  assert.equal(a.attempt, 0);
  assert.equal(a.consecutiveFailures, 0);
  assert.equal(a.lastError, null);
});

test('automation summarize: counts and failing list for the dashboard', () => {
  const store = new AutomationV2Store(null);
  store.add(scheduleInput('a1'), NOW);
  store.add(scheduleInput('a2'), NOW);
  store.add(scheduleInput('a3'), NOW);
  store.pause('a3', NOW);
  const summary = store.summarize();
  assert.equal(summary.total, 3);
  assert.equal(summary.idle, 2);
  assert.equal(summary.paused, 1);
  assert.equal(summary.deadLetter, 0);
  assert.deepEqual(summary.failingConsecutively, []);
});

// ---------------------------------------------------------------------------
// Durability: file-backed store + crash resume
// ---------------------------------------------------------------------------

test('automation durability: file store survives reload', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'automations.json');
  const store = new AutomationV2Store(filePath, NOW);
  store.add(scheduleInput('a1'), NOW);
  store.add(eventInput('a2', 'bot.*'), NOW);
  assert.ok(fs.existsSync(filePath));
  const reloaded = new AutomationV2Store(filePath, NOW + 5000);
  assert.equal(reloaded.size, 2);
  assert.equal(reloaded.get('a1')?.name, 'Automation a1');
  assert.equal(reloaded.get('a2')?.trigger.kind, 'event');
});

test('automation durability: interrupted run is resumed on load, not lost or double-run', async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'automations.json');
  const store = new AutomationV2Store(filePath, NOW);
  store.add(scheduleInput('a1', { maxAttempts: 3 }), NOW);
  // Simulate a crash mid-run: rewrite the file with status=running.
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.automations[0].status = 'running';
  raw.automations[0].attempt = 1;
  raw.automations[0].totalRuns = 1;
  fs.writeFileSync(filePath, JSON.stringify(raw), 'utf8');
  const reloaded = new AutomationV2Store(filePath, NOW + 1000);
  const a = reloaded.get('a1');
  assert.equal(a.status, 'waiting-retry');
  assert.equal(a.nextRunAt, NOW + 1000);
  assert.equal(a.totalRuns, 1);
  assert.ok(a.traces.some((t) => t.kind === 'resumed'));
  // The resumed run can now execute once (attempt 2), not from scratch.
  await reloaded.runOne('a1', succeed, NOW + 1000);
  assert.equal(reloaded.get('a1')?.totalRuns, 2);
  assert.equal(reloaded.get('a1')?.status, 'idle');
});

test('automation durability: interrupted run at maxAttempts goes dead-letter on load', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'automations.json');
  const store = new AutomationV2Store(filePath, NOW);
  store.add(scheduleInput('a1', { maxAttempts: 2 }), NOW);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.automations[0].status = 'running';
  raw.automations[0].attempt = 2;
  raw.automations[0].totalRuns = 2;
  fs.writeFileSync(filePath, JSON.stringify(raw), 'utf8');
  const reloaded = new AutomationV2Store(filePath, NOW + 1000);
  const a = reloaded.get('a1');
  assert.equal(a.status, 'dead-letter');
  assert.ok(a.traces.some((t) => t.kind === 'dead-letter'));
});

test('automation durability: corrupt file starts empty instead of crashing the app', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'automations.json');
  fs.writeFileSync(filePath, '{not json', 'utf8');
  const store = new AutomationV2Store(filePath, NOW);
  assert.equal(store.size, 0);
  store.add(scheduleInput('a1'), NOW);
  assert.equal(store.size, 1);
});

test('automation durability: serialize/fromSnapshot round-trip', async () => {
  const store = new AutomationV2Store(null);
  store.add(scheduleInput('a1'), NOW);
  await store.runOne('a1', succeed, NOW);
  const snapshot = store.serialize();
  assert.equal(snapshot.version, 2);
  const restored = AutomationV2Store.fromSnapshot(snapshot);
  assert.equal(restored.size, 1);
  assert.equal(restored.get('a1')?.totalSuccesses, 1);
  assert.equal(restored.get('a1')?.status, 'idle');
});
