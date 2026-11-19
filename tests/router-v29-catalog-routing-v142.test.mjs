/**
 * Router v29 — catalog + routing decision matrix (v1.42, Doi T5, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - Catalog mac dinh: 12 muc; gpt-realtime-2.1 128k ctx / 32k out;
 *   GPT-Live $0.05/phut; Gemini 3.8 Live 131k input + async function
 *   calling + proactive audio; Gemini 3.x live family du 3 muc.
 * - Validate entry: gia am / quality ngoai 0..1 / realtime thieu
 *   realtimeVoice / fullDuplex sai architecture -> loi.
 * - Refresh catalog: add / update / unchanged / rejected / removeMissing.
 * - Routing decision matrix: voice realtime -> chi model realtime/live;
 *   full-duplex + barge-in -> full-duplex; cheapest -> local $0;
 *   context dai -> model 128k+; maxCost loai model dat; khong model
 *   nao dat -> ok:false + rejected day du.
 * - Architecture recommend: <=350ms/barge-in -> full-duplex;
 *   <=800ms -> turn-based; text-only -> cascaded 500-800ms.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v29-catalog-routing-v142.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultModelCatalogV29,
  estimateModelCostV29,
  filterCatalogV29,
  findModelV29,
  refreshModelCatalogV29,
  summarizeCatalogV29,
  validateModelCatalogEntryV29,
} from '../packages/core/dist/routerV29/modelCatalogV29.js';
import {
  CASCADED_LATENCY_MS_MAX_V29,
  CASCADED_LATENCY_MS_MIN_V29,
  SPEECH_TO_SPEECH_LATENCY_MS_V29,
  explainRoutingDecisionV29,
  recommendVoiceArchitectureV29,
  routeModelV29,
} from '../packages/core/dist/routerV29/latencyCostRouterV29.js';

const catalog = () => defaultModelCatalogV29();

test('catalog mac dinh: 12 muc, du model realtime 2026', () => {
  const c = catalog();
  assert.equal(c.length, 12);
  const realtime = c.find((m) => m.modelId === 'gpt-realtime-2.1');
  assert.ok(realtime);
  assert.equal(realtime.contextTokens, 131072);
  assert.equal(realtime.maxOutputTokens, 32768);
  assert.equal(realtime.capabilities.realtimeVoice, true);
  const mini = c.find((m) => m.modelId === 'gpt-realtime-2.1-mini');
  assert.ok(mini);
  assert.equal(mini.architecture, 'turn-based-realtime');
  const live = c.find((m) => m.modelId === 'gpt-live');
  assert.ok(live);
  assert.equal(live.perMinuteUsd, 0.05);
  assert.equal(live.capabilities.fullDuplex, true);
  assert.equal(live.capabilities.contextAppendOnly, true);
  const geminiLive = c.find((m) => m.modelId === 'gemini-3.8-live');
  assert.ok(geminiLive);
  assert.equal(geminiLive.contextTokens, 131072);
  assert.equal(geminiLive.capabilities.asyncFunctionCalling, true);
  assert.equal(geminiLive.capabilities.proactiveAudio, true);
  // Gemini 3.x live family: 3 muc.
  const family = c.filter((m) => m.family === 'gemini-live');
  assert.equal(family.length, 3);
  const summary = summarizeCatalogV29(c);
  assert.equal(summary.totalModels, 12);
  assert.equal(summary.realtimeModels.length, 6);
  assert.equal(summary.cheapestInputModelId, 'qwen3-4b');
  assert.equal(summary.fastestModelId, 'gemini-3-flash-live');
});

test('catalog: uoc tinh chi phi token + phut (GPT-Live)', () => {
  const live = findModelV29(catalog(), 'gpt-live');
  assert.ok(live);
  const est = estimateModelCostV29(live, { inputTokens: 1000, outputTokens: 500, minutes: 10 });
  assert.equal(est.basis, 'tokens+minutes');
  assert.ok(Math.abs(est.perMinuteUsd - 0.5) < 1e-9);
  assert.ok(est.totalUsd > 0.5);
  const local = findModelV29(catalog(), 'qwen3-4b');
  assert.ok(local);
  assert.equal(estimateModelCostV29(local, { inputTokens: 5000, outputTokens: 2000 }).totalUsd, 0);
});

test('catalog: validate bat loi', () => {
  const good = findModelV29(catalog(), 'gpt-realtime-2.1');
  assert.ok(good);
  assert.equal(validateModelCatalogEntryV29(good).ok, true);
  assert.equal(validateModelCatalogEntryV29({ ...good, inputPricePer1kUsd: -1 }).ok, false);
  assert.equal(validateModelCatalogEntryV29({ ...good, quality: 1.5 }).ok, false);
  assert.equal(validateModelCatalogEntryV29({ ...good, maxOutputTokens: 999999 }).ok, false);
  assert.equal(
    validateModelCatalogEntryV29({ ...good, capabilities: { ...good.capabilities, realtimeVoice: false } }).ok,
    false,
  );
  assert.equal(
    validateModelCatalogEntryV29({ ...good, capabilities: { ...good.capabilities, fullDuplex: true }, architecture: 'turn-based-realtime' }).ok,
    false,
  );
  assert.equal(validateModelCatalogEntryV29({ ...good, released: '06/07/2026' }).ok, false);
});

test('catalog: filter theo capability + context', () => {
  const c = catalog();
  const full = filterCatalogV29(c, { requireCapabilities: { fullDuplex: true } });
  assert.ok(full.length >= 2);
  assert.ok(full.every((m) => m.architecture === 'full-duplex'));
  const longCtx = filterCatalogV29(c, { minContextTokens: 1000000 });
  assert.ok(longCtx.length >= 2);
  assert.ok(longCtx.every((m) => m.contextTokens >= 1000000));
  const cheap = filterCatalogV29(c, { maxInputPricePer1kUsd: 0 });
  assert.deepEqual(cheap.map((m) => m.modelId), ['qwen3-4b']);
  const deprecated = { ...c[0], deprecated: true };
  assert.equal(filterCatalogV29([deprecated]).length, 0);
  assert.equal(filterCatalogV29([deprecated], { excludeDeprecated: false }).length, 1);
});

test('catalog: refresh add/update/unchanged/rejected/removeMissing', () => {
  const c = catalog();
  const updated = { ...findModelV29(c, 'gpt-realtime-2.1-mini'), quality: 0.86 };
  const added = {
    ...findModelV29(c, 'gemini-3-flash-live'),
    modelId: 'gemini-3-nano-live',
    displayName: 'Gemini 3 Nano Live',
    quality: 0.8,
  };
  const broken = { ...findModelV29(c, 'gpt-live'), modelId: 'broken-live', quality: 2 };
  const result = refreshModelCatalogV29(c, [updated, added, findModelV29(c, 'gpt-live'), broken]);
  assert.deepEqual(result.updated, ['gpt-realtime-2.1-mini']);
  assert.deepEqual(result.added, ['gemini-3-nano-live']);
  assert.deepEqual(result.unchanged, ['gpt-live']);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].modelId, 'broken-live');
  assert.equal(result.catalog.length, 13);
  assert.equal(result.removed.length, 0);
  // removeMissing: chi giu cac muc co trong updates.
  const pruned = refreshModelCatalogV29(c, [findModelV29(c, 'gpt-live')], { removeMissing: true });
  assert.equal(pruned.catalog.length, 1);
  assert.equal(pruned.removed.length, 11);
});

test('routing matrix: voice realtime chi chon model realtime/live', () => {
  const d = routeModelV29(catalog(), { needsRealtimeVoice: true, profile: 'balanced' });
  assert.equal(d.ok, true);
  assert.ok(d.chosenModelId);
  assert.ok(['realtime', 'live'].includes(findModelV29(catalog(), d.chosenModelId).kind));
  assert.ok(d.rejected.some((r) => r.modelId === 'gemini-2.5-flash'));
  assert.ok(d.reasons.some((r) => r.includes('voice realtime')));
});

test('routing matrix: full-duplex + barge-in -> model full-duplex', () => {
  const d = routeModelV29(catalog(), { needsRealtimeVoice: true, needsFullDuplex: true, needsBargeIn: true });
  assert.equal(d.ok, true);
  const chosen = findModelV29(catalog(), d.chosenModelId);
  assert.equal(chosen.capabilities.fullDuplex, true);
  assert.equal(chosen.capabilities.bargeIn, true);
  assert.equal(d.architecture, 'full-duplex');
});

test('routing matrix: cheapest -> local $0; quality -> model manh', () => {
  const cheap = routeModelV29(catalog(), { profile: 'cheapest' });
  assert.equal(cheap.chosenModelId, 'qwen3-4b');
  assert.equal(cheap.estimatedCostUsd, 0);
  const quality = routeModelV29(catalog(), { profile: 'quality', minQuality: 0.93 });
  assert.equal(quality.ok, true);
  assert.ok(quality.quality >= 0.93);
  assert.notEqual(quality.chosenModelId, 'qwen3-4b');
});

test('routing matrix: context dai + ngan sach loai model dat', () => {
  const longCtx = routeModelV29(catalog(), { minContextTokens: 1000000 });
  assert.equal(longCtx.ok, true);
  assert.ok(findModelV29(catalog(), longCtx.chosenModelId).contextTokens >= 1000000);
  // Ngan sach $0.0001/luot: chi local dat (gia 0).
  const broke = routeModelV29(catalog(), { maxCostUsd: 0.0001 });
  assert.equal(broke.ok, true);
  assert.equal(broke.chosenModelId, 'qwen3-4b');
  // Ngan sach $0 + yeu cau vision: local khong co vision -> fail co ly do.
  const impossible = routeModelV29(catalog(), { maxCostUsd: 0, needsVision: true, minQuality: 0.99 });
  assert.equal(impossible.ok, false);
  assert.equal(impossible.chosenModelId, null);
  assert.ok(impossible.rejected.length > 0);
  assert.ok(explainRoutingDecisionV29(impossible)[0].includes('Khong chon duoc model'));
  const lines = explainRoutingDecisionV29(routeModelV29(catalog(), { needsRealtimeVoice: true }));
  assert.ok(lines[0].startsWith('Chon '));
  assert.ok(lines.some((l) => l.includes('Uoc tinh:')));
});

test('routing matrix: fastest uu tien do tre; exclude loai model loi', () => {
  const fast = routeModelV29(catalog(), { profile: 'fastest' });
  assert.equal(fast.ok, true);
  assert.ok(fast.estimatedLatencyMs <= 350);
  const d = routeModelV29(catalog(), {
    needsRealtimeVoice: true,
    excludeModelIds: ['gpt-realtime-2.1', 'gpt-live', 'gemini-3.8-live', 'gemini-3-live', 'gemini-3-flash-live', 'gpt-realtime-2.1-mini'],
  });
  assert.equal(d.ok, false);
  const excludedReasons = d.rejected.filter((r) =>
    ['gpt-realtime-2.1', 'gpt-live', 'gemini-3.8-live'].includes(r.modelId),
  );
  assert.equal(excludedReasons.length, 3);
  assert.ok(excludedReasons.every((r) => r.reason.includes('loai tru')));
  // Text models bi loai vi khong co voice realtime.
  assert.ok(d.rejected.some((r) => r.modelId === 'gemini-2.5-flash' && r.reason.includes('voice realtime')));
});

test('architecture recommend: nguong do tre + barge-in + text-only', () => {
  assert.equal(SPEECH_TO_SPEECH_LATENCY_MS_V29, 300);
  assert.equal(CASCADED_LATENCY_MS_MIN_V29, 500);
  assert.equal(CASCADED_LATENCY_MS_MAX_V29, 800);
  const duplex = recommendVoiceArchitectureV29({ targetLatencyMs: 300, needsBargeIn: true }, catalog());
  assert.equal(duplex.architecture, 'full-duplex');
  assert.ok(duplex.suggestedModels.includes('gpt-live'));
  const turn = recommendVoiceArchitectureV29({ targetLatencyMs: 600 }, catalog());
  assert.equal(turn.architecture, 'turn-based-realtime');
  assert.ok(turn.expectedLatencyMs.max <= 800);
  const cascaded = recommendVoiceArchitectureV29({ targetLatencyMs: 2000 }, catalog());
  assert.equal(cascaded.architecture, 'cascaded');
  assert.deepEqual(cascaded.expectedLatencyMs, { min: 500, max: 800 });
  const textOnly = recommendVoiceArchitectureV29({ targetLatencyMs: 250, textOnlyAvailable: true }, catalog());
  assert.equal(textOnly.architecture, 'cascaded');
  assert.deepEqual(textOnly.suggestedModels, []);
  const proactive = recommendVoiceArchitectureV29({ targetLatencyMs: 300, needsProactiveAudio: true }, catalog());
  assert.equal(proactive.architecture, 'full-duplex');
  assert.ok(proactive.reasons.some((r) => r.includes('Proactive audio')));
});
