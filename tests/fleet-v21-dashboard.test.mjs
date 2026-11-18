/**
 * Tests for the fleet v21 dashboard + registered tools (v1.34, Đội T6).
 *
 * Covers:
 * - Node panel: totals, overloaded/dead ids, rows sorted by load.
 * - Run panel: lifetime-cap violations, orphaned runs (node gone).
 * - Automation panel: dead-letter ids, consecutively-failing ids.
 * - Dashboard: aggregated summary, attention sorted errors-first,
 *   badge counts, recent placements (newest first).
 * - Core tool defs: 18 tools, unique names, write tools flagged.
 * - Tools package: all 18 tools in ALL_TOOLS exactly once;
 *   unbound tools answer NOT_WIRED; bound tools schedule/place/list
 *   automations and render the dashboard from live state; binding
 *   via createDefaultTools never duplicates names.
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v21-dashboard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AutomationV2Store } from '../packages/core/dist/durable/automationV2.js';
import { createFleetV21Node } from '../packages/core/dist/fleetV21/nodes.js';
import { FleetV21PlacementLog } from '../packages/core/dist/fleetV21/placement.js';
import {
  buildFleetV21AutomationPanel,
  buildFleetV21Dashboard,
  buildFleetV21NodePanel,
  buildFleetV21RunPanel,
} from '../packages/core/dist/fleetV21/panelsV21.js';
import {
  FLEET_V21_TOOLS,
  findFleetV21Tool,
  fleetV21ToolNamesUnique,
  fleetV21ToolsByGroup,
  fleetV21WriteTools,
} from '../packages/core/dist/fleetV21/toolsV21.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { FLEET_V21_TOOL_NAMES, FLEET_V21_TOOLS as FLEET_V21_RUNNABLE_TOOLS, createFleetV21Tools } from '../packages/tools/dist/fleetV21Tools.js';

const GB = 1024 ** 3;
const NOW = 1780000000000;

function makeNode(id, overrides = {}) {
  return createFleetV21Node({
    id,
    name: id,
    maxTier: 'bwrap',
    cpuCores: 10,
    ramBytes: 32 * GB,
    diskBytes: 200 * GB,
    latencyMs: 10,
    now: NOW,
    ...overrides,
  });
}

function fleetFixture() {
  const nodes = [
    makeNode('node-over', { cpuUsed: 9.5, ramUsed: 30 * GB, runCount: 3 }),
    { ...makeNode('node-dead'), status: 'dead', statusReason: 'mất heartbeat 400s', runCount: 1 },
    makeNode('node-ok', { maxTier: 'microvm', cpuUsed: 2, ramUsed: 4 * GB, runCount: 1 }),
  ];
  const runs = [
    { runId: 'run-old', botId: 'bot-1', nodeId: 'node-ok', minTier: 'bwrap', startedAt: NOW - 2 * 3600 * 1000, maxLifetimeMs: 3600 * 1000 },
    { runId: 'run-ok', botId: 'bot-2', nodeId: 'node-ok', minTier: 'microvm', startedAt: NOW - 60000 },
    { runId: 'run-orphan', botId: 'bot-3', nodeId: 'node-gone', minTier: 'bwrap', startedAt: NOW - 60000 },
    { runId: 'run-stranded', botId: 'bot-4', nodeId: 'node-dead', minTier: 'bwrap', startedAt: NOW - 60000 },
  ];
  const store = new AutomationV2Store(null);
  store.add({
    id: 'auto-dead',
    name: 'Dead automation',
    trigger: { kind: 'schedule', intervalMs: 60000 },
    action: { kind: 'run-bot', botId: 'bot-1' },
    maxAttempts: 1,
  }, NOW);
  store.add({
    id: 'auto-failing',
    name: 'Failing automation',
    trigger: { kind: 'schedule', intervalMs: 60000 },
    action: { kind: 'run-bot', botId: 'bot-1' },
    maxAttempts: 5,
  }, NOW);
  store.add({
    id: 'auto-ok',
    name: 'Healthy automation',
    trigger: { kind: 'event', eventPattern: 'bot.*' },
    action: { kind: 'run-bot', botId: 'bot-2' },
  }, NOW);
  return { nodes, runs, store };
}

async function driveToStates(store) {
  // auto-dead: one failure with maxAttempts 1 -> dead-letter.
  await assert.rejects(() => store.runOne('auto-dead', async () => { throw new Error('dead boom'); }, NOW));
  // auto-failing: two failures -> consecutiveFailures 2 (not dead-letter yet).
  await assert.rejects(() => store.runOne('auto-failing', async () => { throw new Error('fail 1'); }, NOW));
  await assert.rejects(() => store.runOne('auto-failing', async () => { throw new Error('fail 2'); }, NOW + 1000));
  // auto-ok: one success.
  await store.runOne('auto-ok', async () => 'ok', NOW);
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

test('dashboard: node panel totals, overload and dead flags', () => {
  const { nodes } = fleetFixture();
  const panel = buildFleetV21NodePanel(nodes, NOW);
  assert.equal(panel.total, 3);
  assert.equal(panel.online, 2);
  assert.equal(panel.dead, 1);
  assert.equal(panel.overloaded, 1);
  assert.deepEqual(panel.overloadedNodeIds, ['node-over']);
  assert.deepEqual(panel.deadNodeIds, ['node-dead']);
  assert.equal(panel.totalRuns, 5);
  // Rows are sorted by load, heaviest first.
  assert.equal(panel.rows[0].id, 'node-over');
  assert.equal(panel.rows[0].overloaded, true);
  assert.equal(panel.rows[0].load > 0.9, true);
  assert.match(panel.summary, /2\/3 node online/);
});

test('dashboard: node panel with no nodes explains itself', () => {
  const panel = buildFleetV21NodePanel([], NOW);
  assert.equal(panel.total, 0);
  assert.match(panel.summary, /chưa có node/);
});

test('dashboard: run panel flags lifetime-cap and orphaned runs', () => {
  const { nodes, runs } = fleetFixture();
  const panel = buildFleetV21RunPanel(runs, nodes, NOW);
  assert.equal(panel.total, 4);
  assert.equal(panel.overLifetimeCap, 1);
  assert.deepEqual(panel.overLifetimeCapRunIds, ['run-old']);
  assert.equal(panel.orphaned, 1);
  assert.deepEqual(panel.orphanedRunIds, ['run-orphan']);
  assert.equal(panel.byTier.bwrap, 3);
  assert.equal(panel.byTier.microvm, 1);
  assert.equal(panel.byNode['node-ok'], 2);
  const old = panel.rows.find((r) => r.runId === 'run-old');
  assert.equal(old.overLifetimeCap, true);
  assert.equal(old.msToCap < 0, true);
  const orphan = panel.rows.find((r) => r.runId === 'run-orphan');
  assert.equal(orphan.nodeExists, false);
});

test('dashboard: automation panel flags dead-letter and failing automations', async () => {
  const { store } = fleetFixture();
  await driveToStates(store);
  const panel = buildFleetV21AutomationPanel(store.list(), NOW);
  assert.equal(panel.total, 3);
  assert.equal(panel.deadLetter, 1);
  assert.deepEqual(panel.deadLetterIds, ['auto-dead']);
  assert.equal(panel.failingConsecutively, 1);
  assert.deepEqual(panel.failingIds, ['auto-failing']);
  const dead = panel.rows.find((r) => r.id === 'auto-dead');
  assert.equal(dead.lastError, 'dead boom');
  const ok = panel.rows.find((r) => r.id === 'auto-ok');
  assert.equal(ok.totalSuccesses, 1);
  assert.equal(ok.triggerKind, 'event');
  assert.equal(ok.triggerLabel, 'event bot.*');
});

// ---------------------------------------------------------------------------
// Aggregated dashboard
// ---------------------------------------------------------------------------

test('dashboard: aggregated view sorts attention errors first with badge counts', async () => {
  const { nodes, runs, store } = fleetFixture();
  await driveToStates(store);
  const log = new FleetV21PlacementLog();
  log.record({ runId: 'run-ok', botId: 'bot-2', nodeId: 'node-ok', kind: 'place', reason: 'test', minTier: 'microvm', at: NOW });
  const view = buildFleetV21Dashboard({ nodes, runs, automations: store.list(), placementHistory: log.list(), now: NOW });
  assert.equal(view.counts.nodesTotal, 3);
  assert.equal(view.counts.nodesOnline, 2);
  assert.equal(view.counts.nodesOverloaded, 1);
  assert.equal(view.counts.runsTotal, 4);
  assert.equal(view.counts.runsOverLifetimeCap, 1);
  assert.equal(view.counts.automationsTotal, 3);
  assert.equal(view.counts.automationsDeadLetter, 1);
  assert.equal(view.counts.automationsFailing, 1);
  assert.ok(view.attentionCount > 0);
  // Errors come before warnings.
  const firstWarning = view.attention.findIndex((a) => a.level === 'warning');
  const errorsAfterWarning = view.attention.slice(firstWarning).filter((a) => a.level === 'error');
  assert.deepEqual(errorsAfterWarning, []);
  assert.equal(view.attention[0].level, 'error');
  const messages = view.attention.map((a) => a.message).join('\n');
  assert.match(messages, /node-dead/);
  assert.match(messages, /run-old/);
  assert.match(messages, /auto-dead/);
  assert.match(messages, /node-over/);
  assert.match(messages, /auto-failing/);
  assert.equal(view.recentPlacements.length, 1);
  assert.equal(view.recentPlacements[0].runId, 'run-ok');
  assert.match(view.summary, /2\/3 node online/);
});

test('dashboard: empty fleet has no attention and says so', () => {
  const view = buildFleetV21Dashboard({ nodes: [], runs: [], automations: [], now: NOW });
  assert.equal(view.attentionCount, 0);
  assert.deepEqual(view.attention, []);
  assert.equal(view.counts.nodesTotal, 0);
  assert.match(view.summary, /Không có mục nào cần chú ý/);
});

// ---------------------------------------------------------------------------
// Core tool definitions
// ---------------------------------------------------------------------------

test('toolsV21: 18 pure definitions, unique names, write tools flagged', () => {
  assert.equal(FLEET_V21_TOOLS.length, 18);
  assert.equal(fleetV21ToolNamesUnique(), true);
  assert.deepEqual(fleetV21ToolsByGroup('scheduler_v21').map((t) => t.name), [
    'scheduler_v21_schedule',
    'scheduler_v21_evaluate',
    'scheduler_v21_node_scores',
  ]);
  assert.equal(fleetV21ToolsByGroup('placement_v21').length, 4);
  assert.equal(fleetV21ToolsByGroup('automation_v21').length, 7);
  assert.equal(fleetV21ToolsByGroup('fleet_v21').length, 4);
  const writes = fleetV21WriteTools().map((t) => t.name);
  assert.ok(writes.includes('placement_v21_place_runs'));
  assert.ok(writes.includes('automation_v21_create'));
  assert.ok(writes.includes('automation_v21_run_due'));
  assert.ok(!writes.includes('fleet_v21_dashboard'));
  assert.ok(!writes.includes('scheduler_v21_schedule'));
  assert.equal(findFleetV21Tool('fleet_v21_dashboard')?.requiresAction, 'view-fleet');
  assert.equal(findFleetV21Tool('nope'), undefined);
});

// ---------------------------------------------------------------------------
// Tools package: registration + bound behaviour
// ---------------------------------------------------------------------------

test('tools package: all 18 v21 tools in ALL_TOOLS exactly once', () => {
  assert.equal(FLEET_V21_TOOL_NAMES.length, 18);
  assert.deepEqual(
    [...FLEET_V21_TOOL_NAMES].sort(),
    // Chú ý: FLEET_V21_TOOLS (core) là định nghĩa thuần {name}, còn bản
    // chạy được trong tools package là {definition:{name}} — test này
    // kiểm tra bản chạy được, phải dùng FLEET_V21_RUNNABLE_TOOLS.
    FLEET_V21_RUNNABLE_TOOLS.map((t) => t.definition.name).sort(),
  );
  for (const name of FLEET_V21_TOOL_NAMES) {
    const matches = ALL_TOOLS.filter((t) => t.definition.name === name);
    assert.equal(matches.length, 1, `${name} must appear exactly once in ALL_TOOLS`);
  }
});

test('tools package: unbound v21 tools answer NOT_WIRED instead of guessing', async () => {
  const tools = createFleetV21Tools();
  assert.equal(tools.length, 18);
  const schedule = tools.find((t) => t.definition.name === 'scheduler_v21_schedule');
  const out = await schedule.execute({
    runId: 'run-1', botId: 'bot-1', minTier: 'bwrap', cpuCores: 1, ramBytes: 1024, diskBytes: 1024,
  });
  assert.match(out, /not configured/);
  const dashboard = tools.find((t) => t.definition.name === 'fleet_v21_dashboard');
  assert.match(await dashboard.execute({}), /not configured/);
});

test('tools package: bound tools schedule, place, manage automations and render the dashboard', async () => {
  const { nodes, runs, store } = fleetFixture();
  const log = new FleetV21PlacementLog();
  const state = {
    nodes,
    runs,
    automationStore: store,
    placementLog: log,
    executor: async () => 'ok',
  };
  const tools = createFleetV21Tools(() => state);
  const byName = (name) => tools.find((t) => t.definition.name === name);

  // Schedule a microvm run: only node-ok qualifies.
  const scheduled = JSON.parse(await byName('scheduler_v21_schedule').execute({
    runId: 'run-new', botId: 'bot-9', minTier: 'microvm', cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB,
  }));
  assert.equal(scheduled.placed, true);
  assert.equal(scheduled.nodeId, 'node-ok');

  // Schedule a bwrap run too big for every node: refused with a reason.
  const refused = JSON.parse(await byName('scheduler_v21_schedule').execute({
    runId: 'run-huge', botId: 'bot-9', minTier: 'bwrap', cpuCores: 99, ramBytes: 1 * GB, diskBytes: 1 * GB,
  }));
  assert.equal(refused.placed, false);
  assert.match(refused.reason, /CPU\/RAM\/disk/);

  // Place two runs at once.
  const placed = JSON.parse(await byName('placement_v21_place_runs').execute({
    requests: [
      { runId: 'run-p1', botId: 'bot-1', minTier: 'bwrap', demand: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB } },
      { runId: 'run-p2', botId: 'bot-2', minTier: 'bwrap', demand: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB } },
    ],
  }));
  assert.equal(placed.placedCount, 2);
  assert.equal(log.size, 2);

  // Dashboard renders from the same live state.
  const dashboard = JSON.parse(await byName('fleet_v21_dashboard').execute({}));
  assert.equal(dashboard.counts.nodesTotal, 3);
  assert.equal(dashboard.counts.runsTotal, 4);
  assert.ok(dashboard.attentionCount > 0);
  assert.equal(dashboard.recentPlacements.length, 2);

  // Alerts tool returns only the attention list.
  const alerts = JSON.parse(await byName('fleet_v21_alerts').execute({}));
  assert.equal(alerts.attentionCount, dashboard.attentionCount);
  assert.ok(alerts.attention.length > 0);

  // Automation create/list/pause/resume through tools.
  const created = JSON.parse(await byName('automation_v21_create').execute({
    automation: {
      id: 'auto-tool', name: 'Tool automation',
      trigger: { kind: 'schedule', intervalMs: 60000 },
      action: { kind: 'run-bot', botId: 'bot-1' },
    },
  }));
  assert.equal(created.id, 'auto-tool');
  const list = JSON.parse(await byName('automation_v21_list').execute({}));
  assert.equal(list.total, 4);
  const paused = JSON.parse(await byName('automation_v21_pause').execute({ automationId: 'auto-tool' }));
  assert.equal(paused.status, 'paused');
  const resumed = JSON.parse(await byName('automation_v21_resume').execute({ automationId: 'auto-tool' }));
  assert.equal(resumed.status, 'idle');
  const traces = JSON.parse(await byName('automation_v21_traces').execute({ automationId: 'auto-tool' }));
  assert.ok(traces.length >= 2);

  // Node capacity + runs tools.
  const capacity = JSON.parse(await byName('placement_v21_node_capacity').execute({}));
  assert.equal(capacity.total, 3);
  assert.deepEqual(capacity.overloadedNodeIds, ['node-over']);
  const runsView = JSON.parse(await byName('fleet_v21_runs').execute({}));
  assert.equal(runsView.total, 4);
  assert.deepEqual(runsView.overLifetimeCapRunIds, ['run-old']);
});

test('tools package: createDefaultTools binding never duplicates v21 names', async () => {
  const { nodes, runs, store } = fleetFixture();
  const tools = createDefaultTools({
    getFleetV21State: () => ({ nodes, runs, automationStore: store, placementLog: new FleetV21PlacementLog() }),
  });
  for (const name of FLEET_V21_TOOL_NAMES) {
    const matches = tools.filter((t) => t.definition.name === name);
    assert.equal(matches.length, 1, `${name} must appear exactly once after binding`);
  }
  // Bound schedule works through createDefaultTools too.
  const schedule = tools.find((t) => t.definition.name === 'scheduler_v21_schedule');
  const out = JSON.parse(await schedule.execute({
    runId: 'run-x', botId: 'bot-1', minTier: 'bwrap', cpuCores: 1, ramBytes: 1024, diskBytes: 1024,
  }));
  assert.equal(out.placed, true);
});

test('tools package: bad tool args return Error strings, never throw', async () => {
  const { nodes, runs, store } = fleetFixture();
  const tools = createFleetV21Tools(() => ({ nodes, runs, automationStore: store, placementLog: new FleetV21PlacementLog() }));
  const byName = (name) => tools.find((t) => t.definition.name === name);
  assert.match(await byName('scheduler_v21_schedule').execute({}), /Missing required argument/);
  assert.match(
    await byName('automation_v21_create').execute({ automation: { id: 'x' } }),
    /Error:/,
  );
  assert.match(
    await byName('placement_v21_place_runs').execute({ requests: 'not-an-array' }),
    /must be an array/,
  );
  assert.match(
    await byName('automation_v21_pause').execute({ automationId: 'nope' }),
    /không tồn tại/,
  );
});
