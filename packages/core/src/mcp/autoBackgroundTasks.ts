/**
 * Auto-background tasks cho tool call dài (v1.10, Team T2).
 *
 * Ý tưởng từ Claude Code 2.1 (`CLAUDE_AUTO_BACKGROUND_TASKS=1` +
 * streaming input, 06/11/2026) và Microsoft Agent Framework
 * (`ListAgentToolsWithTasksAsync` — poll task tới xong rồi trả kết
 * quả như gọi đồng bộ): một tool call không trả lời ngay thì đừng
 * chặn cả agent loop — nó được đưa nền ngay, caller vẫn nhận kết quả
 * cuối dưới đúng hình dạng như gọi đồng bộ, chỉ thêm cờ
 * `backgrounded: true` + log event để UI biết nó từng chạy nền.
 *
 * Luồng `runToolCallAutoBackground(fn, options)`:
 *   1. chạy `fn` ngay (đồng bộ, như bình thường);
 *   2. nếu `fn` xong trước `thresholdMs` (mặc định 1500ms) → trả
 *      kết quả luôn, `backgrounded: false` — đường nhanh không tốn
 *      thêm gì;
 *   3. nếu quá ngưỡng → phát event `backgrounded`, `fn` tiếp tục
 *      chạy nền; caller poll theo `pollIntervalMs` (event `progress`
 *      mỗi vòng + mọi `reportProgress()` mà `fn` gọi qua context —
 *      đó là "streaming input" của task: tiến độ chảy về trong lúc
 *      chờ, thay vì im lặng tới khi xong);
 *   4. `fn` xong → trả kết quả như gọi đồng bộ (`backgrounded:
 *      true`, kèm số poll + thời gian); timeout → `timeout` error;
 *      `signal` abort → huỷ và báo `cancelled`.
 *
 * `LocalBackgroundTaskRegistry` giữ các job đang chạy nền theo
 * `taskId` để tool / UI poll trạng thái hoặc huỷ từ xa (vd tool
 * `mcp_tasks_auto_background` đăng ký job rồi poll tới xong).
 * Bật/tắt toàn cục qua env `OPENBOT_AUTO_BACKGROUND_TASKS=1`
 * (mặc định TẮT — opt-in như Claude, vì chạy nền đổi hành vi thấy
 * được của agent loop; host bật khi đã sẵn sàng).
 *
 * Module này không gọi model, không chạm mạng: `fn` do caller tiêm
 * vào; đồng hồ + sleep tiêm được để test chạy nhanh, xác định.
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

/** Biến môi trường bật auto-background tasks (opt-in, giống Claude). */
export const AUTO_BACKGROUND_TASKS_ENV_VAR = 'OPENBOT_AUTO_BACKGROUND_TASKS';

/** Ngưỡng mặc định: call chậm hơn 1500ms thì đưa nền. */
export const AUTO_BACKGROUND_DEFAULT_THRESHOLD_MS = 1500;
/** Khoảng poll mặc định khi đã chạy nền. */
export const AUTO_BACKGROUND_DEFAULT_POLL_INTERVAL_MS = 250;
/** Timeout mặc định cho cả call (kể cả thời gian chạy nền). */
export const AUTO_BACKGROUND_DEFAULT_TIMEOUT_MS = 120_000;

/** Lỗi auto-background (timeout / huỷ). */
export class AutoBackgroundError extends Error {
  readonly code: 'timeout' | 'cancelled';
  readonly taskId?: string;
  constructor(message: string, code: 'timeout' | 'cancelled', taskId?: string) {
    super(message);
    this.name = 'AutoBackgroundError';
    this.code = code;
    if (taskId) this.taskId = taskId;
  }
}

/**
 * True khi auto-background được bật qua env (`1` / `true`, không phân
 * biệt hoa thường). Mặc định tắt — host phải opt-in rõ ràng.
 */
export function isAutoBackgroundTasksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[AUTO_BACKGROUND_TASKS_ENV_VAR];
  if (raw === undefined) return false;
  return raw.trim().toLowerCase() === '1' || raw.trim().toLowerCase() === 'true';
}

/** Context một tool call nhận được khi chạy (nền hay không). */
export interface BackgroundTaskContext {
  /** Task id ổn định của call này (để poll/huỷ từ xa). */
  taskId: string;
  /** Signal huỷ (abort từ caller hoặc timeout). */
  signal: AbortSignal;
  /**
   * Đẩy tiến độ streaming về cho caller trong lúc chạy: `percent`
   * 0..100, `message` mô tả bước hiện tại. Không có gì bắt buộc phải
   * gọi — call không báo tiến độ vẫn chạy nền bình thường, chỉ ít
   * event `progress` hơn.
   */
  reportProgress: (percent: number, message?: string) => void;
}

/** Một event trong đời một auto-background call. */
export type AutoBackgroundEvent =
  | { kind: 'started'; taskId: string; label?: string }
  | { kind: 'backgrounded'; taskId: string; afterMs: number }
  | { kind: 'progress'; taskId: string; percent?: number; message?: string; polls: number }
  | { kind: 'done'; taskId: string; backgrounded: boolean; durationMs: number; polls: number }
  | { kind: 'cancelled'; taskId: string; afterMs: number }
  | { kind: 'timeout'; taskId: string; afterMs: number };

/** Tuỳ chọn cho `runToolCallAutoBackground`. */
export interface AutoBackgroundOptions {
  /** Task id ổn định (mặc định sinh `bg-<timestamp>-<random>`). */
  taskId?: string;
  /** Nhãn hiển thị (tên tool / mô tả ngắn) cho event + registry. */
  label?: string;
  /** Ngưỡng đưa nền (ms, mặc định 1500). */
  thresholdMs?: number;
  /** Khoảng poll khi đã nền (ms, mặc định 250). */
  pollIntervalMs?: number;
  /** Timeout tổng (ms, mặc định 120000; 0 = không giới hạn). */
  timeoutMs?: number;
  /** Signal huỷ từ caller. */
  signal?: AbortSignal;
  /** Nhận từng event (started/backgrounded/progress/done/...). */
  onEvent?: (event: AutoBackgroundEvent) => void;
  /** Đồng hồ tiêm vào (test). */
  now?: () => number;
  /** Sleep tiêm vào (test). */
  sleep?: (ms: number) => Promise<void>;
}

/** Kết quả cuối của một auto-background call. */
export interface AutoBackgroundOutcome<T> {
  /** Kết quả `fn` trả về — đúng hình dạng như gọi đồng bộ. */
  result: T;
  /** True khi call từng bị đưa nền (chậm hơn ngưỡng). */
  backgrounded: boolean;
  /** Task id của call (để đối chiếu với registry/event). */
  taskId: string;
  /** Tổng thời gian chạy (ms). */
  durationMs: number;
  /** Số vòng poll đã chạy khi nền (0 khi xong ngay). */
  polls: number;
  /** Toàn bộ event đã phát (theo thứ tự). */
  events: AutoBackgroundEvent[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function newTaskId(): string {
  return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Chạy `fn` như một tool call thường, nhưng tự đưa nền khi chậm hơn
 * ngưỡng rồi poll tới xong và trả kết quả như gọi đồng bộ.
 *
 * `fn` nhận `BackgroundTaskContext` để báo tiến độ streaming và nhận
 * signal huỷ. Ném `AutoBackgroundError` khi timeout (`code:
 * 'timeout'`) hoặc bị huỷ (`code: 'cancelled'`); lỗi của `fn` thì
 * propagate nguyên vẹn (không bọc lại).
 */
export async function runToolCallAutoBackground<T>(
  fn: (ctx: BackgroundTaskContext) => Promise<T>,
  options: AutoBackgroundOptions = {},
): Promise<AutoBackgroundOutcome<T>> {
  const taskId = options.taskId ?? newTaskId();
  const thresholdMs = options.thresholdMs ?? AUTO_BACKGROUND_DEFAULT_THRESHOLD_MS;
  const pollIntervalMs = options.pollIntervalMs ?? AUTO_BACKGROUND_DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? AUTO_BACKGROUND_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAtMs = now();
  const events: AutoBackgroundEvent[] = [];
  const emit = (event: AutoBackgroundEvent): void => {
    events.push(event);
    options.onEvent?.(event);
  };
  const deadlineMs = timeoutMs > 0 ? startedAtMs + timeoutMs : 0;

  const controller = new AbortController();
  // Ghi lại xem abort (timeout / caller) có xảy ra TRƯỚC khi `fn`
  // settle không: `fn` hợp tác (resolve khi nhận abort) sẽ settle
  // ngay sau abort — lúc đó vẫn phải báo timeout/cancelled, không
  // được trả kết quả 'never' của nó. Ngược lại, `fn` settle trước
  // khi abort kịp chạy thì kết quả đó là hợp lệ. Listener này chạy
  // đồng bộ trong lúc dispatch abort, trước mọi microtask `.then`
  // của `fn`, nên thứ tự ghi được là chính xác (không phụ thuộc
  // đồng hồ).
  let abortedBeforeSettle = false;
  controller.signal.addEventListener(
    'abort',
    () => {
      if (!settled) abortedBeforeSettle = true;
    },
    { once: true },
  );
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else {
      options.signal.addEventListener('abort', () => controller.abort(options.signal!.reason), { once: true });
    }
  }
  const timeoutTimer =
    deadlineMs > 0
      ? setTimeout(() => controller.abort(new Error('timeout')), deadlineMs - startedAtMs)
      : undefined;
  timeoutTimer?.unref?.();

  emit({ kind: 'started', taskId, ...(options.label ? { label: options.label } : {}) });

  let latestProgress: { percent?: number; message?: string } = {};
  const ctx: BackgroundTaskContext = {
    taskId,
    signal: controller.signal,
    reportProgress: (percent: number, message?: string) => {
      latestProgress = {
        percent: Math.max(0, Math.min(100, percent)),
        ...(message ? { message } : {}),
      };
    },
  };

  let result: T;
  let resultPromise: Promise<T>;
  try {
    resultPromise = fn(ctx);
  } catch (err) {
    clearTimeout(timeoutTimer);
    throw err;
  }
  // Gắn handler chống unhandled rejection trong lúc chờ ngưỡng: kết
  // quả vẫn được lấy lại ở vòng poll dưới.
  let settled = false;
  let settledError: unknown;
  let settledValue: T | undefined;
  resultPromise.then(
    (value) => {
      settled = true;
      settledValue = value;
    },
    (err) => {
      settled = true;
      settledError = err;
    },
  );

  // Chờ fn xong, theo từng vòng pollIntervalMs. Vòng nào vượt ngưỡng
  // mà fn chưa xong thì phát `backgrounded` một lần rồi tiếp tục
  // poll (event `progress` mỗi vòng) tới khi fn xong / timeout / huỷ.
  let polls = 0;
  let backgroundedEmitted = false;
  for (;;) {
    if (settled) break;
    if (controller.signal.aborted) break;
    const elapsed = now() - startedAtMs;
    if (elapsed >= thresholdMs && !backgroundedEmitted) {
      backgroundedEmitted = true;
      emit({ kind: 'backgrounded', taskId, afterMs: elapsed });
    }
    if (backgroundedEmitted) {
      polls += 1;
      emit({
        kind: 'progress',
        taskId,
        ...(latestProgress.percent !== undefined ? { percent: latestProgress.percent } : {}),
        ...(latestProgress.message ? { message: latestProgress.message } : {}),
        polls,
      });
    }
    if (deadlineMs > 0 && now() >= deadlineMs) {
      controller.abort(new Error('timeout'));
      break;
    }
    await sleep(pollIntervalMs);
  }
  clearTimeout(timeoutTimer);

  if (controller.signal.aborted && abortedBeforeSettle) {
    const reason = controller.signal.reason;
    const isTimeout =
      (reason instanceof Error && reason.message === 'timeout') ||
      (deadlineMs > 0 && now() >= deadlineMs);
    const afterMs = now() - startedAtMs;
    if (isTimeout) {
      emit({ kind: 'timeout', taskId, afterMs });
      throw new AutoBackgroundError(
        `Tool call "${taskId}" hết thời gian chờ (${timeoutMs}ms).`,
        'timeout',
        taskId,
      );
    }
    emit({ kind: 'cancelled', taskId, afterMs });
    throw new AutoBackgroundError(
      `Tool call "${taskId}" đã bị huỷ.`,
      'cancelled',
      taskId,
    );
  }

  // Đợi kết quả thật (đã settled hoặc sắp settled — không poll nữa).
  if (!settled) {
    try {
      settledValue = await resultPromise;
      settled = true;
    } catch (err) {
      settledError = err;
      settled = true;
    }
  }
  if (settledError !== undefined) throw settledError;
  result = settledValue as T;
  const durationMs = now() - startedAtMs;
  const backgrounded = polls > 0;
  emit({ kind: 'done', taskId, backgrounded, durationMs, polls });
  return { result, backgrounded, taskId, durationMs, polls, events };
}

// ---------------------------------------------------------------------------
// Registry: giữ job nền theo taskId để poll / huỷ từ xa
// ---------------------------------------------------------------------------

/** Trạng thái một job nền trong registry. */
export type BackgroundJobStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** Một job nền đang (hoặc đã) chạy. */
export interface BackgroundJob {
  taskId: string;
  label?: string;
  status: BackgroundJobStatus;
  startedAtMs: number;
  finishedAtMs?: number;
  /** Kết quả (khi done) — giữ nguyên hình dạng như gọi đồng bộ. */
  result?: unknown;
  /** Lỗi (khi failed/cancelled). */
  error?: string;
  /** Số event progress đã phát. */
  polls: number;
}

/**
 * Registry job nền trong-process: `runToolCallAutoBackground` đăng ký
 * job lúc bắt đầu, cập nhật lúc xong; tool/UI tra cứu theo taskId để
 * poll hoặc huỷ. Không persist — restart là mất (job nền là call
 * trong-process, không phải task của server; resume sau restart là
 * việc của `McpTaskRunner`).
 */
export class LocalBackgroundTaskRegistry {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Số job đang giữ (kể cả đã xong — registry không tự xoá). */
  get size(): number {
    return this.jobs.size;
  }

  /**
   * Chạy `fn` qua auto-background và đăng ký job. Trả outcome như
   * `runToolCallAutoBackground` (kết quả vẫn như gọi đồng bộ).
   */
  async run<T>(
    fn: (ctx: BackgroundTaskContext) => Promise<T>,
    options: AutoBackgroundOptions = {},
  ): Promise<AutoBackgroundOutcome<T>> {
    const taskId = options.taskId ?? newTaskId();
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else options.signal.addEventListener('abort', () => controller.abort(options.signal!.reason), { once: true });
    }
    const startedAtMs = this.now();
    const job: BackgroundJob = {
      taskId,
      ...(options.label ? { label: options.label } : {}),
      status: 'running',
      startedAtMs,
      polls: 0,
    };
    this.jobs.set(taskId, job);
    this.controllers.set(taskId, controller);
    let polls = 0;
    try {
      const outcome = await runToolCallAutoBackground(fn, {
        ...options,
        taskId,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === 'progress') {
            polls = event.polls;
            job.polls = polls;
          }
          options.onEvent?.(event);
        },
      });
      job.status = 'done';
      job.finishedAtMs = this.now();
      job.result = outcome.result;
      job.polls = outcome.polls;
      return outcome;
    } catch (err) {
      job.status = err instanceof AutoBackgroundError && err.code === 'cancelled' ? 'cancelled' : 'failed';
      job.finishedAtMs = this.now();
      job.error = err instanceof Error ? err.message : String(err);
      job.polls = polls;
      throw err;
    } finally {
      this.controllers.delete(taskId);
    }
  }

  /** Tra cứu một job theo taskId (undefined khi chưa từng có). */
  get(taskId: string): BackgroundJob | undefined {
    return this.jobs.get(taskId);
  }

  /** Liệt kê job (mới nhất trước). */
  list(): BackgroundJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAtMs - a.startedAtMs);
  }

  /** Huỷ một job đang chạy. Trả false khi job không còn chạy. */
  cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    controller.abort(new Error('cancelled by registry'));
    return true;
  }

  /** Xoá job khỏi registry (dọn sau khi UI đã đọc kết quả). */
  remove(taskId: string): boolean {
    return this.jobs.delete(taskId);
  }
}
