/**
 * Memory v24 — fused retrieval (v1.39, Doi T1).
 *
 * Y tuong Mem0 fusion (chi y tuong): semantic + BM25 + entity
 * match hop nhat roi rank. Y tuong Graphiti (chi y tuong):
 * time-aware ranking — fact dung *khi nao* quan trong khong
 * kem fact noi gi.
 *
 * Tu thiet ke lai hoan toan cho open-bot, chay local:
 *  - Semantic: hash-embedding xac dinh (FNV-1a tren token ->
 *    vector 64 chieu, cosine) — ghi ro provenance `hash`,
 *    khong bao gio gia vo la embedding that.
 *  - BM25: tf-idf chuan (k1=1.2, b=0.75), tinh tren corpus
 *    truyen vao (khong giu state toan cuc).
 *  - Entity: ti le entity cua query xuat hien trong text.
 *  - Time-aware: valid-time chua now? (trong khoang = 1,
 *    het han = 0.1, tuong lai = 0.3) * recency decay theo
 *    tuoi (half-life 180 ngay) * confidence hien tai.
 *  - Tong co trong so, chuan hoa ve [0, 1]; moi hit kem
 *    explanation giai thich vi sao duoc chon.
 *  - searchFacts / searchLessons / searchMemfs / searchAll:
 *    1 ham duy nhat cho moi loai nguon, gop roi rank chung.
 */
import {
  clamp01V24,
  fnv1aV24,
  parseIsoV24,
  tokenizeV24,
  type V24Fact,
  type V24FusionHit,
  type V24FusionScore,
  type V24FusionWeights,
  type V24Lesson,
  type V24MemNode,
  V24_DEFAULT_FUSION_WEIGHTS,
} from './types';

/** Kich thuoc vector hash-embedding. */
export const V24_EMBED_DIM = 64;

/** Hash-embedding xac dinh cua 1 text: FNV-1a tren token -> 64 chieu. */
export function hashEmbedV24(text: string, dim: number = V24_EMBED_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenizeV24(text);
  if (tokens.length === 0) return vec;
  for (const token of tokens) {
    const h = fnv1aV24(token);
    const idx = h % dim;
    const sign = (h >> 7) % 2 === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  // Chuan hoa L2.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** Cosine similarity giua 2 vector (da chuan hoa hoac chua). */
export function cosineV24(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return clamp01V24((dot / (Math.sqrt(na) * Math.sqrt(nb)) + 1) / 2);
}

/** IDF cua 1 term trong corpus (so doc chua term). */
export function idfV24(docFreq: number, totalDocs: number): number {
  return Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
}

/** Diem BM25 cua 1 doc doi voi query (k1=1.2, b=0.75). */
export function bm25ScoreV24(
  queryTokens: string[],
  docTokens: string[],
  docFreq: Map<string, number>,
  totalDocs: number,
  avgDocLen: number,
): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const docLen = docTokens.length;
  let score = 0;
  const seen = new Set<string>();
  for (const q of queryTokens) {
    if (seen.has(q)) continue;
    seen.add(q);
    const f = tf.get(q) ?? 0;
    if (f === 0) continue;
    const idf = idfV24(docFreq.get(q) ?? 0, totalDocs);
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docLen) / Math.max(1, avgDocLen))));
  }
  return score;
}

/** Chuan hoa BM25 ve [0, 1] theo max trong batch (max <= 0 -> 0). */
export function normalizeBm25V24(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  return clamp01V24(score / maxScore);
}

/** Diem entity: ti le entity cua query xuat hien trong text. */
export function entityScoreV24(queryEntities: string[], text: string): number {
  if (queryEntities.length === 0) return 0;
  const lower = text.toLowerCase();
  let matched = 0;
  for (const e of queryEntities) {
    if (e && lower.includes(e.toLowerCase())) matched++;
  }
  return matched / queryEntities.length;
}

/** Trich entity don gian tu query: tu viet hoa + cum tu sau gioi tu. */
export function extractQueryEntitiesV24(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s(])([A-ZÀ-Ỹ][a-zà-ỹ]+(?:\s+[A-ZÀ-Ỹ][a-zà-ỹ]+){0,2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    if (m.index === 0) continue; // bo tu dau cau (viet hoa do dau cau).
    const name = m[1].trim();
    const key = name.toLowerCase();
    if (!seen.has(key) && name.length >= 2) {
      seen.add(key);
      out.push(name);
    }
  }
  const prepRe = /(?:ở|tại|o|in|at)\s+([A-ZÀ-Ỹ][\wà-ỹÀ-Ỹ]+(?:\s+[A-ZÀ-Ỹ][\wà-ỹÀ-Ỹ]+){0,2})/g;
  while ((m = prepRe.exec(query)) !== null) {
    const name = m[1].trim();
    const key = name.toLowerCase();
    if (!seen.has(key) && name.length >= 2) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/** Diem time-aware: valid-time + recency + confidence hien tai. */
export function timeScoreV24(
  validFrom: string | null,
  validTo: string | null,
  learnedAt: string,
  confidence: number,
  nowMs: number,
): number {
  let validity = 1;
  const from = parseIsoV24(validFrom)?.getTime();
  const to = parseIsoV24(validTo)?.getTime();
  if (from !== undefined && from !== null && nowMs < from) validity = 0.3; // chua toi luc hieu luc.
  if (to !== undefined && to !== null && nowMs > to) validity = 0.1; // het hieu luc.
  const learned = parseIsoV24(learnedAt)?.getTime() ?? nowMs;
  const ageDays = Math.max(0, (nowMs - learned) / (24 * 3600 * 1000));
  const recency = Math.pow(0.5, ageDays / 180);
  return clamp01V24(validity * (0.5 + 0.5 * recency) * (0.5 + 0.5 * clamp01V24(confidence)));
}

/** Hop nhat 4 tin hieu thanh tong co trong so (chuan hoa). */
export function fuseScoresV24(
  partial: { semantic: number; keyword: number; entity: number; time: number },
  weights: V24FusionWeights = V24_DEFAULT_FUSION_WEIGHTS,
): V24FusionScore {
  const totalWeight = weights.semantic + weights.keyword + weights.entity + weights.time || 1;
  const total = clamp01V24(
    (partial.semantic * weights.semantic +
      partial.keyword * weights.keyword +
      partial.entity * weights.entity +
      partial.time * weights.time) / totalWeight,
  );
  return {
    semantic: clamp01V24(partial.semantic),
    keyword: clamp01V24(partial.keyword),
    entity: clamp01V24(partial.entity),
    time: clamp01V24(partial.time),
    total,
  };
}

/** Giai thich ngan 1 hit (tin hieu nao manh nhat). */
export function explainHitV24(score: V24FusionScore, matchedEntities: string[]): string {
  const parts: string[] = [];
  if (score.semantic >= 0.6) parts.push(`ngu nghia ${score.semantic.toFixed(2)}`);
  if (score.keyword >= 0.6) parts.push(`tu khoa ${score.keyword.toFixed(2)}`);
  if (score.entity > 0) parts.push(`entity ${matchedEntities.join(', ')}`);
  if (score.time >= 0.8) parts.push('con hieu luc');
  else if (score.time <= 0.2) parts.push('het hieu luc / cu');
  return parts.length > 0 ? parts.join(' + ') : `tong ${score.total.toFixed(2)}`;
}

/** Input chung cho fused search: danh sach ung vien dang text. */
export interface V24SearchCandidate {
  sourceKind: 'fact' | 'lesson' | 'memfs';
  id: string;
  text: string;
  validFrom: string | null;
  validTo: string | null;
  learnedAt: string;
  confidence: number;
}

/** Fused search tren danh sach ung vien bat ky (fact/lesson/memfs). */
export function fusedSearchV24(
  query: string,
  candidates: V24SearchCandidate[],
  opts: {
    topK?: number;
    weights?: V24FusionWeights;
    minTotal?: number;
    nowMs?: number;
  } = {},
): V24FusionHit[] {
  const nowMs = opts.nowMs ?? Date.now();
  const topK = opts.topK ?? 10;
  const minTotal = opts.minTotal ?? 0;
  const queryTokens = tokenizeV24(query);
  const queryEntities = extractQueryEntitiesV24(query);
  const queryVec = hashEmbedV24(query);
  // BM25: thong ke corpus.
  const docTokensList = candidates.map((c) => tokenizeV24(c.text));
  const docFreq = new Map<string, number>();
  let totalLen = 0;
  for (const tokens of docTokensList) {
    totalLen += tokens.length;
    for (const t of new Set(tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const avgDocLen = candidates.length === 0 ? 1 : totalLen / candidates.length;
  const rawBm25 = candidates.map((c, i) =>
    bm25ScoreV24(queryTokens, docTokensList[i], docFreq, candidates.length, avgDocLen),
  );
  const maxBm25 = Math.max(0, ...rawBm25);
  const hits: V24FusionHit[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const semantic = cosineV24(queryVec, hashEmbedV24(c.text));
    const keyword = normalizeBm25V24(rawBm25[i], maxBm25);
    const matchedEntities = queryEntities.filter((e) => c.text.toLowerCase().includes(e.toLowerCase()));
    const entity = queryEntities.length === 0 ? 0 : matchedEntities.length / queryEntities.length;
    const time = timeScoreV24(c.validFrom, c.validTo, c.learnedAt, c.confidence, nowMs);
    const score = fuseScoresV24({ semantic, keyword, entity, time }, opts.weights);
    if (score.total < minTotal) continue;
    hits.push({
      sourceKind: c.sourceKind,
      id: c.id,
      text: c.text,
      score,
      matchedEntities,
      explanation: explainHitV24(score, matchedEntities),
    });
  }
  hits.sort((a, b) => b.score.total - a.score.total);
  return hits.slice(0, Math.max(0, topK));
}

/** Chuyen fact thanh candidate cho fused search. */
export function factToCandidateV24(fact: V24Fact): V24SearchCandidate {
  return {
    sourceKind: 'fact',
    id: fact.id,
    text: `${fact.subject} ${fact.edge} ${fact.object}`,
    validFrom: fact.validFrom,
    validTo: fact.validTo,
    learnedAt: fact.learnedAt,
    confidence: fact.confidence,
  };
}

/** Chuyen lesson thanh candidate cho fused search. */
export function lessonToCandidateV24(lesson: V24Lesson): V24SearchCandidate {
  return {
    sourceKind: 'lesson',
    id: lesson.id,
    text: `${lesson.title}. ${lesson.body}`,
    validFrom: lesson.validFrom,
    validTo: lesson.validTo,
    learnedAt: lesson.createdAt,
    confidence: lesson.confidence,
  };
}

/** Chuyen MemFS node thanh candidate cho fused search. */
export function memNodeToCandidateV24(node: V24MemNode): V24SearchCandidate {
  return {
    sourceKind: 'memfs',
    id: node.path,
    text: `${node.title}. ${node.body}`,
    validFrom: null,
    validTo: null,
    learnedAt: node.updatedAt,
    confidence: 0.7,
  };
}
