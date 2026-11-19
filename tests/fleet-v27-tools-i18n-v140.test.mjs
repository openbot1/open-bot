/**
 * Tests for fleet v27 tools + i18n (v1.40, Team T6).
 *
 * Covers:
 * - Pure tool defs: 30 tools, unique snake_case names, no dots,
 *   write/read split.
 * - Runnable tools: unbound says "not configured"; bound state does
 *   the full loop (campaign create/start/advance/cancel/results/
 *   retry, templates list/get/suggest, automations create/list/due/
 *   mark-ran, quota limits/usage/evaluate/alerts/policy/queue,
 *   dashboard) via `createFleetV27Tools` + `createEmptyFleetV27ToolState`.
 * - defaultToolFactory binding: bound v27 tools replace the
 *   placeholders (same 30 names, no duplicates).
 * - Panels: campaign panel joins campaigns + active/finished runs;
 *   automation panel joins templates + automations + suggestions;
 *   quota panel joins limits/usage/alerts/queue/decisions; dashboard
 *   joins all three areas.
 * - i18n: 72 fleet.v27.* keys in all 6 locales, non-empty values,
 *   totals equal across locales and >= the v140 baseline (8322 keys
 *   before v27). No hardcoded global total.
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v27-tools-i18n-v140.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FLEET_V27_TOOLS,
  findFleetV27Tool,
  fleetV27ReadTools,
  fleetV27ToolNamesValid,
  fleetV27ToolsByGroup,
  fleetV27WriteTools,
} from '../packages/core/dist/fleetV27/toolsV27.js';
import { FLEET_V27_VERSION } from '../packages/core/dist/fleetV27/index.js';
import {
  buildFleetV27AutomationPanel,
  buildFleetV27CampaignPanel,
  buildFleetV27Dashboard,
  buildFleetV27QuotaPanel,
} from '../packages/core/dist/fleetV27/panelsV27.js';
import {
  FLEET_V27_TOOLS as RUNNABLE_V27_TOOLS,
  createEmptyFleetV27ToolState,
  createFleetV27Tools,
  fleetV27ToolNamesUnique as runnableNamesUnique,
} from '../packages/tools/dist/fleetV27Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/index.js';

const LOCALES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];
const V140_BASELINE_KEYS = 8322;

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

test('tools v27: defs — 30 tools, names valid, groups', () => {
  assert.equal(FLEET_V27_VERSION, 'v27');
  assert.equal(FLEET_V27_TOOLS.length, 30);
  assert.equal(fleetV27ToolNamesValid(), true);
  assert.ok(FLEET_V27_TOOLS.every((t) => !t.name.includes('.')));
  assert.ok(FLEET_V27_TOOLS.every((t) => t.name.startsWith('fleet_v27_')));
  assert.equal(fleetV27ToolsByGroup('fleet_v27').length, 30);
  assert.equal(findFleetV27Tool('fleet_v27_campaign_create')?.write, true);
  assert.equal(findFleetV27Tool('fleet_v27_campaign_list')?.write, false);
  assert.equal(findFleetV27Tool('fleet_v27_automation_create')?.write, true);
  assert.equal(findFleetV27Tool('fleet_v27_quota_evaluate')?.write, false);
  assert.equal(findFleetV27Tool('fleet_v27_quota_set_limits')?.write, true);
  assert.equal(findFleetV27Tool('fleet_v27_dashboard')?.write, false);
  assert.equal(findFleetV27Tool('fleet_v27_template_suggest')?.write, false);
  assert.ok(fleetV27WriteTools().length > 0);
  assert.ok(fleetV27ReadTools().length > 0);
  assert.equal(fleetV27WriteTools().length + fleetV27ReadTools().length, 30);
  assert.equal(findFleetV27Tool('nope'), undefined);
});

test('tools v27: runnable names unique, unbound says not configured', async () => {
  assert.equal(runnableNamesUnique(), true);
  assert.equal(RUNNABLE_V27_TOOLS.length, 30);
  assert.deepEqual(
    [...RUNNABLE_V27_TOOLS.map((t) => t.definition.name)].sort(),
    [...FLEET_V27_TOOLS.map((t) => t.name)].sort(),
  );
  const out = await run(RUNNABLE_V27_TOOLS, 'fleet_v27_dashboard');
  assert.ok(out.startsWith('Error:'), 'unbound dashboard must error');
  assert.ok(out.includes('not configured'));
  const out2 = await run(RUNNABLE_V27_TOOLS, 'fleet_v27_campaign_list');
  assert.ok(out2.startsWith('Error:'));
});

test('tools v27: bound state runs the full campaign loop', async () => {
  const state = createEmptyFleetV27ToolState();
  const tools = createFleetV27Tools(() => state);

  const created = asJson(await run(tools, 'fleet_v27_campaign_create', {
    id: 'cmp-1',
    name: 'Review sprint PRs',
    bots: ['bot-a', 'bot-b', 'bot-c'],
    task: { kind: 'prompt', text: 'Review the PRs.', maxRetries: 0 },
    concurrency: 1,
    tags: ['review'],
  }));
  assert.equal(created.created, true);
  assert.equal(created.campaign.bots.length, 3);

  // Bad campaign is refused with reasons, not a crash.
  const bad = await run(tools, 'fleet_v27_campaign_create', {
    id: 'cmp-1', name: 'Again', bots: ['bot-a'], task: { kind: 'prompt', text: 'x' },
  });
  assert.ok(bad.startsWith('Error:'));
  assert.ok(bad.includes('campaign-exists'));

  const list = asJson(await run(tools, 'fleet_v27_campaign_list', {}));
  assert.equal(list.campaigns.length, 1);
  assert.equal(asJson(await run(tools, 'fleet_v27_campaign_list', { tag: 'nightly' })).campaigns.length, 0);
  assert.equal(asJson(await run(tools, 'fleet_v27_campaign_get', { id: 'cmp-1' })).campaign.name, 'Review sprint PRs');
  assert.ok((await run(tools, 'fleet_v27_campaign_get', { id: 'nope' })).startsWith('Error:'));

  const started = asJson(await run(tools, 'fleet_v27_campaign_start', { campaignId: 'cmp-1' }));
  assert.equal(started.started, true);
  const runId = started.run.id;
  assert.equal(started.run.entries[0].state, 'running');
  assert.equal(started.run.entries[1].state, 'queued');

  let prog = asJson(await run(tools, 'fleet_v27_campaign_progress', { runId }));
  assert.equal(prog.status, 'running');
  assert.equal(prog.aggregate.total, 3);
  assert.equal(prog.aggregate.running, 1);

  const adv1 = asJson(await run(tools, 'fleet_v27_campaign_advance', {
    runId, outcomes: [{ botId: 'bot-a', outcome: 'succeeded', text: 'done' }],
  }));
  assert.deepEqual(adv1.started, ['bot-b']);
  const adv2 = asJson(await run(tools, 'fleet_v27_campaign_advance', {
    runId, outcomes: [{ botId: 'bot-b', outcome: 'failed', error: 'boom' }],
  }));
  assert.deepEqual(adv2.started, ['bot-c']);
  const adv3 = asJson(await run(tools, 'fleet_v27_campaign_advance', {
    runId, outcomes: [{ botId: 'bot-c', outcome: 'succeeded', text: 'ok' }],
  }));
  assert.equal(adv3.status, 'partial');
  prog = asJson(await run(tools, 'fleet_v27_campaign_progress', { runId }));
  assert.equal(prog.aggregate.succeeded, 2);
  assert.equal(prog.aggregate.failed, 1);

  // History shows the finished run with its aggregate.
  const results = asJson(await run(tools, 'fleet_v27_campaign_results', {}));
  assert.equal(results.runs.length, 1);
  assert.equal(results.runs[0].status, 'partial');
  assert.equal(results.runs[0].aggregate.failed, 1);
  assert.equal(asJson(await run(tools, 'fleet_v27_campaign_results', { status: 'failed' })).runs.length, 0);

  // Retry the failed bot as a new run, then cancel it.
  const retry = asJson(await run(tools, 'fleet_v27_campaign_retry_failed', { runId }));
  assert.equal(retry.retried, true);
  assert.deepEqual(retry.run.entries.map((e) => e.botId), ['bot-b']);
  const cancelled = asJson(await run(tools, 'fleet_v27_campaign_cancel', { runId: retry.run.id, reason: 'stop' }));
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.run.status, 'cancelled');

  assert.equal(asJson(await run(tools, 'fleet_v27_campaign_remove', { id: 'cmp-1' })).removed, true);
  assert.ok((await run(tools, 'fleet_v27_campaign_remove', { id: 'cmp-1' })).startsWith('Error:'));
  // Runs stay in history after the campaign is removed.
  assert.equal(asJson(await run(tools, 'fleet_v27_campaign_results', {})).runs.length, 2);
});

test('tools v27: bound state runs templates + automations', async () => {
  const state = createEmptyFleetV27ToolState();
  const tools = createFleetV27Tools(() => state);

  const templates = asJson(await run(tools, 'fleet_v27_template_list', {}));
  assert.equal(templates.templates.length, 8);
  assert.equal(asJson(await run(tools, 'fleet_v27_template_list', { category: 'memory' })).templates.length, 1);
  const tpl = asJson(await run(tools, 'fleet_v27_template_get', { id: 'pr-review-morning' }));
  assert.equal(tpl.template.defaultCron, 'daily-08-00');
  assert.ok((await run(tools, 'fleet_v27_template_get', { id: 'nope' })).startsWith('Error:'));

  const sugg = asJson(await run(tools, 'fleet_v27_template_suggest', {
    repoPath: '/home/hatch/workspace/open-bot', hasGit: true,
    botTags: ['review', 'coding'], botCount: 3, capabilities: ['git', 'repo-read'], hourOfDay: 8, limit: 3,
  }));
  assert.equal(sugg.suggestions.length, 3);
  assert.equal(sugg.suggestions[0].templateId, 'pr-review-morning');

  const created = asJson(await run(tools, 'fleet_v27_automation_create', {
    templateId: 'pr-review-morning', botId: 'bot-review', repoPath: '/home/hatch/workspace/open-bot',
  }));
  assert.equal(created.created, true);
  assert.equal(created.automation.id, 'auto-0001');
  assert.ok(created.automation.taskText.includes('/home/hatch/workspace/open-bot'));

  const bad = await run(tools, 'fleet_v27_automation_create', {
    templateId: 'memory-digest-nightly', botId: 'bot-mem', params: {},
  });
  assert.ok(bad.startsWith('Error:'));
  assert.ok(bad.includes('missing-param'));

  const list = asJson(await run(tools, 'fleet_v27_automation_list', {}));
  assert.equal(list.automations.length, 1);
  assert.equal(asJson(await run(tools, 'fleet_v27_automation_get', { id: 'auto-0001' })).automation.botId, 'bot-review');
  const due = asJson(await run(tools, 'fleet_v27_automation_due', {}));
  assert.ok(Array.isArray(due.due));
  const marked = asJson(await run(tools, 'fleet_v27_automation_mark_ran', { id: 'auto-0001' }));
  assert.equal(marked.marked, true);
  assert.equal(marked.automation.runCount, 1);
  assert.equal(asJson(await run(tools, 'fleet_v27_automation_set_enabled', { id: 'auto-0001', enabled: false })).updated, true);
  assert.equal(asJson(await run(tools, 'fleet_v27_automation_list', { enabled: true })).automations.length, 0);
  assert.equal(asJson(await run(tools, 'fleet_v27_automation_remove', { id: 'auto-0001' })).removed, true);
});

test('tools v27: bound state runs quota v2 + dashboard', async () => {
  const state = createEmptyFleetV27ToolState();
  const tools = createFleetV27Tools(() => state);

  const limits = asJson(await run(tools, 'fleet_v27_quota_limits', {}));
  assert.equal(limits.limits.cpuCores, 4);
  assert.equal(limits.policy.onCpuExhausted, 'queue');

  const usage = asJson(await run(tools, 'fleet_v27_quota_usage', {}));
  assert.equal(usage.usage.runningBots, 0);
  assert.equal(usage.alerts.length, 7);
  assert.ok(usage.summary.includes('0/8 bots'));

  const admit = asJson(await run(tools, 'fleet_v27_quota_evaluate', {
    kind: 'bot-start', cpuCores: 1, ramMB: 1024, extraRunningBots: 1,
  }));
  assert.equal(admit.decision, 'admit');
  // Admitted evaluation applies the usage.
  assert.equal(asJson(await run(tools, 'fleet_v27_quota_usage', {})).usage.runningBots, 1);

  const over = asJson(await run(tools, 'fleet_v27_quota_evaluate', {
    kind: 'bot-start', cpuCores: 99, extraRunningBots: 1,
  }));
  assert.equal(over.decision, 'queue');
  assert.ok(over.reasons.includes('cpu-over-limit'));

  const badLimits = await run(tools, 'fleet_v27_quota_set_limits', { cpuCores: -1 });
  assert.ok(badLimits.startsWith('Error:'));
  const setLimits = asJson(await run(tools, 'fleet_v27_quota_set_limits', { cpuCores: 2 }));
  assert.equal(setLimits.updated, true);
  assert.equal(setLimits.limits.cpuCores, 2);

  const policy = asJson(await run(tools, 'fleet_v27_quota_policy', {}));
  assert.equal(policy.policy.onRunsExhausted, 'defer');
  const setPolicy = asJson(await run(tools, 'fleet_v27_quota_set_policy', { onCpuExhausted: 'reject' }));
  assert.equal(setPolicy.updated, true);
  assert.equal(setPolicy.policy.onCpuExhausted, 'reject');
  const badPolicy = await run(tools, 'fleet_v27_quota_set_policy', { onCpuExhausted: 'explode' });
  assert.ok(badPolicy.startsWith('Error:'));

  const queueEmpty = asJson(await run(tools, 'fleet_v27_quota_queue_list', {}));
  assert.deepEqual(queueEmpty.queue, []);
  const promoteEmpty = asJson(await run(tools, 'fleet_v27_quota_queue_promote', {}));
  assert.equal(promoteEmpty.promoted, false);

  const dash = asJson(await run(tools, 'fleet_v27_dashboard', {}));
  assert.ok(dash.summary.includes('Fleet v27'));
  assert.equal(dash.campaigns.campaigns.length, 0);
  assert.equal(dash.automations.templates.length, 8);
  assert.equal(dash.quota.usage.runningBots, 1);
});

test('tools v27: defaultToolFactory binding replaces placeholders', () => {
  const inAll = ALL_TOOLS.filter((t) => t.definition.name.startsWith('fleet_v27_'));
  assert.equal(inAll.length, 30);
  const state = createEmptyFleetV27ToolState();
  const bound = createDefaultTools({ getFleetV27State: () => state });
  const boundV27 = bound.filter((t) => t.definition.name.startsWith('fleet_v27_'));
  assert.equal(boundV27.length, 30);
  assert.deepEqual(
    [...boundV27.map((t) => t.definition.name)].sort(),
    [...inAll.map((t) => t.definition.name)].sort(),
  );
  // No duplicates anywhere in the bound list.
  const names = bound.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
  // Without the wiring, the placeholders stay.
  const plain = createDefaultTools();
  assert.equal(plain.filter((t) => t.definition.name.startsWith('fleet_v27_')).length, 30);
});

test('panels v27: campaign + automation + quota + dashboard', () => {
  const state = createEmptyFleetV27ToolState();
  state.campaigns.createCampaign({
    id: 'cmp-1', name: 'Review', bots: [{ botId: 'bot-a' }, { botId: 'bot-b' }],
    task: { kind: 'prompt', text: 'Review.', maxRetries: 0 }, concurrency: 2, createdAtMs: 1000,
  });
  const { run } = state.campaigns.startRun('cmp-1', { nowMs: 1000 });
  state.campaigns.advanceRun(run.id, [{ botId: 'bot-a', outcome: 'succeeded' }], { nowMs: 2000 });
  state.automations.createFromTemplate({ templateId: 'pr-review-morning', botId: 'bot-a', createdAtMs: 1000 });
  state.quota.evaluate({ kind: 'bot-start', cpuCores: 1, extraRunningBots: 1 }, 1000);

  const camp = buildFleetV27CampaignPanel(state.campaigns);
  assert.equal(camp.campaigns.length, 1);
  assert.equal(camp.campaigns[0].latestStatus, 'running');
  assert.equal(camp.activeRuns.length, 1);
  assert.equal(camp.activeRuns[0].aggregate.finished, 1);
  assert.equal(camp.finishedRuns.length, 0);

  const auto = buildFleetV27AutomationPanel(state.automations, { botTags: ['review'], hasGit: true }, 1500);
  assert.equal(auto.templates.length, 8);
  assert.equal(auto.automations.length, 1);
  assert.equal(auto.suggestions[0].templateId, 'pr-review-morning');
  assert.equal(auto.dueNow.length, 0);

  const quota = buildFleetV27QuotaPanel(state.quota);
  assert.equal(quota.usage.runningBots, 1);
  assert.equal(quota.alerts.length, 7);
  assert.equal(quota.worstLevel, 'ok');
  assert.equal(quota.recentDecisions.length, 1);
  assert.equal(quota.recentDecisions[0].decision, 'admit');

  const dash = buildFleetV27Dashboard({ campaigns: state.campaigns, automations: state.automations, quota: state.quota, nowMs: 1500 });
  assert.ok(dash.summary.includes('Fleet v27'));
  assert.equal(dash.campaigns.campaigns.length, 1);
  assert.equal(dash.automations.automations.length, 1);
  assert.equal(dash.quota.queue.length, 0);
});

test('i18n v27: 73 fleet.v27 keys in all 6 locales, totals equal', () => {
  const totals = new Set();
  for (const loc of LOCALES) {
    const data = loadLocale(loc);
    totals.add(Object.keys(data).length);
    const v27 = Object.keys(data).filter((k) => k.startsWith('fleet.v27.'));
    assert.equal(v27.length, 73, `${loc} must have 73 fleet.v27 keys`);
    for (const k of v27) {
      assert.equal(typeof data[k], 'string', `${loc}:${k} must be a string`);
      assert.ok(data[k].length > 0, `${loc}:${k} must be non-empty`);
    }
    // Spot checks: the UI's panel + tab + status keys exist.
    assert.ok(data['fleet.v27.campaignTitle']);
    assert.ok(data['fleet.v27.automationTitle']);
    assert.ok(data['fleet.v27.quotaTitle']);
    assert.ok(data['fleet.v27.tab.usage']);
    assert.ok(data['fleet.v27.status.partial']);
    assert.ok(data['fleet.v27.activeRuns'].includes('{count}'));
    assert.ok(data['fleet.v27.queuePosition'].includes('{position}'));
  }
  // Totals must be identical across all 6 locales and at least the
  // v140 baseline (8322 keys before v27 added its 73). No hardcoded
  // global total: later v140 teams add their own keys on top.
  assert.equal(totals.size, 1, 'all 6 locales must have the same key total');
  assert.ok([...totals][0] >= V140_BASELINE_KEYS, 'total must cover the v140 baseline');
  assert.ok([...totals][0] >= V140_BASELINE_KEYS + 73, 'total must cover baseline + 73 fleet.v27 keys');
});
