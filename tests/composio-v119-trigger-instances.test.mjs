/**
 * Composio v119 tests — trigger instances v2 (v1.19, Doi T4 —
 * node:test, no network, no key).
 *
 * Covers triggerInstancesV119.ts:
 * - Lifecycle table (draft/active/paused/stopped/archived),
 *   allowed/illegal transitions, archived is terminal
 * - Register/create validation, runnable rule (active + enabled)
 * - Run lifecycle: start (only when runnable), finish
 *   (success/failed/skipped), errors, consecutiveErrors
 * - Prune: maxRuns cap keeps running runs, drops oldest finished
 * - Stuck-run detection, run/instance summaries, filter
 * - Audit entries, memory store + JSON file store (round-trip,
 *   audit on disk)
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v119-trigger-instances.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPOSIO_V119_DEFAULT_MAX_RUNS_PER_INSTANCE,
  COMPOSIO_V119_MAX_INSTANCES,
  COMPOSIO_V119_STUCK_RUN_AFTER_MS,
  COMPOSIO_V119_TRIGGER_LIFECYCLE_TRANSITIONS,
  COMPOSIO_V119_TRIGGER_LIFECYCLES,
  JsonFileComposioV119TriggerInstanceStore,
  MemoryComposioV119TriggerInstanceStore,
  countComposioV119RunningRuns,
  createComposioV119TriggerAuditEntry,
  createComposioV119TriggerInstance,
  filterComposioV119TriggerInstances,
  findComposioV119StuckRuns,
  finishComposioV119TriggerRun,
  isComposioV119LifecycleTransitionAllowed,
  isComposioV119TriggerInstanceRunnable,
  pruneComposioV119Runs,
  startComposioV119TriggerRun,
  summarizeComposioV119TriggerInstance,
  summarizeComposioV119TriggerInstances,
  summarizeComposioV119TriggerRuns,
  transitionComposioV119TriggerLifecycle,
  validateComposioV119TriggerAuditEntry,
  validateComposioV119TriggerInstance,
  validateComposioV119TriggerRun,
  composioV119RunDurationMs,
} from '../packages/core/dist/composio/triggerInstancesV119.js';

const NOW = 1780000000000; // 2026-05-28T20:26:40Z

function makeInput(over = {}) {
  return {
    triggerId: 'ti_test1',
    triggerSlug: 'GITHUB_COMMIT_EVENT',
    toolkit: 'github',
    connectionId: 'ca_1',
    label: 'Test trigger',
    ...over,
  };
}

function makeActive(over = {}, nowMs = NOW) {
  const draft = createComposioV119TriggerInstance(makeInput(over), nowMs);
  return transitionComposioV119TriggerLifecycle(draft, 'active', 'go live', nowMs);
}

test('v119 trigger instances: lifecycles + transition table', () => {
  assert.deepEqual([...COMPOSIO_V119_TRIGGER_LIFECYCLES], ['draft', 'active', 'paused', 'stopped', 'archived']);
  assert.deepEqual(COMPOSIO_V119_TRIGGER_LIFECYCLE_TRANSITIONS.draft, ['active', 'archived']);
  assert.deepEqual(COMPOSIO_V119_TRIGGER_LIFECYCLE_TRANSITIONS.active, ['paused', 'stopped', 'archived']);
  assert.deepEqual(COMPOSIO_V119_TRIGGER_LIFECYCLE_TRANSITIONS.paused, ['active', 'stopped', 'archived']);
  assert.deepEqual(COMPOSIO_V119_TRIGGER_LIFECYCLE_TRANSITIONS.stopped, ['active', 'archived']);
  assert.deepEqual(COMPOSIO_V119_TRIGGER_LIFECYCLE_TRANSITIONS.archived, []);
  assert.equal(isComposioV119LifecycleTransitionAllowed('draft', 'active'), true);
  assert.equal(isComposioV119LifecycleTransitionAllowed('draft', 'paused'), false);
  assert.equal(isComposioV119LifecycleTransitionAllowed('active', 'draft'), false);
  assert.equal(isComposioV119LifecycleTransitionAllowed('archived', 'active'), false);
  assert.equal(isComposioV119LifecycleTransitionAllowed('stopped', 'paused'), false);
  assert.equal(isComposioV119LifecycleTransitionAllowed('paused', 'active'), true);
});

test('v119 trigger instances: create defaults + validation', () => {
  const inst = createComposioV119TriggerInstance(makeInput(), NOW);
  assert.equal(inst.lifecycle, 'draft');
  assert.equal(inst.lifecycleUpdatedAtMs, NOW);
  assert.equal(inst.lifecycleReason, null);
  assert.deepEqual(inst.runs, []);
  assert.equal(inst.maxRuns, COMPOSIO_V119_DEFAULT_MAX_RUNS_PER_INSTANCE);
  assert.equal(inst.maxRuns, 100);
  assert.equal(inst.base.status, 'enabled');
  assert.equal(inst.base.totalFired, 0);
  assert.equal(inst.base.lastFiredAtMs, null);
  const withLifecycle = createComposioV119TriggerInstance(makeInput({ lifecycle: 'active', maxRuns: 5 }), NOW);
  assert.equal(withLifecycle.lifecycle, 'active');
  assert.equal(withLifecycle.maxRuns, 5);
  assert.throws(() => createComposioV119TriggerInstance(makeInput({ lifecycle: 'running' })), /Unknown ComposioV119TriggerLifecycle/);
  assert.throws(() => createComposioV119TriggerInstance(makeInput({ maxRuns: 0 })), /maxRuns must be a positive integer/);
  assert.throws(() => createComposioV119TriggerInstance(makeInput({ triggerId: '' })), /triggerId/);
  assert.throws(() => createComposioV119TriggerInstance(makeInput({ triggerSlug: 'bad-slug' })), /triggerSlug is invalid/);
  assert.throws(() => createComposioV119TriggerInstance(makeInput({ toolkit: '' })), /toolkit/);
});

test('v119 trigger instances: transition updates lifecycle + reason, rejects illegal', () => {
  const draft = createComposioV119TriggerInstance(makeInput(), NOW);
  const active = transitionComposioV119TriggerLifecycle(draft, 'active', 'launch', NOW + 1000);
  assert.equal(active.lifecycle, 'active');
  assert.equal(active.lifecycleUpdatedAtMs, NOW + 1000);
  assert.equal(active.lifecycleReason, 'launch');
  assert.equal(draft.lifecycle, 'draft', 'transition is pure (no mutation)');
  // Empty reason falls back to the target state name.
  const paused = transitionComposioV119TriggerLifecycle(active, 'paused', '   ', NOW + 2000);
  assert.equal(paused.lifecycleReason, 'paused');
  assert.throws(() => transitionComposioV119TriggerLifecycle(draft, 'paused', 'x', NOW), /Invalid Composio v119 lifecycle transition: draft -> paused/);
  const archived = transitionComposioV119TriggerLifecycle(draft, 'archived', 'done', NOW);
  assert.throws(() => transitionComposioV119TriggerLifecycle(archived, 'active', 'x', NOW), /archived -> active/);
});

test('v119 trigger instances: runnable = active lifecycle + enabled base', () => {
  const draft = createComposioV119TriggerInstance(makeInput(), NOW);
  assert.equal(isComposioV119TriggerInstanceRunnable(draft), false);
  const active = transitionComposioV119TriggerLifecycle(draft, 'active', 'go', NOW);
  assert.equal(isComposioV119TriggerInstanceRunnable(active), true);
  const disabled = { ...active, base: { ...active.base, status: 'disabled' } };
  assert.equal(isComposioV119TriggerInstanceRunnable(disabled), false);
  const paused = transitionComposioV119TriggerLifecycle(active, 'paused', 'hold', NOW);
  assert.equal(isComposioV119TriggerInstanceRunnable(paused), false);
});

test('v119 trigger instances: start/finish run happy path + errors', () => {
  const active = makeActive();
  const { instance: withRun, run } = startComposioV119TriggerRun(active, 'evt_1', NOW);
  assert.equal(withRun.runs.length, 1);
  assert.equal(run.eventId, 'evt_1');
  assert.equal(run.startedAtMs, NOW);
  assert.equal(run.finishedAtMs, null);
  assert.equal(run.status, null);
  assert.ok(run.runId.startsWith('run119-'));
  assert.equal(withRun.base.totalFired, 1);
  assert.equal(withRun.base.lastFiredAtMs, NOW);
  assert.equal(countComposioV119RunningRuns(withRun), 1);
  assert.equal(composioV119RunDurationMs(run), null);

  const finished = finishComposioV119TriggerRun(withRun, run.runId, 'success', { nowMs: NOW + 1500 });
  assert.equal(finished.runs[0].status, 'success');
  assert.equal(finished.runs[0].finishedAtMs, NOW + 1500);
  assert.equal(finished.runs[0].error, null);
  assert.equal(composioV119RunDurationMs(finished.runs[0]), 1500);
  assert.equal(countComposioV119RunningRuns(finished), 0);
  assert.equal(finished.base.consecutiveErrors, 0);

  // Failed run: default error message + consecutiveErrors.
  const { instance: w2, run: r2 } = startComposioV119TriggerRun(finished, 'evt_2', NOW + 2000);
  const failed = finishComposioV119TriggerRun(w2, r2.runId, 'failed', { nowMs: NOW + 2500 });
  assert.equal(failed.runs[1].status, 'failed');
  assert.equal(failed.runs[1].error, 'trigger run failed');
  assert.equal(failed.base.consecutiveErrors, 1);
  assert.equal(failed.base.lastError, 'trigger run failed');
  // Custom error text is kept; skipped clears the error counter.
  const { instance: w3, run: r3 } = startComposioV119TriggerRun(failed, null, NOW + 3000);
  assert.equal(r3.eventId, null);
  const failed2 = finishComposioV119TriggerRun(w3, r3.runId, 'failed', { error: 'timeout', nowMs: NOW + 3200 });
  assert.equal(failed2.runs[2].error, 'timeout');
  // Starting run r3 reset the streak to 0 (a new fire), so this
  // second consecutive failure counts as 1, not 2.
  assert.equal(failed2.base.consecutiveErrors, 1);
  const { instance: w4, run: r4 } = startComposioV119TriggerRun(failed2, null, NOW + 4000);
  const skipped = finishComposioV119TriggerRun(w4, r4.runId, 'skipped', { nowMs: NOW + 4100 });
  assert.equal(skipped.runs[3].status, 'skipped');
  assert.equal(skipped.base.consecutiveErrors, 0, 'non-failed finish resets the counter');

  // Errors: unknown run, already finished, start when not runnable.
  assert.throws(() => finishComposioV119TriggerRun(finished, 'nope', 'success'), /Unknown trigger run id/);
  assert.throws(() => finishComposioV119TriggerRun(finished, run.runId, 'success'), /already finished/);
  const draft = createComposioV119TriggerInstance(makeInput(), NOW);
  assert.throws(() => startComposioV119TriggerRun(draft, null, NOW), /is not runnable/);
});

test('v119 trigger instances: prune keeps running runs, drops oldest finished', () => {
  let inst = makeActive({ maxRuns: 3 });
  // 3 finished runs, then a 4th running run → prune drops the oldest finished.
  for (let i = 0; i < 3; i += 1) {
    const started = startComposioV119TriggerRun(inst, `evt_${i}`, NOW + i * 1000);
    inst = finishComposioV119TriggerRun(started.instance, started.run.runId, 'success', { nowMs: NOW + i * 1000 + 100 });
  }
  assert.equal(inst.runs.length, 3);
  const fourth = startComposioV119TriggerRun(inst, 'evt_3', NOW + 4000);
  inst = fourth.instance;
  assert.equal(inst.runs.length, 3, 'maxRuns is enforced on start');
  assert.equal(inst.runs.filter((r) => r.status === null).length, 1, 'the running run survives');
  assert.equal(inst.runs[2].runId, fourth.run.runId);
  assert.equal(inst.runs[0].eventId, 'evt_1', 'oldest finished run was dropped');
  // prune() on its own is a no-op within the cap.
  assert.equal(pruneComposioV119Runs(inst), inst);
});

test('v119 trigger instances: stuck runs + summaries + filter', () => {
  let inst = makeActive();
  const s1 = startComposioV119TriggerRun(inst, 'e1', NOW);
  inst = finishComposioV119TriggerRun(s1.instance, s1.run.runId, 'success', { nowMs: NOW + 100 });
  const s2 = startComposioV119TriggerRun(inst, 'e2', NOW + 200);
  inst = finishComposioV119TriggerRun(s2.instance, s2.run.runId, 'failed', { error: 'x', nowMs: NOW + 500 });
  const s3 = startComposioV119TriggerRun(inst, 'e3', NOW + 1000);
  inst = s3.instance; // still running
  assert.equal(findComposioV119StuckRuns(inst, NOW + 1000).length, 0);
  assert.equal(
    findComposioV119StuckRuns(inst, NOW + 1000 + COMPOSIO_V119_STUCK_RUN_AFTER_MS + 1).length,
    1,
    'running > 30 min is stuck',
  );
  const summary = summarizeComposioV119TriggerRuns(inst, NOW + 2000);
  assert.equal(summary.total, 3);
  assert.equal(summary.running, 1);
  assert.equal(summary.success, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.stuck, 0);
  assert.equal(summary.failureRate, 0.5);
  assert.equal(summary.avgDurationMs, 200, '(100 + 300) / 2');
  assert.equal(summary.maxDurationMs, 300);
  assert.equal(summary.lastRunAtMs, NOW + 1000);
  assert.equal(summary.lastStatus, null);
  assert.match(summarizeComposioV119TriggerInstance(inst, NOW + 2000), /3 runs \(1 ok, 1 failed, 1 running\)/);

  const other = createComposioV119TriggerInstance(makeInput({ triggerId: 'ti_other', toolkit: 'slack', triggerSlug: 'SLACK_NEW_MESSAGE' }), NOW);
  const list = [inst, other];
  assert.equal(filterComposioV119TriggerInstances(list, { toolkit: 'github' }).length, 1);
  assert.equal(filterComposioV119TriggerInstances(list, { lifecycle: 'draft' }).length, 1);
  assert.equal(filterComposioV119TriggerInstances(list, { runnable: true }).length, 1);
  assert.equal(filterComposioV119TriggerInstances(list, { triggerSlug: 'SLACK_NEW_MESSAGE' }).length, 1);
  assert.equal(filterComposioV119TriggerInstances(list, {}).length, 2);
  const all = summarizeComposioV119TriggerInstances(list, NOW + 2000);
  assert.equal(all.total, 2);
  assert.equal(all.runnable, 1);
  assert.equal(all.byLifecycle.active, 1);
  assert.equal(all.byLifecycle.draft, 1);
  assert.equal(all.totalRuns, 3);
  assert.equal(all.totalFailed, 1);
  assert.equal(all.totalRunning, 1);
  assert.deepEqual(all.needsAttention, ['ti_test1'], 'failureRate 0.5 + failures → needs attention');
});

test('v119 trigger instances: run/instance validation rejects bad shapes', () => {
  const good = {
    runId: 'run119-x',
    eventId: null,
    startedAtMs: NOW,
    finishedAtMs: NOW + 10,
    status: 'success',
    error: null,
  };
  assert.deepEqual(validateComposioV119TriggerRun(good), good);
  assert.throws(() => validateComposioV119TriggerRun({ ...good, finishedAtMs: null }), /both be null/);
  assert.throws(() => validateComposioV119TriggerRun({ ...good, status: 'ok' }), /success, failed, skipped or null/);
  assert.throws(() => validateComposioV119TriggerRun({ ...good, finishedAtMs: NOW - 1 }), /must not be before/);
  const inst = makeActive();
  assert.throws(() => validateComposioV119TriggerInstance({ ...inst, runs: [good, good] }), /duplicate runId/);
  assert.throws(() => validateComposioV119TriggerInstance({ ...inst, maxRuns: 0 }), /positive integer/);
  assert.throws(() => validateComposioV119TriggerInstance({ ...inst, lifecycle: 'running' }), /lifecycle is invalid/);
});

test('v119 trigger instances: audit entries', () => {
  const entry = createComposioV119TriggerAuditEntry('ti_test1', 'GITHUB_COMMIT_EVENT', 'lifecycle', 'draft -> active', 'launch', NOW);
  assert.ok(entry.id.startsWith('ti119-'));
  assert.equal(entry.action, 'lifecycle');
  assert.equal(entry.atMs, NOW);
  assert.deepEqual(validateComposioV119TriggerAuditEntry(entry), entry);
  assert.throws(() => createComposioV119TriggerAuditEntry('ti_test1', 'GITHUB_COMMIT_EVENT', 'explode', 'x', 'y', NOW), /Unknown ComposioV119TriggerAuditAction/);
  assert.throws(() => createComposioV119TriggerAuditEntry('', 'GITHUB_COMMIT_EVENT', 'register', 'x', 'y', NOW), /non-empty string/);
  assert.throws(() => validateComposioV119TriggerAuditEntry({ ...entry, detail: '' }), /detail must be a non-empty string/);
});

test('v119 trigger instances: memory store CRUD + audit', () => {
  const store = new MemoryComposioV119TriggerInstanceStore();
  const inst = store.register(makeInput(), NOW);
  assert.equal(inst.base.triggerId, 'ti_test1');
  assert.equal(store.get('ti_test1').base.triggerId, 'ti_test1');
  assert.equal(store.get('nope'), undefined);
  assert.throws(() => store.register(makeInput(), NOW), /duplicate trigger instance id/);
  assert.equal(store.list().length, 1);
  assert.equal(store.list({ lifecycle: 'active' }).length, 0);
  const active = transitionComposioV119TriggerLifecycle(inst, 'active', 'go', NOW);
  store.update(active);
  assert.equal(store.list({ lifecycle: 'active' }).length, 1);
  assert.throws(() => store.update({ ...active, base: { ...active.base, triggerId: 'nope' } }), /unknown trigger instance id/);
  const audit = store.listAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'register');
  assert.equal(store.remove('ti_test1'), true);
  assert.equal(store.remove('ti_test1'), false);
  assert.equal(store.list().length, 0);
  store.register(makeInput(), NOW);
  store.clear();
  assert.equal(store.list().length, 0);
  assert.equal(store.listAudit().length, 0);
  assert.equal(COMPOSIO_V119_MAX_INSTANCES, 500);
});

test('v119 trigger instances: JSON file store persists + audit on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'composio-v119-ti-'));
  try {
    const store = new JsonFileComposioV119TriggerInstanceStore(dir);
    const inst = store.register(makeInput(), NOW);
    assert.ok(existsSync(join(dir, 'composio-trigger-instances-v119.json')));
    const text = readFileSync(join(dir, 'composio-trigger-instances-v119.json'), 'utf8');
    assert.match(text, /ti_test1/);
    // A new store over the same dir sees the same data.
    const store2 = new JsonFileComposioV119TriggerInstanceStore(dir);
    assert.equal(store2.get('ti_test1').lifecycle, 'draft');
    const active = transitionComposioV119TriggerLifecycle(inst, 'active', 'go', NOW);
    store2.update(active);
    assert.equal(new JsonFileComposioV119TriggerInstanceStore(dir).get('ti_test1').lifecycle, 'active');
    assert.throws(() => store2.register(makeInput(), NOW), /duplicate trigger instance id/);
    const audit = store2.listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'register');
    assert.equal(store2.listAudit({ action: 'lifecycle' }).length, 0);
    assert.equal(store2.remove('ti_test1'), true);
    assert.equal(store2.list().length, 0);
    store2.clear();
    assert.equal(existsSync(join(dir, 'composio-trigger-instances-v119.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => new JsonFileComposioV119TriggerInstanceStore(''), /non-empty string/);
});
