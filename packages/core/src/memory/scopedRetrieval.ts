/**
 * Per-scope retrieval (v1.03, Đội T2 — Memory v4).
 *
 * Ý tưởng học từ Mem0 (`user_id` / `agent_id` / `run_id` scope, mỗi
 * fact sống đúng một scope nhưng retrieval đi lên hierarchy) nhưng tự
 * thiết kế lại hoàn toàn cho open-bot, chạy 100% local, không gọi
 * model. Scope hierarchy đã có ở `graph/scopes.ts` (run ⊂ agent ⊂
 * user ⊂ app) và `fusedRetrieve` (v1.02) đã fuse hybrid search trên
 * graph — module này là LỚP HỢP NHẤT trên cả ba kho memory:
 *
 *   graph facts (temporal KG) + long-term entries + memory blocks
 *   (attach trực tiếp + shared-group)
 *
 * Một lần `retrieveScoped` trả về hit đã fuse, dedupe, xếp hạng:
 *  - Nguồn nào cũng phải qua `scopeIncludes` — fact của user/bot/
 *    run khác không bao giờ lọt vào (trừ block shared-group mà bot
 *    là thành viên, và entry `includeShared`).
 *  - Điểm = keyword hits × confidence × scope-level weight
 *    (run 1.0 > agent 0.8 > user 0.6 > app 0.4) × source weight
 *    (graph 1.0, long-term 0.9, block 0.85 — block là text dài nên
 *    không lấn fact ngắn, gọn).
 *  - Dedupe theo text chuẩn hoá: cùng một fact nằm cả ở graph lẫn
 *    long-term chỉ trả về một lần (lấy điểm cao nhất, ghi rõ nguồn
 *    đã gộp trong `mergedSources`).
 *  - Query rỗng = "recent": trả về fact/entry/block mới nhất theo
 *    scope, không chấm keyword.
 *
 * Không gọi embedding/model: keyword overlap + confidence + scope
 * weight là đủ cho local-first; host muốn semantic thì dùng
 * `fusedRetrieve` của graph rồi gộp thêm ở đây sau.
 */

import { scopeIncludes, scopeLevel, scopeLevelWeight } from './graph/scopes';
import type { ScopeLevel } from './graph/scopes';
import type { GraphFact, MemoryScope } from './graph/types';
import { factSearchText, normalizeGraphText } from './graph/types';
import type { TemporalGraphStore } from './graph/store';
import type { LongTermMemory } from './longterm';
import { MemoryBlockStore } from './blocks';
import type { SharedBlockGroupStore } from './sharedBlocks';

/** Nguồn của một hit đã fuse. */
export type ScopedHitSource = 'graph' | 'longterm' | 'block' | 'shared-block';

/** Một hit memory đã fuse theo scope. */
export interface ScopedMemoryHit {
  /** Id ổn định: `graph:<factId>` / `longterm:<entryId>` / `block:<blockId>`. */
  id: string;
  source: ScopedHitSource;
  /** Các nguồn khác đã gộp vào hit này khi dedupe. */
  mergedSources: ScopedHitSource[];
  scopeLevel: ScopeLevel;
  scope: MemoryScope;
  /** Text hiển thị (fact / `key: value` / block content tóm tắt). */
  text: string;
  /** Điểm fuse (càng cao càng liên quan + càng hẹp scope). */
  score: number;
  /** Số từ khoá của query khớp hit. */
  keywordHits: number;
  confidence: number;
  /** Thời điểm cập nhật gần nhất. */
  updatedAt: string;
  factId?: string;
  entryId?: string;
  blockId?: string;
}

export interface ScopedRetrievalOptions {
  graphStore?: TemporalGraphStore;
  longTerm?: LongTermMemory;
  blocksStore?: MemoryBlockStore;
  sharedGroups?: SharedBlockGroupStore;
  scope: MemoryScope;
  /** Truy vấn (rỗng = recent theo scope). */
  query?: string;
  /** Số hit tối đa (mặc định 20, tối đa 100). */
  limit?: number;
}

/** Trọng số nguồn khi fuse (graph fact ngắn gọn được ưu tiên nhẹ). */
export const SCOPED_SOURCE_WEIGHTS: Record<ScopedHitSource, number> = {
  graph: 1.0,
  longterm: 0.9,
  block: 0.85,
  'shared-block': 0.85,
};
/** Số fact graph tối đa xét trong một lần retrieve. */
export const SCOPED_MAX_GRAPH_FACTS = 1000;
/** Độ dài tối đa của text block trong hit (cắt ngắn, không trả cả block). */
export const SCOPED_BLOCK_TEXT_CHARS = 500;

function tokenizeQuery(query: string): string[] {
  return normalizeGraphText(query)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function countHits(terms: string[], haystack: string): number {
  if (terms.length === 0) return 0;
  const hay = normalizeGraphText(haystack);
  let hits = 0;
  for (const term of terms) {
    if (hay.includes(term)) hits += 1;
  }
  return hits;
}

/** Scope level của một scope fact/entry (dựa trên trường nào được bind). */
function levelOf(scope: MemoryScope): ScopeLevel {
  return scopeLevel(scope);
}

export function retrieveScoped(opts: ScopedRetrievalOptions): ScopedMemoryHit[] {
  const query = (opts.query ?? '').trim();
  const terms = tokenizeQuery(query);
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100);
  const queryScope: MemoryScope = { ...opts.scope };
  const hits: ScopedMemoryHit[] = [];

  // --- 1. Graph facts (active, còn hiệu lực) ---
  if (opts.graphStore) {
    const store = opts.graphStore;
    const facts = store.listFacts({ status: 'active', limit: SCOPED_MAX_GRAPH_FACTS });
    for (const fact of facts) {
      if (!scopeIncludes(queryScope, fact.scope)) continue;
      const subject = store.getEntity(fact.subjectId);
      const object = fact.objectId ? store.getEntity(fact.objectId) : undefined;
      const text = factSearchText(fact, subject?.name ?? fact.subjectId, object?.name);
      const keywordHits = countHits(terms, text);
      if (terms.length > 0 && keywordHits === 0) continue;
      const weight =
        scopeLevelWeight(levelOf(fact.scope)) * SCOPED_SOURCE_WEIGHTS.graph;
      hits.push({
        id: `graph:${fact.id}`,
        source: 'graph',
        mergedSources: [],
        scopeLevel: levelOf(fact.scope),
        scope: { ...fact.scope },
        text,
        score: (terms.length > 0 ? keywordHits : 1) * fact.confidence * weight,
        keywordHits,
        confidence: fact.confidence,
        updatedAt: fact.updatedAt,
        factId: fact.id,
      });
    }
  }

  // --- 2. Long-term entries ---
  if (opts.longTerm) {
    const entries = opts.longTerm.recall({
      query: query === '' ? undefined : query,
      botId: queryScope.botId === '' ? undefined : queryScope.botId,
      userId: queryScope.userId === '' ? undefined : queryScope.userId,
      includeShared: true,
      limit: 100,
    });
    for (const entry of entries) {
      const entryScope: MemoryScope = {
        userId: entry.userId ?? '',
        botId: entry.botId,
        runId: '',
      };
      if (!scopeIncludes(queryScope, entryScope)) continue;
      const text = `${entry.key}: ${entry.value}`;
      const keywordHits = countHits(terms, `${text} ${entry.tags.join(' ')}`);
      if (terms.length > 0 && keywordHits === 0) continue;
      const weight =
        scopeLevelWeight(levelOf(entryScope)) * SCOPED_SOURCE_WEIGHTS.longterm;
      hits.push({
        id: `longterm:${entry.id}`,
        source: 'longterm',
        mergedSources: [],
        scopeLevel: levelOf(entryScope),
        scope: entryScope,
        text,
        score: (terms.length > 0 ? keywordHits : 1) * entry.confidence * weight,
        keywordHits,
        confidence: entry.confidence,
        updatedAt: entry.updatedAt,
        entryId: entry.id,
      });
    }
  }

  // --- 3. Memory blocks (trực tiếp + shared-group) ---
  if (opts.blocksStore && queryScope.botId !== '') {
    const blocksStore = opts.blocksStore;
    const pushBlock = (
      blockId: string,
      source: ScopedHitSource,
      scope: MemoryScope,
    ): void => {
      const block = blocksStore.get(blockId);
      if (!block) return;
      const haystack = `${block.label} ${block.description} ${block.content}`;
      const keywordHits = countHits(terms, haystack);
      if (terms.length > 0 && keywordHits === 0) return;
      const weight =
        scopeLevelWeight(levelOf(scope)) * SCOPED_SOURCE_WEIGHTS[source];
      hits.push({
        id: `block:${block.id}`,
        source,
        mergedSources: [],
        scopeLevel: levelOf(scope),
        scope: { ...scope },
        text: `[${block.label}] ${block.content.slice(0, SCOPED_BLOCK_TEXT_CHARS)}`,
        score: (terms.length > 0 ? keywordHits : 1) * 0.8 * weight,
        keywordHits,
        confidence: 0.8,
        updatedAt: block.updatedAt,
        blockId: block.id,
      });
    };
    const attached = blocksStore.listAttached(queryScope.botId);
    // Block qua nhóm được báo nguồn 'shared-block' kể cả khi nó cũng
    // đang attach trực tiếp (resolve ưu tiên provenance nhóm).
    const sharedIds = new Set<string>();
    if (opts.sharedGroups) {
      for (const resolved of opts.sharedGroups.resolveBlocksForBot(queryScope.botId)) {
        if (resolved.via === 'direct') continue;
        sharedIds.add(resolved.block.id);
        pushBlock(resolved.block.id, 'shared-block', { ...queryScope, runId: '' });
      }
    }
    for (const block of attached) {
      if (sharedIds.has(block.id)) continue;
      pushBlock(block.id, 'block', { ...queryScope, runId: '' });
    }
  }

  // --- 4. Dedupe theo text chuẩn hoá, giữ hit điểm cao nhất ---
  const byText = new Map<string, ScopedMemoryHit>();
  for (const hit of hits) {
    const key = normalizeGraphText(hit.text);
    const existing = byText.get(key);
    if (!existing) {
      byText.set(key, hit);
      continue;
    }
    if (hit.score > existing.score) {
      existing.mergedSources.push(existing.source);
      byText.set(key, { ...hit, mergedSources: [...existing.mergedSources] });
    } else {
      existing.mergedSources.push(hit.source);
    }
  }

  return [...byText.values()]
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}
