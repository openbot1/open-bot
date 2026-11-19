/**
 * Cost forecast v29 (v1.42, Doi T5) — du bao chi phi tu lich su ledger.
 *
 * Tu cac ban ghi ModelUsageRecordV29 (khong can doc file — host
 * truyen records): chi phi trung binh/ngay, du bao thang, toc do
 * "dot" ngan sach ngay (bao lau thi het), xu huong tung model
 * (7 ngay gan nhat vs 7 ngay truoc do), model thay the re hon.
 * Thuan logic, khong goi API live.
 */
import type { ModelCatalogEntryV29 } from './modelCatalogV29';
import type { ModelUsageRecordV29 } from './costLedgerV29';
import { dayOfTimestampV29 } from './costLedgerV29';

/** Du bao tong hop. */
export interface CostForecastV29 {
  /** So ngay co du lieu trong cua so. */
  daysWithData: number;
  /** Chi phi trung binh/ngay (USD) trong cua so. */
  avgDailyUsd: number;
  /** Chi phi ngay gan nhat co du lieu (USD). */
  lastDayUsd: number;
  /** Ngay gan nhat co du lieu (YYYY-MM-DD). */
  lastDay: string | null;
  /** Du bao chi phi 30 ngay toi (avg * 30). */
  projected30DayUsd: number;
  /** Du bao chi phi 7 ngay toi (avg * 7). */
  projected7DayUsd: number;
  /** Tong chi phi trong cua so (USD). */
  windowTotalUsd: number;
  /** So luot goi trong cua so. */
  windowCalls: number;
}

/** Trang thai "dot" ngan sach ngay. */
export interface BudgetBurnV29 {
  dailyBudgetUsd: number | null;
  avgDailyUsd: number;
  /** So ngay nua thi het ngan sach thang (null neu khong tinh duoc). */
  daysUntilMonthlyBudgetOut: number | null;
  /** true = toc do hien tai se vuot ngan sach ngay trung binh. */
  willExceedDaily: boolean;
  /** Phan tram ngan sach ngay da dung (trung binh). */
  dailyUsagePct: number | null;
}

/** Xu huong mot model: 7 ngay gan nhat vs 7 ngay truoc. */
export interface ModelTrendV29 {
  modelId: string;
  recent7DayUsd: number;
  previous7DayUsd: number;
  /** Thay doi tuyet doi (USD). */
  deltaUsd: number;
  /** Thay doi tuong doi (1 = tang gap doi; null khi mau cu = 0). */
  deltaPct: number | null;
  trend: 'up' | 'down' | 'flat' | 'new';
}

/** Goi y thay the re hon cho mot model. */
export interface CheaperAlternativeV29 {
  modelId: string;
  alternativeModelId: string | null;
  alternativeProvider: string | null;
  /** Tiet kiem uoc tinh moi 1k input + 500 output (USD). */
  savedPerTurnUsd: number;
  /** Chat luong cua model thay the (0..1). */
  alternativeQuality: number;
  reason: string;
}

function sumCost(records: ModelUsageRecordV29[]): number {
  return records.reduce((s, r) => s + r.costUsd, 0);
}

function recordsInWindow(
  records: ModelUsageRecordV29[],
  endDay: string,
  days: number,
): ModelUsageRecordV29[] {
  const end = new Date(`${endDay}T00:00:00.000Z`).getTime();
  const start = end - (days - 1) * 86400000;
  return records.filter((r) => {
    const t = new Date(`${r.day}T00:00:00.000Z`).getTime();
    return t >= start && t <= end;
  });
}

function distinctDays(records: ModelUsageRecordV29[]): string[] {
  return [...new Set(records.map((r) => r.day))].sort();
}

/**
 * Du bao chi phi tu lich su: lay `windowDays` ngay gan nhat tinh
 * tu `endDay` (mac dinh hom nay). Neu khong co du lieu thi cac so
 * deu 0 (khong doan mo).
 */
export function forecastCostV29(
  records: ModelUsageRecordV29[],
  options: { windowDays?: number; endDay?: string } = {},
): CostForecastV29 {
  const windowDays = Math.max(1, Math.floor(options.windowDays ?? 30));
  const endDay = options.endDay ?? dayOfTimestampV29(Date.now());
  const window = recordsInWindow(records, endDay, windowDays);
  const days = distinctDays(window);
  const total = sumCost(window);
  const daysWithData = days.length;
  const avgDailyUsd = daysWithData > 0 ? total / daysWithData : 0;
  const lastDay = days.length > 0 ? days[days.length - 1] : null;
  const lastDayUsd = lastDay !== null ? sumCost(window.filter((r) => r.day === lastDay)) : 0;
  return {
    daysWithData,
    avgDailyUsd,
    lastDayUsd,
    lastDay,
    projected30DayUsd: avgDailyUsd * 30,
    projected7DayUsd: avgDailyUsd * 7,
    windowTotalUsd: total,
    windowCalls: window.length,
  };
}

/**
 * Toc do dot ngan sach: so sanh chi phi trung binh/ngay voi ngan
 * sach ngay; uoc tinh so ngay nua thi het ngan sach thang
 * (monthlyBudgetUsd) o toc do hien tai.
 */
export function budgetBurnV29(
  records: ModelUsageRecordV29[],
  options: { dailyBudgetUsd?: number | null; monthlyBudgetUsd?: number | null; windowDays?: number; endDay?: string } = {},
): BudgetBurnV29 {
  const forecast = forecastCostV29(records, { windowDays: options.windowDays, endDay: options.endDay });
  const dailyBudgetUsd = options.dailyBudgetUsd ?? null;
  const monthlyBudgetUsd = options.monthlyBudgetUsd ?? null;
  const avg = forecast.avgDailyUsd;
  let daysUntilMonthlyBudgetOut: number | null = null;
  if (monthlyBudgetUsd !== null && monthlyBudgetUsd > 0 && avg > 0) {
    daysUntilMonthlyBudgetOut = Math.floor(monthlyBudgetUsd / avg);
  }
  return {
    dailyBudgetUsd,
    avgDailyUsd: avg,
    daysUntilMonthlyBudgetOut,
    willExceedDaily: dailyBudgetUsd !== null && dailyBudgetUsd > 0 && avg > dailyBudgetUsd,
    dailyUsagePct: dailyBudgetUsd !== null && dailyBudgetUsd > 0 ? (avg / dailyBudgetUsd) * 100 : null,
  };
}

/**
 * Xu huong tung model: 7 ngay gan nhat (tinh tu endDay) so voi
 * 7 ngay truoc do. `new` = model moi xuat hien trong 7 ngay gan nhat.
 */
export function modelTrendsV29(
  records: ModelUsageRecordV29[],
  options: { endDay?: string } = {},
): ModelTrendV29[] {
  const endDay = options.endDay ?? dayOfTimestampV29(Date.now());
  const end = new Date(`${endDay}T00:00:00.000Z`).getTime();
  const recentStart = end - 6 * 86400000;
  const previousStart = end - 13 * 86400000;
  const previousEnd = recentStart - 86400000;
  const byModel = new Map<string, { recent: number; previous: number }>();
  for (const r of records) {
    const t = new Date(`${r.day}T00:00:00.000Z`).getTime();
    const slot = byModel.get(r.modelId) ?? { recent: 0, previous: 0 };
    if (t >= recentStart && t <= end) slot.recent += r.costUsd;
    else if (t >= previousStart && t <= previousEnd) slot.previous += r.costUsd;
    byModel.set(r.modelId, slot);
  }
  const trends: ModelTrendV29[] = [];
  for (const [modelId, { recent, previous }] of byModel) {
    if (recent === 0 && previous === 0) continue;
    const deltaUsd = recent - previous;
    let trend: ModelTrendV29['trend'];
    let deltaPct: number | null;
    if (previous === 0) {
      trend = 'new';
      deltaPct = null;
    } else {
      deltaPct = deltaUsd / previous;
      trend = deltaUsd > 0.005 ? 'up' : deltaUsd < -0.005 ? 'down' : 'flat';
    }
    trends.push({ modelId, recent7DayUsd: recent, previous7DayUsd: previous, deltaUsd, deltaPct, trend });
  }
  return trends.sort((a, b) => b.recent7DayUsd - a.recent7DayUsd || a.modelId.localeCompare(b.modelId));
}

/**
 * Goi y model thay the re hon: cung loai (realtime/live/text), gia
 * input + output thap hon, chat luong khong thap hon qua 0.15.
 * Tra null neu khong co lua chon re hon dat chuan.
 */
export function cheaperAlternativeV29(
  catalog: ModelCatalogEntryV29[],
  modelId: string,
  options: { inputTokens?: number; outputTokens?: number; maxQualityDrop?: number } = {},
): CheaperAlternativeV29 {
  const inputTokens = options.inputTokens ?? 1000;
  const outputTokens = options.outputTokens ?? 500;
  const maxQualityDrop = options.maxQualityDrop ?? 0.15;
  const current = catalog.find((m) => m.modelId === modelId);
  if (!current) {
    return {
      modelId,
      alternativeModelId: null,
      alternativeProvider: null,
      savedPerTurnUsd: 0,
      alternativeQuality: 0,
      reason: `Khong co model "${modelId}" trong catalog.`,
    };
  }
  const currentCost = (inputTokens / 1000) * current.inputPricePer1kUsd + (outputTokens / 1000) * current.outputPricePer1kUsd;
  const candidates = catalog
    .filter((m) => !m.deprecated && m.modelId !== modelId && m.kind === current.kind)
    .filter((m) => m.quality >= current.quality - maxQualityDrop)
    .map((m) => ({
      model: m,
      cost: (inputTokens / 1000) * m.inputPricePer1kUsd + (outputTokens / 1000) * m.outputPricePer1kUsd,
    }))
    .filter((c) => c.cost < currentCost)
    .sort((a, b) => a.cost - b.cost || b.model.quality - a.model.quality);
  if (candidates.length === 0) {
    return {
      modelId,
      alternativeModelId: null,
      alternativeProvider: null,
      savedPerTurnUsd: 0,
      alternativeQuality: 0,
      reason: `${modelId} da la lua chon re nhat trong loai ${current.kind} (chat luong giam toi da ${maxQualityDrop}).`,
    };
  }
  const best = candidates[0];
  return {
    modelId,
    alternativeModelId: best.model.modelId,
    alternativeProvider: best.model.provider,
    savedPerTurnUsd: currentCost - best.cost,
    alternativeQuality: best.model.quality,
    reason: `${best.model.modelId} re hon $${(currentCost - best.cost).toFixed(4)}/luot, chat luong ${best.model.quality} (goc ${current.quality}).`,
  };
}
