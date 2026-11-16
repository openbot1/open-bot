/**
 * RouterLLM v6 — leo thang model theo ngữ cảnh (v1.14, Đội T3).
 *
 * Ý tưởng học từ OpenHands RouterLLM (survey v1.14 §2): đổi model
 * giữa hội thoại — leo thang lên model mạnh (vd multimodal) chỉ khi
 * cần. Nối với ModelRouter của open-bot (v0.96: structural →
 * semantic → decision, session pinning, fallback ladder): v6 là
 * tầng rule NHẸ, xác định, chạy TRƯỚC khi gọi model trong agent
 * loop của coding agent — không gọi model để quyết định model
 * (tránh vòng lặp tốn kém), chỉ chấm tín hiệu của task:
 *
 *   - Task dễ (ngắn, ít file, không lỗi, không ảnh) → tier `light`
 *     (model nhẹ/rẻ).
 *   - Task vừa (vài file, có lỗi, refactor) → tier `standard`.
 *   - Task khó (nhiều file, nhiều lỗi, từ khoá kiến trúc/debug
 *     sâu, có ảnh/screenshot, context gần đầy) → tier `strong`.
 *
 * Tính chất:
 * - LEO THANG MỘT CHIỀU trong một session: sau quyết định đầu
 *   tiên (được chọn tự do — task dễ bắt đầu ở tier light), tier
 *   chỉ đi lên, tránh nhảy model giữa chừng làm mất mạch hội thoại
 *   (cùng nguyên tắc session pinning của router chung). `reset()`
 *   đưa về standard khi bắt đầu session mới.
 * - Mọi quyết định được LOG (tier, model, lý do, tín hiệu) vào
 *   `decisions` — agent ghi event `v6.model.routed` từ đó, UI đọc
 *   được vì sao chọn model này.
 * - Model theo tier cấu hình được (`RouterLlmModels`); rule
 *   (ngưỡng/điểm) cấu hình được (`RouterLlmRules`).
 * - Fail-open: input lạ → tier `standard` (model mặc định), không
 *   bao giờ làm hỏng turn.
 */

import type { V6ModelTier } from './types';

/** Model theo từng tier (host cấu hình — tên model đầy đủ). */
export interface RouterLlmModels {
  /** Model nhẹ/rẻ (vd model local nhỏ, Haiku). */
  light: string;
  /** Model mặc định. */
  standard: string;
  /** Model mạnh (vd frontier). */
  strong: string;
}

/** Model mặc định khi host không cấu hình (tên gợi ý, không gọi thật). */
export const DEFAULT_ROUTER_LLM_MODELS: RouterLlmModels = {
  light: 'local-light',
  standard: 'default',
  strong: 'frontier-strong',
};

/** Ngưỡng/điểm của rule leo thang (host cấu hình được). */
export interface RouterLlmRules {
  /** Điểm >= ngưỡng này → strong. Mặc định 6. */
  strongThreshold?: number;
  /** Điểm <= ngưỡng này → light. Mặc định 1. */
  lightThreshold?: number;
  /** Điểm cộng khi prompt dài hơn số ký tự này. Mặc định 2000. */
  longPromptChars?: number;
  /** Điểm cộng mỗi N file liên quan. Mặc định 5. */
  filesPerPoint?: number;
  /** Điểm cộng khi có ảnh đính kèm (cần multimodal). Mặc định 4. */
  imagePoints?: number;
  /** Điểm cộng mỗi lỗi đã gặp. Mặc định 2. */
  errorPoints?: number;
}

const DEFAULT_ROUTER_LLM_RULES: Required<RouterLlmRules> = {
  strongThreshold: 6,
  lightThreshold: 1,
  longPromptChars: 2000,
  filesPerPoint: 5,
  imagePoints: 4,
  errorPoints: 2,
};

/** Tín hiệu đầu vào để route (task hiện tại + trạng thái session). */
export interface RouterLlmContext {
  /** Text task/prompt hiện tại. */
  prompt: string;
  /** Số file liên quan tới task (vd file đã `/add` / đã đổi). */
  fileCount?: number;
  /** Số lỗi đã gặp trong session (từ log v6). */
  errorCount?: number;
  /** true khi có ảnh/screenshot đính kèm (cần model xem được ảnh). */
  hasImage?: boolean;
  /** Số token context đã dùng (ước lượng) — gần đầy thì leo thang? Không: gần đầy thì giữ tier, chỉ ghi chú. */
  contextTokensUsed?: number;
  /** Giới hạn context window (token) — để tính tỉ lệ đã dùng. */
  contextLimit?: number;
}

/** Một quyết định route đã log. */
export interface RouterLlmDecision {
  at: string;
  tier: V6ModelTier;
  model: string;
  /** Điểm khó tính được + ngưỡng đã áp. */
  score: number;
  /** Lý do đọc được (vd "nhiều lỗi (3) + kiến trúc"). */
  reason: string;
  /** Tín hiệu đã chấm (để debug). */
  signals: string[];
  /** true khi quyết định này leo thang so với tier trước. */
  escalated: boolean;
}

/** Từ khoá task khó (kiến trúc / debug sâu / hiệu năng). */
export const ROUTER_LLM_HARD_KEYWORDS: readonly string[] = [
  'architecture',
  'kiến trúc',
  'refactor',
  'tái cấu trúc',
  'race condition',
  'deadlock',
  'memory leak',
  'rò rỉ bộ nhớ',
  'performance',
  'hiệu năng',
  'security',
  'bảo mật',
  'migrate',
  'di chuyển',
  'design',
  'thiết kế hệ thống',
];

/** Từ khoá task dễ (hỏi đáp / việc nhỏ). */
export const ROUTER_LLM_EASY_KEYWORDS: readonly string[] = [
  'what is',
  'là gì',
  'explain',
  'giải thích',
  'typo',
  'lỗi chính tả',
  'rename',
  'đổi tên',
  'comment',
  'chú thích',
];

/** Chấm điểm khó của task (pure — dùng cho test + log lý do). */
export function scoreRouterLlmContext(
  ctx: RouterLlmContext,
  rules: RouterLlmRules = {},
): { score: number; signals: string[] } {
  const r = { ...DEFAULT_ROUTER_LLM_RULES, ...rules };
  let score = 0;
  const signals: string[] = [];
  const prompt = ctx.prompt ?? '';
  const lower = prompt.toLowerCase();

  if (prompt.length >= r.longPromptChars) {
    score += 2;
    signals.push(`prompt dài (${prompt.length} ký tự)`);
  }
  const fileCount = ctx.fileCount ?? 0;
  if (fileCount > 0) {
    const points = Math.floor(fileCount / r.filesPerPoint);
    if (points > 0) {
      score += points;
      signals.push(`${fileCount} file liên quan`);
    }
  }
  const errorCount = ctx.errorCount ?? 0;
  if (errorCount > 0) {
    score += errorCount * r.errorPoints;
    signals.push(`${errorCount} lỗi đã gặp`);
  }
  if (ctx.hasImage) {
    score += r.imagePoints;
    signals.push('có ảnh đính kèm (cần multimodal)');
  }
  const hardHit = ROUTER_LLM_HARD_KEYWORDS.find((k) => lower.includes(k));
  if (hardHit) {
    score += 3;
    signals.push(`từ khoá khó: "${hardHit}"`);
  }
  const easyHit = ROUTER_LLM_EASY_KEYWORDS.find((k) => lower.includes(k));
  if (easyHit && score === 0) {
    score -= 1;
    signals.push(`task dễ: "${easyHit}"`);
  }
  if (
    ctx.contextTokensUsed !== undefined &&
    ctx.contextLimit !== undefined &&
    ctx.contextLimit > 0 &&
    ctx.contextTokensUsed / ctx.contextLimit >= 0.9
  ) {
    signals.push('context sắp đầy (>= 90%) — giữ tier, nên condense');
  }
  return { score, signals };
}

/** Tier suy ra từ điểm (pure). */
export function tierForRouterLlmScore(score: number, rules: RouterLlmRules = {}): V6ModelTier {
  const r = { ...DEFAULT_ROUTER_LLM_RULES, ...rules };
  if (score >= r.strongThreshold) return 'strong';
  if (score <= r.lightThreshold) return 'light';
  return 'standard';
}

/** Thứ tự tier (để so sánh leo thang). */
export const V6_TIER_ORDER: Record<V6ModelTier, number> = { light: 0, standard: 1, strong: 2 };

/**
 * RouterLLM có trạng thái: giữ tier hiện tại (leo thang một chiều),
 * log mọi quyết định. `route` trả tier + model + lý do; `reset`
 * đưa tier về `standard` khi bắt đầu session mới.
 */
export class RouterLlm {
  private readonly models: RouterLlmModels;
  private readonly rules: Required<RouterLlmRules>;
  private currentTier: V6ModelTier = 'standard';
  private readonly decisions: RouterLlmDecision[] = [];
  /** true sau quyết định route đầu tiên của session. */
  private hasDecided = false;

  constructor(options: { models?: RouterLlmModels; rules?: RouterLlmRules } = {}) {
    this.models = { ...DEFAULT_ROUTER_LLM_MODELS, ...(options.models ?? {}) };
    this.rules = { ...DEFAULT_ROUTER_LLM_RULES, ...(options.rules ?? {}) };
  }

  /** Tier hiện tại của session. */
  get tier(): V6ModelTier {
    return this.currentTier;
  }

  /** Model hiện tại (theo tier). */
  get model(): string {
    return this.models[this.currentTier];
  }

  /** Mọi quyết định đã log (theo thứ tự). */
  history(): RouterLlmDecision[] {
    return [...this.decisions];
  }

  /**
   * Route cho một task: chấm điểm → tier mới → chỉ leo thang
   * (không hạ tier trong session, TRỪ quyết định đầu tiên được
   * chọn tự do để task dễ bắt đầu ở tier light) → log quyết định.
   */
  route(ctx: RouterLlmContext): RouterLlmDecision {
    const { score, signals } = scoreRouterLlmContext(ctx, this.rules);
    const wanted = tierForRouterLlmScore(score, this.rules);
    // Quyết định đầu tiên: chọn tự do (task dễ → light ngay).
    // Các lần sau: leo thang một chiều, không hạ tier giữa session.
    const tier = !this.hasDecided
      ? wanted
      : V6_TIER_ORDER[wanted] > V6_TIER_ORDER[this.currentTier]
        ? wanted
        : this.currentTier;
    const escalated = this.hasDecided && V6_TIER_ORDER[tier] > V6_TIER_ORDER[this.currentTier];
    const reason =
      signals.length > 0
        ? `${signals.join(' + ')} (điểm ${score}) → ${tier}`
        : `không có tín hiệu khó (điểm ${score}) → giữ ${tier}`;
    const decision: RouterLlmDecision = {
      at: new Date().toISOString(),
      tier,
      model: this.models[tier],
      score,
      reason,
      signals,
      escalated,
    };
    this.currentTier = tier;
    this.hasDecided = true;
    this.decisions.push(decision);
    return decision;
  }

  /** Đặt lại tier về standard (bắt đầu session mới). */
  reset(): void {
    this.currentTier = 'standard';
    this.hasDecided = false;
  }
}
