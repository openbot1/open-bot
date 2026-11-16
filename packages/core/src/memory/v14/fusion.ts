/**
 * Memory v14 — Retrieval fusion 3 tin hieu v2 (v1.15, Doi T1).
 *
 * Y tuong hoc tu Mem0 v3 (retrieve = semantic + keyword + entity
 * fusion) va Zep/Graphiti (hybrid search: semantic + BM25 + graph)
 * — tu thiet ke lai hoan toan cho open-bot, chay 100% local, KHONG
 * copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - Semantic: `LocalHashEmbedder` + `cosineSimilarity` cua v10.
 *  - BM25: lop `Bm25` cua graph v0.98.
 *  - `factSearchText` / `isFactValidAt` cua graph/types.
 *
 * Moi so voi v13 (multiSignal):
 *  1. Tin hieu graph THAT SU la graph: khong chi "query goi ten
 *     entity nao" ma ca 1-hop neighbours — fact noi toi entity
 *     ke cua entity trong query duoc 0.5 diem (vd hoi ve "An" thi
 *     fact ve "Cong ty Do" — noi lam viec cua An — van duoc diem
 *     graph nho, vi An --works_at--> Cong ty Do).
 *  2. Hai che do hop nhat: `weighted` (tong co trong so, mac
 *     dinh semantic 0.4 / BM25 0.35 / graph 0.25) va `rrf`
 *     (reciprocal rank fusion, k = 60 — on dinh khi diem tuyet
 *     doi cua cac tin hieu lech nhau qua lon).
 *  3. Loc theo cua so hieu luc TAI THOI DIEM HOI (`asOf`): fact
 *     het hieu luc truoc `asOf` bi loai ngay tu dau (ket hop
 *     temporal KG v3 — v13 chi loc "con hieu luc ngay bay gio").
 *  4. Moi hit kem bang giai thich day du + hang (rank) tung tin
 *     hieu de benchmark do duoc dong gop that cua tung tin hieu.
 */

import type { GraphFact } from '../graph/types';
import { factSearchText, isFactValidAt, normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import type { ScopeFilter } from '../graph/store';
import { Bm25 } from '../graph/bm25';
import { searchEntitiesByName } from '../graph/fusedRetrieval';
import { LocalHashEmbedder, cosineSimilarity } from '../v10/localEmbedding';
import { isFactValidAtV14 } from './temporalKg';

/** Loi retrieval fusion v14 — message tieng Viet. */
export class V14FusionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V14FusionError';
  }
}

export type V14FusionSource = 'semantic' | 'bm25' | 'graph';
export type V14FusionMode = 'weighted' | 'rrf';

export interface V14FusionWeights {
  semantic: number;
  bm25: number;
  graph: number;
}

export const V14_DEFAULT_FUSION_WEIGHTS: V14FusionWeights = {
  semantic: 0.4,
  bm25: 0.35,
  graph: 0.25,
};

/** RRF constant — k = 60 la gia tri chuan trong cac he hybrid search. */
export const V14_RRF_K = 60;

export interface V14FusionScores {
  semantic: number;
  bm25: number;
  graph: number;
  total: number;
}

export interface V14FusionHit {
  fact: GraphFact;
  subjectName: string;
  objectName?: string;
  scores: V14FusionScores;
  /** Hang cua fact trong tung tin hieu (1 = cao nhat; null = khong co trong tin hieu). */
  ranks: Record<V14FusionSource, number | null>;
  sources: V14FusionSource[];
  explanation: string;
}

export interface V14FusionOptions {
  topK?: number;
  weights?: Partial<V14FusionWeights>;
  mode?: V14FusionMode;
  embedder?: LocalHashEmbedder;
  skipSemantic?: boolean;
  /** Loc scope (mac dinh: tat ca scope). */
  scope?: ScopeFilter;
  /** Thoi diem kiem tra hieu luc (mac dinh: bay gio). */
  asOf?: Date;
  /** Chi fact con hieu luc tai asOf (mac dinh true). */
  onlyValidAtAsOf?: boolean;
  /** Tinh ca fact superseded co cua so bao phu asOf (mac dinh false). */
  includeSupersededHistory?: boolean;
}

export interface V14FusionResult {
  query: string;
  mode: V14FusionMode;
  hits: V14FusionHit[];
  weights: V14FusionWeights;
  sourcesUsed: V14FusionSource[];
  candidates: number;
  notes: string[];
}

export function normalizeV14Weights(input?: Partial<V14FusionWeights>): V14FusionWeights {
  const base = { ...V14_DEFAULT_FUSION_WEIGHTS, ...(input ?? {}) };
  const clean: V14FusionWeights = {
    semantic: Math.max(0, Number.isFinite(base.semantic) ? base.semantic : 0),
    bm25: Math.max(0, Number.isFinite(base.bm25) ? base.bm25 : 0),
    graph: Math.max(0, Number.isFinite(base.graph) ? base.graph : 0),
  };
  const sum = clean.semantic + clean.bm25 + clean.graph;
  if (sum <= 0) return { ...V14_DEFAULT_FUSION_WEIGHTS };
  return {
    semantic: clean.semantic / sum,
    bm25: clean.bm25 / sum,
    graph: clean.graph / sum,
  };
}

export function minMaxNormalizeV14(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-12) return values.map(() => (max > 0 ? 1 : 0));
  return values.map((v) => (v - min) / (max - min));
}

/** Hang 1-based cua moi id theo diem giam dan (khong co diem -> null). */
function ranksOf(scores: Map<string, number>): Map<string, number> {
  const sorted = [...scores.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const out = new Map<string, number>();
  sorted.forEach(([id], i) => out.set(id, i + 1));
  return out;
}

function objectNameOf(store: TemporalGraphStore, fact: GraphFact): string | undefined {
  if (fact.objectId) return store.getEntity(fact.objectId)?.name;
  return fact.objectText;
}

function explainHit(scores: V14FusionScores, sources: V14FusionSource[], subjectName: string): string {
  const parts: string[] = [];
  if (scores.semantic > 0) parts.push(`ngu nghia ${scores.semantic.toFixed(2)}`);
  if (scores.bm25 > 0) parts.push(`tu khoa ${scores.bm25.toFixed(2)}`);
  if (scores.graph > 0) parts.push(`graph ${scores.graph.toFixed(2)}`);
  const detail = parts.length > 0 ? parts.join(' + ') : 'khong tin hieu nao manh';
  return `${subjectName}: tong ${scores.total.toFixed(2)} (${detail}) — nguon: ${sources.join(', ') || 'khong co'}.`;
}

/**
 * Retrieval fusion 3 tin hieu tren fact cua temporal graph.
 * Khong throw vi embedder hong — tin hieu semantic chi vang mat.
 */
export async function fusedRetrieveV14(
  store: TemporalGraphStore,
  query: string,
  opts: V14FusionOptions = {},
): Promise<V14FusionResult> {
  const cleanQuery = (query ?? '').trim();
  const weights = normalizeV14Weights(opts.weights);
  const mode: V14FusionMode = opts.mode === 'rrf' ? 'rrf' : 'weighted';
  const topK = Math.max(1, Math.min(50, Math.floor(opts.topK ?? 10)));
  const onlyValid = opts.onlyValidAtAsOf !== false;
  const asOf = opts.asOf ?? new Date();
  const notes: string[] = [];
  if (cleanQuery === '') {
    return { query: cleanQuery, mode, hits: [], weights, sourcesUsed: [], candidates: 0, notes: ['Query rong.'] };
  }

  const scopeFilter: ScopeFilter = { ...(opts.scope ?? {}) };
  const statusFilter = opts.includeSupersededHistory === true ? undefined : 'active';
  const candidates = store
    .listFacts({ ...scopeFilter, ...(statusFilter ? { status: statusFilter } : {}), limit: 5000 })
    .filter((f) => {
      if (!onlyValid) return true;
      if (opts.includeSupersededHistory === true) return isFactValidAtV14(f, asOf);
      return isFactValidAt(f, asOf);
    });
  if (candidates.length === 0) {
    return { query: cleanQuery, mode, hits: [], weights, sourcesUsed: [], candidates: 0, notes: ['Khong co fact nao trong scope / con hieu luc.'] };
  }

  // --- Tin hieu 1: semantic (cosine voi hash embedding) ---
  const semanticRaw = new Map<string, number>();
  const sourcesUsed: V14FusionSource[] = [];
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

  // --- Tin hieu 3: graph (entity truc tiep = 1, hang xom 1-hop = 0.5) ---
  const graphRaw = new Map<string, number>();
  if (weights.graph > 0) {
    const matched = searchEntitiesByName(store, cleanQuery, 10);
    const matchedIds = new Set(matched.map((m) => m.entity.id));
    const neighbourIds = new Set<string>();
    if (matchedIds.size > 0) {
      for (const id of matchedIds) {
        for (const f of store.neighbours(id, scopeFilter, 50)) {
          if (f.subjectId !== id) neighbourIds.add(f.subjectId);
          if (f.objectId && f.objectId !== id) neighbourIds.add(f.objectId);
        }
      }
    }
    for (const fact of candidates) {
      let best = 0;
      if (matchedIds.has(fact.subjectId) || (fact.objectId && matchedIds.has(fact.objectId))) {
        best = 1;
      } else if (neighbourIds.has(fact.subjectId) || (fact.objectId && neighbourIds.has(fact.objectId))) {
        best = 0.5;
      }
      if (best > 0) graphRaw.set(fact.id, best);
    }
    if (graphRaw.size > 0) sourcesUsed.push('graph');
  }

  // --- Hop nhat ---
  const ids = candidates.map((f) => f.id);
  const semNorm = new Map<string, number>();
  const bm25Norm = new Map<string, number>();
  const graphNorm = new Map<string, number>();
  minMaxNormalizeV14(ids.map((id) => semanticRaw.get(id) ?? 0)).forEach((v, i) => semNorm.set(ids[i], v));
  minMaxNormalizeV14(ids.map((id) => bm25Raw.get(id) ?? 0)).forEach((v, i) => bm25Norm.set(ids[i], v));
  minMaxNormalizeV14(ids.map((id) => graphRaw.get(id) ?? 0)).forEach((v, i) => graphNorm.set(ids[i], v));
  const semRanks = ranksOf(semanticRaw);
  const bm25Ranks = ranksOf(bm25Raw);
  const graphRanks = ranksOf(graphRaw);

  const hits: V14FusionHit[] = [];
  for (const fact of candidates) {
    const s = semNorm.get(fact.id) ?? 0;
    const b = bm25Norm.get(fact.id) ?? 0;
    const g = graphNorm.get(fact.id) ?? 0;
    let total: number;
    if (mode === 'rrf') {
      const rrf = (rank: number | undefined): number =>
        rank === undefined ? 0 : 1 / (V14_RRF_K + rank);
      total =
        weights.semantic * rrf(semRanks.get(fact.id)) +
        weights.bm25 * rrf(bm25Ranks.get(fact.id)) +
        weights.graph * rrf(graphRanks.get(fact.id));
      // Chuan hoa RRF ve [0,1] de so sanh duoc voi che do weighted.
      const maxRrf = 1 / (V14_RRF_K + 1);
      total = total / maxRrf;
    } else {
      total = s * weights.semantic + b * weights.bm25 + g * weights.graph;
    }
    if (total <= 0) continue;
    const sources: V14FusionSource[] = [];
    if (s > 0 && sourcesUsed.includes('semantic')) sources.push('semantic');
    if (b > 0) sources.push('bm25');
    if (g > 0) sources.push('graph');
    const subjectName = store.getEntity(fact.subjectId)?.name ?? 'user';
    const scores: V14FusionScores = { semantic: s, bm25: b, graph: g, total };
    hits.push({
      fact,
      subjectName,
      ...(objectNameOf(store, fact) ? { objectName: objectNameOf(store, fact) } : {}),
      scores,
      ranks: {
        semantic: semRanks.get(fact.id) ?? null,
        bm25: bm25Ranks.get(fact.id) ?? null,
        graph: graphRanks.get(fact.id) ?? null,
      },
      sources,
      explanation: explainHit(scores, sources, subjectName),
    });
  }
  hits.sort((a, b) => b.scores.total - a.scores.total || b.fact.confidence - a.fact.confidence);
  return {
    query: cleanQuery,
    mode,
    hits: hits.slice(0, topK),
    weights,
    sourcesUsed,
    candidates: candidates.length,
    notes,
  };
}

/** Lop tien ich giu trong so + embedder mac dinh cho nhieu lan goi. */
export class V14FusionRetriever {
  private readonly weights: V14FusionWeights;
  private readonly mode: V14FusionMode;
  private readonly embedder: LocalHashEmbedder;

  constructor(opts: { weights?: Partial<V14FusionWeights>; mode?: V14FusionMode; embedder?: LocalHashEmbedder } = {}) {
    this.weights = normalizeV14Weights(opts.weights);
    this.mode = opts.mode === 'rrf' ? 'rrf' : 'weighted';
    this.embedder = opts.embedder ?? new LocalHashEmbedder();
  }

  get defaultWeights(): V14FusionWeights {
    return { ...this.weights };
  }

  get defaultMode(): V14FusionMode {
    return this.mode;
  }

  retrieve(
    store: TemporalGraphStore,
    query: string,
    opts: Omit<V14FusionOptions, 'weights' | 'embedder' | 'mode'> = {},
  ): Promise<V14FusionResult> {
    return fusedRetrieveV14(store, query, {
      ...opts,
      weights: this.weights,
      mode: this.mode,
      embedder: this.embedder,
    });
  }

  /**
   * Do dong gop cua tung tin hieu: tat tung tin hieu mot lan, xem
   * top-1 co doi khong.
   */
  async ablation(
    store: TemporalGraphStore,
    query: string,
    opts: Omit<V14FusionOptions, 'weights' | 'embedder' | 'mode'> = {},
  ): Promise<Record<V14FusionSource, string | null>> {
    const out: Record<V14FusionSource, string | null> = { semantic: null, bm25: null, graph: null };
    const variants: { key: V14FusionSource; weights: V14FusionWeights }[] = [
      { key: 'semantic', weights: { semantic: 0, bm25: 0.5, graph: 0.5 } },
      { key: 'bm25', weights: { semantic: 0.5, bm25: 0, graph: 0.5 } },
      { key: 'graph', weights: { semantic: 0.5, bm25: 0.5, graph: 0 } },
    ];
    for (const v of variants) {
      const res = await fusedRetrieveV14(store, query, {
        ...opts,
        weights: v.weights,
        mode: this.mode,
        embedder: this.embedder,
      });
      out[v.key] = res.hits[0]?.fact.id ?? null;
    }
    return out;
  }
}

/** Scope mac dinh cho retrieval: user hien tai (xem temporalKg.defaultV14Scope). */
