/**
 * Temporal KG v2 — session scope (v1.12, Đội T3).
 *
 * Ý tưởng: một session là một phiên hội thoại dài của một user+bot
 * (có thể gồm nhiều run, resume qua restart). Fact và episode mang
 * `sessionId` để agent trả lời đúng theo session đang nói chuyện
 * ("trong buổi này Huy đã nói thích gì?") mà không lẫn với session
 * khác — nhưng fact không gắn session (legacy) vẫn nhìn thấy ở mọi
 * session (quy tắc "empty matches everything" của `matchesScope`).
 *
 * Tự thiết kế lại hoàn toàn cho open-bot, 100% local, không copy
 * code/text/tài sản của bất kỳ repo nào. Mọi hàm ở đây đều là pure
 * read, trừ `retargetFactSession` (đổi session của một fact qua
 * store — dùng cho backfill / sửa session ghi nhầm).
 *
 * Session KHÔNG phải một tầng trong hierarchy run ⊂ agent ⊂ user ⊂
 * app (xem scopes.ts): nó là chiều lọc trực giao. Một query session
 * vẫn thấy fact không gắn session, và fact của session khác thì
 * không — giống cách runId lọc, nhưng bền qua restart và resume.
 */

import type { GraphFact, MemoryScope } from './types';
import { factDisplayText } from './types';
import type { TemporalGraphStore } from './store';
import { readInvalidationLog } from './biTemporal';

/** Dựng một scope đầy đủ cho một session. */
export function sessionScope(
  userId: string,
  botId: string,
  sessionId: string,
  opts: { runId?: string; appId?: string } = {},
): MemoryScope {
  return {
    userId: (userId ?? '').trim(),
    botId: (botId ?? '').trim(),
    runId: (opts.runId ?? '').trim(),
    ...(opts.appId ? { appId: opts.appId } : {}),
    sessionId: (sessionId ?? '').trim(),
  };
}

/** Scope của một session, chỉ giữ lại user/bot/session (bỏ run/app). */
export function sessionOnlyScope(scope: MemoryScope): MemoryScope {
  return {
    userId: scope.userId,
    botId: scope.botId,
    runId: '',
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
  };
}

/**
 * Liệt kê fact của một session: fact gắn đúng sessionId ĐÓ, cộng
 * fact không gắn session nào (legacy — nhìn thấy ở mọi session).
 * Muốn CHỈ fact gắn đúng session (loại legacy) thì truyền
 * `strict: true`.
 */
export function listFactsBySession(
  store: TemporalGraphStore,
  sessionId: string,
  scope: MemoryScope,
  opts: { strict?: boolean; status?: GraphFact['status']; limit?: number } = {},
): GraphFact[] {
  const clean = (sessionId ?? '').trim();
  if (clean === '') return [];
  const limit = opts.limit === undefined ? 500 : Math.min(5000, Math.max(1, Math.floor(opts.limit)));
  const facts = store.listFacts({ ...scope, sessionId: clean, limit: 20000 });
  const strict = opts.strict === true;
  return facts
    .filter((f) => (strict ? (f.scope.sessionId ?? '') === clean : true))
    .filter((f) => (opts.status ? f.status === opts.status : true))
    .slice(0, limit);
}

/** Tóm tắt một session: đếm + entity + predicate + khoảng thời gian. */
export interface SessionSummary {
  sessionId: string;
  scope: MemoryScope;
  /** Fact gắn đúng session (không tính legacy). */
  factsInSession: number;
  /** Fact active gắn đúng session. */
  activeFacts: number;
  /** Fact bị invalidate gắn đúng session. */
  invalidatedFacts: number;
  /** Episode gắn đúng session. */
  episodesInSession: number;
  /** Entity được nhắc tới trong session (tên). */
  entities: string[];
  /** Predicate xuất hiện trong session (kèm số fact). */
  predicates: Array<{ predicate: string; count: number }>;
  /** Fact đầu tiên của session (createdAt). */
  firstFactAt: string | null;
  /** Fact mới nhất của session (createdAt). */
  lastFactAt: string | null;
}

export function sessionSummary(
  store: TemporalGraphStore,
  sessionId: string,
  scope: MemoryScope,
): SessionSummary | null {
  const clean = (sessionId ?? '').trim();
  if (clean === '') return null;
  const facts = listFactsBySession(store, clean, scope, { strict: true, limit: 20000 });
  // Episode đã xử lý cũng thuộc session — đếm qua exportFile (read-only).
  const allEpisodes = store.exportFile().episodes.filter((e) => (e.sessionId ?? '') === clean);
  const entityNames = new Set<string>();
  const predicateCounts = new Map<string, number>();
  for (const fact of facts) {
    const subject = store.getEntity(fact.subjectId);
    if (subject) entityNames.add(subject.name);
    if (fact.objectId) {
      const object = store.getEntity(fact.objectId);
      if (object) entityNames.add(object.name);
    }
    predicateCounts.set(fact.predicate, (predicateCounts.get(fact.predicate) ?? 0) + 1);
  }
  const createdAts = facts.map((f) => f.createdAt).sort();
  const predicates = [...predicateCounts.entries()]
    .map(([predicate, count]) => ({ predicate, count }))
    .sort((a, b) => b.count - a.count || a.predicate.localeCompare(b.predicate));
  return {
    sessionId: clean,
    scope,
    factsInSession: facts.length,
    activeFacts: facts.filter((f) => f.status === 'active').length,
    invalidatedFacts: facts.filter((f) => f.invalidAt !== undefined).length,
    episodesInSession: allEpisodes.length,
    entities: [...entityNames].sort(),
    predicates,
    firstFactAt: createdAts[0] ?? null,
    lastFactAt: createdAts[createdAts.length - 1] ?? null,
  };
}

/** Một bước trong timeline của một session. */
export interface SessionTimelineStep {
  at: string;
  kind: 'fact-created' | 'fact-superseded' | 'fact-deleted' | 'fact-invalidated' | 'episode';
  factId?: string;
  episodeId?: string;
  text: string;
}

/**
 * Timeline của một session: fact được tạo / supersede / xoá /
 * invalidate trong session (theo transaction time) + episode của
 * session, xếp theo thời gian. Dùng để xem lại "buổi này đã xảy ra
 * chuyện gì, theo thứ tự".
 */
export function sessionTimeline(
  store: TemporalGraphStore,
  sessionId: string,
  scope: MemoryScope,
  opts: { workspaceDir?: string; limit?: number } = {},
): SessionTimelineStep[] {
  const clean = (sessionId ?? '').trim();
  if (clean === '') return [];
  const limit = opts.limit === undefined ? 200 : Math.min(2000, Math.max(1, Math.floor(opts.limit)));
  const steps: SessionTimelineStep[] = [];
  const facts = listFactsBySession(store, clean, scope, { strict: true, limit: 20000 });
  for (const fact of facts) {
    const subjectName = store.getEntity(fact.subjectId)?.name ?? 'user';
    const text = factDisplayText(fact, subjectName);
    steps.push({ at: fact.createdAt, kind: 'fact-created', factId: fact.id, text });
    if (fact.status === 'superseded' && fact.validUntil !== null) {
      steps.push({ at: fact.validUntil, kind: 'fact-superseded', factId: fact.id, text });
    }
    if (fact.status === 'deleted' && fact.validUntil !== null) {
      steps.push({ at: fact.validUntil, kind: 'fact-deleted', factId: fact.id, text });
    }
    if (fact.invalidAt !== undefined) {
      steps.push({
        at: fact.invalidAt,
        kind: 'fact-invalidated',
        factId: fact.id,
        text: `${text} (invalidate: ${fact.invalidationReason ?? ''})`,
      });
    }
  }
  const episodes = store.exportFile().episodes.filter((e) => (e.sessionId ?? '') === clean);
  for (const episode of episodes) {
    steps.push({
      at: episode.createdAt,
      kind: 'episode',
      episodeId: episode.id,
      text: `${episode.role}: "${episode.text.slice(0, 120)}"`,
    });
  }
  // Invalidate ghi trong audit log nhưng fact đã bị dọn khỏi kho
  // (hiếm): vẫn hiện bước invalidate để timeline không mất mốc.
  if (opts.workspaceDir) {
    const knownFactIds = new Set(facts.map((f) => f.id));
    for (const record of readInvalidationLog(opts.workspaceDir, 1000)) {
      if (knownFactIds.has(record.factId)) continue;
      steps.push({
        at: record.at,
        kind: 'fact-invalidated',
        factId: record.factId,
        text: `${record.subjectName} —${record.predicate}→ ${record.objectText} (invalidate: ${record.reason})`,
      });
    }
  }
  steps.sort((a, b) => {
    const byAt = a.at.localeCompare(b.at);
    if (byAt !== 0) return byAt;
    return a.kind.localeCompare(b.kind);
  });
  return steps.slice(0, limit);
}

/**
 * Đổi session của một fact (backfill / sửa session ghi nhầm).
 * Trả về fact đã cập nhật. `sessionId` rỗng = gỡ session.
 */
export function retargetFactSession(
  store: TemporalGraphStore,
  factId: string,
  sessionId: string,
): GraphFact {
  return store.setFactSession(factId, sessionId);
}

/** Liệt kê mọi sessionId đang có fact (trong một scope). */
export function listSessionIds(store: TemporalGraphStore, scope: MemoryScope): string[] {
  const ids = new Set<string>();
  for (const fact of store.listFacts({ ...scope, limit: 20000 })) {
    if ((fact.scope.sessionId ?? '') !== '') ids.add(fact.scope.sessionId as string);
  }
  for (const episode of store.exportFile().episodes) {
    if ((episode.sessionId ?? '') !== '') ids.add(episode.sessionId as string);
  }
  return [...ids].sort();
}
