/**
 * Workspace abstraction v3 (v1.03, Đội T4).
 *
 * Ý tưởng (học từ OpenHands V1 SDK — Workspace package, chỉ học ý
 * tưởng, không copy code): agent code không bao giờ chạm host trực
 * tiếp; mọi thao tác file/shell đi qua một interface `Workspace`
 * duy nhất, và factory chọn backend local hay container theo config.
 * Đổi backend không đổi code agent.
 *
 * Ba khái niệm tách riêng:
 * - `WorkspaceBackend`: nơi thực thi thật (local = BotBoxManager,
 *   container = docker/podman, xem local.ts / container.ts).
 * - `Workspace`: một workspace đang mở — handle mà agent cầm
 *   (exec/read/write/list/snapshot, xem workspace.ts).
 * - `WorkspaceManager`: vòng đời workspace (create/get/list/destroy)
 *   + quota tổng + snapshot store (xem workspace.ts).
 *
 * NGUYÊN TẮC TRUNG THỰC (kế thừa compute/types.ts + sandbox/types.ts):
 * - Không bao giờ báo cách ly cao hơn thực tế: backend container mà
 *   không có docker/podman thì trạng thái là `degraded` + lý do rõ,
 *   không bịa là đã chạy trong container.
 * - Số liệu "đang dùng" chỉ ghi khi đo được thật (dirSizeBytes);
 *   số đã cấp ghi riêng là "đã cấp".
 * - Quota không bao giờ cấp vượt ngân sách host: hết ngân sách thì
 *   create bị từ chối kèm lý do (xem quota.ts).
 */

import type { IsolationInfo } from '../sandbox/types';

/** Backend thực thi của một workspace. */
export type WorkspaceBackendKind = 'local' | 'container';

/** Trạng thái vòng đời của một workspace. */
export type WorkspaceStatus = 'active' | 'degraded' | 'stopped' | 'destroyed';

/**
 * Quota tài nguyên của một workspace. Mọi field đều optional khi
 * người gọi tạo — `resolveWorkspaceQuota` điền mặc định (xem quota.ts).
 * `0` = không giới hạn cho field đó, trừ cpuCores (0 = không cấp CPU,
 * workspace không chạy được — resolve sẽ nâng lên mức sàn).
 */
export interface WorkspaceQuota {
  /** Số core CPU tối đa (mặc định 1; sàn 0.25). */
  cpuCores?: number;
  /** RAM tối đa, bytes (mặc định 1 GiB). */
  ramBytes?: number;
  /** Đĩa tối đa cho workspace, bytes (mặc định 2 GiB). */
  diskBytes?: number;
  /** Số process tối đa cùng lúc (mặc định 64; 0 = không giới hạn). */
  maxProcesses?: number;
  /** Tổng byte ghi tối đa trong cửa sổ quota (mặc định 1 GiB; 0 = không giới hạn). */
  maxWriteBytes?: number;
  /** Tổng thời gian chạy tối đa trong cửa sổ quota, ms (mặc định 1 giờ; 0 = không giới hạn). */
  maxWallMs?: number;
  /** Timeout một lần chạy, ms (mặc định 120_000). */
  timeoutMs?: number;
  /** Số ký tự output tối đa giữ lại một lần chạy (mặc định 200_000). */
  maxOutputChars?: number;
}

/** Quota đã resolve đầy đủ (mọi field đều có mặt). */
export interface ResolvedWorkspaceQuota {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  maxProcesses: number;
  maxWriteBytes: number;
  maxWallMs: number;
  timeoutMs: number;
  maxOutputChars: number;
}

/** Ngân sách host còn lại cho workspace mới (tính từ MachineProfile, xem quota.ts). */
export interface WorkspaceHostBudget {
  /** Số core CPU còn cấp được (đã chừa headroom cho host). */
  cpuCores: number;
  /** RAM còn cấp được, bytes (đã chừa headroom). */
  ramBytes: number;
  /** Đĩa còn cấp được, bytes (đã chừa reserve). */
  diskBytes: number;
}

/** Mức sử dụng đã đo được thật của một workspace. */
export interface WorkspaceUsage {
  /** Dung lượng thư mục workspace đo được thật, bytes. */
  diskBytes: number;
  /** Số file trong workspace (đo thật). */
  fileCount: number;
  /** Số lần exec đã chạy trong cửa sổ quota hiện tại. */
  runs: number;
  /** Tổng byte đã ghi trong cửa sổ quota hiện tại. */
  bytesWritten: number;
  /** Tổng thời gian chạy trong cửa sổ quota hiện tại, ms. */
  wallMs: number;
  /** Đầu cửa sổ quota hiện tại (ISO string). */
  windowStart: string;
}

/** Metadata bền của một workspace (ghi vào `workspace.json`, không chứa secret). */
export interface WorkspaceMeta {
  id: string;
  /** Tên hiển thị (mặc định = id). */
  name: string;
  /** Bot sở hữu workspace này (rỗng = workspace dùng chung). */
  botId: string;
  backend: WorkspaceBackendKind;
  /** Backend được yêu cầu lúc tạo (khác `backend` khi container fallback về local — xem container.ts). */
  requestedBackend?: WorkspaceBackendKind;
  /** Thư mục gốc của workspace trên host (`<root>/<id>/`). */
  dir: string;
  /** Thư mục làm việc (file của agent) — `<dir>/files/`. */
  filesDir: string;
  quota: ResolvedWorkspaceQuota;
  usage: WorkspaceUsage;
  /** Sandbox profile áp cho exec ('strict' | 'standard' | 'permissive'). */
  profile: string;
  status: WorkspaceStatus;
  /** Lý do degraded (chỉ có khi status = 'degraded'). */
  degradedReason?: string;
  /** Mức cách ly THẬT của lần chạy gần nhất (undefined = chưa chạy lần nào). */
  lastIsolation?: IsolationInfo;
  createdAt: string;
  updatedAt: string;
}

/** Tuỳ chọn khi tạo workspace. */
export interface CreateWorkspaceOptions {
  /** Id workspace (chỉ chữ/số/`.`/`-`/`_`; trống = sinh `ws-<8 hex>`). */
  id?: string;
  /** Tên hiển thị (mặc định = id). */
  name?: string;
  /** Bot sở hữu (mặc định ''). */
  botId?: string;
  /** Backend — 'local' mặc định; 'container' cần docker/podman (không có thì degraded + fallback local, xem container.ts). */
  backend?: WorkspaceBackendKind;
  /** Quota (mặc định DEFAULT_WORKSPACE_QUOTA). */
  quota?: WorkspaceQuota;
  /** Sandbox profile áp cho exec (mặc định 'standard'; xem sandbox/profiles.ts). */
  profile?: string;
  /** Env allow-list thêm cho exec (ngoài biến mặc định an toàn). */
  envAllowlist?: string[];
}

/** Tuỳ chọn một lần chạy lệnh trong workspace. */
export interface WorkspaceExecOptions {
  /** Ghi đè timeout lần chạy này (ms). */
  timeoutMs?: number;
  /** Ghi đè cap ghi lần chạy này (bytes). */
  maxWriteBytes?: number;
  /** Ghi đè cap output lần chạy này (ký tự). */
  maxOutputChars?: number;
  /** stdin đưa vào tiến trình. */
  stdin?: string;
  /** Giá trị env thêm (tên phải nằm trong allow-list của workspace). */
  envValues?: Record<string, string>;
}

/** Kết quả một lần chạy lệnh trong workspace. */
export interface WorkspaceExecResult {
  workspaceId: string;
  command: string;
  args: string[];
  /** Mức cách ly THẬT của lần chạy này — không bao giờ nói quá. */
  isolation: IsolationInfo;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True khi bị kill vì vượt cap ghi của workspace. */
  writeCapExceeded: boolean;
  /** True khi bị từ chối trước khi chạy vì vượt quota (runs/wall/write). */
  quotaDenied: boolean;
  /** Dung lượng workspace đo được sau khi chạy (bytes). */
  workspaceBytes: number;
  durationMs: number;
}

/** Một entry trong thư mục workspace (list). */
export interface WorkspaceEntry {
  name: string;
  /** Đường dẫn tương đối trong workspace (dùng `/`). */
  relPath: string;
  kind: 'file' | 'dir';
  sizeBytes: number;
  modifiedAt: string;
}

/** Backend interface — mọi backend đều nói cùng một tiếng. */
export interface WorkspaceBackend {
  readonly kind: WorkspaceBackendKind;
  /** Mức cách ly mà backend này THẬT SỰ đạt được (kiểm tra lúc tạo). */
  readonly isolation: IsolationInfo;
  /** True khi backend chạy được thật trên máy này (docker có mặt, bwrap có mặt...). */
  readonly available: boolean;
  /** Lý do không khả dụng (chỉ có khi available = false). */
  readonly unavailableReason?: string;
  /** Thư mục làm việc của workspace id này (file của agent). */
  filesDir(workspaceId: string): string;
  /** Tạo thư mục workspace (idempotent). */
  prepare(meta: WorkspaceMeta): void;
  /** Chạy một lệnh trong workspace. */
  exec(
    meta: WorkspaceMeta,
    command: string,
    args: string[],
    opts: WorkspaceExecOptions,
  ): Promise<WorkspaceExecResult>;
  /** Xoá toàn bộ thư mục workspace (được gọi sau khi manager đã ghi log). */
  destroy(meta: WorkspaceMeta): boolean;
}

/** Metadata của một snapshot workspace (ghi vào `snapshot.json`, không chứa secret). */
export interface WorkspaceSnapshotMeta {
  id: string;
  workspaceId: string;
  /** Tên snapshot (mặc định = id). */
  name: string;
  backend: WorkspaceBackendKind;
  /** Quota của workspace lúc chụp. */
  quota: ResolvedWorkspaceQuota;
  /** Số file đã chụp. */
  fileCount: number;
  /** Tổng byte đã chụp. */
  totalBytes: number;
  /** sha256 của manifest (toàn bộ file đã chụp) — restore kiểm tra lại. */
  manifestSha256: string;
  createdAt: string;
}

/** Một file trong snapshot manifest. */
export interface WorkspaceSnapshotManifestEntry {
  /** Đường dẫn tương đối trong workspace (dùng `/`). */
  relPath: string;
  sizeBytes: number;
  sha256: string;
}

/** View tổng hợp cho UI/log: workspace + quota + usage + snapshot. */
export interface WorkspaceStatusView {
  id: string;
  name: string;
  botId: string;
  backend: WorkspaceBackendKind;
  status: WorkspaceStatus;
  degradedReason?: string;
  /** Sandbox profile áp cho exec. */
  profile: string;
  isolation: IsolationInfo | null;
  quota: ResolvedWorkspaceQuota;
  usage: WorkspaceUsage;
  /** Số snapshot đang giữ. */
  snapshotCount: number;
  createdAt: string;
  updatedAt: string;
}
