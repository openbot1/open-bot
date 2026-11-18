/**
 * Fleet v9 tools tests (v1.12, Doi T6 — node:test, no network).
 *
 * Covers:
 * - Registry: all 15 fleet v9 tools in ALL_TOOLS (374 total), unique
 *   names, no duplicates; createDefaultTools({ getFleetV9BaseDir })
 *   binds them without duplicating (same 15 names, same total)
 * - Unbound file tools answer NOT_WIRED; the 4 pure tools (day plan,
 *   automation dry-run, mock list/execute, app catalogue) work unbound
 * - Bound end-to-end flow on a tmp userData dir: schedule create ->
 *   list -> enable -> tick (enqueue + start) -> queue list;
 *   automation create -> list -> dry-run -> run log; mock toolkit
 *   list/execute; MCP app install/uninstall; state persisted to
 *   fleet-schedules-v112.json / fleet-queue-v112.json /
 *   automations-v112.json / mcp-apps-v112.json
 * - Tool arg validation: missing args / bad enum / unknown toolkit
 *   or app return Error strings, never throw
 * - Approval flags: writes need approval, reads do not
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v112-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { FLEET_V9_TOOLS, createFleetV9Tools } from '../packages/tools/dist/fleetV9Tools.js';
import {
  createAutomationV2,
  createFleetV9Schedule,
  enqueueFleetV9,
  saveFleetV9Schedules,
} from '../packages/core/dist/index.js';

const V9_NAMES = [
  'fleet_schedule_create_v9',
  'fleet_schedule_list_v9',
  'fleet_schedule_enable_v9',
  'fleet_queue_tick_v9',
  'fleet_queue_list_v9',
  'fleet_day_plan_v9',
  'automation_v2_create',
  'automation_v2_list',
  'automation_v2_dry_run',
  'automation_v2_run_log',
  'composio_mock_toolkit_list_v112',
  'composio_mock_toolkit_execute_v112',
  'mcp_app_catalogue_v112',
  'mcp_app_install_v112',
  'mcp_app_uninstall_v112',
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v112-tools-'));
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tools, name, args) {
  return toolByName(tools, name).execute(args, {});
}

function toolNames(tools) {
  return tools.map((t) => t.definition.name);
}

test('fleet v112 tools: 15 tools in ALL_TOOLS (491), unique names', () => {
  assert.equal(FLEET_V9_TOOLS.length, 15);
  assert.deepEqual(
    FLEET_V9_TOOLS.map((t) => t.definition.name),
    V9_NAMES,
  );
  for (const name of V9_NAMES) {
    assert.equal(
      ALL_TOOLS.filter((t) => t.definition.name === name).length,
      1,
      `${name} must appear exactly once in ALL_TOOLS`,
    );
  }
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  assert.equal(ALL_TOOLS.length, 899); // v1.14 merge: 453 + 38 = 500; v1.13: 402 + 51 = 453; v1.11 merge: 359; v1.12 T6: 359 + 15 = 374 // v1.36 re-pin: 825 + 74 = 899.
});

test('fleet v112 tools: createDefaultTools binds without duplicating', () => {
  const base = tmpDir();
  const bound = createDefaultTools({ getFleetV9BaseDir: () => base });
  assert.equal(bound.length, ALL_TOOLS.length);
  for (const name of V9_NAMES) {
    assert.equal(
      bound.filter((t) => t.definition.name === name).length,
      1,
      `${name} duplicated after binding`,
    );
  }
  // Bound tools sit where the placeholders were (order preserved).
  assert.deepEqual(
    bound.map((t) => t.definition.name).filter((n) => V9_NAMES.includes(n)),
    V9_NAMES,
  );
});

test('fleet v112 tools: unbound file tools say NOT_WIRED, pure tools work', async () => {
  const unbound = createFleetV9Tools();
  assert.match(await run(unbound, 'fleet_schedule_create_v9', { botId: 'b', name: 'n', kind: 'manual' }), /^Error:.*not wired/);
  assert.match(await run(unbound, 'fleet_schedule_list_v9', {}), /^Error:.*not wired/);
  assert.match(await run(unbound, 'fleet_queue_list_v9', {}), /^Error:.*not wired/);
  assert.match(await run(unbound, 'automation_v2_list', {}), /^Error:.*not wired/);
  assert.match(await run(unbound, 'mcp_app_install_v112', { appId: 'kanban-board' }), /^Error:.*not wired/);

  // Pure: mock list/execute.
  const listed = JSON.parse(await run(unbound, 'composio_mock_toolkit_list_v112', {}));
  assert.equal(listed.length, 6);
  assert.deepEqual(listed.map((t) => t.slug), ['grafana', 'elasticsearch', 'bigquery', 'clickhouse', 'launchdarkly', 'greenhouse']);
  const executed = JSON.parse(await run(unbound, 'composio_mock_toolkit_execute_v112', {
    toolkit: 'grafana', slug: 'GRAFANA_LIST_DASHBOARDS', args: {},
  }));
  assert.equal(executed.mock, true);
  assert.equal(executed.live, false);
  assert.match(await run(unbound, 'composio_mock_toolkit_execute_v112', { toolkit: 'grafana', slug: 'NOPE' }), /^Error:/);

  // Pure: app catalogue (host grants read+write so kanban is compatible).
  const apps = JSON.parse(await run(unbound, 'mcp_app_catalogue_v112', {
    query: 'kanban',
    grantedPermissions: ['read-files', 'write-files', 'clipboard', 'notifications'],
  }));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].app.id, 'kanban-board');
  assert.equal(apps[0].compatible, true);
  assert.equal(apps[0].installed, false);

  // Pure: day plan.
  const { queue } = enqueueFleetV9([], { botId: 'b1', name: 'job' }, 0);
  const plan = JSON.parse(await run(unbound, 'fleet_day_plan_v9', {
    entries: queue,
    dayStartMs: Date.UTC(2026, 10, 16, 0, 0, 0),
  }));
  assert.equal(plan.unscheduled.length, 0);
  assert.equal(plan.slots.length, 96);

  // Pure: automation dry-run.
  const auto = createAutomationV2({
    botId: 'b1',
    name: 'a',
    trigger: { kind: 'manual' },
    steps: [{ id: 's1', kind: 'notify', message: 'hi' }],
  });
  const dry = JSON.parse(await run(unbound, 'automation_v2_dry_run', {
    automation: auto,
    event: { type: 'manual', atMs: 0 },
  }));
  assert.equal(dry.wouldRun, true);
  assert.equal(dry.steps.length, 1);
});

test('fleet v112 tools: bound schedule flow — create/list/enable/tick/queue', async () => {
  const base = tmpDir();
  const tools = createFleetV9Tools(() => base);

  const created = JSON.parse(await run(tools, 'fleet_schedule_create_v9', {
    botId: 'bot-1', name: 'hourly', kind: 'interval', intervalMs: 3600000, priority: 'high',
  }));
  assert.equal(created.botId, 'bot-1');
  assert.equal(created.kind, 'interval');
  assert.ok(created.id.startsWith('sched_v9_'));

  const listed = JSON.parse(await run(tools, 'fleet_schedule_list_v9', {}));
  assert.equal(listed.schedules.length, 1);
  assert.equal(listed.summary.totalSchedules, 1);

  const disabled = JSON.parse(await run(tools, 'fleet_schedule_enable_v9', {
    scheduleId: created.id, enabled: false,
  }));
  assert.equal(disabled.enabled, false);
  const reEnabled = JSON.parse(await run(tools, 'fleet_schedule_enable_v9', {
    scheduleId: created.id, enabled: true,
  }));
  assert.equal(reEnabled.enabled, true);
  assert.match(await run(tools, 'fleet_schedule_enable_v9', { scheduleId: 'nope', enabled: true }), /^Error:.*not found/);
  assert.match(await run(tools, 'fleet_schedule_create_v9', { botId: 'bot-1', name: 'x', kind: 'bogus' }), /^Error:/);
  assert.match(await run(tools, 'fleet_schedule_create_v9', { botId: 'bot-1', name: 'x', kind: 'cron' }), /^Error:/);

  // Tick with a due schedule written directly (interval created in the past).
  const fleetRoot = path.join(base, 'fleet');
  const past = createFleetV9Schedule(
    { botId: 'bot-2', name: 'past-hourly', kind: 'interval', intervalMs: 3600000 },
    Date.now() - 70 * 60 * 1000,
  );
  saveFleetV9Schedules(fleetRoot, [past]);
  const ticked = JSON.parse(await run(tools, 'fleet_queue_tick_v9', { hostCpuCores: 4, hostRamBytes: 8 * 1024 ** 3 }));
  assert.equal(ticked.enqueued.length, 1);
  assert.equal(ticked.started.length, 1);
  assert.equal(ticked.summary.running, 1);
  assert.ok(fs.existsSync(path.join(fleetRoot, 'fleet-queue-v112.json')));

  const queue = JSON.parse(await run(tools, 'fleet_queue_list_v9', {}));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, 'running');
  const runningOnly = JSON.parse(await run(tools, 'fleet_queue_list_v9', { status: 'running' }));
  assert.equal(runningOnly.length, 1);
  const doneOnly = JSON.parse(await run(tools, 'fleet_queue_list_v9', { status: 'done' }));
  assert.equal(doneOnly.length, 0);
});

test('fleet v112 tools: bound automation flow — create/list/run-log', async () => {
  const base = tmpDir();
  const tools = createFleetV9Tools(() => base);

  const created = JSON.parse(await run(tools, 'automation_v2_create', {
    botId: 'bot-1',
    name: 'file watch',
    trigger: { kind: 'file', pathPattern: 'notes/**.md', events: ['modified'] },
    steps: [{ id: 's1', kind: 'notify', message: 'notes changed' }],
  }));
  assert.equal(created.trigger.kind, 'file');
  assert.ok(created.id.startsWith('auto_v2_'));
  assert.ok(fs.existsSync(path.join(base, 'automations', 'automations-v112.json')));

  const listed = JSON.parse(await run(tools, 'automation_v2_list', {}));
  assert.equal(listed.length, 1);
  const enabledOnly = JSON.parse(await run(tools, 'automation_v2_list', { enabledOnly: true }));
  assert.equal(enabledOnly.length, 1);

  const log = JSON.parse(await run(tools, 'automation_v2_run_log', {}));
  assert.deepEqual(log.runs, []);
  assert.deepEqual(log.summary, { total: 0, succeeded: 0, failed: 0, partial: 0, skipped: 0 });

  assert.match(await run(tools, 'automation_v2_create', {
    botId: 'bot-1', name: 'bad', trigger: { kind: 'nope' }, steps: [{ id: 's1', kind: 'notify', message: 'x' }],
  }), /^Error:/);
  assert.match(await run(tools, 'automation_v2_create', {
    botId: 'bot-1', name: 'bad', trigger: { kind: 'manual' }, steps: [],
  }), /^Error:/);
});

test('fleet v112 tools: bound MCP app flow — install/uninstall', async () => {
  const base = tmpDir();
  const tools = createFleetV9Tools(() => base);

  const installed = JSON.parse(await run(tools, 'mcp_app_install_v112', {
    appId: 'kanban-board',
    grantedPermissions: ['read-files', 'write-files', 'clipboard', 'notifications'],
  }));
  assert.equal(installed.appId, 'kanban-board');
  assert.equal(installed.version, '1.2.0');
  assert.ok(fs.existsSync(path.join(base, 'mcp-apps-v112.json')));

  const catalogue = JSON.parse(await run(tools, 'mcp_app_catalogue_v112', { query: '' }));
  assert.equal(catalogue.find((a) => a.app.id === 'kanban-board').installed, true);

  assert.match(await run(tools, 'mcp_app_install_v112', {
    appId: 'kanban-board',
    grantedPermissions: ['read-files', 'write-files', 'clipboard', 'notifications'],
  }), /^Error:.*already installed/);
  assert.match(await run(tools, 'mcp_app_install_v112', { appId: 'nope' }), /^Error:.*not in catalogue/);
  // Incompatible on an old host.
  assert.match(await run(tools, 'mcp_app_install_v112', { appId: 'chart-dashboard', hostVersion: '0.1.0' }), /^Error:.*not compatible/);

  const removed = JSON.parse(await run(tools, 'mcp_app_uninstall_v112', { appId: 'kanban-board' }));
  assert.equal(removed.uninstalled, 'kanban-board');
  assert.equal(removed.remaining, 0);
  assert.match(await run(tools, 'mcp_app_uninstall_v112', { appId: 'kanban-board' }), /^Error:.*not installed/);
});

test('fleet v112 tools: approval flags — writes need approval, reads do not', () => {
  const needsApproval = new Set(
    FLEET_V9_TOOLS.filter((t) => t.needsApproval).map((t) => t.definition.name),
  );
  assert.deepEqual([...needsApproval].sort(), [
    'automation_v2_create',
    'fleet_queue_tick_v9',
    'fleet_schedule_create_v9',
    'fleet_schedule_enable_v9',
    'mcp_app_install_v112',
    'mcp_app_uninstall_v112',
  ]);
  for (const tool of FLEET_V9_TOOLS) {
    if (!needsApproval.has(tool.definition.name)) assert.equal(tool.needsApproval, false);
  }
  assert.equal(toolNames(FLEET_V9_TOOLS).length, 15);
});
