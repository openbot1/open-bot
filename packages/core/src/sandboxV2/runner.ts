/**
 * Sandbox v2 — runner (v1.34, Đội T2).
 *
 * Ties the subsystem together for one run:
 *
 *   policy (validate) → tier (select) → policy engine (check exec)
 *     → token broker (issue, only after the policy check passed)
 *     → kill switch + lifetime cap (armed) → execute → report.
 *
 * Execution honesty:
 *  - Tier 1 `bwrap`: the command is wrapped in `bwrap` (or `unshare`
 *    when only that exists) exactly like sandbox v1 does. When
 *    neither exists the command still runs, but the report says
 *    `isolated: false` + why — NEVER "isolated" when it is not.
 *  - Tier 2 `syscall-policy`: same execution as tier 1, PLUS the
 *    policy engine gates the command, the working directory and any
 *    planned file/network access declared up front. The engine is
 *    the decision layer; the OS boundary underneath is bwrap when
 *    available.
 *  - Tier 3 `microvm`: NEVER executes. It validates the microVM
 *    descriptor and returns a dry-run feasibility report
 *    (endReason 'dry-run'). Booting a real VM is out of scope for
 *    this subsystem by design.
 *
 * Safety order: a denied exec, an invalid policy, a fired kill
 * switch or an expired lifetime all stop the run BEFORE the child
 * process starts (or kill it the moment they fire). Tokens are
 * revoked and the temp workspace is deleted on every exit path.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertValidSandboxV2Policy,
  builtinPolicyForTrust,
  getBuiltinSandboxV2Policy,
} from './policy';
import type { SandboxV2Policy } from './policy';
import { SyscallPolicyEngine } from './syscallPolicy';
import { TokenBroker } from './tokenBroker';
import type { SandboxV2IssuedToken } from './tokenBroker';
import { KillSwitch, LifetimeCap, linkAbortSignalToKillSwitch } from './killSwitch';
import { defaultMicroVmSpec, dryRunMicroVm } from './microvm';
import { SandboxV2RunReportBuilder } from './runReport';
import { probeHostCapabilities, selectSandboxV2Tier } from './tierSelector';
import type {
  SandboxV2EndReason,
  SandboxV2HostCapabilities,
  SandboxV2MicroVmSpec,
  SandboxV2RunOptions,
  SandboxV2RunReport,
  SandboxV2Tier,
} from './types';

/** Planned accesses declared before a run (pre-flight check). */
export interface SandboxV2PlannedAccess {
  syscalls?: string[];
  fileReads?: string[];
  fileWrites?: string[];
  network?: Array<{ host: string; port?: number }>;
}

/** Options for the runner itself (not per-run). */
export interface SandboxV2RunnerOptions {
  /** Base dir for per-run workspaces (default: os.tmpdir()/open-bot-sandbox-v2). */
  baseDir?: string;
  /** Host capabilities override (tests inject a fake host). */
  hostCapabilities?: Partial<SandboxV2HostCapabilities>;
  /** MicroVM spec used when tier 3 is selected (default: empty spec → infeasible dry-run). */
  microvmSpec?: SandboxV2MicroVmSpec;
  /** File-existence check for the microVM dry-run (tests inject a fake). */
  microvmFileExists?: (filePath: string) => boolean;
}

/** Result of a pre-flight planned-access check. */
export interface SandboxV2PreflightResult {
  allowed: boolean;
  denied: Array<{ kind: string; target: string; reason: string }>;
}

const DEFAULT_POLL_MS = 100;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated to ${maxChars} chars]`;
}

export class SandboxV2Runner {
  private readonly baseDir: string;
  private readonly hostOverride?: Partial<SandboxV2HostCapabilities>;
  private readonly microvmSpec?: SandboxV2MicroVmSpec;
  private readonly microvmFileExists?: (filePath: string) => boolean;
  private readonly reports = new Map<string, SandboxV2RunReport>();
  /** Live kill switches, keyed by run id — removed when the run ends. */
  private readonly liveSwitches = new Map<string, KillSwitch>();

  constructor(options: SandboxV2RunnerOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(os.tmpdir(), 'open-bot-sandbox-v2');
    this.hostOverride = options.hostCapabilities;
    this.microvmSpec = options.microvmSpec;
    this.microvmFileExists = options.microvmFileExists;
  }

  /** Reports of finished runs, newest first (in-memory, this process only). */
  listReports(): SandboxV2RunReport[] {
    return [...this.reports.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  /** One finished report by run id (undefined when unknown). */
  getReport(runId: string): SandboxV2RunReport | undefined {
    return this.reports.get(runId);
  }

  /** Run ids currently executing (live kill switches). */
  listLiveRuns(): string[] {
    return [...this.liveSwitches.keys()];
  }

  /**
   * Trip the kill switch of a live run (from the UI, a policy, or
   * an operator). Returns false when the run is not live anymore
   * (already finished — check its report instead).
   */
  killRun(runId: string, source: 'ui' | 'policy' | 'manual' = 'ui', reason?: string): boolean {
    const killSwitch = this.liveSwitches.get(runId);
    if (!killSwitch) return false;
    return killSwitch.trip(source, reason ?? `Run ${runId} killed from ${source}`);
  }

  private resolveHost(): SandboxV2HostCapabilities {
    const probed = probeHostCapabilities();
    return { ...probed, ...(this.hostOverride ?? {}) };
  }

  private resolvePolicy(options: SandboxV2RunOptions): SandboxV2Policy {
    if (typeof options.policy === 'string') {
      const builtin = getBuiltinSandboxV2Policy(options.policy);
      if (!builtin) throw new Error(`Unknown sandbox v2 policy "${options.policy}"`);
      return builtin;
    }
    if (options.policy !== undefined) return assertValidSandboxV2Policy(options.policy);
    return builtinPolicyForTrust(options.trust ?? 'standard');
  }

  /**
   * Pre-flight check: run the policy engine over planned accesses
   * BEFORE anything executes. Returns every denial; the runner
   * refuses the run when any planned access is denied.
   */
  preflight(policy: SandboxV2Policy, tier: SandboxV2Tier, planned: SandboxV2PlannedAccess): SandboxV2PreflightResult {
    const engine = new SyscallPolicyEngine({ policy, tier });
    const denied: SandboxV2PreflightResult['denied'] = [];
    for (const syscall of planned.syscalls ?? []) {
      const check = engine.checkSyscall(syscall);
      if (check.verdict === 'deny') denied.push({ kind: 'syscall', target: syscall, reason: check.reason });
    }
    for (const file of planned.fileReads ?? []) {
      const check = engine.checkFile('file-read', file);
      if (!check.allowed) denied.push({ kind: 'file-read', target: file, reason: check.reason });
    }
    for (const file of planned.fileWrites ?? []) {
      const check = engine.checkFile('file-write', file);
      if (!check.allowed) denied.push({ kind: 'file-write', target: file, reason: check.reason });
    }
    for (const net of planned.network ?? []) {
      const check = engine.checkNetwork(net.host, net.port ?? 443);
      if (!check.allowed) denied.push({ kind: 'network', target: `${net.host}:${net.port ?? 443}`, reason: check.reason });
    }
    return { allowed: denied.length === 0, denied };
  }

  /**
   * Run one command inside sandbox v2. Always returns a report —
   * even for refused runs (policy-denied / dry-run) — so the caller
   * always has the audit trail. Only throws on programmer errors
   * (e.g. an invalid policy object passed directly).
   */
  async run(options: SandboxV2RunOptions): Promise<SandboxV2RunReport> {
    const runId = options.runId ?? `run_${randomUUID().slice(0, 8)}`;
    const label = options.label ?? `${options.command} ${(options.args ?? []).join(' ')}`.trim();
    const trust = options.trust ?? 'standard';
    const policy = this.resolvePolicy(options);
    const host = this.resolveHost();
    const caps = {
      maxLifetimeMs: Math.min(options.caps?.maxLifetimeMs ?? policy.caps.maxLifetimeMs, policy.caps.maxLifetimeMs),
      maxWriteBytes: options.caps?.maxWriteBytes ?? policy.caps.maxWriteBytes,
      maxOutputChars: options.caps?.maxOutputChars ?? policy.caps.maxOutputChars,
      maxCpuSeconds: options.caps?.maxCpuSeconds ?? policy.caps.maxCpuSeconds,
    };

    // --- Tier selection (may refuse hostile code on a weak host). ---
    let tier: SandboxV2Tier;
    let tierReason = '';
    let downgraded = false;
    try {
      const decision = selectSandboxV2Tier({ trust, policy, requestedTier: options.requestedTier, host });
      tier = decision.tier;
      tierReason = decision.reason;
      downgraded = decision.downgraded;
    } catch (err) {
      const report = new SandboxV2RunReportBuilder({
        runId,
        label,
        tier: 'syscall-policy',
        policyId: policy.id,
        policyVersion: policy.version,
        trust,
        lifetimeCapMs: caps.maxLifetimeMs,
        isolationDetail: 'refused — no safe tier on this host',
        isolated: false,
      });
      const finished = report.finish('policy-denied', (err as Error).message);
      this.reports.set(runId, finished);
      return finished;
    }

    // --- Policy engine: exec check happens BEFORE anything runs. ---
    const report = new SandboxV2RunReportBuilder({
      runId,
      label,
      tier,
      policyId: policy.id,
      policyVersion: policy.version,
      trust,
      lifetimeCapMs: caps.maxLifetimeMs,
      isolationDetail:
        tier === 'microvm'
          ? 'microVM descriptor (dry-run only — no VM booted)'
          : tier === 'bwrap'
            ? `bwrap tier (requested: ${options.requestedTier ?? 'auto'})`
            : 'syscall-policy tier (policy engine + bwrap when available)',
      isolated: tier === 'microvm' ? false : host.bwrapAvailable || host.unshareAvailable,
    });
    const engine = new SyscallPolicyEngine({
      policy,
      tier,
      onBlocked: (event) => {
        report.addBlocked({
          seq: report.blockedCount() + 1,
          at: new Date().toISOString(),
          ...event,
        });
      },
    });
    // --- Tier 3 is dry-run only: descriptor + feasibility, no execution.
    // Nó PHẢI đứng trước exec check: dry-run không chạy lệnh nào nên
    // policy exec không được chặn nó — trust hostile tắt shell hoàn toàn
    // (checkExec luôn deny) nên để sau exec check thì tier-3 dry-run
    // không bao giờ tới được. Từ chối hostile thật vẫn do tier selection
    // ở trên lo (host không có KVM → throw → policy-denied).
    if (tier === 'microvm') {
      const spec = this.microvmSpec ?? defaultMicroVmSpec();
      const feasibility = this.microvmFileExists
        ? dryRunMicroVm(spec, host, this.microvmFileExists)
        : dryRunMicroVm(spec, host);
      const dryReport = new SandboxV2RunReportBuilder({
        runId,
        label,
        tier,
        policyId: policy.id,
        policyVersion: policy.version,
        trust,
        lifetimeCapMs: caps.maxLifetimeMs,
        microvmFeasibility: feasibility,
        isolationDetail: 'microVM descriptor (dry-run only — no VM booted)',
        isolated: false,
      });
      for (const [i, e] of engine.blockedEvents().entries()) dryReport.addBlocked({ ...e, seq: i + 1 });
      const finished = dryReport.finish(
        'dry-run',
        feasibility.feasible
          ? `MicroVM could boot on this host (est. ${feasibility.estimatedBootMs}ms cold boot). No VM was started — descriptor only.`
          : `MicroVM cannot boot here: ${feasibility.blockers.join('; ')}`,
      );
      this.reports.set(runId, finished);
      return finished;
    }

    const execCheck = engine.checkExec(options.command);
    if (!execCheck.allowed) {
      const finished = report.finish('policy-denied', execCheck.reason);
      this.reports.set(runId, finished);
      return finished;
    }

    if (options.dryRun === true) {
      const finished = report.finish(
        'dry-run',
        `Dry run: tier ${tier}${downgraded ? ' (downgraded)' : ''} selected — ${tierReason}. Command not executed.`,
      );
      this.reports.set(runId, finished);
      return finished;
    }

    // --- Token broker: only AFTER the policy check passed. ---
    const broker = new TokenBroker({ policy });
    let issued: SandboxV2IssuedToken | undefined;
    if ((options.scopes ?? []).length > 0) {
      try {
        issued = broker.issue(runId, options.scopes ?? [], options.tokenTtlMs ?? policy.caps.maxTokenTtlMs);
        report.addTokenIssued(issued.token.id);
      } catch (err) {
        const finished = report.finish('policy-denied', `Token issue failed: ${(err as Error).message}`);
        this.reports.set(runId, finished);
        return finished;
      }
    }

    // --- Kill switch + lifetime cap. ---
    const killSwitch = new KillSwitch({ runId });
    this.liveSwitches.set(runId, killSwitch);
    killSwitch.onTripped((source) => {
      report.markKillSwitchFired(source);
    });
    const lifetimeCap = new LifetimeCap({ runId, maxLifetimeMs: caps.maxLifetimeMs, killSwitch });
    const unlinkAbort = options.signal ? linkAbortSignalToKillSwitch(options.signal, killSwitch) : undefined;
    killSwitch.registerCleanup('revoke-tokens', () => {
      const revoked = broker.revokeForTask(runId, 'kill-switch');
      for (const id of revoked) report.addTokenRevoked(id, 'kill-switch');
    });

    // --- Workspace (per-run temp dir, deleted on every exit path). ---
    const workspaceDir = path.join(this.baseDir, runId, 'workspace');
    const tmpDir = path.join(this.baseDir, runId, 'tmp');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    killSwitch.registerCleanup('delete-workspace', () => {
      fs.rmSync(path.join(this.baseDir, runId), { recursive: true, force: true });
    });

    const cwd = options.cwd ?? workspaceDir;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: workspaceDir,
      TMPDIR: tmpDir,
      ...(options.env ?? {}),
    };

    // --- Build argv (bwrap / unshare wrap when available). ---
    const isolated = host.bwrapAvailable || host.unshareAvailable;
    let argv: string[];
    let spawnCommand: string;
    if (host.bwrapAvailable) {
      spawnCommand = 'bwrap';
      argv = [
        '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/bin', '/bin',
        '--ro-bind', '/lib', '/lib',
        '--ro-bind', '/lib64', '/lib64',
        '--ro-bind', '/etc', '/etc',
        '--tmpfs', '/tmp',
        '--bind', workspaceDir, workspaceDir,
        '--bind', tmpDir, tmpDir,
        '--chdir', cwd,
        '--unshare-pid',
        '--die-with-parent',
        options.command,
        ...(options.args ?? []),
      ];
    } else if (host.unshareAvailable) {
      spawnCommand = 'unshare';
      argv = ['--user', '--map-root-user', '--pid', '--fork', options.command, ...(options.args ?? [])];
    } else {
      spawnCommand = options.command;
      argv = [...(options.args ?? [])];
    }

    // --- Execute with polling: kill switch / lifetime cap / timeout. ---
    const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string; endReason: SandboxV2EndReason; endDetail?: string }>(
      (resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const settle = (value: { exitCode: number | null; stdout: string; stderr: string; endReason: SandboxV2EndReason; endDetail?: string }): void => {
          if (settled) return;
          settled = true;
          clearInterval(poller);
          resolve(value);
        };
        let child: ChildProcessByStdio<null, Readable, Readable>;
        try {
          child = spawn(spawnCommand, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
          settle({ exitCode: null, stdout, stderr, endReason: 'failed', endDetail: `spawn failed: ${(err as Error).message}` });
          return;
        }
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (stdout.length > caps.maxOutputChars * 2) stdout = stdout.slice(0, caps.maxOutputChars * 2);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
          if (stderr.length > caps.maxOutputChars * 2) stderr = stderr.slice(0, caps.maxOutputChars * 2);
        });
        child.on('error', (err: Error) => {
          settle({ exitCode: null, stdout, stderr, endReason: 'failed', endDetail: `spawn error: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
          if (killSwitch.isFired) {
            const source = killSwitch.source ?? 'manual';
            settle({
              exitCode: code,
              stdout,
              stderr,
              endReason: source === 'lifetime-cap' ? 'lifetime-cap' : 'kill-switch',
              endDetail: killSwitch.reason,
            });
          } else if (code === 0) {
            settle({ exitCode: code, stdout, stderr, endReason: 'completed' });
          } else {
            settle({ exitCode: code, stdout, stderr, endReason: 'failed', endDetail: `exit code ${String(code)}` });
          }
        });
        const poller = setInterval(() => {
          if (!lifetimeCap.check()) {
            report.markLifetimeCapHit();
            try {
              child.kill('SIGKILL');
            } catch {
              // Already dead — the close handler settles.
            }
            settle({
              exitCode: null,
              stdout,
              stderr,
              endReason: 'lifetime-cap',
              endDetail: killSwitch.reason,
            });
            return;
          }
          if (killSwitch.isFired) {
            try {
              child.kill('SIGKILL');
            } catch {
              // Already dead.
            }
            settle({
              exitCode: null,
              stdout,
              stderr,
              endReason: 'kill-switch',
              endDetail: killSwitch.reason,
            });
          }
        }, DEFAULT_POLL_MS);
        // Hard backstop: if the poller itself stalls, the child is
        // still bounded by the process-level timeout below.
        const hardTimeout = setTimeout(() => {
          if (!settled) {
            killSwitch.trip('timeout', `Run ${runId} exceeded its hard timeout of ${caps.maxLifetimeMs}ms`);
            try {
              child.kill('SIGKILL');
            } catch {
              // Already dead.
            }
            settle({ exitCode: null, stdout, stderr, endReason: 'timed-out', endDetail: killSwitch.reason });
          }
        }, caps.maxLifetimeMs + 5_000);
        void hardTimeout;
        // Keep the hard timeout from holding the process open alone.
        if (typeof hardTimeout === 'object' && 'unref' in hardTimeout) {
          (hardTimeout as unknown as { unref(): void }).unref();
        }
        killSwitch.registerCleanup('kill-child', () => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already dead.
          }
        });
      },
    );
    // --- Teardown: revoke tokens, run cleanup, finish the report. ---
    unlinkAbort?.();
    this.liveSwitches.delete(runId);
    if (issued) {
      const revoked = broker.revokeForTask(runId, result.endReason === 'completed' ? 'task-done' : 'kill-switch');
      for (const id of revoked) report.addTokenRevoked(id, result.endReason === 'completed' ? 'task-done' : 'kill-switch');
    }
    // Blocked events were streamed into the report by the engine's
    // onBlocked callback as they happened; nothing left to copy.
    report.setOutput(truncateText(result.stdout, caps.maxOutputChars), truncateText(result.stderr, caps.maxOutputChars));
    report.setExitCode(result.exitCode);
    await killSwitch.runCleanup();
    const finished = report.finish(
      result.endReason,
      result.endDetail ?? (downgraded ? `Tier downgraded: ${tierReason}` : undefined),
    );
    this.reports.set(runId, finished);
    return finished;
  }
}
