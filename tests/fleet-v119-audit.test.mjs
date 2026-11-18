/**
 * Audit log v2 tests (v1.19, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Severity mapping (longest prefix wins, default info) + row
 *   conversion.
 * - Advanced search: AND terms, field:term, quoted phrases,
 *   case-insensitive, empty query matches all.
 * - Filter v2: severity list + v15 fields combined with query.
 * - Presets: add (duplicate name / too many / invalid rejected),
 *   remove (missing → error).
 * - Cursor pagination: page walk is stable and complete, invalid
 *   cursor → first page, page size clamped, nextCursor null at end.
 * - Export: NDJSON round-trip, CSV with column subset + quoting.
 * - Summary: counts by severity/source, top actors/actions, hourly
 *   buckets, criticalRows.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v119-audit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_V16_CSV_COLUMNS,
  addAuditV16Preset,
  auditV16CursorFor,
  auditV16ParseCursor,
  auditV16RowMatchesQuery,
  auditV16SeverityOf,
  exportAuditV16Csv,
  exportAuditV16Ndjson,
  filterAuditV16Rows,
  paginateAuditV16Rows,
  parseAuditV16Query,
  removeAuditV16Preset,
  summarizeAuditV16Rows,
  toAuditV16Rows,
  validateAuditV16Preset,
} from '../packages/core/dist/fleetV16/index.js';

const T0 = Date.UTC(2026, 10, 16, 10, 0, 0);

function row(over = {}) {
  return {
    seq: 1, at: T0, source: 'team-audit', userId: 'u1', actorUserId: 'alice',
    actorRole: 'admin', action: 'user.create', target: 'bob', detail: 'role=member',
    hash: 'h1', verified: true, ...over,
  };
}

const ROWS = toAuditV16Rows([
  row({ seq: 1, at: T0, action: 'user.create', actorUserId: 'alice', target: 'bob' }),
  row({ seq: 2, at: T0 + 1000, action: 'user.suspend', actorUserId: 'alice', target: 'carol', source: 'user-audit' }),
  row({ seq: 3, at: T0 + 2000, action: 'user.deactivate', actorUserId: 'bob', target: 'carol', detail: 'policy breach' }),
  row({ seq: 4, at: T0 + 3000, action: 'rollout.rollback', actorUserId: 'alice', target: 'bot-1', source: 'fleet-audit' }),
  row({ seq: 5, at: T0 + 4000, action: 'fleet.node-drain', actorUserId: 'ops', target: 'node-7', source: 'fleet-audit' }),
  row({ seq: 6, at: T0 + 5000, action: 'user.create', actorUserId: 'bob', target: 'bot alpha', detail: 'bot alpha created' }),
]);
// Newest-first order (as buildAuditV15Rows returns).
const NEWEST_FIRST = [...ROWS].reverse();

test('audit v16: severity mapping (longest prefix wins)', () => {
  assert.equal(auditV16SeverityOf('user.create'), 'info');
  assert.equal(auditV16SeverityOf('user.suspend'), 'warning');
  assert.equal(auditV16SeverityOf('user.deactivate'), 'critical');
  assert.equal(auditV16SeverityOf('user.change-role'), 'critical');
  assert.equal(auditV16SeverityOf('role.create'), 'warning');
  assert.equal(auditV16SeverityOf('role.remove'), 'critical');
  assert.equal(auditV16SeverityOf('rollout.rollback'), 'critical');
  assert.equal(auditV16SeverityOf('rollout.pause'), 'warning');
  assert.equal(auditV16SeverityOf('auth.locked'), 'critical');
  assert.equal(auditV16SeverityOf('auth.failed'), 'warning');
  assert.equal(auditV16SeverityOf('something.else'), 'info');
  assert.equal(auditV16SeverityOf(''), 'info');
  assert.equal(ROWS[0].severity, 'info');
  assert.equal(ROWS[1].severity, 'warning');
  assert.equal(ROWS[2].severity, 'critical');
  assert.equal(toAuditV16Rows([]).length, 0);
});

test('audit v16: advanced search query', () => {
  assert.deepEqual(parseAuditV16Query(''), []);
  assert.deepEqual(parseAuditV16Query('actor:alice user.create'), [
    { field: 'actor', term: 'alice' },
    { field: '', term: 'user.create' },
  ]);
  assert.deepEqual(parseAuditV16Query('"bot alpha"'), [{ field: '', term: 'bot alpha' }]);
  assert.deepEqual(parseAuditV16Query('unknown:xyz'), [{ field: '', term: 'unknown:xyz' }]);
  assert.deepEqual(parseAuditV16Query('actor:'), []);
  const r = ROWS[5]; // bob created 'bot alpha'
  assert.equal(auditV16RowMatchesQuery(r, ''), true);
  assert.equal(auditV16RowMatchesQuery(r, 'bot alpha'), true);
  assert.equal(auditV16RowMatchesQuery(r, '"bot alpha"'), true);
  assert.equal(auditV16RowMatchesQuery(r, 'BOT ALPHA'), true, 'case-insensitive');
  assert.equal(auditV16RowMatchesQuery(r, 'actor:bob'), true);
  assert.equal(auditV16RowMatchesQuery(r, 'actor:alice'), false);
  assert.equal(auditV16RowMatchesQuery(r, 'bot alpha carol'), false, 'AND: all terms must match');
  assert.equal(auditV16RowMatchesQuery(r, 'action:user.create target:bot'), true);
  assert.equal(auditV16RowMatchesQuery(r, 'source:fleet-audit'), false);
  assert.equal(auditV16RowMatchesQuery(ROWS[3], 'source:fleet-audit'), true);
});

test('audit v16: filter v2 (severity + v15 fields + query)', () => {
  assert.equal(filterAuditV16Rows(ROWS, {}).length, 6);
  assert.equal(filterAuditV16Rows(ROWS, { severities: ['critical'] }).length, 2);
  assert.equal(filterAuditV16Rows(ROWS, { severities: ['warning', 'critical'] }).length, 4);
  assert.equal(filterAuditV16Rows(ROWS, { actorUserId: 'alice' }).length, 3);
  assert.equal(filterAuditV16Rows(ROWS, { actionPrefix: 'user.' }).length, 4);
  assert.equal(filterAuditV16Rows(ROWS, { source: 'fleet-audit' }).length, 2);
  assert.equal(filterAuditV16Rows(ROWS, { fromMs: T0 + 2000, toMs: T0 + 3000 }).length, 2);
  assert.equal(filterAuditV16Rows(ROWS, { verifiedOnly: true }).length, 6);
  assert.equal(filterAuditV16Rows(ROWS, { query: 'actor:alice' }).length, 3);
  assert.equal(filterAuditV16Rows(ROWS, { query: 'carol', severities: ['critical'] }).length, 1);
});

test('audit v16: presets', () => {
  assert.equal(validateAuditV16Preset({ name: '', filter: {} }), 'tên preset không được rỗng và tối đa 60 ký tự');
  assert.match(validateAuditV16Preset({ name: 'x', filter: { severities: ['bogus'] } }), /mức độ không hợp lệ/);
  assert.match(validateAuditV16Preset({ name: 'x', filter: { fromMs: 5, toMs: 1 } }), /fromMs phải <= toMs/);
  const added = addAuditV16Preset([], { name: ' Critical ', filter: { severities: ['critical'] } }, T0);
  assert.equal(added.ok, true, added.error);
  assert.equal(added.presets[0].name, 'Critical', 'name trimmed');
  assert.equal(added.presets[0].createdAt, T0);
  assert.equal(addAuditV16Preset(added.presets, { name: 'Critical', filter: {} }, T0).ok, false, 'duplicate name');
  const removed = removeAuditV16Preset(added.presets, 'Critical');
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.presets.length, 0);
  assert.equal(removeAuditV16Preset([], 'nope').ok, false);
  // Cap at 20.
  let presets = [];
  for (let i = 0; i < 20; i++) {
    const r = addAuditV16Preset(presets, { name: `p${i}`, filter: {} }, T0);
    assert.equal(r.ok, true, r.error);
    presets = r.presets;
  }
  assert.equal(addAuditV16Preset(presets, { name: 'p20', filter: {} }, T0).ok, false);
});

test('audit v16: cursor pagination (stable walk, invalid cursor, clamping)', () => {
  const page1 = paginateAuditV16Rows(NEWEST_FIRST, null, 2);
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.rows[0].seq, 6);
  assert.equal(page1.rows[1].seq, 5);
  assert.equal(page1.totalRows, 6);
  assert.ok(page1.nextCursor);
  const page2 = paginateAuditV16Rows(NEWEST_FIRST, page1.nextCursor, 2);
  assert.deepEqual(page2.rows.map((r) => r.seq), [4, 3]);
  const page3 = paginateAuditV16Rows(NEWEST_FIRST, page2.nextCursor, 2);
  assert.deepEqual(page3.rows.map((r) => r.seq), [2, 1]);
  assert.equal(page3.nextCursor, null, 'last page has no cursor');
  // Full walk with page size 1 visits every row exactly once.
  let cursor = null;
  const seen = [];
  for (let i = 0; i < 10 && (i === 0 || cursor); i++) {
    const p = paginateAuditV16Rows(NEWEST_FIRST, cursor, 1);
    seen.push(...p.rows.map((r) => r.seq));
    cursor = p.nextCursor;
  }
  assert.deepEqual(seen, [6, 5, 4, 3, 2, 1]);
  // Invalid cursor → first page; oversized page clamped to 500.
  assert.equal(paginateAuditV16Rows(NEWEST_FIRST, 'garbage', 2).rows[0].seq, 6);
  assert.equal(paginateAuditV16Rows(NEWEST_FIRST, null, 10000).rows.length, 6);
  assert.equal(paginateAuditV16Rows([], null, 10).nextCursor, null);
  // Cursor round-trip.
  const c = auditV16CursorFor(ROWS[0]);
  assert.equal(c, `${T0}:1:team-audit`);
  assert.deepEqual(auditV16ParseCursor(c), { at: T0, seq: 1, source: 'team-audit' });
  assert.equal(auditV16ParseCursor('x'), null);
  assert.equal(auditV16ParseCursor('1:2'), null);
});

test('audit v16: export NDJSON + CSV column subset', () => {
  assert.equal(exportAuditV16Ndjson([]), '');
  const nd = exportAuditV16Ndjson(ROWS.slice(0, 2));
  const lines = nd.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).action, 'user.create');
  assert.equal(JSON.parse(lines[1]).severity, 'warning');
  assert.ok(AUDIT_V16_CSV_COLUMNS.includes('isoTime'));
  assert.ok(AUDIT_V16_CSV_COLUMNS.includes('severity'));
  const csv = exportAuditV16Csv(ROWS.slice(0, 1), ['seq', 'severity', 'action']);
  assert.equal(csv, 'seq,severity,action\n1,info,user.create\n');
  const full = exportAuditV16Csv(ROWS.slice(0, 1));
  assert.ok(full.startsWith('seq,at,isoTime,source,severity,userId,actorUserId,actorRole,action,target,detail,hash,verified\n'));
  // Quoting: detail with comma + quote is escaped.
  const tricky = row({ seq: 9, detail: 'a,"b"' });
  const csv2 = exportAuditV16Csv(toAuditV16Rows([tricky]), ['detail']);
  assert.equal(csv2, 'detail\n"a,""b"""\n');
});

test('audit v16: summary', () => {
  const s = summarizeAuditV16Rows(ROWS);
  assert.equal(s.totalRows, 6);
  assert.deepEqual(s.bySeverity, { info: 2, warning: 2, critical: 2 });
  assert.equal(s.criticalRows, 2);
  assert.deepEqual(s.bySource, { 'team-audit': 3, 'user-audit': 1, 'fleet-audit': 2 });
  assert.deepEqual(s.topActors[0], { actorUserId: 'alice', count: 3 });
  assert.deepEqual(s.topActions[0], { action: 'user.create', count: 2 });
  assert.equal(s.hourly.length, 1);
  assert.equal(s.hourly[0].count, 6);
  assert.equal(summarizeAuditV16Rows([]).totalRows, 0);
  assert.deepEqual(summarizeAuditV16Rows([], 0).topActors, []);
});
