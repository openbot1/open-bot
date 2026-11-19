/**
 * Sandbox v3 — copy-on-write snapshots (v1.35, Team T2).
 *
 * A snapshot captures a session workspace as an overlay manifest:
 * every file under the workspace root is hashed (sha-256) and its
 * content copied into the snapshot store; deletions are recorded
 * as tombstones. The base workspace is never mutated by a capture —
 * that is the "copy-on-write" contract: the snapshot holds its own
 * copies, the live workspace keeps changing, and a restore writes
 * the snapshot's copies back over the workspace.
 *
 * Restore semantics, in order:
 *  1. The snapshot manifest hash is verified first; a corrupt or
 *     tampered manifest refuses to restore (fail-closed).
 *  2. Every captured file is written back (directories created as
 *     needed). Files that exist in the workspace but were NOT in
 *     the snapshot are deleted — the workspace returns to exactly
 *     the snapshot state, not "snapshot plus leftovers".
 *  3. Tombstoned paths (files deleted before the snapshot that the
 *     manifest remembers) are deleted if they reappeared.
 *  4. Files the snapshot never saw and the workspace never had are
 *     untouched (there is nothing to do).
 *
 * Safety: every path is resolved inside the workspace root before
 * any read or write (`resolveWithinV3`). A manifest entry pointing
 * outside the root (for example `../../etc/passwd`, or a symlink
 * escape) is rejected and the whole restore aborts before writing
 * anything.
 *
 * Limits: snapshots are capped by file count and total bytes per
 * snapshot and by count per session; exceeding a cap refuses the
 * capture with a clear error instead of filling the disk silently.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  SandboxV3Snapshot,
  SandboxV3SnapshotEntry,
} from './types';

/** Max files in one snapshot (default 5,000). */
export const SANDBOX_V3_SNAPSHOT_MAX_FILES = 5_000;

/** Max bytes in one snapshot (default 256 MiB). */
export const SANDBOX_V3_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;

/** Max snapshots kept per session (default 10; older ones prune). */
export const SANDBOX_V3_SNAPSHOTS_PER_SESSION = 10;

/** Max single file captured in a snapshot (default 64 MiB). */
export const SANDBOX_V3_SNAPSHOT_MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Directories never captured (caches, sockets, node_modules). */
export const SANDBOX_V3_SNAPSHOT_SKIP_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '__pycache__',
  '.cache',
  '.tmp',
];

/** Files never captured (locks, sockets, huge binaries). */
export const SANDBOX_V3_SNAPSHOT_SKIP_SUFFIXES: readonly string[] = [
  '.sock',
  '.lock',
];

/** sha-256 hex of a buffer. */
export function hashBytes(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha-256 hex of the canonical manifest JSON (integrity check). */
export function hashManifest(entries: SandboxV3SnapshotEntry[]): string {
  const canonical = JSON.stringify(
    [...entries]
      .map((entry) => ({ ...entry }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Resolve `target` inside `root`. Returns the absolute path, or
 * undefined when the target escapes the root (traversal / symlink).
 * Symlinks inside the root are resolved with realpath when they
 * exist; missing targets are checked lexically.
 */
export function resolveWithinV3(root: string, target: string): string | undefined {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, target);
  if (absolute !== absoluteRoot && !absolute.startsWith(absoluteRoot + path.sep)) {
    return undefined;
  }
  try {
    const realRoot = fs.realpathSync(absoluteRoot);
    const real = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined;
  } catch {
    // realpath failed (broken link, race): fall back to the lexical
    // check above, which already passed.
  }
  return absolute;
}

/** True when a relative path should be skipped during capture. */
export function shouldSkipSnapshotPath(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => SANDBOX_V3_SNAPSHOT_SKIP_DIRS.includes(part))) return true;
  if (SANDBOX_V3_SNAPSHOT_SKIP_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) {
    return true;
  }
  return false;
}

export interface SnapshotStoreOptions {
  /** Root dir for all snapshot data (`<base>/snapshots/`). */
  baseDir: string;
  /** Max files per snapshot. Default SANDBOX_V3_SNAPSHOT_MAX_FILES. */
  maxFiles?: number;
  /** Max bytes per snapshot. Default SANDBOX_V3_SNAPSHOT_MAX_BYTES. */
  maxBytes?: number;
  /** Max snapshots per session. Default SANDBOX_V3_SNAPSHOTS_PER_SESSION. */
  maxPerSession?: number;
}

export interface SnapshotRestoreResult {
  snapshotId: string;
  /** Files written back from the snapshot. */
  restoredFiles: number;
  /** Files deleted because they were not in the snapshot. */
  deletedFiles: number;
  /** Bytes written back. */
  bytesRestored: number;
  /** Paths that could not be restored (with reasons). */
  failures: Array<{ path: string; reason: string }>;
}

export interface SandboxV3SnapshotDiff {
  /** Files present in `to` but not in `from`. */
  added: string[];
  /** Files present in `from` but not in `to`. */
  removed: string[];
  /** Files in both with different content hashes. */
  modified: string[];
  /** Files in both with identical content. */
  unchanged: string[];
}

/**
 * On-disk snapshot store. Layout:
 *
 *   <baseDir>/<sessionId>/<snapshotId>/
 *     manifest.json   — { snapshot, entries }
 *     files/<sha256>  — content-addressed file copies
 */
export class SnapshotStore {
  private readonly baseDir: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly maxPerSession: number;
  // v1.35 fix: createdAtMs phai don dieu tang de listSnapshots ("oldest
  // first") dung that. Hai capture trong cung 1ms co createdAtMs bang
  // nhau thi sort on dinh giu thu tu UUID (ngau nhien) — list[0] co the
  // la snapshot moi hon, va prune() se xoa nham snapshot moi thay vi cu.
  private lastCreatedAtMs = 0;

  constructor(options: SnapshotStoreOptions) {
    this.baseDir = path.resolve(options.baseDir);
    this.maxFiles = options.maxFiles ?? SANDBOX_V3_SNAPSHOT_MAX_FILES;
    this.maxBytes = options.maxBytes ?? SANDBOX_V3_SNAPSHOT_MAX_BYTES;
    this.maxPerSession = options.maxPerSession ?? SANDBOX_V3_SNAPSHOTS_PER_SESSION;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /** Root dir of the store. */
  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Monotonic creation timestamp: never goes backwards and never
   * repeats within one store instance, so listSnapshots order is a
   * true creation order even when two captures land in one ms.
   */
  private nextCreatedAtMs(): number {
    const now = Date.now();
    this.lastCreatedAtMs = Math.max(now, this.lastCreatedAtMs + 1);
    return this.lastCreatedAtMs;
  }

  /**
   * Capture a snapshot of `workdir`. Walks the tree, copies every
   * captured file into content-addressed storage and writes the
   * manifest. Returns the snapshot metadata.
   */
  capture(
    sessionId: string,
    workdir: string,
    label: string,
    knownDeleted: string[] = [],
  ): SandboxV3Snapshot {
    const root = path.resolve(workdir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`Workspace "${workdir}" does not exist or is not a directory`);
    }
    const entries: SandboxV3SnapshotEntry[] = [];
    let totalBytes = 0;
    const walk = (dir: string): void => {
      const names = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      for (const item of names) {
        const full = path.join(dir, item.name);
        const relative = path.relative(root, full);
        if (shouldSkipSnapshotPath(relative)) continue;
        if (item.isDirectory()) {
          walk(full);
          continue;
        }
        if (!item.isFile()) continue;
        const stat = fs.statSync(full);
        if (stat.size > SANDBOX_V3_SNAPSHOT_MAX_FILE_BYTES) continue;
        const data = fs.readFileSync(full);
        if (entries.length + 1 > this.maxFiles) {
          throw new Error(
            `Snapshot would exceed the file cap (${this.maxFiles} files)`,
          );
        }
        if (totalBytes + data.length > this.maxBytes) {
          throw new Error(
            `Snapshot would exceed the byte cap (${this.maxBytes} bytes)`,
          );
        }
        const contentHash = hashBytes(data);
        entries.push({
          path: relative.split(path.sep).join('/'),
          kind: 'file',
          sizeBytes: data.length,
          contentHash,
          mtimeMs: stat.mtimeMs,
        });
        totalBytes += data.length;
        this.storeContent(contentHash, data);
      }
    };
    walk(root);
    for (const deleted of knownDeleted) {
      const clean = deleted.split(path.sep).join('/').replace(/^\.\//, '');
      if (clean === '' || entries.some((entry) => entry.path === clean)) continue;
      entries.push({
        path: clean,
        kind: 'deleted',
        sizeBytes: 0,
        contentHash: hashBytes(Buffer.alloc(0)),
        mtimeMs: 0,
      });
    }
    const snapshot: SandboxV3Snapshot = {
      id: randomUUID(),
      sessionId,
      createdAtMs: this.nextCreatedAtMs(),
      label,
      fileCount: entries.filter((entry) => entry.kind === 'file').length,
      totalBytes,
      deletedCount: entries.filter((entry) => entry.kind === 'deleted').length,
      manifestHash: hashManifest(entries),
    };
    const dir = this.snapshotDir(sessionId, snapshot.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ snapshot, entries }, null, 2),
      'utf8',
    );
    return snapshot;
  }

  /** Read a snapshot manifest (metadata + entries). */
  readSnapshot(
    sessionId: string,
    snapshotId: string,
  ): { snapshot: SandboxV3Snapshot; entries: SandboxV3SnapshotEntry[] } | undefined {
    const manifestPath = path.join(
      this.snapshotDir(sessionId, snapshotId),
      'manifest.json',
    );
    if (!fs.existsSync(manifestPath)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        snapshot: SandboxV3Snapshot;
        entries: SandboxV3SnapshotEntry[];
      };
      if (!parsed || typeof parsed !== 'object' || !parsed.snapshot || !Array.isArray(parsed.entries)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** List snapshots of a session, oldest first. */
  listSnapshots(sessionId: string): SandboxV3Snapshot[] {
    const sessionDir = path.join(this.baseDir, sessionId);
    if (!fs.existsSync(sessionDir)) return [];
    const out: SandboxV3Snapshot[] = [];
    for (const id of fs.readdirSync(sessionDir).sort()) {
      const read = this.readSnapshot(sessionId, id);
      if (read) out.push(read.snapshot);
    }
    out.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return out;
  }

  /** True when the manifest hash matches the stored entries. */
  verifySnapshot(sessionId: string, snapshotId: string): boolean {
    const read = this.readSnapshot(sessionId, snapshotId);
    if (!read) return false;
    if (read.snapshot.manifestHash !== hashManifest(read.entries)) return false;
    for (const entry of read.entries) {
      if (entry.kind !== 'file') continue;
      const contentPath = this.contentPath(entry.contentHash);
      if (!fs.existsSync(contentPath)) return false;
      const data = fs.readFileSync(contentPath);
      if (hashBytes(data) !== entry.contentHash) return false;
      if (data.length !== entry.sizeBytes) return false;
    }
    return true;
  }

  /**
   * Restore a snapshot into `workdir`. Verifies the manifest
   * first; on any verification failure nothing is written. Files
   * in the workspace that the snapshot never saw are deleted, so
   * the workspace returns to exactly the snapshot state.
   */
  restore(
    sessionId: string,
    snapshotId: string,
    workdir: string,
  ): SnapshotRestoreResult {
    const read = this.readSnapshot(sessionId, snapshotId);
    if (!read) {
      throw new Error(`Snapshot "${snapshotId}" not found for session "${sessionId}"`);
    }
    if (read.snapshot.manifestHash !== hashManifest(read.entries)) {
      throw new Error(
        `Snapshot "${snapshotId}" failed integrity check (manifest hash mismatch) — refusing to restore`,
      );
    }
    const root = path.resolve(workdir);
    fs.mkdirSync(root, { recursive: true });
    const result: SnapshotRestoreResult = {
      snapshotId,
      restoredFiles: 0,
      deletedFiles: 0,
      bytesRestored: 0,
      failures: [],
    };
    const wanted = new Set<string>();
    for (const entry of read.entries) {
      const target = resolveWithinV3(root, entry.path);
      if (target === undefined) {
        result.failures.push({
          path: entry.path,
          reason: 'Path escapes the workspace root',
        });
        continue;
      }
      wanted.add(entry.path);
      if (entry.kind === 'deleted') {
        if (fs.existsSync(target)) {
          try {
            fs.rmSync(target, { force: true });
            result.deletedFiles += 1;
          } catch (err) {
            result.failures.push({
              path: entry.path,
              reason: `Could not delete tombstoned file: ${(err as Error).message}`,
            });
          }
        }
        continue;
      }
      const contentPath = this.contentPath(entry.contentHash);
      if (!fs.existsSync(contentPath)) {
        result.failures.push({
          path: entry.path,
          reason: 'Snapshot content missing from store',
        });
        continue;
      }
      try {
        const data = fs.readFileSync(contentPath);
        if (hashBytes(data) !== entry.contentHash) {
          result.failures.push({
            path: entry.path,
            reason: 'Snapshot content failed integrity check',
          });
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
        fs.utimesSync(target, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
        result.restoredFiles += 1;
        result.bytesRestored += data.length;
      } catch (err) {
        result.failures.push({
          path: entry.path,
          reason: (err as Error).message,
        });
      }
    }
    // Delete workspace files the snapshot never saw.
    const extras = this.listWorkspaceFiles(root);
    for (const relative of extras) {
      if (wanted.has(relative)) continue;
      if (shouldSkipSnapshotPath(relative)) continue;
      const target = resolveWithinV3(root, relative);
      if (target === undefined) continue;
      try {
        fs.rmSync(target, { force: true });
        result.deletedFiles += 1;
      } catch (err) {
        result.failures.push({
          path: relative,
          reason: `Could not delete extra file: ${(err as Error).message}`,
        });
      }
    }
    this.pruneEmptyDirs(root);
    return result;
  }

  /** Delete one snapshot (manifest + orphaned content is left alone). */
  deleteSnapshot(sessionId: string, snapshotId: string): boolean {
    const dir = this.snapshotDir(sessionId, snapshotId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * Keep only the newest `keep` snapshots of a session; delete the
   * rest. Returns the ids deleted. Defaults to the per-session cap.
   */
  prune(sessionId: string, keep?: number): string[] {
    const limit = keep ?? this.maxPerSession;
    const all = this.listSnapshots(sessionId);
    if (all.length <= limit) return [];
    const doomed = all.slice(0, all.length - limit);
    const deleted: string[] = [];
    for (const snapshot of doomed) {
      if (this.deleteSnapshot(sessionId, snapshot.id)) deleted.push(snapshot.id);
    }
    return deleted;
  }

  /** Diff two snapshots of the same session (added/removed/modified). */
  diffSnapshots(
    sessionId: string,
    fromId: string,
    toId: string,
  ): SandboxV3SnapshotDiff {
    const from = this.readSnapshot(sessionId, fromId);
    const to = this.readSnapshot(sessionId, toId);
    if (!from) throw new Error(`Snapshot "${fromId}" not found`);
    if (!to) throw new Error(`Snapshot "${toId}" not found`);
    return diffSnapshotEntries(from.entries, to.entries);
  }

  private snapshotDir(sessionId: string, snapshotId: string): string {
    return path.join(this.baseDir, sessionId, snapshotId);
  }

  private contentPath(contentHash: string): string {
    return path.join(this.baseDir, '.content', contentHash);
  }

  private storeContent(contentHash: string, data: Buffer): void {
    const target = this.contentPath(contentHash);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }

  /** All files under a workspace root, as `/`-joined relative paths. */
  listWorkspaceFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        const full = path.join(dir, item.name);
        const relative = path.relative(root, full).split(path.sep).join('/');
        if (item.isDirectory()) {
          walk(full);
          continue;
        }
        if (item.isFile()) out.push(relative);
      }
    };
    walk(root);
    return out;
  }

  private pruneEmptyDirs(root: string): void {
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        const full = path.join(dir, item.name);
        walk(full);
        try {
          if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        } catch {
          // Directory not empty or already gone — leave it.
        }
      }
    };
    walk(root);
  }
}

/** Pure diff of two entry lists (used by `diffSnapshots` + tests). */
export function diffSnapshotEntries(
  from: SandboxV3SnapshotEntry[],
  to: SandboxV3SnapshotEntry[],
): SandboxV3SnapshotDiff {
  const fromMap = new Map(from.filter((e) => e.kind === 'file').map((e) => [e.path, e]));
  const toMap = new Map(to.filter((e) => e.kind === 'file').map((e) => [e.path, e]));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  for (const [p, entry] of toMap) {
    const before = fromMap.get(p);
    if (!before) added.push(p);
    else if (before.contentHash !== entry.contentHash) modified.push(p);
    else unchanged.push(p);
  }
  for (const p of fromMap.keys()) {
    if (!toMap.has(p)) removed.push(p);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
    unchanged: unchanged.sort(),
  };
}
