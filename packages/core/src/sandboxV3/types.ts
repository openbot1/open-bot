/**
 * Sandbox v3 — shared types (v1.35, Team T2).
 *
 * Deep sandbox, one layer above sandbox v2: v2 decides the isolation
 * tier and gates syscalls; v3 adds the runtime controls that make a
 * long-lived sandbox safe to keep around:
 *
 *  - per-tier syscall allowlist (`syscallAllowlist.ts`) — stricter
 *    than v2: each tier gets its own allow set, not just a deny list.
 *  - egress policy gate (`egressPolicy.ts`) — every outbound network
 *    request is checked against host / scheme / port rules and a
 *    per-run byte + request budget before it leaves.
 *  - lifetime cap + auto-stop (`lifetime.ts`) — a session has a hard
 *    deadline; when it passes the session stops itself, with a grace
 *    window for in-flight steps.
 *  - copy-on-write snapshots (`snapshot.ts`) — capture the session
 *    filesystem state as an overlay manifest and restore it later;
 *    the base image is never mutated.
 *  - pause / resume (`lifecycle.ts`) — a session can be frozen
 *    mid-run and resumed later; no step executes while paused.
 *  - PreToolUse / PostToolUse hooks (`hooks.ts`) — user-registered
 *    hooks inspect (and may block or rewrite) every tool call that
 *    runs inside the sandbox, before and after it executes.
 *
 * Ideas only from the Claude Agent SDK permission modes / hooks and
 * the OpenAI Agents SDK sandbox execution model — no code, text or
 * asset copied from any repo, xAI or Cursor.
 *
 * Fail-closed everywhere: an unknown syscall, an unlisted egress
 * host, an expired lifetime, a paused session or a hook that says
 * "deny" all stop the step, never let it through silently.
 */

import type { SandboxV2Tier, SandboxV2TrustLevel } from '../sandboxV2/types';

/** Re-exported so v3 callers never need to import v2 types directly. */
export type { SandboxV2Tier, SandboxV2TrustLevel };

/** Strictness of the v3 syscall allowlist. One per tier, by default. */
export type SandboxV3SyscallMode = 'strict' | 'standard' | 'permissive';

/** What a syscall check can return. `log-only` records but allows. */
export type SandboxV3SyscallVerdict = 'allow' | 'deny' | 'log-only';

/** Syscall groups, mirroring the v2 engine grouping. */
export type SandboxV3SyscallGroup =
  | 'base'
  | 'fs'
  | 'net'
  | 'process'
  | 'ipc'
  | 'dangerous'
  | 'unknown';

/** Egress decision. */
export type SandboxV3EgressVerdict = 'allow' | 'deny';

/** Why an egress request was denied (stable strings for reports). */
export type SandboxV3EgressDenyReason =
  | 'network-disabled'
  | 'host-not-allowed'
  | 'host-blocked'
  | 'scheme-not-allowed'
  | 'port-not-allowed'
  | 'request-budget-exceeded'
  | 'byte-budget-exceeded'
  | 'invalid-url';

/** Session lifecycle states. `paused` is a real freeze, not a flag. */
export type SandboxV3SessionState =
  | 'created'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'expired';

/** Why a session ended. */
export type SandboxV3EndReason =
  | 'completed'
  | 'failed'
  | 'lifetime-cap'
  | 'auto-stopped'
  | 'paused-timeout'
  | 'hook-denied'
  | 'policy-denied'
  | 'egress-denied'
  | 'syscall-denied'
  | 'killed'
  | 'error';

/** When a hook runs relative to the tool call it guards. */
export type SandboxV3HookTiming = 'pre' | 'post';

/** What a hook may decide. `modify` rewrites the call arguments. */
export type SandboxV3HookDecision = 'allow' | 'deny' | 'modify';

/** How a hook matches a tool call. */
export type SandboxV3HookMatcher = {
  /** Tool name glob, e.g. `sandbox_v3_*` or `*`. `*` matches all. */
  toolPattern?: string;
  /** Optional exact argument key that must be present. */
  argKey?: string;
};

/** One blocked (or logged) event inside a session. */
export interface SandboxV3BlockedEvent {
  /** Monotonic sequence number inside the session (starts at 1). */
  seq: number;
  /** Wall-clock time (ms since epoch) when the event was recorded. */
  atMs: number;
  /** Which subsystem blocked it. */
  source: 'syscall' | 'egress' | 'hook' | 'lifetime' | 'lifecycle' | 'policy';
  /** What was attempted, in human-readable form. */
  attempted: string;
  /** Why it was blocked. */
  reason: string;
  /** Tool call id, when the block happened inside a tool step. */
  toolCallId?: string;
}

/** A single egress request, as the gate sees it. */
export interface SandboxV3EgressRequest {
  /** Full URL the sandbox code wants to reach. */
  url: string;
  /** HTTP method (GET by default). Upper-cased by the gate. */
  method?: string;
  /** Expected response size in bytes (0 when unknown). */
  expectedBytes?: number;
}

/** The gate's answer for one egress request. */
export interface SandboxV3EgressCheck {
  verdict: SandboxV3EgressVerdict;
  /** Present when denied. */
  reason?: SandboxV3EgressDenyReason;
  /** Human-readable explanation, always present. */
  detail: string;
  /** Normalised host the check ran against ('' when the URL is invalid). */
  host: string;
  /** Scheme the check ran against ('' when the URL is invalid). */
  scheme: string;
  /** Port the check ran against (0 when the URL is invalid). */
  port: number;
  /** Requests already used in this session, after this check. */
  requestsUsed: number;
  /** Bytes already used in this session, after this check. */
  bytesUsed: number;
}

/** One syscall check result. */
export interface SandboxV3SyscallCheck {
  verdict: SandboxV3SyscallVerdict;
  group: SandboxV3SyscallGroup;
  /** Human-readable explanation, always present. */
  reason: string;
  /** True when the syscall is on the always-deny list (no override). */
  hardDenied: boolean;
  /** True when the check was recorded in the blocked-events log. */
  recorded: boolean;
}

/** A copy-on-write snapshot of a session's filesystem state. */
export interface SandboxV3Snapshot {
  /** Snapshot id (uuid). */
  id: string;
  /** Session it belongs to. */
  sessionId: string;
  /** When the snapshot was taken (ms since epoch). */
  createdAtMs: number;
  /** Human label, e.g. `before-install`. */
  label: string;
  /** Number of files captured in the overlay. */
  fileCount: number;
  /** Total bytes captured in the overlay. */
  totalBytes: number;
  /** Number of deleted files recorded in the overlay. */
  deletedCount: number;
  /** Content hash of the overlay manifest (integrity check on restore). */
  manifestHash: string;
}

/** One entry in a snapshot overlay. */
export interface SandboxV3SnapshotEntry {
  /** Path relative to the session workspace root. */
  path: string;
  /** `file` for a captured file, `deleted` for a tombstone. */
  kind: 'file' | 'deleted';
  /** Byte size of the captured content (0 for tombstones). */
  sizeBytes: number;
  /** Content hash (sha-256 hex) of the captured content. */
  contentHash: string;
  /** Last-modified time of the source file (ms since epoch). */
  mtimeMs: number;
}

/** A hook registration. */
export interface SandboxV3Hook {
  /** Hook id (uuid). */
  id: string;
  /** Display name, e.g. `block-shell-in-sandbox`. */
  name: string;
  /** When it runs. */
  timing: SandboxV3HookTiming;
  /** What it matches. Absent matcher = matches everything. */
  matcher?: SandboxV3HookMatcher;
  /** What it decides when it matches. */
  decision: SandboxV3HookDecision;
  /** Replacement arguments when decision is `modify` (JSON object). */
  modifyArgs?: Record<string, unknown>;
  /** Message shown to the agent when the hook denies or modifies. */
  message?: string;
  /** Whether the hook is currently active (disabled hooks are skipped). */
  enabled: boolean;
  /** Priority: lower runs first. Ties run in registration order. */
  priority: number;
}

/** What a hook evaluation returns for one tool call. */
export interface SandboxV3HookEvaluation {
  /** Final decision after all matching hooks ran. */
  decision: SandboxV3HookDecision;
  /** Arguments the tool should actually run with (rewritten when modified). */
  args: Record<string, unknown>;
  /** Ids of the hooks that matched, in evaluation order. */
  matchedHookIds: string[];
  /** Human-readable explanation of the final decision. */
  reason: string;
  /** True when at least one hook denied the call. */
  denied: boolean;
  /** True when at least one hook rewrote the arguments. */
  modified: boolean;
}

/** One tool step executed inside a session. */
export interface SandboxV3Step {
  /** Step id (uuid). */
  id: string;
  /** Tool name that ran. */
  tool: string;
  /** Arguments the tool ran with (after hook rewrites). */
  args: Record<string, unknown>;
  /** When the step started (ms since epoch). */
  startedAtMs: number;
  /** When the step finished (ms since epoch). 0 while running. */
  finishedAtMs: number;
  /** `ok` / `denied` / `error` / `skipped-paused`. */
  status: 'ok' | 'denied' | 'error' | 'skipped-paused';
  /** Short result summary (never the full secret-bearing output). */
  summary: string;
  /** Syscalls the step attempted (names only, for the report). */
  syscalls: string[];
  /** Egress hosts the step reached (hosts only, for the report). */
  egressHosts: string[];
}

/** A live sandbox v3 session. */
export interface SandboxV3Session {
  /** Session id (uuid). */
  id: string;
  /** Isolation tier the session runs on (from v2). */
  tier: SandboxV2Tier;
  /** Trust level the session was created for. */
  trust: SandboxV2TrustLevel;
  /** Policy id the session was created from. */
  policyId: string;
  /** Current lifecycle state. */
  state: SandboxV3SessionState;
  /** When the session was created (ms since epoch). */
  createdAtMs: number;
  /** Hard deadline (ms since epoch). 0 = no lifetime cap. */
  deadlineMs: number;
  /** Workspace directory for the session (under the v3 base dir). */
  workdir: string;
  /** Steps executed so far, in order. */
  steps: SandboxV3Step[];
  /** Blocked events so far, in order. */
  blockedEvents: SandboxV3BlockedEvent[];
  /** Snapshot ids taken in this session, in order. */
  snapshotIds: string[];
  /** Egress requests used so far. */
  egressRequestsUsed: number;
  /** Egress bytes used so far. */
  egressBytesUsed: number;
  /** Why the session ended (present once stopped / expired). */
  endReason?: SandboxV3EndReason;
  /** When the session ended (ms since epoch). 0 while live. */
  endedAtMs: number;
}

/** Summary of a session for list / report endpoints. */
export interface SandboxV3SessionSummary {
  id: string;
  tier: SandboxV2Tier;
  trust: SandboxV2TrustLevel;
  policyId: string;
  state: SandboxV3SessionState;
  createdAtMs: number;
  deadlineMs: number;
  steps: number;
  blocked: number;
  snapshots: number;
  egressRequestsUsed: number;
  egressBytesUsed: number;
  endReason?: SandboxV3EndReason;
  endedAtMs: number;
}
