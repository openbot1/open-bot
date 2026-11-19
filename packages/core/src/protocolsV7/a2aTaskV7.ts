/**
 * Protocols v7 — A2A v1.0.1 long-running task lifecycle (v1.38, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v138.md: ACP's stateful / async long-task
 * ideas were contributed to A2A when ACP merged in (08/2025), and
 * A2A v1.0.1 is the first stable release carrying them. This
 * module is the complete v7 task layer:
 *
 *   - `A2A_V7_TASK_TRANSITIONS` — the legal state machine
 *     (submitted → working → input-required → working …
 *     → completed / failed / canceled / rejected; terminal
 *     states never move again).
 *   - `A2aV7TaskStore` — persistent task store: create / get /
 *     list (by tenant, status, context), history + artifacts,
 *     JSON snapshot / restore (the host mirrors it to disk),
 *     expiry pruning of terminal tasks.
 *   - `A2aV7TaskEngine` — async execution: an injected runner
 *     does the work, the engine tracks state, supports cancel
 *     (AbortSignal), input-required pauses with resume, per-task
 *     timeouts, and push-notification hooks for state changes.
 *   - Push notification configs (`tasks/pushNotificationConfig/*`)
 *     live here too: a task may carry a webhook URL the agent
 *     calls when the task changes state (loopback in tests).
 *
 * No code, text or asset from any other repo is copied here.
 * No network, no process spawning: the runner is injected and
 * push delivery is a host-supplied callback.
 */

import { randomUUID } from 'node:crypto';
import {
  A2A_V7_DEFAULT_TENANT,
  A2A_V7_TERMINAL_TASK_STATES,
  type A2aV7TaskState,
} from './versions';
import { normalizeA2aV7TenantId } from './a2aCardV7';

/** Legal transitions of the A2A v1.0.1 task state machine. */
export const A2A_V7_TASK_TRANSITIONS: Record<A2aV7TaskState, readonly A2aV7TaskState[]> = {
  // A submitted task may fail before it ever starts (e.g. its
  // deadline passes while queued) — that is a real failure, not
  // a cancel: the sweep marks it failed, never completed.
  submitted: ['working', 'input-required', 'canceled', 'rejected', 'failed'],
  working: ['working', 'input-required', 'completed', 'failed', 'canceled'],
  'input-required': ['working', 'canceled', 'failed'],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
};

/** True when the state is terminal (no further transition is legal). */
export function isA2aV7TaskTerminal(state: A2aV7TaskState): boolean {
  return (A2A_V7_TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/** True when the transition is legal. */
export function isA2aV7TaskTransitionLegal(from: A2aV7TaskState, to: A2aV7TaskState): boolean {
  return (A2A_V7_TASK_TRANSITIONS[from] as readonly A2aV7TaskState[]).includes(to);
}

/** Error raised by the v7 task layer. */
export class A2aV7TaskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2aV7TaskError';
    this.code = code;
  }
}

/** One part of a message / artifact (text, file, or data). */
export interface A2aV7Part {
  kind: 'text' | 'file' | 'data';
  /** Text content (kind=text) or file name (kind=file). */
  text?: string;
  /** File bytes as base64 (kind=file) or JSON data (kind=data). */
  data?: unknown;
  /** MIME type for file / data parts. */
  mimeType?: string;
  /** File URI (kind=file, when the bytes live elsewhere). */
  uri?: string;
}

/** One message in a task's history. */
export interface A2aV7Message {
  messageId: string;
  role: 'user' | 'agent';
  parts: A2aV7Part[];
  /** Task this message belongs to. */
  taskId: string;
  /** Conversation this task belongs to. */
  contextId: string;
  /** Creation time (ms since epoch). */
  createdAtMs: number;
  /** Free-form metadata (never credentials). */
  metadata?: Record<string, unknown>;
}

/** One artifact produced by a task. */
export interface A2aV7Artifact {
  artifactId: string;
  /** Human-readable artifact name. */
  name: string;
  /** Short description of the artifact. */
  description?: string;
  parts: A2aV7Part[];
  /** Creation time (ms since epoch). */
  createdAtMs: number;
  /** Free-form metadata (never credentials). */
  metadata?: Record<string, unknown>;
}

/** Push notification config for a task (webhook called on state change). */
export interface A2aV7PushNotificationConfig {
  /** Config id. */
  id: string;
  /** Task this config belongs to. */
  taskId: string;
  /** Webhook URL (https, or http on loopback). */
  url: string;
  /** Optional bearer token id (the token itself is never stored here). */
  tokenId?: string;
  /** States that trigger a push (empty = all state changes). */
  states?: A2aV7TaskState[];
  /** Creation time (ms since epoch). */
  createdAtMs: number;
}

/** One entry in a task's status history. */
export interface A2aV7StatusChange {
  state: A2aV7TaskState;
  atMs: number;
  /** Why the task moved (free text, e.g. "runner finished"). */
  reason?: string;
  /** Message attached to the transition (input-required prompt, failure text). */
  message?: string;
}

/** An A2A v1.0.1 task. */
export interface A2aV7Task {
  id: string;
  /** Conversation this task belongs to. */
  contextId: string;
  /** Tenant this task belongs to (multi-tenancy). */
  tenant: string;
  /** Current state. */
  status: A2aV7TaskState;
  /** Full message history (user + agent). */
  history: A2aV7Message[];
  /** Artifacts produced so far. */
  artifacts: A2aV7Artifact[];
  /** Status history (every transition, oldest first). */
  statusHistory: A2aV7StatusChange[];
  /** Push notification configs for this task. */
  pushConfigs: A2aV7PushNotificationConfig[];
  /** Creation time (ms since epoch). */
  createdAtMs: number;
  /** Last update time (ms since epoch). */
  updatedAtMs: number;
  /** Deadline (ms since epoch; undefined = no deadline). */
  deadlineMs?: number;
  /** Free-form metadata (never credentials). */
  metadata?: Record<string, unknown>;
}

/** Input for creating a task. */
export interface A2aV7TaskInput {
  /** Task id override (default: random UUID). */
  id?: string;
  /** Conversation id (default: random UUID). */
  contextId?: string;
  /** Tenant (default: `default`). */
  tenant?: string;
  /** First user message (text). */
  message?: string;
  /** First message parts (when richer than plain text). */
  parts?: A2aV7Part[];
  /** Deadline in ms from now (undefined = no deadline). */
  timeoutMs?: number;
  /** Free-form metadata. */
  metadata?: Record<string, unknown>;
}

/** Build one text part. */
export function a2aV7TextPart(text: string): A2aV7Part {
  return { kind: 'text', text };
}

/** Build one message (id generated when omitted). */
export function buildA2aV7Message(
  role: 'user' | 'agent',
  parts: A2aV7Part[],
  taskId: string,
  contextId: string,
  messageId?: string,
): A2aV7Message {
  return {
    messageId: messageId ?? `msg-${randomUUID()}`,
    role,
    parts: parts.map((p) => ({ ...p })),
    taskId,
    contextId,
    createdAtMs: Date.now(),
  };
}

/**
 * Persistent task store. All state lives in memory; `snapshot()`
 * / `restore()` move it as JSON so the host can mirror it to
 * disk. Nothing here touches the network or the filesystem.
 */
export class A2aV7TaskStore {
  private tasks = new Map<string, A2aV7Task>();

  /** Create a task in `submitted` (copies the input). */
  create(input: A2aV7TaskInput = {}): A2aV7Task {
    const now = Date.now();
    const id = input.id ?? `task-${randomUUID()}`;
    if (this.tasks.has(id)) {
      throw new A2aV7TaskError('duplicate-task', `Task ${id} already exists.`);
    }
    const contextId = input.contextId ?? `ctx-${randomUUID()}`;
    const tenant = normalizeA2aV7TenantId(input.tenant);
    const parts = input.parts ?? (input.message !== undefined ? [a2aV7TextPart(input.message)] : []);
    const task: A2aV7Task = {
      id,
      contextId,
      tenant,
      status: 'submitted',
      history: [],
      artifacts: [],
      statusHistory: [{ state: 'submitted', atMs: now, reason: 'created' }],
      pushConfigs: [],
      createdAtMs: now,
      updatedAtMs: now,
      deadlineMs: input.timeoutMs !== undefined ? now + input.timeoutMs : undefined,
      metadata: input.metadata ? { ...input.metadata } : undefined,
    };
    if (parts.length > 0) {
      task.history.push(buildA2aV7Message('user', parts, id, contextId));
    }
    this.tasks.set(id, task);
    return this.copy(task);
  }

  /** Get a task by id (null when missing). */
  get(id: string): A2aV7Task | null {
    const task = this.tasks.get(id);
    return task ? this.copy(task) : null;
  }

  /** True when the task exists. */
  has(id: string): boolean {
    return this.tasks.has(id);
  }

  /** Number of tasks in the store. */
  size(): number {
    return this.tasks.size;
  }

  /** List tasks, optionally filtered (newest first). */
  list(filter: {
    tenant?: string;
    status?: A2aV7TaskState;
    contextId?: string;
    limit?: number;
  } = {}): A2aV7Task[] {
    const out: A2aV7Task[] = [];
    for (const task of this.tasks.values()) {
      if (filter.tenant !== undefined && task.tenant !== normalizeA2aV7TenantId(filter.tenant)) continue;
      if (filter.status !== undefined && task.status !== filter.status) continue;
      if (filter.contextId !== undefined && task.contextId !== filter.contextId) continue;
      out.push(task);
    }
    out.sort((a, b) => b.createdAtMs - a.createdAtMs);
    const limited = filter.limit !== undefined ? out.slice(0, Math.max(0, filter.limit)) : out;
    return limited.map((t) => this.copy(t));
  }

  /** Move a task to a new state (illegal transitions throw). */
  transition(id: string, to: A2aV7TaskState, reason?: string, message?: string): A2aV7Task {
    const task = this.tasks.get(id);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${id} does not exist.`);
    if (task.status === to && to !== 'working') {
      throw new A2aV7TaskError('illegal-transition', `Task ${id} is already ${to}.`);
    }
    if (!isA2aV7TaskTransitionLegal(task.status, to)) {
      throw new A2aV7TaskError(
        'illegal-transition',
        `Task ${id} cannot move from ${task.status} to ${to}.`,
      );
    }
    task.status = to;
    task.updatedAtMs = Date.now();
    task.statusHistory.push({ state: to, atMs: task.updatedAtMs, reason, message });
    return this.copy(task);
  }

  /** Append a message to a task's history (terminal tasks refuse new messages). */
  addMessage(id: string, message: A2aV7Message): A2aV7Task {
    const task = this.tasks.get(id);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${id} does not exist.`);
    if (isA2aV7TaskTerminal(task.status)) {
      throw new A2aV7TaskError('task-terminal', `Task ${id} is ${task.status} and takes no more messages.`);
    }
    if (message.taskId !== id) {
      throw new A2aV7TaskError('message-mismatch', `Message belongs to task ${message.taskId}, not ${id}.`);
    }
    task.history.push({ ...message, parts: message.parts.map((p) => ({ ...p })) });
    task.updatedAtMs = Date.now();
    return this.copy(task);
  }

  /** Attach an artifact to a task (terminal tasks refuse new artifacts). */
  addArtifact(id: string, artifact: A2aV7Artifact): A2aV7Task {
    const task = this.tasks.get(id);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${id} does not exist.`);
    if (isA2aV7TaskTerminal(task.status)) {
      throw new A2aV7TaskError('task-terminal', `Task ${id} is ${task.status} and takes no more artifacts.`);
    }
    if (task.artifacts.some((a) => a.artifactId === artifact.artifactId)) {
      throw new A2aV7TaskError('duplicate-artifact', `Artifact ${artifact.artifactId} already exists on task ${id}.`);
    }
    task.artifacts.push({ ...artifact, parts: artifact.parts.map((p) => ({ ...p })) });
    task.updatedAtMs = Date.now();
    return this.copy(task);
  }

  /** Set (or replace) a task's deadline. */
  setDeadline(id: string, deadlineMs: number | undefined): A2aV7Task {
    const task = this.tasks.get(id);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${id} does not exist.`);
    task.deadlineMs = deadlineMs;
    task.updatedAtMs = Date.now();
    return this.copy(task);
  }

  /** True when the task's deadline has passed (and it is not terminal yet). */
  isOverdue(id: string, nowMs: number = Date.now()): boolean {
    const task = this.tasks.get(id);
    if (!task || task.deadlineMs === undefined) return false;
    return !isA2aV7TaskTerminal(task.status) && nowMs > task.deadlineMs;
  }

  /** Add a push notification config to a task. */
  addPushConfig(taskId: string, url: string, options: { tokenId?: string; states?: A2aV7TaskState[] } = {}): A2aV7PushNotificationConfig {
    const task = this.tasks.get(taskId);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${taskId} does not exist.`);
    if (!isValidA2aV7PushUrl(url)) {
      throw new A2aV7TaskError('invalid-push-url', 'Push URL must be https, or http on loopback.');
    }
    const config: A2aV7PushNotificationConfig = {
      id: `push-${randomUUID()}`,
      taskId,
      url,
      tokenId: options.tokenId,
      states: options.states ? [...options.states] : undefined,
      createdAtMs: Date.now(),
    };
    task.pushConfigs.push(config);
    task.updatedAtMs = Date.now();
    return { ...config };
  }

  /** List a task's push configs (empty when none). */
  listPushConfigs(taskId: string): A2aV7PushNotificationConfig[] {
    const task = this.tasks.get(taskId);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${taskId} does not exist.`);
    return task.pushConfigs.map((c) => ({ ...c }));
  }

  /** Remove one push config (false when missing). */
  removePushConfig(taskId: string, configId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${taskId} does not exist.`);
    const idx = task.pushConfigs.findIndex((c) => c.id === configId);
    if (idx === -1) return false;
    task.pushConfigs.splice(idx, 1);
    task.updatedAtMs = Date.now();
    return true;
  }

  /** Delete a task outright (false when missing). */
  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  /** Drop terminal tasks older than `olderThanMs` (returns how many were dropped). */
  pruneTerminal(olderThanMs: number, nowMs: number = Date.now()): number {
    let n = 0;
    for (const [id, task] of this.tasks) {
      if (isA2aV7TaskTerminal(task.status) && nowMs - task.updatedAtMs > olderThanMs) {
        this.tasks.delete(id);
        n += 1;
      }
    }
    return n;
  }

  /** Counts by status (for the UI). */
  countsByStatus(tenant?: string): Record<A2aV7TaskState, number> {
    const counts: Record<A2aV7TaskState, number> = {
      submitted: 0,
      working: 0,
      'input-required': 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      rejected: 0,
    };
    for (const task of this.tasks.values()) {
      if (tenant !== undefined && task.tenant !== normalizeA2aV7TenantId(tenant)) continue;
      counts[task.status] += 1;
    }
    return counts;
  }

  /** Serialise all tasks as JSON (host mirrors it to disk). */
  snapshot(): string {
    return JSON.stringify([...this.tasks.values()], null, 2);
  }

  /** Restore tasks from a snapshot (replaces the store; validates shape). */
  restore(snapshotJson: string): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(snapshotJson) as unknown;
    } catch {
      throw new A2aV7TaskError('bad-snapshot', 'Task snapshot is not valid JSON.');
    }
    if (!Array.isArray(parsed)) {
      throw new A2aV7TaskError('bad-snapshot', 'Task snapshot must be a JSON array of tasks.');
    }
    const next = new Map<string, A2aV7Task>();
    for (const raw of parsed) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new A2aV7TaskError('bad-snapshot', 'Task snapshot entries must be task objects.');
      }
      const t = raw as Record<string, unknown>;
      if (typeof t.id !== 'string' || typeof t.status !== 'string'
        || !(A2A_V7_TERMINAL_TASK_STATES as readonly string[]).includes(t.status)
        && !['submitted', 'working', 'input-required'].includes(t.status as string)) {
        throw new A2aV7TaskError('bad-snapshot', 'Task snapshot entry has an invalid id or status.');
      }
      if (typeof t.contextId !== 'string' || typeof t.tenant !== 'string'
        || !Array.isArray(t.history) || !Array.isArray(t.artifacts)
        || !Array.isArray(t.statusHistory) || !Array.isArray(t.pushConfigs)
        || typeof t.createdAtMs !== 'number' || typeof t.updatedAtMs !== 'number') {
        throw new A2aV7TaskError('bad-snapshot', `Task snapshot entry ${String(t.id)} is missing required fields.`);
      }
      next.set(t.id as string, raw as A2aV7Task);
    }
    this.tasks = next;
    return next.size;
  }

  private copy(task: A2aV7Task): A2aV7Task {
    return {
      ...task,
      history: task.history.map((m) => ({ ...m, parts: m.parts.map((p) => ({ ...p })) })),
      artifacts: task.artifacts.map((a) => ({ ...a, parts: a.parts.map((p) => ({ ...p })) })),
      statusHistory: task.statusHistory.map((s) => ({ ...s })),
      pushConfigs: task.pushConfigs.map((c) => ({ ...c })),
      metadata: task.metadata ? { ...task.metadata } : undefined,
    };
  }
}

/** True when the push URL may be used (https, or http on loopback). */
export function isValidA2aV7PushUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  }
  return false;
}

/** What the injected runner returns when it finishes a task. */
export interface A2aV7RunnerResult {
  /** Final agent message (text). */
  text: string;
  /** Artifacts to attach (optional). */
  artifacts?: A2aV7Artifact[];
  /** True when the runner needs more user input instead of finishing. */
  needsInput?: boolean;
  /** The question / prompt to show the user when input is needed. */
  inputPrompt?: string;
}

/** The injected agent runner: does the work for one task. */
export type A2aV7Runner = (
  task: A2aV7Task,
  signal: AbortSignal,
) => Promise<A2aV7RunnerResult>;

/** Push delivery: called when a task changes state (host-supplied). */
export type A2aV7PushDeliver = (
  config: A2aV7PushNotificationConfig,
  task: A2aV7Task,
) => Promise<void> | void;

/** Engine options. */
export interface A2aV7TaskEngineOptions {
  /** Default per-task timeout in ms (undefined = no timeout). */
  defaultTimeoutMs?: number;
  /** Push delivery hook (undefined = push configs recorded but never delivered). */
  onPush?: A2aV7PushDeliver;
  /** Tenant the engine serves (default: all tenants). */
  tenant?: string;
}

/** One running task (engine bookkeeping). */
export interface A2aV7RunningTask {
  taskId: string;
  startedAtMs: number;
  /** Resolves when the task reaches a terminal state. */
  done: Promise<A2aV7Task>;
}

/**
 * Task engine: runs tasks asynchronously with an injected
 * runner. `run()` starts the work and returns immediately with
 * a handle; the task moves submitted → working → completed /
 * failed / input-required, and `resume()` continues an
 * input-required task with the user's answer. `cancel()` aborts
 * the runner via AbortSignal and marks the task canceled.
 * State changes fire push delivery for matching configs.
 */
export class A2aV7TaskEngine {
  private store: A2aV7TaskStore;
  private runner: A2aV7Runner;
  private options: A2aV7TaskEngineOptions;
  private running = new Map<string, { controller: AbortController; done: Promise<A2aV7Task>; timeout?: NodeJS.Timeout }>();
  private pushLog: { configId: string; taskId: string; state: A2aV7TaskState; atMs: number; delivered: boolean; error?: string }[] = [];

  constructor(store: A2aV7TaskStore, runner: A2aV7Runner, options: A2aV7TaskEngineOptions = {}) {
    this.store = store;
    this.runner = runner;
    this.options = { ...options };
  }

  /** The store this engine drives. */
  getStore(): A2aV7TaskStore {
    return this.store;
  }

  /** Task ids currently running. */
  runningTaskIds(): string[] {
    return [...this.running.keys()];
  }

  /** True when the task is currently running. */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Push delivery log (copies). */
  getPushLog(): { configId: string; taskId: string; state: A2aV7TaskState; atMs: number; delivered: boolean; error?: string }[] {
    return this.pushLog.map((e) => ({ ...e }));
  }

  /** Create a task and start it (returns the task + a done promise). */
  submit(input: A2aV7TaskInput = {}): A2aV7RunningTask {
    const task = this.store.create(input);
    return this.start(task.id);
  }

  /** Start an existing submitted task. */
  start(taskId: string): A2aV7RunningTask {
    const task = this.store.get(taskId);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${taskId} does not exist.`);
    if (this.options.tenant !== undefined && task.tenant !== normalizeA2aV7TenantId(this.options.tenant)) {
      throw new A2aV7TaskError('tenant-mismatch', `Engine serves tenant "${this.options.tenant}", not "${task.tenant}".`);
    }
    if (task.status !== 'submitted' && task.status !== 'input-required') {
      throw new A2aV7TaskError('not-startable', `Task ${taskId} is ${task.status} and cannot start.`);
    }
    if (this.running.has(taskId)) {
      throw new A2aV7TaskError('already-running', `Task ${taskId} is already running.`);
    }
    const controller = new AbortController();
    const timeoutMs = this.options.defaultTimeoutMs;
    let timeout: NodeJS.Timeout | undefined;
    const done = this.execute(taskId, controller.signal, timeoutMs);
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeout = setTimeout(() => {
        controller.abort(new Error(`Task ${taskId} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      if (typeof timeout.unref === 'function') timeout.unref();
    }
    this.running.set(taskId, { controller, done, timeout });
    void done.finally(() => {
      const entry = this.running.get(taskId);
      if (entry?.timeout) clearTimeout(entry.timeout);
      if (entry?.done === done) this.running.delete(taskId);
    });
    return { taskId, startedAtMs: Date.now(), done };
  }

  /** Cancel a running (or submitted / input-required) task. */
  cancel(taskId: string, reason = 'canceled by caller'): A2aV7Task {
    const task = this.store.get(taskId);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${taskId} does not exist.`);
    if (isA2aV7TaskTerminal(task.status)) {
      throw new A2aV7TaskError('task-terminal', `Task ${taskId} is already ${task.status}.`);
    }
    const entry = this.running.get(taskId);
    if (entry) {
      entry.controller.abort(new Error(reason));
      if (entry.timeout) clearTimeout(entry.timeout);
    }
    const updated = this.store.transition(taskId, 'canceled', reason);
    void this.deliverPush(updated);
    return updated;
  }

  /** Resume an input-required task with the user's answer. */
  resume(taskId: string, answer: string): A2aV7RunningTask {
    const task = this.store.get(taskId);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${taskId} does not exist.`);
    if (task.status !== 'input-required') {
      throw new A2aV7TaskError('not-waiting', `Task ${taskId} is ${task.status}, not input-required.`);
    }
    this.store.addMessage(taskId, buildA2aV7Message('user', [a2aV7TextPart(answer)], taskId, task.contextId));
    return this.start(taskId);
  }

  /** Mark tasks whose deadline passed as failed (sweep; returns how many). */
  sweepOverdue(nowMs: number = Date.now()): number {
    let n = 0;
    for (const task of this.store.list()) {
      if (this.store.isOverdue(task.id, nowMs)) {
        const entry = this.running.get(task.id);
        if (entry) entry.controller.abort(new Error(`Task ${task.id} exceeded its deadline.`));
        this.store.transition(task.id, 'failed', 'deadline exceeded');
        n += 1;
      }
    }
    return n;
  }

  private async execute(
    taskId: string,
    signal: AbortSignal,
    _timeoutMs: number | undefined,
  ): Promise<A2aV7Task> {
    let task = this.store.get(taskId);
    if (!task) throw new A2aV7TaskError('task-not-found', `Task ${taskId} does not exist.`);
    this.store.transition(taskId, 'working', 'runner started');
    await this.deliverPush(this.store.get(taskId) as A2aV7Task);
    try {
      task = this.store.get(taskId) as A2aV7Task;
      const result = await this.runner(task, signal);
      if (signal.aborted) {
        return this.finishCanceled(taskId, 'runner aborted');
      }
      if (result.needsInput) {
        const updated = this.store.transition(taskId, 'input-required', 'runner needs input', result.inputPrompt);
        await this.deliverPush(updated);
        return updated;
      }
      for (const artifact of result.artifacts ?? []) {
        this.store.addArtifact(taskId, artifact);
      }
      this.store.addMessage(
        taskId,
        buildA2aV7Message('agent', [a2aV7TextPart(result.text)], taskId, task.contextId),
      );
      const finished = this.store.transition(taskId, 'completed', 'runner finished');
      await this.deliverPush(finished);
      return finished;
    } catch (err) {
      const current = this.store.get(taskId);
      if (!current) throw err;
      if (isA2aV7TaskTerminal(current.status)) return current;
      if (signal.aborted) {
        return this.finishCanceled(taskId, err instanceof Error ? err.message : 'aborted');
      }
      const failed = this.store.transition(
        taskId,
        'failed',
        'runner failed',
        err instanceof Error ? err.message : String(err),
      );
      await this.deliverPush(failed);
      return failed;
    }
  }

  private finishCanceled(taskId: string, reason: string): A2aV7Task {
    const current = this.store.get(taskId);
    if (!current) throw new A2aV7TaskError('task-not-found', `Task ${taskId} does not exist.`);
    if (isA2aV7TaskTerminal(current.status)) return current;
    const canceled = this.store.transition(taskId, 'canceled', reason);
    void this.deliverPush(canceled);
    return canceled;
  }

  private async deliverPush(task: A2aV7Task): Promise<void> {
    const deliver = this.options.onPush;
    if (!deliver) return;
    for (const config of task.pushConfigs) {
      if (config.states && config.states.length > 0 && !config.states.includes(task.status)) continue;
      try {
        await deliver(config, task);
        this.pushLog.push({ configId: config.id, taskId: task.id, state: task.status, atMs: Date.now(), delivered: true });
      } catch (err) {
        this.pushLog.push({
          configId: config.id,
          taskId: task.id,
          state: task.status,
          atMs: Date.now(),
          delivered: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/** One-line summary of a task, for logs and the UI. */
export function summarizeA2aV7Task(task: A2aV7Task): string {
  const last = task.history[task.history.length - 1];
  const preview = last?.parts.find((p) => p.kind === 'text')?.text ?? '';
  const short = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
  return `${task.id} [${task.tenant}] ${task.status} — ${task.artifacts.length} artifact(s)${short ? ` — "${short}"` : ''}`;
}

/** Default tenant for tasks (same value as the card layer). */
export const A2A_V7_TASK_DEFAULT_TENANT = A2A_V7_DEFAULT_TENANT;
