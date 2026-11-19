/**
 * A2A v1.0 persistence (v11 generation) — file-backed task store,
 * peer registry snapshot, and audit export.
 *
 * The in-memory store/registry/log are fast but die with the
 * process. This module is the durable side, with three rules:
 *
 *  - ATOMIC WRITES: every snapshot is written to a temp file in the
 *    same directory and renamed over the target, so a crash mid-write
 *    never leaves a half-written file.
 *  - NEVER OVERWRITE BLINDLY: loading validates the shape first; a
 *    corrupt file is reported (with its path) instead of silently
 *    replacing live state or crashing the host.
 *  - NO SECRETS ON DISK: registry snapshots store cards (which may
 *    carry a signature envelope — public) but never signing keys or
 *    shared secrets. A snapshot that contains a secret-shaped value
 *    is refused.
 *
 * Files (all JSON, all under one directory chosen by the host):
 *  - `a2a-v11-tasks.json`   — array of V11Task
 *  - `a2a-v11-peers.json`   — array of V11PeerRecord
 *  - `a2a-v11-audit.json`   — array of V11AuditEntry (hash-chained)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { V11AuditLog, redactV11AuditText } from './audit';
import { V11PeerRegistry, type V11PeerRecord } from './registry';
import { V11TaskStore } from './taskStore';
import { isV11TerminalState, type V11Task } from './types';

export const V11_TASKS_FILE_NAME = 'a2a-v11-tasks.json';
export const V11_PEERS_FILE_NAME = 'a2a-v11-peers.json';
export const V11_AUDIT_FILE_NAME = 'a2a-v11-audit.json';

/** A secret-shaped value found where it must never be. */
export class V11PersistSecretError extends Error {
  constructor(file: string) {
    super(`refusing to persist ${file}: it contains a secret-shaped value`);
    this.name = 'V11PersistSecretError';
  }
}

const V11_SECRET_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,
  /\b(ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

/** True when the text contains a secret-shaped value. */
export function v11TextHasSecret(text: string): boolean {
  return V11_SECRET_SHAPES.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/** Ensure a directory exists (created recursively when missing). */
export function ensureV11Dir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Atomic write: temp file + rename, same directory. */
export function writeV11FileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  ensureV11Dir(dir);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Read a JSON file. Returns undefined when the file does not exist. */
export function readV11JsonFile<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

/** Is the value shaped like a V11Task (minimal structural check)? */
export function isV11TaskShape(value: unknown): value is V11Task {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const t = value as Partial<V11Task>;
  return (
    typeof t.id === 'string' &&
    t.id.length > 0 &&
    typeof t.contextId === 'string' &&
    typeof t.state === 'string' &&
    typeof t.createdAt === 'string' &&
    typeof t.updatedAt === 'string'
  );
}

/** Is the value shaped like a V11PeerRecord (minimal check)? */
export function isV11PeerRecordShape(value: unknown): value is V11PeerRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Partial<V11PeerRecord>;
  return (
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    p.card !== null &&
    typeof p.card === 'object' &&
    typeof p.status === 'string' &&
    typeof p.trustScore === 'number'
  );
}

/** Snapshot of everything the v11 subsystem owns, for one directory. */
export interface V11PersistedState {
  tasks: V11Task[];
  peers: V11PeerRecord[];
  /** Audit entries (hash-chained, oldest first). */
  audit: ReturnType<V11AuditLog['all']>;
  savedAt: string;
}

/** Persist tasks + peers + audit into a directory (3 files). */
export function saveV11State(
  dir: string,
  input: { store: V11TaskStore; registry: V11PeerRegistry; audit: V11AuditLog },
): V11PersistedState {
  const state: V11PersistedState = {
    tasks: input.store.all(),
    peers: input.registry.listPeers(),
    audit: input.audit.all(),
    savedAt: new Date().toISOString(),
  };
  const tasksJson = JSON.stringify(state.tasks, null, 2);
  const peersJson = JSON.stringify(state.peers, null, 2);
  const auditJson = JSON.stringify(state.audit, null, 2);
  if (v11TextHasSecret(peersJson)) {
    throw new V11PersistSecretError(V11_PEERS_FILE_NAME);
  }
  if (v11TextHasSecret(auditJson)) {
    throw new V11PersistSecretError(V11_AUDIT_FILE_NAME);
  }
  writeV11FileAtomic(path.join(dir, V11_TASKS_FILE_NAME), tasksJson);
  writeV11FileAtomic(path.join(dir, V11_PEERS_FILE_NAME), peersJson);
  writeV11FileAtomic(path.join(dir, V11_AUDIT_FILE_NAME), auditJson);
  return state;
}

/** What loading found (and what was wrong, if anything). */
export interface V11LoadResult {
  tasks: V11Task[];
  peers: V11PeerRecord[];
  audit: ReturnType<V11AuditLog['all']>;
  /** Files that existed but failed to parse/validate (reported, not fatal). */
  problems: { file: string; message: string }[];
}

/** Load persisted state from a directory. Missing files = empty lists. */
export function loadV11State(dir: string): V11LoadResult {
  const problems: { file: string; message: string }[] = [];
  const tasks: V11Task[] = [];
  const peers: V11PeerRecord[] = [];
  const audit: ReturnType<V11AuditLog['all']> = [];

  const tasksPath = path.join(dir, V11_TASKS_FILE_NAME);
  try {
    const raw = readV11JsonFile<unknown>(tasksPath);
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (isV11TaskShape(item)) tasks.push(item);
        else problems.push({ file: V11_TASKS_FILE_NAME, message: 'skipped a task with a bad shape' });
      }
    } else if (raw !== undefined) {
      problems.push({ file: V11_TASKS_FILE_NAME, message: 'top level is not an array' });
    }
  } catch (err) {
    problems.push({ file: V11_TASKS_FILE_NAME, message: err instanceof Error ? err.message : String(err) });
  }

  const peersPath = path.join(dir, V11_PEERS_FILE_NAME);
  try {
    const raw = readV11JsonFile<unknown>(peersPath);
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (isV11PeerRecordShape(item)) peers.push(item);
        else problems.push({ file: V11_PEERS_FILE_NAME, message: 'skipped a peer with a bad shape' });
      }
    } else if (raw !== undefined) {
      problems.push({ file: V11_PEERS_FILE_NAME, message: 'top level is not an array' });
    }
  } catch (err) {
    problems.push({ file: V11_PEERS_FILE_NAME, message: err instanceof Error ? err.message : String(err) });
  }

  const auditPath = path.join(dir, V11_AUDIT_FILE_NAME);
  try {
    const raw = readV11JsonFile<unknown>(auditPath);
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item !== null && typeof item === 'object' && typeof (item as { seq?: unknown }).seq === 'number') {
          audit.push(item as ReturnType<V11AuditLog['all']>[number]);
        } else {
          problems.push({ file: V11_AUDIT_FILE_NAME, message: 'skipped an audit entry with a bad shape' });
        }
      }
    } else if (raw !== undefined) {
      problems.push({ file: V11_AUDIT_FILE_NAME, message: 'top level is not an array' });
    }
  } catch (err) {
    problems.push({ file: V11_AUDIT_FILE_NAME, message: err instanceof Error ? err.message : String(err) });
  }

  return { tasks, peers, audit, problems };
}

/** Restore a task store from loaded tasks (skips duplicates). */
export function restoreV11TaskStore(tasks: V11Task[]): V11TaskStore {
  const store = new V11TaskStore();
  for (const task of tasks) {
    try {
      // Re-create through the store so ids stay unique; keep the
      // original id / timestamps by putting the task back directly
      // via create-then-put when the id is fresh.
      const created = store.create({
        id: task.id,
        contextId: task.contextId,
        ...(task.tenantId !== undefined ? { tenantId: task.tenantId } : {}),
        ...(task.peerId !== undefined ? { peerId: task.peerId } : {}),
        ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
      });
      void created;
      // The stored task already carries history/artifacts/state; put
      // the full record back (create() only made the shell).
      store.put(task);
    } catch {
      // Duplicate id or bad record: skip, keep going.
    }
  }
  return store;
}

/** Summary counts for a directory's persisted state (no loading of bodies). */
export function summarizeV11PersistedState(loaded: V11LoadResult): {
  tasks: number;
  activeTasks: number;
  awaitingInput: number;
  peers: number;
  allowlistedPeers: number;
  auditEntries: number;
  problems: number;
} {
  return {
    tasks: loaded.tasks.length,
    activeTasks: loaded.tasks.filter((t) => !isV11TerminalState(t.state)).length,
    awaitingInput: loaded.tasks.filter((t) => t.state === 'input-required').length,
    peers: loaded.peers.length,
    allowlistedPeers: loaded.peers.filter((p) => p.status === 'allowlisted').length,
    auditEntries: loaded.audit.length,
    problems: loaded.problems.length,
  };
}

/** One-line summary of a persisted state (safe to log). */
export function describeV11PersistedState(loaded: V11LoadResult): string {
  const s = summarizeV11PersistedState(loaded);
  const problems = s.problems > 0 ? `, ${s.problems} problem(s)` : '';
  return redactV11AuditText(
    `A2A v11 persisted: ${s.tasks} task(s) (${s.activeTasks} active, ${s.awaitingInput} awaiting input), ` +
      `${s.peers} peer(s) (${s.allowlistedPeers} allowlisted), ${s.auditEntries} audit entries${problems}`,
  );
}
