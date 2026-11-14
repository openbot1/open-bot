/**
 * Run metrics v2 — cost/latency per run/model/tool (v1.04, Team T6).
 *
 * Telemetry v1 (`observability/cost.ts`, `observability/otel.ts`) chỉ
 * ước tính cost cho một span/trace đơn lẻ và export OTel ra file
 * local. Module này là lớp aggregate còn thiếu:
 *
 * - `recordRunMetric` ghi một lần đo (một model call, một tool call,
 *   hoặc cả run) vào `<baseDir>/run-metrics.jsonl` (append, không ghi
 *   đè; mỗi dòng là một JSON record).
 * - `aggregateRunMetrics` là pure aggregation trên list record: tổng
 *   hợp theo run, theo model, theo tool — kèm mean/p95 latency, tổng
 *   token, tổng cost (qua `estimateCostDetailed`; model không có giá
 *   thì cost null, liệt kê riêng, không bịa giá).
 * - Record không chứa prompt/completion text — chỉ số đo (runId,
 *   model, tool, duration, token, cost, status). Telemetry không bao
 *   giờ mang nội dung hội thoại.
 *
 * Caller tự quyết định ghi metric ở đâu (agent loop, tool runner...);
 * module này chỉ là sổ ghi + aggregate, không hook vào loop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { estimateCostDetailed } from './cost';
import { percentile } from './benchmark';

/** File JSONL lưu metric. */
export const RUN_METRICS_FILE = 'run-metrics.jsonl';

/** Loại đo: một model call, một tool call, hay toàn bộ run. */
export type RunMetricKind = 'model-call' | 'tool-call' | 'run';

export const RUN_METRIC_KINDS: readonly RunMetricKind[] = ['model-call', 'tool-call', 'run'];

/** Trạng thái của lần đo. */
export type RunMetricStatus = 'ok' | 'error' | 'cancelled';

export const RUN_METRIC_STATUSES: readonly RunMetricStatus[] = ['ok', 'error', 'cancelled'];

/** Một lần đo cost/latency. */
export interface RunMetric {
  /** Id run (nhiều metric cùng runId = cùng một lần chạy bot). */
  runId: string;
  /** Bot chạy metric này. */
  botId: string;
  kind: RunMetricKind;
  /** Model (cho model-call/run) — null khi đo tool-call không gắn model. */
  model: string | null;
  /** Tool (cho tool-call) — null khi đo model-call/run. */
  tool: string | null;
  /** Thời gian (ms, >= 0). */
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, null khi model không có giá (hoặc không có model). */
  costUsd: number | null;
  status: RunMetricStatus;
  /** Lỗi ngắn (khi status = error). */
  error?: string;
  /** Epoch ms lúc ghi. */
  at: number;
}

/** Đầu vào ghi metric (cost tự tính từ model + token). */
export interface RecordRunMetricInput {
  runId: string;
  botId: string;
  kind: RunMetricKind;
  model?: string | null;
  tool?: string | null;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  status?: RunMetricStatus;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Validate đầu vào ghi metric (throw khi sai). */
export function validateRunMetricInput(raw: unknown): RecordRunMetricInput {
  if (!isRecord(raw)) throw new Error('run metric must be an object.');
  const { runId, botId, kind, model, tool, durationMs, inputTokens, outputTokens, status, error } = raw;
  if (typeof runId !== 'string' || runId.trim().length === 0) throw new Error('run metric needs a non-empty runId.');
  if (typeof botId !== 'string' || botId.trim().length === 0) throw new Error('run metric needs a non-empty botId.');
  if (!RUN_METRIC_KINDS.includes(kind as RunMetricKind)) throw new Error(`run metric kind must be one of: ${RUN_METRIC_KINDS.join(', ')}.`);
  if (model !== undefined && model !== null && (typeof model !== 'string' || model.trim().length === 0)) {
    throw new Error('run metric model must be a non-empty string or null.');
  }
  if (tool !== undefined && tool !== null && (typeof tool !== 'string' || tool.trim().length === 0)) {
    throw new Error('run metric tool must be a non-empty string or null.');
  }
  if (kind === 'tool-call' && (tool === undefined || tool === null)) {
    throw new Error('run metric of kind tool-call needs a tool name.');
  }
  if (kind === 'model-call' && (model === undefined || model === null)) {
    throw new Error('run metric of kind model-call needs a model name.');
  }
  if (!isNonNegativeFinite(durationMs)) throw new Error('run metric durationMs must be a finite number >= 0.');
  if (inputTokens !== undefined && !isNonNegativeFinite(inputTokens)) throw new Error('run metric inputTokens must be a finite number >= 0.');
  if (outputTokens !== undefined && !isNonNegativeFinite(outputTokens)) throw new Error('run metric outputTokens must be a finite number >= 0.');
  if (status !== undefined && !RUN_METRIC_STATUSES.includes(status as RunMetricStatus)) {
    throw new Error(`run metric status must be one of: ${RUN_METRIC_STATUSES.join(', ')}.`);
  }
  if (error !== undefined && typeof error !== 'string') throw new Error('run metric error must be a string.');
  return {
    runId: runId.trim(),
    botId: botId.trim(),
    kind: kind as RunMetricKind,
    ...(model !== undefined ? { model } : {}),
    ...(tool !== undefined ? { tool } : {}),
    durationMs,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(status !== undefined ? { status: status as RunMetricStatus } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/** Tính cost cho một lần đo (null khi không có model hoặc model không có giá). */
export function costOfRunMetric(input: Pick<RecordRunMetricInput, 'model' | 'inputTokens' | 'outputTokens'>): number | null {
  const model = input.model ?? null;
  if (model === null) return null;
  return estimateCostDetailed(model, input.inputTokens ?? 0, input.outputTokens ?? 0).costUsd;
}

/** Đường dẫn file metric. */
export function getRunMetricsPath(baseDir: string): string {
  return path.join(baseDir, RUN_METRICS_FILE);
}

/** Ghi một metric (append JSONL, tạo thư mục khi cần). Trả về record đã ghi. */
export function recordRunMetric(baseDir: string, input: RecordRunMetricInput, at = Date.now()): RunMetric {
  const valid = validateRunMetricInput(input);
  const metric: RunMetric = {
    runId: valid.runId,
    botId: valid.botId,
    kind: valid.kind,
    model: valid.model ?? null,
    tool: valid.tool ?? null,
    durationMs: valid.durationMs,
    inputTokens: valid.inputTokens ?? 0,
    outputTokens: valid.outputTokens ?? 0,
    costUsd: costOfRunMetric(valid),
    status: valid.status ?? 'ok',
    ...(valid.error !== undefined ? { error: valid.error } : {}),
    at,
  };
  const filePath = getRunMetricsPath(baseDir);
  fs.mkdirSync(baseDir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(metric)}\n`, 'utf8');
  return metric;
}

/** Parse một dòng JSONL thành metric (null khi dòng hỏng — caller bỏ qua). */
export function parseRunMetricLine(line: string): RunMetric | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  try {
    const valid = validateRunMetricInput(parsed);
    return {
      runId: valid.runId,
      botId: valid.botId,
      kind: valid.kind,
      model: valid.model ?? null,
      tool: valid.tool ?? null,
      durationMs: valid.durationMs,
      inputTokens: valid.inputTokens ?? 0,
      outputTokens: valid.outputTokens ?? 0,
      costUsd: costOfRunMetric(valid),
      status: valid.status ?? 'ok',
      ...(valid.error !== undefined ? { error: valid.error } : {}),
      at: typeof parsed.at === 'number' ? parsed.at : Date.now(),
    };
  } catch {
    return null;
  }
}

/** Đọc toàn bộ metric (dòng hỏng bị bỏ qua, không làm fail cả file). */
export function readRunMetrics(baseDir: string, limit = 10000): RunMetric[] {
  const filePath = getRunMetricsPath(baseDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: RunMetric[] = [];
  for (const line of raw.split('\n')) {
    const metric = parseRunMetricLine(line);
    if (metric) out.push(metric);
    if (out.length >= limit) break;
  }
  return out;
}

/** Aggregate của một nhóm metric (theo run / model / tool). */
export interface RunMetricGroupSummary {
  /** Key nhóm: runId, model, hoặc tool. */
  key: string;
  count: number;
  errors: number;
  totalDurationMs: number;
  meanDurationMs: number | null;
  p95DurationMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Tổng USD (null khi không record nào có giá). */
  totalCostUsd: number | null;
  /** True khi có record không có giá (cost chưa đầy đủ). */
  costIncomplete: boolean;
}

function summarizeGroup(key: string, metrics: RunMetric[]): RunMetricGroupSummary {
  const durations = metrics.map((m) => m.durationMs).sort((a, b) => a - b);
  const priced = metrics.filter((m) => m.costUsd !== null);
  return {
    key,
    count: metrics.length,
    errors: metrics.filter((m) => m.status === 'error').length,
    totalDurationMs: metrics.reduce((s, m) => s + m.durationMs, 0),
    meanDurationMs: metrics.length === 0 ? null : metrics.reduce((s, m) => s + m.durationMs, 0) / metrics.length,
    p95DurationMs: percentile(durations, 95),
    totalInputTokens: metrics.reduce((s, m) => s + m.inputTokens, 0),
    totalOutputTokens: metrics.reduce((s, m) => s + m.outputTokens, 0),
    totalCostUsd: priced.length === 0 ? null : priced.reduce((s, m) => s + (m.costUsd as number), 0),
    costIncomplete: priced.length < metrics.length,
  };
}

/** Aggregate đầy đủ trên một list metric (pure). */
export interface RunMetricsAggregate {
  totalRecords: number;
  totalRuns: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Tổng USD (null khi không record nào có giá). */
  totalCostUsd: number | null;
  /** Model không có giá (cost chưa đầy đủ). */
  unknownCostModels: string[];
  errors: number;
  byRun: RunMetricGroupSummary[];
  byModel: RunMetricGroupSummary[];
  byTool: RunMetricGroupSummary[];
}

export function aggregateRunMetrics(metrics: RunMetric[]): RunMetricsAggregate {
  const groupBy = (keyFn: (m: RunMetric) => string | null): RunMetricGroupSummary[] => {
    const groups = new Map<string, RunMetric[]>();
    for (const metric of metrics) {
      const key = keyFn(metric);
      if (key === null) continue;
      const list = groups.get(key) ?? [];
      list.push(metric);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([key, list]) => summarizeGroup(key, list))
      .sort((a, b) => b.totalDurationMs - a.totalDurationMs);
  };
  const priced = metrics.filter((m) => m.costUsd !== null);
  const unknownCostModels = [...new Set(metrics.filter((m) => m.model !== null && m.costUsd === null).map((m) => m.model as string))].sort();
  return {
    totalRecords: metrics.length,
    totalRuns: new Set(metrics.map((m) => m.runId)).size,
    totalDurationMs: metrics.reduce((s, m) => s + m.durationMs, 0),
    totalInputTokens: metrics.reduce((s, m) => s + m.inputTokens, 0),
    totalOutputTokens: metrics.reduce((s, m) => s + m.outputTokens, 0),
    totalCostUsd: priced.length === 0 ? null : priced.reduce((s, m) => s + (m.costUsd as number), 0),
    unknownCostModels,
    errors: metrics.filter((m) => m.status === 'error').length,
    byRun: groupBy((m) => m.runId),
    byModel: groupBy((m) => m.model),
    byTool: groupBy((m) => m.tool),
  };
}

/** Đọc file rồi aggregate (tiện cho UI/CLI). */
export function summarizeRunMetricsFile(baseDir: string, limit = 10000): RunMetricsAggregate {
  return aggregateRunMetrics(readRunMetrics(baseDir, limit));
}
