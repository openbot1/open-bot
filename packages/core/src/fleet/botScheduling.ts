/**
 * Fleet bot scheduling v2 — chạy bot trên fleet đa máy (v1.06, Đội T6).
 *
 * Tầng trên của `fleet/nodes.ts` (node nào còn sống) và `fleet/dispatch.ts`
 * (job nào chạy trên máy nào). Module này trả lời câu hỏi riêng của BOT:
 * một bot cụ thể (không phải job chung) nên chạy ở đâu, khi nào, với độ
 * ưu tiên nào — và giữ nó chạy được khi node bận hoặc chết.
 *
 * - `BotPriority`: critical > high > normal > low. Hàng đợi luôn lấy
 *   critical trước; trong cùng mức ưu tiên thì FIFO. Một run chờ quá
 *   lâu được "lão hoá" (aging): độ ưu tiên hiệu dụng tăng dần theo thời
 *   gian chờ để bot low không bao giờ đói vĩnh viễn.
 * - `scoreNodeForBotRun`: chấm điểm một node cho một bot run — chỉ node
 *   alive/stale mới được xét (dead / never-seen = 0, không bao giờ là
 *   target); trừ tài nguyên đã đặt chỗ cho các run đang chạy/scheduled
 *   trên node đó (reservation, không chỉ load node tự báo); phạt theo
 *   CPU đang dùng + số run đang chạy; giới hạn concurrency mỗi node
 *   (maxConcurrentPerNode) là rào cứng — node đủ tài nguyên nhưng đã
 *   đủ slot thì không fit; loopback được cộng điểm (không tốn mạng).
 * - Hàng đợi durable `<fleetRoot>/fleet-bot-schedule.json` (atomic
 *   write, mode 0600, cùng posture với fleet-nodes.json /
 *   fleet-dispatch.json): `enqueueBotRun` → `scheduleBotRuns` (gắn run
 *   đang chờ vào node tốt nhất, theo thứ tự ưu tiên) → node claim qua
 *   `claimBotRun` → `completeBotRun` / `failBotRun` (retry có backoff,
 *   hết maxAttempts thì failed vĩnh viễn, không retry vô hạn).
 * - `requeueDeadNodeRuns`: run (scheduled/running) của node đã chết
 *   được đưa về queued để schedule lại — không mất bot run khi máy chết.
 *
 * Module này KHÔNG chạy bot thật (không spawn process, không SSH):
 * nó là bộ điều phối ghi sổ — node nhận run qua cơ chế claim riêng
 * của nó. Tách bạch như vậy để logic test được thuần túy mà không
 * cần mạng thật. Bot run không chứa secret, chỉ mô tả công việc.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  detectDeadNodes,
  loadFleetNodes,
  nodeLiveness,
  type FleetNode,
  type FleetNodeDispatchRequest,
  type FleetNodeLiveness,
} from './nodes';

/** File lưu hàng đợi / trạng thái bot run trong fleet root. */
export const FLEET_BOT_SCHEDULE_FILE = 'fleet-bot-schedule.json';

/** Số run tối đa chạy đồng thời trên một node (mặc định). */
export const DEFAULT_MAX_CONCURRENT_PER_NODE = 4;
/** Số run tối đa chạy đồng thời của cùng một bot (mặc định). */
export const DEFAULT_MAX_CONCURRENT_PER_BOT = 1;
/** Số lần thử tối đa cho một bot run fail (mặc định). */
export const DEFAULT_MAX_BOT_RUN_ATTEMPTS = 3;
/** Backoff cơ số giữa các lần retry (ms, mặc định). */
export const DEFAULT_BOT_RUN_RETRY_BACKOFF_MS = 5_000;
/** Sau từng này ms chờ, một run được cộng 1 bậc ưu tiên hiệu dụng. */
export const DEFAULT_PRIORITY_AGING_MS = 60_000;

/** Độ ưu tiên của bot run — critical luôn được xét trước. */
export type BotPriority = 'critical' | 'high' | 'normal' | 'low';

export const BOT_PRIORITIES: readonly BotPriority[] = ['critical', 'high', 'normal', 'low'];

/** Trọng số số học của từng mức ưu tiên (dùng để xếp hạng + lão hoá). */
export const BOT_PRIORITY_WEIGHTS: Record<BotPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/** Trạng thái của một bot run. */
export type BotRunStatus =
  | 'queued'
  | 'scheduled'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

/** Một mục trong lịch sử bot run (audit tối thiểu, không secret). */
export interface BotRunHistoryEntry {
  at: number;
  event:
    | 'enqueued'
    | 'scheduled'
    | 'claimed'
    | 'completed'
    | 'failed'
    | 'retried'
    | 'requeued'
    | 'cancelled';
  /** Node liên quan (nếu có). */
  nodeId?: string;
  detail?: string;
}

/** Một lần chạy bot đã lên lịch / đang chạy trong fleet. */
export interface BotRun {
  /** Id ổn định: `br-<uuid>`. */
  id: string;
  /** Bot mà run phục vụ. */
  botId: string;
  /** Mô tả ngắn cho UI/log (không chứa secret). */
  summary: string;
  priority: BotPriority;
  /** Tài nguyên run cần (để chọn node). */
  resources: FleetNodeDispatchRequest;
  status: BotRunStatus;
  /** Node đang giữ run — null khi chưa schedule. */
  nodeId: string | null;
  /** Số lần đã thử chạy (claim = 1 lần thử). */
  attempts: number;
  /** Số lần thử tối đa trước khi run chuyển failed vĩnh viễn. */
  maxAttempts: number;
  /** Epoch ms được phép thử lại (retry backoff) — null khi không chờ retry. */
  nextAttemptAt: number | null;
  /** Lỗi cuối cùng (khi fail). */
  lastError?: string;
  createdAt: number;
  scheduledAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  history: BotRunHistoryEntry[];
}

/** Đầu vào enqueue một bot run. */
export interface EnqueueBotRunInput {
  id?: string;
  botId: string;
  summary: string;
  priority?: BotPriority;
  resources: FleetNodeDispatchRequest;
  maxAttempts?: number;
}

/** Chính sách của bộ lập lịch bot. */
export interface BotSchedulerPolicy {
  /** Số run tối đa chạy đồng thời trên một node (0 = không giới hạn). */
  maxConcurrentPerNode: number;
  /** Số run tối đa chạy đồng thời của cùng một bot (0 = không giới hạn). */
  maxConcurrentPerBot: number;
  /** Số lần thử tối đa mặc định cho run mới. */
  defaultMaxAttempts: number;
  /** Backoff cơ số giữa các lần retry (ms). */
  retryBackoffMs: number;
  /** Ms chờ để được cộng 1 bậc ưu tiên hiệu dụng (0 = tắt lão hoá). */
  priorityAgingMs: number;
}

export const DEFAULT_BOT_SCHEDULER_POLICY: BotSchedulerPolicy = {
  maxConcurrentPerNode: DEFAULT_MAX_CONCURRENT_PER_NODE,
  maxConcurrentPerBot: DEFAULT_MAX_CONCURRENT_PER_BOT,
  defaultMaxAttempts: DEFAULT_MAX_BOT_RUN_ATTEMPTS,
  retryBackoffMs: DEFAULT_BOT_RUN_RETRY_BACKOFF_MS,
  priorityAgingMs: DEFAULT_PRIORITY_AGING_MS,
};

/** Một node được chấm điểm cho một bot run. */
export interface BotRunNodeScore {
  node: FleetNode;
  liveness: FleetNodeLiveness;
  /** True khi node đủ tài nguyên còn lại + còn slot concurrency. */
  fits: boolean;
  /** 0..1, cao hơn = chạy bot tốt hơn (0 khi không fit hoặc node chết). */
  score: number;
  /** Số run đang chạy/scheduled trên node (đặt chỗ). */
  activeRuns: number;
  /** Tài nguyên còn lại SAU khi trừ reservation + request này. */
  headroomAfter: { cpuCores: number; ramBytes: number; diskBytes: number };
  /** Lý do ngắn gọn. */
  reason: string;
}

/** Kết quả một lần schedule (gắn run vào node, hoặc xếp hàng chờ). */
export interface BotScheduleResult {
  run: BotRun;
  /** True khi run đã được gắn node trong lần này. */
  scheduled: boolean;
  nodeId: string | null;
  reason: string;
}

/** Tóm tắt hàng đợi + run của scheduler. */
export interface BotSchedulingSummary {
  total: number;
  queued: number;
  scheduled: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Run đang chờ retry (fail nhưng chưa hết attempts). */
  awaitingRetry: number;
  /** Run queued lâu nhất (ms) — null khi hàng đợi rỗng. */
  oldestQueuedMs: number | null;
  byPriority: Record<BotPriority, number>;
  byNode: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function newBotRunId(): string {
  return `br-${crypto.randomUUID()}`;
}

/** Validate tài nguyên một bot run cần (throw khi sai). */
export function validateBotRunResources(raw: unknown): FleetNodeDispatchRequest {
  if (!isRecord(raw)) throw new Error('bot run resources must be an object.');
  const { cpuCores, ramBytes, diskBytes } = raw;
  if (!isPositiveFinite(cpuCores)) throw new Error('bot run cpuCores must be a number > 0.');
  if (!isPositiveFinite(ramBytes)) throw new Error('bot run ramBytes must be a number > 0.');
  if (!isPositiveFinite(diskBytes)) throw new Error('bot run diskBytes must be a number > 0.');
  return {
    cpuCores: cpuCores as number,
    ramBytes: ramBytes as number,
    diskBytes: diskBytes as number,
  };
}

/** Validate đầu vào enqueue bot run (throw khi sai, kèm lý do rõ). */
export function validateEnqueueBotRunInput(raw: unknown): EnqueueBotRunInput {
  if (!isRecord(raw)) throw new Error('bot run input must be an object.');
  const { id, botId, summary, priority, resources, maxAttempts } = raw;
  if (id !== undefined && (typeof id !== 'string' || id.trim().length === 0)) {
    throw new Error('bot run id must be a non-empty string when given.');
  }
  if (typeof botId !== 'string' || botId.trim().length === 0) {
    throw new Error('bot run needs a non-empty botId.');
  }
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('bot run needs a non-empty summary.');
  }
  if (
    priority !== undefined &&
    !BOT_PRIORITIES.includes(priority as BotPriority)
  ) {
    throw new Error(`bot run priority must be one of: ${BOT_PRIORITIES.join(', ')}.`);
  }
  const validResources = validateBotRunResources(resources);
  if (
    maxAttempts !== undefined &&
    (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1)
  ) {
    throw new Error('bot run maxAttempts must be an integer >= 1.');
  }
  return {
    ...(id !== undefined ? { id } : {}),
    botId: (botId as string).trim(),
    summary: (summary as string).trim(),
    ...(priority !== undefined ? { priority: priority as BotPriority } : {}),
    resources: validResources,
    ...(maxAttempts !== undefined ? { maxAttempts: maxAttempts as number } : {}),
  };
}

/** Validate chính sách scheduler (throw khi sai). */
export function validateBotSchedulerPolicy(raw: unknown): BotSchedulerPolicy {
  if (!isRecord(raw)) throw new Error('bot scheduler policy must be an object.');
  const { maxConcurrentPerNode, maxConcurrentPerBot, defaultMaxAttempts, retryBackoffMs, priorityAgingMs } = raw;
  for (const [key, value] of [
    ['maxConcurrentPerNode', maxConcurrentPerNode],
    ['maxConcurrentPerBot', maxConcurrentPerBot],
  ] as const) {
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new Error(`bot scheduler policy ${key} must be an integer >= 0 (0 = no limit).`);
    }
  }
  if (!Number.isInteger(defaultMaxAttempts) || (defaultMaxAttempts as number) < 1) {
    throw new Error('bot scheduler policy defaultMaxAttempts must be an integer >= 1.');
  }
  if (!Number.isInteger(retryBackoffMs) || (retryBackoffMs as number) < 0) {
    throw new Error('bot scheduler policy retryBackoffMs must be an integer >= 0.');
  }
  if (!Number.isInteger(priorityAgingMs) || (priorityAgingMs as number) < 0) {
    throw new Error('bot scheduler policy priorityAgingMs must be an integer >= 0 (0 = aging off).');
  }
  return {
    maxConcurrentPerNode: maxConcurrentPerNode as number,
    maxConcurrentPerBot: maxConcurrentPerBot as number,
    defaultMaxAttempts: defaultMaxAttempts as number,
    retryBackoffMs: retryBackoffMs as number,
    priorityAgingMs: priorityAgingMs as number,
  };
}

/**
 * Độ ưu tiên hiệu dụng của một run tại `now`: trọng số gốc + số bậc
 * lão hoá (mỗi priorityAgingMs chờ cộng 1, tối đa bằng critical).
 * Run mới tạo chưa chờ thì bằng đúng trọng số gốc — lão hoá chỉ cứu
 * run chờ lâu khỏi đói, không đảo thứ tự ban đầu.
 */
export function effectivePriorityWeight(
  run: Pick<BotRun, 'priority' | 'createdAt'>,
  now = Date.now(),
  policy: BotSchedulerPolicy = DEFAULT_BOT_SCHEDULER_POLICY,
): number {
  const base = BOT_PRIORITY_WEIGHTS[run.priority];
  if (policy.priorityAgingMs <= 0) return base;
  const waited = Math.max(0, now - run.createdAt);
  const bonus = Math.floor(waited / policy.priorityAgingMs);
  return Math.min(BOT_PRIORITY_WEIGHTS.critical, base + bonus);
}

/** So sánh thứ tự hàng đợi: ưu tiên hiệu dụng cao trước, rồi FIFO. */
export function compareBotRunsForQueue(
  a: BotRun,
  b: BotRun,
  now = Date.now(),
  policy: BotSchedulerPolicy = DEFAULT_BOT_SCHEDULER_POLICY,
): number {
  const wa = effectivePriorityWeight(a, now, policy);
  const wb = effectivePriorityWeight(b, now, policy);
  if (wa !== wb) return wb - wa;
  return a.createdAt - b.createdAt;
}

/** Đường dẫn file lưu bot run. */
export function getFleetBotSchedulePath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_BOT_SCHEDULE_FILE);
}

function parseBotRun(raw: unknown, index: number): BotRun {
  if (!isRecord(raw)) throw new Error(`bot run at index ${index} is not an object.`);
  const {
    id, botId, summary, priority, resources, status, nodeId, attempts,
    maxAttempts, nextAttemptAt, lastError, createdAt, scheduledAt,
    startedAt, finishedAt, history,
  } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error(`bot run at index ${index} needs a non-empty id.`);
  if (typeof botId !== 'string' || botId.trim().length === 0) throw new Error(`bot run ${id} needs a non-empty botId.`);
  if (typeof summary !== 'string') throw new Error(`bot run ${id} needs a string summary.`);
  if (!BOT_PRIORITIES.includes(priority as BotPriority)) throw new Error(`bot run ${id} has an invalid priority.`);
  validateBotRunResources(resources);
  const statuses: readonly string[] = ['queued', 'scheduled', 'running', 'done', 'failed', 'cancelled'];
  if (!statuses.includes(status as string)) throw new Error(`bot run ${id} has an invalid status.`);
  if (nodeId !== null && typeof nodeId !== 'string') throw new Error(`bot run ${id} has an invalid nodeId.`);
  if (!Number.isInteger(attempts) || (attempts as number) < 0) throw new Error(`bot run ${id} has an invalid attempts count.`);
  if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1) throw new Error(`bot run ${id} has an invalid maxAttempts.`);
  if (nextAttemptAt !== null && !Number.isInteger(nextAttemptAt)) throw new Error(`bot run ${id} has an invalid nextAttemptAt.`);
  if (lastError !== undefined && typeof lastError !== 'string') throw new Error(`bot run ${id} has an invalid lastError.`);
  for (const key of ['createdAt', 'scheduledAt', 'startedAt', 'finishedAt'] as const) {
    const value = { createdAt, scheduledAt, startedAt, finishedAt }[key];
    if (key === 'createdAt') {
      if (!Number.isInteger(value)) throw new Error(`bot run ${id} has an invalid createdAt.`);
    } else if (value !== null && !Number.isInteger(value)) {
      throw new Error(`bot run ${id} has an invalid ${key}.`);
    }
  }
  if (!Array.isArray(history)) throw new Error(`bot run ${id} needs a history array.`);
  return {
    id: id as string,
    botId: botId as string,
    summary: summary as string,
    priority: priority as BotPriority,
    resources: resources as FleetNodeDispatchRequest,
    status: status as BotRunStatus,
    nodeId: nodeId as string | null,
    attempts: attempts as number,
    maxAttempts: maxAttempts as number,
    nextAttemptAt: nextAttemptAt as number | null,
    ...(lastError !== undefined ? { lastError: lastError as string } : {}),
    createdAt: createdAt as number,
    scheduledAt: scheduledAt as number | null,
    startedAt: startedAt as number | null,
    finishedAt: finishedAt as number | null,
    history: history as BotRunHistoryEntry[],
  };
}

/** Đọc danh sách bot run (file chưa có → rỗng; file hỏng → throw rõ). */
export function loadBotRuns(fleetRoot: string): BotRun[] {
  const filePath = getFleetBotSchedulePath(fleetRoot);
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
    throw new Error(`bot schedule file ${filePath} is not valid JSON — refusing to guess; fix or remove it.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`bot schedule file ${filePath} must contain a JSON array.`);
  return parsed.map((entry, index) => parseBotRun(entry, index));
}

/** Ghi danh sách bot run (atomic: tmp + rename, mode 0600). */
export function saveBotRuns(fleetRoot: string, runs: BotRun[]): void {
  fs.mkdirSync(fleetRoot, { recursive: true });
  const filePath = getFleetBotSchedulePath(fleetRoot);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(runs, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Filesystem không hỗ trợ chmod — bỏ qua.
  }
}

/** Tài nguyên đã đặt chỗ trên một node bởi các run active (scheduled/running). */
export function reservedResourcesOnNode(
  runs: BotRun[],
  nodeId: string,
): { cpuCores: number; ramBytes: number; diskBytes: number; activeRuns: number } {
  let cpuCores = 0;
  let ramBytes = 0;
  let diskBytes = 0;
  let activeRuns = 0;
  for (const run of runs) {
    if (run.nodeId !== nodeId) continue;
    if (run.status !== 'scheduled' && run.status !== 'running') continue;
    activeRuns += 1;
    cpuCores += run.resources.cpuCores;
    ramBytes += run.resources.ramBytes;
    diskBytes += run.resources.diskBytes;
  }
  return { cpuCores, ramBytes, diskBytes, activeRuns };
}

/** Số run active của một bot (scheduled/running) — để giới hạn concurrency theo bot. */
export function activeRunsForBot(runs: BotRun[], botId: string): number {
  return runs.filter(
    (r) => r.botId === botId && (r.status === 'scheduled' || r.status === 'running'),
  ).length;
}

/**
 * Chấm điểm một node cho một bot run (pure):
 * - dead / never-seen → 0, không bao giờ là target;
 * - vượt giới hạn concurrency của node → 0 (rào cứng);
 * - không đủ tài nguyên sau khi trừ reservation → 0;
 * - còn lại: điểm từ headroom sau placement + phạt theo CPU dùng +
 *   số run đang chạy + bonus loopback (+0.15, tối đa 1). Stale node
 *   vẫn được chấm nhưng điểm bị phạt một nửa — chỉ dùng khi hết alive.
 */
export function scoreNodeForBotRun(
  node: FleetNode,
  run: Pick<BotRun, 'resources'>,
  allRuns: BotRun[],
  now = Date.now(),
  policy: BotSchedulerPolicy = DEFAULT_BOT_SCHEDULER_POLICY,
): BotRunNodeScore {
  const liveness = nodeLiveness(node, now);
  const reserved = reservedResourcesOnNode(allRuns, node.id);
  const headroomAfter = {
    cpuCores: node.cpuCores - reserved.cpuCores - run.resources.cpuCores,
    ramBytes: node.ramBytes - reserved.ramBytes - run.resources.ramBytes,
    diskBytes: node.diskBytes - reserved.diskBytes - run.resources.diskBytes,
  };
  // Node đang drain cho bảo trì (xem fleet/nodeMaintenance.ts) không
  // bao giờ nhận run mới. Cờ `draining` là field optional trên
  // FleetNode nên đọc inline ở đây để tránh import vòng.
  if ((node as { draining?: boolean }).draining === true) {
    return { node, liveness, fits: false, score: 0, activeRuns: reserved.activeRuns, headroomAfter, reason: 'node is draining for maintenance, never schedule new bot runs to it.' };
  }
  if (liveness === 'dead' || liveness === 'never-seen') {
    return { node, liveness, fits: false, score: 0, activeRuns: reserved.activeRuns, headroomAfter, reason: `node is ${liveness}, never schedule a bot run to it.` };
  }
  if (policy.maxConcurrentPerNode > 0 && reserved.activeRuns >= policy.maxConcurrentPerNode) {
    return { node, liveness, fits: false, score: 0, activeRuns: reserved.activeRuns, headroomAfter, reason: `node already runs ${reserved.activeRuns} bot runs (limit ${policy.maxConcurrentPerNode}).` };
  }
  if (headroomAfter.cpuCores < 0 || headroomAfter.ramBytes < 0 || headroomAfter.diskBytes < 0) {
    return { node, liveness, fits: false, score: 0, activeRuns: reserved.activeRuns, headroomAfter, reason: 'node does not have enough free resources after reservations.' };
  }
  const load = node.lastLoad;
  const cpuUsed = load?.cpuUsedFraction ?? 0;
  const freeCpu = headroomAfter.cpuCores / node.cpuCores;
  const freeRam = headroomAfter.ramBytes / node.ramBytes;
  const freeDisk = headroomAfter.diskBytes / node.diskBytes;
  const headroom = (freeCpu + freeRam + freeDisk) / 3;
  const loadPenalty = Math.min(0.5, reserved.activeRuns * 0.05 + cpuUsed * 0.2);
  let score = Math.max(0, Math.min(1, headroom * 0.85 - loadPenalty + 0.15));
  if (node.loopback) score = Math.min(1, score + 0.15);
  if (liveness === 'stale') score *= 0.5;
  return {
    node,
    liveness,
    fits: true,
    score,
    activeRuns: reserved.activeRuns,
    headroomAfter,
    reason: node.loopback ? 'loopback node with enough resources and a free slot.' : 'LAN node with enough resources and a free slot.',
  };
}

/** Chọn node tốt nhất cho một bot run (null khi không node nào fit + alive/stale). */
export function pickBestNodeForBotRun(
  nodes: FleetNode[],
  run: Pick<BotRun, 'resources'>,
  allRuns: BotRun[],
  now = Date.now(),
  policy: BotSchedulerPolicy = DEFAULT_BOT_SCHEDULER_POLICY,
): BotRunNodeScore | null {
  const scored = nodes
    .map((node) => scoreNodeForBotRun(node, run, allRuns, now, policy))
    .filter((s) => s.fits)
    .sort((a, b) => {
      if (a.liveness !== b.liveness) return a.liveness === 'alive' ? -1 : 1;
      return b.score - a.score;
    });
  return scored[0] ?? null;
}

/** Thêm một bot run vào hàng đợi (id trùng → throw). */
export function enqueueBotRun(
  fleetRoot: string,
  input: EnqueueBotRunInput,
  policy: BotSchedulerPolicy = DEFAULT_BOT_SCHEDULER_POLICY,
  at = Date.now(),
): BotRun {
  const valid = validateEnqueueBotRunInput(input);
  const runs = loadBotRuns(fleetRoot);
  const id = valid.id ?? newBotRunId();
  if (runs.some((r) => r.id === id)) throw new Error(`bot run id "${id}" is already scheduled.`);
  const run: BotRun = {
    id,
    botId: valid.botId,
    summary: valid.summary,
    priority: valid.priority ?? 'normal',
    resources: valid.resources,
    status: 'queued',
    nodeId: null,
    attempts: 0,
    maxAttempts: valid.maxAttempts ?? policy.defaultMaxAttempts,
    nextAttemptAt: null,
    createdAt: at,
    scheduledAt: null,
    startedAt: null,
    finishedAt: null,
    history: [{ at, event: 'enqueued', detail: `priority=${valid.priority ?? 'normal'}` }],
  };
  saveBotRuns(fleetRoot, [...runs, run]);
  return run;
}

/** Tìm bot run theo id (không có → null, không throw). */
export function findBotRun(fleetRoot: string, runId: string): BotRun | null {
  return loadBotRuns(fleetRoot).find((r) => r.id === runId) ?? null;
}

/** Liệt kê bot run, lọc theo status / botId / nodeId (mới nhất trước). */
export function listBotRuns(
  fleetRoot: string,
  filter: { status?: BotRunStatus; botId?: string; nodeId?: string } = {},
): BotRun[] {
  return loadBotRuns(fleetRoot)
    .filter((r) => (filter.status === undefined || r.status === filter.status)
      && (filter.botId === undefined || r.botId === filter.botId)
      && (filter.nodeId === undefined || r.nodeId === filter.nodeId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Lên lịch một run đang queued: chọn node tốt nhất còn sống.
 * - Run chưa tới lượt retry (nextAttemptAt > now) → ở lại queued.
 * - Bot đã đủ slot concurrency → ở lại queued (không chiếm chỗ bot khác).
 * - Không node nào fit → ở lại queued, ghi rõ lý do vào history.
 */
export function scheduleBotRun(
  fleetRoot: string,
  runId: string,
  policy: BotSchedulerPolicy = DEFAULT_BOT_SCHEDULER_POLICY,
  at = Date.now(),
): BotScheduleResult {
  const runs = loadBotRuns(fleetRoot);
  const index = runs.findIndex((r) => r.id === runId);
  if (index === -1) throw new Error(`bot run "${runId}" is not scheduled.`);
  const run = runs[index];
  if (run.status !== 'queued') {
    return { run, scheduled: false, nodeId: run.nodeId, reason: `bot run is ${run.status}, not queued.` };
  }
  if (run.nextAttemptAt !== null && run.nextAttemptAt > at) {
    return { run, scheduled: false, nodeId: null, reason: `bot run waits for retry until ${new Date(run.nextAttemptAt).toISOString()}.` };
  }
  if (policy.maxConcurrentPerBot > 0 && activeRunsForBot(runs, run.botId) >= policy.maxConcurrentPerBot) {
    return { run, scheduled: false, nodeId: null, reason: `bot "${run.botId}" already runs ${policy.maxConcurrentPerBot} run(s) (limit ${policy.maxConcurrentPerBot}).` };
  }
  const nodes = loadFleetNodes(fleetRoot);
  const best = pickBestNodeForBotRun(nodes, run, runs, at, policy);
  if (!best) {
    return { run, scheduled: false, nodeId: null, reason: 'no alive node has enough free resources and a free slot right now.' };
  }
  const updated: BotRun = {
    ...run,
    status: 'scheduled',
    nodeId: best.node.id,
    scheduledAt: at,
    history: [...run.history, { at, event: 'scheduled', nodeId: best.node.id, detail: best.reason }],
  };
  runs[index] = updated;
  saveBotRuns(fleetRoot, runs);
  return { run: updated, scheduled: true, nodeId: best.node.id, reason: best.reason };
}

/**
 * Lên lịch tất cả run đang queued (theo thứ tự ưu tiên + FIFO):
 * trả về kết quả từng run. Run nào không schedule được thì ở lại
 * queued — lần gọi sau thử lại khi capacity thay đổi.
 */
export function scheduleBotRuns(
  fleetRoot: string,
  policy: BotSchedulerPolicy = DEFAULT_BOT_SCHEDULER_POLICY,
  at = Date.now(),
): BotScheduleResult[] {
  const queued = loadBotRuns(fleetRoot)
    .filter((r) => r.status === 'queued')
    .sort((a, b) => compareBotRunsForQueue(a, b, at, policy));
  const results: BotScheduleResult[] = [];
  for (const run of queued) {
    results.push(scheduleBotRun(fleetRoot, run.id, policy, at));
  }
  return results;
}

/** Node claim run đã schedule (chỉ đúng node đó được claim; claim = 1 lần thử). */
export function claimBotRun(fleetRoot: string, runId: string, nodeId: string, at = Date.now()): BotRun {
  const runs = loadBotRuns(fleetRoot);
  const index = runs.findIndex((r) => r.id === runId);
  if (index === -1) throw new Error(`bot run "${runId}" is not scheduled.`);
  const run = runs[index];
  if (run.status !== 'scheduled') throw new Error(`bot run "${runId}" is ${run.status}, only a scheduled run can be claimed.`);
  if (run.nodeId !== nodeId) throw new Error(`bot run "${runId}" is scheduled to node "${run.nodeId}", not "${nodeId}".`);
  const updated: BotRun = {
    ...run,
    status: 'running',
    attempts: run.attempts + 1,
    startedAt: at,
    history: [...run.history, { at, event: 'claimed', nodeId }],
  };
  runs[index] = updated;
  saveBotRuns(fleetRoot, runs);
  return updated;
}

/** Node báo run xong (chỉ đúng node đó được báo). */
export function completeBotRun(fleetRoot: string, runId: string, nodeId: string, at = Date.now()): BotRun {
  const runs = loadBotRuns(fleetRoot);
  const index = runs.findIndex((r) => r.id === runId);
  if (index === -1) throw new Error(`bot run "${runId}" is not scheduled.`);
  const run = runs[index];
  if (run.status !== 'running') throw new Error(`bot run "${runId}" is ${run.status}, only a running run can complete.`);
  if (run.nodeId !== nodeId) throw new Error(`bot run "${runId}" runs on node "${run.nodeId}", not "${nodeId}".`);
  const updated: BotRun = {
    ...run,
    status: 'done',
    finishedAt: at,
    history: [...run.history, { at, event: 'completed', nodeId }],
  };
  runs[index] = updated;
  saveBotRuns(fleetRoot, runs);
  return updated;
}

/**
 * Node báo run fail: còn attempts → về queued + hẹn retry sau backoff
 * (backoff nhân đôi mỗi lần: backoff * 2^(attempts-1)); hết attempts →
 * failed vĩnh viễn. Lỗi được lưu lại (không secret — caller chỉ ghi
 * message ngắn, không ghi stack/key).
 */
export function failBotRun(
  fleetRoot: string,
  runId: string,
  nodeId: string,
  error: string,
  policy: BotSchedulerPolicy = DEFAULT_BOT_SCHEDULER_POLICY,
  at = Date.now(),
): BotRun {
  const runs = loadBotRuns(fleetRoot);
  const index = runs.findIndex((r) => r.id === runId);
  if (index === -1) throw new Error(`bot run "${runId}" is not scheduled.`);
  const run = runs[index];
  if (run.status !== 'running') throw new Error(`bot run "${runId}" is ${run.status}, only a running run can fail.`);
  if (run.nodeId !== nodeId) throw new Error(`bot run "${runId}" runs on node "${run.nodeId}", not "${nodeId}".`);
  if (typeof error !== 'string' || error.trim().length === 0) throw new Error('failBotRun needs a non-empty error message.');
  const canRetry = run.attempts < run.maxAttempts;
  const backoff = canRetry ? policy.retryBackoffMs * 2 ** Math.max(0, run.attempts - 1) : 0;
  const updated: BotRun = {
    ...run,
    status: canRetry ? 'queued' : 'failed',
    nodeId: canRetry ? null : run.nodeId,
    nextAttemptAt: canRetry ? at + backoff : null,
    scheduledAt: canRetry ? null : run.scheduledAt,
    startedAt: canRetry ? null : run.startedAt,
    lastError: error.trim().slice(0, 500),
    ...(canRetry ? {} : { finishedAt: at }),
    history: [
      ...run.history,
      {
        at,
        event: canRetry ? 'retried' : 'failed',
        nodeId,
        detail: canRetry
          ? `attempt ${run.attempts}/${run.maxAttempts} failed, retry in ${backoff}ms: ${error.trim().slice(0, 200)}`
          : `attempt ${run.attempts}/${run.maxAttempts} failed, no more retries: ${error.trim().slice(0, 200)}`,
      },
    ],
  };
  runs[index] = updated;
  saveBotRuns(fleetRoot, runs);
  return updated;
}

/** Huỷ run (queued/scheduled/running đều huỷ được; done/failed thì throw). */
export function cancelBotRun(fleetRoot: string, runId: string, at = Date.now()): BotRun {
  const runs = loadBotRuns(fleetRoot);
  const index = runs.findIndex((r) => r.id === runId);
  if (index === -1) throw new Error(`bot run "${runId}" is not scheduled.`);
  const run = runs[index];
  if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
    throw new Error(`bot run "${runId}" is already ${run.status} and cannot be cancelled.`);
  }
  const updated: BotRun = {
    ...run,
    status: 'cancelled',
    finishedAt: at,
    history: [...run.history, { at, event: 'cancelled', nodeId: run.nodeId ?? undefined }],
  };
  runs[index] = updated;
  saveBotRuns(fleetRoot, runs);
  return updated;
}

/**
 * Run (scheduled/running) của node đã chết được đưa về queued để
 * schedule lại sang node sống — attempts giữ nguyên (lần chạy dở đó
 * vẫn tính là 1 lần thử, không ăn gian retry). Trả về danh sách đã
 * đưa về hàng đợi.
 */
export function requeueDeadNodeRuns(
  fleetRoot: string,
  now = Date.now(),
  timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
): BotRun[] {
  const nodes = loadFleetNodes(fleetRoot);
  const deadIds = new Set(detectDeadNodes(nodes, now, timeoutMs).map((n) => n.id));
  if (deadIds.size === 0) return [];
  const runs = loadBotRuns(fleetRoot);
  const requeued: BotRun[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if ((run.status !== 'scheduled' && run.status !== 'running') || run.nodeId === null) continue;
    if (!deadIds.has(run.nodeId)) continue;
    const updated: BotRun = {
      ...run,
      status: 'queued',
      nodeId: null,
      scheduledAt: null,
      startedAt: null,
      nextAttemptAt: null,
      history: [...run.history, { at: now, event: 'requeued', nodeId: run.nodeId, detail: 'node died, back to queue.' }],
    };
    runs[i] = updated;
    requeued.push(updated);
  }
  if (requeued.length > 0) saveBotRuns(fleetRoot, runs);
  return requeued;
}

/** Kết quả dry-run: xếp hạng node cho một bot run mà KHÔNG ghi gì. */
export interface BotRunPlan {
  request: EnqueueBotRunInput;
  candidates: BotRunNodeScore[];
  /** Node tốt nhất, hoặc null khi không node nào fit. */
  best: BotRunNodeScore | null;
  plannedAt: number;
}

/**
 * Dry-run lập lịch: chấm điểm mọi node cho một bot run (theo thứ tự
 * ưu tiên đã có) mà không enqueue, không ghi file. Dùng cho UI/CLI
 * xem trước "bot này sẽ chạy ở đâu" trước khi schedule thật.
 */
export function planBotRun(
  fleetRoot: string,
  input: EnqueueBotRunInput,
  policy: BotSchedulerPolicy = DEFAULT_BOT_SCHEDULER_POLICY,
  at = Date.now(),
): BotRunPlan {
  const valid = validateEnqueueBotRunInput(input);
  const nodes = loadFleetNodes(fleetRoot);
  const runs = loadBotRuns(fleetRoot);
  const request: EnqueueBotRunInput = {
    botId: valid.botId,
    summary: valid.summary,
    priority: valid.priority ?? 'normal',
    resources: valid.resources,
    ...(valid.maxAttempts !== undefined ? { maxAttempts: valid.maxAttempts } : {}),
  };
  const candidates = nodes
    .map((node) => scoreNodeForBotRun(node, { resources: valid.resources }, runs, at, policy))
    .sort((a, b) => {
      if (a.fits !== b.fits) return a.fits ? -1 : 1;
      if (a.liveness !== b.liveness) return a.liveness === 'alive' ? -1 : 1;
      return b.score - a.score;
    });
  return {
    request,
    candidates,
    best: candidates.find((c) => c.fits) ?? null,
    plannedAt: at,
  };
}

/** Tóm tắt hàng đợi + run (để UI/CLI/tools hiển thị nhanh). */
export function summarizeBotScheduling(
  fleetRoot: string,
  at = Date.now(),
): BotSchedulingSummary {
  const runs = loadBotRuns(fleetRoot);
  const summary: BotSchedulingSummary = {
    total: runs.length,
    queued: 0,
    scheduled: 0,
    running: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    awaitingRetry: 0,
    oldestQueuedMs: null,
    byPriority: { critical: 0, high: 0, normal: 0, low: 0 },
    byNode: {},
  };
  for (const run of runs) {
    summary[run.status] += 1;
    summary.byPriority[run.priority] += 1;
    if (run.status === 'queued' && run.nextAttemptAt !== null && run.nextAttemptAt > at) {
      summary.awaitingRetry += 1;
    }
    if (run.status === 'queued') {
      const waited = at - run.createdAt;
      summary.oldestQueuedMs = summary.oldestQueuedMs === null ? waited : Math.max(summary.oldestQueuedMs, waited);
    }
    if (run.nodeId !== null && (run.status === 'scheduled' || run.status === 'running')) {
      summary.byNode[run.nodeId] = (summary.byNode[run.nodeId] ?? 0) + 1;
    }
  }
  return summary;
}
