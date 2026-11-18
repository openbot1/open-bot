/**
 * Composio v129 tests — long jobs + job polling (v1.29, Doi T4 —
 * node:test, no network, no key, mock-only).
 *
 * Covers packages/core/src/composio/longJobsV129.ts +
 * jobPollingV129.ts:
 * - Job create: validation (empty toolkit/slug, totalSteps range,
 *   args too large, timeout over max), deterministic id, defaults
 * - Advance: pending -> running -> done, step results kept (capped),
 *   result summary; step throw -> failed; cancelRequested stops at
 *   next tick; timeout -> timed-out; terminal jobs never advance
 * - Cancel: request on active job, refused on terminal job
 * - Timeout check: pure, before/after deadline
 * - List/filter + summary counts
 * - Checkpoint serialize/parse round-trip + bad version rejected
 * - Memory store: submit/dedupe/save/list/prune/snapshot/restore
 * - Poll policy: delay table (progress resets, no-progress backs
 *   off, error backs off harder, done = 0), deterministic jitter
 *   (same job+attempt -> same jitter, bounded), schedule create/
 *   update/due/serialize round-trip
 * - Poll driver: one tick advances at most one step, outcome
 *   mapping, maxPolls -> failed, timeout -> timed-out, schedule
 *   mismatch throws, terminal job poll returns done/0-delay
 * - Batch poll: due jobs polled, not-due skipped, counts
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v129-long-jobs.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryComposioV129JobStore,
  advanceComposioV129Job,
  checkComposioV129JobTimeout,
  composioV129JobElapsedMs,
  composioV129JobId,
  composioV129JobProgress,
  composioV129JobTimeLeftMs,
  createComposioV129Job,
  isComposioV129TerminalJobStatus,
  listComposioV129Jobs,
  parseComposioV129Job,
  requestComposioV129JobCancel,
  serializeComposioV129Job,
  summarizeComposioV129Job,
  summarizeComposioV129Jobs,
  validateComposioV129JobConfig,
} from '../packages/core/dist/composio/longJobsV129.js';
import {
  DEFAULT_COMPOSIO_V129_POLL_POLICY,
  composioV129Hash32,
  composioV129MsUntilNextPoll,
  composioV129NextPollDelayMs,
  composioV129PollDelayMs,
  composioV129PollDelayTable,
  composioV129PollJitterMs,
  createComposioV129PollSchedule,
  isComposioV129PollDue,
  parseComposioV129PollSchedule,
  pollComposioV129JobOnce,
  pollComposioV129JobsBatch,
  resolveComposioV129PollPolicy,
  serializeComposioV129PollSchedule,
  updateComposioV129PollSchedule,
  validateComposioV129PollPolicy,
  validateComposioV129PollSchedule,
} from '../packages/core/dist/composio/jobPollingV129.js';

const NOW = 1780000000000;

function mockStep(job, stepIndex) {
  return { step: stepIndex + 1, toolkit: job.toolkit, slug: job.slug };
}

function makeJob(over = {}, nowMs = NOW) {
  return createComposioV129Job(
    { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', totalSteps: 3, ...over },
    nowMs,
  );
}

test('long job: create defaults + deterministic id + needsApproval', () => {
  const job = makeJob();
  assert.equal(job.status, 'pending');
  assert.equal(job.stepsDone, 0);
  assert.equal(job.totalSteps, 3);
  assert.equal(job.pollCount, 0);
  assert.equal(job.cancelRequested, false);
  assert.equal(job.needsApproval, false); // LIST is a read tool
  assert.equal(job.timeoutAtMs, NOW + 10 * 60 * 1000);
  assert.equal(job.id, composioV129JobId(`smartsheet:SMARTSHEET_LIST_ROWS:${NOW}:3`));
  assert.equal(composioV129JobId('x'), composioV129JobId('x'));
  assert.notEqual(composioV129JobId('x'), composioV129JobId('y'));
  const writeJob = makeJob({ slug: 'SMARTSHEET_CREATE_ROW' });
  assert.equal(writeJob.needsApproval, true);
});

test('long job: create validation throws', () => {
  assert.throws(() => createComposioV129Job({ toolkit: '', slug: 'X' }, NOW), /toolkit/);
  assert.throws(() => createComposioV129Job({ toolkit: 't', slug: '' }, NOW), /slug/);
  assert.throws(() => makeJob({ totalSteps: 0 }), /totalSteps/);
  assert.throws(() => makeJob({ totalSteps: 1001 }), /totalSteps/);
  assert.throws(() => makeJob({ timeoutMs: 61 * 60 * 1000 }), /timeoutMs/);
  assert.throws(() => makeJob({ args: { big: 'x'.repeat(30000) } }), /args too large/);
  assert.throws(() => makeJob({ conversationId: '' }), /conversationId/);
  assert.deepEqual(validateComposioV129JobConfig({}), []);
  assert.ok(validateComposioV129JobConfig({ defaultTimeoutMs: -1 }).length > 0);
  assert.ok(validateComposioV129JobConfig({ maxTotalSteps: 0 }).length > 0);
  assert.ok(validateComposioV129JobConfig({ defaultTimeoutMs: 999999999, maxTimeoutMs: 1 }).length > 0);
});

test('long job: advance pending -> running -> done, progress + elapsed', () => {
  let job = makeJob();
  assert.equal(composioV129JobProgress(job), 0);
  let r = advanceComposioV129Job(job, NOW + 1000, mockStep);
  assert.equal(r.advanced, true);
  assert.equal(r.finished, false);
  job = r.job;
  assert.equal(job.status, 'running');
  assert.equal(job.stepsDone, 1);
  assert.equal(job.startedAtMs, NOW + 1000);
  assert.equal(job.stepResults.length, 1);
  assert.equal(composioV129JobProgress(job), 1 / 3);
  r = advanceComposioV129Job(job, NOW + 2000, mockStep);
  job = r.job;
  r = advanceComposioV129Job(job, NOW + 3000, mockStep);
  job = r.job;
  assert.equal(r.finished, true);
  assert.equal(job.status, 'done');
  assert.equal(job.stepsDone, 3);
  assert.equal(job.finishedAtMs, NOW + 3000);
  assert.equal(composioV129JobProgress(job), 1);
  assert.equal(composioV129JobElapsedMs(job, NOW + 9999), 3000);
  assert.ok(job.result !== null);
  assert.equal(job.result.stepsDone, 3);
  // Terminal jobs never advance again.
  const again = advanceComposioV129Job(job, NOW + 4000, mockStep);
  assert.equal(again.advanced, false);
  assert.equal(again.job, job);
  const summary = summarizeComposioV129Job(job, NOW + 4000);
  assert.equal(summary.status, 'done');
  assert.equal(summary.progress, 1);
});

test('long job: step throw -> failed; step results capped', () => {
  const job = makeJob({ totalSteps: 2 });
  const failing = () => {
    throw new Error('boom-step');
  };
  const r = advanceComposioV129Job(job, NOW, failing);
  assert.equal(r.job.status, 'failed');
  assert.equal(r.job.error, 'boom-step');
  assert.equal(r.finished, true);
  // Cap: maxKeptStepResults = 2 keeps only the last 2.
  let j2 = createComposioV129Job(
    { toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', totalSteps: 5 },
    NOW,
  );
  for (let i = 0; i < 5; i += 1) {
    j2 = advanceComposioV129Job(j2, NOW + i, mockStep, { maxKeptStepResults: 2 }).job;
  }
  assert.equal(j2.stepResults.length, 2);
  assert.equal(j2.stepResults[1].step, 5);
});

test('long job: cancel is cooperative, refused on terminal', () => {
  let job = makeJob({ totalSteps: 5 });
  job = advanceComposioV129Job(job, NOW, mockStep).job;
  const { job: cancelled, cancelled: ok } = requestComposioV129JobCancel(job, NOW + 100, 'user stop');
  assert.equal(ok, true);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.status, 'running'); // still running until next tick
  const r = advanceComposioV129Job(cancelled, NOW + 200, mockStep);
  assert.equal(r.job.status, 'cancelled');
  assert.equal(r.finished, true);
  assert.equal(r.job.stepsDone, 1); // no extra step ran
  const done = advanceComposioV129Job(makeJob({ totalSteps: 1 }), NOW, mockStep).job;
  assert.equal(requestComposioV129JobCancel(done, NOW).cancelled, false);
  assert.equal(requestComposioV129JobCancel(done, NOW).job, done);
});

test('long job: timeout is absolute and pure', () => {
  const job = makeJob({ totalSteps: 10, timeoutMs: 5000 });
  assert.equal(checkComposioV129JobTimeout(job, NOW + 4999).status, 'pending');
  const timedOut = checkComposioV129JobTimeout(job, NOW + 5001);
  assert.equal(timedOut.status, 'timed-out');
  assert.match(timedOut.error, /timed out/);
  assert.equal(composioV129JobTimeLeftMs(job, NOW + 1000), 4000);
  assert.equal(composioV129JobTimeLeftMs(job, NOW + 6000), -1000);
  // Advance after the deadline times out instead of stepping.
  const r = advanceComposioV129Job(job, NOW + 6000, mockStep);
  assert.equal(r.job.status, 'timed-out');
  assert.equal(r.advanced, false);
  // Terminal check is exhaustive.
  for (const s of ['done', 'failed', 'cancelled', 'timed-out']) assert.equal(isComposioV129TerminalJobStatus(s), true);
  for (const s of ['pending', 'running']) assert.equal(isComposioV129TerminalJobStatus(s), false);
});

test('long job: list/filter + summary', () => {
  const jobs = [
    makeJob({ id: 'a', slug: 'SMARTSHEET_LIST_ROWS', totalSteps: 1 }),
    makeJob({ id: 'b', slug: 'SMARTSHEET_CREATE_ROW', conversationId: 'c1' }),
    makeJob({ id: 'c', toolkit: 'klaviyo', slug: 'KLAVIYO_LIST_LISTS', conversationId: 'c1' }),
  ];
  const done = advanceComposioV129Job(jobs[0], NOW, mockStep).job;
  const all = [done, jobs[1], jobs[2]];
  assert.equal(listComposioV129Jobs(all, { status: 'done' }).length, 1);
  assert.equal(listComposioV129Jobs(all, { conversationId: 'c1' }).length, 2);
  assert.equal(listComposioV129Jobs(all, { toolkit: 'klaviyo' }).length, 1);
  assert.equal(listComposioV129Jobs(all, { activeOnly: true }).length, 2);
  const summary = summarizeComposioV129Jobs(all, NOW + 1000);
  assert.equal(summary.total, 3);
  assert.equal(summary.byStatus.done, 1);
  assert.equal(summary.active, 2);
  assert.equal(summary.oldestActiveAgeMs, 1000);
  assert.equal(summary.avgProgressActive, 0);
});

test('long job: checkpoint serialize/parse round-trip + bad version', () => {
  const job = advanceComposioV129Job(makeJob(), NOW, mockStep).job;
  const parsed = parseComposioV129Job(serializeComposioV129Job(job));
  assert.deepEqual(parsed, job);
  assert.throws(() => parseComposioV129Job('not json'), /not JSON/);
  assert.throws(
    () => parseComposioV129Job(JSON.stringify({ version: 99, job })),
    /Unsupported.*version/,
  );
  assert.throws(
    () => parseComposioV129Job(JSON.stringify({ version: 1, job: { ...job, stepsDone: 99 } })),
    /stepsDone must not exceed totalSteps/,
  );
});

test('long job: memory store submit/dedupe/save/prune/snapshot', () => {
  const store = new MemoryComposioV129JobStore();
  const job = store.submit({ toolkit: 'smartsheet', slug: 'SMARTSHEET_LIST_ROWS', totalSteps: 1, id: 'j1' }, NOW);
  assert.equal(store.size(), 1);
  assert.equal(store.get('j1').id, 'j1');
  assert.throws(() => store.submit({ toolkit: 't', slug: 'S', id: 'j1' }, NOW), /already exists/);
  const done = advanceComposioV129Job(job, NOW, mockStep).job;
  store.save(done);
  assert.equal(store.get('j1').status, 'done');
  assert.equal(store.removeTerminal('j1'), true);
  assert.equal(store.size(), 0);
  assert.equal(store.removeTerminal('nope'), false);
  store.submit({ toolkit: 't', slug: 'S', id: 'j2' }, NOW);
  const snap = store.snapshot();
  const store2 = new MemoryComposioV129JobStore();
  store2.restore(snap);
  assert.equal(store2.size(), 1);
  assert.equal(store2.get('j2').toolkit, 't');
  assert.throws(() => store2.restore('{"version":99,"jobs":[]}'), /Unsupported/);
  assert.throws(() => store2.save(makeJob({ id: 'ghost' })), /Unknown.*job/);
  assert.equal(store.pruneTerminal(), 0);
});

test('poll policy: delay table + validation', () => {
  assert.deepEqual(validateComposioV129PollPolicy({}), []);
  assert.ok(validateComposioV129PollPolicy({ baseMs: 0 }).length > 0);
  assert.ok(validateComposioV129PollPolicy({ factor: 0.5 }).length > 0);
  assert.ok(validateComposioV129PollPolicy({ maxPolls: 0 }).length > 0);
  const resolved = resolveComposioV129PollPolicy({});
  assert.equal(resolved.baseMs, DEFAULT_COMPOSIO_V129_POLL_POLICY.baseMs);
  assert.equal(resolved.maxPolls, DEFAULT_COMPOSIO_V129_POLL_POLICY.maxPolls);
  // Progress resets to base; no-progress backs off; error backs off harder.
  assert.equal(composioV129PollDelayMs('progress', 5), 2000);
  assert.equal(composioV129PollDelayMs('no-progress', 0), 2000);
  assert.equal(composioV129PollDelayMs('no-progress', 1), 4000);
  assert.equal(composioV129PollDelayMs('no-progress', 2), 8000);
  assert.equal(composioV129PollDelayMs('error', 0), 4000);
  assert.equal(composioV129PollDelayMs('error', 1), 8000);
  assert.equal(composioV129PollDelayMs('done', 9), 0);
  // Cap at maxMs.
  assert.equal(composioV129PollDelayMs('no-progress', 99), 60000);
  const table = composioV129PollDelayTable({}, 3);
  assert.deepEqual(table[0], { attempt: 0, noProgressMs: 2000, errorMs: 4000 });
  assert.deepEqual(table[2], { attempt: 2, noProgressMs: 8000, errorMs: 16000 });
});

test('poll policy: deterministic jitter is bounded and repeatable', () => {
  const a = composioV129PollJitterMs('job-1', 3, 500);
  assert.equal(a, composioV129PollJitterMs('job-1', 3, 500));
  assert.ok(a >= 0 && a <= 500);
  assert.equal(composioV129PollJitterMs('job-1', 3, 0), 0);
  // Different jobs/attempts usually differ (hash spreads); delay includes jitter.
  const d1 = composioV129NextPollDelayMs('job-1', 'no-progress', 0, {});
  assert.ok(d1 >= 2000 && d1 <= 2500);
  assert.equal(composioV129NextPollDelayMs('job-1', 'done', 0, {}), 0);
  assert.ok(composioV129Hash32('a') !== composioV129Hash32('b'));
});

test('poll schedule: create/update/due/serialize', () => {
  const schedule = createComposioV129PollSchedule('job-1', NOW);
  assert.equal(schedule.nextPollAtMs, NOW + 2000);
  assert.equal(schedule.pollCount, 0);
  assert.equal(schedule.consecutiveMisses, 0);
  assert.equal(isComposioV129PollDue(schedule, NOW), false);
  assert.equal(isComposioV129PollDue(schedule, NOW + 2000), true);
  assert.equal(composioV129MsUntilNextPoll(schedule, NOW + 500), 1500);
  const afterProgress = updateComposioV129PollSchedule(schedule, 'progress', NOW + 2000);
  assert.equal(afterProgress.pollCount, 1);
  assert.equal(afterProgress.consecutiveMisses, 0);
  assert.ok(afterProgress.nextPollAtMs >= NOW + 2000 + 2000);
  const afterMiss = updateComposioV129PollSchedule(afterProgress, 'no-progress', NOW + 4000);
  assert.equal(afterMiss.consecutiveMisses, 1);
  assert.ok(afterMiss.nextPollAtMs >= NOW + 4000 + 4000);
  const afterDone = updateComposioV129PollSchedule(afterMiss, 'done', NOW + 8000);
  assert.equal(afterDone.nextPollAtMs, NOW + 8000);
  const parsed = parseComposioV129PollSchedule(serializeComposioV129PollSchedule(afterMiss));
  assert.deepEqual(parsed, afterMiss);
  assert.deepEqual(validateComposioV129PollSchedule(afterMiss), []);
  assert.ok(validateComposioV129PollSchedule({ jobId: '', nextPollAtMs: 1, pollCount: 0, consecutiveMisses: 0 }).length > 0);
  assert.throws(() => parseComposioV129PollSchedule('{"version":2,"schedule":{}}'), /Unsupported/);
});

test('poll driver: one tick = one step, outcome mapping, terminal poll', () => {
  const job = makeJob({ totalSteps: 2 });
  const schedule = createComposioV129PollSchedule(job.id, NOW);
  const r1 = pollComposioV129JobOnce(job, schedule, NOW + 2000, mockStep);
  assert.equal(r1.outcome, 'progress');
  assert.equal(r1.job.stepsDone, 1);
  assert.equal(r1.job.pollCount, 1);
  assert.equal(r1.finished, false);
  assert.ok(r1.nextDelayMs >= 2000);
  assert.equal(r1.schedule.pollCount, 1);
  assert.equal(r1.schedule.consecutiveMisses, 0);
  const r2 = pollComposioV129JobOnce(r1.job, r1.schedule, r1.schedule.nextPollAtMs, mockStep);
  assert.equal(r2.outcome, 'done');
  assert.equal(r2.job.status, 'done');
  assert.equal(r2.nextDelayMs, 0);
  assert.equal(r2.finished, true);
  // Polling a terminal job returns done with no step.
  const r3 = pollComposioV129JobOnce(r2.job, r2.schedule, NOW + 99999, mockStep);
  assert.equal(r3.outcome, 'done');
  assert.equal(r3.job.stepsDone, 2);
  assert.equal(r3.nextDelayMs, 0);
  // Schedule/job mismatch throws.
  assert.throws(
    () => pollComposioV129JobOnce(job, createComposioV129PollSchedule('other-job', NOW), NOW, mockStep),
    /mismatch/,
  );
});

test('poll driver: maxPolls fails the job; timeout ends it; step error', () => {
  const job = makeJob({ totalSteps: 100 });
  let schedule = createComposioV129PollSchedule(job.id, NOW);
  const r = pollComposioV129JobOnce(job, schedule, NOW, mockStep, { maxPolls: 0 + 1, baseMs: 1, maxMs: 1, maxJitterMs: 0 });
  assert.equal(r.job.status, 'running');
  schedule = r.schedule;
  const r2 = pollComposioV129JobOnce(r.job, schedule, NOW + 1, mockStep, { maxPolls: 1, baseMs: 1, maxMs: 1, maxJitterMs: 0 });
  assert.equal(r2.job.status, 'failed');
  assert.match(r2.job.error, /Poll limit exceeded/);
  assert.equal(r2.finished, true);
  // Timeout.
  const slow = makeJob({ totalSteps: 100, timeoutMs: 1000 });
  const slowSchedule = createComposioV129PollSchedule(slow.id, NOW);
  const r3 = pollComposioV129JobOnce(slow, slowSchedule, NOW + 5000, mockStep);
  assert.equal(r3.job.status, 'timed-out');
  assert.equal(r3.outcome, 'error');
  // Step error -> failed with error outcome.
  const errJob = makeJob({ totalSteps: 2 });
  const errSchedule = createComposioV129PollSchedule(errJob.id, NOW);
  const r4 = pollComposioV129JobOnce(errJob, errSchedule, NOW, () => {
    throw new Error('step boom');
  });
  assert.equal(r4.job.status, 'failed');
  assert.equal(r4.outcome, 'error');
  assert.equal(r4.finished, true);
});

test('poll driver: batch polls due jobs, skips not-due', () => {
  const a = makeJob({ id: 'batch-a', totalSteps: 1 });
  const b = makeJob({ id: 'batch-b', totalSteps: 1 });
  const schedules = {
    'batch-a': createComposioV129PollSchedule('batch-a', NOW),
    'batch-b': { ...createComposioV129PollSchedule('batch-b', NOW), nextPollAtMs: NOW + 60000 },
  };
  const batch = pollComposioV129JobsBatch([a, b], schedules, NOW + 2000, mockStep);
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].job.id, 'batch-a');
  assert.equal(batch.finished, 1);
  assert.equal(batch.stillRunning, 0);
  assert.deepEqual(batch.skipped, ['batch-b']);
  // Job without a schedule is skipped, not crashed.
  const c = makeJob({ id: 'batch-c', totalSteps: 1 });
  const batch2 = pollComposioV129JobsBatch([c], {}, NOW, mockStep);
  assert.deepEqual(batch2.skipped, ['batch-c']);
});
