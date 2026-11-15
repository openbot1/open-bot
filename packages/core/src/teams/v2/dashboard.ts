/**
 * Agent Teams v2 — dashboard snapshot (v1.10, Đội T3).
 *
 * Gom dữ liệu v1 (team/teammate/task/mailbox/events) + trạng
 * thái v2 trên disk (lock, disk mailbox, fork, chi phí, cỡ team,
 * feedback reviewer) thành một snapshot duy nhất để UI Team
 * (AgentTeamsV2View) và tool `teams_v2_dashboard` hiển thị.
 *
 * Thuần đọc (không đổi state): đọc lock dir + disk mailbox +
 * session, tính toán từ dữ liệu đã có.
 */

import type { AgentTeamV109 } from '../types';
import { diskUnreadByName, recentDiskMessages } from './diskMailbox';
import { checkTeamSize, estimateTeamTokens } from './cost';
import { listClaimLocks } from './claimLock';
import { listTeammateSessions } from './sessions';
import type { TeamV2Dashboard, TeamV2State } from './types';

/**
 * Build dashboard snapshot v2 cho một team.
 * `baseDir` là thư mục dữ liệu của app (nơi chứa teams-v2/...).
 */
export function buildTeamV2Dashboard(
  team: AgentTeamV109,
  v2: TeamV2State,
  baseDir: string,
  now = Date.now(),
): TeamV2Dashboard {
  const sessions = listTeammateSessions(baseDir, team.id);
  const sessionOpenById = new Map(sessions.map((s) => [s.mateId, s.closedAt === undefined]));
  const assignedByMate = new Map<string, string[]>();
  for (const session of sessions) {
    assignedByMate.set(session.mateId, session.assignedTaskIds);
  }
  const taskById = new Map(team.tasks.map((t) => [t.id, t]));
  const locks = listClaimLocks(baseDir, team.id, now).map((entry) => ({
    taskId: entry.lock.taskId,
    taskTitle: taskById.get(entry.lock.taskId)?.title ?? entry.lock.taskId,
    ownerName: entry.lock.ownerName,
    leaseUntil: entry.lock.leaseUntil,
    stale: entry.stale,
  }));
  const teammateNames = team.teammates.map((m) => m.name);
  const mailboxUnreadByName = diskUnreadByName(baseDir, team.id, teammateNames);
  const recentMessages = recentDiskMessages(baseDir, team.id, teammateNames, 20);
  const diskMessageCount = teammateNames.reduce(
    (sum, name) => sum + (recentDiskMessages(baseDir, team.id, [name], 1000).length),
    0,
  );
  const cost = estimateTeamTokens(
    {
      teammates: team.teammates.length,
      tasks: team.tasks.length,
      messages: team.messages.length + diskMessageCount,
      forks: v2.forks.length,
    },
    v2.config,
  );
  const sizeCheck = checkTeamSize(team.teammates.length, v2.config);
  const lead = team.teammates.find((m) => m.id === team.leadId);
  return {
    teamId: team.id,
    teamName: team.name,
    goal: team.goal,
    status: team.status,
    leadName: lead?.name ?? '?',
    teammates: team.teammates.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      status: m.status,
      specialty: m.specialty,
      currentTaskId: m.currentTaskId,
      currentTaskTitle: m.currentTaskId
        ? taskById.get(m.currentTaskId)?.title
        : undefined,
      tasksDone: m.tasksDone,
      tasksFailed: m.tasksFailed,
      sessionOpen: sessionOpenById.get(m.id) ?? false,
      assignedTaskIds: assignedByMate.get(m.id) ?? [],
    })),
    tasks: [...team.tasks],
    locks,
    mailboxUnreadByName,
    recentMessages,
    forks: [...v2.forks],
    cost,
    sizeCheck,
    reviewFeedback: [...v2.reviewFeedback],
    events: team.events.slice(-50).map((e) => ({ at: e.at, type: e.type, message: e.message })),
  };
}
