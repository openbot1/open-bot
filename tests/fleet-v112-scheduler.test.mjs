/**
 * Fleet scheduling v2 tests (v1.12, Doi T6 — node:test, no network).
 *
 * Covers:
 * - Schedule kinds: cron / interval / once / window next-run math
 * - Validation: bad kind/priority/resources/window/cron string
 * - Retry backoff: exponential, capped, deterministic
 * - Priority + aging: effective priority, FIFO tie-break
 * - Capacity fit: max concurrent, per-bot, heavy exclusion, CPU/RAM
 * - Queue ops: enqueue/start/complete/fail (retry-waiting then
 *   failed after attempts exhausted)/cancel/reopen
 * - Tick (pure): due schedule enqueues once, missed past grace is
 *   recorded not enqueued, once disables itself, capacity limits
 *   how many start
 * - Day plan: heavy bots never share a slot, unscheduled entries
 *   carry a reason, CPU/RAM caps respected
 * - Persistence round-trip: schedules + queue to tmp fleet root
 *   (atomic, mode 0600), corrupt file loads as empty
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v112-scheduler.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_FLEET_V9_SCHEDULER_POLICY,
  cancelFleetV9Entry,
  completeFleetV9Entry,
  createFleetV9Schedule,
  effectiveFleetV9Priority,
  enqueueFleetV9,
  failFleetV9Entry,
  fleetV9EntryFits,
  fleetV9RetryBackoffMs,
  isFleetV9HeavyBot,
  isFleetV9ScheduleDue,
  loadFleetV9Queue,
  loadFleetV9Schedules,
  nextFleetV9WindowRun,
  nextRunForFleetV9Schedule,
  parseFleetV9CronString,
  pickNextFleetV9Entry,
  planFleetV9Day,
  removeFleetV9Schedule,
  saveFleetV9Queue,
  saveFleetV9Schedules,
  setFleetV9ScheduleEnabled,
  startFleetV9Entry,
  summarizeFleetV9Scheduling,
  tickFleetV9Scheduler,
  validateFleetV9SchedulerPolicy,
  validateFleetV9TimeWindow,
} from '../packages/core/dist/fleet/fleetV9Scheduler.js';

const T0 = Date.UTC(2026, 10, 15, 0, 0, 0);
const HOST = { cpuCores: 4, ramBytes: 8 * 1024 ** 3, maxConcurrent: 0 };
const POLICY = { ...DEFAULT_FLEET_V9_SCHEDULER_POLICY };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v112-'));
}

function entry(overrides = {}) {
  const { queue, entry: e } = enqueueFleetV9([], {
    botId: 'bot-1',
    name: 'run',
    resources: { cpuCores: 1, ramBytes: 512 * 1024 * 1024 },
    ...overrides,
  }, T0);
  void queue;
  return e;
}

test('fleet v9: cron/interval/once/window next-run math', () => {
  const cron = createFleetV9Schedule(
    { botId: 'b1', name: 'daily', kind: 'cron', cron: parseFleetV9CronString('0 2 * * *') },
    T0,
  );
  assert.equal(cron.nextRunAtMs, Date.UTC(2026, 10, 15, 2, 0, 0));

  const interval = createFleetV9Schedule(
    { botId: 'b1', name: 'hourly', kind: 'interval', intervalMs: 60 * 60 * 1000 },
    T0,
  );
  assert.equal(interval.nextRunAtMs, T0 + 60 * 60 * 1000);

  const once = createFleetV9Schedule(
    { botId: 'b1', name: 'once', kind: 'once', runAtMs: T0 + 5000 },
    T0,
  );
  assert.equal(once.nextRunAtMs, T0 + 5000);
  assert.equal(nextRunForFleetV9Schedule(once, T0 + 6000), null);

  const windowed = createFleetV9Schedule(
    { botId: 'b1', name: 'night', kind: 'window', window: { startHour: 2, startMinute: 0, endHour: 4, endMinute: 0 } },
    T0,
  );
  assert.equal(windowed.nextRunAtMs, Date.UTC(2026, 10, 15, 2, 0, 0));
  // After the window started, the next run is tomorrow's window.
  assert.equal(
    nextFleetV9WindowRun({ startHour: 2, startMinute: 0, endHour: 4, endMinute: 0 }, T0 + 3 * 60 * 60 * 1000),
    Date.UTC(2026, 10, 16, 2, 0, 0),
  );
  assert.ok(isFleetV9ScheduleDue({ ...cron, nextRunAtMs: T0 }, T0));
  assert.ok(!isFleetV9ScheduleDue({ ...cron, enabled: false, nextRunAtMs: T0 }, T0));
});

test('fleet v9: validation rejects bad input', () => {
  assert.throws(() => createFleetV9Schedule({ botId: '', name: 'x', kind: 'cron', cron: parseFleetV9CronString('0 2 * * *') }, T0), /botId/);
  assert.throws(() => createFleetV9Schedule({ botId: 'b', name: 'x', kind: 'bogus' }, T0), /kind/);
  assert.throws(() => createFleetV9Schedule({ botId: 'b', name: 'x', kind: 'cron' }, T0), /cron/);
  assert.throws(() => createFleetV9Schedule({ botId: 'b', name: 'x', kind: 'interval', intervalMs: 0 }, T0), /intervalMs/);
  assert.throws(() => createFleetV9Schedule({ botId: 'b', name: 'x', kind: 'once' }, T0), /runAtMs/);
  assert.throws(() => validateFleetV9TimeWindow({ startHour: 2, startMinute: 0, endHour: 2, endMinute: 0 }), /empty/);
  assert.throws(() => validateFleetV9TimeWindow({ startHour: 24, startMinute: 0, endHour: 4, endMinute: 0 }), /startHour/);
  assert.throws(() => parseFleetV9CronString('0 2 * *'), /5 fields/);
  assert.throws(() => parseFleetV9CronString('99 2 * * *'), /out of range/);
  assert.throws(() => validateFleetV9SchedulerPolicy({ maxConcurrent: 0 }), /maxConcurrent/);
  assert.throws(() => validateFleetV9SchedulerPolicy({ backoffMultiplier: 0.5 }), /backoffMultiplier/);
});

test('fleet v9: retry backoff is exponential and capped', () => {
  assert.equal(fleetV9RetryBackoffMs(1, 30_000, 2, 900_000), 30_000);
  assert.equal(fleetV9RetryBackoffMs(2, 30_000, 2, 900_000), 60_000);
  assert.equal(fleetV9RetryBackoffMs(3, 30_000, 2, 900_000), 120_000);
  assert.equal(fleetV9RetryBackoffMs(10, 30_000, 2, 120_000), 120_000);
  assert.equal(fleetV9RetryBackoffMs(1, 30_000, 2, 900_000), fleetV9RetryBackoffMs(1, 30_000, 2, 900_000));
  assert.throws(() => fleetV9RetryBackoffMs(0, 30_000, 2, 900_000), /attempt/);
});

test('fleet v9: priority + aging, heavy detection', () => {
  const low = entry({ priority: 'low' });
  const high = entry({ priority: 'high' });
  assert.ok(effectiveFleetV9Priority(high, T0) > effectiveFleetV9Priority(low, T0));
  // Aging: a low entry waiting 2x agingMs gains 2 weight, still below critical cap.
  assert.equal(
    effectiveFleetV9Priority(low, T0 + 2 * POLICY.agingMs),
    Math.min(4, 1 + 2),
  );
  assert.ok(isFleetV9HeavyBot({ cpuCores: 2, ramBytes: 1 }));
  assert.ok(isFleetV9HeavyBot({ cpuCores: 1, ramBytes: 4 * 1024 ** 3 }));
  assert.ok(!isFleetV9HeavyBot({ cpuCores: 1, ramBytes: 512 * 1024 * 1024 }));
});

test('fleet v9: capacity fit checks every limit with reasons', () => {
  const running = [{ ...entry({ botId: 'b1' }), status: 'running' }];
  const sameBot = entry({ botId: 'b1' });
  const fitSameBot = fleetV9EntryFits(sameBot, running, POLICY, HOST);
  assert.equal(fitSameBot.fits, false);
  assert.match(fitSameBot.reasons.join(' '), /already has 1 run/);

  const heavy = entry({ botId: 'b2', resources: { cpuCores: 2, ramBytes: 4 * 1024 ** 3 } });
  const heavyRunning = [{ ...heavy, botId: 'b3', status: 'running' }];
  const fitHeavy = fleetV9EntryFits(heavy, heavyRunning, POLICY, HOST);
  assert.equal(fitHeavy.fits, false);
  assert.match(fitHeavy.reasons.join(' '), /heavy bot is already running/);

  const bigCpu = entry({ botId: 'b4', resources: { cpuCores: 5, ramBytes: 1 } });
  assert.match(fleetV9EntryFits(bigCpu, [], POLICY, HOST).reasons.join(' '), /not enough CPU/);
  const bigRam = entry({ botId: 'b5', resources: { cpuCores: 1, ramBytes: 16 * 1024 ** 3 } });
  assert.match(fleetV9EntryFits(bigRam, [], POLICY, HOST).reasons.join(' '), /not enough RAM/);
  assert.equal(fleetV9EntryFits(entry({ botId: 'b6' }), running, POLICY, HOST).fits, true);
});

test('fleet v9: queue lifecycle — start/complete/fail-retry/fail-terminal/cancel', () => {
  let queue = [];
  ({ queue } = enqueueFleetV9(queue, { botId: 'b1', name: 'job', maxAttempts: 1, backoffMs: 1000 }, T0));
  const id = queue[0].id;
  queue = startFleetV9Entry(queue, id, T0);
  assert.equal(queue[0].status, 'running');
  assert.equal(queue[0].attempts, 1);
  assert.throws(() => startFleetV9Entry(queue, id, T0), /not queued/);

  let res = failFleetV9Entry(queue, id, 'boom', T0 + 1000, POLICY);
  queue = res.queue;
  assert.equal(res.entry.status, 'retry-waiting');
  assert.equal(res.entry.notBeforeMs, T0 + 1000 + 1000);
  assert.match(res.entry.history.at(-1).note, /retry in 1000ms/);

  // Reopen only after notBefore passes — and the tick starts it right away.
  assert.equal(tickFleetV9Scheduler([], queue, T0 + 1500).result.reopened.length, 0);
  const reopened = tickFleetV9Scheduler([], queue, T0 + 2000).result;
  assert.equal(reopened.reopened.length, 1);
  queue = reopened.queue;
  assert.equal(queue.find((e) => e.id === id).status, 'running');
  res = failFleetV9Entry(queue, id, 'boom again', T0 + 3000, POLICY);
  assert.equal(res.entry.status, 'failed');
  assert.equal(res.entry.lastError, 'boom again');
  assert.match(res.entry.history.at(-1).note, /no retries left/);

  ({ queue } = enqueueFleetV9(queue, { botId: 'b2', name: 'cancel-me' }, T0));
  const cancelId = queue.at(-1).id;
  queue = cancelFleetV9Entry(queue, cancelId, T0);
  assert.equal(queue.find((e) => e.id === cancelId).status, 'cancelled');
  assert.throws(() => cancelFleetV9Entry(queue, id, T0), /cannot cancel/);

  // Complete path.
  ({ queue } = enqueueFleetV9(queue, { botId: 'b3', name: 'ok' }, T0));
  const okId = queue.at(-1).id;
  queue = startFleetV9Entry(queue, okId, T0);
  queue = completeFleetV9Entry(queue, okId, T0 + 500);
  assert.equal(queue.find((e) => e.id === okId).status, 'done');
});

test('fleet v9: tick enqueues due schedules once, skips missed past grace, disables once', () => {
  const cron = createFleetV9Schedule(
    { botId: 'b1', name: 'hourly', kind: 'interval', intervalMs: 60 * 60 * 1000 },
    T0,
  );
  const once = createFleetV9Schedule(
    { botId: 'b2', name: 'once', kind: 'once', runAtMs: T0 + 1000 },
    T0,
  );
  const { schedules, result } = tickFleetV9Scheduler([cron, once], [], T0 + 60 * 60 * 1000, { policy: POLICY, host: HOST });
  // Interval schedule fires once (not once per missed hour) and starts immediately (capacity free).
  assert.equal(result.enqueued.length, 2);
  assert.equal(result.started.length, 2);
  assert.equal(result.missed.length, 0);
  const onceAfter = schedules.find((s) => s.id === once.id);
  assert.equal(onceAfter.enabled, false);
  assert.equal(onceAfter.nextRunAtMs, null);

  // Missed far past grace: recorded, not enqueued.
  const stale = createFleetV9Schedule(
    { botId: 'b3', name: 'stale', kind: 'interval', intervalMs: 60 * 1000 },
    T0,
  );
  const tick2 = tickFleetV9Scheduler([stale], [], T0 + 10 * 60 * 60 * 1000, {
    policy: POLICY,
    host: HOST,
    missedGraceMs: 60 * 60 * 1000,
  });
  assert.equal(tick2.result.enqueued.length, 0);
  assert.equal(tick2.result.missed.length, 1);
  assert.equal(tick2.result.missed[0].scheduleId, stale.id);
  // ...but the schedule still advances (no catch-up burst next tick).
  assert.ok((tick2.schedules[0].nextRunAtMs ?? 0) > T0 + 10 * 60 * 60 * 1000);
});

test('fleet v9: tick respects capacity — only fitting entries start', () => {
  const policy = { ...POLICY, maxConcurrent: 1 };
  // Enqueued 1ms apart so FIFO order is deterministic.
  const first = enqueueFleetV9([], { botId: 'b1', name: 'first', priority: 'normal' }, T0).entry;
  const second = enqueueFleetV9([], { botId: 'b2', name: 'second', priority: 'normal' }, T0 + 1).entry;
  const queue = [first, second];
  const { result } = tickFleetV9Scheduler([], queue, T0, { policy, host: HOST });
  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].botId, 'b1');
  assert.equal(result.queue.filter((e) => e.status === 'running').length, 1);
  assert.equal(result.queue.filter((e) => e.status === 'queued').length, 1);
  // pickNext skips a too-big head entry and starts a fitting lower one.
  const big = entry({ botId: 'b9', name: 'big', priority: 'critical', resources: { cpuCores: 99, ramBytes: 1 } });
  const small = entry({ botId: 'b8', name: 'small', priority: 'low' });
  const picked = pickNextFleetV9Entry([big, small], T0, POLICY, HOST);
  assert.equal(picked.entry?.id, small.id);
  assert.equal(picked.blockedReason, null);
  // Nothing fits at all: entry null + the blocking reason is reported.
  const nonePicked = pickNextFleetV9Entry([big], T0, POLICY, HOST);
  assert.equal(nonePicked.entry, null);
  assert.match(nonePicked.blockedReason ?? '', /not enough CPU/);
});

test('fleet v9: day plan never overlaps heavy bots and explains unscheduled', () => {
  const dayStart = Date.UTC(2026, 10, 16, 0, 0, 0);
  const heavy1 = entry({ botId: 'h1', name: 'heavy-1', resources: { cpuCores: 2, ramBytes: 4 * 1024 ** 3 } });
  const heavy2 = entry({ botId: 'h2', name: 'heavy-2', resources: { cpuCores: 2, ramBytes: 4 * 1024 ** 3 } });
  const huge = entry({ botId: 'h3', name: 'huge', resources: { cpuCores: 99, ramBytes: 1 } });
  const plan = planFleetV9Day([heavy1, heavy2, huge], dayStart, { host: HOST });
  for (const slot of plan.slots) {
    assert.ok(slot.entries.filter((e) => e.heavy).length <= 1, 'two heavy bots in one slot');
  }
  assert.equal(plan.unscheduled.length, 1);
  assert.equal(plan.unscheduled[0].entryId, huge.id);
  assert.match(plan.unscheduled[0].reason, /no timeslot/);
  const placed = plan.slots.flatMap((s) => s.entries.map((e) => e.entryId));
  assert.ok(placed.includes(heavy1.id) && placed.includes(heavy2.id));
});

test('fleet v9: schedule CRUD + summary', () => {
  let schedules = [
    createFleetV9Schedule({ botId: 'b1', name: 'a', kind: 'interval', intervalMs: 1000 }, T0),
    createFleetV9Schedule({ botId: 'b2', name: 'b', kind: 'interval', intervalMs: 1000, enabled: false }, T0),
  ];
  schedules = setFleetV9ScheduleEnabled(schedules, schedules[1].id, true, T0);
  assert.equal(schedules[1].enabled, true);
  assert.ok(schedules[1].nextRunAtMs !== null);
  schedules = removeFleetV9Schedule(schedules, schedules[0].id);
  assert.equal(schedules.length, 1);
  assert.throws(() => removeFleetV9Schedule(schedules, 'nope'), /not found/);
  const summary = summarizeFleetV9Scheduling(schedules, [entry()], 2);
  assert.equal(summary.totalSchedules, 1);
  assert.equal(summary.enabledSchedules, 1);
  assert.equal(summary.queued, 1);
  assert.equal(summary.missedRuns, 2);
  assert.equal(summary.nextRunAtMs, schedules[0].nextRunAtMs);
});

test('fleet v9: persistence round-trip, corrupt file loads empty, mode 0600', () => {
  const root = tmpDir();
  const schedules = [createFleetV9Schedule({ botId: 'b1', name: 'a', kind: 'interval', intervalMs: 1000 }, T0)];
  const { queue } = enqueueFleetV9([], { botId: 'b1', name: 'job' }, T0);
  saveFleetV9Schedules(root, schedules);
  saveFleetV9Queue(root, queue);
  assert.equal(fs.statSync(path.join(root, 'fleet-schedules-v112.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, 'fleet-queue-v112.json')).mode & 0o777, 0o600);
  assert.equal(loadFleetV9Schedules(root).length, 1);
  assert.equal(loadFleetV9Queue(root).length, 1);
  assert.equal(loadFleetV9Schedules(root)[0].botId, 'b1');
  fs.writeFileSync(path.join(root, 'fleet-schedules-v112.json'), '{broken');
  assert.deepEqual(loadFleetV9Schedules(root), []);
  assert.deepEqual(loadFleetV9Schedules(tmpDir()), []);
});
