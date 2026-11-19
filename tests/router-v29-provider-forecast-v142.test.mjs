/**
 * Router v29 — provider config + cost forecast + routing policy
 * (v1.42, Doi T5, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - Provider config: mac dinh 5 provider; validate (priority am,
 *   authKind la, retry > 10, local sai authKind); upsert/patch/
 *   enable/disable; routingOrder; filterProvidersByConfig; toJSON/
 *   fromJSON (bo qua muc sai).
 * - Cost forecast: trung binh/ngay + du bao 7/30 ngay; burn (het
 *   ngan sach thang sau bao nhieu ngay, vuot ngan sach ngay); xu
 *   huong model (up/down/flat/new); model thay the re hon.
 * - Routing policy: validate (allow/deny overlap); normalize;
 *   merge (deny hop, allow giao, tran min); isModelAllowed;
 *   applyPolicy (cam voice -> text, tran gia/do tre, loai provider/
 *   model); store (get mac dinh khi chua co policy).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v29-provider-forecast-v142.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProviderConfigStoreV29,
  defaultProviderConfigsV29,
  filterProvidersByConfigV29,
  mergeProviderConfigV29,
  validateProviderConfigV29,
} from '../packages/core/dist/routerV29/providerConfigV29.js';
import {
  budgetBurnV29,
  cheaperAlternativeV29,
  forecastCostV29,
  modelTrendsV29,
} from '../packages/core/dist/routerV29/costForecastV29.js';
import {
  BotRoutingPolicyStoreV29,
  applyPolicyToRoutingRequestV29,
  defaultBotRoutingPolicyV29,
  isModelAllowedByPolicyV29,
  mergeBotRoutingPoliciesV29,
  normalizeBotRoutingPolicyV29,
  validateBotRoutingPolicyV29,
} from '../packages/core/dist/routerV29/routingPolicyV29.js';
import { ModelCostLedgerV29 } from '../packages/core/dist/routerV29/costLedgerV29.js';
import { defaultModelCatalogV29, findModelV29 } from '../packages/core/dist/routerV29/modelCatalogV29.js';

const DAY = '2026-11-19';

function ledgerWithHistory() {
  const ledger = new ModelCostLedgerV29();
  const live = findModelV29(defaultModelCatalogV29(), 'gpt-live');
  const flash = findModelV29(defaultModelCatalogV29(), 'gemini-3-flash-live');
  // 14 ngay: ngay 1-7 (2026-11-06..12) moi ngay $0.10 gpt-live;
  // ngay 8-14 (2026-11-13..19) moi ngay $0.20 gpt-live + $0.01 flash.
  for (let d = 6; d <= 19; d += 1) {
    const day = `2026-11-${String(d).padStart(2, '0')}`;
    const isRecent = d >= 13;
    ledger.recordUsage({
      modelId: 'gpt-live', provider: 'openai', sessionId: 's1',
      inputTokens: 0, outputTokens: 0, minutes: 0,
      costUsdOverride: isRecent ? 0.2 : 0.1,
      day, createdAt: Date.parse(`${day}T01:00:00.000Z`),
    });
    if (isRecent) {
      ledger.recordUsage({
        modelId: 'gemini-3-flash-live', provider: 'gemini', sessionId: 's1',
        inputTokens: 0, outputTokens: 0, minutes: 0,
        costUsdOverride: 0.01,
        day, createdAt: Date.parse(`${day}T02:00:00.000Z`),
      });
    }
  }
  return ledger;
}

test('provider config: mac dinh 5 provider, validate bat loi', () => {
  const defaults = defaultProviderConfigsV29();
  assert.equal(defaults.length, 5);
  assert.deepEqual(defaults.map((c) => c.provider), ['openai', 'gemini', 'anthropic', 'xai', 'ollama']);
  assert.ok(defaults.every((c) => validateProviderConfigV29(c).ok));
  assert.equal(defaults.find((c) => c.provider === 'ollama').local, true);
  assert.equal(defaults.find((c) => c.provider === 'ollama').authKind, 'local');
  const base = defaults[0];
  assert.equal(validateProviderConfigV29({ ...base, priority: -1 }).ok, false);
  assert.equal(validateProviderConfigV29({ ...base, authKind: 'magic' }).ok, false);
  assert.equal(validateProviderConfigV29({ ...base, maxRetries: 11 }).ok, false);
  assert.equal(validateProviderConfigV29({ ...base, timeoutMs: 0 }).ok, false);
  assert.equal(validateProviderConfigV29({ ...base, local: true, authKind: 'api-key' }).ok, false);
  assert.equal(validateProviderConfigV29({ ...base, rateLimitPerMin: -5 }).ok, false);
  const merged = mergeProviderConfigV29(base, { priority: 9, notes: 'moi' });
  assert.equal(merged.priority, 9);
  assert.equal(merged.notes, 'moi');
  assert.equal(merged.provider, 'openai');
});

test('provider config: store upsert/patch/enable/disable/routingOrder', () => {
  const store = new ProviderConfigStoreV29();
  assert.equal(store.size, 5);
  assert.equal(store.isEnabled('openai'), true);
  assert.deepEqual(store.enabledProviders().map((c) => c.provider), ['openai', 'gemini', 'anthropic', 'xai', 'ollama']);
  assert.deepEqual(store.routingOrder()[0], { provider: 'openai', enabled: true, priority: 1 });
  assert.equal(store.upsert({ ...store.get('xai'), enabled: false }).ok, true);
  assert.equal(store.isEnabled('xai'), false);
  assert.equal(store.disabledProviders().length, 1);
  assert.equal(store.patch('xai', { enabled: true }).ok, true);
  assert.equal(store.isEnabled('xai'), true);
  assert.equal(store.patch('khong-co', { enabled: true }).ok, false);
  assert.equal(store.upsert({ provider: 'x', enabled: true, priority: -1, authKind: 'api-key', timeoutMs: 1000, maxRetries: 1, local: false }).ok, false);
  assert.equal(store.get('x'), undefined);
  assert.deepEqual(store.defaultsFor('openai'), { timeoutMs: 60000, maxRetries: 2 });
  assert.deepEqual(store.defaultsFor('khong-co'), { timeoutMs: 60000, maxRetries: 2 });
  assert.equal(store.remove('xai'), true);
  assert.equal(store.size, 4);
  const { store: restored, skipped } = ProviderConfigStoreV29.fromJSON(store.toJSON());
  assert.equal(skipped, 0);
  assert.equal(restored.size, 4);
  assert.equal(ProviderConfigStoreV29.fromJSON([{ provider: 'bad' }]).skipped, 1);
  assert.equal(ProviderConfigStoreV29.fromJSON('nope').skipped, 1);
  const filtered = filterProvidersByConfigV29(['openai', 'xai', 'chua-dang-ky'], store);
  assert.deepEqual(filtered.allowed, ['openai']);
  assert.equal(filtered.rejected.length, 2);
});

test('forecast: trung binh/ngay + du bao 7/30 ngay', () => {
  const ledger = ledgerWithHistory();
  const records = ledger.allRecords();
  assert.equal(records.length, 21);
  const f = forecastCostV29(records, { windowDays: 14, endDay: DAY });
  assert.equal(f.daysWithData, 14);
  // Tong 14 ngay: 7*0.1 + 7*0.21 = 2.17; trung binh 0.155.
  assert.ok(Math.abs(f.windowTotalUsd - 2.17) < 1e-9);
  assert.ok(Math.abs(f.avgDailyUsd - 0.155) < 1e-9);
  assert.ok(Math.abs(f.projected30DayUsd - 4.65) < 1e-9);
  assert.ok(Math.abs(f.projected7DayUsd - 1.085) < 1e-9);
  assert.equal(f.lastDay, DAY);
  assert.ok(Math.abs(f.lastDayUsd - 0.21) < 1e-9);
  assert.equal(f.windowCalls, 21);
  // Cua so 7 ngay: chi 7 ngay gan nhat (7*0.21 = 1.47).
  const f7 = forecastCostV29(records, { windowDays: 7, endDay: DAY });
  assert.ok(Math.abs(f7.windowTotalUsd - 1.47) < 1e-9);
  assert.ok(Math.abs(f7.avgDailyUsd - 0.21) < 1e-9);
  // Khong du lieu -> 0.
  const empty = forecastCostV29([], { windowDays: 30, endDay: DAY });
  assert.equal(empty.avgDailyUsd, 0);
  assert.equal(empty.lastDay, null);
  assert.equal(empty.projected30DayUsd, 0);
});

test('forecast: burn + trend + cheaper alternative', () => {
  const ledger = ledgerWithHistory();
  const records = ledger.allRecords();
  const burn = budgetBurnV29(records, { dailyBudgetUsd: 0.2, monthlyBudgetUsd: 3, windowDays: 14, endDay: DAY });
  assert.ok(Math.abs(burn.avgDailyUsd - 0.155) < 1e-9);
  assert.equal(burn.willExceedDaily, false);
  assert.ok(Math.abs(burn.dailyUsagePct - 77.5) < 1e-9);
  assert.equal(burn.daysUntilMonthlyBudgetOut, 19);
  const tight = budgetBurnV29(records, { dailyBudgetUsd: 0.1, windowDays: 14, endDay: DAY });
  assert.equal(tight.willExceedDaily, true);
  const noBudget = budgetBurnV29(records, { windowDays: 14, endDay: DAY });
  assert.equal(noBudget.dailyBudgetUsd, null);
  assert.equal(noBudget.daysUntilMonthlyBudgetOut, null);
  assert.equal(noBudget.dailyUsagePct, null);
  const trends = modelTrendsV29(records, { endDay: DAY });
  assert.equal(trends.length, 2);
  const live = trends.find((t) => t.modelId === 'gpt-live');
  assert.equal(live.trend, 'up');
  assert.ok(Math.abs(live.recent7DayUsd - 1.4) < 1e-9);
  assert.ok(Math.abs(live.previous7DayUsd - 0.7) < 1e-9);
  assert.ok(Math.abs(live.deltaPct - 1) < 1e-9);
  const flash = trends.find((t) => t.modelId === 'gemini-3-flash-live');
  assert.equal(flash.trend, 'new');
  assert.equal(flash.deltaPct, null);
  // Thay the re hon: gpt-live -> gemini-3.8-live cung loai live, re hon.
  const catalog = defaultModelCatalogV29();
  const alt = cheaperAlternativeV29(catalog, 'gpt-live');
  assert.equal(alt.alternativeModelId, 'gemini-3-flash-live');
  assert.ok(alt.savedPerTurnUsd > 0.1);
  // qwen3-4b da re nhat (gia 0) -> khong co thay the.
  const cheapest = cheaperAlternativeV29(catalog, 'qwen3-4b');
  assert.equal(cheapest.alternativeModelId, null);
  assert.equal(cheaperAlternativeV29(catalog, 'khong-co').alternativeModelId, null);
});

test('policy: validate + normalize + merge', () => {
  const base = { botId: 'b1', deniedProviders: ['xai'], maxCostPerTurnUsd: 0.5, defaultProfile: 'balanced' };
  assert.equal(validateBotRoutingPolicyV29(base).ok, true);
  assert.equal(validateBotRoutingPolicyV29({ botId: '', deniedProviders: ['xai'] }).ok, false);
  assert.equal(validateBotRoutingPolicyV29({ botId: 'b1', allowedProviders: ['xai'], deniedProviders: ['xai'] }).ok, false);
  assert.equal(validateBotRoutingPolicyV29({ botId: 'b1', allowedModels: ['a'], deniedModels: ['a'] }).ok, false);
  assert.equal(validateBotRoutingPolicyV29({ botId: 'b1', defaultProfile: 'sieunhanh' }).ok, false);
  assert.equal(validateBotRoutingPolicyV29({ botId: 'b1', minQuality: 1.2 }).ok, false);
  assert.equal(validateBotRoutingPolicyV29({ botId: 'b1', maxLatencyMs: -5 }).ok, false);
  const messy = normalizeBotRoutingPolicyV29({ botId: 'b1', deniedProviders: ['xai', 'xai', 'openai'] });
  assert.deepEqual(messy.deniedProviders, ['openai', 'xai']);
  const over = { botId: 'b1', allowedProviders: ['openai', 'gemini'], deniedProviders: ['gemini'], maxCostPerTurnUsd: 0.2, voiceAllowed: false };
  const merged = mergeBotRoutingPoliciesV29(base, over);
  assert.deepEqual(merged.allowedProviders, ['gemini', 'openai']); // normalize sort alphabetically
  assert.deepEqual(merged.deniedProviders, ['gemini', 'xai']);
  assert.equal(merged.maxCostPerTurnUsd, 0.2);
  assert.equal(merged.voiceAllowed, false);
  assert.throws(() => mergeBotRoutingPoliciesV29(base, { ...over, botId: 'b2' }), /cung botId/);
  assert.equal(isModelAllowedByPolicyV29(merged, 'gpt-live', 'openai'), true);
  assert.equal(isModelAllowedByPolicyV29(merged, 'gpt-live', 'gemini'), false);
  assert.equal(isModelAllowedByPolicyV29(merged, 'grok-4.7', 'xai'), false);
  const allowOnly = { botId: 'b1', allowedProviders: ['openai'] };
  assert.equal(isModelAllowedByPolicyV29(allowOnly, 'gpt-live', 'openai'), true);
  assert.equal(isModelAllowedByPolicyV29(allowOnly, 'gemini-3.8-live', 'gemini'), false);
});

test('policy: apply vao request + store', () => {
  const policy = {
    botId: 'b1', defaultProfile: 'cheapest', maxCostPerTurnUsd: 0.1, maxLatencyMs: 500,
    minQuality: 0.8, deniedProviders: ['xai'], deniedModels: ['grok-4.7'], voiceAllowed: false,
    preferLocal: true, fallbackChainId: 'c1',
  };
  const { request, applied } = applyPolicyToRoutingRequestV29(policy, {
    needsRealtimeVoice: true, profile: undefined, maxCostUsd: 0.5, maxLatencyMs: 900,
  });
  assert.equal(request.needsRealtimeVoice, false);
  assert.equal(request.profile, 'cheapest');
  assert.equal(request.maxCostUsd, 0.1);
  assert.equal(request.maxLatencyMs, 500);
  assert.equal(request.minQuality, 0.8);
  assert.deepEqual(request.excludeProviders, ['xai']);
  assert.deepEqual(request.excludeModelIds, ['grok-4.7']);
  assert.equal(request.preferLocal, true);
  assert.ok(applied.length >= 5);
  // Policy khong mo rong request nguoi dung (tran nho hon thang).
  const { request: kept } = applyPolicyToRoutingRequestV29(policy, { maxCostUsd: 0.05 });
  assert.equal(kept.maxCostUsd, 0.05);
  const store = new BotRoutingPolicyStoreV29();
  assert.equal(store.has('b1'), false);
  assert.equal(store.get('b1').defaultProfile, 'balanced');
  assert.equal(store.get('b1').voiceAllowed, true);
  assert.equal(store.set(policy).ok, true);
  assert.equal(store.has('b1'), true);
  assert.equal(store.get('b1').maxCostPerTurnUsd, 0.1);
  assert.equal(store.set({ botId: 'b1', allowedProviders: ['x'], deniedProviders: ['x'] }).ok, false);
  assert.equal(store.size, 1);
  assert.equal(store.remove('b1'), true);
  assert.equal(store.size, 0);
  assert.equal(defaultBotRoutingPolicyV29('b9').botId, 'b9');
});
