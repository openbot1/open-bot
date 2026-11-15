/**
 * Agent Teams v2 — vai lead/worker: giao việc + tổng hợp (v1.10, Đội T3).
 *
 * Vai trò (ý tưởng Claude Code Agent Teams + Codex manager/worker):
 * - Lead điều phối: spawn teammate, GIAO task cho đúng teammate,
 *   tổng hợp kết quả. Lead không claim task trực tiếp (luật v1 giữ nguyên).
 * - Worker chỉ làm task được giao: khi lead đã assign một task cho
 *   teammate A, chỉ A mới được claim task đó. Task chưa ai assign
 *   thì teammate rảnh nào cũng claim được (luật v1).
 * - Tổng hợp: lead gom resultSummary của các task done theo từng
 *   teammate thành báo cáo team (để lead đọc nhanh / gửi tiếp).
 *
 * Thuần logic trên dữ liệu team + danh sách assignment (lưu trong
 * TeamV2State): không I/O, serviceV2 gọi các hàm này rồi lưu disk.
 */

import type { AgentTeamV109, TeamTask, Teammate } from '../types';
import type { TaskAssignment, TeamAggregateReport } from './types';

/** Kết quả một thao tác lead/worker. */
export type LeadWorkerResult<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; error: string; value?: undefined };

function ok<T>(value: T): LeadWorkerResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): LeadWorkerResult<T> {
  return { ok: false, error };
}

/** Tìm assignment của một task (undefined = chưa giao cho ai). */
export function assignmentForTask(
  assignments: TaskAssignment[],
  taskId: string,
): TaskAssignment | undefined {
  return assignments.find((a) => a.taskId === taskId);
}

/** Task nào đang được giao cho một teammate. */
export function assignmentsForTeammate(
  assignments: TaskAssignment[],
  teammateId: string,
): TaskAssignment[] {
  return assignments.filter((a) => a.teammateId === teammateId);
}

/**
 * Lead giao task cho một teammate.
 * - Chỉ lead mới được giao (assignedById phải là leadId của team).
 * - Task phải tồn tại và đang pending (task đã có người giữ thì không giao lại).
 * - Teammate phải tồn tại, không phải lead, không blocked/failed.
 * - Giao lại cho người khác: ghi đè assignment cũ (task vẫn pending).
 */
export function assignTaskToTeammate(
  team: AgentTeamV109,
  assignments: TaskAssignment[],
  input: { taskId: string; teammateId: string; assignedById: string },
  now = Date.now(),
): LeadWorkerResult<{ assignments: TaskAssignment[]; assignment: TaskAssignment }> {
  if (input.assignedById !== team.leadId) {
    return fail('Chỉ lead mới được giao task cho teammate.');
  }
  const task = team.tasks.find((t) => t.id === input.taskId);
  if (!task) return fail(`Không tìm thấy task ${input.taskId}.`);
  if (task.status !== 'pending') {
    return fail(`Task "${task.title}" đang ở trạng thái ${task.status}, chỉ giao task pending.`);
  }
  const mate = team.teammates.find((m) => m.id === input.teammateId);
  if (!mate) return fail(`Không tìm thấy teammate ${input.teammateId}.`);
  if (mate.role === 'lead') return fail('Lead điều phối, không giao task cho chính lead.');
  if (mate.status === 'blocked' || mate.status === 'failed') {
    return fail(`Teammate "${mate.name}" đang ở trạng thái ${mate.status}, không giao được.`);
  }
  const assignment: TaskAssignment = {
    taskId: input.taskId,
    teammateId: input.teammateId,
    teammateName: mate.name,
    assignedById: input.assignedById,
    assignedAt: now,
  };
  const next = assignments.filter((a) => a.taskId !== input.taskId);
  next.push(assignment);
  return ok({ assignments: next, assignment });
}

/**
 * Worker có được claim task này không: task đã giao cho người khác
 * thì worker này không claim được (chỉ người được giao mới claim).
 * Task chưa giao cho ai thì ai cũng claim được (luật v1).
 */
export function canClaimAssignedTask(
  assignments: TaskAssignment[],
  taskId: string,
  teammateId: string,
): { allowed: boolean; reason: string } {
  const assignment = assignmentForTask(assignments, taskId);
  if (!assignment) return { allowed: true, reason: '' };
  if (assignment.teammateId === teammateId) return { allowed: true, reason: '' };
  return {
    allowed: false,
    reason: `Task đã được lead giao cho "${assignment.teammateName}" — worker khác không claim được.`,
  };
}

/** Hủy giao task (task về lại hàng đợi chung, ai cũng claim được). */
export function unassignTask(
  assignments: TaskAssignment[],
  taskId: string,
  requestedById: string,
  leadId: string,
): LeadWorkerResult<TaskAssignment[]> {
  if (requestedById !== leadId) {
    return fail('Chỉ lead mới được hủy giao task.');
  }
  const existing = assignmentForTask(assignments, taskId);
  if (!existing) return fail(`Task ${taskId} chưa được giao cho ai.`);
  return ok(assignments.filter((a) => a.taskId !== taskId));
}

/** Gỡ assignment khi task đã xong/lỗi hẳn (không còn cần giữ giao nữa). */
export function clearAssignmentForTask(
  assignments: TaskAssignment[],
  taskId: string,
): TaskAssignment[] {
  return assignments.filter((a) => a.taskId !== taskId);
}

/**
 * Lead tổng hợp kết quả: gom resultSummary các task done/failed
 * theo từng teammate + đếm pending. Task done không có summary
 * vẫn được liệt kê (để lead biết task nào thiếu báo cáo).
 */
export function aggregateTeamResults(
  team: AgentTeamV109,
  now = Date.now(),
): TeamAggregateReport {
  const byTeammate = team.teammates.map((mate: Teammate) => {
    const done = team.tasks.filter(
      (t: TeamTask) => t.status === 'done' && t.claimedBy === mate.id,
    );
    const failed = team.tasks.filter(
      (t: TeamTask) => t.status === 'failed' && t.claimedBy === mate.id,
    );
    return {
      teammateId: mate.id,
      teammateName: mate.name,
      done: done.length,
      failed: failed.length,
      summaries: done.map((t) => ({
        taskId: t.id,
        taskTitle: t.title,
        summary: t.resultSummary,
      })),
    };
  });
  const tasksDone = team.tasks.filter((t) => t.status === 'done').length;
  const tasksFailed = team.tasks.filter((t) => t.status === 'failed').length;
  const tasksPending = team.tasks.filter(
    (t) => t.status === 'pending' || t.status === 'claimed' || t.status === 'in-progress',
  ).length;
  const lines: string[] = [
    `Báo cáo team "${team.name}" (${now ? new Date(now).toISOString() : ''}): ${tasksDone} task xong, ${tasksFailed} lỗi, ${tasksPending} chưa xong.`,
  ];
  for (const entry of byTeammate) {
    if (entry.done === 0 && entry.failed === 0) continue;
    lines.push(`- ${entry.teammateName}: ${entry.done} xong, ${entry.failed} lỗi.`);
    for (const s of entry.summaries) {
      lines.push(`  • ${s.taskTitle}: ${s.summary ?? '(chưa có tóm tắt)'}`);
    }
  }
  return {
    teamId: team.id,
    teamName: team.name,
    tasksDone,
    tasksFailed,
    tasksPending,
    byTeammate,
    reportText: lines.join('\n'),
  };
}

/** Worker rảnh nào đang chờ task được giao (để lead ưu tiên giao). */
export function idleWorkers(team: AgentTeamV109): Teammate[] {
  return team.teammates.filter(
    (m) => m.role === 'teammate' && m.status === 'idle' && !m.currentTaskId,
  );
}

/** Task pending chưa được giao cho ai (hàng đợi chung của team). */
export function unassignedPendingTasks(
  team: AgentTeamV109,
  assignments: TaskAssignment[],
): TeamTask[] {
  const assignedIds = new Set(assignments.map((a) => a.taskId));
  return team.tasks.filter((t) => t.status === 'pending' && !assignedIds.has(t.id));
}
