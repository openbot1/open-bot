/**
 * Local server detection v3 (v1.18, Doi T3) — Ollama / vLLM /
 * LM Studio / llama.cpp / text-generation-webui.
 *
 * Mo rong localDetectV2 (v1.17, chi Ollama + LM Studio) them:
 * - vLLM: GET /v1/models (OpenAI-compatible) + GET /health.
 * - llama.cpp server: GET /health + GET /v1/models (khi bat
 *   `--api-key` thi khong co key se 401 — bao unreachable ro rang).
 * - text-generation-webui: GET /v1/models (OpenAI extension).
 * Tai dung parser Ollama/LM Studio cua localDetectV2 (khong viet
 * lai); them parser OpenAI `/v1/models` chung cho vLLM/llama.cpp/
 * textgen (khac LM Studio o cho: them `owned_by` + chay thu
 * `/health` truoc).
 * - Health monitor dinh ky: probe lai moi N giay (mac dinh 30s),
 *   ghi nho trang thai + so loi lien tiep, goi listener khi trang
 *   thai doi (de UI cap nhat + router tu dang ky/huy model local).
 * - Auto-register: model local tim duoc -> RouterV3LocalModel
 *   (providerId `local:<kind>`, cost = 0, capability suy tu ten).
 *
 * NGUYEN TAC BAO MAT (nhu localDetectV2): chi goi HTTP loopback;
 * KHONG doc credential/token, KHONG gui credential di dau. Ket qua
 * chi chua nhan (ten model, endpoint, trang thai). Fetch inject
 * duoc (test dung fake); khong co fetch thi chi tra parser thuan.
 */

import {
  LOCAL_DETECT_MAX_MODELS,
  LOCAL_DETECT_TIMEOUT_MS,
  OLLAMA_DEFAULT_BASE_URL,
  LM_STUDIO_DEFAULT_BASE_URL,
  inferParameterSize,
  probeLmStudioEndpoint,
  probeOllamaEndpoint,
  type LocalDetectFetch,
  type LocalEndpointModel,
} from '../routerV2/localDetectV2';
import { capabilitiesForModel } from './capabilities';
import type {
  LocalServerDef,
  LocalServerHealth,
  RouterV3LocalKind,
  RouterV3LocalModel,
} from './types';

export type { LocalDetectFetch, LocalEndpointModel };

/** Endpoint mac dinh cua vLLM (OpenAI-compatible). */
export const VLLM_DEFAULT_BASE_URL = 'http://localhost:8000';
/** Endpoint mac dinh cua llama.cpp server. */
export const LLAMACPP_DEFAULT_BASE_URL = 'http://localhost:8080';
/** Endpoint mac dinh cua text-generation-webui (OpenAI extension). */
export const TEXTGEN_DEFAULT_BASE_URL = 'http://localhost:5000';

/** Danh sach server local mac dinh de quet (theo thu tu uu tien). */
export const DEFAULT_LOCAL_SERVER_DEFS: LocalServerDef[] = [
  { kind: 'ollama', baseUrl: OLLAMA_DEFAULT_BASE_URL, enabled: true },
  { kind: 'vllm', baseUrl: VLLM_DEFAULT_BASE_URL, enabled: true },
  { kind: 'lmstudio', baseUrl: LM_STUDIO_DEFAULT_BASE_URL, enabled: true },
  { kind: 'llamacpp', baseUrl: LLAMACPP_DEFAULT_BASE_URL, enabled: true },
  { kind: 'textgen', baseUrl: TEXTGEN_DEFAULT_BASE_URL, enabled: true },
];

/** Provider id cua mot server local trong router v3. */
export function localProviderId(kind: RouterV3LocalKind): string {
  return `local:${kind}`;
}

/** Nhan hien thi cua mot loai server local. */
export function localKindLabel(kind: RouterV3LocalKind): string {
  switch (kind) {
    case 'ollama':
      return 'Ollama';
    case 'vllm':
      return 'vLLM';
    case 'lmstudio':
      return 'LM Studio';
    case 'llamacpp':
      return 'llama.cpp';
    case 'textgen':
      return 'text-generation-webui';
  }
}

/** Endpoint tu env (neu user set) hoac mac dinh. */
export function vllmBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.VLLM_BASE_URL ?? '').trim() || VLLM_DEFAULT_BASE_URL;
}

/** Endpoint llama.cpp tu env (neu user set) hoac mac dinh. */
export function llamacppBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.LLAMACPP_BASE_URL ?? '').trim() || LLAMACPP_DEFAULT_BASE_URL;
}

// ---------------------------------------------------------------------------
// Parser thuan (khong I/O)
// ---------------------------------------------------------------------------

/**
 * Parse response OpenAI GET /v1/models chung (vLLM / llama.cpp /
 * textgen): `{ data: [{ id, owned_by, ... }] }`. Phong thu nhu
 * LM Studio: field la/thieu thi bo qua, khong crash.
 */
export function parseOpenAiModelsResponse(data: unknown): LocalEndpointModel[] {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { data?: unknown }).data)) return [];
  const out: LocalEndpointModel[] = [];
  for (const raw of (data as { data: unknown[] }).data) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : null;
    if (!id) continue;
    out.push({
      id,
      displayName: id.split('/').pop() ?? id,
      parameterSize: inferParameterSize(id),
    });
    if (out.length >= LOCAL_DETECT_MAX_MODELS) break;
  }
  return out;
}

/**
 * Parse response vLLM GET /health: tra true khi body noi server
 * san sang (`{"status": "ok"}` hoac text rong voi status 200).
 * Phong thu: khong phai object thi coi nhu chua san sang.
 */
export function parseVllmHealthResponse(data: unknown): boolean {
  if (typeof data === 'string') return data.trim().length === 0;
  if (data && typeof data === 'object') {
    const status = (data as Record<string, unknown>).status;
    return status === 'ok' || status === 'healthy';
  }
  return false;
}

/**
 * Parse response llama.cpp GET /health: `{ "status": "ok" }` (200)
 * hoac `{ "status": "loading model" }` (503 — server dang load).
 * Tra 'ok' | 'loading' | 'error'.
 */
export function parseLlamacppHealthResponse(data: unknown): 'ok' | 'loading' | 'error' {
  if (data && typeof data === 'object') {
    const status = (data as Record<string, unknown>).status;
    if (status === 'ok') return 'ok';
    if (typeof status === 'string' && status.toLowerCase().includes('loading')) return 'loading';
  }
  return 'error';
}

/** Chuan hoa base URL (bo `/` cuoi). */
function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

/** Goi fetch voi timeout; tra null khi timeout/loi/khong ok. */
async function fetchJsonWithTimeout(
  fetchFn: LocalDetectFetch,
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; data: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) return null;
    return { ok: true, data: await res.json() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Probe tung server (fetch inject)
// ---------------------------------------------------------------------------

/** Ket qua probe mot server local (v3, co them health). */
export interface LocalServerProbe {
  kind: RouterV3LocalKind;
  baseUrl: string;
  reachable: boolean;
  /** true = server san sang phuc vu (health ok). */
  healthy: boolean;
  models: LocalEndpointModel[];
  error?: string;
  probeLatencyMs: number;
  probedAt: number;
}

/** Probe vLLM: GET /health (best-effort) + GET /v1/models. */
export async function probeVllmEndpoint(
  fetchFn: LocalDetectFetch,
  opts?: { baseUrl?: string; timeoutMs?: number },
): Promise<LocalServerProbe> {
  const baseUrl = normalizeBaseUrl(opts?.baseUrl ?? VLLM_DEFAULT_BASE_URL);
  const timeoutMs = opts?.timeoutMs ?? LOCAL_DETECT_TIMEOUT_MS;
  const probedAt = Date.now();
  const started = Date.now();
  const health = await fetchJsonWithTimeout(fetchFn, `${baseUrl}/health`, timeoutMs);
  const healthy = health !== null && parseVllmHealthResponse(health.data);
  const modelsRes = await fetchJsonWithTimeout(fetchFn, `${baseUrl}/v1/models`, timeoutMs);
  if (modelsRes === null) {
    return {
      kind: 'vllm', baseUrl, reachable: false, healthy: false, models: [],
      error: 'vLLM server did not respond.', probeLatencyMs: Date.now() - started, probedAt,
    };
  }
  return {
    kind: 'vllm', baseUrl, reachable: true, healthy,
    models: parseOpenAiModelsResponse(modelsRes.data),
    probeLatencyMs: Date.now() - started, probedAt,
  };
}

/** Probe llama.cpp: GET /health + GET /v1/models. */
export async function probeLlamacppEndpoint(
  fetchFn: LocalDetectFetch,
  opts?: { baseUrl?: string; timeoutMs?: number },
): Promise<LocalServerProbe> {
  const baseUrl = normalizeBaseUrl(opts?.baseUrl ?? LLAMACPP_DEFAULT_BASE_URL);
  const timeoutMs = opts?.timeoutMs ?? LOCAL_DETECT_TIMEOUT_MS;
  const probedAt = Date.now();
  const started = Date.now();
  const health = await fetchJsonWithTimeout(fetchFn, `${baseUrl}/health`, timeoutMs);
  const healthStatus = health === null ? 'error' : parseLlamacppHealthResponse(health.data);
  const modelsRes = await fetchJsonWithTimeout(fetchFn, `${baseUrl}/v1/models`, timeoutMs);
  if (modelsRes === null) {
    return {
      kind: 'llamacpp', baseUrl, reachable: false, healthy: false, models: [],
      error: 'llama.cpp server did not respond.', probeLatencyMs: Date.now() - started, probedAt,
    };
  }
  return {
    kind: 'llamacpp', baseUrl, reachable: true, healthy: healthStatus === 'ok',
    models: parseOpenAiModelsResponse(modelsRes.data),
    error: healthStatus === 'loading' ? 'llama.cpp server is still loading the model.' : undefined,
    probeLatencyMs: Date.now() - started, probedAt,
  };
}

/** Probe text-generation-webui: GET /v1/models (OpenAI extension). */
export async function probeTextgenEndpoint(
  fetchFn: LocalDetectFetch,
  opts?: { baseUrl?: string; timeoutMs?: number },
): Promise<LocalServerProbe> {
  const baseUrl = normalizeBaseUrl(opts?.baseUrl ?? TEXTGEN_DEFAULT_BASE_URL);
  const timeoutMs = opts?.timeoutMs ?? LOCAL_DETECT_TIMEOUT_MS;
  const probedAt = Date.now();
  const started = Date.now();
  const modelsRes = await fetchJsonWithTimeout(fetchFn, `${baseUrl}/v1/models`, timeoutMs);
  if (modelsRes === null) {
    return {
      kind: 'textgen', baseUrl, reachable: false, healthy: false, models: [],
      error: 'text-generation-webui did not respond.', probeLatencyMs: Date.now() - started, probedAt,
    };
  }
  return {
    kind: 'textgen', baseUrl, reachable: true, healthy: true,
    models: parseOpenAiModelsResponse(modelsRes.data),
    probeLatencyMs: Date.now() - started, probedAt,
  };
}

/** Probe mot server local bat ky (dispatch theo kind). */
export async function probeLocalServer(
  kind: RouterV3LocalKind,
  fetchFn: LocalDetectFetch,
  opts?: { baseUrl?: string; timeoutMs?: number },
): Promise<LocalServerProbe> {
  switch (kind) {
    case 'ollama': {
      const probe = await probeOllamaEndpoint(fetchFn, opts);
      return {
        kind, baseUrl: probe.baseUrl, reachable: probe.reachable, healthy: probe.reachable,
        models: probe.models, error: probe.error, probeLatencyMs: 0, probedAt: probe.probedAt,
      };
    }
    case 'lmstudio': {
      const probe = await probeLmStudioEndpoint(fetchFn, opts);
      return {
        kind, baseUrl: probe.baseUrl, reachable: probe.reachable, healthy: probe.reachable,
        models: probe.models, error: probe.error, probeLatencyMs: 0, probedAt: probe.probedAt,
      };
    }
    case 'vllm':
      return probeVllmEndpoint(fetchFn, opts);
    case 'llamacpp':
      return probeLlamacppEndpoint(fetchFn, opts);
    case 'textgen':
      return probeTextgenEndpoint(fetchFn, opts);
  }
}

/**
 * Quet tat ca server local da bat: probe song song (Promise.all),
 * server nao loi van co muc `reachable: false` kem ly do — khong
 * crash ca lan quet.
 */
export async function scanAllLocalServers(opts: {
  fetchFn: LocalDetectFetch;
  servers?: LocalServerDef[];
  timeoutMs?: number;
}): Promise<LocalServerProbe[]> {
  const servers = opts.servers ?? DEFAULT_LOCAL_SERVER_DEFS;
  const enabled = servers.filter((s) => s.enabled);
  const results = await Promise.all(
    enabled.map(async (server) => {
      try {
        return await probeLocalServer(server.kind, opts.fetchFn, { baseUrl: server.baseUrl, timeoutMs: opts.timeoutMs });
      } catch (error) {
        return {
          kind: server.kind,
          baseUrl: server.baseUrl,
          reachable: false,
          healthy: false,
          models: [],
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
          probeLatencyMs: 0,
          probedAt: Date.now(),
        } satisfies LocalServerProbe;
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Auto-register model local vao router
// ---------------------------------------------------------------------------

/** Chuyen ket qua probe thanh danh sach model local da dang ky. */
export function probesToLocalModels(probes: readonly LocalServerProbe[]): RouterV3LocalModel[] {
  const out: RouterV3LocalModel[] = [];
  const seen = new Set<string>();
  for (const probe of probes) {
    if (!probe.reachable) continue;
    for (const model of probe.models) {
      const key = `${probe.kind}::${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        modelId: model.id,
        serverKind: probe.kind,
        baseUrl: probe.baseUrl,
        providerId: localProviderId(probe.kind),
        capability: capabilitiesForModel(model.id),
        running: model.running ?? false,
        sizeBytes: model.sizeBytes,
        discoveredAt: probe.probedAt,
      });
    }
  }
  return out.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
}

/** Base URL OpenAI-compatible (`/v1`) cua mot model local da dang ky. */
export function localModelChatBaseUrl(model: RouterV3LocalModel): string {
  return `${model.baseUrl.replace(/\/+$/, '')}/v1`;
}

// ---------------------------------------------------------------------------
// Health monitor dinh ky
// ---------------------------------------------------------------------------

/** Listener goi khi health mot server thay doi (reachable/healthy/modelCount). */
export type LocalHealthListener = (health: LocalServerHealth) => void;

/**
 * LocalHealthMonitor — probe lai cac server local moi `intervalMs`
 * (mac dinh 30s), giu trang thai + so loi lien tiep, goi listener
 * khi trang thai doi. `start()` dung setInterval (unref de khong
 * giu process); `stop()` dung lai. Probe mot lan bang `checkNow()`
 * (dung cho test + tool, khong can doi interval).
 */
export class LocalHealthMonitor {
  private readonly fetchFn: LocalDetectFetch;
  private readonly servers: LocalServerDef[];
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly listeners = new Set<LocalHealthListener>();
  private readonly health = new Map<string, LocalServerHealth>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    fetchFn: LocalDetectFetch;
    servers?: LocalServerDef[];
    intervalMs?: number;
    timeoutMs?: number;
  }) {
    this.fetchFn = opts.fetchFn;
    this.servers = (opts.servers ?? DEFAULT_LOCAL_SERVER_DEFS).map((s) => ({ ...s }));
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.timeoutMs = opts.timeoutMs ?? LOCAL_DETECT_TIMEOUT_MS;
  }

  /** Bat monitor dinh ky (goi checkNow ngay lan dau). */
  start(): void {
    if (this.timer !== null) return;
    void this.checkNow();
    this.timer = setInterval(() => {
      void this.checkNow();
    }, this.intervalMs);
    if (typeof (this.timer as { unref?: unknown }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Dung monitor dinh ky. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Monitor co dang chay khong. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Dang ky listener (tra ham huy). */
  onChange(listener: LocalHealthListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Probe tat ca server ngay bay gio, cap nhat health, tra ket qua. */
  async checkNow(): Promise<LocalServerHealth[]> {
    const probes = await scanAllLocalServers({
      fetchFn: this.fetchFn,
      servers: this.servers,
      timeoutMs: this.timeoutMs,
    });
    const out: LocalServerHealth[] = [];
    for (const probe of probes) {
      const prev = this.health.get(probe.kind);
      const consecutiveFailures = probe.reachable ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
      const next: LocalServerHealth = {
        kind: probe.kind,
        baseUrl: probe.baseUrl,
        reachable: probe.reachable,
        modelCount: probe.models.length,
        probeLatencyMs: probe.probeLatencyMs,
        lastError: probe.error,
        lastCheckedAt: probe.probedAt,
        consecutiveFailures,
      };
      this.health.set(probe.kind, next);
      out.push(next);
      const changed =
        !prev ||
        prev.reachable !== next.reachable ||
        prev.modelCount !== next.modelCount ||
        prev.lastError !== next.lastError;
      if (changed) {
        for (const listener of this.listeners) {
          try {
            listener({ ...next });
          } catch {
            // Listener loi khong lam hong monitor.
          }
        }
      }
    }
    return out;
  }

  /** Health hien tai cua mot server (undefined khi chua probe). */
  getHealth(kind: RouterV3LocalKind): LocalServerHealth | undefined {
    const found = this.health.get(kind);
    return found ? { ...found } : undefined;
  }

  /** Health hien tai cua tat ca server. */
  snapshot(): LocalServerHealth[] {
    return [...this.health.values()].map((h) => ({ ...h }));
  }

  /** So server dang reachable. */
  reachableCount(): number {
    return [...this.health.values()].filter((h) => h.reachable).length;
  }
}
