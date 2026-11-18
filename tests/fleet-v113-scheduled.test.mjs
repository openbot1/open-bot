/**
 * Fleet v10 scheduled tests (v1.13, Doi T6 — node:test, no network).
 *
 * Covers:
 * - Timezone: offset Asia/Ho_Chi_Minh (+7), America/New_York DST
 *   (spring forward skips the missing hour, fall back runs once),
 *   invalid timezone rejected
 * - Cron: 5-field parse/validate, next run in a timezone (09:00
 *   Saigon = 02:00 UTC), weekday handling
 * - Next-run math: cron / interval / once (once runs once only)
 * - Tick (pure): due -> started, skip-if-running, missed past grace
 *   (at most one missed per schedule per tick), retry reopen with
 *   exponential backoff, once disables itself
 * - Run lifecycle: complete resets failures, fail retries then
 *   exhausts after maxAttempts
 * - Summary: due in 24h, running, failed/missed/skipped in 24h
 * - Persistence round-trip + corrupt file loads as empty
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v113-scheduled.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  completeFleetV10Run,
  createFleetV10Schedule,
  failFleetV10Run,
  fleetV10CronMatchesInTimezone,
  fleetV10RetryBackoffMs,
  fleetV10TimezoneOffsetMs,
  fleetV10ZonedTimeToUtcMs,
  isValidFleetV10CronString,
  isValidFleetV10Timezone,
  loadFleetV10ScheduledRuns,
  loadFleetV10Schedules,
  nextFleetV10CronRun,
  nextRunForFleetV10Schedule,
  parseFleetV10CronString,
  removeFleetV10Schedule,
  saveFleetV10ScheduledRuns,
  saveFleetV10Schedules,
  setFleetV10ScheduleEnabled,
  summarizeFleetV10Scheduling,
  tickFleetV10Scheduler,
  validateFleetV10Schedule,
} from '../packages/core/dist/fleet/fleetV10Scheduled.js';

// 2026-11-15 00:00 UTC = 07:00 Saigon.
const T0 = Date.UTC(2026, 10, 15, 0, 0, 0);

function makeSchedule(overrides = {}, now = T0) {
  return createFleetV10Schedule(
    {
      name: 'morning',
      agentId: 'bot-morning',
      ownerUserId: 'alice',
      kind: 'cron',
      cron: '0 9 * * *',
      timezone: 'Asia/Ho_Chi_Minh',
      ...overrides,
    },
    now,
  );
}

test('timezone: offset Saigon +7h, New York DST -5/-4, mui gio sai bi tu choi', () => {
  assert.equal(fleetV10TimezoneOffsetMs('Asia/Ho_Chi_Minh', T0), 7 * 3600 * 1000);
  assert.equal(fleetV10TimezoneOffsetMs('UTC', T0), 0);
  // New York: mua dong -5h, mua he -4h (DST).
  assert.equal(fleetV10TimezoneOffsetMs('America/New_York', Date.UTC(2026, 0, 15)), -5 * 3600 * 1000);
  assert.equal(fleetV10TimezoneOffsetMs('America/New_York', Date.UTC(2026, 6, 15)), -4 * 3600 * 1000);
  assert.equal(isValidFleetV10Timezone('Asia/Ho_Chi_Minh'), true);
  assert.equal(isValidFleetV10Timezone('Mars/Olympus'), false);
  assert.throws(() => createFleetV10Schedule({ name: 'x', agentId: 'b', ownerUserId: 'a', kind: 'cron', cron: '0 9 * * *', timezone: 'Mars/Olympus' }, T0), /unknown timezone/);
  // Zoned -> UTC: 09:00 Saigon 2026-11-15 = 02:00 UTC.
  assert.equal(fleetV10ZonedTimeToUtcMs('Asia/Ho_Chi_Minh', 2026, 11, 15, 9, 0), Date.UTC(2026, 10, 15, 2, 0, 0));
});

test('cron: parse 5 truong, next run theo mui gio, DST spring-forward bo qua gio khong ton tai', () => {
  assert.throws(() => parseFleetV10CronString('0 9 * *'), /5 fields/);
  assert.throws(() => parseFleetV10CronString('61 9 * * *'), /out of range/);
  assert.equal(isValidFleetV10CronString('0 9 * * *'), true);
  assert.equal(isValidFleetV10CronString('x 9 * * *'), false);
  // 09:00 Saigon moi ngay; tu 00:00 UTC 15/11 (= 07:00 Saigon) -> 02:00 UTC cung ngay.
  const next = nextFleetV10CronRun('0 9 * * *', 'Asia/Ho_Chi_Minh', T0);
  assert.equal(next, Date.UTC(2026, 10, 15, 2, 0, 0));
  assert.equal(fleetV10CronMatchesInTimezone(parseFleetV10CronString('0 9 * * *'), 'Asia/Ho_Chi_Minh', next), true);
  assert.equal(fleetV10CronMatchesInTimezone(parseFleetV10CronString('0 9 * * *'), 'Asia/Ho_Chi_Minh', next + 60_000), false);
  // New York, DST spring forward 2026-03-08: 02:30 khong ton tai ->
  // lan chay ke tiep sau 02:30 phai la ngay hom sau, khong phai 02:30 "ao".
  const springEve = Date.UTC(2026, 2, 8, 0, 0, 0);
  const nextSpring = nextFleetV10CronRun('30 2 * * *', 'America/New_York', springEve);
  assert.equal(nextSpring, Date.UTC(2026, 2, 9, 6, 30, 0)); // 02:30 EDT ngay 9/3 = 06:30 UTC
  // Fall back 2026-11-01: 01:30 lap lai — chay o lan xuat hien dau tien (EDT, 05:30 UTC).
  const fallEve = Date.UTC(2026, 9, 31, 12, 0, 0);
  const nextFall = nextFleetV10CronRun('30 1 * * *', 'America/New_York', fallEve);
  assert.equal(nextFall, Date.UTC(2026, 10, 1, 5, 30, 0));
});

test('create + next-run: cron/interval/once, once chi chay 1 lan', () => {
  const cron = makeSchedule();
  assert.equal(cron.nextRunAt, Date.UTC(2026, 10, 15, 2, 0, 0));
  const interval = createFleetV10Schedule(
    { name: 'hourly', agentId: 'b1', ownerUserId: 'alice', kind: 'interval', intervalMs: 3_600_000 },
    T0,
  );
  assert.equal(interval.nextRunAt, T0 + 3_600_000);
  assert.equal(nextRunForFleetV10Schedule(interval, T0), T0 + 3_600_000);
  const once = createFleetV10Schedule(
    { name: 'once', agentId: 'b1', ownerUserId: 'alice', kind: 'once', runAtMs: T0 + 60_000 },
    T0,
  );
  assert.equal(once.nextRunAt, T0 + 60_000);
  assert.equal(nextRunForFleetV10Schedule({ ...once, lastRunAt: T0 + 60_000 }, T0 + 60_000), null);
  // Once trong qua khu bi tu choi; interval <= 0 bi tu choi.
  assert.throws(
    () => createFleetV10Schedule({ name: 'o', agentId: 'b', ownerUserId: 'a', kind: 'once', runAtMs: T0 - 1 }, T0),
    /in the future/,
  );
  assert.throws(
    () => createFleetV10Schedule({ name: 'i', agentId: 'b', ownerUserId: 'a', kind: 'interval', intervalMs: 0 }, T0),
    /intervalMs > 0/,
  );
  assert.throws(() => validateFleetV10Schedule({ ...cron, timezone: 'Nowhere/X' }), /valid IANA timezone/);
});

test('retry backoff: cap so nhan co chan tren, xac dinh', () => {
  const s = makeSchedule();
  assert.equal(fleetV10RetryBackoffMs(s, 1), 30_000);
  assert.equal(fleetV10RetryBackoffMs(s, 2), 60_000);
  assert.equal(fleetV10RetryBackoffMs(s, 3), 120_000);
  assert.equal(fleetV10RetryBackoffMs(s, 10), 15 * 60 * 1000); // chan tren 15 phut
});

test('tick: due -> started, skip-if-running, missed qua grace chi ghi 1 lan', () => {
  const cron = makeSchedule();
  const due = cron.nextRunAt; // 02:00 UTC 15/11
  // Chay dung gio.
  let out = tickFleetV10Scheduler(due, { schedules: [cron], runs: [] });
  assert.equal(out.result.started.length, 1);
  assert.equal(out.result.started[0].status, 'running');
  assert.equal(out.result.started[0].attempt, 1);
  assert.equal(out.state.schedules[0].totalRuns, 1);
  assert.equal(out.state.schedules[0].nextRunAt, Date.UTC(2026, 10, 16, 2, 0, 0));
  // Agent dang chay + skipIfRunning -> skipped-running, nextRunAt nhay ngay mai.
  const running = { ...cron, nextRunAt: due };
  out = tickFleetV10Scheduler(due, { schedules: [running], runs: [] }, new Set(['bot-morning']));
  assert.equal(out.result.skippedRunning.length, 1);
  assert.equal(out.result.skippedRunning[0].reason, 'agent bot-morning is already running');
  assert.equal(out.state.schedules[0].nextRunAt, Date.UTC(2026, 10, 16, 2, 0, 0));
  // Khong skip khi skipIfRunning = false.
  const noSkip = { ...cron, nextRunAt: due, skipIfRunning: false };
  out = tickFleetV10Scheduler(due, { schedules: [noSkip], runs: [] }, new Set(['bot-morning']));
  assert.equal(out.result.started.length, 1);
  // Lo 10 phut (grace 5 phut) -> missed, khong chay, chi 1 ban ghi.
  const late = { ...cron, nextRunAt: due };
  out = tickFleetV10Scheduler(due + 10 * 60 * 1000, { schedules: [late], runs: [] });
  assert.equal(out.result.missed.length, 1);
  assert.equal(out.result.started.length, 0);
  assert.equal(out.state.schedules[0].missedRuns, 1);
  assert.equal(out.state.schedules[0].nextRunAt, Date.UTC(2026, 10, 16, 2, 0, 0));
  // Lo trong grace (3 phut) -> van chay.
  out = tickFleetV10Scheduler(due + 3 * 60 * 1000, { schedules: [{ ...cron, nextRunAt: due }], runs: [] });
  assert.equal(out.result.started.length, 1);
  // Lich tat khong chay.
  out = tickFleetV10Scheduler(due, { schedules: [{ ...cron, enabled: false }], runs: [] });
  assert.deepEqual(out.result, { started: [], skippedRunning: [], missed: [], retried: [] });
});

test('run lifecycle: complete reset loi, fail retry roi het luot', () => {
  const s = createFleetV10Schedule(
    { name: 'flaky', agentId: 'b1', ownerUserId: 'alice', kind: 'interval', intervalMs: 60_000, maxAttempts: 2, backoffMs: 10_000 },
    T0,
  );
  const due = s.nextRunAt;
  let { state } = tickFleetV10Scheduler(due, { schedules: [s], runs: [] });
  const runId = state.runs[0].id;
  // Fail lan 1 -> con retry sau 10s.
  let failed = failFleetV10Run(state, runId, 'boom', due + 1000);
  assert.equal(failed.exhausted, false);
  assert.equal(failed.state.schedules[0].retryAt, due + 1000 + 10_000);
  assert.equal(failed.state.schedules[0].consecutiveFailures, 1);
  // Tick tai retryAt -> mo lai attempt 2.
  let ticked = tickFleetV10Scheduler(due + 11_000, failed.state);
  assert.equal(ticked.result.retried.length, 1);
  assert.equal(ticked.result.retried[0].attempt, 2);
  // Fail lan 2 -> het luot.
  const run2 = ticked.state.runs[ticked.state.runs.length - 1].id;
  failed = failFleetV10Run(ticked.state, run2, 'boom again', due + 12_000);
  assert.equal(failed.exhausted, true);
  assert.equal(failed.state.schedules[0].retryAt, null);
  // Complete mot run khac reset loi lien tiep.
  const fresh = tickFleetV10Scheduler(due + 60_000, { schedules: [{ ...s, nextRunAt: due + 60_000 }], runs: [] });
  const completed = completeFleetV10Run(fresh.state, fresh.state.runs[0].id, due + 61_000);
  assert.equal(completed.runs[0].status, 'done');
  assert.equal(completed.schedules[0].consecutiveFailures, 0);
  assert.throws(() => completeFleetV10Run(fresh.state, 'nope'), /not found/);
  assert.throws(() => failFleetV10Run(completed, fresh.state.runs[0].id, 'x'), /not running/);
});

test('summary + enable/remove + persistence, file hong = rong', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v10-sched-'));
  try {
    const s1 = makeSchedule();
    const s2 = createFleetV10Schedule(
      { name: 'hourly', agentId: 'b2', ownerUserId: 'bob', kind: 'interval', intervalMs: 3_600_000 },
      T0,
    );
    saveFleetV10Schedules(root, [s1, s2]);
    assert.equal(fs.statSync(path.join(root, 'fleet-schedules-v113.json')).mode & 0o777, 0o600);
    const loaded = loadFleetV10Schedules(root);
    assert.equal(loaded.length, 2);
    const summary = summarizeFleetV10Scheduling(loaded, [], T0);
    assert.equal(summary.total, 2);
    assert.equal(summary.enabled, 2);
    assert.equal(summary.dueNext24h, 2);
    const disabled = setFleetV10ScheduleEnabled(loaded, s1.id, false, T0 + 1000);
    assert.equal(disabled.find((x) => x.id === s1.id).enabled, false);
    assert.equal(disabled.find((x) => x.id === s1.id).nextRunAt, null);
    assert.throws(() => setFleetV10ScheduleEnabled(loaded, 'nope', false), /not found/);
    const removed = removeFleetV10Schedule(disabled, s2.id);
    assert.equal(removed.length, 1);
    assert.throws(() => removeFleetV10Schedule(removed, 'nope'), /not found/);
    saveFleetV10ScheduledRuns(root, []);
    assert.deepEqual(loadFleetV10ScheduledRuns(root), []);
    fs.writeFileSync(path.join(root, 'fleet-schedules-v113.json'), 'not json');
    assert.deepEqual(loadFleetV10Schedules(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
