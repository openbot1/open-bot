/**
 * Sandbox v3 — session runner (v1.35, Team T2).
 *
 * One runner owns every live session and ties the five subsystems
 * together. The order of checks for every step is fixed and
 * fail-closed — a step runs only when ALL of these pass:
 *
 *   1. session exists and is `running` (lifecycle) — a paused,
 *      stopped or expired session refuses the step.
 *   2. lifetime cap has not expired and the idle clock is fresh
 *      (lifetime) — an expired session auto-stops itself.
 *   3. step budget not exhausted (`caps.maxSteps`).
 *   4. PreToolUse hooks allow the call (hooks) — a deny records
 *      the step as `denied`; a modify rewrites the arguments.
 *   5. declared syscalls are on the allowlist (syscallAllowlist).
 *   6. declared egress hosts pass the gate (egressPolicy).
 *   7. the command (when the step runs a shell command) is on the
 *      policy command list and the shell is enabled.
 *
 * Only then does the step execute — either through the caller
 * supplied executor (`runStep`) or as a spawned shell command
 * (`runCommand`, same honesty contract as v2: bwrap when present,
 * plain spawn otherwise, and the report always says whether the
 * run was isolated). After execution the PostToolUse hooks decide
 * whether the agent sees the result.
 *
 * Sessions are in-memory records plus an on-disk workspace under
 * `<baseDir>/<sessionId>/` and snapshots under
 * `<baseDir>/snapshots/`. Stopping a session ends it; deleting it
 * removes the workspace and its snapshots. Nothing here phones
 * home, boots a VM, or touches the network itself.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SandboxV3EgressGate } from './egressPolicy';
import type { SandboxV3EgressCheck, SandboxV3EgressRequest } from './types';
import { SandboxV3HookRegistry } from './hooks';
import type { RegisterHookSpec, SandboxV3ToolCall } from './hooks';
import { LifecycleController } from './lifecycle';
import { SandboxV3LifetimeCap } from './lifetime';
import { SnapshotStore } from './snapshot';
import type { SnapshotRestoreResult } from './snapshot';
import { SyscallAllowlist } from './syscallAllowlist';
import {
  assertValidSandboxV3Policy,
  builtinPolicyV3ForTrust,
  getBuiltinSandboxV3Policy,
  isDeniedSandboxV3Path,
} from './policy';
import type { SandboxV3Policy } from './policy';
import type {
  SandboxV3BlockedEvent,
  SandboxV3EndReason,
  SandboxV3Session,
  SandboxV3SessionState,
  SandboxV3SessionSummary,
  SandboxV3Snapshot,
  SandboxV3Step,
  SandboxV2Tier,
  SandboxV2TrustLevel,
} from './types';

/** Default base dir for session workspaces (under the OS temp dir). */
export function defaultSandboxV3BaseDir(): string {
  return path.join(os.tmpdir(), 'open-bot-sandbox-v3');
}

/** How a command step is executed (injected by the host / tests). */
export type SandboxV3StepExecutor = (
  call: SandboxV3ToolCall,
) => Promise<{ output: string; exitCode: number }>;

export interface SandboxV3RunnerOptions {
  /** Base dir for session workspaces + snapshots. */
  baseDir?: string;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
  /** Default step executor (tests / dry runs). */
  defaultExecutor?: SandboxV3StepExecutor;
}

export interface CreateSandboxV3SessionOptions {
  /** Policy id (builtin) or full policy object. Default: trust builtin. */
  policyId?: string;
  policy?: SandboxV3Policy | string;
  /** Trust level (used when no policy is given). Default `standard`. */
  trust?: SandboxV2TrustLevel;
  /** Requested tier. Default: the policy minimum tier. */
  tier?: SandboxV2Tier;
  /** Requested lifetime in ms (clamped by the policy max). */
  lifetimeMs?: number;
  /** Extra hooks to register on top of the policy hooks. */
  extraHooks?: RegisterHookSpec[];
}

export interface RunSandboxV3StepOptions {
  /** Syscalls the step declares it will use (checked first). */
  syscalls?: string[];
  /** Egress requests the step declares (checked first). */
  egress?: SandboxV3EgressRequest[];
  /** Executor for this step (overrides the runner default). */
  executor?: SandboxV3StepExecutor;
  /** Timeout for a spawned command, ms. Default 30_000. */
  timeoutMs?: number;
}

export interface RunSandboxV3CommandOptions extends RunSandboxV3StepOptions {
  /** Working directory inside the session workspace (relative). */
  cwd?: string;
  /** Environment variables for the child (inherited + these). */
  env?: Record<string, string>;
}

/** Full report for a session (live or finished). */
export interface SandboxV3SessionReport {
  session: SandboxV3SessionSummary;
  policy: { id: string; name: string; version: number; trust: SandboxV2TrustLevel; tier: SandboxV2Tier };
  lifetime: ReturnType<SandboxV3LifetimeCap['describe']>;
  lifecycle: ReturnType<LifecycleController['describe']>;
  egress: ReturnType<SandboxV3EgressGate['describe']>;
  syscalls: { mode: string; allowCount: number; denied: number };
  hooks: { registered: number; enabled: number; denied: number; modified: number };
  snapshots: SandboxV3Snapshot[];
  steps: SandboxV3Step[];
  blockedEvents: SandboxV3BlockedEvent[];
  isolated: boolean;
  isolationDetail: string;
}

interface SessionRecord {
  session: SandboxV3Session;
  policy: SandboxV3Policy;
  lifecycle: LifecycleController;
  lifetime: SandboxV3LifetimeCap;
  egressGate: SandboxV3EgressGate;
  syscallEngine: SyscallAllowlist;
  hooks: SandboxV3HookRegistry;
  snapshots: SnapshotStore;
  bwrapAvailable: boolean;
}

/**
 * The v3 runner. One instance per host process; sessions are
 * isolated from each other (own policy, gates, hooks, workspace).
 */
export class SandboxV3Runner {
  private readonly baseDir: string;
  private readonly nowMs: () => number;
  private readonly defaultExecutor?: SandboxV3StepExecutor;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly snapshotStore: SnapshotStore;

  constructor(options: SandboxV3RunnerOptions = {}) {
    this.baseDir = path.resolve(options.baseDir ?? defaultSandboxV3BaseDir());
    this.nowMs = options.nowMs ?? Date.now;
    this.defaultExecutor = options.defaultExecutor;
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.snapshotStore = new SnapshotStore({
      baseDir: path.join(this.baseDir, 'snapshots'),
    });
  }

  /** Base dir this runner uses. */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** Resolve the policy for a create request (throws when invalid). */
  resolvePolicy(options: CreateSandboxV3SessionOptions): SandboxV3Policy {
    if (options.policy !== undefined) {
      if (typeof options.policy === 'string') return assertValidSandboxV3Policy(JSON.parse(options.policy) as unknown);
      return assertValidSandboxV3Policy(options.policy);
    }
    if (options.policyId !== undefined) {
      const builtin = getBuiltinSandboxV3Policy(options.policyId);
      if (!builtin) throw new Error(`Unknown sandbox v3 policy "${options.policyId}"`);
      return builtin;
    }
    return builtinPolicyV3ForTrust(options.trust ?? 'standard');
  }

  /** Create a session and start it (state `running`). */
  createSession(options: CreateSandboxV3SessionOptions = {}): SandboxV3SessionSummary {
    const policy = this.resolvePolicy(options);
    const tier = options.tier ?? policy.minTier;
    const tierLevels: Record<SandboxV2Tier, number> = {
      bwrap: 1,
      'syscall-policy': 2,
      microvm: 3,
    };
    if (tierLevels[tier] < policy.minTierLevel) {
      throw new Error(
        `Tier "${tier}" is below the policy minimum tier "${policy.minTier}"`,
      );
    }
    const now = this.nowMs();
    const id = randomUUID();
    const workdir = path.join(this.baseDir, id);
    fs.mkdirSync(workdir, { recursive: true });
    const lifetime = new SandboxV3LifetimeCap({
      lifetimeMs: Math.min(
        options.lifetimeMs ?? policy.lifetime.maxLifetimeMs,
        policy.lifetime.maxLifetimeMs,
      ),
      graceMs: policy.lifetime.graceMs,
      idleTimeoutMs: policy.lifetime.idleTimeoutMs,
      startedAtMs: now,
      nowMs: this.nowMs,
    });
    const lifecycle = new LifecycleController({
      initialState: 'created',
      maxPauseMs: policy.lifetime.maxPauseMs,
      nowMs: this.nowMs,
    });
    const session: SandboxV3Session = {
      id,
      tier,
      trust: policy.trust,
      policyId: policy.id,
      state: 'created',
      createdAtMs: now,
      deadlineMs: lifetime.getDeadlineMs(),
      workdir,
      steps: [],
      blockedEvents: [],
      snapshotIds: [],
      egressRequestsUsed: 0,
      egressBytesUsed: 0,
      endedAtMs: 0,
    };
    const record: SessionRecord = {
      session,
      policy,
      lifecycle,
      lifetime,
      egressGate: new SandboxV3EgressGate({
        policy: policy.egress,
        onDenied: (check) => this.recordBlocked(id, 'egress', `egress ${check.host || check.detail}`, check.detail),
      }),
      syscallEngine: new SyscallAllowlist({
        mode: policy.syscallMode,
        extraAllow: policy.syscalls.allow,
        extraDeny: policy.syscalls.deny,
        logOnlyDeny: policy.syscalls.logOnlyDeny,
        onBlocked: (event) => {
          this.recordBlocked(id, 'syscall', `syscall ${event.syscall}`, event.reason);
        },
      }),
      hooks: new SandboxV3HookRegistry(),
      snapshots: this.snapshotStore,
      bwrapAvailable: probeBwrapAvailable(),
    };
    for (const hook of policy.hooks) record.hooks.register(hook);
    for (const hook of options.extraHooks ?? []) record.hooks.register(hook);
    this.sessions.set(id, record);
    lifecycle.start('Session created');
    this.syncSessionState(record);
    return this.summarize(record);
  }

  /** Resolve a live session record (throws when unknown). */
  private requireRecord(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown sandbox v3 session "${sessionId}"`);
    return record;
  }

  /** Session summary, or undefined when unknown. */
  getSession(sessionId: string): SandboxV3SessionSummary | undefined {
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    this.syncSessionState(record);
    return this.summarize(record);
  }

  /** All sessions, oldest first. */
  listSessions(): SandboxV3SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.session.createdAtMs - b.session.createdAtMs)
      .map((record) => {
        this.syncSessionState(record);
        return this.summarize(record);
      });
  }

  /** Sessions in a given state. */
  listSessionsByState(state: SandboxV3SessionState): SandboxV3SessionSummary[] {
    return this.listSessions().filter((session) => session.state === state);
  }

  /** Record a heartbeat (owner activity) for a session. */
  heartbeat(sessionId: string): void {
    const record = this.requireRecord(sessionId);
    record.lifetime.heartbeat();
  }

  /** Pause a session. Returns false when the session cannot pause. */
  pauseSession(sessionId: string, reason = ''): boolean {
    const record = this.requireRecord(sessionId);
    const ok = record.lifecycle.pause(reason);
    this.syncSessionState(record);
    return ok;
  }

  /** Resume a paused session. Returns false when not paused. */
  resumeSession(sessionId: string, reason = ''): boolean {
    const record = this.requireRecord(sessionId);
    const ok = record.lifecycle.resume(reason);
    if (ok) record.lifetime.heartbeat();
    this.syncSessionState(record);
    return ok;
  }

  /** Stop a session for good (terminal). */
  stopSession(sessionId: string, reason = '', endReason: SandboxV3EndReason = 'killed'): boolean {
    const record = this.requireRecord(sessionId);
    const ok = record.lifecycle.stop(reason, endReason);
    this.syncSessionState(record);
    return ok;
  }

  /** Delete a session: stop it, remove workspace + snapshots. */
  deleteSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    try {
      record.lifecycle.stop('Session deleted');
    } catch {
      // Already terminal — continue with the removal.
    }
    for (const snapshotId of [...record.session.snapshotIds]) {
      record.snapshots.deleteSnapshot(sessionId, snapshotId);
    }
    try {
      fs.rmSync(record.session.workdir, { recursive: true, force: true });
    } catch {
      // Workspace already gone — nothing to do.
    }
    this.sessions.delete(sessionId);
    return true;
  }

  /** Check one egress request against the session's gate (no step needed). */
  checkEgress(sessionId: string, request: SandboxV3EgressRequest): SandboxV3EgressCheck {
    const record = this.requireRecord(sessionId);
    const check = record.egressGate.check(request);
    this.syncEgressCounters(record);
    return check;
  }

  /** Check one syscall against the session's allowlist. */
  checkSyscall(sessionId: string, name: string): ReturnType<SyscallAllowlist['checkSyscall']> {
    const record = this.requireRecord(sessionId);
    return record.syscallEngine.checkSyscall(name);
  }

  /** Register an extra hook on a live session. */
  registerHook(sessionId: string, spec: RegisterHookSpec): string {
    const record = this.requireRecord(sessionId);
    return record.hooks.register(spec).id;
  }

  /** Disable a hook on a live session. */
  disableHook(sessionId: string, hookId: string): boolean {
    const record = this.requireRecord(sessionId);
    return record.hooks.setEnabled(hookId, false) !== undefined;
  }

  /** Take a COW snapshot of the session workspace. */
  takeSnapshot(sessionId: string, label: string): SandboxV3Snapshot {
    const record = this.requireRecord(sessionId);
    if (record.session.snapshotIds.length >= record.policy.caps.maxSnapshots) {
      throw new Error(
        `Snapshot cap reached (${record.policy.caps.maxSnapshots} per session)`,
      );
    }
    const snapshot = record.snapshots.capture(sessionId, record.session.workdir, label);
    record.session.snapshotIds.push(snapshot.id);
    record.snapshots.prune(sessionId, record.policy.caps.maxSnapshots);
    return snapshot;
  }

  /** Restore a snapshot into the session workspace. */
  restoreSnapshot(sessionId: string, snapshotId: string): SnapshotRestoreResult {
    const record = this.requireRecord(sessionId);
    if (!record.session.snapshotIds.includes(snapshotId)) {
      throw new Error(`Snapshot "${snapshotId}" does not belong to session "${sessionId}"`);
    }
    return record.snapshots.restore(sessionId, snapshotId, record.session.workdir);
  }

  /** List snapshots of a session. */
  listSnapshots(sessionId: string): SandboxV3Snapshot[] {
    const record = this.requireRecord(sessionId);
    return record.snapshots.listSnapshots(sessionId);
  }

  /**
   * Run one tool step inside a session, through the full gate
   * chain. `executor` performs the actual work (a real tool call,
   * a dry-run stub, ...); when absent, the runner's default
   * executor runs, and when that is absent too the step is a
   * gate-only check that returns `"(no executor: gates only)"`.
   */
  async runStep(
    sessionId: string,
    call: SandboxV3ToolCall,
    options: RunSandboxV3StepOptions = {},
  ): Promise<SandboxV3Step> {
    const record = this.requireRecord(sessionId);
    const now = this.nowMs();
    const step: SandboxV3Step = {
      id: randomUUID(),
      tool: call.tool,
      args: { ...call.args },
      startedAtMs: now,
      finishedAtMs: 0,
      status: 'error',
      summary: '',
      syscalls: options.syscalls ?? [],
      egressHosts: (options.egress ?? []).map((request) => {
        try {
          return new URL(request.url).hostname;
        } catch {
          return request.url;
        }
      }),
    };
    const finish = (status: SandboxV3Step['status'], summary: string): SandboxV3Step => {
      step.status = status;
      step.summary = summary.slice(0, record.policy.caps.maxOutputChars);
      step.finishedAtMs = this.nowMs();
      record.session.steps.push(step);
      record.lifetime.heartbeat();
      return step;
    };

    // 1. Lifecycle: only a running session accepts steps.
    if (!record.lifecycle.mayRunStep()) {
      if (record.lifecycle.getState() === 'paused') {
        return finish('skipped-paused', `Session is paused — step "${call.tool}" skipped`);
      }
      return finish('denied', `Session is ${record.lifecycle.getState()} — step "${call.tool}" refused`);
    }
    // 2. Lifetime: expired or idle sessions auto-stop first.
    const stopCause = record.lifetime.evaluateAutoStop(now, false);
    if (stopCause !== undefined) {
      this.expireFromLifetime(record, stopCause);
      return finish('denied', `Session auto-stopped (${stopCause}) — step "${call.tool}" refused`);
    }
    // 3. Step budget.
    if (record.session.steps.length >= record.policy.caps.maxSteps) {
      return finish('denied', `Step budget exceeded (${record.policy.caps.maxSteps} steps)`);
    }
    // 4. PreToolUse hooks.
    const pre = record.hooks.evaluatePre(call);
    if (pre.denied) {
      this.recordBlocked(sessionId, 'hook', `tool ${call.tool}`, pre.reason, call.toolCallId);
      return finish('denied', `Blocked by PreToolUse hook: ${pre.reason}`);
    }
    step.args = pre.args;
    const effectiveCall: SandboxV3ToolCall = { ...call, args: pre.args };
    // 5. Declared syscalls against the allowlist.
    for (const name of options.syscalls ?? []) {
      const check = record.syscallEngine.checkSyscall(name);
      if (check.verdict === 'deny') {
        return finish('denied', `Syscall "${name}" denied: ${check.reason}`);
      }
    }
    // 6. Declared egress against the gate.
    for (const request of options.egress ?? []) {
      const check = record.egressGate.check(request);
      if (check.verdict === 'deny') {
        this.syncEgressCounters(record);
        return finish('denied', `Egress denied: ${check.detail}`);
      }
    }
    this.syncEgressCounters(record);
    // 7. Execute.
    const executor = options.executor ?? this.defaultExecutor;
    let output = '(no executor: gates only)';
    let exitCode = 0;
    try {
      if (executor) {
        const result = await executor(effectiveCall);
        output = result.output;
        exitCode = result.exitCode;
      }
    } catch (err) {
      return finish('error', `Step "${call.tool}" failed: ${(err as Error).message}`);
    }
    if (exitCode !== 0) {
      return finish('error', `Step "${call.tool}" failed with exit code ${exitCode}: ${output.slice(0, 200)}`);
    }
    // 8. PostToolUse hooks decide what the agent sees.
    const post = record.hooks.evaluatePost(effectiveCall, output);
    if (post.denied) {
      return finish('ok', `Result withheld by PostToolUse hook: ${post.reason}`);
    }
    return finish('ok', post.modified ? post.result : output);
  }

  /**
   * Run a shell command inside a session. The command must be on
   * the policy command list (when the list is non-empty) and the
   * shell must be enabled. Execution honesty (same as v2): bwrap
   * when present, plain spawn otherwise, and the report always
   * says whether the run was isolated.
   */
  async runCommand(
    sessionId: string,
    command: string,
    options: RunSandboxV3CommandOptions = {},
  ): Promise<SandboxV3Step> {
    const record = this.requireRecord(sessionId);
    const argv = command.trim().split(/\s+/).filter((part) => part !== '');
    if (argv.length === 0) {
      const step: SandboxV3Step = {
        id: randomUUID(),
        tool: 'shell',
        args: { command },
        startedAtMs: this.nowMs(),
        finishedAtMs: this.nowMs(),
        status: 'denied',
        summary: 'Empty command refused',
        syscalls: [],
        egressHosts: [],
      };
      record.session.steps.push(step);
      return step;
    }
    if (!record.policy.shellEnabled) {
      const step: SandboxV3Step = {
        id: randomUUID(),
        tool: 'shell',
        args: { command },
        startedAtMs: this.nowMs(),
        finishedAtMs: this.nowMs(),
        status: 'denied',
        summary: 'Shell is disabled by the policy — command refused',
        syscalls: [],
        egressHosts: [],
      };
      this.recordBlocked(sessionId, 'policy', `command ${argv[0]}`, step.summary);
      record.session.steps.push(step);
      return step;
    }
    if (record.policy.commands.length > 0 && !record.policy.commands.includes(argv[0])) {
      const step: SandboxV3Step = {
        id: randomUUID(),
        tool: 'shell',
        args: { command },
        startedAtMs: this.nowMs(),
        finishedAtMs: this.nowMs(),
        status: 'denied',
        summary: `Command "${argv[0]}" is not on the policy command list`,
        syscalls: [],
        egressHosts: [],
      };
      this.recordBlocked(sessionId, 'policy', `command ${argv[0]}`, step.summary);
      record.session.steps.push(step);
      return step;
    }
    const cwd = options.cwd
      ? resolveSessionCwd(record.session.workdir, options.cwd)
      : record.session.workdir;
    if (cwd === undefined) {
      const step: SandboxV3Step = {
        id: randomUUID(),
        tool: 'shell',
        args: { command },
        startedAtMs: this.nowMs(),
        finishedAtMs: this.nowMs(),
        status: 'denied',
        summary: `Working directory "${options.cwd ?? ''}" escapes the session workspace`,
        syscalls: [],
        egressHosts: [],
      };
      record.session.steps.push(step);
      return step;
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    const executor: SandboxV3StepExecutor = async () =>
      runCommandWithTimeout(argv, cwd, timeoutMs, options.env, record.bwrapAvailable);
    return this.runStep(sessionId, { tool: 'shell', args: { command } }, { ...options, executor });
  }

  /** Full report for a session (live or finished). */
  getReport(sessionId: string): SandboxV3SessionReport | undefined {
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    this.syncSessionState(record);
    const summary = this.summarize(record);
    return {
      session: summary,
      policy: {
        id: record.policy.id,
        name: record.policy.name,
        version: record.policy.version,
        trust: record.policy.trust,
        tier: record.session.tier,
      },
      lifetime: record.lifetime.describe(),
      lifecycle: record.lifecycle.describe(),
      egress: record.egressGate.describe(),
      syscalls: {
        mode: record.syscallEngine.getMode(),
        allowCount: record.syscallEngine.allowCount(),
        denied: record.syscallEngine.deniedCount(),
      },
      hooks: {
        registered: record.hooks.size(),
        enabled: record.hooks.enabledCount(),
        denied: record.hooks.deniedCount(),
        modified: record.hooks.modifiedCount(),
      },
      snapshots: record.snapshots.listSnapshots(sessionId),
      steps: [...record.session.steps],
      blockedEvents: [...record.session.blockedEvents],
      isolated: record.bwrapAvailable,
      isolationDetail: record.bwrapAvailable
        ? `bwrap present — shell commands run inside a bubblewrap box (tier ${record.session.tier})`
        : 'bwrap NOT present — shell commands run unboxed on the host; the policy gates still apply but the run is NOT isolated',
    };
  }

  /** Evaluate lifetime + pause expiry for all sessions. */
  sweep(now?: number): string[] {
    const at = now ?? this.nowMs();
    const changed: string[] = [];
    for (const record of this.sessions.values()) {
      if (record.lifecycle.isTerminal()) continue;
      if (record.lifecycle.evaluatePauseExpiry(at)) {
        this.syncSessionState(record);
        changed.push(record.session.id);
        continue;
      }
      const cause = record.lifetime.evaluateAutoStop(at, false);
      if (cause !== undefined) {
        this.expireFromLifetime(record, cause);
        changed.push(record.session.id);
      }
    }
    return changed;
  }

  private expireFromLifetime(
    record: SessionRecord,
    cause: 'lifetime-cap' | 'grace-expired' | 'idle-timeout' | 'manual',
  ): void {
    if (cause === 'idle-timeout') {
      record.lifecycle.expire(`Idle timeout (${record.lifetime.getIdleTimeoutMs()}ms)`, 'auto-stopped');
    } else {
      record.lifecycle.expire(`Lifetime cap reached (${cause})`, 'lifetime-cap');
    }
    this.syncSessionState(record);
  }

  private recordBlocked(
    sessionId: string,
    source: SandboxV3BlockedEvent['source'],
    attempted: string,
    reason: string,
    toolCallId?: string,
  ): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.session.blockedEvents.push({
      seq: record.session.blockedEvents.length + 1,
      atMs: this.nowMs(),
      source,
      attempted,
      reason,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    });
  }

  private syncSessionState(record: SessionRecord): void {
    record.session.state = record.lifecycle.getState();
    record.session.deadlineMs = record.lifetime.getDeadlineMs();
    const endReason = record.lifecycle.getEndReason();
    if (endReason !== undefined) {
      record.session.endReason = endReason;
      record.session.endedAtMs = record.lifecycle.getEndedAtMs();
    }
    this.syncEgressCounters(record);
  }

  private syncEgressCounters(record: SessionRecord): void {
    record.session.egressRequestsUsed = record.egressGate.getRequestsUsed();
    record.session.egressBytesUsed = record.egressGate.getBytesUsed();
  }

  private summarize(record: SessionRecord): SandboxV3SessionSummary {
    const session = record.session;
    return {
      id: session.id,
      tier: session.tier,
      trust: session.trust,
      policyId: session.policyId,
      state: session.state,
      createdAtMs: session.createdAtMs,
      deadlineMs: session.deadlineMs,
      steps: session.steps.length,
      blocked: session.blockedEvents.length,
      snapshots: session.snapshotIds.length,
      egressRequestsUsed: session.egressRequestsUsed,
      egressBytesUsed: session.egressBytesUsed,
      ...(session.endReason !== undefined ? { endReason: session.endReason } : {}),
      endedAtMs: session.endedAtMs,
    };
  }
}

/** Resolve a relative cwd inside the session workspace (undefined when it escapes). */
export function resolveSessionCwd(workdir: string, cwd: string): string | undefined {
  const absoluteRoot = path.resolve(workdir);
  const absolute = path.resolve(absoluteRoot, cwd);
  if (absolute !== absoluteRoot && !absolute.startsWith(absoluteRoot + path.sep)) {
    return undefined;
  }
  return absolute;
}

/** True when the `bwrap` binary is on PATH (best-effort probe). */
export function probeBwrapAvailable(): boolean {
  const pathVar = process.env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === '') continue;
    try {
      if (fs.existsSync(path.join(dir, 'bwrap'))) return true;
    } catch {
      // Ignore unreadable PATH entries.
    }
  }
  return false;
}

/**
 * Spawn a command with a timeout. When bwrap is available the
 * command runs inside a minimal box (`--ro-bind /usr`, `--bind`
 * workdir, `--unshare-all`, `--die-with-parent`); otherwise it
 * runs directly and the caller must report `isolated: false`.
 */
export function runCommandWithTimeout(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> | undefined,
  bwrapAvailable: boolean,
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const command = argv[0];
    const args = argv.slice(1);
    let child: ReturnType<typeof spawn>;
    try {
      if (bwrapAvailable) {
        child = spawn(
          'bwrap',
          [
            '--unshare-all',
            '--die-with-parent',
            '--ro-bind', '/usr', '/usr',
            '--ro-bind', '/lib', '/lib',
            '--ro-bind', '/lib64', '/lib64',
            '--bind', cwd, cwd,
            '--chdir', cwd,
            '--',
            command,
            ...args,
          ],
          { cwd, env: { ...process.env, ...(env ?? {}) }, timeout: timeoutMs },
        );
      } else {
        child = spawn(command, args, {
          cwd,
          env: { ...process.env, ...(env ?? {}) },
          timeout: timeoutMs,
        });
      }
    } catch (err) {
      resolve({ output: `Failed to spawn "${command}": ${(err as Error).message}`, exitCode: 127 });
      return;
    }
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      resolve({ output: `Failed to spawn "${command}": ${err.message}`, exitCode: 127 });
    });
    child.on('close', (code: number | null) => {
      resolve({ output, exitCode: code ?? 1 });
    });
  });
}

/** Summarise a session report in a few lines (for list UIs). */
export function summarizeSandboxV3Report(report: SandboxV3SessionReport): string {
  const session = report.session;
  return (
    `session ${session.id} [${session.state}] tier=${session.tier} ` +
    `steps=${session.steps} blocked=${session.blocked} ` +
    `snapshots=${session.snapshots} egress=${session.egressRequestsUsed} reqs / ` +
    `${session.egressBytesUsed} bytes isolated=${report.isolated ? 'yes' : 'NO'}`
  );
}

/** Render a session report as Markdown (for the report tool / UI). */
export function renderSandboxV3ReportMarkdown(report: SandboxV3SessionReport): string {
  const lines: string[] = [];
  const session = report.session;
  lines.push(`# Sandbox v3 report — ${session.id}`);
  lines.push('');
  lines.push(`- State: **${session.state}**${session.endReason ? ` (${session.endReason})` : ''}`);
  lines.push(`- Tier: ${session.tier} · trust: ${session.trust} · policy: ${report.policy.id} v${report.policy.version}`);
  lines.push(`- Isolated: ${report.isolated ? 'yes' : 'NO — ' + report.isolationDetail}`);
  lines.push(`- Steps: ${session.steps} · blocked events: ${session.blocked} · snapshots: ${session.snapshots}`);
  lines.push(`- Egress: ${session.egressRequestsUsed} requests / ${session.egressBytesUsed} bytes`);
  lines.push(`- Lifetime: deadline ${new Date(session.deadlineMs).toISOString()}, remaining ${report.lifetime.remainingMs}ms`);
  lines.push('');
  if (report.steps.length > 0) {
    lines.push('## Steps');
    for (const step of report.steps) {
      const cmd = typeof step.args?.command === 'string' && step.args.command !== '' ? ` "${step.args.command}"` : '';
      lines.push(`- [${step.status}] ${step.tool}${cmd} — ${step.summary}`);
    }
    lines.push('');
  }
  if (report.blockedEvents.length > 0) {
    lines.push('## Blocked events');
    for (const event of report.blockedEvents) {
      lines.push(`- #${event.seq} [${event.source}] ${event.attempted} — ${event.reason}`);
    }
    lines.push('');
  }
  if (report.snapshots.length > 0) {
    lines.push('## Snapshots');
    for (const snapshot of report.snapshots) {
      lines.push(`- ${snapshot.id} "${snapshot.label}" — ${snapshot.fileCount} files, ${snapshot.totalBytes} bytes`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** True when a path is denied under a session's policy (re-export for tools). */
export { isDeniedSandboxV3Path };
