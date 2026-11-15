/**
 * Retrieval hợp nhất 3 tín hiệu — kiểu Mem0/Zep (v1.10, Đội T1).
 *
 * Mỗi truy vấn chấm điểm ứng viên trên 3 tín hiệu độc lập:
 *  1. Vector — cosine similarity với embedding hash-local (mặc định)
 *     hoặc bất kỳ Embedder nào (Ollama khi khả dụng).
 *  2. BM25 — keyword, tái dùng scorer BM25 của graph v0.98.
 *  3. Entity-match — query có nhắc tới entity của fact không
 *     (subject/object chứa trong query hoặc ngược lại, chuẩn hoá,
 *     bỏ dấu) — để "Hà Nội" tìm được fact về Hà Nội dù câu query
 *     không trùng từ khoá nào khác.
 *
 * Mỗi tín hiệu chuẩn hoá min-max về 0..1 trên tập ứng viên rồi cộng
 * có trọng số (mặc định vector 0.45 / bm25 0.35 / entity 0.20).
 * Kết quả trả về BẢNG ĐIỂM GIẢI THÍCH ĐƯỢC: từng tín hiệu + trọng số
 * + tổng + lý do chọn bằng chữ, để UI hiển thị được "vì sao memory
 * này được recall" thay vì một con số bí ẩn.
 *
 * Ứng viên = fact semantic active (đúng tại asOf nếu truyền) +
 * episode gần nhất (episodic) + procedure khớp trigger. Retrieval
 * KHÔNG đọc working memory (working chỉ phục vụ prompt trực tiếp).
 */

import { Bm25 } from '../graph/bm25';
import type { Embedder } from '../embeddings';
import { LocalHashEmbedder, cosineSimilarity } from './localEmbedding';
import { normalizeV10Text, v10FactSearchText, type V10RetrievalHit, type V10RetrievalResult, type V10ScoreBreakdown } from './types';
import type { BiTemporalGraphV10 } from './biTemporalGraph';
import type { EpisodicStore, ProceduralStore } from './coala';

export interface V10RetrievalWeights {
  vector: number;
  bm25: number;
  entity: number;
}

export const V10_DEFAULT_WEIGHTS: V10RetrievalWeights = { vector: 0.45, bm25: 0.35, entity: 0.2 };

export interface V10RetrievalOptions {
  topK?: number;
  /** Trọng số 3 tín hiệu (mặc định 0.45/0.35/0.20). */
  weights?: Partial<V10RetrievalWeights>;
  /** Embedder cho tín hiệu vector (mặc định: hash-local). */
  embedder?: Embedder;
  /** Bỏ qua tín hiệu vector (vd embedder lỗi). */
  skipVector?: boolean;
  /** Chỉ fact đúng tại thời điểm này (mặc định: bây giờ). null = không lọc thời gian. */
  asOf?: Date | null;
  /** Có gồm episode (episodic) trong kết quả không (mặc định true). */
  includeEpisodic?: boolean;
  /** Có gồm procedure trong kết quả không (mặc định true). */
  includeProcedural?: boolean;
  /** Giới hạn episode xét tới (mặc định 50 episode gần nhất). */
  episodicLimit?: number;
}

interface RawCandidate {
  id: string;
  kind: V10RetrievalHit['kind'];
  text: string;
  entityNames: string[];
  fact?: V10RetrievalHit['fact'];
  /** Điểm vector thô (cosine -1..1, đã cắt về 0..1 ở bước chuẩn hoá). */
  vectorRaw: number;
  bm25Raw: number;
  entityRaw: number;
}

/** Điểm entity-match 0..1: tỉ lệ entity của ứng viên xuất hiện
 *  trong query (chuẩn hoá). Query nhắc "Hà Nội" → fact có object
 *  "Hà Nội" được 1.0; không nhắc entity nào → 0. */
export function entityMatchScore(query: string, entityNames: string[]): number {
  const normQuery = normalizeV10Text(query);
  if (normQuery === '' || entityNames.length === 0) return 0;
  let hits = 0;
  for (const name of entityNames) {
    const normName = normalizeV10Text(name);
    if (normName.length < 2) continue;
    if (normQuery.includes(normName) || normName.includes(normQuery)) hits += 1;
  }
  return hits / entityNames.length;
}

/** Chuẩn hoá min-max một mảng điểm về 0..1 (mọi điểm bằng nhau → 0.5
 *  cho tất cả để không triệt tiêu tín hiệu khi chỉ có 1 ứng viên). */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-9) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

export class FusedRetrieverV10 {
  private readonly embedder: Embedder;

  constructor(embedder?: Embedder) {
    this.embedder = embedder ?? new LocalHashEmbedder();
  }

  async retrieve(
    query: string,
    graph: BiTemporalGraphV10,
    episodic: EpisodicStore,
    procedural: ProceduralStore,
    opts: V10RetrievalOptions = {},
  ): Promise<V10RetrievalResult> {
    const topK = Math.max(1, Math.min(opts.topK ?? 10, 50));
    const weights: V10RetrievalWeights = {
      vector: opts.weights?.vector ?? V10_DEFAULT_WEIGHTS.vector,
      bm25: opts.weights?.bm25 ?? V10_DEFAULT_WEIGHTS.bm25,
      entity: opts.weights?.entity ?? V10_DEFAULT_WEIGHTS.entity,
    };
    const weightSum = weights.vector + weights.bm25 + weights.entity || 1;
    const w = {
      vector: weights.vector / weightSum,
      bm25: weights.bm25 / weightSum,
      entity: weights.entity / weightSum,
    };
    const asOf = opts.asOf === undefined ? new Date() : opts.asOf;
    const includeEpisodic = opts.includeEpisodic ?? true;
    const includeProcedural = opts.includeProcedural ?? true;

    // --- Thu thập ứng viên ---
    // asOf = null → chỉ fact active hiện tại. asOf có giá trị → fact
    // ĐÚNG tại thời điểm đó (kể cả fact sau này bị supersede — đó
    // chính là truy vấn bi-temporal "ở đâu vào tháng 3"); fact đã
    // xoá/quarantine không bao giờ vào (isV10FactValidAt loại).
    const facts = asOf === null ? graph.query({ status: 'active' }) : graph.queryAt(asOf);
    const rawCandidates: RawCandidate[] = facts.map((fact) => ({
      id: fact.id,
      kind: 'semantic' as const,
      text: v10FactSearchText(fact),
      entityNames: [fact.subject, fact.object],
      fact,
      vectorRaw: 0,
      bm25Raw: 0,
      entityRaw: entityMatchScore(query, [fact.subject, fact.object]),
    }));
    if (includeEpisodic) {
      for (const ep of episodic.recent(opts.episodicLimit ?? 50)) {
        rawCandidates.push({
          id: ep.id,
          kind: 'episodic',
          text: ep.summary || ep.text.slice(0, 200),
          entityNames: [],
          vectorRaw: 0,
          bm25Raw: 0,
          entityRaw: 0,
        });
      }
    }
    if (includeProcedural) {
      for (const proc of procedural.list()) {
        rawCandidates.push({
          id: proc.id,
          kind: 'procedural',
          text: `${proc.trigger} — ${proc.steps.join(' ')}`,
          entityNames: [proc.trigger],
          vectorRaw: 0,
          bm25Raw: 0,
          entityRaw: entityMatchScore(query, [proc.trigger]),
        });
      }
    }
    if (rawCandidates.length === 0) {
      return { query, asOf: asOf ? asOf.toISOString() : null, hits: [], candidatesScored: 0, retrievedAt: new Date().toISOString() };
    }

    // --- Tín hiệu 1: vector (cosine, cắt về 0..1) ---
    if (!opts.skipVector) {
      try {
        const queryVec = await this.embedder.embed(query);
        const docVecs = await Promise.all(rawCandidates.map((c) => this.embedder.embed?.(c.text) ?? Promise.resolve([] as number[])));
        rawCandidates.forEach((c, i) => {
          const vec = docVecs[i] ?? [];
          c.vectorRaw = vec.length === 0 ? 0 : Math.max(0, cosineSimilarity(queryVec, vec));
        });
      } catch {
        // Embedder lỗi → tín hiệu vector = 0 cho mọi ứng viên, hai
        // tín hiệu còn lại vẫn chạy (không throw ra ngoài retrieval).
        rawCandidates.forEach((c) => {
          c.vectorRaw = 0;
        });
      }
    }

    // --- Tín hiệu 2: BM25 keyword ---
    const bm25 = new Bm25(rawCandidates.map((c) => ({ id: c.id, text: c.text })));
    const bm25ById = new Map(bm25.search(query, rawCandidates.length).map((r) => [r.id, r.score]));
    for (const c of rawCandidates) {
      c.bm25Raw = Math.max(0, bm25ById.get(c.id) ?? 0);
    }

    // --- Chuẩn hoá từng tín hiệu rồi cộng có trọng số ---
    const vectorNorm = minMaxNormalize(rawCandidates.map((c) => c.vectorRaw));
    const bm25Norm = minMaxNormalize(rawCandidates.map((c) => c.bm25Raw));
    const hits: V10RetrievalHit[] = rawCandidates.map((c, i) => {
      const breakdown: V10ScoreBreakdown = {
        vector: Math.round(vectorNorm[i] * 1000) / 1000,
        bm25: Math.round(bm25Norm[i] * 1000) / 1000,
        entity: Math.round(c.entityRaw * 1000) / 1000,
        weights: { ...w },
        total: 0,
      };
      breakdown.total =
        Math.round((breakdown.vector * w.vector + breakdown.bm25 * w.bm25 + breakdown.entity * w.entity) * 1000) / 1000;
      const reasons: string[] = [
        `vector ${breakdown.vector.toFixed(2)}`,
        `bm25 ${breakdown.bm25.toFixed(2)}`,
        `entity ${breakdown.entity.toFixed(2)}`,
      ];
      if (c.entityRaw > 0) reasons.push(`entity: ${c.entityNames.filter((n) => normalizeV10Text(query).includes(normalizeV10Text(n))).join(', ') || 'khớp tên'}`);
      if (c.kind === 'semantic' && c.fact) {
        reasons.push(`fact ${c.fact.subject} —${c.fact.predicate}→ ${c.fact.object}`);
      }
      return {
        id: c.id,
        kind: c.kind,
        text: c.text,
        fact: c.fact,
        scores: breakdown,
        reasons,
      };
    });

    hits.sort((a, b) => b.scores.total - a.scores.total);
    return {
      query,
      asOf: asOf ? asOf.toISOString() : null,
      hits: hits.slice(0, topK),
      candidatesScored: rawCandidates.length,
      retrievedAt: new Date().toISOString(),
    };
  }
}
