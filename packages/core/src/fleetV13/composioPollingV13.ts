/**
 * Composio polling v3 — polling trigger bền: backoff, dedupe event,
 * resume sau restart (v1.16, Đội T6).
 *
 * Tầng trên của poll scheduler v2 (`composio/pollSchedulerV2.ts` —
 * lịch theo từng connection/toolkit, backoff nhân đôi, dedupe theo
 * cửa sổ, checkpoint serialize). V2 đã có engine chạy lịch trong bộ
 * nhớ; v3 thêm 3 thứ còn thiếu để polling sống sót qua restart và
 * lỗi kéo dài trong app thật:
 *
 * 1. Bền vững trên đĩa: mỗi trigger có checkpoint lưu file
 *    `<teamRoot>/composio-poll-v116.json` (atomic tmp + rename,
 *    0600): lần poll cuối, cursor, seen ids, số lỗi liên tiếp.
 *    App restart xong `resumeComposioV13PollState` khôi phục đúng
 *    chỗ cũ thay vì quét lại từ đầu (tránh event trùng lặp hàng loạt
 *    và tránh bỏ sót event trong lúc app tắt).
 * 2. Backoff có trần + jitter xác định + catch-up có giới hạn:
 *    lỗi liên tiếp nhân interval (tối đa `maxBackoffMs`); khi hết
 *    lỗi, interval quay về base ngay (không chờ hạ dần). Poll bị
 *    trễ (app tắt lâu) thì lần poll đầu chỉ lấy tối đa
 *    `maxCatchUpEvents` event mới nhất — tránh flood hàng nghìn
 *    event cũ cùng lúc; phần còn lại chờ poll sau (cursor vẫn tiến).
 * 3. Dedupe 2 lớp: seen-id ring buffer (giới hạn số id) + cửa sổ
 *    thời gian (event cũ hơn `dedupeWindowMs` tính từ lúc poll thì
 *    bỏ — event cũ thường là bản quét lại). Máy trạng thái trigger:
 *    `idle -> polling -> idle`, lỗi → `backing-off`, quá nhiều lỗi
 *    liên tiếp → `paused` (cần người bật lại), `disabled` khi user
 *    tắt trigger.
 *
 * Engine KHÔNG gọi mạng: caller truyền hàm `fetch` (trong app thật
 * là Composio poller, trong test là mock) — `tickComposioV13Poll`
 * chạy các trigger đến hạn, trả kết quả từng trigger để caller lưu
 * checkpoint. Mọi hàm quyết định đều thuần (nhận `nowMs`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** File lưu checkpoint polling v3 trong team root. */
export const COMPOSIO_V13_POLL_FILE = 'composio-poll-v116.json';
/** Backoff tối đa mặc định: 2 giờ. */
export const COMPOSIO_V13_DEFAULT_MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;
/** Hệ số backoff mặc định: nhân đôi mỗi lỗi. */
export const COMPOSIO_V13_DEFAULT_BACKOFF_MULTIPLIER = 2;
/** Cửa sổ dedupe mặc định: 24 giờ. */
export const COMPOSIO_V13_DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Giữ tối đa 1000 id đã thấy mỗi trigger. */
export const COMPOSIO_V13_DEFAULT_MAX_SEEN_IDS = 1000;
/** Jitter mặc định ±10% (xác định theo trigger id — không random). */
export const COMPOSIO_V13_DEFAULT_JITTER_FRACTION = 0.1;
/** Số lỗi liên tiếp thì trigger tự pause (cần người bật lại). */
export const COMPOSIO_V13_DEFAULT_MAX_CONSECUTIVE_ERRORS = 10;
/** Số event tối đa lấy trong một lần poll catch-up. */
export const COMPOSIO_V13_DEFAULT_MAX_CATCH_UP_EVENTS = 100;
/** Số trigger tối đa trong một poll state. */
export const COMPOSIO_V13_MAX_TRIGGERS = 200;
/** Phiên bản định dạng checkpoint. */
export const COMPOSIO_V13_CHECKPOINT_VERSION = 1;

/** Trạng thái của một trigger polling v3. */
export type ComposioV13TriggerStatus =
  | 'idle'
  | 'polling'
  | 'backing-off'
  | 'paused'
  | 'disabled';

export const COMPOSIO_V13_TRIGGER_STATUSES: readonly ComposioV13TriggerStatus[] = [
  'idle',
  'polling',
  'backing-off',
  'paused',
  'disabled',
];

/** Một event thô trả về từ một lần poll (caller chuẩn hóa trước khi đưa vào). */
export interface ComposioV13PolledEvent {
  /** Id duy nhất của event (dùng dedupe). */
  id: string;
  /** Epoch ms event xảy ra phía app nguồn (0 = không biết). */
  occurredAt: number;
  /** Payload thô (JSON-able, không chứa secret). */
  payload: Record<string, unknown>;
}

/** Checkpoint bền vững của một trigger (lưu file). */
export interface ComposioV13TriggerCheckpoint {
  triggerId: string;
  connectionId: string;
  toolkit: string;
  triggerSlug: string;
  status: ComposioV13TriggerStatus;
  /** Interval cơ số (ms) khi không lỗi. */
  baseIntervalMs: number;
  /** Interval hiện tại (ms) — thay đổi theo backoff. */
  currentIntervalMs: number;
  /** Epoch ms lần poll thành công gần nhất (null = chưa poll lần nào). */
  lastPollAt: number | null;
  /** Epoch ms lần poll kế tiếp (do engine tính). */
  nextPollAt: number;
  /** Cursor phía app nguồn (vd id event cuối / timestamp) — opaque. */
  cursor: string;
  /** Số lỗi liên tiếp (reset về 0 khi poll thành công). */
  consecutiveErrors: number;
  /** Lỗi gần nhất (thông điệp ngắn, không chứa secret). */
  lastError: string;
  /** Id event đã thấy (ring buffer, mới nhất ở cuối). */
  seenIds: string[];
  /** Tổng số event mới đã giao (để UI/quota đếm). */
  deliveredCount: number;
  /** Tổng số event trùng đã bỏ (để UI thấy dedupe có tác dụng). */
  dedupedCount: number;
  /** Tổng số lần poll (thành công + lỗi). */
  pollCount: number;
}

/** Toàn bộ poll state v3 (lưu file). */
export interface ComposioV13PollState {
  version: 1;
  triggers: ComposioV13TriggerCheckpoint[];
  updatedAt: number;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Jitter xác định ±fraction theo trigger id (ổn định giữa các lần tính). */
export function composioV13JitterMs(triggerId: string, intervalMs: number, fraction = COMPOSIO_V13_DEFAULT_JITTER_FRACTION): number {
  let hash = 0;
  for (let i = 0; i < triggerId.length; i++) {
    hash = (hash * 31 + triggerId.charCodeAt(i)) >>> 0;
  }
  const signed = (hash % 1000) / 1000 - 0.5; // [-0.5, 0.5)
  return Math.round(intervalMs * fraction * 2 * signed);
}

/**
 * Interval sau một lỗi: nhân hệ số, cộng jitter, chặn trần
 * `maxBackoffMs`. Lỗi đầu tiên từ base → base*multiplier.
 */
export function composioV13BackoffIntervalMs(
  currentIntervalMs: number,
  multiplier = COMPOSIO_V13_DEFAULT_BACKOFF_MULTIPLIER,
  maxBackoffMs = COMPOSIO_V13_DEFAULT_MAX_BACKOFF_MS,
): number {
  const next = Math.round(currentIntervalMs * multiplier);
  return Math.min(next, maxBackoffMs);
}

/** Tạo checkpoint trigger mới (chưa poll lần nào → poll ngay). */
export function createComposioV13Trigger(
  input: {
    triggerId: string;
    connectionId: string;
    toolkit: string;
    triggerSlug: string;
    baseIntervalMs: number;
  },
  now = Date.now(),
): ComposioV13TriggerCheckpoint {
  const base = Math.max(1000, Math.floor(input.baseIntervalMs));
  return {
    triggerId: input.triggerId.trim(),
    connectionId: input.connectionId.trim(),
    toolkit: input.toolkit.trim(),
    triggerSlug: input.triggerSlug.trim(),
    status: 'idle',
    baseIntervalMs: base,
    currentIntervalMs: base,
    lastPollAt: null,
    nextPollAt: now,
    cursor: '',
    consecutiveErrors: 0,
    lastError: '',
    seenIds: [],
    deliveredCount: 0,
    dedupedCount: 0,
    pollCount: 0,
  };
}

export function createComposioV13PollState(now = Date.now()): ComposioV13PollState {
  return { version: 1, triggers: [], updatedAt: now };
}

export function findComposioV13Trigger(
  state: ComposioV13PollState,
  triggerId: string,
): ComposioV13TriggerCheckpoint | null {
  if (!isNonEmptyString(triggerId)) return null;
  return state.triggers.find((t) => t.triggerId === triggerId.trim()) ?? null;
}

export type ComposioV13AddTriggerResult =
  | { ok: true; state: ComposioV13PollState; trigger: ComposioV13TriggerCheckpoint }
  | { ok: false; state: ComposioV13PollState; error: string };

/** Thêm trigger mới vào state (trùng id thì từ chối). */
export function addComposioV13Trigger(
  state: ComposioV13PollState,
  input: {
    triggerId: string;
    connectionId: string;
    toolkit: string;
    triggerSlug: string;
    baseIntervalMs: number;
  },
  now = Date.now(),
): ComposioV13AddTriggerResult {
  if (!isNonEmptyString(input?.triggerId)) return { ok: false, state, error: 'triggerId không được trống' };
  if (!isNonEmptyString(input?.connectionId)) return { ok: false, state, error: 'connectionId không được trống' };
  if (!isNonEmptyString(input?.toolkit)) return { ok: false, state, error: 'toolkit không được trống' };
  if (!isNonEmptyString(input?.triggerSlug)) return { ok: false, state, error: 'triggerSlug không được trống' };
  if (!Number.isFinite(input?.baseIntervalMs) || input.baseIntervalMs < 1000) {
    return { ok: false, state, error: 'baseIntervalMs phải >= 1000ms' };
  }
  if (state.triggers.length >= COMPOSIO_V13_MAX_TRIGGERS) {
    return { ok: false, state, error: `đã đủ ${COMPOSIO_V13_MAX_TRIGGERS} trigger tối đa` };
  }
  if (findComposioV13Trigger(state, input.triggerId)) {
    return { ok: false, state, error: `trigger "${input.triggerId}" đã tồn tại` };
  }
  const trigger = createComposioV13Trigger(input, now);
  return { ok: true, state: { ...state, triggers: [...state.triggers, trigger], updatedAt: now }, trigger };
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/** Kết quả dedupe một batch event vừa poll về. */
export interface ComposioV13DedupeResult {
  /** Event mới (chưa thấy, còn trong cửa sổ thời gian). */
  fresh: ComposioV13PolledEvent[];
  /** Event trùng id đã thấy. */
  duplicates: ComposioV13PolledEvent[];
  /** Event quá cũ (ngoài cửa sổ dedupe) — bỏ để tránh quét lại. */
  stale: ComposioV13PolledEvent[];
  /** Seen ids mới sau khi cộng event fresh (ring buffer đã cắt). */
  seenIds: string[];
}

/**
 * Dedupe batch event: trùng id trong seen → duplicate; occurredAt
 * cũ hơn `nowMs - dedupeWindowMs` (khi occurredAt > 0) → stale;
 * còn lại → fresh. Seen ids mới = seen cũ + id fresh, cắt ở
 * `maxSeenIds` (giữ mới nhất). Hàm thuần.
 */
export function dedupeComposioV13Events(
  events: readonly ComposioV13PolledEvent[],
  seenIds: readonly string[],
  nowMs: number,
  options: { dedupeWindowMs?: number; maxSeenIds?: number } = {},
): ComposioV13DedupeResult {
  const dedupeWindowMs = options.dedupeWindowMs ?? COMPOSIO_V13_DEFAULT_DEDUPE_WINDOW_MS;
  const maxSeenIds = options.maxSeenIds ?? COMPOSIO_V13_DEFAULT_MAX_SEEN_IDS;
  const seen = new Set(seenIds);
  const fresh: ComposioV13PolledEvent[] = [];
  const duplicates: ComposioV13PolledEvent[] = [];
  const stale: ComposioV13PolledEvent[] = [];
  const freshIds: string[] = [];
  for (const e of events) {
    if (!isNonEmptyString(e?.id)) {
      stale.push(e);
      continue;
    }
    if (seen.has(e.id)) {
      duplicates.push(e);
      continue;
    }
    if (e.occurredAt > 0 && e.occurredAt < nowMs - dedupeWindowMs) {
      stale.push(e);
      continue;
    }
    fresh.push(e);
    freshIds.push(e.id);
    seen.add(e.id);
  }
  const seenIdsNext = [...seenIds, ...freshIds].slice(-Math.max(1, maxSeenIds));
  return { fresh, duplicates, stale, seenIds: seenIdsNext };
}

// ---------------------------------------------------------------------------
// Áp dụng kết quả poll (thành công / lỗi) lên checkpoint
// ---------------------------------------------------------------------------

/** Kết quả một lần poll của một trigger (do caller đo, module chỉ xét). */
export interface ComposioV13PollOutcome {
  /** true = fetch thành công (kể cả khi 0 event mới). */
  ok: boolean;
  /** Event thô fetch về (chỉ có nghĩa khi ok). */
  events: ComposioV13PolledEvent[];
  /** Cursor mới phía app nguồn ('' = giữ cursor cũ). */
  cursor: string;
  /** Thông điệp lỗi ngắn (chỉ khi !ok, không chứa secret). */
  error: string;
}

export type ComposioV13ApplyPollResult =
  | { ok: true; trigger: ComposioV13TriggerCheckpoint; fresh: ComposioV13PolledEvent[]; deduped: number; stale: number }
  | { ok: false; trigger: ComposioV13TriggerCheckpoint; error: string };

/**
 * Áp dụng kết quả poll lên checkpoint (hàm thuần):
 * - Thành công: dedupe batch (cắt catch-up ở
 *   `maxCatchUpEvents` — chỉ lấy event mới nhất khi batch quá lớn),
 *   reset lỗi liên tiếp về 0, interval về base + jitter, nextPollAt
 *   = now + interval, cursor tiến khi caller đưa cursor mới.
 * - Lỗi: tăng lỗi liên tiếp, backoff interval, status
 *   `backing-off`; đủ `maxConsecutiveErrors` lỗi thì `paused`
 *   (cần người bật lại — tránh poll lỗi mãi tốn quota).
 */
export function applyComposioV13PollOutcome(
  trigger: ComposioV13TriggerCheckpoint,
  outcome: ComposioV13PollOutcome,
  nowMs: number,
  options: {
    maxBackoffMs?: number;
    backoffMultiplier?: number;
    maxConsecutiveErrors?: number;
    maxCatchUpEvents?: number;
    dedupeWindowMs?: number;
    maxSeenIds?: number;
  } = {},
): ComposioV13ApplyPollResult {
  const maxBackoffMs = options.maxBackoffMs ?? COMPOSIO_V13_DEFAULT_MAX_BACKOFF_MS;
  const backoffMultiplier = options.backoffMultiplier ?? COMPOSIO_V13_DEFAULT_BACKOFF_MULTIPLIER;
  const maxConsecutiveErrors = options.maxConsecutiveErrors ?? COMPOSIO_V13_DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const maxCatchUpEvents = options.maxCatchUpEvents ?? COMPOSIO_V13_DEFAULT_MAX_CATCH_UP_EVENTS;

  if (!outcome.ok) {
    const consecutiveErrors = trigger.consecutiveErrors + 1;
    const interval = composioV13BackoffIntervalMs(trigger.currentIntervalMs, backoffMultiplier, maxBackoffMs);
    const paused = consecutiveErrors >= maxConsecutiveErrors;
    const updated: ComposioV13TriggerCheckpoint = {
      ...trigger,
      status: paused ? 'paused' : 'backing-off',
      currentIntervalMs: interval,
      nextPollAt: nowMs + interval + composioV13JitterMs(trigger.triggerId, interval),
      consecutiveErrors,
      lastError: outcome.error.slice(0, 300),
      pollCount: trigger.pollCount + 1,
    };
    return {
      ok: false,
      trigger: updated,
      error: paused
        ? `trigger "${trigger.triggerId}" đã pause sau ${consecutiveErrors} lỗi liên tiếp: ${outcome.error.slice(0, 200)}`
        : `poll lỗi (${consecutiveErrors} lỗi liên tiếp): ${outcome.error.slice(0, 200)}`,
    };
  }

  // Catch-up có giới hạn: batch quá lớn thì chỉ lấy event mới nhất
  // (sắp xếp theo occurredAt giảm dần, event không có occurredAt
  // giữ cuối) — phần còn lại chờ poll sau, cursor vẫn tiến tới
  // event mới nhất đã lấy để không quét lại từ đầu.
  const sorted = [...outcome.events].sort((a, b) => (b.occurredAt || 0) - (a.occurredAt || 0));
  const batch = sorted.slice(0, Math.max(1, maxCatchUpEvents));
  const deduped = dedupeComposioV13Events(batch, trigger.seenIds, nowMs, options);
  const interval = trigger.baseIntervalMs;
  const updated: ComposioV13TriggerCheckpoint = {
    ...trigger,
    status: 'idle',
    currentIntervalMs: interval,
    lastPollAt: nowMs,
    nextPollAt: nowMs + interval + composioV13JitterMs(trigger.triggerId, interval),
    cursor: outcome.cursor || trigger.cursor,
    consecutiveErrors: 0,
    lastError: '',
    seenIds: deduped.seenIds,
    deliveredCount: trigger.deliveredCount + deduped.fresh.length,
    dedupedCount: trigger.dedupedCount + deduped.duplicates.length + deduped.stale.length,
    pollCount: trigger.pollCount + 1,
  };
  return {
    ok: true,
    trigger: updated,
    fresh: deduped.fresh,
    deduped: deduped.duplicates.length,
    stale: deduped.stale.length,
  };
}

/** Bật lại trigger đã pause (reset lỗi, poll ngay). */
export function resumeComposioV13Trigger(
  trigger: ComposioV13TriggerCheckpoint,
  nowMs = Date.now(),
): ComposioV13TriggerCheckpoint {
  return {
    ...trigger,
    status: 'idle',
    currentIntervalMs: trigger.baseIntervalMs,
    nextPollAt: nowMs,
    consecutiveErrors: 0,
    lastError: '',
  };
}

/** Tắt/bật trigger theo ý user (disabled không bao giờ được tick). */
export function setComposioV13TriggerEnabled(
  trigger: ComposioV13TriggerCheckpoint,
  enabled: boolean,
  nowMs = Date.now(),
): ComposioV13TriggerCheckpoint {
  if (enabled) return resumeComposioV13Trigger(trigger, nowMs);
  return { ...trigger, status: 'disabled', nextPollAt: Number.POSITIVE_INFINITY };
}

/** Trigger nào đến hạn poll lúc `nowMs` (idle/backing-off, đã tới nextPollAt). */
export function dueComposioV13Triggers(
  state: ComposioV13PollState,
  nowMs: number,
): ComposioV13TriggerCheckpoint[] {
  return state.triggers.filter(
    (t) =>
      (t.status === 'idle' || t.status === 'backing-off') && t.nextPollAt <= nowMs,
  );
}

// ---------------------------------------------------------------------------
// Resume sau restart
// ---------------------------------------------------------------------------

/** Kết quả resume poll state từ checkpoint đã lưu. */
export interface ComposioV13ResumeResult {
  state: ComposioV13PollState;
  /** Trigger nào sẽ poll ngay (đã quá hạn trong lúc app tắt). */
  overdue: string[];
  /** Trigger nào vẫn còn backoff/pause từ trước restart. */
  stillWaiting: string[];
  summary: string;
}

/**
 * Resume sau restart: trigger đang `polling` lúc app tắt (treo giữa
 * chừng) → về `idle` và poll ngay; trigger quá hạn nextPollAt →
 * poll ngay (không quét lại từ đầu — cursor + seen ids còn nguyên);
 * trigger paused/disabled giữ nguyên. Hàm thuần trên state đã load.
 */
export function resumeComposioV13PollState(
  state: ComposioV13PollState,
  nowMs = Date.now(),
): ComposioV13ResumeResult {
  const overdue: string[] = [];
  const stillWaiting: string[] = [];
  const triggers = state.triggers.map((t) => {
    if (t.status === 'polling') {
      overdue.push(t.triggerId);
      return { ...t, status: 'idle' as ComposioV13TriggerStatus, nextPollAt: nowMs };
    }
    if ((t.status === 'idle' || t.status === 'backing-off') && t.nextPollAt <= nowMs) {
      overdue.push(t.triggerId);
      return { ...t, status: 'idle' as ComposioV13TriggerStatus, nextPollAt: nowMs };
    }
    if (t.status === 'paused' || t.status === 'disabled' || t.status === 'backing-off') {
      stillWaiting.push(t.triggerId);
    }
    return t;
  });
  return {
    state: { ...state, triggers, updatedAt: nowMs },
    overdue,
    stillWaiting,
    summary:
      overdue.length === 0
        ? 'Không có trigger nào quá hạn — polling tiếp tục theo lịch cũ.'
        : `${overdue.length} trigger quá hạn trong lúc app tắt, sẽ poll ngay từ cursor đã lưu (${overdue.join(', ')}).`,
  };
}

/** Tóm tắt poll state cho UI: trigger theo status, event đã giao/bỏ. */
export interface ComposioV13PollSummary {
  triggerCount: number;
  idleCount: number;
  backingOffCount: number;
  pausedCount: number;
  disabledCount: number;
  deliveredTotal: number;
  dedupedTotal: number;
  pollTotal: number;
  summary: string;
}

export function summarizeComposioV13Poll(state: ComposioV13PollState): ComposioV13PollSummary {
  const count = (s: ComposioV13TriggerStatus): number =>
    state.triggers.filter((t) => t.status === s).length;
  const deliveredTotal = state.triggers.reduce((n, t) => n + t.deliveredCount, 0);
  const dedupedTotal = state.triggers.reduce((n, t) => n + t.dedupedCount, 0);
  const pollTotal = state.triggers.reduce((n, t) => n + t.pollCount, 0);
  return {
    triggerCount: state.triggers.length,
    idleCount: count('idle'),
    backingOffCount: count('backing-off'),
    pausedCount: count('paused'),
    disabledCount: count('disabled'),
    deliveredTotal,
    dedupedTotal,
    pollTotal,
    summary:
      state.triggers.length === 0
        ? 'Chưa có trigger polling nào.'
        : `${state.triggers.length} trigger: ${count('idle')} idle, ${count('backing-off')} đang backoff, ` +
          `${count('paused')} paused, ${count('disabled')} disabled; đã giao ${deliveredTotal} event, bỏ ${dedupedTotal} event trùng/cũ.`,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function getComposioV13PollPath(teamRoot: string): string {
  return path.join(teamRoot, COMPOSIO_V13_POLL_FILE);
}

function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Nền tảng không hỗ trợ chmod (Windows) — file vẫn dùng được.
  }
}

function isValidTrigger(v: unknown): v is ComposioV13TriggerCheckpoint {
  if (!v || typeof v !== 'object') return false;
  const t = v as Partial<ComposioV13TriggerCheckpoint>;
  return (
    typeof t.triggerId === 'string' &&
    typeof t.toolkit === 'string' &&
    typeof t.triggerSlug === 'string' &&
    COMPOSIO_V13_TRIGGER_STATUSES.includes(t.status as ComposioV13TriggerStatus) &&
    typeof t.baseIntervalMs === 'number' &&
    typeof t.nextPollAt === 'number' &&
    Array.isArray(t.seenIds)
  );
}

export function loadComposioV13PollState(teamRoot: string): ComposioV13PollState | null {
  try {
    const raw = fs.readFileSync(getComposioV13PollPath(teamRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<ComposioV13PollState>;
    if (p.version !== 1 || !Array.isArray(p.triggers)) return null;
    return {
      version: 1,
      triggers: p.triggers.filter(isValidTrigger).slice(0, COMPOSIO_V13_MAX_TRIGGERS),
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveComposioV13PollState(teamRoot: string, state: ComposioV13PollState): void {
  atomicWriteFile(getComposioV13PollPath(teamRoot), `${JSON.stringify(state, null, 2)}\n`);
}
