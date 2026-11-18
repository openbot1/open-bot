/**
 * Local detect v2 (v1.17, Doi T3) — Ollama / LM Studio / CLI agent.
 *
 * Mo rong cliProbeV2 (v1.16, chi probe 6 CLI agent) them 2 nguon
 * model local chay qua HTTP tren loopback:
 * - Ollama: GET /api/tags (list model da pull) + /api/ps (model
 *   dang chay) + /api/show (context). Endpoint mac dinh
 *   http://localhost:11434; ton trong OLLAMA_HOST khi user set.
 * - LM Studio: server local OpenAI-compatible mac dinh
 *   http://localhost:1234/v1/models (GET /v1/models).
 * - CLI agent: tai dung probeAllCliAgents cua cliProbeV2 (khong
 *   viet lai probe) — chi them lop hop nhat + toggle.
 *
 * NGUYEN TAC BAO MAT (giong detected v1 / cliProbeV2, ap dung
 * nghiem): chi goi HTTP loopback + lenh cua chinh CLI; KHONG BAO
 * GIO doc noi dung file credential / token, KHONG copy hay gui
 * credential di dau. Ket qua chi chua nhan (ten model, endpoint,
 * trang thai, account label) — an toan hien UI / gui qua IPC.
 * Fetch duoc inject (test dung fake; production dung fetch that);
 * khong co fetch thi chi tra parser thuan + probe CLI.
 */

import { probeAllCliAgents } from './cliProbeV2';
import type { BinaryFinder, CliRunner } from './cliProbeV2';
import type { CliAgentKind, CliProbeResult } from './types';

/** Loai endpoint local. */
export type LocalEndpointKind = 'ollama' | 'lmstudio' | 'llamacpp';

/** Endpoint mac dinh cua Ollama (loopback). */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';
/** Endpoint mac dinh cua LM Studio (loopback, OpenAI-compatible). */
export const LM_STUDIO_DEFAULT_BASE_URL = 'http://localhost:1234';
/** Timeout mac dinh cho probe HTTP local (ms). */
export const LOCAL_DETECT_TIMEOUT_MS = 5_000;
/** So model toi da lay tu mot endpoint (chong blow-up). */
export const LOCAL_DETECT_MAX_MODELS = 500;

/** Mot model local tren mot endpoint. */
export interface LocalEndpointModel {
  /** Id model, vd `qwen2.5:7b` (Ollama) hay `lmstudio-community/...`. */
  id: string;
  /** Ten hien thi (mac dinh = id). */
  displayName: string;
  /** Dung luong tren dia (byte), neu endpoint tra. */
  sizeBytes?: number;
  /** Kich thuoc tham so, vd `7B` (neu suy ra duoc). */
  parameterSize?: string;
  /** true = model dang chay (chi Ollama /api/ps biet). */
  running?: boolean;
  /** Context window (token), neu endpoint tra. */
  contextLength?: number;
}

/** Ket qua probe mot endpoint local. */
export interface LocalEndpointProbe {
  kind: LocalEndpointKind;
  /** Base URL da probe (khong co `/v1` thua doi voi LM Studio). */
  baseUrl: string;
  /** Endpoint co phan hoi khong. */
  reachable: boolean;
  /** Version server (neu tra ve). */
  version?: string;
  /** Model tim thay tren endpoint. */
  models: LocalEndpointModel[];
  /** Loi gap khi probe (neu co). */
  error?: string;
  /** Thoi diem probe (ms epoch). */
  probedAt: number;
}

/** Kieu fetch toi thieu de probe (tuong thich fetch that + fake). */
export type LocalDetectFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

/** Mot nguon model da hop nhat (endpoint local hoac CLI agent). */
export type LocalSourceKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'cli';
export interface LocalSource {
  /** Id on dinh: `ollama`, `lmstudio`, `cli:<kind>`. */
  id: string;
  kind: LocalSourceKind;
  /** Nhan hien thi, vd `Ollama`, `LM Studio`, `Claude Code`. */
  label: string;
  /** CLI agent tuong ung (khi kind = 'cli'). */
  cliKind?: CliAgentKind;
  /** Endpoint (khi la server local). */
  baseUrl?: string;
  /** Nguon co san sang dung khong. */
  available: boolean;
  /** Ly do khong kha dung (neu co). */
  unavailableReason?: string;
  /** Tai khoan / login dang chay qua (label, khong chua secret). */
  accountLabel?: string;
  /** Model cua nguon nay. */
  models: LocalEndpointModel[];
  /** Nguon co dang bat (user toggle) khong. */
  enabled: boolean;
}

/** Store toggle bat/tat tung nguon (in-memory + serialize). */
export class SourceToggleStore {
  private disabled = new Set<string>();

  /** Tat mot nguon (nguon tat khong duoc chon / khong probe sau). */
  disable(sourceId: string): void {
    this.disabled.add(sourceId);
  }

  /** Bat lai mot nguon. */
  enable(sourceId: string): void {
    this.disabled.delete(sourceId);
  }

  /** Nguon co dang bat khong. */
  isEnabled(sourceId: string): boolean {
    return !this.disabled.has(sourceId);
  }

  /** Tat ca id nguon dang tat. */
  disabledIds(): string[] {
    return [...this.disabled].sort();
  }

  /** Serialize de luu (vd vao settings). */
  serialize(): { disabledSourceIds: string[] } {
    return { disabledSourceIds: this.disabledIds() };
  }

  /** Khoi phuc tu du lieu da luu (bo qua id la). */
  static deserialize(data: unknown): SourceToggleStore {
    const store = new SourceToggleStore();
    if (data && typeof data === 'object' && Array.isArray((data as { disabledSourceIds?: unknown }).disabledSourceIds)) {
      for (const id of (data as { disabledSourceIds: unknown[] }).disabledSourceIds) {
        if (typeof id === 'string' && id.length > 0) store.disabled.add(id);
      }
    }
    return store;
  }
}

/** Mot muc trong model picker cua UI. */
export interface ModelPickerEntry {
  /** Id muc: `<sourceId>:<modelId>`. */
  id: string;
  /** Ten model hien thi. */
  modelLabel: string;
  /** Nguon chay (Ollama / LM Studio / ten CLI). */
  sourceLabel: string;
  /** Id nguon (de toggle). */
  sourceId: string;
  /** Tai khoan nao chay model nay (label; undefined = khong can login). */
  accountLabel?: string;
  /** Muc co duoc bat khong (nguon bi tat thi entry mo di). */
  enabled: boolean;
  /** Model co kha dung ngay bay gio khong. */
  available: boolean;
  /** Model dang chay san (load nhanh). */
  running?: boolean;
  /** Go i y chat luong (0..1) — suy tu kich thuoc / ten, chi de sap xep. */
  qualityHint: number;
}

// ---------------------------------------------------------------------------
// Parser thuan (khong I/O) — test truc tiep duoc
// ---------------------------------------------------------------------------

/** Suy kich thuoc tham so tu ten model, vd `qwen2.5:7b` -> `7B`. */
export function inferParameterSize(modelId: string): string | undefined {
  const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(modelId);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return undefined;
  return `${m[1]}B`;
}

/**
 * Parse response Ollama GET /api/tags:
 * `{ models: [{ name, size, modified_at, details: { parameter_size,
 * quantization_level, family } }] }`. Phong thu: field la/thieu thi
 * bo qua field do, khong crash; khong phai object thi tra [].
 */
export function parseOllamaTagsResponse(data: unknown): LocalEndpointModel[] {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { models?: unknown }).models)) return [];
  const out: LocalEndpointModel[] = [];
  for (const raw of (data as { models: unknown[] }).models) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : null;
    if (!name) continue;
    const details = rec.details && typeof rec.details === 'object' ? (rec.details as Record<string, unknown>) : {};
    const model: LocalEndpointModel = {
      id: name,
      displayName: name,
      parameterSize:
        typeof details.parameter_size === 'string' ? details.parameter_size : inferParameterSize(name),
    };
    if (typeof rec.size === 'number' && Number.isFinite(rec.size) && rec.size > 0) model.sizeBytes = rec.size;
    out.push(model);
    if (out.length >= LOCAL_DETECT_MAX_MODELS) break;
  }
  return out;
}

/**
 * Parse response Ollama GET /api/ps: `{ models: [{ name, ... }] }`
 * — tra tap ten model dang chay (de danh dau `running`).
 */
export function parseOllamaPsResponse(data: unknown): Set<string> {
  const running = new Set<string>();
  if (!data || typeof data !== 'object' || !Array.isArray((data as { models?: unknown }).models)) return running;
  for (const raw of (data as { models: unknown[] }).models) {
    if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).name === 'string') {
      running.add(((raw as Record<string, unknown>).name as string).trim());
    }
  }
  return running;
}

/**
 * Parse response LM Studio GET /v1/models (OpenAI-compatible):
 * `{ data: [{ id, owned_by, ... }] }`. Phong thu nhu Ollama.
 */
export function parseLmStudioModelsResponse(data: unknown): LocalEndpointModel[] {
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

/** Danh dau model nao dang chay (tu /api/ps) vao danh sach /api/tags. */
export function markRunningModels(models: LocalEndpointModel[], running: ReadonlySet<string>): LocalEndpointModel[] {
  return models.map((m) => ({ ...m, running: running.has(m.id) }));
}

/** Gop 2 danh sach model theo id (uu tien muc co nhieu thong tin hon). */
export function mergeLocalModels(a: LocalEndpointModel[], b: LocalEndpointModel[]): LocalEndpointModel[] {
  const byId = new Map<string, LocalEndpointModel>();
  for (const m of [...a, ...b]) {
    const prev = byId.get(m.id);
    if (!prev) {
      byId.set(m.id, { ...m });
      continue;
    }
    byId.set(m.id, {
      ...prev,
      ...m,
      sizeBytes: m.sizeBytes ?? prev.sizeBytes,
      parameterSize: m.parameterSize ?? prev.parameterSize,
      contextLength: m.contextLength ?? prev.contextLength,
      running: m.running ?? prev.running,
    });
  }
  return [...byId.values()].sort((x, y) => x.id.localeCompare(y.id));
}

// ---------------------------------------------------------------------------
// Probe HTTP local (fetch inject)
// ---------------------------------------------------------------------------

/** Goi fetch voi timeout (AbortController); tra null khi timeout/loi. */
async function fetchJsonWithTimeout(
  fetchFn: LocalDetectFetch,
  url: string,
  timeoutMs: number,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Chuan hoa base URL (bo `/` cuoi). */
function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

/** Endpoint Ollama tu env (neu user set OLLAMA_HOST) hoac mac dinh. */
export function ollamaBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const host = (env.OLLAMA_HOST ?? '').trim();
  if (!host) return OLLAMA_DEFAULT_BASE_URL;
  // OLLAMA_HOST co the la `host:port` (khong scheme) hoac URL day du.
  if (/^https?:\/\//.test(host)) return normalizeBaseUrl(host);
  return `http://${normalizeBaseUrl(host)}`;
}

/** Endpoint LM Studio tu env (LM_STUDIO_URL) hoac mac dinh. */
export function lmStudioBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = (env.LM_STUDIO_URL ?? '').trim();
  return url ? normalizeBaseUrl(url) : LM_STUDIO_DEFAULT_BASE_URL;
}

/** Probe Ollama: /api/tags + /api/ps (best-effort). */
export async function probeOllamaEndpoint(
  fetchFn: LocalDetectFetch,
  opts?: { baseUrl?: string; timeoutMs?: number },
): Promise<LocalEndpointProbe> {
  const baseUrl = normalizeBaseUrl(opts?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL);
  const timeoutMs = opts?.timeoutMs ?? LOCAL_DETECT_TIMEOUT_MS;
  const probedAt = Date.now();
  const tags = await fetchJsonWithTimeout(fetchFn, `${baseUrl}/api/tags`, timeoutMs);
  if (tags === null) {
    return { kind: 'ollama', baseUrl, reachable: false, models: [], error: 'Ollama server did not respond.', probedAt };
  }
  const models = parseOllamaTagsResponse(tags);
  const ps = await fetchJsonWithTimeout(fetchFn, `${baseUrl}/api/ps`, timeoutMs);
  const running = ps === null ? new Set<string>() : parseOllamaPsResponse(ps);
  return { kind: 'ollama', baseUrl, reachable: true, models: markRunningModels(models, running), probedAt };
}

/** Probe LM Studio: GET /v1/models. */
export async function probeLmStudioEndpoint(
  fetchFn: LocalDetectFetch,
  opts?: { baseUrl?: string; timeoutMs?: number },
): Promise<LocalEndpointProbe> {
  const baseUrl = normalizeBaseUrl(opts?.baseUrl ?? LM_STUDIO_DEFAULT_BASE_URL);
  const timeoutMs = opts?.timeoutMs ?? LOCAL_DETECT_TIMEOUT_MS;
  const probedAt = Date.now();
  const data = await fetchJsonWithTimeout(fetchFn, `${baseUrl}/v1/models`, timeoutMs);
  if (data === null) {
    return { kind: 'lmstudio', baseUrl, reachable: false, models: [], error: 'LM Studio server did not respond.', probedAt };
  }
  return { kind: 'lmstudio', baseUrl, reachable: true, models: parseLmStudioModelsResponse(data), probedAt };
}

// ---------------------------------------------------------------------------
// Hop nhat nguon + model picker entries
// ---------------------------------------------------------------------------

/** Chuyen ket qua probe CLI thanh LocalSource (tai dung probe v1.16). */
export function cliProbeToLocalSource(result: CliProbeResult, enabled: boolean): LocalSource {
  return {
    id: `cli:${result.kind}`,
    kind: 'cli',
    label: result.label,
    cliKind: result.kind,
    available: result.exists && result.loggedIn === true,
    unavailableReason: result.loggedIn === false
      ? 'not-signed-in'
      : !result.exists
        ? 'not-installed'
        : result.unavailableReason,
    accountLabel: result.accountLabel,
    models: result.models.map((id) => ({
      id,
      displayName: id,
      parameterSize: inferParameterSize(id),
    })),
    enabled,
  };
}

/** Chuyen ket qua probe endpoint thanh LocalSource. */
export function endpointProbeToLocalSource(probe: LocalEndpointProbe, enabled: boolean): LocalSource {
  const label = probe.kind === 'ollama' ? 'Ollama' : probe.kind === 'lmstudio' ? 'LM Studio' : 'llama.cpp';
  return {
    id: probe.kind,
    kind: probe.kind,
    label,
    baseUrl: probe.baseUrl,
    available: probe.reachable,
    unavailableReason: probe.reachable ? undefined : 'not-running',
    models: probe.models,
    enabled,
  };
}

/**
 * Detect tat ca nguon local: Ollama + LM Studio (qua fetch) + 6 CLI
 * agent (tai dung probeAllCliAgents). Nguon nao fetch/CLI loi thi
 * van co muc `available: false` kem ly do — khong crash ca lan
 * detect. Toggle store quyet dinh `enabled` tung nguon.
 */
export async function detectAllLocalSources(opts?: {
  fetchFn?: LocalDetectFetch;
  ollamaBaseUrl?: string;
  lmStudioBaseUrl?: string;
  timeoutMs?: number;
  toggles?: SourceToggleStore;
  cliRunner?: CliRunner;
  cliFinder?: BinaryFinder;
  cliEnv?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<LocalSource[]> {
  const toggles = opts?.toggles ?? new SourceToggleStore();
  const sources: LocalSource[] = [];
  if (opts?.fetchFn) {
    const [ollama, lmStudio] = await Promise.all([
      probeOllamaEndpoint(opts.fetchFn, { baseUrl: opts.ollamaBaseUrl, timeoutMs: opts.timeoutMs }),
      probeLmStudioEndpoint(opts.fetchFn, { baseUrl: opts.lmStudioBaseUrl, timeoutMs: opts.timeoutMs }),
    ]);
    sources.push(endpointProbeToLocalSource(ollama, toggles.isEnabled('ollama')));
    sources.push(endpointProbeToLocalSource(lmStudio, toggles.isEnabled('lmstudio')));
  } else {
    // Khong co fetch: van bao endpoint mac dinh la chua kiem tra duoc.
    sources.push({
      id: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: opts?.ollamaBaseUrl ?? OLLAMA_DEFAULT_BASE_URL,
      available: false, unavailableReason: 'not-checked', models: [], enabled: toggles.isEnabled('ollama'),
    });
    sources.push({
      id: 'lmstudio', kind: 'lmstudio', label: 'LM Studio', baseUrl: opts?.lmStudioBaseUrl ?? LM_STUDIO_DEFAULT_BASE_URL,
      available: false, unavailableReason: 'not-checked', models: [], enabled: toggles.isEnabled('lmstudio'),
    });
  }
  let cliResults: CliProbeResult[] = [];
  try {
    cliResults = await probeAllCliAgents({
      runner: opts?.cliRunner,
      finder: opts?.cliFinder,
      env: opts?.cliEnv,
      homeDir: opts?.homeDir,
    });
  } catch {
    cliResults = [];
  }
  for (const r of cliResults) {
    sources.push(cliProbeToLocalSource(r, toggles.isEnabled(`cli:${r.kind}`)));
  }
  return sources;
}

/** Go i y chat luong (0..1) de sap xep picker: model lon hon thi goi y cao hon; model dang chay duoc cong them. */
export function qualityHintForModel(model: LocalEndpointModel, sourceKind: LocalSourceKind): number {
  let hint = 0.55;
  if (sourceKind === 'cli') hint = 0.85;
  const size = model.parameterSize ? Number.parseFloat(model.parameterSize) : Number.NaN;
  if (Number.isFinite(size)) {
    if (size >= 30) hint = Math.max(hint, 0.9);
    else if (size >= 8) hint = Math.max(hint, 0.78);
    else if (size >= 3) hint = Math.max(hint, 0.65);
    else hint = Math.max(hint, 0.5);
  }
  if (model.running) hint = Math.min(1, hint + 0.05);
  return Math.min(1, Math.max(0, hint));
}

/**
 * Build danh sach muc cho model picker cua UI tu cac nguon da
 * detect: moi model mot muc, ghi ro chay qua nguon nao + tai khoan
 * nao, muc cua nguon bi tat thi `enabled: false` (UI mo di, khong
 * cho chon). Sap xep: model dang chay truoc, roi theo qualityHint.
 */
export function buildModelPickerEntries(sources: readonly LocalSource[]): ModelPickerEntry[] {
  const entries: ModelPickerEntry[] = [];
  for (const source of sources) {
    for (const model of source.models) {
      entries.push({
        id: `${source.id}:${model.id}`,
        modelLabel: model.displayName,
        sourceLabel: source.label,
        sourceId: source.id,
        accountLabel: source.accountLabel,
        enabled: source.enabled,
        available: source.available,
        running: model.running ?? false,
        qualityHint: qualityHintForModel(model, source.kind),
      });
    }
  }
  return entries.sort((a, b) => {
    if ((a.running ?? false) !== (b.running ?? false)) return a.running ? -1 : 1;
    if (b.qualityHint !== a.qualityHint) return b.qualityHint - a.qualityHint;
    return a.modelLabel.localeCompare(b.modelLabel);
  });
}

/** Loc entry chi lay muc duoc bat + kha dung (de picker chon). */
export function selectablePickerEntries(entries: readonly ModelPickerEntry[]): ModelPickerEntry[] {
  return entries.filter((e) => e.enabled && e.available);
}
