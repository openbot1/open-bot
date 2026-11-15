/**
 * Agent Teams v1 — service (v1.09, Đội T1).
 *
 * `TeamService` là điểm điều phối duy nhất của một team: tạo team,
 * thêm/bớt teammate, thêm task, claim/start/complete/fail task,
 * gửi/đọc mailbox, lập lịch (scheduler gán task ready cho teammate
 * rảnh, tôn trọng maxParallelTasks + file-lock + dependency), thu
 * hồi claim treo, pause/resume/complete/dissolve team.
 *
 * Service giữ state trong bộ nhớ; persistence do caller gọi
 * `snapshot()` rồi ghi qua `TeamsV109Store` (tool làm việc này).
 * Mọi phương thức đổi state đều ghi event vào nhật ký team.
 */

import {
  DEFAULT_MAX_TEAMMATES,
  MAX_TEAM_EVENTS,
  defaultTeamV109Config,
  newTeamId,
  normalizeTeamName,
  slugOf,
  validateTeamV109Config,
  type AddTeammateInput,
  type AddTeamTaskInput,
  type AgentTeamV109,
  type AgentTeamV109Status,
  type CreateTeamV109Input,
  type SendTeamMessageInput,
  type TeamTask,
  type TeamV109Event,
  type TeamV109Summary,
  type Teammate,
  type TeammateStatus,
} from './types';
import {
  claimTask,
  completeTask,
  countTasksByStatus,
  createTeamTask,
  failTask,
  findDependencyCycle,
  findStaleClaims,
  isTaskReady,
  readyTasks,
  reclaimStaleTask,
  releaseTask,
  startTask,
  validateNewTask,
} from './taskList';
import {
  inboxFor,
  markInboxRead,
  markMessageRead,
  sendTeamMessage,
  teamUnreadCount,
  unansweredQuestions,
  unreadCount,
} from './mailbox';
import { canAddTeammate, canRunMoreParallel, teammateTaskLoad } from './policy';
import { detectFileConflicts } from './partitions';

/** Kết quả một thao tác của service. */
export type TeamServiceResult<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; error: string; value?: undefined };

function ok<T>(value: T): TeamServiceResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): TeamServiceResult<T> {
  return { ok: false, error };
}

/** Một lần gán task của scheduler: task nào → teammate nào. */
export interface ScheduledAssignment {
  taskId: string;
  taskTitle: string;
  teammateId: string;
  teammateName: string;
}

export class TeamService {
  private team: AgentTeamV109;

  constructor(team: AgentTeamV109) {
    this.team = team;
  }

  /** Team hiện tại (bản sao nông của mảng con — caller không mutate trực tiếp). */
  get snapshot(): AgentTeamV109 {
    return {
      ...this.team,
      teammates: [...this.team.teammates],
      tasks: [...this.team.tasks],
      messages: [...this.team.messages],
      events: [...this.team.events],
    };
  }

  /** Tạo team mới với một lead. */
  static create(input: CreateTeamV109Input, now = Date.now()): TeamServiceResult<TeamService> {
    const name = normalizeTeamName(input.name);
    if (!name) return fail('Tên team không được rỗng.');
    if (!input.goal.trim()) return fail('Mục tiêu team không được rỗng.');
    const configErrors = validateTeamV109Config(input.config ?? {});
    if (configErrors.length > 0) return fail(configErrors.join(' '));
    const config = { ...defaultTeamV109Config(), ...(input.config ?? {}) };
    if (config.maxParallelTasks > config.maxTeammates) {
      config.maxParallelTasks = config.maxTeammates;
    }
    const leadName = normalizeTeamName(input.leadName ?? 'lead') || 'lead';
    const lead: Teammate = {
      id: newTeamId('mate'),
      name: leadName,
      role: 'lead',
      model: input.defaultModel,
      status: 'idle',
      tasksDone: 0,
      tasksFailed: 0,
      createdAt: now,
      updatedAt: now,
    };
    const team: AgentTeamV109 = {
      id: newTeamId('team'),
      name,
      goal: input.goal.trim(),
      leadId: lead.id,
      defaultModel: input.defaultModel,
      teammates: [lead],
      tasks: [],
      messages: [],
      config,
      status: 'active',
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    const service = new TeamService(team);
    service.pushEvent('created', `Team "${name}" được tạo, lead là ${leadName}.`);
    return ok(service);
  }

  /** Khôi phục service từ team đã lưu (không validate lại — store đã lọc). */
  static restore(team: AgentTeamV109): TeamService {
    return new TeamService(team);
  }

  private pushEvent(
    type: TeamV109Event['type'],
    message: string,
    teammateId?: string,
    taskId?: string,
    now = Date.now(),
  ): void {
    const event: TeamV109Event = { at: now, type, teammateId, taskId, message };
    this.team = {
      ...this.team,
      events: [...this.team.events, event].slice(-MAX_TEAM_EVENTS),
      updatedAt: now,
    };
  }

  private updateTeammate(id: string, patch: Partial<Teammate>, now = Date.now()): void {
    this.team = {
      ...this.team,
      teammates: this.team.teammates.map((m) =>
        m.id === id ? { ...m, ...patch, updatedAt: now } : m,
      ),
    };
  }

  private setTasks(tasks: TeamTask[], now = Date.now()): void {
    this.team = { ...this.team, tasks, updatedAt: now };
  }

  /** Lead của team. */
  get lead(): Teammate {
    return this.team.teammates.find((m) => m.id === this.team.leadId) as Teammate;
  }

  /** Tìm teammate theo id. */
  findTeammate(id: string): Teammate | undefined {
    return this.team.teammates.find((m) => m.id === id);
  }

  /** Tìm task theo id. */
  findTask(id: string): TeamTask | undefined {
    return this.team.tasks.find((t) => t.id === id);
  }

  /** Thêm teammate (kiểm tra giới hạn + trùng tên + partition chồng). */
  addTeammate(input: AddTeammateInput, now = Date.now()): TeamServiceResult<Teammate> {
    if (this.team.status !== 'active' && this.team.status !== 'paused') {
      return fail(`Team đang ở trạng thái ${this.team.status}, không thêm teammate được.`);
    }
    const name = normalizeTeamName(input.name);
    if (!name) return fail('Tên teammate không được rỗng.');
    if (this.team.teammates.some((m) => m.name === name)) {
      return fail(`Team đã có teammate tên "${name}".`);
    }
    const limit = canAddTeammate(this.team.teammates.length, this.team.config.maxTeammates);
    if (!limit.allowed) return fail(limit.reason);
    const partition = input.partition?.trim() || undefined;
    if (partition) {
      const clash = this.team.teammates.find(
        (m) =>
          m.partition &&
          (m.partition.replace(/\/+$/, '') === partition.replace(/\/+$/, '') ||
            m.partition.startsWith(partition) ||
            partition.startsWith(m.partition)),
      );
      if (clash) {
        return fail(`Partition "${partition}" chồng với partition của "${clash.name}".`);
      }
    }
    const mate: Teammate = {
      id: newTeamId('mate'),
      name,
      role: 'teammate',
      model: input.model,
      specialty: input.specialty?.trim() || undefined,
      status: 'idle',
      partition,
      tasksDone: 0,
      tasksFailed: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.team = { ...this.team, teammates: [...this.team.teammates, mate], updatedAt: now };
    this.pushEvent('teammate-added', `Teammate "${name}" tham gia team.`, mate.id);
    return ok(mate);
  }

  /** Xóa teammate (không xóa lead; teammate đang giữ task thì task được nhả về pending). */
  removeTeammate(teammateId: string, now = Date.now()): TeamServiceResult<Teammate> {
    const mate = this.findTeammate(teammateId);
    if (!mate) return fail(`Không tìm thấy teammate ${teammateId}.`);
    if (mate.role === 'lead') return fail('Không xóa lead. Giải tán team hoặc đổi lead trước.');
    // Nhả mọi task teammate đang giữ về pending.
    let tasks = this.team.tasks;
    for (const task of tasks.filter((t) => t.claimedBy === teammateId)) {
      const released = releaseTask(tasks, task.id, teammateId, now);
      if (released.ok) tasks = released.value.tasks;
    }
    this.setTasks(tasks, now);
    this.team = {
      ...this.team,
      teammates: this.team.teammates.filter((m) => m.id !== teammateId),
      updatedAt: now,
    };
    this.pushEvent('teammate-removed', `Teammate "${mate.name}" rời team; task đang giữ đã nhả về pending.`, teammateId);
    return ok(mate);
  }

  /** Đổi trạng thái teammate (idle/working/waiting/blocked/done/failed). */
  setTeammateStatus(
    teammateId: string,
    status: TeammateStatus,
    now = Date.now(),
  ): TeamServiceResult<Teammate> {
    const mate = this.findTeammate(teammateId);
    if (!mate) return fail(`Không tìm thấy teammate ${teammateId}.`);
    this.updateTeammate(teammateId, { status }, now);
    return ok(this.findTeammate(teammateId) as Teammate);
  }

  /** Thêm task vào danh sách chia sẻ (validate dependency + chu trình). */
  addTask(input: AddTeamTaskInput, now = Date.now()): TeamServiceResult<TeamTask> {
    if (this.team.status !== 'active' && this.team.status !== 'paused') {
      return fail(`Team đang ở trạng thái ${this.team.status}, không thêm task được.`);
    }
    const errors = validateNewTask(this.team.tasks, input);
    if (errors.length > 0) return fail(errors.join(' '));
    const task = createTeamTask(input, now);
    const withNew = [...this.team.tasks, task];
    const cycle = findDependencyCycle(withNew);
    if (cycle.length > 0) {
      return fail(`Dependency tạo chu trình: ${cycle.join(' -> ')}.`);
    }
    this.setTasks(withNew, now);
    this.pushEvent('task-added', `Task "${task.title}" được thêm (ưu tiên ${task.priority}).`, undefined, task.id);
    return ok(task);
  }

  /** Teammate claim task (kèm file-lock + dependency, xem taskList.claimTask). */
  claimTask(taskId: string, teammateId: string, now = Date.now()): TeamServiceResult<TeamTask> {
    if (this.team.status !== 'active') {
      return fail(`Team đang ở trạng thái ${this.team.status}, không claim task được.`);
    }
    const mate = this.findTeammate(teammateId);
    if (!mate) return fail(`Không tìm thấy teammate ${teammateId}.`);
    if (mate.role === 'lead') return fail('Lead điều phối, không claim task trực tiếp.');
    if (mate.status === 'blocked' || mate.status === 'failed') {
      return fail(`Teammate "${mate.name}" đang ở trạng thái ${mate.status}, không claim được.`);
    }
    const load = teammateTaskLoad(
      this.team.tasks.filter(
        (t) => t.claimedBy === teammateId && (t.status === 'claimed' || t.status === 'in-progress'),
      ).length,
    );
    if (load.overloaded) return fail(load.reason);
    const res = claimTask(this.team.tasks, taskId, teammateId, now);
    if (!res.ok) return fail(res.error as string);
    this.setTasks(res.value.tasks, now);
    this.updateTeammate(teammateId, { status: 'working', currentTaskId: taskId }, now);
    this.pushEvent('task-claimed', `"${mate.name}" claim task "${res.value.task.title}".`, teammateId, taskId);
    return ok(res.value.task);
  }

  /** Teammate bắt đầu làm task đã claim. */
  startTask(taskId: string, teammateId: string, now = Date.now()): TeamServiceResult<TeamTask> {
    const res = startTask(this.team.tasks, taskId, teammateId, now);
    if (!res.ok) return fail(res.error as string);
    this.setTasks(res.value.tasks, now);
    this.pushEvent('task-started', `Task "${res.value.task.title}" bắt đầu chạy.`, teammateId, taskId);
    return ok(res.value.task);
  }

  /** Teammate nhả task về pending. */
  releaseTask(taskId: string, teammateId: string, now = Date.now()): TeamServiceResult<TeamTask> {
    const res = releaseTask(this.team.tasks, taskId, teammateId, now);
    if (!res.ok) return fail(res.error as string);
    this.setTasks(res.value.tasks, now);
    this.updateTeammate(teammateId, { status: 'idle', currentTaskId: undefined }, now);
    this.pushEvent('task-released', `Task "${res.value.task.title}" được nhả về pending.`, teammateId, taskId);
    return ok(res.value.task);
  }

  /** Teammate hoàn thành task. */
  completeTask(
    taskId: string,
    teammateId: string,
    resultSummary?: string,
    now = Date.now(),
  ): TeamServiceResult<TeamTask> {
    const res = completeTask(this.team.tasks, taskId, teammateId, resultSummary, now);
    if (!res.ok) return fail(res.error as string);
    this.setTasks(res.value.tasks, now);
    const mate = this.findTeammate(teammateId) as Teammate;
    this.updateTeammate(
      teammateId,
      { status: 'idle', currentTaskId: undefined, tasksDone: mate.tasksDone + 1 },
      now,
    );
    this.pushEvent('task-done', `Task "${res.value.task.title}" xong.`, teammateId, taskId);
    this.maybeCompleteTeam(now);
    return ok(res.value.task);
  }

  /** Teammate báo task lỗi (còn lượt → pending để claim lại; hết lượt → failed). */
  failTask(
    taskId: string,
    teammateId: string,
    error: string,
    now = Date.now(),
  ): TeamServiceResult<{ task: TeamTask; retryable: boolean }> {
    const res = failTask(this.team.tasks, taskId, teammateId, error, now);
    if (!res.ok) return fail(res.error as string);
    this.setTasks(res.value.tasks, now);
    const mate = this.findTeammate(teammateId) as Teammate;
    this.updateTeammate(
      teammateId,
      {
        status: res.value.retryable ? 'idle' : 'failed',
        currentTaskId: undefined,
        tasksFailed: mate.tasksFailed + 1,
      },
      now,
    );
    this.pushEvent(
      'task-failed',
      `Task "${res.value.task.title}" lỗi: ${error}${res.value.retryable ? ' (sẽ thử lại)' : ' (hết lượt thử)'}.`,
      teammateId,
      taskId,
    );
    return ok({ task: res.value.task, retryable: res.value.retryable });
  }

  /** Gửi tin nhắn mailbox. */
  sendMessage(input: SendTeamMessageInput, now = Date.now()): TeamServiceResult<import('./types').MailboxMessage> {
    const res = sendTeamMessage(this.team, input, now);
    if (!res.ok) return fail(res.error as string);
    this.team = { ...res.value.team };
    this.pushEvent('message-sent', `Tin ${res.value.message.kind} từ ${res.value.message.fromName}.`, input.fromId, input.taskId);
    return ok(res.value.message);
  }

  /** Hộp thư đến của một teammate. */
  inbox(teammateId: string): import('./types').MailboxMessage[] {
    return inboxFor(this.team.messages, teammateId);
  }

  /** Đánh dấu đã đọc một tin. */
  markRead(messageId: string, teammateId: string): TeamServiceResult<boolean> {
    const res = markMessageRead(this.team.messages, messageId, teammateId);
    if (!res.ok) return fail(res.error as string);
    this.team = { ...this.team, messages: res.value, updatedAt: Date.now() };
    return ok(true);
  }

  /** Đánh dấu đã đọc toàn bộ hộp thư đến. */
  markAllRead(teammateId: string): void {
    this.team = { ...this.team, messages: markInboxRead(this.team.messages, teammateId), updatedAt: Date.now() };
  }

  /** Question chưa được trả lời trong team. */
  unansweredQuestions(): import('./types').MailboxMessage[] {
    return unansweredQuestions(this.team);
  }

  /** Xung đột file hiện tại trong team. */
  fileConflicts(): import('./types').FileConflict[] {
    const conflicts = detectFileConflicts(this.team);
    if (conflicts.length > 0) {
      this.pushEvent(
        'conflict-detected',
        `Phát hiện ${conflicts.length} xung đột file: ${conflicts.map((c) => c.file).join(', ')}.`,
      );
    }
    return conflicts;
  }

  /**
   * Scheduler: gán task ready cho teammate rảnh.
   * Tôn trọng: team phải active, maxParallelTasks, mỗi teammate tối
   * đa 1 task, file-lock (task chạm file đang khóa bị bỏ qua lượt
   * này), dependency (chỉ task ready). Trả về danh sách đã gán.
   */
  schedule(now = Date.now()): ScheduledAssignment[] {
    if (this.team.status !== 'active') return [];
    const activeCount = this.team.tasks.filter(
      (t) => t.status === 'claimed' || t.status === 'in-progress',
    ).length;
    const parallel = canRunMoreParallel(activeCount, this.team.config.maxParallelTasks);
    if (!parallel.allowed) return [];
    const idle = this.team.teammates.filter(
      (m) => m.role === 'teammate' && m.status === 'idle' && !m.currentTaskId,
    );
    if (idle.length === 0) return [];
    const assignments: ScheduledAssignment[] = [];
    let tasks = this.team.tasks;
    let running = activeCount;
    for (const task of readyTasks(tasks)) {
      if (running >= this.team.config.maxParallelTasks) break;
      if (idle.length === 0) break;
      const mate = idle.shift() as Teammate;
      const res = claimTask(tasks, task.id, mate.id, now);
      if (!res.ok) continue;
      tasks = res.value.tasks;
      running += 1;
      this.updateTeammate(mate.id, { status: 'working', currentTaskId: task.id }, now);
      this.pushEvent('task-claimed', `Scheduler gán task "${task.title}" cho "${mate.name}".`, mate.id, task.id);
      assignments.push({ taskId: task.id, taskTitle: task.title, teammateId: mate.id, teammateName: mate.name });
    }
    this.setTasks(tasks, now);
    return assignments;
  }

  /** Thu hồi các claim treo (quá claimTimeoutMs) về pending. */
  reclaimStaleClaims(now = Date.now()): TeamTask[] {
    const stale = findStaleClaims(this.team.tasks, this.team.config.claimTimeoutMs, now);
    let tasks = this.team.tasks;
    const reclaimed: TeamTask[] = [];
    for (const task of stale) {
      const res = reclaimStaleTask(tasks, task.id, now);
      if (!res.ok) continue;
      tasks = res.value.tasks;
      reclaimed.push(res.value.task);
      if (task.claimedBy) {
        this.updateTeammate(task.claimedBy, { status: 'idle', currentTaskId: undefined }, now);
      }
      this.pushEvent('task-released', `Thu hồi claim treo của task "${task.title}".`, task.claimedBy, task.id);
    }
    this.setTasks(tasks, now);
    return reclaimed;
  }

  /** Tạm dừng team (không claim/schedule mới, task đang chạy vẫn được hoàn thành). */
  pause(now = Date.now()): TeamServiceResult<AgentTeamV109> {
    if (this.team.status !== 'active') return fail(`Team đang ở trạng thái ${this.team.status}, không pause được.`);
    this.team = { ...this.team, status: 'paused', updatedAt: now };
    this.pushEvent('paused', 'Team tạm dừng.');
    return ok(this.snapshot);
  }

  /** Tiếp tục team đã pause. */
  resume(now = Date.now()): TeamServiceResult<AgentTeamV109> {
    if (this.team.status !== 'paused') return fail(`Team đang ở trạng thái ${this.team.status}, không resume được.`);
    this.team = { ...this.team, status: 'active', updatedAt: now };
    this.pushEvent('resumed', 'Team tiếp tục.');
    return ok(this.snapshot);
  }

  /** Giải tán team (task chưa xong bị bỏ, teammate về idle). */
  dissolve(reason: string, now = Date.now()): TeamServiceResult<AgentTeamV109> {
    if (this.team.status === 'dissolved' || this.team.status === 'completed') {
      return fail(`Team đã ở trạng thái ${this.team.status}.`);
    }
    this.team = {
      ...this.team,
      status: 'dissolved',
      endReason: reason.trim() || 'Lead giải tán team.',
      updatedAt: now,
    };
    this.pushEvent('dissolved', `Team giải tán: ${this.team.endReason}`);
    return ok(this.snapshot);
  }

  /** Tóm tắt trạng thái team. */
  summary(): TeamV109Summary {
    const counts = countTasksByStatus(this.team.tasks);
    const lead = this.lead;
    return {
      id: this.team.id,
      name: this.team.name,
      goal: this.team.goal,
      status: this.team.status as AgentTeamV109Status,
      leadName: lead?.name ?? '?',
      teammateCount: this.team.teammates.length,
      idleTeammates: this.team.teammates.filter((m) => m.status === 'idle').length,
      workingTeammates: this.team.teammates.filter((m) => m.status === 'working').length,
      tasksTotal: this.team.tasks.length,
      tasksPending: counts.pending,
      tasksClaimed: counts.claimed,
      tasksInProgress: counts['in-progress'],
      tasksDone: counts.done,
      tasksFailed: counts.failed,
      tasksBlocked: counts.blocked,
      tasksReady: readyTasks(this.team.tasks).length,
      unreadMessages: teamUnreadCount(this.team),
      createdAt: this.team.createdAt,
      updatedAt: this.team.updatedAt,
    };
  }

  /** Task sẵn sàng claim (để lead/UI hiển thị). */
  readyTaskList(): TeamTask[] {
    return readyTasks(this.team.tasks);
  }

  /** Task của team mà dependency chưa done (để UI hiển thị lý do chờ). */
  waitingTasks(): { task: TeamTask; waitingOn: string[] }[] {
    return this.team.tasks
      .filter((t) => t.status === 'pending' && !isTaskReady(this.team.tasks, t))
      .map((t) => ({
        task: t,
        waitingOn: t.dependsOn.filter((d) => this.findTask(d)?.status !== 'done'),
      }));
  }

  /** Tự động completed khi: có ít nhất 1 task, mọi task done, không còn task active. */
  private maybeCompleteTeam(now = Date.now()): void {
    if (this.team.status !== 'active') return;
    if (this.team.tasks.length === 0) return;
    const counts = countTasksByStatus(this.team.tasks);
    if (counts.done === this.team.tasks.length) {
      this.team = { ...this.team, status: 'completed', endReason: 'Mọi task đã xong.', updatedAt: now };
      this.pushEvent('completed', 'Team hoàn thành: mọi task đã done.');
    }
  }

  /** Slug đọc được của team (dùng cho worktree branch). */
  get slug(): string {
    return slugOf(this.team.name);
  }

  /** Giới hạn teammate mặc định (để tool/UI hiển thị). */
  static get defaultMaxTeammates(): number {
    return DEFAULT_MAX_TEAMMATES;
  }
}
