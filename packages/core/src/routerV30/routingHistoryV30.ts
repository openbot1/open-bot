/**
 * Routing history v30 (v1.44, Doi T5) — lich su quyet dinh routing.
 *
 * Router v30 chon model moi lan goi; file nay luu lai cac quyet dinh
 * do (model nao duoc chon, vi sao, latency/chi phi uoc tinh luc do,
 * co phai do that khong) de UI hien thi + host phan tich: model nao
 * duoc chon nhieu nhat, tong chi phi uoc tinh, ti le "khong co model
 * nao dat".
 *
 * Store in-memory, cap 500 muc (cu nhat bi xoa); host persist bang
 * `snapshotV30()` / `restoreV30()`. Thuan logic, khong goi model that.
 */
import type { RoutingDecisionV30 } from './latencyCostRouterV30';
import type { RoutingRequestV30 } from './latencyCostRouterV30';

/** So muc toi da trong lich su. */
export const MAX_ROUTING_HISTORY_ENTRIES_V30 = 500;

/** Mot muc lich su routing. */
export interface RoutingHistoryEntryV30 {
  /** Luc quyet dinh (epoch ms). */
  at: number;
  /** Co chon duoc model khong. */
  ok: boolean;
  /** Model duoc chon (dang provider::modelId). */
  chosenKey: string | null;
  /** Diem cua model duoc chon (neu co). */
  chosenScore: number | null;
  /** Do tre hieu dung luc chon (ms). */
  effectiveLatencyMs: number | null;
  /** Latency nay co phai do that khong. */
  latencyMeasured: boolean;
  /** Chi phi uoc tinh (USD). */
  estimatedCostUsd: number | null;
  /** Yeu cau (tom tat — chi luu cac flag, khong luu prompt). */
  needsRealtimeVoice: boolean;
  needsToolCalling: boolean;
  needsVision: boolean;
  needsReasoning: boolean;
  /** Profile/policy luc chon (chuoi tom tat). */
  policySummary: string;
  /** Giai thich 1 dong (de hien thi). */
  explanation: string;
}

/** Store lich su routing. */
export class RoutingHistoryStoreV30 {
  private entries: RoutingHistoryEntryV30[] = [];

  /** Ghi 1 quyet dinh routing vao lich su. */
  record(
    decision: RoutingDecisionV30,
    request: RoutingRequestV30 = {},
  ): RoutingHistoryEntryV30 {
    const chosen = decision.chosen;
    const entry: RoutingHistoryEntryV30 = {
      at: decision.decidedAt,
      ok: decision.ok,
      chosenKey: chosen
        ? `${chosen.entry.provider}::${chosen.entry.modelId}`
        : null,
      chosenScore: chosen ? chosen.score : null,
      effectiveLatencyMs: chosen ? chosen.effectiveLatencyMs : null,
      latencyMeasured: chosen ? chosen.latencyMeasured : false,
      estimatedCostUsd: chosen ? chosen.estimatedCostUsd : null,
      needsRealtimeVoice: request.needsRealtimeVoice ?? false,
      needsToolCalling: request.needsToolCalling ?? false,
      needsVision: request.needsVision ?? false,
      needsReasoning: request.needsReasoning ?? false,
      policySummary: decision.policySummary,
      explanation:
        chosen != null
          ? `${chosen.entry.provider}::${chosen.entry.modelId} (${chosen.score.toFixed(2)})`
          : 'no model fits',
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ROUTING_HISTORY_ENTRIES_V30) {
      this.entries.splice(
        0,
        this.entries.length - MAX_ROUTING_HISTORY_ENTRIES_V30,
      );
    }
    return entry;
  }

  /** Tat ca muc (moi nhat cuoi cung). */
  get all(): RoutingHistoryEntryV30[] {
    return [...this.entries];
  }

  get length(): number {
    return this.entries.length;
  }

  /** N muc gan nhat (moi nhat dau tien). */
  recent(count: number): RoutingHistoryEntryV30[] {
    return [...this.entries].slice(-count).reverse();
  }

  /** Cac muc chon 1 model cu the. */
  byModel(provider: string, modelId: string): RoutingHistoryEntryV30[] {
    const key = `${provider}::${modelId}`;
    return this.entries.filter((e) => e.chosenKey === key);
  }

  /** Xoa het lich su. */
  clear(): void {
    this.entries = [];
  }

  /** Thong ke tong hop de UI bao cao. */
  summary(): {
    total: number;
    succeeded: number;
    failed: number;
    /** So lan moi model duoc chon (sap xep giam dan). */
    byModel: Array<{ key: string; count: number }>;
    /** Tong chi phi uoc tinh (USD) cua cac lan chon duoc. */
    totalEstimatedCostUsd: number;
    /** Chi phi uoc tinh trung binh / lan chon duoc. */
    avgEstimatedCostUsd: number;
    /** Ti le lan dung latency do that (0..1). */
    measuredLatencyRatio: number;
    /** Model duoc chon nhieu nhat. */
    mostChosen: string | null;
  } {
    const total = this.entries.length;
    let succeeded = 0;
    let totalCost = 0;
    let measured = 0;
    const counts = new Map<string, number>();
    for (const e of this.entries) {
      if (e.ok) {
        succeeded += 1;
        if (e.estimatedCostUsd !== null) totalCost += e.estimatedCostUsd;
        if (e.latencyMeasured) measured += 1;
      }
      if (e.chosenKey) {
        counts.set(e.chosenKey, (counts.get(e.chosenKey) ?? 0) + 1);
      }
    }
    const byModel = [...counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    return {
      total,
      succeeded,
      failed: total - succeeded,
      byModel,
      totalEstimatedCostUsd: totalCost,
      avgEstimatedCostUsd: succeeded === 0 ? 0 : totalCost / succeeded,
      measuredLatencyRatio: succeeded === 0 ? 0 : measured / succeeded,
      mostChosen: byModel.length > 0 ? byModel[0].key : null,
    };
  }

  /** Snapshot de persist. */
  snapshotV30(): RoutingHistoryEntryV30[] {
    return this.all.map((e) => ({ ...e }));
  }

  /** Nap lai snapshot (chi nhan muc hop le, cap 500). */
  restoreV30(snapshot: RoutingHistoryEntryV30[]): number {
    let restored = 0;
    const next: RoutingHistoryEntryV30[] = [];
    for (const e of snapshot ?? []) {
      if (!e || typeof e.at !== 'number' || typeof e.ok !== 'boolean') {
        continue;
      }
      next.push({ ...e });
      restored += 1;
    }
    this.entries = next.slice(-MAX_ROUTING_HISTORY_ENTRIES_V30);
    return restored;
  }
}
