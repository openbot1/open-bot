/**
 * Tenant quotas v16 tests (v1.19, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Defaults: limits + periods per kind, period vs level kinds.
 * - Warning levels from fraction (watch 0.8, warning 0.9, critical
 *   1.0, exceeded > 1).
 * - Period keys (daily YYYY-MM-DD, weekly YYYY-Www, monthly
 *   YYYY-MM) + period start / next start.
 * - Tenant records: create (duplicate / bad id rejected), quota
 *   override, period override.
 * - Consume: period quotas accumulate per period key (new period =
 *   fresh budget), level quotas accumulate until released, over
 *   limit rejected with remaining + reset time, amount <= 0
 *   rejected, unknown tenant rejected.
 * - Release: level quotas only (period release rejected), never
 *   below zero.
 * - Summary rows, alerts sorted by severity, prune of old daily
 *   usage, save/load round-trip.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v119-quotas.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TENANT_V16_DEFAULT_LIMITS,
  TENANT_V16_DEFAULT_PERIODS,
  createTenantV16QuotaState,
  createTenantV16Record,
  consumeTenantV16Quota,
  findTenantV16Record,
  isTenantV16PeriodQuota,
  loadTenantV16QuotaState,
  pruneTenantV16Usage,
  releaseTenantV16Quota,
  saveTenantV16QuotaState,
  setTenantV16QuotaOverride,
  setTenantV16QuotaPeriod,
  summarizeTenantV16Quota,
  tenantV16Alerts,
  tenantV16LimitFor,
  tenantV16NextPeriodStartMs,
  tenantV16PeriodFor,
  tenantV16PeriodKey,
  tenantV16PeriodStartMs,
  tenantV16Remaining,
  tenantV16UsedAmount,
  tenantV16WarningLevel,
} from '../packages/core/dist/fleetV16/index.js';

const T0 = Date.UTC(2026, 10, 16, 10, 30, 0); // Monday 2026-11-16
const DAY = 24 * 60 * 60 * 1000;

function stateWithTenant(id = 't1') {
  let state = createTenantV16QuotaState(T0);
  const res = createTenantV16Record(state, { tenantId: id, displayName: 'Tenant One' }, T0);
  assert.equal(res.ok, true, res.error);
  return res.state;
}

test('tenant quotas v16: defaults + kinds', () => {
  assert.equal(TENANT_V16_DEFAULT_LIMITS['model-calls'], 10000);
  assert.equal(TENANT_V16_DEFAULT_LIMITS['model-tokens'], 10_000_000);
  assert.equal(TENANT_V16_DEFAULT_LIMITS.bots, 50);
  assert.equal(TENANT_V16_DEFAULT_PERIODS['model-calls'], 'daily');
  assert.equal(TENANT_V16_DEFAULT_PERIODS['model-tokens'], 'monthly');
  assert.equal(isTenantV16PeriodQuota('model-calls'), true);
  assert.equal(isTenantV16PeriodQuota('model-tokens'), true);
  assert.equal(isTenantV16PeriodQuota('tool-calls'), true);
  assert.equal(isTenantV16PeriodQuota('storage-bytes'), false);
  assert.equal(isTenantV16PeriodQuota('bots'), false);
  assert.equal(tenantV16WarningLevel(0), 'none');
  assert.equal(tenantV16WarningLevel(0.79), 'none');
  assert.equal(tenantV16WarningLevel(0.8), 'watch');
  assert.equal(tenantV16WarningLevel(0.9), 'warning');
  assert.equal(tenantV16WarningLevel(1), 'critical');
  assert.equal(tenantV16WarningLevel(1.01), 'exceeded');
});

test('tenant quotas v16: period keys + boundaries', () => {
  assert.equal(tenantV16PeriodKey('daily', T0), '2026-11-16');
  assert.equal(tenantV16PeriodKey('monthly', T0), '2026-11');
  assert.equal(tenantV16PeriodKey('weekly', T0), '2026-W46');
  assert.equal(tenantV16PeriodStartMs('daily', T0), Date.UTC(2026, 10, 16));
  assert.equal(tenantV16NextPeriodStartMs('daily', T0), Date.UTC(2026, 10, 17));
  assert.equal(tenantV16NextPeriodStartMs('monthly', T0), Date.UTC(2026, 11, 1));
  assert.equal(tenantV16NextPeriodStartMs('weekly', T0), tenantV16PeriodStartMs('weekly', T0) + 7 * DAY);
});

test('tenant quotas v16: create tenant + overrides', () => {
  let state = stateWithTenant();
  assert.equal(createTenantV16Record(state, { tenantId: 't1', displayName: 'Dup' }, T0).ok, false);
  assert.equal(createTenantV16Record(state, { tenantId: 'Bad Id', displayName: 'X' }, T0).ok, false);
  assert.equal(createTenantV16Record(state, { tenantId: 't2', displayName: '' }, T0).ok, false);
  const rec = findTenantV16Record(state, 't1');
  assert.equal(tenantV16LimitFor(rec, 'model-calls'), 10000);
  assert.equal(tenantV16PeriodFor(rec, 'model-calls'), 'daily');
  const over = setTenantV16QuotaOverride(state, { tenantId: 't1', kind: 'model-calls', limit: 100 }, T0);
  assert.equal(over.ok, true, over.error);
  assert.equal(tenantV16LimitFor(findTenantV16Record(over.state, 't1'), 'model-calls'), 100);
  assert.equal(setTenantV16QuotaOverride(state, { tenantId: 'ghost', kind: 'bots', limit: 1 }, T0).ok, false);
  assert.equal(setTenantV16QuotaOverride(state, { tenantId: 't1', kind: 'bots', limit: -5 }, T0).ok, false);
  const per = setTenantV16QuotaPeriod(over.state, { tenantId: 't1', kind: 'model-calls', period: 'weekly' }, T0);
  assert.equal(per.ok, true, per.error);
  assert.equal(tenantV16PeriodFor(findTenantV16Record(per.state, 't1'), 'model-calls'), 'weekly');
  // Null override restores the default.
  const back = setTenantV16QuotaOverride(per.state, { tenantId: 't1', kind: 'model-calls', limit: null }, T0);
  assert.equal(tenantV16LimitFor(findTenantV16Record(back.state, 't1'), 'model-calls'), 10000);
});

test('tenant quotas v16: consume period quota (reset each period)', () => {
  let state = stateWithTenant();
  const c1 = consumeTenantV16Quota(state, { tenantId: 't1', kind: 'model-calls', amount: 9000 }, T0);
  assert.equal(c1.ok, true, c1.error);
  assert.equal(c1.remaining, 1000);
  assert.equal(c1.warning, 'warning');
  assert.equal(c1.resetAtMs, Date.UTC(2026, 10, 17));
  state = c1.state;
  // 9000 + 2000 > 10000 → rejected, state unchanged.
  const over = consumeTenantV16Quota(state, { tenantId: 't1', kind: 'model-calls', amount: 2000 }, T0);
  assert.equal(over.ok, false);
  assert.equal(over.remaining, 1000);
  assert.match(over.error, /vượt quota/);
  assert.equal(tenantV16UsedAmount(findTenantV16Record(over.state, 't1'), 'model-calls', T0), 9000);
  // Next day: fresh budget.
  const nextDay = consumeTenantV16Quota(state, { tenantId: 't1', kind: 'model-calls', amount: 5000 }, T0 + DAY);
  assert.equal(nextDay.ok, true, nextDay.error);
  assert.equal(nextDay.remaining, 5000);
  // Bad inputs.
  assert.equal(consumeTenantV16Quota(state, { tenantId: 't1', kind: 'model-calls', amount: 0 }, T0).ok, false);
  assert.equal(consumeTenantV16Quota(state, { tenantId: 'ghost', kind: 'model-calls', amount: 1 }, T0).ok, false);
});

test('tenant quotas v16: consume + release level quota', () => {
  let state = stateWithTenant();
  const c1 = consumeTenantV16Quota(state, { tenantId: 't1', kind: 'bots', amount: 40 }, T0);
  assert.equal(c1.ok, true, c1.error);
  assert.equal(c1.remaining, 10);
  assert.equal(c1.warning, 'watch');
  assert.equal(c1.resetAtMs, 0, 'level quota has no reset time');
  state = c1.state;
  assert.equal(consumeTenantV16Quota(state, { tenantId: 't1', kind: 'bots', amount: 11 }, T0).ok, false);
  const rel = releaseTenantV16Quota(state, { tenantId: 't1', kind: 'bots', amount: 15 }, T0);
  assert.equal(rel.ok, true, rel.error);
  assert.equal(tenantV16UsedAmount(findTenantV16Record(rel.state, 't1'), 'bots', T0), 25);
  // Release more than used → clamps at 0, never negative.
  const relAll = releaseTenantV16Quota(rel.state, { tenantId: 't1', kind: 'bots', amount: 100 }, T0);
  assert.equal(relAll.ok, true, relAll.error);
  assert.equal(tenantV16UsedAmount(findTenantV16Record(relAll.state, 't1'), 'bots', T0), 0);
  // Period quota cannot be released.
  assert.equal(releaseTenantV16Quota(state, { tenantId: 't1', kind: 'model-calls', amount: 1 }, T0).ok, false);
  assert.equal(releaseTenantV16Quota(state, { tenantId: 'ghost', kind: 'bots', amount: 1 }, T0).ok, false);
  assert.equal(tenantV16Remaining(findTenantV16Record(relAll.state, 't1'), 'bots', T0), 50);
});

test('tenant quotas v16: summary rows + alerts + prune', () => {
  let state = stateWithTenant();
  state = consumeTenantV16Quota(state, { tenantId: 't1', kind: 'model-calls', amount: 10000 }, T0).state;
  state = consumeTenantV16Quota(state, { tenantId: 't1', kind: 'bots', amount: 45 }, T0).state;
  const rows = summarizeTenantV16Quota(findTenantV16Record(state, 't1'), T0);
  assert.equal(rows.length, 5);
  const calls = rows.find((r) => r.kind === 'model-calls');
  assert.equal(calls.used, 10000);
  assert.equal(calls.limit, 10000);
  assert.equal(calls.warning, 'critical');
  assert.equal(calls.period, 'daily');
  assert.equal(calls.resetAtMs, Date.UTC(2026, 10, 17));
  const bots = rows.find((r) => r.kind === 'bots');
  assert.equal(bots.warning, 'warning');
  assert.equal(bots.period, null);
  const alerts = tenantV16Alerts(state, 'warning', T0);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].warning, 'critical', 'worst first');
  assert.equal(tenantV16Alerts(state, 'critical', T0).length, 1);
  assert.equal(tenantV16Alerts(state, 'exceeded', T0).length, 0);
  // Prune drops daily usage older than retention; current usage survives.
  const old = consumeTenantV16Quota(state, { tenantId: 't1', kind: 'model-calls', amount: 10 }, T0 - 100 * DAY);
  const pruned = pruneTenantV16Usage(old.state, 90, T0);
  const kept = tenantV16UsedAmount(findTenantV16Record(pruned, 't1'), 'model-calls', T0);
  assert.equal(kept, 10000, 'old period key pruned, current kept');
});

test('tenant quotas v16: save/load round-trip', () => {
  let state = stateWithTenant();
  state = consumeTenantV16Quota(state, { tenantId: 't1', kind: 'bots', amount: 3 }, T0).state;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-v16-'));
  try {
    saveTenantV16QuotaState(dir, state);
    const loaded = loadTenantV16QuotaState(dir);
    assert.ok(loaded);
    assert.equal(loaded.tenants.length, 1);
    assert.equal(tenantV16UsedAmount(loaded.tenants[0], 'bots', T0), 3);
    assert.equal(loadTenantV16QuotaState(path.join(dir, 'missing')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
