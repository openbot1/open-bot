/**
 * Memory v16 — Archival recall (v1.35, Doi T1).
 *
 * Y tuong hoc tu Letta (archival memory: bo nho lanh — fact it dung
 * duoc dua xuong archival, recall lai khi can bang search + promote
 * len core khi quan trong tro lai) — tu thiet ke lai hoan toan cho
 * open-bot, chay 100% local, KHONG copy code/text/tai san cua bat ky
 * repo nao.
 *
 * Moi so voi hybrid search v15 (lop archival RIENG cua v16):
 *  1. Archival store rieng: fact het han / it dung duoc archive
 *     xuong (giu nguyen provenance + cua so hieu luc), khong nam
 *     trong graph active nua.
 *  2. Recall 4 tin hieu: token overlap co trong so IDF + recency
 *     decay (half-life) + importance + access boost (fact hay duoc
 *     mo thi de recall hon) — weighted hoac RRF.
 *  3. Importance decay theo thoi gian + tang khi access: fact cang
 *     lau khong dung cang chim xuong; fact duoc mo lai thi noi len.
 *  4. Promote/demote 2 chieu: promote dua fact archival tro lai
 *     graph active; archive dua fact active xuong lanh. Moi buoc
 *     deu co ly do + audit.
 *  5. Cau noi expiry -> archival: archiveExpiredFactsM16 nhan
 *     danh sach fact het han tu temporal sweep va archive hang loat.
 */

import type { GraphFact, MemoryScope } from '../memory/graph/types';
import { normalizeGraphText } from '../memory/graph/types';
import type { TemporalGraphStore } from '../memory/graph/store';

/** Loi archival v16 — message tieng Viet. */
export class M16ArchivalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M16ArchivalError';
  }
}

/** Mot ban ghi archival (fact lanh). */
export interface M16ArchivalRecord {
  id: string;
  /** Id fact goc trong graph (neu archive tu graph). */
  factId: string | null;
  subject: string;
  predicate: string;
  objectText: string;
  scope: MemoryScope;
  confidence: number;
  sourceText: string;
  /** Do quan trong 0..1 (decay theo thoi gian, tang khi access). */
  importance: number;
  /** So lan record nay duoc recall/mo. */
  accessCount: number;
  lastAccessedAt: string | null;
  archivedAt: string;
  archivedBy: string;
  reason: string;
  validFrom: string | null;
  validUntil: string | null;
}

/** Trong so mac dinh cho archival recall. */
export interface M16ArchivalWeights {
  text: number;
  recency: number;
  importance: number;
  access: number;
}

export const M16_DEFAULT_ARCHIVAL_WEIGHTS: M16ArchivalWeights = {
  text: 0.5,
  recency: 0.2,
  importance: 0.2,
  access: 0.1,
};

/** Hang so RRF (reciprocal rank fusion). */
export const M16_RRF_K = 60;
/** Half-life mac dinh cho recency: 180 ngay. */
export const M16_DEFAULT_RECENCY_HALF_LIFE_DAYS = 180;
/** Half-life mac dinh cho importance decay: 365 ngay. */
export const M16_IMPORTANCE_HALF_LIFE_DAYS = 365;

export type M16ArchivalMode = 'weighted' | 'rrf';

export function normalizeArchivalWeightsM16(input?: Partial<M16ArchivalWeights>): M16ArchivalWeights {
  const w: M16ArchivalWeights = { ...M16_DEFAULT_ARCHIVAL_WEIGHTS, ...(input ?? {}) };
  const total = w.text + w.recency + w.importance + w.access;
  if (total <= 0) return { ...M16_DEFAULT_ARCHIVAL_WEIGHTS };
  return {
    text: w.text / total,
    recency: w.recency / total,
    importance: w.importance / total,
    access: w.access / total,
  };
}

function newArchivalIdM16(): string {
  return `arc-v16-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function nowIsoM16(): string {
  return new Date().toISOString();
}

/** Tach query/text thanh token (chu thuong, bo dau cau, bo stopword ngan). */
export function archivalTokensM16(text: string): string[] {
  const clean = normalizeGraphText(text ?? '');
  if (clean === '') return [];
  const stop = new Set(['la', 'là', 'cua', 'của', 'va', 'và', 'the', 'a', 'an', 'is', 'are', 'of', 'to', 'in', 'on']);
  return clean
    .split(/[^a-zà-ỹ0-9]+/i)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 1 && !stop.has(t));
}

/** Text index cua record: subject + predicate (tieng Viet) + object. */
export function archivalIndexTextM16(record: Pick<M16ArchivalRecord, 'subject' | 'predicate' | 'objectText'>): string {
  return `${record.subject} ${record.predicate.replace(/_/g, ' ')} ${record.objectText}`;
}

/**
 * Diem text: trung binh IDF-weighted overlap — token hiem (xuat hien
 * trong it record) nang hon token pho bien. Tra 0..1.
 */
export function archivalTextScoreM16(
  queryTokens: string[],
  recordTokens: string[],
  docFreq: Map<string, number>,
  totalDocs: number,
): number {
  if (queryTokens.length === 0 || recordTokens.length === 0) return 0;
  const recordSet = new Set(recordTokens);
  let weightedHit = 0;
  let weightedTotal = 0;
  for (const token of new Set(queryTokens)) {
    const df = docFreq.get(token) ?? 0;
    const idf = Math.log(1 + totalDocs / (1 + df));
    weightedTotal += idf;
    if (recordSet.has(token)) weightedHit += idf;
  }
  if (weightedTotal === 0) return 0;
  return weightedHit / weightedTotal;
}

/** Diem recency: decay theo half-life tu `archivedAt` (hoac lastAccessedAt). */
export function archivalRecencyScoreM16(
  atIso: string | null,
  nowMs: number,
  halfLifeDays: number,
): number {
  if (!atIso) return 0.5;
  const ageMs = nowMs - Date.parse(atIso);
  if (Number.isNaN(ageMs) || ageMs <= 0) return 1;
  const halfLifeMs = Math.max(1, halfLifeDays) * 24 * 60 * 60 * 1000;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/** Diem access: log-scale — mo nhieu lan thi tang nhung bao hoa som. */
export function archivalAccessScoreM16(accessCount: number): number {
  if (accessCount <= 0) return 0;
  return Math.min(1, Math.log1p(accessCount) / Math.log1p(10));
}

export interface M16ArchivalHit {
  record: M16ArchivalRecord;
  score: number;
  scores: { text: number; recency: number; importance: number; access: number };
  rank: number;
}

export interface M16ArchivalRecallOptions {
  topK?: number;
  /** Chi lay record co diem >= nguong nay. */
  minScore?: number;
  mode?: M16ArchivalMode;
  weights?: Partial<M16ArchivalWeights>;
  halfLifeDays?: number;
  /** Chi recall record van dung tai thoi diem nay (theo validUntil). */
  asOf?: string | Date;
  now?: Date;
  /** Loc theo predicate (vd chi recall 'likes'). */
  predicate?: string;
}

export interface M16ArchivalRecallResult {
  query: string;
  total: number;
  hits: M16ArchivalHit[];
}

/**
 * Archival store — in-memory, serialize duoc sang JSON. Giu fact
 * lanh + importance + access count. Khong tu ghi dia.
 */
export class M16ArchivalStore {
  private readonly records = new Map<string, M16ArchivalRecord>();

  get size(): number {
    return this.records.size;
  }

  /** Archive mot fact tu graph (khong xoa fact goc — caller quyet). */
  archiveFact(
    fact: GraphFact,
    actor = 'system',
    reason = '',
    opts: { importance?: number; now?: Date } = {},
  ): M16ArchivalRecord {
    const subject = fact.subjectId;
    const record: M16ArchivalRecord = {
      id: newArchivalIdM16(),
      factId: fact.id,
      subject,
      predicate: fact.predicate,
      objectText: fact.objectText ?? '',
      scope: { ...fact.scope },
      confidence: fact.confidence,
      sourceText: fact.provenance.sourceText,
      importance: Math.min(1, Math.max(0, opts.importance ?? fact.confidence)),
      accessCount: 0,
      lastAccessedAt: null,
      archivedAt: (opts.now ?? new Date()).toISOString(),
      archivedBy: actor,
      reason: (reason ?? '').slice(0, 500),
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  /** Archive truc tiep 1 fact text (khong qua graph). */
  archiveText(
    input: {
      subject: string;
      predicate: string;
      objectText: string;
      scope?: MemoryScope;
      confidence?: number;
      sourceText?: string;
      importance?: number;
      validFrom?: string | null;
      validUntil?: string | null;
    },
    actor = 'system',
    reason = '',
    now?: Date,
  ): M16ArchivalRecord {
    if ((input.subject ?? '').trim() === '') throw new M16ArchivalError('Archive can co subject.');
    if ((input.predicate ?? '').trim() === '') throw new M16ArchivalError('Archive can co predicate.');
    if ((input.objectText ?? '').trim() === '') throw new M16ArchivalError('Archive can co objectText.');
    const record: M16ArchivalRecord = {
      id: newArchivalIdM16(),
      factId: null,
      subject: input.subject.trim(),
      predicate: normalizeGraphText(input.predicate).replace(/\s+/g, '_'),
      objectText: input.objectText.trim(),
      scope: input.scope ?? { userId: '', botId: '', runId: '' },
      confidence: Math.min(1, Math.max(0, input.confidence ?? 0.8)),
      sourceText: (input.sourceText ?? '').slice(0, 500),
      importance: Math.min(1, Math.max(0, input.importance ?? 0.5)),
      accessCount: 0,
      lastAccessedAt: null,
      archivedAt: (now ?? new Date()).toISOString(),
      archivedBy: actor,
      reason: (reason ?? '').slice(0, 500),
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  get(id: string): M16ArchivalRecord | undefined {
    const r = this.records.get(id);
    return r ? { ...r } : undefined;
  }

  list(predicate?: string): M16ArchivalRecord[] {
    const all = [...this.records.values()];
    const filtered = predicate
      ? all.filter((r) => r.predicate === normalizeGraphText(predicate).replace(/\s+/g, '_'))
      : all;
    filtered.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1));
    return filtered.map((r) => ({ ...r }));
  }

  /** Xoa cung 1 record archival (GDPR / don dep). */
  remove(id: string): boolean {
    return this.records.delete(id);
  }

  /** Ghi nhan 1 lan access: tang dem + cap nhat lastAccessedAt + importance. */
  recordAccess(id: string, now?: Date): M16ArchivalRecord {
    const record = this.records.get(id);
    if (!record) throw new M16ArchivalError(`Khong tim thay record archival ${id}.`);
    record.accessCount += 1;
    record.lastAccessedAt = (now ?? new Date()).toISOString();
    // Mo lai thi quan trong hon: tang importance nhe (toi da 1).
    record.importance = Math.min(1, record.importance + 0.05);
    return { ...record };
  }

  /** Dat lai importance thu cong (vd UI danh dau quan trong). */
  setImportance(id: string, importance: number): M16ArchivalRecord {
    const record = this.records.get(id);
    if (!record) throw new M16ArchivalError(`Khong tim thay record archival ${id}.`);
    if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
      throw new M16ArchivalError(`Importance phai trong [0, 1], nhan duoc ${importance}.`);
    }
    record.importance = importance;
    return { ...record };
  }

  /**
   * Decay importance theo thoi gian: record nao lau khong duoc mo
   * thi importance giam theo half-life. Tra so record bi giam.
   */
  decayImportance(now: Date = new Date(), halfLifeDays: number = M16_IMPORTANCE_HALF_LIFE_DAYS): number {
    const nowMs = now.getTime();
    let changed = 0;
    for (const record of this.records.values()) {
      const refMs = Date.parse(record.lastAccessedAt ?? record.archivedAt);
      if (Number.isNaN(refMs)) continue;
      const ageMs = nowMs - refMs;
      if (ageMs <= 0) continue;
      const halfLifeMs = Math.max(1, halfLifeDays) * 24 * 60 * 60 * 1000;
      const factor = Math.pow(0.5, ageMs / halfLifeMs);
      const next = record.importance * factor;
      if (next < record.importance - 0.001) {
        record.importance = Math.max(0, next);
        changed += 1;
      }
    }
    return changed;
  }

  stats(): {
    total: number;
    avgImportance: number;
    totalAccesses: number;
    byPredicate: Record<string, number>;
  } {
    const all = [...this.records.values()];
    const total = all.length;
    const avgImportance = total === 0 ? 0 : all.reduce((s, r) => s + r.importance, 0) / total;
    const totalAccesses = all.reduce((s, r) => s + r.accessCount, 0);
    const byPredicate: Record<string, number> = {};
    for (const r of all) byPredicate[r.predicate] = (byPredicate[r.predicate] ?? 0) + 1;
    return { total, avgImportance, totalAccesses, byPredicate };
  }

  toJSON(): { version: 1; records: M16ArchivalRecord[] } {
    return { version: 1, records: this.list() };
  }

  static fromJSON(data: unknown): { store: M16ArchivalStore; skipped: number } {
    const store = new M16ArchivalStore();
    let skipped = 0;
    const raw = (data ?? {}) as { records?: unknown };
    if (!Array.isArray(raw.records)) return { store, skipped: 0 };
    for (const item of raw.records) {
      const r = item as Partial<M16ArchivalRecord>;
      if (
        typeof r?.id !== 'string' ||
        typeof r?.subject !== 'string' ||
        typeof r?.predicate !== 'string' ||
        typeof r?.objectText !== 'string'
      ) {
        skipped += 1;
        continue;
      }
      store.records.set(r.id, {
        id: r.id,
        factId: typeof r.factId === 'string' ? r.factId : null,
        subject: r.subject,
        predicate: r.predicate,
        objectText: r.objectText,
        scope: (r.scope as MemoryScope) ?? { userId: '', botId: '', runId: '' },
        confidence: typeof r.confidence === 'number' ? r.confidence : 0.8,
        sourceText: typeof r.sourceText === 'string' ? r.sourceText : '',
        importance: typeof r.importance === 'number' ? r.importance : 0.5,
        accessCount: typeof r.accessCount === 'number' ? r.accessCount : 0,
        lastAccessedAt: typeof r.lastAccessedAt === 'string' ? r.lastAccessedAt : null,
        archivedAt: typeof r.archivedAt === 'string' ? r.archivedAt : nowIsoM16(),
        archivedBy: typeof r.archivedBy === 'string' ? r.archivedBy : 'system',
        reason: typeof r.reason === 'string' ? r.reason : '',
        validFrom: typeof r.validFrom === 'string' ? r.validFrom : null,
        validUntil: typeof r.validUntil === 'string' ? r.validUntil : null,
      });
    }
    return { store, skipped };
  }
}

/** Dem document frequency cua token tren toan bo record (cho IDF). */
export function archivalDocFreqM16(records: M16ArchivalRecord[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const r of records) {
    const tokens = new Set(archivalTokensM16(archivalIndexTextM16(r)));
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

/**
 * Archival recall: xep hang record theo 4 tin hieu (weighted hoac
 * RRF). Query rong -> tra record moi nhat theo recency + importance.
 */
export function archivalRecallM16(
  store: M16ArchivalStore,
  query: string,
  opts: M16ArchivalRecallOptions = {},
): M16ArchivalRecallResult {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const topK = opts.topK ?? 10;
  const minScore = opts.minScore ?? 0;
  const mode = opts.mode ?? 'weighted';
  const weights = normalizeArchivalWeightsM16(opts.weights);
  const halfLifeDays = opts.halfLifeDays ?? M16_DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const queryTokens = archivalTokensM16(query);
  const asOfMs = opts.asOf ? (opts.asOf instanceof Date ? opts.asOf.getTime() : Date.parse(opts.asOf)) : null;

  let records = store.list(opts.predicate);
  if (asOfMs !== null && !Number.isNaN(asOfMs)) {
    records = records.filter((r) => {
      if (r.validFrom && Date.parse(r.validFrom) > asOfMs) return false;
      if (r.validUntil !== null && Date.parse(r.validUntil) <= asOfMs) return false;
      return true;
    });
  }
  const totalDocs = Math.max(1, records.length);
  const docFreq = archivalDocFreqM16(records);

  interface Scored {
    record: M16ArchivalRecord;
    scores: { text: number; recency: number; importance: number; access: number };
    weighted: number;
    textRank: number;
    recencyRank: number;
  }
  const scored: Scored[] = records.map((record) => {
    const tokens = archivalTokensM16(archivalIndexTextM16(record));
    const text = archivalTextScoreM16(queryTokens, tokens, docFreq, totalDocs);
    const recency = archivalRecencyScoreM16(record.lastAccessedAt ?? record.archivedAt, nowMs, halfLifeDays);
    const importance = Math.min(1, Math.max(0, record.importance));
    const access = archivalAccessScoreM16(record.accessCount);
    const weighted = weights.text * text + weights.recency * recency + weights.importance * importance + weights.access * access;
    return { record, scores: { text, recency, importance, access }, weighted, textRank: 0, recencyRank: 0 };
  });

  // Rank rieng cho RRF: text desc, recency desc. Rank DONG HANG
  // (average rank) khi diem bang nhau trong epsilon: chenh lech
  // recency 1e-10 (cung mili-giay archive) khong phai tin hieu that,
  // khong duoc tao ra mot buoc rank day — neu khong RRF doi xung
  // se dat record khong khop text (nhung moi hon 1e-10) len tren
  // record khop text chinh xac.
  const assignRanks = (
    getScore: (s: Scored) => number,
    setRank: (s: Scored, rank: number) => void,
  ): void => {
    const sorted = [...scored].sort((a, b) => getScore(b) - getScore(a));
    let i = 0;
    while (i < sorted.length) {
      let j = i + 1;
      while (j < sorted.length && Math.abs(getScore(sorted[j]) - getScore(sorted[i])) <= 1e-9) j += 1;
      const avgRank = (i + 1 + j) / 2;
      for (let k = i; k < j; k += 1) setRank(sorted[k], avgRank);
      i = j;
    }
  };
  assignRanks(
    (s) => s.scores.text,
    (s, r) => {
      s.textRank = r;
    },
  );
  assignRanks(
    (s) => s.scores.recency,
    (s, r) => {
      s.recencyRank = r;
    },
  );

  const ranked = scored
    .map((s) => {
      const score =
        mode === 'rrf'
          ? 1 / (M16_RRF_K + s.textRank) + 1 / (M16_RRF_K + s.recencyRank)
          : s.weighted;
      return { ...s, score };
    })
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topK));

  return {
    query,
    total: records.length,
    hits: ranked.map((s, i) => ({ record: s.record, score: s.score, scores: s.scores, rank: i + 1 })),
  };
}

/** Retriever tien ich: giu store + goi recall, tu dong ghi access. */
export class M16ArchivalRetriever {
  constructor(private readonly store: M16ArchivalStore) {}

  recall(query: string, opts: M16ArchivalRecallOptions = {}): M16ArchivalRecallResult {
    return archivalRecallM16(this.store, query, opts);
  }

  /** Recall + ghi nhan access cho hit dau (fact duoc mo lai). */
  recallAndTouch(query: string, opts: M16ArchivalRecallOptions = {}): M16ArchivalRecallResult {
    const result = this.recall(query, opts);
    if (result.hits.length > 0) {
      this.store.recordAccess(result.hits[0].record.id, opts.now);
    }
    return result;
  }
}

/**
 * Archive hang loat fact het han (tu temporal sweep): tra so record
 * da tao. Fact goc trong graph KHONG bi xoa o day — caller quyet
 * dinh co deleteFact hay giu lai de truy van lich su.
 */
export function archiveExpiredFactsM16(
  archivalStore: M16ArchivalStore,
  facts: GraphFact[],
  actor = 'sleep-agent-v16',
  reason = 'het han — dua xuong archival',
  now?: Date,
): { archived: number; skipped: number; ids: string[] } {
  let archived = 0;
  let skipped = 0;
  const ids: string[] = [];
  for (const fact of facts) {
    const already = archivalStore.list().some((r) => r.factId === fact.id);
    if (already) {
      skipped += 1;
      continue;
    }
    const record = archivalStore.archiveFact(fact, actor, reason, { now });
    ids.push(record.id);
    archived += 1;
  }
  return { archived, skipped, ids };
}

/**
 * Promote 1 record archival tro lai graph active: tao fact moi trong
 * graph (ghi provenance "promoted from archival") + xoa record
 * archival. Tra fact moi.
 */
export function promoteArchivedToGraphM16(
  graphStore: TemporalGraphStore,
  archivalStore: M16ArchivalStore,
  archivalId: string,
  actor = 'system',
  now?: Date,
): GraphFact {
  const record = archivalStore.get(archivalId);
  if (!record) throw new M16ArchivalError(`Khong tim thay record archival ${archivalId} de promote.`);
  const at = (now ?? new Date()).toISOString();
  const fact = graphStore.addFact({
    subjectName: record.subject,
    predicate: record.predicate,
    objectText: record.objectText,
    confidence: record.confidence,
    scope: record.scope,
    provenance: {
      episodeId: '',
      turnId: '',
      runId: record.scope.runId ?? '',
      botId: record.scope.botId ?? '',
      userId: record.scope.userId ?? '',
      at,
      sourceText: `promoted from archival ${archivalId} by ${actor}: ${record.sourceText}`,
    },
    ...(record.validFrom ? { validFrom: record.validFrom } : {}),
    ...(record.validUntil !== undefined ? { validUntil: record.validUntil } : {}),
  });
  archivalStore.remove(archivalId);
  return fact;
}

// ---------------------------------------------------------------------------
// Archival candidates — goi y fact nen dua xuong kho lanh
// ---------------------------------------------------------------------------

export interface M16ArchivalCandidate {
  fact: GraphFact;
  /** So ngay tu khi fact duoc cap nhat lan cuoi. */
  ageDays: number;
  reason: string;
}

/**
 * Goi y fact nen archive: fact active da lau khong cap nhat (>=
 * olderThanDays) VA do tin cay thap (<= maxConfidence). Xep theo tuoi
 * giam dan (cu nhat truoc). Chi GOI Y — khong tu dong archive.
 */
export function suggestArchivalCandidatesM16(
  graphStore: TemporalGraphStore,
  opts: { olderThanDays?: number; maxConfidence?: number; limit?: number; now?: Date; scope?: import('../memory/graph/store').ScopeFilter } = {},
): M16ArchivalCandidate[] {
  const olderThanDays = opts.olderThanDays ?? 180;
  const maxConfidence = opts.maxConfidence ?? 0.7;
  const limit = opts.limit ?? 50;
  const nowMs = (opts.now ?? new Date()).getTime();
  const out: M16ArchivalCandidate[] = [];
  for (const fact of graphStore.listFacts({ ...(opts.scope ?? {}), status: 'active', limit: 500 })) {
    const updatedMs = Date.parse(fact.updatedAt);
    if (Number.isNaN(updatedMs)) continue;
    const ageDays = Math.floor((nowMs - updatedMs) / (24 * 60 * 60 * 1000));
    const expired = fact.validUntil !== null && Date.parse(fact.validUntil) <= nowMs;
    // Ung vien khi: cu (>= olderThanDays) HOAC da het hieu luc —
    // ca hai truong hop deu can tin cay thap (<= maxConfidence).
    if (ageDays < olderThanDays && !expired) continue;
    if (fact.confidence > maxConfidence) continue;
    const reasons: string[] = [];
    if (ageDays >= olderThanDays) reasons.push(`khong cap nhat ${ageDays} ngay`);
    if (fact.confidence <= 0.5) reasons.push(`tin cay thap (${fact.confidence.toFixed(2)})`);
    if (expired) reasons.push('da het hieu luc');
    out.push({ fact, ageDays, reason: reasons.join('; ') });
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out.slice(0, Math.max(0, limit));
}

/**
 * Top record archival theo importance (kem access count de UI uu
 * tien hien thi). Dung cho dashboard kho lanh.
 */
export function archivalImportanceTopM16(store: M16ArchivalStore, topK = 5): M16ArchivalRecord[] {
  const records = store.list();
  records.sort(
    (a, b) =>
      b.importance - a.importance ||
      b.accessCount - a.accessCount ||
      (a.archivedAt < b.archivedAt ? 1 : -1),
  );
  return records.slice(0, Math.max(0, topK));
}
