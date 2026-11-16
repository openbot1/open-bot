/**
 * Local model router — shared types (v1.15, Doi T3).
 *
 * Y tuong: llama.cpp router-mode (mot process quan nhieu model, route
 * theo `model`, load on-demand, LRU unload) + LiteLLM gateway pattern
 * (virtual keys, budgets, spend tracking) truoc endpoint noi bo chi
 * listen 127.0.0.1. Toan bo thiet ke viet lai cho open-bot.
 */

import type { LocalModelEntry } from '../../models/localCatalog';

/** Backend chay model local. */
export type LocalBackendKind = 'ollama' | 'llamacpp';

/** Trang thai load cua mot model. */
export type LocalModelLoadState = 'unloaded' | 'loading' | 'loaded' | 'failed' | 'unloading';

/** Endpoint noi bo OpenAI-compatible cua mot backend. */
export interface LocalBackendEndpoint {
  kind: LocalBackendKind;
  /** Base URL, luon loopback: http://127.0.0.1:<port>. */
  baseUrl: string;
  port: number;
  /** true = process/backend dang chay va tra health. */
  healthy: boolean;
  lastHealthCheckAt?: number;
}

/** Mot model local dang duoc quan ly boi registry. */
export interface LocalModelInstance {
  entry: LocalModelEntry;
  backend: LocalBackendKind;
  state: LocalModelLoadState;
  /** Endpoint phuc vu model nay (neu loaded). */
  endpoint?: string;
  /** Process id cua llama-server (neu backend llamacpp). */
  pid?: number;
  loadedAt?: number;
  lastUsedAt?: number;
  /** So task dang chay tren model nay (de LRU khong unload model dang ban). */
  activeTasks: number;
  /** true = user pin — LRU khong duoc unload tru khi bat buoc. */
  pinned: boolean;
  /** Loi lan load gan nhat (neu state = failed). */
  lastError?: string;
  /** So lan load that lien tiep (de backoff). */
  consecutiveFailures: number;
}

/** Thong tin RAM he thong (byte). */
export interface RamSnapshot {
  totalBytes: number;
  freeBytes: number;
  /** RAM registry duoc phep dung cho model (gioi han cau hinh). */
  budgetBytes: number;
  /** RAM cac model dang loaded chiem (uoc tinh theo catalogue). */
  usedByModelsBytes: number;
  takenAt: number;
}

/** Cau hinh LRU load/unload. */
export interface LruConfig {
  /** So model toi da dong thoi (tuong duong --models-max cua llama.cpp). */
  maxLoadedModels: number;
  /** RAM toi da cho model (byte). 0 = khong gioi han rieng, dung maxLoadedModels. */
  maxRamBytes: number;
  /** Idle bao lau (ms) thi duoc phep unload (mac dinh 10 phut). */
  idleTimeoutMs: number;
  /** true = khong unload model dang co activeTasks > 0. */
  protectActive: boolean;
}

/** Cau hinh mac dinh LRU. */
export const DEFAULT_LRU_CONFIG: LruConfig = {
  maxLoadedModels: 2,
  maxRamBytes: 0,
  idleTimeoutMs: 10 * 60 * 1000,
  protectActive: true,
};

/** Loai task de policy router phan loai. */
export type RouterTaskKind = 'simple-chat' | 'code' | 'reasoning' | 'research' | 'creative' | 'howto' | 'summarize' | 'translate';

/** Mo ta mot task can route. */
export interface RouterTask {
  kind: RouterTaskKind;
  /** Do dai prompt uoc tinh (token). */
  promptTokens: number;
  /** Co can tool-use khong. */
  needsToolUse: boolean;
  /** Co can context dai (> 32k) khong. */
  needsLongContext: boolean;
  /** Do uu tien chat luong (0..1): 1 = bat buoc model manh nhat. */
  qualityNeed: number;
  /** Nguoi dung chi dinh model cu the (override). */
  manualModelId?: string;
  /** Bot goi task (de tinh budget per-bot). */
  botId?: string;
}

/** Mot ung vien route (local hoac cloud). */
export interface RouteCandidate {
  /** 'local' | 'cloud'. */
  kind: 'local' | 'cloud';
  /** Id model (catalogue local hoac ten model cloud). */
  modelId: string;
  /** Chi phi uoc tinh (USD / 1k token). */
  costPer1kTokensUsd: number;
  /** Latency uoc tinh den token dau tien (ms). */
  estLatencyMs: number;
  /** Chat luong uoc tinh (0..1). */
  quality: number;
  /** Ly do loai bo (neu khong du kha nang: het RAM, khong tool-use...). */
  excludedReason?: string;
}

/** Ket qua scoring mot ung vien. */
export interface ScoredCandidate extends RouteCandidate {
  score: number;
  breakdown: { costScore: number; latencyScore: number; qualityScore: number };
}

/** Quyet dinh route cuoi cung. */
export interface RouteDecision {
  chosen: ScoredCandidate;
  /** Cac ung vien fallback theo thu tu (khi chosen fail). */
  fallbacks: ScoredCandidate[];
  /** Giai thich ngan cho UI/log. */
  reason: string;
  /** true = quyet dinh tu manual override. */
  manualOverride: boolean;
  decidedAt: number;
}

/** Trong so scoring (tong = 1). */
export interface RouterWeights {
  cost: number;
  latency: number;
  quality: number;
}

/** Cau hinh policy router. */
export interface PolicyRouterConfig {
  weights: RouterWeights;
  /** Chi phi mac dinh cua model local (dien + khau hao, USD/1k token). */
  localCostPer1kTokensUsd: number;
  /** Latency mac dinh khi load on-demand (ms, cong them khi model chua loaded). */
  coldStartPenaltyMs: number;
  /** Nguong qualityNeed de bat buoc cloud (>=). */
  cloudQualityThreshold: number;
  /** Task code/reasoning co prompt > nguong nay thi uu tien cloud. */
  heavyPromptTokens: number;
}

/** Cau hinh mac dinh policy router. */
export const DEFAULT_POLICY_CONFIG: PolicyRouterConfig = {
  weights: { cost: 0.4, latency: 0.3, quality: 0.3 },
  localCostPer1kTokensUsd: 0.0001,
  coldStartPenaltyMs: 5000,
  cloudQualityThreshold: 0.85,
  heavyPromptTokens: 8000,
};

/** Mot dong spend (ghi theo tung call). */
export interface SpendRecord {
  id: string;
  botId: string;
  modelId: string;
  /** 'local' | 'cloud'. */
  kind: 'local' | 'cloud';
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  virtualKeyId?: string;
  at: number;
}

/** Ngan sach (ngay hoac thang). */
export interface BudgetLimit {
  /** 'daily' | 'monthly'. */
  period: 'daily' | 'monthly';
  /** Gioi han USD. 0 = khong gioi han. */
  limitUsd: number;
  /** Canh bao khi dat ti le nay (0..1, mac dinh 0.8). */
  warnAt: number;
  /** Chan call moi khi vuot gioi han (mac dinh true). */
  blockOnExceed: boolean;
}

/** Virtual key (LiteLLM-style) gan cho mot bot. */
export interface VirtualKey {
  id: string;
  botId: string;
  /** Key hien thi dang rut gon (khong luu full key o log). */
  keyHint: string;
  budget: BudgetLimit;
  /** true = key bi vo hieu hoa. */
  revoked: boolean;
  createdAt: number;
  expiresAt?: number;
}

/** Trang thai ngan sach tai mot thoi diem. */
export interface LocalBudgetStatus {
  period: 'daily' | 'monthly';
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  usageRatio: number;
  state: 'ok' | 'warning' | 'exceeded' | 'unlimited';
  windowStart: number;
  windowEnd: number;
}

/** Bao cao spend tong hop. */
export interface SpendReport {
  period: 'daily' | 'monthly';
  windowStart: number;
  windowEnd: number;
  totalUsd: number;
  totalCalls: number;
  totalTokens: number;
  byModel: Array<{ modelId: string; calls: number; tokens: number; costUsd: number }>;
  byBot: Array<{ botId: string; calls: number; tokens: number; costUsd: number }>;
  localUsd: number;
  cloudUsd: number;
}

/** Cau hinh gateway noi bo (LiteLLM-style). */
export interface LocalGatewayConfig {
  /** Port gateway (loopback). */
  port: number;
  /** true = bat buoc virtual key moi request. */
  requireKey: boolean;
  /** Rate limit: so request toi da moi phut moi key. 0 = khong gioi han. */
  rateLimitPerMinute: number;
  /** Ngan sach mac dinh khi tao key moi. */
  defaultBudget: BudgetLimit;
}

/** Cau hinh mac dinh gateway. */
export const DEFAULT_GATEWAY_CONFIG: LocalGatewayConfig = {
  port: 11880,
  requireKey: true,
  rateLimitPerMinute: 120,
  defaultBudget: { period: 'monthly', limitUsd: 10, warnAt: 0.8, blockOnExceed: true },
};

/** Ket qua kiem tra loopback-only. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch {
    return false;
  }
}

/** Dinh dang so byte thanh chuoi doc duoc (vd 2.5 GB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Dinh dang USD. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}
