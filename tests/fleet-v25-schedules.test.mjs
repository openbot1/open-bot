/**
 * Tests for fleet v25 schedules v2 + runs v2 + engine (v1.38, Team T6).
 *
 * Covers:
 * - Cron: parse/validate (lists, ranges, steps, dow 7 = Sunday),
 *   next-run (incl. day-of-month/day-of-week OR semantics), bad input.
 * - Conditions: all 5 types (previous outcome, time window incl.
 *   midnight wrap, max runs/day, tag status, cooldown).
 * - Retry: exponential backoff, cap, should-retry rules.
 * - Registry: create/validate/enable/disable/pause/resume/remove,
 *   due schedules, recordRunStart/Outcome (retry arming, skip
 *   clears a pending retry), stats.
 * - Run ledger: start/finish, query, retry groups, stuck runs,
 *   failure rate, timing, runsToday.
 * - Engine: dry-run preview, tick success/failure/skip/defer,
 *   retry chain (same group, attempt 2), dispatcher throw.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v25-schedules.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V25_DEFAULT_RETRY_POLICY,
  FleetV25AutomationEngine,
  FleetV25ScheduleRegistry,
  FleetV25ScheduledRunLedger,
  computeFleetV25NextRun,
  createFleetV25ScheduleRegistry,
  createFleetV25ScheduledRunLedger,
  describeFleetV25Cron,
  evaluateFleetV25Condition,
  evaluateFleetV25Conditions,
  fleetV25ConditionsPassed,
  fleetV25RetryDelayMs,
  fleetV25ShouldRetry,
  nextFleetV25CronRunMs,
  parseFleetV25Cron,
  summarizeFleetV25Schedules,
  validateFleetV25Condition,
  validateFleetV25Cron,
  validateFleetV25RetryPolicy,
  validateFleetV25ScheduleTiming,
} from '../packages/core/dist/fleetV25/index.js';

// Wednesday 2026-11-18 00:00 UTC (task date).
const WED = Date.UTC(2026, 10, 18, 0, 0, 0);
const HOUR = 3600000;
const MIN = 60000;

function ctx(over = {}) {
  return { lastOutcome: null, runsToday: 0, lastFinishedAtMs: null, nowMs: WED + 10 * HOUR, ...over };
}

test('cron v25: parse — fields, lists, ranges, steps, dow 7', () => {
  const c = parseFleetV25Cron('0 9 * * 1-5');
  assert.equal(c.text, '0 9 * * 1-5');
  assert.deepEqual(c.minute.values, [0]);
  assert.deepEqual(c.hour.values, [9]);
  assert.equal(c.dayOfMonth.unrestricted, true);
  assert.deepEqual(c.dayOfWeek.values, [1, 2, 3, 4, 5]);
  const steps = parseFleetV25Cron('*/15 * * * *');
  assert.deepEqual(steps.minute.values, [0, 15, 30, 45]);
  const list = parseFleetV25Cron('0,30 8,18 * * *');
  assert.deepEqual(list.minute.values, [0, 30]);
  assert.deepEqual(list.hour.values, [8, 18]);
  const sunday = parseFleetV25Cron('30 2 * * 7');
  assert.deepEqual(sunday.dayOfWeek.values, [0]);
  const rangeStep = parseFleetV25Cron('0 0-23/6 * * *');
  assert.deepEqual(rangeStep.hour.values, [0, 6, 12, 18]);
  assert.equal(validateFleetV25Cron('0 9 * * *').valid, true);
  assert.equal(describeFleetV25Cron(c).includes('Cron "0 9 * * 1-5"'), true);
});

test('cron v25: parse — bad input rejected', () => {
  assert.equal(validateFleetV25Cron('0 9 * *').valid, false);
  assert.equal(validateFleetV25Cron('0 25 * * *').valid, false);
  assert.equal(validateFleetV25Cron('0 9 * * 8').valid, false);
  assert.equal(validateFleetV25Cron('x 9 * * *').valid, false);
  assert.equal(validateFleetV25Cron('0 9 * * */0').valid, false);
  assert.equal(validateFleetV25Cron('').valid, false);
  assert.equal(validateFleetV25Cron('0 9 * * * extra').valid, false);
  assert.match(validateFleetV25Cron('0 25 * * *').problems[0], /hour/);
  assert.throws(() => parseFleetV25Cron('0 9 * *'), /5 fields/);
});

test('cron v25: next run — weekday, Sunday, OR semantics', () => {
  // Weekdays 09:00 from Wed 00:00 → same day 09:00.
  assert.equal(
    nextFleetV25CronRunMs(parseFleetV25Cron('0 9 * * 1-5'), WED),
    WED + 9 * HOUR,
  );
  // Already past 09:00 on Wed → Thu 09:00.
  assert.equal(
    nextFleetV25CronRunMs(parseFleetV25Cron('0 9 * * 1-5'), WED + 10 * HOUR),
    WED + 24 * HOUR + 9 * HOUR,
  );
  // Sunday 02:30 from Wed → Sun Nov 22 02:30.
  assert.equal(
    nextFleetV25CronRunMs(parseFleetV25Cron('30 2 * * 0'), WED),
    Date.UTC(2026, 10, 22, 2, 30, 0),
  );
  // Every 15 min from 00:00 → 00:15 (strictly after).
  assert.equal(
    nextFleetV25CronRunMs(parseFleetV25Cron('*/15 * * * *'), WED),
    WED + 15 * MIN,
  );
  // dom=1 OR dow=Sunday: from Wed Nov 18, the next match is Sunday
  // Nov 22 (dow), before Dec 1 (dom).
  assert.equal(
    nextFleetV25CronRunMs(parseFleetV25Cron('0 0 1 * 0'), WED),
    Date.UTC(2026, 10, 22, 0, 0, 0),
  );
  // Monthly on the 1st: from Nov 18 → Dec 1 00:00.
  assert.equal(
    nextFleetV25CronRunMs(parseFleetV25Cron('0 0 1 * *'), WED),
    Date.UTC(2026, 11, 1, 0, 0, 0),
  );
  // Exactly on a fire time → the *next* fire (strictly after).
  assert.equal(
    nextFleetV25CronRunMs(parseFleetV25Cron('0 9 * * *'), WED + 9 * HOUR),
    WED + 24 * HOUR + 9 * HOUR,
  );
});

test('conditions v25: all five types', () => {
  // previous-run-outcome
  assert.equal(evaluateFleetV25Condition({ type: 'previous-run-outcome', outcomes: ['failed'] }, ctx({ lastOutcome: 'failed' })).passed, true);
  assert.equal(evaluateFleetV25Condition({ type: 'previous-run-outcome', outcomes: ['failed'] }, ctx({ lastOutcome: 'completed' })).passed, false);
  assert.equal(evaluateFleetV25Condition({ type: 'previous-run-outcome', outcomes: ['failed'] }, ctx()).passed, false);
  // time-window (9-17 UTC)
  assert.equal(evaluateFleetV25Condition({ type: 'time-window', startHour: 9, endHour: 17 }, ctx()).passed, true);
  assert.equal(evaluateFleetV25Condition({ type: 'time-window', startHour: 9, endHour: 17 }, ctx({ nowMs: WED + 20 * HOUR })).passed, false);
  // midnight wrap: 22-06 passes at 23:00 and 02:00, fails at 12:00.
  const wrap = { type: 'time-window', startHour: 22, endHour: 6 };
  assert.equal(evaluateFleetV25Condition(wrap, ctx({ nowMs: WED + 23 * HOUR })).passed, true);
  assert.equal(evaluateFleetV25Condition(wrap, ctx({ nowMs: WED + 2 * HOUR })).passed, true);
  assert.equal(evaluateFleetV25Condition(wrap, ctx({ nowMs: WED + 12 * HOUR })).passed, false);
  // max-runs-per-day
  assert.equal(evaluateFleetV25Condition({ type: 'max-runs-per-day', maxRuns: 3 }, ctx({ runsToday: 2 })).passed, true);
  assert.equal(evaluateFleetV25Condition({ type: 'max-runs-per-day', maxRuns: 3 }, ctx({ runsToday: 3 })).passed, false);
  // tag-status
  const tag = { type: 'tag-status', tag: 'nightly', status: 'idle' };
  assert.equal(evaluateFleetV25Condition(tag, ctx({ tagStatuses: { nightly: ['idle', 'idle'] } })).passed, true);
  assert.equal(evaluateFleetV25Condition(tag, ctx({ tagStatuses: { nightly: ['idle', 'running'] } })).passed, false);
  assert.equal(evaluateFleetV25Condition(tag, ctx({ tagStatuses: {} })).passed, false);
  // cooldown
  assert.equal(evaluateFleetV25Condition({ type: 'cooldown', minMsSinceLastRun: HOUR }, ctx()).passed, true);
  assert.equal(evaluateFleetV25Condition({ type: 'cooldown', minMsSinceLastRun: HOUR }, ctx({ lastFinishedAtMs: WED + 9 * HOUR + 30 * MIN })).passed, false);
  assert.equal(evaluateFleetV25Condition({ type: 'cooldown', minMsSinceLastRun: HOUR }, ctx({ lastFinishedAtMs: WED + 8 * HOUR })).passed, true);

  // AND across conditions + validation problems.
  const results = evaluateFleetV25Conditions(
    [{ type: 'time-window', startHour: 9, endHour: 17 }, { type: 'max-runs-per-day', maxRuns: 1 }],
    ctx({ runsToday: 1 }),
  );
  assert.equal(results.length, 2);
  assert.equal(fleetV25ConditionsPassed(results), false);
  assert.deepEqual(validateFleetV25Condition({ type: 'time-window', startHour: 9, endHour: 9 }), ['time-window startHour must differ from endHour.']);
  assert.deepEqual(validateFleetV25Condition({ type: 'max-runs-per-day', maxRuns: 0 }), ['max-runs-per-day needs maxRuns, an integer >= 1.']);
  assert.deepEqual(validateFleetV25Condition({ type: 'tag-status' }), ['tag-status needs a tag.', 'tag-status needs a status.']);
  assert.equal(validateFleetV25Condition({ type: 'nope' }).length, 1);
});

test('retry v25: backoff, cap, should-retry', () => {
  assert.deepEqual(validateFleetV25RetryPolicy(FLEET_V25_DEFAULT_RETRY_POLICY), []);
  assert.equal(FLEET_V25_DEFAULT_RETRY_POLICY.maxRetries, 0);
  const policy = { maxRetries: 3, backoffMs: 60000, backoffMultiplier: 2, maxBackoffMs: 200000, retryOn: ['failed'] };
  assert.equal(fleetV25RetryDelayMs(policy, 1), 60000);
  assert.equal(fleetV25RetryDelayMs(policy, 2), 120000);
  assert.equal(fleetV25RetryDelayMs(policy, 3), 200000); // capped
  assert.equal(fleetV25RetryDelayMs(policy, 0), 0);
  assert.equal(fleetV25ShouldRetry(policy, 'failed', 1), true);
  assert.equal(fleetV25ShouldRetry(policy, 'failed', 3), true);
  assert.equal(fleetV25ShouldRetry(policy, 'failed', 4), false);
  assert.equal(fleetV25ShouldRetry(policy, 'completed', 1), false);
  assert.equal(fleetV25ShouldRetry(FLEET_V25_DEFAULT_RETRY_POLICY, 'failed', 1), false);
  assert.equal(validateFleetV25RetryPolicy({ ...policy, maxRetries: 11 }).length, 1);
  assert.equal(validateFleetV25RetryPolicy({ ...policy, maxBackoffMs: 1000 }).length, 1);
  assert.equal(validateFleetV25RetryPolicy({ ...policy, retryOn: [] }).length, 1);
});

test('schedules v25: timing validation', () => {
  assert.deepEqual(validateFleetV25ScheduleTiming({ kind: 'cron', cron: '0 9 * * *' }), []);
  assert.deepEqual(validateFleetV25ScheduleTiming({ kind: 'interval', intervalMs: 60000 }), []);
  assert.deepEqual(validateFleetV25ScheduleTiming({ kind: 'once', runAtMs: WED }), []);
  assert.equal(validateFleetV25ScheduleTiming({ kind: 'cron', cron: '' }).length, 1);
  assert.equal(validateFleetV25ScheduleTiming({ kind: 'cron', cron: '0 9 * * *', intervalMs: 1000 }).length, 1);
  assert.equal(validateFleetV25ScheduleTiming({ kind: 'interval', intervalMs: 999 }).length, 1);
  assert.equal(validateFleetV25ScheduleTiming({ kind: 'interval' }).length, 1);
  assert.equal(validateFleetV25ScheduleTiming({ kind: 'once' }).length, 1);
  assert.equal(validateFleetV25ScheduleTiming({ kind: 'once', runAtMs: WED, cron: '0 9 * * *' }).length, 1);
  assert.equal(validateFleetV25ScheduleTiming({ kind: 'nope' }).length, 1);
});

function registryWithTwo() {
  const r = createFleetV25ScheduleRegistry();
  r.create({ id: 's-cron', automationId: 'auto-a', owner: 'team-data', name: 'Nightly', kind: 'cron', cron: '0 9 * * *' }, WED);
  r.create({
    id: 's-int', automationId: 'auto-b', owner: 'team-ops', name: 'Hourly',
    kind: 'interval', intervalMs: HOUR,
    conditions: [{ type: 'time-window', startHour: 9, endHour: 17 }],
    retry: { maxRetries: 2, backoffMs: MIN },
  }, WED);
  return r;
}

test('schedules v25: registry CRUD + next run + due', () => {
  const r = registryWithTwo();
  assert.equal(r.size, 2);
  const cron = r.get('s-cron');
  assert.equal(cron.nextRunAtMs, WED + 9 * HOUR);
  assert.equal(cron.timezone, 'UTC');
  assert.equal(cron.enabled, true);
  assert.equal(cron.paused, false);
  const int = r.get('s-int');
  assert.equal(int.nextRunAtMs, WED + HOUR);
  assert.equal(int.retry.maxRetries, 2);
  assert.equal(int.retry.backoffMs, MIN);
  // A partial retry patch with explicit undefined keeps the defaults
  // (regression: tools pass through absent fields as undefined).
  const patched = r.create(
    { id: 's-undef', automationId: 'auto-c', owner: 'o', name: 'U', kind: 'once', runAtMs: WED + HOUR, retry: { maxRetries: undefined, backoffMs: undefined } },
    WED,
  );
  assert.equal(patched.retry.maxRetries, 0);
  assert.equal(patched.retry.backoffMs, 60000);
  r.remove('s-undef');

  assert.throws(
    () => r.create({ id: 's-cron', automationId: 'x', owner: 'y', name: 'Dup', kind: 'once', runAtMs: WED }, WED),
    /already exists/,
  );
  assert.throws(
    () => r.create({ id: 's-bad', automationId: 'x', owner: 'y', name: 'Bad', kind: 'cron', cron: '0 25 * * *' }, WED),
    /Invalid schedule timing/,
  );
  assert.throws(
    () => r.create({ id: 's-bad2', automationId: 'x', owner: 'y', name: 'Bad', kind: 'interval', intervalMs: 100, conditions: [{ type: 'time-window', startHour: 9, endHour: 9 }] }, WED),
    /Invalid schedule timing/,
  );

  // Due: nothing due at 00:30; interval due at 01:00; cron due at 09:00.
  assert.equal(r.dueSchedules(WED + 30 * MIN).length, 0);
  assert.deepEqual(r.dueSchedules(WED + HOUR).map((s) => s.id), ['s-int']);
  assert.deepEqual(r.dueSchedules(WED + 9 * HOUR).map((s) => s.id), ['s-int', 's-cron']);

  // Pause/resume/disable/enable.
  assert.equal(r.pause('s-int', WED).paused, true);
  assert.equal(r.dueSchedules(WED + HOUR).length, 0);
  assert.equal(r.resume('s-int', WED).paused, false);
  assert.equal(r.get('s-int').nextRunAtMs, WED + HOUR);
  assert.equal(r.disable('s-int', WED).enabled, false);
  assert.equal(r.get('s-int').nextRunAtMs, null);
  assert.equal(r.enable('s-int', WED).enabled, true);
  assert.equal(r.get('s-int').nextRunAtMs, WED + HOUR);

  // Update kind + timing recomputes next run; unknown id throws.
  const updated = r.update('s-int', { kind: 'once', runAtMs: WED + 5 * HOUR }, WED);
  assert.equal(updated.kind, 'once');
  assert.equal(updated.nextRunAtMs, WED + 5 * HOUR);
  assert.throws(() => r.update('nope', { name: 'x' }, WED), /does not exist/);
  assert.equal(r.remove('s-int'), true);
  assert.equal(r.remove('s-int'), false);
  assert.equal(r.byAutomation('auto-a').length, 1);
  assert.equal(r.byOwner('team-data').length, 1);
  assert.equal(r.byKind('cron').length, 1);
  assert.equal(r.live().length, 1);
  assert.match(summarizeFleetV25Schedules(r), /1 schedule/);
});

test('schedules v25: recordRunOutcome — retry arming + skip clears retry', () => {
  const r = createFleetV25ScheduleRegistry();
  r.create({
    id: 's-r', automationId: 'auto-a', owner: 'team-data', name: 'R',
    kind: 'interval', intervalMs: HOUR, retry: { maxRetries: 2, backoffMs: MIN },
  }, WED);
  r.recordRunStart('s-r', WED + HOUR, false);
  assert.equal(r.get('s-r').runCount, 1);
  assert.equal(r.get('s-r').nextRunAtMs, WED + 2 * HOUR);
  // Fail attempt 1 → retry armed at +60s, attempt 1.
  const afterFail = r.recordRunOutcome('s-r', 'failed', WED + HOUR + 1000, 1);
  assert.equal(afterFail.failureCount, 1);
  assert.equal(afterFail.consecutiveFailures, 1);
  assert.equal(afterFail.retryAtMs, WED + HOUR + 1000 + MIN);
  assert.equal(afterFail.retryAttempt, 1);
  assert.deepEqual(r.dueSchedules(WED + HOUR + 1000 + MIN).map((s) => s.id), ['s-r']);
  // Retry skipped by a condition → retry cleared, no infinite due loop.
  r.recordRunStart('s-r', WED + HOUR + 1000 + MIN, true);
  const afterSkip = r.recordRunOutcome('s-r', 'skipped-condition', WED + HOUR + 2000 + MIN, 2);
  assert.equal(afterSkip.skippedCount, 1);
  assert.equal(afterSkip.retryAtMs, null);
  assert.equal(afterSkip.retryAttempt, 0);
  // Success resets consecutive failures.
  r.recordRunStart('s-r', WED + 2 * HOUR, false);
  const afterOk = r.recordRunOutcome('s-r', 'completed', WED + 2 * HOUR + 500, 1);
  assert.equal(afterOk.successCount, 1);
  assert.equal(afterOk.consecutiveFailures, 0);
  const stats = r.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.runs, 3);
  assert.equal(stats.successes, 1);
  assert.equal(stats.failures, 1);
  assert.equal(stats.skipped, 1);
  // One-shot never fires again once it ran.
  const r2 = createFleetV25ScheduleRegistry();
  r2.create({ id: 's-once', automationId: 'a', owner: 'o', name: 'Once', kind: 'once', runAtMs: WED + HOUR }, WED);
  r2.recordRunStart('s-once', WED + HOUR, false);
  r2.recordRunOutcome('s-once', 'completed', WED + HOUR + 10, 1);
  assert.equal(r2.get('s-once').nextRunAtMs, null);
  assert.equal(r2.dueSchedules(WED + 2 * HOUR).length, 0);
});

test('runs v25: ledger — start/finish/query/groups/stuck', () => {
  const ledger = createFleetV25ScheduledRunLedger();
  const run = ledger.start({ id: 'run-1', scheduleId: 's-a', automationId: 'auto-a', owner: 'team-data' }, WED);
  assert.equal(run.outcome, 'running');
  assert.equal(run.groupId, 'run-1');
  assert.equal(run.attempt, 1);
  assert.throws(() => ledger.start({ id: 'run-1', scheduleId: 's-a', automationId: 'auto-a', owner: 'x' }, WED), /already exists/);
  const finished = ledger.finish('run-1', 'failed', WED + 5000, 'boom');
  assert.equal(finished.outcome, 'failed');
  assert.equal(finished.durationMs, 5000);
  assert.equal(finished.error, 'boom');
  assert.equal(ledger.finish('run-1', 'completed', WED + 6000), null); // already finished
  assert.equal(ledger.finish('missing', 'completed', WED), null);
  // 'running' is not a finish state — checked on a run still in flight.
  ledger.start({ id: 'run-0', scheduleId: 's-a', automationId: 'auto-a', owner: 'team-data' }, WED);
  assert.throws(() => ledger.finish('run-0', 'running', WED), /not a finish state/);
  ledger.finish('run-0', 'cancelled', WED + 100);

  // Retry chain: attempt 2 in the same group, then success.
  ledger.start({ id: 'run-2', groupId: 'run-1', attempt: 2, scheduleId: 's-a', automationId: 'auto-a', owner: 'team-data', trigger: 'retry' }, WED + MIN);
  ledger.finish('run-2', 'completed', WED + MIN + 2000);
  const group = ledger.groupSummary('run-1');
  assert.equal(group.attempts, 2);
  assert.equal(group.outcome, 'completed');
  assert.equal(group.totalDurationMs, 7000);
  assert.equal(group.lastError, 'boom');
  assert.equal(ledger.attemptsFor('run-1').length, 2);
  assert.equal(ledger.attemptsFor('run-1')[1].attempt, 2);

  // More runs for query/stats.
  ledger.start({ id: 'run-3', scheduleId: 's-b', automationId: 'auto-b', owner: 'team-ops' }, WED + 2 * HOUR);
  ledger.finish('run-3', 'completed', WED + 2 * HOUR + 1000);
  ledger.start({ id: 'run-4', scheduleId: 's-a', automationId: 'auto-a', owner: 'team-data' }, WED + 3 * HOUR);
  assert.equal(ledger.running().length, 1);
  assert.equal(ledger.stuckRuns(WED + 3 * HOUR + 31 * MIN, 30 * MIN).length, 1);
  assert.equal(ledger.stuckRuns(WED + 3 * HOUR + 10 * MIN, 30 * MIN).length, 0);
  assert.deepEqual(ledger.countsByOutcome(), { running: 1, completed: 2, failed: 1, 'skipped-condition': 0, cancelled: 1 });
  assert.equal(ledger.failureRate(), 1 / 4);
  assert.deepEqual(ledger.timing(), { finished: 4, avgDurationMs: 2025, maxDurationMs: 5000, minDurationMs: 100 });
  assert.equal(ledger.query({ scheduleId: 's-a' }).length, 4);
  assert.equal(ledger.query({ owner: 'team-ops' }).length, 1);
  assert.equal(ledger.query({ outcome: 'completed', newestFirst: true })[0].id, 'run-3');
  assert.equal(ledger.forSchedule('s-a', 2).length, 2);
  assert.equal(ledger.runsToday('s-a', WED + 12 * HOUR), 4);
  const stats = ledger.statsBySchedule('s-a');
  assert.equal(stats.total, 4);
  assert.equal(stats.lastOutcome, 'running');
  assert.equal(ledger.groupSummaries().length, 4);
});

test('engine v25: dry-run preview (no writes)', () => {
  const registry = registryWithTwo();
  const ledger = createFleetV25ScheduledRunLedger();
  const engine = new FleetV25AutomationEngine(registry, ledger);
  assert.equal(engine.concurrency, 5);
  // Nothing due at 00:30.
  assert.deepEqual(engine.tickDryRun(WED + 30 * MIN), {
    atMs: WED + 30 * MIN, due: 0, wouldFire: 0, wouldSkip: 0, wouldDefer: 0, decisions: [],
  });
  // Interval due at 01:00 but outside its 9-17 window → would skip.
  const dry = engine.tickDryRun(WED + HOUR);
  assert.equal(dry.due, 1);
  assert.equal(dry.wouldSkip, 1);
  assert.equal(dry.wouldFire, 0);
  assert.equal(dry.decisions[0].would, 'skip');
  assert.equal(dry.decisions[0].trigger, 'schedule');
  assert.equal(ledger.size, 0); // dry run writes nothing
  assert.equal(registry.get('s-int').runCount, 0);
  // Inside the window at 10:00 → would fire.
  const dry2 = engine.tickDryRun(WED + 10 * HOUR);
  assert.equal(dry2.due, 2);
  assert.equal(dry2.wouldFire, 2);
});

test('engine v25: tick — fire, skip, retry chain, dispatcher throw', async () => {
  const registry = createFleetV25ScheduleRegistry();
  registry.create({
    id: 's-e', automationId: 'auto-a', owner: 'team-data', name: 'E',
    kind: 'interval', intervalMs: HOUR, retry: { maxRetries: 1, backoffMs: MIN },
  }, WED);
  const ledger = createFleetV25ScheduledRunLedger();
  const engine = new FleetV25AutomationEngine(registry, ledger, { maxConcurrent: 5 });
  let calls = 0;
  const failOnce = async () => {
    calls += 1;
    if (calls === 1) return { outcome: 'failed', error: 'first boom' };
    return { outcome: 'completed' };
  };
  // Tick 1 at 01:00: fires, fails, retry armed at 01:01.
  const t1 = await engine.tick(WED + HOUR, failOnce);
  assert.equal(t1.due, 1);
  assert.equal(t1.fired, 1);
  assert.equal(t1.failed, 1);
  assert.equal(t1.completed, 0);
  assert.equal(t1.decisions[0].decision, 'failed');
  assert.equal(t1.decisions[0].outcome, 'failed');
  assert.equal(t1.decisions[0].attempt, 1);
  assert.equal(ledger.size, 1);
  // Retry armed one backoff (60s) after the tick time.
  assert.equal(registry.get('s-e').retryAtMs, WED + HOUR + MIN);
  // Tick 2 at the retry time: attempt 2, same group, succeeds.
  const retryAt = registry.get('s-e').retryAtMs;
  assert.ok(retryAt !== null && retryAt > WED + HOUR);
  const t2 = await engine.tick(retryAt, failOnce);
  assert.equal(t2.fired, 1);
  assert.equal(t2.completed, 1);
  assert.equal(t2.decisions[0].trigger, 'retry');
  assert.equal(t2.decisions[0].attempt, 2);
  const groupId = t2.decisions[0].runId;
  assert.ok(groupId);
  const attempts = ledger.attemptsFor(ledger.get(t2.decisions[0].runId).groupId);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].attempt, 1);
  assert.equal(attempts[1].attempt, 2);
  assert.equal(ledger.groupSummary(attempts[0].groupId).outcome, 'completed');
  assert.equal(registry.get('s-e').consecutiveFailures, 0);

  // Dispatcher throw → failed run, tick continues (fresh engine: only s-t due).
  const throwing = async () => { throw new Error('dispatcher exploded'); };
  const registry3 = createFleetV25ScheduleRegistry();
  registry3.create({ id: 's-t', automationId: 'auto-b', owner: 'o', name: 'T', kind: 'once', runAtMs: WED + 5 * HOUR }, WED);
  const ledger3 = createFleetV25ScheduledRunLedger();
  const engine3 = new FleetV25AutomationEngine(registry3, ledger3);
  const t3 = await engine3.tick(WED + 5 * HOUR, throwing);
  assert.equal(t3.failed, 1);
  assert.match(t3.decisions.find((d) => d.scheduleId === 's-t')?.error ?? '', /dispatcher exploded/);
});

test('engine v25: tick — condition skip + concurrency defer', async () => {
  const registry = createFleetV25ScheduleRegistry();
  registry.create({
    id: 's-w', automationId: 'auto-a', owner: 'o', name: 'W',
    kind: 'interval', intervalMs: HOUR,
    conditions: [{ type: 'time-window', startHour: 9, endHour: 17 }],
  }, WED);
  registry.create({ id: 's-x', automationId: 'auto-b', owner: 'o', name: 'X', kind: 'interval', intervalMs: HOUR }, WED);
  const ledger = createFleetV25ScheduledRunLedger();
  // maxConcurrent 1: one fires, the other defers.
  const engine = new FleetV25AutomationEngine(registry, ledger, { maxConcurrent: 1 });
  const ok = async () => ({ outcome: 'completed' });
  // At 10:00 both are due and both pass conditions.
  const report = await engine.tick(WED + 10 * HOUR, ok);
  assert.equal(report.due, 2);
  assert.equal(report.fired, 1);
  assert.equal(report.deferred, 1);
  assert.equal(report.decisions.find((d) => d.decision === 'deferred')?.runId, null);
  // At 01:00 the window schedule would skip (recorded as skipped run).
  const registry2 = createFleetV25ScheduleRegistry();
  registry2.create({
    id: 's-w2', automationId: 'auto-a', owner: 'o', name: 'W2',
    kind: 'interval', intervalMs: HOUR,
    conditions: [{ type: 'time-window', startHour: 9, endHour: 17 }],
  }, WED);
  const ledger2 = createFleetV25ScheduledRunLedger();
  const engine2 = new FleetV25AutomationEngine(registry2, ledger2);
  const skipped = await engine2.tick(WED + HOUR, ok);
  assert.equal(skipped.skipped, 1);
  assert.equal(skipped.decisions[0].decision, 'skipped');
  assert.equal(skipped.decisions[0].outcome, 'skipped-condition');
  assert.equal(ledger2.size, 1);
  assert.equal(ledger2.get(skipped.decisions[0].runId).outcome, 'skipped-condition');
  assert.equal(registry2.get('s-w2').skippedCount, 1);
  // A skipped run does not consume the dispatcher.
  assert.equal(skipped.fired, 0);
});
