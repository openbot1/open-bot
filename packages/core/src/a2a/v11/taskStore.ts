/**
 * A2A v1.0 task store + lifecycle (v11 generation).
 *
 * A task moves through the A2A 1.0 states (bare form kept locally,
 * `task/<state>` on the wire):
 *
 *   submitted -> working -> completed | failed | cancelled | rejected
 *   working   -> input-required -> working | completed | failed | cancelled
 *   submitted -> input-required | cancelled | rejected
 *
 * Rules enforced here (fail-closed, never silent):
 *  - No transition out of a terminal state, ever.
 *  - `input-required` is the only way a task waits for the user; a
 *    task that needs input must say so explicitly instead of stalling
 *    in `working` forever.
 *  - Every transition is appended to the task's history (with a
 *    timestamp and optional message) so state-transition history is
 *    always available to GetTask / subscribers.
 *  - `ListTasks` pagination uses opaque cursors: the cursor is a
 *    base64url JSON blob `{ offset }` — no ids leak, no page can be
 *    forged into a different slice.
 */

import {
  V11_TERMINAL_TASK_STATES,
  fromV11WireState,
  isV11TerminalState,
  type V11Artifact,
  type V11ListTasksFilter,
  type V11Message,
  type V11Task,
  type V11TaskPage,
  type V11TaskState,
} from './types';
import { v11Base64UrlDecode, v11Base64UrlEncode } from './signing';

/** Legal transitions out of each state (empty = terminal). */
export const V11_TASK_TRANSITIONS: Record<V11TaskState, readonly V11TaskState[]> = {
  submitted: ['working', 'input-required', 'cancelled', 'rejected'],
  working: ['working', 'input-required', 'completed', 'failed', 'cancelled'],
  'input-required': ['working', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  rejected: [],
};

/** True when `from -> to` is a legal lifecycle step. */
export function isV11LegalTransition(from: V11TaskState, to: V11TaskState): boolean {
  if (from === to && from === 'working') return true; // progress update
  return (V11_TASK_TRANSITIONS[from] as readonly V11TaskState[]).includes(to);
}

/** Error thrown when a transition is illegal. */
export class V11TaskTransitionError extends Error {
  readonly from: V11TaskState;
  readonly to: V11TaskState;

  constructor(from: V11TaskState, to: V11TaskState) {
    super(`illegal task transition: ${from} -> ${to}`);
    this.name = 'V11TaskTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Options for creating a task. */
export interface V11CreateTaskOptions {
  id?: string;
  contextId?: string;
  tenantId?: string;
  peerId?: string;
  metadata?: Record<string, unknown>;
  /** First message (the user's request) — recorded, not executed. */
  initialMessage?: V11Message;
  now?: Date;
}

let v11TaskCounter = 0;

export function v11NewTaskId(): string {
  v11TaskCounter += 1;
  return `task-v11-${Date.now().toString(36)}-${v11TaskCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function v11NewContextId(): string {
  return `ctx-v11-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Build a fresh task in `submitted`. */
export function createV11Task(options: V11CreateTaskOptions = {}): V11Task {
  const now = (options.now ?? new Date()).toISOString();
  return {
    id: options.id ?? v11NewTaskId(),
    contextId: options.contextId ?? v11NewContextId(),
    state: 'submitted',
    history: [{ state: 'submitted', at: now }],
    artifacts: [],
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.peerId !== undefined ? { peerId: options.peerId } : {}),
    ...(options.initialMessage ? { lastMessage: options.initialMessage } : {}),
    createdAt: now,
    updatedAt: now,
    ...(options.metadata !== undefined ? { metadata: { ...options.metadata } } : {}),
  };
}

/**
 * Move a task to a new state. Returns a NEW task object (the input is
 * not mutated) with history appended. Throws V11TaskTransitionError
 * on an illegal step. Accepts bare or `task/`-prefixed states.
 */
export function transitionV11Task(
  task: V11Task,
  toRaw: V11TaskState | string,
  message?: string,
  now: Date = new Date(),
): V11Task {
  const to = fromV11WireState(toRaw);
  if (!to) throw new V11TaskTransitionError(task.state, task.state);
  if (!isV11LegalTransition(task.state, to)) {
    throw new V11TaskTransitionError(task.state, to);
  }
  const at = now.toISOString();
  return {
    ...task,
    state: to,
    history: [...(task.history ?? []), { state: to, at, ...(message ? { message } : {}) }],
    updatedAt: at,
    ...(message !== undefined ? { statusMessage: message } : {}),
  };
}

/** Attach an artifact to a task (returns a new task object). */
export function addV11ArtifactToTask(task: V11Task, artifact: V11Artifact): V11Task {
  return {
    ...task,
    artifacts: [...(task.artifacts ?? []), artifact],
    updatedAt: new Date().toISOString(),
  };
}

/** Record the latest agent message on a task. */
export function setV11TaskMessage(task: V11Task, message: V11Message): V11Task {
  return { ...task, lastMessage: message, updatedAt: new Date().toISOString() };
}

/** In-memory task store. Single-process; the server persists via hooks. */
export class V11TaskStore {
  private readonly tasks = new Map<string, V11Task>();
  private readonly order: string[] = [];

  /** Create + store a task. Duplicate id = error (never overwrite). */
  create(options: V11CreateTaskOptions = {}): V11Task {
    const task = createV11Task(options);
    if (this.tasks.has(task.id)) {
      throw new Error(`task already exists: ${task.id}`);
    }
    this.tasks.set(task.id, task);
    this.order.push(task.id);
    return task;
  }

  get(id: string): V11Task | undefined {
    return this.tasks.get(id);
  }

  /** Replace a task (used after a transition). Unknown id = error. */
  put(task: V11Task): V11Task {
    if (!this.tasks.has(task.id)) throw new Error(`unknown task: ${task.id}`);
    this.tasks.set(task.id, task);
    return task;
  }

  /**
   * Transition a stored task. Throws on unknown id or illegal step.
   * Returns the updated task.
   */
  transition(id: string, to: V11TaskState | string, message?: string, now?: Date): V11Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    const next = transitionV11Task(task, to, message, now);
    this.tasks.set(id, next);
    return next;
  }

  addArtifact(id: string, artifact: V11Artifact): V11Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    const next = addV11ArtifactToTask(task, artifact);
    this.tasks.set(id, next);
    return next;
  }

  setMessage(id: string, message: V11Message): V11Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    const next = setV11TaskMessage(task, message);
    this.tasks.set(id, next);
    return next;
  }

  /** All tasks in creation order (oldest first). */
  all(): V11Task[] {
    return this.order.map((id) => this.tasks.get(id) as V11Task);
  }

  count(): number {
    return this.tasks.size;
  }

  /** Tasks currently waiting for user input. */
  awaitingInput(): V11Task[] {
    return this.all().filter((t) => t.state === 'input-required');
  }

  /** Tasks that are still active (not terminal). */
  active(): V11Task[] {
    return this.all().filter((t) => !isV11TerminalState(t.state));
  }

  /** Encode a list offset as an opaque cursor. */
  static encodeCursor(offset: number): string {
    return v11Base64UrlEncode(JSON.stringify({ offset, v: 1 }));
  }

  /** Decode a cursor back to an offset. Invalid cursor = offset 0. */
  static decodeCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    const raw = v11Base64UrlDecode(cursor);
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as { offset?: unknown; v?: unknown };
      if (parsed.v !== 1 || typeof parsed.offset !== 'number' || parsed.offset < 0) return 0;
      return Math.floor(parsed.offset);
    } catch {
      return 0;
    }
  }

  /**
   * ListTasks with cursor pagination (new in A2A 1.0). Filters first,
   * then slices by cursor + page size. `pageSize` is clamped to 1..100.
   */
  list(
    filter: V11ListTasksFilter = {},
    cursor?: string,
    pageSize = 20,
  ): V11TaskPage {
    const size = Math.max(1, Math.min(100, Math.floor(pageSize) || 20));
    const filtered = this.all().filter((t) => {
      if (filter.state !== undefined && t.state !== filter.state) return false;
      if (filter.tenantId !== undefined && t.tenantId !== filter.tenantId) return false;
      if (filter.peerId !== undefined && t.peerId !== filter.peerId) return false;
      if (filter.contextId !== undefined && t.contextId !== filter.contextId) return false;
      return true;
    });
    const offset = V11TaskStore.decodeCursor(cursor);
    const page = filtered.slice(offset, offset + size);
    const nextOffset = offset + page.length;
    return {
      tasks: page,
      totalCount: filtered.length,
      ...(nextOffset < filtered.length
        ? { nextCursor: V11TaskStore.encodeCursor(nextOffset) }
        : {}),
    };
  }

  /** Remove all tasks (tests / reset). */
  clear(): void {
    this.tasks.clear();
    this.order.length = 0;
  }

  /**
   * Prune terminal tasks whose last update is older than
   * `olderThanMs`. Live tasks are never pruned. Returns the ids that
   * were removed, oldest first. The store is otherwise unbounded, so
   * hosts should prune on a schedule (or the server refuses new
   * tasks at maxTasks).
   */
  pruneTerminal(olderThanMs: number, now: Date = new Date()): string[] {
    const cutoff = now.getTime() - Math.max(0, olderThanMs);
    const removed: string[] = [];
    for (const id of [...this.order]) {
      const task = this.tasks.get(id);
      if (!task) continue;
      if (!isV11TerminalState(task.state)) continue;
      if (new Date(task.updatedAt).getTime() > cutoff) continue;
      this.tasks.delete(id);
      removed.push(id);
    }
    if (removed.length > 0) {
      const gone = new Set(removed);
      for (let i = this.order.length - 1; i >= 0; i -= 1) {
        if (gone.has(this.order[i] as string)) this.order.splice(i, 1);
      }
    }
    return removed;
  }
}

/** Re-export for callers that only need the terminal check. */
export { V11_TERMINAL_TASK_STATES as V11TerminalStates };
