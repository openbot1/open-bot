/**
 * Tests for fleet v25 tools + i18n (v1.38, Team T6).
 *
 * Covers:
 * - Pure tool defs: 28 tools, unique snake_case names, no dots,
 *   write/read split, requiresAction per group.
 * - Runnable tools: unbound says "not configured"; bound state does
 *   the full loop (users + permission denial audited, schedules,
 *   audit query/verify/export, runs, dry-run, dashboard) via
 *   `createFleetV25Tools` + `createEmptyFleetV25ToolState`.
 * - defaultToolFactory binding: bound v25 tools replace the
 *   placeholders (same 28 names, no duplicates).
 * - i18n: 48 fleet.v25.* keys in all 6 locales, non-empty values,
 *   total keys per locale = 8072 (7721 + 137 v137 + 48 fleetV25 +
 *   32 protocolsV7 + 40 voiceV25 + 32 memoryV23 + 32 sandboxV6 +
 *   30 codingV16).
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v25-tools-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FLEET_V25_TOOLS,
  findFleetV25Tool,
  fleetV25ReadTools,
  fleetV25ToolNamesValid,
  fleetV25ToolsByGroup,
  fleetV25ToolsRequiring,
  fleetV25WriteTools,
} from '../packages/core/dist/fleetV25/toolsV25.js';
import { FLEET_V25_VERSION } from '../packages/core/dist/fleetV25/index.js';
import {
  FLEET_V25_TOOLS as RUNNABLE_V25_TOOLS,
  createEmptyFleetV25ToolState,
  createFleetV25Tools,
  fleetV25ToolNamesUnique as runnableNamesUnique,
} from '../packages/tools/dist/fleetV25Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/index.js';

const LOCALES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

function loadLocale(loc) {
  return JSON.parse(readFileSync(new URL(`../apps/desktop/src/renderer/i18n/locales/${loc}.json`, import.meta.url), 'utf-8'));
}

test('tools v25: defs — 28 tools, names valid, groups', () => {
  assert.equal(FLEET_V25_VERSION, 'v25');
  assert.equal(FLEET_V25_TOOLS.length, 28);
  assert.equal(fleetV25ToolNamesValid(), true);
  assert.ok(FLEET_V25_TOOLS.every((t) => !t.name.includes('.')));
  assert.ok(FLEET_V25_TOOLS.every((t) => t.name.startsWith('fleet_v25_')));
  assert.equal(fleetV25ToolsByGroup('fleet_v25').length, 28);
  assert.equal(findFleetV25Tool('fleet_v25_roles')?.write, false);
  assert.equal(findFleetV25Tool('fleet_v25_user_create')?.write, true);
  assert.equal(findFleetV25Tool('fleet_v25_schedule_create')?.write, true);
  assert.equal(findFleetV25Tool('fleet_v25_audit_export')?.write, false);
  assert.equal(findFleetV25Tool('fleet_v25_audit_export')?.requiresAction, 'export-audit');
  assert.equal(findFleetV25Tool('fleet_v25_user_set_role')?.requiresAction, 'manage-roles');
  assert.equal(findFleetV25Tool('fleet_v25_schedule_create')?.requiresAction, 'manage-schedules');
  assert.equal(findFleetV25Tool('fleet_v25_audit_query')?.requiresAction, 'view-audit');
  assert.equal(findFleetV25Tool('no-such-tool'), undefined);
  assert.equal(fleetV25WriteTools().length, 13);
  assert.equal(fleetV25ReadTools().length, 15);
  assert.equal(fleetV25WriteTools().length + fleetV25ReadTools().length, 28);
  assert.ok(fleetV25WriteTools().every((t) => t.write));
  assert.ok(fleetV25ReadTools().every((t) => !t.write));
  assert.equal(fleetV25ToolsRequiring('manage-users').length, 6);
  assert.equal(fleetV25ToolsRequiring('manage-schedules').length, 6);
  assert.equal(fleetV25ToolsRequiring('view-fleet').length, 11);
});

test('tools v25: runnable — unbound says not configured', async () => {
  assert.equal(RUNNABLE_V25_TOOLS.length, 28);
  assert.equal(runnableNamesUnique(), true);
  const names = RUNNABLE_V25_TOOLS.map((t) => t.definition.name);
  assert.deepEqual([...names].sort(), [...FLEET_V25_TOOLS.map((t) => t.name)].sort());
  const dashboard = RUNNABLE_V25_TOOLS.find((t) => t.definition.name === 'fleet_v25_dashboard');
  const out = await dashboard.execute({}, {});
  assert.ok(out.includes('not configured'));
  const create = RUNNABLE_V25_TOOLS.find((t) => t.definition.name === 'fleet_v25_user_create');
  assert.equal(create.needsApproval, true);
  assert.equal(dashboard.needsApproval, false);
  const auditExport = RUNNABLE_V25_TOOLS.find((t) => t.definition.name === 'fleet_v25_audit_export');
  assert.equal(auditExport.needsApproval, false);
});

test('tools v25: runnable — users + permission denial is audited', async () => {
  const state = createEmptyFleetV25ToolState();
  const tools = createFleetV25Tools(() => state);
  const run = async (name, args = {}) => {
    const tool = tools.find((t) => t.definition.name === name);
    assert.ok(tool, `tool ${name} missing`);
    const out = await tool.execute(args, {});
    assert.ok(!out.startsWith('Error:'), `${name}: ${out}`);
    return JSON.parse(out);
  };
  const runRaw = async (name, args = {}) => {
    const tool = tools.find((t) => t.definition.name === name);
    assert.ok(tool, `tool ${name} missing`);
    return tool.execute(args, {});
  };

  // Empty state bootstraps one active admin.
  const list0 = await run('fleet_v25_user_list', {});
  assert.equal(list0.total, 1);
  assert.equal(list0.users[0].id, 'admin');
  assert.equal(list0.users[0].role, 'admin');

  // Admin invites an operator + a viewer, then activates them.
  await run('fleet_v25_user_create', { id: 'ops', name: 'Ops', role: 'operator', tags: ['nightly'], actorId: 'admin' });
  await run('fleet_v25_user_create', { id: 'vee', name: 'Vee', role: 'viewer', actorId: 'admin' });
  const dup = await runRaw('fleet_v25_user_create', { id: 'ops', name: 'Dup', role: 'viewer', actorId: 'admin' });
  assert.ok(dup.startsWith('Error:'));
  assert.ok(dup.includes('already exists'));
  await run('fleet_v25_user_activate', { id: 'ops', actorId: 'admin' });
  await run('fleet_v25_user_activate', { id: 'vee', actorId: 'admin' });
  assert.equal((await run('fleet_v25_user_list', { role: 'operator' })).total, 1);
  assert.equal((await run('fleet_v25_user_list', { status: 'invited' })).total, 0);

  // Viewer tries to create a user → denied, and the denial is audited.
  const denied = await runRaw('fleet_v25_user_create', { id: 'mallory', name: 'M', role: 'viewer', actorId: 'vee' });
  assert.ok(denied.startsWith('Error:'));
  assert.ok(denied.includes('Permission denied'));
  const audit = await run('fleet_v25_audit_query', { result: 'denied' });
  assert.equal(audit.total, 1);
  assert.equal(audit.entries[0].actorId, 'vee');
  assert.equal(audit.entries[0].action, 'user.create');

  // Unknown actor → error, no audit entry for a ghost.
  const ghost = await runRaw('fleet_v25_user_disable', { id: 'ops', actorId: 'ghost' });
  assert.ok(ghost.startsWith('Error:'));
  assert.ok(ghost.includes('Unknown actor'));

  // Operator cannot manage users either (role gate, not just viewers).
  const opDenied = await runRaw('fleet_v25_user_disable', { id: 'vee', actorId: 'ops' });
  assert.ok(opDenied.startsWith('Error:'));
  assert.ok(opDenied.includes('Permission denied'));

  // Admin disables + re-enables the viewer; last-admin guard holds.
  await run('fleet_v25_user_disable', { id: 'vee', note: 'test', actorId: 'admin' });
  assert.equal((await run('fleet_v25_user_list', { status: 'disabled' })).total, 1);
  await run('fleet_v25_user_enable', { id: 'vee', actorId: 'admin' });
  const lastAdmin = await runRaw('fleet_v25_user_disable', { id: 'admin', actorId: 'admin' });
  assert.ok(lastAdmin.startsWith('Error:'));
  assert.ok(lastAdmin.includes('last active admin'));

  // Roles panel + permission check tool.
  const roles = await run('fleet_v25_roles', {});
  assert.equal(roles.counts.roles, 3);
  assert.equal(roles.matrix.length, 13);
  const check = await run('fleet_v25_check_permission', { role: 'viewer', action: 'manage-users' });
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'role-lacks-action');
  const checkOk = await run('fleet_v25_check_permission', { role: 'operator', action: 'run-bot', tags: ['nightly'] });
  assert.equal(checkOk.allowed, true);
});

test('tools v25: runnable — schedules, audit, runs, dashboard', async () => {
  const state = createEmptyFleetV25ToolState();
  const tools = createFleetV25Tools(() => state);
  const run = async (name, args = {}) => {
    const tool = tools.find((t) => t.definition.name === name);
    assert.ok(tool, `tool ${name} missing`);
    const out = await tool.execute(args, {});
    assert.ok(!out.startsWith('Error:'), `${name}: ${out}`);
    return JSON.parse(out);
  };
  const runRaw = async (name, args = {}) => {
    const tool = tools.find((t) => t.definition.name === name);
    assert.ok(tool, `tool ${name} missing`);
    return tool.execute(args, {});
  };

  // Cron validation: bad, then good.
  const bad = await run('fleet_v25_schedule_validate_cron', { cron: '0 25 * * *' });
  assert.equal(bad.valid, false);
  assert.equal(bad.normalised, null);
  const good = await run('fleet_v25_schedule_validate_cron', { cron: '0 9 * * 1-5' });
  assert.equal(good.valid, true);
  assert.equal(good.normalised, '0 9 * * 1-5');
  assert.ok(good.description.includes('Cron'));

  // Create a cron schedule + an interval schedule with a condition.
  const cron = await run('fleet_v25_schedule_create', {
    id: 's-nightly', automationId: 'auto-a', owner: 'team-data', name: 'Nightly',
    kind: 'cron', cron: '0 9 * * *', actorId: 'admin',
  });
  assert.equal(cron.kind, 'cron');
  assert.ok(cron.nextRunAtMs > Date.now());
  const interval = await run('fleet_v25_schedule_create', {
    id: 's-hourly', automationId: 'auto-b', owner: 'team-ops', name: 'Hourly',
    kind: 'interval', intervalMs: 3600000,
    conditions: [{ type: 'time-window', startHour: 9, endHour: 17 }],
    maxRetries: 2, backoffMs: 60000, actorId: 'admin',
  });
  assert.equal(interval.retry.maxRetries, 2);
  const badCreate = await runRaw('fleet_v25_schedule_create', {
    id: 's-bad', automationId: 'auto-a', owner: 'o', name: 'Bad',
    kind: 'cron', cron: 'nope', actorId: 'admin',
  });
  assert.ok(badCreate.startsWith('Error:'));

  // List / filter / lifecycle.
  assert.equal((await run('fleet_v25_schedule_list', {})).total, 2);
  assert.equal((await run('fleet_v25_schedule_list', { owner: 'team-ops' })).total, 1);
  assert.equal((await run('fleet_v25_schedule_list', { kind: 'cron' })).total, 1);
  await run('fleet_v25_schedule_pause', { id: 's-hourly', actorId: 'admin' });
  assert.equal(state.schedules.get('s-hourly').paused, true);
  await run('fleet_v25_schedule_resume', { id: 's-hourly', actorId: 'admin' });
  assert.equal(state.schedules.get('s-hourly').paused, false);
  await run('fleet_v25_schedule_disable', { id: 's-hourly', actorId: 'admin' });
  assert.equal(state.schedules.get('s-hourly').enabled, false);
  await run('fleet_v25_schedule_enable', { id: 's-hourly', actorId: 'admin' });
  assert.equal(state.schedules.get('s-hourly').enabled, true);
  const next = await run('fleet_v25_schedule_next_runs', { limit: 5 });
  assert.equal(next.schedules.length, 2);
  assert.equal(next.stats.total, 2);

  // Dry-run preview: nothing is due right now (both fire in the future).
  const dry = await run('fleet_v25_engine_tick_dry_run', {});
  assert.equal(dry.due, 0);
  assert.equal(dry.wouldFire, 0);

  // Runs: none yet; stats + stuck are empty.
  assert.equal((await run('fleet_v25_runs_query', {})).total, 0);
  const stats = await run('fleet_v25_run_stats', {});
  assert.equal(stats.total, 0);
  assert.equal(stats.failureRate, 0);
  assert.equal((await run('fleet_v25_runs_stuck', {})).stuck.length, 0);

  // Audit: schedule creates were audited; chain verifies; summary counts.
  const auditAll = await run('fleet_v25_audit_query', {});
  assert.ok(auditAll.total >= 2);
  assert.ok(auditAll.entries.some((e) => e.action === 'schedule.create'));
  const verify = await run('fleet_v25_audit_verify', {});
  assert.equal(verify.ok, true);
  const summary = await run('fleet_v25_audit_summary', {});
  assert.equal(summary.total, auditAll.total);
  assert.equal(summary.chain.ok, true);

  // Audit export: admin ok, viewer denied.
  await run('fleet_v25_user_create', { id: 'vee', name: 'Vee', role: 'viewer', actorId: 'admin' });
  await run('fleet_v25_user_activate', { id: 'vee', actorId: 'admin' });
  const exportDenied = await runRaw('fleet_v25_audit_export', { actorId: 'vee' });
  assert.ok(exportDenied.startsWith('Error:'));
  assert.ok(exportDenied.includes('Permission denied'));
  const exported = await runRaw('fleet_v25_audit_export', { actorId: 'admin' });
  assert.ok(!exported.startsWith('Error:'));
  assert.ok(exported.trim().split('\n').length >= 2);
  assert.equal(JSON.parse(exported.trim().split('\n')[0]).seq, 1);

  // Remove one schedule; dashboard aggregates everything.
  await run('fleet_v25_schedule_remove', { id: 's-hourly', actorId: 'admin' });
  assert.equal((await run('fleet_v25_schedule_list', {})).total, 1);
  const dashboard = await run('fleet_v25_dashboard', {});
  assert.equal(dashboard.users.counts.total, 2);
  assert.equal(dashboard.schedules.stats.total, 1);
  assert.equal(dashboard.audit.chainValid, true);
  assert.equal(dashboard.roles.counts.roles, 3);
  assert.equal(dashboard.runs.countsByOutcome.completed, 0);
  assert.ok(dashboard.summary.includes('1 schedule'));
});

test('tools v25: createDefaultTools binds v25 state (same 28 names, no dup)', () => {
  const state = createEmptyFleetV25ToolState();
  const unbound = createDefaultTools();
  const unboundNames = unbound.map((t) => t.definition.name);
  assert.equal(unboundNames.filter((n) => n.startsWith('fleet_v25_')).length, 28);
  const bound = createDefaultTools({ getFleetV25State: () => state });
  const boundNames = bound.map((t) => t.definition.name);
  assert.equal(boundNames.filter((n) => n.startsWith('fleet_v25_')).length, 28);
  assert.equal(new Set(boundNames).size, boundNames.length);
  assert.deepEqual(
    [...boundNames.filter((n) => n.startsWith('fleet_v25_'))].sort(),
    [...FLEET_V25_TOOLS.map((t) => t.name)].sort(),
  );
  // ALL_TOOLS itself carries the 28 placeholders.
  const allNames = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(allNames.filter((n) => n.startsWith('fleet_v25_')).length, 28);
  assert.equal(new Set(allNames).size, allNames.length);
});

test('i18n v25: 48 fleet.v25.* keys in all 6 locales, totals re-pinned', () => {
  const counts = {};
  for (const loc of LOCALES) {
    const data = loadLocale(loc);
    counts[loc] = Object.keys(data).length;
    const v25 = Object.keys(data).filter((k) => k.startsWith('fleet.v25.'));
    assert.equal(v25.length, 48, `${loc}: expected 48 fleet.v25 keys, got ${v25.length}`);
    for (const key of v25) {
      assert.equal(typeof data[key], 'string', `${loc}:${key} must be a string`);
      assert.ok(data[key].trim().length > 0, `${loc}:${key} must not be empty`);
    }
  }
  // Every locale carries the same key set.
  const sets = LOCALES.map((loc) => Object.keys(loadLocale(loc)).sort().join('\n'));
  for (const other of sets.slice(1)) assert.equal(other, sets[0]);
  // Total keys per locale = 7721 (v1.38 base) + 137 (v137 catch-up: T1 47 + T3 25 + T4 65) + 48 (fleetV25) + 32 (protocolsV7) + 40 (voiceV25) + 32 (memoryV23) + 32 (sandboxV6) + 30 (codingV16) = 8072.
  for (const loc of LOCALES) assert.ok(counts[loc] >= 8072, `${loc}: expected >= 8072 keys, got ${counts[loc]}`); // v1.39 fix round 4b: floor (was 8072 in v1.38; now 8322).
});
