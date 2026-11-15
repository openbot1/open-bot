/**
 * Agent Teams v2 — hook TaskCompleted (v1.10, Đội T3).
 *
 * Khi teammate đánh dấu task xong, lead có thể cấu hình một lệnh
 * shell (reviewer) chạy kiểm tra kết quả — ý tưởng hook
 * `TaskCompleted` của Claude Code Agent Teams (survey v1.10 §2):
 *
 * - Lệnh nhận JSON input qua stdin (team/task/teammate +
 *   resultSummary) và env `OPENBOT_HOOK_EVENT=TaskCompleted`,
 *   `OPENBOT_TEAM_ID`, `OPENBOT_TASK_ID`, ...
 * - Exit 0 = chấp nhận: task done, ghi kết quả bình thường.
 * - Exit 2 = GIỮ TASK MỞ kèm feedback của reviewer: task quay
 *   lại hàng đợi (pending) để teammate làm lại theo feedback.
 *   Feedback lấy từ dòng stdout cuối (hoặc stderr khi stdout
 *   trống) — cùng quy ước với `HOOK_COMMAND_BLOCK_EXIT_CODE = 2`
 *   của shellCommandRunner.
 * - Exit khác / timeout / bị kill / spawn lỗi = lỗi hạ tầng của
 *   hook: task VẪN done (không làm mất công việc vì reviewer
 *   lỗi), lỗi được ghi lại trong kết quả + event log để lead thấy.
 *
 * Runner mặc định dùng `runShellCommand` (low-level, đã xử lý
 * timeout/kill process group); test tiêm runner giả qua
 * `TaskCompletedHookRunner` nên không cần chạy shell thật.
 */

import { runShellCommand, type ShellCommandResult } from '../../hooks/shellCommandRunner';
import type { TaskCompletedHookInput, TaskCompletedHookResult } from './types';

/** Exit code giữ task mở (cùng quy ước hook command của open-bot). */
export const TASK_COMPLETED_HOLD_EXIT_CODE = 2;

/** Env var báo loại event cho lệnh hook. */
export const TASK_COMPLETED_HOOK_EVENT_ENV = 'OPENBOT_HOOK_EVENT';

/** Runner một lệnh hook: nhận command + input, trả về kết quả shell thô. */
export type TaskCompletedHookRunner = (
  command: string,
  input: TaskCompletedHookInput,
  timeoutMs: number,
) => Promise<ShellCommandResult>;

/** Runner mặc định: chạy lệnh qua runShellCommand (stdin JSON + env an toàn). */
export async function defaultTaskCompletedHookRunner(
  command: string,
  input: TaskCompletedHookInput,
  timeoutMs: number,
): Promise<ShellCommandResult> {
  const payload = JSON.stringify(input);
  return runShellCommand(command, {
    timeoutMs,
    stdinText: `${payload}\n`,
    env: {
      [TASK_COMPLETED_HOOK_EVENT_ENV]: 'TaskCompleted',
      OPENBOT_TEAM_ID: input.teamId,
      OPENBOT_TASK_ID: input.taskId,
      OPENBOT_TEAMMATE_ID: input.teammateId,
    },
  });
}

/** Dòng stdout không rỗng cuối cùng (feedback của reviewer). */
export function lastNonEmptyLine(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? (lines[lines.length - 1] as string) : '';
}

/**
 * Diễn giải kết quả shell thành quyết định hook:
 * - exit 2 → giữ task mở, feedback = dòng stdout cuối (hoặc stderr).
 * - exit 0 → chấp nhận.
 * - timeout/signal/spawn (exitCode null) → lỗi hạ tầng, task vẫn done.
 * - exit khác → lỗi hạ tầng, task vẫn done.
 */
export function interpretHookResult(result: ShellCommandResult): TaskCompletedHookResult {
  if (result.timedOut) {
    return {
      accepted: true,
      exitCode: null,
      hookError: `Hook TaskCompleted timeout (quá ${result.durationMs}ms) — task vẫn done, kiểm tra lại lệnh hook.`,
    };
  }
  if (result.signal !== null && result.exitCode === null) {
    return {
      accepted: true,
      exitCode: null,
      hookError: `Hook TaskCompleted bị kill bởi signal ${result.signal} — task vẫn done.`,
    };
  }
  const exitCode = result.exitCode ?? -1;
  if (exitCode === TASK_COMPLETED_HOLD_EXIT_CODE) {
    const feedback =
      lastNonEmptyLine(result.stdout) || result.stderr.trim() || 'Reviewer giữ task mở (không có feedback).';
    return { accepted: false, exitCode, feedback: feedback.slice(0, 2000) };
  }
  if (exitCode !== 0) {
    const stderrTail = result.stderr.trim();
    return {
      accepted: true,
      exitCode,
      hookError:
        `Hook TaskCompleted exit code ${exitCode}` +
        (stderrTail ? ` (stderr: ${stderrTail.slice(-500)})` : '') +
        ' — task vẫn done.',
    };
  }
  return { accepted: true, exitCode: 0 };
}

/**
 * Chạy hook TaskCompleted cho một task vừa xong.
 * Không có lệnh hook cấu hình → chấp nhận ngay (không chạy gì).
 * Spawn lỗi (lệnh không chạy được) → lỗi hạ tầng, task vẫn done.
 */
export async function runTaskCompletedHook(
  command: string | undefined,
  input: TaskCompletedHookInput,
  opts: { timeoutMs?: number; runner?: TaskCompletedHookRunner } = {},
): Promise<TaskCompletedHookResult> {
  const trimmed = command?.trim() ?? '';
  if (!trimmed) return { accepted: true, exitCode: 0 };
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const runner = opts.runner ?? defaultTaskCompletedHookRunner;
  let result: ShellCommandResult;
  try {
    result = await runner(trimmed, input, timeoutMs);
  } catch (err) {
    return {
      accepted: true,
      exitCode: null,
      hookError: `Không chạy được lệnh hook TaskCompleted: ${(err as Error).message} — task vẫn done.`,
    };
  }
  return interpretHookResult(result);
}
