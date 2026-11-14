/**
 * Workspace quota v3 (v1.03, Đội T4).
 *
 * Kế thừa compute/planner.ts (kế thừa, không phá): ngân sách host
 * tính bằng cùng công thức headroom của planner — chừa cho host
 * `max(reserveCpuCores, 25% tổng core)` CPU, `max(reserveRamBytes,
 * 25% tổng RAM)` trên RAM TRỐNG (không quá nửa RAM trống), và
 * `reserveDiskBytes` trên ổ hệ thống. Workspace không bao giờ được
 * cấp vượt ngân sách này: hết ngân sách thì create bị từ chối kèm
 * lý do rõ ràng.
 *
 * Hai lớp kiểm tra tách riêng:
 * - `WorkspaceQuotaLedger` (cấp phát): tổng quota đã cấp của mọi
 *   workspace không vượt ngân sách host. Pure — không I/O.
 * - `WorkspaceUsageWindow` (cửa sổ sử dụng): bytes ghi / wall ms /
 *   số run trong một cửa sổ (mặc định 1 ngày) của một workspace.
 *   Pure — manager lưu window vào workspace.json.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';

import { resolvePlannerPolicy, GB } from '../compute/planner';
import type { MachineProfile, PlannerPolicy } from '../compute/types';
import type {
  ResolvedWorkspaceQuota,
  WorkspaceHostBudget,
  WorkspaceQuota,
  WorkspaceUsage,
} from './types';

export const MB = 1024 * 1024;

/** Quota mặc định cho một workspace mới (tương đương mức 'container' của planner). */
export const DEFAULT_WORKSPACE_QUOTA: ResolvedWorkspaceQuota = {
  cpuCores: 1,
  ramBytes: 1 * GB,
  diskBytes: 2 * GB,
  maxProcesses: 64,
  maxWriteBytes: 1 * GB,
  maxWallMs: 60 * 60 * 1000,
  timeoutMs: 120_000,
  maxOutputChars: 200_000,
};

/** Mức sàn — yêu cầu thấp hơn vẫn lấy mức này (workspace phải chạy được). */
export const WORKSPACE_QUOTA_FLOOR: ResolvedWorkspaceQuota = {
  cpuCores: 0.25,
  ramBytes: 256 * MB,
  diskBytes: 256 * MB,
  maxProcesses: 8,
  maxWriteBytes: 0,
  maxWallMs: 0,
  timeoutMs: 10_000,
  maxOutputChars: 10_000,
};

/** Cửa sổ quota mặc định: 1 ngày (ms). */
export const DEFAULT_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Ngân sách host còn cấp được, tính từ MachineProfile đã probe +
 * policy của planner. Cùng công thức headroom với `planComputers`
 * (xem compute/planner.ts) — đổi policy ở một chỗ thì cả hai cùng đổi.
 */
export function hostBudgetFromProfile(
  profile: MachineProfile,
  policy: PlannerPolicy = {},
): WorkspaceHostBudget {
  const p = resolvePlannerPolicy(policy);
  const totalCores = Math.max(1, profile.cpu.logicalCores);
  const reserveCores = Math.min(
    Math.max(totalCores - 1, 0),
    Math.max(p.reserveCpuCores, Math.ceil(totalCores * 0.25)),
  );
  const cpuCores = Math.max(0, totalCores - reserveCores);
  const reserveRam = Math.min(
    Math.floor(profile.memory.freeBytes * 0.5),
    Math.max(p.reserveRamBytes, Math.floor(profile.memory.totalBytes * p.reserveRamRatio)),
  );
  const ramBytes = Math.max(0, profile.memory.freeBytes - reserveRam);
  const systemDisk = profile.disks.find((d) => d.mount === '/') ?? profile.disks[0];
  const diskBytes = Math.max(0, (systemDisk?.freeBytes ?? 0) - p.reserveDiskBytes);
  return { cpuCores, ramBytes, diskBytes };
}

/**
 * Ngân sách host đồng bộ (không cần probe đầy đủ): CPU/RAM từ
 * node:os, đĩa trống từ fs.statfsSync('/'). Dùng khi caller không
 * truyền hostBudget (vd tool tự tạo manager) — cùng công thức
 * headroom với `hostBudgetFromProfile`.
 */
export function defaultHostBudget(): WorkspaceHostBudget {
  const p = resolvePlannerPolicy({});
  const totalCores = Math.max(1, os.cpus().length);
  const reserveCores = Math.min(
    Math.max(totalCores - 1, 0),
    Math.max(p.reserveCpuCores, Math.ceil(totalCores * 0.25)),
  );
  const cpuCores = Math.max(0, totalCores - reserveCores);
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const reserveRam = Math.min(
    Math.floor(freeRam * 0.5),
    Math.max(p.reserveRamBytes, Math.floor(totalRam * p.reserveRamRatio)),
  );
  const ramBytes = Math.max(0, freeRam - reserveRam);
  let diskBytes = 0;
  try {
    const stats = fs.statfsSync('/');
    diskBytes = Math.max(0, stats.bavail * stats.bsize - p.reserveDiskBytes);
  } catch {
    diskBytes = 0;
  }
  return { cpuCores, ramBytes, diskBytes };
}

/** Resolve quota người gọi đưa thành quota đầy đủ: mặc định + sàn + kẹp theo ngân sách host. */
export function resolveWorkspaceQuota(
  quota: WorkspaceQuota = {},
  hostBudget?: WorkspaceHostBudget,
): ResolvedWorkspaceQuota {
  const merged: ResolvedWorkspaceQuota = { ...DEFAULT_WORKSPACE_QUOTA, ...quota };
  // Áp mức sàn (trừ các field 0 = không giới hạn: maxWriteBytes/maxWallMs giữ 0).
  const out: ResolvedWorkspaceQuota = {
    cpuCores: Math.max(WORKSPACE_QUOTA_FLOOR.cpuCores, merged.cpuCores),
    ramBytes: Math.max(WORKSPACE_QUOTA_FLOOR.ramBytes, merged.ramBytes),
    diskBytes: Math.max(WORKSPACE_QUOTA_FLOOR.diskBytes, merged.diskBytes),
    maxProcesses: merged.maxProcesses === 0 ? 0 : Math.max(WORKSPACE_QUOTA_FLOOR.maxProcesses, merged.maxProcesses),
    maxWriteBytes: Math.max(0, merged.maxWriteBytes),
    maxWallMs: Math.max(0, merged.maxWallMs),
    timeoutMs: Math.max(WORKSPACE_QUOTA_FLOOR.timeoutMs, merged.timeoutMs),
    maxOutputChars: Math.max(WORKSPACE_QUOTA_FLOOR.maxOutputChars, merged.maxOutputChars),
  };
  if (hostBudget) {
    // Kẹp theo ngân sách host — nhưng không kẹp xuống dưới sàn:
    // ngân sách nhỏ hơn sàn thì create sẽ bị ledger từ chối sau.
    out.cpuCores = Math.min(out.cpuCores, Math.max(hostBudget.cpuCores, WORKSPACE_QUOTA_FLOOR.cpuCores));
    out.ramBytes = Math.min(out.ramBytes, Math.max(hostBudget.ramBytes, WORKSPACE_QUOTA_FLOOR.ramBytes));
    out.diskBytes = Math.min(out.diskBytes, Math.max(hostBudget.diskBytes, WORKSPACE_QUOTA_FLOOR.diskBytes));
  }
  return out;
}

/** Validate quota đã resolve (trả về danh sách lỗi; rỗng = hợp lệ). */
export function validateWorkspaceQuota(quota: ResolvedWorkspaceQuota): string[] {
  const problems: string[] = [];
  if (!(quota.cpuCores > 0)) problems.push('cpuCores must be positive');
  if (!(quota.ramBytes > 0)) problems.push('ramBytes must be positive');
  if (!(quota.diskBytes > 0)) problems.push('diskBytes must be positive');
  if (quota.maxProcesses < 0) problems.push('maxProcesses must not be negative');
  if (quota.maxWriteBytes < 0) problems.push('maxWriteBytes must not be negative');
  if (quota.maxWallMs < 0) problems.push('maxWallMs must not be negative');
  if (!(quota.timeoutMs > 0)) problems.push('timeoutMs must be positive');
  if (!(quota.maxOutputChars > 0)) problems.push('maxOutputChars must be positive');
  return problems;
}

/**
 * Ledger cấp phát — tổng quota đã cấp của mọi workspace không vượt
 * ngân sách host. Pure, không I/O: manager đọc quota các workspace
 * từ đĩa rồi nạp vào ledger; test dùng trực tiếp với số liệu giả.
 */
export class WorkspaceQuotaLedger {
  private readonly budget: WorkspaceHostBudget;
  private allocatedCpu = 0;
  private allocatedRam = 0;
  private allocatedDisk = 0;
  private readonly entries = new Map<string, ResolvedWorkspaceQuota>();

  constructor(budget: WorkspaceHostBudget) {
    this.budget = { ...budget };
  }

  get hostBudget(): WorkspaceHostBudget {
    return { ...this.budget };
  }

  get allocated(): { cpuCores: number; ramBytes: number; diskBytes: number; workspaces: number } {
    return {
      cpuCores: this.allocatedCpu,
      ramBytes: this.allocatedRam,
      diskBytes: this.allocatedDisk,
      workspaces: this.entries.size,
    };
  }

  get remaining(): WorkspaceHostBudget {
    return {
      cpuCores: Math.max(0, this.budget.cpuCores - this.allocatedCpu),
      ramBytes: Math.max(0, this.budget.ramBytes - this.allocatedRam),
      diskBytes: Math.max(0, this.budget.diskBytes - this.allocatedDisk),
    };
  }

  /** Workspace này có vừa ngân sách còn lại không (trả lý do khi không vừa). */
  check(quota: ResolvedWorkspaceQuota): { allowed: boolean; reason?: string } {
    const remaining = this.remaining;
    if (quota.cpuCores > remaining.cpuCores) {
      return { allowed: false, reason: `not enough CPU budget: needs ${quota.cpuCores} cores, ${remaining.cpuCores} left` };
    }
    if (quota.ramBytes > remaining.ramBytes) {
      return { allowed: false, reason: `not enough RAM budget: needs ${quota.ramBytes} bytes, ${remaining.ramBytes} left` };
    }
    if (quota.diskBytes > remaining.diskBytes) {
      return { allowed: false, reason: `not enough disk budget: needs ${quota.diskBytes} bytes, ${remaining.diskBytes} left` };
    }
    return { allowed: true };
  }

  /** Cấp quota cho workspace (ném lỗi khi không vừa ngân sách). */
  allocate(id: string, quota: ResolvedWorkspaceQuota): void {
    const check = this.check(quota);
    if (!check.allowed) throw new Error(`workspace quota denied for "${id}": ${check.reason}`);
    this.release(id);
    this.entries.set(id, { ...quota });
    this.allocatedCpu += quota.cpuCores;
    this.allocatedRam += quota.ramBytes;
    this.allocatedDisk += quota.diskBytes;
  }

  /** Giải phóng quota của workspace (idempotent). */
  release(id: string): void {
    const prev = this.entries.get(id);
    if (!prev) return;
    this.entries.delete(id);
    this.allocatedCpu = Math.max(0, this.allocatedCpu - prev.cpuCores);
    this.allocatedRam = Math.max(0, this.allocatedRam - prev.ramBytes);
    this.allocatedDisk = Math.max(0, this.allocatedDisk - prev.diskBytes);
  }
}

/** Cửa sổ sử dụng mới (chưa dùng gì). */
export function freshWorkspaceUsage(): WorkspaceUsage {
  return {
    diskBytes: 0,
    fileCount: 0,
    runs: 0,
    bytesWritten: 0,
    wallMs: 0,
    windowStart: new Date().toISOString(),
  };
}

/**
 * Cửa sổ sử dụng — bytes ghi / wall ms / số run của một workspace.
 * Pure: manager giữ window trong workspace.json và gọi `check` trước
 * mỗi lần exec, `record` sau mỗi lần exec.
 */
export class WorkspaceUsageWindow {
  private usage: WorkspaceUsage;
  private readonly quota: ResolvedWorkspaceQuota;
  private readonly windowMs: number;

  constructor(quota: ResolvedWorkspaceQuota, usage?: WorkspaceUsage, windowMs: number = DEFAULT_QUOTA_WINDOW_MS) {
    this.quota = { ...quota };
    this.windowMs = windowMs;
    this.usage = usage ? { ...usage } : freshWorkspaceUsage();
    this.rolloverIfExpired();
  }

  get current(): WorkspaceUsage {
    this.rolloverIfExpired();
    return { ...this.usage };
  }

  /** Đặt lại số đo đĩa (đo thật từ fs — gọi sau mỗi lần exec). */
  setMeasured(diskBytes: number, fileCount: number): void {
    this.usage.diskBytes = diskBytes;
    this.usage.fileCount = fileCount;
  }

  /** Kiểm tra một lần chạy có được phép bắt đầu không (quota cửa sổ). */
  checkRun(): { allowed: boolean; reason?: string } {
    this.rolloverIfExpired();
    if (this.quota.maxWallMs > 0 && this.usage.wallMs >= this.quota.maxWallMs) {
      return { allowed: false, reason: `wall-time quota exceeded (${this.usage.wallMs}/${this.quota.maxWallMs} ms)` };
    }
    if (this.quota.maxWriteBytes > 0 && this.usage.bytesWritten >= this.quota.maxWriteBytes) {
      return { allowed: false, reason: `write quota exceeded (${this.usage.bytesWritten}/${this.quota.maxWriteBytes} bytes)` };
    }
    if (this.quota.diskBytes > 0 && this.usage.diskBytes >= this.quota.diskBytes) {
      return { allowed: false, reason: `disk quota exceeded (${this.usage.diskBytes}/${this.quota.diskBytes} bytes)` };
    }
    return { allowed: true };
  }

  /** Kiểm tra một lần ghi `bytes` có vừa quota không. */
  checkWrite(bytes: number): { allowed: boolean; reason?: string } {
    this.rolloverIfExpired();
    if (this.quota.maxWriteBytes > 0 && this.usage.bytesWritten + bytes > this.quota.maxWriteBytes) {
      return { allowed: false, reason: `write quota exceeded (${this.usage.bytesWritten + bytes}/${this.quota.maxWriteBytes} bytes)` };
    }
    if (this.quota.diskBytes > 0 && this.usage.diskBytes + bytes > this.quota.diskBytes) {
      return { allowed: false, reason: `disk quota exceeded (${this.usage.diskBytes + bytes}/${this.quota.diskBytes} bytes)` };
    }
    return { allowed: true };
  }

  /** Ghi nhận một lần chạy đã xong. */
  recordRun(bytesWritten: number, wallMs: number): void {
    this.rolloverIfExpired();
    this.usage.runs += 1;
    this.usage.bytesWritten += bytesWritten;
    this.usage.wallMs += wallMs;
  }

  /** Reset cửa sổ (host gọi, vd mỗi ngày). */
  reset(): void {
    const measured = { diskBytes: this.usage.diskBytes, fileCount: this.usage.fileCount };
    this.usage = freshWorkspaceUsage();
    this.usage.diskBytes = measured.diskBytes;
    this.usage.fileCount = measured.fileCount;
  }

  private rolloverIfExpired(): void {
    const start = Date.parse(this.usage.windowStart);
    if (Number.isNaN(start)) {
      this.usage.windowStart = new Date().toISOString();
      return;
    }
    if (Date.now() - start >= this.windowMs) this.reset();
  }
}
