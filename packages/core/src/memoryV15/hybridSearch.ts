/**
 * Memory v15 — Hybrid search v2 (v1.16, Doi T1).
 *
 * Y tuong hoc tu Mem0 v3 (search fuse semantic + BM25 + entity) va
 * Zep/Graphiti (hybrid: semantic + BM25 + graph) — tu thiet ke lai
 * hoan toan cho open-bot, chay 100% local, KHONG copy code/text/tai
 * san cua bat ky repo nao.
 *
 * Moi so voi fusion v14 (3 tin hieu: semantic + BM25 + graph 1-hop):
 *  1. Tin hieu thu 4 — RECENCY DECAY: fact moi hon duoc uu tien
 *     theo ham mu (half-life mac dinh 180 ngay, tinh tu validFrom).
 *     Dieu nay lam retrieval-time supersede hoat dong trong search:
 *     fact moi cung (subject, predicate) noi len tren nho recency,
 *     du ca hai van con active trong store.
 *  2. Graph proximity 2-hop: entity trong query duoc 1.0; fact
 *     noi toi entity ke 1-hop duoc 0.5; 2-hop duoc 0.25 (v14 chi
 *     co 1-hop 0.5). Ke do hang xom tinh tu tat ca fact active.
 *  3. Loc asOf theo CUA SO (window-based, giong v14) + tuy chon
 *     `resolveSuperseded`: khi bat, cac nhom don tri chi giu
 *     winner cua `resolveCurrentV15` (retrieval-time supersede
 *     ap dung ngay trong search).
 *  4. Poisoning defence noi tiep v1.15: fact quarantined bi loai
 *     khoi ket qua (co dem); fact khong co provenance (episodeId
 *     rong) bi loai (co dem); gate trich xuat dung lai judge v14
 *     (`gateExtractedV15`) + quarantine v14 (`quarantineExtractedV15`).
 *
 * Ke thua, khong viet lai:
 *  - `LocalHashEmbedder` + `cosineSimilarity` (v10): semantic,
 *    embedding hash-local xac dinh (mock Ollama-style, offline).
 *    Text index cua fact kem them ban dich vi ngu tieng Viet
 *    (`factIndexTextV15`) de query tieng Viet khop schema tieng Anh.
 *  - `Bm25` (graph v0.98): BM25 keyword.
 *  - `isFactValidAtV15` (temporalKg.ts): loc cua so tai asOf.
 *  - `resolveCurrentV15` (consolidation.ts): collapse nhom don tri.
 *  - Judge + quarantine v14 (poisoning.ts): gate/quarantine.
 */

import type { GraphFact, MemoryScope } from '../memory/graph/types';
import { normalizeGraphText } from '../memory/graph/types';
import type { TemporalGraphStore } from '../memory/graph/store';
import type { ScopeFilter } from '../memory/graph/store';
import { Bm25 } from '../memory/graph/bm25';
import { LocalHashEmbedder, cosineSimilarity } from '../memory/v10/localEmbedding';
import { isFactValidAtV15 } from './temporalKg';
import { resolveCurrentV15, isSingleValuedPredicateV15 } from './consolidation';
import type { V15ExtractedFact } from './consolidation';
import { judgeCandidateV14, quarantineCandidateV14 } from '../memory/v14/poisoning';
import type { V14ExtractedFact } from '../memory/v14/extraction';

/** Loi hybrid search v15 — message tieng Viet. */
export class V15HybridError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V15HybridError';
  }
}

export type V15HybridSource = 'semantic' | 'bm25' | 'graph' | 'recency';
export type V15HybridMode = 'weighted' | 'rrf';

export interface V15HybridWeights {
  semantic: number;
  bm25: number;
  graph: number;
  recency: number;
}

export const V15_DEFAULT_HYBRID_WEIGHTS: V15HybridWeights = {
  semantic: 0.35,
  bm25: 0.3,
  graph: 0.2,
  recency: 0.15,
};

/** RRF constant — k = 60 la gia tri chuan trong cac he hybrid search. */
export const V15_RRF_K = 60;
/**
 * Half-life mac dinh cua recency decay (ngay) — 180 ngay cho hop
 * voi memory dai han (fact trai dai nhieu nam): voi half-life 30
 * ngay thi moi fact cu hon vai thang deu co recency ~0, tin hieu
 * mat tac dung.
 */
export const V15_DEFAULT_RECENCY_HALF_LIFE_DAYS = 180;

export interface V15HybridScores {
  semantic: number;
  bm25: number;
  graph: number;
  recency: number;
  total: number;
}

export interface V15HybridHit {
  fact: GraphFact;
  subjectName: string;
  objectName?: string;
  scores: V15HybridScores;
  /** Hang cua fact trong tung tin hieu (1 = cao nhat; null = khong co trong tin hieu). */
  ranks: Record<V15HybridSource, number | null>;
  sources: V15HybridSource[];
  /** Giai thich ngan vi sao fact nay duoc chon. */
  explanation: string;
}

export interface V15HybridOptions {
  scope?: MemoryScope;
  /** Chi lay fact dung tai thoi diem nay (mac dinh: bay gio). */
  asOf?: string | Date;
  topK?: number;
  weights?: Partial<V15HybridWeights>;
  mode?: V15HybridMode;
  /** Half-life recency (ngay). Mac dinh 30. */
  recencyHalfLifeDays?: number;
  /** true = collapse nhom don tri ve winner (retrieval-time supersede). */
  resolveSuperseded?: boolean;
  /** Diem total toi thieu de giu hit (mac dinh 0 — giu het). */
  minScore?: number;
  now?: Date;
}

export interface V15HybridResult {
  query: string;
  mode: V15HybridMode;
  weights: V15HybridWeights;
  hits: V15HybridHit[];
  totalCandidates: number;
  /** So fact bi loai vi dang quarantined. */
  excludedQuarantined: number;
  /** So fact bi loai vi thieu provenance (episodeId rong). */
  excludedNoProvenance: number;
  /** So fact bi loai vi het hieu luc tai asOf. */
  excludedNotValidAt: number;
  /** So nhom don tri da collapse ve winner (khi resolveSuperseded). */
  collapsedGroups: number;
}

export function normalizeV15Weights(input?: Partial<V15HybridWeights>): V15HybridWeights {
  const w: V15HybridWeights = {
    semantic: input?.semantic ?? V15_DEFAULT_HYBRID_WEIGHTS.semantic,
    bm25: input?.bm25 ?? V15_DEFAULT_HYBRID_WEIGHTS.bm25,
    graph: input?.graph ?? V15_DEFAULT_HYBRID_WEIGHTS.graph,
    recency: input?.recency ?? V15_DEFAULT_HYBRID_WEIGHTS.recency,
  };
  const sum = w.semantic + w.bm25 + w.graph + w.recency;
  if (sum <= 0) return { ...V15_DEFAULT_HYBRID_WEIGHTS };
  return {
    semantic: w.semantic / sum,
    bm25: w.bm25 / sum,
    graph: w.graph / sum,
    recency: w.recency / sum,
  };
}

/** Min-max normalize ve [0, 1] (tat ca bang nhau -> toan 1 neu > 0). */
export function minMaxNormalizeV15(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map((v) => (v > 0 ? 1 : 0));
  return values.map((v) => (v - min) / (max - min));
}

/** Recency decay: 1 luc moi, giam mot nua moi half-life. */
export function recencyScoreV15(validFrom: string, nowMs: number, halfLifeDays: number): number {
  const fromMs = Date.parse(validFrom);
  if (Number.isNaN(fromMs)) return 0;
  const ageDays = Math.max(0, (nowMs - fromMs) / 86400000);
  const halfLife = halfLifeDays > 0 ? halfLifeDays : V15_DEFAULT_RECENCY_HALF_LIFE_DAYS;
  return Math.pow(0.5, ageDays / halfLife);
}

/**
 * Ban dich vi ngu sang tieng Viet (de query tieng Viet khop fact
 * co schema tieng Anh: 'thich' khop 'likes', 'song o' khop
 * 'lives_in'...). Chi phuc vu index tim kiem, khong doi schema.
 */
export const V15_PREDICATE_VI: Record<string, string> = {
  likes: 'thích',
  dislikes: 'ghét',
  prefers: 'thích hơn',
  lives_in: 'sống ở',
  works_at: 'làm ở',
  born_in: 'sinh ở',
  studies_at: 'học ở',
  favorite: 'yêu thích nhất',
  speaks: 'nói',
  visited: 'đã đến',
  plays: 'chơi',
  reads: 'đọc',
  watches: 'xem',
  goal: 'mục tiêu',
  daily_routine: 'thói quen hàng ngày',
  constraint: 'không được',
  allergic_to: 'dị ứng',
  is_friend_of: 'bạn của',
  lives_with: 'sống cùng',
  commutes_by: 'đi làm bằng',
  has_pet: 'nuôi',
  owns: 'có',
  eats: 'ăn',
  knows_skill: 'giỏi',
  works_with: 'làm cùng',
  uses: 'dùng',
  wants: 'muốn',
};

/** Text index cua mot fact: subject + vi ngu (Viet + Anh) + object. */
export function factIndexTextV15(
  fact: GraphFact,
  subjectName: string,
  objectName?: string,
): string {
  const object = objectName ?? fact.objectText ?? '';
  const vi = V15_PREDICATE_VI[fact.predicate];
  const predicateEn = fact.predicate.replace(/_/g, ' ');
  const predicatePart = vi ? `${vi} ${predicateEn}` : predicateEn;
  return `${subjectName} ${predicatePart} ${object}`.trim();
}

/** Tach query thanh token chuan hoa (dung cho graph entity match). */
export function queryTokensV15(query: string): string[] {
  return normalizeGraphText(query ?? '')
    .split(/[^a-z0-9à-ỹ]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

interface V15GraphProximity {
  /** entityId -> khoang cach tu query (0 = truc tiep, 1, 2; Infinity = khong toi duoc). */
  distanceByEntity: Map<string, number>;
}

/**
 * Tinh khoang cach graph tu query: entity nao co ten/token xuat hien
 * trong query la 0-hop; ke cua no qua 1 fact la 1-hop; ke cua ke la
 * 2-hop. Chi xet fact active trong scope.
 */
export function graphProximityV15(
  store: TemporalGraphStore,
  query: string,
  filter: ScopeFilter = {},
): V15GraphProximity {
  const tokens = new Set(queryTokensV15(query));
  const normQuery = normalizeGraphText(query);
  const distanceByEntity = new Map<string, number>();
  // Entity truc tiep: ten chuan hoa xuat hien trong query, hoac co
  // token chung dai >= 3 ky tu voi query.
  for (const entity of store.listEntities(filter)) {
    const normName = normalizeGraphText(entity.name);
    if (normName !== '' && normQuery.includes(normName)) {
      distanceByEntity.set(entity.id, 0);
      continue;
    }
    const nameTokens = normName.split(/[^a-z0-9à-ỹ]+/i).filter((t) => t.length >= 3);
    if (nameTokens.some((t) => tokens.has(t))) {
      distanceByEntity.set(entity.id, 0);
    }
    for (const alias of entity.aliases ?? []) {
      const normAlias = normalizeGraphText(alias);
      if (normAlias !== '' && normQuery.includes(normAlias)) {
        distanceByEntity.set(entity.id, 0);
      }
    }
  }
  if (distanceByEntity.size === 0) return { distanceByEntity };
  // Ke do: subject <-> object qua moi fact active. Ngoai objectId,
  // objectText trung ten mot entity cung noi (fact import tay hay
  // trich xuat khong danh dau objectIsEntity van noi duoc graph).
  const entityByNormName = new Map<string, string>();
  for (const entity of store.listEntities(filter)) {
    entityByNormName.set(normalizeGraphText(entity.name), entity.id);
    for (const alias of entity.aliases ?? []) {
      entityByNormName.set(normalizeGraphText(alias), entity.id);
    }
  }
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string | undefined): void => {
    if (!b) return;
    const setA = neighbours.get(a) ?? new Set<string>();
    setA.add(b);
    neighbours.set(a, setA);
    const setB = neighbours.get(b) ?? new Set<string>();
    setB.add(a);
    neighbours.set(b, setB);
  };
  for (const fact of store.listFacts({ ...filter, status: 'active', limit: 5000 })) {
    link(fact.subjectId, fact.objectId);
    if (!fact.objectId && fact.objectText) {
      const objectEntityId = entityByNormName.get(normalizeGraphText(fact.objectText));
      if (objectEntityId && objectEntityId !== fact.subjectId) {
        link(fact.subjectId, objectEntityId);
      }
    }
  }
  // BFS toi 2 hop tu cac entity 0-hop.
  const queue: { id: string; dist: number }[] = [...distanceByEntity.entries()].map(
    ([id]) => ({ id, dist: 0 }),
  );
  const seen = new Set<string>(distanceByEntity.keys());
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || cur.dist >= 2) continue;
    for (const nb of neighbours.get(cur.id) ?? []) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      distanceByEntity.set(nb, cur.dist + 1);
      queue.push({ id: nb, dist: cur.dist + 1 });
    }
  }
  return { distanceByEntity };
}

/** Diem graph cua mot fact theo khoang cach entity gan nhat no cham toi. */
export function graphScoreForFactV15(
  fact: GraphFact,
  proximity: V15GraphProximity,
): number {
  const distances = [
    proximity.distanceByEntity.get(fact.subjectId),
    fact.objectId ? proximity.distanceByEntity.get(fact.objectId) : undefined,
  ].filter((d): d is number => typeof d === 'number');
  if (distances.length === 0) return 0;
  const best = Math.min(...distances);
  if (best === 0) return 1;
  if (best === 1) return 0.5;
  if (best === 2) return 0.25;
  return 0;
}

function rankOfV15(
  sortedIds: string[],
  id: string,
): number | null {
  const idx = sortedIds.indexOf(id);
  return idx === -1 ? null : idx + 1;
}

function explainHitV15(
  hit: Omit<V15HybridHit, 'explanation'>,
): string {
  const parts: string[] = [];
  const s = hit.scores;
  if (s.semantic > 0.01) parts.push(`ngu nghia ${s.semantic.toFixed(2)}`);
  if (s.bm25 > 0.01) parts.push(`tu khoa ${s.bm25.toFixed(2)}`);
  if (s.graph > 0) parts.push(`graph ${s.graph.toFixed(2)}`);
  if (s.recency > 0.01) parts.push(`moi ${s.recency.toFixed(2)}`);
  if (parts.length === 0) return 'Khop yeu tren ca 4 tin hieu.';
  return `Vi: ${parts.join(', ')}.`;
}

/**
 * Hybrid search 4 tin hieu: semantic (cosine, hash embedding) +
 * BM25 + graph proximity (0/1/2-hop) + recency decay. Che do
 * `weighted` (tong co trong so sau min-max normalize) hoac `rrf`
 * (reciprocal rank fusion, k = 60).
 *
 * Poisoning defence (noi v1.15): fact quarantined hoac thieu
 * provenance (episodeId rong) bi loai khoi ket qua va dem rieng.
 */
export async function hybridSearchV15(
  store: TemporalGraphStore,
  query: string,
  opts: V15HybridOptions = {},
): Promise<V15HybridResult> {
  const cleanQuery = (query ?? '').trim();
  if (cleanQuery === '') {
    throw new V15HybridError('Query tim kiem khong duoc rong.');
  }
  const scope: MemoryScope = opts.scope ?? { userId: '', botId: '', runId: '' };
  const asOf = opts.asOf ?? opts.now ?? new Date();
  const nowMs = (opts.now ?? new Date()).getTime();
  const topK = Math.max(1, opts.topK ?? 10);
  const weights = normalizeV15Weights(opts.weights);
  const mode: V15HybridMode = opts.mode ?? 'weighted';
  const halfLife = opts.recencyHalfLifeDays ?? V15_DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const minScore = opts.minScore ?? 0;

  // --- Loc ung vien: active + dung tai asOf + co provenance + khong quarantine. ---
  const all = store.listFacts({ ...scope, limit: 5000 });
  let excludedQuarantined = 0;
  let excludedNoProvenance = 0;
  let excludedNotValidAt = 0;
  const candidates: { fact: GraphFact; subjectName: string; objectName?: string }[] = [];
  for (const fact of all) {
    if (fact.status === 'quarantined') {
      excludedQuarantined += 1;
      continue;
    }
    if (fact.status === 'deleted') continue;
    if (!fact.provenance || (fact.provenance.episodeId ?? '').trim() === '') {
      excludedNoProvenance += 1;
      continue;
    }
    if (!isFactValidAtV15(fact, asOf)) {
      excludedNotValidAt += 1;
      continue;
    }
    candidates.push({
      fact,
      subjectName: store.getEntity(fact.subjectId)?.name ?? '',
      ...(fact.objectId
        ? { objectName: store.getEntity(fact.objectId)?.name }
        : {}),
    });
  }
  const totalCandidates = candidates.length;
  if (candidates.length === 0) {
    return {
      query: cleanQuery,
      mode,
      weights,
      hits: [],
      totalCandidates,
      excludedQuarantined,
      excludedNoProvenance,
      excludedNotValidAt,
      collapsedGroups: 0,
    };
  }

  // --- Tin hieu 1: semantic (cosine tren hash embedding). ---
  const embedder = new LocalHashEmbedder();
  const queryVec = await embedder.embed(cleanQuery);
  const semanticRaw = new Map<string, number>();
  for (const c of candidates) {
    const text = factIndexTextV15(c.fact, c.subjectName, c.objectName);
    const vec = await embedder.embed(text);
    semanticRaw.set(c.fact.id, Math.max(0, cosineSimilarity(queryVec, vec)));
  }

  // --- Tin hieu 2: BM25. ---
  const bm25 = new Bm25(
    candidates.map((c) => ({
      id: c.fact.id,
      text: factIndexTextV15(c.fact, c.subjectName, c.objectName),
    })),
  );
  const bm25Raw = new Map<string, number>();
  for (const r of bm25.search(cleanQuery, Math.max(topK * 5, 50))) {
    bm25Raw.set(r.id, r.score);
  }

  // --- Tin hieu 3: graph proximity 2-hop. ---
  const proximity = graphProximityV15(store, cleanQuery, scope);
  const graphRaw = new Map<string, number>();
  for (const c of candidates) {
    graphRaw.set(c.fact.id, graphScoreForFactV15(c.fact, proximity));
  }

  // --- Tin hieu 4: recency decay. ---
  const recencyRaw = new Map<string, number>();
  for (const c of candidates) {
    recencyRaw.set(c.fact.id, recencyScoreV15(c.fact.validFrom, nowMs, halfLife));
  }

  // --- Normalize + hop nhat. ---
  // Semantic / BM25 / graph duoc min-max normalize ve [0, 1].
  // Recency KHONG min-max: no da o [0, 1] va la ham mu — min-max
  // tren cac gia tri gan 0 se khuếch dai chenh lech vo nghia
  // (vd 0.0024 -> 1.0) khien fact moi hon thang vo co du noi dung
  // kem lien quan hon. Dung gia tri tho de tin hieu nay chi la
  // "uu tien nhe cho fact moi" dung nhu thiet ke.
  const ids = candidates.map((c) => c.fact.id);
  const norm = (raw: Map<string, number>): Map<string, number> => {
    const vals = ids.map((id) => raw.get(id) ?? 0);
    const normed = minMaxNormalizeV15(vals);
    const out = new Map<string, number>();
    ids.forEach((id, i) => out.set(id, normed[i] ?? 0));
    return out;
  };
  const semN = norm(semanticRaw);
  const bmN = norm(bm25Raw);
  const graphN = norm(graphRaw);
  const recN = new Map<string, number>(ids.map((id) => [id, recencyRaw.get(id) ?? 0]));

  const sortedBy = (raw: Map<string, number>): string[] =>
    [...ids].sort((a, b) => (raw.get(b) ?? 0) - (raw.get(a) ?? 0));
  const semRank = sortedBy(semanticRaw);
  const bmRank = sortedBy(bm25Raw);
  const graphRank = sortedBy(graphRaw);
  const recRank = sortedBy(recencyRaw);

  let hits: V15HybridHit[] = candidates.map((c) => {
    const id = c.fact.id;
    const scores: V15HybridScores = {
      semantic: semN.get(id) ?? 0,
      bm25: bmN.get(id) ?? 0,
      graph: graphN.get(id) ?? 0,
      recency: recN.get(id) ?? 0,
      total: 0,
    };
    if (mode === 'rrf') {
      const rrf = (rank: number | null): number =>
        rank === null ? 0 : 1 / (V15_RRF_K + rank);
      scores.total =
        weights.semantic * rrf(rankOfV15(semRank, id)) +
        weights.bm25 * rrf(rankOfV15(bmRank, id)) +
        weights.graph * rrf(rankOfV15(graphRank, id)) +
        weights.recency * rrf(rankOfV15(recRank, id));
    } else {
      scores.total =
        weights.semantic * scores.semantic +
        weights.bm25 * scores.bm25 +
        weights.graph * scores.graph +
        weights.recency * scores.recency;
    }
    const sources: V15HybridSource[] = [];
    if (scores.semantic > 0) sources.push('semantic');
    if (scores.bm25 > 0) sources.push('bm25');
    if (scores.graph > 0) sources.push('graph');
    if (scores.recency > 0) sources.push('recency');
    const base: Omit<V15HybridHit, 'explanation'> = {
      fact: c.fact,
      subjectName: c.subjectName,
      ...(c.objectName ? { objectName: c.objectName } : {}),
      scores,
      ranks: {
        semantic: rankOfV15(semRank, id),
        bm25: rankOfV15(bmRank, id),
        graph: rankOfV15(graphRank, id),
        recency: rankOfV15(recRank, id),
      },
      sources,
    };
    return { ...base, explanation: explainHitV15(base) };
  });

  hits = hits.filter((h) => h.scores.total >= minScore);
  hits.sort((a, b) => b.scores.total - a.scores.total);

  // --- Tuy chon: collapse nhom don tri ve winner (retrieval-time supersede). ---
  let collapsedGroups = 0;
  if (opts.resolveSuperseded) {
    const winners = new Map<string, GraphFact>();
    const seenGroups = new Set<string>();
    for (const hit of hits) {
      const f = hit.fact;
      if (!isSingleValuedPredicateV15(f.predicate)) continue;
      const key = `${normalizeGraphText(hit.subjectName)}|${f.predicate}`;
      if (!winners.has(key)) {
        const res = resolveCurrentV15(store, hit.subjectName, f.predicate, scope, asOf);
        seenGroups.add(key);
        if (res.winner) winners.set(key, res.winner);
      }
    }
    if (seenGroups.size > 0) {
      const before = hits.length;
      hits = hits.filter((hit) => {
        const f = hit.fact;
        if (!isSingleValuedPredicateV15(f.predicate)) return true;
        const key = `${normalizeGraphText(hit.subjectName)}|${f.predicate}`;
        const winner = winners.get(key);
        return !winner || winner.id === f.id;
      });
      collapsedGroups = before - hits.length;
    }
  }

  return {
    query: cleanQuery,
    mode,
    weights,
    hits: hits.slice(0, topK),
    totalCandidates,
    excludedQuarantined,
    excludedNoProvenance,
    excludedNotValidAt,
    collapsedGroups,
  };
}

/** Lop retriever giu embedder dung lai giua cac lan goi (tien cho tool). */
export class V15HybridRetriever {
  private readonly embedder = new LocalHashEmbedder();

  get embedderName(): string {
    return this.embedder.name;
  }

  async search(
    store: TemporalGraphStore,
    query: string,
    opts: V15HybridOptions = {},
  ): Promise<V15HybridResult> {
    void this.embedder;
    return hybridSearchV15(store, query, opts);
  }
}

// ---------------------------------------------------------------------------
// Poisoning defence — gate + quarantine (dung lai judge v14)
// ---------------------------------------------------------------------------

export interface V15GateVerdict {
  decision: 'accept' | 'quarantine' | 'reject';
  reason: string;
  risk: number;
}

/**
 * Gate mot ung vien v15 qua judge v14 (mau nghi ngo + mau thuan
 * fact tin cay cao + nguon khong tin cay). Dung lam gate cho
 * `consolidateTurnsV15`.
 */
export function gateExtractedV15(
  store: TemporalGraphStore,
  candidate: V15ExtractedFact,
  scope: MemoryScope,
): V15GateVerdict {
  const v14candidate: V14ExtractedFact = {
    subject: candidate.subject,
    predicate: candidate.predicate,
    objectText: candidate.objectText,
    confidence: candidate.confidence,
    effectiveConfidence: candidate.effectiveConfidence,
    sourceTrust: candidate.sourceTrust,
    sourceText: candidate.sourceText,
    pattern: candidate.pattern,
    origin: candidate.origin,
    intent: candidate.intent,
    ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
    ...(candidate.validUntil ? { validUntil: candidate.validUntil } : {}),
  };
  const verdict = judgeCandidateV14(store, v14candidate, scope);
  return {
    decision: verdict.decision,
    reason: verdict.reasons.join(' '),
    risk: verdict.risk,
  };
}

/** Gate dang `V15ConsolidationGate` — cam thang vao consolidate. */
export function v15JudgeGate(
  candidate: V15ExtractedFact,
  ctx: { store: TemporalGraphStore; scope: MemoryScope },
): { decision: 'accept' | 'quarantine' | 'reject'; reason: string } {
  const verdict = gateExtractedV15(ctx.store, candidate, ctx.scope);
  return { decision: verdict.decision, reason: verdict.reason };
}

/**
 * Dua mot ung vien v15 bi gate vao quarantine v14 (cho user duyet
 * tay). Tra id muc quarantine.
 */
export function quarantineExtractedV15(
  store: TemporalGraphStore,
  candidate: V15ExtractedFact,
  scope: MemoryScope,
  provenance: GraphFact['provenance'],
  reason: string,
): string {
  const v14candidate: V14ExtractedFact = {
    subject: candidate.subject,
    predicate: candidate.predicate,
    objectText: candidate.objectText,
    confidence: candidate.confidence,
    effectiveConfidence: candidate.effectiveConfidence,
    sourceTrust: candidate.sourceTrust,
    sourceText: candidate.sourceText,
    pattern: candidate.pattern,
    origin: candidate.origin,
    intent: candidate.intent,
    ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
    ...(candidate.validUntil ? { validUntil: candidate.validUntil } : {}),
  };
  const verdict = judgeCandidateV14(store, v14candidate, scope);
  const item = quarantineCandidateV14(store, {
    candidate: v14candidate,
    scope,
    provenance,
    verdict,
  });
  void reason;
  return item.id;
}
