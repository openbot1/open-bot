/**
 * Workspace snapshot/restore (v1.03, Đội T4).
 *
 * Chụp trạng thái workspace: copy toàn bộ cây file + manifest
 * (relPath/size/sha256 từng file) + metadata (quota, backend, thời
 * gian). Khôi phục: kiểm tra hash manifest của bản snapshot, thay
 * nội dung workspace hiện tại bằng bản snapshot, kiểm tra lại hash
 * sau khi copy — sai hash thì rollback về nội dung cũ (giữ trong
 * thư mục tạm cho tới khi restore xong hẳn).
 *
 * Layout trên đĩa (dưới `<workspaceDir>/snapshots/<snapshotId>/`):
 *   snapshot.json  — WorkspaceSnapshotMeta (+ manifestSha256)
 *   manifest.json  — WorkspaceSnapshotManifestEntry[]
 *   files/         — bản copy cây file lúc chụp
 *
 * Không dùng tar/gzip (không phụ thuộc binary ngoài — chạy được trên
 * máy không có tar); file lớn vẫn copy bằng fs.cpSync (Node ≥24).
 * Snapshot KHÔNG chứa secret ngoài file user đã để trong workspace —
 * đó là dữ liệu của user, giống chính workspace.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  WorkspaceMeta,
  WorkspaceSnapshotManifestEntry,
  WorkspaceSnapshotMeta,
} from './types';
import { toRelPath } from './paths';

export const SNAPSHOTS_REL_DIR = 'snapshots';
/** Số snapshot giữ lại tối đa mỗi workspace (prune tự động khi tạo mới). */
export const DEFAULT_MAX_SNAPSHOTS_PER_WORKSPACE = 10;

function snapshotDir(workspaceDir: string, snapshotId: string): string {
  return path.join(workspaceDir, SNAPSHOTS_REL_DIR, snapshotId);
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  out.sort();
  return out;
}

function clearDirContents(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

export class WorkspaceSnapshotStore {
  /** Số snapshot giữ lại tối đa mỗi workspace. */
  readonly maxSnapshots: number;

  constructor(maxSnapshots: number = DEFAULT_MAX_SNAPSHOTS_PER_WORKSPACE) {
    this.maxSnapshots = Math.max(1, maxSnapshots);
  }

  /** Chụp snapshot workspace hiện tại (trả metadata). */
  create(meta: WorkspaceMeta, name?: string): WorkspaceSnapshotMeta {
    const filesDir = meta.filesDir;
    if (!fs.existsSync(filesDir)) {
      throw new Error(`workspace files dir does not exist: ${filesDir}`);
    }
    const id = `snap-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const dir = snapshotDir(meta.dir, id);
    const snapFilesDir = path.join(dir, 'files');
    fs.mkdirSync(snapFilesDir, { recursive: true });
    const files = walkFiles(filesDir);
    const manifest: WorkspaceSnapshotManifestEntry[] = [];
    let totalBytes = 0;
    for (const file of files) {
      const relPath = toRelPath(filesDir, file);
      const dest = path.join(snapFilesDir, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      const sizeBytes = fs.statSync(file).size;
      totalBytes += sizeBytes;
      manifest.push({ relPath, sizeBytes, sha256: sha256File(file) });
    }
    const manifestSha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex');
    const snapMeta: WorkspaceSnapshotMeta = {
      id,
      workspaceId: meta.id,
      name: name?.trim() ? name.trim() : id,
      backend: meta.backend,
      quota: { ...meta.quota },
      fileCount: manifest.length,
      totalBytes,
      manifestSha256,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'snapshot.json'), `${JSON.stringify(snapMeta, null, 2)}\n`, 'utf8');
    this.prune(meta, this.maxSnapshots);
    return snapMeta;
  }

  /** Liệt kê snapshot của workspace (mới nhất trước). */
  list(meta: WorkspaceMeta): WorkspaceSnapshotMeta[] {
    const root = path.join(meta.dir, SNAPSHOTS_REL_DIR);
    if (!fs.existsSync(root)) return [];
    const out: WorkspaceSnapshotMeta[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const snapMeta: WorkspaceSnapshotMeta = JSON.parse(
          fs.readFileSync(path.join(root, entry.name, 'snapshot.json'), 'utf8'),
        );
        if (snapMeta.workspaceId === meta.id) out.push(snapMeta);
      } catch {
        // snapshot hỏng (thiếu file/không parse được) — bỏ qua.
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  /** Đọc một snapshot (meta + manifest). Ném lỗi khi không có. */
  get(meta: WorkspaceMeta, snapshotId: string): { snapMeta: WorkspaceSnapshotMeta; manifest: WorkspaceSnapshotManifestEntry[] } {
    const dir = snapshotDir(meta.dir, snapshotId);
    let snapMeta: WorkspaceSnapshotMeta;
    let manifest: WorkspaceSnapshotManifestEntry[];
    try {
      snapMeta = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      throw new Error(`unknown snapshot "${snapshotId}" for workspace "${meta.id}"`);
    }
    if (snapMeta.workspaceId !== meta.id) {
      throw new Error(`snapshot "${snapshotId}" belongs to workspace "${snapMeta.workspaceId}", not "${meta.id}"`);
    }
    return { snapMeta, manifest };
  }

  /** Kiểm tra toàn vẹn snapshot: mọi file trong manifest còn đủ + hash khớp. */
  verify(meta: WorkspaceMeta, snapshotId: string): { ok: boolean; problems: string[] } {
    const { manifest } = this.get(meta, snapshotId);
    const dir = snapshotDir(meta.dir, snapshotId);
    const problems: string[] = [];
    for (const entry of manifest) {
      const file = path.join(dir, 'files', entry.relPath);
      if (!fs.existsSync(file)) {
        problems.push(`missing file in snapshot: ${entry.relPath}`);
        continue;
      }
      if (fs.statSync(file).size !== entry.sizeBytes) {
        problems.push(`size mismatch in snapshot: ${entry.relPath}`);
        continue;
      }
      if (sha256File(file) !== entry.sha256) {
        problems.push(`hash mismatch in snapshot: ${entry.relPath}`);
      }
    }
    return { ok: problems.length === 0, problems };
  }

  /**
   * Khôi phục workspace về snapshot. Kiểm tra hash trước, giữ nội
   * dung cũ trong thư mục tạm và rollback khi copy lỗi — workspace
   * không bao giờ rơi vào trạng thái nửa-vời.
   */
  restore(meta: WorkspaceMeta, snapshotId: string): WorkspaceSnapshotMeta {
    const { snapMeta, manifest } = this.get(meta, snapshotId);
    const verified = this.verify(meta, snapshotId);
    if (!verified.ok) {
      throw new Error(`snapshot "${snapshotId}" is corrupt: ${verified.problems.join('; ')}`);
    }
    const filesDir = meta.filesDir;
    const snapFilesDir = path.join(snapshotDir(meta.dir, snapshotId), 'files');
    const backupDir = path.join(meta.dir, `.restore-backup-${Date.now().toString(36)}`);
    fs.mkdirSync(filesDir, { recursive: true });
    // Giữ nội dung cũ để rollback.
    fs.mkdirSync(backupDir, { recursive: true });
    try {
      for (const entry of fs.readdirSync(filesDir)) {
        fs.renameSync(path.join(filesDir, entry), path.join(backupDir, entry));
      }
      try {
        for (const entry of manifest) {
          const src = path.join(snapFilesDir, entry.relPath);
          const dest = path.join(filesDir, entry.relPath);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        }
      } catch (err) {
        // Copy lỗi giữa chừng — rollback về nội dung cũ.
        clearDirContents(filesDir);
        for (const entry of fs.readdirSync(backupDir)) {
          fs.renameSync(path.join(backupDir, entry), path.join(filesDir, entry));
        }
        throw new Error(`restore failed, workspace rolled back: ${(err as Error).message}`);
      }
      // Kiểm tra lại hash sau khi copy.
      for (const entry of manifest) {
        const file = path.join(filesDir, entry.relPath);
        if (!fs.existsSync(file) || sha256File(file) !== entry.sha256) {
          clearDirContents(filesDir);
          for (const backupEntry of fs.readdirSync(backupDir)) {
            fs.renameSync(path.join(backupDir, backupEntry), path.join(filesDir, backupEntry));
          }
          throw new Error(`restore verification failed for ${entry.relPath}, workspace rolled back`);
        }
      }
    } finally {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    return snapMeta;
  }

  /** Xoá một snapshot (trả false khi không có). */
  delete(meta: WorkspaceMeta, snapshotId: string): boolean {
    const dir = snapshotDir(meta.dir, snapshotId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Giữ lại `keep` snapshot mới nhất, xoá phần còn lại. */
  prune(meta: WorkspaceMeta, keep: number = this.maxSnapshots): number {
    const all = this.list(meta);
    let removed = 0;
    for (const snap of all.slice(Math.max(1, keep))) {
      if (this.delete(meta, snap.id)) removed += 1;
    }
    return removed;
  }
}
