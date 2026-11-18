/**
 * Tests for fleet v23 health v2 (v1.36, Đội T6).
 *
 * Covers:
 * - Node scoring: healthy node ~100, offline = dead 0 availability,
 *   stale heartbeat (> 5 min) = dead, never-heartbeat = critical,
 *   overloaded node loses load points, consecutive failures eat
 *   reliability, fresh node uptime < 1 min gets half availability.
 * - Rollup: mean score, byStatus counts, worst node, zone degraded
 *   (>= 50% nodes dead/critical), group quorum risk (bots on
 *   dead/critical nodes), empty fleet.
 * - Alerts: node-dead/node-critical critical first, stale-heartbeat
 *   warning, zone-degraded warning, group-quorum-risk critical.
 * - History: record, trend improving/declining/stable/unknown,
 *   last incident, size cap.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v23-health.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V23_HEARTBEAT_FRESH_MS,
  FLEET_V23_HEARTBEAT_STALE_MS,
  FleetV23HealthHistory,
  fleetV23HealthAlerts,
  rollupFleetV23Health,
  scoreFleetV23NodeHealth,
  validateFleetV23NodeHealthInput,
} from '../packages/core/dist/fleetV23/healthV2.js';
import {
  createFleetV23BotGroup,
  createFleetV23Topology,
  createFleetV23Zone,
  topologyAddGroup,
  topologyAddZone,
  topologyAssignNode,
} from '../packages/core/dist/fleetV23/topology.js';
import { buildFleetV23HealthPanel } from '../packages/core/dist/fleetV23/panelsV23.js';

const NOW = 1780000000000;

function makeInput(nodeId, overrides = {}) {
  return {
    nodeId,
    zoneId: null,
    online: true,
    lastHeartbeatAtMs: NOW - 5000,
    reliability: 100,
    cpuUsedFraction: 0.1,
    ramUsedFraction: 0.1,
    consecutiveFailures: 0,
    uptimeMs: 3600_000,
    ...overrides,
  };
}

test('health: validate input', () => {
  assert.deepEqual(validateFleetV23NodeHealthInput(makeInput('n1')), []);
  assert.ok(validateFleetV23NodeHealthInput({ ...makeInput('n1'), reliability: 101 }).some((e) => e.includes('reliability')));
  assert.ok(validateFleetV23NodeHealthInput({ ...makeInput('n1'), cpuUsedFraction: 1.5 }).some((e) => e.includes('cpuUsedFraction')));
  assert.ok(validateFleetV23NodeHealthInput({ ...makeInput('n1'), consecutiveFailures: -1 }).some((e) => e.includes('consecutiveFailures')));
  assert.ok(validateFleetV23NodeHealthInput(null).some((e) => e.includes('object')));
  assert.throws(() => scoreFleetV23NodeHealth({ ...makeInput('n1'), reliability: 101 }), /không hợp lệ/);
});

test('health: node scoring — healthy, dead, critical, degraded', () => {
  // Node khoẻ: điểm cao, healthy.
  const good = scoreFleetV23NodeHealth(makeInput('good'), NOW);
  assert.equal(good.status, 'healthy');
  assert.ok(good.score >= 90);
  assert.equal(good.breakdown.availability, 40);
  assert.equal(good.breakdown.freshness, 15);
  assert.equal(good.heartbeatAgeMs, 5000);

  // Offline → dead, availability 0.
  const off = scoreFleetV23NodeHealth(makeInput('off', { online: false }), NOW);
  assert.equal(off.status, 'dead');
  assert.equal(off.breakdown.availability, 0);
  assert.ok(off.reason.includes('offline'));

  // Heartbeat cũ > 5 phút → dead dù online.
  const stale = scoreFleetV23NodeHealth(makeInput('stale', { lastHeartbeatAtMs: NOW - FLEET_V23_HEARTBEAT_STALE_MS - 1000 }), NOW);
  assert.equal(stale.status, 'dead');
  assert.equal(stale.breakdown.freshness, 0);

  // Chưa từng heartbeat → critical.
  const never = scoreFleetV23NodeHealth(makeInput('never', { lastHeartbeatAtMs: null }), NOW);
  assert.equal(never.status, 'critical');
  assert.equal(never.heartbeatAgeMs, null);

  // Tải 100% → mất hết điểm load.
  const loaded = scoreFleetV23NodeHealth(makeInput('loaded', { cpuUsedFraction: 1, ramUsedFraction: 1 }), NOW);
  assert.equal(loaded.breakdown.load, 0);
  assert.ok(loaded.score < good.score);

  // Lỗi liên tiếp ăn reliability: 10 lỗi × 3 = 30 → trừ hết 25.
  const failing = scoreFleetV23NodeHealth(makeInput('failing', { reliability: 80, consecutiveFailures: 10 }), NOW);
  assert.equal(failing.breakdown.reliability, 0);
  assert.ok(failing.score < good.score);

  // Node mới lên (< 1 phút uptime) → availability một nửa.
  const fresh = scoreFleetV23NodeHealth(makeInput('fresh', { uptimeMs: 30_000 }), NOW);
  assert.equal(fresh.breakdown.availability, 20);

  // Heartbeat 2 phút → freshness giảm một phần (30s..5phút).
  const aging = scoreFleetV23NodeHealth(makeInput('aging', { lastHeartbeatAtMs: NOW - 120_000 }), NOW);
  assert.ok(aging.breakdown.freshness > 0 && aging.breakdown.freshness < 15);
  assert.ok(FLEET_V23_HEARTBEAT_FRESH_MS < FLEET_V23_HEARTBEAT_STALE_MS);
});

test('health: rollup — mean, worst, degraded zones, groups at risk', () => {
  let topo = createFleetV23Topology();
  topo = topologyAddZone(topo, createFleetV23Zone({ id: 'zone-a', region: 'r', name: 'A' }));
  topo = topologyAddZone(topo, createFleetV23Zone({ id: 'zone-b', region: 'r', name: 'B' }));
  topo = topologyAssignNode(topo, 'n1', 'zone-a');
  topo = topologyAssignNode(topo, 'n2', 'zone-a');
  topo = topologyAssignNode(topo, 'n3', 'zone-b');
  topo = topologyAddGroup(
    topo,
    createFleetV23BotGroup({ id: 'g1', botIds: ['b1', 'b2'], quorum: 2 }),
  );
  const health = [
    scoreFleetV23NodeHealth(makeInput('n1', { zoneId: 'zone-a' }), NOW),
    scoreFleetV23NodeHealth(makeInput('n2', { zoneId: 'zone-a', online: false }), NOW),
    scoreFleetV23NodeHealth(makeInput('n3', { zoneId: 'zone-b' }), NOW),
  ];
  // Placement: b1 trên n1 (sống), b2 trên n2 (chết) → group còn 1 < quorum 2.
  const rollup = rollupFleetV23Health({ nodeHealth: health, topology: topo, placement: { b1: 'n1', b2: 'n2' } });
  assert.equal(rollup.byStatus.healthy, 2);
  assert.equal(rollup.byStatus.dead, 1);
  assert.equal(rollup.worstNodeId, 'n2');
  assert.ok(rollup.meanScore !== null && rollup.meanScore < 100);
  assert.deepEqual(rollup.degradedZones, ['zone-a']); // 1/2 node chết = 50%
  assert.deepEqual(rollup.groupsAtRisk, ['g1']);
  assert.equal(rollup.hasIncident, true);
  assert.ok(rollup.summary.includes('zone-a'));

  // Fleet không có node.
  const empty = rollupFleetV23Health({ nodeHealth: [] });
  assert.equal(empty.meanScore, null);
  assert.equal(empty.worstNodeId, null);
  assert.equal(empty.hasIncident, false);
  assert.deepEqual(empty.degradedZones, []);
});

test('health: alerts — severity order + kinds', () => {
  const health = [
    scoreFleetV23NodeHealth(makeInput('n1', { zoneId: 'zone-a' }), NOW),
    scoreFleetV23NodeHealth(makeInput('n2', { zoneId: 'zone-a', online: false }), NOW),
    scoreFleetV23NodeHealth(makeInput('n3', { zoneId: 'zone-a', lastHeartbeatAtMs: NOW - 60_000, cpuUsedFraction: 0.9, reliability: 50 }), NOW),
  ];
  const fleet = rollupFleetV23Health({ nodeHealth: health });
  const alerts = fleetV23HealthAlerts({ nodeHealth: health, fleetHealth: fleet });
  assert.ok(alerts.length >= 1);
  // Critical trước warning.
  assert.equal(alerts[0]?.severity, 'critical');
  assert.ok(alerts.some((a) => a.kind === 'node-dead' && a.targetId === 'n2'));
  // n3 degraded + heartbeat 60s (> 30s tươi) → stale-heartbeat warning.
  assert.ok(alerts.some((a) => a.kind === 'stale-heartbeat' && a.targetId === 'n3'));
  // Zone-a: 1/3 node dead → chưa tới 50% → không có zone-degraded.
  assert.ok(!alerts.some((a) => a.kind === 'zone-degraded'));
});

test('health: history — trend + last incident + cap', () => {
  const history = new FleetV23HealthHistory(3);
  assert.equal(history.trend(), 'unknown');
  const mk = (mean, dead) => ({ meanScore: mean, byStatus: { healthy: 1, degraded: 0, critical: 0, dead }, worstNodeId: null, degradedZones: [], groupsAtRisk: [], hasIncident: dead > 0, summary: '' });
  history.record(mk(60, 0), NOW);
  history.record(mk(70, 0), NOW + 1000);
  assert.equal(history.trend(), 'improving');
  history.record(mk(50, 1), NOW + 2000);
  assert.equal(history.trend(), 'declining');
  assert.equal(history.lastIncident()?.meanScore, 50);
  assert.equal(history.size, 3);
  // Ghi thêm → cap 3, snapshot cũ nhất bị đẩy ra.
  history.record(mk(55, 0), NOW + 3000);
  assert.equal(history.size, 3);
  assert.equal(history.list()[0]?.meanScore, 70);

  // Panel health từ rollup + alerts.
  const health = [scoreFleetV23NodeHealth(makeInput('n1'), NOW)];
  const fleet = rollupFleetV23Health({ nodeHealth: health });
  const panel = buildFleetV23HealthPanel({
    nodeHealth: health,
    fleetHealth: fleet,
    alerts: fleetV23HealthAlerts({ nodeHealth: health, fleetHealth: fleet }),
    trend: 'stable',
  });
  assert.equal(panel.nodes.length, 1);
  assert.equal(panel.trend, 'stable');
  assert.equal(panel.hasIncident, false);
  assert.ok(panel.summary.includes('Xu hướng'));
});
