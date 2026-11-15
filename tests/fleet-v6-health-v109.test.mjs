/**
 * Tests for fleet health v6 (packages/core/src/fleet/fleetV6Health.ts).
 *
 * Covers: health check derivation (healthy / degraded / unhealthy /
 * down, heartbeat staleness, quota breach, recent errors, never-seen
 * heartbeat), restart decisions (exponential backoff, cap, exhausted
 * after maxRestarts in window, no restart once unhealthy), crash
 * recording (consecutive failures, unhealthy marking, healthy reset),
 * and the incident log (append/list/filter, corrupt line skipped).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-v6-health-v109.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_FLEET_V6_RESTART_POLICY,
  appendFleetV6Incident,
  checkFleetV6BotHealth,
  createFleetV6Incident,
  decideFleetV6Restart,
  emptyFleetV6BotHealthState,
  fleetV6RestartBackoffMs,
  formatFleetV6IncidentLine,
  listFleetV6Incidents,
  loadFleetV6HealthStates,
  recordFleetV6Crash,
  recordFleetV6HealthCheck,
  recordFleetV6Restart,
  saveFleetV6HealthStates,
} from '../packages/core/dist/fleet/fleetV6Health.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v6-health-'));
}

const GB = 1024 ** 3;
const T0 = 1792000000000;

function healthyInput(overrides = {}) {
  return {
    botId: 'bot-1',
    lastHeartbeatAt: T0 - 5_000,
    serviceState: 'running',
    usage: { cpuCoresUsed: 0.5, ramBytesUsed: 1 * GB, diskBytesUsed: 5 * GB },
    quota: {
      botId: 'bot-1',
      cpuCoresMax: 2,
      ramBytesMax: 4 * GB,
      diskBytesMax: 20 * GB,
      warnPercent: 0.8,
      enabled: true,
      updatedAt: new Date(T0).toISOString(),
      updatedBy: 'admin',
    },
    recentErrors: [],
    consecutiveFailures: 0,
    ...overrides,
  };
}

// --- Health check -----------------------------------------------------------

test('health: fresh heartbeat + running + within quota is healthy', () => {
  const result = checkFleetV6BotHealth(healthyInput(), T0);
  assert.equal(result.status, 'healthy');
  assert.ok(result.checks.every((c) => c.ok));
  assert.equal(result.quotaLevel, 'ok');
  assert.equal(result.recentErrorCount, 0);
  assert.equal(result.lastError, null);
});

test('health: stale heartbeat degrades (not down) when service still running', () => {
  const result = checkFleetV6BotHealth(healthyInput({ lastHeartbeatAt: T0 - 120_000 }), T0);
  assert.equal(result.status, 'degraded');
  const hb = result.checks.find((c) => c.name === 'heartbeat');
  assert.equal(hb.ok, false);
  assert.match(hb.detail, /stale/);
});

test('health: never-seen heartbeat or service error is down', () => {
  const noBeat = checkFleetV6BotHealth(healthyInput({ lastHeartbeatAt: null }), T0);
  assert.equal(noBeat.status, 'down');
  const errored = checkFleetV6BotHealth(healthyInput({ serviceState: 'error' }), T0);
  assert.equal(errored.status, 'down');
});

test('health: over quota degrades; near quota stays healthy', () => {
  const over = checkFleetV6BotHealth(
    healthyInput({ usage: { cpuCoresUsed: 3, ramBytesUsed: 1 * GB, diskBytesUsed: 5 * GB } }),
    T0,
  );
  assert.equal(over.status, 'degraded');
  assert.equal(over.quotaLevel, 'breach');
  const near = checkFleetV6BotHealth(
    healthyInput({ usage: { cpuCoresUsed: 1.7, ramBytesUsed: 1 * GB, diskBytesUsed: 5 * GB } }),
    T0,
  );
  assert.equal(near.quotaLevel, 'warning');
  assert.equal(near.status, 'healthy');
});

test('health: many recent errors degrade; 3 consecutive failures mark unhealthy', () => {
  const errors = [
    { at: T0 - 1000, message: 'boom 3' },
    { at: T0 - 2000, message: 'boom 2' },
    { at: T0 - 3000, message: 'boom 1' },
  ];
  const result = checkFleetV6BotHealth(healthyInput({ recentErrors: errors }), T0);
  assert.equal(result.status, 'degraded');
  assert.equal(result.recentErrorCount, 3);
  assert.equal(result.lastError, 'boom 3');
  const unhealthy = checkFleetV6BotHealth(healthyInput({ consecutiveFailures: 3 }), T0);
  assert.equal(unhealthy.status, 'unhealthy');
  assert.equal(unhealthy.markedUnhealthy, true);
});

test('health: unmeasured usage reports unknown, never guesses ok', () => {
  const result = checkFleetV6BotHealth(healthyInput({ usage: null }), T0);
  assert.equal(result.status, 'healthy');
  assert.equal(result.quotaLevel, null);
  const resources = result.checks.find((c) => c.name === 'resources');
  assert.match(resources.detail, /not measured/);
});

// --- Restart decisions ------------------------------------------------------

test('restart: backoff doubles each attempt and caps at max', () => {
  const policy = DEFAULT_FLEET_V6_RESTART_POLICY;
  assert.equal(fleetV6RestartBackoffMs(policy, 1), 5_000);
  assert.equal(fleetV6RestartBackoffMs(policy, 2), 10_000);
  assert.equal(fleetV6RestartBackoffMs(policy, 3), 20_000);
  assert.equal(fleetV6RestartBackoffMs(policy, 4), 40_000);
  assert.equal(fleetV6RestartBackoffMs(policy, 10), 300_000); // capped
  assert.throws(() => fleetV6RestartBackoffMs(policy, 0), />= 1/);
});

test('restart: first crash restarts with base delay; later crashes back off more', () => {
  const policy = DEFAULT_FLEET_V6_RESTART_POLICY;
  // History BAO GỒM lần crash vừa xảy ra: 1 crash -> attempt 1, delay base.
  const first = decideFleetV6Restart(policy, [T0], 0, T0);
  assert.equal(first.shouldRestart, true);
  assert.equal(first.delayMs, 5_000);
  assert.equal(first.attempt, 1);
  assert.equal(first.exhausted, false);
  const third = decideFleetV6Restart(policy, [T0 - 1000, T0 - 2000, T0 - 3000], 2, T0);
  assert.equal(third.shouldRestart, true);
  assert.equal(third.delayMs, 20_000);
  assert.equal(third.attempt, 3);
});

test('restart: exhausted after maxRestarts in the window; old crashes fall out of window', () => {
  const policy = DEFAULT_FLEET_V6_RESTART_POLICY;
  // Ngưỡng unhealthy cao hơn để chạm exhausted trước (bot chưa bị đánh dấu unhealthy).
  const widePolicy = { ...policy, unhealthyAfterFailures: 10 };
  // 6 crash trong cửa sổ > maxRestarts (5) -> lần thứ 6 exhausted.
  const history = [T0 - 1000, T0 - 2000, T0 - 3000, T0 - 4000, T0 - 5000, T0 - 6000];
  const exhausted = decideFleetV6Restart(widePolicy, history, 4, T0);
  assert.equal(exhausted.shouldRestart, false);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.reason, 'exhausted');
  // Crash cũ hơn cửa sổ 1h không tính.
  const oldHistory = [T0 - 2 * 60 * 60 * 1000, T0 - 3 * 60 * 60 * 1000];
  const fresh = decideFleetV6Restart(policy, oldHistory, 0, T0);
  assert.equal(fresh.shouldRestart, true);
  assert.equal(fresh.attempt, 1);
});

test('restart: unhealthy bot (3 consecutive failures) never auto-restarts', () => {
  const policy = DEFAULT_FLEET_V6_RESTART_POLICY;
  const decision = decideFleetV6Restart(policy, [T0 - 1000], 3, T0);
  assert.equal(decision.shouldRestart, false);
  assert.equal(decision.reason, 'unhealthy');
  assert.equal(decision.exhausted, false);
});

// --- Crash / state recording ------------------------------------------------

test('crash recording: consecutive failures grow, unhealthy at 3, healthy check resets', () => {
  let states = [];
  states = recordFleetV6Crash(states, 'bot-1', T0, 'segfault');
  assert.equal(states[0].consecutiveFailures, 1);
  assert.equal(states[0].unhealthy, false);
  states = recordFleetV6Crash(states, 'bot-1', T0 + 1000, 'segfault again');
  states = recordFleetV6Crash(states, 'bot-1', T0 + 2000, 'segfault third');
  assert.equal(states[0].consecutiveFailures, 3);
  assert.equal(states[0].unhealthy, true);
  assert.equal(states[0].crashHistory.length, 3);
  // Health check healthy -> reset đếm + bỏ unhealthy.
  const healthy = checkFleetV6BotHealth(healthyInput(), T0 + 3000);
  states = recordFleetV6HealthCheck(states, healthy);
  assert.equal(states[0].consecutiveFailures, 0);
  assert.equal(states[0].unhealthy, false);
  assert.equal(states[0].lastStatus, 'healthy');
});

test('restart recording: restart history kept inside window', () => {
  let states = [emptyFleetV6BotHealthState('bot-1', T0)];
  states = recordFleetV6Restart(states, 'bot-1', T0);
  states = recordFleetV6Restart(states, 'bot-1', T0 + 1000);
  assert.equal(states[0].restartHistory.length, 2);
});

test('health states: file round-trip', () => {
  const dir = tmpDir();
  assert.deepEqual(loadFleetV6HealthStates(dir), []);
  let states = [];
  states = recordFleetV6Crash(states, 'bot-1', T0, 'boom');
  saveFleetV6HealthStates(dir, states);
  const loaded = loadFleetV6HealthStates(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].consecutiveFailures, 1);
  assert.equal(loaded[0].lastError, 'boom');
});

// --- Incident log -----------------------------------------------------------

test('incidents: append/list/filter/limit, corrupt line skipped', () => {
  const dir = tmpDir();
  assert.deepEqual(listFleetV6Incidents(dir), []);
  appendFleetV6Incident(dir, createFleetV6Incident('bot-1', 'crash', 'segfault', T0));
  appendFleetV6Incident(dir, createFleetV6Incident('bot-1', 'restart', 'restarted after 5s', T0 + 5000));
  appendFleetV6Incident(dir, createFleetV6Incident('bot-2', 'crash', 'oom', T0 + 10000));
  const all = listFleetV6Incidents(dir);
  assert.equal(all.length, 3);
  assert.equal(all[0].botId, 'bot-2'); // mới nhất trước
  assert.deepEqual(listFleetV6Incidents(dir, { botId: 'bot-1' }).map((i) => i.kind), ['restart', 'crash']);
  assert.deepEqual(listFleetV6Incidents(dir, { kind: 'crash' }).map((i) => i.botId), ['bot-2', 'bot-1']);
  assert.equal(listFleetV6Incidents(dir, { limit: 1 }).length, 1);
  assert.equal(listFleetV6Incidents(dir, { since: T0 + 6000 }).length, 1);
  // Dòng hỏng trong file: bỏ qua, không crash.
  fs.appendFileSync(path.join(dir, 'fleet-incidents-v109.jsonl'), 'not json at all\n');
  assert.equal(listFleetV6Incidents(dir).length, 3);
  const line = formatFleetV6IncidentLine(all[0]);
  assert.match(line, /bot-2 crash: oom/);
});

test('incidents: same-millisecond timestamps keep append order, newest first', () => {
  // v1.09 merge fix (hồi quy cho flake merge4): 2 crash + 1 restart ghi trong
  // cùng 1 ms phải liệt kê restart trước — sort chỉ theo `at` sẽ giữ nguyên
  // thứ tự ghi (stable sort) và trả crash trước, làm test round-trip fail.
  const dir = tmpDir();
  appendFleetV6Incident(dir, createFleetV6Incident('bot-1', 'crash', 'segfault', T0));
  appendFleetV6Incident(dir, createFleetV6Incident('bot-1', 'crash', 'segfault again', T0));
  appendFleetV6Incident(dir, createFleetV6Incident('bot-1', 'restart', 'restarted after 5s', T0));
  const all = listFleetV6Incidents(dir);
  assert.equal(all.length, 3);
  assert.equal(all[0].kind, 'restart');
  assert.equal(all[1].message, 'segfault again');
  assert.equal(all[2].message, 'segfault');
});

test('incidents: validation rejects bad kind / empty message', () => {
  assert.throws(() => createFleetV6Incident('bot-1', 'nope', 'x', T0), /kind/);
  assert.throws(() => createFleetV6Incident('bot-1', 'crash', '', T0), /message/);
});
