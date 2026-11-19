/**
 * Tasks v2 job store — persist job snapshots to disk (v1.44, Team T3).
 *
 * `TaskV2Orchestrator.snapshot()` / `restore()` (see `tasksV2.ts`)
 * already serialise a job to plain JSON; this module is the disk
 * half of that story: one JSON file per job under a directory
 * (default `<data>/tasks-v2/`), atomic-ish writes (write temp +
 * rename), listing, loading and deleting. The orchestrator itself
 * never touches the filesystem — the coordinator (or the agent
 * host) owns a store and calls `save()` after a job finishes and
 * `load()` on startup to resume unfinished jobs.
 *
 * File names are derived from the job id (validated slug), so a
 * hostile job id cannot escape the directory (`..` / `/` are
 * rejected by the same regex the orchestrator uses). Corrupt
 * files fail `load()` with a clear error instead of returning a
 * half-parsed job.
 *
 * No network, no key. Ideas only — no code copied from any MCP
 * implementation, SDK, or the Grok Bot / Cursor installers.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { TaskV2Orchestrator } from './tasksV2';
import type { TaskV2Executor, TaskV2JobSnapshot } from './tasksV2';

/** Error raised by the Tasks v2 store. */
export class TasksV2StoreError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'TasksV2StoreError';
    this.code = code;
  }
}

/** One entry in a store listing (no node detail — use `load()` for that). */
export interface TaskV2StoreEntry {
  jobId: string;
  status: TaskV2JobSnapshot['status'];
  nodes: number;
  done: number;
  failed: number;
  updatedAt: number;
  /** File size (bytes). */
  bytes: number;
}

const JOB_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function fileNameFor(jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) {
    throw new TasksV2StoreError(`Job id không hợp lệ: ${JSON.stringify(jobId)}.`, 'bad-job-id');
  }
  return `${jobId}.tasks-v2.json`;
}

/** Validate a parsed snapshot object (shape only — `restore()` validates the graph). */
export function isTaskV2JobSnapshot(value: unknown): value is TaskV2JobSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    typeof record['jobId'] === 'string' &&
    Array.isArray(record['nodes']) &&
    Array.isArray(record['artifacts']) &&
    typeof record['status'] === 'string'
  );
}

/** Parse snapshot JSON text (throws `TasksV2StoreError` on bad JSON / shape). */
export function parseTaskV2Snapshot(text: string): TaskV2JobSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TasksV2StoreError('Snapshot Tasks v2 không phải JSON hợp lệ.', 'bad-json');
  }
  if (!isTaskV2JobSnapshot(parsed)) {
    throw new TasksV2StoreError(
      'Snapshot Tasks v2 sai hình dạng (cần version 1 + jobId + nodes + artifacts + status).',
      'bad-snapshot',
    );
  }
  return parsed;
}

/** Serialise a snapshot to stable JSON text (2-space indent, sorted top-level keys). */
export function stringifyTaskV2Snapshot(snapshot: TaskV2JobSnapshot): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ['version', 'jobId', 'nodes', 'artifacts', 'status', 'createdAt', 'updatedAt'] as const) {
    ordered[key] = snapshot[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Summarise a snapshot for listings (no node detail). */
export function summarizeTaskV2Snapshot(snapshot: TaskV2JobSnapshot, bytes: number): TaskV2StoreEntry {
  const done = snapshot.nodes.filter((n) => n.status === 'completed').length;
  const failed = snapshot.nodes.filter((n) => n.status === 'failed').length;
  return {
    jobId: snapshot.jobId,
    status: snapshot.status,
    nodes: snapshot.nodes.length,
    done,
    failed,
    updatedAt: snapshot.updatedAt,
    bytes,
  };
}

/**
 * File-backed store for Tasks v2 job snapshots. One instance owns
 * one directory; writes go through temp file + rename so a crash
 * mid-write never leaves a half-written snapshot behind.
 */
export class TaskV2JobStore {
  readonly dir: string;

  constructor(dir: string) {
    if (typeof dir !== 'string' || dir.length === 0) {
      throw new TasksV2StoreError('TaskV2JobStore cần thư mục không rỗng.', 'bad-dir');
    }
    this.dir = dir;
  }

  private filePath(jobId: string): string {
    return path.join(this.dir, fileNameFor(jobId));
  }

  /** Save a job snapshot (creates the directory when needed). */
  async save(job: TaskV2Orchestrator): Promise<TaskV2StoreEntry> {
    const snapshot = job.snapshot();
    return this.saveSnapshot(snapshot);
  }

  /** Save a raw snapshot object. */
  async saveSnapshot(snapshot: TaskV2JobSnapshot): Promise<TaskV2StoreEntry> {
    const text = stringifyTaskV2Snapshot(snapshot);
    const target = this.filePath(snapshot.jobId);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, target);
    return summarizeTaskV2Snapshot(snapshot, Buffer.byteLength(text, 'utf8'));
  }

  /** Load a snapshot by job id (throws when missing / corrupt). */
  async loadSnapshot(jobId: string): Promise<TaskV2JobSnapshot> {
    const target = this.filePath(jobId);
    let text: string;
    try {
      text = await fs.readFile(target, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TasksV2StoreError(`Không có job "${jobId}" trong store.`, 'not-found');
      }
      throw err;
    }
    return parseTaskV2Snapshot(text);
  }

  /** Load a job as a live orchestrator (ready to `runAll()` / resume). */
  async loadJob(jobId: string, executor: TaskV2Executor): Promise<TaskV2Orchestrator> {
    const snapshot = await this.loadSnapshot(jobId);
    return TaskV2Orchestrator.restore(snapshot, executor);
  }

  /** True when a snapshot file exists for this job id. */
  async exists(jobId: string): Promise<boolean> {
    try {
      await fs.stat(this.filePath(jobId));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /** List all stored jobs (newest first). Corrupt files are reported, not skipped silently. */
  async list(): Promise<TaskV2StoreEntry[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries: TaskV2StoreEntry[] = [];
    const corrupt: string[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.tasks-v2.json')) continue;
      const target = path.join(this.dir, name);
      try {
        const text = await fs.readFile(target, 'utf8');
        const snapshot = parseTaskV2Snapshot(text);
        entries.push(summarizeTaskV2Snapshot(snapshot, Buffer.byteLength(text, 'utf8')));
      } catch {
        corrupt.push(name);
      }
    }
    if (corrupt.length > 0) {
      throw new TasksV2StoreError(
        `Store có ${corrupt.length} snapshot hỏng: ${corrupt.join(', ')} — sửa hoặc xoá tay trước khi list.`,
        'corrupt-snapshot',
      );
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries;
  }

  /** Delete a stored job. Returns false when it did not exist. */
  async delete(jobId: string): Promise<boolean> {
    const target = this.filePath(jobId);
    try {
      await fs.unlink(target);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Prune finished jobs older than `olderThanMs` (completed /
   * failed / cancelled only — running / partial jobs are never
   * pruned). Returns the deleted job ids.
   */
  async pruneFinished(olderThanMs: number, nowMs: number = Date.now()): Promise<string[]> {
    const entries = await this.list();
    const deleted: string[] = [];
    for (const entry of entries) {
      if (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled') {
        if (nowMs - entry.updatedAt > olderThanMs) {
          if (await this.delete(entry.jobId)) deleted.push(entry.jobId);
        }
      }
    }
    return deleted;
  }
}
