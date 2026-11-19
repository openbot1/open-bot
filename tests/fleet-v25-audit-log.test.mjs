/**
 * Tests for the fleet v25 audit log (v1.38, Team T6).
 *
 * Covers:
 * - Append: seq/hash chain, genesis prevHash, ids, input validation.
 * - Query: actor/action/prefix/resource/result/time-window, limit,
 *   newest-first, forResource/forActor/denied/failures helpers.
 * - Verify: valid chain, tampered content (via serialised JSON),
 *   deleted line (via serialised JSON), prune-with-checkpoint keeps
 *   verifying, summary counts.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v25-audit-log.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V25_AUDIT_GENESIS_HASH,
  FleetV25AuditLog,
  createFleetV25AuditLog,
  hashFleetV25AuditEntry,
  summarizeFleetV25Audit,
} from '../packages/core/dist/fleetV25/index.js';

const T0 = Date.UTC(2026, 10, 18, 10, 0, 0);

function seededLog() {
  const log = createFleetV25AuditLog();
  log.append({ actorId: 'admin', actorRole: 'admin', action: 'user.create', resourceType: 'user', resourceId: 'u-op', result: 'success', detail: 'Invited u-op.' }, T0);
  log.append({ actorId: 'u-op', actorRole: 'operator', action: 'schedule.create', resourceType: 'schedule', resourceId: 's-nightly', result: 'success', detail: 'Created schedule.' }, T0 + 1000);
  log.append({ actorId: 'u-view', actorRole: 'viewer', action: 'user.create', resourceType: 'user', resourceId: 'u-x', result: 'denied', detail: 'Role viewer cannot manage-users.' }, T0 + 2000);
  log.append({ actorId: 'engine', actorRole: null, action: 'schedule.run', resourceType: 'schedule', resourceId: 's-nightly', result: 'failure', detail: 'Dispatch failed.' }, T0 + 3000);
  return log;
}

test('audit v25: append — seq, hash chain, genesis', () => {
  const log = createFleetV25AuditLog();
  assert.equal(log.size, 0);
  assert.deepEqual(log.verify(), { ok: true, checked: 0, badSeq: null, reason: null, pruned: false, prunedBeforeSeq: 0 });
  const e1 = log.append({ actorId: 'admin', action: 'user.create', resourceType: 'user', resourceId: 'u1', result: 'success' }, T0);
  assert.equal(e1.seq, 1);
  assert.equal(e1.id, 'audit-1');
  assert.equal(e1.prevHash, FLEET_V25_AUDIT_GENESIS_HASH);
  assert.match(e1.hash, /^[0-9a-f]{64}$/);
  assert.equal(e1.hash, hashFleetV25AuditEntry({ ...e1, hash: undefined, }));
  const e2 = log.append({ actorId: 'admin', action: 'user.disable', resourceType: 'user', resourceId: 'u1', result: 'success', detail: '  spaced detail  ' }, T0 + 1);
  assert.equal(e2.seq, 2);
  assert.equal(e2.prevHash, e1.hash);
  assert.notEqual(e2.hash, e1.hash);
  assert.equal(e2.detail, 'spaced detail');
  assert.equal(e2.actorRole, null);
  assert.equal(log.size, 2);
  assert.equal(log.verify().ok, true);
  assert.equal(log.verify().checked, 2);

  assert.throws(() => log.append({ actorId: '  ', action: 'x', resourceType: 'user', resourceId: 'u', result: 'success' }, T0), /actorId/);
  assert.throws(() => log.append({ actorId: 'a', action: '', resourceType: 'user', resourceId: 'u', result: 'success' }, T0), /action/);
  assert.throws(() => log.append({ actorId: 'a', action: 'x', resourceType: 'nope', resourceId: 'u', result: 'success' }, T0), /resource type/);
  assert.throws(() => log.append({ actorId: 'a', action: 'x', resourceType: 'user', resourceId: 'u', result: 'maybe' }, T0), /result/);
});

test('audit v25: query — filters, newest-first, helpers', () => {
  const log = seededLog();
  assert.equal(log.list().length, 4);
  assert.equal(log.query({ actorId: 'admin' }).length, 1);
  assert.equal(log.query({ action: 'user.create' }).length, 2);
  assert.equal(log.query({ actionPrefix: 'user.' }).length, 2);
  assert.equal(log.query({ actionPrefix: 'schedule.' }).length, 2);
  assert.equal(log.query({ resourceType: 'schedule' }).length, 2);
  assert.equal(log.query({ resourceId: 's-nightly' }).length, 2);
  assert.equal(log.query({ result: 'denied' }).length, 1);
  assert.equal(log.query({ result: 'failure' }).length, 1);
  assert.equal(log.query({ fromMs: T0 + 2000 }).length, 2);
  assert.equal(log.query({ toMs: T0 + 1000 }).length, 2);
  assert.equal(log.query({ fromMs: T0 + 1000, toMs: T0 + 2000 }).length, 2);
  assert.equal(log.query({ limit: 2 }).length, 2);
  assert.equal(log.query({ limit: 0 }).length, 0);
  assert.throws(() => log.query({ limit: -1 }), /limit must be >= 0/);
  const newest = log.query({ newestFirst: true });
  assert.equal(newest[0].seq, 4);
  assert.equal(newest[3].seq, 1);
  assert.equal(log.query({ newestFirst: true, limit: 1 })[0].seq, 4);
  assert.equal(log.forResource('schedule', 's-nightly').length, 2);
  assert.equal(log.forActor('u-op').length, 1);
  assert.equal(log.forActor('u-op')[0].action, 'schedule.create');
  assert.equal(log.denied().length, 1);
  assert.equal(log.denied()[0].actorId, 'u-view');
  assert.equal(log.failures().length, 1);
  assert.equal(log.failures()[0].action, 'schedule.run');
  assert.equal(log.query({ actorId: 'nobody' }).length, 0);
});

test('audit v25: summary + one-line summary', () => {
  const log = seededLog();
  const s = log.summary();
  assert.equal(s.total, 4);
  assert.deepEqual(s.byResult, { success: 2, allowed: 0, denied: 1, failure: 1 });
  assert.equal(s.denied, 1);
  assert.equal(s.failures, 1);
  assert.equal(s.byAction[0].action, 'user.create');
  assert.equal(s.byAction[0].count, 2);
  assert.equal(s.byAction.find((a) => a.action === 'schedule.create')?.count, 1);
  assert.equal(s.byActor.find((a) => a.actorId === 'admin')?.count, 1);
  assert.equal(s.firstAtMs, T0);
  assert.equal(s.lastAtMs, T0 + 3000);
  assert.match(summarizeFleetV25Audit(log), /4 audit entries/);
  assert.match(summarizeFleetV25Audit(log), /chain valid/);
  assert.match(summarizeFleetV25Audit(createFleetV25AuditLog()), /0 audit entries/);
});

test('audit v25: tamper — edited entry breaks verify at that seq', () => {
  const log = seededLog();
  const json = log.toJSON();
  // Edit the content of entry 2 (action) without fixing its hash.
  json.entries[1].action = 'schedule.remove';
  assert.throws(
    () => FleetV25AuditLog.fromJSON(json),
    /chain broken at seq 2/,
  );
  // Same tamper, checked through the live object (white-box: TS-private
  // fields are runtime-accessible, so a test may simulate an edit).
  const live = seededLog();
  live.entries[1].action = 'schedule.remove';
  const v = live.verify();
  assert.equal(v.ok, false);
  assert.equal(v.badSeq, 2);
  assert.match(v.reason ?? '', /hash does not match/);
  assert.equal(v.checked, 4);
});

test('audit v25: tamper — deleted line breaks the chain link', () => {
  const log = seededLog();
  const json = log.toJSON();
  json.entries.splice(1, 1); // delete entry 2; entry 3 prevHash now dangles
  assert.throws(
    () => FleetV25AuditLog.fromJSON(json),
    /chain broken at seq 3/,
  );
  const live = seededLog();
  live.entries.splice(1, 1);
  const v = live.verify();
  assert.equal(v.ok, false);
  assert.equal(v.badSeq, 3);
  assert.match(v.reason ?? '', /prevHash does not match/);
});

test('audit v25: prune — checkpoint keeps the remaining chain valid', () => {
  const log = seededLog();
  assert.equal(log.pruneBeforeSeq(1), 0);
  assert.equal(log.pruneBeforeSeq(3), 2);
  assert.equal(log.size, 2);
  assert.equal(log.pruned, true);
  const v = log.verify();
  assert.equal(v.ok, true);
  assert.equal(v.checked, 2);
  assert.equal(v.pruned, true);
  assert.equal(v.prunedBeforeSeq, 2);
  assert.equal(log.list()[0].seq, 3);
  assert.equal(log.list()[0].prevHash, log.toJSON().checkpointHash);
  // A new entry still chains onto the retained tail.
  log.append({ actorId: 'admin', action: 'audit.prune', resourceType: 'audit', resourceId: 'log', result: 'success' }, T0 + 9000);
  assert.equal(log.verify().ok, true);
  assert.equal(log.size, 3);
  assert.match(summarizeFleetV25Audit(log), /pruned before seq 2/);

  // Pruned log round-trips through JSON and still verifies.
  const restored = FleetV25AuditLog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())));
  assert.equal(restored.verify().ok, true);
  assert.equal(restored.size, 3);
  assert.equal(restored.pruned, true);
});

test('audit v25: JSON / JSONL round-trip', () => {
  const log = seededLog();
  const restored = FleetV25AuditLog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())));
  assert.equal(restored.size, 4);
  assert.equal(restored.verify().ok, true);
  assert.equal(restored.list()[3].hash, log.list()[3].hash);
  const jsonl = log.toJSONL();
  assert.equal(jsonl.trim().split('\n').length, 4);
  assert.equal(JSON.parse(jsonl.trim().split('\n')[0]).seq, 1);
  assert.equal(createFleetV25AuditLog().toJSONL(), '');
  assert.throws(() => FleetV25AuditLog.fromJSON(null), /Invalid audit log/);
  assert.throws(() => FleetV25AuditLog.fromJSON({ entries: 'nope' }), /must be an array/);
});
