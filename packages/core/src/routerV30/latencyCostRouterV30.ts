/**
 * Latency / cost router v30 (v1.44, Doi T5) — chon model theo do tre
 * DO DUOC + chi phi uoc tinh + chat luong, theo cau hinh uu tien cua user.
 *
 * Khac v29 (chi dung so khai bao): v30 dung `LatencyStatsStoreV30` —
 * do tre that do duoc (EWMA) duoc uu tien hon `estimatedLatencyMs`;
 * khi chua co mau thi fallback ve so khai bao (ghi ro `measured: false`
 * trong giai thich). Diem tong = trong so hoa cua 3 diem chuan hoa
 * (latency / cost / quality) theo policy cua user.
 *
 * Loc cung (hard filter) truoc khi cham diem: capability yeu cau,
 * context, tran gia/do tre, allowlist/blocklist, deprecated.
 * Thuan logic, khong goi model that, khong goi API live.
 */
import {
  entryKeyV30,
  estimateModelCostV30,
  type ModelCatalogEntryV30,
  type ModelCatalogV30,
} from './modelCatalogV30';
import {
  type LatencyStatsStoreV30,
} from './latencyStatsV30';
import {
  defaultRoutingPolicyV30,
  effectiveWeightsV30,
  type RoutingPolicyV30,
} from './routingPolicyV30';

/** Yeu cau routing. */
export interface RoutingRequestV30 {
  /** Can voice realtime (speech-to-speech) thay vi text. */
  needsRealtimeVoice?: boolean;
  /** Can tool/function calling. */
  needsToolCalling?: boolean;
  /** Can hieu anh. */
  needsVision?: boolean;
  /** Can ly luan sau. */
  needsReasoning?: boolean;
  /** Can tra JSON co cau truc. */
  needsJsonMode?: boolean;
  /** Can embedding (khong phai text gen). */
  needsEmbedding?: boolean;
  /** So token input du kien (de uoc tinh chi phi). */
  inputTokens?: number;
  /** So token output du kien (de uoc tinh chi phi). */
  outputTokens?: number;
  /** Context toi thieu can (token). */
  minContextTokens?: number;
  /** Do tre toi da chap nhan cho lan goi nay (ms) — uu tien hon policy. */
  maxLatencyMs?: number;
  /** Chi phi toi da chap nhan cho lan goi nay (USD) — uu tien hon policy. */
  maxCostUsd?: number;
  /** Provider bat buoc (neu co). */
  forceProvider?: string;
  /** Model bat buoc (dang provider::modelId; neu co, bo qua cham diem). */
  forceModel?: string;
}

/** Mot ung vien da cham diem. */
export interface ScoredCandidateV30 {
  entry: ModelCatalogEntryV30;
  /** Diem tong 0..1. */
  score: number;
  /** Diem latency 0..1. */
  latencyScore: number;
  /** Diem chi phi 0..1. */
  costScore: number;
  /** Diem chat luong 0..1 (= qualityScore khai bao). */
  qualityScore: number;
  /** Do tre hieu dung (ms) — do that neu co, khong thi khai bao. */
  effectiveLatencyMs: number;
  /** Do tre nay co phai do that khong. */
  latencyMeasured: boolean;
  /** So mau do tre that (0 neu chua co). */
  latencySamples: number;
  /** Chi phi uoc tinh (USD) cho input/output du kien. */
  estimatedCostUsd: number;
  /** Ly do chon / ghi chu (de giai thich). */
  reasons: string[];
}

/** Ket qua routing. */
export interface RoutingDecisionV30 {
  /** Co chon duoc model khong. */
  ok: boolean;
  /** Model duoc chon (neu ok). */
  chosen?: ScoredCandidateV30;
  /** Top ung vien (toi da 5) de UI hien thi lua chon thay the. */
  candidates: ScoredCandidateV30[];
  /** Cac model bi loai + ly do (de debug / giai thich). */
  rejected: Array<{ key: string; reason: string }>;
  /** Policy + request da dung (de log lai quyet dinh). */
  policySummary: string;
  /** Luc quyet dinh (epoch ms). */
  decidedAt: number;
}

/** Tran mac dinh khi user khong dat tran: 30s latency, $1/call. */
export const DEFAULT_MAX_LATENCY_MS_V30 = 30_000;
export const DEFAULT_MAX_COST_USD_V30 = 1;
/** Bonus diem khi model local duoc uu tien (preferLocal). */
export const PREFER_LOCAL_BONUS_V30 = 0.05;

/** Kiem tra 1 entry co dap ung loc cung cua request + policy khong. */
export function filterCandidateV30(
  entry: ModelCatalogEntryV30,
  request: RoutingRequestV30,
  policy: RoutingPolicyV30,
  effectiveLatencyMs: number,
  estimatedCostUsd: number,
): string | null {
  // forceModel / forceProvider vuot qua moi loc khac (chi kiem tra ton tai).
  if (request.forceModel && entryKeyV30(entry) !== request.forceModel) {
    return 'not the forced model';
  }
  if (request.forceProvider && entry.provider !== request.forceProvider) {
    return 'not the forced provider';
  }
  if (policy.blockedModels.includes(entryKeyV30(entry))) {
    return 'model is blocked by policy';
  }
  if (
    policy.allowedModels.length > 0 &&
    !policy.allowedModels.includes(entryKeyV30(entry))
  ) {
    return 'model not in allowedModels';
  }
  if (
    policy.allowedProviders.length > 0 &&
    !policy.allowedProviders.includes(entry.provider)
  ) {
    return 'provider not in allowedProviders';
  }
  if (entry.deprecated && !policy.allowDeprecated) {
    return 'model is deprecated';
  }
  if (request.needsRealtimeVoice && !entry.capabilities.realtimeVoice) {
    return 'no realtime voice';
  }
  if (request.needsToolCalling && !entry.capabilities.toolCalling) {
    return 'no tool calling';
  }
  if (request.needsVision && !entry.capabilities.vision) {
    return 'no vision';
  }
  if (request.needsReasoning && !entry.capabilities.reasoning) {
    return 'no reasoning';
  }
  if (request.needsJsonMode && !entry.capabilities.jsonMode) {
    return 'no JSON mode';
  }
  if (request.needsEmbedding && entry.kind !== 'embedding') {
    return 'not an embedding model';
  }
  if (!request.needsEmbedding && entry.kind === 'embedding') {
    return 'embedding model cannot generate text';
  }
  const minContext = request.minContextTokens ?? 0;
  if (entry.contextTokens < minContext) {
    return `context ${entry.contextTokens} < required ${minContext}`;
  }
  const maxLatency = request.maxLatencyMs ?? policy.maxLatencyMs ?? 0;
  if (maxLatency > 0 && effectiveLatencyMs > maxLatency) {
    return `latency ${Math.round(effectiveLatencyMs)}ms > max ${maxLatency}ms`;
  }
  const maxCost = request.maxCostUsd ?? policy.maxCostPerRequestUsd ?? 0;
  if (maxCost > 0 && estimatedCostUsd > maxCost) {
    return `cost $${estimatedCostUsd.toFixed(4)} > max $${maxCost}`;
  }
  return null;
}

/**
 * Chon model tot nhat tu catalog.
 *
 * - `stats` co the null (chua co so do that) — khi do dung so khai bao.
 * - `forceModel` (neu co): chi can entry ton tai + khong bi block thi
 *   chon thang, khong cham diem (user da quyet).
 * - Diem latency/cost chuan hoa MIN-MAX theo cac ung vien dat loc cung
 *   (khong cham theo cap tuyet doi: cap $1/30s lam moi model deu ~1.0
 *   va quality lat at — "cheapest"/"fastest" khong phan biet duoc).
 *   Latency thap nhat -> 1, cao nhat -> 0; tuong tu chi phi. Chi co
 *   1 ung vien thi ca 2 diem = 1.
 * - Tra top 5 ung vien + danh sach bi loai de UI giai thich duoc.
 */
export function routeModelV30(
  catalog: ModelCatalogV30,
  request: RoutingRequestV30 = {},
  policy: RoutingPolicyV30 = defaultRoutingPolicyV30(),
  stats: LatencyStatsStoreV30 | null = null,
  now = Date.now(),
): RoutingDecisionV30 {
  const weights = effectiveWeightsV30(policy);
  const weightTotal = weights.latency + weights.cost + weights.quality || 1;
  const inputTokens = request.inputTokens ?? 1000;
  const outputTokens = request.outputTokens ?? 500;

  const rejected: Array<{ key: string; reason: string }> = [];
  // Vong 1: loc cung + thu thap so lieu tho (de chuan hoa min-max).
  const fitting: Array<{
    entry: ModelCatalogEntryV30;
    effMs: number;
    measured: boolean;
    samples: number;
    cost: number;
  }> = [];

  for (const entry of catalog.entries) {
    const eff = stats
      ? stats.effectiveLatencyMs(entry)
      : {
          ms: entry.estimatedLatencyMs,
          measured: false,
          samples: 0,
        };
    const cost = estimateModelCostV30(entry, inputTokens, outputTokens);
    const reason = filterCandidateV30(
      entry,
      request,
      policy,
      eff.ms,
      cost,
    );
    if (reason) {
      rejected.push({ key: entryKeyV30(entry), reason });
      continue;
    }
    fitting.push({
      entry,
      effMs: eff.ms,
      measured: eff.measured,
      samples: eff.samples,
      cost,
    });
  }

  const minLat = fitting.length > 0 ? Math.min(...fitting.map((f) => f.effMs)) : 0;
  const maxLat = fitting.length > 0 ? Math.max(...fitting.map((f) => f.effMs)) : 0;
  const minCost = fitting.length > 0 ? Math.min(...fitting.map((f) => f.cost)) : 0;
  const maxCost = fitting.length > 0 ? Math.max(...fitting.map((f) => f.cost)) : 0;
  const rangeScore = (value: number, min: number, max: number): number => {
    if (max <= min) return 1;
    return 1 - (value - min) / (max - min);
  };

  // Vong 2: cham diem.
  const scored: ScoredCandidateV30[] = fitting.map((f) => {
    const { entry } = f;
    const latScore = rangeScore(f.effMs, minLat, maxLat);
    const cScore = rangeScore(f.cost, minCost, maxCost);
    const qScore = entry.qualityScore;
    let total =
      (weights.latency * latScore +
        weights.cost * cScore +
        weights.quality * qScore) /
      weightTotal;
    const reasons: string[] = [];
    if (f.measured) {
      reasons.push(
        `measured latency ${Math.round(f.effMs)}ms (${f.samples} samples)`,
      );
    } else {
      reasons.push(`estimated latency ${Math.round(f.effMs)}ms (no measurements yet)`);
    }
    reasons.push(`estimated cost $${f.cost.toFixed(4)}`);
    reasons.push(`quality ${qScore}`);
    const isFree =
      entry.inputPricePerMillionUsd === 0 &&
      entry.outputPricePerMillionUsd === 0;
    if (policy.preferLocal && isFree) {
      total = Math.min(1, total + PREFER_LOCAL_BONUS_V30);
      reasons.push('preferred: free/local model');
    }
    if (request.forceModel === entryKeyV30(entry)) {
      total = 1;
      reasons.push('forced by user');
    }
    return {
      entry,
      score: total,
      latencyScore: latScore,
      costScore: cScore,
      qualityScore: qScore,
      effectiveLatencyMs: f.effMs,
      latencyMeasured: f.measured,
      latencySamples: f.samples,
      estimatedCostUsd: f.cost,
      reasons,
    };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.effectiveLatencyMs - b.effectiveLatencyMs ||
      a.estimatedCostUsd - b.estimatedCostUsd,
  );
  const candidates = scored.slice(0, 5);
  const chosen = candidates[0];
  return {
    ok: Boolean(chosen),
    chosen,
    candidates,
    rejected,
    policySummary: `profile=${policy.profile} lat=${weights.latency} cost=${weights.cost} q=${weights.quality}`,
    decidedAt: now,
  };
}

/** Giai thich quyet dinh routing bang cau doc duoc (de UI/log hien thi). */
export function explainRoutingDecisionV30(
  decision: RoutingDecisionV30,
): string {
  if (!decision.ok || !decision.chosen) {
    const sample = decision.rejected.slice(0, 3).map(
      (r) => `${r.key} (${r.reason})`,
    );
    return `No model fits the requirements. ${decision.rejected.length} rejected${sample.length > 0 ? `: ${sample.join('; ')}` : '.'}`;
  }
  const c = decision.chosen;
  const lines = [
    `Chosen ${c.entry.provider}::${c.entry.modelId} (score ${c.score.toFixed(2)}) — ${c.reasons.join('; ')}.`,
    `Latency ${Math.round(c.effectiveLatencyMs)}ms (${c.latencyMeasured ? 'measured' : 'estimated'}), cost $${c.estimatedCostUsd.toFixed(4)}, quality ${c.qualityScore}.`,
  ];
  if (decision.candidates.length > 1) {
    const alts = decision.candidates
      .slice(1, 3)
      .map((a) => `${a.entry.provider}::${a.entry.modelId} (${a.score.toFixed(2)})`)
      .join(', ');
    lines.push(`Alternatives: ${alts}.`);
  }
  lines.push(`Policy: ${decision.policySummary}.`);
  return lines.join(' ');
}

/** Goi y model re nhat dap ung yeu cau (tien cho UI "tiet kiem chi phi"). */
export function cheapestFittingModelV30(
  catalog: ModelCatalogV30,
  request: RoutingRequestV30 = {},
  policy: RoutingPolicyV30 = defaultRoutingPolicyV30(),
  stats: LatencyStatsStoreV30 | null = null,
): ScoredCandidateV30 | undefined {
  const cheap = { ...policy, profile: 'cheapest' as const, customWeights: undefined };
  const decision = routeModelV30(catalog, request, cheap, stats);
  return decision.chosen;
}

/** Goi y model nhanh nhat dap ung yeu cau (tien cho UI "nhanh nhat"). */
export function fastestFittingModelV30(
  catalog: ModelCatalogV30,
  request: RoutingRequestV30 = {},
  policy: RoutingPolicyV30 = defaultRoutingPolicyV30(),
  stats: LatencyStatsStoreV30 | null = null,
): ScoredCandidateV30 | undefined {
  const fast = { ...policy, profile: 'fastest' as const, customWeights: undefined };
  const decision = routeModelV30(catalog, request, fast, stats);
  return decision.chosen;
}
