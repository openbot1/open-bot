/**
 * TF-IDF local cho memory v6 (v1.05, Đội T1).
 *
 * Fallback ngữ nghĩa khi không có embedding thật (Ollama chưa chạy /
 * chưa pull model): retrieval vẫn có nguồn semantic, nhưng điểm số
 * đến từ TF-IDF thay vì vector. Thuật toán tự viết, chạy 100% local,
 * không copy code/text/tài sản của bất kỳ repo nào.
 *
 *  - Tokenize: tách theo chữ/số Unicode, lowercase, bỏ token 1 ký tự,
 *    bỏ stopword tiếng Việt + tiếng Anh thường gặp.
 *  - IDF: ln((N + 1) / (df + 1)) + 1 (làm mượt, tránh chia 0).
 *  - Vector TF-IDF chuẩn hoá L2; cosine = tích vô hướng.
 *  - Index xây theo corpus lúc truy vấn (corpus = bản ghi active
 *    trong scope); corpus rỗng -> mọi điểm = 0.
 *
 * Không dùng cho corpus lớn: O(corpus) mỗi lần truy vấn, phù hợp
 * memory local vài nghìn bản ghi. Khi có Ollama, fused retrieval
 * dùng embedding thật và bỏ qua module này.
 */

import { normalizeV6Token } from './types';

/** Stopword tiếng Việt + tiếng Anh (bỏ khỏi TF-IDF để giảm nhiễu). */
export const V6_STOPWORDS: ReadonlySet<string> = new Set([
  // Tiếng Việt.
  'là', 'của', 'và', 'các', 'cái', 'cho', 'với', 'trong', 'đã', 'sẽ',
  'đang', 'có', 'không', 'một', 'này', 'đó', 'kia', 'thì', 'mà', 'để',
  'tôi', 'bạn', 'anh', 'chị', 'em', 'nó', 'họ', 'mình', 'ta', 'vậy',
  'như', 'khi', 'nếu', 'rằng', 'là', 'được', 'bị', 'vì', 'nên', 'từ',
  'đến', 'ở', 'ra', 'vào', 'lên', 'xuống', 'qua', 'theo', 'cùng', 'rất',
  'quá', 'lắm', 'thôi', 'nhé', 'ạ', 'ơi', 'nào', 'gì', 'sao', 'đâu',
  // Tiếng Anh.
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'i', 'you', 'he', 'she',
  'it', 'we', 'they', 'this', 'that', 'these', 'those', 'my', 'your',
  'his', 'her', 'its', 'our', 'their', 'not', 'no', 'yes', 'do', 'does',
  'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
  'at', 'by', 'from', 'as', 'but', 'so', 'if', 'then', 'than', 'too',
]);

/** Tách text thành token đã chuẩn hoá (bỏ stopword, bỏ token < 2 ký tự). */
export function tokenizeV6(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!matches) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const token = normalizeV6Token(raw);
    if (token.length < 2 || V6_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** Cosine similarity giữa hai vector thưa (Map token -> trọng số). */
export function sparseCosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of a.values()) normA += v * v;
  for (const v of b.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [token, weight] of small) {
    const other = big.get(token);
    if (other !== undefined) dot += weight * other;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Độ tương đồng Jaccard giữa hai tập token (dùng cho near-dup ở sleep). */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (big.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Index TF-IDF trên một corpus text.
 *
 * Cách dùng:
 *   const index = new TfIdfIndex(corpus);       // corpus: string[]
 *   index.similarity(query, docIndex);           // cosine 0..1
 *   index.rank(query);                           // [{doc, score}] giảm dần
 */
export class TfIdfIndex {
  private readonly docs: string[][];
  private readonly idf = new Map<string, number>();
  private readonly vectors: Map<string, number>[];

  constructor(documents: string[]) {
    this.docs = documents.map((d) => tokenizeV6(d));
    const docCount = this.docs.length;
    const df = new Map<string, number>();
    for (const tokens of this.docs) {
      for (const token of new Set(tokens)) {
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
    for (const [token, count] of df) {
      this.idf.set(token, Math.log((docCount + 1) / (count + 1)) + 1);
    }
    this.vectors = this.docs.map((tokens) => this.vectorize(tokens));
  }

  /** Số document trong corpus. */
  get size(): number {
    return this.docs.length;
  }

  private vectorize(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    const vector = new Map<string, number>();
    let norm = 0;
    for (const [token, count] of tf) {
      const weight = count * (this.idf.get(token) ?? 1);
      vector.set(token, weight);
      norm += weight * weight;
    }
    if (norm === 0) return vector;
    const length = Math.sqrt(norm);
    for (const [token, weight] of vector) vector.set(token, weight / length);
    return vector;
  }

  /** Vector TF-IDF của một text bất kỳ (kể cả ngoài corpus). */
  queryVector(text: string): Map<string, number> {
    return this.vectorize(tokenizeV6(text));
  }

  /** Cosine giữa query và document thứ `docIndex` (0..1). */
  similarity(query: string, docIndex: number): number {
    if (docIndex < 0 || docIndex >= this.vectors.length) return 0;
    return sparseCosine(this.queryVector(query), this.vectors[docIndex]);
  }

  /** Xếp hạng toàn bộ corpus theo query (giảm dần, kèm index gốc). */
  rank(query: string): { doc: number; score: number }[] {
    const queryVector = this.queryVector(query);
    return this.vectors
      .map((vector, doc) => ({ doc, score: sparseCosine(queryVector, vector) }))
      .sort((a, b) => b.score - a.score);
  }
}
