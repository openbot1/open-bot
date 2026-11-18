/**
 * Eval Harness v3 — decision tracing (v1.35, Đội T4).
 *
 * Ghi lại từng bước đánh giá của một trial thành các span (trial →
 * materialize → base-test → guardrail → executor → agent-command →
 * test → score → gate) để truy vết vì sao một trial pass/fail/trip/
 * timeout: mở trace ra là thấy bước nào fail, guardrail nào trip,
 * test nào flaky, lệnh nào timeout — không cần chạy lại trial.
 *
 * - Trace lưu trong RAM trong lúc chạy; runner gom trace của trial
 *   vào `EvalHarnessV3TrialResult.traceId` và tool `trace` export ra
 *   file JSONL (`<baseDir>/eval-harness-v3-traces/<runId>.jsonl`).
 * - Secret bị redact trước khi ghi attribute: mọi giá trị khớp mẫu
 *   secret/PII đều thay bằng `[REDACTED]` — trace an toàn để chia sẻ.
 * - Span lồng nhau qua parentSpanId; span gốc luôn là kind `trial`.
 * - Không gọi mạng, không phụ thuộc OTel runtime — trace v3 là dữ
 *   liệu thuần, có thể nối `otelTraceId` của repo khi cần.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EVAL_HARNESS_V3_SECRET_PATTERNS,
  EVAL_HARNESS_V3_PII_PATTERNS,
} from './guardrails.js';
import type {
  EvalHarnessV3SpanKind,
  EvalHarnessV3Trace,
  EvalHarnessV3TraceSpan,
  EvalHarnessV3TrialStatus,
} from './types.js';

/** Độ dài tối đa của một attribute string trong trace. */
export const EVAL_HARNESS_V3_TRACE_MAX_ATTR_CHARS = 500;

/** Mẫu redact thêm cho trace (token/secret dạng key=value). */
const TRACE_REDACT_PATTERNS: readonly RegExp[] = [
  /(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*['"]?[^\s'";,}]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/g,
  /Basic\s+[A-Za-z0-9+/=]+/g,
];

/** Redact secret/PII khỏi một chuỗi trước khi ghi trace. */
export function redactTraceText(text: string): string {
  let out = text;
  for (const { pattern } of EVAL_HARNESS_V3_SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED-SECRET]');
  }
  for (const { pattern } of EVAL_HARNESS_V3_PII_PATTERNS) {
    out = out.replace(pattern, '[REDACTED-PII]');
  }
  for (const re of TRACE_REDACT_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

/** Cắt ngắn + redact một attribute string. */
function cleanAttribute(value: string): string {
  const redacted = redactTraceText(value);
  if (redacted.length <= EVAL_HARNESS_V3_TRACE_MAX_ATTR_CHARS) return redacted;
  return `${redacted.slice(0, EVAL_HARNESS_V3_TRACE_MAX_ATTR_CHARS)}...[truncated]`;
}

/** Tạo id ngắn (8 hex) cho span/trace. */
function shortId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/** Tạo trace id cho một trial. */
export function newEvalTraceId(trialId: string): string {
  return `${trialId}-${shortId()}`;
}

/** Một span đang mở (đo thời gian) trong TraceBuilder. */
interface OpenSpan {
  span: EvalHarnessV3TraceSpan;
}

/**
 * Builder ghi trace cho một trial: `startSpan` mở span, `endSpan`
 * đóng span với status, `finish` trả về trace hoàn chỉnh. Builder
 * không throw — span lỗi vẫn ghi được.
 */
export class EvalHarnessV3TraceBuilder {
  readonly traceId: string;
  readonly trialId: string;
  readonly taskId: string;
  readonly trialIndex: number;
  private readonly startedAt: number;
  private readonly spans: EvalHarnessV3TraceSpan[] = [];
  private readonly open = new Map<string, OpenSpan>();
  private rootSpanId: string | undefined;

  constructor(taskId: string, trialId: string, trialIndex: number) {
    this.taskId = taskId;
    this.trialId = trialId;
    this.trialIndex = trialIndex;
    this.traceId = newEvalTraceId(trialId);
    this.startedAt = Date.now();
  }

  /** Mở một span con (trả về spanId để đóng sau). */
  startSpan(
    kind: EvalHarnessV3SpanKind,
    name: string,
    parentSpanId?: string,
    attributes?: Record<string, string | number | boolean>,
  ): string {
    const spanId = `${kind}-${shortId()}`;
    const parent = parentSpanId ?? this.rootSpanId;
    const span: EvalHarnessV3TraceSpan = {
      spanId,
      ...(parent !== undefined ? { parentSpanId: parent } : {}),
      kind,
      name,
      startedAt: Date.now(),
      durationMs: 0,
      status: 'info',
      ...(attributes !== undefined ? { attributes: this.cleanAttributes(attributes) } : {}),
    };
    if (kind === 'trial' && this.rootSpanId === undefined) {
      this.rootSpanId = spanId;
    }
    this.open.set(spanId, { span });
    return spanId;
  }

  /** Đóng một span với status + ghi chú (không throw khi span không có). */
  endSpan(
    spanId: string,
    status: EvalHarnessV3TraceSpan['status'],
    note?: string,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    const entry = this.open.get(spanId);
    if (entry === undefined) return;
    this.open.delete(spanId);
    entry.span.durationMs = Date.now() - entry.span.startedAt;
    entry.span.status = status;
    if (note !== undefined) entry.span.note = cleanAttribute(note);
    if (attributes !== undefined) {
      entry.span.attributes = {
        ...(entry.span.attributes ?? {}),
        ...this.cleanAttributes(attributes),
      };
    }
    this.spans.push(entry.span);
  }

  /** Ghi một span đã xong ngay (không cần mở/đóng riêng). */
  recordSpan(
    kind: EvalHarnessV3SpanKind,
    name: string,
    status: EvalHarnessV3TraceSpan['status'],
    durationMs: number,
    parentSpanId?: string,
    note?: string,
    attributes?: Record<string, string | number | boolean>,
  ): string {
    const spanId = `${kind}-${shortId()}`;
    const parent = parentSpanId ?? this.rootSpanId;
    const span: EvalHarnessV3TraceSpan = {
      spanId,
      ...(parent !== undefined ? { parentSpanId: parent } : {}),
      kind,
      name,
      startedAt: Date.now() - durationMs,
      durationMs,
      status,
      ...(note !== undefined ? { note: cleanAttribute(note) } : {}),
      ...(attributes !== undefined ? { attributes: this.cleanAttributes(attributes) } : {}),
    };
    this.spans.push(span);
    return spanId;
  }

  private cleanAttributes(
    attributes: Record<string, string | number | boolean>,
  ): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(attributes)) {
      out[key] = typeof value === 'string' ? cleanAttribute(value) : value;
    }
    return out;
  }

  /** Đóng mọi span còn mở (khi trial kết thúc bất thường) rồi trả trace. */
  finish(outcome: EvalHarnessV3TrialStatus): EvalHarnessV3Trace {
    const finishedAt = Date.now();
    for (const [spanId, entry] of [...this.open.entries()]) {
      this.open.delete(spanId);
      entry.span.durationMs = finishedAt - entry.span.startedAt;
      if (entry.span.status === 'info') entry.span.status = 'cancelled';
      this.spans.push(entry.span);
    }
    // Span sắp xếp theo thời gian bắt đầu để đọc xuôi như timeline.
    this.spans.sort((a, b) => a.startedAt - b.startedAt);
    return {
      traceId: this.traceId,
      trialId: this.trialId,
      taskId: this.taskId,
      trialIndex: this.trialIndex,
      startedAt: this.startedAt,
      finishedAt,
      outcome,
      spans: [...this.spans],
    };
  }
}

/** Tóm tắt một trace thành một dòng (để log / list). */
export function summarizeEvalTrace(trace: EvalHarnessV3Trace): string {
  const byStatus = new Map<string, number>();
  for (const span of trace.spans) {
    byStatus.set(span.status, (byStatus.get(span.status) ?? 0) + 1);
  }
  const parts = [...byStatus.entries()].map(([status, count]) => `${status}:${count}`).join(' ');
  return `${trace.trialId} ${trace.outcome} ${trace.finishedAt - trace.startedAt}ms spans=${trace.spans.length} ${parts}`;
}

/** Render trace thành text timeline đọc được. */
export function renderEvalTraceText(trace: EvalHarnessV3Trace): string {
  const lines: string[] = [
    `Trace ${trace.traceId} — trial ${trace.trialId} (${trace.taskId}) → ${trace.outcome}`,
    `  started ${new Date(trace.startedAt).toISOString()}, duration ${trace.finishedAt - trace.startedAt}ms, spans ${trace.spans.length}`,
  ];
  for (const span of trace.spans) {
    const offset = span.startedAt - trace.startedAt;
    lines.push(
      `  +${offset}ms [${span.kind}] ${span.name} — ${span.status} (${span.durationMs}ms)${span.note !== undefined ? ` — ${span.note}` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Thư mục trace mặc định trong baseDir của app. */
export function defaultEvalHarnessV3TracesDir(baseDir: string): string {
  return path.join(baseDir, 'eval-harness-v3-traces');
}

/** Ghi một trace thành một dòng JSONL (append, mode 0600 khi tạo file mới). */
export function appendEvalTraceToFile(tracesDir: string, runId: string, trace: EvalHarnessV3Trace): string {
  fs.mkdirSync(tracesDir, { recursive: true });
  const filePath = path.join(tracesDir, `${runId}.jsonl`);
  const isNew = !fs.existsSync(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(trace)}\n`, 'utf8');
  if (isNew) {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // chmod fail trên Windows — không chặn ghi trace.
    }
  }
  return filePath;
}

/** Đọc toàn bộ trace của một run từ file JSONL (bỏ dòng lỗi). */
export function readEvalTracesFromFile(filePath: string): EvalHarnessV3Trace[] {
  if (!fs.existsSync(filePath)) return [];
  const traces: EvalHarnessV3Trace[] = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      traces.push(JSON.parse(trimmed) as EvalHarnessV3Trace);
    } catch {
      // Dòng hỏng (ghi dở do crash) — bỏ qua, không fail cả file.
    }
  }
  return traces;
}

/** Lọc span theo kind trong một trace. */
export function filterTraceSpans(
  trace: EvalHarnessV3Trace,
  kind: EvalHarnessV3SpanKind,
): EvalHarnessV3TraceSpan[] {
  return trace.spans.filter((s) => s.kind === kind);
}

/** Đếm số span fail/trip/timeout trong trace (để gate/report dùng nhanh). */
export function countTraceProblems(trace: EvalHarnessV3Trace): { fail: number; trip: number; timeout: number; error: number } {
  const out = { fail: 0, trip: 0, timeout: 0, error: 0 };
  for (const span of trace.spans) {
    if (span.status === 'fail') out.fail += 1;
    else if (span.status === 'trip') out.trip += 1;
    else if (span.status === 'timeout') out.timeout += 1;
    else if (span.status === 'error') out.error += 1;
  }
  return out;
}
