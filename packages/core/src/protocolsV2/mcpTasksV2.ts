/**
 * Protocols v2 — MCP Tasks long-running v2 (v1.16, Team T2).
 *
 * Idea only, learned from the public MCP Tasks extension
 * description in docs/repo-survey-v116.md section 3: a durable
 * task handle, poll for progress, resume after reconnect. No
 * code, text or asset from any other repo is copied here. This
 * builds on the v1.15 Tasks client (`protocols/mcpStateless.ts`)
 * and the persistent store (`mcp/taskStorePersistent.ts`) without
 * touching either: v1.15 polls a server-side task; v2 is the
 * server-side manager itself — it runs the work, persists every
 * state change to disk, and lets a client that disconnected
 * mid-task reconnect and resume polling the same durable id.
 *
 * Lifecycle: created -> running -> (input_required -> running)*
 *   -> completed | failed | cancelled. A task that is still
 *   `running` when the process restarts is marked `failed` with
 *   a truthful "server restarted" error on load — its runner died
 *   with the old process and cannot be resumed — while terminal
 *   tasks stay pollable. A task may instead be *resumable* when
 *   the runner is checkpoint-based: `resume()` re-runs it from
 *   its last checkpoint instead of from scratch.
 *
 * Retry policy: a failed attempt is retried only when the error
 * is marked retryable (transient) and attempts remain; the delay
 * grows exponentially (base * 2^attempt, capped) with a small
 * deterministic jitter so two tasks do not retry in lockstep.
 * A task-level timeout cancels the run; a per-attempt timeout
 * fails just that attempt (and may retry).
 *
 * Design rules:
 * - The task id is durable: it survives restart, reconnect and
 *   rename of nothing else. Clients poll by id, never by object.
 * - Every state change is snapshotted to disk atomically
 *   (tmp + rename) before any waiter is notified.
 * - Progress is events, not just a number: each progress report
 *   carries a message + a monotonic event sequence the client
 *   can resume from.
 * - Nothing here executes untrusted code: the runner is supplied
 *   by the host (a real tool runner); this module only schedules,
 *   times, retries and persists it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Task states in the v2 lifecycle. */
export const MCP_TASK_V2_STATES = [
  'created',
  'running',
  'input_required',
  'completed',
  'failed',
  'cancelled',
] as const;
export type McpTaskV2State = (typeof MCP_TASK_V2_STATES)[number];

/** Terminal states — a task in one of these never changes again. */
export const MCP_TASK_V2_TERMINAL_STATES: readonly McpTaskV2State[] = ['completed', 'failed', 'cancelled'];

export function isMcpTaskV2Terminal(state: McpTaskV2State): boolean {
  return (MCP_TASK_V2_TERMINAL_STATES as readonly McpTaskV2State[]).includes(state);
}

/** One progress event on a task. */
export interface McpTaskV2ProgressEvent {
  /** Monotonic per-task event counter (0-based). */
  sequence: number;
  /** 0..1, or null when the task cannot report a fraction. */
  progress: number | null;
  message: string;
  atMs: number;
}

/** Retry policy for one task. */
export interface McpTaskV2RetryPolicy {
  /** Maximum attempts including the first (default 1 = no retry). */
  maxAttempts: number;
  /** Delay before the first retry, ms (default 500). */
  baseDelayMs: number;
  /** Maximum delay between retries, ms (default 30_000). */
  maxDelayMs: number;
  /** Per-attempt timeout, ms (0 = no timeout). */
  attemptTimeoutMs: number;
  /** Whole-task timeout, ms (0 = no timeout). */
  taskTimeoutMs: number;
}

/** Default retry policy: one attempt, no timeouts. */
export const MCP_TASK_V2_DEFAULT_RETRY: McpTaskV2RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  attemptTimeoutMs: 0,
  taskTimeoutMs: 0,
};

/** Delay before attempt `attempt` (1-based retry count), with deterministic jitter. */
export function mcpTaskV2RetryDelayMs(policy: McpTaskV2RetryPolicy, attempt: number): number {
  const raw = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  // Deterministic jitter: +/-10% keyed on the attempt number, so
  // two tasks retrying at the same time still spread out.
  const jitter = ((attempt * 37) % 21 - 10) / 100;
  return Math.max(0, Math.round(capped * (1 + jitter)));
}

/** A durable task record (JSON-safe — this is what hits disk). */
export interface McpTaskV2Record {
  taskId: string;
  method: string;
  params: Record<string, unknown>;
  state: McpTaskV2State;
  result?: unknown;
  error?: string;
  /** True when the last failure is transient and may be retried. */
  retryable?: boolean;
  attempts: number;
  /** Checkpoint the runner saved; resume() restarts from here. */
  checkpoint?: unknown;
  hasCheckpoint: boolean;
  progress: McpTaskV2ProgressEvent[];
  /** Input the server is waiting for (input_required state). */
  inputRequest?: { prompt: string; schema?: Record<string, unknown> };
  tenantId?: string;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs?: number;
  retryPolicy: McpTaskV2RetryPolicy;
}

/** Error thrown by the task manager for bad task operations. */
export class McpTaskV2Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpTaskV2Error';
    this.code = code;
  }
}

/** Runner: the host's real work for one attempt. */
export type McpTaskV2Runner = (ctx: McpTaskV2RunnerContext) => Promise<unknown>;
export interface McpTaskV2RunnerContext {
  taskId: string;
  attempt: number;
  /** Report progress; also persists the event. */
  reportProgress(progress: number | null, message: string): void;
  /** Save a checkpoint a later resume() can restart from. */
  saveCheckpoint(checkpoint: unknown): void;
  /** True when the task was cancelled while this attempt ran. */
  isCancelled(): boolean;
  /** Input supplied by the client after an input_required pause. */
  inputAnswer?: unknown;
  signal: AbortSignal;
}

/** Options for creating a task. */
export interface CreateMcpTaskV2Options {
  method: string;
  params?: Record<string, unknown>;
  retryPolicy?: Partial<McpTaskV2RetryPolicy>;
  /** TTL after completion, ms (default 1h; 0 = never expires). */
  ttlMs?: number;
  tenantId?: string;
}

export interface McpTaskV2ManagerOptions {
  /** Full path of the snapshot file (required for durability). */
  snapshotPath: string;
  /** Maximum tasks kept in the snapshot (default 200). */
  maxPersistedTasks?: number;
  /** Called when the snapshot file is corrupt on load. */
  onCorrupt?: (error: Error) => void;
  /** Clock, for tests. */
  now?: () => number;
  /** Sleep, for tests (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

const SNAPSHOT_FORMAT_VERSION = 2;

/**
 * Durable MCP Tasks v2 manager.
 *
 * Create a task with a runner, then `poll()` it (or wait with
 * `waitFor()`), `cancel()` it, or `resume()` it after a
 * reconnect. State survives process restarts via the snapshot
 * file; runners do not — a task that was `running` at crash time
 * is failed on load, and only a task with a checkpoint can be
 * resumed from where it stopped.
 */
export class McpTaskV2Manager {
  private readonly snapshotPath: string;
  private readonly maxPersisted: number;
  private readonly onCorrupt?: (error: Error) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tasks = new Map<string, McpTaskV2Record>();
  private readonly runners = new Map<string, McpTaskV2Runner>();
  private readonly aborters = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Array<(record: McpTaskV2Record) => void>>();
  /** Run epoch per task: each runAttempts() bumps it, so a stale
   * attempt (superseded by resume()/restart) recognises itself
   * and never overwrites the newer run's state. Without this,
   * the old attempt's rejection can land after resume() started
   * (promise rejections take two microtask hops) and wrongly
   * cancel the resumed run. */
  private readonly runEpochs = new Map<string, number>();
  private counter = 0;

  constructor(options: McpTaskV2ManagerOptions) {
    this.snapshotPath = options.snapshotPath;
    this.maxPersisted = options.maxPersistedTasks ?? 200;
    this.onCorrupt = options.onCorrupt;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Load the snapshot from disk (call once at startup). */
  load(): { loaded: number; failedOnRestart: number } {
    if (!fs.existsSync(this.snapshotPath)) return { loaded: 0, failedOnRestart: 0 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
    } catch (error) {
      this.onCorrupt?.(error instanceof Error ? error : new Error(String(error)));
      return { loaded: 0, failedOnRestart: 0 };
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== SNAPSHOT_FORMAT_VERSION) {
      this.onCorrupt?.(new Error('unsupported snapshot format version'));
      return { loaded: 0, failedOnRestart: 0 };
    }
    const records = (parsed as { records?: unknown }).records;
    if (!Array.isArray(records)) return { loaded: 0, failedOnRestart: 0 };
    let failedOnRestart = 0;
    for (const raw of records) {
      const record = raw as McpTaskV2Record;
      if (typeof record?.taskId !== 'string' || typeof record?.state !== 'string') continue;
      if (record.state === 'running' || record.state === 'created') {
        record.state = 'failed';
        record.error = 'server restarted while the task was running';
        record.retryable = false;
        record.updatedAtMs = this.now();
        failedOnRestart += 1;
      } else if (record.state === 'input_required') {
        record.state = 'failed';
        record.error = 'server restarted while waiting for input';
        record.retryable = false;
        record.updatedAtMs = this.now();
        failedOnRestart += 1;
      }
      this.tasks.set(record.taskId, record);
    }
    this.persist();
    return { loaded: this.tasks.size, failedOnRestart };
  }

  private persist(): void {
    const dir = path.dirname(this.snapshotPath);
    fs.mkdirSync(dir, { recursive: true });
    const records = [...this.tasks.values()]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, this.maxPersisted);
    const tmp = `${this.snapshotPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: SNAPSHOT_FORMAT_VERSION, records }, null, 2), 'utf8');
    fs.renameSync(tmp, this.snapshotPath);
  }

  private notify(record: McpTaskV2Record): void {
    const waiters = this.waiters.get(record.taskId);
    if (!waiters) return;
    this.waiters.delete(record.taskId);
    const snapshot = this.clone(record);
    for (const waiter of waiters) waiter(snapshot);
  }

  private clone(record: McpTaskV2Record): McpTaskV2Record {
    return JSON.parse(JSON.stringify(record)) as McpTaskV2Record;
  }

  private update(taskId: string, patch: Partial<McpTaskV2Record>): McpTaskV2Record {
    const record = this.tasks.get(taskId);
    if (!record) throw new McpTaskV2Error('UNKNOWN_TASK', `Unknown task: ${taskId}`);
    Object.assign(record, patch, { updatedAtMs: this.now() });
    this.persist();
    this.notify(record);
    return this.clone(record);
  }

  /** Create a task (state `created`). The runner starts on `start()`. */
  create(options: CreateMcpTaskV2Options, runner: McpTaskV2Runner): McpTaskV2Record {
    if (!options.method || options.method.trim().length === 0) {
      throw new McpTaskV2Error('INVALID_METHOD', 'method is required');
    }
    this.counter += 1;
    const taskId = `task-v2-${this.now().toString(36)}-${this.counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const ttlMs = options.ttlMs ?? 3_600_000;
    const record: McpTaskV2Record = {
      taskId,
      method: options.method,
      params: options.params ?? {},
      state: 'created',
      attempts: 0,
      hasCheckpoint: false,
      progress: [],
      tenantId: options.tenantId,
      createdAtMs: this.now(),
      updatedAtMs: this.now(),
      expiresAtMs: ttlMs > 0 ? this.now() + ttlMs : undefined,
      retryPolicy: { ...MCP_TASK_V2_DEFAULT_RETRY, ...(options.retryPolicy ?? {}) },
    };
    if (record.retryPolicy.maxAttempts < 1) record.retryPolicy.maxAttempts = 1;
    this.tasks.set(taskId, record);
    this.runners.set(taskId, runner);
    this.persist();
    return this.clone(record);
  }

  /** Start a created task (runs attempts in the background). */
  start(taskId: string): McpTaskV2Record {
    const record = this.tasks.get(taskId);
    if (!record) throw new McpTaskV2Error('UNKNOWN_TASK', `Unknown task: ${taskId}`);
    if (record.state !== 'created') {
      throw new McpTaskV2Error('INVALID_STATE', `Cannot start a task in state ${record.state}`);
    }
    void this.runAttempts(taskId);
    return this.clone(record);
  }

  /** Create + start in one call (the common path). */
  submit(options: CreateMcpTaskV2Options, runner: McpTaskV2Runner): McpTaskV2Record {
    const record = this.create(options, runner);
    return this.start(record.taskId);
  }

  private async runAttempts(taskId: string, inputAnswer?: unknown): Promise<void> {
    const record = this.tasks.get(taskId);
    const runner = this.runners.get(taskId);
    if (!record || !runner) return;
    const epoch = (this.runEpochs.get(taskId) ?? 0) + 1;
    this.runEpochs.set(taskId, epoch);
    /** True when a newer run has superseded this one. */
    const superseded = (): boolean => this.runEpochs.get(taskId) !== epoch;
    const aborter = new AbortController();
    this.aborters.set(taskId, aborter);
    this.update(taskId, { state: 'running' });
    const startedAt = this.now();
    // Attempts are cumulative in the record (for reporting), but
    // the retry budget (maxAttempts) applies per run: an explicit
    // resume() starts a fresh budget, otherwise a checkpoint
    // resume could never run.
    const baseAttempts = this.tasks.get(taskId)?.attempts ?? 0;
    let attempt = 0;
    while (attempt < record.retryPolicy.maxAttempts) {
      attempt += 1;
      this.update(taskId, { attempts: baseAttempts + attempt });
      const ctx: McpTaskV2RunnerContext = {
        taskId,
        attempt: baseAttempts + attempt,
        reportProgress: (progress, message) => {
          const current = this.tasks.get(taskId);
          if (!current) return;
          current.progress.push({ sequence: current.progress.length, progress, message, atMs: this.now() });
          current.updatedAtMs = this.now();
          this.persist();
          this.notify(current);
        },
        saveCheckpoint: (checkpoint) => {
          const current = this.tasks.get(taskId);
          if (!current) return;
          current.checkpoint = checkpoint;
          current.hasCheckpoint = true;
          current.updatedAtMs = this.now();
          this.persist();
        },
        isCancelled: () => aborter.signal.aborted,
        inputAnswer,
        signal: aborter.signal,
      };
      try {
        const attemptPromise = runner(ctx);
        const result = record.retryPolicy.attemptTimeoutMs > 0
          ? await this.withTimeout(attemptPromise, record.retryPolicy.attemptTimeoutMs, 'attempt timed out')
          : await attemptPromise;
        // A superseded run must never overwrite the newer run.
        if (superseded()) return;
        if (aborter.signal.aborted) {
          // An abort caused by requestInput() must not overwrite
          // the input_required state the manager already set.
          if (this.tasks.get(taskId)?.state !== 'input_required') {
            this.update(taskId, { state: 'cancelled', error: 'task cancelled' });
          }
          return;
        }
        this.update(taskId, { state: 'completed', result });
        return;
      } catch (error) {
        // A superseded run must never overwrite the newer run —
        // this is the requestInput() race: the old attempt's
        // rejection lands after resume() started a new run.
        if (superseded()) return;
        // The runner was aborted because the manager paused the
        // task for input: leave the input_required state alone.
        if (this.tasks.get(taskId)?.state === 'input_required') return;
        if (aborter.signal.aborted) {
          this.update(taskId, { state: 'cancelled', error: 'task cancelled' });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const retryable = isRetryableError(error);
        const timedOut =
          record.retryPolicy.taskTimeoutMs > 0 && this.now() - startedAt >= record.retryPolicy.taskTimeoutMs;
        if (timedOut) {
          this.update(taskId, { state: 'failed', error: `task timed out after ${record.retryPolicy.taskTimeoutMs}ms: ${message}`, retryable: false });
          return;
        }
        if (retryable && attempt < record.retryPolicy.maxAttempts) {
          await this.sleep(mcpTaskV2RetryDelayMs(record.retryPolicy, attempt));
          if (superseded()) return;
          continue;
        }
        this.update(taskId, { state: 'failed', error: message, retryable });
        return;
      }
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Current state of a task (a snapshot copy). */
  get(taskId: string): McpTaskV2Record {
    const record = this.tasks.get(taskId);
    if (!record) throw new McpTaskV2Error('UNKNOWN_TASK', `Unknown task: ${taskId}`);
    return this.clone(record);
  }

  /**
   * Poll a task: the current snapshot plus only the progress
   * events after `afterSequence` (so a reconnecting client
   * replays exactly what it missed).
   */
  poll(taskId: string, afterSequence = -1): { record: McpTaskV2Record; newProgress: McpTaskV2ProgressEvent[] } {
    const record = this.get(taskId);
    return {
      record,
      newProgress: record.progress.filter((event) => event.sequence > afterSequence),
    };
  }

  /** List tasks, optionally filtered by state and/or tenant. */
  list(filter: { state?: McpTaskV2State; tenantId?: string } = {}): McpTaskV2Record[] {
    return [...this.tasks.values()]
      .filter((t) => (filter.state === undefined || t.state === filter.state)
        && (filter.tenantId === undefined || t.tenantId === filter.tenantId))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((t) => this.clone(t));
  }

  /** Cancel a task (running or created). Terminal tasks cannot be cancelled. */
  cancel(taskId: string): McpTaskV2Record {
    const record = this.tasks.get(taskId);
    if (!record) throw new McpTaskV2Error('UNKNOWN_TASK', `Unknown task: ${taskId}`);
    if (isMcpTaskV2Terminal(record.state)) {
      throw new McpTaskV2Error('INVALID_STATE', `Cannot cancel a ${record.state} task`);
    }
    this.aborters.get(taskId)?.abort();
    return this.update(taskId, { state: 'cancelled', error: 'task cancelled by client' });
  }

  /**
   * Pause a running task for input (multi round-trip): the task
   * moves to `input_required` and the runner's attempt is
   * abandoned; `resumeWithInput()` restarts it with the answer.
   * (Runners that support in-place pausing instead return the
   * sentinel `{ input_required: ... }` — see `requestInput`.)
   */
  requestInput(taskId: string, prompt: string, schema?: Record<string, unknown>): McpTaskV2Record {
    const record = this.tasks.get(taskId);
    if (!record) throw new McpTaskV2Error('UNKNOWN_TASK', `Unknown task: ${taskId}`);
    if (record.state !== 'running' && record.state !== 'created') {
      throw new McpTaskV2Error('INVALID_STATE', `Cannot request input from a ${record.state} task`);
    }
    this.aborters.get(taskId)?.abort();
    return this.update(taskId, { state: 'input_required', inputRequest: { prompt, schema } });
  }

  /**
   * Resume an `input_required` task with the client's answer, or
   * resume a `failed` task that has a checkpoint (restarts the
   * runner from the checkpoint instead of from scratch).
   */
  resume(taskId: string, inputAnswer?: unknown): McpTaskV2Record {
    const record = this.tasks.get(taskId);
    if (!record) throw new McpTaskV2Error('UNKNOWN_TASK', `Unknown task: ${taskId}`);
    if (record.state === 'input_required') {
      const resumed = this.update(taskId, { state: 'created', inputRequest: undefined });
      void this.runAttempts(taskId, inputAnswer);
      return resumed;
    }
    if (record.state === 'failed' && record.hasCheckpoint) {
      const resumed = this.update(taskId, { state: 'created', error: undefined, retryable: undefined });
      void this.runAttempts(taskId, inputAnswer);
      return resumed;
    }
    throw new McpTaskV2Error(
      'INVALID_STATE',
      `Cannot resume a ${record.state} task${record.state === 'failed' ? ' (no checkpoint saved)' : ''}`,
    );
  }

  /**
   * Wait until a task reaches a terminal state (or `input_required`
   * when `includeInputRequired` is set), polling the in-memory
   * waiters instead of spinning. Resolves immediately when the
   * task is already terminal.
   */
  waitFor(taskId: string, options: { timeoutMs?: number; includeInputRequired?: boolean } = {}): Promise<McpTaskV2Record> {
    const record = this.tasks.get(taskId);
    if (!record) return Promise.reject(new McpTaskV2Error('UNKNOWN_TASK', `Unknown task: ${taskId}`));
    const done = (r: McpTaskV2Record): boolean =>
      isMcpTaskV2Terminal(r.state) || (options.includeInputRequired === true && r.state === 'input_required');
    if (done(record)) return Promise.resolve(this.clone(record));
    return new Promise<McpTaskV2Record>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = (updated: McpTaskV2Record): void => {
        if (!done(updated)) {
          const list = this.waiters.get(taskId) ?? [];
          list.push(waiter);
          this.waiters.set(taskId, list);
          return;
        }
        if (timer) clearTimeout(timer);
        resolve(this.clone(updated));
      };
      const list = this.waiters.get(taskId) ?? [];
      list.push(waiter);
      this.waiters.set(taskId, list);
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          const pending = this.waiters.get(taskId) ?? [];
          this.waiters.set(taskId, pending.filter((w) => w !== waiter));
          reject(new McpTaskV2Error('TIMEOUT', `Timed out waiting for task ${taskId}`));
        }, options.timeoutMs);
      }
    });
  }

  /** Drop expired terminal tasks from memory + snapshot. Returns how many were dropped. */
  pruneExpired(): number {
    const now = this.now();
    let dropped = 0;
    for (const [id, record] of [...this.tasks]) {
      if (isMcpTaskV2Terminal(record.state) && record.expiresAtMs !== undefined && record.expiresAtMs <= now) {
        this.tasks.delete(id);
        this.runners.delete(id);
        this.aborters.delete(id);
        dropped += 1;
      }
    }
    if (dropped > 0) this.persist();
    return dropped;
  }

  /** Number of tasks currently tracked. */
  size(): number {
    return this.tasks.size;
  }
}

/**
 * True when an error is transient and worth retrying: network
 * hiccups, rate limits, timeouts. Anything else (bad input,
 * auth, not-found) fails fast instead of burning retries.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('timed out') || message.includes('timeout')) return true;
    if (message.includes('econnreset') || message.includes('econnrefused') || message.includes('enotfound')) return true;
    if (message.includes('rate limit') || message.includes('429') || message.includes('503') || message.includes('502')) return true;
    const code = (error as { code?: unknown }).code;
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true;
    if (typeof code === 'number' && (code === 429 || code >= 500)) return true;
  }
  return false;
}
