/**
 * Coding agent v10 tools (v1.18, Đội T2) — 7 tools.
 *
 * Nối coding agent v9 tools (v1.17): placeholder trong ALL_TOOLS cho
 * tới khi host bind (`createCodingV10Tools(getBaseDir, opts)` với
 * userData dir). Không gọi model thật, không gọi mạng:
 *
 *  - coding_v10_session  — quản lý phiên event-sourced: start /
 *    status / pause / resume / snapshot / replay / fork / list.
 *  - coding_v10_codeact  — chạy code node/python/bash trong sandbox
 *    local (allowlist + denylist, timeout + cap output), kết quả
 *    thành Observation (stdout/stderr/exit code).
 *  - coding_v10_repomap  — build repo map v10 (hierarchical
 *    summaries module → file → symbol, nén theo ngân sách token),
 *    query theo symbol hoặc theo từ khóa (PageRank v3).
 *  - coding_v10_edit     — áp edit bằng strategy selector (AST /
 *    search-replace / whole-file), có preview + commit atomic.
 *  - coding_v10_eval     — chạy suite eval v10 (6 task mẫu), lưu
 *    kết quả theo phiên bản agent; so sánh/bảng các phiên bản.
 *  - coding_v10_agent    — chạy một task CodingAgentV10 end-to-end
 *    từ plan JSON (edit → codeact → verify loop → commit → snapshot).
 *  - coding_v10_snapshot — chụp/đọc snapshot của một phiên (để
 *    resume/fork sau này).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  CodingAgentV10,
  CodingV10Session,
  V10CodeActExecutor,
  V10RepoMap,
  applyV10Edit,
  compareV10EvalVersions,
  listV10EvalVersions,
  loadV10EvalSummary,
  renderV10AgentReport,
  renderV10RepoMapSummary,
  renderV10SessionReport,
  runV10EvalSuite,
  saveV10EvalReport,
  scriptedV10Agent,
  v10EvalVersionTable,
  v10PlanEditCandidates,
  renderV10EvalVersionTable,
  validateV10CodeActRequest,
} from '@open-bot/core';
import type { V10CodeActKind, V10EditStrategy } from '@open-bot/core';
import type { V10EditRequest } from '@open-bot/core';

const NOT_WIRED =
  'Coding agent v10 is not configured: the host has not wired a base directory yet. ' +
  'Bind createCodingV10Tools(getBaseDir) with the app userData directory first.';

export const CODING_V10_TOOL_NAMES = [
  'coding_v10_session',
  'coding_v10_codeact',
  'coding_v10_repomap',
  'coding_v10_edit',
  'coding_v10_eval',
  'coding_v10_agent',
  'coding_v10_snapshot',
] as const;

export type CodingV10ToolName = (typeof CODING_V10_TOOL_NAMES)[number];

export function isCodingV10ToolName(name: string): boolean {
  return (CODING_V10_TOOL_NAMES as readonly string[]).includes(name);
}

export interface CodingV10ToolOptions {
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

export function codingV10DataDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v10');
}

export function codingV10SessionsDir(baseDir: string): string {
  return path.join(codingV10DataDir(baseDir), 'sessions');
}

export function codingV10EvalDir(baseDir: string): string {
  return path.join(codingV10DataDir(baseDir), 'eval');
}

export function createCodingV10Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: CodingV10ToolOptions = {},
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
    return base ? path.join(base, 'coding-v10-workspace') : path.join(os.tmpdir(), 'open-bot-coding-v10-workspace');
  };

  const resolveSessionsDir = (): string | null => {
    const base = resolveBase();
    return base ? codingV10SessionsDir(base) : null;
  };

  const openSession = (sessionId: string, workingDir: string): CodingV10Session => {
    const sessionsDir = resolveSessionsDir();
    if (!sessionsDir) throw new Error(NOT_WIRED);
    return CodingV10Session.open(sessionsDir, sessionId, workingDir);
  };

  const sessionTool: Tool = {
    definition: toolDef(
      'coding_v10_session',
      'Manage a coding agent v10 event-sourced session (v1.18): start a new session, read its folded status, pause/resume it (persisted), replay it from the event log (hash-chain verified), fork it at any event seq, or list sessions. Every action/observation is an immutable event in an append-only log.',
      {
        action: { type: 'string', description: '"start" | "status" | "pause" | "resume" | "replay" | "fork" | "list".' },
        sessionId: { type: 'string', description: 'Session id (required except start/list).' },
        title: { type: 'string', description: 'Title for a new session (start).' },
        reason: { type: 'string', description: 'Reason for pause/resume.' },
        forkSeq: { type: 'integer', description: 'Event seq to fork at (fork).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      try {
        const action = getStringArg(args, 'action', true);
        const sessionsDir = resolveSessionsDir();
        if (!sessionsDir) return errorResult(NOT_WIRED);
        if (action === 'list') {
          return JSON.stringify({ sessions: CodingV10Session.listSessions(sessionsDir) }, null, 2);
        }
        if (action === 'start') {
          const session = new CodingV10Session({
            sessionsDir,
            workingDir,
            title: getStringArg(args, 'title') || 'coding session',
          });
          session.start();
          return JSON.stringify({ sessionId: session.sessionId, status: session.state() }, null, 2);
        }
        const sessionId = getStringArg(args, 'sessionId', true);
        const session = openSession(sessionId, workingDir);
        if (action === 'status') {
          return JSON.stringify({ ...session.state() }, null, 2);
        }
        if (action === 'pause') {
          session.pause(getStringArg(args, 'reason'));
          return JSON.stringify({ ...session.state() }, null, 2);
        }
        if (action === 'resume') {
          session.resume(getStringArg(args, 'reason'));
          return JSON.stringify({ ...session.state() }, null, 2);
        }
        if (action === 'replay') {
          const replayed = session.replay();
          return JSON.stringify(
            {
              sessionId,
              verification: replayed.verification,
              snapshotMatches: replayed.snapshotMatches,
              report: renderV10SessionReport(replayed.state),
            },
            null,
            2,
          );
        }
        if (action === 'fork') {
          const forkSeq = getIntArg(args, 'forkSeq');
          if (forkSeq === undefined) throw new Error('forkSeq is required for fork.');
          const forked = session.fork(forkSeq);
          return JSON.stringify({ parentSessionId: sessionId, ...forked }, null, 2);
        }
        return errorResult(`unknown session action: ${action}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const codeactTool: Tool = {
    definition: toolDef(
      'coding_v10_codeact',
      'Run CodeAct-style code in the local sandbox (v1.18): write node/python code or a bash command, run it with argv (no shell), timeout and output caps, allowlist + denylist enforced. Returns stdout/stderr/exit code as an observation. Optionally records the run into a v10 session.',
      {
        kind: { type: 'string', description: '"node" | "python" | "bash".' },
        code: { type: 'string', description: 'Source code (node/python) or command (bash).' },
        argsJson: { type: 'string', description: 'Optional JSON array of extra args for node/python scripts.' },
        timeoutMs: { type: 'integer', description: 'Timeout in ms (default 30000, max 120000).' },
        sessionId: { type: 'string', description: 'Optional session id to record the action + observation into.' },
      },
      ['kind', 'code'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      try {
        const kind = getStringArg(args, 'kind', true) as V10CodeActKind;
        const code = getStringArg(args, 'code', true);
        const rawArgs = getStringArg(args, 'argsJson');
        const extraArgs = rawArgs
          ? (parseJsonArrayArg(rawArgs, 'argsJson') as string[])
          : [];
        const request = { kind, code, args: extraArgs, timeoutMs: getIntArg(args, 'timeoutMs') };
        validateV10CodeActRequest(request);
        const sessionId = getStringArg(args, 'sessionId');
        if (sessionId) {
          openSession(sessionId, workingDir).recordAction('codeact-run', { kind, codePreview: code.slice(0, 200) });
        }
        const executor = new V10CodeActExecutor({ workingDir });
        const result = await executor.run(request);
        if (sessionId) {
          openSession(sessionId, workingDir).recordObservation('codeact-result', {
            kind: result.kind,
            status: result.status,
            exitCode: result.exitCode,
            stdoutPreview: result.stdout.slice(0, 500),
            stderrPreview: result.stderr.slice(0, 500),
            durationMs: result.durationMs,
          });
        }
        return JSON.stringify({ workingDir, ...result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const repomapTool: Tool = {
    definition: toolDef(
      'coding_v10_repomap',
      'Build/query the coding agent v10 repo map (v1.18): hierarchical summaries module -> file -> symbol on top of the v8 PageRank graph, rendered under a token budget (token compression), or query by symbol name / free text. Incremental: only changed files are re-parsed (content hash).',
      {
        action: { type: 'string', description: '"build" | "render" | "symbol" | "text".' },
        budget: { type: 'integer', description: 'Token budget for render (default 4000).' },
        query: { type: 'string', description: 'Symbol name (symbol) or free text (text).' },
        limit: { type: 'integer', description: 'Max hits (default 10).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      try {
        const action = getStringArg(args, 'action', true);
        const map = new V10RepoMap(workingDir);
        map.scanAndBuild();
        if (action === 'build') {
          const current = map.current();
          return JSON.stringify(
            {
              workingDir,
              fileCount: current?.fileCount,
              symbolCount: current?.symbolCount,
              moduleCount: current?.moduleCount,
              totalTokenEstimate: current?.totalTokenEstimate,
              lastUpdate: map.lastUpdate(),
            },
            null,
            2,
          );
        }
        if (action === 'render') {
          const rendered = map.render(getIntArg(args, 'budget') ?? 4000);
          return JSON.stringify({ workingDir, summary: renderV10RepoMapSummary(rendered), ...rendered }, null, 2);
        }
        if (action === 'symbol') {
          const query = getStringArg(args, 'query', true);
          return JSON.stringify({ workingDir, ...map.querySymbol(query, getIntArg(args, 'limit')) }, null, 2);
        }
        if (action === 'text') {
          const query = getStringArg(args, 'query', true);
          return JSON.stringify({ workingDir, query, hits: map.queryText(query, getIntArg(args, 'limit')) }, null, 2);
        }
        return errorResult(`unknown repomap action: ${action}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const editTool: Tool = {
    definition: toolDef(
      'coding_v10_edit',
      'Apply one edit with the v10 strategy selector (v1.18): previews AST-aware, search-replace block and whole-file strategies, scores them, applies the best (or the forced one, with fallback), verifies by re-parsing, and optionally commits atomically (git-first). Dry-run previews the candidates without writing.',
      {
        path: { type: 'string', description: 'Repo-relative file path, e.g. "src/util.ts".' },
        kind: { type: 'string', description: 'V9 edit kind: "replace-symbol" | "replace-import" | "insert-after" | "rename-symbol" | "search-replace".' },
        symbolName: { type: 'string', description: 'Target symbol name.' },
        qualifiedName: { type: 'string', description: 'Optional qualified name, e.g. "Calc.sum".' },
        newText: { type: 'string', description: 'New symbol text (replace-symbol / insert-after).' },
        newSpecifier: { type: 'string', description: 'New module specifier (replace-import).' },
        newName: { type: 'string', description: 'New name (rename-symbol).' },
        oldBlock: { type: 'string', description: 'Exact old block (search-replace).' },
        newBlock: { type: 'string', description: 'New block (search-replace).' },
        newContent: { type: 'string', description: 'Full new file content (whole-file fallback).' },
        forceStrategy: { type: 'string', description: 'Optional forced strategy: "ast" | "search-replace" | "whole-file".' },
        commit: { type: 'boolean', description: 'Commit atomically after a successful edit (default false).' },
        dryRun: { type: 'boolean', description: 'true = preview candidates only, do not write.' },
        sessionId: { type: 'string', description: 'Optional session id to record the edit-result into.' },
      },
      ['path', 'kind'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      try {
        const request: V10EditRequest = {
          operation: {
            kind: getStringArg(args, 'kind', true) as V10EditRequest['operation']['kind'],
            path: getStringArg(args, 'path', true),
            symbolName: getStringArg(args, 'symbolName') || undefined,
            qualifiedName: getStringArg(args, 'qualifiedName') || undefined,
            newText: getStringArg(args, 'newText') || undefined,
            newSpecifier: getStringArg(args, 'newSpecifier') || undefined,
            newName: getStringArg(args, 'newName') || undefined,
            oldBlock: getStringArg(args, 'oldBlock') || undefined,
            newBlock: getStringArg(args, 'newBlock') || undefined,
          },
          newContent: getStringArg(args, 'newContent') || undefined,
          forceStrategy: (getStringArg(args, 'forceStrategy') || undefined) as V10EditStrategy | undefined,
          commit: getBoolArg(args, 'commit'),
        };
        const sessionId = getStringArg(args, 'sessionId');
        const dryRun = getBoolArg(args, 'dryRun') ?? false;
        if (dryRun) {
          const candidates = v10PlanEditCandidates(request, { workingDir });
          return JSON.stringify({ workingDir, dryRun: true, candidates }, null, 2);
        }
        const result = await applyV10Edit(request, {
          workingDir,
          onEvent: sessionId
            ? (event) => {
                openSession(sessionId, workingDir).recordObservation(event.type, event.payload);
              }
            : undefined,
        });
        return JSON.stringify({ workingDir, ...result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'coding_v10_eval',
      'Run the coding agent v10 sample eval (v1.18): 6 small JS tasks (3 from v9 + dedupe/capitalize/max) on temp repos, scored SWE-bench-style with the scripted agent. Results are stored per agent version; "table" lists pass@k per version and "compare" diffs two versions.',
      {
        action: { type: 'string', description: '"run" | "table" | "compare".' },
        agentVersion: { type: 'string', description: 'Agent version to save the run under (run, default "v10").' },
        attemptsPerTask: { type: 'integer', description: 'Attempts per task, k of pass@k (default 3).' },
        olderVersion: { type: 'string', description: 'Older version (compare).' },
        newerVersion: { type: 'string', description: 'Newer version (compare).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const action = getStringArg(args, 'action', true);
        const evalDir = codingV10EvalDir(base);
        if (action === 'table') {
          const rows = v10EvalVersionTable(evalDir);
          return JSON.stringify({ table: renderV10EvalVersionTable(rows), rows }, null, 2);
        }
        if (action === 'compare') {
          const older = getStringArg(args, 'olderVersion', true);
          const newer = getStringArg(args, 'newerVersion', true);
          const comparison = compareV10EvalVersions(evalDir, older, newer);
          return JSON.stringify({ ...comparison }, null, 2);
        }
        if (action === 'run') {
          const agentVersion = getStringArg(args, 'agentVersion') || 'v10';
          const { report } = await runV10EvalSuite(scriptedV10Agent, {
            agentVersion,
            attemptsPerTask: getIntArg(args, 'attemptsPerTask') ?? 3,
          });
          const saved = saveV10EvalReport(report, agentVersion, evalDir);
          const summary = loadV10EvalSummary(evalDir, agentVersion);
          return JSON.stringify({ agentVersion, detailFile: saved.detailFile, summary, report }, null, 2);
        }
        return errorResult(`unknown eval action: ${action}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const agentTool: Tool = {
    definition: toolDef(
      'coding_v10_agent',
      'Run one CodingAgentV10 task end-to-end (v1.18) in the workspace: edits from a JSON plan via the strategy selector, optional CodeAct runs, sandbox-loop verify, atomic commit, and a session snapshot. Every step is recorded as an event in the session log (event-sourced). The plan is a JSON array of edit requests; the agent does not invent edits.',
      {
        title: { type: 'string', description: 'Short task title.' },
        task: { type: 'string', description: 'Task description.' },
        planJson: { type: 'string', description: 'JSON array of edit requests, e.g. [{"operation":{"kind":"replace-symbol","path":"util.mjs","symbolName":"greet","newText":"..."}}].' },
        verifyCommandsJson: { type: 'string', description: 'Optional JSON array of argv arrays to verify with.' },
        codeActJson: { type: 'string', description: 'Optional JSON array of CodeAct requests, e.g. [{"kind":"node","code":"console.log(1)"}].' },
        maxRounds: { type: 'integer', description: 'Max sandbox loop rounds (default 5).' },
        autoCommit: { type: 'boolean', description: 'Commit atomically after green verify (default true).' },
        repoMapBudget: { type: 'integer', description: 'Token budget for the repo map in the plan context (0 = off).' },
      },
      ['title', 'task', 'planJson'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      const sessionsDir = resolveSessionsDir();
      if (!sessionsDir) return errorResult(NOT_WIRED);
      try {
        const raw = parseJsonArrayArg(getStringArg(args, 'planJson', true), 'planJson');
        const plan = raw as V10EditRequest[];
        for (const [i, req] of plan.entries()) {
          if (!req || typeof req !== 'object' || !req.operation || typeof req.operation.kind !== 'string') {
            throw new Error(`planJson[${i}] must be an edit request with an "operation" object.`);
          }
        }
        const verifyRaw = getStringArg(args, 'verifyCommandsJson');
        const verifyCommands: string[][] | undefined = verifyRaw
          ? (parseJsonArrayArg(verifyRaw, 'verifyCommandsJson') as string[][])
          : undefined;
        const codeActRaw = getStringArg(args, 'codeActJson');
        const codeActRequests = codeActRaw
          ? (parseJsonArrayArg(codeActRaw, 'codeActJson') as Array<{ kind: V10CodeActKind; code: string; args?: string[] }>)
          : undefined;
        const agent = new CodingAgentV10({
          workingDir,
          sessionsDir,
          planProvider: () => plan,
          verifyCommands,
          maxRounds: getIntArg(args, 'maxRounds'),
          autoCommit: getBoolArg(args, 'autoCommit'),
          codeActRequests,
          repoMapBudget: getIntArg(args, 'repoMapBudget'),
          summary: getStringArg(args, 'title', true),
        });
        const report = await agent.runTask(getStringArg(args, 'title', true), getStringArg(args, 'task', true));
        return JSON.stringify({ workingDir, reportText: renderV10AgentReport(report), ...report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const snapshotTool: Tool = {
    definition: toolDef(
      'coding_v10_snapshot',
      'Snapshot a coding agent v10 session (v1.18): capture the folded state at the current seq (with a digest for replay comparison) or read the latest saved snapshot. Snapshots let a session resume or fork later from exactly this point.',
      {
        action: { type: 'string', description: '"take" | "read".' },
        sessionId: { type: 'string', description: 'Session id.' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workingDir = resolveWorkspaceDir(ctx);
      try {
        const action = getStringArg(args, 'action', true);
        const session = openSession(getStringArg(args, 'sessionId', true), workingDir);
        if (action === 'take') {
          const snap = session.snapshot();
          return JSON.stringify({ ...snap }, null, 2);
        }
        if (action === 'read') {
          const snap = session.readSnapshot();
          if (!snap) return errorResult(`No snapshot saved for session ${session.sessionId}.`);
          return JSON.stringify({ ...snap }, null, 2);
        }
        return errorResult(`unknown snapshot action: ${action}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [sessionTool, codeactTool, repomapTool, editTool, evalTool, agentTool, snapshotTool];
}

/** Placeholder tools (unbound) for ALL_TOOLS — same names, never a duplicate. */
export const CODING_V10_TOOLS: Tool[] = createCodingV10Tools();

/** Ensure the tools use the fs import (keeps the data-dir helper honest). */
export function codingV10EnsureDataDir(baseDir: string): string {
  const dir = codingV10DataDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
