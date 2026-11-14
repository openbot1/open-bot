/**
 * Workspace — handle agent cầm + Manager vòng đời (v1.03, Đội T4).
 *
 * Agent code chỉ gọi `Workspace`: `exec` / `readFile` / `writeFile`
 * / `listFiles` / `snapshot` / `restore` / `quotaStatus`. Đổi backend
 * (local ↔ container) không đổi một dòng code agent — factory
 * `createWorkspaceBackend` chọn backend theo `meta.backend`, và
 * `WorkspaceManager.create` fallback về local (đánh dấu `degraded`)
 * khi container runtime không có trên máy.
 *
 * Mọi lần exec đi qua 3 lớp kiểm tra, theo thứ tự:
 * 1. `WorkspaceUsageWindow.checkRun` — quota cửa sổ (wall/write/disk).
 * 2. `WorkspaceExecGuard.checkExec` — mẫu lệnh nguy hiểm + exec đồng
 *    thời + allowlist/profile của sandbox enforcer.
 * 3. Backend exec — giới hạn per-run (timeout/cap ghi/cap output) +
 *    cách ly thật (bwrap/unshare/container).
 * Sau exec: ghi nhận usage, đo lại đĩa thật, lưu meta. Từ chối ở
 * lớp 1/2 thì không spawn tiến trình nào (fail-closed).
 *
 * Meta bền: `<root>/<id>/workspace.json` (quota + usage + status).
 * File agent nằm trong `filesDir` của backend (local: box workspace;
 * container: thư mục bind-mount). Snapshot nằm trong
 * `<root>/<id>/snapshots/` (xem snapshot.ts).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { SandboxAuditLogger } from '../sandbox/audit';
import { SandboxDeniedError } from '../sandbox/enforce';
import { getBuiltinSandboxProfile, SANDBOX_PROFILE_STANDARD } from '../sandbox/profiles';
import { dirFileCount, dirSizeBytes } from '../sandbox/box';
import type { WorkspaceSnapshotMeta } from './types';
import type {
  CreateWorkspaceOptions,
  WorkspaceBackend,
  WorkspaceBackendKind,
  WorkspaceEntry,
  WorkspaceExecOptions,
  WorkspaceExecResult,
  WorkspaceHostBudget,
  WorkspaceMeta,
  WorkspaceQuota,
  WorkspaceStatusView,
} from './types';
import { ContainerWorkspaceBackend, type ContainerRunner } from './container';
import { WorkspaceExecGuard } from './hardening';
import { LocalWorkspaceBackend } from './local';
import { resolveWithinRoot, toRelPath } from './paths';
import {
  WorkspaceQuotaLedger,
  WorkspaceUsageWindow,
  defaultHostBudget,
  freshWorkspaceUsage,
  resolveWorkspaceQuota,
  validateWorkspaceQuota,
} from './quota';
import { WorkspaceSnapshotStore } from './snapshot';

export const WORKSPACE_META_FILE = 'workspace.json';
export const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Số snapshot giữ lại mặc định mỗi workspace (xem snapshot.ts). */
export const DEFAULT_WORKSPACE_MAX_SNAPSHOTS = 10;

export function validateWorkspaceId(id: string): void {
  if (!WORKSPACE_ID_RE.test(id) || id.includes('..')) {
    throw new Error(`Invalid workspace id "${id}": use letters, digits, ".", "-" and "_" only.`);
  }
}

export interface WorkspaceManagerOptions {
  /** Thư mục gốc chứa mọi workspace (`<root>/<id>/...`). */
  rootDir: string;
  /** Ngân sách host (mặc định dò từ máy bằng defaultHostBudget). */
  hostBudget?: WorkspaceHostBudget;
  /** Sandbox profile áp cho exec (mặc định 'standard'). */
  profile?: string;
  /** Env allow-list thêm cho exec. */
  envAllowlist?: string[];
  /** Image container (mặc định 'alpine:latest'). */
  containerImage?: string;
  /** Runner container (mặc định defaultContainerRunner; test inject fake). */
  containerRunner?: ContainerRunner;
  /** Số snapshot giữ lại mỗi workspace (mặc định 10). */
  maxSnapshots?: number;
  /** Nơi ghi cảnh báo (mặc định im lặng). */
  logger?: { warn(message: string): void };
}

/** Factory backend — agent/manager không tự `new` backend lẻ. */
export function createWorkspaceBackend(
  kind: WorkspaceBackendKind,
  options: WorkspaceManagerOptions,
): WorkspaceBackend {
  if (kind === 'container') {
    return new ContainerWorkspaceBackend({
      rootDir: options.rootDir,
      ...(options.containerImage ? { image: options.containerImage } : {}),
      ...(options.containerRunner ? { runner: options.containerRunner } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }
  return new LocalWorkspaceBackend({
    rootDir: options.rootDir,
    ...(options.envAllowlist ? { envAllowlist: options.envAllowlist } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

function readMetaFile(metaPath: string): WorkspaceMeta {
  const meta: WorkspaceMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (!meta.id || !meta.dir || !meta.filesDir || !meta.quota) {
    throw new Error(`invalid workspace meta: ${metaPath}`);
  }
  return meta;
}

function writeMetaFileAtomic(meta: WorkspaceMeta): void {
  const metaPath = path.join(meta.dir, WORKSPACE_META_FILE);
  fs.mkdirSync(meta.dir, { recursive: true });
  const tmpPath = `${metaPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, metaPath);
}

/**
 * Một workspace đang mở — handle mà agent cầm. Mọi phương thức đều
 * kiểm tra guard/quota trước khi chạm backend hay đĩa.
 */
export class Workspace {
  readonly meta: WorkspaceMeta;
  private readonly backend: WorkspaceBackend;
  private readonly guard: WorkspaceExecGuard;
  private readonly snapshots: WorkspaceSnapshotStore;
  private readonly saveMeta: (meta: WorkspaceMeta) => void;

  constructor(
    meta: WorkspaceMeta,
    backend: WorkspaceBackend,
    options: {
      profileName?: string;
      maxSnapshots?: number;
      audit?: SandboxAuditLogger;
      saveMeta: (meta: WorkspaceMeta) => void;
    },
  ) {
    this.meta = meta;
    this.backend = backend;
    this.snapshots = new WorkspaceSnapshotStore(options.maxSnapshots ?? DEFAULT_WORKSPACE_MAX_SNAPSHOTS);
    this.saveMeta = options.saveMeta;
    // Profile của workspace (ghi trong meta lúc create) thắng profile
    // mặc định của manager; meta cũ chưa có profile thì dùng 'standard'.
    const profile =
      getBuiltinSandboxProfile(meta.profile ?? options.profileName ?? 'standard') ??
      SANDBOX_PROFILE_STANDARD;
    this.guard = new WorkspaceExecGuard({
      profile,
      ...(meta.botId ? { botId: meta.botId } : {}),
      ...(options.audit ? { audit: options.audit } : {}),
    });
  }

  get id(): string {
    return this.meta.id;
  }

  get backendKind(): WorkspaceBackendKind {
    return this.backend.kind;
  }

  get filesDir(): string {
    return this.meta.filesDir;
  }

  get quota(): WorkspaceMeta['quota'] {
    return { ...this.meta.quota };
  }

  /** Đo lại đĩa thật + cập nhật usage (không reset cửa sổ). */
  refreshUsage(): WorkspaceMeta['usage'] {
    const dir = this.meta.filesDir;
    const measured = fs.existsSync(dir)
      ? { diskBytes: dirSizeBytes(dir), fileCount: dirFileCount(dir) }
      : { diskBytes: 0, fileCount: 0 };
    const window = new WorkspaceUsageWindow(this.meta.quota, this.meta.usage);
    window.setMeasured(measured.diskBytes, measured.fileCount);
    this.meta.usage = window.current;
    this.meta.updatedAt = new Date().toISOString();
    this.saveMeta(this.meta);
    return { ...this.meta.usage };
  }

  /** Chạy một lệnh trong workspace (qua guard + quota + backend). */
  async exec(command: string, args: string[] = [], opts: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
    const startedAt = Date.now();
    const window = new WorkspaceUsageWindow(this.meta.quota, this.meta.usage);
    const fail = (stderr: string, extra: Partial<WorkspaceExecResult> = {}): WorkspaceExecResult => ({
      workspaceId: this.meta.id,
      command,
      args: [...args],
      isolation: this.meta.lastIsolation ?? { kind: 'none', isolated: false, detail: 'none — not run yet' },
      exitCode: null,
      signal: null,
      stdout: '',
      stderr,
      timedOut: false,
      writeCapExceeded: false,
      quotaDenied: true,
      workspaceBytes: this.meta.usage.diskBytes,
      durationMs: Date.now() - startedAt,
      ...extra,
    });
    // Lớp 1: quota cửa sổ — từ chối trước khi spawn.
    const allowed = window.checkRun();
    if (!allowed.allowed) return fail(`workspace quota denied: ${allowed.reason}`);
    // Lớp 2: guard — mẫu nguy hiểm + exec đồng thời + allowlist.
    // QUAN TRỌNG: guard kiểm tra toàn bộ command line (command +
    // args nối lại) — chỉ kiểm tra tên program thì `rm -rf /` sẽ
    // lọt qua vì guard chỉ thấy `rm`.
    let releaseSlot: (() => void) | undefined;
    try {
      this.guard.checkExec([command, ...args].join(' '));
      releaseSlot = this.guard.acquireExecSlot();
    } catch (err) {
      if (err instanceof SandboxDeniedError) {
        return fail(`sandbox denied exec: ${err.message}`, { quotaDenied: false });
      }
      throw err;
    }
    try {
      // Lớp 3: backend exec (timeout/cap ghi/cap output + cách ly thật).
      const beforeBytes = this.meta.usage.diskBytes;
      const result = await this.backend.exec(this.meta, command, args, opts);
      this.meta.lastIsolation = result.isolation;
      const measured = this.refreshUsage();
      const written = Math.max(0, measured.diskBytes - beforeBytes);
      window.setMeasured(measured.diskBytes, measured.fileCount);
      window.recordRun(written, result.durationMs);
      this.meta.usage = window.current;
      this.meta.updatedAt = new Date().toISOString();
      this.saveMeta(this.meta);
      return result;
    } finally {
      releaseSlot?.();
    }
  }

  /** Đọc file trong workspace (guard + symlink check). */
  readFile(relPath: string): string {
    this.guard.checkRead(this.meta.filesDir, relPath);
    const target = resolveWithinRoot(this.meta.filesDir, relPath, true);
    return fs.readFileSync(target, 'utf8');
  }

  /** Ghi file trong workspace (guard + quota ghi + symlink check). */
  writeFile(relPath: string, content: string): void {
    this.guard.checkWrite(this.meta.filesDir, relPath);
    const window = new WorkspaceUsageWindow(this.meta.quota, this.meta.usage);
    const check = window.checkWrite(Buffer.byteLength(content, 'utf8'));
    if (!check.allowed) throw new Error(`workspace quota denied: ${check.reason}`);
    const target = resolveWithinRoot(this.meta.filesDir, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    this.refreshUsage();
  }

  /** Liệt kê file/thư mục trong workspace (đệ quy, tối đa 200 entry). */
  listFiles(relPath = '.'): WorkspaceEntry[] {
    const target = resolveWithinRoot(this.meta.filesDir, relPath, true);
    const out: WorkspaceEntry[] = [];
    const walk = (dir: string): void => {
      if (out.length >= 200) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= 200) return;
        const full = path.join(dir, entry.name);
        const rel = toRelPath(this.meta.filesDir, full);
        if (entry.isDirectory()) {
          out.push({
            name: entry.name,
            relPath: rel,
            kind: 'dir',
            sizeBytes: 0,
            modifiedAt: fs.statSync(full).mtime.toISOString(),
          });
          walk(full);
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          out.push({
            name: entry.name,
            relPath: rel,
            kind: 'file',
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
      }
    };
    walk(target);
    return out;
  }

  /** Chụp snapshot workspace hiện tại. */
  createSnapshot(name?: string): WorkspaceSnapshotMeta {
    return this.snapshots.create(this.meta, name);
  }

  /** Liệt kê snapshot (mới nhất trước). */
  listSnapshots(): WorkspaceSnapshotMeta[] {
    return this.snapshots.list(this.meta);
  }

  /** Khôi phục workspace về snapshot (có rollback khi lỗi). */
  restoreSnapshot(snapshotId: string): WorkspaceSnapshotMeta {
    const restored = this.snapshots.restore(this.meta, snapshotId);
    this.refreshUsage();
    return restored;
  }

  /** Xoá một snapshot. */
  deleteSnapshot(snapshotId: string): boolean {
    return this.snapshots.delete(this.meta, snapshotId);
  }

  /** Trạng thái tổng hợp cho UI/log. */
  status(): WorkspaceStatusView {
    const usage = this.refreshUsage();
    return {
      id: this.meta.id,
      name: this.meta.name,
      botId: this.meta.botId,
      backend: this.meta.backend,
      status: this.meta.status,
      ...(this.meta.degradedReason ? { degradedReason: this.meta.degradedReason } : {}),
      profile: this.meta.profile ?? 'standard',
      isolation: this.meta.lastIsolation ?? null,
      quota: { ...this.meta.quota },
      usage,
      snapshotCount: this.snapshots.list(this.meta).length,
      createdAt: this.meta.createdAt,
      updatedAt: this.meta.updatedAt,
    };
  }
}

/**
 * Vòng đời workspace: create/get/list/destroy + ledger quota tổng.
 * Manager giữ ledger trong bộ nhớ (nạp từ đĩa lúc khởi tạo) — tạo
 * manager mới (vd mỗi lần tool chạy) vẫn thấy đúng quota đã cấp vì
 * meta đọc lại từ đĩa.
 */
export class WorkspaceManager {
  readonly rootDir: string;
  private readonly options: WorkspaceManagerOptions;
  private readonly ledger: WorkspaceQuotaLedger;
  private readonly audit?: SandboxAuditLogger;

  constructor(options: WorkspaceManagerOptions) {
    this.rootDir = options.rootDir;
    this.options = options;
    const budget = options.hostBudget ?? defaultHostBudget();
    this.ledger = new WorkspaceQuotaLedger(budget);
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.audit = new SandboxAuditLogger(path.join(this.rootDir, 'audit.log'));
    // Nạp quota đã cấp của workspace còn active vào ledger.
    for (const meta of this.listMetas()) {
      if (meta.status === 'active' || meta.status === 'degraded') {
        try {
          this.ledger.allocate(meta.id, meta.quota);
        } catch {
          // Meta cũ vượt ngân sách hiện tại (vd máy đổi) — giữ workspace
          // nhưng không cấp thêm; create mới sẽ bị từ chối tới khi đủ chỗ.
        }
      }
    }
  }

  get hostBudget(): WorkspaceHostBudget {
    return this.ledger.hostBudget;
  }

  get allocated(): { cpuCores: number; ramBytes: number; diskBytes: number; workspaces: number } {
    return this.ledger.allocated;
  }

  get remainingBudget(): WorkspaceHostBudget {
    return this.ledger.remaining;
  }

  /** Tạo workspace mới (từ chối khi hết ngân sách host). */
  create(opts: CreateWorkspaceOptions = {}): Workspace {
    const id = opts.id?.trim() ? opts.id.trim() : `ws-${randomUUID().slice(0, 8)}`;
    validateWorkspaceId(id);
    const metaPath = path.join(this.rootDir, id, WORKSPACE_META_FILE);
    if (fs.existsSync(metaPath)) {
      throw new Error(`workspace "${id}" already exists`);
    }
    const quota = resolveWorkspaceQuota(opts.quota ?? {}, this.ledger.hostBudget);
    const problems = validateWorkspaceQuota(quota);
    if (problems.length > 0) throw new Error(`invalid workspace quota: ${problems.join('; ')}`);
    // Validate profile TRƯỚC khi cấp ledger (tránh rò rỉ quota khi create lỗi sau đó).
    const profileName = opts.profile?.trim().toLowerCase() || 'standard';
    const profile = getBuiltinSandboxProfile(profileName);
    if (!profile) throw new Error(`unknown sandbox profile "${opts.profile}"`);
    this.ledger.allocate(id, quota);
    const requestedBackend = opts.backend ?? 'local';
    let backend = createWorkspaceBackend(requestedBackend, this.options);
    let status: WorkspaceMeta['status'] = 'active';
    let degradedReason: string | undefined;
    let effectiveBackend = requestedBackend;
    if (!backend.available) {
      // Fallback trung thực: container không có thì chạy local, đánh
      // dấu degraded + lý do — không bao giờ giả vờ đã container.
      degradedReason =
        backend.unavailableReason ??
        `container backend "${requestedBackend}" is unavailable — fell back to local execution`;
      backend = createWorkspaceBackend('local', this.options);
      effectiveBackend = 'local';
      status = 'degraded';
    }
    const now = new Date().toISOString();
    const meta: WorkspaceMeta = {
      id,
      name: opts.name?.trim() ? opts.name.trim() : id,
      botId: opts.botId ?? '',
      backend: effectiveBackend,
      ...(requestedBackend !== effectiveBackend ? { requestedBackend } : {}),
      dir: path.join(this.rootDir, id),
      filesDir: backend.filesDir(id),
      quota,
      usage: freshWorkspaceUsage(),
      profile: profile.name,
      status,
      ...(degradedReason ? { degradedReason } : {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      backend.prepare(meta);
    } catch (err) {
      this.ledger.release(id);
      throw err;
    }
    writeMetaFileAtomic(meta);
    return this.open(meta);
  }

  /** Mở workspace đã có (đọc meta từ đĩa; backend container mất thì degraded + local). */
  get(id: string): Workspace {
    validateWorkspaceId(id);
    const meta = this.readMeta(id);
    return this.open(meta);
  }

  /** Liệt kê mọi workspace (mới nhất trước). */
  list(): WorkspaceMeta[] {
    return this.listMetas().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Xoá workspace (backend destroy + xoá thư mục meta + giải phóng quota). */
  destroy(id: string): boolean {
    validateWorkspaceId(id);
    let meta: WorkspaceMeta;
    try {
      meta = this.readMeta(id);
    } catch {
      return false;
    }
    const backend = this.backendFor(meta);
    try {
      backend.destroy(meta);
    } catch {
      // Backend destroy lỗi (vd container đã mất) — vẫn xoá thư mục.
    }
    fs.rmSync(meta.dir, { recursive: true, force: true });
    this.ledger.release(id);
    return true;
  }

  /** Đổi quota workspace (kiểm tra lại ngân sách còn lại). */
  updateQuota(id: string, quota: WorkspaceQuota): WorkspaceMeta {
    const meta = this.readMeta(id);
    const resolved = resolveWorkspaceQuota(quota, this.ledger.hostBudget);
    const problems = validateWorkspaceQuota(resolved);
    if (problems.length > 0) throw new Error(`invalid workspace quota: ${problems.join('; ')}`);
    this.ledger.release(id);
    try {
      this.ledger.allocate(id, resolved);
    } catch (err) {
      this.ledger.allocate(id, meta.quota);
      throw err;
    }
    meta.quota = resolved;
    meta.updatedAt = new Date().toISOString();
    writeMetaFileAtomic(meta);
    return meta;
  }

  /** Trạng thái tổng hợp của workspace (đo đĩa thật). */
  status(id: string): WorkspaceStatusView {
    return this.get(id).status();
  }

  private readMeta(id: string): WorkspaceMeta {
    const metaPath = path.join(this.rootDir, id, WORKSPACE_META_FILE);
    try {
      return readMetaFile(metaPath);
    } catch {
      throw new Error(`unknown workspace "${id}" (no ${WORKSPACE_META_FILE} under ${this.rootDir})`);
    }
  }

  private listMetas(): WorkspaceMeta[] {
    if (!fs.existsSync(this.rootDir)) return [];
    const out: WorkspaceMeta[] = [];
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(this.rootDir, entry.name, WORKSPACE_META_FILE);
      if (!fs.existsSync(metaPath)) continue;
      try {
        out.push(readMetaFile(metaPath));
      } catch {
        // Meta hỏng — bỏ qua (không xoá dữ liệu user).
      }
    }
    return out;
  }

  /** Backend cho meta đã lưu (container mất runtime thì fallback local + degraded trong bộ nhớ). */
  private backendFor(meta: WorkspaceMeta): WorkspaceBackend {
    const backend = createWorkspaceBackend(meta.backend, this.options);
    if (backend.available) return backend;
    return createWorkspaceBackend('local', this.options);
  }

  private open(meta: WorkspaceMeta): Workspace {
    const backend = this.backendFor(meta);
    // Backend yêu cầu không khả dụng (vd container mất runtime) thì
    // backendFor đã fallback về local — đánh dấu degraded trong bộ nhớ.
    const fellBack = backend.kind !== meta.backend;
    const openMeta: WorkspaceMeta = {
      ...meta,
      backend: backend.kind,
      ...(fellBack && meta.status === 'active'
        ? { status: 'degraded' as const, degradedReason: `container backend "${meta.backend}" is unavailable on this machine — running on local backend` }
        : {}),
    };
    return new Workspace(openMeta, backend, {
      profileName: this.options.profile,
      maxSnapshots: this.options.maxSnapshots,
      audit: this.audit,
      saveMeta: (next) => writeMetaFileAtomic(next),
    });
  }
}
