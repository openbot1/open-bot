/**
 * Local workspace backend (v1.03, Đội T4).
 *
 * Backend `local`: chạy trong BotBoxManager hiện có (xem
 * sandbox/box.ts) — thư mục riêng + env allow-list + bwrap/unshare
 * khi có, chạy thường + cảnh báo rõ khi không có. Không phá API cũ:
 * box được tạo 1-1 với workspace (botId của box = `ws-<workspaceId>`),
 * mọi giới hạn per-run (timeout/cap ghi/cap output) lấy từ quota của
 * workspace mỗi lần exec — đổi quota không cần tạo lại box.
 *
 * Giới hạn prlimit (CPU/RAM/process — xem sandbox/types.ts) là
 * box-level nên chỉ áp lúc tạo box; quota đổi sau đó vẫn được enforce
 * ở tầng Workspace (cửa sổ sử dụng + kiểm tra đĩa sau mỗi lần chạy).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { BotBoxManager, BOXES_REL_DIR, dirFileCount, dirSizeBytes } from '../sandbox/box';
import type { IsolationInfo } from '../sandbox/types';
import { detectIsolation } from '../sandbox/env';
import type {
  WorkspaceBackend,
  WorkspaceBackendKind,
  WorkspaceExecOptions,
  WorkspaceExecResult,
  WorkspaceMeta,
} from './types';

export interface LocalWorkspaceBackendOptions {
  /** Thư mục gốc chứa mọi workspace (`<root>/<id>/...`). */
  rootDir: string;
  /** BotBoxManager dùng chung (mặc định tự tạo, root `<rootDir>/boxes`). */
  boxManager?: BotBoxManager;
  /** Env allow-list thêm cho mọi workspace local. */
  envAllowlist?: string[];
  /** Nơi ghi cảnh báo (mặc định im lặng). */
  logger?: { warn(message: string): void };
}

/** boxId của BotBoxManager cho một workspace id (ký tự an toàn cho tên thư mục). */
export function boxIdForWorkspace(workspaceId: string): string {
  return `ws-${workspaceId}`;
}

export class LocalWorkspaceBackend implements WorkspaceBackend {
  readonly kind: WorkspaceBackendKind = 'local';
  readonly isolation: IsolationInfo;
  readonly available = true;
  readonly rootDir: string;
  private readonly boxManager: BotBoxManager;
  private readonly envAllowlist: string[];
  private readonly warn: (message: string) => void;

  constructor(options: LocalWorkspaceBackendOptions) {
    this.rootDir = options.rootDir;
    this.boxManager =
      options.boxManager ?? new BotBoxManager({ rootDir: options.rootDir });
    this.envAllowlist = options.envAllowlist ?? [];
    this.warn = options.logger ? (m) => options.logger?.warn(m) : () => undefined;
    this.isolation = detectIsolation();
  }

  /**
   * Thư mục làm việc của workspace — chính là workspace/ của box.
   * Tính từ `boxManager.rootDir` (box nằm ở
   * `<boxRoot>/boxes/<botId>/workspace`) để không lệch với box thật.
   */
  filesDir(workspaceId: string): string {
    return path.join(this.boxManager.rootDir, BOXES_REL_DIR, boxIdForWorkspace(workspaceId), 'workspace');
  }

  prepare(meta: WorkspaceMeta): void {
    const boxId = boxIdForWorkspace(meta.id);
    // Box đã tồn tại thì giữ nguyên (idempotent theo BotBoxManager);
    // giới hạn per-run lấy từ quota mỗi lần exec (xem exec bên dưới).
    this.boxManager.createBox(boxId, {
      envAllowlist: this.envAllowlist,
      limits: {
        timeoutMs: meta.quota.timeoutMs,
        // Box đo cap ghi trên TỔNG dung lượng workspace (xem box.ts),
        // nên cap per-run = quota đĩa của workspace.
        maxWriteBytes: meta.quota.diskBytes,
        maxOutputChars: meta.quota.maxOutputChars,
        maxFiles: 10_000,
        cpuSeconds:
          meta.quota.maxWallMs > 0
            ? Math.max(1, Math.ceil((meta.quota.timeoutMs / 1000) * meta.quota.cpuCores))
            : undefined,
        maxMemoryBytes: meta.quota.ramBytes,
        maxProcesses: meta.quota.maxProcesses === 0 ? undefined : meta.quota.maxProcesses,
      },
    });
    fs.mkdirSync(meta.dir, { recursive: true });
  }

  async exec(
    meta: WorkspaceMeta,
    command: string,
    args: string[],
    opts: WorkspaceExecOptions,
  ): Promise<WorkspaceExecResult> {
    const boxId = boxIdForWorkspace(meta.id);
    const startedAt = Date.now();
    const result = await this.boxManager.runInBox(boxId, command, args, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : { timeoutMs: meta.quota.timeoutMs }),
      ...(opts.maxWriteBytes !== undefined
        ? { maxWriteBytes: opts.maxWriteBytes }
        : { maxWriteBytes: meta.quota.diskBytes }),
      ...(opts.maxOutputChars !== undefined
        ? { maxOutputChars: opts.maxOutputChars }
        : { maxOutputChars: meta.quota.maxOutputChars }),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      ...(opts.envValues !== undefined ? { envValues: opts.envValues } : {}),
    });
    const filesDir = this.filesDir(meta.id);
    return {
      workspaceId: meta.id,
      command,
      args: [...args],
      isolation: result.isolation,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      writeCapExceeded: result.writeCapExceeded,
      quotaDenied: false,
      workspaceBytes: fs.existsSync(filesDir) ? dirSizeBytes(filesDir) : result.workspaceBytes,
      durationMs: Date.now() - startedAt,
    };
  }

  destroy(meta: WorkspaceMeta): boolean {
    const boxId = boxIdForWorkspace(meta.id);
    return this.boxManager.destroyBox(boxId);
  }

  /** Đo dung lượng + số file thật của workspace (phục vụ quota/status). */
  measure(workspaceId: string): { diskBytes: number; fileCount: number } {
    const dir = this.filesDir(workspaceId);
    if (!fs.existsSync(dir)) return { diskBytes: 0, fileCount: 0 };
    return { diskBytes: dirSizeBytes(dir), fileCount: dirFileCount(dir) };
  }
}
