/**
 * Agent Teams v3 — lead control layer (v1.11, Đội T3).
 *
 * Lead có 2 mode:
 * - delegate: lead chỉ giao việc, không tự làm — claim/start task
 *   với tư cách lead là lỗi.
 * - implement: lead cũng trực tiếp làm — lead claim/start task như
 *   teammate thường.
 * Chuyển mode được giữa chừng; mỗi lần chuyển ghi vào lịch sử mode
 * + log hội thoại team để audit. Lead xem được trạng thái từng
 * teammate qua lead status board (trạng thái, task đang làm, wave,
 * tin chưa đọc, challenge đang mở, vị trí pane).
 *
 * Thuần: không chạm disk — service v3 giữ state và gọi các hàm này.
 */

import type { AgentTeamV109, TeamTask, Teammate } from '../types';
import {
  autoPaneColumns,
  panePosition,
  type LeadMode,
  type LeadTeammateBoardEntry,
  type TeamV3Result,
} from './types';
import { waveOfTask } from './waves';
import type { TeamWave } from './types';

/** Lead có được claim/start task ở mode hiện tại không. */
export function canLeadWork(mode: LeadMode): { allowed: boolean; reason?: string } {
  if (mode === 'implement') return { allowed: true };
  return {
    allowed: false,
    reason: 'Lead đang ở delegate mode (chỉ giao việc, không tự làm) — chuyển sang implement mode để lead trực tiếp làm task (qua worker seat).',
  };
}

/** Tên worker seat của lead (teammate đại diện cho lead khi làm việc). */
export function leadWorkerName(leadName: string): string {
  return `${leadName} · worker`;
}

/** Kiểm tra claim/start của worker seat của lead (chỉ làm việc ở implement mode). */
export function checkLeadWorkerClaim(
  mode: LeadMode,
  actorId: string,
  leadWorkerId: string | undefined,
): TeamV3Result<void> {
  if (!leadWorkerId || actorId !== leadWorkerId) return { ok: true, value: undefined };
  if (mode === 'implement') return { ok: true, value: undefined };
  return {
    ok: false,
    error: 'Worker seat của lead chỉ làm việc ở implement mode — lead đang ở delegate mode, chuyển sang implement mode để seat này làm task.',
  };
}

/** Kiểm tra một thao tác claim/start của lead ở mode hiện tại. */
export function checkLeadClaim(
  mode: LeadMode,
  actorId: string,
  leadId: string,
): TeamV3Result<void> {
  if (actorId !== leadId) return { ok: true, value: undefined };
  const check = canLeadWork(mode);
  if (!check.allowed) return { ok: false, error: check.reason as string };
  return { ok: true, value: undefined };
}

/** Validate chuyển mode (chỉ 2 giá trị hợp lệ; chuyển sang mode đang dùng là lỗi). */
export function validateLeadModeSwitch(from: LeadMode, to: LeadMode): TeamV3Result<LeadMode> {
  if (to !== 'delegate' && to !== 'implement') {
    return { ok: false, error: 'leadMode phải là "delegate" hoặc "implement".' };
  }
  if (from === to) {
    return { ok: false, error: `Lead đã ở ${to} mode rồi — không cần chuyển.` };
  }
  return { ok: true, value: to };
}

/** Lead có được làm việc này không khi chuyển sang implement giữa chừng mà đang giữ task dở? */
export function leadModeSwitchNote(from: LeadMode, to: LeadMode): string {
  if (from === 'delegate' && to === 'implement') {
    return 'Lead chuyển sang implement mode: lead làm việc qua worker seat (teammate "lead · worker") như một teammate thường. Task đã giao cho teammate khác không bị thu hồi.';
  }
  return 'Lead chuyển sang delegate mode: lead và worker seat không claim/start task mới nữa. Task seat đang làm dở (nếu có) vẫn giữ nguyên cho tới khi xong — lead nên hoàn thành hoặc nhả task đó.';
}

/** Số task lead đang giữ dở (claimed/in-progress) — để cảnh báo khi về delegate mode. */
export function leadOpenTasks(team: AgentTeamV109): TeamTask[] {
  return team.tasks.filter(
    (t) => t.claimedBy === team.leadId && (t.status === 'claimed' || t.status === 'in-progress'),
  );
}

/**
 * Lead status board: trạng thái từng teammate (lead xem được mọi
 * teammate: trạng thái, task đang làm + wave, tin chưa đọc,
 * challenge đang mở, vị trí pane tmux).
 */
export function buildLeadBoard(
  team: AgentTeamV109,
  opts: {
    waves: TeamWave[];
    unreadByTeammate: Record<string, number>;
    openChallengesByTeammate: Record<string, number>;
    paneColumns?: number;
  },
): LeadTeammateBoardEntry[] {
  const columns = opts.paneColumns && opts.paneColumns > 0 ? opts.paneColumns : autoPaneColumns(team.teammates.length);
  return team.teammates.map((mate: Teammate, index: number) => {
    const pos = panePosition(index, columns);
    const task = mate.currentTaskId ? team.tasks.find((t) => t.id === mate.currentTaskId) : undefined;
    const wave = task ? waveOfTask(opts.waves, task.id) : undefined;
    return {
      id: mate.id,
      name: mate.name,
      role: mate.role,
      status: mate.status,
      specialty: mate.specialty,
      currentTaskId: mate.currentTaskId,
      currentTaskTitle: task?.title,
      currentWave: wave?.index,
      tasksDone: mate.tasksDone,
      tasksFailed: mate.tasksFailed,
      unreadMessages: opts.unreadByTeammate[mate.id] ?? 0,
      openChallenges: opts.openChallengesByTeammate[mate.id] ?? 0,
      paneRow: pos.row,
      paneCol: pos.col,
    };
  });
}

/** Tóm tắt board một dòng (để tool/dashboard hiển thị nhanh). */
export function summarizeLeadBoard(board: LeadTeammateBoardEntry[]): string {
  if (board.length === 0) return 'Chưa có teammate nào.';
  const working = board.filter((b) => b.status === 'working').length;
  const idle = board.filter((b) => b.status === 'idle').length;
  const blocked = board.filter((b) => b.status === 'blocked').length;
  const parts = board.map((b) => `${b.name} (${b.role === 'lead' ? 'lead' : b.status}${b.currentTaskTitle ? `: ${b.currentTaskTitle}` : ''})`);
  return `${board.length} người — ${working} đang làm, ${idle} rảnh, ${blocked} bị chặn. ${parts.join('; ')}.`;
}
