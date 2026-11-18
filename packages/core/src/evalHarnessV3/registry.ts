/**
 * Eval Harness v3 — eval registry (v1.35, Đội T4).
 *
 * Registry là nơi đăng ký task + gom task thành eval set (bộ eval):
 * - Một task đăng ký một lần, dùng lại trong nhiều set (vd set
 *   `v3-smoke` chạy nhanh mỗi commit, set `v3-nightly` chạy đầy đủ).
 * - Set có version: đổi danh sách task thì version tăng — baseline và
 *   gate so sánh theo đúng version của set, không so nhầm bộ khác.
 * - Registry lưu trên đĩa (`<baseDir>/eval-harness-v3/registry.json`,
 *   mode 0600): app khởi động lại vẫn còn set của user; builtin set
 *   (từ suite mẫu) luôn có sẵn và không ghi đè set của user cùng id
 *   khi user đã sửa (user thắng builtin).
 * - Chạy theo bộ: `resolveEvalSet` trả về danh sách task theo đúng
 *   thứ tự set, bỏ qua task id không còn đăng ký (ghi rõ trong
 *   `missing` để người chạy biết, không fail lặng).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EVAL_HARNESS_V3_SET_ID_RE,
  type EvalHarnessV3EvalSet,
  type EvalHarnessV3RegistryEntry,
  type EvalHarnessV3Task,
} from './types.js';

/** Tên file registry trên đĩa. */
export const EVAL_HARNESS_V3_REGISTRY_FILE = 'registry.json';
/** Thư mục dữ liệu v3 trong baseDir của app. */
export const EVAL_HARNESS_V3_DIR = 'eval-harness-v3';

/** Đường dẫn file registry trong baseDir. */
export function getEvalHarnessV3RegistryPath(baseDir: string): string {
  return path.join(baseDir, EVAL_HARNESS_V3_DIR, EVAL_HARNESS_V3_REGISTRY_FILE);
}

/** Dạng lưu trên đĩa: set + task id đã đăng ký (task đầy đủ lưu riêng). */
export interface EvalHarnessV3RegistryDisk {
  version: 1;
  sets: EvalHarnessV3EvalSet[];
  /** Task đăng ký kèm: map id → task đầy đủ. */
  tasks: Record<string, EvalHarnessV3Task>;
  updatedAt: number;
}

function emptyDisk(): EvalHarnessV3RegistryDisk {
  return { version: 1, sets: [], tasks: {}, updatedAt: Date.now() };
}

/** Registry trong RAM: task + set, đồng bộ ra đĩa khi đổi. */
export class EvalHarnessV3Registry {
  private readonly tasks = new Map<string, EvalHarnessV3Task>();
  private readonly sets = new Map<string, EvalHarnessV3EvalSet>();

  /** Đăng ký một task (ghi đè task cùng id, giữ nguyên set chứa nó). */
  registerTask(task: EvalHarnessV3Task): void {
    this.tasks.set(task.id, task);
  }

  /** Đăng ký nhiều task cùng lúc. */
  registerTasks(tasks: EvalHarnessV3Task[]): void {
    for (const task of tasks) this.registerTask(task);
  }

  /** Gỡ một task khỏi registry (và khỏi mọi set chứa nó). */
  unregisterTask(taskId: string): boolean {
    const existed = this.tasks.delete(taskId);
    for (const set of this.sets.values()) {
      const next = set.taskIds.filter((id) => id !== taskId);
      if (next.length !== set.taskIds.length) {
        set.taskIds = next;
        set.updatedAt = Date.now();
      }
    }
    return existed;
  }

  /** Lấy task theo id (undefined khi chưa đăng ký). */
  getTask(taskId: string): EvalHarnessV3Task | undefined {
    return this.tasks.get(taskId);
  }

  /** Liệt kê toàn bộ task đã đăng ký (theo id). */
  listTasks(): EvalHarnessV3Task[] {
    return [...this.tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Lọc task theo kind / difficulty / tag (kết hợp AND). */
  findTasks(filter: {
    kind?: EvalHarnessV3Task['kind'];
    difficulty?: EvalHarnessV3Task['difficulty'];
    tag?: string;
  }): EvalHarnessV3Task[] {
    return this.listTasks().filter(
      (t) =>
        (filter.kind === undefined || t.kind === filter.kind) &&
        (filter.difficulty === undefined || t.difficulty === filter.difficulty) &&
        (filter.tag === undefined || (t.tags ?? []).includes(filter.tag)),
    );
  }

  /** Mục đăng ký của một task (task + set chứa nó). */
  getEntry(taskId: string): EvalHarnessV3RegistryEntry | undefined {
    const task = this.tasks.get(taskId);
    if (task === undefined) return undefined;
    const setIds = [...this.sets.values()]
      .filter((s) => s.taskIds.includes(taskId))
      .map((s) => s.id);
    return { task, setIds, registeredAt: Date.now() };
  }

  /** Tạo hoặc cập nhật một eval set (version tăng khi danh sách task đổi). */
  upsertSet(input: {
    id: string;
    name: string;
    description: string;
    taskIds: string[];
    tags?: string[];
  }): EvalHarnessV3EvalSet {
    if (!EVAL_HARNESS_V3_SET_ID_RE.test(input.id)) {
      throw new Error(`Set id không hợp lệ: "${input.id}" (chữ thường, số, "-" và "_").`);
    }
    const deduped = [...new Set(input.taskIds)];
    const existing = this.sets.get(input.id);
    const now = Date.now();
    if (existing !== undefined) {
      const changed =
        existing.taskIds.length !== deduped.length ||
        existing.taskIds.some((id, idx) => id !== deduped[idx]);
      const updated: EvalHarnessV3EvalSet = {
        ...existing,
        name: input.name,
        description: input.description,
        taskIds: deduped,
        tags: input.tags ?? existing.tags ?? [],
        version: changed ? existing.version + 1 : existing.version,
        updatedAt: now,
      };
      this.sets.set(input.id, updated);
      return updated;
    }
    const created: EvalHarnessV3EvalSet = {
      id: input.id,
      name: input.name,
      description: input.description,
      version: 1,
      taskIds: deduped,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.sets.set(input.id, created);
    return created;
  }

  /** Xoá một eval set (task trong set vẫn còn trong registry). */
  deleteSet(setId: string): boolean {
    return this.sets.delete(setId);
  }

  /** Lấy set theo id (undefined khi chưa có). */
  getSet(setId: string): EvalHarnessV3EvalSet | undefined {
    return this.sets.get(setId);
  }

  /** Liệt kê toàn bộ set (theo id). */
  listSets(): EvalHarnessV3EvalSet[] {
    return [...this.sets.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Resolve một set thành danh sách task theo đúng thứ tự set.
   * Task id không còn đăng ký liệt kê trong `missing` (không throw).
   */
  resolveEvalSet(setId: string): { set: EvalHarnessV3EvalSet; tasks: EvalHarnessV3Task[]; missing: string[] } {
    const set = this.sets.get(setId);
    if (set === undefined) throw new Error(`Không có eval set "${setId}".`);
    const tasks: EvalHarnessV3Task[] = [];
    const missing: string[] = [];
    for (const id of set.taskIds) {
      const task = this.tasks.get(id);
      if (task === undefined) missing.push(id);
      else tasks.push(task);
    }
    return { set, tasks, missing };
  }

  /** Số task + số set trong registry. */
  size(): { tasks: number; sets: number } {
    return { tasks: this.tasks.size, sets: this.sets.size };
  }

  /** Chuyển registry thành dạng lưu đĩa. */
  toDisk(): EvalHarnessV3RegistryDisk {
    const tasks: Record<string, EvalHarnessV3Task> = {};
    for (const [id, task] of this.tasks) tasks[id] = task;
    return { version: 1, sets: this.listSets(), tasks, updatedAt: Date.now() };
  }

  /** Nạp registry từ dạng lưu đĩa (bỏ qua task/set hỏng, ghi rõ lý do). */
  static fromDisk(data: unknown): { registry: EvalHarnessV3Registry; skipped: string[] } {
    const registry = new EvalHarnessV3Registry();
    const skipped: string[] = [];
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      skipped.push('registry.json không phải object.');
      return { registry, skipped };
    }
    const disk = data as Record<string, unknown>;
    const tasks = disk['tasks'];
    if (typeof tasks === 'object' && tasks !== null) {
      for (const [id, task] of Object.entries(tasks as Record<string, unknown>)) {
        if (typeof task === 'object' && task !== null && (task as Record<string, unknown>)['id'] === id) {
          registry.tasks.set(id, task as EvalHarnessV3Task);
        } else {
          skipped.push(`Bỏ task "${id}" (không hợp lệ).`);
        }
      }
    }
    const sets = disk['sets'];
    if (Array.isArray(sets)) {
      for (const raw of sets) {
        if (
          typeof raw === 'object' && raw !== null &&
          typeof (raw as Record<string, unknown>)['id'] === 'string' &&
          Array.isArray((raw as Record<string, unknown>)['taskIds'])
        ) {
          registry.sets.set((raw as Record<string, unknown>)['id'] as string, raw as EvalHarnessV3EvalSet);
        } else {
          skipped.push('Bỏ một eval set (không hợp lệ).');
        }
      }
    }
    return { registry, skipped };
  }
}

/** Nạp registry từ đĩa (file không có → registry trống). */
export function loadEvalHarnessV3Registry(baseDir: string): { registry: EvalHarnessV3Registry; skipped: string[] } {
  const filePath = getEvalHarnessV3RegistryPath(baseDir);
  if (!fs.existsSync(filePath)) return { registry: new EvalHarnessV3Registry(), skipped: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return EvalHarnessV3Registry.fromDisk(parsed);
  } catch (err) {
    return { registry: new EvalHarnessV3Registry(), skipped: [`Không đọc được registry.json: ${(err as Error).message}`] };
  }
}

/** Lưu registry ra đĩa (mode 0600, tạo thư mục khi cần). */
export function saveEvalHarnessV3Registry(baseDir: string, registry: EvalHarnessV3Registry): string {
  const filePath = getEvalHarnessV3RegistryPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(registry.toDisk(), null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod fail trên Windows — không chặn lưu registry.
  }
  return filePath;
}

/** Render registry thành text (list task + set). */
export function renderEvalHarnessV3RegistryText(registry: EvalHarnessV3Registry): string {
  const lines: string[] = [
    `Eval registry v3: ${registry.size().tasks} tasks, ${registry.size().sets} sets`,
  ];
  for (const set of registry.listSets()) {
    lines.push(`  set ${set.id} (v${set.version}): ${set.name} — ${set.taskIds.length} tasks [${set.taskIds.join(', ')}]`);
  }
  for (const task of registry.listTasks()) {
    lines.push(`  task ${task.id} (${task.kind}, ${task.difficulty}): ${task.description}`);
  }
  return `${lines.join('\n')}\n`;
}
