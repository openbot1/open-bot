/**
 * Fleet health dashboard v5 (v1.08, Đội T6).
 *
 * Một cái nhìn duy nhất cho UI: trạng thái từng bot/agent trong fleet
 * (đang chạy / chờ / lỗi / idle / vượt budget / đã dừng), tài nguyên
 * đã dùng so với tổng (cộng dồn từ node đã khai báo), campaign đang
 * chạy, và danh sách cảnh báo.
 *
 * Nguồn dữ liệu ghép từ các module đã có — không phát minh số:
 * - bot run: `fleet/botScheduling.ts` (queued/scheduled/running/done/failed);
 * - node: `fleet/nodes.ts` (khai báo CPU/RAM/đĩa + heartbeat/liveness);
 * - campaign: `fleet/fleetV5Campaign.ts` (task theo trạng thái);
 * - budget: `fleet/fleetV5Budget.ts` (soft/hard + lịch sử tiêu thụ).
 * Số nào không đo được thì báo `null` / `usageKnown: false`, không
 * đoán là 0.
 *
 * `aggregateFleetV5Health` là hàm thuần (nhận dữ liệu đã load — dễ
 * test, dễ dùng cho UI mock); `buildFleetV5HealthDashboard` là wrapper
 * đọc file từ fleetRoot.
 */

import { loadBotRuns, type BotRun } from './botScheduling';
import {
  loadFleetV5BudgetHistory,
  loadFleetV5Budgets,
  type FleetV5BotBudget,
  type FleetV5BudgetLevel,
  type FleetV5UsageSample,
} from './fleetV5Budget';
import {
  loadFleetV5Campaigns,
  summarizeFleetV5Campaign,
  type FleetV5Campaign,
  type FleetV5CampaignSummary,
} from './fleetV5Campaign';
import { loadFleetNodes, nodeLiveness, type FleetNode } from './nodes';

export type FleetV5BotHealthStatus = 'running' | 'waiting' | 'error' | 'idle' | 'over-budget' | 'stopped';

export interface FleetV5BotHealth {
  botId: string;
  status: FleetV5BotHealthStatus;
  activeTasks: number;
  queuedTasks: number;
  failedTasks: number;
  doneTasks: number;
  /** Node bot đang chạy trên (null khi không chạy đâu). */
  currentNodeId: string | null;
  /** Mức budget nghiêm trọng nhất (null khi bot chưa đặt budget). */
  budgetLevel: FleetV5BudgetLevel | null;
  /** Sample tiêu thụ mới nhất (null khi chưa đo được). */
  latestUsage: FleetV5UsageSample | null;
  usageKnown: boolean;
  /** Lỗi cuối cùng (khi run/task mới nhất fail). */
  lastError?: string;
}

export interface FleetV5HealthWarning {
  level: 'warning' | 'critical';
  code:
    | 'bot-over-hard-budget'
    | 'bot-over-soft-budget'
    | 'bot-failed-runs'
    | 'campaign-blocked-tasks'
    | 'campaign-all-tasks-failed'
    | 'no-alive-node'
    | 'bot-no-budget';
  message: string;
  botId?: string;
  campaignId?: string;
  nodeId?: string;
}

export interface FleetV5HealthTotals {
  cpuCoresUsed: number | null;
  cpuCoresTotal: number | null;
  ramBytesUsed: number | null;
  ramBytesTotal: number | null;
  diskBytesUsed: number | null;
  diskBytesTotal: number | null;
  botsTotal: number;
  botsRunning: number;
  botsWaiting: number;
  botsError: number;
  botsOverBudget: number;
  botsIdle: number;
  campaignsActive: number;
  campaignsTotal: number;
  tasksQueued: number;
  tasksRunning: number;
  tasksAssigned: number;
  tasksDone: number;
  tasksFailed: number;
  tasksBlocked: number;
}

export interface FleetV5HealthDashboard {
  at: number;
  bots: FleetV5BotHealth[];
  campaigns: FleetV5CampaignSummary[];
  totals: FleetV5HealthTotals;
  warnings: FleetV5HealthWarning[];
  /** Bot nào chưa đặt budget v2 (dashboard nhắc, không chặn). */
  botsWithoutBudget: string[];
}

export interface FleetV5HealthInput {
  runs: BotRun[];
  nodes: FleetNode[];
  campaigns: FleetV5Campaign[];
  budgets: FleetV5BotBudget[];
  /** Sample mới nhất theo bot (bot không có sample = chưa đo được). */
  latestUsageByBot: Map<string, FleetV5UsageSample>;
  /** Lịch sử sample theo bot (để tính budget level từ sample mới nhất). */
  now?: number;
}

/** Mức budget của một bot từ sample mới nhất (null khi chưa đặt budget). */
export function fleetV5BotBudgetLevel(
  budget: FleetV5BotBudget | undefined,
  latest: FleetV5UsageSample | undefined,
): FleetV5BudgetLevel | null {
  if (budget === undefined || !budget.enabled || latest === undefined) return null;
  let worst: FleetV5BudgetLevel = 'ok';
  const order: FleetV5BudgetLevel[] = ['ok', 'approaching-soft', 'over-soft', 'over-hard'];
  for (const resource of ['cpuCores', 'ramBytes', 'diskBytes'] as const) {
    const used = latest[resource];
    let level: FleetV5BudgetLevel = 'ok';
    if (used >= budget.hard[resource]) level = 'over-hard';
    else if (used >= budget.soft[resource]) level = 'over-soft';
    else if (used >= budget.soft[resource] * budget.preSoftWarnPercent) level = 'approaching-soft';
    if (order.indexOf(level) > order.indexOf(worst)) worst = level;
  }
  return worst;
}

function botStatusFromSignals(input: {
  running: number;
  assigned: number;
  queued: number;
  failed: number;
  budgetLevel: FleetV5BudgetLevel | null;
}): FleetV5BotHealthStatus {
  if (input.budgetLevel === 'over-hard') return 'stopped';
  if (input.failed > 0 && input.running === 0 && input.assigned === 0) return 'error';
  if (input.budgetLevel === 'over-soft') return 'over-budget';
  if (input.running > 0 || input.assigned > 0) return 'running';
  if (input.queued > 0) return 'waiting';
  if (input.failed > 0) return 'error';
  return 'idle';
}

/**
 * Ghép dữ liệu đã load thành dashboard (thuần — không đọc file).
 * Bot = hợp của bot có run + bot có budget + bot được gán task trong
 * campaign + bot có sample tiêu thụ.
 */
export function aggregateFleetV5Health(input: FleetV5HealthInput): FleetV5HealthDashboard {
  const now = input.now ?? Date.now();
  const botIds = new Set<string>();
  for (const run of input.runs) botIds.add(run.botId);
  for (const budget of input.budgets) botIds.add(budget.botId);
  for (const campaign of input.campaigns) {
    for (const task of campaign.tasks) {
      if (task.assignedBotId !== null) botIds.add(task.assignedBotId);
    }
  }
  for (const botId of input.latestUsageByBot.keys()) botIds.add(botId);

  const budgetsByBot = new Map(input.budgets.map((b) => [b.botId, b]));
  const runsByBot = new Map<string, BotRun[]>();
  for (const run of input.runs) {
    const list = runsByBot.get(run.botId) ?? [];
    list.push(run);
    runsByBot.set(run.botId, list);
  }

  const bots: FleetV5BotHealth[] = [];
  for (const botId of [...botIds].sort()) {
    const runs = runsByBot.get(botId) ?? [];
    const latest = input.latestUsageByBot.get(botId);
    const budget = budgetsByBot.get(botId);
    const budgetLevel = fleetV5BotBudgetLevel(budget, latest);
    let activeTasks = 0;
    let queuedTasks = 0;
    let failedTasks = 0;
    let doneTasks = 0;
    let currentNodeId: string | null = null;
    for (const campaign of input.campaigns) {
      for (const task of campaign.tasks) {
        if (task.assignedBotId !== botId) continue;
        if (task.status === 'running' || task.status === 'assigned') activeTasks += 1;
        if (task.status === 'failed') failedTasks += 1;
        if (task.status === 'done') doneTasks += 1;
      }
    }
    let lastError: string | undefined;
    let latestFailedAt = 0;
    for (const run of runs) {
      if (run.status === 'running' || run.status === 'scheduled') {
        if (run.nodeId !== null) currentNodeId = run.nodeId;
      }
      if (run.status === 'queued') queuedTasks += 1;
      if (run.status === 'failed') {
        failedTasks += 1;
        if (run.createdAt >= latestFailedAt) {
          latestFailedAt = run.createdAt;
          lastError = run.lastError;
        }
      }
      if (run.status === 'done') doneTasks += 1;
    }
    const runningRuns = runs.filter((r) => r.status === 'running' || r.status === 'scheduled').length;
    const status = botStatusFromSignals({
      running: activeTasks + runningRuns,
      assigned: 0,
      queued: queuedTasks,
      failed: failedTasks,
      budgetLevel,
    });
    bots.push({
      botId,
      status,
      activeTasks: activeTasks + runningRuns,
      queuedTasks,
      failedTasks,
      doneTasks,
      currentNodeId,
      budgetLevel,
      latestUsage: latest ?? null,
      usageKnown: latest !== undefined,
      ...(lastError !== undefined ? { lastError } : {}),
    });
  }

  const campaignSummaries = input.campaigns.map(summarizeFleetV5Campaign);
  const totals: FleetV5HealthTotals = {
    cpuCoresUsed: null,
    cpuCoresTotal: null,
    ramBytesUsed: null,
    ramBytesTotal: null,
    diskBytesUsed: null,
    diskBytesTotal: null,
    botsTotal: bots.length,
    botsRunning: bots.filter((b) => b.status === 'running').length,
    botsWaiting: bots.filter((b) => b.status === 'waiting').length,
    botsError: bots.filter((b) => b.status === 'error').length,
    botsOverBudget: bots.filter((b) => b.status === 'over-budget' || b.status === 'stopped').length,
    botsIdle: bots.filter((b) => b.status === 'idle').length,
    campaignsActive: input.campaigns.filter((c) => c.status === 'active').length,
    campaignsTotal: input.campaigns.length,
    tasksQueued: campaignSummaries.reduce((a, s) => a + s.queued, 0),
    tasksRunning: campaignSummaries.reduce((a, s) => a + s.running, 0),
    tasksAssigned: campaignSummaries.reduce((a, s) => a + s.assigned, 0),
    tasksDone: campaignSummaries.reduce((a, s) => a + s.done, 0),
    tasksFailed: campaignSummaries.reduce((a, s) => a + s.failed, 0),
    tasksBlocked: campaignSummaries.reduce((a, s) => a + s.blocked, 0),
  };

  // Tổng tài nguyên: cộng dồn khai báo của node; đã dùng = cộng dồn
  // sample mới nhất của các bot (bot chưa đo được thì không cộng — và
  // totals.*Used là null khi KHÔNG bot nào đo được, để UI không hiển
  // thị 0 giả).
  if (input.nodes.length > 0) {
    totals.cpuCoresTotal = input.nodes.reduce((a, n) => a + n.cpuCores, 0);
    totals.ramBytesTotal = input.nodes.reduce((a, n) => a + n.ramBytes, 0);
    totals.diskBytesTotal = input.nodes.reduce((a, n) => a + n.diskBytes, 0);
  }
  const knownUsages = [...input.latestUsageByBot.values()];
  if (knownUsages.length > 0) {
    totals.cpuCoresUsed = knownUsages.reduce((a, s) => a + s.cpuCores, 0);
    totals.ramBytesUsed = knownUsages.reduce((a, s) => a + s.ramBytes, 0);
    totals.diskBytesUsed = knownUsages.reduce((a, s) => a + s.diskBytes, 0);
  }

  const warnings: FleetV5HealthWarning[] = [];
  const aliveNodes = input.nodes.filter((n) => nodeLiveness(n, now) === 'alive').length;
  if (input.nodes.length > 0 && aliveNodes === 0) {
    warnings.push({
      level: 'critical',
      code: 'no-alive-node',
      message: `Không có node nào alive trong fleet (${input.nodes.length} node đã đăng ký) — bot run không schedule được.`,
    });
  }
  for (const bot of bots) {
    if (bot.budgetLevel === 'over-hard') {
      warnings.push({
        level: 'critical',
        code: 'bot-over-hard-budget',
        message: `Bot "${bot.botId}" vượt giới hạn cứng budget v2 — bot phải tự dừng.`,
        botId: bot.botId,
      });
    } else if (bot.budgetLevel === 'over-soft') {
      warnings.push({
        level: 'warning',
        code: 'bot-over-soft-budget',
        message: `Bot "${bot.botId}" vượt giới hạn mềm budget v2 — throttle + chặn nhận task mới.`,
        botId: bot.botId,
      });
    }
    if (bot.failedTasks > 0 && bot.status === 'error') {
      warnings.push({
        level: 'warning',
        code: 'bot-failed-runs',
        message: `Bot "${bot.botId}" có ${bot.failedTasks} run/task failed và hiện không chạy gì.`,
        botId: bot.botId,
      });
    }
  }
  for (const campaign of input.campaigns) {
    const summary = summarizeFleetV5Campaign(campaign);
    if (summary.blocked > 0) {
      warnings.push({
        level: 'warning',
        code: 'campaign-blocked-tasks',
        message: `Campaign "${campaign.id}" có ${summary.blocked} task blocked (dependsOn failed/cancelled).`,
        campaignId: campaign.id,
      });
    }
    if (summary.totalTasks > 0 && summary.failed === summary.totalTasks) {
      warnings.push({
        level: 'critical',
        code: 'campaign-all-tasks-failed',
        message: `Campaign "${campaign.id}": tất cả ${summary.totalTasks} task đều failed.`,
        campaignId: campaign.id,
      });
    }
  }
  const botsWithoutBudget = bots
    .filter((b) => budgetsByBot.get(b.botId) === undefined && (b.activeTasks > 0 || b.queuedTasks > 0))
    .map((b) => b.botId);
  if (botsWithoutBudget.length > 0) {
    warnings.push({
      level: 'warning',
      code: 'bot-no-budget',
      message: `${botsWithoutBudget.length} bot đang chạy/chờ mà chưa đặt budget v2: ${botsWithoutBudget.join(', ')} — nên đặt giới hạn để tránh chiếm hết tài nguyên.`,
    });
  }

  return { at: now, bots, campaigns: campaignSummaries, totals, warnings, botsWithoutBudget };
}

/**
 * Build dashboard đầy đủ từ fleetRoot (chỉ đọc — không ghi file nào).
 * Bot run đọc từ botScheduling, node từ nodes, campaign/budget/history
 * từ file v108. Bot không có run/budget/task/sample thì không xuất
 * hiện — dashboard chỉ báo những gì fleet thật sự có.
 */
export function buildFleetV5HealthDashboard(fleetRoot: string, now = Date.now()): FleetV5HealthDashboard {
  const runs = loadBotRuns(fleetRoot);
  const nodes = loadFleetNodes(fleetRoot);
  const campaigns = loadFleetV5Campaigns(fleetRoot);
  const budgets = loadFleetV5Budgets(fleetRoot);
  const latestUsageByBot = new Map<string, FleetV5UsageSample>();
  const botIds = new Set<string>([
    ...runs.map((r) => r.botId),
    ...budgets.map((b) => b.botId),
  ]);
  for (const campaign of campaigns) {
    for (const task of campaign.tasks) {
      if (task.assignedBotId !== null) botIds.add(task.assignedBotId);
    }
  }
  for (const botId of botIds) {
    const history = loadFleetV5BudgetHistory(fleetRoot, botId);
    if (history.length > 0) latestUsageByBot.set(botId, history[history.length - 1]);
  }
  return aggregateFleetV5Health({ runs, nodes, campaigns, budgets, latestUsageByBot, now });
}

/** Tóm tắt một dòng dashboard (để CLI/tool in nhanh). */
export function formatFleetV5HealthLine(dashboard: FleetV5HealthDashboard): string {
  const t = dashboard.totals;
  const cpu =
    t.cpuCoresUsed !== null && t.cpuCoresTotal !== null
      ? `CPU ${t.cpuCoresUsed.toFixed(2)}/${t.cpuCoresTotal} cores`
      : 'CPU chưa đo được';
  const ram =
    t.ramBytesUsed !== null && t.ramBytesTotal !== null
      ? `RAM ${Math.round(t.ramBytesUsed / 1024 / 1024)}MB/${Math.round(t.ramBytesTotal / 1024 / 1024)}MB`
      : 'RAM chưa đo được';
  const parts = [
    `bots ${t.botsRunning} running, ${t.botsWaiting} waiting, ${t.botsError} error, ${t.botsIdle} idle`,
    cpu,
    ram,
    `campaigns ${t.campaignsActive}/${t.campaignsTotal} active`,
    `tasks queued=${t.tasksQueued} running=${t.tasksRunning} done=${t.tasksDone} failed=${t.tasksFailed}`,
  ];
  const warnings = dashboard.warnings.length > 0 ? ` — ${dashboard.warnings.length} warning(s)` : '';
  return `${parts.join(', ')}${warnings}`;
}
