/**
 * Composio usage metering v1.19 — dem luot goi + quota local +
 * bao cao su dung (v1.19, Doi T4).
 *
 * Tang MOI (chua co tang nao dem usage o muc Composio): polling
 * v5/v6 dem item, health v114 dem ti le loi — nhung khong co tang
 * nao dem LUOT GOI TOOL theo toolkit/user va gioi han quota.
 * V2 (module nay) lap khoang trong do:
 *
 * - Dem luot goi: moi lan goi tool Composio (live hoac mock) ghi
 *   1 luot vao bo dem theo (ngay UTC, userId, toolkit, slug).
 *   Dem ca luot thanh cong / that bai / bi chan (quota) rieng —
 *   de bao cao phan biet "dung nhieu" voi "hong nhieu".
 * - Quota local: gioi han theo ngay cho tung toolkit
 *   (`dailyCapPerToolkit`) + gioi han chung cho ca user
 *   (`dailyCapPerUser`) + gioi han chung cho ca may
 *   (`dailyCapGlobal`). Vuot thi `record` tra `allowed: false`
 *   (khong tang bo dem thanh cong, tang bo dem bi chan) — host
 *   tu choi goi tool truoc khi goi Composio, tiet kiem quota
 *   that ben Composio. Quota la CUC BO (local-first): user tu
 *   dat trong Settings, mac dinh rong rai (khong chan dung
 *   binh thuong).
 * - Rollover theo ngay: sang ngay UTC moi thi bo dem ngay cu
 *   duoc cat vao lich su (giu toi da `maxDaysKept` ngay) roi
 *   reset ve 0 — khong can cron rieng, rollover xay ra ngay
 *   trong `record`/`report`.
 * - Bao cao: tong theo toolkit / theo user / theo ngay, top
 *   toolkit, top user, danh sach vuot quota, ti le loi — de UI
 *   Settings → Composio → Usage ve bieu do + canh bao.
 * - Store: memory + JSON file atomic (mode 0600) trong
 *   `<userData>/composio/` — cung mau voi v118/v119. Bo dem
 *   KHONG chua secret, KHONG chua noi dung goi tool (chi slug
 *   + so luot + thoi gian).
 *
 * Tat ca ham quyet dinh deu thuan (khong doc/ghi file, khong
 * goi mang, `nowMs` do caller truyen vao); chi store doc/ghi
 * file.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File bo dem usage trong thu muc composio cua userData. */
export const COMPOSIO_V119_USAGE_FILE = 'composio-usage-v119.json';
/** Phien ban dinh dang file usage. */
export const COMPOSIO_V119_USAGE_VERSION = 1;
/** Giu lich su toi da tung nay ngay. */
export const COMPOSIO_V119_DEFAULT_MAX_DAYS_KEPT = 90;
/** Quota mac dinh moi ngay moi toolkit (luot goi). */
export const COMPOSIO_V119_DEFAULT_DAILY_CAP_PER_TOOLKIT = 10_000;
/** Quota mac dinh moi ngay moi user (luot goi). */
export const COMPOSIO_V119_DEFAULT_DAILY_CAP_PER_USER = 50_000;
/** Quota mac dinh moi ngay cho ca may (luot goi). */
export const COMPOSIO_V119_DEFAULT_DAILY_CAP_GLOBAL = 200_000;
/** Gioi han mac dinh cua bao cao top (muc). */
export const COMPOSIO_V119_DEFAULT_TOP_N = 10;

/** Quota local (so luot goi toi da moi ngay UTC). */
export interface ComposioV119Quota {
  /** Luot toi da moi ngay cho mot toolkit (ap cho moi user). */
  dailyCapPerToolkit: number;
  /** Luot toi da moi ngay cho mot user (moi toolkit cong lai). */
  dailyCapPerUser: number;
  /** Luot toi da moi ngay cho ca may (moi user cong lai). */
  dailyCapGlobal: number;
}

/** Quota mac dinh (rong rai — khong chan dung binh thuong). */
export const DEFAULT_COMPOSIO_V119_QUOTA: ComposioV119Quota = {
  dailyCapPerToolkit: COMPOSIO_V119_DEFAULT_DAILY_CAP_PER_TOOLKIT,
  dailyCapPerUser: COMPOSIO_V119_DEFAULT_DAILY_CAP_PER_USER,
  dailyCapGlobal: COMPOSIO_V119_DEFAULT_DAILY_CAP_GLOBAL,
};

/** Kiem tra + chuan hoa quota (throw neu sai). */
export function validateComposioV119Quota(raw: Partial<ComposioV119Quota> | undefined): ComposioV119Quota {
  const q: ComposioV119Quota = { ...DEFAULT_COMPOSIO_V119_QUOTA, ...(raw ?? {}) };
  for (const f of ['dailyCapPerToolkit', 'dailyCapPerUser', 'dailyCapGlobal'] as const) {
    if (!Number.isInteger(q[f]) || q[f] < 0) {
      throw new Error(`quota ${f} must be a non-negative integer`);
    }
  }
  return q;
}

/** Ket qua dem cua MOT (ngay, user, toolkit). */
export interface ComposioV119UsageCounter {
  /** Ngay UTC dang YYYY-MM-DD. */
  day: string;
  /** Id user. */
  userId: string;
  /** Slug toolkit. */
  toolkit: string;
  /** Tong luot goi (thanh cong + that bai). */
  calls: number;
  /** Luot thanh cong. */
  succeeded: number;
  /** Luot that bai (loi tu Composio/mock). */
  failed: number;
  /** Luot bi chan vi vuot quota (khong goi Composio). */
  blocked: number;
  /** Luot goi mock (khong ton quota that ben Composio). */
  mockCalls: number;
  /** Luot goi live. */
  liveCalls: number;
}

/** Bo dem usage day du (persist duoc). */
export interface ComposioV119UsageState {
  version: number;
  /** Quota dang ap. */
  quota: ComposioV119Quota;
  /** So ngay lich su giu toi da. */
  maxDaysKept: number;
  /** Tat ca bo dem (ngay cu nhat truoc). */
  counters: ComposioV119UsageCounter[];
}

/** Ngay UTC dang YYYY-MM-DD tu epoch ms. */
export function composioV119UsageDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Tao state usage moi (rong). */
export function createComposioV119UsageState(
  quota?: Partial<ComposioV119Quota>,
  maxDaysKept: number = COMPOSIO_V119_DEFAULT_MAX_DAYS_KEPT,
): ComposioV119UsageState {
  if (!Number.isInteger(maxDaysKept) || maxDaysKept < 1) {
    throw new Error('maxDaysKept must be a positive integer');
  }
  return { version: COMPOSIO_V119_USAGE_VERSION, quota: validateComposioV119Quota(quota), counters: [], maxDaysKept };
}

/** Kiem tra mot counter co hop le khong (throw neu sai). */
export function validateComposioV119UsageCounter(raw: unknown): ComposioV119UsageCounter {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV119UsageCounter must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['day'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rec['day'])) {
    throw new Error('usage counter day must be YYYY-MM-DD.');
  }
  if (typeof rec['userId'] !== 'string' || (rec['userId'] as string).trim() === '') {
    throw new Error('usage counter userId must be a non-empty string.');
  }
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') {
    throw new Error('usage counter toolkit must be a non-empty string.');
  }
  for (const f of ['calls', 'succeeded', 'failed', 'blocked', 'mockCalls', 'liveCalls'] as const) {
    if (!Number.isInteger(rec[f]) || (rec[f] as number) < 0) {
      throw new Error(`usage counter ${f} must be a non-negative integer.`);
    }
  }
  if ((rec['succeeded'] as number) + (rec['failed'] as number) !== (rec['calls'] as number)) {
    throw new Error('usage counter succeeded + failed must equal calls.');
  }
  if ((rec['mockCalls'] as number) + (rec['liveCalls'] as number) !== (rec['calls'] as number)) {
    throw new Error('usage counter mockCalls + liveCalls must equal calls.');
  }
  return {
    day: rec['day'] as string,
    userId: rec['userId'] as string,
    toolkit: rec['toolkit'] as string,
    calls: rec['calls'] as number,
    succeeded: rec['succeeded'] as number,
    failed: rec['failed'] as number,
    blocked: rec['blocked'] as number,
    mockCalls: rec['mockCalls'] as number,
    liveCalls: rec['liveCalls'] as number,
  };
}

/** Kiem tra state usage co hop le khong (throw neu sai). */
export function validateComposioV119UsageState(raw: unknown): ComposioV119UsageState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV119UsageState must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (rec['version'] !== COMPOSIO_V119_USAGE_VERSION) {
    throw new Error(`unsupported usage state version: ${JSON.stringify(rec['version'])}`);
  }
  const quota = validateComposioV119Quota(rec['quota'] as Partial<ComposioV119Quota>);
  if (!Number.isInteger(rec['maxDaysKept']) || (rec['maxDaysKept'] as number) < 1) {
    throw new Error('usage state maxDaysKept must be a positive integer.');
  }
  if (!Array.isArray(rec['counters'])) throw new Error('usage state counters must be an array.');
  const counters = (rec['counters'] as unknown[]).map((c) => validateComposioV119UsageCounter(c));
  const keys = new Set(counters.map((c) => `${c.day}|${c.userId}|${c.toolkit}`));
  if (keys.size !== counters.length) throw new Error('usage state counters must not contain duplicates.');
  return { version: COMPOSIO_V119_USAGE_VERSION, quota, maxDaysKept: rec['maxDaysKept'] as number, counters };
}

function counterKey(day: string, userId: string, toolkit: string): string {
  return `${day}|${userId}|${toolkit}`;
}

/** Tong luot goi cua mot user trong mot ngay (moi toolkit cong lai). */
export function composioV119UserCallsToday(
  state: ComposioV119UsageState,
  userId: string,
  day: string,
): number {
  return state.counters
    .filter((c) => c.day === day && c.userId === userId)
    .reduce((n, c) => n + c.calls, 0);
}

/** Tong luot goi cua ca may trong mot ngay (moi user cong lai). */
export function composioV119GlobalCallsToday(state: ComposioV119UsageState, day: string): number {
  return state.counters.filter((c) => c.day === day).reduce((n, c) => n + c.calls, 0);
}

/** Luot goi cua mot (user, toolkit) trong mot ngay. */
export function composioV119ToolkitCallsToday(
  state: ComposioV119UsageState,
  userId: string,
  toolkit: string,
  day: string,
): number {
  const c = state.counters.find((x) => x.day === day && x.userId === userId && x.toolkit === toolkit);
  return c ? c.calls : 0;
}

/**
 * Kiem tra quota truoc khi goi: tra ve muc nao (neu co) se bi
 * vuot — 'toolkit' | 'user' | 'global' | null (duoc phep goi).
 * Quota = 0 nghia la chan hoan toan muc do (tat).
 */
export function checkComposioV119Quota(
  state: ComposioV119UsageState,
  userId: string,
  toolkit: string,
  nowMs: number,
): 'toolkit' | 'user' | 'global' | null {
  const day = composioV119UsageDayKey(nowMs);
  if (composioV119ToolkitCallsToday(state, userId, toolkit, day) >= state.quota.dailyCapPerToolkit) return 'toolkit';
  if (composioV119UserCallsToday(state, userId, day) >= state.quota.dailyCapPerUser) return 'user';
  if (composioV119GlobalCallsToday(state, day) >= state.quota.dailyCapGlobal) return 'global';
  return null;
}

/** Ket qua ghi 1 luot goi. */
export interface ComposioV119RecordResult {
  /** true = duoc phep goi (da dem vao calls); false = bi chan vi quota. */
  allowed: boolean;
  /** Muc quota da chan (chi khi allowed = false). */
  blockedBy?: 'toolkit' | 'user' | 'global';
  /** Counter sau khi ghi. */
  counter: ComposioV119UsageCounter;
}

/**
 * Ghi 1 luot goi (ham thuan): kiem tra quota truoc — vuot thi
 * KHONG dem vao calls ma dem vao `blocked` va tra allowed =
 * false; duoc phep thi dem vao calls + succeeded/failed +
 * mock/live tuy theo ket qua. Rollover: ngay cu qua
 * `maxDaysKept` thi cat khoi counters.
 */
export function recordComposioV119Usage(
  prev: ComposioV119UsageState,
  input: {
    userId: string;
    toolkit: string;
    succeeded: boolean;
    mock: boolean;
  },
  nowMs: number = Date.now(),
): { state: ComposioV119UsageState; result: ComposioV119RecordResult } {
  if (typeof input.userId !== 'string' || input.userId.trim() === '') {
    throw new Error('userId must be a non-empty string');
  }
  if (typeof input.toolkit !== 'string' || input.toolkit.trim() === '') {
    throw new Error('toolkit must be a non-empty string');
  }
  const day = composioV119UsageDayKey(nowMs);
  const key = counterKey(day, input.userId.trim(), input.toolkit.trim());
  const existing = prev.counters.find((c) => counterKey(c.day, c.userId, c.toolkit) === key);
  const counter: ComposioV119UsageCounter = existing
    ? { ...existing }
    : {
        day,
        userId: input.userId.trim(),
        toolkit: input.toolkit.trim(),
        calls: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        mockCalls: 0,
        liveCalls: 0,
      };

  const blockedBy = checkComposioV119Quota(prev, input.userId.trim(), input.toolkit.trim(), nowMs);
  if (blockedBy !== null) {
    counter.blocked += 1;
    const counters = prev.counters.some((c) => counterKey(c.day, c.userId, c.toolkit) === key)
      ? prev.counters.map((c) => (counterKey(c.day, c.userId, c.toolkit) === key ? counter : c))
      : [...prev.counters, counter];
    const state = pruneComposioV119Usage({ ...prev, counters }, nowMs);
    return { state, result: { allowed: false, blockedBy, counter } };
  }

  counter.calls += 1;
  if (input.succeeded) counter.succeeded += 1;
  else counter.failed += 1;
  if (input.mock) counter.mockCalls += 1;
  else counter.liveCalls += 1;
  const counters = prev.counters.some((c) => counterKey(c.day, c.userId, c.toolkit) === key)
    ? prev.counters.map((c) => (counterKey(c.day, c.userId, c.toolkit) === key ? counter : c))
    : [...prev.counters, counter];
  const state = pruneComposioV119Usage({ ...prev, counters }, nowMs);
  return { state, result: { allowed: true, counter } };
}

/** Cat ngay cu qua `maxDaysKept` (ham thuan): giu ngay moi nhat. */
export function pruneComposioV119Usage(
  prev: ComposioV119UsageState,
  nowMs: number = Date.now(),
): ComposioV119UsageState {
  const days = [...new Set(prev.counters.map((c) => c.day))].sort();
  if (days.length <= prev.maxDaysKept) return prev;
  const keep = new Set(days.slice(-prev.maxDaysKept));
  void nowMs;
  return { ...prev, counters: prev.counters.filter((c) => keep.has(c.day)) };
}

/** Mot muc trong bao cao top. */
export interface ComposioV119UsageTopEntry {
  key: string;
  calls: number;
  succeeded: number;
  failed: number;
  blocked: number;
  failureRate: number;
}

/** Bao cao su dung (tong hop tu counters). */
export interface ComposioV119UsageReport {
  /** Ngay bao cao (UTC). */
  day: string;
  /** Khoang ngay bao cao bao phu (YYYY-MM-DD → YYYY-MM-DD). */
  range: { from: string; to: string };
  totalCalls: number;
  totalSucceeded: number;
  totalFailed: number;
  totalBlocked: number;
  totalMockCalls: number;
  totalLiveCalls: number;
  failureRate: number;
  byToolkit: ComposioV119UsageTopEntry[];
  byUser: ComposioV119UsageTopEntry[];
  byDay: { day: string; calls: number; succeeded: number; failed: number; blocked: number }[];
  /** Cac (user, toolkit) vuot quota trong ngay bao cao. */
  overQuota: { userId: string; toolkit: string; calls: number; cap: number; level: 'toolkit' | 'user' | 'global' }[];
  /** Cac (user, toolkit) co ti le loi >= 50% va it nhat 5 luot. */
  highFailure: { userId: string; toolkit: string; calls: number; failureRate: number }[];
}

/** Lap bao cao su dung tu state (ham thuan). */
export function buildComposioV119UsageReport(
  state: ComposioV119UsageState,
  opts: { day?: string; topN?: number; nowMs?: number } = {},
): ComposioV119UsageReport {
  const nowMs = opts.nowMs ?? Date.now();
  const day = opts.day ?? composioV119UsageDayKey(nowMs);
  const topN = opts.topN ?? COMPOSIO_V119_DEFAULT_TOP_N;
  const today = state.counters.filter((c) => c.day === day);
  const sum = (list: ComposioV119UsageCounter[], f: (c: ComposioV119UsageCounter) => number): number =>
    list.reduce((n, c) => n + f(c), 0);
  const totalCalls = sum(today, (c) => c.calls);
  const totalSucceeded = sum(today, (c) => c.succeeded);
  const totalFailed = sum(today, (c) => c.failed);
  const totalBlocked = sum(today, (c) => c.blocked);
  const totalMockCalls = sum(today, (c) => c.mockCalls);
  const totalLiveCalls = sum(today, (c) => c.liveCalls);

  const groupBy = (keyFn: (c: ComposioV119UsageCounter) => string): ComposioV119UsageTopEntry[] => {
    const map = new Map<string, ComposioV119UsageCounter[]>();
    for (const c of today) {
      const key = keyFn(c);
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return [...map.entries()]
      .map(([key, list]) => {
        const calls = sum(list, (c) => c.calls);
        const failed = sum(list, (c) => c.failed);
        return {
          key,
          calls,
          succeeded: sum(list, (c) => c.succeeded),
          failed,
          blocked: sum(list, (c) => c.blocked),
          failureRate: calls === 0 ? 0 : failed / calls,
        };
      })
      .sort((a, b) => b.calls - a.calls)
      .slice(0, topN);
  };

  const days = [...new Set(state.counters.map((c) => c.day))].sort();
  const byDay = days.map((d) => {
    const list = state.counters.filter((c) => c.day === d);
    return { day: d, calls: sum(list, (c) => c.calls), succeeded: sum(list, (c) => c.succeeded), failed: sum(list, (c) => c.failed), blocked: sum(list, (c) => c.blocked) };
  });

  const overQuota: ComposioV119UsageReport['overQuota'] = [];
  for (const c of today) {
    if (c.calls >= state.quota.dailyCapPerToolkit) {
      overQuota.push({ userId: c.userId, toolkit: c.toolkit, calls: c.calls, cap: state.quota.dailyCapPerToolkit, level: 'toolkit' });
    }
  }
  const userTotals = new Map<string, number>();
  for (const c of today) userTotals.set(c.userId, (userTotals.get(c.userId) ?? 0) + c.calls);
  for (const [userId, calls] of userTotals) {
    if (calls >= state.quota.dailyCapPerUser) {
      overQuota.push({ userId, toolkit: '*', calls, cap: state.quota.dailyCapPerUser, level: 'user' });
    }
  }
  if (totalCalls >= state.quota.dailyCapGlobal) {
    overQuota.push({ userId: '*', toolkit: '*', calls: totalCalls, cap: state.quota.dailyCapGlobal, level: 'global' });
  }

  const highFailure: ComposioV119UsageReport['highFailure'] = [];
  for (const c of today) {
    if (c.calls >= 5 && c.calls > 0 && c.failed / c.calls >= 0.5) {
      highFailure.push({ userId: c.userId, toolkit: c.toolkit, calls: c.calls, failureRate: c.failed / c.calls });
    }
  }
  highFailure.sort((a, b) => b.failureRate - a.failureRate);

  return {
    day,
    range: { from: days[0] ?? day, to: days[days.length - 1] ?? day },
    totalCalls,
    totalSucceeded,
    totalFailed,
    totalBlocked,
    totalMockCalls,
    totalLiveCalls,
    failureRate: totalCalls === 0 ? 0 : totalFailed / totalCalls,
    byToolkit: groupBy((c) => c.toolkit),
    byUser: groupBy((c) => c.userId),
    byDay,
    overQuota,
    highFailure,
  };
}

/** Tom tat usage 1 dong cho UI. */
export function summarizeComposioV119Usage(state: ComposioV119UsageState, nowMs: number = Date.now()): string {
  const day = composioV119UsageDayKey(nowMs);
  const report = buildComposioV119UsageReport(state, { day, nowMs });
  return `${day}: ${report.totalCalls} calls (${report.totalLiveCalls} live, ${report.totalMockCalls} mock), ${report.totalFailed} failed, ${report.totalBlocked} blocked, ${report.overQuota.length} over quota.`;
}

// ---------------------------------------------------------------------------
// Store — memory + JSON file (atomic, mode 0600)
// ---------------------------------------------------------------------------

/** Interface store usage. */
export interface ComposioV119UsageStore {
  load(): ComposioV119UsageState;
  save(state: ComposioV119UsageState): void;
  clear(): void;
}

/** Store trong bo nho — de test + host khong co userData dir. */
export class MemoryComposioV119UsageStore implements ComposioV119UsageStore {
  private state: ComposioV119UsageState;

  constructor(quota?: Partial<ComposioV119Quota>, maxDaysKept?: number) {
    this.state = createComposioV119UsageState(quota, maxDaysKept);
  }

  load(): ComposioV119UsageState {
    return JSON.parse(JSON.stringify(this.state)) as ComposioV119UsageState;
  }

  save(state: ComposioV119UsageState): void {
    const valid = validateComposioV119UsageState(state);
    this.state = JSON.parse(JSON.stringify(valid)) as ComposioV119UsageState;
  }

  clear(): void {
    this.state = createComposioV119UsageState(this.state.quota, this.state.maxDaysKept);
  }
}

/** Duong dan file usage. */
export function getComposioV119UsagePath(dir: string): string {
  return path.join(dir, COMPOSIO_V119_USAGE_FILE);
}

/** Store tren dia (file JSON atomic, mode 0600). */
export class JsonFileComposioV119UsageStore implements ComposioV119UsageStore {
  private readonly filePath: string;

  constructor(dir: string) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new Error('usage store dir must be a non-empty string');
    }
    this.filePath = getComposioV119UsagePath(dir);
  }

  /** Duong dan file dang dung (de UI/log hien). */
  get path(): string {
    return this.filePath;
  }

  load(): ComposioV119UsageState {
    if (!fs.existsSync(this.filePath)) return createComposioV119UsageState();
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    return validateComposioV119UsageState(raw);
  }

  save(state: ComposioV119UsageState): void {
    const valid = validateComposioV119UsageState(state);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows khong co chmod unix — bo qua.
    }
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
  }
}
