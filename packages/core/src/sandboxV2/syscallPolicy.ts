/**
 * Sandbox v2 — syscall policy engine, gVisor-style (v1.34, Đội T2).
 *
 * Idea (from the v1.34 survey §3): gVisor puts a userspace kernel
 * between the guest and the host kernel and intercepts every syscall
 * BEFORE it touches the host. This engine is the same idea simulated
 * in-process: every syscall / file / network / exec attempt is checked
 * against the policy first, and a deny is recorded + blocked before
 * any host call happens.
 *
 * This is NOT a kernel, NOT seccomp-bpf, NOT a real sandbox boundary
 * on its own — it is the policy decision layer. The real boundary is
 * the tier that runs the code (bwrap for tier 1, the microVM for
 * tier 3); this engine decides, logs and (for the runner) enforces
 * the decision in the host-side wrapper. Never claim a process is
 * isolated just because this engine said "allow".
 *
 * Syscall groups:
 *  - `base` — always allowed: pure computation, memory, thread and
 *    time syscalls that cannot touch the host outside the process.
 *  - `fs` / `net` / `process` — gated by the policy file/network/
 *    command rules.
 *  - `dangerous` — never allowed under any policy: ptrace, mount,
 *    reboot, kexec, bpf, keyctl, init_module, swap, and friends.
 *    A policy that lists one in `allow` is still denied (and the
 *    policy itself is flagged by the validator in policy.ts only
 *    when it contradicts itself — here the engine is the backstop).
 */

import type { SandboxV2Policy } from './policy';
import { isDeniedSandboxV2Path, isPathUnderPrefixes } from './policy';
import type { SandboxV2BlockedEvent, SandboxV2SyscallVerdict, SandboxV2Tier } from './types';

/** Syscalls that can never touch anything outside the process. Always allowed. */
export const SANDBOX_V2_BASE_SYSCALLS: readonly string[] = [
  'read',
  'write',
  'openat',
  'close',
  'fstat',
  'newfstatat',
  'lseek',
  'pread64',
  'pwrite64',
  'brk',
  'mmap',
  'munmap',
  'mprotect',
  'madvise',
  'rt_sigaction',
  'rt_sigprocmask',
  'rt_sigreturn',
  'ioctl',
  'poll',
  'ppoll',
  'select',
  'pselect6',
  'getpid',
  'getppid',
  'getuid',
  'getgid',
  'geteuid',
  'getegid',
  'gettid',
  'getcwd',
  'gettimeofday',
  'clock_gettime',
  'clock_getres',
  'nanosleep',
  'sched_yield',
  'sched_getaffinity',
  'futex',
  'set_tid_address',
  'set_robust_list',
  'rseq',
  'prlimit64',
  'getrandom',
  'uname',
  'arch_prctl',
  'exit',
  'exit_group',
];

/** Filesystem syscalls — gated by the file rules. */
export const SANDBOX_V2_FS_SYSCALLS: readonly string[] = [
  'open',
  'openat2',
  'creat',
  'unlink',
  'unlinkat',
  'mkdir',
  'mkdirat',
  'rmdir',
  'rename',
  'renameat',
  'renameat2',
  'link',
  'linkat',
  'symlink',
  'symlinkat',
  'readlink',
  'readlinkat',
  'stat',
  'lstat',
  'statx',
  'access',
  'faccessat',
  'chmod',
  'fchmod',
  'fchmodat',
  'chown',
  'fchown',
  'fchownat',
  'truncate',
  'ftruncate',
  'fsync',
  'fdatasync',
  'syncfs',
  'readdir',
  'getdents64',
  'mount',
  'umount2',
];

/** Network syscalls — gated by the network rules. */
export const SANDBOX_V2_NET_SYSCALLS: readonly string[] = [
  'socket',
  'connect',
  'bind',
  'listen',
  'accept',
  'accept4',
  'sendto',
  'recvfrom',
  'sendmsg',
  'recvmsg',
  'sendmmsg',
  'recvmmsg',
  'setsockopt',
  'getsockopt',
  'getsockname',
  'getpeername',
  'shutdown',
  'socketpair',
];

/** Process-control syscalls — gated by the command rules. */
export const SANDBOX_V2_PROCESS_SYSCALLS: readonly string[] = [
  'clone',
  'clone3',
  'fork',
  'vfork',
  'execve',
  'execveat',
  'wait4',
  'waitid',
  'kill',
  'tkill',
  'tgkill',
  'getrusage',
  'times',
];

/**
 * Dangerous syscalls — NEVER allowed under any policy. Escaping the
 * sandbox, loading kernel code, tracing other processes, rebooting,
 * or raw device / BPF access. The engine denies these even when a
 * policy lists them in `allow` (defense in depth).
 */
export const SANDBOX_V2_DANGEROUS_SYSCALLS: readonly string[] = [
  'ptrace',
  'process_vm_readv',
  'process_vm_writev',
  'mount',
  'umount2',
  'pivot_root',
  'chroot',
  'reboot',
  'kexec_load',
  'kexec_file_load',
  'init_module',
  'finit_module',
  'delete_module',
  'bpf',
  'perf_event_open',
  'keyctl',
  'add_key',
  'request_key',
  'swapon',
  'swapoff',
  'ioperm',
  'iopl',
  'io_uring_setup',
  'io_uring_enter',
  'io_uring_register',
  'lookup_dcookie',
  'acct',
  'nfsservctl',
  'quotactl',
  'setns',
  'unshare',
  'sethostname',
  'setdomainname',
  'sched_setaffinity',
  'mbind',
  'migrate_pages',
  'move_pages',
  'open_by_handle_at',
  'name_to_handle_at',
  'fanotify_init',
  'fanotify_mark',
  'inotify_init1',
  'modify_ldt',
  'syslog',
  'vhangup',
  'create_module',
  'query_module',
  'uselib',
  'personality',
];

/** Syscall → group, for reporting. */
export function syscallGroup(name: string): 'base' | 'fs' | 'net' | 'process' | 'dangerous' | 'unknown' {
  if ((SANDBOX_V2_DANGEROUS_SYSCALLS as readonly string[]).includes(name)) return 'dangerous';
  if ((SANDBOX_V2_BASE_SYSCALLS as readonly string[]).includes(name)) return 'base';
  if ((SANDBOX_V2_FS_SYSCALLS as readonly string[]).includes(name)) return 'fs';
  if ((SANDBOX_V2_NET_SYSCALLS as readonly string[]).includes(name)) return 'net';
  if ((SANDBOX_V2_PROCESS_SYSCALLS as readonly string[]).includes(name)) return 'process';
  return 'unknown';
}

/** One syscall check, with the reason attached. */
export interface SandboxV2SyscallCheck {
  syscall: string;
  verdict: SandboxV2SyscallVerdict;
  group: ReturnType<typeof syscallGroup>;
  reason: string;
  /** True when the deny came from the hard dangerous list (not the policy). */
  hardDenied: boolean;
}

/** One file / network / exec check. */
export interface SandboxV2AccessCheck {
  kind: 'file-read' | 'file-write' | 'network' | 'exec';
  target: string;
  allowed: boolean;
  reason: string;
}

/** Options for the policy engine. */
export interface SyscallPolicyEngineOptions {
  policy: SandboxV2Policy;
  /** Tier enforcing the check (recorded on blocked events). */
  tier: SandboxV2Tier;
  /** Called for every blocked (or log-only) event. */
  onBlocked?: (event: Omit<SandboxV2BlockedEvent, 'seq' | 'at'>) => void;
}

/**
 * The policy engine. Stateless apart from the blocked-event log:
 * `checkSyscall`, `checkFile`, `checkNetwork` and `checkExec` are
 * pure decisions against the policy; the runner calls them before
 * every host-side action and records the outcome.
 */
export class SyscallPolicyEngine {
  private readonly policy: SandboxV2Policy;
  private readonly tier: SandboxV2Tier;
  private readonly onBlocked?: SyscallPolicyEngineOptions['onBlocked'];
  private readonly blocked: SandboxV2BlockedEvent[] = [];
  private seq = 0;

  constructor(options: SyscallPolicyEngineOptions) {
    this.policy = options.policy;
    this.tier = options.tier;
    this.onBlocked = options.onBlocked;
  }

  /** All blocked (or log-only) events recorded so far, in order. */
  blockedEvents(): SandboxV2BlockedEvent[] {
    return [...this.blocked];
  }

  /** Counts of blocked events by kind. */
  blockedCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.blocked) {
      counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    }
    return counts;
  }

  private record(
    kind: SandboxV2BlockedEvent['kind'],
    target: string,
    reason: string,
    logOnly: boolean,
  ): void {
    this.seq += 1;
    const event: SandboxV2BlockedEvent = {
      seq: this.seq,
      at: new Date().toISOString(),
      kind,
      target,
      reason,
      tier: this.tier,
      logOnly,
    };
    this.blocked.push(event);
    this.onBlocked?.({ kind, target, reason, tier: this.tier, logOnly });
  }

  /**
   * Check one syscall. Order (fail-closed):
   *  1. dangerous list → deny, always.
   *  2. policy `deny` list → deny (or log-only when the policy says so).
   *  3. base set → allow.
   *  4. fs/net/process groups → allow only when the matching policy
   *     section permits that kind of access at all.
   *  5. unknown syscall → deny (fail-closed: we do not know what it does).
   */
  checkSyscall(syscall: string): SandboxV2SyscallCheck {
    const name = syscall.trim();
    const group = syscallGroup(name);
    if (group === 'dangerous') {
      const check: SandboxV2SyscallCheck = {
        syscall: name,
        verdict: 'deny',
        group,
        reason: `syscall "${name}" is on the always-denied list (sandbox escape / kernel access)`,
        hardDenied: true,
      };
      this.record('syscall', name, check.reason, false);
      return check;
    }
    if (this.policy.syscalls.deny.includes(name)) {
      const logOnly = this.policy.syscalls.logOnlyDeny;
      const check: SandboxV2SyscallCheck = {
        syscall: name,
        verdict: logOnly ? 'log-only' : 'deny',
        group,
        reason: `syscall "${name}" is denied by policy ${this.policy.id} v${this.policy.version}`,
        hardDenied: false,
      };
      this.record('syscall', name, check.reason, logOnly);
      return check;
    }
    if (group === 'base') {
      return { syscall: name, verdict: 'allow', group, reason: 'base syscall (no host access)', hardDenied: false };
    }
    if (group === 'fs') {
      // Filesystem syscalls are allowed through only when the policy
      // grants at least one file prefix; the per-path check happens in
      // checkFile() with the real path. A policy with no file access
      // at all denies the whole group here.
      if (this.policy.files.readPrefixes.length === 0 && this.policy.files.writePrefixes.length === 0) {
        const reason = `filesystem syscall "${name}" denied: policy ${this.policy.id} grants no file access`;
        this.record('syscall', name, reason, false);
        return { syscall: name, verdict: 'deny', group, reason, hardDenied: false };
      }
      return { syscall: name, verdict: 'allow', group, reason: 'filesystem syscall, path checked separately', hardDenied: false };
    }
    if (group === 'net') {
      if (!this.policy.network.enabled) {
        const reason = `network syscall "${name}" denied: network is disabled by policy ${this.policy.id}`;
        this.record('syscall', name, reason, false);
        return { syscall: name, verdict: 'deny', group, reason, hardDenied: false };
      }
      return { syscall: name, verdict: 'allow', group, reason: 'network syscall, host checked separately', hardDenied: false };
    }
    if (group === 'process') {
      if (!this.policy.shellEnabled) {
        const reason = `process syscall "${name}" denied: shell is disabled by policy ${this.policy.id}`;
        this.record('syscall', name, reason, false);
        return { syscall: name, verdict: 'deny', group, reason, hardDenied: false };
      }
      return { syscall: name, verdict: 'allow', group, reason: 'process syscall, command checked separately', hardDenied: false };
    }
    // Unknown syscall: fail closed.
    const reason = `syscall "${name}" is unknown to the policy engine — denied (fail-closed)`;
    this.record('syscall', name, reason, false);
    return { syscall: name, verdict: 'deny', group, reason, hardDenied: false };
  }

  /** Check a file read/write against the file rules. Denied paths always win. */
  checkFile(kind: 'file-read' | 'file-write', targetPath: string): SandboxV2AccessCheck {
    const path = targetPath.trim();
    if (path === '') return { kind, target: targetPath, allowed: false, reason: 'empty path' };
    if (path.includes('..')) {
      const reason = `path "${path}" contains ".." — denied (directory traversal)`;
      this.record(kind, path, reason, false);
      return { kind, target: path, allowed: false, reason };
    }
    if (isDeniedSandboxV2Path(path)) {
      const reason = `path "${path}" hits a denied segment (credential / vault path)`;
      this.record(kind, path, reason, false);
      return { kind, target: path, allowed: false, reason };
    }
    const prefixes = kind === 'file-read' ? this.policy.files.readPrefixes : this.policy.files.writePrefixes;
    if (this.policy.files.denyPrefixes.length > 0 && isPathUnderPrefixes(path, this.policy.files.denyPrefixes)) {
      const reason = `path "${path}" is under a policy deny prefix`;
      this.record(kind, path, reason, false);
      return { kind, target: path, allowed: false, reason };
    }
    if (!isPathUnderPrefixes(path, prefixes)) {
      const reason = `path "${path}" is outside the ${kind === 'file-read' ? 'read' : 'write'} allow-list of policy ${this.policy.id}`;
      this.record(kind, path, reason, false);
      return { kind, target: path, allowed: false, reason };
    }
    return { kind, target: path, allowed: true, reason: 'path is inside the allow-list' };
  }

  /** Check a network egress (host + optional port) against the network rules. */
  checkNetwork(host: string, port = 443): SandboxV2AccessCheck {
    const target = `${host}:${port}`;
    if (!this.policy.network.enabled) {
      const reason = `network to ${target} denied: network is disabled by policy ${this.policy.id}`;
      this.record('network', target, reason, false);
      return { kind: 'network', target, allowed: false, reason };
    }
    const allowedPorts = this.policy.network.ports.length > 0 ? this.policy.network.ports : [443];
    if (!allowedPorts.includes(port)) {
      const reason = `network to ${target} denied: port ${port} is not in the allow-list (${allowedPorts.join(', ')})`;
      this.record('network', target, reason, false);
      return { kind: 'network', target, allowed: false, reason };
    }
    const exact = this.policy.network.hosts.includes(host);
    const suffix = this.policy.network.hostSuffixes.some((s) => host.endsWith(s));
    if (!exact && !suffix) {
      const reason = `network to ${host} denied: host is not in the allow-list of policy ${this.policy.id}`;
      this.record('network', target, reason, false);
      return { kind: 'network', target, allowed: false, reason };
    }
    return { kind: 'network', target, allowed: true, reason: 'host is allow-listed' };
  }

  /** Check a command name against the command allow-list + shell flag. */
  checkExec(command: string): SandboxV2AccessCheck {
    const name = command.trim().split(/\s+/)[0] ?? '';
    const base = name.split('/').pop() ?? name;
    if (!this.policy.shellEnabled) {
      const reason = `exec "${base}" denied: shell is disabled by policy ${this.policy.id}`;
      this.record('exec', base, reason, false);
      return { kind: 'exec', target: base, allowed: false, reason };
    }
    if (this.policy.commands.length > 0 && !this.policy.commands.includes(base)) {
      const reason = `exec "${base}" denied: command is not in the allow-list of policy ${this.policy.id}`;
      this.record('exec', base, reason, false);
      return { kind: 'exec', target: base, allowed: false, reason };
    }
    return { kind: 'exec', target: base, allowed: true, reason: 'command is allow-listed' };
  }

  /**
   * Render a seccomp-bpf-style filter description for the policy:
   * the allow-list the tier would load (for audit + for the run
   * report). This is a DESCRIPTION, not a compiled filter — the
   * runner enforces it in-process and the tier boundary enforces it
   * at the OS level where available.
   */
  describeFilter(): string {
    const lines: string[] = [];
    lines.push(`# sandbox v2 syscall filter — policy ${this.policy.id} v${this.policy.version}`);
    lines.push(`# tier: ${this.tier} | trust: ${this.policy.trust} | log-only deny: ${this.policy.syscalls.logOnlyDeny}`);
    lines.push(`ALLOW base (${SANDBOX_V2_BASE_SYSCALLS.length}): ${[...SANDBOX_V2_BASE_SYSCALLS].join(', ')}`);
    const extraAllow = this.policy.syscalls.allow.filter((s) => !SANDBOX_V2_BASE_SYSCALLS.includes(s));
    lines.push(`ALLOW policy-extra (${extraAllow.length}): ${extraAllow.join(', ') || '(none)'}`);
    lines.push(`DENY always (${SANDBOX_V2_DANGEROUS_SYSCALLS.length}): ${[...SANDBOX_V2_DANGEROUS_SYSCALLS].join(', ')}`);
    lines.push(`DENY policy (${this.policy.syscalls.deny.length}): ${this.policy.syscalls.deny.join(', ') || '(none)'}`);
    lines.push(`DENY unknown syscalls (fail-closed)`);
    lines.push(`FILES read: ${this.policy.files.readPrefixes.join(', ') || '(none)'}`);
    lines.push(`FILES write: ${this.policy.files.writePrefixes.join(', ') || '(none)'}`);
    lines.push(
      `NETWORK: ${this.policy.network.enabled ? `enabled, hosts ${this.policy.network.hosts.join(', ') || '(none)'}, suffixes ${this.policy.network.hostSuffixes.join(', ') || '(none)'}, ports ${(this.policy.network.ports.length > 0 ? this.policy.network.ports : [443]).join(', ')}` : 'disabled'}`,
    );
    return lines.join('\n');
  }

  /** Effective syscall allow-set for this policy (base + policy extras, minus denies + dangerous). */
  effectiveAllowSet(): string[] {
    const set = new Set<string>(SANDBOX_V2_BASE_SYSCALLS);
    for (const s of this.policy.syscalls.allow) set.add(s);
    for (const s of this.policy.syscalls.deny) set.delete(s);
    for (const s of SANDBOX_V2_DANGEROUS_SYSCALLS) set.delete(s);
    return [...set].sort();
  }
}
