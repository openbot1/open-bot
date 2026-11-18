/**
 * Composio polling v4 — polling trigger nâng cấp: interval động theo
 * độ bận, backoff khi lỗi, dedup event, resume sau restart từ
 * checkpoint (v1.17, Đội T6).
 *
 * Tầng trên của polling v3 (`fleetV13/composioPollingV13.ts` — checkpoint
 * bền trên đĩa, backoff có trần + jitter xác định, catch-up có giới
 * hạn, dedupe 2 lớp seen-id + cửa sổ thời gian, máy trạng thái
 * trigger). V3 đã bền qua restart; v4 thêm 3 thứ còn thiếu để polling
 * vừa tiết kiệm quota API vừa không bỏ sót event khi app nguồn bận:
 *
 * 1. Interval ĐỘNG theo độ bận: mỗi lần poll đo "độ bận" của trigger
 *    (số event mới / poll, độ đầy hàng đợi). Trigger bận (nhiều event
 *    mới liên tiếp) → interval co lại (tối thiểu `minIntervalMs`) để
 *    bắt kịp; trigger idle (0 event nhiều lần liên tiếp) → interval
 *    giãn ra (tối đa `maxIntervalMs`) để đỡ gọi API vô ích. Hệ số
 *    điều chỉnh có giới hạn mỗi bước (không nhảy vọt) và luôn nằm
 *    trong [min, max] — caller chỉ cần truyền `busyScore` 0..1.
 * 2. Dedup 3 lớp: seen-id ring (v3) + cửa sổ thời gian (v3) + HASH
 *    NỘI DUNG: hai event khác id nhưng cùng payload-hash trong cùng
 *    cửa sổ thì event sau bị coi là trùng (app nguồn đôi khi phát
 *    lại event với id mới). Hash tính trên payload đã chuẩn hóa
 *    (key sắp xếp) nên thứ tự key không làm lệch.
 * 3. Resume MẠNH sau restart: checkpoint v4 lưu thêm `lastEventAt`
 *    (thời điểm event mới nhất đã thấy) + `missedWindowMs` (khoảng
 *    app đã tắt, tính từ `lastPollAt` đến lúc resume) + số lần
 *    resume; `resumeComposioV14PollState` trả về danh sách trigger
 *    cần poll bù ngay (quá hạn từ lúc tắt) và trigger nào chỉ cần
 *    poll theo lịch thường — caller không phải tự suy luận.
 *
 * Engine KHÔNG gọi mạng: caller truyền hàm `fetch` (trong app thật
 * là Composio poller, trong test là mock) — `tickComposioV14Poll`
 * chạy các trigger đến hạn, trả kết quả từng trigger để caller lưu
 * checkpoint. Mọi hàm quyết định đều thuần (nhận `nowMs`).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File lưu checkpoint polling v4 trong team root. */
export const COMPOSIO_V14_POLL_FILE = 'composio-poll-v117.json';
/** Backoff tối đa mặc định: 2 giờ. */
export const COMPOSIO_V14_DEFAULT_MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;
/** Hệ số backoff mặc định: nhân đôi mỗi lỗi. */
export const COMPOSIO_V14_DEFAULT_BACKOFF_MULTIPLIER = 2;
/** Cửa sổ dedupe mặc định: 24 giờ. */
export const COMPOSIO_V14_DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Giữ tối đa 1000 id đã thấy mỗi trigger. */
export const COMPOSIO_V14_DEFAULT_MAX_SEEN_IDS = 1000;
/** Giữ tối đa 1000 hash nội dung đã thấy mỗi trigger. */
export const COMPOSIO_V14_DEFAULT_MAX_SEEN_HASHES = 1000;
/** Jitter mặc định ±10% (xác định theo trigger id — không random). */
export const COMPOSIO_V14_DEFAULT_JITTER_FRACTION = 0.1;
/** Số lỗi liên tiếp thì trigger tự pause (cần người bật lại). */
export const COMPOSIO_V14_DEFAULT_MAX_CONSECUTIVE_ERRORS = 10;
/** Số event tối đa lấy trong một lần poll catch-up. */
export const COMPOSIO_V14_DEFAULT_MAX_CATCH_UP_EVENTS = 100;
/** Số trigger tối đa trong một poll state. */
export const COMPOSIO_V14_MAX_TRIGGERS = 200;
/** Phiên bản định dạng checkpoint. */
export const COMPOSIO_V14_CHECKPOINT_VERSION = 2;
/** Interval tối thiểu khi trigger bận (mặc định 15 giây). */
export const COMPOSIO_V14_DEFAULT_MIN_INTERVAL_MS = 15 * 1000;
/** Interval tối đa khi trigger idle (mặc định 30 phút). */
export const COMPOSIO_V14_DEFAULT_MAX_INTERVAL_MS = 30 * 60 * 1000;
/** Số poll idle liên tiếp thì bắt đầu giãn interval. */
export const COMPOSIO_V14_DEFAULT_IDLE_POLLS_TO_STRETCH = 3;
/** Số poll bận liên tiếp thì bắt đầu co interval. */
export const COMPOSIO_V14_DEFAULT_BUSY_POLLS_TO_SHRINK = 2;
/** Hệ số co/giãn interval mỗi bước (x0.5 khi bận, x2 khi idle). */
export const COMPOSIO_V14_DEFAULT_INTERVAL_STEP = 2;

/** Trạng thái của một trigger polling v4. */
export type ComposioV14TriggerStatus =
  | 'idle'
  | 'polling'
  | 'backing-off'
  | 'paused'
  | 'disabled';

export const COMPOSIO_V14_TRIGGER_STATUSES: readonly ComposioV14TriggerStatus[] = [
  'idle',
  'polling',
  'backing-off',
  'paused',
  'disabled',
];

/** Một event thô trả về từ một lần poll (caller chuẩn hóa trước khi đưa vào). */
export interface ComposioV14PolledEvent {
  /** Id duy nhất của event (dùng dedupe lớp 1). */
  id: string;
  /** Epoch ms event xảy ra phía app nguồn (0 = không biết). */
  occurredAt: number;
  /** Payload thô (JSON-able, không chứa secret). */
  payload: Record<string, unknown>;
}

/** Cấu hình động của một trigger polling v4. */
export interface ComposioV14TriggerConfig {
  /** Interval cơ số (ms) khi không lỗi, không bận. */
  baseIntervalMs: number;
  /** Interval tối thiểu khi bận (mặc định 15s). */
  minIntervalMs: number;
  /** Interval tối đa khi idle (mặc định 30 phút). */
  maxIntervalMs: number;
  /** Backoff tối đa khi lỗi (mặc định 2 giờ). */
  maxBackoffMs: number;
  /** Hệ số backoff mỗi lỗi (mặc định nhân đôi). */
  backoffMultiplier: number;
  /** Cửa sổ dedupe (ms, mặc định 24 giờ). */
  dedupeWindowMs: number;
  /** Số id đã thấy giữ lại (mặc định 1000). */
  maxSeenIds: number;
  /** Số hash nội dung giữ lại (mặc định 1000). */
  maxSeenHashes: number;
  /** Số lỗi liên tiếp thì tự pause (mặc định 10). */
  maxConsecutiveErrors: number;
  /** Số event tối đa trong một lần poll catch-up (mặc định 100). */
  maxCatchUpEvents: number;
}

export function defaultComposioV14TriggerConfig(baseIntervalMs = 60 * 1000): ComposioV14TriggerConfig {
  return {
    baseIntervalMs,
    minIntervalMs: COMPOSIO_V14_DEFAULT_MIN_INTERVAL_MS,
    maxIntervalMs: COMPOSIO_V14_DEFAULT_MAX_INTERVAL_MS,
    maxBackoffMs: COMPOSIO_V14_DEFAULT_MAX_BACKOFF_MS,
    backoffMultiplier: COMPOSIO_V14_DEFAULT_BACKOFF_MULTIPLIER,
    dedupeWindowMs: COMPOSIO_V14_DEFAULT_DEDUPE_WINDOW_MS,
    maxSeenIds: COMPOSIO_V14_DEFAULT_MAX_SEEN_IDS,
    maxSeenHashes: COMPOSIO_V14_DEFAULT_MAX_SEEN_HASHES,
    maxConsecutiveErrors: COMPOSIO_V14_DEFAULT_MAX_CONSECUTIVE_ERRORS,
    maxCatchUpEvents: COMPOSIO_V14_DEFAULT_MAX_CATCH_UP_EVENTS,
  };
}

/** Checkpoint bền vững của một trigger (lưu file). */
export interface ComposioV14TriggerCheckpoint {
  triggerId: string;
  connectionId: string;
  toolkit: string;
  triggerSlug: string;
  status: ComposioV14TriggerStatus;
  config: ComposioV14TriggerConfig;
  /** Interval hiện tại (ms) — thay đổi theo độ bận + backoff. */
  currentIntervalMs: number;
  /** Epoch ms lần poll thành công gần nhất (null = chưa poll lần nào). */
  lastPollAt: number | null;
  /** Epoch ms lần poll kế tiếp (do engine tính). */
  nextPollAt: number;
  /** Cursor phía app nguồn (opaque, caller tự quản lý ý nghĩa). */
  cursor: string;
  /** Epoch ms event mới nhất đã thấy (null = chưa thấy event nào). */
  lastEventAt: number | null;
  /** Số lỗi liên tiếp hiện tại. */
  consecutiveErrors: number;
  /** Số poll idle liên tiếp (0 event mới). */
  idlePolls: number;
  /** Số poll bận liên tiếp (>= 1 event mới). */
  busyPolls: number;
  /** Id event đã thấy (ring buffer, mới nhất ở cuối). */
  seenIds: string[];
  /** Hash nội dung event đã thấy (ring buffer, mới nhất ở cuối). */
  seenHashes: string[];
  /** Tổng số event mới đã nhận (từ lúc tạo trigger). */
  totalNewEvents: number;
  /** Tổng số event trùng đã bỏ (dedupe). */
  totalDuplicates: number;
  /** Tổng số lần poll (thành công + lỗi). */
  totalPolls: number;
  /** Số lần resume sau restart. */
  resumeCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Toàn bộ state polling v4 (lưu file). */
export interface ComposioV14PollState {
  version: 2;
  triggers: ComposioV14TriggerCheckpoint[];
  updatedAt: number;
}

export function createComposioV14PollState(now = Date.now()): ComposioV14PollState {
  return { version: 2, triggers: [], updatedAt: now };
}

/** Jitter xác định ±fraction theo trigger id (không random, test được). */
export function composioV14Jitter(triggerId: string, fraction = COMPOSIO_V14_DEFAULT_JITTER_FRACTION): number {
  let h = 0;
  for (let i = 0; i < triggerId.length; i++) {
    h = (h * 31 + triggerId.charCodeAt(i)) >>> 0;
  }
  const unit = (h % 1000) / 1000; // 0..0.999
  return (unit * 2 - 1) * fraction; // -fraction..+fraction
}

/** Chuẩn hóa payload thành chuỗi ổn định (key sắp xếp đệ quy) để hash. */
export function stableStringifyComposioV14(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringifyComposioV14(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringifyComposioV14(obj[k])}`).join(',')}}`;
}

/** Hash nội dung của một event (lớp dedupe 3: cùng payload → trùng). */
export function hashComposioV14EventPayload(payload: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(stableStringifyComposioV14(payload)).digest('hex');
}

// ---------------------------------------------------------------------------
// Interval động theo độ bận + backoff
// ---------------------------------------------------------------------------

/**
 * Tính interval kế tiếp theo độ bận của lần poll vừa rồi.
 * - Bận (busyScore >= 0.7, tức nhiều event mới / hàng đợi đầy):
 *   co interval 1 bước (chia `step`, tối thiểu minIntervalMs).
 * - Idle (busyScore <= 0.1, tức 0 event mới): giãn interval 1 bước
 *   (nhân `step`, tối đa maxIntervalMs) — chỉ sau
 *   `idlePollsToStretch` poll idle liên tiếp, tránh giãn vì 1 lần trống.
 * - Giữa hai mức: quay dần về baseIntervalMs (1 bước mỗi poll).
 * `busyPolls`/`idlePolls` là số poll liên tiếp cùng trạng thái.
 */
export function computeComposioV14DynamicInterval(
  config: ComposioV14TriggerConfig,
  currentIntervalMs: number,
  busyScore: number,
  idlePolls: number,
  busyPolls: number,
  idlePollsToStretch = COMPOSIO_V14_DEFAULT_IDLE_POLLS_TO_STRETCH,
  busyPollsToShrink = COMPOSIO_V14_DEFAULT_BUSY_POLLS_TO_SHRINK,
  step = COMPOSIO_V14_DEFAULT_INTERVAL_STEP,
): number {
  const clampedBusy = Math.min(1, Math.max(0, busyScore));
  const min = Math.max(1000, config.minIntervalMs);
  const max = Math.max(min, config.maxIntervalMs);
  const base = Math.min(max, Math.max(min, config.baseIntervalMs));
  let next = currentIntervalMs;
  if (clampedBusy >= 0.7 && busyPolls >= busyPollsToShrink) {
    next = Math.max(min, Math.floor(currentIntervalMs / step));
  } else if (clampedBusy <= 0.1 && idlePolls >= idlePollsToStretch) {
    next = Math.min(max, currentIntervalMs * step);
  } else if (clampedBusy > 0.1 && clampedBusy < 0.7) {
    // Mức bận trung bình: quay dần về base (1 bước mỗi poll).
    if (currentIntervalMs > base) next = Math.max(base, Math.floor(currentIntervalMs / step));
    else if (currentIntervalMs < base) next = Math.min(base, currentIntervalMs * step);
    else next = base;
  }
  return Math.min(max, Math.max(min, next));
}

/** Interval sau một lỗi: nhân backoff, trần maxBackoffMs, cộng jitter xác định. */
export function computeComposioV14BackoffInterval(
  config: ComposioV14TriggerConfig,
  triggerId: string,
  consecutiveErrors: number,
): number {
  const raw = config.baseIntervalMs * Math.pow(config.backoffMultiplier, Math.max(0, consecutiveErrors));
  const capped = Math.min(config.maxBackoffMs, raw);
  const jittered = Math.round(capped * (1 + composioV14Jitter(triggerId)));
  return Math.max(1000, jittered);
}

// ---------------------------------------------------------------------------
// Dedupe 3 lớp
// ---------------------------------------------------------------------------

export interface ComposioV14DedupeResult {
  /** Event mới (chưa từng thấy). */
  fresh: ComposioV14PolledEvent[];
  /** Event trùng đã bỏ (kèm lý do từng event). */
  duplicates: { event: ComposioV14PolledEvent; reason: 'seen-id' | 'seen-hash' | 'too-old' }[];
  /** seenIds mới (ring buffer đã cập nhật). */
  seenIds: string[];
  /** seenHashes mới (ring buffer đã cập nhật). */
  seenHashes: string[];
}

/**
 * Dedupe một loạt event theo 3 lớp, theo thứ tự:
 * 1. seen-id: id đã thấy → trùng.
 * 2. cửa sổ thời gian: occurredAt cũ hơn now - dedupeWindowMs → trùng
 *    (event quét lại từ quá khứ; occurredAt = 0 thì bỏ qua lớp này).
 * 3. hash nội dung: cùng payload-hash đã thấy → trùng (phát lại id mới).
 * Event mới được thêm vào cả hai ring buffer (giới hạn maxSeen*).
 */
export function dedupeComposioV14Events(
  events: readonly ComposioV14PolledEvent[],
  seenIds: readonly string[],
  seenHashes: readonly string[],
  config: ComposioV14TriggerConfig,
  now = Date.now(),
): ComposioV14DedupeResult {
  const idSet = new Set(seenIds);
  const hashSet = new Set(seenHashes);
  const fresh: ComposioV14PolledEvent[] = [];
  const duplicates: ComposioV14DedupeResult['duplicates'] = [];
  const nextSeenIds = [...seenIds];
  const nextSeenHashes = [...seenHashes];
  for (const event of events) {
    if (idSet.has(event.id)) {
      duplicates.push({ event, reason: 'seen-id' });
      continue;
    }
    if (event.occurredAt > 0 && event.occurredAt < now - config.dedupeWindowMs) {
      duplicates.push({ event, reason: 'too-old' });
      continue;
    }
    const hash = hashComposioV14EventPayload(event.payload);
    if (hashSet.has(hash)) {
      duplicates.push({ event, reason: 'seen-hash' });
      continue;
    }
    fresh.push(event);
    idSet.add(event.id);
    hashSet.add(hash);
    nextSeenIds.push(event.id);
    nextSeenHashes.push(hash);
  }
  const trimmedIds = nextSeenIds.slice(-Math.max(1, config.maxSeenIds));
  const trimmedHashes = nextSeenHashes.slice(-Math.max(1, config.maxSeenHashes));
  return { fresh, duplicates, seenIds: trimmedIds, seenHashes: trimmedHashes };
}

// ---------------------------------------------------------------------------
// Quản lý trigger + tick engine
// ---------------------------------------------------------------------------

/** Tạo checkpoint trigger mới (trạng thái idle, poll ngay lần tick đầu). */
export function createComposioV14Trigger(
  input: {
    triggerId: string;
    connectionId: string;
    toolkit: string;
    triggerSlug: string;
    baseIntervalMs?: number;
    config?: Partial<ComposioV14TriggerConfig>;
  },
  now = Date.now(),
): ComposioV14TriggerCheckpoint {
  const config: ComposioV14TriggerConfig = {
    ...defaultComposioV14TriggerConfig(input.baseIntervalMs ?? 60 * 1000),
    ...(input.config ?? {}),
  };
  return {
    triggerId: input.triggerId.trim(),
    connectionId: input.connectionId.trim(),
    toolkit: input.toolkit.trim(),
    triggerSlug: input.triggerSlug.trim(),
    status: 'idle',
    config,
    currentIntervalMs: config.baseIntervalMs,
    lastPollAt: null,
    nextPollAt: now,
    cursor: '',
    lastEventAt: null,
    consecutiveErrors: 0,
    idlePolls: 0,
    busyPolls: 0,
    seenIds: [],
    seenHashes: [],
    totalNewEvents: 0,
    totalDuplicates: 0,
    totalPolls: 0,
    resumeCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Thêm trigger vào state (trùng id → lỗi). */
export function addComposioV14Trigger(
  state: ComposioV14PollState,
  trigger: ComposioV14TriggerCheckpoint,
  now = Date.now(),
): { ok: boolean; state: ComposioV14PollState; reason: string } {
  if (state.triggers.some((t) => t.triggerId === trigger.triggerId)) {
    return { ok: false, state, reason: `trigger already exists: ${trigger.triggerId}` };
  }
  if (state.triggers.length >= COMPOSIO_V14_MAX_TRIGGERS) {
    return { ok: false, state, reason: 'too many triggers' };
  }
  return { ok: true, state: { ...state, triggers: [...state.triggers, trigger], updatedAt: now }, reason: '' };
}

/** Đổi trạng thái trigger (enable/disable/pause/resume thủ công). */
export function setComposioV14TriggerStatus(
  trigger: ComposioV14TriggerCheckpoint,
  status: ComposioV14TriggerStatus,
  now = Date.now(),
): ComposioV14TriggerCheckpoint {
  const next: ComposioV14TriggerCheckpoint = { ...trigger, status, updatedAt: now };
  if (status === 'idle' && trigger.status === 'paused') {
    next.consecutiveErrors = 0;
    next.nextPollAt = now;
  }
  if (status === 'disabled') next.nextPollAt = Number.MAX_SAFE_INTEGER;
  return next;
}

/** True khi trigger đến hạn poll (idle/backing-off và đã tới nextPollAt). */
export function isComposioV14TriggerDue(trigger: ComposioV14TriggerCheckpoint, now = Date.now()): boolean {
  return (trigger.status === 'idle' || trigger.status === 'backing-off') && trigger.nextPollAt <= now;
}

/** Kết quả một lần poll của một trigger (do engine trả về). */
export interface ComposioV14TickResult {
  triggerId: string;
  ok: boolean;
  /** Event mới sau dedupe (đã cắt catch-up). */
  freshEvents: ComposioV14PolledEvent[];
  duplicateCount: number;
  /** Lý do lỗi ('' khi ok). */
  error: string;
  /** Checkpoint mới của trigger. */
  checkpoint: ComposioV14TriggerCheckpoint;
  /** True khi lần poll này là catch-up sau thời gian dài không poll. */
  catchUp: boolean;
}

/** Hàm fetch do caller cung cấp: trả event thô + cursor mới (mock trong test). */
export type ComposioV14FetchFn = (trigger: ComposioV14TriggerCheckpoint) => Promise<{
  events: ComposioV14PolledEvent[];
  cursor: string;
}>;

/**
 * Chạy một lần poll cho một trigger: fetch → dedupe → cập nhật
 * interval động / backoff / checkpoint. Lỗi fetch → backoff, đủ lỗi
 * liên tiếp → paused (cần người bật lại).
 */
export async function pollComposioV14Trigger(
  trigger: ComposioV14TriggerCheckpoint,
  fetchFn: ComposioV14FetchFn,
  now = Date.now(),
): Promise<ComposioV14TickResult> {
  const base: Omit<ComposioV14TickResult, 'checkpoint'> = {
    triggerId: trigger.triggerId,
    ok: false,
    freshEvents: [],
    duplicateCount: 0,
    error: '',
    catchUp: false,
  };
  let fetched: { events: ComposioV14PolledEvent[]; cursor: string };
  try {
    fetched = await fetchFn(trigger);
  } catch (err) {
    const consecutiveErrors = trigger.consecutiveErrors + 1;
    const backoffMs = computeComposioV14BackoffInterval(trigger.config, trigger.triggerId, consecutiveErrors);
    const paused = consecutiveErrors >= trigger.config.maxConsecutiveErrors;
    const checkpoint: ComposioV14TriggerCheckpoint = {
      ...trigger,
      status: paused ? 'paused' : 'backing-off',
      currentIntervalMs: backoffMs,
      nextPollAt: now + backoffMs,
      consecutiveErrors,
      totalPolls: trigger.totalPolls + 1,
      updatedAt: now,
    };
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      checkpoint,
    };
  }
  const catchUp = trigger.lastPollAt !== null && now - trigger.lastPollAt > trigger.config.maxCatchUpEvents * trigger.config.baseIntervalMs;
  // Catch-up: chỉ lấy tối đa maxCatchUpEvents event MỚI NHẤT (tránh flood).
  const sorted = [...fetched.events].sort((a, b) => (b.occurredAt || 0) - (a.occurredAt || 0));
  const limited = catchUp ? sorted.slice(0, trigger.config.maxCatchUpEvents) : fetched.events;
  const deduped = dedupeComposioV14Events(limited, trigger.seenIds, trigger.seenHashes, trigger.config, now);
  const freshCount = deduped.fresh.length;
  // Độ bận 0..1: tỉ lệ event mới trên số event tối đa của một poll.
  const busyScore = Math.min(1, freshCount / Math.max(1, trigger.config.maxCatchUpEvents));
  const idlePolls = freshCount === 0 ? trigger.idlePolls + 1 : 0;
  const busyPolls = freshCount > 0 ? trigger.busyPolls + 1 : 0;
  const nextInterval = computeComposioV14DynamicInterval(
    trigger.config,
    trigger.config.baseIntervalMs === trigger.currentIntervalMs && trigger.consecutiveErrors > 0
      ? trigger.config.baseIntervalMs
      : trigger.currentIntervalMs,
    busyScore,
    idlePolls,
    busyPolls,
  );
  const lastEventAt = deduped.fresh.reduce(
    (max, e) => Math.max(max, e.occurredAt || 0),
    trigger.lastEventAt ?? 0,
  );
  const checkpoint: ComposioV14TriggerCheckpoint = {
    ...trigger,
    status: 'idle',
    currentIntervalMs: nextInterval,
    lastPollAt: now,
    nextPollAt: now + nextInterval,
    cursor: fetched.cursor || trigger.cursor,
    lastEventAt: lastEventAt > 0 ? lastEventAt : trigger.lastEventAt,
    consecutiveErrors: 0,
    idlePolls,
    busyPolls,
    seenIds: deduped.seenIds,
    seenHashes: deduped.seenHashes,
    totalNewEvents: trigger.totalNewEvents + freshCount,
    totalDuplicates: trigger.totalDuplicates + deduped.duplicates.length,
    totalPolls: trigger.totalPolls + 1,
    updatedAt: now,
  };
  return {
    ...base,
    ok: true,
    freshEvents: deduped.fresh,
    duplicateCount: deduped.duplicates.length,
    checkpoint,
    catchUp,
  };
}

/**
 * Tick toàn bộ state: chạy các trigger đến hạn (tuần tự, theo thứ tự
 * nextPollAt), trả state mới + kết quả từng trigger.
 */
export async function tickComposioV14Poll(
  state: ComposioV14PollState,
  fetchFn: ComposioV14FetchFn,
  now = Date.now(),
): Promise<{ state: ComposioV14PollState; results: ComposioV14TickResult[] }> {
  const due = state.triggers
    .filter((t) => isComposioV14TriggerDue(t, now))
    .sort((a, b) => a.nextPollAt - b.nextPollAt);
  const results: ComposioV14TickResult[] = [];
  const byId = new Map(state.triggers.map((t) => [t.triggerId, t]));
  for (const trigger of due) {
    const result = await pollComposioV14Trigger(trigger, fetchFn, now);
    results.push(result);
    byId.set(trigger.triggerId, result.checkpoint);
  }
  const triggers = state.triggers.map((t) => byId.get(t.triggerId) ?? t);
  return { state: { ...state, triggers, updatedAt: now }, results };
}

// ---------------------------------------------------------------------------
// Resume sau restart từ checkpoint
// ---------------------------------------------------------------------------

export interface ComposioV14ResumeReport {
  /** Trigger cần poll bù ngay (đã quá hạn từ lúc app tắt). */
  overdue: { triggerId: string; missedWindowMs: number; nextPollAt: number }[];
  /** Trigger chỉ cần poll theo lịch thường. */
  onSchedule: string[];
  /** Tổng số trigger đã resume. */
  resumedCount: number;
}

/**
 * Resume sau restart: trigger nào quá hạn (nextPollAt đã qua) thì
 * xếp poll bù ngay (nextPollAt = now) và đếm resume; trigger chưa
 * quá hạn giữ nguyên lịch. Trả report để caller log / hiển thị.
 */
export function resumeComposioV14PollState(
  state: ComposioV14PollState,
  now = Date.now(),
): { state: ComposioV14PollState; report: ComposioV14ResumeReport } {
  const overdue: ComposioV14ResumeReport['overdue'] = [];
  const onSchedule: string[] = [];
  const triggers = state.triggers.map((t) => {
    if (t.status === 'disabled' || t.status === 'paused') {
      onSchedule.push(t.triggerId);
      return t;
    }
    const missedWindowMs = t.lastPollAt !== null ? Math.max(0, now - t.lastPollAt) : 0;
    if (t.nextPollAt <= now) {
      overdue.push({ triggerId: t.triggerId, missedWindowMs, nextPollAt: now });
      return { ...t, nextPollAt: now, status: 'idle' as const, resumeCount: t.resumeCount + 1, updatedAt: now };
    }
    onSchedule.push(t.triggerId);
    return { ...t, resumeCount: t.resumeCount + 1, updatedAt: now };
  });
  return {
    state: { ...state, triggers, updatedAt: now },
    report: { overdue, onSchedule, resumedCount: triggers.length },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows không có chmod unix — bỏ qua.
  }
}

export function saveComposioV14PollState(teamRoot: string, state: ComposioV14PollState): void {
  atomicWriteFile(path.join(teamRoot, COMPOSIO_V14_POLL_FILE), JSON.stringify(state, null, 2));
}

export function loadComposioV14PollState(teamRoot: string): ComposioV14PollState | null {
  const file = path.join(teamRoot, COMPOSIO_V14_POLL_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ComposioV14PollState;
    if (parsed.version !== 2 || !Array.isArray(parsed.triggers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Tóm tắt một trigger cho panel. */
export interface ComposioV14TriggerSummary {
  triggerId: string;
  toolkit: string;
  triggerSlug: string;
  status: ComposioV14TriggerStatus;
  currentIntervalMs: number;
  baseIntervalMs: number;
  consecutiveErrors: number;
  totalNewEvents: number;
  totalDuplicates: number;
  totalPolls: number;
  nextPollInMs: number;
}

export function summarizeComposioV14Trigger(
  trigger: ComposioV14TriggerCheckpoint,
  now = Date.now(),
): ComposioV14TriggerSummary {
  return {
    triggerId: trigger.triggerId,
    toolkit: trigger.toolkit,
    triggerSlug: trigger.triggerSlug,
    status: trigger.status,
    currentIntervalMs: trigger.currentIntervalMs,
    baseIntervalMs: trigger.config.baseIntervalMs,
    consecutiveErrors: trigger.consecutiveErrors,
    totalNewEvents: trigger.totalNewEvents,
    totalDuplicates: trigger.totalDuplicates,
    totalPolls: trigger.totalPolls,
    nextPollInMs: Math.max(0, trigger.nextPollAt - now),
  };
}
