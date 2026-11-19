/**
 * Tests for fleet v27 campaigns (v1.40, Team T6).
 *
 * Covers:
 * - Validation: missing id/name, no bots, duplicate bot, empty task,
 *   bad concurrency/timeout/retries.
 * - Create/list/get/remove + duplicate-id refusal.
 * - Start: first `concurrency` entries run, the rest queue.
 * - Advance: outcomes apply, failures retry up to maxRetries, freed
 *   slots fill from the queue, run closes as succeeded/partial/failed.
 * - Cancel: queued/running entries become cancelled, run closes.
 * - Retry-failed: a new run with only the failed / timed-out bots.
 * - History: listFinishedRuns replays finished runs only.
 * - JSON round-trip preserves campaigns + runs + sequence.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v27-campaigns.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FleetV27CampaignStore,
  aggregateFleetV27Run,
  deriveFleetV27RunStatus,
  summarizeFleetV27Run,
  validateFleetV27Campaign,
} from '../packages/core/dist/fleetV27/campaigns.js';

const TASK = { kind: 'prompt', text: 'Review the open PRs and summarise each.' };
const T0 = 1_800_000_000_000;

function makeStore() {
  return new FleetV27CampaignStore();
}

function createOk(store, overrides = {}) {
  const res = store.createCampaign({
    id: 'cmp-1',
    name: 'Review sprint PRs',
    bots: [{ botId: 'bot-a' }, { botId: 'bot-b' }, { botId: 'bot-c' }],
    task: TASK,
    concurrency: 1,
    tags: ['review'],
    createdAtMs: T0,
    ...overrides,
  });
  assert.equal(res.ok, true, `create must succeed: ${res.reasons.join(',')}`);
  return res.campaign;
}

test('campaigns v27: validation catches bad definitions', () => {
  assert.deepEqual(validateFleetV27Campaign({}), ['missing-id', 'missing-name', 'no-bots', 'empty-task']);
  assert.ok(validateFleetV27Campaign({ id: 'x', name: 'X', bots: [{ botId: 'a' }, { botId: 'a' }], task: TASK }).includes('duplicate-bot'));
  assert.ok(validateFleetV27Campaign({ id: 'x', name: 'X', bots: [{ botId: 'a' }], task: TASK, concurrency: 0 }).includes('bad-concurrency'));
  assert.ok(validateFleetV27Campaign({ id: 'x', name: 'X', bots: [{ botId: 'a' }], task: TASK, concurrency: 17 }).includes('bad-concurrency'));
  assert.ok(validateFleetV27Campaign({ id: 'x', name: 'X', bots: [{ botId: 'a' }], task: { kind: 'prompt', text: '  ' } }).includes('empty-task'));
  assert.ok(validateFleetV27Campaign({ id: 'x', name: 'X', bots: [{ botId: 'a' }], task: { kind: 'prompt', text: 't', timeoutMs: -1 } }).includes('bad-timeout'));
  assert.ok(validateFleetV27Campaign({ id: 'x', name: 'X', bots: [{ botId: 'a' }], task: { kind: 'prompt', text: 't', maxRetries: -1 } }).includes('bad-retries'));
  assert.deepEqual(validateFleetV27Campaign({ id: 'x', name: 'X', bots: [{ botId: 'a' }], task: TASK, concurrency: 2 }), []);
});

test('campaigns v27: create/list/get/remove + duplicate id refused', () => {
  const store = makeStore();
  const c = createOk(store);
  assert.equal(c.concurrency, 1);
  assert.equal(c.tags[0], 'review');
  assert.equal(store.listCampaigns().length, 1);
  assert.equal(store.listCampaigns('review').length, 1);
  assert.equal(store.listCampaigns('nightly').length, 0);
  assert.equal(store.getCampaign('cmp-1')?.name, 'Review sprint PRs');
  assert.equal(store.getCampaign('nope'), undefined);
  const dup = store.createCampaign({ id: 'cmp-1', name: 'Again', bots: [{ botId: 'bot-a' }], task: TASK });
  assert.equal(dup.ok, false);
  assert.ok(dup.reasons.includes('campaign-exists'));
  assert.equal(store.removeCampaign('cmp-1'), true);
  assert.equal(store.removeCampaign('cmp-1'), false);
  assert.equal(store.listCampaigns().length, 0);
});

test('campaigns v27: start fills concurrency slots, rest queue', () => {
  const store = makeStore();
  createOk(store);
  const { ok, run } = store.startRun('cmp-1', { nowMs: T0 });
  assert.equal(ok, true);
  assert.equal(run.status, 'running');
  assert.equal(run.entries[0].state, 'running');
  assert.equal(run.entries[0].attempts, 1);
  assert.equal(run.entries[1].state, 'queued');
  assert.equal(run.entries[2].state, 'queued');
  const prog = store.progress(run.id);
  assert.equal(prog.ok, true);
  assert.equal(prog.aggregate.total, 3);
  assert.equal(prog.aggregate.running, 1);
  assert.equal(prog.aggregate.queued, 2);
  assert.equal(prog.aggregate.progress, 0);
  assert.equal(store.startRun('nope').ok, false);
});

test('campaigns v27: advance applies outcomes, fills slots, closes partial', () => {
  const store = makeStore();
  createOk(store, { task: { kind: 'prompt', text: 'Do it', maxRetries: 0 } });
  const { run } = store.startRun('cmp-1', { nowMs: T0 });
  // bot-a succeeds -> bot-b starts (concurrency 1).
  const step1 = store.advanceRun(run.id, [{ botId: 'bot-a', outcome: 'succeeded', text: 'done' }], { nowMs: T0 + 1000 });
  assert.equal(step1.ok, true);
  assert.deepEqual(step1.result.started, ['bot-b']);
  assert.deepEqual(step1.result.finished, ['bot-a']);
  assert.equal(step1.result.status, 'running');
  // bot-b fails with no retries -> bot-c starts.
  const step2 = store.advanceRun(run.id, [{ botId: 'bot-b', outcome: 'failed', error: 'boom' }], { nowMs: T0 + 2000 });
  assert.deepEqual(step2.result.started, ['bot-c']);
  assert.deepEqual(step2.result.finished, ['bot-b']);
  // bot-c succeeds -> run closes partial (2 succeeded, 1 failed).
  const step3 = store.advanceRun(run.id, [{ botId: 'bot-c', outcome: 'succeeded', text: 'ok' }], { nowMs: T0 + 3000 });
  assert.equal(step3.result.status, 'partial');
  assert.equal(step3.result.aggregate.succeeded, 2);
  assert.equal(step3.result.aggregate.failed, 1);
  assert.equal(step3.result.aggregate.progress, 1);
  assert.equal(store.getRun(run.id).finishedAtMs, T0 + 3000);
  // Advancing a finished run is refused.
  assert.equal(store.advanceRun(run.id, []).ok, false);
  assert.ok(store.advanceRun(run.id, []).reasons.includes('run-already-finished'));
  assert.equal(store.summarizeRun(run.id).includes('partial'), true);
});

test('campaigns v27: failure retries up to maxRetries, then fails', () => {
  const store = makeStore();
  createOk(store, { task: { kind: 'prompt', text: 'Do it', maxRetries: 1 }, concurrency: 3 });
  const { run } = store.startRun('cmp-1', { nowMs: T0 });
  // First failure retries (attempts 1 -> 2, still running).
  const step1 = store.advanceRun(run.id, [{ botId: 'bot-a', outcome: 'failed', error: 'flaky' }], { nowMs: T0 + 1000 });
  assert.deepEqual(step1.result.retried, ['bot-a']);
  assert.equal(store.getRun(run.id).entries[0].state, 'running');
  assert.equal(store.getRun(run.id).entries[0].attempts, 2);
  // Second failure is terminal.
  const step2 = store.advanceRun(run.id, [{ botId: 'bot-a', outcome: 'failed', error: 'still broken' }], { nowMs: T0 + 2000 });
  assert.deepEqual(step2.result.retried, []);
  assert.deepEqual(step2.result.finished, ['bot-a']);
  assert.equal(store.getRun(run.id).entries[0].state, 'failed');
  // Outcomes for a bot that is not running are ignored, not fatal.
  const step3 = store.advanceRun(run.id, [{ botId: 'bot-a', outcome: 'succeeded' }], { nowMs: T0 + 3000 });
  assert.equal(step3.ok, true);
  assert.ok(step3.result.notes.some((n) => n.includes('not running')));
});

test('campaigns v27: all succeed -> succeeded; all fail -> failed; skip counts as finished', () => {
  const store = makeStore();
  createOk(store, { task: { kind: 'prompt', text: 'Do it', maxRetries: 0 }, concurrency: 3 });
  const { run } = store.startRun('cmp-1', { nowMs: T0 });
  const done = store.advanceRun(run.id, [
    { botId: 'bot-a', outcome: 'succeeded' },
    { botId: 'bot-b', outcome: 'skipped', text: 'bot unavailable' },
    { botId: 'bot-c', outcome: 'succeeded' },
  ], { nowMs: T0 + 1000 });
  assert.equal(done.result.status, 'partial');
  assert.equal(done.result.aggregate.skipped, 1);

  const store2 = makeStore();
  createOk(store2, { task: { kind: 'prompt', text: 'Do it', maxRetries: 0 }, concurrency: 3 });
  const { run: run2 } = store2.startRun('cmp-1', { nowMs: T0 });
  const allOk = store2.advanceRun(run2.id, [
    { botId: 'bot-a', outcome: 'succeeded' },
    { botId: 'bot-b', outcome: 'succeeded' },
    { botId: 'bot-c', outcome: 'succeeded' },
  ], { nowMs: T0 + 1000 });
  assert.equal(allOk.result.status, 'succeeded');

  const store3 = makeStore();
  createOk(store3, { task: { kind: 'prompt', text: 'Do it', maxRetries: 0 }, concurrency: 3 });
  const { run: run3 } = store3.startRun('cmp-1', { nowMs: T0 });
  const allBad = store3.advanceRun(run3.id, [
    { botId: 'bot-a', outcome: 'failed', error: 'x' },
    { botId: 'bot-b', outcome: 'timed-out', error: 'slow' },
    { botId: 'bot-c', outcome: 'failed', error: 'y' },
  ], { nowMs: T0 + 1000 });
  assert.equal(allBad.result.status, 'failed');
  assert.equal(allBad.result.aggregate.timedOut, 1);
});

test('campaigns v27: cancel closes the run, finished entries kept', () => {
  const store = makeStore();
  createOk(store);
  const { run } = store.startRun('cmp-1', { nowMs: T0 });
  store.advanceRun(run.id, [{ botId: 'bot-a', outcome: 'succeeded' }], { nowMs: T0 + 1000 });
  const cancelled = store.cancelRun(run.id, 'operator stopped it', { nowMs: T0 + 2000 });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.run.cancelReason, 'operator stopped it');
  const entries = cancelled.run.entries;
  assert.equal(entries.find((e) => e.botId === 'bot-a').state, 'succeeded');
  assert.equal(entries.find((e) => e.botId === 'bot-b').state, 'cancelled');
  assert.equal(entries.find((e) => e.botId === 'bot-c').state, 'cancelled');
  // Cancelling twice is refused.
  assert.equal(store.cancelRun(run.id, 'again').ok, false);
  assert.equal(store.progress('nope').ok, false);
});

test('campaigns v27: retry-failed starts a new run with only failed bots', () => {
  const store = makeStore();
  createOk(store, { task: { kind: 'prompt', text: 'Do it', maxRetries: 0 }, concurrency: 3 });
  const { run } = store.startRun('cmp-1', { nowMs: T0 });
  store.advanceRun(run.id, [
    { botId: 'bot-a', outcome: 'succeeded' },
    { botId: 'bot-b', outcome: 'failed', error: 'x' },
    { botId: 'bot-c', outcome: 'timed-out', error: 'slow' },
  ], { nowMs: T0 + 1000 });
  assert.equal(store.getRun(run.id).status, 'partial');
  const retry = store.retryFailed(run.id, { nowMs: T0 + 2000 });
  assert.equal(retry.ok, true);
  assert.notEqual(retry.run.id, run.id);
  assert.deepEqual(retry.run.entries.map((e) => e.botId), ['bot-b', 'bot-c']);
  assert.equal(retry.run.entries[0].state, 'running');
  // Original run is untouched in history.
  assert.equal(store.getRun(run.id).status, 'partial');
  // No failed bots -> nothing to retry.
  const store2 = makeStore();
  createOk(store2, { task: { kind: 'prompt', text: 'Do it', maxRetries: 0 }, concurrency: 3 });
  const { run: run2 } = store2.startRun('cmp-1', { nowMs: T0 });
  store2.advanceRun(run2.id, [
    { botId: 'bot-a', outcome: 'succeeded' },
    { botId: 'bot-b', outcome: 'succeeded' },
    { botId: 'bot-c', outcome: 'succeeded' },
  ], { nowMs: T0 + 1000 });
  assert.equal(store2.retryFailed(run2.id).ok, false);
});

test('campaigns v27: history lists finished runs only, newest first', () => {
  const store = makeStore();
  createOk(store, { task: { kind: 'prompt', text: 'Do it', maxRetries: 0 }, concurrency: 3 });
  const { run: r1 } = store.startRun('cmp-1', { nowMs: T0 });
  store.advanceRun(r1.id, [
    { botId: 'bot-a', outcome: 'succeeded' },
    { botId: 'bot-b', outcome: 'succeeded' },
    { botId: 'bot-c', outcome: 'succeeded' },
  ], { nowMs: T0 + 1000 });
  const { run: r2 } = store.startRun('cmp-1', { nowMs: T0 + 2000 });
  assert.equal(store.listFinishedRuns().length, 1);
  assert.equal(store.listFinishedRuns('succeeded').length, 1);
  assert.equal(store.listFinishedRuns('failed').length, 0);
  assert.equal(store.listRuns('cmp-1').length, 2);
  assert.equal(store.listRuns()[0].id, r2.id); // newest first
  store.cancelRun(r2.id, 'stop', { nowMs: T0 + 3000 });
  assert.equal(store.listFinishedRuns().length, 2);
  assert.equal(store.listFinishedRuns('cancelled').length, 1);
});

test('campaigns v27: aggregate + derive + JSON round-trip', () => {
  const entries = [
    { botId: 'a', state: 'succeeded', attempts: 1, startedAtMs: 1, finishedAtMs: 2, outcome: 'ok', error: null, durationMs: 1 },
    { botId: 'b', state: 'queued', attempts: 0, startedAtMs: null, finishedAtMs: null, outcome: null, error: null, durationMs: null },
    { botId: 'c', state: 'failed', attempts: 2, startedAtMs: 1, finishedAtMs: 2, outcome: null, error: 'x', durationMs: 1 },
  ];
  const agg = aggregateFleetV27Run(entries);
  assert.equal(agg.total, 3);
  assert.equal(agg.finished, 2);
  assert.equal(agg.progress, 2 / 3);
  assert.equal(deriveFleetV27RunStatus(entries, false), 'running');
  assert.equal(deriveFleetV27RunStatus(entries, true), 'cancelled');
  assert.ok(summarizeFleetV27Run(agg).includes('2/3 finished'));

  const store = makeStore();
  createOk(store);
  const { run } = store.startRun('cmp-1', { nowMs: T0 });
  const restored = FleetV27CampaignStore.fromJSON(store.toJSON());
  assert.equal(restored.listCampaigns().length, 1);
  assert.equal(restored.getRun(run.id)?.status, 'running');
  const r2 = restored.startRun('cmp-1', { nowMs: T0 + 1000 });
  assert.equal(r2.run.id, 'run-0002'); // sequence preserved
});
