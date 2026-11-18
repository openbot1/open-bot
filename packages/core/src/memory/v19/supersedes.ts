/**
 * Memory v19 — Supersedes semantics kieu Mnemoverse memory_write
 * 0.18.0 (v1.20, Doi T1).
 *
 * Y tuong hoc tu Mnemoverse memory_write 0.18.0 (memory moi thay
 * the memory cu cung chu de, giu lai lich su thay vi xoa) — tu
 * thiet ke lai hoan toan cho open-bot, KHONG copy code/text/tai
 * san cua bat ky repo nao.
 *
 * Quy tac cua module nay:
 *  1. CUNG CHU DE = cung subject + predicate (chuan hoa). Memory
 *     moi cung chu de, object khac thi \"thay the\" memory cu —
 *     khong phai xoa: fact cu chuyen `superseded`, tro
 *     `supersededBy` sang fact moi; fact moi ghi `supersedes`
 *     tro ve fact cu (co che san cua `TemporalGraphStore`).
 *  2. KHONG GHI DE LANG LE: neu memory moi yeu hon memory cu
 *     qua `minConfidenceGap` thi TU CHOI viet (tra ve
 *     `rejected-weak`, ke ca hai), tru khi host `force` co chu
 *     dich — truong hop do ghi ro `forced: true` vao audit.
 *     Ly do: mot fact confidence 0.95 khong nen bi thay bang
 *     mot doan chat confidence 0.4 chi vi no moi hon.
 *  3. LICH SU DAY DU: chuoi thay the doc duoc qua
 *     `store.factHistory` (san co); module nay chi dinh dang
 *     lai thanh timeline co so phien ban + mo ta tung buoc.
 *  4. ROLLBACK = PHIEN BAN MOI: khoi phuc ban cu khong xoa ban
 *     moi — no tao mot fact moi copy noi dung ban cu va supersede
 *     ban hien tai. Lich su khong bao gio bi viet lai.
 *  5. NHIEU BAN CU: chi supersede truc tiep ban manh nhat (ban
 *     \"hien tai\"); cac ban cu khac cung chu de bi invalidate co
 *     ly do tro ve fact moi (de khong con 2 fact active cung
 *     chu de doi nhau).
 *
 * Module nay KHONG tu sua `file.facts`: moi thao tac ghi deu qua
 * `store.supersedeFact` / `store.addFact` /
 * `store.markFactInvalidated`. Predicate da tri (vd `likes`) khong
 * bao gio bi supersede tu dong — nhieu object cung dung duoc —
 * tru khi host goi thang voi `force` va biet ro minh lam gi (luc
 * do audit ghi ro).
 */

import type { GraphFact, MemoryScope, FactProvenance } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import type { V16CandidateFact } from '../v16/consolidationOps';
import { isSingleValuedPredicateV15 } from '../../memoryV15/consolidation';

/** Loi supersedes v19 — message tieng Viet. */
export class V19SupersedeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V19SupersedeError';
  }
}

/** Chenh lech confidence toi thieu de chap nhan thay the (mac dinh 0.1). */
export const V19_DEFAULT_MIN_SUPERSEDE_GAP = 0.1;
/** Actor mac dinh ghi audit supersede. */
export const V19_DEFAULT_SUPERSEDE_ACTOR = 'system:supersede-v19';

/** Ket qua ap dung supersede. */
export type V19SupersedeAction =
  | 'added' // khong co ban cu: viet moi binh thuong
  | 'superseded' // da thay the (cac) ban cu
  | 'no-change' // object giong het ban cu: khong viet trung
  | 'rejected-weak'; // moi yeu hon cu qua gap: khong viet

/** Ban ghi audit mot lan supersede. */
export interface V19SupersedeRecord {
  /** Thoi diem (ISO). */
  at: string;
  /** Ai thuc hien (user id / `agent:<botId>` / `system:...`). */
  actor: string;
  /** Chu de bi thay the (`subject|predicate` chuan hoa). */
  topicKey: string;
  /** Id cac fact cu bi thay the / invalidate. */
  oldFactIds: string[];
  /** Id fact moi (null khi rejected-weak / no-change). */
  newFactId: string | null;
  /** Hanh dong da xay ra. */
  action: V19SupersedeAction;
  /** true = host ep buoc thay the du fact moi yeu hon. */
  forced: boolean;
  /** Ly do doc duoc (de hien UI / log). */
  reason: string;
}

/** Ket qua day du cua `applySupersedeV19` (gom audit + fact moi). */
export interface V19SupersedeResult {
  record: V19SupersedeRecord;
  /** Fact moi da viet (undefined khi khong viet). */
  newFact?: GraphFact;
  /** Cac fact cu bi anh huong (de UI hien \"da thay the cai gi\"). */
  oldFacts: GraphFact[];
}

/** Tuy chon cua `applySupersedeV19`. */
export interface V19SupersedeOptions {
  /** Scope ghi (mac dinh lay tu candidate / scope rong). */
  scope?: MemoryScope;
  /** Chenh lech confidence toi thieu chap nhan (mac dinh 0.1). */
  minConfidenceGap?: number;
  /** true = thay the ca khi fact moi yeu hon (ghi ro vao audit). */
  force?: boolean;
  /** Actor ghi audit. */
  actor?: string;
  /** Thoi diem ghi (mac dinh = now). */
  now?: Date;
}

/** Mot buoc trong lich su thay the cua mot fact. */
export interface V19SupersedeHistoryEntry {
  /** So phien ban (1 = ban goc). */
  version: number;
  /** Id fact o buoc nay. */
  factId: string;
  /** Noi dung object o buoc nay. */
  objectText: string;
  /** Confidence o buoc nay. */
  confidence: number;
  /** Trang thai o buoc nay. */
  status: GraphFact['status'];
  /** Thoi diem viet buoc nay (ISO). */
  createdAt: string;
  /** Buoc nay thay the fact nao (undefined = ban goc). */
  supersedes?: string;
  /** Buoc nay bi fact nao thay the (undefined = ban moi nhat). */
  supersededBy?: string;
  /** true = buoc hien tai (ban moi nhat). */
  isCurrent: boolean;
}

/**
 * Khoa chu de cua mot ung vien fact: `subject|predicate` da chuan
 * hoa (bo dau, lower-case, khoang trang -> `_`). Hai fact cung
 * khoa moi xet thay the nhau.
 */
export function topicKeyV19(subjectName: string, predicate: string): string {
  const subject = normalizeGraphText(subjectName ?? '').replace(/\s+/g, '_');
  const pred = normalizeGraphText(predicate ?? '').replace(/\s+/g, '_');
  return `${subject}|${pred}`;
}

/**
 * Tim cac fact active cung chu de voi ung vien (cung subject +
 * predicate, object chuan hoa KHAC nhau). Tra ve rong khi subject
 * chua co trong graph, hoac khi predicate la da tri va host khong
 * bat buoc (predicate da tri: nhieu object cung dung duoc nen
 * khong tu thay the).
 */
export function findSupersedeCandidatesV19(
  store: TemporalGraphStore,
  candidate: Pick<V16CandidateFact, 'subject' | 'predicate' | 'objectText'>,
  scope: MemoryScope = { userId: '', botId: '', runId: '' },
  opts: { forceMultiValued?: boolean } = {},
): GraphFact[] {
  const entity = store.findEntityByName(candidate.subject ?? '');
  if (!entity) return [];
  if (!isSingleValuedPredicateV15(candidate.predicate) && !opts.forceMultiValued) return [];
  const wantedObject = normalizeGraphText(candidate.objectText ?? '');
  return store
    .listFacts({ ...scope, status: 'active', limit: 1000 })
    .filter((f) => f.subjectId === entity.id)
    .filter((f) => normalizeGraphText(f.predicate).replace(/\s+/g, '_')
      === normalizeGraphText(candidate.predicate).replace(/\s+/g, '_'))
    .filter((f) => normalizeGraphText(f.objectText ?? '') !== wantedObject);
}

/** Fact cu manh nhat trong danh sach (confidence cao nhat, hoa thi moi nhat). */
export function pickCurrentFactV19(candidates: GraphFact[]): GraphFact | undefined {
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return sorted[0];
}

function candidateProvenance(
  candidate: V16CandidateFact,
  scope: MemoryScope,
  nowIso: string,
): FactProvenance {
  return {
    episodeId: candidate.episodeId ?? '',
    turnId: candidate.turnId ?? '',
    runId: candidate.runId ?? scope.runId ?? '',
    botId: candidate.botId ?? scope.botId ?? '',
    userId: candidate.userId ?? scope.userId ?? '',
    at: candidate.at ?? nowIso,
    sourceText: (candidate.sourceText ?? '').slice(0, 500),
  };
}

/**
 * Viet mot memory moi theo semantics supersedes: neu co ban cu
 * cung chu de thi thay the (giu lich su); neu khong co thi viet
 * moi binh thuong; neu object giong het ban cu thi khong viet
 * trung; neu ban moi yeu hon ban cu qua `minConfidenceGap` thi
 * tu choi viet (tru khi `force`).
 *
 * KHONG bao gio xoa fact cu. KHONG bao gio viet lai lich su.
 */
export function applySupersedeV19(
  store: TemporalGraphStore,
  candidate: V16CandidateFact,
  opts: V19SupersedeOptions = {},
): V19SupersedeResult {
  const subjectName = (candidate.subject ?? '').trim();
  const predicate = (candidate.predicate ?? '').trim();
  const objectText = (candidate.objectText ?? '').trim();
  if (subjectName === '') throw new V19SupersedeError('subject khong duoc rong.');
  if (predicate === '') throw new V19SupersedeError('predicate khong duoc rong.');
  if (objectText === '') throw new V19SupersedeError('objectText khong duoc rong.');
  // Confidence hieu dung (da nhan trust nguon) la thuoc do de so sanh;
  // neu caller chi set confidence goc thi dung no.
  const confidence = candidate.effectiveConfidence ?? candidate.confidence ?? 0.5;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new V19SupersedeError('confidence phai trong [0, 1].');
  }
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const scope: MemoryScope = opts.scope ?? {
    userId: candidate.userId ?? '',
    botId: candidate.botId ?? '',
    runId: candidate.runId ?? '',
  };
  const actor = (opts.actor ?? V19_DEFAULT_SUPERSEDE_ACTOR).trim() || V19_DEFAULT_SUPERSEDE_ACTOR;
  const gap = opts.minConfidenceGap ?? V19_DEFAULT_MIN_SUPERSEDE_GAP;
  const topicKey = topicKeyV19(subjectName, predicate);
  const provenance = candidateProvenance(candidate, scope, nowIso);

  // 0. Object giong het ban active cung chu de -> khong viet trung.
  const entity = store.findEntityByName(subjectName);
  if (entity) {
    const sameObject = store
      .listFacts({ ...scope, status: 'active', limit: 1000 })
      .filter((f) => f.subjectId === entity.id)
      .filter(
        (f) =>
          normalizeGraphText(f.predicate).replace(/\s+/g, '_')
          === normalizeGraphText(predicate).replace(/\s+/g, '_'),
      )
      .find((f) => normalizeGraphText(f.objectText ?? '') === normalizeGraphText(objectText));
    if (sameObject) {
      return {
        record: {
          at: nowIso,
          actor,
          topicKey,
          oldFactIds: [sameObject.id],
          newFactId: null,
          action: 'no-change',
          forced: false,
          reason: `Object giong het fact ${sameObject.id} dang active — khong viet trung.`,
        },
        oldFacts: [sameObject],
      };
    }
  }

  const olds = findSupersedeCandidatesV19(
    store,
    candidate,
    scope,
    { forceMultiValued: opts.force === true },
  );
  const input = {
    subjectName,
    predicate,
    objectText,
    confidence,
    scope,
    provenance,
    validFrom: nowIso,
  };

  // 1. Khong co ban cu: viet moi binh thuong.
  if (olds.length === 0) {
    const created = store.addFact(input);
    return {
      record: {
        at: nowIso,
        actor,
        topicKey,
        oldFactIds: [],
        newFactId: created.id,
        action: 'added',
        forced: false,
        reason: 'Khong co fact cu cung chu de — viet moi.',
      },
      newFact: created,
      oldFacts: [],
    };
  }

  // 2. Ban moi yeu hon ban cu manh nhat qua gap -> tu choi (tru khi force).
  const current = pickCurrentFactV19(olds) as GraphFact;
  const forced = opts.force === true;
  if (!forced && confidence + gap < current.confidence) {
    return {
      record: {
        at: nowIso,
        actor,
        topicKey,
        oldFactIds: olds.map((f) => f.id),
        newFactId: null,
        action: 'rejected-weak',
        forced: false,
        reason: `Fact moi (confidence ${confidence}) yeu hon fact cu ${current.id} (${current.confidence}) qua ${gap} — giu ban cu, khong viet.`,
      },
      oldFacts: olds,
    };
  }

  // 3. Thay the: supersede ban manh nhat, invalidate cac ban cu con lai.
  const created = store.supersedeFact(current.id, input);
  const supersededIds: string[] = [current.id];
  for (const other of olds) {
    if (other.id === current.id) continue;
    if (other.validUntil !== null) continue;
    try {
      store.markFactInvalidated(other.id, {
        invalidAt: now,
        actor,
        reason: `Cung chu de ${topicKey}, bi thay the boi fact ${created.id} (supersede ban ${current.id}).`,
      });
      supersededIds.push(other.id);
    } catch {
      continue;
    }
  }
  return {
    record: {
      at: nowIso,
      actor,
      topicKey,
      oldFactIds: supersededIds,
      newFactId: created.id,
      action: 'superseded',
      forced,
      reason: forced
        ? `Ep buoc thay the ${supersededIds.length} fact cu cung chu de (fact moi yeu hon nhung host force).`
        : `Thay the ${supersededIds.length} fact cu cung chu de; lich su giu lai qua chuoi supersedes.`,
    },
    newFact: created,
    oldFacts: olds,
  };
}

/**
 * Lich su thay the cua mot fact, dinh dang thanh timeline co so
 * phien ban (1 = ban goc). Doc tu `store.factHistory` (san co) —
 * module nay chi sap xep + danh so.
 */
export function supersedeHistoryV19(
  store: TemporalGraphStore,
  factId: string,
): V19SupersedeHistoryEntry[] {
  const chain = store.factHistory(factId);
  if (chain.length === 0) return [];
  const currentId = chain[chain.length - 1]?.id;
  return chain.map((fact, index) => ({
    version: index + 1,
    factId: fact.id,
    objectText: fact.objectText ?? '',
    confidence: fact.confidence,
    status: fact.status,
    createdAt: fact.createdAt,
    ...(fact.supersedes ? { supersedes: fact.supersedes } : {}),
    ...(fact.supersededBy ? { supersededBy: fact.supersededBy } : {}),
    isCurrent: fact.id === currentId,
  }));
}

/**
 * Rollback: khoi phuc noi dung cua mot phien ban cu (mac dinh =
 * phien ban ngay truoc ban hien tai) bang cach viet mot phien ban
 * MOI copy noi dung ban cu va supersede ban hien tai. Lich su
 * khong bi viet lai — rollback cung la mot buoc trong timeline.
 */
export function rollbackSupersedeV19(
  store: TemporalGraphStore,
  factId: string,
  opts: { targetVersion?: number; actor?: string; scope?: MemoryScope; now?: Date } = {},
): V19SupersedeResult {
  const chain = store.factHistory(factId);
  if (chain.length < 2) {
    throw new V19SupersedeError('Khong co phien ban cu de rollback (can it nhat 2 phien ban).');
  }
  const current = chain[chain.length - 1] as GraphFact;
  if (current.status !== 'active') {
    throw new V19SupersedeError('Chi rollback duoc khi ban hien tai dang active.');
  }
  const targetVersion = opts.targetVersion ?? chain.length - 1;
  const target = chain[targetVersion - 1];
  if (!target) throw new V19SupersedeError(`Khong co phien ban ${targetVersion}.`);
  if (target.id === current.id) {
    throw new V19SupersedeError('Ban dich da la ban hien tai — khong can rollback.');
  }
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const actor = (opts.actor ?? V19_DEFAULT_SUPERSEDE_ACTOR).trim() || V19_DEFAULT_SUPERSEDE_ACTOR;
  const scope: MemoryScope = opts.scope ?? current.scope;
  const entity = store.getEntity(current.subjectId);
  const subjectName = entity?.name ?? current.subjectId;
  const created = store.supersedeFact(current.id, {
    subjectName,
    predicate: current.predicate,
    objectText: target.objectText ?? '',
    confidence: target.confidence,
    scope,
    provenance: {
      ...target.provenance,
      at: nowIso,
      sourceText: `rollback-v19:${target.id} | ${target.provenance.sourceText}`.slice(0, 500),
    },
    validFrom: nowIso,
  });
  return {
    record: {
      at: nowIso,
      actor,
      topicKey: topicKeyV19(subjectName, current.predicate),
      oldFactIds: [current.id],
      newFactId: created.id,
      action: 'superseded',
      forced: true,
      reason: `Rollback ve phien ban ${targetVersion} (fact ${target.id}): viet ban moi copy noi dung cu, lich su giu nguyen.`,
    },
    newFact: created,
    oldFacts: [current],
  };
}

/** Tom tat mot ban ghi supersede thanh text (tieng Viet) cho log/UI. */
export function formatV19SupersedeRecord(record: V19SupersedeRecord): string {
  switch (record.action) {
    case 'added':
      return `Memory moi [${record.topicKey}] da viet (${record.newFactId}).`;
    case 'superseded':
      return `Memory [${record.topicKey}] da thay the ${record.oldFactIds.length} ban cu -> ${record.newFactId}${record.forced ? ' (ep buoc)' : ''}.`;
    case 'no-change':
      return `Memory [${record.topicKey}] khong doi — object da ton tai.`;
    case 'rejected-weak':
      return `Memory [${record.topicKey}] bi tu choi: ban moi yeu hon ban cu. ${record.reason}`;
    default:
      return `Memory [${record.topicKey}]: ${record.action}.`;
  }
}
