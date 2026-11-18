/**
 * Fleet health v12 tests (v1.15, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Rule validation: metric/operator/level sai, threshold ngoài
 *   0–100 cho cpu/ram/disk, modelDrift threshold khác 0/1,
 *   duration/cooldown âm.
 * - Metric value + compare: từng metric (cpu/ram/disk/heartbeat/
 *   drift/tokens), heartbeat null -> null, mọi toán tử.
 * - Evaluate node: healthy/degraded/unhealthy/down theo ngưỡng;
 *   model drift -> ít nhất degraded (critical check); node không
 *   load model vẫn healthy; heartbeat null -> down.
 * - Trend: rising/falling/stable/unknown (< 4 điểm).
 * - History summary: avg/max/trend/drift %; rỗng -> null.
 * - recordSample: append history (cắt 60), rule bắn khi vi phạm đủ
 *   duration, cooldown chặn bắn trùng, alert hết vi phạm thì
 *   resolved, ack, dedupe.
 * - Dashboard: rollup theo status/model, drift/down, avg, alert
 *   theo mức, worst nodes, rỗng -> summary rõ ràng.
 * - Probe local: đo thật bằng node:os (cpu/ram/disk trong 0–100).
 * - Persistence: save/load round-trip, rule hỏng bị loại, file hỏng
 *   -> null.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v115-health.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_FLEET_V12_ALERT_RULES,
  acknowledgeFleetV12Alert,
  buildFleetV12HealthDashboard,
  createFleetV12HealthState,
  dedupeFleetV12Alerts,
  evaluateFleetV12NodeHealth,
  fleetV12Compare,
  fleetV12MetricValue,
  fleetV12Trend,
  getFleetV12HealthPath,
  loadFleetV12HealthState,
  probeFleetV12LocalNode,
  recordFleetV12Sample,
  saveFleetV12HealthState,
  summarizeFleetV12NodeHistory,
  validateFleetV12AlertRule,
} from '../packages/core/dist/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function tmpFleetRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v12-health-')), 'fleet');
}

function sample(overrides = {}) {
  return {
    nodeId: 'node-1',
    at: T0,
    cpuPct: 40,
    ramPct: 50,
    diskPct: 60,
    uptimeMs: 3600_000,
    lastHeartbeatAt: T0,
    botCount: 1,
    botCapacity: 4,
    loadedModelId: 'qwen3-4b-q4_k_m',
    modelStatus: 'verified',
    tokensPerSec: 42,
    pendingRequests: 0,
    ...overrides,
  };
}

function rule(overrides = {}) {
  return {
    id: 'test-rule',
    name: 'Rule test',
    metric: 'cpuPct',
    operator: '>',
    threshold: 80,
    durationMs: 0,
    level: 'warning',
    enabled: true,
    cooldownMs: 0,
    ...overrides,
  };
}

test('rule mac dinh: 8 rule, co model-drift critical + heartbeat + tokens-low', () => {
  assert.equal(DEFAULT_FLEET_V12_ALERT_RULES.length, 8);
  const ids = DEFAULT_FLEET_V12_ALERT_RULES.map((r) => r.id);
  assert.ok(ids.includes('model-drift'));
  assert.ok(ids.includes('heartbeat-stale'));
  assert.ok(ids.includes('tokens-low'));
  assert.ok(ids.includes('cpu-critical'));
  for (const r of DEFAULT_FLEET_V12_ALERT_RULES) {
    assert.deepEqual(validateFleetV12AlertRule(r), [], r.id);
  }
});

test('validate rule: metric/operator/level sai, threshold, duration/cooldown am', () => {
  assert.ok(validateFleetV12AlertRule(rule({ metric: 'nope' })).length > 0);
  assert.ok(validateFleetV12AlertRule(rule({ operator: '!=' })).length > 0);
  assert.ok(validateFleetV12AlertRule(rule({ level: 'fatal' })).length > 0);
  assert.ok(validateFleetV12AlertRule(rule({ threshold: 101 })).length > 0);
  assert.ok(validateFleetV12AlertRule(rule({ threshold: -1 })).length > 0);
  assert.ok(validateFleetV12AlertRule(rule({ metric: 'modelDrift', threshold: 0.5 })).length > 0);
  assert.deepEqual(validateFleetV12AlertRule(rule({ metric: 'modelDrift', threshold: 1, operator: '==' })), []);
  assert.ok(validateFleetV12AlertRule(rule({ durationMs: -1 })).length > 0);
  assert.ok(validateFleetV12AlertRule(rule({ cooldownMs: -5 })).length > 0);
  assert.ok(validateFleetV12AlertRule(rule({ id: '' })).length > 0);
  assert.ok(validateFleetV12AlertRule(rule({ name: '' })).length > 0);
  assert.ok(validateFleetV12AlertRule(rule({ threshold: Number.NaN })).length > 0);
});

test('metric value + compare: tung metric, heartbeat null, moi toan tu', () => {
  const s = sample();
  assert.equal(fleetV12MetricValue(s, 'cpuPct', T0), 40);
  assert.equal(fleetV12MetricValue(s, 'ramPct', T0), 50);
  assert.equal(fleetV12MetricValue(s, 'diskPct', T0), 60);
  assert.equal(fleetV12MetricValue(s, 'heartbeatStaleMs', T0 + 5000), 5000);
  assert.equal(fleetV12MetricValue(s, 'modelDrift', T0), 0);
  assert.equal(fleetV12MetricValue(sample({ modelStatus: 'drift' }), 'modelDrift', T0), 1);
  assert.equal(fleetV12MetricValue(s, 'tokensPerSec', T0), 42);
  assert.equal(fleetV12MetricValue(sample({ lastHeartbeatAt: null }), 'heartbeatStaleMs', T0), null);
  assert.equal(fleetV12MetricValue(sample({ tokensPerSec: null }), 'tokensPerSec', T0), null);
  assert.equal(fleetV12MetricValue(s, 'nope', T0), null);
  assert.equal(fleetV12Compare(90, '>', 80), true);
  assert.equal(fleetV12Compare(80, '>', 80), false);
  assert.equal(fleetV12Compare(80, '>=', 80), true);
  assert.equal(fleetV12Compare(4, '<', 5), true);
  assert.equal(fleetV12Compare(5, '<=', 5), true);
  assert.equal(fleetV12Compare(1, '==', 1), true);
  assert.equal(fleetV12Compare(0, '==', 1), false);
  assert.equal(fleetV12Compare(1, '??', 1), false);
});

test('evaluate node: healthy/degraded/unhealthy/down + model drift + khong load model', () => {
  let r = evaluateFleetV12NodeHealth(sample(), undefined, T0);
  assert.equal(r.status, 'healthy');
  assert.equal(r.worstReason, '');
  assert.equal(r.loadedModelId, 'qwen3-4b-q4_k_m');
  assert.equal(r.modelStatus, 'verified');
  // CPU 85% -> degraded (warn), CPU 97% -> unhealthy (crit).
  assert.equal(evaluateFleetV12NodeHealth(sample({ cpuPct: 85 }), undefined, T0).status, 'degraded');
  assert.equal(evaluateFleetV12NodeHealth(sample({ cpuPct: 97 }), undefined, T0).status, 'unhealthy');
  assert.equal(evaluateFleetV12NodeHealth(sample({ ramPct: 96 }), undefined, T0).status, 'unhealthy');
  assert.equal(evaluateFleetV12NodeHealth(sample({ diskPct: 96 }), undefined, T0).status, 'unhealthy');
  // Model drift -> unhealthy (check model level critical).
  r = evaluateFleetV12NodeHealth(sample({ modelStatus: 'drift' }), undefined, T0);
  assert.equal(r.status, 'unhealthy');
  assert.ok(r.worstReason.includes('thay đổi'));
  assert.ok(r.checks.find((c) => c.name === 'model')?.passed === false);
  // Model chưa verify -> degraded (warning).
  assert.equal(evaluateFleetV12NodeHealth(sample({ modelStatus: 'unverified' }), undefined, T0).status, 'degraded');
  // Không load model nào -> vẫn healthy (không ép node nào cũng phải chạy model).
  assert.equal(
    evaluateFleetV12NodeHealth(sample({ loadedModelId: '', modelStatus: 'none' }), undefined, T0).status,
    'healthy',
  );
  // Heartbeat stale 2 phút -> degraded; quá 5 phút -> down; chưa bao giờ -> down.
  assert.equal(evaluateFleetV12NodeHealth(sample(), undefined, T0 + 120_000).status, 'degraded');
  assert.equal(evaluateFleetV12NodeHealth(sample(), undefined, T0 + 360_000).status, 'down');
  assert.equal(evaluateFleetV12NodeHealth(sample({ lastHeartbeatAt: null }), undefined, T0).status, 'down');
  // Tokens thấp -> degraded.
  assert.equal(evaluateFleetV12NodeHealth(sample({ tokensPerSec: 2 }), undefined, T0).status, 'degraded');
  // CPU/ram/disk bị kẹp 0–100.
  assert.equal(evaluateFleetV12NodeHealth(sample({ cpuPct: 250 }), undefined, T0).status, 'unhealthy');
});

test('trend + history summary: rising/falling/stable/unknown, avg/max/drift %', () => {
  assert.equal(fleetV12Trend([10, 20, 30]), 'unknown');
  assert.equal(fleetV12Trend([10, 12, 40, 42]), 'rising');
  assert.equal(fleetV12Trend([40, 42, 10, 12]), 'falling');
  assert.equal(fleetV12Trend([50, 51, 50, 51]), 'stable');
  const empty = summarizeFleetV12NodeHistory('node-1', []);
  assert.equal(empty.sampleCount, 0);
  assert.equal(empty.avgCpuPct, null);
  assert.equal(empty.cpuTrend, 'unknown');
  const samples = [0, 1, 2, 3].map((i) =>
    sample({ at: T0 + i * 1000, cpuPct: 10 + i * 20, ramPct: 50, modelStatus: i === 3 ? 'drift' : 'verified' }),
  );
  const h = summarizeFleetV12NodeHistory('node-1', samples);
  assert.equal(h.sampleCount, 4);
  assert.equal(h.avgCpuPct, 40);
  assert.equal(h.maxCpuPct, 70);
  assert.equal(h.cpuTrend, 'rising');
  assert.equal(h.ramTrend, 'stable');
  assert.equal(h.driftSamplePct, 25);
  assert.equal(h.firstAt, T0);
  assert.equal(h.lastAt, T0 + 3000);
});

test('recordSample: history cat 60, rule ban khi du duration, cooldown, resolved, ack, dedupe', () => {
  const fastRule = rule({ id: 'cpu-fast', threshold: 80, durationMs: 0, cooldownMs: 0 });
  const slowRule = rule({ id: 'cpu-slow', threshold: 80, durationMs: 60_000, cooldownMs: 0 });
  let state = { ...createFleetV12HealthState(T0), rules: [fastRule, slowRule] };
  // Sample khỏe -> không bắn.
  let res = recordFleetV12Sample(state, sample({ at: T0 }), T0);
  state = res.state;
  assert.equal(res.fired.length, 0);
  assert.equal(res.result.status, 'healthy');
  assert.equal(state.history['node-1'].length, 1);
  // Sample CPU cao -> fast bắn ngay, slow chưa đủ duration.
  res = recordFleetV12Sample(state, sample({ at: T0 + 1000, cpuPct: 90 }), T0 + 1000);
  state = res.state;
  assert.equal(res.fired.length, 1);
  assert.equal(res.fired[0].ruleId, 'cpu-fast');
  assert.equal(res.fired[0].level, 'warning');
  assert.equal(state.openAlerts.length, 1);
  // Sample CPU cao tiếp theo 61s sau -> slow đủ duration -> bắn; fast đã mở nên chỉ cập nhật.
  res = recordFleetV12Sample(state, sample({ at: T0 + 62_000, cpuPct: 90 }), T0 + 62_000);
  state = res.state;
  assert.equal(res.fired.length, 1);
  assert.equal(res.fired[0].ruleId, 'cpu-slow');
  assert.equal(state.openAlerts.length, 2);
  // Sample khỏe -> cả 2 alert resolved.
  res = recordFleetV12Sample(state, sample({ at: T0 + 63_000, cpuPct: 40 }), T0 + 63_000);
  state = res.state;
  assert.equal(res.resolved.length, 2);
  assert.equal(state.openAlerts.length, 0);
  // Cooldown: rule cooldown 5 phút, bắn lại trong cooldown thì không bắn mới.
  const coolRule = rule({ id: 'cpu-cool', threshold: 80, durationMs: 0, cooldownMs: 300_000 });
  state = { ...createFleetV12HealthState(T0), rules: [coolRule] };
  res = recordFleetV12Sample(state, sample({ at: T0, cpuPct: 90 }), T0);
  state = res.state;
  assert.equal(res.fired.length, 1);
  res = recordFleetV12Sample(state, sample({ at: T0 + 60_000, cpuPct: 90 }), T0 + 60_000);
  state = res.state;
  assert.equal(res.fired.length, 0);
  assert.equal(state.openAlerts.length, 1);
  // Ack không xóa alert.
  const alertId = state.openAlerts[0].id;
  const acked = acknowledgeFleetV12Alert(state, alertId, 'admin', T0);
  assert.equal(acked.openAlerts[0].acknowledged, true);
  assert.equal(acked.openAlerts[0].acknowledgedBy, 'admin');
  assert.equal(acknowledgeFleetV12Alert(state, 'khong-co', 'admin', T0).openAlerts.length, 1);
  // Dedupe: cùng rule+node giữ bản mới nhất.
  const dupes = dedupeFleetV12Alerts([
    { ...state.openAlerts[0], lastSeenAt: T0 },
    { ...state.openAlerts[0], lastSeenAt: T0 + 1000, id: 'newer' },
    { ...state.openAlerts[0], ruleId: 'other-rule', id: 'other', lastSeenAt: T0 },
  ]);
  assert.equal(dupes.length, 2);
  assert.equal(dupes[0].id, 'newer');
  // History cắt 60: ghi 70 sample.
  let s2 = createFleetV12HealthState(T0);
  for (let i = 0; i < 70; i++) {
    s2 = recordFleetV12Sample(s2, sample({ at: T0 + i * 1000 }), T0 + i * 1000).state;
  }
  assert.equal(s2.history['node-1'].length, 60);
  assert.equal(s2.history['node-1'][0].at, T0 + 10_000);
});

test('dashboard: rollup status/model/drift/down/avg/alert/worst + rong', () => {
  const state = createFleetV12HealthState(T0);
  const samples = [
    sample({ nodeId: 'node-1', cpuPct: 40, ramPct: 50 }),
    sample({ nodeId: 'node-2', cpuPct: 97, ramPct: 96, modelStatus: 'drift', loadedModelId: 'llama-3.2-3b-q4_k_m' }),
    sample({ nodeId: 'node-3', lastHeartbeatAt: null, loadedModelId: '' }),
  ];
  const d = buildFleetV12HealthDashboard(samples, state, T0);
  assert.equal(d.nodeCount, 3);
  assert.equal(d.byStatus.healthy, 1);
  assert.equal(d.byStatus.unhealthy, 1);
  assert.equal(d.byStatus.down, 1);
  assert.equal(d.byModel['qwen3-4b-q4_k_m'], 1);
  assert.equal(d.byModel['llama-3.2-3b-q4_k_m'], 1);
  assert.deepEqual(d.driftNodeIds, ['node-2']);
  assert.deepEqual(d.downNodeIds, ['node-3']);
  assert.ok(d.avgCpuPct !== null && d.avgCpuPct > 40 && d.avgCpuPct < 100);
  assert.equal(d.avgTokensPerSec, 42);
  assert.equal(d.openAlerts.length, 0);
  assert.equal(d.worstNodes[0].nodeId, 'node-3');
  assert.equal(d.worstNodes[0].status, 'down');
  assert.equal(d.nodeHistories.length, 3);
  assert.ok(d.summary.includes('3 node'));
  // Sample cũ hơn không ghi đè sample mới nhất.
  const d2 = buildFleetV12HealthDashboard(
    [sample({ nodeId: 'node-1', at: T0 + 1000, cpuPct: 10 }), sample({ nodeId: 'node-1', at: T0, cpuPct: 99 })],
    state,
    T0 + 1000,
  );
  assert.equal(d2.avgCpuPct, 10);
  // Rỗng.
  const empty = buildFleetV12HealthDashboard([], state, T0);
  assert.equal(empty.nodeCount, 0);
  assert.equal(empty.avgCpuPct, null);
  assert.ok(empty.summary.includes('Chưa có sample'));
});

test('probe local: do that bang node:os, gia tri trong 0-100', () => {
  const p = probeFleetV12LocalNode('node-local', 'qwen3-4b-q4_k_m', 'verified', 30, 2, T0);
  assert.equal(p.nodeId, 'node-local');
  assert.ok(p.cpuPct >= 0 && p.cpuPct <= 100);
  assert.ok(p.ramPct > 0 && p.ramPct <= 100);
  assert.ok(p.diskPct >= 0 && p.diskPct <= 100);
  assert.equal(p.loadedModelId, 'qwen3-4b-q4_k_m');
  assert.equal(p.modelStatus, 'verified');
  assert.equal(p.tokensPerSec, 30);
  assert.equal(p.pendingRequests, 2);
  assert.equal(p.lastHeartbeatAt, T0);
});

test('persistence: save/load round-trip, rule hong bi loai, file hong -> null', () => {
  const root = tmpFleetRoot();
  assert.equal(loadFleetV12HealthState(root), null);
  assert.ok(getFleetV12HealthPath(root).endsWith('fleet-health-v115.json'));
  let state = { ...createFleetV12HealthState(T0), rules: [rule({ id: 'r1' })] };
  state = recordFleetV12Sample(state, sample({ at: T0, cpuPct: 90 }), T0).state;
  saveFleetV12HealthState(root, state);
  const loaded = loadFleetV12HealthState(root);
  assert.ok(loaded);
  assert.equal(loaded.rules.length, 1);
  assert.equal(loaded.history['node-1'].length, 1);
  assert.equal(loaded.openAlerts.length, 1);
  // Rule hỏng trong file bị loại, còn rule tốt giữ lại.
  const raw = JSON.parse(fs.readFileSync(getFleetV12HealthPath(root), 'utf8'));
  raw.rules.push({ id: 'bad', metric: 'nope' });
  fs.writeFileSync(getFleetV12HealthPath(root), JSON.stringify(raw));
  const loaded2 = loadFleetV12HealthState(root);
  assert.equal(loaded2.rules.length, 1);
  fs.writeFileSync(getFleetV12HealthPath(root), 'khong-phai-json');
  assert.equal(loadFleetV12HealthState(root), null);
  fs.writeFileSync(getFleetV12HealthPath(root), JSON.stringify({ version: 99 }));
  assert.equal(loadFleetV12HealthState(root), null);
});
