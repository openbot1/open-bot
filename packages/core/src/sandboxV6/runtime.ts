/**
 * Sandbox v6 — per-bot runtime manager (v1.38, Team T3).
 *
 * One live runtime per bot. A runtime owns four things that
 * are all keyed by the same bot id, so nothing can leak
 * across bots:
 *
 *  1. a BotBox workspace (`sandbox/box.ts`) — the bot's own
 *     directory + bwrap/unshare isolation + prlimit fallback;
 *  2. a cgroup v2 enforcer (`cgroupEnforcer.ts`) — real CPU /
 *     RAM / process caps, attached to every spawned process
 *     through the box manager's `onSpawn` hook;
 *  3. an exec audit logger (`execAudit.ts`) — every exec,
 *     refusal and quota event, hash-chained;
 *  4. a secret store (`secretScope.ts`) — this bot's secrets
 *     only, readable only by this bot.
 *
 * Exec flow (`exec()`):
 *
 *  - the runtime must be `running` (created runtimes start
 *    running; paused / stopped / destroyed refuse);
 *  - the disk gate runs first: an over-quota workspace refuses
 *    the exec before anything spawns, and the refusal is
 *    audited;
 *  - the command is audited as `exec-start`, then spawned in
 *    the box; the spawn hook moves the child into the bot's
 *    cgroup (best-effort — a hook failure is warned, not fatal,
 *    because the box's own prlimit still applies);
 *  - on finish the result is audited as `exec-finish`
 *    (or `exec-timeout` when the box killed it for time).
 *    stdout/stderr excerpts are scrubbed of secret values
 *    before they reach the log.
 *
 * Quota changes (`setQuota()`) rewrite the cgroup limits live
 * and are audited. A cgroup that cannot be created (no
 * delegation on this machine) does NOT block the runtime:
 * the runtime runs with `enforcement: 'prlimit'` and says so
 * in every summary — but a cgroup that *was* created and
 * then fails a limit write DOES block the quota change
 * (fail-closed: never run under a cap that is not there).
 *
 * Lifecycle: `stop()` refuses new execs but keeps the box,
 * cgroup and secrets (a stopped bot can be resumed); `destroy()`
 * removes the box workspace, the cgroup and the bot's secrets,
 * and audits `runtime-destroyed`. The audit log survives
 * destruction — deleting the record of what a bot did would
 * defeat the audit. `sweepIdle()` stops runtimes past their
 * idle timeout and destroys runtimes past their lifetime cap.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotBoxManager } from '../sandbox/box';
import type { BotBox, IsolationKind } from '../sandbox/types';
import { probeSandboxV6Cgroup, SandboxV6CgroupEnforcer, sandboxV6CgroupName } from './cgroupEnforcer';
import { verifySandboxV6Enforcement, type SandboxV6EnforcementStatus } from './enforcementStatus';
import { SandboxV6AuditLogger } from './execAudit';
import { enforceDiskQuotaBeforeExec, measureWorkspace } from './diskQuota';
import { SandboxV6SecretStore } from './secretScope';
import {
  SANDBOX_V6_DEFAULT_QUOTA,
  SANDBOX_V6_QUOTA_PRESETS,
  formatSandboxV6Bytes,
  resolveSandboxV6Quota,
  sandboxV6BotIdError,
  type SandboxV6AuditSummary,
  type SandboxV6BotRuntime,
  type SandboxV6CgroupProbe,
  type SandboxV6DiskCheck,
  type SandboxV6EnforcementMode,
  type SandboxV6ExecResult,
  type SandboxV6Quota,
  type SandboxV6QuotaPresetName,
  type SandboxV6ResolvedQuota,
  type SandboxV6RuntimeStopReason,
  type SandboxV6RuntimeSummary,
  type SandboxV6Usage,
} from './types';

/** Default base dir: OS temp dir / open-bot-sandbox-v6. */
export function defaultSandboxV6BaseDir(): string {
  return path.join(fs.realpathSync(os.tmpdir()), 'open-bot-sandbox-v6');
}

export interface CreateSandboxV6RuntimeOptions {
  /** Quota (partial — missing fields take the default preset). */
  quota?: SandboxV6Quota;
  /** Named preset (ignored when `quota` is given). */
  preset?: SandboxV6QuotaPresetName;
  /** Hard lifetime cap in ms (0 = none). */
  lifetimeMs?: number;
  /** Env var names the bot's box may pass through (in addition to the safe defaults). */
  envAllowlist?: string[];
}

export interface SandboxV6ExecOptions {
  /** Extra env values for this exec (names must be in the box allow-list). */
  envValues?: Record<string, string>;
  /** Secret values to inject as env AND to scrub from the audit log. */
  secrets?: Record<string, string>;
  /** Stdin for the process. */
  stdin?: string;
  /** Timeout override for this exec (ms). */
  timeoutMs?: number;
  /** Isolation backend override. */
  isolation?: 'auto' | IsolationKind;
}

export interface SandboxV6RuntimeManagerOptions {
  /** Base dir for runtimes (default: OS temp / open-bot-sandbox-v6). */
  baseDir?: string;
  /** cgroup root (default /sys/fs/cgroup; tests pass a temp dir). */
  cgroupRoot?: string;
  /** Idle timeout for runtimes in ms (default 30 minutes, 0 = never). */
  idleTimeoutMs?: number;
  /** Default lifetime cap for runtimes in ms (default 0 = none). */
  defaultLifetimeMs?: number;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
  logger?: { warn(message: string): void };
}

interface RuntimeRecord {
  runtime: SandboxV6BotRuntime;
  box: BotBox;
  enforcer: SandboxV6CgroupEnforcer | null;
  audit: SandboxV6AuditLogger;
  secrets: SandboxV6SecretStore;
}

function isLiveRuntimeState(state: string): boolean {
  return state === 'created' || state === 'running';
}

export class SandboxV6RuntimeManager {
  readonly baseDir: string;
  private readonly boxes: BotBoxManager;
  private readonly cgroupRoot?: string;
  private readonly idleTimeoutMs: number;
  private readonly defaultLifetimeMs: number;
  private readonly nowMs: () => number;
  private readonly warn: (message: string) => void;
  private readonly probe: SandboxV6CgroupProbe;
  private readonly records = new Map<string, RuntimeRecord>();

  constructor(options: SandboxV6RuntimeManagerOptions = {}) {
    this.baseDir = options.baseDir ?? defaultSandboxV6BaseDir();
    this.cgroupRoot = options.cgroupRoot;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
    this.defaultLifetimeMs = options.defaultLifetimeMs ?? 0;
    this.nowMs = options.nowMs ?? Date.now;
    this.warn = options.logger ? (m) => options.logger?.warn(m) : () => undefined;
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.boxes = new BotBoxManager({
      rootDir: path.join(this.baseDir, 'boxes-root'),
      logger: options.logger,
    });
    // One dispatch hook for all bots (BotBoxManager holds a
    // single hook — installing one per bot would overwrite the
    // previous bot's). It routes by bot id to that bot's
    // enforcer, so every spawned process joins its own bot's
    // cgroup (children inherit it on fork).
    this.boxes.setSpawnHook((hookBotId, child) => {
      const record = this.records.get(hookBotId);
      if (record === undefined || record.enforcer === null || child.pid === undefined) return;
      try {
        record.enforcer.addPid(child.pid);
      } catch (err) {
        this.warn(
          `sandbox-v6: could not move pid ${child.pid} into cgroup ${record.enforcer.name}: ${(err as Error).message}`,
        );
      }
    });
    // Probe once: the result decides the enforcement mode for
    // every runtime this manager creates.
    this.probe = probeSandboxV6Cgroup(
      this.cgroupRoot !== undefined ? { cgroupRoot: this.cgroupRoot } : {},
    );
    if (!this.probe.available) {
      this.warn(
        `sandbox-v6: cgroup v2 enforcement unavailable — ${this.probe.reason ?? 'unknown reason'} ` +
          `(falling back to prlimit + measurement).`,
      );
    }
  }

  /** cgroup probe result (shared by all runtimes of this manager). */
  cgroupProbe(): SandboxV6CgroupProbe {
    return { ...this.probe };
  }

  /** Create (or return the existing live) runtime for a bot. Idempotent per bot. */
  create(botId: string, options: CreateSandboxV6RuntimeOptions = {}): SandboxV6RuntimeSummary {
    const botErr = sandboxV6BotIdError(botId);
    if (botErr !== '') throw new Error(botErr);
    const existing = this.records.get(botId);
    if (existing !== undefined && isLiveRuntimeState(existing.runtime.state)) {
      return this.summaryOf(existing, null);
    }
    // Re-creating after stop/destroy: drop the old enforcer so
    // its cgroup does not leak (the audit log + secrets on disk
    // are reloaded by the new logger/store below).
    if (existing !== undefined && existing.enforcer !== null) {
      existing.enforcer.destroy();
      existing.enforcer = null;
    }
    const quota = options.quota !== undefined
      ? resolveSandboxV6Quota(options.quota)
      : { ...(options.preset !== undefined ? SANDBOX_V6_QUOTA_PRESETS[options.preset] : SANDBOX_V6_DEFAULT_QUOTA) };
    const now = this.nowMs();
    const lifetimeMs = options.lifetimeMs ?? this.defaultLifetimeMs;
    const runtimeId = crypto.randomUUID();

    const box = this.boxes.createBox(botId, {
      ...(options.envAllowlist !== undefined ? { envAllowlist: options.envAllowlist } : {}),
      limits: {
        timeoutMs: quota.maxExecMs > 0 ? quota.maxExecMs : undefined,
        maxWriteBytes: quota.maxWriteBytes > 0 ? quota.maxWriteBytes : undefined,
        maxProcesses: quota.maxProcesses > 0 ? quota.maxProcesses : undefined,
        maxMemoryBytes: quota.memoryBytes > 0 ? quota.memoryBytes : undefined,
      },
    });

    const botDir = path.join(this.baseDir, 'bots', botId);
    fs.mkdirSync(botDir, { recursive: true });
    const audit = new SandboxV6AuditLogger({ dir: path.join(botDir, 'audit'), botId, nowMs: this.nowMs });
    const secrets = new SandboxV6SecretStore({
      dir: path.join(botDir, 'secrets'),
      botId,
      nowMs: this.nowMs,
      onAccessDenied: (info) => {
        audit.record({
          runtimeId,
          kind: 'secret-access-denied',
          detail: `Bot "${info.callerBotId}" tried to read secret "${info.name}" owned by "${info.ownerBotId}": ${info.reason}`,
        });
      },
    });

    // Attach every secret value this bot already owns to the
    // scrubber, so a value echoed by any command is redacted.
    for (const value of secrets.valuesForScrubbing()) audit.registerSecret(value);

    // cgroup: create when the probe says we can, otherwise run
    // degraded (prlimit) and say so. A create failure here is
    // NOT fatal: the box still isolates, prlimit still caps.
    let enforcer: SandboxV6CgroupEnforcer | null = null;
    let enforcement: SandboxV6EnforcementMode = 'prlimit';
    let enforcementReason = this.probe.reason;
    let cgroupName = '';
    if (this.probe.available && process.platform === 'linux') {
      cgroupName = sandboxV6CgroupName(botId, runtimeId);
      const candidate = new SandboxV6CgroupEnforcer({
        ...(this.cgroupRoot !== undefined ? { cgroupRoot: this.cgroupRoot } : {}),
        name: cgroupName,
        logger: { warn: this.warn },
      });
      try {
        const { applied, skipped } = candidate.create(quota);
        enforcer = candidate;
        enforcement = skipped.length === 0 || applied.length > 0 ? 'cgroup' : 'prlimit';
        if (skipped.length > 0) {
          enforcementReason = `cgroup controllers skipped: ${skipped.join(', ')} (applied: ${applied.join(', ') || 'none'})`;
        } else {
          enforcementReason = undefined;
        }
      } catch (err) {
        audit.record({
          runtimeId,
          kind: 'cgroup-failed',
          detail: `Could not create cgroup ${cgroupName}: ${(err as Error).message} — running with prlimit only.`,
        });
        this.warn(`sandbox-v6: cgroup create failed for bot ${botId}: ${(err as Error).message}`);
        enforcement = 'prlimit';
        enforcementReason = `cgroup create failed: ${(err as Error).message}`;
        cgroupName = '';
      }
    } else if (process.platform !== 'linux') {
      enforcement = 'none';
      enforcementReason = `cgroup v2 needs Linux (this platform: ${process.platform}).`;
    }

    const runtime: SandboxV6BotRuntime = {
      id: runtimeId,
      botId,
      state: 'running',
      quota,
      enforcement,
      ...(enforcementReason !== undefined ? { enforcementReason } : {}),
      workdir: box.workspaceDir,
      cgroupName,
      createdAtMs: now,
      lastActivityMs: now,
      deadlineMs: lifetimeMs > 0 ? now + lifetimeMs : 0,
      endedAtMs: 0,
      execCount: 0,
      refusedCount: 0,
    };
    const record: RuntimeRecord = { runtime, box, enforcer, audit, secrets };
    this.records.set(botId, record);

    audit.record({
      runtimeId,
      kind: 'runtime-created',
      enforcement,
      detail:
        `Runtime created for bot "${botId}" (quota: CPU ${quota.cpuPercent}%, ` +
        `RAM ${formatSandboxV6Bytes(quota.memoryBytes)}, disk ${formatSandboxV6Bytes(quota.diskBytes)}; ` +
        `enforcement: ${enforcement}${enforcementReason !== undefined ? ` — ${enforcementReason}` : ''}).`,
    });
    return this.summaryOf(record, null);
  }

  /** Live runtime for a bot (undefined when none / destroyed). */
  get(botId: string): SandboxV6RuntimeSummary | undefined {
    const record = this.records.get(botId);
    if (record === undefined) return undefined;
    return this.summaryOf(record, null);
  }

  /** Runtime by id (any state). */
  getById(runtimeId: string): SandboxV6RuntimeSummary | undefined {
    for (const record of this.records.values()) {
      if (record.runtime.id === runtimeId) return this.summaryOf(record, null);
    }
    return undefined;
  }

  /** All runtimes (live first, then stopped/destroyed). */
  list(): SandboxV6RuntimeSummary[] {
    const out = [...this.records.values()].map((r) => this.summaryOf(r, null));
    out.sort((a, b) => {
      const live = (s: string): number => (isLiveRuntimeState(s) ? 0 : 1);
      return live(a.state) - live(b.state) || b.lastActivityMs - a.lastActivityMs;
    });
    return out;
  }

  /** Audit logger for a bot (throws when the bot has no runtime). */
  auditLogger(botId: string): SandboxV6AuditLogger {
    return this.requireRecord(botId).audit;
  }

  /** Secret store for a bot (throws when the bot has no runtime). */
  secretStore(botId: string): SandboxV6SecretStore {
    return this.requireRecord(botId).secrets;
  }

  /** Change a live bot's quota (rewrites the cgroup limits live). Audited. */
  setQuota(botId: string, quotaInput: SandboxV6Quota): SandboxV6RuntimeSummary {
    const record = this.requireRecord(botId);
    const runtime = record.runtime;
    if (!isLiveRuntimeState(runtime.state)) {
      throw new Error(`Cannot change quota: runtime for bot "${botId}" is ${runtime.state}.`);
    }
    const quota = resolveSandboxV6Quota(quotaInput);
    // Fail-closed: a cgroup limit that cannot be written blocks
    // the change — the bot must not run under a cap that is not there.
    if (record.enforcer !== null) {
      record.enforcer.setQuota(quota);
    }
    const old = runtime.quota;
    runtime.quota = quota;
    runtime.lastActivityMs = this.nowMs();
    record.audit.record({
      runtimeId: runtime.id,
      kind: 'quota-changed',
      enforcement: runtime.enforcement,
      detail:
        `Quota changed for bot "${botId}": CPU ${old.cpuPercent}% -> ${quota.cpuPercent}%, ` +
        `RAM ${formatSandboxV6Bytes(old.memoryBytes)} -> ${formatSandboxV6Bytes(quota.memoryBytes)}, ` +
        `disk ${formatSandboxV6Bytes(old.diskBytes)} -> ${formatSandboxV6Bytes(quota.diskBytes)}.`,
    });
    return this.summaryOf(record, null);
  }

  /** Live usage of a bot runtime (cgroup stats + disk measurement). */
  getUsage(botId: string): SandboxV6Usage {
    return this.readUsage(this.requireRecord(botId));
  }

  /** Disk quota check for a bot runtime. */
  checkDisk(botId: string): SandboxV6DiskCheck {
    const record = this.requireRecord(botId);
    const measured = measureWorkspace(record.box.workspaceDir);
    const quota = record.runtime.quota.diskBytes;
    const ratio = quota > 0 ? measured.bytes / quota : 0;
    return {
      usedBytes: measured.bytes,
      quotaBytes: quota,
      files: measured.files,
      overQuota: quota > 0 && measured.bytes >= quota,
      nearQuota: quota > 0 && ratio >= 0.9 && measured.bytes < quota,
      ratio,
    };
  }

  /**
   * Verify a bot's live cgroup files against its quota (drift
   * detection). Returns the verdict; never throws for an
   * unreadable tree.
   */
  verifyEnforcement(botId: string): SandboxV6EnforcementStatus {
    const record = this.requireRecord(botId);
    const runtime = record.runtime;
    return verifySandboxV6Enforcement(
      botId,
      runtime.id,
      runtime.enforcement,
      record.enforcer !== null ? record.enforcer.dir : null,
      runtime.quota,
      this.nowMs,
    );
  }

  /** Verify enforcement for every runtime the manager knows. */
  verifyAllEnforcement(): SandboxV6EnforcementStatus[] {
    return [...this.records.keys()].map((botId) => this.verifyEnforcement(botId));
  }

  /**
   * Run a command in a bot's runtime. Audited start-to-finish.
   * Refuses (audited, no spawn) when the runtime is not
   * running or the disk quota is already blown.
   */
  async exec(
    botId: string,
    command: string,
    args: string[] = [],
    opts: SandboxV6ExecOptions = {},
  ): Promise<SandboxV6ExecResult> {
    const record = this.requireRecord(botId);
    const runtime = record.runtime;
    const startedAtMs = this.nowMs();
    const refuse = (kind: 'exec-refused', reason: string): Promise<SandboxV6ExecResult> => {
      runtime.refusedCount += 1;
      const entry = record.audit.record({
        runtimeId: runtime.id,
        kind,
        command,
        args,
        startedAtMs,
        durationMs: 0,
        enforcement: runtime.enforcement,
        detail: reason,
      });
      return Promise.resolve({
        auditId: entry.id,
        botId,
        runtimeId: runtime.id,
        command,
        args: [...args],
        exitCode: null,
        signal: null,
        timedOut: false,
        writeCapExceeded: false,
        stdout: '',
        stderr: '',
        durationMs: 0,
        workspaceBytes: measureWorkspace(record.box.workspaceDir).bytes,
        enforcement: runtime.enforcement,
        isolation: '',
        startedAtMs,
      });
    };

    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('exec: command must be a non-empty string.');
    }
    if (runtime.state !== 'running') {
      return refuse('exec-refused', `Runtime for bot "${botId}" is ${runtime.state} — cannot run commands.`);
    }
    if (runtime.deadlineMs > 0 && startedAtMs >= runtime.deadlineMs) {
      this.stop(botId, 'lifetime-cap');
      return refuse('exec-refused', `Runtime for bot "${botId}" passed its lifetime cap.`);
    }

    // Disk gate before anything spawns.
    const gate = enforceDiskQuotaBeforeExec(record.box.workspaceDir, runtime.quota.diskBytes);
    if (!gate.allowed) {
      record.audit.record({
        runtimeId: runtime.id,
        kind: 'disk-quota-exceeded',
        command,
        args,
        startedAtMs,
        enforcement: runtime.enforcement,
        detail: gate.reason ?? 'Disk quota exceeded.',
      });
      return refuse('exec-refused', gate.reason ?? 'Disk quota exceeded.');
    }

    // Secrets injected for this exec are scrubbed from the log.
    const secretValues: Record<string, string> = { ...(opts.secrets ?? {}) };
    for (const value of Object.values(secretValues)) record.audit.registerSecret(value);
    const envValues: Record<string, string> = { ...(opts.envValues ?? {}), ...secretValues };

    const startEntry = record.audit.record({
      runtimeId: runtime.id,
      kind: 'exec-start',
      command,
      args,
      startedAtMs,
      enforcement: runtime.enforcement,
      detail: `exec started in box ${record.box.id}`,
    });

    const runStarted = Date.now();
    const boxResult = await this.boxes.runInBox(botId, command, args, {
      ...(Object.keys(envValues).length > 0 ? { vaultSecrets: envValues } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.isolation !== undefined ? { isolation: opts.isolation } : {}),
    });
    const durationMs = Date.now() - runStarted;

    runtime.execCount += 1;
    runtime.lastActivityMs = this.nowMs();
    const workspaceBytes = measureWorkspace(record.box.workspaceDir).bytes;

    const finishKind = boxResult.timedOut ? 'exec-timeout' : 'exec-finish';
    const finishEntry = record.audit.record({
      runtimeId: runtime.id,
      kind: finishKind,
      command,
      args,
      startedAtMs,
      durationMs,
      exitCode: boxResult.exitCode,
      signal: boxResult.signal,
      timedOut: boxResult.timedOut,
      enforcement: runtime.enforcement,
      isolation: boxResult.isolation.kind,
      detail:
        `exit=${boxResult.exitCode ?? 'null'} signal=${boxResult.signal ?? 'none'} ` +
        `timedOut=${boxResult.timedOut} writeCapExceeded=${boxResult.writeCapExceeded} ` +
        `stdout=${record.audit.scrub(boxResult.stdout.slice(0, 500))} ` +
        `stderr=${record.audit.scrub(boxResult.stderr.slice(0, 500))}`,
    });
    void startEntry;
    void finishEntry;

    // Disk quota crossed *by* this exec: warn in the audit, stop
    // the runtime when it blew past the cap hard (>= 110%).
    const after = this.checkDisk(botId);
    if (after.overQuota) {
      record.audit.record({
        runtimeId: runtime.id,
        kind: 'disk-quota-exceeded',
        command,
        args,
        startedAtMs,
        durationMs,
        enforcement: runtime.enforcement,
        detail: `Workspace now uses ${after.usedBytes} bytes (quota ${after.quotaBytes}) after this exec.`,
      });
    }

    return {
      auditId: finishEntry.id,
      botId,
      runtimeId: runtime.id,
      command,
      args: [...args],
      exitCode: boxResult.exitCode,
      signal: boxResult.signal,
      timedOut: boxResult.timedOut,
      writeCapExceeded: boxResult.writeCapExceeded,
      // The RESULT goes back to the calling bot (the secret
      // owner) unscrubbed — it needs its own command output.
      // Only the AUDIT LOG is scrubbed (see the finish entry
      // above, whose excerpts pass through the scrubber).
      stdout: boxResult.stdout,
      stderr: boxResult.stderr,
      durationMs,
      workspaceBytes,
      enforcement: runtime.enforcement,
      isolation: boxResult.isolation.kind,
      startedAtMs,
    };
  }

  /** Pause a live runtime (refuses new execs until resumed). */
  pause(botId: string): SandboxV6RuntimeSummary {
    const record = this.requireRecord(botId);
    if (record.runtime.state !== 'running') {
      throw new Error(`Cannot pause: runtime for bot "${botId}" is ${record.runtime.state}.`);
    }
    record.runtime.state = 'paused';
    record.runtime.lastActivityMs = this.nowMs();
    return this.summaryOf(record, null);
  }

  /** Resume a paused runtime. */
  resume(botId: string): SandboxV6RuntimeSummary {
    const record = this.requireRecord(botId);
    if (record.runtime.state !== 'paused') {
      throw new Error(`Cannot resume: runtime for bot "${botId}" is ${record.runtime.state}.`);
    }
    record.runtime.state = 'running';
    record.runtime.lastActivityMs = this.nowMs();
    return this.summaryOf(record, null);
  }

  /** Stop a runtime (keeps box, cgroup, secrets; refuses new execs). */
  stop(botId: string, reason: SandboxV6RuntimeStopReason = 'stopped-by-user'): SandboxV6RuntimeSummary {
    const record = this.requireRecord(botId);
    const runtime = record.runtime;
    if (runtime.state === 'destroyed') {
      throw new Error(`Cannot stop: runtime for bot "${botId}" is already destroyed.`);
    }
    if (runtime.state === 'stopped') return this.summaryOf(record, null);
    runtime.state = 'stopped';
    runtime.stopReason = reason;
    runtime.endedAtMs = this.nowMs();
    record.audit.record({
      runtimeId: runtime.id,
      kind: 'runtime-stopped',
      enforcement: runtime.enforcement,
      detail: `Runtime stopped for bot "${botId}" (reason: ${reason}).`,
    });
    return this.summaryOf(record, null);
  }

  /**
   * Destroy a runtime: box workspace, cgroup and the bot's
   * secrets are removed. The audit log is kept (deleting the
   * record of what a bot did would defeat the audit).
   */
  destroy(botId: string): SandboxV6RuntimeSummary {
    const record = this.requireRecord(botId);
    const runtime = record.runtime;
    if (runtime.state === 'destroyed') return this.summaryOf(record, null);
    const purgedSecrets = record.secrets.purge();
    if (record.enforcer !== null) {
      record.enforcer.destroy();
      record.enforcer = null;
    }
    // Remove the box workspace (best-effort — a missing box is fine).
    try {
      fs.rmSync(record.box.dir, { recursive: true, force: true });
    } catch (err) {
      this.warn(`sandbox-v6: could not remove box dir for bot ${botId}: ${(err as Error).message}`);
    }
    runtime.state = 'destroyed';
    runtime.stopReason = runtime.stopReason ?? 'completed';
    runtime.endedAtMs = this.nowMs();
    runtime.cgroupName = '';
    record.audit.record({
      runtimeId: runtime.id,
      kind: 'runtime-destroyed',
      enforcement: runtime.enforcement,
      detail: `Runtime destroyed for bot "${botId}" (box + cgroup removed, ${purgedSecrets} secret(s) purged, audit log kept).`,
    });
    return this.summaryOf(record, null);
  }

  /**
   * Heartbeat: refresh last-activity so an active bot is not
   * swept as idle. Returns false when the bot has no runtime.
   */
  heartbeat(botId: string): boolean {
    const record = this.records.get(botId);
    if (record === undefined) return false;
    record.runtime.lastActivityMs = this.nowMs();
    return true;
  }

  /**
   * Sweep idle / expired runtimes. Stops runtimes idle past
   * the idle timeout; destroys runtimes past their lifetime
   * cap. Returns the bot ids that were stopped / destroyed.
   */
  sweepIdle(): { stopped: string[]; destroyed: string[] } {
    const now = this.nowMs();
    const stopped: string[] = [];
    const destroyed: string[] = [];
    for (const [botId, record] of this.records) {
      const runtime = record.runtime;
      if (runtime.state === 'destroyed') continue;
      if (runtime.deadlineMs > 0 && now >= runtime.deadlineMs && runtime.state === 'running') {
        this.stop(botId, 'lifetime-cap');
        destroyed.push(botId);
        this.destroy(botId);
        continue;
      }
      if (
        this.idleTimeoutMs > 0 &&
        runtime.state === 'running' &&
        now - runtime.lastActivityMs >= this.idleTimeoutMs
      ) {
        this.stop(botId, 'idle-timeout');
        stopped.push(botId);
      }
    }
    return { stopped, destroyed };
  }

  /** Audit summary for a bot. */
  auditSummary(botId: string): SandboxV6AuditSummary {
    return this.requireRecord(botId).audit.summarize();
  }

  private requireRecord(botId: string): RuntimeRecord {
    const record = this.records.get(botId);
    if (record === undefined) {
      throw new Error(`Unknown bot runtime "${botId}": create it first with sandbox_v6_runtime_create.`);
    }
    return record;
  }

  private readUsage(record: RuntimeRecord): SandboxV6Usage {
    const now = this.nowMs();
    const disk = measureWorkspace(record.box.workspaceDir);
    const usage: SandboxV6Usage = {
      cpuTimeUsec: null,
      memoryCurrentBytes: null,
      memoryPeakBytes: null,
      processCount: null,
      diskBytes: disk.bytes,
      diskFiles: disk.files,
      readAtMs: now,
    };
    if (record.enforcer !== null) {
      const live = record.enforcer.readUsage();
      usage.cpuTimeUsec = live.cpuTimeUsec;
      usage.memoryCurrentBytes = live.memoryCurrentBytes;
      usage.memoryPeakBytes = live.memoryPeakBytes;
      usage.processCount = live.processCount;
    }
    return usage;
  }

  private summaryOf(record: RuntimeRecord, usage: SandboxV6Usage | null): SandboxV6RuntimeSummary {
    const r = record.runtime;
    return {
      id: r.id,
      botId: r.botId,
      state: r.state,
      quota: { ...r.quota },
      enforcement: r.enforcement,
      ...(r.enforcementReason !== undefined ? { enforcementReason: r.enforcementReason } : {}),
      workdir: r.workdir,
      cgroupName: r.cgroupName,
      createdAtMs: r.createdAtMs,
      lastActivityMs: r.lastActivityMs,
      deadlineMs: r.deadlineMs,
      endedAtMs: r.endedAtMs,
      ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
      execCount: r.execCount,
      refusedCount: r.refusedCount,
      usage,
    };
  }
}
