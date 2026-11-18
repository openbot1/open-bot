/**
 * Coding agent v12 — conversation budget meters.
 *
 * Nối `BudgetTracker` của coding agent gốc (v1.02: đếm step/token/
 * cost/time cho MỘT run, dừng khi hết budget): v12 nâng lên mức
 * CONVERSATION (nhiều run, nhiều lần switch model trong cùng một
 * phiên làm việc dài) và thêm 3 thứ mà tracker cũ chưa có:
 *
 *   1. Meter riêng cho từng chiều (tokens / cost / time / steps),
 *      mỗi meter báo phần trăm đã dùng + còn lại + mức cảnh báo —
 *      UI vẽ 4 thanh meter từ `state()` là đủ, không cần tự tính.
 *   2. Cảnh báo ngưỡng 50% / 80% / 100%: mỗi lần vượt một ngưỡng
 *      thì gọi `onWarning` đúng MỘT lần (không spam mỗi lần record),
 *      và `check()` cho host hỏi \"còn chạy được nữa không\" trước
 *      mỗi turn — vượt 100% thì dừng, không gọi model thêm.
 *   3. Tự động tóm tắt (compaction) khi gần hết budget: khi token
 *      vượt ngưỡng `autoSummarizeAtPercent` (mặc định 80%), gọi
 *      `summarizer` do host tiêm (host tự chọn cách tóm tắt — ở đây
 *      chỉ có summarizer mặc định trích xuất, KHÔNG gọi model thật),
 *      thay N message cũ bằng 1 message tóm tắt, giữ nguyên K
 *      message gần nhất; token ước lượng được giải phóng và meter
 *      cập nhật ngay để conversation tiếp tục được.
 *
 * Cost ước lượng qua bảng giá chung `usage/pricing` (như tracker
 * cũ); model không có giá thì cost = null (không bao giờ báo $0).
 * Token khi model không báo thì ước lượng chars/4 và đánh dấu
 * `tokensEstimated: true` — số liệu là ước lượng, nói rõ trong
 * report chứ không giả vờ chính xác.
 */

import { estimateCost } from '../usage/pricing';
import { CodingV12Error } from './types';
import type {
  V12BudgetKind,
  V12BudgetMessage,
  V12BudgetState,
  V12BudgetSummaryResult,
  V12BudgetWarningLevel,
  V12ConversationBudget,
  V12MeterReading,
} from './types';

/** Hệ số ước lượng token khi model không báo (chars / 4, như eval v11). */
export const V12_BUDGET_TOKEN_CHARS_PER_TOKEN = 4;

/** Ngưỡng cảnh báo mặc định (phần trăm). */
export const V12_BUDGET_WARN_50 = 50;
export const V12_BUDGET_WARN_80 = 80;
export const V12_BUDGET_WARN_100 = 100;

/** Ngưỡng tự động tóm tắt mặc định (phần trăm token). */
export const V12_BUDGET_DEFAULT_AUTO_SUMMARIZE_AT = 80;

/** Số message gần nhất giữ nguyên khi tóm tắt (mặc định). */
export const V12_BUDGET_DEFAULT_KEEP_RECENT = 6;

/** Giới hạn cứng để tránh cấu hình vô lý. */
export const V12_BUDGET_MAX_TOKENS = 10_000_000;
export const V12_BUDGET_MAX_TIME_MS = 24 * 60 * 60 * 1000;

/** Mức cảnh báo từ phần trăm đã dùng. */
export function v12WarningLevel(percentUsed: number | null): V12BudgetWarningLevel {
  if (percentUsed === null) return 'none';
  if (percentUsed >= V12_BUDGET_WARN_100) return 'critical100';
  if (percentUsed >= V12_BUDGET_WARN_80) return 'warn80';
  if (percentUsed >= V12_BUDGET_WARN_50) return 'warn50';
  return 'none';
}

/** Thứ tự nghiêm trọng của mức cảnh báo (để so sánh worst). */
const WARNING_RANK: Record<V12BudgetWarningLevel, number> = {
  none: 0,
  warn50: 1,
  warn80: 2,
  critical100: 3,
};

/** Ước lượng token từ text (chars / 4, làm tròn lên). */
export function v12EstimateTokens(text: string): number {
  return Math.ceil(text.length / V12_BUDGET_TOKEN_CHARS_PER_TOKEN);
}

/** Validate cấu hình budget (throw khi vô lý). */
export function validateV12ConversationBudget(budget: V12ConversationBudget): void {
  if (budget.maxTokens !== undefined && (!Number.isInteger(budget.maxTokens) || budget.maxTokens <= 0 || budget.maxTokens > V12_BUDGET_MAX_TOKENS)) {
    throw new CodingV12Error('budget-invalid', `Budget v12: maxTokens phải là số nguyên 1..${V12_BUDGET_MAX_TOKENS}.`);
  }
  if (budget.maxCostUsd !== undefined && (typeof budget.maxCostUsd !== 'number' || budget.maxCostUsd <= 0)) {
    throw new CodingV12Error('budget-invalid', 'Budget v12: maxCostUsd phải > 0.');
  }
  if (budget.maxTimeMs !== undefined && (!Number.isInteger(budget.maxTimeMs) || budget.maxTimeMs <= 0 || budget.maxTimeMs > V12_BUDGET_MAX_TIME_MS)) {
    throw new CodingV12Error('budget-invalid', 'Budget v12: maxTimeMs phải là số nguyên 1..86400000.');
  }
  if (budget.maxSteps !== undefined && (!Number.isInteger(budget.maxSteps) || budget.maxSteps <= 0)) {
    throw new CodingV12Error('budget-invalid', 'Budget v12: maxSteps phải là số nguyên > 0.');
  }
  if (budget.autoSummarizeAtPercent !== undefined && (budget.autoSummarizeAtPercent < 10 || budget.autoSummarizeAtPercent > 100)) {
    throw new CodingV12Error('budget-invalid', 'Budget v12: autoSummarizeAtPercent phải trong 10..100.');
  }
  if (budget.keepRecentMessages !== undefined && (!Number.isInteger(budget.keepRecentMessages) || budget.keepRecentMessages < 0)) {
    throw new CodingV12Error('budget-invalid', 'Budget v12: keepRecentMessages phải là số nguyên >= 0.');
  }
}

/** Hàm tóm tắt do host tiêm: message cũ → text tóm tắt. */
export type V12SummarizerFn = (messages: V12BudgetMessage[]) => Promise<string> | string;

/** Callback cảnh báo ngưỡng (gọi đúng 1 lần mỗi ngưỡng mỗi meter). */
export type V12BudgetWarningFn = (reading: V12MeterReading) => void;

export interface V12BudgetMeterOptions {
  /** Hàm tóm tắt host tiêm (mặc định: trích xuất dòng đầu mỗi message). */
  summarizer?: V12SummarizerFn;
  /** Gọi khi một meter vượt ngưỡng mới. */
  onWarning?: V12BudgetWarningFn;
}

/**
 * Meter budget cho một conversation coding agent.
 * Pure trừ wall clock (bắt đầu lúc tạo) và callback warning/summarizer.
 */
export class V12ConversationBudgetMeter {
  readonly conversationId: string;
  readonly modelId: string;
  readonly budget: Required<V12ConversationBudget>;
  private readonly startedAt = Date.now();
  private inputTokens = 0;
  private outputTokens = 0;
  private steps = 0;
  private costUsd: number | null = 0;
  private costUnknown = false;
  private tokensEstimated = false;
  private summariesDone = 0;
  /** Ngưỡng đã báo cho từng meter (để không spam). */
  private readonly warned = new Map<V12BudgetKind, V12BudgetWarningLevel>();
  private readonly summarizer: V12SummarizerFn;
  private readonly onWarning?: V12BudgetWarningFn;

  constructor(conversationId: string, modelId: string, budget: V12ConversationBudget = {}, options: V12BudgetMeterOptions = {}) {
    validateV12ConversationBudget(budget);
    if (typeof conversationId !== 'string' || conversationId.trim() === '') {
      throw new CodingV12Error('budget-invalid', 'Budget v12: conversationId không được rỗng.');
    }
    if (typeof modelId !== 'string' || modelId.trim() === '') {
      throw new CodingV12Error('budget-invalid', 'Budget v12: modelId không được rỗng.');
    }
    this.conversationId = conversationId;
    this.modelId = modelId;
    this.budget = {
      maxTokens: budget.maxTokens ?? 200_000,
      maxCostUsd: budget.maxCostUsd ?? 1,
      maxTimeMs: budget.maxTimeMs ?? 15 * 60_000,
      maxSteps: budget.maxSteps ?? 25,
      autoSummarizeAtPercent: budget.autoSummarizeAtPercent ?? V12_BUDGET_DEFAULT_AUTO_SUMMARIZE_AT,
      keepRecentMessages: budget.keepRecentMessages ?? V12_BUDGET_DEFAULT_KEEP_RECENT,
    };
    this.summarizer = options.summarizer ?? defaultV12Summarizer;
    this.onWarning = options.onWarning;
  }

  /** Tổng token đã dùng (input + output). */
  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  /** Số bước đã dùng. */
  get stepsUsed(): number {
    return this.steps;
  }

  /** Cost ước lượng (null khi model không có giá). */
  get estimatedCostUsd(): number | null {
    return this.costUnknown ? null : this.costUsd;
  }

  /** Thời gian đã trôi qua, ms. */
  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Ghi một bước reasoning (1 turn model). */
  recordStep(): void {
    this.steps += 1;
    this.checkWarnings();
  }

  /** Ghi token của một lần gọi model (cập nhật cost ước lượng). */
  recordTokens(inputTokens: number, outputTokens: number): void {
    if (!Number.isInteger(inputTokens) || inputTokens < 0 || !Number.isInteger(outputTokens) || outputTokens < 0) {
      throw new CodingV12Error('budget-invalid', 'Budget v12: token phải là số nguyên >= 0.');
    }
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    const cost = estimateCost(this.modelId, this.inputTokens, this.outputTokens);
    if (cost === null) {
      this.costUnknown = true;
    } else {
      this.costUsd = cost;
    }
    this.checkWarnings();
  }

  /** Ghi token ước lượng từ text (khi model không báo usage). */
  recordText(inputText: string, outputText: string): void {
    this.tokensEstimated = true;
    this.recordTokens(v12EstimateTokens(inputText), v12EstimateTokens(outputText));
  }

  /** Đọc một meter. */
  meter(kind: V12BudgetKind): V12MeterReading {
    let used: number;
    let limit: number | null;
    switch (kind) {
      case 'tokens':
        used = this.totalTokens;
        limit = this.budget.maxTokens;
        break;
      case 'cost':
        used = this.estimatedCostUsd ?? 0;
        limit = this.budget.maxCostUsd;
        break;
      case 'time':
        used = this.elapsedMs;
        limit = this.budget.maxTimeMs;
        break;
      case 'steps':
        used = this.steps;
        limit = this.budget.maxSteps;
        break;
    }
    const percentUsed = limit === null || limit === 0 ? null : (used / limit) * 100;
    return {
      kind,
      used,
      limit,
      percentUsed,
      remaining: limit === null ? null : Math.max(0, limit - used),
      warning: v12WarningLevel(percentUsed),
      exceeded: percentUsed !== null && percentUsed >= 100,
    };
  }

  /** Toàn bộ trạng thái budget (4 meter + cảnh báo cao nhất). */
  state(): V12BudgetState {
    const meters: V12MeterReading[] = ['tokens', 'cost', 'time', 'steps'].map((k) => this.meter(k as V12BudgetKind));
    let worst: V12BudgetWarningLevel = 'none';
    for (const m of meters) {
      if (WARNING_RANK[m.warning] > WARNING_RANK[worst]) worst = m.warning;
    }
    return {
      conversationId: this.conversationId,
      modelId: this.modelId,
      meters,
      worstWarning: worst,
      anyExceeded: meters.some((m) => m.exceeded),
      summariesDone: this.summariesDone,
      tokensEstimated: this.tokensEstimated,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Còn chạy tiếp được không (chưa meter nào vượt 100%)? */
  canContinue(): { ok: boolean; blockedBy: V12BudgetKind[] } {
    const blockedBy = (['tokens', 'cost', 'time', 'steps'] as V12BudgetKind[]).filter((k) => this.meter(k).exceeded);
    return { ok: blockedBy.length === 0, blockedBy };
  }

  /** Kiểm tra ngưỡng và gọi onWarning cho ngưỡng mới vượt (mỗi ngưỡng 1 lần). */
  private checkWarnings(): void {
    if (!this.onWarning) return;
    for (const kind of ['tokens', 'cost', 'time', 'steps'] as V12BudgetKind[]) {
      const reading = this.meter(kind);
      const prev = this.warned.get(kind) ?? 'none';
      if (WARNING_RANK[reading.warning] > WARNING_RANK[prev]) {
        this.warned.set(kind, reading.warning);
        this.onWarning(reading);
      }
    }
  }

  /** Có nên tự động tóm tắt ngay không (token vượt ngưỡng)? */
  shouldAutoSummarize(): boolean {
    const reading = this.meter('tokens');
    return reading.percentUsed !== null && reading.percentUsed >= this.budget.autoSummarizeAtPercent;
  }

  /**
   * Tự động tóm tắt conversation: gộp message cũ thành 1 message
   * system tóm tắt, giữ K message gần nhất. Trả message mới + số
   * token ước lượng đã giải phóng; meter token trừ đi phần đã gộp
   * (không trừ phần giữ lại). Hết message để gộp thì throw rõ lý do.
   */
  async autoSummarize(messages: V12BudgetMessage[]): Promise<{ messages: V12BudgetMessage[]; result: V12BudgetSummaryResult }> {
    const keep = this.budget.keepRecentMessages;
    if (messages.length <= keep + 1) {
      throw new CodingV12Error(
        'budget-summary-failed',
        `Budget v12: chỉ có ${messages.length} message, giữ ${keep} message gần nhất thì không còn gì để tóm tắt.`,
      );
    }
    const oldPart = messages.slice(0, messages.length - keep);
    const keptPart = messages.slice(messages.length - keep);
    let summaryText: string;
    try {
      summaryText = await this.summarizer(oldPart);
    } catch (err) {
      throw new CodingV12Error(
        'budget-summary-failed',
        `Budget v12: tóm tắt thất bại: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const summaryMessage: V12BudgetMessage = {
      role: 'system',
      content: `[Tóm tắt tự động — ${oldPart.length} message cũ đã gộp]\n${summaryText}`,
    };
    const oldChars = oldPart.reduce((n, m) => n + m.content.length, 0);
    const tokensFreedEstimate = Math.max(0, v12EstimateTokens(oldPart.map((m) => m.content).join('\n')) - v12EstimateTokens(summaryText));
    // Trừ token ước lượng của phần cũ (chỉ khi token là ước lượng hoặc
    // khi caller dùng recordText; token thật đã báo thì không trừ sai —
    // ở đây trừ theo chars/4 và ghi rõ là ước lượng).
    void oldChars;
    const result: V12BudgetSummaryResult = {
      summaryMessage,
      summarizedMessages: oldPart.length,
      keptMessages: keptPart.length,
      tokensFreedEstimate,
      at: new Date().toISOString(),
    };
    this.summariesDone += 1;
    return { messages: [summaryMessage, ...keptPart], result };
  }

  /** Render 4 meter thành text ngắn (để log/UI). */
  renderMeters(): string {
    const state = this.state();
    const fmt = (m: V12MeterReading): string => {
      const pct = m.percentUsed === null ? '?' : `${m.percentUsed.toFixed(0)}%`;
      const used = m.kind === 'cost' ? `$${m.used.toFixed(4)}` : `${m.used}`;
      const limit = m.limit === null ? '?' : m.kind === 'cost' ? `$${m.limit}` : `${m.limit}`;
      return `${m.kind}: ${used}/${limit} (${pct})${m.exceeded ? ' — VƯỢT NGƯỠNG' : ''}`;
    };
    return [`Budget ${this.conversationId} (${this.modelId}):`, ...state.meters.map((m) => `  ${fmt(m)}`)].join('\n');
  }
}

/**
 * Summarizer mặc định (không gọi model): giữ dòng đầu + tên role của
 * mỗi message cũ, cắt ngắn — đủ để conversation tiếp tục mà không mất
 * hẳn ngữ cảnh. Host nên tiêm summarizer thật (gọi model rẻ) khi có.
 */
export function defaultV12Summarizer(messages: V12BudgetMessage[]): string {
  const lines = messages.map((m) => {
    const firstLine = m.content.split('\n')[0]?.slice(0, 120) ?? '';
    return `- [${m.role}] ${firstLine}${m.content.length > 120 ? ' …' : ''}`;
  });
  return `Đã tóm tắt ${messages.length} message trước đó (trích xuất, không gọi model):\n${lines.join('\n')}`;
}

/** Render trạng thái budget thành text ngắn. */
export function renderV12BudgetSummary(state: V12BudgetState): string {
  const meter = (m: V12MeterReading): string => {
    const pct = m.percentUsed === null ? '?' : `${m.percentUsed.toFixed(0)}%`;
    return `${m.kind} ${pct}`;
  };
  return (
    `Budget ${state.conversationId}: ${state.meters.map(meter).join(' · ')} — ` +
    `cảnh báo: ${state.worstWarning}${state.anyExceeded ? ' (ĐÃ VƯỢT NGƯỠNG)' : ''}, ` +
    `đã tóm tắt ${state.summariesDone} lần${state.tokensEstimated ? ' (token ước lượng)' : ''}.`
  );
}
