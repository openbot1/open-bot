/**
 * Agent Teams v1 — policy: giới hạn song song + leo cấp (v1.09, Đội T1).
 *
 * Hai chính sách:
 * 1. Giới hạn song song: số teammate tối đa (mặc định 8, trần 32),
 *    số task chạy song song tối đa, số task một teammate giữ cùng
 *    lúc (mặc định 1 — teammate làm xong task mới nhận task mới,
 *    tránh ôm đồm rồi bỏ dở).
 * 2. Leo cấp (escalation): chỉ dùng team khi task đơn-bot chứng minh
 *    là không đủ. Đánh giá từ tín hiệu (số subtask độc lập, số vùng
 *    file, nhiều chuyên môn, số step ước tính, deadline gấp) ra điểm
 *    phức tạp 0..100 + gợi ý team/single-bot + số teammate gợi ý.
 *    Ngưỡng: >= 50 → team; < 50 → single-bot là đủ.
 */

import {
  ABSOLUTE_MAX_TEAMMATES,
  DEFAULT_MAX_TEAMMATES,
  type TeamEscalationAssessment,
  type TeamEscalationSignals,
} from './types';

/** Ngưỡng điểm phức tạp để gợi ý dùng team thay vì single-bot. */
export const TEAM_ESCALATION_THRESHOLD = 50;

/** Số task tối đa một teammate giữ cùng lúc (mặc định 1). */
export const DEFAULT_MAX_TASKS_PER_TEAMMATE = 1;

/** Số teammate tối thiểu để gọi là team (1 teammate + lead = chưa phải team thật). */
export const MIN_TEAMMATES_FOR_TEAM = 2;

/** Validate số teammate yêu cầu: trong [1, trần tuyệt đối]. */
export function validateTeammateLimit(maxTeammates: number): string[] {
  if (!Number.isInteger(maxTeammates)) return ['maxTeammates phải là số nguyên.'];
  if (maxTeammates < 1) return ['maxTeammates phải >= 1.'];
  if (maxTeammates > ABSOLUTE_MAX_TEAMMATES) {
    return [`maxTeammates tối đa ${ABSOLUTE_MAX_TEAMMATES} (bạn yêu cầu ${maxTeammates}).`];
  }
  return [];
}

/** Validate maxParallelTasks so với maxTeammates. */
export function validateParallelLimit(maxParallelTasks: number, maxTeammates: number): string[] {
  if (!Number.isInteger(maxParallelTasks) || maxParallelTasks < 1) {
    return ['maxParallelTasks phải là số nguyên >= 1.'];
  }
  if (maxParallelTasks > maxTeammates) {
    return [
      `maxParallelTasks (${maxParallelTasks}) không được vượt maxTeammates (${maxTeammates}).`,
    ];
  }
  return [];
}

/**
 * Kiểm tra team có được thêm teammate nữa không.
 * Trả về { allowed, reason } — reason rỗng khi được phép.
 */
export function canAddTeammate(
  currentCount: number,
  maxTeammates: number,
): { allowed: boolean; reason: string } {
  if (currentCount >= maxTeammates) {
    return {
      allowed: false,
      reason: `Team đã đủ ${maxTeammates} teammate tối đa (hiện ${currentCount}). Tăng maxTeammates trong cấu hình team nếu cần.`,
    };
  }
  return { allowed: true, reason: '' };
}

/**
 * Kiểm tra có được chạy thêm task song song không (dựa trên số task
 * đang active và giới hạn maxParallelTasks).
 */
export function canRunMoreParallel(
  activeTasks: number,
  maxParallelTasks: number,
): { allowed: boolean; reason: string } {
  if (activeTasks >= maxParallelTasks) {
    return {
      allowed: false,
      reason: `Đã chạy ${activeTasks}/${maxParallelTasks} task song song tối đa.`,
    };
  }
  return { allowed: true, reason: '' };
}

/** Teammate có đang ôm quá số task cho phép không. */
export function teammateTaskLoad(
  activeTaskCount: number,
  maxTasksPerTeammate = DEFAULT_MAX_TASKS_PER_TEAMMATE,
): { overloaded: boolean; reason: string } {
  if (activeTaskCount >= maxTasksPerTeammate) {
    return {
      overloaded: true,
      reason: `Teammate đang giữ ${activeTaskCount}/${maxTasksPerTeammate} task tối đa.`,
    };
  }
  return { overloaded: false, reason: '' };
}

/** Chuẩn hóa tín hiệu đầu vào (kẹp về miền hợp lệ, thiếu → mặc định 0/false). */
export function normalizeEscalationSignals(
  input: Partial<TeamEscalationSignals>,
): TeamEscalationSignals {
  const clampInt = (v: number | undefined, max: number): number =>
    Math.max(0, Math.min(max, Math.floor(v ?? 0)));
  return {
    subtaskCount: clampInt(input.subtaskCount, 100),
    fileAreaCount: clampInt(input.fileAreaCount, 50),
    needsMultipleSpecialties: input.needsMultipleSpecialties ?? false,
    estimatedSteps: clampInt(input.estimatedSteps, 1000),
    timeSensitive: input.timeSensitive ?? false,
  };
}

/**
 * Đánh giá có nên dùng team hay single-bot.
 *
 * Điểm (tối đa 100):
 * - subtask độc lập: mỗi subtask +8, tối đa 40 (5+ subtask độc lập là
 *   tín hiệu mạnh nhất cho song song).
 * - vùng file: mỗi vùng +6, tối đa 18 (nhiều vùng → phân vùng cho
 *   nhiều teammate, tránh giẫm chân).
 * - nhiều chuyên môn: +15 (một bot khó giỏi mọi chuyên môn cùng lúc).
 * - số step ước tính: >= 40 step +12, >= 20 step +6 (việc dài → chia
 *   nhỏ để lead theo dõi từng phần).
 * - deadline gấp + song song giúp kịp: +15 (song song rút thời gian
 *   wall-clock, single-bot làm tuần tự sẽ trễ).
 */
export function assessTeamEscalation(
  input: Partial<TeamEscalationSignals>,
): TeamEscalationAssessment {
  const s = normalizeEscalationSignals(input);
  const reasons: string[] = [];
  let score = 0;

  const subtaskScore = Math.min(40, s.subtaskCount * 8);
  score += subtaskScore;
  if (s.subtaskCount >= 5) reasons.push(`${s.subtaskCount} subtask độc lập — chia cho nhiều teammate chạy song song.`);
  else if (s.subtaskCount >= 3) reasons.push(`${s.subtaskCount} subtask độc lập — có thể chia nhỏ.`);
  else if (s.subtaskCount <= 1) reasons.push('Chỉ 1 subtask — single-bot làm tuần tự là đủ.');

  const fileScore = Math.min(18, s.fileAreaCount * 6);
  score += fileScore;
  if (s.fileAreaCount >= 3) reasons.push(`${s.fileAreaCount} vùng file khác nhau — phân vùng cho từng teammate tránh xung đột.`);

  if (s.needsMultipleSpecialties) {
    score += 15;
    reasons.push('Cần nhiều chuyên môn khác nhau (research + code + review...) — một bot khó bao hết.');
  }

  if (s.estimatedSteps >= 40) {
    score += 12;
    reasons.push(`Ước tính ${s.estimatedSteps} step — việc dài, chia nhỏ để lead theo dõi từng phần.`);
  } else if (s.estimatedSteps >= 20) {
    score += 6;
    reasons.push(`Ước tính ${s.estimatedSteps} step — việc vừa dài.`);
  }

  if (s.timeSensitive) {
    score += 15;
    reasons.push('Deadline gấp — chạy song song rút thời gian wall-clock.');
  }

  score = Math.min(100, score);
  const recommendation = score >= TEAM_ESCALATION_THRESHOLD ? 'team' : 'single-bot';
  if (recommendation === 'single-bot' && reasons.length === 0) {
    reasons.push('Công việc nhỏ, ít subtask — single-bot là đủ, dùng team chỉ thêm chi phí điều phối.');
  }
  if (recommendation === 'single-bot') {
    reasons.push('Chưa đủ tín hiệu để dùng team — thử single-bot trước, leo cấp khi bot bí hoặc việc phình ra.');
  }

  // Số teammate gợi ý: 2 + 1 mỗi 2 subtask độc lập, kẹp [2, 8].
  const suggestedTeammates =
    recommendation === 'team'
      ? Math.max(MIN_TEAMMATES_FOR_TEAM, Math.min(DEFAULT_MAX_TEAMMATES, 2 + Math.floor(s.subtaskCount / 2)))
      : 0;

  return { recommendation, complexityScore: score, reasons, suggestedTeammates };
}
