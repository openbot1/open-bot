/**
 * Inference broker v2 — capability matrix for local engines (v1.33, Doi T5).
 *
 * Y tuong hoc tu survey docs/repo-survey-v133.md muc 4 (local inference
 * llama.cpp / Ollama / vLLM / SGLang), viet lai hoan toan cho open-bot,
 * KHONG copy code/text/tai san cua bat ky repo nao (ke ca xAI / Cursor /
 * Anthropic):
 * - Bon engine, bon viec: Ollama = "Docker cho LLM" (1 lenh cai, 1 lenh
 *   chay, outgrow o ~5 user dong thoi); llama.cpp = engine tham chieu
 *   (C/C++, GGUF, mmap, chay tu Raspberry Pi toi H100, kiem soat
 *   quantization tung layer); vLLM = serving production (PagedAttention,
 *   continuous batching, chunked prefill, prefix caching, speculative
 *   decoding, 10+ user); SGLang = cho agent pipeline (RadixAttention,
 *   disaggregated prefill/decode, structured output first-class).
 * - Tool calling da la chuan o ca 4, nhung cach bat + do tin cay khac
 *   nhau: Ollama nhan `tools` o `/api/chat` (+ endpoint OpenAI-compatible,
 *   nhung KHONG ho tro `tool_choice`); llama.cpp server bat function
 *   calling bang `--jinja`, co handler native cho Llama 3.x / Qwen 2.5 /
 *   Hermes / Mistral Nemo / gpt-oss, parallel call TAT mac dinh, KV cache
 *   quantization manh lam hong tool calling; vLLM can
 *   `--enable-auto-tool-choice` + `--tool-call-parser`
 *   (hermes / llama3_json / openai) — doc thua nhan forced call chi dam
 *   bao parse duoc, khong dam bao dung, auto mode van co the gay schema
 *   neu khong bat strict mode. Bai hoc chung: VALIDATE moi tool call
 *   truoc khi thuc thi (xem validate.ts).
 * - Structured output la grammar, khong phai hy vong: schema-constrained
 *   JSON / GBNF grammar ep output khop schema; Ollama siet grammar ngay
 *   trong runner de agent loop nhan payload da validate, khoi retry
 *   hau xu ly.
 * - Nguong thuc te: Ollama khuyen nghi context >= 64.000 token cho
 *   agent / coding / search; llama.cpp v0.8.0 (28/10/2026) co router mode,
 *   parallel decoding, speculative decoding voi draft model; Ollama server
 *   nghe 127.0.0.1:11434, khong auth — phai bat `OLLAMA_NO_CLOUD=1` tren
 *   may quan ly de giu local-only; gpt-oss-20b chay trong 16GB RAM,
 *   Apache 2.0, function calling + structured output native.
 *
 * Module nay CHI khai bao (declared capability — so lieu tu survey +
 * doc cong khai cua engine, khong phai do that). Capability THAT do
 * probe.ts do luc khoi dong va ghi de muc khai bao trong registry.
 * Router chon engine + model theo task o day (routeTaskToEngineV2);
 * broker.ts noi ket qua nay vao UnifiedRouterV3 (routerV3).
 *
 * Local-first, mien phi, khong du lieu X, khong cloud VM / tai khoan /
 * thanh toan. Khong goi API that trong module nay (thuan, khong I/O);
 * khong doc credential.
 */

import { capabilitiesForModel } from '../routerV3/capabilities';
import type { ModelCapability } from '../routerV3/types';

/** Bon engine local ma broker v2 biet. */
export type InferenceBrokerV2EngineKind = 'ollama' | 'llamacpp' | 'vllm' | 'sglang';

/** Cac engine theo thu tu uu tien mac dinh khi chua co so do that. */
export const INFERENCE_BROKER_V2_ENGINES: readonly InferenceBrokerV2EngineKind[] = [
  'ollama',
  'llamacpp',
  'vllm',
  'sglang',
] as const;

/** Parser tool-call cua mot engine. */
export type InferenceBrokerV2ToolCallParser =
  | 'openai-compatible'
  | 'jinja-native'
  | 'hermes'
  | 'llama3_json'
  | 'openai'
  | 'auto';

/** Dang structured output mot engine ho tro. */
export type InferenceBrokerV2StructuredOutputKind =
  | 'json-schema'
  | 'gbnf-grammar'
  | 'json-mode'
  | 'regex'
  | 'none';

/** Dang batching mot engine dung. */
export type InferenceBrokerV2BatchingKind =
  | 'none'
  | 'continuous-batching'
  | 'chunked-prefill'
  | 'parallel-decoding'
  | 'disaggregated-prefill-decode';

/** Tool calling cua mot engine (khai bao). */
export interface InferenceBrokerV2ToolCalling {
  /** Engine co ho tro tool/function calling khong. */
  supported: boolean;
  /** Parser nao xuat tool call. */
  parser: InferenceBrokerV2ToolCallParser;
  /** Cac parser co the chon khi khoi dong engine (neu co). */
  parserChoices: readonly InferenceBrokerV2ToolCallParser[];
  /** Co goi nhieu tool song song trong 1 turn khong. */
  parallelCalls: boolean;
  /** Parallel co bat mac dinh khong (llama.cpp: TAT mac dinh). */
  parallelByDefault: boolean;
  /** Co ho tro `tool_choice` (ep / cam goi tool) khong. */
  toolChoiceSupported: boolean;
  /** Co strict mode (ep dung schema) khong. */
  strictMode: boolean;
  /** Strict co bat mac dinh khong. */
  strictByDefault: boolean;
  /** Co ho tro MCP native trong runtime khong (xu huong). */
  mcpNative: boolean;
  /** Flag khoi dong can bat de co tool calling ('' = khong can). */
  enableFlag: string;
  /** Ghi chu ve do tin cay (vd forced call chi dam bao parse duoc). */
  reliabilityNote: string;
}

/** Structured output cua mot engine (khai bao). */
export interface InferenceBrokerV2StructuredOutput {
  /** Dang ep output manh nhat engine ho tro. */
  kind: InferenceBrokerV2StructuredOutputKind;
  /** Co nhan JSON Schema truc tiep khong. */
  jsonSchema: boolean;
  /** Co nhan GBNF grammar khong. */
  gbnfGrammar: boolean;
  /** Co JSON mode long (khong ep schema) khong. */
  jsonMode: boolean;
  /** Co ep regex khong. */
  regex: boolean;
  /** Grammar co duoc siet ngay trong runner khong (Ollama). */
  enforcedInRunner: boolean;
  /** Ghi chu. */
  note: string;
}

/** Batching / throughput cua mot engine (khai bao). */
export interface InferenceBrokerV2Batching {
  /** Dang batching chinh. */
  kind: InferenceBrokerV2BatchingKind;
  /** Co continuous batching khong. */
  continuousBatching: boolean;
  /** Co chunked prefill khong. */
  chunkedPrefill: boolean;
  /** Co prefix caching phia server khong. */
  prefixCaching: boolean;
  /** Co speculative decoding khong. */
  speculativeDecoding: boolean;
  /** So user dong thoi khuyen nghi (0 = khong biet / khong gioi han noi). */
  recommendedMaxConcurrentUsers: number;
  /** Throughput dinh (TPS) theo survey — uoc luong, khong phai do that. */
  peakTpsEstimate: number;
  /** Ghi chu. */
  note: string;
}

/** Capability khai bao day du cua mot engine local. */
export interface InferenceBrokerV2EngineCapability {
  /** Engine. */
  engine: InferenceBrokerV2EngineKind;
  /** Ten hien thi. */
  label: string;
  /** Mo ta ngan (1 dong): engine nay dung cho viec gi. */
  role: string;
  /** Base URL mac dinh (loopback, khong `/v1` thua tru khi ghi ro). */
  defaultBaseUrl: string;
  /** Port mac dinh. */
  defaultPort: number;
  /** Endpoint OpenAI-compatible chinh (tuong doi). */
  chatCompletionsPath: string;
  /** Endpoint rieng cua engine (neu khac OpenAI-compatible). */
  nativeChatPath: string;
  /** Tool calling. */
  toolCalling: InferenceBrokerV2ToolCalling;
  /** Structured output. */
  structuredOutput: InferenceBrokerV2StructuredOutput;
  /** Context toi da khuyen nghi cho agent loop (token). */
  recommendedMaxContext: number;
  /** Context toi thieu khuyen nghi cho agent / coding / search (token). */
  minContextForAgent: number;
  /** Context mac dinh khi khong cau hinh (token, 0 = tuy model). */
  defaultContext: number;
  /** Batching / throughput. */
  batching: InferenceBrokerV2Batching;
  /** Co can auth khong (loopback mac dinh: khong). */
  needsAuth: boolean;
  /** true = chi nghe loopback theo mac dinh. */
  loopbackByDefault: boolean;
  /** Bien moi truong / co che giu local-only (vd OLLAMA_NO_CLOUD=1). */
  localOnlyMechanism: string;
  /** Gioi han / rui ro da biet (khong phai quang cao cua engine). */
  knownLimits: readonly string[];
  /** Ho model co handler tool-call native tren engine nay. */
  nativeToolCallFamilies: readonly string[];
}

/** Nhan hien thi cua mot engine. */
export function inferenceBrokerV2EngineLabel(engine: InferenceBrokerV2EngineKind): string {
  switch (engine) {
    case 'ollama':
      return 'Ollama';
    case 'llamacpp':
      return 'llama.cpp';
    case 'vllm':
      return 'vLLM';
    case 'sglang':
      return 'SGLang';
  }
}

/** Base URL mac dinh cua mot engine. */
export function inferenceBrokerV2DefaultBaseUrl(engine: InferenceBrokerV2EngineKind): string {
  return INFERENCE_BROKER_V2_ENGINE_CAPABILITY[engine].defaultBaseUrl;
}

/** Port mac dinh cua mot engine. */
export function inferenceBrokerV2DefaultPort(engine: InferenceBrokerV2EngineKind): number {
  return INFERENCE_BROKER_V2_ENGINE_CAPABILITY[engine].defaultPort;
}

/**
 * Bang capability khai bao cho 4 engine. So lieu tu survey v133 muc 4
 * (khong phai do that — probe.ts do that luc khoi dong).
 */
export const INFERENCE_BROKER_V2_ENGINE_CAPABILITY: Record<
  InferenceBrokerV2EngineKind,
  InferenceBrokerV2EngineCapability
> = {
  ollama: {
    engine: 'ollama',
    label: 'Ollama',
    role: 'Docker cho LLM — 1 lenh cai, 1 lenh chay; tot nhat cho may don / dev.',
    defaultBaseUrl: 'http://localhost:11434',
    defaultPort: 11434,
    chatCompletionsPath: '/v1/chat/completions',
    nativeChatPath: '/api/chat',
    toolCalling: {
      supported: true,
      parser: 'openai-compatible',
      parserChoices: ['openai-compatible'],
      parallelCalls: true,
      parallelByDefault: true,
      toolChoiceSupported: false,
      strictMode: false,
      strictByDefault: false,
      mcpNative: true,
      enableFlag: '',
      reliabilityNote:
        'Nhan `tools` o /api/chat va /v1/chat/completions, nhung KHONG ho tro `tool_choice`: khong ep duoc model phai goi tool, khong cam duoc tool. Can validate truoc khi thuc thi.',
    },
    structuredOutput: {
      kind: 'json-schema',
      jsonSchema: true,
      gbnfGrammar: true,
      jsonMode: true,
      regex: false,
      enforcedInRunner: true,
      note: 'Siet grammar ngay trong runner: agent loop nhan payload da validate, khoi retry hau xu ly.',
    },
    recommendedMaxContext: 131_072,
    minContextForAgent: 64_000,
    defaultContext: 4096,
    batching: {
      kind: 'none',
      continuousBatching: false,
      chunkedPrefill: false,
      prefixCaching: false,
      speculativeDecoding: false,
      recommendedMaxConcurrentUsers: 5,
      peakTpsEstimate: 41,
      note: 'Outgrow o ~5 user dong thoi; khong phai engine serving production.',
    },
    needsAuth: false,
    loopbackByDefault: true,
    localOnlyMechanism: 'OLLAMA_NO_CLOUD=1',
    knownLimits: [
      'Khong ho tro tool_choice — khong ep / cam tool call.',
      'Khong co strict mode cho tool call.',
      'Context mac dinh 4096 neu khong set num_ctx — phai set >= 64000 cho agent/coding.',
      'Khong auth tren loopback — chi chay tren may quan ly, bat OLLAMA_NO_CLOUD=1.',
      'Throughput thap (~41 TPS theo survey), khong chiu duoc nhieu user dong thoi.',
    ],
    nativeToolCallFamilies: ['llama3', 'qwen2.5', 'qwen3', 'mistral', 'gemma3', 'gpt-oss'],
  },
  llamacpp: {
    engine: 'llamacpp',
    label: 'llama.cpp',
    role: 'Engine tham chieu (C/C++, GGUF, mmap) — chay tu Raspberry Pi toi H100, kiem soat quantization tung layer.',
    defaultBaseUrl: 'http://localhost:8080',
    defaultPort: 8080,
    chatCompletionsPath: '/v1/chat/completions',
    nativeChatPath: '/v1/chat/completions',
    toolCalling: {
      supported: true,
      parser: 'jinja-native',
      parserChoices: ['jinja-native', 'openai-compatible'],
      parallelCalls: true,
      parallelByDefault: false,
      toolChoiceSupported: true,
      strictMode: true,
      strictByDefault: false,
      mcpNative: false,
      enableFlag: '--jinja',
      reliabilityNote:
        'Handler native cho Llama 3.x / Qwen 2.5 / Hermes / Mistral Nemo / gpt-oss. Parallel call TAT mac dinh — phai bat ro neu can. KV cache quantization manh lam hong tool calling.',
    },
    structuredOutput: {
      kind: 'gbnf-grammar',
      jsonSchema: true,
      gbnfGrammar: true,
      jsonMode: true,
      regex: true,
      enforcedInRunner: true,
      note: 'GBNF grammar la the manh: ep output khop schema ngay luc sinh token.',
    },
    recommendedMaxContext: 131_072,
    minContextForAgent: 64_000,
    defaultContext: 0,
    batching: {
      kind: 'parallel-decoding',
      continuousBatching: true,
      chunkedPrefill: false,
      prefixCaching: true,
      speculativeDecoding: true,
      recommendedMaxConcurrentUsers: 5,
      peakTpsEstimate: 0,
      note: 'v0.8.0: router mode, parallel decoding, speculative decoding voi draft model.',
    },
    needsAuth: false,
    loopbackByDefault: true,
    localOnlyMechanism: 'chi bind 127.0.0.1 (mac dinh)',
    knownLimits: [
      'Parallel tool call TAT mac dinh — task can parallel phai bat ro.',
      'KV cache quantization manh (Q4/Q2) lam hong tool calling — dung Q8 hoac tat KV quant cho agent.',
      'Can --jinja moi co function calling; khong bat thi model chi tra text.',
      'Throughput tuy thuoc phan cung (CPU/GPU) rat nhieu — khong co con so chung.',
    ],
    nativeToolCallFamilies: ['llama3', 'qwen2.5', 'qwen3', 'hermes', 'mistral-nemo', 'gpt-oss'],
  },
  vllm: {
    engine: 'vllm',
    label: 'vLLM',
    role: 'Serving production — PagedAttention, continuous batching, chunked prefill, prefix caching; 10+ user.',
    defaultBaseUrl: 'http://localhost:8000',
    defaultPort: 8000,
    chatCompletionsPath: '/v1/chat/completions',
    nativeChatPath: '/v1/chat/completions',
    toolCalling: {
      supported: true,
      parser: 'hermes',
      parserChoices: ['hermes', 'llama3_json', 'openai'],
      parallelCalls: true,
      parallelByDefault: true,
      toolChoiceSupported: true,
      strictMode: true,
      strictByDefault: false,
      mcpNative: false,
      enableFlag: '--enable-auto-tool-choice --tool-call-parser <hermes|llama3_json|openai>',
      reliabilityNote:
        'Doc thua nhan: forced call chi dam bao parse duoc, KHONG dam bao dung — auto mode van co the gay schema neu khong bat strict mode. Validate truoc khi thuc thi.',
    },
    structuredOutput: {
      kind: 'json-schema',
      jsonSchema: true,
      gbnfGrammar: false,
      jsonMode: true,
      regex: true,
      enforcedInRunner: true,
      note: 'Structured output first-class qua guided decoding (JSON schema / regex / choice).',
    },
    recommendedMaxContext: 262_144,
    minContextForAgent: 64_000,
    defaultContext: 0,
    batching: {
      kind: 'continuous-batching',
      continuousBatching: true,
      chunkedPrefill: true,
      prefixCaching: true,
      speculativeDecoding: true,
      recommendedMaxConcurrentUsers: 10,
      peakTpsEstimate: 793,
      note: 'Peak ~793 TPS theo survey (tuy model + GPU); tot nhat cho serving nhieu user.',
    },
    needsAuth: false,
    loopbackByDefault: false,
    localOnlyMechanism: 'bind 127.0.0.1 + --api-key khi mo port',
    knownLimits: [
      'Can GPU (VRAM lon) moi phat huy — CPU-only khong phai the manh.',
      'Forced tool call chi dam bao parse duoc, khong dam bao dung schema.',
      'Parser phai chon dung theo ho model (hermes / llama3_json / openai) — sai parser la gay tool call.',
      'Khoi dong nang, an VRAM lon ngay ca khi idle.',
    ],
    nativeToolCallFamilies: ['hermes', 'llama3', 'qwen2.5', 'qwen3', 'mistral', 'gpt-oss'],
  },
  sglang: {
    engine: 'sglang',
    label: 'SGLang',
    role: 'Cho agent pipeline — RadixAttention, disaggregated prefill/decode, structured output first-class.',
    defaultBaseUrl: 'http://localhost:30000',
    defaultPort: 30000,
    chatCompletionsPath: '/v1/chat/completions',
    nativeChatPath: '/v1/chat/completions',
    toolCalling: {
      supported: true,
      parser: 'openai-compatible',
      parserChoices: ['openai-compatible', 'hermes', 'llama3_json'],
      parallelCalls: true,
      parallelByDefault: true,
      toolChoiceSupported: true,
      strictMode: true,
      strictByDefault: false,
      mcpNative: false,
      enableFlag: '',
      reliabilityNote:
        'Tool calling qua OpenAI-compatible endpoint; manh nhat o pipeline nhieu turn (prefix cache giam latency/turn). Van phai validate truoc khi thuc thi.',
    },
    structuredOutput: {
      kind: 'json-schema',
      jsonSchema: true,
      gbnfGrammar: false,
      jsonMode: true,
      regex: true,
      enforcedInRunner: true,
      note: 'Structured output first-class — sinh co rang buoc la tinh nang goc, khong phai lop phu.',
    },
    recommendedMaxContext: 262_144,
    minContextForAgent: 64_000,
    defaultContext: 0,
    batching: {
      kind: 'disaggregated-prefill-decode',
      continuousBatching: true,
      chunkedPrefill: true,
      prefixCaching: true,
      speculativeDecoding: true,
      recommendedMaxConcurrentUsers: 10,
      peakTpsEstimate: 0,
      note: 'RadixAttention: cache prompt prefix chung giua cac turn — y tuong goc cua prefix-cache o prefixCache.ts.',
    },
    needsAuth: false,
    loopbackByDefault: false,
    localOnlyMechanism: 'bind 127.0.0.1 + --api-key khi mo port',
    knownLimits: [
      'Can GPU moi phat huy; setup phuc tap hon Ollama/llama.cpp.',
      'Cong dong + tai lieu nho hon vLLM — loi hiem gap kho tra.',
      'Disaggregated prefill/decode can cau hinh dung moi co loi.',
    ],
    nativeToolCallFamilies: ['llama3', 'qwen2.5', 'qwen3', 'hermes', 'gpt-oss'],
  },
};

/** Lay capability khai bao cua mot engine (ban sao, khong cho sua goc). */
export function inferenceBrokerV2CapabilityFor(
  engine: InferenceBrokerV2EngineKind,
): InferenceBrokerV2EngineCapability {
  const cap = INFERENCE_BROKER_V2_ENGINE_CAPABILITY[engine];
  return {
    ...cap,
    toolCalling: { ...cap.toolCalling, parserChoices: [...cap.toolCalling.parserChoices] },
    structuredOutput: { ...cap.structuredOutput },
    batching: { ...cap.batching },
    knownLimits: [...cap.knownLimits],
    nativeToolCallFamilies: [...cap.nativeToolCallFamilies],
  };
}

/** Tat ca capability khai bao (ban sao). */
export function listInferenceBrokerV2Capabilities(): InferenceBrokerV2EngineCapability[] {
  return INFERENCE_BROKER_V2_ENGINES.map((e) => inferenceBrokerV2CapabilityFor(e));
}

// ---------------------------------------------------------------------------
// Loai task + yeu cau
// ---------------------------------------------------------------------------

/** Loai task ma router phai chon engine + model cho. */
export type InferenceBrokerV2TaskKind =
  | 'coding'
  | 'extract'
  | 'chat'
  | 'planning'
  | 'vision'
  | 'long-context'
  | 'batch'
  | 'voice';

/** Yeu cau cua mot task doi voi engine + model. */
export interface InferenceBrokerV2TaskRequirements {
  /** Loai task. */
  kind: InferenceBrokerV2TaskKind;
  /** Task can tool-calling. */
  needsToolCalling?: boolean;
  /** Task can tool-calling NATIVE + strict (khong chap nhan parser long). */
  needsStrictToolCalling?: boolean;
  /** Task can goi nhieu tool song song trong 1 turn. */
  needsParallelCalls?: boolean;
  /** Task can ep output khop schema (grammar / JSON Schema). */
  needsGrammar?: boolean;
  /** Task co anh dinh kem. */
  needsVision?: boolean;
  /** Context toi thieu task can (token). */
  minContext?: number;
  /** Task nhay cam latency (voice / chat truc tiep). */
  latencySensitive?: boolean;
  /** Task uu tien throughput (batch nhieu request). */
  preferThroughput?: boolean;
  /** Task chay nhieu turn lien tiep (agent loop) — uu tien prefix cache. */
  multiTurn?: boolean;
}

/** Yeu cau mac dinh theo loai task (theo survey). */
export function defaultRequirementsForTaskKind(
  kind: InferenceBrokerV2TaskKind,
): InferenceBrokerV2TaskRequirements {
  switch (kind) {
    case 'coding':
      // Coding -> model co tool calling native + context >= 64k.
      return {
        kind,
        needsToolCalling: true,
        needsStrictToolCalling: true,
        needsParallelCalls: true,
        minContext: 64_000,
        multiTurn: true,
      };
    case 'extract':
      // Extract -> grammar-constrained (ep schema, khong doan mo).
      return { kind, needsGrammar: true, needsToolCalling: false, minContext: 32_768 };
    case 'chat':
      return { kind, latencySensitive: true, minContext: 32_768 };
    case 'planning':
      return {
        kind,
        needsToolCalling: true,
        needsStrictToolCalling: true,
        minContext: 64_000,
        multiTurn: true,
      };
    case 'vision':
      return { kind, needsVision: true, minContext: 32_768 };
    case 'long-context':
      return { kind, minContext: 128_000, multiTurn: true };
    case 'batch':
      return { kind, preferThroughput: true, needsGrammar: true, minContext: 32_768 };
    case 'voice':
      return { kind, latencySensitive: true, multiTurn: true, minContext: 32_768 };
  }
}

/** Gop yeu cau loai task voi yeu cau rieng cua caller (rieng thang). */
export function requirementsForTask(
  kind: InferenceBrokerV2TaskKind,
  overrides?: Partial<InferenceBrokerV2TaskRequirements>,
): InferenceBrokerV2TaskRequirements {
  return { ...defaultRequirementsForTaskKind(kind), ...(overrides ?? {}), kind };
}

// ---------------------------------------------------------------------------
// Cham diem engine theo task
// ---------------------------------------------------------------------------

/** Mot engine duoc cham diem cho mot task. */
export interface InferenceBrokerV2EngineScore {
  /** Engine. */
  engine: InferenceBrokerV2EngineKind;
  /** Diem tong 0..1 (cao hon tot hon). */
  score: number;
  /** true = engine dap ung du yeu cau bat buoc. */
  eligible: boolean;
  /** Yeu cau bat buoc nao khong dat (rong khi eligible). */
  missing: string[];
  /** Giai thich ngan gon (tieng Viet). */
  reason: string;
  /** Diem thanh phan. */
  breakdown: {
    toolCalling: number;
    structured: number;
    context: number;
    throughput: number;
    latency: number;
  };
}

/** Cham diem mot engine cho mot task (thuan, khong I/O). */
export function scoreInferenceBrokerV2Engine(
  engine: InferenceBrokerV2EngineKind,
  req: InferenceBrokerV2TaskRequirements,
  opts?: { probedToolCallWorks?: boolean; probedStrictWorks?: boolean },
): InferenceBrokerV2EngineScore {
  const cap = INFERENCE_BROKER_V2_ENGINE_CAPABILITY[engine];
  const missing: string[] = [];
  const breakdown = { toolCalling: 0, structured: 0, context: 0, throughput: 0, latency: 0 };

  // --- Tool calling (0..1) ---
  if (req.needsToolCalling || req.needsStrictToolCalling) {
    if (!cap.toolCalling.supported) {
      missing.push('tool-calling');
      breakdown.toolCalling = 0;
    } else if (opts?.probedToolCallWorks === false) {
      // Probe that da chung minh parser gay — khong tin khai bao nua.
      missing.push('tool-calling (probe that bai)');
      breakdown.toolCalling = 0;
    } else {
      let s = 0.6;
      if (cap.toolCalling.parallelCalls && (!req.needsParallelCalls || cap.toolCalling.parallelByDefault)) s += 0.15;
      if (cap.toolCalling.toolChoiceSupported) s += 0.1;
      if (cap.toolCalling.strictMode) s += 0.15;
      breakdown.toolCalling = Math.min(1, s);
      if (req.needsStrictToolCalling && !cap.toolCalling.strictMode) {
        missing.push('strict tool-calling');
      }
      if (req.needsStrictToolCalling && opts?.probedStrictWorks === false) {
        missing.push('strict tool-calling (probe that bai)');
      }
      if (req.needsParallelCalls && !cap.toolCalling.parallelCalls) {
        missing.push('parallel tool calls');
      }
      if (req.needsParallelCalls && !cap.toolCalling.parallelByDefault) {
        // Khong loai — chi tru diem (bat them flag la duoc).
        breakdown.toolCalling = Math.max(0, breakdown.toolCalling - 0.15);
      }
    }
  } else {
    breakdown.toolCalling = cap.toolCalling.supported ? 0.5 : 0;
  }

  // --- Structured output / grammar (0..1) ---
  if (req.needsGrammar) {
    if (cap.structuredOutput.kind === 'none' || !cap.structuredOutput.jsonSchema) {
      missing.push('grammar-constrained output');
      breakdown.structured = 0;
    } else {
      breakdown.structured =
        cap.structuredOutput.kind === 'gbnf-grammar'
          ? 1
          : cap.structuredOutput.enforcedInRunner
            ? 0.9
            : 0.7;
    }
  } else {
    breakdown.structured = cap.structuredOutput.jsonSchema ? 0.5 : 0;
  }

  // --- Context (0..1) ---
  const minCtx = req.minContext ?? 0;
  if (minCtx > 0 && cap.recommendedMaxContext < minCtx) {
    missing.push(`context >= ${minCtx}`);
    breakdown.context = Math.max(0, cap.recommendedMaxContext / minCtx - 0.2);
  } else if (minCtx > 0) {
    breakdown.context = cap.recommendedMaxContext >= minCtx * 2 ? 1 : 0.8;
  } else {
    breakdown.context = 0.5;
  }

  // --- Throughput (0..1) ---
  if (req.preferThroughput) {
    if (cap.batching.continuousBatching) breakdown.throughput = 0.9;
    else if (cap.batching.kind === 'parallel-decoding') breakdown.throughput = 0.6;
    else breakdown.throughput = 0.3;
    if (cap.batching.peakTpsEstimate >= 500) breakdown.throughput = 1;
  } else {
    breakdown.throughput = cap.batching.continuousBatching ? 0.7 : 0.4;
  }

  // --- Latency / multi-turn (0..1) ---
  if (req.latencySensitive || req.multiTurn) {
    // Prefix cache giam latency/turn — engine co prefix caching duoc cong.
    breakdown.latency = cap.batching.prefixCaching ? 0.9 : 0.6;
    if (req.multiTurn && engine === 'sglang') breakdown.latency = 1;
    if (req.latencySensitive && engine === 'ollama') breakdown.latency = 0.9;
  } else {
    breakdown.latency = 0.5;
  }

  const eligible = missing.length === 0;
  // Trong so: tool calling + grammar nang nhat khi task doi; context ke
  // tiep; throughput/latency tuy task.
  const wTool = req.needsToolCalling || req.needsStrictToolCalling ? 0.35 : 0.15;
  const wStruct = req.needsGrammar ? 0.3 : 0.1;
  const wCtx = minCtx > 0 ? 0.25 : 0.1;
  // Batch uu tien throughput that su: trong so throughput phai vuot
  // structured (neu khong llama.cpp thang nho GBNF du vLLM moi la
  // engine serving batch — 793 TPS + continuous batching).
  const wThr = req.preferThroughput ? 0.35 : 0.1;
  const wLat = req.latencySensitive || req.multiTurn ? 0.15 : 0.05;
  const wSum = wTool + wStruct + wCtx + wThr + wLat;
  const score = eligible
    ? (breakdown.toolCalling * wTool +
        breakdown.structured * wStruct +
        breakdown.context * wCtx +
        breakdown.throughput * wThr +
        breakdown.latency * wLat) /
      wSum
    : 0;

  const parts: string[] = [`${cap.label}: `];
  if (!eligible) parts.push(`khong dat (${missing.join('; ')})`);
  else {
    if (req.needsToolCalling) parts.push('tool-calling ok');
    if (req.needsStrictToolCalling) parts.push('strict ok');
    if (req.needsGrammar) parts.push('grammar ok');
    if (minCtx > 0) parts.push(`context ${cap.recommendedMaxContext} >= ${minCtx}`);
    if (req.preferThroughput && cap.batching.continuousBatching) parts.push('continuous batching');
    if (req.multiTurn && cap.batching.prefixCaching) parts.push('prefix cache');
  }
  return {
    engine,
    score: Math.round(score * 1000) / 1000,
    eligible,
    missing,
    reason: parts.join('; ') + '.',
    breakdown,
  };
}

/** Xep hang tat ca engine cho mot task (tot nhat truoc). */
export function rankInferenceBrokerV2Engines(
  req: InferenceBrokerV2TaskRequirements,
  candidates: readonly InferenceBrokerV2EngineKind[] = INFERENCE_BROKER_V2_ENGINES,
  probed?: Readonly<Partial<Record<InferenceBrokerV2EngineKind, { toolCallWorks: boolean; strictWorks: boolean }>>>,
): InferenceBrokerV2EngineScore[] {
  const scored = candidates.map((engine) =>
    scoreInferenceBrokerV2Engine(engine, req, {
      probedToolCallWorks: probed?.[engine]?.toolCallWorks,
      probedStrictWorks: probed?.[engine]?.strictWorks,
    }),
  );
  scored.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });
  return scored;
}

/**
 * Route mot task: chon engine tot nhat + chuoi fallback.
 *
 * Quy tac fallback (tu survey): Ollama thieu `tool_choice`/strict mode
 * -> fallback sang llama.cpp server. Quy tac chung: engine khong dat
 * yeu cau bat buoc thi xuong hang sau; engine da probe that bai thi
 * khong dung lam fallback dau tien.
 */
export function routeTaskToEngineV2(
  req: InferenceBrokerV2TaskRequirements,
  candidates: readonly InferenceBrokerV2EngineKind[] = INFERENCE_BROKER_V2_ENGINES,
  probed?: Readonly<Partial<Record<InferenceBrokerV2EngineKind, { toolCallWorks: boolean; strictWorks: boolean }>>>,
): {
  ranked: InferenceBrokerV2EngineScore[];
  primary: InferenceBrokerV2EngineScore | undefined;
  fallbackChain: InferenceBrokerV2EngineKind[];
  reason: string;
} {
  const ranked = rankInferenceBrokerV2Engines(req, candidates, probed);
  const eligible = ranked.filter((r) => r.eligible);
  const primary = eligible[0] ?? ranked[0];
  const fallbackChain: InferenceBrokerV2EngineKind[] = [];
  // Fallback: cac engine eligible con lai theo thu tu diem, sau do neu
  // primary la Ollama va task can strict/tool_choice thi chen llama.cpp
  // ngay sau primary (quy tac Ollama -> llama.cpp server).
  const rest = eligible.filter((r) => r.engine !== primary?.engine).map((r) => r.engine);
  if (primary && primary.engine === 'ollama' && (req.needsStrictToolCalling || req.needsToolCalling)) {
    if (candidates.includes('llamacpp') && !rest.includes('llamacpp')) {
      fallbackChain.push('llamacpp');
    } else if (rest.includes('llamacpp')) {
      fallbackChain.push('llamacpp', ...rest.filter((e) => e !== 'llamacpp'));
    } else {
      fallbackChain.push(...rest);
    }
  } else {
    fallbackChain.push(...rest);
  }
  // Engine khong eligible van co the lam fallback cuoi (tot hon la khong
  // co gi) — ghi ro trong reason, khong dua vao chain mac dinh.
  const reason = primary
    ? primary.eligible
      ? `Chon ${inferenceBrokerV2EngineLabel(primary.engine)} (${primary.reason})` +
        (fallbackChain.length > 0
          ? `; fallback: ${fallbackChain.map((e) => inferenceBrokerV2EngineLabel(e)).join(' -> ')}.`
          : '; khong co fallback eligible.')
      : `Khong engine nao dat du yeu cau; dung ${inferenceBrokerV2EngineLabel(primary.engine)} tot nhat hien co (${primary.reason}) — can validate ky truoc khi thuc thi.`
    : 'Khong co engine ung vien.';
  return { ranked, primary, fallbackChain, reason };
}

/** Fallback truc tiep cho mot engine (khong can task). */
export function fallbackEngineForV2(
  engine: InferenceBrokerV2EngineKind,
  reason: 'missing-tool-choice' | 'missing-strict' | 'probe-failed' | 'unreachable',
): InferenceBrokerV2EngineKind | undefined {
  if (engine === 'ollama' && (reason === 'missing-tool-choice' || reason === 'missing-strict')) {
    return 'llamacpp';
  }
  if (reason === 'probe-failed' || reason === 'unreachable') {
    // Engine gay / khong chay: thu llama.cpp (nhe, chay CPU duoc) truoc,
    // tru khi chinh no la llama.cpp thi thu Ollama.
    return engine === 'llamacpp' ? 'ollama' : 'llamacpp';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Model tren engine: ket hop capability model (routerV3) + matrix engine
// ---------------------------------------------------------------------------

/** Capability tong hop cua mot model tren mot engine cu the. */
export interface InferenceBrokerV2ModelOnEngine {
  /** Id model. */
  modelId: string;
  /** Engine. */
  engine: InferenceBrokerV2EngineKind;
  /** Capability cua model (tu routerV3: bang biet truoc / suy tu ten). */
  modelCapability: ModelCapability;
  /** Capability khai bao cua engine. */
  engineCapability: InferenceBrokerV2EngineCapability;
  /** Model co tool calling native tren engine nay khong (theo ho model). */
  nativeToolCalling: boolean;
  /** Context khuyen nghi that su: min(context model, context engine). */
  effectiveContext: number;
  /** true = du dieu kien cho agent loop (tool calling + context >= 64k). */
  agentReady: boolean;
  /** Ly do neu chua agent-ready. */
  notReadyReason?: string;
}

/** Ho model co phai ho co handler tool-call native tren engine khong. */
export function modelHasNativeToolCallingOnEngine(
  modelId: string,
  engine: InferenceBrokerV2EngineKind,
): boolean {
  const lower = modelId.toLowerCase();
  const families = INFERENCE_BROKER_V2_ENGINE_CAPABILITY[engine].nativeToolCallFamilies;
  return families.some((f) => lower.includes(f));
}

/** Capability tong hop cua mot model tren mot engine. */
export function capabilityForModelOnEngineV2(
  modelId: string,
  engine: InferenceBrokerV2EngineKind,
): InferenceBrokerV2ModelOnEngine {
  const modelCapability = capabilitiesForModel(modelId);
  const engineCapability = inferenceBrokerV2CapabilityFor(engine);
  const nativeToolCalling =
    modelCapability.toolCalling && modelHasNativeToolCallingOnEngine(modelId, engine);
  const effectiveContext = Math.min(
    modelCapability.contextWindow > 0 ? modelCapability.contextWindow : engineCapability.recommendedMaxContext,
    engineCapability.recommendedMaxContext,
  );
  const agentReady =
    nativeToolCalling &&
    modelCapability.toolCalling &&
    effectiveContext >= engineCapability.minContextForAgent;
  const notReadyReason = agentReady
    ? undefined
    : !modelCapability.toolCalling
      ? `Model ${modelId} khong co tool-calling theo bang routerV3.`
      : !nativeToolCalling
        ? `Model ${modelId} khong thuoc ho co handler tool-call native tren ${engineCapability.label}.`
        : `Context hieu dung ${effectiveContext} < ${engineCapability.minContextForAgent} (toi thieu cho agent).`;
  return {
    modelId,
    engine,
    modelCapability,
    engineCapability,
    nativeToolCalling,
    effectiveContext,
    agentReady,
    notReadyReason,
  };
}

/**
 * Chon engine + model tot nhat cho mot task trong danh sach model local
 * da biet (vd tu scan routerV3). Tra undefined khi khong co model nao
 * agent-ready cho task coding/planning.
 */
export function pickModelForTaskV2(
  req: InferenceBrokerV2TaskRequirements,
  models: readonly { modelId: string; engine: InferenceBrokerV2EngineKind }[],
  probed?: Readonly<Partial<Record<InferenceBrokerV2EngineKind, { toolCallWorks: boolean; strictWorks: boolean }>>>,
): { modelId: string; engine: InferenceBrokerV2EngineKind; score: number; reason: string } | undefined {
  let best: { modelId: string; engine: InferenceBrokerV2EngineKind; score: number; reason: string } | undefined;
  for (const m of models) {
    const onEngine = capabilityForModelOnEngineV2(m.modelId, m.engine);
    const engineScore = scoreInferenceBrokerV2Engine(m.engine, req, {
      probedToolCallWorks: probed?.[m.engine]?.toolCallWorks,
      probedStrictWorks: probed?.[m.engine]?.strictWorks,
    });
    if (!engineScore.eligible) continue;
    // Coding/planning doi agent-ready that su (model + engine).
    if ((req.kind === 'coding' || req.kind === 'planning') && !onEngine.agentReady) continue;
    // Vision doi model co vision.
    if (req.needsVision && !onEngine.modelCapability.vision) continue;
    const score = engineScore.score * 0.6 + (onEngine.effectiveContext >= 131_072 ? 0.4 : 0.2);
    if (!best || score > best.score) {
      best = {
        modelId: m.modelId,
        engine: m.engine,
        score: Math.round(score * 1000) / 1000,
        reason: `${m.modelId} tren ${inferenceBrokerV2EngineLabel(m.engine)} (context hieu dung ${onEngine.effectiveContext}, ${engineScore.reason})`,
      };
    }
  }
  return best;
}

/** Tom tat matrix dang markdown (de UI / log hien thi). */
export function inferenceBrokerV2MatrixMarkdown(): string {
  const lines: string[] = [
    '# Inference broker v2 — capability matrix (khai bao, chua probe)',
    '',
    '| Engine | Tool calling | tool_choice | Strict | Structured output | Context KN agent | Batching |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const engine of INFERENCE_BROKER_V2_ENGINES) {
    const c = INFERENCE_BROKER_V2_ENGINE_CAPABILITY[engine];
    lines.push(
      `| ${c.label} | ${c.toolCalling.supported ? c.toolCalling.parser : 'khong'} | ${c.toolCalling.toolChoiceSupported ? 'co' : 'KHONG'} | ${c.toolCalling.strictMode ? 'co' : 'KHONG'} | ${c.structuredOutput.kind} | ${c.minContextForAgent} | ${c.batching.kind} |`,
    );
  }
  lines.push(
    '',
    'Luu y: day la capability KHAI BAO tu survey/doc. Capability THAT do probe luc khoi dong (probe.ts) va ghi de muc nay trong registry.',
  );
  return lines.join('\n');
}
