/**
 * Cerebras provider — POST https://api.cerebras.ai/v1/chat/completions.
 * Cerebras speaks the OpenAI chat-completions API, so the transport is
 * shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * v1.10 (Đội T6): promoted from the `cerebras` preset in
 * models/presets.ts to a dedicated provider, following the v1.08
 * precedent (OpenRouter / Fireworks). The preset stays untouched so
 * old configs keep working; the dedicated provider gives the model
 * picker + Vault namespace + health monitor their own `cerebras` id
 * instead of sharing `openai-compatible`.
 *
 * Model notes (checked against Cerebras' public docs, 2026-11):
 *  - Public Developer-tier catalog lists two models: `gpt-oss-120b`
 *    (default here) and `qwen-3.8-27b`.
 *  - The docs also list `qwen-3-235b-a22b-instruct-2507`,
 *    `llama-3.1-8b` and `zai-glm-4.7` as supported with strict tool
 *    calling — kept in the fallback list below.
 *  - Deliberately EXCLUDED: `llama-3.3-70b` and `qwen-3-32b`
 *    (deprecation scheduled 2026-02-16), `qwen-3-235b-a22b-thinking-2507`
 *    and `qwen-3-coder-480b` (deprecated — docs recommend migrating
 *    to gpt-oss-120b / GLM 4.7).
 *  - `GET /v1/models` returns the live catalog; when the endpoint
 *    answers, `listModels()` returns it, otherwise it falls back to
 *    CEREBRAS_KNOWN_MODELS. The catalog rotates often — known models
 *    below are a fallback only, never a promise that a model is
 *    still served.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
/** OpenAI GPT-OSS 120B — default for new Cerebras bots (public catalog). */
export const CEREBRAS_DEFAULT_MODEL = 'gpt-oss-120b';
/** Models listed when the API does not return a model list. */
export const CEREBRAS_KNOWN_MODELS = [
  'gpt-oss-120b',
  'qwen-3.8-27b',
  'qwen-3-235b-a22b-instruct-2507',
  'llama-3.1-8b',
  'zai-glm-4.7',
];

export class CerebrasProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'cerebras',
        label: config.label || 'Cerebras',
        baseUrl: config.baseUrl ?? CEREBRAS_BASE_URL,
        defaultModel: config.defaultModel || CEREBRAS_DEFAULT_MODEL,
      },
      CEREBRAS_KNOWN_MODELS,
    );
  }
}
