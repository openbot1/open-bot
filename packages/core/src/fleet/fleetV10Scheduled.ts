/**
 * Fleet v10 — scheduled agents, timezone-aware (v1.13, Doi T6).
 *
 * Tang tren fleet v9 (`fleetV9Scheduler.ts`): v9 da co cron/interval/
 * once/window + retry/backoff + gioi han CPU/RAM, nhung cron cua v9
 * chay theo gio he thong (local time cua may) — khong co mui gio
 * rieng cho tung lich. Module nay them:
 * - Cron 5 truong theo MUI GIO IANA rieng (`Asia/Ho_Chi_Minh`,
 *   `America/New_York`, ...) — tinh bang `Intl.DateTimeFormat`,
 *   khong them dependency. Xu ly dung DST: gio wall-clock khong ton
 *   tai (spring forward) thi bo qua phut do; gio lap lai (fall back)
 *   thi chay o lan xuat hien dau tien.
 * - Lich su chay day du: moi lan chay la 1 ban ghi (`running` ->
 *   `done`/`failed`/`skipped-running`/`missed`), retry theo cap so
 *   nhan co chan tren, skip khi agent dang chay (neu `skipIfRunning`).
 * - Chinh sach bo lo: lich toi gio ma host tat thi chi ghi TOI DA 1
 *   lan `missed` cho moi lich tai moi tick (khong bao gio bu theo cap
 *   so nhan — cung luat chong burst nhu v9/automations).
 * - Ham thuan + luu file tach rieng: `tickFleetV10Scheduler(now,
 *   state, runningAgentIds)` la ham thuan, khong spawn process,
 *   khong cham mang. File ben: `fleet-schedules-v113.json` +
 *   `fleet-scheduled-runs-v113.json` duoi fleet root (atomic tmp +
 *   rename, mode 0600). Khong chua secret.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  fleetV6CronMatches,
  parseFleetV6CronField,
  validateFleetV6Cron,
  type FleetV6CronExpression,
} from './fleetV6Scheduler';

/** File luu lich v10 trong fleet root. */
export const FLEET_V10_SCHEDULES_FILE = 'fleet-schedules-v113.json';
/** File luu lich su chay lich v10 trong fleet root. */
export const FLEET_V10_SCHEDULED_RUNS_FILE = 'fleet-scheduled-runs-v113.json';
/** Gioi han so lich trong mot fleet root. */
export const FLEET_V10_MAX_SCHEDULES = 200;
/** Gioi han so ban ghi lich su chay duoc giu. */
export const FLEET_V10_MAX_SCHEDULED_RUNS = 1000;
/** So lan thu lai mac dinh khi chay loi. */
export const FLEET_V10_DEFAULT_MAX_ATTEMPTS = 3;
/** Backoff co so mac dinh giua cac lan thu lai. */
export const FLEET_V10_DEFAULT_BACKOFF_MS = 30_000;
/** He so nhan backoff mac dinh. */
export const FLEET_V10_DEFAULT_BACKOFF_MULTIPLIER = 2;
/** Chan tren backoff mac dinh: 15 phut. */
export const FLEET_V10_DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000;
/** Mui gio mac dinh: gio he thong (UTC khi khong biet). */
export const FLEET_V10_DEFAULT_TIMEZONE = 'UTC';

/** Loai lich chay dinh ky. */
export type FleetV10ScheduleKind = 'cron' | 'interval' | 'once';

export const FLEET_V10_SCHEDULE_KINDS: readonly FleetV10ScheduleKind[] = [
  'cron',
  'interval',
  'once',
];

/** Mot lich chay dinh ky cho mot agent. */
export interface FleetV10Schedule {
  /** Id on dinh: `fsch-<uuid>`. */
  id: string;
  /** Ten hien thi (duy nhat trong fleet root). */
  name: string;
  /** Agent (bot) se chay khi lich toi gio. */
  agentId: string;
  /** User so huu lich (dung de phan quyen + quota). */
  ownerUserId: string;
  kind: FleetV10ScheduleKind;
  /** Cron 5 truong `m h dom mon dow` (chi kind cron). */
  cron?: string;
  /** Mui gio IANA ap dung cho cron (chi kind cron). */
  timezone: string;
  /** Lap lai moi N ms (chi kind interval). */
  intervalMs?: number;
  /** Epoch ms chay 1 lan (chi kind once). */
  runAtMs?: number;
  enabled: boolean;
  /** true = bo qua lan chay neu agent dang chay; false = cho doi. */
  skipIfRunning: boolean;
  /** So lan thu toi da khi chay loi (bao gom lan dau). */
  maxAttempts: number;
  /** Backoff co so giua cac lan thu lai. */
  backoffMs: number;
  /** He so nhan backoff moi lan thu. */
  backoffMultiplier: number;
  /** Chan tren backoff. */
  maxBackoffMs: number;
  /** Epoch ms lan chay gan nhat (null = chua chay). */
  lastRunAt: number | null;
  /** Epoch ms lan chay ke tiep (null = khong con lich). */
  nextRunAt: number | null;
  /** So loi lien tiep (reset ve 0 khi chay thanh cong). */
  consecutiveFailures: number;
  /** Lan thu hien tai cua chuoi retry (0 = khong retry). */
  attempt: number;
  /** Epoch ms mo lai retry (null = khong cho retry). */
  retryAt: number | null;
  /** Tong so lan chay (ke ca loi). */
  totalRuns: number;
  /** Tong so lan chay loi. */
  totalFailures: number;
  /** Tong so lan bi bo lo (host tat / vuot grace). */
  missedRuns: number;
  createdAt: number;
  updatedAt: number;
}

/** Dau vao tao lich (id + thoi gian do ham tao). */
export interface CreateFleetV10ScheduleInput {
  name: string;
  agentId: string;
  ownerUserId: string;
  kind: FleetV10ScheduleKind;
  cron?: string;
  timezone?: string;
  intervalMs?: number;
  runAtMs?: number;
  enabled?: boolean;
  skipIfRunning?: boolean;
  maxAttempts?: number;
  backoffMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
}

/** Trang thai mot lan chay lich. */
export type FleetV10RunStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped-running'
  | 'missed';

export const FLEET_V10_RUN_STATUSES: readonly FleetV10RunStatus[] = [
  'running',
  'done',
  'failed',
  'skipped-running',
  'missed',
];

/** Mot ban ghi lich su chay lich. */
export interface FleetV10ScheduledRun {
  id: string;
  scheduleId: string;
  status: FleetV10RunStatus;
  /** Lan thu thu may (1 = lan dau). */
  attempt: number;
  startedAt: number;
  finishedAt: number | null;
  /** Loi (chi khi failed). */
  error?: string;
  /** Ly do bo qua / bo lo (chi skipped-running / missed). */
  reason?: string;
}

/** Ket qua 1 tick cua scheduler (ham thuan). */
export interface FleetV10TickResult {
  /** Lich toi gio -> bat dau chay (da ghi run `running`). */
  started: FleetV10ScheduledRun[];
  /** Lich toi gio nhung agent dang chay va `skipIfRunning` = true. */
  skippedRunning: FleetV10ScheduledRun[];
  /** Lich toi gio nhung da lo qua grace -> ghi `missed`, khong chay. */
  missed: FleetV10ScheduledRun[];
  /** Retry toi gio -> mo lai thanh run `running` moi. */
  retried: FleetV10ScheduledRun[];
}

/** Tom tat lich + lich su chay cho UI. */
export interface FleetV10SchedulingSummary {
  total: number;
  enabled: number;
  dueNext24h: number;
  running: number;
  failedLast24h: number;
  missedLast24h: number;
  skippedLast24h: number;
}

// --- Helper -----------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// --- Mui gio (IANA) ------------------------------------------------------------

/** Kiem tra mot mui gio IANA co hop le khong (Intl nem loi khi sai). */
export function isValidFleetV10Timezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Do lech (ms) cua mui gio so voi UTC tai thoi diem `utcMs`.
 * Vi du `Asia/Ho_Chi_Minh` -> +7h = 25_200_000. Dung
 * `Intl.DateTimeFormat` nen tu dong dung DST cua mui gio do.
 */
export function fleetV10TimezoneOffsetMs(timezone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  // Lam tron ve giay de tranh lech do mili-giay.
  return Math.round((wallAsUtc - Math.floor(utcMs / 1000) * 1000) / 1000) * 1000;
}

/**
 * Doi thoi gian wall-clock trong mui gio thanh epoch ms (UTC).
 * Giai bang lap: bat dau tu wall nhu UTC, hieu chinh bang offset
 * (2 vong lap la du vi offset thay doi toi da 1-2h tai bien DST).
 * Gio wall-clock khong ton tai (spring forward) tra ve thoi diem
 * hop le gan nhat sau do (offset sau bien DST).
 */
export function fleetV10ZonedTimeToUtcMs(
  timezone: string,
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const offset = fleetV10TimezoneOffsetMs(timezone, guess);
    const next = Date.UTC(year, month - 1, day, hour, minute) - offset;
    if (next === guess) return next;
    guess = next;
  }
  return guess;
}

/** Cac thanh phan wall-clock cua mot thoi diem trong mui gio. */
export function fleetV10ZonedParts(
  timezone: string,
  utcMs: number,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string): string => parts.find((x) => x.type === type)?.value ?? '0';
  const weekdayName = get('weekday');
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: weekday < 0 ? 0 : weekday,
  };
}

// --- Cron ---------------------------------------------------------------------

/** Parse cron 5 truong thanh bieu thuc v6 (nem loi khi sai). */
export function parseFleetV10CronString(expression: string): FleetV6CronExpression {
  if (!isNonEmptyString(expression)) throw new Error('cron expression must be a non-empty string.');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (m h dom mon dow), got ${fields.length}.`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const expr: FleetV6CronExpression = { minute, hour, dayOfMonth, month, dayOfWeek };
  return validateFleetV6Cron(expr);
}

/** Kiem tra mot bieu thuc cron 5 truong (khong nem loi). */
export function isValidFleetV10CronString(expression: string): boolean {
  try {
    parseFleetV10CronString(expression);
    return true;
  } catch {
    return false;
  }
}

/** Mot thoi diem wall-clock (trong mui gio) co khop cron khong. */
export function fleetV10CronMatchesInTimezone(
  expr: FleetV6CronExpression,
  timezone: string,
  utcMs: number,
): boolean {
  const parts = fleetV10ZonedParts(timezone, utcMs);
  const minute = parseFleetV6CronField(expr.minute, 0, 59);
  const hour = parseFleetV6CronField(expr.hour, 0, 23);
  const dom = parseFleetV6CronField(expr.dayOfMonth, 1, 31);
  const month = parseFleetV6CronField(expr.month, 1, 12);
  const dow = parseFleetV6CronField(expr.dayOfWeek, 0, 7);
  const dowHit = dow.has(parts.weekday) || (parts.weekday === 0 && dow.has(7));
  return (
    minute.has(parts.minute) &&
    hour.has(parts.hour) &&
    dom.has(parts.day) &&
    month.has(parts.month) &&
    dowHit
  );
}

/**
 * Lan chay cron ke tiep sau `fromMs` (khong bao gom chinh `fromMs`),
 * tinh theo mui gio. Quet theo phut wall-clock, toi da 366 ngay.
 * Gio wall-clock khong ton tai (spring forward) tu dong bi bo qua vi
 * khong co thoi diem UTC nao anh xa ve phut do.
 */
export function nextFleetV10CronRun(
  expression: string,
  timezone: string,
  fromMs: number,
): number {
  const expr = parseFleetV10CronString(expression);
  if (!isValidFleetV10Timezone(timezone)) throw new Error(`unknown timezone: ${timezone}`);
  if (!Number.isFinite(fromMs)) throw new Error('nextFleetV10CronRun needs a finite fromMs.');
  // Bat dau tu phut wall-clock ke tiep sau fromMs.
  const startParts = fleetV10ZonedParts(timezone, fromMs);
  let cursor = fleetV10ZonedTimeToUtcMs(timezone, startParts.year, startParts.month, startParts.day, startParts.hour, startParts.minute) + 60_000;
  const limit = fromMs + 366 * 24 * 60 * 60 * 1000;
  while (cursor <= limit) {
    if (fleetV10CronMatchesInTimezone(expr, timezone, cursor)) {
      // Kiem tra nguoc: phut wall-clock cua cursor phai dung la phut
      // dang xet (tranh truong hop DST day cursor sang phut khac).
      const p = fleetV10ZonedParts(timezone, cursor);
      const wallMinuteStart = fleetV10ZonedTimeToUtcMs(timezone, p.year, p.month, p.day, p.hour, p.minute);
      if (wallMinuteStart === cursor) return cursor;
      // Neu cursor khong nam dung dau phut wall-clock (gio khong ton
      // tai), nhay toi phut wall-clock ke tiep.
      cursor = wallMinuteStart + 60_000;
      continue;
    }
    // Nhay theo phut wall-clock: cong 60s vao thoi gian wall-clock
    // hien tai roi doi lai UTC (dung qua bien DST).
    const p = fleetV10ZonedParts(timezone, cursor);
    const totalMinutes = p.hour * 60 + p.minute + 1;
    const nextHour = Math.floor(totalMinutes / 60);
    const nextMinute = totalMinutes % 60;
    if (nextHour >= 24) {
      const nextDay = new Date(Date.UTC(p.year, p.month - 1, p.day));
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      cursor = fleetV10ZonedTimeToUtcMs(timezone, nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, 0);
    } else {
      cursor = fleetV10ZonedTimeToUtcMs(timezone, p.year, p.month, p.day, nextHour, nextMinute);
    }
  }
  throw new Error('no next cron run within 366 days.');
}

// --- Validate + tao ------------------------------------------------------------

/** Backoff retry: cap so nhan co chan tren, xac dinh. */
export function fleetV10RetryBackoffMs(
  schedule: Pick<FleetV10Schedule, 'backoffMs' | 'backoffMultiplier' | 'maxBackoffMs'>,
  attempt: number,
): number {
  const raw = schedule.backoffMs * Math.pow(schedule.backoffMultiplier, Math.max(0, attempt - 1));
  return Math.min(Math.max(0, Math.floor(raw)), schedule.maxBackoffMs);
}

/** Lan chay ke tiep cua mot lich (null khi khong con lich / bi tat). */
export function nextRunForFleetV10Schedule(
  schedule: FleetV10Schedule,
  fromMs: number,
): number | null {
  if (!schedule.enabled) return null;
  if (schedule.kind === 'cron' && schedule.cron) {
    return nextFleetV10CronRun(schedule.cron, schedule.timezone, fromMs);
  }
  if (schedule.kind === 'interval' && schedule.intervalMs) {
    const base = schedule.lastRunAt ?? schedule.createdAt;
    const next = base + schedule.intervalMs;
    return next > fromMs ? next : fromMs + schedule.intervalMs;
  }
  if (schedule.kind === 'once' && schedule.runAtMs !== undefined) {
    if (schedule.lastRunAt !== null) return null;
    return schedule.runAtMs > fromMs ? schedule.runAtMs : null;
  }
  return null;
}

/** Validate mot lich day du (nem loi khi truong nao hong). */
export function validateFleetV10Schedule(raw: unknown): FleetV10Schedule {
  if (!isRecord(raw)) throw new Error('fleet v10 schedule must be an object.');
  const {
    id, name, agentId, ownerUserId, kind, cron, timezone, intervalMs, runAtMs,
    enabled, skipIfRunning, maxAttempts, backoffMs, backoffMultiplier, maxBackoffMs,
    lastRunAt, nextRunAt, consecutiveFailures, attempt, retryAt,
    totalRuns, totalFailures, missedRuns, createdAt, updatedAt,
  } = raw;
  if (!isNonEmptyString(id)) throw new Error('schedule needs a non-empty id.');
  if (!isNonEmptyString(name)) throw new Error('schedule needs a non-empty name.');
  if (!isNonEmptyString(agentId)) throw new Error('schedule needs a non-empty agentId.');
  if (!isNonEmptyString(ownerUserId)) throw new Error('schedule needs a non-empty ownerUserId.');
  if (!FLEET_V10_SCHEDULE_KINDS.includes(kind as FleetV10ScheduleKind)) {
    throw new Error(`schedule kind must be one of: ${FLEET_V10_SCHEDULE_KINDS.join(', ')}.`);
  }
  if (!isNonEmptyString(timezone) || !isValidFleetV10Timezone(timezone as string)) {
    throw new Error(`schedule timezone must be a valid IANA timezone, got: ${String(timezone)}`);
  }
  let validCron: string | undefined;
  let validInterval: number | undefined;
  let validRunAt: number | undefined;
  if (kind === 'cron') {
    if (!isNonEmptyString(cron)) throw new Error('cron schedule needs a cron expression.');
    parseFleetV10CronString(cron as string);
    validCron = (cron as string).trim();
  }
  if (kind === 'interval') {
    if (!isPositiveInt(intervalMs)) throw new Error('interval schedule needs intervalMs > 0.');
    validInterval = intervalMs as number;
  }
  if (kind === 'once') {
    if (!isNonNegativeInt(runAtMs)) throw new Error('once schedule needs runAtMs >= 0.');
    validRunAt = runAtMs as number;
  }
  if (typeof enabled !== 'boolean') throw new Error('schedule enabled must be a boolean.');
  if (typeof skipIfRunning !== 'boolean') throw new Error('schedule skipIfRunning must be a boolean.');
  if (!isPositiveInt(maxAttempts)) throw new Error('schedule maxAttempts must be an integer > 0.');
  if (!isPositiveNumber(backoffMs)) throw new Error('schedule backoffMs must be a number > 0.');
  if (!isPositiveNumber(backoffMultiplier)) throw new Error('schedule backoffMultiplier must be a number > 0.');
  if (!isPositiveNumber(maxBackoffMs)) throw new Error('schedule maxBackoffMs must be a number > 0.');
  if (lastRunAt !== null && !isNonNegativeInt(lastRunAt)) throw new Error('schedule lastRunAt must be null or a non-negative integer.');
  if (nextRunAt !== null && !isNonNegativeInt(nextRunAt)) throw new Error('schedule nextRunAt must be null or a non-negative integer.');
  if (!isNonNegativeInt(consecutiveFailures)) throw new Error('schedule consecutiveFailures must be a non-negative integer.');
  if (!isNonNegativeInt(attempt)) throw new Error('schedule attempt must be a non-negative integer.');
  if (retryAt !== null && !isNonNegativeInt(retryAt)) throw new Error('schedule retryAt must be null or a non-negative integer.');
  if (!isNonNegativeInt(totalRuns)) throw new Error('schedule totalRuns must be a non-negative integer.');
  if (!isNonNegativeInt(totalFailures)) throw new Error('schedule totalFailures must be a non-negative integer.');
  if (!isNonNegativeInt(missedRuns)) throw new Error('schedule missedRuns must be a non-negative integer.');
  if (!isNonNegativeInt(createdAt)) throw new Error('schedule createdAt must be a non-negative integer.');
  if (!isNonNegativeInt(updatedAt)) throw new Error('schedule updatedAt must be a non-negative integer.');
  return {
    id: (id as string).trim(),
    name: (name as string).trim(),
    agentId: (agentId as string).trim(),
    ownerUserId: (ownerUserId as string).trim(),
    kind: kind as FleetV10ScheduleKind,
    ...(validCron ? { cron: validCron } : {}),
    timezone: (timezone as string).trim(),
    ...(validInterval !== undefined ? { intervalMs: validInterval } : {}),
    ...(validRunAt !== undefined ? { runAtMs: validRunAt } : {}),
    enabled,
    skipIfRunning,
    maxAttempts: maxAttempts as number,
    backoffMs: backoffMs as number,
    backoffMultiplier: backoffMultiplier as number,
    maxBackoffMs: maxBackoffMs as number,
    lastRunAt: lastRunAt as number | null,
    nextRunAt: nextRunAt as number | null,
    consecutiveFailures: consecutiveFailures as number,
    attempt: attempt as number,
    retryAt: retryAt as number | null,
    totalRuns: totalRuns as number,
    totalFailures: totalFailures as number,
    missedRuns: missedRuns as number,
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
  };
}

/** Tao mot lich moi (tinh san nextRunAt tu `now`). */
export function createFleetV10Schedule(
  input: CreateFleetV10ScheduleInput,
  now: number = Date.now(),
): FleetV10Schedule {
  if (!isNonEmptyString(input.name)) throw new Error('createFleetV10Schedule needs a non-empty name.');
  if (!isNonEmptyString(input.agentId)) throw new Error('createFleetV10Schedule needs a non-empty agentId.');
  if (!isNonEmptyString(input.ownerUserId)) throw new Error('createFleetV10Schedule needs a non-empty ownerUserId.');
  if (!FLEET_V10_SCHEDULE_KINDS.includes(input.kind)) {
    throw new Error(`schedule kind must be one of: ${FLEET_V10_SCHEDULE_KINDS.join(', ')}.`);
  }
  const timezone = (input.timezone ?? FLEET_V10_DEFAULT_TIMEZONE).trim();
  if (!isValidFleetV10Timezone(timezone)) throw new Error(`unknown timezone: ${timezone}`);
  const maxAttempts = input.maxAttempts ?? FLEET_V10_DEFAULT_MAX_ATTEMPTS;
  const backoffMs = input.backoffMs ?? FLEET_V10_DEFAULT_BACKOFF_MS;
  const backoffMultiplier = input.backoffMultiplier ?? FLEET_V10_DEFAULT_BACKOFF_MULTIPLIER;
  const maxBackoffMs = input.maxBackoffMs ?? FLEET_V10_DEFAULT_MAX_BACKOFF_MS;
  if (!isPositiveInt(maxAttempts)) throw new Error('maxAttempts must be an integer > 0.');
  if (!isPositiveNumber(backoffMs) || !isPositiveNumber(backoffMultiplier) || !isPositiveNumber(maxBackoffMs)) {
    throw new Error('backoffMs, backoffMultiplier and maxBackoffMs must be numbers > 0.');
  }
  let cron: string | undefined;
  let intervalMs: number | undefined;
  let runAtMs: number | undefined;
  if (input.kind === 'cron') {
    if (!isNonEmptyString(input.cron)) throw new Error('cron schedule needs a cron expression.');
    parseFleetV10CronString(input.cron);
    cron = input.cron.trim();
  }
  if (input.kind === 'interval') {
    if (!isPositiveInt(input.intervalMs)) throw new Error('interval schedule needs intervalMs > 0.');
    intervalMs = input.intervalMs;
  }
  if (input.kind === 'once') {
    if (!isNonNegativeInt(input.runAtMs)) throw new Error('once schedule needs runAtMs >= 0.');
    if ((input.runAtMs as number) <= now) throw new Error('once schedule runAtMs must be in the future.');
    runAtMs = input.runAtMs;
  }
  const enabled = input.enabled ?? true;
  const schedule: FleetV10Schedule = {
    id: `fsch-${crypto.randomUUID()}`,
    name: input.name.trim(),
    agentId: input.agentId.trim(),
    ownerUserId: input.ownerUserId.trim(),
    kind: input.kind,
    ...(cron ? { cron } : {}),
    timezone,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(runAtMs !== undefined ? { runAtMs } : {}),
    enabled,
    skipIfRunning: input.skipIfRunning ?? true,
    maxAttempts,
    backoffMs,
    backoffMultiplier,
    maxBackoffMs,
    lastRunAt: null,
    nextRunAt: null,
    consecutiveFailures: 0,
    attempt: 0,
    retryAt: null,
    totalRuns: 0,
    totalFailures: 0,
    missedRuns: 0,
    createdAt: now,
    updatedAt: now,
  };
  schedule.nextRunAt = nextRunForFleetV10Schedule(schedule, now);
  return schedule;
}

/** Mot lich co toi gio chay khong (nextRunAt <= now, chua retry-cho). */
export function isFleetV10ScheduleDue(schedule: FleetV10Schedule, now: number): boolean {
  return schedule.enabled && schedule.nextRunAt !== null && schedule.nextRunAt <= now;
}

/** Tim lich theo id (undefined khi khong co). */
export function findFleetV10Schedule(
  schedules: readonly FleetV10Schedule[],
  id: string,
): FleetV10Schedule | undefined {
  return schedules.find((s) => s.id === id);
}

/** Bat/tat lich (tra ve danh sach moi, tinh lai nextRunAt). */
export function setFleetV10ScheduleEnabled(
  schedules: readonly FleetV10Schedule[],
  id: string,
  enabled: boolean,
  now: number = Date.now(),
): FleetV10Schedule[] {
  const found = schedules.some((s) => s.id === id);
  if (!found) throw new Error(`schedule not found: ${id}`);
  return schedules.map((s) => {
    if (s.id !== id) return s;
    const next = { ...s, enabled, updatedAt: now };
    next.nextRunAt = nextRunForFleetV10Schedule(next, now);
    return next;
  });
}

/** Xoa lich (tra ve danh sach moi). */
export function removeFleetV10Schedule(
  schedules: readonly FleetV10Schedule[],
  id: string,
): FleetV10Schedule[] {
  const found = schedules.some((s) => s.id === id);
  if (!found) throw new Error(`schedule not found: ${id}`);
  return schedules.filter((s) => s.id !== id);
}

// --- Tick + run lifecycle -----------------------------------------------------

/** Trang thai day du ma tick can: lich + lich su chay. */
export interface FleetV10SchedulerState {
  schedules: FleetV10Schedule[];
  runs: FleetV10ScheduledRun[];
}

/**
 * Tick scheduler — ham thuan.
 *
 * Voi `now` cho truoc:
 * - Lich toi gio: neu agent dang chay (nam trong `runningAgentIds`)
 *   va `skipIfRunning` thi ghi `skipped-running` + tinh nextRunAt ke
 *   tiep (khong cho doi); neu khong skip thi van start (host tu xep
 *   hang o lop tren).
 * - Lich toi gio qua grace (`missedGraceMs`, mac dinh 5 phut) thi ghi
 *   TOI DA 1 lan `missed` roi tinh nextRunAt ke tiep (khong bu chay).
 * - Retry toi gio (`retryAt <= now`): mo lai thanh run `running` moi
 *   voi attempt tang dan.
 * - `once` chay xong thi nextRunAt = null (khong lap lai).
 *
 * Ham tra ve ca state moi (schedules + runs) lan ket qua tick; khong
 * spawn process, khong cham mang. Host chi can luu state + thuc thi
 * cac run `running` (goi `completeFleetV10Run` / `failFleetV10Run`
 * khi xong).
 */
export function tickFleetV10Scheduler(
  now: number,
  state: FleetV10SchedulerState,
  runningAgentIds: ReadonlySet<string> = new Set(),
  missedGraceMs: number = 5 * 60 * 1000,
): { state: FleetV10SchedulerState; result: FleetV10TickResult } {
  const result: FleetV10TickResult = { started: [], skippedRunning: [], missed: [], retried: [] };
  let runs = [...state.runs];
  const pushRun = (run: FleetV10ScheduledRun): void => {
    runs = [...runs, run];
    if (runs.length > FLEET_V10_MAX_SCHEDULED_RUNS) {
      runs = runs.slice(runs.length - FLEET_V10_MAX_SCHEDULED_RUNS);
    }
  };
  const schedules = state.schedules.map((schedule) => {
    if (!schedule.enabled) return schedule;
    // Retry toi gio: mo lai run moi (attempt tang).
    if (schedule.retryAt !== null && schedule.retryAt <= now && schedule.attempt > 0) {
      const run: FleetV10ScheduledRun = {
        id: `fsrun-${crypto.randomUUID()}`,
        scheduleId: schedule.id,
        status: 'running',
        attempt: schedule.attempt + 1,
        startedAt: now,
        finishedAt: null,
      };
      result.retried.push(run);
      pushRun(run);
      return {
        ...schedule,
        attempt: schedule.attempt + 1,
        retryAt: null,
        lastRunAt: now,
        totalRuns: schedule.totalRuns + 1,
        updatedAt: now,
      };
    }
    if (!isFleetV10ScheduleDue(schedule, now)) return schedule;
    const nextRunAt = schedule.nextRunAt as number;
    const lateBy = now - nextRunAt;
    // Lo qua grace: ghi missed, khong chay.
    if (lateBy > missedGraceMs) {
      const run: FleetV10ScheduledRun = {
        id: `fsrun-${crypto.randomUUID()}`,
        scheduleId: schedule.id,
        status: 'missed',
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        reason: `missed by ${lateBy}ms (grace ${missedGraceMs}ms)`,
      };
      result.missed.push(run);
      pushRun(run);
      const advanced = { ...schedule, missedRuns: schedule.missedRuns + 1, updatedAt: now };
      advanced.nextRunAt = nextRunForFleetV10Schedule(advanced, now);
      return advanced;
    }
    // Agent dang chay + skipIfRunning: bo qua lan nay.
    if (schedule.skipIfRunning && runningAgentIds.has(schedule.agentId)) {
      const run: FleetV10ScheduledRun = {
        id: `fsrun-${crypto.randomUUID()}`,
        scheduleId: schedule.id,
        status: 'skipped-running',
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        reason: `agent ${schedule.agentId} is already running`,
      };
      result.skippedRunning.push(run);
      pushRun(run);
      const advanced = { ...schedule, updatedAt: now };
      advanced.nextRunAt = nextRunForFleetV10Schedule(advanced, now);
      return advanced;
    }
    const run: FleetV10ScheduledRun = {
      id: `fsrun-${crypto.randomUUID()}`,
      scheduleId: schedule.id,
      status: 'running',
      attempt: 1,
      startedAt: now,
      finishedAt: null,
    };
    result.started.push(run);
    pushRun(run);
    const started = {
      ...schedule,
      lastRunAt: now,
      attempt: 1,
      retryAt: null,
      totalRuns: schedule.totalRuns + 1,
      updatedAt: now,
    };
    started.nextRunAt = nextRunForFleetV10Schedule(started, now);
    return started;
  });
  return { state: { schedules, runs }, result };
}

/** Danh dau mot run chay xong thanh cong (reset loi lien tiep + retry). */
export function completeFleetV10Run(
  state: FleetV10SchedulerState,
  runId: string,
  now: number = Date.now(),
): FleetV10SchedulerState {
  const run = state.runs.find((r) => r.id === runId);
  if (!run) throw new Error(`scheduled run not found: ${runId}`);
  if (run.status !== 'running') throw new Error(`scheduled run ${runId} is not running (status: ${run.status}).`);
  return {
    schedules: state.schedules.map((s) =>
      s.id === run.scheduleId
        ? { ...s, consecutiveFailures: 0, attempt: 0, retryAt: null, updatedAt: now }
        : s,
    ),
    runs: state.runs.map((r) =>
      r.id === runId ? { ...r, status: 'done', finishedAt: now } : r,
    ),
  };
}

/**
 * Danh dau mot run chay loi. Con luot retry thi dat `retryAt` theo
 * backoff cap so nhan (attempt tang o tick mo lai); het luot thi
 * ghi ro `consecutiveFailures` va tra ve `exhausted: true`.
 */
export function failFleetV10Run(
  state: FleetV10SchedulerState,
  runId: string,
  error: string,
  now: number = Date.now(),
): { state: FleetV10SchedulerState; exhausted: boolean } {
  const run = state.runs.find((r) => r.id === runId);
  if (!run) throw new Error(`scheduled run not found: ${runId}`);
  if (run.status !== 'running') throw new Error(`scheduled run ${runId} is not running (status: ${run.status}).`);
  const schedule = state.schedules.find((s) => s.id === run.scheduleId);
  if (!schedule) throw new Error(`schedule not found for run: ${run.scheduleId}`);
  const exhausted = run.attempt >= schedule.maxAttempts;
  const retryAt = exhausted ? null : now + fleetV10RetryBackoffMs(schedule, run.attempt);
  return {
    state: {
      schedules: state.schedules.map((s) =>
        s.id === schedule.id
          ? {
              ...s,
              consecutiveFailures: s.consecutiveFailures + 1,
              totalFailures: s.totalFailures + 1,
              attempt: run.attempt,
              retryAt,
              updatedAt: now,
            }
          : s,
      ),
      runs: state.runs.map((r) =>
        r.id === runId ? { ...r, status: 'failed', finishedAt: now, error } : r,
      ),
    },
    exhausted,
  };
}

/** Tom tat lich + lich su chay 24h qua cho UI. */
export function summarizeFleetV10Scheduling(
  schedules: readonly FleetV10Schedule[],
  runs: readonly FleetV10ScheduledRun[],
  now: number,
): FleetV10SchedulingSummary {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let running = 0;
  let failed = 0;
  let missed = 0;
  let skipped = 0;
  for (const r of runs) {
    if (r.status === 'running') running++;
    if (r.startedAt < dayAgo) continue;
    if (r.status === 'failed') failed++;
    else if (r.status === 'missed') missed++;
    else if (r.status === 'skipped-running') skipped++;
  }
  return {
    total: schedules.length,
    enabled: schedules.filter((s) => s.enabled).length,
    dueNext24h: schedules.filter(
      (s) => s.enabled && s.nextRunAt !== null && s.nextRunAt > now && s.nextRunAt <= now + 24 * 60 * 60 * 1000,
    ).length,
    running,
    failedLast24h: failed,
    missedLast24h: missed,
    skippedLast24h: skipped,
  };
}

// --- Persistence ---------------------------------------------------------------

export function getFleetV10SchedulesPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V10_SCHEDULES_FILE);
}

export function getFleetV10ScheduledRunsPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V10_SCHEDULED_RUNS_FILE);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows khong co chmod POSIX — bo qua.
  }
}

function loadJsonArray<T>(filePath: string, validate: (raw: unknown) => T): T[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: T[] = [];
  for (const item of parsed) {
    try {
      out.push(validate(item));
    } catch {
      // Ban ghi hong thi bo qua thay vi lam hong ca file.
    }
  }
  return out;
}

/** Doc lich tu fleet root (file hong/missing = danh sach rong). */
export function loadFleetV10Schedules(fleetRoot: string): FleetV10Schedule[] {
  return loadJsonArray(getFleetV10SchedulesPath(fleetRoot), validateFleetV10Schedule);
}

/** Ghi lich xuong fleet root (atomic, mode 0600). */
export function saveFleetV10Schedules(fleetRoot: string, schedules: readonly FleetV10Schedule[]): void {
  if (schedules.length > FLEET_V10_MAX_SCHEDULES) {
    throw new Error(`too many schedules: ${schedules.length} > ${FLEET_V10_MAX_SCHEDULES}`);
  }
  atomicWriteJson(getFleetV10SchedulesPath(fleetRoot), schedules.map((s) => validateFleetV10Schedule(s)));
}

function validateFleetV10ScheduledRun(raw: unknown): FleetV10ScheduledRun {
  if (!isRecord(raw)) throw new Error('scheduled run must be an object.');
  const { id, scheduleId, status, attempt, startedAt, finishedAt, error, reason } = raw;
  if (!isNonEmptyString(id) || !isNonEmptyString(scheduleId)) {
    throw new Error('scheduled run needs non-empty id and scheduleId.');
  }
  if (!FLEET_V10_RUN_STATUSES.includes(status as FleetV10RunStatus)) {
    throw new Error(`scheduled run status must be one of: ${FLEET_V10_RUN_STATUSES.join(', ')}.`);
  }
  if (!isPositiveInt(attempt)) throw new Error('scheduled run attempt must be an integer > 0.');
  if (!isNonNegativeInt(startedAt)) throw new Error('scheduled run startedAt must be a non-negative integer.');
  if (finishedAt !== null && !isNonNegativeInt(finishedAt)) throw new Error('scheduled run finishedAt must be null or a non-negative integer.');
  if (error !== undefined && !isNonEmptyString(error)) throw new Error('scheduled run error must be a non-empty string.');
  if (reason !== undefined && !isNonEmptyString(reason)) throw new Error('scheduled run reason must be a non-empty string.');
  return {
    id: id as string,
    scheduleId: scheduleId as string,
    status: status as FleetV10RunStatus,
    attempt: attempt as number,
    startedAt: startedAt as number,
    finishedAt: finishedAt as number | null,
    ...(error !== undefined ? { error: error as string } : {}),
    ...(reason !== undefined ? { reason: reason as string } : {}),
  };
}

/** Doc lich su chay lich (file hong/missing = rong). */
export function loadFleetV10ScheduledRuns(fleetRoot: string): FleetV10ScheduledRun[] {
  return loadJsonArray(getFleetV10ScheduledRunsPath(fleetRoot), validateFleetV10ScheduledRun);
}

/** Ghi lich su chay lich (atomic, mode 0600, cat bot khi vuot gioi han). */
export function saveFleetV10ScheduledRuns(fleetRoot: string, runs: readonly FleetV10ScheduledRun[]): void {
  const trimmed = runs.length > FLEET_V10_MAX_SCHEDULED_RUNS
    ? runs.slice(runs.length - FLEET_V10_MAX_SCHEDULED_RUNS)
    : runs;
  atomicWriteJson(getFleetV10ScheduledRunsPath(fleetRoot), trimmed);
}
