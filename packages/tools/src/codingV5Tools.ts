/**
 * Coding agent v5 tools for @open-bot/tools (v1.13, Doi T4).
 *
 * The agent drives coding v5 by tool call (git-native, hoc y tuong
 * tu Aider — chi hoc y tuong, khong copy):
 *  - coding_v5_patch_preview  — diff worktree/staged -> preview
 *    (file nao, hunk nao, +/-, so dong) + danh sach id hunk (read)
 *  - coding_v5_patch_apply    — apply hunk da duyet (theo id
 *    `file:hunk`), tuy chon commit + ghi lich su patch (write)
 *  - coding_v5_commit_message — sinh commit message co nghia tu diff
 *    worktree hoac patch text + validate theo quy uoc repo (read)
 *  - coding_v5_add            — /add file vao tap (validate + uoc
 *    luong token + canh bao vuot ngan sach) (local state)
 *  - coding_v5_drop           — /drop file khoi tap (local state)
 *  - coding_v5_ls_files       — /ls-files: tap hien tai + thong ke
 *    token (read)
 *  - coding_v5_suggest_files  — goi y file theo truy van qua repo
 *    map v4 (PageRank v2); tuy chon add thang vao tap (read + cache)
 *  - coding_v5_eval_run       — chay 1 task SWE-bench local (issue
 *    -> patch -> test truoc/sau, cham FAIL_TO_PASS/PASS_TO_PASS)
 *    (runs commands in a temp repo)
 *  - coding_v5_eval_suite     — chay bo task SWE mau, luu bao cao
 *    JSON, tra ve pass rate (runs commands in temp repos)
 *  - coding_v5_rollback       — rollback patch theo commit id
 *    (revert an toan, hoac reset-hard khi xac nhan pha huy) (write)
 *  - coding_v5_patch_history  — lich su patch (active/rolled back)
 *    (read)
 *
 * SAFETY: everything here is local — no network, no X data, no Grok
 * Imagine, no cloud VM/accounts/payments. Git ops never push/fetch
 * or touch remotes; `git apply` always `--check`s first; rollback
 * `reset-hard` needs explicit `allowDestructive: true`. Eval runs
 * commands (argv, no shell) only inside a fresh temp repo; only run
 * tasks you wrote/trust. Repo map cache lives under
 * `.open-bot/coding-v4/`; patch history under
 * `.open-bot/coding-v5/patch-history.json`; eval reports under
 * `.open-bot/coding-v5/eval-results/`. File sets live in memory in
 * this process (per workspaceDir).
 *
 * Factory:
 *   createCodingV5Tools(opts) -> Tool[]   (bound, usable)
 *   CODING_V5_TOOLS                       (unbound placeholder)
 *
 * NOTE: CODING_V5_TOOLS is NOT added to ALL_TOOLS here — the release
 * coordinator wires the central registry later (per v1.13 wave
 * rules). Import createCodingV5Tools / CODING_V5_TOOLS directly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  CODING_V5_DEFAULT_TOKEN_BUDGET,
  CODING_V5_SWE_SAMPLE_TASKS,
  CodingV5FileSet,
  CodingV5GitSession,
  CodingV5PatchHistory,
  CodingV5PatchSession,
  CodingV5SweHarness,
  analyzeCodingV5Diff,
  generateCodingV5CommitMessage,
  parseCodingV5Diff,
  parseCodingV5FileCommand,
  parseCodingV2Cache,
  renderCodingV5PatchHistory,
  renderCodingV5Suggestions,
  renderCodingV5SweReport,
  rollbackCodingV5Patch,
  saveCodingV5SweReport,
  serializeCodingV5Patch,
  suggestCodingV5Files,
  suggestCodingV5FilesByName,
  validateCodingV5CommitMessage,
} from '@open-bot/core';
import type { CodingV2FileEntry, CodingV5SweTask, CodingV5SweTaskResult } from '@open-bot/core';
import { CodingV4RepoMapStore } from './codingV4RepoMap';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export const CODING_V5_TOOL_NAMES = [
  'coding_v5_patch_preview',
  'coding_v5_patch_apply',
  'coding_v5_commit_message',
  'coding_v5_add',
  'coding_v5_drop',
  'coding_v5_ls_files',
  'coding_v5_suggest_files',
  'coding_v5_eval_run',
  'coding_v5_eval_suite',
  'coding_v5_rollback',
  'coding_v5_patch_history',
] as const;

export type CodingV5ToolName = (typeof CODING_V5_TOOL_NAMES)[number];

export function isCodingV5ToolName(name: string): name is CodingV5ToolName {
  return (CODING_V5_TOOL_NAMES as readonly string[]).includes(name);
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

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
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

export interface CodingV5ToolOptions {
  /** Fixed workspace directory (its repo map / file set live there). */
  workspaceDir?: string;
  /** Lazy workspace directory (host supplies it; overrides ctx when set). */
  getWorkspaceDir?: () => string | undefined;
  /** Pre-built repo map store (tests); defaults to one per workspaceDir. */
  repoMapStore?: CodingV4RepoMapStore;
  /** Pre-built file set (tests); defaults to one per workspaceDir. */
  fileSet?: CodingV5FileSet;
  /** Token budget for the file set (default 8000). */
  tokenBudget?: number;
}

export function createCodingV5Tools(opts: CodingV5ToolOptions = {}): Tool[] {
  const repoMapStores = new Map<string, CodingV4RepoMapStore>();
  const fileSets = new Map<string, CodingV5FileSet>();

  const resolveRoot = (ctx: ToolContext): string => {
    const dir = opts.workspaceDir ?? opts.getWorkspaceDir?.() ?? ctx.workspaceDir;
    if (!dir || typeof dir !== 'string' || dir.trim() === '') {
      throw new Error(
        'workspaceDir is required (host must pass it to createCodingV5Tools, or the tool context must carry it).',
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

  const fileSetOf = (root: string): CodingV5FileSet => {
    if (opts.fileSet) return opts.fileSet;
    let set = fileSets.get(root);
    if (!set) {
      set = new CodingV5FileSet(root, opts.tokenBudget ?? CODING_V5_DEFAULT_TOKEN_BUDGET);
      fileSets.set(root, set);
    }
    return set;
  };

  /** File entries cua repo tu cache v2 (sau khi build map v4). */
  const repoFileEntries = (root: string): CodingV2FileEntry[] => {
    const store = repoMapOf(root);
    const cachePath = store.v3.v2.cachePath;
    try {
      const text = fs.readFileSync(cachePath, 'utf8');
      const parsed = parseCodingV2Cache(text, root);
      if ('error' in parsed) return [];
      return Object.values(parsed.cache.files);
    } catch {
      return [];
    }
  };

  // --- Patch preview / apply ---------------------------------------------------

  const patchPreview: Tool = {
    definition: toolDef(
      'coding_v5_patch_preview',
      'Preview a patch before applying it (v1.13, read): unified diff of the worktree (or staged only) parsed into files/hunks with per-hunk ids ("file:hunk"), additions/deletions and line numbers, rendered as short preview text. Show this to the user/agent so they can approve individual hunks before coding_v5_patch_apply runs.',
      {
        stagedOnly: { type: 'boolean', description: 'Preview staged changes only (git diff --cached). Default: worktree diff.' },
        paths: { type: 'array', description: 'Limit the diff to these repo-relative paths.' },
        maxChars: { type: 'number', description: 'Max preview chars (default 20000).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const session = new CodingV5GitSession(root);
        const diffText = await session.diff({
          stagedOnly: getBooleanArg(args, 'stagedOnly') ?? false,
          paths: getStringArrayArg(args, 'paths'),
        });
        const patch = parseCodingV5Diff(diffText);
        if (patch.isEmpty) {
          return 'Worktree sach — khong co thay doi nao de preview.';
        }
        const previewSession = new CodingV5PatchSession(diffText, { repoRoot: root });
        const preview = previewSession.preview({ maxChars: getNumberArg(args, 'maxChars') });
        const hunkIds = previewSession.allHunkIds();
        return truncate(
          `${preview}\nHunk ids (dung trong coding_v5_patch_apply): ${hunkIds.join(', ')}`,
          MAX_TOOL_RESULT_CHARS,
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const patchApply: Tool = {
    definition: toolDef(
      'coding_v5_patch_apply',
      'Apply approved patch hunks (v1.13, write): takes a unified diff and the list of approved hunk ids ("file:hunk", from coding_v5_patch_preview), or approveAll=true to apply everything. Only approved hunks are applied (git apply --check first). Optionally commits the result with the given message and records the patch in the patch history.',
      {
        patch: { type: 'string', description: 'Unified diff text to apply (from).' },
        approvedHunkIds: { type: 'array', description: 'Hunk ids to approve, e.g. ["0:0", "1:2"]. Ignored when approveAll=true.' },
        approveAll: { type: 'boolean', description: 'Approve every hunk in the patch. Default false.' },
        commitMessage: { type: 'string', description: 'Optional commit message: when given, stages the patched files and commits (message is validated against repo conventions first).' },
        issueRef: { type: 'string', description: 'Optional issue ref appended to the commit message footer (e.g. "refs v1.13").' },
      },
      ['patch'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const patchText = getStringArg(args, 'patch');
        const session = new CodingV5PatchSession(patchText, { repoRoot: root });
        if (session.patch.isEmpty) {
          return errorResult('Patch rong — khong co hunk nao de apply.');
        }
        if (getBooleanArg(args, 'approveAll') ?? false) {
          session.approveAll();
        } else {
          const ids = getStringArrayArg(args, 'approvedHunkIds') ?? [];
          if (ids.length === 0) {
            return errorResult(
              'Chua duyet hunk nao — truyen approvedHunkIds (vd ["0:0"]) hoac approveAll=true.',
            );
          }
          for (const id of ids) session.approveHunk(id);
        }
        const approved = session.approvedPatch();
        const applied = await session.applyApproved({ repoRoot: root });
        const lines: string[] = [
          `Applied ${applied.hunksApplied} approved hunk(s) in ${applied.filesAffected} file(s) ` +
            `(+${approved.additions}/-${approved.deletions}).`,
          `Rejected hunks (not applied): ${session.rejectedHunkIds().join(', ') || '(none)'}; ` +
            `pending: ${session.pendingHunkIds().join(', ') || '(none)'}.`,
        ];

        const commitMessage = getOptionalStringArg(args, 'commitMessage');
        if (commitMessage) {
          const issues = validateCodingV5CommitMessage(commitMessage);
          if (issues.length > 0) {
            lines.push(
              `Commit SKIPPED — message khong hop le: ${issues.map((i) => i.message).join(' | ')}. ` +
                `Patch da apply, hay commit tay voi message da sua.`,
            );
          } else {
            const git = new CodingV5GitSession(root);
            const parentSha = await git.headSha();
            const files = approved.files.map((f) => f.newPath || f.oldPath);
            await git.add(files);
            const fullMessage = getOptionalStringArg(args, 'issueRef')
              ? `${commitMessage}\n\n${getOptionalStringArg(args, 'issueRef') as string}`
              : commitMessage;
            const sha = await git.commit(fullMessage);
            const analysis = analyzeCodingV5Diff(approved);
            const history = new CodingV5PatchHistory(root);
            history.recordPatch({
              commitSha: sha,
              parentSha,
              message: fullMessage,
              type: analysis.type,
              scope: analysis.scope,
              files,
              additions: approved.additions,
              deletions: approved.deletions,
              hunksApproved: applied.hunksApplied,
              hunksRejected: session.rejectedHunkIds().length,
            });
            lines.push(`Committed as ${sha.slice(0, 7)} (${analysis.type}/${analysis.scope}) and recorded in patch history.`);
          }
        } else {
          lines.push('Khong commit (khong co commitMessage) — patch chi apply vao worktree.');
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const commitMessageTool: Tool = {
    definition: toolDef(
      'coding_v5_commit_message',
      'Generate a meaningful commit message from a diff (v1.13, read): classifies the change (feat/fix/refactor/test/docs/chore), infers scope from file paths, summarizes added/removed symbols, and validates the message against repo conventions (type(scope): subject, subject <= 72 chars). Give a patch text, or omit it to use the worktree diff.',
      {
        patch: { type: 'string', description: 'Unified diff text to summarize. Omit to use the worktree diff.' },
        type: { type: 'string', description: 'Force a change type (feat/fix/refactor/test/docs/chore).' },
        scope: { type: 'string', description: 'Force a scope (e.g. "coding-v5").' },
        issueRef: { type: 'string', description: 'Issue ref for the message footer (e.g. "refs v1.13").' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        let patchText = getOptionalStringArg(args, 'patch');
        if (!patchText) {
          const session = new CodingV5GitSession(root);
          patchText = await session.diff();
        }
        const patch = parseCodingV5Diff(patchText);
        if (patch.isEmpty) {
          return 'Khong co thay doi nao — khong sinh duoc commit message.';
        }
        const type = getOptionalStringArg(args, 'type');
        const allowedTypes = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore'];
        if (type !== undefined && !allowedTypes.includes(type)) {
          return errorResult(`Type "${type}" khong hop le (chi: ${allowedTypes.join(', ')}).`);
        }
        const generated = generateCodingV5CommitMessage(patch, {
          type: type as 'feat' | 'fix' | 'refactor' | 'test' | 'docs' | 'chore' | undefined,
          scope: getOptionalStringArg(args, 'scope'),
          issueRef: getOptionalStringArg(args, 'issueRef'),
        });
        const issues = validateCodingV5CommitMessage(generated.full);
        const lines = [
          `Suggested commit message (${generated.type}/${generated.scope} — ${generated.analysis.typeReason}):`,
          generated.full,
        ];
        if (issues.length > 0) {
          lines.push(`Validation warnings: ${issues.map((i) => i.message).join(' | ')}`);
        }
        return truncate(lines.join('\n\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // --- File selection (/add, /drop, /ls-files, suggest) -----------------------

  const fileAdd: Tool = {
    definition: toolDef(
      'coding_v5_add',
      'Add files to the agent working set, /add style (v1.13, local state): validates each path (inside the repo, exists, not a system/build dir), estimates tokens (chars/4), and warns when the set goes over its token budget. Accepts a paths array, or a chat command string like "/add src/a.ts src/b.ts".',
      {
        paths: { type: 'array', description: 'Repo-relative file paths to add.' },
        command: { type: 'string', description: 'Chat command to parse, e.g. "/add src/a.ts". Takes precedence over paths when given.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const set = fileSetOf(root);
        const command = getOptionalStringArg(args, 'command');
        let paths = getStringArrayArg(args, 'paths') ?? [];
        if (command) {
          const parsed = parseCodingV5FileCommand(command);
          if (parsed.kind !== 'add') {
            return errorResult(`Lenh "${command}" khong phai /add (kind: ${parsed.kind}).`);
          }
          paths = parsed.paths;
        }
        if (paths.length === 0) {
          return errorResult('Khong co file nao de add — truyen paths hoac command "/add <file> ...".');
        }
        const { added, skipped } = set.addMany(paths);
        const stats = set.stats();
        const lines = [
          `Added ${added.length} file(s)${skipped.length > 0 ? `, skipped ${skipped.length}` : ''}.`,
          set.render(),
        ];
        for (const s of skipped) lines.push(`Skipped ${s.path}: ${s.reason}`);
        if (stats.overBudget) {
          lines.push(`CANH BAO: tap file vuot ngan sach ${stats.overByTokens} token — drop bot file truoc khi lam viec.`);
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const fileDrop: Tool = {
    definition: toolDef(
      'coding_v5_drop',
      'Drop files from the agent working set, /drop style (v1.13, local state): removes the given paths (or parses a "/drop ..." chat command). Missing files are reported, not fatal.',
      {
        paths: { type: 'array', description: 'Repo-relative file paths to drop.' },
        command: { type: 'string', description: 'Chat command to parse, e.g. "/drop src/a.ts". Takes precedence over paths when given.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const set = fileSetOf(root);
        const command = getOptionalStringArg(args, 'command');
        let paths = getStringArrayArg(args, 'paths') ?? [];
        if (command) {
          const parsed = parseCodingV5FileCommand(command);
          if (parsed.kind !== 'drop') {
            return errorResult(`Lenh "${command}" khong phai /drop (kind: ${parsed.kind}).`);
          }
          paths = parsed.paths;
        }
        if (paths.length === 0) {
          return errorResult('Khong co file nao de drop — truyen paths hoac command "/drop <file> ...".');
        }
        const { dropped, missing } = set.dropMany(paths);
        const lines = [
          `Dropped ${dropped.length} file(s)${missing.length > 0 ? `, ${missing.length} khong co trong tap` : ''}.`,
          set.render(),
        ];
        for (const m of missing) lines.push(`Khong co trong tap: ${m}`);
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const fileList: Tool = {
    definition: toolDef(
      'coding_v5_ls_files',
      'List the agent working set, /ls-files style (v1.13, read): files with estimated tokens and the budget status.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const set = fileSetOf(root);
        return truncate(set.render(), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const suggestFiles: Tool = {
    definition: toolDef(
      'coding_v5_suggest_files',
      'Suggest files for a query via the v4 repo map, /add --suggest style (v1.13, read + cache): ranks files by Personalized PageRank v2 (query seeds + reference frequency + freshness) and returns each with its score and reason. Falls back to filename matching when the repo map has never been built. Optionally adds the suggestions straight into the working set.',
      {
        query: { type: 'string', description: 'Query (symbol/file/topic), e.g. "auth login".' },
        limit: { type: 'number', description: 'Max suggestions (default 10, capped at 50).' },
        addToSet: { type: 'boolean', description: 'Add the suggested files to the working set. Default false.' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const query = getStringArg(args, 'query');
        const limit = getNumberArg(args, 'limit') ?? 10;
        const set = fileSetOf(root);
        const store = repoMapOf(root);
        const selected = new Set(set.list().map((e) => e.relPath));
        let rendered: string;
        let suggestedPaths: string[] = [];
        let fellBack = false;
        try {
          await store.ensureBuilt();
          const graph = store.getGraph();
          const entries = repoFileEntries(root);
          if (!graph || entries.length === 0) throw new Error('Repo map chua build duoc.');
          const { suggestions, fellBackToGlobal } = suggestCodingV5Files(graph, entries, query, {
            limit,
            excludeSelected: selected,
          });
          fellBack = fellBackToGlobal;
          suggestedPaths = suggestions.map((s) => s.relPath);
          rendered = renderCodingV5Suggestions(suggestions, query, fellBackToGlobal);
        } catch {
          // Fallback: quet file tren dia roi khop ten (khong can repo map).
          const entries = scanDiskEntries(root);
          const { suggestions } = suggestCodingV5FilesByName(entries, query, {
            limit,
            excludeSelected: selected,
          });
          fellBack = true;
          suggestedPaths = suggestions.map((s) => s.relPath);
          rendered = renderCodingV5Suggestions(suggestions, query, true);
        }
        const lines = [rendered];
        if ((getBooleanArg(args, 'addToSet') ?? false) && suggestedPaths.length > 0) {
          const { added, skipped } = set.addMany(suggestedPaths);
          lines.push(`Added ${added.length} suggested file(s) to the working set.`);
          for (const s of skipped) lines.push(`Skipped ${s.path}: ${s.reason}`);
          lines.push(set.render());
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // --- SWE-bench eval ----------------------------------------------------------

  const evalRun: Tool = {
    definition: toolDef(
      'coding_v5_eval_run',
      'Run one SWE-bench-style eval task locally (v1.13, runs commands in a temp repo): builds a temp git repo from the task fixtures, runs the tests on the base, applies the candidate patch, re-runs the tests, and scores FAIL_TO_PASS (must fail before, pass after) and PASS_TO_PASS (must pass both times). Returns pass/fail/error with the reason and saves the result JSON under .open-bot/coding-v5/eval-results/. Only run tasks you wrote/trust — commands run as argv (no shell) inside the temp repo.',
      {
        task: { type: 'object', description: 'Eval task: { id, title, issue, fixtures: {path: content}, patch (unified diff), testCommands: [{name, argv}], failToPass: [names], passToPass: [names] }.' },
      },
      ['task'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const raw = getObjectArg(args, 'task');
        if (!raw) return errorResult('Missing required argument: "task".');
        const task = raw as unknown as CodingV5SweTask;
        const harness = new CodingV5SweHarness();
        const result = await harness.runTask(task);
        const saved = saveSweTaskResult(root, result);
        const lines = [
          `[${result.status.toUpperCase()}] ${result.taskId} — ${result.title}`,
          `Patch applied: ${result.patchApplied}; failToPass ${result.failToPassPassed}/${result.failToPassTotal}; ` +
            `passToPass ${result.passToPassPassed}/${result.passToPassTotal}; ${result.durationMs}ms.`,
          `Reason: ${result.reason}`,
          `Result JSON: ${saved}`,
        ];
        for (const t of result.tests) {
          lines.push(
            `  - ${t.name} [${t.group}] base exit ${String(t.baseExitCode)} -> after exit ${String(t.afterExitCode)} ` +
              `(${t.expectationMet ? 'met' : 'NOT met'})`,
          );
        }
        return truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const evalSuite: Tool = {
    definition: toolDef(
      'coding_v5_eval_suite',
      'Run the built-in SWE-bench-style sample suite locally (v1.13, runs commands in temp repos): 3 sample tasks (a correct fix must PASS, a wrong patch must FAIL, a patch breaking old tests must FAIL). Saves the suite report JSON under .open-bot/coding-v5/eval-results/ and returns the pass rate.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const harness = new CodingV5SweHarness();
        const report = await harness.runSuite(CODING_V5_SWE_SAMPLE_TASKS);
        const saved = saveCodingV5SweReport(report, path.join(root, '.open-bot', 'coding-v5', 'eval-results'));
        return truncate(`${renderCodingV5SweReport(report)}\nReport JSON: ${saved}`, MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // --- Rollback / history ------------------------------------------------------

  const rollback: Tool = {
    definition: toolDef(
      'coding_v5_rollback',
      'Roll back a patch by commit id (v1.13, write): reverts the commit with `git revert --no-edit` (safe, history preserved; conflicts abort cleanly) and marks it rolled back in the patch history. Mode "reset-hard" instead resets to the parent commit — destructive (drops the commit and any uncommitted changes), requires allowDestructive=true, and cannot roll back the root commit.',
      {
        commitSha: { type: 'string', description: 'Commit SHA to roll back (full or >= 7 hex chars).' },
        mode: { type: 'string', description: '"revert" (default, safe) or "reset-hard" (destructive).' },
        allowDestructive: { type: 'boolean', description: 'Required true for mode "reset-hard".' },
      },
      ['commitSha'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const commitSha = getStringArg(args, 'commitSha');
        const mode = getOptionalStringArg(args, 'mode') ?? 'revert';
        if (mode !== 'revert' && mode !== 'reset-hard') {
          return errorResult(`Mode "${mode}" khong hop le (chi "revert" hoac "reset-hard").`);
        }
        const history = new CodingV5PatchHistory(root);
        const result = await rollbackCodingV5Patch(root, commitSha, {
          mode,
          allowDestructive: getBooleanArg(args, 'allowDestructive') ?? false,
          history,
        });
        return truncate(
          `Rolled back ${result.shortSha} (${result.message}) via ${result.mode} -> ${result.rollbackSha.slice(0, 7)}. ` +
            (result.record ? 'Marked rolled back in patch history.' : 'No patch-history record for this commit (rolled back anyway).'),
          MAX_TOOL_RESULT_CHARS,
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const patchHistoryTool: Tool = {
    definition: toolDef(
      'coding_v5_patch_history',
      'List the patch history (v1.13, read): applied patches with commit, message, files, +/-, approved/rejected hunks, and rollback state. Filter to active (not rolled back) or rolled-back records.',
      {
        filter: { type: 'string', description: '"all" (default), "active", or "rolled-back".' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const root = resolveRoot(ctx);
        const filter = getOptionalStringArg(args, 'filter') ?? 'all';
        if (filter !== 'all' && filter !== 'active' && filter !== 'rolled-back') {
          return errorResult(`Filter "${filter}" khong hop le (chi "all", "active", "rolled-back").`);
        }
        const history = new CodingV5PatchHistory(root);
        if (history.loadWarning) {
          return truncate(`Warning: ${history.loadWarning}\n${renderCodingV5PatchHistory(history.list())}`, MAX_TOOL_RESULT_CHARS);
        }
        const records =
          filter === 'active'
            ? history.listActive()
            : filter === 'rolled-back'
              ? history.listRolledBack()
              : history.list();
        return truncate(renderCodingV5PatchHistory(records), MAX_TOOL_RESULT_CHARS);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    patchPreview,
    patchApply,
    commitMessageTool,
    fileAdd,
    fileDrop,
    fileList,
    suggestFiles,
    evalRun,
    evalSuite,
    rollback,
    patchHistoryTool,
  ];
}

export const CODING_V5_TOOLS: Tool[] = createCodingV5Tools();

/** Luu ket qua 1 task SWE thanh JSON (de so sanh giua cac lan chay). */
function saveSweTaskResult(root: string, result: CodingV5SweTaskResult): string {
  const dir = path.join(root, '.open-bot', 'coding-v5', 'eval-results');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `swe-task-${result.taskId}-${Date.now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf8');
  return filePath;
}

/**
 * Quet file source tren dia (de goi y theo ten khi chua co repo map).
 * Chi lay .ts/.tsx/.js/.jsx/.py, bo thu muc he thong/build, toi da
 * 2000 file — du cho fallback, khong thay the repo map that.
 */
function scanDiskEntries(root: string): CodingV2FileEntry[] {
  const entries: CodingV2FileEntry[] = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.open-bot', 'coverage']);
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);
  const walk = (dir: string, rel: string): void => {
    if (entries.length >= 2000) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (entries.length >= 2000) return;
      if (ignored.has(dirent.name)) continue;
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      const childAbs = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(childAbs, childRel);
      } else if (dirent.isFile()) {
        const ext = path.extname(dirent.name);
        if (!exts.has(ext)) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(childAbs);
        } catch {
          continue;
        }
        entries.push({
          relPath: childRel,
          language: ext.slice(1),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          symbols: [],
          imports: [],
          hasError: false,
        });
      }
    }
  };
  walk(root, '');
  return entries;
}
