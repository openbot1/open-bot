/**
 * Fleet policy v4 (v1.05, Team T6) — chính sách phân bổ của fleet:
 * số bot chạy đồng thời tối đa, quota token theo bot, ưu tiên mặc
 * định, giới hạn restart, số task tối đa mỗi bot.
 *
 * Nối tiếp fleet v3 (`scheduling.ts` — placement theo workspace,
 * `quotas.ts` — quota tài nguyên CPU/RAM/đĩa, `dispatch.ts` — job
 * queue): policy này là lớp QUY TẮC VẬN HÀNH trên cùng — orchestrator
 * v4 (`orchestration.ts`) hỏi policy trước mỗi quyết định (nhận task?
 * restart bot? chạy thêm bot?) và `enforceFleetPolicy` liệt kê vi
 * phạm để UI/tool cảnh báo.
 *
 * Lưu trữ: `<fleetRoot>/fleet-policy-v4.json` (atomic tmp + rename,
 * mode 0600, cùng posture với fleet-schedule.json). File thiếu =
 * policy mặc định.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const FLEET_POLICY_V4_FILE = 'fleet-policy-v4.json';

/** Mức ưu tiên task của fleet (1 = thấp nhất, 5 = cao nhất). */
export type FleetTaskPriority = 1 | 2 | 3 | 4 | 5;

export const FLEET_TASK_PRIORITIES: readonly FleetTaskPriority[] = [1, 2, 3, 4, 5];

/** Chính sách phân bổ của fleet. */
export interface FleetPolicyV4 {
  /** Số bot được chạy đồng thời tối đa (0 = không giới hạn). */
  maxConcurrentBots: number;
  /** Quota token mỗi bot trong một chu kỳ quota (0 = không giới hạn). */
  perBotTokenQuota: number;
  /** Chu kỳ quota token (ms). Mặc định 1 ngày. */
  tokenQuotaPeriodMs: number;
  /** Ưu tiên mặc định cho task không ghi ưu tiên. */
  defaultPriority: FleetTaskPriority;
  /** Số lần auto-restart tối đa mỗi bot trong một giờ (0 = không restart tự động). */
  maxRestartsPerHour: number;
  /** Số task chạy đồng thời tối đa trên một bot (0 = không giới hạn). */
  maxTasksPerBot: number;
  /** Chỉ giao task cho bot có đủ capability yêu cầu (true = chặn, false = chỉ cảnh báo). */
  requireCapabilityMatch: boolean;
}

export const DEFAULT_FLEET_POLICY_V4: FleetPolicyV4 = {
  maxConcurrentBots: 10,
  perBotTokenQuota: 1_000_000,
  tokenQuotaPeriodMs: 24 * 60 * 60 * 1000,
  defaultPriority: 3,
  maxRestartsPerHour: 3,
  maxTasksPerBot: 4,
  requireCapabilityMatch: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validate một policy v4 (throws khi sai; thiếu field = dùng mặc định). */
export function validateFleetPolicyV4(raw: unknown): FleetPolicyV4 {
  if (!isRecord(raw)) throw new Error('fleet policy v4 must be an object.');
  const policy: FleetPolicyV4 = { ...DEFAULT_FLEET_POLICY_V4 };
  if (raw.maxConcurrentBots !== undefined) {
    if (!isNonNegativeInt(raw.maxConcurrentBots)) {
      throw new Error('fleet policy maxConcurrentBots must be an integer >= 0.');
    }
    policy.maxConcurrentBots = raw.maxConcurrentBots;
  }
  if (raw.perBotTokenQuota !== undefined) {
    if (!isNonNegativeInt(raw.perBotTokenQuota)) {
      throw new Error('fleet policy perBotTokenQuota must be an integer >= 0.');
    }
    policy.perBotTokenQuota = raw.perBotTokenQuota;
  }
  if (raw.tokenQuotaPeriodMs !== undefined) {
    if (typeof raw.tokenQuotaPeriodMs !== 'number' || !Number.isFinite(raw.tokenQuotaPeriodMs) || raw.tokenQuotaPeriodMs <= 0) {
      throw new Error('fleet policy tokenQuotaPeriodMs must be a number > 0.');
    }
    policy.tokenQuotaPeriodMs = raw.tokenQuotaPeriodMs;
  }
  if (raw.defaultPriority !== undefined) {
    if (!FLEET_TASK_PRIORITIES.includes(raw.defaultPriority as FleetTaskPriority)) {
      throw new Error('fleet policy defaultPriority must be an integer 1..5.');
    }
    policy.defaultPriority = raw.defaultPriority as FleetTaskPriority;
  }
  if (raw.maxRestartsPerHour !== undefined) {
    if (!isNonNegativeInt(raw.maxRestartsPerHour)) {
      throw new Error('fleet policy maxRestartsPerHour must be an integer >= 0.');
    }
    policy.maxRestartsPerHour = raw.maxRestartsPerHour;
  }
  if (raw.maxTasksPerBot !== undefined) {
    if (!isNonNegativeInt(raw.maxTasksPerBot)) {
      throw new Error('fleet policy maxTasksPerBot must be an integer >= 0.');
    }
    policy.maxTasksPerBot = raw.maxTasksPerBot;
  }
  if (raw.requireCapabilityMatch !== undefined) {
    if (typeof raw.requireCapabilityMatch !== 'boolean') {
      throw new Error('fleet policy requireCapabilityMatch must be a boolean.');
    }
    policy.requireCapabilityMatch = raw.requireCapabilityMatch;
  }
  return policy;
}

export function getFleetPolicyV4Path(fleetRoot: string): string {
  if (typeof fleetRoot !== 'string' || fleetRoot.trim().length === 0) {
    throw new Error('fleet policy v4 needs a non-empty fleetRoot.');
  }
  return path.join(fleetRoot, FLEET_POLICY_V4_FILE);
}

/** Đọc policy v4 (file thiếu = mặc định; file hỏng = throw). */
export function loadFleetPolicyV4(fleetRoot: string): FleetPolicyV4 {
  const filePath = getFleetPolicyV4Path(fleetRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_FLEET_POLICY_V4 };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${FLEET_POLICY_V4_FILE} is corrupt: not valid JSON.`);
  }
  return validateFleetPolicyV4(parsed);
}

/** Ghi policy v4 (atomic tmp + rename, mode 0600). */
export function saveFleetPolicyV4(fleetRoot: string, policy: FleetPolicyV4): FleetPolicyV4 {
  const valid = validateFleetPolicyV4(policy);
  const filePath = getFleetPolicyV4Path(fleetRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX modes.
  }
  fs.renameSync(tmp, filePath);
  return valid;
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/** Ảnh chụp nhanh trạng thái fleet để kiểm tra policy (không cần FleetManager thật). */
export interface FleetPolicySnapshot {
  /** Số bot đang chạy (healthy + degraded). */
  runningBots: number;
  /** Số task đang chạy trên mỗi bot. */
  runningTasksByBot: Record<string, number>;
  /** Token đã dùng trong chu kỳ quota hiện tại, theo bot. */
  tokenUsageByBot: Record<string, number>;
  /** Số lần restart trong giờ qua, theo bot. */
  restartsLastHourByBot: Record<string, number>;
  /** Capability mỗi bot có (để kiểm tra requireCapabilityMatch). */
  capabilitiesByBot?: Record<string, string[]>;
  /** Capability mà task đang chờ yêu cầu (botId -> capability thiếu). */
  missingCapabilitiesByBot?: Record<string, string[]>;
}

/** Một vi phạm policy. */
export interface FleetPolicyViolation {
  /** Quy tắc bị vi phạm. */
  rule:
    | 'max-concurrent-bots'
    | 'per-bot-token-quota'
    | 'max-restarts-per-hour'
    | 'max-tasks-per-bot'
    | 'capability-match';
  /** Bot liên quan (undefined = vi phạm toàn fleet). */
  botId?: string;
  severity: 'warn' | 'block';
  detail: string;
}

/**
 * Kiểm tra toàn bộ snapshot theo policy, trả về mọi vi phạm.
 * - 'block': vượt giới hạn cứng (không nhận thêm bot/task, không restart);
 * - 'warn': vượt ngưỡng mềm — ở đây quota token 90% trở lên là warn,
 *   vượt 100% là block; capability thiếu là block khi
 *   requireCapabilityMatch = true, warn khi false.
 */
export function enforceFleetPolicy(
  policy: FleetPolicyV4,
  snapshot: FleetPolicySnapshot,
): FleetPolicyViolation[] {
  const pol = validateFleetPolicyV4(policy);
  const violations: FleetPolicyViolation[] = [];
  if (pol.maxConcurrentBots > 0 && snapshot.runningBots > pol.maxConcurrentBots) {
    violations.push({
      rule: 'max-concurrent-bots',
      severity: 'block',
      detail: `${snapshot.runningBots} bots running, over the limit of ${pol.maxConcurrentBots}.`,
    });
  }
  for (const [botId, tasks] of Object.entries(snapshot.runningTasksByBot)) {
    if (pol.maxTasksPerBot > 0 && tasks > pol.maxTasksPerBot) {
      violations.push({
        rule: 'max-tasks-per-bot',
        botId,
        severity: 'block',
        detail: `bot "${botId}" runs ${tasks} tasks, over the limit of ${pol.maxTasksPerBot}.`,
      });
    }
  }
  for (const [botId, used] of Object.entries(snapshot.tokenUsageByBot)) {
    if (pol.perBotTokenQuota <= 0) continue;
    if (used > pol.perBotTokenQuota) {
      violations.push({
        rule: 'per-bot-token-quota',
        botId,
        severity: 'block',
        detail: `bot "${botId}" used ${used} tokens, over the quota of ${pol.perBotTokenQuota}.`,
      });
    } else if (used >= pol.perBotTokenQuota * 0.9) {
      violations.push({
        rule: 'per-bot-token-quota',
        botId,
        severity: 'warn',
        detail: `bot "${botId}" used ${used} tokens (${Math.round((used / pol.perBotTokenQuota) * 100)}% of the ${pol.perBotTokenQuota} quota).`,
      });
    }
  }
  for (const [botId, restarts] of Object.entries(snapshot.restartsLastHourByBot)) {
    if (pol.maxRestartsPerHour > 0 && restarts > pol.maxRestartsPerHour) {
      violations.push({
        rule: 'max-restarts-per-hour',
        botId,
        severity: 'block',
        detail: `bot "${botId}" restarted ${restarts} times in the last hour (limit ${pol.maxRestartsPerHour}).`,
      });
    }
  }
  if (snapshot.missingCapabilitiesByBot) {
    for (const [botId, missing] of Object.entries(snapshot.missingCapabilitiesByBot)) {
      if (missing.length === 0) continue;
      violations.push({
        rule: 'capability-match',
        botId,
        severity: pol.requireCapabilityMatch ? 'block' : 'warn',
        detail: `bot "${botId}" lacks required capabilities: ${missing.join(', ')}.`,
      });
    }
  }
  return violations;
}

/** Bot này có còn quota token để chạy thêm `tokens` token nữa không. */
export function checkBotTokenQuota(
  policy: FleetPolicyV4,
  botId: string,
  usedTokens: number,
  additionalTokens = 0,
): { allowed: boolean; remaining: number | null; detail: string } {
  const pol = validateFleetPolicyV4(policy);
  if (typeof botId !== 'string' || botId.trim() === '') {
    throw new Error('checkBotTokenQuota needs a non-empty botId.');
  }
  if (!Number.isFinite(usedTokens) || usedTokens < 0 || !Number.isFinite(additionalTokens) || additionalTokens < 0) {
    throw new Error('checkBotTokenQuota needs non-negative token counts.');
  }
  if (pol.perBotTokenQuota <= 0) {
    return { allowed: true, remaining: null, detail: `bot "${botId}" has no token quota limit.` };
  }
  const remaining = pol.perBotTokenQuota - usedTokens;
  const allowed = usedTokens + additionalTokens <= pol.perBotTokenQuota;
  return {
    allowed,
    remaining,
    detail: allowed
      ? `bot "${botId}" has ${remaining} tokens left of ${pol.perBotTokenQuota}.`
      : `bot "${botId}" would exceed its ${pol.perBotTokenQuota} token quota (${usedTokens} used + ${additionalTokens} requested).`,
  };
}

/** Bot này có được restart tự động nữa không (theo số restart giờ qua). */
export function canAutoRestartBot(policy: FleetPolicyV4, restartsLastHour: number): boolean {
  const pol = validateFleetPolicyV4(policy);
  if (pol.maxRestartsPerHour <= 0) return false;
  return restartsLastHour < pol.maxRestartsPerHour;
}

/** Fleet này có được chạy thêm một bot nữa không. */
export function canStartAnotherBot(policy: FleetPolicyV4, runningBots: number): boolean {
  const pol = validateFleetPolicyV4(policy);
  if (pol.maxConcurrentBots <= 0) return true;
  return runningBots < pol.maxConcurrentBots;
}
