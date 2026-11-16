/**
 * Composio poll scheduler v2 — lich poll theo tung connection/toolkit
 * (v1.14, Doi T4).
 *
 * Tang tren `pollScheduler.ts` (ComposioPollScheduler: interval co dinh
 * + dedupe theo id da thay) va `pollPolicyV111.ts` (adaptive interval
 * + jitter + dedupe theo cua so thoi gian). V2 KHONG viet lai hai tang
 * do — no them 3 thu con thieu cho polling chay that trong app:
 *
 * 1. Lich poll THEO TUNG CONNECTION/TOOLKIT: moi connection co
 *    schedule rieng (`baseIntervalMs` rieng theo toolkit — Gmail
 *    nhanh, Xero cham...), bat/tat rieng, loi rieng khong lam
 *    dung ca cum poller khac.
 * 2. Backoff khi loi + dedupe event + resume tu checkpoint: loi
 *    lien tiep thi gian interval theo cap so nhan (toi da
 *    `maxBackoffMs`), event trung id trong cua so thi bo, va moi
 *    schedule luu checkpoint (lan poll cuoi + cursor + seen ids)
 *    de app restart xong poll tiep tu cho cu thay vi quet lai tu dau.
 * 3. Engine chay lich: `ComposioV114PollEngine` giu nhieu schedule,
 *    `tick(nowMs, fetch)` chay nhung schedule den han, goi ham
 *    fetch do caller cung cap (trong app that la ComposioPoller,
 *    trong test la mock tra item mau) — engine KHONG goi mang.
 *
 * Tat ca ham quyet dinh deu thuan (khong doc/ghi file, khong goi
 * mang, khong dong ho thuc — `nowMs` do caller truyen vao) de test
 * duoc xac dinh. Chi co class engine giu state trong bo nho;
 * checkpoint serialize ra JSON de caller luu xuong dia tuy y.
 */

import {
  COMPOSIO_POLL_BACKOFF_MAX_MS,
  COMPOSIO_POLL_BACKOFF_MULTIPLIER,
  COMPOSIO_POLL_MAX_INTERVAL_MS,
  COMPOSIO_POLL_MIN_INTERVAL_MS,
  clampComposioPollIntervalMs,
} from './pollScheduler';

/** Interval mac dinh theo toolkit — app chat nhanh, app ke toan cham. */
export const COMPOSIO_V114_DEFAULT_INTERVAL_BY_TOOLKIT: Readonly<Record<string, number>> = {
  gmail: 5 * 60 * 1000,
  slack: 2 * 60 * 1000,
  github: 5 * 60 * 1000,
  googlecalendar: 5 * 60 * 1000,
  discord: 5 * 60 * 1000,
  jira: 10 * 60 * 1000,
  linear: 10 * 60 * 1000,
  notion: 15 * 60 * 1000,
  stripe: 15 * 60 * 1000,
  shopify: 15 * 60 * 1000,
  xero: 60 * 60 * 1000,
  chargebee: 60 * 60 * 1000,
};

/** Interval mac dinh khi toolkit khong co trong bang tren. */
export const COMPOSIO_V114_DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
/** Backoff toi da mac dinh (2 gio — bang COMPOSIO_POLL_BACKOFF_MAX_MS). */
export const COMPOSIO_V114_DEFAULT_MAX_BACKOFF_MS = COMPOSIO_POLL_BACKOFF_MAX_MS;
/** He so backoff mac dinh (nhan doi moi loi — bang poll v1). */
export const COMPOSIO_V114_DEFAULT_BACKOFF_MULTIPLIER = COMPOSIO_POLL_BACKOFF_MULTIPLIER;
/** Cua so dedupe mac dinh: 24 gio. */
export const COMPOSIO_V114_DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Giu toi da 1000 id da thay moi schedule. */
export const COMPOSIO_V114_DEFAULT_MAX_SEEN_IDS = 1000;
/** Jitter mac dinh ±10% (nhu pollPolicyV111). */
export const COMPOSIO_V114_DEFAULT_JITTER_FRACTION = 0.1;
/** Phien ban dinh dang checkpoint (de migrate sau nay). */
export const COMPOSIO_V114_CHECKPOINT_VERSION = 1;

/** Interval mac dinh cho mot toolkit (co bang rieng, fallback 10 phut). */
export function defaultComposioV114IntervalMs(toolkit: string): number {
  return COMPOSIO_V114_DEFAULT_INTERVAL_BY_TOOLKIT[toolkit] ?? COMPOSIO_V114_DEFAULT_INTERVAL_MS;
}

/** Mot lich poll cho mot connection (connection = 1 tai khoan cua 1 toolkit). */
export interface ComposioV114PollSchedule {
  /** Id lich — duy nhat trong engine, vd 'poll:gmail:ca_123'. */
  id: string;
  /** Id connection Composio (khong chua secret, chi la id). */
  connectionId: string;
  /** Slug toolkit, vd 'gmail'. */
  toolkit: string;
  /** Slug trigger dang poll, vd 'GMAIL_NEW_GMAIL_MESSAGE'. */
  triggerSlug: string;
  /** Interval co so (ms) khi khong loi. */
  baseIntervalMs: number;
  /** Interval hien tai (ms) — thay doi theo ket qua poll. */
  currentIntervalMs: number;
  /** Interval nho nhat / lon nhat cho phep (ms). */
  minIntervalMs: number;
  maxIntervalMs: number;
  /** He so backoff khi loi lien tiep (>= 1). */
  backoffMultiplier: number;
  /** Backoff toi da (ms). */
  maxBackoffMs: number;
  /** So loi lien tiep (reset ve 0 khi poll thanh cong). */
  consecutiveErrors: number;
  /** Lan poll ke tiep (epoch ms). */
  nextPollAtMs: number;
  /** Lan poll gan nhat (epoch ms) — null neu chua poll lan nao. */
  lastPollAtMs: number | null;
  /** Cursor phan trang/lan cuoi tra ve (neu co) — de resume. */
  lastCursor: string | null;
  /** So item moi nhan duoc tu lan poll gan nhat. */
  lastNewItems: number;
  /** So item trung (da thay) da bo o lan poll gan nhat. */
  lastDuplicates: number;
  /** Ti le jitter 0..1 (0 = tat). */
  jitterFraction: number;
  /** false = tam dung lich (khong poll nua nhung giu checkpoint). */
  enabled: boolean;
}

/** Input tao schedule — chi can id/connection/toolkit/trigger + thoi gian bat dau. */
export interface ComposioV114CreateScheduleInput {
  id: string;
  connectionId: string;
  toolkit: string;
  triggerSlug: string;
  /** Epoch ms bat dau poll (mac dinh: poll ngay). */
  startAtMs?: number;
  /** Ghi de interval co so (mac dinh: theo bang toolkit). */
  baseIntervalMs?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
  jitterFraction?: number;
  enabled?: boolean;
}

/** Kiem tra mot schedule co hop le khong (throw Error mo ta loi cu the). */
export function validateComposioV114Schedule(s: ComposioV114PollSchedule): void {
  if (typeof s.id !== 'string' || s.id.trim() === '') throw new Error('schedule.id must be a non-empty string');
  if (typeof s.connectionId !== 'string' || s.connectionId.trim() === '') {
    throw new Error('schedule.connectionId must be a non-empty string');
  }
  if (typeof s.toolkit !== 'string' || s.toolkit.trim() === '') {
    throw new Error('schedule.toolkit must be a non-empty string');
  }
  if (typeof s.triggerSlug !== 'string' || !/^[A-Z][A-Z0-9_]{2,}$/.test(s.triggerSlug)) {
    throw new Error(`schedule.triggerSlug must match ^[A-Z][A-Z0-9_]{2,}$ (got ${s.triggerSlug})`);
  }
  if (!Number.isFinite(s.baseIntervalMs) || s.baseIntervalMs <= 0) {
    throw new Error('schedule.baseIntervalMs must be a positive number');
  }
  if (s.minIntervalMs < COMPOSIO_POLL_MIN_INTERVAL_MS) {
    throw new Error(`schedule.minIntervalMs must be >= ${COMPOSIO_POLL_MIN_INTERVAL_MS}`);
  }
  if (s.maxIntervalMs > COMPOSIO_POLL_MAX_INTERVAL_MS) {
    throw new Error(`schedule.maxIntervalMs must be <= ${COMPOSIO_POLL_MAX_INTERVAL_MS}`);
  }
  if (s.minIntervalMs > s.maxIntervalMs) throw new Error('schedule.minIntervalMs must be <= maxIntervalMs');
  if (s.baseIntervalMs < s.minIntervalMs || s.baseIntervalMs > s.maxIntervalMs) {
    throw new Error('schedule.baseIntervalMs must be within [minIntervalMs, maxIntervalMs]');
  }
  if (s.currentIntervalMs < s.minIntervalMs || s.currentIntervalMs > s.maxIntervalMs) {
    throw new Error('schedule.currentIntervalMs must be within [minIntervalMs, maxIntervalMs]');
  }
  if (!Number.isFinite(s.backoffMultiplier) || s.backoffMultiplier < 1) {
    throw new Error('schedule.backoffMultiplier must be >= 1');
  }
  if (!Number.isFinite(s.maxBackoffMs) || s.maxBackoffMs <= 0) {
    throw new Error('schedule.maxBackoffMs must be a positive number');
  }
  if (!Number.isInteger(s.consecutiveErrors) || s.consecutiveErrors < 0) {
    throw new Error('schedule.consecutiveErrors must be a non-negative integer');
  }
  if (!Number.isFinite(s.nextPollAtMs) || s.nextPollAtMs < 0) {
    throw new Error('schedule.nextPollAtMs must be a non-negative number');
  }
  if (s.lastPollAtMs !== null && (!Number.isFinite(s.lastPollAtMs) || s.lastPollAtMs < 0)) {
    throw new Error('schedule.lastPollAtMs must be null or a non-negative number');
  }
  if (s.jitterFraction < 0 || s.jitterFraction > 1) {
    throw new Error('schedule.jitterFraction must be within [0, 1]');
  }
  if (!Number.isInteger(s.lastNewItems) || s.lastNewItems < 0) {
    throw new Error('schedule.lastNewItems must be a non-negative integer');
  }
  if (!Number.isInteger(s.lastDuplicates) || s.lastDuplicates < 0) {
    throw new Error('schedule.lastDuplicates must be a non-negative integer');
  }
}

/** Tao schedule moi tu input toi thieu (validate truoc khi tra). */
export function createComposioV114Schedule(input: ComposioV114CreateScheduleInput): ComposioV114PollSchedule {
  const nowMs = typeof input.startAtMs === 'number' ? input.startAtMs : Date.now();
  const base = input.baseIntervalMs ?? defaultComposioV114IntervalMs(input.toolkit);
  const min = input.minIntervalMs ?? COMPOSIO_POLL_MIN_INTERVAL_MS;
  const max = input.maxIntervalMs ?? COMPOSIO_POLL_MAX_INTERVAL_MS;
  const schedule: ComposioV114PollSchedule = {
    id: input.id,
    connectionId: input.connectionId,
    toolkit: input.toolkit,
    triggerSlug: input.triggerSlug,
    baseIntervalMs: clampComposioPollIntervalMs(base),
    currentIntervalMs: clampComposioPollIntervalMs(base),
    minIntervalMs: min,
    maxIntervalMs: max,
    backoffMultiplier: input.backoffMultiplier ?? COMPOSIO_V114_DEFAULT_BACKOFF_MULTIPLIER,
    maxBackoffMs: input.maxBackoffMs ?? COMPOSIO_V114_DEFAULT_MAX_BACKOFF_MS,
    consecutiveErrors: 0,
    nextPollAtMs: nowMs,
    lastPollAtMs: null,
    lastCursor: null,
    lastNewItems: 0,
    lastDuplicates: 0,
    jitterFraction: input.jitterFraction ?? COMPOSIO_V114_DEFAULT_JITTER_FRACTION,
    enabled: input.enabled ?? true,
  };
  validateComposioV114Schedule(schedule);
  return schedule;
}

/**
 * Cong jitter ±fraction vao interval (random co kiem soat — caller
 * truyen `random` de test xac dinh; mac dinh Math.random).
 */
export function applyComposioV114Jitter(
  intervalMs: number,
  jitterFraction: number,
  random: () => number = Math.random,
): number {
  if (jitterFraction <= 0) return intervalMs;
  const delta = intervalMs * jitterFraction * (random() * 2 - 1);
  return Math.max(1000, Math.round(intervalMs + delta));
}

/** Delay backoff sau `n` loi lien tiep: base * multiplier^n, cap o maxBackoffMs. */
export function composioV114BackoffDelayMs(
  baseIntervalMs: number,
  consecutiveErrors: number,
  backoffMultiplier: number,
  maxBackoffMs: number,
): number {
  if (consecutiveErrors <= 0) return baseIntervalMs;
  const delay = baseIntervalMs * Math.pow(backoffMultiplier, consecutiveErrors);
  return Math.min(Math.max(delay, baseIntervalMs), maxBackoffMs);
}

/**
 * Cap nhat schedule SAU POLL THANH CONG: reset loi, interval tro ve
 * base (poll trúng thi giu base — adaptive rut/gian theo hit/miss
 * thuoc pollPolicyV111, tang nay chi lo backoff khi loi), ghi
 * cursor + so item moi/trung, hen lan sau.
 */
export function nextComposioV114PollAfterSuccess(
  schedule: ComposioV114PollSchedule,
  nowMs: number,
  outcome: { newItems: number; duplicates: number; cursor?: string | null },
  random: () => number = Math.random,
): ComposioV114PollSchedule {
  const next: ComposioV114PollSchedule = {
    ...schedule,
    consecutiveErrors: 0,
    currentIntervalMs: schedule.baseIntervalMs,
    lastPollAtMs: nowMs,
    lastCursor: outcome.cursor ?? schedule.lastCursor,
    lastNewItems: outcome.newItems,
    lastDuplicates: outcome.duplicates,
    nextPollAtMs:
      nowMs + applyComposioV114Jitter(schedule.baseIntervalMs, schedule.jitterFraction, random),
  };
  validateComposioV114Schedule(next);
  return next;
}

/**
 * Cap nhat schedule SAU POLL LOI: tang loi lien tiep, gian interval
 * theo backoff (cap o maxBackoffMs), hen lan sau muon hon. Khong
 * doi lastPollAtMs/lastCursor — checkpoint cu van giu de resume.
 */
export function nextComposioV114PollAfterError(
  schedule: ComposioV114PollSchedule,
  nowMs: number,
  random: () => number = Math.random,
): ComposioV114PollSchedule {
  const consecutiveErrors = schedule.consecutiveErrors + 1;
  const delay = composioV114BackoffDelayMs(
    schedule.baseIntervalMs,
    consecutiveErrors,
    schedule.backoffMultiplier,
    schedule.maxBackoffMs,
  );
  const currentIntervalMs = clampComposioPollIntervalMs(Math.min(delay, schedule.maxIntervalMs));
  const next: ComposioV114PollSchedule = {
    ...schedule,
    consecutiveErrors,
    currentIntervalMs,
    nextPollAtMs: nowMs + applyComposioV114Jitter(currentIntervalMs, schedule.jitterFraction, random),
  };
  validateComposioV114Schedule(next);
  return next;
}

/** Schedule co den han poll tai `nowMs` khong (bat + da toi gio). */
export function isComposioV114ScheduleDue(schedule: ComposioV114PollSchedule, nowMs: number): boolean {
  return schedule.enabled && nowMs >= schedule.nextPollAtMs;
}

/** So ms con lai toi lan poll ke (0 neu da den han, -1 neu tat). */
export function composioV114MsUntilNextPoll(schedule: ComposioV114PollSchedule, nowMs: number): number {
  if (!schedule.enabled) return -1;
  return Math.max(0, schedule.nextPollAtMs - nowMs);
}

// ---------------------------------------------------------------------------
// Dedupe — tap id da thay theo tung schedule
// ---------------------------------------------------------------------------

/** Mot id da thay kem thoi diem thay (de prune theo cua so). */
export interface ComposioV114SeenEntry {
  id: string;
  atMs: number;
}

/** true khi id da thay trong cua so dedupe (tinh tu `nowMs`). */
export function isComposioV114Duplicate(
  seen: readonly ComposioV114SeenEntry[],
  id: string,
  nowMs: number,
  dedupeWindowMs: number = COMPOSIO_V114_DEFAULT_DEDUPE_WINDOW_MS,
): boolean {
  return seen.some((e) => e.id === id && nowMs - e.atMs <= dedupeWindowMs);
}

/** Them id moi vao tap da thay (bo qua id da co), cap o maxSeenIds (giu moi nhat). */
export function recordComposioV114SeenIds(
  seen: readonly ComposioV114SeenEntry[],
  ids: readonly string[],
  nowMs: number,
  maxSeenIds: number = COMPOSIO_V114_DEFAULT_MAX_SEEN_IDS,
): ComposioV114SeenEntry[] {
  const known = new Set(seen.map((e) => e.id));
  const next = [...seen];
  for (const id of ids) {
    if (!known.has(id)) {
      known.add(id);
      next.push({ id, atMs: nowMs });
    }
  }
  return next.length > maxSeenIds ? next.slice(next.length - maxSeenIds) : next;
}

/** Bo id qua han cua so dedupe (tinh tu `nowMs`). */
export function pruneComposioV114SeenIds(
  seen: readonly ComposioV114SeenEntry[],
  nowMs: number,
  dedupeWindowMs: number = COMPOSIO_V114_DEFAULT_DEDUPE_WINDOW_MS,
): ComposioV114SeenEntry[] {
  return seen.filter((e) => nowMs - e.atMs <= dedupeWindowMs);
}

/** Mot item poll (id bat buoc, cac field khac tuy toolkit). */
export interface ComposioV114PollItem {
  id: string;
  [key: string]: unknown;
}

/** Tach item moi khoi item trung theo tap da thay. */
export function filterComposioV114NewItems(
  items: readonly ComposioV114PollItem[],
  seen: readonly ComposioV114SeenEntry[],
  nowMs: number,
  dedupeWindowMs: number = COMPOSIO_V114_DEFAULT_DEDUPE_WINDOW_MS,
): { fresh: ComposioV114PollItem[]; duplicates: ComposioV114PollItem[] } {
  const fresh: ComposioV114PollItem[] = [];
  const duplicates: ComposioV114PollItem[] = [];
  for (const item of items) {
    if (isComposioV114Duplicate(seen, item.id, nowMs, dedupeWindowMs)) duplicates.push(item);
    else fresh.push(item);
  }
  return { fresh, duplicates };
}

// ---------------------------------------------------------------------------
// Checkpoint — luu/khoi phuc lich poll qua restart
// ---------------------------------------------------------------------------

/** Checkpoint cua mot schedule: du de resume sau restart ma khong quet lai tu dau. */
export interface ComposioV114Checkpoint {
  version: number;
  scheduleId: string;
  connectionId: string;
  toolkit: string;
  triggerSlug: string;
  lastPollAtMs: number | null;
  lastCursor: string | null;
  nextPollAtMs: number;
  consecutiveErrors: number;
  currentIntervalMs: number;
  seen: ComposioV114SeenEntry[];
  savedAtMs: number;
}

/** Lay checkpoint tu mot schedule + tap seen hien tai. */
export function checkpointComposioV114Schedule(
  schedule: ComposioV114PollSchedule,
  seen: readonly ComposioV114SeenEntry[],
  nowMs: number,
): ComposioV114Checkpoint {
  return {
    version: COMPOSIO_V114_CHECKPOINT_VERSION,
    scheduleId: schedule.id,
    connectionId: schedule.connectionId,
    toolkit: schedule.toolkit,
    triggerSlug: schedule.triggerSlug,
    lastPollAtMs: schedule.lastPollAtMs,
    lastCursor: schedule.lastCursor,
    nextPollAtMs: schedule.nextPollAtMs,
    consecutiveErrors: schedule.consecutiveErrors,
    currentIntervalMs: schedule.currentIntervalMs,
    seen: [...seen],
    savedAtMs: nowMs,
  };
}

/** Kiem tra checkpoint co hop le khong (throw neu sai dinh dang). */
export function validateComposioV114Checkpoint(cp: ComposioV114Checkpoint): void {
  if (cp.version !== COMPOSIO_V114_CHECKPOINT_VERSION) {
    throw new Error(`unsupported checkpoint version: ${cp.version}`);
  }
  if (typeof cp.scheduleId !== 'string' || cp.scheduleId.trim() === '') {
    throw new Error('checkpoint.scheduleId must be a non-empty string');
  }
  if (typeof cp.connectionId !== 'string' || cp.connectionId.trim() === '') {
    throw new Error('checkpoint.connectionId must be a non-empty string');
  }
  if (typeof cp.toolkit !== 'string' || cp.toolkit.trim() === '') {
    throw new Error('checkpoint.toolkit must be a non-empty string');
  }
  if (!/^[A-Z][A-Z0-9_]{2,}$/.test(cp.triggerSlug)) {
    throw new Error(`checkpoint.triggerSlug must match ^[A-Z][A-Z0-9_]{2,}$ (got ${cp.triggerSlug})`);
  }
  if (cp.lastPollAtMs !== null && (!Number.isFinite(cp.lastPollAtMs) || cp.lastPollAtMs < 0)) {
    throw new Error('checkpoint.lastPollAtMs must be null or a non-negative number');
  }
  if (!Number.isFinite(cp.nextPollAtMs) || cp.nextPollAtMs < 0) {
    throw new Error('checkpoint.nextPollAtMs must be a non-negative number');
  }
  if (!Number.isInteger(cp.consecutiveErrors) || cp.consecutiveErrors < 0) {
    throw new Error('checkpoint.consecutiveErrors must be a non-negative integer');
  }
  if (!Array.isArray(cp.seen) || cp.seen.some((e) => typeof e.id !== 'string' || !Number.isFinite(e.atMs))) {
    throw new Error('checkpoint.seen must be an array of {id, atMs}');
  }
  if (new Set(cp.seen.map((e) => e.id)).size !== cp.seen.length) {
    throw new Error('checkpoint.seen must not contain duplicate ids');
  }
}

/** Serialize checkpoint thanh JSON (de caller luu xuong dia). */
export function serializeComposioV114Checkpoint(cp: ComposioV114Checkpoint): string {
  validateComposioV114Checkpoint(cp);
  return JSON.stringify(cp);
}

/** Parse checkpoint tu JSON (throw neu sai dinh dang). */
export function parseComposioV114Checkpoint(json: string): ComposioV114Checkpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('checkpoint JSON is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('checkpoint JSON must be an object');
  }
  const cp = parsed as ComposioV114Checkpoint;
  validateComposioV114Checkpoint(cp);
  return cp;
}

/**
 * Resume schedule tu checkpoint sau restart: khoi phuc lan poll cuoi,
 * cursor, loi lien tiep, interval hien tai. Neu lan poll ke da qua
 * (app tat lau) thi poll ngay lap tuc thay vi doi het interval.
 */
export function resumeComposioV114Schedule(
  base: ComposioV114PollSchedule,
  cp: ComposioV114Checkpoint,
  nowMs: number,
): ComposioV114PollSchedule {
  validateComposioV114Checkpoint(cp);
  if (cp.scheduleId !== base.id) {
    throw new Error(`checkpoint scheduleId ${cp.scheduleId} does not match schedule ${base.id}`);
  }
  if (cp.connectionId !== base.connectionId || cp.toolkit !== base.toolkit || cp.triggerSlug !== base.triggerSlug) {
    throw new Error('checkpoint connection/toolkit/trigger does not match schedule');
  }
  const resumed: ComposioV114PollSchedule = {
    ...base,
    lastPollAtMs: cp.lastPollAtMs,
    lastCursor: cp.lastCursor,
    consecutiveErrors: cp.consecutiveErrors,
    currentIntervalMs: clampComposioPollIntervalMs(cp.currentIntervalMs),
    nextPollAtMs: cp.nextPollAtMs <= nowMs ? nowMs : cp.nextPollAtMs,
  };
  validateComposioV114Schedule(resumed);
  return resumed;
}

/** So lan poll da lo giua checkpoint va bay gio (de UI bao catch-up). */
export function missedComposioV114Polls(cp: ComposioV114Checkpoint, nowMs: number, intervalMs: number): number {
  if (intervalMs <= 0 || nowMs <= cp.nextPollAtMs) return 0;
  return Math.floor((nowMs - cp.nextPollAtMs) / intervalMs);
}

// ---------------------------------------------------------------------------
// Engine — chay nhieu schedule, dedupe, checkpoint
// ---------------------------------------------------------------------------

/** Ham fetch do caller cung cap: tra item moi cua mot schedule (mock trong test). */
export type ComposioV114FetchFn = (
  schedule: ComposioV114PollSchedule,
  cursor: string | null,
) => Promise<{ items: ComposioV114PollItem[]; cursor?: string | null }>;

/** Ket qua mot lan poll cua engine (de UI/log doc). */
export interface ComposioV114TickResult {
  scheduleId: string;
  toolkit: string;
  ok: boolean;
  fresh: number;
  duplicates: number;
  error?: string;
  nextPollAtMs: number;
}

/** Tuy chon engine. */
export interface ComposioV114PollEngineOptions {
  dedupeWindowMs?: number;
  maxSeenIds?: number;
  /** Random cho jitter — truyen ham co dinh de test xac dinh. */
  random?: () => number;
}

/**
 * Engine poll v2: giu nhieu schedule (moi connection mot lich),
 * moi schedule co tap seen + checkpoint rieng. `tick` chi chay
 * schedule den han; loi cua mot schedule khong anh huong schedule
 * khac. Engine khong goi mang — fetch do caller cung cap.
 */
export class ComposioV114PollEngine {
  private readonly schedules = new Map<string, ComposioV114PollSchedule>();
  private readonly seen = new Map<string, ComposioV114SeenEntry[]>();
  private readonly dedupeWindowMs: number;
  private readonly maxSeenIds: number;
  private readonly random: () => number;

  constructor(options: ComposioV114PollEngineOptions = {}) {
    this.dedupeWindowMs = options.dedupeWindowMs ?? COMPOSIO_V114_DEFAULT_DEDUPE_WINDOW_MS;
    this.maxSeenIds = options.maxSeenIds ?? COMPOSIO_V114_DEFAULT_MAX_SEEN_IDS;
    this.random = options.random ?? Math.random;
  }

  /** Them schedule (throw neu trung id). */
  addSchedule(schedule: ComposioV114PollSchedule): void {
    validateComposioV114Schedule(schedule);
    if (this.schedules.has(schedule.id)) throw new Error(`duplicate poll schedule id: ${schedule.id}`);
    this.schedules.set(schedule.id, { ...schedule });
    this.seen.set(schedule.id, []);
  }

  /** Xoa schedule + tap seen cua no. */
  removeSchedule(id: string): boolean {
    this.seen.delete(id);
    return this.schedules.delete(id);
  }

  /** Lay ban sao schedule (undefined neu khong co). */
  getSchedule(id: string): ComposioV114PollSchedule | undefined {
    const s = this.schedules.get(id);
    return s ? { ...s } : undefined;
  }

  /** Tat ca schedule (ban sao). */
  listSchedules(): ComposioV114PollSchedule[] {
    return [...this.schedules.values()].map((s) => ({ ...s }));
  }

  /** Schedule den han tai `nowMs`. */
  dueSchedules(nowMs: number): ComposioV114PollSchedule[] {
    return this.listSchedules().filter((s) => isComposioV114ScheduleDue(s, nowMs));
  }

  /** Bat/tat mot schedule (giu checkpoint). */
  setEnabled(id: string, enabled: boolean): ComposioV114PollSchedule {
    const s = this.schedules.get(id);
    if (!s) throw new Error(`unknown poll schedule id: ${id}`);
    const next = { ...s, enabled };
    this.schedules.set(id, next);
    return { ...next };
  }

  /** Checkpoint cua mot schedule (de luu xuong dia). */
  checkpoint(id: string, nowMs: number): ComposioV114Checkpoint {
    const s = this.schedules.get(id);
    if (!s) throw new Error(`unknown poll schedule id: ${id}`);
    return checkpointComposioV114Schedule(s, this.seen.get(id) ?? [], nowMs);
  }

  /** Tat ca checkpoint (de luu mot lan khi app tat). */
  checkpoints(nowMs: number): ComposioV114Checkpoint[] {
    return this.listSchedules().map((s) => this.checkpoint(s.id, nowMs));
  }

  /** Khoi phuc mot schedule tu checkpoint (schedule phai ton tai truoc). */
  restore(id: string, cp: ComposioV114Checkpoint, nowMs: number): ComposioV114PollSchedule {
    const s = this.schedules.get(id);
    if (!s) throw new Error(`unknown poll schedule id: ${id}`);
    const resumed = resumeComposioV114Schedule(s, cp, nowMs);
    this.schedules.set(id, resumed);
    this.seen.set(id, pruneComposioV114SeenIds(cp.seen, nowMs, this.dedupeWindowMs));
    return { ...resumed };
  }

  /**
   * Chay tat ca schedule den han tai `nowMs`: fetch → dedupe →
   * cap nhat lich/backoff/checkpoint. Tra ket qua tung schedule;
   * loi fetch chi anh huong schedule do (ghi error, backoff).
   */
  async tick(nowMs: number, fetch: ComposioV114FetchFn): Promise<ComposioV114TickResult[]> {
    const results: ComposioV114TickResult[] = [];
    for (const schedule of this.dueSchedules(nowMs)) {
      const seenBefore = this.seen.get(schedule.id) ?? [];
      try {
        const { items, cursor } = await fetch(schedule, schedule.lastCursor);
        const { fresh, duplicates } = filterComposioV114NewItems(items, seenBefore, nowMs, this.dedupeWindowMs);
        const seenAfter = recordComposioV114SeenIds(
          pruneComposioV114SeenIds(seenBefore, nowMs, this.dedupeWindowMs),
          fresh.map((i) => i.id),
          nowMs,
          this.maxSeenIds,
        );
        this.seen.set(schedule.id, seenAfter);
        const next = nextComposioV114PollAfterSuccess(
          schedule,
          nowMs,
          { newItems: fresh.length, duplicates: duplicates.length, cursor },
          this.random,
        );
        this.schedules.set(schedule.id, next);
        results.push({
          scheduleId: schedule.id,
          toolkit: schedule.toolkit,
          ok: true,
          fresh: fresh.length,
          duplicates: duplicates.length,
          nextPollAtMs: next.nextPollAtMs,
        });
      } catch (err) {
        const next = nextComposioV114PollAfterError(schedule, nowMs, this.random);
        this.schedules.set(schedule.id, next);
        results.push({
          scheduleId: schedule.id,
          toolkit: schedule.toolkit,
          ok: false,
          fresh: 0,
          duplicates: 0,
          error: err instanceof Error ? err.message : String(err),
          nextPollAtMs: next.nextPollAtMs,
        });
      }
    }
    return results;
  }

  /** Tom tat nhanh cho UI: bao nhieu schedule, bao nhieu den han, bao nhieu loi. */
  summarize(nowMs: number): {
    total: number;
    enabled: number;
    due: number;
    erroring: number;
    nextPollAtMs: number | null;
  } {
    const all = this.listSchedules();
    const due = all.filter((s) => isComposioV114ScheduleDue(s, nowMs)).length;
    const enabled = all.filter((s) => s.enabled).length;
    const erroring = all.filter((s) => s.consecutiveErrors > 0).length;
    const upcoming = all
      .filter((s) => s.enabled)
      .map((s) => s.nextPollAtMs)
      .sort((a, b) => a - b);
    return { total: all.length, enabled, due, erroring, nextPollAtMs: upcoming[0] ?? null };
  }
}
