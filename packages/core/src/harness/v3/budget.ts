/**
 * Conversation budget meter (v1.07, Đội T2) — token + chi phí + thời gian.
 *
 * Ý tưởng học từ survey v1.07 phần 1 (OpenHands v1.38 conversation
 * budget meters — chỉ học ý tưởng, không copy code/text/tài sản của
 * repo nào): ngân sách hội thoại hiển thị bằng meter ngữ nghĩa trong
 * chat, cảnh báo khi gần hết.
 *
 * Nối tiếp, không viết lại: token + chi phí DÙNG LẠI
 * `ConversationBudgetMeter` của `risk/budget.ts` (v1.01, đã có bảng
 * giá, warn 80%, alert một lần mỗi ngưỡng) — module này chỉ THÊM
 * chiều thời gian (maxMs: turn chạy tối đa bao lâu) + ngưỡng cảnh
 * báo 2 mức (70% nhắc, 90% gấp) + render một dòng meter cho chat.
 * Không nhân đôi logic đếm token/cost.
 *
 * Trạng thái: 'ok' (< 70% mọi cap) | 'warning' (≥ 70% một cap) |
 * 'critical' (≥ 90% một cap) | 'exceeded' (chạm/vượt một cap).
 * `record()` trả snapshot mới; host (Conversation) đọc
 * `snapshot().status` trước mỗi step và dừng turn khi 'exceeded'.
 * Cảnh báo chỉ bắn một lần mỗi mức (warned/critical/exceeded) qua
 * callback `onAlert` — chat không bị spam mỗi lần record.
 */

import { ConversationBudgetMeter, DEFAULT_BUDGET_WARN_RATIO } from '../../risk/budget';
import type { BudgetSnapshot } from '../../risk/types';

export const V3_BUDGET_WARN_RATIO = 0.7;
export const V3_BUDGET_CRITICAL_RATIO = 0.9;

export type V3BudgetStatus = 'ok' | 'warning' | 'critical' | 'exceeded';

/** Snapshot meter của một conversation (để UI + EventLog dùng chung). */
export interface V3BudgetSnapshot {
  conversationId: string;
  /** Token + cost (từ ConversationBudgetMeter của risk). */
  tokens: BudgetSnapshot;
  /** Thời gian đã chạy từ lúc start() (ms). */
  elapsedMs: number;
  /** Giới hạn thời gian (ms) — null = không giới hạn. */
  timeLimitMs: number | null;
  /** % thời gian đã dùng (null khi không giới hạn). */
  timePercentUsed: number | null;
  /** % lớn nhất trong 3 chiều token/cost/thời gian (null khi không có cap nào). */
  percentUsed: number | null;
  status: V3BudgetStatus;
  /** Cảnh báo đang hiệu lực (rỗng khi ok). */
  warnings: string[];
}

export interface V3BudgetMeterOptions {
  /** Token tối đa cho conversation (<= 0 / không set = không cap). */
  tokenLimit?: number;
  /** Chi phí tối đa (USD) cho conversation. */
  costLimitUsd?: number;
  /** Thời gian tối đa (ms) cho conversation. */
  timeLimitMs?: number;
  /** Ngưỡng warning (mặc định 0.7). */
  warnAtRatio?: number;
  /** Ngưỡng critical (mặc định 0.9). */
  criticalAtRatio?: number;
  /** Model mặc định để tính cost khi record không báo model. */
  model?: string;
  /** Callback mỗi lần vượt một ngưỡng mới (mỗi mức tối đa một lần). */
  onAlert?: (snapshot: V3BudgetSnapshot) => void;
  /** Đồng hồ (mặc định Date.now) — test truyền đồng hồ giả. */
  now?: () => number;
}

/**
 * Meter ngân sách hội thoại: token + cost (ủy quyền cho risk meter)
 * + thời gian (tự đếm từ start()). Một meter cho một conversation;
 * conversation mới thì tạo meter mới.
 */
export class V3BudgetMeter {
  private readonly conversationId: string;
  private readonly inner: ConversationBudgetMeter;
  private readonly timeLimitMs: number | null;
  private readonly warnAtRatio: number;
  private readonly criticalAtRatio: number;
  private readonly onAlert?: (snapshot: V3BudgetSnapshot) => void;
  private readonly now: () => number;
  private startedAtMs: number | null = null;
  private lastStatus: V3BudgetStatus = 'ok';

  constructor(conversationId: string, options: V3BudgetMeterOptions = {}) {
    if (typeof conversationId !== 'string' || conversationId.trim() === '') {
      throw new Error('V3BudgetMeter cần conversationId không rỗng.');
    }
    this.conversationId = conversationId;
    this.timeLimitMs =
      options.timeLimitMs !== undefined && Number.isFinite(options.timeLimitMs) && options.timeLimitMs > 0
        ? Math.floor(options.timeLimitMs)
        : null;
    const warn =
      options.warnAtRatio !== undefined && Number.isFinite(options.warnAtRatio)
        ? options.warnAtRatio
        : V3_BUDGET_WARN_RATIO;
    const critical =
      options.criticalAtRatio !== undefined && Number.isFinite(options.criticalAtRatio)
        ? options.criticalAtRatio
        : V3_BUDGET_CRITICAL_RATIO;
    if (warn <= 0 || warn >= 1 || critical <= 0 || critical >= 1 || critical <= warn) {
      throw new Error(
        `V3BudgetMeter cần 0 < warnAtRatio < criticalAtRatio < 1 (nhận ${warn} / ${critical}).`,
      );
    }
    this.warnAtRatio = warn;
    this.criticalAtRatio = critical;
    this.onAlert = options.onAlert;
    this.now = options.now ?? Date.now;
    this.inner = new ConversationBudgetMeter(
      conversationId,
      {
        ...(options.tokenLimit !== undefined ? { tokenLimit: options.tokenLimit } : {}),
        ...(options.costLimitUsd !== undefined ? { costLimitUsd: options.costLimitUsd } : {}),
        warnAtRatio: DEFAULT_BUDGET_WARN_RATIO,
        ...(options.model !== undefined ? { model: options.model } : {}),
      },
    );
  }

  /** Bắt đầu đếm thời gian (gọi khi turn/conversation bắt đầu). */
  start(): void {
    if (this.startedAtMs === null) this.startedAtMs = this.now();
  }

  /** Thời gian đã chạy (ms, 0 khi chưa start). */
  elapsedMs(): number {
    return this.startedAtMs === null ? 0 : Math.max(0, this.now() - this.startedAtMs);
  }

  /**
   * Ghi một lần gọi model. Trả snapshot mới. Token âm → 0 (theo risk
   * meter). Model chưa có giá → cost null, không báo $0 giả.
   */
  record(model: string, inputTokens: number, outputTokens: number): V3BudgetSnapshot {
    this.start();
    this.inner.record(model, inputTokens, outputTokens);
    return this.snapshot();
  }

  /** Snapshot hiện tại (không ghi thêm usage). */
  snapshot(): V3BudgetSnapshot {
    const tokens = this.inner.snapshot();
    const elapsed = this.elapsedMs();
    const timePercentUsed =
      this.timeLimitMs === null ? null : (elapsed / this.timeLimitMs) * 100;
    const percents = [tokens.percentUsed, timePercentUsed].filter(
      (p): p is number => p !== null,
    );
    const percentUsed = percents.length === 0 ? null : Math.max(...percents);
    const timeExceeded = timePercentUsed !== null && timePercentUsed >= 100;
    let status: V3BudgetStatus;
    if (tokens.status === 'exceeded' || timeExceeded) status = 'exceeded';
    else if (percentUsed !== null && percentUsed >= this.criticalAtRatio * 100) status = 'critical';
    else if (percentUsed !== null && percentUsed >= this.warnAtRatio * 100) status = 'warning';
    else status = 'ok';
    const warnings: string[] = [];
    if (tokens.tokenPercentUsed !== null && tokens.tokenPercentUsed >= this.warnAtRatio * 100) {
      warnings.push(
        `Token đã dùng ${Math.round(tokens.tokenPercentUsed)}% (giới hạn ${tokens.tokenLimit?.toLocaleString('en-US')} token).`,
      );
    }
    if (tokens.costPercentUsed !== null && tokens.costPercentUsed >= this.warnAtRatio * 100) {
      warnings.push(
        `Chi phí đã dùng ${Math.round(tokens.costPercentUsed)}% (giới hạn $${tokens.costLimitUsd}).`,
      );
    }
    if (timePercentUsed !== null && timePercentUsed >= this.warnAtRatio * 100) {
      warnings.push(
        `Thời gian đã dùng ${Math.round(timePercentUsed)}% (giới hạn ${formatDuration(this.timeLimitMs ?? 0)}).`,
      );
    }
    if (status === 'exceeded') {
      warnings.push('Đã vượt ngân sách — turn sẽ dừng.');
    }
    const snapshot: V3BudgetSnapshot = {
      conversationId: this.conversationId,
      tokens,
      elapsedMs: elapsed,
      timeLimitMs: this.timeLimitMs,
      timePercentUsed,
      percentUsed,
      status,
      warnings,
    };
    // Alert một lần mỗi lần trạng thái XẤU ĐI (ok → warning → critical
    // → exceeded); trạng thái tốt lên (không xảy ra khi chỉ cộng dồn)
    // thì không bắn lại.
    const order: Record<V3BudgetStatus, number> = { ok: 0, warning: 1, critical: 2, exceeded: 3 };
    if (order[status] > order[this.lastStatus]) {
      this.lastStatus = status;
      this.onAlert?.(snapshot);
    }
    return snapshot;
  }

  /** True khi đã vượt một cap (token/cost/thời gian). */
  get isExceeded(): boolean {
    return this.snapshot().status === 'exceeded';
  }
}

/** Định dạng ms thành "1m 30s" / "45s" / "800ms" cho chat. */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  if (safe < 1_000) return `${safe}ms`;
  const totalSeconds = Math.floor(safe / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Render một dòng meter cho chat (vd dưới message cuối):
 * `Ngân sách: 42% · 12.400 token · $0.03 · 1m 10s — gần hết token (70%).`
 * Không có cap nào → chỉ đếm (không có %).
 */
export function formatBudgetMeterLine(snapshot: V3BudgetSnapshot): string {
  const tokens = snapshot.tokens;
  const parts = [
    `Ngân sách: ${snapshot.percentUsed === null ? 'không giới hạn' : `${Math.round(snapshot.percentUsed)}%`}`,
    `${tokens.totalTokens.toLocaleString('en-US')} token`,
    tokens.costUsd === null
      ? tokens.hasUnknownCost
        ? 'chi phí ?'
        : '$0.00'
      : `$${tokens.costUsd.toFixed(4)}`,
    formatDuration(snapshot.elapsedMs),
  ];
  const statusText =
    snapshot.status === 'exceeded'
      ? ' — đã vượt ngân sách'
      : snapshot.status === 'critical'
        ? ' — sắp hết ngân sách'
        : snapshot.status === 'warning'
          ? ' — gần hết ngân sách'
          : '';
  const warningText =
    snapshot.warnings.length > 0 ? ` (${snapshot.warnings.join(' ')})` : '';
  return `${parts.join(' · ')}${statusText}${warningText}`;
}
