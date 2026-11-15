/**
 * Server-directed tasks — client poll task do SERVER tạo
 * (v1.06, Đội T2).
 *
 * Tasks extension chính thức `io.modelcontextprotocol/tasks`
 * (spec 2026-07-28) cho phép server CHỦ ĐỘNG tạo task mà client
 * không cần xin trước:
 *
 *   - Server trả task handle ngay trong kết quả `tools/call`
 *     (không cần client gửi `_meta.task` trước) — `detectTaskHandle`
 *     trong `tasks.ts` đã nhận ra dạng này; module này nối nó vào
 *     `McpTaskManager` để task được poll tới xong.
 *   - Server gửi notification `notifications/tasks/created` khi nó
 *     tạo task ngoài băng (vd job nền do trigger khác khởi động) —
 *     client nhận notification thì adopt task và poll `tasks/get`
 *     theo `pollInterval` server gợi ý.
 *   - `notifications/tasks/updated` — server báo task đổi trạng
 *     thái (tiến độ / sang `input_required` / xong); client poll
 *     ngay một lần để snapshot kịp thời thay vì chờ tới lượt poll.
 *   - `notifications/tasks/cancelled` — server báo task đã bị huỷ
 *     phía nó; client dừng vòng chờ local qua `manager.cancel`
 *     (lệnh `tasks/cancel` kèm theo là best-effort — server đã
 *     huỷ rồi nên có lỗi cũng không sao, snapshot vẫn ghi
 *     cancelled).
 *
 * `ServerDirectedTaskWatcher` là lớp nối duy nhất: coordinator đăng
 * ký nó vào dispatcher của từng client (`notifications/tasks/*`),
 * nó tự adopt + poll qua `McpTaskManager` đã có. Server nào chưa
 * đăng ký transport thì notification bị bỏ qua có ghi event
 * (không throw — một notification lạ không được làm chết client).
 * Task adopt trùng key thì bỏ qua (event `duplicate`); task vượt
 * `MAX_TRACKED_TASKS` của manager thì ghi event `rejected` và
 * không track — không lặng lẽ xoá task cũ.
 *
 * Ideas only — không copy code/text/tài sản của repo nào.
 */

import {
  detectTaskHandle,
  parseTaskHandle,
  TaskHandle,
  type McpTaskSpecVersion,
  type McpTaskTransport,
  type TaskHandleData,
  type TaskStatus,
} from './tasks';
import {
  McpTaskManager,
  type TaskSnapshot,
  type TrackTaskMeta,
} from './taskManager';

/** Notification method của tasks extension mà watcher xử lý. */
export const SERVER_DIRECTED_TASK_NOTIFICATIONS = {
  created: 'notifications/tasks/created',
  updated: 'notifications/tasks/updated',
  cancelled: 'notifications/tasks/cancelled',
} as const;

/** Loại sự kiện watcher ghi lại. */
export type ServerDirectedTaskEventKind =
  | 'adopted'
  | 'adopted-from-result'
  | 'duplicate'
  | 'updated'
  | 'cancelled'
  | 'rejected'
  | 'unknown-server'
  | 'invalid';

/** Một sự kiện server-directed task (để log / activity feed). */
export interface ServerDirectedTaskEvent {
  kind: ServerDirectedTaskEventKind;
  serverName: string;
  taskId?: string;
  /** Chi tiết đọc được (không chứa secret). */
  detail?: string;
  atMs: number;
}

export type ServerDirectedTaskEventListener = (
  event: ServerDirectedTaskEvent,
) => void;

/** Transport + spec version của một server đã đăng ký. */
export interface ServerDirectedTaskServer {
  transport: McpTaskTransport;
  specVersion?: McpTaskSpecVersion;
  /** Khoảng poll mặc định khi server không gợi ý (ms). */
  pollIntervalMs?: number;
  /** Timeout tối đa cho task adopt từ server này (ms). */
  timeoutMs?: number;
}

/** Tuỳ chọn cho `ServerDirectedTaskWatcher`. */
export interface ServerDirectedTaskWatcherOptions {
  /** Manager giữ task (poll + snapshot + huỷ). Bắt buộc. */
  manager: McpTaskManager;
  /** Nghe sự kiện adopt / huỷ / lỗi. */
  onEvent?: ServerDirectedTaskEventListener;
  /** Đồng hồ (test tiêm giờ cố định). */
  nowMs?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse params của `notifications/tasks/*` thành task handle +
 * metadata hiển thị. Ném Error khi thiếu `taskId` / status sai —
 * caller bắt và ghi event `invalid` thay vì throw ra dispatcher.
 */
export function parseServerDirectedTaskNotification(
  params: unknown,
): { data: TaskHandleData; method: string; label: string } {
  if (!isRecord(params)) {
    throw new Error('Task: notification tasks phải có params là object.');
  }
  const data = parseTaskHandle(params);
  const method =
    typeof params['method'] === 'string' && params['method']
      ? params['method']
      : 'tools/call';
  const label =
    typeof params['label'] === 'string' && params['label']
      ? params['label']
      : `Task ${data.taskId}`;
  return { data, method, label };
}

/**
 * Theo dõi task do server tạo: adopt từ notification hoặc từ kết
 * quả tool, poll qua `McpTaskManager`.
 */
export class ServerDirectedTaskWatcher {
  private readonly manager: McpTaskManager;
  private readonly servers = new Map<string, ServerDirectedTaskServer>();
  private readonly onEvent?: ServerDirectedTaskEventListener;
  private readonly nowMs: () => number;
  private readonly events: ServerDirectedTaskEvent[] = [];
  /** Task handle watcher đang giữ (để poll ngay khi có `updated`). */
  private readonly handles = new Map<string, TaskHandle>();
  private adoptedCount = 0;

  constructor(options: ServerDirectedTaskWatcherOptions) {
    this.manager = options.manager;
    this.onEvent = options.onEvent;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Số task đã adopt thành công (kể cả đã xong). */
  get adopted(): number {
    return this.adoptedCount;
  }

  /** Số server đã đăng ký transport. */
  get serverCount(): number {
    return this.servers.size;
  }

  /** Toàn bộ sự kiện đã ghi (bản sao). */
  getEvents(): ServerDirectedTaskEvent[] {
    return [...this.events];
  }

  private record(
    kind: ServerDirectedTaskEventKind,
    serverName: string,
    taskId?: string,
    detail?: string,
  ): void {
    const event: ServerDirectedTaskEvent = {
      kind,
      serverName,
      ...(taskId ? { taskId } : {}),
      ...(detail ? { detail } : {}),
      atMs: this.nowMs(),
    };
    this.events.push(event);
    this.onEvent?.(event);
  }

  /**
   * Đăng ký transport cho một server (để watcher poll task của nó).
   * Gọi lại với cùng tên thì ghi đè transport cũ (reconnect).
   */
  registerServer(
    serverName: string,
    server: ServerDirectedTaskServer,
  ): void {
    this.servers.set(serverName, server);
  }

  /** Hủy đăng ký một server (ngắt kết nối). */
  unregisterServer(serverName: string): boolean {
    return this.servers.delete(serverName);
  }

  /** Key của task trong manager: `${serverName}:${taskId}`. */
  static taskKey(serverName: string, taskId: string): string {
    return `${serverName}:${taskId}`;
  }

  /**
   * Adopt một task handle đã parse vào manager (poll ngay qua vòng
   * chờ nền của manager). Trả snapshot, hoặc null khi task đã được
   * theo dõi (duplicate) / manager đầy. Không throw — mọi lỗi ghi
   * event để caller biết.
   */
  adoptTask(
    serverName: string,
    data: TaskHandleData,
    meta: { method: string; label: string },
  ): TaskSnapshot | null {
    const server = this.servers.get(serverName);
    if (!server) {
      this.record(
        'unknown-server',
        serverName,
        data.taskId,
        `Chưa đăng ký transport cho server "${serverName}" — bỏ qua task.`,
      );
      return null;
    }
    const key = ServerDirectedTaskWatcher.taskKey(serverName, data.taskId);
    if (this.manager.get(key)) {
      this.record('duplicate', serverName, data.taskId, `Task "${key}" đã được theo dõi.`);
      return null;
    }
    const handle = new TaskHandle(server.transport, data, {
      specVersion: server.specVersion ?? '2026-07-28',
      ...(server.pollIntervalMs !== undefined
        ? { pollIntervalMs: server.pollIntervalMs }
        : {}),
    });
    const trackMeta: TrackTaskMeta = {
      serverName,
      method: meta.method,
      label: meta.label,
      specVersion: handle.specVersion,
      ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
      ...(server.pollIntervalMs !== undefined
        ? { pollIntervalMs: server.pollIntervalMs }
        : {}),
    };
    try {
      const snapshot = this.manager.track(handle, trackMeta);
      this.handles.set(key, handle);
      this.adoptedCount += 1;
      this.record('adopted', serverName, data.taskId, `Đã adopt task "${key}" (status ${data.status}) — đang poll.`);
      return snapshot;
    } catch (err) {
      this.record(
        'rejected',
        serverName,
        data.taskId,
        `Không adopt được task "${key}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Adopt task từ kết quả của một request thường (`tools/call`...)
   * — extension 2026-07-28 cho phép server trả handle mà không cần
   * client opt-in trước. Trả snapshot khi kết quả ĐÚNG là task
   * handle, null khi kết quả là kết quả thường (không phải task).
   */
  adoptTaskFromResult(
    serverName: string,
    method: string,
    result: unknown,
    label?: string,
  ): TaskSnapshot | null {
    const data = detectTaskHandle(result);
    if (!data) return null;
    const snapshot = this.adoptTask(serverName, data, {
      method,
      label: label ?? `Task ${data.taskId} (từ ${method})`,
    });
    if (snapshot) {
      // Ghi đè kind cho rõ nguồn: task tới từ kết quả, không phải notification.
      const last = this.events[this.events.length - 1];
      if (last && last.kind === 'adopted' && last.taskId === data.taskId) {
        last.kind = 'adopted-from-result';
      }
    }
    return snapshot;
  }

  /**
   * Xử lý một notification `notifications/tasks/*` từ dispatcher.
   * Trả true khi method thuộc tasks extension (đã xử lý hoặc đã ghi
   * event), false khi method không phải tasks (dispatcher route
   * tiếp cho handler khác). Không throw.
   */
  handleNotification(
    serverName: string,
    method: string,
    params: unknown,
  ): boolean {
    if (method === SERVER_DIRECTED_TASK_NOTIFICATIONS.created) {
      this.handleCreated(serverName, params);
      return true;
    }
    if (method === SERVER_DIRECTED_TASK_NOTIFICATIONS.updated) {
      void this.handleUpdated(serverName, params);
      return true;
    }
    if (method === SERVER_DIRECTED_TASK_NOTIFICATIONS.cancelled) {
      void this.handleCancelled(serverName, params);
      return true;
    }
    return false;
  }

  private handleCreated(serverName: string, params: unknown): void {
    let parsed: { data: TaskHandleData; method: string; label: string };
    try {
      parsed = parseServerDirectedTaskNotification(params);
    } catch (err) {
      this.record('invalid', serverName, undefined, (err as Error).message);
      return;
    }
    this.adoptTask(serverName, parsed.data, {
      method: parsed.method,
      label: parsed.label,
    });
  }

  private async handleUpdated(
    serverName: string,
    params: unknown,
  ): Promise<void> {
    let parsed: { data: TaskHandleData; method: string; label: string };
    try {
      parsed = parseServerDirectedTaskNotification(params);
    } catch (err) {
      this.record('invalid', serverName, undefined, (err as Error).message);
      return;
    }
    const key = ServerDirectedTaskWatcher.taskKey(serverName, parsed.data.taskId);
    const handle = this.handles.get(key);
    if (!handle) {
      // Task chưa adopt (tới trước khi watcher đăng ký, hoặc do
      // server khác tạo) — adopt luôn để không mất task.
      this.adoptTask(serverName, parsed.data, {
        method: parsed.method,
        label: parsed.label,
      });
      return;
    }
    // Poll ngay một lần để snapshot kịp trạng thái mới; vòng chờ
    // nền của manager vẫn poll theo lịch của nó. Lỗi poll ở đây
    // không fatal — vòng chờ sẽ thử lại.
    try {
      await handle.poll();
      this.record(
        'updated',
        serverName,
        parsed.data.taskId,
        `Task "${key}" đổi trạng thái → ${handle.status}.`,
      );
    } catch (err) {
      this.record(
        'updated',
        serverName,
        parsed.data.taskId,
        `Task "${key}" báo updated nhưng poll lỗi: ${(err as Error).message} (vòng chờ sẽ thử lại).`,
      );
    }
  }

  private async handleCancelled(
    serverName: string,
    params: unknown,
  ): Promise<void> {
    if (!isRecord(params) || typeof params['taskId'] !== 'string') {
      this.record('invalid', serverName, undefined, 'Notification tasks/cancelled thiếu taskId.');
      return;
    }
    const taskId = params['taskId'] as string;
    const key = ServerDirectedTaskWatcher.taskKey(serverName, taskId);
    const reason =
      typeof params['reason'] === 'string' ? params['reason'] : undefined;
    this.handles.delete(key);
    try {
      await this.manager.cancel(key);
      this.record(
        'cancelled',
        serverName,
        taskId,
        `Server đã huỷ task "${key}"${reason ? `: ${reason}` : ''} — đã dừng vòng chờ local.`,
      );
    } catch {
      // Task không còn trong manager (đã xong / đã huỷ trước) — vẫn
      // ghi event để biết server đã huỷ.
      this.record(
        'cancelled',
        serverName,
        taskId,
        `Server đã huỷ task "${key}" (task không còn trong manager).`,
      );
    }
  }

  /** Trạng thái task server-directed đang theo dõi (snapshot). */
  getTask(serverName: string, taskId: string): TaskSnapshot | undefined {
    return this.manager.get(
      ServerDirectedTaskWatcher.taskKey(serverName, taskId),
    );
  }

  /** Mọi task server-directed đang theo dõi (snapshot). */
  listTasks(): TaskSnapshot[] {
    return this.manager.list();
  }

  /** Huỷ một task server-directed (cả vòng chờ lẫn ở server). */
  async cancelTask(serverName: string, taskId: string): Promise<TaskSnapshot> {
    const key = ServerDirectedTaskWatcher.taskKey(serverName, taskId);
    this.handles.delete(key);
    return this.manager.cancel(key);
  }

  /** Huỷ mọi vòng chờ (đóng app / ngắt kết nối). */
  async stop(): Promise<void> {
    this.handles.clear();
    await this.manager.stop();
  }
}

/** Trạng thái task có phải trạng thái cuối không (dùng cho UI). */
export function isServerDirectedTaskTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
