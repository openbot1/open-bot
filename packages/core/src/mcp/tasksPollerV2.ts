/**
 * MCP Tasks — poller đúng chuẩn 2026-07-28 (v1.14, Đội T2).
 *
 * Spec 2026-07-28 thay `tasks/result` chặn bằng polling: server trả task
 * handle, client poll `tasks/get` (long-polling — server giữ request tới
 * `timeoutMs` rồi trả trạng thái mới nhất), gửi input giữa chừng bằng
 * `tasks/update`, huỷ bằng `tasks/cancel`. `tasks/list` không còn tồn tại.
 *
 * `TaskHandle` (`tasks.ts`) và `McpTaskRunner` (`tasksRunner.ts`) đã có
 * adapter 2026 + hàng đợi/retry; module này là poller ở tầng WIRE —
 * một client protocol thuần cho extension 2026, không hàng đợi, không
 * retry ẩn, để UI / tool / runner gọi trực tiếp và kiểm thử được bằng
 * fake transport:
 *
 *   - `pollOnce(taskId, { timeoutMs })` — một lần `tasks/get` (long-poll).
 *   - `waitForCompletion(taskId, opts)` — vòng poll tới trạng thái cuối,
 *     kèm deadline, backoff, progress callback, `inputProvider` tự trả
 *     lời `input_required` qua `tasks/update`, `AbortSignal` huỷ qua
 *     `tasks/cancel`.
 *   - `sendInput(taskId, input)` — `tasks/update`.
 *   - `cancel(taskId)` — `tasks/cancel`.
 *   - `fetchResultBlocking(taskId)` — LUÔN ném `McpTasksSpecError`:
 *     `tasks/result` đã bị xoá ở 2026-07-28; kết quả cuối nằm ngay trong
 *     `tasks/get` khi `status = completed`.
 *
 * Trạng thái v2: `pending` | `running` | `input_required` | `completed` |
 * `failed` | `cancelled`. Server 2025 trả `working` được chuẩn hoá về
 * `running`; `pending` là trạng thái server báo trước khi task bắt đầu
 * chạy (task mới tạo chưa schedule).
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import { McpTasksSpecError, tasksMethodReplacement } from './tasksSpec';
import { TaskError, parseTaskHandle, type TaskHandleData } from './tasks';

/** Trạng thái task theo chuẩn polling 2026-07-28. */
export type McpTaskStatusV2 =
  | 'pending'
  | 'running'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Trạng thái cuối — poll dừng khi gặp một trong các trạng thái này. */
export const TASK_V2_TERMINAL_STATUSES: readonly McpTaskStatusV2[] = [
  'completed',
  'failed',
  'cancelled',
];

/** Method tasks còn tồn tại ở extension 2026-07-28. */
export const MCP_TASKS_V2_METHODS = {
  get: 'tasks/get',
  update: 'tasks/update',
  cancel: 'tasks/cancel',
} as const;

/** Method tasks đã bị xoá ở 2026-07-28 (gọi là lỗi). */
export const MCP_TASKS_V2_REMOVED_METHODS = ['tasks/result', 'tasks/list'] as const;

/** Transport tối thiểu poller cần: một hàm gọi JSON-RPC. */
export interface McpTasksPollerTransport {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Snapshot task sau một lần poll (đã chuẩn hoá trạng thái v2). */
export interface TaskPollSnapshot {
  taskId: string;
  status: McpTaskStatusV2;
  /** Tiến độ 0..1 khi server báo (undefined = server không báo). */
  progress?: number;
  /** Ghi chú tiến độ của server. */
  progressMessage?: string;
  /** Kết quả cuối — chỉ có khi status = completed. */
  result?: unknown;
  /** Lỗi server báo khi status = failed. */
  error?: string;
  /** Gợi ý khoảng chờ tới lần poll sau (ms). */
  pollIntervalMs?: number;
  /** Số lần đã poll (tính từ lúc tạo poller / waitForCompletion). */
  pollCount: number;
}

/** Event progress gửi cho UI mỗi lần poll có thay đổi. */
export interface TaskPollProgressEvent {
  taskId: string;
  status: McpTaskStatusV2;
  progress?: number;
  progressMessage?: string;
  pollCount: number;
  elapsedMs: number;
}

/** Tuỳ chọn cho `waitForCompletion`. */
export interface WaitForCompletionV2Options {
  /** Tổng thời gian chờ tối đa (ms, 0 = không giới hạn; mặc định 120_000). */
  timeoutMs?: number;
  /** Khoảng chờ giữa các lần poll khi server không gợi ý (mặc định 1000). */
  pollIntervalMs?: number;
  /** Khoảng chờ tối đa sau backoff (mặc định 10_000). */
  maxPollIntervalMs?: number;
  /** Long-poll timeout gửi kèm mỗi `tasks/get` (mặc định 30_000, 0 = tắt). */
  longPollTimeoutMs?: number;
  /** Gọi mỗi lần poll có thay đổi trạng thái / tiến độ. */
  onProgress?: (event: TaskPollProgressEvent) => void;
  /** Huỷ task qua `tasks/cancel` khi signal abort. */
  signal?: AbortSignal;
  /** Nguồn đáp án khi task rơi vào `input_required` (qua `tasks/update`). */
  inputProvider?: (snapshot: TaskPollSnapshot) => Promise<unknown>;
  /** Số vòng input tối đa (mặc định 8) — chặn task xin input vô hạn. */
  maxInputRounds?: number;
  /** Đồng hồ (để test). */
  now?: () => number;
  /** Hàm ngủ (để test). */
  sleep?: (ms: number) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

/**
 * Chuẩn hoá trạng thái server trả về trạng thái v2: `working` -> `running`,
 * `pending` giữ nguyên. Ném `TaskError` khi giá trị ngoài spec.
 */
export function normalizeTaskStatusV2(value: unknown): McpTaskStatusV2 {
  if (value === 'pending' || value === 'running' || value === 'input_required') {
    return value;
  }
  if (value === 'working') return 'running';
  if (value === 'completed' || value === 'failed' || value === 'cancelled') {
    return value;
  }
  throw new TaskError(`Tasks v2: trạng thái không hợp lệ: ${JSON.stringify(value)}`);
}

/** True khi trạng thái là trạng thái cuối (poll dừng). */
export function isTaskTerminalV2(status: McpTaskStatusV2): boolean {
  return (TASK_V2_TERMINAL_STATUSES as readonly McpTaskStatusV2[]).includes(status);
}

/**
 * Parse snapshot task từ kết quả `tasks/get` thô. Chấp nhận cả shape
 * `TaskHandleData` cũ (đã parse qua `parseTaskHandle`) và shape v2 có
 * thêm `progressPercent` / `error`.
 */
export function parseTaskPollSnapshot(value: unknown, pollCount: number): TaskPollSnapshot {
  // Server 2026 có thể báo `pending` / `running` — `parseTaskHandle`
  // (spec 2025) chỉ biết `working`, nên map trước khi parse rồi chuẩn
  // hoá lại từ status gốc sau đó.
  const raw = isRecord(value) ? value : {};
  const rawStatus = raw['status'];
  const mapped =
    rawStatus === 'pending' || rawStatus === 'running'
      ? { ...raw, status: 'working' }
      : value;
  const handle: TaskHandleData = parseTaskHandle(mapped);
  const status = normalizeTaskStatusV2(rawStatus);
  const snapshot: TaskPollSnapshot = {
    taskId: handle.taskId,
    status,
    pollCount,
  };
  if (typeof handle.progress === 'number') snapshot.progress = handle.progress;
  else if (typeof raw['progressPercent'] === 'number' && Number.isFinite(raw['progressPercent'])) {
    snapshot.progress = Math.max(0, Math.min(1, raw['progressPercent'] / 100));
  }
  if (typeof handle.progressMessage === 'string') snapshot.progressMessage = handle.progressMessage;
  else if (typeof raw['message'] === 'string') snapshot.progressMessage = raw['message'];
  if ('result' in raw) snapshot.result = raw['result'];
  if (typeof raw['error'] === 'string') snapshot.error = raw['error'];
  else if (isRecord(raw['error']) && typeof raw['error']['message'] === 'string') {
    snapshot.error = raw['error']['message'] as string;
  }
  if (typeof handle.pollInterval === 'number') snapshot.pollIntervalMs = handle.pollInterval;
  return snapshot;
}

/**
 * Poller wire-level cho Tasks extension 2026-07-28. Không hàng đợi,
 * không retry ẩn — lỗi transport propagate thẳng để caller quyết định.
 */
export class McpTasksPollerV2 {
  private readonly transport: McpTasksPollerTransport;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    transport: McpTasksPollerTransport,
    options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.transport = transport;
    this.now = options.now ?? Date.now;
    this.sleepFn = options.sleep ?? defaultSleep;
  }

  /**
   * Một lần `tasks/get` (long-poll khi `longPollTimeoutMs > 0`: server
   * giữ request tới timeout rồi trả trạng thái mới nhất).
   */
  async pollOnce(
    taskId: string,
    options: { longPollTimeoutMs?: number; pollCount?: number } = {},
  ): Promise<TaskPollSnapshot> {
    if (typeof taskId !== 'string' || taskId === '') {
      throw new TaskError('Tasks v2: taskId phải là chuỗi không rỗng');
    }
    const params: Record<string, unknown> = { taskId };
    const longPoll = options.longPollTimeoutMs ?? 0;
    if (longPoll > 0) params['timeoutMs'] = longPoll;
    const raw = await this.transport.call(MCP_TASKS_V2_METHODS.get, params);
    return parseTaskPollSnapshot(raw, options.pollCount ?? 1);
  }

  /**
   * Gửi input cho task đang `input_required` qua `tasks/update`.
   * Trả snapshot mới nhất sau khi update.
   */
  async sendInput(taskId: string, input: unknown): Promise<TaskPollSnapshot> {
    if (typeof taskId !== 'string' || taskId === '') {
      throw new TaskError('Tasks v2: taskId phải là chuỗi không rỗng');
    }
    const raw = await this.transport.call(MCP_TASKS_V2_METHODS.update, {
      taskId,
      input,
    });
    return parseTaskPollSnapshot(raw, 1);
  }

  /** Huỷ task qua `tasks/cancel`. Trả snapshot mới nhất (thường `cancelled`). */
  async cancel(taskId: string): Promise<TaskPollSnapshot> {
    if (typeof taskId !== 'string' || taskId === '') {
      throw new TaskError('Tasks v2: taskId phải là chuỗi không rỗng');
    }
    const raw = await this.transport.call(MCP_TASKS_V2_METHODS.cancel, { taskId });
    return parseTaskPollSnapshot(raw, 1);
  }

  /**
   * `tasks/result` đã bị xoá ở 2026-07-28 — hàm này LUÔN ném
   * `McpTasksSpecError` kèm method thay thế, để code cũ gọi nhầm thì
   * lỗi rõ ràng thay vì treo chờ kết quả không bao giờ tới.
   */
  fetchResultBlocking(_taskId: string): never {
    throw new McpTasksSpecError(
      'tasks/result đã bị xoá ở MCP 2026-07-28 — kết quả cuối nằm ngay trong tasks/get khi status = completed',
      'tasks/result',
      '2026-07-28',
      tasksMethodReplacement('tasks/result'),
    );
  }

  /**
   * Poll tới trạng thái cuối. Long-poll mỗi vòng, backoff giữa các vòng
   * khi server trả ngay (không long-poll), deadline tổng, `input_required`
   * tự trả lời qua `inputProvider` + `tasks/update`, abort thì huỷ task
   * qua `tasks/cancel` rồi ném `TaskError`.
   */
  async waitForCompletion(
    taskId: string,
    options: WaitForCompletionV2Options = {},
  ): Promise<TaskPollSnapshot> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const baseInterval = options.pollIntervalMs ?? 1000;
    const maxInterval = options.maxPollIntervalMs ?? 10_000;
    const longPollTimeoutMs = options.longPollTimeoutMs ?? 30_000;
    const maxInputRounds = options.maxInputRounds ?? 8;
    const startedAt = this.now();
    const deadline = timeoutMs > 0 ? startedAt + timeoutMs : Number.POSITIVE_INFINITY;
    let pollCount = 0;
    let interval = baseInterval;
    let inputRounds = 0;
    let lastStatus: McpTaskStatusV2 | undefined;
    let lastProgress: number | undefined;

    for (;;) {
      if (options.signal?.aborted) {
        await this.cancelQuietly(taskId);
        throw new TaskError('Tasks v2: task đã bị huỷ bởi caller', taskId, 'cancelled');
      }
      if (this.now() >= deadline) {
        throw new TaskError(
          `Tasks v2: hết thời gian chờ task ${taskId} sau ${timeoutMs}ms`,
          taskId,
        );
      }
      pollCount += 1;
      const snapshot = await this.pollOnce(taskId, { longPollTimeoutMs, pollCount });
      const changed =
        snapshot.status !== lastStatus || snapshot.progress !== lastProgress;
      if (changed && options.onProgress) {
        options.onProgress({
          taskId,
          status: snapshot.status,
          progress: snapshot.progress,
          progressMessage: snapshot.progressMessage,
          pollCount,
          elapsedMs: this.now() - startedAt,
        });
      }
      lastStatus = snapshot.status;
      lastProgress = snapshot.progress;
      if (isTaskTerminalV2(snapshot.status)) return snapshot;
      if (snapshot.status === 'failed') return snapshot;
      if (snapshot.status === 'input_required') {
        if (!options.inputProvider) {
          throw new TaskError(
            'Tasks v2: task đang chờ input — truyền inputProvider hoặc gọi sendInput() tay',
            taskId,
            'input_required',
          );
        }
        inputRounds += 1;
        if (inputRounds > maxInputRounds) {
          throw new TaskError(
            `Tasks v2: task xin input quá ${maxInputRounds} vòng — dừng để tránh lặp vô hạn`,
            taskId,
            'input_required',
          );
        }
        const answer = await options.inputProvider(snapshot);
        await this.sendInput(taskId, answer);
        continue;
      }
      // Chưa tới trạng thái cuối: chờ theo gợi ý server (có backoff).
      // Hết thời gian còn lại thì dừng ngay thay vì poll trong vòng lặp
      // vô hạn (waitMs = 0 nghĩa là đã chạm deadline).
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) {
        throw new TaskError(
          `Tasks v2: hết thời gian chờ task ${taskId} sau ${timeoutMs}ms`,
          taskId,
        );
      }
      const waitMs = Math.min(snapshot.pollIntervalMs ?? interval, maxInterval, remainingMs);
      await this.sleepFn(waitMs);
      interval = Math.min(interval * 2, maxInterval);
    }
  }

  private async cancelQuietly(taskId: string): Promise<void> {
    try {
      await this.transport.call(MCP_TASKS_V2_METHODS.cancel, { taskId });
    } catch {
      // Huỷ thất bại thì thôi — lỗi abort gốc mới là lỗi cần báo.
    }
  }
}

/**
 * Tiện ích một lần: poll một task đã biết tới trạng thái cuối trên một
 * transport dùng một lần (không cần giữ instance poller).
 */
export async function pollTaskToCompletionV2(
  transport: McpTasksPollerTransport,
  taskId: string,
  options: WaitForCompletionV2Options = {},
): Promise<TaskPollSnapshot> {
  const poller = new McpTasksPollerV2(transport, {
    now: options.now,
    sleep: options.sleep,
  });
  return poller.waitForCompletion(taskId, options);
}
