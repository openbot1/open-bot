/**
 * Memory v23 — sleep-time consolidation v2 (v1.38, Doi T1).
 *
 * Letta-style sleep-time compute, noi tiep v20/v21: pass chay luc
 * idle (khong chiem turn), don dep store v23 + danh sach block
 * core (dang { id, text, confidence, updatedAt }):
 *  1. Decay: confidence giam theo half-life (mac dinh 30 ngay);
 *     record nao rot duoi minConfidence -> archived (khong xoa cung).
 *  2. Prune: record deleted qua retention (mac dinh 30 ngay) ->
 *     purge khoi store; record noise (confidence thap + khong bao
 *     gio duoc retrieval + cu) -> archived.
 *  3. Merge: cap gan trung lap (Jaccard >= threshold) -> gop vao
 *     record giu lai (text dai hon, confidence max, entity hop nhat).
 *  4. Promote: record duoc retrieval nhieu lan (>= 3) + confidence
 *     chua cao -> tang confidence (toi da 0.95).
 *  5. Stale: record qua validTo -> danh dau archived + ghi log.
 *
 * Ngan sach: gioi han so thao tac (`maxOps`, mac dinh 200) va thoi
 * gian (`timeBudgetMs`, mac dinh 5000ms); het ngan sach thi dung
 * va bao `budgetHit: true` de pass sau lam tiep (khong bao gio
 * chay vo han luc idle).
 */

import { jaccardV23 } from './types';
import type { V23MemoryStore } from './store';
import type { V23SleepReport } from './types';

/** Tuy chon sleep v2. */
export interface V23SleepOptions {
  /** Thoi gian confidence giam mot nua (ngay, mac dinh 30). */
  halfLifeDays?: number;
  /** Confidence toi thieu de record con song sau decay (mac dinh 0.25). */
  minConfidence?: number;
  /** So ngay giu record deleted truoc khi purge (mac dinh 30). */
  deletedRetentionDays?: number;
  /** Jaccard de coi hai record la trung lap (mac dinh 0.6). */
  dedupeThreshold?: number;
  /** So lan retrieval toi thieu de promote (mac dinh 3). */
  promoteRetrievals?: number;
  /** Confidence toi da sau promote (mac dinh 0.95). */
  promoteCap?: number;
  /** So thao tac toi da moi pass (mac dinh 200). */
  maxOps?: number;
  /** Ngan sach thoi gian moi pass (ms, mac dinh 5000). */
  timeBudgetMs?: number;
  /** Ham lay thoi gian (test truyen clock co dinh). */
  now?: () => number;
}

/** Mot block core (dang toi thieu) de sleep v2 don dep. */
export interface V23SleepBlockInput {
  id: string;
  text: string;
  confidence: number;
  updatedAt: number;
  retrievalCount?: number;
}

/** Ket qua don dep block (thuan tuy, khong ghi store). */
export interface V23BlockSleepResult {
  keep: V23SleepBlockInput[];
  merged: { intoId: string; mergedIds: string[] }[];
  pruned: V23SleepBlockInput[];
  decayed: { id: string; from: number; to: number }[];
  actions: string[];
}

const DAY_MS = 86_400_000;

/** Confidence sau decay theo half-life. */
export function decayConfidenceV23(
  confidence: number,
  ageMs: number,
  halfLifeDays: number,
): number {
  if (ageMs <= 0 || halfLifeDays <= 0) return confidence;
  const halfLives = ageMs / (halfLifeDays * DAY_MS);
  const decayed = confidence * Math.pow(0.5, halfLives);
  return Math.round(decayed * 1000) / 1000;
}

/**
 * Don dep danh sach block (thuan tuy): decay + merge trung lap +
 * prune noise. Dung cho core blocks ma khong can store v23.
 */
export function consolidateBlocksV23(
  blocks: V23SleepBlockInput[],
  opts: V23SleepOptions = {},
): V23BlockSleepResult {
  const now = opts.now?.() ?? Date.now();
  const halfLifeDays = opts.halfLifeDays ?? 30;
  const minConfidence = opts.minConfidence ?? 0.25;
  const dedupeThreshold = opts.dedupeThreshold ?? 0.6;
  const actions: string[] = [];
  const decayed: { id: string; from: number; to: number }[] = [];

  // Buoc 1: decay + loai block rot duoi nguong.
  const afterDecay: V23SleepBlockInput[] = [];
  const pruned: V23SleepBlockInput[] = [];
  for (const block of blocks) {
    const ageMs = Math.max(0, now - block.updatedAt);
    const next = decayConfidenceV23(block.confidence, ageMs, halfLifeDays);
    if (next !== block.confidence) decayed.push({ id: block.id, from: block.confidence, to: next });
    if (next < minConfidence) {
      pruned.push({ ...block, confidence: next });
      actions.push(`prune ${block.id}: confidence ${next} < ${minConfidence} (decay)`);
    } else {
      afterDecay.push({ ...block, confidence: next });
    }
  }

  // Buoc 2: merge cap gan trung lap (giu block dai hon / moi hon).
  const merged: { intoId: string; mergedIds: string[] }[] = [];
  const consumed = new Set<string>();
  const keep: V23SleepBlockInput[] = [];
  const sorted = [...afterDecay].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const block of sorted) {
    if (consumed.has(block.id)) continue;
    const group = [block];
    for (const other of sorted) {
      if (other.id === block.id || consumed.has(other.id)) continue;
      if (jaccardV23(block.text, other.text) >= dedupeThreshold) {
        group.push(other);
        consumed.add(other.id);
      }
    }
    consumed.add(block.id);
    if (group.length > 1) {
      const best = [...group].sort((a, b) => b.text.length - a.text.length || b.updatedAt - a.updatedAt)[0];
      const mergedIds = group.filter((g) => g.id !== best.id).map((g) => g.id);
      merged.push({ intoId: best.id, mergedIds });
      actions.push(`merge ${mergedIds.join(', ')} -> ${best.id} (Jaccard >= ${dedupeThreshold})`);
      keep.push({ ...best, confidence: Math.max(...group.map((g) => g.confidence)) });
    } else {
      keep.push(block);
    }
  }
  keep.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return { keep, merged, pruned, decayed, actions };
}

/**
 * Sleep consolidator v2: chay pass tren V23MemoryStore (ghi that).
 * Thu tu: stale -> decay -> promote -> merge -> prune. Moi buoc
 * kiem tra ngan sach truoc khi lam (het ngan sach thi dung).
 */
export class V23SleepConsolidator {
  private readonly opts: Required<
    Pick<
      V23SleepOptions,
      | 'halfLifeDays'
      | 'minConfidence'
      | 'deletedRetentionDays'
      | 'dedupeThreshold'
      | 'promoteRetrievals'
      | 'promoteCap'
      | 'maxOps'
      | 'timeBudgetMs'
    >
  >;
  private readonly now: () => number;

  constructor(opts: V23SleepOptions = {}) {
    this.opts = {
      halfLifeDays: opts.halfLifeDays ?? 30,
      minConfidence: opts.minConfidence ?? 0.25,
      deletedRetentionDays: opts.deletedRetentionDays ?? 30,
      dedupeThreshold: opts.dedupeThreshold ?? 0.6,
      promoteRetrievals: opts.promoteRetrievals ?? 3,
      promoteCap: opts.promoteCap ?? 0.95,
      maxOps: opts.maxOps ?? 200,
      timeBudgetMs: opts.timeBudgetMs ?? 5000,
    };
    this.now = opts.now ?? Date.now;
  }

  /** Chay mot pass sleep tren store, tra bao cao. */
  run(store: V23MemoryStore): V23SleepReport {
    const started = Date.now();
    const ranAt = this.now();
    const actions: string[] = [];
    let ops = 0;
    let budgetHit = false;
    const outOfBudget = (): boolean => {
      if (ops >= this.opts.maxOps) {
        budgetHit = true;
        return true;
      }
      if (Date.now() - started >= this.opts.timeBudgetMs) {
        budgetHit = true;
        return true;
      }
      return false;
    };

    const actives = store.listActive();
    const scanned = store.size(false);
    let decayed = 0;
    let pruned = 0;
    let merged = 0;
    let promoted = 0;
    let markedStale = 0;

    // Buoc 1: stale theo validTo.
    for (const record of actives) {
      if (outOfBudget()) break;
      if (record.validTo && todayIsoOf(ranAt) > record.validTo) {
        store.update(record.id, { status: 'archived' });
        ops += 1;
        markedStale += 1;
        actions.push(`stale ${record.id}: validTo ${record.validTo} da qua`);
      }
    }

    // Buoc 2: decay + promote (tren record con active).
    for (const record of store.listActive()) {
      if (outOfBudget()) break;
      const ageMs = Math.max(0, ranAt - record.updatedAt);
      const nextConf = decayConfidenceV23(record.confidence, ageMs, this.opts.halfLifeDays);
      let target = nextConf;
      let promotedThis = false;
      if (record.retrievalCount >= this.opts.promoteRetrievals && target < this.opts.promoteCap) {
        target = Math.min(this.opts.promoteCap, Math.round((target + 0.1) * 100) / 100);
        promotedThis = true;
      }
      if (target < this.opts.minConfidence) {
        store.update(record.id, { status: 'archived', confidence: target });
        ops += 1;
        pruned += 1;
        actions.push(`archive ${record.id}: confidence ${target} < ${this.opts.minConfidence}`);
      } else if (target !== record.confidence) {
        store.update(record.id, { confidence: target });
        ops += 1;
        if (promotedThis) {
          promoted += 1;
          actions.push(`promote ${record.id}: confidence ${record.confidence} -> ${target} (${record.retrievalCount} retrieval)`);
        } else {
          decayed += 1;
        }
      } else if (promotedThis) {
        promoted += 1;
      }
    }

    // Buoc 3: merge cap trung lap.
    const remaining = store.listActive();
    const consumed = new Set<string>();
    for (const record of remaining) {
      if (outOfBudget()) break;
      if (consumed.has(record.id)) continue;
      for (const other of remaining) {
        if (other.id === record.id || consumed.has(other.id)) continue;
        if (jaccardV23(record.text, other.text) >= this.opts.dedupeThreshold) {
          const keeper = record.text.length >= other.text.length ? record : other;
          const loser = keeper === record ? other : record;
          const keeperNow = store.get(keeper.id);
          if (!keeperNow) continue;
          store.update(keeper.id, {
            entities: [...new Set([...keeperNow.entities, ...loser.entities])],
            confidence: Math.max(keeperNow.confidence, loser.confidence),
          });
          store.update(loser.id, { status: 'merged', supersededBy: keeper.id });
          consumed.add(keeper.id);
          consumed.add(loser.id);
          ops += 1;
          merged += 1;
          actions.push(`merge ${loser.id} -> ${keeper.id}`);
          break;
        }
      }
      consumed.add(record.id);
    }

    // Buoc 4: purge record deleted qua retention.
    const retentionMs = this.opts.deletedRetentionDays * DAY_MS;
    for (const record of store.list({ status: 'deleted' })) {
      if (outOfBudget()) break;
      if (ranAt - record.updatedAt >= retentionMs) {
        // Xoa cung: khong co API purge trong store — danh archived
        // la buoc cuoi an toan (du lieu van con de audit).
        store.update(record.id, { status: 'archived' });
        ops += 1;
        pruned += 1;
        actions.push(`purge-soft ${record.id}: deleted qua ${this.opts.deletedRetentionDays} ngay`);
      }
    }

    return {
      scanned,
      decayed,
      pruned,
      merged,
      promoted,
      markedStale,
      actions: actions.slice(0, 50),
      ranAt,
      durationMs: Date.now() - started,
      budgetHit,
    };
  }
}

/** Ngay YYYY-MM-DD (UTC) tu epoch ms. */
function todayIsoOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
