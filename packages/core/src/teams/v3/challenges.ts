/**
 * Agent Teams v3 — challenges (v1.11, Đội T3).
 *
 * Khác subagent (chỉ báo cáo về main): teammate trong team được
 * thách thức/góp ý kết luận của nhau — một teammate đọc
 * resultSummary của task đã done, thấy sai thì mở challenge; người
 * bị thách thức trả lời; chỉ lead mới resolve. Mọi bước đều ghi
 * lại vào log hội thoại team (conversation) để audit.
 *
 * Thuần: thao tác trên mảng challenges + conversation của v3 state,
 * không chạm disk — service v3 giữ state và lưu.
 */

import { newTeamId } from '../types';
import type { TeamTask, Teammate } from '../types';
import {
  MAX_TEAM_CHALLENGES,
  v3StateOf,
  type TeamChallenge,
  type TeamChallengeStatus,
  type TeamConversationEntry,
  type TeamV3Result,
} from './types';

/** Input mở challenge. */
export interface OpenChallengeInput {
  taskId: string;
  challengerId: string;
  body: string;
}

/** Mở challenge cho kết luận của một task đã closed (done). */
export function openChallenge(
  challenges: TeamChallenge[],
  tasks: TeamTask[],
  teammates: Teammate[],
  input: OpenChallengeInput,
  now = Date.now(),
): TeamV3Result<{ challenge: TeamChallenge; entry: TeamConversationEntry }> {
  if (challenges.length >= MAX_TEAM_CHALLENGES) {
    return { ok: false, error: `Team đã có tối đa ${MAX_TEAM_CHALLENGES} challenge — resolve bớt challenge cũ trước.` };
  }
  const task = tasks.find((t) => t.id === input.taskId);
  if (!task) return { ok: false, error: `Không tìm thấy task ${input.taskId}.` };
  if (v3StateOf(task) !== 'closed' || task.status !== 'done') {
    return { ok: false, error: `Chỉ challenge được kết luận của task đã done (task "${task.title}" đang ${task.status}).` };
  }
  if (!task.resultSummary?.trim()) {
    return { ok: false, error: `Task "${task.title}" chưa có kết luận (resultSummary trống) — không có gì để challenge.` };
  }
  const challenger = teammates.find((m) => m.id === input.challengerId);
  if (!challenger) return { ok: false, error: `Không tìm thấy teammate ${input.challengerId}.` };
  if (!task.claimedBy) {
    return { ok: false, error: `Task "${task.title}" không rõ ai làm — không biết challenge ai.` };
  }
  if (task.claimedBy === input.challengerId) {
    return { ok: false, error: 'Không tự challenge kết luận của chính mình — nhờ teammate khác review.' };
  }
  const target = teammates.find((m) => m.id === task.claimedBy);
  const body = input.body.trim();
  if (!body) return { ok: false, error: 'Nội dung challenge không được rỗng.' };
  if (body.length > 2000) return { ok: false, error: 'Nội dung challenge tối đa 2000 ký tự.' };
  const alreadyOpen = challenges.find(
    (c) => c.taskId === task.id && c.challengerId === input.challengerId && c.status !== 'resolved',
  );
  if (alreadyOpen) {
    return { ok: false, error: `Bạn đã có challenge đang mở cho task "${task.title}" (${alreadyOpen.id}) — trả lời/resolve challenge đó trước.` };
  }
  const challenge: TeamChallenge = {
    id: newTeamId('challenge'),
    teamId: '',
    taskId: task.id,
    taskTitle: task.title,
    challengerId: challenger.id,
    challengerName: challenger.name,
    targetId: task.claimedBy,
    targetName: target?.name ?? task.claimedBy,
    conclusion: task.resultSummary,
    body,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
  const entry: TeamConversationEntry = {
    at: now,
    kind: 'challenge',
    fromName: challenger.name,
    fromId: challenger.id,
    taskId: task.id,
    body: `${challenger.name} thách thức kết luận của ${challenge.targetName} ở task "${task.title}": ${body}`,
  };
  return { ok: true, value: { challenge, entry } };
}

/** Người bị thách thức trả lời challenge (open → answered). */
export function answerChallenge(
  challenges: TeamChallenge[],
  challengeId: string,
  answerById: string,
  answer: string,
  now = Date.now(),
): TeamV3Result<{ challenge: TeamChallenge; entry: TeamConversationEntry }> {
  const challenge = challenges.find((c) => c.id === challengeId);
  if (!challenge) return { ok: false, error: `Không tìm thấy challenge ${challengeId}.` };
  if (challenge.status === 'resolved') {
    return { ok: false, error: `Challenge ${challengeId} đã được resolve — không trả lời thêm.` };
  }
  if (challenge.targetId !== answerById) {
    return { ok: false, error: 'Chỉ người bị thách thức mới được trả lời challenge này.' };
  }
  const text = answer.trim();
  if (!text) return { ok: false, error: 'Câu trả lời không được rỗng.' };
  if (text.length > 2000) return { ok: false, error: 'Câu trả lời tối đa 2000 ký tự.' };
  const updated: TeamChallenge = {
    ...challenge,
    status: 'answered',
    answer: text,
    answeredBy: answerById,
    answeredAt: now,
    updatedAt: now,
  };
  const entry: TeamConversationEntry = {
    at: now,
    kind: 'challenge-answer',
    fromName: challenge.targetName,
    fromId: answerById,
    taskId: challenge.taskId,
    body: `${challenge.targetName} trả lời challenge của ${challenge.challengerName} ở task "${challenge.taskTitle}": ${text}`,
  };
  return { ok: true, value: { challenge: updated, entry } };
}

/** Lead resolve challenge (open/answered → resolved). */
export function resolveChallenge(
  challenges: TeamChallenge[],
  challengeId: string,
  leadId: string,
  leadName: string,
  resolution: string,
  now = Date.now(),
): TeamV3Result<{ challenge: TeamChallenge; entry: TeamConversationEntry }> {
  const challenge = challenges.find((c) => c.id === challengeId);
  if (!challenge) return { ok: false, error: `Không tìm thấy challenge ${challengeId}.` };
  if (challenge.status === 'resolved') {
    return { ok: false, error: `Challenge ${challengeId} đã được resolve trước đó.` };
  }
  const text = resolution.trim();
  if (!text) return { ok: false, error: 'Nhận xét resolve không được rỗng.' };
  if (text.length > 2000) return { ok: false, error: 'Nhận xét resolve tối đa 2000 ký tự.' };
  const updated: TeamChallenge = {
    ...challenge,
    status: 'resolved',
    resolution: text,
    resolvedBy: leadId,
    resolvedAt: now,
    updatedAt: now,
  };
  const entry: TeamConversationEntry = {
    at: now,
    kind: 'challenge-resolved',
    fromName: leadName,
    fromId: leadId,
    taskId: challenge.taskId,
    body: `Lead ${leadName} resolve challenge ở task "${challenge.taskTitle}": ${text}`,
  };
  return { ok: true, value: { challenge: updated, entry } };
}

/** Challenge đang mở của một task (để dashboard cảnh báo). */
export function openChallengesForTask(challenges: TeamChallenge[], taskId: string): TeamChallenge[] {
  return challenges.filter((c) => c.taskId === taskId && c.status !== 'resolved');
}

/** Số challenge đang mở theo teammate (challenger hoặc target). */
export function openChallengeCounts(challenges: TeamChallenge[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of challenges) {
    if (c.status === 'resolved') continue;
    counts[c.challengerId] = (counts[c.challengerId] ?? 0) + 1;
    counts[c.targetId] = (counts[c.targetId] ?? 0) + 1;
  }
  return counts;
}

/** Lọc challenge theo trạng thái. */
export function challengesByStatus(
  challenges: TeamChallenge[],
  status: TeamChallengeStatus,
): TeamChallenge[] {
  return challenges.filter((c) => c.status === status);
}

/** Tóm tắt challenge một dòng (để dashboard hiển thị). */
export function summarizeChallenges(challenges: TeamChallenge[]): string {
  const open = challenges.filter((c) => c.status === 'open').length;
  const answered = challenges.filter((c) => c.status === 'answered').length;
  const resolved = challenges.filter((c) => c.status === 'resolved').length;
  if (challenges.length === 0) return 'Chưa có challenge nào.';
  return `${challenges.length} challenge — ${open} đang mở, ${answered} đã trả lời, ${resolved} đã resolve.`;
}
