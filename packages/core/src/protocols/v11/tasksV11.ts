/**
 * Protocols v11 — Tasks extension (v1.42, Team T2).
 *
 * Idea only, learned from the public MCP 2.0 description in
 * docs/repo-survey-v142.md (section 2): Tasks is a formal
 * extension in MCP 2.0 under the namespace
 * `io.modelcontextprotocol/tasks`. A long-running call
 * returns a task handle; the client polls `tasks/get` until
 * the task reaches a terminal state. No code, text or asset
 * from any other repo is copied here.
 *
 * What this module owns:
 *  - Task lifecycle: `created` -> `running` -> (`input_required`
 *    -> `running`) -> `completed` | `failed` | `cancelled`.
 *    A task that asks for input waits in `input_required`
 *    until the client provides it; a task whose input is
 *    never provided expires (TTL) and fails closed.
 *  - `McpV11TaskStore`: in-memory task records with progress
 *    events, input handoff, expiry sweep, snapshot/restore,
 *    and counts.
 *  - `McpV11TaskEngine`: creates tasks from a handler, runs
 *    the handler in the background (the engine never blocks
 *    the caller), and drives progress / completion / failure.
 *    The engine is transport-free: the tools layer exposes
 *    the same operations as `tasks/create`, `tasks/get`,
 *    `tasks/list`, `tasks/cancel`, `tasks/provide-input`.
 *  - `pollMcpV11Task()`: the client-side `tasks/get` poll
 *    loop — resolves when the task is terminal, rejects on
 *    timeout.
 *
 * Tasks are local records: the store keeps no session and
 * no credentials, only the task's own input, progress and
 * result.
 */

import { randomUUID } from 'node:crypto';
import { MCP_V11_TASKS_EXTENSION } from './versionsV11';

/** The Tasks extension namespace (re-exported for callers). */
export const MCP_V11_TASKS_NAMESPACE = MCP_V11_TASKS_EXTENSION;

/** Task states. */
export type McpV11TaskStatus =
  | 'created'
  | 'running'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Terminal states (polling stops here). */
export const MCP_V11_TASK_TERMINAL_STATUSES: McpV11TaskStatus[] = ['completed', 'failed', 'cancelled'];

/** True when the status is terminal. */
export function isMcpV11TaskTerminal(status: McpV11TaskStatus): boolean {
  return (MCP_V11_TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** One progress event recorded on a task. */
export interface McpV11TaskProgressEvent {
  atMs: number;
  /** 0..100, or -1 when the handler does not report progress. */
  percent: number;
  message: string;
}

/** A task record. */
export interface McpV11Task {
  id: string;
  kind: string;
  status: McpV11TaskStatus;
  input: Record<string, unknown>;
  /** Result once completed. */
  result?: Record<string, unknown>;
  /** Error message once failed. */
  error?: string;
  /** 0..100 progress. */
  progress: number;
  progressEvents: McpV11TaskProgressEvent[];
  /** Input the server is waiting for (while `input_required`). */
  pendingInput?: { id: string; title: string; reason: string; fields: string[] };
  /** Input the client provided (once answered). */
  providedInput?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  /** When the task expires if it never reaches a terminal state. */
  expiresAtMs: number;
}

/** Counts of tasks by status. */
export interface McpV11TaskCounts {
  total: number;
  created: number;
  running: number;
  input_required: number;
  completed: number;
  failed: number;
  cancelled: number;
}

/** Error raised by the Tasks extension layer. */
export class McpV11TaskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV11TaskError';
    this.code = code;
  }
}

/** Default task TTL: 10 minutes without a terminal state. */
export const MCP_V11_TASK_DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Default input wait: 5 minutes for the client to answer `input_required`. */
export const MCP_V11_TASK_INPUT_WAIT_MS = 5 * 60 * 1000;

/** In-memory task store. */
export class McpV11TaskStore {
  private tasks = new Map<string, McpV11Task>();

  constructor(private readonly ttlMs: number = MCP_V11_TASK_DEFAULT_TTL_MS) {}

  create(kind: string, input: Record<string, unknown> = {}): McpV11Task {
    const now = Date.now();
    const task: McpV11Task = {
      id: `task-${randomUUID()}`,
      kind,
      status: 'created',
      input: { ...input },
      progress: 0,
      progressEvents: [],
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + this.ttlMs,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): McpV11Task | undefined {
    return this.tasks.get(id);
  }

  require(id: string): McpV11Task {
    const task = this.tasks.get(id);
    if (!task) throw new McpV11TaskError('task-not-found', `No task "${id}".`);
    return task;
  }

  list(status?: McpV11TaskStatus): McpV11Task[] {
    const all = [...this.tasks.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
    return status ? all.filter((t) => t.status === status) : all;
  }

  counts(): McpV11TaskCounts {
    const counts: McpV11TaskCounts = {
      total: this.tasks.size,
      created: 0,
      running: 0,
      input_required: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of this.tasks.values()) counts[task.status] += 1;
    return counts;
  }

  /** Move a task to a new status (records the transition time). */
  setStatus(id: string, status: McpV11TaskStatus, patch: Partial<McpV11Task> = {}): McpV11Task {
    const task = this.require(id);
    task.status = status;
    task.updatedAtMs = Date.now();
    Object.assign(task, patch);
    return task;
  }

  /** Record a progress event (0..100). */
  progress(id: string, percent: number, message: string): McpV11Task {
    const task = this.require(id);
    if (isMcpV11TaskTerminal(task.status)) {
      throw new McpV11TaskError('task-terminal', `Task "${id}" is already ${task.status}.`);
    }
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    task.progress = clamped;
    task.progressEvents.push({ atMs: Date.now(), percent: clamped, message });
    task.updatedAtMs = Date.now();
    if (task.status === 'created') task.status = 'running';
    return task;
  }

  /** The server asks the client for input; the task waits in `input_required`. */
  requestInput(
    id: string,
    pending: { id: string; title: string; reason: string; fields: string[] },
  ): McpV11Task {
    const task = this.require(id);
    if (isMcpV11TaskTerminal(task.status)) {
      throw new McpV11TaskError('task-terminal', `Task "${id}" is already ${task.status}.`);
    }
    task.status = 'input_required';
    task.pendingInput = pending;
    task.updatedAtMs = Date.now();
    return task;
  }

  /** The client answers the pending input; the task resumes as `running`. */
  provideInput(id: string, input: Record<string, unknown>): McpV11Task {
    const task = this.require(id);
    if (task.status !== 'input_required') {
      throw new McpV11TaskError('not-waiting-for-input', `Task "${id}" is ${task.status}, not input_required.`);
    }
    task.providedInput = { ...input };
    task.pendingInput = undefined;
    task.status = 'running';
    task.updatedAtMs = Date.now();
    return task;
  }

  complete(id: string, result: Record<string, unknown>): McpV11Task {
    const task = this.require(id);
    if (isMcpV11TaskTerminal(task.status)) {
      throw new McpV11TaskError('task-terminal', `Task "${id}" is already ${task.status}.`);
    }
    task.status = 'completed';
    task.result = result;
    task.progress = 100;
    task.updatedAtMs = Date.now();
    return task;
  }

  fail(id: string, error: string): McpV11Task {
    const task = this.require(id);
    if (isMcpV11TaskTerminal(task.status)) {
      throw new McpV11TaskError('task-terminal', `Task "${id}" is already ${task.status}.`);
    }
    task.status = 'failed';
    task.error = error;
    task.updatedAtMs = Date.now();
    return task;
  }

  cancel(id: string): McpV11Task {
    const task = this.require(id);
    if (isMcpV11TaskTerminal(task.status)) {
      throw new McpV11TaskError('task-terminal', `Task "${id}" is already ${task.status}.`);
    }
    task.status = 'cancelled';
    task.updatedAtMs = Date.now();
    return task;
  }

  /**
   * Expire stale tasks: a task past its TTL that never reached
   * a terminal state fails closed (never left hanging).
   * Returns the ids that were expired.
   */
  sweep(nowMs: number = Date.now()): string[] {
    const expired: string[] = [];
    for (const task of this.tasks.values()) {
      if (!isMcpV11TaskTerminal(task.status) && nowMs > task.expiresAtMs) {
        task.status = 'failed';
        task.error = 'Task expired: no terminal state within its TTL.';
        task.updatedAtMs = nowMs;
        expired.push(task.id);
      }
    }
    return expired;
  }

  /** Serialisable snapshot (the host mirrors it; the store itself never writes to disk). */
  snapshot(): { tasks: McpV11Task[]; savedAtMs: number } {
    return { tasks: this.list(), savedAtMs: Date.now() };
  }

  /** Restore from a snapshot (replaces the whole store). */
  restore(snapshot: { tasks: McpV11Task[] }): number {
    this.tasks.clear();
    for (const task of snapshot.tasks ?? []) this.tasks.set(task.id, { ...task });
    return this.tasks.size;
  }
}

/** Handler context handed to a task handler. */
export interface McpV11TaskContext {
  taskId: string;
  /** Report progress (0..100). */
  progress: (percent: number, message: string) => void;
  /** True when the task was cancelled while the handler ran. */
  isCancelled: () => boolean;
}

/** A task handler: (input, ctx) => result. */
export type McpV11TaskHandler = (
  input: Record<string, unknown>,
  ctx: McpV11TaskContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * Task engine: creates tasks from a handler and runs the
 * handler in the background. The caller gets the task id
 * immediately and polls `tasks/get` — exactly the MCP 2.0
 * Tasks extension shape.
 */
export class McpV11TaskEngine {
  readonly store: McpV11TaskStore;

  constructor(store?: McpV11TaskStore) {
    this.store = store ?? new McpV11TaskStore();
  }

  /** Create a task and start its handler in the background. */
  create(kind: string, input: Record<string, unknown>, handler: McpV11TaskHandler): McpV11Task {
    const task = this.store.create(kind, input);
    this.store.setStatus(task.id, 'running');
    const ctx: McpV11TaskContext = {
      taskId: task.id,
      progress: (percent, message) => {
        try {
          this.store.progress(task.id, percent, message);
        } catch {
          // Task went terminal (cancelled) — the handler's isCancelled() sees it.
        }
      },
      isCancelled: () => {
        const current = this.store.get(task.id);
        return current?.status === 'cancelled';
      },
    };
    void Promise.resolve()
      .then(() => handler({ ...input }, ctx))
      .then((result) => {
        const current = this.store.get(task.id);
        if (!current || isMcpV11TaskTerminal(current.status)) return;
        this.store.complete(task.id, result ?? {});
      })
      .catch((err) => {
        const current = this.store.get(task.id);
        if (!current || isMcpV11TaskTerminal(current.status)) return;
        this.store.fail(task.id, (err as Error).message ?? String(err));
      });
    return task;
  }

  /** `tasks/get`: the poll endpoint. */
  get(id: string): McpV11Task {
    return this.store.require(id);
  }

  /** `tasks/list`: optionally filtered by status. */
  list(status?: McpV11TaskStatus): McpV11Task[] {
    return this.store.list(status);
  }

  /** `tasks/cancel`. */
  cancel(id: string): McpV11Task {
    return this.store.cancel(id);
  }

  counts(): McpV11TaskCounts {
    return this.store.counts();
  }
}

/**
 * Poll `tasks/get` until the task is terminal.
 * Resolves with the terminal task; rejects with
 * `poll-timeout` when `maxPolls` runs out first.
 */
export async function pollMcpV11Task(
  engine: McpV11TaskEngine,
  id: string,
  opts: { intervalMs?: number; maxPolls?: number } = {},
): Promise<McpV11Task> {
  const intervalMs = opts.intervalMs ?? 25;
  const maxPolls = opts.maxPolls ?? 120;
  for (let poll = 0; poll < maxPolls; poll++) {
    const task = engine.get(id);
    if (isMcpV11TaskTerminal(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new McpV11TaskError('poll-timeout', `poll-timeout: Task "${id}" did not reach a terminal state after ${maxPolls} polls.`);
}
