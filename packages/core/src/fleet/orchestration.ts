/**
 * Fleet orchestration v4 (v1.05, Team T6) — điều phối nhiều bot trong
 * một fleet: lập lịch task theo affinity/load/capability, health
 * check + auto-restart, hàng đợi task ưu tiên, chia sẻ memory block
 * giữa các bot trong fleet.
 *
 * Nối tiếp fleet v3:
 * - placement theo workspace (`scheduling.ts` — bot MỚI đặt ở đâu);
 *   module này trả lời task CHẠY TRÊN BOT NÀO trong fleet đang có.
 * - job queue đa node (`dispatch.ts` — job + work stealing); module
 *   này thêm hàng đợi ƯU TIÊN + affinity + capability matching.
 * - quota tài nguyên (`quotas.ts`); module này thêm policy v4
 *   (`policy.ts`: max bot đồng thời, quota token, giới hạn restart).
 * - shared memory blocks (`memory/sharedBlocks.ts` — nhóm share
 *   block cross-agent); module này KHÔNG sửa code đó — nó bọc
 *   `SharedBlockGroupStore` thành API phía fleet (tạo nhóm theo
 *   fleet, thêm bot, publish block, resolve block cho bot).
 *
 * TRUNG THỰC: auto-restart ở đây là MOCK lifecycle — orchestrator
 * không spawn process thật; nó gọi `BotLifecycle` (mặc định là mock
 * trong bộ nhớ) để đánh dấu bot đã restart. Production lifecycle
 * (spawn service thật qua FleetServiceManager) gắn vào qua interface
 * `BotLifecycle`. Health probe cũng qua interface `BotHealthProbe`
 * (mặc định `MockBotHealthProbe` giữ map sức khỏe trong bộ nhớ để
 * test/demo; probe thật gắn sau qua cùng interface).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { SharedBlockGroupStore } from '../memory/sharedBlocks';
import type { ResolvedSharedBlock, SharedBlockGroup } from '../memory/sharedBlocks';
import type { FleetPolicyV4, FleetTaskPriority } from './policy';
import { DEFAULT_FLEET_POLICY_V4, canAutoRestartBot, validateFleetPolicyV4 } from './policy';

/** File lưu hàng đợi task durable (`<fleetRoot>/fleet-tasks-v4.json`). */
export const FLEET_TASKS_V4_FILE = 'fleet-tasks-v4.json';
/** File log quyết định lập lịch (`<fleetRoot>/fleet-scheduling-decisions.jsonl`, append-only). */
export const FLEET_SCHEDULING_DECISIONS_FILE = 'fleet-scheduling-decisions.jsonl';
/** Số quyết định giữ tối đa trong bộ nhớ (ring buffer). */
export const FLEET_MAX_DECISIONS_IN_MEMORY = 200;

/** Một quyết định điều phối (assign / requeue / restart) để audit. */
export interface FleetSchedulingDecision {
  at: number;
  kind: 'assign' | 'requeue' | 'restart';
  taskId?: string;
  taskTitle?: string;
  botId: string;
  score?: number;
  reason: string;
}

/** Sức khỏe của một bot trong fleet. */
export type FleetBotHealth = 'healthy' | 'degraded' | 'down' | 'unknown';

export const FLEET_BOT_HEALTHS: readonly FleetBotHealth[] = ['healthy', 'degraded', 'down', 'unknown'];

/** Một bot mà orchestrator điều phối (khác FleetWorkspace: đây là bot chạy task). */
export interface FleetBotNode {
  botId: string;
  name: string;
  /** Capability bot có (vd 'code', 'research', 'voice', 'composio'). */
  capabilities: string[];
  /** Tag affinity (vd 'sales', 'vn', 'night-shift') để task tìm đúng bot. */
  affinityTags: string[];
  /** Số task đang chạy trên bot. */
  runningTasks: number;
  /** Tải CPU hiện tại 0..1 (null khi chưa đo). */
  cpuLoad: number | null;
  status: FleetBotHealth;
  lastHealthAt: number | null;
  /** Số lần restart (tích lũy từ khi đăng ký). */
  restarts: number;
  /** Token đã dùng trong chu kỳ quota hiện tại. */
  tokenUsage: number;
}

/** Trạng thái task trong hàng đợi. */
export type FleetTaskStatus = 'waiting' | 'assigned' | 'running' | 'done' | 'failed' | 'cancelled';

export const FLEET_TASK_STATUSES: readonly FleetTaskStatus[] = [
  'waiting',
  'assigned',
  'running',
  'done',
  'failed',
  'cancelled',
];

/** Một task chờ điều phối trong fleet. */
export interface FleetTaskV4 {
  id: string;
  title: string;
  /** Loại task (vd 'code', 'research', 'eval-run', 'maintenance'). */
  kind: string;
  /** 1 (thấp nhất) .. 5 (cao nhất). */
  priority: FleetTaskPriority;
  /** Capability bắt buộc — bot thiếu là không đủ điều kiện (khi policy requireCapabilityMatch). */
  requiredCapabilities: string[];
  /** Gắn task vào đúng bot này khi có thể (affinity mạnh nhất). */
  affinityBotId?: string;
  /** Tag affinity — bot có tag trùng được ưu tiên. */
  affinityTags: string[];
  /** Token dự kiến task sẽ dùng (để kiểm tra quota bot). */
  tokenBudget?: number;
  submittedBy: string;
  submittedAt: number;
  status: FleetTaskStatus;
  assignedBotId?: string;
  assignedAt?: number;
  /** Lịch sử chuyển trạng thái (để audit/debug). */
  history: Array<{ at: number; note: string }>;
}

/** Kết quả probe sức khỏe một bot. */
export interface BotHealthProbeResult {
  healthy: boolean;
  /** Độ trễ probe (ms) — latency cao (> 1000ms) = degraded, không phải down. */
  latencyMs?: number;
  detail?: string;
}

/** Interface probe sức khỏe — mock mặc định, probe thật gắn sau. */
export interface BotHealthProbe {
  probe(botId: string): Promise<BotHealthProbeResult> | BotHealthProbeResult;
}

/** Interface lifecycle bot — mock mặc định, lifecycle thật gắn sau. */
export interface BotLifecycle {
  /** Restart bot (mock: chỉ đổi trạng thái; thật: spawn lại service). */
  restart(botId: string): Promise<{ restarted: boolean; detail: string }> | { restarted: boolean; detail: string };
}

/** Probe mock: giữ map sức khỏe trong bộ nhớ, test/demo chỉnh tay. */
export class MockBotHealthProbe implements BotHealthProbe {
  private readonly health = new Map<string, BotHealthProbeResult>();

  setHealth(botId: string, result: BotHealthProbeResult): void {
    this.health.set(botId, { ...result });
  }

  probe(botId: string): BotHealthProbeResult {
    return this.health.get(botId) ?? { healthy: true, latencyMs: 10, detail: 'mock probe: no override, assumed healthy.' };
  }
}

/** Lifecycle mock: restart luôn "thành công" trong bộ nhớ. */
export class MockBotLifecycle implements BotLifecycle {
  restart(botId: string): { restarted: boolean; detail: string } {
    return { restarted: true, detail: `mock restart of bot "${botId}" (no real process spawned).` };
  }
}

/** Một bot được chấm điểm cho một task. */
export interface FleetBotScore {
  botId: string;
  eligible: boolean;
  /** 0..1, cao hơn = phù hợp hơn (0 khi không đủ điều kiện). */
  score: number;
  reason: string;
}

/** Kết quả lập lịch một task. */
export interface FleetSchedulingResult {
  task: FleetTaskV4;
  botId: string;
  score: number;
  reason: string;
  assignedAt: number;
}

/** Báo cáo một vòng health check + auto-restart. */
export interface FleetHealthReport {
  at: number;
  checked: number;
  healthy: number;
  degraded: number;
  down: number;
  restarted: Array<{ botId: string; detail: string }>;
  /** Bot down nhưng không restart được (hết lượt theo policy) + lý do. */
  restartBlocked: Array<{ botId: string; reason: string }>;
}

/** Tóm tắt sức khỏe fleet để UI vẽ. */
export interface FleetHealthSummary {
  at: number;
  totalBots: number;
  byStatus: Record<FleetBotHealth, number>;
  waitingTasks: number;
  runningTasks: number;
  totalRestarts: number;
  bots: FleetBotNode[];
}

export interface FleetOrchestratorOptions {
  /** Thư mục fleet root (để lưu policy + shared groups). Không có = chỉ chạy trong bộ nhớ. */
  fleetRoot?: string;
  probe?: BotHealthProbe;
  lifecycle?: BotLifecycle;
  policy?: FleetPolicyV4;
  /** Hàm lấy thời gian (mặc định Date.now) — truyền vào để test xác định. */
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ONE_HOUR_MS = 60 * 60 * 1000;
/** Latency probe trên ngưỡng này thì bot bị đánh 'degraded'. */
export const FLEET_DEGRADED_LATENCY_MS = 1000;

function taskId(): string {
  return `ftask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Validate một task v4 đã lưu (throws khi sai) — dùng khi nạp file durable. */
export function validateFleetTaskV4(raw: unknown): FleetTaskV4 {
  if (!isRecord(raw)) throw new Error('fleet task must be an object.');
  const { id, title, kind, priority, requiredCapabilities, affinityBotId, affinityTags, tokenBudget, submittedBy, submittedAt, status, assignedBotId, assignedAt, history } = raw;
  if (typeof id !== 'string' || id.trim() === '') throw new Error('fleet task needs a non-empty id.');
  if (typeof title !== 'string' || title.trim() === '') throw new Error('fleet task needs a non-empty title.');
  if (typeof kind !== 'string' || kind.trim() === '') throw new Error('fleet task needs a non-empty kind.');
  if (![1, 2, 3, 4, 5].includes(priority as number)) throw new Error('fleet task priority must be an integer 1..5.');
  if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((c) => typeof c !== 'string')) {
    throw new Error('fleet task requiredCapabilities must be an array of strings.');
  }
  if (affinityBotId !== undefined && typeof affinityBotId !== 'string') {
    throw new Error('fleet task affinityBotId must be a string when given.');
  }
  if (!Array.isArray(affinityTags) || affinityTags.some((t) => typeof t !== 'string')) {
    throw new Error('fleet task affinityTags must be an array of strings.');
  }
  if (tokenBudget !== undefined && (typeof tokenBudget !== 'number' || !Number.isFinite(tokenBudget) || tokenBudget < 0)) {
    throw new Error('fleet task tokenBudget must be a number >= 0.');
  }
  if (typeof submittedBy !== 'string' || submittedBy.trim() === '') {
    throw new Error('fleet task needs a non-empty submittedBy.');
  }
  if (typeof submittedAt !== 'number' || !Number.isFinite(submittedAt)) {
    throw new Error('fleet task submittedAt must be a number.');
  }
  if (!FLEET_TASK_STATUSES.includes(status as FleetTaskStatus)) {
    throw new Error('fleet task status is unknown.');
  }
  if (assignedBotId !== undefined && typeof assignedBotId !== 'string') {
    throw new Error('fleet task assignedBotId must be a string when given.');
  }
  if (assignedAt !== undefined && typeof assignedAt !== 'number') {
    throw new Error('fleet task assignedAt must be a number when given.');
  }
  if (!Array.isArray(history)) throw new Error('fleet task history must be an array.');
  for (const entry of history as Array<Record<string, unknown>>) {
    if (typeof entry.at !== 'number' || typeof entry.note !== 'string') {
      throw new Error('fleet task history entries need a numeric at and a string note.');
    }
  }
  return {
    id: id.trim(),
    title: title.trim(),
    kind: kind.trim(),
    priority: priority as FleetTaskPriority,
    requiredCapabilities: [...(requiredCapabilities as string[])],
    ...(affinityBotId !== undefined ? { affinityBotId: affinityBotId as string } : {}),
    affinityTags: [...(affinityTags as string[])],
    ...(tokenBudget !== undefined ? { tokenBudget: tokenBudget as number } : {}),
    submittedBy: submittedBy.trim(),
    submittedAt: submittedAt as number,
    status: status as FleetTaskStatus,
    ...(assignedBotId !== undefined ? { assignedBotId: assignedBotId as string } : {}),
    ...(assignedAt !== undefined ? { assignedAt: assignedAt as number } : {}),
    history: (history as Array<{ at: number; note: string }>).map((h) => ({ at: h.at, note: h.note })),
  };
}

function validateBotNode(raw: unknown): FleetBotNode {
  if (!isRecord(raw)) throw new Error('fleet bot node must be an object.');
  const { botId, name, capabilities, affinityTags, runningTasks, cpuLoad, status, lastHealthAt, restarts, tokenUsage } = raw;
  if (typeof botId !== 'string' || botId.trim() === '') throw new Error('fleet bot needs a non-empty botId.');
  if (typeof name !== 'string' || name.trim() === '') throw new Error('fleet bot needs a non-empty name.');
  if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== 'string')) {
    throw new Error('fleet bot capabilities must be an array of strings.');
  }
  if (!Array.isArray(affinityTags) || affinityTags.some((t) => typeof t !== 'string')) {
    throw new Error('fleet bot affinityTags must be an array of strings.');
  }
  if (typeof runningTasks !== 'number' || !Number.isInteger(runningTasks) || runningTasks < 0) {
    throw new Error('fleet bot runningTasks must be an integer >= 0.');
  }
  if (cpuLoad !== null && (typeof cpuLoad !== 'number' || !Number.isFinite(cpuLoad) || cpuLoad < 0 || cpuLoad > 1)) {
    throw new Error('fleet bot cpuLoad must be null or a number in [0, 1].');
  }
  if (!FLEET_BOT_HEALTHS.includes(status as FleetBotHealth)) {
    throw new Error('fleet bot status must be healthy, degraded, down or unknown.');
  }
  if (lastHealthAt !== null && typeof lastHealthAt !== 'number') {
    throw new Error('fleet bot lastHealthAt must be a number or null.');
  }
  if (typeof restarts !== 'number' || !Number.isInteger(restarts) || restarts < 0) {
    throw new Error('fleet bot restarts must be an integer >= 0.');
  }
  if (typeof tokenUsage !== 'number' || !Number.isFinite(tokenUsage) || tokenUsage < 0) {
    throw new Error('fleet bot tokenUsage must be a number >= 0.');
  }
  return {
    botId: botId.trim(),
    name: name.trim(),
    capabilities: [...(capabilities as string[])],
    affinityTags: [...(affinityTags as string[])],
    runningTasks: runningTasks as number,
    cpuLoad: cpuLoad as number | null,
    status: status as FleetBotHealth,
    lastHealthAt: lastHealthAt as number | null,
    restarts: restarts as number,
    tokenUsage: tokenUsage as number,
  };
}

export interface SubmitFleetTaskInput {
  title: string;
  kind?: string;
  priority?: FleetTaskPriority;
  requiredCapabilities?: string[];
  affinityBotId?: string;
  affinityTags?: string[];
  tokenBudget?: number;
  submittedBy: string;
}

/**
 * Orchestrator v4: giữ registry bot + hàng đợi task ưu tiên trong bộ
 * nhớ, chấm điểm bot cho task, health check + auto-restart (mock
 * lifecycle), và API chia sẻ memory block qua SharedBlockGroupStore.
 */
export class FleetOrchestrator {
  private readonly fleetRoot: string | undefined;
  private readonly probe: BotHealthProbe;
  private readonly lifecycle: BotLifecycle;
  private policy: FleetPolicyV4;
  private readonly now: () => number;
  private readonly bots = new Map<string, FleetBotNode>();
  private readonly tasks: FleetTaskV4[] = [];
  /** Lịch sử restart theo bot (epoch ms) — để đếm số lần trong giờ qua. */
  private readonly restartLog = new Map<string, number[]>();
  /** Ring buffer quyết định điều phối (mới nhất ở cuối). */
  private readonly decisions: FleetSchedulingDecision[] = [];
  private sharedGroups: SharedBlockGroupStore | null = null;

  constructor(opts: FleetOrchestratorOptions = {}) {
    this.fleetRoot = opts.fleetRoot;
    this.probe = opts.probe ?? new MockBotHealthProbe();
    this.lifecycle = opts.lifecycle ?? new MockBotLifecycle();
    this.policy = validateFleetPolicyV4(opts.policy ?? DEFAULT_FLEET_POLICY_V4);
    this.now = opts.now ?? Date.now;
  }

  // --- Policy ---

  getPolicy(): FleetPolicyV4 {
    return { ...this.policy };
  }

  setPolicy(policy: FleetPolicyV4): FleetPolicyV4 {
    this.policy = validateFleetPolicyV4(policy);
    return { ...this.policy };
  }

  // --- Bot registry ---

  registerBot(node: FleetBotNode): FleetBotNode {
    const valid = validateBotNode(node);
    this.bots.set(valid.botId, { ...valid });
    return { ...valid };
  }

  removeBot(botId: string): boolean {
    return this.bots.delete(botId);
  }

  getBot(botId: string): FleetBotNode | null {
    const found = this.bots.get(botId);
    return found ? { ...found } : null;
  }

  listBots(): FleetBotNode[] {
    return [...this.bots.values()].map((b) => ({ ...b }));
  }

  /** Cập nhật tải / token usage của bot (đo từ bên ngoài đưa vào). */
  updateBotLoad(botId: string, patch: { runningTasks?: number; cpuLoad?: number | null; tokenUsage?: number }): FleetBotNode {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`fleet bot not found: ${botId}`);
    if (patch.runningTasks !== undefined) {
      if (!Number.isInteger(patch.runningTasks) || patch.runningTasks < 0) {
        throw new Error('runningTasks must be an integer >= 0.');
      }
      bot.runningTasks = patch.runningTasks;
    }
    if (patch.cpuLoad !== undefined) {
      if (patch.cpuLoad !== null && (patch.cpuLoad < 0 || patch.cpuLoad > 1)) {
        throw new Error('cpuLoad must be null or in [0, 1].');
      }
      bot.cpuLoad = patch.cpuLoad;
    }
    if (patch.tokenUsage !== undefined) {
      if (!Number.isFinite(patch.tokenUsage) || patch.tokenUsage < 0) {
        throw new Error('tokenUsage must be a number >= 0.');
      }
      bot.tokenUsage = patch.tokenUsage;
    }
    return { ...bot };
  }

  // --- Task queue (ưu tiên) ---

  submitTask(input: SubmitFleetTaskInput): FleetTaskV4 {
    if (!isRecord(input)) throw new Error('fleet task input must be an object.');
    if (typeof input.title !== 'string' || input.title.trim() === '') {
      throw new Error('fleet task needs a non-empty title.');
    }
    if (typeof input.submittedBy !== 'string' || input.submittedBy.trim() === '') {
      throw new Error('fleet task needs a non-empty submittedBy.');
    }
    if (input.priority !== undefined && ![1, 2, 3, 4, 5].includes(input.priority)) {
      throw new Error('fleet task priority must be an integer 1..5.');
    }
    if (input.tokenBudget !== undefined && (typeof input.tokenBudget !== 'number' || !Number.isFinite(input.tokenBudget) || input.tokenBudget < 0)) {
      throw new Error('fleet task tokenBudget must be a number >= 0.');
    }
    const now = this.now();
    const task: FleetTaskV4 = {
      id: taskId(),
      title: input.title.trim(),
      kind: typeof input.kind === 'string' && input.kind.trim() !== '' ? input.kind.trim() : 'general',
      priority: input.priority ?? this.policy.defaultPriority,
      requiredCapabilities: [...(input.requiredCapabilities ?? [])],
      ...(input.affinityBotId ? { affinityBotId: input.affinityBotId } : {}),
      affinityTags: [...(input.affinityTags ?? [])],
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      submittedBy: input.submittedBy.trim(),
      submittedAt: now,
      status: 'waiting',
      history: [{ at: now, note: 'submitted to the fleet queue.' }],
    };
    this.tasks.push(task);
    return { ...task, history: [...task.history] };
  }

  getTask(id: string): FleetTaskV4 | null {
    const found = this.tasks.find((t) => t.id === id);
    return found ? { ...found, history: [...found.history] } : null;
  }

  /** Hàng đợi chờ, xếp theo ưu tiên cao trước, cùng ưu tiên thì nộp trước được trước. */
  listWaitingTasks(): FleetTaskV4[] {
    return this.tasks
      .filter((t) => t.status === 'waiting')
      .sort((a, b) => b.priority - a.priority || a.submittedAt - b.submittedAt)
      .map((t) => ({ ...t, history: [...t.history] }));
  }

  listTasks(status?: FleetTaskStatus): FleetTaskV4[] {
    const pool = status ? this.tasks.filter((t) => t.status === status) : this.tasks;
    return pool.map((t) => ({ ...t, history: [...t.history] }));
  }

  cancelTask(id: string, reason?: string): FleetTaskV4 {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`fleet task not found: ${id}`);
    if (task.status === 'done' || task.status === 'failed') {
      throw new Error(`fleet task "${id}" is ${task.status} and cannot be cancelled.`);
    }
    task.status = 'cancelled';
    task.history.push({ at: this.now(), note: reason ? `cancelled: ${reason}` : 'cancelled.' });
    return { ...task, history: [...task.history] };
  }

  markTaskDone(id: string, note?: string): FleetTaskV4 {
    return this.transitionTask(id, 'done', note ?? 'completed.');
  }

  markTaskFailed(id: string, note?: string): FleetTaskV4 {
    return this.transitionTask(id, 'failed', note ?? 'failed.');
  }

  private transitionTask(id: string, status: FleetTaskStatus, note: string): FleetTaskV4 {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`fleet task not found: ${id}`);
    task.status = status;
    task.history.push({ at: this.now(), note });
    if (status === 'done' || status === 'failed') {
      const bot = task.assignedBotId ? this.bots.get(task.assignedBotId) : undefined;
      if (bot && bot.runningTasks > 0) bot.runningTasks -= 1;
    }
    return { ...task, history: [...task.history] };
  }

  // --- Scheduling ---

  /**
   * Chấm điểm một bot cho một task.
   *
   * Không đủ điều kiện khi: bot down/unknown; thiếu capability bắt
   * buộc (khi policy requireCapabilityMatch); bot đã đầy task
   * (maxTasksPerBot); task vượt quota token còn lại của bot.
   * Điểm (0..1): affinityBotId khớp +0.5, tag affinity trùng +0.3
   * tối đa, còn trống task +0.2 tối đa, CPU rảnh cộng thêm tới 0.1
   * (chuẩn hóa về 0..1). Bot thiếu capability nhưng policy không
   * chặn thì bị trừ một nửa điểm.
   */
  scoreBotForTask(bot: FleetBotNode, task: FleetTaskV4): FleetBotScore {
    const base = { botId: bot.botId, score: 0, reason: '' };
    if (bot.status === 'down' || bot.status === 'unknown') {
      return { ...base, eligible: false, reason: `bot "${bot.name}" is ${bot.status}.` };
    }
    const missing = task.requiredCapabilities.filter((c) => !bot.capabilities.includes(c));
    if (missing.length > 0 && this.policy.requireCapabilityMatch) {
      return { ...base, eligible: false, reason: `bot "${bot.name}" lacks capabilities: ${missing.join(', ')}.` };
    }
    if (this.policy.maxTasksPerBot > 0 && bot.runningTasks >= this.policy.maxTasksPerBot) {
      return { ...base, eligible: false, reason: `bot "${bot.name}" already runs ${bot.runningTasks} tasks (limit ${this.policy.maxTasksPerBot}).` };
    }
    if (
      this.policy.perBotTokenQuota > 0 &&
      task.tokenBudget !== undefined &&
      bot.tokenUsage + task.tokenBudget > this.policy.perBotTokenQuota
    ) {
      return {
        ...base,
        eligible: false,
        reason: `bot "${bot.name}" would exceed its token quota (${bot.tokenUsage} used + ${task.tokenBudget} budgeted > ${this.policy.perBotTokenQuota}).`,
      };
    }
    let score = 0;
    const reasons: string[] = [];
    if (task.affinityBotId === bot.botId) {
      score += 0.5;
      reasons.push('affinity bot match');
    }
    if (task.affinityTags.length > 0) {
      const overlap = task.affinityTags.filter((t) => bot.affinityTags.includes(t)).length;
      score += 0.3 * (overlap / task.affinityTags.length);
      if (overlap > 0) reasons.push(`${overlap}/${task.affinityTags.length} affinity tags match`);
    }
    const freeTaskSlots =
      this.policy.maxTasksPerBot > 0
        ? (this.policy.maxTasksPerBot - bot.runningTasks) / this.policy.maxTasksPerBot
        : 1;
    score += 0.2 * freeTaskSlots;
    if (bot.cpuLoad !== null) score += 0.1 * (1 - bot.cpuLoad);
    if (missing.length > 0) {
      score *= 0.5;
      reasons.push(`lacks capabilities: ${missing.join(', ')} (policy allows anyway)`);
    }
    if (bot.status === 'degraded') {
      score *= 0.8;
      reasons.push('bot is degraded');
    }
    return {
      ...base,
      eligible: true,
      score: Math.min(1, Math.max(0, score)),
      reason: reasons.length > 0 ? reasons.join('; ') : 'available.',
    };
  }

  /**
   * Lập lịch task chờ có ưu tiên cao nhất: chọn bot đủ điều kiện có
   * điểm cao nhất, gắn task vào bot (tăng runningTasks), trả về kết
   * quả. Null khi không còn task chờ, hoặc không bot nào đủ điều
   * kiện cho task đầu hàng đợi (task ở lại hàng đợi).
   */
  scheduleNext(): FleetSchedulingResult | null {
    const waiting = this.listWaitingTasks();
    if (waiting.length === 0) return null;
    const task = this.tasks.find((t) => t.id === waiting[0].id);
    if (!task) return null;
    const scored = [...this.bots.values()]
      .map((bot) => this.scoreBotForTask(bot, task))
      .filter((s) => s.eligible)
      .sort((a, b) => b.score - a.score || a.botId.localeCompare(b.botId));
    if (scored.length === 0) return null;
    const best = scored[0];
    const bot = this.bots.get(best.botId);
    if (!bot) return null;
    const now = this.now();
    task.status = 'assigned';
    task.assignedBotId = bot.botId;
    task.assignedAt = now;
    task.history.push({ at: now, note: `assigned to bot "${bot.name}" (score ${best.score.toFixed(2)}).` });
    bot.runningTasks += 1;
    this.recordSchedulingDecision({
      at: now,
      kind: 'assign',
      taskId: task.id,
      taskTitle: task.title,
      botId: bot.botId,
      score: best.score,
      reason: best.reason,
    });
    return { task: { ...task, history: [...task.history] }, botId: bot.botId, score: best.score, reason: best.reason, assignedAt: now };
  }

  /**
   * Lập lịch hàng loạt: gọi `scheduleNext()` lặp lại cho tới khi hết
   * task chờ hoặc task đầu hàng đợi không còn bot đủ điều kiện. Trả
   * về mọi assignment đã làm + số task còn chờ.
   */
  scheduleAll(): { scheduled: FleetSchedulingResult[]; stillWaiting: number } {
    const scheduled: FleetSchedulingResult[] = [];
    for (;;) {
      const next = this.scheduleNext();
      if (!next) break;
      scheduled.push(next);
    }
    return { scheduled, stillWaiting: this.listWaitingTasks().length };
  }

  /**
   * Cân bằng lại khi một bot chết: các task đang assigned/running
   * trên bot đó được đưa về 'waiting' (giữ nguyên ưu tiên + lịch
   * sử) để vòng lập lịch sau giao cho bot khác. Task đã done/failed
   * không động vào. Trả về số task được đưa về hàng đợi.
   */
  rebalanceAfterBotDown(botId: string): number {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`fleet bot not found: ${botId}`);
    const now = this.now();
    let moved = 0;
    for (const task of this.tasks) {
      if (task.assignedBotId !== botId) continue;
      if (task.status !== 'assigned' && task.status !== 'running') continue;
      task.status = 'waiting';
      task.assignedBotId = undefined;
      task.assignedAt = undefined;
      task.history.push({ at: now, note: `re-queued: bot "${bot.name}" is down.` });
      this.recordSchedulingDecision({
        at: now,
        kind: 'requeue',
        taskId: task.id,
        taskTitle: task.title,
        botId,
        reason: `bot "${bot.name}" is down.`,
      });
      moved += 1;
    }
    if (bot.runningTasks > 0) bot.runningTasks = 0;
    return moved;
  }

  // --- Durable task queue ---
  //
  // Hàng đợi task có thể lưu xuống `<fleetRoot>/fleet-tasks-v4.json`
  // (atomic tmp + rename, mode 0600) để restart process không mất
  // task chờ. Bot registry KHÔNG lưu file (bot là trạng thái sống,
  // đăng ký lại mỗi lần khởi động); chỉ task + restart log được lưu.

  getTasksFilePath(): string {
    if (!this.fleetRoot) {
      throw new Error('durable task queue needs a fleetRoot (orchestrator was created without one).');
    }
    return path.join(this.fleetRoot, FLEET_TASKS_V4_FILE);
  }

  saveTasks(): number {
    const filePath = this.getTasksFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.tasks, null, 2)}\n`, 'utf8');
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // chmod is best-effort on platforms without POSIX modes.
    }
    fs.renameSync(tmp, filePath);
    return this.tasks.length;
  }

  /** Nạp task từ file (file thiếu = không có task nào; file hỏng = throw). */
  loadTasks(): number {
    const filePath = this.getTasksFilePath();
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${FLEET_TASKS_V4_FILE} is corrupt: not valid JSON.`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${FLEET_TASKS_V4_FILE} is corrupt: expected an array.`);
    const loaded = parsed.map((entry, i) => {
      try {
        return validateFleetTaskV4(entry);
      } catch (err) {
        throw new Error(`${FLEET_TASKS_V4_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
      }
    });
    this.tasks.splice(0, this.tasks.length, ...loaded);
    return loaded.length;
  }

  // --- Health check + auto-restart ---

  /** Số lần restart của bot trong giờ qua (từ restart log). */
  restartsLastHour(botId: string, now: number = this.now()): number {
    const log = this.restartLog.get(botId) ?? [];
    const cutoff = now - ONE_HOUR_MS;
    return log.filter((at) => at >= cutoff).length;
  }

  /** Restart một bot qua lifecycle (mock mặc định): tăng restarts, đánh healthy. */
  async restartBot(botId: string, reason = 'auto-restart after failed health check'): Promise<{ restarted: boolean; detail: string }> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`fleet bot not found: ${botId}`);
    const now = this.now();
    if (!canAutoRestartBot(this.policy, this.restartsLastHour(botId, now))) {
      return {
        restarted: false,
        detail: `bot "${bot.name}" hit the auto-restart limit (${this.policy.maxRestartsPerHour}/hour).`,
      };
    }
    const result = await this.lifecycle.restart(botId);
    if (!result.restarted) return result;
    bot.restarts += 1;
    bot.status = 'healthy';
    bot.lastHealthAt = now;
    bot.runningTasks = 0;
    const log = this.restartLog.get(botId) ?? [];
    log.push(now);
    this.restartLog.set(botId, log);
    this.recordSchedulingDecision({
      at: now,
      kind: 'restart',
      botId,
      reason,
    });
    return { restarted: true, detail: `${result.detail} Reason: ${reason}` };
  }

  /**
   * Một vòng health check: probe từng bot, cập nhật status
   * (healthy / degraded khi latency cao / down khi probe fail), rồi
   * auto-restart bot down khi policy còn cho phép. Bot down nhưng
   * hết lượt restart được liệt kê ở `restartBlocked`, không tự ý
   * restart vượt giới hạn.
   */
  async runHealthCheck(): Promise<FleetHealthReport> {
    const now = this.now();
    const report: FleetHealthReport = {
      at: now,
      checked: 0,
      healthy: 0,
      degraded: 0,
      down: 0,
      restarted: [],
      restartBlocked: [],
    };
    for (const bot of this.bots.values()) {
      report.checked += 1;
      let result: BotHealthProbeResult;
      try {
        result = await this.probe.probe(bot.botId);
      } catch (err) {
        result = { healthy: false, detail: (err as Error).message };
      }
      bot.lastHealthAt = now;
      if (!result.healthy) {
        bot.status = 'down';
        report.down += 1;
      } else if (result.latencyMs !== undefined && result.latencyMs > FLEET_DEGRADED_LATENCY_MS) {
        bot.status = 'degraded';
        report.degraded += 1;
      } else {
        bot.status = 'healthy';
        report.healthy += 1;
      }
      if (bot.status === 'down') {
        const restarted = await this.restartBot(bot.botId);
        if (restarted.restarted) {
          report.restarted.push({ botId: bot.botId, detail: restarted.detail });
          report.down -= 1;
          report.healthy += 1;
        } else {
          report.restartBlocked.push({ botId: bot.botId, reason: restarted.detail });
        }
      }
    }
    return report;
  }

  /**
   * Ghi một quyết định điều phối: luôn vào ring buffer trong bộ nhớ,
   * và append vào file jsonl khi orchestrator có fleetRoot (để audit
   * sau khi restart process). Không có fleetRoot thì chỉ giữ trong
   * bộ nhớ — không throw, vì lập lịch vẫn phải chạy được.
   */
  recordSchedulingDecision(decision: FleetSchedulingDecision): FleetSchedulingDecision {
    const entry = { ...decision };
    this.decisions.push(entry);
    if (this.decisions.length > FLEET_MAX_DECISIONS_IN_MEMORY) {
      this.decisions.splice(0, this.decisions.length - FLEET_MAX_DECISIONS_IN_MEMORY);
    }
    if (this.fleetRoot) {
      try {
        const filePath = path.join(this.fleetRoot, FLEET_SCHEDULING_DECISIONS_FILE);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, `${JSON.stringify(entry)}
`, 'utf8');
      } catch {
        // Ghi log audit thất bại không được chặn lập lịch.
      }
    }
    return { ...entry };
  }

  /** Các quyết định gần nhất (mới nhất ở cuối; giới hạn `limit` nếu có). */
  listSchedulingDecisions(limit?: number): FleetSchedulingDecision[] {
    const all = this.decisions.map((d) => ({ ...d }));
    if (limit === undefined) return all;
    if (!Number.isInteger(limit) || limit < 0) throw new Error('listSchedulingDecisions limit must be an integer >= 0.');
    return all.slice(all.length - limit);
  }

  getHealthSummary(): FleetHealthSummary {
    const bots = this.listBots();
    const byStatus: Record<FleetBotHealth, number> = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
    for (const bot of bots) byStatus[bot.status] += 1;
    return {
      at: this.now(),
      totalBots: bots.length,
      byStatus,
      waitingTasks: this.tasks.filter((t) => t.status === 'waiting').length,
      runningTasks: this.tasks.filter((t) => t.status === 'assigned' || t.status === 'running').length,
      totalRestarts: bots.reduce((sum, b) => sum + b.restarts, 0),
      bots,
    };
  }

  // --- Shared memory giữa các bot trong fleet ---
  //
  // Bọc SharedBlockGroupStore (memory v4): nhóm share block theo
  // fleet, bot vào nhóm thì thấy mọi block của nhóm, bot rời nhóm
  // thì mất block của nhóm đó. Nội dung block vẫn sống trong
  // MemoryBlockStore — orchestrator chỉ quản lý quan hệ nhóm ↔ bot
  // ↔ block, không nhân bản nội dung.

  private groupsStore(): SharedBlockGroupStore {
    if (!this.fleetRoot) {
      throw new Error('fleet shared memory needs a fleetRoot (orchestrator was created without one).');
    }
    if (!this.sharedGroups) this.sharedGroups = new SharedBlockGroupStore(this.fleetRoot);
    return this.sharedGroups;
  }

  createSharedGroup(name: string, description = '', createdByBotId = ''): SharedBlockGroup {
    return this.groupsStore().createGroup({ name, description, createdByBotId });
  }

  listSharedGroups(): SharedBlockGroup[] {
    return this.groupsStore().listGroups();
  }

  addBotToSharedGroup(groupIdOrName: string, botId: string, role: 'read' | 'write' = 'read'): SharedBlockGroup {
    if (!this.bots.has(botId)) throw new Error(`fleet bot not found: ${botId}`);
    return this.groupsStore().addMember(groupIdOrName, botId, role);
  }

  removeBotFromSharedGroup(groupIdOrName: string, botId: string): SharedBlockGroup {
    return this.groupsStore().removeMember(groupIdOrName, botId);
  }

  publishBlockToSharedGroup(groupIdOrName: string, blockId: string): SharedBlockGroup {
    return this.groupsStore().attachBlockToGroup(groupIdOrName, blockId);
  }

  unpublishBlockFromSharedGroup(groupIdOrName: string, blockId: string): SharedBlockGroup {
    return this.groupsStore().detachBlockFromGroup(groupIdOrName, blockId);
  }

  /** Mọi block một bot thấy được (trực tiếp + qua nhóm), kèm nguồn nhóm. */
  sharedBlocksForBot(botId: string): ResolvedSharedBlock[] {
    return this.groupsStore().resolveBlocksForBot(botId);
  }

  /** Báo cáo lệch (drift) của một nhóm share: ai chưa đủ block, block nào đã mất. */
  sharedGroupSyncReport(groupIdOrName: string): ReturnType<SharedBlockGroupStore['groupSyncReport']> {
    return this.groupsStore().groupSyncReport(groupIdOrName);
  }
}
