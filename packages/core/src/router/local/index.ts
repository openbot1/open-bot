/**
 * Local model router (v1.15, Doi T3) — public exports.
 *
 * - Catalogue: models/localCatalog (Qwen3/Llama/Gemma + license validation).
 * - Registry: Ollama + llama.cpp router-mode-style (load on-demand, LRU).
 * - Policy: routing theo cost/latency/quality + override + fallback.
 * - Budget: virtual key + budget ngay/thang + spend tracking.
 * - Gateway: LiteLLM-style, loopback-only, virtual-key auth.
 * - Mock server: Ollama/llama.cpp gia cho test.
 */
export {
  ALLOWED_LICENSE_NAMES,
  DEFAULT_LOCAL_MODEL_ID,
  DEFAULT_ROUTER_MODEL_ID,
  LOCAL_MODEL_CATALOG,
  findLocalModel,
  localModelsForUseCase,
  localModelsFittingRam,
  validateModelLicense,
} from '../../models/localCatalog';
export type { LicenseValidation, LocalModelEntry, LocalModelLicense } from '../../models/localCatalog';

export * from './types';
export * from './lru';
export * from './registry';
export * from './policy';
export * from './budget';
export * from './gateway';
export * from './mockServer';
export * from './scoringV116';
export * from './fallbackV116';
export * from './cliSourcesV116';
export * from './batchingV116';
export * from './healthProbeV116';
export * from './pickerV116';
export * from './midChatRouterV117';
export * from './riskScoringV117';
export * from './confirmPolicyV117';
export * from './toolChoiceV118';
export * from './inlineToolsV118';
export * from './programmaticToolCallingV118';
export * from './botPolicyV118';
export * from './costAwareRoutingV118';
export * from './retryBackoffV118';
