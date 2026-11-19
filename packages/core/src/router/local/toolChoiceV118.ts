/**
 * Tool-choice capability matrix + request-param builder (v1.41, Doi T3).
 *
 * Y tuong tu survey docs/repo-survey-v141.md §1 "Cam bay provider 2026"
 * (chi hoc y tuong, khong copy code/text/tai san cua bat ky repo nao):
 * - Claude lon (Fable / Mythos / Opus / Sonnet 5.5) tra 400 voi
 *   `tool_choice: any` / `tool` — chi chap nhan `auto` / `none`.
 * - Beta `inline-tools-2026-09-15` cho doi tool giua hoi thoai khong pha
 *   prompt cache (xem inlineToolsV118.ts).
 * - API version `2026-10-21` bo `temperature` / `top_p` / `top_k` —
 *   gui kem du mac dinh cung 400.
 *
 * Module nay thuan logic (khong goi API that, khong doc credential):
 * cho provider + model + tool_choice yeu cau, tra che do duoc ep
 * (enforced), ly do, canh bao, va bo tham so request da loc sach
 * (khong gui tham so sampling bi cam o API version moi).
 *
 * Quy tac mac dinh (fail-closed): provider/model chua biet -> chi cho
 * `auto` / `none`, khong cho ep `any` / `tool`, parallel = false,
 * maxTools = 32; nguoi goi phai dang ky ro rang moi mo rong.
 */

/** Che do tool_choice ma caller co the yeu cau. */
export type ToolChoiceMode = 'auto' | 'none' | 'any' | 'tool';

/** Dang tool_choice da chuan hoa de gui len provider. */
export type NormalizedToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

/** Provider ma router biet (id on dinh, khong phai ten hien thi). */
export type RouterV118ProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'xai'
  | 'deepseek'
  | 'ollama'
  | 'llamacpp'
  | 'vllm'
  | 'sglang'
  | 'openai-compatible';

export const ROUTER_V118_PROVIDER_IDS: readonly RouterV118ProviderId[] = [
  'anthropic',
  'openai',
  'gemini',
  'xai',
  'deepseek',
  'ollama',
  'llamacpp',
  'vllm',
  'sglang',
  'openai-compatible',
] as const;

/** Beta header inline-tools cua Anthropic (survey §1). */
export const INLINE_TOOLS_BETA = 'inline-tools-2026-09-15' as const;

/** API version tu do tro di bo temperature/top_p/top_k (survey §1). */
export const SAMPLING_PARAMS_REMOVED_API_VERSION = '2026-10-21' as const;

/** Cac tham so sampling co the bi cam theo API version. */
export const SAMPLING_PARAM_NAMES: readonly string[] = [
  'temperature',
  'top_p',
  'top_k',
] as const;

export type SamplingParamName = (typeof SAMPLING_PARAM_NAMES)[number];

/**
 * Nang luc tool_choice cua mot provider (khai bao, theo survey + doc
 * cong khai; capability THAT do probe luc chay ghi de — xem
 * inferenceBrokerV2/probe.ts cho engine local).
 */
export interface ProviderToolChoiceCapability {
  provider: RouterV118ProviderId;
  /** Cac che do tool_choice provider chap nhan. */
  allowedModes: readonly ToolChoiceMode[];
  /** Che do mac dinh khi caller khong chi dinh. */
  defaultMode: ToolChoiceMode;
  /** Co goi nhieu tool song song trong 1 turn khong. */
  parallelCalls: boolean;
  /** So tool toi da gui kem trong 1 request (0 = khong gioi han khai bao). */
  maxTools: number;
  /** Co ho tro beta inline-tools (doi tool giua hoi thoai) khong. */
  inlineToolsSupported: boolean;
  /** API version tu do tro di bo tham so sampling ('' = khong ap dung). */
  samplingRemovedSinceApiVersion: string;
  /** Ghi chu ve han che (de giai thich trong log/UI). */
  note: string;
}

/** Ghi de nang luc theo model (model cu the chat hon muc provider). */
export interface ModelToolChoiceOverride {
  /** Pattern model id — khop chinh xac hoac prefix ket thuc bang `*`. */
  modelPattern: string;
  allowedModes?: readonly ToolChoiceMode[];
  parallelCalls?: boolean;
  maxTools?: number;
  inlineToolsSupported?: boolean;
  samplingRemovedSinceApiVersion?: string;
  note?: string;
}

/** Mot dong trong ma tran: capability provider + override theo model. */
export interface ProviderCapabilityEntry {
  capability: ProviderToolChoiceCapability;
  modelOverrides: readonly ModelToolChoiceOverride[];
}

function cap(
  provider: RouterV118ProviderId,
  allowedModes: readonly ToolChoiceMode[],
  opts: Partial<Omit<ProviderToolChoiceCapability, 'provider' | 'allowedModes'>> & {
    defaultMode?: ToolChoiceMode;
  } = {},
): ProviderToolChoiceCapability {
  return {
    provider,
    allowedModes,
    defaultMode: opts.defaultMode ?? 'auto',
    parallelCalls: opts.parallelCalls ?? true,
    maxTools: opts.maxTools ?? 128,
    inlineToolsSupported: opts.inlineToolsSupported ?? false,
    samplingRemovedSinceApiVersion: opts.samplingRemovedSinceApiVersion ?? '',
    note: opts.note ?? '',
  };
}

/**
 * Ma tran capability theo provider/model — tam 2026-11 (survey §1).
 *
 * - anthropic: model lon 5.5 / Fable / Mythos chi `auto`/`none`; model
 *   cu hon van cho `any`/`tool`. Beta inline-tools co san tu
 *   `inline-tools-2026-09-15`; API version `2026-10-21` bo sampling.
 * - openai: day du 4 che do, parallel that, max 128 tool.
 * - gemini: `auto`/`none`/`any` (qua function_calling_config mode
 *   AUTO/NONE/ANY); ep mot tool cu the (`tool`) chi qua
 *   allowed_function_names — router coi nhu khong ho tro truc tiep
 *   nen ep xuong `any` kem ghi chu.
 * - xai (Grok): tuong thich OpenAI, day du 4 che do.
 * - deepseek: `auto`/`none`/`tool`, khong `any` rieng (ep ve `auto`).
 * - ollama: nhan `tools` nhung KHONG ho tro `tool_choice` (xem
 *   inferenceBrokerV2/capabilityMatrix.ts) — moi che do ep deu ve
 *   `auto` (nghia la "gui tool, de model tu quyet"), parallel tuy
 *   model, max 64.
 * - llamacpp: co tool_choice qua jinja handler, day du, parallel TAT
 *   mac dinh (xem capabilityMatrix.ts).
 * - vllm: can `--enable-auto-tool-choice`; forced call chi dam bao
 *   parse duoc — router gioi han `tool` o model da bat strict.
 * - sglang: structured output first-class, day du 4 che do.
 * - openai-compatible (chung): chi dam bao `auto`/`none`.
 */
export const PROVIDER_TOOL_CHOICE_MATRIX: Readonly<Record<RouterV118ProviderId, ProviderCapabilityEntry>> = {
  anthropic: {
    capability: cap(
      'anthropic',
      ['auto', 'none', 'any', 'tool'],
      {
        parallelCalls: true,
        maxTools: 256,
        inlineToolsSupported: true,
        samplingRemovedSinceApiVersion: SAMPLING_PARAMS_REMOVED_API_VERSION,
        note: 'Large models (5.5/Fable/Mythos) accept only auto/none — see model overrides.',
      },
    ),
    modelOverrides: [
      {
        modelPattern: 'claude-opus-5*',
        allowedModes: ['auto', 'none'],
        note: 'Claude Opus 5.x returns 400 for tool_choice any/tool; only auto/none.',
      },
      {
        modelPattern: 'claude-sonnet-5*',
        allowedModes: ['auto', 'none'],
        note: 'Claude Sonnet 5.x returns 400 for tool_choice any/tool; only auto/none.',
      },
      {
        modelPattern: 'claude-fable*',
        allowedModes: ['auto', 'none'],
        note: 'Claude Fable returns 400 for tool_choice any/tool; only auto/none.',
      },
      {
        modelPattern: 'claude-mythos*',
        allowedModes: ['auto', 'none'],
        note: 'Claude Mythos returns 400 for tool_choice any/tool; only auto/none.',
      },
      {
        modelPattern: 'claude-opus-4*',
        allowedModes: ['auto', 'none', 'any', 'tool'],
        note: 'Claude Opus 4.x still accepts any/tool.',
      },
      {
        modelPattern: 'claude-sonnet-4*',
        allowedModes: ['auto', 'none', 'any', 'tool'],
        note: 'Claude Sonnet 4.x still accepts any/tool.',
      },
    ],
  },
  openai: {
    capability: cap('openai', ['auto', 'none', 'any', 'tool'], {
      parallelCalls: true,
      maxTools: 128,
      note: 'Full tool_choice support; parallel calls supported.',
    }),
    modelOverrides: [],
  },
  gemini: {
    capability: cap('gemini', ['auto', 'none', 'any'], {
      defaultMode: 'auto',
      parallelCalls: true,
      maxTools: 128,
      note: 'Forcing one specific tool is done via allowed_function_names, not a tool_choice "tool" mode — router downgrades "tool" to "any".',
    }),
    modelOverrides: [],
  },
  xai: {
    capability: cap('xai', ['auto', 'none', 'any', 'tool'], {
      parallelCalls: true,
      maxTools: 128,
      note: 'Grok (xAI) is OpenAI-compatible for tool_choice.',
    }),
    modelOverrides: [],
  },
  deepseek: {
    capability: cap('deepseek', ['auto', 'none', 'tool'], {
      parallelCalls: true,
      maxTools: 128,
      note: 'No standalone "any" mode — requests for "any" fall back to "auto".',
    }),
    modelOverrides: [],
  },
  ollama: {
    capability: cap('ollama', ['auto'], {
      defaultMode: 'auto',
      parallelCalls: false,
      maxTools: 64,
      note: 'Ollama accepts tools but does NOT support tool_choice: forcing or forbidding is not honoured — everything behaves as auto.',
    }),
    modelOverrides: [
      {
        modelPattern: 'qwen2.5*',
        parallelCalls: true,
        note: 'Qwen 2.5 tool models on Ollama can emit parallel calls.',
      },
      {
        modelPattern: 'llama3*',
        parallelCalls: true,
        note: 'Llama 3.x tool models on Ollama can emit parallel calls.',
      },
    ],
  },
  llamacpp: {
    capability: cap('llamacpp', ['auto', 'none', 'any', 'tool'], {
      parallelCalls: true,
      maxTools: 128,
      note: 'llama.cpp server with --jinja: native function calling; parallel calls ON by default.',
    }),
    modelOverrides: [],
  },
  vllm: {
    capability: cap('vllm', ['auto', 'none', 'any', 'tool'], {
      parallelCalls: true,
      maxTools: 128,
      note: 'Needs --enable-auto-tool-choice + --tool-call-parser; forced calls only guarantee a parseable call, not a correct one — validate every call.',
    }),
    modelOverrides: [],
  },
  sglang: {
    capability: cap('sglang', ['auto', 'none', 'any', 'tool'], {
      parallelCalls: true,
      maxTools: 128,
      note: 'Structured output first-class; full tool_choice support.',
    }),
    modelOverrides: [],
  },
  'openai-compatible': {
    capability: cap('openai-compatible', ['auto', 'none'], {
      parallelCalls: false,
      maxTools: 32,
      note: 'Unknown OpenAI-compatible endpoint — only auto/none are guaranteed.',
    }),
    modelOverrides: [],
  },
};

/** Capability mac dinh cho provider chua biet (fail-closed). */
export const UNKNOWN_PROVIDER_CAPABILITY: ProviderToolChoiceCapability = cap(
  'openai-compatible',
  ['auto', 'none'],
  {
    parallelCalls: false,
    maxTools: 32,
    note: 'Unknown provider — fail-closed: only auto/none, no parallel calls, max 32 tools.',
  },
);

/** Khop pattern `prefix*` hoac chinh xac (khong phan biet hoa/thuong). */
export function modelPatternMatches(pattern: string, modelId: string): boolean {
  const p = pattern.trim().toLowerCase();
  const m = modelId.trim().toLowerCase();
  if (p === '' || m === '') return false;
  if (p.endsWith('*')) return m.startsWith(p.slice(0, -1));
  return p === m;
}

/** Tim override phu hop nhat cho model (pattern dai nhat thang). */
export function findModelOverride(
  entry: ProviderCapabilityEntry,
  modelId: string,
): ModelToolChoiceOverride | null {
  let best: ModelToolChoiceOverride | null = null;
  let bestLen = -1;
  for (const o of entry.modelOverrides) {
    if (modelPatternMatches(o.modelPattern, modelId) && o.modelPattern.length > bestLen) {
      best = o;
      bestLen = o.modelPattern.length;
    }
  }
  return best;
}

/**
 * Capability hieu dung cho (provider, model): muc provider bi override
 * theo model ghi de tung truong (khong thay doi ma tran goc).
 */
export function effectiveCapability(
  provider: string,
  modelId: string,
): ProviderToolChoiceCapability {
  const id = (ROUTER_V118_PROVIDER_IDS as readonly string[]).includes(provider)
    ? (provider as RouterV118ProviderId)
    : null;
  if (id === null) return { ...UNKNOWN_PROVIDER_CAPABILITY };
  const entry = PROVIDER_TOOL_CHOICE_MATRIX[id];
  const base = entry.capability;
  const override = modelId ? findModelOverride(entry, modelId) : null;
  if (override === null) return { ...base, allowedModes: [...base.allowedModes] };
  return {
    ...base,
    allowedModes: override.allowedModes ? [...override.allowedModes] : [...base.allowedModes],
    parallelCalls: override.parallelCalls ?? base.parallelCalls,
    maxTools: override.maxTools ?? base.maxTools,
    inlineToolsSupported: override.inlineToolsSupported ?? base.inlineToolsSupported,
    samplingRemovedSinceApiVersion:
      override.samplingRemovedSinceApiVersion ?? base.samplingRemovedSinceApiVersion,
    note: override.note ?? base.note,
  };
}

/** Yeu cau resolve tool_choice tu caller. */
export interface ResolveToolChoiceInput {
  provider: string;
  modelId: string;
  /** Che do caller muon (undefined = dung default cua provider). */
  requested?: ToolChoiceMode;
  /** Ten tool muon ep khi requested = 'tool'. */
  toolName?: string;
  /** So tool dinh gui kem (de kiem tra maxTools). */
  toolCount?: number;
}

/** Ket qua resolve: che do that su se gui + ly do + canh bao. */
export interface ResolvedToolChoice {
  provider: string;
  modelId: string;
  requested: ToolChoiceMode;
  enforced: ToolChoiceMode;
  /** Dang chuan hoa gui len provider (null khi enforced = none? van gui {type:'none'}). */
  normalized: NormalizedToolChoice;
  changed: boolean;
  parallelCalls: boolean;
  maxTools: number;
  toolCountOk: boolean;
  warnings: string[];
  reasons: string[];
}

function normalizeChoice(mode: ToolChoiceMode, toolName?: string): NormalizedToolChoice {
  if (mode === 'tool') {
    return { type: 'tool', name: typeof toolName === 'string' && toolName !== '' ? toolName : '' };
  }
  return { type: mode };
}

/**
 * Ep tool_choice theo capability that cua (provider, model).
 *
 * - `any`/`tool` tren Claude lon -> `auto` (ke kem ly do 400).
 * - `tool` tren Gemini -> `any` (Gemini ep tool cu the bang
 *   allowed_function_names, khong phai tool_choice).
 * - `any` tren DeepSeek -> `auto`.
 * - Bat ky che do ep nao tren Ollama -> `auto` (Ollama khong ton trong
 *   tool_choice); `none` tren Ollama van giu `auto` kem canh bao vi
 *   "cam tool" khong thuc thi duoc — caller muon cam that phai dung
 *   cach khong gui `tools` (xem buildProviderRequestParams).
 * - `tool` thieu ten tool -> `any` (neu cho phep) hoac `auto`.
 * - toolCount > maxTools -> canh bao, khong tu cat (caller quyet dinh
 *   cat tool nao; cat bay co the pha prompt cache — xem inlineTools).
 */
export function resolveToolChoice(input: ResolveToolChoiceInput): ResolvedToolChoice {
  const provider = typeof input.provider === 'string' ? input.provider : '';
  const modelId = typeof input.modelId === 'string' ? input.modelId : '';
  const cap = effectiveCapability(provider, modelId);
  const requested: ToolChoiceMode = input.requested ?? cap.defaultMode;
  const warnings: string[] = [];
  const reasons: string[] = [];
  let enforced: ToolChoiceMode = requested;

  if (!cap.allowedModes.includes(requested)) {
    if (provider === 'anthropic' && (requested === 'any' || requested === 'tool')) {
      reasons.push(
        `Model ${modelId || '(unknown)'} tren Anthropic chi chap nhan tool_choice auto/none — ${requested} se tra 400, ep xuong auto.`,
      );
    } else if (provider === 'ollama') {
      reasons.push(
        'Ollama khong ho tro tool_choice — moi che do ep deu hanh xu nhu auto.',
      );
    } else if (provider === 'gemini' && requested === 'tool') {
      reasons.push(
        'Gemini khong co che do tool_choice "tool" — ep tool cu the bang allowed_function_names, router ha xuong any.',
      );
      enforced = 'any';
    } else if (provider === 'deepseek' && requested === 'any') {
      reasons.push('DeepSeek khong co che do "any" rieng — ha xuong auto.');
      enforced = 'auto';
    } else {
      reasons.push(
        `Provider ${provider || '(unknown)'} khong ho tro tool_choice "${requested}" — ha xuong ${cap.defaultMode}.`,
      );
      enforced = cap.defaultMode;
    }
    if (enforced === requested) {
      // Truong hop chi co ly do chung o tren nhung enforced chua doi
      // (vd anthropic/ollama): ha ve che do an toan nhat duoc phep.
      enforced = cap.allowedModes.includes('auto') ? 'auto' : cap.allowedModes[0] ?? 'auto';
    }
    warnings.push(`tool_choice "${requested}" khong duoc ho tro — da ep xuong "${enforced}".`);
  }

  if (enforced === 'tool') {
    if (typeof input.toolName !== 'string' || input.toolName.trim() === '') {
      reasons.push('tool_choice "tool" thieu ten tool — ha xuong any (neu cho phep) hoac auto.');
      warnings.push('tool_choice "tool" thieu toolName.');
      enforced = cap.allowedModes.includes('any') ? 'any' : 'auto';
    }
  }

  if (provider === 'ollama' && requested === 'none') {
    warnings.push(
      'Ollama khong ton trong tool_choice "none" — muon cam tool that, dung khong gui "tools" trong request (xem buildProviderRequestParams).',
    );
  }

  const toolCount = typeof input.toolCount === 'number' ? input.toolCount : 0;
  const toolCountOk = cap.maxTools === 0 || toolCount <= cap.maxTools;
  if (!toolCountOk) {
    warnings.push(
      `Dinh gui ${toolCount} tool, vuot maxTools=${cap.maxTools} cua ${provider}/${modelId || '(unknown)'} — can cat bot tool truoc khi gui.`,
    );
  }

  return {
    provider,
    modelId,
    requested,
    enforced,
    normalized: normalizeChoice(enforced, input.toolName),
    changed: enforced !== requested,
    parallelCalls: cap.parallelCalls,
    maxTools: cap.maxTools,
    toolCountOk,
    warnings,
    reasons,
  };
}

/** So sanh version dang `YYYY-MM-DD` (tra ve <0 / 0 / >0). */
export function compareApiVersion(a: string, b: string): number {
  const pa = a.split('-').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('-').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * API version nay co bo tham so sampling khong (Anthropic >= 2026-10-21).
 * Chi ap dung khi provider khai bao samplingRemovedSinceApiVersion.
 */
export function samplingParamsRemoved(
  provider: string,
  modelId: string,
  apiVersion: string,
): boolean {
  if (!apiVersion) return false;
  const cap = effectiveCapability(provider, modelId);
  if (!cap.samplingRemovedSinceApiVersion) return false;
  return compareApiVersion(apiVersion, cap.samplingRemovedSinceApiVersion) >= 0;
}

/** Input xay request param gui len provider. */
export interface BuildRequestParamsInput {
  provider: string;
  modelId: string;
  apiVersion?: string;
  /** Beta header muon dung (vd inline-tools-2026-09-15). */
  betaHeaders?: string[];
  toolChoice?: ToolChoiceMode;
  toolName?: string;
  toolCount?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  tools?: unknown[];
}

/** Request param da loc sach, san sang gui. */
export interface BuiltRequestParams {
  provider: string;
  modelId: string;
  apiVersion: string;
  toolChoice: ResolvedToolChoice;
  /** Beta header that su gui (chi nhung header provider ho tro). */
  betaHeaders: string[];
  /** Co gui `tools` khong (false khi tool_choice none tren Ollama...). */
  includeTools: boolean;
  sampling: { temperature?: number; topP?: number; topK?: number };
  /** Tham so sampling nao bi loai + ly do. */
  droppedSamplingParams: { name: SamplingParamName; reason: string }[];
  maxTokens?: number;
  warnings: string[];
}

/**
 * Xay bo tham so request an toan cho provider:
 * - Ep tool_choice theo ma tran (resolveToolChoice).
 * - Loai temperature/top_p/top_k khi apiVersion >= 2026-10-21 (ke ca
 *   khi caller de gia tri mac dinh — survey §1: 400 ca khi de default).
 * - `none` tren Ollama -> khong gui `tools` (vi Ollama khong ton trong
 *   tool_choice none); cac provider khac van gui tools kem
 *   tool_choice none.
 * - Beta inline-tools chi gui khi provider ho tro (Anthropic) va
 *   caller yeu cau dung header do.
 */
export function buildProviderRequestParams(input: BuildRequestParamsInput): BuiltRequestParams {
  const provider = input.provider ?? '';
  const modelId = input.modelId ?? '';
  const apiVersion = input.apiVersion ?? '';
  const toolChoice = resolveToolChoice({
    provider,
    modelId,
    requested: input.toolChoice,
    toolName: input.toolName,
    toolCount: input.toolCount ?? (Array.isArray(input.tools) ? input.tools.length : 0),
  });
  const warnings: string[] = [...toolChoice.warnings];
  const droppedSamplingParams: { name: SamplingParamName; reason: string }[] = [];
  const sampling: { temperature?: number; topP?: number; topK?: number } = {};
  const removed = samplingParamsRemoved(provider, modelId, apiVersion);
  const entries: [SamplingParamName, number | undefined][] = [
    ['temperature', input.temperature],
    ['top_p', input.topP],
    ['top_k', input.topK],
  ];
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    if (removed) {
      droppedSamplingParams.push({
        name,
        reason: `API version ${apiVersion} da bo ${name} — gui kem se tra 400.`,
      });
      warnings.push(`Da loai ${name} (API version ${apiVersion} khong con ho tro).`);
    } else if (name === 'temperature') {
      sampling.temperature = value;
    } else if (name === 'top_p') {
      sampling.topP = value;
    } else {
      sampling.topK = value;
    }
  }

  const cap = effectiveCapability(provider, modelId);
  const betaHeaders: string[] = [];
  for (const header of input.betaHeaders ?? []) {
    if (header === INLINE_TOOLS_BETA) {
      if (cap.inlineToolsSupported) {
        betaHeaders.push(header);
      } else {
        warnings.push(`Beta ${header} khong duoc ${provider} ho tro — da bo.`);
      }
    } else {
      // Beta header la: giu nguyen (router khong biet het beta moi),
      // nhung ghi chu de caller tu chiu trach nhiem.
      betaHeaders.push(header);
    }
  }

  // Ollama: "none" chi co nghia khi khong gui tools.
  const includeTools =
    Array.isArray(input.tools) && input.tools.length > 0
      ? !(provider === 'ollama' && toolChoice.enforced === 'auto' && input.toolChoice === 'none')
      : false;
  if (provider === 'ollama' && input.toolChoice === 'none' && includeTools === false) {
    warnings.push('Ollama: tool_choice "none" duoc thuc thi bang cach khong gui "tools".');
  }

  return {
    provider,
    modelId,
    apiVersion,
    toolChoice,
    betaHeaders,
    includeTools,
    sampling,
    droppedSamplingParams,
    maxTokens: input.maxTokens,
    warnings,
  };
}

/**
 * Loi 400 co phai do tool_choice khong duoc ho tro khong — de retry
 * ha cap xuong auto roi thu lai mot lan (xem retryBackoffV118.ts).
 * Nhan dien theo status + noi dung message cua provider.
 */
export function isToolChoice400Error(status: number, message: string): boolean {
  if (status !== 400) return false;
  const m = (message ?? '').toLowerCase();
  return (
    m.includes('tool_choice') ||
    m.includes('tool choice') ||
    (m.includes('tool') && m.includes('not supported')) ||
    m.includes('invalid tool_choice')
  );
}

/** Loi 400 co phai do tham so sampling bi bo khong. */
export function isSamplingParam400Error(status: number, message: string): boolean {
  if (status !== 400) return false;
  const m = (message ?? '').toLowerCase();
  return (
    (m.includes('temperature') || m.includes('top_p') || m.includes('top_k')) &&
    (m.includes('not supported') ||
      m.includes('removed') ||
      m.includes('unknown parameter') ||
      m.includes('unsupported parameter') ||
      m.includes('deprecated'))
  );
}

/** Tom tat ma tran dang bang markdown (de hien thi trong UI/log). */
export function summarizeCapabilityMatrix(): string {
  const lines: string[] = [
    '| Provider | tool_choice | Parallel | Max tools | Inline-tools |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const id of ROUTER_V118_PROVIDER_IDS) {
    const c = PROVIDER_TOOL_CHOICE_MATRIX[id].capability;
    lines.push(
      `| ${id} | ${c.allowedModes.join('/')} | ${c.parallelCalls ? 'yes' : 'no'} | ${c.maxTools} | ${c.inlineToolsSupported ? 'yes' : 'no'} |`,
    );
  }
  return lines.join('\n');
}
