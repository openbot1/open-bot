/**
 * Fireworks AI provider — POST https://api.fireworks.ai/inference/v1/chat/completions.
 * Fireworks speaks the OpenAI chat-completions API, so the transport is
 * shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * v1.08 (Đội T4): promoted from the `fireworks` preset in
 * models/presets.ts to a dedicated provider, following the v0.97/v0.98
 * precedent (DeepSeek / Groq / Mistral / Together). The preset stays
 * untouched so old configs keep working; the dedicated provider gives
 * the model picker + Vault namespace + health monitor their own
 * `fireworks` id instead of sharing `openai-compatible`.
 *
 * Model notes (checked against Fireworks' docs, 2026-11):
 *  - Fireworks is serverless inference for open-weight models. Model
 *    ids on the inference API use the full form
 *    `accounts/fireworks/models/<model>` (same form as the preset's
 *    default model). Short ids are NOT accepted by the inference
 *    endpoint — every known model below keeps the full form.
 *  - `GET /v1/models` returns the live catalog; when the endpoint
 *    answers, `listModels()` returns it, otherwise it falls back to
 *    FIREWORKS_KNOWN_MODELS.
 *  - The catalog changes often — known models below are a fallback
 *    only, never a promise that a model is still served.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';
/** General-purpose Llama 3.3 70B — default for new Fireworks bots. */
export const FIREWORKS_DEFAULT_MODEL = 'accounts/fireworks/models/llama-v3p3-70b-instruct';
/** Models listed when the API does not return a model list. */
export const FIREWORKS_KNOWN_MODELS = [
  'accounts/fireworks/models/llama-v3p3-70b-instruct',
  'accounts/fireworks/models/llama-v3p1-8b-instruct',
  'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507',
  'accounts/fireworks/models/deepseek-v3p1',
  'accounts/fireworks/models/kimi-k2-instruct',
  'accounts/fireworks/models/gpt-oss-120b',
];

export class FireworksProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'fireworks',
        label: config.label || 'Fireworks AI',
        baseUrl: config.baseUrl ?? FIREWORKS_BASE_URL,
        defaultModel: config.defaultModel || FIREWORKS_DEFAULT_MODEL,
      },
      FIREWORKS_KNOWN_MODELS,
    );
  }
}
