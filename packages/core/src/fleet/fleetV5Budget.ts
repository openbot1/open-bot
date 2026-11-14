/**
 * Per-bot resource budget v2 (v1.08, Đội T6).
 *
 * Chặt hơn quota v1 (`fleet/quotas.ts` — chỉ một giới hạn + warn 80%):
 * mỗi bot có HAI mức cho từng tài nguyên (CPU cores / RAM / đĩa):
 *
 * - soft (giới hạn mềm): vượt thì cảnh báo + throttle (bot vẫn chạy,
 *   nhưng dashboard báo over-soft và lần claim task tiếp theo bị chặn
 *   khi bot đang over-soft — xem `shouldBlockNewTasks`);
 * - hard (giới hạn cứng): vượt thì bot phải TỰ DỪNG — evaluation trả
 *   `action: 'stop'` + `shouldStop: true`; host dựa vào đó dừng bot,
 *   module này không kill process (không giả vờ enforce khi không có
 *   cgroup thật, giống tư thế của quotas v1/compute quota).
 * - pre-soft warning: cảnh báo TRƯỚC khi chạm soft — mặc định ở 80%
 *   của soft (`preSoftWarnPercent`, 0 < x < 1) — để bot/user kịp giảm
 *   tải trước khi vượt mềm.
 *
 * Lịch sử tiêu thụ theo bot: mỗi lần `recordFleetV5BudgetUsage` ghi
 * một sample vào `<fleetRoot>/fleet-budget-history-v108.json` (tối đa
 * 500 sample/bot, cũ nhất bị cắt). `summarizeFleetV5BudgetHistory`
 * trả peak/avg/trend (rising/falling/stable theo nửa đầu vs nửa sau)
 * và số lần vượt soft/hard — để dashboard và user thấy bot nào đang
 * leo dần tới giới hạn.
 *
 * Ngân sách lưu ở `<fleetRoot>/fleet-budgets-v108.json` (atomic tmp +
 * rename, mode 0600 — cùng tư thế với quotas).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const FLEET_V5_BUDGETS_FILE = 'fleet-budgets-v108.json';
export const FLEET_V5_BUDGET_HISTORY_FILE = 'fleet-budget-history-v108.json';
/** Cảnh báo trước khi chạm soft: mặc định ở 80% của soft. */
export const FLEET_V5_DEFAULT_PRE_SOFT_WARN_PERCENT = 0.8;
/** Giữ tối đa 500 sample lịch sử mỗi bot. */
export const FLEET_V5_MAX_HISTORY_SAMPLES_PER_BOT = 500;
/** Trend: nửa sau lệch nửa đầu quá 10% thì rising/falling. */
export const FLEET_V5_TREND_THRESHOLD = 0.1;

export type FleetV5BudgetResource = 'cpuCores' | 'ramBytes' | 'diskBytes';
export const FLEET_V5_BUDGET_RESOURCES: FleetV5BudgetResource[] = ['cpuCores', 'ramBytes', 'diskBytes'];

/** Giới hạn cho cả 3 tài nguyên (mọi số đều > 0). */
export interface FleetV5ResourceLimits {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
}

export interface FleetV5BotBudget {
  botId: string;
  soft: FleetV5ResourceLimits;
  hard: FleetV5ResourceLimits;
  /** Cảnh báo khi dùng tới x * soft (0 < x < 1). */
  preSoftWarnPercent: number;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface FleetV5UsageSample {
  botId: string;
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  /** Epoch ms. */
  at: number;
}

export type FleetV5BudgetLevel = 'ok' | 'approaching-soft' | 'over-soft' | 'over-hard';
export type FleetV5BudgetAction = 'none' | 'warn' | 'throttle' | 'stop';

export interface FleetV5ResourceEvaluation {
  resource: FleetV5BudgetResource;
  used: number;
  soft: number;
  hard: number;
  /** used / soft. */
  softRatio: number;
  /** used / hard. */
  hardRatio: number;
  level: FleetV5BudgetLevel;
  warnings: string[];
}

export interface FleetV5BudgetEvaluation {
  botId: string;
  at: number;
  /** Budget đã tắt (enabled=false) thì không đánh giá — levels toàn ok, action none. */
  budgetEnabled: boolean;
  resources: Record<FleetV5BudgetResource, FleetV5ResourceEvaluation>;
  /** Mức nghiêm trọng nhất trong 3 tài nguyên. */
  overallLevel: FleetV5BudgetLevel;
  /** Hành động host nên làm: none / warn / throttle (over-soft) / stop (over-hard). */
  action: FleetV5BudgetAction;
  /** Bot có nên dừng ngay không (true khi bất kỳ tài nguyên nào over-hard). */
  shouldStop: boolean;
  /** Bot có nên bị chặn nhận task mới không (true khi over-soft trở lên). */
  shouldBlockNewTasks: boolean;
  reasons: string[];
}

export type FleetV5Trend = 'rising' | 'falling' | 'stable' | 'unknown';

export interface FleetV5BudgetHistorySummary {
  botId: string;
  samples: number;
  firstAt: number | null;
  lastAt: number | null;
  peak: FleetV5ResourceLimits;
  average: FleetV5ResourceLimits;
  trend: Record<FleetV5BudgetResource, FleetV5Trend>;
  overSoftCount: number;
  overHardCount: number;
}

export function getFleetV5BudgetsPath(fleetRoot: string): string {
  if (typeof fleetRoot !== 'string' || fleetRoot.trim().length === 0) {
    throw new Error('fleet v5 budgets need a non-empty fleetRoot.');
  }
  return path.join(fleetRoot, FLEET_V5_BUDGETS_FILE);
}

export function getFleetV5BudgetHistoryPath(fleetRoot: string): string {
  if (typeof fleetRoot !== 'string' || fleetRoot.trim().length === 0) {
    throw new Error('fleet v5 budget history need a non-empty fleetRoot.');
  }
  return path.join(fleetRoot, FLEET_V5_BUDGET_HISTORY_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateLimits(raw: unknown, where: string): FleetV5ResourceLimits {
  if (!isRecord(raw)) throw new Error(`${where} phải là object { cpuCores, ramBytes, diskBytes }.`);
  if (!isPositiveFinite(raw['cpuCores'])) throw new Error(`${where}.cpuCores phải là số > 0.`);
  if (!isPositiveFinite(raw['ramBytes'])) throw new Error(`${where}.ramBytes phải là số > 0.`);
  if (!isPositiveFinite(raw['diskBytes'])) throw new Error(`${where}.diskBytes phải là số > 0.`);
  return {
    cpuCores: raw['cpuCores'] as number,
    ramBytes: raw['ramBytes'] as number,
    diskBytes: raw['diskBytes'] as number,
  };
}

/** Validate một budget v2 (throw với message rõ ràng khi sai). */
export function validateFleetV5BotBudget(raw: unknown): FleetV5BotBudget {
  if (!isRecord(raw)) throw new Error('fleet v5 bot budget must be an object.');
  if (typeof raw['botId'] !== 'string' || raw['botId'].trim().length === 0) {
    throw new Error('fleet v5 bot budget needs a non-empty botId.');
  }
  const soft = validateLimits(raw['soft'], 'fleet v5 bot budget soft');
  const hard = validateLimits(raw['hard'], 'fleet v5 bot budget hard');
  for (const resource of FLEET_V5_BUDGET_RESOURCES) {
    if (hard[resource] < soft[resource]) {
      throw new Error(
        `fleet v5 bot budget hard.${resource} (${hard[resource]}) không được nhỏ hơn soft.${resource} (${soft[resource]}).`,
      );
    }
  }
  if (
    typeof raw['preSoftWarnPercent'] !== 'number' ||
    !Number.isFinite(raw['preSoftWarnPercent']) ||
    raw['preSoftWarnPercent'] <= 0 ||
    raw['preSoftWarnPercent'] >= 1
  ) {
    throw new Error('fleet v5 bot budget preSoftWarnPercent phải là số trong (0, 1).');
  }
  if (typeof raw['enabled'] !== 'boolean') throw new Error('fleet v5 bot budget enabled phải là boolean.');
  if (typeof raw['updatedAt'] !== 'string' || raw['updatedAt'].trim().length === 0) {
    throw new Error('fleet v5 bot budget needs a non-empty updatedAt.');
  }
  if (typeof raw['updatedBy'] !== 'string' || raw['updatedBy'].trim().length === 0) {
    throw new Error('fleet v5 bot budget needs a non-empty updatedBy.');
  }
  return {
    botId: (raw['botId'] as string).trim(),
    soft,
    hard,
    preSoftWarnPercent: raw['preSoftWarnPercent'] as number,
    enabled: raw['enabled'] as boolean,
    updatedAt: raw['updatedAt'] as string,
    updatedBy: raw['updatedBy'] as string,
  };
}

export function validateFleetV5UsageSample(raw: unknown): FleetV5UsageSample {
  if (!isRecord(raw)) throw new Error('fleet v5 usage sample must be an object.');
  if (typeof raw['botId'] !== 'string' || raw['botId'].trim().length === 0) {
    throw new Error('fleet v5 usage sample needs a non-empty botId.');
  }
  if (!isNonNegativeFinite(raw['cpuCores'])) throw new Error('fleet v5 usage sample cpuCores phải là số >= 0.');
  if (!isNonNegativeFinite(raw['ramBytes'])) throw new Error('fleet v5 usage sample ramBytes phải là số >= 0.');
  if (!isNonNegativeFinite(raw['diskBytes'])) throw new Error('fleet v5 usage sample diskBytes phải là số >= 0.');
  if (typeof raw['at'] !== 'number' || !Number.isFinite(raw['at']) || raw['at'] < 0) {
    throw new Error('fleet v5 usage sample at phải là epoch ms >= 0.');
  }
  return {
    botId: (raw['botId'] as string).trim(),
    cpuCores: raw['cpuCores'] as number,
    ramBytes: raw['ramBytes'] as number,
    diskBytes: raw['diskBytes'] as number,
    at: raw['at'] as number,
  };
}

/** Load mọi budget v2 (file chưa có = chưa đặt budget nào). */
export function loadFleetV5Budgets(fleetRoot: string): FleetV5BotBudget[] {
  const filePath = getFleetV5BudgetsPath(fleetRoot);
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
    throw new Error(`${FLEET_V5_BUDGETS_FILE} is corrupt: not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${FLEET_V5_BUDGETS_FILE} is corrupt: expected an array.`);
  return parsed.map((entry, i) => {
    try {
      return validateFleetV5BotBudget(entry);
    } catch (err) {
      throw new Error(`${FLEET_V5_BUDGETS_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
}

/** Lưu mọi budget v2 (atomic tmp + rename, mode 0600). */
export function saveFleetV5Budgets(fleetRoot: string, budgets: FleetV5BotBudget[]): void {
  const valid = budgets.map((b) => validateFleetV5BotBudget(b));
  const filePath = getFleetV5BudgetsPath(fleetRoot);
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

export interface SetFleetV5BotBudgetInput {
  botId: string;
  soft: FleetV5ResourceLimits;
  hard: FleetV5ResourceLimits;
  preSoftWarnPercent?: number;
  enabled?: boolean;
}

/** Tạo hoặc thay thế budget của một bot. Trả về budget đã lưu. */
export function setFleetV5BotBudget(
  fleetRoot: string,
  input: SetFleetV5BotBudgetInput,
  updatedBy: string,
): FleetV5BotBudget {
  if (typeof updatedBy !== 'string' || updatedBy.trim().length === 0) {
    throw new Error('setFleetV5BotBudget needs a non-empty updatedBy.');
  }
  const budget = validateFleetV5BotBudget({
    botId: input.botId,
    soft: input.soft,
    hard: input.hard,
    preSoftWarnPercent: input.preSoftWarnPercent ?? FLEET_V5_DEFAULT_PRE_SOFT_WARN_PERCENT,
    enabled: input.enabled ?? true,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy.trim(),
  });
  const budgets = loadFleetV5Budgets(fleetRoot);
  const next = budgets.some((b) => b.botId === budget.botId)
    ? budgets.map((b) => (b.botId === budget.botId ? budget : b))
    : [...budgets, budget];
  saveFleetV5Budgets(fleetRoot, next);
  return budget;
}

/** Budget của một bot, hoặc undefined khi chưa đặt. */
export function getFleetV5BotBudget(fleetRoot: string, botId: string): FleetV5BotBudget | undefined {
  return loadFleetV5Budgets(fleetRoot).find((b) => b.botId === botId);
}

/** Xoá budget của một bot. Trả true khi đã xoá được. */
export function removeFleetV5BotBudget(fleetRoot: string, botId: string): boolean {
  const budgets = loadFleetV5Budgets(fleetRoot);
  const next = budgets.filter((b) => b.botId !== botId);
  if (next.length === budgets.length) return false;
  saveFleetV5Budgets(fleetRoot, next);
  return true;
}

const RESOURCE_LABELS: Record<FleetV5BudgetResource, string> = {
  cpuCores: 'CPU',
  ramBytes: 'RAM',
  diskBytes: 'đĩa',
};

function evaluateResource(
  resource: FleetV5BudgetResource,
  used: number,
  soft: number,
  hard: number,
  preSoftWarnPercent: number,
  botId: string,
): FleetV5ResourceEvaluation {
  const softRatio = soft > 0 ? used / soft : 0;
  const hardRatio = hard > 0 ? used / hard : 0;
  const label = RESOURCE_LABELS[resource];
  let level: FleetV5BudgetLevel = 'ok';
  const warnings: string[] = [];
  if (hardRatio >= 1) {
    level = 'over-hard';
    warnings.push(`Bot "${botId}" vượt GIỚI HẠN CỨNG ${label}: dùng ${used} / cứng ${hard} (${Math.round(hardRatio * 100)}%) — bot phải tự dừng.`);
  } else if (softRatio >= 1) {
    level = 'over-soft';
    warnings.push(`Bot "${botId}" vượt giới hạn mềm ${label}: dùng ${used} / mềm ${soft} (${Math.round(softRatio * 100)}%) — throttle + chặn nhận task mới.`);
  } else if (softRatio >= preSoftWarnPercent) {
    level = 'approaching-soft';
    warnings.push(
      `Bot "${botId}" sắp chạm giới hạn mềm ${label}: dùng ${used} / mềm ${soft} (${Math.round(softRatio * 100)}%, ngưỡng cảnh báo sớm ${Math.round(preSoftWarnPercent * 100)}%) — giảm tải trước khi vượt mềm.`,
    );
  }
  return { resource, used, soft, hard, softRatio, hardRatio, level, warnings };
}

const LEVEL_ORDER: FleetV5BudgetLevel[] = ['ok', 'approaching-soft', 'over-soft', 'over-hard'];

/**
 * Đánh giá một sample sử dụng với budget của bot (thuần — dễ test).
 * Budget tắt hoặc không có thì trả evaluation rỗng (không chặn gì).
 */
export function evaluateFleetV5BotBudget(
  budget: FleetV5BotBudget | undefined,
  sample: FleetV5UsageSample,
): FleetV5BudgetEvaluation {
  const at = sample.at;
  if (budget === undefined || !budget.enabled) {
    const resources = {} as Record<FleetV5BudgetResource, FleetV5ResourceEvaluation>;
    for (const resource of FLEET_V5_BUDGET_RESOURCES) {
      resources[resource] = {
        resource,
        used: sample[resource],
        soft: 0,
        hard: 0,
        softRatio: 0,
        hardRatio: 0,
        level: 'ok',
        warnings: [],
      };
    }
    return {
      botId: sample.botId,
      at,
      budgetEnabled: false,
      resources,
      overallLevel: 'ok',
      action: 'none',
      shouldStop: false,
      shouldBlockNewTasks: false,
      reasons: budget === undefined ? [`Bot "${sample.botId}" chưa đặt budget v2 — không giới hạn.`] : [`Budget v2 của bot "${sample.botId}" đang tắt — không giới hạn.`],
    };
  }
  const resources = {} as Record<FleetV5BudgetResource, FleetV5ResourceEvaluation>;
  for (const resource of FLEET_V5_BUDGET_RESOURCES) {
    resources[resource] = evaluateResource(resource, sample[resource], budget.soft[resource], budget.hard[resource], budget.preSoftWarnPercent, budget.botId);
  }
  let overallLevel: FleetV5BudgetLevel = 'ok';
  for (const resource of FLEET_V5_BUDGET_RESOURCES) {
    if (LEVEL_ORDER.indexOf(resources[resource].level) > LEVEL_ORDER.indexOf(overallLevel)) {
      overallLevel = resources[resource].level;
    }
  }
  const reasons = FLEET_V5_BUDGET_RESOURCES.flatMap((r) => resources[r].warnings);
  const action: FleetV5BudgetAction =
    overallLevel === 'over-hard' ? 'stop' : overallLevel === 'over-soft' ? 'throttle' : overallLevel === 'approaching-soft' ? 'warn' : 'none';
  return {
    botId: budget.botId,
    at,
    budgetEnabled: true,
    resources,
    overallLevel,
    action,
    shouldStop: overallLevel === 'over-hard',
    shouldBlockNewTasks: overallLevel === 'over-soft' || overallLevel === 'over-hard',
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Lịch sử tiêu thụ theo bot
// ---------------------------------------------------------------------------

type BudgetHistoryFile = Record<string, FleetV5UsageSample[]>;

function readHistoryFile(fleetRoot: string): BudgetHistoryFile {
  const filePath = getFleetV5BudgetHistoryPath(fleetRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${FLEET_V5_BUDGET_HISTORY_FILE} is corrupt: not valid JSON.`);
  }
  if (!isRecord(parsed)) throw new Error(`${FLEET_V5_BUDGET_HISTORY_FILE} is corrupt: expected an object.`);
  const out: BudgetHistoryFile = {};
  for (const [botId, samples] of Object.entries(parsed)) {
    if (!Array.isArray(samples)) throw new Error(`${FLEET_V5_BUDGET_HISTORY_FILE} is corrupt: samples for "${botId}" must be an array.`);
    out[botId] = samples.map((s, i) => {
      try {
        return validateFleetV5UsageSample(s);
      } catch (err) {
        throw new Error(`${FLEET_V5_BUDGET_HISTORY_FILE} is corrupt for "${botId}" at index ${i}: ${(err as Error).message}`);
      }
    });
  }
  return out;
}

function writeHistoryFile(fleetRoot: string, history: BudgetHistoryFile): void {
  const filePath = getFleetV5BudgetHistoryPath(fleetRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX modes.
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Ghi một sample tiêu thụ vào lịch sử của bot (cắt cũ nhất khi quá
 * 500 sample). Trả về evaluation của sample đó với budget hiện tại.
 */
export function recordFleetV5BudgetUsage(
  fleetRoot: string,
  sampleInput: FleetV5UsageSample,
): FleetV5BudgetEvaluation {
  const sample = validateFleetV5UsageSample(sampleInput);
  const history = readHistoryFile(fleetRoot);
  const samples = [...(history[sample.botId] ?? []), sample].sort((a, b) => a.at - b.at);
  history[sample.botId] =
    samples.length > FLEET_V5_MAX_HISTORY_SAMPLES_PER_BOT
      ? samples.slice(samples.length - FLEET_V5_MAX_HISTORY_SAMPLES_PER_BOT)
      : samples;
  writeHistoryFile(fleetRoot, history);
  const budget = getFleetV5BotBudget(fleetRoot, sample.botId);
  return evaluateFleetV5BotBudget(budget, sample);
}

/** Toàn bộ sample lịch sử của một bot (theo thời gian tăng dần). */
export function loadFleetV5BudgetHistory(fleetRoot: string, botId: string): FleetV5UsageSample[] {
  const history = readHistoryFile(fleetRoot);
  return [...(history[botId] ?? [])].sort((a, b) => a.at - b.at);
}

/** Xoá lịch sử của một bot. Trả true khi đã xoá được. */
export function clearFleetV5BudgetHistory(fleetRoot: string, botId: string): boolean {
  const history = readHistoryFile(fleetRoot);
  if (!(botId in history)) return false;
  delete history[botId];
  writeHistoryFile(fleetRoot, history);
  return true;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function trendOf(values: number[]): FleetV5Trend {
  if (values.length < 4) return 'unknown';
  const half = Math.floor(values.length / 2);
  const first = avg(values.slice(0, half));
  const second = avg(values.slice(half));
  if (first === 0) return second > 0 ? 'rising' : 'stable';
  const change = (second - first) / first;
  if (change > FLEET_V5_TREND_THRESHOLD) return 'rising';
  if (change < -FLEET_V5_TREND_THRESHOLD) return 'falling';
  return 'stable';
}

/**
 * Tóm tắt lịch sử tiêu thụ của một bot (thuần trên mảng sample — dễ
 * test): peak/avg/trend từng tài nguyên + số lần vượt soft/hard (cần
 * budget để biết ngưỡng; không có budget thì 0).
 */
export function summarizeFleetV5BudgetHistory(
  botId: string,
  samples: FleetV5UsageSample[],
  budget?: FleetV5BotBudget,
): FleetV5BudgetHistorySummary {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const peak: FleetV5ResourceLimits = { cpuCores: 0, ramBytes: 0, diskBytes: 0 };
  const average: FleetV5ResourceLimits = { cpuCores: 0, ramBytes: 0, diskBytes: 0 };
  const trend = {} as Record<FleetV5BudgetResource, FleetV5Trend>;
  for (const resource of FLEET_V5_BUDGET_RESOURCES) {
    const values = sorted.map((s) => s[resource]);
    peak[resource] = values.length > 0 ? Math.max(...values) : 0;
    average[resource] = avg(values);
    trend[resource] = trendOf(values);
  }
  let overSoftCount = 0;
  let overHardCount = 0;
  if (budget !== undefined && budget.enabled) {
    for (const sample of sorted) {
      let overSoft = false;
      let overHard = false;
      for (const resource of FLEET_V5_BUDGET_RESOURCES) {
        if (sample[resource] >= budget.hard[resource]) overHard = true;
        if (sample[resource] >= budget.soft[resource]) overSoft = true;
      }
      if (overHard) overHardCount += 1;
      else if (overSoft) overSoftCount += 1;
    }
  }
  return {
    botId,
    samples: sorted.length,
    firstAt: sorted.length > 0 ? sorted[0].at : null,
    lastAt: sorted.length > 0 ? sorted[sorted.length - 1].at : null,
    peak,
    average,
    trend,
    overSoftCount,
    overHardCount,
  };
}

/** Tóm tắt lịch sử từ file (bot chưa có sample thì summary rỗng). */
export function summarizeFleetV5BudgetHistoryFromFile(
  fleetRoot: string,
  botId: string,
): FleetV5BudgetHistorySummary {
  const samples = loadFleetV5BudgetHistory(fleetRoot, botId);
  const budget = getFleetV5BotBudget(fleetRoot, botId);
  return summarizeFleetV5BudgetHistory(botId, samples, budget);
}

/** Đánh giá tất cả bot có budget với sample mới nhất của chúng. */
export function checkAllFleetV5Budgets(
  fleetRoot: string,
  latestSamples: FleetV5UsageSample[],
): FleetV5BudgetEvaluation[] {
  const budgets = loadFleetV5Budgets(fleetRoot);
  const byBot = new Map(latestSamples.map((s) => [s.botId, s]));
  const evaluations: FleetV5BudgetEvaluation[] = [];
  for (const budget of budgets) {
    const sample = byBot.get(budget.botId);
    if (sample !== undefined) evaluations.push(evaluateFleetV5BotBudget(budget, sample));
  }
  return evaluations;
}
