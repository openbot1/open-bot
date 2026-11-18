/**
 * Fleet v10 triggers tests (v1.13, Doi T6 — node:test, no network).
 *
 * Covers:
 * - Glob: `*`, `**`, `?` for file paths and payload values
 * - Filter: kind/source/pathGlob/payloadMatch/userId/minQueueDepth
 * - Decide: disabled, filtered, duplicate, cooldown, throttle,
 *   debounce, rate-limited, fired — in that precedence order
 * - Evaluate batch: one event fires matching triggers only, duplicate
 *   event id in one batch is processed once
 * - Apply decision: fired updates lastRunAt/runCount, debounced
 *   updates lastMatchedAt, filtered-disabled changes nothing
 * - Runs in last hour + summary counts
 * - Persistence round-trip: triggers + runs to tmp fleet root
 *   (atomic, mode 0600), corrupt file loads as empty
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v113-triggers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FLEET_V10_MAX_TRIGGER_RUNS,
  applyFleetV10DecisionToTrigger,
  createFleetV10Trigger,
  decideFleetV10Trigger,
  evaluateFleetV10Triggers,
  fleetV10GlobMatch,
  fleetV10RunsInLastHour,
  loadFleetV10TriggerRuns,
  loadFleetV10Triggers,
  recordFleetV10TriggerRun,
  removeFleetV10Trigger,
  saveFleetV10TriggerRuns,
  saveFleetV10Triggers,
  setFleetV10TriggerEnabled,
  summarizeFleetV10Triggers,
  validateFleetV10Event,
  validateFleetV10Trigger,
} from '../packages/core/dist/fleet/fleetV10Triggers.js';

const T0 = Date.UTC(2026, 10, 15, 0, 0, 0);

function makeTrigger(overrides = {}) {
  return createFleetV10Trigger(
    {
      name: 'notes-watcher',
      agentId: 'bot-notes',
      ownerUserId: 'alice',
      eventKind: 'file-changed',
      condition: { pathGlob: 'notes/**.md' },
      debounceMs: 5000,
      throttleMs: 0,
      cooldownMs: 0,
      maxRunsPerHour: 0,
      ...overrides,
    },
    T0,
  );
}

function makeEvent(overrides = {}) {
  return validateFleetV10Event({
    id: 'evt-1',
    kind: 'file-changed',
    at: T0 + 10_000,
    source: 'workspace',
    filePath: 'notes/todo.md',
    userId: 'alice',
    ...overrides,
  });
}

test('glob: * trong 1 doan, ** qua nhieu doan, ? 1 ky tu', () => {
  assert.equal(fleetV10GlobMatch('notes/*.md', 'notes/todo.md'), true);
  assert.equal(fleetV10GlobMatch('notes/*.md', 'notes/a/b.md'), false);
  assert.equal(fleetV10GlobMatch('notes/**.md', 'notes/a/b/c.md'), true);
  assert.equal(fleetV10GlobMatch('notes/**.md', 'notes/todo.md'), true);
  assert.equal(fleetV10GlobMatch('notes/?.md', 'notes/a.md'), true);
  assert.equal(fleetV10GlobMatch('notes/?.md', 'notes/ab.md'), false);
  assert.equal(fleetV10GlobMatch('*.md', 'todo.md'), true);
  assert.equal(fleetV10GlobMatch('*.md', 'a/todo.md'), false);
});

test('create: mac dinh debounce/throttle/cooldown, validate nem loi khi sai', () => {
  const t = createFleetV10Trigger(
    { name: 'w', agentId: 'b1', ownerUserId: 'alice', eventKind: 'webhook-local' },
    T0,
  );
  assert.equal(t.debounceMs, 5000);
  assert.equal(t.throttleMs, 60000);
  assert.equal(t.maxRunsPerHour, 20);
  assert.equal(t.enabled, true);
  assert.equal(t.runCount, 0);
  assert.equal(t.lastRunAt, null);
  assert.throws(() => createFleetV10Trigger({ name: '', agentId: 'b', ownerUserId: 'a', eventKind: 'webhook-local' }), /non-empty name/);
  assert.throws(
    () => createFleetV10Trigger({ name: 'x', agentId: 'b', ownerUserId: 'a', eventKind: 'nope' }),
    /eventKind must be one of/,
  );
  assert.throws(
    () => validateFleetV10Trigger({ ...t, debounceMs: -1 }),
    /debounceMs must be a number/,
  );
});

test('filter: pathGlob, source, payloadMatch, userId, queue-depth', () => {
  const t = makeTrigger();
  assert.equal(decideFleetV10Trigger(t, makeEvent(), [], T0 + 10_000).fire, true);
  // File khong khop glob.
  assert.equal(decideFleetV10Trigger(t, makeEvent({ filePath: 'notes/todo.txt' }), [], T0 + 10_000).status, 'filtered');
  // Source khong nam trong danh sach.
  const t2 = makeTrigger({ condition: { pathGlob: 'notes/**.md', sources: ['git'] } });
  assert.match(decideFleetV10Trigger(t2, makeEvent(), [], T0 + 10_000).reason, /source workspace not in/);
  // Payload khop glob + khop so.
  const t3 = createFleetV10Trigger(
    { name: 'msg', agentId: 'b1', ownerUserId: 'alice', eventKind: 'message-inbound', condition: { payloadMatch: { channel: 'slack-*', priority: 1 } }, debounceMs: 0, throttleMs: 0, maxRunsPerHour: 0 },
    T0,
  );
  assert.equal(
    decideFleetV10Trigger(t3, makeEvent({ id: 'e2', kind: 'message-inbound', filePath: undefined, payload: { channel: 'slack-general', priority: 1 } }), [], T0 + 10_000).fire,
    true,
  );
  assert.equal(
    decideFleetV10Trigger(t3, makeEvent({ id: 'e3', kind: 'message-inbound', filePath: undefined, payload: { channel: 'slack-general', priority: 2 } }), [], T0 + 10_000).status,
    'filtered',
  );
  // User khong khop.
  const t4 = makeTrigger({ condition: { pathGlob: 'notes/**.md', userId: 'bob' } });
  assert.match(decideFleetV10Trigger(t4, makeEvent(), [], T0 + 10_000).reason, /event user alice != bob/);
  // Queue depth duoi nguong.
  const t5 = createFleetV10Trigger(
    { name: 'q', agentId: 'b1', ownerUserId: 'alice', eventKind: 'queue-depth', condition: { minQueueDepth: 5 }, debounceMs: 0, throttleMs: 0, maxRunsPerHour: 0 },
    T0,
  );
  assert.equal(
    decideFleetV10Trigger(t5, makeEvent({ id: 'e4', kind: 'queue-depth', filePath: undefined, payload: { depth: 3 } }), [], T0 + 10_000).status,
    'filtered',
  );
  assert.equal(
    decideFleetV10Trigger(t5, makeEvent({ id: 'e5', kind: 'queue-depth', filePath: undefined, payload: { depth: 7 } }), [], T0 + 10_000).fire,
    true,
  );
});

test('decide: thu tu uu tien cooldown > throttle > debounce > gioi han/gio', () => {
  const now = T0 + 100_000;
  // Disabled.
  const disabled = makeTrigger({ enabled: false, debounceMs: 0, throttleMs: 0 });
  assert.equal(decideFleetV10Trigger(disabled, makeEvent(), [], now).status, 'filtered');
  // Duplicate.
  const t = makeTrigger({ debounceMs: 0, throttleMs: 0, maxRunsPerHour: 0 });
  assert.equal(decideFleetV10Trigger(t, makeEvent(), [], now, new Set(['evt-1'])).status, 'duplicate');
  // Cooldown thang throttle (ca hai deu vuot).
  const cooling = { ...t, lastRunAt: now - 1000, cooldownMs: 60_000, throttleMs: 30_000 };
  assert.equal(decideFleetV10Trigger(cooling, makeEvent(), [], now).status, 'cooldown');
  // Throttle khi het cooldown.
  const throttled = { ...t, lastRunAt: now - 1000, cooldownMs: 0, throttleMs: 30_000 };
  assert.equal(decideFleetV10Trigger(throttled, makeEvent(), [], now).status, 'throttled');
  // Debounce khi het throttle.
  const debounced = { ...t, lastRunAt: now - 100_000, lastMatchedAt: now - 1000, debounceMs: 5000, throttleMs: 0 };
  assert.equal(decideFleetV10Trigger(debounced, makeEvent(), [], now).status, 'debounced');
  // Gioi han/gio: 2 lan trong gio qua, max 2.
  const limited = { ...t, debounceMs: 0, throttleMs: 0, maxRunsPerHour: 2, lastRunAt: null, lastMatchedAt: null };
  const runs = [
    { id: 'r1', triggerId: limited.id, eventId: 'e1', status: 'fired', reason: 'x', at: now - 1000 },
    { id: 'r2', triggerId: limited.id, eventId: 'e2', status: 'fired', reason: 'x', at: now - 2000 },
  ];
  assert.equal(fleetV10RunsInLastHour(runs, limited.id, now), 2);
  assert.equal(decideFleetV10Trigger(limited, makeEvent(), runs, now).status, 'rate-limited');
  // Het gioi han khi run cu hon 1 gio.
  const oldRuns = [{ ...runs[0], at: now - 3_700_000 }, { ...runs[1], at: now - 3_700_000 }];
  assert.equal(decideFleetV10Trigger(limited, makeEvent(), oldRuns, now).fire, true);
});

test('evaluate batch: chi trigger dung kind chay, trung id chi xu ly 1 lan', () => {
  const fileTrigger = makeTrigger({ debounceMs: 0, throttleMs: 0, maxRunsPerHour: 0 });
  const msgTrigger = createFleetV10Trigger(
    { name: 'msg', agentId: 'b2', ownerUserId: 'alice', eventKind: 'message-inbound', debounceMs: 0, throttleMs: 0, maxRunsPerHour: 0 },
    T0,
  );
  const events = [
    makeEvent(),
    makeEvent({ id: 'evt-1' }), // trung id
    makeEvent({ id: 'evt-2', kind: 'message-inbound', filePath: undefined }),
  ];
  const decisions = evaluateFleetV10Triggers(events, [fileTrigger, msgTrigger], [], T0 + 10_000);
  const fired = decisions.filter((d) => d.fire);
  assert.equal(fired.length, 2);
  assert.deepEqual(fired.map((d) => d.triggerId).sort(), [fileTrigger.id, msgTrigger.id].sort());
  assert.equal(decisions.filter((d) => d.status === 'duplicate').length, 1);
});

test('apply decision: fired cap nhat runCount, debounced cap nhat lastMatchedAt', () => {
  const now = T0 + 50_000;
  const t = makeTrigger({ debounceMs: 0, throttleMs: 0, maxRunsPerHour: 0 });
  const fired = decideFleetV10Trigger(t, makeEvent(), [], now);
  const afterFire = applyFleetV10DecisionToTrigger(t, fired, now);
  assert.equal(afterFire.runCount, 1);
  assert.equal(afterFire.lastRunAt, now);
  const debouncedTrigger = { ...t, debounceMs: 5000, lastMatchedAt: now - 1000 };
  const deb = decideFleetV10Trigger(debouncedTrigger, makeEvent(), [], now);
  assert.equal(deb.status, 'debounced');
  const afterDeb = applyFleetV10DecisionToTrigger(debouncedTrigger, deb, now);
  assert.equal(afterDeb.runCount, 0);
  assert.equal(afterDeb.lastMatchedAt, now);
  // Trigger tat: khong doi gi.
  const off = { ...t, enabled: false };
  const filtered = decideFleetV10Trigger(off, makeEvent(), [], now);
  assert.deepEqual(applyFleetV10DecisionToTrigger(off, filtered, now), off);
});

test('record run + summary: cat bot lich su, dem dung theo gio', () => {
  let runs = [];
  const t = makeTrigger({ debounceMs: 0, throttleMs: 0, maxRunsPerHour: 0 });
  for (let i = 0; i < FLEET_V10_MAX_TRIGGER_RUNS + 5; i++) {
    runs = recordFleetV10TriggerRun(runs, { triggerId: t.id, eventId: `e${i}`, fire: true, status: 'fired', reason: 'ok' }, T0 + i * 1000);
  }
  assert.equal(runs.length, FLEET_V10_MAX_TRIGGER_RUNS);
  const summary = summarizeFleetV10Triggers([t], runs, T0 + (FLEET_V10_MAX_TRIGGER_RUNS + 5) * 1000);
  assert.equal(summary.total, 1);
  assert.equal(summary.enabled, 1);
  assert.equal(summary.byKind['file-changed'], 1);
  assert.ok(summary.firedLastHour > 0);
});

test('enable/remove + persistence round-trip, file hong = rong', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v10-trig-'));
  try {
    const t1 = makeTrigger();
    const t2 = makeTrigger({ name: 'second', eventKind: 'webhook-local' });
    saveFleetV10Triggers(root, [t1, t2]);
    assert.equal(fs.statSync(path.join(root, 'fleet-triggers-v113.json')).mode & 0o777, 0o600);
    const loaded = loadFleetV10Triggers(root);
    assert.equal(loaded.length, 2);
    const disabled = setFleetV10TriggerEnabled(loaded, t1.id, false, T0 + 1000);
    assert.equal(disabled.find((x) => x.id === t1.id).enabled, false);
    assert.throws(() => setFleetV10TriggerEnabled(loaded, 'nope', false), /not found/);
    const removed = removeFleetV10Trigger(disabled, t2.id);
    assert.equal(removed.length, 1);
    assert.throws(() => removeFleetV10Trigger(removed, 'nope'), /not found/);
    const runs = recordFleetV10TriggerRun([], { triggerId: t1.id, eventId: 'e1', fire: true, status: 'fired', reason: 'ok' }, T0, { durationMs: 123 });
    saveFleetV10TriggerRuns(root, runs);
    assert.equal(loadFleetV10TriggerRuns(root).length, 1);
    assert.equal(loadFleetV10TriggerRuns(root)[0].durationMs, 123);
    // File hong -> rong, khong nem loi.
    fs.writeFileSync(path.join(root, 'fleet-triggers-v113.json'), '{broken');
    assert.deepEqual(loadFleetV10Triggers(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
