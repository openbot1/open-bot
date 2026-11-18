/**
 * Local-model router v3 (v1.18, Doi T3) — public exports.
 *
 * - Catalog: 100+ provider hop nhat (90 preset OpenAI-compatible +
 *   provider rieng + CLI) — providersCatalog.ts.
 * - Capability matrix per model + kiem tra yeu cau task —
 *   capabilities.ts.
 * - Cost table cau hinh duoc (gia theo model) — costTable.ts.
 * - Latency tracker (do that, rolling window) — latency.ts.
 * - Loi chuan hoa (phan loai + retryable + backoff) — errors.ts.
 * - Local server: Ollama / vLLM / LM Studio / llama.cpp / textgen —
 *   quet + health dinh ky + tu dang ky model — localServers.ts.
 * - Orchestrator LiteLLM-style: pick theo policy + fallback chain
 *   + retry + circuit breaker per provider — routerV3.ts.
 */
export * from './types';
export * from './errors';
export * from './capabilities';
export * from './costTable';
export * from './latency';
export * from './providersCatalog';
export * from './localServers';
export * from './routerV3';
