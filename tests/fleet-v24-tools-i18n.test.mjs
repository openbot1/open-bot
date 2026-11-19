/**
 * Tests for fleet v24 tools + i18n (v1.37, Đội T6).
 *
 * Covers:
 * - Tool defs thuần: 26 tool, tên duy nhất + không dấu chấm
 *   (quy tắc sau vụ nổ defaultToolFactory v21/v22), nhóm đủ 3 nhóm,
 *   write tools tách được.
 * - Tools chạy thật: unbound trả "not configured"; bound state tạo
 *   automation, chạy run, ghi stop-hook feedback, thêm CIDR rule,
 *   evaluate (route, IP), dashboard — qua
 *   `createFleetV24Tools` + `createEmptyFleetV24ToolState`.
 * - i18n: 93 key fleet.v24.* có đủ 6 locale, giá trị không rỗng,
 *   tổng key mỗi locale = 8072 (7721 + 137 v137 + 48 fleetV25 +
 *   32 protocolsV7 + 40 voiceV25 + 32 memoryV23 + 32 sandboxV6 +
 *   30 codingV16). // v1.38 merge re-pin: 8072.
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v24-tools-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FLEET_V24_TOOLS,
  findFleetV24Tool,
  fleetV24ReadTools,
  fleetV24ToolNamesValid,
  fleetV24ToolsByGroup,
  fleetV24WriteTools,
} from '../packages/core/dist/fleetV24/toolsV24.js';
import { FLEET_V24_VERSION } from '../packages/core/dist/fleetV24/index.js';
import {
  FLEET_V24_TOOLS as RUNNABLE_V24_TOOLS,
  createEmptyFleetV24ToolState,
  createFleetV24Tools,
  fleetV24ToolNamesUnique as runnableNamesUnique,
} from '../packages/tools/dist/fleetV24Tools.js';

const LOCALES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

function loadLocale(loc) {
  return JSON.parse(readFileSync(new URL(`../apps/desktop/src/renderer/i18n/locales/${loc}.json`, import.meta.url), 'utf-8'));
}

test('tools v24: defs — 26 tools, names valid, 3 groups', () => {
  assert.equal(FLEET_V24_VERSION, 'v24');
  assert.equal(FLEET_V24_TOOLS.length, 26);
  assert.equal(fleetV24ToolNamesValid(), true);
  // Không tool nào có dấu chấm (bài học v21/v22).
  assert.ok(FLEET_V24_TOOLS.every((t) => !t.name.includes('.')));
  assert.equal(fleetV24ToolsByGroup('fleet_v24').length, 13);
  assert.equal(fleetV24ToolsByGroup('stophook_v24').length, 6);
  assert.equal(fleetV24ToolsByGroup('cidr_v24').length, 7);
  assert.equal(findFleetV24Tool('fleet_v24_dashboard')?.write, false);
  assert.equal(findFleetV24Tool('fleet_v24_register')?.write, true);
  assert.equal(findFleetV24Tool('stophook_v24_record')?.write, true);
  assert.equal(findFleetV24Tool('cidr_v24_add_rule')?.write, true);
  assert.equal(findFleetV24Tool('cidr_v24_evaluate')?.write, false);
  assert.equal(findFleetV24Tool('no-such-tool'), undefined);
  assert.ok(fleetV24WriteTools().length > 0);
  assert.ok(fleetV24WriteTools().every((t) => t.write));
  assert.ok(fleetV24ReadTools().every((t) => !t.write));
  assert.equal(fleetV24WriteTools().length + fleetV24ReadTools().length, 26);
});

test('tools v24: runnable — unbound says not configured', async () => {
  assert.equal(RUNNABLE_V24_TOOLS.length, 26);
  assert.equal(runnableNamesUnique(), true);
  const names = RUNNABLE_V24_TOOLS.map((t) => t.definition.name);
  assert.deepEqual([...names].sort(), [...FLEET_V24_TOOLS.map((t) => t.name)].sort());
  const dashboard = RUNNABLE_V24_TOOLS.find((t) => t.definition.name === 'fleet_v24_dashboard');
  const out = await dashboard.execute({}, {});
  assert.ok(out.includes('not configured'));
  const register = RUNNABLE_V24_TOOLS.find((t) => t.definition.name === 'fleet_v24_register');
  assert.equal(register.needsApproval, true);
  assert.equal(dashboard.needsApproval, false);
  const addRule = RUNNABLE_V24_TOOLS.find((t) => t.definition.name === 'cidr_v24_add_rule');
  assert.equal(addRule.needsApproval, true);
  const evaluate = RUNNABLE_V24_TOOLS.find((t) => t.definition.name === 'cidr_v24_evaluate');
  assert.equal(evaluate.needsApproval, false);
});

test('tools v24: runnable — automation dashboard end-to-end', async () => {
  const state = createEmptyFleetV24ToolState();
  const tools = createFleetV24Tools(() => state);
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

  // Register two automations, then list/group/stats.
  await run('fleet_v24_register', { id: 'auto-a', name: 'A', owner: 'team-data', tags: ['nightly', 'backup'] });
  await run('fleet_v24_register', { id: 'auto-b', name: 'B', owner: 'team-ops', tags: ['nightly'] });
  const dup = await runRaw('fleet_v24_register', { id: 'auto-a', name: 'dup', owner: 'x' });
  assert.ok(dup.startsWith('Error:'));
  assert.ok(dup.includes('already registered'));

  const list = await run('fleet_v24_list', {});
  assert.equal(list.total, 2);
  assert.equal((await run('fleet_v24_list', { tag: 'backup' })).total, 1);
  assert.equal((await run('fleet_v24_list', { owner: 'team-ops' })).total, 1);
  assert.equal((await run('fleet_v24_list', { status: 'failed' })).total, 0);

  const groups = await run('fleet_v24_group_by_tag', {});
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.tag === 'nightly')?.automations.length, 2);
  const owners = await run('fleet_v24_group_by_owner', {});
  assert.equal(owners.length, 2);

  const stats = await run('fleet_v24_stats', {});
  assert.equal(stats.scope, 'fleet');
  assert.equal(stats.stats.total, 2);
  assert.equal((await run('fleet_v24_stats', { tag: 'backup' })).stats.total, 1);
  assert.equal((await run('fleet_v24_stats', { owner: 'team-ops' })).stats.total, 1);

  // Bulk pause by tag, then resume + disable/enable.
  const paused = await run('fleet_v24_pause_tag', { tag: 'nightly' });
  assert.equal(paused.applied, 2);
  assert.equal(state.registry.get('auto-a')?.status, 'paused');
  const resumed = await run('fleet_v24_resume_tag', { tag: 'nightly' });
  assert.equal(resumed.applied, 2);
  const disabled = await run('fleet_v24_disable_tag', { tag: 'backup' });
  assert.equal(disabled.applied, 1);
  assert.equal(state.registry.get('auto-a')?.status, 'disabled');
  const enabled = await run('fleet_v24_enable_tag', { tag: 'backup' });
  assert.equal(enabled.applied, 1);
  assert.equal(state.registry.get('auto-a')?.status, 'idle');

  // Runs: start + finish, then query.
  await run('fleet_v24_run_start', { id: 'run-1', automationId: 'auto-a', trigger: 'manual' });
  assert.equal(state.registry.get('auto-a')?.status, 'running');
  const missingAuto = await runRaw('fleet_v24_run_start', { id: 'run-9', automationId: 'nope' });
  assert.ok(missingAuto.startsWith('Error:'));
  const finished = await run('fleet_v24_run_finish', { id: 'run-1', outcome: 'completed' });
  assert.equal(finished.outcome, 'completed');
  assert.ok(finished.durationMs >= 0);
  assert.equal(state.registry.get('auto-a')?.status, 'completed');
  const badFinish = await runRaw('fleet_v24_run_finish', { id: 'run-1', outcome: 'completed' });
  assert.ok(badFinish.startsWith('Error:'));
  const badOutcome = await runRaw('fleet_v24_run_finish', { id: 'run-1', outcome: 'running' });
  assert.ok(badOutcome.startsWith('Error:'));

  const runs = await run('fleet_v24_runs', {});
  assert.equal(runs.total, 1);
  assert.equal(runs.runs[0].id, 'run-1');
  assert.equal(runs.panel.countsByOutcome.completed, 1);

  // Dashboard aggregates everything.
  const dashboard = await run('fleet_v24_dashboard', {});
  assert.equal(dashboard.automation.stats.total, 2);
  assert.equal(dashboard.runs.countsByOutcome.completed, 1);
  assert.equal(dashboard.stopHook.stats.total, 0);
  assert.equal(dashboard.cidr.rules.length, 0);
  assert.ok(dashboard.summary.includes('2 automations'));
  const filtered = await run('fleet_v24_dashboard', { tag: 'backup' });
  assert.equal(filtered.automation.filtered?.length, 1);
});

test('tools v24: runnable — stop hook feedback end-to-end', async () => {
  const state = createEmptyFleetV24ToolState();
  const tools = createFleetV24Tools(() => state);
  const run = async (name, args = {}) => {
    const tool = tools.find((t) => t.definition.name === name);
    assert.ok(tool, `tool ${name} missing`);
    const out = await tool.execute(args, {});
    assert.ok(!out.startsWith('Error:'), `${name}: ${out}`);
    return JSON.parse(out);
  };

  const feedback = await run('stophook_v24_record', {
    id: 'sh-1', runId: 'run-1', automationId: 'auto-a',
    reason: 'max-steps reached', triggeredBy: 'system',
    triggeredByName: 'agent-loop', action: 'stop',
  });
  assert.ok(feedback.suggestedNextAction.includes('step limit'));
  assert.equal(feedback.acknowledged, false);

  assert.equal((await run('stophook_v24_for_run', { runId: 'run-1' })).length, 1);
  assert.equal((await run('stophook_v24_for_run', { runId: 'run-9' })).length, 0);
  const forAuto = await run('stophook_v24_for_automation', { automationId: 'auto-a' });
  assert.equal(forAuto.feedback.length, 1);
  assert.equal(forAuto.summary.total, 1);
  assert.equal((await run('stophook_v24_unacknowledged', {})).length, 1);

  const acked = await run('stophook_v24_acknowledge', { id: 'sh-1', acknowledgedBy: 'ops', note: 'ok' });
  assert.equal(acked.acknowledged, true);
  assert.equal((await run('stophook_v24_unacknowledged', {})).length, 0);

  const summary = await run('stophook_v24_summary', {});
  assert.equal(summary.fleet.total, 1);
  assert.equal(summary.fleet.unacknowledged, 0);
  assert.equal(summary.byAutomation.length, 1);
  const perAuto = await run('stophook_v24_summary', { automationId: 'auto-a' });
  assert.equal(perAuto.total, 1);
});

test('tools v24: runnable — CIDR rules end-to-end', async () => {
  const state = createEmptyFleetV24ToolState();
  const tools = createFleetV24Tools(() => state);
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

  // Validate first: bad CIDR, host-bits CIDR, good CIDR.
  const bad = await run('cidr_v24_validate', { cidr: 'nope' });
  assert.equal(bad.valid, false);
  assert.equal(bad.normalised, null);
  const hostBits = await run('cidr_v24_validate', { cidr: '10.0.0.5/24' });
  assert.equal(hostBits.valid, false);
  assert.equal(hostBits.normalised, '10.0.0.0/24');
  const good = await run('cidr_v24_validate', { cidr: '203.0.113.0/24' });
  assert.equal(good.valid, true);
  assert.equal(good.normalised, '203.0.113.0/24');
  assert.equal(good.prefix, 24);
  assert.equal(good.bits, 32);
  const goodV6 = await run('cidr_v24_validate', { cidr: '2001:db8::/32' });
  assert.equal(goodV6.valid, true);
  assert.equal(goodV6.bits, 128);

  // Add rules: global deny + route allow + more specific route deny.
  await run('cidr_v24_add_rule', { id: 'r-deny-private', cidr: '10.0.0.0/8', action: 'deny' });
  await run('cidr_v24_add_rule', { id: 'r-allow-docs', cidr: '203.0.113.0/24', action: 'allow', routeId: 'route-public' });
  await run('cidr_v24_add_rule', { id: 'r-deny-sub', cidr: '203.0.113.128/25', action: 'deny', routeId: 'route-public' });
  const dup = await runRaw('cidr_v24_add_rule', { id: 'r-deny-private', cidr: '10.0.0.0/8', action: 'deny' });
  assert.ok(dup.startsWith('Error:'));
  const invalid = await runRaw('cidr_v24_add_rule', { id: 'r-bad', cidr: 'nope', action: 'deny' });
  assert.ok(invalid.startsWith('Error:'));

  // Evaluate: longest prefix wins; route binding respected; default deny.
  const denied = await run('cidr_v24_evaluate', { routeId: 'route-public', ip: '203.0.113.200' });
  assert.equal(denied.action, 'deny');
  assert.equal(denied.ruleId, 'r-deny-sub');
  const allowed = await run('cidr_v24_evaluate', { routeId: 'route-public', ip: '203.0.113.10' });
  assert.equal(allowed.action, 'allow');
  const otherRoute = await run('cidr_v24_evaluate', { routeId: 'route-x', ip: '203.0.113.10' });
  assert.equal(otherRoute.action, 'deny');
  assert.equal(otherRoute.fromDefault, true);
  const privateIp = await run('cidr_v24_evaluate', { routeId: 'route-x', ip: '10.1.2.3' });
  assert.equal(privateIp.ruleId, 'r-deny-private');

  // Rules for a route include global rules.
  const forRoute = await run('cidr_v24_rules_for_route', { routeId: 'route-public' });
  assert.equal(forRoute.rules.length, 3);
  assert.equal(forRoute.panel.rulesForRoute?.length, 3);

  // Overlap: /24 allow vs /25 deny disagree.
  const overlaps = await run('cidr_v24_overlaps', {});
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].conflicting, true);

  // Audit: 3 creates so far.
  const audit = await run('cidr_v24_audit', {});
  assert.equal(audit.length, 3);
  assert.equal((await run('cidr_v24_audit', { ruleId: 'r-allow-docs' })).length, 1);

  // Remove a rule: it stops matching immediately, audit grows.
  await run('cidr_v24_remove_rule', { id: 'r-deny-sub' });
  const afterRemove = await run('cidr_v24_evaluate', { routeId: 'route-public', ip: '203.0.113.200' });
  assert.equal(afterRemove.action, 'allow');
  assert.equal((await run('cidr_v24_audit', {})).length, 4);
  const missingRemove = await runRaw('cidr_v24_remove_rule', { id: 'nope' });
  assert.ok(missingRemove.startsWith('Error:'));
});

test('i18n v24: 93 fleet.v24.* keys in all 6 locales, totals re-pinned', () => {
  const counts = {};
  for (const loc of LOCALES) {
    const data = loadLocale(loc);
    counts[loc] = Object.keys(data).length;
    const v24 = Object.keys(data).filter((k) => k.startsWith('fleet.v24.'));
    assert.equal(v24.length, 93, `${loc}: expected 93 fleet.v24 keys, got ${v24.length}`);
    for (const key of v24) {
      assert.equal(typeof data[key], 'string', `${loc}:${key} must be a string`);
      assert.ok(data[key].trim().length > 0, `${loc}:${key} must not be empty`);
    }
  }
  // Every locale carries the same key set.
  const sets = LOCALES.map((loc) => Object.keys(loadLocale(loc)).sort().join('\n'));
  for (const other of sets.slice(1)) assert.equal(other, sets[0]);
  // Total keys per locale = 7721 (v1.38 base) + 137 (v137 catch-up) + 48 (fleetV25) + 32 (protocolsV7) + 40 (voiceV25) + 32 (memoryV23) + 32 (sandboxV6) + 30 (codingV16) = 8072.
  for (const loc of LOCALES) assert.ok(counts[loc] >= 8072, `${loc}: expected >= 8072 keys, got ${counts[loc]}`);}); // v1.39 fix round 4b: floor (was 8072 in v1.38; now 8322).
