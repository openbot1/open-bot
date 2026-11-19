/**
 * Provider budget v30 (v1.44, Doi T5) — ngan sach chi phi theo provider.
 *
 * Router v30 chon model theo chi phi uoc tinh; file nay them gioi han
 * that: user dat tran chi tieu moi ngay cho tung provider (vd OpenAI
 * $5/ngay). Khi provider da het ngan sach trong ngay, router (qua
 * `applyBudgetToDecisionV30`) se bo qua model cua provider do va chon
 * model re hon / provider khac con ngan sach — thay vi cho goi that
 * roi moi biet la vuot.
 *
 * - Ngay tinh theo UTC (bat dau 00:00 UTC); qua ngay moi thi so da
 *   chi tu reset (khong can host goi reset tay).
 * - Khong co budget nao duoc dat -> moi thu nhu cu (khong chan gi).
 * - Store in-memory, cap 100 provider; host persist bang
 *   `snapshotV30()` / `restoreV30()`. Thuan logic, khong goi API.
 */
import type { RoutingDecisionV30 } from './latencyCostRouterV30';

/** Ngan sach ngay cua 1 provider. */
export interface ProviderBudgetV30 {
  provider: string;
  /** Tran chi tieu 1 ngay (USD). 0 = khong gioi han (tuong duong khong dat). */
  dailyCapUsd: number;
  /** Da chi trong ngay hien tai (USD). */
  spentTodayUsd: number;
  /** Ngay dang tinh (epoch ms cua 00:00 UTC ngay do). */
  dayStartMs: number;
}

/** So provider toi da theo doi. */
export const MAX_TRACKED_BUDGETS_V30 = 100;

/** Bat dau ngay UTC chua epoch ms cho truoc. */
export function startOfUtcDayV30(at = Date.now()): number {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Store ngan sach theo provider. */
export class ProviderBudgetStoreV30 {
  private budgets = new Map<string, ProviderBudgetV30>();

  /** Dat (hoac doi) tran ngay cua 1 provider. */
  setBudget(provider: string, dailyCapUsd: number, now = Date.now()): ProviderBudgetV30 {
    if (!provider) throw new Error('provider is required');
    if (!Number.isFinite(dailyCapUsd) || dailyCapUsd < 0) {
      throw new Error('dailyCapUsd must be >= 0');
    }
    const dayStartMs = startOfUtcDayV30(now);
    const existing = this.budgets.get(provider);
    const budget: ProviderBudgetV30 = {
      provider,
      dailyCapUsd,
      spentTodayUsd: existing && existing.dayStartMs === dayStartMs ? existing.spentTodayUsd : 0,
      dayStartMs,
    };
    this.budgets.set(provider, budget);
    if (this.budgets.size > MAX_TRACKED_BUDGETS_V30) {
      const first = this.budgets.keys().next().value;
      if (first !== undefined && first !== provider) this.budgets.delete(first);
    }
    return { ...budget };
  }

  /** Xoa budget cua 1 provider. */
  removeBudget(provider: string): boolean {
    return this.budgets.delete(provider);
  }

  /** Budget hien tai cua 1 provider (null neu chua dat). */
  getBudget(provider: string, now = Date.now()): ProviderBudgetV30 | null {
    const budget = this.budgets.get(provider);
    if (!budget) return null;
    if (budget.dayStartMs !== startOfUtcDayV30(now)) {
      // Qua ngay moi: reset so da chi (khong doi cap).
      const reset: ProviderBudgetV30 = {
        ...budget,
        spentTodayUsd: 0,
        dayStartMs: startOfUtcDayV30(now),
      };
      this.budgets.set(provider, reset);
      return { ...reset };
    }
    return { ...budget };
  }

  /** Ghi chi phi that (sau khi goi model xong) vao ngay hien tai. */
  recordSpend(provider: string, usd: number, now = Date.now()): ProviderBudgetV30 | null {
    if (!Number.isFinite(usd) || usd < 0) return null;
    const current = this.getBudget(provider, now);
    if (!current) return null;
    const updated: ProviderBudgetV30 = {
      ...current,
      spentTodayUsd: current.spentTodayUsd + usd,
    };
    this.budgets.set(provider, updated);
    return { ...updated };
  }

  /** So tien con lai trong ngay (null neu chua dat budget). */
  remainingUsd(provider: string, now = Date.now()): number | null {
    const budget = this.getBudget(provider, now);
    if (!budget) return null;
    if (budget.dailyCapUsd === 0) return Number.POSITIVE_INFINITY;
    return budget.dailyCapUsd - budget.spentTodayUsd;
  }

  /** Provider nay da het ngan sach trong ngay chua. */
  isOverBudget(provider: string, now = Date.now()): boolean {
    const remaining = this.remainingUsd(provider, now);
    if (remaining === null) return false;
    return remaining <= 0;
  }

  /** Con du ngan sach cho 1 lan goi uoc tinh bao nhieu USD khong. */
  canAfford(provider: string, estimatedCostUsd: number, now = Date.now()): boolean {
    const remaining = this.remainingUsd(provider, now);
    if (remaining === null) return true;
    return estimatedCostUsd <= remaining;
  }

  /** Tat ca budget dang theo doi. */
  allBudgets(now = Date.now()): ProviderBudgetV30[] {
    const dayStart = startOfUtcDayV30(now);
    return [...this.budgets.values()]
      .map((b) =>
        b.dayStartMs === dayStart
          ? { ...b }
          : { ...b, spentTodayUsd: 0, dayStartMs: dayStart },
      )
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** Co budget nao duoc dat khong. */
  get hasBudgets(): boolean {
    return this.budgets.size > 0;
  }

  clear(): void {
    this.budgets.clear();
  }

  /** Snapshot de persist — giu nguyen du lieu da luu (khong reset theo ngay hien tai; viec reset ngay moi do getBudget/allBudgets lam khi doc). */
  snapshotV30(): ProviderBudgetV30[] {
    return [...this.budgets.values()].map((b) => ({ ...b }));
  }

  /** Nap lai snapshot (chi nhan muc hop le). */
  restoreV30(snapshot: ProviderBudgetV30[]): number {
    let restored = 0;
    for (const b of snapshot ?? []) {
      if (!b || typeof b.provider !== 'string' || !b.provider) continue;
      if (!Number.isFinite(b.dailyCapUsd) || b.dailyCapUsd < 0) continue;
      if (!Number.isFinite(b.spentTodayUsd) || b.spentTodayUsd < 0) continue;
      this.budgets.set(b.provider, { ...b });
      restored += 1;
    }
    return restored;
  }
}

/**
 * Ap ngan sach vao 1 quyet dinh routing: neu model duoc chon thuoc
 * provider da het ngan sach (hoac khong du cho chi phi uoc tinh),
 * chon ung vien tiep theo con ngan sach. Khong co budget nao ->
 * tra nguyen quyet dinh. Tra quyet dinh moi (khong doi quyet dinh cu).
 */
export function applyBudgetToDecisionV30(
  decision: RoutingDecisionV30,
  budgets: ProviderBudgetStoreV30,
  now = Date.now(),
): RoutingDecisionV30 {
  if (!decision.ok || !decision.chosen) return decision;
  if (!budgets.hasBudgets) return decision;
  const chosen = decision.chosen;
  if (
    budgets.canAfford(chosen.entry.provider, chosen.estimatedCostUsd, now)
  ) {
    return decision;
  }
  const skipped: Array<{ key: string; reason: string }> = [
    {
      key: `${chosen.entry.provider}::${chosen.entry.modelId}`,
      reason: `provider ${chosen.entry.provider} over daily budget`,
    },
  ];
  for (const candidate of decision.candidates.slice(1)) {
    if (
      budgets.canAfford(
        candidate.entry.provider,
        candidate.estimatedCostUsd,
        now,
      )
    ) {
      return {
        ...decision,
        chosen: candidate,
        candidates: [
          candidate,
          ...decision.candidates.filter((c) => c !== candidate),
        ],
        rejected: [...decision.rejected, ...skipped],
      };
    }
    skipped.push({
      key: `${candidate.entry.provider}::${candidate.entry.modelId}`,
      reason: `provider ${candidate.entry.provider} over daily budget`,
    });
  }
  return {
    ...decision,
    ok: false,
    chosen: undefined,
    candidates: [],
    rejected: [...decision.rejected, ...skipped],
  };
}
