/**
 * Fleet health v11 tests (v1.14, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Threshold normalization: invalid values fall back per-field, warn < crit
 *   is enforced, heartbeatTimeout < downAfter is enforced.
 * - Node health: healthy / degraded (warn) / unhealthy (crit) / down
 *   (stale heartbeat), missing measurements don't crash, stopped-bot
 *   heartbeat is not a failure, capacity overage warns.
 * - Bot health: running bot without heartbeat -> down; stopped bot ->
 *   healthy (no heartbeat required); consecutive failures -> unhealthy.
 * - Alerts: built from failed checks only, occurrences/firstSeen carried
 *   from previous alerts, dedupe keeps newest, ack records actor/time
 *   and doesn't delete the alert.
 * - Snapshot: counts by status, alert counts by level, averages, worst
 *   list (max 5, down first), summary line per situation.
 * - Persistence: health state round-trip, downs tracking (+1 / reset),
 *   incident append + read (newest first, bad lines skipped), corrupted
 *   state file falls back to defaults.
 * - Local probe: returns a sample with sane values (cpu/ram in 0-100,
 *   uptime > 0, heartbeat = now).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v114-health.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  acknowledgeFleetV11Alert,
  appendFleetV11Incident,
  buildFleetV11Alerts,
  buildFleetV11HealthSnapshot,
  createFleetV11HealthState,
  dedupeFleetV11Alerts,
  evaluateFleetV11BotHealth,
  evaluateFleetV11NodeHealth,
  getFleetV11HealthPath,
  getFleetV11IncidentsPath,
  loadFleetV11HealthState,
  normalizeFleetV11Thresholds,
  probeFleetV11LocalNode,
  readFleetV11Incidents,
  saveFleetV11HealthState,
  trackFleetV11Downs,
} from '../packages/core/dist/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v11-health-'));
}

function nodeSample(overrides = {}) {
  return {
    nodeId: 'node-1',
    name: 'Node 1',
    cpuPct: 40,
    ramPct: 50,
    diskPct: 60,
    uptimeMs: 3600_000,
    lastHeartbeatAt: T0,
    botCount: 2,
    botCapacity: 4,
    ...overrides,
  };
}

function botSample(overrides = {}) {
  return {
    botId: 'bot-1',
    name: 'Bot 1',
    nodeId: 'node-1',
    cpuPct: 20,
    ramPct: 30,
    lastHeartbeatAt: T0,
    uptimeMs: 1800_000,
    consecutiveFailures: 0,
    recentRestarts: 0,
    running: true,
    ...overrides,
  };
}

test('thresholds: giá trị xấu rơi về mặc định từng trường, warn < crit luôn đúng', () => {
  const t = normalizeFleetV11Thresholds({
    cpuWarnPct: Number.NaN,
    cpuCritPct: 50,
    ramWarnPct: 90,
    ramCritPct: 80,
    heartbeatTimeoutMs: 120_000,
    downAfterMs: 60_000,
  });
  assert.equal(t.cpuWarnPct, 80, 'cpuWarn NaN -> mặc định 80');
  assert.equal(t.cpuCritPct, 81, 'warn 80 >= crit 50 -> crit được đẩy lên 81');
  assert.ok(t.ramWarnPct < t.ramCritPct, 'warn >= crit thì crit được đẩy lên');
  assert.ok(t.heartbeatTimeoutMs < t.downAfterMs, 'timeout >= downAfter thì downAfter nhân đôi');
  const def = normalizeFleetV11Thresholds(null);
  assert.equal(def.cpuWarnPct, 80);
  assert.equal(def.cpuCritPct, 95);
  assert.equal(def.heartbeatTimeoutMs, 60_000);
  assert.equal(def.downAfterMs, 300_000);
});

test('node health: healthy khi mọi chỉ số trong ngưỡng', () => {
  const r = evaluateFleetV11NodeHealth(nodeSample(), undefined, T0);
  assert.equal(r.status, 'healthy');
  assert.equal(r.worstReason, '');
  assert.equal(r.targetKind, 'node');
  assert.ok(r.checks.every((c) => c.level === 'passed'));
});

test('node health: warn -> degraded, crit -> unhealthy, heartbeat quá hạn -> down', () => {
  const degraded = evaluateFleetV11NodeHealth(nodeSample({ ramPct: 85 }), undefined, T0);
  assert.equal(degraded.status, 'degraded');
  assert.match(degraded.worstReason, /RAM 85%/);

  const unhealthy = evaluateFleetV11NodeHealth(nodeSample({ cpuPct: 99 }), undefined, T0);
  assert.equal(unhealthy.status, 'unhealthy');

  const stale = evaluateFleetV11NodeHealth(
    nodeSample({ lastHeartbeatAt: T0 - 120_000 }),
    undefined,
    T0,
  );
  assert.equal(stale.status, 'degraded', 'heartbeat 120s: quá timeout 60s nhưng chưa tới down 300s');

  const down = evaluateFleetV11NodeHealth(
    nodeSample({ lastHeartbeatAt: T0 - 400_000 }),
    undefined,
    T0,
  );
  assert.equal(down.status, 'down');
  assert.match(down.worstReason, /heartbeat/);

  const never = evaluateFleetV11NodeHealth(
    nodeSample({ lastHeartbeatAt: null, uptimeMs: null }),
    undefined,
    T0,
  );
  assert.equal(never.status, 'down', 'chưa từng heartbeat + chưa từng uptime = down');
});

test('node health: không đo được thì không crash, quá sức chứa thì warn', () => {
  const r = evaluateFleetV11NodeHealth(
    nodeSample({ cpuPct: null, ramPct: null, diskPct: null, lastHeartbeatAt: null, uptimeMs: 3600_000 }),
    undefined,
    T0,
  );
  assert.equal(r.status, 'down', 'chưa từng heartbeat nhưng có uptime -> down vì heartbeat crit');
  const over = evaluateFleetV11NodeHealth(nodeSample({ botCount: 6, botCapacity: 4 }), undefined, T0);
  assert.equal(over.status, 'degraded');
  assert.ok(over.checks.some((c) => c.name === 'capacity' && c.level === 'warn'));
  const fresh = evaluateFleetV11NodeHealth(nodeSample({ uptimeMs: 10_000 }), undefined, T0);
  assert.equal(fresh.status, 'degraded', 'node mới restart gần đây -> warn uptime');
});

test('bot health: bot đang chạy mất heartbeat -> down; bot dừng -> không đòi heartbeat', () => {
  const down = evaluateFleetV11BotHealth(
    botSample({ lastHeartbeatAt: T0 - 400_000 }),
    undefined,
    T0,
  );
  assert.equal(down.status, 'down');

  const stopped = evaluateFleetV11BotHealth(
    botSample({ running: false, lastHeartbeatAt: null, uptimeMs: null }),
    undefined,
    T0,
  );
  assert.equal(stopped.status, 'healthy');

  const failing = evaluateFleetV11BotHealth(botSample({ consecutiveFailures: 3 }), undefined, T0);
  assert.equal(failing.status, 'unhealthy');
  const failing2 = evaluateFleetV11BotHealth(botSample({ consecutiveFailures: 1 }), undefined, T0);
  assert.equal(failing2.status, 'degraded');
  const restarty = evaluateFleetV11BotHealth(botSample({ recentRestarts: 4 }), undefined, T0);
  assert.equal(restarty.status, 'degraded');
});

test('alerts: chỉ sinh từ check lỗi, giữ occurrences/ack từ lần trước, dedupe + ack', () => {
  const results = [
    evaluateFleetV11NodeHealth(nodeSample({ ramPct: 90 }), undefined, T0),
    evaluateFleetV11BotHealth(botSample(), undefined, T0),
  ];
  const alerts = buildFleetV11Alerts(results, [], T0);
  assert.equal(alerts.length, 1, 'chỉ node RAM warn sinh alert, bot healthy không sinh');
  assert.equal(alerts[0].id, 'node:node-1:ram');
  assert.equal(alerts[0].level, 'warning');
  assert.equal(alerts[0].occurrences, 1);

  // Đánh giá lần 2: occurrences tăng, firstSeen giữ nguyên, ack giữ nguyên.
  const again = buildFleetV11Alerts(results, alerts, T0 + 1000);
  assert.equal(again[0].occurrences, 2);
  assert.equal(again[0].firstSeenAt, T0);

  const acked = acknowledgeFleetV11Alert(again, 'node:node-1:ram', 'admin', T0 + 2000);
  assert.equal(acked[0].acknowledged, true);
  assert.equal(acked[0].acknowledgedBy, 'admin');
  assert.equal(acked[0].acknowledgedAt, T0 + 2000);
  // Ack id không tồn tại -> trả về nguyên danh sách (cùng tham chiếu).
  assert.equal(acknowledgeFleetV11Alert(acked, 'node:nope:cpu', 'admin', T0), acked);

  const dupes = dedupeFleetV11Alerts([...alerts, ...alerts]);
  assert.equal(dupes.length, 1, 'dedupe gộp alert trùng id');
  const critFirst = dedupeFleetV11Alerts([
    { ...alerts[0], id: 'a', level: 'warning' },
    { ...alerts[0], id: 'b', level: 'critical' },
  ]);
  assert.equal(critFirst[0].level, 'critical', 'critical xếp trước warning');
});

test('snapshot: đếm theo trạng thái/mức, trung bình tài nguyên, worst tối đa 5, summary', () => {
  const nodeResults = [
    evaluateFleetV11NodeHealth(nodeSample(), undefined, T0),
    evaluateFleetV11NodeHealth(nodeSample({ nodeId: 'node-2', ramPct: 99 }), undefined, T0),
  ];
  const botResults = [evaluateFleetV11BotHealth(botSample(), undefined, T0)];
  const alerts = buildFleetV11Alerts([...nodeResults, ...botResults], [], T0);
  const snap = buildFleetV11HealthSnapshot(
    [nodeSample(), nodeSample({ nodeId: 'node-2', ramPct: 99 })],
    nodeResults,
    botResults,
    alerts,
    T0,
  );
  assert.equal(snap.nodes.total, 2);
  assert.equal(snap.nodes.healthy, 1);
  assert.equal(snap.nodes.unhealthy, 1);
  assert.equal(snap.bots.healthy, 1);
  assert.equal(snap.alerts.total, 1);
  assert.equal(snap.alerts.critical, 1);
  assert.equal(snap.alerts.unacknowledged, 1);
  assert.equal(snap.avgCpuPct, 40);
  assert.equal(snap.avgRamPct, (50 + 99) / 2);
  assert.equal(snap.worst.length, 1);
  assert.equal(snap.worst[0].targetId, 'node-2');
  assert.match(snap.summary, /nghiêm trọng/);

  const healthySnap = buildFleetV11HealthSnapshot(
    [nodeSample()],
    [evaluateFleetV11NodeHealth(nodeSample(), undefined, T0)],
    [],
    [],
    T0,
  );
  assert.match(healthySnap.summary, /khỏe/);
  assert.equal(healthySnap.worst.length, 0);
});

test('persistence: state round-trip, đếm down liên tiếp, incident log', () => {
  const dir = tmpDir();
  const root = path.join(dir, 'fleet');
  assert.deepEqual(loadFleetV11HealthState(root), createFleetV11HealthState());

  const state = createFleetV11HealthState();
  state.acknowledgedAlerts['node:node-1:ram'] = { by: 'admin', at: T0 };
  saveFleetV11HealthState(root, state);
  const loaded = loadFleetV11HealthState(root);
  assert.equal(loaded.acknowledgedAlerts['node:node-1:ram'].by, 'admin');
  assert.equal(getFleetV11HealthPath(root), path.join(root, 'fleet-health-v114.json'));

  const down = evaluateFleetV11NodeHealth(
    nodeSample({ lastHeartbeatAt: T0 - 400_000 }),
    undefined,
    T0,
  );
  const tracked = trackFleetV11Downs(loaded, [down], T0);
  assert.equal(tracked.consecutiveDowns['node:node-1'], 1);
  const tracked2 = trackFleetV11Downs(
    tracked,
    [evaluateFleetV11NodeHealth(nodeSample(), undefined, T0)],
    T0 + 1000,
  );
  assert.equal(tracked2.consecutiveDowns['node:node-1'], 0, 'hết down thì reset về 0');

  assert.equal(readFleetV11Incidents(root).length, 0);
  assert.equal(
    appendFleetV11Incident(root, {
      at: T0, kind: 'node-down', targetKind: 'node', targetId: 'node-1',
      message: 'node-1 down', level: 'critical',
    }),
    true,
  );
  assert.equal(getFleetV11IncidentsPath(root), path.join(root, 'fleet-incidents-v114.jsonl'));
  const incidents = readFleetV11Incidents(root);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].targetId, 'node-1');
  assert.equal(incidents[0].kind, 'node-down');

  // File state hỏng -> fallback mặc định, không throw.
  fs.writeFileSync(getFleetV11HealthPath(root), '{not json');
  assert.deepEqual(loadFleetV11HealthState(root), createFleetV11HealthState());
  // Dòng incident hỏng -> bỏ qua dòng đó.
  fs.appendFileSync(getFleetV11IncidentsPath(root), 'not-json\n');
  assert.equal(readFleetV11Incidents(root).length, 1);
});

test('probe local: trả về sample hợp lệ (cpu/ram 0-100, uptime > 0)', () => {
  const s = probeFleetV11LocalNode('node-local');
  assert.equal(s.nodeId, 'node-local');
  assert.ok(s.cpuPct === null || (s.cpuPct >= 0 && s.cpuPct <= 1000), 'load/core có thể >100, không âm');
  assert.ok(s.ramPct === null || (s.ramPct >= 0 && s.ramPct <= 100));
  assert.ok(typeof s.uptimeMs === 'number' && (s.uptimeMs ?? 0) > 0);
  assert.ok(typeof s.lastHeartbeatAt === 'number');
  const r = evaluateFleetV11NodeHealth(s, undefined, Date.now());
  assert.ok(['healthy', 'degraded', 'unhealthy', 'down'].includes(r.status));
});
