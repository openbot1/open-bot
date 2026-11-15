/**
 * Fleet scheduler v6 — lập lịch fleet nhiều bot trên cùng một máy (v1.09, Đội T6).
 *
 * Tầng trên của `fleet/botScheduling.ts` (hàng đợi bot run theo node) và
 * `fleet/scheduling.ts` (placement theo workspace). Module này trả lời
 * câu hỏi riêng của MÁY CHỦ: nhiều bot cùng chạy trên một máy thì chạy
 * KHI NÀO, theo lịch nào, và làm sao để hai bot nặng không đè nhau.
 *
 *   cron (5 trường kiểu
 *   cron: phút/giờ/ngày-tháng/tháng/thứ, hỗ trợ `*`, danh sách, khoảng,
 *   bước "sao-chia-15", "9-17/2"), `interval` (lặp mỗi N ms), hoặc `event`
 *   (kích hoạt khi một bot khác xong / hàng đợi vượt ngưỡng / bot idle).
 * - `planFleetV6Day`: chia một ngày thành timeslot, xếp lịch theo độ ưu
 *   tiên; rào cứng: hai bot nặng (heavy) không bao giờ chồng nhau, tổng
 *   CPU/RAM đồng thời không vượt sức chứa máy. Slot nào không xếp được
 *   thì ghi rõ lý do (không đoán, không xếp lén).
 * - Hàng đợi ưu tiên v6 (`fleet-queue-v109.json`): critical > high >
 *   normal > low, FIFO trong cùng mức, aging chống đói (chờ lâu tăng
 *   bậc hiệu dụng), preemption CÓ GIỚI HẠN — chỉ preempt entry thấp
 *   hơn hẳn, có cờ `preemptible`, và mỗi entry chỉ bị preempt tối đa
 *   `maxPreemptions` lần rồi thôi (không preempt vô hạn).
 * - `tickFleetV6Scheduler`: hàm thuần — với `now`, trả về hành động
 *   (schedule nào tới giờ, queue entry nào được start, entry nào bị
 *   preempt). Không spawn process, không chạm mạng: điều phối ghi sổ,
 *   giống botScheduling v2.
 *
 * File bền: `fleet-schedules-v109.json` + `fleet-queue-v109.json`
 * dưới fleet root (atomic tmp + rename, mode 0600, cùng tư thế với
 * fleet-quotas.json / fleet-bot-schedule.json). Không chứa secret.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BOT_PRIORITY_WEIGHTS, type BotPriority } from './botScheduling';

/** File lưu lịch v6 trong fleet root. */
export const FLEET_V6_SCHEDULES_FILE = 'fleet-schedules-v109.json';
/** File lưu hàng đợi v6 trong fleet root. */
export const FLEET_V6_QUEUE_FILE = 'fleet-queue-v109.json';
/** Một bot được coi là "nặng" khi cần từ mức này trở lên (tránh chồng nhau). */
export const FLEET_V6_HEAVY_CPU_CORES = 2;
/** RAM (bytes) từ mức này trở lên thì bot được coi là nặng. */
export const FLEET_V6_HEAVY_RAM_BYTES = 4 * 1024 ** 3;
/** Độ dài timeslot mặc định khi lập lịch ngày (ms). */
export const FLEET_V6_DEFAULT_SLOT_MS = 15 * 60 * 1000;
/** Sau từng này ms chờ, một queue entry được cộng 1 bậc ưu tiên hiệu dụng. */
export const FLEET_V6_DEFAULT_AGING_MS = 60_000;
/** Số lần một queue entry có thể bị preempt trước khi được "miễn preempt". */
export const FLEET_V6_DEFAULT_MAX_PREEMPTIONS = 2;
/** Backoff sau khi bị preempt trước khi entry được xét chạy lại (ms). */
export const FLEET_V6_PREEMPT_BACKOFF_MS = 30_000;
/** Số bot chạy đồng thời tối đa trên một máy khi không cấu hình khác. */
export const FLEET_V6_DEFAULT_MAX_CONCURRENT = 4;

/** Loại lịch v6. */
export type FleetV6ScheduleKind = 'cron' | 'interval' | 'event';

export const FLEET_V6_SCHEDULE_KINDS: readonly FleetV6ScheduleKind[] = ['cron', 'interval', 'event'];

/** Một trường cron: '*' hoặc danh sách / khoảng / bước, vd '9-17', '1,15'. */
export type FleetV6CronField = string;

/** Biểu thức cron 5 trường (phút giờ ngày-tháng tháng thứ). */
export interface FleetV6CronExpression {
  minute: FleetV6CronField;
  hour: FleetV6CronField;
  dayOfMonth: FleetV6CronField;
  month: FleetV6CronField;
  /** Thứ trong tuần: 0 = Chủ nhật, 6 = Thứ bảy (7 cũng được coi là Chủ nhật). */
  dayOfWeek: FleetV6CronField;
}

/** Sự kiện kích hoạt một lịch event. */
export type FleetV6EventTrigger =
  | { type: 'on-bot-done'; botId: string }
  | { type: 'on-bot-idle'; botId: string; idleMs: number }
  | { type: 'on-queue-depth'; minWaiting: number };

/** Tài nguyên một lần chạy theo lịch cần (để xếp timeslot + tránh chồng nặng). */
export interface FleetV6RunResources {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
}

/** Một lịch chạy cho một bot. */
export interface FleetV6Schedule {
  /** Id ổn định: `fs6-<uuid>`. */
  id: string;
  botId: string;
  /** Mô tả ngắn cho UI/log (không chứa secret). */
  summary: string;
  kind: FleetV6ScheduleKind;
  /** Biểu thức cron — bắt buộc khi kind = 'cron'. */
  cron?: FleetV6CronExpression;
  /** Chu kỳ lặp (ms) — bắt buộc khi kind = 'interval'. */
  intervalMs?: number;
  /** Sự kiện kích hoạt — bắt buộc khi kind = 'event'. */
  event?: FleetV6EventTrigger;
  priority: BotPriority;
  resources: FleetV6RunResources;
  /** Lần chạy gần nhất (epoch ms) — null khi chưa chạy lần nào. */
  lastRunAt: number | null;
  /** Lần chạy kế tiếp đã tính (epoch ms) — null khi kind = 'event' hoặc disabled. */
  nextRunAt: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Đầu vào tạo lịch v6 (id/timestamps do hàm tạo tự sinh). */
export interface CreateFleetV6ScheduleInput {
  botId: string;
  summary: string;
  kind: FleetV6ScheduleKind;
  cron?: FleetV6CronExpression;
  intervalMs?: number;
  event?: FleetV6EventTrigger;
  priority?: BotPriority;
  resources: FleetV6RunResources;
  enabled?: boolean;
}

/** Trạng thái một queue entry v6. */
export type FleetV6QueueStatus = 'waiting' | 'running' | 'done' | 'cancelled';

/** Một mục trong hàng đợi ưu tiên v6. */
export interface FleetV6QueueEntry {
  /** Id ổn định: `fq6-<uuid>`. */
  id: string;
  botId: string;
  /** Lịch đã sinh ra entry này (nếu có). */
  scheduleId: string | null;
  summary: string;
  priority: BotPriority;
  resources: FleetV6RunResources;
  status: FleetV6QueueStatus;
  enqueuedAt: number;
  /** Không được xét chạy trước thời điểm này (backoff/preempt). */
  notBefore: number | null;
  /** Entry này có được phép bị preempt bởi entry ưu tiên cao hơn không. */
  preemptible: boolean;
  /** Số lần đã bị preempt (đạt maxPreemptions thì không bị preempt nữa). */
  preemptions: number;
  maxPreemptions: number;
  /** Số lần đã thử chạy. */
  attempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  history: FleetV6QueueHistoryEntry[];
}

/** Một mục lịch sử của queue entry (audit tối thiểu, không secret). */
export interface FleetV6QueueHistoryEntry {
  at: number;
  event: 'enqueued' | 'started' | 'preempted' | 'completed' | 'cancelled';
  detail?: string;
}

/** Một timeslot đã xếp trong ngày. */
export interface FleetV6Timeslot {
  /** Bắt đầu slot (epoch ms). */
  start: number;
  /** Kết thúc slot (epoch ms). */
  end: number;
  botId: string;
  scheduleId: string;
  priority: BotPriority;
  /** Bot nặng (chiếm gần hết máy trong slot này). */
  heavy: boolean;
  resources: FleetV6RunResources;
}

/** Một lịch không xếp được slot trong ngày + lý do. */
export interface FleetV6Unscheduled {
  scheduleId: string;
  botId: string;
  reason: string;
}

/** Kết quả lập lịch một ngày. */
export interface FleetV6DayPlan {
  /** Ngày được lập (epoch ms lúc 00:00 local). */
  dayStart: number;
  slots: FleetV6Timeslot[];
  unscheduled: FleetV6Unscheduled[];
  /** Số slot nặng tối đa đồng thời trong ngày (luôn <= 1 theo rào cứng). */
  maxHeavyOverlap: number;
  /** CPU đồng thời cao nhất trong ngày (core). */
  peakCpuCores: number;
  /** RAM đồng thời cao nhất trong ngày (bytes). */
  peakRamBytes: number;
}

/** Sức chứa máy chủ dùng khi lập lịch (đo thật hoặc khai báo — gọi tên rõ nguồn). */
export interface FleetV6HostCapacity {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
}

export const DEFAULT_FLEET_V6_HOST_CAPACITY: FleetV6HostCapacity = {
  cpuCores: 4,
  ramBytes: 8 * 1024 ** 3,
  diskBytes: 100 * 1024 ** 3,
};

/** Kết quả một nhịp tick của scheduler. */
export interface FleetV6TickResult {
  at: number;
  /** Lịch tới giờ chạy (đã enqueue thành queue entry). */
  due: FleetV6QueueEntry[];
  /** Queue entry được start trong nhịp này. */
  started: FleetV6QueueEntry[];
  /** Queue entry đang chạy bị preempt để nhường entry ưu tiên cao hơn. */
  preempted: FleetV6QueueEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// --- Cron -------------------------------------------------------------------

const CRON_FIELD_RANGES: Record<keyof FleetV6CronExpression, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 7],
};

/**
 * Phân tích một trường cron thành tập giá trị cho phép.
 * Hỗ trợ `*`, `*\/n`, `a-b`, `a-b/n`, `a,b,c`. Ném lỗi khi sai cú pháp
 * hoặc ngoài khoảng — không bao giờ đoán một trường cron hỏng.
 */
export function parseFleetV6CronField(field: string, min: number, max: number): Set<number> {
  if (typeof field !== 'string' || field.trim().length === 0) {
    throw new Error('cron field must be a non-empty string.');
  }
  const values = new Set<number>();
  const parts = field.trim().split(',');
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part.length === 0) throw new Error(`cron field "${field}" has an empty part.`);
    let rangePart = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      rangePart = part.slice(0, slash);
      const stepText = part.slice(slash + 1);
      if (!/^\d+$/.test(stepText)) throw new Error(`cron field "${field}" has a bad step "${stepText}".`);
      step = Number(stepText);
      if (step <= 0) throw new Error(`cron field "${field}" step must be > 0.`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      if (!/^\d+$/.test(a ?? '') || !/^\d+$/.test(b ?? '')) {
        throw new Error(`cron field "${field}" has a bad range "${rangePart}".`);
      }
      lo = Number(a);
      hi = Number(b);
      if (lo > hi) throw new Error(`cron field "${field}" range ${lo}-${hi} is reversed.`);
    } else if (/^\d+$/.test(rangePart)) {
      lo = Number(rangePart);
      hi = lo;
    } else {
      throw new Error(`cron field "${field}" has an unsupported part "${rangePart}".`);
    }
    if (lo < min || hi > max) {
      throw new Error(`cron field "${field}" is out of range ${min}-${max}.`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Kiểm tra một biểu thức cron đầy đủ (ném lỗi khi trường nào hỏng). */
export function validateFleetV6Cron(expr: FleetV6CronExpression): FleetV6CronExpression {
  if (!isRecord(expr)) throw new Error('cron expression must be an object.');
  const out: Record<string, string> = {};
  for (const key of Object.keys(CRON_FIELD_RANGES) as (keyof FleetV6CronExpression)[]) {
    const [min, max] = CRON_FIELD_RANGES[key];
    const raw = expr[key];
    if (typeof raw !== 'string') throw new Error(`cron.${key} must be a string.`);
    parseFleetV6CronField(raw, min, max);
    out[key] = raw.trim();
  }
  return out as unknown as FleetV6CronExpression;
}

/** Một thời điểm (local) có khớp biểu thức cron không. */
export function fleetV6CronMatches(expr: FleetV6CronExpression, at: Date): boolean {
  const minute = parseFleetV6CronField(expr.minute, 0, 59);
  const hour = parseFleetV6CronField(expr.hour, 0, 23);
  const dom = parseFleetV6CronField(expr.dayOfMonth, 1, 31);
  const month = parseFleetV6CronField(expr.month, 1, 12);
  const dow = parseFleetV6CronField(expr.dayOfWeek, 0, 7);
  const dayOfWeek = at.getDay() === 0 ? 0 : at.getDay();
  const dowHit = dow.has(dayOfWeek) || (dayOfWeek === 0 && dow.has(7));
  return (
    minute.has(at.getMinutes()) &&
    hour.has(at.getHours()) &&
    dom.has(at.getDate()) &&
    month.has(at.getMonth() + 1) &&
    dowHit
  );
}

/**
 * Lần chạy cron kế tiếp sau `fromMs` (không bao gồm chính `fromMs`).
 * Quét theo phút, tối đa 366 ngày — vượt thì ném lỗi thay vì treo.
 */
export function nextFleetV6CronRun(expr: FleetV6CronExpression, fromMs: number): number {
  validateFleetV6Cron(expr);
  if (!Number.isFinite(fromMs)) throw new Error('nextFleetV6CronRun needs a finite fromMs.');
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  // Bắt đầu từ phút tiếp theo.
  let cursor = new Date(start.getTime() + 60_000);
  const limit = fromMs + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    if (fleetV6CronMatches(expr, cursor)) return cursor.getTime();
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new Error('no next cron run within 366 days.');
}

// --- Lịch -------------------------------------------------------------------

function validateResources(raw: unknown, name: string): FleetV6RunResources {
  if (!isRecord(raw)) throw new Error(`${name} must be an object { cpuCores, ramBytes, diskBytes }.`);
  if (!isPositiveFinite(raw.cpuCores)) throw new Error(`${name}.cpuCores must be a number > 0.`);
  if (!isPositiveFinite(raw.ramBytes)) throw new Error(`${name}.ramBytes must be a number > 0.`);
  if (!isPositiveFinite(raw.diskBytes)) throw new Error(`${name}.diskBytes must be a number > 0.`);
  return { cpuCores: raw.cpuCores as number, ramBytes: raw.ramBytes as number, diskBytes: raw.diskBytes as number };
}

function validateEventTrigger(raw: unknown): FleetV6EventTrigger {
  if (!isRecord(raw)) throw new Error('event trigger must be an object.');
  if (raw.type === 'on-bot-done' || raw.type === 'on-bot-idle') {
    if (!isNonEmptyString(raw.botId)) throw new Error(`event trigger ${raw.type as string} needs a non-empty botId.`);
    if (raw.type === 'on-bot-idle') {
      if (!isPositiveFinite(raw.idleMs)) throw new Error('on-bot-idle trigger needs idleMs > 0.');
      return { type: 'on-bot-idle', botId: (raw.botId as string).trim(), idleMs: raw.idleMs as number };
    }
    return { type: 'on-bot-done', botId: (raw.botId as string).trim() };
  }
  if (raw.type === 'on-queue-depth') {
    if (!isPositiveFinite(raw.minWaiting)) throw new Error('on-queue-depth trigger needs minWaiting > 0.');
    return { type: 'on-queue-depth', minWaiting: raw.minWaiting as number };
  }
  throw new Error(`unknown event trigger type: ${String(raw.type)}.`);
}

/** Validate một lịch v6 (ném lỗi khi trường nào hỏng). */
export function validateFleetV6Schedule(raw: unknown): FleetV6Schedule {
  if (!isRecord(raw)) throw new Error('fleet v6 schedule must be an object.');
  const { id, botId, summary, kind, cron, intervalMs, event, priority, resources, lastRunAt, nextRunAt, enabled, createdAt, updatedAt } = raw;
  if (!isNonEmptyString(id)) throw new Error('fleet v6 schedule needs a non-empty id.');
  if (!isNonEmptyString(botId)) throw new Error('fleet v6 schedule needs a non-empty botId.');
  if (!isNonEmptyString(summary)) throw new Error('fleet v6 schedule needs a non-empty summary.');
  if (kind !== 'cron' && kind !== 'interval' && kind !== 'event') {
    throw new Error(`fleet v6 schedule kind must be one of: ${FLEET_V6_SCHEDULE_KINDS.join(', ')}.`);
  }
  let validCron: FleetV6CronExpression | undefined;
  let validInterval: number | undefined;
  let validEvent: FleetV6EventTrigger | undefined;
  if (kind === 'cron') {
    if (cron === undefined) throw new Error('cron schedule needs a cron expression.');
    validCron = validateFleetV6Cron(cron as FleetV6CronExpression);
  }
  if (kind === 'interval') {
    if (!isPositiveFinite(intervalMs)) throw new Error('interval schedule needs intervalMs > 0.');
    validInterval = intervalMs as number;
  }
  if (kind === 'event') {
    if (event === undefined) throw new Error('event schedule needs an event trigger.');
    validEvent = validateEventTrigger(event);
  }
  const priorities: readonly string[] = ['critical', 'high', 'normal', 'low'];
  if (typeof priority !== 'string' || !priorities.includes(priority)) {
    throw new Error('fleet v6 schedule priority must be one of: critical, high, normal, low.');
  }
  const validResources = validateResources(resources, 'resources');
  if (lastRunAt !== null && !isNonNegativeInt(lastRunAt)) throw new Error('lastRunAt must be null or a non-negative integer.');
  if (nextRunAt !== null && !isNonNegativeInt(nextRunAt)) throw new Error('nextRunAt must be null or a non-negative integer.');
  if (typeof enabled !== 'boolean') throw new Error('fleet v6 schedule enabled must be a boolean.');
  if (!isNonNegativeInt(createdAt)) throw new Error('fleet v6 schedule createdAt must be a non-negative integer.');
  if (!isNonNegativeInt(updatedAt)) throw new Error('fleet v6 schedule updatedAt must be a non-negative integer.');
  return {
    id: (id as string).trim(),
    botId: (botId as string).trim(),
    summary: (summary as string).trim(),
    kind: kind as FleetV6ScheduleKind,
    ...(validCron ? { cron: validCron } : {}),
    ...(validInterval !== undefined ? { intervalMs: validInterval } : {}),
    ...(validEvent ? { event: validEvent } : {}),
    priority: priority as BotPriority,
    resources: validResources,
    lastRunAt: lastRunAt as number | null,
    nextRunAt: nextRunAt as number | null,
    enabled,
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
  };
}

/** Một bot có được coi là nặng không (dựa trên tài nguyên một lần chạy). */
export function isFleetV6HeavyBot(resources: FleetV6RunResources): boolean {
  return resources.cpuCores >= FLEET_V6_HEAVY_CPU_CORES || resources.ramBytes >= FLEET_V6_HEAVY_RAM_BYTES;
}

/** Lần chạy kế tiếp của một lịch (null khi event/disabled). */
export function nextRunForFleetV6Schedule(schedule: FleetV6Schedule, fromMs: number): number | null {
  if (!schedule.enabled) return null;
  if (schedule.kind === 'cron' && schedule.cron) return nextFleetV6CronRun(schedule.cron, fromMs);
  if (schedule.kind === 'interval' && schedule.intervalMs) {
    const base = schedule.lastRunAt ?? schedule.createdAt;
    const next = base + schedule.intervalMs;
    return next > fromMs ? next : fromMs + schedule.intervalMs;
  }
  return null;
}

/** Tạo một lịch v6 mới (tính sẵn nextRunAt từ `now`). */
export function createFleetV6Schedule(input: CreateFleetV6ScheduleInput, now: number = Date.now()): FleetV6Schedule {
  if (!isNonEmptyString(input.botId)) throw new Error('createFleetV6Schedule needs a non-empty botId.');
  if (!isNonEmptyString(input.summary)) throw new Error('createFleetV6Schedule needs a non-empty summary.');
  if (!FLEET_V6_SCHEDULE_KINDS.includes(input.kind)) {
    throw new Error(`schedule kind must be one of: ${FLEET_V6_SCHEDULE_KINDS.join(', ')}.`);
  }
  const base: FleetV6Schedule = {
    id: newId('fs6'),
    botId: input.botId.trim(),
    summary: input.summary.trim(),
    kind: input.kind,
    priority: input.priority ?? 'normal',
    resources: validateResources(input.resources, 'resources'),
    lastRunAt: null,
    nextRunAt: null,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  if (input.kind === 'cron') {
    if (!input.cron) throw new Error('cron schedule needs a cron expression.');
    base.cron = validateFleetV6Cron(input.cron);
  }
  if (input.kind === 'interval') {
    if (!isPositiveFinite(input.intervalMs)) throw new Error('interval schedule needs intervalMs > 0.');
    base.intervalMs = input.intervalMs;
  }
  if (input.kind === 'event') {
    if (!input.event) throw new Error('event schedule needs an event trigger.');
    base.event = validateEventTrigger(input.event);
  }
  const validated = validateFleetV6Schedule(base);
  validated.nextRunAt = nextRunForFleetV6Schedule(validated, now);
  return validated;
}

// --- Lập lịch ngày (timeslot) ----------------------------------------------

/** Trùng nhau không, theo nửa khoảng [start, end). */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export interface PlanFleetV6DayOptions {
  /** Độ dài mỗi slot (ms). Mặc định 15 phút. */
  slotMs?: number;
  /** Sức chứa máy chủ. Mặc định 4 core / 8 GB / 100 GB. */
  host?: FleetV6HostCapacity;
}

/**
 * Lập lịch một ngày cho các lịch đã bật (cron + interval; lịch event
 * không có giờ cố định nên không vào timeslot — chúng chạy khi sự kiện
 * tới, xem `tickFleetV6Scheduler`).
 *
 * Thuật toán tham lam theo độ ưu tiên: lịch ưu tiên cao được xếp trước,
 * mỗi lịch chiếm 1 slot bắt đầu đúng giờ chạy kế tiếp trong ngày (hoặc
 * slot trống gần nhất sau đó). Rào cứng:
 * - hai bot heavy không bao giờ chồng nhau;
 * - tổng CPU/RAM đồng thời trong slot không vượt sức chứa máy.
 * Lịch không xếp được thì vào `unscheduled` kèm lý do — không xếp lén.
 */
export function planFleetV6Day(
  schedules: FleetV6Schedule[],
  dayStart: number,
  options: PlanFleetV6DayOptions = {},
): FleetV6DayPlan {
  const slotMs = options.slotMs ?? FLEET_V6_DEFAULT_SLOT_MS;
  if (!isPositiveFinite(slotMs)) throw new Error('planFleetV6Day needs slotMs > 0.');
  if (!isNonNegativeInt(dayStart)) throw new Error('planFleetV6Day needs a non-negative integer dayStart.');
  const host = options.host ?? DEFAULT_FLEET_V6_HOST_CAPACITY;
  if (!isPositiveFinite(host.cpuCores) || !isPositiveFinite(host.ramBytes) || !isPositiveFinite(host.diskBytes)) {
    throw new Error('planFleetV6Day needs a host capacity with cpuCores/ramBytes/diskBytes > 0.');
  }
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const sorted = [...schedules]
    .filter((s) => s.enabled && s.kind !== 'event')
    .sort((a, b) => {
      const w = BOT_PRIORITY_WEIGHTS[b.priority] - BOT_PRIORITY_WEIGHTS[a.priority];
      if (w !== 0) return w;
      return (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER);
    });
  const slots: FleetV6Timeslot[] = [];
  const unscheduled: FleetV6Unscheduled[] = [];
  let peakCpuCores = 0;
  let peakRamBytes = 0;

  for (const schedule of sorted) {
    const heavy = isFleetV6HeavyBot(schedule.resources);
    // Lịch interval không có nextRunAt thì lấy đầu ngày; cron lấy lần chạy kế tiếp trong ngày.
    let firstRun = schedule.nextRunAt;
    if (firstRun === null || firstRun < dayStart) {
      firstRun = nextRunForFleetV6Schedule(schedule, dayStart - 1) ?? dayStart;
    }
    if (firstRun >= dayEnd) {
      unscheduled.push({ scheduleId: schedule.id, botId: schedule.botId, reason: 'next-run-outside-day' });
      continue;
    }
    // Lịch đòi hỏi vượt hẳn sức chứa máy thì không bao giờ xếp được.
    if (
      schedule.resources.cpuCores > host.cpuCores ||
      schedule.resources.ramBytes > host.ramBytes ||
      schedule.resources.diskBytes > host.diskBytes
    ) {
      unscheduled.push({ scheduleId: schedule.id, botId: schedule.botId, reason: 'exceeds-host-capacity' });
      continue;
    }
    // Tìm slot trống gần nhất từ firstRun (quét theo slotMs, tối đa hết ngày).
    let placed: FleetV6Timeslot | null = null;
    let cursor = Math.max(firstRun, dayStart);
    // Căn cursor về biên slot.
    cursor = dayStart + Math.floor((cursor - dayStart) / slotMs) * slotMs;
    while (cursor + slotMs <= dayEnd) {
      const end = cursor + slotMs;
      const overlapping = slots.filter((s) => overlaps(s.start, s.end, cursor, end));
      const heavyClash = heavy && overlapping.some((s) => s.heavy);
      const cpuUsed = overlapping.reduce((sum, s) => sum + s.resources.cpuCores, 0);
      const ramUsed = overlapping.reduce((sum, s) => sum + s.resources.ramBytes, 0);
      const diskUsed = overlapping.reduce((sum, s) => sum + s.resources.diskBytes, 0);
      if (
        !heavyClash &&
        cpuUsed + schedule.resources.cpuCores <= host.cpuCores &&
        ramUsed + schedule.resources.ramBytes <= host.ramBytes &&
        diskUsed + schedule.resources.diskBytes <= host.diskBytes
      ) {
        placed = {
          start: cursor,
          end,
          botId: schedule.botId,
          scheduleId: schedule.id,
          priority: schedule.priority,
          heavy,
          resources: { ...schedule.resources },
        };
        break;
      }
      cursor += slotMs;
    }
    if (placed) {
      slots.push(placed);
      const overlapping = slots.filter((s) => overlaps(s.start, s.end, placed.start, placed.end));
      peakCpuCores = Math.max(peakCpuCores, overlapping.reduce((sum, s) => sum + s.resources.cpuCores, 0));
      peakRamBytes = Math.max(peakRamBytes, overlapping.reduce((sum, s) => sum + s.resources.ramBytes, 0));
    } else {
      unscheduled.push({
        scheduleId: schedule.id,
        botId: schedule.botId,
        reason: heavy ? 'no-slot-without-heavy-overlap' : 'no-slot-within-host-capacity',
      });
    }
  }
  slots.sort((a, b) => a.start - b.start);
  // Số bot nặng chồng nhau nhiều nhất tại cùng một thời điểm (rào cứng => <= 1).
  let maxHeavyOverlap = 0;
  for (const slot of slots) {
    if (!slot.heavy) continue;
    const atSameTime = slots.filter((s) => s.heavy && overlaps(s.start, s.end, slot.start, slot.end)).length;
    maxHeavyOverlap = Math.max(maxHeavyOverlap, atSameTime);
  }
  return { dayStart, slots, unscheduled, maxHeavyOverlap, peakCpuCores, peakRamBytes };
}

// --- Hàng đợi ưu tiên -------------------------------------------------------

function validateQueueHistory(raw: unknown): FleetV6QueueHistoryEntry[] {
  if (!Array.isArray(raw)) throw new Error('queue entry history must be an array.');
  return raw.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`queue history[${i}] must be an object.`);
    if (!isNonNegativeInt(entry.at)) throw new Error(`queue history[${i}].at must be a non-negative integer.`);
    const events = ['enqueued', 'started', 'preempted', 'completed', 'cancelled'];
    if (typeof entry.event !== 'string' || !events.includes(entry.event)) {
      throw new Error(`queue history[${i}].event is invalid.`);
    }
    return {
      at: entry.at as number,
      event: entry.event as FleetV6QueueHistoryEntry['event'],
      ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}),
    };
  });
}

/** Validate một queue entry v6. */
export function validateFleetV6QueueEntry(raw: unknown): FleetV6QueueEntry {
  if (!isRecord(raw)) throw new Error('fleet v6 queue entry must be an object.');
  const { id, botId, scheduleId, summary, priority, resources, status, enqueuedAt, notBefore, preemptible, preemptions, maxPreemptions, attempts, startedAt, finishedAt, history } = raw;
  if (!isNonEmptyString(id)) throw new Error('queue entry needs a non-empty id.');
  if (!isNonEmptyString(botId)) throw new Error('queue entry needs a non-empty botId.');
  if (scheduleId !== null && !isNonEmptyString(scheduleId)) throw new Error('queue entry scheduleId must be null or a non-empty string.');
  if (!isNonEmptyString(summary)) throw new Error('queue entry needs a non-empty summary.');
  const priorities: readonly string[] = ['critical', 'high', 'normal', 'low'];
  if (typeof priority !== 'string' || !priorities.includes(priority)) {
    throw new Error('queue entry priority must be one of: critical, high, normal, low.');
  }
  const validResources = validateResources(resources, 'resources');
  const statuses: readonly string[] = ['waiting', 'running', 'done', 'cancelled'];
  if (typeof status !== 'string' || !statuses.includes(status)) {
    throw new Error('queue entry status must be one of: waiting, running, done, cancelled.');
  }
  if (!isNonNegativeInt(enqueuedAt)) throw new Error('queue entry enqueuedAt must be a non-negative integer.');
  if (notBefore !== null && !isNonNegativeInt(notBefore)) throw new Error('queue entry notBefore must be null or a non-negative integer.');
  if (typeof preemptible !== 'boolean') throw new Error('queue entry preemptible must be a boolean.');
  if (!isNonNegativeInt(preemptions)) throw new Error('queue entry preemptions must be a non-negative integer.');
  if (!isNonNegativeInt(maxPreemptions)) throw new Error('queue entry maxPreemptions must be a non-negative integer.');
  if (preemptions > maxPreemptions) throw new Error('queue entry preemptions must not exceed maxPreemptions.');
  if (!isNonNegativeInt(attempts)) throw new Error('queue entry attempts must be a non-negative integer.');
  if (startedAt !== null && !isNonNegativeInt(startedAt)) throw new Error('queue entry startedAt must be null or a non-negative integer.');
  if (finishedAt !== null && !isNonNegativeInt(finishedAt)) throw new Error('queue entry finishedAt must be null or a non-negative integer.');
  return {
    id: (id as string).trim(),
    botId: (botId as string).trim(),
    scheduleId: scheduleId === null ? null : (scheduleId as string).trim(),
    summary: (summary as string).trim(),
    priority: priority as BotPriority,
    resources: validResources,
    status: status as FleetV6QueueStatus,
    enqueuedAt: enqueuedAt as number,
    notBefore: notBefore as number | null,
    preemptible,
    preemptions: preemptions as number,
    maxPreemptions: maxPreemptions as number,
    attempts: attempts as number,
    startedAt: startedAt as number | null,
    finishedAt: finishedAt as number | null,
    history: validateQueueHistory(history),
  };
}

/** Độ ưu tiên hiệu dụng: trọng số cơ bản + điểm aging theo thời gian chờ. */
export function effectiveFleetV6Priority(entry: FleetV6QueueEntry, now: number, agingMs: number = FLEET_V6_DEFAULT_AGING_MS): number {
  const waited = Math.max(0, now - entry.enqueuedAt);
  return BOT_PRIORITY_WEIGHTS[entry.priority] + Math.floor(waited / agingMs);
}

/** So sánh hai entry đang chờ: hiệu dụng cao trước, rồi FIFO (enqueue sớm trước). */
export function compareFleetV6QueueEntries(
  a: FleetV6QueueEntry,
  b: FleetV6QueueEntry,
  now: number,
  agingMs: number = FLEET_V6_DEFAULT_AGING_MS,
): number {
  const diff = effectiveFleetV6Priority(b, now, agingMs) - effectiveFleetV6Priority(a, now, agingMs);
  if (diff !== 0) return diff;
  return a.enqueuedAt - b.enqueuedAt;
}

export interface EnqueueFleetV6Input {
  botId: string;
  summary: string;
  priority?: BotPriority;
  resources: FleetV6RunResources;
  scheduleId?: string | null;
  preemptible?: boolean;
  maxPreemptions?: number;
  notBefore?: number | null;
}

/** Thêm một entry vào hàng đợi (không tự start — tick mới start). */
export function enqueueFleetV6(queue: FleetV6QueueEntry[], input: EnqueueFleetV6Input, now: number = Date.now()): FleetV6QueueEntry {
  if (!isNonEmptyString(input.botId)) throw new Error('enqueueFleetV6 needs a non-empty botId.');
  if (!isNonEmptyString(input.summary)) throw new Error('enqueueFleetV6 needs a non-empty summary.');
  const entry: FleetV6QueueEntry = {
    id: newId('fq6'),
    botId: input.botId.trim(),
    scheduleId: input.scheduleId ?? null,
    summary: input.summary.trim(),
    priority: input.priority ?? 'normal',
    resources: validateResources(input.resources, 'resources'),
    status: 'waiting',
    enqueuedAt: now,
    notBefore: input.notBefore ?? null,
    preemptible: input.preemptible ?? true,
    preemptions: 0,
    maxPreemptions: input.maxPreemptions ?? FLEET_V6_DEFAULT_MAX_PREEMPTIONS,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    history: [{ at: now, event: 'enqueued' }],
  };
  const validated = validateFleetV6QueueEntry(entry);
  return validated;
}

/** Entry đang chờ có thể được xét chạy tại `now` không (hết backoff chưa). */
export function isFleetV6EntryReady(entry: FleetV6QueueEntry, now: number): boolean {
  return entry.status === 'waiting' && (entry.notBefore === null || entry.notBefore <= now);
}

/**
 * Chọn entry tiếp theo để start: chờ + sẵn sàng, ưu tiên hiệu dụng cao
 * nhất. Trả null khi hàng đợi trống hoặc chưa tới lượt (backoff).
 */
export function pickNextFleetV6Entry(
  queue: FleetV6QueueEntry[],
  now: number,
  agingMs: number = FLEET_V6_DEFAULT_AGING_MS,
): FleetV6QueueEntry | null {
  const ready = queue.filter((e) => isFleetV6EntryReady(e, now));
  if (ready.length === 0) return null;
  return [...ready].sort((a, b) => compareFleetV6QueueEntries(a, b, now, agingMs))[0] ?? null;
}

/**
 * Preemption có giới hạn: một entry mới (ưu tiên cao hơn) có thể chiếm
 * slot của entry đang chạy KHI VÀ CHỈ KHI entry đang chạy có
 * `preemptible`, trọng số ưu tiên thấp hơn hẳn, và chưa đạt
 * `maxPreemptions`. Entry bị preempt quay lại 'waiting' với backoff,
 * `preemptions` + 1. Trả entry bị preempt (đã cập nhật) hoặc null.
 */
export function preemptFleetV6Entry(
  running: FleetV6QueueEntry,
  incoming: FleetV6QueueEntry,
  now: number,
): FleetV6QueueEntry | null {
  if (running.status !== 'running') return null;
  if (!running.preemptible) return null;
  if (running.preemptions >= running.maxPreemptions) return null;
  if (BOT_PRIORITY_WEIGHTS[incoming.priority] <= BOT_PRIORITY_WEIGHTS[running.priority]) return null;
  return {
    ...running,
    status: 'waiting',
    startedAt: null,
    notBefore: now + FLEET_V6_PREEMPT_BACKOFF_MS,
    preemptions: running.preemptions + 1,
    history: [...running.history, { at: now, event: 'preempted', detail: `preempted by ${incoming.id} (${incoming.priority})` }],
  };
}

// --- Tick -------------------------------------------------------------------

export interface FleetV6TickOptions {
  /** Số bot chạy đồng thời tối đa. Mặc định 4. */
  maxConcurrent?: number;
  /** Thời gian aging (ms). Mặc định 60_000. */
  agingMs?: number;
}

/**
 * Một nhịp tick thuần: lịch nào tới giờ thì enqueue; entry chờ nào được
 * start (tôn trọng maxConcurrent); entry ưu tiên cao đang chờ có preempt
 * entry đang chạy thấp hơn không (giới hạn theo `preemptFleetV6Entry`).
 *
 * Hàm trả về queue + schedules ĐÃ CẬP NHẬT (immutable style — caller tự
 * lưu) và kết quả tick để UI/log dùng. Lịch interval/cron sau khi tới
 * giờ được cập nhật lastRunAt/nextRunAt; lịch event không tự chạy ở
 * đây — caller gọi `fireFleetV6Event` khi sự kiện xảy ra.
 */
export function tickFleetV6Scheduler(
  schedules: FleetV6Schedule[],
  queue: FleetV6QueueEntry[],
  now: number,
  options: FleetV6TickOptions = {},
): { schedules: FleetV6Schedule[]; queue: FleetV6QueueEntry[]; result: FleetV6TickResult } {
  const maxConcurrent = options.maxConcurrent ?? FLEET_V6_DEFAULT_MAX_CONCURRENT;
  const agingMs = options.agingMs ?? FLEET_V6_DEFAULT_AGING_MS;
  if (!isPositiveFinite(maxConcurrent)) throw new Error('tickFleetV6Scheduler needs maxConcurrent > 0.');

  let nextQueue = [...queue];
  const due: FleetV6QueueEntry[] = [];
  const started: FleetV6QueueEntry[] = [];
  const preempted: FleetV6QueueEntry[] = [];

  const nextSchedules = schedules.map((schedule) => {
    if (!schedule.enabled || schedule.kind === 'event') return schedule;
    const nextAt = schedule.nextRunAt ?? nextRunForFleetV6Schedule(schedule, now);
    if (nextAt === null || nextAt > now) return schedule;
    const entry = enqueueFleetV6(nextQueue, {
      botId: schedule.botId,
      summary: schedule.summary,
      priority: schedule.priority,
      resources: schedule.resources,
      scheduleId: schedule.id,
    }, now);
    nextQueue = [...nextQueue, entry];
    due.push(entry);
    const updated: FleetV6Schedule = {
      ...schedule,
      lastRunAt: now,
      nextRunAt: nextRunForFleetV6Schedule({ ...schedule, lastRunAt: now }, now),
      updatedAt: now,
    };
    return updated;
  });

  // Preemption: entry chờ ưu tiên cao nhất có thể chiếm slot của entry
  // đang chạy thấp hơn (giới hạn) — làm trước khi start entry mới.
  let running = nextQueue.filter((e) => e.status === 'running');
  const topWaiting = pickNextFleetV6Entry(nextQueue, now, agingMs);
  if (topWaiting && running.length >= maxConcurrent) {
    const victim = [...running]
      .sort((a, b) => BOT_PRIORITY_WEIGHTS[a.priority] - BOT_PRIORITY_WEIGHTS[b.priority])[0];
    if (victim) {
      const preemptedEntry = preemptFleetV6Entry(victim, topWaiting, now);
      if (preemptedEntry) {
        nextQueue = nextQueue.map((e) => (e.id === victim.id ? preemptedEntry : e));
        preempted.push(preemptedEntry);
        running = nextQueue.filter((e) => e.status === 'running');
      }
    }
  }

  // Start entry chờ theo thứ tự ưu tiên cho tới khi đủ maxConcurrent.
  running = nextQueue.filter((e) => e.status === 'running');
  while (running.length < maxConcurrent) {
    const next = pickNextFleetV6Entry(nextQueue, now, agingMs);
    if (!next) break;
    const startedEntry: FleetV6QueueEntry = {
      ...next,
      status: 'running',
      attempts: next.attempts + 1,
      startedAt: now,
      history: [...next.history, { at: now, event: 'started' }],
    };
    nextQueue = nextQueue.map((e) => (e.id === next.id ? startedEntry : e));
    started.push(startedEntry);
    running = nextQueue.filter((e) => e.status === 'running');
  }

  return { schedules: nextSchedules, queue: nextQueue, result: { at: now, due, started, preempted } };
}

/**
 * Kích hoạt lịch event khi sự kiện xảy ra: lịch event khớp trigger thì
 * enqueue một entry. Trả về queue mới + entry đã tạo (rỗng khi không khớp).
 */
export function fireFleetV6Event(
  schedules: FleetV6Schedule[],
  queue: FleetV6QueueEntry[],
  event: { type: 'bot-done'; botId: string } | { type: 'bot-idle'; botId: string; idleMs: number } | { type: 'queue-depth'; waiting: number },
  now: number = Date.now(),
): { queue: FleetV6QueueEntry[]; fired: FleetV6QueueEntry[] } {
  const fired: FleetV6QueueEntry[] = [];
  let nextQueue = [...queue];
  for (const schedule of schedules) {
    if (!schedule.enabled || schedule.kind !== 'event' || !schedule.event) continue;
    const trigger = schedule.event;
    let match = false;
    if (trigger.type === 'on-bot-done' && event.type === 'bot-done' && trigger.botId === event.botId) match = true;
    if (trigger.type === 'on-bot-idle' && event.type === 'bot-idle' && trigger.botId === event.botId && event.idleMs >= trigger.idleMs) match = true;
    if (trigger.type === 'on-queue-depth' && event.type === 'queue-depth' && event.waiting >= trigger.minWaiting) match = true;
    if (!match) continue;
    // Chống enqueue trùng: cùng schedule đang chờ/chạy thì thôi.
    const alreadyPending = nextQueue.some(
      (e) => e.scheduleId === schedule.id && (e.status === 'waiting' || e.status === 'running'),
    );
    if (alreadyPending) continue;
    const entry = enqueueFleetV6(nextQueue, {
      botId: schedule.botId,
      summary: schedule.summary,
      priority: schedule.priority,
      resources: schedule.resources,
      scheduleId: schedule.id,
    }, now);
    nextQueue = [...nextQueue, entry];
    fired.push(entry);
  }
  return { queue: nextQueue, fired };
}

/** Đánh dấu một queue entry hoàn thành / huỷ (ghi lịch sử). */
export function finishFleetV6Entry(
  queue: FleetV6QueueEntry[],
  entryId: string,
  outcome: 'completed' | 'cancelled',
  now: number = Date.now(),
): FleetV6QueueEntry[] {
  return queue.map((entry) => {
    if (entry.id !== entryId) return entry;
    if (entry.status !== 'running' && entry.status !== 'waiting') return entry;
    return {
      ...entry,
      status: outcome === 'completed' ? 'done' : 'cancelled',
      finishedAt: now,
      history: [...entry.history, { at: now, event: outcome }],
    };
  });
}

// --- File bền ---------------------------------------------------------------

export function getFleetV6SchedulesPath(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('fleet v6 schedules need a non-empty rootDir.');
  }
  return path.join(rootDir, FLEET_V6_SCHEDULES_FILE);
}

export function getFleetV6QueuePath(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('fleet v6 queue needs a non-empty rootDir.');
  }
  return path.join(rootDir, FLEET_V6_QUEUE_FILE);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX modes.
  }
  fs.renameSync(tmp, filePath);
}

function loadJsonArray(filePath: string, fileLabel: string): unknown[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${fileLabel} is corrupt: not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${fileLabel} is corrupt: expected an array.`);
  return parsed;
}

/** Load mọi lịch v6 (file thiếu = chưa có lịch nào). */
export function loadFleetV6Schedules(rootDir: string): FleetV6Schedule[] {
  const parsed = loadJsonArray(getFleetV6SchedulesPath(rootDir), FLEET_V6_SCHEDULES_FILE);
  return parsed.map((entry, i) => {
    try {
      return validateFleetV6Schedule(entry);
    } catch (err) {
      throw new Error(`${FLEET_V6_SCHEDULES_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
}

/** Lưu mọi lịch v6 (atomic tmp + rename, mode 0600). */
export function saveFleetV6Schedules(rootDir: string, schedules: FleetV6Schedule[]): void {
  const valid = schedules.map((s) => validateFleetV6Schedule(s));
  atomicWriteJson(getFleetV6SchedulesPath(rootDir), valid);
}

/** Load hàng đợi v6 (file thiếu = hàng đợi rỗng). */
export function loadFleetV6Queue(rootDir: string): FleetV6QueueEntry[] {
  const parsed = loadJsonArray(getFleetV6QueuePath(rootDir), FLEET_V6_QUEUE_FILE);
  return parsed.map((entry, i) => {
    try {
      return validateFleetV6QueueEntry(entry);
    } catch (err) {
      throw new Error(`${FLEET_V6_QUEUE_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
}

/** Lưu hàng đợi v6 (atomic tmp + rename, mode 0600). */
export function saveFleetV6Queue(rootDir: string, queue: FleetV6QueueEntry[]): void {
  const valid = queue.map((e) => validateFleetV6QueueEntry(e));
  atomicWriteJson(getFleetV6QueuePath(rootDir), valid);
}

/** Tạo + lưu một lịch v6 mới. */
export function addFleetV6Schedule(
  rootDir: string,
  input: CreateFleetV6ScheduleInput,
  now: number = Date.now(),
): FleetV6Schedule {
  const schedules = loadFleetV6Schedules(rootDir);
  const schedule = createFleetV6Schedule(input, now);
  saveFleetV6Schedules(rootDir, [...schedules, schedule]);
  return schedule;
}

/** Xoá một lịch v6 theo id. Trả true khi đã xoá. */
export function removeFleetV6Schedule(rootDir: string, scheduleId: string): boolean {
  const schedules = loadFleetV6Schedules(rootDir);
  const next = schedules.filter((s) => s.id !== scheduleId);
  if (next.length === schedules.length) return false;
  saveFleetV6Schedules(rootDir, next);
  return true;
}

/** Bật/tắt một lịch v6. Trả lịch đã cập nhật hoặc undefined khi không có. */
export function setFleetV6ScheduleEnabled(
  rootDir: string,
  scheduleId: string,
  enabled: boolean,
  now: number = Date.now(),
): FleetV6Schedule | undefined {
  const schedules = loadFleetV6Schedules(rootDir);
  const target = schedules.find((s) => s.id === scheduleId);
  if (!target) return undefined;
  const updated: FleetV6Schedule = {
    ...target,
    enabled,
    nextRunAt: enabled ? nextRunForFleetV6Schedule({ ...target, enabled: true }, now) : null,
    updatedAt: now,
  };
  saveFleetV6Schedules(
    rootDir,
    schedules.map((s) => (s.id === scheduleId ? validateFleetV6Schedule(updated) : s)),
  );
  return validateFleetV6Schedule(updated);
}
