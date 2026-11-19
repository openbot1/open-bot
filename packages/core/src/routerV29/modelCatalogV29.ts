/**
 * Model catalog v29 (v1.42, Doi T5) — refresh danh muc model cho router.
 *
 * Y tuong hoc tu nghien cuu v1.42 (docs/repo-survey-v142.md, muc 4):
 * voice realtime 2026 co 3 kien truc (cascaded / turn-based realtime /
 * full-duplex); cascaded ~500-800ms, speech-to-speech ~300ms; OpenAI
 * gpt-realtime-2.1 (06/07/2026, 128k context, 32k output) + 2.1 mini;
 * GPT-Live full-duplex GA 10/09/2026 ($0.05/phut); Gemini 3.8 Live GA
 * 15/09/2026 (131k input, async function calling mac dinh, proactive
 * audio). File nay CHI chua metadata/config (ten, context, gia khai
 * bao, capability) — KHONG goi API live that, KHONG fetch gia live.
 *
 * Gia la uoc tinh khai bao do host cap nhat qua refreshModelCatalogV29
 * (giong defaultCostCandidates v118); router khong tu fetch gia.
 * Gia tri mac dinh duoi day la so khai bao de routing/cost-ledger co
 * the chay offline; host co the ghi de bat ky muc nao.
 */

/** Kien truc voice realtime (nghien cuu v1.42 muc 4). */
export type RealtimeArchitectureV29 = 'cascaded' | 'turn-based-realtime' | 'full-duplex';

/** Loai model trong catalog. */
export type ModelKindV29 = 'text' | 'realtime' | 'live' | 'embedding' | 'image' | 'audio';

/** Nhom model (family) de loc + hien thi. */
export type ModelFamilyV29 =
  | 'gpt-realtime'
  | 'gpt-live'
  | 'gemini-live'
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'grok'
  | 'local'
  | 'other';

/** Capability cua mot model (co gi thi router moi chon cho yeu cau do). */
export interface ModelCapabilitiesV29 {
  /** Goi voice realtime (speech-to-speech). */
  realtimeVoice: boolean;
  /** Full-duplex: noi + nghe dong thoi, barge-in. */
  fullDuplex: boolean;
  /** Nguoi dung chen ngang khi model dang noi. */
  bargeIn: boolean;
  /** Function calling bat dong bo (khong chan audio). */
  asyncFunctionCalling: boolean;
  /** Model tu chu dong noi truoc (proactive audio). */
  proactiveAudio: boolean;
  /** Goi tool/function (text). */
  toolCalling: boolean;
  /** Hieu anh / da phuong thuc. */
  vision: boolean;
  /** Tra token theo luong (streaming). */
  streaming: boolean;
  /** Context dai (>= 128k). */
  longContext: boolean;
  /** Server tu quyet dinh khi nao tra loi (server-driven response). */
  serverDrivenResponse: boolean;
  /** Context chi append (khong sua lich su cu) — kieu GPT-Live. */
  contextAppendOnly: boolean;
}

/** Mot muc trong catalog model v29. */
export interface ModelCatalogEntryV29 {
  /** Id duy nhat, vi du 'gpt-realtime-2.1'. */
  modelId: string;
  /** Provider: 'openai' | 'gemini' | 'anthropic' | 'xai' | 'ollama' | ... */
  provider: string;
  family: ModelFamilyV29;
  displayName: string;
  kind: ModelKindV29;
  /** Kien truc voice; chi co y nghia khi kind la realtime/live. */
  architecture: RealtimeArchitectureV29;
  /** Context toi da (token). */
  contextTokens: number;
  /** Output toi da (token). */
  maxOutputTokens: number;
  /** USD / 1k token input (uoc tinh khai bao). */
  inputPricePer1kUsd: number;
  /** USD / 1k token output (uoc tinh khai bao). */
  outputPricePer1kUsd: number;
  /** USD / phut (chi voice realtime/live tinh theo phut, vi du GPT-Live 0.05). */
  perMinuteUsd?: number;
  /** Chat luong uoc tinh 0..1 (model manh nhat = 1). */
  quality: number;
  /** Do tre dien hinh mot turn (ms) — uoc tinh khai bao. */
  typicalLatencyMs: number;
  capabilities: ModelCapabilitiesV29;
  /** Ngay phat hanh YYYY-MM-DD (neu biet). */
  released?: string;
  /** Ghi chu ngan cho UI (khong chua secret). */
  notes?: string;
  /** true = da ngung ho tro, router mac dinh khong chon. */
  deprecated?: boolean;
}

/** Capability "khong co gi" — diem khoi cho tung muc. */
export function emptyCapabilitiesV29(): ModelCapabilitiesV29 {
  return {
    realtimeVoice: false,
    fullDuplex: false,
    bargeIn: false,
    asyncFunctionCalling: false,
    proactiveAudio: false,
    toolCalling: false,
    vision: false,
    streaming: false,
    longContext: false,
    serverDrivenResponse: false,
    contextAppendOnly: false,
  };
}

/** Capability text model co ban: tool + streaming (+ vision neu truyen). */
export function textCapabilitiesV29(vision = true): ModelCapabilitiesV29 {
  return {
    ...emptyCapabilitiesV29(),
    toolCalling: true,
    vision,
    streaming: true,
    longContext: true,
  };
}

/** Capability realtime day du kieu GPT-Live / Gemini 3.8 Live. */
export function fullDuplexCapabilitiesV29(overrides?: Partial<ModelCapabilitiesV29>): ModelCapabilitiesV29 {
  return {
    realtimeVoice: true,
    fullDuplex: true,
    bargeIn: true,
    asyncFunctionCalling: true,
    proactiveAudio: true,
    toolCalling: true,
    vision: true,
    streaming: true,
    longContext: true,
    serverDrivenResponse: true,
    contextAppendOnly: true,
    ...overrides,
  };
}

/**
 * Catalog mac dinh v29 — 12 muc (chi metadata).
 *
 * Nguon so lieu (nghien cuu v1.42, chi lay so da cong bo):
 * - gpt-realtime-2.1: 128k context, 32k output (06/07/2026).
 * - GPT-Live (gpt-live): full-duplex GA 10/09/2026, $0.05/phut.
 * - Gemini 3.8 Live: 131k input, async function calling mac dinh,
 *   proactive audio (GA 15/09/2026).
 * Gia token la uoc tinh khai bao (xem dau file), host ghi de duoc.
 */
export function defaultModelCatalogV29(): ModelCatalogEntryV29[] {
  return [
    {
      modelId: 'gpt-realtime-2.1',
      provider: 'openai',
      family: 'gpt-realtime',
      displayName: 'GPT Realtime 2.1',
      kind: 'realtime',
      architecture: 'full-duplex',
      contextTokens: 131072,
      maxOutputTokens: 32768,
      inputPricePer1kUsd: 0.04,
      outputPricePer1kUsd: 0.16,
      quality: 0.95,
      typicalLatencyMs: 300,
      capabilities: fullDuplexCapabilitiesV29({ contextAppendOnly: false }),
      released: '2026-07-06',
      notes: 'Speech-to-speech realtime, 128k context, 32k output.',
    },
    {
      modelId: 'gpt-realtime-2.1-mini',
      provider: 'openai',
      family: 'gpt-realtime',
      displayName: 'GPT Realtime 2.1 Mini',
      kind: 'realtime',
      architecture: 'turn-based-realtime',
      contextTokens: 131072,
      maxOutputTokens: 32768,
      inputPricePer1kUsd: 0.008,
      outputPricePer1kUsd: 0.032,
      quality: 0.85,
      typicalLatencyMs: 250,
      capabilities: fullDuplexCapabilitiesV29({
        fullDuplex: false,
        bargeIn: false,
        proactiveAudio: false,
        serverDrivenResponse: false,
        contextAppendOnly: false,
      }),
      released: '2026-07-06',
      notes: 'Ban nhe, re hon cua gpt-realtime-2.1; turn-based realtime.',
    },
    {
      modelId: 'gpt-live',
      provider: 'openai',
      family: 'gpt-live',
      displayName: 'GPT-Live',
      kind: 'live',
      architecture: 'full-duplex',
      contextTokens: 131072,
      maxOutputTokens: 32768,
      inputPricePer1kUsd: 0.04,
      outputPricePer1kUsd: 0.16,
      perMinuteUsd: 0.05,
      quality: 0.93,
      typicalLatencyMs: 280,
      capabilities: fullDuplexCapabilitiesV29(),
      released: '2026-09-10',
      notes: 'Full-duplex GA, server-driven, tu quyet barge-in, context append-only, $0.05/phut.',
    },
    {
      modelId: 'gemini-3.8-live',
      provider: 'gemini',
      family: 'gemini-live',
      displayName: 'Gemini 3.8 Live',
      kind: 'live',
      architecture: 'full-duplex',
      contextTokens: 131072,
      maxOutputTokens: 32768,
      inputPricePer1kUsd: 0.002,
      outputPricePer1kUsd: 0.008,
      quality: 0.94,
      typicalLatencyMs: 300,
      capabilities: fullDuplexCapabilitiesV29({ contextAppendOnly: false, serverDrivenResponse: false }),
      released: '2026-09-15',
      notes: '131k input, async function calling mac dinh, proactive audio luon bat.',
    },
    {
      modelId: 'gemini-3-live',
      provider: 'gemini',
      family: 'gemini-live',
      displayName: 'Gemini 3 Live',
      kind: 'live',
      architecture: 'turn-based-realtime',
      contextTokens: 131072,
      maxOutputTokens: 32768,
      inputPricePer1kUsd: 0.0015,
      outputPricePer1kUsd: 0.006,
      quality: 0.92,
      typicalLatencyMs: 320,
      capabilities: fullDuplexCapabilitiesV29({
        fullDuplex: false,
        bargeIn: false,
        contextAppendOnly: false,
        serverDrivenResponse: false,
      }),
      released: '2026-09-15',
      notes: 'Thanh vien Gemini 3.x live family, turn-based realtime.',
    },
    {
      modelId: 'gemini-3-flash-live',
      provider: 'gemini',
      family: 'gemini-live',
      displayName: 'Gemini 3 Flash Live',
      kind: 'live',
      architecture: 'turn-based-realtime',
      contextTokens: 131072,
      maxOutputTokens: 16384,
      inputPricePer1kUsd: 0.0005,
      outputPricePer1kUsd: 0.002,
      quality: 0.85,
      typicalLatencyMs: 220,
      capabilities: fullDuplexCapabilitiesV29({
        fullDuplex: false,
        bargeIn: false,
        proactiveAudio: false,
        contextAppendOnly: false,
        serverDrivenResponse: false,
      }),
      released: '2026-09-15',
      notes: 'Ban flash re nhat cua Gemini 3.x live family, do tre thap.',
    },
    {
      modelId: 'gemini-2.5-flash',
      provider: 'gemini',
      family: 'gemini',
      displayName: 'Gemini 2.5 Flash',
      kind: 'text',
      architecture: 'cascaded',
      contextTokens: 1048576,
      maxOutputTokens: 65536,
      inputPricePer1kUsd: 0.0003,
      outputPricePer1kUsd: 0.0025,
      quality: 0.82,
      typicalLatencyMs: 400,
      capabilities: textCapabilitiesV29(true),
      notes: 'Text nhanh, re, context 1M — fallback text cho yeu cau thuong.',
    },
    {
      modelId: 'gemini-2.5-pro',
      provider: 'gemini',
      family: 'gemini',
      displayName: 'Gemini 2.5 Pro',
      kind: 'text',
      architecture: 'cascaded',
      contextTokens: 1048576,
      maxOutputTokens: 65536,
      inputPricePer1kUsd: 0.00125,
      outputPricePer1kUsd: 0.01,
      quality: 0.93,
      typicalLatencyMs: 800,
      capabilities: textCapabilitiesV29(true),
      notes: 'Text manh, context 1M — fallback khi can chat luong cao.',
    },
    {
      modelId: 'claude-sonnet-4-5',
      provider: 'anthropic',
      family: 'anthropic',
      displayName: 'Claude Sonnet 4.5',
      kind: 'text',
      architecture: 'cascaded',
      contextTokens: 200000,
      maxOutputTokens: 64000,
      inputPricePer1kUsd: 0.003,
      outputPricePer1kUsd: 0.015,
      quality: 0.93,
      typicalLatencyMs: 900,
      capabilities: textCapabilitiesV29(true),
      notes: 'Text chat luong cao, tool calling tot.',
    },
    {
      modelId: 'gpt-5-mini',
      provider: 'openai',
      family: 'openai',
      displayName: 'GPT-5 Mini',
      kind: 'text',
      architecture: 'cascaded',
      contextTokens: 400000,
      maxOutputTokens: 128000,
      inputPricePer1kUsd: 0.00025,
      outputPricePer1kUsd: 0.002,
      quality: 0.88,
      typicalLatencyMs: 600,
      capabilities: textCapabilitiesV29(true),
      notes: 'Text re, context lon — fallback kinh te cho task kho vua.',
    },
    {
      modelId: 'grok-4.7',
      provider: 'xai',
      family: 'grok',
      displayName: 'Grok 4.7',
      kind: 'text',
      architecture: 'cascaded',
      contextTokens: 256000,
      maxOutputTokens: 64000,
      inputPricePer1kUsd: 0.002,
      outputPricePer1kUsd: 0.01,
      quality: 0.94,
      typicalLatencyMs: 1000,
      capabilities: textCapabilitiesV29(true),
      notes: 'Text manh nha xAI — fallback chat luong cao.',
    },
    {
      modelId: 'qwen3-4b',
      provider: 'ollama',
      family: 'local',
      displayName: 'Qwen3 4B (local)',
      kind: 'text',
      architecture: 'cascaded',
      contextTokens: 32768,
      maxOutputTokens: 8192,
      inputPricePer1kUsd: 0,
      outputPricePer1kUsd: 0,
      quality: 0.7,
      typicalLatencyMs: 350,
      capabilities: textCapabilitiesV29(false),
      notes: 'Chay local mien phi qua Ollama — lua chon re nhat.',
    },
  ];
}

/** Tim model theo id (tra undefined neu khong co). */
export function findModelV29(
  catalog: ModelCatalogEntryV29[],
  modelId: string,
): ModelCatalogEntryV29 | undefined {
  return catalog.find((m) => m.modelId === modelId);
}

/** Dieu kien loc catalog. */
export interface CatalogFilterV29 {
  provider?: string;
  family?: ModelFamilyV29;
  kind?: ModelKindV29;
  architecture?: RealtimeArchitectureV29;
  /** Chi model realtime/live (voice). */
  realtimeOnly?: boolean;
  /** Chi model con ho tro (loai deprecated). Mac dinh true. */
  excludeDeprecated?: boolean;
  /** Context toi thieu (token). */
  minContextTokens?: number;
  /** Gia input toi da (USD/1k). */
  maxInputPricePer1kUsd?: number;
  /** Chat luong toi thieu 0..1. */
  minQuality?: number;
  /** Capability bat buoc (tat ca phai true). */
  requireCapabilities?: Partial<ModelCapabilitiesV29>;
}

/** Loc catalog theo dieu kien (khong doi mang goc). */
export function filterCatalogV29(
  catalog: ModelCatalogEntryV29[],
  filter: CatalogFilterV29 = {},
): ModelCatalogEntryV29[] {
  const excludeDeprecated = filter.excludeDeprecated !== false;
  return catalog.filter((m) => {
    if (excludeDeprecated && m.deprecated) return false;
    if (filter.provider !== undefined && m.provider !== filter.provider) return false;
    if (filter.family !== undefined && m.family !== filter.family) return false;
    if (filter.kind !== undefined && m.kind !== filter.kind) return false;
    if (filter.architecture !== undefined && m.architecture !== filter.architecture) return false;
    if (filter.realtimeOnly && m.kind !== 'realtime' && m.kind !== 'live') return false;
    if (filter.minContextTokens !== undefined && m.contextTokens < filter.minContextTokens) return false;
    if (filter.maxInputPricePer1kUsd !== undefined && m.inputPricePer1kUsd > filter.maxInputPricePer1kUsd) return false;
    if (filter.minQuality !== undefined && m.quality < filter.minQuality) return false;
    if (filter.requireCapabilities) {
      for (const [key, wanted] of Object.entries(filter.requireCapabilities)) {
        if (wanted === true && !m.capabilities[key as keyof ModelCapabilitiesV29]) return false;
      }
    }
    return true;
  });
}

/** Ket qua validate mot muc catalog. */
export interface CatalogValidationV29 {
  ok: boolean;
  errors: string[];
}

/** Validate mot muc catalog (thuan, khong network). */
export function validateModelCatalogEntryV29(entry: ModelCatalogEntryV29): CatalogValidationV29 {
  const errors: string[] = [];
  if (!entry || typeof entry !== 'object') return { ok: false, errors: ['entry phai la object.'] };
  if (!entry.modelId || entry.modelId.trim() === '') errors.push('modelId khong duoc rong.');
  if (!entry.provider || entry.provider.trim() === '') errors.push('provider khong duoc rong.');
  if (!entry.displayName || entry.displayName.trim() === '') errors.push('displayName khong duoc rong.');
  if (!Number.isFinite(entry.contextTokens) || entry.contextTokens <= 0) {
    errors.push('contextTokens phai la so duong.');
  }
  if (!Number.isFinite(entry.maxOutputTokens) || entry.maxOutputTokens <= 0) {
    errors.push('maxOutputTokens phai la so duong.');
  }
  if (entry.maxOutputTokens > entry.contextTokens) {
    errors.push('maxOutputTokens khong duoc lon hon contextTokens.');
  }
  if (!Number.isFinite(entry.inputPricePer1kUsd) || entry.inputPricePer1kUsd < 0) {
    errors.push('inputPricePer1kUsd phai >= 0.');
  }
  if (!Number.isFinite(entry.outputPricePer1kUsd) || entry.outputPricePer1kUsd < 0) {
    errors.push('outputPricePer1kUsd phai >= 0.');
  }
  if (entry.perMinuteUsd !== undefined && (!Number.isFinite(entry.perMinuteUsd) || entry.perMinuteUsd < 0)) {
    errors.push('perMinuteUsd phai >= 0.');
  }
  if (!Number.isFinite(entry.quality) || entry.quality < 0 || entry.quality > 1) {
    errors.push('quality phai trong khoang 0..1.');
  }
  if (!Number.isFinite(entry.typicalLatencyMs) || entry.typicalLatencyMs <= 0) {
    errors.push('typicalLatencyMs phai la so duong.');
  }
  if (entry.released !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(entry.released)) {
    errors.push('released phai co dang YYYY-MM-DD.');
  }
  if (!entry.capabilities || typeof entry.capabilities !== 'object') {
    errors.push('capabilities phai la object.');
  } else {
    const caps = entry.capabilities;
    if ((entry.kind === 'realtime' || entry.kind === 'live') && !caps.realtimeVoice) {
      errors.push('model realtime/live phai co capabilities.realtimeVoice = true.');
    }
    if (entry.kind === 'realtime' || entry.kind === 'live') {
      if (entry.architecture === 'cascaded') {
        errors.push('model realtime/live khong dung kien truc cascaded.');
      }
    }
    if (caps.fullDuplex && entry.architecture !== 'full-duplex') {
      errors.push('capabilities.fullDuplex = true thi architecture phai la full-duplex.');
    }
    if (caps.bargeIn && !caps.fullDuplex && entry.architecture !== 'turn-based-realtime') {
      errors.push('bargeIn can full-duplex hoac turn-based-realtime.');
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Ket qua uoc tinh chi phi mot luot dung model. */
export interface ModelCostEstimateV29 {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  minutes: number;
  inputUsd: number;
  outputUsd: number;
  perMinuteUsd: number;
  /** Tong USD (token + theo phut neu co). */
  totalUsd: number;
  /** Co so tinh: 'tokens' | 'minutes' | 'tokens+minutes'. */
  basis: 'tokens' | 'minutes' | 'tokens+minutes';
}

/** Uoc tinh chi phi: token theo gia/1k + phut theo perMinuteUsd (neu co). */
export function estimateModelCostV29(
  entry: ModelCatalogEntryV29,
  usage: { inputTokens?: number; outputTokens?: number; minutes?: number },
): ModelCostEstimateV29 {
  const inputTokens = Math.max(0, Math.floor(usage.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.floor(usage.outputTokens ?? 0));
  const minutes = Math.max(0, usage.minutes ?? 0);
  const inputUsd = (inputTokens / 1000) * entry.inputPricePer1kUsd;
  const outputUsd = (outputTokens / 1000) * entry.outputPricePer1kUsd;
  const perMinuteUsd = entry.perMinuteUsd !== undefined ? minutes * entry.perMinuteUsd : 0;
  const hasTokens = inputTokens > 0 || outputTokens > 0;
  const hasMinutes = minutes > 0 && entry.perMinuteUsd !== undefined;
  return {
    modelId: entry.modelId,
    inputTokens,
    outputTokens,
    minutes,
    inputUsd,
    outputUsd,
    perMinuteUsd,
    totalUsd: inputUsd + outputUsd + perMinuteUsd,
    basis: hasTokens && hasMinutes ? 'tokens+minutes' : hasMinutes ? 'minutes' : 'tokens',
  };
}

/** Ket qua refresh catalog (merge thuan — host cung cap muc moi, khong fetch). */
export interface CatalogRefreshResultV29 {
  catalog: ModelCatalogEntryV29[];
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
  /** Loi validate cua cac muc bi tu choi (khong vao catalog). */
  rejected: { modelId: string; errors: string[] }[];
}

/**
 * Refresh catalog: gop cac muc host cung cap vao catalog hien co.
 * - Muc moi hop le -> added; muc da co, khac noi dung -> updated;
 *   giong het -> unchanged; muc sai validate -> rejected (khong ghi de).
 * - Neu `removeMissing` true, muc cu khong co trong `updates` se bi
 *   removed (mac dinh false — refresh khong xoa gi de tranh mat model).
 * Khong goi network, khong doc credential.
 */
export function refreshModelCatalogV29(
  current: ModelCatalogEntryV29[],
  updates: ModelCatalogEntryV29[],
  options: { removeMissing?: boolean } = {},
): CatalogRefreshResultV29 {
  const byId = new Map(current.map((m) => [m.modelId, m]));
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const rejected: { modelId: string; errors: string[] }[] = [];
  const seen = new Set<string>();

  for (const update of updates) {
    const id = update?.modelId ?? '';
    seen.add(id);
    const validation = validateModelCatalogEntryV29(update);
    if (!validation.ok) {
      rejected.push({ modelId: id || '(thieu modelId)', errors: validation.errors });
      continue;
    }
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, update);
      added.push(id);
    } else if (JSON.stringify(existing) === JSON.stringify(update)) {
      unchanged.push(id);
    } else {
      byId.set(id, update);
      updated.push(id);
    }
  }

  const removed: string[] = [];
  if (options.removeMissing) {
    for (const id of [...byId.keys()]) {
      if (!seen.has(id)) {
        byId.delete(id);
        removed.push(id);
      }
    }
  }
  // unchanged: chi cac muc co trong updates va giong het ban cu.
  // Cac muc cu khong nam trong updates van o trong catalog nhung
  // khong thuoc bucket nao (refresh khong xoa gi khi removeMissing=false).
  return { catalog: [...byId.values()], added, updated, removed, unchanged, rejected };
}

/** Tom tat catalog cho UI / tool. */
export interface CatalogSummaryV29 {
  totalModels: number;
  activeModels: number;
  deprecatedModels: number;
  byProvider: Record<string, number>;
  byKind: Record<string, number>;
  byArchitecture: Record<string, number>;
  realtimeModels: string[];
  cheapestInputModelId: string | null;
  cheapestInputPricePer1kUsd: number | null;
  fastestModelId: string | null;
  fastestLatencyMs: number | null;
  maxContextTokens: number;
  maxContextModelId: string | null;
}

/** Tom tat catalog (chi dem, khong goi network). */
export function summarizeCatalogV29(catalog: ModelCatalogEntryV29[]): CatalogSummaryV29 {
  const active = catalog.filter((m) => !m.deprecated);
  const byProvider: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const byArchitecture: Record<string, number> = {};
  for (const m of catalog) {
    byProvider[m.provider] = (byProvider[m.provider] ?? 0) + 1;
    byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
    byArchitecture[m.architecture] = (byArchitecture[m.architecture] ?? 0) + 1;
  }
  let cheapest: ModelCatalogEntryV29 | null = null;
  let fastest: ModelCatalogEntryV29 | null = null;
  let maxCtx: ModelCatalogEntryV29 | null = null;
  for (const m of active) {
    if (!cheapest || m.inputPricePer1kUsd < cheapest.inputPricePer1kUsd) cheapest = m;
    if (!fastest || m.typicalLatencyMs < fastest.typicalLatencyMs) fastest = m;
    if (!maxCtx || m.contextTokens > maxCtx.contextTokens) maxCtx = m;
  }
  return {
    totalModels: catalog.length,
    activeModels: active.length,
    deprecatedModels: catalog.length - active.length,
    byProvider,
    byKind,
    byArchitecture,
    realtimeModels: active
      .filter((m) => m.kind === 'realtime' || m.kind === 'live')
      .map((m) => m.modelId),
    cheapestInputModelId: cheapest ? cheapest.modelId : null,
    cheapestInputPricePer1kUsd: cheapest ? cheapest.inputPricePer1kUsd : null,
    fastestModelId: fastest ? fastest.modelId : null,
    fastestLatencyMs: fastest ? fastest.typicalLatencyMs : null,
    maxContextTokens: maxCtx ? maxCtx.contextTokens : 0,
    maxContextModelId: maxCtx ? maxCtx.modelId : null,
  };
}

/** Sap xep catalog theo gia input tang dan (re nhat truoc). */
export function sortCatalogByInputPriceV29(catalog: ModelCatalogEntryV29[]): ModelCatalogEntryV29[] {
  return [...catalog].sort(
    (a, b) => a.inputPricePer1kUsd - b.inputPricePer1kUsd || a.modelId.localeCompare(b.modelId),
  );
}

/** Sap xep catalog theo do tre tang dan (nhanh nhat truoc). */
export function sortCatalogByLatencyV29(catalog: ModelCatalogEntryV29[]): ModelCatalogEntryV29[] {
  return [...catalog].sort(
    (a, b) => a.typicalLatencyMs - b.typicalLatencyMs || a.modelId.localeCompare(b.modelId),
  );
}
