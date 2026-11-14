/**
 * Multi-scope memory — Memory v6 (v1.05, Đội T1).
 *
 * Ý tưởng học từ Mem0 v3 / Letta (memory chia theo scope user /
 * agent / run / app, truy vấn ở scope hẹp thấy cả scope rộng hơn) —
 * tự thiết kế lại hoàn toàn cho open-bot, 100% local, không copy
 * code/text/tài sản của bất kỳ repo nào.
 *
 * THỨ BẬC SCOPE (mặc định, cấu hình được qua `scopePriority`):
 *   run > agent > user > app
 * Nghĩa là: một truy vấn ở run X thấy memory của run X, của agent,
 * của user và của app; khi cùng một `key` tồn tại ở nhiều mức, mức
 * HẸP HƠN thắng (vd preference ở mức run ghi đè preference ở mức
 * user — giống biến cục bộ che biến toàn cục).
 *
 * Một bản ghi thuộc đúng MỘT mức scope (mức hẹp nhất mà nó gắn):
 *  - runId !== ''        -> mức 'run'
 *  - agentId !== ''      -> mức 'agent'
 *  - userId !== ''       -> mức 'user'
 *  - chỉ appId !== ''    -> mức 'app'
 *  - tất cả rỗng         -> mức 'app' (nhớ chung toàn cục)
 *
 * QUY TẮC NHÌN THẤY (visibility): truy vấn ở scope Q chỉ thấy bản
 * ghi ở mức M khi mọi id của mức đó khớp với Q (vd bản ghi mức run
 * chỉ thấy khi runId khớp; bản ghi mức agent chỉ thấy khi agentId
 * khớp; bản ghi mức user chỉ thấy khi userId khớp; bản ghi mức app
 * thấy khi appId khớp hoặc appId rỗng = nhớ chung).
 */

import type { V6AppendInput, V6RecordView, V6Scope, V6ScopeLevel, V6ScopeQuery } from './types';
import { DEFAULT_V6_SCOPE_PRIORITY, emptyV6Scope, toV6Scope } from './types';
import type { V6RecordStore } from './store';

/** Mức scope của một scope đầy đủ (mức hẹp nhất mà nó gắn). */
export function scopeLevelOf(scope: V6Scope): V6ScopeLevel {
  if (scope.runId !== '') return 'run';
  if (scope.agentId !== '') return 'agent';
  if (scope.userId !== '') return 'user';
  return 'app';
}

/** Nhãn hiển thị của một mức scope. */
export function scopeLevelLabel(level: V6ScopeLevel): string {
  switch (level) {
    case 'run':
      return 'Run';
    case 'agent':
      return 'Agent';
    case 'user':
      return 'User';
    case 'app':
      return 'App';
  }
}

/** Trọng số boost theo mức scope trong fused retrieval (hẹp > rộng). */
export function scopeLevelWeight(level: V6ScopeLevel, priority: V6ScopeLevel[] = DEFAULT_V6_SCOPE_PRIORITY): number {
  const index = priority.indexOf(level);
  if (index === -1) return 0.5;
  // Mức đầu tiên trong priority = 1.0, mỗi mức sau trừ 0.15 (tối thiểu 0.4).
  return Math.max(0.4, 1 - index * 0.15);
}

/**
 * Một bản ghi ở `recordScope` có nhìn thấy được từ truy vấn `query`
 * không? Quy tắc:
 *  - mức run: runId phải khớp (truy vấn không nêu runId -> không thấy).
 *  - mức agent: agentId phải khớp.
 *  - mức user: userId phải khớp (truy vấn không nêu userId nhưng bản
 *    ghi có userId '' = legacy -> vẫn thấy).
 *  - mức app: appId khớp, hoặc bản ghi có appId '' (nhớ chung).
 */
export function scopeVisible(recordScope: V6Scope, query: V6ScopeQuery): boolean {
  const level = scopeLevelOf(recordScope);
  switch (level) {
    case 'run':
      return query.runId !== undefined && query.runId !== '' && recordScope.runId === query.runId;
    case 'agent':
      return (
        query.agentId !== undefined && query.agentId !== '' && recordScope.agentId === query.agentId
      );
    case 'user':
      if (recordScope.userId === '') return true;
      return query.userId !== undefined && query.userId !== '' && recordScope.userId === query.userId;
    case 'app':
      if (recordScope.appId === '') return true;
      return query.appId !== undefined && recordScope.appId === query.appId;
  }
}

/**
 * Sắp xếp một danh sách bản ghi theo độ ưu tiên scope (hẹp trước,
 * rộng sau) rồi theo thời gian mới trước. Dùng để resolve key: phần
 * tử đầu tiên là "người thắng".
 */
export function sortByScopePriority<T extends { scope: V6Scope; createdAt: string }>(
  records: T[],
  priority: V6ScopeLevel[] = DEFAULT_V6_SCOPE_PRIORITY,
): T[] {
  const rank = (level: V6ScopeLevel): number => {
    const index = priority.indexOf(level);
    return index === -1 ? priority.length : index;
  };
  return [...records].sort((a, b) => {
    const rankDiff = rank(scopeLevelOf(a.scope)) - rank(scopeLevelOf(b.scope));
    if (rankDiff !== 0) return rankDiff;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

/** Kết quả resolve một key qua các mức scope. */
export interface ScopedResolveResult {
  /** Bản ghi thắng (mức hẹp nhất, mới nhất trong mức đó) — undefined khi không có. */
  winner: V6RecordView | undefined;
  /** Mức scope của winner. */
  winnerLevel: V6ScopeLevel | undefined;
  /** Tất cả ứng viên nhìn thấy được, đã sắp theo ưu tiên (hẹp trước). */
  candidates: V6RecordView[];
}

/**
 * Resolve một key qua các mức scope: lấy bản ghi active có `key` đó
 * mà truy vấn nhìn thấy, mức hẹp nhất thắng (trong cùng mức, mới
 * nhất thắng). Không tìm thấy -> winner undefined.
 */
export function resolveScopedKey(
  store: V6RecordStore,
  query: V6ScopeQuery,
  key: string,
  priority: V6ScopeLevel[] = DEFAULT_V6_SCOPE_PRIORITY,
): ScopedResolveResult {
  const trimmed = key.trim();
  if (trimmed === '') return { winner: undefined, winnerLevel: undefined, candidates: [] };
  const candidates = sortByScopePriority(
    store.listActive().filter((r) => r.key === trimmed && scopeVisible(r.scope, query)),
    priority,
  );
  const winner = candidates[0];
  return {
    winner,
    winnerLevel: winner ? scopeLevelOf(winner.scope) : undefined,
    candidates,
  };
}

/**
 * Ghi một memory theo scope (append-only qua store).
 * `scope` thiếu mức nào thì mặc định '' — vd chỉ truyền userId thì
 * ghi ở mức user.
 */
export function setScopedMemory(
  store: V6RecordStore,
  scope: V6ScopeQuery,
  input: Omit<V6AppendInput, 'scope'>,
): V6RecordView {
  return store.append({ ...input, scope: toV6Scope(scope) });
}

/**
 * Đọc một memory theo scope (resolve key qua thứ bậc scope).
 * Trả về bản ghi thắng hoặc undefined.
 */
export function getScopedMemory(
  store: V6RecordStore,
  query: V6ScopeQuery,
  key: string,
  priority: V6ScopeLevel[] = DEFAULT_V6_SCOPE_PRIORITY,
): V6RecordView | undefined {
  return resolveScopedKey(store, query, key, priority).winner;
}

/**
 * Liệt kê mọi bản ghi active mà truy vấn nhìn thấy, gom theo key:
 * mỗi key chỉ giữ bản thắng (mức hẹp nhất). Hữu ích để dựng "bảng
 * memory hiệu lực" của một run/agent/user.
 */
export function effectiveScopedMemories(
  store: V6RecordStore,
  query: V6ScopeQuery,
  priority: V6ScopeLevel[] = DEFAULT_V6_SCOPE_PRIORITY,
): V6RecordView[] {
  const visible = store
    .listActive()
    .filter((r) => scopeVisible(r.scope, query));
  const sorted = sortByScopePriority(visible, priority);
  const byKey = new Map<string, V6RecordView>();
  for (const record of sorted) {
    const mapKey = record.key ?? `__text:${record.id}`;
    if (!byKey.has(mapKey)) byKey.set(mapKey, record);
  }
  return [...byKey.values()];
}

/**
 * Mô tả ngắn một scope (vd "run=abc agent=main user=u1 app=open-bot")
 * — dùng cho log/debug, bỏ qua mức rỗng.
 */
export function describeScope(scope: V6ScopeQuery): string {
  const parts: string[] = [];
  if (scope.runId) parts.push(`run=${scope.runId}`);
  if (scope.agentId) parts.push(`agent=${scope.agentId}`);
  if (scope.userId) parts.push(`user=${scope.userId}`);
  if (scope.appId) parts.push(`app=${scope.appId}`);
  return parts.length > 0 ? parts.join(' ') : '(scope chung)';
}

/** Scope mặc định cho ghi memory của user hiện tại (mức user). */
export function userScope(userId: string, appId = ''): V6Scope {
  return { ...emptyV6Scope(), userId, appId };
}

/** Scope mặc định cho ghi memory của một bot (mức agent). */
export function agentScope(userId: string, agentId: string, appId = ''): V6Scope {
  return { ...emptyV6Scope(), userId, agentId, appId };
}

/** Scope mặc định cho ghi memory của một run (mức run). */
export function runScope(userId: string, agentId: string, runId: string, appId = ''): V6Scope {
  return { ...emptyV6Scope(), userId, agentId, runId, appId };
}
