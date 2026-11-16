/**
 * Policy router (v1.15, Doi T3) — routing theo cost / latency / quality.
 *
 * Quy tac:
 * - Task nho/nhanh (simple-chat, summarize, translate, prompt ngan)
 *   -> model 3–4B local (re, gan nhu mien phi).
 * - Code nang / reasoning / research, prompt dai, qualityNeed cao
 *   -> cloud (model manh).
 * - Scoring: cost + latency + quality co trong so, chuan hoa ve 0..1.
 * - Manual override: user chi dinh model -> luon ton trong (neu model
 *   ton tai va du kha nang), ghi ro manualOverride.
 * - Fallback: khi local fail (chua load / het RAM / loi), ha xuong
 *   model local nho hon, roi moi sang cloud; danh sach fallback co
 *   thu tu cu the, khong doan mo.
 * - Khong goi model that — chi tinh toan tren candidate do caller
 *   cung cap (registry + gia cloud cau hinh).
 */

import { findLocalModel, localModelsForUseCase, type LocalModelEntry } from '../../models/localCatalog';
import {
  DEFAULT_POLICY_CONFIG,
  type PolicyRouterConfig,
  type RouteCandidate,
  type RouteDecision,
  type RouterTask,
  type ScoredCandidate,
} from './types';

/** Gia cloud mac dinh (USD / 1k token) — cau hinh mau, host doi theo gia thuc. */
export const DEFAULT_CLOUD_PRICES: Record<string, { inputUsdPer1k: number; quality: number; estLatencyMs: number }> = {
  'grok-4.7': { inputUsdPer1k: 0.003, quality: 0.97, estLatencyMs: 900 },
  'claude-sonnet-4.5': { inputUsdPer1k: 0.003, quality: 0.96, estLatencyMs: 1100 },
  'gpt-5': { inputUsdPer1k: 0.005, quality: 0.97, estLatencyMs: 1000 },
  'gemini-2.5-flash': { inputUsdPer1k: 0.0003, quality: 0.85, estLatencyMs: 600 },
  'gemini-2.5-pro': { inputUsdPer1k: 0.00125, quality: 0.93, estLatencyMs: 1200 },
};

/** Cloud model mac dinh khi can fallback. */
export const DEFAULT_CLOUD_FALLBACK_MODEL = 'gemini-2.5-flash';

/** Map task kind -> use-case catalogue de chon model local. */
const KIND_TO_USE_CASE: Record<RouterTask['kind'], LocalModelEntry['useCases'][number]> = {
  'simple-chat': 'chat',
  code: 'code',
  reasoning: 'reasoning',
  research: 'reasoning',
  creative: 'chat',
  howto: 'chat',
  summarize: 'summarize',
  translate: 'translate',
};

/** Task nang can model manh: code/reasoning/research. */
export const HEAVY_KINDS: ReadonlySet<RouterTask['kind']> = new Set(['code', 'reasoning', 'research']);

/**
 * Phan loai muc do nang cua task (0..1) tu kind + prompt + yeu cau.
 * Dung de giai thich quyet dinh + chon nguong cloud.
 */
export function taskHeaviness(task: RouterTask, config: PolicyRouterConfig = DEFAULT_POLICY_CONFIG): number {
  let score = 0;
  if (HEAVY_KINDS.has(task.kind)) score += 0.45;
  if (task.needsToolUse) score += 0.15;
  if (task.needsLongContext) score += 0.15;
  if (task.promptTokens >= config.heavyPromptTokens) score += 0.2;
  else if (task.promptTokens >= config.heavyPromptTokens / 2) score += 0.1;
  score += task.qualityNeed * 0.25;
  return Math.min(1, score);
}

/** Quality uoc tinh cua model local theo qualityTier (1..5 -> 0.56..1.0). */
export function localQualityOf(entry: LocalModelEntry): number {
  return Math.min(1, 0.45 + entry.qualityTier * 0.11);
}

/** Latency uoc tinh den token dau tien cho model local. */
export function localLatencyMs(entry: LocalModelEntry, loaded: boolean, config: PolicyRouterConfig): number {
  const base = entry.estTokensPerSec ? Math.round(1000 / entry.estTokensPerSec) + 120 : 400;
  return loaded ? base : base + config.coldStartPenaltyMs;
}

/** Build candidate local tu catalogue + trang thai loaded. */
export function buildLocalCandidates(
  task: RouterTask,
  loadedModelIds: ReadonlySet<string>,
  availableRamBytes: number,
  config: PolicyRouterConfig = DEFAULT_POLICY_CONFIG,
): RouteCandidate[] {
  const useCase = KIND_TO_USE_CASE[task.kind];
  const pool = localModelsForUseCase(useCase);
  const out: RouteCandidate[] = [];
  for (const entry of pool) {
    const loaded = loadedModelIds.has(entry.id);
    if (task.needsToolUse && !entry.toolUse) {
      out.push({
        kind: 'local',
        modelId: entry.id,
        costPer1kTokensUsd: config.localCostPer1kTokensUsd,
        estLatencyMs: localLatencyMs(entry, loaded, config),
        quality: localQualityOf(entry),
        excludedReason: 'Model khong ho tro tool-use',
      });
      continue;
    }
    if (task.needsLongContext && entry.contextTokens < 32768) {
      out.push({
        kind: 'local',
        modelId: entry.id,
        costPer1kTokensUsd: config.localCostPer1kTokensUsd,
        estLatencyMs: localLatencyMs(entry, loaded, config),
        quality: localQualityOf(entry),
        excludedReason: `Context ${entry.contextTokens} token khong du cho long-context`,
      });
      continue;
    }
    if (!loaded && entry.ramRequiredBytes > availableRamBytes) {
      out.push({
        kind: 'local',
        modelId: entry.id,
        costPer1kTokensUsd: config.localCostPer1kTokensUsd,
        estLatencyMs: localLatencyMs(entry, loaded, config),
        quality: localQualityOf(entry),
        excludedReason: `Can ${Math.round(entry.ramRequiredBytes / 1e9)} GB RAM, chi con ${Math.round(availableRamBytes / 1e9)} GB`,
      });
      continue;
    }
    out.push({
      kind: 'local',
      modelId: entry.id,
      costPer1kTokensUsd: config.localCostPer1kTokensUsd,
      estLatencyMs: localLatencyMs(entry, loaded, config),
      quality: localQualityOf(entry),
    });
  }
  return out;
}

/** Build candidate cloud tu bang gia cau hinh. */
export function buildCloudCandidates(
  prices: Record<string, { inputUsdPer1k: number; quality: number; estLatencyMs: number }> = DEFAULT_CLOUD_PRICES,
): RouteCandidate[] {
  return Object.entries(prices).map(([modelId, p]) => ({
    kind: 'cloud' as const,
    modelId,
    costPer1kTokensUsd: p.inputUsdPer1k,
    estLatencyMs: p.estLatencyMs,
    quality: p.quality,
  }));
}

/** Chuan hoa + score mot candidate (cao hon = tot hon). */
export function scoreCandidate(
  candidate: RouteCandidate,
  weights: PolicyRouterConfig['weights'],
  ranges: { maxCost: number; maxLatency: number },
): ScoredCandidate {
  const costScore = ranges.maxCost > 0 ? 1 - candidate.costPer1kTokensUsd / ranges.maxCost : 1;
  const latencyScore = ranges.maxLatency > 0 ? 1 - candidate.estLatencyMs / ranges.maxLatency : 1;
  const qualityScore = candidate.quality;
  const score =
    weights.cost * clamp01(costScore) +
    weights.latency * clamp01(latencyScore) +
    weights.quality * clamp01(qualityScore);
  return {
    ...candidate,
    score,
    breakdown: { costScore: clamp01(costScore), latencyScore: clamp01(latencyScore), qualityScore: clamp01(qualityScore) },
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** PolicyRouter — quyet dinh route cho mot task. */
export class PolicyRouter {
  private readonly config: PolicyRouterConfig;
  private readonly cloudPrices: Record<string, { inputUsdPer1k: number; quality: number; estLatencyMs: number }>;

  constructor(
    config?: Partial<PolicyRouterConfig>,
    cloudPrices?: Record<string, { inputUsdPer1k: number; quality: number; estLatencyMs: number }>,
  ) {
    this.config = {
      ...DEFAULT_POLICY_CONFIG,
      ...config,
      weights: { ...DEFAULT_POLICY_CONFIG.weights, ...(config?.weights ?? {}) },
    };
    this.cloudPrices = cloudPrices ?? DEFAULT_CLOUD_PRICES;
  }

  getConfig(): PolicyRouterConfig {
    return { ...this.config, weights: { ...this.config.weights } };
  }

  /**
   * Route mot task.
   * @param task mo ta task.
   * @param env trang thai hien tai: model local nao dang loaded, RAM con lai.
   */
  decide(
    task: RouterTask,
    env: { loadedModelIds: ReadonlySet<string>; availableRamBytes: number },
  ): RouteDecision {
    const now = Date.now();
    const local = buildLocalCandidates(task, env.loadedModelIds, env.availableRamBytes, this.config);
    const cloud = buildCloudCandidates(this.cloudPrices);
    const all = [...local, ...cloud];
    const eligible = all.filter((c) => !c.excludedReason);

    // 1) Manual override — ton trong tuyet doi neu model ton tai + du kha nang.
    if (task.manualModelId) {
      const target = all.find((c) => c.modelId === task.manualModelId);
      if (target && !target.excludedReason) {
        // Override luon thang: score de giai thich, khong de sap xep lai.
        const ranges = {
          maxCost: Math.max(...eligible.map((c) => c.costPer1kTokensUsd), target.costPer1kTokensUsd),
          maxLatency: Math.max(...eligible.map((c) => c.estLatencyMs), target.estLatencyMs),
        };
        const chosen = scoreCandidate(target, this.config.weights, ranges);
        const fallbacks = this.scoreAll(eligible.filter((c) => c.modelId !== target.modelId)).slice(0, 3);
        return {
          chosen,
          fallbacks,
          reason: `Manual override: user chi dinh model "${task.manualModelId}".`,
          manualOverride: true,
          decidedAt: now,
        };
      }
      if (target?.excludedReason) {
        // Override vao model khong du kha nang: bao ro ly do, roi route binh thuong.
        const normal = this.decideNormal(task, local, cloud, now);
        return { ...normal, reason: `Override "${task.manualModelId}" khong kha thi (${target.excludedReason}) — ${normal.reason}` };
      }
      // Model khong phai ung vien cho task nay: co trong catalogue
      // nhung khong ho tro kind nay, hoac hoan toan khong ton tai.
      const normal = this.decideNormal(task, local, cloud, now);
      const inCatalogue = findLocalModel(task.manualModelId);
      const note = inCatalogue
        ? `Override "${task.manualModelId}" khong ho tro task "${task.kind}" (use-case: ${inCatalogue.useCases.join(', ')})`
        : `Override "${task.manualModelId}" khong co trong catalogue`;
      return { ...normal, reason: `${note} — ${normal.reason}` };
    }

    return this.decideNormal(task, local, cloud, now);
  }

  private decideNormal(
    task: RouterTask,
    local: RouteCandidate[],
    cloud: RouteCandidate[],
    now: number,
  ): RouteDecision {
    const eligible = [...local, ...cloud].filter((c) => !c.excludedReason);
    const heaviness = taskHeaviness(task, this.config);

    // Task nang + can chat luong cao: bat buoc cloud (bo qua local du re).
    if (task.qualityNeed >= this.config.cloudQualityThreshold || (heaviness >= 0.8 && task.promptTokens >= this.config.heavyPromptTokens)) {
      const cloudOnly = this.scoreAll(cloud.filter((c) => !c.excludedReason));
      if (cloudOnly.length > 0) {
        const localFallback = this.scoreAll(local.filter((c) => !c.excludedReason)).slice(0, 2);
        return {
          chosen: cloudOnly[0],
          fallbacks: [...cloudOnly.slice(1, 3), ...localFallback],
          reason: `Task nang (heaviness ${heaviness.toFixed(2)}, qualityNeed ${task.qualityNeed}) — can model cloud manh.`,
          manualOverride: false,
          decidedAt: now,
        };
      }
    }

    // Task nhe + co local du kha nang: uu tien local (task nho/nhanh
    // -> model 3-4B local). Cold start 3-10s chi tra 1 lan khi load,
    // sau do local re + rieng tu; scoring chi sap xep trong locals.
    // Khong ap dung khi user doi chat luong cao (da xu ly o tren).
    const lightLocal = local.filter((c) => !c.excludedReason);
    if (heaviness < 0.5 && task.qualityNeed < this.config.cloudQualityThreshold && lightLocal.length > 0) {
      const scoredLocal = this.scoreAll(lightLocal);
      const chosen = scoredLocal[0];
      const cloudFallback = this.scoreAll(cloud.filter((c) => !c.excludedReason)).slice(0, 1);
      return {
        chosen,
        fallbacks: [...scoredLocal.slice(1, 3), ...cloudFallback].slice(0, 3),
        reason: `Task nhe (heaviness ${heaviness.toFixed(2)}) — chay local "${chosen.modelId}" (re, rieng tu; cold start chi tra 1 lan).`,
        manualOverride: false,
        decidedAt: now,
      };
    }

    const scored = this.scoreAll(eligible);
    if (scored.length === 0) {
      // Khong ung vien nao du kha nang: fallback cung — cloud re nhat.
      const fallbackCloud = buildCloudCandidates(this.cloudPrices).sort(
        (a, b) => a.costPer1kTokensUsd - b.costPer1kTokensUsd,
      )[0] ?? {
        kind: 'cloud' as const,
        modelId: DEFAULT_CLOUD_FALLBACK_MODEL,
        costPer1kTokensUsd: 0.0003,
        estLatencyMs: 600,
        quality: 0.85,
      };
      const chosen: ScoredCandidate = {
        ...fallbackCloud,
        score: 0,
        breakdown: { costScore: 0, latencyScore: 0, qualityScore: fallbackCloud.quality },
      };
      return {
        chosen,
        fallbacks: [],
        reason: 'Khong co ung vien local/cloud nao du kha nang — fallback cung ve cloud re nhat, can kiem tra lai cau hinh.',
        manualOverride: false,
        decidedAt: now,
      };
    }

    // Fallback: local nho hon truoc, roi cloud — sap xep: cung kind voi
    // chosen truoc (local -> local nho hon), sau do kind khac.
    const chosen = scored[0];
    const rest = scored.slice(1);
    const sameKind = rest.filter((c) => c.kind === chosen.kind);
    const otherKind = rest.filter((c) => c.kind !== chosen.kind);
    const fallbacks = [...sameKind, ...otherKind].slice(0, 3);
    return {
      chosen,
      fallbacks,
      reason:
        chosen.kind === 'local'
          ? `Task ${task.kind} vua suc local — chon "${chosen.modelId}" (re, nhanh, quality ${chosen.quality.toFixed(2)}).`
          : `Task ${task.kind} can model manh — chon cloud "${chosen.modelId}" (quality ${chosen.quality.toFixed(2)}).`,
      manualOverride: false,
      decidedAt: now,
    };
  }

  /** Score + sap xep giam dan. */
  scoreAll(candidates: RouteCandidate[]): ScoredCandidate[] {
    if (candidates.length === 0) return [];
    const maxCost = Math.max(...candidates.map((c) => c.costPer1kTokensUsd));
    const maxLatency = Math.max(...candidates.map((c) => c.estLatencyMs));
    return candidates
      .map((c) => scoreCandidate(c, this.config.weights, { maxCost, maxLatency }))
      .sort((a, b) => b.score - a.score);
  }
}

/** Giai thich nhanh mot quyet dinh cho UI (1 dong). */
export function explainDecision(decision: RouteDecision): string {
  const c = decision.chosen;
  return `${c.kind === 'local' ? 'Local' : 'Cloud'} ${c.modelId} — score ${c.score.toFixed(2)} ` +
    `(cost ${c.breakdown.costScore.toFixed(2)}, latency ${c.breakdown.latencyScore.toFixed(2)}, ` +
    `quality ${c.breakdown.qualityScore.toFixed(2)}). ${decision.reason}` +
    (decision.fallbacks.length > 0 ? ` Fallback: ${decision.fallbacks.map((f) => f.modelId).join(', ')}.` : '');
}

/** Tim model local tot nhat cho mot use-case trong RAM cho phep. */
export function bestLocalModelFor(
  useCase: LocalModelEntry['useCases'][number],
  availableRamBytes: number,
): LocalModelEntry | undefined {
  const fitting = localModelsForUseCase(useCase)
    .filter((m) => m.ramRequiredBytes <= availableRamBytes)
    .sort((a, b) => b.qualityTier - a.qualityTier);
  return fitting[0];
}

export { findLocalModel };
