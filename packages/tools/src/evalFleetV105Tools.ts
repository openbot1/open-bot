/**
 * Eval v3 / fleet v4 tools (v1.05, Team T6) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * - `eval_v3_dataset` — liệt kê / xem chi tiết các dataset
 *   fixture có sẵn (read-only);
 * - `eval_v3_run_suite` — chạy bộ eval memory nội bộ (dataset fixture
 *   tự viết + mock embedding, offline 100%, không gọi API ngoài) và
 *   lưu báo cáo vào lịch sử; trả điểm tổng + theo loại câu hỏi +
 *   cảnh báo regression (nếu có);
 * - `eval_v3_report` — báo cáo eval mới nhất + lịch sử điểm;
 * - `eval_v3_compare` — so sánh hai lần chạy (baseline vs hiện tại)
 *   theo từng metric;
 * - `fleet_v4_schedule` — lập lịch một task cho bot phù hợp nhất
 *   (affinity / capability / load / quota token), ghi task vào hàng
 *   đợi ưu tiên của fleet (chỉ lập lịch, không chạy task);
 * - `fleet_v4_health` — health check + auto-restart (mock lifecycle)
 *   toàn fleet, kèm tóm tắt sức khỏe từng bot;
 * - `fleet_v4_policy_set` — xem / đặt chính sách phân bổ fleet v4
 *   (max bot đồng thời, quota token, ưu tiên, giới hạn restart);
 * - `fleet_v4_tasks` — quản lý hàng đợi task durable của fleet
 *   (list / submit / cancel, lưu file fleet-tasks-v4.json).
 *
 * Như fleet v3 tools, đây là placeholder trong ALL_TOOLS cho tới khi
 * host bind: `createEvalFleetV105Tools(getBaseDir)` với userData dir
 * của app (eval history `<userData>/eval-memory-history.json`,
 * fleet root `<userData>/fleet`). Chưa bind thì trả lời rõ "not
 * configured" thay vì đoán đường dẫn. Tool `eval_v3_run_suite` ghi
 * lịch sử thật khi đã bind; tool fleet chỉ đọc/ghi file policy +
 * lập lịch trong bộ nhớ của lần gọi (không spawn process thật —
 * auto-restart là mock, xem orchestration.ts).
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  BUILTIN_MEMORY_EVAL_DATASET,
  BUILTIN_MEMORY_EVAL_DATASETS,
  DEFAULT_FLEET_POLICY_V4,
  FleetManager,
  FleetOrchestrator,
  InMemoryMockRetriever,
  KeywordMockRetriever,
  checkMemoryEvalRegression,
  compareMemoryEvalReports,
  enforceFleetPolicy,
  getBuiltinMemoryEvalDataset,
  listMemoryEvalHistory,
  loadFleetPolicyV4,
  summarizeEvalHistory,
  runMemoryEvalSuite,
  runRetrieverBenchmark,
  saveFleetPolicyV4,
  validateEvalRunnerConfig,
  validateFleetPolicyV4,
} from '@open-bot/core';

export const EVAL_FLEET_V105_TOOL_NAMES = [
  'eval_v3_run_suite',
  'eval_v3_report',
  'eval_v3_compare',
  'eval_v3_dataset',
  'eval_v3_trend',
  'eval_v3_benchmark',
  'fleet_v4_schedule',
  'fleet_v4_health',
  'fleet_v4_policy_set',
  'fleet_v4_tasks',
  'fleet_v4_rebalance',
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

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

const NOT_WIRED =
  'eval v3 / fleet v4 tools are not wired in this host (no userData dir configured) — open the eval dashboard UI instead.';

/**
 * Build the 8 eval v3 / fleet v4 tools. `getBaseDir` resolves the
 * app userData dir (null/undefined = unbound placeholders).
 */
export function createEvalFleetV105Tools(getBaseDir?: () => string | null | undefined): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const runSuiteTool: Tool = {
    definition: toolDef(
      'eval_v3_run_suite',
      'Run the built-in offline memory eval suite (fictional fixture dataset + mock embedding, no external calls, no real keys) against the mock retriever and save the report to eval history. Returns overall + per-category recall/precision/F1, temporal accuracy, multi-hop score, judge score, and any regression alerts vs the previous run.',
      {
        retrieverVersion: { type: 'string', description: 'Label for the memory/retriever version being measured (e.g. "memory-v5.2").' },
        topK: { type: 'number', description: 'Facts retrieved per question (default 5).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const retriever = new InMemoryMockRetriever(BUILTIN_MEMORY_EVAL_DATASET.facts);
        const topK = getNumberArg(args, 'topK', 5);
        if (!Number.isInteger(topK) || topK <= 0) return errorResult('topK must be an integer > 0.');
        const config = validateEvalRunnerConfig({
          retrieverVersion: getStringArg(args, 'retrieverVersion', false) || 'mock-embedding-v1',
          topK,
        });
        const { report, alerts, comparison } = await runMemoryEvalSuite(
          base,
          BUILTIN_MEMORY_EVAL_DATASET,
          retriever,
          config,
        );
        return JSON.stringify(
          {
            dataset: report.datasetId,
            retrieverVersion: report.retrieverVersion,
            at: report.at,
            overall: report.overall,
            byCategory: report.byCategory,
            alerts,
            comparison,
          },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const reportTool: Tool = {
    definition: toolDef(
      'eval_v3_report',
      'Latest memory eval report + score history (overall F1/recall/temporal/multi-hop/judge per run). Read-only, local only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const history = listMemoryEvalHistory(base);
        const latest = history.length > 0 ? history[history.length - 1] : null;
        const alerts = checkMemoryEvalRegression(history);
        return JSON.stringify(
          {
            runs: history.length,
            latest: latest
              ? {
                  retrieverVersion: latest.retrieverVersion,
                  at: latest.at,
                  overall: latest.overall,
                  byCategory: latest.byCategory,
                }
              : null,
            history: history.map((r) => ({
              at: r.at,
              retrieverVersion: r.retrieverVersion,
              f1: r.overall.f1,
              recall: r.overall.recall,
              temporalAccuracy: r.overall.temporalAccuracy,
              multiHopScore: r.overall.multiHopScore,
              judgeScore: r.overall.judgeScore,
            })),
            regressionAlerts: alerts,
          },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const compareTool: Tool = {
    definition: toolDef(
      'eval_v3_compare',
      'Compare two eval runs from history (by index: 0 = oldest; negative = from the end, -1 = latest) and report per-metric deltas overall + per question category, and how many questions improved/worsened. Read-only, local only.',
      {
        baselineIndex: { type: 'number', description: 'Index of the baseline run in history (default -2, the run before the latest).' },
        currentIndex: { type: 'number', description: 'Index of the current run in history (default -1, the latest).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const history = listMemoryEvalHistory(base);
        const pick = (idx: number): unknown => {
          const i = idx < 0 ? history.length + idx : idx;
          if (!Number.isInteger(i) || i < 0 || i >= history.length) {
            throw new Error(`no eval run at index ${idx} (history has ${history.length} runs).`);
          }
          return history[i];
        };
        const baselineIndex = Math.trunc(getNumberArg(args, 'baselineIndex', -2));
        const currentIndex = Math.trunc(getNumberArg(args, 'currentIndex', -1));
        if (history.length < 2) return errorResult(`need at least 2 eval runs to compare (history has ${history.length}).`);
        const comparison = compareMemoryEvalReports(
          pick(baselineIndex) as Parameters<typeof compareMemoryEvalReports>[0],
          pick(currentIndex) as Parameters<typeof compareMemoryEvalReports>[1],
        );
        return JSON.stringify(comparison, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  /** Orchestrator seeded from live fleet workspaces (read-only statuses). */
  function seededOrchestrator(base: string): FleetOrchestrator {
    const fleetRoot = path.join(base, 'fleet');
    const orchestrator = new FleetOrchestrator({
      fleetRoot,
      policy: loadFleetPolicyV4(fleetRoot),
    });
    const manager = new FleetManager({ rootDir: fleetRoot });
    for (const status of manager.listFleet()) {
      orchestrator.registerBot({
        botId: status.workspace.id,
        name: status.workspace.name,
        capabilities: [],
        affinityTags: [status.workspace.name],
        runningTasks: status.usage ? 0 : 0,
        cpuLoad: null,
        status:
          status.workspace.status === 'active' && status.service.state === 'running'
            ? 'healthy'
            : status.service.state === 'error'
              ? 'down'
              : 'unknown',
        lastHealthAt: status.service.lastHealthAt,
        restarts: 0,
        tokenUsage: 0,
      });
    }
    return orchestrator;
  }

  const scheduleTool: Tool = {
    definition: toolDef(
      'fleet_v4_schedule',
      'Schedule a task onto the best-fit bot in the fleet (affinity bot/tags, required capabilities, current load, per-bot token quota from fleet policy v4). The task is queued by priority and assigned in-memory for this call; it does not execute the task. Read-only except for the in-memory queue.',
      {
        title: { type: 'string', description: 'Task title.' },
        kind: { type: 'string', description: 'Task kind (e.g. code, research, eval-run). Default general.' },
        priority: { type: 'number', description: 'Priority 1 (lowest) .. 5 (highest). Default = fleet policy defaultPriority.' },
        requiredCapabilities: { type: 'array', items: { type: 'string' }, description: 'Capabilities the bot must have.' },
        affinityBotId: { type: 'string', description: 'Prefer this exact bot when possible.' },
        affinityTags: { type: 'array', items: { type: 'string' }, description: 'Affinity tags — bots matching them score higher.' },
        tokenBudget: { type: 'number', description: 'Expected tokens the task will use (checked against the bot quota).' },
        submittedBy: { type: 'string', description: 'Who submitted the task.' },
      },
      ['title', 'submittedBy'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const priority = getNumberArg(args, 'priority', 0);
        if (priority !== 0 && (!Number.isInteger(priority) || priority < 1 || priority > 5)) {
          return errorResult('priority must be an integer 1..5.');
        }
        const tokenBudget = getNumberArg(args, 'tokenBudget', 0);
        const orchestrator = seededOrchestrator(base);
        const task = orchestrator.submitTask({
          title: getStringArg(args, 'title'),
          kind: getStringArg(args, 'kind', false) || undefined,
          ...(priority !== 0 ? { priority: priority as 1 | 2 | 3 | 4 | 5 } : {}),
          requiredCapabilities: getStringArrayArg(args, 'requiredCapabilities'),
          affinityBotId: getStringArg(args, 'affinityBotId', false) || undefined,
          affinityTags: getStringArrayArg(args, 'affinityTags'),
          ...(tokenBudget !== 0 ? { tokenBudget } : {}),
          submittedBy: getStringArg(args, 'submittedBy'),
        });
        const scheduled = orchestrator.scheduleNext();
        const violations = enforceFleetPolicy(orchestrator.getPolicy(), {
          runningBots: orchestrator.listBots().filter((b) => b.status === 'healthy' || b.status === 'degraded').length,
          runningTasksByBot: Object.fromEntries(orchestrator.listBots().map((b) => [b.botId, b.runningTasks])),
          tokenUsageByBot: Object.fromEntries(orchestrator.listBots().map((b) => [b.botId, b.tokenUsage])),
          restartsLastHourByBot: Object.fromEntries(orchestrator.listBots().map((b) => [b.botId, b.restarts])),
        });
        return JSON.stringify(
          {
            task,
            scheduled,
            waitingTasks: orchestrator.listWaitingTasks().length,
            policyViolations: violations,
          },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthTool: Tool = {
    definition: toolDef(
      'fleet_v4_health',
      'Health-check every bot in the fleet (mock probe over live fleet statuses) and auto-restart down bots within the fleet policy v4 restart limit. Returns the health report + per-bot summary. Restart here is a mock lifecycle (no real process is spawned).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const orchestrator = seededOrchestrator(base);
        const report = await orchestrator.runHealthCheck();
        return JSON.stringify(
          { report, summary: orchestrator.getHealthSummary() },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const policyTool: Tool = {
    definition: toolDef(
      'fleet_v4_policy_set',
      'View or set the fleet allocation policy v4 (max concurrent bots, per-bot token quota + period, default task priority, max auto-restarts per hour, max tasks per bot, require capability match). With no arguments it returns the current policy; with arguments it validates and saves it to <fleetRoot>/fleet-policy-v4.json.',
      {
        maxConcurrentBots: { type: 'number', description: 'Max bots running at once (0 = unlimited).' },
        perBotTokenQuota: { type: 'number', description: 'Token quota per bot per period (0 = unlimited).' },
        tokenQuotaPeriodMs: { type: 'number', description: 'Token quota period in ms.' },
        defaultPriority: { type: 'number', description: 'Default task priority 1..5.' },
        maxRestartsPerHour: { type: 'number', description: 'Max auto-restarts per bot per hour (0 = no auto-restart).' },
        maxTasksPerBot: { type: 'number', description: 'Max concurrent tasks per bot (0 = unlimited).' },
        requireCapabilityMatch: { type: 'boolean', description: 'Only assign tasks to bots with all required capabilities.' },
      },
      [],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const fleetRoot = path.join(base, 'fleet');
        const current = loadFleetPolicyV4(fleetRoot);
        const hasUpdate = Object.keys(args).length > 0;
        if (!hasUpdate) {
          return JSON.stringify(
            { policy: current, defaults: DEFAULT_FLEET_POLICY_V4 },
            null,
            2,
          ).slice(0, 20000);
        }
        const next = validateFleetPolicyV4({ ...current, ...args });
        const saved = saveFleetPolicyV4(fleetRoot, next);
        const violations = enforceFleetPolicy(saved, {
          runningBots: 0,
          runningTasksByBot: {},
          tokenUsageByBot: {},
          restartsLastHourByBot: {},
        });
        return JSON.stringify({ policy: saved, violations }, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const datasetTool: Tool = {
    definition: toolDef(
      'eval_v3_dataset',
      'List the built-in offline memory eval datasets (fictional fixtures) or show one dataset in detail (facts + questions + ground truth). Read-only, local only.',
      {
        datasetId: { type: 'string', description: 'Dataset id to show in detail (omit to list all datasets).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const datasetId = getStringArg(args, 'datasetId', false);
        if (!datasetId) {
          return JSON.stringify(
            BUILTIN_MEMORY_EVAL_DATASETS.map((d) => ({
              id: d.id,
              name: d.name,
              version: d.version,
              description: d.description,
              facts: d.facts.length,
              questions: d.questions.length,
              byCategory: {
                recall: d.questions.filter((q) => q.category === 'recall').length,
                temporal: d.questions.filter((q) => q.category === 'temporal').length,
                'multi-hop': d.questions.filter((q) => q.category === 'multi-hop').length,
              },
            })),
            null,
            2,
          ).slice(0, 20000);
        }
        const dataset = getBuiltinMemoryEvalDataset(datasetId);
        if (!dataset) return errorResult(`unknown eval dataset: "${datasetId}".`);
        return JSON.stringify(dataset, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const tasksTool: Tool = {
    definition: toolDef(
      'fleet_v4_tasks',
      'Manage the durable fleet task queue (<fleetRoot>/fleet-tasks-v4.json): list waiting/assigned tasks, submit a new task (saved to the queue file), or cancel one. Listing and submitting do not execute tasks.',
      {
        action: { type: 'string', enum: ['list', 'submit', 'cancel'], description: 'Action (default list).' },
        status: { type: 'string', enum: ['waiting', 'assigned', 'running', 'done', 'failed', 'cancelled'], description: 'Filter listed tasks by status.' },
        title: { type: 'string', description: 'Task title (submit only).' },
        kind: { type: 'string', description: 'Task kind (submit only, default general).' },
        priority: { type: 'number', description: 'Priority 1..5 (submit only).' },
        requiredCapabilities: { type: 'array', items: { type: 'string' }, description: 'Required capabilities (submit only).' },
        affinityBotId: { type: 'string', description: 'Prefer this bot (submit only).' },
        tokenBudget: { type: 'number', description: 'Expected tokens (submit only).' },
        submittedBy: { type: 'string', description: 'Who submits (submit only).' },
        taskId: { type: 'string', description: 'Task id (cancel only).' },
        reason: { type: 'string', description: 'Cancel reason (cancel only).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const fleetRoot = path.join(base, 'fleet');
        const orchestrator = new FleetOrchestrator({ fleetRoot, policy: loadFleetPolicyV4(fleetRoot) });
        orchestrator.loadTasks();
        const action = getStringArg(args, 'action', false) || 'list';
        if (action === 'list') {
          const status = getStringArg(args, 'status', false);
          const valid = ['waiting', 'assigned', 'running', 'done', 'failed', 'cancelled'];
          if (status && !valid.includes(status)) return errorResult(`status must be one of ${valid.join(', ')}, got "${status}".`);
          const tasks = orchestrator.listTasks(status as never);
          return JSON.stringify({ tasks, count: tasks.length }, null, 2).slice(0, 20000);
        }
        if (action === 'submit') {
          const priority = getNumberArg(args, 'priority', 0);
          if (priority !== 0 && (!Number.isInteger(priority) || priority < 1 || priority > 5)) {
            return errorResult('priority must be an integer 1..5.');
          }
          const tokenBudget = getNumberArg(args, 'tokenBudget', 0);
          const task = orchestrator.submitTask({
            title: getStringArg(args, 'title'),
            kind: getStringArg(args, 'kind', false) || undefined,
            ...(priority !== 0 ? { priority: priority as 1 | 2 | 3 | 4 | 5 } : {}),
            requiredCapabilities: getStringArrayArg(args, 'requiredCapabilities'),
            affinityBotId: getStringArg(args, 'affinityBotId', false) || undefined,
            ...(tokenBudget !== 0 ? { tokenBudget } : {}),
            submittedBy: getStringArg(args, 'submittedBy'),
          });
          orchestrator.saveTasks();
          return JSON.stringify({ task, saved: true }, null, 2).slice(0, 20000);
        }
        if (action === 'cancel') {
          const cancelled = orchestrator.cancelTask(getStringArg(args, 'taskId'), getStringArg(args, 'reason', false) || undefined);
          orchestrator.saveTasks();
          return JSON.stringify({ task: cancelled, saved: true }, null, 2).slice(0, 20000);
        }
        return errorResult(`action must be list, submit or cancel, got "${action}".`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const trendTool: Tool = {
    definition: toolDef(
      'eval_v3_trend',
      'Summarize the eval score trend from history: F1 slope per run (linear fit), best/worst run, latest vs first F1. Read-only, local only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const history = listMemoryEvalHistory(base);
        const trend = summarizeEvalHistory(history);
        return JSON.stringify({ runs: history.length, trend }, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const rebalanceTool: Tool = {
    definition: toolDef(
      'fleet_v4_rebalance',
      'Re-queue the assigned/running tasks of a down bot so the next scheduling round can give them to a healthy bot. Returns how many tasks were moved back to waiting. Does not execute tasks.',
      {
        botId: { type: 'string', description: 'Id of the down bot whose tasks should be re-queued.' },
      },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const fleetRoot = path.join(base, 'fleet');
        const orchestrator = new FleetOrchestrator({ fleetRoot, policy: loadFleetPolicyV4(fleetRoot) });
        orchestrator.loadTasks();
        const botId = getStringArg(args, 'botId');
        // The bot must exist in the live fleet (seeded from FleetManager).
        const live = seededOrchestrator(base).listBots().some((b) => b.botId === botId);
        if (!live) return errorResult(`no fleet bot with id "${botId}".`);
        // Rebalance needs the bot registered in this orchestrator.
        orchestrator.registerBot({
          botId,
          name: botId,
          capabilities: [],
          affinityTags: [],
          runningTasks: 0,
          cpuLoad: null,
          status: 'down',
          lastHealthAt: null,
          restarts: 0,
          tokenUsage: 0,
        });
        const moved = orchestrator.rebalanceAfterBotDown(botId);
        orchestrator.saveTasks();
        return JSON.stringify(
          { botId, movedTasks: moved, waitingTasks: orchestrator.listWaitingTasks().length },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const benchmarkTool: Tool = {
    definition: toolDef(
      'eval_v3_benchmark',
      'Run one dataset through both built-in mock retrievers (mock-embedding-v1 vs keyword-v1) and rank them per metric. Offline, no external calls, no real keys.',
      {
        datasetId: { type: 'string', description: 'Dataset id (default builtin-memory-v1).' },
        topK: { type: 'number', description: 'Facts retrieved per question (default 5).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const datasetId = getStringArg(args, 'datasetId', false) || BUILTIN_MEMORY_EVAL_DATASET.id;
        const dataset = getBuiltinMemoryEvalDataset(datasetId);
        if (!dataset) return errorResult(`unknown eval dataset: "${datasetId}".`);
        const topK = getNumberArg(args, 'topK', 5);
        if (!Number.isInteger(topK) || topK <= 0) return errorResult('topK must be an integer > 0.');
        const benchmark = await runRetrieverBenchmark(
          dataset,
          [
            { retriever: new InMemoryMockRetriever(dataset.facts), version: 'mock-embedding-v1' },
            { retriever: new KeywordMockRetriever(dataset.facts), version: 'keyword-v1' },
          ],
          { topK },
        );
        // Full reports (with per-question detail) exceed the 20k tool
        // result cap, so return the summary rows + winners only.
        const summary = {
          datasetId: benchmark.datasetId,
          datasetVersion: benchmark.datasetVersion,
          topK: benchmark.topK,
          at: benchmark.at,
          rows: benchmark.rows.map((row) => ({
            retrieverName: row.retrieverName,
            version: row.version,
            overall: row.report.overall,
            byCategory: row.report.byCategory,
          })),
          winners: benchmark.winners,
        };
        return JSON.stringify(summary, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [runSuiteTool, reportTool, compareTool, datasetTool, trendTool, benchmarkTool, scheduleTool, healthTool, policyTool, tasksTool, rebalanceTool];
}

/** Unbound placeholders, registered in ALL_TOOLS (see tools.ts). */
export const EVAL_FLEET_V105_TOOLS: Tool[] = createEvalFleetV105Tools();
