/**
 * Composio polling v6 — batch + cursor dedup + bounded retry
 * (v1.19, Doi T4).
 *
 * Tang tren polling v5 (pollingV118.ts) — KHONG viet lai:
 * - `ComposioV118PollConnState` van la state cua mot connection
 *   (adaptive interval V111 + burst/idle cap + seen ids + cursor).
 * - `nextComposioV118Poll` van la may tinh interval sau moi lan
 *   poll; v6 goi lai no sau khi da xu ly batch + retry xong.
 * - `filterComposioV118NewItems` van loc trung theo seen ids.
 *
 * Moi trong v6:
 * 1. Batch: mot lan poll co the tra nhieu PAGE (moi page co cursor
 *    rieng); engine gom toi da `batchSize` page thanh mot batch,
 *    dung lai khi gap page rong hoac het `maxBatchItems`. Moi page
 *    duoc dedupe rieng truoc khi gop — item trung o page sau khong
 *    lam tang `totalNewItems`.
 * 2. Cursor dedup: ngoai dedupe theo item id (v5), v6 con ghi lai
 *    tap hop cursor DA THAY (`seenCursors`, cap `maxSeenCursors`).
 *    Neu server tra lai cung cursor (phan trang lap / retry cua
 *    Composio), engine dung ngay lap tuc thay vi lap vo han —
 *    day la loi pho bien khi trigger ben Composio khong doi cursor
 *    sau page cuoi.
 * 3. Bounded retry: fetch loi thi thu lai toi da `maxRetries` lan,
 *    moi lan cach nhau `retryDelayMs * backoffMultiplier^attempt`
 *    (cap o `maxRetryDelayMs`), co jitter tuy chon. Het luot thi
 *    ghi outcome 'error' (V118 backoff) + ghi `lastError` + tang
 *    `consecutiveErrors` — khong retry vo han, khong doi quota.
 * 4. Retry budget theo ngay: moi connection co `dailyRetryBudget`
 *    (mac dinh 20); het budget thi khong retry nua trong ngay do,
 *    chi ghi error va cho lan poll ke — tranh truong hop mot
 *    connection hong dot het quota cua ca ngay.
 * 5. Batch summary: moi tick tra ve so page, so item tho, so item
 *    moi, so trung (ca trung id lan trung cursor), so lan retry,
 *    cursor cuoi — de UI + usage metering dem dung.
 *
 * Tat ca ham quyet dinh deu thuan (khong doc/ghi file, khong goi
 * mang, khong dong ho thuc — `nowMs` do caller truyen vao). Chi
 * engine giu state; fetch do caller cung cap (trong app that la
 * ComposioPoller, trong test la mock).
 */

import {
  ComposioV118PollEngine,
  composioV118PollMode,
  createComposioV118ConnState,
  filterComposioV118NewItems,
  nextComposioV118Poll,
  type ComposioV118PollConnState,
  type ComposioV118PollItem,
  type ComposioV118TickResult,
} from './pollingV118';
import type { ComposioV111PollOutcome } from './pollPolicyV111';

/** Phien ban dinh dang batch state v119 (de migrate sau nay). */
export const COMPOSIO_V119_POLL_STATE_VERSION = 1;
/** So page toi da gom trong mot batch (mac dinh). */
export const COMPOSIO_V119_DEFAULT_BATCH_SIZE = 5;
/** So item toi da gom trong mot batch (mac dinh). */
export const COMPOSIO_V119_DEFAULT_MAX_BATCH_ITEMS = 200;
/** So cursor da thay giu toi da moi connection. */
export const COMPOSIO_V119_DEFAULT_MAX_SEEN_CURSORS = 200;
/** So lan retry toi da sau mot lan fetch loi (mac dinh). */
export const COMPOSIO_V119_DEFAULT_MAX_RETRIES = 3;
/** Delay co so giua cac lan retry (ms). */
export const COMPOSIO_V119_DEFAULT_RETRY_DELAY_MS = 1000;
/** He so nhan delay moi lan retry (cap o maxRetryDelayMs). */
export const COMPOSIO_V119_DEFAULT_RETRY_BACKOFF_MULTIPLIER = 2;
/** Delay retry toi da (ms). */
export const COMPOSIO_V119_DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
/** Ngan sach retry moi ngay moi connection (mac dinh). */
export const COMPOSIO_V119_DEFAULT_DAILY_RETRY_BUDGET = 20;
/** Phan tram jitter ap len delay retry (0 = tat, de test xac dinh). */
export const COMPOSIO_V119_DEFAULT_RETRY_JITTER_FRACTION = 0.1;

/** Cau hinh batch + retry cua polling v6 (mot connection). */
export interface ComposioV119PollBatchConfig {
  /** So page toi da gom trong mot batch. */
  batchSize: number;
  /** So item toi da gom trong mot batch (dung som khi du). */
  maxBatchItems: number;
  /** So cursor da thay giu toi da. */
  maxSeenCursors: number;
  /** So lan retry toi da sau mot lan fetch loi. */
  maxRetries: number;
  /** Delay co so giua cac lan retry (ms). */
  retryDelayMs: number;
  /** He so nhan delay moi lan retry. */
  retryBackoffMultiplier: number;
  /** Delay retry toi da (ms). */
  maxRetryDelayMs: number;
  /** Ngan sach retry moi ngay cua connection nay. */
  dailyRetryBudget: number;
  /** Phan tram jitter ap len delay retry (0..0.5). */
  retryJitterFraction: number;
}

/** Cau hinh mac dinh cua polling v6. */
export const DEFAULT_COMPOSIO_V119_POLL_BATCH_CONFIG: ComposioV119PollBatchConfig = {
  batchSize: COMPOSIO_V119_DEFAULT_BATCH_SIZE,
  maxBatchItems: COMPOSIO_V119_DEFAULT_MAX_BATCH_ITEMS,
  maxSeenCursors: COMPOSIO_V119_DEFAULT_MAX_SEEN_CURSORS,
  maxRetries: COMPOSIO_V119_DEFAULT_MAX_RETRIES,
  retryDelayMs: COMPOSIO_V119_DEFAULT_RETRY_DELAY_MS,
  retryBackoffMultiplier: COMPOSIO_V119_DEFAULT_RETRY_BACKOFF_MULTIPLIER,
  maxRetryDelayMs: COMPOSIO_V119_DEFAULT_MAX_RETRY_DELAY_MS,
  dailyRetryBudget: COMPOSIO_V119_DEFAULT_DAILY_RETRY_BUDGET,
  retryJitterFraction: COMPOSIO_V119_DEFAULT_RETRY_JITTER_FRACTION,
};

/** Kiem tra + chuan hoa cau hinh batch (throw neu sai). */
export function validateComposioV119PollBatchConfig(
  raw: Partial<ComposioV119PollBatchConfig> | undefined,
): ComposioV119PollBatchConfig {
  const cfg: ComposioV119PollBatchConfig = { ...DEFAULT_COMPOSIO_V119_POLL_BATCH_CONFIG, ...(raw ?? {}) };
  const intFields: (keyof ComposioV119PollBatchConfig)[] = [
    'batchSize',
    'maxBatchItems',
    'maxSeenCursors',
    'maxRetries',
    'retryDelayMs',
    'maxRetryDelayMs',
    'dailyRetryBudget',
  ];
  for (const f of intFields) {
    if (!Number.isInteger(cfg[f]) || (cfg[f] as number) < 0) {
      throw new Error(`poll batch config ${f} must be a non-negative integer`);
    }
  }
  if (cfg.batchSize < 1) throw new Error('poll batch config batchSize must be at least 1');
  if (cfg.maxBatchItems < 1) throw new Error('poll batch config maxBatchItems must be at least 1');
  if (cfg.maxSeenCursors < 1) throw new Error('poll batch config maxSeenCursors must be at least 1');
  if (typeof cfg.retryBackoffMultiplier !== 'number' || cfg.retryBackoffMultiplier < 1) {
    throw new Error('poll batch config retryBackoffMultiplier must be a number >= 1');
  }
  if (typeof cfg.retryJitterFraction !== 'number' || cfg.retryJitterFraction < 0 || cfg.retryJitterFraction > 0.5) {
    throw new Error('poll batch config retryJitterFraction must be a number between 0 and 0.5');
  }
  if (cfg.retryDelayMs > cfg.maxRetryDelayMs) {
    throw new Error('poll batch config retryDelayMs must not exceed maxRetryDelayMs');
  }
  return cfg;
}

/**
 * Delay truoc lan retry thu `attempt` (0-based): delay co so nhan
 * he so mu, cap o max, cong jitter tuy chon. Ham thuan — `random`
 * mac dinh la Math.random, test truyen () => 0.5 de xac dinh.
 */
export function composioV119RetryDelayMs(
  attempt: number,
  config: ComposioV119PollBatchConfig,
  random: () => number = Math.random,
): number {
  if (attempt < 0) throw new Error('retry attempt must be a non-negative integer');
  const base = Math.min(
    config.retryDelayMs * Math.pow(config.retryBackoffMultiplier, attempt),
    config.maxRetryDelayMs,
  );
  if (config.retryJitterFraction <= 0) return Math.round(base);
  const jitter = base * config.retryJitterFraction * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** Mot cursor da thay + lan thay gan nhat (de prune theo thoi gian). */
export interface ComposioV119SeenCursor {
  cursor: string;
  atMs: number;
}

/** State batch + retry cua MOT connection (ghe ben canh state v118). */
export interface ComposioV119PollConnBatchState {
  /** Id connection (trung voi state v118). */
  connectionId: string;
  /** Cau hinh batch + retry cua connection nay. */
  config: ComposioV119PollBatchConfig;
  /** Cac cursor da thay (de phat hien phan trang lap). */
  seenCursors: ComposioV119SeenCursor[];
  /** So lan retry da dung trong ngay hien tai (UTC, YYYY-MM-DD). */
  retriesUsedToday: number;
  /** Ngay (UTC, YYYY-MM-DD) cua `retriesUsedToday`. */
  retriesDay: string;
  /** Tong so lan retry tich luy (moi thoi). */
  totalRetries: number;
  /** Tong so page da fetch tich luy. */
  totalPages: number;
  /** Tong so item tho da fetch tich luy. */
  totalRawItems: number;
  /** Tong so item trung cursor (phan trang lap) tich luy. */
  totalCursorDuplicates: number;
  /** Loi gan nhat (null khi lan cuoi khong loi). */
  lastError: string | null;
  /** So loi lien tiep (reset khi fetch thanh cong). */
  consecutiveErrors: number;
}

/** Ngay UTC dang YYYY-MM-DD tu epoch ms. */
export function composioV119DayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Tao state batch moi cho mot connection. */
export function createComposioV119PollConnBatchState(
  connectionId: string,
  config?: Partial<ComposioV119PollBatchConfig>,
  nowMs: number = Date.now(),
): ComposioV119PollConnBatchState {
  if (typeof connectionId !== 'string' || connectionId.trim() === '') {
    throw new Error('connectionId must be a non-empty string');
  }
  const state: ComposioV119PollConnBatchState = {
    connectionId,
    config: validateComposioV119PollBatchConfig(config),
    seenCursors: [],
    retriesUsedToday: 0,
    retriesDay: composioV119DayKey(nowMs),
    totalRetries: 0,
    totalPages: 0,
    totalRawItems: 0,
    totalCursorDuplicates: 0,
    lastError: null,
    consecutiveErrors: 0,
  };
  validateComposioV119PollConnBatchState(state);
  return state;
}

/** Kiem tra state batch co hop le khong (throw neu sai). */
export function validateComposioV119PollConnBatchState(s: ComposioV119PollConnBatchState): void {
  if (typeof s.connectionId !== 'string' || s.connectionId.trim() === '') {
    throw new Error('batch state connectionId must be a non-empty string');
  }
  validateComposioV119PollBatchConfig(s.config);
  if (!Array.isArray(s.seenCursors)) throw new Error('batch state seenCursors must be an array');
  for (const c of s.seenCursors) {
    if (typeof c.cursor !== 'string' || c.cursor === '') throw new Error('seen cursor must be a non-empty string');
    if (!Number.isFinite(c.atMs) || c.atMs < 0) throw new Error('seen cursor atMs must be a non-negative number');
  }
  if (new Set(s.seenCursors.map((c) => c.cursor)).size !== s.seenCursors.length) {
    throw new Error('batch state seenCursors must not contain duplicates');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.retriesDay)) throw new Error('batch state retriesDay must be YYYY-MM-DD');
  for (const f of ['retriesUsedToday', 'totalRetries', 'totalPages', 'totalRawItems', 'totalCursorDuplicates', 'consecutiveErrors'] as const) {
    if (!Number.isInteger(s[f]) || s[f] < 0) throw new Error(`batch state ${f} must be a non-negative integer`);
  }
  if (s.lastError !== null && typeof s.lastError !== 'string') throw new Error('batch state lastError must be a string or null');
}

/**
 * true khi cursor da thay truoc do (phan trang lap). Cursor null
 * (het page) khong bao gio coi la lap — het page la binh thuong.
 */
export function isComposioV119CursorDuplicate(
  state: ComposioV119PollConnBatchState,
  cursor: string | null | undefined,
): boolean {
  if (cursor === null || cursor === undefined || cursor === '') return false;
  return state.seenCursors.some((c) => c.cursor === cursor);
}

/** Ghi mot cursor vua thay (ham thuan): them + cat bot theo cap. */
export function recordComposioV119SeenCursor(
  prev: ComposioV119PollConnBatchState,
  cursor: string,
  nowMs: number,
): ComposioV119PollConnBatchState {
  if (typeof cursor !== 'string' || cursor === '') return prev;
  const seenCursors = [...prev.seenCursors.filter((c) => c.cursor !== cursor), { cursor, atMs: nowMs }];
  const trimmed = seenCursors.slice(-prev.config.maxSeenCursors);
  return { ...prev, seenCursors: trimmed };
}

/** Cat bot seenCursors theo cap (ham thuan). */
export function pruneComposioV119SeenCursors(
  prev: ComposioV119PollConnBatchState,
): ComposioV119PollConnBatchState {
  return { ...prev, seenCursors: prev.seenCursors.slice(-prev.config.maxSeenCursors) };
}

/**
 * Reset ngan sach retry khi sang ngay moi (UTC). Neu `nowMs` van
 * cung ngay thi tra nguyen state; sang ngay moi thi
 * `retriesUsedToday` ve 0 va `retriesDay` doi theo.
 */
export function rolloverComposioV119RetryBudget(
  prev: ComposioV119PollConnBatchState,
  nowMs: number,
): ComposioV119PollConnBatchState {
  const day = composioV119DayKey(nowMs);
  if (day === prev.retriesDay) return prev;
  return { ...prev, retriesDay: day, retriesUsedToday: 0 };
}

/** So luot retry con lai trong ngay (sau rollover). */
export function composioV119RetriesLeftToday(state: ComposioV119PollConnBatchState, nowMs: number): number {
  const rolled = rolloverComposioV119RetryBudget(state, nowMs);
  return Math.max(0, rolled.config.dailyRetryBudget - rolled.retriesUsedToday);
}

/** Co duoc retry nua khong (con luot trong ngay + chua het maxRetries cua lan nay). */
export function composioV119CanRetry(
  state: ComposioV119PollConnBatchState,
  attempt: number,
  nowMs: number,
): boolean {
  if (attempt >= state.config.maxRetries) return false;
  return composioV119RetriesLeftToday(state, nowMs) > 0;
}

// ---------------------------------------------------------------------------
// Batch fetch — gom nhieu page thanh mot batch
// ---------------------------------------------------------------------------

/** Ket qua mot page fetch (giong fetch v118, them trang thai lap cursor). */
export interface ComposioV119PollPage {
  items: ComposioV118PollItem[];
  cursor?: string | null;
}

/** Ket qua gom batch: item moi + thong ke chi tiet. */
export interface ComposioV119BatchResult {
  /** Tat ca item moi (da dedupe theo id + cursor). */
  fresh: ComposioV118PollItem[];
  /** So item tho fetch duoc (truoc dedupe). */
  rawItems: number;
  /** So item trung theo id. */
  duplicateIds: number;
  /** So item bi bo vi page lap cursor. */
  cursorDuplicates: number;
  /** So page da fetch. */
  pages: number;
  /** true khi dung vi gap cursor lap (phan trang lap). */
  stoppedOnCursorRepeat: boolean;
  /** true khi dung vi du maxBatchItems. */
  stoppedOnMaxItems: boolean;
  /** Cursor cuoi cung (de resume lan sau). */
  lastCursor: string | null;
}

/**
 * Gom nhieu page thanh mot batch (ham thuan, khong goi mang —
 * `fetchPage` do caller cung cap):
 * - Fetch page 1 tu `startCursor`, dedupe theo id cua state v118,
 *   ghi cursor vua thay vao state batch.
 * - Lap lai cho toi khi: het page (cursor null), du `batchSize`
 *   page, du `maxBatchItems` item moi, hoac gap cursor DA THAY
 *   (phan trang lap — dung ngay, item cua page lap bi bo).
 * - Tra ve batch + state batch moi (seenCursors + thong ke) — state
 *   v118 (seen ids) do caller cap nhat bang `nextComposioV118Poll`
 *   sau khi biet outcome.
 */
export async function fetchComposioV119Batch(
  pollState: ComposioV118PollConnState,
  batchState: ComposioV119PollConnBatchState,
  fetchPage: (cursor: string | null) => Promise<ComposioV119PollPage>,
  nowMs: number,
): Promise<{ result: ComposioV119BatchResult; batchState: ComposioV119PollConnBatchState }> {
  const cfg = batchState.config;
  let working = rolloverComposioV119RetryBudget(batchState, nowMs);
  const fresh: ComposioV118PollItem[] = [];
  const seenFreshIds = new Set<string>();
  let rawItems = 0;
  let duplicateIds = 0;
  let cursorDuplicates = 0;
  let pages = 0;
  let stoppedOnCursorRepeat = false;
  let stoppedOnMaxItems = false;
  let lastCursor: string | null = pollState.lastCursor;
  let cursor: string | null = pollState.lastCursor;

  for (let page = 0; page < cfg.batchSize; page += 1) {
    const { items, cursor: nextCursor } = await fetchPage(cursor);
    pages += 1;
    rawItems += items.length;
    // Cursor server tra ve da thay truoc do → phan trang lap: bo
    // page nay (khong them item cua no vao batch), dung ngay.
    // (Kiem tra o day — tren cursor TRA VE — chu khong phai tren
    // cursor sap fetch: cursor tra ve duoc ghi vao seenCursors
    // ngay sau page truoc, nen kiem tra truoc khi fetch se dung
    // luon sau page dau tien va batch khong bao gio qua 1 page.)
    if (nextCursor !== undefined && nextCursor !== null && isComposioV119CursorDuplicate(working, nextCursor)) {
      stoppedOnCursorRepeat = true;
      cursorDuplicates += 1;
      break;
    }
    const { fresh: pageFresh, duplicates } = filterComposioV118NewItems(items, pollState, nowMs);
    duplicateIds += duplicates.length;
    for (const item of pageFresh) {
      if (seenFreshIds.has(item.id)) {
        duplicateIds += 1;
        continue;
      }
      seenFreshIds.add(item.id);
      fresh.push(item);
      if (fresh.length >= cfg.maxBatchItems) {
        stoppedOnMaxItems = true;
        break;
      }
    }
    if (nextCursor !== undefined && nextCursor !== null) {
      working = recordComposioV119SeenCursor(working, nextCursor, nowMs);
      lastCursor = nextCursor;
    } else {
      lastCursor = null;
    }
    // Het page hoac du item thi dung.
    if (nextCursor === null || nextCursor === undefined || stoppedOnMaxItems) break;
    cursor = nextCursor;
  }

  working = {
    ...working,
    totalPages: working.totalPages + pages,
    totalRawItems: working.totalRawItems + rawItems,
    totalCursorDuplicates: working.totalCursorDuplicates + cursorDuplicates,
  };
  validateComposioV119PollConnBatchState(working);
  return {
    result: {
      fresh,
      rawItems,
      duplicateIds,
      cursorDuplicates,
      pages,
      stoppedOnCursorRepeat,
      stoppedOnMaxItems,
      lastCursor,
    },
    batchState: working,
  };
}

/**
 * Fetch mot batch co retry gioi han (ham thuan ve logic, bat dong bo
 * vi fetch): khi `fetchBatch` loi, thu lai toi da `maxRetries` lan
 * (chi khi con ngan sach ngay), moi lan doi
 * `composioV119RetryDelayMs(attempt)` — `sleep` do caller cung cap
 * de test khong phai doi that. Het luot thi nem loi goc.
 */
export async function fetchComposioV119BatchWithRetry<T>(
  batchState: ComposioV119PollConnBatchState,
  fetchBatch: () => Promise<T>,
  opts: {
    nowMs: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  },
): Promise<{ value: T; batchState: ComposioV119PollConnBatchState; retries: number }> {
  const nowMs = opts.nowMs;
  let working = rolloverComposioV119RetryBudget(batchState, nowMs);
  const sleep = opts.sleep ?? (async () => undefined);
  let attempt = 0;
  for (;;) {
    try {
      const value = await fetchBatch();
      working = { ...working, lastError: null, consecutiveErrors: 0 };
      return { value, batchState: working, retries: attempt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const canRetry = composioV119CanRetry(working, attempt, nowMs);
      if (!canRetry) {
        working = {
          ...working,
          lastError: message,
          consecutiveErrors: working.consecutiveErrors + 1,
        };
        throw err;
      }
      const delay = composioV119RetryDelayMs(attempt, working.config, opts.random ?? (() => 0.5));
      working = {
        ...working,
        retriesUsedToday: working.retriesUsedToday + 1,
        totalRetries: working.totalRetries + 1,
      };
      attempt += 1;
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Engine v6 — chay nhieu connection, batch + retry + persist
// ---------------------------------------------------------------------------

/** Ket qua mot lan poll cua engine v6 (mo rong ket qua v5). */
export interface ComposioV119TickResult extends ComposioV118TickResult {
  /** So page da fetch trong batch. */
  pages: number;
  /** So item tho fetch duoc. */
  rawItems: number;
  /** So item trung theo id. */
  duplicateIds: number;
  /** So page lap cursor bi bo. */
  cursorDuplicates: number;
  /** So lan retry da dung trong lan poll nay. */
  retries: number;
  /** true khi dung batch vi gap cursor lap. */
  stoppedOnCursorRepeat: boolean;
  /** Cursor cuoi cung sau batch. */
  lastCursor: string | null;
}

/** Tuy chon engine v6. */
export interface ComposioV119PollEngineOptions {
  /** Engine v5 ben duoi (giu state + store + lich adaptive). */
  v118?: ComposioV118PollEngine;
  /** Cau hinh batch mac dinh cho connection chua co config rieng. */
  defaultBatchConfig?: Partial<ComposioV119PollBatchConfig>;
  /** Ham doi that giua cac lan retry (mac dinh: khong doi — test truyen mock). */
  sleep?: (ms: number) => Promise<void>;
}

/** Ham fetch cua engine v6: tra mot PAGE (khong phai ca batch). */
export type ComposioV119FetchPageFn = (
  state: ComposioV118PollConnState,
  cursor: string | null,
) => Promise<ComposioV119PollPage>;

/**
 * Engine poll v6: boc tren engine v5. Moi connection co them state
 * batch (seenCursors + ngan sach retry). `tick` chay connection den
 * han: fetch batch (nhieu page, dedupe id + cursor) co retry gioi
 * han → cap nhat state v118 (adaptive/burst/idle/backoff) → tra
 * ket qua chi tiet tung connection. Loi cua mot connection khong
 * anh huong connection khac.
 */
export class ComposioV119PollEngine {
  private readonly v118: ComposioV118PollEngine;
  private readonly batchStates = new Map<string, ComposioV119PollConnBatchState>();
  private readonly defaultBatchConfig: Partial<ComposioV119PollBatchConfig> | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ComposioV119PollEngineOptions = {}) {
    this.v118 = options.v118 ?? new ComposioV118PollEngine();
    this.defaultBatchConfig = options.defaultBatchConfig;
    this.sleep = options.sleep ?? (async () => undefined);
  }

  /** Them connection (state v118 + state batch mac dinh). */
  addConnection(state: ComposioV118PollConnState, batchConfig?: Partial<ComposioV119PollBatchConfig>): void {
    this.v118.addConnection(state);
    this.batchStates.set(
      state.connectionId,
      createComposioV119PollConnBatchState(state.connectionId, batchConfig ?? this.defaultBatchConfig),
    );
  }

  /** Xoa connection (ca state v118 lan state batch). */
  removeConnection(connectionId: string): boolean {
    this.batchStates.delete(connectionId);
    return this.v118.removeConnection(connectionId);
  }

  /** Lay ban sao state batch (undefined neu khong co). */
  getBatchState(connectionId: string): ComposioV119PollConnBatchState | undefined {
    const s = this.batchStates.get(connectionId);
    return s ? (JSON.parse(JSON.stringify(s)) as ComposioV119PollConnBatchState) : undefined;
  }

  /** Ghi de state batch (de test + restore). */
  setBatchState(state: ComposioV119PollConnBatchState): void {
    validateComposioV119PollConnBatchState(state);
    this.batchStates.set(state.connectionId, JSON.parse(JSON.stringify(state)) as ComposioV119PollConnBatchState);
  }

  /** Lay ban sao state v118 (undefined neu khong co). */
  getConnection(connectionId: string): ComposioV118PollConnState | undefined {
    return this.v118.getConnection(connectionId);
  }

  /** Tat ca state v118 (ban sao). */
  listConnections(): ComposioV118PollConnState[] {
    return this.v118.listConnections();
  }

  /** Bat/tat mot connection (giu state). */
  setEnabled(connectionId: string, enabled: boolean): ComposioV118PollConnState {
    return this.v118.setEnabled(connectionId, enabled);
  }

  /** Khoi phuc state v118 tu store ben duoi. */
  restoreFromStore(): number {
    return this.v118.restoreFromStore();
  }

  /**
   * Chay tat ca connection den han tai `nowMs` bang fetchPage
   * (tra tung page). Moi connection: fetch batch co retry gioi
   * han → dedupe → cap nhat adaptive → tra ket qua chi tiet.
   */
  async tick(nowMs: number, fetchPage: ComposioV119FetchPageFn): Promise<ComposioV119TickResult[]> {
    const results: ComposioV119TickResult[] = [];
    for (const state of this.v118.dueConnections(nowMs)) {
      const batchState = this.batchStates.get(state.connectionId) ??
        createComposioV119PollConnBatchState(state.connectionId, this.defaultBatchConfig, nowMs);
      try {
        const { value, batchState: afterRetry, retries } = await fetchComposioV119BatchWithRetry(
          batchState,
          () => fetchComposioV119Batch(state, batchState, (cursor) => fetchPage(state, cursor), nowMs),
          { nowMs, sleep: this.sleep, random: () => 0.5 },
        );
        const { result, batchState: afterBatch } = value;
        // Gop so retry (wrapper dem) vao state batch (ham batch dem
        // page/cursor): giu seenCursors + thong ke cua batch, lay so
        // retry/ngay + loi cua wrapper.
        this.batchStates.set(state.connectionId, {
          ...afterBatch,
          retriesUsedToday: afterRetry.retriesUsedToday,
          retriesDay: afterRetry.retriesDay,
          totalRetries: afterRetry.totalRetries,
          lastError: null,
          consecutiveErrors: 0,
        });
        const outcome: ComposioV111PollOutcome = result.fresh.length > 0 ? 'hit' : 'miss';
        const next = nextComposioV118Poll(state, outcome, {
          nowMs,
          newItemIds: result.fresh.map((i) => i.id),
          cursor: result.lastCursor,
        });
        // Ghi state moi ve engine v5 (xoa + them lai de giu lich).
        this.v118.removeConnection(state.connectionId);
        this.v118.addConnection(next);
        results.push({
          connectionId: state.connectionId,
          toolkit: state.toolkit,
          ok: true,
          fresh: result.fresh.length,
          duplicates: result.duplicateIds + result.cursorDuplicates,
          mode: composioV118PollMode(next),
          nextPollAtMs: next.nextPollAtMs,
          pages: result.pages,
          rawItems: result.rawItems,
          duplicateIds: result.duplicateIds,
          cursorDuplicates: result.cursorDuplicates,
          retries,
          stoppedOnCursorRepeat: result.stoppedOnCursorRepeat,
          lastCursor: result.lastCursor,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failedBatch = {
          ...batchState,
          lastError: message,
          consecutiveErrors: batchState.consecutiveErrors + 1,
        };
        this.batchStates.set(state.connectionId, failedBatch);
        const next = nextComposioV118Poll(state, 'error', { nowMs, error: message });
        this.v118.removeConnection(state.connectionId);
        this.v118.addConnection(next);
        results.push({
          connectionId: state.connectionId,
          toolkit: state.toolkit,
          ok: false,
          fresh: 0,
          duplicates: 0,
          mode: 'error',
          error: message,
          nextPollAtMs: next.nextPollAtMs,
          pages: 0,
          rawItems: 0,
          duplicateIds: 0,
          cursorDuplicates: 0,
          retries: batchState.config.maxRetries,
          stoppedOnCursorRepeat: false,
          lastCursor: state.lastCursor,
        });
      }
    }
    return results;
  }

  /** Tom tat nhanh cho UI: dem theo che do + tong batch/retry. */
  summarize(nowMs: number): {
    total: number;
    enabled: number;
    due: number;
    erroring: number;
    bursting: number;
    idle: number;
    totalNewItems: number;
    totalPages: number;
    totalRetries: number;
    totalCursorDuplicates: number;
    nextPollAtMs: number | null;
  } {
    const base = this.v118.summarize(nowMs);
    let totalPages = 0;
    let totalRetries = 0;
    let totalCursorDuplicates = 0;
    for (const s of this.batchStates.values()) {
      totalPages += s.totalPages;
      totalRetries += s.totalRetries;
      totalCursorDuplicates += s.totalCursorDuplicates;
    }
    return { ...base, totalPages, totalRetries, totalCursorDuplicates };
  }
}

/** Tao state v118 nhanh cho test/tool (tai xuat de tool v119 dung). */
export function createComposioV119ConnState(
  connectionId: string,
  toolkit: string,
  triggerSlug: string,
  startAtMs?: number,
): ComposioV118PollConnState {
  return createComposioV118ConnState({ connectionId, toolkit, triggerSlug, startAtMs });
}
