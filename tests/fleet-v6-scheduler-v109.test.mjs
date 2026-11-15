/**
 * Tests for fleet scheduler v6 (packages/core/src/fleet/fleetV6Scheduler.ts).
 *
 * Covers: cron field parsing (+ errors), next cron run, schedule
 * validation/creation, day timeslot planning (heavy bots never overlap,
 * host capacity respected, priority order), priority queue (priority
 * first, FIFO within level, aging against starvation), bounded
 * preemption (only lower + preemptible + under maxPreemptions), tick
 * (due schedules enqueue + start within maxConcurrent), event firing,
 * and the durable schedule/queue files.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-v6-scheduler-v109.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FLEET_V6_HEAVY_CPU_CORES,
  addFleetV6Schedule,
  createFleetV6Schedule,
  enqueueFleetV6,
  finishFleetV6Entry,
  fireFleetV6Event,
  loadFleetV6Queue,
  loadFleetV6Schedules,
  nextFleetV6CronRun,
  parseFleetV6CronField,
  pickNextFleetV6Entry,
  planFleetV6Day,
  preemptFleetV6Entry,
  removeFleetV6Schedule,
  saveFleetV6Queue,
  saveFleetV6Schedules,
  setFleetV6ScheduleEnabled,
  tickFleetV6Scheduler,
} from '../packages/core/dist/fleet/fleetV6Scheduler.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v6-scheduler-'));
}

const GB = 1024 ** 3;
const T0 = new Date(2026, 10, 15, 8, 0, 0).getTime(); // 15/11/2026 08:00 local
const DAY_START = new Date(2026, 10, 15, 0, 0, 0).getTime();

function resources(overrides = {}) {
  return { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB, ...overrides };
}

function cronSchedule(overrides = {}) {
  return createFleetV6Schedule(
    {
      botId: 'bot-1',
      summary: 'Chạy sáng',
      kind: 'cron',
      cron: { minute: '0', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
      priority: 'normal',
      resources: resources(),
      ...overrides,
    },
    T0,
  );
}

// --- Cron parsing -----------------------------------------------------------

test('cron field: star, list, range, step', () => {
  assert.deepEqual([...parseFleetV6CronField('*', 0, 59)].sort((a, b) => a - b).slice(0, 3), [0, 1, 2]);
  assert.equal(parseFleetV6CronField('*', 0, 59).size, 60);
  assert.deepEqual([...parseFleetV6CronField('*/15', 0, 59)], [0, 15, 30, 45]);
  assert.deepEqual([...parseFleetV6CronField('9-17', 0, 23)], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...parseFleetV6CronField('9-17/2', 0, 23)], [9, 11, 13, 15, 17]);
  assert.deepEqual([...parseFleetV6CronField('1,15', 1, 31)], [1, 15]);
});

test('cron field: invalid input throws (never guessed)', () => {
  assert.throws(() => parseFleetV6CronField('', 0, 59), /non-empty/);
  assert.throws(() => parseFleetV6CronField('60', 0, 59), /out of range/);
  assert.throws(() => parseFleetV6CronField('17-9', 0, 23), /reversed/);
  assert.throws(() => parseFleetV6CronField('*/0', 0, 59), /step must be > 0/);
  assert.throws(() => parseFleetV6CronField('abc', 0, 59), /unsupported/);
  assert.throws(() => parseFleetV6CronField('1,,2', 0, 59), /empty part/);
});

test('next cron run: 09:00 daily from 08:00 is same day, from 09:00 is next day', () => {
  const expr = { minute: '0', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '*' };
  const fromMorning = new Date(2026, 10, 15, 8, 0, 0).getTime();
  const next = nextFleetV6CronRun(expr, fromMorning);
  assert.equal(new Date(next).getHours(), 9);
  assert.equal(new Date(next).getDate(), 15);
  const fromNine = new Date(2026, 10, 15, 9, 0, 0).getTime();
  const nextAfter = nextFleetV6CronRun(expr, fromNine);
  assert.equal(new Date(nextAfter).getDate(), 16);
  assert.equal(new Date(nextAfter).getHours(), 9);
});

test('next cron run: every 15 minutes lands on the quarter', () => {
  const expr = { minute: '*/15', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' };
  const from = new Date(2026, 10, 15, 8, 7, 0).getTime();
  const next = nextFleetV6CronRun(expr, from);
  const d = new Date(next);
  assert.equal(d.getHours(), 8);
  assert.equal(d.getMinutes(), 15);
});

// --- Schedule creation / validation -----------------------------------------

test('create schedule: cron computes nextRunAt, interval from createdAt', () => {
  const cron = cronSchedule();
  assert.equal(new Date(cron.nextRunAt).getHours(), 9);
  const interval = createFleetV6Schedule(
    { botId: 'bot-2', summary: 'Lặp giờ', kind: 'interval', intervalMs: 60 * 60 * 1000, resources: resources() },
    T0,
  );
  assert.equal(interval.nextRunAt, T0 + 60 * 60 * 1000);
  const event = createFleetV6Schedule(
    { botId: 'bot-3', summary: 'Khi xong', kind: 'event', event: { type: 'on-bot-done', botId: 'bot-1' }, resources: resources() },
    T0,
  );
  assert.equal(event.nextRunAt, null);
});

test('create schedule: bad input throws', () => {
  assert.throws(() => createFleetV6Schedule({ botId: '', summary: 'x', kind: 'cron', cron: { minute: '0', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '*' }, resources: resources() }, T0), /botId/);
  assert.throws(() => createFleetV6Schedule({ botId: 'b', summary: 'x', kind: 'cron', resources: resources() }, T0), /cron expression/);
  assert.throws(() => createFleetV6Schedule({ botId: 'b', summary: 'x', kind: 'interval', intervalMs: 0, resources: resources() }, T0), /intervalMs/);
  assert.throws(() => createFleetV6Schedule({ botId: 'b', summary: 'x', kind: 'event', event: { type: 'nope' }, resources: resources() }, T0), /unknown event trigger/);
  assert.throws(() => createFleetV6Schedule({ botId: 'b', summary: 'x', kind: 'cron', cron: { minute: '61', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '*' }, resources: resources() }, T0), /out of range/);
});

// --- Day planning -----------------------------------------------------------

test('day plan: two heavy bots at the same hour never overlap', () => {
  const heavy1 = cronSchedule({ botId: 'heavy-1', resources: resources({ cpuCores: 2, ramBytes: 1 * GB }) });
  const heavy2 = cronSchedule({ botId: 'heavy-2', resources: resources({ cpuCores: 2, ramBytes: 1 * GB }) });
  const plan = planFleetV6Day([heavy1, heavy2], DAY_START, { host: { cpuCores: 4, ramBytes: 8 * GB, diskBytes: 100 * GB } });
  assert.equal(plan.maxHeavyOverlap, 1);
  assert.equal(plan.slots.length, 2);
  const [a, b] = plan.slots;
  assert.ok(a.end <= b.start || b.end <= a.start, 'heavy slots must not overlap');
  assert.equal(plan.unscheduled.length, 0);
});

test('day plan: host capacity is a hard wall (peak cpu never exceeds host)', () => {
  const schedules = [];
  for (let i = 0; i < 6; i++) {
    schedules.push(cronSchedule({ botId: `bot-${i}`, resources: resources({ cpuCores: 1 }) }));
  }
  const plan = planFleetV6Day(schedules, DAY_START, { host: { cpuCores: 4, ramBytes: 8 * GB, diskBytes: 100 * GB } });
  assert.ok(plan.peakCpuCores <= 4, `peak ${plan.peakCpuCores} exceeds host 4`);
  assert.ok(plan.peakRamBytes <= 8 * GB);
});

test('day plan: impossible schedule is reported unscheduled, not silently placed', () => {
  const huge = cronSchedule({ botId: 'huge', resources: resources({ cpuCores: 99, ramBytes: 1 * GB }) });
  const plan = planFleetV6Day([huge], DAY_START, { host: { cpuCores: 4, ramBytes: 8 * GB, diskBytes: 100 * GB } });
  assert.equal(plan.slots.length, 0);
  assert.equal(plan.unscheduled.length, 1);
  assert.match(plan.unscheduled[0].reason, /exceeds-host-capacity/);
});

test('day plan: critical beats low when slots are scarce', () => {
  const low = cronSchedule({ botId: 'low-bot', priority: 'low' });
  const critical = cronSchedule({ botId: 'crit-bot', priority: 'critical' });
  // Host chỉ đủ 1 slot trong ngày: slotMs = cả ngày, host chỉ 1 core.
  const plan = planFleetV6Day([low, critical], DAY_START, {
    slotMs: 24 * 60 * 60 * 1000,
    host: { cpuCores: 1, ramBytes: 8 * GB, diskBytes: 100 * GB },
  });
  assert.equal(plan.slots.length, 1);
  assert.equal(plan.slots[0].botId, 'crit-bot');
  assert.equal(plan.unscheduled.length, 1);
  assert.equal(plan.unscheduled[0].botId, 'low-bot');
});

test('day plan: disabled and event schedules are skipped', () => {
  const disabled = cronSchedule({ botId: 'off', enabled: false });
  const event = createFleetV6Schedule(
    { botId: 'ev', summary: 'event', kind: 'event', event: { type: 'on-bot-done', botId: 'bot-1' }, resources: resources() },
    T0,
  );
  const plan = planFleetV6Day([disabled, event, cronSchedule()], DAY_START);
  assert.equal(plan.slots.length, 1);
  assert.equal(plan.slots[0].botId, 'bot-1');
});

// --- Priority queue ---------------------------------------------------------

function makeEntry(queue, overrides = {}) {
  const entry = enqueueFleetV6(queue, {
    botId: 'bot-1',
    summary: 'run',
    priority: 'normal',
    resources: resources(),
    ...overrides,
  }, T0);
  return [...queue, entry];
}

test('queue: priority first, FIFO within the same level', () => {
  let queue = [];
  queue = makeEntry(queue, { botId: 'low-1', priority: 'low' });
  queue = makeEntry(queue, { botId: 'high-1', priority: 'high' });
  queue = makeEntry(queue, { botId: 'normal-1', priority: 'normal' });
  assert.equal(pickNextFleetV6Entry(queue, T0).botId, 'high-1');
  const first = enqueueFleetV6([], { botId: 'a', summary: 'a', priority: 'normal', resources: resources() }, T0);
  const second = enqueueFleetV6([], { botId: 'b', summary: 'b', priority: 'normal', resources: resources() }, T0 + 1000);
  assert.equal(pickNextFleetV6Entry([second, first], T0 + 1000).botId, 'a');
});

test('queue: aging — a long-waiting low entry beats a fresh normal entry', () => {
  const old = enqueueFleetV6([], { botId: 'old-low', summary: 'old', priority: 'low', resources: resources() }, T0);
  const fresh = enqueueFleetV6([], { botId: 'fresh-normal', summary: 'fresh', priority: 'normal', resources: resources() }, T0 + 59_000);
  // Chờ 61s: low (1 + 1 aging) = 2, normal mới (2 + 0) = 2 -> hòa, FIFO lấy old-low.
  const now = T0 + 61_000;
  assert.equal(pickNextFleetV6Entry([fresh, old], now).botId, 'old-low');
  // Chờ 121s: low = 1 + 2 = 3 > normal 2 -> thắng rõ.
  const later = T0 + 121_000;
  assert.equal(pickNextFleetV6Entry([fresh, old], later).botId, 'old-low');
});

test('queue: notBefore backoff blocks picking until due', () => {
  let queue = [];
  queue = makeEntry(queue, { botId: 'b1', notBefore: T0 + 30_000 });
  assert.equal(pickNextFleetV6Entry(queue, T0), null);
  assert.equal(pickNextFleetV6Entry(queue, T0 + 30_000).botId, 'b1');
});

test('preemption: critical preempts running low; non-preemptible and maxed-out do not', () => {
  const running = { ...enqueueFleetV6([], { botId: 'low', summary: 'low', priority: 'low', resources: resources() }, T0), status: 'running', startedAt: T0 };
  const incoming = enqueueFleetV6([], { botId: 'crit', summary: 'crit', priority: 'critical', resources: resources() }, T0);
  const preempted = preemptFleetV6Entry(running, incoming, T0);
  assert.ok(preempted);
  assert.equal(preempted.status, 'waiting');
  assert.equal(preempted.preemptions, 1);
  assert.equal(preempted.notBefore, T0 + 30_000);

  const stubborn = { ...running, preemptible: false };
  assert.equal(preemptFleetV6Entry(stubborn, incoming, T0), null);

  const maxed = { ...running, preemptions: 2, maxPreemptions: 2 };
  assert.equal(preemptFleetV6Entry(maxed, incoming, T0), null);

  // Không preempt entry cùng hoặc cao hơn.
  const sameLevel = { ...running, priority: 'critical' };
  assert.equal(preemptFleetV6Entry(sameLevel, incoming, T0), null);
});

// --- Tick + events ----------------------------------------------------------

test('tick: due cron schedule enqueues and starts within maxConcurrent', () => {
  const schedule = cronSchedule();
  const atNine = new Date(2026, 10, 15, 9, 0, 0).getTime();
  const { schedules, queue, result } = tickFleetV6Scheduler([schedule], [], atNine, { maxConcurrent: 2 });
  assert.equal(result.due.length, 1);
  assert.equal(result.started.length, 1);
  assert.equal(queue[0].status, 'running');
  assert.equal(queue[0].scheduleId, schedule.id);
  assert.ok(schedules[0].lastRunAt === atNine);
  assert.ok(schedules[0].nextRunAt > atNine);
});

test('tick: maxConcurrent caps running entries; the rest stay waiting', () => {
  let queue = [];
  for (let i = 0; i < 3; i++) queue = makeEntry(queue, { botId: `bot-${i}` });
  const { queue: next, result } = tickFleetV6Scheduler([], queue, T0, { maxConcurrent: 1 });
  assert.equal(result.started.length, 1);
  assert.equal(next.filter((e) => e.status === 'running').length, 1);
  assert.equal(next.filter((e) => e.status === 'waiting').length, 2);
});

test('tick: critical waiting entry preempts a running low entry when full', () => {
  const running = { ...enqueueFleetV6([], { botId: 'low', summary: 'low', priority: 'low', resources: resources() }, T0), status: 'running', startedAt: T0 };
  const waiting = enqueueFleetV6([], { botId: 'crit', summary: 'crit', priority: 'critical', resources: resources() }, T0);
  const { queue, result } = tickFleetV6Scheduler([], [running, waiting], T0, { maxConcurrent: 1 });
  assert.equal(result.preempted.length, 1);
  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].botId, 'crit');
  assert.equal(queue.find((e) => e.botId === 'low').status, 'waiting');
});

test('event: on-bot-done fires matching schedule once (no duplicate while pending)', () => {
  const schedule = createFleetV6Schedule(
    { botId: 'bot-2', summary: 'sau bot-1', kind: 'event', event: { type: 'on-bot-done', botId: 'bot-1' }, resources: resources() },
    T0,
  );
  const first = fireFleetV6Event([schedule], [], { type: 'bot-done', botId: 'bot-1' }, T0);
  assert.equal(first.fired.length, 1);
  const second = fireFleetV6Event([schedule], first.queue, { type: 'bot-done', botId: 'bot-1' }, T0);
  assert.equal(second.fired.length, 0);
  const other = fireFleetV6Event([schedule], [], { type: 'bot-done', botId: 'bot-9' }, T0);
  assert.equal(other.fired.length, 0);
});

test('event: on-queue-depth fires only at/above threshold', () => {
  const schedule = createFleetV6Schedule(
    { botId: 'bot-2', summary: 'khi đông', kind: 'event', event: { type: 'on-queue-depth', minWaiting: 3 }, resources: resources() },
    T0,
  );
  assert.equal(fireFleetV6Event([schedule], [], { type: 'queue-depth', waiting: 2 }, T0).fired.length, 0);
  assert.equal(fireFleetV6Event([schedule], [], { type: 'queue-depth', waiting: 3 }, T0).fired.length, 1);
});

test('finish: running entry completes with history, waiting entry cancels', () => {
  let queue = [];
  queue = makeEntry(queue, { botId: 'b1' });
  const running = { ...queue[0], status: 'running', startedAt: T0 };
  const done = finishFleetV6Entry([running], running.id, 'completed', T0 + 1000);
  assert.equal(done[0].status, 'done');
  assert.equal(done[0].finishedAt, T0 + 1000);
  assert.equal(done[0].history[done[0].history.length - 1].event, 'completed');
  const cancelled = finishFleetV6Entry(queue, queue[0].id, 'cancelled', T0 + 1000);
  assert.equal(cancelled[0].status, 'cancelled');
});

// --- Durable files ----------------------------------------------------------

test('files: schedule add/load/remove/enable round-trips', () => {
  const dir = tmpDir();
  assert.deepEqual(loadFleetV6Schedules(dir), []);
  const created = addFleetV6Schedule(dir, {
    botId: 'bot-1',
    summary: 'Sáng',
    kind: 'cron',
    cron: { minute: '0', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
    resources: resources(),
  }, T0);
  const loaded = loadFleetV6Schedules(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, created.id);
  const disabled = setFleetV6ScheduleEnabled(dir, created.id, false, T0);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.nextRunAt, null);
  assert.equal(removeFleetV6Schedule(dir, created.id), true);
  assert.equal(removeFleetV6Schedule(dir, created.id), false);
  assert.deepEqual(loadFleetV6Schedules(dir), []);
});

test('files: queue save/load round-trips and rejects corrupt entries', () => {
  const dir = tmpDir();
  const entry = enqueueFleetV6([], { botId: 'bot-1', summary: 'run', resources: resources() }, T0);
  saveFleetV6Queue(dir, [entry]);
  const loaded = loadFleetV6Queue(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, entry.id);
  fs.writeFileSync(path.join(dir, 'fleet-queue-v109.json'), JSON.stringify([{ ...entry, priority: 'nope' }]));
  assert.throws(() => loadFleetV6Queue(dir), /corrupt/);
  assert.equal(FLEET_V6_HEAVY_CPU_CORES, 2);
});
