/**
 * Unified router v3 (v1.18, Doi T3) — LiteLLM-style orchestrator.
 *
 * Mot interface chat thong nhat cho 100+ provider OpenAI-compatible
 * + model local:
 * - `pickCandidates`: cham diem provider/model theo policy cua user
 *   (cheapest / fastest / balanced) dua tren bang cost cau hinh
 *   duoc + latency do that (rolling window) + capability; loai bo
 *   model khong du capability / provider bi tat / circuit mo.
 * - `chat`: chay request qua fallback chain theo thu tu da cham
 *   diem; moi provider retry co backoff khi loi retryable, circuit
 *   breaker per provider (tai dung CircuitBreaker cua routerV2);
 *   ghi latency that + uoc tinh cost; tra ket qua chuan hoa +
 *   huong dan khi tat ca deu loi.
 * - `registerLocalModels`: model local tu scan (Ollama/vLLM/LM
 *   Studio/...) dang ky vao router, cost = 0, duoc cham diem nhu
 *   provider thuong.
 *
 * Executor mac dinh goi OpenAI-compatible `/chat/completions` qua
 * `openAIChatCompletions` (khong doc Vault — key lay tu `apiKeys`
 * do host truyen vao; khong co key thi bao loi auth ro rang).
 * Test inject executor gia (khong goi API that).
 */

import { openAIChatCompletions } from '../providers/openaiCompatible';
import { CircuitBreaker } from '../routerV2/fallback';
import type { ChatCompletionRequest, ProviderResponse } from '../types';
import { capabilitiesForModel, checkRequirements } from './capabilities';
import { CostTable } from './costTable';
import { classifyFetchError, classifyProviderError, retryDelayMs, shouldRetry, buildRouterV3FailureGuidance, type RouterV3Error } from './errors';
import { LatencyTracker } from './latency';
import { listV3Providers } from './providersCatalog';
import { localModelChatBaseUrl } from './localServers';
import type {
  CapabilityRequirement,
  RouterV3Attempt,
  RouterV3Candidate,
  RouterV3ChatRequest,
  RouterV3ChatResult,
  RouterV3Config,
  RouterV3Executor,
  RouterV3LocalModel,
  RouterV3Policy,
  ScoredRouterV3Candidate,
} from './types';
import { DEFAULT_ROUTER_V3_CONFIG } from './types';

/** Trong so cham diem theo policy. */
export const ROUTER_V3_WEIGHTS: Record<RouterV3Policy, { cost: number; latency: number; capability: number }> = {
  cheapest: { cost: 0.6, latency: 0.2, capability: 0.2 },
  fastest: { cost: 0.15, latency: 0.65, capability: 0.2 },
  balanced: { cost: 0.35, latency: 0.35, capability: 0.3 },
};

/** Chuan hoa gia tri nho hon tot hon ve 0..1 (min-max tren tap ung vien). */
export function normalizeLowerBetterV3(value: number, min: number, max: number): number {
  if (max <= min) return 1;
  return Math.min(1, Math.max(0, 1 - (value - min) / (max - min)));
}

/** Chuan hoa gia tri lon hon tot hon ve 0..1 (min-max tren tap ung vien). */
export function normalizeHigherBetterV3(value: number, min: number, max: number): number {
  if (max <= min) return 1;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Giai thich ngan gon vi sao ung vien nay duoc diem nhu vay. */
export function explainRouterV3Candidate(
  candidate: RouterV3Candidate,
  breakdown: { costScore: number; latencyScore: number; capabilityScore: number },
  policy: RouterV3Policy,
): string {
  const parts: string[] = [];
  if (candidate.local) parts.push('Local (mien phi, khong gui du lieu ra ngoai)');
  else parts.push(`Qua ${candidate.providerId}`);
  if (candidate.costPer1kTokensUsd <= 0) parts.push('chi phi 0');
  else if (candidate.costPer1kTokensUsd <= 0.0005) parts.push('rat re');
  if (candidate.estLatencyMs <= 300) parts.push('phan hoi rat nhanh');
  else if (candidate.estLatencyMs >= 2000) parts.push('latency cao');
  if (candidate.capability.contextWindow >= 1_000_000) parts.push('context rat dai');
  else if (candidate.capability.contextWindow >= 128_000) parts.push('context dai');
  if (candidate.capability.vision) parts.push('co vision');
  if (candidate.capability.reasoning) parts.push('co reasoning');
  if (policy === 'cheapest' && breakdown.costScore >= 0.9) parts.push('re nhat trong danh sach');
  if (policy === 'fastest' && breakdown.latencyScore >= 0.9) parts.push('nhanh nhat trong danh sach');
  return parts.join('; ') + '.';
}

/** Executor mac dinh: OpenAI-compatible chat (key do host truyen vao). */
export function createDefaultRouterV3Executor(apiKeys?: Readonly<Record<string, string>>): RouterV3Executor {
  return async (providerId, baseUrl, req) => {
    if (!baseUrl) {
      throw new Error(`${providerId}: provider nay khong co baseUrl HTTP (CLI hoac API rieng) — can executor rieng.`);
    }
    const apiKey = apiKeys?.[providerId];
    return openAIChatCompletions(baseUrl, apiKey, providerId, req);
  };
}

/** Trang thai circuit breaker cua mot provider (de UI ve). */
export interface RouterV3CircuitStatus {
  providerId: string;
  state: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  failureThreshold: number;
  openedAt?: number;
  resetTimeoutMs: number;
  lastError?: string;
}

export class UnifiedRouterV3 {
  readonly config: RouterV3Config;
  readonly costTable: CostTable;
  readonly latencyTracker: LatencyTracker;
  private readonly executor: RouterV3Executor;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly localModels: RouterV3LocalModel[] = [];
  private readonly extraCandidates: RouterV3Candidate[] = [];
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(opts?: {
    config?: Partial<RouterV3Config>;
    costTable?: CostTable;
    latencyTracker?: LatencyTracker;
    executor?: RouterV3Executor;
    apiKeys?: Readonly<Record<string, string>>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.config = { ...DEFAULT_ROUTER_V3_CONFIG, ...(opts?.config ?? {}) };
    this.costTable = opts?.costTable ?? new CostTable();
    this.latencyTracker = opts?.latencyTracker ?? new LatencyTracker();
    this.executor = opts?.executor ?? createDefaultRouterV3Executor(opts?.apiKeys);
    this.nowFn = opts?.now ?? Date.now;
    this.sleepFn = opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Dang ky model local tim duoc tu scan (ghi de model cung provider+id). */
  registerLocalModels(models: readonly RouterV3LocalModel[]): void {
    for (const model of models) {
      const index = this.localModels.findIndex(
        (m) => m.providerId === model.providerId && m.modelId === model.modelId,
      );
      if (index >= 0) this.localModels[index] = { ...model };
      else this.localModels.push({ ...model });
    }
  }

  /** Tat ca model local da dang ky. */
  listLocalModels(): RouterV3LocalModel[] {
    return this.localModels.map((m) => ({ ...m }));
  }

  /** Them ung vien tuy chinh (vd provider rieng cua user). */
  addCandidate(candidate: RouterV3Candidate): void {
    const index = this.extraCandidates.findIndex(
      (c) => c.providerId === candidate.providerId && c.modelId === candidate.modelId,
    );
    if (index >= 0) this.extraCandidates[index] = { ...candidate };
    else this.extraCandidates.push({ ...candidate });
  }

  /** Tat provider (user). */
  disableProvider(providerId: string): void {
    if (!this.config.disabledProviders.includes(providerId)) {
      this.config.disabledProviders.push(providerId);
    }
  }

  /** Bat lai provider. */
  enableProvider(providerId: string): void {
    this.config.disabledProviders = this.config.disabledProviders.filter((id) => id !== providerId);
  }

  /** Circuit breaker cua mot provider (tao khi can). */
  breakerFor(providerId: string): CircuitBreaker {
    let breaker = this.breakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker('cloud', providerId, {
        failureThreshold: this.config.circuitFailureThreshold,
        resetTimeoutMs: this.config.circuitResetTimeoutMs,
      });
      this.breakers.set(providerId, breaker);
    }
    return breaker;
  }

  /** Trang thai circuit breaker cua tat ca provider da gap loi. */
  circuitStatus(now: number = this.nowFn()): RouterV3CircuitStatus[] {
    return [...this.breakers.values()].map((b) => {
      const health = b.toHealth(now);
      return {
        providerId: b.sourceId,
        state: health.circuit,
        consecutiveFailures: health.consecutiveFailures,
        failureThreshold: health.failureThreshold,
        openedAt: health.openedAt,
        resetTimeoutMs: health.resetTimeoutMs,
        lastError: health.lastError,
      };
    });
  }

  /** Reset circuit breaker mot provider (user bat lai). */
  resetCircuit(providerId: string): boolean {
    const breaker = this.breakers.get(providerId);
    if (!breaker) return false;
    breaker.reset();
    return true;
  }

  /**
   * Ung vien goc: catalog provider (model mac dinh) + model local da
   * dang ky + ung vien tuy chinh. Local model thay the ung vien
   * catalog cung provider (vd `local:ollama` thay preset ollama).
   */
  buildCandidates(): RouterV3Candidate[] {
    const candidates: RouterV3Candidate[] = [];
    for (const entry of listV3Providers()) {
      if (entry.source === 'cli' || entry.source === 'dedicated') continue;
      if (!entry.defaultModel) continue;
      candidates.push({
        providerId: entry.id,
        baseUrl: entry.baseUrl,
        modelId: entry.defaultModel,
        capability: capabilitiesForModel(entry.defaultModel),
        costPer1kTokensUsd: this.costTable.costPer1kTokensUsd(entry.defaultModel, entry.id),
        estLatencyMs: this.latencyTracker.estimatedLatencyMs(entry.id, entry.defaultModel, this.config.defaultLatencyMs),
        local: entry.local,
      });
    }
    for (const model of this.localModels) {
      const index = candidates.findIndex((c) => c.providerId === model.providerId);
      const candidate: RouterV3Candidate = {
        providerId: model.providerId,
        baseUrl: localModelChatBaseUrl(model),
        modelId: model.modelId,
        capability: model.capability,
        costPer1kTokensUsd: 0,
        estLatencyMs: this.latencyTracker.estimatedLatencyMs(model.providerId, model.modelId, 250),
        local: true,
      };
      if (index >= 0) candidates[index] = candidate;
      else candidates.push(candidate);
    }
    for (const extra of this.extraCandidates) {
      const index = candidates.findIndex(
        (c) => c.providerId === extra.providerId && c.modelId === extra.modelId,
      );
      if (index >= 0) candidates[index] = { ...extra };
      else candidates.push({ ...extra });
    }
    return candidates;
  }

  /**
   * Cham diem + sap xep ung vien theo policy. Ung vien khong du
   * capability / bi tat / circuit mo van co trong ket qua kem
   * `excludedReason` (de UI giai thich), nhung xep sau cung.
   */
  rankCandidates(opts?: {
    policy?: RouterV3Policy;
    requirements?: CapabilityRequirement;
    preferredProviderId?: string;
    preferredModelId?: string;
  }): ScoredRouterV3Candidate[] {
    const policy = opts?.policy ?? this.config.policy;
    const requirements = opts?.requirements;
    const weights = ROUTER_V3_WEIGHTS[policy];
    const candidates = this.buildCandidates();
    const costs = candidates.map((c) => c.costPer1kTokensUsd);
    const latencies = candidates.map((c) => c.estLatencyMs);
    const contexts = candidates.map((c) => c.capability.contextWindow);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const minContext = Math.min(...contexts);
    const maxContext = Math.max(...contexts);
    const scored: ScoredRouterV3Candidate[] = candidates.map((candidate) => {
      const costScore = normalizeLowerBetterV3(candidate.costPer1kTokensUsd, minCost, maxCost);
      const latencyScore = normalizeLowerBetterV3(candidate.estLatencyMs, minLatency, maxLatency);
      const capabilityScore = normalizeHigherBetterV3(candidate.capability.contextWindow, minContext, maxContext);
      const breakdown = { costScore, latencyScore, capabilityScore };
      const score = weights.cost * costScore + weights.latency * latencyScore + weights.capability * capabilityScore;
      let excludedReason: string | undefined;
      if (this.config.disabledProviders.includes(candidate.providerId)) {
        excludedReason = 'provider-bi-tat';
      } else if (requirements) {
        const check = checkRequirements(candidate.modelId, requirements, candidate.providerId, candidate.capability);
        if (!check.ok) excludedReason = `thieu-capability:${check.missing.join(',')}`;
      }
      if (!excludedReason && this.breakerFor(candidate.providerId).state(this.nowFn()) === 'open') {
        excludedReason = 'circuit-mo';
      }
      return {
        ...candidate,
        score,
        breakdown,
        explanation: explainRouterV3Candidate(candidate, breakdown, policy),
        ...(excludedReason ? { excludedReason } : {}),
      };
    });
    // Preferred len dau (neu dat); con lai theo diem giam dan.
    const preferred = opts?.preferredProviderId ?? opts?.preferredModelId;
    scored.sort((a, b) => {
      const aPreferred =
        preferred !== undefined &&
        ((opts?.preferredProviderId !== undefined && a.providerId === opts.preferredProviderId) ||
          (opts?.preferredModelId !== undefined && a.modelId === opts.preferredModelId));
      const bPreferred =
        preferred !== undefined &&
        ((opts?.preferredProviderId !== undefined && b.providerId === opts.preferredProviderId) ||
          (opts?.preferredModelId !== undefined && b.modelId === opts.preferredModelId));
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
      const aExcluded = a.excludedReason !== undefined;
      const bExcluded = b.excludedReason !== undefined;
      if (aExcluded !== bExcluded) return aExcluded ? 1 : -1;
      return b.score - a.score;
    });
    // Ap thu tu fallback cau hinh (neu co): provider trong list len truoc.
    // Ung vien bi loai (tat / thieu capability / circuit mo) van xep
    // sau ung vien dung duoc — neu khong, provider da tat co the hien
    // tren provider dung duoc chi vi diem cao hon.
    if (this.config.fallbackOrder.length > 0) {
      const order = this.config.fallbackOrder;
      scored.sort((a, b) => {
        const aExcluded = a.excludedReason !== undefined;
        const bExcluded = b.excludedReason !== undefined;
        if (aExcluded !== bExcluded) return aExcluded ? 1 : -1;
        const ai = order.indexOf(a.providerId);
        const bi = order.indexOf(b.providerId);
        const aRank = ai === -1 ? order.length : ai;
        const bRank = bi === -1 ? order.length : bi;
        if (aRank !== bRank) return aRank - bRank;
        return b.score - a.score;
      });
    }
    return scored;
  }

  /**
   * Chat qua router v3: chon provider theo policy, thu theo thu tu,
   * retry co backoff khi loi retryable, circuit breaker per provider.
   * Tra ket qua chuan hoa + so buoc da thu + cost uoc tinh.
   */
  async chat(req: RouterV3ChatRequest): Promise<RouterV3ChatResult> {
    const startedAt = this.nowFn();
    const ranked = this.rankCandidates({
      policy: req.policy,
      requirements: req.requirements,
      preferredProviderId: req.preferredProviderId,
      preferredModelId: req.preferredModelId,
    });
    const attempts: RouterV3Attempt[] = [];
    const chatReq: ChatCompletionRequest = {
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      stop: req.stop,
      signal: req.signal,
    };
    for (const candidate of ranked) {
      const attemptStarted = this.nowFn();
      if (candidate.excludedReason === 'provider-bi-tat') {
        attempts.push({
          providerId: candidate.providerId, modelId: candidate.modelId, attemptIndex: 0,
          outcome: 'skipped-disabled', latencyMs: 0, attemptedAt: attemptStarted,
        });
        continue;
      }
      if (candidate.excludedReason !== undefined && candidate.excludedReason.startsWith('thieu-capability')) {
        attempts.push({
          providerId: candidate.providerId, modelId: candidate.modelId, attemptIndex: 0,
          outcome: 'skipped-capability', latencyMs: 0, attemptedAt: attemptStarted,
        });
        continue;
      }
      if (candidate.excludedReason === 'circuit-mo') {
        attempts.push({
          providerId: candidate.providerId, modelId: candidate.modelId, attemptIndex: 0,
          outcome: 'skipped-circuit-open', latencyMs: 0, attemptedAt: attemptStarted,
        });
        continue;
      }
      const breaker = this.breakerFor(candidate.providerId);
      if (!breaker.allowRequest(this.nowFn())) {
        attempts.push({
          providerId: candidate.providerId, modelId: candidate.modelId, attemptIndex: 0,
          outcome: 'skipped-circuit-open', latencyMs: 0, attemptedAt: attemptStarted,
        });
        continue;
      }
      const requestForProvider: ChatCompletionRequest = { ...chatReq, model: candidate.modelId };
      let lastError: RouterV3Error | undefined;
      for (let attempt = 0; attempt <= this.config.maxRetriesPerProvider; attempt += 1) {
        const callStarted = this.nowFn();
        try {
          const response = await this.executor(candidate.providerId, candidate.baseUrl, requestForProvider);
          const latencyMs = this.nowFn() - callStarted;
          this.latencyTracker.record(candidate.providerId, candidate.modelId, latencyMs, true, this.nowFn());
          breaker.recordSuccess();
          attempts.push({
            providerId: candidate.providerId, modelId: candidate.modelId, attemptIndex: attempt,
            outcome: 'success', latencyMs, attemptedAt: callStarted,
          });
          const costUsd = this.costTable.estimateCostUsd(
            candidate.modelId,
            candidate.providerId,
            response.usage?.inputTokens ?? 0,
            response.usage?.outputTokens ?? 0,
          );
          return {
            ok: true,
            response,
            servedByProviderId: candidate.providerId,
            servedByModelId: candidate.modelId,
            attempts,
            costUsd,
            totalLatencyMs: this.nowFn() - startedAt,
          };
        } catch (error) {
          const latencyMs = this.nowFn() - callStarted;
          this.latencyTracker.record(candidate.providerId, candidate.modelId, latencyMs, false, this.nowFn());
          const maybeKind = (error as { kind?: unknown } | null)?.kind;
          if (typeof maybeKind === 'string' && maybeKind.length > 0) {
            lastError = error as RouterV3Error;
          } else {
            lastError = classifyFetchError(candidate.providerId, error);
          }
          // Loi HTTP co status thi phan loai lai tu message (executor
          // mac dinh nem Error `${label}: HTTP ${status} ...`).
          if (error instanceof Error && /HTTP \d{3}/.test(error.message)) {
            const statusMatch = /HTTP (\d{3})/.exec(error.message);
            const status = statusMatch ? Number(statusMatch[1]) : undefined;
            const body = error.message.slice(error.message.indexOf('—') + 1).trim();
            lastError = classifyProviderError(candidate.providerId, status, body);
          }
          attempts.push({
            providerId: candidate.providerId, modelId: candidate.modelId, attemptIndex: attempt,
            outcome: 'failed', errorKind: lastError.kind,
            error: lastError.message.slice(0, 300), latencyMs, attemptedAt: callStarted,
          });
          breaker.recordFailure(lastError.message, this.nowFn());
          if (!shouldRetry(lastError, attempt, this.config.maxRetriesPerProvider)) break;
          const delay = retryDelayMs(attempt, this.config.retryBackoffBaseMs, this.config.retryBackoffMaxMs);
          if (lastError.retryAfterSeconds !== undefined) {
            await this.sleepFn(Math.max(delay, lastError.retryAfterSeconds * 1000));
          } else {
            await this.sleepFn(delay);
          }
          if (req.signal?.aborted) break;
        }
      }
      if (lastError?.kind === 'aborted') break;
    }
    return {
      ok: false,
      attempts,
      guidance: buildRouterV3FailureGuidance(attempts),
      totalLatencyMs: this.nowFn() - startedAt,
    };
  }
}
