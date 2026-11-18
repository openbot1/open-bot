/**
 * Sandbox v3 — per-tier syscall allowlist (v1.35, Team T2).
 *
 * Where v2 keeps one engine with a deny list, v3 flips the model:
 * every tier gets an explicit ALLOW set, and anything not on it is
 * denied fail-closed. The three modes line up with the v2 tiers:
 *
 *  - `strict`     (tier 1 bwrap, untrusted/hostile code) — pure
 *    computation only: base syscalls + read-only file access. No
 *    network, no process spawn, no IPC, no writes outside the
 *    workspace (writes are gated separately by the policy file
 *    rules; the syscall layer only decides the call itself).
 *  - `standard`   (tier 2 syscall-policy, normal agent code) —
 *    base + filesystem + network + a small process set (fork/exec
 *    of the allow-listed command only; the runner enforces the
 *    command list). IPC stays off.
 *  - `permissive` (tier 1 bwrap, trusted first-party code) —
 *    everything standard allows, plus IPC and the wider process
 *    set. Still never the dangerous set.
 *
 * The dangerous set is identical in spirit to v2's: syscalls that
 * can escape the sandbox or take over the host (ptrace, mount,
 * bpf, module loading, reboot, keyring, namespace juggling). They
 * are denied even when a policy lists them in `allow` — the engine
 * is the backstop, the policy validator is only the first check.
 *
 * This is the decision layer only. It writes no kernel code, no
 * seccomp-bpf, and never claims a process is isolated just because
 * this engine said "allow" — the real boundary is the tier that
 * runs the code (bwrap / microVM). The lists use the Linux x86_64
 * syscall names, the same names the v2 engine uses.
 */

import type {
  SandboxV3SyscallCheck,
  SandboxV3SyscallGroup,
  SandboxV3SyscallMode,
  SandboxV3SyscallVerdict,
} from './types';

/** Syscalls that can never touch anything outside the process. */
export const SANDBOX_V3_BASE_SYSCALLS: readonly string[] = [
  'read',
  'write',
  'pread64',
  'pwrite64',
  'readv',
  'writev',
  'preadv',
  'pwritev',
  'close',
  'fstat',
  'newfstatat',
  'lseek',
  'llseek',
  'brk',
  'mmap',
  'munmap',
  'mprotect',
  'madvise',
  'mremap',
  'msync',
  'mlock',
  'munlock',
  'mlockall',
  'munlockall',
  'mincore',
  'rt_sigaction',
  'rt_sigprocmask',
  'rt_sigreturn',
  'rt_sigpending',
  'rt_sigtimedwait',
  'rt_sigqueueinfo',
  'rt_tgsigqueueinfo',
  'sigaltstack',
  'ioctl',
  'poll',
  'ppoll',
  'select',
  'pselect6',
  'epoll_create',
  'epoll_create1',
  'epoll_ctl',
  'epoll_wait',
  'epoll_pwait',
  'eventfd',
  'eventfd2',
  'signalfd',
  'signalfd4',
  'timerfd_create',
  'timerfd_settime',
  'timerfd_gettime',
  'getpid',
  'getppid',
  'getuid',
  'getgid',
  'geteuid',
  'getegid',
  'gettid',
  'getsid',
  'getpgid',
  'getgroups',
  'getresuid',
  'getresgid',
  'getrlimit',
  'getrusage',
  'gettimeofday',
  'clock_gettime',
  'clock_getres',
  'clock_nanosleep',
  'nanosleep',
  'time',
  'times',
  'uname',
  'sysinfo',
  'getcpu',
  'getrandom',
  'arch_prctl',
  'set_tid_address',
  'set_robust_list',
  'get_robust_list',
  'futex',
  'futex_waitv',
  'sched_yield',
  'sched_getaffinity',
  'sched_getparam',
  'sched_getscheduler',
  'sched_get_priority_max',
  'sched_get_priority_min',
  'sched_rr_get_interval',
  'exit',
  'exit_group',
];

/** Read-only filesystem syscalls (open for read, stat, list). */
export const SANDBOX_V3_FS_READ_SYSCALLS: readonly string[] = [
  'open',
  'openat',
  'openat2',
  'creat',
  'access',
  'faccessat',
  'faccessat2',
  'stat',
  'lstat',
  'statx',
  'statfs',
  'fstatfs',
  'getdents',
  'getdents64',
  'readlink',
  'readlinkat',
  'getcwd',
  'chdir',
  'fchdir',
  'dup',
  'dup2',
  'dup3',
  'fcntl',
  'fsync',
  'fdatasync',
  'sync_file_range',
  'readahead',
  'sendfile',
  'copy_file_range',
  'splice',
  'tee',
  'vmsplice',
  'ftruncate',
  'truncate',
  'fallocate',
  'fadvise64',
  'flock',
  'inotify_init',
  'inotify_init1',
  'inotify_add_watch',
  'inotify_rm_watch',
  'fanotify_mark',
];

/** Mutating filesystem syscalls (create / write / rename / delete). */
export const SANDBOX_V3_FS_WRITE_SYSCALLS: readonly string[] = [
  'mkdir',
  'mkdirat',
  'rmdir',
  'unlink',
  'unlinkat',
  'rename',
  'renameat',
  'renameat2',
  'link',
  'linkat',
  'symlink',
  'symlinkat',
  'mknod',
  'mknodat',
  'chmod',
  'fchmod',
  'fchmodat',
  'chown',
  'fchown',
  'fchownat',
  'lchown',
  'utime',
  'utimes',
  'utimensat',
  'futimesat',
  'setxattr',
  'lsetxattr',
  'fsetxattr',
  'getxattr',
  'lgetxattr',
  'fgetxattr',
  'listxattr',
  'llistxattr',
  'flistxattr',
  'removexattr',
  'lremovexattr',
  'fremovexattr',
];

/** Network syscalls. The egress gate decides the destination; this */
export const SANDBOX_V3_NET_SYSCALLS: readonly string[] = [
  'socket',
  'socketpair',
  'bind',
  'listen',
  'accept',
  'accept4',
  'connect',
  'getsockname',
  'getpeername',
  'setsockopt',
  'getsockopt',
  'sendto',
  'recvfrom',
  'sendmsg',
  'recvmsg',
  'sendmmsg',
  'recvmmsg',
  'shutdown',
  'gethostname',
  'getdomainname',
];

/** Process syscalls. `execve` is only meaningful when the runner's */
/** command allowlist also permits the binary; the engine alone never */
/** authorises a command.                                        */
export const SANDBOX_V3_PROCESS_SYSCALLS: readonly string[] = [
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
  'pipe',
  'pipe2',
  'prctl',
  'capget',
  'capset',
  'setuid',
  'setgid',
  'seteuid',
  'setegid',
  'setreuid',
  'setregid',
  'setresuid',
  'setresgid',
  'setfsuid',
  'setfsgid',
  'setpgid',
  'setsid',
  'setgroups',
  'personality',
  'getitimer',
  'setitimer',
  'alarm',
  'pause',
  'restart_syscall',
  'ptrace',
];

/** IPC syscalls (shared memory, message queues, semaphores). Only */
/** permissive mode allows them; standard and strict deny.         */
export const SANDBOX_V3_IPC_SYSCALLS: readonly string[] = [
  'shmget',
  'shmat',
  'shmdt',
  'shmctl',
  'msgget',
  'msgsnd',
  'msgrcv',
  'msgctl',
  'semget',
  'semop',
  'semtimedop',
  'semctl',
  'mq_open',
  'mq_unlink',
  'mq_timedsend',
  'mq_timedreceive',
  'mq_notify',
  'mq_getsetattr',
  'memfd_create',
  'memfd_secret',
  'pidfd_open',
  'pidfd_send_signal',
  'pidfd_getfd',
  'process_madvise',
  'process_mrelease',
  'process_vm_readv',
  'process_vm_writev',
];

/**
 * Syscalls that are NEVER allowed, in any mode, under any policy.
 * Listing one in a policy `allow` list is still denied here, and
 * the policy validator flags the policy as contradictory.
 *
 * NOTE: `ptrace` also appears in PROCESS_SYSCALLS above for
 * grouping completeness — the dangerous check runs FIRST, so
 * `ptrace` is always denied. Keep it in both lists on purpose:
 * removing it from PROCESS would hide it from group reports.
 */
export const SANDBOX_V3_DANGEROUS_SYSCALLS: readonly string[] = [
  'ptrace',
  'mount',
  'umount2',
  'pivot_root',
  'chroot',
  'bpf',
  'perf_event_open',
  'init_module',
  'finit_module',
  'delete_module',
  'create_module',
  'query_module',
  'reboot',
  'kexec_load',
  'kexec_file_load',
  'keyctl',
  'add_key',
  'request_key',
  'swapon',
  'swapoff',
  'unshare',
  'setns',
  'acct',
  'quotactl',
  'nfsservctl',
  'lookup_dcookie',
  'io_setup',
  'io_destroy',
  'io_submit',
  'io_cancel',
  'io_getevents',
  'io_pgetevents',
  'io_uring_setup',
  'io_uring_enter',
  'io_uring_register',
  'open_by_handle_at',
  'name_to_handle_at',
  'fanotify_init',
  'move_pages',
  'migrate_pages',
  'kcmp',
  'userfaultfd',
  'landlock_create_ruleset',
  'landlock_add_rule',
  'landlock_restrict_self',
  'seccomp',
  'modify_ldt',
  'ustat',
  'vhangup',
];

/** Every syscall this module knows about, by group. */
export const SANDBOX_V3_SYSCALL_GROUPS: Record<
  Exclude<SandboxV3SyscallGroup, 'unknown'>,
  readonly string[]
> = {
  base: SANDBOX_V3_BASE_SYSCALLS,
  fs: [...SANDBOX_V3_FS_READ_SYSCALLS, ...SANDBOX_V3_FS_WRITE_SYSCALLS],
  net: SANDBOX_V3_NET_SYSCALLS,
  process: SANDBOX_V3_PROCESS_SYSCALLS,
  ipc: SANDBOX_V3_IPC_SYSCALLS,
  dangerous: SANDBOX_V3_DANGEROUS_SYSCALLS,
};

/**
 * Per-mode allow sets. `strict` = base + read-only fs. `standard` =
 * strict + writable fs + net + a small process set (no execve: the
 * runner spawns the command itself, the guest never execs directly).
 * `permissive` = standard + execve + full process + IPC.
 */
export const SANDBOX_V3_MODE_ALLOWLISTS: Record<SandboxV3SyscallMode, readonly string[]> = {
  strict: [...SANDBOX_V3_BASE_SYSCALLS, ...SANDBOX_V3_FS_READ_SYSCALLS],
  standard: [
    ...SANDBOX_V3_BASE_SYSCALLS,
    ...SANDBOX_V3_FS_READ_SYSCALLS,
    ...SANDBOX_V3_FS_WRITE_SYSCALLS,
    ...SANDBOX_V3_NET_SYSCALLS,
    ...SANDBOX_V3_PROCESS_SYSCALLS.filter((name) => name !== 'execve' && name !== 'execveat'),
  ],
  permissive: [
    ...SANDBOX_V3_BASE_SYSCALLS,
    ...SANDBOX_V3_FS_READ_SYSCALLS,
    ...SANDBOX_V3_FS_WRITE_SYSCALLS,
    ...SANDBOX_V3_NET_SYSCALLS,
    ...SANDBOX_V3_PROCESS_SYSCALLS,
    ...SANDBOX_V3_IPC_SYSCALLS,
  ],
};

/** Default mode for a trust level. Hostile code always gets strict. */
export function defaultSyscallModeForTrust(
  trust: 'trusted' | 'standard' | 'untrusted' | 'hostile',
): SandboxV3SyscallMode {
  switch (trust) {
    case 'trusted':
      return 'permissive';
    case 'standard':
      return 'standard';
    case 'untrusted':
    case 'hostile':
      return 'strict';
    default:
      return 'standard';
  }
}

/** Which group a syscall belongs to. Dangerous wins over every group. */
export function syscallV3Group(name: string): SandboxV3SyscallGroup {
  const lower = name.trim().toLowerCase();
  if (SANDBOX_V3_DANGEROUS_SYSCALLS.includes(lower)) return 'dangerous';
  if (SANDBOX_V3_BASE_SYSCALLS.includes(lower)) return 'base';
  if (
    SANDBOX_V3_FS_READ_SYSCALLS.includes(lower) ||
    SANDBOX_V3_FS_WRITE_SYSCALLS.includes(lower)
  ) {
    return 'fs';
  }
  if (SANDBOX_V3_NET_SYSCALLS.includes(lower)) return 'net';
  if (SANDBOX_V3_PROCESS_SYSCALLS.includes(lower)) return 'process';
  if (SANDBOX_V3_IPC_SYSCALLS.includes(lower)) return 'ipc';
  return 'unknown';
}

/** Extra per-mode overrides a policy may add on top of the mode set. */
export interface SyscallAllowlistOptions {
  /** Mode that selects the base allow set. Default `standard`. */
  mode?: SandboxV3SyscallMode;
  /** Extra syscalls to allow (dangerous ones are still denied). */
  extraAllow?: string[];
  /** Extra syscalls to deny (wins over the mode allow set). */
  extraDeny?: string[];
  /**
   * When true, denied syscalls are only logged, not blocked.
   * Only honoured for non-dangerous, non-unknown syscalls; the
   * dangerous set is always a hard deny. Default false.
   */
  logOnlyDeny?: boolean;
  /** Optional sink for blocked / logged events (seq assigned by caller). */
  onBlocked?: (event: {
    syscall: string;
    group: SandboxV3SyscallGroup;
    verdict: SandboxV3SyscallVerdict;
    reason: string;
  }) => void;
}

/**
 * Per-tier syscall allowlist engine. Stateless per check apart from
 * the blocked-events log, which the runner merges into the session.
 */
export class SyscallAllowlist {
  private readonly mode: SandboxV3SyscallMode;
  private readonly allow: Set<string>;
  private readonly deny: Set<string>;
  private readonly logOnlyDeny: boolean;
  private readonly onBlocked?: SyscallAllowlistOptions['onBlocked'];
  private readonly blocked: Array<{
    syscall: string;
    group: SandboxV3SyscallGroup;
    verdict: SandboxV3SyscallVerdict;
    reason: string;
  }> = [];

  constructor(options: SyscallAllowlistOptions = {}) {
    this.mode = options.mode ?? 'standard';
    this.logOnlyDeny = options.logOnlyDeny ?? false;
    this.onBlocked = options.onBlocked;
    this.allow = new Set(
      SANDBOX_V3_MODE_ALLOWLISTS[this.mode]
        .map((name) => name.toLowerCase())
        // `ptrace` rides along in PROCESS_SYSCALLS for grouping, but
        // it is dangerous: never land it on an allow set.
        .filter((name) => !SANDBOX_V3_DANGEROUS_SYSCALLS.includes(name)),
    );
    for (const name of options.extraAllow ?? []) {
      const lower = name.trim().toLowerCase();
      if (lower.length > 0 && !SANDBOX_V3_DANGEROUS_SYSCALLS.includes(lower)) {
        this.allow.add(lower);
      }
    }
    this.deny = new Set(
      (options.extraDeny ?? []).map((name) => name.trim().toLowerCase()),
    );
  }

  /** The mode this engine was built for. */
  getMode(): SandboxV3SyscallMode {
    return this.mode;
  }

  /** Number of syscalls on the effective allow set. */
  allowCount(): number {
    return this.allow.size;
  }

  /** True when the syscall is on the effective allow set. */
  isAllowed(name: string): boolean {
    return this.checkSyscall(name).verdict === 'allow';
  }

  /**
   * Check one syscall. Order matters, and every branch is
   * fail-closed:
   *  1. dangerous → hard deny, always recorded.
   *  2. extra deny list → deny (or log-only when configured).
   *  3. allow set → allow.
   *  4. anything else → deny, fail-closed (unknown syscall).
   */
  checkSyscall(name: string): SandboxV3SyscallCheck {
    const lower = name.trim().toLowerCase();
    const group = syscallV3Group(lower);
    if (group === 'dangerous') {
      const check: SandboxV3SyscallCheck = {
        verdict: 'deny',
        group,
        reason: `Syscall "${lower}" is always denied (dangerous: can escape the sandbox)`,
        hardDenied: true,
        recorded: true,
      };
      this.record(check, lower);
      return check;
    }
    if (this.deny.has(lower)) {
      const verdict: SandboxV3SyscallVerdict = this.logOnlyDeny ? 'log-only' : 'deny';
      const check: SandboxV3SyscallCheck = {
        verdict,
        group,
        reason: `Syscall "${lower}" is on the policy deny list`,
        hardDenied: false,
        recorded: true,
      };
      this.record(check, lower);
      return check;
    }
    if (this.allow.has(lower)) {
      return {
        verdict: 'allow',
        group,
        reason: `Syscall "${lower}" is allowed in ${this.mode} mode`,
        hardDenied: false,
        recorded: false,
      };
    }
    const check: SandboxV3SyscallCheck = {
      verdict: 'deny',
      group,
      reason:
        group === 'unknown'
          ? `Unknown syscall "${lower}" — denied fail-closed`
          : `Syscall "${lower}" is not on the ${this.mode} allowlist`,
      hardDenied: false,
      recorded: true,
    };
    this.record(check, lower);
    return check;
  }

  /** Check a batch; returns one result per name, in order. */
  checkBatch(names: string[]): SandboxV3SyscallCheck[] {
    return names.map((name) => this.checkSyscall(name));
  }

  /** True when every name in the batch is allowed. */
  allowsAll(names: string[]): boolean {
    return names.every((name) => this.checkSyscall(name).verdict === 'allow');
  }

  /** Blocked / logged events recorded by this engine, in order. */
  blockedEvents(): Array<{
    syscall: string;
    group: SandboxV3SyscallGroup;
    verdict: SandboxV3SyscallVerdict;
    reason: string;
  }> {
    return [...this.blocked];
  }

  /** How many checks were denied (hard + policy). */
  deniedCount(): number {
    return this.blocked.filter((event) => event.verdict === 'deny').length;
  }

  /** Summarise the mode: groups allowed, counts, dangerous size. */
  describe(): {
    mode: SandboxV3SyscallMode;
    allowCount: number;
    denyCount: number;
    groups: SandboxV3SyscallGroup[];
    dangerousCount: number;
  } {
    const groups = new Set<SandboxV3SyscallGroup>();
    for (const name of this.allow) groups.add(syscallV3Group(name));
    return {
      mode: this.mode,
      allowCount: this.allow.size,
      denyCount: this.deny.size,
      groups: [...groups],
      dangerousCount: SANDBOX_V3_DANGEROUS_SYSCALLS.length,
    };
  }

  private record(
    check: SandboxV3SyscallCheck,
    syscall: string,
  ): void {
    const event = {
      syscall,
      group: check.group,
      verdict: check.verdict,
      reason: check.reason,
    };
    this.blocked.push(event);
    this.onBlocked?.(event);
  }
}

/**
 * Validate a mode name. Returns the mode, or undefined when the
 * value is not one of the three modes (caller decides the error).
 */
export function parseSyscallMode(value: unknown): SandboxV3SyscallMode | undefined {
  if (value === 'strict' || value === 'standard' || value === 'permissive') return value;
  return undefined;
}

/**
 * Diff two modes: which syscalls the target mode adds / removes
 * relative to the base mode. Useful for policy review UI.
 */
export function diffSyscallModes(
  from: SandboxV3SyscallMode,
  to: SandboxV3SyscallMode,
): { added: string[]; removed: string[] } {
  const fromSet = new Set(SANDBOX_V3_MODE_ALLOWLISTS[from]);
  const toSet = new Set(SANDBOX_V3_MODE_ALLOWLISTS[to]);
  const added = [...toSet].filter((name) => !fromSet.has(name)).sort();
  const removed = [...fromSet].filter((name) => !toSet.has(name)).sort();
  return { added, removed };
}
