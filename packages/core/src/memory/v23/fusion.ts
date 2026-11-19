/**
 * Memory v23 — retrieval fusion (v1.38, Doi T1).
 *
 * Fusion 3 tin hieu tren record v23 (y tuong Mem0, tu cai dat lai):
 *  1. Semantic — cosine similarity giua embedding cua query va
 *     embedding cua record (Ollama neu co, hash neu khong; khi
 *     corpus toan hash thi trong so semantic tu giam mot nua va
 *     phan giam chuyen sang BM25 — vi hash khong phai ngu nghia that).
 *  2. BM25 — xep hang keyword co dien (tu cai dat, khong phu thuoc),
 *     co chuan hoa do dai document, k1=1.5 / b=0.75.
 *  3. Entity — ti le entity cua query co trong record (+ bonus
 *     co-occurrence, xem entityIndex).
 *
 * Moi tin hieu chuan hoa theo max 0..1 theo query, roi cong co
 * trong so (mac dinh semantic 0.45 / BM25 0.35 / entity 0.20).
 * Ket qua kem giai thich tung tin hieu de agent/user tu danh gia.
 * Them bien the RRF (reciprocal rank fusion) cho caller muon hop
 * nhat theo thu hang thay vi theo diem.
 */

import { V23EntityIndex, queryEntitiesV23 } from './entityIndex';
import { cosineV23 } from './localEmbedder';
import type { V23LocalEmbedder } from './localEmbedder';
import { clampMemoryV23, contentTokensV23 } from './types';
import type { V23FusionHit, V23FusionWeights, V23MemoryRecord } from './types';
import { V23_FUSION_DEFAULT_WEIGHTS } from './types';

/** Tham so BM25. */
export const V23_BM25_K1 = 1.5;
export const V23_BM25_B = 0.75;

/** Tuy chon fusion. */
export interface V23FusionOptions {
  /** Trong so 3 tin hieu (mac dinh 0.45/0.35/0.20). */
  weights?: Partial<V23FusionWeights>;
  /** So hit tra ve toi da (mac dinh 10). */
  topK?: number;
  /** Chi lay hit co diem >= nguong (mac dinh 0 — lay tat ca). */
  minScore?: number;
  /** Entity index (neu khong co, tin hieu entity = khop truc tiep). */
  entityIndex?: V23EntityIndex;
  /** Tu khoa entity bo sung cho query. */
  extraEntityKeywords?: string[];
  /** Chi lay record con hieu luc tai thoi diem nay (mac dinh true). */
  onlyValidNow?: boolean;
  /** Ham lay thoi gian (test truyen clock co dinh). */
  now?: () => number;
}

/** Ket qua BM25 cho mot document (chua chuan hoa). */
export interface V23Bm25Score {
  recordId: string;
  score: number;
}

/**
 * BM25 tu cai dat tren tap record. Index duoc xay mot lan (tu
 * content tokens cua record), query duoc cham theo cong thuc
 * chuan: IDF * tf*(k1+1)/(tf+k1*(1-b+b*dl/avgdl)).
 */
export class V23Bm25Index {
  private readonly docs = new Map<string, { tokens: string[]; length: number }>();
  private readonly docFreq = new Map<string, number>();
  private avgDocLength = 0;

  constructor(records: V23MemoryRecord[] = []) {
    for (const record of records) this.addRecord(record.id, record.text);
    this.finish();
  }

  addRecord(id: string, text: string): void {
    const tokens = contentTokensV23(text);
    this.docs.set(id, { tokens, length: tokens.length });
    const unique = new Set(tokens);
    for (const token of unique) {
      this.docFreq.set(token, (this.docFreq.get(token) ?? 0) + 1);
    }
  }

  /** Tinh avgDocLength sau khi them xong (goi truoc khi cham). */
  finish(): void {
    let total = 0;
    for (const doc of this.docs.values()) total += doc.length;
    this.avgDocLength = this.docs.size === 0 ? 0 : total / this.docs.size;
  }

  /** So document trong index. */
  size(): number {
    return this.docs.size;
  }

  /** Cham BM25 cho query, tra map id -> diem tho (chua chuan hoa). */
  score(query: string): Map<string, number> {
    const out = new Map<string, number>();
    const queryTokens = contentTokensV23(query);
    if (queryTokens.length === 0 || this.docs.size === 0) return out;
    const n = this.docs.size;
    const avgdl = this.avgDocLength || 1;
    for (const [id, doc] of this.docs) {
      if (doc.length === 0) continue;
      const tf = new Map<string, number>();
      for (const token of doc.tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      let score = 0;
      for (const token of new Set(queryTokens)) {
        const count = tf.get(token);
        if (!count) continue;
        const df = this.docFreq.get(token) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const denom = count + V23_BM25_K1 * (1 - V23_BM25_B + (V23_BM25_B * doc.length) / avgdl);
        score += idf * ((count * (V23_BM25_K1 + 1)) / denom);
      }
      if (score > 0) out.set(id, score);
    }
    return out;
  }
}

/** Chuan hoa max mot map diem ve 0..1 (chia cho max; giu ti le
 * tuong doi — khong day doc thap nhat ve 0 nhu min-max, de trong
 * so scope / tin hieu khac van co tac dung). Map rong -> rong;
 * max <= 0 -> tat ca 0. */
export function normalizeScoresV23(scores: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (scores.size === 0) return out;
  let max = -Infinity;
  for (const v of scores.values()) {
    if (v > max) max = v;
  }
  if (max <= 0) {
    for (const [k] of scores) out.set(k, 0);
    return out;
  }
  for (const [k, v] of scores) out.set(k, Math.max(0, v) / max);
  return out;
}

/** Chuan hoa trong so fusion (tong ve 1; tong 0 -> dung mac dinh). */
export function normalizeWeightsV23(weights: Partial<V23FusionWeights>): V23FusionWeights {
  const s = (weights.semantic ?? V23_FUSION_DEFAULT_WEIGHTS.semantic) +
    (weights.bm25 ?? V23_FUSION_DEFAULT_WEIGHTS.bm25) +
    (weights.entity ?? V23_FUSION_DEFAULT_WEIGHTS.entity);
  if (s <= 0) return { ...V23_FUSION_DEFAULT_WEIGHTS };
  return {
    semantic: (weights.semantic ?? V23_FUSION_DEFAULT_WEIGHTS.semantic) / s,
    bm25: (weights.bm25 ?? V23_FUSION_DEFAULT_WEIGHTS.bm25) / s,
    entity: (weights.entity ?? V23_FUSION_DEFAULT_WEIGHTS.entity) / s,
  };
}

/**
 * Fusion 3 tin hieu tren danh sach record. Embedder co the la
 * undefined (khi do semantic = 0 cho moi record, khong gia vo).
 * Record khong co embedding duoc cham semantic 0 (khong bi loai).
 */
export async function fuseV23(
  records: V23MemoryRecord[],
  query: string,
  embedder: V23LocalEmbedder | undefined,
  opts: V23FusionOptions = {},
): Promise<V23FusionHit[]> {
  const trimmed = query.trim();
  const topK = opts.topK ?? 10;
  const minScore = opts.minScore ?? 0;
  const now = opts.now?.() ?? Date.now();
  const onlyValid = opts.onlyValidNow ?? true;

  const actives = records.filter((r) => r.status === 'active');
  const pool = onlyValid
    ? actives.filter((r) => {
        if (r.validFrom && todayOf(now) < r.validFrom) return false;
        if (r.validTo && todayOf(now) > r.validTo) return false;
        return true;
      })
    : actives;
  if (pool.length === 0 || !trimmed) return [];

  // --- Tin hieu 1: semantic (cosine). ---
  const semanticRaw = new Map<string, number>();
  let hashOnlyCorpus = false;
  if (embedder) {
    const queryRes = await embedder.embed(trimmed);
    if (queryRes.ok && queryRes.vector) {
      const queryVec = queryRes.vector;
      let withEmbedding = 0;
      let hashCount = 0;
      for (const record of pool) {
        if (!record.embedding) continue;
        withEmbedding += 1;
        if (record.embeddingKind === 'hash') hashCount += 1;
        const sim = cosineV23(queryVec, record.embedding);
        // Cosine am -> 0 (khong lien quan).
        semanticRaw.set(record.id, Math.max(0, sim));
      }
      hashOnlyCorpus = withEmbedding > 0 && hashCount === withEmbedding;
    }
  }

  // --- Tin hieu 2: BM25. ---
  const bm25 = new V23Bm25Index(pool);
  const bm25Raw = bm25.score(trimmed);

  // --- Tin hieu 3: entity. ---
  const entityIndex = opts.entityIndex;
  const queryEntities = queryEntitiesV23(trimmed, opts.extraEntityKeywords ?? []);
  const expanded = entityIndex ? entityIndex.expandQueryEntities(queryEntities) : [...queryEntities];
  const entityRaw = new Map<string, number>();
  for (const record of pool) {
    const signal = V23EntityIndex.entitySignal(queryEntities, record.entities, expanded);
    if (signal > 0) entityRaw.set(record.id, signal);
  }

  // --- Chuan hoa + trong so. ---
  let weights = normalizeWeightsV23(opts.weights ?? {});
  if (hashOnlyCorpus) {
    // Corpus toan hash: semantic khong dang tin — giam mot nua,
    // chuyen phan giam sang BM25, ghi ro trong giai thich.
    const moved = weights.semantic / 2;
    weights = { semantic: weights.semantic / 2, bm25: weights.bm25 + moved, entity: weights.entity };
  }
  const semantic = normalizeScoresV23(semanticRaw);
  const bm25Norm = normalizeScoresV23(bm25Raw);
  const entity = normalizeScoresV23(entityRaw);

  const hits: V23FusionHit[] = [];
  for (const record of pool) {
    const s = semantic.get(record.id) ?? 0;
    const b = bm25Norm.get(record.id) ?? 0;
    const e = entity.get(record.id) ?? 0;
    const score = clampMemoryV23(weights.semantic * s + weights.bm25 * b + weights.entity * e, 0, 1);
    if (score < minScore) continue;
    const explanation =
      `semantic ${s.toFixed(2)} · bm25 ${b.toFixed(2)} · entity ${e.toFixed(2)}` +
      (hashOnlyCorpus ? ' · hash-embed (semantic giam trong so)' : '');
    hits.push({ record, score, signals: { semantic: s, bm25: b, entity: e }, explanation });
  }
  hits.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
  return hits.slice(0, Math.max(0, topK));
}

/** Ngay YYYY-MM-DD (UTC) tu epoch ms. */
function todayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * RRF (reciprocal rank fusion): hop nhat theo thu hang tung tin
 * hieu thay vi theo diem. `k` mac dinh 60 (gia tri chuan). Dung
 * khi caller khong tin diem tuyet doi cua cac tin hieu.
 */
export async function fuseV23Rrf(
  records: V23MemoryRecord[],
  query: string,
  embedder: V23LocalEmbedder | undefined,
  opts: V23FusionOptions & { rrfK?: number } = {},
): Promise<V23FusionHit[]> {
  const k = opts.rrfK ?? 60;
  const detailed = await fuseV23(records, query, embedder, { ...opts, topK: 1000, minScore: 0 });
  // Xep hang tung tin hieu rieng (de tinh RRF), roi tong hop.
  const bySignal: Record<'semantic' | 'bm25' | 'entity', V23FusionHit[]> = {
    semantic: [...detailed].sort((a, b) => b.signals.semantic - a.signals.semantic),
    bm25: [...detailed].sort((a, b) => b.signals.bm25 - a.signals.bm25),
    entity: [...detailed].sort((a, b) => b.signals.entity - a.signals.entity),
  };
  const rrf = new Map<string, number>();
  const byId = new Map<string, V23FusionHit>();
  for (const hit of detailed) byId.set(hit.record.id, hit);
  for (const signal of ['semantic', 'bm25', 'entity'] as const) {
    const ranked = bySignal[signal];
    ranked.forEach((hit, idx) => {
      if (hit.signals[signal] <= 0) return;
      rrf.set(hit.record.id, (rrf.get(hit.record.id) ?? 0) + 1 / (k + idx + 1));
    });
  }
  const maxRrf = Math.max(0, ...rrf.values());
  const hits: V23FusionHit[] = [];
  for (const [id, value] of rrf) {
    const base = byId.get(id);
    if (!base) continue;
    const score = maxRrf === 0 ? 0 : value / maxRrf;
    if (score < (opts.minScore ?? 0)) continue;
    hits.push({ ...base, score, explanation: `${base.explanation} · rrf ${value.toFixed(4)}` });
  }
  hits.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
  return hits.slice(0, Math.max(0, opts.topK ?? 10));
}
