/**
 * Agent Teams v1 — runner (v1.09, Đội T1).
 *
 * Chạy task của team qua runner do caller tiêm vào: scheduler gán
 * task ready cho teammate rảnh, runner chạy từng task (song song
 * theo batch, tối đa maxParallelTasks), kết quả ghi về task
 * (done/failed + resultSummary), teammate nhắn result vào mailbox
 * cho lead. Runner thật do caller cung cấp (agent thật / subagent /
 * CLI); test dùng runner giả.
 *
 * Runner KHÔNG chạy ở đây theo kiểu fire-and-forget vô hạn: `runTeam`
 * chạy theo đợt (một đợt = gán + chạy batch task ready), trả về báo
 * cáo đợt; caller gọi lặp cho tới khi team completed/dissolved hoặc
 * hết task ready. Hủy giữa chừng qua AbortSignal.
 */

import type { AgentTeamV109, MailboxMessage, TeamTask, Teammate } from './types';
import { TeamService, type ScheduledAssignment } from './service';

/** Đầu vào một lần chạy task: task + teammate + ngữ cảnh team. */
export interface TeamTaskRunInput {
  teamId: string;
  teamName: string;
  teamGoal: string;
  task: TeamTask;
  teammate: Teammate;
  /** Tin nhắn mailbox gần nhất gửi cho teammate này (để nó đọc yêu cầu). */
  inbox: MailboxMessage[];
}

/** Kết quả một lần chạy task. */
export interface TeamTaskRunResult {
  output: string;
  /** File teammate đã tạo/sửa (đường dẫn tương đối) — dùng để đối chiếu touchesFiles. */
  filesChanged?: string[];
  /** Token đã dùng (khi runner báo). */
  tokensUsed?: number;
  durationMs?: number;
}

/** Runner một task: nhận input, trả kết quả hoặc throw khi lỗi. */
export type TeamTaskRunner = (input: TeamTaskRunInput) => Promise<TeamTaskRunResult>;

/** Tùy chọn chạy team. */
export interface RunTeamOptions {
  /** Số đợt tối đa (mặc định 20 — tránh vòng lặp vô hạn khi task cứ fail rồi retry). */
  maxRounds?: number;
  /** Timeout mỗi task, ms (mặc định lấy từ team.config.taskTimeoutMs). */
  taskTimeoutMs?: number;
  /** Hủy giữa chừng. */
  signal?: AbortSignal;
  /** Callback sau mỗi task xong (để UI/log theo dõi). */
  onTaskFinished?: (event: TeamTaskFinishedEvent) => void;
}

/** Sự kiện một task xong trong đợt chạy. */
export interface TeamTaskFinishedEvent {
  taskId: string;
  taskTitle: string;
  teammateId: string;
  teammateName: string;
  status: 'done' | 'failed';
  durationMs: number;
  retryable?: boolean;
}

/** Báo cáo một đợt chạy team. */
export interface TeamRunReport {
  teamId: string;
  teamName: string;
  roundsRun: number;
  tasksDone: number;
  tasksFailed: number;
  tasksRetried: number;
  assignments: ScheduledAssignment[];
  finished: TeamTaskFinishedEvent[];
  teamStatus: AgentTeamV109['status'];
  stoppedReason: 'completed' | 'dissolved' | 'no-ready-tasks' | 'max-rounds' | 'aborted' | 'paused';
}

/** Chạy một task với timeout (race giữa runner và timer). */
export async function runTaskWithTimeout(
  runner: TeamTaskRunner,
  input: TeamTaskRunInput,
  timeoutMs: number,
): Promise<TeamTaskRunResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      runner(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Task "${input.task.title}" quá ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Chạy team theo đợt qua runner tiêm vào.
 *
 * Mỗi đợt: reclaim claim treo → scheduler gán task ready → chạy
 * batch song song (Promise.allSettled, tối đa maxParallelTasks) →
 * ghi kết quả về task + mailbox result cho lead → lặp lại nếu còn
 * task ready và chưa hết maxRounds.
 */
export async function runTeam(
  service: TeamService,
  runner: TeamTaskRunner,
  options: RunTeamOptions = {},
): Promise<TeamRunReport> {
  const maxRounds = options.maxRounds ?? 20;
  const report: TeamRunReport = {
    teamId: service.snapshot.id,
    teamName: service.snapshot.name,
    roundsRun: 0,
    tasksDone: 0,
    tasksFailed: 0,
    tasksRetried: 0,
    assignments: [],
    finished: [],
    teamStatus: service.snapshot.status,
    stoppedReason: 'no-ready-tasks',
  };
  for (let round = 0; round < maxRounds; round++) {
    if (options.signal?.aborted) {
      report.stoppedReason = 'aborted';
      break;
    }
    const snap = service.snapshot;
    if (snap.status === 'completed') {
      report.stoppedReason = 'completed';
      break;
    }
    if (snap.status === 'dissolved') {
      report.stoppedReason = 'dissolved';
      break;
    }
    if (snap.status === 'paused') {
      report.stoppedReason = 'paused';
      break;
    }
    report.roundsRun += 1;
    service.reclaimStaleClaims();
    const assignments = service.schedule();
    if (assignments.length === 0) {
      report.stoppedReason = service.snapshot.tasks.some((t) => t.status === 'pending')
        ? 'no-ready-tasks'
        : 'completed';
      break;
    }
    report.assignments.push(...assignments);
    // Chạy batch song song: mỗi assignment = 1 task + 1 teammate.
    const settled = await Promise.allSettled(
      assignments.map(async (a) => {
        const current = service.snapshot;
        const task = current.tasks.find((t) => t.id === a.taskId);
        const mate = current.teammates.find((m) => m.id === a.teammateId);
        if (!task || !mate) return { assignment: a, skipped: true as const };
        const started = service.startTask(task.id, mate.id);
        if (!started.ok) return { assignment: a, skipped: true as const };
        const startedAt = Date.now();
        const timeoutMs = options.taskTimeoutMs ?? current.config.taskTimeoutMs;
        try {
          const result = await runTaskWithTimeout(
            runner,
            {
              teamId: current.id,
              teamName: current.name,
              teamGoal: current.goal,
              task: service.findTask(task.id) as TeamTask,
              teammate: mate,
              inbox: service.inbox(mate.id),
            },
            timeoutMs,
          );
          const durationMs = Date.now() - startedAt;
          const done = service.completeTask(task.id, mate.id, result.output.slice(0, 500));
          if (done.ok) {
            report.tasksDone += 1;
            const event: TeamTaskFinishedEvent = {
              taskId: task.id,
              taskTitle: task.title,
              teammateId: mate.id,
              teammateName: mate.name,
              status: 'done',
              durationMs,
            };
            report.finished.push(event);
            options.onTaskFinished?.(event);
            // Nhắn result cho lead qua mailbox.
            service.sendMessage({
              fromId: mate.id,
              toId: current.leadId,
              kind: 'result',
              taskId: task.id,
              body: result.output.slice(0, 2000) || `Task "${task.title}" xong.`,
            });
          }
          return { assignment: a, skipped: false as const };
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          const message = err instanceof Error ? err.message : String(err);
          const failed = service.failTask(task.id, mate.id, message);
          if (failed.ok) {
            if (failed.value.retryable) report.tasksRetried += 1;
            else report.tasksFailed += 1;
            const event: TeamTaskFinishedEvent = {
              taskId: task.id,
              taskTitle: task.title,
              teammateId: mate.id,
              teammateName: mate.name,
              status: 'failed',
              durationMs,
              retryable: failed.value.retryable,
            };
            report.finished.push(event);
            options.onTaskFinished?.(event);
            // Teammate bí → hỏi lead qua mailbox (question).
            service.sendMessage({
              fromId: mate.id,
              toId: current.leadId,
              kind: 'question',
              taskId: task.id,
              body: `Task "${task.title}" lỗi: ${message.slice(0, 1000)} — cần lead hỗ trợ.`,
            });
          }
          return { assignment: a, skipped: false as const };
        }
      }),
    );
    void settled;
    if (service.snapshot.status === 'completed') {
      report.stoppedReason = 'completed';
      break;
    }
    // Hết đợt mà không còn task ready → dừng (tránh vòng lặp rỗng).
    if (service.readyTaskList().length === 0 && service.snapshot.tasks.every((t) => t.status === 'done' || t.status === 'failed')) {
      report.stoppedReason = 'completed';
      break;
    }
  }
  if (report.roundsRun >= maxRounds && report.stoppedReason === 'no-ready-tasks') {
    report.stoppedReason = 'max-rounds';
  }
  report.teamStatus = service.snapshot.status;
  return report;
}

/** Tóm tắt nhanh một đợt chạy (để log/UI hiển thị một dòng). */
export function summarizeTeamRun(report: TeamRunReport): string {
  return (
    `Team "${report.teamName}": ${report.roundsRun} đợt, ` +
    `${report.tasksDone} task xong, ${report.tasksFailed} lỗi, ` +
    `${report.tasksRetried} thử lại, trạng thái ${report.teamStatus} (${report.stoppedReason}).`
  );
}
