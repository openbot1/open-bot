/**
 * Coding agent v6 tools (v1.14, Đội T3) — 7 tools.
 *
 * Event-sourced coding agent qua `CodingAgentV6` (core codingV6):
 *
 *  - coding_v6_start          — tạo session mới (log append-only + hash chain).
 *  - coding_v6_run_text       — parse action từ text agent (JSON / fenced
 *    block / think / finish / delegate), chấm security từng action,
 *    HIGH/UNKNOWN thì pause chờ duyệt, còn lại chạy trong BotBox qua
 *    CodeActExecutor của host.
 *  - coding_v6_approve        — duyệt/từ chối action đang chờ, chạy action
 *    đã duyệt (resume vòng lặp pause/resume).
 *  - coding_v6_replay         — verify chain + state tại seq / replay từ
 *    event N + fork tại seq (read-only, trừ fork).
 *  - coding_v6_security       — chấm rủi ro một tool call (LOW/MEDIUM/HIGH/
 *    UNKNOWN + lý do). Thuần — chạy được cả khi chưa nối base dir.
 *  - coding_v6_condense       — nén log thành bản có cấu trúc (quyết định +
 *    file đã đổi + lỗi đã gặp), append marker, không xoá lịch sử.
 *  - coding_v6_delegate       — delegate một task cho sub-agent qua
 *    `ctx.runSubagent` (hoặc runner do host tiêm), có budget + timeout.
 *
 * Placeholder trong ALL_TOOLS cho tới khi host bind
 * (`createCodingV6Tools(getBaseDir, opts)` với userData dir): log sống
 * ở `<baseDir>/coding-v6/<sessionId>.jsonl`. CodeAct cần host nối
 * `getCodeActExecutor` (BotBoxManager của bot) — không nối thì action
 * code trả observation blocked rõ ràng, không chạy giả. Delegate cần
 * `ctx.runSubagent` hoặc `getSubagentRunner` — không có thì trả lỗi rõ.
 *
 * SAFETY: log đã cắt ngắn payload (xem core codingV6); tool không gọi
 * mạng, không gọi model thật (generate do host nối ở tầng agent, tool
 * `run_text` chỉ chạy action từ text đã có).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodeActExecutor, Tool, ToolContext, V6SubagentRunner } from '@open-bot/core';
import {
  CodingAgentV6,
  CodingV6Log,
  V6SecurityAnalyzer,
  parseV6ActionsFromText,
} from '@open-bot/core';

const NOT_WIRED =
  'Coding agent v6 is not configured: the host has not wired a base directory yet. ' +
  'Bind createCodingV6Tools(getBaseDir) with the app userData directory first.';

export const CODING_V6_TOOL_NAMES = [
  'coding_v6_start',
  'coding_v6_run_text',
  'coding_v6_approve',
  'coding_v6_replay',
  'coding_v6_security',
  'coding_v6_condense',
  'coding_v6_delegate',
] as const;

export type CodingV6ToolName = (typeof CODING_V6_TOOL_NAMES)[number];

export function isCodingV6ToolName(name: string): boolean {
  return (CODING_V6_TOOL_NAMES as readonly string[]).includes(name);
}

export interface CodingV6ToolOptions {
  /** Resolver CodeActExecutor v2 cho action code (host nối vào BotBoxManager của bot). */
  getCodeActExecutor?: (ctx: ToolContext) => CodeActExecutor | null | undefined;
  /** Runner sub-agent cho delegate (ưu tiên sau ctx.runSubagent). */
  getSubagentRunner?: (ctx: ToolContext) => V6SubagentRunner | null | undefined;
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

function getBoolArg(args: Record<string, unknown>, name: string, required = false): boolean {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

export function codingV6DataDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v6');
}

function sessionFilePath(baseDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(codingV6DataDir(baseDir), `${safe}.jsonl`);
}

export function createCodingV6Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: CodingV6ToolOptions = {},
): Tool[] {
  const agents = new Map<string, CodingAgentV6>();

  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const resolveWorkspaceDir = (ctx: ToolContext): string | undefined => {
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) return ctx.workspaceDir;
    try {
      const dir = toolOptions.getWorkspaceDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : undefined;
    } catch {
      return undefined;
    }
  };

  const resolveRunner = (ctx: ToolContext): V6SubagentRunner | undefined => {
    const injected = toolOptions.getSubagentRunner?.(ctx);
    if (injected) return injected;
    if (ctx.runSubagent) {
      const runSubagent = ctx.runSubagent;
      return async (input) => {
        const startedMs = Date.now();
        try {
          const output = await runSubagent(input.task, {
            ...(input.scope ? { instructions: `Scope: ${input.scope}` } : {}),
            ...(input.model ? { model: input.model } : {}),
            maxSteps: input.maxSteps,
          });
          return { name: input.name, status: 'done', output, durationMs: Date.now() - startedMs };
        } catch (e) {
          return {
            name: input.name,
            status: 'error',
            output: '',
            durationMs: Date.now() - startedMs,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      };
    }
    return undefined;
  };

  const saveAgent = (base: string, agent: CodingAgentV6): void => {
    const dir = codingV6DataDir(base);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionFilePath(base, agent.log.sessionId), agent.log.toJsonl(), 'utf8');
  };

  const openAgent = (base: string, ctx: ToolContext, sessionId: string): CodingAgentV6 => {
    const key = `${base}::${sessionId}`;
    const cached = agents.get(key);
    if (cached) return cached;
    const file = sessionFilePath(base, sessionId);
    let log: CodingV6Log;
    if (fs.existsSync(file)) {
      log = CodingV6Log.fromJsonl(sessionId, fs.readFileSync(file, 'utf8'));
    } else {
      log = new CodingV6Log(sessionId);
    }
    const agent = new CodingAgentV6({
      log,
      executor: toolOptions.getCodeActExecutor?.(ctx) ?? undefined,
      delegateRunner: resolveRunner(ctx),
      workspaceDir: resolveWorkspaceDir(ctx),
    });
    agents.set(key, agent);
    return agent;
  };

  const startTool: Tool = {
    definition: toolDef(
      'coding_v6_start',
      'Start a new coding agent v6 session (v1.14): creates an append-only event-sourced log (hash chain) for a coding task. Returns the session id. The log lives under <baseDir>/coding-v6/.',
      {
        sessionId: { type: 'string', description: 'Optional id (default: generated uuid).' },
        title: { type: 'string', description: 'Short task title.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const sessionId = getStringArg(args, 'sessionId') || undefined;
        const title = getStringArg(args, 'title') || 'coding v6 session';
        const agent = new CodingAgentV6({
          sessionId,
          executor: toolOptions.getCodeActExecutor?.(ctx) ?? undefined,
          delegateRunner: resolveRunner(ctx),
          workspaceDir: resolveWorkspaceDir(ctx),
        });
        agent.startSession(title);
        agents.set(`${base}::${agent.log.sessionId}`, agent);
        saveAgent(base, agent);
        return JSON.stringify({ sessionId: agent.log.sessionId, title, lastSeq: agent.log.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runTextTool: Tool = {
    definition: toolDef(
      'coding_v6_run_text',
      'Run agent text as v6 CodeAct actions (v1.14): parses JSON / fenced bash+python blocks / think / finish / delegate from the text, scores each action with the security analyzer (HIGH/UNKNOWN pauses for approval instead of running), and executes the rest in the BotBox sandbox via the host CodeActExecutor. Returns observations + status (finished/paused/stuck).',
      {
        sessionId: { type: 'string', description: 'Session id from coding_v6_start.' },
        text: { type: 'string', description: 'Agent output text containing actions.' },
      },
      ['sessionId', 'text'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const text = getStringArg(args, 'text', true);
        const agent = openAgent(base, ctx, sessionId);
        // Lưu ý: khi host chưa nối getCodeActExecutor, action code sẽ
        // bị chặn ở tầng agent (observation blocked) — không chạy giả.
        const parsed = parseV6ActionsFromText(text);
        const observations: Array<{ kind: string; ok: boolean; stdout: string; stderr: string }> = [];
        let status: string = 'done';
        for (const action of parsed.actions) {
          const before = agent.log.length;
          const outcome = await agent.runAction(action);
          const events = agent.log.all().slice(before);
          const obs = events.find((e) => e.type === 'v6.observation');
          if (obs) {
            const p = obs.payload as Record<string, unknown>;
            observations.push({
              kind: String(p['kind'] ?? action.kind),
              ok: p['ok'] === true,
              stdout: typeof p['stdout'] === 'string' ? (p['stdout'] as string) : '',
              stderr: typeof p['stderr'] === 'string' ? (p['stderr'] as string) : '',
            });
          }
          if (outcome === 'finish') {
            status = 'finished';
            break;
          }
          if (outcome === 'paused') {
            status = 'paused';
            break;
          }
        }
        const state = agent.state();
        saveAgent(base, agent);
        const pending = agent.gate.listPending();
        return JSON.stringify(
          {
            sessionId,
            status: state.status === 'stuck' ? 'stuck' : status,
            observations,
            filesChanged: state.filesChanged,
            decisions: state.decisions,
            errors: state.errors,
            lastSeq: agent.log.length,
            ...(pending.length > 0
              ? { pendingApproval: { id: pending[0]!.id, reason: pending[0]!.reason } }
              : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const approveTool: Tool = {
    definition: toolDef(
      'coding_v6_approve',
      'Approve or deny a pending v6 action (v1.14): approving runs the paused HIGH/UNKNOWN action in the sandbox; denying skips it. Returns the resumed status. The pending action only lives in-process — after a restart, approve fails and the action must be re-issued.',
      {
        sessionId: { type: 'string', description: 'Session id.' },
        approvalId: { type: 'string', description: 'Approval id from coding_v6_run_text (pendingApproval.id).' },
        approved: { type: 'boolean', description: 'true = run the action, false = skip it.' },
        note: { type: 'string', description: 'Optional note from the approver.' },
      },
      ['sessionId', 'approvalId', 'approved'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const approvalId = getStringArg(args, 'approvalId', true);
        const approved = getBoolArg(args, 'approved', true);
        const note = getStringArg(args, 'note') || undefined;
        const agent = openAgent(base, ctx, sessionId);
        const result = await agent.approve(approvalId, approved, note);
        saveAgent(base, agent);
        return JSON.stringify({ sessionId, approvalId, approved, status: result.status, note: result.note }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const replayTool: Tool = {
    definition: toolDef(
      'coding_v6_replay',
      'Replay / time-travel a v6 session (v1.14): verifies the hash chain, folds the log into state, returns state at an optional seq (time-travel) and state replayed from an optional fromSeq. Optionally forks at fromSeq into a child session. Read-only except fork.',
      {
        sessionId: { type: 'string', description: 'Session id.' },
        atSeq: { type: 'integer', description: 'Optional seq for time-travel state.' },
        fromSeq: { type: 'integer', description: 'Optional seq to replay from (and fork at, when fork=true).' },
        fork: { type: 'boolean', description: 'Fork at fromSeq into a child session (default false).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const atSeq = getIntArg(args, 'atSeq');
        const fromSeq = getIntArg(args, 'fromSeq');
        const fork = getBoolArg(args, 'fork');
        const agent = openAgent(base, ctx, sessionId);
        const verification = agent.log.verify();
        const state = agent.state();
        const result: Record<string, unknown> = {
          sessionId,
          chainOk: verification.ok,
          events: agent.log.length,
          state: {
            status: state.status,
            lastSeq: state.lastSeq,
            filesChanged: state.filesChanged,
            decisions: state.decisions,
            errors: state.errors,
            actionsExecuted: state.actionsExecuted,
            failedObservations: state.failedObservations,
            delegations: state.delegations,
            condensations: state.condensations,
            stuckDetections: state.stuckDetections,
          },
        };
        if (atSeq !== undefined) {
          const at = agent.stateAt(atSeq);
          result['stateAt'] = { seq: atSeq, lastSeq: at.lastSeq, filesChanged: at.filesChanged, decisions: at.decisions, messages: at.messages.length };
        }
        if (fromSeq !== undefined) {
          const replayed = agent.replayFrom(fromSeq);
          result['replayFrom'] = { fromSeq, replayed: replayed.replayed, afterLastSeq: replayed.after.lastSeq };
        }
        if (fork && fromSeq !== undefined) {
          const child = agent.forkAt(fromSeq);
          agents.set(`${base}::${child.log.sessionId}`, child);
          saveAgent(base, agent);
          saveAgent(base, child);
          result['forkedSessionId'] = child.log.sessionId;
          result['forkFromSeq'] = fromSeq;
        }
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const securityTool: Tool = {
    definition: toolDef(
      'coding_v6_security',
      'Score the risk of one tool call with the v6 security analyzer (v1.14): LOW/MEDIUM/HIGH/UNKNOWN + score + reasons + whether it needs user confirmation. Pure — works without a base directory.',
      {
        toolName: { type: 'string', description: 'Tool name (e.g. shell_exec, write_file).' },
        argsJson: { type: 'string', description: 'Optional JSON object of tool args (default {}).' },
      },
      ['toolName'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const toolName = getStringArg(args, 'toolName', true);
        const argsJson = getStringArg(args, 'argsJson');
        let toolArgs: Record<string, unknown> = {};
        if (argsJson.trim() !== '') {
          const parsed: unknown = JSON.parse(argsJson);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return errorResult('argsJson must be a JSON object.');
          }
          toolArgs = parsed as Record<string, unknown>;
        }
        const analyzer = new V6SecurityAnalyzer();
        const verdict = analyzer.assessToolCall(toolName, toolArgs);
        return JSON.stringify(verdict, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const condenseTool: Tool = {
    definition: toolDef(
      'coding_v6_condense',
      'Condense a v6 session log (v1.14): builds a structured summary (decisions + files changed + errors encountered + open questions) with real token savings, appends a v6.condensed marker, and keeps the original history intact.',
      {
        sessionId: { type: 'string', description: 'Session id.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const agent = openAgent(base, ctx, sessionId);
        const condensation = agent.condenseNow();
        saveAgent(base, agent);
        return JSON.stringify({ sessionId, ...condensation }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const delegateTool: Tool = {
    definition: toolDef(
      'coding_v6_delegate',
      'Delegate a task to a sub-agent via tool call (v1.14): runs the child through ctx.runSubagent (or a host-injected runner) with scope + step/timeout budget, records delegation events in the session log, and returns the child result. Errors clearly when no runner is wired.',
      {
        sessionId: { type: 'string', description: 'Session id.' },
        task: { type: 'string', description: 'Task for the sub-agent.' },
        scope: { type: 'string', description: 'Optional scope (dirs/files/tools the child may touch).' },
        role: { type: 'string', description: 'Optional specialist role.' },
        timeoutMs: { type: 'integer', description: 'Optional child timeout in ms (default 120000).' },
        maxSteps: { type: 'integer', description: 'Optional child max steps (default 20).' },
      },
      ['sessionId', 'task'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const task = getStringArg(args, 'task', true);
        const scope = getStringArg(args, 'scope') || undefined;
        const role = getStringArg(args, 'role') || undefined;
        const timeoutMs = getIntArg(args, 'timeoutMs');
        const maxSteps = getIntArg(args, 'maxSteps');
        const agent = openAgent(base, ctx, sessionId);
        const action = {
          kind: 'delegate' as const,
          task,
          ...(scope ? { scope } : {}),
          ...(role ? { role } : {}),
          budget: {
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(maxSteps !== undefined ? { maxSteps } : {}),
          },
        };
        await agent.runAction(action);
        saveAgent(base, agent);
        const state = agent.state();
        const lastDelegation = [...agent.log.all()].reverse().find((e) => e.type === 'v6.delegation.finished');
        return JSON.stringify(
          {
            sessionId,
            delegations: state.delegations,
            ...(lastDelegation ? { result: lastDelegation.payload } : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [startTool, runTextTool, approveTool, replayTool, securityTool, condenseTool, delegateTool];
}

/** Unbound placeholders for ALL_TOOLS (bound by createDefaultTools when wired). */
export const CODING_V6_TOOLS: Tool[] = createCodingV6Tools();
