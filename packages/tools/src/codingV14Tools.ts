/**
 * Coding agent v14 tools (v1.29, Đội T3) — 6 tools.
 *
 * Nối coding agent v9 tools (v1.17): placeholder trong ALL_TOOLS cho
 * tới khi host bind (`createCodingV14Tools(getBaseDir)` với userData
 * dir). Không gọi model thật, không gọi mạng — mọi tool làm việc trên
 * file local trong thư mục dữ liệu v14:
 *
 *   <base>/coding-v14/
 *     run-logs/<runId>.jsonl        (RunLogStore — event log chung)
 *     run-logs/<runId>.v14condense.json (sidecar các bản nén v14)
 *     reasoning/<runId>.reasoning.jsonl (sidecar reasoning blocks)
 *     <runId>.journal.json          (edit journal — để rollback)
 *
 *  - coding_v14_condense   — nén tăng dần log của một run (retention
 *    policy + marker `run.compacted` + sidecar bản nén đầy đủ).
 *  - coding_v14_stuck_check — phát hiện kẹt v2 trên log của một run
 *    (loop signature, oscillation, no-progress) + gợi ý recovery.
 *  - coding_v14_recover    — lập kế hoạch recovery + thực thi bước
 *    đầu (redirect / narrow_scope / ask_user / escalate; rollback
 *    lần edit cuối bằng journal file + ghi thật ra workspace).
 *  - coding_v14_reasoning  — liệt kê + verify reasoning blocks của
 *    một run (sidecar hash chain + đối chiếu digest trong run log).
 *  - coding_v14_agent      — chạy CodingAgentV14 end-to-end với
 *    script step JSON (không tự bịa step), lưu log/sidecar/journal.
 *  - coding_v14_resume     — chạy tiếp agent từ resumeState JSON
 *    (reasoning + journal + condensation được khôi phục).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import { RunLogStore } from '@open-bot/core';
import {
  runV14Agent,
  scriptedV14Agent,
  V14EditJournal,
  renderV14AgentReport,
  renderV14CondensationSummary,
  renderV14StuckReport,
  v14ApplyCondensation,
  v14DetectStuck,
  v14ExecuteRecovery,
  v14PlanRecovery,
  v14ReplayState,
  v14ShouldCondense,
  v14VerifyDigests,
  V14ReasoningStore,
} from '@open-bot/core';
import type {
  V14CondenseStrategy,
  V14EditJournalEntry,
  V14RecoveryStrategy,
  V14ResumeState,
  V14StepResult,
} from '@open-bot/core';

export const CODING_V14_TOOL_NAMES = [
  'coding_v14_condense',
  'coding_v14_stuck_check',
  'coding_v14_recover',
  'coding_v14_reasoning',
  'coding_v14_agent',
  'coding_v14_resume',
] as const;

export type CodingV14ToolName = (typeof CODING_V14_TOOL_NAMES)[number];

export function isCodingV14ToolName(name: string): boolean {
  return (CODING_V14_TOOL_NAMES as readonly string[]).includes(name);
}

export interface CodingV14ToolOptions {
  /** Thư mục workspace fallback (ưu tiên ctx.workspaceDir). */
  getWorkspaceDir?: () => string | null | undefined;
}

/** Thư mục dữ liệu v14 trong base dir của host. */
export function codingV14DataDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v14');
}

/**
 * Thư mục run log chung của v14 — nhận vào THƯ MỤC DỮ LIỆU v14
 * (`<base>/coding-v14`, như `codingV14DataDir` trả về), không phải
 * base dir của host (tránh nhân đôi `coding-v14/coding-v14/`).
 */
export function codingV14RunLogsDir(dataDir: string): string {
  return path.join(dataDir, 'run-logs');
}

/** Thư mục reasoning sidecar của v14 (nhận thư mục dữ liệu v14). */
export function codingV14ReasoningDir(dataDir: string): string {
  return path.join(dataDir, 'reasoning');
}

/** Tạo (nếu chưa có) thư mục dữ liệu v14, trả đường dẫn. */
export function codingV14EnsureDataDir(baseDir: string): string {
  const dir = codingV14DataDir(baseDir);
  fs.mkdirSync(path.join(dir, 'run-logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'reasoning'), { recursive: true });
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

/** Parse một JSON string thành object (lỗi rõ ràng khi sai định dạng). */
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

/** Parse một JSON string thành mảng (lỗi rõ ràng khi sai định dạng). */
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

/** Validate một step JSON thành V14StepResult (không bịa field). */
function parseStepResult(entry: unknown, index: number): V14StepResult {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`stepsJson[${index}] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e['text'] !== 'string') throw new Error(`stepsJson[${index}].text must be a string.`);
  if (!Array.isArray(e['toolCalls'])) throw new Error(`stepsJson[${index}].toolCalls must be an array.`);
  if (typeof e['done'] !== 'boolean') throw new Error(`stepsJson[${index}].done must be a boolean.`);
  const toolCalls: V14StepResult['toolCalls'] = (e['toolCalls'] as unknown[]).map((c, j) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`stepsJson[${index}].toolCalls[${j}] must be an object.`);
    }
    const cc = c as Record<string, unknown>;
    if (typeof cc['tool'] !== 'string') throw new Error(`stepsJson[${index}].toolCalls[${j}].tool must be a string.`);
    if (cc['status'] !== 'ok' && cc['status'] !== 'error' && cc['status'] !== 'denied') {
      throw new Error(`stepsJson[${index}].toolCalls[${j}].status must be "ok" | "error" | "denied".`);
    }
    if (typeof cc['outputPreview'] !== 'string') {
      throw new Error(`stepsJson[${index}].toolCalls[${j}].outputPreview must be a string.`);
    }
    let fileChange: V14StepResult['toolCalls'][number]['fileChange'];
    const fcRaw = cc['fileChange'];
    if (fcRaw !== undefined && fcRaw !== null) {
      if (typeof fcRaw !== 'object' || Array.isArray(fcRaw)) {
        throw new Error(`stepsJson[${index}].toolCalls[${j}].fileChange must be an object.`);
      }
      const fc = fcRaw as Record<string, unknown>;
      if (typeof fc['path'] !== 'string') throw new Error(`stepsJson[${index}].toolCalls[${j}].fileChange.path must be a string.`);
      const kind = fc['kind'];
      if (kind !== 'write' && kind !== 'edit' && kind !== 'delete' && kind !== 'create') {
        throw new Error(`stepsJson[${index}].toolCalls[${j}].fileChange.kind is invalid.`);
      }
      fileChange = {
        path: fc['path'] as string,
        kind,
        ...(typeof fc['beforeContent'] === 'string' || fc['beforeContent'] === null
          ? { beforeContent: fc['beforeContent'] as string | null }
          : {}),
        ...(typeof fc['afterContent'] === 'string' || fc['afterContent'] === null
          ? { afterContent: fc['afterContent'] as string | null }
          : {}),
      };
    }
    return {
      tool: cc['tool'] as string,
      args: (cc['args'] as Record<string, unknown>) ?? {},
      status: cc['status'] as 'ok' | 'error' | 'denied',
      outputPreview: cc['outputPreview'] as string,
      ...(fileChange ? { fileChange } : {}),
    };
  });
  const reasoningRaw = e['reasoning'];
  let reasoning: V14StepResult['reasoning'];
  if (reasoningRaw !== undefined && reasoningRaw !== null) {
    if (typeof reasoningRaw !== 'object' || Array.isArray(reasoningRaw)) {
      throw new Error(`stepsJson[${index}].reasoning must be an object.`);
    }
    const r = reasoningRaw as Record<string, unknown>;
    if (typeof r['text'] !== 'string') throw new Error(`stepsJson[${index}].reasoning.text must be a string.`);
    const kind = r['kind'];
    if (kind !== 'thinking' && kind !== 'reasoning_content' && kind !== 'plan' && kind !== 'self_critique') {
      throw new Error(`stepsJson[${index}].reasoning.kind is invalid.`);
    }
    reasoning = {
      kind,
      text: r['text'] as string,
      ...(typeof r['model'] === 'string' ? { model: r['model'] as string } : {}),
    };
  }
  return {
    text: e['text'] as string,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    done: e['done'] as boolean,
    ...(typeof e['note'] === 'string' ? { note: e['note'] as string } : {}),
  };
}

/** Đường dẫn file journal của một run. */
function journalFilePath(dataDir: string, runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'run';
  return path.join(dataDir, `${safe}.journal.json`);
}

/** Lưu edit journal của một run (để recover rollback được sau này). */
function saveJournal(dataDir: string, runId: string, entries: V14EditJournalEntry[]): void {
  fs.writeFileSync(journalFilePath(dataDir, runId), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

/** Đọc edit journal của một run (rỗng khi chưa có). */
function loadJournal(dataDir: string, runId: string): V14EditJournalEntry[] {
  const file = journalFilePath(dataDir, runId);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is V14EditJournalEntry => {
      if (!e || typeof e !== 'object') return false;
      const v = e as Record<string, unknown>;
      return typeof v['id'] === 'string' && typeof v['path'] === 'string';
    });
  } catch {
    return [];
  }
}

/** Nạp journal file vào V14EditJournal (giữ nguyên undone). */
function journalFromEntries(entries: V14EditJournalEntry[]): V14EditJournal {
  const journal = new V14EditJournal();
  for (const entry of entries) {
    journal.record(entry.runId, entry.path, entry.beforeContent, entry.afterContent, entry.step, entry.seq, entry.createdAt);
    if (entry.undone) {
      const found = journal.find(entry.id);
      if (found) found.undone = true;
    }
  }
  return journal;
}

const V14_RECOVERY_STRATEGIES: V14RecoveryStrategy[] = [
  'redirect',
  'narrow_scope',
  'ask_user',
  'rollback_last_edit',
  'escalate',
];

export function createCodingV14Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: CodingV14ToolOptions = {},
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
    if (base) return codingV14EnsureDataDir(base);
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) {
      return codingV14EnsureDataDir(path.join(ctx.workspaceDir, '.open-bot'));
    }
    const fallback = toolOptions.getWorkspaceDir?.();
    if (typeof fallback === 'string' && fallback.trim().length > 0) {
      return codingV14EnsureDataDir(path.join(fallback, '.open-bot'));
    }
    return codingV14EnsureDataDir(path.join(os.tmpdir(), 'open-bot-coding-v14'));
  };

  const resolveWorkspaceDir = (ctx: ToolContext): string => {
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) return ctx.workspaceDir;
    const dir = toolOptions.getWorkspaceDir?.();
    if (typeof dir === 'string' && dir.trim().length > 0) return dir;
    const base = resolveBase();
    return base ? path.join(base, 'coding-v14-workspace') : path.join(os.tmpdir(), 'open-bot-coding-v14-workspace');
  };

  const openStore = (dataDir: string): RunLogStore =>
    new RunLogStore({ logDir: codingV14RunLogsDir(dataDir) });

  const condenseTool: Tool = {
    definition: toolDef(
      'coding_v14_condense',
      'Condense a run event log incrementally (v1.29): summarize only events after the last run.compacted marker, keep error tool results / latest edit per file / approvals verbatim (retention policy), append a run.compacted marker and save the full condensation to the sidecar. Original events are never deleted.',
      {
        runId: { type: 'string', description: 'Run id to condense, e.g. "run-1".' },
        strategy: { type: 'string', description: '"incremental-summarize" (default) | "incremental-extract-keep" | "full-summarize".' },
        minEvents: { type: 'integer', description: 'Condense when uncondensed events >= N (default 40).' },
        minTokens: { type: 'integer', description: 'Condense when uncondensed tokens >= N (default 4000).' },
        force: { type: 'boolean', description: 'true = condense even below thresholds (default false).' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const dataDir = resolveDataDir(ctx);
      try {
        const runId = getStringArg(args, 'runId', true);
        const strategyRaw = getStringArg(args, 'strategy');
        const strategy: V14CondenseStrategy | undefined =
          strategyRaw === '' ? undefined : (strategyRaw as V14CondenseStrategy);
        if (strategy !== undefined && !['incremental-summarize', 'incremental-extract-keep', 'full-summarize'].includes(strategy)) {
          throw new Error(`Unknown strategy: "${strategyRaw}"`);
        }
        const force = getBoolArg(args, 'force') ?? false;
        const store = openStore(dataDir);
        const { events } = store.readRun(runId);
        if (events.length === 0) throw new Error(`run ${runId} has no events (unknown run id?).`);
        if (!force) {
          const check = v14ShouldCondense(events, {
            ...(strategy ? { strategy } : {}),
            ...(getIntArg(args, 'minEvents') !== undefined ? { minEvents: getIntArg(args, 'minEvents') } : {}),
            ...(getIntArg(args, 'minTokens') !== undefined ? { minTokens: getIntArg(args, 'minTokens') } : {}),
          });
          if (!check.needed) {
            return JSON.stringify({ dataDir, runId, needed: false, reason: check.reason, check }, null, 2);
          }
        }
        const condensation = v14ApplyCondensation(store, codingV14RunLogsDir(dataDir), runId, {
          ...(strategy ? { strategy } : {}),
          ...(getIntArg(args, 'minEvents') !== undefined ? { minEvents: getIntArg(args, 'minEvents') } : {}),
          ...(getIntArg(args, 'minTokens') !== undefined ? { minTokens: getIntArg(args, 'minTokens') } : {}),
        });
        return JSON.stringify(
          { dataDir, summary: renderV14CondensationSummary(condensation), condensation },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stuckCheckTool: Tool = {
    definition: toolDef(
      'coding_v14_stuck_check',
      'Detect stuck loops in a run event log (v1.29): same action repeated, same normalized error repeated, A-B-A-B oscillation, empty model responses with tool calls, or N steps without progress. Pure analysis — does not stop the run.',
      {
        runId: { type: 'string', description: 'Run id to analyze, e.g. "run-1".' },
        repeatActionThreshold: { type: 'integer', description: 'Same action repeated N times = stuck (default 3).' },
        repeatErrorThreshold: { type: 'integer', description: 'Same error repeated N times = stuck (default 3).' },
        noProgressStepThreshold: { type: 'integer', description: 'N steps without progress = stuck (default 8).' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const dataDir = resolveDataDir(ctx);
      try {
        const runId = getStringArg(args, 'runId', true);
        const store = openStore(dataDir);
        const { events } = store.readRun(runId);
        if (events.length === 0) throw new Error(`run ${runId} has no events (unknown run id?).`);
        const report = v14DetectStuck(events, runId, {
          ...(getIntArg(args, 'repeatActionThreshold') !== undefined
            ? { repeatActionThreshold: getIntArg(args, 'repeatActionThreshold') }
            : {}),
          ...(getIntArg(args, 'repeatErrorThreshold') !== undefined
            ? { repeatErrorThreshold: getIntArg(args, 'repeatErrorThreshold') }
            : {}),
          ...(getIntArg(args, 'noProgressStepThreshold') !== undefined
            ? { noProgressStepThreshold: getIntArg(args, 'noProgressStepThreshold') }
            : {}),
        });
        const replay = v14ReplayState(events, runId);
        return JSON.stringify(
          { dataDir, summary: renderV14StuckReport(report), report, replay },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const recoverTool: Tool = {
    definition: toolDef(
      'coding_v14_recover',
      'Plan and execute the first recovery step for a stuck run (v1.29): redirect, narrow_scope, ask_user, rollback_last_edit (restores the last edited file from the saved edit journal, writing the real file in the workspace), or escalate. Records a stuck.recovered event in the run log.',
      {
        runId: { type: 'string', description: 'Run id to recover, e.g. "run-1".' },
        strategy: { type: 'string', description: 'Optional strategy to execute: "redirect" | "narrow_scope" | "ask_user" | "rollback_last_edit" | "escalate". Default = first step of the plan.' },
        allowAskUser: { type: 'boolean', description: 'true = the ask_user step may be used (default false).' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const dataDir = resolveDataDir(ctx);
      const workspaceDir = resolveWorkspaceDir(ctx);
      try {
        const runId = getStringArg(args, 'runId', true);
        const strategyRaw = getStringArg(args, 'strategy');
        const strategy: V14RecoveryStrategy | undefined =
          strategyRaw === '' ? undefined : (strategyRaw as V14RecoveryStrategy);
        if (strategy !== undefined && !V14_RECOVERY_STRATEGIES.includes(strategy)) {
          throw new Error(`Unknown strategy: "${strategyRaw}"`);
        }
        const allowAskUser = getBoolArg(args, 'allowAskUser') ?? false;
        const store = openStore(dataDir);
        const { events } = store.readRun(runId);
        if (events.length === 0) throw new Error(`run ${runId} has no events (unknown run id?).`);
        const report = v14DetectStuck(events, runId);
        if (!report.stuck) {
          return JSON.stringify({ dataDir, runId, stuck: false, message: 'Run is not stuck — no recovery needed.' }, null, 2);
        }
        const signal = report.signals[0]!;
        const journalEntries = loadJournal(dataDir, runId);
        const journal = journalFromEntries(journalEntries);
        // priorRecoveries thật: đếm event stuck.recovered trong log.
        const priorRecoveries = events.filter((e) => e.type === 'stuck.recovered').length;
        const planWithCount = v14PlanRecovery(runId, signal, {
          hasLastEdit: journal.lastEdit() !== undefined,
          allowAskUser,
          taskSummary: '',
          priorRecoveries,
        });
        const applier = (filePath: string, content: string | null): void => {
          const abs = path.join(workspaceDir, filePath);
          if (content === null) {
            fs.rmSync(abs, { force: true });
          } else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, 'utf8');
          }
        };
        const result = v14ExecuteRecovery(planWithCount, {
          redirect: (i) => i,
          narrowScope: (i) => i,
          askUser: (i) => i,
          escalate: (i) => i,
          rollbackLastEdit: () => journal.rollbackLast(applier),
        }, strategy);
        saveJournal(dataDir, runId, journal.all());
        const marker = store.append(runId, {
          type: 'stuck.recovered',
          payload: {
            step: report.step,
            strategy: result.strategy,
            signalKind: signal.kind,
            detail: result.detail.slice(0, 500),
            applied: result.applied,
          },
        });
        return JSON.stringify(
          { dataDir, workspaceDir, plan: planWithCount, result: { ...result, markerSeq: marker.seq } },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const reasoningTool: Tool = {
    definition: toolDef(
      'coding_v14_reasoning',
      'List and verify reasoning blocks of a run (v1.29): reads the reasoning sidecar JSONL (full thinking / reasoning_content text, hash-chained), verifies the chain, and cross-checks each block against its digest event in the run log.',
      {
        runId: { type: 'string', description: 'Run id, e.g. "run-1".' },
        keepLast: { type: 'integer', description: 'How many recent blocks to return (default 10).' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const dataDir = resolveDataDir(ctx);
      try {
        const runId = getStringArg(args, 'runId', true);
        const keepLast = getIntArg(args, 'keepLast') ?? 10;
        const reasoningStore = new V14ReasoningStore({ dataDir: codingV14ReasoningDir(dataDir) });
        const chain = reasoningStore.verify(runId);
        const blocks = reasoningStore.latestBlocks(runId, keepLast);
        const store = openStore(dataDir);
        const { events } = store.readRun(runId);
        const verification = v14VerifyDigests(events, reasoningStore, runId);
        return JSON.stringify(
          {
            dataDir,
            chain,
            verification,
            totalBlocks: reasoningStore.blocks(runId).length,
            blocks: blocks.map((b) => ({
              id: b.id,
              step: b.step,
              kind: b.kind,
              chars: b.chars,
              sha256: b.sha256,
              excerpt: b.text.slice(0, 300),
              redacted: b.redacted,
              pinned: b.pinned,
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

  const agentTool: Tool = {
    definition: toolDef(
      'coding_v14_agent',
      'Run one CodingAgentV14 task end-to-end (v1.29) from a JSON script of steps: each step gives model text, optional reasoning block, tool calls with results, and done flag. The agent records reasoning blocks, detects stuck loops, recovers, and auto-condenses. No model is called — the script IS the model. Persists run log + sidecars + edit journal.',
      {
        runId: { type: 'string', description: 'Run id, e.g. "run-1".' },
        prompt: { type: 'string', description: 'Task prompt for the agent.' },
        stepsJson: { type: 'string', description: 'JSON array of V14StepResult objects.' },
        maxSteps: { type: 'integer', description: 'Max steps (default 20).' },
        allowAskUser: { type: 'boolean', description: 'true = recovery may ask the user (default false).' },
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
        const steps = parseJsonArrayArg(getStringArg(args, 'stepsJson', true), 'stepsJson').map((s, i) =>
          parseStepResult(s, i),
        );
        const maxSteps = getIntArg(args, 'maxSteps');
        const allowAskUser = getBoolArg(args, 'allowAskUser') ?? false;
        const report = runV14Agent({
          runId,
          prompt,
          maxSteps: maxSteps ?? 20,
          stepFn: scriptedV14Agent(steps),
          dataDir,
          allowAskUser,
          fileApplier: (filePath: string, content: string | null): void => {
            const abs = path.join(workspaceDir, filePath);
            if (content === null) {
              fs.rmSync(abs, { force: true });
            } else {
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, content, 'utf8');
            }
          },
        });
        saveJournal(dataDir, runId, report.resumeState.editJournal);
        return JSON.stringify(
          { dataDir, workspaceDir, summary: renderV14AgentReport(report), report },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const resumeTool: Tool = {
    definition: toolDef(
      'coding_v14_resume',
      'Resume a CodingAgentV14 run from a saved resumeState JSON (v1.29): reasoning blocks, edit journal, condensations and recoveries are restored, then the agent continues with the new script steps. Persists the updated run log + sidecars + edit journal.',
      {
        resumeStateJson: { type: 'string', description: 'JSON of a V14ResumeState (from coding_v14_agent output).' },
        stepsJson: { type: 'string', description: 'JSON array of V14StepResult objects to run next.' },
        maxSteps: { type: 'integer', description: 'Max steps for the resumed run (default 20).' },
        allowAskUser: { type: 'boolean', description: 'true = recovery may ask the user (default false).' },
      },
      ['resumeStateJson', 'stepsJson'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const dataDir = resolveDataDir(ctx);
      const workspaceDir = resolveWorkspaceDir(ctx);
      try {
        const resumeState = parseJsonObjectArg(getStringArg(args, 'resumeStateJson', true), 'resumeStateJson') as unknown as V14ResumeState;
        if (typeof resumeState.runId !== 'string' || typeof resumeState.prompt !== 'string') {
          throw new Error('resumeStateJson must contain runId and prompt.');
        }
        const steps = parseJsonArrayArg(getStringArg(args, 'stepsJson', true), 'stepsJson').map((s, i) =>
          parseStepResult(s, i),
        );
        const maxSteps = getIntArg(args, 'maxSteps');
        const allowAskUser = getBoolArg(args, 'allowAskUser') ?? false;
        const report = runV14Agent({
          runId: resumeState.runId,
          prompt: resumeState.prompt,
          maxSteps: maxSteps ?? 20,
          stepFn: scriptedV14Agent(steps),
          dataDir,
          allowAskUser,
          resumeFrom: resumeState,
          fileApplier: (filePath: string, content: string | null): void => {
            const abs = path.join(workspaceDir, filePath);
            if (content === null) {
              fs.rmSync(abs, { force: true });
            } else {
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, content, 'utf8');
            }
          },
        });
        saveJournal(dataDir, resumeState.runId, report.resumeState.editJournal);
        return JSON.stringify(
          { dataDir, workspaceDir, summary: renderV14AgentReport(report), report },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [condenseTool, stuckCheckTool, recoverTool, reasoningTool, agentTool, resumeTool];
}

/** Placeholder tools (chưa bind base dir) — dùng trong ALL_TOOLS. */
export const CODING_V14_TOOLS: Tool[] = createCodingV14Tools();

/** Đảm bảo base dir có thư mục dữ liệu v14 (dùng khi host bind). */
export function codingV14EnsureBaseDir(baseDir: string): string {
  return codingV14EnsureDataDir(baseDir);
}
