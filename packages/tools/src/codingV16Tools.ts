/**
 * Coding agent v16 tools (v1.38, Đội T4) — 7 tools.
 *
 * Nối coding agent v14 tools (v1.29): placeholder trong ALL_TOOLS cho
 * tới khi host bind (`createCodingV16Tools(getBaseDir)` với userData
 * dir). Không gọi model thật, không gọi mạng — mọi tool làm việc trên
 * file local trong thư mục dữ liệu v16 và workspace của người dùng:
 *
 *   <base>/coding-v16/
 *     budgets.json     (ngân sách + sample token theo task)
 *     costs.json       (cost record theo harness/task)
 *
 *  - coding_v16_budget      — đặt ngân sách token, ghi sample, xem
 *    trạng thái (ok/warn/blocked + dự báo số step còn lại).
 *  - coding_v16_cost        — ghi cost record, so sánh harness
 *    (pass rate, $/task, điểm/đô la), báo cáo cost/accuracy trade-off.
 *  - coding_v16_minimal     — chạy minimal harness (bash-only,
 *    preamble gọn) từ script step JSON, ghi file qua linter gate.
 *  - coding_v16_file_window — xem file theo cửa sổ 100 dòng (phân
 *    trang, nhảy tới dòng, tìm chuỗi).
 *  - coding_v16_lint_edit   — kiểm tra cú pháp rồi mới ghi file
 *    (chặn khi có lỗi error, cho qua khi chỉ warning).
 *  - coding_v16_trim        — cắt gọn history JSON khi vượt ngưỡng
 *    (giữ 5 tool-output gần nhất + entry pinned, thay phần cắt bằng
 *    summary).
 *  - coding_v16_benchmark   — benchmark nội bộ: chạy task mẫu qua
 *    các harness, báo cáo cost/accuracy trade-off.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  HarnessCostEstimator,
  TokenBudgetMeter,
  renderV16BenchmarkReport,
  renderV16BudgetStatus,
  renderV16CostAccuracyReport,
  renderV16FileWindow,
  renderV16LintResult,
  renderV16MinimalReport,
  renderV16TrimResult,
  runV16Benchmark,
  runV16Minimal,
  v16ApplyFileWrite,
  v16GetWindow,
  v16LintContent,
  v16SearchInFile,
  v16TrimHistory,
  v16ValidateBenchmarkTask,
  v16WindowAroundLine,
  v16WindowCenteredOnLine,
} from '@open-bot/core';
import type {
  V16BenchmarkTask,
  V16HistoryEntry,
  V16MinimalStep,
  V16TokenBudget,
  V16TokenSample,
  V16TrimPolicy,
} from '@open-bot/core';

export const CODING_V16_TOOL_NAMES = [
  'coding_v16_budget',
  'coding_v16_cost',
  'coding_v16_minimal',
  'coding_v16_file_window',
  'coding_v16_lint_edit',
  'coding_v16_trim',
  'coding_v16_benchmark',
] as const;

export type CodingV16ToolName = (typeof CODING_V16_TOOL_NAMES)[number];

export function isCodingV16ToolName(name: string): boolean {
  return (CODING_V16_TOOL_NAMES as readonly string[]).includes(name);
}

export interface CodingV16ToolOptions {
  /** Thư mục workspace fallback (ưu tiên ctx.workspaceDir). */
  getWorkspaceDir?: () => string | null | undefined;
}

/** Thư mục dữ liệu v16 trong base dir của host. */
export function codingV16DataDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v16');
}

/** Tạo (nếu chưa có) thư mục dữ liệu v16, trả đường dẫn. */
export function codingV16EnsureDataDir(baseDir: string): string {
  const dir = codingV16DataDir(baseDir);
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

/** Đọc JSON file (trả fallback khi chưa có / lỗi parse). */
function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Ghi JSON file (tạo thư mục cha khi cần). */
function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Validate một minimal step JSON (không bịa field). */
function parseMinimalStep(entry: unknown, index: number): V16MinimalStep {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`stepsJson[${index}] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e['text'] !== 'string') throw new Error(`stepsJson[${index}].text must be a string.`);
  if (typeof e['done'] !== 'boolean') throw new Error(`stepsJson[${index}].done must be a boolean.`);
  const step: V16MinimalStep = { text: e['text'] as string, done: e['done'] as boolean };
  if (typeof e['bashCommand'] === 'string') step.bashCommand = e['bashCommand'] as string;
  if (typeof e['bashOutput'] === 'string') step.bashOutput = e['bashOutput'] as string;
  if (typeof e['promptTokens'] === 'number') step.promptTokens = e['promptTokens'] as number;
  if (typeof e['completionTokens'] === 'number') step.completionTokens = e['completionTokens'] as number;
  if (typeof e['note'] === 'string') step.note = e['note'] as string;
  const fwRaw = e['fileWrite'];
  if (fwRaw !== undefined && fwRaw !== null) {
    if (typeof fwRaw !== 'object' || Array.isArray(fwRaw)) {
      throw new Error(`stepsJson[${index}].fileWrite must be an object.`);
    }
    const fw = fwRaw as Record<string, unknown>;
    if (typeof fw['path'] !== 'string') throw new Error(`stepsJson[${index}].fileWrite.path must be a string.`);
    if (fw['kind'] !== 'create' && fw['kind'] !== 'write' && fw['kind'] !== 'edit') {
      throw new Error(`stepsJson[${index}].fileWrite.kind is invalid.`);
    }
    if (typeof fw['content'] !== 'string') throw new Error(`stepsJson[${index}].fileWrite.content must be a string.`);
    if (fw['kind'] === 'edit' && typeof fw['oldText'] !== 'string') {
      throw new Error(`stepsJson[${index}].fileWrite.oldText is required for kind "edit".`);
    }
    step.fileWrite = {
      path: fw['path'] as string,
      kind: fw['kind'] as 'create' | 'write' | 'edit',
      content: fw['content'] as string,
      ...(typeof fw['oldText'] === 'string' ? { oldText: fw['oldText'] as string } : {}),
    };
  }
  return step;
}

/** Validate một history entry JSON. */
function parseHistoryEntry(entry: unknown, index: number): V16HistoryEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`historyJson[${index}] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e['id'] !== 'string') throw new Error(`historyJson[${index}].id must be a string.`);
  if (!['user', 'model', 'tool', 'system', 'summary'].includes(e['role'] as string)) {
    throw new Error(`historyJson[${index}].role is invalid.`);
  }
  if (typeof e['text'] !== 'string') throw new Error(`historyJson[${index}].text must be a string.`);
  if (typeof e['tokens'] !== 'number' || (e['tokens'] as number) < 0) {
    throw new Error(`historyJson[${index}].tokens must be a non-negative number.`);
  }
  if (typeof e['seq'] !== 'number' || !Number.isInteger(e['seq'])) {
    throw new Error(`historyJson[${index}].seq must be an integer.`);
  }
  if (typeof e['at'] !== 'number') throw new Error(`historyJson[${index}].at must be a number.`);
  return {
    id: e['id'] as string,
    role: e['role'] as V16HistoryEntry['role'],
    text: e['text'] as string,
    tokens: e['tokens'] as number,
    seq: e['seq'] as number,
    at: e['at'] as number,
    ...(e['pinned'] === true ? { pinned: true } : {}),
    ...(typeof e['toolName'] === 'string' ? { toolName: e['toolName'] as string } : {}),
  };
}

/** Đường dẫn file budgets.json / costs.json trong data dir. */
function budgetsFile(dataDir: string): string {
  return path.join(dataDir, 'budgets.json');
}

function costsFile(dataDir: string): string {
  return path.join(dataDir, 'costs.json');
}

interface BudgetsStore {
  budgets: V16TokenBudget[];
  samples: V16TokenSample[];
}

function loadBudgets(dataDir: string): BudgetsStore {
  const stored = readJsonFile<Partial<BudgetsStore>>(budgetsFile(dataDir), {});
  return {
    budgets: Array.isArray(stored.budgets) ? stored.budgets : [],
    samples: Array.isArray(stored.samples) ? stored.samples : [],
  };
}

function saveBudgets(dataDir: string, store: BudgetsStore): void {
  writeJsonFile(budgetsFile(dataDir), store);
}

export function createCodingV16Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: CodingV16ToolOptions = {},
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
    if (base) return codingV16EnsureDataDir(base);
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) {
      return codingV16EnsureDataDir(path.join(ctx.workspaceDir, '.open-bot'));
    }
    const fallback = toolOptions.getWorkspaceDir?.();
    if (typeof fallback === 'string' && fallback.trim().length > 0) {
      return codingV16EnsureDataDir(path.join(fallback, '.open-bot'));
    }
    return codingV16EnsureDataDir(path.join(os.tmpdir(), 'open-bot-coding-v16'));
  };

  const resolveWorkspaceDir = (ctx: ToolContext): string => {
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) return ctx.workspaceDir;
    const dir = toolOptions.getWorkspaceDir?.();
    if (typeof dir === 'string' && dir.trim().length > 0) return dir;
    const base = resolveBase();
    return base ? path.join(base, 'coding-v16-workspace') : path.join(os.tmpdir(), 'open-bot-coding-v16-workspace');
  };

  /** Mở meter từ budgets.json (sample + budget đã lưu). */
  const openMeter = (dataDir: string): TokenBudgetMeter => {
    const meter = new TokenBudgetMeter();
    const store = loadBudgets(dataDir);
    for (const b of store.budgets) {
      try {
        meter.setBudget(b);
      } catch {
        // Budget cũ lỗi thì bỏ qua, không chặn tool.
      }
    }
    for (const s of store.samples) {
      try {
        meter.record(s);
      } catch {
        // Sample cũ lỗi thì bỏ qua.
      }
    }
    return meter;
  };

  /** Lưu lại toàn bộ meter vào budgets.json. */
  const persistMeter = (dataDir: string, meter: TokenBudgetMeter): void => {
    const samples: V16TokenSample[] = [];
    for (const taskId of meter.taskIds()) samples.push(...meter.samples(taskId));
    saveBudgets(dataDir, { budgets: meter.listBudgets(), samples });
  };

  /** Mở estimator từ costs.json. */
  const openEstimator = (dataDir: string): HarnessCostEstimator => {
    const estimator = new HarnessCostEstimator();
    const records = readJsonFile<unknown[]>(costsFile(dataDir), []);
    for (const raw of records) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      if (
        typeof r['taskId'] !== 'string' ||
        typeof r['harnessId'] !== 'string' ||
        typeof r['model'] !== 'string' ||
        typeof r['score'] !== 'number'
      ) {
        continue;
      }
      try {
        estimator.record({
          taskId: r['taskId'] as string,
          harnessId: r['harnessId'] as string,
          model: r['model'] as string,
          score: r['score'] as number,
          promptTokens: (r['promptTokens'] as number) ?? 0,
          completionTokens: (r['completionTokens'] as number) ?? 0,
          steps: (r['steps'] as number) ?? 0,
          ...(typeof r['costUsd'] === 'number' ? { costUsd: r['costUsd'] as number } : {}),
          ...(typeof r['note'] === 'string' ? { note: r['note'] as string } : {}),
        });
      } catch {
        // Record cũ lỗi thì bỏ qua.
      }
    }
    return estimator;
  };

  const persistEstimator = (dataDir: string, estimator: HarnessCostEstimator): void => {
    writeJsonFile(costsFile(dataDir), estimator.allRecords());
  };

  const budgetTool: Tool = {
    definition: toolDef(
      'coding_v16_budget',
      'Token budget meter (v1.38): set a token budget for a task, record token usage samples, or check status (ok/warn/blocked + projected steps left). Budgets and samples persist in coding-v16/budgets.json.',
      {
        action: { type: 'string', description: '"set" (set budget) | "record" (record a usage sample) | "status" (check budget status) | "list" (list all budgets + session total).' },
        budgetId: { type: 'string', description: 'Budget id, e.g. "task-1" (default = taskId).' },
        taskId: { type: 'string', description: 'Task id the sample/status belongs to.' },
        limitTokens: { type: 'integer', description: 'Budget limit in tokens (action "set").' },
        warnAtPercent: { type: 'integer', description: 'Warn threshold percent (default 80).' },
        blockAtPercent: { type: 'integer', description: 'Block threshold percent (default 100).' },
        step: { type: 'integer', description: 'Step number of the sample (action "record").' },
        kind: { type: 'string', description: 'Sample kind: "preamble" | "model" | "tool" | "condense" | "retry".' },
        promptTokens: { type: 'integer', description: 'Prompt tokens of the sample.' },
        completionTokens: { type: 'integer', description: 'Completion tokens of the sample.' },
        model: { type: 'string', description: 'Model used for the sample.' },
        harness: { type: 'string', description: 'Harness used for the sample.' },
        note: { type: 'string', description: 'Note for the budget.' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const dataDir = resolveDataDir(ctx);
      try {
        const action = getStringArg(args, 'action', true);
        if (!['set', 'record', 'status', 'list'].includes(action)) {
          throw new Error(`Unknown action: "${action}" (expected set | record | status | list).`);
        }
        const meter = openMeter(dataDir);
        if (action === 'set') {
          const budgetId = getStringArg(args, 'budgetId') || getStringArg(args, 'taskId', true);
          const limitTokens = getIntArg(args, 'limitTokens');
          if (limitTokens === undefined) throw new Error('Missing required argument: "limitTokens".');
          const budget = meter.setBudget({
            id: budgetId,
            limitTokens,
            ...(getIntArg(args, 'warnAtPercent') !== undefined ? { warnAtPercent: getIntArg(args, 'warnAtPercent') } : {}),
            ...(getIntArg(args, 'blockAtPercent') !== undefined ? { blockAtPercent: getIntArg(args, 'blockAtPercent') } : {}),
            ...(getStringArg(args, 'note') !== '' ? { note: getStringArg(args, 'note') } : {}),
          });
          persistMeter(dataDir, meter);
          return JSON.stringify({ dataDir, budget }, null, 2);
        }
        if (action === 'record') {
          const taskId = getStringArg(args, 'taskId', true);
          const step = getIntArg(args, 'step') ?? 0;
          const kindRaw = getStringArg(args, 'kind') || 'model';
          if (!['preamble', 'model', 'tool', 'condense', 'retry'].includes(kindRaw)) {
            throw new Error(`Unknown kind: "${kindRaw}".`);
          }
          const promptTokens = getIntArg(args, 'promptTokens') ?? 0;
          const completionTokens = getIntArg(args, 'completionTokens') ?? 0;
          const sample = meter.record({
            taskId,
            step,
            kind: kindRaw as V16TokenSample['kind'],
            promptTokens,
            completionTokens,
            at: Date.now(),
            ...(getStringArg(args, 'model') !== '' ? { model: getStringArg(args, 'model') } : {}),
            ...(getStringArg(args, 'harness') !== '' ? { harness: getStringArg(args, 'harness') } : {}),
          });
          persistMeter(dataDir, meter);
          const budgetId = getStringArg(args, 'budgetId') || taskId;
          const status = meter.status(budgetId, taskId);
          return JSON.stringify(
            { dataDir, sample, total: meter.total(taskId), status, statusText: status ? renderV16BudgetStatus(status) : null },
            null,
            2,
          );
        }
        if (action === 'status') {
          const budgetId = getStringArg(args, 'budgetId') || getStringArg(args, 'taskId', true);
          const taskId = getStringArg(args, 'taskId') || budgetId;
          const status = meter.status(budgetId, taskId);
          if (!status) throw new Error(`No budget "${budgetId}" — set it first (action "set").`);
          return JSON.stringify(
            { dataDir, status, statusText: renderV16BudgetStatus(status), total: meter.total(taskId) },
            null,
            2,
          );
        }
        return JSON.stringify(
          { dataDir, budgets: meter.listBudgets(), statuses: meter.allStatuses(), sessionTotal: meter.sessionTotal() },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const costTool: Tool = {
    definition: toolDef(
      'coding_v16_cost',
      'Harness cost estimator (v1.38): record a finished task (score + tokens + harness + model) and get the cost/accuracy trade-off report — pass rate, $/task, score/$, tokens per pass, max cost ratio across harnesses. Cost records persist in coding-v16/costs.json.',
      {
        action: { type: 'string', description: '"record" (record a finished task) | "report" (cost/accuracy report) | "compare" (compare one harness).' },
        taskId: { type: 'string', description: 'Task id.' },
        harnessId: { type: 'string', description: 'Harness id, e.g. "minimal" | "claude-code" | "opencode" | "mini-swe-agent".' },
        model: { type: 'string', description: 'Model used, e.g. "claude-sonnet-4".' },
        score: { type: 'number', description: 'Task score 0..1 (1 = pass).' },
        promptTokens: { type: 'integer', description: 'Prompt tokens used.' },
        completionTokens: { type: 'integer', description: 'Completion tokens used.' },
        steps: { type: 'integer', description: 'Steps run.' },
        costUsd: { type: 'number', description: 'Optional explicit cost in USD (default = computed from the model price table).' },
        harnessIdsJson: { type: 'string', description: 'Optional JSON array of harness ids for the report (default = all recorded).' },
        note: { type: 'string', description: 'Note for the record.' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const dataDir = resolveDataDir(ctx);
      try {
        const action = getStringArg(args, 'action', true);
        if (!['record', 'report', 'compare'].includes(action)) {
          throw new Error(`Unknown action: "${action}" (expected record | report | compare).`);
        }
        const estimator = openEstimator(dataDir);
        if (action === 'record') {
          const taskId = getStringArg(args, 'taskId', true);
          const harnessId = getStringArg(args, 'harnessId', true);
          const model = getStringArg(args, 'model', true);
          const score = args['score'];
          if (typeof score !== 'number' || score < 0 || score > 1) {
            throw new Error('Argument "score" must be a number within [0, 1].');
          }
          const promptTokens = getIntArg(args, 'promptTokens') ?? 0;
          const completionTokens = getIntArg(args, 'completionTokens') ?? 0;
          const steps = getIntArg(args, 'steps') ?? 0;
          const costUsd = args['costUsd'];
          if (costUsd !== undefined && costUsd !== null && typeof costUsd !== 'number') {
            throw new Error('Argument "costUsd" must be a number.');
          }
          const record = estimator.record({
            taskId,
            harnessId,
            model,
            score,
            promptTokens,
            completionTokens,
            steps,
            ...(typeof costUsd === 'number' ? { costUsd } : {}),
            ...(getStringArg(args, 'note') !== '' ? { note: getStringArg(args, 'note') } : {}),
          });
          persistEstimator(dataDir, estimator);
          return JSON.stringify({ dataDir, record }, null, 2);
        }
        if (action === 'compare') {
          const harnessId = getStringArg(args, 'harnessId', true);
          const comparison = estimator.compare(harnessId);
          if (!comparison) throw new Error(`No cost records for harness "${harnessId}".`);
          return JSON.stringify({ dataDir, comparison }, null, 2);
        }
        const harnessIdsRaw = getStringArg(args, 'harnessIdsJson');
        let harnessIds: string[] | undefined;
        if (harnessIdsRaw !== '') {
          const parsed = parseJsonArrayArg(harnessIdsRaw, 'harnessIdsJson');
          if (!parsed.every((h) => typeof h === 'string')) {
            throw new Error('harnessIdsJson must be a JSON array of strings.');
          }
          harnessIds = parsed as string[];
        }
        const report = estimator.report(harnessIds);
        return JSON.stringify(
          { dataDir, summary: renderV16CostAccuracyReport(report), report },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const minimalTool: Tool = {
    definition: toolDef(
      'coding_v16_minimal',
      'Run the minimal harness (v1.38): a bash-only loop with a compact preamble (<1000 tokens) from a JSON script of steps. File writes go through the linter gate (blocked on syntax errors) and history auto-trims. No model is called — the script IS the model. Files are written for real in the workspace.',
      {
        runId: { type: 'string', description: 'Run id, e.g. "run-1".' },
        prompt: { type: 'string', description: 'Task prompt.' },
        stepsJson: { type: 'string', description: 'JSON array of V16MinimalStep objects.' },
        maxSteps: { type: 'integer', description: 'Max steps (default 20).' },
        maxPreambleTokens: { type: 'integer', description: 'Max preamble tokens (default 1000).' },
        budgetTokens: { type: 'integer', description: 'Optional hard token budget for the run.' },
        lintBeforeWrite: { type: 'boolean', description: 'true = lint-gate every file write (default true).' },
        score: { type: 'number', description: 'Optional task score 0..1 for the cost record (default 1 when done, else 0).' },
        model: { type: 'string', description: 'Model name for the cost record (default "claude-sonnet-4").' },
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
          parseMinimalStep(s, i),
        );
        const maxSteps = getIntArg(args, 'maxSteps');
        const maxPreambleTokens = getIntArg(args, 'maxPreambleTokens');
        const budgetTokens = getIntArg(args, 'budgetTokens');
        const lintBeforeWrite = getBoolArg(args, 'lintBeforeWrite');
        const score = args['score'];
        if (score !== undefined && score !== null && (typeof score !== 'number' || score < 0 || score > 1)) {
          throw new Error('Argument "score" must be a number within [0, 1].');
        }
        const model = getStringArg(args, 'model') || 'claude-sonnet-4';
        const meter = openMeter(dataDir);
        const estimator = openEstimator(dataDir);
        const files = new Map<string, string | null>();
        const fileApplier = (write: { path: string; kind: 'create' | 'write' | 'edit'; content: string; oldText?: string }, before: string | null): string => {
          const after = v16ApplyFileWrite(before, write);
          const abs = path.join(workspaceDir, write.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, after, 'utf8');
          return after;
        };
        // Nạp nội dung file hiện có từ workspace để edit/create kiểm tra đúng.
        for (const step of steps) {
          if (step.fileWrite) {
            const abs = path.join(workspaceDir, step.fileWrite.path);
            if (!files.has(step.fileWrite.path)) {
              files.set(step.fileWrite.path, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
            }
          }
        }
        const { report } = runV16Minimal({
          runId,
          prompt,
          steps,
          config: {
            ...(maxSteps !== undefined ? { maxSteps } : {}),
            ...(maxPreambleTokens !== undefined ? { maxPreambleTokens } : {}),
            ...(lintBeforeWrite !== undefined ? { lintBeforeWrite } : {}),
          },
          files,
          fileApplier,
          meter,
          ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        });
        persistMeter(dataDir, meter);
        const cost = estimator.record({
          taskId: runId,
          harnessId: 'minimal',
          model,
          score: typeof score === 'number' ? score : report.done ? 1 : 0,
          promptTokens: report.promptTokens,
          completionTokens: report.completionTokens,
          steps: report.stepsRun,
        });
        persistEstimator(dataDir, estimator);
        return JSON.stringify(
          { dataDir, workspaceDir, summary: renderV16MinimalReport(report), report, cost },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fileWindowTool: Tool = {
    definition: toolDef(
      'coding_v16_file_window',
      'View a file in 100-line windows (v1.38): paginate a large file instead of dumping it whole. Actions: "page" (one numbered window), "around" (window containing a line), "centered" (window centered on a line), "search" (find a string, return line + page).',
      {
        filePath: { type: 'string', description: 'Path relative to the workspace, e.g. "src/auth.ts".' },
        action: { type: 'string', description: '"page" (default) | "around" | "centered" | "search".' },
        page: { type: 'integer', description: 'Page number (1-based) for action "page".' },
        line: { type: 'integer', description: 'Line number (1-based) for actions "around" / "centered".' },
        windowLines: { type: 'integer', description: 'Lines per window (default 100).' },
        query: { type: 'string', description: 'Search string for action "search".' },
        caseInsensitive: { type: 'boolean', description: 'true = case-insensitive search (default false).' },
        maxHits: { type: 'integer', description: 'Max search hits (default 50).' },
      },
      ['filePath'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workspaceDir = resolveWorkspaceDir(ctx);
      try {
        const filePath = getStringArg(args, 'filePath', true);
        const action = getStringArg(args, 'action') || 'page';
        if (!['page', 'around', 'centered', 'search'].includes(action)) {
          throw new Error(`Unknown action: "${action}" (expected page | around | centered | search).`);
        }
        const abs = path.join(workspaceDir, filePath);
        if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);
        const content = fs.readFileSync(abs, 'utf8');
        const windowLines = getIntArg(args, 'windowLines') ?? 100;
        if (action === 'search') {
          const query = getStringArg(args, 'query', true);
          const hits = v16SearchInFile(content, query, {
            caseInsensitive: getBoolArg(args, 'caseInsensitive') ?? false,
            maxHits: getIntArg(args, 'maxHits') ?? 50,
            windowLines,
          });
          return JSON.stringify({ workspaceDir, filePath, query, hits }, null, 2);
        }
        if (action === 'around' || action === 'centered') {
          const line = getIntArg(args, 'line');
          if (line === undefined) throw new Error(`Missing required argument: "line" for action "${action}".`);
          const window = action === 'around'
            ? v16WindowAroundLine(filePath, content, line, windowLines)
            : v16WindowCenteredOnLine(filePath, content, line, windowLines);
          return JSON.stringify({ workspaceDir, window, rendered: renderV16FileWindow(window) }, null, 2);
        }
        const page = getIntArg(args, 'page') ?? 1;
        const window = v16GetWindow(filePath, content, page, windowLines);
        return JSON.stringify({ workspaceDir, window, rendered: renderV16FileWindow(window) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const lintEditTool: Tool = {
    definition: toolDef(
      'coding_v16_lint_edit',
      'Lint-gated file edit (v1.38): check the new content for syntax errors first (unbalanced delimiters, invalid JSON, unclosed tags/strings/comments, bad YAML/Python indent). BLOCKED on errors — the file is not written. Warnings still allow the write.',
      {
        filePath: { type: 'string', description: 'Path relative to the workspace, e.g. "src/auth.ts".' },
        content: { type: 'string', description: 'Full new content of the file.' },
        dryRun: { type: 'boolean', description: 'true = only lint, do not write (default false).' },
      },
      ['filePath', 'content'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const workspaceDir = resolveWorkspaceDir(ctx);
      try {
        const filePath = getStringArg(args, 'filePath', true);
        const content = getStringArg(args, 'content', true);
        const dryRun = getBoolArg(args, 'dryRun') ?? false;
        const result = v16LintContent(filePath, content);
        if (result.blocked) {
          return JSON.stringify(
            { workspaceDir, filePath, written: false, summary: renderV16LintResult(result), lint: result },
            null,
            2,
          );
        }
        if (!dryRun) {
          const abs = path.join(workspaceDir, filePath);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf8');
        }
        return JSON.stringify(
          { workspaceDir, filePath, written: !dryRun, summary: renderV16LintResult(result), lint: result },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const trimTool: Tool = {
    definition: toolDef(
      'coding_v16_trim',
      'Auto-trim conversation/task history (v1.38): cut history JSON down to a token budget, always keeping pinned entries, the 5 most recent tool outputs and the most recent entries; the trimmed part is replaced by one short summary entry.',
      {
        historyJson: { type: 'string', description: 'JSON array of V16HistoryEntry objects.' },
        maxTokens: { type: 'integer', description: 'Token budget for the kept history (default 8000).' },
        keepRecentToolOutputs: { type: 'integer', description: 'Recent tool outputs to keep (default 5).' },
        keepRecentEntries: { type: 'integer', description: 'Recent model/user entries to keep (default 4).' },
        summarizeTrimmed: { type: 'boolean', description: 'true = replace trimmed part with a summary entry (default true).' },
        summaryMaxTokens: { type: 'integer', description: 'Max tokens of the summary entry (default 300).' },
      },
      ['historyJson'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const entries = parseJsonArrayArg(getStringArg(args, 'historyJson', true), 'historyJson').map((e, i) =>
          parseHistoryEntry(e, i),
        );
        const policy: V16TrimPolicy = {
          maxTokens: getIntArg(args, 'maxTokens') ?? 8000,
          ...(getIntArg(args, 'keepRecentToolOutputs') !== undefined
            ? { keepRecentToolOutputs: getIntArg(args, 'keepRecentToolOutputs') }
            : {}),
          ...(getIntArg(args, 'keepRecentEntries') !== undefined
            ? { keepRecentEntries: getIntArg(args, 'keepRecentEntries') }
            : {}),
          ...(getBoolArg(args, 'summarizeTrimmed') !== undefined
            ? { summarizeTrimmed: getBoolArg(args, 'summarizeTrimmed') }
            : {}),
          ...(getIntArg(args, 'summaryMaxTokens') !== undefined
            ? { summaryMaxTokens: getIntArg(args, 'summaryMaxTokens') }
            : {}),
        };
        const { kept, result } = v16TrimHistory(entries, policy);
        return JSON.stringify(
          { summary: renderV16TrimResult(result), result, kept },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const benchmarkTool: Tool = {
    definition: toolDef(
      'coding_v16_benchmark',
      'Internal benchmark (v1.38): run scripted sample tasks through several harnesses (same task, different harness scripts) and report the cost/accuracy trade-off — pass rate vs $/task, score/$, max cost ratio. No model is called; task scripts ARE the model.',
      {
        tasksJson: { type: 'string', description: 'JSON array of V16BenchmarkTask objects (id, prompt, scripts per harness, expectedScore).' },
        harnessIdsJson: { type: 'string', description: 'Optional JSON array of harness ids to measure (default = all in the tasks).' },
        model: { type: 'string', description: 'Model name for pricing (default "claude-sonnet-4").' },
        note: { type: 'string', description: 'Note for the cost records (e.g. "rerun-2").' },
      },
      ['tasksJson'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const dataDir = resolveDataDir(ctx);
      try {
        const tasks = parseJsonArrayArg(getStringArg(args, 'tasksJson', true), 'tasksJson').map((t, i) =>
          v16ValidateBenchmarkTask(t, i),
        );
        const harnessIdsRaw = getStringArg(args, 'harnessIdsJson');
        let harnessIds: string[] | undefined;
        if (harnessIdsRaw !== '') {
          const parsed = parseJsonArrayArg(harnessIdsRaw, 'harnessIdsJson');
          if (!parsed.every((h) => typeof h === 'string')) {
            throw new Error('harnessIdsJson must be a JSON array of strings.');
          }
          harnessIds = parsed as string[];
        }
        const model = getStringArg(args, 'model') || 'claude-sonnet-4';
        const estimator = openEstimator(dataDir);
        const report = runV16Benchmark({
          tasks,
          ...(harnessIds ? { harnessIds } : {}),
          model,
          estimator,
          ...(getStringArg(args, 'note') !== '' ? { note: getStringArg(args, 'note') } : {}),
        });
        persistEstimator(dataDir, estimator);
        return JSON.stringify(
          { dataDir, summary: renderV16BenchmarkReport(report), report },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [budgetTool, costTool, minimalTool, fileWindowTool, lintEditTool, trimTool, benchmarkTool];
}

/** Placeholder tools (chưa bind base dir) — dùng trong ALL_TOOLS. */
export const CODING_V16_TOOLS: Tool[] = createCodingV16Tools();

/** Đảm bảo base dir có thư mục dữ liệu v16 (dùng khi host bind). */
export function codingV16EnsureBaseDir(baseDir: string): string {
  return codingV16EnsureDataDir(baseDir);
}
