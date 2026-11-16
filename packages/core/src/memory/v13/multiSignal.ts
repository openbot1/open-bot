/**
 * Memory v13 — retrieval da tin hieu (v1.14, Doi T1).
 *
 * Y tuong hoc tu Mem0 (retrieval da tin hieu song song: semantic +
 * BM25 keyword + entity boost) va LongMemEval (do recall theo tung
 * phien ban) — tu thiet ke lai hoan toan cho open-bot, chay 100%
 * local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - Semantic: `LocalHashEmbedder` cua v10 (hash embedding xac dinh,
 *    khong can model) + `cosineSimilarity`.
 *  - BM25: lop `Bm25` cua graph v0.98 (k1=1.2, b=0.75, token tieng
 *    Viet bo dau).
 *  - Entity boost: `searchEntitiesByName` cua fusedRetrieval v1.02.
 *  - Nguon fact: `TemporalGraphStore.listFacts` (chi fact `active`,
 *    loc theo scope, chi fact con hieu luc neu `onlyValidNow`).
 *
 * Moi tin hieu duoc chuan hoa min-max ve [0,1] tren tap ung vien
 * truoc khi cong co trong so — neu khong, BM25 (diem tuyet doi lon)
 * se at ca hai tin hieu kia. Trong so cau hinh duoc, tong khong nhat
 * thiet bang 1 (ham tu chuan hoa); mac dinh semantic 0.45 / BM25
 * 0.35 / entity 0.20 — giong trong so fused cua v10 de ket qua
 * nhat quan giua cac phien ban.
 *
 * Moi hit kem bang giai thich (`scores` tung tin hieu + `sources`)
 * de UI giai thich tai sao memory nay duoc nho lai, va de benchmark
 * (benchmark.ts) do duoc tung tin hieu dong gop bao nhieu.
 */

import type { GraphFact, MemoryScope } from '../graph/types';
import { factSearchText, isFactValidAt, normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { Bm25 } from '../graph/bm25';
import { searchEntitiesByName } from '../graph/fusedRetrieval';
import { LocalHashEmbedder, cosineSimilarity } from '../v10/localEmbedding';
import type { ScopeFilter } from '../graph/store';

/** Loi retrieval — message tieng Viet. */
export class V13RetrievalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V13RetrievalError';
  }
}

/** Trong so 3 tin hieu (moi trong so >= 0, it nhat mot cai > 0). */
export interface V13RetrievalWeights {
  semantic: number;
  bm25: number;
  entity: number;
}

export const V13_DEFAULT_WEIGHTS: V13RetrievalWeights = {
  semantic: 0.45,
  bm25: 0.35,
  entity: 0.2,
};

export type V13RetrievalSource = 'semantic' | 'bm25' | 'entity';

/** Diem tung tin hieu (da chuan hoa min-max) + tong co trong so. */
export interface V13SignalScores {
  semantic: number;
  bm25: number;
  entity: number;
  total: number;
}

export interface V13MultiSignalHit {
  fact: GraphFact;
  subjectName: string;
  objectName?: string;
  scores: V13SignalScores;
  /** Tin hieu nao that su dong gop (> 0) cho hit nay. */
  sources: V13RetrievalSource[];
  /** Giai thich ngan gon de UI hien. */
  explanation: string;
}

export interface V13MultiSignalOptions {
  topK?: number;
  weights?: Partial<V13RetrievalWeights>;
  /** Embedder cho tin hieu semantic (mac dinh LocalHashEmbedder). */
  embedder?: LocalHashEmbedder;
  /** Bo qua tin hieu semantic (vd muon do rieng BM25+entity). */
  skipSemantic?: boolean;
  /** Chi fact con hieu luc ngay bay gio (mac dinh true). */
  onlyValidNow?: boolean;
  /** Loc scope (mac dinh: tat ca scope cua user hien tai). */
  scope?: ScopeFilter;
  /** Thoi diem kiem tra hieu luc (mac dinh bay gio). */
  asOf?: Date;
}

export interface V13MultiSignalResult {
  query: string;
  hits: V13MultiSignalHit[];
  weights: V13RetrievalWeights;
  sourcesUsed: V13RetrievalSource[];
  candidates: number;
  notes: string[];
}

/** Chuan hoa trong so: am -> 0, tong = 0 -> dung mac dinh. */
export function normalizeV13Weights(
  input?: Partial<V13RetrievalWeights>,
): V13RetrievalWeights {
  const base = { ...V13_DEFAULT_WEIGHTS, ...(input ?? {}) };
  const clean: V13RetrievalWeights = {
    semantic: Math.max(0, Number.isFinite(base.semantic) ? base.semantic : 0),
    bm25: Math.max(0, Number.isFinite(base.bm25) ? base.bm25 : 0),
    entity: Math.max(0, Number.isFinite(base.entity) ? base.entity : 0),
  };
  const sum = clean.semantic + clean.bm25 + clean.entity;
  if (sum <= 0) return { ...V13_DEFAULT_WEIGHTS };
  return {
    semantic: clean.semantic / sum,
    bm25: clean.bm25 / sum,
    entity: clean.entity / sum,
  };
}

/** Chuan hoa min-max mot mang diem ve [0,1] (tat ca bang nhau -> 0 het, tru diem max -> 1). */
export function minMaxNormalizeV13(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-12) return values.map(() => (max > 0 ? 1 : 0));
  return values.map((v) => (v - min) / (max - min));
}

function objectNameOf(store: TemporalGraphStore, fact: GraphFact): string | undefined {
  if (fact.objectId) return store.getEntity(fact.objectId)?.name;
  return fact.objectText;
}

function explainHit(
  scores: V13SignalScores,
  sources: V13RetrievalSource[],
  subjectName: string,
): string {
  const parts: string[] = [];
  if (scores.semantic > 0) parts.push(`ngu nghia ${scores.semantic.toFixed(2)}`);
  if (scores.bm25 > 0) parts.push(`tu khoa ${scores.bm25.toFixed(2)}`);
  if (scores.entity > 0) parts.push(`entity ${scores.entity.toFixed(2)}`);
  const detail = parts.length > 0 ? parts.join(' + ') : 'khong tin hieu nao manh';
  return `${subjectName}: tong ${scores.total.toFixed(2)} (${detail}) — nguon: ${sources.join(', ') || 'khong co'}.`;
}

/**
 * Retrieval da tin hieu tren fact cua temporal graph.
 * Khong bao gio throw vi embedder hong — tin hieu semantic chi don
 * gian vang mat (fail-open giong fusedRetrieve v1.02).
 */
export async function multiSignalRetrieve(
  store: TemporalGraphStore,
  query: string,
  opts: V13MultiSignalOptions = {},
): Promise<V13MultiSignalResult> {
  const cleanQuery = (query ?? '').trim();
  const weights = normalizeV13Weights(opts.weights);
  const topK = Math.max(1, Math.min(50, Math.floor(opts.topK ?? 10)));
  const onlyValidNow = opts.onlyValidNow !== false;
  const asOf = opts.asOf ?? new Date();
  const notes: string[] = [];
  if (cleanQuery === '') {
    return { query: cleanQuery, hits: [], weights, sourcesUsed: [], candidates: 0, notes: ['Query rong.'] };
  }

  const scopeFilter: ScopeFilter = { ...(opts.scope ?? {}) };
  const candidates = store
    .listFacts({ ...scopeFilter, status: 'active', limit: 5000 })
    .filter((f) => !onlyValidNow || isFactValidAt(f, asOf));
  if (candidates.length === 0) {
    return { query: cleanQuery, hits: [], weights, sourcesUsed: [], candidates: 0, notes: ['Khong co fact active nao trong scope.'] };
  }

  // --- Tin hieu 1: semantic (cosine voi hash embedding) ---
  const semanticRaw = new Map<string, number>();
  const sourcesUsed: V13RetrievalSource[] = [];
  if (opts.skipSemantic !== true && weights.semantic > 0) {
    try {
      const embedder = opts.embedder ?? new LocalHashEmbedder();
      const queryVec = embedder.embedSync(cleanQuery);
      for (const fact of candidates) {
        const text = factSearchText(
          fact,
          store.getEntity(fact.subjectId)?.name ?? 'user',
          objectNameOf(store, fact),
        );
        const vec = fact.embedding ?? embedder.embedSync(text);
        semanticRaw.set(fact.id, Math.max(0, cosineSimilarity(queryVec, vec)));
      }
      sourcesUsed.push('semantic');
    } catch {
      notes.push('Tin hieu semantic bi bo qua (embedder loi).');
    }
  }

  // --- Tin hieu 2: BM25 tu khoa ---
  const bm25Raw = new Map<string, number>();
  if (weights.bm25 > 0) {
    const docs = candidates.map((fact) => ({
      id: fact.id,
      text: factSearchText(
        fact,
        store.getEntity(fact.subjectId)?.name ?? 'user',
        objectNameOf(store, fact),
      ),
    }));
    const bm25 = new Bm25(docs);
    for (const hit of bm25.search(cleanQuery, candidates.length)) {
      bm25Raw.set(hit.id, hit.score);
    }
    sourcesUsed.push('bm25');
  }

  // --- Tin hieu 3: entity boost (query goi ten entity nao?) ---
  const entityRaw = new Map<string, number>();
  if (weights.entity > 0) {
    const matched = searchEntitiesByName(store, cleanQuery, 10);
    const boostByEntity = new Map<string, number>();
    for (const { entity, score } of matched) {
      boostByEntity.set(entity.id, score);
    }
    for (const fact of candidates) {
      const s = boostByEntity.get(fact.subjectId) ?? 0;
      const o = fact.objectId ? (boostByEntity.get(fact.objectId) ?? 0) : 0;
      const best = Math.max(s, o);
      if (best > 0) entityRaw.set(fact.id, best);
    }
    if (entityRaw.size > 0) sourcesUsed.push('entity');
  }

  // --- Chuan hoa tung tin hieu roi cong co trong so ---
  const ids = candidates.map((f) => f.id);
  const semNorm = new Map<string, number>();
  const bm25Norm = new Map<string, number>();
  const entNorm = new Map<string, number>();
  minMaxNormalizeV13(ids.map((id) => semanticRaw.get(id) ?? 0)).forEach((v, i) =>
    semNorm.set(ids[i], v),
  );
  minMaxNormalizeV13(ids.map((id) => bm25Raw.get(id) ?? 0)).forEach((v, i) =>
    bm25Norm.set(ids[i], v),
  );
  minMaxNormalizeV13(ids.map((id) => entityRaw.get(id) ?? 0)).forEach((v, i) =>
    entNorm.set(ids[i], v),
  );

  const hits: V13MultiSignalHit[] = [];
  for (const fact of candidates) {
    const s = semNorm.get(fact.id) ?? 0;
    const b = bm25Norm.get(fact.id) ?? 0;
    const e = entNorm.get(fact.id) ?? 0;
    const total = s * weights.semantic + b * weights.bm25 + e * weights.entity;
    if (total <= 0) continue;
    const sources: V13RetrievalSource[] = [];
    if (s > 0 && sourcesUsed.includes('semantic')) sources.push('semantic');
    if (b > 0) sources.push('bm25');
    if (e > 0) sources.push('entity');
    const subjectName = store.getEntity(fact.subjectId)?.name ?? 'user';
    const scores: V13SignalScores = { semantic: s, bm25: b, entity: e, total };
    hits.push({
      fact,
      subjectName,
      ...(objectNameOf(store, fact) ? { objectName: objectNameOf(store, fact) } : {}),
      scores,
      sources,
      explanation: explainHit(scores, sources, subjectName),
    });
  }
  hits.sort((a, b) => b.scores.total - a.scores.total || b.fact.confidence - a.fact.confidence);
  return {
    query: cleanQuery,
    hits: hits.slice(0, topK),
    weights,
    sourcesUsed,
    candidates: candidates.length,
    notes,
  };
}

/** Lop tien ich giu trong so + embedder mac dinh cho nhieu lan goi. */
export class V13MultiSignalRetriever {
  private readonly weights: V13RetrievalWeights;
  private readonly embedder: LocalHashEmbedder;

  constructor(opts: { weights?: Partial<V13RetrievalWeights>; embedder?: LocalHashEmbedder } = {}) {
    this.weights = normalizeV13Weights(opts.weights);
    this.embedder = opts.embedder ?? new LocalHashEmbedder();
  }

  get defaultWeights(): V13RetrievalWeights {
    return { ...this.weights };
  }

  retrieve(
    store: TemporalGraphStore,
    query: string,
    opts: Omit<V13MultiSignalOptions, 'weights' | 'embedder'> = {},
  ): Promise<V13MultiSignalResult> {
    return multiSignalRetrieve(store, query, {
      ...opts,
      weights: this.weights,
      embedder: this.embedder,
    });
  }

  /**
   * Do dong gop cua tung tin hieu: chay lai retrieval voi tung tin
   * hieu tat mot lan, xem top-1 co doi khong. Dung de benchmark
   * (xem benchmark.ts) va de debug khi ket qua la.
   */
  async ablation(
    store: TemporalGraphStore,
    query: string,
    opts: Omit<V13MultiSignalOptions, 'weights' | 'embedder'> = {},
  ): Promise<Record<V13RetrievalSource, string | null>> {
    const out: Record<V13RetrievalSource, string | null> = {
      semantic: null,
      bm25: null,
      entity: null,
    };
    const variants: { key: V13RetrievalSource; weights: V13RetrievalWeights }[] = [
      { key: 'semantic', weights: { semantic: 0, bm25: 0.5, entity: 0.5 } },
      { key: 'bm25', weights: { semantic: 0.5, bm25: 0, entity: 0.5 } },
      { key: 'entity', weights: { semantic: 0.5, bm25: 0.5, entity: 0 } },
    ];
    for (const v of variants) {
      const res = await multiSignalRetrieve(store, query, {
        ...opts,
        weights: v.weights,
        embedder: this.embedder,
      });
      out[v.key] = res.hits[0]?.fact.id ?? null;
    }
    return out;
  }
}

/** Scope mac dinh cho retrieval: user hien tai, khong gioi han bot/run. */
export function defaultV13Scope(scope: MemoryScope): ScopeFilter {
  return {
    ...(scope.userId !== '' ? { userId: scope.userId } : {}),
    ...(scope.botId !== '' ? { botId: scope.botId } : {}),
    ...(scope.runId !== '' ? { runId: scope.runId } : {}),
  };
}
