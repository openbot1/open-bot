/**
 * Memory eval scoring (v1.05, Team T6) — đo chất lượng memory
 * retrieval offline, kiểu LoCoMo/LongMemEval về HÌNH THỨC (metric
 * recall/precision/F1 + temporal accuracy + multi-hop) nhưng toàn bộ
 * code và fixture đều tự viết, không copy từ repo nào.
 *
 * Cách chạy, hoàn toàn local, không gọi API ngoài, không dùng key:
 * - `MemoryRetriever`: interface mà bất kỳ retriever nào cũng có thể
 *   implement — `retrieve(query, topK)` trả về các hit `{ factId,
 *   text, score }`. Production retriever (hybrid search thật) có thể
 *   gắn vào đây sau; eval mặc định dùng `InMemoryMockRetriever`.
 * - `InMemoryMockRetriever`: mock embedding xác định (deterministic):
 *   mỗi token được hash FNV-1a vào một chiều của vector 64 chiều,
 *   cosine similarity giữa query và fact. Không có yếu tố ngẫu nhiên:
 *   cùng dataset + cùng topK cho cùng một kết quả, lần nào cũng vậy.
 * - `mockJudgeAnswer`: "mock LLM judge" — KHÔNG gọi model thật; nó
 *   chỉ đếm tỉ lệ từ khóa đáp án xuất hiện trong các fact lấy được
 *   (đo xem retrieval có mang đủ nguyên liệu để trả lời hay không).
 *   Tên gọi "judge" để rõ đây là proxy rẻ, không phải chấm điểm bằng
 *   LLM thật — báo cáo ghi rõ `judge: 'mock-keyword'`.
 * - `runMemoryEval`: chạy toàn bộ dataset, chấm từng câu rồi gom theo
 *   loại câu hỏi (recall / temporal / multi-hop) + tổng hợp.
 */

import type {
  MemoryEvalDataset,
  MemoryEvalQuestion,
  MemoryEvalQuestionCategory,
  MemoryFact,
} from './memoryDataset';
import { indexFactsById } from './memoryDataset';

/** Số chiều của mock embedding (đủ lớn để ít va chạm, đủ nhỏ để nhanh). */
export const MOCK_EMBEDDING_DIM = 64;

/** Một hit retrieval: fact nào, nội dung, điểm tương đồng 0..1. */
export interface MemoryRetrievalHit {
  factId: string;
  text: string;
  score: number;
}

/**
 * Interface retriever cho eval. Bất kỳ retriever thật nào (hybrid
 * search, graph, scoped retrieval) cũng có thể implement interface
 * này để được đo bằng cùng một bộ metric.
 */
export interface MemoryRetriever {
  /** Tên hiển thị của retriever (vd 'mock-embedding-v1', 'hybrid-v2'). */
  readonly name: string;
  retrieve(query: string, topK: number): Promise<MemoryRetrievalHit[]> | MemoryRetrievalHit[];
}

/** Tách từ: lowercase, chỉ giữ chữ/số (cả tiếng Việt có dấu). */
export function tokenizeEvalText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((t) => t.length > 0);
}

/** FNV-1a 32-bit — hash xác định, không seed ngẫu nhiên. */
export function fnv1aHash32(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Mock embedding: vector thưa (bag-of-words băm vào 64 chiều), chuẩn
 * hóa về độ dài 1. Hai văn bản càng chung nhiều token thì cosine càng
 * cao. Xác định hoàn toàn — không random, không mạng, không model.
 */
export function mockEmbed(text: string, dim: number = MOCK_EMBEDDING_DIM): number[] {
  if (!Number.isInteger(dim) || dim <= 0) throw new Error('mockEmbed needs dim as an integer > 0.');
  const vec = new Array<number>(dim).fill(0);
  for (const token of tokenizeEvalText(text)) {
    vec[fnv1aHash32(token) % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** Cosine similarity giữa hai vector cùng chiều (đã chuẩn hóa hoặc chưa). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error('cosineSimilarity needs equal-length vectors.');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Retriever mock trên bộ fact cho trước: embed trước toàn bộ fact
 * một lần (constructor), mỗi query embed rồi xếp hạng cosine, trả topK.
 * Ổn định: cùng query + cùng topK luôn trả cùng thứ tự.
 *
 * Token được cân bằng IDF (tần suất nghịch trong corpus): token
 * hiếm (vd 'peanuts', 'PostGIS') nặng hơn token chung (vd 'Minh',
 * 'project') — cùng ý tưởng TF-IDF cổ điển, tính hoàn toàn local
 * từ chính bộ fact, không có gì từ ngoài.
 */
export class InMemoryMockRetriever implements MemoryRetriever {
  readonly name = 'mock-embedding-v1';
  private readonly embedded: Array<{ fact: MemoryFact; vec: number[] }>;
  private readonly idf: Map<string, number>;

  constructor(facts: readonly MemoryFact[], dim: number = MOCK_EMBEDDING_DIM) {
    if (!Array.isArray(facts) || facts.length === 0) {
      throw new Error('InMemoryMockRetriever needs at least one fact.');
    }
    const df = new Map<string, number>();
    for (const fact of facts) {
      for (const token of new Set(tokenizeEvalText(fact.text))) {
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
    const n = facts.length;
    this.idf = new Map([...df.entries()].map(([token, count]) => [token, Math.log((n + 1) / (count + 1)) + 1]));
    this.embedded = facts.map((fact) => ({ fact, vec: this.embedWeighted(fact.text, dim) }));
  }

  /** Embed có cân IDF (token lạ trong corpus được nhân hệ số lớn hơn). */
  private embedWeighted(text: string, dim: number): number[] {
    const vec = new Array<number>(dim).fill(0);
    for (const token of tokenizeEvalText(text)) {
      vec[fnv1aHash32(token) % dim] += this.idf.get(token) ?? 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }

  retrieve(query: string, topK: number): MemoryRetrievalHit[] {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new Error('retrieve needs a non-empty query.');
    }
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new Error('retrieve needs topK as an integer > 0.');
    }
    const queryVec = this.embedWeighted(query, MOCK_EMBEDDING_DIM);
    const scored = this.embedded
      .map(({ fact, vec }) => ({
        factId: fact.id,
        text: fact.text,
        score: cosineSimilarity(queryVec, vec),
      }))
      .sort((a, b) => b.score - a.score || a.factId.localeCompare(b.factId));
    return scored.slice(0, topK);
  }
}

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

/** Kết quả chấm một câu hỏi. */
export interface MemoryQuestionScore {
  questionId: string;
  category: MemoryEvalQuestionCategory;
  /** Số fact kỳ vọng lấy được / tổng số fact kỳ vọng. */
  recall: number;
  /** Số fact kỳ vọng lấy được / tổng số fact lấy được. */
  precision: number;
  f1: number;
  /** Chỉ có ý nghĩa với câu temporal: 1 khi có fact đúng ngày được lấy, 0 khi không. */
  temporalAccuracy: number | null;
  /** Chỉ có ý nghĩa với câu multi-hop: số hop được phủ / tổng số hop. */
  multiHopScore: number | null;
  /**
   * Mock judge (keyword proxy): tỉ lệ từ khóa đáp án xuất hiện trong
   * các fact lấy được. 1 = đủ nguyên liệu để trả lời.
   */
  judgeScore: number;
  /** Id các fact kỳ vọng đã lấy được. */
  retrievedExpectedIds: string[];
  /** Id các fact đã lấy (theo thứ tự retriever trả). */
  retrievedIds: string[];
}

/** Điểm gom theo một loại câu hỏi. */
export interface MemoryCategoryScore {
  category: MemoryEvalQuestionCategory | 'overall';
  count: number;
  recall: number;
  precision: number;
  f1: number;
  /** Trung bình temporalAccuracy của các câu temporal (null khi không có câu nào). */
  temporalAccuracy: number | null;
  /** Trung bình multiHopScore của các câu multi-hop (null khi không có câu nào). */
  multiHopScore: number | null;
  judgeScore: number;
}

/** Báo cáo đầy đủ của một lần chạy eval trên một dataset. */
export interface MemoryEvalReport {
  datasetId: string;
  datasetVersion: number;
  retrieverName: string;
  /** Nhãn phiên bản retriever/memory đang đo (vd 'memory-v5.2', 'baseline'). */
  retrieverVersion: string;
  topK: number;
  at: number;
  perQuestion: MemoryQuestionScore[];
  byCategory: MemoryCategoryScore[];
  overall: MemoryCategoryScore;
}

function f1Of(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Chấm một câu hỏi từ danh sách hit đã lấy.
 *
 * - recall/precision/F1 so với expectedFactIds;
 * - temporalAccuracy: với câu temporal, 1 khi ít nhất một fact lấy
 *   được có `date === expectedDate`, 0 khi không (fact lấy được mang
 *   sai ngày hoặc không có ngày đều tính sai — retrieval phải phân
 *   biệt được thời gian, không chỉ từ khóa);
 * - multiHopScore: tỉ lệ hop được phủ (mỗi hop cần ≥ 1 fact của hop
 *   đó trong topK);
 * - judgeScore: tỉ lệ expectedAnswerKeywords (lowercase, so khớp
 *   từng từ) xuất hiện trong văn bản các fact lấy được.
 */
export function scoreMemoryQuestion(
  question: MemoryEvalQuestion,
  hits: readonly MemoryRetrievalHit[],
  factsById: Map<string, MemoryFact>,
): MemoryQuestionScore {
  const retrievedIds = hits.map((h) => h.factId);
  const retrievedSet = new Set(retrievedIds);
  const expectedSet = new Set(question.expectedFactIds);
  const retrievedExpectedIds = question.expectedFactIds.filter((id) => retrievedSet.has(id));
  const recall = question.expectedFactIds.length === 0 ? 0 : retrievedExpectedIds.length / question.expectedFactIds.length;
  const precision = retrievedIds.length === 0 ? 0 : retrievedExpectedIds.length / retrievedIds.length;
  const f1 = f1Of(precision, recall);

  let temporalAccuracy: number | null = null;
  if (question.category === 'temporal' && question.expectedDate) {
    const hitRightDate = hits.some((h) => factsById.get(h.factId)?.date === question.expectedDate);
    temporalAccuracy = hitRightDate ? 1 : 0;
  }

  let multiHopScore: number | null = null;
  if (question.category === 'multi-hop') {
    const hops = question.hops && question.hops.length > 0 ? question.hops : [question.expectedFactIds];
    const covered = hops.filter((hop) => hop.some((fid) => retrievedSet.has(fid))).length;
    multiHopScore = hops.length === 0 ? 0 : covered / hops.length;
  }

  const haystack = hits.map((h) => h.text.toLowerCase()).join('\n');
  const matchedKeywords = question.expectedAnswerKeywords.filter((kw) =>
    haystack.includes(kw.toLowerCase()),
  ).length;
  const judgeScore =
    question.expectedAnswerKeywords.length === 0
      ? 0
      : matchedKeywords / question.expectedAnswerKeywords.length;

  return {
    questionId: question.id,
    category: question.category,
    recall,
    precision,
    f1,
    temporalAccuracy,
    multiHopScore,
    judgeScore,
    retrievedExpectedIds,
    retrievedIds,
  };
}

function aggregateCategory(
  category: MemoryEvalQuestionCategory | 'overall',
  scores: MemoryQuestionScore[],
): MemoryCategoryScore {
  const n = scores.length;
  const mean = (pick: (s: MemoryQuestionScore) => number): number =>
    n === 0 ? 0 : scores.reduce((sum, s) => sum + pick(s), 0) / n;
  const temporal = scores.filter((s) => s.temporalAccuracy !== null);
  const hops = scores.filter((s) => s.multiHopScore !== null);
  return {
    category,
    count: n,
    recall: mean((s) => s.recall),
    precision: mean((s) => s.precision),
    f1: mean((s) => s.f1),
    temporalAccuracy:
      temporal.length === 0
        ? null
        : temporal.reduce((sum, s) => sum + (s.temporalAccuracy ?? 0), 0) / temporal.length,
    multiHopScore:
      hops.length === 0 ? null : hops.reduce((sum, s) => sum + (s.multiHopScore ?? 0), 0) / hops.length,
    judgeScore: mean((s) => s.judgeScore),
  };
}

export interface RunMemoryEvalOptions {
  /** Số fact lấy tối đa mỗi câu (mặc định 5). */
  topK?: number;
  /** Nhãn phiên bản đang đo — dùng để so sánh baseline vs hiện tại. */
  retrieverVersion?: string;
  /** Thời điểm chạy (epoch ms, mặc định Date.now()). */
  at?: number;
}

/**
 * Chạy toàn bộ dataset qua retriever, chấm từng câu, gom theo loại.
 * Không gọi mạng, không dùng key — retriever mock chạy local.
 */
export async function runMemoryEval(
  dataset: MemoryEvalDataset,
  retriever: MemoryRetriever,
  opts: RunMemoryEvalOptions = {},
): Promise<MemoryEvalReport> {
  const topK = opts.topK ?? 5;
  if (!Number.isInteger(topK) || topK <= 0) throw new Error('runMemoryEval needs topK as an integer > 0.');
  const factsById = indexFactsById(dataset);
  const perQuestion: MemoryQuestionScore[] = [];
  for (const question of dataset.questions) {
    const hits = await retriever.retrieve(question.question, topK);
    perQuestion.push(scoreMemoryQuestion(question, hits, factsById));
  }
  const byCategory: MemoryCategoryScore[] = (['recall', 'temporal', 'multi-hop'] as const).map(
    (category) =>
      aggregateCategory(category, perQuestion.filter((s) => s.category === category)) as MemoryCategoryScore,
  );
  const overall = aggregateCategory('overall', perQuestion);
  return {
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    retrieverName: retriever.name,
    retrieverVersion: opts.retrieverVersion ?? 'unlabelled',
    topK,
    at: opts.at ?? Date.now(),
    perQuestion,
    byCategory,
    overall,
  };
}

/**
 * Retriever mock thứ hai: chấm theo chồng lấp từ khóa (Jaccard trên
 * tập token), không dùng embedding. Dùng để so sánh chiến lược
 * retrieval trong cùng một bộ eval — vd mock-embedding-v1 vs
 * keyword-v1 trên cùng dataset, cùng topK — xem chiến lược nào
 * recall cao hơn trước khi gắn retriever thật.
 */
export class KeywordMockRetriever implements MemoryRetriever {
  readonly name = 'keyword-v1';
  private readonly facts: readonly MemoryFact[];

  constructor(facts: readonly MemoryFact[]) {
    if (!Array.isArray(facts) || facts.length === 0) {
      throw new Error('KeywordMockRetriever needs at least one fact.');
    }
    this.facts = facts;
  }

  retrieve(query: string, topK: number): MemoryRetrievalHit[] {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new Error('retrieve needs a non-empty query.');
    }
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new Error('retrieve needs topK as an integer > 0.');
    }
    const queryTokens = new Set(tokenizeEvalText(query));
    const scored = this.facts
      .map((fact) => {
        const factTokens = new Set(tokenizeEvalText(fact.text));
        let overlap = 0;
        for (const token of queryTokens) if (factTokens.has(token)) overlap += 1;
        const union = new Set([...queryTokens, ...factTokens]).size;
        return {
          factId: fact.id,
          text: fact.text,
          score: union === 0 ? 0 : overlap / union,
        };
      })
      .sort((a, b) => b.score - a.score || a.factId.localeCompare(b.factId));
    return scored.slice(0, topK);
  }
}

/**
 * Mock LLM judge — KHÔNG gọi model thật. Trả lời một câu hỏi bằng
 * cách ghép các fact lấy được rồi đếm từ khóa đáp án có mặt hay
 * không; dùng để ước lượng "retrieval có đủ nguyên liệu để một LLM
 * trả lời đúng không", không phải để chấm câu trả lời thật.
 */
export function mockJudgeAnswer(
  question: MemoryEvalQuestion,
  hits: readonly MemoryRetrievalHit[],
): { answer: string; judgeScore: number } {
  const answer =
    hits.length === 0
      ? 'I could not find relevant memories.'
      : hits.map((h) => h.text).join(' ');
  const haystack = answer.toLowerCase();
  const matched = question.expectedAnswerKeywords.filter((kw) => haystack.includes(kw.toLowerCase())).length;
  const judgeScore =
    question.expectedAnswerKeywords.length === 0 ? 0 : matched / question.expectedAnswerKeywords.length;
  return { answer, judgeScore };
}
