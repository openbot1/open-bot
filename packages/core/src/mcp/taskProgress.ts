/**
 * MCP Tasks lifecycle v2 — progress events + server-directed tasks
 * (v1.05, sóng T2).
 *
 * `tasks.ts` (client TaskHandle) và `taskStore.ts` (server store)
 * đã có poll/get/update/cancel, nhưng còn thiếu hai mảnh của
 * lifecycle đầy đủ theo Tasks extension 2026-07-28:
 *
 *   1. Task progress events: khi server chạy task dài, client cần
 *      biết tiến độ (0..1 + message) NGAY KHI nó đổi, không phải
 *      chờ lần poll sau. Module này cung cấp
 *      `McpTaskProgressEmitter` (subscribe/unsubscribe, giống
 *      EventTarget nhưng không phụ thuộc DOM) và
 *      `McpTaskProgressTracker` — bọc một `TaskHandle`, poll theo
 *      `pollInterval` và phát event mỗi khi status / progress /
 *      message đổi, kèm `notifications/tasks/progress` parse cho
 *      server push (khi transport hỗ trợ notification).
 *   2. Server-directed task: server yêu cầu CLIENT tạo task
 *      (method `tasks/create` do server gửi — vd server muốn
 *      client chạy một job dài ở phía client rồi báo lại).
 *      `parseServerDirectedTaskRequest` validate request,
 *      `handleServerDirectedTask` tạo task qua `createTask` rồi
 *      trả handle cho server, kèm chính sách: chỉ tạo task cho
 *      method trong allowlist, từ chối method nguy hiểm, giới hạn
 *      số task server-directed đang chạy.
 *
 * Module không chạm mạng: transport là `McpTaskTransport` của
 * `tasks.ts` (fake trong test). Không copy code từ SDK MCP nào.
 */

import {
  TaskError,
  TaskHandle,
  createTask,
  isTaskTerminal,
  parseTaskHandle,
  parseTaskStatus,
  type McpTaskTransport,
  type TaskHandleData,
  type TaskStatus,
} from './tasks';

/** Một event tiến độ của task. */
export interface TaskProgressEvent {
  /** Task id. */
  taskId: string;
  /** Trạng thái hiện tại. */
  status: TaskStatus;
  /** Tiến độ 0..1 (khi server báo). */
  progress?: number;
  /** Ghi chú tiến độ (khi server báo). */
  progressMessage?: string;
  /** Khi nào event phát ra (ms epoch). */
  atMs: number;
  /** Nguồn event: poll client hay server push notification. */
  source: 'poll' | 'push';
}

/** Loại event progress tracker phát ra. */
export type TaskProgressEventKind = 'progress' | 'status' | 'terminal';

/** Một event đầy đủ tracker phát ra (kèm loại). */
export interface TaskProgressTrackerEvent extends TaskProgressEvent {
  kind: TaskProgressEventKind;
}

export type TaskProgressListener = (event: TaskProgressTrackerEvent) => void;

/**
 * Emitter cho task progress events: subscribe/unsubscribe theo
 * taskId (hoặc tất cả task với `'*'`), phát event đồng bộ cho mọi
 * listener. Listener ném lỗi không làm chết emitter — lỗi được gom
 * vào `listenerErrors` để coordinator xem.
 */
export class McpTaskProgressEmitter {
  private readonly listeners = new Map<string, Set<TaskProgressListener>>();
  private readonly wildcard = new Set<TaskProgressListener>();
  private readonly errors: Error[] = [];

  /** Số listener đang đăng ký. */
  get listenerCount(): number {
    let count = this.wildcard.size;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  /** Lỗi listener đã gom (copy). */
  get listenerErrors(): Error[] {
    return [...this.errors];
  }

  /**
   * Đăng ký nhận event của một task (hoặc `'*'` cho mọi task).
   * Trả hàm huỷ đăng ký.
   */
  subscribe(taskId: string, listener: TaskProgressListener): () => void {
    if (taskId === '*') {
      this.wildcard.add(listener);
      return () => {
        this.wildcard.delete(listener);
      };
    }
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.listeners.delete(taskId);
    };
  }

  /** Phát một event tới listener của task + wildcard. */
  emit(event: TaskProgressTrackerEvent): void {
    const targets: TaskProgressListener[] = [
      ...(this.listeners.get(event.taskId) ?? []),
      ...this.wildcard,
    ];
    for (const listener of targets) {
      try {
        listener(event);
      } catch (err) {
        this.errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /** Huỷ mọi đăng ký (vd đóng client). */
  clear(): void {
    this.listeners.clear();
    this.wildcard.clear();
  }
}

/** Tuỳ chọn cho McpTaskProgressTracker. */
export interface TaskProgressTrackerOptions {
  /** Khoảng poll tối đa (ms) — backoff không vượt quá (mặc định 30s). */
  maxPollIntervalMs?: number;
  /** Gọi khi task tới trạng thái cuối. */
  onTerminal?: (taskId: string, status: TaskStatus, result?: unknown) => void;
  /** Clock injection cho test. */
  nowMs?: () => number;
}

/**
 * Theo dõi một task qua poll và phát progress event mỗi khi có thay
 * đổi: status đổi → event `status`; progress/message đổi → event
 * `progress`; tới trạng thái cuối → event `terminal` (kèm result
 * khi completed ở spec 2026-07-28). Poll dùng backoff giống
 * `TaskHandle.waitForCompletion` (bắt đầu từ pollInterval server
 * gợi ý, nhân đôi mỗi vòng).
 *
 * Server push: `handlePushNotification(method, params)` nhận
 * `notifications/tasks/progress` từ transport (khi client hỗ trợ
 * notification) và phát event ngay, không chờ poll.
 */
export class McpTaskProgressTracker {
  private readonly handle: TaskHandle;
  private readonly emitter: McpTaskProgressEmitter;
  private readonly options: TaskProgressTrackerOptions;
  private readonly nowMs: () => number;
  private lastStatus: TaskStatus;
  private lastProgress?: number;
  private lastMessage?: string;
  private stopped = false;
  private currentTimer: NodeJS.Timeout | null = null;

  constructor(
    handle: TaskHandle,
    emitter: McpTaskProgressEmitter = new McpTaskProgressEmitter(),
    options: TaskProgressTrackerOptions = {},
  ) {
    this.handle = handle;
    this.emitter = emitter;
    this.options = options;
    this.nowMs = options.nowMs ?? Date.now;
    this.lastStatus = handle.status;
  }

  /** Task id đang theo dõi. */
  get taskId(): string {
    return this.handle.taskId;
  }

  /** Emitter của tracker (để UI subscribe). */
  get progressEmitter(): McpTaskProgressEmitter {
    return this.emitter;
  }

  /** True khi tracker đã dừng (terminal / stop / cancel). */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Chạy tracker tới khi task xong. Trả `{ status, result }` như
   * `waitForCompletion` (2026: result trong tasks/get; 2025:
   * result qua tasks/result). Mỗi thay đổi đều phát event trước
   * khi trả về.
   */
  async trackToCompletion(options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<{ status: TaskStatus; result: unknown }> {
    const signal = options.signal;
    const maxPollIntervalMs = this.options.maxPollIntervalMs ?? 30_000;
    const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
    let attempt = 0;
    for (;;) {
      if (this.stopped) {
        throw new TaskError(
          `Task "${this.handle.taskId}": tracker đã dừng ở trạng thái "${this.handle.status}"`,
          this.handle.taskId,
          this.handle.status,
        );
      }
      signal?.throwIfAborted();
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new TaskError(
          `Task "${this.handle.taskId}": hết thời gian theo dõi (${options.timeoutMs}ms) ở trạng thái "${this.handle.status}"`,
          this.handle.taskId,
          this.handle.status,
        );
      }
      const data = await this.handle.poll(signal);
      this.emitFor(data, 'poll');
      if (data.status === 'completed') {
        this.stopped = true;
        const result =
          this.handle.specVersion === '2026-07-28'
            ? data.result
            : await this.handle.getResult(signal);
        this.emitTerminal(data, result);
        this.options.onTerminal?.(this.handle.taskId, 'completed', result);
        return { status: 'completed', result };
      }
      if (data.status === 'failed') {
        this.stopped = true;
        this.emitTerminal(data);
        this.options.onTerminal?.(this.handle.taskId, 'failed');
        throw new TaskError(
          `Task "${this.handle.taskId}": server báo thất bại`,
          this.handle.taskId,
          'failed',
        );
      }
      if (data.status === 'cancelled') {
        this.stopped = true;
        this.emitTerminal(data);
        this.options.onTerminal?.(this.handle.taskId, 'cancelled');
        throw new TaskError(
          `Task "${this.handle.taskId}": đã bị huỷ`,
          this.handle.taskId,
          'cancelled',
        );
      }
      if (data.status === 'input_required') {
        // Không fail như waitForCompletion: tracker phát event để
        // UI/coordinator gửi input qua sendInput rồi tiếp tục.
        // Poll tiếp sau một khoảng chờ (server sẽ đổi status khi
        // có input).
        const delay = Math.min(this.handle.pollIntervalMs * 2 ** attempt, maxPollIntervalMs);
        attempt += 1;
        await this.sleep(delay, signal);
        continue;
      }
      const delay = Math.min(this.handle.pollIntervalMs * 2 ** attempt, maxPollIntervalMs);
      attempt += 1;
      await this.sleep(delay, signal);
    }
  }

  /**
   * Nhận một notification `notifications/tasks/progress` do server
   * push. Trả true khi đúng là notification progress và đã phát
   * event; false khi method khác (caller xử lý tiếp).
   */
  handlePushNotification(method: string, params: unknown): boolean {
    if (method !== 'notifications/tasks/progress') return false;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
    const raw = params as Record<string, unknown>;
    if (raw['taskId'] !== this.handle.taskId) return false;
    let status: TaskStatus;
    try {
      status = parseTaskStatus(raw['status']);
    } catch {
      return false;
    }
    const progress =
      typeof raw['progress'] === 'number' && Number.isFinite(raw['progress'])
        ? Math.max(0, Math.min(1, raw['progress']))
        : undefined;
    const progressMessage =
      typeof raw['progressMessage'] === 'string' ? (raw['progressMessage'] as string) : undefined;
    const event: TaskProgressTrackerEvent = {
      taskId: this.handle.taskId,
      status,
      ...(progress !== undefined ? { progress } : {}),
      ...(progressMessage !== undefined ? { progressMessage } : {}),
      atMs: this.nowMs(),
      source: 'push',
      kind: isTaskTerminal(status) ? 'terminal' : status !== this.lastStatus ? 'status' : 'progress',
    };
    this.lastStatus = status;
    if (progress !== undefined) this.lastProgress = progress;
    if (progressMessage !== undefined) this.lastMessage = progressMessage;
    this.emitter.emit(event);
    if (isTaskTerminal(status)) this.stopped = true;
    return true;
  }

  /**
   * Build một notification `notifications/tasks/progress` (phía
   * server dùng để push tiến độ cho client). Dùng cùng shape mà
   * `handlePushNotification` parse.
   */
  static buildProgressNotification(
    taskId: string,
    status: TaskStatus,
    progress?: number,
    progressMessage?: string,
  ): { method: string; params: Record<string, unknown> } {
    const params: Record<string, unknown> = { taskId, status };
    if (progress !== undefined) params['progress'] = Math.max(0, Math.min(1, progress));
    if (progressMessage !== undefined) params['progressMessage'] = progressMessage;
    return { method: 'notifications/tasks/progress', params };
  }

  /** Dừng tracker (không huỷ task phía server — chỉ ngừng poll). */
  stop(): void {
    this.stopped = true;
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
  }

  private emitFor(data: TaskHandleData, source: 'poll' | 'push'): void {
    const progress = (data as { progress?: unknown })['progress'];
    const progressMessage = (data as { progressMessage?: unknown })['progressMessage'];
    const progressValue =
      typeof progress === 'number' && Number.isFinite(progress)
        ? Math.max(0, Math.min(1, progress))
        : undefined;
    const messageValue = typeof progressMessage === 'string' ? progressMessage : undefined;
    const statusChanged = data.status !== this.lastStatus;
    const progressChanged =
      progressValue !== undefined && progressValue !== this.lastProgress;
    const messageChanged =
      messageValue !== undefined && messageValue !== this.lastMessage;
    if (!statusChanged && !progressChanged && !messageChanged) return;
    this.lastStatus = data.status;
    if (progressValue !== undefined) this.lastProgress = progressValue;
    if (messageValue !== undefined) this.lastMessage = messageValue;
    this.emitter.emit({
      taskId: this.handle.taskId,
      status: data.status,
      ...(progressValue !== undefined ? { progress: progressValue } : {}),
      ...(messageValue !== undefined ? { progressMessage: messageValue } : {}),
      atMs: this.nowMs(),
      source,
      kind: statusChanged ? 'status' : 'progress',
    });
  }

  private emitTerminal(data: TaskHandleData, result?: unknown): void {
    this.emitter.emit({
      taskId: this.handle.taskId,
      status: data.status,
      atMs: this.nowMs(),
      source: 'poll',
      kind: 'terminal',
    });
    void result;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.currentTimer = null;
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      timer.unref?.();
      this.currentTimer = timer;
      let onAbort: (() => void) | undefined;
      if (signal) {
        onAbort = () => {
          clearTimeout(timer);
          this.currentTimer = null;
          reject(signal.reason instanceof Error ? signal.reason : new Error('Task: đã bị huỷ'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

/** Method server dùng để yêu cầu client tạo task. */
export const MCP_SERVER_DIRECTED_TASK_METHOD = 'tasks/create';

/** Số task server-directed chạy đồng thời tối đa (mặc định). */
export const DEFAULT_MAX_SERVER_DIRECTED_TASKS = 5;

/** Yêu cầu tạo task do server gửi (đã parse). */
export interface ServerDirectedTaskRequest {
  /** Method client phải chạy dưới dạng task (vd `tools/call`). */
  method: string;
  /** Params cho method đó. */
  params: Record<string, unknown>;
  /** Nhãn hiển thị (server gợi ý cho UI). */
  label?: string;
  /** TTL mong muốn (ms). */
  ttlMs?: number;
  /** Khoảng poll gợi ý (ms). */
  pollIntervalMs?: number;
  /** Id phía server để đối chiếu (khi có). */
  serverTaskId?: string;
}

export class ServerDirectedTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerDirectedTaskError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse request `tasks/create` do server gửi. Ném
 * `ServerDirectedTaskError` khi thiếu method / params sai hình.
 * Method rỗng hoặc chứa ký tự lạ bị từ chối ngay.
 */
export function parseServerDirectedTaskRequest(value: unknown): ServerDirectedTaskRequest {
  if (!isRecord(value)) {
    throw new ServerDirectedTaskError('Server-directed task: params phải là một object.');
  }
  const method = value['method'];
  if (typeof method !== 'string' || method.trim().length === 0) {
    throw new ServerDirectedTaskError('Server-directed task: thiếu "method".');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(method)) {
    throw new ServerDirectedTaskError(
      `Server-directed task: method không hợp lệ: ${JSON.stringify(method)}.`,
    );
  }
  const params = value['params'];
  if (params !== undefined && !isRecord(params)) {
    throw new ServerDirectedTaskError('Server-directed task: "params" phải là một object.');
  }
  const out: ServerDirectedTaskRequest = {
    method: method.trim(),
    params: params ? { ...(params as Record<string, unknown>) } : {},
  };
  if (typeof value['label'] === 'string' && value['label'].trim()) {
    out.label = value['label'] as string;
  }
  if (typeof value['ttlMs'] === 'number' && Number.isFinite(value['ttlMs']) && value['ttlMs'] > 0) {
    out.ttlMs = value['ttlMs'];
  }
  if (
    typeof value['pollIntervalMs'] === 'number' &&
    Number.isFinite(value['pollIntervalMs']) &&
    value['pollIntervalMs'] > 0
  ) {
    out.pollIntervalMs = value['pollIntervalMs'];
  }
  if (typeof value['serverTaskId'] === 'string' && value['serverTaskId']) {
    out.serverTaskId = value['serverTaskId'];
  }
  return out;
}

/** Chính sách cho server-directed task (allowlist + giới hạn). */
export interface ServerDirectedTaskPolicy {
  /** Method được phép tạo task (mặc định chỉ tools/call). */
  allowedMethods?: string[];
  /** Method cấm tuyệt đối (ưu tiên hơn allowlist). */
  deniedMethods?: string[];
  /** Số task server-directed chạy đồng thời tối đa. */
  maxConcurrent?: number;
}

export const DEFAULT_SERVER_DIRECTED_ALLOWED_METHODS: readonly string[] = ['tools/call'];

/**
 * Kiểm tra một method có được phép tạo task theo chính sách không.
 * Trả `{ allowed: true }` hoặc `{ allowed: false, reason }`.
 */
export function checkServerDirectedMethodAllowed(
  method: string,
  policy: ServerDirectedTaskPolicy = {},
): { allowed: true } | { allowed: false; reason: string } {
  const denied = policy.deniedMethods ?? [];
  if (denied.includes(method)) {
    return { allowed: false, reason: `Method "${method}" bị cấm tạo task theo chính sách.` };
  }
  const allowed = policy.allowedMethods ?? [...DEFAULT_SERVER_DIRECTED_ALLOWED_METHODS];
  if (!allowed.includes(method)) {
    return {
      allowed: false,
      reason: `Method "${method}" không nằm trong allowlist tạo task (chỉ: ${allowed.join(', ')}).`,
    };
  }
  return { allowed: true };
}

/** Kết quả xử lý một server-directed task. */
export interface ServerDirectedTaskOutcome {
  /** Handle task vừa tạo. */
  handle: TaskHandle;
  /** Request gốc đã parse. */
  request: ServerDirectedTaskRequest;
  /** Tracker progress (để UI subscribe ngay). */
  tracker: McpTaskProgressTracker;
}

/**
 * Xử lý một request `tasks/create` do server gửi: parse → kiểm tra
 * chính sách (allowlist + giới hạn concurrent) → tạo task qua
 * `createTask` → đăng ký vào registry đang chạy → trả handle +
 * tracker. Task được tạo chạy như task client tự tạo (poll qua
 * tracker), khác ở chỗ `origin: 'server-directed'` để UI phân biệt
 * và log ghi rõ ai yêu cầu.
 */
export class ServerDirectedTaskHandler {
  private readonly transport: McpTaskTransport;
  private readonly policy: ServerDirectedTaskPolicy;
  private readonly emitter: McpTaskProgressEmitter;
  private readonly running = new Map<string, ServerDirectedTaskOutcome>();

  constructor(
    transport: McpTaskTransport,
    policy: ServerDirectedTaskPolicy = {},
    emitter: McpTaskProgressEmitter = new McpTaskProgressEmitter(),
  ) {
    this.transport = transport;
    this.policy = policy;
    this.emitter = emitter;
  }

  /** Số task server-directed đang chạy. */
  get runningCount(): number {
    return this.running.size;
  }

  /** Emitter progress dùng chung (UI subscribe `'*'`). */
  get progressEmitter(): McpTaskProgressEmitter {
    return this.emitter;
  }

  /**
   * Xử lý request thô (`tasks/create` params). Ném
   * `ServerDirectedTaskError` khi parse/policy/concurrency lỗi,
   * `TaskError` khi tạo task thất bại.
   */
  async handle(
    rawParams: unknown,
    options: {
      specVersion?: '2025-11-25' | '2026-07-28';
      signal?: AbortSignal;
    } = {},
  ): Promise<ServerDirectedTaskOutcome> {
    const request = parseServerDirectedTaskRequest(rawParams);
    const allowed = checkServerDirectedMethodAllowed(request.method, this.policy);
    if (!allowed.allowed) {
      throw new ServerDirectedTaskError(
        `Server-directed task bị từ chối: ${allowed.reason}`,
      );
    }
    const maxConcurrent = this.policy.maxConcurrent ?? DEFAULT_MAX_SERVER_DIRECTED_TASKS;
    if (this.running.size >= maxConcurrent) {
      throw new ServerDirectedTaskError(
        `Server-directed task bị từ chối: đã có ${this.running.size}/${maxConcurrent} task server-directed đang chạy.`,
      );
    }
    const handle = await createTask(this.transport, request.method, request.params, {
      ...(request.ttlMs !== undefined ? { ttlMs: request.ttlMs } : {}),
      ...(request.pollIntervalMs !== undefined ? { pollIntervalMs: request.pollIntervalMs } : {}),
      ...(options.specVersion ? { specVersion: options.specVersion } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const tracker = new McpTaskProgressTracker(handle, this.emitter, {
      onTerminal: () => {
        this.running.delete(handle.taskId);
      },
    });
    const outcome: ServerDirectedTaskOutcome = { handle, request, tracker };
    this.running.set(handle.taskId, outcome);
    // Task kết thúc mà tracker không chạy (không ai gọi
    // trackToCompletion) thì registry vẫn phải dọn: poll nhẹ một
    // lần khi handle đổi status — ở đây dựa vào onTerminal của
    // tracker; ngoài ra expose prune() để caller dọn định kỳ.
    return outcome;
  }

  /** Lấy outcome của một task server-directed đang chạy. */
  get(taskId: string): ServerDirectedTaskOutcome | undefined {
    return this.running.get(taskId);
  }

  /** Dọn các task đã terminal khỏi registry (trả số lượng đã dọn). */
  prune(): number {
    let removed = 0;
    for (const [id, outcome] of this.running) {
      if (outcome.handle.isTerminal || outcome.tracker.isStopped) {
        this.running.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Huỷ tất cả task server-directed đang chạy (best-effort). */
  async cancelAll(): Promise<{ cancelled: string[]; failed: { taskId: string; error: string }[] }> {
    const cancelled: string[] = [];
    const failed: { taskId: string; error: string }[] = [];
    for (const [id, outcome] of [...this.running]) {
      try {
        await outcome.handle.cancel();
        outcome.tracker.stop();
        this.running.delete(id);
        cancelled.push(id);
      } catch (err) {
        failed.push({ taskId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { cancelled, failed };
  }
}

/**
 * Parse một task handle thô trong `tasks/get` kèm progress (server
 * 2026-07-28 có thể trả `progress` / `progressMessage` cùng handle).
 * Trả handle + progress tách riêng để tracker dùng.
 */
export function parseTaskHandleWithProgress(value: unknown): {
  handle: TaskHandleData;
  progress?: number;
  progressMessage?: string;
} {
  const handle = parseTaskHandle(value);
  const out: { handle: TaskHandleData; progress?: number; progressMessage?: string } = { handle };
  if (isRecord(value)) {
    if (typeof value['progress'] === 'number' && Number.isFinite(value['progress'])) {
      out.progress = Math.max(0, Math.min(1, value['progress'] as number));
    }
    if (typeof value['progressMessage'] === 'string') {
      out.progressMessage = value['progressMessage'] as string;
    }
  }
  return out;
}
