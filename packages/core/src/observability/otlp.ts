/**
 * OTLP export v2 — OpenTelemetry Protocol over HTTP/JSON (v1.04, Team T6).
 *
 * Telemetry v1 (`observability/otel.ts`) chỉ convert trace sang shape
 * OTel JSON rồi append vào file local — không bao giờ gửi đi đâu.
 * Module này thêm bước gửi thật, nhưng giữ nguyên posture local-first:
 *
 * - **Tắt mặc định**: `enabled` mặc định false. Không có config tường
 *   minh thì `exportTracesOtlp` trả về `{ sent: false, reason:
 *   'disabled' }` mà không chạm mạng.
 * - **Chỉ loopback / LAN riêng**: endpoint phải là http(s) và host
 *   phải là loopback (127.0.0.1 / ::1 / localhost) hoặc IP LAN riêng
 *   (10/8, 172.16/12, 192.168/16) hoặc hostname LAN (.local/.lan/
 *   .home, hoặc không có dấu chấm). Host công khai bị từ chối
 *   fail-closed — telemetry không bao giờ tự gửi ra internet.
 * - **OTLP/HTTP JSON**: `POST <endpoint>/v1/traces` với
 *   `Content-Type: application/json`, body là `{ resourceSpans }`
 *   theo đúng OTLP/HTTP JSON (path `/v1/traces` được append tự động
 *   khi endpoint chưa có; endpoint đã kết thúc bằng `/v1/traces`
 *   thì dùng nguyên). Timeout ngắn (mặc định 5s), không follow
 *   redirect (fetch mặc định follow — module này tự kiểm tra status
 *   3xx và coi là lỗi, không đuổi theo), không đọc env `OTEL_*`
 *   (chỉ config tường minh mới bật).
 * - Payload tái dùng `traceToOtel` có sẵn — không viết lại converter.
 * - Thêm `buildOtlpMetricsPayload`: gauge/counter OTLP từ aggregate
 *   của `runMetrics.ts` (tổng duration, token, cost theo model/tool)
 *   để collector local cũng nhận được số liệu cost/latency.
 *
 * Lưu ý: module này dùng `fetch` global (Node >= 18). Không phụ thuộc
 * thêm package nào (không gRPC — OTLP/HTTP JSON là đủ cho collector
 * local, và là lựa chọn đơn giản nhất theo OTLP docs).
 */

import type { Trace } from '../tracing/tracer';
import { traceToOtel, type OtelResourceSpan } from './otel';
import type { RunMetricsAggregate } from './runMetrics';

/** Cấu hình OTLP export. */
export interface OtlpConfig {
  /** Bật export (mặc định false — tắt thì không gửi gì cả). */
  enabled: boolean;
  /** Base URL của collector local (vd 'http://127.0.0.1:4318'). */
  endpoint?: string;
  /** Timeout cho mỗi request (ms, mặc định 5000). */
  timeoutMs?: number;
  /** Header thêm (vd Authorization khi collector local yêu cầu). */
  headers?: Record<string, string>;
}

export const DEFAULT_OTLP_TIMEOUT_MS = 5_000;
export const DEFAULT_OTLP_ENDPOINT = 'http://127.0.0.1:4318';

/** Kết quả một lần export. */
export interface OtlpExportResult {
  sent: boolean;
  /** Lý do khi không gửi (disabled / no-traces / invalid-config / error). */
  reason?: string;
  /** HTTP status khi đã gửi (undefined khi chưa gửi). */
  status?: number;
  /** Thông báo lỗi khi gửi thất bại. */
  error?: string;
  /** Số span đã gửi (0 khi chưa gửi). */
  spansSent: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True khi host là loopback. */
export function isOtlpLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/** True khi host là loopback hoặc IP/hostname LAN riêng (cho phép làm endpoint OTLP). */
export function isOtlpAllowedHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (isOtlpLoopbackHost(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (!h.includes('.')) return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.intranet')) return true;
  return false;
}

/**
 * Validate config OTLP (throw khi sai). Endpoint phải là http(s) và
 * host phải là loopback/LAN — host công khai bị từ chối.
 */
export function validateOtlpConfig(raw: unknown): OtlpConfig {
  if (!isRecord(raw)) throw new Error('otlp config must be an object.');
  const { enabled, endpoint, timeoutMs, headers } = raw;
  if (typeof enabled !== 'boolean') throw new Error('otlp config enabled must be a boolean.');
  if (endpoint !== undefined) {
    if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
      throw new Error('otlp endpoint must be a non-empty string when given.');
    }
    let url: URL;
    try {
      url = new URL(endpoint.trim());
    } catch {
      throw new Error(`otlp endpoint "${endpoint}" is not a valid URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('otlp endpoint must use http:// or https://.');
    }
    if (url.username !== '' || url.password !== '') {
      throw new Error('otlp endpoint must not contain credentials in the URL — use headers instead.');
    }
    if (!isOtlpAllowedHost(url.hostname)) {
      throw new Error(
        `otlp endpoint host "${url.hostname}" is not loopback or private LAN — telemetry is never sent to a public host.`,
      );
    }
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) {
    throw new Error('otlp timeoutMs must be a positive integer.');
  }
  if (headers !== undefined) {
    if (!isRecord(headers) || Object.values(headers).some((v) => typeof v !== 'string')) {
      throw new Error('otlp headers must be an object of string values.');
    }
  }
  return {
    enabled,
    ...(endpoint !== undefined ? { endpoint: endpoint.trim() } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
    ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
  };
}

/** URL đầy đủ cho signal traces: append /v1/traces khi endpoint chưa có. */
export function otlpTracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  if (base.endsWith('/v1/traces')) return base;
  return `${base}/v1/traces`;
}

/** URL đầy đủ cho signal metrics: append /v1/metrics khi endpoint chưa có. */
export function otlpMetricsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  if (base.endsWith('/v1/metrics')) return base;
  return `${base}/v1/metrics`;
}

/** Build payload OTLP/HTTP JSON cho traces từ danh sách Trace. */
export function buildOtlpTracesPayload(traces: Trace[]): { resourceSpans: OtelResourceSpan[] } {
  return { resourceSpans: traces.map((trace) => traceToOtel(trace)) };
}

/** Một metric OTLP (gauge) trong payload JSON. */
export interface OtlpMetric {
  name: string;
  description: string;
  unit: string;
  gauge: { dataPoints: Array<{ asDouble?: number; asInt?: string; attributes: Array<{ key: string; value: { stringValue: string } }> }> };
}

/** Build payload OTLP/HTTP JSON cho metrics từ aggregate của runMetrics. */
export function buildOtlpMetricsPayload(aggregate: RunMetricsAggregate): { resourceMetrics: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> }; scopeMetrics: Array<{ scope: { name: string; version: string }; metrics: OtlpMetric[] }> }> } {
  const metrics: OtlpMetric[] = [];
  const gauge = (name: string, description: string, unit: string, points: Array<{ value: number; attrs: Record<string, string> }>): OtlpMetric => ({
    name,
    description,
    unit,
    gauge: {
      dataPoints: points.map((p) => ({
        asDouble: p.value,
        attributes: Object.entries(p.attrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
      })),
    },
  });
  metrics.push(
    gauge('openbot.run.duration_ms', 'Total run duration in milliseconds.', 'ms', [
      { value: aggregate.totalDurationMs, attrs: { scope: 'all' } },
    ]),
  );
  metrics.push(
    gauge('openbot.run.tokens', 'Total tokens (input + output).', '1', [
      { value: aggregate.totalInputTokens + aggregate.totalOutputTokens, attrs: { scope: 'all' } },
    ]),
  );
  if (aggregate.totalCostUsd !== null) {
    metrics.push(
      gauge('openbot.run.cost_usd', 'Total estimated cost in USD (known prices only).', 'USD', [
        { value: aggregate.totalCostUsd, attrs: { scope: 'all' } },
      ]),
    );
  }
  for (const byModel of aggregate.byModel) {
    metrics.push(
      gauge('openbot.model.duration_ms', 'Total duration per model.', 'ms', [
        { value: byModel.totalDurationMs, attrs: { model: byModel.key } },
      ]),
    );
    if (byModel.totalCostUsd !== null) {
      metrics.push(
        gauge('openbot.model.cost_usd', 'Total estimated cost per model.', 'USD', [
          { value: byModel.totalCostUsd, attrs: { model: byModel.key } },
        ]),
      );
    }
  }
  for (const byTool of aggregate.byTool) {
    metrics.push(
      gauge('openbot.tool.duration_ms', 'Total duration per tool.', 'ms', [
        { value: byTool.totalDurationMs, attrs: { tool: byTool.key } },
      ]),
    );
  }
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'open-bot' } }] },
        scopeMetrics: [{ scope: { name: 'open-bot.telemetry', version: '1.04.0' }, metrics }],
      },
    ],
  };
}

async function postOtlpJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<OtlpExportResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Không follow redirect: telemetry chỉ đi đúng endpoint đã cấu
      // hình. Redirect 3xx được coi là lỗi (caller tự sửa endpoint).
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      return { sent: false, reason: 'error', status: response.status, error: `OTLP endpoint redirected (${response.status}) — refusing to follow; fix the endpoint URL.`, spansSent: 0 };
    }
    if (response.status < 200 || response.status >= 300) {
      return { sent: false, reason: 'error', status: response.status, error: `OTLP endpoint returned HTTP ${response.status}.`, spansSent: 0 };
    }
    return { sent: true, status: response.status, spansSent: -1 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = (err as Error).name === 'AbortError' || /aborted|timeout/i.test(message);
    return { sent: false, reason: 'error', error: timedOut ? `OTLP export timed out after ${timeoutMs}ms.` : `OTLP export failed: ${message}`, spansSent: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Export traces qua OTLP/HTTP JSON. Tắt mặc định — khi disabled hoặc
 * không có trace thì không gửi gì cả. Trả về spansSent thật.
 */
export async function exportTracesOtlp(rawConfig: unknown, traces: Trace[]): Promise<OtlpExportResult> {
  const config = validateOtlpConfig(rawConfig);
  if (!config.enabled) return { sent: false, reason: 'disabled', spansSent: 0 };
  if (traces.length === 0) return { sent: false, reason: 'no-traces', spansSent: 0 };
  const endpoint = config.endpoint ?? DEFAULT_OTLP_ENDPOINT;
  const timeoutMs = config.timeoutMs ?? DEFAULT_OTLP_TIMEOUT_MS;
  const spanCount = traces.reduce((sum, t) => sum + t.spans.length, 0);
  const result = await postOtlpJson(otlpTracesUrl(endpoint), buildOtlpTracesPayload(traces), timeoutMs, config.headers ?? {});
  if (result.sent) return { ...result, spansSent: spanCount };
  return result;
}

/**
 * Export metrics aggregate qua OTLP/HTTP JSON (signal metrics).
 * Cùng luật như traces: tắt mặc định, chỉ loopback/LAN.
 */
export async function exportMetricsOtlp(rawConfig: unknown, aggregate: RunMetricsAggregate): Promise<OtlpExportResult> {
  const config = validateOtlpConfig(rawConfig);
  if (!config.enabled) return { sent: false, reason: 'disabled', spansSent: 0 };
  const endpoint = config.endpoint ?? DEFAULT_OTLP_ENDPOINT;
  const timeoutMs = config.timeoutMs ?? DEFAULT_OTLP_TIMEOUT_MS;
  const result = await postOtlpJson(otlpMetricsUrl(endpoint), buildOtlpMetricsPayload(aggregate), timeoutMs, config.headers ?? {});
  if (result.sent) return { ...result, spansSent: 0 };
  return result;
}
