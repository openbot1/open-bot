/**
 * Fleet dispatch v2 — multi-machine dispatch + work stealing (v1.04, Team T6).
 *
 * Tầng trên của `fleet/nodes.ts`: node registry cho biết máy nào còn
 * sống, module này quyết định JOB nào chạy trên máy nào.
 *
 * - `submitJob` tạo job chờ dispatch (queued, chưa gắn node).
 * - `dispatchJob` chọn node tốt nhất còn sống (qua `pickBestNode` —
 *   loopback-first, node chết không bao giờ được chọn) và gắn job vào
 *   node đó. Job đã gắn node chỉ node đó mới được claim.
 * - `claimJob` / `completeJob` / `failJob`: vòng đời job. Fail có thể
 *   retry (giới hạn attempts, requeue về trạng thái queued).
 * - `reassignDeadNodeJobs`: job (queued hoặc running) của node đã chết
 *   được đưa về queued để dispatch lại — không mất job khi máy chết.
 * - `stealWork` (work stealing): node RẢNH chủ động kéo job đang chờ
 *   của node BẬN. Node bận = queuedJobs vượt ngưỡng HOẶC cpuUsed cao;
 *   job bị lấy ghi rõ `stolenFrom` + history để audit được. Không có
 *   "đẩy" job từ controller — node rảnh tự kéo, tránh race khi node
 *   bận vừa claim job.
 *
 * Store durable: `<fleetRoot>/fleet-dispatch.json` (atomic write, mode
 * 0600, cùng posture với các store fleet khác). Job không chứa secret,
 * chỉ mô tả công việc (botId, kind, payload mô tả ngắn).
 *
 * Module này không chạy job thật (không spawn process, không SSH):
 * nó là bộ điều phối ghi sổ — node nhận job qua cơ chế riêng của nó
 * (claim qua API loopback của node). Tách bạch như vậy để dispatch
 * logic test được thuần túy mà không cần mạng thật.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  detectDeadNodes,
  loadFleetNodes,
  nodeLiveness,
  pickBestNode,
  type FleetNode,
  type FleetNodeDispatchRequest,
} from './nodes';

/** File lưu job dispatch trong fleet root. */
export const FLEET_DISPATCH_FILE = 'fleet-dispatch.json';

/** Số lần retry tối đa cho một job fail (mặc định). */
export const DEFAULT_MAX_JOB_ATTEMPTS = 3;
/** Node bị coi là bận khi queuedJobs >= ngưỡng này (mặc định). */
export const DEFAULT_STEAL_QUEUE_THRESHOLD = 3;
/** Node bị coi là bận khi cpuUsedFraction >= ngưỡng này (mặc định). */
export const DEFAULT_STEAL_CPU_THRESHOLD = 0.8;
/** Node rảnh khi runningJobs + queuedJobs <= ngưỡng này (mặc định). */
export const DEFAULT_IDLE_JOB_THRESHOLD = 0;

/** Trạng thái của một job dispatch. */
export type FleetJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** Loại công việc (mở rộng được, chỉ dùng để hiển thị/lọc). */
export type FleetJobKind = 'bot-run' | 'eval-run' | 'benchmark-run' | 'maintenance';

export const FLEET_JOB_KINDS: readonly FleetJobKind[] = ['bot-run', 'eval-run', 'benchmark-run', 'maintenance'];

/** Một mục trong lịch sử job (audit tối thiểu, không secret). */
export interface FleetJobHistoryEntry {
  at: number;
  event: 'submitted' | 'dispatched' | 'claimed' | 'completed' | 'failed' | 'retried' | 'stolen' | 'reassigned' | 'cancelled';
  /** Node liên quan (nếu có). */
  nodeId?: string;
  detail?: string;
}

/** Một job chờ/chạy trong fleet đa máy. */
export interface FleetJob {
  /** Id ổn định: `fj-<uuid>`. */
  id: string;
  /** Bot mà job phục vụ (nếu có). */
  botId: string;
  kind: FleetJobKind;
  /** Mô tả ngắn cho UI/log (không chứa secret). */
  summary: string;
  /** Tài nguyên job cần (để chọn node). */
  resources: FleetNodeDispatchRequest;
  status: FleetJobStatus;
  /** Node đang giữ job — null khi chưa dispatch. */
  nodeId: string | null;
  /** Node job bị lấy từ đó (khi job từng bị steal) — null khi chưa từng. */
  stolenFrom: string | null;
  /** Số lần đã thử chạy (claim = 1 lần thử). */
  attempts: number;
  /** Số lần thử tối đa trước khi job chuyển failed vĩnh viễn. */
  maxAttempts: number;
  /** Lỗi cuối cùng (khi fail). */
  lastError?: string;
  createdAt: number;
  dispatchedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  history: FleetJobHistoryEntry[];
}

/** Đầu vào submit job. */
export interface SubmitFleetJobInput {
  id?: string;
  botId: string;
  kind: FleetJobKind;
  summary: string;
  resources: FleetNodeDispatchRequest;
  maxAttempts?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function newJobId(): string {
  return `fj-${crypto.randomUUID()}`;
}

function historyEntry(
  event: FleetJobHistoryEntry['event'],
  at: number,
  nodeId?: string,
  detail?: string,
): FleetJobHistoryEntry {
  return { at, event, ...(nodeId !== undefined ? { nodeId } : {}), ...(detail !== undefined ? { detail } : {}) };
}

/** Validate tài nguyên job (throw khi sai). */
export function validateJobResources(raw: unknown): FleetNodeDispatchRequest {
  if (!isRecord(raw)) throw new Error('job resources must be an object.');
  const { cpuCores, ramBytes, diskBytes } = raw;
  if (!isPositiveFinite(cpuCores)) throw new Error('job cpuCores must be a number > 0.');
  if (!isPositiveFinite(ramBytes)) throw new Error('job ramBytes must be a number > 0.');
  if (!isPositiveFinite(diskBytes)) throw new Error('job diskBytes must be a number > 0.');
  return { cpuCores, ramBytes, diskBytes };
}

/** Validate đầu vào submit job (throw khi sai). */
export function validateSubmitJobInput(raw: unknown): SubmitFleetJobInput {
  if (!isRecord(raw)) throw new Error('job submission must be an object.');
  const { id, botId, kind, summary, resources, maxAttempts } = raw;
  if (id !== undefined && (typeof id !== 'string' || id.trim().length === 0)) {
    throw new Error('job id must be a non-empty string when given.');
  }
  if (typeof botId !== 'string' || botId.trim().length === 0) {
    throw new Error('job submission needs a non-empty botId.');
  }
  if (!FLEET_JOB_KINDS.includes(kind as FleetJobKind)) {
    throw new Error(`job kind must be one of: ${FLEET_JOB_KINDS.join(', ')}.`);
  }
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('job submission needs a non-empty summary.');
  }
  const validResources = validateJobResources(resources);
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > 10)) {
    throw new Error('job maxAttempts must be an integer between 1 and 10.');
  }
  return {
    ...(id !== undefined ? { id } : {}),
    botId: botId.trim(),
    kind: kind as FleetJobKind,
    summary: summary.trim(),
    resources: validResources,
    ...(maxAttempts !== undefined ? { maxAttempts: maxAttempts as number } : {}),
  };
}

/** Đường dẫn file job dispatch. */
export function getFleetDispatchPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_DISPATCH_FILE);
}

function parseJob(raw: unknown, index: number): FleetJob {
  if (!isRecord(raw)) throw new Error(`fleet job at index ${index} is not an object.`);
  const { id, botId, kind, summary, resources, status, nodeId, stolenFrom, attempts, maxAttempts, lastError, createdAt, dispatchedAt, startedAt, finishedAt, history } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error(`fleet job at index ${index} needs a non-empty id.`);
  if (typeof botId !== 'string' || botId.trim().length === 0) throw new Error(`fleet job ${id} needs a non-empty botId.`);
  if (!FLEET_JOB_KINDS.includes(kind as FleetJobKind)) throw new Error(`fleet job ${id} has an invalid kind.`);
  if (typeof summary !== 'string') throw new Error(`fleet job ${id} needs a string summary.`);
  validateJobResources(resources);
  const statuses: FleetJobStatus[] = ['queued', 'running', 'done', 'failed', 'cancelled'];
  if (!statuses.includes(status as FleetJobStatus)) throw new Error(`fleet job ${id} has an invalid status.`);
  if (nodeId !== null && typeof nodeId !== 'string') throw new Error(`fleet job ${id} has an invalid nodeId.`);
  if (stolenFrom !== null && typeof stolenFrom !== 'string') throw new Error(`fleet job ${id} has an invalid stolenFrom.`);
  if (!Number.isInteger(attempts) || (attempts as number) < 0) throw new Error(`fleet job ${id} has an invalid attempts.`);
  if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1) throw new Error(`fleet job ${id} has an invalid maxAttempts.`);
  if (lastError !== undefined && typeof lastError !== 'string') throw new Error(`fleet job ${id} has an invalid lastError.`);
  if (!Number.isInteger(createdAt)) throw new Error(`fleet job ${id} needs an integer createdAt.`);
  for (const field of [dispatchedAt, startedAt, finishedAt]) {
    if (field !== null && !Number.isInteger(field)) throw new Error(`fleet job ${id} has an invalid timestamp.`);
  }
  if (!Array.isArray(history)) throw new Error(`fleet job ${id} needs a history array.`);
  return {
    id: id as string,
    botId: botId as string,
    kind: kind as FleetJobKind,
    summary: summary as string,
    resources: resources as FleetNodeDispatchRequest,
    status: status as FleetJobStatus,
    nodeId: nodeId as string | null,
    stolenFrom: stolenFrom as string | null,
    attempts: attempts as number,
    maxAttempts: maxAttempts as number,
    ...(lastError !== undefined ? { lastError: lastError as string } : {}),
    createdAt: createdAt as number,
    dispatchedAt: dispatchedAt as number | null,
    startedAt: startedAt as number | null,
    finishedAt: finishedAt as number | null,
    history: history as FleetJobHistoryEntry[],
  };
}

/** Đọc danh sách job (file chưa có → rỗng; file hỏng → throw rõ). */
export function loadFleetJobs(fleetRoot: string): FleetJob[] {
  const filePath = getFleetDispatchPath(fleetRoot);
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
    throw new Error(`fleet dispatch file ${filePath} is not valid JSON — refusing to guess; fix or remove it.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`fleet dispatch file ${filePath} must contain a JSON array.`);
  return parsed.map((entry, index) => parseJob(entry, index));
}

/** Ghi danh sách job (atomic: tmp + rename, mode 0600). */
export function saveFleetJobs(fleetRoot: string, jobs: FleetJob[]): void {
  fs.mkdirSync(fleetRoot, { recursive: true });
  const filePath = getFleetDispatchPath(fleetRoot);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(jobs, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Filesystem không hỗ trợ chmod — bỏ qua.
  }
}

function persistJob(fleetRoot: string, jobs: FleetJob[], updated: FleetJob): FleetJob {
  const index = jobs.findIndex((j) => j.id === updated.id);
  if (index === -1) jobs.push(updated);
  else jobs[index] = updated;
  saveFleetJobs(fleetRoot, jobs);
  return updated;
}

/** Tạo job mới ở trạng thái queued (chưa gắn node). */
export function submitJob(fleetRoot: string, input: SubmitFleetJobInput, at = Date.now()): FleetJob {
  const valid = validateSubmitJobInput(input);
  const jobs = loadFleetJobs(fleetRoot);
  const id = valid.id ?? newJobId();
  if (jobs.some((j) => j.id === id)) throw new Error(`fleet job id "${id}" already exists.`);
  const job: FleetJob = {
    id,
    botId: valid.botId,
    kind: valid.kind,
    summary: valid.summary,
    resources: valid.resources,
    status: 'queued',
    nodeId: null,
    stolenFrom: null,
    attempts: 0,
    maxAttempts: valid.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS,
    createdAt: at,
    dispatchedAt: null,
    startedAt: null,
    finishedAt: null,
    history: [historyEntry('submitted', at)],
  };
  saveFleetJobs(fleetRoot, [...jobs, job]);
  return job;
}

/** Tìm job theo id (không có → null). */
export function findFleetJob(fleetRoot: string, jobId: string): FleetJob | null {
  return loadFleetJobs(fleetRoot).find((j) => j.id === jobId) ?? null;
}

/** Liệt kê job, lọc theo status và/hoặc node (mới nhất trước). */
export function listFleetJobs(
  fleetRoot: string,
  filter: { status?: FleetJobStatus; nodeId?: string } = {},
): FleetJob[] {
  return loadFleetJobs(fleetRoot)
    .filter((j) => (filter.status === undefined || j.status === filter.status) && (filter.nodeId === undefined || j.nodeId === filter.nodeId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Kết quả dispatch một job. */
export interface DispatchResult {
  job: FleetJob;
  /** Node được chọn — null khi không có node nào phù hợp. */
  node: FleetNode | null;
  reason: string;
}

/**
 * Dispatch một job đang queued sang node tốt nhất còn sống.
 * - Job không ở queued → throw (không dispatch lại job đang chạy/xong).
 * - Không có node fit → job ở lại queued, trả về node null + lý do.
 * - Node chết / never-seen không bao giờ được chọn (pickBestNode).
 */
export function dispatchJob(fleetRoot: string, jobId: string, at = Date.now()): DispatchResult {
  const jobs = loadFleetJobs(fleetRoot);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`fleet job "${jobId}" does not exist.`);
  if (job.status !== 'queued') throw new Error(`fleet job "${jobId}" is ${job.status}, only queued jobs can be dispatched.`);
  const nodes = loadFleetNodes(fleetRoot);
  const best = pickBestNode(nodes, job.resources, at);
  if (!best) {
    return { job, node: null, reason: 'no alive node has the requested resources right now — job stays queued.' };
  }
  const updated: FleetJob = {
    ...job,
    nodeId: best.node.id,
    dispatchedAt: at,
    history: [...job.history, historyEntry('dispatched', at, best.node.id, best.reason)],
  };
  persistJob(fleetRoot, jobs, updated);
  return { job: updated, node: best.node, reason: best.reason };
}

/**
 * Node claim job đã dispatch cho nó: queued → running, attempts +1.
 * Job của node khác / chưa dispatch / không queued → throw.
 */
export function claimJob(fleetRoot: string, jobId: string, nodeId: string, at = Date.now()): FleetJob {
  const jobs = loadFleetJobs(fleetRoot);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`fleet job "${jobId}" does not exist.`);
  if (job.status !== 'queued') throw new Error(`fleet job "${jobId}" is ${job.status}, only queued jobs can be claimed.`);
  if (job.nodeId === null) throw new Error(`fleet job "${jobId}" has not been dispatched yet — dispatch it first.`);
  if (job.nodeId !== nodeId) {
    throw new Error(`fleet job "${jobId}" is assigned to node "${job.nodeId}", not "${nodeId}" — use stealWork to take it.`);
  }
  const updated: FleetJob = {
    ...job,
    status: 'running',
    attempts: job.attempts + 1,
    startedAt: at,
    history: [...job.history, historyEntry('claimed', at, nodeId)],
  };
  return persistJob(fleetRoot, jobs, updated);
}

/** Node báo job xong: running → done. */
export function completeJob(fleetRoot: string, jobId: string, nodeId: string, at = Date.now()): FleetJob {
  const jobs = loadFleetJobs(fleetRoot);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`fleet job "${jobId}" does not exist.`);
  if (job.status !== 'running') throw new Error(`fleet job "${jobId}" is ${job.status}, only running jobs can complete.`);
  if (job.nodeId !== nodeId) throw new Error(`fleet job "${jobId}" is running on node "${job.nodeId}", not "${nodeId}".`);
  const updated: FleetJob = {
    ...job,
    status: 'done',
    finishedAt: at,
    history: [...job.history, historyEntry('completed', at, nodeId)],
  };
  return persistJob(fleetRoot, jobs, updated);
}

/**
 * Node báo job lỗi: running → queued (retry, còn attempts) hoặc failed
 * (hết attempts). Job retry giữ nguyên nodeId để node đó thử lại;
 * controller có thể dispatch lại sang node khác bằng cách requeue
 * tường minh (xem reassignDeadNodeJobs / stealWork).
 */
export function failJob(fleetRoot: string, jobId: string, nodeId: string, error: string, at = Date.now()): FleetJob {
  const jobs = loadFleetJobs(fleetRoot);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`fleet job "${jobId}" does not exist.`);
  if (job.status !== 'running') throw new Error(`fleet job "${jobId}" is ${job.status}, only running jobs can fail.`);
  if (job.nodeId !== nodeId) throw new Error(`fleet job "${jobId}" is running on node "${job.nodeId}", not "${nodeId}".`);
  if (typeof error !== 'string' || error.trim().length === 0) throw new Error('failJob needs a non-empty error message.');
  const canRetry = job.attempts < job.maxAttempts;
  const updated: FleetJob = {
    ...job,
    status: canRetry ? 'queued' : 'failed',
    finishedAt: canRetry ? job.finishedAt : at,
    lastError: error.trim(),
    history: [
      ...job.history,
      historyEntry(canRetry ? 'retried' : 'failed', at, nodeId, canRetry ? `attempt ${job.attempts}/${job.maxAttempts} failed, requeued.` : `attempt ${job.attempts}/${job.maxAttempts} failed, no retries left.`),
    ],
  };
  return persistJob(fleetRoot, jobs, updated);
}

/** Hủy job đang queued (job running/done không hủy được ở đây). */
export function cancelJob(fleetRoot: string, jobId: string, at = Date.now()): FleetJob {
  const jobs = loadFleetJobs(fleetRoot);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`fleet job "${jobId}" does not exist.`);
  if (job.status !== 'queued') throw new Error(`fleet job "${jobId}" is ${job.status}, only queued jobs can be cancelled.`);
  const updated: FleetJob = {
    ...job,
    status: 'cancelled',
    finishedAt: at,
    history: [...job.history, historyEntry('cancelled', at, job.nodeId ?? undefined)],
  };
  return persistJob(fleetRoot, jobs, updated);
}

/**
 * Đưa job của các node đã chết về queued (chưa gắn node) để dispatch
 * lại. Bao gồm cả job running (node chết giữa chừng — job coi như
 * chưa chạy xong) và job queued đã gắn node chết. Job được requeue
 * giữ nguyên attempts (lần chạy dở không tính là fail — node chết
 * không phải lỗi của job).
 */
export function reassignDeadNodeJobs(
  fleetRoot: string,
  at = Date.now(),
  timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
): FleetJob[] {
  const nodes = loadFleetNodes(fleetRoot);
  const dead = detectDeadNodes(nodes, at, timeoutMs);
  if (dead.length === 0) return [];
  const deadIds = new Set(dead.map((n) => n.id));
  const jobs = loadFleetJobs(fleetRoot);
  const reassigned: FleetJob[] = [];
  for (const job of jobs) {
    if (job.nodeId === null || !deadIds.has(job.nodeId)) continue;
    if (job.status !== 'queued' && job.status !== 'running') continue;
    const updated: FleetJob = {
      ...job,
      status: 'queued',
      nodeId: null,
      dispatchedAt: null,
      startedAt: null,
      history: [...job.history, historyEntry('reassigned', at, undefined, `node "${job.nodeId}" is dead, job requeued for dispatch.`)],
    };
    jobs[jobs.findIndex((j) => j.id === job.id)] = updated;
    reassigned.push(updated);
  }
  if (reassigned.length > 0) saveFleetJobs(fleetRoot, jobs);
  return reassigned;
}

/** Điều kiện work stealing (pure, dễ test). */
export interface StealPolicy {
  /** Node nguồn bị coi là bận khi queuedJobs >= ngưỡng này. */
  queueThreshold: number;
  /** Node nguồn bị coi là bận khi cpuUsedFraction >= ngưỡng này. */
  cpuThreshold: number;
  /** Node lấy chỉ được lấy khi runningJobs + queuedJobs <= ngưỡng này. */
  idleMaxJobs: number;
}

export const DEFAULT_STEAL_POLICY: StealPolicy = {
  queueThreshold: DEFAULT_STEAL_QUEUE_THRESHOLD,
  cpuThreshold: DEFAULT_STEAL_CPU_THRESHOLD,
  idleMaxJobs: DEFAULT_IDLE_JOB_THRESHOLD,
};

/** True khi node nguồn đủ bận để bị lấy việc (theo load nó báo). */
export function isNodeBusyForStealing(node: FleetNode, policy: StealPolicy = DEFAULT_STEAL_POLICY): boolean {
  const load = node.lastLoad;
  if (!load) return false;
  if (load.queuedJobs >= policy.queueThreshold) return true;
  if (load.cpuUsedFraction !== null && load.cpuUsedFraction >= policy.cpuThreshold) return true;
  return false;
}

/** True khi node lấy đủ rảnh để lấy việc (theo load nó báo). */
export function isNodeIdleForStealing(node: FleetNode, policy: StealPolicy = DEFAULT_STEAL_POLICY): boolean {
  const load = node.lastLoad;
  if (!load) return true; // Chưa báo load = chưa có việc gì đo được → coi là rảnh.
  return load.runningJobs + load.queuedJobs <= policy.idleMaxJobs;
}

/**
 * Tìm các job có thể bị lấy: đang queued, đã gắn một node KHÁC node lấy,
 * và node nguồn đang bận (hoặc đã chết). Cũ nhất trước. Pure trên
 * danh sách đã load — caller tự load nodes/jobs rồi gọi.
 */
export function findStealableJobs(
  jobs: FleetJob[],
  nodes: FleetNode[],
  thiefNodeId: string,
  policy: StealPolicy = DEFAULT_STEAL_POLICY,
  now = Date.now(),
): FleetJob[] {
  const thief = nodes.find((n) => n.id === thiefNodeId);
  if (!thief) throw new Error(`thief node "${thiefNodeId}" is not registered.`);
  if (!isNodeIdleForStealing(thief, policy)) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return jobs
    .filter((job) => {
      if (job.status !== 'queued' || job.nodeId === null || job.nodeId === thiefNodeId) return false;
      const source = byId.get(job.nodeId);
      if (!source) return true; // Node nguồn không còn trong registry → job mồ côi, lấy được.
      if (nodeLiveness(source, now) === 'dead') return true;
      return isNodeBusyForStealing(source, policy);
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Work stealing: node rảnh lấy MỘT job đang chờ của node bận/chết.
 * Job được gắn sang node lấy, ghi `stolenFrom` + history 'stolen'.
 * Trả về job đã lấy, hoặc null khi không có job nào lấy được (node lấy
 * không rảnh, không có job bận, hoặc node nguồn chưa đủ bận).
 */
export function stealWork(
  fleetRoot: string,
  thiefNodeId: string,
  policy: StealPolicy = DEFAULT_STEAL_POLICY,
  at = Date.now(),
): FleetJob | null {
  const nodes = loadFleetNodes(fleetRoot);
  const jobs = loadFleetJobs(fleetRoot);
  const stealable = findStealableJobs(jobs, nodes, thiefNodeId, policy, at);
  const target = stealable[0];
  if (!target) return null;
  const updated: FleetJob = {
    ...target,
    nodeId: thiefNodeId,
    stolenFrom: target.nodeId,
    dispatchedAt: at,
    history: [...target.history, historyEntry('stolen', at, thiefNodeId, `stolen from node "${target.nodeId}".`)],
  };
  persistJob(fleetRoot, jobs, updated);
  return updated;
}

/** Tóm tắt dispatch: job theo status + node chết + job mồ côi. */
export interface FleetDispatchSummary {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Job queued đã gắn node chết (cần reassign). */
  strandedOnDeadNodes: number;
  /** Node chết lúc này. */
  deadNodes: number;
  /** Job từng bị steal. */
  stolen: number;
}

export function summarizeDispatch(fleetRoot: string, at = Date.now()): FleetDispatchSummary {
  const jobs = loadFleetJobs(fleetRoot);
  const nodes = loadFleetNodes(fleetRoot);
  const deadIds = new Set(detectDeadNodes(nodes, at).map((n) => n.id));
  const count = (status: FleetJobStatus): number => jobs.filter((j) => j.status === status).length;
  return {
    total: jobs.length,
    queued: count('queued'),
    running: count('running'),
    done: count('done'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    strandedOnDeadNodes: jobs.filter(
      (j) => (j.status === 'queued' || j.status === 'running') && j.nodeId !== null && deadIds.has(j.nodeId),
    ).length,
    deadNodes: deadIds.size,
    stolen: jobs.filter((j) => j.stolenFrom !== null).length,
  };
}
