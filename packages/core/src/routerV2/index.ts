/**
 * Local-model router v2 (v1.16, Doi T3) — public exports.
 *
 * - Discovery: quet models-dir (GGUF that, doc header) + preset INI.
 * - Resource: uoc tinh footprint (GGUF + KV cache) + RAM/VRAM that.
 * - Process: moi model mot child process, crash isolation, restart backoff.
 * - LRU v2: evict theo byte RAM/VRAM + TTL idle.
 * - Swap-groups: nhom chia tai nguyen, embedder luon resident, preemption.
 * - Picker v2: cham diem cost/latency/quality + giai thich + nho lua chon user.
 * - CLI probe v2: probe sau 6 CLI agent (version range + format + login + model list).
 * - Fallback: cloud -> CLI -> local, circuit breaker + health + budget (noi v1.15).
 * - Router: orchestrator load on-demand + route + sweep.
 */
export * from './types';
export * from './discovery';
export * from './presets';
export * from './resourceEstimator';
export * from './processManager';
export * from './lruV2';
export * from './swapGroups';
export * from './pickerV2';
export * from './cliProbeV2';
export * from './fallback';
export * from './routerV2';
