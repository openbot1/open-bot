/**
 * Memory v18 — Hybrid retrieval v2: semantic + BM25 + entity (v1.19, Doi T1).
 *
 * Y tuong hoc tu Mem0 v3 (2026: hybrid retrieval ket hop semantic +
 * BM25 + entity linking) — tu thiet ke lai hoan toan cho open-bot,
 * chay 100% local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `Bm25` cua memory/graph/bm25: BM25 chuan (k1=1.2, b=0.75).
 *  - `cosineSimilarity` cua memory/embeddings: cosine tren vector
 *    da chuan hoa.
 *  - `factSearchText` / `normalizeGraphText` cua memory/graph/types.
 *  - `entityMatchScoreV16` / `normalizeEntityNameV16` cua
 *    memory/v16/entityLinking: diem khop entity.
 *  - `V15HybridRetriever` KHONG duoc dung lai o day: v15 tron 4 tin
 *    hieu (semantic + BM25 + graph proximity + recency); v18 la
 *    lop tron 3 tin hieu KHAC (semantic + BM25 + entity) voi trong
 *    so cau hinh duoc + giai thich diem tung tin hieu — phuc vu
 *    eval LOCOMO (can biet fact nao vao top nho tin hieu nao).
 *
 * Moi trong v18:
 *  1. `V18HybridWeights` — trong so 3 tin hieu, chuan hoa ve tong 1
 *     (`normalizeWeightsV18`); cau hinh mac dinh uu tien semantic.
 *  2. `retrieveV18` — tron 3 tin hieu bang min-max normalize tung
 *     tin hieu ve [0,1] roi cong co trong so; tra ve hit kem
 *     `signals` (diem tung tin hieu) de UI/eval giai thich.
 *  3. Tin hieu entity: diem khop cao nhat giua token query va ten/
 *     alias cua subject + object entity cua fact (0 neu khong co
 *     entity nao khop) — giup query go ten rieng tim dung fact ma
 *     BM25/semantic co the sot.
 *  4. Tin hieu semantic: cosine giua query embedding (caller cung
 *     cap qua `embed` — mac dinh null vector khi khong co embedder)
 *     va `fact.embedding`; fact khong co embedding duoc diem 0
 *     (khong bi loai, van con BM25 + entity).
 *  5. `explainHitV18` — giai thich text mot hit (tin hieu nao dan
 *     dau, diem bao nhieu) de UI hien thi.
 */

import type { GraphFact, GraphEntity } from '../graph/types';
import { normalizeGraphText, factSearchText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { Bm25 } from '../graph/bm25';
import { cosineSimilarity } from '../embeddings';
import { entityMatchScoreV16, normalizeEntityNameV16 } from '../v16/entityLinking';

/** Loi hybrid retrieval v2 — message tieng Viet. */
export class V18HybridError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V18HybridError';
  }
}

/** Trong so 3 tin hieu hybrid (tong chuan hoa ve 1 khi dung). */
export interface V18HybridWeights {
  /** Trong so semantic (cosine embedding). */
  semantic: number;
  /** Trong so BM25 (tu khoa). */
  bm25: number;
  /** Trong so entity (khop ten entity). */
  entity: number;
}

/** Trong so mac dinh: semantic 0.5, BM25 0.3, entity 0.2. */
export const V18_DEFAULT_HYBRID_WEIGHTS: V18HybridWeights = {
  semantic: 0.5,
  bm25: 0.3,
  entity: 0.2,
};

/** Clamp 0..1. */
export function clamp01V18Hybrid(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Chuan hoa trong so ve tong 1 (so am -> 0; tong 0 -> dung mac
 * dinh). Tra ve ban sao moi, khong sua input.
 */
export function normalizeWeightsV18(input?: Partial<V18HybridWeights>): V18HybridWeights {
  const raw: V18HybridWeights = {
    semantic: Math.max(0, input?.semantic ?? V18_DEFAULT_HYBRID_WEIGHTS.semantic),
    bm25: Math.max(0, input?.bm25 ?? V18_DEFAULT_HYBRID_WEIGHTS.bm25),
    entity: Math.max(0, input?.entity ?? V18_DEFAULT_HYBRID_WEIGHTS.entity),
  };
  const total = raw.semantic + raw.bm25 + raw.entity;
  if (total <= 0) return { ...V18_DEFAULT_HYBRID_WEIGHTS };
  return {
    semantic: raw.semantic / total,
    bm25: raw.bm25 / total,
    entity: raw.entity / total,
  };
}

/** Diem 3 tin hieu cua mot hit (moi tin hieu da ve [0,1]). */
export interface V18HitSignals {
  semantic: number;
  bm25: number;
  entity: number;
}

/** Mot hit hybrid v2. */
export interface V18HybridHit {
  fact: GraphFact;
  /** Diem tong hop 0..1. */
  score: number;
  signals: V18HitSignals;
  /** Tin hieu dan dau (lon nhat). */
  topSignal: keyof V18HitSignals;
}

/** Tuy chon retrieval v2. */
export interface V18HybridOptions {
  weights?: Partial<V18HybridWeights>;
  /** So hit toi da tra ve (mac dinh 10). */
  topK?: number;
  /** Diem tong hop toi thieu de tra ve (mac dinh 0). */
  minScore?: number;
  /**
   * Ham embed query -> vector (caller cung cap, vd Ollama
   * nomic-embed-text). Neu khong co, tin hieu semantic = 0.
   */
  embed?: (text: string) => number[] | null;
  /** Chi lay fact active (mac dinh true). */
  activeOnly?: boolean;
  /** Predicate loc (vd chi 'lives_in'); rong = tat ca. */
  predicate?: string;
}

/** Min-max normalize mot mang diem ve [0,1] (max=0 -> toan 0). */
export function minMaxNormalizeV18(values: number[]): number[] {
  const max = values.length === 0 ? 0 : Math.max(...values);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => clamp01V18Hybrid(v / max));
}

/**
 * Diem entity cua mot fact doi voi query: diem khop cao nhat giua
 * cac token query va ten/alias cua subject + object entity.
 * Token query ngan (<=1 ky tu) bi bo qua.
 */
export function entityScoreForFactV18(
  query: string,
  fact: GraphFact,
  entityById: (id: string) => GraphEntity | undefined,
): number {
  const queryTokens = normalizeGraphText(query)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (queryTokens.length === 0) return 0;
  const entities: GraphEntity[] = [];
  const subject = entityById(fact.subjectId);
  if (subject) entities.push(subject);
  if (fact.objectId) {
    const object = entityById(fact.objectId);
    if (object) entities.push(object);
  }
  if (entities.length === 0) return 0;
  let best = 0;
  for (const entity of entities) {
    const names = [entity.name, ...entity.aliases];
    for (const name of names) {
      const normName = normalizeEntityNameV16(name);
      if (normName === '') continue;
      for (const token of queryTokens) {
        // Token query khop neu la token cua ten, hoac ten chua token.
        const nameTokens = normName.split(' ').filter((t) => t.length > 1);
        if (nameTokens.includes(token)) {
          best = Math.max(best, 1);
          continue;
        }
        if (normName.includes(token) && token.length >= 3) {
          best = Math.max(best, 0.8);
          continue;
        }
        const detail = entityMatchScoreV16(token, name, entity.aliases);
        best = Math.max(best, detail.score * 0.6);
      }
    }
  }
  return clamp01V18Hybrid(best);
}

/**
 * Retrieval hybrid 3 tin hieu tren cac fact cua store (loc theo
 * scope qua `listFacts` cua caller — ham nay nhan danh sach fact
 * san de test duoc ma khong can store).
 */
export function retrieveFromFactsV18(
  query: string,
  facts: GraphFact[],
  entityById: (id: string) => GraphEntity | undefined,
  opts: V18HybridOptions = {},
): V18HybridHit[] {
  const cleanQuery = (query ?? '').trim();
  if (cleanQuery === '' || facts.length === 0) return [];
  const weights = normalizeWeightsV18(opts.weights);
  const topK = Math.max(1, opts.topK ?? 10);
  const minScore = clamp01V18Hybrid(opts.minScore ?? 0);
  const activeOnly = opts.activeOnly ?? true;
  const predicateFilter = (opts.predicate ?? '').trim();

  let pool = facts;
  if (activeOnly) pool = pool.filter((f) => f.status === 'active');
  if (predicateFilter !== '') {
    pool = pool.filter(
      (f) => normalizeGraphText(f.predicate).replace(/\s+/g, '_') === normalizeGraphText(predicateFilter).replace(/\s+/g, '_'),
    );
  }
  if (pool.length === 0) return [];

  // Tin hieu BM25 (chuan).
  const bm25 = new Bm25(
    pool.map((f) => ({
      id: f.id,
      text: factSearchText(f, entityById(f.subjectId)?.name ?? '', entityById(f.objectId ?? '')?.name),
    })),
  );
  const bm25ById = new Map<string, number>();
  for (const r of bm25.search(cleanQuery, pool.length)) bm25ById.set(r.id, r.score);

  // Tin hieu semantic (cosine; khong co embedder -> 0).
  const queryEmbedding = opts.embed ? opts.embed(cleanQuery) : null;
  const semanticById = new Map<string, number>();
  if (queryEmbedding && queryEmbedding.length > 0) {
    for (const fact of pool) {
      if (!fact.embedding || fact.embedding.length === 0) {
        semanticById.set(fact.id, 0);
        continue;
      }
      semanticById.set(fact.id, clamp01V18Hybrid(cosineSimilarity(queryEmbedding, fact.embedding)));
    }
  } else {
    for (const fact of pool) semanticById.set(fact.id, 0);
  }

  // Tin hieu entity.
  const entityByFact = new Map<string, number>();
  for (const fact of pool) entityByFact.set(fact.id, entityScoreForFactV18(cleanQuery, fact, entityById));

  // Min-max normalize tung tin hieu roi cong co trong so.
  const bm25Norm = minMaxNormalizeV18(pool.map((f) => bm25ById.get(f.id) ?? 0));
  const semanticNorm = minMaxNormalizeV18(pool.map((f) => semanticById.get(f.id) ?? 0));
  const entityNorm = minMaxNormalizeV18(pool.map((f) => entityByFact.get(f.id) ?? 0));

  const hits: V18HybridHit[] = pool.map((fact, i) => {
    const signals: V18HitSignals = {
      semantic: semanticNorm[i] ?? 0,
      bm25: bm25Norm[i] ?? 0,
      entity: entityNorm[i] ?? 0,
    };
    const score =
      signals.semantic * weights.semantic + signals.bm25 * weights.bm25 + signals.entity * weights.entity;
    const topSignal: keyof V18HitSignals =
      signals.semantic >= signals.bm25 && signals.semantic >= signals.entity
        ? 'semantic'
        : signals.bm25 >= signals.entity
          ? 'bm25'
          : 'entity';
    return { fact, score: clamp01V18Hybrid(score), signals, topSignal };
  });
  hits.sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id));
  return hits.filter((h) => h.score >= minScore && h.score > 0).slice(0, topK);
}

/**
 * Retrieval hybrid tren store: lay fact theo scope (qua
 * `listFacts`), resolve entity qua store, roi goi
 * `retrieveFromFactsV18`.
 */
export function retrieveV18(
  store: TemporalGraphStore,
  query: string,
  scope: Parameters<TemporalGraphStore['listFacts']>[0] | undefined,
  opts: V18HybridOptions = {},
): V18HybridHit[] {
  const facts = store.listFacts(scope ?? {});
  return retrieveFromFactsV18(query, facts, (id) => store.getEntity(id), opts);
}

/** Giai thich text mot hit (de UI hien thi ly do fact duoc chon). */
export function explainHitV18(hit: V18HybridHit): string {
  const s = hit.signals;
  return (
    `diem ${hit.score.toFixed(2)} (dan dau: ${hit.topSignal} — ` +
    `semantic ${s.semantic.toFixed(2)}, BM25 ${s.bm25.toFixed(2)}, entity ${s.entity.toFixed(2)})`
  );
}
