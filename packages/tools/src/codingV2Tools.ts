/**
 * Coding agent v2 tools for @open-bot/tools (v1.08, Đội T2).
 *
 * The agent drives coding v2 by tool call:
 *  - coding_v2_repo_map_build   — build/refresh the symbol-level repo
 *    map (incremental: only changed/new files are re-parsed; entries
 *    cached on disk) (read + cache write)
 *  - coding_v2_repo_map_query   — "which files are most related to X"
 *    (Personalized PageRank seeded by the query) (read)
 *  - coding_v2_repo_map_symbol  — one symbol: definition, references,
 *    dependents (read)
 *  - coding_v2_architect_plan   — planner creates a plan (steps +
 *    files each step may touch, no code written) (local action)
 *  - coding_v2_architect_execute — editor executes ONE planned step;
 *    planner reviews the diff; deviation blocks the plan (local action)
 *  - coding_v2_architect_status — plan status, progress, review log (read)
 *  - coding_v2_git_commit       — commit edits as one step-commit
 *    (message records plan/step) (local action)
 *  - coding_v2_git_diff         — diff view: worktree, staged, one
 *    commit, or a range (read)
 *  - coding_v2_git_revert       — revert one commit (local action)
 *  - coding_v2_git_squash       — squash a commit range into one
 *    commit (local action)
 *
 * SAFETY: everything here is local — no network, no X data, no Grok
 * Imagine, no cloud VM/accounts/payments. Repo map cache lives under
 * `.open-bot/coding-v2/` in the workspace. Architect edits go through
 * the confined v1 `Workspace`; git runs only allowlisted subcommands
 * with structured argv (no push/fetch/remote). Write tools need
 * approval; reads do not.
 *
 * Factory:
 *   createCodingV2Tools(opts) -> Tool[]   (bound, usable)
 *   CODING_V2_TOOLS                       (unbound placeholder)
 */

import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  CodingV2ArchitectSession,
  CodingV2GitSession,
  CODING_V2_MAX_STEP_LINE_CHANGES,
} from '@open-bot/core';
import type {
  CodingV2ArchitectEdit,
  CodingV2ArchitectStepKind,
} from '@open-bot/core';
import { CodingV2RepoMapStore } from './codingV2RepoMap';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export const CODING_V2_TOOL_NAMES = [
  'coding_v2_repo_map_build',
  'coding_v2_repo_map_query',
  'coding_v2_repo_map_symbol',
  'coding_v2_architect_plan',
  'coding_v2_architect_execute',
  'coding_v2_architect_status',
  'coding_v2_git_commit',
  'coding_v2_git_diff',
  'coding_v2_git_revert',
  'coding_v2_git_squash',
] as const;

export type CodingV2ToolName = (typeof CODING_V2_TOOL_NAMES)[number];

export function isCodingV2ToolName(name: string): name is CodingV2ToolName {
  return (CODING_V2_TOOL_NAMES as readonly string[]).includes(name);
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

function getObjectArrayArg(args: Record<string, unknown>, name: string): Array<Record<string, unknown>> {
  const value = args[name];
  if (value === undefined || value === null) {
    throw new Error(`Missing required argument: "${name}"`);
  }
  if (!Array.isArray(value) || value.some((v) => !v || typeof v !== 'object' || Array.isArray(v))) {
    throw new Error(`Argument "${name}" must be an array of objects.`);
  }
  return value as Array<Record<string, unknown>>;
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

const ARCHITECT_STEP_KINDS: ReadonlySet<string> = new Set(['explore', 'implement', 'verify', 'finish']);
const ARCHITECT_EDIT_KINDS: ReadonlySet<string> = new Set(['create', 'write', 'edit', 'delete']);

export interface CodingV2ToolOptions {
  /** Fixed workspace directory (its repo map / architect session / git repo). */
  workspaceDir?: string;
  /** Lazy workspace directory (host supplies it; overrides ctx when set). */
  getWorkspaceDir?: () => string | undefined;
  /** Pre-built architect session (tests); defaults to one per workspaceDir. */
  architectSession?: CodingV2ArchitectSession;
  /** Pre-built repo map store (tests); defaults to one per workspaceDir. */
  repoMapStore?: CodingV2RepoMapStore;
}

export function createCodingV2Tools(opts: CodingV2ToolOptions = {}): Tool[] {
  const architectSessions = new Map<string, CodingV2ArchitectSession>();
  const repoMapStores = new Map<string, CodingV2RepoMapStore>();

  const resolveRoot = (ctx: ToolContext): string => {
    const dir = opts.workspaceDir ?? opts.getWorkspaceDir?.() ?? ctx.workspaceDir;
    if (!dir || typeof dir !== 'string' || dir.trim() === '') {
      throw new Error(
        'workspaceDir is required (host must pass it to createCodingV2Tools, or the tool context must carry it).',
      );
    }
    return path.resolve(dir);
  };

  const architectOf = (root: string): CodingV2ArchitectSession => {
    if (opts.architectSession) return opts.architectSession;
    let session = architectSessions.get(root);
    if (!session) {
      session = new CodingV2ArchitectSession(root);
      architectSessions.set(root, session);
    }
    return session;
  };

  const repoMapOf = (root: string): CodingV2RepoMapStore => {
    if (opts.repoMapStore) return opts.repoMapStore;
    let store = repoMapStores.get(root);
    if (!store) {
      store = new CodingV2RepoMapStore(root);
      repoMapStores.set(root, store);
    }
    return store;
  };

  /** repoDir arg must stay inside the workspace root (confinement). */
  const resolveRepoDir = (root: string, repoDir: string | undefined): string => {
    if (!repoDir) return root;
    const resolved = path.resolve(root, repoDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`repoDir "${repoDir}" escapes the workspace root.`);
    }
    return resolved;
  };

  const repoMapBuild: Tool = {
    definition: toolDef(
      'coding_v2_repo_map_build',
      'Build or refresh the coding-v2 repo map (v1.08, read + cache write): symbol-level graph (symbols + imports, PageRank) over the workspace, updated incrementally — only changed/new files are re-parsed, unchanged files reuse the on-disk cache (.open-bot/coding-v2/repo-map-v2.json). Supports TS/TSX/JS/JSX/Python, max 2000 files / 1 MB per file. Returns files/symbols/edges, how many files were re-parsed vs reused vs removed, and warnings.',
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
          `Repo map v2 built for ${result.rootDir} in ${result.durationMs}ms.`,
          `Files: ${result.files}, symbols: ${result.symbols}, edges: ${result.edges}.`,
          `Scanned: ${result.scanned} files — re-parsed ${result.reparsed}, reused from cache ${result.reused}, removed ${result.removed}.`,
          `Cache: ${result.cachePath} (${result.cacheWritten ? 'written' : 'NOT written'}; ${result.cacheFresh ? 'already fresh' : 'refreshed'}).`,
        ];
        if (result.fallbackFiles.length > 0) {
          lines.push(`Regex fallback (tree-sitter unavailable) for ${result.fallbackFiles.length} file(s): ${result.fallbackFiles.slice(0, 5).join(', ')}${result.fallbackFiles.length > 5 ? '…' : ''}.`);
        }
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

  const repoMapQuery: Tool = {
    definition: toolDef(
      'coding_v2_repo_map_query',
      'Ask the coding-v2 repo map "which files are most related to X" (v1.08, read): Personalized PageRank seeded by files/symbols whose names match the query (file path or symbol name). Returns top files with their top symbols and whether each is a direct seed match or pulled in by rank. An empty query, or one matching nothing, falls back to the global PageRank ranking. Builds the map first when it has never been built.',
      {
        query: { type: 'string', description: 'Symbol name, file path fragment, or topic, e.g. "CodingV2GitSession" or "repoMap".' },
        limit: { type: 'number', description: 'Max files to return (default 10).' },
        symbolLimit: { type: 'number', description: 'Max symbols to return (default 10).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        await store.ensureBuilt();
        const query = getStringArg(args, 'query');
        const result = store.query(query, {
          limit: getNumberArg(args, 'limit') ?? 10,
          symbolLimit: getNumberArg(args, 'symbolLimit') ?? 10,
        });
        const lines: string[] = [
          `Repo map v2 query "${result.query}" (${result.totalFiles} files, ${result.totalSymbols} symbols in map).`,
        ];
        if (result.fellBackToGlobal) {
          lines.push('No seed match — showing the global PageRank ranking instead.');
        } else {
          lines.push(`Seed files: ${result.seedFiles.join(', ') || '(none)'}; seed symbols: ${result.seedSymbols.length}.`);
        }
        if (result.files.length === 0) lines.push('No files in the map yet — build it first.');
        for (const file of result.files) {
          lines.push(`#${file.rank} ${file.relPath} (score ${file.score.toFixed(4)}, ${file.match})`);
          for (const symbol of file.topSymbols) {
            lines.push(`    ${symbol.kind} ${symbol.qualifiedName} (line ${symbol.line}, score ${symbol.score.toFixed(4)})`);
          }
        }
        if (result.symbols.length > 0) {
          lines.push('Top symbols:');
          for (const symbol of result.symbols) {
            lines.push(`  ${symbol.qualifiedName} — ${symbol.file}:${symbol.line} (score ${symbol.score.toFixed(4)})`);
          }
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const repoMapSymbol: Tool = {
    definition: toolDef(
      'coding_v2_repo_map_symbol',
      'Detail for one symbol in the coding-v2 repo map (v1.08, read): where it is defined (file, line, kind, PageRank score) and which files reference it. Give the qualified name (e.g. "Foo.save") or the short name (e.g. "save"); multiple definitions with the same name are all listed.',
      {
        name: { type: 'string', description: 'Qualified or short symbol name.' },
      },
      ['name'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        await store.ensureBuilt();
        const detail = store.symbolDetail(getStringArg(args, 'name'));
        if (!detail.found) return `Symbol "${getStringArg(args, 'name')}" not found in the repo map v2.`;
        const lines: string[] = [`${detail.matches.length} definition(s) for "${getStringArg(args, 'name')}":`];
        for (const match of detail.matches) {
          lines.push(
            `${match.kind} ${match.qualifiedName} — ${match.file}:${match.line} (score ${match.score.toFixed(4)})`,
          );
          if (match.referencedBy.length > 0) {
            lines.push(
              `  Referenced by: ${match.referencedBy.map((r) => `${r.file} (w ${r.weight.toFixed(1)})`).join(', ')}`,
            );
          } else {
            lines.push('  Referenced by: (no other file references it)');
          }
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const architectPlan: Tool = {
    definition: toolDef(
      'coding_v2_architect_plan',
      'Planner creates an architect plan (v1.08, local action, writes no code): a task plus ordered steps (explore/implement/verify/finish), each step declaring the files it may touch. The plan is immutable once created; the editor may only execute its steps. Implement steps must declare at least one file. Returns the plan id and step ids — pass them to coding_v2_architect_execute.',
      {
        task: { type: 'string', description: 'What the plan should achieve.' },
        steps: {
          type: 'array',
          description: 'Ordered steps: { kind: explore|implement|verify|finish, description, files?: string[] (workspace-relative) }.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              description: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
            },
            required: ['kind', 'description'],
          },
        },
      },
      ['task', 'steps'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const session = architectOf(root);
        const task = getStringArg(args, 'task');
        const rawSteps = getObjectArrayArg(args, 'steps');
        const steps = rawSteps.map((raw, i) => {
          const kind = raw.kind;
          if (typeof kind !== 'string' || !ARCHITECT_STEP_KINDS.has(kind)) {
            throw new Error(`steps[${i}].kind "${String(kind)}" is invalid (explore/implement/verify/finish).`);
          }
          const description = raw.description;
          if (typeof description !== 'string' || description.trim() === '') {
            throw new Error(`steps[${i}].description must be a non-empty string.`);
          }
          let files: string[] | undefined;
          if (raw.files !== undefined) {
            if (!Array.isArray(raw.files) || raw.files.some((f) => typeof f !== 'string')) {
              throw new Error(`steps[${i}].files must be an array of strings.`);
            }
            files = raw.files as string[];
          }
          return { kind: kind as CodingV2ArchitectStepKind, description, files };
        });
        const plan = session.createPlan(task, steps);
        const lines = [
          `Architect plan created: ${plan.id}`,
          `Task: ${plan.task}`,
          `Status: ${plan.status} — ${plan.steps.length} step(s), 0% done.`,
        ];
        for (const step of plan.steps) {
          lines.push(`  [${step.id}] ${step.kind}: ${step.description}${step.files.length > 0 ? ` (files: ${step.files.join(', ')})` : ''}`);
        }
        lines.push('The planner wrote no code. Execute one step at a time with coding_v2_architect_execute.');
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const architectExecute: Tool = {
    definition: toolDef(
      'coding_v2_architect_execute',
      'Editor executes ONE step of an architect plan (v1.08, local action, needs approval): applies the given edits through the confined workspace, then the planner reviews the diff immediately. If the diff touches a file the step did not declare, deletes an undeclared file, or exceeds the per-step line-change cap, the step FAILS, the plan is BLOCKED, and execution stops so the user can be asked — nothing further runs on its own. Edits: { path, kind: create|write|edit|delete, content?, oldText?, newText? }.',
      {
        planId: { type: 'string', description: 'Plan id from coding_v2_architect_plan.' },
        stepId: { type: 'string', description: 'Step id from the plan.' },
        edits: {
          type: 'array',
          description: 'Edits to apply, in order.',
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
      ['planId', 'stepId', 'edits'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const session = architectOf(root);
        const planId = getStringArg(args, 'planId');
        const stepId = getStringArg(args, 'stepId');
        const rawEdits = getObjectArrayArg(args, 'edits');
        const edits: CodingV2ArchitectEdit[] = rawEdits.map((raw, i) => {
          const editPath = raw.path;
          if (typeof editPath !== 'string' || editPath.trim() === '') {
            throw new Error(`edits[${i}].path must be a non-empty string.`);
          }
          const kind = raw.kind;
          if (typeof kind !== 'string' || !ARCHITECT_EDIT_KINDS.has(kind)) {
            throw new Error(`edits[${i}].kind "${String(kind)}" is invalid (create/write/edit/delete).`);
          }
          const edit: CodingV2ArchitectEdit = { path: editPath, kind: kind as CodingV2ArchitectEdit['kind'] };
          if (typeof raw.content === 'string') edit.content = raw.content;
          if (typeof raw.oldText === 'string') edit.oldText = raw.oldText;
          if (typeof raw.newText === 'string') edit.newText = raw.newText;
          return edit;
        });
        const result = session.executeStep(planId, stepId, edits);
        const lines = [result.summary, `Plan status: ${result.plan.status}.`];
        lines.push(`Review verdict: ${result.review.verdict}.`);
        for (const change of result.review.filesChanged) {
          lines.push(`  ${change.path} (${change.kind}, +${change.linesAdded}/-${change.linesRemoved})`);
        }
        for (const deviation of result.review.deviations) lines.push(`  Deviation: ${deviation}`);
        lines.push(`Per-step line-change cap: ${CODING_V2_MAX_STEP_LINE_CHANGES} lines.`);
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const architectStatus: Tool = {
    definition: toolDef(
      'coding_v2_architect_status',
      'Architect plan status (v1.08, read): progress, step states, and the planner review log for one plan (planId), or a list of all plans in this workspace when planId is omitted.',
      {
        planId: { type: 'string', description: 'Plan id (optional — omit to list all plans).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const session = architectOf(root);
        const planId = getOptionalStringArg(args, 'planId');
        const formatPlan = (plan: ReturnType<typeof session.getPlan>): string => {
          if (!plan) return 'Plan not found.';
          const lines = [
            `Plan ${plan.id} — ${plan.status} (${plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length}/${plan.steps.length} steps done)`,
            `Task: ${plan.task}`,
          ];
          for (const step of plan.steps) {
            lines.push(`  [${step.status}] ${step.kind}: ${step.description}${step.note ? ` — ${step.note}` : ''}`);
          }
          for (const review of session.reviewsFor(plan.id)) {
            lines.push(
              `  Review ${review.stepId}: ${review.verdict}${review.deviations.length > 0 ? ` — ${review.deviations.join(' ')}` : ''}`,
            );
          }
          return lines.join('\n');
        };
        if (planId) {
          const plan = session.getPlan(planId);
          if (!plan) return `Plan "${planId}" not found in this workspace.`;
          return truncate(formatPlan(plan), MAX_TOOL_RESULT_CHARS);
        }
        const plans = session.listPlans();
        if (plans.length === 0) return 'No architect plans in this workspace yet.';
        return truncate(plans.map(formatPlan).join('\n\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const gitCommit: Tool = {
    definition: toolDef(
      'coding_v2_git_commit',
      'Git-first commit: commit the given files as ONE step-commit (v1.08, local action, needs approval). The message records the plan/step when given (e.g. "[coding-v2] plan <id> step <step>: <summary>"), so every agent edit is individually revertable. No push, no remote, no identity changes — git must already have user.name/user.email configured. Fails when nothing is staged.',
      {
        files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files to stage and commit.' },
        message: { type: 'string', description: 'Short summary of the step.' },
        planId: { type: 'string', description: 'Architect plan id (optional, recorded in the message).' },
        stepId: { type: 'string', description: 'Architect step id (optional, recorded in the message).' },
        repoDir: { type: 'string', description: 'Repo directory, relative to the workspace root (default: workspace root).' },
      },
      ['files', 'message'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const repoDir = resolveRepoDir(root, getOptionalStringArg(args, 'repoDir'));
        const session = new CodingV2GitSession(repoDir);
        const result = await session.commitStep({
          files: getStringArrayArg(args, 'files'),
          message: getStringArg(args, 'message'),
          planId: getOptionalStringArg(args, 'planId'),
          stepId: getOptionalStringArg(args, 'stepId'),
        });
        return truncate(
          `Committed ${result.shortSha} (${result.sha}): ${result.message}\nFiles: ${result.files.join(', ')}`,
          MAX_TOOL_RESULT_CHARS,
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const gitDiff: Tool = {
    definition: toolDef(
      'coding_v2_git_diff',
      'Diff view (v1.08, read): the worktree diff (default), the staged diff (staged: true), one commit (commit: <sha>), or a range (from..to). Output is capped at 20,000 characters and says so when truncated. Read-only — never modifies the repo.',
      {
        commit: { type: 'string', description: 'Show one commit (full SHA or 7+ hex prefix).' },
        from: { type: 'string', description: 'Range start (SHA or HEAD).' },
        to: { type: 'string', description: 'Range end (SHA or HEAD).' },
        staged: { type: 'boolean', description: 'Show the staged diff instead of the worktree diff.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Limit the diff to these workspace-relative paths.' },
        repoDir: { type: 'string', description: 'Repo directory, relative to the workspace root (default: workspace root).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const repoDir = resolveRepoDir(root, getOptionalStringArg(args, 'repoDir'));
        const session = new CodingV2GitSession(repoDir);
        const result = await session.diff({
          commit: getOptionalStringArg(args, 'commit'),
          from: getOptionalStringArg(args, 'from'),
          to: getOptionalStringArg(args, 'to'),
          staged: getBooleanArg(args, 'staged') ?? false,
          paths: getStringArrayArg(args, 'paths', false),
        });
        const header = `Diff (${result.kind})${result.truncated ? ' — truncated at 20,000 chars' : ''}:`;
        const body = result.text.trim() === '' ? '(no differences)' : result.text;
        return truncate(`${header}\n${body}`, MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const gitRevert: Tool = {
    definition: toolDef(
      'coding_v2_git_revert',
      'Revert ONE commit (v1.08, local action, needs approval): creates a new commit undoing the given commit (git revert --no-edit). Refuses when the worktree is dirty. On conflict it aborts the revert so the repo is left exactly as before, and reports the failure.',
      {
        sha: { type: 'string', description: 'Commit SHA to revert (full SHA or 7+ hex prefix).' },
        repoDir: { type: 'string', description: 'Repo directory, relative to the workspace root (default: workspace root).' },
      },
      ['sha'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const repoDir = resolveRepoDir(root, getOptionalStringArg(args, 'repoDir'));
        const session = new CodingV2GitSession(repoDir);
        const result = await session.revert(getStringArg(args, 'sha'));
        return truncate(
          `Reverted ${result.reverted.slice(0, 7)} with new commit ${result.shortSha} (${result.sha}).`,
          MAX_TOOL_RESULT_CHARS,
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const gitSquash: Tool = {
    definition: toolDef(
      'coding_v2_git_squash',
      'Squash a commit range into ONE commit (v1.08, local action, needs approval): squashes every commit after <base> up to HEAD into a single commit with the given message (git reset --soft <base> + commit). Base must be an ancestor of HEAD and there must be at least 2 commits to squash. Refuses when the worktree is dirty.',
      {
        base: { type: 'string', description: 'Base commit SHA — commits AFTER this one are squashed (full SHA or 7+ hex prefix).' },
        message: { type: 'string', description: 'Message for the squashed commit.' },
        repoDir: { type: 'string', description: 'Repo directory, relative to the workspace root (default: workspace root).' },
      },
      ['base', 'message'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const repoDir = resolveRepoDir(root, getOptionalStringArg(args, 'repoDir'));
        const session = new CodingV2GitSession(repoDir);
        const result = await session.squash({
          base: getStringArg(args, 'base'),
          message: getStringArg(args, 'message'),
        });
        const lines = [
          `Squashed ${result.squashed.length} commit(s) into ${result.shortSha} (${result.sha}): ${result.message}`,
        ];
        for (const commit of result.squashed) {
          lines.push(`  ${commit.shortSha} ${commit.message}`);
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    repoMapBuild,
    repoMapQuery,
    repoMapSymbol,
    architectPlan,
    architectExecute,
    architectStatus,
    gitCommit,
    gitDiff,
    gitRevert,
    gitSquash,
  ];
}

/** Unbound placeholder (same shape as MEMORY_V8_TOOLS). */
export const CODING_V2_TOOLS: Tool[] = createCodingV2Tools();
