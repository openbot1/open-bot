/**
 * Fleet v8 tests (v1.11, Đội T6 — node:test, no network).
 *
 * Covers:
 *  - checkFleetV8NodeHealth: healthy / degraded (stale heartbeat,
 *    high CPU, low RAM/disk, full bots) / unhealthy (crit thresholds)
 *    / down (missing or very old heartbeat); draining never counts
 *    against the node by itself
 *  - decideFleetV8NodeAction: healthy → none, degraded → drain,
 *    unhealthy → restart-bots with backoff, down → restart then
 *    evacuate after N consecutive downs
 *  - fleetV8RestartBackoffMs: base * 2^attempt capped at max
 *  - probeFleetV8LocalNode: real os values on this machine (cores >=
 *    1, RAM total > free >= 0); disk may be null on unsupported fs
 *  - updateFleetV8NodeTrackState: consecutive downs / restart
 *    attempts / totals, reset on healthy
 *  - incident log: append/list (newest first, kind/node filter,
 *    limit), prune keeps the newest 500, corrupt line throws
 *  - planFleetV8Rebalance: moves bots off down/unhealthy/draining/
 *    overloaded nodes; loopback destination preferred; unplaced
 *    when no healthy node has a free slot; stable order
 *  - rollupFleetV8NodeHealth: counts + worst status + needsAttention
 *  - buildFleetV8Dashboard: reads v6/v7/v8 stores (empty fleet =
 *    local node only + no alerts except none), problem bots,
 *    active campaigns, recent incidents, summary line
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v111-health.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendFleetV8Incident,
  checkFleetV8NodeHealth,
  createFleetV8Incident,
  decideFleetV8NodeAction,
  emptyFleetV8NodeTrackState,
  fleetV8RestartBackoffMs,
  listFleetV8Incidents,
  loadFleetV8NodeStates,
  planFleetV8Rebalance,
  probeFleetV8LocalNode,
  rollupFleetV8NodeHealth,
  saveFleetV8NodeStates,
  updateFleetV8NodeTrackState,
  DEFAULT_FLEET_V8_ACTION_POLICY,
  FLEET_V8_MAX_INCIDENTS,
} from '../packages/core/dist/fleet/fleetV8Health.js';
import { buildFleetV8Dashboard as buildDashboard, summarizeFleetV8Dashboard } from '../packages/core/dist/fleet/fleetV8Dashboard.js';
import { saveFleetV6HealthStates } from '../packages/core/dist/fleet/fleetV6Health.js';
import { createFleetV7Campaign, saveFleetV7Campaigns, startFleetV7Campaign } from '../packages/core/dist/fleet/fleetV7Campaign.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v111-'));
}

function healthyInput(overrides = {}) {
  return {
    nodeId: 'node-1',
    cpuCores: 4,
    cpuLoad1m: 1.0,
    ramTotalBytes: 16 * 1024 ** 3,
    ramFreeBytes: 8 * 1024 ** 3,
    diskTotalBytes: 500 * 1024 ** 3,
    diskFreeBytes: 250 * 1024 ** 3,
    heartbeatAgeMs: 5_000,
    runningBots: 1,
    maxBots: 4,
    ...overrides,
  };
}

test('fleet v8: healthy node passes every check', () => {
  const r = checkFleetV8NodeHealth(healthyInput());
  assert.equal(r.status, 'healthy');
  assert.equal(r.reasons.length, 0);
  assert.ok(r.checks.every((c) => c.ok));
  assert.equal(r.nodeId, 'node-1');
});

test('fleet v8: stale heartbeat + high CPU + low RAM/disk degrade the node', () => {
  const r = checkFleetV8NodeHealth(
    healthyInput({ heartbeatAgeMs: 90_000, cpuLoad1m: 3.8, ramFreeBytes: 1 * 1024 ** 3, diskFreeBytes: 40 * 1024 ** 3 }),
  );
  assert.equal(r.status, 'degraded');
  assert.ok(r.reasons.length >= 3);
  const byName = new Map(r.checks.map((c) => [c.name, c]));
  assert.equal(byName.get('heartbeat')?.ok, false);
  assert.equal(byName.get('cpu-load')?.ok, false);
  assert.equal(byName.get('ram-free')?.ok, false);
});

test('fleet v8: crit CPU/RAM/disk make the node unhealthy', () => {
  const r = checkFleetV8NodeHealth(
    healthyInput({ cpuLoad1m: 8, ramFreeBytes: 100 * 1024 ** 2, diskFreeBytes: 1 * 1024 ** 3 }),
  );
  assert.equal(r.status, 'unhealthy');
  assert.ok(r.reasons.some((x) => x.includes('CPU')));
  assert.ok(r.reasons.some((x) => x.includes('RAM')));
});

test('fleet v8: missing or very old heartbeat means down', () => {
  assert.equal(checkFleetV8NodeHealth(healthyInput({ heartbeatAgeMs: null })).status, 'down');
  assert.equal(checkFleetV8NodeHealth(healthyInput({ heartbeatAgeMs: 10 * 60_000 })).status, 'down');
  // Exactly at the stale threshold but under down-after: degraded, not down.
  assert.equal(checkFleetV8NodeHealth(healthyInput({ heartbeatAgeMs: 60_000 })).status, 'degraded');
});

test('fleet v8: draining alone does not degrade, full bots only warn', () => {
  const draining = checkFleetV8NodeHealth(healthyInput({ draining: true }));
  assert.equal(draining.status, 'healthy');
  const full = checkFleetV8NodeHealth(healthyInput({ runningBots: 4 }));
  assert.equal(full.status, 'degraded');
  const over = checkFleetV8NodeHealth(healthyInput({ runningBots: 5 }));
  assert.equal(over.status, 'unhealthy');
});

test('fleet v8: unknown resources are skipped, not failed', () => {
  const r = checkFleetV8NodeHealth(
    healthyInput({ cpuLoad1m: null, ramTotalBytes: null, ramFreeBytes: null, diskTotalBytes: null, diskFreeBytes: null, maxBots: null }),
  );
  assert.equal(r.status, 'healthy');
});

test('fleet v8: action decisions per status + evacuate after repeated downs', () => {
  const healthy = decideFleetV8NodeAction(checkFleetV8NodeHealth(healthyInput()));
  assert.equal(healthy.action, 'none');
  assert.equal(healthy.delayMs, 0);

  const degraded = decideFleetV8NodeAction(checkFleetV8NodeHealth(healthyInput({ heartbeatAgeMs: 90_000 })));
  assert.equal(degraded.action, 'drain');

  const unhealthy = decideFleetV8NodeAction(checkFleetV8NodeHealth(healthyInput({ cpuLoad1m: 8 })), { restartAttempts: 1 });
  assert.equal(unhealthy.action, 'restart-bots');
  assert.equal(unhealthy.delayMs, fleetV8RestartBackoffMs(DEFAULT_FLEET_V8_ACTION_POLICY, 1));

  const down = checkFleetV8NodeHealth(healthyInput({ heartbeatAgeMs: null }));
  assert.equal(decideFleetV8NodeAction(down, { consecutiveDowns: 0 }).action, 'restart-bots');
  const evac = decideFleetV8NodeAction(down, { consecutiveDowns: 2 });
  assert.equal(evac.action, 'evacuate');
  assert.equal(evac.consecutiveDowns, 3);
});

test('fleet v8: restart backoff doubles and caps', () => {
  assert.equal(fleetV8RestartBackoffMs(DEFAULT_FLEET_V8_ACTION_POLICY, 0), 5_000);
  assert.equal(fleetV8RestartBackoffMs(DEFAULT_FLEET_V8_ACTION_POLICY, 1), 10_000);
  assert.equal(fleetV8RestartBackoffMs(DEFAULT_FLEET_V8_ACTION_POLICY, 2), 20_000);
  assert.equal(fleetV8RestartBackoffMs(DEFAULT_FLEET_V8_ACTION_POLICY, 100), 5 * 60 * 1000);
  assert.equal(fleetV8RestartBackoffMs(DEFAULT_FLEET_V8_ACTION_POLICY, -3), 5_000);
});

test('fleet v8: local probe returns real machine numbers', () => {
  const probe = probeFleetV8LocalNode();
  assert.ok(probe.cpuCores >= 1);
  assert.ok(probe.ramTotalBytes > 0);
  assert.ok(probe.ramFreeBytes >= 0);
  assert.ok(probe.ramFreeBytes <= probe.ramTotalBytes);
  if (probe.diskTotalBytes !== null) {
    assert.ok(probe.diskTotalBytes > 0);
    assert.ok((probe.diskFreeBytes ?? 0) <= probe.diskTotalBytes);
  }
  assert.equal(probe.diskPath, os.homedir());
});

test('fleet v8: track state counts downs/restarts and resets on healthy', () => {
  const down = checkFleetV8NodeHealth(healthyInput({ heartbeatAgeMs: null }), {}, 1_000);
  let state = updateFleetV8NodeTrackState(undefined, down, 'restart-bots');
  assert.equal(state.consecutiveDowns, 1);
  assert.equal(state.restartAttempts, 1);
  assert.equal(state.totalDowns, 1);
  state = updateFleetV8NodeTrackState(state, down, 'evacuate');
  assert.equal(state.consecutiveDowns, 2);
  assert.equal(state.totalEvacuations, 1);
  const healthy = checkFleetV8NodeHealth(healthyInput(), {}, 2_000);
  state = updateFleetV8NodeTrackState(state, healthy, 'none');
  assert.equal(state.consecutiveDowns, 0);
  assert.equal(state.restartAttempts, 0);
  assert.equal(state.totalDowns, 2);
  assert.equal(state.lastStatus, 'healthy');
});

test('fleet v8: node states persist round-trip; corrupt file throws', () => {
  const dir = tmpDir();
  assert.deepEqual(loadFleetV8NodeStates(dir), []);
  const state = emptyFleetV8NodeTrackState('node-1', 1_000);
  saveFleetV8NodeStates(dir, [{ ...state, consecutiveDowns: 2 }]);
  const loaded = loadFleetV8NodeStates(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].nodeId, 'node-1');
  assert.equal(loaded[0].consecutiveDowns, 2);
  fs.writeFileSync(path.join(dir, 'fleet-health-v111.json'), 'not json');
  assert.throws(() => loadFleetV8NodeStates(dir));
});

test('fleet v8: incident log append/list/filter/prune', () => {
  const dir = tmpDir();
  assert.deepEqual(listFleetV8Incidents(dir), []);
  appendFleetV8Incident(dir, createFleetV8Incident('node-down', 'node-1', 'lost heartbeat', { atMs: 1_000 }));
  appendFleetV8Incident(dir, createFleetV8Incident('node-degraded', 'node-2', 'high cpu', { atMs: 2_000 }));
  appendFleetV8Incident(dir, createFleetV8Incident('node-down', 'node-1', 'still down', { botId: 'bot-1', atMs: 3_000 }));
  const all = listFleetV8Incidents(dir);
  assert.equal(all.length, 3);
  assert.equal(all[0].message, 'still down', 'newest first');
  assert.equal(all[0].botId, 'bot-1');
  assert.equal(listFleetV8Incidents(dir, { kind: 'node-down' }).length, 2);
  assert.equal(listFleetV8Incidents(dir, { nodeId: 'node-2' }).length, 1);
  assert.equal(listFleetV8Incidents(dir, { limit: 1 }).length, 1);
  assert.throws(() => createFleetV8Incident('bogus', 'node-1', 'x'));
  assert.throws(() => createFleetV8Incident('node-down', '', 'x'));
  // Prune: more than MAX keeps only the newest MAX.
  for (let i = 0; i < FLEET_V8_MAX_INCIDENTS + 10; i += 1) {
    appendFleetV8Incident(dir, createFleetV8Incident('rebalance', 'node-1', `move ${i}`, { atMs: 10_000 + i }));
  }
  assert.equal(listFleetV8Incidents(dir).length, FLEET_V8_MAX_INCIDENTS);
});

test('fleet v8: rebalance moves bots off bad nodes to loopback first', () => {
  const nodes = [
    { nodeId: 'n-down', status: 'down', loopback: false, maxBots: 2, freeFraction: 0.9, draining: false },
    { nodeId: 'n-lan', status: 'healthy', loopback: false, maxBots: 2, freeFraction: 0.9, draining: false },
    { nodeId: 'n-local', status: 'healthy', loopback: true, maxBots: 2, freeFraction: 0.1, draining: false },
  ];
  const bots = [
    { botId: 'bot-a', nodeId: 'n-down' },
    { botId: 'bot-b', nodeId: 'n-down' },
    { botId: 'bot-c', nodeId: 'n-lan' },
  ];
  const plan = planFleetV8Rebalance(nodes, bots);
  assert.equal(plan.moves.length, 2);
  assert.equal(plan.moves[0].toNodeId, 'n-local', 'loopback wins over free fraction');
  assert.equal(plan.moves[1].toNodeId, 'n-local');
  assert.equal(plan.unplaced.length, 0);
  assert.ok(plan.summary.includes('2 bot'));
});

test('fleet v8: rebalance leaves healthy bots alone and reports unplaced', () => {
  const nodes = [
    { nodeId: 'n-bad', status: 'unhealthy', loopback: false, maxBots: 1, freeFraction: 0.5, draining: false },
    { nodeId: 'n-full', status: 'healthy', loopback: false, maxBots: 1, freeFraction: 0.5, draining: false },
  ];
  const bots = [
    { botId: 'bot-x', nodeId: 'n-bad' },
    { botId: 'bot-y', nodeId: 'n-full' },
  ];
  const plan = planFleetV8Rebalance(nodes, bots);
  assert.equal(plan.moves.length, 0, 'destination is full');
  assert.equal(plan.unplaced.length, 1);
  assert.equal(plan.unplaced[0].botId, 'bot-x');
  // Draining + overloaded nodes also evacuate.
  const plan2 = planFleetV8Rebalance(
    [
      { nodeId: 'n-drain', status: 'healthy', loopback: false, maxBots: 5, freeFraction: 0.5, draining: true },
      { nodeId: 'n-ok', status: 'healthy', loopback: false, maxBots: 5, freeFraction: 0.5, draining: false },
    ],
    [{ botId: 'bot-z', nodeId: 'n-drain' }],
  );
  assert.equal(plan2.moves.length, 1);
  assert.equal(plan2.moves[0].toNodeId, 'n-ok');
  const empty = planFleetV8Rebalance(
    [{ nodeId: 'n-ok', status: 'healthy', loopback: true, maxBots: 5, freeFraction: 0.5, draining: false }],
    [{ botId: 'bot-z', nodeId: 'n-ok' }],
  );
  assert.equal(empty.moves.length, 0);
  assert.ok(empty.summary.includes('không cần chuyển'));
});

test('fleet v8: rollup counts + worst status', () => {
  const results = [
    checkFleetV8NodeHealth(healthyInput({ nodeId: 'a' })),
    checkFleetV8NodeHealth(healthyInput({ nodeId: 'b', heartbeatAgeMs: 90_000 })),
    checkFleetV8NodeHealth(healthyInput({ nodeId: 'c', heartbeatAgeMs: null })),
  ];
  const rollup = rollupFleetV8NodeHealth(results);
  assert.deepEqual(
    { total: rollup.totalNodes, healthy: rollup.healthy, degraded: rollup.degraded, down: rollup.down },
    { total: 3, healthy: 1, degraded: 1, down: 1 },
  );
  assert.equal(rollup.worstStatus, 'down');
  assert.equal(rollup.needsAttention, true);
  assert.equal(rollupFleetV8NodeHealth([]).worstStatus, 'none');
  assert.equal(rollupFleetV8NodeHealth([]).needsAttention, false);
});

test('fleet v8: dashboard on an empty fleet shows only the local node', () => {
  const dir = tmpDir();
  const snap = buildDashboard(dir, 1_000_000);
  assert.equal(snap.builtAtMs, 1_000_000);
  assert.equal(snap.nodeRows.length, 1);
  assert.equal(snap.nodeRows[0].nodeId, 'local');
  assert.equal(snap.nodeRows[0].isLocal, true);
  assert.equal(snap.totalTrackedBots, 0);
  assert.equal(snap.problemBots.length, 0);
  assert.equal(snap.totalCampaigns, 0);
  assert.equal(snap.recentIncidents.length, 0);
  assert.ok(snap.localProbe !== null);
  assert.ok(summarizeFleetV8Dashboard(snap).includes('1 node'));
});

test('fleet v8: dashboard merges v6 bots + v7 campaigns + v8 incidents', () => {
  const dir = tmpDir();
  saveFleetV6HealthStates(dir, [
    {
      botId: 'bot-bad',
      consecutiveFailures: 2,
      crashHistory: [900, 950],
      restartHistory: [],
      lastCheckAt: 950,
      lastStatus: 'unhealthy',
      unhealthy: true,
      lastError: 'boom',
      updatedAt: 950,
    },
    {
      botId: 'bot-ok',
      consecutiveFailures: 0,
      crashHistory: [],
      restartHistory: [],
      lastCheckAt: 950,
      lastStatus: 'healthy',
      unhealthy: false,
      lastError: null,
      updatedAt: 950,
    },
  ]);
  const campaign = createFleetV7Campaign({
    goal: 'rollout v111',
    bots: [
      { botId: 'bot-1', nodeId: 'n-1' },
      { botId: 'bot-2', nodeId: 'n-1' },
    ],
  });
  startFleetV7Campaign(campaign);
  saveFleetV7Campaigns(dir, [campaign]);
  appendFleetV8Incident(dir, createFleetV8Incident('node-down', 'n-1', 'lost heartbeat', { atMs: 990 }));
  saveFleetV8NodeStates(dir, [{ ...emptyFleetV8NodeTrackState('n-1', 995), lastStatus: 'down', consecutiveDowns: 1 }]);

  const snap = buildDashboard(dir, 1_000);
  assert.equal(snap.totalTrackedBots, 2);
  assert.equal(snap.problemBots.length, 1);
  assert.equal(snap.problemBots[0].botId, 'bot-bad');
  assert.equal(snap.totalCampaigns, 1);
  assert.equal(snap.activeCampaigns.length, 1);
  assert.equal(snap.activeCampaigns[0].goal, 'rollout v111');
  assert.equal(snap.recentIncidents.length, 1);
  assert.equal(snap.nodes.down, 1);
  assert.ok(snap.alerts.length >= 1);
  assert.ok(snap.alerts.some((a) => a.includes('down')));
  // Same builder via the fleet barrel import.
  const snap2 = buildDashboard(dir, 1_000);
  assert.equal(snap2.nodes.down, snap.nodes.down);
});
