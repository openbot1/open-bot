/**
 * Sandbox v4 — per-conversation runtime (v1.36, Team T4).
 *
 * One conversation, one runtime. A runtime owns:
 *
 *  - one sandbox v3 session (the isolation: syscall allowlist,
 *    egress gate, lifetime cap, hooks — all v3, reused, not
 *    reimplemented),
 *  - its own workspace directory `<baseDir>/conversations/<id>/`
 *    (the conversation's files; nothing from another
 *    conversation ever lands here),
 *  - a process registry: every process spawned for the
 *    conversation is tracked by pid, and stopping the runtime
 *    kills them all (best-effort — a pid that is already gone
 *    is reported, not an error),
 *  - one budget meter (`budgetMeter.ts`) and one profile slot
 *    (the profile itself lives in `agentProfiles.ts`).
 *
 * Rules:
 *  - At most one live runtime per conversation. Creating a
 *    second while one is live throws — the caller must stop
 *    or clean up the old one first. (A stopped runtime can be
 *    replaced; a cleaned one is gone for good.)
 *  - Conversation ids are validated as safe path segments
 *    (`SANDBOX_V4_CONVERSATION_ID_PATTERN`): a conversation id
 *    must never escape its workspace directory.
 *  - Stopping is terminal for the v3 session; cleanup removes
 *    the workspace directory and the v3 session. After cleanup
 *    the runtime record stays as a `cleaned` tombstone so
 *    reports can still show it existed.
 *  - Idle runtimes expire: no heartbeat / step / process
 *    activity for `idleTimeoutMs` marks the runtime `expired`
 *    (the v3 session is stopped; the workspace is kept until
 *    explicit cleanup, so nothing is lost by surprise).
 *  - Budget soft-block is enforced here: `mayRunStep` is false
 *    while the meter is soft-blocked, and `recordUsage`
 *    refreshes activity so a blocked conversation does not
 *    also silently idle-expire underneath the operator.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SandboxV3Runner } from '../sandboxV3/runner';
import type { SandboxV3SessionSummary } from '../sandboxV3/types';
import { SandboxV4BudgetMeter } from './budgetMeter';
import type { SandboxV4BudgetLimits } from './types';
import {
  SANDBOX_V4_CONVERSATION_ID_PATTERN,
} from './types';
import type {
  SandboxV4BudgetState,
  SandboxV4ConversationRuntime,
  SandboxV4RuntimeEndReason,
  SandboxV4RuntimeProcess,
  SandboxV4RuntimeState,
  SandboxV4RuntimeSummary,
  SandboxV2Tier,
  SandboxV2TrustLevel,
} from './types';

/** Default base dir for v4 runtimes (under the OS temp dir). */
export function defaultSandboxV4BaseDir(): string {
  return path.join(os.tmpdir(), 'open-bot-sandbox-v4');
}

/** Default idle timeout: 30 minutes without activity. */
export const SANDBOX_V4_DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Default lifetime cap for a runtime: 4 hours. */
export const SANDBOX_V4_DEFAULT_LIFETIME_MS = 4 * 60 * 60 * 1000;

/** Hard maximum lifetime cap: 24 hours. */
export const SANDBOX_V4_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface SandboxV4RuntimeManagerOptions {
  /** Base dir for conversation workspaces + v3 sessions. */
  baseDir?: string;
  /** Idle timeout in ms (default 30 min). */
  idleTimeoutMs?: number;
  /** Default lifetime cap in ms (default 4 h). */
  defaultLifetimeMs?: number;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

export interface CreateSandboxV4RuntimeOptions {
  /** Trust level for the underlying v3 session. Default `standard`. */
  trust?: SandboxV2TrustLevel;
  /** Requested tier (never below the policy minimum). */
  tier?: SandboxV2Tier;
  /** Builtin v3 policy id (default: builtin for the trust level). */
  policyId?: string;
  /** Agent profile id to run under ('' = none; validated by the service). */
  profileId?: string;
  /** Requested lifetime in ms (clamped to the manager default / hard max). */
  lifetimeMs?: number;
  /** Starting budget limits for this conversation. */
  budgetLimits?: SandboxV4BudgetLimits;
}

/** Full report for one runtime (live or finished). */
export interface SandboxV4RuntimeReport {
  runtime: SandboxV4RuntimeSummary;
  session: SandboxV3SessionSummary | undefined;
  budget: SandboxV4BudgetState;
  processes: SandboxV4RuntimeProcess[];
  mayRunStep: boolean;
  workdirExists: boolean;
}

interface RuntimeRecord {
  runtime: SandboxV4ConversationRuntime;
  budget: SandboxV4BudgetMeter;
  idleTimeoutMs: number;
}

/**
 * Manager for per-conversation runtimes. One instance per host
 * process; runtimes are isolated from each other by construction
 * (own v3 session, own workspace, own process list, own meter).
 */
export class SandboxV4RuntimeManager {
  private readonly baseDir: string;
  private readonly v3Runner: SandboxV3Runner;
  private readonly idleTimeoutMs: number;
  private readonly defaultLifetimeMs: number;
  private readonly nowMs: () => number;
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly byConversation = new Map<string, string>();

  constructor(options: SandboxV4RuntimeManagerOptions = {}) {
    this.baseDir = path.resolve(options.baseDir ?? defaultSandboxV4BaseDir());
    this.idleTimeoutMs = Math.max(1000, Math.floor(options.idleTimeoutMs ?? SANDBOX_V4_DEFAULT_IDLE_TIMEOUT_MS));
    const lifetime = options.defaultLifetimeMs ?? SANDBOX_V4_DEFAULT_LIFETIME_MS;
    this.defaultLifetimeMs = Math.min(Math.max(Math.floor(lifetime), 1000), SANDBOX_V4_MAX_LIFETIME_MS);
    this.nowMs = options.nowMs ?? Date.now;
    fs.mkdirSync(path.join(this.baseDir, 'conversations'), { recursive: true });
    this.v3Runner = new SandboxV3Runner({
      baseDir: path.join(this.baseDir, 'v3-sessions'),
      nowMs: this.nowMs,
    });
  }

  /** Base dir this manager uses. */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** Idle timeout in ms. */
  getIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  /** Underlying v3 runner (for tools that need the session directly). */
  getV3Runner(): SandboxV3Runner {
    return this.v3Runner;
  }

  /** Validate a conversation id (throws when invalid). */
  static assertConversationId(conversationId: string): void {
    if (!SANDBOX_V4_CONVERSATION_ID_PATTERN.test(conversationId)) {
      throw new Error(
        `Invalid conversationId "${conversationId}": use 1-128 chars of letters, digits, "_", "-".`,
      );
    }
  }

  /** Create + start a runtime for a conversation. */
  create(conversationId: string, options: CreateSandboxV4RuntimeOptions = {}): SandboxV4RuntimeSummary {
    SandboxV4RuntimeManager.assertConversationId(conversationId);
    const existingId = this.byConversation.get(conversationId);
    if (existingId !== undefined) {
      const existing = this.records.get(existingId);
      if (existing && !isSandboxV4RuntimeTerminal(existing.runtime.state)) {
        throw new Error(
          `Conversation "${conversationId}" already has a live runtime (${existingId}, state ${existing.runtime.state}). Stop or clean it up first.`,
        );
      }
    }
    const now = this.nowMs();
    const lifetimeMs = Math.min(
      options.lifetimeMs ?? this.defaultLifetimeMs,
      SANDBOX_V4_MAX_LIFETIME_MS,
    );
    const session = this.v3Runner.createSession({
      ...(options.policyId !== undefined ? { policyId: options.policyId } : {}),
      trust: options.trust ?? 'standard',
      ...(options.tier !== undefined ? { tier: options.tier } : {}),
      lifetimeMs,
    });
    const workdir = path.join(this.baseDir, 'conversations', conversationId);
    fs.mkdirSync(workdir, { recursive: true });
    const runtime: SandboxV4ConversationRuntime = {
      id: randomUUID(),
      conversationId,
      sessionId: session.id,
      state: 'running',
      profileId: options.profileId ?? '',
      trust: session.trust,
      tier: session.tier,
      workdir,
      createdAtMs: now,
      deadlineMs: session.deadlineMs,
      lastActivityAtMs: now,
      processes: [],
      endedAtMs: 0,
    };
    const budget = new SandboxV4BudgetMeter({
      conversationId,
      ...(options.budgetLimits !== undefined ? { limits: options.budgetLimits } : {}),
      nowMs: this.nowMs,
    });
    this.records.set(runtime.id, { runtime, budget, idleTimeoutMs: this.idleTimeoutMs });
    this.byConversation.set(conversationId, runtime.id);
    return this.summarizeRecord(this.records.get(runtime.id) as RuntimeRecord);
  }

  /** Resolve a runtime record (throws when unknown). */
  private requireRecord(runtimeId: string): RuntimeRecord {
    const record = this.records.get(runtimeId);
    if (!record) throw new Error(`Unknown sandbox v4 runtime "${runtimeId}".`);
    return record;
  }

  /** Runtime summary by id, or undefined when unknown. */
  get(runtimeId: string): SandboxV4RuntimeSummary | undefined {
    const record = this.records.get(runtimeId);
    if (!record) return undefined;
    this.syncRecord(record);
    return this.summarizeRecord(record);
  }

  /** Runtime summary by conversation, or undefined when none. */
  getByConversation(conversationId: string): SandboxV4RuntimeSummary | undefined {
    const id = this.byConversation.get(conversationId);
    if (id === undefined) return undefined;
    return this.get(id);
  }

  /** All runtimes, oldest first. */
  list(): SandboxV4RuntimeSummary[] {
    return [...this.records.values()]
      .sort((a, b) => a.runtime.createdAtMs - b.runtime.createdAtMs)
      .map((record) => {
        this.syncRecord(record);
        return this.summarizeRecord(record);
      });
  }

  /** Runtimes in a given state. */
  listByState(state: SandboxV4RuntimeState): SandboxV4RuntimeSummary[] {
    return this.list().filter((runtime) => runtime.state === state);
  }

  /** Budget meter for a runtime (throws when unknown). */
  budgetFor(runtimeId: string): SandboxV4BudgetMeter {
    return this.requireRecord(runtimeId).budget;
  }

  /** Budget meter for a conversation (throws when no runtime). */
  budgetForConversation(conversationId: string): SandboxV4BudgetMeter {
    const id = this.byConversation.get(conversationId);
    if (id === undefined) throw new Error(`No sandbox v4 runtime for conversation "${conversationId}".`);
    return this.requireRecord(id).budget;
  }

  /** True when a new step may start in this runtime (running + budget not blocked). */
  mayRunStep(runtimeId: string): boolean {
    const record = this.requireRecord(runtimeId);
    this.syncRecord(record);
    return record.runtime.state === 'running' && record.budget.mayStartStep();
  }

  /** Record activity (heartbeat / step / tool call). Returns false when unknown. */
  heartbeat(runtimeId: string): boolean {
    const record = this.records.get(runtimeId);
    if (!record) return false;
    record.runtime.lastActivityAtMs = this.nowMs();
    try {
      this.v3Runner.heartbeat(record.runtime.sessionId);
    } catch {
      // The v3 session may already be gone; the heartbeat is best-effort.
    }
    return true;
  }

  /** Record usage on the runtime's budget meter (also a heartbeat). */
  recordUsage(runtimeId: string, input: { model?: string; inputTokens: number; outputTokens: number; wallMs?: number; costUsd?: number }): ReturnType<SandboxV4BudgetMeter['recordUsage']> {
    const record = this.requireRecord(runtimeId);
    const result = record.budget.recordUsage(input);
    record.runtime.lastActivityAtMs = this.nowMs();
    return result;
  }

  /** Pause a running runtime. Returns false when it cannot pause. */
  pause(runtimeId: string, reason = ''): boolean {
    const record = this.requireRecord(runtimeId);
    const ok = this.v3Runner.pauseSession(record.runtime.sessionId, reason);
    this.syncRecord(record);
    return ok;
  }

  /** Resume a paused runtime. Returns false when not paused. */
  resume(runtimeId: string, reason = ''): boolean {
    const record = this.requireRecord(runtimeId);
    const ok = this.v3Runner.resumeSession(record.runtime.sessionId, reason);
    if (ok) record.runtime.lastActivityAtMs = this.nowMs();
    this.syncRecord(record);
    return ok;
  }

  /**
   * Stop a runtime for good: kill its processes, stop the v3
   * session. The workspace is kept until `cleanup`. Returns
   * false when the runtime was already terminal.
   */
  stop(runtimeId: string, reason = '', endReason: SandboxV4RuntimeEndReason = 'stopped-by-user'): boolean {
    const record = this.requireRecord(runtimeId);
    if (isSandboxV4RuntimeTerminal(record.runtime.state)) return false;
    const killed = this.killProcesses(runtimeId);
    this.v3Runner.stopSession(record.runtime.sessionId, reason, 'killed');
    this.syncRecord(record);
    if (record.runtime.state === 'running' || record.runtime.state === 'paused') {
      record.runtime.state = 'stopped';
      record.runtime.endReason = endReason;
      record.runtime.endedAtMs = this.nowMs();
    }
    void killed;
    return true;
  }

  /**
   * Clean up a runtime: stop it, delete the v3 session and remove
   * the conversation workspace from disk. The record stays as a
   * `cleaned` tombstone. Returns false when unknown.
   */
  cleanup(runtimeId: string): boolean {
    const record = this.records.get(runtimeId);
    if (!record) return false;
    if (!isSandboxV4RuntimeTerminal(record.runtime.state)) {
      this.stop(runtimeId, 'Runtime cleaned up', 'stopped-by-user');
    }
    try {
      this.v3Runner.deleteSession(record.runtime.sessionId);
    } catch {
      // Best-effort: the session may already be gone.
    }
    try {
      fs.rmSync(record.runtime.workdir, { recursive: true, force: true });
    } catch {
      // Best-effort: report through the tombstone, not an exception.
    }
    record.runtime.state = 'cleaned';
    if (record.runtime.endReason === undefined) record.runtime.endReason = 'stopped-by-user';
    if (record.runtime.endedAtMs === 0) record.runtime.endedAtMs = this.nowMs();
    this.byConversation.delete(record.runtime.conversationId);
    return true;
  }

  /** Assign (or clear) the agent profile a runtime runs under. */
  setProfile(runtimeId: string, profileId: string): SandboxV4RuntimeSummary {
    const record = this.requireRecord(runtimeId);
    if (profileId !== '' && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileId)) {
      throw new Error(`Invalid profile id "${profileId}".`);
    }
    record.runtime.profileId = profileId;
    record.runtime.lastActivityAtMs = this.nowMs();
    return this.summarizeRecord(record);
  }

  /** Register a spawned process under a runtime. */
  registerProcess(runtimeId: string, input: { pid: number; label: string; command: string }): SandboxV4RuntimeProcess {
    const record = this.requireRecord(runtimeId);
    if (!Number.isInteger(input.pid) || input.pid < 0) {
      throw new Error('Process pid must be a non-negative integer.');
    }
    if (input.label.trim() === '') throw new Error('Process label must be a non-empty string.');
    const proc: SandboxV4RuntimeProcess = {
      pid: input.pid,
      label: input.label,
      command: input.command,
      startedAtMs: this.nowMs(),
      endedAtMs: 0,
      exitCode: null,
      endKind: 'unknown',
    };
    record.runtime.processes.push(proc);
    record.runtime.lastActivityAtMs = this.nowMs();
    return { ...proc };
  }

  /** Mark a registered process as exited (by pid). Returns false when unknown. */
  markProcessEnded(runtimeId: string, pid: number, exitCode: number | null): boolean {
    const record = this.records.get(runtimeId);
    if (!record) return false;
    const proc = record.runtime.processes.find((p) => p.pid === pid && p.endedAtMs === 0);
    if (!proc) return false;
    proc.endedAtMs = this.nowMs();
    proc.exitCode = exitCode;
    proc.endKind = 'exited';
    return true;
  }

  /** Live (not yet ended) processes of a runtime. */
  liveProcesses(runtimeId: string): SandboxV4RuntimeProcess[] {
    const record = this.requireRecord(runtimeId);
    return record.runtime.processes.filter((p) => p.endedAtMs === 0).map((p) => ({ ...p }));
  }

  /**
   * Kill every live process of a runtime (SIGTERM, best-effort).
   * Returns the pids that were signalled.
   */
  killProcesses(runtimeId: string): number[] {
    const record = this.requireRecord(runtimeId);
    const signalled: number[] = [];
    const now = this.nowMs();
    for (const proc of record.runtime.processes) {
      if (proc.endedAtMs !== 0 || proc.pid === 0) continue;
      try {
        process.kill(proc.pid, 'SIGTERM');
        signalled.push(proc.pid);
      } catch {
        // Already gone (or not ours) — mark it ended, not an error.
      }
      proc.endedAtMs = now;
      proc.exitCode = null;
      proc.endKind = 'killed';
    }
    return signalled;
  }

  /**
   * Expire runtimes past their lifetime deadline or idle timeout.
   * Returns the ids that expired in this pass.
   */
  sweepExpired(now?: number): string[] {
    const at = now ?? this.nowMs();
    const expired: string[] = [];
    for (const record of this.records.values()) {
      if (isSandboxV4RuntimeTerminal(record.runtime.state)) continue;
      const deadlineHit = record.runtime.deadlineMs > 0 && at >= record.runtime.deadlineMs;
      const idleHit = record.runtime.state === 'running' && at - record.runtime.lastActivityAtMs >= record.idleTimeoutMs;
      if (!deadlineHit && !idleHit) continue;
      const reason: SandboxV4RuntimeEndReason = deadlineHit ? 'lifetime-cap' : 'idle-timeout';
      this.killProcesses(record.runtime.id);
      try {
        this.v3Runner.stopSession(record.runtime.sessionId, deadlineHit ? 'Lifetime cap reached' : 'Idle timeout', 'lifetime-cap');
      } catch {
        // Best-effort.
      }
      record.runtime.state = 'expired';
      record.runtime.endReason = reason;
      record.runtime.endedAtMs = at;
      expired.push(record.runtime.id);
    }
    return expired;
  }

  /** Full report for one runtime (throws when unknown). */
  report(runtimeId: string): SandboxV4RuntimeReport {
    const record = this.requireRecord(runtimeId);
    this.syncRecord(record);
    const summary = this.summarizeRecord(record);
    return {
      runtime: summary,
      session: this.v3Runner.getSession(record.runtime.sessionId),
      budget: record.budget.describe(),
      processes: record.runtime.processes.map((p) => ({ ...p })),
      mayRunStep: this.mayRunStep(runtimeId),
      workdirExists: fs.existsSync(record.runtime.workdir),
    };
  }

  /** Sync the runtime state from the underlying v3 session. */
  private syncRecord(record: RuntimeRecord): void {
    const session = this.v3Runner.getSession(record.runtime.sessionId);
    if (!session) return;
    if (record.runtime.state === 'cleaned') return;
    if (session.state === 'paused' && record.runtime.state === 'running') {
      record.runtime.state = 'paused';
    } else if (session.state === 'running' && record.runtime.state === 'paused') {
      record.runtime.state = 'running';
    } else if (session.state === 'stopped' && (record.runtime.state === 'running' || record.runtime.state === 'paused' || record.runtime.state === 'created')) {
      record.runtime.state = 'stopped';
      if (record.runtime.endReason === undefined) record.runtime.endReason = 'stopped-by-user';
      if (record.runtime.endedAtMs === 0) record.runtime.endedAtMs = this.nowMs();
    } else if (session.state === 'expired' && !isSandboxV4RuntimeTerminal(record.runtime.state)) {
      record.runtime.state = 'expired';
      if (record.runtime.endReason === undefined) record.runtime.endReason = 'lifetime-cap';
      if (record.runtime.endedAtMs === 0) record.runtime.endedAtMs = this.nowMs();
    }
  }

  private summarizeRecord(record: RuntimeRecord): SandboxV4RuntimeSummary {
    const runtime = record.runtime;
    const live = runtime.processes.filter((p) => p.endedAtMs === 0).length;
    return {
      id: runtime.id,
      conversationId: runtime.conversationId,
      sessionId: runtime.sessionId,
      state: runtime.state,
      profileId: runtime.profileId,
      trust: runtime.trust,
      tier: runtime.tier,
      workdir: runtime.workdir,
      createdAtMs: runtime.createdAtMs,
      deadlineMs: runtime.deadlineMs,
      lastActivityAtMs: runtime.lastActivityAtMs,
      liveProcesses: live,
      totalProcesses: runtime.processes.length,
      ...(runtime.endReason !== undefined ? { endReason: runtime.endReason } : {}),
      endedAtMs: runtime.endedAtMs,
    };
  }
}

/** True when no further transition is possible from this state. */
export function isSandboxV4RuntimeTerminal(state: SandboxV4RuntimeState): boolean {
  return state === 'stopped' || state === 'expired' || state === 'cleaned';
}

/** States in which a runtime still accepts new steps. */
export function isSandboxV4RuntimeLive(state: SandboxV4RuntimeState): boolean {
  return state === 'created' || state === 'running';
}
