/**
 * Sandbox v2 — tiered isolation model (v1.34, Đội T2).
 *
 * Shared types for the whole `sandboxV2/` subsystem. Ideas only from
 * the v1.34 survey (§3: Firecracker microVM / gVisor syscall policy /
 * Kata-style tiers, token broker, kill switch, per-run report) — no
 * code, text or asset copied from any repo, xAI or Cursor.
 *
 * Three tiers, weakest → strongest:
 *  - tier 1 `bwrap`  — bubblewrap box, reuses sandbox v1 (`sandbox/`).
 *  - tier 2 `syscall-policy` — gVisor-style syscall filter: every
 *    syscall / file / network access is checked against the policy
 *    BEFORE it touches the host kernel (simulated by a policy engine
 *    in-process; this codebase writes no kernel code).
 *  - tier 3 `microvm` — Firecracker-style microVM descriptor (own
 *    KVM kernel + rootfs + snapshot). This subsystem only builds and
 *    validates the descriptor and produces a dry-run feasibility
 *    report; it never boots a real VM.
 *
 * Fail-closed everywhere: an unknown tier, an unvalidated policy, an
 * expired token or a tripped kill switch denies the run, never allows
 * it silently.
 */

/** Isolation tier. `1 | 2 | 3` numeric form is used in policies. */
export type SandboxV2Tier = 'bwrap' | 'syscall-policy' | 'microvm';

/** Numeric tier level (1 = bwrap, 2 = syscall policy, 3 = microVM). */
export type SandboxV2TierLevel = 1 | 2 | 3;

/** How much the code about to run is trusted. Drives tier choice. */
export type SandboxV2TrustLevel =
  | 'trusted' // First-party code, reviewed, signed or from our own repo.
  | 'standard' // Normal agent-generated code (default).
  | 'untrusted' // Code from the network, user paste, or a prompt-injection risk.
  | 'hostile'; // Known-malicious sample / red-team fixture. Never tier 1.

/** Why a run ended. */
export type SandboxV2EndReason =
  | 'completed'
  | 'failed'
  | 'timed-out'
  | 'lifetime-cap'
  | 'kill-switch'
  | 'policy-denied'
  | 'token-expired'
  | 'token-revoked'
  | 'host-unavailable'
  | 'dry-run';

/** Source that tripped the kill switch. */
export type SandboxV2KillSource = 'ui' | 'policy' | 'timeout' | 'manual' | 'lifetime-cap';

/** What a syscall check can return. */
export type SandboxV2SyscallVerdict = 'allow' | 'deny' | 'log-only';

/** What a file/network check can return. */
export type SandboxV2AccessVerdict = 'allow' | 'deny';

/** Host capabilities the tier selector probes (injectable for tests). */
export interface SandboxV2HostCapabilities {
  /** Operating system. MicroVM needs Linux + KVM; bwrap needs Linux. */
  platform: NodeJS.Platform;
  /** `bwrap` binary present on PATH. */
  bwrapAvailable: boolean;
  /** `unshare` binary present on PATH (weak fallback, tier 1 only). */
  unshareAvailable: boolean;
  /** `/dev/kvm` readable (KVM acceleration for tier 3). */
  kvmAvailable: boolean;
  /** Number of logical CPUs (feeds microVM sizing + feasibility). */
  cpuCount: number;
  /** Total RAM in bytes (feeds microVM sizing + feasibility). */
  totalMemoryBytes: number;
  /** Firecracker binary present (only matters for a real boot). */
  firecrackerAvailable: boolean;
}

/** One blocked (or logged) access inside a run. */
export interface SandboxV2BlockedEvent {
  /** Monotonic sequence number inside the run (starts at 1). */
  seq: number;
  /** ISO timestamp when the attempt happened. */
  at: string;
  /** What was attempted: 'syscall' | 'file-read' | 'file-write' | 'network' | 'exec'. */
  kind: 'syscall' | 'file-read' | 'file-write' | 'network' | 'exec';
  /** The syscall name (e.g. 'ptrace'), path, host or command. */
  target: string;
  /** Why it was blocked (policy rule id or reason string). */
  reason: string;
  /** Tier that enforced the block. */
  tier: SandboxV2Tier;
  /** True when the event only logged (log-only verdict) and execution continued. */
  logOnly: boolean;
}

/** A credential issued by the token broker for one task. */
export interface SandboxV2Token {
  /** Opaque token id (never the secret itself in logs). */
  id: string;
  /** Task / run this token is bound to. */
  taskId: string;
  /** Downstream scopes granted (e.g. 'github:read', 'npm:fetch'). */
  scopes: string[];
  /** ISO timestamp when the token was issued. */
  issuedAt: string;
  /** ISO timestamp when the token expires (TTL enforced). */
  expiresAt: string;
  /** True after revoke() or expiry sweep. */
  revoked: boolean;
  /** ISO timestamp of revocation (undefined while live). */
  revokedAt?: string;
  /** Why it was revoked ('expired' | 'task-done' | 'manual' | 'kill-switch'). */
  revokeReason?: string;
}

/** Lifetime / resource caps for one run. */
export interface SandboxV2RunCaps {
  /** Max wall-clock lifetime of the run, ms (default 120_000). */
  maxLifetimeMs: number;
  /** Max CPU seconds (undefined = no extra cap beyond lifetime). */
  maxCpuSeconds?: number;
  /** Max bytes the run may write (undefined = no extra cap). */
  maxWriteBytes?: number;
  /** Max output chars retained (default 200_000). */
  maxOutputChars: number;
}

/** Resolved caps (every field present). */
export type SandboxV2ResolvedCaps = Required<Pick<SandboxV2RunCaps, 'maxLifetimeMs' | 'maxOutputChars'>> &
  Pick<SandboxV2RunCaps, 'maxCpuSeconds' | 'maxWriteBytes'>;

/** MicroVM descriptor (Firecracker-style). Spec only — never boots here. */
export interface SandboxV2MicroVmSpec {
  /** Kernel image path on the host (must exist for a real boot). */
  kernelPath: string;
  /** Root filesystem image path on the host. */
  rootfsPath: string;
  /** vCPU count (1–32). */
  vcpuCount: number;
  /** Guest RAM in MiB (128–32768). */
  memoryMiB: number;
  /** Kernel command line (default set when empty). */
  kernelCmdline: string;
  /** Boot from a snapshot instead of a cold boot (snapshot id). */
  snapshotId?: string;
  /** Network disabled by default; allow-listed hosts only when set. */
  networkHosts: string[];
  /** Extra virtio drives (host path → guest mount). */
  drives: Array<{ hostPath: string; guestPath: string; readOnly: boolean }>;
}

/** Result of a microVM dry-run feasibility check. */
export interface SandboxV2MicroVmFeasibility {
  /** True when a real boot COULD work on this host. */
  feasible: boolean;
  /** Estimated cold-boot time, ms (Firecracker-class ~125ms when KVM works). */
  estimatedBootMs: number;
  /** Estimated snapshot-resume time, ms (undefined when no snapshot). */
  estimatedResumeMs?: number;
  /** Blocking reasons when not feasible (e.g. 'no /dev/kvm on this host'). */
  blockers: string[];
  /** Non-blocking warnings (e.g. 'firecracker binary not installed'). */
  warnings: string[];
  /** Host facts the estimate used. */
  host: Pick<SandboxV2HostCapabilities, 'platform' | 'kvmAvailable' | 'cpuCount' | 'totalMemoryBytes' | 'firecrackerAvailable'>;
}

/** Decision of the tier selector. */
export interface SandboxV2TierDecision {
  /** Tier that will run the code. */
  tier: SandboxV2Tier;
  /** Numeric level (1–3). */
  level: SandboxV2TierLevel;
  /** Human-readable reason (shown in UI + run report). */
  reason: string;
  /** True when the requested tier was downgraded (host cannot do it). */
  downgraded: boolean;
  /** Tier that was requested before downgrade (undefined when none). */
  requestedTier?: SandboxV2Tier;
  /** Trust level the decision was based on. */
  trust: SandboxV2TrustLevel;
  /** Host facts the decision used. */
  host: Pick<SandboxV2HostCapabilities, 'platform' | 'bwrapAvailable' | 'kvmAvailable'>;
}

/** Per-run isolation report (built by runReport.ts, one per run). */
export interface SandboxV2RunReport {
  /** Run id (also the task id the token broker binds to). */
  runId: string;
  /** Bot / task label for display. */
  label: string;
  /** Tier that actually ran the code. */
  tier: SandboxV2Tier;
  /** Policy id + version that was applied. */
  policyId: string;
  policyVersion: number;
  /** Trust level of the code that ran. */
  trust: SandboxV2TrustLevel;
  /** ISO start / end timestamps. */
  startedAt: string;
  endedAt: string;
  /** Wall-clock lifetime, ms. */
  durationMs: number;
  /** How the run ended. */
  endReason: SandboxV2EndReason;
  /** Human-readable end detail (e.g. kill-switch source). */
  endDetail?: string;
  /** Syscall / file / network attempts that were blocked (or logged). */
  blocked: SandboxV2BlockedEvent[];
  /** Counts by blocked kind, for quick scanning. */
  blockedCounts: Record<string, number>;
  /** Tokens issued for this run (ids only — never secrets). */
  tokensIssued: string[];
  /** Tokens revoked by end of run, with reasons. */
  tokensRevoked: Array<{ id: string; reason: string }>;
  /** Whether the kill switch fired during this run, and its source. */
  killSwitchFired: boolean;
  killSwitchSource?: SandboxV2KillSource;
  /** Lifetime cap that applied (ms). */
  lifetimeCapMs: number;
  /** True when the cap was hit (run killed by lifetime, not by finishing). */
  lifetimeCapHit: boolean;
  /** Exit code of the command (null when killed / never started). */
  exitCode: number | null;
  /** Truncated stdout / stderr (cap applied). */
  stdout: string;
  stderr: string;
  /** True when the run really was isolated (never claim isolation falsely). */
  isolated: boolean;
  /** Isolation detail string (e.g. 'bwrap (user+pid ns)'). */
  isolationDetail: string;
  /** MicroVM feasibility snapshot when tier 3 was requested. */
  microvmFeasibility?: SandboxV2MicroVmFeasibility;
}

/** Options for starting a sandbox v2 run. */
export interface SandboxV2RunOptions {
  /** Run / task id (generated when omitted). */
  runId?: string;
  /** Display label. */
  label?: string;
  /** Trust level of the code (default 'standard'). */
  trust?: SandboxV2TrustLevel;
  /** Requested tier (undefined = auto-select from trust + host). */
  requestedTier?: SandboxV2Tier;
  /** Policy to apply (id or full object; default = builtin for trust). */
  policy?: string | import('./policy').SandboxV2Policy;
  /** Command + args to run inside the sandbox. */
  command: string;
  args?: string[];
  /** Working directory inside the sandbox (must be under the workspace root). */
  cwd?: string;
  /** Extra env vars (allow-listed names only; never whole process.env). */
  env?: Record<string, string>;
  /** Downstream scopes the run needs (token broker issues one token per scope set). */
  scopes?: string[];
  /** Token TTL in ms (default 15 minutes; capped by the policy). */
  tokenTtlMs?: number;
  /** Lifetime / resource caps (defaults applied when omitted). */
  caps?: Partial<SandboxV2RunCaps>;
  /** Host capabilities override (tests inject a fake host here). */
  hostCapabilities?: Partial<SandboxV2HostCapabilities>;
  /** Abort signal: tripping it is the same as the manual kill switch. */
  signal?: AbortSignal;
  /** Dry-run: validate + select tier + report, do not execute. */
  dryRun?: boolean;
}

/** Error thrown when a sandbox v2 policy denies an action. */
export class SandboxV2DeniedError extends Error {
  readonly code = 'SANDBOX_V2_DENIED';
  constructor(
    message: string,
    readonly kind: SandboxV2BlockedEvent['kind'],
    readonly target: string,
  ) {
    super(message);
    this.name = 'SandboxV2DeniedError';
  }
}

/** Error thrown when a token is missing, expired or revoked. */
export class SandboxV2TokenError extends Error {
  readonly code = 'SANDBOX_V2_TOKEN';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxV2TokenError';
  }
}

/** Error thrown when the kill switch fires mid-run. */
export class SandboxV2KilledError extends Error {
  readonly code = 'SANDBOX_V2_KILLED';
  constructor(
    message: string,
    readonly source: SandboxV2KillSource,
  ) {
    super(message);
    this.name = 'SandboxV2KilledError';
  }
}

/** Error thrown when a policy document fails validation. */
export class SandboxV2PolicyError extends Error {
  readonly code = 'SANDBOX_V2_POLICY';
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = 'SandboxV2PolicyError';
  }
}
