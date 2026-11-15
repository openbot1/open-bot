/**
 * SambaNova provider — POST https://api.sambanova.ai/v1/chat/completions.
 * SambaNova Cloud speaks the OpenAI chat-completions API, so the
 * transport is shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * v1.11 (Đội T6): promoted from the `sambanova` preset in
 * models/presets.ts to a dedicated provider, following the v1.08 /
 * v1.10 precedent (OpenRouter / Fireworks / Cerebras). The preset
 * stays untouched so old configs keep working; the dedicated provider
 * gives the model picker + Vault namespace + health monitor their own
 * `sambanova` id instead of sharing `openai-compatible`.
 *
 * Model notes (checked against SambaNova's public docs, 2026-11):
 *  - Default is `Meta-Llama-3.3-70B-Instruct` (the preset default).
 *  - The public catalog also lists `Llama-4-Maverick-17B-128E-Instruct`,
 *    `Llama-4-Scout-17B-16E-Instruct`, `DeepSeek-R1-0528`,
 *    `Qwen3-32B`, `Qwen3-235B-A22B-Instruct-2507` and
 *    `Meta-Llama-3.1-8B-Instruct` — kept in the fallback list below.
 *  - Deliberately EXCLUDED: older `Llama-3.1-405B` variants the docs
 *    no longer list as generally available.
 *  - `GET /v1/models` returns the live catalog; when the endpoint
 *    answers, `listModels()` returns it, otherwise it falls back to
 *    SAMBANOVA_KNOWN_MODELS. The catalog rotates often — known models
 *    below are a fallback only, never a promise that a model is
 *    still served.
 *  - Free-tier note from the preset (kept, still true in 2026-11):
 *    SambaNova's free tier asks for a payment method before the first
 *    call (a 402 was seen in a 2026-08-31 test). The user brings
 *    their own key; open-bot never bundles one.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const SAMBANOVA_BASE_URL = 'https://api.sambanova.ai/v1';
/** Meta Llama 3.3 70B Instruct — default for new SambaNova bots (preset default). */
export const SAMBANOVA_DEFAULT_MODEL = 'Meta-Llama-3.3-70B-Instruct';
/** Models listed when the API does not return a model list. */
export const SAMBANOVA_KNOWN_MODELS = [
  'Meta-Llama-3.3-70B-Instruct',
  'Llama-4-Maverick-17B-128E-Instruct',
  'Llama-4-Scout-17B-16E-Instruct',
  'DeepSeek-R1-0528',
  'Qwen3-32B',
  'Qwen3-235B-A22B-Instruct-2507',
  'Meta-Llama-3.1-8B-Instruct',
];

export class SambaNovaProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'sambanova',
        label: config.label || 'SambaNova',
        baseUrl: config.baseUrl ?? SAMBANOVA_BASE_URL,
        defaultModel: config.defaultModel || SAMBANOVA_DEFAULT_MODEL,
      },
      SAMBANOVA_KNOWN_MODELS,
    );
  }
}
