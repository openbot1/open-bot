/**
 * SWE-bench task store — lưu task eval durable (v1.04, Team T6).
 *
 * `observability/sweBenchEval.ts` chạy task được truyền vào bằng code;
 * module này là nơi task SỐNG lâu dài: một file
 * `<baseDir>/swe-tasks.json` (atomic write, mode 0600, cùng posture
 * với evalHarness `evals.json`) chứa các task đã validate. UI/CLI
 * tạo/sửa/xóa task qua store này rồi đưa task vào `runSweBenchTask`
 * khi chạy eval.
 *
 * Task trong store là định nghĩa (problem statement + setup files +
 * test command), KHÔNG chứa đáp án hay patch mẫu — chấm bằng chạy
 * test, không so với đáp án (xem sweBenchEval.ts). Store không chứa
 * secret: setup files là code/test fixture của user.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateSweBenchTask, type SweBenchTask } from './sweBenchEval';

/** File lưu task eval. */
export const SWE_TASKS_FILE = 'swe-tasks.json';

/** Đầu vào tạo task (id tự sinh khi không cho). */
export interface CreateSweTaskInput {
  id?: string;
  title: string;
  problemStatement: string;
  setupFiles?: Record<string, string>;
  failToPass: SweBenchTask['failToPass'];
  passToPass?: SweBenchTask['passToPass'];
  testTimeoutMs?: number;
  solverTimeoutMs?: number;
}

/** Task đã lưu (kèm metadata). */
export interface StoredSweTask extends SweBenchTask {
  createdAt: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Đường dẫn file store. */
export function getSweTasksPath(baseDir: string): string {
  return path.join(baseDir, SWE_TASKS_FILE);
}

function parseStoredTask(raw: unknown, index: number): StoredSweTask {
  if (!isRecord(raw)) throw new Error(`swe task at index ${index} is not an object.`);
  const task = validateSweBenchTask(raw);
  const { createdAt, updatedAt } = raw;
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') {
    throw new Error(`swe task ${task.id} needs string createdAt/updatedAt.`);
  }
  return { ...task, createdAt, updatedAt };
}

/** Đọc toàn bộ task (file chưa có → rỗng; file hỏng → throw rõ). */
export function loadSweTasks(baseDir: string): StoredSweTask[] {
  const filePath = getSweTasksPath(baseDir);
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
    throw new Error(`swe tasks file ${filePath} is not valid JSON — refusing to guess; fix or remove it.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`swe tasks file ${filePath} must contain a JSON array.`);
  return parsed.map((entry, index) => parseStoredTask(entry, index));
}

/** Ghi toàn bộ task (atomic: tmp + rename, mode 0600). */
export function saveSweTasks(baseDir: string, tasks: StoredSweTask[]): void {
  fs.mkdirSync(baseDir, { recursive: true });
  const filePath = getSweTasksPath(baseDir);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(tasks, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Filesystem không hỗ trợ chmod — bỏ qua.
  }
}

/** Validate đầu vào tạo task (throw khi sai). */
export function validateCreateSweTaskInput(raw: unknown): CreateSweTaskInput {
  if (!isRecord(raw)) throw new Error('swe task input must be an object.');
  const { id, title, problemStatement, setupFiles, failToPass, passToPass, testTimeoutMs, solverTimeoutMs } = raw;
  if (id !== undefined && (typeof id !== 'string' || id.trim().length === 0)) {
    throw new Error('swe task id must be a non-empty string when given.');
  }
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('swe task needs a non-empty title.');
  if (typeof problemStatement !== 'string' || problemStatement.trim().length === 0) {
    throw new Error('swe task needs a non-empty problemStatement.');
  }
  // Tái dùng validator của runner cho phần còn lại (failToPass, setupFiles, timeout...).
  validateSweBenchTask({
    id: id ?? 'tmp-validate',
    title,
    problemStatement,
    ...(setupFiles !== undefined ? { setupFiles } : {}),
    failToPass,
    ...(passToPass !== undefined ? { passToPass } : []),
    ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
    ...(solverTimeoutMs !== undefined ? { solverTimeoutMs } : {}),
  });
  return {
    ...(id !== undefined ? { id: id.trim() } : {}),
    title: title.trim(),
    problemStatement,
    ...(setupFiles !== undefined ? { setupFiles: setupFiles as Record<string, string> } : {}),
    failToPass: failToPass as SweBenchTask['failToPass'],
    ...(passToPass !== undefined ? { passToPass: passToPass as SweBenchTask['passToPass'] } : {}),
    ...(testTimeoutMs !== undefined ? { testTimeoutMs: testTimeoutMs as number } : {}),
    ...(solverTimeoutMs !== undefined ? { solverTimeoutMs: solverTimeoutMs as number } : {}),
  };
}

/** Tạo task mới (id trùng → throw). */
export function createSweTask(baseDir: string, input: CreateSweTaskInput): StoredSweTask {
  const valid = validateCreateSweTaskInput(input);
  const tasks = loadSweTasks(baseDir);
  const id = valid.id ?? `swe-${crypto.randomUUID()}`;
  if (tasks.some((t) => t.id === id)) throw new Error(`swe task id "${id}" already exists.`);
  const now = new Date().toISOString();
  const task: StoredSweTask = {
    id,
    title: valid.title,
    problemStatement: valid.problemStatement,
    ...(valid.setupFiles !== undefined ? { setupFiles: valid.setupFiles } : {}),
    failToPass: valid.failToPass,
    passToPass: valid.passToPass ?? [],
    ...(valid.testTimeoutMs !== undefined ? { testTimeoutMs: valid.testTimeoutMs } : {}),
    ...(valid.solverTimeoutMs !== undefined ? { solverTimeoutMs: valid.solverTimeoutMs } : {}),
    createdAt: now,
    updatedAt: now,
  };
  saveSweTasks(baseDir, [...tasks, task]);
  return task;
}

/** Lấy task theo id (không có → null). */
export function getSweTask(baseDir: string, taskId: string): StoredSweTask | null {
  return loadSweTasks(baseDir).find((t) => t.id === taskId) ?? null;
}

/** Liệt kê task (mới nhất trước theo updatedAt). */
export function listSweTasks(baseDir: string): StoredSweTask[] {
  return loadSweTasks(baseDir).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * Cập nhật task (chỉ các field cho phép; id không đổi; updatedAt tự
 * cập nhật). Task không có → throw.
 */
export function updateSweTask(
  baseDir: string,
  taskId: string,
  patch: Partial<Omit<CreateSweTaskInput, 'id'>>,
): StoredSweTask {
  const tasks = loadSweTasks(baseDir);
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index === -1) throw new Error(`swe task "${taskId}" does not exist.`);
  const current = tasks[index];
  const merged = validateSweBenchTask({
    id: current.id,
    title: patch.title ?? current.title,
    problemStatement: patch.problemStatement ?? current.problemStatement,
    setupFiles: patch.setupFiles ?? current.setupFiles,
    failToPass: patch.failToPass ?? current.failToPass,
    passToPass: patch.passToPass ?? current.passToPass,
    ...(patch.testTimeoutMs ?? current.testTimeoutMs !== undefined ? { testTimeoutMs: patch.testTimeoutMs ?? current.testTimeoutMs } : {}),
    ...(patch.solverTimeoutMs ?? current.solverTimeoutMs !== undefined ? { solverTimeoutMs: patch.solverTimeoutMs ?? current.solverTimeoutMs } : {}),
  });
  const updated: StoredSweTask = { ...merged, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
  tasks[index] = updated;
  saveSweTasks(baseDir, tasks);
  return updated;
}

/** Xóa task (không có → throw). Trả về task đã xóa. */
export function removeSweTask(baseDir: string, taskId: string): StoredSweTask {
  const tasks = loadSweTasks(baseDir);
  const found = tasks.find((t) => t.id === taskId);
  if (!found) throw new Error(`swe task "${taskId}" does not exist.`);
  saveSweTasks(baseDir, tasks.filter((t) => t.id !== taskId));
  return found;
}
