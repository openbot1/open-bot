/**
 * Tests for fleet v28 budget meter + tools + panels + i18n (v1.41, Team T6).
 *
 * Covers:
 * - Pure tool defs: 40 tools, unique snake_case names, no dots,
 *   write/read split, groups.
 * - Runnable tools: unbound says "not configured"; bound state does
 *   the full loop (runtime start/list/get/stop/restart/limits/usage/
 *   evict-idle/health/probe, secrets set/get/list/delete/rotate/
 *   redact/audit, budget record/get/set-cap/list/reset/reports/
 *   alerts, presets list/get/set, dashboard) via
 *   `createFleetV28Tools` + `createEmptyFleetV28ToolState`.
 * - defaultToolFactory binding: bound v28 tools replace the
 *   placeholders (same 30 names, no duplicates).
 * - Budget meter: per-model pricing, fallback price flagged,
 *   warn/critical/exceeded levels, hard cap REFUSES records past
 *   the cap (meter unchanged, blockedRecords + 1), alerts, reset
 *   keeps history, daily/weekly reports aggregate per profile +
 *   top conversations.
 * - Presets: built-ins small/medium/large resolve; custom validates;
 *   per-profile choices are independent.
 * - Panels: runtime panel joins runtimes + queue + evictions;
 *   secrets panel carries names only (no values); budget panel
 *   joins meters + alerts + today; dashboard joins all four areas.
 * - i18n: 80 fleet.v28.* keys in all 6 locales, non-empty values,
 *   totals equal across locales. Namespace-only assertions — no
 *   global total is pinned. Plus: every `fleet.v28.*` key the
 *   renderer panels use exists in every locale (the v1.40 lesson:
 *   T6 shipped a renderer key the locales lacked).
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v28-budget-tools-i18n-v141.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FLEET_V28_TOOLS,
  findFleetV28Tool,
  fleetV28ReadTools,
  fleetV28ToolNamesValid,
  fleetV28ToolsByGroup,
  fleetV28WriteTools,
} from '../packages/core/dist/fleetV28/toolsV28.js';
import { FLEET_V28_VERSION } from '../packages/core/dist/fleetV28/index.js';
import {
  FLEET_V28_BUDGET_WARN_RATIO,
  FleetV28BudgetStore,
  fleetV28BudgetLevel,
  fleetV28DayOf,
  priceFleetV28Tokens,
} from '../packages/core/dist/fleetV28/budget.js';
import {
  FLEET_V28_PRESETS,
  FleetV28PresetStore,
  findFleetV28Preset,
  listFleetV28Presets,
} from '../packages/core/dist/fleetV28/presets.js';
import {
  buildFleetV28BudgetPanel,
  buildFleetV28Dashboard,
  buildFleetV28PresetsPanel,
  buildFleetV28RuntimePanel,
  buildFleetV28SecretsPanel,
} from '../packages/core/dist/fleetV28/panelsV28.js';
import { FleetV28RuntimeStore } from '../packages/core/dist/fleetV28/runtime.js';
import { FleetV28SecretStore } from '../packages/core/dist/fleetV28/secrets.js';
import {
  FLEET_V28_TOOLS as RUNNABLE_V28_TOOLS,
  createEmptyFleetV28ToolState,
  createFleetV28Tools,
  fleetV28ToolNamesUnique as runnableNamesUnique,
} from '../packages/tools/dist/fleetV28Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/index.js';

const LOCALES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];
const T0 = Date.UTC(2026, 10, 18, 9, 0, 0); // 2026-11-18 (UTC)
const DAY = '2026-11-18';

function loadLocale(loc) {
  return JSON.parse(readFileSync(new URL(`../apps/desktop/src/renderer/i18n/locales/${loc}.json`, import.meta.url), 'utf-8'));
}

async function run(tools, name, args = {}) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  const out = await tool.execute(args);
  return out;
}

function asJson(out) {
  assert.ok(!out.startsWith('Error:'), `expected JSON, got ${out}`);
  return JSON.parse(out);
}

test('tools v28: defs — 40 tools, names valid, groups', () => {
  assert.equal(FLEET_V28_VERSION, 'v28');
  assert.equal(FLEET_V28_TOOLS.length, 40);
  assert.equal(fleetV28ToolNamesValid(), true);
  assert.ok(FLEET_V28_TOOLS.every((t) => !t.name.includes('.')));
  assert.ok(FLEET_V28_TOOLS.every((t) => t.name.startsWith('fleet_v28_')));
  assert.equal(fleetV28ToolsByGroup('fleet_v28').length, 40);
  assert.equal(fleetV28ToolsByGroup('fleet_v28_runtime').length, 11);
  assert.equal(fleetV28ToolsByGroup('fleet_v28_secret').length, 7);
  assert.equal(fleetV28ToolsByGroup('fleet_v28_budget').length, 11);
  assert.equal(fleetV28ToolsByGroup('fleet_v28_sandbox').length, 4);
  assert.equal(fleetV28ToolsByGroup('fleet_v28_conversation').length, 3);
  assert.equal(fleetV28ToolsByGroup('fleet_v28_preset').length, 3);
  assert.equal(findFleetV28Tool('fleet_v28_runtime_start')?.write, true);
  assert.equal(findFleetV28Tool('fleet_v28_runtime_list')?.write, false);
  assert.equal(findFleetV28Tool('fleet_v28_secret_set')?.write, true);
  assert.equal(findFleetV28Tool('fleet_v28_secret_get')?.write, false);
  assert.equal(findFleetV28Tool('fleet_v28_budget_record')?.write, true);
  assert.equal(findFleetV28Tool('fleet_v28_budget_alerts')?.write, false);
  assert.equal(findFleetV28Tool('fleet_v28_preset_set')?.write, true);
  assert.equal(findFleetV28Tool('fleet_v28_dashboard')?.write, false);
  assert.ok(fleetV28WriteTools().length > 0 && fleetV28ReadTools().length > 0);
  assert.equal(fleetV28WriteTools().length + fleetV28ReadTools().length, 40);
  assert.equal(runnableNamesUnique(), true);
  assert.equal(RUNNABLE_V28_TOOLS.length, 40);
  assert.deepEqual(
    RUNNABLE_V28_TOOLS.map((t) => t.definition.name).sort(),
    FLEET_V28_TOOLS.map((t) => t.name).sort(),
    'runnable tools match pure defs',
  );
});

test('tools v28: unbound tools say "not configured"', async () => {
  const out = await run(RUNNABLE_V28_TOOLS, 'fleet_v28_dashboard');
  assert.ok(out.startsWith('Error:'));
  assert.ok(out.includes('not configured'));
  const out2 = await run(RUNNABLE_V28_TOOLS, 'fleet_v28_runtime_list');
  assert.ok(out2.startsWith('Error:'));
});

test('tools v28: bound runtime loop', async () => {
  const state = createEmptyFleetV28ToolState();
  const tools = createFleetV28Tools(() => state);
  const started = asJson(await run(tools, 'fleet_v28_runtime_start', {
    conversationId: 'conv-1', profileId: 'profile-a', botId: 'bot-1',
    cpuCores: 1, ramMB: 1024, diskMB: 2048,
  }));
  assert.equal(started.status, 'started');
  assert.equal(started.runtime.state, 'running');
  const bad = await run(tools, 'fleet_v28_runtime_start', { conversationId: 'conv-1', profileId: 'profile-a' });
  assert.ok(bad.startsWith('Error:'), 'duplicate start refused');
  const listed = asJson(await run(tools, 'fleet_v28_runtime_list', {}));
  assert.equal(listed.runtimes.length, 1);
  const got = asJson(await run(tools, 'fleet_v28_runtime_get', { conversationId: 'conv-1' }));
  assert.equal(got.runtime.profileId, 'profile-a');
  const usage = asJson(await run(tools, 'fleet_v28_runtime_usage', { conversationId: 'conv-1' }));
  assert.deepEqual(usage.overLimit, []);
  assert.equal(usage.aggregate.running, 1);
  const limits = asJson(await run(tools, 'fleet_v28_runtime_limits', {}));
  assert.equal(limits.defaultLimits.cpuCores, 1);
  const setLimits = asJson(await run(tools, 'fleet_v28_runtime_set_limits', { conversationId: 'conv-1', ramMB: 512 }));
  assert.equal(setLimits.runtime.limits.ramMB, 512);
  const badLimits = await run(tools, 'fleet_v28_runtime_set_limits', { conversationId: 'conv-1', cpuCores: 0 });
  assert.ok(badLimits.startsWith('Error:'));
  const health = asJson(await run(tools, 'fleet_v28_runtime_health', { conversationId: 'conv-1' }));
  assert.equal(health.health, 'unknown');
  const probed = asJson(await run(tools, 'fleet_v28_runtime_probe', { conversationId: 'conv-1', healthy: true }));
  assert.equal(probed.runtime.health, 'ok');
  const evicted = asJson(await run(tools, 'fleet_v28_runtime_evict_idle', {}));
  assert.deepEqual(evicted.evicted, [], 'fresh runtime is not idle');
  const stopped = asJson(await run(tools, 'fleet_v28_runtime_stop', { conversationId: 'conv-1' }));
  assert.equal(stopped.runtime.state, 'stopped');
  assert.ok(stopped.runtime.savedState);
  const restarted = asJson(await run(tools, 'fleet_v28_runtime_restart', { conversationId: 'conv-1' }));
  assert.equal(restarted.runtime.state, 'running');
  assert.equal(restarted.runtime.restarts, 1);
  const missing = await run(tools, 'fleet_v28_runtime_get', { conversationId: 'nope' });
  assert.ok(missing.startsWith('Error:'));
});

test('tools v28: bound secrets loop (isolation via tools)', async () => {
  const state = createEmptyFleetV28ToolState();
  const tools = createFleetV28Tools(() => state);
  const set = asJson(await run(tools, 'fleet_v28_secret_set', {
    profileId: 'profile-a', name: 'api-key', value: 'TOOL-SECRET-777',
  }));
  assert.equal(set.meta.version, 1);
  const got = asJson(await run(tools, 'fleet_v28_secret_get', { profileId: 'profile-a', name: 'api-key' }));
  assert.equal(got.value, 'TOOL-SECRET-777');
  const denied = await run(tools, 'fleet_v28_secret_get', { profileId: 'profile-b', name: 'api-key' });
  assert.ok(denied.startsWith('Error:'), 'profile B cannot read profile A secret via tools');
  const listed = asJson(await run(tools, 'fleet_v28_secret_list', { profileId: 'profile-a' }));
  assert.equal(listed.secrets.length, 1);
  assert.ok(!JSON.stringify(listed).includes('TOOL-SECRET-777'), 'list must never leak the value');
  const redacted = asJson(await run(tools, 'fleet_v28_secret_redact', {
    profileId: 'profile-a', text: 'leaked TOOL-SECRET-777 in log',
  }));
  assert.equal(redacted.text, 'leaked [REDACTED] in log');
  const rotated = asJson(await run(tools, 'fleet_v28_secret_rotate', {
    profileId: 'profile-a', name: 'api-key', newValue: 'TOOL-SECRET-888',
  }));
  assert.equal(rotated.meta.version, 2);
  const audit = asJson(await run(tools, 'fleet_v28_secret_audit', { profileId: 'profile-a' }));
  assert.ok(audit.audit.length >= 2);
  assert.ok(!JSON.stringify(audit).includes('TOOL-SECRET'), 'audit must never contain a value');
  const deleted = asJson(await run(tools, 'fleet_v28_secret_delete', { profileId: 'profile-a', name: 'api-key' }));
  assert.equal(deleted.deleted, true);
  const gone = await run(tools, 'fleet_v28_secret_get', { profileId: 'profile-a', name: 'api-key' });
  assert.ok(gone.startsWith('Error:'));
  const badName = await run(tools, 'fleet_v28_secret_set', { profileId: 'profile-a', name: '1bad', value: 'x-1234' });
  assert.ok(badName.startsWith('Error:'));
});

test('tools v28: bound budget + preset + dashboard loop', async () => {
  const state = createEmptyFleetV28ToolState();
  const tools = createFleetV28Tools(() => state);
  const presets = asJson(await run(tools, 'fleet_v28_preset_list', {}));
  assert.equal(presets.presets.length, 3);
  assert.deepEqual(presets.presets.map((p) => p.name), ['small', 'medium', 'large']);
  const presetGet = asJson(await run(tools, 'fleet_v28_preset_get', { profileId: 'profile-a' }));
  assert.equal(presetGet.resolved.preset.name, 'medium');
  const presetSet = asJson(await run(tools, 'fleet_v28_preset_set', { profileId: 'profile-a', presetName: 'large' }));
  assert.equal(presetSet.choice.presetName, 'large');
  const badPreset = await run(tools, 'fleet_v28_preset_set', { profileId: 'profile-a', presetName: 'huge' });
  assert.ok(badPreset.startsWith('Error:'));

  // Budget: cap via ensure + record; hard cap refuses.
  state.budget.ensureMeter('conv-1', 'profile-a', { capUsd: 0.01, nowMs: T0 });
  const rec = asJson(await run(tools, 'fleet_v28_budget_record', {
    conversationId: 'conv-1', profileId: 'profile-a', model: 'gpt-4o-mini',
    inputTokens: 10000, outputTokens: 5000,
  }));
  assert.equal(rec.recorded, true);
  assert.equal(rec.costUsd, 0.0045);
  const meter = asJson(await run(tools, 'fleet_v28_budget_get', { conversationId: 'conv-1' }));
  assert.equal(meter.meter.level, 'ok');
  assert.equal(meter.meter.percentUsed, 45);
  const blocked = await run(tools, 'fleet_v28_budget_record', {
    conversationId: 'conv-1', profileId: 'profile-a', model: 'gpt-4o-mini',
    inputTokens: 100000, outputTokens: 0,
  });
  assert.ok(blocked.startsWith('Error:'), 'record past the hard cap is refused');
  assert.ok(blocked.includes('Hard cap'));
  const alerts = asJson(await run(tools, 'fleet_v28_budget_alerts', {}));
  assert.equal(alerts.alerts.length, 0, '45% is under the 80% warn threshold');
  const capSet = asJson(await run(tools, 'fleet_v28_budget_set_cap', { conversationId: 'conv-1', capUsd: 0.005 }));
  assert.equal(capSet.meter.capUsd, 0.005);
  assert.equal(capSet.meter.level, 'critical', '90% used -> critical');
  const listed = asJson(await run(tools, 'fleet_v28_budget_list', { profileId: 'profile-a' }));
  assert.equal(listed.meters.length, 1);
  const daily = asJson(await run(tools, 'fleet_v28_budget_report_daily', { day: fleetV28DayOf(Date.now()) }));
  assert.equal(daily.report.records, 1);
  const weekly = asJson(await run(tools, 'fleet_v28_budget_report_weekly', { weekStart: DAY }));
  assert.equal(weekly.report.kind, 'weekly');
  const reset = asJson(await run(tools, 'fleet_v28_budget_reset', { conversationId: 'conv-1' }));
  assert.equal(reset.meter.costUsd, 0);
  const dailyAfterReset = asJson(await run(tools, 'fleet_v28_budget_report_daily', { day: fleetV28DayOf(Date.now()) }));
  assert.equal(dailyAfterReset.report.records, 1, 'reset keeps history for reports');

  const dashboard = asJson(await run(tools, 'fleet_v28_dashboard', { profileId: 'profile-a' }));
  assert.ok(dashboard.dashboard.summary.includes('Fleet v28'));
  assert.equal(dashboard.dashboard.runtimes.running, 0);
  assert.equal(dashboard.dashboard.budget.meters.length, 1);
  assert.equal(dashboard.dashboard.secrets.profileId, 'profile-a');
  assert.equal(dashboard.dashboard.presets.current.presetName, 'large');
  assert.equal(dashboard.dashboard.forecast, null, 'no window given => no forecast area');
  const todayDay = fleetV28DayOf(Date.now());
  const dashboardForecast = asJson(await run(tools, 'fleet_v28_dashboard', {
    profileId: 'profile-a',
    windowStart: todayDay,
    windowEnd: todayDay,
    horizon: fleetV28DayOf(Date.now() + 7 * 24 * 60 * 60 * 1000),
  }));
  assert.ok(dashboardForecast.dashboard.forecast !== null, 'window given => forecast area included');
  assert.equal(dashboardForecast.dashboard.forecast.forecasts.length, 1);
  const badWindow = await run(tools, 'fleet_v28_dashboard', {
    windowStart: 'today', windowEnd: todayDay, horizon: todayDay,
  });
  assert.ok(badWindow.startsWith('Error:'));
});

test('tools v28: defaultToolFactory binding replaces placeholders', () => {
  const inAll = ALL_TOOLS.filter((t) => t.definition.name.startsWith('fleet_v28_'));
  assert.equal(inAll.length, 40);
  const state = createEmptyFleetV28ToolState();
  const bound = createDefaultTools({ getFleetV28State: () => state });
  assert.equal(bound.length, ALL_TOOLS.length, 'bind must not add/remove tools');
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, bound.length, 'no duplicate tool names');
  const boundV28 = bound.filter((t) => t.definition.name.startsWith('fleet_v28_'));
  assert.equal(boundV28.length, 40);
  const plain = createDefaultTools();
  assert.equal(plain.length, ALL_TOOLS.length);
});

test('budget meter: pricing, levels, hard cap, alerts, reports', () => {
  assert.equal(priceFleetV28Tokens(1000, 0.0025), 0.0025);
  assert.equal(fleetV28BudgetLevel(0, 10), 'ok');
  assert.equal(fleetV28BudgetLevel(6.9, 10), 'ok');
  assert.equal(fleetV28BudgetLevel(7, 10), 'watch');
  assert.equal(fleetV28BudgetLevel(8, 10), 'warning');
  assert.equal(fleetV28BudgetLevel(9, 10), 'critical');
  assert.equal(fleetV28BudgetLevel(10, 10), 'exceeded');
  assert.equal(fleetV28BudgetLevel(12, 10), 'exceeded');
  assert.equal(fleetV28BudgetLevel(999, null), 'ok');
  assert.equal(FLEET_V28_BUDGET_WARN_RATIO, 0.8);
  assert.equal(fleetV28DayOf(T0), DAY);

  const store = new FleetV28BudgetStore();
  assert.equal(store.priceFor('gpt-4o-mini').priced, true);
  assert.equal(store.priceFor('no-such-model').priced, false, 'unknown model uses the flagged fallback price');
  const priced = store.setModelPrice({ model: 'my-model', inputPer1kUsd: 0.001, outputPer1kUsd: 0.002 });
  assert.equal(priced.ok, true);
  assert.equal(store.setModelPrice({ model: 'bad', inputPer1kUsd: -1, outputPer1kUsd: 0 }).ok, false);

  // Unknown model: cost is estimated and flagged.
  const est = store.recordUsage('conv-x', 'profile-a', 'no-such-model', 1000, 1000, T0);
  assert.equal(est.accepted, true);
  assert.equal(est.meter.hasUnpricedUsage, true);

  // Levels + hard cap on a capped meter.
  store.ensureMeter('conv-1', 'profile-a', { capUsd: 1, nowMs: T0 });
  const r1 = store.recordUsage('conv-1', 'profile-a', 'gpt-4o-mini', 100000, 0, T0);
  assert.equal(r1.accepted, true);
  assert.equal(r1.costUsd, 0.015);
  assert.equal(r1.meter.level, 'ok');
  const r2 = store.recordUsage('conv-1', 'profile-a', 'gpt-4o', 200000, 100000, T0 + 1000);
  // gpt-4o: 200k in * 0.0025/1k = 0.5; 100k out * 0.01/1k = 1.0 -> 1.5 total, over the $1 cap.
  assert.equal(r2.accepted, false);
  assert.equal(r2.blocked, true);
  assert.ok(r2.reason?.includes('Hard cap'));
  assert.equal(store.getMeter('conv-1')?.costUsd, 0.015, 'refused record leaves the meter unchanged');
  assert.equal(store.getMeter('conv-1')?.blockedRecords, 1);
  // Invalid records are refused without blocking.
  assert.equal(store.recordUsage('conv-1', 'profile-a', 'gpt-4o-mini', -1, 0, T0).accepted, false);
  assert.equal(store.recordUsage('conv-1', 'profile-a', 'gpt-4o-mini', 0, 0, T0).accepted, false);
  assert.equal(store.recordUsage('conv-1', 'profile-a', '', 10, 0, T0).accepted, false);

  // Warn threshold + alerts: 80% of a $0.10 cap.
  store.ensureMeter('conv-2', 'profile-b', { capUsd: 0.1, nowMs: T0 });
  store.recordUsage('conv-2', 'profile-b', 'gpt-4o-mini', 400000, 100000, T0);
  // 400k in * 0.00015 = 0.06; 100k out * 0.0006 = 0.06 -> 0.12 > 0.10 cap: refused!
  assert.equal(store.getMeter('conv-2')?.costUsd, 0);
  store.recordUsage('conv-2', 'profile-b', 'gpt-4o-mini', 200000, 100000, T0);
  // 0.03 + 0.06 = 0.09 -> 90% -> critical alert.
  assert.equal(store.getMeter('conv-2')?.level, 'critical');
  const alerts = store.listAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].conversationId, 'conv-2');
  assert.equal(alerts[0].level, 'critical');
  assert.equal(alerts[0].percentUsed, 90);
  assert.equal(store.totalCostUsd(), 0.115, 'conv-x 0.01 (fallback) + conv-1 0.015 + conv-2 0.09');
  assert.equal(store.totalTokens(), 402000, 'conv-x 2000 + conv-1 100000 + conv-2 300000');

  // Reports: daily + weekly aggregate per profile and top conversations.
  const daily = store.dailyReport(DAY);
  assert.equal(daily.kind, 'daily');
  assert.equal(daily.records, 3);
  assert.equal(daily.conversations, 3);
  assert.equal(daily.totalCostUsd, 0.115);
  assert.deepEqual(daily.byProfile.map((r) => r.id), ['profile-b', 'profile-a']);
  assert.equal(daily.topConversations[0].id, 'conv-2');
  const weekly = store.weeklyReport('2026-11-16');
  assert.equal(weekly.kind, 'weekly');
  assert.equal(weekly.period, '2026-11-16..2026-11-22');
  assert.equal(weekly.records, 3);
  assert.equal(store.dailyReport('2026-11-17').records, 0, 'other days are empty');
  assert.equal(store.listEntries({ profileId: 'profile-b' }).length, 1);

  // Cap + warnAt validation; reset.
  assert.equal(store.setCap('conv-missing', 5).ok, false);
  assert.equal(store.setCap('conv-1', 0).ok, false);
  assert.equal(store.setCap('conv-1', null).ok, true);
  assert.equal(store.getMeter('conv-1')?.level, 'ok', 'clearing the cap clears the level');
  assert.equal(store.setWarnAt('conv-1', 0).ok, false);
  assert.equal(store.setWarnAt('conv-1', 1).ok, false);
  assert.equal(store.setWarnAt('conv-1', 0.5).ok, true);
  assert.equal(store.resetMeter('conv-1', T0 + 2000), true);
  assert.equal(store.getMeter('conv-1')?.costUsd, 0);
  assert.equal(store.resetMeter('conv-missing'), false);
  assert.equal(store.removeMeter('conv-1'), true);
  assert.equal(store.getMeter('conv-1'), undefined);
});

test('presets: built-ins resolve, custom validates, per-profile independence', () => {
  assert.equal(FLEET_V28_PRESETS.length, 3);
  assert.deepEqual(listFleetV28Presets().map((p) => p.name), ['small', 'medium', 'large']);
  const small = findFleetV28Preset('small');
  assert.equal(small?.limits.cpuCores, 0.5);
  assert.equal(small?.capUsd, 1);
  const large = findFleetV28Preset('large');
  assert.equal(large?.limits.cpuCores, 2);
  assert.equal(large?.capUsd, 20);
  assert.equal(findFleetV28Preset('custom'), undefined);
  assert.equal(findFleetV28Preset('huge'), undefined);

  const store = new FleetV28PresetStore();
  assert.equal(store.resolveForProfile('profile-a').preset.name, 'medium', 'default is medium');
  assert.equal(store.setPreset('profile-a', 'small').ok, true);
  assert.equal(store.resolveForProfile('profile-a').preset.name, 'small');
  assert.equal(store.resolveForProfile('profile-b').preset.name, 'medium', 'profiles are independent');
  assert.equal(store.setPreset('profile-a', 'huge').ok, false);
  assert.equal(store.setPreset('profile-a', 'custom', { customLimits: { cpuCores: 0 }, customCapUsd: 3 }).ok, false);
  const custom = store.setPreset('profile-a', 'custom', {
    customLimits: { cpuCores: 1.5, ramMB: 3072, diskMB: 6000, timeoutMs: 45 * 60 * 1000, idleTimeoutMs: 20 * 60 * 1000, maxRestarts: 4 },
    customCapUsd: 7,
  });
  assert.equal(custom.ok, true);
  assert.equal(store.resolveForProfile('profile-a').preset.name, 'custom');
  assert.equal(store.resolveForProfile('profile-a').preset.limits.cpuCores, 1.5);
  assert.equal(store.resolveForProfile('profile-a').preset.capUsd, 7);
  assert.equal(store.clearPreset('profile-a'), true);
  assert.equal(store.resolveForProfile('profile-a').preset.name, 'medium');
  assert.equal(store.clearPreset('profile-a'), false);
  assert.deepEqual(store.listProfiles(), []);
});

test('panels v28: runtime, secrets (no values), budget, presets, dashboard', () => {
  const runtimes = new FleetV28RuntimeStore({ maxConcurrentRuntimes: 2 });
  runtimes.startRuntime('conv-1', 'profile-a', { nowMs: T0, limits: { idleTimeoutMs: 5 * 60 * 1000 } });
  runtimes.startRuntime('conv-2', 'profile-a', { nowMs: T0 });
  runtimes.recordUsage('conv-1', { cpuCores: 0.5, ramMB: 512, diskMB: 100 }, T0 + 1000);
  const runtimePanel = buildFleetV28RuntimePanel(runtimes, T0 + 2000);
  assert.equal(runtimePanel.running, 2);
  assert.equal(runtimePanel.maxConcurrent, 2);
  assert.equal(runtimePanel.runtimes.length, 2);
  assert.equal(runtimePanel.runtimes[0].idleMs, 1000);
  assert.deepEqual(runtimePanel.queue, []);
  assert.ok(runtimePanel.summary.includes('2 running'));

  const secrets = new FleetV28SecretStore();
  secrets.setSecret('profile-a', 'api-key', 'PANEL-SECRET-123', T0);
  secrets.setSecret('profile-a', 'token', 'PANEL-TOKEN-456', T0);
  const secretsPanel = buildFleetV28SecretsPanel(secrets, 'profile-a');
  assert.equal(secretsPanel.secrets.length, 2);
  assert.ok(!JSON.stringify(secretsPanel).includes('PANEL-SECRET-123'), 'panel must never carry a value');
  assert.ok(!JSON.stringify(secretsPanel).includes('PANEL-TOKEN-456'));
  assert.equal(secretsPanel.recentAudit[0].action, 'set');
  assert.deepEqual(buildFleetV28SecretsPanel(secrets, 'profile-b').secrets, []);

  const budget = new FleetV28BudgetStore();
  budget.ensureMeter('conv-1', 'profile-a', { capUsd: 5, nowMs: T0 });
  budget.recordUsage('conv-1', 'profile-a', 'gpt-4o-mini', 10000, 5000, T0);
  const budgetPanel = buildFleetV28BudgetPanel(budget, { nowMs: T0 });
  assert.equal(budgetPanel.meters.length, 1);
  assert.equal(budgetPanel.totalCostUsd, 0.0045);
  assert.equal(budgetPanel.totalTokens, 15000);
  assert.deepEqual(budgetPanel.alerts, []);
  assert.ok(budgetPanel.today !== null, 'today report exists when entries exist today');
  const emptyPanel = buildFleetV28BudgetPanel(new FleetV28BudgetStore(), { nowMs: T0 });
  assert.equal(emptyPanel.today, null);

  const presets = new FleetV28PresetStore();
  presets.setPreset('profile-a', 'large', { nowMs: T0 });
  const presetsPanel = buildFleetV28PresetsPanel(presets, 'profile-a');
  assert.equal(presetsPanel.presets.length, 3);
  assert.equal(presetsPanel.current?.presetName, 'large');

  const dashboard = buildFleetV28Dashboard({ runtimes, secrets, budget, presets, profileId: 'profile-a', nowMs: T0 });
  assert.ok(dashboard.summary.includes('Fleet v28'));
  assert.equal(dashboard.runtimes.running, 2);
  assert.equal(dashboard.budget.meters.length, 1);
  assert.equal(dashboard.secrets?.secrets.length, 2);
  assert.equal(dashboard.presets.current?.presetName, 'large');
  const noProfile = buildFleetV28Dashboard({ runtimes, secrets, budget, presets, nowMs: T0 });
  assert.equal(noProfile.secrets, null, 'no profile => no secrets area (secrets are per-profile)');
});

test('i18n v28: 80 fleet.v28 keys in all 6 locales, totals equal', () => {
  const totals = new Set();
  for (const loc of LOCALES) {
    const data = loadLocale(loc);
    totals.add(Object.keys(data).length);
    const v28 = Object.keys(data).filter((k) => k.startsWith('fleet.v28.'));
    assert.equal(v28.length, 80, `${loc} must have 80 fleet.v28 keys`);
    assert.deepEqual(v28, [...v28].sort(), `${loc} fleet.v28 keys must be sorted`);
    for (const k of v28) {
      assert.equal(typeof data[k], 'string', `${loc}:${k} must be a string`);
      assert.ok(data[k].length > 0, `${loc}:${k} must be non-empty`);
    }
    // Spot checks: the keys the panels actually render.
    assert.ok(data['fleet.v28.runtimeTitle']);
    assert.ok(data['fleet.v28.budgetTitle']);
    assert.ok(data['fleet.v28.secretsTitle']);
    assert.ok(data['fleet.v28.dashboardTitle']);
    assert.ok(data['fleet.v28.status.running']);
    assert.ok(data['fleet.v28.health.ok']);
    assert.ok(data['fleet.v28.level.exceeded']);
    assert.ok(data['fleet.v28.capReached']);
    assert.ok(data['fleet.v28.nearCap']);
    assert.ok(data['fleet.v28.preset.large']);
    assert.ok(data['fleet.v28.redacted']);
  }
  // Totals must be identical across all 6 locales. No global total is
  // pinned here: other teams add their own keys on top.
  assert.equal(totals.size, 1, 'all 6 locales must have the same key total');
});

test('i18n v28: every key the renderer panels use exists in every locale', () => {
  // The v1.40 lesson: a renderer key missing from the locales breaks
  // the UI. Extract every t('fleet.v28.…') + template-literal
  // t(`fleet.v28.<group>.${…}`) from the three v28 panels and assert
  // each resolves in every locale.
  const panelFiles = [
    'FleetV28RuntimePanel.tsx',
    'FleetV28BudgetPanel.tsx',
    'FleetV28SecretsPanel.tsx',
  ];
  const dynamicGroups = {
    'fleet.v28.status.': ['running', 'starting', 'stopped', 'evicted', 'failed', 'restarting'],
    'fleet.v28.health.': ['ok', 'degraded', 'failed', 'unknown'],
    'fleet.v28.level.': ['ok', 'watch', 'warning', 'critical', 'exceeded'],
  };
  const used = new Set();
  for (const file of panelFiles) {
    const src = readFileSync(new URL(`../apps/desktop/src/renderer/components/${file}`, import.meta.url), 'utf-8');
    for (const m of src.matchAll(/t\('(fleet\.v28\.[^']+)'\)/g)) used.add(m[1]);
    for (const m of src.matchAll(/t\(`(fleet\.v28\.[\w.]+)\$\{/g)) {
      const prefix = m[1];
      for (const suffix of dynamicGroups[prefix] ?? []) used.add(prefix + suffix);
    }
  }
  assert.ok(used.size >= 50, `expected 50+ renderer keys, found ${used.size}`);
  for (const loc of LOCALES) {
    const data = loadLocale(loc);
    for (const key of used) {
      assert.ok(typeof data[key] === 'string' && data[key].length > 0, `${loc} is missing renderer key ${key}`);
    }
  }
});
