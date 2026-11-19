/**
 * Memory v24 — decay / forgetting policy (v1.39, Doi T1).
 *
 * Y tuong R083 building blocks (chi y tuong): decay/forgetting —
 * memory cu, khong duoc dung thi mo dan roi quen; quan trong thi
 * quen cham; dung lai thi nho lai (revive).
 *
 * Tu thiet ke lai hoan toan cho open-bot, cong thuc xac dinh:
 *  - Retention = importance-adjusted exponential decay:
 *    newConfidence = confidence * 0.5^(ageDays / halfLifeDays),
 *    half-life theo kind (note 30 ngay, project 90, fact 180,
 *    preference/decision/lesson 365).
 *  - Access boost: moi lan duoc retrieval tra ve, confidence
 *    + accessBoost (toi da maxConfidence) va lastAccessedAt
 *    duoc cap nhat — memory hay duoc dung kho quen.
 *  - Stale: confidence < staleThreshold (0.15) -> danh dau
 *    stale (van retrieval duoc nhung giam uu tien).
 *  - Archive: confidence < archiveThreshold (0.05) -> archived
 *    (khong retrieval nua, van giu de audit/khoi phuc).
 *  - Expired: qua expiresAt -> expired (archive luon, khong
 *    phu thuoc confidence).
 *  - Revive: fact/lesson stale duoc access lai -> confidence
 *    tang ve tren nguong, status tro lai active.
 *  - KHONG xoa vat ly: archive/expired chi doi status.
 */
import {
  clamp01V24,
  isoAtV24,
  parseIsoV24,
  type V24DecayOutcome,
  type V24DecayPolicy,
  type V24Fact,
  type V24Lesson,
  type V24RecordKind,
  V24_DEFAULT_DECAY_POLICY,
} from './types';

const DAY_MS = 24 * 3600 * 1000;

/** Tinh confidence sau decay theo tuoi (ngay) va half-life. */
export function decayedConfidenceV24(
  confidence: number,
  ageDays: number,
  halfLifeDays: number,
): number {
  if (ageDays <= 0) return confidence;
  if (halfLifeDays <= 0) return 0;
  const factor = Math.pow(0.5, ageDays / halfLifeDays);
  return clamp01V24(confidence * factor);
}

/** Tuoi (ngay) cua 1 fact/lesson tinh tu lastAccessedAt (fallback learnedAt/createdAt). */
export function ageDaysV24(sinceIso: string | null, fallbackIso: string, nowMs: number): number {
  const since = parseIsoV24(sinceIso)?.getTime() ?? parseIsoV24(fallbackIso)?.getTime();
  if (since === null || since === undefined) return 0;
  return Math.max(0, (nowMs - since) / DAY_MS);
}

/** Ap dung decay cho 1 fact: tra fact moi + outcome (khong sua fact goc). */
export function applyDecayToFactV24(
  fact: V24Fact,
  policy: V24DecayPolicy = V24_DEFAULT_DECAY_POLICY,
  nowMs: number = Date.now(),
): { fact: V24Fact; outcome: V24DecayOutcome } {
  const base: V24DecayOutcome = {
    id: fact.id,
    kind: fact.kind,
    oldConfidence: fact.confidence,
    newConfidence: fact.confidence,
    action: 'unchanged',
    detail: '',
  };
  if (fact.status === 'archived' || fact.status === 'invalidated' || fact.status === 'superseded' || fact.status === 'merged') {
    return { fact, outcome: { ...base, detail: `Fact ${fact.id} o status ${fact.status}, khong decay nua.` } };
  }
  // Het han luu tru -> expired (archive luon).
  const expiresAt = parseIsoV24(fact.expiresAt)?.getTime();
  if (expiresAt !== null && expiresAt !== undefined && nowMs > expiresAt) {
    const updated: V24Fact = { ...fact, status: 'archived', confidence: fact.confidence };
    return {
      fact: updated,
      outcome: { ...base, action: 'expired', detail: `Fact ${fact.id} het han ${fact.expiresAt} -> archived.` },
    };
  }
  const halfLife = policy.halfLifeDaysByKind[fact.kind] ?? 180;
  const age = ageDaysV24(fact.lastAccessedAt, fact.learnedAt, nowMs);
  const next = decayedConfidenceV24(fact.confidence, age, halfLife);
  const updated: V24Fact = { ...fact, confidence: next };
  if (next < policy.archiveThreshold) {
    updated.status = 'archived';
    return {
      fact: updated,
      outcome: { ...base, newConfidence: next, action: 'archived', detail: `Fact ${fact.id} confidence ${next.toFixed(2)} < ${policy.archiveThreshold} sau ${Math.round(age)} ngay khong dung -> archived.` },
    };
  }
  if (next < policy.staleThreshold) {
    if (fact.status !== 'quarantined') updated.status = fact.status;
    return {
      fact: updated,
      outcome: { ...base, newConfidence: next, action: 'stale', detail: `Fact ${fact.id} confidence ${next.toFixed(2)} < ${policy.staleThreshold} sau ${Math.round(age)} ngay -> stale (van retrieval duoc).` },
    };
  }
  if (Math.abs(next - fact.confidence) < 0.001) {
    return { fact: updated, outcome: { ...base, newConfidence: next, detail: `Fact ${fact.id} chua du tuoi de decay.` } };
  }
  return {
    fact: updated,
    outcome: { ...base, newConfidence: next, action: 'decayed', detail: `Fact ${fact.id} decay ${fact.confidence.toFixed(2)} -> ${next.toFixed(2)} sau ${Math.round(age)} ngay.` },
  };
}

/** Ap dung decay cho 1 lesson. */
export function applyDecayToLessonV24(
  lesson: V24Lesson,
  policy: V24DecayPolicy = V24_DEFAULT_DECAY_POLICY,
  nowMs: number = Date.now(),
): { lesson: V24Lesson; outcome: V24DecayOutcome } {
  const base: V24DecayOutcome = {
    id: lesson.id,
    kind: 'lesson',
    oldConfidence: lesson.confidence,
    newConfidence: lesson.confidence,
    action: 'unchanged',
    detail: '',
  };
  if (lesson.status === 'archived' || lesson.status === 'retracted' || lesson.status === 'superseded') {
    return { lesson, outcome: { ...base, detail: `Lesson ${lesson.id} o status ${lesson.status}, khong decay nua.` } };
  }
  const expiresAt = parseIsoV24(lesson.expiresAt)?.getTime();
  if (expiresAt !== null && expiresAt !== undefined && nowMs > expiresAt) {
    const updated: V24Lesson = { ...lesson, status: 'archived' };
    return {
      lesson: updated,
      outcome: { ...base, action: 'expired', detail: `Lesson ${lesson.id} het han ${lesson.expiresAt} -> archived.` },
    };
  }
  const halfLife = policy.halfLifeDaysByKind.lesson;
  const age = ageDaysV24(lesson.lastAppliedAt, lesson.createdAt, nowMs);
  const next = decayedConfidenceV24(lesson.confidence, age, halfLife);
  const updated: V24Lesson = { ...lesson, confidence: next };
  if (next < policy.archiveThreshold) {
    updated.status = 'archived';
    return {
      lesson: updated,
      outcome: { ...base, newConfidence: next, action: 'archived', detail: `Lesson ${lesson.id} confidence ${next.toFixed(2)} < ${policy.archiveThreshold} -> archived.` },
    };
  }
  if (next < policy.staleThreshold) {
    return {
      lesson: updated,
      outcome: { ...base, newConfidence: next, action: 'stale', detail: `Lesson ${lesson.id} confidence ${next.toFixed(2)} < ${policy.staleThreshold} -> stale.` },
    };
  }
  if (Math.abs(next - lesson.confidence) < 0.001) {
    return { lesson: updated, outcome: { ...base, newConfidence: next, detail: `Lesson ${lesson.id} chua du tuoi de decay.` } };
  }
  return {
    lesson: updated,
    outcome: { ...base, newConfidence: next, action: 'decayed', detail: `Lesson ${lesson.id} decay ${lesson.confidence.toFixed(2)} -> ${next.toFixed(2)} sau ${Math.round(age)} ngay.` },
  };
}

/** Ghi nhan 1 lan access: tang confidence (boost) + cap nhat lastAccessedAt. */
export function recordAccessFactV24(
  fact: V24Fact,
  policy: V24DecayPolicy = V24_DEFAULT_DECAY_POLICY,
  nowMs: number = Date.now(),
): { fact: V24Fact; outcome: V24DecayOutcome } {
  const boosted = clamp01V24(Math.min(policy.maxConfidence, fact.confidence + policy.accessBoost));
  const revived = fact.confidence < policy.staleThreshold && boosted >= policy.staleThreshold;
  const updated: V24Fact = {
    ...fact,
    confidence: boosted,
    accessCount: fact.accessCount + 1,
    lastAccessedAt: isoAtV24(nowMs),
  };
  return {
    fact: updated,
    outcome: {
      id: fact.id,
      kind: fact.kind,
      oldConfidence: fact.confidence,
      newConfidence: boosted,
      action: revived ? 'revived' : 'unchanged',
      detail: revived
        ? `Fact ${fact.id} duoc dung lai -> revive ${fact.confidence.toFixed(2)} -> ${boosted.toFixed(2)}.`
        : `Fact ${fact.id} access #${updated.accessCount}, confidence ${fact.confidence.toFixed(2)} -> ${boosted.toFixed(2)}.`,
    },
  };
}

/** Lich trinh review tiep theo cho 1 fact (khi nao can decay lai). */
export function nextReviewAtV24(
  fact: V24Fact,
  policy: V24DecayPolicy = V24_DEFAULT_DECAY_POLICY,
  nowMs: number = Date.now(),
): string {
  const halfLife = policy.halfLifeDaysByKind[fact.kind] ?? 180;
  // Review lai sau 1/4 half-life (du som de bat stale som).
  const reviewInMs = Math.max(DAY_MS, (halfLife * DAY_MS) / 4);
  return isoAtV24(nowMs + reviewInMs);
}

/** Loai record nao duoc phep quen nhanh nhat (de UI sap xep). */
export function forgettingOrderV24(kinds: V24RecordKind[]): V24RecordKind[] {
  const policy = V24_DEFAULT_DECAY_POLICY;
  return [...kinds].sort(
    (a, b) => (policy.halfLifeDaysByKind[a] ?? 180) - (policy.halfLifeDaysByKind[b] ?? 180),
  );
}
