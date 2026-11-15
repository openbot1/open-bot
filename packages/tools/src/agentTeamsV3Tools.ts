/**
 * Agent Teams v3 tools (v1.11, Đội T3) — registered in ALL_TOOLS
 * (see tools.ts, same replace-in-place pattern as v1/v2).
 *
 * Đúng 7 primitives dưới dạng tool:
 * - `teams_v3_create` — TeamCreate (kèm ước tính chi phí tuyến
 *   tính trước khi tạo + chặn team thứ 2 trong cùng session).
 * - `teams_v3_spawn` — Task: lead spawn teammate cho task.
 * - `teams_v3_send` — SendMessage trực tiếp teammate-to-teammate
 *   (không qua lead); toId='*' = lead broadcast toàn team.
 * - `teams_v3_claim` — file-locked claim: wave gate + file guard
 *   + disk lock v2 (lease + heartbeat). Lock lỗi → rollback.
 * - `teams_v3_start` — lifecycle open → in-progress.
 * - `teams_v3_close` — lifecycle in-progress → closed
 *   (outcome done/failed; hook TaskCompleted exit 2 = giữ mở).
 * - `teams_v3_waves` — dependency waves: plan + trạng thái +
 *   wave hiện tại (read-only).
 * - `teams_v3_challenge` — teammate thách thức kết luận của nhau.
 * - `teams_v3_challenge_answer` — người bị thách thức trả lời.
 * - `teams_v3_challenge_resolve` — lead resolve challenge.
 * - `teams_v3_lead_mode` — xem/chuyển lead mode
 *   (delegate ↔ implement, chuyển được giữa chừng).
 * - `teams_v3_panes` — teammate pane view kiểu tmux (read-only).
 * - `teams_v3_pane_log` — thêm/đọc log trong pane của teammate.
 * - `teams_v3_cost` — ước tính chi phí token tuyến tính
 *   (pre-create khi chưa có team, hoặc live khi có teamId).
 * - `teams_v3_dashboard` — snapshot dashboard v3 (read-only).
 *
 * Như tool v1/v2: placeholder trong ALL_TOOLS cho tới khi host
 * bind: `createAgentTeamsV3Tools(getBaseDir)` với userData dir của
 * app (dùng chung thư mục với v1/v2 — v3 lưu thêm
 * `teams-v3/<teamId>/v3.json` + `teams-v3/sessions.json`).
 * Tool ghi file cần approval; tool chỉ đọc / tính toán thì không.
 */

import type { Tool } from '@open-bot/core';
import {
  TEAM_V3_PRIMITIVES,
  TEAM_V3_PRIMITIVE_DESCRIPTIONS,
  TeamServiceV3,
  estimateCostBeforeCreateV3,
  linearCostWarning,
  renderPaneGrid,
  type TeamV3CostEstimate,
} from '@open-bot/core';

export const TEAM_V3_TOOL_NAMES = [
  'teams_v3_create',
  'teams_v3_spawn',
  'teams_v3_send',
  'teams_v3_claim',
  'teams_v3_start',
  'teams_v3_close',
  'teams_v3_waves',
  'teams_v3_challenge',
  'teams_v3_challenge_answer',
  'teams_v3_challenge_resolve',
  'teams_v3_lead_mode',
  'teams_v3_panes',
  'teams_v3_pane_log',
  'teams_v3_cost',
  'teams_v3_dashboard',
] as const;

const NOT_WIRED = 'Agent Teams v3 chưa được cấu hình (thiếu thư mục dữ liệu của app).';

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

function formatCostEstimate(cost: TeamV3CostEstimate): string {
  const lines = [
    `Ước tính ${cost.estimatedTokens.toLocaleString('en-US')} token ` +
      `(cơ sở ${cost.baseTokens.toLocaleString('en-US')} + ${cost.teammates} teammate x ${cost.byTeammate} + ` +
      `${cost.tasks} task x ${cost.byTask} + ${cost.messages} tin x ${cost.byMessage} + ${cost.forks} fork x ${cost.byFork}), ` +
      `ngân sách ${cost.budget.toLocaleString('en-US')} token (${Math.round(cost.usageRatio * 100)}%), mức ${cost.level}.`,
    `Hệ số x${cost.multiplier} so với 1 session đơn — chi phí tăng tuyến tính theo số teammate.`,
  ];
  for (const w of cost.warnings) lines.push(`Cảnh báo: ${w}`);
  return lines.join('\n');
}

export function createAgentTeamsV3Tools(
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

  const teamV3OrError = (teamId: string): TeamServiceV3 | string => {
    const base = resolveBase();
    if (!base) return errorResult(NOT_WIRED);
    const loaded = TeamServiceV3.load(base, teamId);
    if (!loaded.service) return errorResult(loaded.loadError ?? `Không tìm thấy team ${teamId}.`);
    return loaded.service;
  };

  const createTool: Tool = {
    definition: toolDef(
      'teams_v3_create',
      'Create an Agent Team v3 (TeamCreate primitive): one team per session, lead mode delegate or implement, linear token-cost estimate shown before creating. Fails when the session already has a team or the caller is a teammate of another team (no sub-teams).',
      {
        name: { type: 'string', description: 'Team name (unique).' },
        goal: { type: 'string', description: 'Shared goal of the team.' },
        sessionId: { type: 'string', description: 'Session owning the team (1 team per session).' },
        leadName: { type: 'string', description: 'Lead display name (default "lead").' },
        leadMode: { type: 'string', enum: ['delegate', 'implement'], description: 'Lead mode: delegate (assign only) or implement (lead also works tasks). Default delegate.' },
        teammateCount: { type: 'number', description: 'Planned teammate count, used for the pre-create cost estimate (default 3).' },
        taskCount: { type: 'number', description: 'Planned task count, used for the pre-create cost estimate (default 0).' },
      },
      ['name', 'goal', 'sessionId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const base = resolveBase();
        if (!base) return errorResult(NOT_WIRED);
        const teammateCount = getNumberArg(args, 'teammateCount', 3);
        const taskCount = getNumberArg(args, 'taskCount', 0);
        const preCost = estimateCostBeforeCreateV3(teammateCount, taskCount);
        const leadMode = getOptionalStringArg(args, 'leadMode');
        if (leadMode !== undefined && leadMode !== 'delegate' && leadMode !== 'implement') {
          return errorResult('leadMode phải là "delegate" hoặc "implement".');
        }
        const created = TeamServiceV3.create(base, {
          name: getStringArg(args, 'name'),
          goal: getStringArg(args, 'goal'),
          sessionId: getStringArg(args, 'sessionId'),
          leadName: getOptionalStringArg(args, 'leadName'),
          v3config: leadMode ? { leadMode: leadMode as 'delegate' | 'implement' } : undefined,
        });
        if (!created.ok) return errorResult(created.error);
        const team = created.value.snapshot;
        return (
          `Đã tạo team v3 "${team.name}" (${team.id}), lead ${created.value.lead.name}, mode ${created.value.leadMode}, session ${getStringArg(args, 'sessionId')}.\n` +
          `Ước tính trước khi tạo (${teammateCount} teammate, ${taskCount} task):\n${formatCostEstimate(preCost)}\n` +
          `7 primitives khả dụng: ${TEAM_V3_PRIMITIVES.map((p) => `${p} — ${TEAM_V3_PRIMITIVE_DESCRIPTIONS[p]}`).join(' | ')}`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const spawnTool: Tool = {
    definition: toolDef(
      'teams_v3_spawn',
      'Spawn a teammate for a task (Task primitive, Agent Teams v3): lead spawns a teammate with its own session file and tmux pane. Warns when the team is below 3 or above 5 teammates, or when the partition overlaps another teammate.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        name: { type: 'string', description: 'Teammate display name (unique in the team).' },
        model: { type: 'string', description: 'Model for this teammate (empty = team default).' },
        specialty: { type: 'string', description: 'Specialty role (researcher/coder/reviewer/...).' },
        partition: { type: 'string', description: 'File area this teammate owns (path prefix, e.g. "src/memory/").' },
      },
      ['teamId', 'name'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const spawned = loaded.spawnTeammate({
          name: getStringArg(args, 'name'),
          model: getOptionalStringArg(args, 'model'),
          specialty: getOptionalStringArg(args, 'specialty'),
          partition: getOptionalStringArg(args, 'partition'),
        });
        if (!spawned.ok) return errorResult(spawned.error);
        loaded.save();
        const warnings = spawned.value.warnings.length > 0 ? `\nCảnh báo: ${spawned.value.warnings.join(' ')}` : '';
        return `Đã spawn teammate "${spawned.value.mate.name}" (${spawned.value.mate.id}) vào team "${loaded.snapshot.name}" (pane + session riêng đã tạo).${warnings}`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sendTool: Tool = {
    definition: toolDef(
      'teams_v3_send',
      'Send a message directly teammate-to-teammate (SendMessage primitive, Agent Teams v3): no lead relay. toId "*" is a lead-only broadcast to the whole team.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        fromId: { type: 'string', description: 'Sender teammate id.' },
        toId: { type: 'string', description: 'Recipient teammate id, or "*" for a lead broadcast.' },
        kind: { type: 'string', enum: ['request', 'result', 'question'], description: 'Message kind.' },
        taskId: { type: 'string', description: 'Related task id (optional).' },
        body: { type: 'string', description: 'Message body.' },
      },
      ['teamId', 'fromId', 'toId', 'kind', 'body'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const toId = getStringArg(args, 'toId');
        const kind = getStringArg(args, 'kind');
        if (kind !== 'request' && kind !== 'result' && kind !== 'question') {
          return errorResult('kind phải là "request", "result" hoặc "question".');
        }
        if (toId === '*') {
          const fromId = getStringArg(args, 'fromId');
          if (fromId !== loaded.snapshot.leadId) {
            return errorResult('Broadcast (*) chỉ lead được gửi.');
          }
          const sent = loaded.broadcast(getStringArg(args, 'body'), getOptionalStringArg(args, 'taskId'));
          if (!sent.ok) return errorResult(sent.error);
          loaded.save();
          return `Lead đã broadcast tới toàn team "${loaded.snapshot.name}".`;
        }
        const sent = loaded.sendMessageDirect({
          fromId: getStringArg(args, 'fromId'),
          toId,
          kind,
          taskId: getOptionalStringArg(args, 'taskId'),
          body: getStringArg(args, 'body'),
        });
        if (!sent.ok) return errorResult(sent.error);
        loaded.save();
        const from = loaded.findTeammate(getStringArg(args, 'fromId'));
        const to = loaded.findTeammate(toId);
        return `Đã gửi tin ${kind} trực tiếp ${from?.name ?? '?'} → ${to?.name ?? toId} (không qua lead), đã ghi vào log hội thoại team.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const claimTool: Tool = {
    definition: toolDef(
      'teams_v3_claim',
      'Claim a task with file locking (Agent Teams v3): wave gate (later waves stay locked until earlier waves close) + file guard (two teammates cannot edit the same file; lead may override with allowOverride + overrideById=lead id, which hands the file over and is logged) + v2 disk lock with lease. In implement mode the lead claims through the lead worker seat; in delegate mode the lead cannot claim.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskId: { type: 'string', description: 'Task id to claim.' },
        teammateId: { type: 'string', description: 'Teammate id claiming the task (the lead id works in implement mode via the lead worker seat).' },
        allowOverride: { type: 'boolean', description: 'Lead-only override of the file guard (default false).' },
        overrideById: { type: 'string', description: 'Lead teammate id authorizing the override (required when allowOverride is true and the claimer is not the lead).' },
      },
      ['teamId', 'taskId', 'teammateId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const claimed = loaded.claimTask(getStringArg(args, 'taskId'), getStringArg(args, 'teammateId'), {
          allowOverride: getBooleanArg(args, 'allowOverride', false),
          overrideById: getOptionalStringArg(args, 'overrideById'),
        });
        if (!claimed.ok) return errorResult(claimed.error);
        loaded.save();
        const warnings = claimed.value.warnings.length > 0 ? `\nCảnh báo: ${claimed.value.warnings.join(' ')}` : '';
        return (
          `Teammate đã claim task "${claimed.value.task.title}" (${claimed.value.task.id}) — wave ${claimed.value.waveIndex + 1}, ` +
          `disk lock, lease tới ${new Date(claimed.value.leaseUntil).toISOString()} — nhớ heartbeat trước khi hết lease.${warnings}`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const startTool: Tool = {
    definition: toolDef(
      'teams_v3_start',
      'Start a claimed task: lifecycle open → in-progress (Agent Teams v3). The lead cannot start tasks in delegate mode.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskId: { type: 'string', description: 'Task id to start.' },
        teammateId: { type: 'string', description: 'Teammate id working the task.' },
      },
      ['teamId', 'taskId', 'teammateId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const started = loaded.startTask(getStringArg(args, 'taskId'), getStringArg(args, 'teammateId'));
        if (!started.ok) return errorResult(started.error);
        loaded.save();
        return `Task "${started.value.title}" đã bắt đầu (open → in-progress).`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const closeTool: Tool = {
    definition: toolDef(
      'teams_v3_close',
      'Close an in-progress task: lifecycle in-progress → closed (Agent Teams v3). outcome done runs the v2 TaskCompleted hook (exit 2 keeps the task open with reviewer feedback); outcome failed marks the task failed. Closing the last task of a wave opens the next wave.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskId: { type: 'string', description: 'Task id to close.' },
        teammateId: { type: 'string', description: 'Teammate id closing the task.' },
        outcome: { type: 'string', enum: ['done', 'failed'], description: 'Close outcome.' },
        summary: { type: 'string', description: 'Short result summary (when done).' },
        error: { type: 'string', description: 'Short error (when failed).' },
      },
      ['teamId', 'taskId', 'teammateId', 'outcome'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const outcome = getStringArg(args, 'outcome');
        if (outcome !== 'done' && outcome !== 'failed') {
          return errorResult('outcome phải là "done" hoặc "failed".');
        }
        const closed = await loaded.closeTask(getStringArg(args, 'taskId'), getStringArg(args, 'teammateId'), outcome, {
          summary: getOptionalStringArg(args, 'summary'),
          error: getOptionalStringArg(args, 'error'),
        });
        if (!closed.ok) return errorResult(closed.error);
        loaded.save();
        const waveNote =
          closed.value.waveCompleted !== undefined
            ? ` Wave ${closed.value.waveCompleted + 1} đã xong — wave ${closed.value.waveCompleted + 2} được mở claim.`
            : '';
        const hookNote = closed.value.heldOpen
          ? ` Hook TaskCompleted giữ task mở: ${closed.value.feedback ?? ''}`
          : '';
        return `Task "${closed.value.task.title}" đã đóng (in-progress → closed, ${outcome}).${waveNote}${hookNote}`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const wavesTool: Tool = {
    definition: toolDef(
      'teams_v3_waves',
      'Show the dependency waves of a team (Agent Teams v3, read-only): topo levels, status of each wave, which wave is claimable, and the current wave.',
      {
        teamId: { type: 'string', description: 'Team id.' },
      },
      ['teamId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const wavesRes = loaded.waves();
        if (!wavesRes.ok) return errorResult(wavesRes.error);
        const team = loaded.snapshot;
        const titleOf = (id: string): string => team.tasks.find((t) => t.id === id)?.title ?? id;
        const lines: string[] = [loaded.wavesSummary()];
        for (const w of wavesRes.value) {
          lines.push(
            `Wave ${w.index + 1}: ${w.status}, ${w.closedCount}/${w.taskIds.length} closed, ` +
              (w.claimable ? 'được claim' : `chưa claim được — ${w.blockedBy ?? ''}`) +
              ` — ${w.taskIds.map(titleOf).join('; ')}`,
          );
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const challengeTool: Tool = {
    definition: toolDef(
      'teams_v3_challenge',
      'Challenge a teammate conclusion (Agent Teams v3): a teammate questions the result summary of a done task. Recorded in the team conversation log and sent as a question to the target teammate inbox.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        taskId: { type: 'string', description: 'Done task whose conclusion is challenged.' },
        challengerId: { type: 'string', description: 'Teammate id opening the challenge.' },
        body: { type: 'string', description: 'Challenge / feedback body.' },
      },
      ['teamId', 'taskId', 'challengerId', 'body'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const opened = loaded.openChallenge({
          taskId: getStringArg(args, 'taskId'),
          challengerId: getStringArg(args, 'challengerId'),
          body: getStringArg(args, 'body'),
        });
        if (!opened.ok) return errorResult(opened.error);
        loaded.save();
        return `Đã mở challenge ${opened.value.id}: ${opened.value.challengerName} thách thức kết luận của ${opened.value.targetName} ở task "${opened.value.taskTitle}" — đã ghi log hội thoại + gửi question vào inbox.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const challengeAnswerTool: Tool = {
    definition: toolDef(
      'teams_v3_challenge_answer',
      'Answer a challenge (Agent Teams v3): only the challenged teammate may answer. The answer is recorded in the team conversation log.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        challengeId: { type: 'string', description: 'Challenge id.' },
        answerById: { type: 'string', description: 'Teammate id answering (must be the challenge target).' },
        answer: { type: 'string', description: 'Answer body.' },
      },
      ['teamId', 'challengeId', 'answerById', 'answer'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const answered = loaded.answerChallenge(
          getStringArg(args, 'challengeId'),
          getStringArg(args, 'answerById'),
          getStringArg(args, 'answer'),
        );
        if (!answered.ok) return errorResult(answered.error);
        loaded.save();
        return `Đã trả lời challenge ${answered.value.id} (trạng thái: answered) — lead sẽ resolve.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const challengeResolveTool: Tool = {
    definition: toolDef(
      'teams_v3_challenge_resolve',
      'Resolve a challenge (Agent Teams v3): only the lead may resolve, with a short verdict. Recorded in the team conversation log.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        challengeId: { type: 'string', description: 'Challenge id.' },
        resolution: { type: 'string', description: 'Lead verdict.' },
      },
      ['teamId', 'challengeId', 'resolution'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const resolved = loaded.resolveChallenge(getStringArg(args, 'challengeId'), getStringArg(args, 'resolution'));
        if (!resolved.ok) return errorResult(resolved.error);
        loaded.save();
        return `Lead đã resolve challenge ${resolved.value.id} (trạng thái: resolved).`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const leadModeTool: Tool = {
    definition: toolDef(
      'teams_v3_lead_mode',
      'Get or switch the lead mode (Agent Teams v3): delegate (lead assigns only) or implement (lead also works tasks through a lead worker seat, since v1 forbids the lead claiming directly). Switching mid-run is allowed and logged; switching back to delegate while the lead worker seat holds open tasks warns.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        mode: { type: 'string', enum: ['delegate', 'implement'], description: 'New mode (omit to just read the current mode).' },
      },
      ['teamId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const mode = getOptionalStringArg(args, 'mode');
        if (mode === undefined) {
          const board = loaded.leadBoard();
          const seatId = loaded.v3snapshot.leadWorkerId;
          const lines = [
            `Lead mode hiện tại: ${loaded.leadMode} (${loaded.leadMode === 'delegate' ? 'chỉ giao việc' : 'lead cũng trực tiếp làm qua worker seat'})` +
              (seatId ? ` — worker seat: ${seatId}.` : ' — chưa có worker seat (tạo khi chuyển sang implement mode).'),
            `Lead status board: ${board.map((b) => `${b.name} (${b.status}${b.currentTaskTitle ? `: ${b.currentTaskTitle}` : ''})`).join('; ') || 'chưa có teammate'}.`,
          ];
          return lines.join('\n');
        }
        if (mode !== 'delegate' && mode !== 'implement') {
          return errorResult('mode phải là "delegate" hoặc "implement".');
        }
        const switched = loaded.setLeadMode(mode);
        if (!switched.ok) return errorResult(switched.error);
        loaded.save();
        const warnings = switched.value.warnings.length > 0 ? `\nCảnh báo: ${switched.value.warnings.join(' ')}` : '';
        return `Lead đã chuyển sang ${switched.value.mode} mode.${warnings}`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const panesTool: Tool = {
    definition: toolDef(
      'teams_v3_panes',
      'Show the tmux-style teammate panes of a team (Agent Teams v3, read-only): one pane per teammate with status, current task and latest log line, plus the pane grid size.',
      {
        teamId: { type: 'string', description: 'Team id.' },
      },
      ['teamId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        return renderPaneGrid(loaded.panes());
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const paneLogTool: Tool = {
    definition: toolDef(
      'teams_v3_pane_log',
      'Append a log line to a teammate pane, or read the latest pane log lines (Agent Teams v3). Give "line" to append; omit it to read.',
      {
        teamId: { type: 'string', description: 'Team id.' },
        teammateId: { type: 'string', description: 'Teammate id owning the pane.' },
        line: { type: 'string', description: 'Log line to append (omit to read the pane log).' },
        limit: { type: 'number', description: 'Max lines to read (default 20).' },
      },
      ['teamId', 'teammateId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        const teammateId = getStringArg(args, 'teammateId');
        const line = getOptionalStringArg(args, 'line');
        if (line !== undefined) {
          const appended = loaded.appendPaneLog(teammateId, line);
          if (!appended.ok) return errorResult(appended.error);
          loaded.save();
          return `Đã thêm dòng log vào pane của ${appended.value.name}.`;
        }
        const limit = getNumberArg(args, 'limit', 20);
        const pane = loaded.panes().find((p) => p.teammateId === teammateId);
        if (!pane) return errorResult(`Không tìm thấy pane của teammate ${teammateId}.`);
        const lines = pane.logLines.slice(-Math.max(1, limit));
        if (lines.length === 0) return `Pane của ${pane.name} chưa có log nào.`;
        return (
          `Pane ${pane.name} [${pane.row},${pane.col}] (${pane.status}):\n` +
          lines.map((l) => `${new Date(l.at).toISOString()} ${l.line}`).join('\n')
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const costTool: Tool = {
    definition: toolDef(
      'teams_v3_cost',
      'Estimate the linear token cost of an Agent Team v3 (read-only): base session tokens + per-teammate tokens, multiplier vs a single session, and warnings. Give teamId for a live estimate, or teammateCount/taskCount for a pre-create estimate.',
      {
        teamId: { type: 'string', description: 'Team id (live estimate).' },
        teammateCount: { type: 'number', description: 'Planned teammate count (pre-create estimate).' },
        taskCount: { type: 'number', description: 'Planned task count (pre-create estimate).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getOptionalStringArg(args, 'teamId');
        if (teamId) {
          const loaded = teamV3OrError(teamId);
          if (typeof loaded === 'string') return loaded;
          return formatCostEstimate(loaded.costEstimate());
        }
        const teammateCount = getNumberArg(args, 'teammateCount', 3);
        const taskCount = getNumberArg(args, 'taskCount', 0);
        const cost = estimateCostBeforeCreateV3(teammateCount, taskCount);
        return `${linearCostWarning(teammateCount)}\n${formatCostEstimate(cost)}`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const dashboardTool: Tool = {
    definition: toolDef(
      'teams_v3_dashboard',
      'Snapshot the Agent Teams v3 dashboard of a team (read-only): lead mode + status board, waves, tmux panes, challenges, conversation log, linear token cost, background sessions (agent view) and file holds.',
      {
        teamId: { type: 'string', description: 'Team id.' },
      },
      ['teamId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamId = getStringArg(args, 'teamId');
        const loaded = teamV3OrError(teamId);
        if (typeof loaded === 'string') return loaded;
        return loaded.dashboardMarkdown();
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    createTool,
    spawnTool,
    sendTool,
    claimTool,
    startTool,
    closeTool,
    wavesTool,
    challengeTool,
    challengeAnswerTool,
    challengeResolveTool,
    leadModeTool,
    panesTool,
    paneLogTool,
    costTool,
    dashboardTool,
  ];
}

export const TEAM_V3_TOOLS: Tool[] = createAgentTeamsV3Tools();
