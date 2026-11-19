/**
 * Memory v23 — health check (v1.38, Doi T1).
 *
 * Kiem tra suc khoe store v23 (offline, chi doc — khong sua store):
 *  - Orphan embedding: record co embedding nhung text da doi sau
 *    lan embed cuoi (embeddingKind con nhung embedding bi xoa khi
 *    update text — store tu xu ly; check nay bat truong hop lac).
 *  - Stale ratio: ty le record active da qua validTo / confidence
 *    duoi nguong song.
 *  - Scope leak: record o scope hep (run) nhung khong co userId/
 *    agentId tuong ung (scope mo ho — retrieval co the hieu sai).
 *  - Low-confidence ratio: ty le record active confidence < 0.4.
 *  - Duplicate cluster: so cap gan trung lap (Jaccard >= 0.85)
 *    ma sleep chua gop.
 *  - Skill health: skill active co success rate thap / rating thap
 *    ma chua bi deprecate (de reviewDeprecations lo).
 *
 * Moi issue co muc do (info / warning / critical) + goi y hanh
 * dong. Health check dung cho tool stats, sleep report va UI.
 */

import { jaccardV23, todayIsoV23 } from './types';
import type { V23MemoryStore } from './store';
import type { V23ProceduralStore } from './procedural';

/** Muc do issue. */
export type V23HealthSeverity = 'info' | 'warning' | 'critical';

/** Mot issue suc khoe. */
export interface V23HealthIssue {
  severity: V23HealthSeverity;
  code: string;
  /** Mo ta ngan gon, doc duoc. */
  detail: string;
  /** Id record/skill lien quan (neu co). */
  refIds: string[];
  /** Goi y hanh dong (vd "chay sleep v2", "chay embedMissing"). */
  suggestion: string;
}

/** Bao cao suc khoe day du. */
export interface V23HealthReport {
  /** Tong so record / skill da quet. */
  recordsScanned: number;
  skillsScanned: number;
  /** Ty le record active con hieu luc (0..1). */
  healthyRatio: number;
  issues: V23HealthIssue[];
  /** Tom tat so issue theo muc do. */
  counts: { info: number; warning: number; critical: number };
  ranAt: number;
}

/** Nguong mac dinh cho health check. */
export interface V23HealthOptions {
  /** Confidence duoi nguong nay = low-confidence (mac dinh 0.4). */
  lowConfidenceThreshold?: number;
  /** Ty le low-confidence vuot nguong nay -> warning (mac dinh 0.3). */
  lowConfidenceRatioWarn?: number;
  /** Ty le stale vuot nguong nay -> warning (mac dinh 0.2). */
  staleRatioWarn?: number;
  /** Jaccard de tinh cap trung lap (mac dinh 0.85). */
  duplicateThreshold?: number;
  /** So cap trung lap vuot nguong nay -> warning (mac dinh 5). */
  duplicatePairsWarn?: number;
  /** Success rate skill duoi nguong nay = kem (mac dinh 0.4). */
  skillLowRateThreshold?: number;
  /** Ham lay thoi gian (test truyen clock co dinh). */
  now?: () => number;
}

/** Dem cap gan trung lap trong danh sach text (ghi nhan cap dau tien moi record). */
export function findDuplicatePairsV23(
  records: { id: string; text: string }[],
  threshold = 0.85,
): { a: string; b: string; similarity: number }[] {
  const pairs: { a: string; b: string; similarity: number }[] = [];
  const used = new Set<string>();
  for (let i = 0; i < records.length; i += 1) {
    if (used.has(records[i].id)) continue;
    for (let j = i + 1; j < records.length; j += 1) {
      if (used.has(records[j].id)) continue;
      const sim = jaccardV23(records[i].text, records[j].text);
      if (sim >= threshold) {
        pairs.push({ a: records[i].id, b: records[j].id, similarity: Math.round(sim * 100) / 100 });
        used.add(records[j].id);
        break;
      }
    }
  }
  return pairs;
}

/**
 * Chay health check tren store v23 (+ skill store neu co).
 * Chi doc — khong sua bat ky record/skill nao.
 */
export function checkV23Health(
  store: V23MemoryStore,
  skillStore?: V23ProceduralStore,
  opts: V23HealthOptions = {},
): V23HealthReport {
  const now = opts.now?.() ?? Date.now();
  const today = todayIsoV23(now);
  const lowConfThreshold = opts.lowConfidenceThreshold ?? 0.4;
  const lowConfRatioWarn = opts.lowConfidenceRatioWarn ?? 0.3;
  const staleRatioWarn = opts.staleRatioWarn ?? 0.2;
  const duplicateThreshold = opts.duplicateThreshold ?? 0.85;
  const duplicatePairsWarn = opts.duplicatePairsWarn ?? 5;
  const skillLowRate = opts.skillLowRateThreshold ?? 0.4;

  const issues: V23HealthIssue[] = [];
  const actives = store.listActive();
  const total = store.size(false);
  let staleCount = 0;
  let lowConfCount = 0;
  let missingEmbedding = 0;
  let scopeLeakCount = 0;

  for (const record of actives) {
    if (record.validTo && today > record.validTo) staleCount += 1;
    if (record.confidence < lowConfThreshold) lowConfCount += 1;
    if (!record.embedding) missingEmbedding += 1;
    // Scope hep nhung thieu scope cha: run co nhung khong co agent/user.
    if (record.scope.runId && !record.scope.agentId && !record.scope.userId) {
      scopeLeakCount += 1;
      issues.push({
        severity: 'warning',
        code: 'scope-ambiguous',
        detail: `Record ${record.id} co runId nhung khong co agentId/userId — scope mo ho.`,
        refIds: [record.id],
        suggestion: 'Gan them agentId/userId cho record, hoac dua ve scope rong.',
      });
    }
    // Record co embeddingKind nhung khong co vector (lac trang thai).
    if (record.embeddingKind && record.embeddingKind !== 'none' && !record.embedding) {
      issues.push({
        severity: 'warning',
        code: 'orphan-embedding-kind',
        detail: `Record ${record.id} ghi embeddingKind=${record.embeddingKind} nhung khong co vector.`,
        refIds: [record.id],
        suggestion: 'Chay embedMissing de gan lai embedding, hoac xoa embeddingKind.',
      });
    }
  }

  const activeCount = actives.length;
  if (activeCount > 0) {
    const staleRatio = staleCount / activeCount;
    if (staleRatio > staleRatioWarn) {
      issues.push({
        severity: 'warning',
        code: 'stale-ratio-high',
        detail: `${staleCount}/${activeCount} record active da qua validTo (${Math.round(staleRatio * 100)}%).`,
        refIds: [],
        suggestion: 'Chay sleep v2 de danh dau stale / archive record het han.',
      });
    }
    const lowConfRatio = lowConfCount / activeCount;
    if (lowConfRatio > lowConfRatioWarn) {
      issues.push({
        severity: 'info',
        code: 'low-confidence-ratio-high',
        detail: `${lowConfCount}/${activeCount} record active confidence < ${lowConfThreshold} (${Math.round(lowConfRatio * 100)}%).`,
        refIds: [],
        suggestion: 'Xem lai nguon extract / tang minConfidence cua extractor.',
      });
    }
    if (missingEmbedding > 0) {
      issues.push({
        severity: 'info',
        code: 'missing-embeddings',
        detail: `${missingEmbedding}/${activeCount} record active chua co embedding (fusion chi dung BM25 + entity).`,
        refIds: [],
        suggestion: 'Chay embedMissing (can Ollama) de bo sung embedding.',
      });
    }
  }

  const dupPairs = findDuplicatePairsV23(
    actives.map((r) => ({ id: r.id, text: r.text })),
    duplicateThreshold,
  );
  if (dupPairs.length > duplicatePairsWarn) {
    issues.push({
      severity: 'warning',
      code: 'duplicate-clusters',
      detail: `${dupPairs.length} cap record gan trung lap (Jaccard >= ${duplicateThreshold}) chua duoc gop.`,
      refIds: dupPairs.slice(0, 10).flatMap((p) => [p.a, p.b]),
      suggestion: 'Chay sleep v2 de merge cac cap trung lap.',
    });
  } else if (dupPairs.length > 0) {
    issues.push({
      severity: 'info',
      code: 'duplicate-clusters',
      detail: `${dupPairs.length} cap record gan trung lap (Jaccard >= ${duplicateThreshold}).`,
      refIds: dupPairs.slice(0, 10).flatMap((p) => [p.a, p.b]),
      suggestion: 'Chay sleep v2 de merge khi ranh.',
    });
  }

  let skillsScanned = 0;
  if (skillStore) {
    const skills = skillStore.listSkills({});
    skillsScanned = skills.length;
    for (const skill of skills) {
      if (skill.status !== 'active' && skill.status !== 'candidate') continue;
      if (skill.totalCount >= 5 && skill.successRate < skillLowRate) {
        issues.push({
          severity: 'warning',
          code: 'skill-low-success-rate',
          detail: `Skill ${skill.id} success rate ${skill.successRate} sau ${skill.totalCount} lan chay.`,
          refIds: [skill.id],
          suggestion: 'Chay skill review (deprecate) hoac cai tien steps roi tang version.',
        });
      }
      if (skill.ratingCount >= 3 && skill.rating > 0 && skill.rating < 2) {
        issues.push({
          severity: 'warning',
          code: 'skill-low-rating',
          detail: `Skill ${skill.id} rating ${skill.rating} sau ${skill.ratingCount} luot.`,
          refIds: [skill.id],
          suggestion: 'Chay skill review (deprecate) hoac hoi user ly do cham thap.',
        });
      }
    }
  }

  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;
  const unhealthy = staleCount + lowConfCount;
  const healthyRatio = activeCount === 0
    ? 1
    : Math.round((1 - unhealthy / activeCount) * 1000) / 1000;

  return {
    recordsScanned: total,
    skillsScanned,
    healthyRatio: Math.max(0, healthyRatio),
    issues,
    counts: { info: infoCount, warning: warningCount, critical: criticalCount },
    ranAt: now,
  };
}

/** Tom tat mot dong cho log/UI: "v23 health: X record, Y warning, Z info". */
export function summarizeV23Health(report: V23HealthReport): string {
  return (
    `v23 health: ${report.recordsScanned} record (${report.skillsScanned} skill), ` +
    `healthy ${Math.round(report.healthyRatio * 100)}%, ` +
    `${report.counts.critical} critical, ${report.counts.warning} warning, ${report.counts.info} info.`
  );
}
