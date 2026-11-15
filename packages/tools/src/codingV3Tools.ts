/**
 * Coding agent v3 tools for @open-bot/tools (v1.10, Đội T4).
 *
 * The agent drives coding v3 by tool call:
 *  - repomap_v3_build      — build/refresh repo map v3 (v2 incremental
 *    build + call edges + module graph + cache v3) (read + cache write)
 *  - repomap_v3_modules    — module ranking (PageRank theo thư mục) +
 *    top call edges file -> file (read)
 *  - repomap_v3_budget_map — repo map rút gọn vừa ngân sách token,
 *    toàn cục hoặc theo truy vấn (read)
 *  - repomap_v3_calls      — file A gọi file B: top calls/callers của
 *    một file (read)
 *  - coding_v3_team_run    — manager chạy team: explorer brief trước,
 *    worker song song (giới hạn thread cấu hình được), tổng hợp kết
 *    quả (local action, needs approval — worker sửa file)
 *  - coding_v3_team_status — kết quả team run gần nhất (read)
 *  - eval_v3_run           — chạy 1 eval task kiểu Terminal-Bench
 *    trong thư mục tạm, chấm pass/fail/error (local action)
 *  - eval_v3_suite         — chạy bộ task mẫu (3 task, chạy thật,
 *    không cần mạng/key) (local action)
 *  - eval_v3_list          — liệt kê task mẫu (read)
 *  - router_v3_pick        — chọn model local theo task/cost/latency
 *    + chuỗi fallback + lý do (read, không gọi API)
 *  - router_v3_record_failure — ghi lỗi một model để lần pick sau
 *    loại nó ra (local action)
 *  - router_v3_catalog     — bảng model router đang dùng (read)
 *
 * SAFETY: everything here is local — no network, no X data, no Grok
 * Imagine, no cloud VM/accounts/payments. Repo map cache lives under
 * `.open-bot/coding-v3/` in the workspace. Team workers only edit
 * files inside the workspace root (path traversal blocked, no shell).
 * Eval tasks run in a temp dir with argv (no shell string) — only run
 * tasks you wrote or trust. Router never calls any API.
 *
 * Factory:
 *   createCodingV3Tools(opts) -> Tool[]   (bound, usable)
 *   CODING_V3_TOOLS                       (unbound placeholder)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  CodingV3EvalHarness,
  CodingV3Explorer,
  CodingV3Manager,
  CodingV3ModelRouter,
  parseCodingV2Cache,
  CODING_V3_DEFAULT_BUDGET_TOKENS,
  CODING_V3_DEFAULT_MAX_THREADS,
  CODING_V3_SAMPLE_TASKS,
} from '@open-bot/core';
import type {
  CodingV3Edit,
  CodingV3EvalCommand,
  CodingV3EvalTask,
  CodingV3Task,
  CodingV3TaskProfile,
  CodingV3TaskType,
  CodingV3TeamRunResult,
} from '@open-bot/core';
import { CodingV3RepoMapStore } from './codingV3RepoMap';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export const CODING_V3_TOOL_NAMES = [
  'repomap_v3_build',
  'repomap_v3_modules',
  'repomap_v3_budget_map',
  'repomap_v3_calls',
  'coding_v3_team_run',
  'coding_v3_team_status',
  'eval_v3_run',
  'eval_v3_suite',
  'eval_v3_list',
  'router_v3_pick',
  'router_v3_record_failure',
  'router_v3_catalog',
] as const;

export type CodingV3ToolName = (typeof CODING_V3_TOOL_NAMES)[number];

export function isCodingV3ToolName(name: string): name is CodingV3ToolName {
  return (CODING_V3_TOOL_NAMES as readonly string[]).includes(name);
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

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string, required = true): string[] {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function getObjectArg(args: Record<string, unknown>, name: string, required = true): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

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

const TASK_TYPES: ReadonlySet<string> = new Set([
  'codegen',
  'refactor',
  'review',
  'explore',
  'plan',
  'fix',
  'test',
  'chat',
]);

function parseEvalCommand(raw: unknown, i: number, taskId: string): CodingV3EvalCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Eval task "${taskId}" command[${i}] phải là object.`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    throw new Error(`Eval task "${taskId}" command[${i}] thiếu name.`);
  }
  if (!Array.isArray(obj.argv) || obj.argv.length === 0 || obj.argv.some((a) => typeof a !== 'string')) {
    throw new Error(`Eval task "${taskId}" command[${i}] cần argv là mảng string không rỗng.`);
  }
  const cmd: CodingV3EvalCommand = { name: obj.name, argv: obj.argv as string[] };
  if (typeof obj.timeoutMs === 'number' && Number.isFinite(obj.timeoutMs)) cmd.timeoutMs = obj.timeoutMs;
  return cmd;
}

function parseEvalTask(raw: Record<string, unknown>): CodingV3EvalTask {
  const id = raw.id;
  if (typeof id !== 'string' || id.trim() === '') throw new Error('Eval task cần id không rỗng.');
  const title = raw.title;
  if (typeof title !== 'string' || title.trim() === '') throw new Error('Eval task cần title không rỗng.');
  if (!Array.isArray(raw.testCommands) || raw.testCommands.length === 0) {
    throw new Error(`Eval task "${id}" cần ít nhất 1 test command.`);
  }
  const task: CodingV3EvalTask = {
    id,
    title,
    testCommands: (raw.testCommands as unknown[]).map((c, i) => parseEvalCommand(c, i, id)),
  };
  if (typeof raw.description === 'string') task.description = raw.description;
  if (Array.isArray(raw.setupCommands)) {
    task.setupCommands = (raw.setupCommands as unknown[]).map((c, i) => parseEvalCommand(c, i, id));
  }
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)) task.timeoutMs = raw.timeoutMs;
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    task.env = env;
  }
  if (raw.fixtures && typeof raw.fixtures === 'object' && !Array.isArray(raw.fixtures)) {
    const fixtures: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.fixtures as Record<string, unknown>)) {
      if (typeof v === 'string') fixtures[k] = v;
    }
    task.fixtures = fixtures;
  }
  return task;
}

export interface CodingV3ToolOptions {
  /** Fixed workspace directory (its repo map / team runs live there). */
  workspaceDir?: string;
  /** Lazy workspace directory (host supplies it; overrides ctx when set). */
  getWorkspaceDir?: () => string | undefined;
  /** Pre-built repo map store (tests); defaults to one per workspaceDir. */
  repoMapStore?: CodingV3RepoMapStore;
  /** Pre-built router (tests); defaults to one per factory. */
  router?: CodingV3ModelRouter;
}

export function createCodingV3Tools(opts: CodingV3ToolOptions = {}): Tool[] {
  const repoMapStores = new Map<string, CodingV3RepoMapStore>();
  const lastTeamRuns = new Map<string, CodingV3TeamRunResult>();
  const router = opts.router ?? new CodingV3ModelRouter();
  const harness = new CodingV3EvalHarness();

  const resolveRoot = (ctx: ToolContext): string => {
    const dir = opts.workspaceDir ?? opts.getWorkspaceDir?.() ?? ctx.workspaceDir;
    if (!dir || typeof dir !== 'string' || dir.trim() === '') {
      throw new Error(
        'workspaceDir is required (host must pass it to createCodingV3Tools, or the tool context must carry it).',
      );
    }
    return path.resolve(dir);
  };

  const repoMapOf = (root: string): CodingV3RepoMapStore => {
    if (opts.repoMapStore) return opts.repoMapStore;
    let store = repoMapStores.get(root);
    if (!store) {
      store = new CodingV3RepoMapStore(root);
      repoMapStores.set(root, store);
    }
    return store;
  };

  const repoMapBuild: Tool = {
    definition: toolDef(
      'repomap_v3_build',
      'Build or refresh the coding-v3 repo map (v1.10, read + cache write): v2 incremental build (only changed/new files re-parsed, disk cache reused) plus v3 layers — file->file call edges (imports + symbol mentions), module graph (files grouped by directory, PageRank-aggregated), and a v3 summary cache (.open-bot/coding-v3/repo-map-v3.json). Supports TS/TSX/JS/JSX/Python, max 2000 files / 1 MB per file.',
      {
        force: { type: 'boolean', description: 'Rebuild from scratch, ignoring the disk cache.' },
        maxFiles: { type: 'number', description: 'Max files to scan (default 2000, capped at 5000).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        const result = await store.build({
          force: getBooleanArg(args, 'force') ?? false,
          maxFiles: getNumberArg(args, 'maxFiles'),
        });
        const lines = [
          `Repo map v3 built for ${result.rootDir} in ${result.durationMs}ms.`,
          `Files: ${result.files}, symbols: ${result.symbols}, edges: ${result.edges} (v2 graph).`,
          `Call edges (file->file): ${result.callEdges}; modules: ${result.modules}${result.topModule ? `; top module: ${result.topModule.module} (score ${result.topModule.score.toFixed(4)})` : ''}.`,
          `Scanned: ${result.scanned} files — re-parsed ${result.reparsed}, reused from cache ${result.reused}, removed ${result.removed}.`,
          `Cache v2: ${result.cachePath} (${result.cacheWritten ? 'written' : 'NOT written'}; ${result.cacheFresh ? 'already fresh' : 'refreshed'}).`,
          `Cache v3: ${result.v3CachePath} (${result.v3CacheWritten ? 'written' : 'NOT written'}).`,
        ];
        if (result.parseErrors.length > 0) {
          lines.push(`Parse errors (${result.parseErrors.length}): ${result.parseErrors.slice(0, 3).join(' | ')}.`);
        }
        for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const repoMapModules: Tool = {
    definition: toolDef(
      'repomap_v3_modules',
      'Module ranking + top call edges from the coding-v3 repo map (v1.10, read): modules (directories) ranked by aggregated PageRank score with file/symbol counts, plus the strongest file->file call edges (import + symbol-mention weight). Builds the map first when it has never been built.',
      {
        limit: { type: 'number', description: 'Max modules to return (default 10).' },
        callEdgeLimit: { type: 'number', description: 'Max call edges to return (default 10).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        await store.ensureBuilt();
        const moduleGraph = store.getModuleGraph();
        const lines: string[] = [`Repo map v3 modules for ${root}:`];
        if (!moduleGraph || moduleGraph.modules.length === 0) {
          lines.push('No modules in the map yet — build it first.');
        } else {
          const limit = getNumberArg(args, 'limit') ?? 10;
          for (const [i, mod] of moduleGraph.modules.slice(0, Math.max(0, limit)).entries()) {
            lines.push(
              `#${i + 1} ${mod.module} (score ${mod.score.toFixed(4)}, ${mod.files} files, ${mod.symbols} symbols)`,
            );
            for (const top of mod.topFiles.slice(0, 3)) {
              lines.push(`    ${top.relPath} (${top.score.toFixed(4)})`);
            }
          }
        }
        const callEdgeLimit = getNumberArg(args, 'callEdgeLimit') ?? 10;
        const edges = store.topCallEdges(callEdgeLimit);
        lines.push(`Top ${edges.length} call edge(s):`);
        for (const edge of edges) {
          lines.push(
            `  ${edge.from} -> ${edge.to} (weight ${edge.weight.toFixed(1)}: import ${edge.importWeight.toFixed(1)}, call ${edge.callWeight.toFixed(1)}, ${edge.distinctSymbolsCalled} symbol(s))`,
          );
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const repoMapBudgetMap: Tool = {
    definition: toolDef(
      'repomap_v3_budget_map',
      'Condensed repo map that fits a token budget (v1.10, read): top files by PageRank with their top symbols, rendered as text and cut to fit the budget (estimated tokens = chars/4). With a query, Personalized PageRank seeds on matching files/symbols first. Reports which files were included vs cut. Builds the map first when it has never been built.',
      {
        query: { type: 'string', description: 'Optional query (symbol/file/topic) — budget map ranked by relevance to it.' },
        budgetTokens: { type: 'number', description: 'Token budget (default 2000).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        await store.ensureBuilt();
        const budgetTokens = getNumberArg(args, 'budgetTokens') ?? CODING_V3_DEFAULT_BUDGET_TOKENS;
        const query = getOptionalStringArg(args, 'query');
        const lines: string[] = [];
        let mapText = '';
        if (query) {
          const qmap = store.queryBudgetMap(query, budgetTokens);
          lines.push(
            `Budget map: ~${qmap.estimatedTokens} tokens (budget ${qmap.budgetTokens}), ${qmap.includedFiles.length}/${qmap.totalFiles} files included${qmap.truncated ? `, ${qmap.excludedFiles.length} cut by budget` : ''}.`,
          );
          if (qmap.fellBackToGlobal) {
            lines.push(`Query "${query}" matched nothing — showing the global ranking.`);
          } else if (qmap.seedFiles.length > 0) {
            lines.push(`Seed files: ${qmap.seedFiles.slice(0, 5).join(', ')}${qmap.seedFiles.length > 5 ? '…' : ''}.`);
          }
          mapText = qmap.text;
        } else {
          const map = store.budgetMap(budgetTokens);
          lines.push(
            `Budget map: ~${map.estimatedTokens} tokens (budget ${map.budgetTokens}), ${map.includedFiles.length}/${map.totalFiles} files included${map.truncated ? `, ${map.excludedFiles.length} cut by budget` : ''}.`,
          );
          mapText = map.text;
        }
        lines.push(mapText);
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const repoMapCalls: Tool = {
    definition: toolDef(
      'repomap_v3_calls',
      'Call neighbours of one file in the coding-v3 repo map (v1.10, read): which files it calls most (top calls) and which files call it most (top callers), with import/call weights. Builds the map first when it has never been built.',
      {
        file: { type: 'string', description: 'Workspace-relative file path, e.g. "packages/core/src/codingV2/repoMapGraph.ts".' },
        limit: { type: 'number', description: 'Max neighbours per direction (default 10).' },
      },
      ['file'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        await store.ensureBuilt();
        const file = getStringArg(args, 'file');
        const limit = getNumberArg(args, 'limit') ?? 10;
        const calls = store.topCallsFrom(file, limit);
        const callers = store.topCallersOf(file, limit);
        const lines: string[] = [`Call neighbours of ${file}:`];
        lines.push(`Calls (${calls.length}):`);
        for (const edge of calls) {
          lines.push(`  -> ${edge.to} (weight ${edge.weight.toFixed(1)}, ${edge.distinctSymbolsCalled} symbol(s))`);
        }
        if (calls.length === 0) lines.push('  (no outgoing calls in the map)');
        lines.push(`Called by (${callers.length}):`);
        for (const edge of callers) {
          lines.push(`  <- ${edge.from} (weight ${edge.weight.toFixed(1)}, ${edge.distinctSymbolsCalled} symbol(s))`);
        }
        if (callers.length === 0) lines.push('  (no incoming calls in the map)');
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const teamRun: Tool = {
    definition: toolDef(
      'coding_v3_team_run',
      'Run a manager/explorer/worker coding team (v1.10, local action, needs approval): the manager splits the task into subtasks (one per hinted file by default), the explorer briefs from the repo map first, then workers run in parallel (maxConcurrentThreads, default 4) applying JSON edits { "edits": [{ path, kind: create|write|edit|delete, content?, oldText?, newText? }] } inside the workspace root. A failing worker does not stop the team. Returns per-subtask status and the files changed. Edits are given in the task spec as JSON, or in the edits argument.',
      {
        title: { type: 'string', description: 'Task title.' },
        spec: { type: 'string', description: 'Task spec — for the patch executor, a JSON string { "edits": [...] } (or free text when edits are passed separately).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Hinted files (one subtask per file by default).' },
        difficulty: { type: 'number', description: 'Estimated difficulty 1-5 (default 3).' },
        maxConcurrentThreads: { type: 'number', description: 'Max parallel workers (default 4, capped at 20).' },
        edits: {
          type: 'array',
          description: 'Edits to apply as a single subtask (alternative to JSON edits in spec).',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              kind: { type: 'string' },
              content: { type: 'string' },
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['path', 'kind'],
          },
        },
      },
      ['title', 'spec'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const title = getStringArg(args, 'title');
        const spec = getStringArg(args, 'spec');
        const files = getStringArrayArg(args, 'files', false);
        const difficulty = getNumberArg(args, 'difficulty') ?? 3;
        const maxConcurrentThreads = getNumberArg(args, 'maxConcurrentThreads') ?? CODING_V3_DEFAULT_MAX_THREADS;
        const rawEdits = args.edits;
        const task: CodingV3Task = {
          id: `team-task-${Date.now()}`,
          title,
          spec,
          files,
          difficulty,
        };
        if (Array.isArray(rawEdits)) {
          const editKinds = new Set(['create', 'write', 'edit', 'delete']);
          task.edits = (rawEdits as Array<Record<string, unknown>>).map((raw, i) => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
              throw new Error(`edits[${i}] phải là object.`);
            }
            if (typeof raw.path !== 'string' || raw.path.trim() === '') {
              throw new Error(`edits[${i}].path phải là string không rỗng.`);
            }
            if (typeof raw.kind !== 'string' || !editKinds.has(raw.kind)) {
              throw new Error(`edits[${i}].kind "${String(raw.kind)}" không hợp lệ (create/write/edit/delete).`);
            }
            const edit: CodingV3Edit = {
              path: raw.path,
              kind: raw.kind as CodingV3Edit['kind'],
            };
            if (typeof raw.content === 'string') edit.content = raw.content;
            if (typeof raw.oldText === 'string') edit.oldText = raw.oldText;
            if (typeof raw.newText === 'string') edit.newText = raw.newText;
            return edit;
          });
        }
        // Explorer brief từ repo map khi map đã build (không build ép).
        let explorer: CodingV3Explorer | null = null;
        const store = repoMapOf(root);
        const graph = store.getGraph();
        if (graph) {
          // Entries cho explorer: đọc cache v2 (đã có sau build).
          const entries: import('@open-bot/core').CodingV2FileEntry[] = [];
          try {
            const text = fs.readFileSync(store.v2.cachePath, 'utf8');
            const parsed = parseCodingV2Cache(text, root);
            if (!('error' in parsed)) entries.push(...Object.values(parsed.cache.files));
          } catch {
            // Không đọc được entries: explorer vẫn brief bằng graph.
          }
          explorer = new CodingV3Explorer(graph, entries, root);
        }
        const manager = new CodingV3Manager({
          maxConcurrentThreads,
          rootDir: root,
          explorer,
        });
        const result = await manager.run(task);
        lastTeamRuns.set(root, result);
        const lines = [result.summary, `Run: ${result.runId} — status ${result.status} (${result.durationMs}ms).`];
        if (result.explorerBrief) {
          lines.push(
            `Explorer brief: ${result.explorerBrief.relevantFiles.length} relevant file(s) for "${title}"${result.explorerBrief.risks.length > 0 ? `; risks: ${result.explorerBrief.risks.join(' ')}` : ''}.`,
          );
        }
        for (const sub of result.subTasks) {
          const res = result.results.find((r) => r.subTaskId === sub.id);
          lines.push(
            `  [${sub.status}] ${sub.id}${sub.claimedBy ? ` (${sub.claimedBy})` : ''}: ${res?.summary ?? ''}${sub.error ? ` — error: ${sub.error}` : ''}`,
          );
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const teamStatus: Tool = {
    definition: toolDef(
      'coding_v3_team_status',
      'Last coding-v3 team run in this workspace (v1.10, read): status, per-subtask results, files changed, and max concurrency observed. Empty when no team has run yet.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const result = lastTeamRuns.get(root);
        if (!result) return 'No coding-v3 team run yet in this workspace.';
        const lines = [
          `Team run ${result.runId} — ${result.status} (${result.durationMs}ms, max concurrency ${result.maxConcurrencyObserved}/${result.maxConcurrentThreads}).`,
          `Task: ${result.taskTitle}`,
          result.summary,
        ];
        for (const sub of result.subTasks) {
          lines.push(`  [${sub.status}] ${sub.id}: ${sub.title}${sub.error ? ` — ${sub.error}` : ''}`);
        }
        if (result.filesChanged.length > 0) {
          lines.push('Files changed:');
          for (const change of result.filesChanged) {
            lines.push(`  ${change.path} (${change.kind}, +${change.linesAdded}/-${change.linesRemoved})`);
          }
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const evalRun: Tool = {
    definition: toolDef(
      'eval_v3_run',
      'Run ONE Terminal-Bench-style eval task (v1.10, local action): setup commands then test commands (exit 0 = pass) in a fresh temp dir, argv only (no shell). Setup failure => status error (infra, not a fail); test failure/timeout => fail. Returns per-command results and logs. Only run tasks you wrote or trust — commands run on this machine (no Docker sandbox).',
      {
        task: {
          type: 'object',
          description: 'Eval task: { id, title, description?, setupCommands?: [{ name, argv, timeoutMs? }], testCommands: [{ name, argv, timeoutMs? }], timeoutMs?, env?, fixtures?: { relPath: content } }.',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            setupCommands: { type: 'array' },
            testCommands: { type: 'array' },
            timeoutMs: { type: 'number' },
            env: { type: 'object' },
            fixtures: { type: 'object' },
          },
          required: ['id', 'title', 'testCommands'],
        },
        keepWorkDir: { type: 'boolean', description: 'Keep the temp work dir after the run (default false: deleted).' },
      },
      ['task'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        void ctx;
        const task = parseEvalTask(getObjectArg(args, 'task'));
        const result = await harness.runTask(task, { keepWorkDir: getBooleanArg(args, 'keepWorkDir') ?? false });
        const lines = [
          `Eval task "${result.taskId}" (${result.title}): ${result.status.toUpperCase()} — ${result.reason}`,
          `Tests: ${result.passedTests}/${result.totalTests} passed in ${result.durationMs}ms. Work dir: ${result.workDir}${result.workDirKept ? ' (kept)' : ' (deleted)'}.`,
        ];
        for (const cmd of [...result.setup, ...result.tests]) {
          lines.push(
            `  [${cmd.phase}] ${cmd.name}: ${cmd.passed ? 'pass' : 'FAIL'} (exit ${String(cmd.exitCode)}${cmd.timedOut ? ', timeout' : ''}, ${cmd.durationMs}ms)`,
          );
          if (cmd.stdout.trim() !== '') lines.push(`    stdout: ${cmd.stdout.trim().split('\n').slice(0, 3).join(' | ')}`);
          if (!cmd.passed && cmd.stderr.trim() !== '') {
            lines.push(`    stderr: ${cmd.stderr.trim().split('\n').slice(0, 3).join(' | ')}`);
          }
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const evalSuite: Tool = {
    definition: toolDef(
      'eval_v3_suite',
      'Run the built-in sample eval suite (v1.10, local action): 3 small tasks that really run (write a function, fix a bug, create a module) in temp dirs with node — no network, no key. Returns pass rate, per-task status, and durations.',
      {
        keepWorkDir: { type: 'boolean', description: 'Keep temp work dirs after the run (default false: deleted).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const report = await harness.runSuite(CODING_V3_SAMPLE_TASKS, {
          keepWorkDir: getBooleanArg(args, 'keepWorkDir') ?? false,
        });
        const lines = [report.summary];
        for (const result of report.results) {
          lines.push(`  [${result.status}] ${result.taskId}: ${result.reason} (${result.durationMs}ms)`);
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const evalList: Tool = {
    definition: toolDef(
      'eval_v3_list',
      'List the built-in sample eval tasks (v1.10, read): id, title, and description of each of the 3 sample tasks. Run one with eval_v3_run (pass the task object) or all with eval_v3_suite.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      const lines = ['Sample eval tasks (v1.10, run for real in temp dirs):'];
      for (const task of CODING_V3_SAMPLE_TASKS) {
        lines.push(
          `  ${task.id}: ${task.title} — ${task.description ?? ''} (${task.testCommands.length} test command(s), ${(task.setupCommands ?? []).length} setup command(s))`,
        );
      }
      return lines.join('\n');
    },
  };

  const routerPick: Tool = {
    definition: toolDef(
      'router_v3_pick',
      'Pick a model for a coding task (v1.10, read, no API call): scores the local-first catalog by task type, estimated difficulty, cost budget, latency budget, and local preference; returns the picked model, the fallback chain in order, and the reason for each score. When the picked model fails, call router_v3_record_failure then pick again.',
      {
        type: { type: 'string', description: 'Task type: codegen|refactor|review|explore|plan|fix|test|chat.' },
        difficulty: { type: 'number', description: 'Estimated difficulty 1-5 (default 3).' },
        estimatedInputTokens: { type: 'number', description: 'Estimated input tokens (default 4000).' },
        estimatedOutputTokens: { type: 'number', description: 'Estimated output tokens (default 1000).' },
        maxCostUsd: { type: 'number', description: 'Max USD for the call (optional).' },
        maxLatencyMs: { type: 'number', description: 'Max latency ms (optional).' },
        preferLocal: { type: 'boolean', description: 'Only local models (default false).' },
        preferCloud: { type: 'boolean', description: 'Only cloud models (default false).' },
      },
      ['type'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const type = getStringArg(args, 'type');
        if (!TASK_TYPES.has(type)) {
          throw new Error(`type "${type}" không hợp lệ (${[...TASK_TYPES].join('|')}).`);
        }
        const profile: CodingV3TaskProfile = {
          type: type as CodingV3TaskType,
          difficulty: getNumberArg(args, 'difficulty') ?? 3,
        };
        const inTokens = getNumberArg(args, 'estimatedInputTokens');
        if (inTokens !== undefined) profile.estimatedInputTokens = inTokens;
        const outTokens = getNumberArg(args, 'estimatedOutputTokens');
        if (outTokens !== undefined) profile.estimatedOutputTokens = outTokens;
        const maxCost = getNumberArg(args, 'maxCostUsd');
        if (maxCost !== undefined) profile.maxCostUsd = maxCost;
        const maxLatency = getNumberArg(args, 'maxLatencyMs');
        if (maxLatency !== undefined) profile.maxLatencyMs = maxLatency;
        if (getBooleanArg(args, 'preferLocal') === true) profile.preferLocal = true;
        if (getBooleanArg(args, 'preferCloud') === true) profile.preferCloud = true;
        const decision = router.pickModel(profile);
        const lines = [
          `Router pick for ${profile.type} (difficulty ${profile.difficulty}): ${decision.picked.model.id} (${decision.picked.model.provider}, ${decision.picked.model.kind}) — score ${decision.picked.score}/100, est. cost $${decision.picked.estimatedCostUsd.toFixed(4)}, p50 ${decision.picked.model.latencyMsP50}ms.`,
          `  Why: ${decision.picked.reasons.join('; ')}.`,
          `  Breakdown: task-type ${decision.picked.breakdown.taskType}/40, difficulty ${decision.picked.breakdown.difficulty}/20, cost ${decision.picked.breakdown.cost}/20, latency ${decision.picked.breakdown.latency}/10, local ${decision.picked.breakdown.localBonus}/10.`,
        ];
        if (decision.excludedByFailure.length > 0) {
          lines.push(`  Excluded (recent failure): ${decision.excludedByFailure.join('; ')}.`);
        }
        if (decision.excludedByConstraint.length > 0) {
          lines.push(`  Excluded (budget): ${decision.excludedByConstraint.join('; ')}.`);
        }
        if (decision.fallbacks.length > 0) {
          lines.push('  Fallbacks (in order):');
          for (const fb of decision.fallbacks.slice(0, 5)) {
            lines.push(`    ${fb.model.id} (score ${fb.score}, $${fb.estimatedCostUsd.toFixed(4)}, p50 ${fb.model.latencyMsP50}ms)`);
          }
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const routerRecordFailure: Tool = {
    definition: toolDef(
      'router_v3_record_failure',
      'Record a model failure so the router excludes it (v1.10, local action): the model stays excluded for 10 minutes (TTL), then becomes eligible again. Pick again with router_v3_pick to get the next fallback.',
      {
        modelId: { type: 'string', description: 'Model id that failed, e.g. "ollama/qwen2.5-coder:7b".' },
        error: { type: 'string', description: 'Short error description.' },
      },
      ['modelId', 'error'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const modelId = getStringArg(args, 'modelId');
        const error = getStringArg(args, 'error');
        router.recordFailure(modelId, error);
        return `Recorded failure for ${modelId}: ${error}. It will be excluded from router picks for 10 minutes.`;
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const routerCatalog: Tool = {
    definition: toolDef(
      'router_v3_catalog',
      'List the model catalog the v3 router scores (v1.10, read): id, provider, local/cloud, context, cost per 1M tokens, p50 latency, strengths, max difficulty. Costs/latencies are configured estimates, not live prices.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      const lines = [`Router catalog (${router.modelCount} models):`];
      for (const model of router.listModels()) {
        lines.push(
          `  ${model.id} — ${model.provider} (${model.kind}, ctx ${model.contextTokens}, $${model.costPer1MInputUsd}/$${model.costPer1MOutputUsd} per 1M in/out, p50 ${model.latencyMsP50}ms, max difficulty ${model.maxDifficulty})`,
        );
        lines.push(`    strengths: ${model.strengths.join(', ')} — ${model.note}`);
      }
      const failed = router.failedModels();
      if (failed.length > 0) {
        lines.push('Excluded by recent failure:');
        for (const f of failed) lines.push(`  ${f.modelId} (${f.error}, at ${f.failedAt})`);
      }
      return lines.join('\n');
    },
  };

  return [
    repoMapBuild,
    repoMapModules,
    repoMapBudgetMap,
    repoMapCalls,
    teamRun,
    teamStatus,
    evalRun,
    evalSuite,
    evalList,
    routerPick,
    routerRecordFailure,
    routerCatalog,
  ];
}

/** Unbound placeholder (same shape as CODING_V2_TOOLS). */
export const CODING_V3_TOOLS: Tool[] = createCodingV3Tools();
