/**
 * Memory v17 — Retrieval fusion: semantic + keyword + entity + time-aware
 * (v1.36, Doi T1).
 *
 * Y tuong hoc tu mem0 v3: retrieval hop nhat semantic + BM25 keyword +
 * entity matching, ranking theo thoi gian. Tu thiet ke lai hoan toan cho
 * open-bot, chay 100% local, KHONG copy code/text/tai san cua bat ky
 * repo nao, KHONG goi model ngoai.
 *
 *  1. Semantic: embedding cuc bo xac dinh (hash token -> vector co dinh,
 *     khong can model). Cosine giua query va fact text. Cung 1 text luon
 *     cho cung 1 vector — ket qua lap lai duoc, test duoc.
 *  2. Keyword: BM25 co dien (tf, idf tren corpus fact trong scope,
 *     chuan hoa do dai) — bat duoc tu khoa hiem ma embedding bo qua.
 *  3. Entity: fact co entity khop voi entity trong query duoc cong
 *     diem; entity khop chinh xac > khop alias > khop chuoi con.
 *  4. Time-aware: recency decay (half-life) + bonus fact dang trong
 *     cua so valid time tai thoi diem truy van; fact het han bi tru
 *     diem (nhung van tra ve neu khop manh, de UI biet).
 *  5. Fusion: RRF (Reciprocal Rank Fusion) tren 4 bang xep hang +
 *     tong co trong so de giai thich; moi hit kem score breakdown.
 *  6. Scope: chi fuse tren fact active trong scope yeu cau.
 */

import {
  M17Error,
  M17Fact,
  M17FusionHit,
  M17FusionScore,
  M17Scope,
  clamp01M17,
  normalizeCompareTextM17,
  parseIsoM17,
  scopesEqualM17,
  validateScopeM17,
} from './types';

/** Loi retrieval fusion v17. */
export class M17FusionError extends M17Error {
  constructor(message: string) {
    super(message);
    this.name = 'M17FusionError';
  }
}

/** Trong so mac dinh cua 4 tin hieu (tong = 1). */
export const M17_DEFAULT_FUSION_WEIGHTS = {
  semantic: 0.4,
  keyword: 0.25,
  entity: 0.2,
  time: 0.15,
} as const;

/** Trong so fusion (tong khong nhat thiet = 1 — se chuan hoa). */
export interface M17FusionWeights {
  semantic: number;
  keyword: number;
  entity: number;
  time: number;
}

/** Hang so RRF. */
export const M17_RRF_K = 60;
/** Kich thuoc vector hash embedding. */
export const M17_EMBEDDING_DIM = 128;
/** Half-life recency mac dinh (ngay). */
export const M17_DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;
/** BM25 k1 / b. */
export const M17_BM25_K1 = 1.2;
export const M17_BM25_B = 0.75;

/** Tuy chon fusion search. */
export interface M17FusionSearchOptions {
  /** Trong so 4 tin hieu. */
  weights?: Partial<M17FusionWeights>;
  /** So ket qua toi da. */
  topK?: number;
  /** Thoi diem truy van (de tinh time score, mac dinh now). */
  atIso?: string;
  /** Half-life recency (ngay). */
  recencyHalfLifeDays?: number;
  /** Chi lay fact co tong diem >= nguong nay. */
  minTotalScore?: number;
  /** Entity trong query (ten da trich, de tinh entity score). */
  queryEntities?: string[];
  /** Loc theo edge (neu co). */
  edge?: string;
}

/** Ket qua fusion search. */
export interface M17FusionSearchResult {
  hits: M17FusionHit[];
  /** Tong fact active da xet trong scope. */
  considered: number;
  /** Query da chuan hoa (de debug). */
  normalizedQuery: string;
  /** Trong so da chuan hoa da dung. */
  weightsUsed: M17FusionWeights;
}

/** Tach text thanh token (chu thuong, bo dau, bo stopword ngan). */
export function fusionTokensM17(text: string): string[] {
  const normalized = normalizeCompareTextM17(text);
  if (!normalized) return [];
  return normalized.split(' ').filter((t) => t.length >= 2);
}

/** Stopword tieng Viet / Anh bo qua trong BM25 + embedding. */
const M17_STOPWORDS = new Set([
  'la', 'cua', 'va', 'thi', 'ma', 'o', 'tai', 'cho', 'voi', 've', 'den',
  'tu', 'co', 'khong', 'toi', 'to', 'minh', 'em', 'anh', 'chi', 'the',
  'a', 'an', 'is', 'are', 'was', 'were', 'am', 'be', 'been', 'have', 'has',
  'had', 'do', 'does', 'did', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'and', 'or', 'but', 'not', 'no', 'my', 'your', 'his', 'her', 'its', 'our',
  'their', 'this', 'that', 'these', 'those', 'it', 'he', 'she', 'we', 'you',
  'i',
]);

/** Token co nghia (bo stopword). */
export function meaningfulTokensM17(text: string): string[] {
  return fusionTokensM17(text).filter((t) => !M17_STOPWORDS.has(t));
}

/** Hash FNV-1a 32-bit (xac dinh, nhanh). */
export function fnv1aHashM17(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Embedding cuc bo xac dinh: moi token dong gop vao 2 vi tri hash
 * (hash + hash dao), vector chuan hoa L2. Khong can model, ket qua lap
 * lai duoc 100%.
 */
export function hashEmbeddingM17(text: string, dim: number = M17_EMBEDDING_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = meaningfulTokensM17(text);
  if (tokens.length === 0) return vec;
  for (const token of tokens) {
    const h1 = fnv1aHashM17(token) % dim;
    const h2 = fnv1aHashM17(`rev:${token}`) % dim;
    vec[h1] += 1;
    vec[h2] += 0.5;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** Cosine giua 2 vector (da chuan hoa thi bang dot product). */
export function cosineSimilarityM17(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return clamp01M17(dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

/** Text dai dien cua fact de embedding / BM25. */
export function factIndexTextM17(fact: M17Fact): string {
  return `${fact.subject} ${fact.edge} ${fact.object}`;
}

/** Tinh document frequency cho BM25 tren corpus. */
export function docFrequenciesM17(facts: M17Fact[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const fact of facts) {
    const unique = new Set(meaningfulTokensM17(factIndexTextM17(fact)));
    for (const token of unique) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return df;
}

/** Diem BM25 cua 1 fact voi query (chuan hoa ve 0..1 bang tanh). */
export function bm25ScoreM17(
  queryTokens: string[],
  factTokens: string[],
  df: Map<string, number>,
  corpusSize: number,
  avgDocLen: number,
): number {
  if (queryTokens.length === 0 || factTokens.length === 0 || corpusSize === 0) return 0;
  const tf = new Map<string, number>();
  for (const token of factTokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const docLen = factTokens.length;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const freq = tf.get(token) ?? 0;
    if (freq === 0) continue;
    const docFreq = df.get(token) ?? 0;
    const idf = Math.log(1 + (corpusSize - docFreq + 0.5) / (docFreq + 0.5));
    const denom = freq + M17_BM25_K1 * (1 - M17_BM25_B + M17_BM25_B * (docLen / Math.max(1, avgDocLen)));
    score += idf * ((freq * (M17_BM25_K1 + 1)) / denom);
  }
  // Chuan hoa: tanh dua diem BM25 (0..~10) ve (0..1).
  return Math.tanh(score / 3);
}

/** Diem entity: query co nhac toi entity cua fact khong. */
export function entityScoreM17(
  fact: M17Fact,
  queryEntities: string[],
  queryText: string,
): { score: number; matched: string[] } {
  if (queryEntities.length === 0 && !queryText.trim()) return { score: 0, matched: [] };
  const matched: string[] = [];
  const objectCompare = normalizeCompareTextM17(fact.object);
  const subjectCompare = normalizeCompareTextM17(fact.subject);
  const queryCompare = normalizeCompareTextM17(queryText);
  let score = 0;
  for (const entityName of queryEntities) {
    const compare = normalizeCompareTextM17(entityName);
    if (!compare) continue;
    if (compare === objectCompare || compare === subjectCompare) {
      score = Math.max(score, 1);
      matched.push(entityName);
    } else if (objectCompare.includes(compare) || subjectCompare.includes(compare)) {
      score = Math.max(score, 0.7);
      matched.push(entityName);
    }
  }
  // Khong co entity trich san: dung substring cua object trong query.
  if (matched.length === 0 && objectCompare.length >= 3 && queryCompare.includes(objectCompare)) {
    score = Math.max(score, 0.8);
    matched.push(fact.object);
  }
  return { score, matched };
}

/** Diem time-aware: recency decay + bonus trong cua so valid time. */
export function timeScoreM17(
  fact: M17Fact,
  atIso: string,
  recencyHalfLifeDays: number,
): number {
  const at = parseIsoM17(atIso)?.getTime() ?? Date.now();
  const learned = parseIsoM17(fact.learnedAt)?.getTime() ?? at;
  const ageDays = Math.max(0, (at - learned) / 86400000);
  const halfLife = Math.max(1, recencyHalfLifeDays);
  const recency = Math.pow(0.5, ageDays / halfLife);
  // Bonus/penalty theo valid time tai thoi diem truy van.
  let validity = 0.5;
  const fromMs = parseIsoM17(fact.validFrom)?.getTime();
  const toMs = parseIsoM17(fact.validTo)?.getTime();
  if (fromMs !== undefined && fromMs !== null && fromMs > at) {
    validity = 0.1; // Chua dung tai T.
  } else if (toMs !== undefined && toMs !== null && toMs <= at) {
    validity = 0.2; // Da het dung tai T.
  } else {
    validity = 1; // Dung tai T.
  }
  return clamp01M17(0.6 * recency + 0.4 * validity);
}

/** Chuan hoa trong so ve tong = 1. */
export function normalizeFusionWeightsM17(
  weights: Partial<M17FusionWeights>,
): M17FusionWeights {
  const merged: M17FusionWeights = {
    semantic: weights.semantic ?? M17_DEFAULT_FUSION_WEIGHTS.semantic,
    keyword: weights.keyword ?? M17_DEFAULT_FUSION_WEIGHTS.keyword,
    entity: weights.entity ?? M17_DEFAULT_FUSION_WEIGHTS.entity,
    time: weights.time ?? M17_DEFAULT_FUSION_WEIGHTS.time,
  };
  const total = merged.semantic + merged.keyword + merged.entity + merged.time;
  if (total <= 0) return { ...M17_DEFAULT_FUSION_WEIGHTS };
  return {
    semantic: merged.semantic / total,
    keyword: merged.keyword / total,
    entity: merged.entity / total,
    time: merged.time / total,
  };
}

/** RRF score tu thu hang (1-based) tren 1 bang xep hang. */
export function rrfScoreM17(rank: number, k: number = M17_RRF_K): number {
  return 1 / (k + rank);
}

/**
 * Fusion search tren fact active trong scope.
 * Tra hit co score breakdown giai thich duoc + xep hang RRF.
 */
export function fusionSearchM17(
  query: string,
  facts: M17Fact[],
  scope: M17Scope,
  options: M17FusionSearchOptions = {},
): M17FusionSearchResult {
  const scopeError = validateScopeM17(scope);
  if (scopeError) throw new M17FusionError(scopeError);
  if (!query || !query.trim()) throw new M17FusionError('Query rong.');
  const weights = normalizeFusionWeightsM17(options.weights ?? {});
  const topK = Math.max(1, Math.min(100, options.topK ?? 10));
  const atIso = options.atIso ?? new Date().toISOString();
  const halfLife = options.recencyHalfLifeDays ?? M17_DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const minTotal = options.minTotalScore ?? 0;
  const queryEntities = options.queryEntities ?? [];
  const normalizedQuery = normalizeCompareTextM17(query);
  const inScope = facts.filter(
    (f) =>
      f.status === 'active' &&
      scopesEqualM17(f.scope, scope) &&
      (!options.edge || f.edge === options.edge),
  );
  const queryTokens = meaningfulTokensM17(query);
  const queryVec = hashEmbeddingM17(query);
  const df = docFrequenciesM17(inScope);
  const avgDocLen =
    inScope.length === 0
      ? 1
      : inScope.reduce((sum, f) => sum + meaningfulTokensM17(factIndexTextM17(f)).length, 0) /
        inScope.length;
  // Tinh 4 tin hieu cho moi fact.
  const scored: { fact: M17Fact; score: M17FusionScore; matched: string[] }[] = [];
  for (const fact of inScope) {
    const factText = factIndexTextM17(fact);
    const semantic = cosineSimilarityM17(queryVec, hashEmbeddingM17(factText));
    const keyword = bm25ScoreM17(
      queryTokens,
      meaningfulTokensM17(factText),
      df,
      inScope.length,
      avgDocLen,
    );
    const entity = entityScoreM17(fact, queryEntities, query);
    const time = timeScoreM17(fact, atIso, halfLife);
    const total = clamp01M17(
      weights.semantic * semantic +
        weights.keyword * keyword +
        weights.entity * entity.score +
        weights.time * time,
    );
    scored.push({
      fact,
      score: { semantic, keyword, entity: entity.score, time, total },
      matched: entity.matched,
    });
  }
  // RRF: xep hang rieng theo tung tin hieu, cong diem RRF co trong so.
  const rankBy = (key: (s: (typeof scored)[number]) => number): Map<string, number> => {
    const sorted = [...scored].sort((a, b) => key(b) - key(a));
    const ranks = new Map<string, number>();
    sorted.forEach((s, i) => ranks.set(s.fact.id, i + 1));
    return ranks;
  };
  const rankSemantic = rankBy((s) => s.score.semantic);
  const rankKeyword = rankBy((s) => s.score.keyword);
  const rankEntity = rankBy((s) => s.score.entity);
  const rankTime = rankBy((s) => s.score.time);
  const fused = scored
    .map((s) => {
      const rrf =
        weights.semantic * rrfScoreM17(rankSemantic.get(s.fact.id) ?? 999) +
        weights.keyword * rrfScoreM17(rankKeyword.get(s.fact.id) ?? 999) +
        weights.entity * rrfScoreM17(rankEntity.get(s.fact.id) ?? 999) +
        weights.time * rrfScoreM17(rankTime.get(s.fact.id) ?? 999);
      return { ...s, rrf };
    })
    .filter((s) => s.score.total >= minTotal)
    .sort((a, b) => b.rrf - a.rrf || b.score.total - a.score.total)
    .slice(0, topK);
  return {
    hits: fused.map((s) => ({ fact: s.fact, score: s.score, matchedEntities: s.matched })),
    considered: inScope.length,
    normalizedQuery,
    weightsUsed: weights,
  };
}

/** Format 1 hit thanh text doc duoc (UI / log). */
export function formatFusionHitM17(hit: M17FusionHit, rank: number): string {
  const s = hit.score;
  const entityPart =
    hit.matchedEntities.length > 0 ? ` | entity: ${hit.matchedEntities.join(', ')}` : '';
  return (
    `#${rank} ${hit.fact.subject} —${hit.fact.edge}→ ${hit.fact.object} ` +
    `(total=${s.total.toFixed(3)}: sem=${s.semantic.toFixed(2)} kw=${s.keyword.toFixed(2)} ` +
    `ent=${s.entity.toFixed(2)} time=${s.time.toFixed(2)}${entityPart})`
  );
}
