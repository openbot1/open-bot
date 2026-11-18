/**
 * Admin panels v2 tests (v1.19, Đội T6 — node:test, no network).
 *
 * Covers:
 * - User panel: rows sorted by userId, feature/session columns,
 *   counts by status/role, recent admin actions.
 * - Tenant quota panel: rows sorted, worst warning per tenant,
 *   alert/critical counts.
 * - System config: 12 default rows in 4 groups, validate (number
 *   range + int, enum options, boolean strings, string length),
 *   apply (unknown key / out-of-range rejected, rows unchanged),
 *   grouping.
 * - Gateway panel: limits from config, route overrides sorted,
 *   rollout/flag counts incl. killed flags.
 * - Audit panel: rows + summary passthrough.
 * - Admin panel: composes all sub-panels, summary string mentions
 *   users/tenants/nodes/rollouts/critical rows.
 * - Fleet panel: node rows (incl. real weight from snapshot, not
 *   hardcoded), rollout rows, summary text.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v119-panels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFleetV14Snapshot,
  heartbeatFleetV14Node,
  registerFleetV14Node,
} from '../packages/core/dist/fleetV14/index.js';
import {
  FLEET_V16_CONFIG_GROUPS,
  applyFleetV16Config,
  buildFleetV16AdminPanel,
  buildFleetV16AuditPanel,
  buildFleetV16GatewayPanel,
  buildFleetV16Panel,
  buildFleetV16TenantQuotaPanel,
  buildFleetV16UserPanel,
  consumeTenantV16Quota,
  createTeamV16Rollout,
  createTeamV16State,
  createTeamV16User,
  createTenantV16QuotaState,
  createTenantV16Record,
  defaultFleetV16ConfigRows,
  defaultGatewayV16Config,
  fleetV16ConfigRowsByGroup,
  paginateAuditV16Rows,
  startTeamV16Canary,
  toAuditV16Rows,
  validateFleetV16ConfigValue,
} from '../packages/core/dist/fleetV16/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function teamState() {
  let state = createTeamV16State(T0);
  state = createTeamV16User(state, { userId: 'owner1', displayName: 'Owner', roleRef: 'owner', actorUserId: 'owner1' }, T0).state;
  state = createTeamV16User(state, { userId: 'mem1', displayName: 'Mem', roleRef: 'member', actorUserId: 'owner1' }, T0).state;
  state = createTeamV16User(state, { userId: 'view1', displayName: 'View', roleRef: 'viewer', actorUserId: 'owner1' }, T0).state;
  return state;
}

function quotaState() {
  let state = createTenantV16QuotaState(T0);
  state = createTenantV16Record(state, { tenantId: 't1', displayName: 'T1' }, T0).state;
  state = consumeTenantV16Quota(state, { tenantId: 't1', kind: 'bots', amount: 45 }, T0).state;
  return state;
}

function fleetSnapshot() {
  let snap = createFleetV14Snapshot(T0);
  const cap = { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 0, diskTotalMb: 500_000, maxTasks: 4 };
  snap = registerFleetV14Node(snap, { nodeId: 'node-b', hostname: 'b.local', fingerprint: 'fp-b', labels: {}, capacity: cap }, 'admin', T0).snapshot;
  snap = registerFleetV14Node(snap, { nodeId: 'node-a', hostname: 'a.local', fingerprint: 'fp-a', labels: {}, capacity: cap }, 'admin', T0).snapshot;
  snap = heartbeatFleetV14Node(snap, 'node-a', T0);
  snap = heartbeatFleetV14Node(snap, 'node-b', T0);
  return { ...snap, v16Weights: { 'node-a': 25, 'node-b': 100 } };
}

function auditRows() {
  return toAuditV16Rows([
    { seq: 1, at: T0, source: 'team-audit', userId: 'u1', actorUserId: 'alice', actorRole: 'admin', action: 'user.create', target: 'bob', detail: '', hash: 'h1', verified: true },
    { seq: 2, at: T0 + 1000, source: 'team-audit', userId: 'u1', actorUserId: 'alice', actorRole: 'admin', action: 'user.deactivate', target: 'carol', detail: '', hash: 'h2', verified: true },
  ]);
}

test('panels v16: user panel', () => {
  const state = teamState();
  const panel = buildFleetV16UserPanel(state, state.users);
  assert.equal(panel.totalUsers, 3);
  assert.deepEqual(panel.rows.map((r) => r.userId), ['mem1', 'owner1', 'view1'], 'sorted by userId');
  assert.deepEqual(panel.byStatus, { active: 3, invited: 0, suspended: 0, deactivated: 0 });
  assert.equal(panel.byRole.owner, 1);
  const owner = panel.rows.find((r) => r.userId === 'owner1');
  assert.equal(owner.maxSessions, 10);
  assert.ok(owner.features.includes('admin'));
  const viewer = panel.rows.find((r) => r.userId === 'view1');
  assert.equal(viewer.maxSessions, 2);
  assert.deepEqual(viewer.features, ['chat', 'memory']);
  assert.equal(panel.recentAdminActions.length, 3);
});

test('panels v16: tenant quota panel', () => {
  const panel = buildFleetV16TenantQuotaPanel(quotaState(), T0);
  assert.equal(panel.rows.length, 1);
  assert.equal(panel.rows[0].tenantId, 't1');
  assert.equal(panel.rows[0].quotas.length, 5);
  assert.equal(panel.rows[0].worstWarning, 'warning', 'bots 45/50 = 0.9 → warning');
  assert.equal(panel.alertCount, 1);
  assert.equal(panel.criticalCount, 0);
  assert.equal(panel.alerts[0].kind, 'bots');
  assert.equal(buildFleetV16TenantQuotaPanel(createTenantV16QuotaState(T0), T0).rows.length, 0);
});

test('panels v16: system config rows (validate + apply + grouping)', () => {
  const rows = defaultFleetV16ConfigRows();
  assert.equal(rows.length, 12);
  assert.deepEqual([...FLEET_V16_CONFIG_GROUPS], ['gateway', 'quotas', 'fleet', 'rollout']);
  const grouped = fleetV16ConfigRowsByGroup(rows);
  assert.equal(grouped.gateway.length, 4);
  assert.equal(grouped.quotas.length, 3);
  assert.equal(grouped.fleet.length, 3);
  assert.equal(grouped.rollout.length, 2);
  const num = rows.find((r) => r.key === 'gateway.userMaxPerMinute');
  assert.deepEqual(validateFleetV16ConfigValue(num, 120), { ok: true, value: 120, error: '' });
  assert.deepEqual(validateFleetV16ConfigValue(num, '120'), { ok: true, value: 120, error: '' });
  assert.equal(validateFleetV16ConfigValue(num, 0).ok, false, 'below min');
  assert.equal(validateFleetV16ConfigValue(num, 10001).ok, false, 'above max');
  assert.equal(validateFleetV16ConfigValue(num, 1.5).ok, false, 'not an integer');
  const en = rows.find((r) => r.key === 'fleet.defaultDistributeStrategy');
  assert.equal(validateFleetV16ConfigValue(en, 'weighted-round-robin').ok, true);
  assert.equal(validateFleetV16ConfigValue(en, 'random').ok, false);
  const bool = rows.find((r) => r.key === 'rollout.autoRollbackEnabled');
  assert.deepEqual(validateFleetV16ConfigValue(bool, 'false'), { ok: true, value: false, error: '' });
  assert.equal(validateFleetV16ConfigValue(bool, 'yes').ok, false);
  const applied = applyFleetV16Config(rows, 'gateway.userMaxPerMinute', 120);
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.rows.find((r) => r.key === 'gateway.userMaxPerMinute').value, 120);
  assert.equal(applied.requiresRestart, false);
  const restart = applyFleetV16Config(rows, 'fleet.heartbeatIntervalMs', 60000);
  assert.equal(restart.requiresRestart, true);
  const bad = applyFleetV16Config(rows, 'gateway.userMaxPerMinute', 0);
  assert.equal(bad.ok, false);
  assert.equal(bad.rows.find((r) => r.key === 'gateway.userMaxPerMinute').value, 60, 'rows unchanged on failure');
  assert.equal(applyFleetV16Config(rows, 'no.such.key', 1).ok, false);
});

test('panels v16: gateway panel', () => {
  const rollout = startTeamV16Canary(createTeamV16Rollout({ id: 'r1', feature: 'f', version: '1' }, T0).rollout, T0).rollout;
  const panel = buildFleetV16GatewayPanel({
    config: defaultGatewayV16Config(),
    bucketCount: 7,
    rollouts: [rollout],
    flags: [{ killed: false }, { killed: true }],
  });
  assert.equal(panel.userMaxPerMinute, 60);
  assert.equal(panel.tenantMaxPerMinute, 600);
  assert.equal(panel.bucketCount, 7);
  assert.deepEqual(panel.routeOverrides.map((r) => r.route), ['chat.completions', 'media.generate', 'tool.run'], 'sorted');
  assert.equal(panel.routeOverrides[0].maxRequests, 20);
  assert.equal(panel.rolloutCount, 1);
  assert.equal(panel.activeRolloutCount, 1);
  assert.equal(panel.flagCount, 2);
  assert.equal(panel.killedFlagCount, 1);
});

test('panels v16: audit panel + admin panel', () => {
  const rows = auditRows();
  const page = paginateAuditV16Rows([...rows].reverse(), null, 50);
  const audit = buildFleetV16AuditPanel({ rows: page.rows, nextCursor: page.nextCursor });
  assert.equal(audit.totalRows, 2);
  assert.equal(audit.nextCursor, null);
  assert.equal(audit.summary.criticalRows, 1);
  const admin = buildFleetV16AdminPanel({
    teamState: teamState(),
    users: teamState().users,
    quotaState: quotaState(),
    configRows: defaultFleetV16ConfigRows(),
    gateway: { config: defaultGatewayV16Config(), bucketCount: 0 },
    rollouts: [],
    flags: [],
    fleetSnapshot: fleetSnapshot(),
    auditRows: rows,
    now: T0,
  });
  assert.equal(admin.userPanel.totalUsers, 3);
  assert.equal(admin.quotaPanel.rows.length, 1);
  assert.equal(admin.configRows.length, 12);
  assert.equal(admin.fleetSummary.totalNodes, 2);
  assert.equal(admin.auditSummary.criticalRows, 1);
  assert.match(admin.summary, /3 user \(3 active\)/);
  assert.match(admin.summary, /1 tenant \(1 cảnh báo quota\)/);
  assert.match(admin.summary, /2 node/);
  assert.match(admin.summary, /1 dòng audit critical/);
});

test('panels v16: fleet panel (real node weights)', () => {
  const panel = buildFleetV16Panel({ fleetSnapshot: fleetSnapshot(), rollouts: [], now: T0 });
  assert.deepEqual(panel.nodes.map((n) => n.nodeId), ['node-a', 'node-b'], 'sorted');
  assert.equal(panel.nodes[0].weight, 25, 'weight from snapshot, not hardcoded 100');
  assert.equal(panel.nodes[1].weight, 100);
  assert.equal(panel.nodes[0].status, 'active');
  assert.equal(panel.nodes[0].heartbeatAgeMs, 0);
  assert.equal(panel.summary.totalNodes, 2);
  assert.match(panel.summaryText, /2 node/);
  assert.match(panel.summaryText, /0 rollout v5/);
  const rollout = startTeamV16Canary(createTeamV16Rollout({ id: 'r1', feature: 'f', version: '1' }, T0).rollout, T0).rollout;
  const withRollout = buildFleetV16Panel({ fleetSnapshot: fleetSnapshot(), rollouts: [rollout], now: T0 });
  assert.equal(withRollout.rollouts.length, 1);
  assert.equal(withRollout.rollouts[0].percent, 1);
  assert.equal(withRollout.rollouts[0].status, 'canary');
});
