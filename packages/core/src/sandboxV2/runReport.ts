/**
 * Sandbox v2 — per-run isolation report (v1.34, Đội T2).
 *
 * One report per run. It answers, in one place:
 *  - which tier ran the code, and which policy (id + version),
 *  - what was blocked (syscall / file / network / exec, with reason),
 *  - which credentials were issued and revoked (ids only — never secrets),
 *  - how long the run lived, whether the lifetime cap fired, and
 *    whether the kill switch fired (and from where),
 *  - how the run ended, and whether it really was isolated.
 *
 * The builder is append-only during the run (blocked events stream
 * in as they happen) and `finish()` freezes it into the final
 * `SandboxV2RunReport`. `renderMarkdown()` is the human-readable
 * form for the UI / audit log; `toJSON()` is the machine form.
 */

import type {
  SandboxV2BlockedEvent,
  SandboxV2EndReason,
  SandboxV2KillSource,
  SandboxV2MicroVmFeasibility,
  SandboxV2RunReport,
  SandboxV2Tier,
  SandboxV2TrustLevel,
} from './types';

/** Inputs needed to open a report (everything known before the run starts). */
export interface SandboxV2ReportOpenOptions {
  runId: string;
  label: string;
  tier: SandboxV2Tier;
  policyId: string;
  policyVersion: number;
  trust: SandboxV2TrustLevel;
  lifetimeCapMs: number;
  /** MicroVM feasibility snapshot when tier 3 was requested. */
  microvmFeasibility?: SandboxV2MicroVmFeasibility;
  /** Isolation detail string from the tier that ran (or 'none'). */
  isolationDetail: string;
  /** True only when the run really was isolated. */
  isolated: boolean;
}

/** Mutable builder — one per run, owned by the runner. */
export class SandboxV2RunReportBuilder {
  private readonly runId: string;
  private readonly label: string;
  private readonly tier: SandboxV2Tier;
  private readonly policyId: string;
  private readonly policyVersion: number;
  private readonly trust: SandboxV2TrustLevel;
  private readonly lifetimeCapMs: number;
  private readonly microvmFeasibility?: SandboxV2MicroVmFeasibility;
  private readonly isolationDetail: string;
  private readonly isolated: boolean;
  private readonly startedAt: string;
  private readonly startedAtMs: number;
  private readonly blocked: SandboxV2BlockedEvent[] = [];
  private readonly tokensIssued: string[] = [];
  private readonly tokensRevoked: Array<{ id: string; reason: string }> = [];
  private killSwitchFired = false;
  private killSwitchSource?: SandboxV2KillSource;
  private lifetimeCapHit = false;
  private stdoutText = '';
  private stderrText = '';
  private exitCode: number | null = null;
  private finished = false;

  constructor(options: SandboxV2ReportOpenOptions) {
    this.runId = options.runId;
    this.label = options.label;
    this.tier = options.tier;
    this.policyId = options.policyId;
    this.policyVersion = options.policyVersion;
    this.trust = options.trust;
    this.lifetimeCapMs = options.lifetimeCapMs;
    this.microvmFeasibility = options.microvmFeasibility;
    this.isolationDetail = options.isolationDetail;
    this.isolated = options.isolated;
    this.startedAtMs = Date.now();
    this.startedAt = new Date(this.startedAtMs).toISOString();
  }

  /** Run id this report belongs to. */
  get id(): string {
    return this.runId;
  }

  /** Append a blocked (or log-only) event. */
  addBlocked(event: SandboxV2BlockedEvent): void {
    this.blocked.push({ ...event });
  }

  /** Record a token issue (id only — never the secret). */
  addTokenIssued(tokenId: string): void {
    if (!this.tokensIssued.includes(tokenId)) this.tokensIssued.push(tokenId);
  }

  /** Record a token revocation with its reason. */
  addTokenRevoked(tokenId: string, reason: string): void {
    if (!this.tokensRevoked.some((t) => t.id === tokenId)) {
      this.tokensRevoked.push({ id: tokenId, reason });
    }
  }

  /** Record that the kill switch fired (first source wins, like the switch itself). */
  markKillSwitchFired(source: SandboxV2KillSource): void {
    if (!this.killSwitchFired) {
      this.killSwitchFired = true;
      this.killSwitchSource = source;
    }
  }

  /** Record that the lifetime cap was hit. */
  markLifetimeCapHit(): void {
    this.lifetimeCapHit = true;
  }

  /** Set captured output (runner truncates to the policy cap first). */
  setOutput(stdout: string, stderr: string): void {
    this.stdoutText = stdout;
    this.stderrText = stderr;
  }

  /** Set the process exit code (null when killed / never started). */
  setExitCode(code: number | null): void {
    this.exitCode = code;
  }

  /** Number of blocked events recorded so far. */
  blockedCount(): number {
    return this.blocked.length;
  }

  /** Counts of blocked events by kind. */
  blockedCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.blocked) {
      counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Freeze the report. After this, further `addBlocked` calls are
   * ignored (the report is a record of what happened, not a live view).
   */
  finish(endReason: SandboxV2EndReason, endDetail?: string): SandboxV2RunReport {
    this.finished = true;
    const endedAtMs = Date.now();
    const report: SandboxV2RunReport = {
      runId: this.runId,
      label: this.label,
      tier: this.tier,
      policyId: this.policyId,
      policyVersion: this.policyVersion,
      trust: this.trust,
      startedAt: this.startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - this.startedAtMs),
      endReason,
      ...(endDetail !== undefined ? { endDetail } : {}),
      blocked: [...this.blocked],
      blockedCounts: this.blockedCounts(),
      tokensIssued: [...this.tokensIssued],
      tokensRevoked: [...this.tokensRevoked],
      killSwitchFired: this.killSwitchFired,
      ...(this.killSwitchSource !== undefined ? { killSwitchSource: this.killSwitchSource } : {}),
      lifetimeCapMs: this.lifetimeCapMs,
      lifetimeCapHit: this.lifetimeCapHit,
      exitCode: this.exitCode,
      stdout: this.stdoutText,
      stderr: this.stderrText,
      isolated: this.isolated,
      isolationDetail: this.isolationDetail,
      ...(this.microvmFeasibility !== undefined ? { microvmFeasibility: this.microvmFeasibility } : {}),
    };
    return report;
  }

  /** True after finish() was called. */
  get isFinished(): boolean {
    return this.finished;
  }
}

/** One-line summary of a finished report (for lists / logs). */
export function summarizeSandboxV2Report(report: SandboxV2RunReport): string {
  const blockedTotal = report.blocked.length;
  const tokens = `${report.tokensIssued.length} issued / ${report.tokensRevoked.length} revoked`;
  const kill = report.killSwitchFired ? `, kill-switch (${report.killSwitchSource ?? '?'})` : '';
  const cap = report.lifetimeCapHit ? ', lifetime-cap hit' : '';
  return (
    `run ${report.runId} [${report.tier}, policy ${report.policyId} v${report.policyVersion}, trust ${report.trust}] ` +
    `ended ${report.endReason} in ${report.durationMs}ms, exit ${report.exitCode ?? 'n/a'}, ` +
    `${blockedTotal} blocked, tokens ${tokens}, isolated=${report.isolated}${kill}${cap}`
  );
}

/** Render a finished report as Markdown (UI panel / audit log). */
export function renderSandboxV2ReportMarkdown(report: SandboxV2RunReport): string {
  const lines: string[] = [];
  lines.push(`# Sandbox v2 run report — ${report.runId}`);
  lines.push('');
  lines.push(`- Label: ${report.label}`);
  lines.push(`- Tier: ${report.tier} (${report.isolated ? 'isolated' : 'NOT isolated'} — ${report.isolationDetail})`);
  lines.push(`- Policy: ${report.policyId} v${report.policyVersion} (trust: ${report.trust})`);
  lines.push(`- Started: ${report.startedAt} — ended: ${report.endedAt} (${report.durationMs}ms)`);
  lines.push(`- End: ${report.endReason}${report.endDetail ? ` — ${report.endDetail}` : ''}`);
  lines.push(`- Lifetime cap: ${report.lifetimeCapMs}ms${report.lifetimeCapHit ? ' (HIT)' : ''}`);
  lines.push(`- Kill switch: ${report.killSwitchFired ? `fired (${report.killSwitchSource ?? 'unknown source'})` : 'not fired'}`);
  lines.push(`- Exit code: ${report.exitCode ?? 'n/a'}`);
  lines.push('');
  lines.push(`## Blocked attempts (${report.blocked.length})`);
  lines.push('');
  if (report.blocked.length === 0) {
    lines.push('None — nothing was blocked during this run.');
  } else {
    lines.push('| # | Time | Kind | Target | Reason |');
    lines.push('|---:|------|------|--------|--------|');
    for (const event of report.blocked) {
      lines.push(`| ${event.seq} | ${event.at} | ${event.kind} | \`${event.target}\` | ${event.reason}${event.logOnly ? ' (log-only)' : ''} |`);
    }
    lines.push('');
    lines.push(`Counts: ${Object.entries(report.blockedCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  lines.push('');
  lines.push(`## Credentials (${report.tokensIssued.length} issued, ${report.tokensRevoked.length} revoked)`);
  lines.push('');
  if (report.tokensIssued.length === 0) {
    lines.push('No tokens were issued for this run.');
  } else {
    for (const id of report.tokensIssued) {
      const revoked = report.tokensRevoked.find((t) => t.id === id);
      lines.push(`- \`${id}\` — ${revoked ? `revoked (${revoked.reason})` : 'still live at report time (check broker)'}`);
    }
  }
  if (report.microvmFeasibility !== undefined) {
    lines.push('');
    lines.push('## MicroVM feasibility (tier 3 requested)');
    lines.push('');
    lines.push(`- Feasible: ${report.microvmFeasibility.feasible ? 'yes' : 'no'}`);
    lines.push(`- Estimated cold boot: ${report.microvmFeasibility.estimatedBootMs}ms`);
    if (report.microvmFeasibility.estimatedResumeMs !== undefined) {
      lines.push(`- Estimated snapshot resume: ${report.microvmFeasibility.estimatedResumeMs}ms`);
    }
    if (report.microvmFeasibility.blockers.length > 0) {
      lines.push(`- Blockers: ${report.microvmFeasibility.blockers.join('; ')}`);
    }
    if (report.microvmFeasibility.warnings.length > 0) {
      lines.push(`- Warnings: ${report.microvmFeasibility.warnings.join('; ')}`);
    }
  }
  if (report.stdout !== '' || report.stderr !== '') {
    lines.push('');
    lines.push('## Output (truncated to policy cap)');
    lines.push('');
    if (report.stdout !== '') {
      lines.push('### stdout');
      lines.push('');
      lines.push('```');
      lines.push(report.stdout);
      lines.push('```');
    }
    if (report.stderr !== '') {
      lines.push('### stderr');
      lines.push('');
      lines.push('```');
      lines.push(report.stderr);
      lines.push('```');
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Serialise a finished report to stable JSON. */
export function serializeSandboxV2Report(report: SandboxV2RunReport): string {
  return JSON.stringify(report, null, 2);
}
