/**
 * Fleet v5 tools (v1.08, Đội T6) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * - `fleet_v5_campaign_create` — tạo campaign (1 mục tiêu lớn → nhiều
 *   task trên nhiều repo), kèm task ban đầu; lưu vào
 *   `<userData>/fleet/fleet-campaigns-v108.json`.
 * - `fleet_v5_campaign_status` — trạng thái campaign (một campaign
 *   theo id hoặc tất cả): đếm task theo trạng thái, tiến độ %,
 *   dedup đã gộp, task blocked.
 * - `fleet_v5_campaign_task_add` — thêm task vào campaign; task trùng
 *   (cùng repo + title + paths) thì dedup — trả về task đã có, không
 *   tạo trùng.
 * - `fleet_v5_campaign_task_claim` — bot claim task tiếp theo theo
 *   hàng đợi ưu tiên (aging, dependsOn đã xong, không xung đột file
 *   với task đang chạy).
 * - `fleet_v5_campaign_task_complete` — hoàn thành / fail một task
 *   (fail còn lượt thì requeue, hết lượt thì failed hẳn) hoặc start
 *   task (assigned → running).
 * - `fleet_v5_budget_set` — đặt budget v2 cho một bot: soft + hard
 *   cho CPU/RAM/đĩa + ngưỡng cảnh báo sớm trước soft.
 * - `fleet_v5_budget_check` — ghi một sample tiêu thụ của bot rồi
 *   đánh giá với budget: mức từng tài nguyên, action
 *   (none/warn/throttle/stop), bot có nên dừng / bị chặn task mới.
 * - `fleet_v5_budget_history` — lịch sử tiêu thụ của bot: peak/avg/
 *   trend từng tài nguyên, số lần vượt soft/hard, sample gần nhất.
 * - `fleet_v5_health_dashboard` — dashboard sức khoẻ fleet: trạng
 *   thái từng bot, tài nguyên đã dùng/tổng, campaign đang chạy,
 *   warnings.
 * - `fleet_v5_conflict_scan` — quét xung đột giữa các task từ danh
 *   sách file (path + content) do caller cung cấp: dựng đồ thị import
 *   rồi báo cùng file / chồng path / thứ tự phụ thuộc. Thuần — chạy
 *   được cả khi chưa bind.
 *
 * Như các tool fleet trước, đây là placeholder trong ALL_TOOLS cho
 * tới khi host bind: `createFleetV5Tools(getBaseDir)` với userData
 * dir của app. Tool ghi file cần approval; tool chỉ đọc / tính toán
 * thì không.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  FLEET_V5_CAMPAIGNS_FILE,
  addFleetV5Task,
  analyzeImportGraph,
  blockedFleetV5Tasks,
  buildFleetV5HealthDashboard,
  claimNextFleetV5Task,
  completeFleetV5Task,
  createFleetV5Campaign,
  evaluateFleetV5BotBudget,
  failFleetV5Task,
  findCampaignConflicts,
  findFleetV5Campaign,
  findFleetV5Task,
  formatFleetV5HealthLine,
  getFleetV5BotBudget,
  loadFleetV5BudgetHistory,
  loadFleetV5Campaigns,
  recordFleetV5BudgetUsage,
  saveFleetV5Campaigns,
  setFleetV5BotBudget,
  setFleetV5CampaignStatus,
  startFleetV5Task,
  summarizeFleetV5BudgetHistoryFromFile,
  summarizeFleetV5Campaign,
  validateFleetV5UsageSample,
  type CreateFleetV5TaskInput,
  type DependencySweepFile,
  type FleetV5BudgetResource,
  type FleetV5Campaign,
  type FleetV5Priority,
  type FleetV5ResourceLimits,
  type FleetV5Task,
} from '@open-bot/core';

export const FLEET_V5_TOOL_NAMES = [
  'fleet_v5_campaign_create',
  'fleet_v5_campaign_status',
  'fleet_v5_campaign_task_add',
  'fleet_v5_campaign_task_claim',
  'fleet_v5_campaign_task_complete',
  'fleet_v5_budget_set',
  'fleet_v5_budget_check',
  'fleet_v5_budget_history',
  'fleet_v5_health_dashboard',
  'fleet_v5_conflict_scan',
] as const;

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string, required = false): string[] {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

function getObjectArrayArg(args: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    throw new Error(`Argument "${name}" must be an array of objects.`);
  }
  return value as Record<string, unknown>[];
}

const NOT_WIRED =
  'fleet v5 tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

/** Fleet root derived from the app userData dir. */
function dirs(baseDir: string): { fleetRoot: string } {
  return { fleetRoot: path.join(baseDir, 'fleet') };
}

const FLEET_V5_PRIORITIES: FleetV5Priority[] = ['critical', 'high', 'medium', 'low'];

function parsePriority(value: unknown, fallback: FleetV5Priority = 'medium'): FleetV5Priority {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !(FLEET_V5_PRIORITIES as string[]).includes(value)) {
    throw new Error(`priority phải là một trong: ${FLEET_V5_PRIORITIES.join(', ')}.`);
  }
  return value as FleetV5Priority;
}

function parseTaskInput(obj: Record<string, unknown>, i: number): CreateFleetV5TaskInput {
  const repo = obj['repo'];
  const title = obj['title'];
  const brief = obj['brief'];
  if (typeof repo !== 'string' || repo.trim().length === 0) throw new Error(`tasks[${i}] cần repo không rỗng.`);
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error(`tasks[${i}] cần title không rỗng.`);
  if (typeof brief !== 'string' || brief.trim().length === 0) throw new Error(`tasks[${i}] cần brief không rỗng.`);
  const paths = obj['paths'];
  if (paths !== undefined && (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string'))) {
    throw new Error(`tasks[${i}] paths phải là mảng chuỗi.`);
  }
  const dependsOn = obj['dependsOn'];
  if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string'))) {
    throw new Error(`tasks[${i}] dependsOn phải là mảng chuỗi.`);
  }
  return {
    repo: (repo as string).trim(),
    title: (title as string).trim(),
    brief: (brief as string).trim(),
    priority: parsePriority(obj['priority']),
    paths: (paths as string[] | undefined) ?? [],
    dependsOn: (dependsOn as string[] | undefined) ?? [],
  };
}

function parseLimits(obj: Record<string, unknown>, name: string): FleetV5ResourceLimits {
  const cpu = obj['cpuCores'];
  const ram = obj['ramBytes'];
  const disk = obj['diskBytes'];
  if (typeof cpu !== 'number' || !Number.isFinite(cpu) || cpu <= 0) {
    throw new Error(`${name}.cpuCores phải là số > 0.`);
  }
  if (typeof ram !== 'number' || !Number.isFinite(ram) || ram <= 0) {
    throw new Error(`${name}.ramBytes phải là số > 0.`);
  }
  if (typeof disk !== 'number' || !Number.isFinite(disk) || disk <= 0) {
    throw new Error(`${name}.diskBytes phải là số > 0.`);
  }
  return { cpuCores: cpu, ramBytes: ram, diskBytes: disk };
}

function parseLimitsArg(args: Record<string, unknown>, name: string): FleetV5ResourceLimits {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object { cpuCores, ramBytes, diskBytes }.`);
  }
  return parseLimits(value as Record<string, unknown>, name);
}

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Repo the task works on (e.g. "open-bot").' },
    title: { type: 'string', description: 'Short task title (used for dedup together with repo + paths).' },
    brief: { type: 'string', description: 'What the bot must do (no secrets).' },
    priority: { type: 'string', enum: [...FLEET_V5_PRIORITIES], description: 'Task priority (default medium).' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Paths (files/dirs, relative to repo root) the task touches — used by the conflict guard.' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks in the same campaign that must finish first.' },
  },
  required: ['repo', 'title', 'brief'],
  additionalProperties: false,
};

const LIMITS_SCHEMA = {
  type: 'object',
  properties: {
    cpuCores: { type: 'number', description: 'Max CPU cores (> 0).' },
    ramBytes: { type: 'number', description: 'Max RAM in bytes (> 0).' },
    diskBytes: { type: 'number', description: 'Max disk in bytes (> 0).' },
  },
  required: ['cpuCores', 'ramBytes', 'diskBytes'],
  additionalProperties: false,
};

/**
 * Build the 10 fleet v5 tools. `getBaseDir` resolves the app userData
 * dir (null/undefined = unbound placeholders that explain themselves
 * instead of guessing paths). `fleet_v5_conflict_scan` is pure
 * computation and runs even unbound — it touches no files.
 */
export function createFleetV5Tools(
  getBaseDir?: () => string | null | undefined,
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const findCampaignOrError = (campaigns: FleetV5Campaign[], campaignId: string): FleetV5Campaign => {
    const campaign = findFleetV5Campaign(campaigns, campaignId);
    if (!campaign) throw new Error(`Không có campaign "${campaignId}".`);
    return campaign;
  };

  const campaignCreateTool: Tool = {
    definition: toolDef(
      'fleet_v5_campaign_create',
      'Create a fleet campaign: one big goal split into tasks across many repos, each with priority + paths + dependencies. Duplicate tasks (same repo + title + paths) are merged by dedup instead of created twice. Saved to <userData>/fleet/fleet-campaigns-v108.json.',
      {
        goal: { type: 'string', description: 'The big goal of the campaign.' },
        repos: { type: 'array', items: { type: 'string' }, description: 'Repos the campaign works on (at least 1).' },
        tasks: { type: 'array', items: TASK_SCHEMA, description: 'Optional: initial tasks (dedup applies).' },
      },
      ['goal', 'repos'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaigns = loadFleetV5Campaigns(fleetRoot);
        const tasks = getObjectArrayArg(args, 'tasks').map((t, i) => parseTaskInput(t, i));
        const campaign = createFleetV5Campaign({
          goal: getStringArg(args, 'goal'),
          repos: getStringArrayArg(args, 'repos', true),
          tasks,
        });
        saveFleetV5Campaigns(fleetRoot, [...campaigns, campaign]);
        return JSON.stringify(
          { campaign: summarizeFleetV5Campaign(campaign), file: FLEET_V5_CAMPAIGNS_FILE },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const campaignStatusTool: Tool = {
    definition: toolDef(
      'fleet_v5_campaign_status',
      'Fleet campaign status: list all campaigns (id, goal, task counts, progress %, dedup merged) or one campaign by id with full task list + blocked tasks. Read-only, local only. Also changes campaign status with action=set-status (active/paused/done/cancelled).',
      {
        campaignId: { type: 'string', description: 'Optional: only show this campaign.' },
        action: { type: 'string', enum: ['status', 'set-status'], description: 'status (read-only, default) or set-status (needs newStatus).' },
        newStatus: { type: 'string', enum: ['active', 'paused', 'done', 'cancelled'], description: 'New status for action=set-status.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const action = getStringArg(args, 'action', false) || 'status';
        if (action !== 'status' && action !== 'set-status') {
          return errorResult('action must be one of: status, set-status.');
        }
        const campaigns = loadFleetV5Campaigns(fleetRoot);
        if (action === 'set-status') {
          const campaignId = getStringArg(args, 'campaignId');
          const campaign = findFleetV5Campaign(campaigns, campaignId);
          if (!campaign) return errorResult(`Không có campaign "${campaignId}".`);
          const newStatus = getStringArg(args, 'newStatus');
          if (!['active', 'paused', 'done', 'cancelled'].includes(newStatus)) {
            return errorResult('newStatus phải là một trong: active, paused, done, cancelled.');
          }
          setFleetV5CampaignStatus(campaign, newStatus as FleetV5Campaign['status']);
          saveFleetV5Campaigns(fleetRoot, campaigns);
          return JSON.stringify({ campaign: summarizeFleetV5Campaign(campaign) }, null, 2);
        }
        const campaignId = getStringArg(args, 'campaignId', false);
        if (campaignId) {
          const campaign = findFleetV5Campaign(campaigns, campaignId);
          if (!campaign) return errorResult(`Không có campaign "${campaignId}".`);
          return JSON.stringify(
            {
              campaign: summarizeFleetV5Campaign(campaign),
              tasks: campaign.tasks,
              blocked: blockedFleetV5Tasks(campaign).map((t) => ({ id: t.id, title: t.title, dependsOn: t.dependsOn })),
            },
            null,
            2,
          ).slice(0, 20000);
        }
        return JSON.stringify(
          { count: campaigns.length, campaigns: campaigns.map(summarizeFleetV5Campaign) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskAddTool: Tool = {
    definition: toolDef(
      'fleet_v5_campaign_task_add',
      'Add a task to a campaign. Dedup: a task with the same repo + title + paths as an existing non-cancelled task is NOT created — the existing task is returned and the campaign dedupMerged counter grows.',
      {
        campaignId: { type: 'string', description: 'Campaign id.' },
        repo: { type: 'string', description: 'Repo the task works on.' },
        title: { type: 'string', description: 'Short task title (dedup key together with repo + paths).' },
        brief: { type: 'string', description: 'What the bot must do (no secrets).' },
        priority: { type: 'string', enum: [...FLEET_V5_PRIORITIES], description: 'Task priority (default medium).' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Paths the task touches (conflict guard).' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks in the same campaign that must finish first.' },
      },
      ['campaignId', 'repo', 'title', 'brief'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaigns = loadFleetV5Campaigns(fleetRoot);
        const campaignId = getStringArg(args, 'campaignId');
        const campaign = findCampaignOrError(campaigns, campaignId);
        const { task, deduplicated, existingTaskId } = addFleetV5Task(campaign, parseTaskInput(args, 0));
        saveFleetV5Campaigns(fleetRoot, campaigns);
        return JSON.stringify(
          {
            deduplicated,
            ...(deduplicated ? { existingTaskId } : {}),
            task: { id: task.id, title: task.title, repo: task.repo, priority: task.priority, status: task.status, paths: task.paths, dependsOn: task.dependsOn },
            dedupMerged: campaign.dedupMerged,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskClaimTool: Tool = {
    definition: toolDef(
      'fleet_v5_campaign_task_claim',
      'A bot claims its next campaign task from the priority queue: highest priority first (waiting tasks gain aging points), dependencies must be done, and tasks conflicting on files with a running task are skipped. Claims across all active campaigns (or one campaign).',
      {
        botId: { type: 'string', description: 'Bot claiming the task.' },
        campaignId: { type: 'string', description: 'Optional: only claim from this campaign.' },
        maxActivePerBot: { type: 'number', description: 'Optional: max active tasks the bot may hold (default 1).' },
      },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaigns = loadFleetV5Campaigns(fleetRoot);
        const botId = getStringArg(args, 'botId');
        const campaignId = getStringArg(args, 'campaignId', false) || undefined;
        const maxActive = getNumberArg(args, 'maxActivePerBot', 1);
        if (maxActive < 1 || !Number.isInteger(maxActive)) {
          return errorResult('maxActivePerBot must be an integer >= 1.');
        }
        const result = claimNextFleetV5Task(campaigns, botId, Date.now(), {
          maxActivePerBot: maxActive,
          ...(campaignId !== undefined ? { campaignId } : {}),
        });
        if (result.task === null) {
          return JSON.stringify({ claimed: false, reason: result.reason, skipped: result.skipped }, null, 2);
        }
        saveFleetV5Campaigns(fleetRoot, campaigns);
        const task: FleetV5Task = result.task;
        return JSON.stringify(
          {
            claimed: true,
            skipped: result.skipped,
            task: { id: task.id, campaignId: task.campaignId, repo: task.repo, title: task.title, brief: task.brief, priority: task.priority, paths: task.paths, dependsOn: task.dependsOn },
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskCompleteTool: Tool = {
    definition: toolDef(
      'fleet_v5_campaign_task_complete',
      'Finish a campaign task: done (task completed), failed (attempts +1 — requeued while attempts remain, failed permanently after maxAttempts), or start (assigned → running).',
      {
        campaignId: { type: 'string', description: 'Campaign id.' },
        taskId: { type: 'string', description: 'Task id.' },
        outcome: { type: 'string', enum: ['done', 'failed', 'start'], description: 'done, failed, or start.' },
        note: { type: 'string', description: 'Optional: note recorded in the task history.' },
        maxAttempts: { type: 'number', description: 'Optional: max fail attempts before permanent failure (default 3, only for outcome=failed).' },
      },
      ['campaignId', 'taskId', 'outcome'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const campaigns = loadFleetV5Campaigns(fleetRoot);
        const campaign = findCampaignOrError(campaigns, getStringArg(args, 'campaignId'));
        const taskId = getStringArg(args, 'taskId');
        const outcome = getStringArg(args, 'outcome');
        if (outcome !== 'done' && outcome !== 'failed' && outcome !== 'start') {
          return errorResult('outcome must be one of: done, failed, start.');
        }
        const note = getStringArg(args, 'note', false) || undefined;
        let task: FleetV5Task;
        if (outcome === 'done') {
          task = completeFleetV5Task(campaign, taskId, Date.now(), note);
        } else if (outcome === 'failed') {
          const maxAttempts = getNumberArg(args, 'maxAttempts', 3);
          task = failFleetV5Task(campaign, taskId, maxAttempts, Date.now(), note);
        } else {
          task = startFleetV5Task(campaign, taskId, Date.now());
        }
        saveFleetV5Campaigns(fleetRoot, campaigns);
        return JSON.stringify(
          { task: { id: task.id, status: task.status, attempts: task.attempts, assignedBotId: task.assignedBotId }, campaign: summarizeFleetV5Campaign(campaign) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const budgetSetTool: Tool = {
    definition: toolDef(
      'fleet_v5_budget_set',
      'Set (or replace) the per-bot resource budget v2: soft limits + hard limits for CPU cores / RAM / disk, plus the early-warning threshold before the soft limit (default 80% of soft). Hard must be >= soft per resource.',
      {
        botId: { type: 'string', description: 'Bot id (fleet workspace id).' },
        soft: LIMITS_SCHEMA,
        hard: LIMITS_SCHEMA,
        preSoftWarnPercent: { type: 'number', description: 'Optional: early-warning at this fraction of soft (0 < x < 1, default 0.8).' },
        enabled: { type: 'boolean', description: 'Optional: disable the budget without deleting it (default true).' },
      },
      ['botId', 'soft', 'hard'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const botId = getStringArg(args, 'botId');
        const soft = parseLimitsArg(args, 'soft');
        const hard = parseLimitsArg(args, 'hard');
        const preSoft = getNumberArg(args, 'preSoftWarnPercent', 0.8);
        const enabled = getBooleanArg(args, 'enabled', true);
        const budget = setFleetV5BotBudget(
          fleetRoot,
          { botId, soft, hard, preSoftWarnPercent: preSoft, enabled },
          'fleet_v5_budget_set',
        );
        return JSON.stringify({ budget }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const budgetCheckTool: Tool = {
    definition: toolDef(
      'fleet_v5_budget_check',
      'Record one resource usage sample for a bot and evaluate it against its budget v2: per-resource level (ok / approaching-soft / over-soft / over-hard), the action the host should take (none / warn / throttle / stop), whether the bot must stop now (over hard) or be blocked from new tasks (over soft).',
      {
        botId: { type: 'string', description: 'Bot id.' },
        cpuCores: { type: 'number', description: 'CPU cores currently used (>= 0).' },
        ramBytes: { type: 'number', description: 'RAM bytes currently used (>= 0).' },
        diskBytes: { type: 'number', description: 'Disk bytes currently used (>= 0).' },
      },
      ['botId', 'cpuCores', 'ramBytes', 'diskBytes'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const sample = validateFleetV5UsageSample({
          botId: getStringArg(args, 'botId'),
          cpuCores: getNumberArg(args, 'cpuCores', -1),
          ramBytes: getNumberArg(args, 'ramBytes', -1),
          diskBytes: getNumberArg(args, 'diskBytes', -1),
          at: Date.now(),
        });
        const evaluation = recordFleetV5BudgetUsage(fleetRoot, sample);
        return JSON.stringify(evaluation, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const budgetHistoryTool: Tool = {
    definition: toolDef(
      'fleet_v5_budget_history',
      'Per-bot consumption history: sample count, peak/average/trend per resource, how many samples went over soft/hard, and the most recent samples. Read-only, local only.',
      {
        botId: { type: 'string', description: 'Bot id.' },
        limit: { type: 'number', description: 'Optional: how many recent samples to include (default 10, max 100).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const botId = getStringArg(args, 'botId');
        const limit = Math.min(100, Math.max(1, Math.floor(getNumberArg(args, 'limit', 10))));
        const summary = summarizeFleetV5BudgetHistoryFromFile(fleetRoot, botId);
        const samples = loadFleetV5BudgetHistory(fleetRoot, botId);
        const budget = getFleetV5BotBudget(fleetRoot, botId);
        const latest = samples.length > 0 ? samples[samples.length - 1] : null;
        const evaluation =
          latest !== null && budget !== undefined
            ? evaluateFleetV5BotBudget(budget, latest)
            : null;
        return JSON.stringify(
          {
            botId,
            budget: budget ?? null,
            summary,
            latestEvaluation: evaluation,
            recentSamples: samples.slice(-limit),
          },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthDashboardTool: Tool = {
    definition: toolDef(
      'fleet_v5_health_dashboard',
      'Fleet health dashboard v5: status of every bot/agent (running/waiting/error/idle/over-budget/stopped), resources used vs total, running campaigns, and warnings. Read-only, local only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const dashboard = buildFleetV5HealthDashboard(fleetRoot);
        return JSON.stringify(
          { line: formatFleetV5HealthLine(dashboard), dashboard },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const conflictScanTool: Tool = {
    definition: toolDef(
      'fleet_v5_conflict_scan',
      'Scan tasks for conflicts from a supplied file list (path + content): builds the import graph (dependency sweep) and reports same-file conflicts, path overlaps, and dependency-order constraints (task A imports a file task B owns, so B should finish first). Pure computation — runs even when the tools are not wired.',
      {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
          description: 'Source files to sweep: { path, content } (content is source text, never executed).',
        },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              repo: { type: 'string' },
              paths: { type: 'array', items: { type: 'string' } },
              status: { type: 'string' },
            },
            required: ['id', 'repo', 'paths'],
            additionalProperties: false,
          },
          description: 'Tasks to check: { id, repo, paths, status? } (status defaults to queued; done/cancelled tasks are ignored).',
        },
      },
      ['files', 'tasks'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const rawFiles = getObjectArrayArg(args, 'files');
        const files: DependencySweepFile[] = rawFiles.map((f, i) => {
          if (typeof f['path'] !== 'string' || f['path'].trim().length === 0) {
            throw new Error(`files[${i}] cần path không rỗng.`);
          }
          if (typeof f['content'] !== 'string') throw new Error(`files[${i}] cần content là chuỗi.`);
          return { path: (f['path'] as string).trim(), content: f['content'] as string };
        });
        const rawTasks = getObjectArrayArg(args, 'tasks');
        const tasks: FleetV5Task[] = rawTasks.map((t, i) => {
          if (typeof t['id'] !== 'string' || (t['id'] as string).trim().length === 0) {
            throw new Error(`tasks[${i}] cần id không rỗng.`);
          }
          if (typeof t['repo'] !== 'string' || (t['repo'] as string).trim().length === 0) {
            throw new Error(`tasks[${i}] cần repo không rỗng.`);
          }
          if (!Array.isArray(t['paths']) || t['paths'].some((p) => typeof p !== 'string')) {
            throw new Error(`tasks[${i}] paths phải là mảng chuỗi.`);
          }
          const status = typeof t['status'] === 'string' ? (t['status'] as string) : 'queued';
          const validStatuses = ['queued', 'assigned', 'running', 'done', 'failed', 'cancelled', 'blocked'];
          if (!validStatuses.includes(status)) throw new Error(`tasks[${i}] status không hợp lệ: "${status}".`);
          const now = Date.now();
          return {
            id: (t['id'] as string).trim(),
            campaignId: 'scan',
            repo: (t['repo'] as string).trim(),
            title: (t['id'] as string).trim(),
            brief: '',
            priority: 'medium',
            status: status as FleetV5Task['status'],
            paths: (t['paths'] as string[]).map((p) => p.trim()).filter((p) => p.length > 0),
            dependsOn: [],
            assignedBotId: null,
            attempts: 0,
            fingerprint: '',
            createdAt: now,
            updatedAt: now,
            history: [],
          };
        });
        const sweep = analyzeImportGraph(files);
        const conflicts = findCampaignConflicts(tasks, sweep);
        return JSON.stringify(
          {
            sweep: { files: sweep.files, edgeCount: sweep.edges.length, edges: sweep.edges, unresolved: sweep.unresolved },
            conflictCount: conflicts.length,
            conflicts,
          },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    campaignCreateTool,
    campaignStatusTool,
    taskAddTool,
    taskClaimTool,
    taskCompleteTool,
    budgetSetTool,
    budgetCheckTool,
    budgetHistoryTool,
    healthDashboardTool,
    conflictScanTool,
  ];
}

/**
 * Unbound placeholders, registered in ALL_TOOLS (see tools.ts).
 * The pure tool (conflict scan) executes even unbound; the nine
 * file-backed tools answer NOT_WIRED until the host binds a base dir.
 */
export const FLEET_V5_TOOLS: Tool[] = createFleetV5Tools();
