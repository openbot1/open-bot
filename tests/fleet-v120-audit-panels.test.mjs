/**
 * Audit log UI v3 + admin panels v3 tests (v1.20, Đội T6 — node:test, no network).
 *
 * Covers audit v3:
 * - Multi-dimension filter: actor, user, action, actionPrefix,
 *   actions list, resource, resourcePrefix, resources list, time
 *   range, severity (inherited v16), source, verifiedOnly, query;
 *   invalid filter (from > to, action + actionPrefix) throws.
 * - Detail: previous/next entry for the same resource, actor
 *   actions in the previous hour, counts, hints (unverified,
 *   critical, only entry); unknown entry returns null.
 * - Filtered export: JSON wraps rows + meta; CSV starts with
 *   comment metadata lines; NDJSON first line is the meta object.
 * - Timeline: buckets per hour with critical/warning counts, top
 *   actors/actions/resources.
 *
 * Covers panels v3:
 * - Dashboard: fleet counts/health, tenant alerts, gateway,
 *   audit totals, rollouts, sub-agents, last scale decision, and
 *   alerts sorted critical-first; validate catches bad counts.
 * - Quota panel: rows per tenant with worst level first, alerts,
 *   recent overrides (newest first, capped).
 * - Rollout panel: rows with stage/percent/status, byStatus totals
 *   match, needsAttention flags paused rollouts; validate catches
 *   bad percent.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v120-audit-panels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFleetV14Snapshot,
  registerFleetV14Node,
  heartbeatFleetV14Node,
} from '../packages/core/dist/fleetV14/index.js';

import {
  auditV17Timeline,
  buildAuditV17Detail,
  buildFleetV17DashboardPanel,
  buildFleetV17QuotaPanel,
  buildFleetV17RolloutPanel,
  buildFleetV17SubAgentMap,
  checkFleetV17Health,
  createTeamV17Rollout,
  createTeamV17RolloutStore,
  createTenantV17QuotaState,
  createTenantV17Record,
  consumeTenantV17Quota,
  evaluateFleetV17ScaleRule,
  exportAuditV17Filtered,
  filterAuditV17Rows,
  setTenantV17QuotaOverride,
  startTeamV17Rollout,
  summarizeFleetV17Capacity,
  validateAuditV17Filter,
  validateFleetV17DashboardPanel,
  validateFleetV17QuotaPanel,
  validateFleetV17RolloutPanel,
} from '../packages/core/dist/fleetV17/index.js';

const T0 = Date.UTC(2026, 11, 16, 0, 0, 0);
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function row(seq, at, over = {}) {
  return {
    seq, at, source: 'user-audit', userId: '', actorUserId: 'u_admin',
    actorRole: 'admin', action: 'user.switch', target: 'bot-1',
    detail: 'switched bot', hash: `h${seq}`, verified: true, ...over,
  };
}

const ROWS = [
  row(1, T0, { action: 'user.create', target: 'user-alice', actorUserId: 'u_owner', detail: 'created alice' }),
  row(2, T0 + 10 * MIN, { action: 'user.deactivate', target: 'user-alice', actorUserId: 'u_admin', detail: 'deactivated alice', verified: false }),
  row(3, T0 + 20 * MIN, { action: 'bot.start', target: 'bot-1', actorUserId: 'u_alice', userId: 'u_alice' }),
  row(4, T0 + 30 * MIN, { action: 'rollout.rollback', target: 'rollout-1', actorUserId: 'u_admin', source: 'fleet-audit' }),
  row(5, T0 + 40 * MIN, { action: 'user.suspend', target: 'user-bob', actorUserId: 'u_admin' }),
  row(6, T0 + 70 * MIN, { action: 'user.deactivate', target: 'user-alice', actorUserId: 'u_admin', detail: 'deactivated again' }),
];

// ---------------------------------------------------------------------------
// Audit v3
// ---------------------------------------------------------------------------

test('auditV17 filter: actor/user/action/resource/time/severity/source/verified/query', () => {
  assert.equal(filterAuditV17Rows(ROWS, { actorUserId: 'u_admin' }).length, 4);
  assert.equal(filterAuditV17Rows(ROWS, { userId: 'u_alice' }).length, 1);
  assert.equal(filterAuditV17Rows(ROWS, { action: 'user.deactivate' }).length, 2);
  assert.equal(filterAuditV17Rows(ROWS, { actionPrefix: 'user.' }).length, 4);
  assert.equal(filterAuditV17Rows(ROWS, { actions: ['bot.start', 'rollout.rollback'] }).length, 2);
  assert.equal(filterAuditV17Rows(ROWS, { resource: 'user-alice' }).length, 3);
  assert.equal(filterAuditV17Rows(ROWS, { resourcePrefix: 'user-' }).length, 4);
  assert.equal(filterAuditV17Rows(ROWS, { resources: ['bot-1', 'rollout-1'] }).length, 2);
  assert.equal(filterAuditV17Rows(ROWS, { fromMs: T0 + 25 * MIN, toMs: T0 + 45 * MIN }).length, 2);
  assert.equal(filterAuditV17Rows(ROWS, { severity: 'critical' }).length, 3);
  assert.equal(filterAuditV17Rows(ROWS, { severity: 'warning' }).length, 1);
  assert.equal(filterAuditV17Rows(ROWS, { source: 'fleet-audit' }).length, 1);
  assert.equal(filterAuditV17Rows(ROWS, { verifiedOnly: true }).length, 5);
  assert.equal(filterAuditV17Rows(ROWS, { query: 'alice' }).length, 3);
  assert.equal(filterAuditV17Rows(ROWS, { actorUserId: 'u_admin', severity: 'critical' }).length, 3);
  assert.equal(filterAuditV17Rows(ROWS, {}).length, 6);
});

test('auditV17 filter validation rejects bad filters', () => {
  assert.notEqual(validateAuditV17Filter({ fromMs: T0 + 1000, toMs: T0 }), '');
  assert.notEqual(validateAuditV17Filter({ action: 'x', actionPrefix: 'y' }), '');
  assert.notEqual(validateAuditV17Filter({ actions: [] }), '');
  assert.equal(validateAuditV17Filter({}), '');
  assert.throws(() => filterAuditV17Rows(ROWS, { fromMs: T0 + 1000, toMs: T0 }), /không hợp lệ/);
});

test('auditV17 detail: context, hints, unknown entry', () => {
  const detail = buildAuditV17Detail(ROWS, 'user-audit', 2);
  assert.ok(detail);
  assert.equal(detail.entry.seq, 2);
  assert.equal(detail.severity, 'critical');
  assert.equal(detail.previousForResource.seq, 1);
  assert.equal(detail.nextForResource.seq, 6);
  assert.equal(detail.resourceEntryCount, 3);
  assert.ok(detail.actorEntryCount >= 3);
  assert.ok(detail.hints.some((h) => h.includes('chưa verify')));
  assert.ok(detail.hints.some((h) => h.includes('critical')));
  // Actor u_admin acted at T0+10 (seq 2 itself excluded) and T0 (seq 1 is u_owner, not u_admin):
  // within 1h before seq 2 there is no other u_admin action -> empty recent.
  assert.equal(detail.actorRecent.length, 0);
  const detail6 = buildAuditV17Detail(ROWS, 'user-audit', 6);
  assert.equal(detail6.actorRecent.length, 3, 'u_admin acted 3x in the hour before seq 6');
  assert.equal(detail6.actorRecent[0].seq, 5);
  assert.equal(buildAuditV17Detail(ROWS, 'user-audit', 999), null);
  // Single-entry resource has its own hint.
  const botDetail = buildAuditV17Detail(ROWS, 'user-audit', 3);
  assert.ok(botDetail.hints.some((h) => h.includes('duy nhất')));
});

test('auditV17 filtered export: json/csv/ndjson carry meta + only filtered rows', () => {
  const filter = { actionPrefix: 'user.' };
  const json = exportAuditV17Filtered(ROWS, filter, 'json', T0 + 2 * HOUR);
  const parsed = JSON.parse(json.content);
  assert.equal(parsed.meta.format, 'json');
  assert.equal(parsed.meta.rowCount, 4);
  assert.equal(parsed.rows.length, 4);
  assert.equal(json.meta.rowCount, 4);
  const csv = exportAuditV17Filtered(ROWS, filter, 'csv', T0 + 2 * HOUR);
  assert.ok(csv.content.startsWith('# open-bot audit export (v17)'));
  assert.ok(csv.content.includes('# filter {"actionPrefix":"user."}'));
  const nd = exportAuditV17Filtered(ROWS, filter, 'ndjson', T0 + 2 * HOUR);
  const lines = nd.content.trim().split('\n');
  assert.equal(lines.length, 5, 'meta line + 4 rows');
  assert.equal(JSON.parse(lines[0]).meta.rowCount, 4);
  assert.equal(JSON.parse(lines[1]).action, 'user.create');
});

test('auditV17 timeline: hourly buckets, critical counts, top lists', () => {
  const timeline = auditV17Timeline(ROWS, {}, HOUR);
  assert.equal(timeline.total, 6);
  assert.equal(timeline.buckets.length, 2);
  assert.equal(timeline.buckets[0].count, 5);
  assert.equal(timeline.buckets[0].critical, 2);
  assert.equal(timeline.buckets[0].warning, 1);
  assert.equal(timeline.buckets[1].count, 1);
  assert.equal(timeline.buckets[1].critical, 1);
  assert.equal(timeline.topActors[0].actorUserId, 'u_admin');
  assert.equal(timeline.topActors[0].count, 4);
  assert.equal(timeline.topActions[0].action, 'user.deactivate');
  assert.equal(timeline.topActions[0].count, 2);
  assert.equal(timeline.topResources[0].resource, 'user-alice');
  assert.equal(timeline.topResources[0].count, 3);
});

// ---------------------------------------------------------------------------
// Panels v3
// ---------------------------------------------------------------------------

function fleetInputs() {
  let snap = createFleetV14Snapshot(T0);
  for (const id of ['n1', 'n2']) {
    const res = registerFleetV14Node(
      snap,
      { nodeId: id, hostname: `${id}.local`, fingerprint: `fp-${id}`, labels: {}, capacity: { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 0, diskTotalMb: 500000, maxTasks: 4 } },
      'u_owner', T0,
    );
    snap = heartbeatFleetV14Node(res.snapshot, id, T0);
  }
  const capacity = summarizeFleetV17Capacity(snap);
  const health = checkFleetV17Health(snap, [], T0 + 1000);
  const map = buildFleetV17SubAgentMap(snap, health, capacity, [], T0 + 1000);
  return { snap, capacity, health, map };
}

function quotaStateWithAlerts() {
  const state = createTenantV17QuotaState(T0);
  createTenantV17Record(state, 'acme', 'Acme', T0);
  createTenantV17Record(state, 'beta', 'Beta', T0);
  consumeTenantV17Quota(state, 'acme', 'cpu-cores', 16, T0);
  consumeTenantV17Quota(state, 'beta', 'cpu-cores', 13, T0);
  setTenantV17QuotaOverride(
    state, 'beta', 'ram-mb',
    { newLimit: 16384, actorUserId: 'u_admin', reason: 'downgrade' }, T0,
  );
  return state;
}

function rolloutStoreWithOne() {
  let store = createTeamV17RolloutStore(T0);
  const created = createTeamV17Rollout(store, {
    id: 'r1', name: 'Release 1.20', targetVersion: '1.20.0', previousVersion: '1.19.0',
    stages: [
      { name: 'canary', percent: 10, groupId: 'all', dwellMs: MIN, requiresApproval: false },
      { name: 'full', percent: 100, groupId: 'all', dwellMs: MIN, requiresApproval: false },
    ],
    createdByUserId: 'u_admin', rollbackErrorRate: 0.1, pauseErrorRate: 0.05,
  }, T0);
  assert.equal(created.ok, true, created.reason);
  // create trả về store MỚI (không mutate) — dùng store trả về.
  store = created.store;
  const started = startTeamV17Rollout(store, 'r1', 'u_admin', T0);
  assert.equal(started.ok, true, started.reason);
  return started.store;
}

function dashboardInput(over = {}) {
  const { capacity, health, map } = fleetInputs();
  const quotaState = quotaStateWithAlerts();
  const store = rolloutStoreWithOne();
  const timeline = auditV17Timeline(ROWS, {}, HOUR);
  const scaleDecision = evaluateFleetV17ScaleRule(
    {
      ruleId: 'r1', name: 'cpu', metric: 'cpu', thresholdUp: 0.8, thresholdDown: 0.2,
      durationMs: 5 * MIN, scaleUpBy: 1, scaleDownBy: 1, minNodes: 1, maxNodes: 5,
      cooldownMs: 10 * MIN, enabled: true,
    },
    capacity, [], null, T0 + 1000,
  );
  return {
    capacity, healthChecks: health, quotaState,
    gatewayBucketCount: 12, lastLoadSim: null,
    auditTimeline: timeline, rolloutStore: store, subAgentMap: map,
    lastScaleDecision: scaleDecision, now: T0 + 1000, ...over,
  };
}

test('panelsV17 dashboard: aggregates fleet/tenant/gateway/audit/rollout/sub-agents', () => {
  const panel = buildFleetV17DashboardPanel(dashboardInput());
  assert.equal(panel.fleet.nodeCount, 2);
  assert.equal(panel.fleet.activeNodeCount, 2);
  assert.equal(panel.fleet.healthyNodeCount, 2);
  assert.equal(panel.fleet.bottleneck, 'none');
  assert.equal(panel.tenants.tenantCount, 2);
  assert.ok(panel.tenants.alertCount >= 2);
  assert.equal(panel.tenants.topAlerts[0].tenantId, 'acme');
  assert.equal(panel.gateway.bucketCount, 12);
  assert.equal(panel.audit.total, 6);
  assert.equal(panel.audit.critical, 3);
  assert.equal(panel.rollouts.total, 1);
  assert.equal(panel.rollouts.running, 1);
  assert.equal(panel.subAgents.totalAgents, 0);
  assert.equal(panel.lastScaleDecision.direction, 'none');
  assert.ok(panel.alerts.length > 0);
  assert.equal(panel.alerts[0].level, 'critical');
  assert.equal(validateFleetV17DashboardPanel(panel), '');
  const bad = { ...panel, fleet: { ...panel.fleet, nodeCount: 1 } };
  assert.notEqual(validateFleetV17DashboardPanel(bad), '');
});

test('panelsV17 quota panel: rows worst-first, alerts, recent overrides', () => {
  const panel = buildFleetV17QuotaPanel(quotaStateWithAlerts(), T0);
  assert.equal(panel.rows.length, 2);
  assert.equal(panel.rows[0].tenantId, 'acme', 'acme at 100% sorts first');
  assert.equal(panel.rows[0].worstLevel, 'critical');
  assert.equal(panel.rows[0].quotas.length, 4);
  assert.equal(panel.rows[1].tenantId, 'beta');
  assert.equal(panel.rows[1].overrideCount, 1);
  assert.ok(panel.alerts.length >= 2);
  assert.equal(panel.recentOverrides.length, 1);
  assert.equal(panel.recentOverrides[0].tenantId, 'beta');
  assert.equal(panel.recentOverrides[0].newLimit, 16384);
  assert.equal(validateFleetV17QuotaPanel(panel), '');
  const bad = { ...panel, rows: [{ ...panel.rows[0], quotas: [] }] };
  assert.notEqual(validateFleetV17QuotaPanel(bad), '');
});

test('panelsV17 rollout panel: rows, byStatus, needsAttention', () => {
  const panel = buildFleetV17RolloutPanel(rolloutStoreWithOne(), T0 + 1000);
  assert.equal(panel.total, 1);
  assert.equal(panel.byStatus.running, 1);
  assert.equal(panel.rows.length, 1);
  assert.equal(panel.rows[0].id, 'r1');
  assert.equal(panel.rows[0].status, 'running');
  assert.equal(panel.rows[0].currentStage, 'canary');
  assert.equal(panel.rows[0].currentPercent, 10);
  assert.equal(panel.rows[0].stageCount, 2);
  assert.equal(panel.rows[0].needsAttention, false);
  assert.equal(panel.running.length, 1);
  assert.equal(validateFleetV17RolloutPanel(panel), '');
  const bad = { ...panel, rows: [{ ...panel.rows[0], currentPercent: 150 }] };
  assert.notEqual(validateFleetV17RolloutPanel(bad), '');
});
