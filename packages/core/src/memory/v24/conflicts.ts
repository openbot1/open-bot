/**
 * Memory v24 — conflict detection + resolution (v1.39, Doi T1).
 *
 * Y tuong Graphiti/Zep (chi y tuong): temporal knowledge graph —
 * fact co thoi gian, biet fact nao da thay doi; xung dot duoc
 * giai quyet co provenance day du, fact cu danh dau invalid thay
 * vi xoa.
 *
 * Tu thiet ke lai hoan toan cho open-bot:
 *  - detect(incoming, existingFacts): tim xung dot — cung
 *    subject+edge khac object (single-valued), phu dinh vs
 *    khang dinh, valid-time giao nhau, trung lap (duplicate).
 *  - resolveAuto(conflict, existing): chon strategy theo rule
 *    xac dinh (khong doan mo): incoming confidence cao + existing
 *    thap -> supersede; existing confidence cao (>= 0.8) ->
 *    keep_both (de retrieval phan xu) hoac reject neu la phu
 *    dinh yeu; duplicate -> merge; ca 2 thap + mau thuan ->
 *    quarantine_both.
 *  - Moi resolution ghi V24Resolution day du: ai quyet, luc nao,
 *    vi sao, fact nao bi anh huong, valid-time moi, evidence.
 *  - Resolver KHONG xoa fact: supersede = tao fact moi + danh
 *    dau fact cu superseded (giu lich su); merge = tao fact moi
 *    gop + danh dau ca 2 fact goc merged.
 */
import {
  clamp01V24,
  isoAtV24,
  makeV24Id,
  normalizeTextV24,
  validWindowsOverlapV24,
  isSingleValuedEdgeV24,
  type V24Conflict,
  type V24ConflictKind,
  type V24ExtractedFact,
  type V24Fact,
  type V24Resolution,
  type V24ResolutionStrategy,
  type V24Scope,
  V24_HIGH_CONFIDENCE_GATE,
} from './types';

/** Fact cu co mau thuan voi candidate khong — tra loai xung dot. */
export function classifyConflictV24(
  incoming: V24ExtractedFact,
  existing: V24Fact,
): V24ConflictKind | null {
  if (existing.status !== 'active') return null;
  const sameSubject = normalizeTextV24(existing.subject) === normalizeTextV24(incoming.subject);
  if (!sameSubject) return null;
  const sameEdge = existing.edge === incoming.edge;
  const sameObject = normalizeTextV24(existing.object) === normalizeTextV24(incoming.object);
  if (sameEdge && sameObject) {
    // Cung triple: duplicate (ke ca khi valid-time khac nhau).
    return 'duplicate';
  }
  if (incoming.isNegation && sameEdge && !sameObject) {
    return 'negation_vs_positive';
  }
  if (sameEdge && !sameObject && isSingleValuedEdgeV24(incoming.edge)) {
    // Cung predicate don tri, object khac nhau. Chi goi la
    // temporal_overlap khi it nhat 1 ben co khoang valid-time
    // cu the va 2 khoang giao nhau; neu ca 2 deu khong ro
    // thoi gian thi la doi gia tri thong thuong.
    const bounded =
      existing.validFrom !== null || existing.validTo !== null ||
      incoming.validFrom !== null || incoming.validTo !== null;
    if (
      bounded &&
      validWindowsOverlapV24(existing.validFrom, existing.validTo, incoming.validFrom, incoming.validTo)
    ) {
      return 'temporal_overlap';
    }
    return 'same_edge_different_object';
  }
  if (sameEdge && !sameObject && incoming.kind === 'lesson') {
    return 'lesson_contradicts';
  }
  return null;
}

/** Phat hien tat ca xung dot cua 1 candidate voi danh sach fact active. */
export function detectConflictsV24(
  incoming: V24ExtractedFact,
  existingFacts: V24Fact[],
  scope: V24Scope,
  opts: { nowMs?: number } = {},
): V24Conflict[] {
  const nowMs = opts.nowMs ?? Date.now();
  const out: V24Conflict[] = [];
  for (const existing of existingFacts) {
    const kind = classifyConflictV24(incoming, existing);
    if (!kind) continue;
    const severity = computeSeverityV24(incoming, existing, kind);
    out.push({
      id: makeV24Id('cf'),
      incoming: { ...incoming, mentionedEntities: [...incoming.mentionedEntities] },
      existingFactId: existing.id,
      kind,
      severity,
      explanation: explainConflictV24(incoming, existing, kind),
      detectedAt: isoAtV24(nowMs),
      scope: { ...scope },
      validTimeOverlaps:
        (existing.validFrom !== null || existing.validTo !== null ||
          incoming.validFrom !== null || incoming.validTo !== null) &&
        validWindowsOverlapV24(
          existing.validFrom, existing.validTo, incoming.validFrom, incoming.validTo,
        ),
    });
  }
  // Nghiem trong nhat truoc; duplicate xu ly dau tien khi resolve.
  out.sort((a, b) => b.severity - a.severity);
  return out;
}

/** Muc do nghiem trong 0..1 theo loai + do tin cay 2 ben. */
export function computeSeverityV24(
  incoming: V24ExtractedFact,
  existing: V24Fact,
  kind: V24ConflictKind,
): number {
  const base: Record<V24ConflictKind, number> = {
    same_edge_different_object: 0.7,
    negation_vs_positive: 0.8,
    temporal_overlap: 0.6,
    duplicate: 0.3,
    lesson_contradicts: 0.75,
  };
  const confGap = Math.abs(incoming.confidence - existing.confidence);
  return clamp01V24(base[kind] + confGap * 0.2);
}

/** Giai thich xung dot bang tieng Viet, de nguoi doc hieu. */
export function explainConflictV24(
  incoming: V24ExtractedFact,
  existing: V24Fact,
  kind: V24ConflictKind,
): string {
  const old = `${existing.subject} ${existing.edge} ${existing.object}`;
  const next = `${incoming.subject} ${incoming.edge} ${incoming.object}`;
  switch (kind) {
    case 'duplicate':
      return `Trung lap: "${next}" da co trong memory (${existing.id}).`;
    case 'negation_vs_positive':
      return `Phu dinh: moi "${next}" phu dinh cu "${old}".`;
    case 'temporal_overlap':
      return `Chong lan thoi gian: moi "${next}" chong voi cu "${old}" trong cung khoang hieu luc.`;
    case 'same_edge_different_object':
      return `Doi gia tri: "${old}" -> "${next}" (cung predicate don tri).`;
    case 'lesson_contradicts':
      return `Lesson mau thuan: moi "${next}" mau thuan voi "${old}".`;
  }
}

/** Chon strategy tu dong theo rule xac dinh (giai thich duoc). */
export function decideResolutionV24(
  conflict: V24Conflict,
  existing: V24Fact,
): { strategy: V24ResolutionStrategy; reason: string } {
  const incoming = conflict.incoming;
  if (conflict.kind === 'duplicate') {
    return {
      strategy: 'merge',
      reason: `Trung lap — gop "${incoming.object}" vao fact cu ${existing.id} (giu provenance ca 2).`,
    };
  }
  if (conflict.kind === 'negation_vs_positive') {
    if (incoming.confidence >= V24_HIGH_CONFIDENCE_GATE) {
      return {
        strategy: 'supersede',
        reason: `Phu dinh tin cay cao (${incoming.confidence}) — fact cu ${existing.id} het hieu luc tu nay.`,
      };
    }
    return {
      strategy: 'keep_both',
      reason: `Phu dinh tin cay thap (${incoming.confidence}) — giu ca 2, de retrieval phan xu theo valid-time.`,
    };
  }
  if (conflict.kind === 'temporal_overlap') {
    return {
      strategy: 'supersede',
      reason: `Valid-time giao nhau — fact moi thang khoang hieu luc moi, fact cu ${existing.id} bi thu hep.`,
    };
  }
  if (conflict.kind === 'same_edge_different_object') {
    if (existing.confidence >= V24_HIGH_CONFIDENCE_GATE && incoming.confidence < existing.confidence) {
      return {
        strategy: 'keep_both',
        reason: `Fact cu tin cay cao (${existing.confidence}) — khong tu dong ghi de, giu ca 2 de retrieval phan xu.`,
      };
    }
    if (incoming.confidence >= existing.confidence) {
      return {
        strategy: 'supersede',
        reason: `Fact moi tin cay hon (${incoming.confidence} >= ${existing.confidence}) — thay the fact cu ${existing.id}.`,
      };
    }
    return {
      strategy: 'reject_incoming',
      reason: `Fact moi tin cay thap hon fact cu (${incoming.confidence} < ${existing.confidence}) — tu choi.`,
    };
  }
  // lesson_contradicts
  if (incoming.confidence >= V24_HIGH_CONFIDENCE_GATE) {
    return {
      strategy: 'quarantine_both',
      reason: 'Lesson mau thuan tin cay cao — cach ly ca 2 cho nguoi duyet, khong tu dong chon 1 ben.',
    };
  }
  return {
    strategy: 'keep_both',
    reason: 'Lesson mau thuan tin cay thap — giu ca 2 kem evidence de retrieval phan xu.',
  };
}

/** Tao ban ghi resolution (provenance day du) tu 1 quyet dinh. */
export function buildResolutionV24(
  conflict: V24Conflict,
  strategy: V24ResolutionStrategy,
  opts: {
    decidedBy?: string;
    reason?: string;
    resultingFactId?: string | null;
    affectedFactId?: string | null;
    resultingValidFrom?: string | null;
    resultingValidTo?: string | null;
    evidenceIds?: string[];
    nowMs?: number;
  } = {},
): V24Resolution {
  return {
    conflictId: conflict.id,
    strategy,
    decidedBy: opts.decidedBy ?? 'auto',
    reason: opts.reason ?? `Auto-resolve ${conflict.kind} -> ${strategy}.`,
    decidedAt: isoAtV24(opts.nowMs ?? Date.now()),
    resultingFactId: opts.resultingFactId ?? null,
    affectedFactId: opts.affectedFactId ?? conflict.existingFactId,
    resultingValidFrom: opts.resultingValidFrom ?? conflict.incoming.validFrom,
    resultingValidTo: opts.resultingValidTo ?? conflict.incoming.validTo,
    evidenceIds: opts.evidenceIds ?? [],
  };
}

/** Resolve 1 conflict tu dong: tra strategy + resolution (chua ap dung vao store). */
export function resolveConflictAutoV24(
  conflict: V24Conflict,
  existing: V24Fact,
  opts: { nowMs?: number } = {},
): { strategy: V24ResolutionStrategy; resolution: V24Resolution } {
  const decided = decideResolutionV24(conflict, existing);
  const resolution = buildResolutionV24(conflict, decided.strategy, {
    decidedBy: 'auto',
    reason: decided.reason,
    nowMs: opts.nowMs,
  });
  return { strategy: decided.strategy, resolution };
}

/** Loc conflict mo: chua co resolution (dung o store/pipeline). */
export function openConflictsV24(
  conflicts: V24Conflict[],
  resolutions: V24Resolution[],
): V24Conflict[] {
  const resolved = new Set(resolutions.map((r) => r.conflictId));
  return conflicts.filter((c) => !resolved.has(c.id));
}
