/**
 * Agent Teams v3 — file guard (v1.11, Đội T3).
 *
 * 2 teammate không sửa cùng file: khi claim một task, kiểm tra
 * `touchesFiles` của task với các task đang claimed/in-progress
 * của teammate khác. Trùng file → chặn; lead override có kiểm
 * soát (allowOverride + ghi log vào conversation) thì cho qua.
 *
 * Kế thừa v1: `buildFileLocks`/`lockedFiles` trong
 * packages/core/src/teams/taskList.ts đã tính file đang bị giữ;
 * file guard v3 thêm lớp quyết định claim (chặn/override/ghi log)
 * và kiểm tra partition chồng nhau khi spawn teammate.
 */

import { buildFileLocks } from '../taskList';
import { partitionsOverlap } from '../types';
import type { TeamTask, Teammate } from '../types';
import type { TeamV3Result } from './types';

/** Một file đang bị giữ bởi task khác. */
export interface FileHold {
  file: string;
  taskId: string;
  taskTitle: string;
  teammateId: string;
  teammateName: string;
}

/** Kết quả kiểm tra file guard trước khi claim. */
export interface FileGuardCheck {
  /** Claim có được phép không (không trùng, hoặc override cho phép). */
  allowed: boolean;
  /** Các file đang bị giữ bởi task khác. */
  holds: FileHold[];
  /** Cảnh báo đọc được (rỗng khi không trùng). */
  warnings: string[];
  /** Lỗi chặn (khi trùng và không override). */
  error?: string;
}

/**
 * Kiểm tra claim task có chạm file đang bị teammate khác giữ không.
 * - Không trùng → allowed.
 * - Trùng + allowOverride → allowed kèm warning (override có kiểm soát).
 * - Trùng + không override → chặn, nêu rõ file + ai đang giữ.
 */
export function checkFileGuard(
  tasks: TeamTask[],
  teammates: Teammate[],
  taskId: string,
  teammateId: string,
  opts: { allowOverride?: boolean } = {},
): FileGuardCheck {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return { allowed: false, holds: [], warnings: [], error: `Không tìm thấy task ${taskId}.` };
  if (task.touchesFiles.length === 0) return { allowed: true, holds: [], warnings: [] };
  const locks = buildFileLocks(tasks);
  const nameOf = (id: string): string => teammates.find((m) => m.id === id)?.name ?? id;
  const holds: FileHold[] = [];
  for (const file of task.touchesFiles) {
    const holderTaskId = locks.get(file);
    if (!holderTaskId || holderTaskId === taskId) continue;
    const holderTask = tasks.find((t) => t.id === holderTaskId);
    if (!holderTask || !holderTask.claimedBy || holderTask.claimedBy === teammateId) continue;
    if (holderTask.status !== 'claimed' && holderTask.status !== 'in-progress') continue;
    holds.push({
      file,
      taskId: holderTaskId,
      taskTitle: holderTask.title,
      teammateId: holderTask.claimedBy,
      teammateName: nameOf(holderTask.claimedBy),
    });
  }
  if (holds.length === 0) return { allowed: true, holds: [], warnings: [] };
  const detail = holds.map((h) => `"${h.file}" đang bị ${h.teammateName} giữ (task "${h.taskTitle}")`).join('; ');
  if (opts.allowOverride) {
    return {
      allowed: true,
      holds,
      warnings: [`OVERRIDE file guard: ${detail} — lead đã cho phép ghi đè có kiểm soát, đã ghi log.`],
    };
  }
  return {
    allowed: false,
    holds,
    warnings: [],
    error: `Không claim được: ${detail}. Chờ teammate kia xong, hoặc lead override (allowOverride).`,
  };
}

/** Kết quả kiểm tra partition khi spawn teammate mới. */
export interface PartitionGuardCheck {
  allowed: boolean;
  warnings: string[];
  error?: string;
}

/**
 * Kiểm tra partition của teammate mới có chồng với teammate hiện có không.
 * V1 chặn hẳn partition chồng (TeamService.addTeammate trả lỗi) vì
 * 2 teammate sửa cùng vùng file rất dễ ghi đè nhau — v3 kiểm tra
 * trước để trả lỗi rõ ràng, không để v2 fail mới biết.
 */
export function checkPartitionGuard(
  teammates: Teammate[],
  partition: string | undefined,
): PartitionGuardCheck {
  if (!partition?.trim()) return { allowed: true, warnings: [] };
  const clashes = teammates.filter((m) => m.partition && partitionsOverlap(m.partition, partition));
  if (clashes.length === 0) return { allowed: true, warnings: [] };
  return {
    allowed: false,
    warnings: [],
    error: `Partition "${partition}" chồng với partition "${clashes[0].partition}" của ${clashes[0].name} — 2 teammate không sửa cùng vùng file, chọn partition khác.`,
  };
}

/** Tóm tắt file guard cho một team (để dashboard hiển thị). */
export function summarizeFileHolds(tasks: TeamTask[], teammates: Teammate[]): FileHold[] {
  const locks = buildFileLocks(tasks);
  const nameOf = (id: string): string => teammates.find((m) => m.id === id)?.name ?? id;
  const holds: FileHold[] = [];
  for (const [file, taskId] of locks) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || !task.claimedBy) continue;
    if (task.status !== 'claimed' && task.status !== 'in-progress') continue;
    holds.push({
      file,
      taskId,
      taskTitle: task.title,
      teammateId: task.claimedBy,
      teammateName: nameOf(task.claimedBy),
    });
  }
  return holds;
}

/** Ghi đè có kiểm soát: chỉ lead (hoặc người được lead ủy quyền) mới override được. */
export function canOverrideFileGuard(
  actorId: string,
  leadId: string,
  allowFileOverride: boolean,
): TeamV3Result<void> {
  if (!allowFileOverride) {
    return { ok: false, error: 'Team này tắt file override (allowFileOverride=false) — không được ghi đè file đang bị giữ.' };
  }
  if (actorId !== leadId) {
    return { ok: false, error: 'Chỉ lead mới được override file guard.' };
  }
  return { ok: true, value: undefined };
}
