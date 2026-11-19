/**
 * Coding agent v15 tools (v1.37, Đội T4) — 10 tools.
 *
 * Nối coding agent v14 tools: placeholder trong ALL_TOOLS cho tới
 * khi host bind (`createCodingV15Tools(getBaseDir)` với userData
 * dir). Không gọi model thật, không gọi mạng — mọi tool làm việc
 * trên file local trong thư mục dữ liệu v15:
 *
 *   <base>/coding-v15/
 *     profiles.json        (profile custom — built-in tạo lại từ code)
 *     hooks-dialog.json    (feedback của hook, pending qua restart)
 *     budget-<runId>.json  (lịch sử budget ghi lại theo run, tuỳ chọn)
 *
 *  - coding_v15_profile_create — tạo profile mới (persona + tool
 *    set + model + nhãn ACP).
 *  - coding_v15_profile_list   — liệt kê profile (lọc theo kind,
 *    chỉ ACP, kèm nhãn `[ACP]`).
 *  - coding_v15_profile_apply  — áp profile cho run: system prompt
 *    cuối + effective tools + model + nhãn ACP.
 *  - coding_v15_profile_update — sửa profile custom (built-in chỉ đọc).
 *  - coding_v15_profile_delete — xóa profile custom (built-in không xóa).
 *  - coding_v15_profile_clone  — clone một profile (kể cả built-in)
 *    thành profile custom mới để sửa.
 *  - coding_v15_budget_report  — meter CHỈ-BÁO-CÁO: ghi usage rồi
 *    báo cáo token + cost ước tính so với cap (vượt cap vẫn chạy,
 *    chỉ cảnh báo 80%/100%).
 *  - coding_v15_budget_history — lịch sử tiêu thụ theo run/bot.
 *  - coding_v15_hooks_dialog   — dialog nhận feedback stop hook
 *    ngoài chat: add/list/confirm/dismiss/snooze/open/close.
 *  - coding_v15_verify         — chạy bộ 9 verify scenario (kỳ
 *    vọng rõ ràng, báo cáo pass/fail từng scenario).
 *  - coding_v15_agent          — chạy CodingAgentV15 end-to-end với
 *    script step JSON + profile + budget (ghi file thật ra workspace).
 *  - coding_v15_run_report     — báo cáo tổng hợp một run (profile +
 *    budget + hooks + verify) + chấm điểm rubric (không gọi model).
 *  - coding_v15_verify_history — lịch sử kiểm chứng: append report,
 *    list, compare với baseline, flaky, trend.
 *  - coding_v15_eval           — chấm điểm rubric một run v15
 *    (completion/correctness/efficiency/budget/hooks → hạng A–F).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  CodingV15BudgetMeter,
  CodingV15HooksDialog,
  CodingV15ProfileStore,
  CodingV15VerifyHistory,
  buildV15RunReport,
  renderV15BudgetForecast,
  renderV15BudgetHistory,
  renderV15BudgetReport,
  renderV15EvalResult,
  renderV15HooksDialog,
  renderV15ProfileSummary,
  renderV15RunReportMarkdown,
  renderV15VerifyComparison,
  renderV15VerifyReport,
  runV15Agent,
  scriptedV15Agent,
  v15BuiltinScenarios,
  v15CorrectOutcomes,
  v15EvalRun,
  v15FindScenario,
  v15ForecastBudget,
  v15RunVerifyScenarios,
  v15ScriptedVerifyStepFn,
  v15WrongOutcomes,
} from '@open-bot/core';
import type {
  V15AgentRunResult,
  V15AgentStep,
  V15BudgetCap,
  V15HookDecision,
  V15HookFeedback,
  V15NewHookFeedback,
  V15NewProfile,
  V15NewUsage,
  V15ProfileKind,
  V15ProfileUpdate,
  V15VerifyReport,
  V15VerifyScenarioKind,
  V15VerifyStepOutcome,
} from '@open-bot/core';

export const CODING_V15_TOOL_NAMES = [
  'coding_v15_profile_create',
  'coding_v15_profile_list',
  'coding_v15_profile_apply',
  'coding_v15_profile_update',
  'coding_v15_profile_delete',
  'coding_v15_profile_clone',
  'coding_v15_budget_report',
  'coding_v15_budget_history',
  'coding_v15_hooks_dialog',
  'coding_v15_verify',
  'coding_v15_agent',
  'coding_v15_run_report',
  'coding_v15_verify_history',
  'coding_v15_eval',
] as const;

export type CodingV15ToolName = (typeof CODING_V15_TOOL_NAMES)[number];

export function isCodingV15ToolName(name: string): boolean {
  return (CODING_V15_TOOL_NAMES as readonly string[]).includes(name);
}

export interface CodingV15ToolOptions {
  /** Thư mục workspace fallback (ưu tiên ctx.workspaceDir). */
  getWorkspaceDir?: () => string | null | undefined;
}

/** Thư mục dữ liệu v15 trong base dir của host. */
export function codingV15DataDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v15');
}

/** Tạo (nếu chưa có) thư mục dữ liệu v15, trả đường dẫn. */
export function codingV15EnsureDataDir(baseDir: string): string {
  const dir = codingV15DataDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
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

function parseJsonObjectArg(raw: string, name: string): Record<string, unknown> {
  if (raw.trim() === '') throw new Error(`Argument "${name}" must be valid JSON object.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Argument "${name}" must be valid JSON object.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Argument "${name}" must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseJsonArrayArg(raw: string, name: string): unknown[] {
  if (raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Argument "${name}" must be valid JSON array.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Argument "${name}" must be a JSON array.`);
  return parsed;
}

function asStringRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`"${name}" must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/** Parse một step JSON của agent v15 (không bịa field). */
function parseV15Step(entry: unknown, index: number): V15AgentStep {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`stepsJson[${index}] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e['text'] !== 'string') throw new Error(`stepsJson[${index}].text must be a string.`);
  const toolCalls: V15AgentStep['toolCalls'] = [];
  if (e['toolCalls'] !== undefined && e['toolCalls'] !== null) {
    if (!Array.isArray(e['toolCalls'])) throw new Error(`stepsJson[${index}].toolCalls must be an array.`);
    for (const [j, c] of (e['toolCalls'] as unknown[]).entries()) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        throw new Error(`stepsJson[${index}].toolCalls[${j}] must be an object.`);
      }
      const cc = c as Record<string, unknown>;
      if (typeof cc['tool'] !== 'string') throw new Error(`stepsJson[${index}].toolCalls[${j}].tool must be a string.`);
      if (cc['status'] !== 'ok' && cc['status'] !== 'error') {
        throw new Error(`stepsJson[${index}].toolCalls[${j}].status must be "ok" | "error".`);
      }
      let fileChange: NonNullable<V15AgentStep['toolCalls']>[number]['fileChange'];
      const fcRaw = cc['fileChange'];
      if (fcRaw !== undefined && fcRaw !== null) {
        if (typeof fcRaw !== 'object' || Array.isArray(fcRaw)) {
          throw new Error(`stepsJson[${index}].toolCalls[${j}].fileChange must be an object.`);
        }
        const fc = fcRaw as Record<string, unknown>;
        if (typeof fc['path'] !== 'string') throw new Error(`stepsJson[${index}].toolCalls[${j}].fileChange.path must be a string.`);
        const kind = fc['kind'];
        if (kind !== 'edit' && kind !== 'create' && kind !== 'delete') {
          throw new Error(`stepsJson[${index}].toolCalls[${j}].fileChange.kind must be "edit" | "create" | "delete".`);
        }
        fileChange = {
          path: fc['path'] as string,
          kind: kind as 'edit' | 'create' | 'delete',
          ...(typeof fc['beforeContent'] === 'string' ? { beforeContent: fc['beforeContent'] as string } : {}),
          ...(typeof fc['afterContent'] === 'string' ? { afterContent: fc['afterContent'] as string } : {}),
        };
      }
      toolCalls.push({
        tool: cc['tool'] as string,
        args: asStringRecord(cc['args'] ?? {}, `stepsJson[${index}].toolCalls[${j}].args`),
        status: cc['status'] as 'ok' | 'error',
        ...(typeof cc['outputPreview'] === 'string' ? { outputPreview: cc['outputPreview'] as string } : {}),
        ...(typeof cc['error'] === 'string' ? { error: cc['error'] as string } : {}),
        ...(fileChange ? { fileChange } : {}),
      });
    }
  }
  let stopHookFeedback: V15AgentStep['stopHookFeedback'];
  const shRaw = e['stopHookFeedback'];
  if (shRaw !== undefined && shRaw !== null) {
    if (typeof shRaw !== 'object' || Array.isArray(shRaw)) {
      throw new Error(`stepsJson[${index}].stopHookFeedback must be an object.`);
    }
    const sh = shRaw as Record<string, unknown>;
    if (typeof sh['source'] !== 'string' || typeof sh['title'] !== 'string' || typeof sh['body'] !== 'string') {
      throw new Error(`stepsJson[${index}].stopHookFeedback needs source/title/body strings.`);
    }
    stopHookFeedback = {
      runId: '',
      source: sh['source'] as string,
      title: sh['title'] as string,
      body: sh['body'] as string,
      ...(typeof sh['severity'] === 'string' ? { severity: sh['severity'] as V15NewHookFeedback['severity'] } : {}),
    };
  }
  return {
    text: e['text'] as string,
    toolCalls,
    done: e['done'] === true,
    ...(typeof e['inputTokens'] === 'number' ? { inputTokens: e['inputTokens'] as number } : {}),
    ...(typeof e['outputTokens'] === 'number' ? { outputTokens: e['outputTokens'] as number } : {}),
    ...(typeof e['model'] === 'string' ? { model: e['model'] as string } : {}),
    ...(stopHookFeedback ? { stopHookFeedback } : {}),
    ...(e['simulateToolError'] === true ? { simulateToolError: true } : {}),
  };
}

/** Parse usage record JSON cho budget tools. */
function parseV15Usage(entry: unknown, index: number, fallbackRunId: string): V15NewUsage {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`usageJson[${index}] must be an object.`);
  }
  const u = entry as Record<string, unknown>;
  if (typeof u['model'] !== 'string') throw new Error(`usageJson[${index}].model must be a string.`);
  if (!Number.isInteger(u['inputTokens']) || (u['inputTokens'] as number) < 0) {
    throw new Error(`usageJson[${index}].inputTokens must be a non-negative integer.`);
  }
  if (!Number.isInteger(u['outputTokens']) || (u['outputTokens'] as number) < 0) {
    throw new Error(`usageJson[${index}].outputTokens must be a non-negative integer.`);
  }
  return {
    runId: typeof u['runId'] === 'string' ? (u['runId'] as string) : fallbackRunId,
    model: u['model'] as string,
    inputTokens: u['inputTokens'] as number,
    outputTokens: u['outputTokens'] as number,
    ...(typeof u['botId'] === 'string' ? { botId: u['botId'] as string } : {}),
    ...(typeof u['profileId'] === 'string' ? { profileId: u['profileId'] as string } : {}),
    ...(typeof u['costUsd'] === 'number' || u['costUsd'] === null ? { costUsd: u['costUsd'] as number | null } : {}),
    ...(typeof u['step'] === 'number' ? { step: u['step'] as number } : {}),
  };
}

/** Parse cap JSON cho budget tools. */
function parseV15Cap(args: Record<string, unknown>): V15BudgetCap {
  const cap: V15BudgetCap = {};
  const maxTokens = getNumberArg(args, 'maxTokens');
  if (maxTokens !== undefined) cap.maxTokens = maxTokens;
  const maxCostUsd = getNumberArg(args, 'maxCostUsd');
  if (maxCostUsd !== undefined) cap.maxCostUsd = maxCostUsd;
  const capRaw = getStringArg(args, 'capJson');
  if (capRaw.trim().length > 0) {
    const obj = parseJsonObjectArg(capRaw, 'capJson');
    if (typeof obj['maxTokens'] === 'number') cap.maxTokens = obj['maxTokens'] as number;
    if (typeof obj['maxCostUsd'] === 'number') cap.maxCostUsd = obj['maxCostUsd'] as number;
  }
  return cap;
}

export function createCodingV15Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: CodingV15ToolOptions = {},
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const resolveDataDir = (ctx: ToolContext): string => {
    const base = resolveBase();
    if (base) return codingV15EnsureDataDir(base);
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) {
      return codingV15EnsureDataDir(path.join(ctx.workspaceDir, '.open-bot'));
    }
    const fallback = toolOptions.getWorkspaceDir?.();
    if (typeof fallback === 'string' && fallback.trim().length > 0) {
      return codingV15EnsureDataDir(path.join(fallback, '.open-bot'));
    }
    return codingV15EnsureDataDir(path.join(os.tmpdir(), 'open-bot-coding-v15'));
  };

  const resolveWorkspaceDir = (ctx: ToolContext): string => {
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) return ctx.workspaceDir;
    const dir = toolOptions.getWorkspaceDir?.();
    if (typeof dir === 'string' && dir.trim().length > 0) return dir;
    const base = resolveBase();
    return base ? path.join(base, 'coding-v15-workspace') : path.join(os.tmpdir(), 'open-bot-coding-v15-workspace');
  };

  const profileStore = (ctx: ToolContext): CodingV15ProfileStore =>
    new CodingV15ProfileStore({ dataDir: resolveDataDir(ctx) });

  const hooksDialog = (ctx: ToolContext): CodingV15HooksDialog =>
    new CodingV15HooksDialog({ dataDir: resolveDataDir(ctx) });

  const profileCreateTool: Tool = {
    definition: toolDef(
      'coding_v15_profile_create',
      'Create a coding agent v15 profile (persona + tool set + model; set exposeViaAcp to list it in ACP with an ACP label).',
      {
        profileJson: { type: 'string', description: 'JSON object: { name (required), persona (required), id?, kind?, description?, systemPrompt?, model?, allowedTools?, deniedTools?, maxSteps?, temperature?, exposeViaAcp? }.' },
      },
      ['profileJson'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const input = parseJsonObjectArg(getStringArg(args, 'profileJson', true), 'profileJson') as unknown as V15NewProfile;
        const created = profileStore(ctx).create(input);
        return JSON.stringify({ summary: renderV15ProfileSummary(created), profile: created }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileListTool: Tool = {
    definition: toolDef(
      'coding_v15_profile_list',
      'List coding agent v15 profiles (built-in + custom), optionally filtered by kind or ACP-only. ACP profiles carry an "[ACP]" display label.',
      {
        kind: { type: 'string', description: 'Optional kind filter: general | reviewer | planner | fixer | explorer | custom.' },
        acpOnly: { type: 'boolean', description: 'true = only profiles exposed via ACP.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const store = profileStore(ctx);
        const kindRaw = getStringArg(args, 'kind');
        const acpOnly = getBoolArg(args, 'acpOnly') ?? false;
        let profiles = store.list();
        if (acpOnly) profiles = profiles.filter((p) => p.exposeViaAcp);
        if (kindRaw.trim().length > 0) {
          const kind = kindRaw as V15ProfileKind;
          profiles = profiles.filter((p) => p.kind === kind);
        }
        return JSON.stringify(
          {
            count: profiles.length,
            profiles: profiles.map((p) => ({ ...p, acpDisplayName: p.exposeViaAcp ? `${p.name} [ACP]` : p.name, summary: renderV15ProfileSummary(p) })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileApplyTool: Tool = {
    definition: toolDef(
      'coding_v15_profile_apply',
      'Apply a coding agent v15 profile to a run: returns the final system prompt, effective tools (deny wins), model and ACP display label.',
      {
        profileId: { type: 'string', description: 'Profile id (e.g. v15-reviewer or a custom id).' },
        fallbackModel: { type: 'string', description: 'Model to use when the profile sets no model.' },
      },
      ['profileId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const applied = profileStore(ctx).apply(
          getStringArg(args, 'profileId', true),
          getStringArg(args, 'fallbackModel'),
        );
        return JSON.stringify(
          { profileId: applied.profile.id, systemPrompt: applied.systemPrompt, effectiveTools: applied.effectiveTools, model: applied.model, acpDisplayName: applied.acpDisplayName, exposedViaAcp: applied.exposedViaAcp },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileUpdateTool: Tool = {
    definition: toolDef(
      'coding_v15_profile_update',
      'Update a custom coding agent v15 profile (built-in profiles are read-only — clone them first).',
      {
        profileId: { type: 'string', description: 'Profile id to update.' },
        patchJson: { type: 'string', description: 'JSON object with the fields to change (name, kind, persona, systemPrompt, model, allowedTools, deniedTools, maxSteps, temperature, exposeViaAcp, description).' },
      },
      ['profileId', 'patchJson'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const patch = parseJsonObjectArg(getStringArg(args, 'patchJson', true), 'patchJson') as unknown as V15ProfileUpdate;
        const updated = profileStore(ctx).update(getStringArg(args, 'profileId', true), patch);
        return JSON.stringify({ summary: renderV15ProfileSummary(updated), profile: updated }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileDeleteTool: Tool = {
    definition: toolDef(
      'coding_v15_profile_delete',
      'Delete a custom coding agent v15 profile (built-in profiles cannot be deleted).',
      {
        profileId: { type: 'string', description: 'Profile id to delete.' },
      },
      ['profileId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const id = getStringArg(args, 'profileId', true);
        profileStore(ctx).delete(id);
        return JSON.stringify({ deleted: id }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileCloneTool: Tool = {
    definition: toolDef(
      'coding_v15_profile_clone',
      'Clone a coding agent v15 profile (including built-in ones) into a new custom profile to edit.',
      {
        profileId: { type: 'string', description: 'Profile id to clone.' },
        newId: { type: 'string', description: 'Id for the clone (default "<id>-copy").' },
        newName: { type: 'string', description: 'Display name for the clone (default "<name> (copy)").' },
      },
      ['profileId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const newId = getStringArg(args, 'newId');
        const newName = getStringArg(args, 'newName');
        const cloned = profileStore(ctx).clone(
          getStringArg(args, 'profileId', true),
          newId.trim().length > 0 ? newId : undefined,
          newName.trim().length > 0 ? newName : undefined,
        );
        return JSON.stringify({ summary: renderV15ProfileSummary(cloned), profile: cloned }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const budgetReportTool: Tool = {
    definition: toolDef(
      'coding_v15_budget_report',
      'Report-only budget meter for a coding agent v15 run: record usage events, then report tokens + estimated cost vs cap. Exceeding the cap NEVER stops the run — warnings at 80%/100% are advisory only. Pass stepsRemaining to also forecast the projected total.',
      {
        runId: { type: 'string', description: 'Run id the usage belongs to.' },
        botId: { type: 'string', description: 'Bot id (default "default-bot").' },
        usageJson: { type: 'string', description: 'JSON array of usage events: [{ model, inputTokens, outputTokens, profileId?, costUsd?, step? }].' },
        maxTokens: { type: 'number', description: 'Optional token cap.' },
        maxCostUsd: { type: 'number', description: 'Optional cost cap in USD.' },
        capJson: { type: 'string', description: 'Optional JSON cap object { maxTokens?, maxCostUsd? } (overrides maxTokens/maxCostUsd when present).' },
        stepsRemaining: { type: 'number', description: 'Optional estimated remaining steps — when given, the output also includes a forecast of the projected total at the current pace.' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runId = getStringArg(args, 'runId', true);
        const botId = getStringArg(args, 'botId') || 'default-bot';
        const cap = parseV15Cap(args);
        const meter = new CodingV15BudgetMeter(botId, cap);
        const entries = parseJsonArrayArg(getStringArg(args, 'usageJson'), 'usageJson');
        for (const [i, entry] of entries.entries()) {
          meter.record(parseV15Usage(entry, i, runId));
        }
        const report = meter.report(runId);
        const stepsRemaining = getNumberArg(args, 'stepsRemaining');
        let forecast: ReturnType<typeof v15ForecastBudget> | null = null;
        let forecastText = '';
        if (stepsRemaining !== undefined) {
          forecast = v15ForecastBudget(report.state, Math.trunc(stepsRemaining));
          forecastText = `\n${renderV15BudgetForecast(forecast)}`;
        }
        return JSON.stringify({ summary: `${renderV15BudgetReport(report)}${forecastText}`, report, forecast }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const budgetHistoryTool: Tool = {
    definition: toolDef(
      'coding_v15_budget_history',
      'Budget history across runs/bots for coding agent v15: pass usage events, get per-run totals (tokens, estimated cost, over-cap flag).',
      {
        botId: { type: 'string', description: 'Bot id (default "default-bot").' },
        recordsJson: { type: 'string', description: 'JSON array of usage events: [{ runId, model, inputTokens, outputTokens, profileId?, costUsd?, step? }].' },
      },
      ['recordsJson'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId') || 'default-bot';
        const meter = new CodingV15BudgetMeter(botId, {});
        const entries = parseJsonArrayArg(getStringArg(args, 'recordsJson', true), 'recordsJson');
        for (const [i, entry] of entries.entries()) {
          const u = entry as Record<string, unknown>;
          const runId = typeof u['runId'] === 'string' ? (u['runId'] as string) : 'unknown-run';
          meter.record(parseV15Usage(entry, i, runId));
        }
        const history = meter.history();
        return JSON.stringify({ summary: renderV15BudgetHistory(history), totals: meter.totals(), history }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const hooksDialogTool: Tool = {
    definition: toolDef(
      'coding_v15_hooks_dialog',
      'Hooks dialog for coding agent v15: stop-hook feedback stays OUT of the chat and shows in a dialog instead. Actions: add (new feedback), list, open, close, confirm, dismiss, snooze, unsnooze.',
      {
        action: { type: 'string', description: 'Action: add | list | open | close | confirm | dismiss | snooze | unsnooze.' },
        feedbackJson: { type: 'string', description: 'JSON object for add: { runId, source, title, body, hookKind?, severity? }.' },
        feedbackId: { type: 'string', description: 'Feedback id for confirm/dismiss/snooze.' },
        note: { type: 'string', description: 'Optional note attached to a confirm/dismiss/snooze decision.' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const action = getStringArg(args, 'action', true);
        const dialog = hooksDialog(ctx);
        if (action === 'add') {
          const input = parseJsonObjectArg(getStringArg(args, 'feedbackJson', true), 'feedbackJson') as unknown as V15NewHookFeedback;
          const feedback: V15HookFeedback = dialog.addFeedback(input);
          return JSON.stringify({ summary: 'Feedback added to the hooks dialog (chat untouched).', feedback, dialogState: dialog.state() }, null, 2);
        }
        if (action === 'list' || action === 'open' || action === 'close') {
          const state = action === 'open' ? dialog.openDialog() : action === 'close' ? dialog.closeDialog() : dialog.state();
          return JSON.stringify({ summary: renderV15HooksDialog(state), dialogState: state }, null, 2);
        }
        if (action === 'confirm' || action === 'dismiss' || action === 'snooze') {
          const id = getStringArg(args, 'feedbackId', true);
          const decision = action as V15HookDecision;
          const note = getStringArg(args, 'note');
          const decided = dialog.decide(id, decision, note.trim().length > 0 ? note : undefined);
          return JSON.stringify({ summary: `Feedback ${decision}ed.`, feedback: decided, dialogState: dialog.state() }, null, 2);
        }
        if (action === 'unsnooze') {
          const count = dialog.unsnoozeAll();
          return JSON.stringify({ summary: `${count} snoozed feedback items returned to pending.`, dialogState: dialog.state() }, null, 2);
        }
        throw new Error(`Unknown hooks dialog action: "${action}" (expected add | list | open | close | confirm | dismiss | snooze | unsnooze).`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const verifyTool: Tool = {
    definition: toolDef(
      'coding_v15_verify',
      'Run the coding agent v15 verify scenario suite (beyond the happy path: tool error, timeout, malformed output, file conflict, mid-run test failure, empty response, permission denied, large diff). Reports pass/fail per scenario.',
      {
        runId: { type: 'string', description: 'Run id for the verify report.' },
        profileId: { type: 'string', description: 'Profile id the scenarios ran under.' },
        scenarioIds: { type: 'string', description: 'Optional comma-separated scenario ids (default: all 9 built-in).' },
        useWrongOutcomes: { type: 'boolean', description: 'true = simulate an agent that behaves WRONG (to prove the runner catches failures). Default false (correct agent).' },
        failFast: { type: 'boolean', description: 'true = stop at the first failed scenario.' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const runId = getStringArg(args, 'runId', true);
        const profileId = getStringArg(args, 'profileId');
        const wrong = getBoolArg(args, 'useWrongOutcomes') ?? false;
        const failFast = getBoolArg(args, 'failFast') ?? false;
        let scenarios = v15BuiltinScenarios();
        const idsRaw = getStringArg(args, 'scenarioIds');
        if (idsRaw.trim().length > 0) {
          const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
          scenarios = ids.map((id) => v15FindScenario(scenarios, id));
        }
        const outcomes = wrong ? v15WrongOutcomes() : v15CorrectOutcomes();
        const stepFn = v15ScriptedVerifyStepFn(outcomes as Partial<Record<V15VerifyScenarioKind, V15VerifyStepOutcome>>);
        const report = await v15RunVerifyScenarios(stepFn, { runId, profileId, scenarios, failFast });
        return JSON.stringify({ summary: renderV15VerifyReport(report), report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const agentTool: Tool = {
    definition: toolDef(
      'coding_v15_agent',
      'Run coding agent v15 end-to-end with scripted steps under a profile: budget meter records tokens per step (report-only), stop-hook feedback goes to the hooks dialog (not the chat), file changes are written to the workspace.',
      {
        runId: { type: 'string', description: 'Run id.' },
        prompt: { type: 'string', description: 'Task prompt for the agent.' },
        profileId: { type: 'string', description: 'Profile id (default v15-general).' },
        botId: { type: 'string', description: 'Bot id (default "default-bot").' },
        stepsJson: { type: 'string', description: 'JSON array of scripted steps: [{ text, toolCalls?, done?, inputTokens?, outputTokens?, model?, stopHookFeedback?, simulateToolError? }].' },
        maxSteps: { type: 'number', description: 'Max steps for the run.' },
        capJson: { type: 'string', description: 'Optional budget cap JSON { maxTokens?, maxCostUsd? }.' },
        fallbackModel: { type: 'string', description: 'Model fallback when the profile sets no model.' },
      },
      ['runId', 'prompt', 'stepsJson'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const dataDir = resolveDataDir(ctx);
      const workspaceDir = resolveWorkspaceDir(ctx);
      try {
        const runId = getStringArg(args, 'runId', true);
        const prompt = getStringArg(args, 'prompt', true);
        const steps = parseJsonArrayArg(getStringArg(args, 'stepsJson', true), 'stepsJson').map((s, i) => parseV15Step(s, i));
        const maxStepsRaw = getNumberArg(args, 'maxSteps');
        const maxSteps = maxStepsRaw !== undefined ? Math.trunc(maxStepsRaw) : undefined;
        const cap = parseV15Cap(args);
        const result = runV15Agent(
          {
            runId,
            prompt,
            profileId: getStringArg(args, 'profileId') || 'v15-general',
            botId: getStringArg(args, 'botId') || 'default-bot',
            maxSteps,
            budgetCap: cap,
          },
          scriptedV15Agent(steps),
          {
            dataDir,
            fallbackModel: getStringArg(args, 'fallbackModel'),
            fileApplier: (filePath: string, content: string | null): void => {
              const abs = path.join(workspaceDir, filePath);
              if (content === null) {
                fs.rmSync(abs, { force: true });
              } else {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.writeFileSync(abs, content, 'utf8');
              }
            },
          },
        );
        return JSON.stringify({ dataDir, workspaceDir, summary: `Agent run ${runId}: ${result.stepsExecuted} steps, done=${result.done}.`, result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runReportTool: Tool = {
    definition: toolDef(
      'coding_v15_run_report',
      'Build the combined report for a coding agent v15 run (profile + budget + hooks dialog + verify) as markdown, plus a rubric eval score (no model call).',
      {
        resultJson: { type: 'string', description: 'JSON object: the V15AgentRunResult to report on (runId, profileId, botId, prompt, stepsExecuted, done, stoppedByMaxSteps, budget, hooksDialog, filesWritten, toolErrors, verify?).' },
        fallbackModel: { type: 'string', description: 'Model fallback when the profile sets no model.' },
      },
      ['resultJson'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const result = parseJsonObjectArg(getStringArg(args, 'resultJson', true), 'resultJson') as unknown as V15AgentRunResult;
        if (typeof result.runId !== 'string' || typeof result.profileId !== 'string') {
          throw new Error('resultJson must contain runId and profileId.');
        }
        const applied = profileStore(ctx).apply(result.profileId, getStringArg(args, 'fallbackModel'));
        const report = buildV15RunReport({ result, applied });
        const evalResult = v15EvalRun(result);
        return JSON.stringify(
          {
            summary: report.summary,
            markdown: renderV15RunReportMarkdown(report),
            evalSummary: renderV15EvalResult(evalResult),
            report,
            eval: evalResult,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const verifyHistoryTool: Tool = {
    definition: toolDef(
      'coding_v15_verify_history',
      'Verify history for coding agent v15: append a verify report, list past runs, compare a run with a baseline (regressions/fixes), list flaky scenarios, or show the pass-rate trend.',
      {
        action: { type: 'string', description: 'Action: append | list | compare | flaky | trend.' },
        reportJson: { type: 'string', description: 'JSON object for append: a V15VerifyReport.' },
        runId: { type: 'string', description: 'Run id for compare.' },
        baselineRunId: { type: 'string', description: 'Baseline run id for compare.' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      try {
        const action = getStringArg(args, 'action', true);
        const history = new CodingV15VerifyHistory({ dataDir: resolveDataDir(ctx) });
        if (action === 'append') {
          const report = parseJsonObjectArg(getStringArg(args, 'reportJson', true), 'reportJson') as unknown as V15VerifyReport;
          history.append(report);
          return JSON.stringify({ summary: `Verify report ${report.runId} appended. History now has ${history.size} run(s).`, size: history.size }, null, 2);
        }
        if (action === 'list') {
          const reports = history.all();
          return JSON.stringify({ summary: `${reports.length} verify run(s) in history.`, reports: reports.map((r) => ({ runId: r.runId, profileId: r.profileId, total: r.total, passed: r.passed, failed: r.failed, createdAt: r.createdAt })) }, null, 2);
        }
        if (action === 'compare') {
          const runId = getStringArg(args, 'runId', true);
          const baselineRunId = getStringArg(args, 'baselineRunId', true);
          const comparison = history.compare(runId, baselineRunId);
          return JSON.stringify({ summary: renderV15VerifyComparison(comparison), comparison }, null, 2);
        }
        if (action === 'flaky') {
          const flaky = history.flaky();
          return JSON.stringify({ summary: flaky.length > 0 ? `Flaky scenarios: ${flaky.map((f) => `${f.scenarioId} (${(f.passRate * 100).toFixed(0)}% pass over ${f.runs} runs)`).join(', ')}.` : 'No flaky scenarios.', flaky }, null, 2);
        }
        if (action === 'trend') {
          const trend = history.trend();
          return JSON.stringify({ summary: history.renderTrend(), trend }, null, 2);
        }
        throw new Error(`Unknown verify history action: "${action}" (expected append | list | compare | flaky | trend).`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'coding_v15_eval',
      'Score a coding agent v15 run with the rubric (completion / correctness / efficiency / budget / hooks → total + grade A–F). No model call — heuristic on the run data.',
      {
        resultJson: { type: 'string', description: 'JSON object: the V15AgentRunResult to score.' },
      },
      ['resultJson'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const result = parseJsonObjectArg(getStringArg(args, 'resultJson', true), 'resultJson') as unknown as V15AgentRunResult;
        if (typeof result.runId !== 'string' || typeof result.profileId !== 'string') {
          throw new Error('resultJson must contain runId and profileId.');
        }
        const evalResult = v15EvalRun(result);
        return JSON.stringify({ summary: renderV15EvalResult(evalResult), eval: evalResult }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    profileCreateTool,
    profileListTool,
    profileApplyTool,
    profileUpdateTool,
    profileDeleteTool,
    profileCloneTool,
    budgetReportTool,
    budgetHistoryTool,
    hooksDialogTool,
    verifyTool,
    agentTool,
    runReportTool,
    verifyHistoryTool,
    evalTool,
  ];
}

/** Placeholder tools (chưa bind base dir) — dùng trong ALL_TOOLS. */
export const CODING_V15_TOOLS: Tool[] = createCodingV15Tools();

/** Đảm bảo base dir có thư mục dữ liệu v15 (dùng khi host bind). */
export function codingV15EnsureBaseDir(baseDir: string): string {
  return codingV15EnsureDataDir(baseDir);
}
