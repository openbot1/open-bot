/**
 * Memory v18 — Temporal KG bi-temporal v2 (v1.19, Doi T1).
 *
 * Y tuong hoc tu Zep / Graphiti (bi-temporal: thoi diem fact dung
 * trong the gioi — valid time — tach biet thoi diem he thong hoc
 * duoc no — transaction/learned time) — tu thiet ke lai hoan toan
 * cho open-bot, chay 100% local, KHONG copy code/text/tai san cua
 * bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `GraphFact` da la bi-temporal: `validFrom` / `validUntil`
 *    (truc the gioi) + `createdAt` / `updatedAt` (truc he thong).
 *  - `queryFactsAtBiTemporal` cua memory/graph/biTemporal: tra loi
 *    "fact dung tai T theo tri thuc da biet tai R"; v18 goi lai,
 *    khong viet lai logic hai truc.
 *  - `factVersionTimeline` / `edgeValidityIntervals`:
 *    timeline phien ban cua mot fact/edge; v18 dung de ve timeline
 *    hieu chinh.
 *  - `TemporalGraphStore.supersedeFact` / `setFactValidity`:
 *    thao tac dong/mo cua so hieu luc duy nhat; v18 chi goi qua
 *    chung, khong sua truc tiep object fact.
 *
 * Moi trong v18:
 *  1. `V18BiTemporalView` — mot fact nhin theo hai truc: `validAt`
 *     (fact dung trong the gioi luc nao) + `learnedAt` (he thong
 *     hoc duoc luc nao = `createdAt`) + `knownAt` (tai thoi diem
 *     truy van R, fact nay da biet chua) — de UI phan biet "dung
 *     tu 2020" voi "moi biet tu hom qua".
 *  2. `V18CorrectionRecord` — ban ghi hieu chinh: fact cu -> fact
 *     moi (supersede), ly do, bang chung, actor, thoi diem hieu
 *     chinh; luu trong bo nho + serialize JSON (`toJson`).
 *  3. `applyCorrectionV18` — hieu chinh mot fact: tao fact moi
 *     (gia tri dung) bang `supersedeFact`, dong cua so cua ban cu
 *     tai thoi diem hieu chinh, ghi correction record; ban cu van
 *     truy van duoc o qua khu.
 *  4. `snapshotAtV18` — anh chup tri thuc "da biet tai R ve thoi
 *     diem T": goi `queryFactsAtBiTemporal`, tra ve kem thong ke
 *     (bao nhieu fact dang hieu luc, bao nhieu da bi thay the sau
 *     do) — phuc vu audit quyet dinh agent trong qua khu.
 *  5. `correctionTimelineV18` — timeline hieu chinh cua mot edge
 *     (subject —predicate→ *): cac buoc valid/learned xep theo
 *     thoi gian, kem ly do moi buoc.
 */

import type { GraphFact, MemoryScope } from '../graph/types';
import { factDisplayText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import type { AddFactInput } from '../graph/store';
import {
  queryFactsAtBiTemporal,
  factVersionTimeline,
} from '../graph/biTemporal';
import type { FactAtBiTemporalTime, FactVersionStep } from '../graph/biTemporal';

/** Loi bi-temporal v2 — message tieng Viet. */
export class V18BiTemporalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V18BiTemporalError';
  }
}

function parseMsV18(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function nowIsoV18(): string {
  return new Date().toISOString();
}

/** Mot fact nhin theo hai truc thoi gian. */
export interface V18BiTemporalView {
  fact: GraphFact;
  subjectName: string;
  objectName?: string;
  /** Fact dung trong the gioi tu luc nay (validFrom). */
  validAt: string;
  /** Fact het dung trong the gioi luc nay (validUntil, null = con dung). */
  validUntil: string | null;
  /** He thong hoc duoc fact nay luc nay (= createdAt). */
  learnedAt: string;
  /** Tai thoi diem truy van R, fact da duoc biet chua. */
  knownAtRecordTime: boolean;
  /** Fact co dang la phien ban hien tai cua edge tai R khong. */
  currentAtRecordTime: boolean;
}

/** Ban ghi hieu chinh mot fact. */
export interface V18CorrectionRecord {
  id: string;
  /** Fact cu (bi thay the). */
  oldFactId: string;
  /** Fact moi (gia tri dung). */
  newFactId: string;
  subjectName: string;
  predicate: string;
  oldObjectText: string;
  newObjectText: string;
  /** Ly do hieu chinh (vd mau thuan voi bang chung moi). */
  reason: string;
  /** Bang chung (text ngan, tuy chon). */
  evidence: string;
  actor: string;
  /** Thoi diem hieu chinh (ISO) — cung la luc dong cua so ban cu. */
  correctedAt: string;
}

/** Anh chup tri thuc tai (T, R). */
export interface V18BiTemporalSnapshot {
  at: string;
  recordedAt: string;
  facts: V18BiTemporalView[];
  /** So fact dang hieu luc tai T theo tri thuc tai R. */
  currentCount: number;
  /** So fact tung dung tai T nhung tai R da biet la cu. */
  supersededCount: number;
}

/** Mot buoc trong timeline hieu chinh cua mot edge. */
export interface V18CorrectionTimelineStep {
  factId: string;
  objectText: string;
  validFrom: string;
  validUntil: string | null;
  learnedAt: string;
  status: string;
  /** Ly do hieu chinh dan toi buoc nay (neu co). */
  correctionReason: string | null;
}

let v18BiTemporalSeq = 0;
function nextV18CorrectionId(): string {
  v18BiTemporalSeq += 1;
  return `corr-${Date.now().toString(36)}-${v18BiTemporalSeq}`;
}

/**
 * Chuyen mot ket qua `queryFactsAtBiTemporal` thanh view v18
 * (them `learnedAt` = createdAt, `knownAtRecordTime`).
 */
export function toBiTemporalViewV18(
  row: FactAtBiTemporalTime,
  recordedAtMs: number,
): V18BiTemporalView {
  return {
    fact: row.fact,
    subjectName: row.subjectName,
    ...(row.objectName ? { objectName: row.objectName } : {}),
    validAt: row.fact.validFrom,
    validUntil: row.fact.validUntil,
    learnedAt: row.fact.createdAt,
    knownAtRecordTime: parseMsV18(row.fact.createdAt) <= recordedAtMs,
    currentAtRecordTime: row.currentAtRecordTime,
  };
}

/**
 * Anh chup tri thuc "da biet tai R ve thoi diem T" (goi ham
 * bi-temporal co san, them thong ke current/superseded).
 */
export function snapshotAtV18(
  store: TemporalGraphStore,
  at: string | Date,
  opts: { recordedAt?: string | Date; scope?: MemoryScope; limit?: number } = {},
): V18BiTemporalSnapshot {
  const atDate = at instanceof Date ? at : new Date(at);
  const recordedDate =
    opts.recordedAt === undefined
      ? new Date()
      : opts.recordedAt instanceof Date
        ? opts.recordedAt
        : new Date(opts.recordedAt);
  if (Number.isNaN(atDate.getTime()) || Number.isNaN(recordedDate.getTime())) {
    throw new V18BiTemporalError('Thoi gian truy van khong hop le.');
  }
  const rows = queryFactsAtBiTemporal(store, atDate, {
    recordedAt: recordedDate,
    scope: opts.scope,
    limit: opts.limit,
  });
  const facts = rows.map((r) => toBiTemporalViewV18(r, recordedDate.getTime()));
  return {
    at: atDate.toISOString(),
    recordedAt: recordedDate.toISOString(),
    facts,
    currentCount: facts.filter((f) => f.currentAtRecordTime).length,
    supersededCount: facts.filter((f) => !f.currentAtRecordTime).length,
  };
}

/**
 * Hieu chinh mot fact: tao fact moi (gia tri dung) thay the ban cu.
 * Ban cu duoc dong cua so tai `correctedAt` (qua `supersedeFact`),
 * lich su truoc do van truy van duoc. Tra ve fact moi + record.
 */
export function applyCorrectionV18(
  store: TemporalGraphStore,
  oldFactId: string,
  correction: {
    newObjectText: string;
    reason: string;
    evidence?: string;
    actor: string;
    correctedAt?: string | Date;
    validFrom?: string;
    confidence?: number;
  },
): { fact: GraphFact; record: V18CorrectionRecord } {
  const oldFact = store.getFact(oldFactId);
  if (!oldFact) throw new V18BiTemporalError(`Khong tim thay fact "${oldFactId}" de hieu chinh.`);
  const newObjectText = (correction.newObjectText ?? '').trim();
  if (newObjectText === '') throw new V18BiTemporalError('Gia tri moi sau hieu chinh khong duoc rong.');
  if (newObjectText === oldFact.objectText) {
    throw new V18BiTemporalError('Gia tri moi giong gia tri cu — khong co gi de hieu chinh.');
  }
  const reason = (correction.reason ?? '').trim();
  if (reason === '') throw new V18BiTemporalError('Ly do hieu chinh khong duoc rong (can audit duoc).');
  const correctedAt =
    correction.correctedAt === undefined
      ? new Date()
      : correction.correctedAt instanceof Date
        ? correction.correctedAt
        : new Date(correction.correctedAt);
  if (Number.isNaN(correctedAt.getTime())) {
    throw new V18BiTemporalError('Thoi diem hieu chinh khong hop le.');
  }
  const subjectName = store.getEntity(oldFact.subjectId)?.name ?? 'user';
  const input: AddFactInput = {
    subjectName,
    kind: store.getEntity(oldFact.subjectId)?.kind ?? 'other',
    predicate: oldFact.predicate,
    objectText: newObjectText,
    objectIsEntity: Boolean(oldFact.objectId),
    confidence: correction.confidence ?? oldFact.confidence,
    scope: { ...oldFact.scope },
    provenance: {
      ...oldFact.provenance,
      at: correctedAt.toISOString(),
      sourceText: `Hieu chinh fact ${oldFactId}: ${reason}`.slice(0, 500),
    },
    validFrom: correction.validFrom ?? correctedAt.toISOString(),
  };
  const fact = store.supersedeFact(oldFactId, input);
  const record: V18CorrectionRecord = {
    id: nextV18CorrectionId(),
    oldFactId,
    newFactId: fact.id,
    subjectName,
    predicate: oldFact.predicate,
    oldObjectText: oldFact.objectText ?? '',
    newObjectText,
    reason,
    evidence: (correction.evidence ?? '').trim().slice(0, 500),
    actor: correction.actor,
    correctedAt: correctedAt.toISOString(),
  };
  return { fact, record };
}

/**
 * Timeline hieu chinh cua mot edge: cac phien ban fact cua edge
 * (subject —predicate→ *) xep theo thoi gian, kem ly do hieu chinh
 * cua tung buoc (neu caller cung cap bang record theo newFactId).
 */
export function correctionTimelineV18(
  store: TemporalGraphStore,
  subjectName: string,
  predicate: string,
  corrections: V18CorrectionRecord[] = [],
  scope: MemoryScope = { userId: '', botId: '', runId: '' },
): V18CorrectionTimelineStep[] {
  const steps: FactVersionStep[] = factVersionTimeline(store, subjectName, predicate, scope);
  const reasonByNewId = new Map<string, string>();
  for (const c of corrections) reasonByNewId.set(c.newFactId, c.reason);
  return steps.map((s) => ({
    factId: s.factId,
    objectText: s.objectText,
    validFrom: s.validFrom,
    validUntil: s.validUntil,
    learnedAt: s.at,
    status: s.status,
    correctionReason: reasonByNewId.get(s.factId) ?? null,
  }));
}

/**
 * So sanh tri thuc tai hai thoi diem ghi nhan R1 < R2 ve cung thoi
 * diem su kien T: fact nao moi xuat hien (hoc duoc giua R1 va R2),
 * fact nao da doi phien ban. Phuc vu audit "hom qua agent biet gi,
 * hom nay biet them gi".
 */
export function diffKnownAtV18(
  store: TemporalGraphStore,
  at: string | Date,
  recordedAt1: string | Date,
  recordedAt2: string | Date,
  scope?: MemoryScope,
): { added: V18BiTemporalView[]; changed: { before: V18BiTemporalView; after: V18BiTemporalView }[] } {
  const snap1 = snapshotAtV18(store, at, { recordedAt: recordedAt1, scope });
  const snap2 = snapshotAtV18(store, at, { recordedAt: recordedAt2, scope });
  const byId1 = new Map(snap1.facts.map((f) => [f.fact.id, f]));
  const added: V18BiTemporalView[] = [];
  const changed: { before: V18BiTemporalView; after: V18BiTemporalView }[] = [];
  for (const view of snap2.facts) {
    const prev = byId1.get(view.fact.id);
    if (!prev) {
      added.push(view);
      continue;
    }
    if (prev.fact.objectText !== view.fact.objectText || prev.fact.status !== view.fact.status) {
      changed.push({ before: prev, after: view });
    }
  }
  return { added, changed };
}

/** Giai thich text mot view bi-temporal (de UI hien thi). */
export function explainBiTemporalViewV18(view: V18BiTemporalView): string {
  const valid = view.validUntil
    ? `dung tu ${view.validAt} den ${view.validUntil}`
    : `dung tu ${view.validAt} den nay`;
  return `${factDisplayText(view.fact, view.subjectName)} — ${valid}, he thong biet tu ${view.learnedAt}` +
    (view.currentAtRecordTime ? '' : ' (da co phien ban moi hon)');
}
