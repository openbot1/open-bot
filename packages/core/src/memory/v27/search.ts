/**
 * Memory v27 — hybrid search (v1.42, Doi T3).
 *
 * Y tuong hoc tu Graphiti (survey v142 muc 3): search ket hop
 * embedding + BM25 + graph traversal. Tu thiet ke lai hoan toan
 * cho open-bot, chay local, khong goi model/mang.
 *
 * TRUNG THUC VE "EMBEDDING": open-bot khong goi model embedding
 * o day. Thanh phan "embeddingProxy" la cosine similarity tren
 * vector dem token (bag-of-words) — xac dinh, chay local, dat
 * ten ro la proxy o moi noi hien diem (khong goi la embedding
 * that). Host co the thay bang vector model that sau nay qua
 * V27EmbeddingFn (tuy chon, mac dinh dung proxy).
 *
 * Cong thuc diem (mac dinh):
 *   total = (0.4*bm25n + 0.3*emb + 0.2*entity + 0.1*graph)
 *           * recencyFactor
 *   - bm25n: diem BM25-ish (TF * IDF) chuan hoa 0..1 theo max.
 *   - emb: cosine token-overlap 0..1.
 *   - entity: tong trong so boost cua entity chung (cap 1).
 *   - graph: 1 neu la ke 1 hop cua top hit, 0.5 neu ke 2 hop.
 *   - recencyFactor: 0.5 + 0.5 / (1 + tuoiNgay/30) — fact moi
 *     duoc uu tien nhe, fact cu khong bi loai.
 *
 * Time-travel: asOf loc fact dung tai X (ca valid time VA
 * transaction time — factValidAtV27). currentOnly chi lay fact
 * con hieu luc.
 *
 * 2 pass: pass 1 cham truc tiep (bm25+emb+entity); pass 2 cong
 * graph bonus cho ke cua top 5 hit roi xep lai.
 */
import {
  errV27,
  factValidAtV27,
  normalizeTextV27,
  okV27,
  tokenizeV27,
  V27_LIMITS,
  type V27EntityLink,
  type V27Fact,
  type V27Result,
  type V27SearchHit,
  type V27SearchInput,
  type V27SearchResult,
  type V27SearchScore,
} from './types';
import type { V27Graph } from './graph';
import type { V27EntityRegistry } from './entities';
import type { V27EpisodeStore } from './episodes';
import { extractQueryMentionsV27 } from './extraction';
import { makeV25Scope, parseIsoV25 } from '../v25/types';

/** Ham embedding tuy chon do host cung cap (vector that). */
export type V27EmbeddingFn = (text: string) => number[] | Promise<number[]>;

/** Cosine similarity giua 2 vector so (0..1, 0 neu rong). */
export function cosineV27(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Vector dem token cua 1 text theo tu dien chung (bag-of-words). */
export function tokenCountVectorV27(text: string, vocab: string[]): number[] {
  const counts = new Map<string, number>();
  for (const token of tokenizeV27(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return vocab.map((term) => counts.get(term) ?? 0);
}

/** Tu dien chung: token xuat hien trong query hoac bat ky fact nao. */
export function buildVocabV27(query: string, factTexts: string[]): string[] {
  const vocab = new Set<string>(tokenizeV27(query));
  for (const text of factTexts) {
    for (const token of tokenizeV27(text)) vocab.add(token);
  }
  return [...vocab];
}

/** He so recency: 0.5..1 — fact moi hon thi cao hon (nhe). */
export function recencyFactorV27(createdAt: string, nowMs: number): number {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return 0.5;
  const ageDays = Math.max(0, (nowMs - createdMs) / 86400000);
  return 0.5 + 0.5 / (1 + ageDays / 30);
}

/**
 * Diem BM25-ish: tong TF*IDF cua query token trong fact text.
 * IDF = ln(1 + N/df). Khong chuan hoa do dai day du nhu BM25
 * chuan (goi la "-ish" cho trung thuc) — chia sqrt(dl) nhe de
 * fact dai khong thang vo co.
 */
export function bm25ishV27(
  queryTokens: string[],
  factText: string,
  docFreq: Map<string, number>,
  totalDocs: number,
): number {
  if (totalDocs === 0 || queryTokens.length === 0) return 0;
  const tokens = tokenizeV27(factText);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  let score = 0;
  for (const term of new Set(queryTokens)) {
    const tf = counts.get(term) ?? 0;
    if (tf === 0) continue;
    const df = docFreq.get(term) ?? 0;
    const idf = Math.log(1 + totalDocs / (1 + df));
    score += tf * idf;
  }
  return score / Math.sqrt(1 + tokens.length / 20);
}

/** Text day du cua 1 fact de cham diem (subject+predicate+object+source). */
export function factSearchTextV27(fact: V27Fact): string {
  return `${fact.subject} ${fact.predicate} ${fact.object} ${fact.sourceText}`;
}

/**
 * Hybrid search tren graph v27.
 * Tra Result — loi khi query rong hoac asOf khong hop le.
 */
export function searchV27(
  graph: V27Graph,
  entities: V27EntityRegistry,
  input: V27SearchInput,
  opts: { nowMs?: number } = {},
): V27Result<V27SearchResult> {
  const startedAt = Date.now();
  const nowMs = opts.nowMs ?? Date.now();
  const query = input.query.trim();
  if (!query) return errV27('Query search khong duoc rong.');
  let asOfMs: number | null = null;
  if (input.asOf !== undefined && input.asOf !== null) {
    const parsed = parseIsoV25(input.asOf);
    if (!parsed) return errV27(`Thoi diem asOf "${input.asOf}" khong phai ISO date hop le.`);
    asOfMs = parsed.getTime();
  }
  const limit = Math.min(
    Math.max(1, input.limit ?? V27_LIMITS.defaultSearchLimit),
    V27_LIMITS.maxSearchLimit,
  );
  const useEntityBoost = input.useEntityBoost ?? true;
  const useTraversal = input.useTraversal ?? true;
  const wBm25 = input.weightBm25 ?? 0.4;
  const wEmb = input.weightEmbedding ?? 0.3;
  const wEnt = input.weightEntity ?? 0.2;
  const wGraph = input.weightGraph ?? 0.1;

  // Ung vien: loc scope + currentOnly + asOf (time-travel chat).
  let candidates = graph.list({
    ...(input.scope ? { scope: makeV25Scope(input.scope) } : {}),
    currentOnly: input.currentOnly ?? false,
  });
  if (asOfMs !== null) {
    candidates = candidates.filter((f) => factValidAtV27(f, asOfMs as number));
  }
  const considered = candidates.length;

  // Entity trong query — link KHONG tao moi (search khong ghi).
  const queryEntities: V27EntityLink[] = [];
  if (useEntityBoost) {
    const mentions = extractQueryMentionsV27(query);
    for (const link of entities.linkMentions(mentions, {
      createIfMissing: false,
      nowMs,
    })) {
      queryEntities.push(link);
    }
  }
  const queryEntityIds = new Set(queryEntities.map((l) => l.entityId));
  const boosts = entities.boostsFor([...queryEntityIds], nowMs);

  // Pass 1: bm25 + embedding proxy + entity boost (chua graph).
  const queryTokens = tokenizeV27(query);
  const factTexts = candidates.map((f) => factSearchTextV27(f));
  const vocab = buildVocabV27(query, factTexts);
  const queryVector = tokenCountVectorV27(query, vocab);
  const docFreq = new Map<string, number>();
  for (const text of factTexts) {
    for (const term of new Set(tokenizeV27(text))) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  const raw: { fact: V27Fact; bm25: number; emb: number; entity: number }[] = [];
  let maxBm25 = 0;
  for (let i = 0; i < candidates.length; i++) {
    const fact = candidates[i] as V27Fact;
    const text = factTexts[i] as string;
    const bm25 = bm25ishV27(queryTokens, text, docFreq, candidates.length);
    if (bm25 > maxBm25) maxBm25 = bm25;
    const emb = cosineV27(queryVector, tokenCountVectorV27(text, vocab));
    let entity = 0;
    if (useEntityBoost) {
      for (const eid of fact.entityIds) {
        const boost = boosts.get(eid);
        if (boost) entity += boost.weight;
      }
      entity = Math.min(1, entity);
    }
    raw.push({ fact, bm25, emb, entity });
  }

  // Pass 2: graph bonus — ke 1 hop cua top 5 hit pass 1.
  const direct = raw
    .map((r) => ({
      ...r,
      bm25n: maxBm25 > 0 ? r.bm25 / maxBm25 : 0,
      graph: 0,
    }))
    .sort((a, b) => {
      const sa = wBm25 * a.bm25n + wEmb * a.emb + wEnt * a.entity;
      const sb = wBm25 * b.bm25n + wEmb * b.emb + wEnt * b.entity;
      return sb - sa;
    });
  const topIds = new Set(direct.slice(0, 5).map((r) => r.fact.id));
  const neighborIds = new Set<string>();
  const twoHopIds = new Set<string>();
  if (useTraversal) {
    for (const top of direct.slice(0, 5)) {
      const { hop1, hop2 } = graph.twoHop(top.fact.id, { limit: 20 });
      for (const n of hop1) if (!topIds.has(n.id)) neighborIds.add(n.id);
      for (const n of hop2) if (!topIds.has(n.id) && !neighborIds.has(n.id)) twoHopIds.add(n.id);
    }
  }

  const hits: V27SearchHit[] = [];
  for (const r of direct) {
    const graphBonus = neighborIds.has(r.fact.id) ? 1 : twoHopIds.has(r.fact.id) ? 0.5 : 0;
    const recency = recencyFactorV27(r.fact.createdAt, nowMs);
    const recencyFactor = recency;
    const total =
      (wBm25 * r.bm25n + wEmb * r.emb + wEnt * r.entity + wGraph * graphBonus) *
      recencyFactor;
    const score: V27SearchScore = {
      bm25: Math.round(r.bm25n * 1000) / 1000,
      embeddingProxy: Math.round(r.emb * 1000) / 1000,
      entityBoost: Math.round(r.entity * 1000) / 1000,
      graphBonus,
      recency: Math.round(recency * 1000) / 1000,
      total: Math.round(total * 1000) / 1000,
    };
    const reasons: string[] = [];
    if (r.bm25n > 0.3) reasons.push('khop tu khoa');
    if (r.emb > 0.3) reasons.push('gan nghia (lexical proxy)');
    if (r.entity > 0) {
      const names = [...queryEntityIds]
        .map((id) => entities.get(id)?.name)
        .filter(Boolean);
      reasons.push(`entity: ${names.join(', ')}`);
    }
    if (graphBonus > 0) reasons.push(graphBonus === 1 ? 'ke 1 hop cua top hit' : 'ke 2 hop cua top hit');
    hits.push({
      fact: r.fact,
      score,
      reason: reasons.length > 0 ? reasons.join(' + ') : 'khop yeu',
      viaTraversal: graphBonus > 0,
    });
  }
  hits.sort((a, b) => b.score.total - a.score.total);
  const topHits = hits.filter((h) => h.score.total > 0).slice(0, limit);
  return okV27({
    query,
    hits: topHits,
    considered,
    queryEntities,
    elapsedMs: Date.now() - startedAt,
    timeTravel: asOfMs !== null,
  });
}

/**
 * Search episode theo noi dung (token overlap, xep theo do
 * phu + do moi). Dung khi muon tim bang chung goc, khong phai
 * fact.
 */
export function searchEpisodesV27(
  episodes: V27EpisodeStore,
  query: string,
  opts: { limit?: number; nowMs?: number } = {},
): V27Result<{ episodeId: string; score: number; snippet: string }[]> {
  const q = query.trim();
  if (!q) return errV27('Query search episode khong duoc rong.');
  const limit = Math.min(Math.max(1, opts.limit ?? 10), V27_LIMITS.maxSearchLimit);
  const queryTokens = new Set(tokenizeV27(q));
  const scored: { episodeId: string; score: number; snippet: string }[] = [];
  for (const episode of episodes.list({})) {
    const tokens = tokenizeV27(episode.text);
    if (tokens.length === 0) continue;
    let overlap = 0;
    for (const t of new Set(tokens)) if (queryTokens.has(t)) overlap++;
    if (overlap === 0 && !normalizeTextV27(episode.text).includes(normalizeTextV27(q))) continue;
    const cosine = overlap / Math.sqrt(queryTokens.size * new Set(tokens).size);
    scored.push({
      episodeId: episode.id,
      score: Math.round(cosine * 1000) / 1000,
      snippet: episode.text.slice(0, 200),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return okV27(scored.slice(0, limit));
}
