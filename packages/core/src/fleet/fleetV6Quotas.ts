/**
 * Fleet quota groups v6 — quota theo bot HOẶC theo nhóm bot (v1.09, Đội T6).
 *
 * `fleet/quotas.ts` (v2) đặt quota cho từng bot riêng lẻ. Module này mở
 * rộng lên NHÓM: một nhóm (vd "content-team", "night-batch") gồm nhiều
 * bot chia chung một trần CPU/RAM/đĩa. Mức dùng của nhóm = tổng mức dùng
 * đo được của các bot trong nhóm — không bao giờ cộng số "đã cấp".
 *
 * Hành động khi vượt quota (theo mức nghiêm trọng nhất trong nhóm):
 * - `warn`: chỉ cảnh báo (vượt ngưỡng warnPercent nhưng chưa vượt trần).
 * - `throttle`: giảm concurrency — mỗi bot trong nhóm chỉ còn tối đa
 *   `throttleMaxConcurrent` lần chạy đồng thời (mặc định 1), không giết
 *   bot đang chạy.
 * - `pause`: tạm dừng bot — bot bị pause không được nhận task mới cho
 *   tới khi mức dùng tụt xuống dưới trần (caller tự resume qua
 *   `fleet_quota_pause` / `resolveFleetV6PausedBots`).
 *
 * Quota nhóm sống trong `<fleetRoot>/fleet-quota-groups-v109.json`
 * (atomic tmp + rename, mode 0600, cùng tư thế với fleet-quotas.json).
 * Đánh giá là hàm thuần (`evaluateFleetV6QuotaGroups`) nhận mức dùng
 * đã đo — dễ test, không đoán số. Mức dùng chưa đo được thì báo
 * `unknown`, không đoán là 0 (nguyên tắc trung thực của fleet).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  QUOTA_DEFAULT_WARN_PERCENT,
  evaluateBotQuota,
  type BotQuota,
  type BotUsageSnapshot,
  type QuotaLevel,
  type QuotaResource,
  type QuotaResourceStatus,
} from './quotas';

/** File lưu quota nhóm v6 trong fleet root. */
export const FLEET_V6_QUOTA_GROUPS_FILE = 'fleet-quota-groups-v109.json';
/** Số cảnh báo tối đa giữ lại mỗi lần đánh giá (mới nhất trước). */
export const FLEET_V6_QUOTA_MAX_ALERTS = 100;
/** Khi throttle, mỗi bot trong nhóm còn tối đa từng này lần chạy đồng thời. */
export const FLEET_V6_DEFAULT_THROTTLE_MAX_CONCURRENT = 1;

export type FleetV6QuotaAction = 'none' | 'warn' | 'throttle' | 'pause';

/** Một nhóm bot chia chung một trần tài nguyên. */
export interface FleetV6QuotaGroup {
  /** Id ổn định: `qg6-<uuid>`. */
  id: string;
  /** Tên hiển thị của nhóm (duy nhất trong fleet). */
  name: string;
  /** Bot thuộc nhóm (id workspace/bot). */
  botIds: string[];
  /** Trần CPU (core, dạng rate). */
  cpuCoresMax: number;
  /** Trần RAM (bytes). */
  ramBytesMax: number;
  /** Trần đĩa (bytes). */
  diskBytesMax: number;
  /** Cảnh báo ở tỉ lệ này của trần (0 < warnPercent < 1). */
  warnPercent: number;
  /** Nhóm tắt thì lưu trữ nhưng không bao giờ đánh giá. */
  enabled: boolean;
  /** Khi throttle, mỗi bot trong nhóm còn tối đa từng này lần chạy đồng thời. */
  throttleMaxConcurrent: number;
  updatedAt: string;
  updatedBy: string;
}

/** Đầu vào tạo/cập nhật một nhóm quota. */
export interface SetFleetV6QuotaGroupInput {
  /** Id nhóm — để trống khi tạo mới. */
  id?: string;
  name: string;
  botIds: string[];
  cpuCoresMax: number;
  ramBytesMax: number;
  diskBytesMax: number;
  warnPercent?: number;
  enabled?: boolean;
  throttleMaxConcurrent?: number;
}

/** Mức dùng đã đo của một bot (null = chưa đo được tài nguyên đó). */
export type FleetV6BotUsage = BotUsageSnapshot;

/** Đánh giá quota cho một phạm vi (bot đơn hoặc nhóm). */
export interface FleetV6QuotaEvaluation {
  /** 'bot' = quota v2 của một bot; 'group' = quota nhóm v6. */
  scope: 'bot' | 'group';
  /** Id bot (scope bot) hoặc id nhóm (scope group). */
  id: string;
  /** Tên hiển thị (tên bot hoặc tên nhóm). */
  name: string;
  /** Bot chịu ảnh hưởng (1 bot với scope bot, mọi bot trong nhóm với scope group). */
  botIds: string[];
  resources: QuotaResourceStatus[];
  /** Mức nghiêm trọng nhất: ok | warning | breach | unknown. */
  overall: QuotaLevel;
  action: FleetV6QuotaAction;
  /** Khi action = 'throttle': concurrency tối đa mỗi bot. */
  throttleMaxConcurrent: number | null;
  /** Khi action = 'pause': bot bị tạm dừng (không nhận task mới). */
  pausedBotIds: string[];
  at: number;
}

/** Một cảnh báo quota v6 (để UI/log gom lại). */
export interface FleetV6QuotaAlert {
  at: number;
  scope: 'bot' | 'group';
  id: string;
  name: string;
  resource: QuotaResource;
  /** Tỉ lệ dùng/trần — null khi chưa đo được. */
  percent: number | null;
  level: QuotaLevel;
  action: FleetV6QuotaAction;
  message: string;
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

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

const LEVEL_RANK: Record<QuotaLevel, number> = { ok: 0, unknown: 1, warning: 2, breach: 3 };
const ACTION_RANK: Record<FleetV6QuotaAction, number> = { none: 0, warn: 1, throttle: 2, pause: 3 };

function actionForLevel(level: QuotaLevel, throttleMaxConcurrent: number): FleetV6QuotaAction {
  if (level === 'breach') return 'pause';
  if (level === 'warning') return 'throttle';
  return 'none';
}

/** Validate một nhóm quota v6 (ném lỗi khi trường nào hỏng). */
export function validateFleetV6QuotaGroup(raw: unknown): FleetV6QuotaGroup {
  if (!isRecord(raw)) throw new Error('fleet v6 quota group must be an object.');
  const { id, name, botIds, cpuCoresMax, ramBytesMax, diskBytesMax, warnPercent, enabled, throttleMaxConcurrent, updatedAt, updatedBy } = raw;
  if (!isNonEmptyString(id)) throw new Error('quota group needs a non-empty id.');
  if (!isNonEmptyString(name)) throw new Error('quota group needs a non-empty name.');
  if (!Array.isArray(botIds) || botIds.length === 0 || botIds.some((b) => !isNonEmptyString(b))) {
    throw new Error('quota group needs a non-empty botIds array of non-empty strings.');
  }
  const unique = new Set((botIds as string[]).map((b) => b.trim()));
  if (unique.size !== (botIds as string[]).length) throw new Error('quota group botIds must be unique.');
  if (!isPositiveFinite(cpuCoresMax)) throw new Error('quota group cpuCoresMax must be a number > 0.');
  if (!isPositiveFinite(ramBytesMax)) throw new Error('quota group ramBytesMax must be a number > 0.');
  if (!isPositiveFinite(diskBytesMax)) throw new Error('quota group diskBytesMax must be a number > 0.');
  if (typeof warnPercent !== 'number' || !Number.isFinite(warnPercent) || warnPercent <= 0 || warnPercent >= 1) {
    throw new Error('quota group warnPercent must be a number between 0 and 1 (exclusive).');
  }
  if (typeof enabled !== 'boolean') throw new Error('quota group enabled must be a boolean.');
  if (!isNonNegativeInt(throttleMaxConcurrent) || (throttleMaxConcurrent as number) < 1) {
    throw new Error('quota group throttleMaxConcurrent must be an integer >= 1.');
  }
  if (!isNonEmptyString(updatedAt)) throw new Error('quota group needs a non-empty updatedAt.');
  if (!isNonEmptyString(updatedBy)) throw new Error('quota group needs a non-empty updatedBy.');
  return {
    id: (id as string).trim(),
    name: (name as string).trim(),
    botIds: (botIds as string[]).map((b) => b.trim()),
    cpuCoresMax: cpuCoresMax as number,
    ramBytesMax: ramBytesMax as number,
    diskBytesMax: diskBytesMax as number,
    warnPercent: warnPercent as number,
    enabled,
    throttleMaxConcurrent: throttleMaxConcurrent as number,
    updatedAt: updatedAt as string,
    updatedBy: updatedBy as string,
  };
}

/** Cộng dồn mức dùng đã đo của nhiều bot (null lan truyền: chưa đo đủ thì unknown). */
export function sumFleetV6BotUsage(usages: FleetV6BotUsage[]): FleetV6BotUsage {
  let cpu: number | null = 0;
  let ram: number | null = 0;
  let disk: number | null = 0;
  let cpuKnown = false;
  let ramKnown = false;
  let diskKnown = false;
  for (const usage of usages) {
    if (usage.cpuCoresUsed !== null && Number.isFinite(usage.cpuCoresUsed)) {
      cpu = (cpu ?? 0) + usage.cpuCoresUsed;
      cpuKnown = true;
    }
    if (usage.ramBytesUsed !== null && Number.isFinite(usage.ramBytesUsed)) {
      ram = (ram ?? 0) + usage.ramBytesUsed;
      ramKnown = true;
    }
    if (usage.diskBytesUsed !== null && Number.isFinite(usage.diskBytesUsed)) {
      disk = (disk ?? 0) + usage.diskBytesUsed;
      diskKnown = true;
    }
  }
  return {
    cpuCoresUsed: cpuKnown ? cpu : null,
    ramBytesUsed: ramKnown ? ram : null,
    diskBytesUsed: diskKnown ? disk : null,
  };
}

/**
 * Đánh giá một nhóm quota với mức dùng đã đo của các bot trong nhóm.
 * Nhóm tắt (enabled = false) thì trả về overall 'unknown', action 'none'.
 */
export function evaluateFleetV6QuotaGroup(
  group: FleetV6QuotaGroup,
  usageByBot: Record<string, FleetV6BotUsage>,
  at: number = Date.now(),
): FleetV6QuotaEvaluation {
  const botIds = [...group.botIds];
  const empty: FleetV6QuotaEvaluation = {
    scope: 'group',
    id: group.id,
    name: group.name,
    botIds,
    resources: (['cpu', 'ram', 'disk'] as const).map((resource) => ({
      resource,
      used: null,
      limit: resource === 'cpu' ? group.cpuCoresMax : resource === 'ram' ? group.ramBytesMax : group.diskBytesMax,
      percent: null,
      level: 'unknown' as QuotaLevel,
    })),
    overall: 'unknown',
    action: 'none',
    throttleMaxConcurrent: null,
    pausedBotIds: [],
    at,
  };
  if (!group.enabled) return empty;
  // Tái dùng evaluator của quota v2 bằng cách dựng một BotQuota tạm từ nhóm.
  const asBotQuota: BotQuota = {
    botId: group.id,
    cpuCoresMax: group.cpuCoresMax,
    ramBytesMax: group.ramBytesMax,
    diskBytesMax: group.diskBytesMax,
    warnPercent: group.warnPercent,
    enabled: true,
    updatedAt: group.updatedAt,
    updatedBy: group.updatedBy,
  };
  const usage = sumFleetV6BotUsage(botIds.map((botId) => usageByBot[botId] ?? { cpuCoresUsed: null, ramBytesUsed: null, diskBytesUsed: null }));
  const base = evaluateBotQuota(asBotQuota, usage, at);
  const overall = base.overall;
  const action = actionForLevel(overall, group.throttleMaxConcurrent);
  return {
    scope: 'group',
    id: group.id,
    name: group.name,
    botIds,
    resources: base.resources,
    overall,
    action,
    throttleMaxConcurrent: action === 'throttle' ? group.throttleMaxConcurrent : null,
    pausedBotIds: action === 'pause' ? botIds : [],
    at,
  };
}

/**
 * Đánh giá toàn bộ: quota nhóm v6 + quota bot v2 (khi caller đưa vào).
 * Kết quả sắp theo mức nghiêm trọng giảm dần (breach trước, rồi warning).
 */
export function evaluateFleetV6Quotas(
  groups: FleetV6QuotaGroup[],
  usageByBot: Record<string, FleetV6BotUsage>,
  botQuotas: BotQuota[] = [],
  at: number = Date.now(),
): FleetV6QuotaEvaluation[] {
  const evaluations: FleetV6QuotaEvaluation[] = [];
  for (const group of groups) {
    evaluations.push(evaluateFleetV6QuotaGroup(group, usageByBot, at));
  }
  for (const quota of botQuotas) {
    const usage = usageByBot[quota.botId] ?? { cpuCoresUsed: null, ramBytesUsed: null, diskBytesUsed: null };
    const base = evaluateBotQuota(quota, usage, at);
    const action = quota.enabled ? actionForLevel(base.overall, FLEET_V6_DEFAULT_THROTTLE_MAX_CONCURRENT) : 'none';
    evaluations.push({
      scope: 'bot',
      id: quota.botId,
      name: quota.botId,
      botIds: [quota.botId],
      resources: base.resources,
      overall: quota.enabled ? base.overall : 'unknown',
      action,
      throttleMaxConcurrent: action === 'throttle' ? FLEET_V6_DEFAULT_THROTTLE_MAX_CONCURRENT : null,
      pausedBotIds: action === 'pause' ? [quota.botId] : [],
      at,
    });
  }
  evaluations.sort((a, b) => {
    const rank = LEVEL_RANK[b.overall] - LEVEL_RANK[a.overall];
    if (rank !== 0) return rank;
    return ACTION_RANK[b.action] - ACTION_RANK[a.action];
  });
  return evaluations;
}

/** Gom cảnh báo từ các đánh giá (tối đa FLEET_V6_QUOTA_MAX_ALERTS, mới nhất trước). */
export function fleetV6QuotaAlerts(evaluations: FleetV6QuotaEvaluation[]): FleetV6QuotaAlert[] {
  const alerts: FleetV6QuotaAlert[] = [];
  for (const evaluation of evaluations) {
    for (const resource of evaluation.resources) {
      if (resource.level === 'ok' || resource.level === 'unknown') continue;
      const percentText = resource.percent === null ? 'unknown' : `${Math.round(resource.percent * 100)}%`;
      alerts.push({
        at: evaluation.at,
        scope: evaluation.scope,
        id: evaluation.id,
        name: evaluation.name,
        resource: resource.resource,
        percent: resource.percent,
        level: resource.level,
        action: evaluation.action,
        message:
          evaluation.scope === 'group'
            ? `Quota group "${evaluation.name}" ${resource.resource} at ${percentText} of limit (${resource.level}, action ${evaluation.action}).`
            : `Bot "${evaluation.name}" ${resource.resource} at ${percentText} of quota (${resource.level}, action ${evaluation.action}).`,
      });
    }
  }
  return alerts.slice(0, FLEET_V6_QUOTA_MAX_ALERTS);
}

/**
 * Bot nào đang bị pause bởi quota (từ các đánh giá breach). Caller dùng
 * tập này để chặn task mới cho bot đó.
 */
export function pausedBotsFromFleetV6Evaluations(evaluations: FleetV6QuotaEvaluation[]): Set<string> {
  const paused = new Set<string>();
  for (const evaluation of evaluations) {
    for (const botId of evaluation.pausedBotIds) paused.add(botId);
  }
  return paused;
}

/**
 * Concurrency tối đa mỗi bot sau throttle: bot bị throttle ở nhóm/bot
 * nào thì lấy cap nhỏ nhất trong các đánh giá throttle; bot không bị
 * throttle thì giữ `defaultMax` (null = không giới hạn bởi quota).
 */
export function throttledConcurrencyFromFleetV6Evaluations(
  evaluations: FleetV6QuotaEvaluation[],
  defaultMax: number | null,
): Record<string, number | null> {
  const caps: Record<string, number | null> = {};
  const seen = new Set<string>();
  for (const evaluation of evaluations) {
    for (const botId of evaluation.botIds) {
      seen.add(botId);
      if (evaluation.action === 'throttle' && evaluation.throttleMaxConcurrent !== null) {
        const current = caps[botId];
        caps[botId] = current === undefined || current === null
          ? evaluation.throttleMaxConcurrent
          : Math.min(current, evaluation.throttleMaxConcurrent);
      }
    }
  }
  for (const botId of seen) {
    if (caps[botId] === undefined) caps[botId] = defaultMax;
  }
  return caps;
}

/**
 * Bot bị pause có được resume không: chỉ resume khi MỌI đánh giá liên
 * quan tới bot đó đều không còn breach (mức dùng đã tụt xuống dưới
 * trần). Trả danh sách bot được phép resume.
 */
export function resolveFleetV6PausedBots(
  evaluations: FleetV6QuotaEvaluation[],
  pausedBotIds: string[],
): string[] {
  const breachBots = new Set<string>();
  for (const evaluation of evaluations) {
    if (evaluation.overall !== 'breach') continue;
    for (const botId of evaluation.botIds) breachBots.add(botId);
  }
  return pausedBotIds.filter((botId) => !breachBots.has(botId));
}

// --- File bền ---------------------------------------------------------------

export function getFleetV6QuotaGroupsPath(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('fleet v6 quota groups need a non-empty rootDir.');
  }
  return path.join(rootDir, FLEET_V6_QUOTA_GROUPS_FILE);
}

/** Load mọi nhóm quota v6 (file thiếu = chưa có nhóm nào). */
export function loadFleetV6QuotaGroups(rootDir: string): FleetV6QuotaGroup[] {
  const filePath = getFleetV6QuotaGroupsPath(rootDir);
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
    throw new Error(`${FLEET_V6_QUOTA_GROUPS_FILE} is corrupt: not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${FLEET_V6_QUOTA_GROUPS_FILE} is corrupt: expected an array.`);
  return parsed.map((entry, i) => {
    try {
      return validateFleetV6QuotaGroup(entry);
    } catch (err) {
      throw new Error(`${FLEET_V6_QUOTA_GROUPS_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
}

/** Lưu mọi nhóm quota v6 (atomic tmp + rename, mode 0600). */
export function saveFleetV6QuotaGroups(rootDir: string, groups: FleetV6QuotaGroup[]): void {
  const valid = groups.map((g) => validateFleetV6QuotaGroup(g));
  const filePath = getFleetV6QuotaGroupsPath(rootDir);
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

/** Tạo mới hoặc cập nhật một nhóm quota (trùng tên thì cập nhật nhóm cũ). */
export function setFleetV6QuotaGroup(
  rootDir: string,
  input: SetFleetV6QuotaGroupInput,
  updatedBy: string,
): FleetV6QuotaGroup {
  if (!isNonEmptyString(updatedBy)) throw new Error('setFleetV6QuotaGroup needs a non-empty updatedBy.');
  if (!isNonEmptyString(input.name)) throw new Error('setFleetV6QuotaGroup needs a non-empty name.');
  const groups = loadFleetV6QuotaGroups(rootDir);
  const byId = input.id ? groups.find((g) => g.id === input.id) : undefined;
  const byName = groups.find((g) => g.name === input.name.trim() && g.id !== input.id);
  if (byName) {
    throw new Error(`quota group name "${input.name.trim()}" is already used by another group.`);
  }
  const nowIso = new Date().toISOString();
  const group: FleetV6QuotaGroup = validateFleetV6QuotaGroup({
    id: byId?.id ?? input.id ?? `qg6-${crypto.randomUUID()}`,
    name: input.name.trim(),
    botIds: input.botIds,
    cpuCoresMax: input.cpuCoresMax,
    ramBytesMax: input.ramBytesMax,
    diskBytesMax: input.diskBytesMax,
    warnPercent: input.warnPercent ?? QUOTA_DEFAULT_WARN_PERCENT,
    enabled: input.enabled ?? true,
    throttleMaxConcurrent: input.throttleMaxConcurrent ?? FLEET_V6_DEFAULT_THROTTLE_MAX_CONCURRENT,
    updatedAt: nowIso,
    updatedBy: updatedBy.trim(),
  });
  const next = groups.some((g) => g.id === group.id)
    ? groups.map((g) => (g.id === group.id ? group : g))
    : [...groups, group];
  saveFleetV6QuotaGroups(rootDir, next);
  return group;
}

/** Xoá một nhóm quota theo id. Trả true khi đã xoá. */
export function removeFleetV6QuotaGroup(rootDir: string, groupId: string): boolean {
  const groups = loadFleetV6QuotaGroups(rootDir);
  const next = groups.filter((g) => g.id !== groupId);
  if (next.length === groups.length) return false;
  saveFleetV6QuotaGroups(rootDir, next);
  return true;
}

/** Một nhóm quota theo id, hoặc undefined khi không có. */
export function getFleetV6QuotaGroup(rootDir: string, groupId: string): FleetV6QuotaGroup | undefined {
  return loadFleetV6QuotaGroups(rootDir).find((g) => g.id === groupId);
}

/** Nhóm quota chứa một bot (một bot có thể thuộc nhiều nhóm). */
export function groupsForFleetV6Bot(rootDir: string, botId: string): FleetV6QuotaGroup[] {
  return loadFleetV6QuotaGroups(rootDir).filter((g) => g.botIds.includes(botId));
}
