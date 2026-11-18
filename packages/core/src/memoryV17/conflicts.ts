/**
 * Memory v17 — Conflict detector + update resolver (v1.36, Doi T1).
 *
 * Y tuong hoc tu mem0 v3: extraction ADD-only nen moi fact moi mau thuan
 * voi fact cu deu phai qua conflict detector + update resolver truoc khi
 * ap dung; resolver co 3 cach: overwrite (fact moi thang, fact cu bi
 * invalid/superseded), merge (gop 2 gia tri thanh 1 fact moi), keep-both
 * (giu ca hai, danh dau cung ton tai). Moi quyet dinh kem provenance:
 * ai quyet dinh, luc nao, ly do gi — va KHONG bao gio xoa dong fact cu.
 *
 *  1. Phat hien: cung subject+edge don tri nhung object khac; phu dinh
 *     vs khang dinh (\"khong con thich pho\" vs \"thich pho\"); cua so
 *     valid time giao nhau nhung object khac; trung lap gan dung.
 *  2. Auto-resolve chi khi an toan: fact cu confidence thap (< gate)
 *     + fact moi confidence cao + khong phai single-valued quan trong,
 *     hoac user da chon strategy mac dinh. Con lai vao hang doi de
 *     user duyet (pending queue).
 *  3. Merge: chi gop duoc khi 2 object co the noi bang \", \" hoac
 *     \"/\" (vd 2 mon an yeu thich); single-valued khong merge duoc.
 *  4. Moi resolution ghi audit log day du (de UI / eval kiem tra lai).
 */

import {
  M17Error,
  M17Conflict,
  M17ExtractedFact,
  M17Fact,
  M17Resolution,
  M17ResolutionStrategy,
  M17Scope,
  M17_HIGH_CONFIDENCE_GATE,
  isSingleValuedEdgeM17,
  makeM17Id,
  normalizeCompareTextM17,
  scopesEqualM17,
  validWindowsOverlapM17,
} from './types';

/** Loi conflict resolver v17. */
export class M17ConflictError extends M17Error {
  constructor(message: string) {
    super(message);
    this.name = 'M17ConflictError';
  }
}

/** Strategy tu dong mac dinh theo loai xung dot. */
export type M17AutoStrategy = 'pending' | M17ResolutionStrategy;

/** Tuy chon detector. */
export interface M17ConflictDetectorOptions {
  /** Nguong confidence fact cu: >= nguong thi khong tu dong overwrite. */
  highConfidenceGate?: number;
  /** Strategy tu dong cho trung lap gan dung (mac dinh keep_both). */
  duplicateStrategy?: M17ResolutionStrategy;
  /** Strategy tu dong cho phu dinh vs khang dinh (mac dinh pending). */
  negationStrategy?: M17AutoStrategy;
}

/** Ket qua ap dung 1 resolution vao store (do store.ts thuc thi). */
export interface M17ResolutionEffect {
  /** Fact cu bi anh huong the nao: null = khong doi. */
  existingEffect: 'invalidated' | 'superseded' | 'merged' | 'kept' | null;
  /** Co can tao fact moi (merge / overwrite) khong. */
  createMergedFact: M17ExtractedFact | null;
  /** Co giu fact moi nhu 1 fact doc lap khong. */
  keepIncomingAsNew: boolean;
  /** Co loai bo fact moi khong. */
  dropIncoming: boolean;
}

/** Ban ghi audit cua 1 lan detect + resolve. */
export interface M17ConflictAuditEntry {
  conflictId: string;
  kind: M17Conflict['kind'];
  existingFactId: string;
  incomingSummary: string;
  strategy: M17ResolutionStrategy | 'pending';
  decidedBy: string;
  decidedAt: string;
  reason: string;
}

/**
 * Phat hien xung dot giua 1 candidate moi va danh sach fact cu dang
 * active trong cung scope. Chi xet fact active (invalid/superseded/
 * merged/quarantined khong gay xung dot nua).
 */
export function detectConflictsM17(
  incoming: M17ExtractedFact,
  existingActive: M17Fact[],
  scope: M17Scope,
  nowIso: string,
): M17Conflict[] {
  const conflicts: M17Conflict[] = [];
  const incomingObject = normalizeCompareTextM17(incoming.object);
  const incomingSubject = normalizeCompareTextM17(incoming.subject);
  for (const existing of existingActive) {
    if (!scopesEqualM17(existing.scope, scope)) continue;
    if (existing.status !== 'active') continue;
    if (normalizeCompareTextM17(existing.subject) !== incomingSubject) continue;
    // (Khong loc edge o day — buoc 2 xu ly cap prefers/dislikes cheo edge.)
    const existingObject = normalizeCompareTextM17(existing.object);
    // 1. Phu dinh (cung edge, cung object, candidate la negation): phai
    //    xet TRUOC duplicate — \"khong con thich X\" khong phai trung lap
    //    voi \"thich X\", ma la mau thuan voi no.
    if (incoming.isNegation && existing.edge === incoming.edge && existingObject === incomingObject) {
      conflicts.push({
        id: makeM17Id('cf'),
        incoming,
        existingFactId: existing.id,
        kind: 'negation_vs_positive',
        severity: 0.8,
        explanation:
          `Fact moi phu dinh fact cu (${existing.subject} —${existing.edge}→ ${existing.object} ` +
          `nhung gio noi khong con); can quyet dinh invalid fact cu hay giu ca hai.`,
        detectedAt: nowIso,
        scope: { ...scope },
      });
      continue;
    }
    // 2. Phu dinh cheo edge prefers <-> dislikes, cung object
    //    (vd extraction \"khong con thich pho\" -> dislikes vs \"thich pho\" cu).
    if (
      ((incoming.edge === 'dislikes' && existing.edge === 'prefers') ||
        (incoming.edge === 'prefers' && existing.edge === 'dislikes')) &&
      existingObject === incomingObject
    ) {
      conflicts.push({
        id: makeM17Id('cf'),
        incoming,
        existingFactId: existing.id,
        kind: 'negation_vs_positive',
        severity: 0.8,
        explanation:
          `Fact moi (${incoming.edge} ${incoming.object}) mau thuan voi fact cu ` +
          `(${existing.edge} ${existing.object}); can quyet dinh invalid fact cu hay giu ca hai.`,
        detectedAt: nowIso,
        scope: { ...scope },
      });
      continue;
    }
    // 3. Khac edge (khong phai cap prefers/dislikes) -> khong lien quan.
    if (existing.edge !== incoming.edge) continue;
    // 4. Trung lap hoan toan: cung object -> duplicate (khong phai xung dot that).
    if (existingObject === incomingObject) {
      conflicts.push({
        id: makeM17Id('cf'),
        incoming,
        existingFactId: existing.id,
        kind: 'duplicate',
        severity: 0.2,
        explanation:
          `Fact moi trung lap voi fact cu (${existing.subject} —${existing.edge}→ ${existing.object}); ` +
          'chi can tang confidence, khong can fact moi.',
        detectedAt: nowIso,
        scope: { ...scope },
      });
      continue;
    }
    // 5. Single-valued, object khac: xung dot that (vd song o Ha Noi -> song o Da Nang).
    if (isSingleValuedEdgeM17(incoming.edge)) {
      const overlaps = validWindowsOverlapM17(
        incoming.validFrom,
        incoming.validTo,
        existing.validFrom,
        existing.validTo,
      );
      conflicts.push({
        id: makeM17Id('cf'),
        incoming,
        existingFactId: existing.id,
        kind: overlaps ? 'temporal_overlap' : 'same_edge_different_object',
        severity: overlaps ? 0.9 : 0.75,
        explanation:
          `Edge don tri "${incoming.edge}": fact cu "${existing.object}" mau thuan voi ` +
          `fact moi "${incoming.object}"` +
          (overlaps ? ' trong cung khoang thoi gian.' : ' (khac khoang thoi gian).'),
        detectedAt: nowIso,
        scope: { ...scope },
      });
      continue;
    }
    // Multi-valued, object khac: khong xung dot (duoc phep nhieu gia tri).
    // Khong tao conflict — candidate duoc ADD binh thuong.
  }
  return conflicts;
}

/** Muc do nghiem trong cao nhat trong danh sach conflict. */
export function maxConflictSeverityM17(conflicts: M17Conflict[]): number {
  let max = 0;
  for (const conflict of conflicts) {
    if (conflict.severity > max) max = conflict.severity;
  }
  return max;
}

/** Co conflict nao can user duyet khong (severity >= 0.7 va chua auto-resolve). */
export function needsHumanReviewM17(conflicts: M17Conflict[]): boolean {
  return conflicts.some((c) => c.severity >= 0.7 && c.kind !== 'duplicate');
}

/**
 * Chon strategy tu dong cho 1 conflict (chi dung khi host bat auto).
 * Tra 'pending' khi khong du dieu kien tu dong — host dua vao hang doi.
 */
export function autoResolveStrategyM17(
  conflict: M17Conflict,
  existingConfidence: number,
  incomingConfidence: number,
  options: M17ConflictDetectorOptions = {},
): M17AutoStrategy {
  const gate = options.highConfidenceGate ?? M17_HIGH_CONFIDENCE_GATE;
  switch (conflict.kind) {
    case 'duplicate':
      return options.duplicateStrategy ?? 'keep_both';
    case 'negation_vs_positive': {
      if (options.negationStrategy && options.negationStrategy !== 'pending') {
        return options.negationStrategy;
      }
      return 'pending';
    }
    case 'same_edge_different_object':
    case 'temporal_overlap': {
      // Fact cu yeu + fact moi manh -> tu dong overwrite.
      if (existingConfidence < gate && incomingConfidence >= existingConfidence + 0.15) {
        return 'overwrite';
      }
      // Fact cu manh -> khong tu dong, cho user quyet.
      return 'pending';
    }
    default:
      return 'pending';
  }
}

/**
 * Tinh effect cua 1 resolution (thuan logic, khong cham store).
 * Store thuc thi effect nay (xem store.ts applyResolution).
 */
export function resolutionEffectM17(
  strategy: M17ResolutionStrategy,
  conflict: M17Conflict,
  existingObject = '',
): M17ResolutionEffect {
  switch (strategy) {
    case 'overwrite':
      return {
        existingEffect: 'superseded',
        createMergedFact: null,
        keepIncomingAsNew: true,
        dropIncoming: false,
      };
    case 'merge': {
      // Gop object CU + object MOI (khong phai gop object moi voi chinh no).
      const merged: M17ExtractedFact = {
        ...conflict.incoming,
        object: mergeObjectsM17(existingObject, conflict.incoming.object),
        confidence: Math.max(0.5, conflict.incoming.confidence),
      };
      return {
        existingEffect: 'merged',
        createMergedFact: merged,
        keepIncomingAsNew: false,
        dropIncoming: false,
      };
    }
    case 'keep_both':
      return {
        existingEffect: 'kept',
        createMergedFact: null,
        keepIncomingAsNew: true,
        dropIncoming: false,
      };
    case 'reject_incoming':
      return {
        existingEffect: 'kept',
        createMergedFact: null,
        keepIncomingAsNew: false,
        dropIncoming: true,
      };
    default:
      throw new M17ConflictError(`Strategy khong hop le: "${String(strategy)}".`);
  }
}

/** Gop 2 object thanh 1 chuoi (vd \"pho\" + \"bun bo\" -> \"pho, bun bo\"). */
export function mergeObjectsM17(existingObject: string, incomingObject: string): string {
  const parts: string[] = [];
  for (const part of [existingObject, incomingObject]) {
    const clean = part.trim();
    if (!clean) continue;
    const compare = normalizeCompareTextM17(clean);
    if (parts.some((p) => normalizeCompareTextM17(p) === compare)) continue;
    parts.push(clean);
  }
  return parts.join(', ');
}

/** Gop that: mergeObjectsM17 can ca object cu (khac voi resolutionEffect dung object moi 2 lan). */
export function mergeObjectsPairM17(existingObject: string, incomingObject: string): string {
  return mergeObjectsM17(existingObject, incomingObject);
}

/**
 * Kiem tra resolution hop le truoc khi ap dung:
 *  - merge chi cho multi-valued edge (single-valued khong gop duoc);
 *  - overwrite can ly do;
 *  - keep_both khong dung cho duplicate (duplicate thi tang confidence la du).
 */
export function validateResolutionM17(
  strategy: M17ResolutionStrategy,
  conflict: M17Conflict,
  reason: string,
): string | null {
  if (strategy === 'merge' && isSingleValuedEdgeM17(conflict.incoming.edge)) {
    return `Khong the merge edge don tri "${conflict.incoming.edge}" — hay dung overwrite hoac keep_both.`;
  }
  if (strategy === 'overwrite' && (!reason || !reason.trim())) {
    return 'Overwrite can ly do (provenance) — ghi ro tai sao fact moi thang.';
  }
  if (strategy === 'keep_both' && conflict.kind === 'duplicate') {
    return 'Duplicate khong can keep_both — hay dung reject_incoming (tang confidence fact cu la du).';
  }
  return null;
}

/** Tao ban ghi resolution (provenance day du). */
export function makeResolutionM17(
  conflictId: string,
  strategy: M17ResolutionStrategy,
  decidedBy: string,
  reason: string,
  nowIso: string,
  resultingFactId: string | null = null,
  affectedFactId: string | null = null,
): M17Resolution {
  return {
    conflictId,
    strategy,
    decidedBy,
    reason: reason.trim(),
    decidedAt: nowIso,
    resultingFactId,
    affectedFactId,
  };
}

/** Hang doi conflict cho duyet (pending queue) — in-memory, host serialize. */
export class M17ConflictQueue {
  private pending: M17Conflict[] = [];
  private audit: M17ConflictAuditEntry[] = [];
  private resolutions: M17Resolution[] = [];

  get pendingCount(): number {
    return this.pending.length;
  }

  get resolvedCount(): number {
    return this.resolutions.length;
  }

  /** Them conflict vao hang doi (dedupe theo incoming+existing). */
  enqueue(conflict: M17Conflict): boolean {
    const exists = this.pending.some(
      (c) =>
        c.existingFactId === conflict.existingFactId &&
        normalizeCompareTextM17(c.incoming.object) ===
          normalizeCompareTextM17(conflict.incoming.object) &&
        c.incoming.edge === conflict.incoming.edge,
    );
    if (exists) return false;
    this.pending.push(conflict);
    return true;
  }

  /** Them nhieu conflict, tra so moi them that. */
  enqueueMany(conflicts: M17Conflict[]): number {
    let added = 0;
    for (const conflict of conflicts) {
      if (this.enqueue(conflict)) added += 1;
    }
    return added;
  }

  /** Liet ke pending (muc do nghiem trong giam dan). */
  listPending(): M17Conflict[] {
    return [...this.pending].sort((a, b) => b.severity - a.severity);
  }

  /** Lay 1 pending theo id. */
  getPending(id: string): M17Conflict | null {
    return this.pending.find((c) => c.id === id) ?? null;
  }

  /** Danh dau da resolve: bo khoi pending, ghi resolution + audit. */
  resolve(
    conflictId: string,
    strategy: M17ResolutionStrategy,
    decidedBy: string,
    reason: string,
    nowIso: string,
    resultingFactId: string | null = null,
    affectedFactId: string | null = null,
  ): M17Resolution {
    const idx = this.pending.findIndex((c) => c.id === conflictId);
    if (idx < 0) throw new M17ConflictError(`Khong tim thay conflict dang cho: ${conflictId}.`);
    const conflict = this.pending[idx];
    const error = validateResolutionM17(strategy, conflict, reason);
    if (error) throw new M17ConflictError(error);
    this.pending.splice(idx, 1);
    const resolution = makeResolutionM17(
      conflictId,
      strategy,
      decidedBy,
      reason,
      nowIso,
      resultingFactId,
      affectedFactId,
    );
    this.resolutions.push(resolution);
    this.audit.push({
      conflictId,
      kind: conflict.kind,
      existingFactId: conflict.existingFactId,
      incomingSummary: `${conflict.incoming.subject} —${conflict.incoming.edge}→ ${conflict.incoming.object}`,
      strategy,
      decidedBy,
      decidedAt: nowIso,
      reason: reason.trim(),
    });
    return resolution;
  }

  /** Ghi audit cho auto-resolve (khong qua hang doi). */
  recordAuto(
    conflict: M17Conflict,
    strategy: M17ResolutionStrategy,
    reason: string,
    nowIso: string,
  ): M17Resolution {
    const resolution = makeResolutionM17(
      conflict.id,
      strategy,
      'auto',
      reason,
      nowIso,
      null,
      conflict.existingFactId,
    );
    this.resolutions.push(resolution);
    this.audit.push({
      conflictId: conflict.id,
      kind: conflict.kind,
      existingFactId: conflict.existingFactId,
      incomingSummary: `${conflict.incoming.subject} —${conflict.incoming.edge}→ ${conflict.incoming.object}`,
      strategy,
      decidedBy: 'auto',
      decidedAt: nowIso,
      reason: reason.trim(),
    });
    return resolution;
  }

  /** Lich su resolution (moi nhat truoc). */
  listResolutions(): M17Resolution[] {
    return [...this.resolutions].reverse();
  }

  /** Audit log (moi nhat truoc). */
  listAudit(): M17ConflictAuditEntry[] {
    return [...this.audit].reverse();
  }

  /** Serialize hang doi + audit. */
  serialize(): {
    pending: M17Conflict[];
    audit: M17ConflictAuditEntry[];
    resolutions: M17Resolution[];
  } {
    return {
      pending: this.pending.map((c) => ({ ...c, incoming: { ...c.incoming }, scope: { ...c.scope } })),
      audit: this.audit.map((a) => ({ ...a })),
      resolutions: this.resolutions.map((r) => ({ ...r })),
    };
  }

  /** Khoi phuc tu JSON. */
  deserialize(data: {
    pending?: M17Conflict[];
    audit?: M17ConflictAuditEntry[];
    resolutions?: M17Resolution[];
  }): void {
    this.pending = (data.pending ?? []).map((c) => ({
      ...c,
      incoming: { ...c.incoming },
      scope: { ...c.scope },
    }));
    this.audit = (data.audit ?? []).map((a) => ({ ...a }));
    this.resolutions = (data.resolutions ?? []).map((r) => ({ ...r }));
  }
}

/** Tom tat 1 conflict de hien thi (UI / log). */
export function describeConflictM17(conflict: M17Conflict): string {
  return (
    `[${conflict.kind} severity=${conflict.severity.toFixed(2)}] ` +
    `${conflict.incoming.subject} —${conflict.incoming.edge}→ ${conflict.incoming.object} ` +
    `mau thuan voi fact ${conflict.existingFactId}. ${conflict.explanation}`
  );
}
