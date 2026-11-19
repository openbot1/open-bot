/**
 * Protocols v8 — MCP Tasks extension (v1.39, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v139.md (section 1): Tasks
 * (`io.modelcontextprotocol/tasks`) graduated from
 * experimental (2025-11-25) to an official extension in spec
 * 2026-07-28. The server returns a task handle instead of
 * holding the connection; the client polls `tasks/get`; the
 * final result is embedded straight in the Task object
 * (SEP-2663 removed the blocking `tasks/result` and the
 * `tasks/list` method); `tasks/update` feeds input in
 * mid-flight. Multi Round-Trip Requests (MRTR, SEP-2322)
 * replace the old mechanism: a task can ask for input, the
 * client answers with `tasks/update`, and the task resumes.
 *
 * This module is open-bot's own implementation, written from
 * that description:
 *
 *   - `McpV8TaskStore`: holds tasks (in memory, host-mirrored
 *     when it wants persistence), with a strict state machine
 *     (submitted → working → input-required → working →
 *     completed / failed / canceled) and terminal-state
 *     enforcement (no transition out of a terminal state).
 *   - `McpV8TaskEngine`: runs a tool handler as a task —
 *     submit returns the handle immediately (never blocks),
 *     the handler runs asynchronously, `tasks/get` polls
 *     non-blocking, `tasks/update` injects input (MRTR round),
 *     `tasks/cancel` cancels. The final result is embedded
 *     in the Task object itself (`result` field) — there is
 *     no blocking `tasks/result` call.
 *   - A task that waits for input expires (default 10 min);
 *     the store sweeps overdue tasks so a forgotten task
 *     never leaks.
 *
 * No code, text or asset from any other repo is copied here.
 * No network, no timers that outlive the process: the engine
 * uses plain promises and the host drives the clock.
 */

/** Error raised by the MCP Tasks layer. */
export class McpV8TasksError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV8TasksError';
    this.code = code;
  }
}

/** Task states (Tasks extension lifecycle). */
export const MCP_V8_TASK_STATES = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
] as const;
export type McpV8TaskState = (typeof MCP_V8_TASK_STATES)[number];

/** Terminal task states — no further transition is legal. */
export const MCP_V8_TERMINAL_TASK_STATES: readonly McpV8TaskState[] = [
  'completed',
  'failed',
  'canceled',
];

/** True when the state is terminal. */
export function mcpV8TaskIsTerminal(state: McpV8TaskState): boolean {
  return (MCP_V8_TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/** Legal transitions (from → to). Anything else is refused. */
export const MCP_V8_TASK_TRANSITIONS: Record<McpV8TaskState, readonly McpV8TaskState[]> = {
  submitted: ['working', 'canceled', 'failed'],
  working: ['input-required', 'completed', 'failed', 'canceled'],
  'input-required': ['working', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

/** True when the transition is legal. */
export function mcpV8TaskTransitionAllowed(from: McpV8TaskState, to: McpV8TaskState): boolean {
  return (MCP_V8_TASK_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** One MRTR round: the task asked for input and the client answered. */
export interface McpV8TaskRound {
  /** Round number (1-based). */
  round: number;
  /** What the task asked for. */
  request: Record<string, unknown>;
  /** What the client answered (undefined while waiting). */
  response?: Record<string, unknown>;
  /** When the round was opened (ms since epoch). */
  openedAtMs: number;
  /** When the round was answered (undefined while waiting). */
  answeredAtMs?: number;
}

/** A task, as the client sees it (final result embedded). */
export interface McpV8Task {
  /** Task id (opaque, unique per store). */
  taskId: string;
  /** Tool the task runs. */
  toolName: string;
  /** Current state. */
  status: McpV8TaskState;
  /** Arguments the task started with. */
  arguments: Record<string, unknown>;
  /** Progress 0..1 (undefined when the task does not report progress). */
  progress?: number;
  /** Human-readable progress message. */
  message?: string;
  /** MRTR rounds (input requests + answers). */
  rounds: McpV8TaskRound[];
  /** Final result, embedded when completed (SEP-2663: no tasks/result call). */
  result?: Record<string, unknown>;
  /** Error message when failed. */
  error?: string;
  /** When the task was created (ms since epoch). */
  createdAtMs: number;
  /** When the task last changed state (ms since epoch). */
  updatedAtMs: number;
  /** When the task reached a terminal state (undefined while open). */
  finishedAtMs?: number;
  /** Tenant the task belongs to. */
  tenant: string;
}

/** Options for the task store. */
export interface McpV8TaskStoreOptions {
  /** Clock override (ms since epoch). */
  nowMs?: () => number;
  /** Max tasks held (default 256; oldest terminal evicted first). */
  maxTasks?: number;
  /** How long a task may wait for input before it is swept as failed (default 10 min). */
  inputTimeoutMs?: number;
}

/**
 * Task store: holds tasks, enforces the state machine, sweeps
 * overdue input-waiting tasks. In-memory only; the host mirrors
 * snapshots when it wants persistence.
 */
export class McpV8TaskStore {
  private tasks = new Map<string, McpV8Task>();
  private seq = 0;
  private nowMs: () => number;
  private maxTasks: number;
  private inputTimeoutMs: number;

  constructor(options: McpV8TaskStoreOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.maxTasks = options.maxTasks ?? 256;
    this.inputTimeoutMs = options.inputTimeoutMs ?? 10 * 60 * 1000;
  }

  /** Number of tasks held. */
  size(): number {
    return this.tasks.size;
  }

  /** Task ids (sorted). */
  taskIds(): string[] {
    return [...this.tasks.keys()].sort();
  }

  /** Get one task (a copy; undefined when missing). */
  get(taskId: string): McpV8Task | undefined {
    const found = this.tasks.get(taskId);
    return found === undefined ? undefined : cloneMcpV8Task(found);
  }

  /** All tasks (copies, sorted by creation). */
  all(): McpV8Task[] {
    return [...this.tasks.values()]
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((t) => cloneMcpV8Task(t));
  }

  /** Tasks in one state (copies). */
  byState(state: McpV8TaskState): McpV8Task[] {
    return this.all().filter((t) => t.status === state);
  }

  /** Counts per state. */
  counts(): Record<McpV8TaskState, number> {
    const out: Record<McpV8TaskState, number> = {
      submitted: 0,
      working: 0,
      'input-required': 0,
      completed: 0,
      failed: 0,
      canceled: 0,
    };
    for (const t of this.tasks.values()) out[t.status] += 1;
    return out;
  }

  /** Create a task in `submitted` state. Returns the task (copy). */
  create(toolName: string, args: Record<string, unknown>, tenant = 'default'): McpV8Task {
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new McpV8TasksError('invalid-task', 'Task needs a non-empty tool name.');
    }
    const now = this.nowMs();
    const task: McpV8Task = {
      taskId: `mcp-v8-task-${now}-${++this.seq}`,
      toolName,
      status: 'submitted',
      arguments: { ...args },
      rounds: [],
      createdAtMs: now,
      updatedAtMs: now,
      tenant,
    };
    this.tasks.set(task.taskId, task);
    while (this.tasks.size > this.maxTasks) {
      const evictable = [...this.tasks.values()]
        .filter((t) => mcpV8TaskIsTerminal(t.status))
        .sort((a, b) => a.updatedAtMs - b.updatedAtMs)[0];
      if (evictable === undefined) break;
      this.tasks.delete(evictable.taskId);
    }
    return cloneMcpV8Task(task);
  }

  /**
   * Move a task to a new state. Throws McpV8TasksError when
   * the task is missing or the transition is illegal (in
   * particular, out of a terminal state).
   */
  transition(
    taskId: string,
    to: McpV8TaskState,
    patch: Partial<Pick<McpV8Task, 'progress' | 'message' | 'result' | 'error'>> = {},
  ): McpV8Task {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new McpV8TasksError('task-not-found', `Task "${taskId}" is not known.`);
    }
    if (!mcpV8TaskTransitionAllowed(task.status, to)) {
      throw new McpV8TasksError(
        'illegal-transition',
        `Task "${taskId}" cannot move from "${task.status}" to "${to}".`,
      );
    }
    const now = this.nowMs();
    task.status = to;
    task.updatedAtMs = now;
    if (patch.progress !== undefined) task.progress = patch.progress;
    if (patch.message !== undefined) task.message = patch.message;
    if (patch.result !== undefined) task.result = { ...patch.result };
    if (patch.error !== undefined) task.error = patch.error;
    if (mcpV8TaskIsTerminal(to)) task.finishedAtMs = now;
    return cloneMcpV8Task(task);
  }

  /** Set progress / message without a state change. */
  report(taskId: string, progress: number, message?: string): McpV8Task {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new McpV8TasksError('task-not-found', `Task "${taskId}" is not known.`);
    }
    if (mcpV8TaskIsTerminal(task.status)) {
      throw new McpV8TasksError('task-terminal', `Task "${taskId}" is ${task.status}; it takes no more progress reports.`);
    }
    if (typeof progress !== 'number' || progress < 0 || progress > 1) {
      throw new McpV8TasksError('invalid-progress', 'Progress must be a number between 0 and 1.');
    }
    task.progress = progress;
    if (message !== undefined) task.message = message;
    task.updatedAtMs = this.nowMs();
    return cloneMcpV8Task(task);
  }

  /** Open an MRTR round: the task asks the client for input. */
  requestInput(taskId: string, request: Record<string, unknown>): McpV8Task {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new McpV8TasksError('task-not-found', `Task "${taskId}" is not known.`);
    }
    if (task.status !== 'working') {
      throw new McpV8TasksError(
        'task-not-working',
        `Task "${taskId}" is ${task.status}; only a working task can request input.`,
      );
    }
    const round: McpV8TaskRound = {
      round: task.rounds.length + 1,
      request: { ...request },
      openedAtMs: this.nowMs(),
    };
    task.rounds.push(round);
    task.status = 'input-required';
    task.updatedAtMs = this.nowMs();
    return cloneMcpV8Task(task);
  }

  /** Answer the open MRTR round (`tasks/update`): the task resumes to `working`. */
  answerInput(taskId: string, response: Record<string, unknown>): McpV8Task {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new McpV8TasksError('task-not-found', `Task "${taskId}" is not known.`);
    }
    if (task.status !== 'input-required') {
      throw new McpV8TasksError(
        'task-not-waiting',
        `Task "${taskId}" is ${task.status}; only an input-required task takes an update.`,
      );
    }
    const open = task.rounds[task.rounds.length - 1];
    if (open === undefined || open.response !== undefined) {
      throw new McpV8TasksError('task-no-open-round', `Task "${taskId}" has no open input round.`);
    }
    open.response = { ...response };
    open.answeredAtMs = this.nowMs();
    task.status = 'working';
    task.updatedAtMs = this.nowMs();
    return cloneMcpV8Task(task);
  }

  /** Cancel a task (no-op when already terminal — returns the task). */
  cancel(taskId: string): McpV8Task {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new McpV8TasksError('task-not-found', `Task "${taskId}" is not known.`);
    }
    if (mcpV8TaskIsTerminal(task.status)) return cloneMcpV8Task(task);
    return this.transition(taskId, 'canceled', { message: 'Canceled by the client.' });
  }

  /**
   * Sweep tasks that waited for input longer than
   * `inputTimeoutMs`: they fail with a timeout error.
   * Returns the swept task ids.
   */
  sweepOverdue(): string[] {
    const now = this.nowMs();
    const swept: string[] = [];
    for (const task of [...this.tasks.values()]) {
      if (task.status !== 'input-required') continue;
      if (now - task.updatedAtMs <= this.inputTimeoutMs) continue;
      task.status = 'failed';
      task.error = `Timed out waiting for input (${this.inputTimeoutMs} ms).`;
      task.updatedAtMs = now;
      task.finishedAtMs = now;
      swept.push(task.taskId);
    }
    return swept.sort();
  }

  /** Snapshot all tasks (for the host to mirror to disk). */
  snapshot(): McpV8Task[] {
    return this.all();
  }

  /** Restore tasks from a snapshot (replaces the store). */
  restore(tasks: McpV8Task[]): void {
    this.tasks.clear();
    for (const t of tasks) {
      if (typeof t.taskId !== 'string' || t.taskId.length === 0) continue;
      if (!(MCP_V8_TASK_STATES as readonly string[]).includes(t.status)) continue;
      this.tasks.set(t.taskId, cloneMcpV8Task(t));
    }
  }
}

/** Deep-ish copy of a task (rounds + arguments + result cloned). */
export function cloneMcpV8Task(task: McpV8Task): McpV8Task {
  const out: McpV8Task = {
    taskId: task.taskId,
    toolName: task.toolName,
    status: task.status,
    arguments: { ...task.arguments },
    rounds: task.rounds.map((r) => ({
      round: r.round,
      request: { ...r.request },
      ...(r.response !== undefined ? { response: { ...r.response } } : {}),
      openedAtMs: r.openedAtMs,
      ...(r.answeredAtMs !== undefined ? { answeredAtMs: r.answeredAtMs } : {}),
    })),
    createdAtMs: task.createdAtMs,
    updatedAtMs: task.updatedAtMs,
    tenant: task.tenant,
  };
  if (task.progress !== undefined) out.progress = task.progress;
  if (task.message !== undefined) out.message = task.message;
  if (task.result !== undefined) out.result = { ...task.result };
  if (task.error !== undefined) out.error = task.error;
  if (task.finishedAtMs !== undefined) out.finishedAtMs = task.finishedAtMs;
  return out;
}

/** A tool runner the engine calls: returns the final result, or asks for input. */
export type McpV8TaskRunner = (
  toolName: string,
  args: Record<string, unknown>,
  task: McpV8Task,
  control: McpV8TaskControl,
) => Promise<Record<string, unknown>>;

/** Control surface a runner uses to report progress / ask for input. */
export interface McpV8TaskControl {
  /** Report progress (0..1) + optional message. */
  report(progress: number, message?: string): void;
  /**
   * Ask the client for input (MRTR): moves the task to
   * `input-required` and resolves with the client's answer
   * when `tasks/update` arrives. Rejects when the task is
   * canceled while waiting.
   */
  askInput(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** True when the task was canceled while the runner was working. */
  isCanceled(): boolean;
}

/** Engine options. */
export interface McpV8TaskEngineOptions {
  /** Clock override (ms since epoch). */
  nowMs?: () => number;
  /** Max tasks held (default 256). */
  maxTasks?: number;
  /** How long a task may wait for input (default 10 min). */
  inputTimeoutMs?: number;
}

/**
 * Task engine: submits a tool run as a task, runs it
 * asynchronously, and answers `tasks/get` / `tasks/update` /
 * `tasks/cancel` without ever blocking the caller. The final
 * result is embedded in the Task object — there is no
 * blocking `tasks/result` method (SEP-2663).
 */
export class McpV8TaskEngine {
  private store: McpV8TaskStore;
  private runners = new Map<string, McpV8TaskRunner>();
  private waiters = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private canceled = new Set<string>();

  constructor(options: McpV8TaskEngineOptions = {}) {
    this.store = new McpV8TaskStore({
      nowMs: options.nowMs,
      maxTasks: options.maxTasks,
      inputTimeoutMs: options.inputTimeoutMs,
    });
  }

  /** The underlying store (for get / counts / snapshot). */
  taskStore(): McpV8TaskStore {
    return this.store;
  }

  /** Register a runner for a tool name. */
  registerRunner(toolName: string, runner: McpV8TaskRunner): void {
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new McpV8TasksError('invalid-runner', 'Runner needs a non-empty tool name.');
    }
    this.runners.set(toolName, runner);
  }

  /** Runner names (sorted). */
  runnerNames(): string[] {
    return [...this.runners.keys()].sort();
  }

  /**
   * Submit a tool run as a task: returns the handle
   * immediately; the runner runs in the background. When no
   * runner is registered the task fails at once (still
   * asynchronously, so submit never blocks).
   */
  submit(toolName: string, args: Record<string, unknown>, tenant = 'default'): McpV8Task {
    const task = this.store.create(toolName, args, tenant);
    const runner = this.runners.get(toolName);
    void this.run(task.taskId, runner);
    return task;
  }

  private async run(taskId: string, runner: McpV8TaskRunner | undefined): Promise<void> {
    try {
      this.store.transition(taskId, 'working', { progress: 0, message: 'Started.' });
    } catch {
      return;
    }
    if (runner === undefined) {
      this.store.transition(taskId, 'failed', { error: `No runner registered for tool "${this.store.get(taskId)?.toolName ?? ''}".` });
      return;
    }
    const task = this.store.get(taskId);
    if (task === undefined) return;
    const control: McpV8TaskControl = {
      report: (progress, message) => {
        try {
          this.store.report(taskId, progress, message);
        } catch {
          // Task finished meanwhile; the report is dropped.
        }
      },
      askInput: (request) => this.askInput(taskId, request),
      isCanceled: () => this.canceled.has(taskId),
    };
    try {
      const result = await runner(task.toolName, task.arguments, this.store.get(taskId) ?? task, control);
      const current = this.store.get(taskId);
      if (current === undefined) return;
      // The task may have been canceled / swept while the runner
      // worked: a terminal task takes no further transition.
      if (mcpV8TaskIsTerminal(current.status)) return;
      if (current.status === 'input-required') {
        // The runner returned while input was still open (it did
        // not await askInput): the task cannot complete — fail it
        // and wake the waiter so nothing leaks.
        this.store.transition(taskId, 'failed', { error: 'Runner finished while input was still open.' });
        this.rejectWaiter(taskId, new McpV8TasksError('task-failed', `Task "${taskId}" finished while input was still open.`));
        return;
      }
      this.store.transition(taskId, 'completed', { result, progress: 1, message: 'Completed.' });
    } catch (err) {
      const current = this.store.get(taskId);
      if (current === undefined) return;
      // Already terminal (canceled / swept to failed while the
      // runner was woken): nothing more to do.
      if (mcpV8TaskIsTerminal(current.status)) return;
      if (current.status === 'input-required') {
        // The runner died while waiting for input: fail it.
        this.store.transition(taskId, 'failed', { error: (err as Error).message });
        this.rejectWaiter(taskId, err as Error);
        return;
      }
      this.store.transition(taskId, 'failed', { error: (err as Error).message });
    }
  }

  private askInput(taskId: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const task = this.store.get(taskId);
    if (task === undefined) return Promise.reject(new McpV8TasksError('task-not-found', `Task "${taskId}" is not known.`));
    if (this.canceled.has(taskId)) {
      return Promise.reject(new McpV8TasksError('task-canceled', `Task "${taskId}" was canceled.`));
    }
    this.store.requestInput(taskId, request);
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.waiters.set(taskId, { resolve, reject });
    });
    // The runner may never await this promise (fire-and-forget
    // askInput): mark the rejection as handled so a later
    // cancel / sweep / fail does not surface as an unhandled
    // rejection. A runner that DOES await still observes the
    // rejection through its own await.
    promise.catch(() => { /* handled: see above */ });
    return promise;
  }

  private rejectWaiter(taskId: string, err: Error): void {
    const waiter = this.waiters.get(taskId);
    if (waiter === undefined) return;
    this.waiters.delete(taskId);
    waiter.reject(err);
  }

  /** `tasks/get`: poll a task (never blocks — returns the current state). */
  get(taskId: string): McpV8Task {
    const task = this.store.get(taskId);
    if (task === undefined) {
      throw new McpV8TasksError('task-not-found', `Task "${taskId}" is not known.`);
    }
    return task;
  }

  /**
   * `tasks/update`: feed input into a waiting task (MRTR).
   * The waiting runner resumes with the answer.
   */
  update(taskId: string, input: Record<string, unknown>): McpV8Task {
    const updated = this.store.answerInput(taskId, input);
    const waiter = this.waiters.get(taskId);
    if (waiter !== undefined) {
      this.waiters.delete(taskId);
      waiter.resolve({ ...input });
    }
    return updated;
  }

  /** `tasks/cancel`: cancel a task (a waiting runner is woken with a rejection). */
  cancel(taskId: string): McpV8Task {
    const task = this.store.get(taskId);
    if (task === undefined) {
      throw new McpV8TasksError('task-not-found', `Task "${taskId}" is not known.`);
    }
    this.canceled.add(taskId);
    const canceled = this.store.cancel(taskId);
    this.rejectWaiter(taskId, new McpV8TasksError('task-canceled', `Task "${taskId}" was canceled.`));
    return canceled;
  }

  /** Sweep overdue input-waiting tasks (also wakes their runners with a failure). */
  sweepOverdue(): string[] {
    const swept = this.store.sweepOverdue();
    for (const taskId of swept) {
      this.rejectWaiter(taskId, new McpV8TasksError('task-timeout', `Task "${taskId}" timed out waiting for input.`));
    }
    return swept;
  }

  /** Counts per state. */
  counts(): Record<McpV8TaskState, number> {
    return this.store.counts();
  }
}

/**
 * The Tasks-extension JSON-RPC surface, as method names:
 * `tasks/get`, `tasks/update`, `tasks/cancel`. There is
 * deliberately NO `tasks/result` (blocking) and NO
 * `tasks/list` (removed by SEP-2663).
 */
export const MCP_V8_TASK_METHODS = ['tasks/get', 'tasks/update', 'tasks/cancel'] as const;
export type McpV8TaskMethod = (typeof MCP_V8_TASK_METHODS)[number];

/** True when the method belongs to the Tasks extension. */
export function mcpV8IsTaskMethod(method: string): method is McpV8TaskMethod {
  return (MCP_V8_TASK_METHODS as readonly string[]).includes(method);
}
