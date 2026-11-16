/**
 * Conversation v112 tools (v1.12, Đội T2) — 11 tools.
 *
 * Event-sourced conversation (scope nhiều turn/branch) + CodeAct-lite
 * + skill workspace, qua `ConversationV112Session`:
 *
 *  - conversation_v112_start        — tạo conversation mới (ghi `conversation.started`).
 *  - conversation_v112_append_message — ghi user/agent message vào log.
 *  - conversation_v112_replay       — replay + verify chain + state summary.
 *  - conversation_v112_branch       — fork tại một seq → conversation con.
 *  - conversation_v112_snapshot     — snapshot state tại seq.
 *  - conversation_v112_compact      — snapshot + cắt log trước seq.
 *  - conversation_v112_export       — export log ra file JSONL.
 *  - conversation_v112_timetravel   — state tại một seq + diff tới hiện tại (read-only).
 *  - codeact_v112_run_text          — trích code block từ text agent, chạy
 *    trong BotBox (qua CodeActExecutor của host), ghi action/observation.
 *  - skill_v112_list                — index `.openbot/skills/` của workspace.
 *  - skill_v112_load                — nạp một skill workspace + ghi `skill.loaded`.
 *
 * Placeholder trong ALL_TOOLS cho tới khi host bind
 * (`createConversationV112Tools(getBaseDir, opts)` với userData dir):
 * log sống ở `<baseDir>/conversations-v112/`. CodeAct cần host nối
 * `getCodeActExecutor` (BotBoxManager của bot) — không nối thì tool
 * `codeact_v112_run_text` trả hướng dẫn, không chạy code giả.
 * Skill tools dùng `ctx.workspaceDir` (fallback `getWorkspaceDir`).
 *
 * SAFETY: message/output ghi log đều redact secret + cắt ngắn (xem
 * core conversationV112/redact.ts); không gọi mạng, không gọi model.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { CodeActExecutor, Tool, ToolContext } from '@open-bot/core';
import {
  ConversationLogStore,
  ConversationV112Session,
  exportConversationToFile,
  indexWorkspaceSkills,
  replayDeterministicallyV112,
  replayFromSnapshot,
  summarizeConversationState,
  timeTravelConversation,
} from '@open-bot/core';

const NOT_WIRED =
  'Conversation v1.12 is not configured: the host has not wired a base directory yet. ' +
  'Bind createConversationV112Tools(getBaseDir) with the app userData directory first.';

const NOT_BOUND_CODEACT =
  'CodeAct executor chưa được cấu hình: host cần truyền getCodeActExecutor cho createConversationV112Tools (nối vào BotBoxManager của bot). Code chưa được chạy.';

export const CONVERSATION_V112_TOOL_NAMES = [
  'conversation_v112_start',
  'conversation_v112_append_message',
  'conversation_v112_replay',
  'conversation_v112_branch',
  'conversation_v112_snapshot',
  'conversation_v112_compact',
  'conversation_v112_export',
  'conversation_v112_timetravel',
  'codeact_v112_run_text',
  'skill_v112_list',
  'skill_v112_load',
] as const;

export function isConversationV112ToolName(name: string): boolean {
  return (CONVERSATION_V112_TOOL_NAMES as readonly string[]).includes(name);
}

export interface ConversationV112ToolOptions {
  /** Resolver CodeActExecutor v2 cho `codeact_v112_run_text` (host nối vào BotBoxManager của bot). */
  getCodeActExecutor?: (ctx: ToolContext) => CodeActExecutor | null | undefined;
  /** Thư mục workspace fallback cho skill tools (ưu tiên ctx.workspaceDir). */
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

export function conversationV112DataDir(baseDir: string): string {
  return path.join(baseDir, 'conversations-v112');
}

export function createConversationV112Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: ConversationV112ToolOptions = {},
): Tool[] {
  const stores = new Map<string, ConversationLogStore>();

  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const storeFor = (base: string): ConversationLogStore => {
    const cached = stores.get(base);
    if (cached) return cached;
    const store = new ConversationLogStore({ dataDir: conversationV112DataDir(base) });
    stores.set(base, store);
    return store;
  };

  const resolveWorkspaceDir = (ctx: ToolContext): string | null => {
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) return ctx.workspaceDir;
    try {
      const dir = toolOptions.getWorkspaceDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const openSession = (
    base: string,
    ctx: ToolContext,
    conversationId: string,
  ): ConversationV112Session => {
    const store = storeFor(base);
    return ConversationV112Session.open(store, {
      botId: ctx.botId,
      conversationId,
      workspaceDir: resolveWorkspaceDir(ctx) ?? undefined,
      codeActExecutor: toolOptions.getCodeActExecutor?.(ctx) ?? undefined,
    });
  };

  const startTool: Tool = {
    definition: toolDef(
      'conversation_v112_start',
      'Start a new event-sourced conversation (v1.12): creates an append-only JSONL log with a hash chain and records conversation.started. Returns the conversation id and first seq. The log lives under <baseDir>/conversations-v112/.',
      {
        conversationId: { type: 'string', description: 'Optional id (default: generated conv-<uuid>).' },
        title: { type: 'string', description: 'Optional short title.' },
        model: { type: 'string', description: 'Optional model routed at start.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const store = storeFor(base);
        const session = ConversationV112Session.open(store, {
          botId: ctx.botId,
          conversationId: getStringArg(args, 'conversationId') || undefined,
          title: getStringArg(args, 'title') || undefined,
          model: getStringArg(args, 'model') || undefined,
          workspaceDir: resolveWorkspaceDir(ctx) ?? undefined,
          codeActExecutor: toolOptions.getCodeActExecutor?.(ctx) ?? undefined,
        });
        return JSON.stringify(
          { conversationId: session.conversationId, botId: ctx.botId, lastSeq: session.getState().lastSeq },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const appendMessageTool: Tool = {
    definition: toolDef(
      'conversation_v112_append_message',
      'Append a user or agent message to a v1.12 conversation log (secret-redacted + truncated before persist). Returns the seq of the recorded event.',
      {
        conversationId: { type: 'string', description: 'Conversation id.' },
        role: { type: 'string', description: 'user or agent.' },
        text: { type: 'string', description: 'Message text.' },
      },
      ['conversationId', 'role', 'text'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const role = getStringArg(args, 'role', true);
        const text = getStringArg(args, 'text', true);
        if (role !== 'user' && role !== 'agent') {
          return errorResult('role must be "user" or "agent".');
        }
        const session = openSession(base, ctx, conversationId);
        const event = role === 'user'
          ? session.recordUserMessage(text)
          : session.recordAgentMessage(text);
        return JSON.stringify({ conversationId, seq: event.seq, role }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const replayTool: Tool = {
    definition: toolDef(
      'conversation_v112_replay',
      'Replay a v1.12 conversation: verify the hash chain, fold events deterministically into state (twice, to prove determinism), and return the state summary. Read-only.',
      {
        conversationId: { type: 'string', description: 'Conversation id.' },
      },
      ['conversationId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const store = storeFor(base);
        const { events } = store.readAll(conversationId, { verify: true });
        const { state: logOnlyState, deterministic } = replayDeterministicallyV112(events, conversationId);
        // State đầy đủ: từ snapshot (nếu có) + fold event sau snapshot.
        // Sau compact, log-only fold THIẾU phần trước snapshot — đó là
        // hành vi có chủ ý, nên `state` dưới đây là snapshot replay,
        // còn `logOnlyMessages` cho thấy log thô chứa bao nhiêu message.
        const { state, foldedAfterSnapshot } = replayFromSnapshot(store, conversationId);
        void ctx;
        return JSON.stringify(
          {
            conversationId,
            events: events.length,
            chainOk: true,
            deterministic,
            foldedAfterSnapshot,
            logOnlyMessages: logOnlyState.messages.length,
            state: {
              conversationId: state.conversationId,
              branchId: state.branchId,
              botId: state.botId,
              status: state.status,
              lastSeq: state.lastSeq,
              messages: state.messages.length,
              pendingToolCalls: state.pendingToolCalls.length,
              pendingCodeAct: state.pendingCodeAct.length,
              loadedSkills: state.loadedSkills.map((s) => s.name),
              codeActRuns: state.codeActRuns,
              codeActBlocked: state.codeActBlocked,
              toolCallsCompleted: state.toolCallsCompleted,
              branches: state.branches.map((b) => b.childConversationId),
              latestSnapshot: state.latestSnapshot ?? null,
              parentConversationId: state.parentConversationId ?? null,
              summary: summarizeConversationState(state),
            },
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const branchTool: Tool = {
    definition: toolDef(
      'conversation_v112_branch',
      'Fork a v1.12 conversation at a seq: the child conversation copies events up to fromSeq (hash chain rebuilt) and records the parent pointer. Returns the child conversation id.',
      {
        conversationId: { type: 'string', description: 'Parent conversation id.' },
        fromSeq: { type: 'integer', description: 'Seq in the parent to branch from (inclusive).' },
        reason: { type: 'string', description: 'Optional reason for the branch.' },
      },
      ['conversationId', 'fromSeq'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const fromSeq = getIntArg(args, 'fromSeq');
        if (fromSeq === undefined) return errorResult('fromSeq is required (integer).');
        const session = openSession(base, ctx, conversationId);
        const child = session.branch(fromSeq, getStringArg(args, 'reason') || undefined);
        return JSON.stringify(
          {
            parentConversationId: conversationId,
            childConversationId: child.conversationId,
            fromSeq,
            childLastSeq: child.getState().lastSeq,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const snapshotTool: Tool = {
    definition: toolDef(
      'conversation_v112_snapshot',
      'Snapshot a v1.12 conversation at a seq (default: latest): folds the log to that seq and writes a sha256-verified snapshot file. The log itself is kept. Returns file, throughSeq and hash.',
      {
        conversationId: { type: 'string', description: 'Conversation id.' },
        throughSeq: { type: 'integer', description: 'Optional seq to snapshot through (default: latest).' },
      },
      ['conversationId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const session = openSession(base, ctx, conversationId);
        const result = session.snapshot(getIntArg(args, 'throughSeq'));
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const compactTool: Tool = {
    definition: toolDef(
      'conversation_v112_compact',
      'Compact a v1.12 conversation log: snapshot at throughSeq (default: latest seq minus 1), then rewrite the log keeping only a snapshot anchor plus later events. Replay from the snapshot still reproduces the full state. Returns removed/remaining event counts.',
      {
        conversationId: { type: 'string', description: 'Conversation id.' },
        throughSeq: { type: 'integer', description: 'Optional seq to compact through (default: latest - 1).' },
      },
      ['conversationId'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const session = openSession(base, ctx, conversationId);
        const result = session.compact(getIntArg(args, 'throughSeq'));
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const timetravelTool: Tool = {
    definition: toolDef(
      'conversation_v112_timetravel',
      'Time travel a v1.12 conversation (read-only): rebuild the state as of a seq and diff it against the present state (added messages/skills, CodeAct/tool deltas, status change, future event count). No log writes.',
      {
        conversationId: { type: 'string', description: 'Conversation id.' },
        seq: { type: 'integer', description: 'Seq to travel back to (1-based).' },
      },
      ['conversationId', 'seq'],
    ),
    needsApproval: false,
    execute: async (args, _ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const seq = getIntArg(args, 'seq');
        if (seq === undefined) return errorResult('seq is required (integer).');
        const store = storeFor(base);
        const result = timeTravelConversation(store, conversationId, seq);
        return JSON.stringify(
          {
            conversationId,
            atSeq: result.atSeq,
            futureEvents: result.futureEvents,
            stateAtSeq: {
              status: result.state.status,
              lastSeq: result.state.lastSeq,
              messages: result.state.messages.length,
              loadedSkills: result.state.loadedSkills.map((s) => s.name),
              codeActRuns: result.state.codeActRuns,
              toolCallsCompleted: result.state.toolCallsCompleted,
            },
            diffToPresent: {
              addedMessages: result.diffToPresent.addedMessages.map((m) => ({ seq: m.seq, role: m.role, text: m.text })),
              addedSkills: result.diffToPresent.addedSkills,
              codeActRunsDelta: result.diffToPresent.codeActRunsDelta,
              toolCallsCompletedDelta: result.diffToPresent.toolCallsCompletedDelta,
              statusChanged: result.diffToPresent.statusChanged,
              statusFrom: result.diffToPresent.statusFrom,
              statusTo: result.diffToPresent.statusTo,
            },
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const exportTool: Tool = {
    definition: toolDef(
      'conversation_v112_export',
      'Export a v1.12 conversation log to a JSONL file (header + hash-chained events) for backup or transfer. Read-only on the log. Returns file path, event count and bytes.',
      {
        conversationId: { type: 'string', description: 'Conversation id.' },
        outDir: { type: 'string', description: 'Optional output directory (default: OS temp dir).' },
      },
      ['conversationId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const outDir = getStringArg(args, 'outDir') || path.join(os.tmpdir(), 'open-bot-conv-v112-exports');
        const store = storeFor(base);
        const result = exportConversationToFile(store, conversationId, outDir);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const codeactRunTextTool: Tool = {
    definition: toolDef(
      'codeact_v112_run_text',
      'CodeAct-lite (v1.12): extract ```bash / ```python code blocks from agent text and run them in the BotBox sandbox (policy-checked, timeout + output caps). Each block is recorded as action.codeact / observation.codeact events in the conversation log. Blocked actions return an observation instead of running.',
      {
        conversationId: { type: 'string', description: 'Conversation id to record the run in.' },
        text: { type: 'string', description: 'Agent text containing fenced bash/python code blocks.' },
      },
      ['conversationId', 'text'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const executor = toolOptions.getCodeActExecutor?.(ctx);
        if (!executor) return errorResult(NOT_BOUND_CODEACT);
        const conversationId = getStringArg(args, 'conversationId', true);
        const text = getStringArg(args, 'text', true);
        const session = ConversationV112Session.open(storeFor(base), {
          botId: ctx.botId,
          conversationId,
          workspaceDir: resolveWorkspaceDir(ctx) ?? undefined,
          codeActExecutor: executor,
        });
        const runs = await session.runCodeActText(text);
        return JSON.stringify(
          {
            conversationId,
            runs: runs.map((run) => ({
              actionIndex: run.actionIndex,
              kind: run.action.kind,
              executionId: run.executionId,
              blocked: run.blocked,
              blockedReason: run.blockedReason ?? null,
              exitCode: run.observation.exitCode,
              timedOut: run.observation.timedOut,
              truncated: run.observation.truncated,
              durationMs: run.observation.durationMs,
              stdout: run.observation.stdout,
              stderr: run.observation.stderr,
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const skillListTool: Tool = {
    definition: toolDef(
      'skill_v112_list',
      'List workspace skills (v1.12): index .openbot/skills/ in the bot workspace (loose <name>.md or <name>/SKILL.md, frontmatter only). Returns name, description, version, triggers and per-file validation errors. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async (_args, ctx) => {
      try {
        const workspaceDir = resolveWorkspaceDir(ctx);
        if (!workspaceDir) {
          return errorResult(
            'No workspace dir available for skill_v112_list (ctx.workspaceDir or getWorkspaceDir).',
          );
        }
        const index = indexWorkspaceSkills(workspaceDir);
        return JSON.stringify(
          {
            skillsDir: index.skillsDir,
            entries: index.entries,
            errors: index.errors,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const skillLoadTool: Tool = {
    definition: toolDef(
      'skill_v112_load',
      'Load a workspace skill on demand (v1.12): read <name>.md (or <name>/SKILL.md) under .openbot/skills/, validate frontmatter + body, record skill.loaded in the conversation log, and return the rendered skill text to inject into the prompt.',
      {
        conversationId: { type: 'string', description: 'Conversation id to record skill.loaded in.' },
        name: { type: 'string', description: 'Skill name (must match the file name).' },
        source: { type: 'string', description: 'How the skill was requested: user, model, or trigger (default user).' },
      },
      ['conversationId', 'name'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const conversationId = getStringArg(args, 'conversationId', true);
        const name = getStringArg(args, 'name', true);
        const source = getStringArg(args, 'source') || 'user';
        if (source !== 'user' && source !== 'model' && source !== 'trigger') {
          return errorResult('source must be "user", "model", or "trigger".');
        }
        const session = openSession(base, ctx, conversationId);
        const rendered = session.loadSkill(name, source as 'user' | 'model' | 'trigger');
        return JSON.stringify({ conversationId, name, source, rendered }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    startTool,
    appendMessageTool,
    replayTool,
    branchTool,
    snapshotTool,
    compactTool,
    exportTool,
    timetravelTool,
    codeactRunTextTool,
    skillListTool,
    skillLoadTool,
  ];
}

export const CONVERSATION_V112_TOOLS: Tool[] = createConversationV112Tools();
