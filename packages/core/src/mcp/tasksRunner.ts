/**
 * MCP Tasks — runner có retry / timeout / resume (v1.09, Team T3).
 *
 * `tasks.ts` đã có `TaskHandle` (poll + lấy kết quả + huỷ) và
 * `taskStorePersistent.ts` đã persist được task xuống file, nhưng
 * chưa có ai NỐI chúng lại thành một vòng đời hoàn chỉnh ở phía
 * client:
 *   - tạo task -> poll -> xong: nếu poll lỗi mạng thoáng qua thì
 *     retry với backoff, chứ không fail ngay;
 *   - task chạy quá lâu: timeout tổng -> huỷ ở server + fail rõ ràng;
 *   - app restart: task đang `working` lúc crash không mất — runner
 *     đọc lại danh sách task đã lưu và RE-ATTACH (poll `tasks/get`
 *     bằng taskId cũ) thay vì chạy lại từ đầu; task nào server đã
 *     quên thì đánh dấu `orphaned`.
 *   - hàng đợi: tối đa N task chạy song song, task thừa xếp hàng
 *     FIFO, có thể huỷ ngay cả khi còn trong hàng đợi.
 *
 * Runner dùng `TaskHandle`/`createTask` của `tasks.ts` nên tự động
 * đúng cả hai spec version (2025-11-25 và 2026-07-28): 2026 thì
 * `tasks/get` trả luôn kết quả, 2025 thì lấy qua `tasks/result`.
 * Progress event đi qua callback `onProgress` (0..100% khi server
 * báo, kèm message) — renderer vẽ progress bar từ đó.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import {
  createTask,
  isTaskTerminal,
  TaskError,
  TaskHandle,
  type McpTaskSpecVersion,
  type McpTaskTransport,
  type TaskHandleData,
  type TaskStatus,
} from './tasks';

/** Chính sách retry cho một lần chạy task. */
export interface TaskRetryPolicy {
  /** Số lần thử lại tối đa SAU lần đầu (0 = không retry). */
  maxAttempts: number;
  /** Delay cơ sở giữa các lần retry (ms) — backoff nhân 2 mỗi lần. */
  baseDelayMs: number;
  /** Delay tối đa giữa các lần retry (ms). */
  maxDelayMs: number;
  /** Có retry khi poll lỗi transport không (mặc định true). */
  retryOnPollError?: boolean;
  /** Có retry khi task kết thúc `failed` không (mặc định false — failed là kết quả thật). */
  retryOnFailedStatus?: boolean;
}

export const DEFAULT_TASK_RETRY_POLICY: TaskRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  retryOnPollError: true,
  retryOnFailedStatus: false,
};

/** Tính delay backoff (nhân 2, có jitter ±20%, chặn trần). */
export function retryDelayMs(policy: TaskRetryPolicy, attempt: number, random = Math.random): number {
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  const jitter = capped * 0.2 * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/** True khi lỗi này được retry (lỗi transport thoáng qua, không phải lỗi logic). */
export function isRetryableTaskError(error: unknown): boolean {
  if (error instanceof TaskError) {
    const msg = error.message.toLowerCase();
    // Lỗi parse handle / taskId sai / timeout chờ: không retry.
    if (msg.includes('taskid') || msg.includes('không trả task handle') || msg.includes('hết thời gian')) {
      return false;
    }
    // v1.10: task xin input nhưng không có provider (hoặc xin input
    // quá số vòng) là lỗi ngữ nghĩa — retry chỉ tạo lại task rồi lại
    // xin input tiếp, không bao giờ xong. Không retry.
    if (msg.includes('input_required') || msg.includes('đang chờ input') || msg.includes('xin input')) {
      return false;
    }
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('abort') || msg.includes('cancel')) return false;
    return true;
  }
  return false;
}

/** Một progress event mà runner phát ra. */
export interface TaskRunnerProgress {
  taskId: string;
  status: TaskStatus;
  /** 0..100 khi server báo tiến độ, undefined khi không báo. */
  progress?: number;
  message?: string;
  /** Lần thử hiện tại (1 = lần đầu). */
  attempt: number;
  /** Số lần poll đã thực hiện. */
  polls: number;
}

/** Kết quả cuối của một lần chạy task. */
export interface TaskRunnerOutcome {
  taskId: string;
  status: TaskStatus;
  result?: unknown;
  error?: string;
  attempts: number;
  polls: number;
  startedAtMs: number;
  finishedAtMs: number;
  /** True khi kết quả tới từ lần resume (re-attach), không phải tạo mới. */
  resumed: boolean;
}

/** Mô tả một task đã lưu để resume sau restart. */
export interface ResumableTaskDescriptor {
  taskId: string;
  serverName: string;
  method: string;
  label: string;
  specVersion?: McpTaskSpecVersion;
  pollIntervalMs?: number;
  /** Tiến độ cuối đã biết trước khi restart (để UI không nhảy về 0). */
  lastProgress?: number;
  lastMessage?: string;
}

/** Kết quả resume một task. */
export type ResumeTaskResult =
  | { taskId: string; outcome: 'resumed'; handle: TaskHandle }
  | { taskId: string; outcome: 'orphaned'; reason: string }
  | { taskId: string; outcome: 'terminal'; status: TaskStatus };

/** Tuỳ chọn cho TaskRunner. */
export interface TaskRunnerOptions {
  /** Số task chạy song song tối đa (mặc định 3). */
  maxConcurrent?: number;
  /** Chính sách retry mặc định. */
  retry?: TaskRetryPolicy;
  /** Timeout tổng mặc định cho một task (ms, 0 = không giới hạn). */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (event: TaskRunnerProgress) => void;
  onOutcome?: (outcome: TaskRunnerOutcome) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

interface QueuedJob {
  run: () => Promise<TaskRunnerOutcome>;
  resolve: (outcome: TaskRunnerOutcome) => void;
  reject: (err: unknown) => void;
  controller: AbortController;
  taskIdHint?: string;
}

/**
 * Runner cho task dài của MCP server: tạo, poll có retry/timeout,
 * huỷ, xếp hàng, và resume sau restart.
 */
export class McpTaskRunner {
  private readonly maxConcurrent: number;
  private readonly retry: TaskRetryPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly onProgress?: TaskRunnerOptions['onProgress'];
  private readonly onOutcome?: TaskRunnerOptions['onOutcome'];
  private readonly queue: QueuedJob[] = [];
  private running = 0;
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: TaskRunnerOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
    this.retry = { ...DEFAULT_TASK_RETRY_POLICY, ...(options.retry ?? {}) };
    this.defaultTimeoutMs = options.timeoutMs ?? 0;
    this.now = options.now ?? Date.now;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.onProgress = options.onProgress;
    this.onOutcome = options.onOutcome;
  }

  get runningCount(): number {
    return this.running;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Chạy một method dưới dạng task (tạo mới). Trả outcome khi task
   * tới trạng thái cuối (hoặc khi hết retry/timeout). Ném lỗi chỉ
   * khi không tạo được task ngay từ đầu và không retry được.
   *
   * v1.10: `inputProvider` tự trả lời task `input_required` ở backend
   * 2026-07-28 (`tasks/update` rồi poll tiếp, tối đa `maxInputRounds`
   * vòng). Không có provider thì task `input_required` vẫn lỗi như
   * trước; backend 2025-11-25 không có cách gửi input nên luôn lỗi.
   */
  async run(
    transport: McpTaskTransport,
    method: string,
    params: Record<string, unknown>,
    options: {
      label?: string;
      specVersion?: McpTaskSpecVersion;
      pollIntervalMs?: number;
      ttlMs?: number;
      timeoutMs?: number;
      retry?: TaskRetryPolicy;
      signal?: AbortSignal;
      inputProvider?: (task: TaskHandleData) => Promise<unknown>;
      maxInputRounds?: number;
    } = {},
  ): Promise<TaskRunnerOutcome> {
    const job = this.enqueue(async () => this.executeNew(transport, method, params, options), options.signal);
    return job;
  }

  /**
   * Chạy một task ĐÃ TỒN TẠI (resume): re-attach bằng taskId, poll
   * tiếp tới trạng thái cuối. Dùng sau khi app restart.
   */
  async resume(
    transport: McpTaskTransport,
    descriptor: ResumableTaskDescriptor,
    options: {
      timeoutMs?: number;
      retry?: TaskRetryPolicy;
      signal?: AbortSignal;
      inputProvider?: (task: TaskHandleData) => Promise<unknown>;
      maxInputRounds?: number;
    } = {},
  ): Promise<TaskRunnerOutcome> {
    const job = this.enqueue(
      async () => this.executeResume(transport, descriptor, options),
      options.signal,
    );
    return job;
  }

  /**
   * Re-attach một task đã lưu mà KHÔNG chờ tới cuối: chỉ poll một
   * lần để biết trạng thái hiện tại. Trả `orphaned` khi server
   * không còn biết task này (vd đã hết TTL), `terminal` khi task
   * đã kết thúc, `resumed` kèm handle để caller poll tiếp.
   */
  async probeResumable(
    transport: McpTaskTransport,
    descriptor: ResumableTaskDescriptor,
    signal?: AbortSignal,
  ): Promise<ResumeTaskResult> {
    const handle = new TaskHandle(
      transport,
      { taskId: descriptor.taskId, status: 'working', ...(descriptor.pollIntervalMs ? { pollInterval: descriptor.pollIntervalMs } : {}) } as TaskHandleData,
      { specVersion: descriptor.specVersion ?? '2026-07-28', pollIntervalMs: descriptor.pollIntervalMs },
    );
    let data: TaskHandleData;
    try {
      data = await handle.poll(signal);
    } catch (err) {
      return { taskId: descriptor.taskId, outcome: 'orphaned', reason: (err as Error).message };
    }
    if (isTaskTerminal(data.status)) {
      return { taskId: descriptor.taskId, outcome: 'terminal', status: data.status };
    }
    return { taskId: descriptor.taskId, outcome: 'resumed', handle };
  }

  /**
   * Resume HÀNG LOẠT task đã lưu sau restart: probe từng task,
   * task nào còn working thì chạy tiếp tới cuối, task orphaned /
   * terminal thì báo lại để caller dọn store. Trả danh sách outcome
   * (mỗi task một outcome; task orphaned có status 'failed' +
   * error ghi rõ).
   */
  async resumeAll(
    transport: McpTaskTransport,
    descriptors: ResumableTaskDescriptor[],
    options: {
      timeoutMs?: number;
      retry?: TaskRetryPolicy;
      inputProvider?: (task: TaskHandleData) => Promise<unknown>;
      maxInputRounds?: number;
    } = {},
  ): Promise<TaskRunnerOutcome[]> {
    const outcomes: TaskRunnerOutcome[] = [];
    for (const descriptor of descriptors) {
      const probe = await this.probeResumable(transport, descriptor);
      if (probe.outcome === 'orphaned') {
        outcomes.push({
          taskId: descriptor.taskId,
          status: 'failed',
          error: `Task không còn tồn tại ở server sau restart (orphaned): ${probe.reason}`,
          attempts: 0,
          polls: 0,
          startedAtMs: this.now(),
          finishedAtMs: this.now(),
          resumed: true,
        });
        continue;
      }
      if (probe.outcome === 'terminal') {
        outcomes.push({
          taskId: descriptor.taskId,
          status: probe.status,
          attempts: 0,
          polls: 1,
          startedAtMs: this.now(),
          finishedAtMs: this.now(),
          resumed: true,
        });
        continue;
      }
      const outcome = await this.runResumedHandle(probe.handle, descriptor, options);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /** Huỷ một task đang chạy (hoặc đang xếp hàng) theo taskId. */
  cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    const queued = this.queue.findIndex((j) => j.taskIdHint === taskId);
    if (queued >= 0) {
      const [job] = this.queue.splice(queued, 1);
      job.controller.abort();
      return true;
    }
    return false;
  }

  private enqueue(
    run: () => Promise<TaskRunnerOutcome>,
    signal?: AbortSignal,
    taskIdHint?: string,
  ): Promise<TaskRunnerOutcome> {
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return new Promise<TaskRunnerOutcome>((resolve, reject) => {
      const job: QueuedJob = { run, resolve, reject, controller, taskIdHint };
      this.queue.push(job);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.controller.signal.aborted) {
        job.reject(job.controller.signal.reason instanceof Error ? job.controller.signal.reason : new Error('Task đã bị huỷ.'));
        continue;
      }
      this.running += 1;
      void job
        .run()
        .then((outcome) => job.resolve(outcome))
        .catch((err) => job.reject(err))
        .finally(() => {
          this.running -= 1;
          void this.pump();
        });
    }
  }

  private async executeNew(
    transport: McpTaskTransport,
    method: string,
    params: Record<string, unknown>,
    options: {
      specVersion?: McpTaskSpecVersion;
      pollIntervalMs?: number;
      ttlMs?: number;
      timeoutMs?: number;
      retry?: TaskRetryPolicy;
      signal?: AbortSignal;
      inputProvider?: (task: TaskHandleData) => Promise<unknown>;
      maxInputRounds?: number;
    },
  ): Promise<TaskRunnerOutcome> {
    const startedAtMs = this.now();
    const retry = { ...this.retry, ...(options.retry ?? {}) };
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const outerSignal = options.signal;
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort(outerSignal.reason);
      else outerSignal.addEventListener('abort', () => controller.abort(outerSignal.reason), { once: true });
    }
    const deadlineMs = timeoutMs > 0 ? startedAtMs + timeoutMs : 0;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= retry.maxAttempts + 1; attempt++) {
      try {
        const handle = await createTask(transport, method, params, {
          specVersion: options.specVersion,
          pollIntervalMs: options.pollIntervalMs,
          ttlMs: options.ttlMs,
          signal: controller.signal,
        });
        this.controllers.set(handle.taskId, controller);
        try {
          const outcome = await this.waitHandle(handle, { retry, timeoutMs, deadlineMs, controller, startedAtMs, attempt, resumed: false, inputProvider: options.inputProvider, maxInputRounds: options.maxInputRounds });
          if (
            outcome.status === 'failed' &&
            retry.retryOnFailedStatus &&
            attempt <= retry.maxAttempts &&
            !(deadlineMs > 0 && this.now() >= deadlineMs)
          ) {
            await this.sleepFn(retryDelayMs(retry, attempt));
            continue;
          }
          return outcome;
        } finally {
          this.controllers.delete(handle.taskId);
        }
      } catch (err) {
        lastError = err as Error;
        if (controller.signal.aborted) throw lastError;
        const retryable = isRetryableTaskError(err);
        const isTimeout =
          deadlineMs > 0 && this.now() >= deadlineMs;
        if (!retryable || isTimeout || attempt > retry.maxAttempts) throw lastError;
        await this.sleepFn(retryDelayMs(retry, attempt));
      }
    }
    throw lastError ?? new TaskError('Task thất bại không rõ nguyên nhân.');
  }

  private async executeResume(
    transport: McpTaskTransport,
    descriptor: ResumableTaskDescriptor,
    options: {
      timeoutMs?: number;
      retry?: TaskRetryPolicy;
      signal?: AbortSignal;
      inputProvider?: (task: TaskHandleData) => Promise<unknown>;
      maxInputRounds?: number;
    },
  ): Promise<TaskRunnerOutcome> {
    const probe = await this.probeResumable(transport, descriptor, options.signal);
    if (probe.outcome === 'orphaned') {
      throw new TaskError(
        `Task "${descriptor.taskId}" không còn tồn tại ở server (orphaned).`,
        descriptor.taskId,
      );
    }
    if (probe.outcome === 'terminal') {
      return {
        taskId: descriptor.taskId,
        status: probe.status,
        attempts: 1,
        polls: 1,
        startedAtMs: this.now(),
        finishedAtMs: this.now(),
        resumed: true,
      };
    }
    return this.runResumedHandle(probe.handle, descriptor, options);
  }

  private async runResumedHandle(
    handle: TaskHandle,
    descriptor: ResumableTaskDescriptor,
    options: {
      timeoutMs?: number;
      retry?: TaskRetryPolicy;
      signal?: AbortSignal;
      inputProvider?: (task: TaskHandleData) => Promise<unknown>;
      maxInputRounds?: number;
    },
  ): Promise<TaskRunnerOutcome> {
    const startedAtMs = this.now();
    const retry = { ...this.retry, ...(options.retry ?? {}) };
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const outerSignal = options.signal;
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort(outerSignal.reason);
      else outerSignal.addEventListener('abort', () => controller.abort(outerSignal.reason), { once: true });
    }
    const deadlineMs = timeoutMs > 0 ? startedAtMs + timeoutMs : 0;
    this.controllers.set(handle.taskId, controller);
    try {
      return await this.waitHandle(handle, { retry, timeoutMs, deadlineMs, controller, startedAtMs, attempt: 1, resumed: true, inputProvider: options.inputProvider, maxInputRounds: options.maxInputRounds });
    } finally {
      this.controllers.delete(handle.taskId);
    }
  }

  private async waitHandle(
    handle: TaskHandle,
    ctx: {
      retry: TaskRetryPolicy;
      timeoutMs: number;
      deadlineMs: number;
      controller: AbortController;
      startedAtMs: number;
      attempt: number;
      resumed: boolean;
      inputProvider?: (task: TaskHandleData) => Promise<unknown>;
      maxInputRounds?: number;
    },
  ): Promise<TaskRunnerOutcome> {
    let polls = 0;
    let pollRetries = 0;
    let inputRounds = 0;
    let lastProgress: number | undefined;
    let lastMessage: string | undefined;
    let lastData: TaskHandleData | undefined;
    const emit = (status: TaskStatus): void => {
      this.onProgress?.({ taskId: handle.taskId, status, progress: lastProgress, message: lastMessage, attempt: ctx.attempt, polls });
    };
    // Task đã terminal ngay khi tạo (server xong quá nhanh): poll một
    // lần để lấy kết quả (2026: nằm trong tasks/get).
    if (handle.isTerminal) {
      try {
        lastData = await handle.poll(ctx.controller.signal);
        polls += 1;
      } catch {
        // Poll lấy kết quả thất bại: vẫn trả outcome theo status đã có.
      }
    }
    // Runner tự kiểm deadline tổng + retry poll lỗi ở vòng poll thủ
    // công này (thay vì dùng waitForCompletion) để lấy được progress
    // từng lần poll cho UI.
    for (;;) {
      if (ctx.controller.signal.aborted) {
        throw new TaskError(`Task "${handle.taskId}" đã bị huỷ.`, handle.taskId, handle.status);
      }
      if (ctx.deadlineMs > 0 && this.now() >= ctx.deadlineMs) {
        try {
          await handle.cancel();
        } catch {
          // Huỷ ở server thất bại thì vẫn báo timeout ở client.
        }
        return {
          taskId: handle.taskId,
          status: 'failed',
          error: `Task "${handle.taskId}" hết thời gian chờ (${ctx.timeoutMs} ms).`,
          attempts: ctx.attempt,
          polls,
          startedAtMs: ctx.startedAtMs,
          finishedAtMs: this.now(),
          resumed: ctx.resumed,
        };
      }
      if (handle.isTerminal) break;
      let data: TaskHandleData;
      try {
        data = await handle.poll(ctx.controller.signal);
        polls += 1;
        lastData = data;
      } catch (err) {
        if (ctx.controller.signal.aborted) throw err;
        if (
          ctx.retry.retryOnPollError &&
          isRetryableTaskError(err) &&
          pollRetries < ctx.retry.maxAttempts
        ) {
          pollRetries += 1;
          await this.sleepFn(retryDelayMs(ctx.retry, pollRetries));
          continue;
        }
        throw err;
      }
      const raw = data as unknown as Record<string, unknown>;
      if (typeof data.progress === 'number') {
        lastProgress = Math.max(0, Math.min(100, Math.round(data.progress * 100)));
      }
      if (typeof data.progressMessage === 'string') lastMessage = data.progressMessage;
      emit(data.status);
      if (isTaskTerminal(data.status)) break;
      // v1.10: task xin input — backend 2026-07-28 + có inputProvider
      // thì gửi input qua tasks/update rồi poll tiếp; không có provider
      // hoặc backend 2025-11-25 thì lỗi rõ ràng như trước.
      if (data.status === 'input_required') {
        if (handle.specVersion === '2025-11-25') {
          throw new TaskError(
            `Task "${handle.taskId}" đang chờ input nhưng spec 2025-11-25 không có cách gửi input.`,
            handle.taskId,
            data.status,
          );
        }
        if (!ctx.inputProvider) {
          throw new TaskError(
            `Task "${handle.taskId}" đang chờ input (input_required) — ` +
              `cần inputProvider để gửi qua tasks/update.`,
            handle.taskId,
            data.status,
          );
        }
        const maxInputRounds = ctx.maxInputRounds ?? 8;
        if (inputRounds >= maxInputRounds) {
          throw new TaskError(
            `Task "${handle.taskId}": server xin input quá ${maxInputRounds} vòng — dừng để tránh lặp vô hạn.`,
            handle.taskId,
            data.status,
          );
        }
        inputRounds += 1;
        const answer = await ctx.inputProvider(data);
        await handle.sendInput(answer, ctx.controller.signal);
        continue;
      }
      await this.sleepFn(handle.pollIntervalMs);
    }
    // Lấy kết quả cuối: 2026 lấy từ tasks/get cuối cùng, 2025 lấy qua tasks/result.
    let result: unknown;
    if (handle.status === 'completed') {
      if (handle.specVersion === '2026-07-28') {
        result = lastData?.result;
      } else {
        try {
          result = await handle.getResult(ctx.controller.signal);
        } catch (err) {
          throw err;
        }
      }
    }
    const outcome: TaskRunnerOutcome = {
      taskId: handle.taskId,
      status: handle.status,
      ...(result !== undefined ? { result } : {}),
      attempts: ctx.attempt,
      polls,
      startedAtMs: ctx.startedAtMs,
      finishedAtMs: this.now(),
      resumed: ctx.resumed,
    };
    if (handle.status === 'failed') {
      outcome.error = `Task "${handle.taskId}" thất bại ở server.`;
    }
    this.onOutcome?.(outcome);
    return outcome;
  }
}
