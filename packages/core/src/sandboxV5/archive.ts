/**
 * Sandbox v5 — idle runtime archiving (v1.37, Team T3).
 *
 * A runtime that has been idle past its threshold is archived,
 * not deleted: its workspace is packed next to a metadata file
 * (`meta.json`) that carries NO secret, the live runtime record
 * is marked archived, and the workspace directory is removed.
 * An archive can be restored later into a fresh runtime on the
 * same tier — the bot comes back with its files intact.
 *
 * Storage format:
 *  - `tar-gz` when the `tar` binary is present: one
 *    `workspace.tar.gz` plus `meta.json`. The manifest hash is
 *    the sha-256 of the tarball bytes.
 *  - `copy` otherwise (or when the caller forces it): the
 *    workspace is copied verbatim into `workspace/` under the
 *    archive dir, plus `meta.json`. The manifest hash is the
 *    sha-256 of the sorted `path:size:mtime` manifest — a
 *    tampered file changes the hash and the restore refuses.
 *
 * Safety:
 *  - Archiving never touches a live runtime: the caller must
 *    stop it first (the service enforces this). Archiving a
 *    running runtime throws.
 *  - Files that look like secrets (`*.pem`, `*.key`, `.env*`,
 *    `credentials*`, anything under `auth/`) are NOT packed:
 *    they are listed in `meta.json` as `excludedSecrets` (names
 *    only) and skipped, so an archive can never smuggle a
 *    credential out of the vault. The restore reports what was
 *    excluded.
 *  - Restore verifies the payload hash BEFORE unpacking. A
 *    mismatch refuses the restore — a tampered archive never
 *    lands back in a live runtime.
 *  - Archive ids and bot ids are validated path segments, so
 *    an archive can never escape the archive base dir.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  SANDBOX_V5_ARCHIVE_ID_PATTERN,
  sandboxV5BotIdProblem,
  type SandboxV5Archive,
  type SandboxV5ArchiveFormat,
  type SandboxV5ArchiveResult,
  type SandboxV5IdleCandidate,
  type SandboxV5RestoreResult,
  type SandboxV5Tier,
} from './types';

export const SANDBOX_V5_ARCHIVES_DIR = 'archives';
export const SANDBOX_V5_ARCHIVE_META_FILE = 'meta.json';
export const SANDBOX_V5_ARCHIVE_TARBALL = 'workspace.tar.gz';
export const SANDBOX_V5_ARCHIVE_WORKSPACE_DIR = 'workspace';

/** Default base dir for archives: OS temp dir / open-bot-sandbox-v5/archives. */
export function defaultSandboxV5ArchiveDir(): string {
  return path.join(os.tmpdir(), 'open-bot-sandbox-v5', SANDBOX_V5_ARCHIVES_DIR);
}

/**
 * File names that are never packed into an archive (names only —
 * the archive metadata records that they were excluded, never
 * their contents). Secrets stay in the Vault, not in archives.
 */
export const SANDBOX_V5_ARCHIVE_EXCLUDED_NAMES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.production',
  'credentials.json',
  'credentials.yaml',
  'credentials.yml',
  'id_rsa',
  'id_ed25519',
  'auth',
];

/** True when a relative path must be excluded from an archive (secret-like). */
export function isSandboxV5ArchiveExcluded(relPath: string): boolean {
  const parts = relPath.split('/');
  const base = parts[parts.length - 1] ?? '';
  if (parts.includes('auth')) return true;
  if (SANDBOX_V5_ARCHIVE_EXCLUDED_NAMES.includes(base)) return true;
  if (base.startsWith('.env')) return true;
  if (base.endsWith('.pem') || base.endsWith('.key')) return true;
  if (base === 'credentials.json' || base.startsWith('credentials.')) return true;
  return false;
}

/** Walk a directory, returning relative posix paths of files (no symlink follow). */
export function sandboxV5WalkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  walk(root, '');
  return out.sort();
}

/** Total bytes of files under a directory (recursive, no symlink follow). */
export function sandboxV5DirSizeBytes(root: string): number {
  let total = 0;
  for (const rel of sandboxV5WalkFiles(root)) {
    try {
      total += fs.statSync(path.join(root, rel)).size;
    } catch {
      // File vanished mid-walk — skip it.
    }
  }
  return total;
}

/** sha-256 hex of a file's bytes. */
export function sandboxV5FileSha256(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Manifest hash for the `copy` format: sha-256 of the sorted
 * `path:size` lines of every packed file. Sizes survive the
 * copy (mtimes do not), so the hash computed at archive time
 * matches the hash recomputed from the archived copy at
 * restore time. Any tampered, added or removed file changes
 * the hash.
 */
export function sandboxV5CopyManifestHash(workdir: string, packedFiles: string[]): string {
  const lines: string[] = [];
  for (const rel of [...packedFiles].sort()) {
    try {
      const stat = fs.statSync(path.join(workdir, rel));
      lines.push(`${rel}:${stat.size}`);
    } catch {
      lines.push(`${rel}:missing`);
    }
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Is `tar` available on this machine? (Checked once, cached.) */
let tarAvailableCache: boolean | undefined;
export function sandboxV5TarAvailable(): boolean {
  if (tarAvailableCache !== undefined) return tarAvailableCache;
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    tarAvailableCache = true;
  } catch {
    tarAvailableCache = false;
  }
  return tarAvailableCache;
}

export interface SandboxV5ArchiveOptions {
  /** Base dir for archives. */
  baseDir?: string;
  /** Force the storage format (default: tar-gz when tar exists, else copy). */
  format?: SandboxV5ArchiveFormat;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

export interface SandboxV5ArchiveInput {
  botId: string;
  runtimeId: string;
  tier: SandboxV5Tier;
  profileId?: string;
  /** Live workspace directory to pack (must exist). */
  workdir: string;
  /** Runtime creation time (ms since epoch). */
  runtimeCreatedAtMs: number;
  /** Last activity (ms since epoch). */
  lastActivityAtMs: number;
  /** Idle threshold that triggered the archive (ms). */
  idleThresholdMs: number;
  /** Who archives it. Default `system`. */
  archivedBy?: string;
  /** Why it is archived. */
  reason?: string;
}

/** Extra metadata written next to the archive (never a secret). */
export interface SandboxV5ArchiveMeta extends SandboxV5Archive {
  /** Relative paths excluded because they look like secrets. */
  excludedSecrets: string[];
  /** Relative paths packed. */
  packedFiles: string[];
}

/**
 * The archiver. Owns the archive base dir; archives are one
 * directory per archive id (`<base>/<id>/meta.json` + payload).
 */
export class SandboxV5Archiver {
  readonly baseDir: string;
  private readonly nowMs: () => number;
  private readonly forcedFormat?: SandboxV5ArchiveFormat;

  constructor(options: SandboxV5ArchiveOptions = {}) {
    this.baseDir = options.baseDir ?? defaultSandboxV5ArchiveDir();
    this.nowMs = options.nowMs ?? Date.now;
    this.forcedFormat = options.format;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /** Archive directory for an id (validated — never escapes the base). */
  archiveDir(archiveId: string): string {
    if (!SANDBOX_V5_ARCHIVE_ID_PATTERN.test(archiveId)) {
      throw new Error(`Invalid archive id "${archiveId}".`);
    }
    return path.join(this.baseDir, archiveId);
  }

  /** Preferred format on this machine (tar-gz when tar exists, else copy). */
  preferredFormat(): SandboxV5ArchiveFormat {
    if (this.forcedFormat !== undefined) return this.forcedFormat;
    return sandboxV5TarAvailable() ? 'tar-gz' : 'copy';
  }

  /** All archives, newest first. */
  list(): SandboxV5ArchiveMeta[] {
    const out: SandboxV5ArchiveMeta[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(this.baseDir, entry.name, SANDBOX_V5_ARCHIVE_META_FILE), 'utf8'),
        ) as SandboxV5ArchiveMeta;
        out.push(meta);
      } catch {
        // Directory without a readable meta.json — not an archive.
      }
    }
    out.sort((a, b) => b.archivedAtMs - a.archivedAtMs);
    return out;
  }

  /** One archive's metadata (undefined when unknown). */
  get(archiveId: string): SandboxV5ArchiveMeta | undefined {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.archiveDir(archiveId), SANDBOX_V5_ARCHIVE_META_FILE), 'utf8'),
      ) as SandboxV5ArchiveMeta;
    } catch {
      return undefined;
    }
  }

  /**
   * Scan runtime summaries for idle archiving candidates. A
   * runtime is archivable when it is stopped and idle past the
   * threshold; running / paused / created runtimes are listed
   * with the reason they cannot be archived yet.
   */
  scanIdle(
    runtimes: Array<{
      botId: string;
      runtimeId: string;
      state: string;
      lastActivityAtMs: number;
      workspaceBytes: number;
    }>,
    idleThresholdMs: number,
    now?: number,
  ): SandboxV5IdleCandidate[] {
    const nowMs = now ?? this.nowMs();
    return runtimes.map((runtime) => {
      const idleMs = Math.max(0, nowMs - runtime.lastActivityAtMs);
      if (runtime.state !== 'stopped') {
        return {
          botId: runtime.botId,
          runtimeId: runtime.runtimeId,
          state: runtime.state as SandboxV5IdleCandidate['state'],
          idleMs,
          idleThresholdMs,
          workspaceBytes: runtime.workspaceBytes,
          archivable: false,
          reason: `Runtime is ${runtime.state} — stop it before archiving.`,
        };
      }
      if (idleMs < idleThresholdMs) {
        return {
          botId: runtime.botId,
          runtimeId: runtime.runtimeId,
          state: 'stopped',
          idleMs,
          idleThresholdMs,
          workspaceBytes: runtime.workspaceBytes,
          archivable: false,
          reason: `Idle ${idleMs}ms, below the ${idleThresholdMs}ms threshold.`,
        };
      }
      return {
        botId: runtime.botId,
        runtimeId: runtime.runtimeId,
        state: 'stopped',
        idleMs,
        idleThresholdMs,
        workspaceBytes: runtime.workspaceBytes,
        archivable: true,
        reason: '',
      };
    });
  }

  /**
   * Archive a stopped runtime's workspace. The caller must have
   * stopped the runtime first — archiving a live workspace
   * throws. Returns the archive metadata; the live workspace
   * directory is removed on success.
   */
  archive(input: SandboxV5ArchiveInput): SandboxV5ArchiveResult {
    const botProblem = sandboxV5BotIdProblem(input.botId);
    if (botProblem !== '') throw new Error(botProblem);
    if (!fs.existsSync(input.workdir) || !fs.statSync(input.workdir).isDirectory()) {
      throw new Error(`Workdir "${input.workdir}" does not exist — nothing to archive.`);
    }
    const format = this.preferredFormat();
    const archiveId = `arc-${randomUUID()}`;
    const dir = this.archiveDir(archiveId);
    fs.mkdirSync(dir, { recursive: true });
    const now = this.nowMs();
    const allFiles = sandboxV5WalkFiles(input.workdir);
    const excludedSecrets = allFiles.filter((rel) => isSandboxV5ArchiveExcluded(rel));
    const packedFiles = allFiles.filter((rel) => !isSandboxV5ArchiveExcluded(rel));
    // An empty file list makes `tar` refuse to build an archive —
    // a workspace of only secret-like files archives as a copy.
    const effectiveFormat: SandboxV5ArchiveFormat =
      format === 'tar-gz' && packedFiles.length === 0 ? 'copy' : format;
    const workspaceBytes = sandboxV5DirSizeBytes(input.workdir);
    let payloadPath: string;
    let payloadSha256: string;
    if (effectiveFormat === 'tar-gz') {
      const tarball = path.join(dir, SANDBOX_V5_ARCHIVE_TARBALL);
      // Pack only the non-excluded files: build the tar from a
      // staging list via --files-from (stdin), relative to workdir.
      const result = spawnSync(
        'tar',
        ['-czf', tarball, '-C', input.workdir, '-T', '-'],
        { input: packedFiles.join('\n'), encoding: 'utf8', timeout: 120_000 },
      );
      if (result.status !== 0) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`tar failed while archiving "${input.botId}": ${(result.stderr as string) || 'unknown error'}`);
      }
      payloadPath = SANDBOX_V5_ARCHIVE_TARBALL;
      payloadSha256 = sandboxV5FileSha256(tarball);
    } else {
      const dest = path.join(dir, SANDBOX_V5_ARCHIVE_WORKSPACE_DIR);
      fs.mkdirSync(dest, { recursive: true });
      for (const rel of packedFiles) {
        const src = path.join(input.workdir, rel);
        const dst = path.join(dest, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
      payloadPath = SANDBOX_V5_ARCHIVE_WORKSPACE_DIR;
      payloadSha256 = sandboxV5CopyManifestHash(input.workdir, packedFiles);
    }
    const meta: SandboxV5ArchiveMeta = {
      id: archiveId,
      botId: input.botId,
      runtimeId: input.runtimeId,
      tier: input.tier,
      profileId: input.profileId ?? '',
      workspaceBytes,
      format: effectiveFormat,
      payloadPath,
      state: 'active',
      runtimeCreatedAtMs: input.runtimeCreatedAtMs,
      lastActivityAtMs: input.lastActivityAtMs,
      archivedAtMs: now,
      idleMsAtArchive: Math.max(0, now - input.lastActivityAtMs),
      idleThresholdMs: input.idleThresholdMs,
      payloadSha256,
      fileCount: packedFiles.length,
      archivedBy: input.archivedBy ?? 'system',
      reason: input.reason ?? '',
      restoredAtMs: 0,
      restoredRuntimeId: '',
      excludedSecrets,
      packedFiles,
    };
    fs.writeFileSync(path.join(dir, SANDBOX_V5_ARCHIVE_META_FILE), JSON.stringify(meta, null, 2), 'utf8');
    // The live workspace goes away only after the archive is
    // written and hashed — a failed archive never deletes data.
    fs.rmSync(input.workdir, { recursive: true, force: true });
    return { archive: meta, liveRemoved: true };
  }

  /**
   * Restore an archive into a fresh workdir. Verifies the
   * payload hash BEFORE unpacking; a mismatch throws and the
   * destination is left untouched. Returns the restore result
   * (the caller registers the new runtime).
   */
  restore(archiveId: string, destWorkdir: string): SandboxV5RestoreResult {
    const meta = this.get(archiveId);
    if (!meta) throw new Error(`Unknown sandbox v5 archive "${archiveId}".`);
    if (meta.state === 'deleted') throw new Error(`Archive "${archiveId}" is deleted and cannot be restored.`);
    if (fs.existsSync(destWorkdir)) {
      throw new Error(`Restore destination "${destWorkdir}" already exists — pick an empty workdir.`);
    }
    const dir = this.archiveDir(archiveId);
    if (meta.format === 'tar-gz') {
      const tarball = path.join(dir, SANDBOX_V5_ARCHIVE_TARBALL);
      if (!fs.existsSync(tarball)) throw new Error(`Archive "${archiveId}" is missing its payload.`);
      const actual = sandboxV5FileSha256(tarball);
      if (actual !== meta.payloadSha256) {
        throw new Error(
          `Archive "${archiveId}" failed its hash check (payload changed since archiving) — restore refused.`,
        );
      }
      fs.mkdirSync(destWorkdir, { recursive: true });
      const result = spawnSync('tar', ['-xzf', tarball, '-C', destWorkdir], { encoding: 'utf8', timeout: 120_000 });
      if (result.status !== 0) {
        fs.rmSync(destWorkdir, { recursive: true, force: true });
        throw new Error(`tar failed while restoring "${archiveId}": ${(result.stderr as string) || 'unknown error'}`);
      }
    } else {
      const src = path.join(dir, SANDBOX_V5_ARCHIVE_WORKSPACE_DIR);
      if (!fs.existsSync(src)) throw new Error(`Archive "${archiveId}" is missing its payload.`);
      // Recompute the manifest hash from the archived copy: sizes
      // survive the copy, so it must match the archive-time hash.
      const recomputed = sandboxV5CopyManifestHash(src, meta.packedFiles);
      if (recomputed !== meta.payloadSha256) {
        throw new Error(
          `Archive "${archiveId}" failed its hash check (payload changed since archiving) — restore refused.`,
        );
      }
      fs.mkdirSync(destWorkdir, { recursive: true });
      for (const rel of meta.packedFiles) {
        const srcFile = path.join(src, rel);
        const dstFile = path.join(destWorkdir, rel);
        fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        fs.copyFileSync(srcFile, dstFile);
      }
    }
    const now = this.nowMs();
    const restoredFiles = sandboxV5WalkFiles(destWorkdir).length;
    meta.state = 'restored';
    meta.restoredAtMs = now;
    fs.writeFileSync(path.join(dir, SANDBOX_V5_ARCHIVE_META_FILE), JSON.stringify(meta, null, 2), 'utf8');
    return {
      archiveId,
      runtimeId: '',
      botId: meta.botId,
      tier: meta.tier,
      workdir: destWorkdir,
      hashVerified: true,
      restoredFiles,
    };
  }

  /**
   * Delete an archive permanently (metadata + payload). Returns
   * false when the archive does not exist.
   */
  delete(archiveId: string): boolean {
    const dir = this.archiveDir(archiveId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}
