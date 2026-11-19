/**
 * Model catalog v30 (v1.44, Doi T5) — danh muc model co version cho router.
 *
 * Noi tiep catalog v29 (chi metadata, khong goi API live): v30 them
 * versioning + co che refresh co kiem soat.
 *
 * - Moi catalog co `catalogVersion` (so nguyen tang dan) + `schemaVersion`
 *   + `updatedAt` + `source` ('bundled' | 'host-snapshot' | 'manual').
 * - Refresh THU CONG: host dua snapshot (danh sach entry) -> ham ap dung
 *   tra bao cao diff (added / updated / unchanged / rejected / removed).
 *   Router KHONG tu fetch tu mang; snapshot do host cap (file local,
 *   UI nhap tay, hoac host tu lay tu API provider bang key cua user).
 * - Refresh TU DONG CO KIEM SOAT: chi chay khi policy cho phep
 *   (`autoRefresh.enabled`), khong qua `minIntervalMs` lan, va chi ap
 *   dung snapshot host da chuan bi san — xem `shouldAutoRefreshV30`.
 *   Khong co auto-refresh nao tu goi mang trong file nay.
 * - Stale marking: entry nao `updatedAt` qua `maxAgeMs` thi danh dau
 *   stale de UI/router biet ma refresh, khong tu xoa.
 *
 * Gia la uoc tinh khai bao do host cap nhat; router khong tu fetch gia.
 * Khong doc/gui credential, khong goi model that, khong goi API live.
 */

/** Loai model trong catalog. */
export type ModelKindV30 =
  | 'text'
  | 'reasoning'
  | 'realtime'
  | 'embedding'
  | 'image'
  | 'audio';

/** Nhom model (family) de loc + hien thi. */
export type ModelFamilyV30 =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'grok'
  | 'deepseek'
  | 'ollama'
  | 'local'
  | 'openai-compatible'
  | 'other';

/** Provider id (chuoi mo — provider moi chi can them ten, khong doi code). */
export type ModelProviderV30 = string;

/** Capability cua mot model (co gi thi router moi chon cho yeu cau do). */
export interface ModelCapabilitiesV30 {
  /** Goi tool/function (text). */
  toolCalling: boolean;
  /** Hieu anh / da phuong thuc. */
  vision: boolean;
  /** Tra token theo luong (streaming). */
  streaming: boolean;
  /** Context dai (>= 128k). */
  longContext: boolean;
  /** Goi voice realtime (speech-to-speech). */
  realtimeVoice: boolean;
  /** Ly luan sau (reasoning) — can nhieu buoc suy nghi. */
  reasoning: boolean;
  /** Tra JSON co cau truc (structured output). */
  jsonMode: boolean;
}

/** Capability rong — dung lam gia tri mac dinh an toan (khong khai gi). */
export function emptyCapabilitiesV30(): ModelCapabilitiesV30 {
  return {
    toolCalling: false,
    vision: false,
    streaming: false,
    longContext: false,
    realtimeVoice: false,
    reasoning: false,
    jsonMode: false,
  };
}

/** Mot muc trong danh muc model. */
export interface ModelCatalogEntryV30 {
  /** Provider so huu model (vd 'openai', 'gemini', 'ollama'). */
  provider: ModelProviderV30;
  /** Id model duy nhat trong provider (vd 'gpt-5.2', 'gemini-3-pro'). */
  modelId: string;
  /** Nhom model de loc/hien thi. */
  family: ModelFamilyV30;
  /** Loai model. */
  kind: ModelKindV30;
  /** Context window (token). */
  contextTokens: number;
  /** Output toi da (token). 0 = khong khai. */
  maxOutputTokens: number;
  /** Gia input USD / 1M token. 0 = mien phi / local. */
  inputPricePerMillionUsd: number;
  /** Gia output USD / 1M token. 0 = mien phi / local. */
  outputPricePerMillionUsd: number;
  /** Gia theo phut (chi model realtime/live). Khong co thi undefined. */
  perMinuteUsd?: number;
  /** Diem chat luong khai bao 0..1 (cao hon = tot hon). */
  qualityScore: number;
  /** Do tre uoc tinh khai bao (ms) khi chua co so do that. */
  estimatedLatencyMs: number;
  /** Capability cua model. */
  capabilities: ModelCapabilitiesV30;
  /** Tag tuy y de loc (vd 'flagship', 'cheap', 'local', 'vision'). */
  tags: string[];
  /** Model da ngung ho tro / sap ngung — router tranh chon mac dinh. */
  deprecated: boolean;
  /** Ly do deprecated (neu co). */
  deprecatedReason?: string;
  /** Version catalog ma entry nay xuat hien lan dau. */
  addedInCatalogVersion: number;
  /** Lan cuoi entry duoc cap nhat (epoch ms). */
  updatedAt: number;
}

/** Version hien tai cua schema catalog (doi khi doi hinh entry). */
export const MODEL_CATALOG_SCHEMA_VERSION_V30 = 1;

/** Version catalog mac dinh di kem build nay. */
export const DEFAULT_MODEL_CATALOG_VERSION_V30 = 30;

/** Nguon goc cua mot ban catalog. */
export type ModelCatalogSourceV30 = 'bundled' | 'host-snapshot' | 'manual';

/** Toan bo danh muc model co version. */
export interface ModelCatalogV30 {
  /** Version schema (doi khi doi hinh entry). */
  schemaVersion: number;
  /** Version catalog — tang moi lan refresh ap dung thay doi. */
  catalogVersion: number;
  /** Lan cuoi catalog duoc cap nhat (epoch ms). */
  updatedAt: number;
  /** Catalog nay tu dau ra. */
  source: ModelCatalogSourceV30;
  /** Cac muc model. */
  entries: ModelCatalogEntryV30[];
}

/** Khoa duy nhat cua mot entry: provider + modelId. */
export function modelCatalogKeyV30(
  provider: string,
  modelId: string,
): string {
  return `${provider}::${modelId}`;
}

/** Khoa cua mot entry. */
export function entryKeyV30(entry: ModelCatalogEntryV30): string {
  return modelCatalogKeyV30(entry.provider, entry.modelId);
}

function baseEntryV30(
  partial: Omit<ModelCatalogEntryV30, 'addedInCatalogVersion' | 'updatedAt'>,
): ModelCatalogEntryV30 {
  return {
    ...partial,
    addedInCatalogVersion: DEFAULT_MODEL_CATALOG_VERSION_V30,
    updatedAt: 0,
  };
}

/**
 * Catalog mac dinh (bundled, version 30) — 18 muc bao phu 4 nhom provider
 * ma nhiem vu yeu cau: OpenAI-compatible, Gemini, Ollama, local.
 *
 * Gia + context la so khai bao tai thoi diem viet (de routing/cost chay
 * offline); host ghi de qua refreshModelCatalogV30 bat ky luc nao.
 * Model local / Ollama gia 0, do tre khai bao thap (chay tren may user).
 */
export function defaultModelCatalogV30(now = Date.now()): ModelCatalogV30 {
  const entries: ModelCatalogEntryV30[] = [
    baseEntryV30({
      provider: 'openai',
      modelId: 'gpt-5.2',
      family: 'openai',
      kind: 'reasoning',
      contextTokens: 400000,
      maxOutputTokens: 128000,
      inputPricePerMillionUsd: 5,
      outputPricePerMillionUsd: 15,
      qualityScore: 0.97,
      estimatedLatencyMs: 2400,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: true,
        jsonMode: true,
      },
      tags: ['flagship', 'reasoning'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'openai',
      modelId: 'gpt-5.2-mini',
      family: 'openai',
      kind: 'text',
      contextTokens: 400000,
      maxOutputTokens: 128000,
      inputPricePerMillionUsd: 0.5,
      outputPricePerMillionUsd: 2,
      qualityScore: 0.9,
      estimatedLatencyMs: 1200,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: true,
        jsonMode: true,
      },
      tags: ['cheap', 'balanced'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'openai',
      modelId: 'gpt-5.2-nano',
      family: 'openai',
      kind: 'text',
      contextTokens: 400000,
      maxOutputTokens: 128000,
      inputPricePerMillionUsd: 0.05,
      outputPricePerMillionUsd: 0.4,
      qualityScore: 0.78,
      estimatedLatencyMs: 600,
      capabilities: {
        toolCalling: true,
        vision: false,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: false,
        jsonMode: true,
      },
      tags: ['cheap', 'fast'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'openai',
      modelId: 'gpt-realtime-2.1',
      family: 'openai',
      kind: 'realtime',
      contextTokens: 131072,
      maxOutputTokens: 32768,
      inputPricePerMillionUsd: 4,
      outputPricePerMillionUsd: 16,
      qualityScore: 0.9,
      estimatedLatencyMs: 300,
      capabilities: {
        toolCalling: true,
        vision: false,
        streaming: true,
        longContext: true,
        realtimeVoice: true,
        reasoning: false,
        jsonMode: false,
      },
      tags: ['realtime', 'voice'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'openai',
      modelId: 'gpt-4.1',
      family: 'openai',
      kind: 'text',
      contextTokens: 1048576,
      maxOutputTokens: 32768,
      inputPricePerMillionUsd: 2,
      outputPricePerMillionUsd: 8,
      qualityScore: 0.88,
      estimatedLatencyMs: 1500,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: false,
        jsonMode: true,
      },
      tags: ['long-context'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'anthropic',
      modelId: 'claude-opus-4.5',
      family: 'anthropic',
      kind: 'reasoning',
      contextTokens: 200000,
      maxOutputTokens: 64000,
      inputPricePerMillionUsd: 5,
      outputPricePerMillionUsd: 25,
      qualityScore: 0.97,
      estimatedLatencyMs: 2600,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: true,
        jsonMode: true,
      },
      tags: ['flagship', 'reasoning'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4.5',
      family: 'anthropic',
      kind: 'text',
      contextTokens: 200000,
      maxOutputTokens: 64000,
      inputPricePerMillionUsd: 3,
      outputPricePerMillionUsd: 15,
      qualityScore: 0.93,
      estimatedLatencyMs: 1600,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: true,
        jsonMode: true,
      },
      tags: ['balanced'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'gemini',
      modelId: 'gemini-3-pro',
      family: 'gemini',
      kind: 'reasoning',
      contextTokens: 1048576,
      maxOutputTokens: 65536,
      inputPricePerMillionUsd: 2,
      outputPricePerMillionUsd: 12,
      qualityScore: 0.96,
      estimatedLatencyMs: 2000,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: true,
        jsonMode: true,
      },
      tags: ['flagship', 'reasoning', 'long-context'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'gemini',
      modelId: 'gemini-3-flash',
      family: 'gemini',
      kind: 'text',
      contextTokens: 1048576,
      maxOutputTokens: 65536,
      inputPricePerMillionUsd: 0.5,
      outputPricePerMillionUsd: 3,
      qualityScore: 0.9,
      estimatedLatencyMs: 900,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: true,
        jsonMode: true,
      },
      tags: ['cheap', 'fast', 'balanced'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      family: 'gemini',
      kind: 'text',
      contextTokens: 1048576,
      maxOutputTokens: 65536,
      inputPricePerMillionUsd: 0.3,
      outputPricePerMillionUsd: 2.5,
      qualityScore: 0.85,
      estimatedLatencyMs: 800,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: false,
        jsonMode: true,
      },
      tags: ['cheap', 'fast'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'gemini',
      modelId: 'gemini-embedding-001',
      family: 'gemini',
      kind: 'embedding',
      contextTokens: 2048,
      maxOutputTokens: 0,
      inputPricePerMillionUsd: 0.15,
      outputPricePerMillionUsd: 0,
      qualityScore: 0.8,
      estimatedLatencyMs: 400,
      capabilities: {
        toolCalling: false,
        vision: false,
        streaming: false,
        longContext: false,
        realtimeVoice: false,
        reasoning: false,
        jsonMode: false,
      },
      tags: ['embedding'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'xai',
      modelId: 'grok-4.7',
      family: 'grok',
      kind: 'reasoning',
      contextTokens: 2000000,
      maxOutputTokens: 64000,
      inputPricePerMillionUsd: 3,
      outputPricePerMillionUsd: 15,
      qualityScore: 0.95,
      estimatedLatencyMs: 2200,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: true,
        jsonMode: true,
      },
      tags: ['flagship', 'long-context'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      family: 'deepseek',
      kind: 'text',
      contextTokens: 131072,
      maxOutputTokens: 8192,
      inputPricePerMillionUsd: 0.27,
      outputPricePerMillionUsd: 1.1,
      qualityScore: 0.86,
      estimatedLatencyMs: 1400,
      capabilities: {
        toolCalling: true,
        vision: false,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: false,
        jsonMode: true,
      },
      tags: ['cheap', 'openai-compatible'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'openrouter',
      modelId: 'openrouter-auto',
      family: 'openai-compatible',
      kind: 'text',
      contextTokens: 200000,
      maxOutputTokens: 64000,
      inputPricePerMillionUsd: 1,
      outputPricePerMillionUsd: 4,
      qualityScore: 0.85,
      estimatedLatencyMs: 1800,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: false,
        jsonMode: true,
      },
      tags: ['openai-compatible', 'auto'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'ollama',
      modelId: 'llama-4-scout',
      family: 'ollama',
      kind: 'text',
      contextTokens: 131072,
      maxOutputTokens: 8192,
      inputPricePerMillionUsd: 0,
      outputPricePerMillionUsd: 0,
      qualityScore: 0.72,
      estimatedLatencyMs: 500,
      capabilities: {
        toolCalling: true,
        vision: true,
        streaming: true,
        longContext: true,
        realtimeVoice: false,
        reasoning: false,
        jsonMode: true,
      },
      tags: ['local', 'free', 'vision'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'ollama',
      modelId: 'qwen3-32b',
      family: 'ollama',
      kind: 'reasoning',
      contextTokens: 32768,
      maxOutputTokens: 8192,
      inputPricePerMillionUsd: 0,
      outputPricePerMillionUsd: 0,
      qualityScore: 0.78,
      estimatedLatencyMs: 700,
      capabilities: {
        toolCalling: true,
        vision: false,
        streaming: true,
        longContext: false,
        realtimeVoice: false,
        reasoning: true,
        jsonMode: true,
      },
      tags: ['local', 'free', 'reasoning'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'ollama',
      modelId: 'nomic-embed-text',
      family: 'ollama',
      kind: 'embedding',
      contextTokens: 8192,
      maxOutputTokens: 0,
      inputPricePerMillionUsd: 0,
      outputPricePerMillionUsd: 0,
      qualityScore: 0.7,
      estimatedLatencyMs: 200,
      capabilities: {
        toolCalling: false,
        vision: false,
        streaming: false,
        longContext: false,
        realtimeVoice: false,
        reasoning: false,
        jsonMode: false,
      },
      tags: ['local', 'free', 'embedding'],
      deprecated: false,
    }),
    baseEntryV30({
      provider: 'local',
      modelId: 'local-echo',
      family: 'local',
      kind: 'text',
      contextTokens: 8192,
      maxOutputTokens: 2048,
      inputPricePerMillionUsd: 0,
      outputPricePerMillionUsd: 0,
      qualityScore: 0.1,
      estimatedLatencyMs: 50,
      capabilities: {
        toolCalling: false,
        vision: false,
        streaming: false,
        longContext: false,
        realtimeVoice: false,
        reasoning: false,
        jsonMode: false,
      },
      tags: ['local', 'free', 'fallback-only'],
      deprecated: false,
    }),
  ];
  for (const entry of entries) entry.updatedAt = now;
  return {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION_V30,
    catalogVersion: DEFAULT_MODEL_CATALOG_VERSION_V30,
    updatedAt: now,
    source: 'bundled',
    entries,
  };
}

/** Loi validate mot entry (chuoi rong = hop le). */
export function validateModelCatalogEntryV30(
  entry: unknown,
): string[] {
  const errors: string[] = [];
  if (!entry || typeof entry !== 'object') return ['entry must be an object'];
  const e = entry as Partial<ModelCatalogEntryV30>;
  if (!e.provider || typeof e.provider !== 'string') {
    errors.push('provider is required');
  }
  if (!e.modelId || typeof e.modelId !== 'string') {
    errors.push('modelId is required');
  }
  if (typeof e.contextTokens !== 'number' || e.contextTokens <= 0) {
    errors.push('contextTokens must be > 0');
  }
  if (typeof e.maxOutputTokens !== 'number' || e.maxOutputTokens < 0) {
    errors.push('maxOutputTokens must be >= 0');
  }
  if (
    typeof e.inputPricePerMillionUsd !== 'number' ||
    e.inputPricePerMillionUsd < 0
  ) {
    errors.push('inputPricePerMillionUsd must be >= 0');
  }
  if (
    typeof e.outputPricePerMillionUsd !== 'number' ||
    e.outputPricePerMillionUsd < 0
  ) {
    errors.push('outputPricePerMillionUsd must be >= 0');
  }
  if (
    e.perMinuteUsd !== undefined &&
    (typeof e.perMinuteUsd !== 'number' || e.perMinuteUsd < 0)
  ) {
    errors.push('perMinuteUsd must be >= 0');
  }
  if (
    typeof e.qualityScore !== 'number' ||
    e.qualityScore < 0 ||
    e.qualityScore > 1
  ) {
    errors.push('qualityScore must be between 0 and 1');
  }
  if (
    typeof e.estimatedLatencyMs !== 'number' ||
    e.estimatedLatencyMs < 0
  ) {
    errors.push('estimatedLatencyMs must be >= 0');
  }
  if (e.kind === 'realtime' && e.capabilities && !e.capabilities.realtimeVoice) {
    errors.push('realtime model must have realtimeVoice capability');
  }
  if (e.kind === 'embedding' && e.capabilities?.toolCalling) {
    errors.push('embedding model must not declare toolCalling');
  }
  if (e.deprecated && !e.deprecatedReason) {
    errors.push('deprecated model should carry deprecatedReason');
  }
  if (!Array.isArray(e.tags)) errors.push('tags must be an array');
  if (!e.capabilities || typeof e.capabilities !== 'object') {
    errors.push('capabilities is required');
  }
  return errors;
}

/** Tim mot model theo provider + modelId. */
export function findModelV30(
  catalog: ModelCatalogV30,
  provider: string,
  modelId: string,
): ModelCatalogEntryV30 | undefined {
  const key = modelCatalogKeyV30(provider, modelId);
  return catalog.entries.find((e) => entryKeyV30(e) === key);
}

/** Dieu kien loc catalog. */
export interface CatalogFilterV30 {
  provider?: string;
  family?: ModelFamilyV30;
  kind?: ModelKindV30;
  tag?: string;
  /** Chi model co tool calling. */
  toolCalling?: boolean;
  /** Chi model co vision. */
  vision?: boolean;
  /** Chi model co voice realtime. */
  realtimeVoice?: boolean;
  /** Loai bo model deprecated (mac dinh true). */
  excludeDeprecated?: boolean;
  /** Context toi thieu. */
  minContextTokens?: number;
  /** Gia input toi da (USD/1M). */
  maxInputPricePerMillionUsd?: number;
}

/** Loc catalog theo dieu kien (khong doi catalog goc). */
export function filterCatalogV30(
  catalog: ModelCatalogV30,
  filter: CatalogFilterV30 = {},
): ModelCatalogEntryV30[] {
  const excludeDeprecated = filter.excludeDeprecated !== false;
  return catalog.entries.filter((e) => {
    if (filter.provider && e.provider !== filter.provider) return false;
    if (filter.family && e.family !== filter.family) return false;
    if (filter.kind && e.kind !== filter.kind) return false;
    if (filter.tag && !e.tags.includes(filter.tag)) return false;
    if (filter.toolCalling && !e.capabilities.toolCalling) return false;
    if (filter.vision && !e.capabilities.vision) return false;
    if (filter.realtimeVoice && !e.capabilities.realtimeVoice) return false;
    if (excludeDeprecated && e.deprecated) return false;
    if (
      filter.minContextTokens !== undefined &&
      e.contextTokens < filter.minContextTokens
    ) {
      return false;
    }
    if (
      filter.maxInputPricePerMillionUsd !== undefined &&
      e.inputPricePerMillionUsd > filter.maxInputPricePerMillionUsd
    ) {
      return false;
    }
    return true;
  });
}

/** Mot muc snapshot host dua vao de refresh (thieu truong se duoc dien mac dinh). */
export type CatalogSnapshotEntryV30 = Partial<ModelCatalogEntryV30> &
  Pick<ModelCatalogEntryV30, 'provider' | 'modelId'>;

/** Ket qua refresh catalog (diff). */
export interface CatalogRefreshReportV30 {
  /** Version catalog truoc khi refresh. */
  fromVersion: number;
  /** Version catalog sau khi refresh (tang neu co thay doi). */
  toVersion: number;
  /** So entry them moi. */
  added: string[];
  /** So entry cap nhat (gia/context/capability doi). */
  updated: string[];
  /** So entry giong het cu (khong doi). */
  unchanged: string[];
  /** Entry bi tu choi + ly do. */
  rejected: Array<{ key: string; errors: string[] }>;
  /** Entry cu bi xoa vi khong con trong snapshot (chi khi removeMissing). */
  removed: string[];
  /** Co thay doi nao duoc ap dung khong. */
  changed: boolean;
  /** Luc refresh (epoch ms). */
  refreshedAt: number;
}

function entriesEqualV30(
  a: ModelCatalogEntryV30,
  b: ModelCatalogEntryV30,
): boolean {
  return (
    a.family === b.family &&
    a.kind === b.kind &&
    a.contextTokens === b.contextTokens &&
    a.maxOutputTokens === b.maxOutputTokens &&
    a.inputPricePerMillionUsd === b.inputPricePerMillionUsd &&
    a.outputPricePerMillionUsd === b.outputPricePerMillionUsd &&
    a.perMinuteUsd === b.perMinuteUsd &&
    a.qualityScore === b.qualityScore &&
    a.estimatedLatencyMs === b.estimatedLatencyMs &&
    a.deprecated === b.deprecated &&
    a.deprecatedReason === b.deprecatedReason &&
    JSON.stringify(a.capabilities) === JSON.stringify(b.capabilities) &&
    JSON.stringify([...a.tags].sort()) === JSON.stringify([...b.tags].sort())
  );
}

function normalizeSnapshotEntryV30(
  raw: CatalogSnapshotEntryV30,
  catalogVersion: number,
  now: number,
): ModelCatalogEntryV30 {
  return {
    provider: raw.provider,
    modelId: raw.modelId,
    family: raw.family ?? 'other',
    kind: raw.kind ?? 'text',
    contextTokens: raw.contextTokens ?? 8192,
    maxOutputTokens: raw.maxOutputTokens ?? 4096,
    inputPricePerMillionUsd: raw.inputPricePerMillionUsd ?? 0,
    outputPricePerMillionUsd: raw.outputPricePerMillionUsd ?? 0,
    perMinuteUsd: raw.perMinuteUsd,
    qualityScore: raw.qualityScore ?? 0.5,
    estimatedLatencyMs: raw.estimatedLatencyMs ?? 1000,
    capabilities: raw.capabilities ?? emptyCapabilitiesV30(),
    tags: raw.tags ?? [],
    deprecated: raw.deprecated ?? false,
    deprecatedReason: raw.deprecatedReason,
    addedInCatalogVersion:
      raw.addedInCatalogVersion ?? catalogVersion,
    updatedAt: raw.updatedAt ?? now,
  };
}

/**
 * Refresh catalog THU CONG tu snapshot host dua vao.
 *
 * - Entry hop le + moi -> added; hop le + doi -> updated; giong het -> unchanged.
 * - Entry loi validate -> rejected (khong ap dung, catalog cu giu nguyen muc do).
 * - `removeMissing=true`: entry cu khong co trong snapshot se bi xoa
 *   (mac dinh false — an toan: snapshot thieu khong lam mat model).
 * - Co thay doi thi `catalogVersion` +1, `source` thanh 'host-snapshot'
 *   (hoac 'manual' neu host truyen source do); khong doi thi giu version.
 * - Ham pure: khong doi catalog truyen vao, tra catalog moi + bao cao.
 */
export function refreshModelCatalogV30(
  catalog: ModelCatalogV30,
  snapshot: CatalogSnapshotEntryV30[],
  options: {
    removeMissing?: boolean;
    source?: ModelCatalogSourceV30;
    now?: number;
  } = {},
): { catalog: ModelCatalogV30; report: CatalogRefreshReportV30 } {
  const now = options.now ?? Date.now();
  const nextVersion = catalog.catalogVersion + 1;
  const report: CatalogRefreshReportV30 = {
    fromVersion: catalog.catalogVersion,
    toVersion: catalog.catalogVersion,
    added: [],
    updated: [],
    unchanged: [],
    rejected: [],
    removed: [],
    changed: false,
    refreshedAt: now,
  };
  const byKey = new Map<string, ModelCatalogEntryV30>();
  for (const e of catalog.entries) byKey.set(entryKeyV30(e), e);
  const seen = new Set<string>();
  const nextEntries: ModelCatalogEntryV30[] = [];

  for (const raw of snapshot) {
    const key = modelCatalogKeyV30(raw.provider, raw.modelId);
    if (seen.has(key)) {
      report.rejected.push({ key, errors: ['duplicate entry in snapshot'] });
      continue;
    }
    seen.add(key);
    const normalized = normalizeSnapshotEntryV30(raw, nextVersion, now);
    const errors = validateModelCatalogEntryV30(normalized);
    if (errors.length > 0) {
      report.rejected.push({ key, errors });
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      report.added.push(key);
      nextEntries.push(normalized);
    } else if (entriesEqualV30(existing, normalized)) {
      report.unchanged.push(key);
      nextEntries.push(existing);
    } else {
      report.updated.push(key);
      nextEntries.push({
        ...normalized,
        addedInCatalogVersion: existing.addedInCatalogVersion,
      });
    }
  }

  if (options.removeMissing) {
    for (const oldEntry of catalog.entries) {
      const key = entryKeyV30(oldEntry);
      if (!seen.has(key)) report.removed.push(key);
    }
  } else {
    for (const oldEntry of catalog.entries) {
      const key = entryKeyV30(oldEntry);
      if (!seen.has(key)) nextEntries.push(oldEntry);
    }
  }

  report.changed =
    report.added.length > 0 ||
    report.updated.length > 0 ||
    report.removed.length > 0;
  if (report.changed) {
    report.toVersion = nextVersion;
  }
  const nextCatalog: ModelCatalogV30 = {
    schemaVersion: catalog.schemaVersion,
    catalogVersion: report.toVersion,
    updatedAt: report.changed ? now : catalog.updatedAt,
    source: report.changed
      ? (options.source ?? 'host-snapshot')
      : catalog.source,
    entries: nextEntries,
  };
  return { catalog: nextCatalog, report };
}

/** Cau hinh auto-refresh co kiem soat. */
export interface CatalogAutoRefreshPolicyV30 {
  /** Bat auto-refresh (mac dinh tat — user phai bat chu dong). */
  enabled: boolean;
  /** Khoang cach toi thieu giua 2 lan auto-refresh (ms). */
  minIntervalMs: number;
  /** Entry qua tuoi nay thi coi la stale va du dieu kien refresh. */
  staleAfterMs: number;
  /** Luc auto-refresh lan cuoi (epoch ms, 0 = chua bao gio). */
  lastAutoRefreshAt: number;
}

/** Policy auto-refresh mac dinh: TAT, toi thieu 6h/lan, stale sau 24h. */
export function defaultCatalogAutoRefreshPolicyV30(): CatalogAutoRefreshPolicyV30 {
  return {
    enabled: false,
    minIntervalMs: 6 * 60 * 60 * 1000,
    staleAfterMs: 24 * 60 * 60 * 1000,
    lastAutoRefreshAt: 0,
  };
}

/**
 * Co nen chay auto-refresh luc nay khong.
 *
 * Chi true khi: policy enabled + da qua minInterval tu lan truoc +
 * co it nhat 1 entry stale (qua staleAfterMs) hoac chua co entry nao.
 * Ham nay chi QUYET DINH — viec lay snapshot van do host lam.
 */
export function shouldAutoRefreshV30(
  catalog: ModelCatalogV30,
  policy: CatalogAutoRefreshPolicyV30,
  now = Date.now(),
): { should: boolean; reason: string } {
  if (!policy.enabled) return { should: false, reason: 'auto-refresh disabled' };
  // lastAutoRefreshAt === 0 nghia la chua bao gio refresh -> khong ap
  // minInterval (khong the "qua som" khi chua tung chay).
  if (
    policy.lastAutoRefreshAt !== 0 &&
    now - policy.lastAutoRefreshAt < policy.minIntervalMs
  ) {
    return { should: false, reason: 'min interval not reached' };
  }
  if (catalog.entries.length === 0) {
    return { should: true, reason: 'catalog empty' };
  }
  const stale = catalog.entries.some(
    (e) => now - e.updatedAt > policy.staleAfterMs,
  );
  if (!stale) return { should: false, reason: 'no stale entries' };
  return { should: true, reason: 'stale entries present' };
}

/** Entry nao stale (qua maxAgeMs ke tu updatedAt). */
export function staleCatalogEntriesV30(
  catalog: ModelCatalogV30,
  maxAgeMs: number,
  now = Date.now(),
): ModelCatalogEntryV30[] {
  return catalog.entries.filter((e) => now - e.updatedAt > maxAgeMs);
}

/** Uoc tinh chi phi USD cho 1 lan goi (input + output token). */
export function estimateModelCostV30(
  entry: ModelCatalogEntryV30,
  inputTokens: number,
  outputTokens: number,
): number {
  const input = (Math.max(0, inputTokens) / 1_000_000) * entry.inputPricePerMillionUsd;
  const output =
    (Math.max(0, outputTokens) / 1_000_000) * entry.outputPricePerMillionUsd;
  return input + output;
}

/** Tom tat catalog de hien thi / log. */
export function summarizeCatalogV30(catalog: ModelCatalogV30): {
  catalogVersion: number;
  schemaVersion: number;
  source: ModelCatalogSourceV30;
  total: number;
  byProvider: Record<string, number>;
  byKind: Record<string, number>;
  deprecated: number;
  free: number;
  realtime: number;
} {
  const byProvider: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let deprecated = 0;
  let free = 0;
  let realtime = 0;
  for (const e of catalog.entries) {
    byProvider[e.provider] = (byProvider[e.provider] ?? 0) + 1;
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    if (e.deprecated) deprecated += 1;
    if (
      e.inputPricePerMillionUsd === 0 &&
      e.outputPricePerMillionUsd === 0
    ) {
      free += 1;
    }
    if (e.capabilities.realtimeVoice) realtime += 1;
  }
  return {
    catalogVersion: catalog.catalogVersion,
    schemaVersion: catalog.schemaVersion,
    source: catalog.source,
    total: catalog.entries.length,
    byProvider,
    byKind,
    deprecated,
    free,
    realtime,
  };
}
