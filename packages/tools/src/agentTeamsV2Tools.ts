/**
 * Agent Teams v2 tools (v1.10, Đội T3) — registered in ALL_TOOLS
 * (see tools.ts, same replace-in-place pattern as v1).
 *
 * V2 thêm trên v1 (team_* giữ nguyên):
 * - `teams_v2_claim` — claim task 2 lớp: v1 claim + disk lock
 *   (lease + heartbeat). Lock disk lỗi → rollback claim v1.
 * - `teams_v2_heartbeat` — gia hạn lease lock của task đang giữ.
 * - `teams_v2_release` — nhả task + xóa disk lock.
 * - `teams_v2_requeue_stale` — sweep lock treo (teammate chết):
 *   task về pending để teammate khác claim lại.
 * - `teams_v2_spawn` — lead spawn teammate (kiểm tra cỡ team
 *   3–5 + cảnh báo token, tạo session file riêng).
 * - `teams_v2_assign` — lead giao task cho một teammate (worker
 *   chỉ claim task được giao).
 * - `teams_v2_aggregate` — lead tổng hợp kết quả team.
 * - `teams_v2_cost` — ước tính token + cảnh báo vượt ngân sách.
 * - `teams_v2_complete` — teammate hoàn thành task (merge fork
 *   done + chạy hook TaskCompleted; exit 2 = giữ task mở kèm
 *   feedback, task về pending).
 * - `teams_v2_config` — xem/sửa cấu hình v2 (hook command, ngân
 *   sách token, lease, giới hạn fork, allowOverRecommended).
 * - `teams_v2_dashboard` — snapshot dashboard v2 (team, teammate,
 *   task, lock, mailbox, fork, chi phí, log hoạt động).
 * - `mailbox_v2_send` — gửi tin disk mailbox theo TÊN teammate
 *   (direct/broadcast), bền vững trên disk.
 * - `mailbox_v2_inbox` — đọc inbox disk theo tên + xác nhận đã đọc.
 * - `mailbox_v2_outbox` — đọc outbox disk theo tên.
 * - `fork_v2_spawn` — spawn fork subagent (context riêng, giới
 *   hạn độ sâu + song song).
 * - `fork_v2_complete` — fork xong (tóm tắt + artifact).
 * - `fork_v2_merge` — merge kết quả fork về task cha.
 * - `fork_v2_status` — cây fork của team (trạng thái, đã merge chưa).
 *
 * Như tool v1: placeholder trong ALL_TOOLS cho tới khi host bind:
 * `createAgentTeamsV2Tools(getBaseDir)` với userData dir của app
 * (dùng chung thư mục với v1 — v2 lưu thêm `teams-v2/<teamId>/`).
 * Tool ghi file cần approval; tool chỉ đọc / tính toán thì không.
 */

import type { Tool } from '@open-bot/core';
import {
  TeamServiceV2,
  type TeamV2Dashboard,
} from '@open-bot/core';

export const TEAM_V2_TOOL_NAMES = [
  'teams_v2_claim',
  'teams_v2_heartbeat',
  'teams_v2_release',
  'teams_v2_requeue_stale',
  'teams_v2_spawn',
  'teams_v2_assign',
  'teams_v2_aggregate',
  'teams_v2_cost',
  'teams_v2_complete',
  'teams_v2_config',
  'teams_v2_dashboard',
  'mailbox_v2_send',
  'mailbox_v2_inbox',
  'mailbox_v2_outbox',
  'fork_v2_spawn',
  'fork_v2_complete',
  'fork_v2_merge',
  'fork_v2_status',
] as const;

const NOT_WIRED = 'Agent Teams v2 chưa được cấu hình (thiếu thư mục dữ liệu của app).';

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

function loadV2(baseDir: string, teamId: string): TeamServiceV2 | null {
  const { service } = TeamServiceV2.load(baseDir, teamId);
  return service;
}

function dashboardLines(d: TeamV2Dashboard): string[] {
  const lines = [
    `Team "${d.teamName}" (${d.teamId}) — ${d.status}, lead ${d.leadName}, mục tiêu: ${d.goal}`,
    `Teammate: ${d.teammates.length} (${d.teammates.filter((m) => m.status === 'working').length} đang làm, ${d.teammates.filter((m) => m.status === 'idle').length} rảnh)`,
    `Task: tổng ${d.tasks.length}, done ${d.tasks.filter((t) => t.status === 'done').length}, pending ${d.tasks.filter((t) => t.status === 'pending').length}, claimed/in-progress ${d.tasks.filter((t) => t.status === 'claimed' || t.status === 'in-progress').length}, failed ${d.tasks.filter((t) => t.status === 'failed').length}`,
    `Chi phí token ước tính: ${d.cost.estimatedTokens.toLocaleString('en-US')} / ${d.cost.budget.toLocaleString('en-US')} (${Math.round(d.cost.usageRatio * 100)}%, mức ${d.cost.level})`,
  ];
  for (const warning of d.cost.warnings) lines.push(`  ⚠️ ${warning}`);
  for (const warning of d.sizeCheck.warnings) lines.push(`  ⚠️ ${warning}`);
  if (d.locks.length > 0) {
    lines.push(`Lock đang giữ (${d.locks.length}):`);
    for (const lock of d.locks) {
      lines.push(
        `  - "${lock.taskTitle}" — ${lock.ownerName}, lease tới ${new Date(lock.leaseUntil).toISOString()}${lock.stale ? ' (TREO)' : ''}`,
      );
    }
  }
  if (d.forks.length > 0) {
    lines.push(`Fork (${d.forks.length}):`);
    for (const fork of d.forks) {
      lines.push(
        `  - ${fork.name} (tầng ${fork.depth}, ${fork.status}${fork.merged ? ', đã merge' : ''}): ${fork.resultSummary ?? fork.task}`,
      );
    }
  }
  if (d.reviewFeedback.length > 0) {
    lines.push(`Feedback reviewer đang giữ task mở (${d.reviewFeedback.length}):`);
    for (const review of d.reviewFeedback) {
      lines.push(`  - task ${review.taskId}: ${review.feedback}`);
    }
  }
  return lines;
}

export function createAgentTeamsV2Tools(
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

  const teamV2OrError = (teamId: string): TeamServiceV2 | string => {
    const base = resolveBase();
    if (!base) return errorResult(NOT_WIRED);
    const service = loadV2(base, teamId);
    if (!service) return errorResult(`Không tìm thấy team ${teamId}.`);
    return service;
  };

  const claimTool: Tool = {
    definition: toolDef(
      'teams_v2_claim',
      'Claim a task with a disk-backed file lock (Agent Teams v2): atomic across processes, lease + heartbeat. Fails when the task is assigned to another teammate, dependencies are not done, a touched file is locked, or another teammate holds the disk lock.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskId: { type: 'string', description: 'Task id to claim.' },
        teammateId: { type: 'string', description: 'Teammate id claiming the task.' },
      },
      ['teamId', 'taskId', 'teammateId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const claimed = loaded.claimTask(getStringArg(args, 'taskId'), getStringArg(args, 'teammateId'));
        if (!claimed.ok) return errorResult(claimed.error);
        loaded.save();
        return (
          `Teammate đã claim task "${claimed.value.task.title}" (${claimed.value.task.id}) với disk lock, ` +
          `lease tới ${new Date(claimed.value.leaseUntil).toISOString()} — nhớ heartbeat trước khi hết lease.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const heartbeatTool: Tool = {
    definition: toolDef(
      'teams_v2_heartbeat',
      'Renew the disk-lock lease of a claimed task (Agent Teams v2). Call regularly (recommended every 60s, lease is 5 minutes by default) while working, otherwise the lock goes stale and the lead may requeue the task.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskId: { type: 'string', description: 'Task id whose lock to renew.' },
        teammateId: { type: 'string', description: 'Teammate id holding the lock.' },
      },
      ['teamId', 'taskId', 'teammateId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const renewed = loaded.heartbeat(getStringArg(args, 'taskId'), getStringArg(args, 'teammateId'));
        if (!renewed.ok) return errorResult(renewed.error);
        return `Đã gia hạn lease task ${getStringArg(args, 'taskId')} tới ${new Date(renewed.value.leaseUntil).toISOString()}.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const releaseTool: Tool = {
    definition: toolDef(
      'teams_v2_release',
      'Release a claimed task back to pending and drop its disk lock (Agent Teams v2).',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskId: { type: 'string', description: 'Task id to release.' },
        teammateId: { type: 'string', description: 'Teammate id holding the task.' },
      },
      ['teamId', 'taskId', 'teammateId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const released = loaded.releaseTask(getStringArg(args, 'taskId'), getStringArg(args, 'teammateId'));
        if (!released.ok) return errorResult(released.error);
        loaded.save();
        return `Task "${released.value.title}" đã nhả về pending, disk lock đã xóa.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const requeueStaleTool: Tool = {
    definition: toolDef(
      'teams_v2_requeue_stale',
      'Requeue tasks whose disk-lock lease expired (Agent Teams v2): a teammate that stopped heartbeating is treated as dead, its tasks go back to pending for others to claim. Read-only when nothing is stale.',
      {
        teamId: { type: 'string', description: 'Team id.' },
      },
      ['teamId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const result = loaded.requeueStale();
        if (result.requeued.length > 0) loaded.save();
        const lines = [`Đã quét lock treo: ${result.requeued.length} task requeue, ${result.failed.length} lỗi.`];
        for (const r of result.requeued) {
          lines.push(`  - "${r.taskTitle}" (${r.taskId}) — lock của ${r.ownerName} hết lease, về pending.`);
        }
        for (const f of result.failed) lines.push(`  - lỗi ${f.taskId}: ${f.error}`);
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const spawnTool: Tool = {
    definition: toolDef(
      'teams_v2_spawn',
      'Lead spawns a new teammate (Agent Teams v2): checks the recommended team size 3-5 and token-cost warnings, creates the teammate with its own session/context file.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        name: { type: 'string', description: 'Teammate display name (unique in the team).' },
        model: { type: 'string', description: 'Model this teammate runs (default: team model).' },
        specialty: { type: 'string', description: 'Specialty role (researcher/coder/reviewer/...).' },
        partition: { type: 'string', description: 'File area owned, path prefix e.g. "packages/core/src/memory/".' },
      },
      ['teamId', 'name'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const spawned = loaded.spawnTeammate({
          name: getStringArg(args, 'name'),
          model: getOptionalStringArg(args, 'model'),
          specialty: getOptionalStringArg(args, 'specialty'),
          partition: getOptionalStringArg(args, 'partition'),
        });
        if (!spawned.ok) return errorResult(spawned.error);
        loaded.save();
        const lines = [
          `Đã spawn teammate "${spawned.value.mate.name}" (${spawned.value.mate.id}) vào team "${loaded.snapshot.name}"` +
            `, session riêng đã tạo. Team hiện có ${loaded.snapshot.teammates.length} thành viên.`,
        ];
        for (const w of spawned.value.warnings) lines.push(`  ⚠️ ${w}`);
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const assignTool: Tool = {
    definition: toolDef(
      'teams_v2_assign',
      'Lead assigns a pending task to one specific teammate (Agent Teams v2). After assignment only that teammate can claim the task; other workers get a clear error.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskId: { type: 'string', description: 'Task id to assign.' },
        teammateId: { type: 'string', description: 'Teammate id to assign the task to.' },
      },
      ['teamId', 'taskId', 'teammateId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const assigned = loaded.assignTask(getStringArg(args, 'taskId'), getStringArg(args, 'teammateId'));
        if (!assigned.ok) return errorResult(assigned.error);
        loaded.save();
        return `Lead đã giao task ${assigned.value.taskId} cho "${assigned.value.teammateName}" — chỉ teammate này claim được.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const aggregateTool: Tool = {
    definition: toolDef(
      'teams_v2_aggregate',
      'Lead aggregates team results (Agent Teams v2): per-teammate done/failed counts with result summaries. Read-only.',
      {
        teamId: { type: 'string', description: 'Team id.' },
      },
      ['teamId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        return loaded.aggregateResults().reportText;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const costTool: Tool = {
    definition: toolDef(
      'teams_v2_cost',
      'Estimate the token cost of an Agent Team v2 (teammates x tasks x messages x forks) against the configured budget, with warnings at 80% and over budget. Read-only, heuristic estimate — not a provider meter reading.',
      {
        teamId: { type: 'string', description: 'Team id.' },
      },
      ['teamId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const cost = loaded.costEstimate();
        const lines = [
          `Chi phí token ước tính team "${loaded.snapshot.name}": ${cost.estimatedTokens.toLocaleString('en-US')} / ${cost.budget.toLocaleString('en-US')} token (${Math.round(cost.usageRatio * 100)}%, mức ${cost.level}).`,
          `  - teammate: ${cost.teammates} x ${cost.byTeammate / Math.max(1, cost.teammates)} = ${cost.byTeammate.toLocaleString('en-US')}`,
          `  - task: ${cost.tasks} x ${cost.byTask / Math.max(1, cost.tasks)} = ${cost.byTask.toLocaleString('en-US')}`,
          `  - tin nhắn: ${cost.messages} x ${cost.byMessage / Math.max(1, cost.messages)} = ${cost.byMessage.toLocaleString('en-US')}`,
          `  - fork: ${cost.forks} x ${cost.byFork / Math.max(1, cost.forks)} = ${cost.byFork.toLocaleString('en-US')}`,
        ];
        for (const w of cost.warnings) lines.push(`  ⚠️ ${w}`);
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const completeTool: Tool = {
    definition: toolDef(
      'teams_v2_complete',
      'Mark a claimed task done (Agent Teams v2): merges finished forks into the result, then runs the configured TaskCompleted hook. Hook exit 2 keeps the task OPEN with reviewer feedback — the task goes back to pending for rework.',
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
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const done = await loaded.completeTask(
          getStringArg(args, 'taskId'),
          getStringArg(args, 'teammateId'),
          getOptionalStringArg(args, 'resultSummary'),
        );
        if (!done.ok) return errorResult(done.error);
        loaded.save();
        if (done.value.heldOpen) {
          return (
            `Hook TaskCompleted GIỮ task "${done.value.task.title}" MỞ (exit 2) — task đã về pending để làm lại. ` +
            `Feedback: ${done.value.feedback ?? '(không có feedback)'}`
          );
        }
        const hookNote = done.value.hookRan
          ? ` Hook TaskCompleted chấp nhận (exit ${done.value.hook?.exitCode ?? 0}).`
          : '';
        const hookError = done.value.hook?.hookError ? ` Cảnh báo hook: ${done.value.hook.hookError}` : '';
        const status = loaded.snapshot.status === 'completed' ? ' Team đã hoàn thành (mọi task done).' : '';
        return `Task "${done.value.task.title}" xong.${hookNote}${hookError}${status}`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const configTool: Tool = {
    definition: toolDef(
      'teams_v2_config',
      'View or update Agent Teams v2 config for a team: TaskCompleted hook command, token budget, claim lease, fork limits, allowOverRecommended. No args besides teamId = view current config. Read-only unless a value is set.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskCompletedHookCommand: { type: 'string', description: 'Shell command run when a teammate marks a task done (exit 2 = keep task open with feedback). Empty string clears it.' },
        tokenBudget: { type: 'number', description: 'Token budget for cost warnings.' },
        claimLeaseMs: { type: 'number', description: 'Claim-lock lease in ms (default 300000).' },
        maxForkDepth: { type: 'number', description: 'Max fork depth (default 3).' },
        maxConcurrentForks: { type: 'number', description: 'Max concurrent forks (default 5, at most 20).' },
        allowOverRecommended: { type: 'boolean', description: 'Allow more than 5 teammates (recommended max).' },
      },
      ['teamId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const patch: Record<string, unknown> = {};
        const hook = getOptionalStringArg(args, 'taskCompletedHookCommand');
        if (hook !== undefined) patch.taskCompletedHookCommand = hook.trim() ? hook : undefined;
        const budget = getNumberArg(args, 'tokenBudget', 0);
        if (budget > 0) patch.tokenBudget = budget;
        const lease = getNumberArg(args, 'claimLeaseMs', 0);
        if (lease > 0) patch.claimLeaseMs = lease;
        const depth = getNumberArg(args, 'maxForkDepth', 0);
        if (depth > 0) patch.maxForkDepth = depth;
        const forks = getNumberArg(args, 'maxConcurrentForks', 0);
        if (forks > 0) patch.maxConcurrentForks = forks;
        if (args.allowOverRecommended !== undefined) {
          patch.allowOverRecommended = getBooleanArg(args, 'allowOverRecommended', false);
        }
        if (Object.keys(patch).length > 0) {
          const updated = loaded.updateV2Config(patch as Parameters<TeamServiceV2['updateV2Config']>[0]);
          if (!updated.ok) return errorResult(updated.error);
          loaded.save();
        }
        const c = loaded.config;
        return [
          `Cấu hình v2 team "${loaded.snapshot.name}":`,
          `  - hook TaskCompleted: ${c.taskCompletedHookCommand ?? '(không cấu hình)'}`,
          `  - ngân sách token: ${c.tokenBudget.toLocaleString('en-US')} (cảnh báo ở ${Math.round(c.tokenWarnRatio * 100)}%)`,
          `  - team khuyến nghị: ${c.recommendedMinTeammates}–${c.recommendedMaxTeammates} teammate (vượt: ${c.allowOverRecommended ? 'cho phép' : 'chặn'})`,
          `  - claim lease: ${c.claimLeaseMs}ms, heartbeat khuyến nghị ${c.heartbeatIntervalMs}ms`,
          `  - fork: sâu tối đa ${c.maxForkDepth}, song song tối đa ${c.maxConcurrentForks}`,
          `  - token ước tính: teammate ${c.tokensPerTeammate}, task ${c.tokensPerTask}, tin ${c.tokensPerMessage}, fork ${c.tokensPerFork}`,
        ].join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const dashboardTool: Tool = {
    definition: toolDef(
      'teams_v2_dashboard',
      'Full Agent Teams v2 dashboard snapshot: teammates + status, tasks, disk locks, mailbox unread counts, forks, token cost, team-size check, reviewer feedback, activity log. Read-only.',
      {
        teamId: { type: 'string', description: 'Team id.' },
      },
      ['teamId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const d = loaded.dashboard();
        const lines = dashboardLines(d);
        lines.push(`Teammate (${d.teammates.length}):`);
        for (const m of d.teammates) {
          lines.push(
            `  - ${m.name} (${m.role}${m.specialty ? `, ${m.specialty}` : ''}): ${m.status}` +
              (m.currentTaskTitle ? `, đang làm "${m.currentTaskTitle}"` : '') +
              `, ${m.tasksDone} xong / ${m.tasksFailed} lỗi, session ${m.sessionOpen ? 'mở' : 'đóng'}` +
              (m.assignedTaskIds.length > 0 ? `, được giao ${m.assignedTaskIds.length} task` : ''),
          );
        }
        lines.push(`Task (${d.tasks.length}):`);
        for (const t of d.tasks) {
          lines.push(
            `  - "${t.title}" (${t.id}): ${t.status}` +
              (t.claimedBy ? `, giữ bởi ${d.teammates.find((m) => m.id === t.claimedBy)?.name ?? t.claimedBy}` : '') +
              (t.resultSummary ? ` — ${t.resultSummary.slice(0, 200)}` : ''),
          );
        }
        if (d.recentMessages.length > 0) {
          lines.push(`Tin nhắn mới (${d.recentMessages.length}):`);
          for (const msg of d.recentMessages.slice(0, 10)) {
            lines.push(
              `  - [${msg.kind}] ${msg.fromName} → ${msg.toName === '*' ? 'toàn team' : msg.toName}: ${msg.body.slice(0, 200)}${msg.read ? '' : ' (chưa đọc)'}`,
            );
          }
        }
        if (d.events.length > 0) {
          lines.push('Log hoạt động mới nhất:');
          for (const e of d.events.slice(-10)) {
            lines.push(`  - ${new Date(e.at).toISOString()} [${e.type}] ${e.message}`);
          }
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const mailboxSendTool: Tool = {
    definition: toolDef(
      'mailbox_v2_send',
      'Send a message through the disk mailbox by teammate NAME (Agent Teams v2): request/result/question/broadcast. Persisted on disk (inbox of the recipient + outbox of the sender). Broadcast ("*" — lead only) reaches every teammate.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        fromName: { type: 'string', description: 'Sender teammate name.' },
        toName: { type: 'string', description: 'Recipient teammate name, or "*" for broadcast (lead only).' },
        kind: { type: 'string', description: '"request" | "result" | "question" | "broadcast".' },
        taskId: { type: 'string', description: 'Related task id (required for result).' },
        body: { type: 'string', description: 'Message body, max 8000 chars (no secrets).' },
      },
      ['teamId', 'fromName', 'toName', 'kind', 'body'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const kind = getStringArg(args, 'kind');
        if (kind !== 'request' && kind !== 'result' && kind !== 'question' && kind !== 'broadcast') {
          return errorResult('kind chỉ nhận "request", "result", "question" hoặc "broadcast".');
        }
        const sent = loaded.sendDiskMessage({
          fromName: getStringArg(args, 'fromName'),
          toName: getStringArg(args, 'toName'),
          kind,
          taskId: getOptionalStringArg(args, 'taskId'),
          body: getStringArg(args, 'body'),
        });
        if (!sent.ok) return errorResult(sent.error);
        return `Đã gửi tin ${kind} (${sent.value.id}) từ ${sent.value.fromName} tới ${sent.value.toName === '*' ? 'toàn team' : sent.value.toName} (lưu disk).`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const mailboxInboxTool: Tool = {
    definition: toolDef(
      'mailbox_v2_inbox',
      'Read a teammate inbox from the disk mailbox by NAME (Agent Teams v2): direct messages + broadcasts, with read receipts. Optionally marks messages read. Read-only unless markRead is set.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        teammateName: { type: 'string', description: 'Teammate name whose inbox to read.' },
        markRead: { type: 'boolean', description: 'Mark the whole inbox read (default false).' },
        messageId: { type: 'string', description: 'Mark one message read by id (instead of the whole inbox).' },
      },
      ['teamId', 'teammateName'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const name = getStringArg(args, 'teammateName');
        if (!loaded.findTeammateByName(name)) {
          return errorResult(`Không có teammate tên "${name}" trong team.`);
        }
        const box = loaded.diskMailboxBox(name);
        const lines = [`Hộp thư đến của "${name}" trong team "${loaded.snapshot.name}" (${box.inbox.length} tin, ${box.unreadCount} chưa đọc):`];
        for (const m of box.inbox.slice(-20)) {
          lines.push(
            `  [${m.kind}] ${m.fromName} → ${m.toName === '*' ? 'toàn team' : m.toName}${m.taskId ? ` (task ${m.taskId})` : ''}: ${m.body.slice(0, 300)}${m.read ? ` (đã đọc ${m.readAt ? new Date(m.readAt).toISOString() : ''})` : ' (chưa đọc)'}`,
          );
        }
        const messageId = getOptionalStringArg(args, 'messageId');
        if (messageId) {
          const marked = loaded.markDiskRead(name, messageId);
          if (!marked.ok) return errorResult(marked.error);
          lines.push(`Đã đánh dấu tin ${messageId} là đã đọc.`);
        } else if (getBooleanArg(args, 'markRead', false)) {
          const count = loaded.markDiskInboxRead(name);
          lines.push(`Đã đánh dấu ${count} tin là đã đọc.`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const mailboxOutboxTool: Tool = {
    definition: toolDef(
      'mailbox_v2_outbox',
      'Read a teammate outbox from the disk mailbox by NAME (Agent Teams v2). Read-only.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        teammateName: { type: 'string', description: 'Teammate name whose outbox to read.' },
      },
      ['teamId', 'teammateName'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const name = getStringArg(args, 'teammateName');
        if (!loaded.findTeammateByName(name)) {
          return errorResult(`Không có teammate tên "${name}" trong team.`);
        }
        const outbox = loaded.diskOutbox(name);
        const lines = [`Hộp thư đi của "${name}" (${outbox.length} tin):`];
        for (const m of outbox.slice(-20)) {
          lines.push(
            `  [${m.kind}] → ${m.toName === '*' ? 'toàn team' : m.toName}${m.taskId ? ` (task ${m.taskId})` : ''}: ${m.body.slice(0, 300)}`,
          );
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const forkSpawnTool: Tool = {
    definition: toolDef(
      'fork_v2_spawn',
      'Spawn a fork subagent with its own context (Agent Teams v2): a child agent working on part of a parent task. Limited to 3 fork levels deep and 5 concurrent forks by default.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        parentTaskId: { type: 'string', description: 'Parent task id the fork serves.' },
        parentForkId: { type: 'string', description: 'Parent fork id when forking a fork (nested).' },
        name: { type: 'string', description: 'Short fork name/purpose.' },
        task: { type: 'string', description: 'What the fork must do (its own context).' },
        spawnedById: { type: 'string', description: 'Teammate id spawning the fork.' },
      },
      ['teamId', 'parentTaskId', 'name', 'task', 'spawnedById'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const fork = loaded.spawnFork({
          parentTaskId: getStringArg(args, 'parentTaskId'),
          parentForkId: getOptionalStringArg(args, 'parentForkId'),
          name: getStringArg(args, 'name'),
          task: getStringArg(args, 'task'),
          spawnedById: getStringArg(args, 'spawnedById'),
        });
        if (!fork.ok) return errorResult(fork.error);
        loaded.save();
        return `Đã spawn fork "${fork.value.name}" (${fork.value.id}, tầng ${fork.value.depth}) cho task ${fork.value.parentTaskId}.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const forkCompleteTool: Tool = {
    definition: toolDef(
      'fork_v2_complete',
      'Mark a fork subagent done with a result summary and artifacts (Agent Teams v2). Use fork_v2_merge afterwards (or complete the parent task) to merge the result back.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        forkId: { type: 'string', description: 'Fork id.' },
        resultSummary: { type: 'string', description: 'Result summary of the fork.' },
        artifacts: { type: 'array', items: { type: 'string' }, description: 'Artifacts the fork produced (relative paths).' },
        tokensUsed: { type: 'number', description: 'Tokens the fork used (when reported).' },
      },
      ['teamId', 'forkId', 'resultSummary'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const tokens = getNumberArg(args, 'tokensUsed', 0);
        const done = loaded.completeFork(
          getStringArg(args, 'forkId'),
          getStringArg(args, 'resultSummary'),
          getStringArrayArg(args, 'artifacts'),
          tokens > 0 ? tokens : undefined,
        );
        if (!done.ok) return errorResult(done.error);
        loaded.save();
        return `Fork "${done.value.name}" xong: ${done.value.resultSummary}${done.value.artifacts.length > 0 ? ` Artifact: ${done.value.artifacts.join(', ')}` : ''} — merge bằng fork_v2_merge.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const forkMergeTool: Tool = {
    definition: toolDef(
      'fork_v2_merge',
      'Merge a finished fork result back into its parent task (Agent Teams v2): summary + artifacts. A fork merges only once.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        forkId: { type: 'string', description: 'Fork id to merge.' },
      },
      ['teamId', 'forkId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const merged = loaded.mergeFork(getStringArg(args, 'forkId'));
        if (!merged.ok) return errorResult(merged.error);
        loaded.save();
        return `Đã merge fork "${merged.value.fork.name}" về task ${merged.value.fork.parentTaskId}: ${merged.value.mergedSummary}`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const forkStatusTool: Tool = {
    definition: toolDef(
      'fork_v2_status',
      'Fork tree status of an Agent Team v2 (all forks with depth, status, merged or not, artifacts). Read-only.',
      {
        teamId: { type: 'string', description: 'Team id.' },
      },
      ['teamId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV2OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const forks = loaded.forks();
        if (forks.length === 0) return `Team "${loaded.snapshot.name}" chưa có fork nào.`;
        const lines = [`Fork của team "${loaded.snapshot.name}" (${forks.length}):`];
        for (const fork of forks) {
          lines.push(
            `  - ${fork.name} (${fork.id}, tầng ${fork.depth}, task cha ${fork.parentTaskId}` +
              (fork.parentForkId ? `, fork cha ${fork.parentForkId}` : '') +
              `): ${fork.status}${fork.merged ? ' (đã merge)' : ''}` +
              (fork.resultSummary ? ` — ${fork.resultSummary.slice(0, 200)}` : '') +
              (fork.artifacts.length > 0 ? ` — artifact: ${fork.artifacts.join(', ')}` : '') +
              (fork.tokensUsed !== undefined ? ` — ${fork.tokensUsed} token` : ''),
          );
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    claimTool,
    heartbeatTool,
    releaseTool,
    requeueStaleTool,
    spawnTool,
    assignTool,
    aggregateTool,
    costTool,
    completeTool,
    configTool,
    dashboardTool,
    mailboxSendTool,
    mailboxInboxTool,
    mailboxOutboxTool,
    forkSpawnTool,
    forkCompleteTool,
    forkMergeTool,
    forkStatusTool,
  ];
}

/** Unbound placeholders for ALL_TOOLS (bound by createDefaultTools when wired). */
export const TEAM_V2_TOOLS: Tool[] = createAgentTeamsV2Tools();
