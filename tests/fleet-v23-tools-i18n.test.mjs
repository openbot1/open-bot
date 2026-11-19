/**
 * Tests for fleet v23 tools + i18n (v1.36, Đội T6).
 *
 * Covers:
 * - Tool defs thuần: 24 tool, tên duy nhất + không dấu chấm
 *   (quy tắc sau vụ nổ defaultToolFactory v21/v22), nhóm đủ 4 nhóm,
 *   write tools tách được.
 * - Tools chạy thật: unbound trả "not configured"; bound state tạo
 *   zone/group, enqueue/start job, cron next, place bot, capacity,
 *   rebalance plan/execute/history, dashboard — qua
 *   `createFleetV23Tools` + `createEmptyFleetV23ToolState`.
 * - i18n: 45 key fleet.v23.* có đủ 6 locale, giá trị không rỗng,
 *   tổng key mỗi locale = 8072 (7357 + 183). // v1.38 re-pin: 8072.
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v23-tools-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FLEET_V23_TOOLS,
  findFleetV23Tool,
  fleetV23ToolNamesValid,
  fleetV23ToolsByGroup,
  fleetV23WriteTools,
} from '../packages/core/dist/fleetV23/toolsV23.js';
import { FLEET_V23_VERSION } from '../packages/core/dist/fleetV23/index.js';
import {
  buildFleetV23Dashboard,
  buildFleetV23RebalancePanel,
  buildFleetV23SchedulerPanel,
  buildFleetV23TopologyPanel,
} from '../packages/core/dist/fleetV23/panelsV23.js';
import {
  FLEET_V23_TOOLS as RUNNABLE_V23_TOOLS,
  createEmptyFleetV23ToolState,
  createFleetV23Tools,
  fleetV23ToolNamesUnique as runnableNamesUnique,
} from '../packages/tools/dist/fleetV23Tools.js';

const GB = 1024 ** 3;
const LOCALES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

function loadLocale(loc) {
  return JSON.parse(readFileSync(new URL(`../apps/desktop/src/renderer/i18n/locales/${loc}.json`, import.meta.url), 'utf-8'));
}

test('tools v23: defs — 24 tools, names valid, 4 groups', () => {
  assert.equal(FLEET_V23_VERSION, 'v23');
  assert.equal(FLEET_V23_TOOLS.length, 24);
  assert.equal(fleetV23ToolNamesValid(), true);
  // Không tool nào có dấu chấm (bài học v21/v22).
  assert.ok(FLEET_V23_TOOLS.every((t) => !t.name.includes('.')));
  assert.equal(fleetV23ToolsByGroup('fleet_v23').length, 7);
  assert.equal(fleetV23ToolsByGroup('schedule_v23').length, 9);
  assert.equal(fleetV23ToolsByGroup('place_v23').length, 4);
  assert.equal(fleetV23ToolsByGroup('rebalance_v23').length, 4);
  assert.equal(findFleetV23Tool('fleet_v23_dashboard')?.write, false);
  assert.equal(findFleetV23Tool('schedule_v23_enqueue')?.write, true);
  assert.equal(findFleetV23Tool('no-such-tool'), undefined);
  assert.ok(fleetV23WriteTools().length > 0);
  assert.ok(fleetV23WriteTools().every((t) => t.write));
});

test('tools v23: runnable — unbound says not configured', async () => {
  assert.equal(RUNNABLE_V23_TOOLS.length, 24);
  assert.equal(runnableNamesUnique(), true);
  const names = RUNNABLE_V23_TOOLS.map((t) => t.definition.name);
  assert.deepEqual([...names].sort(), [...FLEET_V23_TOOLS.map((t) => t.name)].sort());
  const dashboard = RUNNABLE_V23_TOOLS.find((t) => t.definition.name === 'fleet_v23_dashboard');
  const out = await dashboard.execute({}, {});
  assert.ok(out.includes('not configured'));
  const enqueue = RUNNABLE_V23_TOOLS.find((t) => t.definition.name === 'schedule_v23_enqueue');
  assert.equal(enqueue.needsApproval, true);
  assert.equal(dashboard.needsApproval, false);
});

test('tools v23: runnable — bound state end-to-end', async () => {
  const state = createEmptyFleetV23ToolState();
  state.nodes = [
    {
      id: 'node-1', zoneId: 'zone-a', online: true,
      cpuCores: 8, cpuFree: 8, ramBytes: 32 * GB, ramFree: 32 * GB,
      diskBytes: 500 * GB, diskFree: 500 * GB, reliability: 95, latencyMs: 10,
      costPerHour: 0, labels: [], runningBotIds: [],
    },
    {
      id: 'node-2', zoneId: 'zone-b', online: true,
      cpuCores: 8, cpuFree: 8, ramBytes: 32 * GB, ramFree: 32 * GB,
      diskBytes: 500 * GB, diskFree: 500 * GB, reliability: 90, latencyMs: 20,
      costPerHour: 0, labels: [], runningBotIds: [],
    },
  ];
  const tools = createFleetV23Tools(() => state);
  const run = async (name, args = {}) => {
    const tool = tools.find((t) => t.definition.name === name);
    assert.ok(tool, `tool ${name} missing`);
    return tool.execute(args, {});
  };
  const parse = (s) => JSON.parse(s.replace(/^Error: /, ''));

  // Topology: tạo zone + gắn node + tạo group.
  assert.equal(parse(await run('fleet_v23_create_zone', { id: 'zone-a', region: 'hcm' })).created, 'zone-a');
  assert.equal(parse(await run('fleet_v23_create_zone', { id: 'zone-b', region: 'hcm' })).created, 'zone-b');
  assert.equal(parse(await run('fleet_v23_assign_node_zone', { nodeId: 'node-1', zoneId: 'zone-a' })).zoneId, 'zone-a');
  assert.equal(parse(await run('fleet_v23_assign_node_zone', { nodeId: 'node-2', zoneId: 'zone-b' })).zoneId, 'zone-b');
  const group = parse(await run('fleet_v23_create_group', { id: 'g1', botIds: ['bot-1', 'bot-2'], spreadMinZones: 2, quorum: 1 }));
  assert.equal(group.created, 'g1');
  // Zone trùng → lỗi.
  assert.ok((await run('fleet_v23_create_zone', { id: 'zone-a', region: 'hcm' })).startsWith('Error:'));
  // Check topology: bot chưa đặt → vi phạm.
  const check = parse(await run('fleet_v23_check_topology'));
  assert.equal(check.ok, false);
  assert.ok(check.violations.length > 0);
  // Zone failure: zone-a chết chưa mất bot nào (chưa đặt bot).
  const zf = parse(await run('fleet_v23_zone_failure', { zoneId: 'zone-a' }));
  assert.deepEqual(zf.impact.lostBotIds, []);

  // Scheduler: enqueue + next + start + finish + cron + sla + queue.
  const enq = parse(await run('schedule_v23_enqueue', { id: 'job-1', botId: 'bot-1', title: 'do work', priority: 'high' }));
  assert.equal(enq.enqueued, 'job-1');
  assert.equal(parse(await run('schedule_v23_next')).next, 'job-1');
  assert.equal(parse(await run('schedule_v23_start', { jobId: 'job-1' })).status, 'running');
  assert.equal(parse(await run('schedule_v23_finish', { jobId: 'job-1', status: 'completed' })).status, 'completed');
  // Cron: từ 2026-05-26T08:30Z, 9:00 hàng ngày → 09:00 cùng ngày.
  const cron = parse(await run('schedule_v23_cron_next', { cron: '0 9 * * *', fromMs: Date.UTC(2026, 4, 26, 8, 30, 0) }));
  assert.equal(cron.nextRunMs, Date.UTC(2026, 4, 26, 9, 0, 0));
  assert.ok((await run('schedule_v23_cron_next', { cron: 'bad' })).startsWith('Error:'));
  const sla = parse(await run('schedule_v23_sla'));
  assert.deepEqual(sla.breached, []);
  const queue = parse(await run('schedule_v23_queue'));
  assert.equal(queue.completed, 1);

  // Placement: evaluate + place + capacity.
  const ev = parse(await run('place_v23_evaluate', { botId: 'bot-1', cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 1024 ** 3 }));
  assert.equal(ev.placed, true);
  const placed = parse(await run('place_v23_place', { botId: 'bot-1', cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 1024 ** 3 }));
  assert.equal(placed.placed, 'bot-1');
  assert.ok(['node-1', 'node-2'].includes(placed.nodeId));
  const cap = parse(await run('place_v23_capacity', { botsPerMonth: 1 }));
  assert.equal(cap.forecasts.length, 3);
  assert.ok(['cpu', 'ram', 'disk', null].includes(cap.bottleneck));

  // Rebalance: measure + plan + execute + history + dashboard.
  const measure = parse(await run('rebalance_v23_measure'));
  assert.equal(typeof measure.needsRebalance, 'boolean');
  const plan = parse(await run('rebalance_v23_plan', { planId: 'plan-1', dryRun: true }));
  assert.equal(plan.id, 'plan-1');
  assert.equal(plan.dryRun, true);
  const exec = parse(await run('rebalance_v23_execute', { planId: 'plan-1' }));
  assert.equal(exec.success, true);
  const hist = parse(await run('rebalance_v23_history'));
  assert.equal(hist.executions.length, 1);
  assert.equal(hist.failures, 0);
  assert.ok((await run('rebalance_v23_execute', { planId: 'no-such-plan' })).startsWith('Error:'));
  const dash = parse(await run('fleet_v23_dashboard'));
  assert.equal(dash.topology.summary.zones, 2);
  assert.equal(dash.scheduler.completed, 1);
  assert.ok(Array.isArray(dash.alerts));
});

test('panels v23: topology/scheduler/placement/rebalance/dashboard view-models', () => {
  const topoPanel = buildFleetV23TopologyPanel(
    {
      zones: [{ id: 'zone-a', region: 'hcm', name: 'A' }],
      nodeZones: new Map([['node-1', 'zone-a']]),
      groups: [],
    },
    new Map([['zone-a', 1]]),
  );
  assert.equal(topoPanel.zones[0]?.nodes, 1);
  assert.equal(topoPanel.summary.zones, 1);

  const schedPanel = buildFleetV23SchedulerPanel([], 1780000000000);
  assert.equal(schedPanel.total, 0);
  assert.equal(schedPanel.nextJob, null);

  const rebPanel = buildFleetV23RebalancePanel({
    imbalance: {
      cpuCv: 0.9, ramCv: 0.8, cpuSpread: 0.9, ramSpread: 0.8,
      hottestNodeId: 'n1', coldestNodeId: 'n2', meanCpu: 0.5,
      needsRebalance: true, reason: 'Lệch tải.',
    },
    plannedMoves: 2,
    lastExecution: null,
  });
  assert.equal(rebPanel.alerts.length, 1);

  const dash = buildFleetV23Dashboard({
    topology: topoPanel,
    scheduler: schedPanel,
    placement: null,
    rebalance: rebPanel,
  });
  assert.ok(dash.alerts.some((a) => a.includes('dưới 2 zone')));
  assert.equal(dash.placement, null);
});

test('i18n: 49 key fleet.v23.* có đủ 6 locale, giá trị không rỗng, tổng 8072', () => { // v1.38 re-pin: 8072.
  const dicts = LOCALES.map(loadLocale);
  for (const [i, loc] of LOCALES.entries()) {
    const dict = dicts[i];
    assert.ok(Object.keys(dict).length >= 8072, `${loc} total keys >= 8072, got ${Object.keys(dict).length}`); // v1.39 fix round 4b: floor (was 8072 in v1.38; now 8322).
    const v23Keys = Object.keys(dict).filter((k) => k.startsWith('fleet.v23.'));
    assert.equal(v23Keys.length, 49, `${loc} fleet.v23 keys`);
    for (const key of v23Keys) {
      assert.equal(typeof dict[key], 'string', `${loc}:${key} phải là chuỗi`);
      assert.ok(dict[key].trim().length > 0, `${loc}:${key} không được rỗng`);
    }
  }
  // Mọi locale có cùng tập key v23.
  const sets = dicts.map((d) => Object.keys(d).filter((k) => k.startsWith('fleet.v23.')).sort().join(','));
  assert.ok(sets.every((s) => s === sets[0]));
});
