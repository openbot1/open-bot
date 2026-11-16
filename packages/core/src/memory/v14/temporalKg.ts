/**
 * Memory v14 — Temporal KG v3 (v1.15, Doi T1).
 *
 * Y tuong hoc tu Zep/Graphiti (temporal knowledge graph bi-temporal:
 * moi fact mang ca "thoi gian that" validFrom/validUntil lan "thoi
 * gian he thong biet" createdAt/updatedAt) — tu thiet ke lai hoan
 * toan cho open-bot, chay 100% local, KHONG copy code/text/tai san
 * cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `TemporalGraphStore.supersedeFact` (v0.98): dong cua so cu +
 *    noi supersession hai chieu. v14 goi lai ham nay roi CHINH
 *    cua so ve moc `supersededAt` do caller chon (de test xac
 *    dinh + de moc thay the dung voi thoi diem turn noi ra su
 *    thay doi, khong phai gio wall-clock luc ghi).
 *  - `isFactValidAt` (graph/types): chi tinh fact `active`. v14
 *    them `isFactValidAtV14` chi xet CUA SO (khong xet status) de
 *    lich su superseded van tra loi duoc "dung vao T thi sao?".
 *  - `queryFactsAt` / `factHistory` cua graph: tang doc lich su.
 *    v14 them lop API viet/tom tat (supersede co moc, timeline
 *    theo (subject, predicate), phat hien cua so chong nhau).
 *
 * Luat v14:
 *  1. Supersede LUON giu lich su: fact cu thanh `superseded`,
 *     validUntil = moc thay the, supersededBy -> fact moi; fact
 *     moi co supersedes -> fact cu, validFrom = moc thay the.
 *  2. Mot (subject, predicate) tai mot thoi diem T chi co toi da
 *     MOT fact dung (neu khong, `overlappingIntervalsV14` bao
 *     loi du lieu de sua tay — thuong do import thu cong).
 *  3. Khong bao gio xoa fact khi supersede/close — chi dong cua so.
 */

import type { GraphFact, MemoryScope } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore, AddFactInput } from '../graph/store';
import type { ScopeFilter } from '../graph/store';

/** Loi temporal KG v14 — message tieng Viet. */
export class V14TemporalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V14TemporalError';
  }
}

export interface V14ValidityInterval {
  validFrom: string;
  validUntil: string | null;
}

export interface V14TimelineStep {
  fact: GraphFact;
  subjectName: string;
  objectText: string;
  interval: V14ValidityInterval;
  status: GraphFact['status'];
  supersedes?: string;
  supersededBy?: string;
}

export interface V14Overlap {
  subject: string;
  predicate: string;
  factA: GraphFact;
  factB: GraphFact;
  overlapFrom: string;
  overlapUntil: string | null;
}

export interface V14FactsValidAtOptions {
  scope?: ScopeFilter;
  subject?: string;
  predicate?: string;
  /** true = ca fact `deleted` co cua so bao phu T (mac dinh false). */
  includeDeleted?: boolean;
  limit?: number;
}

export interface V14FactsValidAtResult {
  at: string;
  facts: { fact: GraphFact; subjectName: string; objectText: string }[];
  totalValid: number;
  summary: string;
}

function parseOrThrow(value: string | Date, field: string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new V14TemporalError(`"${field}" khong phai thoi gian hop le: "${String(value)}".`);
  }
  return d;
}

/** Cua so hieu luc cua mot fact. */
export function intervalOfFact(fact: GraphFact): V14ValidityInterval {
  return { validFrom: fact.validFrom, validUntil: fact.validUntil };
}

/**
 * Fact co dung tai thoi diem T khong — CHI XET CUA SO, khong xet
 * status. Fact superseded van "dung" trong cua so cu cua no; fact
 * active nhung validFrom o tuong lai thi chua dung.
 */
export function isFactValidAtV14(fact: GraphFact, at: string | Date): boolean {
  const atMs = parseOrThrow(at, 'at').getTime();
  if (Date.parse(fact.validFrom) > atMs) return false;
  if (fact.validUntil !== null && Date.parse(fact.validUntil) <= atMs) return false;
  return true;
}

/** Hai cua so co giao nhau khong (validUntil null = vo han). */
export function intervalsOverlapV14(a: V14ValidityInterval, b: V14ValidityInterval): boolean {
  const aFrom = Date.parse(a.validFrom);
  const bFrom = Date.parse(b.validFrom);
  const aUntil = a.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(a.validUntil);
  const bUntil = b.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(b.validUntil);
  return aFrom < bUntil && bFrom < aUntil;
}

/**
 * Thay the fact cu bang fact moi tai moc `supersededAt` (mac dinh
 * bay gio): fact cu dong cua so tai moc do, fact moi bat dau dung
 * tai moc do. Lich su giu nguyen, noi hai chieu.
 */
export function supersedeFactV14(
  store: TemporalGraphStore,
  oldFactId: string,
  input: AddFactInput,
  opts: { supersededAt?: string | Date } = {},
): GraphFact {
  const at = opts.supersededAt ? parseOrThrow(opts.supersededAt, 'supersededAt') : new Date();
  const atIso = at.toISOString();
  const oldFact = store.getFact(oldFactId);
  if (!oldFact) throw new V14TemporalError('Khong tim thay fact can thay the.');
  if (oldFact.status !== 'active') {
    throw new V14TemporalError('Chi thay the duoc fact dang active.');
  }
  if (Date.parse(oldFact.validFrom) > at.getTime()) {
    throw new V14TemporalError('Moc thay the phai >= validFrom cua fact cu.');
  }
  const created = store.supersedeFact(oldFactId, {
    ...input,
    validFrom: atIso,
  });
  // supersedeFact dung gio wall-clock lam moc; chinh lai ve moc
  // caller chon (ca 2 phia) de lich su khop voi thoi diem turn.
  store.setFactValidity(oldFactId, { validUntil: atIso });
  store.setFactValidity(created.id, { validFrom: atIso });
  const fixed = store.getFact(created.id);
  if (!fixed) throw new V14TemporalError('Fact moi vua tao bien mat khoi store.');
  return fixed;
}

/**
 * Dong cua so hieu luc cua mot fact tai moc `at` (fact het dung tu
 * luc do, khong xoa, khong doi status). Dung cho retract / het han.
 */
export function closeIntervalV14(
  store: TemporalGraphStore,
  factId: string,
  at: string | Date,
  reason?: string,
): GraphFact {
  const atDate = parseOrThrow(at, 'at');
  const fact = store.getFact(factId);
  if (!fact) throw new V14TemporalError('Khong tim thay fact.');
  if (fact.validUntil !== null && Date.parse(fact.validUntil) <= atDate.getTime()) {
    throw new V14TemporalError('Fact da het hieu luc truoc moc dong cua so.');
  }
  void reason;
  return store.setFactValidity(factId, { validUntil: atDate.toISOString() });
}

/**
 * Tat ca fact DUNG tai thoi diem T (ke ca fact da superseded, mien
 * la cua so cua no bao phu T). Loc theo scope/subject/predicate.
 */
export function factsValidAt(
  store: TemporalGraphStore,
  at: string | Date,
  opts: V14FactsValidAtOptions = {},
): V14FactsValidAtResult {
  const atDate = parseOrThrow(at, 'at');
  const atIso = atDate.toISOString();
  const scope = opts.scope ?? {};
  const includeDeleted = opts.includeDeleted === true;
  const subjectNorm = opts.subject ? normalizeGraphText(opts.subject) : null;
  const predNorm = opts.predicate
    ? normalizeGraphText(opts.predicate).replace(/\s+/g, '_')
    : null;
  const all = store.listFacts({ ...scope, limit: 5000 });
  const valid = all.filter((f) => {
    if (!includeDeleted && f.status === 'deleted') return false;
    if (f.status === 'quarantined') return false;
    if (!isFactValidAtV14(f, atDate)) return false;
    if (subjectNorm) {
      const name = store.getEntity(f.subjectId)?.name ?? '';
      if (normalizeGraphText(name) !== subjectNorm) return false;
    }
    if (predNorm && f.predicate !== predNorm) return false;
    return true;
  });
  const totalValid = valid.length;
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 100)));
  const facts = valid.slice(0, limit).map((f) => ({
    fact: f,
    subjectName: store.getEntity(f.subjectId)?.name ?? 'user',
    objectText: f.objectText ?? '',
  }));
  const summary =
    facts.length === 0
      ? `Vao ${atIso}, khong co fact nao dung trong scope nay.`
      : `Vao ${atIso}, co ${totalValid} fact dung — hien ${facts.length} fact.`;
  return { at: atIso, facts, totalValid, summary };
}

/**
 * Timeline cua mot (subject, predicate): moi phien ban fact theo
 * thu tu validFrom, kem cua so + status + lien ket supersession.
 * Dung de tra loi "user da doi cho o nhu the nao theo thoi gian?".
 */
export function factTimelineV14(
  store: TemporalGraphStore,
  subject: string,
  predicate: string,
  opts: { scope?: ScopeFilter } = {},
): V14TimelineStep[] {
  const cleanSubject = (subject ?? '').trim();
  const pred = normalizeGraphText(predicate ?? '').replace(/\s+/g, '_');
  if (cleanSubject === '') throw new V14TemporalError('Subject khong duoc rong.');
  if (pred === '') throw new V14TemporalError('Predicate khong duoc rong.');
  const entity = store.findEntityByName(cleanSubject);
  if (!entity) return [];
  const scope = opts.scope ?? {};
  const steps = store
    .listFacts({ ...scope, predicate: pred, limit: 5000 })
    .filter((f) => f.subjectId === entity.id)
    .sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom))
    .map((f) => ({
      fact: f,
      subjectName: entity.name,
      objectText: f.objectText ?? '',
      interval: intervalOfFact(f),
      status: f.status,
      ...(f.supersedes ? { supersedes: f.supersedes } : {}),
      ...(f.supersededBy ? { supersededBy: f.supersededBy } : {}),
    }));
  return steps;
}

/** Tom tat timeline dang text (de hien UI / chen vao prompt). */
export function formatTimelineV14(steps: V14TimelineStep[]): string {
  if (steps.length === 0) return '(chua co lich su)';
  return steps
    .map(
      (s) =>
        `- ${s.objectText} [${s.interval.validFrom} → ${s.interval.validUntil ?? 'nay'}] (${s.status})`,
    )
    .join('\n');
}

/**
 * Phat hien cua so hieu luc CHONG NHAU giua cac fact cung
 * (subject, predicate): tai mot thoi diem co 2 fact cung dung —
 * du lieu loi (thuong do import thu cong), can sua tay.
 */
export function overlappingIntervalsV14(
  store: TemporalGraphStore,
  opts: { scope?: ScopeFilter } = {},
): V14Overlap[] {
  const scope = opts.scope ?? {};
  const groups = new Map<string, GraphFact[]>();
  for (const f of store.listFacts({ ...scope, limit: 5000 })) {
    if (f.status === 'deleted' || f.status === 'quarantined') continue;
    const subjectName = store.getEntity(f.subjectId)?.name ?? 'user';
    const key = `${normalizeGraphText(subjectName)}|${f.predicate}`;
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const out: V14Overlap[] = [];
  for (const [key, facts] of groups) {
    const [subject, predicate] = key.split('|');
    const sorted = [...facts].sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (!intervalsOverlapV14(intervalOfFact(a), intervalOfFact(b))) continue;
        const overlapFrom = new Date(
          Math.max(Date.parse(a.validFrom), Date.parse(b.validFrom)),
        ).toISOString();
        const aUntil = a.validUntil === null ? null : Date.parse(a.validUntil);
        const bUntil = b.validUntil === null ? null : Date.parse(b.validUntil);
        let overlapUntil: string | null = null;
        if (aUntil !== null && bUntil !== null) {
          overlapUntil = new Date(Math.min(aUntil, bUntil)).toISOString();
        } else if (aUntil !== null) {
          overlapUntil = new Date(aUntil).toISOString();
        } else if (bUntil !== null) {
          overlapUntil = new Date(bUntil).toISOString();
        }
        out.push({ subject, predicate, factA: a, factB: b, overlapFrom, overlapUntil });
      }
    }
  }
  return out;
}

/** Scope mac dinh cho query temporal: user hien tai. */
export function defaultV14Scope(scope: MemoryScope): ScopeFilter {
  return {
    ...(scope.userId !== '' ? { userId: scope.userId } : {}),
    ...(scope.botId !== '' ? { botId: scope.botId } : {}),
    ...(scope.runId !== '' ? { runId: scope.runId } : {}),
  };
}
