/**
 * Tenant quotas v2 tests (v1.20, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Defaults: cpu 16 cores / ram 64GB / disk 512GB / api-calls
 *   10k daily; check/consume/release for level quotas.
 * - Hard enforcement: consuming past the limit is blocked and
 *   nothing is recorded; limit 0 blocks the kind entirely.
 * - Soft enforcement: consuming past the limit is allowed with
 *   level 'soft-exceeded' and a warning reason.
 * - Warning levels: 80% watch, 90% warning, 100% critical (hard,
 *   not yet consumed past), past 100% exceeded/soft-exceeded.
 * - api-calls period quota: usage splits by day (v16 period key).
 * - Override with audit: changing limit/enforcement writes an
 *   audit entry (old/new, actor, reason); no-change and negative
 *   limit rejected; null limit restores the default; audit list
 *   filters by tenant/kind/actor/time.
 * - Summary + alerts: rows carry fraction/level/enforcement/
 *   isOverride; alerts sort worst first.
 * - Prune: daily usage older than 90 days is removed.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v120-quotas.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TENANT_V17_DEFAULT_LIMITS,
  checkTenantV17Quota,
  consumeTenantV17Quota,
  createTenantV17QuotaState,
  createTenantV17Record,
  findTenantV17Record,
  listTenantV17OverrideAudit,
  pruneTenantV17Usage,
  releaseTenantV17Quota,
  setTenantV17QuotaOverride,
  summarizeTenantV17Quota,
  tenantV17Alerts,
  tenantV17EnforcementFor,
  tenantV17LimitFor,
  tenantV17Remaining,
  tenantV17UsedAmount,
  tenantV17WarningLevel,
} from '../packages/core/dist/fleetV17/index.js';

const T0 = Date.UTC(2026, 11, 16, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function stateWithTenant(id = 'acme') {
  const state = createTenantV17QuotaState(T0);
  const res = createTenantV17Record(state, id, 'Acme Corp', T0);
  assert.equal(res.ok, true, res.reason);
  return { state, record: res.record };
}

test('tenantV17 defaults: limits and hard enforcement', () => {
  const { record } = stateWithTenant();
  assert.equal(tenantV17LimitFor(record, 'cpu-cores'), TENANT_V17_DEFAULT_LIMITS['cpu-cores']);
  assert.equal(tenantV17LimitFor(record, 'api-calls'), 10000);
  assert.equal(tenantV17EnforcementFor(record, 'cpu-cores'), 'hard');
  assert.equal(tenantV17UsedAmount(record, 'cpu-cores', T0), 0);
  assert.equal(tenantV17Remaining(record, 'cpu-cores', T0), 16);
});

test('tenantV17 consume/release level quota (cpu/ram/disk)', () => {
  const { state, record } = stateWithTenant();
  const c1 = consumeTenantV17Quota(state, 'acme', 'cpu-cores', 4, T0);
  assert.equal(c1.consumed, true);
  assert.equal(c1.allowed, true);
  assert.equal(tenantV17UsedAmount(record, 'cpu-cores', T0), 4);
  const rel = releaseTenantV17Quota(state, 'acme', 'cpu-cores', 1, T0);
  assert.equal(rel.ok, true);
  assert.equal(tenantV17UsedAmount(record, 'cpu-cores', T0), 3);
  // Release more than used clamps at 0.
  const rel2 = releaseTenantV17Quota(state, 'acme', 'cpu-cores', 99, T0);
  assert.equal(rel2.ok, true);
  assert.equal(tenantV17UsedAmount(record, 'cpu-cores', T0), 0);
});

test('tenantV17 hard enforcement blocks past-limit consume', () => {
  const { state, record } = stateWithTenant();
  const blocked = consumeTenantV17Quota(state, 'acme', 'cpu-cores', 17, T0);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.consumed, false);
  assert.equal(blocked.level, 'exceeded');
  assert.equal(tenantV17UsedAmount(record, 'cpu-cores', T0), 0);
  // Exactly at the limit is allowed.
  const exact = consumeTenantV17Quota(state, 'acme', 'cpu-cores', 16, T0);
  assert.equal(exact.allowed, true);
  assert.equal(exact.level, 'critical');
});

test('tenantV17 soft enforcement allows overage with warning', () => {
  const { state } = stateWithTenant();
  const over = setTenantV17QuotaOverride(
    state, 'acme', 'cpu-cores',
    { newEnforcement: 'soft', actorUserId: 'u_admin', reason: 'migration week' }, T0,
  );
  assert.equal(over.ok, true);
  assert.equal(over.audit.oldEnforcement, null);
  assert.equal(over.audit.newEnforcement, 'soft');
  const c = consumeTenantV17Quota(state, 'acme', 'cpu-cores', 20, T0);
  assert.equal(c.allowed, true);
  assert.equal(c.consumed, true);
  assert.equal(c.level, 'soft-exceeded');
  assert.match(c.reason, /mềm/);
});

test('tenantV17 limit 0 blocks the kind entirely', () => {
  const { state } = stateWithTenant();
  const over = setTenantV17QuotaOverride(
    state, 'acme', 'disk-mb',
    { newLimit: 0, actorUserId: 'u_admin', reason: 'disk freeze' }, T0,
  );
  assert.equal(over.ok, true);
  const c = consumeTenantV17Quota(state, 'acme', 'disk-mb', 1, T0);
  assert.equal(c.allowed, false);
  assert.match(c.reason, /tắt/);
});

test('tenantV17 warning levels follow fraction thresholds', () => {
  assert.equal(tenantV17WarningLevel(0, 'hard'), 'none');
  assert.equal(tenantV17WarningLevel(0.8, 'hard'), 'watch');
  assert.equal(tenantV17WarningLevel(0.9, 'hard'), 'warning');
  assert.equal(tenantV17WarningLevel(0.99, 'hard'), 'warning');
  assert.equal(tenantV17WarningLevel(1, 'hard'), 'critical');
  assert.equal(tenantV17WarningLevel(1.2, 'hard'), 'exceeded');
  assert.equal(tenantV17WarningLevel(1.2, 'soft'), 'soft-exceeded');
  assert.equal(tenantV17WarningLevel(0.99, 'soft'), 'warning');
  const { state } = stateWithTenant();
  const check = checkTenantV17Quota(findTenantV17Record(state, 'acme'), 'ram-mb', 0.8 * 65536, T0);
  assert.equal(check.level, 'watch');
  assert.equal(check.allowed, true);
});

test('tenantV17 api-calls quota splits by day', () => {
  const { state, record } = stateWithTenant();
  const c1 = consumeTenantV17Quota(state, 'acme', 'api-calls', 9999, T0);
  assert.equal(c1.consumed, true);
  const c2 = consumeTenantV17Quota(state, 'acme', 'api-calls', 2, T0);
  assert.equal(c2.allowed, false);
  // Next day the period resets.
  const c3 = consumeTenantV17Quota(state, 'acme', 'api-calls', 5, T0 + DAY);
  assert.equal(c3.allowed, true);
  assert.equal(tenantV17UsedAmount(record, 'api-calls', T0 + DAY), 5);
  assert.equal(tenantV17UsedAmount(record, 'api-calls', T0), 9999);
});

test('tenantV17 override audit: entries, no-change, validation, restore default', () => {
  const { state } = stateWithTenant();
  const bad = setTenantV17QuotaOverride(
    state, 'acme', 'ram-mb',
    { newLimit: -5, actorUserId: 'u_admin', reason: 'x' }, T0,
  );
  assert.equal(bad.ok, false);
  const noReason = setTenantV17QuotaOverride(
    state, 'acme', 'ram-mb',
    { newLimit: 1000, actorUserId: 'u_admin', reason: '' }, T0,
  );
  assert.equal(noReason.ok, false);
  const first = setTenantV17QuotaOverride(
    state, 'acme', 'ram-mb',
    { newLimit: 32768, actorUserId: 'u_admin', reason: 'downgrade' }, T0,
  );
  assert.equal(first.ok, true);
  assert.equal(first.audit.seq, 1);
  assert.equal(first.audit.oldLimit, null);
  assert.equal(first.audit.newLimit, 32768);
  const same = setTenantV17QuotaOverride(
    state, 'acme', 'ram-mb',
    { newLimit: 32768, actorUserId: 'u_admin', reason: 'again' }, T0,
  );
  assert.equal(same.ok, false);
  // Restore default with null.
  const restore = setTenantV17QuotaOverride(
    state, 'acme', 'ram-mb',
    { newLimit: null, actorUserId: 'u_admin', reason: 'back to default' }, T0 + 1000,
  );
  assert.equal(restore.ok, true);
  assert.equal(restore.audit.newLimit, null);
  assert.equal(tenantV17LimitFor(findTenantV17Record(state, 'acme'), 'ram-mb'), 65536);
  // Audit filters.
  assert.equal(listTenantV17OverrideAudit(state, {}).length, 2);
  assert.equal(listTenantV17OverrideAudit(state, { kind: 'cpu-cores' }).length, 0);
  assert.equal(listTenantV17OverrideAudit(state, { actorUserId: 'u_admin' }).length, 2);
  assert.equal(listTenantV17OverrideAudit(state, { fromAt: T0 + 500 }).length, 1);
  assert.equal(listTenantV17OverrideAudit(state, { tenantId: 'other' }).length, 0);
});

test('tenantV17 summary and alerts sort worst first', () => {
  const { state } = stateWithTenant('acme');
  createTenantV17Record(state, 'beta', 'Beta LLC', T0);
  consumeTenantV17Quota(state, 'acme', 'cpu-cores', 16, T0);
  consumeTenantV17Quota(state, 'beta', 'cpu-cores', 13, T0);
  const rows = summarizeTenantV17Quota(findTenantV17Record(state, 'acme'), T0);
  assert.equal(rows.length, 4);
  const cpu = rows.find((r) => r.kind === 'cpu-cores');
  assert.equal(cpu.fraction, 1);
  assert.equal(cpu.level, 'critical');
  assert.equal(cpu.isOverride, false);
  const alerts = tenantV17Alerts(state, T0);
  assert.ok(alerts.length >= 2);
  assert.equal(alerts[0].tenantId, 'acme');
  assert.ok(alerts[0].fraction >= alerts[1].fraction);
  assert.match(alerts[0].message, /acme/);
});

test('tenantV17 create duplicate tenant rejected, unknown tenant consume fails', () => {
  const { state } = stateWithTenant();
  const dup = createTenantV17Record(state, 'acme', 'Again', T0);
  assert.equal(dup.ok, false);
  const bad = createTenantV17Record(state, 'bad id!', 'Bad', T0);
  assert.equal(bad.ok, false);
  const c = consumeTenantV17Quota(state, 'ghost', 'cpu-cores', 1, T0);
  assert.equal(c.allowed, false);
  assert.match(c.reason, /chưa tồn tại/);
});

test('tenantV17 prune removes daily usage older than 90 days', () => {
  const { state, record } = stateWithTenant();
  consumeTenantV17Quota(state, 'acme', 'api-calls', 10, T0);
  consumeTenantV17Quota(state, 'acme', 'api-calls', 5, T0 + 100 * DAY);
  const removed = pruneTenantV17Usage(state, T0 + 100 * DAY);
  assert.equal(removed, 1);
  const keys = Object.keys(record.apiCallsUsage);
  assert.equal(keys.length, 1);
  assert.equal(record.apiCallsUsage[keys[0]], 5);
});
