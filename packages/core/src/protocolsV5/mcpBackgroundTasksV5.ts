/**
 * Background MCP tasks, Claude Agent SDK style (v1.29, Team T2).
 *
 * Idea only, learned from the public description of Claude Agent
 * SDK 0.3.319 (see docs/repo-survey-v129.md): with background tasks
 * enabled and streaming input, an MCP task runs in the background —
 * the caller gets a task id back immediately instead of holding the
 * call open, the `tool_result` it receives first is a placeholder,
 * and the real result arrives later as a system message
 * `task_notification` (task_type `"mcp_task"`). A long-running MCP
 * call must never block the agent turn.
 *
 * This module is the open-bot implementation of that behaviour,
 * built on top of the existing `mcp/tasks.ts` TaskHandle world
 * without touching it:
 *   - `BackgroundMcpTaskManager` owns tasks keyed by task id.
 *   - `submit()` starts the work (an injected `run` function —
 *     the host wires the real MCP `tools/call` behind it) and
 *     returns a placeholder `tool_result` immediately.
 *   - `task_notification` events are delivered to listeners the
 *     host registers (the agent loop turns them into system
 *     messages); listeners added after completion still get the
 *     terminal notification once (replay), so a late subscriber
 *     never misses a result.
 *   - Statuses: `pending` | `running` | `done` | `failed` |
 *     `cancelled` — the SDK-style surface the agent turn reads.
 *     (The wire `mcp/tasks.ts` statuses `working` /
 *     `input_required` / `completed` map onto these via
 *     `mapMcpTaskStatusV5`.)
 *   - Timeout cancels the work (AbortSignal) and marks the task
 *     `failed` with code `timeout`; `cancel()` marks it
 *     `cancelled`. Cancelling a finished task is a no-op that
 *     reports `false`.
 *   - Opt-in via env `OPENBOT_MCP_BACKGROUND_TASKS=1` (default
 *     off, like the SDK's `CLAUDE_AUTO_BACKGROUND_TASKS=1`):
 *     when off, `submitBackgroundOrDirect()` runs the work inline
 *     and returns the real result — same shape, no placeholder.
 *
 * No network, no model: the `run` function is injected by the
 * caller, the clock/sleep are injectable so tests run fast and
 * deterministically. Nothing here copies code, text or assets
 * from any other repo.
 */

/** Env var that opts the host into background MCP tasks. */
export const MCP_BACKGROUND_TASKS_ENV_VAR = 'OPENBOT_MCP_BACKGROUND_TASKS';
/** SDK-style env var name this mirrors (for docs / migration). */
export const MCP_BACKGROUND_TASKS_SDK_ENV_VAR = 'CLAUDE_AUTO_BACKGROUND_TASKS';
/** Default timeout for one background MCP task (10 minutes). */
export const MCP_BG_TASK_DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Default poll interval a UI/loop uses when it polls instead of listening. */
export const MCP_BG_TASK_DEFAULT_POLL_INTERVAL_MS = 500;
/** Placeholder `tool_result` text returned while a task runs. */
export const MCP_BG_TASK_PLACEHOLDER_PREFIX = 'Background MCP task started';

/** Agent-turn-visible status of a background MCP task. */
export type McpBgTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
/** Terminal statuses — no further notification follows. */
export const MCP_BG_TASK_TERMINAL_STATUSES: readonly McpBgTaskStatus[] = [
  'done',
  'failed',
  'cancelled',
];
export function isMcpBgTaskTerminal(status: McpBgTaskStatus): boolean {
  return (MCP_BG_TASK_TERMINAL_STATUSES as readonly McpBgTaskStatus[]).includes(status);
}

/** Wire statuses from `mcp/tasks.ts` (SEP-1686 / 2026-07-28). */
export type McpWireTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/**
 * Map a wire task status onto the agent-turn status. `working` /
 * `input_required` are both still running from the turn's point of
 * view; `input_required` is surfaced separately in the task record
 * (`needsInput: true`) so the turn can ask the user instead of
 * treating it as finished.
 */
export function mapMcpTaskStatusV5(wire: McpWireTaskStatus): McpBgTaskStatus {
  switch (wire) {
    case 'working':
    case 'input_required':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

/** Error raised by background-task operations. */
export class McpBackgroundTaskError extends Error {
  readonly code: 'timeout' | 'cancelled' | 'not-found' | 'duplicate' | 'disabled';
  readonly taskId?: string;
  constructor(message: string, code: McpBackgroundTaskError['code'], taskId?: string) {
    super(message);
    this.name = 'McpBackgroundTaskError';
    this.code = code;
    if (taskId) this.taskId = taskId;
  }
}

/** The placeholder `tool_result` returned immediately by `submit()`. */
export interface McpBgTaskPlaceholder {
  /** Always the literal string `task_placeholder` — the turn knows to wait. */
  kind: 'task_placeholder';
  taskId: string;
  serverName: string;
  toolName: string;
  status: McpBgTaskStatus;
  /** Text the model sees in the tool_result while the task runs. */
  text: string;
  /** How often (ms) a poller should ask for the status. */
  pollIntervalMs: number;
}

export function buildMcpBgTaskPlaceholder(
  taskId: string,
  serverName: string,
  toolName: string,
  pollIntervalMs: number = MCP_BG_TASK_DEFAULT_POLL_INTERVAL_MS,
): McpBgTaskPlaceholder {
  return {
    kind: 'task_placeholder',
    taskId,
    serverName,
    toolName,
    status: 'running',
    text:
      `${MCP_BG_TASK_PLACEHOLDER_PREFIX}: ${taskId} (${serverName}/${toolName}). ` +
      `The result will arrive as a task_notification; do not call the tool again.`,
    pollIntervalMs,
  };
}

/**
 * A `task_notification` system message — the shape the agent loop
 * receives when a background task changes state. `task_type` is
 * always `"mcp_task"` (SDK convention); `isTerminal` tells the loop
 * whether to stop waiting for this task.
 */
export interface McpTaskNotification {
  type: 'task_notification';
  task_type: 'mcp_task';
  taskId: string;
  serverName: string;
  toolName: string;
  status: McpBgTaskStatus;
  isTerminal: boolean;
  /** Set on `done`: the real tool result (JSON-able). */
  result?: unknown;
  /** Set on `failed`: machine-readable code + human message. */
  error?: { code: string; message: string };
  /** Elapsed wall time (ms) from submit to this notification. */
  elapsedMs: number;
  /** Monotonic sequence number per manager (orders notifications). */
  sequence: number;
}

export type McpTaskNotificationListener = (notification: McpTaskNotification) => void;

/** One background task, as the agent turn / UI reads it. */
export interface McpBgTaskRecord {
  taskId: string;
  serverName: string;
  toolName: string;
  /** Arguments the tool was called with (JSON-able). */
  args: Record<string, unknown>;
  status: McpBgTaskStatus;
  /** True when the wire task is waiting for more input. */
  needsInput: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Timeout configured for this task (ms). */
  timeoutMs: number;
  /** The real result once `done` (undefined before that). */
  result?: unknown;
  /** Error detail once `failed` (undefined otherwise). */
  error?: { code: string; message: string };
  /** Number of notifications emitted for this task so far. */
  notificationCount: number;
}

export interface McpBgTaskSubmitOptions {
  serverName: string;
  toolName: string;
  args?: Record<string, unknown>;
  /** Timeout for the whole task (default 10 minutes). */
  timeoutMs?: number;
  /** Poll interval advertised in the placeholder (default 500ms). */
  pollIntervalMs?: number;
  /** Caller-supplied id (tests / idempotent resubmit); generated when omitted. */
  taskId?: string;
  /**
   * The work itself: called with an AbortSignal that fires on
   * timeout / cancel. Must resolve with the real tool result.
   */
  run: (signal: AbortSignal) => Promise<unknown>;
  /** Clock override (tests). Defaults to Date.now. */
  now?: () => number;
}

/** Options for the manager itself. */
export interface BackgroundMcpTaskManagerOptions {
  /** Default timeout for tasks (ms). */
  defaultTimeoutMs?: number;
  /** Clock override (tests). */
  now?: () => number;
  /** Id generator override (tests). */
  generateId?: () => string;
  /** Timer override (tests can drive time manually). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

let bgTaskCounter = 0;
function defaultGenerateBgTaskId(): string {
  bgTaskCounter += 1;
  return `mcp-bg-${Date.now().toString(36)}-${bgTaskCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Owns background MCP tasks for one host. One manager per agent
 * session is the expected shape; the manager is deliberately
 * transport-free — the host injects `run` per task, so the same
 * manager works behind stdio, Streamable HTTP, or a test double.
 */
export class BackgroundMcpTaskManager {
  private readonly tasks = new Map<string, McpBgTaskRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly timeouts = new Map<string, unknown>();
  private readonly listeners = new Set<McpTaskNotificationListener>();
  private readonly terminalNotifications = new Map<string, McpTaskNotification>();
  private sequence = 0;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(options: BackgroundMcpTaskManagerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? MCP_BG_TASK_DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? defaultGenerateBgTaskId;
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h as never));
  }

  /** Number of tasks currently tracked (any status). */
  get size(): number {
    return this.tasks.size;
  }

  /** Number of tasks still running (pending or running). */
  get activeCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (!isMcpBgTaskTerminal(t.status)) n += 1;
    return n;
  }

  /**
   * Subscribe to `task_notification`s. Returns an unsubscribe
   * function. A listener added after a task finished still gets
   * that task's terminal notification once (replay), in
   * submission order — a late agent turn never misses a result.
   */
  onNotification(listener: McpTaskNotificationListener): () => void {
    this.listeners.add(listener);
    for (const n of this.terminalNotifications.values()) listener(n);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(task: McpBgTaskRecord): void {
    this.sequence += 1;
    const notification: McpTaskNotification = {
      type: 'task_notification',
      task_type: 'mcp_task',
      taskId: task.taskId,
      serverName: task.serverName,
      toolName: task.toolName,
      status: task.status,
      isTerminal: isMcpBgTaskTerminal(task.status),
      result: task.status === 'done' ? task.result : undefined,
      error: task.error,
      elapsedMs: (task.finishedAt ?? this.now()) - task.createdAt,
      sequence: this.sequence,
    };
    task.notificationCount += 1;
    if (notification.isTerminal) this.terminalNotifications.set(task.taskId, notification);
    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch {
        // One bad listener must never break the task or the others.
      }
    }
  }

  /**
   * Submit work to run in the background. Returns the placeholder
   * `tool_result` immediately — the caller must NOT await the
   * work. Throws `duplicate` when `taskId` is already tracked.
   */
  submit(options: McpBgTaskSubmitOptions): McpBgTaskPlaceholder {
    const taskId = options.taskId ?? this.generateId();
    if (this.tasks.has(taskId)) {
      throw new McpBackgroundTaskError(
        `Background MCP task "${taskId}" already exists.`,
        'duplicate',
        taskId,
      );
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new McpBackgroundTaskError(
        `timeoutMs must be a positive number, got ${timeoutMs}.`,
        'timeout',
        taskId,
      );
    }
    const createdAt = options.now?.() ?? this.now();
    const controller = new AbortController();
    const record: McpBgTaskRecord = {
      taskId,
      serverName: options.serverName,
      toolName: options.toolName,
      args: options.args ?? {},
      status: 'pending',
      needsInput: false,
      createdAt,
      startedAt: null,
      finishedAt: null,
      timeoutMs,
      notificationCount: 0,
    };
    this.tasks.set(taskId, record);
    this.controllers.set(taskId, controller);
    const handle = this.setTimeoutFn(() => this.failWithTimeout(taskId), timeoutMs);
    this.timeouts.set(taskId, handle);

    // Start the work on the next microtask so submit() returns the
    // placeholder before any result can arrive.
    record.status = 'running';
    record.startedAt = createdAt;
    void Promise.resolve()
      .then(() => options.run(controller.signal))
      .then((result) => this.finish(taskId, result))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return; // timeout/cancel already recorded it
        this.fail(taskId, err instanceof Error ? err : new Error(String(err)));
      });
    return buildMcpBgTaskPlaceholder(
      taskId,
      options.serverName,
      options.toolName,
      options.pollIntervalMs ?? MCP_BG_TASK_DEFAULT_POLL_INTERVAL_MS,
    );
  }

  private clearTimer(taskId: string): void {
    const handle = this.timeouts.get(taskId);
    if (handle !== undefined) {
      this.clearTimeoutFn(handle);
      this.timeouts.delete(taskId);
    }
  }

  private finish(taskId: string, result: unknown): void {
    const task = this.tasks.get(taskId);
    if (!task || isMcpBgTaskTerminal(task.status)) return;
    this.clearTimer(taskId);
    task.status = 'done';
    task.result = result;
    task.finishedAt = this.now();
    this.emit(task);
  }

  private fail(taskId: string, err: Error): void {
    const task = this.tasks.get(taskId);
    if (!task || isMcpBgTaskTerminal(task.status)) return;
    this.clearTimer(taskId);
    task.status = 'failed';
    task.error = { code: 'error', message: err.message };
    task.finishedAt = this.now();
    this.emit(task);
  }

  private failWithTimeout(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || isMcpBgTaskTerminal(task.status)) return;
    this.controllers.get(taskId)?.abort();
    task.status = 'failed';
    task.error = {
      code: 'timeout',
      message: `Background MCP task ${taskId} timed out after ${task.timeoutMs}ms.`,
    };
    task.finishedAt = this.now();
    this.emit(task);
  }

  /**
   * Cancel a running task. Returns true when a running task was
   * cancelled, false when the task was already terminal or
   * unknown (use `get()` to distinguish). Never throws for an
   * unknown id — the agent turn treats "already gone" as done.
   */
  cancel(taskId: string, reason = 'Cancelled by the agent turn.'): boolean {
    const task = this.tasks.get(taskId);
    if (!task || isMcpBgTaskTerminal(task.status)) return false;
    this.controllers.get(taskId)?.abort();
    this.clearTimer(taskId);
    task.status = 'cancelled';
    task.error = { code: 'cancelled', message: reason };
    task.finishedAt = this.now();
    this.emit(task);
    return true;
  }

  /** Read one task, or undefined when unknown. */
  get(taskId: string): McpBgTaskRecord | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task, args: { ...task.args } } : undefined;
  }

  /** Throwing variant of `get()` for tool handlers. */
  require(taskId: string): McpBgTaskRecord {
    const task = this.get(taskId);
    if (!task) {
      throw new McpBackgroundTaskError(
        `Unknown background MCP task "${taskId}".`,
        'not-found',
        taskId,
      );
    }
    return task;
  }

  /** All tasks, newest first. Filter by status when given. */
  list(status?: McpBgTaskStatus): McpBgTaskRecord[] {
    const all = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    return (status ? all.filter((t) => t.status === status) : all).map((t) => ({
      ...t,
      args: { ...t.args },
    }));
  }

  /**
   * Mark a task as waiting for input (wire `input_required`):
   * still `running` from the turn's view, but `needsInput` tells
   * the turn to ask the user instead of polling forever. Returns
   * false when the task is terminal or unknown.
   */
  markNeedsInput(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || isMcpBgTaskTerminal(task.status)) return false;
    task.needsInput = true;
    this.emit(task);
    return true;
  }

  /** Drop finished tasks from the manager (keeps the live set small). Returns how many were dropped. */
  pruneFinished(): number {
    let n = 0;
    for (const [id, task] of [...this.tasks.entries()]) {
      if (!isMcpBgTaskTerminal(task.status)) continue;
      this.tasks.delete(id);
      this.controllers.delete(id);
      this.terminalNotifications.delete(id);
      n += 1;
    }
    return n;
  }

  /** Cancel every running task (session teardown). Returns how many were cancelled. */
  cancelAll(reason = 'Session ended.'): number {
    let n = 0;
    for (const task of [...this.tasks.values()]) {
      if (this.cancel(task.taskId, reason)) n += 1;
    }
    return n;
  }
}

/** True when background MCP tasks are enabled for this process. */
export function isMcpBackgroundTasksEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MCP_BACKGROUND_TASKS_ENV_VAR] === '1' || env[MCP_BACKGROUND_TASKS_SDK_ENV_VAR] === '1';
}

/**
 * The agent turn's entry point: when background tasks are enabled,
 * submit and return the placeholder immediately (the turn goes on
 * to other work; the result arrives as a `task_notification`).
 * When disabled, run the work inline and return the real result —
 * same call shape, no placeholder, no manager needed.
 */
export async function submitBackgroundOrDirect(
  manager: BackgroundMcpTaskManager,
  options: McpBgTaskSubmitOptions & { enabled?: boolean },
): Promise<McpBgTaskPlaceholder | { kind: 'direct'; result: unknown }> {
  const enabled = options.enabled ?? isMcpBackgroundTasksEnabled();
  if (!enabled) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MCP_BG_TASK_DEFAULT_TIMEOUT_MS);
    try {
      const result = await options.run(controller.signal);
      return { kind: 'direct', result };
    } finally {
      clearTimeout(timer);
    }
  }
  return manager.submit(options);
}
