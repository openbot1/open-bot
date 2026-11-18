/**
 * Capability matrix per model (v1.18, Doi T3).
 *
 * Moi model khai bao capability (tool-calling, vision, streaming,
 * JSON mode, context window, max output, reasoning). Router tu choi
 * / de xuat thay the khi task doi capability model khong co.
 *
 * Bang KNOWN_MODEL_CAPABILITIES ghi capability cua model pho bien
 * theo doc cong khai cua hang (so context la so doc cong bo; co the
 * lac hau khi hang doi — user co the override bang
 * `registerModelCapability`). Model khong co trong bang thi suy tu
 * ten (inferred) roi roi ve mac dinh an toan (default): tool-calling
 * co, vision khong, streaming co, JSON mode co, context 32k.
 * Khong doan mo vision/tool-calling cho model la: mac dinh la
 * "khong co" tru khi bang hoac ten chung minh co.
 */

import type { CapabilityCheckResult, CapabilityRequirement, ModelCapability } from './types';

/** Capability mac dinh an toan khi khong biet gi ve model. */
export const DEFAULT_MODEL_CAPABILITY: ModelCapability = {
  toolCalling: true,
  vision: false,
  streaming: true,
  jsonMode: true,
  contextWindow: 32_768,
  maxOutputTokens: 4096,
  reasoning: false,
  source: 'default',
};

/** Capability cua model embedding (khong chat, khong tool, khong vision). */
export const EMBEDDING_MODEL_CAPABILITY: ModelCapability = {
  toolCalling: false,
  vision: false,
  streaming: false,
  jsonMode: false,
  contextWindow: 8192,
  maxOutputTokens: 0,
  reasoning: false,
  source: 'default',
};

function cap(
  partial: Partial<ModelCapability> & { contextWindow: number; maxOutputTokens: number },
): ModelCapability {
  return {
    toolCalling: partial.toolCalling ?? true,
    vision: partial.vision ?? false,
    streaming: partial.streaming ?? true,
    jsonMode: partial.jsonMode ?? true,
    contextWindow: partial.contextWindow,
    maxOutputTokens: partial.maxOutputTokens,
    reasoning: partial.reasoning ?? false,
    source: 'known',
  };
}

/**
 * Bang capability model pho bien (doc cong khai cua hang, tinh den
 * 11/2026). Key la tien to model id (khop tien to dai nhat thang).
 * So context la context doc cong bo; model tren provider thu ba co
 * the bi gioi han thap hon — router chi dung de chon/de xuat, khong
 * dung de cat prompt (guard context that nam o provider).
 */
export const KNOWN_MODEL_CAPABILITIES: Readonly<Record<string, ModelCapability>> = {
  // OpenAI
  'gpt-5': cap({ contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true, vision: true }),
  'gpt-5-mini': cap({ contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true, vision: true }),
  'gpt-4.1': cap({ contextWindow: 1_047_576, maxOutputTokens: 32_768, vision: true }),
  'gpt-4o': cap({ contextWindow: 128_000, maxOutputTokens: 16_384, vision: true }),
  'gpt-4o-mini': cap({ contextWindow: 128_000, maxOutputTokens: 16_384, vision: true }),
  'o3': cap({ contextWindow: 200_000, maxOutputTokens: 100_000, reasoning: true, vision: true }),
  'o4-mini': cap({ contextWindow: 200_000, maxOutputTokens: 100_000, reasoning: true, vision: true }),
  'gpt-oss-120b': cap({ contextWindow: 131_072, maxOutputTokens: 32_768, reasoning: true }),
  'gpt-oss-20b': cap({ contextWindow: 131_072, maxOutputTokens: 32_768, reasoning: true }),
  // Anthropic
  'claude-opus-4-5': cap({ contextWindow: 200_000, maxOutputTokens: 8192, reasoning: true, vision: true }),
  'claude-sonnet-4-5': cap({ contextWindow: 200_000, maxOutputTokens: 8192, reasoning: true, vision: true }),
  'claude-haiku-4-5': cap({ contextWindow: 200_000, maxOutputTokens: 8192, reasoning: true, vision: true }),
  'claude-3-7-sonnet': cap({ contextWindow: 200_000, maxOutputTokens: 8192, reasoning: true, vision: true }),
  'claude-3-5-sonnet': cap({ contextWindow: 200_000, maxOutputTokens: 8192, vision: true }),
  // Google
  'gemini-3-pro': cap({ contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true, vision: true }),
  'gemini-2.5-pro': cap({ contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true, vision: true }),
  'gemini-2.5-flash': cap({ contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true, vision: true }),
  'gemini-2.0-flash': cap({ contextWindow: 1_048_576, maxOutputTokens: 8192, vision: true }),
  'gemini-1.5-pro': cap({ contextWindow: 2_097_152, maxOutputTokens: 8192, vision: true }),
  // xAI
  'grok-4': cap({ contextWindow: 256_000, maxOutputTokens: 32_768, reasoning: true, vision: true }),
  'grok-3': cap({ contextWindow: 131_072, maxOutputTokens: 32_768, reasoning: true }),
  'grok-code-fast-1': cap({ contextWindow: 256_000, maxOutputTokens: 32_768, reasoning: true }),
  // DeepSeek
  'deepseek-chat': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  'deepseek-reasoner': cap({ contextWindow: 64_000, maxOutputTokens: 8192, reasoning: true }),
  'deepseek-v4-flash': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  'deepseek-v3.2': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  'deepseek-r1': cap({ contextWindow: 64_000, maxOutputTokens: 8192, reasoning: true, toolCalling: false }),
  // Meta / Llama
  'llama-4-maverick': cap({ contextWindow: 1_048_576, maxOutputTokens: 8192, vision: true }),
  'llama-4-scout': cap({ contextWindow: 10_485_760, maxOutputTokens: 8192, vision: true }),
  'llama-3.3-70b': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  'llama-3.1-405b': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  'llama-3.1-70b': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  'llama-3.1-8b': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  'llama3.1': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  'llama3.3': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  // Qwen
  'qwen3-235b': cap({ contextWindow: 262_144, maxOutputTokens: 32_768, reasoning: true }),
  'qwen3-32b': cap({ contextWindow: 262_144, maxOutputTokens: 32_768, reasoning: true }),
  'qwen3-8b': cap({ contextWindow: 262_144, maxOutputTokens: 32_768, reasoning: true }),
  'qwen3': cap({ contextWindow: 262_144, maxOutputTokens: 32_768, reasoning: true }),
  'qwen-plus': cap({ contextWindow: 1_000_000, maxOutputTokens: 8192 }),
  'qwen-turbo': cap({ contextWindow: 1_000_000, maxOutputTokens: 8192 }),
  'qwen-max': cap({ contextWindow: 262_144, maxOutputTokens: 8192 }),
  'qwen2.5-coder': cap({ contextWindow: 32_768, maxOutputTokens: 8192 }),
  'qwen2.5': cap({ contextWindow: 32_768, maxOutputTokens: 8192 }),
  // Mistral
  'mistral-large': cap({ contextWindow: 128_000, maxOutputTokens: 8192, vision: true }),
  'mistral-medium': cap({ contextWindow: 128_000, maxOutputTokens: 8192, vision: true }),
  'mistral-small': cap({ contextWindow: 128_000, maxOutputTokens: 8192, vision: true }),
  'codestral': cap({ contextWindow: 256_000, maxOutputTokens: 8192 }),
  'mixtral-8x22b': cap({ contextWindow: 65_536, maxOutputTokens: 8192 }),
  // Moonshot / Kimi
  'kimi-k3': cap({ contextWindow: 256_000, maxOutputTokens: 8192 }),
  'kimi-k2': cap({ contextWindow: 256_000, maxOutputTokens: 8192 }),
  // Cohere
  'command-a': cap({ contextWindow: 256_000, maxOutputTokens: 8192 }),
  'command-r-plus': cap({ contextWindow: 128_000, maxOutputTokens: 4096 }),
  'command-r': cap({ contextWindow: 128_000, maxOutputTokens: 4096 }),
  // GLM / Zhipu
  'glm-4.7': cap({ contextWindow: 200_000, maxOutputTokens: 8192, reasoning: true }),
  'glm-4.5': cap({ contextWindow: 128_000, maxOutputTokens: 8192, reasoning: true }),
  // Perplexity
  'sonar': cap({ contextWindow: 127_072, maxOutputTokens: 8192 }),
  // MiniMax / StepFun / others
  'MiniMax-M2': cap({ contextWindow: 204_800, maxOutputTokens: 8192, reasoning: true }),
  'step-2': cap({ contextWindow: 256_000, maxOutputTokens: 8192, reasoning: true }),
  'solar-pro': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  'jamba-large': cap({ contextWindow: 256_000, maxOutputTokens: 8192 }),
  'reka-flash': cap({ contextWindow: 128_000, maxOutputTokens: 8192 }),
  // Local pho bien
  'gemma3': cap({ contextWindow: 128_000, maxOutputTokens: 8192, vision: true }),
  'gemma-3': cap({ contextWindow: 128_000, maxOutputTokens: 8192, vision: true }),
  'llava': cap({ contextWindow: 32_768, maxOutputTokens: 4096, vision: true, toolCalling: false }),
  'mistral': cap({ contextWindow: 32_768, maxOutputTokens: 8192 }),
  'qwen2.5-vl': cap({ contextWindow: 32_768, maxOutputTokens: 8192, vision: true }),
  'deepseek-r1-distill': cap({ contextWindow: 32_768, maxOutputTokens: 8192, reasoning: true, toolCalling: false }),
};

/** Override do user / host dang ky (uu tien hon bang biet truoc). */
const customCapabilities = new Map<string, ModelCapability>();

/** Dang ky capability cho mot model (ghi de bang biet truoc). */
export function registerModelCapability(modelId: string, capability: ModelCapability): void {
  customCapabilities.set(normalizeModelId(modelId), { ...capability, source: 'known' });
}

/** Xoa override da dang ky (tra ve bang biet truoc). */
export function unregisterModelCapability(modelId: string): boolean {
  return customCapabilities.delete(normalizeModelId(modelId));
}

/**
 * Chuan hoa model id de khop: bo tien to vendor `a/b`, chu thuong, bo tag `:...`.
 *
 * LUU Y: barrel `@open-bot/core` export mot `normalizeModelId` khac
 * (router/contextWindow.ts, chi bo tag) qua explicit export — ten
 * nay KHONG phai ham nay khi import tu barrel. Code router v3 (va
 * test) import truc tiep tu module nay (`./capabilities`).
 */
export function normalizeModelId(modelId: string): string {
  const noVendor = modelId.includes('/') ? (modelId.split('/').pop() ?? modelId) : modelId;
  const noTag = noVendor.includes(':') ? (noVendor.split(':')[0] ?? noVendor) : noVendor;
  return noTag.trim().toLowerCase();
}

/** Tim muc bang biet truoc khop tien to dai nhat (khong phan biet hoa/thuong). */
function lookupKnown(modelId: string): ModelCapability | undefined {
  const normalized = normalizeModelId(modelId);
  let best: ModelCapability | undefined;
  let bestLen = 0;
  for (const [prefix, capValue] of Object.entries(KNOWN_MODEL_CAPABILITIES)) {
    const p = prefix.toLowerCase();
    if (normalized.startsWith(p) && p.length > bestLen) {
      best = capValue;
      bestLen = p.length;
    }
  }
  return best ? { ...best } : undefined;
}

/**
 * Suy capability tu ten model (khi khong co trong bang). Quy tac
 * bao thu: chi bat vision/reasoning khi ten noi ro; embedding thi
 * tat het.
 */
export function inferCapabilityFromName(modelId: string): ModelCapability {
  const lower = modelId.toLowerCase();
  if (lower.includes('embed') || lower.includes('embedding') || lower.includes('rerank')) {
    return { ...EMBEDDING_MODEL_CAPABILITY, source: 'inferred' };
  }
  const vision =
    lower.includes('vision') ||
    lower.includes('-vl') ||
    lower.includes('llava') ||
    lower.includes('gemma3') ||
    lower.includes('gemma-3') ||
    lower.includes('4o') ||
    lower.includes('claude') ||
    lower.includes('gemini') ||
    lower.includes('grok-4') ||
    lower.includes('llama-4');
  const reasoning =
    lower.includes('reasoning') ||
    lower.includes('thinking') ||
    lower.includes('-r1') ||
    lower.includes('r1-distill') ||
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('o4-') ||
    lower.includes('qwq');
  // Suy context tu ten: model 70B+ thuong 128k, model nho thuong 32k.
  const contextWindow = /70b|72b|120b|235b|405b/i.test(modelId) ? 128_000 : 32_768;
  return {
    toolCalling: !lower.includes('llava'),
    vision,
    streaming: true,
    jsonMode: true,
    contextWindow,
    maxOutputTokens: 4096,
    reasoning,
    source: 'inferred',
  };
}

/**
 * Capability cua mot model: override user > bang biet truoc > suy
 * tu ten > mac dinh an toan.
 */
export function capabilitiesForModel(modelId: string): ModelCapability {
  const normalized = normalizeModelId(modelId);
  const custom = customCapabilities.get(normalized);
  if (custom) return { ...custom };
  const known = lookupKnown(modelId);
  if (known) return known;
  return inferCapabilityFromName(modelId);
}

/** Ten hien thi cua mot capability thieu (de giai thich cho user). */
const MISSING_LABELS: Record<string, string> = {
  toolCalling: 'tool-calling',
  vision: 'vision (nhan anh)',
  streaming: 'streaming',
  jsonMode: 'JSON mode',
  reasoning: 'reasoning',
  contextWindow: 'context window du lon',
  maxOutputTokens: 'max output du lon',
};

/**
 * Kiem tra model co dap ung yeu cau cua task khong. Tra danh sach
 * capability thieu + ly do; khong throw.
 */
export function checkRequirements(
  modelId: string,
  requirements: CapabilityRequirement,
  providerId?: string,
  capability?: ModelCapability,
): CapabilityCheckResult {
  const capValue = capability ?? capabilitiesForModel(modelId);
  const missing: string[] = [];
  if (requirements.needsToolCalling && !capValue.toolCalling) missing.push('toolCalling');
  if (requirements.needsVision && !capValue.vision) missing.push('vision');
  if (requirements.needsStreaming && !capValue.streaming) missing.push('streaming');
  if (requirements.needsJsonMode && !capValue.jsonMode) missing.push('jsonMode');
  if (requirements.needsReasoning && !capValue.reasoning) missing.push('reasoning');
  if (
    requirements.minContextWindow !== undefined &&
    capValue.contextWindow > 0 &&
    capValue.contextWindow < requirements.minContextWindow
  ) {
    missing.push('contextWindow');
  }
  if (
    requirements.minOutputTokens !== undefined &&
    capValue.maxOutputTokens > 0 &&
    capValue.maxOutputTokens < requirements.minOutputTokens
  ) {
    missing.push('maxOutputTokens');
  }
  if (missing.length === 0) {
    return { ok: true, modelId, providerId, missing: [] };
  }
  const labels = missing.map((m) => MISSING_LABELS[m] ?? m).join(', ');
  return {
    ok: false,
    modelId,
    providerId,
    missing,
    reason: `Model ${modelId} thieu: ${labels}.`,
  };
}

/**
 * De xuat model thay the trong danh sach ung vien: model dau tien
 * (theo thu tu truyen vao) dap ung du yeu cau. Tra undefined khi
 * khong co ung vien nao dat.
 */
export function suggestAlternative(
  requirements: CapabilityRequirement,
  candidates: readonly { modelId: string; providerId?: string; capability?: ModelCapability }[],
): string | undefined {
  for (const candidate of candidates) {
    const result = checkRequirements(candidate.modelId, requirements, candidate.providerId, candidate.capability);
    if (result.ok) return candidate.modelId;
  }
  return undefined;
}

/**
 * Kiem tra + de xuat thay the trong mot buoc: khi model khong dat,
 * `suggestedAlternative` la model dau tien dat trong danh sach.
 */
export function checkRequirementsWithAlternative(
  modelId: string,
  requirements: CapabilityRequirement,
  providerId: string | undefined,
  candidates: readonly { modelId: string; providerId?: string; capability?: ModelCapability }[],
): CapabilityCheckResult {
  const result = checkRequirements(modelId, requirements, providerId);
  if (result.ok) return result;
  const alternative = suggestAlternative(
    requirements,
    candidates.filter((c) => c.modelId !== modelId),
  );
  return { ...result, suggestedAlternative: alternative };
}
