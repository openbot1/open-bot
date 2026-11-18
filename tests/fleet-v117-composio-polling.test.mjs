/**
 * Composio polling v4 tests (v1.17, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Dynamic interval: busy shrinks, idle stretches, bounded [min, max].
 * - Backoff: exponential with cap + deterministic jitter.
 * - Dedupe 3 layers: seen-id, too-old window, same-payload hash
 *   (stable stringify ignores key order).
 * - Tick engine: success path (checkpoint advances, totals counted),
 *   error path (backoff, then auto-pause after N consecutive errors),
 *   catch-up cap, disabled trigger never polled.
 * - Resume after restart: overdue triggers flagged with missed window.
 * - Persistence: save/load round-trip, corrupt file → null.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v117-composio-polling.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  addComposioV14Trigger,
  computeComposioV14BackoffInterval,
  computeComposioV14DynamicInterval,
  composioV14Jitter,
  createComposioV14PollState,
  createComposioV14Trigger,
  dedupeComposioV14Events,
  defaultComposioV14TriggerConfig,
  hashComposioV14EventPayload,
  isComposioV14TriggerDue,
  loadComposioV14PollState,
  pollComposioV14Trigger,
  resumeComposioV14PollState,
  saveComposioV14PollState,
  setComposioV14TriggerStatus,
  stableStringifyComposioV14,
  summarizeComposioV14Trigger,
  tickComposioV14Poll,
} from '../packages/core/dist/fleetV14/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const MIN = 60 * 1000;

function tmpRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-poll-v14-')), 'team');
}

function makeTrigger(id = 'trig-gmail', baseMs = MIN) {
  return createComposioV14Trigger(
    { triggerId: id, connectionId: 'conn-1', toolkit: 'gmail', triggerSlug: 'new-email', baseIntervalMs: baseMs },
    T0,
  );
}

test('dynamic interval: busy shrinks, idle stretches, bounded by min/max', () => {
  const cfg = defaultComposioV14TriggerConfig(MIN);
  // Busy: shrink by step, floored at min.
  assert.equal(computeComposioV14DynamicInterval(cfg, 4 * MIN, 0.9, 0, 2), 2 * MIN);
  assert.equal(computeComposioV14DynamicInterval(cfg, MIN, 0.9, 0, 2), 30 * 1000, 'shrink stops at minIntervalMs');
  assert.equal(computeComposioV14DynamicInterval(cfg, 15 * 1000, 0.9, 0, 5), 15 * 1000);
  // Not enough busy polls yet: no shrink.
  assert.equal(computeComposioV14DynamicInterval(cfg, 4 * MIN, 0.9, 0, 1), 4 * MIN);
  // Idle: stretch after 3 idle polls, capped at max.
  assert.equal(computeComposioV14DynamicInterval(cfg, MIN, 0.0, 3, 0), 2 * MIN);
  assert.equal(computeComposioV14DynamicInterval(cfg, MIN, 0.0, 2, 0), MIN, 'needs 3 idle polls');
  assert.equal(computeComposioV14DynamicInterval(cfg, 30 * MIN, 0.0, 5, 0), 30 * MIN, 'stretch stops at maxIntervalMs');
  // Medium busy: drift back toward base.
  assert.equal(computeComposioV14DynamicInterval(cfg, 4 * MIN, 0.5, 0, 0), 2 * MIN);
  assert.equal(computeComposioV14DynamicInterval(cfg, MIN / 2, 0.5, 0, 0), MIN);
  // Jitter is deterministic and within ±10%.
  assert.equal(composioV14Jitter('trig-gmail'), composioV14Jitter('trig-gmail'));
  assert.ok(Math.abs(composioV14Jitter('trig-gmail')) <= 0.1);
});

test('backoff: exponential, capped at maxBackoffMs', () => {
  const cfg = defaultComposioV14TriggerConfig(MIN);
  const b0 = computeComposioV14BackoffInterval(cfg, 'trig-a', 0);
  const b1 = computeComposioV14BackoffInterval(cfg, 'trig-a', 1);
  assert.ok(b1 > b0, `backoff grows: ${b0} -> ${b1}`);
  const bBig = computeComposioV14BackoffInterval(cfg, 'trig-a', 30);
  assert.ok(bBig <= 2 * 60 * 60 * 1000 * 1.1, `capped near 2h + jitter, got ${bBig}`);
  assert.ok(bBig >= 1000);
});

test('dedupe: seen-id, too-old window, same-payload hash (key order ignored)', () => {
  const cfg = defaultComposioV14TriggerConfig(MIN);
  assert.equal(stableStringifyComposioV14({ b: 1, a: { d: 4, c: 3 } }), stableStringifyComposioV14({ a: { c: 3, d: 4 }, b: 1 }));
  assert.equal(hashComposioV14EventPayload({ a: 1 }), hashComposioV14EventPayload({ a: 1 }));
  assert.notEqual(hashComposioV14EventPayload({ a: 1 }), hashComposioV14EventPayload({ a: 2 }));
  const events = [
    { id: 'e1', occurredAt: T0, payload: { subject: 'hi' } },
    { id: 'e1', occurredAt: T0, payload: { subject: 'hi again' } },
    { id: 'e2', occurredAt: T0, payload: { subject: 'hi' } },
    { id: 'e3', occurredAt: T0 - 25 * 60 * 60 * 1000, payload: { subject: 'old' } },
    { id: 'e4', occurredAt: T0, payload: { subject: 'fresh' } },
  ];
  const res = dedupeComposioV14Events(events, [], [], cfg, T0);
  assert.deepEqual(res.fresh.map((e) => e.id), ['e1', 'e4']);
  assert.deepEqual(res.duplicates.map((d) => d.reason), ['seen-id', 'seen-hash', 'too-old']);
  assert.equal(res.seenIds.length, 2);
  // Second call with same seen buffers: everything is duplicate.
  const res2 = dedupeComposioV14Events(events.slice(0, 1), res.seenIds, res.seenHashes, cfg, T0);
  assert.equal(res2.fresh.length, 0);
});

test('tick success: checkpoint advances, totals counted, idle stretches interval', async () => {
  let state = createComposioV14PollState(T0);
  const trigger = makeTrigger();
  const added = addComposioV14Trigger(state, trigger, T0);
  assert.equal(added.ok, true);
  state = added.state;
  const dup = addComposioV14Trigger(state, trigger, T0);
  assert.equal(dup.ok, false);
  let fetchCalls = 0;
  const fetchFn = async () => {
    fetchCalls++;
    return {
      events: fetchCalls === 1
        ? [
          { id: 'e1', occurredAt: T0, payload: { n: 1 } },
          { id: 'e2', occurredAt: T0, payload: { n: 2 } },
        ]
        : [],
      cursor: `cursor-${fetchCalls}`,
    };
  };
  const r1 = await tickComposioV14Poll(state, fetchFn, T0);
  assert.equal(r1.results.length, 1);
  assert.equal(r1.results[0].ok, true);
  assert.equal(r1.results[0].freshEvents.length, 2);
  assert.equal(r1.results[0].checkpoint.totalNewEvents, 2);
  assert.equal(r1.results[0].checkpoint.cursor, 'cursor-1');
  assert.equal(r1.results[0].checkpoint.nextPollAt, T0 + MIN);
  state = r1.state;
  // Not due yet.
  const rEarly = await tickComposioV14Poll(state, fetchFn, T0 + 30 * 1000);
  assert.equal(rEarly.results.length, 0);
  assert.equal(fetchCalls, 1);
  // 3 idle polls in a row stretch the interval.
  for (let i = 0; i < 3; i++) {
    const r = await tickComposioV14Poll(state, fetchFn, state.triggers[0].nextPollAt);
    state = r.state;
  }
  assert.equal(state.triggers[0].idlePolls, 3);
  assert.ok(state.triggers[0].currentIntervalMs > MIN, 'interval stretched after idle polls');
  const summary = summarizeComposioV14Trigger(state.triggers[0], T0);
  assert.equal(summary.totalNewEvents, 2);
  assert.equal(summary.status, 'idle');
});

test('tick errors: backoff grows, auto-pause after max consecutive errors', async () => {
  let state = createComposioV14PollState(T0);
  const trigger = makeTrigger();
  state = addComposioV14Trigger(state, trigger, T0).state;
  const failingFetch = async () => { throw new Error('Composio 503'); };
  let current = T0;
  for (let i = 0; i < 10; i++) {
    const r = await tickComposioV14Poll(state, failingFetch, current);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].error, /503/);
    state = r.state;
    current = state.triggers[0].nextPollAt;
    if (i < 9) assert.equal(state.triggers[0].status, 'backing-off');
  }
  assert.equal(state.triggers[0].status, 'paused');
  assert.equal(state.triggers[0].consecutiveErrors, 10);
  // Paused trigger is never due again.
  const r = await tickComposioV14Poll(state, failingFetch, current + 10 * MIN);
  assert.equal(r.results.length, 0);
  // Manual resume resets errors.
  const resumed = setComposioV14TriggerStatus(state.triggers[0], 'idle', current);
  assert.equal(resumed.consecutiveErrors, 0);
  assert.equal(isComposioV14TriggerDue(resumed, current), true);
  // Disabled trigger is never due.
  const disabled = setComposioV14TriggerStatus(state.triggers[0], 'disabled', current);
  assert.equal(isComposioV14TriggerDue(disabled, current), false);
});

test('catch-up cap: long gap only takes newest maxCatchUpEvents', async () => {
  const trigger = makeTrigger();
  trigger.config.maxCatchUpEvents = 3;
  trigger.lastPollAt = T0;
  trigger.nextPollAt = T0 + MIN;
  const events = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, occurredAt: T0 + i * 1000, payload: { n: i } }));
  const fetchFn = async () => ({ events, cursor: 'c1' });
  const res = await pollComposioV14Trigger(trigger, fetchFn, T0 + 100 * MIN);
  assert.equal(res.catchUp, true);
  assert.equal(res.freshEvents.length, 3, 'catch-up capped at 3 newest');
  assert.deepEqual(res.freshEvents.map((e) => e.id), ['e9', 'e8', 'e7']);
});

test('resume after restart: overdue flagged with missed window', () => {
  let state = createComposioV14PollState(T0);
  const t1 = makeTrigger('trig-a');
  const t2 = { ...makeTrigger('trig-b'), nextPollAt: T0 + 10 * MIN, lastPollAt: T0 };
  state = addComposioV14Trigger(state, t1, T0).state;
  state = addComposioV14Trigger(state, t2, T0).state;
  const { state: resumed, report } = resumeComposioV14PollState(state, T0 + 20 * MIN);
  assert.equal(report.resumedCount, 2);
  assert.equal(report.overdue.length, 2);
  assert.equal(report.overdue.find((o) => o.triggerId === 'trig-b').missedWindowMs, 20 * MIN);
  assert.equal(resumed.triggers.find((t) => t.triggerId === 'trig-b').resumeCount, 1);
  assert.equal(resumed.triggers.find((t) => t.triggerId === 'trig-b').nextPollAt, T0 + 20 * MIN);
});

test('persistence: save/load round-trip, corrupt file returns null', () => {
  const root = tmpRoot();
  let state = createComposioV14PollState(T0);
  state = addComposioV14Trigger(state, makeTrigger(), T0).state;
  saveComposioV14PollState(root, state);
  const loaded = loadComposioV14PollState(root);
  assert.ok(loaded);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.triggers.length, 1);
  assert.equal(loaded.triggers[0].triggerId, 'trig-gmail');
  fs.writeFileSync(path.join(root, 'composio-poll-v117.json'), 'oops');
  assert.equal(loadComposioV14PollState(root), null);
  assert.equal(loadComposioV14PollState(path.join(root, 'missing')), null);
});
