/**
 * Agent Teams v3 — service (v1.11, Đội T3).
 *
 * TeamServiceV3 bọc TeamServiceV2 (kế thừa toàn bộ v2: claim lock
 * disk, mailbox disk, session, fork, hook TaskCompleted, chi phí)
 * và thêm lớp v3: 7 primitives (TeamCreate/Task/SendMessage/
 * lifecycle 3 trạng thái/file-lock/dependency waves/lead control),
 * challenge giữa teammate, panes tmux, session registry
 * (1 team/session, cấm team con), file guard, chi phí tuyến tính.
 *
 * Team v1/v2 cũ load được trong v3 (state v3 mặc định khi chưa có
 * file v3.json). Mọi thao tác ghi đều save() cả v1+v2+v3.
 */

import type { AgentTeamV109, MailboxMessage, TeamTask, Teammate } from '../types';
import { TeamServiceV2, type CreateTeamV2Input, type TeamServiceV2Result } from '../v2/serviceV2';
import { checkTeamSize, estimateTeamTokens } from '../v2/cost';
import { defaultTeamV2Config } from '../v2/types';
import type { TeamV2Config } from '../v2/types';
import {
  MAX_TEAM_CONVERSATION_ENTRIES,
  TEAM_V3_PRIMITIVES,
  defaultTeamV3State,
  v3OutcomeOf,
  v3StateOf,
  validateTeamV3Config,
  type LeadMode,
  type TeamBackgroundSession,
  type TeamConversationEntry,
  type TeamConversationKind,
  type TeamV3Config,
  type TeamV3Result,
  type TeamV3State,
  type TeamWave,
  type TeammatePane,
  type V3TaskOutcome,
  type V3TaskState,
} from './types';
import { computeWaves, currentWave, canClaimByWave, allWavesDone, summarizeWaves } from './waves';
import { checkFileGuard, checkPartitionGuard, canOverrideFileGuard, summarizeFileHolds } from './fileGuard';
import { checkLeadClaim, validateLeadModeSwitch, leadModeSwitchNote, leadOpenTasks, buildLeadBoard, checkLeadWorkerClaim, leadWorkerName } from './leadControl';
import {
  openChallenge,
  answerChallenge,
  resolveChallenge,
  openChallengeCounts,
  summarizeChallenges,
  type OpenChallengeInput,
} from './challenges';
import { syncPanes, appendPaneLog, focusPane, paneGridSize, summarizeBackgroundSession } from './panes';
import {
  assertCanCreateTeam,
  listTeamSessions,
  registerTeamSession,
  unregisterTeamSession,
} from './sessionRegistry';
import { estimateTeamV3Cost, estimateCostBeforeCreate, type TeamV3CostInputs } from './cost';
import { TeamV3Store } from './stateStore';
import { teamV3DashboardMarkdown, type TeamV3Dashboard } from './dashboard';

/** Input tạo team v3 (v2 + session + cấu hình v3). */
export interface CreateTeamV3Input extends CreateTeamV2Input {
  /** Session sở hữu team (bắt buộc — 1 team/session). */
  sessionId: string;
  /** Id team mà actor đang là teammate (nếu có → cấm tạo team con). */
  actorIsTeammateOfTeamId?: string;
  /** Cấu hình v3 (lead mode, challenge, pane...). */
  v3config?: Partial<TeamV3Config>;
}

/** Kết quả đóng task v3 (kèm quyết định hook v2). */
export interface CloseTaskV3Result {
  task: TeamTask;
  outcome: V3TaskOutcome;
  /** Hook TaskCompleted đã chạy chưa (chỉ khi outcome=done và có hook). */
  hookRan: boolean;
  /** true = hook giữ task mở, task đã về open kèm feedback. */
  heldOpen: boolean;
  feedback?: string;
  /** Wave vừa xong nhờ task này đóng (undefined khi chưa xong wave nào). */
  waveCompleted?: number;
}

export class TeamServiceV3 {
  private v2: TeamServiceV2;
  private v3: TeamV3State;
  private readonly baseDir: string;

  constructor(v2service: TeamServiceV2, v3state: TeamV3State, baseDir: string) {
    this.v2 = v2service;
    this.v3 = v3state;
    this.baseDir = baseDir;
  }

  /** Team v1 hiện tại (snapshot). */
  get snapshot(): AgentTeamV109 {
    return this.v2.snapshot;
  }

  /** Trạng thái v3 hiện tại (bản sao). */
  get v3snapshot(): TeamV3State {
    return {
      ...this.v3,
      config: { ...this.v3.config, v2: { ...this.v3.config.v2 } },
      leadModeHistory: [...this.v3.leadModeHistory],
      challenges: [...this.v3.challenges],
      conversation: [...this.v3.conversation],
      panes: [...this.v3.panes],
    };
  }

  /** Cấu hình v3 hiện tại. */
  get config(): TeamV3Config {
    return { ...this.v3.config, v2: { ...this.v3.config.v2 } };
  }

  /** Mode hiện tại của lead. */
  get leadMode(): LeadMode {
    return this.v3.leadMode;
  }

  /** Thư mục dữ liệu gốc (userData) mà service v3 dùng. */
  get dataDir(): string {
    return this.baseDir;
  }

  /** Lead của team. */
  get lead(): Teammate {
    return this.v2.lead;
  }

  findTeammate(id: string): Teammate | undefined {
    return this.v2.findTeammate(id);
  }

  findTeammateByName(name: string): Teammate | undefined {
    return this.v2.findTeammateByName(name);
  }

  findTask(id: string): TeamTask | undefined {
    return this.v2.findTask(id);
  }

  // ------------------------------------------------------------------
  // Tạo / load / save
  // ------------------------------------------------------------------

  /**
   * Tạo team mới (primitive team-create): kiểm tra 1 team/session +
   * cấm team con → v2 create → state v3 (lead mode, pane lead, log
   * team-created) → đăng ký session.
   */
  static create(
    baseDir: string,
    input: CreateTeamV3Input,
    now = Date.now(),
  ): TeamV3Result<TeamServiceV3> {
    const gate = assertCanCreateTeam(baseDir, input.sessionId, {
      isTeammateOfTeamId: input.actorIsTeammateOfTeamId,
    });
    if (!gate.ok) return { ok: false, error: gate.error };
    const v2input: CreateTeamV2Input = {
      name: input.name,
      goal: input.goal,
      leadName: input.leadName,
      defaultModel: input.defaultModel,
      config: input.config,
      v2config: input.v2config,
    };
    const created = TeamServiceV2.create(baseDir, v2input, now);
    if (!created.ok) return { ok: false, error: created.error };
    const v2svc = created.value;
    const team = v2svc.snapshot;
    const v3state = defaultTeamV3State(team.id, input.v3config);
    v3state.sessionId = input.sessionId;
    v3state.panes = syncPanes([], team, v3state.config.paneColumns, now);
    v3state.conversation = [
      {
        at: now,
        kind: 'team-created',
        fromName: v2svc.lead.name,
        fromId: v2svc.lead.id,
        body: `Team "${team.name}" được tạo (mục tiêu: ${team.goal}). Lead mode: ${v3state.leadMode}. Session: ${input.sessionId}.`,
      },
    ];
    v3state.updatedAt = now;
    const svc = new TeamServiceV3(v2svc, v3state, baseDir);
    const registered = registerTeamSession(baseDir, {
      sessionId: input.sessionId,
      teamId: team.id,
      teamName: team.name,
      createdAt: now,
    });
    if (!registered.ok) return { ok: false, error: registered.error };
    svc.save();
    return { ok: true, value: svc };
  }

  /** Load team v2 + state v3 từ disk (team cũ chưa có v3 → state mặc định). */
  static load(
    baseDir: string,
    teamId: string,
  ): { service: TeamServiceV3 | null; loadError?: string } {
    const loaded = TeamServiceV2.load(baseDir, teamId);
    if (!loaded.service) return { service: null, loadError: loaded.loadError };
    const { state, loadError } = new TeamV3Store(baseDir, teamId).load();
    return { service: new TeamServiceV3(loaded.service, state, baseDir), loadError };
  }

  /** Lưu team v1 + state v2 + state v3 xuống disk (panes đồng bộ trước khi lưu). */
  save(): void {
    this.v3 = { ...this.v3, panes: syncPanes(this.v3.panes, this.v2.snapshot, this.v3.config.paneColumns) };
    this.v2.save();
    new TeamV3Store(this.baseDir, this.snapshot.id).save(this.v3);
  }

  /** Cập nhật cấu hình v3 (validate trước). */
  updateV3Config(patch: Partial<TeamV3Config>, now = Date.now()): TeamV3Result<TeamV3Config> {
    const next = { ...this.v3.config, ...patch, v2: { ...this.v3.config.v2, ...(patch.v2 ?? {}) } };
    const errors = validateTeamV3Config(next);
    if (errors.length > 0) return { ok: false, error: errors.join(' ') };
    this.v3 = { ...this.v3, config: next, updatedAt: now };
    return { ok: true, value: { ...next } };
  }

  // ------------------------------------------------------------------
  // Waves (primitive dependency-wave)
  // ------------------------------------------------------------------

  /** Tính waves hiện tại từ task list (lỗi khi dependency treo/chu trình). */
  waves(): TeamV3Result<TeamWave[]> {
    return computeWaves(this.v2.snapshot.tasks);
  }

  /** Tóm tắt waves một dòng. */
  wavesSummary(): string {
    const res = this.waves();
    if (!res.ok) return `Waves lỗi: ${res.error}`;
    return summarizeWaves(res.value, this.v2.snapshot.tasks);
  }

  // ------------------------------------------------------------------
  // Spawn teammate (primitive task-spawn) + add task
  // ------------------------------------------------------------------

  /**
   * Lead spawn teammate cho task (primitive task-spawn): kiểm tra
   * partition chồng (v1 chặn hẳn) + v2 spawn (cỡ team 3–5, session
   * riêng) + pane mới + log teammate-spawned.
   */
  spawnTeammate(
    input: Parameters<TeamServiceV2['spawnTeammate']>[0],
    now = Date.now(),
  ): TeamServiceV2Result<{ mate: Teammate; warnings: string[] }> {
    const partitionCheck = checkPartitionGuard(this.v2.snapshot.teammates, input.partition);
    if (!partitionCheck.allowed) return { ok: false, error: partitionCheck.error as string };
    const spawned = this.v2.spawnTeammate(input, now);
    if (!spawned.ok) return { ok: false, error: spawned.error };
    const warnings = [...partitionCheck.warnings, ...spawned.value.warnings];
    this.logConversation('teammate-spawned', this.v2.lead.name, `Lead spawn teammate "${spawned.value.mate.name}"${input.partition ? ` (partition ${input.partition})` : ''}.`, this.v2.lead.id, undefined, now);
    this.appendPaneLogInternal(spawned.value.mate.id, `Đã tham gia team "${this.snapshot.name}".`, now);
    return { ok: true, value: { mate: spawned.value.mate, warnings } };
  }

  /**
   * Bảo đảm worker seat của lead tồn tại (tạo khi chưa có): seat là
   * một teammate thường ("lead · worker") để lead làm việc qua đó ở
   * implement mode — v1 cấm lead claim trực tiếp nên không có seat
   * thì lead không làm được task nào.
   */
  ensureLeadWorkerSeat(now = Date.now()): TeamServiceV2Result<{ mate: Teammate; warnings: string[] }> {
    const existing = this.v3.leadWorkerId ? this.findTeammate(this.v3.leadWorkerId) : undefined;
    if (existing) return { ok: true, value: { mate: existing, warnings: [] } };
    const byName = this.findTeammateByName(leadWorkerName(this.v2.lead.name));
    if (byName) {
      this.v3 = { ...this.v3, leadWorkerId: byName.id, updatedAt: now };
      return { ok: true, value: { mate: byName, warnings: [] } };
    }
    const spawned = this.spawnTeammate(
      { name: leadWorkerName(this.v2.lead.name), specialty: 'lead-implementer' },
      now,
    );
    if (!spawned.ok) return { ok: false, error: spawned.error };
    this.v3 = { ...this.v3, leadWorkerId: spawned.value.mate.id, updatedAt: now };
    return { ok: true, value: { mate: spawned.value.mate, warnings: spawned.value.warnings } };
  }

  /**
   * Phân giải actor của một thao tác claim/start/close: lead.id ở
   * implement mode → worker seat của lead; lead.id ở delegate mode
   * → lỗi; worker seat ở delegate mode → lỗi; teammate thường →
   * giữ nguyên.
   */
  private resolveActorId(
    teammateId: string,
    now: number,
  ): TeamV3Result<string> {
    const leadId = this.snapshot.leadId;
    if (teammateId === leadId) {
      if (this.v3.leadMode !== 'implement') {
        return { ok: false, error: 'Lead đang ở delegate mode (chỉ giao việc, không tự làm) — chuyển sang implement mode để lead trực tiếp làm task (qua worker seat).' };
      }
      const seat = this.ensureLeadWorkerSeat(now);
      if (!seat.ok) return { ok: false, error: seat.error };
      return { ok: true, value: seat.value.mate.id };
    }
    if (this.v3.leadWorkerId && teammateId === this.v3.leadWorkerId) {
      const check = checkLeadWorkerClaim(this.v3.leadMode, teammateId, this.v3.leadWorkerId);
      if (!check.ok) return { ok: false, error: check.error };
    }
    return { ok: true, value: teammateId };
  }

  /** Thêm task vào danh sách chia sẻ (v1 qua v2, không đổi). */
  addTask(
    input: Parameters<TeamServiceV2['addTask']>[0],
    now = Date.now(),
  ): TeamServiceV2Result<TeamTask> {
    return this.v2.addTask(input, now);
  }

  /** Xóa teammate: v2 remove + xóa pane + log. */
  removeTeammate(teammateId: string, now = Date.now()): TeamServiceV2Result<Teammate> {
    const removed = this.v2.removeTeammate(teammateId, now);
    if (!removed.ok) return { ok: false, error: removed.error };
    this.v3 = {
      ...this.v3,
      panes: this.v3.panes.filter((p) => p.teammateId !== teammateId),
      updatedAt: now,
    };
    return { ok: true, value: removed.value };
  }

  // ------------------------------------------------------------------
  // Claim / start / close — lifecycle 3 trạng thái + file lock + wave
  // ------------------------------------------------------------------

  /**
   * Claim task (primitive file-lock): phân giải actor (lead ở
   * implement mode → worker seat) → wave gate → file guard
   * (override chỉ lead, ghi log + thu hồi claim người đang giữ) →
   * v2 claim (v1 claim + disk lock lease). Disk lock lỗi thì v2 đã
   * rollback claim v1.
   */
  claimTask(
    taskId: string,
    teammateId: string,
    opts: { allowOverride?: boolean; overrideById?: string; now?: number } = {},
  ): TeamV3Result<{ task: TeamTask; leaseUntil: number; waveIndex: number; warnings: string[]; claimedAsId: string }> {
    const now = opts.now ?? Date.now();
    const resolved = this.resolveActorId(teammateId, now);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const actorId = resolved.value;
    const mate = this.findTeammate(actorId);
    if (!mate) return { ok: false, error: `Không tìm thấy teammate ${actorId}.` };
    const leadCheck = checkLeadClaim(this.v3.leadMode, actorId, this.snapshot.leadId);
    if (!leadCheck.ok) return { ok: false, error: leadCheck.error };
    const wavesRes = this.waves();
    if (!wavesRes.ok) return { ok: false, error: wavesRes.error };
    const waveGate = canClaimByWave(wavesRes.value, taskId);
    if (!waveGate.allowed) {
      this.logConversation('wave-blocked', mate.name, `Claim task bị chặn bởi wave: ${waveGate.reason}`, actorId, taskId, now);
      return { ok: false, error: `Không claim được: ${waveGate.reason}` };
    }
    const team = this.v2.snapshot;
    const guard = checkFileGuard(team.tasks, team.teammates, taskId, actorId, {
      allowOverride: opts.allowOverride,
    });
    if (!guard.allowed) return { ok: false, error: guard.error as string };
    if (guard.holds.length > 0 && opts.allowOverride) {
      const overrideById = opts.overrideById ?? teammateId;
      const override = canOverrideFileGuard(overrideById, this.snapshot.leadId, this.v3.config.allowFileOverride);
      if (!override.ok) return { ok: false, error: override.error };
      // Override có kiểm soát = lead thu hồi claim của người đang giữ
      // file (task họ về pending, disk lock nhả) rồi claim cho lead;
      // v1 claimTask cũng chặn file bị khóa nên không thể "cứ claim"
      // mà bỏ qua bước thu hồi. Mọi bước đều ghi log hội thoại.
      const holderTaskIds = [...new Set(guard.holds.map((h) => h.taskId))];
      for (const holderTaskId of holderTaskIds) {
        const holderTask = team.tasks.find((t) => t.id === holderTaskId);
        if (!holderTask?.claimedBy) continue;
        const released = this.v2.releaseTask(holderTaskId, holderTask.claimedBy, now);
        if (!released.ok) return { ok: false, error: `Override thất bại khi thu hồi task "${holderTask.title}": ${released.error}` };
      }
      this.logConversation(
        'file-override',
        mate.name,
        `Lead override file guard: thu hồi ${holderTaskIds.length} task đang giữ file (${guard.holds.map((h) => `"${h.file}" (đang bị ${h.teammateName} giữ)`).join('; ')}) để claim cho ${mate.name}.`,
        actorId,
        taskId,
        now,
      );
    }
    const claimed = this.v2.claimTask(taskId, actorId, now);
    if (!claimed.ok) return { ok: false, error: claimed.error };
    this.appendPaneLogInternal(actorId, `Claim task "${claimed.value.task.title}" (wave ${(waveGate.waveIndex ?? 0) + 1}, lease tới ${new Date(claimed.value.leaseUntil).toISOString()}).`, now);
    return {
      ok: true,
      value: { task: claimed.value.task, leaseUntil: claimed.value.leaseUntil, waveIndex: waveGate.waveIndex ?? 0, warnings: guard.warnings, claimedAsId: actorId },
    };
  }

  /** Heartbeat gia hạn lease lock (v2, không đổi). */
  heartbeat(taskId: string, teammateId: string, now = Date.now()): TeamServiceV2Result<{ leaseUntil: number }> {
    return this.v2.heartbeat(taskId, teammateId, now);
  }

  /** Nhả task: v2 release + log (lead nhả qua worker seat ở implement mode). */
  releaseTask(taskId: string, teammateId: string, now = Date.now()): TeamServiceV2Result<TeamTask> {
    const resolved = this.resolveActorId(teammateId, now);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const res = this.v2.releaseTask(taskId, resolved.value, now);
    if (!res.ok) return { ok: false, error: res.error };
    this.appendPaneLogInternal(resolved.value, `Nhả task "${res.value.title}".`, now);
    return { ok: true, value: res.value };
  }

  /**
   * Bắt đầu task đã claim: open → in-progress (lifecycle). Lead ở
   * delegate mode không được start (lead làm việc qua worker seat ở
   * implement mode).
   */
  startTask(taskId: string, teammateId: string, now = Date.now()): TeamV3Result<TeamTask> {
    const resolved = this.resolveActorId(teammateId, now);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const actorId = resolved.value;
    const mate = this.findTeammate(actorId);
    if (!mate) return { ok: false, error: `Không tìm thấy teammate ${actorId}.` };
    const leadCheck = checkLeadClaim(this.v3.leadMode, actorId, this.snapshot.leadId);
    if (!leadCheck.ok) return { ok: false, error: leadCheck.error };
    const task = this.findTask(taskId);
    if (!task) return { ok: false, error: `Không tìm thấy task ${taskId}.` };
    if (v3StateOf(task) !== 'open') {
      return { ok: false, error: `Task "${task.title}" đang ở trạng thái ${v3StateOf(task)} — chỉ start được task open.` };
    }
    const started = this.v2.startTask(taskId, actorId, now);
    if (!started.ok) return { ok: false, error: started.error };
    this.logConversation('lifecycle', mate.name, `${mate.name} bắt đầu task "${task.title}" (open → in-progress).`, actorId, taskId, now);
    this.appendPaneLogInternal(actorId, `Bắt đầu task "${task.title}".`, now);
    return { ok: true, value: started.value };
  }

  /**
   * Đóng task: in-progress → closed (lifecycle).
   * - outcome=done: v2 complete (merge fork + hook TaskCompleted; exit 2 = giữ task mở).
   * - outcome=failed: v2 failTask (task về failed, retryable theo attempts).
   * Đóng xong wave nào thì ghi log wave-advance.
   */
  async closeTask(
    taskId: string,
    teammateId: string,
    outcome: V3TaskOutcome,
    opts: { summary?: string; error?: string; now?: number } = {},
  ): Promise<TeamV3Result<CloseTaskV3Result>> {
    const now = opts.now ?? Date.now();
    const resolved = this.resolveActorId(teammateId, now);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const actorId = resolved.value;
    const mate = this.findTeammate(actorId);
    if (!mate) return { ok: false, error: `Không tìm thấy teammate ${actorId}.` };
    const task = this.findTask(taskId);
    if (!task) return { ok: false, error: `Không tìm thấy task ${taskId}.` };
    if (v3StateOf(task) !== 'in-progress') {
      return { ok: false, error: `Task "${task.title}" đang ở trạng thái ${v3StateOf(task)} — chỉ close được task in-progress.` };
    }
    const wavesBefore = this.waves();
    const doneWavesBefore = wavesBefore.ok ? new Set(wavesBefore.value.filter((w) => w.status === 'done').map((w) => w.index)) : new Set<number>();
    let result: CloseTaskV3Result;
    if (outcome === 'done') {
      const done = await this.v2.completeTask(taskId, actorId, opts.summary, { now });
      if (!done.ok) return { ok: false, error: done.error };
      result = {
        task: done.value.task,
        outcome: 'done',
        hookRan: done.value.hookRan,
        heldOpen: done.value.heldOpen,
        feedback: done.value.feedback,
      };
    } else {
      // outcome=failed theo ngữ nghĩa v1: còn lượt thử → task về pending để
      // claim lại (retryable); hết lượt → failed. Không phải lúc nào cũng 'failed'.
      const failed = this.v2.failTask(taskId, actorId, opts.error ?? 'Task thất bại (không rõ lý do).', now);
      if (!failed.ok) return { ok: false, error: failed.error };
      result = { task: failed.value.task, outcome: 'failed', hookRan: false, heldOpen: false };
    }
    const finalState = v3StateOf(result.task);
    const outcomeLabel = v3OutcomeOf(result.task) ?? outcome;
    if (result.heldOpen) {
      this.logConversation('lifecycle', mate.name, `Hook TaskCompleted giữ task "${task.title}" mở: ${result.feedback ?? ''} (in-progress → open).`, actorId, taskId, now);
    } else if (finalState === 'open') {
      this.logConversation('lifecycle', mate.name, `${mate.name} báo task "${task.title}" lỗi (in-progress → open, còn lượt thử — claim lại để làm tiếp).`, actorId, taskId, now);
    } else {
      this.logConversation('lifecycle', mate.name, `${mate.name} đóng task "${task.title}" (in-progress → closed, ${outcomeLabel})${opts.summary ? `: ${opts.summary.slice(0, 200)}` : ''}.`, actorId, taskId, now);
    }
    this.appendPaneLogInternal(actorId, `Đóng task "${task.title}" (${outcomeLabel})${result.heldOpen ? ' — hook giữ mở' : ''}.`, now);
    // Wave nào vừa xong nhờ task này?
    if (!result.heldOpen && finalState === 'closed') {
      const wavesAfter = this.waves();
      if (wavesAfter.ok) {
        const newlyDone = wavesAfter.value.find((w) => w.status === 'done' && !doneWavesBefore.has(w.index));
        if (newlyDone) {
          result = { ...result, waveCompleted: newlyDone.index };
          this.logConversation('wave-advance', this.v2.lead.name, `Wave ${newlyDone.index + 1} đã xong — wave ${newlyDone.index + 2} được mở claim.`, this.snapshot.leadId, taskId, now);
        }
      }
    }
    return { ok: true, value: result };
  }

  // ------------------------------------------------------------------
  // SendMessage trực tiếp (primitive send-message) + mailbox v1
  // ------------------------------------------------------------------

  /**
   * Gửi tin trực tiếp teammate-to-teammate (primitive send-message):
   * không qua lead — lead chỉ nhận bản sao trong log hội thoại khi
   * tin là question gửi cho lead. Broadcast chỉ lead được gửi.
   */
  sendMessageDirect(
    input: {
      fromId: string;
      toId: string;
      kind: 'request' | 'result' | 'question';
      taskId?: string;
      body: string;
    },
    now = Date.now(),
  ): TeamServiceV2Result<MailboxMessage> {
    const from = this.findTeammate(input.fromId);
    if (!from) return { ok: false, error: `Không tìm thấy teammate ${input.fromId}.` };
    if (input.toId !== '*' && !this.findTeammate(input.toId)) {
      return { ok: false, error: `Không tìm thấy teammate nhận ${input.toId}.` };
    }
    if (input.toId === '*') {
      return { ok: false, error: 'Broadcast (*) chỉ lead được gửi — dùng sendMessageDirect từ lead hoặc broadcast riêng.' };
    }
    if (input.fromId === input.toId) {
      return { ok: false, error: 'Không tự nhắn cho chính mình.' };
    }
    const sent = this.v2.sendMessage(
      { fromId: input.fromId, toId: input.toId, kind: input.kind, taskId: input.taskId, body: input.body },
      now,
    );
    if (!sent.ok) return { ok: false, error: sent.error };
    const to = this.findTeammate(input.toId);
    this.logConversation('message', from.name, `${from.name} → ${to?.name ?? input.toId} [${input.kind}]: ${input.body.slice(0, 300)}`, input.fromId, input.taskId, now);
    return { ok: true, value: sent.value };
  }

  /** Lead broadcast toàn team (chỉ lead). */
  broadcast(
    body: string,
    taskId?: string,
    now = Date.now(),
  ): TeamServiceV2Result<MailboxMessage> {
    const lead = this.v2.lead;
    const sent = this.v2.sendMessage({ fromId: lead.id, toId: '*', kind: 'broadcast', taskId, body }, now);
    if (!sent.ok) return { ok: false, error: sent.error };
    this.logConversation('message', lead.name, `Lead broadcast: ${body.slice(0, 300)}`, lead.id, taskId, now);
    return { ok: true, value: sent.value };
  }

  // ------------------------------------------------------------------
  // Challenge (teammate thách thức kết luận của nhau)
  // ------------------------------------------------------------------

  openChallenge(input: OpenChallengeInput, now = Date.now()): TeamV3Result<import('./types').TeamChallenge> {
    const team = this.v2.snapshot;
    if (!this.v3.config.allowChallenges) {
      return { ok: false, error: 'Team này tắt challenge (allowChallenges=false).' };
    }
    const res = openChallenge(this.v3.challenges, team.tasks, team.teammates, input, now);
    if (!res.ok) return { ok: false, error: res.error };
    const challenge = { ...res.value.challenge, teamId: team.id };
    this.v3 = {
      ...this.v3,
      challenges: [...this.v3.challenges, challenge],
      conversation: [...this.v3.conversation, res.value.entry].slice(-MAX_TEAM_CONVERSATION_ENTRIES),
      updatedAt: now,
    };
    // Gửi mailbox request cho người bị thách thức để họ thấy trong inbox
    // (v1: tin 'question' chỉ gửi cho lead, nên challenge dùng 'request').
    this.v2.sendMessage(
      {
        fromId: challenge.challengerId,
        toId: challenge.targetId,
        kind: 'request',
        taskId: challenge.taskId,
        body: `Challenge kết luận task "${challenge.taskTitle}": ${challenge.body}`,
      },
      now,
    );
    return { ok: true, value: challenge };
  }

  answerChallenge(challengeId: string, answerById: string, answer: string, now = Date.now()): TeamV3Result<import('./types').TeamChallenge> {
    const res = answerChallenge(this.v3.challenges, challengeId, answerById, answer, now);
    if (!res.ok) return { ok: false, error: res.error };
    this.v3 = {
      ...this.v3,
      challenges: this.v3.challenges.map((c) => (c.id === challengeId ? res.value.challenge : c)),
      conversation: [...this.v3.conversation, res.value.entry].slice(-MAX_TEAM_CONVERSATION_ENTRIES),
      updatedAt: now,
    };
    return { ok: true, value: res.value.challenge };
  }

  resolveChallenge(challengeId: string, resolution: string, now = Date.now()): TeamV3Result<import('./types').TeamChallenge> {
    const lead = this.v2.lead;
    const res = resolveChallenge(this.v3.challenges, challengeId, lead.id, lead.name, resolution, now);
    if (!res.ok) return { ok: false, error: res.error };
    this.v3 = {
      ...this.v3,
      challenges: this.v3.challenges.map((c) => (c.id === challengeId ? res.value.challenge : c)),
      conversation: [...this.v3.conversation, res.value.entry].slice(-MAX_TEAM_CONVERSATION_ENTRIES),
      updatedAt: now,
    };
    return { ok: true, value: res.value.challenge };
  }

  // ------------------------------------------------------------------
  // Lead control (primitive lead-control)
  // ------------------------------------------------------------------

  /**
   * Chuyển mode lead giữa chừng (delegate ↔ implement). Về delegate
   * mà lead/seat đang giữ task dở thì cảnh báo (task vẫn giữ nguyên).
   * Sang implement thì tạo worker seat cho lead nếu chưa có (lead làm
   * việc qua seat này vì v1 cấm lead claim trực tiếp).
   */
  setLeadMode(mode: LeadMode, now = Date.now()): TeamV3Result<{ mode: LeadMode; warnings: string[] }> {
    const checked = validateLeadModeSwitch(this.v3.leadMode, mode);
    if (!checked.ok) return { ok: false, error: checked.error };
    const warnings: string[] = [];
    if (mode === 'implement') {
      const seat = this.ensureLeadWorkerSeat(now);
      if (!seat.ok) return { ok: false, error: seat.error };
      warnings.push(...seat.value.warnings);
    }
    if (mode === 'delegate') {
      const open = leadOpenTasks(this.v2.snapshot);
      const seatId = this.v3.leadWorkerId;
      const seatOpen = seatId
        ? this.v2.snapshot.tasks.filter(
            (t) => t.claimedBy === seatId && (t.status === 'claimed' || t.status === 'in-progress'),
          )
        : [];
      const allOpen = [...open, ...seatOpen];
      if (allOpen.length > 0) {
        warnings.push(
          `Lead/worker seat đang giữ ${allOpen.length} task dở (${allOpen.map((t) => `"${t.title}"`).join(', ')}) — task vẫn giữ nguyên, lead nên hoàn thành hoặc nhả trước khi giao việc tiếp.`,
        );
      }
    }
    const from = this.v3.leadMode;
    this.v3 = {
      ...this.v3,
      leadMode: mode,
      leadModeHistory: [...this.v3.leadModeHistory, { mode, at: now, byName: this.v2.lead.name }],
      conversation: [
        ...this.v3.conversation,
        {
          at: now,
          kind: 'mode-switch',
          fromName: this.v2.lead.name,
          fromId: this.v2.lead.id,
          body: `Lead chuyển mode ${from} → ${mode}. ${leadModeSwitchNote(from, mode)}`,
        } as TeamConversationEntry,
      ].slice(-MAX_TEAM_CONVERSATION_ENTRIES),
      updatedAt: now,
    };
    return { ok: true, value: { mode, warnings } };
  }

  /** Lead status board: trạng thái từng teammate. */
  leadBoard(): import('./types').LeadTeammateBoardEntry[] {
    const team = this.v2.snapshot;
    const wavesRes = this.waves();
    const waves = wavesRes.ok ? wavesRes.value : [];
    const unread: Record<string, number> = {};
    for (const mate of team.teammates) {
      unread[mate.id] = this.v2.snapshot.messages.filter((m) => m.toId === mate.id && !m.read).length;
    }
    return buildLeadBoard(team, {
      waves,
      unreadByTeammate: unread,
      openChallengesByTeammate: openChallengeCounts(this.v3.challenges),
      paneColumns: this.v3.config.paneColumns,
    });
  }

  // ------------------------------------------------------------------
  // Panes tmux + agent view
  // ------------------------------------------------------------------

  /** Panes hiện tại (đồng bộ với teammate list + lưu lại vào state). */
  panes(): TeammatePane[] {
    this.v3 = { ...this.v3, panes: syncPanes(this.v3.panes, this.v2.snapshot, this.v3.config.paneColumns) };
    return [...this.v3.panes];
  }

  /** Thêm dòng log vào pane của teammate. */
  appendPaneLog(teammateId: string, line: string, now = Date.now()): TeamV3Result<TeammatePane> {
    this.v3 = { ...this.v3, panes: syncPanes(this.v3.panes, this.v2.snapshot, this.v3.config.paneColumns) };
    const res = appendPaneLog(this.v3.panes, teammateId, line, now);
    if (!res.ok) return { ok: false, error: res.error };
    this.v3 = {
      ...this.v3,
      panes: this.v3.panes.map((p) => (p.teammateId === teammateId ? res.value : p)),
      updatedAt: now,
    };
    return { ok: true, value: res.value };
  }

  /** Focus một pane trong agent view. */
  focusPane(teammateId: string, now = Date.now()): TeamV3Result<TeammatePane[]> {
    this.v3 = { ...this.v3, panes: syncPanes(this.v3.panes, this.v2.snapshot, this.v3.config.paneColumns) };
    const res = focusPane(this.v3.panes, teammateId, now);
    if (!res.ok) return { ok: false, error: res.error };
    this.v3 = { ...this.v3, panes: res.value, updatedAt: now };
    return { ok: true, value: res.value };
  }

  /** Background sessions (agent view): mọi session đang có team. */
  backgroundSessions(): TeamBackgroundSession[] {
    const sessions: TeamBackgroundSession[] = [];
    for (const entry of listTeamSessions(this.baseDir)) {
      const loaded = TeamServiceV2.load(this.baseDir, entry.teamId);
      if (!loaded.service) continue;
      const team = loaded.service.snapshot;
      const v3loaded = new TeamV3Store(this.baseDir, entry.teamId).load().state;
      const wavesRes = computeWaves(team.tasks);
      const waves = wavesRes.ok ? wavesRes.value : [];
      const current = currentWave(waves);
      sessions.push(
        summarizeBackgroundSession(team, {
          sessionId: entry.sessionId,
          leadMode: v3loaded.leadMode,
          currentWave: current ? current.index : waves.length,
          totalWaves: waves.length,
        }),
      );
    }
    return sessions;
  }

  // ------------------------------------------------------------------
  // Chi phí tuyến tính + dashboard + dissolve
  // ------------------------------------------------------------------

  /** Ước tính chi phí token tuyến tính v3 của team hiện tại. */
  costEstimate(): import('./types').TeamV3CostEstimate {
    const team = this.v2.snapshot;
    const v2cost = this.v2.costEstimate();
    const inputs: TeamV3CostInputs = {
      teammates: team.teammates.length,
      tasks: team.tasks.length,
      messages: team.messages.length + this.v2.recentDiskMessages(1000).length,
      forks: this.v2.v2snapshot.forks.length,
    };
    return estimateTeamV3Cost(inputs, {
      tokenBudget: v2cost.budget,
      tokenWarnRatio: this.v2.config.tokenWarnRatio,
      tokensPerTeammate: this.v2.config.tokensPerTeammate,
      tokensPerTask: this.v2.config.tokensPerTask,
      tokensPerMessage: this.v2.config.tokensPerMessage,
    });
  }

  /** Kiểm tra cỡ team 3–5 (v2). */
  sizeCheck(): ReturnType<TeamServiceV2['sizeCheck']> {
    return this.v2.sizeCheck();
  }

  /** Snapshot dashboard v3. */
  dashboard(): TeamV3Dashboard {
    const team = this.v2.snapshot;
    const wavesRes = this.waves();
    const waves = wavesRes.ok ? wavesRes.value : [];
    const current = currentWave(waves);
    const panes = this.panes();
    const cost = this.costEstimate();
    const size = this.sizeCheck();
    const counts = { open: 0, inProgress: 0, closed: 0 };
    for (const task of team.tasks) {
      const s: V3TaskState = v3StateOf(task);
      if (s === 'open') counts.open += 1;
      else if (s === 'in-progress') counts.inProgress += 1;
      else counts.closed += 1;
    }
    return {
      teamId: team.id,
      teamName: team.name,
      goal: team.goal,
      status: team.status,
      leadName: this.v2.lead.name,
      leadMode: this.v3.leadMode,
      leadWorkerId: this.v3.leadWorkerId,
      primitives: [...TEAM_V3_PRIMITIVES],
      leadBoard: this.leadBoard(),
      waves,
      currentWaveIndex: current ? current.index : waves.length,
      panes,
      paneGrid: paneGridSize(panes),
      challenges: [...this.v3.challenges],
      challengeSummary: summarizeChallenges(this.v3.challenges),
      conversation: this.v3.conversation.slice(-50),
      cost,
      sizeWarnings: size.warnings,
      backgroundSessions: this.backgroundSessions(),
      fileHolds: summarizeFileHolds(team.tasks, team.teammates),
      lifecycleCounts: counts,
      updatedAt: Date.now(),
    };
  }

  /** Markdown dashboard (để tool trả text). */
  dashboardMarkdown(): string {
    return teamV3DashboardMarkdown(this.dashboard());
  }

  /** Giải tán team: v2 dissolve + gỡ khỏi session registry. */
  dissolve(reason: string, now = Date.now()): TeamServiceV2Result<AgentTeamV109> {
    const res = this.v2.dissolve(reason, now);
    if (!res.ok) return { ok: false, error: res.error };
    unregisterTeamSession(this.baseDir, this.snapshot.id);
    return { ok: true, value: res.value };
  }

  /** Tạm dừng / tiếp tục team (v2, không đổi). */
  pause(now = Date.now()): TeamServiceV2Result<AgentTeamV109> {
    return this.v2.pause(now);
  }

  resume(now = Date.now()): TeamServiceV2Result<AgentTeamV109> {
    return this.v2.resume(now);
  }

  // ------------------------------------------------------------------
  // Helpers nội bộ
  // ------------------------------------------------------------------

  private logConversation(
    kind: TeamConversationKind,
    fromName: string,
    body: string,
    fromId?: string,
    taskId?: string,
    now = Date.now(),
  ): void {
    const entry: TeamConversationEntry = { at: now, kind, fromName, fromId, taskId, body };
    this.v3 = {
      ...this.v3,
      conversation: [...this.v3.conversation, entry].slice(-MAX_TEAM_CONVERSATION_ENTRIES),
      updatedAt: now,
    };
  }

  private appendPaneLogInternal(teammateId: string, line: string, now: number): void {
    this.v3 = { ...this.v3, panes: syncPanes(this.v3.panes, this.v2.snapshot, this.v3.config.paneColumns) };
    const res = appendPaneLog(this.v3.panes, teammateId, line, now);
    if (res.ok) {
      this.v3 = {
        ...this.v3,
        panes: this.v3.panes.map((p) => (p.teammateId === teammateId ? res.value : p)),
        updatedAt: now,
      };
    }
  }
}

/** Ước tính chi phí v3 TRƯỚC khi tạo team (để UI cảnh báo tuyến tính). */
export function estimateCostBeforeCreateV3(
  teammateCount: number,
  taskCount: number,
  tokenBudget?: number,
): import('./types').TeamV3CostEstimate {
  return estimateCostBeforeCreate(teammateCount, taskCount, tokenBudget);
}

/** Kiểm tra cỡ team 3–5 (kế thừa v2, để tool/UI dùng chung). */
export function checkTeamSizeV3(teammateCount: number): { allowed: boolean; warnings: string[]; error?: string } {
  const cfg = defaultTeamV2Config();
  return checkTeamSize(teammateCount, cfg);
}

/** Ước tính token v2 thô (để so sánh với v3 trong test). */
export function estimateTeamTokensV2(
  input: { teammates: number; tasks: number; messages: number; forks: number },
  config: Partial<TeamV2Config> = {},
): ReturnType<typeof estimateTeamTokens> {
  return estimateTeamTokens(input, config);
}
