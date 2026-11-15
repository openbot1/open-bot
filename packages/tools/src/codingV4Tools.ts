/**
 * Coding agent v4 tools for @open-bot/tools (v1.11, Doi T4).
 *
 * The agent drives coding v4 by tool call:
 *  - repomap_v4_build        — build/refresh repo map v4 (v3 build +
 *    PageRank v2 ranking + weighted map + cache v4 + invalidation
 *    report) (read + cache write)
 *  - repomap_v4_rank         — top files by PageRank v2 with the
 *    score breakdown (PageRank / references / freshness) (read)
 *  - repomap_v4_budget_map   — condensed repo map that fits a token
 *    budget, ranked by PageRank v2, global or by query (read)
 *  - repomap_v4_invalidate   — which files changed/added/removed
 *    since the last v4 build (cache invalidation check, no rebuild)
 *    (read)
 *  - coding_v4_subagent_start  — start a sub-agent task tree (root
 *    task) for a session (local state)
 *  - coding_v4_subagent_update — update a task node (status/progress/
 *    log/model/tokens) or add a child / complete / fail / cancel it
 *    (local state)
 *  - coding_v4_subagent_tree   — show the live task tree (text tree +
 *    counts + overall progress) (read)
 *  - coding_v4_subagent_detail — detail of one task node incl. log
 *    tail (read)
 *  - coding_v4_model_switch  — switch model between runs, keeping the
 *    transcript; the switch is logged with reason + preserved counts
 *    (local state)
 *  - coding_v4_model_history — switch log of a session (read)
 *  - coding_v4_session_status — session summary: current model,
 *    messages, switches, models used (read)
 *  - coding_v4_profile_list  — list the 6 coding profiles (read)
 *  - coding_v4_profile_get   — one coding profile in full (read)
 *  - coding_v4_profile_apply — resolve a profile for a task kind /
 *    task type (+ overrides): model + tools + system prompt (read)
 *
 * SAFETY: everything here is local — no network, no X data, no Grok
 * Imagine, no cloud VM/accounts/payments. Repo map cache lives under
 * `.open-bot/coding-v4/` in the workspace. Task trees and model
 * sessions live in memory in this process (serialize them via the
 * core classes when persistence is needed). Model switching never
 * calls any API — it only records which model the host should use
 * for the next run.
 *
 * Factory:
 *   createCodingV4Tools(opts) -> Tool[]   (bound, usable)
 *   CODING_V4_TOOLS                       (unbound placeholder)
 */

import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  CodingV4CodingSession,
  CodingV4TaskTree,
  codingV4ProfileForTaskType,
  getCodingV4Profile,
  listCodingV4Profiles,
  renderCodingV4ProfileSystemPrompt,
  resolveCodingV4Profile,
  CODING_V4_DEFAULT_BUDGET_TOKENS,
  CODING_V4_PROFILE_KINDS,
} from '@open-bot/core';
import type { CodingV4TaskStatus } from '@open-bot/core';
import { CodingV4RepoMapStore } from './codingV4RepoMap';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export const CODING_V4_TOOL_NAMES = [
  'repomap_v4_build',
  'repomap_v4_rank',
  'repomap_v4_budget_map',
  'repomap_v4_invalidate',
  'coding_v4_subagent_start',
  'coding_v4_subagent_update',
  'coding_v4_subagent_tree',
  'coding_v4_subagent_detail',
  'coding_v4_model_switch',
  'coding_v4_model_history',
  'coding_v4_session_status',
  'coding_v4_profile_list',
  'coding_v4_profile_get',
  'coding_v4_profile_apply',
] as const;

export type CodingV4ToolName = (typeof CODING_V4_TOOL_NAMES)[number];

export function isCodingV4ToolName(name: string): name is CodingV4ToolName {
  return (CODING_V4_TOOL_NAMES as readonly string[]).includes(name);
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

const TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
]);

const UPDATE_ACTIONS: ReadonlySet<string> = new Set([
  'update',
  'add-child',
  'complete',
  'fail',
  'cancel',
]);

export interface CodingV4ToolOptions {
  /** Fixed workspace directory (its repo map lives there). */
  workspaceDir?: string;
  /** Lazy workspace directory (host supplies it; overrides ctx when set). */
  getWorkspaceDir?: () => string | undefined;
  /** Pre-built repo map store (tests); defaults to one per workspaceDir. */
  repoMapStore?: CodingV4RepoMapStore;
  /** Model catalog allowed for switching (empty = any well-formed id). */
  modelCatalog?: string[];
  /** Known tool names for profile validation (defaults: no filtering). */
  knownToolNames?: string[];
}

export function createCodingV4Tools(opts: CodingV4ToolOptions = {}): Tool[] {
  const repoMapStores = new Map<string, CodingV4RepoMapStore>();
  const sessions = new Map<string, CodingV4CodingSession>();
  const trees = new Map<string, CodingV4TaskTree>();

  const resolveRoot = (ctx: ToolContext): string => {
    const dir = opts.workspaceDir ?? opts.getWorkspaceDir?.() ?? ctx.workspaceDir;
    if (!dir || typeof dir !== 'string' || dir.trim() === '') {
      throw new Error(
        'workspaceDir is required (host must pass it to createCodingV4Tools, or the tool context must carry it).',
      );
    }
    return path.resolve(dir);
  };

  const repoMapOf = (root: string): CodingV4RepoMapStore => {
    if (opts.repoMapStore) return opts.repoMapStore;
    let store = repoMapStores.get(root);
    if (!store) {
      store = new CodingV4RepoMapStore(root);
      repoMapStores.set(root, store);
    }
    return store;
  };

  const sessionKey = (root: string, sessionId: string): string => `${root}\n${sessionId}`;

  const sessionOf = (root: string, sessionId: string, fromModel?: string): CodingV4CodingSession => {
    const key = sessionKey(root, sessionId);
    let session = sessions.get(key);
    if (!session) {
      session = new CodingV4CodingSession({
        sessionId,
        modelId: fromModel,
        catalog: opts.modelCatalog,
      });
      sessions.set(key, session);
    }
    return session;
  };

  const treeOf = (root: string, sessionId: string): CodingV4TaskTree => {
    const key = sessionKey(root, sessionId);
    const tree = trees.get(key);
    if (!tree) throw new Error(`Chua co cay task cho session "${sessionId}" — goi coding_v4_subagent_start truoc.`);
    return tree;
  };

  const sessionIdArg = (args: Record<string, unknown>): string => {
    const id = getOptionalStringArg(args, 'sessionId') ?? 'default';
    if (id.trim() === '') throw new Error('sessionId khong duoc rong.');
    return id;
  };

  // --- Repo map v4 -----------------------------------------------------------

  const repoMapBuild: Tool = {
    definition: toolDef(
      'repomap_v4_build',
      'Build or refresh the coding-v4 repo map (v1.11, read + cache write): v3 incremental build plus PageRank v2 ranking (weighted PageRank + reference frequency + freshness), a weighted file->file map, and a v4 cache (.open-bot/coding-v4/repo-map-v4.json). Reports which files changed/added/removed since the last v4 build (cache invalidation). Supports TS/TSX/JS/JSX/Python, max 2000 files / 1 MB per file.',
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
          `Repo map v4 built for ${result.rootDir} in ${result.durationMs}ms.`,
          `Files: ${result.files}, symbols: ${result.symbols}, edges: ${result.edges} (v2 graph); call edges: ${result.callEdges}; modules: ${result.modules}${result.topModule ? `; top module: ${result.topModule.module} (score ${result.topModule.score.toFixed(4)})` : ''}.`,
          `PageRank v2 weights: PageRank ${result.weights.pageRank.toFixed(2)}, references ${result.weights.references.toFixed(2)}, freshness ${result.weights.freshness.toFixed(2)}${result.topFile ? `; top file: ${result.topFile.relPath} (score ${result.topFile.score.toFixed(4)})` : ''}.`,
          `Invalidation vs last v4 build: ${result.changed} changed, ${result.added} added, ${result.removed} removed.`,
          `Scanned: ${result.scanned} files — re-parsed ${result.reparsed}, reused from cache ${result.reused}, removed ${result.removed}.`,
          `Cache v4: ${result.v4CachePath} (${result.v4CacheWritten ? 'written' : 'NOT written'}).`,
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

  const repoMapRank: Tool = {
    definition: toolDef(
      'repomap_v4_rank',
      'Top files by PageRank v2 (v1.11, read): each file with its combined score and the 3-component breakdown (PageRank / reference frequency / freshness). Optional custom weights re-rank in memory without rebuilding. Builds the map first when it has never been built.',
      {
        limit: { type: 'number', description: 'Max files to return (default 10).' },
        weightPageRank: { type: 'number', description: 'Custom PageRank weight (default 0.5).' },
        weightReferences: { type: 'number', description: 'Custom reference-frequency weight (default 0.3).' },
        weightFreshness: { type: 'number', description: 'Custom freshness weight (default 0.2).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        await store.ensureBuilt();
        const limit = getNumberArg(args, 'limit') ?? 10;
        const customWeights =
          getNumberArg(args, 'weightPageRank') !== undefined ||
          getNumberArg(args, 'weightReferences') !== undefined ||
          getNumberArg(args, 'weightFreshness') !== undefined;
        const ranks = customWeights
          ? store
              .rankWithWeights({
                weights: {
                  pageRank: getNumberArg(args, 'weightPageRank'),
                  references: getNumberArg(args, 'weightReferences'),
                  freshness: getNumberArg(args, 'weightFreshness'),
                },
              })
              .ranks.slice(0, Math.max(0, limit))
          : store.topFiles(limit);
        const ranking = store.getRanking();
        const lines: string[] = [
          `Repo map v4 ranking for ${root} (${ranks.length} file(s)${customWeights ? ', custom weights' : ''}; weights PageRank ${ranking?.weights.pageRank.toFixed(2) ?? '?'}, references ${ranking?.weights.references.toFixed(2) ?? '?'}, freshness ${ranking?.weights.freshness.toFixed(2) ?? '?'}):`,
        ];
        for (const r of ranks) {
          lines.push(
            `#${r.rank} ${r.relPath} (v4 ${r.score.toFixed(4)} = pr ${r.pageRankScore.toFixed(2)}, ref ${r.referenceScore.toFixed(2)}, fresh ${r.freshnessScore.toFixed(2)}; ${r.symbols} symbols)`,
          );
        }
        if (ranks.length === 0) lines.push('(no files ranked yet — build the map first)');
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const repoMapBudgetMap: Tool = {
    definition: toolDef(
      'repomap_v4_budget_map',
      'Condensed repo map that fits a token budget, ranked by PageRank v2 (v1.11, read): top files with their top symbols and the v4 score breakdown, cut to fit the budget (estimated tokens = chars/4). With a query, matching files/symbols rank first. Builds the map first when it has never been built.',
      {
        query: { type: 'string', description: 'Optional query (symbol/file/topic) — matching files rank first.' },
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
        const budgetTokens = getNumberArg(args, 'budgetTokens') ?? CODING_V4_DEFAULT_BUDGET_TOKENS;
        const query = getOptionalStringArg(args, 'query');
        const map = store.budgetMap(budgetTokens, query);
        const lines: string[] = [
          `Budget map v4: ~${map.estimatedTokens} tokens (budget ${map.budgetTokens}), ${map.includedFiles.length}/${map.totalFiles} files included${map.truncated ? `, ${map.excludedFiles.length} cut by budget` : ''}.`,
        ];
        if (query && 'seedFiles' in map) {
          const seedFiles = (map as { seedFiles?: string[] }).seedFiles ?? [];
          if (seedFiles.length > 0) {
            lines.push(`Seed files: ${seedFiles.slice(0, 5).join(', ')}${seedFiles.length > 5 ? '…' : ''}.`);
          } else {
            lines.push(`Query "${query}" matched nothing — showing the global ranking.`);
          }
        }
        lines.push(map.text);
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const repoMapInvalidate: Tool = {
    definition: toolDef(
      'repomap_v4_invalidate',
      'Cache-invalidation check for the coding-v4 repo map (v1.11, read): scans file fingerprints on disk and compares them with the last v4 build cache, reporting changed / added / removed (stale) files without rebuilding. When files changed, run repomap_v4_build to refresh.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      void args;
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        const plan = store.invalidate();
        const lines = [
          `Repo map v4 invalidation for ${root}: scanned ${plan.scannedFiles} files, cache holds ${plan.cachedFiles}.`,
          `Unchanged: ${plan.unchanged.length}; changed: ${plan.changed.length}; added: ${plan.added.length}; removed (stale): ${plan.removed.length}.`,
          plan.needsRebuild
            ? 'Rebuild needed — run repomap_v4_build to refresh the ranking.'
            : 'Cache is fresh — no rebuild needed.',
        ];
        for (const rel of plan.changed.slice(0, 10)) lines.push(`  changed: ${rel}`);
        for (const rel of plan.added.slice(0, 10)) lines.push(`  added: ${rel}`);
        for (const rel of plan.removed.slice(0, 10)) lines.push(`  removed: ${rel}`);
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // --- Sub-agent task visualizer ---------------------------------------------

  const subagentStart: Tool = {
    definition: toolDef(
      'coding_v4_subagent_start',
      'Start a sub-agent task tree for a coding session (v1.11, local state): creates the root task; use coding_v4_subagent_update to add child tasks and update progress, and coding_v4_subagent_tree to watch it live in chat.',
      {
        sessionId: { type: 'string', description: 'Session id (default "default").' },
        title: { type: 'string', description: 'Root task title, e.g. "Implement user auth".' },
        replace: { type: 'boolean', description: 'Replace an existing tree for this session (default false).' },
      },
      ['title'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const sessionId = sessionIdArg(args);
        const title = getStringArg(args, 'title');
        const replace = getBooleanArg(args, 'replace') ?? false;
        const key = sessionKey(root, sessionId);
        if (trees.has(key) && !replace) {
          return errorResult(
            `Session "${sessionId}" da co cay task — dung coding_v4_subagent_update, hoac dat replace=true de tao lai.`,
          );
        }
        const tree = new CodingV4TaskTree(title, { sessionId });
        tree.startRoot();
        trees.set(key, tree);
        return truncate(
          `Task tree started for session "${sessionId}": root "${title}" (id "root", running).\n${tree.renderText()}`,
          MAX_TOOL_RESULT_CHARS,
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const subagentUpdate: Tool = {
    definition: toolDef(
      'coding_v4_subagent_update',
      'Update a sub-agent task node (v1.11, local state). Actions: "update" (status/progress/log/model/tokens), "add-child" (add a child task under nodeId), "complete", "fail", "cancel". The tree version bumps on every change so the chat UI can live-update only the changed rows.',
      {
        sessionId: { type: 'string', description: 'Session id (default "default").' },
        nodeId: { type: 'string', description: 'Task node id ("root" for the root task).' },
        action: { type: 'string', description: 'One of: update, add-child, complete, fail, cancel (default update).' },
        title: { type: 'string', description: 'Child task title (add-child only).' },
        status: { type: 'string', description: 'New status: pending, running, done, failed, cancelled.' },
        progress: { type: 'number', description: 'Progress 0-100.' },
        logLine: { type: 'string', description: 'One log line to append (kept, capped at 50 lines per node).' },
        model: { type: 'string', description: 'Model running this task.' },
        tokensUsed: { type: 'number', description: 'Tokens used by this task.' },
        error: { type: 'string', description: 'Error / cancel reason.' },
        detail: { type: 'string', description: 'Short spec / detail for the task.' },
      },
      ['nodeId'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const sessionId = sessionIdArg(args);
        const tree = treeOf(root, sessionId);
        const nodeId = getStringArg(args, 'nodeId');
        const action = getOptionalStringArg(args, 'action') ?? 'update';
        if (!UPDATE_ACTIONS.has(action)) {
          return errorResult(`action "${action}" khong hop le (update, add-child, complete, fail, cancel).`);
        }
        if (action === 'add-child') {
          const title = getStringArg(args, 'title');
          const child = tree.addTask(nodeId === 'root' ? null : nodeId, title, {
            detail: getOptionalStringArg(args, 'detail'),
            model: getOptionalStringArg(args, 'model'),
          });
          return truncate(
            `Added child task "${title}" (id "${child.id}") under "${nodeId}" in session "${sessionId}" (tree v${tree.version}).\n${tree.renderText()}`,
            MAX_TOOL_RESULT_CHARS,
          );
        }
        if (action === 'complete') {
          if (!tree.completeTask(nodeId, getOptionalStringArg(args, 'logLine'))) {
            return errorResult(`Khong tim thay task "${nodeId}" trong session "${sessionId}".`);
          }
          return truncate(`Task "${nodeId}" done (tree v${tree.version}).\n${tree.renderText()}`, MAX_TOOL_RESULT_CHARS);
        }
        if (action === 'fail') {
          const error = getStringArg(args, 'error');
          if (!tree.failTask(nodeId, error)) {
            return errorResult(`Khong tim thay task "${nodeId}" trong session "${sessionId}".`);
          }
          return truncate(`Task "${nodeId}" failed: ${error} (tree v${tree.version}).\n${tree.renderText()}`, MAX_TOOL_RESULT_CHARS);
        }
        if (action === 'cancel') {
          if (!tree.cancelTask(nodeId, getOptionalStringArg(args, 'error'))) {
            return errorResult(`Khong tim thay task "${nodeId}" trong session "${sessionId}".`);
          }
          return truncate(`Task "${nodeId}" cancelled (tree v${tree.version}).\n${tree.renderText()}`, MAX_TOOL_RESULT_CHARS);
        }
        const statusRaw = getOptionalStringArg(args, 'status');
        if (statusRaw !== undefined && !TASK_STATUSES.has(statusRaw)) {
          return errorResult(`status "${statusRaw}" khong hop le (pending, running, done, failed, cancelled).`);
        }
        const ok = tree.updateTask(nodeId, {
          status: statusRaw as CodingV4TaskStatus | undefined,
          progress: getNumberArg(args, 'progress'),
          logLine: getOptionalStringArg(args, 'logLine'),
          model: getOptionalStringArg(args, 'model'),
          tokensUsed: getNumberArg(args, 'tokensUsed'),
          error: getOptionalStringArg(args, 'error'),
          detail: getOptionalStringArg(args, 'detail'),
        });
        if (!ok) return errorResult(`Khong tim thay task "${nodeId}" trong session "${sessionId}".`);
        return truncate(
          `Task "${nodeId}" updated (tree v${tree.version}, overall ${tree.overallProgress()}%).\n${tree.renderText()}`,
          MAX_TOOL_RESULT_CHARS,
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const subagentTree: Tool = {
    definition: toolDef(
      'coding_v4_subagent_tree',
      'Show the live sub-agent task tree of a session (v1.11, read): indented tree with status, progress, model and tokens per task, plus counts by status and overall progress. The tree version tells the chat UI whether it changed since the last render.',
      {
        sessionId: { type: 'string', description: 'Session id (default "default").' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const sessionId = sessionIdArg(args);
        const tree = treeOf(root, sessionId);
        const counts = tree.countsByStatus();
        const header = `Task tree for session "${sessionId}" (v${tree.version}, ${tree.flatten().length} tasks, overall ${tree.overallProgress()}%): pending ${counts.pending}, running ${counts.running}, done ${counts.done}, failed ${counts.failed}, cancelled ${counts.cancelled}.`;
        return truncate(`${header}\n${tree.renderText()}`, MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const subagentDetail: Tool = {
    definition: toolDef(
      'coding_v4_subagent_detail',
      'Detail of one sub-agent task node (v1.11, read): title, status, progress, model, tokens, timestamps, error, child tasks, and the last log lines. Click a task in the chat UI to open this detail.',
      {
        sessionId: { type: 'string', description: 'Session id (default "default").' },
        nodeId: { type: 'string', description: 'Task node id.' },
      },
      ['nodeId'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const sessionId = sessionIdArg(args);
        const tree = treeOf(root, sessionId);
        const nodeId = getStringArg(args, 'nodeId');
        const node = tree.find(nodeId);
        if (!node) return errorResult(`Khong tim thay task "${nodeId}" trong session "${sessionId}".`);
        const lines = [
          `Task "${node.title}" (id "${node.id}", session "${sessionId}"):`,
          `  Status: ${node.status}, progress: ${node.progress}% (rollup ${tree.overallProgress()}% overall).`,
        ];
        if (node.detail) lines.push(`  Detail: ${node.detail}`);
        if (node.model) lines.push(`  Model: ${node.model}`);
        if (node.tokensUsed !== undefined) lines.push(`  Tokens used: ${node.tokensUsed}`);
        if (node.startedAt) lines.push(`  Started: ${node.startedAt}`);
        if (node.finishedAt) lines.push(`  Finished: ${node.finishedAt}`);
        if (node.error) lines.push(`  Error: ${node.error}`);
        lines.push(`  Children (${node.children.length}): ${node.children.map((c) => `${c.id} (${c.status}, ${c.progress}%)`).join(', ') || '(none)'}`);
        lines.push(`  Log (${node.log.length} line(s)${node.logTruncated > 0 ? `, ${node.logTruncated} older line(s) trimmed` : ''}):`);
        for (const line of node.log.slice(-10)) lines.push(`    | ${line}`);
        if (node.log.length === 0) lines.push('    (no log yet)');
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // --- ACP-style model switching ---------------------------------------------

  const modelSwitch: Tool = {
    definition: toolDef(
      'coding_v4_model_switch',
      'Switch the model between runs, keeping the transcript (v1.11, local state): the session keeps every message, the switch is logged with reason and preserved message/character counts, and the new model applies from the next run. Optionally append one message to the transcript before switching.',
      {
        sessionId: { type: 'string', description: 'Session id (default "default").' },
        fromModel: { type: 'string', description: 'Current model when creating a new session (default ollama/qwen2.5-coder:7b).' },
        toModel: { type: 'string', description: 'Model to switch to, e.g. "gemini-2.5-flash".' },
        reason: { type: 'string', description: 'Why switch (required, logged).' },
        message: { type: 'string', description: 'Optional message to append to the transcript before switching.' },
        messageRole: { type: 'string', description: 'Role of the message: user or assistant (default user).' },
      },
      ['toModel', 'reason'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const sessionId = sessionIdArg(args);
        const session = sessionOf(root, sessionId, getOptionalStringArg(args, 'fromModel'));
        const message = getOptionalStringArg(args, 'message');
        if (message !== undefined) {
          const roleRaw = getOptionalStringArg(args, 'messageRole') ?? 'user';
          if (roleRaw !== 'user' && roleRaw !== 'assistant' && roleRaw !== 'system' && roleRaw !== 'tool') {
            return errorResult(`messageRole "${roleRaw}" khong hop le (user, assistant, system, tool).`);
          }
          session.addMessage(roleRaw, message);
        }
        const toModel = getStringArg(args, 'toModel');
        const reason = getStringArg(args, 'reason');
        const record = session.switchModel(toModel, reason);
        return truncate(
          `Model switched in session "${sessionId}": ${record.fromModelId} -> ${record.toModelId} (${record.at}).\n` +
            `Reason: ${record.reason}. Transcript kept: ${record.preservedMessages} message(s), ${record.transcriptChars} chars.`,
          MAX_TOOL_RESULT_CHARS,
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const modelHistory: Tool = {
    definition: toolDef(
      'coding_v4_model_history',
      'Switch log of a coding session (v1.11, read): every model switch with from/to, time, reason and how much transcript was preserved. Shows the current model when the session never switched.',
      {
        sessionId: { type: 'string', description: 'Session id (default "default").' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const sessionId = sessionIdArg(args);
        const session = sessionOf(root, sessionId);
        return truncate(session.renderSwitchHistory(), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const sessionStatus: Tool = {
    definition: toolDef(
      'coding_v4_session_status',
      'Session summary (v1.11, read): current model, message count, transcript size, switch count, models used, and last switch time. Creates the session (with the default model) when it does not exist yet.',
      {
        sessionId: { type: 'string', description: 'Session id (default "default").' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const sessionId = sessionIdArg(args);
        const session = sessionOf(root, sessionId);
        const s = session.summary();
        const lines = [
          `Session "${s.sessionId}": model ${s.modelId}.`,
          `Messages: ${s.messages} (${s.transcriptChars} chars); switches: ${s.switches}; models used: ${s.modelsUsed.join(', ') || '(none)'}.`,
        ];
        if (s.lastSwitchAt) lines.push(`Last switch: ${s.lastSwitchAt}.`);
        lines.push(`Created: ${s.createdAt}; updated: ${s.updatedAt}.`);
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // --- Coding profiles ---------------------------------------------------------

  const profileList: Tool = {
    definition: toolDef(
      'coding_v4_profile_list',
      'List the 6 coding agent profiles (v1.11, read): debug, refactor, feature, review, test, explore — each with its suggested model, allowed tools, step/token limits and a short description.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const lines = ['Coding profiles (v4, 6 kinds):'];
        for (const p of listCodingV4Profiles()) {
          lines.push(
            `- ${p.id} (${p.kind}): ${p.label} — model ${p.modelId} (fallbacks: ${p.fallbackModelIds.join(', ')}); ${p.tools.length} tools; max ${p.maxSteps} steps, ${p.budgetTokens} tokens.`,
          );
          lines.push(`  ${p.description}`);
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const profileGet: Tool = {
    definition: toolDef(
      'coding_v4_profile_get',
      'One coding agent profile in full (v1.11, read): model + fallbacks, allowed tools, system prompt, step/token limits and do/don\'t rules. Look up by kind ("debug") or id ("coding-debug").',
      {
        kind: { type: 'string', description: 'Profile kind or id: debug, refactor, feature, review, test, explore.' },
      },
      ['kind'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const kind = getStringArg(args, 'kind');
        const profile = getCodingV4Profile(kind);
        if (!profile) {
          return errorResult(
            `Khong co coding profile "${kind}" (debug, refactor, feature, review, test, explore).`,
          );
        }
        const lines = [
          `Profile ${profile.id} (${profile.kind}): ${profile.label}.`,
          profile.description,
          `Model: ${profile.modelId}; fallbacks: ${profile.fallbackModelIds.join(', ')}.`,
          `Allowed tools (${profile.tools.length}): ${profile.tools.join(', ')}.`,
          `Max steps: ${profile.maxSteps}; repo-map budget: ${profile.budgetTokens} tokens.`,
          '',
          renderCodingV4ProfileSystemPrompt(profile),
        ];
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const profileApply: Tool = {
    definition: toolDef(
      'coding_v4_profile_apply',
      'Resolve a coding profile for a task (v1.11, read): pick by kind ("debug") or by task type ("fix" maps to debug, "codegen" to feature, "plan"/"chat" to explore). Optional overrides for model, max steps and budget. Returns the resolved model + tools + full system prompt the host should apply; unknown tools are dropped with a warning.',
      {
        kind: { type: 'string', description: 'Profile kind or id.' },
        taskType: { type: 'string', description: 'Router task type instead of kind: codegen, refactor, review, explore, plan, fix, test, chat.' },
        modelId: { type: 'string', description: 'Override the suggested model.' },
        maxSteps: { type: 'number', description: 'Override max steps.' },
        budgetTokens: { type: 'number', description: 'Override the repo-map token budget.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const kindRaw = getOptionalStringArg(args, 'kind');
        const taskTypeRaw = getOptionalStringArg(args, 'taskType');
        if (!kindRaw && !taskTypeRaw) {
          return errorResult('coding_v4_profile_apply can kind hoac taskType.');
        }
        const kind = kindRaw ?? codingV4ProfileForTaskType(taskTypeRaw as string);
        const overrides: {
          modelId?: string;
          maxSteps?: number;
          budgetTokens?: number;
        } = {};
        const modelId = getOptionalStringArg(args, 'modelId');
        if (modelId !== undefined) overrides.modelId = modelId;
        const maxSteps = getNumberArg(args, 'maxSteps');
        if (maxSteps !== undefined) overrides.maxSteps = maxSteps;
        const budgetTokens = getNumberArg(args, 'budgetTokens');
        if (budgetTokens !== undefined) overrides.budgetTokens = budgetTokens;
        const { profile, warnings } = resolveCodingV4Profile(kind, {
          overrides,
          knownTools: opts.knownToolNames,
        });
        const lines = [
          `Profile applied: ${profile.id} (${profile.kind})${taskTypeRaw ? ` for task type "${taskTypeRaw}"` : ''}.`,
          `Model: ${profile.modelId}; fallbacks: ${profile.fallbackModelIds.join(', ')}.`,
          `Allowed tools (${profile.tools.length}): ${profile.tools.join(', ') || '(none)'}.`,
          `Max steps: ${profile.maxSteps}; repo-map budget: ${profile.budgetTokens} tokens.`,
        ];
        for (const w of warnings) lines.push(`Warning: ${w}`);
        lines.push('', renderCodingV4ProfileSystemPrompt(profile));
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    repoMapBuild,
    repoMapRank,
    repoMapBudgetMap,
    repoMapInvalidate,
    subagentStart,
    subagentUpdate,
    subagentTree,
    subagentDetail,
    modelSwitch,
    modelHistory,
    sessionStatus,
    profileList,
    profileGet,
    profileApply,
  ];
}

export const CODING_V4_TOOLS: Tool[] = createCodingV4Tools();
