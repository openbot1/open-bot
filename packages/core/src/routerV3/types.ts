/**
 * Local-model router v3 (v1.18, Doi T3) — shared types.
 *
 * Y tuong (hoc tu LiteLLM-style multi-provider routing, viet lai
 * hoan toan cho open-bot, khong copy code/text/tai san repo nao):
 * - Mot interface chat thong nhat (OpenAI-compatible) cho 100+
 *   provider: request chuan hoa mot lan, response chuan hoa mot lan,
 *   loi chuan hoa ve mot dang (RouterErrorKind) de retry/fallback
 *   quyet dinh duoc.
 * - Router chon provider/model theo policy do user chon (cheapest /
 *   fastest / balanced) dua tren bang cost cau hinh duoc + latency
 *   do that (rolling window), khong phai so tinh.
 * - Moi model khai bao capability (tool-calling, vision, streaming,
 *   JSON mode, context window, max output); task doi capability
 *   model khong co thi router tu choi + de xuat thay the.
 * - Fallback chain theo thu tu cau hinh + retry backoff + circuit
 *   breaker per provider (tai dung CircuitBreaker cua routerV2).
 * - Local server: Ollama / vLLM / LM Studio / llama.cpp / text-gen —
 *   quet endpoint loopback, health check dinh ky, tu dang ky model
 *   local vao router (cost = 0).
 *
 * Local-first, mien phi, khong du lieu X, khong cloud VM/tai khoan/
 * thanh toan. Khong goi API that trong core (executor inject duoc);
 * khong doc credential.
 */

import type { ChatCompletionRequest, ProviderResponse } from '../types';

/** Chinh sach chon provider/model cua router v3. */
export type RouterV3Policy = 'cheapest' | 'fastest' | 'balanced';

/** Loai server local ma router v3 biet quet. */
export type RouterV3LocalKind = 'ollama' | 'vllm' | 'lmstudio' | 'llamacpp' | 'textgen';

/** Capability cua mot model (khai bao, khong doan mo). */
export interface ModelCapability {
  /** Model co goi tool/function-calling duoc khong. */
  toolCalling: boolean;
  /** Model co nhan anh (vision) khong. */
  vision: boolean;
  /** Model co ho tro streaming (SSE) khong. */
  streaming: boolean;
  /** Model co ho tro JSON mode / structured output khong. */
  jsonMode: boolean;
  /** Context window (token). 0 = khong biet. */
  contextWindow: number;
  /** Max output token mot lan goi. 0 = khong biet. */
  maxOutputTokens: number;
  /** Model co reasoning (suy luan dai) khong. */
  reasoning: boolean;
  /** Nguon cua capability: 'known' = bang biet truoc, 'inferred' = suy tu ten, 'default' = mac dinh an toan. */
  source: 'known' | 'inferred' | 'default';
}

/** Yeu cau capability cua mot task. */
export interface CapabilityRequirement {
  /** Task can tool-calling. */
  needsToolCalling?: boolean;
  /** Task co anh dinh kem. */
  needsVision?: boolean;
  /** Task can streaming. */
  needsStreaming?: boolean;
  /** Task can JSON mode. */
  needsJsonMode?: boolean;
  /** Task can reasoning. */
  needsReasoning?: boolean;
  /** Context toi thieu task can (token). */
  minContextWindow?: number;
  /** Output toi thieu task can (token). */
  minOutputTokens?: number;
}

/** Ket qua kiem tra capability: thieu cai gi + de xuat thay the. */
export interface CapabilityCheckResult {
  /** true = model dap ung du yeu cau. */
  ok: boolean;
  /** Model duoc kiem tra. */
  modelId: string;
  /** Provider cua model (neu co). */
  providerId?: string;
  /** Capability thieu (rong khi ok). */
  missing: string[];
  /** Giai thich ngan gon (tieng Viet) khi khong dat. */
  reason?: string;
  /** Model thay the goi y (neu co, cung dap ung du yeu cau). */
  suggestedAlternative?: string;
}

/** Gia mac dinh cua mot model (USD / 1M token). */
export interface ModelCostEntry {
  /** Gia input (USD / 1M token). */
  inputPer1mUsd: number;
  /** Gia output (USD / 1M token). */
  outputPer1mUsd: number;
  /** true = gia uoc luong (chua kiem chung), false = gia cong khai da biet. */
  estimated: boolean;
}

/** Gia cua mot provider (fallback khi model khong co trong bang). */
export interface ProviderCostDefault {
  /** Gia mac dinh input (USD / 1M token) cho moi model cua provider. */
  inputPer1mUsd: number;
  /** Gia mac dinh output (USD / 1M token). */
  outputPer1mUsd: number;
}

/** Mot mau latency do that (ms). */
export interface LatencySample {
  /** Latency den token dau tien / hoan thanh (ms). */
  latencyMs: number;
  /** true = call thanh cong, false = loi (khong tinh vao p50). */
  ok: boolean;
  /** Thoi diem do (ms epoch). */
  at: number;
}

/** Thong ke latency cua mot provider+model (rolling window). */
export interface LatencyStats {
  /** So mau thanh cong trong window. */
  count: number;
  /** Trung binh (ms). */
  meanMs: number;
  /** p50 (ms). */
  p50Ms: number;
  /** p90 (ms). */
  p90Ms: number;
  /** Nhanh nhat (ms). */
  minMs: number;
  /** Cham nhat (ms). */
  maxMs: number;
  /** Ty le loi trong window (0..1). */
  errorRate: number;
  /** Lan cap nhat gan nhat (ms epoch). */
  updatedAt: number;
}

/** Phan loai provider trong catalog v3. */
export type RouterV3ProviderCategory =
  | 'gateway'
  | 'inference-cloud'
  | 'model-vendor'
  | 'regional'
  | 'local'
  | 'dedicated'
  | 'cli';

/** Mot muc trong catalog provider hop nhat cua router v3. */
export interface RouterV3ProviderEntry {
  /** Id on dinh (preset id / provider id / `cli:<kind>`). */
  id: string;
  /** Ten hien thi. */
  label: string;
  /** Base URL OpenAI-compatible ('' khi khong phai HTTP: CLI / Anthropic...). */
  baseUrl: string;
  /** Model mac dinh. */
  defaultModel: string;
  /** Phan loai. */
  category: RouterV3ProviderCategory;
  /** true = chay local (loopback), khong can key, cost = 0. */
  local: boolean;
  /** true = can key cua user (Vault). */
  needsKey: boolean;
  /** Nguon muc: 'preset' | 'dedicated' | 'cli'. */
  source: 'preset' | 'dedicated' | 'cli';
}

/** Mot ung vien provider+model de router v3 cham diem. */
export interface RouterV3Candidate {
  /** Id provider (preset id / provider id). */
  providerId: string;
  /** Base URL ('' khi CLI). */
  baseUrl: string;
  /** Id model. */
  modelId: string;
  /** Capability cua model. */
  capability: ModelCapability;
  /** Gia uoc tinh (USD / 1k token, input+output binh quan). */
  costPer1kTokensUsd: number;
  /** Latency uoc tinh den token dau tien (ms) — do that neu co, mac dinh neu chua. */
  estLatencyMs: number;
  /** Co phai model local khong (cost = 0). */
  local: boolean;
  /** Ly do loai bo (neu khong du kha nang / khong kha dung). */
  excludedReason?: string;
}

/** Ung vien da cham diem theo policy. */
export interface ScoredRouterV3Candidate extends RouterV3Candidate {
  /** Diem tong (0..1, cao hon tot hon). */
  score: number;
  breakdown: { costScore: number; latencyScore: number; capabilityScore: number };
  /** Giai thich ngan gon (tieng Viet). */
  explanation: string;
}

/** Mot model local da dang ky vao router v3. */
export interface RouterV3LocalModel {
  /** Id model tren server local, vd `qwen3:8b`. */
  modelId: string;
  /** Loai server: ollama / vllm / lmstudio... */
  serverKind: RouterV3LocalKind;
  /** Base URL cua server (khong `/v1` thua). */
  baseUrl: string;
  /** Provider id trong router: `local:<kind>`. */
  providerId: string;
  /** Capability (suy tu ten + bang biet truoc). */
  capability: ModelCapability;
  /** true = model dang chay san (Ollama /api/ps). */
  running: boolean;
  /** Dung luong (byte), neu server tra. */
  sizeBytes?: number;
  /** Lan thay cuoi (ms epoch). */
  discoveredAt: number;
}

/** Trang thai health cua mot server local. */
export interface LocalServerHealth {
  kind: RouterV3LocalKind;
  baseUrl: string;
  /** Server co phan hoi khong. */
  reachable: boolean;
  /** So model thay duoc lan probe gan nhat. */
  modelCount: number;
  /** Latency probe (ms). */
  probeLatencyMs: number;
  /** Loi gan nhat (neu co). */
  lastError?: string;
  /** Lan probe gan nhat (ms epoch). */
  lastCheckedAt: number;
  /** So lan probe lien tiep that bai. */
  consecutiveFailures: number;
}

/** Dinh nghia mot server local de quet (cau hinh duoc). */
export interface LocalServerDef {
  kind: RouterV3LocalKind;
  /** Base URL (khong `/v1` thua). */
  baseUrl: string;
  /** true = quet server nay. */
  enabled: boolean;
}

/** Mot buoc thu trong fallback chain v3. */
export interface RouterV3Attempt {
  providerId: string;
  modelId: string;
  /** So lan retry trong buoc nay (0 = lan dau). */
  attemptIndex: number;
  outcome: 'success' | 'failed' | 'skipped-circuit-open' | 'skipped-capability' | 'skipped-disabled';
  /** Loai loi chuan hoa (khi failed). */
  errorKind?: string;
  error?: string;
  latencyMs: number;
  attemptedAt: number;
}

/** Ket qua mot lan chat qua router v3. */
export interface RouterV3ChatResult {
  /** true = co provider tra ket qua. */
  ok: boolean;
  /** Response chuan hoa (khi ok). */
  response?: ProviderResponse;
  /** Provider da phuc vu. */
  servedByProviderId?: string;
  /** Model da phuc vu. */
  servedByModelId?: string;
  /** Cac buoc da thu (theo thu tu). */
  attempts: RouterV3Attempt[];
  /** Chi phi uoc tinh cua call thanh cong (USD). */
  costUsd?: number;
  /** Tong latency (ms). */
  totalLatencyMs: number;
  /** Huong dan cho user khi tat ca deu loi. */
  guidance?: string;
}

/** Cau hinh router v3. */
export interface RouterV3Config {
  /** Policy mac dinh. */
  policy: RouterV3Policy;
  /** So lan retry toi da cho mot provider khi loi retryable (khong tinh lan dau). */
  maxRetriesPerProvider: number;
  /** Backoff co so giua cac retry (ms); nhan doi moi lan. */
  retryBackoffBaseMs: number;
  /** Backoff toi da (ms). */
  retryBackoffMaxMs: number;
  /** So loi lien tiep thi mo circuit breaker cua provider. */
  circuitFailureThreshold: number;
  /** Thoi gian circuit mo truoc khi thu lai (ms). */
  circuitResetTimeoutMs: number;
  /** Thu tu fallback mac dinh (provider id theo thu tu uu tien). */
  fallbackOrder: string[];
  /** Provider bi tat (user). */
  disabledProviders: string[];
  /** Latency mac dinh (ms) khi chua co so do that. */
  defaultLatencyMs: number;
}

/** Cau hinh mac dinh router v3. */
export const DEFAULT_ROUTER_V3_CONFIG: RouterV3Config = {
  policy: 'balanced',
  maxRetriesPerProvider: 2,
  retryBackoffBaseMs: 500,
  retryBackoffMaxMs: 8000,
  circuitFailureThreshold: 3,
  circuitResetTimeoutMs: 60_000,
  fallbackOrder: [],
  disabledProviders: [],
  defaultLatencyMs: 1200,
};

/** Request chat qua router v3 (them policy + yeu cau capability). */
export interface RouterV3ChatRequest extends ChatCompletionRequest {
  /** Policy chon provider (mac dinh theo config). */
  policy?: RouterV3Policy;
  /** Yeu cau capability cua task (neu co). */
  requirements?: CapabilityRequirement;
  /** Provider uu tien (neu user chi dinh). */
  preferredProviderId?: string;
  /** Model uu tien (neu user chi dinh). */
  preferredModelId?: string;
}

/** Ham thuc thi mot chat call qua mot provider (injectable de test). */
export type RouterV3Executor = (
  providerId: string,
  baseUrl: string,
  req: ChatCompletionRequest,
) => Promise<ProviderResponse>;
