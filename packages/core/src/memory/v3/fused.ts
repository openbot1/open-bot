/**
 * Fused retrieval cho memory v6 (v1.05, Đội T1).
 *
 * Ý tưởng học từ Mem0 v3 (fused retrieval: semantic + keyword +
 * entity, trọng số cấu hình được) — tự thiết kế lại hoàn toàn cho
 * open-bot, 100% local, không copy code/text/tài sản của bất kỳ repo
 * nào.
 *
 * BA NGUỒN ĐIỂM (hợp nhất bằng trung bình có trọng số, tổng = 1):
 *  1. Semantic: cosine embedding (Ollama, khi caller truyền embedder
 *     và embedder khả dụng). Khi không có embedding -> fallback
 *     TF-IDF local (xem `tfidf.ts`); breakdown ghi rõ nguồn đã dùng.
 *     Embedder lỗi -> fail-open về TF-IDF (trừ khi
 *     `skipSemanticOnError` = false thì throw).
 *  2. BM25: từ khoá cổ điển (k1 = 1.2, b = 0.75), chuẩn hoá về 0..1
 *     bằng cách chia cho điểm BM25 lớn nhất trong lần truy vấn.
 *  3. Entity match: tỉ lệ entity của bản ghi xuất hiện trong query
 *     (khớp chuỗi con sau khi chuẩn hoá) — entity là cầu nối khi
 *     query nhắc tên người/nơi/vật mà text không chứa đúng từ đó.
 *
 * ĐIỂM CUỐI = (wS*semantic + wB*bm25 + wE*entity) * scopeBoost * recencyDecay
 *  - scopeBoost: mức scope hẹp được boost (run 1.0 -> app 0.55).
 *  - recencyDecay: hàm mũ theo tuổi (xem `temporal.ts`).
 *  - Mỗi hit kèm `breakdown` đầy đủ để debug ("vì sao bản ghi này
 *    được chọn") và `temporal` (bucket + tuổi + decay).
 */

import type { Embedder } from '../embeddings';
import { cosineSimilarity } from '../embeddings';
import type {
  V6FusedHit,
  V6FusedOptions,
  V6FusedWeights,
  V6RecordKind,
  V6RecordView,
  V6ScopeLevel,
} from './types';
import { DEFAULT_V6_FUSED_WEIGHTS, DEFAULT_V6_RECENCY_HALF_LIFE_DAYS, normalizeV6Text } from './types';
import { classifyTemporal } from './temporal';
import { scopeLevelOf, scopeLevelWeight, scopeVisible } from './scopes';
import { TfIdfIndex, tokenizeV6 } from './tfidf';
import type { V6RecordStore } from './store';

/** Tham số BM25 cổ điển. */
export const V6_BM25_K1 = 1.2;
export const V6_BM25_B = 0.75;

/** Điểm tối đa của topK (mặc định 10, trần 50). */
export const V6_FUSED_DEFAULT_TOP_K = 10;
export const V6_FUSED_MAX_TOP_K = 50;

/** Chuẩn hoá trọng số fused về tổng = 1 (giữ tỉ lệ). */
export function normalizeFusedWeights(weights: Partial<V6FusedWeights>): V6FusedWeights {
  const merged: V6FusedWeights = { ...DEFAULT_V6_FUSED_WEIGHTS, ...weights };
  const total = merged.semantic + merged.bm25 + merged.entity;
  if (!(total > 0)) return { ...DEFAULT_V6_FUSED_WEIGHTS };
  return {
    semantic: merged.semantic / total,
    bm25: merged.bm25 / total,
    entity: merged.entity / total,
  };
}

/**
 * Index BM25 nhỏ, tự chứa, trên một corpus text.
 * Xây một lần cho mỗi lần truy vấn (corpus = bản ghi trong scope).
 */
export class V6Bm25Index {
  private readonly docs: string[][];
  private readonly docLengths: number[];
  private readonly avgLength: number;
  private readonly idf = new Map<string, number>();

  constructor(documents: string[]) {
    this.docs = documents.map((d) => tokenizeV6(d));
    this.docLengths = this.docs.map((tokens) => tokens.length);
    const totalLength = this.docLengths.reduce((sum, n) => sum + n, 0);
    this.avgLength = this.docs.length === 0 ? 0 : totalLength / this.docs.length;
    const docCount = this.docs.length;
    const df = new Map<string, number>();
    for (const tokens of this.docs) {
      for (const token of new Set(tokens)) {
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
    for (const [token, count] of df) {
      // IDF BM25 chuẩn (Robertson): ln(1 + (N - df + 0.5) / (df + 0.5)).
      this.idf.set(token, Math.log(1 + (docCount - count + 0.5) / (count + 0.5)));
    }
  }

  /** Số document trong corpus. */
  get size(): number {
    return this.docs.length;
  }

  /** Điểm BM25 thô của query với document thứ `docIndex` (>= 0). */
  score(query: string, docIndex: number): number {
    if (docIndex < 0 || docIndex >= this.docs.length) return 0;
    const queryTokens = tokenizeV6(query);
    if (queryTokens.length === 0 || this.avgLength === 0) return 0;
    const tokens = this.docs[docIndex];
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    const docLength = this.docLengths[docIndex];
    let total = 0;
    for (const token of new Set(queryTokens)) {
      const freq = tf.get(token);
      if (freq === undefined) continue;
      const idf = this.idf.get(token) ?? 0;
      const numerator = freq * (V6_BM25_K1 + 1);
      const denominator =
        freq + V6_BM25_K1 * (1 - V6_BM25_B + V6_BM25_B * (docLength / this.avgLength));
      total += idf * (numerator / denominator);
    }
    return total;
  }

  /** Điểm BM25 thô cho toàn bộ corpus (theo thứ tự document). */
  scoreAll(query: string): number[] {
    return this.docs.map((_, index) => this.score(query, index));
  }
}

/**
 * Điểm entity match 0..1: tỉ lệ entity của bản ghi xuất hiện trong
 * query (khớp chuỗi con sau chuẩn hoá, cả hai chiều: entity trong
 * query hoặc query-token nằm trong entity).
 */
export function entityMatchScore(query: string, entities: string[]): number {
  if (entities.length === 0) return 0;
  const normalizedQuery = normalizeV6Text(query);
  if (normalizedQuery === '') return 0;
  const queryTokens = new Set(tokenizeV6(query));
  let matched = 0;
  for (const rawEntity of entities) {
    const entity = normalizeV6Text(rawEntity);
    if (entity === '') continue;
    if (normalizedQuery.includes(entity)) {
      matched += 1;
      continue;
    }
    // Entity nhiều từ: khớp khi mọi token của entity có trong query.
    const entityTokens = tokenizeV6(entity);
    if (entityTokens.length > 0 && entityTokens.every((t) => queryTokens.has(t))) {
      matched += 1;
    }
  }
  return matched / entities.length;
}

/** Lỗi fused retrieval — mọi message đều tiếng Việt. */
export class V6FusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V6FusedError';
  }
}

function clampTopK(topK: number | undefined): number {
  if (topK === undefined || !Number.isFinite(topK)) return V6_FUSED_DEFAULT_TOP_K;
  return Math.min(V6_FUSED_MAX_TOP_K, Math.max(1, Math.floor(topK)));
}

/**
 * Fused retrieval trên kho v6.
 *
 *  - Chỉ xét bản ghi active (mặc định) mà scope truy vấn nhìn thấy.
 *  - Lọc theo `kinds` khi caller truyền.
 *  - Điểm semantic: embedding khi có embedder khả dụng, ngược lại
 *    TF-IDF. Embedding được tính theo batch khi embedder hỗ trợ
 *    `embedBatch`, nếu không thì từng bản ghi một (cache trong lần
 *    gọi này, không lưu vector ra đĩa).
 *  - Trả về tối đa `topK` hit, sắp theo điểm cuối giảm dần; hit có
 *    điểm cuối = 0 vẫn trả về khi không có hit nào khác? KHÔNG —
 *    hit điểm 0 bị loại (trừ khi corpus rỗng thì trả về []).
 */
export async function fusedRetrieve(
  store: V6RecordStore,
  query: string,
  opts: V6FusedOptions = {},
): Promise<V6FusedHit[]> {
  const trimmedQuery = query.trim();
  if (trimmedQuery === '') return [];
  const now = opts.now ?? new Date();
  const weights = normalizeFusedWeights(opts.weights ?? {});
  const topK = clampTopK(opts.topK);
  const halfLife = opts.recencyHalfLifeDays ?? DEFAULT_V6_RECENCY_HALF_LIFE_DAYS;
  const scopeQuery = opts.scope ?? {};
  const priority = opts.scopePriority;
  const activeOnly = opts.activeOnly ?? true;
  const kinds: V6RecordKind[] | undefined = opts.kinds;

  let candidates: V6RecordView[] = store.listAll().filter((r) => scopeVisible(r.scope, scopeQuery));
  if (activeOnly) candidates = candidates.filter((r) => r.status === 'active');
  if (kinds && kinds.length > 0) {
    const kindSet = new Set(kinds);
    candidates = candidates.filter((r) => kindSet.has(r.kind));
  }
  if (candidates.length === 0) return [];

  // --- Nguồn 1: semantic (embedding, fallback TF-IDF). ---
  let semanticScores: number[] = new Array(candidates.length).fill(0);
  let semanticSource: 'embedding' | 'tfidf' = 'tfidf';
  const embedder: Embedder | undefined = opts.embedder;
  if (embedder) {
    try {
      const available = (await embedder.isAvailable?.()) ?? true;
      if (available) {
        const texts = candidates.map((r) => `${r.text} ${r.entities.join(' ')} ${r.tags.join(' ')}`.trim());
        const queryEmbedding = await embedder.embed(trimmedQuery);
        let docEmbeddings: number[][];
        if (typeof embedder.embedBatch === 'function') {
          docEmbeddings = await embedder.embedBatch(texts);
        } else {
          docEmbeddings = [];
          for (const text of texts) docEmbeddings.push(await embedder.embed(text));
        }
        semanticScores = docEmbeddings.map((vec) => {
          const sim = cosineSimilarity(queryEmbedding, vec);
          return Number.isFinite(sim) ? Math.max(0, Math.min(1, sim)) : 0;
        });
        semanticSource = 'embedding';
      }
    } catch (err) {
      if (opts.skipSemanticOnError === false) {
        throw new V6FusedError(
          `Nguồn semantic lỗi và skipSemanticOnError=false: ${(err as Error).message}`,
        );
      }
      semanticScores = new Array(candidates.length).fill(0);
      semanticSource = 'tfidf';
    }
  }
  if (semanticSource === 'tfidf') {
    const tfidf = new TfIdfIndex(candidates.map((r) => `${r.text} ${r.entities.join(' ')} ${r.tags.join(' ')}`));
    semanticScores = tfidf.rank(trimmedQuery).reduce<number[]>((acc, { doc, score }) => {
      acc[doc] = Math.max(0, Math.min(1, score));
      return acc;
    }, new Array(candidates.length).fill(0));
  }

  // --- Nguồn 2: BM25 (chuẩn hoá theo max trong lần truy vấn). ---
  const bm25Index = new V6Bm25Index(
    candidates.map((r) => `${r.text} ${r.entities.join(' ')} ${r.tags.join(' ')}`),
  );
  const rawBm25 = bm25Index.scoreAll(trimmedQuery);
  const maxBm25 = rawBm25.reduce((max, s) => Math.max(max, s), 0);
  const bm25Scores = maxBm25 > 0 ? rawBm25.map((s) => s / maxBm25) : rawBm25.map(() => 0);

  // --- Nguồn 3: entity match + scope boost + recency decay. ---
  const hits: V6FusedHit[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const record = candidates[i] as V6RecordView;
    const level: V6ScopeLevel = scopeLevelOf(record.scope);
    const temporal = classifyTemporal(record, now, halfLife);
    const semantic = semanticScores[i] ?? 0;
    const bm25 = bm25Scores[i] ?? 0;
    const entity = entityMatchScore(trimmedQuery, record.entities);
    const scopeBoost = scopeLevelWeight(level, priority);
    const fused = weights.semantic * semantic + weights.bm25 * bm25 + weights.entity * entity;
    const final = fused * scopeBoost * temporal.recencyDecay;
    if (final <= 0) continue;
    hits.push({
      record,
      scopeLevel: level,
      temporal,
      breakdown: {
        semantic,
        semanticSource,
        bm25,
        entity,
        scopeBoost,
        recencyDecay: temporal.recencyDecay,
        final,
      },
    });
  }
  hits.sort((a, b) => b.breakdown.final - a.breakdown.final);
  return hits.slice(0, topK);
}

/**
 * Giải thích một hit bằng text (vd để log/debug hoặc trả cho agent):
 * "Hà Nội · scope run · tuần này · final 0.62 = (0.45*0.80 + 0.35*0.50
 * + 0.20*1.00) * boost 1.00 * decay 0.93 [embedding]".
 */
export function explainFusedHit(hit: V6FusedHit, weights: V6FusedWeights = DEFAULT_V6_FUSED_WEIGHTS): string {
  const b = hit.breakdown;
  const text = hit.record.text.length > 80 ? `${hit.record.text.slice(0, 80)}…` : hit.record.text;
  return (
    `${text} · scope ${hit.scopeLevel} · ${hit.temporal.bucket} · ` +
    `final ${b.final.toFixed(3)} = (${weights.semantic}*${b.semantic.toFixed(2)} + ` +
    `${weights.bm25}*${b.bm25.toFixed(2)} + ${weights.entity}*${b.entity.toFixed(2)}) * ` +
    `boost ${b.scopeBoost.toFixed(2)} * decay ${b.recencyDecay.toFixed(2)} [${b.semanticSource}]`
  );
}
