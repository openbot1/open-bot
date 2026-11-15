/**
 * Agent Teams v1 tools (v1.09, Đội T1) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * - `team_create` — tạo team mới với một lead (tên + mục tiêu +
 *   cấu hình giới hạn: maxTeammates mặc định 8, maxParallelTasks,
 *   partitionMode, timeout). Lưu vào `<userData>/agent-teams-v109.json`.
 * - `team_add_teammate` — thêm teammate (tên, model, specialty,
 *   partition); vượt giới hạn hoặc partition chồng → lỗi rõ ràng.
 * - `team_assign_task` — thêm task vào danh sách chia sẻ (title,
 *   detail, dependsOn, priority, touchesFiles, maxAttempts);
 *   dependency không tồn tại hoặc chu trình → lỗi.
 * - `team_claim_task` — teammate claim task (kiểm tra dependency
 *   done + file-lock + mỗi teammate tối đa 1 task cùng lúc).
 * - `team_complete_task` — teammate hoàn thành task (ghi
 *   resultSummary; team tự completed khi mọi task done).
 * - `team_send_message` — gửi tin mailbox (request/result/question/
 *   broadcast; broadcast + question cho lead theo đúng luật).
 * - `team_status` — tóm tắt team (teammate, task theo trạng thái,
 *   task ready, tin chưa đọc, xung đột file) hoặc tất cả team.
 * - `team_mailbox` — đọc hộp thư đến của một teammate + question
 *   chưa trả lời; có thể đánh dấu đã đọc.
 * - `team_list` — liệt kê team (id, tên, trạng thái, số teammate/task).
 * - `team_assess` — đánh giá có nên dùng team hay single-bot từ tín
 *   hiệu (số subtask độc lập, vùng file, chuyên môn, step, deadline).
 * - `team_worktree` — lập kế hoạch worktree cho teammate (branch +
 *   đường dẫn). CHỈ LẬP KẾ HOẠCH — không chạy git.
 *
 * Như các tool fleet trước, đây là placeholder trong ALL_TOOLS cho
 * tới khi host bind: `createAgentTeamsV109Tools(getBaseDir)` với
 * userData dir của app. Tool ghi file cần approval; tool chỉ đọc /
 * tính toán thì không.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  AGENT_TEAMS_V109_FILE,
  TeamService,
  TeamsV109Store,
  assessTeamEscalation,
  planTeammateWorktree,
  type AgentTeamV109,
} from '@open-bot/core';

export const TEAM_V109_TOOL_NAMES = [
  'team_create',
  'team_add_teammate',
  'team_assign_task',
  'team_claim_task',
  'team_complete_task',
  'team_send_message',
  'team_status',
  'team_mailbox',
  'team_list',
  'team_assess',
  'team_worktree',
] as const;

const NOT_WIRED =
  'Agent Teams v1 chưa được cấu hình (thiếu thư mục dữ liệu của app).';

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

function loadTeams(store: TeamsV109Store): { teams: AgentTeamV109[]; loadError?: string } {
  return store.load();
}

function saveTeams(store: TeamsV109Store, teams: AgentTeamV109[]): void {
  store.save(teams);
}

/** Thay team đã sửa vào danh sách rồi lưu (theo id). */
function upsertTeam(teams: AgentTeamV109[], updated: AgentTeamV109): AgentTeamV109[] {
  return teams.map((t) => (t.id === updated.id ? updated : t));
}

function summarizeTeamLine(team: AgentTeamV109): string {
  const s = TeamService.restore(team).summary();
  return (
    `- ${s.name} (${s.id}): ${s.status}, lead ${s.leadName}, ` +
    `${s.teammateCount} teammate (${s.workingTeammates} đang làm, ${s.idleTeammates} rảnh), ` +
    `task ${s.tasksDone}/${s.tasksTotal} xong, ${s.tasksReady} sẵn sàng, ` +
    `${s.tasksFailed} lỗi, ${s.unreadMessages} tin chưa đọc.`
  );
}

export function createAgentTeamsV109Tools(
  getBaseDir?: () => string | null | undefined,
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const storeFor = (): TeamsV109Store | null => {
    const base = resolveBase();
    if (!base) return null;
    return new TeamsV109Store(base);
  };

  const teamCreateTool: Tool = {
    definition: toolDef(
      'team_create',
      'Create an Agent Team v1: one lead bot coordinates teammate bots running in parallel in the same session, sharing a task list. Teammates claim tasks (file-locked, dependency-ordered) and talk through a mailbox. Saved to <userData>/agent-teams-v109.json.',
      {
        name: { type: 'string', description: 'Team name (unique in the teams file).' },
        goal: { type: 'string', description: 'Shared goal of the team.' },
        leadName: { type: 'string', description: 'Name of the lead bot (default "lead").' },
        defaultModel: { type: 'string', description: 'Default model for the team.' },
        maxTeammates: { type: 'number', description: 'Max teammates (default 8, at most 32).' },
        maxParallelTasks: { type: 'number', description: 'Max tasks running in parallel (default = maxTeammates).' },
        partitionMode: { type: 'string', description: '"directory" (default) or "worktree" file partitioning.' },
      },
      ['name', 'goal'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const store = storeFor();
      if (!store) return errorResult(NOT_WIRED);
      try {
        const { teams, loadError } = loadTeams(store);
        const name = getStringArg(args, 'name');
        if (teams.some((t) => t.name.toLowerCase() === name.trim().toLowerCase())) {
          return errorResult(`Đã có team tên "${name.trim()}" — đặt tên khác.`);
        }
        const config: Record<string, unknown> = {};
        const maxTeammates = getNumberArg(args, 'maxTeammates', 0);
        if (maxTeammates > 0) config.maxTeammates = maxTeammates;
        const maxParallel = getNumberArg(args, 'maxParallelTasks', 0);
        if (maxParallel > 0) config.maxParallelTasks = maxParallel;
        const partitionMode = getOptionalStringArg(args, 'partitionMode');
        if (partitionMode) {
          if (partitionMode !== 'directory' && partitionMode !== 'worktree') {
            return errorResult('partitionMode chỉ nhận "directory" hoặc "worktree".');
          }
          config.partitionMode = partitionMode;
        }
        const created = TeamService.create({
          name,
          goal: getStringArg(args, 'goal'),
          leadName: getOptionalStringArg(args, 'leadName'),
          defaultModel: getOptionalStringArg(args, 'defaultModel'),
          config,
        });
        if (!created.ok) return errorResult(created.error);
        const team = created.value.snapshot;
        saveTeams(store, [...teams, team]);
        const warn = loadError ? ` (cảnh báo: file team cũ lỗi, đã bắt đầu mới: ${loadError})` : '';
        return (
          `Đã tạo team "${team.name}" (${team.id}), lead "${team.teammates[0].name}", ` +
          `tối đa ${team.config.maxTeammates} teammate, ${team.config.maxParallelTasks} task song song, ` +
          `lưu tại ${path.join(store.path)}.${warn}`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const teamAddTeammateTool: Tool = {
    definition: toolDef(
      'team_add_teammate',
      'Add a teammate bot to an Agent Team v1 (name, model, specialty, file partition). Fails when the team is full or the partition overlaps another teammate.',
      {
        teamId: { type: 'string', description: 'Team id (from team_create / team_list).' },
        name: { type: 'string', description: 'Teammate display name (unique in the team).' },
        model: { type: 'string', description: 'Model this teammate runs (default: team model).' },
        specialty: { type: 'string', description: 'Specialty role (researcher/coder/reviewer/...).' },
        partition: { type: 'string', description: 'File area owned, path prefix e.g. "packages/core/src/memory/".' },
      },
      ['teamId', 'name'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const store = storeFor();
      if (!store) return errorResult(NOT_WIRED);
      try {
        const { teams } = loadTeams(store);
        const teamId = getStringArg(args, 'teamId');
        const team = teams.find((t) => t.id === teamId);
        if (!team) return errorResult(`Không tìm thấy team ${teamId}.`);
        const service = TeamService.restore(team);
        const added = service.addTeammate({
          name: getStringArg(args, 'name'),
          model: getOptionalStringArg(args, 'model'),
          specialty: getOptionalStringArg(args, 'specialty'),
          partition: getOptionalStringArg(args, 'partition'),
        });
        if (!added.ok) return errorResult(added.error);
        saveTeams(store, upsertTeam(teams, service.snapshot));
        return (
          `Đã thêm teammate "${added.value.name}" (${added.value.id}) vào team "${team.name}"` +
          (added.value.partition ? `, partition "${added.value.partition}"` : '') +
          `. Team hiện có ${service.snapshot.teammates.length} thành viên.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const teamAssignTaskTool: Tool = {
    definition: toolDef(
      'team_assign_task',
      'Add a task to the shared task list of an Agent Team v1 (title, detail, dependsOn task ids, priority 1-5, files it will touch, maxAttempts). Dependency must exist and must not form a cycle.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        title: { type: 'string', description: 'Short task title.' },
        detail: { type: 'string', description: 'What needs doing (no secrets).' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish first.' },
        priority: { type: 'number', description: 'Priority 1 (lowest) to 5 (highest), default 3.' },
        touchesFiles: { type: 'array', items: { type: 'string' }, description: 'Relative file paths this task will touch (file-lock).' },
        maxAttempts: { type: 'number', description: 'Max attempts (default 3).' },
      },
      ['teamId', 'title'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const store = storeFor();
      if (!store) return errorResult(NOT_WIRED);
      try {
        const { teams } = loadTeams(store);
        const teamId = getStringArg(args, 'teamId');
        const team = teams.find((t) => t.id === teamId);
        if (!team) return errorResult(`Không tìm thấy team ${teamId}.`);
        const service = TeamService.restore(team);
        const added = service.addTask({
          title: getStringArg(args, 'title'),
          detail: getOptionalStringArg(args, 'detail'),
          dependsOn: getStringArrayArg(args, 'dependsOn'),
          priority: getNumberArg(args, 'priority', 3) as 1 | 2 | 3 | 4 | 5,
          touchesFiles: getStringArrayArg(args, 'touchesFiles'),
          maxAttempts: getNumberArg(args, 'maxAttempts', 3),
        });
        if (!added.ok) return errorResult(added.error);
        saveTeams(store, upsertTeam(teams, service.snapshot));
        return (
          `Đã thêm task "${added.value.title}" (${added.value.id}) vào team "${team.name}"` +
          (added.value.dependsOn.length > 0 ? `, chờ ${added.value.dependsOn.length} dependency` : '') +
          (added.value.touchesFiles.length > 0 ? `, khóa file: ${added.value.touchesFiles.join(', ')}` : '') +
          `.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const teamClaimTaskTool: Tool = {
    definition: toolDef(
      'team_claim_task',
      'Claim a task from the shared task list for a teammate (atomic: only one owner). Fails when dependencies are not done, a touched file is locked by another task, or the teammate already holds a task.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskId: { type: 'string', description: 'Task id to claim.' },
        teammateId: { type: 'string', description: 'Teammate id claiming the task.' },
      },
      ['teamId', 'taskId', 'teammateId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const store = storeFor();
      if (!store) return errorResult(NOT_WIRED);
      try {
        const { teams } = loadTeams(store);
        const teamId = getStringArg(args, 'teamId');
        const team = teams.find((t) => t.id === teamId);
        if (!team) return errorResult(`Không tìm thấy team ${teamId}.`);
        const service = TeamService.restore(team);
        const claimed = service.claimTask(getStringArg(args, 'taskId'), getStringArg(args, 'teammateId'));
        if (!claimed.ok) return errorResult(claimed.error);
        saveTeams(store, upsertTeam(teams, service.snapshot));
        return `Teammate đã claim task "${claimed.value.title}" (${claimed.value.id}), lần thử ${claimed.value.attempts}/${claimed.value.maxAttempts}.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const teamCompleteTaskTool: Tool = {
    definition: toolDef(
      'team_complete_task',
      'Mark a claimed task done for the teammate holding it, with a short result summary. The team auto-completes when every task is done.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskId: { type: 'string', description: 'Task id to complete.' },
        teammateId: { type: 'string', description: 'Teammate id holding the task.' },
        resultSummary: { type: 'string', description: 'Short result summary (no secrets).' },
      },
      ['teamId', 'taskId', 'teammateId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const store = storeFor();
      if (!store) return errorResult(NOT_WIRED);
      try {
        const { teams } = loadTeams(store);
        const teamId = getStringArg(args, 'teamId');
        const team = teams.find((t) => t.id === teamId);
        if (!team) return errorResult(`Không tìm thấy team ${teamId}.`);
        const service = TeamService.restore(team);
        const done = service.completeTask(
          getStringArg(args, 'taskId'),
          getStringArg(args, 'teammateId'),
          getOptionalStringArg(args, 'resultSummary'),
        );
        if (!done.ok) return errorResult(done.error);
        saveTeams(store, upsertTeam(teams, service.snapshot));
        const status = service.snapshot.status === 'completed' ? ' Team đã hoàn thành (mọi task done).' : '';
        return `Task "${done.value.title}" xong.${status}`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const teamSendMessageTool: Tool = {
    definition: toolDef(
      'team_send_message',
      'Send a mailbox message inside an Agent Team v1: request (ask for work/info), result (return a result for a task), question (ask the lead when stuck), broadcast (whole team, lead only).',
      {
        teamId: { type: 'string', description: 'Team id.' },
        fromId: { type: 'string', description: 'Sender teammate id.' },
        toId: { type: 'string', description: 'Recipient teammate id, or "*" for broadcast (lead only).' },
        kind: { type: 'string', description: '"request" | "result" | "question" | "broadcast".' },
        taskId: { type: 'string', description: 'Related task id (required for result).' },
        body: { type: 'string', description: 'Message body, max 8000 chars (no secrets).' },
      },
      ['teamId', 'fromId', 'toId', 'kind', 'body'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const store = storeFor();
      if (!store) return errorResult(NOT_WIRED);
      try {
        const { teams } = loadTeams(store);
        const teamId = getStringArg(args, 'teamId');
        const team = teams.find((t) => t.id === teamId);
        if (!team) return errorResult(`Không tìm thấy team ${teamId}.`);
        const kind = getStringArg(args, 'kind');
        if (kind !== 'request' && kind !== 'result' && kind !== 'question' && kind !== 'broadcast') {
          return errorResult('kind chỉ nhận "request", "result", "question" hoặc "broadcast".');
        }
        const service = TeamService.restore(team);
        const sent = service.sendMessage({
          fromId: getStringArg(args, 'fromId'),
          toId: getStringArg(args, 'toId'),
          kind,
          taskId: getOptionalStringArg(args, 'taskId'),
          body: getStringArg(args, 'body'),
        });
        if (!sent.ok) return errorResult(sent.error);
        saveTeams(store, upsertTeam(teams, service.snapshot));
        return `Đã gửi tin ${kind} (${sent.value.id}) từ ${sent.value.fromName} tới ${sent.value.toId === '*' ? 'toàn team' : sent.value.toId}.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const teamStatusTool: Tool = {
    definition: toolDef(
      'team_status',
      'Status of an Agent Team v1 (one team by id, or all teams): teammates, tasks by status, ready tasks, unread messages, file conflicts. Read-only.',
      {
        teamId: { type: 'string', description: 'Team id (empty = all teams).' },
        includeConflicts: { type: 'boolean', description: 'Include file-conflict scan (default true).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const store = storeFor();
      if (!store) return errorResult(NOT_WIRED);
      try {
        const { teams, loadError } = loadTeams(store);
        const teamId = getOptionalStringArg(args, 'teamId');
        const includeConflicts = getBooleanArg(args, 'includeConflicts', true);
        if (teamId) {
          const team = teams.find((t) => t.id === teamId);
          if (!team) return errorResult(`Không tìm thấy team ${teamId}.`);
          const service = TeamService.restore(team);
          const s = service.summary();
          const lines = [
            `Team "${s.name}" (${s.id}) — ${s.status}, lead ${s.leadName}, mục tiêu: ${s.goal}`,
            `Teammate: ${s.teammateCount} (${s.workingTeammates} đang làm, ${s.idleTeammates} rảnh)`,
            `Task: tổng ${s.tasksTotal}, pending ${s.tasksPending}, claimed ${s.tasksClaimed}, in-progress ${s.tasksInProgress}, done ${s.tasksDone}, failed ${s.tasksFailed}, sẵn sàng claim ${s.tasksReady}`,
            `Tin chưa đọc: ${s.unreadMessages}`,
          ];
          for (const m of team.teammates) {
            lines.push(
              `  - ${m.name} (${m.id}, ${m.role}${m.specialty ? `, ${m.specialty}` : ''}): ${m.status}` +
                (m.currentTaskId ? `, đang làm ${m.currentTaskId}` : '') +
                (m.partition ? `, partition ${m.partition}` : '') +
                `, ${m.tasksDone} xong / ${m.tasksFailed} lỗi`,
            );
          }
          for (const t of service.readyTaskList()) {
            lines.push(`  - sẵn sàng: "${t.title}" (${t.id}, ưu tiên ${t.priority})`);
          }
          for (const w of service.waitingTasks()) {
            lines.push(`  - đang chờ: "${w.task.title}" chờ ${w.waitingOn.join(', ')}`);
          }
          if (includeConflicts) {
            const conflicts = service.fileConflicts();
            if (conflicts.length > 0) {
              lines.push(`Xung đột file (${conflicts.length}):`);
              for (const c of conflicts) {
                lines.push(`  - ${c.kind} "${c.file}" — teammate ${c.teammateIds.join(', ')}`);
              }
            } else {
              lines.push('Không có xung đột file.');
            }
          }
          if (loadError) lines.push(`Cảnh báo: ${loadError}`);
          return lines.join('\n');
        }
        if (teams.length === 0) return `Chưa có team nào. File: ${AGENT_TEAMS_V109_FILE}.`;
        return teams.map(summarizeTeamLine).join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const teamMailboxTool: Tool = {
    definition: toolDef(
      'team_mailbox',
      'Read a teammate inbox in an Agent Team v1 (direct messages + broadcasts), with unanswered questions to the lead. Optionally marks the inbox read. Read-only unless markRead is set.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        teammateId: { type: 'string', description: 'Teammate id whose inbox to read.' },
        markRead: { type: 'boolean', description: 'Mark the whole inbox read (default false).' },
      },
      ['teamId', 'teammateId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const store = storeFor();
      if (!store) return errorResult(NOT_WIRED);
      try {
        const { teams } = loadTeams(store);
        const teamId = getStringArg(args, 'teamId');
        const team = teams.find((t) => t.id === teamId);
        if (!team) return errorResult(`Không tìm thấy team ${teamId}.`);
        const teammateId = getStringArg(args, 'teammateId');
        if (!team.teammates.some((m) => m.id === teammateId)) {
          return errorResult(`Không tìm thấy teammate ${teammateId} trong team.`);
        }
        const service = TeamService.restore(team);
        const inbox = service.inbox(teammateId);
        const lines = [`Hộp thư của ${teammateId} trong team "${team.name}" (${inbox.length} tin):`];
        for (const m of inbox.slice(-20)) {
          lines.push(
            `  [${m.kind}] ${m.fromName} → ${m.toId === '*' ? 'toàn team' : m.toId}${m.taskId ? ` (task ${m.taskId})` : ''}: ${m.body.slice(0, 300)}${m.read ? '' : ' (chưa đọc)'}`,
          );
        }
        const unanswered = service.unansweredQuestions();
        if (unanswered.length > 0) {
          lines.push(`Question chưa trả lời (${unanswered.length}):`);
          for (const q of unanswered) {
            lines.push(`  - ${q.fromName}: ${q.body.slice(0, 200)}`);
          }
        }
        if (getBooleanArg(args, 'markRead', false)) {
          service.markAllRead(teammateId);
          saveTeams(store, upsertTeam(teams, service.snapshot));
          lines.push('Đã đánh dấu toàn bộ hộp thư là đã đọc.');
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const teamListTool: Tool = {
    definition: toolDef(
      'team_list',
      'List Agent Teams v1 (id, name, status, teammate/task counts). Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const store = storeFor();
      if (!store) return errorResult(NOT_WIRED);
      try {
        const { teams, loadError } = loadTeams(store);
        if (teams.length === 0) return `Chưa có team nào. File: ${AGENT_TEAMS_V109_FILE}.`;
        const lines = teams.map(summarizeTeamLine);
        if (loadError) lines.push(`Cảnh báo: ${loadError}`);
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const teamAssessTool: Tool = {
    definition: toolDef(
      'team_assess',
      'Assess whether a job needs an Agent Team or a single bot is enough, from signals (independent subtasks, file areas, specialties, estimated steps, deadline pressure). Pure computation, no file access.',
      {
        subtaskCount: { type: 'number', description: 'Estimated independent subtasks.' },
        fileAreaCount: { type: 'number', description: 'Distinct file areas the work touches.' },
        needsMultipleSpecialties: { type: 'boolean', description: 'Needs several specialties (research + code + review...).' },
        estimatedSteps: { type: 'number', description: 'Estimated agent steps.' },
        timeSensitive: { type: 'boolean', description: 'Tight deadline where parallel work helps.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const result = assessTeamEscalation({
        subtaskCount: getNumberArg(args, 'subtaskCount', 0),
        fileAreaCount: getNumberArg(args, 'fileAreaCount', 0),
        needsMultipleSpecialties: getBooleanArg(args, 'needsMultipleSpecialties', false),
        estimatedSteps: getNumberArg(args, 'estimatedSteps', 0),
        timeSensitive: getBooleanArg(args, 'timeSensitive', false),
      });
      const lines = [
        `Gợi ý: ${result.recommendation === 'team' ? 'dùng TEAM' : 'single-bot là đủ'} (điểm phức tạp ${result.complexityScore}/100).`,
      ];
      if (result.recommendation === 'team') {
        lines.push(`Số teammate gợi ý: ${result.suggestedTeammates}.`);
      }
      for (const reason of result.reasons) lines.push(`- ${reason}`);
      return lines.join('\n');
    },
  };

  const teamWorktreeTool: Tool = {
    definition: toolDef(
      'team_worktree',
      'Plan an isolated git worktree for a teammate of an Agent Team v1 (branch + path). PLANNING ONLY — does not run git or create directories; the host decides when to create the real worktree.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        teammateId: { type: 'string', description: 'Teammate id.' },
        repoRoot: { type: 'string', description: 'Absolute path of the repo root the worktree splits from.' },
      },
      ['teamId', 'teammateId', 'repoRoot'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const store = storeFor();
      if (!store) return errorResult(NOT_WIRED);
      try {
        const { teams } = loadTeams(store);
        const teamId = getStringArg(args, 'teamId');
        const team = teams.find((t) => t.id === teamId);
        if (!team) return errorResult(`Không tìm thấy team ${teamId}.`);
        const teammateId = getStringArg(args, 'teammateId');
        const mate = team.teammates.find((m) => m.id === teammateId);
        if (!mate) return errorResult(`Không tìm thấy teammate ${teammateId} trong team.`);
        const repoRoot = getStringArg(args, 'repoRoot');
        if (!path.isAbsolute(repoRoot)) return errorResult('repoRoot phải là đường dẫn tuyệt đối.');
        const planned = planTeammateWorktree(team, mate, repoRoot);
        if (!planned.ok || !planned.plan) return errorResult((planned.errors ?? ['Không lập được kế hoạch worktree.']).join(' '));
        return (
          `Worktree cho "${mate.name}": branch "${planned.plan.branch}", ` +
          `đường dẫn "${planned.plan.worktreePath}" (tách từ "${planned.plan.repoRoot}"). ` +
          `CHỈ LÀ KẾ HOẠCH — chưa tạo thư mục, chưa chạy git.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    teamCreateTool,
    teamAddTeammateTool,
    teamAssignTaskTool,
    teamClaimTaskTool,
    teamCompleteTaskTool,
    teamSendMessageTool,
    teamStatusTool,
    teamMailboxTool,
    teamListTool,
    teamAssessTool,
    teamWorktreeTool,
  ];
}

/** Unbound placeholders for ALL_TOOLS (bound by createDefaultTools when wired). */
export const TEAM_V109_TOOLS: Tool[] = createAgentTeamsV109Tools();
