/**
 * Composio long jobs v1.29 (v1.29, Doi T4 — Composio v6).
 *
 * Job chay nen (background long job) cho Composio: agent submit mot
 * cong viec dai (vd dong bo hang tram item qua mot toolkit) roi quay
 * lai ngay — khong block agent turn. Ket qua lay sau bang poll:
 * submit -> job id -> poll trang thai (pending/running/done/failed/
 * cancelled/timed-out) -> ket qua.
 *
 * Thiet ke:
 * - Ham thuan + store trong bo nho: moi chuyen trang thai la mot ham
 *   tra job moi (khong mutate job cu), de test + checkpoint de dang.
 * - Mock runner xac dinh: moi tick poll chay them mot step (stepFn do
 *   caller dua — tools layer dua mock executor v129; host live dua
 *   fetch that sau nay). KHONG goi mang, KHONG can key trong file nay.
 * - Timeout tuyet doi (timeoutAtMs): job qua han ma chua xong thi
 *   chuyen sang 'timed-out' o lan poll/kiem tra ke tiep, khong chay
 *   mai. Cancel la hop tac: cancelRequested duoc ghi ngay, job dung
 *   o step ke tiep (khong cat ngang giua step).
 * - Ket qua step duoc giu lai (stepResults) + tong hop thanh result
 *   cuoi khi done, de agent doc duoc tien trinh ma khong can goi them.
 * - Checkpoint JSON co version — de host luu/tai job qua restart
 *   (store file do host tu nap, xem serialize/parse o day).
 */

import { mockComposioV129ToolNeedsApproval } from './toolkitsV129';

/** Trang thai cua mot long job. */
export type ComposioV129JobStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

/** Trang thai ket thuc (khong chay them step nao nua). */
export const COMPOSIO_V129_TERMINAL_JOB_STATUSES: readonly ComposioV129JobStatus[] = [
  'done',
  'failed',
  'cancelled',
  'timed-out',
] as const;

export function isComposioV129TerminalJobStatus(status: ComposioV129JobStatus): boolean {
  return (COMPOSIO_V129_TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

/** Version checkpoint JSON cua long job v129. */
export const COMPOSIO_V129_JOB_CHECKPOINT_VERSION = 1;

/** Cau hinh mac dinh cho long job v129. */
export const DEFAULT_COMPOSIO_V129_JOB_CONFIG = {
  /** Timeout mac dinh cua mot job: 10 phut. */
  defaultTimeoutMs: 10 * 60 * 1000,
  /** Timeout toi da cho phep: 1 gio. */
  maxTimeoutMs: 60 * 60 * 1000,
  /** So step toi da cua mot job. */
  maxTotalSteps: 1000,
  /** So step toi thieu. */
  minTotalSteps: 1,
  /** Do dai toi da cua args JSON (ky tu) — chong job mang payload khung. */
  maxArgsChars: 20000,
  /** So step result giu lai toi da (step cu nhat bi cat khi vuot). */
  maxKeptStepResults: 200,
} as const;

export interface ComposioV129JobConfig {
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxTotalSteps?: number;
  minTotalSteps?: number;
  maxArgsChars?: number;
  maxKeptStepResults?: number;
}

export function resolveComposioV129JobConfig(
  config: ComposioV129JobConfig = {},
): Required<ComposioV129JobConfig> {
  return {
    defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_COMPOSIO_V129_JOB_CONFIG.defaultTimeoutMs,
    maxTimeoutMs: config.maxTimeoutMs ?? DEFAULT_COMPOSIO_V129_JOB_CONFIG.maxTimeoutMs,
    maxTotalSteps: config.maxTotalSteps ?? DEFAULT_COMPOSIO_V129_JOB_CONFIG.maxTotalSteps,
    minTotalSteps: config.minTotalSteps ?? DEFAULT_COMPOSIO_V129_JOB_CONFIG.minTotalSteps,
    maxArgsChars: config.maxArgsChars ?? DEFAULT_COMPOSIO_V129_JOB_CONFIG.maxArgsChars,
    maxKeptStepResults:
      config.maxKeptStepResults ?? DEFAULT_COMPOSIO_V129_JOB_CONFIG.maxKeptStepResults,
  };
}

export function validateComposioV129JobConfig(config: ComposioV129JobConfig): string[] {
  const errors: string[] = [];
  const resolved = resolveComposioV129JobConfig(config);
  if (!Number.isFinite(resolved.defaultTimeoutMs) || resolved.defaultTimeoutMs <= 0) {
    errors.push('defaultTimeoutMs must be a positive number');
  }
  if (!Number.isFinite(resolved.maxTimeoutMs) || resolved.maxTimeoutMs <= 0) {
    errors.push('maxTimeoutMs must be a positive number');
  }
  if (resolved.defaultTimeoutMs > resolved.maxTimeoutMs) {
    errors.push('defaultTimeoutMs must not exceed maxTimeoutMs');
  }
  if (!Number.isInteger(resolved.maxTotalSteps) || resolved.maxTotalSteps < 1) {
    errors.push('maxTotalSteps must be an integer >= 1');
  }
  if (!Number.isInteger(resolved.minTotalSteps) || resolved.minTotalSteps < 1) {
    errors.push('minTotalSteps must be an integer >= 1');
  }
  if (resolved.minTotalSteps > resolved.maxTotalSteps) {
    errors.push('minTotalSteps must not exceed maxTotalSteps');
  }
  if (!Number.isInteger(resolved.maxArgsChars) || resolved.maxArgsChars < 1) {
    errors.push('maxArgsChars must be an integer >= 1');
  }
  if (!Number.isInteger(resolved.maxKeptStepResults) || resolved.maxKeptStepResults < 1) {
    errors.push('maxKeptStepResults must be an integer >= 1');
  }
  return errors;
}

/** Mot long job Composio v129. */
export interface ComposioV129LongJob {
  /** Id duy nhat, vd 'job-v129-<hash>'. */
  id: string;
  /** Toolkit Composio (live hoac mock v129), vd 'smartsheet'. */
  toolkit: string;
  /** Slug tool Composio, vd 'SMARTSHEET_LIST_ROWS'. */
  slug: string;
  /** Args goi tool (da cat theo maxArgsChars luc tao). */
  args: Record<string, unknown>;
  /** Conversation so huu job (de sandbox v129 gioi han theo conversation). */
  conversationId?: string;
  /** Trang thai hien tai. */
  status: ComposioV129JobStatus;
  /** Tong so step du kien. */
  totalSteps: number;
  /** So step da chay xong. */
  stepsDone: number;
  /** Ket qua tung step (cat o maxKeptStepResults — step cu nhat mat truoc). */
  stepResults: unknown[];
  /** Ket qua tong hop khi done (null khi chua xong). */
  result: unknown;
  /** Loi khi failed/timed-out (null khi khong loi). */
  error: string | null;
  /** Epoch ms luc tao. */
  createdAtMs: number;
  /** Epoch ms luc cap nhat cuoi. */
  updatedAtMs: number;
  /** Epoch ms luc chay step dau tien (undefined khi chua chay). */
  startedAtMs?: number;
  /** Epoch ms luc ket thuc (done/failed/cancelled/timed-out). */
  finishedAtMs?: number;
  /** Epoch ms het han tuyet doi — qua moc nay thi timed-out. */
  timeoutAtMs: number;
  /** So lan da poll. */
  pollCount: number;
  /** Epoch ms poll ke tiep nen dien ra (do polling policy tinh). */
  nextPollAtMs?: number;
  /** Cancel da duoc yeu cau (job se dung o step ke tiep). */
  cancelRequested: boolean;
  /** Ghi chu: job co can approval (tool ghi) khong. */
  needsApproval: boolean;
  /** Ly do cancel (khi cancelRequested = true). */
  cancelReason?: string;
}

/** Input tao job moi. */
export interface ComposioV129CreateJobInput {
  toolkit: string;
  slug: string;
  args?: Record<string, unknown>;
  conversationId?: string;
  /** Tong so step (mac dinh 1). */
  totalSteps?: number;
  /** Timeout rieng (ms); mac dinh defaultTimeoutMs. */
  timeoutMs?: number;
  /** Id tu chon (de test/dedupe); mac dinh sinh tu seed. */
  id?: string;
}

/** Id xac dinh (deterministic) tu mot seed — de test + dedupe. */
export function composioV129JobId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `job-v129-${hash.toString(36)}`;
}

/** true khi slug la tool ghi (can approval) — theo luat dong tu ghi. */
export function composioV129JobNeedsApproval(slug: string): boolean {
  return mockComposioV129ToolNeedsApproval(slug);
}

function validateCreateInput(
  input: ComposioV129CreateJobInput,
  config: Required<ComposioV129JobConfig>,
): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    errors.push('job input must be an object');
    return errors;
  }
  if (typeof input.toolkit !== 'string' || input.toolkit.trim() === '') {
    errors.push('toolkit must be a non-empty string');
  }
  if (typeof input.slug !== 'string' || input.slug.trim() === '') {
    errors.push('slug must be a non-empty string');
  }
  if (input.args !== undefined && (typeof input.args !== 'object' || input.args === null || Array.isArray(input.args))) {
    errors.push('args must be an object');
  }
  const argsChars = input.args ? JSON.stringify(input.args).length : 0;
  if (argsChars > config.maxArgsChars) {
    errors.push(`args too large: ${argsChars} chars > max ${config.maxArgsChars}`);
  }
  const totalSteps = input.totalSteps ?? 1;
  if (!Number.isInteger(totalSteps) || totalSteps < config.minTotalSteps || totalSteps > config.maxTotalSteps) {
    errors.push(`totalSteps must be an integer in [${config.minTotalSteps}, ${config.maxTotalSteps}]`);
  }
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > config.maxTimeoutMs)) {
    errors.push(`timeoutMs must be a positive number <= ${config.maxTimeoutMs}`);
  }
  if (input.conversationId !== undefined && (typeof input.conversationId !== 'string' || input.conversationId.trim() === '')) {
    errors.push('conversationId must be a non-empty string when given');
  }
  if (input.id !== undefined && (typeof input.id !== 'string' || input.id.trim() === '')) {
    errors.push('id must be a non-empty string when given');
  }
  return errors;
}

/**
 * Tao mot long job moi o trang thai 'pending'. Throw khi input
 * khong hop le (toolkit/slug rong, totalSteps ngoai khoang, args
 * qua lon, timeout vuot max). Job chua chay step nao — chay bang
 * `advanceComposioV129Job` o moi tick poll.
 */
export function createComposioV129Job(
  input: ComposioV129CreateJobInput,
  nowMs: number,
  config: ComposioV129JobConfig = {},
): ComposioV129LongJob {
  const resolved = resolveComposioV129JobConfig(config);
  const errors = validateCreateInput(input, resolved);
  if (errors.length > 0) throw new Error(`Invalid Composio v129 job: ${errors.join('; ')}`);
  const totalSteps = input.totalSteps ?? 1;
  const timeoutMs = input.timeoutMs ?? resolved.defaultTimeoutMs;
  const id =
    input.id ?? composioV129JobId(`${input.toolkit}:${input.slug}:${nowMs}:${totalSteps}`);
  return {
    id,
    toolkit: input.toolkit,
    slug: input.slug,
    args: { ...(input.args ?? {}) },
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    status: 'pending',
    totalSteps,
    stepsDone: 0,
    stepResults: [],
    result: null,
    error: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    timeoutAtMs: nowMs + timeoutMs,
    pollCount: 0,
    cancelRequested: false,
    needsApproval: composioV129JobNeedsApproval(input.slug),
  };
}

/** Kiem tra timeout: job chua ket thuc ma qua timeoutAtMs thi timed-out. */
export function checkComposioV129JobTimeout(
  job: ComposioV129LongJob,
  nowMs: number,
): ComposioV129LongJob {
  if (isComposioV129TerminalJobStatus(job.status)) return job;
  if (nowMs <= job.timeoutAtMs) return job;
  return {
    ...job,
    status: 'timed-out',
    error: `Job timed out after ${job.timeoutAtMs - job.createdAtMs}ms (created ${job.createdAtMs}, deadline ${job.timeoutAtMs}, now ${nowMs}).`,
    updatedAtMs: nowMs,
    finishedAtMs: nowMs,
  };
}

/**
 * Yeu cau cancel mot job. Job terminal thi khong doi (tra
 * cancelled: false). Job pending/running thi ghi cancelRequested —
 * step ke tiep se dung lai (xem advanceComposioV129Job).
 */
export function requestComposioV129JobCancel(
  job: ComposioV129LongJob,
  nowMs: number,
  reason = 'cancelled by user',
): { job: ComposioV129LongJob; cancelled: boolean } {
  if (isComposioV129TerminalJobStatus(job.status)) return { job, cancelled: false };
  return {
    job: { ...job, cancelRequested: true, cancelReason: reason, updatedAtMs: nowMs },
    cancelled: true,
  };
}

/** Ham chay mot step: nhan job + chi so step (0-based), tra ket qua step. */
export type ComposioV129StepFn = (job: ComposioV129LongJob, stepIndex: number) => unknown;

/** Ket qua mot tick advance. */
export interface ComposioV129AdvanceResult {
  job: ComposioV129LongJob;
  /** true khi co step duoc chay o tick nay. */
  advanced: boolean;
  /** true khi job vua chuyen sang trang thai ket thuc o tick nay. */
  finished: boolean;
  /** Ly do khong chay step (khi advanced = false). */
  reason?: string;
}

/**
 * Chay them mot step cua job (mot tick poll = toi da mot step).
 *
 * - Job terminal: khong chay, tra lai nguyen ven.
 * - Job qua timeout: chuyen 'timed-out', khong chay step.
 * - cancelRequested: chuyen 'cancelled', khong chay step nua.
 * - pending -> running (ghi startedAtMs), chay step, tang stepsDone;
 *   het step (stepsDone >= totalSteps) thi 'done' + result tong hop.
 * - stepFn throw: job 'failed' + error = message cua loi.
 *
 * Luu y: ham nay KHONG doi (khong sleep, khong cho) — agent goi
 * xong tra ket qua ngay, turn khong bi block.
 */
export function advanceComposioV129Job(
  job: ComposioV129LongJob,
  nowMs: number,
  stepFn: ComposioV129StepFn,
  config: ComposioV129JobConfig = {},
): ComposioV129AdvanceResult {
  const resolved = resolveComposioV129JobConfig(config);
  if (isComposioV129TerminalJobStatus(job.status)) {
    return { job, advanced: false, finished: false, reason: `job already ${job.status}` };
  }
  const timedOut = checkComposioV129JobTimeout(job, nowMs);
  if (timedOut.status === 'timed-out') {
    return { job: timedOut, advanced: false, finished: true, reason: 'job timed out' };
  }
  if (job.cancelRequested) {
    const cancelled: ComposioV129LongJob = {
      ...job,
      status: 'cancelled',
      error: job.cancelReason ?? 'cancelled',
      updatedAtMs: nowMs,
      finishedAtMs: nowMs,
    };
    return { job: cancelled, advanced: false, finished: true, reason: 'cancel requested' };
  }
  const stepIndex = job.stepsDone;
  let stepResult: unknown;
  try {
    stepResult = stepFn(job, stepIndex);
  } catch (err) {
    const failed: ComposioV129LongJob = {
      ...job,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      updatedAtMs: nowMs,
      finishedAtMs: nowMs,
    };
    return { job: failed, advanced: false, finished: true, reason: 'step threw' };
  }
  const kept = [...job.stepResults, stepResult];
  const stepResults =
    kept.length > resolved.maxKeptStepResults
      ? kept.slice(kept.length - resolved.maxKeptStepResults)
      : kept;
  const stepsDone = job.stepsDone + 1;
  const done = stepsDone >= job.totalSteps;
  const next: ComposioV129LongJob = {
    ...job,
    status: done ? 'done' : 'running',
    stepsDone,
    stepResults,
    result: done
      ? {
          toolkit: job.toolkit,
          slug: job.slug,
          steps: stepResults,
          stepsDone,
          totalSteps: job.totalSteps,
        }
      : null,
    startedAtMs: job.startedAtMs ?? nowMs,
    updatedAtMs: nowMs,
    ...(done ? { finishedAtMs: nowMs } : {}),
  };
  return { job: next, advanced: true, finished: done };
}

/** Danh dau job failed voi mot loi (vd fetch that loi, khong phai stepFn). */
export function failComposioV129Job(
  job: ComposioV129LongJob,
  error: string,
  nowMs: number,
): ComposioV129LongJob {
  if (isComposioV129TerminalJobStatus(job.status)) return job;
  return { ...job, status: 'failed', error, updatedAtMs: nowMs, finishedAtMs: nowMs };
}

/** Tien trinh 0..1 cua job (done = 1). */
export function composioV129JobProgress(job: ComposioV129LongJob): number {
  if (job.totalSteps <= 0) return 0;
  return Math.min(1, job.stepsDone / job.totalSteps);
}

/** Thoi gian job da chay (ms) — tu createdAtMs toi finishedAtMs/now. */
export function composioV129JobElapsedMs(job: ComposioV129LongJob, nowMs: number): number {
  return (job.finishedAtMs ?? nowMs) - job.createdAtMs;
}

/** Thoi gian con lai toi timeout (ms, am = da qua han). */
export function composioV129JobTimeLeftMs(job: ComposioV129LongJob, nowMs: number): number {
  return job.timeoutAtMs - nowMs;
}

/** Bo loc khi liet ke job. */
export interface ComposioV129JobFilter {
  status?: ComposioV129JobStatus;
  conversationId?: string;
  toolkit?: string;
  slug?: string;
  /** Chi job chua ket thuc. */
  activeOnly?: boolean;
}

/** Loc danh sach job theo filter (khong doi thu tu). */
export function listComposioV129Jobs(
  jobs: readonly ComposioV129LongJob[],
  filter: ComposioV129JobFilter = {},
): ComposioV129LongJob[] {
  return jobs.filter((job) => {
    if (filter.status && job.status !== filter.status) return false;
    if (filter.conversationId && job.conversationId !== filter.conversationId) return false;
    if (filter.toolkit && job.toolkit !== filter.toolkit) return false;
    if (filter.slug && job.slug !== filter.slug) return false;
    if (filter.activeOnly && isComposioV129TerminalJobStatus(job.status)) return false;
    return true;
  });
}

/** Tom tat mot job cho UI/agent (khong kem stepResults day du). */
export function summarizeComposioV129Job(
  job: ComposioV129LongJob,
  nowMs: number,
): Record<string, unknown> {
  return {
    id: job.id,
    toolkit: job.toolkit,
    slug: job.slug,
    ...(job.conversationId ? { conversationId: job.conversationId } : {}),
    status: job.status,
    progress: composioV129JobProgress(job),
    stepsDone: job.stepsDone,
    totalSteps: job.totalSteps,
    pollCount: job.pollCount,
    elapsedMs: composioV129JobElapsedMs(job, nowMs),
    timeLeftMs: composioV129JobTimeLeftMs(job, nowMs),
    needsApproval: job.needsApproval,
    cancelRequested: job.cancelRequested,
    ...(job.error ? { error: job.error } : {}),
    ...(job.result !== null ? { hasResult: true } : {}),
    ...(job.nextPollAtMs !== undefined ? { nextPollAtMs: job.nextPollAtMs } : {}),
  };
}

/** Thong ke tap job. */
export function summarizeComposioV129Jobs(
  jobs: readonly ComposioV129LongJob[],
  nowMs: number,
): {
  total: number;
  byStatus: Record<ComposioV129JobStatus, number>;
  active: number;
  done: number;
  failed: number;
  oldestActiveAgeMs: number | null;
  avgProgressActive: number | null;
} {
  const byStatus: Record<ComposioV129JobStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    'timed-out': 0,
  };
  let active = 0;
  let oldestActiveAgeMs: number | null = null;
  let progressSum = 0;
  for (const job of jobs) {
    byStatus[job.status] += 1;
    if (!isComposioV129TerminalJobStatus(job.status)) {
      active += 1;
      const age = nowMs - job.createdAtMs;
      if (oldestActiveAgeMs === null || age > oldestActiveAgeMs) oldestActiveAgeMs = age;
      progressSum += composioV129JobProgress(job);
    }
  }
  return {
    total: jobs.length,
    byStatus,
    active,
    done: byStatus['done'],
    failed: byStatus['failed'] + byStatus['timed-out'],
    oldestActiveAgeMs,
    avgProgressActive: active > 0 ? progressSum / active : null,
  };
}

/** Validate mot job da tai (checkpoint) — tra danh sach loi, rong = hop le. */
export function validateComposioV129Job(job: unknown): string[] {
  const errors: string[] = [];
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    errors.push('job must be an object');
    return errors;
  }
  const j = job as Record<string, unknown>;
  if (typeof j['id'] !== 'string' || (j['id'] as string).trim() === '') errors.push('id must be a non-empty string');
  if (typeof j['toolkit'] !== 'string' || (j['toolkit'] as string).trim() === '') errors.push('toolkit must be a non-empty string');
  if (typeof j['slug'] !== 'string' || (j['slug'] as string).trim() === '') errors.push('slug must be a non-empty string');
  if (typeof j['args'] !== 'object' || j['args'] === null || Array.isArray(j['args'])) errors.push('args must be an object');
  if (!isComposioV129TerminalJobStatus(j['status'] as ComposioV129JobStatus) && j['status'] !== 'pending' && j['status'] !== 'running') {
    errors.push(`status must be a ComposioV129JobStatus, got ${String(j['status'])}`);
  }
  if (!Number.isInteger(j['totalSteps']) || (j['totalSteps'] as number) < 1) errors.push('totalSteps must be an integer >= 1');
  if (!Number.isInteger(j['stepsDone']) || (j['stepsDone'] as number) < 0) errors.push('stepsDone must be an integer >= 0');
  if (typeof j['stepsDone'] === 'number' && typeof j['totalSteps'] === 'number' && (j['stepsDone'] as number) > (j['totalSteps'] as number)) {
    errors.push('stepsDone must not exceed totalSteps');
  }
  if (!Array.isArray(j['stepResults'])) errors.push('stepResults must be an array');
  if (typeof j['createdAtMs'] !== 'number' || !Number.isFinite(j['createdAtMs'] as number)) errors.push('createdAtMs must be a finite number');
  if (typeof j['updatedAtMs'] !== 'number' || !Number.isFinite(j['updatedAtMs'] as number)) errors.push('updatedAtMs must be a finite number');
  if (typeof j['timeoutAtMs'] !== 'number' || !Number.isFinite(j['timeoutAtMs'] as number)) errors.push('timeoutAtMs must be a finite number');
  if (!Number.isInteger(j['pollCount']) || (j['pollCount'] as number) < 0) errors.push('pollCount must be an integer >= 0');
  if (typeof j['cancelRequested'] !== 'boolean') errors.push('cancelRequested must be a boolean');
  if (typeof j['needsApproval'] !== 'boolean') errors.push('needsApproval must be a boolean');
  return errors;
}

/** Serialize mot job thanh checkpoint JSON (co version). */
export function serializeComposioV129Job(job: ComposioV129LongJob): string {
  return JSON.stringify({ version: COMPOSIO_V129_JOB_CHECKPOINT_VERSION, job });
}

/** Parse checkpoint JSON thanh job; throw khi version la hoac job khong hop le. */
export function parseComposioV129Job(text: string): ComposioV129LongJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid Composio v129 job checkpoint: not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Composio v129 job checkpoint: expected an object');
  }
  const { version, job } = parsed as { version?: unknown; job?: unknown };
  if (version !== COMPOSIO_V129_JOB_CHECKPOINT_VERSION) {
    throw new Error(
      `Unsupported Composio v129 job checkpoint version: ${String(version)} (expected ${COMPOSIO_V129_JOB_CHECKPOINT_VERSION})`,
    );
  }
  const errors = validateComposioV129Job(job);
  if (errors.length > 0) throw new Error(`Invalid Composio v129 job: ${errors.join('; ')}`);
  return job as ComposioV129LongJob;
}

// ---------------------------------------------------------------------------
// Store trong bo nho — host giu mot instance dung chung trong session
// ---------------------------------------------------------------------------

/**
 * Store job trong bo nho. Moi thao tac tra ban sao moi cua job (ham
 * thuan o tren) nen caller khong bao gio mutate job trong store vo
 * tinh. Host co the serialize toan bo store qua `snapshot()` de luu
 * file, roi tai lai bang `restore()`.
 */
export class MemoryComposioV129JobStore {
  private readonly jobs = new Map<string, ComposioV129LongJob>();

  submit(input: ComposioV129CreateJobInput, nowMs: number, config: ComposioV129JobConfig = {}): ComposioV129LongJob {
    const job = createComposioV129Job(input, nowMs, config);
    if (this.jobs.has(job.id)) {
      throw new Error(`Composio v129 job id already exists: ${job.id}`);
    }
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): ComposioV129LongJob | undefined {
    return this.jobs.get(id);
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  /** Ghi de job (sau advance/cancel/timeout) — throw khi job chua co. */
  save(job: ComposioV129LongJob): void {
    if (!this.jobs.has(job.id)) throw new Error(`Unknown Composio v129 job: ${job.id}`);
    this.jobs.set(job.id, job);
  }

  list(filter: ComposioV129JobFilter = {}): ComposioV129LongJob[] {
    return listComposioV129Jobs([...this.jobs.values()], filter);
  }

  size(): number {
    return this.jobs.size;
  }

  /** Xoa job terminal (de don store); tra true khi xoa duoc. */
  removeTerminal(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || !isComposioV129TerminalJobStatus(job.status)) return false;
    return this.jobs.delete(id);
  }

  /** Xoa het job terminal; tra so job da xoa. */
  pruneTerminal(): number {
    let removed = 0;
    for (const [id, job] of [...this.jobs.entries()]) {
      if (isComposioV129TerminalJobStatus(job.status) && this.jobs.delete(id)) removed += 1;
    }
    return removed;
  }

  summary(nowMs: number): ReturnType<typeof summarizeComposioV129Jobs> {
    return summarizeComposioV129Jobs([...this.jobs.values()], nowMs);
  }

  /** Snapshot toan bo store (JSON) — de host luu file. */
  snapshot(): string {
    return JSON.stringify({
      version: COMPOSIO_V129_JOB_CHECKPOINT_VERSION,
      jobs: [...this.jobs.values()],
    });
  }

  /** Tai snapshot (thay the toan bo store) — throw khi snapshot loi. */
  restore(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Invalid Composio v129 job store snapshot: not JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid Composio v129 job store snapshot: expected an object');
    }
    const { version, jobs } = parsed as { version?: unknown; jobs?: unknown };
    if (version !== COMPOSIO_V129_JOB_CHECKPOINT_VERSION) {
      throw new Error(`Unsupported Composio v129 job store version: ${String(version)}`);
    }
    if (!Array.isArray(jobs)) throw new Error('Invalid Composio v129 job store snapshot: jobs must be an array');
    const next = new Map<string, ComposioV129LongJob>();
    for (const job of jobs) {
      const errors = validateComposioV129Job(job);
      if (errors.length > 0) throw new Error(`Invalid Composio v129 job in snapshot: ${errors.join('; ')}`);
      const typed = job as ComposioV129LongJob;
      if (next.has(typed.id)) throw new Error(`Duplicate Composio v129 job id in snapshot: ${typed.id}`);
      next.set(typed.id, typed);
    }
    this.jobs.clear();
    for (const [id, job] of next) this.jobs.set(id, job);
  }
}
