/**
 * Agent Teams v3 — dependency waves (v1.11, Đội T3).
 *
 * Wave = một tầng topo của dependency graph: wave 0 gồm các task
 * không có dependency; wave k gồm các task mà mọi dependency đều
 * nằm ở wave < k. Wave sau chỉ claimable khi wave trước đã done hết
 * (mọi task status 'done' — theo luật v1, task phụ thuộc chỉ claim
 * được khi dependency đã done; task failed hết lượt vẫn chặn wave
 * sau, lead phải cho làm lại task đó hoặc chấp nhận wave kẹt).
 *
 * Kế thừa v1: `findDependencyCycle`/`topoOrder` trong
 * packages/core/src/teams/taskList.ts đã phát hiện chu trình; wave
 * engine dùng lại để chặn team có dependency chu trình trước khi
 * tính wave.
 */

import { findDependencyCycle } from '../taskList';
import type { TeamTask } from '../types';
import { v3StateOf } from './types';
import type { TeamV3Result, TeamWave } from './types';

/**
 * Tính waves cho một danh sách task.
 * - Task có dependency tới id không tồn tại → lỗi (dependency treo).
 * - Dependency tạo chu trình → lỗi.
 * - Task failed vẫn tính là closed (wave sau vẫn mở) — failed là
 *   kết thúc có kiểm soát, lead quyết định retry hay bỏ qua.
 */
export function computeWaves(tasks: TeamTask[]): TeamV3Result<TeamWave[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) {
        return { ok: false, error: `Task "${task.title}" phụ thuộc vào task không tồn tại: ${dep}.` };
      }
    }
  }
  // findDependencyCycle trả [] khi không có chu trình (không phải null).
  const cycle = findDependencyCycle(tasks);
  if (cycle.length > 0) {
    return { ok: false, error: `Dependency tạo chu trình: ${cycle.join(' -> ')}.` };
  }
  // Tầng topo: level(task) = 0 khi không có dep, ngược lại
  // 1 + max(level(dep)). Tính bằng duyệt topo lặp (graph đã acyclic).
  const level = new Map<string, number>();
  let remaining = [...tasks];
  let guard = 0;
  while (remaining.length > 0) {
    guard += 1;
    if (guard > tasks.length + 2) {
      return { ok: false, error: 'Không tính được wave: dependency graph không hội tụ.' };
    }
    const next: TeamTask[] = [];
    let progressed = false;
    for (const task of remaining) {
      const depLevels = task.dependsOn.map((d) => level.get(d));
      if (depLevels.every((l) => l !== undefined)) {
        level.set(task.id, task.dependsOn.length === 0 ? 0 : 1 + Math.max(...(depLevels as number[])));
        progressed = true;
      } else {
        next.push(task);
      }
    }
    if (!progressed) {
      return { ok: false, error: 'Không tính được wave: còn dependency chưa xếp tầng.' };
    }
    remaining = next;
  }
  const maxLevel = tasks.length === 0 ? -1 : Math.max(...[...level.values()]);
  const waves: TeamWave[] = [];
  for (let i = 0; i <= maxLevel; i += 1) {
    const waveTasks = tasks.filter((t) => level.get(t.id) === i);
    // Wave chỉ xong khi MỌI task đều done — theo luật v1, task phụ thuộc
    // chỉ claim được khi dependency đã done; task failed (hết lượt) vẫn
    // chặn wave sau cho tới khi lead cho làm lại/thay thế bằng cách khác.
    const doneCount = waveTasks.filter((t) => t.status === 'done').length;
    const status: TeamWave['status'] =
      doneCount === waveTasks.length && waveTasks.length > 0
        ? 'done'
        : waveTasks.some((t) => v3StateOf(t) !== 'open')
          ? 'active'
          : 'pending';
    waves.push({ index: i, taskIds: waveTasks.map((t) => t.id), status, closedCount: doneCount, claimable: false });
  }
  // Wave k claimable khi mọi wave < k đã done.
  for (let i = 0; i < waves.length; i += 1) {
    const earlierDone = waves.slice(0, i).every((w) => w.status === 'done');
    waves[i].claimable = earlierDone;
    if (!earlierDone) {
      const blocker = waves.slice(0, i).find((w) => w.status !== 'done');
      const openInBlocker = blocker
        ? tasks.filter((t) => blocker.taskIds.includes(t.id) && t.status !== 'done').length
        : 0;
      waves[i].blockedBy = `Wave ${blocker?.index ?? 0} chưa xong (còn ${openInBlocker} task chưa done).`;
    }
  }
  return { ok: true, value: waves };
}

/** Wave hiện tại: wave đầu tiên chưa done (undefined khi mọi wave done hoặc không có task). */
export function currentWave(waves: TeamWave[]): TeamWave | undefined {
  return waves.find((w) => w.status !== 'done');
}

/** Task có được claim không theo luật wave (task phải thuộc wave claimable). */
export function canClaimByWave(
  waves: TeamWave[],
  taskId: string,
): { allowed: boolean; reason?: string; waveIndex?: number } {
  const wave = waves.find((w) => w.taskIds.includes(taskId));
  if (!wave) return { allowed: false, reason: `Task ${taskId} không thuộc wave nào.` };
  if (!wave.claimable) {
    return { allowed: false, reason: wave.blockedBy ?? `Wave ${wave.index} chưa được claim.`, waveIndex: wave.index };
  }
  return { allowed: true, waveIndex: wave.index };
}

/** Wave của một task (undefined khi task không có trong wave nào). */
export function waveOfTask(waves: TeamWave[], taskId: string): TeamWave | undefined {
  return waves.find((w) => w.taskIds.includes(taskId));
}

/** Tóm tắt tiến độ waves (để dashboard/UI hiển thị một dòng). */
export function summarizeWaves(waves: TeamWave[], tasks: TeamTask[]): string {
  if (waves.length === 0) return 'Chưa có wave nào (chưa có task).';
  const done = waves.filter((w) => w.status === 'done').length;
  const current = currentWave(waves);
  const closedTotal = tasks.filter((t) => t.status === 'done').length;
  if (!current) {
    return `Đã xong ${done}/${waves.length} wave, ${closedTotal}/${tasks.length} task done.`;
  }
  return (
    `Wave ${current.index + 1}/${waves.length} đang chạy ` +
    `(${current.closedCount}/${current.taskIds.length} task done trong wave), ` +
    `tổng ${closedTotal}/${tasks.length} task done.`
  );
}

/** Mọi wave đã done chưa (team xong phần việc theo dependency). */
export function allWavesDone(waves: TeamWave[]): boolean {
  return waves.length > 0 && waves.every((w) => w.status === 'done');
}
