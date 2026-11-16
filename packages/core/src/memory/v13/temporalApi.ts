/**
 * Memory v13 — temporal query API (v1.14, Doi T1).
 *
 * Y tuong hoc tu Zep/Graphiti (temporal knowledge graph bi-temporal:
 * moi fact mang 2 timeline — thoi gian that trong the gioi + thoi
 * gian he thong biet; fact mau thuan khong xoa ma ghi `invalid_at`)
 * — tu thiet ke lai hoan toan cho open-bot, KHONG copy code/text/tai
 * san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `queryFactsAt` / `findChangesInWindow` /
 *    `findContradictionsBetween` / `entityTimeline` cua
 *    graph/temporalQuery (v1.02) la tang doc lich su.
 *  - `isFactValidAt` cua graph/types la luat hieu luc.
 *
 * Tang v13 them lop API tra loi cau hoi dang "dung vao thoi diem X
 * thi sao?": goi mot ham nhan ve cau tra loi + bang chung (fact nao,
 * nguon goc episode nao, cua so hieu luc nao), thay vi phai tu loc
 * fact tho. Moi cau tra loi deu kem `asOf` (thoi diem duoc hoi) va
 * `knownAt` (he thong biet tu luc nao) de phan biet ro 2 timeline
 * bi-temporal — vd "thang 3 user song o Ha Noi" (valid) nhung "he
 * thong chi biet dieu do tu thang 5" (known).
 */

import type { GraphFact } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import type { ScopeFilter } from '../graph/store';
import {
  queryFactsAt,
  findChangesInWindow,
  findContradictionsBetween,
  entityTimeline,
} from '../graph/temporalQuery';
import type {
  FactAtTime,
  FactChange,
  TemporalContradiction,
  TimelineStep,
} from '../graph/temporalQuery';

/** Loi temporal API — message tieng Viet. */
export class V13TemporalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V13TemporalError';
  }
}

/** Dap an cho cau hoi "dung vao thoi diem X, subject predicate gi?" */
export interface V13TemporalAnswer {
  /** true = tim duoc fact dung vao thoi diem hoi. */
  found: boolean;
  subject: string;
  predicate: string;
  /** Gia tri tra loi (object text) — null khi khong tim thay. */
  value: string | null;
  /** Fact dung sau dap an (null khi khong tim thay). */
  fact: GraphFact | null;
  /** Thoi diem duoc hoi (ISO). */
  asOf: string;
  /** Fact bat dau dung luc nao / het dung luc nao. */
  validFrom: string | null;
  validUntil: string | null;
  /** He thong biet fact nay tu luc nao (timeline thu 2: known). */
  knownSince: string | null;
  /** Bang chung: cau goc + episode sinh ra fact. */
  evidence: { sourceText: string; episodeId: string } | null;
  /** Fact cung (subject, predicate) nhung khac object — de user thay mau thuan. */
  competing: { value: string; validFrom: string; validUntil: string | null }[];
  /** Cau giai thich doc duoc de hien trong UI. */
  explanation: string;
}

export interface V13StateAtOptions {
  subject?: string;
  predicate?: string;
  scope?: ScopeFilter;
  limit?: number;
}

export interface V13StateAtResult {
  at: string;
  facts: FactAtTime[];
  /** Tom tat doc duoc: "Vao <at>, co N fact dung..." */
  summary: string;
  /** So fact dung o thoi diem do (truoc khi cat theo limit). */
  totalValid: number;
}

export interface V13WhatChangedOptions {
  scope?: ScopeFilter;
  limit?: number;
}

function parseOrThrow(value: string | Date, field: string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new V13TemporalError(`"${field}" khong phai thoi gian hop le: "${String(value)}".`);
  }
  return d;
}

function normalizePredicate(predicate: string): string {
  return normalizeGraphText(predicate).replace(/\s+/g, '_');
}

/**
 * Trang thai tri thuc TAI mot thoi diem: tat ca fact dung vao luc do
 * (loc them theo subject/predicate neu co).
 */
export function stateAt(
  store: TemporalGraphStore,
  at: string | Date,
  opts: V13StateAtOptions = {},
): V13StateAtResult {
  const atDate = parseOrThrow(at, 'at');
  const atIso = atDate.toISOString();
  const scope = opts.scope ?? {};
  let facts = queryFactsAt(store, atDate, {
    ...(Object.keys(scope).length > 0 ? { scope: { userId: '', botId: '', runId: '', ...scope } } : {}),
    limit: 5000,
  });
  const totalValid = facts.length;
  if (opts.subject !== undefined && opts.subject.trim() !== '') {
    const subjectNorm = normalizeGraphText(opts.subject);
    facts = facts.filter(
      (f) => normalizeGraphText(f.subjectName) === subjectNorm,
    );
  }
  if (opts.predicate !== undefined && opts.predicate.trim() !== '') {
    const pred = normalizePredicate(opts.predicate);
    facts = facts.filter((f) => f.fact.predicate === pred);
  }
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 100)));
  // queryFactsAt chi dat objectName khi object la entity; voi object
  // text thi bo sung tu objectText de caller luon co ten hien thi.
  const sliced = facts.slice(0, limit).map((f) => ({
    ...f,
    objectName: f.objectName ?? f.fact.objectText ?? undefined,
  }));
  const summary =
    sliced.length === 0
      ? `Vao ${atIso}, khong co fact nao dung trong scope nay.`
      : `Vao ${atIso}, co ${totalValid} fact dung` +
        (opts.subject ? ` ve "${opts.subject}"` : '') +
        (opts.predicate ? ` (${opts.predicate})` : '') +
        ` — hien ${sliced.length} fact.`;
  return { at: atIso, facts: sliced, summary, totalValid };
}

/**
 * Tra loi "dung vao thoi diem X, <subject> <predicate> gi?".
 * Vd: answerAtTime(store, 'An', 'lives_in', '2026-03-15') ->
 * "Ha Noi" kem cua so hieu luc + bang chung.
 */
export function answerAtTime(
  store: TemporalGraphStore,
  subject: string,
  predicate: string,
  at: string | Date,
  opts: { scope?: ScopeFilter } = {},
): V13TemporalAnswer {
  const atDate = parseOrThrow(at, 'at');
  const atIso = atDate.toISOString();
  const cleanSubject = (subject ?? '').trim();
  const pred = normalizePredicate(predicate ?? '');
  if (cleanSubject === '') {
    throw new V13TemporalError('Subject khong duoc rong.');
  }
  if (pred === '') {
    throw new V13TemporalError('Predicate khong duoc rong.');
  }
  const state = stateAt(store, atDate, {
    subject: cleanSubject,
    predicate: pred,
    scope: opts.scope,
    limit: 100,
  });
  const best = state.facts
    .slice()
    .sort((a, b) => b.fact.confidence - a.fact.confidence)[0];
  const competing = state.facts
    .filter((f) => best === undefined || f.fact.id !== best.fact.id)
    .map((f) => ({
      value: f.objectName ?? f.fact.objectText ?? '',
      validFrom: f.fact.validFrom,
      validUntil: f.fact.validUntil,
    }));
  if (!best) {
    return {
      found: false,
      subject: cleanSubject,
      predicate: pred,
      value: null,
      fact: null,
      asOf: atIso,
      validFrom: null,
      validUntil: null,
      knownSince: null,
      evidence: null,
      competing,
      explanation:
        `Vao ${atIso}, khong co thong tin nao ve "${cleanSubject} ${pred}" ` +
        `(co ${competing.length} fact canh tranh cung khong tim thay).`,
    };
  }
  const value = best.objectName ?? best.fact.objectText ?? '';
  return {
    found: true,
    subject: cleanSubject,
    predicate: pred,
    value,
    fact: best.fact,
    asOf: atIso,
    validFrom: best.fact.validFrom,
    validUntil: best.fact.validUntil,
    knownSince: best.fact.createdAt,
    evidence: {
      sourceText: best.fact.provenance.sourceText,
      episodeId: best.fact.provenance.episodeId,
    },
    competing,
    explanation:
      `Vao ${atIso}, "${cleanSubject} ${pred}" la "${value}" ` +
      `(dung tu ${best.fact.validFrom}` +
      (best.fact.validUntil ? ` den ${best.fact.validUntil}` : ' den nay') +
      `, he thong biet tu ${best.fact.createdAt}).`,
  };
}

/** Nhung gi da thay doi trong [from, to). */
export function whatChangedBetween(
  store: TemporalGraphStore,
  from: string | Date,
  to: string | Date,
  opts: V13WhatChangedOptions = {},
): { from: string; to: string; changes: FactChange[]; summary: string } {
  const fromDate = parseOrThrow(from, 'from');
  const toDate = parseOrThrow(to, 'to');
  if (toDate.getTime() < fromDate.getTime()) {
    throw new V13TemporalError('"to" phai sau "from".');
  }
  const changes = findChangesInWindow(store, fromDate, toDate, {
    ...(opts.scope ? { scope: { userId: '', botId: '', runId: '', ...opts.scope } } : {}),
    limit: opts.limit ?? 100,
  });
  const counts = { created: 0, superseded: 0, deleted: 0 };
  for (const c of changes) counts[c.kind] += 1;
  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    changes,
    summary:
      `Tu ${fromDate.toISOString()} den ${toDate.toISOString()}: ` +
      `${changes.length} thay doi (${counts.created} tao moi, ` +
      `${counts.superseded} bi thay the, ${counts.deleted} bi xoa).`,
  };
}

/** Mau thuan giua 2 cua so thoi gian (cung subject+predicate, khac object). */
export function contradictionsBetween(
  store: TemporalGraphStore,
  fromA: string | Date,
  toA: string | Date,
  fromB: string | Date,
  toB: string | Date,
): TemporalContradiction[] {
  parseOrThrow(fromA, 'fromA');
  parseOrThrow(toA, 'toA');
  parseOrThrow(fromB, 'fromB');
  parseOrThrow(toB, 'toB');
  return findContradictionsBetween(
    store,
    { from: fromA, to: toA },
    { from: fromB, to: toB },
  );
}

/** Toan bo lich su cua mot entity theo thu tu thoi gian. */
export function knowledgeTimeline(
  store: TemporalGraphStore,
  subject: string,
  opts: { scope?: ScopeFilter } = {},
): TimelineStep[] {
  const clean = (subject ?? '').trim();
  if (clean === '') throw new V13TemporalError('Subject khong duoc rong.');
  const entity = store.findEntityByName(clean);
  if (!entity) return [];
  // entityTimeline nhan TEN entity (khong phai id) — truyen thang ten.
  return entityTimeline(store, clean, {
    ...(opts.scope ? { scope: { userId: '', botId: '', runId: '', ...opts.scope } } : {}),
  });
}

/**
 * Snapshot "tai thoi diem X" dang markdown — chen thang vao prompt
 * hoac hien trong UI. Chi gom fact dung vao luc do, kem bang chung.
 */
export function asOfSnapshotMarkdown(
  store: TemporalGraphStore,
  at: string | Date,
  opts: V13StateAtOptions = {},
): string {
  const state = stateAt(store, at, opts);
  const lines: string[] = [`# Tri thuc tai ${state.at}`, '', state.summary, ''];
  for (const f of state.facts) {
    const value = f.objectName ?? f.fact.objectText ?? '';
    lines.push(
      `- ${f.subjectName} ${f.fact.predicate}: ${value} ` +
        `(dung tu ${f.fact.validFrom}` +
        (f.fact.validUntil ? ` den ${f.fact.validUntil}` : '') +
        `, nguon: "${f.fact.provenance.sourceText}")`,
    );
  }
  if (state.facts.length === 0) lines.push('- (trong)');
  return lines.join('\n');
}

/**
 * So sanh trang thai tai 2 thoi diem: fact nao moi xuat hien, fact
 * nao bien mat, fact nao doi gia tri. Dung de tra loi "tu thang 3
 * den gio, user doi gi?".
 */
export function diffStates(
  store: TemporalGraphStore,
  atA: string | Date,
  atB: string | Date,
  opts: V13StateAtOptions = {},
): {
  atA: string;
  atB: string;
  appeared: FactAtTime[];
  disappeared: FactAtTime[];
  changed: { subject: string; predicate: string; from: string; to: string }[];
} {
  const stateA = stateAt(store, atA, { ...opts, limit: 5000 });
  const stateB = stateAt(store, atB, { ...opts, limit: 5000 });
  const keyOf = (f: FactAtTime): string =>
    `${normalizeGraphText(f.subjectName)}|${f.fact.predicate}|${normalizeGraphText(f.objectName ?? f.fact.objectText ?? '')}`;
  const groupKeyOf = (f: FactAtTime): string =>
    `${normalizeGraphText(f.subjectName)}|${f.fact.predicate}`;
  const mapB = new Map(stateB.facts.map((f) => [keyOf(f), f]));
  const mapA = new Map(stateA.facts.map((f) => [keyOf(f), f]));
  const appeared = stateB.facts.filter((f) => !mapA.has(keyOf(f)));
  const disappeared = stateA.facts.filter((f) => !mapB.has(keyOf(f)));
  const changed: { subject: string; predicate: string; from: string; to: string }[] = [];
  const groupB = new Map(stateB.facts.map((f) => [groupKeyOf(f), f]));
  for (const fa of stateA.facts) {
    const fb = groupB.get(groupKeyOf(fa));
    if (fb && keyOf(fa) !== keyOf(fb)) {
      changed.push({
        subject: fa.subjectName,
        predicate: fa.fact.predicate,
        from: fa.objectName ?? fa.fact.objectText ?? '',
        to: fb.objectName ?? fb.fact.objectText ?? '',
      });
    }
  }
  return { atA: stateA.at, atB: stateB.at, appeared, disappeared, changed };
}
