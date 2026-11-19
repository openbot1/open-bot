/**
 * Health probe v116 (v1.39, Doi T3) — probe suc khoe endpoint local
 * cho local-model router.
 *
 * Registry V115 da co `healthCheck()` (ping backend + model loaded)
 * nhung chi biet Ollama/llama.cpp cua chinh no. V116 them probe
 * chung cho BAT KY endpoint OpenAI-compatible loopback nao (vLLM,
 * LM Studio, textgen, llama-server, Ollama...):
 *
 * 1) `probeLocalEndpoint()`: chi goi URL loopback (127.0.0.1 /
 *    localhost / ::1 — dung lai `isLoopbackUrl`, tu choi URL khac
 *    de khong vo tinh probe may chu khac). Thu `/v1/models` truoc
 *    (lay danh sach model that server dang phuc vu), roi `/health`
 *    neu co; tra ve reachable/latency/status + model + loi ro rang.
 *    Http client inject duoc (mac dinh fetch toan cuc) + timeout
 *    qua AbortController — test dung fake client hoac server that
 *    tren port tam, khong phu thuoc Ollama ambient dang chay.
 * 2) `probeEndpoints()`: probe nhieu endpoint, tra ve tung ket qua +
 *    endpoint khoe nhat (de router chon nhanh).
 * 3) `LocalEndpointHealthHistory`: lich su probe theo endpoint (ring
 *    buffer): uptime ratio, so loi lien tiep, lan khoe cuoi — de UI
 *    hien thi "endpoint nay chet 3 lan trong 10 phut qua" thay vi
 *    chi biet trang thai hien tai.
 *
 * KHONG doc/gui credential: probe chi GET khong auth. Endpoint nao
 * doi API key se tra 401 — ghi ro `authRequired` thay vi bao "chet".
 */

import { defaultHttpClient, type HttpClient } from './registry';
import { parseVllmMetrics, type VllmMetricsSnapshot } from './batchingV116';
import { isLoopbackUrl } from './types';

/** Trang thai mot endpoint sau probe. */
export type LocalEndpointProbeStatus = 'healthy' | 'unreachable' | 'error' | 'auth-required';

/** Ket qua mot lan probe. */
export interface LocalEndpointProbeResult {
  baseUrl: string;
  status: LocalEndpointProbeStatus;
  /** true = server tra loi (ke ca 401 — server song nhung doi key). */
  reachable: boolean;
  /** Thoi gian tu luc gui den khi nhan header dau tien (ms). */
  latencyMs: number;
  /** Ten model server bao qua /v1/models (rong khi khong lay duoc). */
  models: string[];
  /** true = server co endpoint /health tra ok. */
  hasHealthEndpoint: boolean;
  /** Ma HTTP cuoi cung nhan duoc (neu co). */
  httpStatus?: number;
  /** Loi ngan (neu co). */
  error?: string;
  checkedAt: number;
}

/** Tuy chon probe. */
export interface ProbeLocalEndpointOptions {
  /** Timeout moi request (ms, mac dinh 3000). */
  timeoutMs?: number;
  /** Http client (mac dinh fetch toan cuc; test inject fake). */
  http?: HttpClient;
  /** Ham lay thoi gian (mac dinh Date.now). */
  now?: () => number;
  /** true = bo qua buoc /v1/models (chi check /health). */
  healthOnly?: boolean;
}

/** Timeout mac dinh cho probe (ms). */
export const HEALTH_PROBE_TIMEOUT_MS = 3000;

/** Thu mot GET voi timeout; tra { ok, status, body } hoac throw. */
async function getWithTimeout(
  http: HttpClient,
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await http(url, { method: 'GET', signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Trich ten model tu JSON cua /v1/models (OpenAI-compatible). */
export function parseModelsList(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return [];
    const data = (parsed as Record<string, unknown>)['data'];
    if (!Array.isArray(data)) return [];
    const out: string[] = [];
    for (const item of data) {
      if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>)['id'] === 'string') {
        out.push((item as Record<string, unknown>)['id'] as string);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Probe mot endpoint local. Chi chap nhan URL loopback — URL khac
 * tra ve `unreachable` + loi ro rang, khong goi mang ra ngoai.
 */
export async function probeLocalEndpoint(
  baseUrl: string,
  options: ProbeLocalEndpointOptions = {},
): Promise<LocalEndpointProbeResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const http = options.http ?? defaultHttpClient;
  const checkedAt = now();
  const started = Date.now();
  const fail = (status: LocalEndpointProbeStatus, error: string, httpStatus?: number): LocalEndpointProbeResult => ({
    baseUrl,
    status,
    reachable: status !== 'unreachable',
    latencyMs: Date.now() - started,
    models: [],
    hasHealthEndpoint: false,
    httpStatus,
    error,
    checkedAt,
  });
  let normalized: string;
  try {
    normalized = baseUrl.replace(/\/+$/, '');
    // Kiem tra URL hop le + loopback truoc khi goi.
    if (!isLoopbackUrl(normalized)) {
      return fail('unreachable', `Chi probe endpoint loopback (127.0.0.1/localhost); "${baseUrl}" khong phai loopback.`);
    }
  } catch {
    return fail('unreachable', `URL khong hop le: "${baseUrl}".`);
  }

  let models: string[] = [];
  let modelsOk = false;
  let httpStatus: number | undefined;
  if (!options.healthOnly) {
    try {
      const res = await getWithTimeout(http, `${normalized}/v1/models`, timeoutMs);
      httpStatus = res.status;
      if (res.status === 401 || res.status === 403) {
        return {
          baseUrl,
          status: 'auth-required',
          reachable: true,
          latencyMs: Date.now() - started,
          models: [],
          hasHealthEndpoint: false,
          httpStatus: res.status,
          error: `Server doi API key (HTTP ${res.status}) — server dang chay, khong phai chet.`,
          checkedAt,
        };
      }
      if (res.ok) {
        models = parseModelsList(res.text);
        modelsOk = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = /abort/i.test(message);
      return fail('unreachable', isTimeout ? `Het timeout sau ${timeoutMs} ms (khong co server tra loi).` : `Khong ket noi duoc: ${message.slice(0, 200)}`);
    }
  }

  // Buoc 2: /health (neu server co). Khong co thi van healthy neu
  // /v1/models da tra loi.
  let hasHealthEndpoint = false;
  try {
    const res = await getWithTimeout(http, `${normalized}/health`, timeoutMs);
    httpStatus = res.status;
    hasHealthEndpoint = res.ok;
    if (res.ok) {
      return {
        baseUrl,
        status: 'healthy',
        reachable: true,
        latencyMs: Date.now() - started,
        models,
        hasHealthEndpoint: true,
        httpStatus: res.status,
        checkedAt,
      };
    }
  } catch {
    // /health loi/timeout: neu /v1/models da ok thi van coi la healthy.
  }
  if (modelsOk) {
    return {
      baseUrl,
      status: 'healthy',
      reachable: true,
      latencyMs: Date.now() - started,
      models,
      hasHealthEndpoint,
      httpStatus,
      checkedAt,
    };
  }
  if (options.healthOnly) {
    return fail('error', 'Endpoint /health khong tra loi ok.', httpStatus);
  }
  return fail('error', `/v1/models tra HTTP ${httpStatus ?? 'khong ro'} va khong co /health ok.`, httpStatus);
}

/** Probe nhieu endpoint, tra ve tung ket qua + endpoint khoe nhat. */
export async function probeEndpoints(
  baseUrls: string[],
  options: ProbeLocalEndpointOptions = {},
): Promise<{ results: LocalEndpointProbeResult[]; healthiest: LocalEndpointProbeResult | null }> {
  const results: LocalEndpointProbeResult[] = [];
  for (const url of baseUrls) {
    results.push(await probeLocalEndpoint(url, options));
  }
  const healthy = results
    .filter((r) => r.status === 'healthy')
    .sort((a, b) => a.latencyMs - b.latencyMs);
  return { results, healthiest: healthy[0] ?? null };
}

/**
 * Lay snapshot /metrics that tu mot server vLLM (loopback only).
 * Tra ve snapshot da parse + tra loi that, hoac null khi server
 * khong co /metrics (khong phai vLLM) — khong throw de caller co
 * the tiep tuc voi health probe thong thuong.
 */
export async function probeVllmMetrics(
  baseUrl: string,
  options: ProbeLocalEndpointOptions = {},
): Promise<{ snapshot: VllmMetricsSnapshot; latencyMs: number } | null> {
  const timeoutMs = options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const http = options.http ?? defaultHttpClient;
  let normalized: string;
  try {
    normalized = baseUrl.replace(/\/+$/, '');
    if (!isLoopbackUrl(normalized)) return null;
  } catch {
    return null;
  }
  const started = Date.now();
  try {
    const res = await getWithTimeout(http, `${normalized}/metrics`, timeoutMs);
    if (!res.ok) return null;
    return { snapshot: parseVllmMetrics(res.text), latencyMs: Date.now() - started };
  } catch {
    return null;
  }
}

/** Lich su probe cua mot endpoint (de tinh uptime / loi lien tiep). */
export interface LocalEndpointHealthSummary {
  baseUrl: string;
  probes: number;
  healthyProbes: number;
  /** Ti le probe healthy (0..1; 0 khi chua probe). */
  uptimeRatio: number;
  consecutiveFailures: number;
  lastHealthyAt: number | null;
  lastProbeAt: number | null;
  lastStatus: LocalEndpointProbeStatus | null;
  avgLatencyMs: number | null;
}

/** Ring buffer lich su probe theo endpoint. */
export class LocalEndpointHealthHistory {
  private readonly capacity: number;
  private readonly entries = new Map<string, LocalEndpointProbeResult[]>();

  constructor(capacity = 50) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  record(result: LocalEndpointProbeResult): void {
    const list = this.entries.get(result.baseUrl) ?? [];
    list.push(result);
    while (list.length > this.capacity) list.shift();
    this.entries.set(result.baseUrl, list);
  }

  history(baseUrl: string): LocalEndpointProbeResult[] {
    return [...(this.entries.get(baseUrl) ?? [])];
  }

  summary(baseUrl: string): LocalEndpointHealthSummary {
    const list = this.entries.get(baseUrl) ?? [];
    const healthy = list.filter((r) => r.status === 'healthy');
    let failures = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].status === 'healthy') break;
      failures += 1;
    }
    const latencies = healthy.map((r) => r.latencyMs);
    return {
      baseUrl,
      probes: list.length,
      healthyProbes: healthy.length,
      uptimeRatio: list.length > 0 ? healthy.length / list.length : 0,
      consecutiveFailures: failures,
      lastHealthyAt: healthy.length > 0 ? healthy[healthy.length - 1].checkedAt : null,
      lastProbeAt: list.length > 0 ? list[list.length - 1].checkedAt : null,
      lastStatus: list.length > 0 ? list[list.length - 1].status : null,
      avgLatencyMs: latencies.length > 0
        ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
        : null,
    };
  }

  summaries(): LocalEndpointHealthSummary[] {
    return [...this.entries.keys()].map((url) => this.summary(url));
  }

  clear(baseUrl?: string): void {
    if (baseUrl) this.entries.delete(baseUrl);
    else this.entries.clear();
  }
}
