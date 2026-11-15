/**
 * Platform v4 tools (v1.06, Đội T6) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * - `platform_v4_schedule_bot` — enqueue một bot run vào hàng đợi
 *   fleet rồi thử schedule ngay lên node tốt nhất (ưu tiên + cân bằng
 *   tải + giới hạn concurrency theo `fleet/botScheduling.ts`).
 * - `platform_v4_fleet_status` — trạng thái fleet/node/bot: node nào
 *   alive/stale/dead, utilisation CPU/RAM/disk, run của từng bot,
 *   cảnh báo sức khoẻ. Chỉ đọc.
 * - `platform_v4_run_memory_eval` — chạy suite memory eval (recall
 *   sau N lượt, tier promotion, block edit) trong workspace tạm,
 *   trả về pass/fail từng case.
 * - `platform_v4_run_mcp_eval` — chạy suite MCP conformance eval
 *   (stateless format, discover, elicitation form/URL, Tasks
 *   poll/cancel, fallback handshake server cũ).
 * - `platform_v4_eval_report` — xem lại báo cáo eval đã lưu
 *   (danh sách hoặc một báo cáo theo id).
 *
 * Like the fleet v3 tools, these are placeholders in ALL_TOOLS until
 * the host binds them: `createPlatformV4Tools(getBaseDir)` with the
 * app's userData dir wires them (fleet root is `<userData>/fleet`,
 * eval reports are `<userData>/eval-reports`). Unbound, they answer
 * with a clear "not configured" message instead of guessing paths.
 * Eval chạy trong thư mục tạm riêng — không động vào dữ liệu thật.
 * `platform_v4_schedule_bot` ghi vào hàng đợi fleet (đó là ý định
 * của tool) nên cần approval; các tool còn lại chỉ đọc / chạy eval
 * trong bộ nhớ + thư mục tạm.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  BOT_PRIORITIES,
  buildFleetStatus,
  enqueueBotRun,
  formatEvalReportText,
  listEvalReports,
  loadEvalReport,
  runEval,
  scheduleBotRuns,
  summarizeBotScheduling,
  type BotPriority,
  type EvalSuiteName,
} from '@open-bot/core';

export const PLATFORM_V4_TOOL_NAMES = [
  'platform_v4_schedule_bot',
  'platform_v4_fleet_status',
  'platform_v4_run_memory_eval',
  'platform_v4_run_mcp_eval',
  'platform_v4_eval_report',
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
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Argument "${name}" must be a number > 0.`);
  }
  return value;
}

function getIntArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`Argument "${name}" must be a positive integer.`);
  }
  return value as number;
}

const NOT_WIRED =
  'platform v4 tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

const GB = 1024 ** 3;

/** Fleet root / eval dir derived from the app userData dir. */
function dirs(baseDir: string): { fleetRoot: string } {
  return { fleetRoot: path.join(baseDir, 'fleet') };
}

const RESOURCES_PROPS = {
  cpuCores: { type: 'number', description: 'CPU cores the bot run needs.' },
  ramBytes: { type: 'number', description: 'RAM in bytes the bot run needs.' },
  diskBytes: { type: 'number', description: 'Disk in bytes the bot run needs.' },
};

/**
 * Build the 5 platform v4 tools. `getBaseDir` resolves the app
 * userData dir (null/undefined = unbound placeholders that explain
 * themselves instead of guessing paths).
 */
export function createPlatformV4Tools(
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

  const scheduleBotTool: Tool = {
    definition: toolDef(
      'platform_v4_schedule_bot',
      'Schedule a bot run on the fleet: enqueue it (priority critical/high/normal/low) and try to place it on the best alive node right away, balancing CPU/RAM/disk load and respecting per-node concurrency. Returns the run and where it was placed (or why it is still queued).',
      {
        botId: { type: 'string', description: 'Id of the bot to run.' },
        summary: { type: 'string', description: 'Short description of the run (no secrets).' },
        priority: { type: 'string', enum: [...BOT_PRIORITIES], description: 'Run priority (default normal).' },
        ...RESOURCES_PROPS,
        maxAttempts: { type: 'integer', description: 'Max attempts before the run fails permanently (default 3).' },
      },
      ['botId', 'summary'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const priority = getStringArg(args, 'priority', false);
        if (priority && !BOT_PRIORITIES.includes(priority as BotPriority)) {
          return errorResult(`priority must be one of: ${BOT_PRIORITIES.join(', ')}.`);
        }
        const run = enqueueBotRun(fleetRoot, {
          botId: getStringArg(args, 'botId'),
          summary: getStringArg(args, 'summary'),
          priority: (priority || 'normal') as BotPriority,
          resources: {
            cpuCores: getNumberArg(args, 'cpuCores', 1),
            ramBytes: getNumberArg(args, 'ramBytes', 512 * 1024 * 1024),
            diskBytes: getNumberArg(args, 'diskBytes', 10 * GB),
          },
          maxAttempts: getIntArg(args, 'maxAttempts', 3),
        });
        const scheduled = scheduleBotRuns(fleetRoot);
        const mine = scheduled.find((r) => r.run.id === run.id);
        return JSON.stringify(
          {
            run: mine?.run ?? run,
            scheduled: mine?.scheduled ?? false,
            nodeId: mine?.nodeId ?? null,
            reason: mine?.reason ?? 'queued',
            queue: summarizeBotScheduling(fleetRoot),
          },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fleetStatusTool: Tool = {
    definition: toolDef(
      'platform_v4_fleet_status',
      'Fleet/node/bot status: which nodes are alive/stale/dead, CPU/RAM/disk utilisation per node, queued/running/done/failed runs per bot, and health warnings. Read-only, local only.',
      {
        botId: { type: 'string', description: 'Optional: only show this bot.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const status = buildFleetStatus(fleetRoot, Date.now(), { maxConcurrentPerNode: 4 });
        const botId = getStringArg(args, 'botId', false);
        const view = botId
          ? { ...status, bots: status.bots.filter((b) => b.botId === botId) }
          : status;
        return JSON.stringify(view, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runMemoryEvalTool: Tool = {
    definition: toolDef(
      'platform_v4_run_memory_eval',
      'Run the memory eval suite (recall the right fact after N turns, tier promotion rules, block edits keep facts, scope isolation) in a temporary workspace. Returns pass/fail per case. Read-only with respect to real user data.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { report, reportPath } = await runEval(['memory'], { saveDir: base });
        return `${formatEvalReportText(report)}Report saved to: ${reportPath ?? '(not saved)'}\n`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runMcpEvalTool: Tool = {
    definition: toolDef(
      'platform_v4_run_mcp_eval',
      'Run the MCP conformance eval suite (stateless request format, server/discover, elicitation form/URL, Tasks poll/cancel, fallback handshake with old servers) against an in-memory fake transport — no real MCP server or network needed. Returns pass/fail per case.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { report, reportPath } = await runEval(['mcp-conformance'], { saveDir: base });
        return `${formatEvalReportText(report)}Report saved to: ${reportPath ?? '(not saved)'}\n`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const evalReportTool: Tool = {
    definition: toolDef(
      'platform_v4_eval_report',
      'Show saved eval reports: list recent reports, or one report by id with pass/fail per case. Read-only, local only.',
      {
        reportId: { type: 'string', description: 'Report id (e.g. eval-...). Omit to list recent reports.' },
        suite: { type: 'string', enum: ['memory', 'mcp-conformance'], description: 'Optional: only list reports that ran this suite.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const reportId = getStringArg(args, 'reportId', false);
        if (reportId) {
          const report = loadEvalReport(base, reportId);
          if (!report) return errorResult(`eval report "${reportId}" not found.`);
          return formatEvalReportText(report);
        }
        const suite = getStringArg(args, 'suite', false);
        if (suite && suite !== 'memory' && suite !== 'mcp-conformance') {
          return errorResult(`suite must be 'memory' or 'mcp-conformance', got "${suite}".`);
        }
        const reports = listEvalReports(base)
          .filter((r) => !suite || r.suites.includes(suite as EvalSuiteName))
          .slice(0, 20);
        return JSON.stringify(reports, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [scheduleBotTool, fleetStatusTool, runMemoryEvalTool, runMcpEvalTool, evalReportTool];
}

/** Unbound placeholders, registered in ALL_TOOLS (see tools.ts). */
export const PLATFORM_V4_TOOLS: Tool[] = createPlatformV4Tools();
