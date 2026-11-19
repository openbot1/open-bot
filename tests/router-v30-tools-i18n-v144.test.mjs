/**
 * Router v30 — tools + i18n (v1.44, Doi T5, node:test).
 *
 * Covers (thuan, khong model that, khong network — executor/prober/
 * cliRunner mock):
 * - 22 ten duy nhat, needsApproval=false; co mat trong ALL_TOOLS;
 *   createDefaultTools({getRouterV30State}) bind khong trung lap.
 * - Catalog list/get/refresh/stale qua tool (refresh them model moi,
 *   tu choi muc sai; stale liet ke entry cu).
 * - Route qua tool (cheapest -> local $0; realtime -> realtime) +
 *   latency record/stats qua tool (EWMA tu mau do that).
 * - Fallback plan/run qua tool (mock executor: loi 429 -> fallback
 *   model sau; loi 401 -> dung; log ghi lai).
 * - Health probe/summary qua tool (mock prober: ok nhanh -> healthy).
 * - CLI detect/list/consent/enable/label qua tool (mock runner: co
 *   codex + gemini-cli; chua dong y -> rong; dong y + tat 1 nguon).
 * - CLI invoke qua tool (mock invoke runner: chua dong y -> loi;
 *   dong y -> output mock) + route history qua tool (ghi sau moi
 *   lan route, tom tat + recent).
 * - Budget set/report qua tool (dat tran ngay, bao cao con lai;
 *   route tranh provider het ngan sach).
 * - i18n: 36 key routerV30.* co mat du 6 locale, so key 6 locale
 *   bang nhau; tong so key >= base 9245 + 36 (floor, khong pin
 *   exact — doi khac cung them key).
 * - Policy get/set qua tool (set profile cheapest; patch sai bi tu choi).
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/router-v30-tools-i18n-v144.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ROUTER_V30_TOOL_NAMES,
  createDefaultRouterV30State,
  createRouterV30Tools,
  isRouterV30ToolName,
} from '../packages/tools/dist/routerV30Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tools, name, args) {
  const tool = toolByName(tools, name);
  const out = await tool.execute(args);
  assert.equal(typeof out, 'string');
  return out;
}

function runJson(tools, name, args) {
  return run(tools, name, args).then((out) => {
    assert.ok(!out.startsWith('Error:'), `${name} failed: ${out}`);
    return JSON.parse(out);
  });
}

const ROUTER_V30_KEYS = [
  'routerV30.title',
  'routerV30.subtitle',
  'routerV30.catalogTitle',
  'routerV30.routeTitle',
  'routerV30.healthTitle',
  'routerV30.fallbackTitle',
  'routerV30.cliTitle',
  'routerV30.policyTitle',
  'routerV30.chooseModel',
  'routerV30.cheapest',
  'routerV30.fastest',
  'routerV30.balanced',
  'routerV30.bestQuality',
  'routerV30.estimatedCost',
  'routerV30.estimatedLatency',
  'routerV30.latencyMeasured',
  'routerV30.latencyEstimated',
  'routerV30.realtimeVoice',
  'routerV30.fullDuplex',
  'routerV30.noModelFits',
  'routerV30.fallbackUsed',
  'routerV30.providerHealthy',
  'routerV30.providerDegraded',
  'routerV30.providerUnhealthy',
  'routerV30.dailyBudget',
  'routerV30.costTitle',
  'routerV30.totalCost',
  'routerV30.consentTitle',
  'routerV30.cliNotInstalled',
  'routerV30.staleCatalog',
  'routerV30.cliInvokeTitle',
  'routerV30.historyTitle',
  'routerV30.invokeDisabled',
  'routerV30.invokeRequiresConsent',
  'routerV30.budgetTitle',
  'routerV30.budgetRemaining',
];

test('tools: 22 ten duy nhat, needsApproval=false, co trong ALL_TOOLS', () => {
  assert.equal(ROUTER_V30_TOOL_NAMES.length, 22);
  assert.equal(new Set(ROUTER_V30_TOOL_NAMES).size, 22);
  assert.ok(ROUTER_V30_TOOL_NAMES.every((n) => n.startsWith('router_v30_')));
  const tools = createRouterV30Tools();
  assert.equal(tools.length, 22);
  assert.ok(tools.every((t) => t.needsApproval === false));
  assert.ok(tools.every((t) => isRouterV30ToolName(t.definition.name)));
  assert.equal(isRouterV30ToolName('router_v30_route'), true);
  assert.equal(isRouterV30ToolName('router_v29_route'), false);
  const allNames = new Set(ALL_TOOLS.map((t) => t.definition.name));
  assert.ok(ROUTER_V30_TOOL_NAMES.every((n) => allNames.has(n)));
  assert.equal(ALL_TOOLS.length, allNames.size, 'ALL_TOOLS khong duoc co ten trung');
});

test('tools: createDefaultTools bind khong trung lap', () => {
  const state = createDefaultRouterV30State();
  const bound = createDefaultTools({ getRouterV30State: () => state });
  const names = bound.map((t) => t.definition.name);
  assert.equal(names.length, new Set(names).size);
  assert.ok(ROUTER_V30_TOOL_NAMES.every((n) => names.includes(n)));
  const bound2 = createDefaultTools({ getRouterV30State: () => state });
  assert.equal(bound2.map((t) => t.definition.name).length, new Set(bound2.map((t) => t.definition.name)).size);
});

test('tools: catalog list/get/refresh/stale', async () => {
  const tools = createRouterV30Tools();
  const all = await runJson(tools, 'router_v30_catalog_list', {});
  assert.equal(all.count, 18);
  assert.equal(all.summary.total, 18);
  assert.equal(all.summary.catalogVersion, 30);
  const gemini = await runJson(tools, 'router_v30_catalog_list', { provider: 'gemini' });
  assert.equal(gemini.count, 4);
  const free = await runJson(tools, 'router_v30_catalog_list', { tag: 'free' });
  assert.equal(free.count, 4);
  const rt = await runJson(tools, 'router_v30_catalog_list', { realtimeVoice: true });
  assert.equal(rt.count, 1);
  assert.equal(rt.entries[0].modelId, 'gpt-realtime-2.1');
  const one = await runJson(tools, 'router_v30_catalog_get', {
    provider: 'openai',
    modelId: 'gpt-5.2-mini',
    inputTokens: 1000000,
    outputTokens: 1000000,
  });
  assert.equal(one.entry.modelId, 'gpt-5.2-mini');
  assert.equal(one.estimatedCostUsd, 2.5);
  const missing = await run(tools, 'router_v30_catalog_get', { provider: 'openai', modelId: 'khong-co' });
  assert.ok(missing.startsWith('Error:'));
  const refreshed = await runJson(tools, 'router_v30_catalog_refresh', {
    entries: [
      {
        provider: 'openai',
        modelId: 'gpt-5.3',
        family: 'openai',
        kind: 'text',
        contextTokens: 400000,
        maxOutputTokens: 128000,
        inputPricePerMillionUsd: 6,
        outputPricePerMillionUsd: 18,
        qualityScore: 0.98,
        estimatedLatencyMs: 2500,
        capabilities: { toolCalling: true, vision: true, streaming: true, longContext: true, realtimeVoice: false, reasoning: true, jsonMode: true },
        tags: ['flagship'],
      },
      { provider: 'bad', modelId: 'broken', contextTokens: -5 },
    ],
  });
  assert.equal(refreshed.toVersion, 31);
  assert.deepEqual(refreshed.added, ['openai::gpt-5.3']);
  assert.equal(refreshed.rejected.length, 1);
  const after = await runJson(tools, 'router_v30_catalog_list', {});
  assert.equal(after.count, 19);
  const stale = await runJson(tools, 'router_v30_catalog_stale', { maxAgeMs: 0 });
  assert.equal(stale.staleCount, 19);
  assert.equal(stale.autoRefresh.should, false);
  assert.equal(stale.autoRefresh.reason, 'auto-refresh disabled');
});

test('tools: route + latency record/stats', async () => {
  const tools = createRouterV30Tools();
  const cheap = await runJson(tools, 'router_v30_route', {});
  assert.equal(cheap.ok, true);
  assert.equal(cheap.chosen.estimatedCostUsd, 0);
  assert.match(cheap.explanation, /Chosen/);
  const rt = await runJson(tools, 'router_v30_route', { needsRealtimeVoice: true });
  assert.equal(rt.chosen.modelId, 'gpt-realtime-2.1');
  assert.equal(rt.chosen.latencyMeasured, false);
  const none = await runJson(tools, 'router_v30_route', { minContextTokens: 99999999 });
  assert.equal(none.ok, false);
  assert.match(none.explanation, /No model fits/);
  // Ghi mau do that cho nano (cham) + mini (nhanh) -> fastest doi sang mini.
  for (let i = 0; i < 5; i += 1) {
    await runJson(tools, 'router_v30_latency_record', { provider: 'openai', modelId: 'gpt-5.2-nano', latencyMs: 5000, success: true });
    await runJson(tools, 'router_v30_latency_record', { provider: 'openai', modelId: 'gpt-5.2-mini', latencyMs: 300, success: true });
  }
  const stats = await runJson(tools, 'router_v30_latency_stats', { provider: 'openai', modelId: 'gpt-5.2-mini' });
  assert.equal(stats.stats.samples, 5);
  assert.equal(stats.stats.ewmaMs, 300);
  assert.equal(stats.modelCount, 2);
  const allStats = await runJson(tools, 'router_v30_latency_stats', {});
  assert.equal(allStats.all.length, 2);
});

test('tools: fallback plan/run (mock executor)', async () => {
  const tools = createRouterV30Tools();
  const plan = await runJson(tools, 'router_v30_fallback_plan', {
    name: 'p1',
    steps: [
      { provider: 'openai', modelId: 'gpt-5.2-mini', maxAttempts: 1 },
      { provider: 'ollama', modelId: 'llama-4-scout', maxAttempts: 1 },
    ],
  });
  assert.equal(plan.totalAttempts, 2);
  assert.equal(plan.stepCount, 2);
  const badPlan = await run(tools, 'router_v30_fallback_plan', {
    name: 'p1',
    steps: [{ provider: 'a', modelId: 'm', maxAttempts: 9 }],
  });
  assert.ok(badPlan.startsWith('Error:'));
  // 429 o buoc 1 -> fallback buoc 2.
  const ran = await runJson(tools, 'router_v30_fallback_run', {
    name: 'p1',
    steps: [
      { provider: 'openai', modelId: 'gpt-5.2-mini' },
      { provider: 'ollama', modelId: 'llama-4-scout' },
    ],
    failModels: ['openai::gpt-5.2-mini'],
    failStatus: 429,
    failMessage: 'rate limited',
  });
  assert.equal(ran.ok, true);
  assert.equal(ran.value, 'mock-ok:ollama::llama-4-scout');
  assert.equal(ran.attemptsMade, 2);
  assert.equal(ran.logLength, 2);
  // 401 dung ngay.
  const fatal = await runJson(tools, 'router_v30_fallback_run', {
    name: 'p1',
    steps: [
      { provider: 'openai', modelId: 'gpt-5.2-mini' },
      { provider: 'ollama', modelId: 'llama-4-scout' },
    ],
    failModels: ['openai::gpt-5.2-mini'],
    failStatus: 401,
    failMessage: 'invalid api key',
  });
  assert.equal(fatal.ok, false);
  assert.equal(fatal.attemptsMade, 1);
  assert.equal(fatal.lastError.kind, 'auth');
});

test('tools: health probe/summary (mock prober)', async () => {
  const state = createDefaultRouterV30State();
  state.prober = async (provider) => ({
    ok: provider !== 'xai',
    latencyMs: provider === 'xai' ? 0 : 150,
    detail: provider === 'xai' ? 'down' : 'ok',
  });
  const tools = createRouterV30Tools(state);
  const p1 = await runJson(tools, 'router_v30_health_probe', { provider: 'openai' });
  assert.equal(p1.cached, false);
  assert.equal(p1.status.status, 'healthy');
  // Trong TTL -> tra cache, khong probe lai.
  const p2 = await runJson(tools, 'router_v30_health_probe', { provider: 'openai' });
  assert.equal(p2.cached, true);
  assert.equal(p2.status.status, 'healthy');
  const forced = await runJson(tools, 'router_v30_health_probe', { provider: 'openai', force: true });
  assert.equal(forced.cached, false);
  // xai that 1 lan -> degraded (chua down).
  const bad = await runJson(tools, 'router_v30_health_probe', { provider: 'xai' });
  assert.equal(bad.status.status, 'degraded');
  const summary = await runJson(tools, 'router_v30_health_summary', {});
  assert.equal(summary.summary.total, 2);
  assert.equal(summary.summary.healthy, 1);
  assert.equal(summary.summary.degraded, 1);
  assert.deepEqual(summary.downProviders, []);
});

test('tools: CLI detect/list/consent/enable/label (mock runner)', async () => {
  const state = createDefaultRouterV30State();
  state.cliRunner = async (definition) => {
    if (definition.kind === 'codex') return { binary: 'codex', version: 'codex-cli 0.42.0' };
    if (definition.kind === 'gemini-cli') return { binary: 'gemini', version: 'gemini 0.9.1' };
    return null;
  };
  const tools = createRouterV30Tools(state);
  const before = await runJson(tools, 'router_v30_cli_list', {});
  assert.equal(before.consented, false);
  assert.equal(before.enabledSources.length, 0);
  const detected = await runJson(tools, 'router_v30_cli_detect', {});
  assert.equal(detected.detections.filter((d) => d.detected).length, 2);
  // Chua dong y -> van rong.
  const listed = await runJson(tools, 'router_v30_cli_list', {});
  assert.equal(listed.enabledSources.length, 0);
  assert.ok(listed.summary.lines.some((l) => l.includes('waiting for consent')));
  // Dong y + dat label.
  const granted = await runJson(tools, 'router_v30_cli_consent', {
    consented: true,
    kind: 'codex',
    accountLabel: 'huy@work',
  });
  assert.equal(granted.consented, true);
  assert.equal(granted.enabledSources.length, 2);
  assert.equal(granted.enabledSources[0].accountLabel, 'huy@work');
  assert.equal(granted.enabledSources[0].via, 'cli-session');
  // Tat gemini-cli.
  const disabled = await runJson(tools, 'router_v30_cli_enable', { kind: 'gemini-cli', enabled: false });
  assert.equal(disabled.enabledSources.length, 1);
  assert.equal(disabled.enabledSources[0].kind, 'codex');
  // Doi model override qua label tool.
  const labeled = await runJson(tools, 'router_v30_cli_label', {
    kind: 'gemini-cli',
    modelOverride: 'gemini-3-flash',
  });
  assert.equal(labeled.modelOverride, 'gemini-3-flash');
  const reenabled = await runJson(tools, 'router_v30_cli_enable', { kind: 'gemini-cli', enabled: true });
  assert.equal(reenabled.enabledSources.find((s) => s.kind === 'gemini-cli').modelId, 'gemini-3-flash');
  // Kind sai thi loi.
  const badKind = await run(tools, 'router_v30_cli_enable', { kind: 'nope', enabled: true });
  assert.ok(badKind.startsWith('Error:'));
});

test('tools: CLI invoke + route history (mock runners)', async () => {
  const state = createDefaultRouterV30State();
  state.cliRunner = async (definition) => {
    if (definition.kind === 'codex') return { binary: 'codex', version: 'codex-cli 0.42.0' };
    return null;
  };
  const tools = createRouterV30Tools(state);
  // Chua detect + chua dong y -> invoke loi, khong spawn.
  const denied = await runJson(tools, 'router_v30_cli_invoke', { kind: 'codex', prompt: 'hi' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /consent/);
  await runJson(tools, 'router_v30_cli_detect', {});
  await runJson(tools, 'router_v30_cli_consent', { consented: true });
  const invoked = await runJson(tools, 'router_v30_cli_invoke', { kind: 'codex', prompt: 'say hi' });
  assert.equal(invoked.ok, true);
  assert.equal(invoked.exitCode, 0);
  assert.match(invoked.output, /mock-invoke:codex/);
  assert.equal(invoked.kind, 'codex');
  // Route ghi vao history.
  const h0 = await runJson(tools, 'router_v30_route_history', {});
  assert.equal(h0.length, 0);
  assert.equal(h0.summary.total, 0);
  await runJson(tools, 'router_v30_route', {});
  await runJson(tools, 'router_v30_route', { needsRealtimeVoice: true });
  await runJson(tools, 'router_v30_route', { minContextTokens: 99999999 });
  const h = await runJson(tools, 'router_v30_route_history', { count: 2 });
  assert.equal(h.length, 3);
  assert.equal(h.summary.total, 3);
  assert.equal(h.summary.succeeded, 2);
  assert.equal(h.summary.failed, 1);
  assert.equal(h.recent.length, 2);
  assert.equal(h.recent[0].ok, false);
  assert.ok(h.summary.mostChosen);
});

test('tools: budget set/report + route tranh provider het ngan sach', async () => {
  const tools = createRouterV30Tools();
  const empty = await runJson(tools, 'router_v30_budget_report', {});
  assert.deepEqual(empty.budgets, []);
  assert.deepEqual(empty.overBudgetProviders, []);
  const set = await runJson(tools, 'router_v30_budget_set', {
    provider: 'openai',
    dailyCapUsd: 1,
    recordSpendUsd: 2,
  });
  assert.equal(set.budget.provider, 'openai');
  assert.equal(set.budget.dailyCapUsd, 1);
  assert.equal(set.budget.spentTodayUsd, 2);
  const report = await runJson(tools, 'router_v30_budget_report', {});
  assert.equal(report.budgets.length, 1);
  assert.equal(report.budgets[0].remainingUsd, -1);
  assert.equal(report.budgets[0].overBudget, true);
  assert.deepEqual(report.overBudgetProviders, ['openai']);
  // Can het moi provider tru ollama -> route phai chon ollama.
  for (const provider of ['openai', 'gemini', 'anthropic', 'xai', 'deepseek', 'openrouter', 'local']) {
    await runJson(tools, 'router_v30_budget_set', { provider, dailyCapUsd: 1, recordSpendUsd: 2 });
  }
  const routed = await runJson(tools, 'router_v30_route', {});
  assert.equal(routed.ok, true);
  assert.equal(routed.chosen.provider, 'ollama');
  const bad = await run(tools, 'router_v30_budget_set', { provider: 'x', dailyCapUsd: -1 });
  assert.ok(bad.startsWith('Error:'));
});

test('tools: policy get/set', async () => {
  const tools = createRouterV30Tools();
  const before = await runJson(tools, 'router_v30_policy_get', {});
  assert.equal(before.policy.profile, 'balanced');
  assert.deepEqual(before.errors, []);
  const set = await runJson(tools, 'router_v30_policy_set', {
    profile: 'cheapest',
    maxCostPerRequestUsd: 0.05,
    preferLocal: true,
    autoRefreshEnabled: true,
  });
  assert.equal(set.policy.profile, 'cheapest');
  assert.equal(set.policy.maxCostPerRequestUsd, 0.05);
  assert.equal(set.policy.preferLocal, true);
  assert.equal(set.policy.autoRefreshCatalog.enabled, true);
  const bad = await run(tools, 'router_v30_policy_set', { maxFallbackAttempts: 99 });
  assert.ok(bad.startsWith('Error:'));
  const kept = await runJson(tools, 'router_v30_policy_get', {});
  assert.equal(kept.policy.profile, 'cheapest');
  const badProfile = await run(tools, 'router_v30_policy_set', { profile: 'turbo' });
  assert.ok(badProfile.startsWith('Error:'));
});

test('i18n: 36 key routerV30.* du 6 locale, tong key >= 9245 + 36', () => {
  const locales = ['en', 'vi', 'zh', 'ja', 'fr', 'es'];
  const counts = [];
  for (const locale of locales) {
    const data = JSON.parse(
      readFileSync(
        new URL(`../apps/desktop/src/renderer/i18n/locales/${locale}.json`, import.meta.url),
        'utf8',
      ),
    );
    counts.push(Object.keys(data).length);
    for (const key of ROUTER_V30_KEYS) {
      assert.ok(key in data, `${locale} missing ${key}`);
      assert.equal(typeof data[key], 'string', `${locale}:${key} must be a string`);
      assert.ok(data[key].length > 0, `${locale}:${key} must not be empty`);
    }
  }
  assert.ok(counts.every((c) => c === counts[0]), `locale key counts differ: ${counts.join(',')}`);
  assert.ok(counts[0] >= 9245 + 36, `total keys ${counts[0]} < ${9245 + 36}`);
});
