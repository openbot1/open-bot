/**
 * Fleet health v6 — health check định kỳ + tự phục hồi (v1.09, Đội T6).
 *
 * Tầng trên của `fleet/fleetV5Health.ts` (dashboard tổng hợp theo bot
 * run/campaign/budget) và `fleet/service.ts` (restart service workspace
 * với backoff cố định). Module này trả lời câu hỏi riêng của BOT:
 * một bot cụ thể có còn sống không, và khi nó crash thì làm gì.
 *
 * - `checkFleetV6BotHealth`: health check thuần cho một bot — heartbeat
 *   còn tươi không, mức dùng tài nguyên so với quota (tái dùng evaluator
 *   của quotas v2), số lỗi gần đây. Kết quả: `healthy` | `degraded` |
 *   `unhealthy` | `down`, kèm từng check riêng lẻ để UI vẽ rõ lý do.
 *   Bot crash N lần liên tiếp (mặc định 3) thì bị đánh dấu `unhealthy`
 *   và không tự restart nữa cho tới khi admin can thiệp.
 * - `decideFleetV6Restart`: chính sách restart với backoff TĂNG DẦN
 *   (base * 2^attempt, chặn trên maxBackoffMs), giới hạn số lần restart
 *   trong một cửa sổ (maxRestarts), reset đếm sau một khoảng chạy ổn
 *   (resetWindowMs). Hết lượt thì trả `exhausted` + ghi incident.
 * - Incident log: `<fleetRoot>/fleet-incidents-v109.jsonl` — append
 *   từng dòng JSON (crash / degraded / unhealthy / restart /
 *   restart-exhausted / quota-over), giữ tối đa N dòng mới nhất.
 * - Trạng thái theo dõi (số lỗi liên tiếp, lịch sử crash, lần restart
 *   cuối) lưu bền trong `<fleetRoot>/fleet-health-v109.json`
 *   (atomic tmp + rename, mode 0600).
 *
 * Module này KHÔNG spawn process thật: nó quyết định "có nên restart
 * không, sau bao lâu" — việc restart do FleetServiceManager / caller
 * thực hiện. Tách bạch như vậy để logic test được thuần túy.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { evaluateBotQuota, type BotQuota, type BotUsageSnapshot, type QuotaLevel } from './quotas';

/** File lưu trạng thái theo dõi health v6 trong fleet root. */
export const FLEET_V6_HEALTH_FILE = 'fleet-health-v109.json';
/** File incident log v6 trong fleet root (JSONL, append). */
export const FLEET_V6_INCIDENTS_FILE = 'fleet-incidents-v109.jsonl';
/** Heartbeat quá từng này ms chưa thấy thì coi là stale (mặc định). */
export const FLEET_V6_DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
/** Số lỗi liên tiếp tối đa trước khi bot bị đánh dấu unhealthy (mặc định). */
export const FLEET_V6_DEFAULT_UNHEALTHY_AFTER_FAILURES = 3;
/** Backoff cơ số giữa các lần restart (ms, mặc định). */
export const FLEET_V6_DEFAULT_RESTART_BASE_BACKOFF_MS = 5_000;
/** Backoff tối đa giữa các lần restart (ms, mặc định). */
export const FLEET_V6_DEFAULT_RESTART_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Số lần restart tối đa trong một cửa sổ trước khi exhausted (mặc định). */
export const FLEET_V6_DEFAULT_MAX_RESTARTS = 5;
/** Cửa sổ đếm restart (ms, mặc định): restart trong cửa sổ này mới tính. */
export const FLEET_V6_DEFAULT_RESTART_WINDOW_MS = 60 * 60 * 1000;
/** Bot chạy ổn từng này ms thì reset đếm crash liên tiếp (mặc định). */
export const FLEET_V6_DEFAULT_STABLE_RESET_MS = 10 * 60 * 1000;
/** Giữ tối đa từng này incident trong file log. */
export const FLEET_V6_MAX_INCIDENTS = 500;

/** Trạng thái sức khoẻ của một bot. */
export type FleetV6HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'down';

export const FLEET_V6_HEALTH_STATUSES: readonly FleetV6HealthStatus[] = ['healthy', 'degraded', 'unhealthy', 'down'];

/** Một check riêng lẻ trong health check (để UI vẽ rõ lý do). */
export interface FleetV6HealthCheck {
  name: 'heartbeat' | 'resources' | 'recent-errors' | 'service-state';
  ok: boolean;
  detail: string;
}

/** Đầu vào health check cho một bot. */
export interface FleetV6BotHealthInput {
  botId: string;
  /** Epoch ms của heartbeat gần nhất (null = chưa bao giờ thấy heartbeat). */
  lastHeartbeatAt: number | null;
  /** Trạng thái service hiện tại của bot (theo FleetServiceManager). */
  serviceState: 'stopped' | 'starting' | 'running' | 'error';
  /** Mức dùng đã đo (null = chưa đo được, báo unknown chứ không đoán 0). */
  usage: BotUsageSnapshot | null;
  /** Quota bot (nếu có) để so mức dùng. */
  quota?: BotQuota;
  /** Các lỗi gần đây (mới nhất trước), mỗi lỗi có thời điểm + message. */
  recentErrors: { at: number; message: string }[];
  /** Số lần crash/lỗi liên tiếp tính tới hiện tại (do store theo dõi). */
  consecutiveFailures: number;
}

/** Kết quả health check cho một bot. */
export interface FleetV6BotHealthResult {
  botId: string;
  status: FleetV6HealthStatus;
  checks: FleetV6HealthCheck[];
  /** Mức quota nghiêm trọng nhất (null khi không có quota / chưa đo được). */
  quotaLevel: QuotaLevel | null;
  /** Số lỗi trong cửa sổ gần đây. */
  recentErrorCount: number;
  /** Lỗi gần nhất (message ngắn, không secret). */
  lastError: string | null;
  /** Bot có bị đánh dấu unhealthy vì quá nhiều lỗi liên tiếp không. */
  markedUnhealthy: boolean;
  at: number;
}

/** Chính sách restart với backoff tăng dần. */
export interface FleetV6RestartPolicy {
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Số lần restart tối đa trong restartWindowMs. */
  maxRestarts: number;
  restartWindowMs: number;
  /** Bot chạy ổn từng này ms thì reset đếm crash liên tiếp. */
  stableResetMs: number;
  /** Số lỗi liên tiếp tối đa trước khi bot bị đánh dấu unhealthy. */
  unhealthyAfterFailures: number;
}

export const DEFAULT_FLEET_V6_RESTART_POLICY: FleetV6RestartPolicy = {
  baseBackoffMs: FLEET_V6_DEFAULT_RESTART_BASE_BACKOFF_MS,
  maxBackoffMs: FLEET_V6_DEFAULT_RESTART_MAX_BACKOFF_MS,
  maxRestarts: FLEET_V6_DEFAULT_MAX_RESTARTS,
  restartWindowMs: FLEET_V6_DEFAULT_RESTART_WINDOW_MS,
  stableResetMs: FLEET_V6_DEFAULT_STABLE_RESET_MS,
  unhealthyAfterFailures: FLEET_V6_DEFAULT_UNHEALTHY_AFTER_FAILURES,
};

/** Quyết định restart cho một bot vừa crash. */
export interface FleetV6RestartDecision {
  /** Có restart không. */
  shouldRestart: boolean;
  /** Chờ từng này ms rồi mới restart (0 = restart ngay). */
  delayMs: number;
  /** Lần restart thứ mấy trong cửa sổ hiện tại (1-based). */
  attempt: number;
  /** Lý do ngắn: 'restart', 'backoff', 'exhausted', 'unhealthy'. */
  reason: 'restart' | 'backoff' | 'exhausted' | 'unhealthy';
  /** Bot đã hết lượt restart trong cửa sổ này. */
  exhausted: boolean;
}

/** Loại incident trong log sự cố. */
export type FleetV6IncidentKind =
  | 'crash'
  | 'health-degraded'
  | 'health-unhealthy'
  | 'health-down'
  | 'restart'
  | 'restart-exhausted'
  | 'quota-over'
  | 'recovered';

/** Một sự cố / biến cố sức khoẻ trong incident log. */
export interface FleetV6Incident {
  /** Id ổn định: `fi6-<uuid>`. */
  id: string;
  at: number;
  botId: string;
  kind: FleetV6IncidentKind;
  message: string;
  /** Chi tiết thêm (không secret). */
  detail?: Record<string, unknown>;
}

/** Trạng thái theo dõi sức khoẻ của một bot (lưu bền). */
export interface FleetV6BotHealthState {
  botId: string;
  consecutiveFailures: number;
  /** Các lần crash gần đây (epoch ms, mới nhất cuối). */
  crashHistory: number[];
  /** Các lần restart gần đây (epoch ms). */
  restartHistory: number[];
  /** Lần health check gần nhất (epoch ms). */
  lastCheckAt: number | null;
  /** Trạng thái ở lần check gần nhất. */
  lastStatus: FleetV6HealthStatus | null;
  /** Bot có đang bị đánh dấu unhealthy không. */
  unhealthy: boolean;
  /** Lỗi gần nhất (message ngắn). */
  lastError: string | null;
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export interface CheckFleetV6BotHealthOptions {
  /** Heartbeat quá từng này ms chưa thấy thì stale. Mặc định 60_000. */
  heartbeatTimeoutMs?: number;
  /** Số lỗi gần đây tối đa còn chấp nhận được trước khi degraded. Mặc định 2. */
  maxRecentErrors?: number;
  /** Cửa sổ tính lỗi gần đây (ms). Mặc định 1 giờ. */
  recentErrorWindowMs?: number;
}

/**
 * Health check thuần cho một bot. Nguyên tắc trung thực: heartbeat chưa
 * bao giờ thấy thì `down` (không đoán là healthy); mức dùng chưa đo
 * được thì check resources báo `unknown` chứ không đoán ok.
 */
export function checkFleetV6BotHealth(
  input: FleetV6BotHealthInput,
  now: number,
  options: CheckFleetV6BotHealthOptions = {},
): FleetV6BotHealthResult {
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? FLEET_V6_DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const maxRecentErrors = options.maxRecentErrors ?? 2;
  const recentErrorWindowMs = options.recentErrorWindowMs ?? 60 * 60 * 1000;
  const checks: FleetV6HealthCheck[] = [];

  // 1. Heartbeat.
  let heartbeatOk = false;
  let heartbeatDetail: string;
  if (input.lastHeartbeatAt === null) {
    heartbeatDetail = 'no heartbeat seen yet';
  } else if (now - input.lastHeartbeatAt > heartbeatTimeoutMs) {
    heartbeatDetail = `heartbeat stale (${Math.round((now - input.lastHeartbeatAt) / 1000)}s ago)`;
  } else {
    heartbeatOk = true;
    heartbeatDetail = `heartbeat ${Math.round((now - input.lastHeartbeatAt) / 1000)}s ago`;
  }
  checks.push({ name: 'heartbeat', ok: heartbeatOk, detail: heartbeatDetail });

  // 2. Service state.
  const serviceOk = input.serviceState === 'running';
  checks.push({
    name: 'service-state',
    ok: serviceOk,
    detail: `service ${input.serviceState}`,
  });

  // 3. Resources vs quota (khi có quota + đo được).
  let quotaLevel: QuotaLevel | null = null;
  if (input.quota && input.usage) {
    const evaluation = evaluateBotQuota(input.quota, input.usage, now);
    quotaLevel = evaluation.overall;
    const breach = evaluation.resources.filter((r) => r.level === 'breach').map((r) => r.resource);
    const warning = evaluation.resources.filter((r) => r.level === 'warning').map((r) => r.resource);
    checks.push({
      name: 'resources',
      ok: quotaLevel === 'ok' || quotaLevel === 'unknown',
      detail:
        quotaLevel === 'breach'
          ? `over quota: ${breach.join(', ')}`
          : quotaLevel === 'warning'
            ? `near quota: ${warning.join(', ')}`
            : quotaLevel === 'unknown'
              ? 'usage not measured yet'
              : 'within quota',
    });
  } else {
    checks.push({
      name: 'resources',
      ok: true,
      detail: input.quota ? 'usage not measured yet' : 'no quota set',
    });
  }

  // 4. Lỗi gần đây.
  const recentErrors = input.recentErrors.filter((e) => now - e.at <= recentErrorWindowMs);
  const recentErrorCount = recentErrors.length;
  const errorsOk = recentErrorCount <= maxRecentErrors;
  checks.push({
    name: 'recent-errors',
    ok: errorsOk,
    detail:
      recentErrorCount === 0
        ? 'no recent errors'
        : `${recentErrorCount} error(s) in the last ${Math.round(recentErrorWindowMs / 60000)}m`,
  });

  const lastError = recentErrors.length > 0 ? (recentErrors[0]?.message ?? null) : null;

  // Tổng hợp trạng thái.
  let status: FleetV6HealthStatus;
  const markedUnhealthy = input.consecutiveFailures >= FLEET_V6_DEFAULT_UNHEALTHY_AFTER_FAILURES;
  if (input.serviceState === 'error' || input.lastHeartbeatAt === null) {
    status = 'down';
  } else if (markedUnhealthy) {
    status = 'unhealthy';
  } else if (!heartbeatOk || !errorsOk || quotaLevel === 'breach') {
    status = 'degraded';
  } else if (input.serviceState !== 'running') {
    status = 'degraded';
  } else {
    status = 'healthy';
  }
  // Bot đã bị đánh dấu unhealthy thì giữ nguyên cho tới khi recovered rõ ràng.
  if (markedUnhealthy && status === 'healthy') status = 'unhealthy';

  return {
    botId: input.botId,
    status,
    checks,
    quotaLevel,
    recentErrorCount,
    lastError,
    markedUnhealthy,
    at: now,
  };
}

/**
 * Quyết định restart với backoff tăng dần.
 *
 * - `crashHistory`: các lần crash gần đây (epoch ms) — BAO GỒM lần
 *   crash vừa xảy ra (caller ghi vào store trước khi gọi). Lần crash
 *   này là attempt thứ `inWindow.length` trong cửa sổ (tối thiểu 1).
 * - Hết `maxRestarts` lần trong `restartWindowMs` => lần tiếp theo
 *   (attempt > maxRestarts) thì exhausted, không restart nữa (tránh
 *   vòng lặp crash-restart vô hạn).
 * - `consecutiveFailures >= unhealthyAfterFailures` => không restart
 *   tự động nữa, chờ admin can thiệp (reason 'unhealthy').
 * - Delay = min(base * 2^(attempt-1), maxBackoffMs). Attempt 1 => delay
 *   = base (không restart tức thì để tránh giật liên tục).
 */
export function decideFleetV6Restart(
  policy: FleetV6RestartPolicy,
  crashHistory: number[],
  consecutiveFailures: number,
  now: number,
): FleetV6RestartDecision {
  if (!isPositiveFinite(policy.baseBackoffMs) || !isPositiveFinite(policy.maxBackoffMs)) {
    throw new Error('restart policy needs baseBackoffMs/maxBackoffMs > 0.');
  }
  if (consecutiveFailures >= policy.unhealthyAfterFailures) {
    return { shouldRestart: false, delayMs: 0, attempt: 0, reason: 'unhealthy', exhausted: false };
  }
  const windowStart = now - policy.restartWindowMs;
  const inWindow = crashHistory.filter((at) => at >= windowStart);
  const attempt = Math.max(1, inWindow.length);
  if (inWindow.length > policy.maxRestarts) {
    return { shouldRestart: false, delayMs: 0, attempt, reason: 'exhausted', exhausted: true };
  }
  const delayMs = Math.min(policy.baseBackoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);
  return { shouldRestart: true, delayMs, attempt, reason: attempt === 1 ? 'restart' : 'backoff', exhausted: false };
}

/** Backoff cho lần restart thứ `attempt` (1-based), chặn trên max. */
export function fleetV6RestartBackoffMs(policy: FleetV6RestartPolicy, attempt: number): number {
  if (attempt < 1) throw new Error('restart attempt must be >= 1.');
  return Math.min(policy.baseBackoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);
}

// --- Store trạng thái theo dõi ----------------------------------------------

/** Validate một trạng thái theo dõi bot. */
export function validateFleetV6BotHealthState(raw: unknown): FleetV6BotHealthState {
  if (!isRecord(raw)) throw new Error('fleet v6 bot health state must be an object.');
  const { botId, consecutiveFailures, crashHistory, restartHistory, lastCheckAt, lastStatus, unhealthy, lastError, updatedAt } = raw;
  if (!isNonEmptyString(botId)) throw new Error('health state needs a non-empty botId.');
  if (!isNonNegativeInt(consecutiveFailures)) throw new Error('health state consecutiveFailures must be a non-negative integer.');
  if (!Array.isArray(crashHistory) || crashHistory.some((v) => !isNonNegativeInt(v))) {
    throw new Error('health state crashHistory must be an array of non-negative integers.');
  }
  if (!Array.isArray(restartHistory) || restartHistory.some((v) => !isNonNegativeInt(v))) {
    throw new Error('health state restartHistory must be an array of non-negative integers.');
  }
  if (lastCheckAt !== null && !isNonNegativeInt(lastCheckAt)) throw new Error('health state lastCheckAt must be null or a non-negative integer.');
  if (lastStatus !== null && !FLEET_V6_HEALTH_STATUSES.includes(lastStatus as FleetV6HealthStatus)) {
    throw new Error('health state lastStatus is invalid.');
  }
  if (typeof unhealthy !== 'boolean') throw new Error('health state unhealthy must be a boolean.');
  if (lastError !== null && typeof lastError !== 'string') throw new Error('health state lastError must be null or a string.');
  if (!isNonNegativeInt(updatedAt)) throw new Error('health state updatedAt must be a non-negative integer.');
  return {
    botId: (botId as string).trim(),
    consecutiveFailures: consecutiveFailures as number,
    crashHistory: [...(crashHistory as number[])],
    restartHistory: [...(restartHistory as number[])],
    lastCheckAt: lastCheckAt as number | null,
    lastStatus: lastStatus as FleetV6HealthStatus | null,
    unhealthy: unhealthy as boolean,
    lastError: lastError as string | null,
    updatedAt: updatedAt as number,
  };
}

/** Trạng thái trống cho một bot chưa từng được theo dõi. */
export function emptyFleetV6BotHealthState(botId: string, now: number = Date.now()): FleetV6BotHealthState {
  return {
    botId,
    consecutiveFailures: 0,
    crashHistory: [],
    restartHistory: [],
    lastCheckAt: null,
    lastStatus: null,
    unhealthy: false,
    lastError: null,
    updatedAt: now,
  };
}

export function getFleetV6HealthPath(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('fleet v6 health needs a non-empty rootDir.');
  }
  return path.join(rootDir, FLEET_V6_HEALTH_FILE);
}

export function getFleetV6IncidentsPath(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('fleet v6 incidents need a non-empty rootDir.');
  }
  return path.join(rootDir, FLEET_V6_INCIDENTS_FILE);
}

/** Load toàn bộ trạng thái theo dõi (file thiếu = chưa có bot nào). */
export function loadFleetV6HealthStates(rootDir: string): FleetV6BotHealthState[] {
  const filePath = getFleetV6HealthPath(rootDir);
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
    throw new Error(`${FLEET_V6_HEALTH_FILE} is corrupt: not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${FLEET_V6_HEALTH_FILE} is corrupt: expected an array.`);
  return parsed.map((entry, i) => {
    try {
      return validateFleetV6BotHealthState(entry);
    } catch (err) {
      throw new Error(`${FLEET_V6_HEALTH_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
}

/** Lưu toàn bộ trạng thái theo dõi (atomic tmp + rename, mode 0600). */
export function saveFleetV6HealthStates(rootDir: string, states: FleetV6BotHealthState[]): void {
  const valid = states.map((s) => validateFleetV6BotHealthState(s));
  const filePath = getFleetV6HealthPath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX modes.
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Ghi một lần crash cho bot: tăng consecutiveFailures, thêm vào
 * crashHistory (chỉ giữ trong cửa sổ restart), cập nhật lastError.
 * Trả về state mới (caller tự save).
 */
export function recordFleetV6Crash(
  states: FleetV6BotHealthState[],
  botId: string,
  at: number,
  message: string,
  policy: FleetV6RestartPolicy = DEFAULT_FLEET_V6_RESTART_POLICY,
): FleetV6BotHealthState[] {
  const windowStart = at - policy.restartWindowMs;
  const existing = states.find((s) => s.botId === botId);
  const base = existing ?? emptyFleetV6BotHealthState(botId, at);
  // Bot đã chạy ổn đủ lâu thì reset đếm liên tiếp trước khi tính crash mới.
  const stableSince = base.lastCheckAt !== null && base.lastStatus === 'healthy' ? base.lastCheckAt : null;
  const reset = stableSince !== null && at - stableSince >= policy.stableResetMs;
  const updated: FleetV6BotHealthState = {
    ...base,
    consecutiveFailures: reset ? 1 : base.consecutiveFailures + 1,
    crashHistory: [...base.crashHistory.filter((t) => t >= windowStart), at],
    lastError: message.slice(0, 500),
    updatedAt: at,
  };
  updated.unhealthy = updated.consecutiveFailures >= policy.unhealthyAfterFailures;
  return states.some((s) => s.botId === botId)
    ? states.map((s) => (s.botId === botId ? updated : s))
    : [...states, updated];
}

/**
 * Ghi một lần restart thành công cho bot (thêm vào restartHistory).
 */
export function recordFleetV6Restart(
  states: FleetV6BotHealthState[],
  botId: string,
  at: number,
  policy: FleetV6RestartPolicy = DEFAULT_FLEET_V6_RESTART_POLICY,
): FleetV6BotHealthState[] {
  const windowStart = at - policy.restartWindowMs;
  const existing = states.find((s) => s.botId === botId);
  const base = existing ?? emptyFleetV6BotHealthState(botId, at);
  const updated: FleetV6BotHealthState = {
    ...base,
    restartHistory: [...base.restartHistory.filter((t) => t >= windowStart), at],
    updatedAt: at,
  };
  return states.some((s) => s.botId === botId)
    ? states.map((s) => (s.botId === botId ? updated : s))
    : [...states, updated];
}

/**
 * Ghi một lần health check thành công: cập nhật lastCheckAt/lastStatus,
 * reset consecutiveFailures khi bot healthy (recovered).
 */
export function recordFleetV6HealthCheck(
  states: FleetV6BotHealthState[],
  result: FleetV6BotHealthResult,
): FleetV6BotHealthState[] {
  const existing = states.find((s) => s.botId === result.botId);
  const base = existing ?? emptyFleetV6BotHealthState(result.botId, result.at);
  const recovered = result.status === 'healthy';
  const updated: FleetV6BotHealthState = {
    ...base,
    consecutiveFailures: recovered ? 0 : base.consecutiveFailures,
    unhealthy: recovered ? false : base.unhealthy,
    lastCheckAt: result.at,
    lastStatus: result.status,
    lastError: result.lastError ?? base.lastError,
    updatedAt: result.at,
  };
  return states.some((s) => s.botId === result.botId)
    ? states.map((s) => (s.botId === result.botId ? updated : s))
    : [...states, updated];
}

// --- Incident log -----------------------------------------------------------

/** Validate một incident. */
export function validateFleetV6Incident(raw: unknown): FleetV6Incident {
  if (!isRecord(raw)) throw new Error('fleet v6 incident must be an object.');
  const { id, at, botId, kind, message, detail } = raw;
  const kinds: readonly string[] = ['crash', 'health-degraded', 'health-unhealthy', 'health-down', 'restart', 'restart-exhausted', 'quota-over', 'recovered'];
  if (!isNonEmptyString(id)) throw new Error('incident needs a non-empty id.');
  if (!isNonNegativeInt(at)) throw new Error('incident at must be a non-negative integer.');
  if (!isNonEmptyString(botId)) throw new Error('incident needs a non-empty botId.');
  if (typeof kind !== 'string' || !kinds.includes(kind)) throw new Error('incident kind is invalid.');
  if (!isNonEmptyString(message)) throw new Error('incident needs a non-empty message.');
  if (detail !== undefined && !isRecord(detail)) throw new Error('incident detail must be an object when present.');
  return {
    id: (id as string).trim(),
    at: at as number,
    botId: (botId as string).trim(),
    kind: kind as FleetV6IncidentKind,
    message: (message as string).trim(),
    ...(detail ? { detail: detail as Record<string, unknown> } : {}),
  };
}

/** Tạo một incident mới (chưa ghi file). */
export function createFleetV6Incident(
  botId: string,
  kind: FleetV6IncidentKind,
  message: string,
  at: number = Date.now(),
  detail?: Record<string, unknown>,
): FleetV6Incident {
  return validateFleetV6Incident({
    id: `fi6-${crypto.randomUUID()}`,
    at,
    botId,
    kind,
    message,
    ...(detail ? { detail } : {}),
  });
}

/** Append một incident vào log (giữ tối đa FLEET_V6_MAX_INCIDENTS dòng mới nhất). */
export function appendFleetV6Incident(rootDir: string, incident: FleetV6Incident): void {
  const valid = validateFleetV6Incident(incident);
  const filePath = getFleetV6IncidentsPath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // v1.09 merge fix: append in TRUE file order (oldest first). The old code
  // read back through listFleetV6Incidents (newest-first sort) and rewrote
  // the file in that order, so the file was never in append order — with two
  // incidents sharing one millisecond the round-trip order became arbitrary
  // and the health test flaked. The newest-first view stays in list only.
  const existing = readFleetV6IncidentLines(rootDir);
  const next = [...existing, valid].slice(-FLEET_V6_MAX_INCIDENTS);
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX modes.
  }
  fs.renameSync(tmp, filePath);
}

/** Read the incident log in file order (oldest first); corrupt lines skipped. */
function readFleetV6IncidentLines(rootDir: string): FleetV6Incident[] {
  const filePath = getFleetV6IncidentsPath(rootDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const incidents: FleetV6Incident[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      incidents.push(validateFleetV6Incident(JSON.parse(trimmed)));
    } catch {
      // Dòng hỏng thì bỏ qua — log sự cố không được crash vì một dòng hỏng.
      continue;
    }
  }
  return incidents;
}

/** Đọc incident log (dòng hỏng thì bỏ qua kèm đếm — không crash cả log). */
export function listFleetV6Incidents(
  rootDir: string,
  filter: { botId?: string; since?: number; until?: number; kind?: FleetV6IncidentKind; limit?: number } = {},
): FleetV6Incident[] {
  const incidents = readFleetV6IncidentLines(rootDir);
  let out = incidents;
  if (filter.botId) out = out.filter((i) => i.botId === filter.botId);
  if (filter.kind) out = out.filter((i) => i.kind === filter.kind);
  if (filter.since !== undefined) out = out.filter((i) => i.at >= (filter.since as number));
  if (filter.until !== undefined) out = out.filter((i) => i.at <= (filter.until as number));
  // v1.09 merge fix: timestamp ties are common (several incidents can land in
  // the same millisecond) — break ties by append order (later line = newer),
  // otherwise the "newest first" list is non-deterministic and the health
  // round-trip test flakes when a crash and the restart share one ms.
  out = out
    .map((incident, index) => ({ incident, index }))
    .sort((a, b) => b.incident.at - a.incident.at || b.index - a.index)
    .map(({ incident }) => incident);
  if (filter.limit !== undefined) out = out.slice(0, filter.limit);
  return out;
}

/** Một dòng tóm tắt incident cho UI/log. */
export function formatFleetV6IncidentLine(incident: FleetV6Incident): string {
  const when = new Date(incident.at).toISOString();
  return `[${when}] ${incident.botId} ${incident.kind}: ${incident.message}`;
}
