/**
 * Router v29 — per-model cost ledger (v1.42, Doi T5, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - Ghi so: tinh chi phi token + phut (GPT-Live $0.05/phut), id duy
 *   nhat, ngay mac dinh tu createdAt.
 * - Tong hop: total / byModel / byDay / bySession / byProvider,
 *   top model + top day.
 * - Budget: ngan sach ngay + phien, over/near-limit (>=80%),
 *   session vuot ngan sach.
 * - Prune: xoa ban ghi cu hon mot ngay; serialize/deserialize
 *   (bo qua ban ghi sai, dem skipped).
 * - Validation: modelId/sessionId rong, gia am, day sai dinh dang.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v29-cost-ledger-v142.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelCostLedgerV29,
  dayOfTimestampV29,
  isValidDayV29,
} from '../packages/core/dist/routerV29/costLedgerV29.js';
import { findModelV29, defaultModelCatalogV29 } from '../packages/core/dist/routerV29/modelCatalogV29.js';

const DAY1 = '2026-11-19';
const T1 = Date.parse('2026-11-19T01:00:00.000Z');
const T2 = Date.parse('2026-11-19T02:00:00.000Z');
const T3 = Date.parse('2026-11-20T01:00:00.000Z');

function ledgerWithData() {
  const ledger = new ModelCostLedgerV29(() => T1);
  const live = findModelV29(defaultModelCatalogV29(), 'gpt-live');
  const flash = findModelV29(defaultModelCatalogV29(), 'gemini-3-flash-live');
  ledger.recordUsage({
    modelId: 'gpt-live', provider: 'openai', sessionId: 's1',
    inputTokens: 1000, outputTokens: 500, minutes: 10,
    inputPricePer1kUsd: live.inputPricePer1kUsd,
    outputPricePer1kUsd: live.outputPricePer1kUsd,
    perMinuteUsd: live.perMinuteUsd,
    createdAt: T1,
  });
  ledger.recordUsage({
    modelId: 'gemini-3-flash-live', provider: 'gemini', sessionId: 's1',
    inputTokens: 2000, outputTokens: 1000, minutes: 0,
    inputPricePer1kUsd: flash.inputPricePer1kUsd,
    outputPricePer1kUsd: flash.outputPricePer1kUsd,
    createdAt: T2,
  });
  ledger.recordUsage({
    modelId: 'gpt-live', provider: 'openai', sessionId: 's2',
    inputTokens: 500, outputTokens: 0, minutes: 5,
    inputPricePer1kUsd: live.inputPricePer1kUsd,
    outputPricePer1kUsd: live.outputPricePer1kUsd,
    perMinuteUsd: live.perMinuteUsd,
    createdAt: T3,
  });
  return ledger;
}

test('ledger: day helper + validate day', () => {
  assert.equal(dayOfTimestampV29(T1), DAY1);
  assert.equal(isValidDayV29('2026-11-19'), true);
  assert.equal(isValidDayV29('2026-02-30'), false);
  assert.equal(isValidDayV29('19/11/2026'), false);
  assert.equal(isValidDayV29('2026-11-19T01:00'), false);
});

test('ledger: ghi so tinh dung token + phut, id duy nhat', () => {
  const ledger = new ModelCostLedgerV29(() => T1);
  const live = findModelV29(defaultModelCatalogV29(), 'gpt-live');
  const r = ledger.recordUsage({
    modelId: 'gpt-live', provider: 'openai', sessionId: 's1',
    inputTokens: 1000, outputTokens: 500, minutes: 10,
    inputPricePer1kUsd: live.inputPricePer1kUsd,
    outputPricePer1kUsd: live.outputPricePer1kUsd,
    perMinuteUsd: live.perMinuteUsd,
  });
  // 0.04 + 0.08 + 10*0.05 = 0.62.
  assert.ok(Math.abs(r.costUsd - 0.62) < 1e-9);
  assert.equal(r.day, DAY1);
  assert.equal(r.minutes, 10);
  assert.equal(ledger.size, 1);
  const r2 = ledger.recordUsage({
    modelId: 'qwen3-4b', provider: 'ollama', sessionId: 's1',
    inputTokens: 9000, outputTokens: 9000,
    inputPricePer1kUsd: 0, outputPricePer1kUsd: 0,
  });
  assert.equal(r2.costUsd, 0);
  assert.notEqual(r.id, r2.id);
  // costUsdOverride thang gia tinh san.
  const r3 = ledger.recordUsage({
    modelId: 'x', provider: 'y', sessionId: 's9', costUsdOverride: 1.5,
  });
  assert.equal(r3.costUsd, 1.5);
});

test('ledger: tong hop theo model/ngay/phien/provider', () => {
  const ledger = ledgerWithData();
  // gpt-live: (0.04+0.08+0.5) + (0.02+0+0.25) = 0.89; flash: 0.001+0.002 = 0.003.
  assert.ok(Math.abs(ledger.costByModel('gpt-live') - 0.89) < 1e-9);
  assert.ok(Math.abs(ledger.costByModel('gemini-3-flash-live') - 0.003) < 1e-9);
  assert.ok(Math.abs(ledger.costByDay(DAY1) - 0.623) < 1e-9);
  assert.ok(Math.abs(ledger.costByDay('2026-11-20') - 0.27) < 1e-9);
  assert.ok(Math.abs(ledger.costBySession('s1') - 0.623) < 1e-9);
  assert.ok(Math.abs(ledger.costByProvider('openai') - 0.89) < 1e-9);
  assert.ok(Math.abs(ledger.totalCost() - 0.893) < 1e-9);
  const s = ledger.summary();
  assert.equal(s.totalCalls, 3);
  assert.equal(s.topModelId, 'gpt-live');
  assert.equal(s.topDay, DAY1);
  assert.equal(s.byModel[0].key, 'gpt-live');
  assert.equal(s.byModel[0].calls, 2);
  assert.equal(s.byDay.length, 2);
  assert.equal(s.bySession.length, 2);
  assert.equal(s.totalMinutes, 15);
  assert.equal(s.totalInputTokens, 3500);
  assert.equal(s.totalOutputTokens, 1500);
  assert.equal(ledger.recordsOnDay(DAY1).length, 2);
  assert.equal(ledger.recordsOnDay('2026-11-21').length, 0);
});

test('ledger: budget ngay + phien, near-limit 80%', () => {
  const ledger = ledgerWithData();
  ledger.setDailyBudget(1);
  ledger.setSessionBudget('s1', 0.5);
  const check = ledger.checkBudget(DAY1);
  assert.equal(check.dailyBudgetUsd, 1);
  assert.ok(Math.abs(check.dailyUsedUsd - 0.623) < 1e-9);
  assert.equal(check.overDaily, false);
  assert.equal(check.dailyNearLimit, false);
  assert.equal(check.sessionsOverBudget.length, 1);
  assert.equal(check.sessionsOverBudget[0].sessionId, 's1');
  // Ha ngan sach ngay xuong 0.5 -> vuot + near-limit.
  ledger.setDailyBudget(0.5);
  const over = ledger.checkBudget(DAY1);
  assert.equal(over.overDaily, true);
  assert.equal(over.dailyNearLimit, true);
  assert.ok(over.dailyRemainingUsd < 0);
  // Xoa ngan sach ngay.
  ledger.setDailyBudget(null);
  assert.equal(ledger.checkBudget(DAY1).dailyBudgetUsd, null);
  assert.equal(ledger.getDailyBudget(), null);
  assert.equal(ledger.getSessionBudget('s1'), 0.5);
});

test('ledger: prune + clear + serialize round-trip', () => {
  const ledger = ledgerWithData();
  ledger.setDailyBudget(2);
  ledger.setSessionBudget('s1', 1);
  assert.equal(ledger.pruneBefore('2026-11-20'), 2);
  assert.equal(ledger.size, 1);
  assert.equal(ledger.costByDay(DAY1), 0);
  const json = ledger.toJSON();
  const { ledger: restored, skipped } = ModelCostLedgerV29.fromJSON(json);
  assert.equal(skipped, 0);
  assert.equal(restored.size, 1);
  assert.ok(Math.abs(restored.totalCost() - 0.27) < 1e-9);
  assert.equal(restored.getDailyBudget(), 2);
  assert.equal(restored.getSessionBudget('s1'), 1);
  // fromJSON bo qua ban ghi sai.
  const bad = ModelCostLedgerV29.fromJSON({
    records: [{ modelId: 'a' }, { modelId: 'b', provider: 'p', sessionId: 's', day: '2026-13-40', costUsd: 1 }],
    dailyBudgetUsd: -5,
  });
  assert.equal(bad.ledger.size, 0);
  assert.equal(bad.skipped, 2);
  assert.equal(ModelCostLedgerV29.fromJSON(null).skipped, 1);
  ledger.clear();
  assert.equal(ledger.size, 0);
  assert.equal(ledger.totalCost(), 0);
  // allRecords tra ban sao (doi mang tra ve khong anh huong ledger).
  const l2 = ledgerWithData();
  const all = l2.allRecords();
  all.pop();
  assert.equal(l2.size, 3);
});

test('ledger: validate dau vao', () => {
  const ledger = new ModelCostLedgerV29(() => T1);
  assert.throws(() => ledger.recordUsage({ modelId: '', provider: 'openai', sessionId: 's1' }), /modelId/);
  assert.throws(() => ledger.recordUsage({ modelId: 'm', provider: '', sessionId: 's1' }), /provider/);
  assert.throws(() => ledger.recordUsage({ modelId: 'm', provider: 'p', sessionId: '' }), /sessionId/);
  assert.throws(
    () => ledger.recordUsage({ modelId: 'm', provider: 'p', sessionId: 's1', inputPricePer1kUsd: -1 }),
    /Gia/,
  );
  assert.throws(
    () => ledger.recordUsage({ modelId: 'm', provider: 'p', sessionId: 's1', day: '19-11-2026' }),
    /day khong hop le/,
  );
  assert.throws(() => ledger.setDailyBudget(-1), /Ngan sach ngay/);
  assert.throws(() => ledger.setSessionBudget('s1', -0.5), /Ngan sach phien/);
  assert.throws(() => ledger.pruneBefore('11/2026'), /day khong hop le/);
});
