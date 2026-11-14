/**
 * Harness v1.03 tools cho @open-bot/tools (v1.03, Đội T1).
 *
 * Ý tưởng học từ survey v1.03 (OpenHands V1 SDK: CodeAct + event-
 * sourced conversation — chỉ học ý tưởng, không copy code/text/tài
 * sản của repo nào):
 *
 *  - `codeact_execute` — CodeAct-style tool: MỘT contract duy nhất
 *    Action → Execution → Observation cho bash + python + editor,
 *    thay vì nhiều tool bespoke rời rạc. Agent gửi một action
 *    (kind + code/path), harness thực thi trong workspace rồi trả
 *    một observation JSON chuẩn (status/exitCode/stdout/stderr/
 *    durationMs/changedFiles). Bash/python chạy qua `runShell`
 *    (denylist + cwd confinement + timeout + safe env của sandbox);
 *    editor chỉ chạm file trong workspace (`resolveWithin`).
 *  - `harness_run_fork` — fork một run tại một seq (time-travel fork).
 *  - `harness_run_replay` — time-travel: fold prefix của run tới một
 *    seq, trả trạng thái + digest tại điểm đó (chỉ đọc).
 *  - `harness_stuck_check` — phân tích log xem agent có kẹt/lặp
 *    không, kèm gợi ý can thiệp (chỉ đọc; có thể ghi marker audit).
 *  - `harness_run_compact` — condenser: tóm tắt prefix của run rồi
 *    ghi marker `run.compacted` (append-only, không xoá lịch sử).
 *
 * An toàn:
 *  - `codeact_execute` cần approval (chạy code thật trên máy user).
 *  - Bốn tool run-log chỉ đọc/ghi trong thư mục run-log
 *    (`<workspaceDir>/.open-bot/run-logs` mặc định, hoặc `logDir`
 *    truyền vào factory) — không chạm provider, không chạm mạng.
 *  - Mọi kết quả đều cắt ở MAX_TOOL_RESULT_CHARS.
 *
 * Factory (cùng pattern với createHarnessV2Tools):
 *   createHarnessV103Tools(opts?) -> Tool[]   (bound, usable)
 *   HARNESS_V103_TOOLS                        (unbound placeholders)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  RunLogStore,
  compactRun,
  detectStuckForRun,
  foldEvents,
  forkRunAt,
  listChildRuns,
  recordStuckDetection,
  replayUpTo,
} from '@open-bot/core';
import { assertCommandAllowed, resolveWithin, runShell } from './sandbox';
import { shellQuote } from './shellQuote';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

export const HARNESS_V103_TOOL_NAMES = [
  'codeact_execute',
  'harness_run_fork',
  'harness_run_replay',
  'harness_stuck_check',
  'harness_run_compact',
] as const;

export interface HarnessV103ToolOptions {
  /**
   * Thư mục chứa các file `.jsonl` run-log. Mặc định:
   * `<workspaceDir>/.open-bot/run-logs` (quy ước state dir của tools).
   * Khi host (coordinator) giữ log ở dataDir riêng thì truyền vào đây.
   */
  logDir?: string;
  /** Timeout mặc định cho codeact bash/python (ms). Mặc định 30_000. */
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CODE_CHARS = 50_000;

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
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getIntArg(args: Record<string, unknown>, name: string, required = false): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Argument "${name}" must be an integer, got ${typeof value}`);
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

/** Thư mục run-log mà tool dùng cho một lần gọi. */
function resolveLogDir(opts: HarnessV103ToolOptions | undefined, ctx: ToolContext): string {
  if (opts?.logDir) return opts.logDir;
  return path.join(ctx.workspaceDir, '.open-bot', 'run-logs');
}

/** Observation chuẩn của CodeAct: Action → Execution → Observation. */
export interface CodeActObservation {
  kind: 'bash' | 'python' | 'read' | 'write' | 'edit';
  status: 'ok' | 'error' | 'timeout';
  /** Exit code (null khi timeout/killed, hoặc khi kind là editor). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  changedFiles: string[];
}

function observationJson(obs: CodeActObservation): string {
  return truncate(JSON.stringify(obs, null, 2));
}

/**
 * Thực thi một CodeAct action. Tách riêng khỏi Tool để test trực
 * tiếp được mà không cần registry (`executeCodeAct` export cho test).
 */
export async function executeCodeAct(
  args: Record<string, unknown>,
  ctx: ToolContext,
  opts: HarnessV103ToolOptions = {},
): Promise<CodeActObservation> {
  const kind = getStringArg(args, 'kind');
  if (kind !== 'bash' && kind !== 'python' && kind !== 'read' && kind !== 'write' && kind !== 'edit') {
    throw new Error(`Unknown CodeAct kind "${kind}": expected bash | python | read | write | edit.`);
  }
  const timeoutMs = getIntArg(args, 'timeoutMs') ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Error(`timeoutMs must be between 1 and 300000, got ${timeoutMs}.`);
  }
  const started = Date.now();
  const finish = (
    status: CodeActObservation['status'],
    exitCode: number | null,
    stdout: string,
    stderr: string,
    changedFiles: string[],
  ): CodeActObservation => ({
    kind,
    status,
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    changedFiles,
  });

  if (kind === 'read') {
    const relPath = getStringArg(args, 'path');
    const abs = resolveWithin(ctx.workspaceDir, relPath);
    const content = fs.readFileSync(abs, 'utf8');
    return finish('ok', 0, content, '', []);
  }
  if (kind === 'write') {
    const relPath = getStringArg(args, 'path');
    const content = getStringArg(args, 'content');
    const abs = resolveWithin(ctx.workspaceDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return finish('ok', 0, `Wrote ${content.length} chars to ${relPath}`, '', [relPath]);
  }
  if (kind === 'edit') {
    const relPath = getStringArg(args, 'path');
    const oldText = getStringArg(args, 'oldText');
    const newText = getStringArg(args, 'newText');
    const abs = resolveWithin(ctx.workspaceDir, relPath);
    const content = fs.readFileSync(abs, 'utf8');
    if (!content.includes(oldText)) {
      return finish('error', 1, '', `oldText not found in ${relPath}`, []);
    }
    fs.writeFileSync(abs, content.replace(oldText, newText), 'utf8');
    return finish('ok', 0, `Replaced 1 occurrence in ${relPath}`, '', [relPath]);
  }

  // bash / python: code chạy qua runShell (denylist + cwd confinement).
  const code = getStringArg(args, 'code');
  if (code.length > MAX_CODE_CHARS) {
    throw new Error(`code is too long: ${code.length} chars (max ${MAX_CODE_CHARS}).`);
  }
  if (kind === 'bash') {
    assertCommandAllowed(code);
    const result = await runShell(code, ctx.workspaceDir, { workspaceDir: ctx.workspaceDir, timeoutMs });
    const status = result.code === 0 ? 'ok' : result.code === null ? 'timeout' : 'error';
    return finish(status, result.code, result.stdout, result.stderr, []);
  }
  // python: ghi code ra file tạm trong workspace rồi chạy `python3`.
  // File tạm nằm dưới `.open-bot/codeact/` để không lẫn với code user.
  const tmpDir = path.join(ctx.workspaceDir, '.open-bot', 'codeact');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `codeact-${randomUUID()}.py`);
  fs.writeFileSync(tmpFile, code, 'utf8');
  try {
    const command = `python3 ${shellQuote(tmpFile)}`;
    assertCommandAllowed(command);
    const result = await runShell(command, ctx.workspaceDir, { workspaceDir: ctx.workspaceDir, timeoutMs });
    const status = result.code === 0 ? 'ok' : result.code === null ? 'timeout' : 'error';
    return finish(status, result.code, result.stdout, result.stderr, []);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // File tạm sót lại không làm hỏng kết quả — dọn ở lần sau.
    }
  }
}

/** Tạo 5 tool harness v1.03 (bound với opts — logDir/timeout). */
export function createHarnessV103Tools(opts: HarnessV103ToolOptions = {}): Tool[] {
  const codeactExecute: Tool = {
    definition: toolDef(
      'codeact_execute',
      'Run one CodeAct action (bash, python, or file read/write/edit) and return a standard Observation {kind, status, exitCode, stdout, stderr, durationMs, changedFiles}. Bash/python run confined to the workspace with a timeout; editor actions only touch files inside the workspace. Use this instead of separate shell/file tools when one unified action->observation contract is wanted.',
      {
        kind: { type: 'string', enum: ['bash', 'python', 'read', 'write', 'edit'] },
        code: { type: 'string', description: 'Code to run (bash/python).' },
        path: { type: 'string', description: 'Workspace-relative file path (read/write/edit).' },
        content: { type: 'string', description: 'Full file content (write).' },
        oldText: { type: 'string', description: 'Exact text to replace (edit).' },
        newText: { type: 'string', description: 'Replacement text (edit).' },
        timeoutMs: { type: 'integer', description: 'Execution timeout in ms (1..300000, default 30000).' },
      },
      ['kind'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      try {
        return observationJson(await executeCodeAct(args, ctx, opts));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runFork: Tool = {
    definition: toolDef(
      'harness_run_fork',
      'Fork an agent run at a given event sequence number: copy the run log prefix up to that seq into a new child run. The parent log is never modified. Returns the child run id, fork seq, copied event count, and the child state at the fork point.',
      {
        runId: { type: 'string' },
        fromSeq: { type: 'integer', description: 'Parent seq to fork from (inclusive).' },
        childRunId: { type: 'string', description: 'Optional id for the child run.' },
      },
      ['runId', 'fromSeq'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const runId = getStringArg(args, 'runId');
        const fromSeq = getIntArg(args, 'fromSeq', true)!;
        const childRunId = getOptionalStringArg(args, 'childRunId');
        const store = new RunLogStore({ logDir: resolveLogDir(opts, ctx) });
        const result = forkRunAt(store, runId, fromSeq, {
          ...(childRunId !== undefined ? { childRunId } : {}),
        });
        return truncate(
          JSON.stringify(
            {
              parentRunId: result.parentRunId,
              childRunId: result.childRunId,
              forkFromSeq: result.forkFromSeq,
              copiedEvents: result.copiedEvents,
              childStateAtFork: {
                status: result.childStateAtFork.status,
                steps: result.childStateAtFork.steps,
                tokensUsed: result.childStateAtFork.tokensUsed,
                toolCalls: result.childStateAtFork.toolCalls.length,
                digest: result.childStateAtFork.digest,
              },
              branches: listChildRuns(store, runId).map((b) => b.runId),
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runReplay: Tool = {
    definition: toolDef(
      'harness_run_replay',
      'Time-travel a run: fold the run log prefix up to a seq and return the run state at that point (status, steps, tokens, tool calls, digest, transcript preview). Read-only; the log is never modified. Omit toSeq to replay the whole log.',
      {
        runId: { type: 'string' },
        toSeq: { type: 'integer', description: 'Seq to travel to (inclusive). Defaults to the last seq.' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const runId = getStringArg(args, 'runId');
        const toSeq = getIntArg(args, 'toSeq');
        const store = new RunLogStore({ logDir: resolveLogDir(opts, ctx) });
        const targetSeq =
          toSeq ?? store.readRun(runId).events.slice(-1)[0]?.seq ?? 0;
        const result = replayUpTo(store, runId, targetSeq);
        const state = result.state;
        return truncate(
          JSON.stringify(
            {
              runId: result.runId,
              atSeq: result.atSeq,
              totalSeq: result.totalSeq,
              eventsUsed: result.eventsUsed,
              status: state.status,
              prompt: state.prompt,
              steps: state.steps,
              tokensUsed: state.tokensUsed,
              toolCalls: state.toolCalls.map((c) => ({ tool: c.tool, status: c.status ?? 'pending' })),
              fileChanges: state.fileChanges.map((f) => f.path),
              errors: state.errors,
              digest: state.digest,
              transcriptPreview: state.transcript.slice(-5),
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stuckCheck: Tool = {
    definition: toolDef(
      'harness_stuck_check',
      'Check whether an agent run looks stuck: repeated identical tool calls, repeated tool/compile errors, empty-response loops, no-progress steps, or step-budget exhaustion. Read-only analysis; set record=true to also append a stuck.detected audit event when stuck.',
      {
        runId: { type: 'string' },
        record: { type: 'boolean', description: 'Append a stuck.detected event when stuck (default false).' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const runId = getStringArg(args, 'runId');
        const record = args['record'] === true;
        const store = new RunLogStore({ logDir: resolveLogDir(opts, ctx) });
        const report = detectStuckForRun(store, runId);
        let markerSeq = 0;
        if (record && report.stuck) markerSeq = recordStuckDetection(store, runId, report);
        return truncate(
          JSON.stringify(
            {
              runId: report.runId,
              stuck: report.stuck,
              step: report.step,
              signals: report.signals,
              suggestionKey: report.suggestionKey ?? null,
              ...(markerSeq > 0 ? { markerSeq } : {}),
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runCompact: Tool = {
    definition: toolDef(
      'harness_run_compact',
      'Condense a run log prefix into a short extractive summary and append a run.compacted marker event. The original events stay on disk (append-only); the summary replaces the prefix when loading context. Returns the summary plus before/after token estimates.',
      {
        runId: { type: 'string' },
        upToSeq: { type: 'integer', description: 'Last seq the summary covers (inclusive). Defaults to the last seq.' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const runId = getStringArg(args, 'runId');
        const upToSeq = getIntArg(args, 'upToSeq');
        const store = new RunLogStore({ logDir: resolveLogDir(opts, ctx) });
        const result = compactRun(store, runId, {
          ...(upToSeq !== undefined ? { upToSeq } : {}),
        });
        return truncate(
          JSON.stringify(
            {
              runId,
              upToSeq: result.upToSeq,
              eventsCovered: result.eventsCovered,
              tokensBefore: result.tokensBefore,
              tokensAfter: result.tokensAfter,
              markerSeq: result.markerSeq,
              summary: result.summary,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [codeactExecute, runFork, runReplay, stuckCheck, runCompact];
}

/** Unbound placeholders (đăng ký vào ALL_TOOLS; host bind lại bằng factory). */
export const HARNESS_V103_TOOLS: Tool[] = createHarnessV103Tools();

/** Trạng thái đã fold của một run — tiện cho test (không qua tool). */
export function foldRunLog(store: RunLogStore, runId: string) {
  return foldEvents(runId, store.readRun(runId).events);
}
