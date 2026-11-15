/**
 * Composio poll policy v1.11 — adaptive polling + dedupe + catch-up
 * (v1.11, Đội T6).
 *
 * Tầng trên của `pollScheduler.ts` (ComposioPollScheduler chạy poll
 * theo interval cố định + dedupe theo id đã thấy) và `pollState.ts`
 * (lưu seen ids bền). Module này KHÔNG chạy poll — nó quyết định
 * "lần sau poll khi nào, với interval bao nhiêu" sau mỗi lần poll:
 *
 * - Adaptive interval: poll trúng (có item mới) thì rút interval
 *   lại (nhân `hitFactor`, tối thiểu `minIntervalMs`) để bắt event
 *   nhanh hơn khi kênh đang sôi động; poll trượt liên tiếp thì giãn
 *   interval ra (nhân `missFactor`, tối đa `maxIntervalMs`) để đỡ
 *   tốn quota Composio khi kênh im ắng. Lỗi (fetch throw / HTTP lỗi)
 *   thì giãn mạnh hơn (nhân `errorFactor`) và ghi vào lịch sử lỗi.
 * - Jitter: mỗi interval tính ra được cộng jitter ngẫu nhiên ±10%
 *   (mặc định) để nhiều poller không cùng đập Composio một lúc —
 *   caller test có thể tắt jitter (`jitter: false`) để kết quả
 *   xác định. Jitter chỉ áp vào interval trả về, không lưu vào
 *   state (state giữ interval gốc, không jitter).
 * - Dedupe theo id + cửa sổ thời gian: `isComposioV111Duplicate`
 *   kiểm tra một id đã thấy trong cửa sổ chưa (dựa trên mảng seen
 *   `{id, atMs}`); `pruneComposioV111SeenIds` dọn id quá hạn.
 *   Khác pollState (chỉ lưu id, không lưu thời gian): ở đây seen
 *   kèm atMs nên cửa sổ dedupe là thời gian thật, không phải số
 *   lượng — id cũ hơn cửa sổ được poll lại (phù hợp trigger tạo
 *   lại sau khi user xoá).
 * - Missed-poll catch-up: `missedPollsBetween` tính số lần poll đã
 *   lỡ giữa hai mốc thời gian (vd app tắt máy qua đêm) để UI báo
 *   "đã lỡ N lần poll, lần tới sẽ quét lại từ <thời gian>" — trigger
 *   vẫn do user tạo trong Composio, open-bot chỉ nhận event; catch-up
 *   ở đây là quét lại item mới từ lần poll cuối, không tạo trigger.
 *
 * Tất cả hàm đều thuần (không đọc/ghi file, không gọi mạng) để test
 * được; state (`ComposioV111PollPolicyState`) do caller giữ — vd
 * trong ComposioPollScheduler hoặc lưu cùng pollState trên đĩa.
 */

import {
  COMPOSIO_POLL_BACKOFF_MULTIPLIER,
  COMPOSIO_POLL_MAX_INTERVAL_MS,
  COMPOSIO_POLL_MIN_INTERVAL_MS,
  clampComposioPollIntervalMs,
} from './pollScheduler';

/** Mặc định: poll trúng rút interval còn 50%. */
export const COMPOSIO_V111_DEFAULT_HIT_FACTOR = 0.5;
/** Mặc định: poll trượt giãn interval gấp 1.5 lần. */
export const COMPOSIO_V111_DEFAULT_MISS_FACTOR = 1.5;
/** Mặc định: poll lỗi giãn interval gấp 2 lần (bằng backoff multiplier). */
export const COMPOSIO_V111_DEFAULT_ERROR_FACTOR = COMPOSIO_POLL_BACKOFF_MULTIPLIER;
/** Mặc định: interval nhanh nhất 1 phút (bằng poll min). */
export const COMPOSIO_V111_DEFAULT_MIN_INTERVAL_MS = COMPOSIO_POLL_MIN_INTERVAL_MS;
/** Mặc định: interval chậm nhất 6 giờ (chặt hơn poll max 24h — poller im quá lâu thì user nên tắt). */
export const COMPOSIO_V111_DEFAULT_MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Mặc định: jitter ±10%. */
export const COMPOSIO_V111_DEFAULT_JITTER_FRACTION = 0.1;
/** Mặc định: cửa sổ dedupe 24 giờ. */
export const COMPOSIO_V111_DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Mặc định: giữ tối đa 1000 id đã thấy mỗi poller. */
export const COMPOSIO_V111_DEFAULT_MAX_SEEN_IDS = 1000;

/** Chính sách adaptive polling của một poller. */
export interface ComposioV111PollPolicy {
  /** Interval bắt đầu (ms). */
  baseIntervalMs: number;
  /** Hệ số rút khi poll trúng (0 < f < 1). */
  hitFactor: number;
  /** Hệ số giãn khi poll trượt (f > 1). */
  missFactor: number;
  /** Hệ số giãn khi poll lỗi (f > 1). */
  errorFactor: number;
  /** Interval nhỏ nhất cho phép (ms). */
  minIntervalMs: number;
  /** Interval lớn nhất cho phép (ms). */
  maxIntervalMs: number;
  /** Tỉ lệ jitter 0..1 (0 = tắt). */
  jitterFraction: number;
  /** Cửa sổ dedupe id (ms). */
  dedupeWindowMs: number;
  /** Số id đã thấy giữ tối đa. */
  maxSeenIds: number;
}

export const DEFAULT_COMPOSIO_V111_POLL_POLICY: ComposioV111PollPolicy = {
  baseIntervalMs: 15 * 60 * 1000,
  hitFactor: COMPOSIO_V111_DEFAULT_HIT_FACTOR,
  missFactor: COMPOSIO_V111_DEFAULT_MISS_FACTOR,
  errorFactor: COMPOSIO_V111_DEFAULT_ERROR_FACTOR,
  minIntervalMs: COMPOSIO_V111_DEFAULT_MIN_INTERVAL_MS,
  maxIntervalMs: COMPOSIO_V111_DEFAULT_MAX_INTERVAL_MS,
  jitterFraction: COMPOSIO_V111_DEFAULT_JITTER_FRACTION,
  dedupeWindowMs: COMPOSIO_V111_DEFAULT_DEDUPE_WINDOW_MS,
  maxSeenIds: COMPOSIO_V111_DEFAULT_MAX_SEEN_IDS,
};

/** Kết quả một lần poll (đầu vào cho policy). */
export type ComposioV111PollOutcome = 'hit' | 'miss' | 'error';

/** State adaptive của một poller (caller giữ, có thể lưu đĩa). */
export interface ComposioV111PollPolicyState {
  /** Tên poller (khớp ComposioPollEntryConfig.name). */
  name: string;
  /** Interval hiện tại (ms, chưa jitter). */
  currentIntervalMs: number;
  /** Số lần poll trượt liên tiếp. */
  consecutiveMisses: number;
  /** Số lần poll trúng liên tiếp. */
  consecutiveHits: number;
  /** Số lần poll lỗi liên tiếp. */
  consecutiveErrors: number;
  /** Tổng số lần poll đã chạy. */
  totalPolls: number;
  /** Tổng số lần poll trúng. */
  totalHits: number;
  /** Tổng số lần poll lỗi. */
  totalErrors: number;
  /** ms epoch lần poll cuối (null = chưa poll lần nào). */
  lastPollAtMs: number | null;
  /** ms epoch lần poll trúng cuối (null = chưa trúng lần nào). */
  lastHitAtMs: number | null;
  /** Lỗi gần nhất (null khi lần cuối không lỗi). */
  lastError: string | null;
  /** Id đã thấy kèm thời gian thấy (để dedupe theo cửa sổ). */
  seenIds: { id: string; atMs: number }[];
}

export function emptyComposioV111PollPolicyState(name: string, policy: Partial<ComposioV111PollPolicy> = {}): ComposioV111PollPolicyState {
  const p = { ...DEFAULT_COMPOSIO_V111_POLL_POLICY, ...policy };
  return {
    name,
    currentIntervalMs: clampComposioPollIntervalMs(p.baseIntervalMs),
    consecutiveMisses: 0,
    consecutiveHits: 0,
    consecutiveErrors: 0,
    totalPolls: 0,
    totalHits: 0,
    totalErrors: 0,
    lastPollAtMs: null,
    lastHitAtMs: null,
    lastError: null,
    seenIds: [],
  };
}

/** Validate một policy (throw khi hệ số/interval vô lý — fail-closed). */
export function validateComposioV111PollPolicy(policy: ComposioV111PollPolicy): ComposioV111PollPolicy {
  const bad = (msg: string): never => {
    throw new Error(`Invalid ComposioV111PollPolicy: ${msg}`);
  };
  if (!(policy.baseIntervalMs > 0) || !Number.isFinite(policy.baseIntervalMs)) bad('baseIntervalMs must be a positive number.');
  if (!(policy.hitFactor > 0) || policy.hitFactor >= 1) bad('hitFactor must be in (0, 1).');
  if (!(policy.missFactor > 1) || !Number.isFinite(policy.missFactor)) bad('missFactor must be > 1.');
  if (!(policy.errorFactor > 1) || !Number.isFinite(policy.errorFactor)) bad('errorFactor must be > 1.');
  if (!(policy.minIntervalMs > 0) || policy.minIntervalMs > policy.maxIntervalMs) bad('minIntervalMs must be positive and <= maxIntervalMs.');
  if (!(policy.maxIntervalMs > 0) || policy.maxIntervalMs > COMPOSIO_POLL_MAX_INTERVAL_MS) bad('maxIntervalMs must be positive and <= 24h.');
  if (policy.jitterFraction < 0 || policy.jitterFraction >= 1) bad('jitterFraction must be in [0, 1).');
  if (!(policy.dedupeWindowMs > 0)) bad('dedupeWindowMs must be positive.');
  if (!Number.isInteger(policy.maxSeenIds) || policy.maxSeenIds <= 0) bad('maxSeenIds must be a positive integer.');
  return { ...policy };
}

/** Clamp một interval vào [min, max] của policy (dùng clamp của pollScheduler làm sàn/trần tuyệt đối). */
export function clampComposioV111IntervalMs(policy: ComposioV111PollPolicy, intervalMs: number): number {
  const clamped = Math.max(policy.minIntervalMs, Math.min(policy.maxIntervalMs, Math.floor(intervalMs)));
  return clampComposioPollIntervalMs(clamped);
}

/** Áp jitter ±fraction vào interval (random 0..1 do caller inject để test xác định được). */
export function applyComposioV111Jitter(intervalMs: number, jitterFraction: number, random: () => number = Math.random): number {
  if (jitterFraction <= 0) return intervalMs;
  const delta = (random() * 2 - 1) * jitterFraction;
  return Math.max(1, Math.floor(intervalMs * (1 + delta)));
}

/**
 * Cập nhật state sau một lần poll + tính interval lần sau.
 * Trả state mới (không mutate state cũ) và `nextIntervalMs` (đã jitter
 * khi policy có jitter — tắt jitter bằng policy `jitterFraction: 0`
 * để test xác định).
 */
export function nextComposioV111Poll(
  prev: ComposioV111PollPolicyState,
  outcome: ComposioV111PollOutcome,
  policy: Partial<ComposioV111PollPolicy> = {},
  opts: { nowMs?: number; error?: string; random?: () => number } = {},
): { state: ComposioV111PollPolicyState; nextIntervalMs: number } {
  const p = validateComposioV111PollPolicy({ ...DEFAULT_COMPOSIO_V111_POLL_POLICY, ...policy });
  const nowMs = opts.nowMs ?? Date.now();
  let currentIntervalMs = prev.currentIntervalMs;
  let consecutiveMisses = prev.consecutiveMisses;
  let consecutiveHits = prev.consecutiveHits;
  let consecutiveErrors = prev.consecutiveErrors;
  let totalHits = prev.totalHits;
  let totalErrors = prev.totalErrors;
  let lastHitAtMs = prev.lastHitAtMs;
  let lastError: string | null = null;

  if (outcome === 'hit') {
    currentIntervalMs = clampComposioV111IntervalMs(p, currentIntervalMs * p.hitFactor);
    consecutiveHits += 1;
    consecutiveMisses = 0;
    consecutiveErrors = 0;
    totalHits += 1;
    lastHitAtMs = nowMs;
  } else if (outcome === 'miss') {
    currentIntervalMs = clampComposioV111IntervalMs(p, currentIntervalMs * p.missFactor);
    consecutiveMisses += 1;
    consecutiveHits = 0;
    consecutiveErrors = 0;
  } else {
    currentIntervalMs = clampComposioV111IntervalMs(p, currentIntervalMs * p.errorFactor);
    consecutiveErrors += 1;
    consecutiveHits = 0;
    consecutiveMisses = 0;
    totalErrors += 1;
    lastError = opts.error ?? 'poll error';
  }

  const state: ComposioV111PollPolicyState = {
    ...prev,
    currentIntervalMs,
    consecutiveMisses,
    consecutiveHits,
    consecutiveErrors,
    totalPolls: prev.totalPolls + 1,
    totalHits,
    totalErrors,
    lastPollAtMs: nowMs,
    lastHitAtMs,
    lastError,
  };
  const nextIntervalMs = applyComposioV111Jitter(currentIntervalMs, p.jitterFraction, opts.random ?? Math.random);
  return { state, nextIntervalMs };
}

// ---------------------------------------------------------------------------
// Dedupe theo cửa sổ thời gian
// ---------------------------------------------------------------------------

/** true khi id đã thấy trong cửa sổ (tính từ nowMs). */
export function isComposioV111Duplicate(
  state: ComposioV111PollPolicyState,
  id: string,
  policy: Partial<ComposioV111PollPolicy> = {},
  nowMs: number = Date.now(),
): boolean {
  const p = { ...DEFAULT_COMPOSIO_V111_POLL_POLICY, ...policy };
  const windowStart = nowMs - p.dedupeWindowMs;
  return state.seenIds.some((s) => s.id === id && s.atMs >= windowStart);
}

/**
 * Ghi các id mới thấy vào state (bỏ id trùng trong cửa sổ, dọn id
 * quá hạn, cắt về maxSeenIds mới nhất). Trả state mới.
 */
export function recordComposioV111SeenIds(
  prev: ComposioV111PollPolicyState,
  ids: string[],
  policy: Partial<ComposioV111PollPolicy> = {},
  nowMs: number = Date.now(),
): ComposioV111PollPolicyState {
  const p = { ...DEFAULT_COMPOSIO_V111_POLL_POLICY, ...policy };
  const windowStart = nowMs - p.dedupeWindowMs;
  const kept = prev.seenIds.filter((s) => s.atMs >= windowStart);
  const known = new Set(kept.map((s) => s.id));
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue;
    if (known.has(id)) continue;
    known.add(id);
    kept.push({ id, atMs: nowMs });
  }
  return { ...prev, seenIds: kept.slice(-p.maxSeenIds) };
}

/** Dọn id quá cửa sổ khỏi state (trả state mới). */
export function pruneComposioV111SeenIds(
  prev: ComposioV111PollPolicyState,
  policy: Partial<ComposioV111PollPolicy> = {},
  nowMs: number = Date.now(),
): ComposioV111PollPolicyState {
  const p = { ...DEFAULT_COMPOSIO_V111_POLL_POLICY, ...policy };
  const windowStart = nowMs - p.dedupeWindowMs;
  return { ...prev, seenIds: prev.seenIds.filter((s) => s.atMs >= windowStart) };
}

// ---------------------------------------------------------------------------
// Missed-poll catch-up
// ---------------------------------------------------------------------------

/** Số lần poll đã lỡ giữa lastPollAtMs và nowMs (0 khi chưa poll lần nào hoặc không lỡ). */
export function missedPollsBetween(state: ComposioV111PollPolicyState, nowMs: number = Date.now()): number {
  if (state.lastPollAtMs === null) return 0;
  const gap = nowMs - state.lastPollAtMs;
  if (gap <= state.currentIntervalMs) return 0;
  // Số khoảng interval đã trôi qua, trừ 1 (lần poll tới chưa tính là lỡ).
  return Math.max(0, Math.floor(gap / state.currentIntervalMs) - 1);
}

/** Tóm tắt catch-up cho UI: lỡ bao nhiêu lần, quét lại từ lúc nào. */
export interface ComposioV111CatchUpSummary {
  name: string;
  missedPolls: number;
  /** ms epoch lần poll cuối (null = chưa poll lần nào). */
  sinceMs: number | null;
  /** true khi có lỡ poll (UI nên hiện cảnh báo + nút poll ngay). */
  needsCatchUp: boolean;
}

export function summarizeComposioV111CatchUp(
  state: ComposioV111PollPolicyState,
  nowMs: number = Date.now(),
): ComposioV111CatchUpSummary {
  const missed = missedPollsBetween(state, nowMs);
  return {
    name: state.name,
    missedPolls: missed,
    sinceMs: state.lastPollAtMs,
    needsCatchUp: missed > 0,
  };
}

/** Tóm tắt một dòng cho UI: interval hiện tại + tỉ lệ trúng + lỗi liên tiếp. */
export function summarizeComposioV111PollState(state: ComposioV111PollPolicyState): string {
  const hitRate = state.totalPolls === 0 ? 0 : Math.round((state.totalHits / state.totalPolls) * 100);
  return (
    `${state.name}: interval ${Math.round(state.currentIntervalMs / 1000)}s, ` +
    `${state.totalPolls} polls (${hitRate}% hit, ${state.totalErrors} lỗi), ` +
    `miss liên tiếp ${state.consecutiveMisses}, lỗi liên tiếp ${state.consecutiveErrors}.`
  );
}
