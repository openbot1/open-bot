/**
 * Harness v1.07 tools cho @open-bot/tools (v1.07, Đội T2).
 *
 * Ý tưởng học từ survey v1.07 phần 1 (OpenHands V1 SDK: TaskToolSet +
 * budget meters + LLM profiles — chỉ học ý tưởng, không copy
 * code/text/tài sản của repo nào):
 *
 *  - `harness_v3_delegate` — giao một task chuyên biệt cho sub-agent
 *    (TaskToolSet), nhận kết quả NÉN về (mặc định ≤ 4.000 ký tự) để
 *    parent không bị bẩn context. Cần host bind `runSubagent`
 *    (vd nối vào `AgentRunner.runSubagent`); chưa bind thì tool trả
 *    hướng dẫn, không giả vờ đã delegate.
 *  - `harness_v3_budget` — đọc meter ngân sách (token/cost/thời
 *    gian) của conversation hiện tại: một dòng meter + cảnh báo.
 *    Cần host bind `getBudgetSnapshot`; chưa bind thì trả hướng dẫn.
 *  - `harness_v3_model` — liệt kê profile LLM đã lưu / đổi profile
 *    active ngay trong turn (tương đương `/model` trong chat, nhưng
 *    gọi được bằng tool call). Cần host bind `getProfileStore`;
 *    chưa bind thì trả hướng dẫn.
 *
 * An toàn:
 *  - Cả 3 tool đều không gọi mạng, không chạm Vault/key, không ghi
 *    file ngoài file profile (qua LlmProfileStore.save() của host).
 *  - `harness_v3_delegate` cần approval (sub-agent chạy tool thật
 *    qua runner của host).
 *  - Mọi kết quả đều cắt ở MAX_TOOL_RESULT_CHARS.
 *
 * Factory (cùng pattern với createHarnessV103Tools):
 *   createHarnessV107Tools(opts?) -> Tool[]   (bound, usable)
 *   HARNESS_V107_TOOLS                       (unbound placeholders)
 */

import type { Tool, ToolContext } from '@open-bot/core';
import type { LlmProfileStore, SubagentRunner, V3BudgetSnapshot } from '@open-bot/core';
import { TaskToolSet, formatBudgetMeterLine } from '@open-bot/core';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

export const HARNESS_V107_TOOL_NAMES = [
  'harness_v3_delegate',
  'harness_v3_budget',
  'harness_v3_model',
] as const;

export interface HarnessV107ToolOptions {
  /**
   * Runner sub-agent cho `harness_v3_delegate` (host nối vào
   * AgentRunner.runSubagent hoặc V3Conversation khác). Không truyền
   * → tool trả hướng dẫn cấu hình, không delegate giả.
   */
  runSubagent?: SubagentRunner;
  /**
   * Resolver meter ngân sách của conversation hiện tại cho
   * `harness_v3_budget` (host trả V3BudgetSnapshot hoặc null khi
   * conversation chưa có meter). Không truyền → tool trả hướng dẫn.
   */
  getBudgetSnapshot?: (ctx: ToolContext) => V3BudgetSnapshot | null | undefined;
  /**
   * Resolver LlmProfileStore cho `harness_v3_model`. Không truyền →
   * tool trả hướng dẫn.
   */
  getProfileStore?: (ctx: ToolContext) => LlmProfileStore | null | undefined;
  /** Timeout mặc định cho một lần delegate (ms). Mặc định 120.000. */
  defaultDelegateTimeoutMs?: number;
  /** Ký tự tối đa của kết quả delegate nén. Mặc định 4.000. */
  delegateMaxChars?: number;
}

const DEFAULT_DELEGATE_TIMEOUT_MS = 120_000;

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

const NOT_BOUND_DELEGATE =
  'Sub-agent delegation chưa được cấu hình: host cần truyền runSubagent cho createHarnessV107Tools (nối vào AgentRunner.runSubagent). Task chưa được giao cho ai.';
const NOT_BOUND_BUDGET =
  'Budget meter chưa được cấu hình: host cần truyền getBudgetSnapshot cho createHarnessV107Tools (trả V3BudgetSnapshot của conversation hiện tại).';
const NOT_BOUND_MODEL =
  'LLM profile store chưa được cấu hình: host cần truyền getProfileStore cho createHarnessV107Tools. Tạo profile trong Settings → Model profiles rồi gọi lại.';

/** Tạo 3 tool harness v1.07 (bound với opts — runner/meter/store). */
export function createHarnessV107Tools(opts: HarnessV107ToolOptions = {}): Tool[] {
  const delegateTool: Tool = {
    definition: toolDef(
      'harness_v3_delegate',
      'Delegate a specialized task to a sub-agent (TaskToolSet) and get back a COMPRESSED result (max ~4000 chars by default) instead of the sub-agent\'s full output — the parent never sees the sub-agent\'s hundreds of tool calls. Use for research, review, or a well-scoped subtask that deserves its own context. Returns the delegation record {delegationId, status, result, truncated, rawChars, resultTokens, changedFiles, durationMs}.',
      {
        task: { type: 'string', description: 'Task chuyên biệt giao cho sub-agent (mô tả rõ input, output mong muốn, giới hạn).' },
        role: { type: 'string', description: 'Vai trò gợi ý của sub-agent (vd researcher, reviewer, coder).' },
        timeoutMs: { type: 'integer', description: 'Timeout một lần delegate (ms, 1..600000, mặc định 120000).' },
      },
      ['task'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      try {
        void ctx;
        const task = getStringArg(args, 'task');
        const role = getOptionalStringArg(args, 'role');
        const timeoutMs = getIntArg(args, 'timeoutMs') ?? opts.defaultDelegateTimeoutMs ?? DEFAULT_DELEGATE_TIMEOUT_MS;
        if (opts.runSubagent === undefined) return NOT_BOUND_DELEGATE;
        if (timeoutMs <= 0 || timeoutMs > 600_000) {
          return errorResult('timeoutMs phải trong khoảng 1..600000.');
        }
        const toolset = new TaskToolSet({
          ...(opts.delegateMaxChars !== undefined ? { maxChars: opts.delegateMaxChars } : {}),
        });
        const record = await toolset.delegate(task, opts.runSubagent, {
          ...(role !== undefined ? { role } : {}),
          timeoutMs,
        });
        return truncate(
          JSON.stringify(
            {
              delegationId: record.delegationId,
              status: record.status,
              result: record.result,
              truncated: record.truncated,
              rawChars: record.rawChars,
              rawLines: record.rawLines,
              resultTokens: record.resultTokens,
              changedFiles: record.changedFiles,
              durationMs: record.durationMs,
              ...(record.error !== undefined ? { error: record.error } : {}),
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

  const budgetTool: Tool = {
    definition: toolDef(
      'harness_v3_budget',
      'Show the current conversation budget meter (tokens used, estimated cost, elapsed time, percent used, warnings). Use when the user asks how much budget is left, or before starting a long task to check whether the conversation can afford it. Returns one meter line plus the warning list.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async (_args, ctx) => {
      try {
        if (opts.getBudgetSnapshot === undefined) return NOT_BOUND_BUDGET;
        const snapshot = opts.getBudgetSnapshot(ctx);
        if (snapshot === undefined || snapshot === null) {
          return 'Conversation hiện tại chưa có budget meter (không đặt giới hạn token/cost/thời gian) — chỉ đếm, không cảnh báo.';
        }
        return truncate(
          JSON.stringify(
            {
              meterLine: formatBudgetMeterLine(snapshot),
              status: snapshot.status,
              percentUsed: snapshot.percentUsed,
              totalTokens: snapshot.tokens.totalTokens,
              costUsd: snapshot.tokens.costUsd,
              elapsedMs: snapshot.elapsedMs,
              timeLimitMs: snapshot.timeLimitMs,
              warnings: snapshot.warnings,
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

  const modelTool: Tool = {
    definition: toolDef(
      'harness_v3_model',
      'List saved LLM profiles or switch the active profile immediately (same as the /model chat command, but callable as a tool). action=list returns the saved profiles with the active one marked; action=switch changes the active profile so the next turn uses it. Profiles never contain API keys — the key stays in the Vault.',
      {
        action: { type: 'string', enum: ['list', 'switch'], description: 'list = liệt kê profile; switch = đổi profile active.' },
        profileId: { type: 'string', description: 'Id profile cần đổi sang (bắt buộc khi action=switch).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const action = getStringArg(args, 'action');
        if (action !== 'list' && action !== 'switch') {
          return errorResult(`Unknown action "${action}": expected list | switch.`);
        }
        if (opts.getProfileStore === undefined) return NOT_BOUND_MODEL;
        const store = opts.getProfileStore(ctx);
        if (store === undefined || store === null) return NOT_BOUND_MODEL;
        if (action === 'list') {
          const profiles = store.list();
          const activeId = store.activeProfileId;
          return truncate(
            JSON.stringify(
              {
                activeProfileId: activeId,
                profiles: profiles.map((p) => ({
                  id: p.id,
                  name: p.name,
                  providerId: p.providerId,
                  model: p.model,
                  active: p.id === activeId,
                  ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
                  ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
                })),
              },
              null,
              2,
            ),
          );
        }
        const profileId = getStringArg(args, 'profileId');
        try {
          const profile = store.setActive(profileId);
          return `Đã đổi sang profile "${profile.id}" — ${profile.name} (${profile.providerId} / ${profile.model}). Turn tiếp theo sẽ dùng profile này.`;
        } catch (err) {
          const available = store.list();
          return errorResult(
            `${(err as Error).message}${available.length > 0 ? ` Profile có sẵn: ${available.map((p) => p.id).join(', ')}.` : ' Chưa có profile nào.'}`,
          );
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [delegateTool, budgetTool, modelTool];
}

/** Unbound placeholders (đăng ký vào ALL_TOOLS; host bind lại bằng factory). */
export const HARNESS_V107_TOOLS: Tool[] = createHarnessV107Tools();
