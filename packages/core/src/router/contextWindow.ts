/**
 * Router biết context window từng model (v1.07, Đội T6).
 *
 * Ý tưởng học từ Claude Code 2026 (survey v1.07 §2): mọi model Claude
 * hiện tại trừ Haiku đều có context 1M token — router nên BIẾT context
 * window từng model để chọn chiến lược nén/summarize thay vì cắt bừa
 * khi context sắp đầy. Module này nối tiếp `targets.ts`
 * (`ESTIMATED_CONTEXT_LIMIT` theo provider) xuống mức MODEL: bảng
 * window theo model id cụ thể, fallback theo họ model rồi theo
 * provider, cuối cùng là fallback an toàn.
 *
 * TẤT CẢ số trong bảng đều là ƯỚC TÍNH công khai (ghi rõ trong tên
 * hằng + comment) — chỉ dùng để chọn chiến lược nén và xếp hạng đích,
 * không phải cam kết của nhà cung cấp. Khi provider đổi window, sửa
 * một chỗ ở đây, mọi nơi khác tự đúng.
 *
 * Chiến lược theo tỉ lệ đã dùng (đo trên window đã trừ reserve):
 *   < 70%  → none (chưa cần làm gì)
 *   70–85% → summarize-oldest (tóm tắt lượt cũ nhất, giữ lượt gần)
 *   85–95% → compress (nén toàn bộ lịch sử thành bản tóm tắt + giữ
 *             system prompt + memory blocks nguyên vẹn)
 *   >= 95% → truncate-hard (cắt lịch sử cũ, chỉ giữ N lượt gần nhất)
 * Ngoài ra `suggestLargerWindowTarget` đề xuất đích có window lớn hơn
 * khi chiến lược đã tới truncate-hard — đổi model rẻ hơn là cắt mất
 * mạch hội thoại.
 */

import { ESTIMATED_CONTEXT_LIMIT } from './targets';
import type { RouterTarget } from './router';

/** Fallback khi không biết model lẫn provider: window nhỏ an toàn. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** Số token dự trữ tối thiểu cho phần trả lời của model. */
export const DEFAULT_ROUTER_RESERVE_TOKENS = 4_000;

/** Ngưỡng chiến lược (tỉ lệ đã dùng trên window khả dụng). */
export const CONTEXT_STRATEGY_THRESHOLDS = {
  /** Dưới ngưỡng này: chưa cần nén. */
  summarizeAt: 0.7,
  /** Từ ngưỡng này: nén toàn bộ lịch sử. */
  compressAt: 0.85,
  /** Từ ngưỡng này: cắt cứng lịch sử cũ. */
  truncateAt: 0.95,
} as const;

/** Chiến lược nén context mà router chọn. */
export type ContextCompactionStrategy =
  | 'none'
  | 'summarize-oldest'
  | 'compress'
  | 'truncate-hard';

/**
 * Context window ƯỚC TÍNH (token) theo model id cụ thể. Key là model
 * id viết thường (khớp chính xác trước, rồi khớp họ model). Số lấy từ
 * tài liệu công khai của nhà cung cấp tại thời điểm viết (11/2026);
 * model mới chưa có trong bảng sẽ rơi về họ model rồi provider.
 */
export const KNOWN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // --- Anthropic Claude: 1M token cho mọi model hiện tại trừ Haiku.
  'claude-opus-4-5': 1_000_000,
  'claude-opus-4-1': 1_000_000,
  'claude-opus-4': 1_000_000,
  'claude-sonnet-4-5': 1_000_000,
  'claude-sonnet-4': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-3-5': 200_000,
  'claude-haiku-3': 200_000,
  // --- OpenAI.
  'gpt-5': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-5-nano': 400_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  'o3': 200_000,
  'o4-mini': 200_000,
  // --- Google Gemini: họ 2.x/3.x đều 1M (2.5 Pro có bản 2M nhưng
  // giữ 1M làm ước tính an toàn — không phóng đại window).
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-3-pro': 1_000_000,
  'gemini-3-flash': 1_000_000,
  // --- xAI Grok.
  'grok-4': 256_000,
  'grok-4-1': 256_000,
  'grok-4-7': 256_000,
  'grok-3': 131_072,
  'grok-2': 131_072,
  // --- Local / open-weight thường gặp qua Ollama.
  'qwen2.5': 32_768,
  'qwen3': 32_768,
  'llama3.1': 128_000,
  'llama3.2': 128_000,
  'llama3.3': 128_000,
  'mistral': 32_768,
  'mixtral': 32_768,
  'deepseek-r1': 64_000,
  'deepseek-chat': 64_000,
  'gemma3': 128_000,
  'phi4': 16_384,
};

/**
 * Window theo HỌ model (khớp tiền tố, viết thường). Dùng khi model id
 * cụ thể chưa có trong bảng trên nhưng thuộc họ đã biết — vd
 * `claude-sonnet-4-5-20250929` hay `gpt-5-chat-latest`.
 */
export const MODEL_FAMILY_CONTEXT_WINDOWS: Array<{ prefix: string; tokens: number }> = [
  { prefix: 'claude-opus', tokens: 1_000_000 },
  { prefix: 'claude-sonnet', tokens: 1_000_000 },
  { prefix: 'claude-haiku', tokens: 200_000 },
  { prefix: 'claude', tokens: 200_000 },
  { prefix: 'gpt-5', tokens: 400_000 },
  { prefix: 'gpt-4.1', tokens: 1_000_000 },
  { prefix: 'gpt-4o', tokens: 128_000 },
  { prefix: 'gpt-4', tokens: 128_000 },
  { prefix: 'o3', tokens: 200_000 },
  { prefix: 'o4', tokens: 200_000 },
  { prefix: 'gemini-3', tokens: 1_000_000 },
  { prefix: 'gemini-2.5', tokens: 1_000_000 },
  { prefix: 'gemini-2.0', tokens: 1_000_000 },
  { prefix: 'gemini', tokens: 1_000_000 },
  { prefix: 'grok-4', tokens: 256_000 },
  { prefix: 'grok', tokens: 131_072 },
  { prefix: 'qwen3', tokens: 32_768 },
  { prefix: 'qwen2.5', tokens: 32_768 },
  { prefix: 'qwen', tokens: 32_768 },
  { prefix: 'llama3', tokens: 128_000 },
  { prefix: 'llama', tokens: 128_000 },
  { prefix: 'mistral', tokens: 32_768 },
  { prefix: 'mixtral', tokens: 32_768 },
  { prefix: 'deepseek', tokens: 64_000 },
  { prefix: 'gemma', tokens: 128_000 },
];

/** Nguồn của con số window đã resolve — để caller biết độ tin cậy. */
export type ContextWindowSource = 'exact-model' | 'model-family' | 'provider-default' | 'fallback';

/** Kết quả resolve context window cho một model. */
export interface ResolvedContextWindow {
  /** Model id đã chuẩn hoá (viết thường, bỏ hậu tố ngày nếu có). */
  model: string;
  /** Provider id (nếu biết). */
  providerId?: string;
  /** Window ước tính (token). */
  windowTokens: number;
  /** Con số này lấy từ đâu. */
  source: ContextWindowSource;
}

/** Bỏ hậu tố ngày/version ở cuối model id (vd `-20250929`, `:latest`). */
export function normalizeModelId(model: string): string {
  const lower = model.trim().toLowerCase();
  // `qwen2.5:0.5b` (tag Ollama) → giữ nguyên phần trước ':'.
  const beforeTag = lower.split(':')[0] ?? lower;
  // Bỏ hậu tố ngày 8 chữ số ở cuối: `claude-sonnet-4-5-20250929`.
  return beforeTag.replace(/-\d{8}$/, '');
}

/**
 * Resolve context window cho một model: khớp chính xác → họ model →
 * provider mặc định (`ESTIMATED_CONTEXT_LIMIT`) → fallback 128k.
 * Không throw với input lạ — model rỗng vẫn trả fallback kèm source.
 */
export function resolveContextWindow(
  model: string,
  providerId?: string,
): ResolvedContextWindow {
  const normalized = normalizeModelId(model);
  if (normalized) {
    const exact = KNOWN_MODEL_CONTEXT_WINDOWS[normalized];
    if (typeof exact === 'number') {
      return { model: normalized, ...(providerId ? { providerId } : {}), windowTokens: exact, source: 'exact-model' };
    }
    // Khớp họ model: tiền tố dài nhất thắng (vd `gpt-5` trước `gpt-4`).
    let best: { prefix: string; tokens: number } | null = null;
    for (const family of MODEL_FAMILY_CONTEXT_WINDOWS) {
      if (normalized.startsWith(family.prefix)) {
        if (!best || family.prefix.length > best.prefix.length) best = family;
      }
    }
    if (best) {
      return { model: normalized, ...(providerId ? { providerId } : {}), windowTokens: best.tokens, source: 'model-family' };
    }
  }
  if (providerId) {
    const byProvider = ESTIMATED_CONTEXT_LIMIT[providerId];
    if (typeof byProvider === 'number') {
      return { model: normalized, providerId, windowTokens: byProvider, source: 'provider-default' };
    }
  }
  return { model: normalized, ...(providerId ? { providerId } : {}), windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'fallback' };
}

/** Context window của một RouterTarget (model + provider của đích đó). */
export function contextWindowForTarget(target: RouterTarget): ResolvedContextWindow {
  const fromTarget = target.contextLimit;
  if (typeof fromTarget === 'number' && fromTarget > 0) {
    // Đích đã mang window riêng (vd coordinator gán tay) — tôn trọng
    // nó, nhưng vẫn báo source để caller biết đây không phải bảng.
    return {
      model: normalizeModelId(target.model),
      providerId: target.providerId,
      windowTokens: fromTarget,
      source: 'provider-default',
    };
  }
  return resolveContextWindow(target.model, target.providerId);
}

/** Ước tính token từ số ký tự (quy tắc 4 ký tự ≈ 1 token, như mọi nơi trong repo). */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** Đầu vào đánh giá áp lực context của một turn. */
export interface ContextPressureInput {
  /** Token đã dùng (system + memory + lịch sử + reserve đã trừ riêng). */
  usedTokens: number;
  /** Context window của model đang chạy (token). */
  windowTokens: number;
  /** Token dự trữ cho câu trả lời — mặc định 4000. */
  reserveTokens?: number;
}

/** Kết quả đánh giá áp lực context. */
export interface ContextPressure {
  usedTokens: number;
  windowTokens: number;
  reserveTokens: number;
  /** Window trừ reserve — phần thật sự dùng được cho prompt. */
  usableTokens: number;
  /** Tỉ lệ đã dùng trên window khả dụng (0..>1, có thể vượt 1). */
  usageRatio: number;
  /** Token còn trống trong phần khả dụng (âm = đã vượt). */
  headroomTokens: number;
  /** Chiến lược router nên áp dụng NGAY cho turn này. */
  strategy: ContextCompactionStrategy;
  /** true khi đã vượt ngưỡng phải nén (strategy != none). */
  needsCompaction: boolean;
  /** Lý do ngắn gọn, đọc được (UI/log hiển thị). */
  reason: string;
}

/**
 * Đánh giá áp lực context và chọn chiến lược nén. Ngưỡng đo trên
 * window KHẢ DỤNG (window − reserve) vì phần trả lời phải còn chỗ.
 * Không throw: window <= 0 thì coi như đã đầy (truncate-hard).
 */
export function assessContextPressure(input: ContextPressureInput): ContextPressure {
  const used = Math.max(0, Math.floor(input.usedTokens));
  const windowTokens = Math.max(0, Math.floor(input.windowTokens));
  const reserve = Math.max(0, Math.floor(input.reserveTokens ?? DEFAULT_ROUTER_RESERVE_TOKENS));
  const usable = Math.max(0, windowTokens - reserve);
  const ratio = usable > 0 ? used / usable : used > 0 ? Infinity : 0;
  const headroom = usable - used;
  let strategy: ContextCompactionStrategy = 'none';
  let reason: string;
  if (windowTokens <= 0) {
    strategy = 'truncate-hard';
    reason = 'Không biết context window của model — cắt cứng lịch sử cũ để turn còn chạy được.';
  } else if (ratio < CONTEXT_STRATEGY_THRESHOLDS.summarizeAt) {
    reason = `Context mới dùng ${(ratio * 100).toFixed(0)}% (${used.toLocaleString('en-US')}/${usable.toLocaleString('en-US')} token khả dụng) — chưa cần nén.`;
  } else if (ratio < CONTEXT_STRATEGY_THRESHOLDS.compressAt) {
    strategy = 'summarize-oldest';
    reason = `Context đã dùng ${(ratio * 100).toFixed(0)}% — tóm tắt các lượt cũ nhất, giữ nguyên lượt gần đây và memory blocks.`;
  } else if (ratio < CONTEXT_STRATEGY_THRESHOLDS.truncateAt) {
    strategy = 'compress';
    reason = `Context đã dùng ${(ratio * 100).toFixed(0)}% — nén toàn bộ lịch sử thành bản tóm tắt, giữ system prompt + memory blocks nguyên vẹn.`;
  } else {
    strategy = 'truncate-hard';
    reason = `Context đã dùng ${(ratio * 100).toFixed(0)}% (còn ${headroom.toLocaleString('en-US')} token) — cắt lịch sử cũ, chỉ giữ N lượt gần nhất, nếu không turn sẽ tràn window.`;
  }
  return {
    usedTokens: used,
    windowTokens,
    reserveTokens: reserve,
    usableTokens: usable,
    usageRatio: ratio,
    headroomTokens: headroom,
    strategy,
    needsCompaction: strategy !== 'none',
    reason,
  };
}

/** Chọn chiến lược nén từ tỉ lệ đã dùng — hàm gọn cho caller chỉ có ratio. */
export function chooseCompactionStrategy(usageRatio: number): ContextCompactionStrategy {
  if (!Number.isFinite(usageRatio) || usageRatio < CONTEXT_STRATEGY_THRESHOLDS.summarizeAt) return 'none';
  if (usageRatio < CONTEXT_STRATEGY_THRESHOLDS.compressAt) return 'summarize-oldest';
  if (usageRatio < CONTEXT_STRATEGY_THRESHOLDS.truncateAt) return 'compress';
  return 'truncate-hard';
}

/** Kế hoạch chia window thành các ngăn: system / memory / history / reserve. */
export interface ContextBudgetPlan {
  windowTokens: number;
  reserveTokens: number;
  systemTokens: number;
  memoryTokens: number;
  historyTokens: number;
  /** Tổng các ngăn = window (làm tròn xuống, phần dư vào history). */
  totalTokens: number;
}

/**
 * Chia context window thành ngăn theo tỉ lệ cố định: system 12%,
 * memory 20%, reserve theo input (mặc định 4000 token, kẹp 2–12%),
 * còn lại cho lịch sử. History không bao giờ dưới 0 — window quá
 * nhỏ thì memory/system bị kẹp theo.
 */
export function planContextBudget(
  windowTokens: number,
  opts: { reserveTokens?: number } = {},
): ContextBudgetPlan {
  const window = Math.max(0, Math.floor(windowTokens));
  const reserveRaw = Math.floor(opts.reserveTokens ?? DEFAULT_ROUTER_RESERVE_TOKENS);
  const reserveMin = Math.floor(window * 0.02);
  const reserveMax = Math.floor(window * 0.12);
  const reserve = window === 0 ? 0 : Math.max(reserveMin, Math.min(reserveMax, Math.max(0, reserveRaw)));
  const system = Math.floor(window * 0.12);
  const memory = Math.floor(window * 0.2);
  const history = Math.max(0, window - reserve - system - memory);
  return {
    windowTokens: window,
    reserveTokens: reserve,
    systemTokens: system,
    memoryTokens: memory,
    historyTokens: history,
    totalTokens: reserve + system + memory + history,
  };
}

/**
 * Đề xuất đích có window lớn hơn đích hiện tại khi context đã tới
 * mức phải cắt cứng: đổi sang model window lớn rẻ hơn là cắt mất
 * mạch hội thoại. Trả null khi không có đích nào lớn hơn (hoặc đích
 * hiện tại đã lớn nhất). Chỉ xét đích có window resolve được lớn hơn
 * đích hiện tại ít nhất 25%.
 */
export function suggestLargerWindowTarget(
  current: RouterTarget,
  candidates: RouterTarget[],
): { target: RouterTarget; windowTokens: number; gainRatio: number } | null {
  const currentWindow = contextWindowForTarget(current).windowTokens;
  let best: { target: RouterTarget; windowTokens: number; gainRatio: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.id === current.id) continue;
    const window = contextWindowForTarget(candidate).windowTokens;
    if (window <= currentWindow * 1.25) continue;
    const gain = window / Math.max(1, currentWindow);
    if (!best || window > best.windowTokens) {
      best = { target: candidate, windowTokens: window, gainRatio: gain };
    }
  }
  return best;
}

/**
 * Đánh giá đầy đủ cho một turn: resolve window của đích đang chạy,
 * đo áp lực, và (khi cần cắt cứng) gợi ý đích window lớn hơn. Đây là
 * hàm router gọi mỗi turn thay vì chỉ nhìn `contextUsageRatio` mù.
 */
export function assessTurnContext(
  target: RouterTarget,
  usedTokens: number,
  candidates: RouterTarget[] = [],
  opts: { reserveTokens?: number } = {},
): ContextPressure & {
  resolved: ResolvedContextWindow;
  budget: ContextBudgetPlan;
  largerWindowSuggestion: { target: RouterTarget; windowTokens: number; gainRatio: number } | null;
} {
  const resolved = contextWindowForTarget(target);
  const pressure = assessContextPressure({
    usedTokens,
    windowTokens: resolved.windowTokens,
    reserveTokens: opts.reserveTokens,
  });
  return {
    ...pressure,
    resolved,
    budget: planContextBudget(resolved.windowTokens, opts),
    largerWindowSuggestion:
      pressure.strategy === 'truncate-hard'
        ? suggestLargerWindowTarget(target, candidates)
        : null,
  };
}
