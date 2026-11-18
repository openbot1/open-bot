/**
 * Composio usage metering v2 — dem theo action + soft-limit +
 * canh bao + quota theo user (v1.20, Doi T4).
 *
 * Tang tren usageMeteringV119.ts — KHONG viet lai:
 * - Bo dem v119 theo (ngay UTC, userId, toolkit) + quota 3 muc
 *   (toolkit/user/global) + rollover theo ngay + bao cao v119
 *   van la nen: v2 GIU LAI toan bo bo dem do (truong
 *   `toolkitCounters` trong state v2 chinh la counter v119) va
 *   dung lai `recordComposioV119Usage` / `checkComposioV119Quota`
 *   / `buildComposioV119UsageReport` de khong lech so lieu giua
 *   2 tang.
 *
 * Moi trong v2:
 * 1. Dem theo ACTION (slug): ngoai bo dem toolkit, moi luot goi
 *    con ghi 1 luot vao bo dem (ngay, user, toolkit, slug) —
 *    biet chinh xac action nao "ngon" quota (vd 1 action goi
 *    vong lap vo tinh), bao cao top action, ti le loi theo
 *    action. Dem ca luot bi chan (blocked) rieng nhu v119.
 * 2. Soft-limit + canh bao: quota khong chi "vuot thi chan" —
 *    v2 them 2 nguong canh bao truoc khi chan: `warnAt`
 *    (mac dinh 70% cap) va `alertAt` (mac dinh 90% cap). Vuot
 *    nguong thi sinh 1 warning (ghi lai, dedup: moi (ngay,
 *    user, toolkit, muc, severity) chi canh bao 1 lan/ngay) —
 *    UI hien thanh tien do + canh bao truoc khi user bi chan
 *    dot ngot. Warning khong chua noi dung goi tool.
 * 3. Quota override theo user: ngoai quota chung, host co the
 *    dat quota rieng cho tung user (vd user tra phi duoc cap
 *    cao hon, bot he thong duoc cap thap hon). Quota hieu luc
 *    = quota chung bi override tung muc theo user; khong co
 *    override thi dung quota chung. Override 0 = chan muc do.
 * 4. Bao cao v2: ke thua bao cao v119 (tong/top toolkit/top
 *    user/vuot quota/ti le loi) + top action + danh sach
 *    warning trong ngay + headroom (so luot con lai) theo
 *    toolkit cho UI ve bieu do.
 * 5. Store: memory + JSON file atomic (mode 0600) trong
 *    `<userData>/composio/` — cung mau voi v119. File rieng
 *    (`composio-usage-v120.json`) de khong pha file v119.
 *
 * Tat ca ham quyet dinh deu thuan (`nowMs` do caller truyen);
 * chi store doc/ghi file.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildComposioV119UsageReport,
  checkComposioV119Quota,
  composioV119UsageDayKey,
  validateComposioV119Quota,
  validateComposioV119UsageCounter,
  validateComposioV119UsageState,
  type ComposioV119Quota,
  type ComposioV119UsageCounter,
  type ComposioV119UsageReport,
  type ComposioV119UsageState,
} from './usageMeteringV119';

/** File bo dem usage v2 trong thu muc composio cua userData. */
export const COMPOSIO_V120_USAGE_FILE = 'composio-usage-v120.json';
/** Phien ban dinh dang file usage v2. */
export const COMPOSIO_V120_USAGE_VERSION = 1;
/** Giu lich su toi da tung nay ngay (mac dinh — bang v119). */
export const COMPOSIO_V120_DEFAULT_MAX_DAYS_KEPT = 90;
/** Nguong canh bao som (phan tram cap) — mac dinh 70%. */
export const COMPOSIO_V120_DEFAULT_WARN_AT = 0.7;
/** Nguong canh bao gap (phan tram cap) — mac dinh 90%. */
export const COMPOSIO_V120_DEFAULT_ALERT_AT = 0.9;
/** Gioi han mac dinh cua bao cao top (muc). */
export const COMPOSIO_V120_DEFAULT_TOP_N = 10;
/** Giu toi da tung nay warning (moi nhat). */
export const COMPOSIO_V120_DEFAULT_MAX_WARNINGS = 500;

/** Nguong soft-limit (phan tram cap, 0..1). */
export interface ComposioV120SoftLimitThresholds {
  /** Vuot ti le nay thi canh bao som ('warn'). */
  warnAt: number;
  /** Vuot ti le nay thi canh bao gap ('alert'). */
  alertAt: number;
}

/** Nguong mac dinh: warn 70%, alert 90%. */
export const DEFAULT_COMPOSIO_V120_SOFT_LIMIT_THRESHOLDS: ComposioV120SoftLimitThresholds = {
  warnAt: COMPOSIO_V120_DEFAULT_WARN_AT,
  alertAt: COMPOSIO_V120_DEFAULT_ALERT_AT,
};

/** Kiem tra + chuan hoa nguong soft-limit (throw neu sai). */
export function validateComposioV120SoftLimitThresholds(
  raw: Partial<ComposioV120SoftLimitThresholds> | undefined,
): ComposioV120SoftLimitThresholds {
  const t: ComposioV120SoftLimitThresholds = { ...DEFAULT_COMPOSIO_V120_SOFT_LIMIT_THRESHOLDS, ...(raw ?? {}) };
  if (typeof t.warnAt !== 'number' || t.warnAt <= 0 || t.warnAt >= 1) {
    throw new Error('soft-limit warnAt must be a number between 0 and 1 (exclusive)');
  }
  if (typeof t.alertAt !== 'number' || t.alertAt <= 0 || t.alertAt >= 1) {
    throw new Error('soft-limit alertAt must be a number between 0 and 1 (exclusive)');
  }
  if (t.alertAt <= t.warnAt) {
    throw new Error('soft-limit alertAt must be greater than warnAt');
  }
  return t;
}

/** Muc do nghiem trong cua soft-limit. */
export type ComposioV120SoftLimitSeverity = 'ok' | 'warn' | 'alert' | 'blocked';

/** Ket qua kiem tra soft-limit tai mot muc quota. */
export interface ComposioV120SoftLimitStatus {
  /** Muc quota dang xet. */
  level: 'toolkit' | 'user' | 'global';
  /** So luot da dung trong ngay. */
  used: number;
  /** Cap cua muc do. */
  cap: number;
  /** Ti le da dung (0..1+, co the vuot 1 khi bi chan). */
  ratio: number;
  /** So luot con lai truoc khi bi chan (0 khi da het). */
  remaining: number;
  /** Muc do nghiem trong. */
  severity: ComposioV120SoftLimitSeverity;
}

/** Tinh trang thai soft-limit tu used/cap (ham thuan). */
export function composioV120SoftLimitStatus(
  level: ComposioV120SoftLimitStatus['level'],
  used: number,
  cap: number,
  thresholds: ComposioV120SoftLimitThresholds,
): ComposioV120SoftLimitStatus {
  if (!Number.isInteger(used) || used < 0) throw new Error('soft-limit used must be a non-negative integer');
  if (!Number.isInteger(cap) || cap < 0) throw new Error('soft-limit cap must be a non-negative integer');
  const ratio = cap === 0 ? (used > 0 ? Number.POSITIVE_INFINITY : 0) : used / cap;
  const severity: ComposioV120SoftLimitSeverity =
    cap === 0 || used >= cap ? 'blocked' : ratio >= thresholds.alertAt ? 'alert' : ratio >= thresholds.warnAt ? 'warn' : 'ok';
  return { level, used, cap, ratio, remaining: Math.max(0, cap - used), severity };
}

/** Ket qua dem cua MOT (ngay, user, toolkit, slug). */
export interface ComposioV120ActionCounter {
  /** Ngay UTC dang YYYY-MM-DD. */
  day: string;
  /** Id user. */
  userId: string;
  /** Slug toolkit. */
  toolkit: string;
  /** Slug action (tool), vd 'GMAIL_SEND_MESSAGE'. */
  slug: string;
  /** Tong luot goi (thanh cong + that bai). */
  calls: number;
  /** Luot thanh cong. */
  succeeded: number;
  /** Luot that bai. */
  failed: number;
  /** Luot bi chan vi vuot quota. */
  blocked: number;
  /** Luot goi mock. */
  mockCalls: number;
  /** Luot goi live. */
  liveCalls: number;
}

/** Kiem tra mot action counter (throw neu sai). */
export function validateComposioV120ActionCounter(raw: unknown): ComposioV120ActionCounter {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV120ActionCounter must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['day'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rec['day'])) {
    throw new Error('action counter day must be YYYY-MM-DD.');
  }
  if (typeof rec['userId'] !== 'string' || (rec['userId'] as string).trim() === '') {
    throw new Error('action counter userId must be a non-empty string.');
  }
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') {
    throw new Error('action counter toolkit must be a non-empty string.');
  }
  if (typeof rec['slug'] !== 'string' || (rec['slug'] as string).trim() === '') {
    throw new Error('action counter slug must be a non-empty string.');
  }
  for (const f of ['calls', 'succeeded', 'failed', 'blocked', 'mockCalls', 'liveCalls'] as const) {
    if (!Number.isInteger(rec[f]) || (rec[f] as number) < 0) {
      throw new Error(`action counter ${f} must be a non-negative integer.`);
    }
  }
  if ((rec['succeeded'] as number) + (rec['failed'] as number) !== (rec['calls'] as number)) {
    throw new Error('action counter succeeded + failed must equal calls.');
  }
  if ((rec['mockCalls'] as number) + (rec['liveCalls'] as number) !== (rec['calls'] as number)) {
    throw new Error('action counter mockCalls + liveCalls must equal calls.');
  }
  return {
    day: rec['day'] as string,
    userId: rec['userId'] as string,
    toolkit: rec['toolkit'] as string,
    slug: rec['slug'] as string,
    calls: rec['calls'] as number,
    succeeded: rec['succeeded'] as number,
    failed: rec['failed'] as number,
    blocked: rec['blocked'] as number,
    mockCalls: rec['mockCalls'] as number,
    liveCalls: rec['liveCalls'] as number,
  };
}

/** Mot canh bao soft-limit (da dedup theo ngay/muc/severity). */
export interface ComposioV120UsageWarning {
  id: string;
  /** Ngay UTC xay ra canh bao. */
  day: string;
  userId: string;
  toolkit: string;
  /** Muc quota bi vuot nguong ('*' = muc user/global). */
  level: 'toolkit' | 'user' | 'global';
  severity: 'warn' | 'alert';
  /** Ti le da dung luc sinh canh bao (0..1). */
  ratio: number;
  /** Cap cua muc do luc do. */
  cap: number;
  /** ms epoch sinh canh bao. */
  atMs: number;
}

/** Kiem tra mot warning (throw neu sai). */
export function validateComposioV120UsageWarning(raw: unknown): ComposioV120UsageWarning {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV120UsageWarning must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || (rec['id'] as string).trim() === '') {
    throw new Error('usage warning id must be a non-empty string.');
  }
  if (typeof rec['day'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rec['day'])) {
    throw new Error('usage warning day must be YYYY-MM-DD.');
  }
  if (typeof rec['userId'] !== 'string' || (rec['userId'] as string).trim() === '') {
    throw new Error('usage warning userId must be a non-empty string.');
  }
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') {
    throw new Error('usage warning toolkit must be a non-empty string.');
  }
  const levels: readonly string[] = ['toolkit', 'user', 'global'];
  if (typeof rec['level'] !== 'string' || !levels.includes(rec['level'])) {
    throw new Error('usage warning level is invalid.');
  }
  if (rec['severity'] !== 'warn' && rec['severity'] !== 'alert') {
    throw new Error('usage warning severity must be warn or alert.');
  }
  if (typeof rec['ratio'] !== 'number' || !Number.isFinite(rec['ratio']) || (rec['ratio'] as number) < 0) {
    throw new Error('usage warning ratio must be a non-negative number.');
  }
  if (!Number.isInteger(rec['cap']) || (rec['cap'] as number) < 0) {
    throw new Error('usage warning cap must be a non-negative integer.');
  }
  if (typeof rec['atMs'] !== 'number' || !Number.isFinite(rec['atMs']) || (rec['atMs'] as number) < 0) {
    throw new Error('usage warning atMs must be a non-negative number.');
  }
  return {
    id: rec['id'] as string,
    day: rec['day'] as string,
    userId: rec['userId'] as string,
    toolkit: rec['toolkit'] as string,
    level: rec['level'] as 'toolkit' | 'user' | 'global',
    severity: rec['severity'] as 'warn' | 'alert',
    ratio: rec['ratio'] as number,
    cap: rec['cap'] as number,
    atMs: rec['atMs'] as number,
  };
}

/** Bo dem usage v2 day du (persist duoc). */
export interface ComposioV120UsageState {
  version: number;
  /** Quota chung (ap cho moi user khi khong co override). */
  quota: ComposioV119Quota;
  /** Override quota theo user: userId → tung muc (thieu muc = dung chung). */
  perUserQuota: Readonly<Record<string, Partial<ComposioV119Quota>>>;
  /** Nguong soft-limit. */
  thresholds: ComposioV120SoftLimitThresholds;
  /** So ngay lich su giu toi da. */
  maxDaysKept: number;
  /** Bo dem theo (ngay, user, toolkit) — giong het counter v119. */
  toolkitCounters: ComposioV119UsageCounter[];
  /** Bo dem theo (ngay, user, toolkit, slug). */
  actionCounters: ComposioV120ActionCounter[];
  /** Canh bao soft-limit da sinh (moi nhat truoc). */
  warnings: ComposioV120UsageWarning[];
}

/** Tao state usage v2 moi (rong). */
export function createComposioV120UsageState(
  quota?: Partial<ComposioV119Quota>,
  opts?: {
    perUserQuota?: Readonly<Record<string, Partial<ComposioV119Quota>>>;
    thresholds?: Partial<ComposioV120SoftLimitThresholds>;
    maxDaysKept?: number;
  },
): ComposioV120UsageState {
  const maxDaysKept = opts?.maxDaysKept ?? COMPOSIO_V120_DEFAULT_MAX_DAYS_KEPT;
  if (!Number.isInteger(maxDaysKept) || maxDaysKept < 1) {
    throw new Error('maxDaysKept must be a positive integer');
  }
  const perUserQuota: Record<string, Partial<ComposioV119Quota>> = {};
  for (const [userId, q] of Object.entries(opts?.perUserQuota ?? {})) {
    if (userId.trim() === '') throw new Error('per-user quota userId must be a non-empty string');
    perUserQuota[userId] = validateComposioV119Quota(q);
  }
  return {
    version: COMPOSIO_V120_USAGE_VERSION,
    quota: validateComposioV119Quota(quota),
    perUserQuota,
    thresholds: validateComposioV120SoftLimitThresholds(opts?.thresholds),
    maxDaysKept,
    toolkitCounters: [],
    actionCounters: [],
    warnings: [],
  };
}

/** Kiem tra state usage v2 (throw neu sai). */
export function validateComposioV120UsageState(raw: unknown): ComposioV120UsageState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV120UsageState must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (rec['version'] !== COMPOSIO_V120_USAGE_VERSION) {
    throw new Error(`unsupported usage v2 state version: ${JSON.stringify(rec['version'])}`);
  }
  const quota = validateComposioV119Quota(rec['quota'] as Partial<ComposioV119Quota>);
  if (typeof rec['perUserQuota'] !== 'object' || rec['perUserQuota'] === null || Array.isArray(rec['perUserQuota'])) {
    throw new Error('usage v2 state perUserQuota must be an object.');
  }
  const perUserQuota: Record<string, Partial<ComposioV119Quota>> = {};
  for (const [userId, q] of Object.entries(rec['perUserQuota'] as Record<string, unknown>)) {
    perUserQuota[userId] = validateComposioV119Quota(q as Partial<ComposioV119Quota>);
  }
  const thresholds = validateComposioV120SoftLimitThresholds(rec['thresholds'] as Partial<ComposioV120SoftLimitThresholds>);
  if (!Number.isInteger(rec['maxDaysKept']) || (rec['maxDaysKept'] as number) < 1) {
    throw new Error('usage v2 state maxDaysKept must be a positive integer.');
  }
  const maxDaysKept = rec['maxDaysKept'] as number;
  if (!Array.isArray(rec['toolkitCounters'])) throw new Error('usage v2 state toolkitCounters must be an array.');
  if (!Array.isArray(rec['actionCounters'])) throw new Error('usage v2 state actionCounters must be an array.');
  if (!Array.isArray(rec['warnings'])) throw new Error('usage v2 state warnings must be an array.');
  const toolkitCounters = (rec['toolkitCounters'] as unknown[]).map((c) => validateComposioV119UsageCounter(c));
  const actionCounters = (rec['actionCounters'] as unknown[]).map((c) => validateComposioV120ActionCounter(c));
  const warnings = (rec['warnings'] as unknown[]).map((w) => validateComposioV120UsageWarning(w));
  const tkKeys = new Set(toolkitCounters.map((c) => `${c.day}|${c.userId}|${c.toolkit}`));
  if (tkKeys.size !== toolkitCounters.length) throw new Error('usage v2 state toolkitCounters must not contain duplicates.');
  const acKeys = new Set(actionCounters.map((c) => `${c.day}|${c.userId}|${c.toolkit}|${c.slug}`));
  if (acKeys.size !== actionCounters.length) throw new Error('usage v2 state actionCounters must not contain duplicates.');
  return { version: COMPOSIO_V120_USAGE_VERSION, quota, perUserQuota, thresholds, maxDaysKept, toolkitCounters, actionCounters, warnings };
}

/** Quota hieu luc cua mot user (chung + override theo user). */
export function effectiveComposioV120QuotaForUser(
  state: ComposioV120UsageState,
  userId: string,
): ComposioV119Quota {
  const override = state.perUserQuota[userId] ?? {};
  return validateComposioV119Quota({ ...state.quota, ...override });
}

/** Dat/xoa override quota cho mot user (ham thuan, tra state moi). */
export function setComposioV120PerUserQuota(
  prev: ComposioV120UsageState,
  userId: string,
  override: Partial<ComposioV119Quota> | null,
): ComposioV120UsageState {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('userId must be a non-empty string');
  }
  const perUserQuota = { ...prev.perUserQuota };
  if (override === null) {
    delete perUserQuota[userId.trim()];
  } else {
    perUserQuota[userId.trim()] = validateComposioV119Quota(override);
  }
  return { ...prev, perUserQuota };
}

/** Chuyen state v2 ve dang state v119 (de dung lai ham v119). */
export function toComposioV119UsageState(
  state: ComposioV120UsageState,
  userId?: string,
): ComposioV119UsageState {
  return {
    version: 1,
    quota: userId !== undefined ? effectiveComposioV120QuotaForUser(state, userId) : state.quota,
    maxDaysKept: state.maxDaysKept,
    counters: state.toolkitCounters,
  };
}

/** Tong luot goi cua mot (user, toolkit, slug) trong mot ngay. */
export function composioV120ActionCallsToday(
  state: ComposioV120UsageState,
  userId: string,
  toolkit: string,
  slug: string,
  day: string,
): number {
  const c = state.actionCounters.find(
    (x) => x.day === day && x.userId === userId && x.toolkit === toolkit && x.slug === slug,
  );
  return c ? c.calls : 0;
}

/**
 * Trang thai soft-limit cua ca 3 muc cho mot (user, toolkit)
 * trong ngay: toolkit → user → global. Dung quota hieu luc
 * cua user do.
 */
export function checkComposioV120SoftLimits(
  state: ComposioV120UsageState,
  userId: string,
  toolkit: string,
  nowMs: number,
): ComposioV120SoftLimitStatus[] {
  const day = composioV119UsageDayKey(nowMs);
  const quota = toComposioV119UsageState(state, userId).quota;
  const toolkitUsed = state.toolkitCounters
    .filter((c) => c.day === day && c.userId === userId && c.toolkit === toolkit)
    .reduce((n, c) => n + c.calls, 0);
  const userUsed = state.toolkitCounters
    .filter((c) => c.day === day && c.userId === userId)
    .reduce((n, c) => n + c.calls, 0);
  const globalUsed = state.toolkitCounters
    .filter((c) => c.day === day)
    .reduce((n, c) => n + c.calls, 0);
  return [
    composioV120SoftLimitStatus('toolkit', toolkitUsed, quota.dailyCapPerToolkit, state.thresholds),
    composioV120SoftLimitStatus('user', userUsed, quota.dailyCapPerUser, state.thresholds),
    composioV120SoftLimitStatus('global', globalUsed, quota.dailyCapGlobal, state.thresholds),
  ];
}

/** Ket qua ghi 1 luot goi v2. */
export interface ComposioV120RecordResult {
  /** true = duoc phep goi; false = bi chan vi quota. */
  allowed: boolean;
  /** Muc quota da chan (chi khi allowed = false). */
  blockedBy?: 'toolkit' | 'user' | 'global';
  /** Trang thai soft-limit sau khi ghi (ca 3 muc). */
  softLimits: ComposioV120SoftLimitStatus[];
  /** Warning MOI sinh trong lan ghi nay (da dedup). */
  newWarnings: ComposioV120UsageWarning[];
  /** Counter toolkit sau khi ghi. */
  toolkitCounter: ComposioV119UsageCounter;
  /** Counter action sau khi ghi. */
  actionCounter: ComposioV120ActionCounter;
}

function actionKey(day: string, userId: string, toolkit: string, slug: string): string {
  return `${day}|${userId}|${toolkit}|${slug}`;
}

/**
 * Ghi 1 luot goi v2 (ham thuan): dem dong thoi ca muc toolkit
 * (qua ham v119 — dam bao so lieu 2 tang khop nhau) LAN muc
 * action; kiem tra quota truoc (vuot thi dem vao `blocked` ca
 * 2 muc, khong goi Composio); vuot nguong soft-limit thi sinh
 * warning (moi (ngay, user, toolkit, muc, severity) 1 lan).
 * Rollover: ngay cu qua `maxDaysKept` thi cat khoi ca 2 bo
 * dem + warning cu.
 */
export function recordComposioV120Usage(
  prev: ComposioV120UsageState,
  input: {
    userId: string;
    toolkit: string;
    slug: string;
    succeeded: boolean;
    mock: boolean;
  },
  nowMs: number = Date.now(),
): { state: ComposioV120UsageState; result: ComposioV120RecordResult } {
  if (typeof input.userId !== 'string' || input.userId.trim() === '') {
    throw new Error('userId must be a non-empty string');
  }
  if (typeof input.toolkit !== 'string' || input.toolkit.trim() === '') {
    throw new Error('toolkit must be a non-empty string');
  }
  if (typeof input.slug !== 'string' || input.slug.trim() === '') {
    throw new Error('slug must be a non-empty string');
  }
  const userId = input.userId.trim();
  const toolkit = input.toolkit.trim();
  const slug = input.slug.trim();
  const day = composioV119UsageDayKey(nowMs);

  // 1. Ghi muc toolkit qua bo may v119 (quota hieu luc cua user):
  // kiem tra quota bang ham v119 tren state co quota hieu luc,
  // roi cap nhat ca 2 bo dem trong 1 lan (dam bao so lieu 2 tang
  // khop nhau).
  const v119Before: ComposioV119UsageState = {
    version: 1,
    quota: effectiveComposioV120QuotaForUser(prev, userId),
    maxDaysKept: prev.maxDaysKept,
    counters: prev.toolkitCounters,
  };
  const blockedBy = checkComposioV119Quota(v119Before, userId, toolkit, nowMs);
  const allowed = blockedBy === null;

  const bump = (c: ComposioV120ActionCounter): ComposioV120ActionCounter => {
    const next = { ...c };
    if (!allowed) {
      next.blocked += 1;
    } else {
      next.calls += 1;
      if (input.succeeded) next.succeeded += 1;
      else next.failed += 1;
      if (input.mock) next.mockCalls += 1;
      else next.liveCalls += 1;
    }
    return next;
  };

  // Muc toolkit: tim hoac tao counter.
  const tkKey = `${day}|${userId}|${toolkit}`;
  const existingTk = prev.toolkitCounters.find((c) => `${c.day}|${c.userId}|${c.toolkit}` === tkKey);
  const toolkitCounter: ComposioV119UsageCounter = existingTk
    ? {
        ...existingTk,
        calls: existingTk.calls + (allowed ? 1 : 0),
        succeeded: existingTk.succeeded + (allowed && input.succeeded ? 1 : 0),
        failed: existingTk.failed + (allowed && !input.succeeded ? 1 : 0),
        blocked: existingTk.blocked + (allowed ? 0 : 1),
        mockCalls: existingTk.mockCalls + (allowed && input.mock ? 1 : 0),
        liveCalls: existingTk.liveCalls + (allowed && !input.mock ? 1 : 0),
      }
    : {
        day,
        userId,
        toolkit,
        calls: allowed ? 1 : 0,
        succeeded: allowed && input.succeeded ? 1 : 0,
        failed: allowed && !input.succeeded ? 1 : 0,
        blocked: allowed ? 0 : 1,
        mockCalls: allowed && input.mock ? 1 : 0,
        liveCalls: allowed && !input.mock ? 1 : 0,
      };
  const toolkitCounters = existingTk
    ? prev.toolkitCounters.map((c) => (`${c.day}|${c.userId}|${c.toolkit}` === tkKey ? toolkitCounter : c))
    : [...prev.toolkitCounters, toolkitCounter];

  // Muc action.
  const acKey = actionKey(day, userId, toolkit, slug);
  const existingAc = prev.actionCounters.find((c) => actionKey(c.day, c.userId, c.toolkit, c.slug) === acKey);
  const baseAc: ComposioV120ActionCounter = existingAc ?? {
    day,
    userId,
    toolkit,
    slug,
    calls: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    mockCalls: 0,
    liveCalls: 0,
  };
  const actionCounter = bump(baseAc);
  const actionCounters = existingAc
    ? prev.actionCounters.map((c) => (actionKey(c.day, c.userId, c.toolkit, c.slug) === acKey ? actionCounter : c))
    : [...prev.actionCounters, actionCounter];

  let next: ComposioV120UsageState = { ...prev, toolkitCounters, actionCounters };

  // 2. Soft-limit + warning (chi khi duoc phep goi — luot bi chan
  // khong sinh warning moi, no da o muc blocked).
  const softLimits = checkComposioV120SoftLimits(next, userId, toolkit, nowMs);
  const newWarnings: ComposioV120UsageWarning[] = [];
  if (allowed) {
    for (const status of softLimits) {
      if (status.severity !== 'warn' && status.severity !== 'alert') continue;
      const dup = next.warnings.some(
        (w) =>
          w.day === day &&
          w.userId === userId &&
          w.toolkit === (status.level === 'toolkit' ? toolkit : '*') &&
          w.level === status.level &&
          w.severity === status.severity,
      );
      if (dup) continue;
      const warning: ComposioV120UsageWarning = {
        id: `uw120-${crypto.randomUUID()}`,
        day,
        userId,
        toolkit: status.level === 'toolkit' ? toolkit : '*',
        level: status.level,
        severity: status.severity,
        ratio: status.ratio,
        cap: status.cap,
        atMs: nowMs,
      };
      newWarnings.push(warning);
    }
    if (newWarnings.length > 0) {
      const warnings = [...newWarnings, ...next.warnings].slice(0, COMPOSIO_V120_DEFAULT_MAX_WARNINGS);
      next = { ...next, warnings };
    }
  }

  next = pruneComposioV120Usage(next);
  return {
    state: next,
    result: {
      allowed,
      ...(blockedBy !== null ? { blockedBy } : {}),
      softLimits,
      newWarnings,
      toolkitCounter,
      actionCounter,
    },
  };
}

/** Cat ngay cu qua `maxDaysKept` (ham thuan). */
export function pruneComposioV120Usage(prev: ComposioV120UsageState): ComposioV120UsageState {
  const days = [...new Set(prev.toolkitCounters.map((c) => c.day))].sort();
  if (days.length <= prev.maxDaysKept) return prev;
  const keep = new Set(days.slice(-prev.maxDaysKept));
  return {
    ...prev,
    toolkitCounters: prev.toolkitCounters.filter((c) => keep.has(c.day)),
    actionCounters: prev.actionCounters.filter((c) => keep.has(c.day)),
    warnings: prev.warnings.filter((w) => keep.has(w.day)),
  };
}

/** Bao cao su dung v2 (ke thua v119 + top action + warning + headroom). */
export interface ComposioV120UsageReport extends ComposioV119UsageReport {
  /** Top action theo luot goi trong ngay bao cao. */
  byAction: {
    key: string;
    toolkit: string;
    slug: string;
    calls: number;
    succeeded: number;
    failed: number;
    blocked: number;
    failureRate: number;
  }[];
  /** Warning trong ngay bao cao (moi nhat truoc). */
  warnings: ComposioV120UsageWarning[];
  /** Headroom theo toolkit: so luot con lai truoc khi bi chan. */
  headroom: { toolkit: string; used: number; cap: number; remaining: number; severity: ComposioV120SoftLimitSeverity }[];
}

/** Lap bao cao su dung v2 tu state (ham thuan). */
export function buildComposioV120UsageReport(
  state: ComposioV120UsageState,
  opts: { day?: string; topN?: number; nowMs?: number } = {},
): ComposioV120UsageReport {
  const nowMs = opts.nowMs ?? Date.now();
  const day = opts.day ?? composioV119UsageDayKey(nowMs);
  const topN = opts.topN ?? COMPOSIO_V120_DEFAULT_TOP_N;
  const v119 = toComposioV119UsageState(state);
  const base = buildComposioV119UsageReport(v119, { day, topN, nowMs });

  const todayActions = state.actionCounters.filter((c) => c.day === day);
  const grouped = new Map<string, ComposioV120ActionCounter[]>();
  for (const c of todayActions) {
    const key = `${c.toolkit}|${c.slug}`;
    const list = grouped.get(key) ?? [];
    list.push(c);
    grouped.set(key, list);
  }
  const byAction = [...grouped.entries()]
    .map(([key, list]) => {
      const calls = list.reduce((n, c) => n + c.calls, 0);
      const failed = list.reduce((n, c) => n + c.failed, 0);
      const [toolkit, slug] = key.split('|');
      return {
        key,
        toolkit: toolkit as string,
        slug: slug as string,
        calls,
        succeeded: list.reduce((n, c) => n + c.succeeded, 0),
        failed,
        blocked: list.reduce((n, c) => n + c.blocked, 0),
        failureRate: calls === 0 ? 0 : failed / calls,
      };
    })
    .sort((a, b) => b.calls - a.calls)
    .slice(0, topN);

  const warnings = state.warnings.filter((w) => w.day === day).slice(0, topN);
  const headroom = base.byToolkit.map((t) => {
    const status = composioV120SoftLimitStatus('toolkit', t.calls, state.quota.dailyCapPerToolkit, state.thresholds);
    return { toolkit: t.key, used: t.calls, cap: state.quota.dailyCapPerToolkit, remaining: status.remaining, severity: status.severity };
  });

  return { ...base, byAction, warnings, headroom };
}

/** Tom tat usage v2 1 dong cho UI. */
export function summarizeComposioV120Usage(state: ComposioV120UsageState, nowMs: number = Date.now()): string {
  const day = composioV119UsageDayKey(nowMs);
  const report = buildComposioV120UsageReport(state, { day, nowMs });
  return `${day}: ${report.totalCalls} calls (${report.totalLiveCalls} live, ${report.totalMockCalls} mock), ${report.totalFailed} failed, ${report.totalBlocked} blocked, ${report.warnings.length} warnings, ${report.overQuota.length} over quota.`;
}

// ---------------------------------------------------------------------------
// Store — memory + JSON file (atomic, mode 0600)
// ---------------------------------------------------------------------------

/** Interface store usage v2. */
export interface ComposioV120UsageStore {
  load(): ComposioV120UsageState;
  save(state: ComposioV120UsageState): void;
  clear(): void;
}

/** Store trong bo nho — de test + host khong co userData dir. */
export class MemoryComposioV120UsageStore implements ComposioV120UsageStore {
  private state: ComposioV120UsageState;

  constructor(quota?: Partial<ComposioV119Quota>, opts?: { perUserQuota?: Readonly<Record<string, Partial<ComposioV119Quota>>>; thresholds?: Partial<ComposioV120SoftLimitThresholds>; maxDaysKept?: number }) {
    this.state = createComposioV120UsageState(quota, opts);
  }

  load(): ComposioV120UsageState {
    return JSON.parse(JSON.stringify(this.state)) as ComposioV120UsageState;
  }

  save(state: ComposioV120UsageState): void {
    const valid = validateComposioV120UsageState(state);
    this.state = JSON.parse(JSON.stringify(valid)) as ComposioV120UsageState;
  }

  clear(): void {
    this.state = createComposioV120UsageState(this.state.quota, {
      perUserQuota: this.state.perUserQuota,
      thresholds: this.state.thresholds,
      maxDaysKept: this.state.maxDaysKept,
    });
  }
}

/** Duong dan file usage v2. */
export function getComposioV120UsagePath(dir: string): string {
  return path.join(dir, COMPOSIO_V120_USAGE_FILE);
}

/** Store tren dia (file JSON atomic, mode 0600). */
export class JsonFileComposioV120UsageStore implements ComposioV120UsageStore {
  private readonly filePath: string;

  constructor(dir: string) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new Error('usage v2 store dir must be a non-empty string');
    }
    this.filePath = getComposioV120UsagePath(dir);
  }

  /** Duong dan file dang dung (de UI/log hien). */
  get path(): string {
    return this.filePath;
  }

  load(): ComposioV120UsageState {
    if (!fs.existsSync(this.filePath)) return createComposioV120UsageState();
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    return validateComposioV120UsageState(raw);
  }

  save(state: ComposioV120UsageState): void {
    const valid = validateComposioV120UsageState(state);
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
