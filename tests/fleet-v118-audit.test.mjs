/**
 * Audit log v15 tests (v1.18, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Unified rows: user-audit + fleet/team AuditEvent merged, newest
 *   first, sources labelled, user chain verified flag carried.
 * - Filter: by userId / actor / action / actionPrefix / source /
 *   time range / verifiedOnly / free-text query.
 * - Pagination: page clamp, totalPages, hasNext/hasPrev, pageSize cap.
 * - Export: JSON parses back to the same rows; CSV header + rows,
 *   quoting of commas/quotes in detail.
 * - Summary: counts by source/action/actor, verified vs unverified,
 *   user chain verify (ok + tampered chain detected), top actions.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v118-audit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendTeamV14UserAuditEvent,
  createTeamV14QuotaState,
} from '../packages/core/dist/fleetV14/index.js';
import {
  buildAuditV15Rows,
  exportAuditV15Csv,
  exportAuditV15Json,
  filterAuditV15Rows,
  paginateAuditV15Rows,
  summarizeAuditV15Rows,
  topAuditV15Actions,
} from '../packages/core/dist/fleetV15/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function userEvents() {
  let state = createTeamV14QuotaState('team-a', T0);
  state = appendTeamV14UserAuditEvent(state, { userId: 'u1', actorUserId: 'admin', actorRole: 'admin', action: 'user.switch', target: 'user:u1', detail: 'switched to u2' }, T0);
  state = appendTeamV14UserAuditEvent(state, { userId: 'u2', actorUserId: 'admin', actorRole: 'admin', action: 'quota.set', target: 'user:u2', detail: 'tokens 1000' }, T0 + 1000);
  state = appendTeamV14UserAuditEvent(state, { userId: 'u1', actorUserId: 'u1', actorRole: 'member', action: 'bot.run', target: 'bot:support', detail: 'ran, with comma' }, T0 + 2000);
  return state.auditEvents;
}

function fleetEvent(seq, at, action) {
  return {
    id: `audit-${seq}`,
    seq,
    at,
    actor: 'system',
    action,
    target: 'fleet:node-a',
    detail: { note: 'x' },
    prevHash: 'GENESIS',
    hash: 'a'.repeat(64),
  };
}

test('audit v15: unified rows merge + sort newest first', () => {
  const rows = buildAuditV15Rows({
    userEvents: userEvents(),
    fleetEvents: [fleetEvent(1, T0 + 1500, 'node.join')],
    userVerified: true,
    fleetVerified: false,
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].action, 'bot.run', 'newest first');
  assert.equal(rows[0].source, 'user-audit');
  assert.equal(rows[0].verified, true);
  const fleetRow = rows.find((r) => r.source === 'fleet-audit');
  assert.ok(fleetRow);
  assert.equal(fleetRow.verified, false);
  assert.equal(fleetRow.actorUserId, 'system');
  assert.equal(rows.filter((r) => r.source === 'user-audit').length, 3);
});

test('audit v15: filters (user, action, prefix, source, time, verified, query)', () => {
  const rows = buildAuditV15Rows({ userEvents: userEvents(), fleetEvents: [fleetEvent(1, T0 + 1500, 'node.join')], userVerified: true });
  assert.equal(filterAuditV15Rows(rows, { userId: 'u1' }).length, 2);
  assert.equal(filterAuditV15Rows(rows, { actorUserId: 'u1' }).length, 1);
  assert.equal(filterAuditV15Rows(rows, { action: 'quota.set' }).length, 1);
  assert.equal(filterAuditV15Rows(rows, { actionPrefix: 'user.' }).length, 1);
  assert.equal(filterAuditV15Rows(rows, { source: 'fleet-audit' }).length, 1);
  assert.equal(filterAuditV15Rows(rows, { fromMs: T0 + 1500 }).length, 2);
  assert.equal(filterAuditV15Rows(rows, { toMs: T0 + 1000 }).length, 2);
  assert.equal(filterAuditV15Rows(rows, { verifiedOnly: true }).length, 3);
  assert.equal(filterAuditV15Rows(rows, { query: 'SUPPORT' }).length, 1, 'query is case-insensitive');
  assert.equal(filterAuditV15Rows(rows, { query: 'zzz-no-match' }).length, 0);
  assert.equal(filterAuditV15Rows(rows, {}).length, 4);
});

test('audit v15: pagination (clamp, totals, next/prev)', () => {
  const rows = buildAuditV15Rows({ userEvents: userEvents() });
  const p1 = paginateAuditV15Rows(rows, 1, 2);
  assert.equal(p1.rows.length, 2);
  assert.equal(p1.totalRows, 3);
  assert.equal(p1.totalPages, 2);
  assert.equal(p1.hasNext, true);
  assert.equal(p1.hasPrev, false);
  const p2 = paginateAuditV15Rows(rows, 2, 2);
  assert.equal(p2.rows.length, 1);
  assert.equal(p2.hasNext, false);
  assert.equal(p2.hasPrev, true);
  // Out-of-range page clamps to the last page; pageSize clamps to 500.
  assert.equal(paginateAuditV15Rows(rows, 99, 2).page, 2);
  assert.equal(paginateAuditV15Rows(rows, 0, 2).page, 1);
  assert.equal(paginateAuditV15Rows(rows, 1, 9999).pageSize, 500);
  assert.equal(paginateAuditV15Rows([], 1, 50).totalPages, 1);
});

test('audit v15: export JSON + CSV round-trip', () => {
  const rows = buildAuditV15Rows({ userEvents: userEvents(), userVerified: true });
  const parsed = JSON.parse(exportAuditV15Json(rows));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].action, 'bot.run');
  const csv = exportAuditV15Csv(rows);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4, 'header + 3 rows');
  assert.equal(lines[0], 'seq,at,isoTime,source,userId,actorUserId,actorRole,action,target,detail,hash,verified');
  // Detail with a comma is quoted.
  const botLine = lines.find((l) => l.includes('bot.run'));
  assert.ok(botLine.includes('"ran, with comma"'), `detail must be CSV-quoted: ${botLine}`);
  assert.ok(botLine.includes('2026-11-16T00:00:02.000Z'));
});

test('audit v15: summary + top actions + tampered chain detected', () => {
  const events = userEvents();
  const rows = buildAuditV15Rows({ userEvents: events, userVerified: true });
  const summary = summarizeAuditV15Rows(rows, events);
  assert.equal(summary.totalRows, 3);
  assert.equal(summary.bySource['user-audit'], 3);
  assert.equal(summary.byAction['user.switch'], 1);
  assert.equal(summary.byActor.admin, 2);
  assert.equal(summary.verifiedRows, 3);
  assert.equal(summary.unverifiedRows, 0);
  assert.equal(summary.userChain.ok, true);
  assert.equal(summary.earliestAt, T0);
  assert.equal(summary.latestAt, T0 + 2000);
  assert.deepEqual(topAuditV15Actions(rows, 2).map((a) => a.count), [1, 1]);

  // Tamper with one event: verify must fail at that seq.
  const tampered = events.map((e) => (e.seq === 2 ? { ...e, detail: 'forged' } : e));
  const bad = summarizeAuditV15Rows(rows, tampered);
  assert.equal(bad.userChain.ok, false);
  assert.equal(bad.userChain.badSeq, 2);
});
