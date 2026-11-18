/**
 * Tests for v1.18 (Team T1) — memory v17:
 * packages/core/src/memory/v17/sleepScheduler.ts
 *
 * Covers:
 *  - pure functions: nextRunAt (never run -> now; after a run ->
 *    lastRun + interval; backoff doubles after failures; quiet
 *    hours push to end of quiet hours; maxRunsPerDay pushes to
 *    tomorrow), shouldRunScheduled (disabled / quiet hours /
 *    maxRunsPerDay / not yet due / due), quiet-hours overnight
 *    window (23h-7h).
 *  - V17SleepScheduler: tick runs when due (episodes processed,
 *    state persisted), tick skips when not due, runOnCompact runs
 *    immediately (but respects quiet hours when configured),
 *    runManual bypasses schedule, consecutive failures back off
 *    the next run, state survives a new scheduler instance.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v17-sleep-scheduler-v118.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  V15BlockStore,
  V16V15BlockAdapter,
  V17SleepScheduler,
  createV17SleepScheduler,
  nextRunAtV17,
  shouldRunScheduledV17,
  isInQuietHoursV17,
  endOfQuietHoursV17,
  defaultV17SleepScheduleState,
  loadV17SleepScheduleState,
  V17_DEFAULT_SLEEP_SCHEDULE_CONFIG,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v17-sched-'));
}

function state(overrides = {}) {
  return {
    version: 1,
    lastRunAt: null,
    nextRunAt: null,
    dayKey: '2026-01-01',
    runsToday: 0,
    consecutiveFailures: 0,
    totalRuns: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function config(overrides = {}) {
  return { ...V17_DEFAULT_SLEEP_SCHEDULE_CONFIG, ...overrides };
}

function localAt(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

function localDayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function seedEpisode(store, text) {
  store.ingestEpisode({
    turnId: `t-${Math.random().toString(36).slice(2, 8)}`,
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role: 'user',
    text,
  });
}

// --- pure functions ------------------------------------------------------

test('v17 scheduler: never run -> next run is now', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  const next = nextRunAtV17(config({ enabled: true, quietHours: null }), state(), now);
  assert.equal(next.getTime(), now.getTime());
});

test('v17 scheduler: after a run -> lastRun + interval', () => {
  const cfg = config({ enabled: true, quietHours: null, intervalMs: 2 * 60 * 60 * 1000, cooldownMs: 5 * 60 * 1000 });
  const st = state({ lastRunAt: '2026-01-01T08:00:00.000Z', dayKey: '2026-01-01' });
  const next = nextRunAtV17(cfg, st, new Date('2026-01-01T09:00:00.000Z'));
  assert.equal(next.toISOString(), '2026-01-01T10:00:00.000Z');
});

test('v17 scheduler: failures back off the next run (doubles)', () => {
  const cfg = config({ enabled: true, quietHours: null, intervalMs: 60 * 60 * 1000, cooldownMs: 60 * 60 * 1000, maxBackoffMs: 4 * 60 * 60 * 1000 });
  const base = state({ lastRunAt: '2026-01-01T08:00:00.000Z', dayKey: '2026-01-01' });
  const noFail = nextRunAtV17(cfg, base, new Date('2026-01-01T08:30:00.000Z'));
  const twoFail = nextRunAtV17(cfg, { ...base, consecutiveFailures: 2 }, new Date('2026-01-01T08:30:00.000Z'));
  // 0 loi: gap = max(1h, 1h, 1h*2^0=1h) = 1h -> 09:00.
  // 2 loi: backoff = 1h*2^(2-1) = 2h -> gap 2h -> 10:00 (cap 4h khong chan).
  assert.equal(noFail.toISOString(), '2026-01-01T09:00:00.000Z');
  assert.equal(twoFail.toISOString(), '2026-01-01T10:00:00.000Z');
});

test('v17 scheduler: quiet hours push next run to end of quiet hours', () => {
  const cfg = config({ enabled: true, quietHours: { startHour: 23, endHour: 7 } });
  const night = localAt(2, 0);
  const next = nextRunAtV17(cfg, state(), night);
  assert.equal(isInQuietHoursV17(cfg.quietHours, next), false);
  assert.equal(next.getHours(), 7);
});

test('v17 scheduler: maxRunsPerDay pushes next run to tomorrow', () => {
  const cfg = config({ enabled: true, quietHours: null, maxRunsPerDay: 1 });
  const now = new Date('2026-01-01T10:00:00.000Z');
  const st = state({ lastRunAt: '2026-01-01T08:00:00.000Z', dayKey: '2026-01-01', runsToday: 1 });
  const next = nextRunAtV17(cfg, st, now);
  assert.ok(next.getTime() >= new Date('2026-01-02T00:00:00.000Z').getTime());
});

test('v17 scheduler: shouldRun — disabled / quiet / maxed / not due / due', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  assert.equal(shouldRunScheduledV17(config({ enabled: false }), state(), now).run, false);
  const quietCfg = config({ enabled: true, quietHours: { startHour: 0, endHour: 23 } });
  assert.equal(shouldRunScheduledV17(quietCfg, state(), localAt(12)).run, false);
  const maxed = config({ enabled: true, quietHours: null, maxRunsPerDay: 1 });
  assert.equal(
    shouldRunScheduledV17(maxed, state({ dayKey: localDayKey(), runsToday: 1 }), new Date()).run,
    false,
  );
  const notDue = config({ enabled: true, quietHours: null, intervalMs: 2 * 60 * 60 * 1000 });
  assert.equal(
    shouldRunScheduledV17(notDue, state({ lastRunAt: new Date().toISOString(), dayKey: localDayKey() }), new Date()).run,
    false,
  );
  assert.equal(shouldRunScheduledV17(config({ enabled: true, quietHours: null }), state(), now).run, true);
});

test('v17 scheduler: quiet hours overnight window + endOfQuietHours', () => {
  const q = { startHour: 23, endHour: 7 };
  assert.equal(isInQuietHoursV17(q, localAt(23, 30)), true);
  assert.equal(isInQuietHoursV17(q, localAt(3, 0)), true);
  assert.equal(isInQuietHoursV17(q, localAt(12, 0)), false);
  assert.equal(isInQuietHoursV17(q, localAt(7, 0)), false);
  const end = endOfQuietHoursV17(q, localAt(2, 0));
  assert.equal(end.getHours(), 7);
  assert.ok(end.getTime() > localAt(2, 0).getTime());
  assert.throws(() => {
    createV17SleepScheduler(freshStore(), tmpDir(), SCOPE, { quietHours: { startHour: 25, endHour: 7 } });
  }, /0\.\.23/);
  assert.throws(() => {
    createV17SleepScheduler(freshStore(), tmpDir(), SCOPE, { intervalMs: 1000 });
  }, /toi thieu 1 phut/);
});

// --- scheduler class -----------------------------------------------------

test('v17 scheduler: tick runs when due and persists state', () => {
  const dir = tmpDir();
  const store = freshStore();
  seedEpisode(store, 'Huy thich ca phe den.');
  const scheduler = new V17SleepScheduler(store, dir, SCOPE, {
    enabled: true,
    intervalMs: 60 * 60 * 1000,
    quietHours: null,
  });
  const blockStore = new V15BlockStore();
  const adapter = new V16V15BlockAdapter(blockStore);
  const report = scheduler.tick({ blocks: adapter, blockStore }, new Date('2026-01-01T10:00:00.000Z'));
  assert.ok(report);
  assert.equal(report.trigger, 'scheduled');
  assert.equal(report.episodesProcessed, 1);
  const reloaded = loadV17SleepScheduleState(dir);
  assert.equal(reloaded.totalRuns, 1);
  assert.equal(reloaded.runsToday, 1);
  assert.ok(reloaded.nextRunAt);
  // Tick ngay lai thi bo qua (chua den lich).
  const again = scheduler.tick({ blocks: adapter }, new Date('2026-01-01T10:01:00.000Z'));
  assert.equal(again, null);
});

test('v17 scheduler: tick skips when disabled', () => {
  const dir = tmpDir();
  const store = freshStore();
  seedEpisode(store, 'Huy thich ca phe den.');
  const scheduler = new V17SleepScheduler(store, dir, SCOPE, { enabled: false, quietHours: null });
  assert.equal(scheduler.tick({}, new Date('2026-01-01T10:00:00.000Z')), null);
});

test('v17 scheduler: runOnCompact runs immediately, respects quiet hours', () => {
  const dir = tmpDir();
  const store = freshStore();
  seedEpisode(store, 'Huy thich ca phe den.');
  const scheduler = new V17SleepScheduler(store, dir, SCOPE, {
    enabled: true,
    quietHours: { startHour: 0, endHour: 23 },
    respectQuietHoursOnCompact: true,
  });
  // 12h local nam trong quiet hours 0-23 -> bo qua.
  assert.equal(scheduler.runOnCompact({}, localAt(12, 0)), null);
  // Tat ton trong quiet hours -> chay ngay.
  scheduler.updateConfig({ respectQuietHoursOnCompact: false });
  const report = scheduler.runOnCompact({}, localAt(12, 0));
  assert.ok(report);
  assert.equal(report.trigger, 'compact');
});

test('v17 scheduler: runManual bypasses schedule + state survives new instance', () => {
  const dir = tmpDir();
  const store = freshStore();
  seedEpisode(store, 'Huy thich ca phe den.');
  const s1 = createV17SleepScheduler(store, dir, SCOPE, { enabled: false, quietHours: null });
  const report = s1.runManual({});
  assert.ok(report);
  assert.equal(report.trigger, 'manual');
  const s2 = createV17SleepScheduler(store, dir, SCOPE, { enabled: false, quietHours: null });
  assert.equal(s2.getState().totalRuns, 1);
  assert.equal(s2.getState().runsToday, 1);
});

test('v17 scheduler: default state + updateConfig round-trip', () => {
  const s = defaultV17SleepScheduleState(new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(s.totalRuns, 0);
  assert.equal(s.lastRunAt, null);
  const scheduler = new V17SleepScheduler(freshStore(), tmpDir(), SCOPE, { enabled: false });
  const updated = scheduler.updateConfig({ enabled: true, maxRunsPerDay: 3 });
  assert.equal(updated.enabled, true);
  assert.equal(updated.maxRunsPerDay, 3);
  assert.equal(scheduler.getConfig().maxRunsPerDay, 3);
});
