/**
 * Job queue v19 — hàng đợi job của fleet: ưu tiên, aging, retry,
 * dead-letter, phân bổ lên node (v1.29, Đội T6).
 *
 * Tầng trên của phân bổ task v14 (`fleetV14` — allocate task lên node
 * theo capacity/label) và drain v17 (di chuyển task đang chạy). V14
 * trả lời "task này chạy ở node nào"; v19 trả lời 6 câu vận hành của
 * HÀNG ĐỢI trước khi task được phân bổ:
 *
 * - ƯU TIÊN + AGING: job có priority 0..9 (9 = cao nhất); trong cùng
 *   priority lấy FIFO theo thời gian tạo. Job chờ quá lâu được TĂNG
 *   priority hiệu dụng theo từng phút (aging) để job thấp không bị
 *   đói (starvation) — priority hiệu dụng bị chặn ở 9.
 * - RETRY + BACKOFF: job fail được xếp lại với backoff lũy thừa
 *   (base * 2^attempt, có trần), kèm jitter cố định từ attempt để
 *   các job fail cùng lúc không retry đồng loạt; quá maxAttempts →
 *   dead-letter.
 * - DEAD-LETTER: job chết (hết retry / validate lỗi / bị hủy khi
 *   đang chạy) vào dead-letter kèm lý do + lần fail cuối; có thể
 *   requeue (reset attempt, về lại hàng đợi) hoặc xóa hẳn.
 * - IDEMPOTENCY: mỗi job có idempotencyKey; enqueue trùng key của
 *   job đang chờ/chạy/retry → trả về job cũ thay vì tạo job mới
 *   (caller retry an toàn).
 * - PHÂN BỔ: chọn node đích cho job đầu hàng đợi: node phải active,
 *   đủ tài nguyên, khớp label, không bị taint chặn (tái dùng
 *   `fleetV17NodeMatchesLabels` / `fleetV17NodeToleratesTask`); trong các
 *   node đủ điều kiện chọn node ít tải nhất (least-loaded); job
 *   không có node phù hợp thì ở lại hàng đợi kèm lý do.
 * - THỐNG KÊ: độ sâu hàng đợi theo trạng thái/priority, thời gian chờ
 *   ước tính (dựa trên throughput gần đây), job hoàn thành/giờ.
 *
 * Module này KHÔNG chạy job thật, KHÔNG spawn process: nó quyết định
 * "job nào chạy tiếp, ở node nào, fail thì retry khi nào" — việc chạy
 * job thật do caller làm.
 */

import type { FleetV14Node, FleetV14Task } from '../fleetV14/fleetV14';
import type { FleetV17Taint, FleetV17Toleration } from '../fleetV17/fleetV17';
import { fleetV17NodeMatchesLabels, fleetV17NodeToleratesTask } from '../fleetV17/fleetV17';

/** Priority của job: 0 (thấp nhất) .. 9 (cao nhất). */
export const FLEET_V19_JOB_PRIORITY_MIN = 0;
export const FLEET_V19_JOB_PRIORITY_MAX = 9;
/** Mỗi phút chờ tăng bao nhiêu priority hiệu dụng (aging). */
export const FLEET_V19_JOB_AGING_PER_MIN = 0.5;
/** Backoff cơ số: base ms * 2^attempt (capped). */
export const FLEET_V19_JOB_RETRY_BASE_MS = 30 * 1000;
/** Backoff tối đa: 30 phút. */
export const FLEET_V19_JOB_RETRY_MAX_MS = 30 * 60 * 1000;
/** Số lần retry mặc định trước khi dead-letter. */
export const FLEET_V19_JOB_DEFAULT_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

/** Trạng thái của một job trong hàng đợi. */
export type FleetV19JobStatus =
  | 'queued' // đang chờ phân bổ
  | 'running' // đang chạy trên node
  | 'retrying' // fail, đang chờ backoff để xếp lại
  | 'done' // hoàn thành
  | 'dead' // dead-letter (hết retry / hủy khi chạy)
  | 'cancelled'; // bị hủy khi còn queued/retrying

export const FLEET_V19_JOB_STATUSES: readonly FleetV19JobStatus[] = [
  'queued',
  'running',
  'retrying',
  'done',
  'dead',
  'cancelled',
];

/** Một job trong hàng đợi fleet. */
export interface FleetV19Job {
  jobId: string;
  /** Task cần chạy (tái dùng kiểu task v14: cpu/ram/label...). */
  task: FleetV14Task;
  /** Priority gốc 0..9 do caller đặt. */
  priority: number;
  /** Key chống trùng ('' = không dùng idempotency). */
  idempotencyKey: string;
  status: FleetV19JobStatus;
  /** Số lần đã thử chạy (0 = chưa chạy lần nào). */
  attempts: number;
  /** Số lần retry tối đa (fail vượt quá → dead). */
  maxAttempts: number;
  /** Node đang chạy job ('' = chưa phân bổ). */
  nodeId: string;
  createdAt: number;
  /** Epoch ms job sẵn sàng chạy lại (dùng cho retrying; 0 = sẵn sàng ngay). */
  readyAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Lý do fail/hủy/chết gần nhất. */
  lastError: string;
  /** Số lần job được requeue từ dead-letter. */
  requeueCount: number;
}

/** Đầu vào tạo job mới (caller chỉ điền phần mô tả, còn lại mặc định). */
export interface FleetV19NewJob {
  jobId: string;
  task: FleetV14Task;
  priority: number;
  idempotencyKey?: string;
  maxAttempts?: number;
}

/** Lỗi validate job mới, '' = hợp lệ. */
export function validateFleetV19NewJob(job: FleetV19NewJob): string {
  if (typeof job.jobId !== 'string' || job.jobId.length === 0) return 'jobId không được rỗng';
  if (typeof job.task !== 'object' || job.task === null) return 'task không được rỗng';
  if (typeof job.task.taskId !== 'string' || job.task.taskId.length === 0) {
    return 'task.taskId không được rỗng';
  }
  if (!Number.isInteger(job.priority) || job.priority < FLEET_V19_JOB_PRIORITY_MIN || job.priority > FLEET_V19_JOB_PRIORITY_MAX) {
    return `priority phải là số nguyên ${FLEET_V19_JOB_PRIORITY_MIN}..${FLEET_V19_JOB_PRIORITY_MAX}`;
  }
  if (job.maxAttempts !== undefined && (!Number.isInteger(job.maxAttempts) || job.maxAttempts < 0)) {
    return 'maxAttempts phải là số nguyên >= 0';
  }
  if (job.task.cpuCores < 0 || job.task.ramMb < 0 || job.task.vramMb < 0) {
    return 'task cpu/ram/vram không được âm';
  }
  return '';
}

/** Hàng đợi job: danh sách job + seq (để UI đếm, không dùng sinh id). */
export interface FleetV19JobQueue {
  jobs: FleetV19Job[];
}

/** Hàng đợi rỗng. */
export function createFleetV19JobQueue(): FleetV19JobQueue {
  return { jobs: [] };
}

/**
 * Priority hiệu dụng tại thời điểm `at`: priority gốc + aging theo
 * phút chờ (từ createdAt, chỉ tính khi job còn queued), chặn ở 9.
 * Job running/retrying/done không aging (chỉ queued mới đói).
 */
export function fleetV19EffectivePriority(job: FleetV19Job, at: number): number {
  if (job.status !== 'queued') return job.priority;
  const waitedMin = Math.max(0, (at - job.createdAt) / 60000);
  return Math.min(
    FLEET_V19_JOB_PRIORITY_MAX,
    job.priority + waitedMin * FLEET_V19_JOB_AGING_PER_MIN,
  );
}

/**
 * Enqueue một job (trả hàng đợi mới, không mutate):
 * - trùng jobId với job đang hoạt động (queued/running/retrying) → throw;
 * - trùng idempotencyKey với job đang hoạt động → trả hàng đợi cũ
 *   (job cũ được giữ, caller retry an toàn);
 * - ngược lại thêm job queued mới (readyAt = createdAt).
 */
export function enqueueFleetV19Job(
  queue: FleetV19JobQueue,
  input: FleetV19NewJob,
  at: number,
): { queue: FleetV19JobQueue; job: FleetV19Job; duplicate: boolean } {
  const err = validateFleetV19NewJob(input);
  if (err !== '') throw new Error(err);
  const active = (j: FleetV19Job): boolean =>
    j.status === 'queued' || j.status === 'running' || j.status === 'retrying';
  const sameId = queue.jobs.find((j) => j.jobId === input.jobId && active(j));
  if (sameId) throw new Error(`jobId đã tồn tại và đang hoạt động: ${input.jobId}`);
  const key = input.idempotencyKey ?? '';
  if (key !== '') {
    const dup = queue.jobs.find((j) => j.idempotencyKey === key && active(j));
    if (dup) return { queue, job: dup, duplicate: true };
  }
  const job: FleetV19Job = {
    jobId: input.jobId,
    task: input.task,
    priority: input.priority,
    idempotencyKey: key,
    status: 'queued',
    attempts: 0,
    maxAttempts: input.maxAttempts ?? FLEET_V19_JOB_DEFAULT_MAX_ATTEMPTS,
    nodeId: '',
    createdAt: at,
    readyAt: at,
    startedAt: null,
    finishedAt: null,
    lastError: '',
    requeueCount: 0,
  };
  return { queue: { jobs: [...queue.jobs, job] }, job, duplicate: false };
}

/** Backoff cho lần retry thứ `attempt` (1-based): base * 2^(attempt-1), chặn ở max, + jitter cố định. */
export function fleetV19RetryBackoffMs(attempt: number): number {
  const base = FLEET_V19_JOB_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(FLEET_V19_JOB_RETRY_MAX_MS, base);
  // Jitter cố định theo attempt (không dùng Math.random để test ổn định):
  // attempt lẻ +10%, chẵn +0% — đủ để các job fail cùng lúc không retry đồng loạt.
  const jitter = attempt % 2 === 1 ? Math.floor(capped * 0.1) : 0;
  return capped + jitter;
}

/**
 * Lấy job tiếp theo cần chạy tại `at`: job queued + readyAt <= at, ưu
 * tiên theo priority hiệu dụng (cao trước), rồi createdAt (cũ trước),
 * rồi jobId (ổn định). Trả null khi hàng đợi trống.
 */
export function peekFleetV19NextJob(
  queue: FleetV19JobQueue,
  at: number,
): FleetV19Job | null {
  const ready = queue.jobs.filter((j) => j.status === 'queued' && j.readyAt <= at);
  if (ready.length === 0) return null;
  const sorted = [...ready].sort((a, b) => {
    const pa = fleetV19EffectivePriority(a, at);
    const pb = fleetV19EffectivePriority(b, at);
    if (pb !== pa) return pb - pa;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
  });
  return sorted[0];
}

/** Đánh dấu job bắt đầu chạy trên node (queued -> running). Không hợp lệ → throw. */
export function startFleetV19Job(
  queue: FleetV19JobQueue,
  jobId: string,
  nodeId: string,
  at: number,
): FleetV19JobQueue {
  const job = queue.jobs.find((j) => j.jobId === jobId);
  if (!job) throw new Error(`không tìm thấy job: ${jobId}`);
  if (job.status !== 'queued') throw new Error(`job ${jobId} không ở trạng thái queued (đang ${job.status})`);
  if (nodeId.length === 0) throw new Error('nodeId không được rỗng');
  return {
    jobs: queue.jobs.map((j) =>
      j.jobId === jobId
        ? { ...j, status: 'running' as const, nodeId, attempts: j.attempts + 1, startedAt: at }
        : j,
    ),
  };
}

/** Đánh dấu job chạy xong (running -> done). */
export function completeFleetV19Job(
  queue: FleetV19JobQueue,
  jobId: string,
  at: number,
): FleetV19JobQueue {
  const job = queue.jobs.find((j) => j.jobId === jobId);
  if (!job) throw new Error(`không tìm thấy job: ${jobId}`);
  if (job.status !== 'running') throw new Error(`job ${jobId} không ở trạng thái running (đang ${job.status})`);
  return {
    jobs: queue.jobs.map((j) =>
      j.jobId === jobId ? { ...j, status: 'done' as const, finishedAt: at } : j,
    ),
  };
}

/**
 * Đánh dấu job fail (running -> retrying hoặc dead):
 * - còn lượt retry (attempts <= maxAttempts) → retrying, readyAt =
 *   at + backoff(attempts), giữ nodeId để UI thấy job fail ở node nào;
 * - hết lượt → dead, finishedAt = at.
 */
export function failFleetV19Job(
  queue: FleetV19JobQueue,
  jobId: string,
  error: string,
  at: number,
): FleetV19JobQueue {
  const job = queue.jobs.find((j) => j.jobId === jobId);
  if (!job) throw new Error(`không tìm thấy job: ${jobId}`);
  if (job.status !== 'running') throw new Error(`job ${jobId} không ở trạng thái running (đang ${job.status})`);
  // attempts đã đếm lần chạy vừa fail (start đã +1): còn lượt khi
  // attempts < maxAttempts; hết lượt (attempts == maxAttempts) → dead.
  const canRetry = job.attempts < job.maxAttempts;
  return {
    jobs: queue.jobs.map((j) => {
      if (j.jobId !== jobId) return j;
      if (canRetry) {
        return {
          ...j,
          status: 'retrying' as const,
          lastError: error,
          readyAt: at + fleetV19RetryBackoffMs(job.attempts),
        };
      }
      return { ...j, status: 'dead' as const, lastError: error, finishedAt: at };
    }),
  };
}

/**
 * Chuyển các job retrying đã hết backoff (readyAt <= at) về queued
 * (trả hàng đợi mới + số job đã chuyển). Job retrying chưa hết backoff
 * ở nguyên.
 */
export function promoteFleetV19Retries(
  queue: FleetV19JobQueue,
  at: number,
): { queue: FleetV19JobQueue; promotedCount: number } {
  let promotedCount = 0;
  const jobs = queue.jobs.map((j) => {
    if (j.status === 'retrying' && j.readyAt <= at) {
      promotedCount++;
      return { ...j, status: 'queued' as const, nodeId: '' };
    }
    return j;
  });
  return { queue: { jobs }, promotedCount };
}

/** Hủy một job đang queued/retrying (queued/retrying -> cancelled). */
export function cancelFleetV19Job(
  queue: FleetV19JobQueue,
  jobId: string,
  reason: string,
  at: number,
): FleetV19JobQueue {
  const job = queue.jobs.find((j) => j.jobId === jobId);
  if (!job) throw new Error(`không tìm thấy job: ${jobId}`);
  if (job.status !== 'queued' && job.status !== 'retrying') {
    throw new Error(`job ${jobId} không hủy được ở trạng thái ${job.status}`);
  }
  return {
    jobs: queue.jobs.map((j) =>
      j.jobId === jobId
        ? { ...j, status: 'cancelled' as const, lastError: reason, finishedAt: at }
        : j,
    ),
  };
}

/** Hủy một job đang chạy (running -> dead, lý do hủy; không retry). */
export function killFleetV19Job(
  queue: FleetV19JobQueue,
  jobId: string,
  reason: string,
  at: number,
): FleetV19JobQueue {
  const job = queue.jobs.find((j) => j.jobId === jobId);
  if (!job) throw new Error(`không tìm thấy job: ${jobId}`);
  if (job.status !== 'running') throw new Error(`job ${jobId} không ở trạng thái running (đang ${job.status})`);
  return {
    jobs: queue.jobs.map((j) =>
      j.jobId === jobId
        ? { ...j, status: 'dead' as const, lastError: reason, finishedAt: at }
        : j,
    ),
  };
}

/** Requeue một job dead (dead -> queued, reset attempts, tăng requeueCount). */
export function requeueFleetV19DeadJob(
  queue: FleetV19JobQueue,
  jobId: string,
  at: number,
): FleetV19JobQueue {
  const job = queue.jobs.find((j) => j.jobId === jobId);
  if (!job) throw new Error(`không tìm thấy job: ${jobId}`);
  if (job.status !== 'dead') throw new Error(`job ${jobId} không ở trạng thái dead (đang ${job.status})`);
  return {
    jobs: queue.jobs.map((j) =>
      j.jobId === jobId
        ? {
            ...j,
            status: 'queued' as const,
            attempts: 0,
            nodeId: '',
            readyAt: at,
            startedAt: null,
            finishedAt: null,
            lastError: '',
            requeueCount: j.requeueCount + 1,
          }
        : j,
    ),
  };
}

/** Xóa hẳn một job đã kết thúc (done/dead/cancelled). Job đang hoạt động → throw. */
export function removeFleetV19Job(queue: FleetV19JobQueue, jobId: string): FleetV19JobQueue {
  const job = queue.jobs.find((j) => j.jobId === jobId);
  if (!job) throw new Error(`không tìm thấy job: ${jobId}`);
  if (job.status === 'queued' || job.status === 'running' || job.status === 'retrying') {
    throw new Error(`job ${jobId} đang hoạt động (${job.status}), không xóa được — hủy trước`);
  }
  return { jobs: queue.jobs.filter((j) => j.jobId !== jobId) };
}

// ---------------------------------------------------------------------------
// Phân bổ job lên node
// ---------------------------------------------------------------------------

/** Node đủ điều kiện chạy job + điểm tải (để xếp hạng). */
export interface FleetV19NodeOffer {
  node: FleetV14Node;
  /** Tải hiện tại 0..1 (task đang chạy / maxTasks, lấy max với cpu/ram). */
  load: number;
  /** Lý do node KHÔNG phù hợp ('' = phù hợp). */
  blockedReason: string;
}

/** Tính tải của node: max(task fraction, cpu fraction, ram fraction). */
export function fleetV19NodeLoad(node: FleetV14Node): number {
  const taskFrac =
    node.capacity.maxTasks > 0 ? node.runningTaskIds.length / node.capacity.maxTasks : 1;
  const cpuFrac =
    node.capacity.cpuCores > 0 ? node.usedCpuCores / node.capacity.cpuCores : 1;
  const ramFrac =
    node.capacity.ramTotalMb > 0 ? node.usedRamMb / node.capacity.ramTotalMb : 1;
  return Math.max(0, Math.min(1, Math.max(taskFrac, cpuFrac, ramFrac)));
}

/**
 * Kiểm tra một node có chạy được task không (trả lý do chặn, '' = được):
 * status phải active, đủ CPU/RAM/VRAM trống, còn slot task, khớp label,
 * toleration khớp taint của node, task cho phép node này (allowedNodeIds).
 */
export function fleetV19NodeBlockedReason(
  node: FleetV14Node,
  task: FleetV14Task,
  nodeTaints: readonly FleetV17Taint[],
  taskTolerations: readonly FleetV17Toleration[],
): string {
  if (node.status !== 'active') return `node ${node.nodeId} không active (đang ${node.status})`;
  if (task.allowedNodeIds.length > 0 && !task.allowedNodeIds.includes(node.nodeId)) {
    return `task không cho phép node ${node.nodeId}`;
  }
  if (!fleetV17NodeMatchesLabels(node.labels, task.requiredLabels)) {
    return `node ${node.nodeId} không khớp label yêu cầu`;
  }
  const toleration = fleetV17NodeToleratesTask(nodeTaints, taskTolerations);
  if (!toleration.allowed) {
    const t = toleration.blockingTaints[0];
    return `node ${node.nodeId} có taint ${t.key}=${t.value}:${t.effect} mà task không toleration`;
  }
  if (node.capacity.maxTasks - node.runningTaskIds.length < 1) {
    return `node ${node.nodeId} hết slot task`;
  }
  const freeCpu = node.capacity.cpuCores - node.usedCpuCores;
  const freeRam = node.capacity.ramTotalMb - node.usedRamMb;
  const freeVram = node.capacity.vramTotalMb - node.usedVramMb;
  if (freeCpu < task.cpuCores) return `node ${node.nodeId} thiếu CPU (${freeCpu} < ${task.cpuCores})`;
  if (freeRam < task.ramMb) return `node ${node.nodeId} thiếu RAM (${freeRam}MB < ${task.ramMb}MB)`;
  if (freeVram < task.vramMb) return `node ${node.nodeId} thiếu VRAM (${freeVram}MB < ${task.vramMb}MB)`;
  return '';
}

/**
 * Chọn node tốt nhất cho job: trong các node phù hợp, chọn node ít tải
 * nhất (load thấp nhất, hòa thì nodeId nhỏ hơn). Trả null + danh sách
 * lý do chặn khi không có node nào phù hợp.
 */
export function pickFleetV19NodeForJob(
  job: FleetV19Job,
  nodes: readonly FleetV14Node[],
  taintsByNode: ReadonlyMap<string, readonly FleetV17Taint[]> | Record<string, readonly FleetV17Taint[]>,
  tolerationsByJob: readonly FleetV17Toleration[],
): { node: FleetV14Node | null; blockedReasons: string[] } {
  const taintsOf = (nodeId: string): readonly FleetV17Taint[] => {
    if (taintsByNode instanceof Map) return taintsByNode.get(nodeId) ?? [];
    return (taintsByNode as Record<string, readonly FleetV17Taint[]>)[nodeId] ?? [];
  };
  const blockedReasons: string[] = [];
  let best: FleetV14Node | null = null;
  let bestLoad = Infinity;
  for (const node of nodes) {
    const reason = fleetV19NodeBlockedReason(node, job.task, taintsOf(node.nodeId), tolerationsByJob);
    if (reason !== '') {
      blockedReasons.push(reason);
      continue;
    }
    const load = fleetV19NodeLoad(node);
    if (load < bestLoad || (load === bestLoad && best !== null && node.nodeId < best.nodeId)) {
      best = node;
      bestLoad = load;
    }
  }
  return { node: best, blockedReasons };
}

// ---------------------------------------------------------------------------
// Thống kê hàng đợi
// ---------------------------------------------------------------------------

/** Thống kê hàng đợi tại một thời điểm. */
export interface FleetV19QueueStats {
  at: number;
  total: number;
  byStatus: Record<FleetV19JobStatus, number>;
  /** Số job queued theo priority gốc (0..9). */
  queuedByPriority: Record<number, number>;
  /** Job queued lâu nhất đã chờ bao nhiêu ms (null = không có job queued). */
  oldestWaitMs: number | null;
  /** Thời gian chờ trung bình của job queued (ms, null = không có). */
  avgWaitMs: number | null;
  /** Số job hoàn thành trong 1 giờ gần nhất (dựa finishedAt). */
  doneLastHour: number;
  /** Ước tính thời gian chờ cho job mới priority 5 (ms, null = không ước tính được). */
  estimatedWaitMs: number | null;
}

/**
 * Tính thống kê hàng đợi. estimatedWaitMs: nếu có job done trong giờ
 * qua, lấy throughput (job/giờ) → thời gian xử lý hết số job queued
 * trước job mới; không có dữ liệu throughput → null (UI hiển thị
 * "chưa đủ dữ liệu" thay vì đoán mò).
 */
export function summarizeFleetV19Queue(queue: FleetV19JobQueue, at: number): FleetV19QueueStats {
  const byStatus: Record<FleetV19JobStatus, number> = {
    queued: 0,
    running: 0,
    retrying: 0,
    done: 0,
    dead: 0,
    cancelled: 0,
  };
  const queuedByPriority: Record<number, number> = {};
  for (let p = FLEET_V19_JOB_PRIORITY_MIN; p <= FLEET_V19_JOB_PRIORITY_MAX; p++) {
    queuedByPriority[p] = 0;
  }
  let oldestWaitMs: number | null = null;
  let waitSum = 0;
  let queuedCount = 0;
  let doneLastHour = 0;
  for (const job of queue.jobs) {
    byStatus[job.status]++;
    if (job.status === 'queued') {
      queuedByPriority[job.priority]++;
      const wait = at - job.createdAt;
      waitSum += wait;
      queuedCount++;
      if (oldestWaitMs === null || wait > oldestWaitMs) oldestWaitMs = wait;
    }
    if (job.status === 'done' && job.finishedAt !== null && at - job.finishedAt <= 60 * 60 * 1000) {
      doneLastHour++;
    }
  }
  const estimatedWaitMs =
    doneLastHour > 0 && queuedCount > 0
      ? Math.round((queuedCount / doneLastHour) * 60 * 60 * 1000)
      : null;
  return {
    at,
    total: queue.jobs.length,
    byStatus,
    queuedByPriority,
    oldestWaitMs,
    avgWaitMs: queuedCount === 0 ? null : Math.round(waitSum / queuedCount),
    doneLastHour,
    estimatedWaitMs,
  };
}

/** Liệt kê job dead-letter (kèm lý do), mới chết trước. */
export function listFleetV19DeadJobs(queue: FleetV19JobQueue): FleetV19Job[] {
  return queue.jobs
    .filter((j) => j.status === 'dead')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
}
