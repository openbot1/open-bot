/**
 * Agent Teams v2 — service (v1.10, Đội T3).
 *
 * `TeamServiceV2` bọc `TeamService` v1 (composition, không sửa
 * code v1) và thêm lớp disk + vai trò + hook + fork:
 *
 * - Claim 2 lớp: v1 claim (nguyên tử trong process) + disk lock
 *   (nguyên tử giữa các process, lease + heartbeat). Lock disk
 *   lỗi → rollback claim v1 để không kẹt nửa chừng.
 * - Lead spawn teammate: kiểm tra cỡ team 3–5 + cảnh báo token,
 *   tạo session file riêng cho teammate.
 * - Lead giao task: chỉ người được giao mới claim được (worker
 *   chỉ làm task được giao).
 * - Complete task: merge fork done của task vào resultSummary,
 *   rồi chạy hook TaskCompleted — exit 2 giữ task mở kèm
 *   feedback (task về pending, feedback gửi mailbox cho worker
 *   + lưu v2 state); exit khác 0/2 chỉ ghi lỗi, task vẫn done.
 * - Teammate chết: sweep lock treo (lease hết hạn) → nhả lock +
 *   task về pending để teammate khác claim lại.
 * - Disk mailbox theo tên, fork subagent, ước tính chi phí token.
 *
 * Persistence: file team v1 qua TeamsV109Store + trạng thái v2
 * qua TeamV2Store; caller gọi `save()` sau mỗi thao tác đổi state
 * (tool làm việc này, cùng mẫu tool v1).
 */

import {
  type AgentTeamV109,
  type AddTeammateInput,
  type CreateTeamV109Input,
  type MailboxMessage,
  type TeamTask,
  type Teammate,
  type TeamV109Event,
} from '../types';
import { TeamService, type TeamServiceResult } from '../service';
import { TeamsV109Store } from '../store';
import {
  acquireClaimLock,
  findStaleClaimLocks,
  getClaimLock,
  heartbeatClaimLock,
  listClaimLocks,
  reclaimStaleClaimLock,
  releaseClaimLock,
} from './claimLock';
import { checkTeamSize, estimateTeamTokens } from './cost';
import {
  markDiskInboxRead,
  markDiskMessageRead,
  readDiskInbox,
  readDiskMailboxBox,
  readDiskOutbox,
  recentDiskMessages,
  sendDiskMessage,
  type SendDiskMessageInput,
} from './diskMailbox';
import {
  completeFork,
  createFork,
  failFork,
  mergeFork,
  summarizeForksForParent,
  unmergedForks,
  type ForkResult,
  type SpawnForkInput,
} from './fork';
import {
  aggregateTeamResults,
  assignTaskToTeammate,
  canClaimAssignedTask,
  clearAssignmentForTask,
  unassignTask,
  type LeadWorkerResult,
} from './leadWorker';
import {
  addAssignedTaskToSession,
  closeTeammateSession,
  createTeammateSession,
  removeAssignedTaskFromSession,
} from './sessions';
import { TeamV2Store } from './stateStore';
import {
  runTaskCompletedHook,
  type TaskCompletedHookRunner,
} from './taskCompletedHook';
import {
  defaultTeamV2Config,
  validateTeamV2Config,
  type DiskMailboxMessage,
  type ForkNode,
  type ReviewFeedback,
  type TeamAggregateReport,
  type TeamCostEstimate,
  type TeamSizeCheck,
  type TeamV2Config,
  type TeamV2Dashboard,
  type TeamV2State,
  type TaskCompletedHookResult,
} from './types';
import { buildTeamV2Dashboard } from './dashboard';

/** Kết quả một thao tác của service v2. */
export type TeamServiceV2Result<T> = TeamServiceResult<T>;

/** Input tạo team v2 (v1 + cấu hình v2). */
export interface CreateTeamV2Input extends CreateTeamV109Input {
  v2config?: Partial<TeamV2Config>;
}

/** Kết quả complete task v2 (kèm quyết định hook). */
export interface CompleteTaskV2Result {
  task: TeamTask;
  /** Hook đã chạy chưa (false = không cấu hình hook). */
  hookRan: boolean;
  /** Kết quả hook (undefined khi không chạy hook). */
  hook?: TaskCompletedHookResult;
  /** true = hook giữ task mở, task đã về pending kèm feedback. */
  heldOpen: boolean;
  feedback?: string;
}

/** Kết quả sweep requeue task của teammate chết. */
export interface RequeueResult {
  /** Task đã requeue (lock treo → về pending). */
  requeued: { taskId: string; taskTitle: string; ownerName: string }[];
  /** Lock treo không requeue được (kèm lý do). */
  failed: { taskId: string; error: string }[];
}

export class TeamServiceV2 {
  private service: TeamService;
  private v2: TeamV2State;
  private readonly baseDir: string;

  constructor(team: AgentTeamV109, v2state: TeamV2State, baseDir: string) {
    this.service = TeamService.restore(team);
    this.v2 = v2state;
    this.baseDir = baseDir;
  }

  /** Team v1 hiện tại (snapshot). */
  get snapshot(): AgentTeamV109 {
    return this.service.snapshot;
  }

  /** Trạng thái v2 hiện tại (bản sao). */
  get v2snapshot(): TeamV2State {
    return {
      ...this.v2,
      config: { ...this.v2.config },
      assignments: [...this.v2.assignments],
      reviewFeedback: [...this.v2.reviewFeedback],
      forks: [...this.v2.forks],
    };
  }

  /** Cấu hình v2 hiện tại. */
  get config(): TeamV2Config {
    return { ...this.v2.config };
  }

  /** Thư mục dữ liệu gốc (userData) mà service v2 dùng. */
  get dataDir(): string {
    return this.baseDir;
  }

  /** Lead của team. */
  get lead(): Teammate {
    return this.service.lead;
  }

  /** Tìm teammate theo id. */
  findTeammate(id: string): Teammate | undefined {
    return this.service.findTeammate(id);
  }

  /** Tìm teammate theo TÊN (mailbox v2 địa chỉ theo tên). */
  findTeammateByName(name: string): Teammate | undefined {
    const normalized = name.trim();
    return this.service.snapshot.teammates.find((m) => m.name === normalized);
  }

  /** Tìm task theo id. */
  findTask(id: string): TeamTask | undefined {
    return this.service.findTask(id);
  }

  // ------------------------------------------------------------------
  // Tạo / load / save
  // ------------------------------------------------------------------

  /** Tạo team mới (v1 + state v2 + session lead). */
  static create(
    baseDir: string,
    input: CreateTeamV2Input,
    now = Date.now(),
  ): TeamServiceV2Result<TeamServiceV2> {
    const created = TeamService.create(input, now);
    if (!created.ok) return { ok: false, error: created.error };
    const service = created.value;
    const team = service.snapshot;
    const v2state: TeamV2State = {
      version: 2,
      teamId: team.id,
      config: { ...defaultTeamV2Config(), ...(input.v2config ?? {}) },
      assignments: [],
      reviewFeedback: [],
      forks: [],
      updatedAt: now,
    };
    const v2 = new TeamServiceV2(team, v2state, baseDir);
    const lead = service.lead;
    const session = createTeammateSession(
      baseDir,
      team.id,
      {
        mateId: lead.id,
        name: lead.name,
        role: 'lead',
        model: lead.model,
        teamGoal: team.goal,
      },
      now,
    );
    if (!session.ok) return { ok: false, error: session.error };
    return { ok: true, value: v2 };
  }

  /** Load team v1 + state v2 từ disk (team v1 chưa có v2 → state mặc định). */
  static load(
    baseDir: string,
    teamId: string,
  ): { service: TeamServiceV2 | null; loadError?: string } {
    const store = new TeamsV109Store(baseDir);
    const team = store.find(teamId);
    if (!team) return { service: null, loadError: `Không tìm thấy team ${teamId}.` };
    const { state, loadError } = new TeamV2Store(baseDir, teamId).load();
    return { service: new TeamServiceV2(team, state, baseDir), loadError };
  }

  /** Lưu team v1 + state v2 xuống disk. */
  save(): void {
    const store = new TeamsV109Store(this.baseDir);
    const { teams } = store.load();
    const updated = teams.map((t) => (t.id === this.snapshot.id ? this.snapshot : t));
    const exists = teams.some((t) => t.id === this.snapshot.id);
    store.save(exists ? updated : [...teams, this.snapshot]);
    new TeamV2Store(this.baseDir, this.snapshot.id).save(this.v2);
  }

  /** Cập nhật cấu hình v2 (validate trước). */
  updateV2Config(
    patch: Partial<TeamV2Config>,
    now = Date.now(),
  ): TeamServiceV2Result<TeamV2Config> {
    const next = { ...this.v2.config, ...patch };
    const errors = validateTeamV2Config(next);
    if (errors.length > 0) return { ok: false, error: errors.join(' ') };
    this.v2 = { ...this.v2, config: next, updatedAt: now };
    return { ok: true, value: { ...next } };
  }

  // ------------------------------------------------------------------
  // Lead spawn teammate (kèm cỡ team 3–5 + cảnh báo token + session)
  // ------------------------------------------------------------------

  /**
   * Lead spawn teammate mới: kiểm tra cỡ team 3–5 (vượt max mà
   * không override thì chặn), tạo teammate v1 + session file riêng.
   * Trả về teammate + cảnh báo (team nhỏ / sắp vượt ngân sách token).
   */
  spawnTeammate(
    input: AddTeammateInput,
    now = Date.now(),
  ): TeamServiceV2Result<{ mate: Teammate; warnings: string[] }> {
    const totalAfter = this.service.snapshot.teammates.length + 1;
    const size = checkTeamSize(totalAfter, this.v2.config);
    if (!size.allowed) return { ok: false, error: size.error as string };
    const added = this.service.addTeammate(input, now);
    if (!added.ok) return { ok: false, error: added.error };
    const mate = added.value;
    const session = createTeammateSession(
      this.baseDir,
      this.snapshot.id,
      {
        mateId: mate.id,
        name: mate.name,
        role: 'teammate',
        model: mate.model,
        specialty: mate.specialty,
        partition: mate.partition,
        teamGoal: this.snapshot.goal,
      },
      now,
    );
    if (!session.ok) {
      // Session lỗi → rollback: xóa teammate vừa thêm để không lệch state.
      this.service.removeTeammate(mate.id, now);
      return { ok: false, error: session.error };
    }
    const warnings = [...size.warnings];
    const cost = this.costEstimate();
    warnings.push(...cost.warnings);
    return { ok: true, value: { mate, warnings } };
  }

  /** Xóa teammate: v1 remove + đóng session + nhả lock + gỡ assignment. */
  removeTeammate(
    teammateId: string,
    now = Date.now(),
  ): TeamServiceV2Result<Teammate> {
    const mate = this.findTeammate(teammateId);
    if (!mate) return { ok: false, error: `Không tìm thấy teammate ${teammateId}.` };
    // Nhả mọi lock teammate đang giữ (task về pending qua v1 remove).
    for (const entry of listClaimLocks(this.baseDir, this.snapshot.id, now)) {
      if (entry.lock.ownerId === teammateId) {
        releaseClaimLock(this.baseDir, this.snapshot.id, entry.lock.taskId, teammateId);
      }
    }
    const removed = this.service.removeTeammate(teammateId, now);
    if (!removed.ok) return { ok: false, error: removed.error };
    this.v2 = {
      ...this.v2,
      assignments: this.v2.assignments.filter((a) => a.teammateId !== teammateId),
      updatedAt: now,
    };
    closeTeammateSession(this.baseDir, this.snapshot.id, teammateId, now);
    return { ok: true, value: removed.value };
  }

  // ------------------------------------------------------------------
  // Lead giao việc (worker chỉ claim task được giao)
  // ------------------------------------------------------------------

  /** Lead giao task cho một teammate (ghi assignment + session). */
  assignTask(
    taskId: string,
    teammateId: string,
    now = Date.now(),
  ): TeamServiceV2Result<{ taskId: string; teammateName: string }> {
    const res = assignTaskToTeammate(this.service.snapshot, this.v2.assignments, {
      taskId,
      teammateId,
      assignedById: this.service.lead.id,
    }, now);
    if (!res.ok) return { ok: false, error: res.error };
    this.v2 = { ...this.v2, assignments: res.value.assignments, updatedAt: now };
    addAssignedTaskToSession(this.baseDir, this.snapshot.id, teammateId, taskId, now);
    return { ok: true, value: { taskId, teammateName: res.value.assignment.teammateName } };
  }

  /** Lead hủy giao task (task về hàng đợi chung). */
  unassignTask(taskId: string): TeamServiceV2Result<boolean> {
    const assignment = this.v2.assignments.find((a) => a.taskId === taskId);
    const res = unassignTask(this.v2.assignments, taskId, this.service.lead.id, this.service.lead.id);
    if (!res.ok) return { ok: false, error: res.error };
    this.v2 = { ...this.v2, assignments: res.value, updatedAt: Date.now() };
    if (assignment) removeAssignedTaskFromSession(this.baseDir, this.snapshot.id, assignment.teammateId, taskId);
    return { ok: true, value: true };
  }

  /** Lead tổng hợp kết quả team. */
  aggregateResults(): TeamAggregateReport {
    return aggregateTeamResults(this.service.snapshot);
  }

  // ------------------------------------------------------------------
  // Claim 2 lớp: v1 + disk lock (lease + heartbeat)
  // ------------------------------------------------------------------

  /**
   * Teammate claim task: kiểm tra assignment (chỉ người được giao
   * mới claim task đã giao) → v1 claim → disk lock. Disk lock lỗi
   * thì rollback claim v1 (nhả task) để không kẹt nửa chừng.
   */
  claimTask(
    taskId: string,
    teammateId: string,
    now = Date.now(),
  ): TeamServiceV2Result<{ task: TeamTask; leaseUntil: number }> {
    const mate = this.findTeammate(teammateId);
    if (!mate) return { ok: false, error: `Không tìm thấy teammate ${teammateId}.` };
    const assignCheck = canClaimAssignedTask(this.v2.assignments, taskId, teammateId);
    if (!assignCheck.allowed) return { ok: false, error: assignCheck.reason };
    const claimed = this.service.claimTask(taskId, teammateId, now);
    if (!claimed.ok) return { ok: false, error: claimed.error };
    const lock = acquireClaimLock(
      this.baseDir,
      this.snapshot.id,
      taskId,
      teammateId,
      mate.name,
      this.v2.config.claimLeaseMs,
      now,
    );
    if (!lock.ok) {
      // Rollback claim v1: disk lock là lớp chống race giữa process.
      this.service.releaseTask(taskId, teammateId, now);
      return { ok: false, error: lock.error };
    }
    return { ok: true, value: { task: claimed.value, leaseUntil: lock.value.leaseUntil } };
  }

  /** Heartbeat: gia hạn lease lock của task đang giữ. */
  heartbeat(
    taskId: string,
    teammateId: string,
    now = Date.now(),
  ): TeamServiceV2Result<{ leaseUntil: number }> {
    const res = heartbeatClaimLock(
      this.baseDir,
      this.snapshot.id,
      taskId,
      teammateId,
      this.v2.config.claimLeaseMs,
      now,
    );
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, value: { leaseUntil: res.value.leaseUntil } };
  }

  /** Nhả task: v1 release + xóa disk lock. */
  releaseTask(
    taskId: string,
    teammateId: string,
    now = Date.now(),
  ): TeamServiceV2Result<TeamTask> {
    const released = this.service.releaseTask(taskId, teammateId, now);
    if (!released.ok) return { ok: false, error: released.error };
    releaseClaimLock(this.baseDir, this.snapshot.id, taskId, teammateId);
    return { ok: true, value: released.value };
  }

  /** Bắt đầu làm task đã claim (v1, không đổi). */
  startTask(taskId: string, teammateId: string, now = Date.now()): TeamServiceV2Result<TeamTask> {
    const res = this.service.startTask(taskId, teammateId, now);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, value: res.value };
  }

  /** Thêm task vào danh sách chia sẻ (v1, không đổi). */
  addTask(
    input: Parameters<TeamService['addTask']>[0],
    now = Date.now(),
  ): TeamServiceV2Result<TeamTask> {
    const res = this.service.addTask(input, now);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, value: res.value };
  }

  // ------------------------------------------------------------------
  // Complete task + hook TaskCompleted (exit 2 = giữ task mở)
  // ------------------------------------------------------------------

  /**
   * Teammate hoàn thành task: merge fork done của task vào
   * resultSummary → v1 complete → chạy hook TaskCompleted (nếu
   * cấu hình). Hook exit 2 → task về pending kèm feedback
   * (feedback gửi mailbox cho worker + lưu v2 state).
   */
  async completeTask(
    taskId: string,
    teammateId: string,
    resultSummary?: string,
    opts: { hookRunner?: TaskCompletedHookRunner; now?: number } = {},
  ): Promise<TeamServiceV2Result<CompleteTaskV2Result>> {
    const now = opts.now ?? Date.now();
    const task = this.findTask(taskId);
    if (!task) return { ok: false, error: `Không tìm thấy task ${taskId}.` };
    const mate = this.findTeammate(teammateId);
    if (!mate) return { ok: false, error: `Không tìm thấy teammate ${teammateId}.` };
    // Merge fork done (chưa merge) của task vào tóm tắt trước khi done.
    const forkSummary = summarizeForksForParent(this.v2.forks, taskId);
    const combinedSummary = [resultSummary?.trim(), forkSummary].filter(Boolean).join('\n');
    // Đánh dấu fork đã merge (chỉ fork done của task này).
    let forks = this.v2.forks;
    for (const fork of unmergedForks(forks).filter((f) => f.parentTaskId === taskId)) {
      const merged = mergeFork(forks, fork.id, now);
      if (merged.ok) forks = merged.value.forks;
    }
    this.v2 = { ...this.v2, forks, updatedAt: now };
    const done = this.service.completeTask(taskId, teammateId, combinedSummary || undefined, now);
    if (!done.ok) return { ok: false, error: done.error };
    // Nhả disk lock (task xong thì hết giữ file).
    releaseClaimLock(this.baseDir, this.snapshot.id, taskId, teammateId);
    this.v2 = {
      ...this.v2,
      assignments: clearAssignmentForTask(this.v2.assignments, taskId),
      updatedAt: now,
    };
    removeAssignedTaskFromSession(this.baseDir, this.snapshot.id, teammateId, taskId, now);
    const hookCommand = this.v2.config.taskCompletedHookCommand;
    if (!hookCommand?.trim()) {
      return { ok: true, value: { task: done.value, hookRan: false, heldOpen: false } };
    }
    const hook = await runTaskCompletedHook(
      hookCommand,
      {
        event: 'TaskCompleted',
        teamId: this.snapshot.id,
        teamName: this.snapshot.name,
        taskId,
        taskTitle: done.value.title,
        teammateId,
        teammateName: mate.name,
        resultSummary: combinedSummary || undefined,
      },
      { timeoutMs: this.v2.config.hookTimeoutMs, runner: opts.hookRunner },
    );
    if (hook.accepted) {
      return { ok: true, value: { task: done.value, hookRan: true, hook, heldOpen: false } };
    }
    // Exit 2: giữ task mở — task về pending kèm feedback reviewer.
    const feedback = hook.feedback ?? 'Reviewer giữ task mở (không có feedback).';
    this.reopenTaskWithFeedback(taskId, teammateId, feedback, now);
    return {
      ok: true,
      value: { task: this.findTask(taskId) as TeamTask, hookRan: true, hook, heldOpen: true, feedback },
    };
  }

  /**
   * Mở lại task đã done (hook exit 2): task về pending, xóa
   * resultSummary, teammate về working với task đó, feedback lưu
   * v2 state + gửi mailbox (request từ lead) cho worker.
   * Dùng replaceTeam (không sửa code v1): dựng team mới từ snapshot.
   */
  private reopenTaskWithFeedback(
    taskId: string,
    teammateId: string,
    feedback: string,
    now: number,
  ): void {
    const team = this.service.snapshot;
    const mate = team.teammates.find((m) => m.id === teammateId);
    const task = team.tasks.find((t) => t.id === taskId);
    if (!task || !mate) return;
    const reopened: TeamTask = {
      ...task,
      status: 'pending',
      claimedBy: undefined,
      claimedAt: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      resultSummary: undefined,
      updatedAt: now,
    };
    const event: TeamV109Event = {
      at: now,
      type: 'task-released',
      teammateId,
      taskId,
      message: `Hook TaskCompleted giữ task "${task.title}" mở: ${feedback.slice(0, 300)}`,
    };
    const nextTeam: AgentTeamV109 = {
      ...team,
      // Task về pending → team chưa xong nữa: nếu v1 vừa auto-complete
      // team (mọi task done) thì mở lại team về active.
      status: team.status === 'completed' ? 'active' : team.status,
      endReason: team.status === 'completed' ? undefined : team.endReason,
      tasks: team.tasks.map((t) => (t.id === taskId ? reopened : t)),
      teammates: team.teammates.map((m) =>
        m.id === teammateId
          ? { ...m, status: 'working', currentTaskId: taskId, tasksDone: Math.max(0, m.tasksDone - 1), updatedAt: now }
          : m,
      ),
      events: [...team.events, event].slice(-1000),
      updatedAt: now,
    };
    this.service = TeamService.restore(nextTeam);
    const review: ReviewFeedback = {
      taskId,
      feedback,
      reviewer: 'TaskCompleted hook',
      at: now,
    };
    this.v2 = {
      ...this.v2,
      reviewFeedback: [...this.v2.reviewFeedback.filter((r) => r.taskId !== taskId), review],
      updatedAt: now,
    };
    // Gửi feedback cho worker qua mailbox v1 (lead → worker, request).
    this.service.sendMessage({
      fromId: team.leadId,
      toId: teammateId,
      kind: 'request',
      taskId,
      body: `Reviewer giữ task "${task.title}" mở, làm lại theo feedback: ${feedback}`,
    });
    // Task vẫn thuộc về worker này — giao lại cho đúng người.
    this.v2 = {
      ...this.v2,
      assignments: [
        ...this.v2.assignments.filter((a) => a.taskId !== taskId),
        { taskId, teammateId, teammateName: mate.name, assignedById: team.leadId, assignedAt: now },
      ],
      updatedAt: now,
    };
  }

  /** Teammate báo task lỗi (v1 + nhả lock). */
  failTask(
    taskId: string,
    teammateId: string,
    error: string,
    now = Date.now(),
  ): TeamServiceV2Result<{ task: TeamTask; retryable: boolean }> {
    const res = this.service.failTask(taskId, teammateId, error, now);
    if (!res.ok) return { ok: false, error: res.error };
    releaseClaimLock(this.baseDir, this.snapshot.id, taskId, teammateId);
    if (!res.value.retryable) {
      this.v2 = {
        ...this.v2,
        assignments: clearAssignmentForTask(this.v2.assignments, taskId),
        updatedAt: now,
      };
    }
    return { ok: true, value: res.value };
  }

  // ------------------------------------------------------------------
  // Requeue teammate chết (lock treo)
  // ------------------------------------------------------------------

  /**
   * Sweep lock treo: lock hết lease → teammate coi như chết,
   * task về pending để teammate khác claim lại (nhả lock + reset
   * task qua replaceTeam, ghi event để audit).
   */
  requeueStale(now = Date.now()): RequeueResult {
    const stale = findStaleClaimLocks(this.baseDir, this.snapshot.id, now);
    const requeued: RequeueResult['requeued'] = [];
    const failed: RequeueResult['failed'] = [];
    let team = this.service.snapshot;
    for (const lock of stale) {
      const task = team.tasks.find((t) => t.id === lock.taskId);
      if (!task) {
        reclaimStaleClaimLock(this.baseDir, this.snapshot.id, lock.taskId, now);
        continue;
      }
      if (task.status !== 'claimed' && task.status !== 'in-progress') {
        // Task đã xong/nhả nhưng lock còn sót → chỉ xóa lock.
        reclaimStaleClaimLock(this.baseDir, this.snapshot.id, lock.taskId, now);
        continue;
      }
      const reclaimed = reclaimStaleClaimLock(this.baseDir, this.snapshot.id, lock.taskId, now);
      if (!reclaimed.ok) {
        failed.push({ taskId: lock.taskId, error: reclaimed.error });
        continue;
      }
      const reset: TeamTask = {
        ...task,
        status: 'pending',
        claimedBy: undefined,
        claimedAt: undefined,
        startedAt: undefined,
        updatedAt: now,
      };
      const event: TeamV109Event = {
        at: now,
        type: 'task-released',
        teammateId: lock.ownerId,
        taskId: lock.taskId,
        message: `Thu hồi task "${task.title}" — lock của "${lock.ownerName}" hết lease (teammate chết/mất heartbeat).`,
      };
      const owner = team.teammates.find((m) => m.id === lock.ownerId);
      team = {
        ...team,
        tasks: team.tasks.map((t) => (t.id === lock.taskId ? reset : t)),
        teammates: owner
          ? team.teammates.map((m) =>
              m.id === lock.ownerId ? { ...m, status: 'idle', currentTaskId: undefined, updatedAt: now } : m,
            )
          : team.teammates,
        events: [...team.events, event].slice(-1000),
        updatedAt: now,
      };
      requeued.push({ taskId: lock.taskId, taskTitle: task.title, ownerName: lock.ownerName });
    }
    if (requeued.length > 0) this.service = TeamService.restore(team);
    return { requeued, failed };
  }

  /** Lock hiện tại của một task (null = không ai giữ). */
  claimLockOf(taskId: string): ReturnType<typeof getClaimLock> {
    return getClaimLock(this.baseDir, this.snapshot.id, taskId);
  }

  /** Mọi lock của team (kèm trạng thái treo). */
  claimLocks(now = Date.now()): ReturnType<typeof listClaimLocks> {
    return listClaimLocks(this.baseDir, this.snapshot.id, now);
  }

  // ------------------------------------------------------------------
  // Disk mailbox theo tên
  // ------------------------------------------------------------------

  /** Gửi tin disk mailbox theo TÊN (direct/broadcast). */
  sendDiskMessage(
    input: {
      fromName: string;
      toName: string;
      kind: DiskMailboxMessage['kind'];
      taskId?: string;
      body: string;
    },
    now = Date.now(),
  ): TeamServiceV2Result<DiskMailboxMessage> {
    const team = this.service.snapshot;
    const sender = this.findTeammateByName(input.fromName);
    if (!sender) return { ok: false, error: `Không có teammate tên "${input.fromName}" trong team.` };
    let toId = '*';
    if (input.toName !== '*') {
      const recipient = this.findTeammateByName(input.toName);
      if (!recipient) return { ok: false, error: `Không có teammate tên "${input.toName}" trong team.` };
      toId = recipient.id;
    }
    // Question chỉ gửi cho lead (luật v1).
    if (input.kind === 'question' && input.toName !== '*' && toId !== team.leadId) {
      return { ok: false, error: 'Question chỉ gửi cho lead (hoặc broadcast cho cả team hỏi chung).' };
    }
    const full: SendDiskMessageInput = {
      fromId: sender.id,
      fromName: sender.name,
      toName: input.toName,
      toId,
      kind: input.kind,
      taskId: input.taskId,
      body: input.body,
      teamMembers: team.teammates.map((m) => ({ id: m.id, name: m.name })),
      isLead: sender.role === 'lead',
      allowQuestionsToLead: team.config.allowQuestionsToLead,
    };
    const res = sendDiskMessage(this.baseDir, team.id, full, now);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, value: res.value };
  }

  /** Inbox disk của một teammate (theo tên). */
  diskInbox(teammateName: string): DiskMailboxMessage[] {
    return readDiskInbox(this.baseDir, this.snapshot.id, teammateName);
  }

  /** Outbox disk của một teammate (theo tên). */
  diskOutbox(teammateName: string): DiskMailboxMessage[] {
    return readDiskOutbox(this.baseDir, this.snapshot.id, teammateName);
  }

  /** Hộp thư disk đầy đủ của một teammate. */
  diskMailboxBox(teammateName: string): ReturnType<typeof readDiskMailboxBox> {
    return readDiskMailboxBox(this.baseDir, this.snapshot.id, teammateName);
  }

  /** Đánh dấu đã đọc một tin disk (xác nhận đã đọc). */
  markDiskRead(
    teammateName: string,
    messageId: string,
    now = Date.now(),
  ): TeamServiceV2Result<DiskMailboxMessage> {
    const res = markDiskMessageRead(this.baseDir, this.snapshot.id, teammateName, messageId, now);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, value: res.value };
  }

  /** Đánh dấu đã đọc toàn bộ inbox disk của một teammate. */
  markDiskInboxRead(teammateName: string, now = Date.now()): number {
    return markDiskInboxRead(this.baseDir, this.snapshot.id, teammateName, now);
  }

  /** Tin disk mới nhất của team (gộp, tối đa 20). */
  recentDiskMessages(limit = 20): DiskMailboxMessage[] {
    const names = this.service.snapshot.teammates.map((m) => m.name);
    return recentDiskMessages(this.baseDir, this.snapshot.id, names, limit);
  }

  // ------------------------------------------------------------------
  // Fork subagent
  // ------------------------------------------------------------------

  /** Spawn fork subagent (giới hạn độ sâu + song song). */
  spawnFork(
    input: Omit<SpawnForkInput, 'teamId' | 'spawnedByName'> & { spawnedById: string },
    now = Date.now(),
  ): ForkResult<ForkNode> {
    const spawner = this.findTeammate(input.spawnedById);
    if (!spawner) return { ok: false, error: `Không tìm thấy teammate ${input.spawnedById}.` };
    const task = this.findTask(input.parentTaskId);
    if (!task) return { ok: false, error: `Không tìm thấy task cha ${input.parentTaskId}.` };
    const created = createFork(
      this.v2.forks,
      {
        teamId: this.snapshot.id,
        parentTaskId: input.parentTaskId,
        parentForkId: input.parentForkId,
        name: input.name,
        task: input.task,
        spawnedById: spawner.id,
        spawnedByName: spawner.name,
      },
      { maxDepth: this.v2.config.maxForkDepth, maxConcurrent: this.v2.config.maxConcurrentForks },
      now,
    );
    if (!created.ok) return { ok: false, error: created.error };
    this.v2 = { ...this.v2, forks: [...this.v2.forks, created.value], updatedAt: now };
    return { ok: true, value: created.value };
  }

  /** Fork xong: ghi tóm tắt + artifact. */
  completeFork(
    forkId: string,
    resultSummary: string,
    artifacts: string[] = [],
    tokensUsed?: number,
    now = Date.now(),
  ): ForkResult<ForkNode> {
    const res = completeFork(this.v2.forks, forkId, resultSummary, artifacts, tokensUsed, now);
    if (!res.ok) return { ok: false, error: res.error };
    this.v2 = { ...this.v2, forks: res.value.forks, updatedAt: now };
    return { ok: true, value: res.value.fork };
  }

  /** Fork lỗi. */
  failFork(forkId: string, error: string, now = Date.now()): ForkResult<ForkNode> {
    const res = failFork(this.v2.forks, forkId, error, now);
    if (!res.ok) return { ok: false, error: res.error };
    this.v2 = { ...this.v2, forks: res.value.forks, updatedAt: now };
    return { ok: true, value: res.value.fork };
  }

  /** Merge kết quả fork về task cha (tóm tắt + artifact). */
  mergeFork(
    forkId: string,
    now = Date.now(),
  ): ForkResult<{ fork: ForkNode; mergedSummary: string; artifacts: string[] }> {
    const res = mergeFork(this.v2.forks, forkId, now);
    if (!res.ok) return { ok: false, error: res.error };
    this.v2 = { ...this.v2, forks: res.value.forks, updatedAt: now };
    return {
      ok: true,
      value: { fork: res.value.fork, mergedSummary: res.value.merge.mergedSummary, artifacts: res.value.merge.artifacts },
    };
  }

  /** Fork của team (để UI/tool xem cây fork). */
  forks(): ForkNode[] {
    return [...this.v2.forks];
  }

  // ------------------------------------------------------------------
  // Chi phí + cỡ team + dashboard
  // ------------------------------------------------------------------

  /** Ước tính chi phí token của team (kèm cảnh báo). */
  costEstimate(): TeamCostEstimate {
    const team = this.service.snapshot;
    const diskCount = this.recentDiskMessages(1000).length;
    return estimateTeamTokens(
      {
        teammates: team.teammates.length,
        tasks: team.tasks.length,
        messages: team.messages.length + diskCount,
        forks: this.v2.forks.length,
      },
      this.v2.config,
    );
  }

  /** Kiểm tra cỡ team hiện tại (3–5). */
  sizeCheck(): TeamSizeCheck {
    return checkTeamSize(this.service.snapshot.teammates.length, this.v2.config);
  }

  /** Snapshot dashboard v2 (để UI Team + tool teams_v2_dashboard). */
  dashboard(): TeamV2Dashboard {
    return buildTeamV2Dashboard(this.service.snapshot, this.v2snapshot, this.baseDir);
  }

  /** Tóm tắt v1 (để tương thích tool/status cũ). */
  summary(): ReturnType<TeamService['summary']> {
    return this.service.summary();
  }

  /** Gửi tin mailbox v1 (giữ nguyên — mailbox v1 và disk v2 chạy song song). */
  sendMessage(
    input: Parameters<TeamService['sendMessage']>[0],
    now = Date.now(),
  ): TeamServiceV2Result<MailboxMessage> {
    const res = this.service.sendMessage(input, now);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, value: res.value };
  }

  /** Scheduler v1 (giữ nguyên). */
  schedule(now = Date.now()): ReturnType<TeamService['schedule']> {
    return this.service.schedule(now);
  }

  /** Tạm dừng / tiếp tục / giải tán team (v1, không đổi). */
  pause(now = Date.now()): TeamServiceV2Result<AgentTeamV109> {
    const res = this.service.pause(now);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, value: res.value };
  }

  resume(now = Date.now()): TeamServiceV2Result<AgentTeamV109> {
    const res = this.service.resume(now);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, value: res.value };
  }

  dissolve(reason: string, now = Date.now()): TeamServiceV2Result<AgentTeamV109> {
    const res = this.service.dissolve(reason, now);
    if (!res.ok) return { ok: false, error: res.error };
    for (const mate of this.service.snapshot.teammates) {
      closeTeammateSession(this.baseDir, this.snapshot.id, mate.id, now);
    }
    return { ok: true, value: res.value };
  }
}
