/**
 * Fleet scheduling v2 (v1.12, Doi T6).
 *
 * Tang tren fleet v6 (`fleetV6Scheduler.ts`) va botScheduling v2, tra loi
 * them 3 cau hoi ma v6 chua tra loi day du:
 *
 * 1. LICH THEO NHIEU DANG: ngoai cron/interval/event cua v6, v9 them
 *    `once` (chay mot lan tai thoi diem cu the) va `window` (moi ngay chi
 *    chay trong mot khung gio, vd 02:00-04:00, de chay viec nang luc may
 *    ranh). Moi schedule giu `nextRunAt` cua rieng no, tinh bang ham thuan.
 * 2. GIOI HAN DONG THOI THEO CPU/RAM HOST THAT: `pickNextFleetV9Entry`
 *    khong chi dem so bot dang chay ma cong don CPU/RAM da dat truoc;
 *    mot entry chi duoc start khi ca CPU lan RAM con du, va hai bot
 *    "nang" khong bao gio chay chong nhau (giong luat heavy cua v6 nhung
 *    ap dung ca cho queue chay tay, khong chi day-plan).
 * 3. RETRY/BACKOFF CO CAU TRUC: entry that duoc retry theo cap so nhan
 *    (`backoff * multiplier^attempt`, chan tren, khong random — xac
 *    dinh de test duoc), ghi ro ly do het luot retry thay vi roi
 *    am tham ve `failed`.
 *
 * Ham thuan + luu file tach rieng nhu cac module fleet truoc:
 * - `tickFleetV9Scheduler(now, state)` la ham thuan: voi `now` cho
 *   truoc, tra ve hanh dong (schedule nao toi gio -> enqueue, entry nao
 *   duoc start, entry retry-waiting nao toi gio mo lai). Khong spawn
 *   process, khong cham mang.
 * - File ben: `fleet-schedules-v112.json` + `fleet-queue-v112.json`
 *   duoi fleet root (atomic tmp + rename, mode 0600, cung tu the voi
 *   fleet-schedules-v109.json / fleet-queue-v109.json). Khong chua secret.
 * - Chinh sach bo lo (missed-run): schedule toi gio ma host tat thi
 *   chi enqueue TOI DA 1 lan cho moi schedule tai moi tick (khong bao gio
 *   bu theo cap so nhan so lan da lo — cung luat chong burst nhu
 *   automations scheduler), ghi `missedRuns` vao summary de UI thay.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BOT_PRIORITIES, BOT_PRIORITY_WEIGHTS, type BotPriority } from './botScheduling';
import {
  fleetV6CronMatches,
  nextFleetV6CronRun,
  validateFleetV6Cron,
  type FleetV6CronExpression,
} from './fleetV6Scheduler';

/** File luu lich v9 trong fleet root. */
export const FLEET_V9_SCHEDULES_FILE = 'fleet-schedules-v112.json';
/** File luu hang doi v9 trong fleet root. */
export const FLEET_V9_QUEUE_FILE = 'fleet-queue-v112.json';
/** So bot chay dong thoi toi da tren mot may khi khong cau hinh khac. */
export const FLEET_V9_DEFAULT_MAX_CONCURRENT = 4;
/** So bot nang chay dong thoi toi da (luon 1: hai bot nang khong chong nhau). */
export const FLEET_V9_DEFAULT_MAX_HEAVY_CONCURRENT = 1;
/** Sau tung nay ms cho, mot queue entry duoc cong 1 bac uu tien hieu dung. */
export const FLEET_V9_DEFAULT_AGING_MS = 60_000;
/** So lan retry mac dinh khi mot entry that (khong tinh lan chay dau). */
export const FLEET_V9_DEFAULT_MAX_ATTEMPTS = 3;
/** Backoff co so giua cac lan retry (ms). */
export const FLEET_V9_DEFAULT_BACKOFF_MS = 30_000;
/** He so nhan backoff sau moi lan that. */
export const FLEET_V9_DEFAULT_BACKOFF_MULTIPLIER = 2;
/** Tran tren backoff (ms) — retry khong bao gio cho lau hon muc nay. */
export const FLEET_V9_DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000;
/** Mot bot duoc coi la "nang" khi can tu muc nay tro len. */
export const FLEET_V9_HEAVY_CPU_CORES = 2;
/** RAM (bytes) tu muc nay tro len thi bot duoc coi la nang. */
export const FLEET_V9_HEAVY_RAM_BYTES = 4 * 1024 ** 3;
/** Do dai timeslot mac dinh khi lap lich ngay (ms). */
export const FLEET_V9_DEFAULT_SLOT_MS = 15 * 60 * 1000;
/** So entry toi da trong mot file queue (chan file phong len vo han). */
export const FLEET_V9_MAX_QUEUE_ENTRIES = 500;
/** So schedule toi da trong mot file lich. */
export const FLEET_V9_MAX_SCHEDULES = 200;

/** Loai lich v9. */
export type FleetV9ScheduleKind = 'cron' | 'interval' | 'once' | 'window';

export const FLEET_V9_SCHEDULE_KINDS: readonly FleetV9ScheduleKind[] = [
  'cron',
  'interval',
  'once',
  'window',
];

/** Tai nguyen mot lan chay can (dat truoc truoc khi start). */
export interface FleetV9RunResources {
  /** So CPU core can (co the la so thap phan, vd 0.5). */
  cpuCores: number;
  /** RAM can (bytes). */
  ramBytes: number;
}

/** Suc chua cua may chu (host) dung de gioi han dong thoi. */
export interface FleetV9HostCapacity {
  /** Tong CPU core cua may (0 = khong biet, khong gioi han theo CPU). */
  cpuCores: number;
  /** Tong RAM cua may (bytes, 0 = khong biet). */
  ramBytes: number;
  /** So bot chay dong thoi toi da (0 = dung mac dinh cua policy). */
  maxConcurrent: number;
}

/** Khung gio trong ngay (giong cron nhung chi gio:phut, theo gio dia phuong cua host). */
export interface FleetV9TimeWindow {
  /** Gio bat dau khung (0-23). */
  startHour: number;
  /** Phut bat dau khung (0-59). */
  startMinute: number;
  /** Gio ket thuc khung (0-23). */
  endHour: number;
  /** Phut ket thuc khung (0-59). */
  endMinute: number;
}

/** Chinh sach scheduler v9. */
export interface FleetV9SchedulerPolicy {
  /** So bot chay dong thoi toi da. */
  maxConcurrent: number;
  /** So bot chay dong thoi toi da cho cung mot botId. */
  maxConcurrentPerBot: number;
  /** So bot nang chay dong thoi toi da. */
  maxHeavyConcurrent: number;
  /** Ms cho de duoc cong 1 bac uu tien hieu dung (chong doi). */
  agingMs: number;
  /** So lan retry mac dinh. */
  defaultMaxAttempts: number;
  /** Backoff co so giua cac retry (ms). */
  defaultBackoffMs: number;
  /** He so nhan backoff. */
  backoffMultiplier: number;
  /** Tran tren backoff (ms). */
  maxBackoffMs: number;
}

export const DEFAULT_FLEET_V9_SCHEDULER_POLICY: FleetV9SchedulerPolicy = {
  maxConcurrent: FLEET_V9_DEFAULT_MAX_CONCURRENT,
  maxConcurrentPerBot: 1,
  maxHeavyConcurrent: FLEET_V9_DEFAULT_MAX_HEAVY_CONCURRENT,
  agingMs: FLEET_V9_DEFAULT_AGING_MS,
  defaultMaxAttempts: FLEET_V9_DEFAULT_MAX_ATTEMPTS,
  defaultBackoffMs: FLEET_V9_DEFAULT_BACKOFF_MS,
  backoffMultiplier: FLEET_V9_DEFAULT_BACKOFF_MULTIPLIER,
  maxBackoffMs: FLEET_V9_DEFAULT_MAX_BACKOFF_MS,
};

export const DEFAULT_FLEET_V9_HOST_CAPACITY: FleetV9HostCapacity = {
  cpuCores: 0,
  ramBytes: 0,
  maxConcurrent: 0,
};

/** Mot lich chay dinh ky cua fleet v9. */
export interface FleetV9Schedule {
  id: string;
  botId: string;
  name: string;
  kind: FleetV9ScheduleKind;
  /** Cron 5 truong (kind 'cron'). */
  cron?: FleetV6CronExpression;
  /** Lap moi N ms (kind 'interval'). */
  intervalMs?: number;
  /** Chay mot lan tai ms epoch (kind 'once'). */
  runAtMs?: number;
  /** Khung gio trong ngay (kind 'window'): chay 1 lan/ngay trong khung. */
  window?: FleetV9TimeWindow;
  priority: BotPriority;
  resources: FleetV9RunResources;
  enabled: boolean;
  /** So lan retry khi that (mac dinh theo policy). */
  maxAttempts: number;
  /** Backoff co so rieng cho schedule nay (mac dinh theo policy). */
  backoffMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  /** Lan chay ke tiep (ms epoch) hoac null khi khong con lan nao (once da chay). */
  nextRunAtMs: number | null;
  /** Lan chay gan nhat (ms epoch) hoac null. */
  lastRunAtMs: number | null;
  runCount: number;
  failureCount: number;
}

export interface CreateFleetV9ScheduleInput {
  botId: string;
  name: string;
  kind: FleetV9ScheduleKind;
  cron?: FleetV6CronExpression;
  intervalMs?: number;
  runAtMs?: number;
  window?: FleetV9TimeWindow;
  priority?: BotPriority;
  resources?: Partial<FleetV9RunResources>;
  enabled?: boolean;
  maxAttempts?: number;
  backoffMs?: number;
}

/** Trang thai mot muc trong hang doi v9. */
export type FleetV9QueueStatus =
  | 'queued'
  | 'running'
  | 'retry-waiting'
  | 'done'
  | 'failed'
  | 'cancelled';

export const FLEET_V9_QUEUE_STATUSES: readonly FleetV9QueueStatus[] = [
  'queued',
  'running',
  'retry-waiting',
  'done',
  'failed',
  'cancelled',
];

/** Mot muc lich su cua queue entry (append-only, toi da 20 muc). */
export interface FleetV9QueueHistoryEntry {
  atMs: number;
  status: FleetV9QueueStatus;
  note: string;
}

/** Mot muc trong hang doi chay v9. */
export interface FleetV9QueueEntry {
  id: string;
  /** Schedule sinh ra entry nay (null = enqueue tay). */
  scheduleId: string | null;
  botId: string;
  name: string;
  priority: BotPriority;
  status: FleetV9QueueStatus;
  enqueuedAtMs: number;
  /** Khong xet chay truoc thoi diem nay (retry backoff / lich hen). */
  notBeforeMs: number;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  resources: FleetV9RunResources;
  lastError: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  history: FleetV9QueueHistoryEntry[];
}

export interface EnqueueFleetV9Input {
  botId: string;
  name: string;
  scheduleId?: string | null;
  priority?: BotPriority;
  notBeforeMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  resources?: Partial<FleetV9RunResources>;
}

/** Ket qua mot lan tick cua scheduler (ham thuan). */
export interface FleetV9TickResult {
  /** Schedule toi gio va da duoc enqueue (moi schedule toi da 1 entry/tick). */
  enqueued: FleetV9QueueEntry[];
  /** Entry duoc chon de start trong tick nay (da tru tai nguyen). */
  started: FleetV9QueueEntry[];
  /** Entry retry-waiting toi gio mo lai thanh queued. */
  reopened: FleetV9QueueEntry[];
  /** Schedule toi gio nhung da bo lo qua grace (khong enqueue, chi ghi nhan). */
  missed: { scheduleId: string; scheduleName: string; dueAtMs: number }[];
  /** Queue hien tai sau tick (da sap xep theo thu tu uu tien). */
  queue: FleetV9QueueEntry[];
}

export interface FleetV9TickOptions {
  policy?: FleetV9SchedulerPolicy;
  host?: FleetV9HostCapacity;
  /** Grace cho schedule bi lo (ms): qua muc nay thi bo lo, khong enqueue. Mac dinh 60 phut. */
  missedGraceMs?: number;
}

/** Mot slot trong ke hoach ngay. */
export interface FleetV9DaySlot {
  startMs: number;
  endMs: number;
  /** Entry duoc xep vao slot (co the trong neu slot trong). */
  entries: { entryId: string; botId: string; name: string; heavy: boolean }[];
  cpuCoresUsed: number;
  ramBytesUsed: number;
}

/** Ke hoach chay mot ngay. */
export interface FleetV9DayPlan {
  dayStartMs: number;
  slotMs: number;
  slots: FleetV9DaySlot[];
  /** Entry khong xep duoc + ly do (khong doan, khong xep len). */
  unscheduled: { entryId: string; botId: string; name: string; reason: string }[];
}

export interface PlanFleetV9DayOptions {
  slotMs?: number;
  policy?: FleetV9SchedulerPolicy;
  host?: FleetV9HostCapacity;
}

/** Tom tat hang doi + lich (cho dashboard). */
export interface FleetV9SchedulingSummary {
  totalSchedules: number;
  enabledSchedules: number;
  queued: number;
  running: number;
  retryWaiting: number;
  done: number;
  failed: number;
  cancelled: number;
  missedRuns: number;
  nextRunAtMs: number | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function validateFleetV9TimeWindow(window: FleetV9TimeWindow): FleetV9TimeWindow {
  if (!window || typeof window !== 'object') throw new Error('window must be an object.');
  const { startHour, startMinute, endHour, endMinute } = window;
  for (const [name, value, max] of [
    ['startHour', startHour, 23],
    ['startMinute', startMinute, 59],
    ['endHour', endHour, 23],
    ['endMinute', endMinute, 59],
  ] as const) {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
      throw new Error(`window.${name} must be an integer in 0..${max}.`);
    }
  }
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (start === end) throw new Error('window must not be empty (start == end).');
  return { startHour, startMinute, endHour, endMinute };
}

export function validateFleetV9Resources(
  resources: Partial<FleetV9RunResources> | undefined,
): FleetV9RunResources {
  const cpuCores = resources?.cpuCores ?? 1;
  const ramBytes = resources?.ramBytes ?? 512 * 1024 * 1024;
  if (typeof cpuCores !== 'number' || !Number.isFinite(cpuCores) || cpuCores <= 0) {
    throw new Error('resources.cpuCores must be a positive number.');
  }
  if (typeof ramBytes !== 'number' || !Number.isFinite(ramBytes) || ramBytes <= 0) {
    throw new Error('resources.ramBytes must be a positive number of bytes.');
  }
  return { cpuCores, ramBytes };
}

export function validateFleetV9SchedulerPolicy(
  policy: Partial<FleetV9SchedulerPolicy> | undefined,
): FleetV9SchedulerPolicy {
  const base = { ...DEFAULT_FLEET_V9_SCHEDULER_POLICY, ...(policy ?? {}) };
  if (!Number.isInteger(base.maxConcurrent) || base.maxConcurrent < 1) {
    throw new Error('policy.maxConcurrent must be an integer >= 1.');
  }
  if (!Number.isInteger(base.maxConcurrentPerBot) || base.maxConcurrentPerBot < 1) {
    throw new Error('policy.maxConcurrentPerBot must be an integer >= 1.');
  }
  if (!Number.isInteger(base.maxHeavyConcurrent) || base.maxHeavyConcurrent < 1) {
    throw new Error('policy.maxHeavyConcurrent must be an integer >= 1.');
  }
  if (!Number.isFinite(base.agingMs) || base.agingMs < 0) {
    throw new Error('policy.agingMs must be a non-negative number.');
  }
  if (!Number.isInteger(base.defaultMaxAttempts) || base.defaultMaxAttempts < 0) {
    throw new Error('policy.defaultMaxAttempts must be a non-negative integer.');
  }
  if (!Number.isFinite(base.defaultBackoffMs) || base.defaultBackoffMs < 0) {
    throw new Error('policy.defaultBackoffMs must be a non-negative number.');
  }
  if (!Number.isFinite(base.backoffMultiplier) || base.backoffMultiplier < 1) {
    throw new Error('policy.backoffMultiplier must be >= 1.');
  }
  if (!Number.isFinite(base.maxBackoffMs) || base.maxBackoffMs < base.defaultBackoffMs) {
    throw new Error('policy.maxBackoffMs must be >= defaultBackoffMs.');
  }
  return base;
}

export function validateFleetV9HostCapacity(
  host: Partial<FleetV9HostCapacity> | undefined,
): FleetV9HostCapacity {
  const base = { ...DEFAULT_FLEET_V9_HOST_CAPACITY, ...(host ?? {}) };
  if (!isFiniteNonNegativeNumber(base.cpuCores)) {
    throw new Error('host.cpuCores must be a non-negative number (0 = unknown).');
  }
  if (!isFiniteNonNegativeNumber(base.ramBytes)) {
    throw new Error('host.ramBytes must be a non-negative number (0 = unknown).');
  }
  if (!Number.isInteger(base.maxConcurrent) || base.maxConcurrent < 0) {
    throw new Error('host.maxConcurrent must be a non-negative integer (0 = use policy).');
  }
  return base;
}

export function validateFleetV9Schedule(input: unknown): FleetV9Schedule {
  if (!input || typeof input !== 'object') throw new Error('schedule must be an object.');
  const s = input as Partial<FleetV9Schedule>;
  if (!isNonEmptyString(s.id)) throw new Error('schedule.id must be a non-empty string.');
  if (!isNonEmptyString(s.botId)) throw new Error('schedule.botId must be a non-empty string.');
  if (!isNonEmptyString(s.name)) throw new Error('schedule.name must be a non-empty string.');
  if (!FLEET_V9_SCHEDULE_KINDS.includes(s.kind as FleetV9ScheduleKind)) {
    throw new Error(`schedule.kind must be one of: ${FLEET_V9_SCHEDULE_KINDS.join(', ')}.`);
  }
  if (!BOT_PRIORITIES.includes(s.priority as BotPriority)) {
    throw new Error(`schedule.priority must be one of: ${BOT_PRIORITIES.join(', ')}.`);
  }
  if (typeof s.enabled !== 'boolean') throw new Error('schedule.enabled must be a boolean.');
  if (!Number.isInteger(s.maxAttempts) || (s.maxAttempts as number) < 0) {
    throw new Error('schedule.maxAttempts must be a non-negative integer.');
  }
  if (!Number.isFinite(s.backoffMs) || (s.backoffMs as number) < 0) {
    throw new Error('schedule.backoffMs must be a non-negative number.');
  }
  if (!Number.isFinite(s.createdAtMs) || !Number.isFinite(s.updatedAtMs)) {
    throw new Error('schedule.createdAtMs/updatedAtMs must be finite numbers.');
  }
  if (s.nextRunAtMs !== null && !Number.isFinite(s.nextRunAtMs)) {
    throw new Error('schedule.nextRunAtMs must be null or a finite number.');
  }
  if (s.lastRunAtMs !== null && !Number.isFinite(s.lastRunAtMs)) {
    throw new Error('schedule.lastRunAtMs must be null or a finite number.');
  }
  if (!Number.isInteger(s.runCount) || (s.runCount as number) < 0) {
    throw new Error('schedule.runCount must be a non-negative integer.');
  }
  if (!Number.isInteger(s.failureCount) || (s.failureCount as number) < 0) {
    throw new Error('schedule.failureCount must be a non-negative integer.');
  }
  const resources = validateFleetV9Resources(s.resources);
  switch (s.kind) {
    case 'cron':
      if (!s.cron) throw new Error("cron schedule needs a 'cron' expression.");
      validateFleetV6Cron(s.cron);
      break;
    case 'interval':
      if (!Number.isFinite(s.intervalMs) || (s.intervalMs as number) <= 0) {
        throw new Error('interval schedule needs intervalMs > 0.');
      }
      break;
    case 'once':
      if (!Number.isFinite(s.runAtMs)) throw new Error('once schedule needs runAtMs.');
      break;
    case 'window': {
      if (!s.window) throw new Error("window schedule needs a 'window'.");
      validateFleetV9TimeWindow(s.window);
      break;
    }
  }
  return { ...(s as FleetV9Schedule), resources };
}

export function validateFleetV9QueueEntry(input: unknown): FleetV9QueueEntry {
  if (!input || typeof input !== 'object') throw new Error('queue entry must be an object.');
  const e = input as Partial<FleetV9QueueEntry>;
  if (!isNonEmptyString(e.id)) throw new Error('entry.id must be a non-empty string.');
  if (e.scheduleId !== null && !isNonEmptyString(e.scheduleId)) {
    throw new Error('entry.scheduleId must be null or a non-empty string.');
  }
  if (!isNonEmptyString(e.botId)) throw new Error('entry.botId must be a non-empty string.');
  if (!isNonEmptyString(e.name)) throw new Error('entry.name must be a non-empty string.');
  if (!BOT_PRIORITIES.includes(e.priority as BotPriority)) {
    throw new Error(`entry.priority must be one of: ${BOT_PRIORITIES.join(', ')}.`);
  }
  if (!FLEET_V9_QUEUE_STATUSES.includes(e.status as FleetV9QueueStatus)) {
    throw new Error(`entry.status must be one of: ${FLEET_V9_QUEUE_STATUSES.join(', ')}.`);
  }
  if (!Number.isFinite(e.enqueuedAtMs) || !Number.isFinite(e.notBeforeMs)) {
    throw new Error('entry.enqueuedAtMs/notBeforeMs must be finite numbers.');
  }
  if (!Number.isInteger(e.attempts) || (e.attempts as number) < 0) {
    throw new Error('entry.attempts must be a non-negative integer.');
  }
  if (!Number.isInteger(e.maxAttempts) || (e.maxAttempts as number) < 0) {
    throw new Error('entry.maxAttempts must be a non-negative integer.');
  }
  if (!Number.isFinite(e.backoffMs) || (e.backoffMs as number) < 0) {
    throw new Error('entry.backoffMs must be a non-negative number.');
  }
  if (e.lastError !== null && typeof e.lastError !== 'string') {
    throw new Error('entry.lastError must be null or a string.');
  }
  if (e.startedAtMs !== null && !Number.isFinite(e.startedAtMs)) {
    throw new Error('entry.startedAtMs must be null or a finite number.');
  }
  if (e.finishedAtMs !== null && !Number.isFinite(e.finishedAtMs)) {
    throw new Error('entry.finishedAtMs must be null or a finite number.');
  }
  if (!Array.isArray(e.history)) throw new Error('entry.history must be an array.');
  for (const h of e.history as FleetV9QueueHistoryEntry[]) {
    if (!Number.isFinite(h.atMs) || !FLEET_V9_QUEUE_STATUSES.includes(h.status) || typeof h.note !== 'string') {
      throw new Error('entry.history entries must have { atMs, status, note }.');
    }
  }
  return { ...(e as FleetV9QueueEntry), resources: validateFleetV9Resources(e.resources) };
}

// ---------------------------------------------------------------------------
// Next-run computation (pure)
// ---------------------------------------------------------------------------

/** Lan chay ke tiep cua mot window (1 lan/ngay trong khung, gio dia phuong host). */
export function nextFleetV9WindowRun(window: FleetV9TimeWindow, fromMs: number): number {
  validateFleetV9TimeWindow(window);
  if (!Number.isFinite(fromMs)) throw new Error('nextFleetV9WindowRun needs a finite fromMs.');
  const from = new Date(fromMs);
  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    const candidate = new Date(from);
    candidate.setDate(from.getDate() + dayOffset);
    candidate.setHours(window.startHour, window.startMinute, 0, 0);
    if (candidate.getTime() > fromMs) return candidate.getTime();
  }
  throw new Error('no next window run within 2 days (unreachable).');
}

/**
 * Lan chay ke tiep cua mot schedule sau `fromMs` (khong bao gom chinh
 * `fromMs`). Tra null khi schedule `once` da qua hoac schedule bi tat
 * (caller tu quyet dinh co tinh schedule tat khong — ham nay van tinh
 * de UI hien "se chay luc nao neu bat lai").
 */
export function nextRunForFleetV9Schedule(
  schedule: FleetV9Schedule,
  fromMs: number,
): number | null {
  validateFleetV9Schedule(schedule);
  if (!Number.isFinite(fromMs)) throw new Error('nextRunForFleetV9Schedule needs a finite fromMs.');
  switch (schedule.kind) {
    case 'cron':
      return nextFleetV6CronRun(schedule.cron as FleetV6CronExpression, fromMs);
    case 'interval': {
      const interval = schedule.intervalMs as number;
      const anchor = schedule.lastRunAtMs ?? schedule.createdAtMs;
      const elapsed = fromMs - anchor;
      if (elapsed < 0) return anchor + interval;
      const steps = Math.floor(elapsed / interval) + 1;
      return anchor + steps * interval;
    }
    case 'once':
      return (schedule.runAtMs as number) > fromMs ? (schedule.runAtMs as number) : null;
    case 'window':
      return nextFleetV9WindowRun(schedule.window as FleetV9TimeWindow, fromMs);
  }
}

/** Schedule co toi gio chay tai `now` khong (chi khi enabled va nextRunAt <= now). */
export function isFleetV9ScheduleDue(schedule: FleetV9Schedule, nowMs: number): boolean {
  return schedule.enabled && schedule.nextRunAtMs !== null && schedule.nextRunAtMs <= nowMs;
}

// ---------------------------------------------------------------------------
// Priority / capacity (pure)
// ---------------------------------------------------------------------------

/** Bot co phai "nang" khong (can nhieu CPU hoac RAM). */
export function isFleetV9HeavyBot(resources: FleetV9RunResources): boolean {
  return resources.cpuCores >= FLEET_V9_HEAVY_CPU_CORES || resources.ramBytes >= FLEET_V9_HEAVY_RAM_BYTES;
}

/**
 * Trong so uu tien hieu dung: trong so co so + aging (cho lau duoc cong
 * bac, chan tren o muc critical — aging khong bao gio vuot critical).
 */
export function effectiveFleetV9Priority(
  entry: FleetV9QueueEntry,
  nowMs: number,
  agingMs: number = FLEET_V9_DEFAULT_AGING_MS,
): number {
  const base = BOT_PRIORITY_WEIGHTS[entry.priority];
  if (agingMs <= 0) return base;
  const waited = Math.max(0, nowMs - entry.enqueuedAtMs);
  const bonus = Math.floor(waited / agingMs);
  return Math.min(BOT_PRIORITY_WEIGHTS.critical, base + bonus);
}

/** So sanh 2 entry trong hang doi: uu tien hieu dung cao truoc, FIFO trong cung muc. */
export function compareFleetV9QueueEntries(
  a: FleetV9QueueEntry,
  b: FleetV9QueueEntry,
  nowMs: number,
  agingMs: number = FLEET_V9_DEFAULT_AGING_MS,
): number {
  const pa = effectiveFleetV9Priority(a, nowMs, agingMs);
  const pb = effectiveFleetV9Priority(b, nowMs, agingMs);
  if (pa !== pb) return pb - pa;
  if (a.enqueuedAtMs !== b.enqueuedAtMs) return a.enqueuedAtMs - b.enqueuedAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Backoff cho lan retry thu `attempt` (attempt 1 = lan that dau): cap so nhan, chan tren. */
export function fleetV9RetryBackoffMs(
  attempt: number,
  backoffMs: number,
  multiplier: number,
  maxBackoffMs: number,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be an integer >= 1.');
  if (backoffMs < 0 || multiplier < 1 || maxBackoffMs < 0) {
    throw new Error('backoffMs/multiplier/maxBackoffMs are out of range.');
  }
  let delay = backoffMs;
  for (let i = 1; i < attempt; i++) {
    delay = Math.min(maxBackoffMs, delay * multiplier);
    if (delay >= maxBackoffMs) break;
  }
  return Math.min(maxBackoffMs, Math.round(delay));
}

/** Tai nguyen dang duoc giu boi cac entry dang chay. */
export function reservedFleetV9Resources(
  running: readonly FleetV9QueueEntry[],
): FleetV9RunResources {
  let cpuCores = 0;
  let ramBytes = 0;
  for (const entry of running) {
    cpuCores += entry.resources.cpuCores;
    ramBytes += entry.resources.ramBytes;
  }
  return { cpuCores, ramBytes };
}

export interface FleetV9FitCheck {
  fits: boolean;
  reasons: string[];
}

/**
 * Entry co vua suc chua host tai thoi diem nay khong (so luong dong thoi
 * + CPU + RAM + gioi han nang + gioi han moi bot). Tra ly do cu the khi
 * khong vua — khong bao gio doan "chac vua".
 */
export function fleetV9EntryFits(
  entry: FleetV9QueueEntry,
  running: readonly FleetV9QueueEntry[],
  policy: FleetV9SchedulerPolicy,
  host: FleetV9HostCapacity,
): FleetV9FitCheck {
  const reasons: string[] = [];
  const maxConcurrent = host.maxConcurrent > 0 ? host.maxConcurrent : policy.maxConcurrent;
  if (running.length >= maxConcurrent) {
    reasons.push(`at max concurrency (${running.length}/${maxConcurrent} running)`);
  }
  const sameBot = running.filter((r) => r.botId === entry.botId).length;
  if (sameBot >= policy.maxConcurrentPerBot) {
    reasons.push(`bot ${entry.botId} already has ${sameBot} run(s) (max ${policy.maxConcurrentPerBot})`);
  }
  if (isFleetV9HeavyBot(entry.resources)) {
    const heavyRunning = running.filter((r) => isFleetV9HeavyBot(r.resources)).length;
    if (heavyRunning >= policy.maxHeavyConcurrent) {
      reasons.push(`a heavy bot is already running (${heavyRunning}/${policy.maxHeavyConcurrent})`);
    }
  }
  const reserved = reservedFleetV9Resources(running);
  if (host.cpuCores > 0 && reserved.cpuCores + entry.resources.cpuCores > host.cpuCores) {
    reasons.push(
      `not enough CPU: needs ${entry.resources.cpuCores} cores, ${reserved.cpuCores}/${host.cpuCores} used`,
    );
  }
  if (host.ramBytes > 0 && reserved.ramBytes + entry.resources.ramBytes > host.ramBytes) {
    reasons.push(
      `not enough RAM: needs ${entry.resources.ramBytes} bytes, ${reserved.ramBytes}/${host.ramBytes} used`,
    );
  }
  return { fits: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Schedule CRUD (pure, tra ban sao moi)
// ---------------------------------------------------------------------------

export function createFleetV9Schedule(
  input: CreateFleetV9ScheduleInput,
  nowMs: number = Date.now(),
): FleetV9Schedule {
  if (!isNonEmptyString(input.botId)) throw new Error('botId must be a non-empty string.');
  if (!isNonEmptyString(input.name)) throw new Error('name must be a non-empty string.');
  if (!FLEET_V9_SCHEDULE_KINDS.includes(input.kind)) {
    throw new Error(`kind must be one of: ${FLEET_V9_SCHEDULE_KINDS.join(', ')}.`);
  }
  if (input.priority !== undefined && !BOT_PRIORITIES.includes(input.priority)) {
    throw new Error(`priority must be one of: ${BOT_PRIORITIES.join(', ')}.`);
  }
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 0)) {
    throw new Error('maxAttempts must be a non-negative integer.');
  }
  if (input.backoffMs !== undefined && (!Number.isFinite(input.backoffMs) || input.backoffMs < 0)) {
    throw new Error('backoffMs must be a non-negative number.');
  }
  const schedule: FleetV9Schedule = {
    id: `sched_v9_${crypto.randomUUID()}`,
    botId: input.botId.trim(),
    name: input.name.trim(),
    kind: input.kind,
    cron: input.cron,
    intervalMs: input.intervalMs,
    runAtMs: input.runAtMs,
    window: input.window,
    priority: input.priority ?? 'normal',
    resources: validateFleetV9Resources(input.resources),
    enabled: input.enabled ?? true,
    maxAttempts: input.maxAttempts ?? DEFAULT_FLEET_V9_SCHEDULER_POLICY.defaultMaxAttempts,
    backoffMs: input.backoffMs ?? DEFAULT_FLEET_V9_SCHEDULER_POLICY.defaultBackoffMs,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    nextRunAtMs: null,
    lastRunAtMs: null,
    runCount: 0,
    failureCount: 0,
  };
  // Validate day du (ca cron/window) truoc khi tinh next run.
  validateFleetV9Schedule(schedule);
  schedule.nextRunAtMs = nextRunForFleetV9Schedule(schedule, nowMs);
  return schedule;
}

export function findFleetV9Schedule(
  schedules: readonly FleetV9Schedule[],
  id: string,
): FleetV9Schedule | undefined {
  return schedules.find((s) => s.id === id);
}

export function setFleetV9ScheduleEnabled(
  schedules: readonly FleetV9Schedule[],
  id: string,
  enabled: boolean,
  nowMs: number = Date.now(),
): FleetV9Schedule[] {
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`schedule not found: ${id}`);
  const updated = schedules.map((s, i) => {
    if (i !== idx) return s;
    const next: FleetV9Schedule = { ...s, enabled, updatedAtMs: nowMs };
    next.nextRunAtMs = enabled ? nextRunForFleetV9Schedule(next, nowMs) : next.nextRunAtMs;
    return next;
  });
  return updated;
}

export function removeFleetV9Schedule(
  schedules: readonly FleetV9Schedule[],
  id: string,
): FleetV9Schedule[] {
  if (!schedules.some((s) => s.id === id)) throw new Error(`schedule not found: ${id}`);
  return schedules.filter((s) => s.id !== id);
}

// ---------------------------------------------------------------------------
// Queue operations (pure)
// ---------------------------------------------------------------------------

function pushHistory(
  entry: FleetV9QueueEntry,
  atMs: number,
  status: FleetV9QueueStatus,
  note: string,
): FleetV9QueueEntry {
  const history = [...entry.history, { atMs, status, note }].slice(-20);
  return { ...entry, history };
}

export function enqueueFleetV9(
  queue: readonly FleetV9QueueEntry[],
  input: EnqueueFleetV9Input,
  nowMs: number = Date.now(),
): { queue: FleetV9QueueEntry[]; entry: FleetV9QueueEntry } {
  if (queue.length >= FLEET_V9_MAX_QUEUE_ENTRIES) {
    throw new Error(`queue is full (${FLEET_V9_MAX_QUEUE_ENTRIES} entries).`);
  }
  if (!isNonEmptyString(input.botId)) throw new Error('botId must be a non-empty string.');
  if (!isNonEmptyString(input.name)) throw new Error('name must be a non-empty string.');
  if (input.priority !== undefined && !BOT_PRIORITIES.includes(input.priority)) {
    throw new Error(`priority must be one of: ${BOT_PRIORITIES.join(', ')}.`);
  }
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 0)) {
    throw new Error('maxAttempts must be a non-negative integer.');
  }
  if (input.backoffMs !== undefined && (!Number.isFinite(input.backoffMs) || input.backoffMs < 0)) {
    throw new Error('backoffMs must be a non-negative number.');
  }
  const entry: FleetV9QueueEntry = {
    id: `q_v9_${crypto.randomUUID()}`,
    scheduleId: input.scheduleId ?? null,
    botId: input.botId.trim(),
    name: input.name.trim(),
    priority: input.priority ?? 'normal',
    status: 'queued',
    enqueuedAtMs: nowMs,
    notBeforeMs: input.notBeforeMs ?? nowMs,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_FLEET_V9_SCHEDULER_POLICY.defaultMaxAttempts,
    backoffMs: input.backoffMs ?? DEFAULT_FLEET_V9_SCHEDULER_POLICY.defaultBackoffMs,
    resources: validateFleetV9Resources(input.resources),
    lastError: null,
    startedAtMs: null,
    finishedAtMs: null,
    history: [{ atMs: nowMs, status: 'queued', note: 'enqueued' }],
  };
  validateFleetV9QueueEntry(entry);
  return { queue: [...queue, entry], entry };
}

export function findFleetV9QueueEntry(
  queue: readonly FleetV9QueueEntry[],
  id: string,
): FleetV9QueueEntry | undefined {
  return queue.find((e) => e.id === id);
}

/** Entry co san sang chay tai `now` khong (queued + qua notBefore). */
export function isFleetV9EntryReady(entry: FleetV9QueueEntry, nowMs: number): boolean {
  return entry.status === 'queued' && entry.notBeforeMs <= nowMs;
}

/**
 * Chon entry ke tiep duoc start: entry ready co uu tien hieu dung cao
 * nhat MA vua suc chua host. Entry uu tien cao nhung khong vua thi
 * KHONG chan entry thap hon vua suc chua (khong head-of-line blocking
 * vo han — entry cao van giu vi tri, se duoc xet lai tick sau).
 * Tra null khi khong co entry nao start duoc + ly do cua entry dau tien.
 */
export function pickNextFleetV9Entry(
  queue: readonly FleetV9QueueEntry[],
  nowMs: number,
  policy: FleetV9SchedulerPolicy,
  host: FleetV9HostCapacity,
): { entry: FleetV9QueueEntry | null; blockedReason: string | null } {
  const running = queue.filter((e) => e.status === 'running');
  const ready = queue
    .filter((e) => isFleetV9EntryReady(e, nowMs))
    .sort((a, b) => compareFleetV9QueueEntries(a, b, nowMs, policy.agingMs));
  let firstBlocked: string | null = null;
  for (const entry of ready) {
    const fit = fleetV9EntryFits(entry, running, policy, host);
    if (fit.fits) return { entry, blockedReason: null };
    if (firstBlocked === null) firstBlocked = fit.reasons.join('; ');
  }
  return { entry: null, blockedReason: firstBlocked };
}

/** Danh dau entry da start (attempts tang, ghi lich su). */
export function startFleetV9Entry(
  queue: readonly FleetV9QueueEntry[],
  id: string,
  nowMs: number = Date.now(),
): FleetV9QueueEntry[] {
  const entry = queue.find((e) => e.id === id);
  if (!entry) throw new Error(`queue entry not found: ${id}`);
  if (entry.status !== 'queued') throw new Error(`entry ${id} is ${entry.status}, not queued.`);
  return queue.map((e) =>
    e.id === id
      ? pushHistory(
          { ...e, status: 'running', attempts: e.attempts + 1, startedAtMs: nowMs },
          nowMs,
          'running',
          `started (attempt ${e.attempts + 1})`,
        )
      : e,
  );
}

/** Entry chay xong thanh cong. */
export function completeFleetV9Entry(
  queue: readonly FleetV9QueueEntry[],
  id: string,
  nowMs: number = Date.now(),
): FleetV9QueueEntry[] {
  const entry = queue.find((e) => e.id === id);
  if (!entry) throw new Error(`queue entry not found: ${id}`);
  if (entry.status !== 'running') throw new Error(`entry ${id} is ${entry.status}, not running.`);
  return queue.map((e) =>
    e.id === id
      ? pushHistory({ ...e, status: 'done', finishedAtMs: nowMs }, nowMs, 'done', 'completed')
      : e,
  );
}

/**
 * Entry that: con luot retry thi chuyen sang `retry-waiting` voi
 * notBefore = now + backoff cap so nhan; het luot thi `failed` kem ly
 * do ro rang. Tra queue moi + entry sau khi cap nhat.
 */
export function failFleetV9Entry(
  queue: readonly FleetV9QueueEntry[],
  id: string,
  error: string,
  nowMs: number = Date.now(),
  policy: FleetV9SchedulerPolicy = DEFAULT_FLEET_V9_SCHEDULER_POLICY,
): { queue: FleetV9QueueEntry[]; entry: FleetV9QueueEntry } {
  const entry = queue.find((e) => e.id === id);
  if (!entry) throw new Error(`queue entry not found: ${id}`);
  if (entry.status !== 'running') throw new Error(`entry ${id} is ${entry.status}, not running.`);
  if (!isNonEmptyString(error)) throw new Error('error must be a non-empty string.');
  const attemptsLeft = entry.maxAttempts - (entry.attempts - 1);
  let updated: FleetV9QueueEntry;
  if (attemptsLeft > 0) {
    const delay = fleetV9RetryBackoffMs(
      entry.attempts,
      entry.backoffMs,
      policy.backoffMultiplier,
      policy.maxBackoffMs,
    );
    updated = pushHistory(
      {
        ...entry,
        status: 'retry-waiting',
        finishedAtMs: nowMs,
        lastError: error.trim(),
        notBeforeMs: nowMs + delay,
      },
      nowMs,
      'retry-waiting',
      `failed (attempt ${entry.attempts}), retry in ${delay}ms (${attemptsLeft} left)`,
    );
  } else {
    updated = pushHistory(
      { ...entry, status: 'failed', finishedAtMs: nowMs, lastError: error.trim() },
      nowMs,
      'failed',
      `failed after ${entry.attempts} attempt(s): no retries left`,
    );
  }
  return { queue: queue.map((e) => (e.id === id ? updated : e)), entry: updated };
}

/** Huy mot entry chua chay xong (queued / retry-waiting). */
export function cancelFleetV9Entry(
  queue: readonly FleetV9QueueEntry[],
  id: string,
  nowMs: number = Date.now(),
): FleetV9QueueEntry[] {
  const entry = queue.find((e) => e.id === id);
  if (!entry) throw new Error(`queue entry not found: ${id}`);
  if (entry.status !== 'queued' && entry.status !== 'retry-waiting') {
    throw new Error(`entry ${id} is ${entry.status}, cannot cancel.`);
  }
  return queue.map((e) =>
    e.id === id
      ? pushHistory({ ...e, status: 'cancelled', finishedAtMs: nowMs }, nowMs, 'cancelled', 'cancelled')
      : e,
  );
}

/** Mo lai cac entry retry-waiting da toi gio (notBefore <= now) thanh queued. */
export function reopenFleetV9Retries(
  queue: readonly FleetV9QueueEntry[],
  nowMs: number,
): { queue: FleetV9QueueEntry[]; reopened: FleetV9QueueEntry[] } {
  const reopened: FleetV9QueueEntry[] = [];
  const next = queue.map((e) => {
    if (e.status === 'retry-waiting' && e.notBeforeMs <= nowMs) {
      const updated = pushHistory({ ...e, status: 'queued' }, nowMs, 'queued', 'retry window opened');
      reopened.push(updated);
      return updated;
    }
    return e;
  });
  return { queue: next, reopened };
}

// ---------------------------------------------------------------------------
// Tick (pure) — dua schedule toi gio vao queue, mo retry, chon entry start
// ---------------------------------------------------------------------------

export function tickFleetV9Scheduler(
  schedules: readonly FleetV9Schedule[],
  queue: readonly FleetV9QueueEntry[],
  nowMs: number,
  options: FleetV9TickOptions = {},
): { schedules: FleetV9Schedule[]; result: FleetV9TickResult } {
  const policy = validateFleetV9SchedulerPolicy(options.policy);
  const host = validateFleetV9HostCapacity(options.host);
  const missedGraceMs = options.missedGraceMs ?? 60 * 60 * 1000;
  if (!Number.isFinite(nowMs)) throw new Error('tick needs a finite nowMs.');
  if (!Number.isFinite(missedGraceMs) || missedGraceMs < 0) {
    throw new Error('missedGraceMs must be a non-negative number.');
  }

  const enqueued: FleetV9QueueEntry[] = [];
  const missed: FleetV9TickResult['missed'] = [];
  let nextQueue: FleetV9QueueEntry[] = [...queue];
  let nextSchedules = schedules.map((s) => ({ ...s }));

  // 1. Schedule toi gio -> enqueue (moi schedule toi da 1 entry/tick).
  for (let i = 0; i < nextSchedules.length; i++) {
    const schedule = nextSchedules[i] as FleetV9Schedule;
    if (!isFleetV9ScheduleDue(schedule, nowMs)) continue;
    const dueAt = schedule.nextRunAtMs as number;
    const updated: FleetV9Schedule = {
      ...schedule,
      lastRunAtMs: dueAt,
      runCount: schedule.runCount + 1,
      updatedAtMs: nowMs,
    };
    if (nowMs - dueAt > missedGraceMs) {
      // Bo lo: ghi nhan, van tien lich len (khong bao gio bu burst).
      missed.push({ scheduleId: schedule.id, scheduleName: schedule.name, dueAtMs: dueAt });
      updated.nextRunAtMs = nextRunForFleetV9Schedule(updated, nowMs);
    } else {
      const { queue: q2, entry } = enqueueFleetV9(nextQueue, {
        botId: schedule.botId,
        name: schedule.name,
        scheduleId: schedule.id,
        priority: schedule.priority,
        maxAttempts: schedule.maxAttempts,
        backoffMs: schedule.backoffMs,
        resources: schedule.resources,
      }, nowMs);
      nextQueue = q2;
      enqueued.push(entry);
      updated.nextRunAtMs = nextRunForFleetV9Schedule(updated, dueAt);
      // Schedule once het lan: nextRun null, tu tat de UI thay ro.
      if (updated.kind === 'once') updated.enabled = false;
    }
    nextSchedules[i] = updated;
  }

  // 2. Mo lai retry da toi gio.
  const reopenedRes = reopenFleetV9Retries(nextQueue, nowMs);
  nextQueue = reopenedRes.queue;

  // 3. Chon entry start cho toi khi het slot hoac het entry vua suc chua.
  const started: FleetV9QueueEntry[] = [];
  for (;;) {
    const { entry } = pickNextFleetV9Entry(nextQueue, nowMs, policy, host);
    if (!entry) break;
    nextQueue = startFleetV9Entry(nextQueue, entry.id, nowMs);
    const startedEntry = findFleetV9QueueEntry(nextQueue, entry.id) as FleetV9QueueEntry;
    started.push(startedEntry);
  }

  const sorted = [...nextQueue].sort((a, b) => {
    const rank = (s: FleetV9QueueStatus): number =>
      s === 'running' ? 0 : s === 'queued' ? 1 : s === 'retry-waiting' ? 2 : 3;
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return compareFleetV9QueueEntries(a, b, nowMs, policy.agingMs);
  });

  return {
    schedules: nextSchedules,
    result: { enqueued, started, reopened: reopenedRes.reopened, missed, queue: sorted },
  };
}

// ---------------------------------------------------------------------------
// Day plan (pure) — chia ngay thanh slot, xep theo uu tien + suc chua
// ---------------------------------------------------------------------------

export function planFleetV9Day(
  entries: readonly FleetV9QueueEntry[],
  dayStartMs: number,
  options: PlanFleetV9DayOptions = {},
): FleetV9DayPlan {
  const slotMs = options.slotMs ?? FLEET_V9_DEFAULT_SLOT_MS;
  const policy = validateFleetV9SchedulerPolicy(options.policy);
  const host = validateFleetV9HostCapacity(options.host);
  if (!Number.isFinite(dayStartMs)) throw new Error('dayStartMs must be finite.');
  if (!Number.isFinite(slotMs) || slotMs <= 0) throw new Error('slotMs must be > 0.');
  const slots: FleetV9DaySlot[] = [];
  for (let i = 0; i < 24 * 60 * 60 * 1000 / slotMs; i++) {
    slots.push({
      startMs: dayStartMs + i * slotMs,
      endMs: dayStartMs + (i + 1) * slotMs,
      entries: [],
      cpuCoresUsed: 0,
      ramBytesUsed: 0,
    });
  }
  const maxConcurrent = host.maxConcurrent > 0 ? host.maxConcurrent : policy.maxConcurrent;
  const ready = [...entries]
    .filter((e) => e.status === 'queued' || e.status === 'retry-waiting')
    .sort((a, b) => compareFleetV9QueueEntries(a, b, dayStartMs, policy.agingMs));
  const unscheduled: FleetV9DayPlan['unscheduled'] = [];
  for (const entry of ready) {
    let placed = false;
    for (const slot of slots) {
      if (slot.entries.length >= maxConcurrent) continue;
      if (isFleetV9HeavyBot(entry.resources)) {
        if (slot.entries.some((e) => e.heavy)) continue;
        const heavyCount = slot.entries.filter((e) => e.heavy).length;
        if (heavyCount >= policy.maxHeavyConcurrent) continue;
      }
      if (host.cpuCores > 0 && slot.cpuCoresUsed + entry.resources.cpuCores > host.cpuCores) continue;
      if (host.ramBytes > 0 && slot.ramBytesUsed + entry.resources.ramBytes > host.ramBytes) continue;
      slot.entries.push({
        entryId: entry.id,
        botId: entry.botId,
        name: entry.name,
        heavy: isFleetV9HeavyBot(entry.resources),
      });
      slot.cpuCoresUsed += entry.resources.cpuCores;
      slot.ramBytesUsed += entry.resources.ramBytes;
      placed = true;
      break;
    }
    if (!placed) {
      unscheduled.push({
        entryId: entry.id,
        botId: entry.botId,
        name: entry.name,
        reason: 'no timeslot has enough free CPU/RAM/concurrency for this entry',
      });
    }
  }
  return { dayStartMs, slotMs, slots, unscheduled };
}

// ---------------------------------------------------------------------------
// Summary + persistence
// ---------------------------------------------------------------------------

export function summarizeFleetV9Scheduling(
  schedules: readonly FleetV9Schedule[],
  queue: readonly FleetV9QueueEntry[],
  missedRuns = 0,
): FleetV9SchedulingSummary {
  const count = (status: FleetV9QueueStatus): number => queue.filter((e) => e.status === status).length;
  const nextRuns = schedules
    .filter((s) => s.enabled && s.nextRunAtMs !== null)
    .map((s) => s.nextRunAtMs as number);
  return {
    totalSchedules: schedules.length,
    enabledSchedules: schedules.filter((s) => s.enabled).length,
    queued: count('queued'),
    running: count('running'),
    retryWaiting: count('retry-waiting'),
    done: count('done'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    missedRuns,
    nextRunAtMs: nextRuns.length > 0 ? Math.min(...nextRuns) : null,
  };
}

export function getFleetV9SchedulesPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V9_SCHEDULES_FILE);
}

export function getFleetV9QueuePath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V9_QUEUE_FILE);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function readJsonArray<T>(filePath: string, validate: (v: unknown) => T): T[] {
  if (!fs.existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: T[] = [];
  for (const item of parsed) {
    try {
      out.push(validate(item));
    } catch {
      // Bo muc hong, giu muc tot (file cu bi hong mot phan khong lam mat tat ca).
    }
  }
  return out;
}

export function loadFleetV9Schedules(fleetRoot: string): FleetV9Schedule[] {
  return readJsonArray(getFleetV9SchedulesPath(fleetRoot), validateFleetV9Schedule);
}

export function saveFleetV9Schedules(fleetRoot: string, schedules: readonly FleetV9Schedule[]): void {
  if (schedules.length > FLEET_V9_MAX_SCHEDULES) {
    throw new Error(`too many schedules (${schedules.length} > ${FLEET_V9_MAX_SCHEDULES}).`);
  }
  const valid = schedules.map((s) => validateFleetV9Schedule(s));
  atomicWriteJson(getFleetV9SchedulesPath(fleetRoot), valid);
}

export function loadFleetV9Queue(fleetRoot: string): FleetV9QueueEntry[] {
  return readJsonArray(getFleetV9QueuePath(fleetRoot), validateFleetV9QueueEntry);
}

export function saveFleetV9Queue(fleetRoot: string, queue: readonly FleetV9QueueEntry[]): void {
  if (queue.length > FLEET_V9_MAX_QUEUE_ENTRIES) {
    throw new Error(`queue too large (${queue.length} > ${FLEET_V9_MAX_QUEUE_ENTRIES}).`);
  }
  const valid = queue.map((e) => validateFleetV9QueueEntry(e));
  atomicWriteJson(getFleetV9QueuePath(fleetRoot), valid);
}

/** Kiem tra cron 5 truong dang chuoi "m p h dom mon dow" (vd "0 2 * * *"). */
export function parseFleetV9CronString(expression: string): FleetV6CronExpression {
  if (typeof expression !== 'string') throw new Error('cron expression must be a string.');
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron expression must have exactly 5 fields.');
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  const expr = { minute, hour, dayOfMonth, month, dayOfWeek };
  validateFleetV6Cron(expr);
  return expr;
}

/** Cron expression co khop tai thoi diem `at` khong (tai su dung helper v6). */
export function fleetV9CronMatches(expr: FleetV6CronExpression, at: Date): boolean {
  return fleetV6CronMatches(expr, at);
}
