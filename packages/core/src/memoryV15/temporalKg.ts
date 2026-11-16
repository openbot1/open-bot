/**
 * Memory v15 — Temporal KG v3 (v1.16, Doi T1).
 *
 * Y tuong hoc tu Zep/Graphiti (temporal KG bi-temporal: edge mang
 * validity interval; contradiction lam INVALID chu khong xoa) — tu
 * thiet ke lai hoan toan cho open-bot, chay 100% local, KHONG copy
 * code/text/tai san cua bat ky repo nao.
 *
 * Bi-temporal o day:
 *  - VALID time: validFrom / validUntil — fact DUNG trong khoang nao
 *    cua the gioi that.
 *  - TRANSACTION time: createdAt / updatedAt (+ invalidAt khi bi
 *    invalidate) — he thong BIET fact luc nao.
 *  Time-travel query tra loi ca hai chieu: "tai thoi diem T thi cai
 *  gi dung?" (valid time) va "luc Tx he thong da biet gi?" (tx time).
 *
 * Ke thua, khong viet lai:
 *  - `TemporalGraphStore.markFactInvalidated` (v1.12): v15 goi lai
 *    de danh dau invalidate (dong validUntil = invalidAt, ghi
 *    invalidAt/invalidatedBy/invalidationReason), khong tu sua field.
 *  - `isFactValidAtV14` / `factsValidAt` / `factTimelineV14` (v14):
 *    v15 dung lai cho query window co ban, them lop bi-temporal +
 *    phat hien mau thuan + time-travel len tren.
 *  - `isSingleValuedPredicateV15` (consolidation.ts): chi predicate
 *    DON TRI moi co the mau thuan that su (da tri thi gia tri moi
 *    song song gia tri cu).
 *
 * Luat v15:
 *  1. Khong bao gio xoa fact khi invalidate/supersede — chi dong cua
 *     so + ghi audit (invalidAt, ly do, actor).
 *  2. Mau thuan = 2 fact active cung (subject, predicate) don tri,
 *     khac object, cua so hieu luc CHONG NHAU. Fact thua la fact co
 *     confidence thap hon; hoa thi fact co validFrom som hon thua
 *     (thong tin moi hon thang).
 *  3. Invalidate 2 lan: lan 2 giu nguyen invalidAt dau tien (store
 *     dam bao), chi cap nhat ly do/actor.
 */

import type { GraphFact, MemoryScope } from '../memory/graph/types';
import { normalizeGraphText } from '../memory/graph/types';
import type { TemporalGraphStore } from '../memory/graph/store';
import type { ScopeFilter } from '../memory/graph/store';
import { isSingleValuedPredicateV15 } from './consolidation';

/** Loi temporal KG v15 — message tieng Viet. */
export class V15TemporalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V15TemporalError';
  }
}

/** Khoang bi-temporal cua mot fact. */
export interface V15BiTemporalInterval {
  /** Fact dung tu luc nao (valid time). */
  validFrom: string;
  /** Fact het dung luc nao (null = van dung; valid time). */
  validUntil: string | null;
  /** He thong biet fact tu luc nao (transaction time). */
  txFrom: string;
  /**
   * He thong ngung tin fact luc nao (null = van tin). Uoc luong
   * bang updatedAt khi fact bi supersede/invalidate (store khong
   * luu rieng moc supersession), nen chi dung de sap xep/hien thi,
   * khong dung de loc cung.
   */
  txTo: string | null;
}

/** Lay khoang bi-temporal cua mot fact. */
export function intervalOfFactV15(fact: GraphFact): V15BiTemporalInterval {
  const ended =
    fact.status === 'superseded' || fact.invalidAt !== undefined;
  return {
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    txFrom: fact.createdAt,
    txTo: ended ? fact.updatedAt : null,
  };
}

/**
 * Fact co dung tai thoi diem `at` khong — chi xet CUA SO (khong xet
 * status, de lich su superseded van tra loi duoc) + moc invalidate:
 * sau invalidAt thi fact da bi tuyen bo sai, khong con dung nua.
 * Fact deleted/quarantined luon sai.
 */
export function isFactValidAtV15(fact: GraphFact, at: string | Date = new Date()): boolean {
  if (fact.status === 'deleted' || fact.status === 'quarantined') return false;
  const atMs = at instanceof Date ? at.getTime() : Date.parse(at);
  if (Number.isNaN(atMs)) return false;
  if (Date.parse(fact.validFrom) > atMs) return false;
  if (fact.validUntil !== null && Date.parse(fact.validUntil) <= atMs) return false;
  if (fact.invalidAt !== undefined && Date.parse(fact.invalidAt) <= atMs) return false;
  return true;
}

/** Hai khoang valid-time co chong nhau khong (null = vo han). */
export function intervalsOverlapV15(
  a: { validFrom: string; validUntil: string | null },
  b: { validFrom: string; validUntil: string | null },
): boolean {
  const aFrom = Date.parse(a.validFrom);
  const bFrom = Date.parse(b.validFrom);
  const aTo = a.validUntil === null ? Infinity : Date.parse(a.validUntil);
  const bTo = b.validUntil === null ? Infinity : Date.parse(b.validUntil);
  return aFrom < bTo && bFrom < aTo;
}

/** Giao cua hai khoang valid-time (null = khong giao nhau). */
export function intervalIntersectionV15(
  a: { validFrom: string; validUntil: string | null },
  b: { validFrom: string; validUntil: string | null },
): { validFrom: string; validUntil: string | null } | null {
  if (!intervalsOverlapV15(a, b)) return null;
  const fromMs = Math.max(Date.parse(a.validFrom), Date.parse(b.validFrom));
  const aTo = a.validUntil === null ? Infinity : Date.parse(a.validUntil);
  const bTo = b.validUntil === null ? Infinity : Date.parse(b.validUntil);
  const toMs = Math.min(aTo, bTo);
  return {
    validFrom: new Date(fromMs).toISOString(),
    validUntil: toMs === Infinity ? null : new Date(toMs).toISOString(),
  };
}

export interface V15FactsValidAtOptions {
  predicate?: string;
  subject?: string;
  /** Gioi han so fact tra ve (mac dinh 500). */
  limit?: number;
}

export interface V15FactsValidAtResult {
  at: string;
  facts: { fact: GraphFact; subjectName: string; objectName?: string }[];
}

/** Tat ca fact DUNG tai thoi diem `at` (theo cua so + moc invalidate). */
export function factsValidAtV15(
  store: TemporalGraphStore,
  at: string | Date,
  filter: ScopeFilter = {},
  opts: V15FactsValidAtOptions = {},
): V15FactsValidAtResult {
  const atMs = at instanceof Date ? at.getTime() : Date.parse(at);
  if (Number.isNaN(atMs)) {
    throw new V15TemporalError('Thoi diem "at" khong phai ngay ISO hop le.');
  }
  const atIso = new Date(atMs).toISOString();
  const out: V15FactsValidAtResult['facts'] = [];
  for (const fact of store.listFacts({ ...filter, limit: 5000 })) {
    if (opts.predicate && fact.predicate !== opts.predicate) continue;
    const subjectName = store.getEntity(fact.subjectId)?.name ?? '';
    if (opts.subject && normalizeGraphText(subjectName) !== normalizeGraphText(opts.subject)) {
      continue;
    }
    if (!isFactValidAtV15(fact, atIso)) continue;
    out.push({
      fact,
      subjectName,
      ...(fact.objectId
        ? { objectName: store.getEntity(fact.objectId)?.name }
        : {}),
    });
  }
  out.sort((a, b) => Date.parse(a.fact.validFrom) - Date.parse(b.fact.validFrom));
  const limit = opts.limit ?? 500;
  return { at: atIso, facts: out.slice(0, Math.max(1, limit)) };
}

// ---------------------------------------------------------------------------
// Time-travel: valid time + transaction time
// ---------------------------------------------------------------------------

export interface V15TimeTravelOptions {
  /** Thoi diem the gioi that (valid time) — bat buoc. */
  validAt: string | Date;
  /** Thoi diem he thong (transaction time) — mac dinh: bay gio (biet het). */
  txAt?: string | Date;
  predicate?: string;
  subject?: string;
  limit?: number;
}

export interface V15TimeTravelResult {
  validAt: string;
  txAt: string;
  facts: { fact: GraphFact; subjectName: string; objectName?: string }[];
  /** So fact bi loai vi he thong CHUA biet tai txAt (createdAt > txAt). */
  excludedNotYetKnown: number;
  /** So fact bi loai vi da het hieu luc / bi invalidate truoc validAt. */
  excludedNotValid: number;
}

/**
 * Time-travel query: "tai thoi diem validAt thi cai gi dung, theo
 * nhung gi he thong da biet tai thoi diem txAt?"
 *  - validAt: loc cua so hieu luc (nhu factsValidAtV15).
 *  - txAt: chi giu fact co createdAt <= txAt (he thong chua biet
 *    fact thi khong the tra loi bang no).
 * Gioi han da biet: moc supersession khong duoc luu rieng trong
 * store (chi uoc luong qua updatedAt) nen txAt KHONG loc fact da
 * bi supersede truoc txAt — cua so validUntil cua fact cu van phan
 * anh dung viec no het dung tu luc nao.
 */
export function timeTravelQueryV15(
  store: TemporalGraphStore,
  filter: ScopeFilter,
  opts: V15TimeTravelOptions,
): V15TimeTravelResult {
  const validMs = opts.validAt instanceof Date ? opts.validAt.getTime() : Date.parse(opts.validAt);
  if (Number.isNaN(validMs)) {
    throw new V15TemporalError('validAt khong phai ngay ISO hop le.');
  }
  const txMs =
    opts.txAt === undefined
      ? Date.now()
      : opts.txAt instanceof Date
        ? opts.txAt.getTime()
        : Date.parse(opts.txAt);
  if (Number.isNaN(txMs)) {
    throw new V15TemporalError('txAt khong phai ngay ISO hop le.');
  }
  const validIso = new Date(validMs).toISOString();
  const txIso = new Date(txMs).toISOString();
  const out: V15TimeTravelResult['facts'] = [];
  let excludedNotYetKnown = 0;
  let excludedNotValid = 0;
  for (const fact of store.listFacts({ ...filter, limit: 5000 })) {
    if (opts.predicate && fact.predicate !== opts.predicate) continue;
    const subjectName = store.getEntity(fact.subjectId)?.name ?? '';
    if (opts.subject && normalizeGraphText(subjectName) !== normalizeGraphText(opts.subject)) {
      continue;
    }
    if (Date.parse(fact.createdAt) > txMs) {
      excludedNotYetKnown += 1;
      continue;
    }
    if (!isFactValidAtV15(fact, validIso)) {
      excludedNotValid += 1;
      continue;
    }
    out.push({
      fact,
      subjectName,
      ...(fact.objectId
        ? { objectName: store.getEntity(fact.objectId)?.name }
        : {}),
    });
  }
  out.sort((a, b) => Date.parse(a.fact.validFrom) - Date.parse(b.fact.validFrom));
  const limit = opts.limit ?? 500;
  return {
    validAt: validIso,
    txAt: txIso,
    facts: out.slice(0, Math.max(1, limit)),
    excludedNotYetKnown,
    excludedNotValid,
  };
}

// ---------------------------------------------------------------------------
// Contradiction: phat hien + invalidate (khong xoa)
// ---------------------------------------------------------------------------

/** Mot cap fact mau thuan nhau. */
export interface V15Contradiction {
  subject: string;
  predicate: string;
  factA: GraphFact;
  factB: GraphFact;
  /** Khoang thoi gian ca hai cung dung (mau thuan that su). */
  overlap: { validFrom: string; validUntil: string | null };
}

export interface V15ContradictionScanResult {
  contradictions: V15Contradiction[];
  scannedFacts: number;
  groupsChecked: number;
}

/**
 * Quet mau thuan: trong moi nhom (subject, predicate) DON TRI,
 * cap fact active nao khac object ma cua so hieu luc chong nhau
 * la mau thuan. Fact da het hieu luc / bi invalidate truoc khi
 * fact kia bat dau thi KHONG mau thuan (chung ke tiep nhau).
 */
export function findContradictionsV15(
  store: TemporalGraphStore,
  filter: ScopeFilter = {},
): V15ContradictionScanResult {
  const groups = new Map<
    string,
    { subject: string; predicate: string; facts: GraphFact[] }
  >();
  let scannedFacts = 0;
  for (const fact of store.listFacts({ ...filter, limit: 5000 })) {
    if (fact.status !== 'active') continue;
    if (fact.invalidAt !== undefined) continue;
    if (!isSingleValuedPredicateV15(fact.predicate)) continue;
    scannedFacts += 1;
    const subject = store.getEntity(fact.subjectId)?.name ?? '';
    const key = `${normalizeGraphText(subject)}|${fact.predicate}`;
    const g = groups.get(key) ?? { subject, predicate: fact.predicate, facts: [] };
    g.facts.push(fact);
    groups.set(key, g);
  }
  const contradictions: V15Contradiction[] = [];
  for (const g of groups.values()) {
    const facts = [...g.facts].sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom));
    for (let i = 0; i < facts.length; i += 1) {
      for (let j = i + 1; j < facts.length; j += 1) {
        const a = facts[i];
        const b = facts[j];
        if (
          normalizeGraphText(a.objectText ?? '') ===
          normalizeGraphText(b.objectText ?? '')
        ) {
          continue;
        }
        const overlap = intervalIntersectionV15(a, b);
        if (!overlap) continue;
        contradictions.push({
          subject: g.subject,
          predicate: g.predicate,
          factA: a,
          factB: b,
          overlap,
        });
      }
    }
  }
  return { contradictions, scannedFacts, groupsChecked: groups.size };
}

/** Fact nao thua trong mot cap mau thuan (thap confidence hon; hoa thi cu hon thua). */
export function loserOfContradictionV15(
  c: V15Contradiction,
): { loser: GraphFact; winner: GraphFact; reason: string } {
  const { factA, factB } = c;
  if (factA.confidence !== factB.confidence) {
    const loser = factA.confidence < factB.confidence ? factA : factB;
    const winner = loser === factA ? factB : factA;
    return {
      loser,
      winner,
      reason: `Confidence ${loser.confidence} < ${winner.confidence}.`,
    };
  }
  const loser =
    Date.parse(factA.validFrom) <= Date.parse(factB.validFrom) ? factA : factB;
  const winner = loser === factA ? factB : factA;
  return {
    loser,
    winner,
    reason:
      'Hoa confidence — thong tin moi hon (validFrom muon hon) thang, fact cu bi invalidate.',
  };
}

export interface V15InvalidateOptions {
  /** Thoi diem tuyen bo sai (mac dinh: bay gio). */
  at?: string | Date;
  actor?: string;
}

/**
 * Invalidate mot fact vi mau thuan: dong cua so tai `at`, ghi
 * invalidAt/invalidatedBy/invalidationReason, KHONG xoa fact.
 * Fact van tra loi duoc "dung tai T" voi T < invalidAt.
 */
export function invalidateFactV15(
  store: TemporalGraphStore,
  factId: string,
  conflictingFactId: string,
  opts: V15InvalidateOptions = {},
): GraphFact {
  const atMs =
    opts.at === undefined
      ? Date.now()
      : opts.at instanceof Date
        ? opts.at.getTime()
        : Date.parse(opts.at);
  if (Number.isNaN(atMs)) {
    throw new V15TemporalError('Thoi diem invalidate khong phai ngay hop le.');
  }
  const fact = store.getFact(factId);
  if (!fact) throw new V15TemporalError('Khong tim thay fact can invalidate.');
  const conflicting = store.getFact(conflictingFactId);
  const conflictText = conflicting
    ? `"${conflicting.objectText ?? ''}" (${conflicting.id})`
    : conflictingFactId;
  return store.markFactInvalidated(factId, {
    invalidAt: new Date(atMs).toISOString(),
    actor: (opts.actor ?? '').trim() || 'system',
    reason: `Mau thuan voi fact ${conflictText} cung (${fact.predicate}) — cua so hieu luc chong nhau.`,
  });
}

export interface V15ContradictionResolution {
  contradiction: V15Contradiction;
  invalidated: GraphFact;
  kept: GraphFact;
  reason: string;
}

export interface V15ScanAndInvalidateResult {
  scanned: V15ContradictionScanResult;
  resolved: V15ContradictionResolution[];
  skippedAlreadyInvalid: number;
}

/**
 * Quet + invalidate toan bo mau thuan trong scope: moi cap chi
 * invalidate fact thua (fact thang giu nguyen). Fact da co invalidAt
 * thi bo qua (khong invalidate lai).
 */
export function scanAndInvalidateContradictionsV15(
  store: TemporalGraphStore,
  filter: ScopeFilter = {},
  opts: V15InvalidateOptions = {},
): V15ScanAndInvalidateResult {
  const scanned = findContradictionsV15(store, filter);
  const resolved: V15ContradictionResolution[] = [];
  let skippedAlreadyInvalid = 0;
  const alreadyInvalidated = new Set<string>();
  for (const c of scanned.contradictions) {
    const { loser, winner, reason } = loserOfContradictionV15(c);
    if (loser.invalidAt !== undefined || alreadyInvalidated.has(loser.id)) {
      skippedAlreadyInvalid += 1;
      continue;
    }
    // Chi invalidate khi moc invalidate nam trong cua so hieu luc
    // cua fact thua (store chan invalidAt ngoai cua so).
    const atMs =
      opts.at === undefined
        ? Date.now()
        : opts.at instanceof Date
          ? opts.at.getTime()
          : Date.parse(opts.at);
    const invalidAtMs = Math.max(atMs, Date.parse(loser.validFrom));
    if (loser.validUntil !== null && invalidAtMs >= Date.parse(loser.validUntil)) {
      skippedAlreadyInvalid += 1;
      continue;
    }
    const invalidated = invalidateFactV15(store, loser.id, winner.id, {
      ...opts,
      at: new Date(invalidAtMs).toISOString(),
    });
    alreadyInvalidated.add(loser.id);
    resolved.push({ contradiction: c, invalidated, kept: winner, reason });
  }
  return { scanned, resolved, skippedAlreadyInvalid };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface V15TimelineStep {
  fact: GraphFact;
  subjectName: string;
  objectText: string;
  interval: V15BiTemporalInterval;
  status: GraphFact['status'];
  invalidated: boolean;
  supersedes?: string;
  supersededBy?: string;
}

/** Lich su day du cua mot (subject, predicate), sap theo validFrom. */
export function factTimelineV15(
  store: TemporalGraphStore,
  subject: string,
  predicate: string,
  filter: ScopeFilter = {},
): V15TimelineStep[] {
  const subjectNorm = normalizeGraphText(subject);
  const steps: V15TimelineStep[] = [];
  for (const fact of store.listFacts({ ...filter, predicate, limit: 5000 })) {
    if (fact.status === 'deleted' || fact.status === 'quarantined') continue;
    const subjectName = store.getEntity(fact.subjectId)?.name ?? '';
    if (normalizeGraphText(subjectName) !== subjectNorm) continue;
    steps.push({
      fact,
      subjectName,
      objectText: fact.objectText ?? '',
      interval: intervalOfFactV15(fact),
      status: fact.status,
      invalidated: fact.invalidAt !== undefined,
      ...(fact.supersedes ? { supersedes: fact.supersedes } : {}),
      ...(fact.supersededBy ? { supersededBy: fact.supersededBy } : {}),
    });
  }
  steps.sort((a, b) => Date.parse(a.interval.validFrom) - Date.parse(b.interval.validFrom));
  return steps;
}

/** Render timeline thanh text de doc (tool/UI). */
export function formatTimelineV15(
  steps: V15TimelineStep[],
  subject: string,
  predicate: string,
): string {
  if (steps.length === 0) return `Khong co lich su cho (${subject}, ${predicate}).`;
  const lines = [`Lich su (${subject}, ${predicate}):`];
  for (const s of steps) {
    const until = s.interval.validUntil ?? 'nay';
    const flag = s.invalidated ? ' [INVALIDATED]' : s.status === 'superseded' ? ' [superseded]' : '';
    lines.push(
      `  ${s.interval.validFrom.slice(0, 10)} -> ${until === 'nay' ? 'nay' : until.slice(0, 10)}: ` +
        `${s.objectText} (conf ${s.fact.confidence})${flag}`,
    );
  }
  return lines.join('\n');
}

export function defaultV15Scope(): MemoryScope {
  return { userId: '', botId: '', runId: '' };
}
