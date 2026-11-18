/**
 * Cost table (v1.18, Doi T3) — gia theo model, cau hinh duoc.
 *
 * Gia mac dinh la gia cong khai cua hang (USD / 1M token, tinh den
 * 11/2026) cho model pho bien; model khong co trong bang thi dung
 * gia mac dinh cua provider, roi roi ve gia uoc luong chung
 * (UNKNOWN_MODEL_PRICE). Gia chi de chon provider re/nhanh + bao
 * cao spend — khong phai hoa don that; hang doi gia thi user
 * override bang `setModelCost` / `setProviderDefault` (luu settings).
 * Model local cost = 0 (chay tren may user).
 */

import type { ModelCostEntry, ProviderCostDefault } from './types';
import { normalizeModelId } from './capabilities';
import { PROVIDERS } from '../providers/index';

/** Gia uoc luong chung khi khong biet model/provider (USD / 1M token). */
export const UNKNOWN_MODEL_INPUT_PER_1M_USD = 1.0;
export const UNKNOWN_MODEL_OUTPUT_PER_1M_USD = 3.0;

/** Gia mac dinh cua provider khi model khong co trong bang (USD / 1M token). */
export const DEFAULT_PROVIDER_COSTS: Readonly<Record<string, ProviderCostDefault>> = {
  openai: { inputPer1mUsd: 2.5, outputPer1mUsd: 10 },
  anthropic: { inputPer1mUsd: 3, outputPer1mUsd: 15 },
  gemini: { inputPer1mUsd: 1.25, outputPer1mUsd: 5 },
  xai: { inputPer1mUsd: 3, outputPer1mUsd: 15 },
  deepseek: { inputPer1mUsd: 0.28, outputPer1mUsd: 0.42 },
  groq: { inputPer1mUsd: 0.5, outputPer1mUsd: 0.75 },
  together: { inputPer1mUsd: 0.8, outputPer1mUsd: 0.8 },
  fireworks: { inputPer1mUsd: 0.9, outputPer1mUsd: 0.9 },
  mistral: { inputPer1mUsd: 0.4, outputPer1mUsd: 1.2 },
  cerebras: { inputPer1mUsd: 0.5, outputPer1mUsd: 0.75 },
  sambanova: { inputPer1mUsd: 0.4, outputPer1mUsd: 0.8 },
  cohere: { inputPer1mUsd: 2.5, outputPer1mUsd: 10 },
  moonshot: { inputPer1mUsd: 0.5, outputPer1mUsd: 2 },
  qwen: { inputPer1mUsd: 0.4, outputPer1mUsd: 1.6 },
  openrouter: { inputPer1mUsd: 1, outputPer1mUsd: 3 },
  ollama: { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  'ollama-local': { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  'lm-studio': { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  vllm: { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  'llama-cpp': { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  'text-generation-webui': { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  jan: { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  sglang: { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  tgi: { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  gpt4all: { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  localai: { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  koboldcpp: { inputPer1mUsd: 0, outputPer1mUsd: 0 },
  litellm: { inputPer1mUsd: 1, outputPer1mUsd: 3 },
};

function entry(input: number, output: number, estimated = false): ModelCostEntry {
  return { inputPer1mUsd: input, outputPer1mUsd: output, estimated };
}

/**
 * Bang gia model pho bien (USD / 1M token). Key la tien to model id
 * (khop tien to dai nhat thang, giong capability). Gia lay tu bang
 * gia cong khai cua hang; `estimated: true` = gia uoc luong tu
 * provider tuong tu (vd model tren gateway), khong phai gia niem yet.
 */
export const DEFAULT_MODEL_COSTS: Readonly<Record<string, ModelCostEntry>> = {
  // OpenAI
  'gpt-5': entry(1.25, 10),
  'gpt-5-mini': entry(0.25, 2),
  'gpt-4.1': entry(2, 8),
  'gpt-4o': entry(2.5, 10),
  'gpt-4o-mini': entry(0.15, 0.6),
  'o3': entry(2, 8),
  'o4-mini': entry(1.1, 4.4),
  'gpt-oss-120b': entry(0.1, 0.5, true),
  'gpt-oss-20b': entry(0.05, 0.2, true),
  // Anthropic
  'claude-opus-4-5': entry(5, 25),
  'claude-sonnet-4-5': entry(3, 15),
  'claude-haiku-4-5': entry(1, 5),
  'claude-3-7-sonnet': entry(3, 15),
  'claude-3-5-sonnet': entry(3, 15),
  // Google
  'gemini-3-pro': entry(2, 12),
  'gemini-2.5-pro': entry(1.25, 10),
  'gemini-2.5-flash': entry(0.3, 2.5),
  'gemini-2.0-flash': entry(0.1, 0.4),
  'gemini-1.5-pro': entry(1.25, 5),
  // xAI
  'grok-4': entry(3, 15),
  'grok-3': entry(3, 15),
  'grok-code-fast-1': entry(0.2, 1.5),
  // DeepSeek
  'deepseek-chat': entry(0.28, 0.42),
  'deepseek-reasoner': entry(0.55, 2.19),
  'deepseek-v4-flash': entry(0.2, 0.6, true),
  'deepseek-v3.2': entry(0.28, 0.42),
  'deepseek-r1': entry(0.55, 2.19),
  // Meta / Llama (gia tren Groq/Together, uoc luong)
  'llama-4-maverick': entry(0.2, 0.6, true),
  'llama-4-scout': entry(0.11, 0.34, true),
  'llama-3.3-70b': entry(0.35, 0.4, true),
  'llama-3.1-405b': entry(0.8, 0.8, true),
  'llama-3.1-70b': entry(0.35, 0.4, true),
  'llama-3.1-8b': entry(0.05, 0.08, true),
  'llama3.1': entry(0.2, 0.2, true),
  'llama3.3': entry(0.35, 0.4, true),
  // Qwen
  'qwen3-235b': entry(0.2, 0.8, true),
  'qwen3-32b': entry(0.1, 0.3, true),
  'qwen3-8b': entry(0.05, 0.2, true),
  'qwen3': entry(0.1, 0.3, true),
  'qwen-plus': entry(0.4, 1.2),
  'qwen-turbo': entry(0.05, 0.2),
  'qwen-max': entry(1.2, 4.8),
  'qwen2.5-coder': entry(0.05, 0.2, true),
  'qwen2.5': entry(0.05, 0.2, true),
  // Mistral
  'mistral-large': entry(2, 6),
  'mistral-medium': entry(0.4, 2),
  'mistral-small': entry(0.1, 0.3),
  'codestral': entry(0.2, 0.6, true),
  'mixtral-8x22b': entry(0.65, 0.65, true),
  // Moonshot / Kimi
  'kimi-k3': entry(0.5, 2, true),
  'kimi-k2': entry(0.6, 2.5),
  // Cohere
  'command-a': entry(2.5, 10),
  'command-r-plus': entry(3, 15),
  'command-r': entry(0.15, 0.6),
  // GLM / Zhipu
  'glm-4.7': entry(0.5, 2, true),
  'glm-4.5': entry(0.4, 1.6, true),
  // Perplexity
  sonar: entry(1, 1),
  // MiniMax / StepFun / others
  'MiniMax-M2': entry(0.3, 1.2, true),
  'step-2': entry(0.4, 1.6, true),
  'solar-pro': entry(0.5, 1.5, true),
  'jamba-large': entry(2, 8, true),
  'reka-flash': entry(0.8, 2.4, true),
  // Local pho bien (mien phi — chay tren may user)
  gemma3: entry(0, 0),
  'gemma-3': entry(0, 0),
  llava: entry(0, 0),
  mistral: entry(0, 0),
  'qwen2.5-vl': entry(0, 0),
  'deepseek-r1-distill': entry(0, 0),
};

/** Provider id nao duoc coi la local (cost = 0, khong can key). */
const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'ollama',
  'ollama-local',
  'lm-studio',
  'vllm',
  'llama-cpp',
  'text-generation-webui',
  'jan',
  'sglang',
  'tgi',
  'gpt4all',
  'localai',
  'koboldcpp',
  'open-webui',
  'litellm',
]);

/**
 * Id cua CLI provider (chay tren may user qua CLI da dang nhap,
 * khong tinh phi theo token — lay tu registry, khong hardcode de
 * khoi lech khi them CLI agent moi).
 */
const CLI_PROVIDER_IDS: ReadonlySet<string> = new Set(
  PROVIDERS.filter((p) => p.kind === 'cli').map((p) => p.id.toLowerCase()),
);

/**
 * true = provider chay local (cost = 0). Nhan dang 3 dang id:
 * - preset local (`ollama-local`, `vllm`, ...) — bang cung;
 * - model local da dang ky (`local:ollama`, `local:vllm`, ...) —
 *   tien to `local:` do localServers.ts dat;
 * - CLI provider (`claude-code`, `codex`, `aider`, ...) — chay tren
 *   may user, khong tinh phi theo token qua open-bot.
 */
export function isLocalProviderId(providerId: string): boolean {
  const id = providerId.toLowerCase();
  if (id.startsWith('local:')) return true;
  return LOCAL_PROVIDER_IDS.has(id) || CLI_PROVIDER_IDS.has(id);
}

/** Tim muc gia theo tien to dai nhat thang (khong phan biet hoa/thuong). */
function lookupModelCost(modelId: string): ModelCostEntry | undefined {
  const normalized = normalizeModelId(modelId);
  let best: ModelCostEntry | undefined;
  let bestLen = 0;
  for (const [prefix, value] of Object.entries(DEFAULT_MODEL_COSTS)) {
    const p = prefix.toLowerCase();
    if (normalized.startsWith(p) && p.length > bestLen) {
      best = value;
      bestLen = p.length;
    }
  }
  return best ? { ...best } : undefined;
}

/**
 * Bang cost co the cau hinh: gia mac dinh + override cua user.
 * Luu in-memory; host serialize bang `serialize()` de luu settings.
 */
export class CostTable {
  private readonly modelOverrides = new Map<string, ModelCostEntry>();
  private readonly providerDefaults = new Map<string, ProviderCostDefault>();

  constructor(opts?: {
    modelOverrides?: Readonly<Record<string, ModelCostEntry>>;
    providerDefaults?: Readonly<Record<string, ProviderCostDefault>>;
  }) {
    if (opts?.modelOverrides) {
      for (const [modelId, cost] of Object.entries(opts.modelOverrides)) {
        this.modelOverrides.set(normalizeModelId(modelId), { ...cost });
      }
    }
    if (opts?.providerDefaults) {
      for (const [providerId, cost] of Object.entries(opts.providerDefaults)) {
        this.providerDefaults.set(providerId.toLowerCase(), { ...cost });
      }
    }
  }

  /** Gia cua mot model tren mot provider (USD / 1M token). */
  costFor(modelId: string, providerId?: string): ModelCostEntry {
    const pid = (providerId ?? '').toLowerCase();
    if (pid && isLocalProviderId(pid)) return { inputPer1mUsd: 0, outputPer1mUsd: 0, estimated: false };
    const override = this.modelOverrides.get(normalizeModelId(modelId));
    if (override) return { ...override };
    const known = lookupModelCost(modelId);
    if (known) return known;
    if (pid) {
      const providerDefault = this.providerDefaults.get(pid) ?? DEFAULT_PROVIDER_COSTS[pid];
      if (providerDefault) {
        return { inputPer1mUsd: providerDefault.inputPer1mUsd, outputPer1mUsd: providerDefault.outputPer1mUsd, estimated: true };
      }
    }
    return {
      inputPer1mUsd: UNKNOWN_MODEL_INPUT_PER_1M_USD,
      outputPer1mUsd: UNKNOWN_MODEL_OUTPUT_PER_1M_USD,
      estimated: true,
    };
  }

  /** Gia trung binh (USD / 1k token) de so sanh provider — gia su input:output = 3:1. */
  costPer1kTokensUsd(modelId: string, providerId?: string): number {
    const cost = this.costFor(modelId, providerId);
    const avgPer1m = (cost.inputPer1mUsd * 3 + cost.outputPer1mUsd) / 4;
    return avgPer1m / 1000;
  }

  /** Uoc tinh chi phi mot call (USD) tu so token that. */
  estimateCostUsd(modelId: string, providerId: string | undefined, inputTokens: number, outputTokens: number): number {
    const cost = this.costFor(modelId, providerId);
    const inTokens = Math.max(0, inputTokens);
    const outTokens = Math.max(0, outputTokens);
    return (inTokens * cost.inputPer1mUsd + outTokens * cost.outputPer1mUsd) / 1_000_000;
  }

  /** Dat/ghi de gia mot model (user cau hinh). */
  setModelCost(modelId: string, cost: ModelCostEntry): void {
    this.modelOverrides.set(normalizeModelId(modelId), { ...cost });
  }

  /** Xoa override gia mot model (tro ve gia mac dinh). */
  clearModelCost(modelId: string): boolean {
    return this.modelOverrides.delete(normalizeModelId(modelId));
  }

  /** Dat/ghi de gia mac dinh mot provider. */
  setProviderDefault(providerId: string, cost: ProviderCostDefault): void {
    this.providerDefaults.set(providerId.toLowerCase(), { ...cost });
  }

  /** So override model hien co (de serialize). */
  modelOverrideCount(): number {
    return this.modelOverrides.size;
  }

  /** Serialize override de luu settings (chi override, khong luu bang mac dinh). */
  serialize(): { modelOverrides: Record<string, ModelCostEntry>; providerDefaults: Record<string, ProviderCostDefault> } {
    return {
      modelOverrides: Object.fromEntries(this.modelOverrides),
      providerDefaults: Object.fromEntries(this.providerDefaults),
    };
  }

  /** Khoi phuc tu du lieu da luu (bo qua muc la). */
  static deserialize(data: unknown): CostTable {
    const table = new CostTable();
    if (!data || typeof data !== 'object') return table;
    const rec = data as { modelOverrides?: unknown; providerDefaults?: unknown };
    if (rec.modelOverrides && typeof rec.modelOverrides === 'object') {
      for (const [modelId, cost] of Object.entries(rec.modelOverrides as Record<string, unknown>)) {
        if (cost && typeof cost === 'object') {
          const c = cost as Record<string, unknown>;
          if (typeof c.inputPer1mUsd === 'number' && typeof c.outputPer1mUsd === 'number') {
            table.setModelCost(modelId, {
              inputPer1mUsd: c.inputPer1mUsd,
              outputPer1mUsd: c.outputPer1mUsd,
              estimated: c.estimated === true,
            });
          }
        }
      }
    }
    if (rec.providerDefaults && typeof rec.providerDefaults === 'object') {
      for (const [providerId, cost] of Object.entries(rec.providerDefaults as Record<string, unknown>)) {
        if (cost && typeof cost === 'object') {
          const c = cost as Record<string, unknown>;
          if (typeof c.inputPer1mUsd === 'number' && typeof c.outputPer1mUsd === 'number') {
            table.setProviderDefault(providerId, { inputPer1mUsd: c.inputPer1mUsd, outputPer1mUsd: c.outputPer1mUsd });
          }
        }
      }
    }
    return table;
  }
}
