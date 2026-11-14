/**
 * Delegation tools v2 cho @open-bot/tools (v1.04, Đội T4).
 *
 * Ủy quyền agent cha → agent con QUA TOOL CALL, có theo dõi tiến độ
 * (DelegationTracker) + hợp nhất kết quả nhiều chiến lược (merge).
 * Xây TRÊN `ctx.runSubagent` có sẵn (AgentRunner chạy con cùng
 * process, cùng provider/tool) — không tạo runner mới, không gọi
 * provider trực tiếp. Khác `delegate_task` (subagentTools.ts — chạy
 * con rồi trả text, không theo dõi):
 *
 * - `delegate_to_agent`: giao 1 việc cho 1 con, theo dõi qua tracker
 *   (session id trả về để `delegation_status` đọc), phân loại kết quả
 *   done/error/timeout từ chuỗi `[subagent <id>] done|timeout|lỗi:`
 *   mà runner bọc (xem `agent/loop.ts` `runSubagent`).
 * - `delegate_parallel`: giao N việc cho N con chạy song song, hợp
 *   nhất theo strategy (concat | summarize | verdict).
 * - `delegation_status`: đọc tiến độ session (số con xong/lỗi/chạy,
 *   %, thời gian, steps/toolCalls khi có).
 *
 * Factory:
 *   createDelegationTools(opts?) -> Tool[]   (bound, usable)
 *   DELEGATION_TOOLS                          (unbound placeholder)
 *
 * Approval: delegate_to_agent và delegate_parallel chạy agent con
 * (đổi trạng thái, tốn token/time) -> needsApproval true; còn
 * delegation_status chỉ đọc -> false.
 */

import type { Tool, ToolContext } from '@open-bot/core';
import {
  DelegationTracker,
  mergeDelegationResults,
  type DelegationChildResult,
  type DelegationMergeStrategy,
} from '@open-bot/core';

/** Tùy chọn của `createDelegationTools`. */
export interface DelegationToolOptions {
  /** Tracker dùng chung (mặc định tạo mới — session sống theo factory). */
  tracker?: DelegationTracker;
  /** Timeout mặc định mỗi con, ms (mặc định 120_000). */
  defaultTimeoutMs?: number;
  /** Chiến lược hợp nhất mặc định cho delegate_parallel (mặc định concat). */
  defaultMergeStrategy?: DelegationMergeStrategy;
}

export const DEFAULT_DELEGATION_TIMEOUT_MS = 120_000;

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

/**
 * Phân loại chuỗi trả về của `ctx.runSubagent`:
 * `[subagent <id>] done: <output>` → done (bỏ prefix),
 * `[subagent <id>] timeout ...` → timeout,
 * `[subagent <id>] lỗi: ...` → error.
 * Chuỗi không có wrapper (runner khác / test double) → done nguyên văn.
 */
export function classifySubagentOutput(raw: string): {
  status: 'done' | 'error' | 'timeout';
  output: string;
  error?: string;
} {
  const timeoutMatch = /^\[subagent [^\]]+\] timeout\b/.exec(raw);
  if (timeoutMatch) {
    return { status: 'timeout', output: '', error: raw };
  }
  const errorMatch = /^\[subagent [^\]]+\] lỗi:\s*/.exec(raw);
  if (errorMatch) {
    return { status: 'error', output: '', error: raw.slice(errorMatch[0].length) };
  }
  const doneMatch = /^\[subagent [^\]]+\] done:\s*/.exec(raw);
  if (doneMatch) {
    return { status: 'done', output: raw.slice(doneMatch[0].length) };
  }
  return { status: 'done', output: raw };
}

/** Trích verdict từ dòng `Verdict: ...` trong output của con (nếu có). */
export function extractVerdictFromOutput(output: string): string | undefined {
  const match = /^Verdict:\s*(.+)$/m.exec(output);
  if (match === null) return undefined;
  const verdict = match[1]!.trim();
  return verdict === '' ? undefined : verdict;
}

export function createDelegationTools(opts: DelegationToolOptions = {}): Tool[] {
  const tracker = opts.tracker ?? new DelegationTracker();
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS;
  const defaultMergeStrategy = opts.defaultMergeStrategy ?? 'concat';

  const delegateToAgent: Tool = {
    definition: toolDef(
      'delegate_to_agent',
      'Giao một việc cho một agent con (chạy qua ctx.runSubagent, cùng provider/tool với cha), theo dõi tiến độ qua delegation session và trả kết quả kèm delegationId để đọc tiến độ bằng delegation_status. Kết quả phân loại done/error/timeout rõ ràng, không nuốt lỗi thành text chung chung.',
      {
        task: { type: 'string', description: 'Việc cần giao (mô tả rõ ràng cho agent con).' },
        name: { type: 'string', description: 'Tên hiển thị của con (mặc định "child").' },
        role: {
          type: 'string',
          description: 'Role subagent chuyên biệt (researcher/coder/reviewer/planner/tester, xem list_subagent_roles).',
        },
        model: { type: 'string', description: 'Model riêng của con (trống = model của cha).' },
        timeoutMs: { type: 'number', description: 'Timeout tối đa, ms. Mặc định 120000.' },
      },
      ['task'],
    ),
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      try {
        const task = getStringArg(args, 'task');
        const name = getOptionalStringArg(args, 'name') ?? 'child';
        const role = getOptionalStringArg(args, 'role');
        const model = getOptionalStringArg(args, 'model');
        const timeoutMs = getNumberArg(args, 'timeoutMs') ?? defaultTimeoutMs;
        if (!ctx.runSubagent) {
          return errorResult(
            'delegate_to_agent chưa được hỗ trợ trong phiên này (ToolContext.runSubagent chưa được cấu hình).',
          );
        }
        const session = tracker.createSession([{ name, task, role, model, timeoutMs }], {
          strategy: 'concat',
        });
        tracker.startChild(session.id, name);
        const startedAt = Date.now();
        let raw: string;
        try {
          raw = await ctx.runSubagent(task, {
            ...(role !== undefined ? { role } : {}),
            ...(model !== undefined ? { model } : {}),
            timeoutMs,
          });
        } catch (err) {
          const result: DelegationChildResult = {
            name,
            status: 'error',
            output: '',
            durationMs: Date.now() - startedAt,
            error: (err as Error).message,
          };
          tracker.failChild(session.id, name, result);
          return JSON.stringify({ delegationId: session.id, child: name, status: 'error', durationMs: result.durationMs, error: result.error }, null, 2);
        }
        const classified = classifySubagentOutput(raw);
        const durationMs = Date.now() - startedAt;
        const verdict =
          classified.status === 'done' ? extractVerdictFromOutput(classified.output) : undefined;
        const result: DelegationChildResult = {
          name,
          status: classified.status,
          output: classified.output,
          durationMs,
          ...(classified.error !== undefined ? { error: classified.error } : {}),
          ...(verdict !== undefined ? { verdict } : {}),
        };
        if (classified.status === 'done') tracker.completeChild(session.id, name, result);
        else if (classified.status === 'timeout') tracker.timeoutChild(session.id, name, result);
        else tracker.failChild(session.id, name, result);
        return JSON.stringify(
          {
            delegationId: session.id,
            child: name,
            status: classified.status,
            durationMs,
            ...(verdict !== undefined ? { verdict } : {}),
            output: classified.output,
            ...(classified.error !== undefined ? { error: classified.error } : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const delegateParallel: Tool = {
    definition: toolDef(
      'delegate_parallel',
      'Giao nhiều việc cho nhiều agent con chạy song song (mỗi con qua ctx.runSubagent), rồi hợp nhất kết quả theo strategy: concat (nối đủ), summarize (trích gọn từng con), verdict (verdict đa số + liệt kê xung đột). Trả merged output kèm báo cáo hợp nhất và delegationId.',
      {
        tasks: {
          type: 'array',
          description: 'Danh sách việc giao, mỗi phần tử { task, name?, role?, model?, timeoutMs? }.',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string' },
              name: { type: 'string' },
              role: { type: 'string' },
              model: { type: 'string' },
              timeoutMs: { type: 'number' },
            },
            required: ['task'],
          },
        },
        mergeStrategy: {
          type: 'string',
          description: 'Chiến lược hợp nhất: concat | summarize | verdict. Mặc định concat.',
        },
      },
      ['tasks'],
    ),
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      try {
        const rawTasks = args['tasks'];
        if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
          return errorResult('delegate_parallel: tasks phải là mảng không rỗng.');
        }
        const strategyRaw = getOptionalStringArg(args, 'mergeStrategy');
        const strategy: DelegationMergeStrategy =
          strategyRaw === 'summarize' || strategyRaw === 'verdict' ? strategyRaw : defaultMergeStrategy;
        if (!ctx.runSubagent) {
          return errorResult(
            'delegate_parallel chưa được hỗ trợ trong phiên này (ToolContext.runSubagent chưa được cấu hình).',
          );
        }
        const inputs = rawTasks.map((t, i) => {
          if (!t || typeof t !== 'object' || Array.isArray(t)) {
            throw new Error(`delegate_parallel: tasks[${i}] phải là object { task, ... }.`);
          }
          const rec = t as Record<string, unknown>;
          const task = rec['task'];
          if (typeof task !== 'string' || task.trim() === '') {
            throw new Error(`delegate_parallel: tasks[${i}].task rỗng.`);
          }
          const nameRaw = rec['name'];
          const name =
            typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw : `child-${i + 1}`;
          const role = typeof rec['role'] === 'string' ? (rec['role'] as string) : undefined;
          const model = typeof rec['model'] === 'string' ? (rec['model'] as string) : undefined;
          const timeoutMs =
            typeof rec['timeoutMs'] === 'number' && Number.isFinite(rec['timeoutMs'])
              ? (rec['timeoutMs'] as number)
              : defaultTimeoutMs;
          return { name, task, role, model, timeoutMs };
        });
        const session = tracker.createSession(inputs, { strategy });
        const settled = await Promise.allSettled(
          inputs.map(async (input) => {
            tracker.startChild(session.id, input.name);
            const startedAt = Date.now();
            try {
              const raw = await ctx.runSubagent!(input.task, {
                ...(input.role !== undefined ? { role: input.role } : {}),
                ...(input.model !== undefined ? { model: input.model } : {}),
                timeoutMs: input.timeoutMs,
              });
              const classified = classifySubagentOutput(raw);
              const durationMs = Date.now() - startedAt;
              const verdict =
                classified.status === 'done'
                  ? extractVerdictFromOutput(classified.output)
                  : undefined;
              const result: DelegationChildResult = {
                name: input.name,
                status: classified.status,
                output: classified.output,
                durationMs,
                ...(classified.error !== undefined ? { error: classified.error } : {}),
                ...(verdict !== undefined ? { verdict } : {}),
              };
              if (classified.status === 'done') tracker.completeChild(session.id, input.name, result);
              else if (classified.status === 'timeout') tracker.timeoutChild(session.id, input.name, result);
              else tracker.failChild(session.id, input.name, result);
              return result;
            } catch (err) {
              const result: DelegationChildResult = {
                name: input.name,
                status: 'error',
                output: '',
                durationMs: Date.now() - startedAt,
                error: (err as Error).message,
              };
              tracker.failChild(session.id, input.name, result);
              return result;
            }
          }),
        );
        const results = settled.map((s) =>
          s.status === 'fulfilled'
            ? s.value
            : ({
                name: 'unknown',
                status: 'error' as const,
                output: '',
                durationMs: 0,
                error: 'delegate_parallel: lỗi nội bộ khi chạy con.',
              } satisfies DelegationChildResult),
        );
        const { merged, report } = mergeDelegationResults(results, strategy);
        tracker.setMerged(session.id, merged, report);
        return JSON.stringify({ delegationId: session.id, strategy, merged, report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const delegationStatus: Tool = {
    definition: toolDef(
      'delegation_status',
      'Đọc tiến độ một lần ủy quyền (delegationId từ delegate_to_agent/delegate_parallel): trạng thái session, số con xong/lỗi/timeout/đang chạy, % hoàn thành, thời gian, steps/toolCalls từng con khi có.',
      {
        delegationId: { type: 'string', description: 'Id session ủy quyền.' },
      },
      ['delegationId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const delegationId = getStringArg(args, 'delegationId');
        const summary = tracker.summarize(delegationId);
        return JSON.stringify(summary, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [delegateToAgent, delegateParallel, delegationStatus];
}

/**
 * Placeholder chưa gắn tracker (theo mẫu SUBAGENT_TOOLS) — dùng
 * createDelegationTools(opts) để có tracker dùng chung.
 */
export const DELEGATION_TOOLS: Tool[] = createDelegationTools();
