/**
 * MCP Tasks v2 — orchestrate MANY long tasks as one job (v1.44, Team T3).
 *
 * What existed before:
 *   - `tasks.ts` (SEP-1686 / extension 2026-07-28): ONE long task —
 *     `TaskHandle` polls `tasks/get`, fetches the result, cancels,
 *     sends input. No notion of several tasks together.
 *   - `taskManager.ts` (v0.98): tracks many `TaskHandle`s at once
 *     (create / watch / cancel / timeout / input_required), but
 *     every task is independent — no ordering, no retries, no
 *     shared result.
 *   - `tasksRunner.ts` (v1.09): runs ONE method as a task with
 *     retry + timeout + progress, and resumes saved tasks.
 *   - `tasksPollerV2.ts` / `serverDirectedTasks.ts`: polling and
 *     server-directed creation.
 *
 * What was still missing — and what this module adds:
 *
 *   1. **A DAG.** A v2 job is a set of tasks with `dependsOn`
 *      edges ("summarise this file AFTER the fetch finishes").
 *      The orchestrator validates the graph (unknown dependency,
 *      self-dependency, cycle) up front, runs tasks as soon as
 *      their dependencies complete, and SKIPS (never silently
 *      runs) the dependents of a failed / cancelled task.
 *   2. **Retry with backoff + jitter, per task.** A failed task
 *      retries up to `maxAttempts` with exponential backoff
 *      (capped) and jitter, so a fleet of tasks does not retry
 *      in lock-step and hammer the server. Retry history is kept
 *      per task for the UI.
 *   3. **Priority + concurrency.** Tasks carry a priority;
 *      ready tasks run highest-priority-first, at most
 *      `concurrency` at once. Progress is aggregated across the
 *      whole job (done / total, per-task progress 0..1).
 *   4. **Result artifacts.** Every completed task's result is
 *      kept as an artifact (JSON-safe, byte-capped) the UI or a
 *      later task can read — a task can consume an earlier
 *      task's artifact as its input without re-running it.
 *   5. **Persistence.** `snapshot()` / `restore()` serialise the
 *      whole job (nodes, states, attempts, artifacts, progress)
 *      so a job survives an app restart; `resume()` re-runs only
 *      the unfinished part.
 *
 * The executor is injected: `runOne` receives a node and returns
 * its result (or throws). `transportExecutor` adapts a real MCP
 * transport (`TaskHandle` / `runTaskToCompletion` from
 * `tasks.ts`) so the orchestrator talks the real protocol without
 * importing the client. Ideas only — no code copied from any MCP
 * implementation, SDK, or the Grok Bot / Cursor installers.
 */

import { runTaskToCompletion } from './tasks';
import type { McpTaskSpecVersion, McpTaskTransport, TaskHandleData } from './tasks';

/** Error raised by the Tasks v2 layer. */
export class TasksV2Error extends Error {
  readonly code: string;
  readonly taskId?: string;
  constructor(message: string, code: string, taskId?: string) {
    super(message);
    this.name = 'TasksV2Error';
    this.code = code;
    if (taskId) this.taskId = taskId;
  }
}

/** Lifecycle state of one v2 task node. */
export type TaskV2Status =
  | 'queued'
  | 'waiting'
  | 'running'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

/** Terminal states — a node in one of these never runs again (except via retryTask). */
export const TASK_V2_TERMINAL: readonly TaskV2Status[] = [
  'completed',
  'failed',
  'cancelled',
  'skipped',
];

export function isTaskV2Terminal(status: TaskV2Status): boolean {
  return (TASK_V2_TERMINAL as readonly TaskV2Status[]).includes(status);
}

/** Definition of one task node in a v2 job (input to `addTask`). */
export interface TaskV2Definition {
  /** Stable id inside the job (slug). */
  id: string;
  /** MCP server that runs this task. */
  serverName: string;
  /** MCP method (usually `tools/call`). */
  method: string;
  /** Params for the method. */
  params?: Record<string, unknown>;
  /** Ids of tasks that must complete first. */
  dependsOn?: string[];
  /** Higher runs first among ready tasks (default 0). */
  priority?: number;
  /** Total attempts including the first (default 1 = no retry). */
  maxAttempts?: number;
  /** Per-attempt timeout (ms). */
  timeoutMs?: number;
  /** Display label. */
  label?: string;
}

/** One retry attempt, kept for the UI / diagnostics. */
export interface TaskV2Attempt {
  attempt: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

/** Runtime state of one task node. */
export interface TaskV2Node
  extends Required<Omit<TaskV2Definition, 'params' | 'label' | 'timeoutMs'>> {
  params: Record<string, unknown>;
  label: string;
  timeoutMs?: number;
  status: TaskV2Status;
  /** Attempts so far (1-based count of started attempts). */
  attempts: number;
  attemptHistory: TaskV2Attempt[];
  /** Progress 0..1 reported by the executor (when it reports). */
  progress: number;
  progressMessage?: string;
  /** Result artifact id (when completed). */
  artifactId?: string;
  /** Failure reason (when failed). */
  error?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

/** One stored result artifact. */
export interface TaskV2Artifact {
  id: string;
  taskId: string;
  createdAt: number;
  /** JSON size of the stored result (bytes). */
  bytes: number;
  /** The result (JSON-safe; truncated when over the cap). */
  result: unknown;
  truncated: boolean;
}

/** Aggregated progress of a whole job. */
export interface TaskV2JobProgress {
  total: number;
  done: number;
  running: number;
  failed: number;
  skipped: number;
  /** Done / total, 0..1 (1 when the job has no tasks). */
  fraction: number;
  /** Mean of per-task progress, 0..1. */
  meanProgress: number;
}

/** Overall job state. */
export type TaskV2JobStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';

/** Serializable snapshot of a whole job (persistence / resume). */
export interface TaskV2JobSnapshot {
  version: 1;
  jobId: string;
  nodes: TaskV2Node[];
  artifacts: TaskV2Artifact[];
  status: TaskV2JobStatus;
  createdAt: number;
  updatedAt: number;
}

/** Executor: runs one node, returns its result (or throws). */
export type TaskV2Executor = (
  node: TaskV2Node,
  signal: AbortSignal,
  reportProgress: (progress: number, message?: string) => void,
) => Promise<unknown>;

/** Options for the orchestrator. */
export interface TaskV2OrchestratorOptions {
  /** Max tasks running at once (default 3). */
  concurrency?: number;
  /** Base backoff between retries (ms, default 500). */
  retryBaseDelayMs?: number;
  /** Max backoff between retries (ms, default 30_000). */
  retryMaxDelayMs?: number;
  /** Max bytes kept per artifact (default 256 KiB). */
  maxArtifactBytes?: number;
  /** Sleep override (tests: record delays instead of waiting). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Random override (tests: deterministic jitter). */
  random?: () => number;
  /** Clock override (tests). */
  nowMs?: () => number;
}

export const TASK_V2_MAX_NODES = 100;
export const TASK_V2_DEFAULT_CONCURRENCY = 3;
export const TASK_V2_DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024;

const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    timer.unref?.();
    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Tasks v2: đã bị huỷ'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = exponential * 0.25 * random();
  return Math.round(exponential + jitter);
}

/**
 * Build an executor over a real MCP transport: each node runs its
 * method as a long task (`runTaskToCompletion` from `tasks.ts`),
 * honouring the node's timeout and reporting server progress.
 */
export function transportExecutor(
  transport: McpTaskTransport,
  options: { specVersion?: McpTaskSpecVersion; serverName?: string } = {},
): TaskV2Executor {
  return async (node, signal, reportProgress) => {
    const result = await runTaskToCompletion(transport, node.method, node.params, {
      specVersion: options.specVersion ?? '2026-07-28',
      ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
      signal,
      onStatusChange: (_status: string, task: TaskHandleData) => {
        if (typeof task.progress === 'number') {
          reportProgress(task.progress, task.progressMessage);
        }
      },
    });
    return result;
  };
}

/** Listener for job events (the UI subscribes to re-render). */
export type TaskV2Event =
  | { type: 'node-started'; nodeId: string }
  | { type: 'node-progress'; nodeId: string; progress: number; message?: string }
  | { type: 'node-completed'; nodeId: string; artifactId: string }
  | { type: 'node-failed'; nodeId: string; error: string; willRetry: boolean }
  | { type: 'node-skipped'; nodeId: string; reason: string }
  | { type: 'node-cancelled'; nodeId: string }
  | { type: 'job-finished'; status: TaskV2JobStatus };

/**
 * Orchestrator for a Tasks v2 job: a DAG of long MCP tasks with
 * retries, priorities, bounded concurrency, artifacts and
 * persistence. `runAll` resolves when every node is terminal;
 * the job status says whether everything completed, something
 * failed, or the job was cancelled / partially done.
 */
export class TaskV2Orchestrator {
  readonly jobId: string;
  private readonly nodes = new Map<string, TaskV2Node>();
  private readonly artifacts = new Map<string, TaskV2Artifact>();
  private readonly listeners = new Set<(event: TaskV2Event) => void>();
  private readonly executor: TaskV2Executor;
  private readonly concurrency: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly maxArtifactBytes: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly randomFn: () => number;
  private readonly nowMs: () => number;
  private readonly createdAt: number;
  private updatedAt: number;
  private status: TaskV2JobStatus = 'idle';
  private abortController: AbortController | undefined;
  private artifactCounter = 0;

  constructor(jobId: string, executor: TaskV2Executor, options: TaskV2OrchestratorOptions = {}) {
    if (!TASK_ID_RE.test(jobId)) {
      throw new TasksV2Error(`Job id không hợp lệ: ${JSON.stringify(jobId)}.`, 'bad-job-id');
    }
    this.jobId = jobId;
    this.executor = executor;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? TASK_V2_DEFAULT_CONCURRENCY));
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 30_000;
    this.maxArtifactBytes = options.maxArtifactBytes ?? TASK_V2_DEFAULT_MAX_ARTIFACT_BYTES;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.randomFn = options.random ?? Math.random;
    this.nowMs = options.nowMs ?? Date.now;
    this.createdAt = this.nowMs();
    this.updatedAt = this.createdAt;
  }

  /** Subscribe to job events. Returns an unsubscribe function. */
  onEvent(listener: (event: TaskV2Event) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: TaskV2Event): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must never break the job.
      }
    }
  }

  private touch(): void {
    this.updatedAt = this.nowMs();
  }

  get jobStatus(): TaskV2JobStatus {
    return this.status;
  }

  get size(): number {
    return this.nodes.size;
  }

  /**
   * Add a task node. Validates the id, the server/method, the
   * dependency list (must exist, no self-dependency) and the
   * whole graph for cycles. Throws `TasksV2Error` on the first
   * problem — a bad graph is rejected before anything runs.
   */
  addTask(def: TaskV2Definition): TaskV2Node {
    if (this.status === 'running') {
      throw new TasksV2Error('Không thêm task khi job đang chạy.', 'job-running', def.id);
    }
    if (!TASK_ID_RE.test(def.id)) {
      throw new TasksV2Error(`Task id không hợp lệ: ${JSON.stringify(def.id)}.`, 'bad-task-id', def.id);
    }
    if (this.nodes.has(def.id)) {
      throw new TasksV2Error(`Task id trùng trong job: "${def.id}".`, 'duplicate-task', def.id);
    }
    if (this.nodes.size >= TASK_V2_MAX_NODES) {
      throw new TasksV2Error(`Job vượt quá ${TASK_V2_MAX_NODES} task.`, 'too-many-tasks', def.id);
    }
    if (typeof def.serverName !== 'string' || def.serverName.length === 0) {
      throw new TasksV2Error(`Task "${def.id}" cần serverName.`, 'bad-task', def.id);
    }
    if (typeof def.method !== 'string' || def.method.length === 0) {
      throw new TasksV2Error(`Task "${def.id}" cần method.`, 'bad-task', def.id);
    }
    const dependsOn = def.dependsOn ?? [];
    for (const dep of dependsOn) {
      if (dep === def.id) {
        throw new TasksV2Error(`Task "${def.id}" không được phụ thuộc chính nó.`, 'self-dependency', def.id);
      }
      if (!this.nodes.has(dep)) {
        throw new TasksV2Error(
          `Task "${def.id}" phụ thuộc task chưa có "${dep}" — thêm dependency trước.`,
          'unknown-dependency',
          def.id,
        );
      }
    }
    const maxAttempts = def.maxAttempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new TasksV2Error(`Task "${def.id}": maxAttempts phải là số nguyên 1..10.`, 'bad-task', def.id);
    }
    const node: TaskV2Node = {
      id: def.id,
      serverName: def.serverName,
      method: def.method,
      params: { ...(def.params ?? {}) },
      dependsOn: [...dependsOn],
      priority: def.priority ?? 0,
      maxAttempts,
      ...(def.timeoutMs !== undefined ? { timeoutMs: def.timeoutMs } : {}),
      label: def.label ?? `${def.method} (${def.id})`,
      status: dependsOn.length > 0 ? 'waiting' : 'queued',
      attempts: 0,
      attemptHistory: [],
      progress: 0,
      createdAt: this.nowMs(),
    };
    this.nodes.set(def.id, node);
    if (this.hasCycle()) {
      this.nodes.delete(def.id);
      throw new TasksV2Error(`Thêm task "${def.id}" tạo chu trình phụ thuộc.`, 'dependency-cycle', def.id);
    }
    this.touch();
    return { ...node, attemptHistory: [...node.attemptHistory], dependsOn: [...node.dependsOn] };
  }

  private hasCycle(): boolean {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const node = this.nodes.get(id);
      for (const dep of node?.dependsOn ?? []) {
        if (visit(dep)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    for (const id of this.nodes.keys()) {
      if (visit(id)) return true;
    }
    return false;
  }

  getNode(taskId: string): TaskV2Node | undefined {
    const node = this.nodes.get(taskId);
    if (!node) return undefined;
    return {
      ...node,
      params: { ...node.params },
      dependsOn: [...node.dependsOn],
      attemptHistory: node.attemptHistory.map((a) => ({ ...a })),
    };
  }

  listNodes(): TaskV2Node[] {
    return [...this.nodes.values()].map((n) => this.getNode(n.id) as TaskV2Node);
  }

  getArtifact(artifactId: string): TaskV2Artifact | undefined {
    const artifact = this.artifacts.get(artifactId);
    return artifact ? { ...artifact } : undefined;
  }

  getArtifactForTask(taskId: string): TaskV2Artifact | undefined {
    const node = this.nodes.get(taskId);
    if (!node?.artifactId) return undefined;
    return this.getArtifact(node.artifactId);
  }

  listArtifacts(): TaskV2Artifact[] {
    return [...this.artifacts.values()].map((a) => ({ ...a }));
  }

  /** Aggregated progress across the whole job. */
  progress(): TaskV2JobProgress {
    const nodes = [...this.nodes.values()];
    const total = nodes.length;
    const done = nodes.filter((n) => n.status === 'completed').length;
    const running = nodes.filter((n) => n.status === 'running').length;
    const failed = nodes.filter((n) => n.status === 'failed').length;
    const skipped = nodes.filter((n) => n.status === 'skipped').length;
    const meanProgress =
      total === 0 ? 1 : nodes.reduce((sum, n) => sum + (n.status === 'completed' ? 1 : n.progress), 0) / total;
    return {
      total,
      done,
      running,
      failed,
      skipped,
      fraction: total === 0 ? 1 : done / total,
      meanProgress,
    };
  }

  private storeArtifact(node: TaskV2Node, result: unknown): TaskV2Artifact {
    this.artifactCounter += 1;
    const id = `artifact-${this.jobId}-${this.artifactCounter}`;
    let stored: unknown = result;
    let truncated = false;
    let json: string;
    try {
      json = JSON.stringify(result) ?? 'null';
    } catch {
      json = JSON.stringify(String(result));
      stored = String(result);
    }
    if (Buffer.byteLength(json, 'utf8') > this.maxArtifactBytes) {
      truncated = true;
      stored = { _truncated: true, preview: json.slice(0, Math.max(0, this.maxArtifactBytes)) };
      json = JSON.stringify(stored);
    }
    const artifact: TaskV2Artifact = {
      id,
      taskId: node.id,
      createdAt: this.nowMs(),
      bytes: Buffer.byteLength(json, 'utf8'),
      result: stored,
      truncated,
    };
    this.artifacts.set(id, artifact);
    return artifact;
  }

  private readyNodes(): TaskV2Node[] {
    return [...this.nodes.values()]
      .filter((n) => n.status === 'queued')
      .filter((n) =>
        n.dependsOn.every((dep) => this.nodes.get(dep)?.status === 'completed'),
      )
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  }

  private skipDependentsOf(failedId: string, reason: string): void {
    // Walk dependents transitively: anything that (transitively)
    // depends on a failed/cancelled task can never run.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.nodes.values()) {
        if (node.status !== 'queued' && node.status !== 'waiting') continue;
        const blocked = node.dependsOn.some((dep) => {
          const depNode = this.nodes.get(dep);
          return depNode && (depNode.status === 'failed' || depNode.status === 'cancelled' || depNode.status === 'skipped');
        });
        if (blocked) {
          node.status = 'skipped';
          node.error = reason;
          node.endedAt = this.nowMs();
          changed = true;
          this.emit({ type: 'node-skipped', nodeId: node.id, reason });
        }
      }
    }
    void failedId;
  }

  private async runNode(node: TaskV2Node, signal: AbortSignal): Promise<void> {
    node.status = 'running';
    node.startedAt = this.nowMs();
    this.touch();
    this.emit({ type: 'node-started', nodeId: node.id });
    let lastError = '';
    for (let attempt = 1; attempt <= node.maxAttempts; attempt += 1) {
      if (signal.aborted) {
        node.status = 'cancelled';
        node.endedAt = this.nowMs();
        this.emit({ type: 'node-cancelled', nodeId: node.id });
        return;
      }
      node.attempts = attempt;
      const attemptRecord: TaskV2Attempt = { attempt, startedAt: this.nowMs() };
      node.attemptHistory.push(attemptRecord);
      try {
        const result = await this.executor(node, signal, (progress, message) => {
          node.progress = Math.max(0, Math.min(1, progress));
          if (message !== undefined) node.progressMessage = message;
          this.emit({ type: 'node-progress', nodeId: node.id, progress: node.progress, ...(message ? { message } : {}) });
        });
        attemptRecord.endedAt = this.nowMs();
        node.status = 'completed';
        node.progress = 1;
        node.endedAt = this.nowMs();
        const artifact = this.storeArtifact(node, result);
        node.artifactId = artifact.id;
        this.touch();
        this.emit({ type: 'node-completed', nodeId: node.id, artifactId: artifact.id });
        return;
      } catch (err) {
        // Aborted mid-attempt (job cancelled): this is a
        // cancellation, not a failure — do not retry, do not
        // count it as a failed attempt for dependents.
        if (signal.aborted) {
          attemptRecord.endedAt = this.nowMs();
          node.status = 'cancelled';
          node.endedAt = this.nowMs();
          this.touch();
          this.emit({ type: 'node-cancelled', nodeId: node.id });
          return;
        }
        attemptRecord.endedAt = this.nowMs();
        lastError = err instanceof Error ? err.message : String(err);
        attemptRecord.error = lastError;
        const willRetry = attempt < node.maxAttempts && !signal.aborted;
        this.emit({ type: 'node-failed', nodeId: node.id, error: lastError, willRetry });
        if (!willRetry) break;
        const delay = backoffDelay(attempt, this.retryBaseDelayMs, this.retryMaxDelayMs, this.randomFn);
        try {
          await this.sleepFn(delay, signal);
        } catch {
          node.status = 'cancelled';
          node.endedAt = this.nowMs();
          this.emit({ type: 'node-cancelled', nodeId: node.id });
          return;
        }
      }
    }
    node.status = 'failed';
    node.error = lastError || 'Task thất bại (không rõ lý do).';
    node.endedAt = this.nowMs();
    this.touch();
    this.skipDependentsOf(node.id, `Dependency "${node.id}" thất bại — task bị skip.`);
  }

  /**
   * Run the whole job until every node is terminal. Resolves
   * with the final job status. Nodes run as soon as their
   * dependencies complete, highest priority first, at most
   * `concurrency` at once. A second `runAll` while running
   * throws; after finishing, `runAll` again resumes unfinished
   * nodes (see `resume`).
   */
  async runAll(signal?: AbortSignal): Promise<TaskV2JobStatus> {
    if (this.status === 'running') {
      throw new TasksV2Error(`Job "${this.jobId}" đang chạy.`, 'job-running');
    }
    this.abortController = new AbortController();
    const outerSignal = signal;
    if (outerSignal) {
      if (outerSignal.aborted) {
        this.abortController.abort(outerSignal.reason);
      } else {
        outerSignal.addEventListener('abort', () => this.abortController?.abort(outerSignal.reason), { once: true });
      }
    }
    const jobSignal = this.abortController.signal;
    this.status = 'running';
    this.touch();
    try {
      const inFlight = new Set<Promise<void>>();
      for (;;) {
        if (jobSignal.aborted) break;
        // Promote waiting nodes whose deps completed.
        for (const node of this.nodes.values()) {
          if (node.status === 'waiting' && node.dependsOn.every((dep) => this.nodes.get(dep)?.status === 'completed')) {
            node.status = 'queued';
          }
        }
        const ready = this.readyNodes();
        if (ready.length === 0 && inFlight.size === 0) break;
        while (ready.length > 0 && inFlight.size < this.concurrency) {
          const node = ready.shift() as TaskV2Node;
          const run = this.runNode(node, jobSignal).finally(() => {
            inFlight.delete(run);
          });
          inFlight.add(run);
        }
        if (inFlight.size > 0) {
          await Promise.race([...inFlight]);
        } else if (ready.length === 0) {
          // Nothing ready and nothing running: remaining nodes are
          // blocked by failed deps — skip them so the job ends.
          let skippedAny = false;
          for (const node of this.nodes.values()) {
            if (node.status === 'queued' || node.status === 'waiting') {
              const blocked = node.dependsOn.some((dep) => {
                const depNode = this.nodes.get(dep);
                return depNode && depNode.status !== 'completed';
              });
              if (blocked) {
                node.status = 'skipped';
                node.error = 'Dependency không hoàn thành — task bị skip.';
                node.endedAt = this.nowMs();
                skippedAny = true;
                this.emit({ type: 'node-skipped', nodeId: node.id, reason: node.error });
              }
            }
          }
          if (!skippedAny) break;
        }
      }
      await Promise.allSettled([...inFlight]);
    } finally {
      this.abortController = undefined;
    }
    const nodes = [...this.nodes.values()];
    const anyFailed = nodes.some((n) => n.status === 'failed');
    const anyCancelled = nodes.some((n) => n.status === 'cancelled');
    const allCompleted = nodes.length > 0 && nodes.every((n) => n.status === 'completed');
    this.status = allCompleted
      ? 'completed'
      : anyCancelled && !anyFailed
        ? 'cancelled'
        : anyFailed || nodes.some((n) => n.status === 'skipped')
          ? 'partial'
          : 'failed';
    if (nodes.length === 0) this.status = 'completed';
    this.touch();
    this.emit({ type: 'job-finished', status: this.status });
    return this.status;
  }

  /** Cancel the running job (running nodes abort; queued nodes are cancelled). */
  cancel(): void {
    this.abortController?.abort();
    for (const node of this.nodes.values()) {
      if (node.status === 'queued' || node.status === 'waiting') {
        node.status = 'cancelled';
        node.endedAt = this.nowMs();
        this.emit({ type: 'node-cancelled', nodeId: node.id });
      }
    }
    this.touch();
  }

  /**
   * Retry one failed node (and un-skip its dependents so they
   * can run when it completes). Only failed nodes retry; the
   * node's attempt history is kept, `maxAttempts` applies to
   * the new run. Returns the node after the retry finishes.
   */
  async retryTask(taskId: string, signal?: AbortSignal): Promise<TaskV2Node> {
    const node = this.nodes.get(taskId);
    if (!node) throw new TasksV2Error(`Không có task "${taskId}" trong job.`, 'unknown-task', taskId);
    if (node.status !== 'failed') {
      throw new TasksV2Error(
        `Chỉ retry được task failed (task "${taskId}" đang ${node.status}).`,
        'not-failed',
        taskId,
      );
    }
    if (this.status === 'running') {
      throw new TasksV2Error('Không retry khi job đang chạy — chờ job xong.', 'job-running', taskId);
    }
    // Un-skip dependents so the retry can unblock them.
    for (const other of this.nodes.values()) {
      if (other.status === 'skipped' && other.dependsOn.includes(taskId)) {
        other.status = other.dependsOn.length > 0 ? 'waiting' : 'queued';
        other.error = undefined;
        other.endedAt = undefined;
      }
    }
    node.status = 'queued';
    node.error = undefined;
    node.progress = 0;
    node.endedAt = undefined;
    node.attemptHistory = [];
    node.attempts = 0;
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    await this.runNode(node, controller.signal);
    // Run any dependents the retry unblocked (re-read the node:
    // runNode updated its status in place).
    const updated = this.nodes.get(taskId) as TaskV2Node;
    if (updated.status === 'completed') {
      await this.runAll();
    } else {
      this.status = 'partial';
      this.emit({ type: 'job-finished', status: this.status });
    }
    return this.getNode(updated.id) as TaskV2Node;
  }

  /** Serialise the whole job (nodes, artifacts, status). */
  snapshot(): TaskV2JobSnapshot {
    return {
      version: 1,
      jobId: this.jobId,
      nodes: this.listNodes(),
      artifacts: this.listArtifacts(),
      status: this.status === 'running' ? 'partial' : this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Restore a job from a snapshot. Completed nodes keep their
   * artifacts; running/waiting nodes come back as queued/waiting
   * so `runAll` resumes only the unfinished part. Throws on a
   * snapshot with a wrong version, wrong job id, or a cycle.
   */
  static restore(snapshot: TaskV2JobSnapshot, executor: TaskV2Executor, options: TaskV2OrchestratorOptions = {}): TaskV2Orchestrator {
    if (!snapshot || snapshot.version !== 1) {
      throw new TasksV2Error('Snapshot Tasks v2 phải có version 1.', 'bad-snapshot');
    }
    const job = new TaskV2Orchestrator(snapshot.jobId, executor, options);
    for (const rawNode of snapshot.nodes) {
      const node: TaskV2Node = {
        ...rawNode,
        params: { ...(rawNode.params ?? {}) },
        dependsOn: [...(rawNode.dependsOn ?? [])],
        attemptHistory: (rawNode.attemptHistory ?? []).map((a) => ({ ...a })),
        status:
          rawNode.status === 'running' || rawNode.status === 'queued'
            ? rawNode.dependsOn.length > 0
              ? 'waiting'
              : 'queued'
            : rawNode.status === 'waiting'
              ? 'waiting'
              : rawNode.status,
      };
      job.nodes.set(node.id, node);
    }
    if (job.hasCycle()) {
      throw new TasksV2Error('Snapshot chứa chu trình phụ thuộc.', 'bad-snapshot');
    }
    for (const artifact of snapshot.artifacts ?? []) {
      job.artifacts.set(artifact.id, { ...artifact });
    }
    job.status = snapshot.status === 'running' ? 'partial' : snapshot.status;
    job.artifactCounter = snapshot.artifacts?.length ?? 0;
    return job;
  }
}

/** One-line summary of a job, for the task list UI. */
export function describeTaskV2Job(job: TaskV2Orchestrator): string {
  const p = job.progress();
  return `Job ${job.jobId} — ${job.jobStatus}: ${p.done}/${p.total} xong` +
    (p.failed > 0 ? `, ${p.failed} lỗi` : '') +
    (p.skipped > 0 ? `, ${p.skipped} skip` : '') +
    ` (${Math.round(p.fraction * 100)}%)`;
}

/** One-line summary of one node, for the task list UI. */
export function describeTaskV2Node(node: TaskV2Node): string {
  const base = `${node.label} [${node.id}] — ${node.status}`;
  if (node.status === 'failed' && node.error) return `${base}: ${node.error}`;
  if (node.status === 'running') return `${base} ${Math.round(node.progress * 100)}%`;
  if (node.attempts > 1) return `${base} (thử ${node.attempts}/${node.maxAttempts})`;
  return base;
}
