/**
 * Agent Teams v1 — shared task list (v1.09, Đội T1).
 *
 * Danh sách task chia sẻ của team: lead thêm task, teammate claim
 * task, task có dependency (chỉ chạy sau khi dependency done) và
 * file-lock (task chạm file nào thì khóa file đó — task khác chạm
 * cùng file không được claim chừng nào lock chưa nhả).
 *
 * Thuần logic, không I/O: thao tác trên mảng task truyền vào, trả về
 * bản sao mới (không mutate input) để service dễ snapshot/undo.
 * Claim là nguyên tử trong process: hàm `claimTask` kiểm tra mọi
 * điều kiện rồi gán owner trong cùng một lần gọi, không có await ở
 * giữa — hai teammate gọi liên tiếp thì người sau thấy task đã có
 * chủ và nhận lỗi rõ ràng.
 */

import {
  newTeamId,
  normalizeTeamName,
  type TeamTask,
  type TeamTaskPriority,
  type TeamTaskStatus,
  type AddTeamTaskInput,
  MAX_TASKS_PER_TEAM,
} from './types';

/** Kết quả một thao tác trên task list (thành công hoặc lỗi rõ ràng). */
export type TaskListResult<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; error: string; value?: undefined };

function ok<T>(value: T): TaskListResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): TaskListResult<T> {
  return { ok: false, error };
}

/** Tạo task mới từ input (chưa chèn vào danh sách). */
export function createTeamTask(input: AddTeamTaskInput, now = Date.now()): TeamTask {
  const title = normalizeTeamName(input.title);
  const priority: TeamTaskPriority =
    input.priority !== undefined && input.priority >= 1 && input.priority <= 5
      ? input.priority
      : 3;
  return {
    id: newTeamId('task'),
    title,
    detail: input.detail?.trim() ? input.detail.trim() : undefined,
    status: 'pending',
    dependsOn: [...new Set(input.dependsOn ?? [])],
    priority,
    touchesFiles: [...new Set((input.touchesFiles ?? []).map((f) => f.trim()).filter(Boolean))],
    attempts: 0,
    maxAttempts:
      input.maxAttempts !== undefined && Number.isInteger(input.maxAttempts) && input.maxAttempts >= 1
        ? input.maxAttempts
        : 3,
    createdAt: now,
    updatedAt: now,
  };
}

/** Validate task mới trước khi thêm: tên, dependency tồn tại, không chu trình, không vượt trần. */
export function validateNewTask(
  tasks: TeamTask[],
  input: AddTeamTaskInput,
): string[] {
  const errors: string[] = [];
  if (!normalizeTeamName(input.title)) errors.push('Tiêu đề task không được rỗng.');
  if (tasks.length >= MAX_TASKS_PER_TEAM) {
    errors.push(`Team đã đạt tối đa ${MAX_TASKS_PER_TEAM} task.`);
  }
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  const known = new Set(tasks.map((t) => t.id));
  for (const dep of dependsOn) {
    if (!known.has(dep)) errors.push(`Dependency không tồn tại: ${dep}.`);
  }
  return errors;
}

/**
 * Phát hiện chu trình dependency trong danh sách task.
 * Trả về danh sách id tạo thành chu trình (rỗng = không có chu trình).
 */
export function findDependencyCycle(tasks: TeamTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const dfs = (id: string): string[] | null => {
    if (visited.has(id)) return null;
    if (visiting.has(id)) {
      const at = stack.indexOf(id);
      return [...stack.slice(at), id];
    }
    const task = byId.get(id);
    if (!task) return null;
    visiting.add(id);
    stack.push(id);
    for (const dep of task.dependsOn) {
      const hit = dfs(dep);
      if (hit) return hit;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const task of tasks) {
    const hit = dfs(task.id);
    if (hit) return hit;
  }
  return [];
}

/** Thứ tự topo của task (dependency trước, task sau); chu trình → trả về null. */
export function topoOrder(tasks: TeamTask[]): TeamTask[] | null {
  if (findDependencyCycle(tasks).length > 0) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const out: TeamTask[] = [];
  const visit = (task: TeamTask): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    for (const depId of task.dependsOn) {
      const dep = byId.get(depId);
      if (dep) visit(dep);
    }
    out.push(task);
  };
  for (const task of tasks) visit(task);
  return out;
}

/** Dependency của task đã done hết chưa. */
export function dependenciesDone(tasks: TeamTask[], task: TeamTask): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependsOn.every((depId) => byId.get(depId)?.status === 'done');
}

/** Dependency nào của task đang failed/blocked (khiến task không chạy được). */
export function blockingDependencies(tasks: TeamTask[], task: TeamTask): TeamTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependsOn
    .map((depId) => byId.get(depId))
    .filter((d): d is TeamTask => !!d && (d.status === 'failed' || d.status === 'blocked'));
}

/** Task đã sẵn sàng để claim chưa: pending + dependency done + chưa hết lượt thử. */
export function isTaskReady(tasks: TeamTask[], task: TeamTask): boolean {
  if (task.status !== 'pending') return false;
  if (task.attempts >= task.maxAttempts) return false;
  return dependenciesDone(tasks, task);
}

/** Các task sẵn sàng claim, xếp theo priority cao trước rồi tạo trước. */
export function readyTasks(tasks: TeamTask[]): TeamTask[] {
  return tasks
    .filter((t) => isTaskReady(tasks, t))
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
}

/**
 * File-lock: map file → task đang giữ. Chỉ tính task ở trạng thái
 * claimed/in-progress (pending chưa giữ file, done/failed đã nhả).
 */
export function buildFileLocks(tasks: TeamTask[]): Map<string, string> {
  const locks = new Map<string, string>();
  for (const task of tasks) {
    if (task.status !== 'claimed' && task.status !== 'in-progress') continue;
    for (const file of task.touchesFiles) {
      if (!locks.has(file)) locks.set(file, task.id);
    }
  }
  return locks;
}

/** File nào trong danh sách đang bị task khác khóa (trả về file + task giữ). */
export function lockedFiles(
  tasks: TeamTask[],
  task: TeamTask,
): { file: string; heldByTaskId: string }[] {
  const locks = buildFileLocks(tasks);
  const out: { file: string; heldByTaskId: string }[] = [];
  for (const file of task.touchesFiles) {
    const holder = locks.get(file);
    if (holder && holder !== task.id) out.push({ file, heldByTaskId: holder });
  }
  return out;
}

/**
 * Claim một task cho teammate. Nguyên tử trong process: mọi kiểm tra
 * xong mới gán owner. Trả về task mới (bản sao) hoặc lỗi rõ ràng.
 * Lý do từ chối theo thứ tự: không tìm thấy → sai trạng thái →
 * dependency chưa xong → dependency lỗi → hết lượt thử → file bị khóa.
 */
export function claimTask(
  tasks: TeamTask[],
  taskId: string,
  teammateId: string,
  now = Date.now(),
): TaskListResult<{ tasks: TeamTask[]; task: TeamTask }> {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return fail(`Không tìm thấy task ${taskId}.`);
  const task = tasks[idx];
  if (task.status !== 'pending') {
    return fail(
      `Task "${task.title}" đang ở trạng thái ${task.status}, không claim được (chỉ claim task pending).`,
    );
  }
  if (task.attempts >= task.maxAttempts) {
    return fail(`Task "${task.title}" đã hết ${task.maxAttempts} lượt thử.`);
  }
  if (!dependenciesDone(tasks, task)) {
    const missing = task.dependsOn.filter((d) => tasks.find((t) => t.id === d)?.status !== 'done');
    return fail(`Task "${task.title}" còn chờ dependency chưa xong: ${missing.join(', ')}.`);
  }
  const blockers = blockingDependencies(tasks, task);
  if (blockers.length > 0) {
    return fail(
      `Task "${task.title}" bị chặn vì dependency lỗi: ${blockers.map((b) => b.title).join(', ')}.`,
    );
  }
  const locked = lockedFiles(tasks, task);
  if (locked.length > 0) {
    return fail(
      `Task "${task.title}" chạm file đang bị khóa: ${locked
        .map((l) => `${l.file} (task ${l.heldByTaskId})`)
        .join(', ')}.`,
    );
  }
  const claimed: TeamTask = {
    ...task,
    status: 'claimed',
    claimedBy: teammateId,
    claimedAt: now,
    attempts: task.attempts + 1,
    updatedAt: now,
  };
  const next = [...tasks];
  next[idx] = claimed;
  return ok({ tasks: next, task: claimed });
}

/** Chuyển task claimed → in-progress (teammate bắt đầu làm thật). */
export function startTask(
  tasks: TeamTask[],
  taskId: string,
  teammateId: string,
  now = Date.now(),
): TaskListResult<{ tasks: TeamTask[]; task: TeamTask }> {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return fail(`Không tìm thấy task ${taskId}.`);
  const task = tasks[idx];
  if (task.status !== 'claimed') {
    return fail(`Task "${task.title}" đang ở trạng thái ${task.status}, chỉ start task đã claim.`);
  }
  if (task.claimedBy !== teammateId) {
    return fail(`Task "${task.title}" đang thuộc về teammate khác, không start được.`);
  }
  const started: TeamTask = { ...task, status: 'in-progress', startedAt: now, updatedAt: now };
  const next = [...tasks];
  next[idx] = started;
  return ok({ tasks: next, task: started });
}

/** Nhả claim: task claimed/in-progress → pending (giữ nguyên attempts, xóa owner). */
export function releaseTask(
  tasks: TeamTask[],
  taskId: string,
  teammateId: string,
  now = Date.now(),
): TaskListResult<{ tasks: TeamTask[]; task: TeamTask }> {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return fail(`Không tìm thấy task ${taskId}.`);
  const task = tasks[idx];
  if (task.status !== 'claimed' && task.status !== 'in-progress') {
    return fail(`Task "${task.title}" đang ở trạng thái ${task.status}, không nhả được.`);
  }
  if (task.claimedBy !== teammateId) {
    return fail(`Task "${task.title}" đang thuộc về teammate khác, không nhả được.`);
  }
  const released: TeamTask = {
    ...task,
    status: 'pending',
    claimedBy: undefined,
    claimedAt: undefined,
    startedAt: undefined,
    updatedAt: now,
  };
  const next = [...tasks];
  next[idx] = released;
  return ok({ tasks: next, task: released });
}

/** Hoàn thành task: chỉ owner ở trạng thái claimed/in-progress mới được done. */
export function completeTask(
  tasks: TeamTask[],
  taskId: string,
  teammateId: string,
  resultSummary?: string,
  now = Date.now(),
): TaskListResult<{ tasks: TeamTask[]; task: TeamTask }> {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return fail(`Không tìm thấy task ${taskId}.`);
  const task = tasks[idx];
  if (task.status !== 'claimed' && task.status !== 'in-progress') {
    return fail(`Task "${task.title}" đang ở trạng thái ${task.status}, không done được.`);
  }
  if (task.claimedBy !== teammateId) {
    return fail(`Task "${task.title}" đang thuộc về teammate khác, không done được.`);
  }
  const done: TeamTask = {
    ...task,
    status: 'done',
    resultSummary: resultSummary?.trim() ? resultSummary.trim() : undefined,
    finishedAt: now,
    updatedAt: now,
  };
  const next = [...tasks];
  next[idx] = done;
  return ok({ tasks: next, task: done });
}

/**
 * Đánh dấu task thất bại: còn lượt thử → về pending để teammate
 * khác claim lại; hết lượt → failed hẳn. Trả về task mới + cho biết
 * có được thử lại không.
 */
export function failTask(
  tasks: TeamTask[],
  taskId: string,
  teammateId: string,
  error: string,
  now = Date.now(),
): TaskListResult<{ tasks: TeamTask[]; task: TeamTask; retryable: boolean }> {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return fail(`Không tìm thấy task ${taskId}.`);
  const task = tasks[idx];
  if (task.status !== 'claimed' && task.status !== 'in-progress') {
    return fail(`Task "${task.title}" đang ở trạng thái ${task.status}, không fail được.`);
  }
  if (task.claimedBy !== teammateId) {
    return fail(`Task "${task.title}" đang thuộc về teammate khác, không fail được.`);
  }
  const retryable = task.attempts < task.maxAttempts;
  const failed: TeamTask = {
    ...task,
    status: retryable ? 'pending' : 'failed',
    claimedBy: undefined,
    claimedAt: undefined,
    startedAt: undefined,
    error: error.trim() || 'Không rõ lỗi.',
    finishedAt: retryable ? undefined : now,
    updatedAt: now,
  };
  const next = [...tasks];
  next[idx] = failed;
  return ok({ tasks: next, task: failed, retryable });
}

/** Đếm task theo trạng thái. */
export function countTasksByStatus(tasks: TeamTask[]): Record<TeamTaskStatus, number> {
  const counts: Record<TeamTaskStatus, number> = {
    pending: 0,
    claimed: 0,
    'in-progress': 0,
    done: 0,
    failed: 0,
    blocked: 0,
  };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}

/**
 * Claim treo: task claimed/in-progress quá claimTimeoutMs mà chưa
 * xong → coi như treo, lead có thể thu hồi (reclaim). Trả về task treo.
 */
export function findStaleClaims(
  tasks: TeamTask[],
  claimTimeoutMs: number,
  now = Date.now(),
): TeamTask[] {
  return tasks.filter(
    (t) =>
      (t.status === 'claimed' || t.status === 'in-progress') &&
      t.claimedAt !== undefined &&
      now - t.claimedAt > claimTimeoutMs,
  );
}

/** Thu hồi claim treo: task → pending, xóa owner (lead thu hồi). */
export function reclaimStaleTask(
  tasks: TeamTask[],
  taskId: string,
  now = Date.now(),
): TaskListResult<{ tasks: TeamTask[]; task: TeamTask }> {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return fail(`Không tìm thấy task ${taskId}.`);
  const task = tasks[idx];
  if (task.status !== 'claimed' && task.status !== 'in-progress') {
    return fail(`Task "${task.title}" không ở trạng thái claim, không thu hồi được.`);
  }
  const reclaimed: TeamTask = {
    ...task,
    status: 'pending',
    claimedBy: undefined,
    claimedAt: undefined,
    startedAt: undefined,
    updatedAt: now,
  };
  const next = [...tasks];
  next[idx] = reclaimed;
  return ok({ tasks: next, task: reclaimed });
}
