/**
 * Latency / cost / capability router v29 (v1.42, Doi T5).
 *
 * Chon model phu hop yeu cau tu catalog v29: loc cung theo capability
 * (voice realtime vs text), context, do tre, ngan sach — roi cham
 * diem theo profile (fastest / cheapest / balanced / quality).
 *
 * So lieu do tre tham chieu tu nghien cuu v1.42 (muc 4): cascaded
 * STT-LLM-TTS ~500-800ms, speech-to-speech ~300ms. Thuan logic,
 * khong goi model that, khong goi API live.
 */
import {
  estimateModelCostV29,
  filterCatalogV29,
  type ModelCatalogEntryV29,
  type RealtimeArchitectureV29,
} from './modelCatalogV29';

/** Do tre kien truc cascaded STT-LLM-TTS (ms) — nghien cuu v1.42. */
export const CASCADED_LATENCY_MS_MIN_V29 = 500;
export const CASCADED_LATENCY_MS_MAX_V29 = 800;
/** Do tre speech-to-speech (ms) — nghien cuu v1.42. */
export const SPEECH_TO_SPEECH_LATENCY_MS_V29 = 300;
/** Nguong full-duplex: duoi muc nay thi can noi + nghe dong thoi. */
export const FULL_DUPLEX_LATENCY_TARGET_MS_V29 = 350;
/** Nguong turn-based realtime: duoi muc nay thi khong dung cascaded. */
export const TURN_BASED_LATENCY_TARGET_MS_V29 = 800;

/** Profile cham diem routing. */
export type RoutingProfileV29 = 'fastest' | 'cheapest' | 'balanced' | 'quality';

/** Yeu cau routing. */
export interface RoutingRequestV29 {
  /** Can voice realtime (speech-to-speech) thay vi text. */
  needsRealtimeVoice?: boolean;
  /** Can full-duplex (noi + nghe dong thoi). */
  needsFullDuplex?: boolean;
  /** Can barge-in (chen ngang khi model dang noi). */
  needsBargeIn?: boolean;
  /** Can async function calling (khong chan audio). */
  needsAsyncFunctionCalling?: boolean;
  /** Can proactive audio (model tu noi truoc). */
  needsProactiveAudio?: boolean;
  /** Can goi tool/function. */
  needsToolCalling?: boolean;
  /** Can hieu anh. */
  needsVision?: boolean;
  /** Context toi thieu can thiet (token). */
  minContextTokens?: number;
  /** Chat luong toi thieu 0..1. */
  minQuality?: number;
  /** Do tre toi da chap nhan (ms). */
  maxLatencyMs?: number;
  /** Chi phi toi da cho mot luot (USD). */
  maxCostUsd?: number;
  /** Token input uoc tinh (mac dinh 1000). */
  estimatedInputTokens?: number;
  /** Token output uoc tinh (mac dinh 500). */
  estimatedOutputTokens?: number;
  /** So phut voice uoc tinh (mac dinh 0). */
  estimatedMinutes?: number;
  /** Profile cham diem (mac dinh 'balanced'). */
  profile?: RoutingProfileV29;
  /** Model id loai tru (vi du vua loi). */
  excludeModelIds?: string[];
  /** Provider loai tru. */
  excludeProviders?: string[];
  /** Uu tien model local mien phi khi ngang diem. */
  preferLocal?: boolean;
}

/** Diem thanh phan cua mot model ung vien. */
export interface RoutingScoreV29 {
  latencyScore: number;
  costScore: number;
  qualityScore: number;
  total: number;
  weights: { latency: number; cost: number; quality: number };
}

/** Mot model ung vien da xep hang. */
export interface RankedModelV29 {
  modelId: string;
  provider: string;
  architecture: RealtimeArchitectureV29;
  score: RoutingScoreV29;
  estimatedCostUsd: number;
  estimatedLatencyMs: number;
  quality: number;
}

/** Quyet dinh routing. */
export interface RoutingDecisionV29 {
  /** true = tim duoc model; false = khong model nao dat loc cung. */
  ok: boolean;
  chosenModelId: string | null;
  provider: string | null;
  architecture: RealtimeArchitectureV29 | null;
  profile: RoutingProfileV29;
  estimatedCostUsd: number;
  estimatedLatencyMs: number;
  quality: number;
  score: RoutingScoreV29 | null;
  /** Top ung vien (toi da 5, da sap xep). */
  ranked: RankedModelV29[];
  /** Model bi loai + ly do. */
  rejected: { modelId: string; reason: string }[];
  reasons: string[];
  warnings: string[];
}

/** Trong so cham diem theo profile (tong = 1). */
export function routingWeightsV29(profile: RoutingProfileV29): {
  latency: number;
  cost: number;
  quality: number;
} {
  switch (profile) {
    case 'fastest':
      return { latency: 0.5, cost: 0.2, quality: 0.3 };
    case 'cheapest':
      // Gia ap dao: local $0 phai thang model co phi du chat luong
      // cao hon chut — neu khong, chuan hoa chi phi theo max se lam
      // moi model re deu gan diem 1 va chat luong quyet dinh thay gia.
      return { latency: 0.1, cost: 0.7, quality: 0.2 };
    case 'quality':
      return { latency: 0.2, cost: 0.2, quality: 0.6 };
    case 'balanced':
    default:
      return { latency: 0.34, cost: 0.33, quality: 0.33 };
  }
}

/**
 * Loc cung: model phai dat moi yeu cau bat buoc, neu khong thi vao
 * `rejected` kem ly do (khong bi loai lang).
 */
export function filterEligibleModelsV29(
  catalog: ModelCatalogEntryV29[],
  request: RoutingRequestV29,
): { eligible: ModelCatalogEntryV29[]; rejected: { modelId: string; reason: string }[] } {
  const inputTokens = request.estimatedInputTokens ?? 1000;
  const outputTokens = request.estimatedOutputTokens ?? 500;
  const minutes = request.estimatedMinutes ?? 0;
  const eligible: ModelCatalogEntryV29[] = [];
  const rejected: { modelId: string; reason: string }[] = [];

  for (const model of filterCatalogV29(catalog, { excludeDeprecated: true })) {
    const reject = (reason: string): void => {
      rejected.push({ modelId: model.modelId, reason });
    };
    if (request.excludeModelIds?.includes(model.modelId)) {
      reject('nam trong danh sach loai tru (excludeModelIds).');
      continue;
    }
    if (request.excludeProviders?.includes(model.provider)) {
      reject(`provider ${model.provider} nam trong danh sach loai tru.`);
      continue;
    }
    if (request.needsRealtimeVoice && !model.capabilities.realtimeVoice) {
      reject('khong ho tro voice realtime (can speech-to-speech).');
      continue;
    }
    if (request.needsFullDuplex && !model.capabilities.fullDuplex) {
      reject('khong ho tro full-duplex.');
      continue;
    }
    if (request.needsBargeIn && !model.capabilities.bargeIn) {
      reject('khong ho tro barge-in.');
      continue;
    }
    if (request.needsAsyncFunctionCalling && !model.capabilities.asyncFunctionCalling) {
      reject('khong ho tro async function calling.');
      continue;
    }
    if (request.needsProactiveAudio && !model.capabilities.proactiveAudio) {
      reject('khong ho tro proactive audio.');
      continue;
    }
    if (request.needsToolCalling && !model.capabilities.toolCalling) {
      reject('khong ho tro tool calling.');
      continue;
    }
    if (request.needsVision && !model.capabilities.vision) {
      reject('khong ho tro vision.');
      continue;
    }
    if (request.minContextTokens !== undefined && model.contextTokens < request.minContextTokens) {
      reject(`context ${model.contextTokens} < yeu cau ${request.minContextTokens}.`);
      continue;
    }
    if (request.minQuality !== undefined && model.quality < request.minQuality) {
      reject(`quality ${model.quality} < yeu cau ${request.minQuality}.`);
      continue;
    }
    if (request.maxLatencyMs !== undefined && model.typicalLatencyMs > request.maxLatencyMs) {
      reject(`do tre ${model.typicalLatencyMs}ms > gioi han ${request.maxLatencyMs}ms.`);
      continue;
    }
    if (request.maxCostUsd !== undefined) {
      const cost = estimateModelCostV29(model, { inputTokens, outputTokens, minutes });
      if (cost.totalUsd > request.maxCostUsd) {
        reject(`chi phi uoc tinh $${cost.totalUsd.toFixed(4)} > gioi han $${request.maxCostUsd}.`);
        continue;
      }
    }
    eligible.push(model);
  }
  return { eligible, rejected };
}

/** Cham diem mot model (0..1 moi thanh phan; tong co trong so). */
export function scoreModelV29(
  model: ModelCatalogEntryV29,
  request: RoutingRequestV29,
  bounds: { maxLatencyMs: number; maxCostUsd: number; minPositiveCostUsd?: number },
): RoutingScoreV29 {
  const profile = request.profile ?? 'balanced';
  const weights = routingWeightsV29(profile);
  const inputTokens = request.estimatedInputTokens ?? 1000;
  const outputTokens = request.estimatedOutputTokens ?? 500;
  const minutes = request.estimatedMinutes ?? 0;
  const cost = estimateModelCostV29(model, { inputTokens, outputTokens, minutes });

  // Latency: 1 khi = 0ms, 0 khi >= max trong catalog (tuyen tinh).
  const latencyScore = bounds.maxLatencyMs > 0
    ? Math.max(0, Math.min(1, 1 - model.typicalLatencyMs / (bounds.maxLatencyMs * 1.2)))
    : 1;
  // Cost: mien phi = 1; model co phi duoc cham theo ti le voi model
  // co phi re nhat (1 / (1 + cost/minPositive)) — chu khong chia
  // cho max: chia cho max lam moi model re deu gan 1 diem va chat
  // luong se quyet dinh thay gia (loi that o v29 ban dau: profile
  // cheapest chon model co phi thay vi local $0).
  const minPositive = bounds.minPositiveCostUsd ?? 0;
  const costScore = cost.totalUsd <= 0
    ? 1
    : minPositive > 0
      ? 1 / (1 + cost.totalUsd / minPositive)
      : 0;
  const qualityScore = Math.max(0, Math.min(1, model.quality));
  const total =
    weights.latency * latencyScore + weights.cost * costScore + weights.quality * qualityScore;
  return { latencyScore, costScore, qualityScore, total, weights };
}

/** So sanh xep hang: diem tong -> do tre -> chat luong -> ten (on dinh). */
function compareRankedV29(a: RankedModelV29, b: RankedModelV29, preferLocal: boolean): number {
  if (b.score.total !== a.score.total) return b.score.total - a.score.total;
  const aLocal = a.provider === 'ollama';
  const bLocal = b.provider === 'ollama';
  if (preferLocal && aLocal !== bLocal) return aLocal ? -1 : 1;
  if (a.estimatedLatencyMs !== b.estimatedLatencyMs) return a.estimatedLatencyMs - b.estimatedLatencyMs;
  if (b.quality !== a.quality) return b.quality - a.quality;
  return a.modelId.localeCompare(b.modelId);
}

/**
 * Route: loc cung -> cham diem -> xep hang -> chon model dau.
 * Tra `ok: false` + rejected day du khi khong model nao dat.
 */
export function routeModelV29(
  catalog: ModelCatalogEntryV29[],
  request: RoutingRequestV29,
): RoutingDecisionV29 {
  const profile = request.profile ?? 'balanced';
  const { eligible, rejected } = filterEligibleModelsV29(catalog, request);
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (request.needsRealtimeVoice) reasons.push('Yeu cau voice realtime -> chi xet model realtime/live.');
  if (request.needsFullDuplex) reasons.push('Yeu cau full-duplex.');
  if (request.needsBargeIn) reasons.push('Yeu cau barge-in.');
  if (request.profile === 'cheapest') reasons.push('Profile cheapest: uu tien gia thap nhat.');
  if (request.profile === 'fastest') reasons.push('Profile fastest: uu tien do tre thap nhat.');
  if (request.profile === 'quality') reasons.push('Profile quality: uu tien chat luong cao nhat.');
  if (request.maxCostUsd !== undefined) reasons.push(`Gioi han chi phi $${request.maxCostUsd}/luot.`);
  if (request.maxLatencyMs !== undefined) reasons.push(`Gioi han do tre ${request.maxLatencyMs}ms.`);

  if (eligible.length === 0) {
    return {
      ok: false,
      chosenModelId: null,
      provider: null,
      architecture: null,
      profile,
      estimatedCostUsd: 0,
      estimatedLatencyMs: 0,
      quality: 0,
      score: null,
      ranked: [],
      rejected,
      reasons: [...reasons, 'Khong co model nao dat tat ca yeu cau bat buoc.'],
      warnings,
    };
  }

  const maxLatencyMs = Math.max(...eligible.map((m) => m.typicalLatencyMs));
  const costs = eligible.map(
    (m) =>
      estimateModelCostV29(m, {
        inputTokens: request.estimatedInputTokens ?? 1000,
        outputTokens: request.estimatedOutputTokens ?? 500,
        minutes: request.estimatedMinutes ?? 0,
      }).totalUsd,
  );
  const maxCostUsd = Math.max(...costs);
  const positiveCosts = costs.filter((c) => c > 0);
  const minPositiveCostUsd = positiveCosts.length > 0 ? Math.min(...positiveCosts) : 0;
  const ranked: RankedModelV29[] = eligible.map((model) => {
    const cost = estimateModelCostV29(model, {
      inputTokens: request.estimatedInputTokens ?? 1000,
      outputTokens: request.estimatedOutputTokens ?? 500,
      minutes: request.estimatedMinutes ?? 0,
    });
    return {
      modelId: model.modelId,
      provider: model.provider,
      architecture: model.architecture,
      score: scoreModelV29(model, request, { maxLatencyMs, maxCostUsd, minPositiveCostUsd }),
      estimatedCostUsd: cost.totalUsd,
      estimatedLatencyMs: model.typicalLatencyMs,
      quality: model.quality,
    };
  });
  ranked.sort((a, b) => compareRankedV29(a, b, request.preferLocal ?? false));

  const chosen = ranked[0];
  if (chosen.estimatedCostUsd === 0) reasons.push(`Chon ${chosen.modelId} (mien phi, local).`);
  else reasons.push(`Chon ${chosen.modelId} — diem ${chosen.score.total.toFixed(3)}, uoc tinh $${chosen.estimatedCostUsd.toFixed(4)}.`);
  if (ranked.length > 1) {
    const second = ranked[1];
    if (second.score.total - chosen.score.total > -0.05) {
      warnings.push(`Lựa chọn thay thế gần điểm: ${second.modelId} (${second.score.total.toFixed(3)}).`);
    }
  }
  if (chosen.architecture === 'cascaded' && request.needsRealtimeVoice) {
    warnings.push('Model duoc chon dung kien truc cascaded — do tre ky vong 500-800ms, khong phai speech-to-speech ~300ms.');
  }

  return {
    ok: true,
    chosenModelId: chosen.modelId,
    provider: chosen.provider,
    architecture: chosen.architecture,
    profile,
    estimatedCostUsd: chosen.estimatedCostUsd,
    estimatedLatencyMs: chosen.estimatedLatencyMs,
    quality: chosen.quality,
    score: chosen.score,
    ranked: ranked.slice(0, 5),
    rejected,
    reasons,
    warnings,
  };
}

/** Yeu cau goi y kien truc voice. */
export interface VoiceArchitectureRequestV29 {
  /** Do tre muc tieu (ms). Mac dinh 800. */
  targetLatencyMs?: number;
  /** Can chen ngang / noi chong. */
  needsBargeIn?: boolean;
  /** Can noi + nghe dong thoi. */
  needsFullDuplex?: boolean;
  /** Can model tu noi truoc. */
  needsProactiveAudio?: boolean;
  /** Chi co model text + STT/TTS roi (khong co model realtime). */
  textOnlyAvailable?: boolean;
}

/** Ket qua goi y kien truc voice. */
export interface VoiceArchitectureRecommendationV29 {
  architecture: RealtimeArchitectureV29;
  /** Khoang do tre ky vong (ms). */
  expectedLatencyMs: { min: number; max: number };
  reasons: string[];
  /** Model realtime goi y (neu co trong catalog). */
  suggestedModels: string[];
}

/**
 * Goi y kien truc voice theo muc tieu do tre + tinh nang can thiet.
 * - full-duplex khi can barge-in / noi chong, hoac muc tieu <= 350ms.
 * - turn-based realtime khi muc tieu <= 800ms.
 * - cascaded khi chi co model text, hoac muc tieu rong rai > 800ms
 *   va khong can barge-in (STT-LLM-TTS ~500-800ms).
 */
export function recommendVoiceArchitectureV29(
  request: VoiceArchitectureRequestV29,
  catalog: ModelCatalogEntryV29[] = [],
): VoiceArchitectureRecommendationV29 {
  const target = request.targetLatencyMs ?? TURN_BASED_LATENCY_TARGET_MS_V29;
  const reasons: string[] = [];
  let architecture: RealtimeArchitectureV29;
  let expectedLatencyMs: { min: number; max: number };

  if (request.textOnlyAvailable) {
    architecture = 'cascaded';
    expectedLatencyMs = { min: CASCADED_LATENCY_MS_MIN_V29, max: CASCADED_LATENCY_MS_MAX_V29 };
    reasons.push('Chi co model text + STT/TTS — dung kien truc cascaded (~500-800ms).');
  } else if (request.needsBargeIn || request.needsFullDuplex || target <= FULL_DUPLEX_LATENCY_TARGET_MS_V29) {
    architecture = 'full-duplex';
    expectedLatencyMs = { min: 200, max: SPEECH_TO_SPEECH_LATENCY_MS_V29 + 100 };
    if (request.needsBargeIn) reasons.push('Can barge-in -> phai full-duplex.');
    if (request.needsFullDuplex) reasons.push('Can noi + nghe dong thoi -> full-duplex.');
    if (target <= FULL_DUPLEX_LATENCY_TARGET_MS_V29) {
      reasons.push(`Muc tieu do tre ${target}ms <= ${FULL_DUPLEX_LATENCY_TARGET_MS_V29}ms -> full-duplex (speech-to-speech ~${SPEECH_TO_SPEECH_LATENCY_MS_V29}ms).`);
    }
  } else if (target <= TURN_BASED_LATENCY_TARGET_MS_V29) {
    architecture = 'turn-based-realtime';
    expectedLatencyMs = { min: SPEECH_TO_SPEECH_LATENCY_MS_V29, max: TURN_BASED_LATENCY_TARGET_MS_V29 };
    reasons.push(`Muc tieu do tre ${target}ms <= ${TURN_BASED_LATENCY_TARGET_MS_V29}ms -> turn-based realtime.`);
  } else {
    architecture = 'cascaded';
    expectedLatencyMs = { min: CASCADED_LATENCY_MS_MIN_V29, max: CASCADED_LATENCY_MS_MAX_V29 };
    reasons.push(`Muc tieu do tre ${target}ms rong rai, khong can barge-in -> cascaded du dung (~500-800ms).`);
  }
  if (request.needsProactiveAudio && architecture !== 'cascaded') {
    reasons.push('Proactive audio: chon model live co proactiveAudio (vd Gemini 3.8 Live, GPT-Live).');
  }

  const suggestedModels = catalog
    .filter((m) => !m.deprecated && (m.kind === 'realtime' || m.kind === 'live') && m.architecture === architecture)
    .sort((a, b) => a.typicalLatencyMs - b.typicalLatencyMs)
    .slice(0, 3)
    .map((m) => m.modelId);

  return { architecture, expectedLatencyMs, reasons, suggestedModels };
}

/** Giai thich quyet dinh routing thanh cac dong doc duoc (cho tool/UI). */
export function explainRoutingDecisionV29(decision: RoutingDecisionV29): string[] {
  const lines: string[] = [];
  if (!decision.ok) {
    lines.push('Khong chon duoc model: khong co model nao dat yeu cau.');
    for (const r of decision.rejected.slice(0, 10)) lines.push(`- ${r.modelId}: ${r.reason}`);
    if (decision.rejected.length > 10) lines.push(`... va ${decision.rejected.length - 10} model khac.`);
    return lines;
  }
  lines.push(`Chon ${decision.chosenModelId} (${decision.provider}, ${decision.architecture}).`);
  lines.push(`Profile: ${decision.profile}; diem ${decision.score?.total.toFixed(3) ?? '?'} ` +
    `(latency ${decision.score?.latencyScore.toFixed(2) ?? '?'}, ` +
    `cost ${decision.score?.costScore.toFixed(2) ?? '?'}, ` +
    `quality ${decision.score?.qualityScore.toFixed(2) ?? '?'})`);
  lines.push(`Uoc tinh: $${decision.estimatedCostUsd.toFixed(4)}/luot, ~${decision.estimatedLatencyMs}ms, quality ${decision.quality}.`);
  for (const r of decision.reasons) lines.push(`- ${r}`);
  for (const w of decision.warnings) lines.push(`! ${w}`);
  if (decision.ranked.length > 1) {
    lines.push('Lua chon thay the: ' + decision.ranked.slice(1, 4).map((r) => r.modelId).join(', ') + '.');
  }
  return lines;
}
