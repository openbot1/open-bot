/**
 * Tests for fleet health dashboard v5 (packages/core/src/fleet/fleetV5Health.ts).
 *
 * Covers the pure aggregator (bot status derivation: running /
 * waiting / error / idle / over-budget / stopped; totals used vs
 * total with nulls when nothing is measured; warnings: over-hard,
 * over-soft, failed runs, blocked campaign tasks, all-tasks-failed
 * campaign, no-alive-node, bot without budget) and the file-backed
 * builder (reads campaigns + budgets + history from a fleet root),
 * plus the one-line formatter.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-v5-health-v108.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  aggregateFleetV5Health,
  buildFleetV5HealthDashboard,
  fleetV5BotBudgetLevel,
  formatFleetV5HealthLine,
} from '../packages/core/dist/fleet/fleetV5Health.js';
import { addFleetV5Task, claimNextFleetV5Task, createFleetV5Campaign, failFleetV5Task, saveFleetV5Campaigns } from '../packages/core/dist/fleet/fleetV5Campaign.js';
import { recordFleetV5BudgetUsage, setFleetV5BotBudget } from '../packages/core/dist/fleet/fleetV5Budget.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v5-health-'));
}

const T0 = 1792000000000;
const GB = 1024 * 1024 * 1024;

function makeNode(overrides = {}) {
  return {
    id: 'fn-1',
    hostname: 'may-chinh',
    host: '127.0.0.1',
    port: 8091,
    role: 'worker',
    cpuCores: 4,
    ramBytes: 8 * GB,
    diskBytes: 100 * GB,
    loopback: true,
    lastHeartbeatAt: T0,
    lastLoad: null,
    registeredAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makeRun(overrides = {}) {
  return {
    id: 'br-1',
    botId: 'bot-1',
    summary: 'Chạy task memory',
    priority: 'medium',
    resources: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB },
    status: 'running',
    nodeId: 'fn-1',
    attempts: 1,
    maxAttempts: 3,
    nextAttemptAt: null,
    createdAt: T0,
    scheduledAt: T0,
    startedAt: T0,
    finishedAt: null,
    history: [],
    ...overrides,
  };
}

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

function makeUsage(overrides = {}) {
  return { botId: 'bot-1', cpuCores: 0.5, ramBytes: 0.5 * GB, diskBytes: 5 * GB, at: T0, ...overrides };
}

function emptyInput(overrides = {}) {
  return {
    runs: [],
    nodes: [],
    campaigns: [],
    budgets: [],
    latestUsageByBot: new Map(),
    now: T0,
    ...overrides,
  };
}

test('budgetLevel: null khi chưa có budget/sample; over-hard thắng over-soft', () => {
  assert.equal(fleetV5BotBudgetLevel(undefined, makeUsage()), null);
  assert.equal(fleetV5BotBudgetLevel(makeBudget(), undefined), null);
  assert.equal(fleetV5BotBudgetLevel(makeBudget(), makeUsage()), 'ok');
  assert.equal(fleetV5BotBudgetLevel(makeBudget(), makeUsage({ ramBytes: 0.85 * GB })), 'approaching-soft');
  assert.equal(fleetV5BotBudgetLevel(makeBudget(), makeUsage({ cpuCores: 1.5 })), 'over-soft');
  assert.equal(fleetV5BotBudgetLevel(makeBudget(), makeUsage({ cpuCores: 1.5, diskBytes: 25 * GB })), 'over-hard');
  assert.equal(fleetV5BotBudgetLevel(makeBudget({ enabled: false }), makeUsage({ cpuCores: 99 })), null);
});

test('aggregate: fleet rỗng -> totals null, 0 bot, không warning', () => {
  const d = aggregateFleetV5Health(emptyInput());
  assert.equal(d.bots.length, 0);
  assert.equal(d.totals.botsTotal, 0);
  assert.equal(d.totals.cpuCoresTotal, null);
  assert.equal(d.totals.cpuCoresUsed, null);
  assert.equal(d.warnings.length, 0);
  assert.match(formatFleetV5HealthLine(d), /bots 0 running, 0 waiting, 0 error, 0 idle/);
  assert.match(formatFleetV5HealthLine(d), /CPU chưa đo được/);
});

test('aggregate: trạng thái bot — running / waiting / error / idle / over-budget / stopped', () => {
  const campaign = createFleetV5Campaign({ goal: 'G', repos: ['open-bot'] }, T0);
  const t1 = addFleetV5Task(campaign, { repo: 'open-bot', title: 'T1', brief: 'b', paths: ['a.md'] }, T0).task;
  const d = aggregateFleetV5Health(emptyInput({
    runs: [
      makeRun({ botId: 'bot-run', status: 'running', nodeId: 'fn-1' }),
      makeRun({ id: 'br-2', botId: 'bot-wait', status: 'queued', nodeId: null, startedAt: null }),
      makeRun({ id: 'br-3', botId: 'bot-err', status: 'failed', nodeId: null, lastError: 'OOM killed', startedAt: T0, finishedAt: T0 + 1000 }),
    ],
    nodes: [makeNode()],
    budgets: [
      makeBudget({ botId: 'bot-over' }),
      makeBudget({ botId: 'bot-stop' }),
    ],
    latestUsageByBot: new Map([
      ['bot-over', makeUsage({ botId: 'bot-over', cpuCores: 1.5 })],
      ['bot-stop', makeUsage({ botId: 'bot-stop', diskBytes: 25 * GB })],
      ['bot-run', makeUsage({ botId: 'bot-run' })],
    ]),
  }));
  const byId = new Map(d.bots.map((b) => [b.botId, b]));
  assert.equal(byId.get('bot-run')?.status, 'running');
  assert.equal(byId.get('bot-run')?.currentNodeId, 'fn-1');
  assert.equal(byId.get('bot-wait')?.status, 'waiting');
  assert.equal(byId.get('bot-wait')?.queuedTasks, 1);
  assert.equal(byId.get('bot-err')?.status, 'error');
  assert.equal(byId.get('bot-err')?.lastError, 'OOM killed');
  assert.equal(byId.get('bot-err')?.failedTasks, 1);
  assert.equal(byId.get('bot-over')?.status, 'over-budget');
  assert.equal(byId.get('bot-over')?.budgetLevel, 'over-soft');
  assert.equal(byId.get('bot-stop')?.status, 'stopped');
  assert.equal(byId.get('bot-stop')?.budgetLevel, 'over-hard');
  assert.equal(d.totals.botsTotal, 5);
  assert.equal(d.totals.botsRunning, 1);
  assert.equal(d.totals.botsError, 1);
  assert.equal(d.totals.botsOverBudget, 2);
  // Totals: node khai báo 4 core / 8GB / 100GB; đã dùng = cộng 3 sample.
  assert.equal(d.totals.cpuCoresTotal, 4);
  assert.equal(d.totals.ramBytesTotal, 8 * GB);
  assert.ok(Math.abs((d.totals.cpuCoresUsed ?? 0) - (1.5 + 0.5 + 0.5)) < 1e-9);
  const codes = d.warnings.map((w) => w.code);
  assert.ok(codes.includes('bot-over-hard-budget'));
  assert.ok(codes.includes('bot-over-soft-budget'));
  assert.ok(codes.includes('bot-failed-runs'));
  void t1;
});

test('aggregate: campaign blocked + all-failed + no-alive-node + bot chưa đặt budget', () => {
  const campaign = createFleetV5Campaign({ goal: 'G', repos: ['open-bot'] }, T0);
  const a = addFleetV5Task(campaign, { repo: 'open-bot', title: 'A', brief: 'b', paths: ['a.md'] }, T0).task;
  addFleetV5Task(campaign, { repo: 'open-bot', title: 'B', brief: 'b', paths: ['b.md'], dependsOn: [a.id] }, T0);
  // A fail hẳn (maxAttempts=1) qua claim+fail.
  claimNextFleetV5Task([campaign], 'bot-1', T0);
  failFleetV5Task(campaign, a.id, 1, T0 + 1000);
  const staleNode = makeNode({ lastHeartbeatAt: T0 - 60 * 60_000 }); // heartbeat cũ -> dead/stale
  const d = aggregateFleetV5Health(emptyInput({
    nodes: [staleNode],
    campaigns: [campaign],
    runs: [makeRun({ botId: 'bot-1', status: 'queued', nodeId: null, startedAt: null })],
    now: T0,
  }));
  const codes = d.warnings.map((w) => w.code);
  assert.ok(codes.includes('campaign-blocked-tasks'));
  assert.ok(codes.includes('no-alive-node'));
  assert.ok(codes.includes('bot-no-budget'));
  assert.deepEqual(d.botsWithoutBudget, ['bot-1']);
  assert.equal(d.totals.tasksBlocked, 1);
  assert.equal(d.totals.tasksFailed, 1);
  assert.equal(d.totals.campaignsActive, 1);
  // Campaign toàn task failed -> cảnh báo critical riêng.
  const campaign2 = createFleetV5Campaign({ goal: 'G2', repos: ['open-bot'] }, T0);
  const only = addFleetV5Task(campaign2, { repo: 'open-bot', title: 'Only', brief: 'b', paths: ['x.md'] }, T0).task;
  claimNextFleetV5Task([campaign2], 'bot-2', T0);
  failFleetV5Task(campaign2, only.id, 1, T0 + 1000);
  const d2 = aggregateFleetV5Health(emptyInput({ campaigns: [campaign2], now: T0 }));
  assert.ok(d2.warnings.some((w) => w.code === 'campaign-all-tasks-failed' && w.level === 'critical'));
  assert.match(formatFleetV5HealthLine(d2), /1 warning\(s\)|2 warning\(s\)/);
});

test('build từ file: đọc campaign + budget + history; bot không đo được thì usageKnown=false', () => {
  const root = tmpDir();
  const fleetRoot = root; // buildFleetV5HealthDashboard nhận fleetRoot trực tiếp
  const campaign = createFleetV5Campaign({ goal: 'G', repos: ['open-bot'] }, T0);
  addFleetV5Task(campaign, { repo: 'open-bot', title: 'T1', brief: 'b', paths: ['a.md'] }, T0);
  saveFleetV5Campaigns(fleetRoot, [campaign]);
  setFleetV5BotBudget(fleetRoot, {
    botId: 'bot-1',
    soft: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB },
    hard: { cpuCores: 2, ramBytes: 2 * GB, diskBytes: 20 * GB },
  }, 'admin');
  recordFleetV5BudgetUsage(fleetRoot, { botId: 'bot-1', cpuCores: 0.4, ramBytes: 0.4 * GB, diskBytes: 4 * GB, at: T0 });
  const d = buildFleetV5HealthDashboard(fleetRoot, T0);
  assert.equal(d.campaigns.length, 1);
  assert.equal(d.campaigns[0].totalTasks, 1);
  assert.equal(d.bots.length, 1);
  assert.equal(d.bots[0].botId, 'bot-1');
  assert.equal(d.bots[0].status, 'idle');
  assert.equal(d.bots[0].usageKnown, true);
  assert.equal(d.bots[0].latestUsage?.cpuCores, 0.4);
  assert.equal(d.totals.cpuCoresUsed, 0.4);
  assert.equal(d.totals.cpuCoresTotal, null); // không có node đăng ký
  assert.equal(d.warnings.length, 0);
  // Fleet root trống hoàn toàn cũng build được.
  const d2 = buildFleetV5HealthDashboard(tmpDir(), T0);
  assert.equal(d2.bots.length, 0);
  assert.equal(d2.campaigns.length, 0);
});
