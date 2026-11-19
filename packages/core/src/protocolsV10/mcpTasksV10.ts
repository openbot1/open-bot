/**
 * Protocols v10 — MCP Tasks extension (v1.41, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v141.md (section 1): Tasks
 * (`io.modelcontextprotocol/tasks`) is an official extension
 * in spec 2026-07-28 — long-running work is split out of the
 * core, the server returns a task handle instead of holding
 * the connection, the client polls `tasks/get`, the final
 * result is embedded in the Task object, and `tasks/update`
 * feeds input in mid-flight (multi round-trip). This module
 * builds on the v8 Tasks layer (`protocolsV8/mcpTasksV8.ts`:
 * strict state machine, terminal-state enforcement, MRTR
 * rounds, input expiry + sweep) and adds the four things a
 * real task system needs on top:
 *
 *   - Priorities: `low` / `normal` / `high` / `urgent`; the
 *     engine picks the highest-priority ready task first.
 *   - Dependencies: a task may wait for other tasks to
 *     complete (`dependsOn`); it only becomes ready when
 *     every dependency is `completed`. A dependency cycle is
 *     refused at creation time.
 *   - Retry policy: a failed task retries with backoff up to
 *     `maxRetries` times (the handler decides what counts as
 *     retryable by throwing a `McpV10TasksRetryableError`).
 *   - Progress events: every state change and every progress
 *     report is appended to a capped event log, so the UI can
 *     show progress without polling the server twice; plus
 *     durable snapshots so the host can mirror tasks to disk.
 *
 * No code, text or asset from any other repo is copied here.
 * No network, no timers that outlive the process: the engine
 * uses plain promises and the host drives the clock.
 */

/** Error raised by the MCP Tasks v10 layer. */
export class McpV10TasksError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV10TasksError';
    this.code = code;
  }
}

/** A failure the engine should retry (transient), not fail outright. */
export class McpV10TasksRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpV10TasksRetryableError';
  }
}

/** Task states (Tasks extension lifecycle, same machine as v8). */
export const MCP_V10_TASK_STATES = [
  'submitted',
  'waiting',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
] as const;
export type McpV10TaskState = (typeof MCP_V10_TASK_STATES)[number];

/** Terminal task states — no further transition is legal. */
export const MCP_V10_TERMINAL_TASK_STATES: readonly McpV10TaskState[] = [
  'completed',
  'failed',
  'canceled',
];

/** True when the state is terminal. */
export function mcpV10TaskIsTerminal(state: McpV10TaskState): boolean {
  return (MCP_V10_TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/** Legal transitions (from → to). Anything else is refused. */
export const MCP_V10_TASK_TRANSITIONS: Record<McpV10TaskState, readonly McpV10TaskState[]> = {
  submitted: ['waiting', 'working', 'canceled', 'failed'],
  waiting: ['submitted', 'working', 'canceled', 'failed'],
  working: ['input-required', 'completed', 'failed', 'canceled'],
  'input-required': ['working', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

/** True when the transition is legal. */
export function mcpV10TaskTransitionAllowed(from: McpV10TaskState, to: McpV10TaskState): boolean {
  return (MCP_V10_TASK_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** Task priority (the engine picks the highest-priority ready task first). */
export const MCP_V10_TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type McpV10TaskPriority = (typeof MCP_V10_TASK_PRIORITIES)[number];
const PRIORITY_RANK: Record<McpV10TaskPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** Retry policy for a task. */
export interface McpV10TaskRetryPolicy {
  /** Max retries after the first failure (default 0 = no retry). */
  maxRetries: number;
  /** Backoff between retries in ms (default 1000, doubled each time). */
  backoffMs?: number;
}

/** One multi round-trip round (task asked for input, client answered). */
export interface McpV10TaskRound {
  round: number;
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  openedAtMs: number;
  answeredAtMs?: number;
}

/** One progress event (state change or progress report). */
export interface McpV10TaskEvent {
  seq: number;
  taskId: string;
  kind: 'created' | 'state' | 'progress' | 'input-requested' | 'input-answered' | 'retried' | 'canceled' | 'swept';
  at: number;
  from?: McpV10TaskState;
  to?: McpV10TaskState;
  /** 0–100 progress (progress events only). */
  progress?: number;
  detail?: string;
}

/** One task. */
export interface McpV10Task {
  id: string;
  /** Tool the task runs (or a free-form title when the host runs its own work). */
  toolName: string;
  /** Arguments for the tool. */
  args: Record<string, unknown>;
  state: McpV10TaskState;
  priority: McpV10TaskPriority;
  /** Task ids this task waits for (all must be `completed`). */
  dependsOn: string[];
  retryPolicy: McpV10TaskRetryPolicy;
  /** How many times the task has been retried so far. */
  retriesUsed: number;
  createdAtMs: number;
  updatedAtMs: number;
  /** When a waiting-for-input task expires (ms since epoch). */
  inputExpiresAtMs?: number;
  /** 0–100 progress (last report). */
  progress?: number;
  /** Progress message (last report). */
  progressMessage?: string;
  /** Multi round-trip rounds so far. */
  rounds: McpV10TaskRound[];
  /** Final result (embedded in the task, per SEP-2663). */
  result?: unknown;
  /** Failure message (when `failed`). */
  error?: string;
  /** Cancellation reason (when `canceled`). */
  cancelReason?: string;
}

/** Serialisable snapshot of one task (for restore). */
export type McpV10TaskSnapshot = McpV10Task;

/** Options for the task store. */
export interface McpV10TaskStoreOptions {
  /** Max tasks kept (default 500; oldest terminal tasks are pruned first). */
  maxTasks?: number;
  /** Max events kept in the log (default 500). */
  maxEvents?: number;
  /** How long a task may wait for input before it is swept (default 10 min). */
  inputTimeoutMs?: number;
}

/**
 * The task store: holds tasks with a strict state machine,
 * dependencies, priorities, retries and a capped event log.
 */
export class McpV10TaskStore {
  private readonly tasks = new Map<string, McpV10Task>();
  private readonly events: McpV10TaskEvent[] = [];
  private seq = 0;
  private eventSeq = 0;
  private readonly maxTasks: number;
  private readonly maxEvents: number;
  readonly inputTimeoutMs: number;

  constructor(options: McpV10TaskStoreOptions = {}) {
    this.maxTasks = options.maxTasks ?? 500;
    this.maxEvents = options.maxEvents ?? 500;
    this.inputTimeoutMs = options.inputTimeoutMs ?? 10 * 60 * 1000;
  }

  private log(taskId: string, kind: McpV10TaskEvent['kind'], extra: Partial<McpV10TaskEvent> = {}): void {
    this.eventSeq += 1;
    this.events.push({ seq: this.eventSeq, taskId, kind, at: Date.now(), ...extra });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  /** Create a task. Dependencies must exist and must not form a cycle. */
  create(input: {
    toolName: string;
    args?: Record<string, unknown>;
    priority?: McpV10TaskPriority;
    dependsOn?: string[];
    retryPolicy?: McpV10TaskRetryPolicy;
  }): McpV10Task {
    if (typeof input.toolName !== 'string' || input.toolName.length === 0) {
      throw new McpV10TasksError('invalid-task', 'Task toolName must be a non-empty string.');
    }
    const dependsOn = [...(input.dependsOn ?? [])];
    for (const dep of dependsOn) {
      if (!this.tasks.has(dep)) {
        throw new McpV10TasksError('unknown-dependency', `Task depends on unknown task "${dep}".`);
      }
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new McpV10TasksError('invalid-task', 'dependsOn must not contain duplicates.');
    }
    this.seq += 1;
    const id = `task-v10-${this.seq}`;
    // A cycle would need the new task to (transitively) depend
    // on itself; since it has no id yet, only a self-reference
    // via a dependency that depends on the new id is possible
    // — impossible here because ids are fresh. The check below
    // guards the restore path, where ids already exist.
    const now = Date.now();
    const task: McpV10Task = {
      id,
      toolName: input.toolName,
      args: input.args ?? {},
      state: dependsOn.length > 0 ? 'waiting' : 'submitted',
      priority: input.priority ?? 'normal',
      dependsOn,
      retryPolicy: { maxRetries: input.retryPolicy?.maxRetries ?? 0, backoffMs: input.retryPolicy?.backoffMs ?? 1000 },
      retriesUsed: 0,
      createdAtMs: now,
      updatedAtMs: now,
      rounds: [],
    };
    this.tasks.set(id, task);
    this.log(id, 'created', { to: task.state });
    this.pruneIfNeeded();
    return { ...task, rounds: [...task.rounds] };
  }

  /** Get a task by id (copy; undefined when unknown). */
  get(id: string): McpV10Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    return { ...task, dependsOn: [...task.dependsOn], rounds: task.rounds.map((r) => ({ ...r })) };
  }

  /** All tasks (copies), newest first. */
  list(): McpV10Task[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? -1 : 1))
      .map((t) => ({ ...t, dependsOn: [...t.dependsOn], rounds: t.rounds.map((r) => ({ ...r })) }));
  }

  /** Tasks in one state. */
  listByState(state: McpV10TaskState): McpV10Task[] {
    return this.list().filter((t) => t.state === state);
  }

  /** Tasks ready to run: submitted, with all dependencies completed. */
  readyQueue(): McpV10Task[] {
    const ready = this.list().filter((t) => {
      if (t.state !== 'submitted') return false;
      return t.dependsOn.every((dep) => this.tasks.get(dep)?.state === 'completed');
    });
    // Highest priority first, then oldest first (fair within a priority).
    ready.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.createdAtMs - b.createdAtMs);
    return ready;
  }

  /** Tasks ready to resume: working, with all dependencies completed. */
  resumable(): McpV10Task[] {
    const ready = this.list().filter((t) => {
      if (t.state !== 'working') return false;
      return t.dependsOn.every((dep) => this.tasks.get(dep)?.state === 'completed');
    });
    ready.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.createdAtMs - b.createdAtMs);
    return ready;
  }

  /** True when every dependency of the task is `completed`. */
  dependenciesMet(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    return task.dependsOn.every((dep) => this.tasks.get(dep)?.state === 'completed');
  }

  /** Move waiting tasks whose dependencies are now met back to `submitted`. */
  releaseReady(nowMs = Date.now()): McpV10Task[] {
    const released: McpV10Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.state === 'waiting' && this.dependenciesMet(task.id)) {
        this.transition(task, 'submitted', nowMs);
        released.push({ ...task });
      }
    }
    return released;
  }

  /** Transition a task (enforces the state machine). */
  transition(task: McpV10Task, to: McpV10TaskState, nowMs = Date.now()): McpV10Task {
    const stored = this.tasks.get(task.id);
    if (!stored) throw new McpV10TasksError('unknown-task', `Unknown task "${task.id}".`);
    if (!mcpV10TaskTransitionAllowed(stored.state, to)) {
      throw new McpV10TasksError(
        'illegal-transition',
        `Task "${task.id}" cannot move from "${stored.state}" to "${to}".`,
      );
    }
    const from = stored.state;
    stored.state = to;
    stored.updatedAtMs = nowMs;
    if (to === 'input-required') stored.inputExpiresAtMs = nowMs + this.inputTimeoutMs;
    else stored.inputExpiresAtMs = undefined;
    this.log(task.id, 'state', { from, to });
    return { ...stored, dependsOn: [...stored.dependsOn], rounds: stored.rounds.map((r) => ({ ...r })) };
  }

  /** Record one retry attempt for a working task (engine bookkeeping). */
  noteRetry(id: string): number {
    const task = this.tasks.get(id);
    if (!task) throw new McpV10TasksError('unknown-task', `Unknown task "${id}".`);
    task.retriesUsed += 1;
    task.updatedAtMs = Date.now();
    this.log(id, 'retried', { detail: `attempt ${task.retriesUsed}` });
    return task.retriesUsed;
  }

  /** Report progress (0–100) for a working task. */
  reportProgress(id: string, progress: number, message?: string, nowMs = Date.now()): McpV10Task {
    const task = this.tasks.get(id);
    if (!task) throw new McpV10TasksError('unknown-task', `Unknown task "${id}".`);
    if (task.state !== 'working') {
      throw new McpV10TasksError('not-working', `Task "${id}" is "${task.state}", not "working"; progress can only be reported while working.`);
    }
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      throw new McpV10TasksError('invalid-progress', 'Progress must be a number from 0 to 100.');
    }
    task.progress = progress;
    if (message !== undefined) task.progressMessage = message;
    task.updatedAtMs = nowMs;
    this.log(id, 'progress', { progress, detail: message });
    return { ...task, dependsOn: [...task.dependsOn], rounds: task.rounds.map((r) => ({ ...r })) };
  }

  /** Open an input round (task asks the client for input). */
  requestInput(id: string, request: Record<string, unknown>, nowMs = Date.now()): McpV10TaskRound {
    const task = this.tasks.get(id);
    if (!task) throw new McpV10TasksError('unknown-task', `Unknown task "${id}".`);
    if (task.state !== 'working') {
      throw new McpV10TasksError('not-working', `Task "${id}" is "${task.state}", not "working"; only a working task can ask for input.`);
    }
    this.transition(task, 'input-required', nowMs);
    const round: McpV10TaskRound = {
      round: task.rounds.length + 1,
      request,
      openedAtMs: nowMs,
    };
    task.rounds.push(round);
    this.log(id, 'input-requested', { detail: `round ${round.round}` });
    return { ...round };
  }

  /** Answer the open input round (client replies via tasks/update). */
  provideInput(id: string, response: Record<string, unknown>, nowMs = Date.now()): McpV10Task {
    const task = this.tasks.get(id);
    if (!task) throw new McpV10TasksError('unknown-task', `Unknown task "${id}".`);
    if (task.state !== 'input-required') {
      throw new McpV10TasksError('not-waiting', `Task "${id}" is "${task.state}", not "input-required"; there is no open input round to answer.`);
    }
    const round = task.rounds[task.rounds.length - 1];
    if (!round || round.response !== undefined) {
      throw new McpV10TasksError('no-open-round', `Task "${id}" has no open input round.`);
    }
    round.response = response;
    round.answeredAtMs = nowMs;
    this.log(id, 'input-answered', { detail: `round ${round.round}` });
    return this.transition(task, 'working', nowMs);
  }

  /** Complete a task with its final result (embedded in the task). */
  complete(id: string, result: unknown, nowMs = Date.now()): McpV10Task {
    const task = this.tasks.get(id);
    if (!task) throw new McpV10TasksError('unknown-task', `Unknown task "${id}".`);
    const done = this.transition(task, 'completed', nowMs);
    // `this.tasks` is the internal map, so this is the stored record (not a copy).
    const stored = this.tasks.get(id);
    if (stored) stored.result = result;
    // Releasing dependents may unblock waiting tasks.
    this.releaseReady(nowMs);
    return { ...done, result };
  }

  /** Fail a task. Returns the task (retry bookkeeping is the engine's job). */
  fail(id: string, error: string, nowMs = Date.now()): McpV10Task {
    const task = this.tasks.get(id);
    if (!task) throw new McpV10TasksError('unknown-task', `Unknown task "${id}".`);
    const done = this.transition(task, 'failed', nowMs);
    // `this.tasks` is the internal map, so this is the stored record (not a copy).
    const stored = this.tasks.get(id);
    if (stored) stored.error = error;
    return { ...done, error };
  }

  /** Cancel a task (from any non-terminal state). */
  cancel(id: string, reason?: string, nowMs = Date.now()): McpV10Task {
    const task = this.tasks.get(id);
    if (!task) throw new McpV10TasksError('unknown-task', `Unknown task "${id}".`);
    if (mcpV10TaskIsTerminal(task.state)) {
      throw new McpV10TasksError('terminal', `Task "${id}" is already "${task.state}" and cannot be canceled.`);
    }
    const done = this.transition(task, 'canceled', nowMs);
    const stored = this.tasks.get(id);
    if (stored && reason !== undefined) stored.cancelReason = reason;
    this.log(id, 'canceled', { detail: reason });
    return { ...done, cancelReason: reason };
  }

  /** Sweep tasks that waited for input past the timeout (they fail, loudly). */
  sweepOverdue(nowMs = Date.now()): McpV10Task[] {
    const swept: McpV10Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.state === 'input-required' && task.inputExpiresAtMs !== undefined && nowMs >= task.inputExpiresAtMs) {
        task.state = 'failed';
        task.error = 'Input wait expired (tasks/update never arrived).';
        task.updatedAtMs = nowMs;
        task.inputExpiresAtMs = undefined;
        this.log(task.id, 'swept', { detail: 'input wait expired' });
        swept.push({ ...task, dependsOn: [...task.dependsOn], rounds: task.rounds.map((r) => ({ ...r })) });
      }
    }
    return swept;
  }

  /** Event log (copy, oldest first). */
  eventsFor(taskId?: string): McpV10TaskEvent[] {
    const all = [...this.events];
    return taskId ? all.filter((e) => e.taskId === taskId) : all;
  }

  /** Counts by state. */
  counts(): Record<McpV10TaskState, number> {
    const out: Record<McpV10TaskState, number> = {
      submitted: 0, waiting: 0, working: 0, 'input-required': 0, completed: 0, failed: 0, canceled: 0,
    };
    for (const task of this.tasks.values()) out[task.state] += 1;
    return out;
  }

  /** Serialisable snapshot of all tasks (for the host to mirror). */
  snapshot(): McpV10TaskSnapshot[] {
    return this.list();
  }

  /** Restore from a snapshot (refuses dependency cycles). */
  restore(snapshots: readonly McpV10TaskSnapshot[]): void {
    const byId = new Map(snapshots.map((s) => [s.id, s]));
    // Cycle check: DFS over dependsOn.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new McpV10TasksError('dependency-cycle', `Restored tasks contain a dependency cycle at "${id}".`);
      visiting.add(id);
      for (const dep of byId.get(id)?.dependsOn ?? []) {
        if (byId.has(dep)) visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of byId.keys()) visit(id);
    this.tasks.clear();
    for (const snap of snapshots) {
      this.tasks.set(snap.id, {
        ...snap,
        dependsOn: [...snap.dependsOn],
        rounds: snap.rounds.map((r) => ({ ...r })),
        retryPolicy: { ...snap.retryPolicy },
      });
      const n = Number.parseInt(snap.id.replace(/^task-v10-/, ''), 10);
      if (Number.isFinite(n) && n > this.seq) this.seq = n;
    }
  }

  private pruneIfNeeded(): void {
    if (this.tasks.size <= this.maxTasks) return;
    const terminal = [...this.tasks.values()]
      .filter((t) => mcpV10TaskIsTerminal(t.state))
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    for (const task of terminal) {
      if (this.tasks.size <= this.maxTasks) break;
      this.tasks.delete(task.id);
    }
  }
}

/** A tool handler the engine runs as a task. */
export type McpV10TaskHandler = (
  task: McpV10Task,
  controls: {
    reportProgress: (progress: number, message?: string) => McpV10Task;
    requestInput: (request: Record<string, unknown>) => McpV10TaskRound;
  },
) => Promise<unknown> | unknown;

/**
 * The task engine: runs handlers as tasks — submit returns
 * the handle immediately (never blocks), the handler runs
 * asynchronously, `tasks/get` polls non-blocking, retries
 * apply to retryable failures with backoff.
 */
export class McpV10TaskEngine {
  readonly store: McpV10TaskStore;
  private readonly handlers = new Map<string, McpV10TaskHandler>();
  private running = new Set<string>();

  constructor(store?: McpV10TaskStore) {
    this.store = store ?? new McpV10TaskStore();
  }

  /** Register a handler for a tool name. */
  registerHandler(toolName: string, handler: McpV10TaskHandler): void {
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new McpV10TasksError('invalid-handler', 'Handler toolName must be a non-empty string.');
    }
    if (typeof handler !== 'function') {
      throw new McpV10TasksError('invalid-handler', `Handler for "${toolName}" must be a function.`);
    }
    this.handlers.set(toolName, handler);
  }

  /** Submit a task (returns the handle immediately). */
  submit(input: {
    toolName: string;
    args?: Record<string, unknown>;
    priority?: McpV10TaskPriority;
    dependsOn?: string[];
    retryPolicy?: McpV10TaskRetryPolicy;
  }): McpV10Task {
    return this.store.create(input);
  }

  /** True when the task's handler is currently running. */
  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /**
   * Run one ready task to completion (the host drives this;
   * it never blocks `submit`). A retryable failure retries
   * the handler in place with backoff, up to the task's
   * retry policy; other failures fail the task.
   */
  async runNext(): Promise<McpV10Task | undefined> {
    const ready = this.store.readyQueue();
    const next =
      ready.find((t) => !this.running.has(t.id)) ??
      this.store.resumable().find((t) => !this.running.has(t.id));
    if (!next) return undefined;
    const handler = this.handlers.get(next.toolName);
    if (!handler) {
      return this.store.fail(next.id, `No handler registered for tool "${next.toolName}".`);
    }
    this.running.add(next.id);
    try {
      // Fresh tasks move submitted -> working; resumed tasks are
      // already working (their handler asked for input earlier),
      // so no transition is needed — or legal — for them.
      if (next.state === 'submitted') this.store.transition(next, 'working');
      const controls = {
        reportProgress: (progress: number, message?: string) => this.store.reportProgress(next.id, progress, message),
        requestInput: (request: Record<string, unknown>) => this.store.requestInput(next.id, request),
      };
      const task = this.store.get(next.id);
      if (!task) throw new McpV10TasksError('unknown-task', `Task "${next.id}" vanished while starting.`);
      let attempt = 0;
      for (;;) {
        try {
          const current = this.store.get(next.id);
          if (!current) throw new McpV10TasksError('unknown-task', `Task "${next.id}" vanished while running.`);
          // A task that asked for input is not a failure — the
          // handler returned because it needs an answer; leave
          // it in `input-required` and let the client answer.
          if (current.state === 'input-required') return current;
          const result = await handler(current, controls);
          // The handler may have asked for input mid-run: that is
          // not a result — leave the task in `input-required` so
          // the client can answer and the host can resume it.
          const after = this.store.get(next.id);
          if (after && after.state === 'input-required') return after;
          return this.store.complete(next.id, result);
        } catch (err) {
          const current = this.store.get(next.id);
          if (!current) throw err;
          if (current.state === 'input-required') return current;
          const retryable = err instanceof McpV10TasksRetryableError;
          const retriesLeft = current.retryPolicy.maxRetries - attempt;
          if (retryable && retriesLeft > 0) {
            attempt += 1;
            this.store.noteRetry(next.id);
            const delayMs = (current.retryPolicy.backoffMs ?? 1000) * 2 ** (attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          return this.store.fail(next.id, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      this.running.delete(next.id);
    }
  }

  /** Cancel a task (running handlers are not interrupted; the result is discarded). */
  cancel(id: string, reason?: string): McpV10Task {
    return this.store.cancel(id, reason);
  }

  /** Answer a task's open input round, then run it again when the host calls runNext(). */
  provideInput(id: string, response: Record<string, unknown>): McpV10Task {
    return this.store.provideInput(id, response);
  }
}
