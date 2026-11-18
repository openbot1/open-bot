/**
 * Composio v119 tests — usage metering (v1.19, Doi T4 — node:test,
 * no network, no key).
 *
 * Covers usageMeteringV119.ts:
 * - Quota validation + defaults, state create/validate (counter
 *   invariants: succeeded+failed == calls, mock+live == calls,
 *   no duplicate counters, version check)
 * - record: accumulation, success/failure + mock/live splits,
 *   quota blocking at toolkit / user / global level (blocked
 *   counts, calls do not)
 * - Per-day totals (toolkit/user/global), prune by maxDaysKept
 * - Report: totals, top toolkit/user (ordered, topN), byDay,
 *   overQuota (3 levels), highFailure (>= 5 calls, >= 50%)
 * - Summary text, memory store + JSON file store
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v119-usage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPOSIO_V119_DEFAULT_DAILY_CAP_GLOBAL,
  COMPOSIO_V119_DEFAULT_DAILY_CAP_PER_TOOLKIT,
  COMPOSIO_V119_DEFAULT_DAILY_CAP_PER_USER,
  COMPOSIO_V119_DEFAULT_MAX_DAYS_KEPT,
  COMPOSIO_V119_DEFAULT_TOP_N,
  COMPOSIO_V119_USAGE_VERSION,
  JsonFileComposioV119UsageStore,
  MemoryComposioV119UsageStore,
  buildComposioV119UsageReport,
  checkComposioV119Quota,
  composioV119GlobalCallsToday,
  composioV119ToolkitCallsToday,
  composioV119UsageDayKey,
  composioV119UserCallsToday,
  createComposioV119UsageState,
  pruneComposioV119Usage,
  recordComposioV119Usage,
  summarizeComposioV119Usage,
  validateComposioV119Quota,
  validateComposioV119UsageCounter,
  validateComposioV119UsageState,
} from '../packages/core/dist/composio/usageMeteringV119.js';

const NOW = 1780000000000; // 2026-05-28T20:26:40Z
const DAY1 = '2026-05-28';
const DAY2 = '2026-05-29';
const DAY3 = '2026-05-30';

function record(state, userId, toolkit, succeeded, mock, nowMs = NOW) {
  return recordComposioV119Usage(state, { userId, toolkit, succeeded, mock }, nowMs);
}

test('v119 usage: quota defaults + validation', () => {
  assert.equal(COMPOSIO_V119_USAGE_VERSION, 1);
  assert.equal(COMPOSIO_V119_DEFAULT_DAILY_CAP_PER_TOOLKIT, 10_000);
  assert.equal(COMPOSIO_V119_DEFAULT_DAILY_CAP_PER_USER, 50_000);
  assert.equal(COMPOSIO_V119_DEFAULT_DAILY_CAP_GLOBAL, 200_000);
  assert.equal(COMPOSIO_V119_DEFAULT_MAX_DAYS_KEPT, 90);
  assert.equal(COMPOSIO_V119_DEFAULT_TOP_N, 10);
  const q = validateComposioV119Quota(undefined);
  assert.deepEqual(q, { dailyCapPerToolkit: 10_000, dailyCapPerUser: 50_000, dailyCapGlobal: 200_000 });
  assert.deepEqual(validateComposioV119Quota({ dailyCapPerToolkit: 5 }), {
    dailyCapPerToolkit: 5,
    dailyCapPerUser: 50_000,
    dailyCapGlobal: 200_000,
  });
  assert.throws(() => validateComposioV119Quota({ dailyCapPerToolkit: -1 }), /quota dailyCapPerToolkit must be a non-negative integer/);
  assert.throws(() => validateComposioV119Quota({ dailyCapGlobal: 1.5 }), /non-negative integer/);
});

test('v119 usage: state create/validate + counter invariants', () => {
  assert.equal(composioV119UsageDayKey(NOW), DAY1);
  assert.equal(composioV119UsageDayKey(NOW + 86_400_000), DAY2);
  const s = createComposioV119UsageState();
  assert.equal(s.version, 1);
  assert.equal(s.maxDaysKept, 90);
  assert.deepEqual(s.counters, []);
  assert.deepEqual(validateComposioV119UsageState(s), s);
  assert.throws(() => createComposioV119UsageState(undefined, 0), /maxDaysKept must be a positive integer/);
  assert.throws(() => validateComposioV119UsageState({ ...s, version: 2 }), /unsupported usage state version/);
  const counter = {
    day: DAY1, userId: 'u1', toolkit: 'gmail',
    calls: 3, succeeded: 2, failed: 1, blocked: 0, mockCalls: 3, liveCalls: 0,
  };
  assert.deepEqual(validateComposioV119UsageCounter(counter), counter);
  assert.throws(
    () => validateComposioV119UsageCounter({ ...counter, failed: 2 }),
    /succeeded \+ failed must equal calls/,
  );
  assert.throws(
    () => validateComposioV119UsageCounter({ ...counter, mockCalls: 2, liveCalls: 0 }),
    /mockCalls \+ liveCalls must equal calls/,
  );
  assert.throws(() => validateComposioV119UsageCounter({ ...counter, day: '28-05-2026' }), /day must be YYYY-MM-DD/);
  assert.throws(
    () => validateComposioV119UsageState({ ...s, counters: [counter, counter] }),
    /must not contain duplicates/,
  );
});

test('v119 usage: record accumulates + splits success/mock/live', () => {
  let state = createComposioV119UsageState();
  let r = record(state, 'u1', 'gmail', true, true);
  state = r.state;
  assert.equal(r.result.allowed, true);
  assert.equal(r.result.counter.calls, 1);
  assert.equal(r.result.counter.succeeded, 1);
  assert.equal(r.result.counter.mockCalls, 1);
  assert.equal(r.result.counter.liveCalls, 0);
  r = record(state, 'u1', 'gmail', false, false);
  state = r.state;
  assert.equal(r.result.counter.calls, 2);
  assert.equal(r.result.counter.failed, 1);
  assert.equal(r.result.counter.liveCalls, 1);
  r = record(state, 'u1', 'slack', true, true);
  state = r.state;
  assert.equal(state.counters.length, 2, 'one counter per (day, user, toolkit)');
  assert.equal(composioV119ToolkitCallsToday(state, 'u1', 'gmail', DAY1), 2);
  assert.equal(composioV119ToolkitCallsToday(state, 'u1', 'slack', DAY1), 1);
  assert.equal(composioV119ToolkitCallsToday(state, 'u1', 'notion', DAY1), 0);
  assert.equal(composioV119UserCallsToday(state, 'u1', DAY1), 3);
  assert.equal(composioV119UserCallsToday(state, 'u2', DAY1), 0);
  assert.equal(composioV119GlobalCallsToday(state, DAY1), 3);
  assert.equal(composioV119GlobalCallsToday(state, DAY2), 0);
  assert.equal(checkComposioV119Quota(state, 'u1', 'gmail', NOW), null);
  assert.throws(() => record(state, '', 'gmail', true, true), /userId must be a non-empty string/);
  assert.throws(() => record(state, 'u1', '', true, true), /toolkit must be a non-empty string/);
});

test('v119 usage: quota blocks at toolkit, then user, then global level', () => {
  let state = createComposioV119UsageState({ dailyCapPerToolkit: 2, dailyCapPerUser: 3, dailyCapGlobal: 5 });
  // Toolkit cap: 2 gmail calls allowed, the 3rd is blocked (toolkit level).
  for (let i = 0; i < 2; i += 1) {
    const r = record(state, 'u1', 'gmail', true, true);
    state = r.state;
    assert.equal(r.result.allowed, true);
  }
  let blocked = record(state, 'u1', 'gmail', true, true);
  state = blocked.state;
  assert.equal(blocked.result.allowed, false);
  assert.equal(blocked.result.blockedBy, 'toolkit');
  assert.equal(blocked.result.counter.calls, 2, 'blocked calls do not count as calls');
  assert.equal(blocked.result.counter.blocked, 1);
  // User cap: slack #1 allowed (user total 2 → 3), slack #2 blocked at user level.
  let r = record(state, 'u1', 'slack', true, true);
  state = r.state;
  assert.equal(r.result.allowed, true);
  assert.equal(composioV119UserCallsToday(state, 'u1', DAY1), 3);
  blocked = record(state, 'u1', 'slack', true, true);
  state = blocked.state;
  assert.equal(blocked.result.allowed, false);
  assert.equal(blocked.result.blockedBy, 'user');
  // Global cap: u2 fills the remaining 2 global calls (total 3 → 5).
  for (let i = 0; i < 2; i += 1) {
    r = record(state, 'u2', 'gmail', true, true);
    state = r.state;
    assert.equal(r.result.allowed, true);
  }
  assert.equal(composioV119GlobalCallsToday(state, DAY1), 5);
  blocked = record(state, 'u2', 'slack', true, true);
  assert.equal(blocked.result.allowed, false);
  assert.equal(blocked.result.blockedBy, 'global');
  // Quota 0 = fully off at that level.
  const off = createComposioV119UsageState({ dailyCapPerToolkit: 0 });
  const zero = record(off, 'u1', 'gmail', true, true);
  assert.equal(zero.result.allowed, false);
  assert.equal(zero.result.blockedBy, 'toolkit');
});

test('v119 usage: prune drops days beyond maxDaysKept', () => {
  let state = createComposioV119UsageState(undefined, 2);
  for (const [day, ms] of [[DAY1, NOW], [DAY2, NOW + 86_400_000], [DAY3, NOW + 2 * 86_400_000]]) {
    const r = record(state, 'u1', 'gmail', true, true, ms);
    state = r.state;
    void day;
  }
  assert.equal(state.counters.length, 2, 'only the 2 newest days are kept');
  assert.deepEqual(state.counters.map((c) => c.day), [DAY2, DAY3]);
  assert.equal(pruneComposioV119Usage(state).counters.length, 2);
});

test('v119 usage: report totals, tops, byDay, overQuota, highFailure', () => {
  // State A — tiny caps (2/3/5): day 1 only, to exercise overQuota.
  let state = createComposioV119UsageState({ dailyCapPerToolkit: 2, dailyCapPerUser: 3, dailyCapGlobal: 5 });
  const addA = (userId, toolkit, succeeded, mock) => {
    const r = record(state, userId, toolkit, succeeded, mock, NOW);
    state = r.state;
    return r.result.allowed;
  };
  addA('u1', 'gmail', true, true);
  addA('u1', 'gmail', false, false);
  addA('u1', 'slack', true, true);
  addA('u2', 'gmail', true, true);
  addA('u2', 'gmail', true, true);
  assert.equal(addA('u2', 'slack', true, true), false, 'global cap blocks the 6th call');

  const report = buildComposioV119UsageReport(state, { day: DAY1, nowMs: NOW });
  assert.equal(report.day, DAY1);
  assert.deepEqual(report.range, { from: DAY1, to: DAY1 });
  assert.equal(report.totalCalls, 5);
  assert.equal(report.totalSucceeded, 4);
  assert.equal(report.totalFailed, 1);
  assert.equal(report.totalBlocked, 1, 'the blocked global call');
  assert.equal(report.totalMockCalls, 4);
  assert.equal(report.totalLiveCalls, 1);
  assert.equal(report.failureRate, 0.2);
  assert.deepEqual(report.byToolkit.map((e) => e.key), ['gmail', 'slack'], 'ordered by calls desc');
  assert.equal(report.byToolkit[0].calls, 4);
  assert.deepEqual(report.byUser.map((e) => e.key), ['u1', 'u2']);
  assert.equal(report.byUser[0].calls, 3);
  assert.equal(report.byDay.length, 1);
  assert.equal(report.byDay[0].day, DAY1);
  assert.equal(report.byDay[0].calls, 5);
  assert.deepEqual(
    report.overQuota.map((o) => `${o.level}:${o.userId}:${o.toolkit}`),
    ['toolkit:u1:gmail', 'toolkit:u2:gmail', 'user:u1:*', 'global:*:*'],
    'toolkit caps, user cap (u1 = 3), global cap (5)',
  );
  assert.deepEqual(report.highFailure, [], 'day 1 has no high-failure (user, toolkit)');
  // topN slices the lists.
  const top1 = buildComposioV119UsageReport(state, { day: DAY1, topN: 1, nowMs: NOW });
  assert.equal(top1.byToolkit.length, 1);
  assert.equal(top1.byUser.length, 1);

  // State B — roomy caps (10/10/20): two days, to exercise
  // byDay + highFailure without quota blocking getting in the way.
  let stateB = createComposioV119UsageState({ dailyCapPerToolkit: 10, dailyCapPerUser: 10, dailyCapGlobal: 20 });
  const addB = (userId, toolkit, succeeded, mock, nowMs) => {
    const r = record(stateB, userId, toolkit, succeeded, mock, nowMs);
    stateB = r.state;
    return r.result.allowed;
  };
  addB('u1', 'gmail', true, true, NOW);
  addB('u1', 'gmail', false, false, NOW);
  addB('u1', 'slack', true, true, NOW);
  addB('u2', 'gmail', true, true, NOW);
  addB('u2', 'gmail', true, true, NOW);
  // Day 2: u1 github 5 calls, 3 failed → high failure.
  for (let i = 0; i < 5; i += 1) assert.equal(addB('u1', 'github', i < 2, true, NOW + 86_400_000), true);
  // Day 2: u2 notion 4 calls, all failed → not high failure (< 5 calls).
  for (let i = 0; i < 4; i += 1) assert.equal(addB('u2', 'notion', false, true, NOW + 86_400_000), true);

  const day2 = buildComposioV119UsageReport(stateB, { day: DAY2, nowMs: NOW + 86_400_000 });
  assert.equal(day2.day, DAY2);
  assert.deepEqual(day2.range, { from: DAY1, to: DAY2 });
  assert.equal(day2.totalCalls, 9);
  assert.equal(day2.totalFailed, 7);
  assert.deepEqual(day2.byDay.map((d) => [d.day, d.calls]), [[DAY1, 5], [DAY2, 9]]);
  assert.deepEqual(day2.byToolkit.map((e) => e.key), ['github', 'notion']);
  assert.deepEqual(day2.highFailure, [{ userId: 'u1', toolkit: 'github', calls: 5, failureRate: 0.6 }]);
  assert.deepEqual(day2.overQuota, [], 'roomy caps → nothing over quota');
});

test('v119 usage: empty report + summary text', () => {
  const state = createComposioV119UsageState();
  const report = buildComposioV119UsageReport(state, { day: DAY1, nowMs: NOW });
  assert.equal(report.totalCalls, 0);
  assert.equal(report.failureRate, 0);
  assert.deepEqual(report.byToolkit, []);
  assert.deepEqual(report.byUser, []);
  assert.deepEqual(report.byDay, []);
  assert.deepEqual(report.overQuota, []);
  assert.deepEqual(report.highFailure, []);
  assert.match(summarizeComposioV119Usage(state, NOW), /2026-05-28: 0 calls \(0 live, 0 mock\), 0 failed, 0 blocked, 0 over quota/);
  let s2 = createComposioV119UsageState();
  const r = record(s2, 'u1', 'gmail', true, true);
  s2 = r.state;
  assert.match(summarizeComposioV119Usage(s2, NOW), /1 calls \(0 live, 1 mock\)/);
});

test('v119 usage: memory store load/save/clear', () => {
  const store = new MemoryComposioV119UsageStore();
  const empty = store.load();
  assert.deepEqual(empty.counters, []);
  let state = record(empty, 'u1', 'gmail', true, true).state;
  store.save(state);
  assert.equal(store.load().counters.length, 1);
  assert.throws(() => store.save({ ...store.load(), version: 99 }), /unsupported usage state version/);
  store.clear();
  assert.deepEqual(store.load().counters, []);
  // Custom quota survives a clear.
  const custom = new MemoryComposioV119UsageStore({ dailyCapPerToolkit: 7 }, 30);
  assert.equal(custom.load().quota.dailyCapPerToolkit, 7);
  assert.equal(custom.load().maxDaysKept, 30);
});

test('v119 usage: JSON file store persists + clear removes the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'composio-v119-usage-'));
  try {
    const store = new JsonFileComposioV119UsageStore(dir);
    assert.deepEqual(store.load().counters, []);
    let state = record(store.load(), 'u1', 'gmail', true, true).state;
    store.save(state);
    assert.ok(existsSync(join(dir, 'composio-usage-v119.json')));
    const store2 = new JsonFileComposioV119UsageStore(dir);
    assert.equal(store2.load().counters.length, 1);
    assert.equal(store2.load().counters[0].calls, 1);
    assert.throws(() => store2.save({ ...store2.load(), version: 99 }), /unsupported usage state version/);
    store2.clear();
    assert.equal(existsSync(join(dir, 'composio-usage-v119.json')), false);
    assert.deepEqual(store2.load().counters, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => new JsonFileComposioV119UsageStore(''), /non-empty string/);
});
