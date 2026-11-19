/**
 * Task set của Eval Harness v4 (v1.44, Đội T2).
 *
 * Một "task set" là danh sách task Harbor sẽ chạy trong một lần
 * chạy suite, resolve từ 3 nguồn (theo thứ tự ưu tiên, id trùng
 * nhau thì nguồn sau thắng — task trên đĩa của user luôn thắng
 * task mẫu, để user override task mẫu bằng bản sửa của mình):
 *
 *   1. task mẫu v1.11 (`builtinHarborTasks` — 4 task),
 *   2. task mẫu V4 (`builtinEvalHarnessV4Tasks` — 4 task),
 *   3. thư mục task trên đĩa (`taskDirs` trong config, mỗi thư
 *      mục con = 1 task, load qua `loadHarborTasksFromDir`).
 *
 * Sau khi gom, áp bộ lọc `selection` của config theo thứ tự:
 * includeIds → includeGlobs → tags → kinds → excludeIds →
 * excludeGlobs. Task/dir nào load lỗi thì ghi vào `skipped` kèm
 * lý do — không im lặng mất task (phong cách của
 * `loadHarborTasksFromDir`).
 *
 * Module này chỉ resolve + lọc (đọc đĩa để load task, không chạy
 * task, không gọi model). Glob chỉ hỗ trợ `*` (bất kỳ chuỗi nào)
 * và `?` (một ký tự) — đủ cho `fix-*`, `*-csv`, không cần
 * minimatch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  loadHarborTasksFromDir,
  validateHarborTask,
  type HarborTask,
} from '../eval/harborTask';
import { builtinHarborTasks } from '../eval/harborLibrary';
import { builtinEvalHarnessV4Tasks } from './builtinTasks';
import type {
  EvalHarnessV4Config,
  EvalHarnessV4ResolvedTask,
  EvalHarnessV4TaskSelection,
  EvalHarnessV4TaskSet,
} from './types';

/**
 * Khớp một id với một glob đơn giản (`*` = bất kỳ chuỗi nào,
 * `?` = đúng một ký tự). Glob rỗng không khớp gì cả.
 */
export function matchEvalHarnessV4Glob(pattern: string, value: string): boolean {
  if (pattern === '') return false;
  let regex = '^';
  for (const ch of pattern) {
    if (ch === '*') regex += '.*';
    else if (ch === '?') regex += '.';
    else regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  regex += '$';
  return new RegExp(regex).test(value);
}

/** True khi id khớp ÍT NHẤT một glob trong danh sách. */
export function matchesAnyEvalHarnessV4Glob(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => matchEvalHarnessV4Glob(p, value));
}

/**
 * Áp bộ lọc selection lên một danh sách task đã load. Trả về task
 * giữ lại + task bị loại (kèm lý do lọc — để report giải thích
 * vì sao một task không chạy).
 */
export function filterHarborTasksBySelection(
  tasks: readonly HarborTask[],
  selection: EvalHarnessV4TaskSelection,
): { kept: HarborTask[]; excluded: { id: string; reason: string }[] } {
  const kept: HarborTask[] = [];
  const excluded: { id: string; reason: string }[] = [];
  for (const task of tasks) {
    const id = task.meta.id;
    if (selection.includeIds.length > 0 && !selection.includeIds.includes(id)) {
      excluded.push({ id, reason: `không nằm trong includeIds [${selection.includeIds.join(', ')}].` });
      continue;
    }
    if (selection.includeGlobs.length > 0 && !matchesAnyEvalHarnessV4Glob(selection.includeGlobs, id)) {
      excluded.push({ id, reason: `không khớp includeGlobs [${selection.includeGlobs.join(', ')}].` });
      continue;
    }
    if (selection.tags.length > 0 && !task.meta.tags.some((t) => selection.tags.includes(t))) {
      excluded.push({ id, reason: `không có tag nào trong [${selection.tags.join(', ')}].` });
      continue;
    }
    if (selection.kinds.length > 0 && !selection.kinds.includes(task.meta.kind)) {
      excluded.push({ id, reason: `kind "${task.meta.kind}" không nằm trong [${selection.kinds.join(', ')}].` });
      continue;
    }
    if (selection.excludeIds.includes(id)) {
      excluded.push({ id, reason: 'nằm trong excludeIds.' });
      continue;
    }
    if (matchesAnyEvalHarnessV4Glob(selection.excludeGlobs, id)) {
      excluded.push({ id, reason: `khớp excludeGlobs [${selection.excludeGlobs.join(', ')}].` });
      continue;
    }
    kept.push(task);
  }
  return { kept, excluded };
}

/** Gom task từ mọi nguồn (chưa lọc selection). Nguồn sau thắng khi trùng id. */
export function collectEvalHarnessV4Tasks(
  config: EvalHarnessV4Config,
): {
  tasks: HarborTask[];
  sources: Map<string, EvalHarnessV4ResolvedTask>;
  skipped: { id: string; reason: string }[];
} {
  const byId = new Map<string, HarborTask>();
  const sources = new Map<string, EvalHarnessV4ResolvedTask>();
  const skipped: { id: string; reason: string }[] = [];
  if (config.includeBuiltin) {
    for (const task of builtinHarborTasks()) {
      byId.set(task.meta.id, task);
      sources.set(task.meta.id, { taskId: task.meta.id, source: 'builtin' });
    }
  }
  if (config.includeBuiltinV4) {
    for (const task of builtinEvalHarnessV4Tasks()) {
      byId.set(task.meta.id, task);
      sources.set(task.meta.id, { taskId: task.meta.id, source: 'builtin-v4' });
    }
  }
  for (const taskDir of config.taskDirs) {
    if (!fs.existsSync(taskDir)) {
      skipped.push({ id: taskDir, reason: `thư mục task không tồn tại: "${taskDir}".` });
      continue;
    }
    if (!fs.statSync(taskDir).isDirectory()) {
      skipped.push({ id: taskDir, reason: `"${taskDir}" không phải thư mục.` });
      continue;
    }
    const loaded = loadHarborTasksFromDir(taskDir);
    for (const task of loaded.tasks) {
      byId.set(task.meta.id, task);
      sources.set(task.meta.id, { taskId: task.meta.id, source: 'directory', dir: task.dir ?? path.join(taskDir, task.meta.id) });
    }
    for (const skip of loaded.skipped) {
      skipped.push({
        id: path.basename(skip.dir),
        reason: `task trong "${skip.dir}" không load được: ${skip.issues.map((i) => `${i.field}: ${i.message}`).join(' | ')}`,
      });
    }
  }
  const tasks = [...byId.values()].sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  return { tasks, sources, skipped };
}

/**
 * Resolve task set đầy đủ: gom task → validate lại từng task →
 * lọc selection. Task validate fail bị skip (ghi lý do) thay vì
 * làm cả suite dừng — suite vẫn chạy các task còn lại.
 */
export function resolveEvalHarnessV4TaskSet(config: EvalHarnessV4Config): EvalHarnessV4TaskSet {
  const collected = collectEvalHarnessV4Tasks(config);
  const totalAvailable = collected.tasks.length;
  const skipped = [...collected.skipped];
  const validTasks: HarborTask[] = [];
  for (const task of collected.tasks) {
    const validation = validateHarborTask(task);
    if (!validation.valid) {
      skipped.push({
        id: task.meta.id,
        reason: `task "${task.meta.id}" không hợp lệ: ${validation.issues.map((i) => `${i.field}: ${i.message}`).join(' | ')}`,
      });
      continue;
    }
    validTasks.push(task);
  }
  const { kept, excluded } = filterHarborTasksBySelection(validTasks, config.selection);
  for (const ex of excluded) {
    skipped.push({ id: ex.id, reason: `bị lọc khỏi task set: ${ex.reason}` });
  }
  const tasks: EvalHarnessV4ResolvedTask[] = kept.map((task) => {
    const source = collected.sources.get(task.meta.id);
    return source ?? { taskId: task.meta.id, source: 'builtin' };
  });
  return { tasks, skipped, totalAvailable, appliedSelection: { ...config.selection } };
}

/**
 * Load đối tượng HarborTask đầy đủ cho các task trong task set đã
 * resolve (để runner chạy). Task trên đĩa được load lại từ `dir`
 * (bản trên đĩa mới nhất); task builtin lấy từ bộ mẫu trong RAM.
 */
export function loadEvalHarnessV4ResolvedTasks(
  taskSet: EvalHarnessV4TaskSet,
  config: EvalHarnessV4Config,
): { tasks: HarborTask[]; skipped: { id: string; reason: string }[] } {
  const collected = collectEvalHarnessV4Tasks(config);
  const byId = new Map(collected.tasks.map((t) => [t.meta.id, t]));
  const tasks: HarborTask[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const resolved of taskSet.tasks) {
    const task = byId.get(resolved.taskId);
    if (!task) {
      skipped.push({ id: resolved.taskId, reason: `task "${resolved.taskId}" không còn tồn tại khi load để chạy.` });
      continue;
    }
    tasks.push(task);
  }
  return { tasks, skipped };
}

/** Thống kê nhanh một task set (đếm theo kind/tag/source) để hiển thị. */
export function describeEvalHarnessV4TaskSet(
  taskSet: EvalHarnessV4TaskSet,
  tasks: readonly HarborTask[],
): {
  total: number;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
  tags: string[];
  ids: string[];
} {
  const byKind: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const tagSet = new Set<string>();
  for (const task of tasks) {
    byKind[task.meta.kind] = (byKind[task.meta.kind] ?? 0) + 1;
    for (const tag of task.meta.tags) tagSet.add(tag);
  }
  for (const resolved of taskSet.tasks) {
    bySource[resolved.source] = (bySource[resolved.source] ?? 0) + 1;
  }
  return {
    total: taskSet.tasks.length,
    byKind,
    bySource,
    tags: [...tagSet].sort(),
    ids: taskSet.tasks.map((t) => t.taskId),
  };
}
