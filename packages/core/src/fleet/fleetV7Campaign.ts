/**
 * Fleet campaign v2 — chạy một chiến dịch trên nhiều bot, nhiều máy
 * (v1.10, Đội T6).
 *
 * Khác campaign v5 (task trên nhiều repo, một máy): campaign v2 chạy
 * CÙNG một mục tiêu trên nhiều bot đặt trên nhiều máy của fleet
 * (node), theo chiến lược rollout từng nấc:
 *
 *   canary → staged → full
 *
 * - canary: một nhóm nhỏ bot chạy trước (mặc định 1 bot, tối thiểu
 *   10% số bot). Chỉ khi nhóm này đạt cổng chất lượng (tỉ lệ thành
 *   công >= minSuccessRate, số fail <= maxFailures) mới được mở nấc
 *   tiếp theo.
 * - staged: mở rộng dần theo các mốc phần trăm (mặc định 25% → 50%
 *   → 75% tổng số bot). Mỗi mốc là một stage riêng, cũng chịu cổng
 *   chất lượng như canary.
 * - full: toàn bộ bot còn lại cùng chạy.
 * - Node offline chặn advance của stage chứa bot trên node đó (fail
 *   closed); node draining chỉ cảnh báo, không chặn.
 * - Tiến độ từng bot: `reportFleetV7BotProgress` cập nhật
 *   progressPercent + trạng thái (pending/running/done/failed);
 *   bot fail quá maxAttempts thì bị đánh failed và không được tính
 *   vào cổng thành công nữa — cổng tính trên bot đã kết thúc
 *   (done + failed).
 * - Rollback: `rollbackFleetV7Campaign` chụp snapshot toàn bộ
 *   assignment trước khi lùi, đưa bot đang running/pending ở stage
 *   hiện tại và các stage sau về 'rolled-back', giữ nguyên bot đã
 *   done (việc đã xong không lùi được). Campaign chuyển sang
 *   'rolled-back' và không advance được nữa; báo cáo tổng hợp vẫn
 *   đọc được snapshot để biết đã lùi cái gì.
 * - Báo cáo tổng hợp: tổng theo trạng thái bot, theo từng stage,
 *   theo từng node, tỉ lệ thành công, tiến độ %, thời gian chạy.
 *
 * Lưu ở `<fleetRoot>/fleet-campaigns-v110.json` (ghi atomic tmp +
 * rename, mode 0600 — cùng tư thế với campaign v5 và quotas).
 * Chỉ local: không biết gì về mạng ngoài fleet, không gọi API nào.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Các nấc rollout, theo thứ tự mở rộng. */
export const FLEET_V7_ROLLOUT_STAGES = ['canary', 'staged', 'full'] as const;
export type FleetV7RolloutStage = (typeof FLEET_V7_ROLLOUT_STAGES)[number];

/** Trạng thái của một stage trong campaign. */
export const FLEET_V7_STAGE_STATUSES = ['pending', 'active', 'done', 'failed', 'rolled-back'] as const;
export type FleetV7StageStatus = (typeof FLEET_V7_STAGE_STATUSES)[number];

/** Trạng thái của một bot trong campaign. */
export const FLEET_V7_BOT_STATUSES = [
  'pending',
  'running',
  'done',
  'failed',
  'rolled-back',
  'skipped',
] as const;
export type FleetV7BotStatus = (typeof FLEET_V7_BOT_STATUSES)[number];

/** Trạng thái của một node (máy) trong fleet. */
export const FLEET_V7_NODE_STATUSES = ['online', 'offline', 'draining'] as const;
export type FleetV7NodeStatus = (typeof FLEET_V7_NODE_STATUSES)[number];

/** Trạng thái của campaign. */
export const FLEET_V7_CAMPAIGN_STATUSES = [
  'draft',
  'active',
  'paused',
  'done',
  'rolled-back',
  'cancelled',
] as const;
export type FleetV7CampaignStatus = (typeof FLEET_V7_CAMPAIGN_STATUSES)[number];

/** Chiến lược rollout của campaign. */
export const FLEET_V7_STRATEGIES = ['canary-staged-full', 'staged-only', 'full-only'] as const;
export type FleetV7Strategy = (typeof FLEET_V7_STRATEGIES)[number];

export const FLEET_V7_CAMPAIGNS_FILE = 'fleet-campaigns-v110.json';
/** Số bot canary mặc định (ít nhất 1, ít nhất 10% tổng số bot). */
export const FLEET_V7_DEFAULT_CANARY_COUNT = 1;
/** Các mốc staged mặc định: phần trăm tổng số bot đã mở sau mỗi mốc. */
export const FLEET_V7_DEFAULT_STAGED_PERCENTS = [25, 50, 75];
/** Cổng thành công mặc định: 80% bot đã kết thúc phải done. */
export const FLEET_V7_DEFAULT_MIN_SUCCESS_RATE = 0.8;
/** Số bot fail tối đa trong một stage trước khi cổng đóng (mặc định 1). */
export const FLEET_V7_DEFAULT_MAX_FAILURES = 1;
/** Số lần fail tối đa của một bot trước khi bị đánh failed hẳn. */
export const FLEET_V7_DEFAULT_MAX_ATTEMPTS = 3;

export interface FleetV7Node {
  id: string;
  label: string;
  /** Số bot tối đa node này nhận cùng lúc (mặc định: không giới hạn). */
  maxBots: number | null;
  status: FleetV7NodeStatus;
}

export interface FleetV7BotAssignmentHistoryEntry {
  at: number;
  status: FleetV7BotStatus;
  progressPercent?: number;
  note?: string;
}

export interface FleetV7BotAssignment {
  botId: string;
  nodeId: string;
  status: FleetV7BotStatus;
  /** Tiến độ 0..100 (chỉ có ý nghĩa khi running/done). */
  progressPercent: number;
  attempts: number;
  lastError?: string;
  startedAt: number | null;
  finishedAt: number | null;
  history: FleetV7BotAssignmentHistoryEntry[];
}

/** Một stage rollout: nhóm bot bắt đầu chạy ở nấc này + cổng chất lượng. */
export interface FleetV7StagePlan {
  stage: FleetV7RolloutStage;
  /** Bot bắt đầu chạy ở stage này (không tính bot của stage trước). */
  botIds: string[];
  minSuccessRate: number;
  maxFailures: number;
  status: FleetV7StageStatus;
  startedAt: number | null;
  finishedAt: number | null;
  /** Lý do cổng đóng / stage fail (khi status 'failed'). */
  gateNote?: string;
}

/** Snapshot assignment lúc rollback — để báo cáo/audit đọc lại. */
export interface FleetV7RollbackSnapshot {
  at: number;
  reason: string;
  stageIndex: number;
  assignments: { botId: string; status: FleetV7BotStatus; progressPercent: number }[];
}

export interface FleetV7CampaignHistoryEntry {
  at: number;
  event: string;
  note?: string;
}

export interface FleetV7Campaign {
  id: string;
  goal: string;
  strategy: FleetV7Strategy;
  status: FleetV7CampaignStatus;
  nodes: FleetV7Node[];
  assignments: FleetV7BotAssignment[];
  stages: FleetV7StagePlan[];
  /** Chỉ số stage đang active (-1 khi chưa start / đã kết thúc). */
  currentStageIndex: number;
  rollbackSnapshots: FleetV7RollbackSnapshot[];
  createdAt: number;
  updatedAt: number;
  history: FleetV7CampaignHistoryEntry[];
}

export interface CreateFleetV7BotInput {
  botId: string;
  nodeId: string;
}

export interface CreateFleetV7NodeInput {
  id: string;
  label?: string;
  maxBots?: number | null;
  status?: FleetV7NodeStatus;
}

export interface CreateFleetV7CampaignInput {
  goal: string;
  bots: CreateFleetV7BotInput[];
  nodes?: CreateFleetV7NodeInput[];
  strategy?: FleetV7Strategy;
  id?: string;
  /** Số bot canary (mặc định 1; luôn ít nhất 1 và ít nhất 10%). */
  canaryCount?: number;
  /** Các mốc staged — phần trăm tổng số bot (mặc định [25, 50, 75]). */
  stagedPercents?: number[];
  minSuccessRate?: number;
  maxFailures?: number;
  maxAttempts?: number;
}

export interface FleetV7StageReport {
  stage: FleetV7RolloutStage;
  status: FleetV7StageStatus;
  botIds: string[];
  done: number;
  failed: number;
  running: number;
  pending: number;
  rolledBack: number;
  successRate: number | null;
  gateNote?: string;
}

export interface FleetV7NodeReport {
  nodeId: string;
  label: string;
  status: FleetV7NodeStatus;
  total: number;
  done: number;
  failed: number;
  running: number;
  pending: number;
  rolledBack: number;
}

export interface FleetV7CampaignReport {
  id: string;
  goal: string;
  strategy: FleetV7Strategy;
  status: FleetV7CampaignStatus;
  totalBots: number;
  done: number;
  failed: number;
  running: number;
  pending: number;
  rolledBack: number;
  skipped: number;
  /** Phần trăm bot đã done (0..100). */
  progressPercent: number;
  /** Tỉ lệ thành công trên bot đã kết thúc (null khi chưa bot nào kết thúc). */
  successRate: number | null;
  currentStage: FleetV7RolloutStage | null;
  stages: FleetV7StageReport[];
  nodes: FleetV7NodeReport[];
  rollbacks: number;
  elapsedMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export function getFleetV7CampaignsPath(fleetRoot: string): string {
  if (typeof fleetRoot !== 'string' || fleetRoot.trim().length === 0) {
    throw new Error('fleet v7 campaigns need a non-empty fleetRoot.');
  }
  return path.join(fleetRoot, FLEET_V7_CAMPAIGNS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Chia bot thành các stage theo chiến lược. Bot giữ nguyên thứ tự
 * caller đưa vào (bot đầu = canary). Trả về danh sách stage plan
 * (chưa active). Stage rỗng (không còn bot mới) thì bỏ qua — vd
 * campaign 2 bot: canary 1 bot, staged 25% (= 1 bot, làm tròn lên),
 * full 0 bot còn lại → full bị bỏ, campaign chỉ còn 2 stage.
 */
export function planFleetV7Stages(
  botIds: string[],
  strategy: FleetV7Strategy,
  options: {
    canaryCount?: number;
    stagedPercents?: number[];
    minSuccessRate?: number;
    maxFailures?: number;
  } = {},
): FleetV7StagePlan[] {
  if (botIds.length === 0) throw new Error('fleet v7 campaign cần ít nhất 1 bot.');
  const minSuccessRate = options.minSuccessRate ?? FLEET_V7_DEFAULT_MIN_SUCCESS_RATE;
  if (typeof minSuccessRate !== 'number' || minSuccessRate < 0 || minSuccessRate > 1) {
    throw new Error('fleet v7 minSuccessRate phải là số trong [0, 1].');
  }
  const maxFailures = options.maxFailures ?? FLEET_V7_DEFAULT_MAX_FAILURES;
  if (!Number.isInteger(maxFailures) || maxFailures < 0) {
    throw new Error('fleet v7 maxFailures phải là số nguyên >= 0.');
  }
  const total = botIds.length;
  const mkStage = (stage: FleetV7RolloutStage, ids: string[]): FleetV7StagePlan => ({
    stage,
    botIds: [...ids],
    minSuccessRate,
    maxFailures,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
  });
  if (strategy === 'full-only') {
    return [mkStage('full', botIds)];
  }
  const stages: FleetV7StagePlan[] = [];
  let cursor = 0;
  if (strategy === 'canary-staged-full') {
    // Canary: ít nhất 1 bot và ít nhất 10% tổng số bot.
    const wanted = options.canaryCount ?? FLEET_V7_DEFAULT_CANARY_COUNT;
    if (!Number.isInteger(wanted) || wanted < 1) {
      throw new Error('fleet v7 canaryCount phải là số nguyên >= 1.');
    }
    const canarySize = Math.min(total, Math.max(1, wanted, Math.ceil(total * 0.1)));
    stages.push(mkStage('canary', botIds.slice(0, canarySize)));
    cursor = canarySize;
  }
  // Staged: mỗi mốc mở thêm bot cho tới mốc phần trăm đó (làm tròn
  // lên, mỗi mốc ít nhất 1 bot mới nếu còn bot).
  const percents = [...(options.stagedPercents ?? FLEET_V7_DEFAULT_STAGED_PERCENTS)]
    .filter((p) => typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 100)
    .sort((a, b) => a - b);
  for (const percent of percents) {
    if (cursor >= total) break;
    const target = Math.min(total - 1, Math.ceil((total * percent) / 100));
    if (target <= cursor) continue;
    stages.push(mkStage('staged', botIds.slice(cursor, target)));
    cursor = target;
  }
  if (cursor < total) {
    stages.push(mkStage('full', botIds.slice(cursor)));
  }
  if (stages.length === 0) {
    // Không thể xảy ra với botIds non-empty, nhưng fail-closed.
    throw new Error('fleet v7 không chia được stage nào cho campaign.');
  }
  return stages;
}

function validateNode(raw: unknown, where: string): FleetV7Node {
  if (!isRecord(raw)) throw new Error(`${where} phải là object.`);
  if (!isNonEmptyString(raw['id'])) throw new Error(`${where} cần id không rỗng.`);
  if (typeof raw['label'] !== 'string') throw new Error(`${where} cần label là chuỗi.`);
  if (
    typeof raw['status'] !== 'string' ||
    !(FLEET_V7_NODE_STATUSES as readonly string[]).includes(raw['status'])
  ) {
    throw new Error(`${where} status phải là một trong: ${FLEET_V7_NODE_STATUSES.join(', ')}.`);
  }
  const maxBots = raw['maxBots'];
  if (maxBots !== null && (typeof maxBots !== 'number' || !Number.isInteger(maxBots) || maxBots < 1)) {
    throw new Error(`${where} maxBots phải là null hoặc số nguyên >= 1.`);
  }
  return {
    id: (raw['id'] as string).trim(),
    label: raw['label'] as string,
    maxBots: maxBots as number | null,
    status: raw['status'] as FleetV7NodeStatus,
  };
}

function validateAssignment(raw: unknown, where: string): FleetV7BotAssignment {
  if (!isRecord(raw)) throw new Error(`${where} phải là object.`);
  if (!isNonEmptyString(raw['botId'])) throw new Error(`${where} cần botId không rỗng.`);
  if (!isNonEmptyString(raw['nodeId'])) throw new Error(`${where} cần nodeId không rỗng.`);
  if (
    typeof raw['status'] !== 'string' ||
    !(FLEET_V7_BOT_STATUSES as readonly string[]).includes(raw['status'])
  ) {
    throw new Error(`${where} status phải là một trong: ${FLEET_V7_BOT_STATUSES.join(', ')}.`);
  }
  if (
    typeof raw['progressPercent'] !== 'number' ||
    raw['progressPercent'] < 0 ||
    raw['progressPercent'] > 100
  ) {
    throw new Error(`${where} progressPercent phải là số trong [0, 100].`);
  }
  if (typeof raw['attempts'] !== 'number' || !Number.isInteger(raw['attempts']) || raw['attempts'] < 0) {
    throw new Error(`${where} attempts phải là số nguyên >= 0.`);
  }
  if (raw['startedAt'] !== null && typeof raw['startedAt'] !== 'number') {
    throw new Error(`${where} startedAt phải là số hoặc null.`);
  }
  if (raw['finishedAt'] !== null && typeof raw['finishedAt'] !== 'number') {
    throw new Error(`${where} finishedAt phải là số hoặc null.`);
  }
  if (!Array.isArray(raw['history'])) throw new Error(`${where} history phải là mảng.`);
  return {
    botId: (raw['botId'] as string).trim(),
    nodeId: (raw['nodeId'] as string).trim(),
    status: raw['status'] as FleetV7BotStatus,
    progressPercent: raw['progressPercent'] as number,
    attempts: raw['attempts'] as number,
    ...(typeof raw['lastError'] === 'string' && (raw['lastError'] as string).length > 0
      ? { lastError: raw['lastError'] as string }
      : {}),
    startedAt: raw['startedAt'] as number | null,
    finishedAt: raw['finishedAt'] as number | null,
    history: (raw['history'] as FleetV7BotAssignmentHistoryEntry[]).map((h) => ({
      at: h.at,
      status: h.status,
      ...(typeof h.progressPercent === 'number' ? { progressPercent: h.progressPercent } : {}),
      ...(typeof h.note === 'string' ? { note: h.note } : {}),
    })),
  };
}

function validateStage(raw: unknown, where: string): FleetV7StagePlan {
  if (!isRecord(raw)) throw new Error(`${where} phải là object.`);
  if (
    typeof raw['stage'] !== 'string' ||
    !(FLEET_V7_ROLLOUT_STAGES as readonly string[]).includes(raw['stage'])
  ) {
    throw new Error(`${where} stage phải là một trong: ${FLEET_V7_ROLLOUT_STAGES.join(', ')}.`);
  }
  if (!Array.isArray(raw['botIds']) || raw['botIds'].some((b) => typeof b !== 'string')) {
    throw new Error(`${where} botIds phải là mảng chuỗi.`);
  }
  if (typeof raw['minSuccessRate'] !== 'number' || raw['minSuccessRate'] < 0 || raw['minSuccessRate'] > 1) {
    throw new Error(`${where} minSuccessRate phải là số trong [0, 1].`);
  }
  if (typeof raw['maxFailures'] !== 'number' || !Number.isInteger(raw['maxFailures']) || raw['maxFailures'] < 0) {
    throw new Error(`${where} maxFailures phải là số nguyên >= 0.`);
  }
  if (
    typeof raw['status'] !== 'string' ||
    !(FLEET_V7_STAGE_STATUSES as readonly string[]).includes(raw['status'])
  ) {
    throw new Error(`${where} status phải là một trong: ${FLEET_V7_STAGE_STATUSES.join(', ')}.`);
  }
  if (raw['startedAt'] !== null && typeof raw['startedAt'] !== 'number') {
    throw new Error(`${where} startedAt phải là số hoặc null.`);
  }
  if (raw['finishedAt'] !== null && typeof raw['finishedAt'] !== 'number') {
    throw new Error(`${where} finishedAt phải là số hoặc null.`);
  }
  return {
    stage: raw['stage'] as FleetV7RolloutStage,
    botIds: [...(raw['botIds'] as string[])],
    minSuccessRate: raw['minSuccessRate'] as number,
    maxFailures: raw['maxFailures'] as number,
    status: raw['status'] as FleetV7StageStatus,
    startedAt: raw['startedAt'] as number | null,
    finishedAt: raw['finishedAt'] as number | null,
    ...(typeof raw['gateNote'] === 'string' && (raw['gateNote'] as string).length > 0
      ? { gateNote: raw['gateNote'] as string }
      : {}),
  };
}

export function validateFleetV7Campaign(raw: unknown): FleetV7Campaign {
  if (!isRecord(raw)) throw new Error('fleet v7 campaign must be an object.');
  if (!isNonEmptyString(raw['id'])) throw new Error('fleet v7 campaign needs a non-empty id.');
  if (!isNonEmptyString(raw['goal'])) throw new Error('fleet v7 campaign needs a non-empty goal.');
  if (
    typeof raw['strategy'] !== 'string' ||
    !(FLEET_V7_STRATEGIES as readonly string[]).includes(raw['strategy'])
  ) {
    throw new Error(`fleet v7 strategy phải là một trong: ${FLEET_V7_STRATEGIES.join(', ')}.`);
  }
  if (
    typeof raw['status'] !== 'string' ||
    !(FLEET_V7_CAMPAIGN_STATUSES as readonly string[]).includes(raw['status'])
  ) {
    throw new Error(`fleet v7 status phải là một trong: ${FLEET_V7_CAMPAIGN_STATUSES.join(', ')}.`);
  }
  if (!Array.isArray(raw['nodes'])) throw new Error('fleet v7 nodes phải là mảng.');
  if (!Array.isArray(raw['assignments'])) throw new Error('fleet v7 assignments phải là mảng.');
  if (!Array.isArray(raw['stages']) || (raw['stages'] as unknown[]).length === 0) {
    throw new Error('fleet v7 stages phải là mảng không rỗng.');
  }
  if (
    typeof raw['currentStageIndex'] !== 'number' ||
    !Number.isInteger(raw['currentStageIndex']) ||
    (raw['currentStageIndex'] as number) < -1 ||
    (raw['currentStageIndex'] as number) >= (raw['stages'] as unknown[]).length
  ) {
    throw new Error('fleet v7 currentStageIndex không hợp lệ.');
  }
  if (!Array.isArray(raw['rollbackSnapshots'])) throw new Error('fleet v7 rollbackSnapshots phải là mảng.');
  if (typeof raw['createdAt'] !== 'number' || typeof raw['updatedAt'] !== 'number') {
    throw new Error('fleet v7 campaign needs numeric createdAt/updatedAt.');
  }
  if (!Array.isArray(raw['history'])) throw new Error('fleet v7 history phải là mảng.');
  const nodes = (raw['nodes'] as unknown[]).map((n, i) => {
    try {
      return validateNode(n, `fleet v7 node[${i}]`);
    } catch (err) {
      throw new Error((err as Error).message);
    }
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  if (nodeIds.size !== nodes.length) throw new Error('fleet v7 campaign có node id trùng nhau.');
  const assignments = (raw['assignments'] as unknown[]).map((a, i) => {
    try {
      return validateAssignment(a, `fleet v7 assignment[${i}]`);
    } catch (err) {
      throw new Error((err as Error).message);
    }
  });
  const botIds = new Set(assignments.map((a) => a.botId));
  if (botIds.size !== assignments.length) throw new Error('fleet v7 campaign có botId trùng nhau.');
  for (const a of assignments) {
    if (!nodeIds.has(a.nodeId)) {
      throw new Error(`fleet v7 bot "${a.botId}" đặt trên node không tồn tại: "${a.nodeId}".`);
    }
  }
  const stages = (raw['stages'] as unknown[]).map((s, i) => {
    try {
      return validateStage(s, `fleet v7 stage[${i}]`);
    } catch (err) {
      throw new Error((err as Error).message);
    }
  });
  const stagedBots = stages.flatMap((s) => s.botIds);
  if (new Set(stagedBots).size !== stagedBots.length) {
    throw new Error('fleet v7 campaign có bot nằm ở nhiều stage.');
  }
  for (const botId of stagedBots) {
    if (!botIds.has(botId)) throw new Error(`fleet v7 stage chứa bot không tồn tại: "${botId}".`);
  }
  if (stagedBots.length !== assignments.length) {
    throw new Error('fleet v7 campaign: mọi bot phải nằm trong đúng một stage.');
  }
  return {
    id: (raw['id'] as string).trim(),
    goal: (raw['goal'] as string).trim(),
    strategy: raw['strategy'] as FleetV7Strategy,
    status: raw['status'] as FleetV7CampaignStatus,
    nodes,
    assignments,
    stages,
    currentStageIndex: raw['currentStageIndex'] as number,
    rollbackSnapshots: (raw['rollbackSnapshots'] as FleetV7RollbackSnapshot[]).map((s) => ({
      at: s.at,
      reason: s.reason,
      stageIndex: s.stageIndex,
      assignments: s.assignments.map((a) => ({ ...a })),
    })),
    createdAt: raw['createdAt'] as number,
    updatedAt: raw['updatedAt'] as number,
    history: (raw['history'] as FleetV7CampaignHistoryEntry[]).map((h) => ({
      at: h.at,
      event: h.event,
      ...(typeof h.note === 'string' ? { note: h.note } : {}),
    })),
  };
}

/** Tạo campaign mới ở trạng thái draft (chưa lưu — caller gọi saveFleetV7Campaigns). */
export function createFleetV7Campaign(
  input: CreateFleetV7CampaignInput,
  now = Date.now(),
): FleetV7Campaign {
  if (!isNonEmptyString(input.goal)) throw new Error('fleet v7 campaign cần goal không rỗng.');
  if (!Array.isArray(input.bots) || input.bots.length === 0) {
    throw new Error('fleet v7 campaign cần ít nhất 1 bot.');
  }
  const seenBots = new Set<string>();
  for (const bot of input.bots) {
    if (!isRecord(bot) || !isNonEmptyString(bot.botId) || !isNonEmptyString(bot.nodeId)) {
      throw new Error('fleet v7 bot cần { botId, nodeId } không rỗng.');
    }
    const id = (bot.botId as string).trim();
    if (seenBots.has(id)) throw new Error(`fleet v7 campaign có botId trùng nhau: "${id}".`);
    seenBots.add(id);
  }
  const strategy: FleetV7Strategy = input.strategy ?? 'canary-staged-full';
  if (!(FLEET_V7_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new Error(`fleet v7 strategy phải là một trong: ${FLEET_V7_STRATEGIES.join(', ')}.`);
  }
  if (
    input.maxAttempts !== undefined &&
    (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)
  ) {
    throw new Error('fleet v7 maxAttempts phải là số nguyên >= 1.');
  }
  // Node: node khai báo tường minh + node chỉ xuất hiện qua bot
  // (label mặc định = id, status online).
  const nodesById = new Map<string, FleetV7Node>();
  for (const nodeInput of input.nodes ?? []) {
    if (!isRecord(nodeInput) || !isNonEmptyString(nodeInput.id)) {
      throw new Error('fleet v7 node cần id không rỗng.');
    }
    const id = (nodeInput.id as string).trim();
    if (nodesById.has(id)) throw new Error(`fleet v7 campaign có node id trùng nhau: "${id}".`);
    const status = nodeInput.status ?? 'online';
    if (!(FLEET_V7_NODE_STATUSES as readonly string[]).includes(status as string)) {
      throw new Error(`fleet v7 node status phải là một trong: ${FLEET_V7_NODE_STATUSES.join(', ')}.`);
    }
    const maxBots = nodeInput.maxBots ?? null;
    if (maxBots !== null && (!Number.isInteger(maxBots) || maxBots < 1)) {
      throw new Error('fleet v7 node maxBots phải là null hoặc số nguyên >= 1.');
    }
    nodesById.set(id, {
      id,
      label: typeof nodeInput.label === 'string' && nodeInput.label.length > 0 ? nodeInput.label : id,
      maxBots,
      status: status as FleetV7NodeStatus,
    });
  }
  for (const bot of input.bots) {
    const nodeId = (bot.nodeId as string).trim();
    if (!nodesById.has(nodeId)) {
      nodesById.set(nodeId, { id: nodeId, label: nodeId, maxBots: null, status: 'online' });
    }
  }
  const nodes = [...nodesById.values()];
  // Fail-closed: node không được nhận nhiều bot hơn maxBots.
  for (const node of nodes) {
    if (node.maxBots === null) continue;
    const count = input.bots.filter((b) => (b.nodeId as string).trim() === node.id).length;
    if (count > node.maxBots) {
      throw new Error(
        `fleet v7 node "${node.id}" chỉ nhận tối đa ${node.maxBots} bot nhưng campaign gán ${count} bot.`,
      );
    }
  }
  const botIds = input.bots.map((b) => (b.botId as string).trim());
  const stages = planFleetV7Stages(botIds, strategy, {
    canaryCount: input.canaryCount,
    stagedPercents: input.stagedPercents,
    minSuccessRate: input.minSuccessRate,
    maxFailures: input.maxFailures,
  });
  // maxAttempts đã validate ở trên; mỗi lần báo fail, tool/core
  // truyền lại maxAttempts cho reportFleetV7BotProgress — campaign
  // không lưu riêng giá trị này.
  const campaign: FleetV7Campaign = {
    id: typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : newId('cmp7'),
    goal: input.goal.trim(),
    strategy,
    status: 'draft',
    nodes,
    assignments: input.bots.map((b) => ({
      botId: (b.botId as string).trim(),
      nodeId: (b.nodeId as string).trim(),
      status: 'pending' as FleetV7BotStatus,
      progressPercent: 0,
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      history: [{ at: now, status: 'pending' as FleetV7BotStatus }],
    })),
    stages,
    currentStageIndex: -1,
    rollbackSnapshots: [],
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, event: 'created', note: `Strategy ${strategy}, ${botIds.length} bot trên ${nodes.length} node.` }],
  };
  return campaign;
}

/** Load tất cả campaign v7 (file chưa có = chưa có campaign nào). */
export function loadFleetV7Campaigns(fleetRoot: string): FleetV7Campaign[] {
  const filePath = getFleetV7CampaignsPath(fleetRoot);
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
    throw new Error(`${FLEET_V7_CAMPAIGNS_FILE} is corrupt: not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${FLEET_V7_CAMPAIGNS_FILE} is corrupt: expected an array.`);
  return parsed.map((entry, i) => {
    try {
      return validateFleetV7Campaign(entry);
    } catch (err) {
      throw new Error(`${FLEET_V7_CAMPAIGNS_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
}

/** Lưu tất cả campaign v7 (atomic tmp + rename, mode 0600). */
export function saveFleetV7Campaigns(fleetRoot: string, campaigns: FleetV7Campaign[]): void {
  const valid = campaigns.map((c) => validateFleetV7Campaign(c));
  const filePath = getFleetV7CampaignsPath(fleetRoot);
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

export function findFleetV7Campaign(
  campaigns: FleetV7Campaign[],
  id: string,
): FleetV7Campaign | undefined {
  return campaigns.find((c) => c.id === id);
}

export function findFleetV7Assignment(
  campaign: FleetV7Campaign,
  botId: string,
): FleetV7BotAssignment | undefined {
  return campaign.assignments.find((a) => a.botId === botId);
}

function pushHistory(campaign: FleetV7Campaign, now: number, event: string, note?: string): void {
  campaign.history.push({ at: now, event, ...(note !== undefined ? { note } : {}) });
  campaign.updatedAt = now;
}

function stageAssignments(campaign: FleetV7Campaign, stage: FleetV7StagePlan): FleetV7BotAssignment[] {
  return stage.botIds
    .map((botId) => findFleetV7Assignment(campaign, botId))
    .filter((a): a is FleetV7BotAssignment => a !== undefined);
}

/** Tỉ lệ thành công của một stage: done / (done + failed), null khi chưa bot nào kết thúc. */
export function fleetV7StageSuccessRate(
  campaign: FleetV7Campaign,
  stage: FleetV7StagePlan,
): number | null {
  const done = stageAssignments(campaign, stage).filter((a) => a.status === 'done').length;
  const failed = stageAssignments(campaign, stage).filter((a) => a.status === 'failed').length;
  if (done + failed === 0) return null;
  return done / (done + failed);
}

export interface FleetV7GateCheck {
  /** Cổng mở khi mọi điều kiện đều đạt. */
  pass: boolean;
  /** Bot fail trong stage hiện tại. */
  failures: number;
  /** Tỉ lệ thành công hiện tại (null khi chưa bot nào kết thúc). */
  successRate: number | null;
  /** Bot trong stage hiện tại chưa kết thúc (running/pending). */
  unfinished: number;
  /** Node offline chặn advance (bot của stage kế nằm trên node đó). */
  offlineNodes: string[];
  /** Node draining chứa bot của stage kế (cảnh báo, không chặn). */
  drainingNodes: string[];
  /** Lý do cổng đóng (null khi cổng mở). */
  reason: string | null;
}

/**
 * Kiểm tra cổng advance từ stage hiện tại sang stage kế: stage hiện
 * tại phải kết thúc hết bot (không còn running/pending), đạt tỉ lệ
 * thành công tối thiểu, không vượt số fail tối đa, và không có bot
 * của stage kế nằm trên node offline.
 */
export function checkFleetV7AdvanceGate(
  campaign: FleetV7Campaign,
  now = Date.now(),
): FleetV7GateCheck {
  void now;
  const empty: FleetV7GateCheck = {
    pass: false,
    failures: 0,
    successRate: null,
    unfinished: 0,
    offlineNodes: [],
    drainingNodes: [],
    reason: 'Campaign chưa start — không có stage hiện tại.',
  };
  if (campaign.status !== 'active') {
    return { ...empty, reason: `Campaign đang ${campaign.status} — chỉ advance được campaign active.` };
  }
  const current = campaign.stages[campaign.currentStageIndex];
  if (!current) return { ...empty, reason: 'Campaign không có stage hiện tại.' };
  const next = campaign.stages[campaign.currentStageIndex + 1];
  if (!next) {
    return {
      ...empty,
      reason: `Stage "${current.stage}" đã là stage cuối — không còn stage kế để advance.`,
    };
  }
  const currentAssignments = stageAssignments(campaign, current);
  const unfinished = currentAssignments.filter(
    (a) => a.status === 'pending' || a.status === 'running',
  ).length;
  const failures = currentAssignments.filter((a) => a.status === 'failed').length;
  const successRate = fleetV7StageSuccessRate(campaign, current);
  const nodeById = new Map(campaign.nodes.map((n) => [n.id, n]));
  const offlineNodes: string[] = [];
  const drainingNodes: string[] = [];
  for (const botId of next.botIds) {
    const assignment = findFleetV7Assignment(campaign, botId);
    if (!assignment) continue;
    const node = nodeById.get(assignment.nodeId);
    if (node?.status === 'offline' && !offlineNodes.includes(node.id)) offlineNodes.push(node.id);
    if (node?.status === 'draining' && !drainingNodes.includes(node.id)) drainingNodes.push(node.id);
  }
  if (unfinished > 0) {
    return {
      pass: false,
      failures,
      successRate,
      unfinished,
      offlineNodes,
      drainingNodes,
      reason: `Stage "${current.stage}" còn ${unfinished} bot chưa kết thúc — chờ bot xong mới advance được.`,
    };
  }
  if (failures > current.maxFailures) {
    return {
      pass: false,
      failures,
      successRate,
      unfinished,
      offlineNodes,
      drainingNodes,
      reason: `Stage "${current.stage}" có ${failures} bot fail (tối đa ${current.maxFailures}) — cổng đóng.`,
    };
  }
  if (successRate !== null && successRate < current.minSuccessRate) {
    return {
      pass: false,
      failures,
      successRate,
      unfinished,
      offlineNodes,
      drainingNodes,
      reason:
        `Stage "${current.stage}" đạt tỉ lệ thành công ${Math.round(successRate * 100)}% ` +
        `(cần >= ${Math.round(current.minSuccessRate * 100)}%) — cổng đóng.`,
    };
  }
  if (offlineNodes.length > 0) {
    return {
      pass: false,
      failures,
      successRate,
      unfinished,
      offlineNodes,
      drainingNodes,
      reason: `Stage kế có bot trên node offline: ${offlineNodes.join(', ')} — chờ node online mới advance được.`,
    };
  }
  return {
    pass: true,
    failures,
    successRate,
    unfinished,
    offlineNodes,
    drainingNodes,
    reason: null,
  };
}

export interface AdvanceFleetV7RolloutResult {
  advanced: boolean;
  reason: string | null;
  /** Stage vừa kích hoạt (undefined khi không advance được). */
  stage?: FleetV7RolloutStage;
  /** Cảnh báo node draining (không chặn). */
  warnings: string[];
}

/** Bắt đầu campaign draft: kích hoạt stage đầu tiên (bot của stage đó vẫn pending cho tới khi host dispatch). */
export function startFleetV7Campaign(
  campaign: FleetV7Campaign,
  now = Date.now(),
): FleetV7Campaign {
  if (campaign.status !== 'draft') {
    throw new Error(`Campaign "${campaign.id}" đang ${campaign.status} — chỉ start được campaign draft.`);
  }
  campaign.status = 'active';
  campaign.currentStageIndex = 0;
  const first = campaign.stages[0];
  first.status = 'active';
  first.startedAt = now;
  pushHistory(campaign, now, 'started', `Stage đầu tiên: ${first.stage} (${first.botIds.length} bot).`);
  return campaign;
}

/**
 * Advance sang stage kế. Cổng đóng thì KHÔNG advance, trả về
 * { advanced: false, reason } để caller báo lại cho host (không
 * throw — cổng đóng là kết quả vận hành bình thường, không phải lỗi
 * lập trình). Campaign sai trạng thái / hết stage thì throw.
 */
export function advanceFleetV7Rollout(
  campaign: FleetV7Campaign,
  now = Date.now(),
): AdvanceFleetV7RolloutResult {
  if (campaign.status !== 'active') {
    throw new Error(`Campaign "${campaign.id}" đang ${campaign.status} — chỉ advance được campaign active.`);
  }
  const current = campaign.stages[campaign.currentStageIndex];
  if (!current) throw new Error(`Campaign "${campaign.id}" không có stage hiện tại.`);
  const next = campaign.stages[campaign.currentStageIndex + 1];
  if (!next) throw new Error(`Campaign "${campaign.id}" đã ở stage cuối — không còn stage kế.`);
  const gate = checkFleetV7AdvanceGate(campaign, now);
  if (!gate.pass) {
    return { advanced: false, reason: gate.reason, warnings: [] };
  }
  current.status = 'done';
  current.finishedAt = now;
  next.status = 'active';
  next.startedAt = now;
  campaign.currentStageIndex += 1;
  const warnings = gate.drainingNodes.map(
    (nodeId) => `Node "${nodeId}" đang draining — bot trên node này vẫn chạy nhưng node sẽ không nhận thêm bot mới.`,
  );
  pushHistory(
    campaign,
    now,
    'advanced',
    `Advance sang stage ${next.stage} (${next.botIds.length} bot).` +
      (warnings.length > 0 ? ` Cảnh báo: ${warnings.join(' ')}` : ''),
  );
  return { advanced: true, reason: null, stage: next.stage, warnings };
}

/** Tạm dừng campaign active (bot đang chạy giữ nguyên trạng thái — host quyết định có dừng bot thật không). */
export function pauseFleetV7Campaign(campaign: FleetV7Campaign, now = Date.now()): FleetV7Campaign {
  if (campaign.status !== 'active') {
    throw new Error(`Campaign "${campaign.id}" đang ${campaign.status} — chỉ pause được campaign active.`);
  }
  campaign.status = 'paused';
  pushHistory(campaign, now, 'paused');
  return campaign;
}

/** Tiếp tục campaign đã pause. */
export function resumeFleetV7Campaign(campaign: FleetV7Campaign, now = Date.now()): FleetV7Campaign {
  if (campaign.status !== 'paused') {
    throw new Error(`Campaign "${campaign.id}" đang ${campaign.status} — chỉ resume được campaign paused.`);
  }
  campaign.status = 'active';
  pushHistory(campaign, now, 'resumed');
  return campaign;
}

/** Huỷ campaign (draft/active/paused đều huỷ được); bot pending/running chuyển sang 'skipped'. */
export function cancelFleetV7Campaign(
  campaign: FleetV7Campaign,
  now = Date.now(),
  note?: string,
): FleetV7Campaign {
  if (campaign.status === 'done' || campaign.status === 'rolled-back' || campaign.status === 'cancelled') {
    throw new Error(`Campaign "${campaign.id}" đã ${campaign.status} — không huỷ được.`);
  }
  for (const assignment of campaign.assignments) {
    if (assignment.status === 'pending' || assignment.status === 'running') {
      assignment.status = 'skipped';
      assignment.finishedAt = now;
      assignment.history.push({ at: now, status: 'skipped', note: 'Campaign cancelled.' });
    }
  }
  for (const stage of campaign.stages) {
    if (stage.status === 'pending' || stage.status === 'active') {
      stage.status = 'rolled-back';
      stage.finishedAt = now;
    }
  }
  campaign.status = 'cancelled';
  campaign.currentStageIndex = -1;
  pushHistory(campaign, now, 'cancelled', note);
  return campaign;
}

export interface ReportFleetV7ProgressInput {
  progressPercent: number;
  /** 'running' | 'done' | 'failed' — mặc định giữ trạng thái hiện tại (pending → running khi báo tiến độ lần đầu). */
  status?: 'running' | 'done' | 'failed';
  note?: string;
  error?: string;
  maxAttempts?: number;
}

/**
 * Báo tiến độ một bot. Lần báo đầu tiên chuyển pending → running và
 * ghi startedAt. Báo done thì progress về 100 + ghi finishedAt.
 * Báo failed: attempts +1; còn lượt thì về pending (requeue cho stage
 * hiện tại), hết lượt thì failed hẳn. Bot đã done/failed/
 * rolled-back/skipped thì không báo được nữa (throw).
 */
export function reportFleetV7BotProgress(
  campaign: FleetV7Campaign,
  botId: string,
  input: ReportFleetV7ProgressInput,
  now = Date.now(),
): FleetV7BotAssignment {
  const assignment = findFleetV7Assignment(campaign, botId);
  if (!assignment) throw new Error(`Không có bot "${botId}" trong campaign "${campaign.id}".`);
  if (campaign.status !== 'active' && campaign.status !== 'paused') {
    throw new Error(`Campaign "${campaign.id}" đang ${campaign.status} — không báo tiến độ được.`);
  }
  if (
    assignment.status === 'done' ||
    assignment.status === 'failed' ||
    assignment.status === 'rolled-back' ||
    assignment.status === 'skipped'
  ) {
    throw new Error(`Bot "${botId}" đã ${assignment.status} — không báo tiến độ được.`);
  }
  const progress = clampPercent(input.progressPercent);
  const maxAttempts = input.maxAttempts ?? FLEET_V7_DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('fleet v7 maxAttempts phải là số nguyên >= 1.');
  }
  if (input.status === 'failed') {
    assignment.attempts += 1;
    if (input.error !== undefined) assignment.lastError = input.error;
    if (assignment.attempts >= maxAttempts) {
      assignment.status = 'failed';
      assignment.progressPercent = progress;
      assignment.finishedAt = now;
      assignment.history.push({
        at: now,
        status: 'failed',
        progressPercent: progress,
        note: input.note ?? `Failed sau ${assignment.attempts} lần thử.`,
      });
    } else {
      assignment.status = 'pending';
      assignment.progressPercent = 0;
      assignment.history.push({
        at: now,
        status: 'pending',
        note: input.note ?? `Fail lần ${assignment.attempts}/${maxAttempts} — requeue.`,
      });
    }
    campaign.updatedAt = now;
    maybeFinishCampaign(campaign, now);
    return assignment;
  }
  if (assignment.status === 'pending') {
    assignment.status = 'running';
    assignment.startedAt = now;
  }
  if (input.status === 'done') {
    assignment.status = 'done';
    assignment.progressPercent = 100;
    assignment.finishedAt = now;
  } else {
    assignment.status = 'running';
    assignment.progressPercent = progress;
  }
  assignment.history.push({
    at: now,
    status: assignment.status,
    progressPercent: assignment.progressPercent,
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
  campaign.updatedAt = now;
  maybeFinishCampaign(campaign, now);
  return assignment;
}

/**
 * Khi mọi bot đã kết thúc (done/failed/rolled-back/skipped) thì
 * campaign active tự chuyển sang 'done' (stage cuối cũng đóng).
 * Rollback/cancel không đi qua đây.
 */
function maybeFinishCampaign(campaign: FleetV7Campaign, now: number): void {
  if (campaign.status !== 'active') return;
  const unfinished = campaign.assignments.some(
    (a) => a.status === 'pending' || a.status === 'running',
  );
  if (unfinished) return;
  const current = campaign.stages[campaign.currentStageIndex];
  if (current && (current.status === 'active' || current.status === 'pending')) {
    current.status = 'done';
    current.finishedAt = now;
  }
  campaign.status = 'done';
  campaign.currentStageIndex = -1;
  pushHistory(campaign, now, 'finished', 'Mọi bot đã kết thúc.');
}

export interface RollbackFleetV7Result {
  rolledBackBots: string[];
  keptDoneBots: string[];
  snapshot: FleetV7RollbackSnapshot;
}

/**
 * Rollback campaign: chụp snapshot toàn bộ assignment, đưa bot đang
 * running/pending ở stage hiện tại và các stage sau về 'rolled-back',
 * đóng các stage đó, campaign → 'rolled-back'. Bot đã done giữ
 * nguyên (việc đã xong không lùi được); bot đã failed giữ nguyên
 * failed. Chỉ rollback được campaign active/paused.
 */
export function rollbackFleetV7Campaign(
  campaign: FleetV7Campaign,
  reason: string,
  now = Date.now(),
): RollbackFleetV7Result {
  if (!isNonEmptyString(reason)) throw new Error('fleet v7 rollback cần reason không rỗng.');
  if (campaign.status !== 'active' && campaign.status !== 'paused') {
    throw new Error(`Campaign "${campaign.id}" đang ${campaign.status} — chỉ rollback được campaign active/paused.`);
  }
  const snapshot: FleetV7RollbackSnapshot = {
    at: now,
    reason: reason.trim(),
    stageIndex: campaign.currentStageIndex,
    assignments: campaign.assignments.map((a) => ({
      botId: a.botId,
      status: a.status,
      progressPercent: a.progressPercent,
    })),
  };
  const rolledBackBots: string[] = [];
  const keptDoneBots: string[] = [];
  for (const assignment of campaign.assignments) {
    if (assignment.status === 'done') {
      keptDoneBots.push(assignment.botId);
      continue;
    }
    if (assignment.status === 'running' || assignment.status === 'pending') {
      assignment.status = 'rolled-back';
      assignment.finishedAt = now;
      assignment.history.push({ at: now, status: 'rolled-back', note: `Rollback: ${reason.trim()}.` });
      rolledBackBots.push(assignment.botId);
    }
  }
  for (let i = 0; i < campaign.stages.length; i += 1) {
    const stage = campaign.stages[i];
    if (i >= campaign.currentStageIndex && (stage.status === 'active' || stage.status === 'pending')) {
      stage.status = 'rolled-back';
      stage.finishedAt = now;
    }
  }
  campaign.rollbackSnapshots.push(snapshot);
  campaign.status = 'rolled-back';
  campaign.currentStageIndex = -1;
  pushHistory(
    campaign,
    now,
    'rolled-back',
    `Rollback: ${reason.trim()} — ${rolledBackBots.length} bot lùi, ${keptDoneBots.length} bot đã done giữ nguyên.`,
  );
  return { rolledBackBots, keptDoneBots, snapshot };
}

export interface FleetV7RolloutPlanStep {
  stageIndex: number;
  stage: FleetV7RolloutStage;
  botIds: string[];
  nodeIds: string[];
  status: FleetV7StageStatus;
  /** Cảnh báo của bước này (node offline/draining, node quá tải). */
  warnings: string[];
}

export interface FleetV7RolloutPlan {
  campaignId: string;
  goal: string;
  strategy: FleetV7Strategy;
  status: FleetV7CampaignStatus;
  totalBots: number;
  steps: FleetV7RolloutPlanStep[];
  /** Cảnh báo toàn campaign (vd node offline ở stage chưa chạy). */
  warnings: string[];
}

/**
 * Kế hoạch rollout chỉ-đọc (dry-run): liệt kê từng stage theo thứ
 * tự chạy, bot + node của stage đó, kèm cảnh báo (node offline /
 * draining / node nhận nhiều bot hơn maxBots). Không đổi gì trên
 * campaign — host xem trước rồi mới start/advance.
 */
export function planFleetV7Rollout(campaign: FleetV7Campaign): FleetV7RolloutPlan {
  const nodeById = new Map(campaign.nodes.map((n) => [n.id, n]));
  const warnings: string[] = [];
  const steps: FleetV7RolloutPlanStep[] = campaign.stages.map((stage, stageIndex) => {
    const stepWarnings: string[] = [];
    const nodeIds = [...new Set(
      stage.botIds
        .map((botId) => findFleetV7Assignment(campaign, botId)?.nodeId)
        .filter((nodeId): nodeId is string => typeof nodeId === 'string'),
    )];
    for (const nodeId of nodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      if (node.status === 'offline') {
        stepWarnings.push(`Node "${nodeId}" đang offline — stage ${stage.stage} sẽ bị chặn ở cổng advance.`);
      } else if (node.status === 'draining') {
        stepWarnings.push(`Node "${nodeId}" đang draining — bot vẫn chạy nhưng node không nhận thêm bot mới.`);
      }
      if (node.maxBots !== null) {
        const onNode = stage.botIds.filter(
          (botId) => findFleetV7Assignment(campaign, botId)?.nodeId === nodeId,
        ).length;
        if (onNode > node.maxBots) {
          stepWarnings.push(
            `Node "${nodeId}" nhận ${onNode} bot ở stage ${stage.stage} nhưng maxBots là ${node.maxBots}.`,
          );
        }
      }
    }
    warnings.push(...stepWarnings);
    return {
      stageIndex,
      stage: stage.stage,
      botIds: [...stage.botIds],
      nodeIds,
      status: stage.status,
      warnings: stepWarnings,
    };
  });
  return {
    campaignId: campaign.id,
    goal: campaign.goal,
    strategy: campaign.strategy,
    status: campaign.status,
    totalBots: campaign.assignments.length,
    steps,
    warnings,
  };
}

/**
 * Nhân bản một campaign thành campaign mới ở trạng thái draft: cùng
 * goal (hoặc goal mới nếu caller đưa), cùng bot/node/stage/cổng,
 * nhưng mọi trạng thái chạy reset về đầu (bot pending, stage
 * pending, không snapshot rollback, history mới). Hữu ích để chạy
 * lại cùng một đợt rollout sau khi campaign cũ xong/lùi.
 */
export function cloneFleetV7Campaign(
  campaign: FleetV7Campaign,
  now = Date.now(),
  goalOverride?: string,
): FleetV7Campaign {
  if (goalOverride !== undefined && !isNonEmptyString(goalOverride)) {
    throw new Error('fleet v7 clone cần goal mới không rỗng (hoặc bỏ trống để giữ goal cũ).');
  }
  const cloned: FleetV7Campaign = {
    id: newId('cmp7'),
    goal: goalOverride !== undefined ? goalOverride.trim() : campaign.goal,
    strategy: campaign.strategy,
    status: 'draft',
    nodes: campaign.nodes.map((n) => ({ ...n })),
    assignments: campaign.assignments.map((a) => ({
      botId: a.botId,
      nodeId: a.nodeId,
      status: 'pending' as FleetV7BotStatus,
      progressPercent: 0,
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      history: [{ at: now, status: 'pending' as FleetV7BotStatus }],
    })),
    stages: campaign.stages.map((s) => ({
      stage: s.stage,
      botIds: [...s.botIds],
      minSuccessRate: s.minSuccessRate,
      maxFailures: s.maxFailures,
      status: 'pending' as FleetV7StageStatus,
      startedAt: null,
      finishedAt: null,
    })),
    currentStageIndex: -1,
    rollbackSnapshots: [],
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, event: 'created', note: `Cloned from campaign "${campaign.id}".` }],
  };
  return validateFleetV7Campaign(cloned);
}

/** Báo cáo tổng hợp một campaign: theo trạng thái, theo stage, theo node. */
export function summarizeFleetV7Campaign(
  campaign: FleetV7Campaign,
  now = Date.now(),
): FleetV7CampaignReport {
  const counts: Record<FleetV7BotStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    'rolled-back': 0,
    skipped: 0,
  };
  for (const a of campaign.assignments) counts[a.status] += 1;
  const total = campaign.assignments.length;
  const finished = counts.done + counts.failed;
  const stages: FleetV7StageReport[] = campaign.stages.map((stage) => {
    const list = stageAssignments(campaign, stage);
    const done = list.filter((a) => a.status === 'done').length;
    const failed = list.filter((a) => a.status === 'failed').length;
    return {
      stage: stage.stage,
      status: stage.status,
      botIds: [...stage.botIds],
      done,
      failed,
      running: list.filter((a) => a.status === 'running').length,
      pending: list.filter((a) => a.status === 'pending').length,
      rolledBack: list.filter((a) => a.status === 'rolled-back').length,
      successRate: fleetV7StageSuccessRate(campaign, stage),
      ...(stage.gateNote !== undefined ? { gateNote: stage.gateNote } : {}),
    };
  });
  const nodes: FleetV7NodeReport[] = campaign.nodes.map((node) => {
    const list = campaign.assignments.filter((a) => a.nodeId === node.id);
    return {
      nodeId: node.id,
      label: node.label,
      status: node.status,
      total: list.length,
      done: list.filter((a) => a.status === 'done').length,
      failed: list.filter((a) => a.status === 'failed').length,
      running: list.filter((a) => a.status === 'running').length,
      pending: list.filter((a) => a.status === 'pending').length,
      rolledBack: list.filter((a) => a.status === 'rolled-back').length,
    };
  });
  const current =
    campaign.currentStageIndex >= 0 ? campaign.stages[campaign.currentStageIndex] : undefined;
  const startedAt = campaign.stages
    .map((s) => s.startedAt)
    .filter((t): t is number => typeof t === 'number')
    .sort((a, b) => a - b)[0];
  return {
    id: campaign.id,
    goal: campaign.goal,
    strategy: campaign.strategy,
    status: campaign.status,
    totalBots: total,
    done: counts.done,
    failed: counts.failed,
    running: counts.running,
    pending: counts.pending,
    rolledBack: counts['rolled-back'],
    skipped: counts.skipped,
    progressPercent: total === 0 ? 0 : Math.round((counts.done / total) * 100),
    successRate: finished === 0 ? null : counts.done / finished,
    currentStage: current?.stage ?? null,
    stages,
    nodes,
    rollbacks: campaign.rollbackSnapshots.length,
    elapsedMs: startedAt === undefined ? null : Math.max(0, now - startedAt),
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}
