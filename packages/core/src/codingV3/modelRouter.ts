/**
 * Router model local cho coding agent v3 (v1.10, Đội T4).
 *
 * Chọn model theo task/cost/latency — KHÔNG gọi API nào: chỉ chấm
 * điểm trên bảng model tĩnh (local-first) rồi trả quyết định + lý do.
 * Host (agent loop) dùng quyết định này để gọi provider thật; khi
 * model chính lỗi, host gọi `recordFailure` rồi `pickModel` lại để
 * lấy fallback tiếp theo trong chuỗi.
 *
 * Bảng model: model local (Ollama — miễn phí, chậm hơn, riêng tư)
 * đứng trước model cloud (có phí theo token). Số liệu cost/latency
 * là ước lượng cấu hình (không phải giá live) — host có thể override
 * bằng `overrideCatalog`.
 *
 * Scoring (tổng 100, trên các model còn lại sau khi loại):
 *   - khớp loại task (strengths):      tối đa 40
 *   - vừa độ khó (không quá yếu, không quá mạnh): tối đa 20
 *   - chi phí trong ngân sách:         tối đa 20
 *   - độ trễ trong ngân sách:          tối đa 10
 *   - ưu tiên local (riêng tư, $0):   tối đa 10
 * Ngân sách cost/latency là RÀNG BUỘC CỨNG: model vi phạm bị loại
 * hẳn trước khi chấm điểm (ghi trong excludedByConstraint), không
 * chỉ bị trừ điểm — nếu không model miễn phí nhưng chậm vẫn có thể
 * thắng nhờ điểm cost/local bù lại điểm latency.
 * Model bị lỗi gần đây (failure log, TTL 10 phút) bị loại khỏi lượt
 * chọn hiện tại và được ghi rõ trong lý do.
 */

export type CodingV3TaskType =
  | 'codegen'
  | 'refactor'
  | 'review'
  | 'explore'
  | 'plan'
  | 'fix'
  | 'test'
  | 'chat';

export type CodingV3ModelKind = 'local' | 'cloud';

export interface CodingV3ModelEntry {
  id: string;
  provider: string;
  kind: CodingV3ModelKind;
  /** Context window (token). */
  contextTokens: number;
  /** USD / 1M token input (0 = local miễn phí). */
  costPer1MInputUsd: number;
  /** USD / 1M token output. */
  costPer1MOutputUsd: number;
  /** Độ trễ p50 ước lượng (ms) cho một lượt gọi codegen vừa. */
  latencyMsP50: number;
  /** Loại task model này mạnh. */
  strengths: CodingV3TaskType[];
  /** Độ khó tối đa model xử lý tốt (1-5). */
  maxDifficulty: number;
  /** Ghi chú ngắn (vd "chạy local qua Ollama"). */
  note: string;
}

/**
 * Bảng model mặc định (local-first). Thứ tự trong bảng KHÔNG phải
 * thứ tự ưu tiên — ưu tiên do scoring quyết định theo từng task.
 */
export const CODING_V3_DEFAULT_CATALOG: CodingV3ModelEntry[] = [
  {
    id: 'ollama/qwen2.5-coder:7b',
    provider: 'ollama',
    kind: 'local',
    contextTokens: 32_768,
    costPer1MInputUsd: 0,
    costPer1MOutputUsd: 0,
    latencyMsP50: 2500,
    strengths: ['codegen', 'fix', 'explore', 'test'],
    maxDifficulty: 3,
    note: 'Local qua Ollama, miễn phí, riêng tư.',
  },
  {
    id: 'ollama/qwen2.5-coder:32b',
    provider: 'ollama',
    kind: 'local',
    contextTokens: 32_768,
    costPer1MInputUsd: 0,
    costPer1MOutputUsd: 0,
    latencyMsP50: 6000,
    strengths: ['codegen', 'refactor', 'fix', 'plan', 'test'],
    maxDifficulty: 4,
    note: 'Local qua Ollama, miễn phí, mạnh hơn bản 7b.',
  },
  {
    id: 'ollama/deepseek-coder-v2:16b',
    provider: 'ollama',
    kind: 'local',
    contextTokens: 32_768,
    costPer1MInputUsd: 0,
    costPer1MOutputUsd: 0,
    latencyMsP50: 4500,
    strengths: ['codegen', 'fix', 'review'],
    maxDifficulty: 3,
    note: 'Local qua Ollama, miễn phí.',
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'gemini',
    kind: 'cloud',
    contextTokens: 1_048_576,
    costPer1MInputUsd: 0.3,
    costPer1MOutputUsd: 2.5,
    latencyMsP50: 1200,
    strengths: ['explore', 'chat', 'plan', 'test', 'review'],
    maxDifficulty: 3,
    note: 'Cloud, rẻ, nhanh, context rất lớn.',
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    kind: 'cloud',
    contextTokens: 1_048_576,
    costPer1MInputUsd: 1.25,
    costPer1MOutputUsd: 10,
    latencyMsP50: 2500,
    strengths: ['codegen', 'refactor', 'plan', 'review', 'fix'],
    maxDifficulty: 5,
    note: 'Cloud, mạnh, xử lý được task khó.',
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    kind: 'cloud',
    contextTokens: 400_000,
    costPer1MInputUsd: 0.25,
    costPer1MOutputUsd: 2,
    latencyMsP50: 1500,
    strengths: ['codegen', 'fix', 'test', 'chat'],
    maxDifficulty: 4,
    note: 'Cloud, rẻ, cân bằng cost/latency.',
  },
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    kind: 'cloud',
    contextTokens: 200_000,
    costPer1MInputUsd: 4,
    costPer1MOutputUsd: 20,
    latencyMsP50: 3500,
    strengths: ['codegen', 'refactor', 'review', 'plan', 'fix'],
    maxDifficulty: 5,
    note: 'Cloud, mạnh nhất cho code khó, đắt nhất.',
  },
];

export interface CodingV3TaskProfile {
  type: CodingV3TaskType;
  /** Độ khó ước tính 1-5 (1 = sửa 1 dòng, 5 = thiết kế hệ thống). */
  difficulty: number;
  /** Token input ước tính (để tính chi phí). Mặc định 4000. */
  estimatedInputTokens?: number;
  /** Token output ước tính. Mặc định 1000. */
  estimatedOutputTokens?: number;
  /** Ngân sách USD tối đa cho lượt gọi (mặc định: không giới hạn). */
  maxCostUsd?: number;
  /** Ngân sách độ trễ ms tối đa (mặc định: không giới hạn). */
  maxLatencyMs?: number;
  /** Chỉ dùng model local (mặc định false). */
  preferLocal?: boolean;
  /** Chỉ dùng model cloud (mặc định false). */
  preferCloud?: boolean;
}

export interface CodingV3ModelScore {
  model: CodingV3ModelEntry;
  score: number;
  /** Chi phí ước tính cho lượt gọi (USD). */
  estimatedCostUsd: number;
  breakdown: {
    taskType: number;
    difficulty: number;
    cost: number;
    latency: number;
    localBonus: number;
  };
  reasons: string[];
}

export interface CodingV3RoutingDecision {
  picked: CodingV3ModelScore;
  /** Chuỗi fallback theo thứ tự ưu tiên (không gồm model đã chọn). */
  fallbacks: CodingV3ModelScore[];
  /** Model bị loại vì lỗi gần đây. */
  excludedByFailure: string[];
  /** Model bị loại vì vi phạm ngân sách cost/latency (ràng buộc cứng). */
  excludedByConstraint: string[];
  profile: CodingV3TaskProfile;
  decidedAt: string;
}

export interface CodingV3RouterOptions {
  /** Ghi đè/thay bảng model mặc định. */
  catalog?: CodingV3ModelEntry[];
  /** Thời gian một failure còn hiệu lực (ms). Mặc định 10 phút. */
  failureTtlMs?: number;
}

export const CODING_V3_ROUTER_DEFAULT_FAILURE_TTL_MS = 10 * 60 * 1000;
const SCORE_TASK_TYPE = 40;
const SCORE_DIFFICULTY = 20;
const SCORE_COST = 20;
const SCORE_LATENCY = 10;
const SCORE_LOCAL = 10;

function clampDifficulty(difficulty: number): number {
  if (!Number.isFinite(difficulty)) return 3;
  return Math.min(5, Math.max(1, Math.round(difficulty)));
}

function estimateCostUsd(model: CodingV3ModelEntry, profile: CodingV3TaskProfile): number {
  const inputTokens = Math.max(0, Math.floor(profile.estimatedInputTokens ?? 4000));
  const outputTokens = Math.max(0, Math.floor(profile.estimatedOutputTokens ?? 1000));
  return (inputTokens * model.costPer1MInputUsd) / 1_000_000 + (outputTokens * model.costPer1MOutputUsd) / 1_000_000;
}

function scoreModel(model: CodingV3ModelEntry, profile: CodingV3TaskProfile): CodingV3ModelScore {
  const difficulty = clampDifficulty(profile.difficulty);
  const reasons: string[] = [];
  const breakdown = { taskType: 0, difficulty: 0, cost: 0, latency: 0, localBonus: 0 };

  // 1. Khớp loại task (40): mạnh đúng loại = đủ điểm; không có trong
  // strengths = 10 (vẫn dùng được, yếu hơn).
  if (model.strengths.includes(profile.type)) {
    breakdown.taskType = SCORE_TASK_TYPE;
    reasons.push(`mạnh cho ${profile.type}`);
  } else {
    breakdown.taskType = 10;
    reasons.push(`không chuyên ${profile.type} (chỉ +10/${SCORE_TASK_TYPE})`);
  }

  // 2. Vừa độ khó (20): đủ sức = đủ điểm; yếu hơn 1 cấp = 10; yếu
  // hơn >= 2 cấp = 0; mạnh hơn 2 cấp trở lên = 14 (lãng phí).
  const gap = model.maxDifficulty - difficulty;
  if (gap === 0 || gap === 1) {
    breakdown.difficulty = SCORE_DIFFICULTY;
    reasons.push(`vừa độ khó ${difficulty}`);
  } else if (gap === -1) {
    breakdown.difficulty = 10;
    reasons.push(`hơi yếu cho độ khó ${difficulty} (max ${model.maxDifficulty})`);
  } else if (gap <= -2) {
    breakdown.difficulty = 0;
    reasons.push(`quá yếu cho độ khó ${difficulty} (max ${model.maxDifficulty})`);
  } else {
    breakdown.difficulty = 14;
    reasons.push(`mạnh hơn cần cho độ khó ${difficulty} (max ${model.maxDifficulty})`);
  }

  // 3. Chi phí (20): trong ngân sách = đủ điểm, tỉ lệ theo chi phí
  // ước tính (rẻ nhất trong catalog = đủ điểm); vượt ngân sách = 0.
  const estimatedCostUsd = estimateCostUsd(model, profile);
  if (profile.maxCostUsd !== undefined && estimatedCostUsd > profile.maxCostUsd) {
    breakdown.cost = 0;
    reasons.push(`vượt ngân sách $${profile.maxCostUsd} (ước tính $${estimatedCostUsd.toFixed(4)})`);
  } else if (estimatedCostUsd === 0) {
    breakdown.cost = SCORE_COST;
    reasons.push('miễn phí (local)');
  } else {
    // Rẻ hơn $0.01/lượt = đủ điểm; đắt dần thì giảm tuyến tính tới $0.20.
    const ratio = Math.min(1, Math.max(0, (0.2 - estimatedCostUsd) / 0.19));
    breakdown.cost = Math.round(ratio * SCORE_COST);
    reasons.push(`chi phí ước tính $${estimatedCostUsd.toFixed(4)}/lượt`);
  }

  // 4. Độ trễ (10): trong ngân sách = đủ điểm; vượt = 0; không có
  // ngân sách thì nhanh hơn 2s = đủ điểm, chậm dần giảm điểm.
  if (profile.maxLatencyMs !== undefined) {
    if (model.latencyMsP50 <= profile.maxLatencyMs) {
      breakdown.latency = SCORE_LATENCY;
      reasons.push(`độ trễ p50 ${model.latencyMsP50}ms trong ngân sách ${profile.maxLatencyMs}ms`);
    } else {
      breakdown.latency = 0;
      reasons.push(`độ trễ p50 ${model.latencyMsP50}ms vượt ngân sách ${profile.maxLatencyMs}ms`);
    }
  } else if (model.latencyMsP50 <= 2000) {
    breakdown.latency = SCORE_LATENCY;
    reasons.push(`nhanh (p50 ${model.latencyMsP50}ms)`);
  } else {
    breakdown.latency = Math.max(0, Math.round(SCORE_LATENCY * (5000 - model.latencyMsP50) / 3000));
    reasons.push(`chậm hơn (p50 ${model.latencyMsP50}ms)`);
  }

  // 5. Ưu tiên local (10): local = đủ điểm; cloud = 0 (trừ khi
  // caller chỉ định preferCloud thì cloud được đủ điểm thay).
  if (profile.preferCloud === true) {
    if (model.kind === 'cloud') {
      breakdown.localBonus = SCORE_LOCAL;
      reasons.push('cloud theo yêu cầu');
    }
  } else if (model.kind === 'local') {
    breakdown.localBonus = SCORE_LOCAL;
    reasons.push('local-first (riêng tư, $0)');
  }

  const score =
    breakdown.taskType + breakdown.difficulty + breakdown.cost + breakdown.latency + breakdown.localBonus;
  return { model, score, estimatedCostUsd, breakdown, reasons };
}

/**
 * Router: chấm điểm mọi model trong catalog, loại model lỗi gần đây
 * và model trái `preferLocal`/`preferCloud`, trả model tốt nhất +
 * chuỗi fallback + log lý do.
 */
export class CodingV3ModelRouter {
  private readonly catalog: CodingV3ModelEntry[];
  private readonly failureTtlMs: number;
  private readonly failures = new Map<string, { at: number; error: string }>();
  private readonly decisionLog: CodingV3RoutingDecision[] = [];

  constructor(options: CodingV3RouterOptions = {}) {
    this.catalog = options.catalog ?? CODING_V3_DEFAULT_CATALOG;
    this.failureTtlMs = Math.max(0, Math.floor(options.failureTtlMs ?? CODING_V3_ROUTER_DEFAULT_FAILURE_TTL_MS));
  }

  get modelCount(): number {
    return this.catalog.length;
  }

  listModels(): CodingV3ModelEntry[] {
    return [...this.catalog];
  }

  /** Ghi một lần lỗi của model (host gọi khi gọi provider thất bại). */
  recordFailure(modelId: string, error: string): void {
    this.failures.set(modelId, { at: Date.now(), error });
  }

  /** Xoá failure của một model (đã khỏi / host retry thủ công). */
  clearFailure(modelId: string): void {
    this.failures.delete(modelId);
  }

  /** Model đang bị loại vì lỗi trong TTL (kèm lý do). */
  failedModels(): Array<{ modelId: string; error: string; failedAt: string }> {
    const now = Date.now();
    const out: Array<{ modelId: string; error: string; failedAt: string }> = [];
    for (const [modelId, failure] of this.failures) {
      if (now - failure.at <= this.failureTtlMs) {
        out.push({ modelId, error: failure.error, failedAt: new Date(failure.at).toISOString() });
      }
    }
    return out;
  }

  /** Quyết định routing cho một task profile. */
  pickModel(profile: CodingV3TaskProfile): CodingV3RoutingDecision {
    const now = Date.now();
    const excludedByFailure: string[] = [];
    const excludedByConstraint: string[] = [];
    const scored: CodingV3ModelScore[] = [];
    for (const model of this.catalog) {
      const failure = this.failures.get(model.id);
      if (failure && now - failure.at <= this.failureTtlMs) {
        excludedByFailure.push(`${model.id} (lỗi: ${failure.error})`);
        continue;
      }
      if (profile.preferLocal === true && model.kind !== 'local') continue;
      if (profile.preferCloud === true && model.kind !== 'cloud') continue;
      // Ngân sách là ràng buộc cứng: model vi phạm bị loại hẳn, không
      // chỉ bị trừ điểm — nếu không model miễn phí nhưng chậm vẫn có
      // thể thắng nhờ điểm cost/local bù lại điểm latency.
      const cost = estimateCostUsd(model, profile);
      if (profile.maxCostUsd !== undefined && cost > profile.maxCostUsd) {
        excludedByConstraint.push(`${model.id} (vượt ngân sách $${profile.maxCostUsd}, ước tính $${cost.toFixed(4)})`);
        continue;
      }
      if (profile.maxLatencyMs !== undefined && model.latencyMsP50 > profile.maxLatencyMs) {
        excludedByConstraint.push(
          `${model.id} (độ trễ p50 ${model.latencyMsP50}ms vượt ngân sách ${profile.maxLatencyMs}ms)`,
        );
        continue;
      }
      scored.push(scoreModel(model, profile));
    }
    // Sắp xếp: điểm cao trước; hoà điểm thì rẻ trước, rồi nhanh trước.
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.estimatedCostUsd - b.estimatedCostUsd ||
        a.model.latencyMsP50 - b.model.latencyMsP50 ||
        a.model.id.localeCompare(b.model.id),
    );
    if (scored.length === 0) {
      throw new Error(
        `Router không còn model khả dụng cho task ${profile.type} (tất cả bị loại bởi preferLocal/preferCloud, lỗi gần đây, hoặc ngân sách: ${[...excludedByFailure, ...excludedByConstraint].join('; ') || 'không rõ'}).`,
      );
    }
    const [picked, ...fallbacks] = scored as [CodingV3ModelScore, ...CodingV3ModelScore[]];
    const decision: CodingV3RoutingDecision = {
      picked,
      fallbacks,
      excludedByFailure,
      excludedByConstraint,
      profile: { ...profile, difficulty: clampDifficulty(profile.difficulty) },
      decidedAt: new Date().toISOString(),
    };
    this.decisionLog.push(decision);
    if (this.decisionLog.length > 200) this.decisionLog.splice(0, this.decisionLog.length - 200);
    return decision;
  }

  /** Log quyết định gần nhất (mới nhất trước, tối đa `limit`). */
  recentDecisions(limit = 20): CodingV3RoutingDecision[] {
    return this.decisionLog.slice(-Math.max(1, limit)).reverse();
  }
}
