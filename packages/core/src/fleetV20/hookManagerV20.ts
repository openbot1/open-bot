/**
 * Quản lý hook v20 — registry hook theo event, log chặn, bật/tắt
 * (v1.33, Đội T6).
 *
 * Tầng trạng thái thuần cho panel Hook v20. Nối vào hệ hook hiện có
 * trong repo thay vì viết song song: `hooks/registry.ts` đã có đăng ký
 * hook script/command + `hooks/runner.ts` chạy hook thật, `hooks/hookLog.ts`
 * đã có log chạy hook; module này không chạy hook, không thay thế
 * runner — nó trả lời câu panel cần mà runner chưa trả lời:
 *
 * - HOOK NÀO CHẠY KHI EVENT NÀO: matcher event (khớp chính xác,
 *   prefix `agent.*`, hoặc wildcard `*`) + thứ tự chạy theo priority
 *   (số nhỏ chạy trước) + điều kiện chặn (hook `blocking` được quyền
 *   chặn action, hook thường chỉ quan sát).
 * - HOOK NÀO ĐANG CHẶN NGƯỜI DÙNG: log chặn — mỗi lần hook blocking
 *   trả về block, ghi lại event + hook + lý do + thời gian để panel
 *   hiện "ai đã chặn cái gì, vì sao"; log thường (allow) chỉ giữ
 *   tóm tắt để khỏi phình.
 * - HOOK NÀO ĐANG HỎNG: hook timeout/quá số lần lỗi liên tiếp thì tự
 *   chuyển `error` và bị bỏ qua khi match (fail-open có ghi log — hệ
 *   thống không chết vì một hook hỏng, nhưng panel phải thấy rõ).
 *
 * Mọi hàm đều pure — không chạy script, không đọc disk. Runner thật
 * gọi `matchHooksV20` để lấy danh sách hook cần chạy theo đúng thứ tự,
 * rồi gọi `recordHookV20Run` sau mỗi lần chạy để cập nhật log/trạng thái.
 */

export type HookV20EventKind =
  | 'agent.start'
  | 'agent.stop'
  | 'tool.before'
  | 'tool.after'
  | 'file.write'
  | 'file.read'
  | 'message.send'
  | 'subagent.spawn'
  | 'subagent.finish'
  | 'plugin.enable'
  | 'plugin.disable'
  | 'eval.run';

/** Event hook lắng nghe — tên event đầy đủ hoặc pattern `prefix.*` hoặc `*`. */
export type HookV20EventPattern = string;

/** Một hook v20 đã đăng ký. */
export interface HookV20Entry {
  /** Id ổn định, vd `guard-no-shell`. */
  id: string;
  name: string;
  description: string;
  /** Pattern event hook lắng nghe, vd `tool.before`, `file.*`, `*`. */
  eventPattern: HookV20EventPattern;
  /** true = hook blocking (được chặn action); false = chỉ quan sát/log. */
  blocking: boolean;
  /** Số nhỏ chạy trước; bằng nhau thì id nhỏ chạy trước (deterministic). */
  priority: number;
  /** Timeout một lần chạy (ms) — quá thì tính là timeout, không đợi nữa. */
  timeoutMs: number;
  /** true = hook đang bật; false = đã tắt tay (match bỏ qua). */
  enabled: boolean;
  /** Số lỗi liên tiếp — đạt maxConsecutiveErrors thì tự chuyển error. */
  consecutiveErrors: number;
  /** Số lỗi liên tiếp tối đa trước khi tự disable vì lỗi. */
  maxConsecutiveErrors: number;
  /** true = hook đang ở trạng thái lỗi (đã vượt ngưỡng lỗi) — match bỏ qua. */
  errored: boolean;
  /** Lý do lỗi gần nhất (nếu có). */
  lastError?: string;
  /** Tổng số lần hook đã chạy (kể cả allow/block/timeout). */
  runCount: number;
  /** Tổng số lần hook đã chặn action. */
  blockCount: number;
  createdAt: number;
}

export type HookV20RunOutcome = 'allowed' | 'blocked' | 'timeout' | 'error' | 'skipped';

/** Một lần chạy hook đã ghi log. */
export interface HookV20RunLog {
  /** Id log ổn định (hookId + số thứ tự). */
  id: string;
  hookId: string;
  /** Event đã kích hoạt hook, vd `tool.before:shell_exec`. */
  event: string;
  outcome: HookV20RunOutcome;
  /** Lý do block / lỗi (nếu có) — panel hiện nguyên văn cho người dùng. */
  reason?: string;
  /** Thời gian chạy (ms). */
  durationMs: number;
  at: number;
}

/** Store hook v20 — host giữ bền vững. */
export interface HookV20Store {
  hooks: HookV20Entry[];
  /** Log chạy — giữ tối đa `maxLogEntries` (cũ nhất bị drop, block log giữ lâu hơn, xem `pruneHookV20Logs`). */
  logs: HookV20RunLog[];
  maxLogEntries: number;
  /** Số thứ tự log (để sinh id ổn định). */
  logSeq: number;
}

export const HOOK_V20_DEFAULT_MAX_LOG_ENTRIES = 500;
export const HOOK_V20_DEFAULT_TIMEOUT_MS = 5_000;
export const HOOK_V20_DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;

export function createHookV20Store(hooks: HookV20Entry[] = [], maxLogEntries: number = HOOK_V20_DEFAULT_MAX_LOG_ENTRIES): HookV20Store {
  return { hooks: hooks.map((h) => ({ ...h })), logs: [], maxLogEntries, logSeq: 0 };
}

// ---------------------------------------------------------------------------
// Event matching
// ---------------------------------------------------------------------------

/**
 * true khi event khớp pattern: khớp chính xác, `prefix.*` khớp mọi event
 * bắt đầu bằng `prefix.`, `*` khớp mọi event. Pattern rỗng → không khớp
 * (fail-closed: hook không rõ event thì không chạy lung tung).
 */
export function hookV20EventMatches(pattern: HookV20EventPattern, event: string): boolean {
  const p = pattern.trim();
  const e = event.trim();
  if (p.length === 0 || e.length === 0) return false;
  if (p === '*') return true;
  if (p.endsWith('.*')) return e.startsWith(p.slice(0, -1));
  return p === e;
}

/** Validate một entry hook: trả lỗi, rỗng = hợp lệ. */
export function validateHookV20Entry(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['Hook v20 phải là một object.'];
  }
  const h = raw as Record<string, unknown>;
  if (typeof h['id'] !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(h['id'] as string)) {
    errors.push('Hook cần "id" chữ thường/số/gạch ngang, bắt đầu bằng chữ cái.');
  }
  if (typeof h['name'] !== 'string' || (h['name'] as string).trim().length === 0) {
    errors.push('Hook cần "name" không rỗng.');
  }
  if (typeof h['eventPattern'] !== 'string' || (h['eventPattern'] as string).trim().length === 0) {
    errors.push('Hook cần "eventPattern" không rỗng (vd `tool.before`, `file.*`, `*`).');
  }
  if (typeof h['blocking'] !== 'boolean') errors.push('Hook: "blocking" phải là boolean (blocking = được chặn action).');
  if (typeof h['priority'] !== 'number' || !Number.isInteger(h['priority'])) {
    errors.push('Hook: "priority" phải là số nguyên (nhỏ chạy trước).');
  }
  if (typeof h['timeoutMs'] !== 'number' || (h['timeoutMs'] as number) <= 0) {
    errors.push('Hook: "timeoutMs" phải là số > 0.');
  }
  if (typeof h['maxConsecutiveErrors'] !== 'number' || (h['maxConsecutiveErrors'] as number) <= 0) {
    errors.push('Hook: "maxConsecutiveErrors" phải là số > 0.');
  }
  return errors;
}

/**
 * Hook nào chạy cho event này, theo đúng thứ tự: chỉ hook đang bật +
 * không lỗi + pattern khớp; sắp theo priority tăng dần, rồi id tăng dần
 * (deterministic — cùng một event, cùng một store thì luôn ra cùng một
 * thứ tự, panel và runner không lệch nhau).
 */
export function matchHooksV20(store: HookV20Store, event: string): HookV20Entry[] {
  return store.hooks
    .filter((h) => h.enabled && !h.errored && hookV20EventMatches(h.eventPattern, event))
    .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.id.localeCompare(b.id)));
}

/** Chỉ hook blocking trong danh sách match — runner chạy nhóm này trước khi quyết định chặn. */
export function matchBlockingHooksV20(store: HookV20Store, event: string): HookV20Entry[] {
  return matchHooksV20(store, event).filter((h) => h.blocking);
}

// ---------------------------------------------------------------------------
// Đăng ký / bật / tắt / gỡ
// ---------------------------------------------------------------------------

export interface HookV20ChangeResult {
  store: HookV20Store;
  ok: boolean;
  errors: string[];
}

function hookV20Fail(store: HookV20Store, errors: string[]): HookV20ChangeResult {
  return { store, ok: false, errors };
}

/** Đăng ký hook mới: id trùng → lỗi; entry không hợp lệ → lỗi rõ từng trường. */
export function registerHookV20(store: HookV20Store, entry: HookV20Entry): HookV20ChangeResult {
  const errors = validateHookV20Entry(entry);
  if (errors.length > 0) return hookV20Fail(store, errors);
  if (store.hooks.some((h) => h.id === entry.id)) {
    return hookV20Fail(store, [`Hook "${entry.id}" đã tồn tại — gỡ hook cũ hoặc đổi id trước khi đăng ký lại.`]);
  }
  const next: HookV20Store = { ...store, hooks: [...store.hooks, { ...entry }] };
  return { store: next, ok: true, errors: [] };
}

/** Gỡ hook theo id (log của hook vẫn giữ — lịch sử chặn không bị xóa theo hook). */
export function unregisterHookV20(store: HookV20Store, hookId: string): HookV20ChangeResult {
  if (!store.hooks.some((h) => h.id === hookId)) {
    return hookV20Fail(store, [`Không có hook "${hookId}" trong store.`]);
  }
  return { store: { ...store, hooks: store.hooks.filter((h) => h.id !== hookId) }, ok: true, errors: [] };
}

function setHookV20Enabled(store: HookV20Store, hookId: string, enabled: boolean): HookV20ChangeResult {
  const hook = store.hooks.find((h) => h.id === hookId);
  if (!hook) return hookV20Fail(store, [`Không có hook "${hookId}" trong store.`]);
  if (hook.errored && enabled) {
    return hookV20Fail(store, [`Hook "${hookId}" đang ở trạng thái lỗi (${hook.lastError ?? 'không rõ lý do'}) — sửa lỗi rồi reset lỗi trước khi bật lại (xem resetHookV20Error).`]);
  }
  const next: HookV20Store = {
    ...store,
    hooks: store.hooks.map((h) => (h.id === hookId ? { ...h, enabled } : h)),
  };
  return { store: next, ok: true, errors: [] };
}

/** Bật hook (hook đang lỗi thì bị chặn — phải reset lỗi trước). */
export function enableHookV20(store: HookV20Store, hookId: string): HookV20ChangeResult {
  return setHookV20Enabled(store, hookId, true);
}

/** Tắt hook (hook tắt thì match bỏ qua, log vẫn giữ). */
export function disableHookV20(store: HookV20Store, hookId: string): HookV20ChangeResult {
  return setHookV20Enabled(store, hookId, false);
}

/** Reset trạng thái lỗi của hook sau khi đã sửa nguyên nhân (về 0 lỗi liên tiếp, bật lại). */
export function resetHookV20Error(store: HookV20Store, hookId: string): HookV20ChangeResult {
  const hook = store.hooks.find((h) => h.id === hookId);
  if (!hook) return hookV20Fail(store, [`Không có hook "${hookId}" trong store.`]);
  if (!hook.errored && hook.consecutiveErrors === 0) return { store, ok: true, errors: [] };
  const next: HookV20Store = {
    ...store,
    hooks: store.hooks.map((h) =>
      h.id === hookId ? { ...h, errored: false, consecutiveErrors: 0, lastError: undefined, enabled: true } : h,
    ),
  };
  return { store: next, ok: true, errors: [] };
}

// ---------------------------------------------------------------------------
// Ghi log chạy + cập nhật trạng thái hook
// ---------------------------------------------------------------------------

export interface RecordHookV20RunInput {
  hookId: string;
  event: string;
  outcome: HookV20RunOutcome;
  reason?: string;
  durationMs: number;
  at?: number;
}

/**
 * Ghi một lần chạy hook: cập nhật runCount/blockCount/consecutiveErrors
 * của hook + thêm log. Quy tắc lỗi: `timeout`/`error` tăng lỗi liên tiếp
 * (đạt ngưỡng → hook tự chuyển `errored`, match bỏ qua từ đó);
 * `allowed`/`blocked` reset lỗi liên tiếp về 0 (hook chạy lại được là
 * hết lỗi). Log vượt max → drop cũ nhất, NHƯNG log `blocked` được giữ
 * ưu tiên (xem `pruneHookV20Logs` — panel cần lịch sử chặn hơn lịch
 * sử allow).
 */
export function recordHookV20Run(store: HookV20Store, input: RecordHookV20RunInput): HookV20Store {
  const hook = store.hooks.find((h) => h.id === input.hookId);
  const at = input.at ?? Date.now();
  const log: HookV20RunLog = {
    id: `${input.hookId}-${store.logSeq + 1}`,
    hookId: input.hookId,
    event: input.event,
    outcome: input.outcome,
    ...(input.reason ? { reason: input.reason } : {}),
    durationMs: Math.max(0, input.durationMs),
    at,
  };
  let hooks = store.hooks;
  if (hook) {
    const isError = input.outcome === 'timeout' || input.outcome === 'error';
    const nextErrors = isError ? hook.consecutiveErrors + 1 : 0;
    const errored = nextErrors >= hook.maxConsecutiveErrors;
    hooks = store.hooks.map((h) =>
      h.id === input.hookId
        ? {
            ...h,
            runCount: h.runCount + 1,
            blockCount: h.blockCount + (input.outcome === 'blocked' ? 1 : 0),
            consecutiveErrors: nextErrors,
            errored,
            ...(isError && input.reason ? { lastError: input.reason } : {}),
            ...(errored ? { enabled: false } : {}),
          }
        : h,
    );
  }
  const next: HookV20Store = {
    ...store,
    hooks,
    logs: pruneHookV20Logs([...store.logs, log], store.maxLogEntries),
    logSeq: store.logSeq + 1,
  };
  return next;
}

/**
 * Cắt log về tối đa `max`: drop log `allowed` cũ nhất trước, giữ log
 * `blocked`/`error`/`timeout` càng lâu càng tốt (panel cần thấy ai đã
 * chặn cái gì). Chỉ khi toàn bộ log đều là block/error mới drop cũ nhất.
 */
export function pruneHookV20Logs(logs: HookV20RunLog[], max: number): HookV20RunLog[] {
  if (logs.length <= max) return logs;
  const sorted = [...logs].sort((a, b) => a.at - b.at);
  let excess = sorted.length - max;
  const keep: HookV20RunLog[] = [];
  const droppable = sorted.filter((l) => l.outcome === 'allowed' || l.outcome === 'skipped');
  const important = sorted.filter((l) => l.outcome !== 'allowed' && l.outcome !== 'skipped');
  // Giữ hết log quan trọng nếu vừa; drop allow cũ nhất trước.
  const dropAllowed = Math.min(excess, droppable.length);
  keep.push(...droppable.slice(dropAllowed), ...important);
  excess -= dropAllowed;
  if (excess > 0) {
    // Vẫn thừa (toàn log quan trọng): drop cũ nhất trong nhóm quan trọng.
    keep.sort((a, b) => a.at - b.at);
    return keep.slice(excess);
  }
  return keep.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// Quyết định chặn tổng hợp cho một event
// ---------------------------------------------------------------------------

export interface HookV20BlockDecision {
  /** true = ít nhất một hook blocking đã chặn action này. */
  blocked: boolean;
  /** Hook đã chặn (rỗng khi không bị chặn). */
  blockingHooks: string[];
  /** Lý do chặn (gộp từ các hook đã chặn). */
  reasons: string[];
}

/**
 * Tính quyết định chặn từ kết quả chạy các hook blocking của một event:
 * runner chạy hook blocking theo thứ tự `matchBlockingHooksV20`, ghi log
 * từng cái bằng `recordHookV20Run`, rồi gọi hàm này với kết quả để biết
 * action có được chạy tiếp không. Một hook chặn là đủ chặn cả action
 * (không cần chờ hook sau — nhưng log vẫn ghi đủ để panel thấy).
 */
export function decideHookV20Block(
  results: readonly { hookId: string; outcome: HookV20RunOutcome; reason?: string }[],
): HookV20BlockDecision {
  const blocked = results.filter((r) => r.outcome === 'blocked');
  return {
    blocked: blocked.length > 0,
    blockingHooks: blocked.map((r) => r.hookId),
    reasons: blocked.map((r) => r.reason ?? `Hook "${r.hookId}" đã chặn action (không ghi lý do).`),
  };
}

// ---------------------------------------------------------------------------
// Truy vấn log + tóm tắt cho panel
// ---------------------------------------------------------------------------

export interface HookV20LogFilters {
  hookId?: string;
  event?: string;
  outcome?: HookV20RunOutcome;
  /** true = chỉ log chặn (outcome blocked). */
  blockedOnly?: boolean;
  /** Chỉ log từ thời điểm này trở đi (ms epoch). */
  sinceMs?: number;
  limit?: number;
}

/** Lọc log cho panel: mới nhất trước, giới hạn số lượng. */
export function queryHookV20Logs(store: HookV20Store, filters: HookV20LogFilters = {}): HookV20RunLog[] {
  const limit = filters.limit ?? 100;
  return store.logs
    .filter((l) => {
      if (filters.hookId && l.hookId !== filters.hookId) return false;
      if (filters.event && l.event !== filters.event) return false;
      if (filters.outcome && l.outcome !== filters.outcome) return false;
      if (filters.blockedOnly && l.outcome !== 'blocked') return false;
      if (filters.sinceMs !== undefined && l.at < filters.sinceMs) return false;
      return true;
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(0, limit));
}

/** Tóm tắt store hook để panel hiện header + cảnh báo. */
export function summarizeHookV20Store(store: HookV20Store): {
  total: number;
  enabled: number;
  blocking: number;
  errored: number;
  totalRuns: number;
  totalBlocks: number;
  recentBlocks: number;
  summary: string;
} {
  const totalRuns = store.hooks.reduce((n, h) => n + h.runCount, 0);
  const totalBlocks = store.hooks.reduce((n, h) => n + h.blockCount, 0);
  const recentBlocks = store.logs.filter((l) => l.outcome === 'blocked').length;
  const errored = store.hooks.filter((h) => h.errored).length;
  return {
    total: store.hooks.length,
    enabled: store.hooks.filter((h) => h.enabled && !h.errored).length,
    blocking: store.hooks.filter((h) => h.blocking).length,
    errored,
    totalRuns,
    totalBlocks,
    recentBlocks,
    summary:
      `Hook: ${store.hooks.filter((h) => h.enabled && !h.errored).length}/${store.hooks.length} đang bật` +
      (errored > 0 ? `, ${errored} lỗi` : '') +
      (totalBlocks > 0 ? `, đã chặn ${totalBlocks} lần` : ''),
  };
}
