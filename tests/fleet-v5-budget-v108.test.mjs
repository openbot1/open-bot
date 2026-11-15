/**
 * Tests for per-bot resource budget v2 (packages/core/src/fleet/fleetV5Budget.ts).
 *
 * Covers budget validation (hard < soft rejected, preSoftWarnPercent
 * must be in (0, 1)), set/get/remove round-trip, evaluation levels
 * (ok / approaching-soft / over-soft / over-hard) + actions
 * (none / warn / throttle / stop) + shouldStop / shouldBlockNewTasks,
 * disabled budget (no limits enforced), usage history recording
 * (append + 500-sample cap + clear), history summary (peak/avg/trend
 * rising/falling/stable/unknown + over-soft/over-hard counts), and
 * checkAllFleetV5Budgets.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-v5-budget-v108.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  checkAllFleetV5Budgets,
  clearFleetV5BudgetHistory,
  evaluateFleetV5BotBudget,
  getFleetV5BotBudget,
  loadFleetV5BudgetHistory,
  loadFleetV5Budgets,
  recordFleetV5BudgetUsage,
  removeFleetV5BotBudget,
  setFleetV5BotBudget,
  summarizeFleetV5BudgetHistory,
  summarizeFleetV5BudgetHistoryFromFile,
  validateFleetV5BotBudget,
} from '../packages/core/dist/fleet/fleetV5Budget.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v5-budget-'));
}

const T0 = 1792000000000;
const GB = 1024 * 1024 * 1024;

function makeBudget(overrides = {}) {
  return {
    botId: 'bot-1',
    soft: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB },
    hard: { cpuCores: 2, ramBytes: 2 * GB, diskBytes: 20 * GB },
    preSoftWarnPercent: 0.8,
    enabled: true,
    updatedAt: new Date(T0).toISOString(),
    updatedBy: 'test',
    ...overrides,
  };
}

function sample(overrides = {}) {
  return {
    botId: 'bot-1',
    cpuCores: 0.5,
    ramBytes: 0.5 * GB,
    diskBytes: 5 * GB,
    at: T0,
    ...overrides,
  };
}

test('validate: hard < soft bị từ chối từng tài nguyên; preSoftWarnPercent phải trong (0,1)', () => {
  assert.doesNotThrow(() => validateFleetV5BotBudget(makeBudget()));
  assert.throws(
    () => validateFleetV5BotBudget(makeBudget({ hard: { cpuCores: 0.5, ramBytes: 2 * GB, diskBytes: 20 * GB } })),
    /hard\.cpuCores.*không được nhỏ hơn soft\.cpuCores/,
  );
  assert.throws(
    () => validateFleetV5BotBudget(makeBudget({ hard: { cpuCores: 2, ramBytes: 0.5 * GB, diskBytes: 20 * GB } })),
    /hard\.ramBytes/,
  );
  assert.throws(() => validateFleetV5BotBudget(makeBudget({ preSoftWarnPercent: 1 })), /preSoftWarnPercent/);
  assert.throws(() => validateFleetV5BotBudget(makeBudget({ preSoftWarnPercent: 0 })), /preSoftWarnPercent/);
  assert.throws(() => validateFleetV5BotBudget(makeBudget({ soft: { cpuCores: 0, ramBytes: 1, diskBytes: 1 } })), /soft\.cpuCores/);
  assert.throws(() => validateFleetV5BotBudget(makeBudget({ botId: '  ' })), /non-empty botId/);
  // hard == soft thì được.
  assert.doesNotThrow(() =>
    validateFleetV5BotBudget(makeBudget({ hard: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB } })),
  );
});

test('set/get/remove: round-trip qua file; set lại thì thay thế, không nhân đôi', () => {
  const root = tmpDir();
  assert.deepEqual(loadFleetV5Budgets(root), []);
  const saved = setFleetV5BotBudget(root, {
    botId: 'bot-1',
    soft: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB },
    hard: { cpuCores: 2, ramBytes: 2 * GB, diskBytes: 20 * GB },
  }, 'admin');
  assert.equal(saved.preSoftWarnPercent, 0.8); // mặc định
  assert.equal(saved.enabled, true);
  assert.equal(getFleetV5BotBudget(root, 'bot-1')?.botId, 'bot-1');
  setFleetV5BotBudget(root, {
    botId: 'bot-1',
    soft: { cpuCores: 0.5, ramBytes: 512 * 1024 * 1024, diskBytes: 5 * GB },
    hard: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB },
    preSoftWarnPercent: 0.7,
  }, 'admin');
  assert.equal(loadFleetV5Budgets(root).length, 1);
  assert.equal(getFleetV5BotBudget(root, 'bot-1')?.soft.cpuCores, 0.5);
  assert.equal(getFleetV5BotBudget(root, 'bot-1')?.preSoftWarnPercent, 0.7);
  assert.equal(removeFleetV5BotBudget(root, 'bot-1'), true);
  assert.equal(removeFleetV5BotBudget(root, 'bot-1'), false);
  assert.equal(getFleetV5BotBudget(root, 'bot-1'), undefined);
  assert.throws(
    () => setFleetV5BotBudget(root, { botId: 'bot-2', soft: { cpuCores: 1, ramBytes: 1, diskBytes: 1 }, hard: { cpuCores: 1, ramBytes: 1, diskBytes: 1 } }, '  '),
    /non-empty updatedBy/,
  );
});

test('evaluate: ok khi dưới ngưỡng cảnh báo sớm; approaching khi chạm 80% soft', () => {
  const budget = makeBudget();
  const ok = evaluateFleetV5BotBudget(budget, sample());
  assert.equal(ok.overallLevel, 'ok');
  assert.equal(ok.action, 'none');
  assert.equal(ok.shouldStop, false);
  assert.equal(ok.shouldBlockNewTasks, false);
  assert.equal(ok.budgetEnabled, true);
  assert.deepEqual(ok.reasons, []);
  // RAM 0.85GB = 85% soft -> approaching-soft, action warn.
  const approaching = evaluateFleetV5BotBudget(budget, sample({ ramBytes: 0.85 * GB }));
  assert.equal(approaching.overallLevel, 'approaching-soft');
  assert.equal(approaching.action, 'warn');
  assert.equal(approaching.resources.ramBytes.level, 'approaching-soft');
  assert.equal(approaching.resources.cpuCores.level, 'ok');
  assert.equal(approaching.shouldStop, false);
  assert.equal(approaching.shouldBlockNewTasks, false);
  assert.match(approaching.reasons[0], /sắp chạm giới hạn mềm RAM/);
  // Đúng 80% soft -> approaching (ngưỡng >=).
  const atThreshold = evaluateFleetV5BotBudget(budget, sample({ ramBytes: 0.8 * GB }));
  assert.equal(atThreshold.resources.ramBytes.level, 'approaching-soft');
});

test('evaluate: over-soft -> throttle + chặn task mới; over-hard -> stop', () => {
  const budget = makeBudget();
  const overSoft = evaluateFleetV5BotBudget(budget, sample({ cpuCores: 1.5 }));
  assert.equal(overSoft.overallLevel, 'over-soft');
  assert.equal(overSoft.action, 'throttle');
  assert.equal(overSoft.shouldStop, false);
  assert.equal(overSoft.shouldBlockNewTasks, true);
  assert.match(overSoft.reasons[0], /vượt giới hạn mềm CPU/);
  // Vượt hard ở 1 tài nguyên, các tài nguyên khác vẫn ok -> overall over-hard.
  const overHard = evaluateFleetV5BotBudget(budget, sample({ diskBytes: 25 * GB }));
  assert.equal(overHard.overallLevel, 'over-hard');
  assert.equal(overHard.action, 'stop');
  assert.equal(overHard.shouldStop, true);
  assert.equal(overHard.shouldBlockNewTasks, true);
  assert.equal(overHard.resources.diskBytes.level, 'over-hard');
  assert.equal(overHard.resources.cpuCores.level, 'ok');
  assert.match(overHard.reasons[0], /vượt GIỚI HẠN CỨNG đĩa/);
  // Đúng bằng hard -> over-hard (>=).
  const atHard = evaluateFleetV5BotBudget(budget, sample({ cpuCores: 2 }));
  assert.equal(atHard.resources.cpuCores.level, 'over-hard');
});

test('evaluate: chưa đặt budget / budget tắt thì không giới hạn gì', () => {
  const noBudget = evaluateFleetV5BotBudget(undefined, sample({ cpuCores: 99 }));
  assert.equal(noBudget.budgetEnabled, false);
  assert.equal(noBudget.action, 'none');
  assert.equal(noBudget.shouldStop, false);
  assert.match(noBudget.reasons[0], /chưa đặt budget/);
  const disabled = evaluateFleetV5BotBudget(makeBudget({ enabled: false }), sample({ cpuCores: 99 }));
  assert.equal(disabled.budgetEnabled, false);
  assert.equal(disabled.action, 'none');
  assert.match(disabled.reasons[0], /đang tắt/);
});

test('record + history: ghi sample, đọc lại theo thời gian; summary peak/avg/counts', () => {
  const root = tmpDir();
  setFleetV5BotBudget(root, {
    botId: 'bot-1',
    soft: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB },
    hard: { cpuCores: 2, ramBytes: 2 * GB, diskBytes: 20 * GB },
  }, 'admin');
  const e1 = recordFleetV5BudgetUsage(root, sample({ at: T0 }));
  assert.equal(e1.overallLevel, 'ok');
  const e2 = recordFleetV5BudgetUsage(root, sample({ at: T0 + 1000, cpuCores: 1.5 }));
  assert.equal(e2.overallLevel, 'over-soft');
  const e3 = recordFleetV5BudgetUsage(root, sample({ at: T0 + 2000, cpuCores: 2.5 }));
  assert.equal(e3.action, 'stop');
  const history = loadFleetV5BudgetHistory(root, 'bot-1');
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((s) => s.at), [T0, T0 + 1000, T0 + 2000]);
  const summary = summarizeFleetV5BudgetHistoryFromFile(root, 'bot-1');
  assert.equal(summary.samples, 3);
  assert.equal(summary.peak.cpuCores, 2.5);
  assert.equal(summary.overSoftCount, 1);
  assert.equal(summary.overHardCount, 1);
  assert.equal(summary.firstAt, T0);
  assert.equal(summary.lastAt, T0 + 2000);
  assert.ok(Math.abs(summary.average.cpuCores - (0.5 + 1.5 + 2.5) / 3) < 1e-9);
  assert.deepEqual(loadFleetV5BudgetHistory(root, 'bot-chua-co'), []);
  // Sample âm bị từ chối, không ghi.
  assert.throws(() => recordFleetV5BudgetUsage(root, sample({ cpuCores: -1 })), /cpuCores phải là số >= 0/);
  assert.equal(loadFleetV5BudgetHistory(root, 'bot-1').length, 3);
});

test('history summary (thuần): trend rising/falling/stable/unknown', () => {
  const budget = makeBudget();
  const rising = summarizeFleetV5BudgetHistory(
    'bot-1',
    [0, 1, 2, 3, 4, 5].map((i) => sample({ at: T0 + i * 1000, cpuCores: 0.1 + i * 0.2 })),
    budget,
  );
  assert.equal(rising.trend.cpuCores, 'rising');
  assert.equal(rising.trend.ramBytes, 'stable'); // không đổi
  const falling = summarizeFleetV5BudgetHistory(
    'bot-1',
    [0, 1, 2, 3, 4, 5].map((i) => sample({ at: T0 + i * 1000, cpuCores: 1 - i * 0.15 })),
    budget,
  );
  assert.equal(falling.trend.cpuCores, 'falling');
  const few = summarizeFleetV5BudgetHistory('bot-1', [sample()], budget);
  assert.equal(few.trend.cpuCores, 'unknown');
  assert.equal(few.samples, 1);
  assert.equal(few.peak.ramBytes, 0.5 * GB);
  const empty = summarizeFleetV5BudgetHistory('bot-1', [], budget);
  assert.equal(empty.samples, 0);
  assert.equal(empty.firstAt, null);
  assert.equal(empty.peak.cpuCores, 0);
});

test('history cap: quá 500 sample thì cắt cũ nhất; clear xoá hết', () => {
  const root = tmpDir();
  const filePath = path.join(root, 'fleet-budget-history-v108.json');
  const many = Array.from({ length: 505 }, (_, i) => sample({ at: T0 + i * 1000 }));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ 'bot-1': many }), 'utf8');
  recordFleetV5BudgetUsage(root, sample({ at: T0 + 505 * 1000 }));
  const history = loadFleetV5BudgetHistory(root, 'bot-1');
  assert.equal(history.length, 500);
  assert.equal(history[0].at, T0 + 6 * 1000); // 6 sample cũ nhất đã cắt
  assert.equal(history[history.length - 1].at, T0 + 505 * 1000);
  assert.equal(clearFleetV5BudgetHistory(root, 'bot-1'), true);
  assert.equal(clearFleetV5BudgetHistory(root, 'bot-1'), false);
  assert.deepEqual(loadFleetV5BudgetHistory(root, 'bot-1'), []);
});

test('checkAll: chỉ đánh giá bot có budget + có sample mới nhất', () => {
  const root = tmpDir();
  setFleetV5BotBudget(root, { botId: 'bot-1', soft: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB }, hard: { cpuCores: 2, ramBytes: 2 * GB, diskBytes: 20 * GB } }, 'admin');
  setFleetV5BotBudget(root, { botId: 'bot-2', soft: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB }, hard: { cpuCores: 2, ramBytes: 2 * GB, diskBytes: 20 * GB } }, 'admin');
  const results = checkAllFleetV5Budgets(root, [sample({ botId: 'bot-1', cpuCores: 1.5 }), sample({ botId: 'bot-3', cpuCores: 9 })]);
  assert.equal(results.length, 1); // bot-2 không có sample, bot-3 không có budget
  assert.equal(results[0].botId, 'bot-1');
  assert.equal(results[0].overallLevel, 'over-soft');
});
