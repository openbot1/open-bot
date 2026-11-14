/**
 * MCP Tasks — persistent task store (v1.05, sóng T2).
 *
 * `taskStore.ts` (v0.97) là in-memory: server restart là mất hết
 * task — client đang poll sẽ thấy "unknown task" và phải chạy lại
 * công việc dài từ đầu. Module này bọc `McpTaskStore` bằng một lớp
 * persist JSON:
 *
 *   - Mọi thay đổi trạng thái (submit / update / cancel / complete
 *     / fail) đều được snapshot xuống file JSON (ghi atomic:
 *     tmp + rename, để crash giữa chừng không làm hỏng file).
 *   - Khởi động lại: `load()` đọc snapshot; task nào đang
 *     `working` / `input_required` lúc crash được đánh dấu
 *     `failed` với error "server đã restart" — trung thực hơn là
 *     giả vờ chúng vẫn chạy (runner đã chết cùng process cũ, không
 *     thể resume). Task terminal (completed / failed / cancelled)
 *     giữ nguyên để client còn poll được kết quả sau restart.
 *   - Snapshot chỉ giữ record JSON-safe (taskId, method, params,
 *     status, result, error, progress, timestamps) — không giữ
 *     runner, AbortController hay waiter (chúng là runtime state,
 *     không serialize được).
 *   - File snapshot có version + checksum nhẹ (đếm record) để
 *     phát hiện file hỏng; file hỏng → load trả store rỗng và ghi
 *     log qua `onCorrupt` thay vì crash server.
 *   - Giới hạn: snapshot chỉ lưu tối đa `maxPersistedTasks`
 *     record mới nhất; TTL expiry vẫn chạy như store gốc.
 *
 * Chỉ dùng `node:fs` — không phụ thuộc DB. File mặc định nằm
 * trong thư mục data của server (caller truyền đường dẫn đầy đủ).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  McpTaskStore,
  type McpTaskRunnerContext,
  type McpTaskStoreOptions,
  type ServerTaskHandleData,
  type ServerTaskStatus,
  type StoredMcpTask,
} from './taskStore';

/** Version của format file snapshot (đổi khi shape record đổi). */
export const PERSISTENT_TASK_STORE_FORMAT_VERSION = 1;

/** Một record task trong file snapshot (JSON-safe). */
export interface PersistedMcpTaskRecord {
  taskId: string;
  method: string;
  params: Record<string, unknown>;
  status: ServerTaskStatus;
  result?: unknown;
  error?: string;
  inputRequest?: { prompt?: string; schema?: Record<string, unknown> };
  progress?: number;
  progressMessage?: string;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs?: number;
}

/** Toàn bộ file snapshot. */
export interface PersistentTaskSnapshotFile {
  formatVersion: number;
  savedAtMs: number;
  tasks: PersistedMcpTaskRecord[];
}

export class PersistentTaskStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistentTaskStoreError';
  }
}

/** Tuỳ chọn cho PersistentMcpTaskStore. */
export interface PersistentMcpTaskStoreOptions extends McpTaskStoreOptions {
  /** Đường dẫn file snapshot JSON (bắt buộc). */
  filePath: string;
  /** Số record tối đa giữ trong snapshot (mặc định 200). */
  maxPersistedTasks?: number;
  /** Ghi snapshot ngay sau mỗi thay đổi (mặc định true). */
  autosave?: boolean;
  /** Gọi khi file snapshot hỏng / không đọc được (mặc định bỏ qua). */
  onCorrupt?: (filePath: string, error: Error) => void;
  /** Gọi sau mỗi lần save thành công (diagnostics). */
  onSaved?: (filePath: string, taskCount: number) => void;
}

export const PERSISTENT_TASK_STORE_MAX_TASKS_DEFAULT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return t !== 'number' || Number.isFinite(value as number);
  }
  if (Array.isArray(value)) return value.every((v) => isJsonSafe(v, depth + 1));
  if (t === 'object') {
    return Object.values(value as Record<string, unknown>).every((v) => isJsonSafe(v, depth + 1));
  }
  return false;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (isJsonSafe(value)) return value;
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'function' ? undefined : v)));
  } catch {
    return '[unserializable]';
  }
}

/**
 * Task store bền: `McpTaskStore` + snapshot JSON.
 *
 * Cách dùng:
 * ```
 * const store = new PersistentMcpTaskStore({ filePath: '/data/mcp-tasks.json' });
 * store.load(); // khôi phục task terminal từ lần chạy trước
 * store.submit('tools/call', params, runner); // autosave
 * ```
 * Mọi method đổi trạng thái (`submit`/`update`/`cancel`) đều
 * autosave khi `autosave: true`. Runner hoàn thành / fail cũng
 * autosave (bọc trong `submit`).
 */
export class PersistentMcpTaskStore {
  private readonly store: McpTaskStore;
  private readonly filePath: string;
  private readonly maxPersistedTasks: number;
  private readonly autosave: boolean;
  private readonly onCorrupt?: (filePath: string, error: Error) => void;
  private readonly onSaved?: (filePath: string, taskCount: number) => void;
  private readonly nowMs: () => number;
  private loadedFromDisk = false;
  private recoveredInterrupted = 0;

  constructor(options: PersistentMcpTaskStoreOptions) {
    if (typeof options.filePath !== 'string' || options.filePath.trim().length === 0) {
      throw new PersistentTaskStoreError('PersistentMcpTaskStore cần filePath là chuỗi không rỗng.');
    }
    this.filePath = options.filePath;
    this.maxPersistedTasks = Math.max(
      1,
      options.maxPersistedTasks ?? PERSISTENT_TASK_STORE_MAX_TASKS_DEFAULT,
    );
    this.autosave = options.autosave ?? true;
    this.onCorrupt = options.onCorrupt;
    this.onSaved = options.onSaved;
    this.nowMs = options.nowMs ?? Date.now;
    this.store = new McpTaskStore(options);
  }

  /** Store trong bộ nhớ (để server gọi trực tiếp khi cần). */
  get inner(): McpTaskStore {
    return this.store;
  }

  /** Đường dẫn file snapshot. */
  get snapshotPath(): string {
    return this.filePath;
  }

  /** True khi đã load() ít nhất một lần. */
  get loaded(): boolean {
    return this.loadedFromDisk;
  }

  /** Số task bị gián đoạn (working/input_required) lúc load và đã đánh failed. */
  get recoveredInterruptedCount(): number {
    return this.recoveredInterrupted;
  }

  /** Số task hiện có (delegate store gốc). */
  get size(): number {
    return this.store.size;
  }

  /**
   * Đọc snapshot từ đĩa và khôi phục task terminal. Task đang
   * `working` / `input_required` lúc lưu được đánh `failed`
   * (error "server đã restart…") vì runner không còn sống.
   * File không tồn tại → store rỗng, không lỗi. File hỏng →
   * store rỗng + gọi `onCorrupt`. Trả số task đã khôi phục.
   */
  load(): number {
    this.loadedFromDisk = true;
    this.recoveredInterrupted = 0;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      this.onCorrupt?.(this.filePath, err as Error);
      return 0;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.onCorrupt?.(this.filePath, err as Error);
      return 0;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed['tasks'])) {
      this.onCorrupt?.(
        this.filePath,
        new Error('Snapshot task không đúng định dạng (thiếu mảng "tasks").'),
      );
      return 0;
    }
    const records = parsed['tasks'] as unknown[];
    let restored = 0;
    for (const item of records) {
      const record = this.parseRecord(item);
      if (!record) continue;
      // Task dở dang lúc crash → failed trung thực (runner đã chết).
      if (record.status === 'working' || record.status === 'input_required') {
        record.status = 'failed';
        record.error = 'Task bị gián đoạn: server đã restart khi task đang chạy.';
        record.inputRequest = undefined;
        this.recoveredInterrupted += 1;
      }
      this.store.restore(record);
      restored += 1;
    }
    this.store.sweepExpired(this.nowMs());
    return restored;
  }

  /**
   * Ghi snapshot hiện tại xuống đĩa (atomic: tmp + rename).
   * Chỉ giữ tối đa `maxPersistedTasks` record mới nhất (theo
   * updatedAtMs). Trả số record đã ghi.
   */
  save(): number {
    const tasks = this.store.list();
    const sorted = [...tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const kept = sorted.slice(0, this.maxPersistedTasks);
    const file: PersistentTaskSnapshotFile = {
      formatVersion: PERSISTENT_TASK_STORE_FORMAT_VERSION,
      savedAtMs: this.nowMs(),
      tasks: kept.map((t) => this.toRecord(t)),
    };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // tmp không tồn tại — bỏ qua.
      }
      throw new PersistentTaskStoreError(
        `Không ghi được snapshot task xuống ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.onSaved?.(this.filePath, kept.length);
    return kept.length;
  }

  /**
   * Submit một job (như `McpTaskStore.submit`) rồi autosave.
   * Runner hoàn thành / fail cũng autosave (bọc promise).
   */
  submit(
    method: string,
    params: Record<string, unknown>,
    runner: (ctx: McpTaskRunnerContext) => Promise<unknown>,
    options: { pollIntervalMs?: number; ttlMs?: number } = {},
  ): ServerTaskHandleData {
    const handle = this.store.submit(method, params, async (ctx) => {
      try {
        const result = await runner(ctx);
        // Autosave sau khi runner xong (status đổi trong store gốc
        // qua promise chain của submit) — hẹn một tick để store
        // gốc kịp cập nhật status trước khi snapshot.
        setTimeout(() => {
          try {
            this.save();
          } catch {
            // Autosave lỗi không được làm fail task đã xong.
          }
        }, 0);
        return result;
      } catch (err) {
        setTimeout(() => {
          try {
            this.save();
          } catch {
            // Như trên.
          }
        }, 0);
        throw err;
      }
    }, options);
    this.maybeAutosave();
    return handle;
  }

  /** Park task ở input_required (delegate + autosave). */
  requestInput(
    taskId: string,
    prompt?: string,
    schema?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const out = this.store.requestInput(taskId, prompt, schema);
    this.maybeAutosave();
    return out;
  }

  /** Deliver input cho task input_required (delegate + autosave). */
  update(taskId: string, input: Record<string, unknown>): ServerTaskHandleData {
    const out = this.store.update(taskId, input);
    this.maybeAutosave();
    return out;
  }

  /** Huỷ task (delegate + autosave). */
  cancel(taskId: string): ServerTaskHandleData {
    const out = this.store.cancel(taskId);
    this.maybeAutosave();
    return out;
  }

  /** Đọc một task (delegate). */
  get(taskId: string): StoredMcpTask {
    return this.store.get(taskId);
  }

  /** Liệt kê task (delegate, mới nhất trước). */
  list(status?: ServerTaskStatus): StoredMcpTask[] {
    return this.store.list(status);
  }

  /** Handle client-facing cho một task (delegate). */
  toHandleData(task: StoredMcpTask, pollIntervalMs?: number): ServerTaskHandleData {
    return this.store.toHandleData(task, pollIntervalMs);
  }

  /** Xoá task hết hạn (delegate + autosave khi có thay đổi). */
  sweepExpired(nowMs?: number): number {
    const removed = this.store.sweepExpired(nowMs ?? this.nowMs());
    if (removed > 0) this.maybeAutosave();
    return removed;
  }

  /** Xoá file snapshot (vd reset server). Trả true khi file đã xoá. */
  clearSnapshot(): boolean {
    try {
      fs.unlinkSync(this.filePath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new PersistentTaskStoreError(
        `Không xoá được snapshot task ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private maybeAutosave(): void {
    if (!this.autosave) return;
    try {
      this.save();
    } catch {
      // Autosave lỗi không được làm fail thao tác chính.
    }
  }

  private toRecord(task: StoredMcpTask): PersistedMcpTaskRecord {
    const record: PersistedMcpTaskRecord = {
      taskId: task.taskId,
      method: task.method,
      params: (sanitizeJsonValue(task.params) as Record<string, unknown>) ?? {},
      status: task.status,
      createdAtMs: task.createdAtMs,
      updatedAtMs: task.updatedAtMs,
    };
    if (task.result !== undefined) record.result = sanitizeJsonValue(task.result);
    if (task.error !== undefined) record.error = task.error;
    if (task.inputRequest !== undefined) {
      record.inputRequest = {
        ...(task.inputRequest.prompt !== undefined ? { prompt: task.inputRequest.prompt } : {}),
        ...(task.inputRequest.schema !== undefined
          ? { schema: sanitizeJsonValue(task.inputRequest.schema) as Record<string, unknown> }
          : {}),
      };
    }
    if (task.progress !== undefined) record.progress = task.progress;
    if (task.progressMessage !== undefined) record.progressMessage = task.progressMessage;
    if (task.expiresAtMs !== undefined) record.expiresAtMs = task.expiresAtMs;
    return record;
  }

  private parseRecord(value: unknown): PersistedMcpTaskRecord | null {
    if (!isRecord(value)) return null;
    if (typeof value['taskId'] !== 'string' || !value['taskId']) return null;
    if (typeof value['method'] !== 'string' || !value['method']) return null;
    const status = value['status'];
    if (
      status !== 'working' &&
      status !== 'input_required' &&
      status !== 'completed' &&
      status !== 'failed' &&
      status !== 'cancelled'
    ) {
      return null;
    }
    const createdAtMs = typeof value['createdAtMs'] === 'number' ? value['createdAtMs'] : 0;
    const updatedAtMs = typeof value['updatedAtMs'] === 'number' ? value['updatedAtMs'] : createdAtMs;
    const record: PersistedMcpTaskRecord = {
      taskId: value['taskId'] as string,
      method: value['method'] as string,
      params: isRecord(value['params']) ? (value['params'] as Record<string, unknown>) : {},
      status: status as ServerTaskStatus,
      createdAtMs,
      updatedAtMs,
    };
    if (value['result'] !== undefined) record.result = value['result'];
    if (typeof value['error'] === 'string') record.error = value['error'];
    if (isRecord(value['inputRequest'])) {
      record.inputRequest = {
        ...(typeof value['inputRequest']['prompt'] === 'string'
          ? { prompt: value['inputRequest']['prompt'] as string }
          : {}),
        ...(isRecord(value['inputRequest']['schema'])
          ? { schema: value['inputRequest']['schema'] as Record<string, unknown> }
          : {}),
      };
    }
    if (typeof value['progress'] === 'number') record.progress = value['progress'];
    if (typeof value['progressMessage'] === 'string') {
      record.progressMessage = value['progressMessage'];
    }
    if (typeof value['expiresAtMs'] === 'number') record.expiresAtMs = value['expiresAtMs'];
    return record;
  }
}
