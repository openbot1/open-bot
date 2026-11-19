/**
 * Router v30 — provider budget (v1.44, Doi T5, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - startOfUtcDayV30: 00:00 UTC.
 * - setBudget/getBudget/recordSpend/remaining/canAfford/isOverBudget:
 *   dat tran, ghi chi, con lai, het ngan sach.
 * - Qua ngay moi: so da chi reset (cap giu nguyen).
 * - Cap 0 = khong gioi han; chua dat budget -> khong chan gi.
 * - applyBudgetToDecisionV30: model chon het ngan sach -> doi sang
 *   ung vien tiep theo con ngan sach; het tat ca -> ok:false;
 *   khong co budget -> tra nguyen quyet dinh.
 * - Snapshot/restore + cap 100 provider.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v30-budget-v144.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProviderBudgetStoreV30,
  applyBudgetToDecisionV30,
  defaultModelCatalogV30,
  defaultRoutingPolicyV30,
  routeModelV30,
  startOfUtcDayV30,
} from '../packages/core/dist/routerV30/index.js';

// 2026-11-19 00:00 UTC + vai gio (epoch ms tinh tay de test on dinh).
const DAY = Date.UTC(2026, 10, 19, 0, 0, 0);
const NOON = DAY + 12 * 60 * 60 * 1000;
const NEXT_DAY = DAY + 24 * 60 * 60 * 1000;

test('startOfUtcDayV30: ve 00:00 UTC', () => {
  assert.equal(startOfUtcDayV30(NOON), DAY);
  assert.equal(startOfUtcDayV30(DAY + 23 * 60 * 60 * 1000 + 999), DAY);
  assert.equal(startOfUtcDayV30(NEXT_DAY), NEXT_DAY);
});

test('budget: dat tran, ghi chi, con lai, het ngan sach', () => {
  const store = new ProviderBudgetStoreV30();
  assert.equal(store.hasBudgets, false);
  assert.equal(store.getBudget('openai', NOON), null);
  assert.equal(store.remainingUsd('openai', NOON), null);
  assert.equal(store.isOverBudget('openai', NOON), false);
  assert.equal(store.canAfford('openai', 999, NOON), true);

  const b = store.setBudget('openai', 5, NOON);
  assert.equal(b.provider, 'openai');
  assert.equal(b.dailyCapUsd, 5);
  assert.equal(b.spentTodayUsd, 0);
  assert.equal(b.dayStartMs, DAY);
  assert.equal(store.hasBudgets, true);
  assert.equal(store.remainingUsd('openai', NOON), 5);
  assert.equal(store.canAfford('openai', 5, NOON), true);
  assert.equal(store.canAfford('openai', 5.01, NOON), false);

  store.recordSpend('openai', 2, NOON);
  assert.equal(store.remainingUsd('openai', NOON), 3);
  assert.equal(store.isOverBudget('openai', NOON), false);
  store.recordSpend('openai', 3, NOON);
  assert.equal(store.remainingUsd('openai', NOON), 0);
  assert.equal(store.isOverBudget('openai', NOON), true);
  assert.equal(store.canAfford('openai', 0.0001, NOON), false);
  // Ghi chi cho provider chua dat budget -> null, khong tao budget.
  assert.equal(store.recordSpend('gemini', 1, NOON), null);
  assert.equal(store.getBudget('gemini', NOON), null);

  // Cap 0 = khong gioi han.
  store.setBudget('ollama', 0, NOON);
  store.recordSpend('ollama', 1000, NOON);
  assert.equal(store.remainingUsd('ollama', NOON), Number.POSITIVE_INFINITY);
  assert.equal(store.isOverBudget('ollama', NOON), false);

  // setBudget sai thi throw.
  assert.throws(() => store.setBudget('', 5, NOON), /provider is required/);
  assert.throws(() => store.setBudget('x', -1, NOON), /dailyCapUsd/);
  assert.equal(store.recordSpend('openai', -1, NOON), null);
});

test('budget: qua ngay moi thi reset so da chi', () => {
  const store = new ProviderBudgetStoreV30();
  store.setBudget('openai', 5, NOON);
  store.recordSpend('openai', 5, NOON);
  assert.equal(store.isOverBudget('openai', NOON), true);
  // Ngay hom sau: con lai day du.
  assert.equal(store.remainingUsd('openai', NEXT_DAY + 1000), 5);
  assert.equal(store.isOverBudget('openai', NEXT_DAY + 1000), false);
  assert.equal(store.getBudget('openai', NEXT_DAY + 1000).spentTodayUsd, 0);
  assert.equal(store.getBudget('openai', NEXT_DAY + 1000).dailyCapUsd, 5);
  // Doi cap trong ngay moi giu so da chi cua ngay moi (0).
  const updated = store.setBudget('openai', 10, NEXT_DAY + 2000);
  assert.equal(updated.dailyCapUsd, 10);
  assert.equal(updated.spentTodayUsd, 0);
  // allBudgets sap xep theo provider.
  store.setBudget('gemini', 3, NEXT_DAY + 2000);
  assert.deepEqual(store.allBudgets(NEXT_DAY + 2000).map((x) => x.provider), ['gemini', 'openai']);
  assert.equal(store.removeBudget('gemini'), true);
  assert.equal(store.removeBudget('gemini'), false);
});

test('applyBudgetToDecisionV30: doi sang ung vien con ngan sach', () => {
  const catalog = defaultModelCatalogV30(1_000_000);
  const policy = defaultRoutingPolicyV30();
  const entry = (provider, modelId) =>
    catalog.entries.find((e) => e.provider === provider && e.modelId === modelId);
  const candidate = (provider, modelId, score) => {
    const e = entry(provider, modelId);
    return {
      entry: e,
      score,
      latencyScore: 0.5,
      costScore: 0.5,
      qualityScore: e.qualityScore,
      effectiveLatencyMs: e.estimatedLatencyMs,
      latencyMeasured: false,
      latencySamples: 0,
      estimatedCostUsd: (1000 / 1_000_000) * e.inputPricePerMillionUsd + (500 / 1_000_000) * e.outputPricePerMillionUsd,
      reasons: [],
    };
  };
  // Decision tu build: chon gpt-5.2 (tra phi) -> llama (mien phi) -> mini (tra phi).
  const decision = {
    ok: true,
    chosen: candidate('openai', 'gpt-5.2', 0.9),
    candidates: [
      candidate('openai', 'gpt-5.2', 0.9),
      candidate('ollama', 'llama-4-scout', 0.8),
      candidate('openai', 'gpt-5.2-mini', 0.7),
    ],
    rejected: [],
    policySummary: 'test',
    decidedAt: 2000,
  };
  assert.ok(decision.chosen.estimatedCostUsd > 0);

  // Khong co budget -> tra nguyen quyet dinh (cung object).
  const empty = new ProviderBudgetStoreV30();
  assert.equal(applyBudgetToDecisionV30(decision, empty, NOON), decision);

  // Het ngan sach openai (chi vuot cap de remaining am) -> doi sang ollama.
  const store = new ProviderBudgetStoreV30();
  store.setBudget('openai', 1, NOON);
  store.recordSpend('openai', 2, NOON);
  const moved = applyBudgetToDecisionV30(decision, store, NOON);
  assert.equal(moved.ok, true);
  assert.equal(moved.chosen.entry.modelId, 'llama-4-scout');
  assert.equal(moved.chosen.entry.provider, 'ollama');
  assert.ok(moved.rejected.some((r) => r.reason.includes('over daily budget')));
  assert.equal(decision.chosen.entry.modelId, 'gpt-5.2'); // quyet dinh cu khong doi

  // Het ca ollama (remaining am) -> khong con ung vien nao -> ok:false.
  store.setBudget('ollama', 1, NOON);
  store.recordSpend('ollama', 2, NOON);
  const failed = applyBudgetToDecisionV30(decision, store, NOON);
  assert.equal(failed.ok, false);
  assert.equal(failed.chosen, undefined);
  assert.equal(failed.candidates.length, 0);

  // Decision khong ok -> tra nguyen.
  const noFit = routeModelV30(catalog, { minContextTokens: 99_999_999 }, policy, null, 2000);
  assert.equal(applyBudgetToDecisionV30(noFit, store, NOON), noFit);
});

test('budget: snapshot/restore + cap 100 provider', () => {
  const store = new ProviderBudgetStoreV30();
  store.setBudget('openai', 5, NOON);
  store.recordSpend('openai', 2, NOON);
  const snap = store.snapshotV30();
  const store2 = new ProviderBudgetStoreV30();
  assert.equal(store2.restoreV30(snap), 1);
  assert.equal(store2.remainingUsd('openai', NOON), 3);
  assert.equal(store2.restoreV30([{ provider: '', dailyCapUsd: 5 }]), 0);
  assert.equal(store2.restoreV30([{ provider: 'x', dailyCapUsd: -1 }]), 0);

  const big = new ProviderBudgetStoreV30();
  for (let i = 0; i < 120; i += 1) big.setBudget(`p${i}`, 1, NOON);
  assert.equal(big.allBudgets(NOON).length, 100);
});
