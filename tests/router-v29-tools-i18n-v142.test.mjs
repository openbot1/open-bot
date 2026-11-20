/**
 * Router v29 — tools + i18n (v1.42, Doi T5, node:test).
 *
 * Covers (thuan, khong model that, khong network — executor/prober mock):
 * - 12 ten duy nhat, needsApproval=false; co mat trong ALL_TOOLS;
 *   createDefaultTools({getRouterV29State}) bind khong trung lap.
 * - Catalog list/get/refresh qua tool (refresh them model moi, tu
 *   choi muc sai).
 * - Route qua tool (voice realtime -> model realtime; cheapest ->
 *   local $0) + architecture recommend qua tool.
 * - Cost record/report/budget qua tool (ghi + tong hop + vuot
 *   ngan sach).
 * - Fallback plan/run qua tool (mock executor: loi 429 -> fallback
 *   model sau; loi 401 -> dung).
 * - Health probe/summary qua tool (mock probe; failProviders).
 * - i18n: 24 key routerV29.* co mat du 6 locale, so key 6 locale
 *   bang nhau; tong so key >= base 8935 + 24 (floor, khong pin
 *   exact — doi khac cung them key).
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/router-v29-tools-i18n-v142.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ROUTER_V29_TOOL_NAMES,
  createDefaultRouterV29State,
  createRouterV29Tools,
  isRouterV29ToolName,
} from '../packages/tools/dist/routerV29Tools.js';
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

const ROUTER_V29_KEYS = [
  'routerV29.title',
  'routerV29.subtitle',
  'routerV29.catalogTitle',
  'routerV29.routeTitle',
  'routerV29.costTitle',
  'routerV29.healthTitle',
  'routerV29.fallbackTitle',
  'routerV29.chooseModel',
  'routerV29.cheapest',
  'routerV29.fastest',
  'routerV29.balanced',
  'routerV29.bestQuality',
  'routerV29.estimatedCost',
  'routerV29.estimatedLatency',
  'routerV29.realtimeVoice',
  'routerV29.fullDuplex',
  'routerV29.noModelFits',
  'routerV29.fallbackUsed',
  'routerV29.providerHealthy',
  'routerV29.providerDegraded',
  'routerV29.providerUnhealthy',
  'routerV29.dailyBudget',
  'routerV29.budgetExceeded',
  'routerV29.totalCost',
];

test('tools: 15 ten duy nhat, needsApproval=false, co trong ALL_TOOLS', () => {
  assert.equal(ROUTER_V29_TOOL_NAMES.length, 15);
  assert.equal(new Set(ROUTER_V29_TOOL_NAMES).size, 15);
  assert.ok(ROUTER_V29_TOOL_NAMES.every((n) => n.startsWith('router_v29_')));
  const tools = createRouterV29Tools();
  assert.equal(tools.length, 15);
  assert.ok(tools.every((t) => t.needsApproval === false));
  assert.ok(tools.every((t) => isRouterV29ToolName(t.definition.name)));
  assert.equal(isRouterV29ToolName('router_v29_route'), true);
  assert.equal(isRouterV29ToolName('router_local_v118_cost_route'), false);
  const allNames = new Set(ALL_TOOLS.map((t) => t.definition.name));
  assert.ok(ROUTER_V29_TOOL_NAMES.every((n) => allNames.has(n)));
  assert.equal(ALL_TOOLS.length, allNames.size, 'ALL_TOOLS khong duoc co ten trung');
});

test('tools: createDefaultTools bind khong trung lap', () => {
  const state = createDefaultRouterV29State();
  const bound = createDefaultTools({ getRouterV29State: () => state });
  const names = bound.map((t) => t.definition.name);
  assert.equal(names.length, new Set(names).size);
  assert.ok(ROUTER_V29_TOOL_NAMES.every((n) => names.includes(n)));
  // Bind 2 lan van khong trung.
  const bound2 = createDefaultTools({ getRouterV29State: () => state });
  assert.equal(bound2.map((t) => t.definition.name).length, new Set(bound2.map((t) => t.definition.name)).size);
});

test('tools: catalog list/get/refresh', async () => {
  const tools = createRouterV29Tools();
  const all = await runJson(tools, 'router_v29_catalog_list', {});
  assert.equal(all.count, 12);
  assert.equal(all.summary.totalModels, 12);
  const live = await runJson(tools, 'router_v29_catalog_list', { realtimeOnly: true });
  assert.equal(live.count, 6);
  const gemini = await runJson(tools, 'router_v29_catalog_list', { provider: 'gemini' });
  assert.ok(gemini.count >= 4);
  const one = await runJson(tools, 'router_v29_catalog_get', { modelId: 'gpt-live' });
  assert.equal(one.entry.modelId, 'gpt-live');
  assert.equal(one.entry.perMinuteUsd, 0.05);
  assert.ok(one.sampleEstimate.totalUsd > 0);
  const missing = await run(tools, 'router_v29_catalog_get', { modelId: 'khong-co' });
  assert.ok(missing.startsWith('Error:'));
  const refreshed = await runJson(tools, 'router_v29_catalog_refresh', {
    updates: [
      {
        modelId: 'gpt-live-2', provider: 'openai', family: 'gpt-live', displayName: 'GPT-Live 2',
        kind: 'live', architecture: 'full-duplex', contextTokens: 131072, maxOutputTokens: 32768,
        inputPricePer1kUsd: 0.04, outputPricePer1kUsd: 0.16, perMinuteUsd: 0.05, quality: 0.94,
        typicalLatencyMs: 270,
        capabilities: { realtimeVoice: true, fullDuplex: true, bargeIn: true, asyncFunctionCalling: true, proactiveAudio: true, toolCalling: true, vision: true, streaming: true, longContext: true, serverDrivenResponse: true, contextAppendOnly: true },
      },
      { modelId: 'sai', provider: 'x' },
    ],
  });
  assert.deepEqual(refreshed.added, ['gpt-live-2']);
  assert.equal(refreshed.rejected.length, 1);
  const after = await runJson(tools, 'router_v29_catalog_list', {});
  assert.equal(after.count, 13);
});

test('tools: route + architecture recommend', async () => {
  const tools = createRouterV29Tools();
  const voice = await runJson(tools, 'router_v29_route', { needsRealtimeVoice: true, needsBargeIn: true });
  assert.equal(voice.ok, true);
  assert.ok(voice.chosenModelId);
  assert.equal(voice.architecture, 'full-duplex');
  assert.ok(voice.explanation[0].startsWith('Chon '));
  const cheap = await runJson(tools, 'router_v29_route', { profile: 'cheapest' });
  assert.equal(cheap.chosenModelId, 'qwen3-4b');
  const impossible = await runJson(tools, 'router_v29_route', { minQuality: 0.99, needsVision: true });
  assert.equal(impossible.ok, false);
  const badProfile = await run(tools, 'router_v29_route', { profile: 'sieunhanh' });
  assert.ok(badProfile.startsWith('Error:'));
  const arch = await runJson(tools, 'router_v29_architecture_recommend', { targetLatencyMs: 300, needsBargeIn: true });
  assert.equal(arch.architecture, 'full-duplex');
  assert.ok(arch.suggestedModels.length > 0);
  const cascaded = await runJson(tools, 'router_v29_architecture_recommend', { textOnlyAvailable: true });
  assert.equal(cascaded.architecture, 'cascaded');
});

test('tools: cost record/report/budget', async () => {
  const tools = createRouterV29Tools();
  const rec = await runJson(tools, 'router_v29_cost_record', {
    modelId: 'gpt-live', sessionId: 's1', inputTokens: 1000, outputTokens: 500, minutes: 10,
  });
  assert.ok(Math.abs(rec.record.costUsd - 0.62) < 1e-9);
  assert.ok(Math.abs(rec.dayTotalUsd - 0.62) < 1e-9);
  // Model la: gia tu catalog (khong can truyen gia).
  await runJson(tools, 'router_v29_cost_record', {
    modelId: 'qwen3-4b', sessionId: 's1', inputTokens: 5000, outputTokens: 1000,
  });
  const report = await runJson(tools, 'router_v29_cost_report', {});
  assert.ok(Math.abs(report.summary.totalUsd - 0.62) < 1e-9);
  assert.equal(report.summary.topModelId, 'gpt-live');
  assert.equal(report.budget.overDaily, false);
  const bad = await run(tools, 'router_v29_cost_record', { modelId: 'model-la', sessionId: 's1' });
  assert.ok(bad.startsWith('Error:'));
  // Dat ngan sach ngay 0.5 -> vuot (da dung 0.62).
  await runJson(tools, 'router_v29_cost_budget_set', { dailyBudgetUsd: 0.5 });
  const over = await runJson(tools, 'router_v29_cost_report', {});
  assert.equal(over.budget.overDaily, true);
  assert.equal(over.budget.dailyNearLimit, true);
  await runJson(tools, 'router_v29_cost_budget_set', { sessionId: 's1', sessionBudgetUsd: 0.1 });
  const overSession = await runJson(tools, 'router_v29_cost_report', { sessionId: 's1' });
  assert.equal(overSession.budget.sessionsOverBudget.length, 1);
  assert.ok(Math.abs(overSession.sessionTotalUsd - 0.62) < 1e-9);
  // Xoa ngan sach ngay.
  const cleared = await runJson(tools, 'router_v29_cost_budget_set', { dailyBudgetUsd: -1 });
  assert.equal(cleared.dailyBudgetUsd, null);
  const half = await run(tools, 'router_v29_cost_budget_set', { sessionId: 's1' });
  assert.ok(half.startsWith('Error:'));
});

test('tools: fallback plan/run (mock executor)', async () => {
  const tools = createRouterV29Tools();
  const plan = await runJson(tools, 'router_v29_fallback_plan', {
    failedModelId: 'gpt-realtime-2.1', status: 429, message: 'rate limit',
  });
  assert.equal(plan.errorKind, 'rate-limit');
  assert.equal(plan.retryable, true);
  assert.ok(plan.nextSteps.length > 0);
  const authPlan = await runJson(tools, 'router_v29_fallback_plan', {
    failedModelId: 'gpt-realtime-2.1', status: 401, message: 'invalid api key',
  });
  assert.equal(authPlan.retryable, false);
  assert.deepEqual(authPlan.nextSteps, []);
  // Run: model dau loi 429 -> fallback model sau ok.
  const runOk = await runJson(tools, 'router_v29_fallback_run', {
    chainId: 't-voice',
    steps: [
      { modelId: 'gpt-realtime-2.1', provider: 'openai' },
      { modelId: 'gemini-3.8-live', provider: 'gemini' },
    ],
    failModels: [{ modelId: 'gpt-realtime-2.1', status: 429, message: 'rate limit' }],
  });
  assert.equal(runOk.ok, true);
  assert.equal(runOk.modelId, 'gemini-3.8-live');
  assert.equal(runOk.fallbackCount, 1);
  assert.equal(runOk.attempts[0].errorKind, 'rate-limit');
  // Run: tat ca loi -> all-failed.
  const runFail = await runJson(tools, 'router_v29_fallback_run', {
    chainId: 't-voice-2',
    steps: [
      { modelId: 'gpt-realtime-2.1', provider: 'openai' },
      { modelId: 'gemini-3.8-live', provider: 'gemini' },
    ],
    failModels: [
      { modelId: 'gpt-realtime-2.1', status: 500 },
      { modelId: 'gemini-3.8-live', status: 500 },
    ],
  });
  assert.equal(runFail.ok, false);
  assert.ok(runFail.gaveUpReason.startsWith('all-failed'));
  // Run: loi auth dung ngay.
  const runAuth = await runJson(tools, 'router_v29_fallback_run', {
    chainId: 't-voice-3',
    steps: [
      { modelId: 'gpt-realtime-2.1', provider: 'openai' },
      { modelId: 'gemini-3.8-live', provider: 'gemini' },
    ],
    failModels: [{ modelId: 'gpt-realtime-2.1', status: 401, message: 'invalid api key' }],
  });
  assert.equal(runAuth.ok, false);
  assert.equal(runAuth.attempts.length, 1);
  // Plan theo chain da dang ky.
  const planReg = await runJson(tools, 'router_v29_fallback_plan', {
    chainId: 't-voice', failedModelId: 'gpt-realtime-2.1', status: 500, message: 'boom',
  });
  assert.equal(planReg.nextSteps[0].modelId, 'gemini-3.8-live');
  const missingChain = await run(tools, 'router_v29_fallback_plan', {
    chainId: 'khong-co', failedModelId: 'gpt-realtime-2.1', status: 500,
  });
  assert.ok(missingChain.startsWith('Error:'));
});

test('tools: health probe/summary (mock probe)', async () => {
  const tools = createRouterV29Tools();
  const probed = await runJson(tools, 'router_v29_health_probe', { providers: ['openai', 'gemini'] });
  assert.equal(probed.results.length, 2);
  assert.ok(probed.results.every((r) => r.status === 'healthy'));
  assert.equal(probed.summary.totalProviders, 2);
  assert.equal(probed.summary.healthy, 2);
  const summary = await runJson(tools, 'router_v29_health_summary', {});
  assert.equal(summary.healthiest.length, 2);
  assert.equal(summary.staleProviders.length, 0);
  // failProviders: 3 lan probe xai loi -> unhealthy.
  const state = createDefaultRouterV29State();
  const tools2 = createRouterV29Tools(state);
  await runJson(tools2, 'router_v29_health_probe', { providers: ['xai'], failProviders: ['xai'] });
  await runJson(tools2, 'router_v29_health_probe', { providers: ['xai'], failProviders: ['xai'] });
  const third = await runJson(tools2, 'router_v29_health_probe', { providers: ['xai'], failProviders: ['xai'] });
  assert.equal(third.results[0].status, 'unhealthy');
  const summary2 = await runJson(tools2, 'router_v29_health_summary', {});
  assert.equal(summary2.summary.unhealthy, 1);
  assert.equal(summary2.summary.worstStatus, 'unhealthy');
});

test('tools: provider config / cost forecast / policy', async () => {
  const tools = createRouterV29Tools();
  const listed = await runJson(tools, 'router_v29_provider_config', { action: 'list' });
  assert.equal(listed.providers.length, 5);
  assert.equal(listed.routingOrder[0].provider, 'openai');
  const one = await runJson(tools, 'router_v29_provider_config', { action: 'get', provider: 'ollama' });
  assert.equal(one.config.local, true);
  assert.equal(one.defaults.timeoutMs, 120000);
  const disabled = await runJson(tools, 'router_v29_provider_config', { action: 'disable', provider: 'xai' });
  assert.equal(disabled.config.enabled, false);
  await runJson(tools, 'router_v29_provider_config', { action: 'enable', provider: 'xai' });
  const added = await runJson(tools, 'router_v29_provider_config', {
    action: 'set',
    provider: 'deepseek',
    config: { provider: 'deepseek', enabled: true, priority: 6, authKind: 'api-key', timeoutMs: 45000, maxRetries: 3, local: false },
  });
  assert.equal(added.providers.length, 6);
  const badAction = await run(tools, 'router_v29_provider_config', { action: 'xoa' });
  assert.ok(badAction.startsWith('Error:'));
  const badConfig = await run(tools, 'router_v29_provider_config', {
    action: 'set', provider: 'x',
    config: { provider: 'x', enabled: true, priority: -1, authKind: 'api-key', timeoutMs: 1000, maxRetries: 1, local: false },
  });
  assert.ok(badConfig.startsWith('Error:'));
  // Forecast: ghi 1 ngay roi du bao (endDay co dinh de on dinh).
  await runJson(tools, 'router_v29_cost_record', {
    modelId: 'gpt-live', sessionId: 's1', inputTokens: 1000, outputTokens: 500, minutes: 10,
  });
  // endDay = hôm nay (cost record ghi ngày hiện tại; endDay cố định
  // '2026-11-19' là time-bomb — sang 20/11 record rơi ngoài window).
  const today = new Date().toISOString().slice(0, 10);
  const forecast = await runJson(tools, 'router_v29_cost_forecast', {
    windowDays: 30, endDay: today, dailyBudgetUsd: 1, monthlyBudgetUsd: 30, modelId: 'gpt-live',
  });
  assert.equal(forecast.forecast.daysWithData, 1);
  assert.ok(Math.abs(forecast.forecast.windowTotalUsd - 0.62) < 1e-9);
  assert.equal(forecast.forecast.projected30DayUsd, 0.62 * 30);
  assert.equal(forecast.burn.willExceedDaily, false);
  assert.equal(forecast.cheaperAlternative.alternativeModelId, 'gemini-3-flash-live');
  assert.equal(forecast.trends[0].modelId, 'gpt-live');
  // Policy: mac dinh mo, set siet lai, preview ap dung.
  const def = await runJson(tools, 'router_v29_policy', { action: 'get', botId: 'b1' });
  assert.equal(def.hasCustomPolicy, false);
  assert.equal(def.policy.defaultProfile, 'balanced');
  await runJson(tools, 'router_v29_policy', {
    action: 'set', botId: 'b1',
    policy: { botId: 'b1', defaultProfile: 'cheapest', maxCostPerTurnUsd: 0.1, voiceAllowed: false, deniedProviders: ['xai'] },
  });
  const preview = await runJson(tools, 'router_v29_policy', {
    action: 'get', botId: 'b1',
    previewRequest: { needsRealtimeVoice: true, maxCostUsd: 0.5 },
  });
  assert.equal(preview.preview.request.needsRealtimeVoice, false);
  assert.equal(preview.preview.request.maxCostUsd, 0.1);
  assert.equal(preview.preview.request.profile, 'cheapest');
  assert.ok(preview.preview.applied.length >= 3);
  const badPolicy = await run(tools, 'router_v29_policy', {
    action: 'set', botId: 'b1',
    policy: { botId: 'b1', allowedProviders: ['xai'], deniedProviders: ['xai'] },
  });
  assert.ok(badPolicy.startsWith('Error:'));
  const badActionPolicy = await run(tools, 'router_v29_policy', { action: 'xoa', botId: 'b1' });
  assert.ok(badActionPolicy.startsWith('Error:'));
});

test('i18n: 24 key routerV29.* du 6 locale, tong key >= base + 24', () => {
  const counts = {};
  for (const loc of ['en', 'es', 'fr', 'ja', 'vi', 'zh']) {
    const data = JSON.parse(readFileSync(new URL(`../apps/desktop/src/renderer/i18n/locales/${loc}.json`, import.meta.url), 'utf-8'));
    counts[loc] = Object.keys(data).length;
    for (const key of ROUTER_V29_KEYS) {
      assert.ok(typeof data[key] === 'string' && data[key].length > 0, `${loc} thieu key ${key}`);
    }
    // Placeholder {model} giu nguyen o moi locale.
    assert.ok(data['routerV29.fallbackUsed'].includes('{model}'), `${loc} fallbackUsed mat {model}`);
  }
  const values = Object.values(counts);
  assert.ok(values.every((v) => v === values[0]), `so key 6 locale khong bang nhau: ${JSON.stringify(counts)}`);
  assert.ok(values[0] >= 8935 + ROUTER_V29_KEYS.length, `tong key ${values[0]} < 8935 + ${ROUTER_V29_KEYS.length}`);
});
