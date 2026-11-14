/**
 * Consolidation v2 — Memory v5 (v1.04, Đội T1).
 *
 * Sleep-time consolidation có scoring, chạy trên nền ADD-only +
 * bi-temporal + health của v5. Kế thừa, không làm lại:
 *  - `runScoredDreamPass` (v1.03) — dream có scoring, promote
 *    top-N vào block `human`. Consolidation v2 GỌI nó (khi có
 *    blocksStore) thay vì viết lại dream pass.
 *  - `sweepExpiredFacts` (v1.03) — đóng mềm fact hết hạn.
 *  - `applyRankingSupersession` (v5, addOnly.ts) — supersede loser
 *    khi winner đủ chắc + đủ gap điểm.
 *  - `computeMemoryHealth` (v5, memoryHealth.ts) — đo trước/sau.
 *  - `TemporalGraphStore.mergeFacts` (v1.02) — gộp fact trùng lặp
 *    chính xác (cùng subject/predicate/object).
 *
 * Một lần chạy consolidation v2, theo thứ tự:
 *  1. Đo health TRƯỚC.
 *  2. Gộp fact trùng lặp chính xác (dedupe thật — cùng object, khác
 *     episode): keeper là fact confidence cao nhất, còn lại đóng
 *     bằng mergeFacts (lịch sử giữ nguyên).
 *  3. Ranking ADD-only: resolve nhóm → supersede loser đủ điều kiện
 *     (winner chắc + gap điểm). Loser không đủ điều kiện ở lại.
 *  4. Sweep fact hết hạn (validUntil đã qua).
 *  4b. Dọn entity mồ côi (không fact nào còn trỏ tới).
 *  5. Scored dream pass (nếu có blocksStore): extract episode chưa
 *     xử lý → chấm điểm → promote top-N vào block human.
 *  6. Đo health SAU + delta điểm. Ghi log JSONL
 *     `.open-bot/memory-consolidation-v2.jsonl` (một dòng / lần chạy)
 *     để audit và để UI hiện lịch sử chạy.
 *
 * Không bước nào xoá dữ liệu: merge/supersede/sweep đều đóng mềm,
 * fact cũ vẫn truy vấn được qua `factHistory` / `queryFactsAt`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphFact, MemoryScope } from './graph/types';
import { normalizeGraphText } from './graph/types';
import type { TemporalGraphStore } from './graph/store';
import type { MemoryBlockStore } from './blocks';
import {
  resolveAddOnlyGroups,
  applyRankingSupersession,
} from './graph/addOnly';
import { sweepExpiredFacts } from './graph/validity';
import { runScoredDreamPass } from './sleepScoring';
import type { ScoredDreamReport } from './sleepScoring';
import {
  computeMemoryHealth,
  healthDelta,
} from './memoryHealth';
import type { MemoryHealth } from './memoryHealth';

/** File log JSONL cho các lần consolidation v2. */
export const MEMORY_CONSOLIDATION_V2_REL_PATH = path.join(
  '.open-bot',
  'memory-consolidation-v2.jsonl',
);
/** Số dòng log tối đa khi đọc. */
export const MAX_CONSOLIDATION_V2_LOG_LINES = 200;

export interface ConsolidationV2Options {
  scope: MemoryScope;
  /** Thư mục workspace của bot (ghi log JSONL + sweep log). */
  workspaceDir: string;
  now?: Date;
  /** Actor ghi audit (mặc định 'system:consolidation-v2'). */
  actor?: string;
  /** Memory block store — không có thì bỏ qua bước dream (bước 5). */
  blocksStore?: MemoryBlockStore;
  /** Điểm tối thiểu để dream promote (mặc định 0.5). */
  dreamMinScore?: number;
  /** Số fact tối đa dream promote (mặc định 10). */
  dreamMaxPromote?: number;
  /** Bỏ qua bước dream (chỉ ranking + sweep + dedupe). */
  skipDream?: boolean;
}

export interface ConsolidationV2Report {
  ranAt: string;
  actor: string;
  /** Số fact trùng lặp chính xác đã gộp. */
  duplicatesMerged: number;
  /** Nhóm ADD-only đã resolve (có mâu thuẫn). */
  groupsResolved: number;
  /** Loser đã supersede theo ranking. */
  losersSuperseded: number;
  /** Loser chưa đủ điều kiện — vẫn active, chỉ bị hạ hạng lúc đọc. */
  losersDeferred: number;
  /** Fact hết hạn đã đóng mềm. */
  expiredSwept: number;
  /** Entity mồ côi (không fact nào trỏ tới) đã xoá. */
  orphanEntitiesPruned: number;
  /** Fact dream đã promote vào block human. */
  dreamPromoted: number;
  /** Episode dream đã xét. */
  dreamEpisodesSeen: number;
  healthBefore: MemoryHealth;
  healthAfter: MemoryHealth;
  /** Delta điểm sức khoẻ (dạng text, vd "điểm 62 → 74 (+12)"). */
  healthSummary: string;
  /** Log JSONL đã ghi (false khi không ghi được / không có workspaceDir). */
  logWritten: boolean;
  details: string[];
  /** Chi tiết dream pass (null khi bỏ qua bước dream). */
  dreamReport: ScoredDreamReport | null;
}

export interface ConsolidationV2LogEntry {
  at: string;
  actor: string;
  duplicatesMerged: number;
  groupsResolved: number;
  losersSuperseded: number;
  losersDeferred: number;
  expiredSwept: number;
  orphanEntitiesPruned: number;
  dreamPromoted: number;
  scoreBefore: number;
  scoreAfter: number;
}

/**
 * Dọn entity mồ côi: entity không còn fact nào (mọi status) trỏ
 * tới. Entity còn được fact superseded/deleted trỏ tới thì KHÔNG
 * xoá — lịch sử vẫn cần tên để hiển thị. Thuần logic trên store —
 * tách riêng để test được.
 */
export function pruneOrphanEntities(
  store: TemporalGraphStore,
  actor: string,
): { pruned: number; names: string[] } {
  void actor;
  const referenced = new Set<string>();
  for (const fact of store.listFacts({ limit: 20000 })) {
    referenced.add(fact.subjectId);
    if (fact.objectId) referenced.add(fact.objectId);
  }
  const names: string[] = [];
  let pruned = 0;
  for (const entity of store.listEntities()) {
    if (referenced.has(entity.id)) continue;
    try {
      if (store.removeEntity(entity.id)) {
        pruned += 1;
        names.push(entity.name);
      }
    } catch {
      // Entity đổi trạng thái giữa chừng — bỏ qua.
    }
  }
  return { pruned, names };
}

/**
 * Gộp fact trùng lặp chính xác: cùng (subjectId, predicate, object
 * chuẩn hoá), đang active. Keeper = confidence cao nhất (hoà thì
 * mới nhất). Thuần logic trên store — tách riêng để test được.
 */
export function mergeExactDuplicateFacts(
  store: TemporalGraphStore,
  scope: MemoryScope,
  actor: string,
): { merged: number; details: string[] } {
  const active = store.listFacts({ ...scope, status: 'active', limit: 20000 });
  const byKey = new Map<string, GraphFact[]>();
  for (const fact of active) {
    const key = [
      fact.subjectId,
      fact.predicate,
      normalizeGraphText(fact.objectText ?? ''),
    ].join('|');
    const list = byKey.get(key) ?? [];
    list.push(fact);
    byKey.set(key, list);
  }
  let merged = 0;
  const details: string[] = [];
  for (const [, members] of byKey) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.createdAt.localeCompare(a.createdAt);
    });
    const keeper = sorted[0];
    const duplicates = sorted.slice(1);
    if (!keeper) continue;
    const mergedIds = store.mergeFacts(
      keeper.id,
      duplicates.map((f) => f.id),
      actor,
    );
    if (mergedIds.length > 0) {
      merged += mergedIds.length;
      details.push(
        `Gộp ${mergedIds.length} fact trùng "${keeper.objectText ?? ''}" (${keeper.predicate}) vào fact giữ (confidence ${keeper.confidence.toFixed(2)}).`,
      );
    }
  }
  return { merged, details };
}

/** Chạy một lần consolidation v2 đầy đủ (6 bước, xem header). */
export async function runConsolidationV2(
  store: TemporalGraphStore,
  opts: ConsolidationV2Options,
): Promise<ConsolidationV2Report> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? 'system:consolidation-v2';
  const details: string[] = [];
  const healthBefore = computeMemoryHealth(store, opts.scope, now);

  // Bước 2: gộp trùng lặp chính xác.
  const dupes = mergeExactDuplicateFacts(store, opts.scope, actor);
  details.push(...dupes.details);

  // Bước 3: ranking ADD-only → supersede loser đủ điều kiện.
  const groups = resolveAddOnlyGroups(store, opts.scope, now);
  const contradictory = groups.filter((g) => g.hasContradiction);
  const ranking = applyRankingSupersession(store, contradictory, actor);
  details.push(...ranking.details);
  for (const deferred of ranking.deferred) {
    details.push(`Giữ lại fact thua (chưa supersede): ${deferred.reason}`);
  }

  // Bước 4: sweep fact hết hạn.
  const sweep = sweepExpiredFacts(store, opts.scope, opts.workspaceDir, now, actor);
  if (sweep.swept.length > 0) {
    details.push(`Sweep: đóng mềm ${sweep.swept.length} fact hết hạn (lịch sử vẫn truy vấn được).`);
  }

  // Bước 4b: dọn entity mồ côi (không fact nào còn trỏ tới).
  const prune = pruneOrphanEntities(store, actor);
  if (prune.pruned > 0) {
    details.push(`Dọn ${prune.pruned} entity mồ côi: ${prune.names.slice(0, 5).join(', ')}${prune.names.length > 5 ? ', …' : ''}.`);
  }

  // Bước 5: scored dream pass (nếu có blocksStore và không skip).
  let dreamReport: ScoredDreamReport | null = null;
  if (opts.skipDream !== true && opts.blocksStore) {
    try {
      dreamReport = await runScoredDreamPass(store, opts.blocksStore, {
        scope: opts.scope,
        now,
        ...(opts.dreamMinScore !== undefined ? { minScore: opts.dreamMinScore } : {}),
        ...(opts.dreamMaxPromote !== undefined ? { maxPromote: opts.dreamMaxPromote } : {}),
        actor: 'dream:consolidation-v2',
      });
      details.push(
        `Dream: xét ${dreamReport.episodesSeen} episode, promote ${dreamReport.promoted} fact vào block human.`,
      );
    } catch {
      details.push('Dream: chạy lỗi — bỏ qua bước dream, các bước khác vẫn hoàn tất.');
    }
  } else if (opts.skipDream !== true) {
    details.push('Dream: không có blocksStore — bỏ qua bước dream.');
  }

  // Bước 6: đo lại health + ghi log.
  const healthAfter = computeMemoryHealth(store, opts.scope, now);
  const delta = healthDelta(healthBefore, healthAfter);
  const report: ConsolidationV2Report = {
    ranAt: now.toISOString(),
    actor,
    duplicatesMerged: dupes.merged,
    groupsResolved: contradictory.length,
    losersSuperseded: ranking.superseded.length,
    losersDeferred: ranking.deferred.length,
    expiredSwept: sweep.swept.length,
    orphanEntitiesPruned: prune.pruned,
    dreamPromoted: dreamReport?.promoted ?? 0,
    dreamEpisodesSeen: dreamReport?.episodesSeen ?? 0,
    healthBefore,
    healthAfter,
    healthSummary: delta.summary,
    logWritten: false,
    details,
    dreamReport,
  };
  try {
    const dir = path.join(opts.workspaceDir, '.open-bot');
    fs.mkdirSync(dir, { recursive: true });
    const entry: ConsolidationV2LogEntry = {
      at: report.ranAt,
      actor,
      duplicatesMerged: report.duplicatesMerged,
      groupsResolved: report.groupsResolved,
      losersSuperseded: report.losersSuperseded,
      losersDeferred: report.losersDeferred,
      expiredSwept: report.expiredSwept,
      orphanEntitiesPruned: report.orphanEntitiesPruned,
      dreamPromoted: report.dreamPromoted,
      scoreBefore: healthBefore.score,
      scoreAfter: healthAfter.score,
    };
    fs.appendFileSync(
      path.join(opts.workspaceDir, MEMORY_CONSOLIDATION_V2_REL_PATH),
      JSON.stringify(entry) + '\n',
      { mode: 0o600 },
    );
    report.logWritten = true;
  } catch {
    report.logWritten = false;
  }
  return report;
}

/** Đọc N lần consolidation v2 gần nhất (bỏ dòng hỏng, không throw). */
export function readConsolidationV2Log(
  workspaceDir: string,
  limit = 20,
): ConsolidationV2LogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceDir, MEMORY_CONSOLIDATION_V2_REL_PATH), 'utf8');
  } catch {
    return [];
  }
  const out: ConsolidationV2LogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ConsolidationV2LogEntry;
      if (typeof parsed.at === 'string' && typeof parsed.scoreAfter === 'number') out.push(parsed);
    } catch {
      // Dòng hỏng — bỏ qua.
    }
  }
  const n = Math.min(Math.max(Math.floor(limit), 1), MAX_CONSOLIDATION_V2_LOG_LINES);
  return out.slice(-n).reverse();
}

/** Render report consolidation v2 thành markdown. */
export function consolidationV2ReportMarkdown(report: ConsolidationV2Report): string {
  const lines: string[] = [];
  lines.push(`# Consolidation v2 — ${report.ranAt.slice(0, 19).replace('T', ' ')}`);
  lines.push('');
  lines.push(`- Trùng lặp đã gộp: ${report.duplicatesMerged}.`);
  lines.push(`- Nhóm mâu thuẫn đã resolve: ${report.groupsResolved} (supersede ${report.losersSuperseded}, giữ lại ${report.losersDeferred}).`);
  lines.push(`- Fact hết hạn đã đóng mềm: ${report.expiredSwept}.`);
  lines.push(`- Entity mồ côi đã dọn: ${report.orphanEntitiesPruned}.`);
  lines.push(`- Dream: ${report.dreamEpisodesSeen} episode, promote ${report.dreamPromoted} fact.`);
  lines.push(`- Sức khoẻ: ${report.healthSummary}.`);
  if (report.details.length > 0) {
    lines.push('');
    lines.push('## Chi tiết');
    for (const detail of report.details) lines.push(`- ${detail}`);
  }
  return lines.join('\n');
}
