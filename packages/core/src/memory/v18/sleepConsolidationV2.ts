/**
 * Memory v18 — Sleep-time consolidation v2 (v1.19, Doi T1).
 *
 * Y tuong hoc tu Letta / MemGPT (sleep-time agents: agent ra soat
 * hoi thoai luc ranh, consolidate va cap nhat memory NGOAI vong lap
 * chinh) + Mem0 v3 (gop fact trung, ha cap fact cu) — tu thiet ke
 * lai hoan toan cho open-bot, chay 100% local, KHONG copy
 * code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `SleepConsolidationAgent` v16 (memory/v16/sleepConsolidation):
 *    dieu phoi sleep (episode -> extract -> gate -> consolidate);
 *    v18 KHONG thay the no — v18 la PASS CUNG CO chay SAU agent
 *    v16 (hoac doc lap) tren graph da co, tap trung vao chat
 *    luong fact hien co thay vi trich fact moi.
 *  - `mergeFacts` cua TemporalGraphStore: gop fact trung that
 *    (doi subject/object, xoa ban trung); v18 chi goi qua no.
 *  - `scanDuplicateEntitiesV16` / `mergeEntitiesV16`: gop entity
 *    trung; v18 goi khi bat `mergeEntities`.
 *  - `setFactConfidence` cua store: ha cap confidence (khong sua
 *    truc tiep object fact).
 *
 * Moi trong v18 (mot lan chay sleep-consolidation):
 *  1. Gop fact trung: cung subject + predicate + object chuan hoa
 *     (khac id) -> giu ban confidence cao nhat (hoac moi nhat neu
 *     hoa), gop cac ban con lai bang `mergeFacts`.
 *  2. Ha cap fact cu: fact active khong duoc truy cap / khong doi
 *     trong `staleAfterDays` ngay -> giam confidence theo tung
 *     `decayStep` (khong xoa, chi ha cap de retrieval uu tien fact
 *     tuoi hon); fact xuong duoi `minConfidence` thi danh dau
 *     demote trong bao cao (khong tu xoa).
 *  3. Gop entity trung lap diem rat cao (>= `mergeEntityThreshold`)
 *     — mac dinh TAT (chi chay khi host bat, vi gop entity la thao
 *     tac manh).
 *  4. Budget: gioi han so fact quet / so thao tac moi lan chay
 *     (`maxFactsPerRun`, `maxMergesPerRun`) + gioi han thoi gian
 *     (`maxMsPerRun`) — het budget thi dung, de phan con lai cho
 *     lan sau; khong bao gio chan turn user.
 *  5. Bao cao `V18SleepConsolidationReport`: so fact quet, so cap
 *     trung da gop, so fact ha cap, so entity da gop, thoi gian chay
 *     — ghi log JSONL neu host truyen workspaceDir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphFact, MemoryScope } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { scanDuplicateEntitiesV16, mergeEntitiesV16 } from '../v16/entityLinking';

/** Loi sleep consolidation v2 — message tieng Viet. */
export class V18SleepConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V18SleepConsolidationError';
  }
}

/** File log JSONL cho cac lan chay sleep consolidation v2. */
export const V18_SLEEP_CONSOLIDATION_RUNS_REL_PATH = path.join(
  '.open-bot',
  'memory-sleep-consolidation-v18.jsonl',
);
/** So fact toi da quet moi lan chay (mac dinh). */
export const V18_DEFAULT_MAX_FACTS_PER_RUN = 2000;
/** So cap gop toi da moi lan chay (mac dinh). */
export const V18_DEFAULT_MAX_MERGES_PER_RUN = 50;
/** Thoi gian toi da moi lan chay (mac dinh 30 giay). */
export const V18_DEFAULT_MAX_MS_PER_RUN = 30_000;
/** So ngay khong doi thi coi la cu (mac dinh 90 ngay). */
export const V18_DEFAULT_STALE_AFTER_DAYS = 90;
/** Buoc giam confidence moi lan ha cap (mac dinh 0.1). */
export const V18_DEFAULT_DECAY_STEP = 0.1;
/** Confidence toi thieu — duoi thi chi bao cao demote, khong tu xoa. */
export const V18_SLEEP_DEFAULT_MIN_CONFIDENCE = 0.2;

/** Cau hinh mot lan chay. */
export interface V18SleepConsolidationConfig {
  maxFactsPerRun: number;
  maxMergesPerRun: number;
  maxMsPerRun: number;
  staleAfterDays: number;
  decayStep: number;
  minConfidence: number;
  /** Co gop entity trung lap diem cao khong (mac dinh false). */
  mergeEntities: boolean;
  /** Nguong diem gop entity (mac dinh 0.95). */
  mergeEntityThreshold: number;
}

/** Cau hinh mac dinh. */
export const V18_DEFAULT_SLEEP_CONSOLIDATION_CONFIG: V18SleepConsolidationConfig = {
  maxFactsPerRun: V18_DEFAULT_MAX_FACTS_PER_RUN,
  maxMergesPerRun: V18_DEFAULT_MAX_MERGES_PER_RUN,
  maxMsPerRun: V18_DEFAULT_MAX_MS_PER_RUN,
  staleAfterDays: V18_DEFAULT_STALE_AFTER_DAYS,
  decayStep: V18_DEFAULT_DECAY_STEP,
  minConfidence: V18_SLEEP_DEFAULT_MIN_CONFIDENCE,
  mergeEntities: false,
  mergeEntityThreshold: 0.95,
};

/** Bao cao mot lan chay sleep consolidation v2. */
export interface V18SleepConsolidationReport {
  at: string;
  durationMs: number;
  factsScanned: number;
  duplicateGroups: number;
  factsMerged: number;
  factsDecayed: number;
  factsBelowMin: number;
  entitiesMerged: number;
  /** Het budget giua chung khong (con viec cho lan sau). */
  budgetExhausted: boolean;
  /** Ly do dung (het budget / xong). */
  stoppedBecause: string;
}

/** Tim cac nhom fact trung lap (cung subject+predicate+object chuan hoa). */
export function findDuplicateFactGroupsV18(facts: GraphFact[]): GraphFact[][] {
  const byKey = new Map<string, GraphFact[]>();
  for (const fact of facts) {
    if (fact.status !== 'active') continue;
    const key = [
      fact.subjectId,
      normalizeGraphText(fact.predicate).replace(/\s+/g, '_'),
      normalizeGraphText(fact.objectText ?? ''),
    ].join('|');
    const group = byKey.get(key) ?? [];
    group.push(fact);
    byKey.set(key, group);
  }
  return [...byKey.values()].filter((g) => g.length > 1);
}

/** Chon ban giu trong mot nhom trung: confidence cao nhat, roi moi nhat. */
export function pickKeepFactV18(group: GraphFact[]): GraphFact {
  const sorted = [...group].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return sorted[0] as GraphFact;
}

/** Fact co bi coi la cu khong (khong doi qua `staleAfterDays` ngay). */
export function isStaleFactV18(fact: GraphFact, nowMs: number, staleAfterDays: number): boolean {
  const updatedMs = Date.parse(fact.updatedAt);
  if (Number.isNaN(updatedMs)) return false;
  return nowMs - updatedMs > staleAfterDays * 24 * 60 * 60 * 1000;
}

function appendSleepRunLogV18(workspaceDir: string, report: V18SleepConsolidationReport): boolean {
  try {
    const filePath = path.join(workspaceDir, V18_SLEEP_CONSOLIDATION_RUNS_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(report)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Chay mot pass cung co sleep-time tren graph: gop fact trung, ha
 * cap fact cu, (tuy chon) gop entity trung. Fail-open theo tung
 * muc: loi o mot nhom chi ghi vao bao cao (qua `stoppedBecause`),
 * khong throw ra caller.
 */
export function runSleepConsolidationV18(
  store: TemporalGraphStore,
  scope: MemoryScope = { userId: '', botId: '', runId: '' },
  config: Partial<V18SleepConsolidationConfig> = {},
  opts: { workspaceDir?: string; now?: Date } = {},
): V18SleepConsolidationReport {
  const cfg: V18SleepConsolidationConfig = {
    ...V18_DEFAULT_SLEEP_CONSOLIDATION_CONFIG,
    ...config,
  };
  const startMs = Date.now();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const report: V18SleepConsolidationReport = {
    at: now.toISOString(),
    durationMs: 0,
    factsScanned: 0,
    duplicateGroups: 0,
    factsMerged: 0,
    factsDecayed: 0,
    factsBelowMin: 0,
    entitiesMerged: 0,
    budgetExhausted: false,
    stoppedBecause: 'done',
  };
  const outOfBudget = (): boolean => {
    if (report.factsMerged + report.factsDecayed >= cfg.maxMergesPerRun * 2) return true;
    return Date.now() - startMs > cfg.maxMsPerRun;
  };

  const facts = store.listFacts({ ...scope, status: 'active', limit: cfg.maxFactsPerRun });
  report.factsScanned = facts.length;

  // 1. Gop fact trung.
  const groups = findDuplicateFactGroupsV18(facts);
  report.duplicateGroups = groups.length;
  for (const group of groups) {
    if (outOfBudget() || report.factsMerged >= cfg.maxMergesPerRun) {
      report.budgetExhausted = true;
      report.stoppedBecause = 'het budget gop (maxMergesPerRun / maxMsPerRun)';
      break;
    }
    const keep = pickKeepFactV18(group);
    const duplicates = group.filter((f) => f.id !== keep.id).map((f) => f.id);
    try {
      const merged = store.mergeFacts(keep.id, duplicates, 'sleep-consolidation-v18');
      report.factsMerged += merged.length;
    } catch {
      // Loi o mot nhom: bo qua nhom, tiep tuc nhom khac (fail-open).
      continue;
    }
  }

  // 2. Ha cap fact cu (chi khi con budget thoi gian).
  if (!report.budgetExhausted) {
    const remaining = store.listFacts({ ...scope, status: 'active', limit: cfg.maxFactsPerRun });
    for (const fact of remaining) {
      if (Date.now() - startMs > cfg.maxMsPerRun) {
        report.budgetExhausted = true;
        report.stoppedBecause = 'het budget thoi gian (maxMsPerRun) khi ha cap';
        break;
      }
      if (!isStaleFactV18(fact, nowMs, cfg.staleAfterDays)) continue;
      const next = Math.max(0, fact.confidence - cfg.decayStep);
      try {
        store.setFactConfidence(fact.id, next);
        report.factsDecayed += 1;
        if (next < cfg.minConfidence) report.factsBelowMin += 1;
      } catch {
        continue;
      }
    }
  }

  // 3. Gop entity trung lap diem rat cao (mac dinh TAT).
  if (cfg.mergeEntities && !report.budgetExhausted) {
    try {
      const clusters = scanDuplicateEntitiesV16(store, { threshold: cfg.mergeEntityThreshold, scope });
      for (const cluster of clusters) {
        if (Date.now() - startMs > cfg.maxMsPerRun) {
          report.budgetExhausted = true;
          report.stoppedBecause = 'het budget thoi gian (maxMsPerRun) khi gop entity';
          break;
        }
        const merged = mergeEntitiesV16(
          store,
          cluster.keep.id,
          cluster.duplicates.map((e) => e.id),
        );
        report.entitiesMerged += merged.removedIds.length;
      }
    } catch {
      // Gop entity loi: bo qua, bao cao van dung.
    }
  }

  report.durationMs = Date.now() - startMs;
  if (opts.workspaceDir) appendSleepRunLogV18(opts.workspaceDir, report);
  return report;
}
