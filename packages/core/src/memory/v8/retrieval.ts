/**
 * Fused retrieval v8 — 3 tín hiệu LOCAL, không embedding, không mạng.
 *
 * Ý tưởng học từ Mem0 v3 (fused retrieval: semantic + BM25 + entity)
 * — nhưng v8 cố tình BỎ nguồn semantic: API này không có tham số
 * embedder, không gọi Ollama, không đọc vector từ đĩa. Ba tín hiệu
 * duy nhất, đều tính local từ text thô:
 *  1. Keyword — BM25 cổ điển (k1 = 1.2, b = 0.75, dùng lại
 *     `V6Bm25Index` của v6), chuẩn hoá theo max trong lần truy vấn.
 *  2. Entity — tỉ lệ entity của bản ghi xuất hiện trong query (dùng
 *     lại `entityMatchScore` của v6).
 *  3. Recency — decay mũ theo tuổi: 0.5^(tuổi / halfLifeNgày).
 *
 * ĐIỂM CUỐI = wK*keyword + wE*entity + wR*recency (tổng trọng số = 1).
 * Mỗi hit kèm breakdown đầy đủ để UI giải thích "vì sao bản ghi này
 * được chọn" — không có điểm đen.
 *
 * KHÔNG RÒ EMBEDDING: module này không import Embedder, không gọi
 * bất kỳ embedder nào, không đọc file vector nào. Nếu caller cần
 * semantic thì dùng `fusedRetrieve` v6 (có embedder tường minh) —
 * đừng dùng module này rồi mong có semantic.
 *
 * KHÔNG TUYÊN BỐ ĐIỂM BENCHMARK: module này không công bố điểm
 * LoCoMo/LongMemEval hay bất kỳ điểm benchmark nào (xem types.ts).
 * Số đo duy nhất là thứ hạng trên fixture trong test — đếm được,
 * tái lập được, không phải benchmark bên ngoài.
 */

import type { V6RecordStore } from '../v3/store';
import type { V6RecordView } from '../v3/types';
import { V6Bm25Index, entityMatchScore } from '../v3/fused';
import { ageInDays } from '../v3/temporal';
import { scopeLevelOf } from '../v3/scopes';
import type {
  V8LocalHit,
  V8LocalOptions,
  V8LocalWeights,
} from './types';
import {
  DEFAULT_V8_LOCAL_WEIGHTS,
  DEFAULT_V8_RECENCY_HALF_LIFE_DAYS,
  V8_LOCAL_DEFAULT_TOP_K,
  V8_LOCAL_MAX_TOP_K,
  V8_NO_BENCHMARK_CLAIM,
} from './types';

/** Lỗi retrieval v8 — mọi message đều tiếng Việt. */
export class V8RetrievalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V8RetrievalError';
  }
}

/** Re-export tuyên bố không-benchmark để tool/UI hiển thị khi cần. */
export { V8_NO_BENCHMARK_CLAIM };

/** Chuẩn hoá trọng số v8 về tổng = 1 (giữ tỉ lệ). */
export function normalizeV8LocalWeights(weights: Partial<V8LocalWeights>): V8LocalWeights {
  const merged: V8LocalWeights = { ...DEFAULT_V8_LOCAL_WEIGHTS, ...weights };
  const total = merged.keyword + merged.entity + merged.recency;
  if (!(total > 0)) return { ...DEFAULT_V8_LOCAL_WEIGHTS };
  return {
    keyword: merged.keyword / total,
    entity: merged.entity / total,
    recency: merged.recency / total,
  };
}

/**
 * Điểm recency 0..1: decay mũ theo tuổi.
 *  - Vừa ghi = 1. Sau 1 half-life = 0.5. Rất cũ -> tiệm cận 0.
 *  - Tuổi âm (thời gian máy lệch) được clamp về 0 ngày.
 */
export function recencyScore(ageDays: number, halfLifeDays: number): number {
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_V8_RECENCY_HALF_LIFE_DAYS;
  const age = Math.max(0, ageDays);
  return Math.pow(0.5, age / halfLife);
}

/** Nhãn scope đọc được cho một bản ghi (để UI hiển thị). */
export function v8ScopeLabel(record: V6RecordView): string {
  const level = scopeLevelOf(record.scope);
  const parts: string[] = [level];
  if (record.scope.userId !== '') parts.push(`user:${record.scope.userId}`);
  if (record.scope.agentId !== '') parts.push(`agent:${record.scope.agentId}`);
  if (record.scope.runId !== '') parts.push(`run:${record.scope.runId}`);
  if (record.scope.appId !== '') parts.push(`app:${record.scope.appId}`);
  return parts.join(' / ');
}

function clampTopK(topK: number | undefined): number {
  if (topK === undefined || !Number.isFinite(topK)) return V8_LOCAL_DEFAULT_TOP_K;
  return Math.min(V8_LOCAL_MAX_TOP_K, Math.max(1, Math.floor(topK)));
}

/**
 * Fused retrieval local trên kho v6 — CHỈ 3 tín hiệu, KHÔNG embedding.
 *
 *  - Chỉ xét bản ghi active (mặc định) + lọc userId/agentId/kinds khi
 *    caller truyền.
 *  - Keyword: BM25 trên `text + entities + tags` của bản ghi.
 *  - Entity: entityMatchScore(query, record.entities).
 *  - Recency: 0.5^(tuổi/halfLife).
 *  - Hit điểm cuối = 0 bị loại. Trả tối đa topK, sắp theo điểm cuối
 *    giảm dần (hoà thì mới hơn trước, rồi id để xác định).
 */
export function localFusedRetrieve(
  store: V6RecordStore,
  query: string,
  opts: V8LocalOptions = {},
): V8LocalHit[] {
  const trimmedQuery = query.trim();
  if (trimmedQuery === '') return [];
  const now = opts.now ?? new Date();
  const weights = normalizeV8LocalWeights(opts.weights ?? {});
  const topK = clampTopK(opts.topK);
  const halfLife = opts.recencyHalfLifeDays ?? DEFAULT_V8_RECENCY_HALF_LIFE_DAYS;
  const activeOnly = opts.activeOnly ?? true;

  let candidates: V6RecordView[] = store.listAll();
  if (activeOnly) candidates = candidates.filter((r) => r.status === 'active');
  if (opts.userId !== undefined && opts.userId !== '') {
    candidates = candidates.filter((r) => r.scope.userId === opts.userId);
  }
  if (opts.agentId !== undefined && opts.agentId !== '') {
    candidates = candidates.filter((r) => r.scope.agentId === opts.agentId);
  }
  if (opts.kinds && opts.kinds.length > 0) {
    const kindSet = new Set(opts.kinds);
    candidates = candidates.filter((r) => kindSet.has(r.kind));
  }
  if (candidates.length === 0) return [];

  const docs = candidates.map((r) => `${r.text} ${r.entities.join(' ')} ${r.tags.join(' ')}`.trim());
  const bm25Index = new V6Bm25Index(docs);
  const rawBm25 = bm25Index.scoreAll(trimmedQuery);
  const maxBm25 = rawBm25.reduce((max, s) => Math.max(max, s), 0);
  const keywordScores = maxBm25 > 0 ? rawBm25.map((s) => s / maxBm25) : rawBm25.map(() => 0);

  const hits: V8LocalHit[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const record = candidates[i] as V6RecordView;
    const ageDays = ageInDays(record.createdAt, now);
    const keyword = keywordScores[i] ?? 0;
    const entity = entityMatchScore(trimmedQuery, record.entities);
    const recency = recencyScore(ageDays, halfLife);
    const final = weights.keyword * keyword + weights.entity * entity + weights.recency * recency;
    if (final <= 0) continue;
    hits.push({
      recordId: record.id,
      text: record.text,
      kind: record.kind,
      scopeLabel: v8ScopeLabel(record),
      confidence: record.confidence,
      ageDays,
      breakdown: { keyword, entity, recency, final },
    });
  }
  hits.sort(
    (a, b) =>
      b.breakdown.final - a.breakdown.final ||
      a.ageDays - b.ageDays ||
      a.recordId.localeCompare(b.recordId),
  );
  return hits.slice(0, topK);
}

/**
 * Giải thích một hit bằng text (để log/debug hoặc trả cho agent):
 * "Hà Nội · user:u1 · 2.5 ngày · final 0.71 = 0.50*0.90 + 0.30*1.00
 * + 0.20*0.45 [local-only: keyword+entity+recency, không embedding]".
 */
export function explainV8LocalHit(hit: V8LocalHit, weights: V8LocalWeights = DEFAULT_V8_LOCAL_WEIGHTS): string {
  const b = hit.breakdown;
  const text = hit.text.length > 80 ? `${hit.text.slice(0, 80)}…` : hit.text;
  return (
    `${text} · ${hit.scopeLabel} · ${hit.ageDays.toFixed(1)} ngày · ` +
    `final ${b.final.toFixed(3)} = (${weights.keyword}*${b.keyword.toFixed(2)} + ` +
    `${weights.entity}*${b.entity.toFixed(2)} + ${weights.recency}*${b.recency.toFixed(2)}) ` +
    `[local-only: keyword+entity+recency, không embedding]`
  );
}
