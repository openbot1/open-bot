/**
 * Coding agent v9 tools (v1.17, Đội T4) — 6 tools.
 *
 * Nối coding agent v7 tools (v1.15): placeholder trong ALL_TOOLS cho
 * tới khi host bind (`createCodingV9Tools(getBaseDir, opts)` với
 * userData dir). Không gọi model thật, không gọi mạng:
 *
 *  - coding_v9_ast_edit  — áp (hoặc preview) một edit AST-aware:
 *    thay function/class/import theo vị trí AST, fallback
 *    search-and-replace block khi không parse được.
 *  - coding_v9_loop      — chạy sandbox execution loop: verify bằng
 *    lệnh argv (không shell) trong working dir, tối đa N vòng.
 *  - coding_v9_commit    — commit atomic các file đã đổi (message tự
 *    sinh từ diff) trong repo làm việc.
 *  - coding_v9_pr        — sinh draft-PR description từ lịch sử commit
 *    (baseRef..HEAD).
 *  - coding_v9_eval      — chạy bộ eval mẫu (3 task) với agent
 *    scripted mặc định, trả pass@k + vòng/token trung bình.
 *  - coding_v9_agent     — chạy một task CodingAgentV9 end-to-end
 *    từ plan JSON (AST edit → sandbox loop verify → atomic commit).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  CodingAgentV9,
  applyV9AstEdit,
  commitV9Atomic,
  generateV9DraftPrDescription,
  previewV9AstEdit,
  runV9EvalSuite,
  runV9SandboxLoop,
  scriptedV9Agent,
  v9CommitLogSince,
  V9_EVAL_SAMPLE_TASKS,
} from '@open-bot/core';
import type { V9EditKind, V9EditOperation } from '@open-bot/core';

const NOT_WIRED =
  'Coding agent v9 is not configured: the host has not wired a base directory yet. ' +
  'Bind createCodingV9Tools(getBaseDir) with the app userData directory first.';

export const CODING_V9_TOOL_NAMES = [
  'coding_v9_ast_edit',
  'coding_v9_loop',
  'coding_v9_commit',
  'coding_v9_pr',
  'coding_v9_eval',
  'coding_v9_agent',
] as const;

export type CodingV9ToolName = (typeof CODING_V9_TOOL_NAMES)[number];

export function isCodingV9ToolName(name: string): boolean {
  return (CODING_V9_TOOL_NAMES as readonly string[]).includes(name);
}

export interface CodingV9ToolOptions {
  /** Thư mục workspace fallback (ưu tiên ctx.workspaceDir). */
  getWorkspaceDir?: () => string | null | undefined;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
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

function getStringArg(args: Record<string, unknown>, name: string, required = false): string {
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

function getIntArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Argument "${name}" must be an integer, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

/** Parse một JSON string thành mảng (lỗi rõ ràng khi sai định dạng). */
function parseJsonArrayArg(raw: string, name: string): unknown[] {
  if (raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Argument "${name}" must be valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Argument "${name}" must be a JSON array.`);
  }
  return parsed;
}

export function codingV9DataDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v9');
}

export function createCodingV9Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: CodingV9ToolOptions = {},
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const resolveWorkspaceDir = (ctx: ToolContext): string => {
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) return ctx.workspaceDir;
    const dir = toolOptions.getWorkspaceDir?.();
    if (typeof dir === 'string' && dir.trim().length > 0) return dir;
    const base = resolveBase();
    return base ? path.join(base, 'coding-v9-workspace') : path.join(os.tmpdir(), 'open-bot-coding-v9-workspace');
  };

  const astEditTool: Tool = {
    definition: toolDef(
      'coding_v9_ast_edit',
      'Apply (or preview with dryRun=true) one AST-aware edit (v1.17): replace a function/class/method/import by its AST location, insert a symbol after another, rename a symbol, or search-and-replace a unique block as fallback. Verifies by re-parsing and enforces a minimal-diff limit.',
      {
        path: { type: 'string', description: 'Repo-relative file path, e.g. "src/util.ts".' },
        kind: { type: 'string', description: '"replace-symbol" | "replace-import" | "insert-after" | "rename-symbol" | "search-replace".' },
        symbolName: { type: 'string', description: 'Target symbol name (or import specifier for replace-import).' },
        qualifiedName: { type: 'string', description: 'Optional qualified name to disambiguate, e.g. "Calc.sum".' },
        newText: { type: 'string', description: 'New symbol text (replace-symbol / insert-after).' },
        newSpecifier: { type: 'string', description: 'New module specifier (replace-import).' },
        newName: { type: 'string', description: 'New name (rename-symbol).' },
        oldBlock: { type: 'string', description: 'Exact old block (search-replace fallback).' },
        newBlock: { type: 'string', description: 'New block (search-replace fallback).' },
        dryRun: { type: 'boolean', description: 'true = preview only, do not write the file.' },
      },
      ['path', 'kind'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      try {
        const kind = getStringArg(args, 'kind', true) as V9EditKind;
        const operation: V9EditOperation = {
          kind,
          path: getStringArg(args, 'path', true),
          symbolName: getStringArg(args, 'symbolName') || undefined,
          qualifiedName: getStringArg(args, 'qualifiedName') || undefined,
          newText: getStringArg(args, 'newText') || undefined,
          newSpecifier: getStringArg(args, 'newSpecifier') || undefined,
          newName: getStringArg(args, 'newName') || undefined,
          oldBlock: getStringArg(args, 'oldBlock') || undefined,
          newBlock: getStringArg(args, 'newBlock') || undefined,
        };
        const dryRun = getBoolArg(args, 'dryRun') ?? false;
        const result = dryRun
          ? previewV9AstEdit(operation, { workingDir })
          : applyV9AstEdit(operation, { workingDir });
        return JSON.stringify({ workingDir, dryRun, ...result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const loopTool: Tool = {
    definition: toolDef(
      'coding_v9_loop',
      'Run the coding agent v9 sandbox execution loop (v1.17): run verify commands (argv, no shell) in the workspace, up to maxRounds rounds. Each round re-runs all verify commands; pass stops the loop. Dangerous commands are denied by the sandbox denylist + v8 policy.',
      {
        verifyCommandsJson: { type: 'string', description: 'JSON array of argv arrays, e.g. [["node","test.mjs"],["npx","tsc","--noEmit"]].' },
        maxRounds: { type: 'integer', description: 'Max loop rounds (default 5, max 20).' },
        commandTimeoutMs: { type: 'integer', description: 'Timeout per verify command in ms (default 30000).' },
      },
      ['verifyCommandsJson'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      try {
        const raw = parseJsonArrayArg(getStringArg(args, 'verifyCommandsJson', true), 'verifyCommandsJson');
        const verifyCommands: string[][] = raw.map((entry, i) => {
          if (!Array.isArray(entry) || entry.some((t) => typeof t !== 'string')) {
            throw new Error(`verifyCommandsJson[${i}] must be an array of strings.`);
          }
          return entry as string[];
        });
        const result = await runV9SandboxLoop({
          workingDir,
          verifyCommands,
          maxRounds: getIntArg(args, 'maxRounds'),
          commandTimeoutMs: getIntArg(args, 'commandTimeoutMs'),
          firstRoundNote: 'tool verify',
        });
        return JSON.stringify({ workingDir, ...result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const commitTool: Tool = {
    definition: toolDef(
      'coding_v9_commit',
      'Create one git-first atomic commit (v1.17) for the given files in the workspace repo: stages exactly those files and commits with an auto-generated message from the diff (summary + per-file +/- lines). Returns the SHA and stats.',
      {
        filesJson: { type: 'string', description: 'JSON array of repo-relative file paths to stage, e.g. ["src/util.ts"].' },
        summary: { type: 'string', description: 'Short change summary for the commit message.' },
        task: { type: 'string', description: 'Optional task description recorded in the commit body.' },
      },
      ['filesJson', 'summary'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      try {
        const raw = parseJsonArrayArg(getStringArg(args, 'filesJson', true), 'filesJson');
        const files = raw.map((f, i) => {
          if (typeof f !== 'string') throw new Error(`filesJson[${i}] must be a string.`);
          return f;
        });
        const commit = await commitV9Atomic({
          workingDir,
          files,
          summary: getStringArg(args, 'summary', true),
          task: getStringArg(args, 'task') || undefined,
        });
        return JSON.stringify({ workingDir, ...commit }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const prTool: Tool = {
    definition: toolDef(
      'coding_v9_pr',
      'Generate a draft-PR description (v1.17) from the commit history baseRef..HEAD in the workspace repo: title + markdown body (summary, commit table, file/line totals, test summary). Does not push or open a real PR.',
      {
        baseRef: { type: 'string', description: 'Base ref for the range, e.g. a commit SHA before the task started.' },
        headBranch: { type: 'string', description: 'Head branch name (default: current branch).' },
        baseBranch: { type: 'string', description: 'Base branch name (default "main").' },
        summary: { type: 'string', description: 'Optional PR summary/title override.' },
        testSummary: { type: 'string', description: 'Optional test summary for the PR body.' },
      },
      ['baseRef'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      try {
        const baseRef = getStringArg(args, 'baseRef', true);
        const commits = await v9CommitLogSince(workingDir, baseRef);
        const pr = generateV9DraftPrDescription({
          commits,
          headBranch: getStringArg(args, 'headBranch') || 'v117-coding',
          baseBranch: getStringArg(args, 'baseBranch') || 'main',
          summary: getStringArg(args, 'summary') || undefined,
          testSummary: getStringArg(args, 'testSummary') || undefined,
        });
        return JSON.stringify({ workingDir, ...pr }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'coding_v9_eval',
      'Run the coding agent v9 sample eval (v1.17): 3 small JS tasks on temp repos, scored SWE-bench-style (FAIL_TO_PASS / PASS_TO_PASS) with the scripted agent. Returns pass@k, attempt pass rate, avg rounds and avg tokens. Pass "taskId" to run one task.',
      {
        taskId: { type: 'string', description: 'Optional single task id (v9-eval-add | v9-eval-greet | v9-eval-sort).' },
        attemptsPerTask: { type: 'integer', description: 'Attempts per task, k of pass@k (default 3).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const taskId = getStringArg(args, 'taskId');
        const tasks = taskId ? V9_EVAL_SAMPLE_TASKS.filter((t) => t.id === taskId) : [...V9_EVAL_SAMPLE_TASKS];
        if (tasks.length === 0) return errorResult(`unknown eval task: ${taskId}`);
        const report = await runV9EvalSuite(tasks, scriptedV9Agent, {
          attemptsPerTask: getIntArg(args, 'attemptsPerTask') ?? 2,
          suiteName: 'coding-v9-sample',
        });
        return JSON.stringify(report, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const agentTool: Tool = {
    definition: toolDef(
      'coding_v9_agent',
      'Run one CodingAgentV9 task end-to-end (v1.17) in the workspace: AST-aware edits from a JSON plan, sandbox-loop verify, atomic commit per file, optional draft-PR description. The plan is a JSON array of V9EditOperation objects; the agent does not invent edits — it executes the given plan.',
      {
        title: { type: 'string', description: 'Short task title.' },
        task: { type: 'string', description: 'Task description.' },
        planJson: { type: 'string', description: 'JSON array of edit operations, e.g. [{"kind":"replace-symbol","path":"util.mjs","symbolName":"greet","newText":"..."}].' },
        verifyCommandsJson: { type: 'string', description: 'Optional JSON array of argv arrays to verify with.' },
        maxRounds: { type: 'integer', description: 'Max sandbox loop rounds (default 5).' },
        autoCommit: { type: 'boolean', description: 'Commit atomically after green verify (default true).' },
      },
      ['title', 'task', 'planJson'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      try {
        const raw = parseJsonArrayArg(getStringArg(args, 'planJson', true), 'planJson');
        const plan = raw as V9EditOperation[];
        for (const [i, op] of plan.entries()) {
          if (!op || typeof op !== 'object' || typeof (op as V9EditOperation).kind !== 'string') {
            throw new Error(`planJson[${i}] must be an edit operation object with a "kind".`);
          }
        }
        const verifyRaw = getStringArg(args, 'verifyCommandsJson');
        const verifyCommands: string[][] | undefined = verifyRaw
          ? (parseJsonArrayArg(verifyRaw, 'verifyCommandsJson') as string[][])
          : undefined;
        const agent = new CodingAgentV9({
          workingDir,
          planProvider: () => plan,
          verifyCommands,
          maxRounds: getIntArg(args, 'maxRounds'),
          autoCommit: getBoolArg(args, 'autoCommit'),
          summary: getStringArg(args, 'title', true),
        });
        const report = await agent.runTask(getStringArg(args, 'title', true), getStringArg(args, 'task', true));
        return JSON.stringify({ workingDir, ...report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [astEditTool, loopTool, commitTool, prTool, evalTool, agentTool];
}

/** Placeholder tools (unbound) for ALL_TOOLS — same names, never a duplicate. */
export const CODING_V9_TOOLS: Tool[] = createCodingV9Tools();

/** Ensure the tools use the fs import (keeps the data-dir helper honest). */
export function codingV9EnsureDataDir(baseDir: string): string {
  const dir = codingV9DataDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
