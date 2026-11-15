/**
 * OpenRouter provider — POST https://openrouter.ai/api/v1/chat/completions.
 * OpenRouter speaks the OpenAI chat-completions API, so the transport is
 * shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * v1.08 (Đội T4): promoted from the `openrouter` preset in
 * models/presets.ts to a dedicated provider, following the v0.97/v0.98
 * precedent (DeepSeek / Groq / Mistral / Together). The preset stays
 * untouched so old configs keep working; the dedicated provider gives
 * the model picker + Vault namespace + health monitor their own
 * `openrouter` id instead of sharing `openai-compatible`.
 *
 * Model notes (checked against OpenRouter's docs, 2026-11):
 *  - OpenRouter is a router, not a model maker: one key reaches 400+
 *    models from many vendors under `<vendor>/<model>` ids, plus the
 *    `openrouter/auto` router that picks a model per prompt. The
 *    default here is `openrouter/auto` (same default as the preset).
 *  - `GET /models` returns the live catalog (ids + pricing + context
 *    length); when the endpoint answers, `listModels()` returns it,
 *    otherwise it falls back to OPENROUTER_KNOWN_MODELS.
 *  - OpenRouter accepts two OPTIONAL routing headers
 *    (`HTTP-Referer` + `X-Title`, used for its public leaderboards);
 *    they are not sent here — the API works without them and this
 *    client never leaks the app's identity to a third party.
 *  - The catalog changes often — known models below are a fallback
 *    only, never a promise that a model is still served.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** Router model — OpenRouter picks a model per prompt. */
export const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto';
/** Models listed when the API does not return a model list. */
export const OPENROUTER_KNOWN_MODELS = [
  'openrouter/auto',
  'meta-llama/llama-3.3-70b-instruct',
  'google/gemini-2.5-flash',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-4o-mini',
  'deepseek/deepseek-chat',
];

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'openrouter',
        label: config.label || 'OpenRouter',
        baseUrl: config.baseUrl ?? OPENROUTER_BASE_URL,
        defaultModel: config.defaultModel || OPENROUTER_DEFAULT_MODEL,
      },
      OPENROUTER_KNOWN_MODELS,
    );
  }
}
