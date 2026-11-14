/**
 * Sandbox exec hardening tiếp cho workspace v3 (v1.03, Đội T4).
 *
 * Kế thừa sandbox hiện có — mở rộng, không phá API cũ:
 * - Mọi check lệnh/file vẫn qua `SandboxEnforcer` + profile (xem
 *   sandbox/enforce.ts, profiles.ts). Guard này thêm 3 lớp mà
 *   enforcer chưa có: mẫu lệnh nguy hiểm, giới hạn exec đồng thời,
 *   và kiểm tra symlink khi ghi file (xem paths.ts).
 * - `WorkspaceExecGuard` là choke point của `Workspace.exec`: một
 *   lệnh chỉ chạy khi qua cả 3 lớp; từ chối thì fail-closed (ném
 *   `SandboxDeniedError`, ghi audit) — không bao giờ chạy lén.
 *
 * Mẫu nguy hiểm bị chặn là danh sách hẹp, rõ ràng (không chặn bừa
 * theo heuristic): xoá/format ổ đĩa, ghi trực tiếp device, fork
 * bomb, tắt máy, và `curl|sh` kiểu pipe-remote-code. Agent vẫn chạy
 * `rm` thường trong workspace, `curl` để tải file, `sh` script local.
 */

import { SandboxAuditLogger } from '../sandbox/audit';
import { SandboxDeniedError, SandboxEnforcer } from '../sandbox/enforce';
import type { SandboxProfile } from '../sandbox/profiles';
import { resolveWithinRoot } from './paths';

/** Mẫu lệnh nguy hiểm — khớp trên command line đã chuẩn hoá (lowercase, khoảng trắng gộp). */
export const WORKSPACE_DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\s)rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|\/\*|~|\$home)/, reason: 'recursive delete of / or $HOME' },
  { pattern: /(^|\s)(mkfs|fdisk|parted|dd)\b.*\bof=\/dev\//, reason: 'writing to a raw device' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'fork bomb' },
  { pattern: /(^|\s)(shutdown|reboot|halt|poweroff)\b/, reason: 'shutting down the host' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b/, reason: 'piping remote code into a shell' },
  { pattern: /(^|\s)chmod\s+(-r\s+)?777\s+\//, reason: 'chmod 777 on a system path' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'redirecting output to a raw disk device' },
  { pattern: /(^|\s)mount\s+/, reason: 'mounting filesystems' },
  { pattern: /(^|\s)(chown|chmod)\s+.*\s+\/(etc|usr|bin|sbin)\b/, reason: 'changing ownership/permissions of system dirs' },
];

/** True khi command line khớp mẫu nguy hiểm (trả kèm lý do). */
export function findDangerousCommand(command: string): { pattern: RegExp; reason: string } | undefined {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
  return WORKSPACE_DANGEROUS_COMMAND_PATTERNS.find((entry) => entry.pattern.test(normalized));
}

export interface WorkspaceExecGuardOptions {
  /** Profile sandbox áp cho exec (mặc định 'standard' — gọi setProfile để đổi). */
  profile: SandboxProfile;
  /** Bot sở hữu (ghi audit). */
  botId?: string;
  /** Số exec đồng thời tối đa trong một workspace (mặc định 4). */
  maxConcurrentExecs?: number;
  /** Audit logger (mặc định không ghi file — chỉ kiểm tra). */
  audit?: SandboxAuditLogger;
}

/**
 * Guard cho một workspace: enforcer + mẫu nguy hiểm + semaphore
 * exec đồng thời. Một guard dùng cho một workspace (giữ số exec
 * đang chạy của workspace đó).
 */
export class WorkspaceExecGuard {
  private readonly profile: SandboxProfile;
  private readonly enforcer: SandboxEnforcer;
  private readonly audit?: SandboxAuditLogger;
  private readonly maxConcurrent: number;
  private running = 0;

  constructor(options: WorkspaceExecGuardOptions) {
    this.profile = options.profile;
    this.enforcer = new SandboxEnforcer({
      profile: options.profile,
      ...(options.botId ? { botId: options.botId } : {}),
      ...(options.audit ? { audit: options.audit } : {}),
    });
    this.audit = options.audit;
    this.maxConcurrent = Math.max(1, options.maxConcurrentExecs ?? 4);
  }

  get profileName(): string {
    return this.enforcer.profileName;
  }

  get runningExecs(): number {
    return this.running;
  }

  /** Kiểm tra lệnh trước khi chạy (ném SandboxDeniedError khi bị chặn). */
  checkExec(command: string): void {
    const dangerous = findDangerousCommand(command);
    if (dangerous) {
      this.deny('exec', command, `dangerous command pattern: ${dangerous.reason}`);
    }
    if (this.running >= this.maxConcurrent) {
      this.deny('exec', command, `too many concurrent execs (${this.running}/${this.maxConcurrent})`);
    }
    // Lệnh đi theo ngữ nghĩa denylist của shell_exec (xem
    // packages/tools/src/sandbox.ts — assertCommandAllowed), KHÔNG
    // theo allowlist commands của profile: allowlist là whitelist
    // hẹp cho bot bị khoá (chỉ node/npm/git/...) và sẽ chặn cả lệnh
    // thường như `echo` hay `/bin/sh`. Profile vẫn gate exec qua
    // shellEnabled (strict = không shell) và qua limits/quota.
    if (!this.profile.shellEnabled) {
      this.deny('exec', command, 'shell is disabled by the sandbox profile');
    }
  }

  /** Đánh dấu một exec bắt đầu (gọi sau checkExec, trước khi spawn). Trả hàm giải phóng. */
  acquireExecSlot(): () => void {
    this.running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running = Math.max(0, this.running - 1);
    };
  }

  /** Kiểm tra ghi file: enforcer (allowlist + always-denied) + symlink escape. */
  checkWrite(workspaceRoot: string, relPath: string): void {
    // resolveWithinRoot ném WorkspacePathError khi escape/symlink.
    resolveWithinRoot(workspaceRoot, relPath);
    this.enforcer.checkWrite(relPath);
  }

  /** Kiểm tra đọc file: enforcer + symlink escape. */
  checkRead(workspaceRoot: string, relPath: string): void {
    resolveWithinRoot(workspaceRoot, relPath);
    this.enforcer.checkRead(relPath);
  }

  private deny(action: 'exec' | 'write' | 'read' | 'network', target: string, reason: string): never {
    this.audit?.append({
      at: new Date().toISOString(),
      action,
      target,
      allowed: false,
      reason,
      profile: this.enforcer.profileName,
    });
    throw new SandboxDeniedError(action, target, reason);
  }
}
