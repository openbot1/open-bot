/**
 * Coding agent v15 — budget meter CHỈ-BÁO-CÁO (report-only).
 *
 * Điểm khác biệt duy nhất và quan trọng nhất so với limiter: meter
 * này KHÔNG BAO GIỜ chặn run. Vượt cap token hay cap cost thì run
 * vẫn chạy tiếp; meter chỉ ghi nhận, tính phần trăm, phát cảnh báo
 * 80% / 100% (mỗi ngưỡng một lần mỗi run) và báo cáo. Người dùng
 * nhìn meter để quyết định dừng bằng tay — máy không tự dừng hộ.
 *
 * - Một meter giữ state cho nhiều run (key theo runId), lịch sử theo
 *   run/bot để UI vẽ tổng tiêu thụ.
 * - Cost ước lượng qua bảng giá chung `usage/pricing`; model không
 *   có giá thì cost = null (không bao giờ báo $0 giả). Host biết
 *   chắc chắn chi phí (vd model local miễn phí) thì truyền costUsd
 *   rõ ràng.
 * - Token khi model không báo thì ước lượng chars/4 — đánh dấu
 *   `tokensEstimated: true` để report nói rõ là ước lượng.
 */

import { estimateCost } from '../usage/pricing';
import { CodingV15Error } from './types';
import type {
  V15BudgetCap,
  V15BudgetHistoryEntry,
  V15BudgetReport,
  V15BudgetState,
  V15BudgetWarning,
  V15BudgetWarningLevel,
  V15NewUsage,
  V15UsageRecord,
} from './types';

/** Hệ số ước lượng token khi model không báo (chars / 4). */
export const V15_BUDGET_TOKEN_CHARS_PER_TOKEN = 4;

/** Ngưỡng cảnh báo mặc định (phần trăm). */
export const V15_BUDGET_WARN_80 = 80;
export const V15_BUDGET_WARN_100 = 100;

/** Giới hạn cứng để tránh cấu hình vô lý. */
export const V15_BUDGET_MAX_TOKENS = 10_000_000;
export const V15_BUDGET_MAX_COST_USD = 10_000;

/** Ghi chú report-only — xuất hiện trong mọi report để không ai nhầm với limiter. */
export const V15_BUDGET_REPORT_ONLY_NOTE =
  'Report-only meter: exceeding the cap never stops a run. Warnings are advisory; the user decides whether to stop.';

/** Validate cap (throw khi vô lý). */
export function v15ValidateBudgetCap(cap: V15BudgetCap): void {
  if (!cap || typeof cap !== 'object') {
    throw new CodingV15Error('budget-invalid', 'Budget cap phải là object.');
  }
  if (cap.maxTokens !== undefined) {
    if (!Number.isInteger(cap.maxTokens) || cap.maxTokens <= 0 || cap.maxTokens > V15_BUDGET_MAX_TOKENS) {
      throw new CodingV15Error('budget-invalid', `Budget maxTokens phải là số nguyên 1..${V15_BUDGET_MAX_TOKENS}.`);
    }
  }
  if (cap.maxCostUsd !== undefined) {
    if (typeof cap.maxCostUsd !== 'number' || Number.isNaN(cap.maxCostUsd) || cap.maxCostUsd <= 0 || cap.maxCostUsd > V15_BUDGET_MAX_COST_USD) {
      throw new CodingV15Error('budget-invalid', `Budget maxCostUsd phải là số > 0 và <= ${V15_BUDGET_MAX_COST_USD}.`);
    }
  }
}

/** Ước lượng token từ số ký tự (khi model không báo token). */
export function v15EstimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / V15_BUDGET_TOKEN_CHARS_PER_TOKEN));
}

/** Tính phần trăm đã dùng (null khi không có cap). */
export function v15BudgetPercent(used: number, cap: number | undefined): number | null {
  if (cap === undefined || cap <= 0) return null;
  return (used / cap) * 100;
}

/** Định dạng USD ngắn gọn (4 chữ số thập phân cho số nhỏ). */
export function v15FormatUsd(cost: number | null): string {
  if (cost === null) return 'unknown';
  if (cost === 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** Định dạng phần trăm (null = không có cap). */
export function v15FormatPercent(percent: number | null): string {
  if (percent === null) return 'no cap';
  return `${percent.toFixed(1)}%`;
}

function warningMessage(level: V15BudgetWarningLevel, dimension: 'tokens' | 'cost', percent: number): string {
  if (level === 'warn80') {
    return dimension === 'tokens'
      ? `Token usage reached ${percent.toFixed(1)}% of the cap (80% threshold). The run keeps going — this is a report-only warning.`
      : `Estimated cost reached ${percent.toFixed(1)}% of the cap (80% threshold). The run keeps going — this is a report-only warning.`;
  }
  return dimension === 'tokens'
    ? `Token usage exceeded the cap (${percent.toFixed(1)}%). The run keeps going — the meter reports, it never blocks.`
    : `Estimated cost exceeded the cap (${percent.toFixed(1)}%). The run keeps going — the meter reports, it never blocks.`;
}

/** Kết quả của một lần ghi nhận: luôn allowed=true + cảnh báo mới (nếu có). */
export interface V15BudgetRecordResult {
  /** Luôn true — meter báo cáo, không chặn. */
  allowed: true;
  /** Cảnh báo mới phát ở lần ghi này (rỗng khi chưa chạm ngưỡng mới). */
  newWarnings: V15BudgetWarning[];
  /** State mới nhất của run. */
  state: V15BudgetState;
  /** true khi lần ghi này làm run vượt cap. */
  crossedCap: boolean;
}

interface V15RunBucket {
  state: V15BudgetState;
  records: V15UsageRecord[];
  /** Ngưỡng đã phát: `tokens:80`, `tokens:100`, `cost:80`, `cost:100`. */
  fired: Set<string>;
}

/**
 * Budget meter report-only cho coding agent v15.
 *
 * Dùng: tạo một meter cho một bot (hoặc một phiên), gọi `record()`
 * sau mỗi lần gọi model / mỗi step, đọc `state()` / `report()` để
 * vẽ UI, đọc `history()` để xem tiêu thụ theo run.
 */
export class CodingV15BudgetMeter {
  private readonly botId: string;
  private readonly cap: V15BudgetCap;
  private readonly buckets = new Map<string, V15RunBucket>();
  private readonly nowFn: () => string;

  constructor(botId: string, cap: V15BudgetCap = {}, options: { now?: () => string } = {}) {
    if (typeof botId !== 'string' || botId.trim().length === 0) {
      throw new CodingV15Error('budget-invalid', 'Budget meter cần botId không rỗng.');
    }
    v15ValidateBudgetCap(cap);
    this.botId = botId;
    this.cap = { ...cap };
    this.nowFn = options.now ?? (() => new Date().toISOString());
  }

  getBotId(): string {
    return this.botId;
  }

  getCap(): V15BudgetCap {
    return { ...this.cap };
  }

  private bucketFor(runId: string, profileId: string, model: string): V15RunBucket {
    let bucket = this.buckets.get(runId);
    if (!bucket) {
      bucket = {
        state: {
          runId,
          botId: this.botId,
          profileId,
          model,
          cap: { ...this.cap },
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: null,
          tokensEstimated: false,
          tokensPercent: null,
          costPercent: null,
          overCap: false,
          warnings: [],
          records: 0,
        },
        records: [],
        fired: new Set<string>(),
      };
      this.buckets.set(runId, bucket);
    }
    return bucket;
  }

  private checkThresholds(bucket: V15RunBucket, at: string): V15BudgetWarning[] {
    const fresh: V15BudgetWarning[] = [];
    const s = bucket.state;
    const dims: { dimension: 'tokens' | 'cost'; percent: number | null }[] = [
      { dimension: 'tokens', percent: s.tokensPercent },
      { dimension: 'cost', percent: s.costPercent },
    ];
    for (const { dimension, percent } of dims) {
      if (percent === null) continue;
      for (const threshold of [V15_BUDGET_WARN_80, V15_BUDGET_WARN_100] as const) {
        const key = `${dimension}:${threshold}`;
        if (percent >= threshold && !bucket.fired.has(key)) {
          bucket.fired.add(key);
          const level: V15BudgetWarningLevel = threshold === 80 ? 'warn80' : 'over100';
          const warning: V15BudgetWarning = {
            level,
            dimension,
            percent,
            message: warningMessage(level, dimension, percent),
            at,
          };
          s.warnings.push(warning);
          fresh.push(warning);
        }
      }
    }
    return fresh;
  }

  /**
   * Ghi nhận một lần tiêu thụ. LUÔN trả allowed=true — vượt cap vẫn
   * chạy, chỉ thêm cảnh báo. Không bao giờ throw vì vượt cap.
   */
  record(usage: V15NewUsage): V15BudgetRecordResult {
    if (!usage || typeof usage !== 'object') {
      throw new CodingV15Error('budget-record-invalid', 'Usage record phải là object.');
    }
    if (typeof usage.runId !== 'string' || usage.runId.trim().length === 0) {
      throw new CodingV15Error('budget-record-invalid', 'Usage record cần runId không rỗng.');
    }
    if (typeof usage.model !== 'string' || usage.model.trim().length === 0) {
      throw new CodingV15Error('budget-record-invalid', 'Usage record cần model không rỗng.');
    }
    for (const [field, value] of [['inputTokens', usage.inputTokens], ['outputTokens', usage.outputTokens]] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new CodingV15Error('budget-record-invalid', `Usage ${field} phải là số nguyên >= 0.`);
      }
    }
    const at = usage.at ?? this.nowFn();
    const profileId = usage.profileId ?? '';
    const botId = usage.botId ?? this.botId;
    const bucket = this.bucketFor(usage.runId, profileId, usage.model);
    const s = bucket.state;
    // Cập nhật bot/profile/model hiển thị theo record mới nhất (run có thể đổi model giữa chừng).
    s.profileId = profileId;
    s.model = usage.model;
    const wasOverCap = s.overCap;
    let costUsd: number | null;
    if (usage.costUsd !== undefined) {
      if (usage.costUsd !== null && (typeof usage.costUsd !== 'number' || Number.isNaN(usage.costUsd) || usage.costUsd < 0)) {
        throw new CodingV15Error('budget-record-invalid', 'Usage costUsd phải là số >= 0 hoặc null.');
      }
      costUsd = usage.costUsd;
    } else {
      costUsd = estimateCost(usage.model, usage.inputTokens, usage.outputTokens);
    }
    const record: V15UsageRecord = {
      runId: usage.runId,
      botId,
      profileId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      tokensEstimated: usage.tokensEstimated ?? false,
      step: usage.step ?? s.records,
      at,
    };
    bucket.records.push(record);
    s.inputTokens += usage.inputTokens;
    s.outputTokens += usage.outputTokens;
    s.totalTokens = s.inputTokens + s.outputTokens;
    if (costUsd !== null) s.costUsd = (s.costUsd ?? 0) + costUsd;
    if (record.tokensEstimated) s.tokensEstimated = true;
    s.tokensPercent = v15BudgetPercent(s.totalTokens, this.cap.maxTokens);
    s.costPercent = s.costUsd === null ? null : v15BudgetPercent(s.costUsd, this.cap.maxCostUsd);
    s.overCap =
      (s.tokensPercent !== null && s.tokensPercent >= 100) ||
      (s.costPercent !== null && s.costPercent >= 100);
    s.records = bucket.records.length;
    const newWarnings = this.checkThresholds(bucket, at);
    return {
      allowed: true,
      newWarnings,
      state: this.snapshotState(s),
      crossedCap: s.overCap && !wasOverCap,
    };
  }

  private snapshotState(s: V15BudgetState): V15BudgetState {
    return { ...s, cap: { ...s.cap }, warnings: s.warnings.map((w) => ({ ...w })) };
  }

  /** State hiện tại của một run (null khi chưa có record nào). */
  state(runId: string): V15BudgetState | null {
    const bucket = this.buckets.get(runId);
    return bucket ? this.snapshotState(bucket.state) : null;
  }

  /** Báo cáo đầy đủ của một run. */
  report(runId: string): V15BudgetReport {
    const bucket = this.buckets.get(runId);
    if (!bucket) {
      throw new CodingV15Error('budget-record-invalid', `Không có dữ liệu budget cho run "${runId}".`);
    }
    const s = this.snapshotState(bucket.state);
    return {
      runId,
      botId: s.botId,
      profileId: s.profileId,
      model: s.model,
      state: s,
      reportOnlyNote: V15_BUDGET_REPORT_ONLY_NOTE,
      summary: renderV15BudgetSummary(s),
    };
  }

  /** Lịch sử tiêu thụ theo run (mới nhất trước). */
  history(): V15BudgetHistoryEntry[] {
    return [...this.buckets.values()]
      .map((b) => {
        const first = b.records[0];
        const last = b.records[b.records.length - 1];
        return {
          runId: b.state.runId,
          botId: b.state.botId,
          profileId: b.state.profileId,
          model: b.state.model,
          totalTokens: b.state.totalTokens,
          costUsd: b.state.costUsd,
          overCap: b.state.overCap,
          records: b.records.length,
          firstAt: first?.at ?? '',
          lastAt: last?.at ?? '',
        } satisfies V15BudgetHistoryEntry;
      })
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  }

  /** Lịch sử chỉ của một bot (meter này đã gắn một bot; lọc thêm khi cần). */
  historyForBot(botId: string): V15BudgetHistoryEntry[] {
    return this.history().filter((h) => h.botId === botId);
  }

  /** Tổng tiêu thụ toàn bộ run trong meter. */
  totals(): { runs: number; totalTokens: number; costUsd: number | null; overCapRuns: number } {
    let totalTokens = 0;
    let costUsd: number | null = null;
    let overCapRuns = 0;
    for (const b of this.buckets.values()) {
      totalTokens += b.state.totalTokens;
      if (b.state.costUsd !== null) costUsd = (costUsd ?? 0) + b.state.costUsd;
      if (b.state.overCap) overCapRuns += 1;
    }
    return { runs: this.buckets.size, totalTokens, costUsd, overCapRuns };
  }

  /** Tất cả record thô của một run (bản copy). */
  recordsForRun(runId: string): V15UsageRecord[] {
    const bucket = this.buckets.get(runId);
    return bucket ? bucket.records.map((r) => ({ ...r })) : [];
  }

  /** Xóa state của một run (giữ lại history thì caller tự snapshot trước). */
  clearRun(runId: string): boolean {
    return this.buckets.delete(runId);
  }
}

/** Tóm tắt một dòng của state budget. */
export function renderV15BudgetSummary(state: V15BudgetState): string {
  const tokens = `${state.totalTokens.toLocaleString('en-US')} tokens (${v15FormatPercent(state.tokensPercent)} of cap)`;
  const cost = `${v15FormatUsd(state.costUsd)} (${v15FormatPercent(state.costPercent)} of cap)`;
  const flag = state.overCap ? ' — OVER CAP (report-only, run continues)' : '';
  const est = state.tokensEstimated ? ' (tokens estimated)' : '';
  return `Run ${state.runId}: ${tokens}, ${cost}${est}${flag}`;
}

/** Render báo cáo budget nhiều dòng (cho tool output / log). */
export function renderV15BudgetReport(report: V15BudgetReport): string {
  const s = report.state;
  const lines = [
    `Budget report — run ${s.runId} (bot ${s.botId}, profile ${s.profileId || 'none'}, model ${s.model})`,
    `  Tokens: ${s.inputTokens.toLocaleString('en-US')} in + ${s.outputTokens.toLocaleString('en-US')} out = ${s.totalTokens.toLocaleString('en-US')} total (${v15FormatPercent(s.tokensPercent)} of cap${s.tokensEstimated ? ', estimated' : ''})`,
    `  Cost: ${v15FormatUsd(s.costUsd)} (${v15FormatPercent(s.costPercent)} of cap)`,
    `  Records: ${s.records} — over cap: ${s.overCap ? 'yes' : 'no'}`,
    `  ${report.reportOnlyNote}`,
  ];
  if (s.warnings.length > 0) {
    lines.push('  Warnings:');
    for (const w of s.warnings) lines.push(`    [${w.level}] ${w.dimension} ${w.percent.toFixed(1)}% — ${w.message}`);
  }
  return lines.join('\n');
}

/** Render lịch sử tiêu thụ theo run (một dòng mỗi run). */
export function renderV15BudgetHistory(entries: V15BudgetHistoryEntry[]): string {
  if (entries.length === 0) return 'No budget history yet.';
  return entries
    .map(
      (e) =>
        `${e.runId} (bot ${e.botId}, ${e.model}): ${e.totalTokens.toLocaleString('en-US')} tokens, ${v15FormatUsd(e.costUsd)}${e.overCap ? ' — OVER CAP' : ''} — ${e.records} records, ${e.firstAt} → ${e.lastAt}`,
    )
    .join('\n');
}

/* ================================================================== */
/* Forecast — dự báo tiêu thụ đến cuối run (report-only)              */
/* ================================================================== */

/** Dự báo tiêu thụ của run nếu tiếp tục với tốc độ hiện tại. */
export interface V15BudgetForecast {
  runId: string;
  /** Số step đã chạy (record). */
  stepsSoFar: number;
  /** Số step còn lại (ước tính). */
  stepsRemaining: number;
  /** Token trung bình mỗi step (từ lịch sử run). */
  avgTokensPerStep: number;
  /** Chi phí trung bình mỗi step (null khi chưa có giá). */
  avgCostPerStep: number | null;
  /** Tổng token dự báo khi run xong. */
  projectedTotalTokens: number;
  /** Tổng chi phí dự báo khi run xong (null khi chưa có giá). */
  projectedCostUsd: number | null;
  /** true = dự báo vượt token cap. */
  projectedOverTokenCap: boolean;
  /** true = dự báo vượt cost cap. */
  projectedOverCostCap: boolean;
  /** Gợi ý hành động (chỉ gợi ý — meter không chặn run). */
  recommendation: string;
}

/**
 * Dự báo tiêu thụ: lấy trung bình token/cost mỗi step từ state hiện
 * tại rồi nhân với số step còn lại. Khi chưa có step nào thì không
 * dự báo được (trả avg 0 + recommendation "chưa đủ dữ liệu").
 * Forecast là ước lượng — nói rõ trong recommendation, không giả
 * vờ chính xác.
 */
export function v15ForecastBudget(
  state: V15BudgetState,
  stepsRemaining: number,
): V15BudgetForecast {
  if (!Number.isInteger(stepsRemaining) || stepsRemaining < 0) {
    throw new CodingV15Error('budget-invalid', 'Forecast stepsRemaining phải là số nguyên >= 0.');
  }
  const stepsSoFar = state.records;
  const avgTokensPerStep = stepsSoFar > 0 ? state.totalTokens / stepsSoFar : 0;
  const avgCostPerStep = stepsSoFar > 0 && state.costUsd !== null ? state.costUsd / stepsSoFar : null;
  const projectedTotalTokens = Math.round(state.totalTokens + avgTokensPerStep * stepsRemaining);
  const projectedCostUsd = avgCostPerStep === null ? null : state.costUsd as number + avgCostPerStep * stepsRemaining;
  const projectedOverTokenCap = state.cap.maxTokens !== undefined && projectedTotalTokens > state.cap.maxTokens;
  const projectedOverCostCap =
    state.cap.maxCostUsd !== undefined && projectedCostUsd !== null && projectedCostUsd > state.cap.maxCostUsd;
  let recommendation: string;
  if (stepsSoFar === 0) {
    recommendation = 'Not enough data yet — record at least one step before forecasting.';
  } else if (projectedOverTokenCap || projectedOverCostCap) {
    const over = [
      projectedOverTokenCap ? `tokens (${projectedTotalTokens.toLocaleString('en-US')} projected vs ${(state.cap.maxTokens as number).toLocaleString('en-US')} cap)` : '',
      projectedOverCostCap ? `cost (${v15FormatUsd(projectedCostUsd)} projected vs ${v15FormatUsd(state.cap.maxCostUsd ?? null)} cap)` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    recommendation = `Projected to exceed ${over} if the run continues at the current pace. Consider stopping, narrowing scope, or switching to a cheaper model — the meter only reports, it never stops the run for you.`;
  } else if (state.cap.maxTokens === undefined && state.cap.maxCostUsd === undefined) {
    recommendation = `Projected total: ${projectedTotalTokens.toLocaleString('en-US')} tokens, ${v15FormatUsd(projectedCostUsd)}. No cap set — nothing to exceed.`;
  } else {
    recommendation = `Projected total: ${projectedTotalTokens.toLocaleString('en-US')} tokens, ${v15FormatUsd(projectedCostUsd)} — within cap at the current pace.`;
  }
  return {
    runId: state.runId,
    stepsSoFar,
    stepsRemaining,
    avgTokensPerStep,
    avgCostPerStep,
    projectedTotalTokens,
    projectedCostUsd,
    projectedOverTokenCap,
    projectedOverCostCap,
    recommendation,
  };
}

/** Render forecast thành text. */
export function renderV15BudgetForecast(forecast: V15BudgetForecast): string {
  return [
    `Budget forecast — run ${forecast.runId}: ${forecast.stepsSoFar} step(s) done, ${forecast.stepsRemaining} remaining`,
    `  Avg per step: ${forecast.avgTokensPerStep.toFixed(1)} tokens, ${v15FormatUsd(forecast.avgCostPerStep)}`,
    `  Projected total: ${forecast.projectedTotalTokens.toLocaleString('en-US')} tokens, ${v15FormatUsd(forecast.projectedCostUsd)}`,
    `  Projected over cap: tokens=${forecast.projectedOverTokenCap}, cost=${forecast.projectedOverCostCap}`,
    `  ${forecast.recommendation}`,
  ].join('\n');
}
