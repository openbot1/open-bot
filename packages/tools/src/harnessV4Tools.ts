/**
 * Harness v4 tools cho @open-bot/tools (v1.08, Đội T3).
 *
 * Ý tưởng học từ survey v1.08 phần OpenHands (chỉ học ý tưởng, không
 * copy code/text/tài sản của bất kỳ repo nào):
 * - EventLog append-only bất biến cho mọi turn (persist JSONL,
 *   replay toàn bộ phiên, time-travel debug).
 * - CodeAct executor (viết + chạy Python/Bash trong sandbox, quan
 *   sát output, lặp theo lỗi).
 * - Dependency sweep cho repo lớn (thứ tự thay đổi đúng, nhiều agent
 *   song song không xung đột).
 *
 * 12 tool:
 * - EventLog (6): create / append / replay / verify / timetravel / list.
 * - CodeAct (2): run (một lần) / loop (chạy → fixer sửa → chạy lại).
 * - Dependency sweep (4): order / conflicts / partition / graph.
 *
 * An toàn:
 * - EventLog chỉ ghi trong `logDir` của factory (mặc định thư mục tạm
 *   của OS); sessionId được sanitize thành tên file an toàn.
 * - CodeAct chạy qua `CodeActExecutor` v2 của host (BotBox sandbox,
 *   denylist, timeout, cap output/ghi); chưa bind executor thì tool
 *   trả hướng dẫn, không giả vờ chạy. Code chỉ chạy local, không gọi
 *   mạng ngoài (trừ khi code trong sandbox tự gọi — box + prlimit là
 *   lớp chặn còn lại, như CodeAct v2).
 * - Dependency sweep chỉ đọc file (inline qua args, hoặc quét thư
 *   mục trong `repoRoot`/workspace của caller); không ghi file nào.
 * - Mọi kết quả đều cắt ở MAX_TOOL_RESULT_CHARS.
 *
 * Factory (cùng pattern với createHarnessV107Tools):
 *   createHarnessV4Tools(opts?) -> Tool[]   (bound, usable)
 *   HARNESS_V4_TOOLS                       (unbound placeholders)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Tool, ToolContext } from '@open-bot/core';
import type { CodeActExecutor } from '@open-bot/core';
import {
  CodeActV4Loop,
  HarnessV4EventLog,
  analyzeHarnessV4Dependencies,
  classifyHarnessV4Error,
  codeActActionFromToolArgs,
  codeActResultToText,
  detectHarnessV4Conflicts,
  foldHarnessV4Events,
  harnessV4ImpactOf,
  harnessV4TruncateText,
  safeHarnessV4Order,
  suggestHarnessV4Partition,
} from '@open-bot/core';
import type {
  HarnessV4EventKind,
  HarnessV4Fixer,
  HarnessV4SweepFile,
} from '@open-bot/core';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

export const HARNESS_V4_TOOL_NAMES = [
  'harness_v4_eventlog_create',
  'harness_v4_eventlog_append',
  'harness_v4_eventlog_replay',
  'harness_v4_eventlog_verify',
  'harness_v4_eventlog_timetravel',
  'harness_v4_eventlog_list',
  'harness_v4_codeact_run',
  'harness_v4_codeact_loop',
  'harness_v4_deps_order',
  'harness_v4_deps_conflicts',
  'harness_v4_deps_partition',
  'harness_v4_deps_graph',
] as const;

export interface HarnessV4ToolOptions {
  /**
   * Thư mục chứa file JSONL của EventLog v4. Mặc định
   * `<tmpdir>/open-bot-harness-v4-logs`.
   */
  logDir?: string;
  /**
   * Resolver CodeActExecutor v2 cho `harness_v4_codeact_*` (host nối
   * vào BotBoxManager của bot). Không truyền → tool trả hướng dẫn
   * cấu hình, không chạy code giả.
   */
  getCodeActExecutor?: (ctx: ToolContext) => CodeActExecutor | null | undefined;
  /**
   * Hàm sửa code cho `harness_v4_codeact_loop` (host nối model).
   * Không truyền → loop chỉ chạy 1 vòng rồi dừng (không tự sửa).
   */
  fixCode?: HarnessV4Fixer;
  /**
   * Thư mục gốc cho phép quét repo khi tool nhận `repoDir` (mặc
   * định: workspaceDir của caller). `repoDir` ngoài phạm vi này bị
   * từ chối.
   */
  repoRoot?: string;
}

const DEFAULT_LOG_DIR = path.join(os.tmpdir(), 'open-bot-harness-v4-logs');

const NOT_BOUND_CODEACT =
  'CodeAct executor chưa được cấu hình: host cần truyền getCodeActExecutor cho createHarnessV4Tools (nối vào BotBoxManager của bot). Code chưa được chạy.';

const HARNESS_V4_EVENT_KINDS: HarnessV4EventKind[] = [
  'h4.session.started',
  'h4.user.message',
  'h4.model.reply',
  'h4.tool.call',
  'h4.tool.result',
  'h4.codeact.run',
  'h4.codeact.loop',
  'h4.error',
  'h4.checkpoint',
  'h4.session.ended',
];

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

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Argument "${name}" phải là object JSON.`);
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Argument "${name}" không phải JSON hợp lệ: ${(err as Error).message}`);
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" phải là object.`);
  }
  return value as Record<string, unknown>;
}

function getFilesArg(args: Record<string, unknown>, name = 'files'): HarnessV4SweepFile[] {
  const value = args[name];
  const raw: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(raw)) throw new Error(`Argument "${name}" phải là mảng [{path, content}].`);
  const out: HarnessV4SweepFile[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Mỗi file trong "${name}" phải là {path, content}.`);
    }
    const f = item as Record<string, unknown>;
    if (typeof f['path'] !== 'string' || typeof f['content'] !== 'string') {
      throw new Error(`Mỗi file trong "${name}" phải có path (string) và content (string).`);
    }
    out.push({ path: f['path'], content: f['content'] });
  }
  if (out.length === 0) throw new Error(`Argument "${name}" không được rỗng.`);
  return out;
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

/** Quét repoDir lấy file TS/JS/Python (bỏ node_modules/.git/dist, cap 5000 file). */
function scanHarnessV4RepoDir(repoDir: string): HarnessV4SweepFile[] {
  const out: HarnessV4SweepFile[] = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__']);
  const walk = (dir: string): void => {
    if (out.length >= 5000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 5000) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py)$/.test(entry.name)) {
        try {
          const stat = fs.statSync(full);
          if (stat.size > 1024 * 1024) continue;
          out.push({ path: path.relative(repoDir, full).replace(/\\/g, '/'), content: fs.readFileSync(full, 'utf8') });
        } catch {
          // File đọc lỗi thì bỏ qua, không hỏng cả sweep.
        }
      }
    }
  };
  walk(repoDir);
  return out;
}

/** Lấy danh sách file sweep: ưu tiên `files` inline, rồi `repoDir`. */
function resolveSweepFiles(
  args: Record<string, unknown>,
  opts: HarnessV4ToolOptions,
  ctx: ToolContext,
): HarnessV4SweepFile[] {
  if (args['files'] !== undefined && args['files'] !== null) return getFilesArg(args, 'files');
  const repoDir = getStringArg(args, 'repoDir');
  const root = opts.repoRoot ?? (typeof ctx.workspaceDir === 'string' ? ctx.workspaceDir : process.cwd());
  const resolved = path.resolve(root, repoDir);
  const inside = resolved === root || resolved.startsWith(`${root}${path.sep}`);
  if (!inside) throw new Error(`repoDir "${repoDir}" nằm ngoài phạm vi cho phép (${root}).`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`repoDir "${repoDir}" không phải thư mục tồn tại.`);
  }
  const files = scanHarnessV4RepoDir(resolved);
  if (files.length === 0) throw new Error(`repoDir "${repoDir}" không có file TS/JS/Python nào để sweep.`);
  return files;
}

/** Đảm bảo session tồn tại trong log (tạo mới khi chưa có). */
function ensureHarnessV4Session(
  log: HarnessV4EventLog,
  sessionId: string,
  ctx: ToolContext,
): void {
  try {
    log.readSession(sessionId);
  } catch {
    log.createSession(sessionId, {
      botId: typeof ctx.botId === 'string' ? ctx.botId : 'unknown',
      title: 'Session tạo bởi harness_v4 tool',
    });
  }
}

/** Tạo 12 tool harness v4 (bound với opts — logDir/executor/fixer/repoRoot). */
export function createHarnessV4Tools(opts: HarnessV4ToolOptions = {}): Tool[] {
  const log = new HarnessV4EventLog({ logDir: opts.logDir ?? DEFAULT_LOG_DIR });

  const createTool: Tool = {
    definition: toolDef(
      'harness_v4_eventlog_create',
      'Create a new harness v4 session (append-only EventLog, JSONL on disk with a SHA-256 hash chain). Returns the session id and the first event (h4.session.started). Use before appending events for a new agent turn/session.',
      {
        sessionId: { type: 'string', description: 'Id session (duy nhất; sẽ thành tên file .jsonl an toàn).' },
        botId: { type: 'string', description: 'Bot sở hữu session.' },
        title: { type: 'string', description: 'Tiêu đề ngắn của session.' },
        model: { type: 'string', description: 'Model/provider dùng cho session (tuỳ chọn).' },
      },
      ['sessionId', 'botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const botId = getStringArg(args, 'botId');
        const title = getOptionalStringArg(args, 'title');
        const model = getOptionalStringArg(args, 'model');
        const event = log.createSession(sessionId, {
          botId,
          ...(title !== undefined ? { title } : {}),
          ...(model !== undefined ? { model } : {}),
        });
        return truncate(JSON.stringify({ sessionId, botId, firstEvent: event, file: log.sessionFilePath(sessionId) }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const appendTool: Tool = {
    definition: toolDef(
      'harness_v4_eventlog_append',
      'Append one event to a harness v4 session log (append-only: seq and SHA-256 hash chain are assigned by the log, old events are never modified). kind must be one of h4.session.started, h4.user.message, h4.model.reply, h4.tool.call, h4.tool.result, h4.codeact.run, h4.codeact.loop, h4.error, h4.checkpoint, h4.session.ended. The session is created automatically if it does not exist yet.',
      {
        sessionId: { type: 'string', description: 'Id session.' },
        kind: { type: 'string', enum: [...HARNESS_V4_EVENT_KINDS], description: 'Loại event h4.*.' },
        payload: { type: 'object', description: 'Payload của event (object; vd {text, step} cho h4.user.message).' },
      },
      ['sessionId', 'kind', 'payload'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const kind = getStringArg(args, 'kind') as HarnessV4EventKind;
        if (!HARNESS_V4_EVENT_KINDS.includes(kind)) {
          return errorResult(`Unknown event kind "${kind}".`);
        }
        const payload = getObjectArg(args, 'payload');
        ensureHarnessV4Session(log, sessionId, ctx);
        const event = log.append(sessionId, { type: kind, payload: payload as never });
        return truncate(JSON.stringify({ sessionId, seq: event.seq, type: event.type, hash: event.hash }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const replayTool: Tool = {
    definition: toolDef(
      'harness_v4_eventlog_replay',
      'Replay a harness v4 session: fold all its events back into the session state (transcript, tool calls, CodeAct runs, errors, tokens, digest). The digest must match across replays of the same log. Optionally limit to a seq range (fromSeq..toSeq) to replay only a prefix.',
      {
        sessionId: { type: 'string', description: 'Id session.' },
        fromSeq: { type: 'integer', description: 'Seq bắt đầu (mặc định 1).' },
        toSeq: { type: 'integer', description: 'Seq kết thúc (mặc định hết log).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const fromSeq = getIntArg(args, 'fromSeq') ?? 1;
        const toSeq = getIntArg(args, 'toSeq');
        const { events } = log.readSession(sessionId);
        const sliced = events.filter((e) => e.seq >= fromSeq && (toSeq === undefined || e.seq <= toSeq));
        if (sliced.length === 0) return errorResult(`Session ${sessionId} không có event nào trong khoảng seq ${fromSeq}..${toSeq ?? 'hết'}.`);
        const state = foldHarnessV4Events(sessionId, sliced);
        return truncate(JSON.stringify({ sessionId, eventsReplayed: sliced.length, state }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const verifyTool: Tool = {
    definition: toolDef(
      'harness_v4_eventlog_verify',
      'Verify a harness v4 session log: recompute the whole SHA-256 hash chain and the seq sequence. Returns ok=true when the log is intact, or the first bad seq and reason when the log was tampered with or corrupted.',
      {
        sessionId: { type: 'string', description: 'Id session.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const verification = log.verify(sessionId);
        return truncate(JSON.stringify(verification, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const timetravelTool: Tool = {
    definition: toolDef(
      'harness_v4_eventlog_timetravel',
      'Time-travel debug for a harness v4 session: show the session state at step N (fold only events up to seq N) plus how far it is from the final state (steps/tokens/tool calls/codeact/errors delta). The original log is never modified. Use harness_v4_eventlog_replay with toSeq to resume from step N in a new session instead.',
      {
        sessionId: { type: 'string', description: 'Id session.' },
        atSeq: { type: 'integer', description: 'Seq muốn quay tới (0..tổng seq).' },
      },
      ['sessionId', 'atSeq'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const atSeq = getIntArg(args, 'atSeq', true) as number;
        const result = log.stateAt(sessionId, atSeq);
        return truncate(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const listTool: Tool = {
    definition: toolDef(
      'harness_v4_eventlog_list',
      'List harness v4 sessions in the log directory (newest first): session id, bot, status, event count, tool calls, CodeAct runs, errors. Use to find a session to replay, verify, or time-travel.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const sessions = log.listSessions();
        return truncate(JSON.stringify({ count: sessions.length, sessions }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const codeactRunTool: Tool = {
    definition: toolDef(
      'harness_v4_codeact_run',
      'Run ONE CodeAct action (bash | python | edit) in the bot sandbox and observe stdout/stderr/exit code. bash runs /bin/sh -c <command>; python runs the code as a temp script; edit writes a file inside the sandbox workspace. The run is logged to the harness v4 EventLog when sessionId is given. Destructive commands are blocked by the CodeAct denylist. Returns the full Action → Execution → Observation record.',
      {
        kind: { type: 'string', enum: ['bash', 'python', 'edit'], description: 'Loại action.' },
        command: { type: 'string', description: 'Lệnh shell (kind=bash).' },
        code: { type: 'string', description: 'Code Python (kind=python).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Đối số dòng lệnh cho script Python.' },
        path: { type: 'string', description: 'Đường dẫn tương đối trong workspace (kind=edit).' },
        content: { type: 'string', description: 'Nội dung ghi (kind=edit).' },
        mode: { type: 'string', enum: ['write', 'append'], description: 'write = ghi đè/tạo mới; append = nối cuối (kind=edit).' },
        timeoutMs: { type: 'integer', description: 'Timeout lần chạy này (ms).' },
        sessionId: { type: 'string', description: 'Session v4 để ghi event h4.codeact.run (tuỳ chọn).' },
        step: { type: 'integer', description: 'Step hiện tại trong session (mặc định 0).' },
      },
      ['kind'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      try {
        if (opts.getCodeActExecutor === undefined) return NOT_BOUND_CODEACT;
        const executor = opts.getCodeActExecutor(ctx);
        if (executor === undefined || executor === null) return NOT_BOUND_CODEACT;
        const action = codeActActionFromToolArgs(args);
        const result = await executor.execute(action);
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const step = getIntArg(args, 'step') ?? 0;
        if (sessionId !== undefined) {
          ensureHarnessV4Session(log, sessionId, ctx);
          const o = result.observation;
          const previewSource = `${o.stdout}\n${o.stderr}`.trim();
          log.append(sessionId, {
            type: 'h4.codeact.run',
            payload: {
              runId: result.execution.id,
              step,
              actionKind: result.action.kind,
              summary: codeActResultToText(result).split('\n')[0] ?? result.action.kind,
              exitCode: o.exitCode,
              timedOut: o.timedOut,
              durationMs: o.durationMs,
              outputPreview: harnessV4TruncateText(previewSource, 500),
            },
          });
        }
        return truncate(JSON.stringify({ action, execution: result.execution, observation: result.observation }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const codeactLoopTool: Tool = {
    definition: toolDef(
      'harness_v4_codeact_loop',
      'Run a CodeAct action in a fix loop: execute in the sandbox, classify the error (syntax/runtime/timeout/not_found/permission/blocked), ask the fixer to rewrite the code, and run again — up to maxRounds (default 5). Stops immediately on success (exit 0) or when the command is blocked. Without a configured fixer the loop runs once and reports the error classification. Every round is logged to the harness v4 EventLog when sessionId is given.',
      {
        kind: { type: 'string', enum: ['bash', 'python', 'edit'], description: 'Loại action.' },
        command: { type: 'string', description: 'Lệnh shell (kind=bash).' },
        code: { type: 'string', description: 'Code Python (kind=python).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Đối số dòng lệnh cho script Python.' },
        path: { type: 'string', description: 'Đường dẫn tương đối trong workspace (kind=edit).' },
        content: { type: 'string', description: 'Nội dung ghi (kind=edit).' },
        mode: { type: 'string', enum: ['write', 'append'], description: 'write = ghi đè/tạo mới; append = nối cuối (kind=edit).' },
        timeoutMs: { type: 'integer', description: 'Timeout mỗi vòng (ms).' },
        maxRounds: { type: 'integer', description: 'Số vòng tối đa (1..20, mặc định 5).' },
        sessionId: { type: 'string', description: 'Session v4 để ghi event h4.codeact.run/loop (tuỳ chọn).' },
        step: { type: 'integer', description: 'Step hiện tại trong session (mặc định 0).' },
      },
      ['kind'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      try {
        if (opts.getCodeActExecutor === undefined) return NOT_BOUND_CODEACT;
        const executor = opts.getCodeActExecutor(ctx);
        if (executor === undefined || executor === null) return NOT_BOUND_CODEACT;
        const action = codeActActionFromToolArgs(args);
        const maxRounds = getIntArg(args, 'maxRounds') ?? 5;
        if (maxRounds < 1 || maxRounds > 20) return errorResult('maxRounds phải trong khoảng 1..20.');
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const step = getIntArg(args, 'step') ?? 0;
        if (sessionId !== undefined) ensureHarnessV4Session(log, sessionId, ctx);
        const loop = new CodeActV4Loop({
          executor,
          ...(opts.fixCode !== undefined ? { fixer: opts.fixCode } : {}),
          limits: { maxRounds },
          ...(sessionId !== undefined ? { eventLog: log, sessionId, step } : {}),
        });
        const result = await loop.run(action);
        const lastRound = result.rounds[result.rounds.length - 1]!;
        return truncate(
          JSON.stringify(
            {
              loopId: result.loopId,
              outcome: result.outcome,
              rounds: result.rounds.length,
              hitMaxRounds: result.hitMaxRounds,
              ...(result.lastErrorKind !== undefined ? { lastErrorKind: result.lastErrorKind } : {}),
              totalDurationMs: result.totalDurationMs,
              roundSummaries: result.rounds.map((r) => ({
                round: r.round,
                actionKind: r.action.kind,
                exitCode: r.result.observation.exitCode,
                timedOut: r.result.observation.timedOut,
                ...(r.errorKind !== undefined ? { errorKind: r.errorKind } : {}),
              })),
              finalObservation: lastRound.result.observation,
              fixerConfigured: opts.fixCode !== undefined,
              errorClassification: classifyHarnessV4Error(lastRound.result),
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

  const depsOrderTool: Tool = {
    definition: toolDef(
      'harness_v4_deps_order',
      'Safe change order for a set of files: topological order (dependencies first, dependents later) plus parallel levels — files in the same level do not depend on each other and can be edited at the same time. Pass files inline as [{path, content}] or a repoDir to scan. Cycles are reported (cyclic files go last) and missing imports are listed.',
      {
        files: { type: 'array', items: { type: 'object' }, description: 'Danh sách {path, content} (ưu tiên hơn repoDir).' },
        repoDir: { type: 'string', description: 'Thư mục repo để quét (khi không truyền files).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const files = resolveSweepFiles(args, opts, ctx);
        const graph = analyzeHarnessV4Dependencies(files);
        const order = safeHarnessV4Order(graph);
        return truncate(JSON.stringify({ files: graph.files.length, truncatedFiles: graph.truncatedFiles, ...order }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const depsConflictsTool: Tool = {
    definition: toolDef(
      'harness_v4_deps_conflicts',
      'Detect conflicts when several agents edit the same repo at once: direct (two agents editing the same file) and shared_dependency (one agent edits a file another agent\'s file depends on). Pass files inline as [{path, content}] or a repoDir, plus assignments as [{agent, files}]. Returns a clean flag when there is no conflict.',
      {
        files: { type: 'array', items: { type: 'object' }, description: 'Danh sách {path, content} (ưu tiên hơn repoDir).' },
        repoDir: { type: 'string', description: 'Thư mục repo để quét (khi không truyền files).' },
        assignments: { type: 'array', items: { type: 'object' }, description: 'Danh sách {agent, files[]} — agent nào sửa file nào.' },
      },
      ['assignments'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const files = resolveSweepFiles(args, opts, ctx);
        const rawAssignments = args['assignments'];
        const parsed: unknown = typeof rawAssignments === 'string' ? JSON.parse(rawAssignments) : rawAssignments;
        if (!Array.isArray(parsed)) return errorResult('Argument "assignments" phải là mảng [{agent, files}].');
        const assignments = parsed.map((a) => {
          if (a === null || typeof a !== 'object' || Array.isArray(a)) throw new Error('Mỗi assignment phải là {agent, files}.');
          const item = a as Record<string, unknown>;
          if (typeof item['agent'] !== 'string' || !Array.isArray(item['files'])) {
            throw new Error('Mỗi assignment phải có agent (string) và files (string[]).');
          }
          return { agent: item['agent'] as string, files: (item['files'] as unknown[]).map(String) };
        });
        const graph = analyzeHarnessV4Dependencies(files);
        const report = detectHarnessV4Conflicts(graph, assignments);
        return truncate(JSON.stringify({ files: graph.files.length, ...report }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const depsPartitionTool: Tool = {
    definition: toolDef(
      'harness_v4_deps_partition',
      'Suggest how to split a set of files across N agents so parallel agents do not conflict: files are dealt in safe-order segments (dependencies first) so shared dependencies stay inside one agent as much as possible. Cyclic files go to the first agent, to edit last. Pass files inline as [{path, content}] or a repoDir.',
      {
        files: { type: 'array', items: { type: 'object' }, description: 'Danh sách {path, content} (ưu tiên hơn repoDir).' },
        repoDir: { type: 'string', description: 'Thư mục repo để quét (khi không truyền files).' },
        agentCount: { type: 'integer', description: 'Số agent (1..32, mặc định 2).' },
        agentNames: { type: 'array', items: { type: 'string' }, description: 'Tên agent (tuỳ chọn; mặc định agent-1..N).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const files = resolveSweepFiles(args, opts, ctx);
        const agentCount = getIntArg(args, 'agentCount') ?? 2;
        if (agentCount < 1 || agentCount > 32) return errorResult('agentCount phải trong khoảng 1..32.');
        const agentNamesRaw = args['agentNames'];
        const agentNames =
          Array.isArray(agentNamesRaw) && agentNamesRaw.every((x) => typeof x === 'string')
            ? (agentNamesRaw as string[])
            : undefined;
        const graph = analyzeHarnessV4Dependencies(files);
        const partition = suggestHarnessV4Partition(graph, agentCount, agentNames);
        return truncate(JSON.stringify({ files: graph.files.length, ...partition }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const depsGraphTool: Tool = {
    definition: toolDef(
      'harness_v4_deps_graph',
      'Dependency graph summary for a set of files: nodes, edges (A imports B), leaves (files with no imports), import cycles, and missing imports (relative imports that resolve to no file in the set). Pass files inline as [{path, content}] or a repoDir to scan. Optionally pass changedFiles to also get impact analysis: every file that depends (directly or indirectly) on the changed files.',
      {
        files: { type: 'array', items: { type: 'object' }, description: 'Danh sách {path, content} (ưu tiên hơn repoDir).' },
        repoDir: { type: 'string', description: 'Thư mục repo để quét (khi không truyền files).' },
        changedFiles: { type: 'array', items: { type: 'string' }, description: 'File đã đổi — trả thêm phân tích ảnh hưởng (file nào phụ thuộc vào chúng).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const files = resolveSweepFiles(args, opts, ctx);
        const graph = analyzeHarnessV4Dependencies(files);
        const changedRaw = args['changedFiles'];
        const changedFiles =
          Array.isArray(changedRaw) && changedRaw.every((x) => typeof x === 'string')
            ? (changedRaw as string[])
            : undefined;
        return truncate(
          JSON.stringify(
            {
              files: graph.files.length,
              edges: graph.edges.length,
              leaves: graph.leaves,
              cycles: graph.cycles,
              missing: graph.missing,
              truncatedFiles: graph.truncatedFiles,
              edgeList: graph.edges,
              ...(changedFiles !== undefined && changedFiles.length > 0
                ? { impact: harnessV4ImpactOf(graph, changedFiles) }
                : {}),
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

  return [
    createTool,
    appendTool,
    replayTool,
    verifyTool,
    timetravelTool,
    listTool,
    codeactRunTool,
    codeactLoopTool,
    depsOrderTool,
    depsConflictsTool,
    depsPartitionTool,
    depsGraphTool,
  ];
}

/** Unbound placeholders (đăng ký vào ALL_TOOLS; host bind lại bằng factory). */
export const HARNESS_V4_TOOLS: Tool[] = createHarnessV4Tools();
