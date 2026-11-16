/**
 * Temporal KG v2 — chuỗi provenance (v1.12, Đội T3).
 *
 * Ý tưởng học từ Graphiti/Zep (mọi fact đều trỏ về episode đã sinh
 * ra nó) nhưng tự thiết kế lại hoàn toàn cho open-bot, 100% local,
 * không copy code/text/tài sản của bất kỳ repo nào.
 *
 * Cái v0.98 đã có: `GraphFact.provenance` bắt buộc (episodeId,
 * turnId, sourceText) và `store.factHistory` (chuỗi supersession).
 *
 * Cái v2 thêm lên trên — chưa có ở main:
 *  1. `episodeFacts`: mọi fact rút ra từ MỘT episode (fact "anh em"
 *     cùng nguồn) — để trả lời "turn này bot đã học được những gì".
 *  2. `factProvenanceChain`: chuỗi provenance ĐẦY ĐỦ của một fact —
 *     fact → episode gốc → các fact anh em cùng episode → toàn bộ
 *     chuỗi supersession → mọi lần invalidate của fact và của các
 *     bản trong chuỗi. Một chỗ duy nhất để audit "fact này từ đâu
 *     ra, ai nói, lúc nào, đã thay đổi ra sao".
 *  3. `provenanceReport`: chuỗi trên render thành text đọc được
 *     (cho tool trả về agent / UI hiển thị).
 *  4. `episodesForEntity`: mọi episode từng nhắc tới một entity
 *     (qua fact của nó) — để truy vết "bot biết về X từ những turn
 *     nào".
 *
 * Mọi hàm ở đây đều là pure read (không ghi).
 */

import type { GraphEpisode, GraphFact, MemoryScope } from './types';
import { factDisplayText } from './types';
import type { TemporalGraphStore } from './store';
import { readInvalidationLog } from './biTemporal';
import type { InvalidationRecord } from './biTemporal';

/** Một fact "anh em": cùng episode với fact đang xét. */
export interface SiblingFact {
  fact: GraphFact;
  subjectName: string;
  text: string;
}

/** Chuỗi provenance đầy đủ của một fact. */
export interface FactProvenanceChain {
  /** Fact đang xét. */
  fact: GraphFact;
  subjectName: string;
  text: string;
  /** Episode đã sinh ra fact (null = episode đã bị dọn khỏi kho). */
  episode: GraphEpisode | null;
  /** Các fact khác rút ra từ cùng episode (không gồm fact đang xét). */
  siblings: SiblingFact[];
  /** Toàn bộ chuỗi supersession của fact (gốc → mới nhất). */
  supersessionChain: GraphFact[];
  /** Mọi lần invalidate của fact đang xét + các bản trong chuỗi. */
  invalidations: InvalidationRecord[];
  /** true = episode gốc vẫn còn trong kho (provenance đầy đủ). */
  provenanceComplete: boolean;
}

/**
 * Mọi fact rút ra từ một episode, xếp theo thời gian tạo.
 * Episode không tồn tại → [] (không throw — caller audit có thể
 * gặp episode đã bị dọn khi kho episode đầy).
 */
export function episodeFacts(store: TemporalGraphStore, episodeId: string): SiblingFact[] {
  const episode = store.getEpisode(episodeId);
  if (!episode) return [];
  const out: SiblingFact[] = [];
  for (const factId of episode.factIds) {
    const fact = store.getFact(factId);
    if (!fact) continue;
    const subjectName = store.getEntity(fact.subjectId)?.name ?? 'user';
    out.push({ fact, subjectName, text: factDisplayText(fact, subjectName) });
  }
  out.sort((a, b) => a.fact.createdAt.localeCompare(b.fact.createdAt));
  return out;
}

/**
 * Chuỗi provenance đầy đủ của một fact. Đọc audit log invalidate
 * khi caller truyền workspaceDir (không có thì invalidations chỉ
 * lấy từ trường `invalidAt` trên fact — vẫn đủ để thấy fact đã bị
 * invalidate, chỉ thiếu lý do chi tiết trong log cũ).
 */
export function factProvenanceChain(
  store: TemporalGraphStore,
  factId: string,
  opts: { workspaceDir?: string } = {},
): FactProvenanceChain | null {
  const fact = store.getFact(factId);
  if (!fact) return null;
  const subjectName = store.getEntity(fact.subjectId)?.name ?? 'user';
  const episode = store.getEpisode(fact.provenance.episodeId) ?? null;
  const siblings = episode
    ? episodeFacts(store, episode.id).filter((s) => s.fact.id !== fact.id)
    : [];
  const supersessionChain = store.factHistory(factId);
  const chainIds = new Set(supersessionChain.map((f) => f.id));
  chainIds.add(fact.id);
  const invalidations: InvalidationRecord[] = [];
  if (opts.workspaceDir) {
    for (const record of readInvalidationLog(opts.workspaceDir, 1000)) {
      if (chainIds.has(record.factId)) invalidations.push(record);
    }
  } else {
    // Không có workspaceDir: dựng bản ghi tối thiểu từ trường
    // invalidAt trên fact (đủ để audit "bị invalidate khi nào").
    for (const chainFact of supersessionChain) {
      if (chainFact.invalidAt === undefined) continue;
      invalidations.push({
        id: `local-${chainFact.id}`,
        factId: chainFact.id,
        subjectName: store.getEntity(chainFact.subjectId)?.name ?? 'user',
        predicate: chainFact.predicate,
        objectText: chainFact.objectText ?? '',
        invalidAt: chainFact.invalidAt,
        previousValidUntil: null,
        reason: chainFact.invalidationReason ?? '',
        actor: chainFact.invalidatedBy ?? 'system',
        at: chainFact.invalidAt,
      });
    }
    if (fact.invalidAt !== undefined && !chainIds.has(fact.id)) {
      invalidations.push({
        id: `local-${fact.id}`,
        factId: fact.id,
        subjectName,
        predicate: fact.predicate,
        objectText: fact.objectText ?? '',
        invalidAt: fact.invalidAt,
        previousValidUntil: null,
        reason: fact.invalidationReason ?? '',
        actor: fact.invalidatedBy ?? 'system',
        at: fact.invalidAt,
      });
    }
  }
  invalidations.sort((a, b) => a.at.localeCompare(b.at));
  return {
    fact,
    subjectName,
    text: factDisplayText(fact, subjectName),
    episode,
    siblings,
    supersessionChain,
    invalidations,
    provenanceComplete: episode !== null,
  };
}

/** Mọi episode từng nhắc tới một entity (qua fact của nó). */
export interface EntityEpisode {
  episode: GraphEpisode;
  /** Fact của entity trong episode này. */
  facts: SiblingFact[];
}

/**
 * Mọi episode từng nhắc tới một entity: quét fact của entity (cả
 * subject lẫn object), gom theo episode, xếp theo thời gian tạo
 * episode. Entity không tồn tại → [].
 */
export function episodesForEntity(
  store: TemporalGraphStore,
  entityName: string,
  opts: { scope?: MemoryScope; limit?: number } = {},
): EntityEpisode[] {
  const entity = store.findEntityByName(entityName);
  if (!entity) return [];
  const scope = opts.scope ?? { userId: '', botId: '', runId: '' };
  const limit = opts.limit === undefined ? 100 : Math.min(1000, Math.max(1, Math.floor(opts.limit)));
  const byEpisode = new Map<string, SiblingFact[]>();
  for (const fact of store.listFacts({ ...scope, limit: 20000 })) {
    if (fact.subjectId !== entity.id && fact.objectId !== entity.id) continue;
    const subjectName = store.getEntity(fact.subjectId)?.name ?? 'user';
    const list = byEpisode.get(fact.provenance.episodeId) ?? [];
    list.push({ fact, subjectName, text: factDisplayText(fact, subjectName) });
    byEpisode.set(fact.provenance.episodeId, list);
  }
  const out: EntityEpisode[] = [];
  for (const [episodeId, facts] of byEpisode) {
    const episode = store.getEpisode(episodeId);
    if (!episode) continue;
    facts.sort((a, b) => a.fact.createdAt.localeCompare(b.fact.createdAt));
    out.push({ episode, facts });
  }
  out.sort((a, b) => a.episode.createdAt.localeCompare(b.episode.createdAt));
  return out.slice(0, limit);
}

/** Render chuỗi provenance thành text đọc được (cho tool / UI). */
export function provenanceReport(chain: FactProvenanceChain): string {
  const lines: string[] = [];
  lines.push(`Fact: ${chain.text}`);
  lines.push(`  id: ${chain.fact.id}`);
  lines.push(`  confidence: ${chain.fact.confidence}, status: ${chain.fact.status}`);
  lines.push(
    `  valid: ${chain.fact.validFrom} – ${chain.fact.validUntil ?? 'nay'}` +
      (chain.fact.invalidAt !== undefined ? ` (invalidated at ${chain.fact.invalidAt})` : ''),
  );
  if (chain.episode) {
    lines.push(`Episode: ${chain.episode.id} (${chain.episode.role}, ${chain.episode.createdAt})`);
    lines.push(`  turn: ${chain.episode.turnId}, run: ${chain.episode.runId}`);
    lines.push(`  text: "${chain.episode.text.slice(0, 200)}"`);
    lines.push(`  source: "${chain.fact.provenance.sourceText}"`);
  } else {
    lines.push('Episode: (đã bị dọn khỏi kho — provenance không đầy đủ)');
    lines.push(`  source: "${chain.fact.provenance.sourceText}"`);
  }
  if (chain.siblings.length > 0) {
    lines.push(`Cùng episode (${chain.siblings.length} fact khác):`);
    for (const sibling of chain.siblings) lines.push(`  - ${sibling.text}`);
  }
  if (chain.supersessionChain.length > 1) {
    lines.push(`Chuỗi thay thế (${chain.supersessionChain.length} bản):`);
    for (const version of chain.supersessionChain) {
      const name = chain.subjectName;
      lines.push(
        `  - [${version.status}] ${factDisplayText(version, name)} ` +
          `(${version.validFrom} – ${version.validUntil ?? 'nay'})`,
      );
    }
  }
  if (chain.invalidations.length > 0) {
    lines.push(`Invalidations (${chain.invalidations.length}):`);
    for (const record of chain.invalidations) {
      lines.push(`  - ${record.invalidAt} bởi ${record.actor}: ${record.reason}`);
    }
  }
  return lines.join('\n');
}
