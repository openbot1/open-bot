/**
 * Sandbox v6 — markdown reports (v1.38, Team T3).
 *
 * Human-readable reports for a bot runtime, its quota usage,
 * its audit summary and its secret scopes. Reports carry
 * metadata only: no secret values ever appear here (the secret
 * store has no read path into a report — only names, purposes
 * and counts), and audit excerpts are already scrubbed by the
 * logger before they are stored.
 */

import { largestWorkspaceFiles } from './diskQuota';
import type {
  SandboxV6AuditSummary,
  SandboxV6DiskCheck,
  SandboxV6RuntimeReport,
  SandboxV6RuntimeSummary,
  SandboxV6Usage,
} from './types';
import { formatSandboxV6Bytes, formatSandboxV6Duration } from './types';

/** Render one runtime summary as a compact one-liner (for lists). */
export function renderSandboxV6RuntimeLine(r: SandboxV6RuntimeSummary): string {
  const quota = r.quota;
  return (
    `- \`${r.botId}\` — ${r.state} (enforcement: ${r.enforcement}) — ` +
    `CPU ${quota.cpuPercent > 0 ? `${quota.cpuPercent}%` : '∞'}, ` +
    `RAM ${quota.memoryBytes > 0 ? formatSandboxV6Bytes(quota.memoryBytes) : '∞'}, ` +
    `disk ${quota.diskBytes > 0 ? formatSandboxV6Bytes(quota.diskBytes) : '∞'} — ` +
    `${r.execCount} exec(s), ${r.refusedCount} refused`
  );
}

/** Render live usage as markdown. */
export function renderSandboxV6UsageMarkdown(usage: SandboxV6Usage, indent = 0): string {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  lines.push(
    `${pad}- CPU time: ${usage.cpuTimeUsec !== null ? formatSandboxV6Duration(usage.cpuTimeUsec / 1000) : 'unknown (no cgroup cpu.stat)'}`,
  );
  lines.push(
    `${pad}- RAM: ${usage.memoryCurrentBytes !== null ? formatSandboxV6Bytes(usage.memoryCurrentBytes) : 'unknown'} ` +
      `(peak ${usage.memoryPeakBytes !== null ? formatSandboxV6Bytes(usage.memoryPeakBytes) : 'unknown'})`,
  );
  lines.push(`${pad}- Processes in cgroup: ${usage.processCount ?? 'unknown'}`);
  lines.push(
    `${pad}- Disk: ${formatSandboxV6Bytes(usage.diskBytes)} in ${usage.diskFiles} file(s) ` +
      `(read ${new Date(usage.readAtMs).toISOString()})`,
  );
  return lines.join('\n');
}

/** Render a disk check as markdown. */
export function renderSandboxV6DiskMarkdown(disk: SandboxV6DiskCheck, indent = 0): string {
  const pad = ' '.repeat(indent);
  const quota = disk.quotaBytes > 0 ? formatSandboxV6Bytes(disk.quotaBytes) : 'unlimited';
  const status = disk.overQuota ? '**OVER QUOTA**' : disk.nearQuota ? '**near quota**' : 'ok';
  const pct = disk.quotaBytes > 0 ? ` (${Math.round(disk.ratio * 100)}%)` : '';
  return (
    `${pad}- Disk: ${formatSandboxV6Bytes(disk.usedBytes)} / ${quota}${pct} — ${status} (${disk.files} files)`
  );
}

/** Render an audit summary as markdown. */
export function renderSandboxV6AuditSummaryMarkdown(summary: SandboxV6AuditSummary, indent = 0): string {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  lines.push(`${pad}- Audit entries: ${summary.totalEntries} (exec: ${summary.execStarts} started, ${summary.execFinishes} finished, ${summary.execRefused} refused, ${summary.execTimeouts} timed out)`);
  lines.push(`${pad}- Quota exceeded: ${summary.quotaExceeded} — secret access denied: ${summary.secretDenied}`);
  if (Object.keys(summary.exitCodes).length > 0) {
    const codes = Object.entries(summary.exitCodes)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([code, count]) => `exit ${code}: ${count}`)
      .join(', ');
    lines.push(`${pad}- Exit codes: ${codes}`);
  }
  lines.push(
    `${pad}- Range: ${summary.firstMs > 0 ? new Date(summary.firstMs).toISOString() : '—'} → ${summary.lastMs > 0 ? new Date(summary.lastMs).toISOString() : '—'}`,
  );
  lines.push(
    `${pad}- Hash chain: ${summary.chainOk ? 'OK' : `BROKEN at seq ${summary.chainBrokenAt.join(', ')}`}`,
  );
  return lines.join('\n');
}

/** Render a fleet-wide summary table for all runtimes (for the dashboard). */
export function renderSandboxV6FleetMarkdown(runtimes: SandboxV6RuntimeSummary[]): string {
  const lines: string[] = [];
  lines.push('# Sandbox v6 — all bot runtimes');
  lines.push('');
  if (runtimes.length === 0) {
    lines.push('No bot runtimes.');
    return lines.join('\n');
  }
  lines.push('| bot | state | enforcement | CPU | RAM | disk | execs | refused |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of runtimes) {
    const q = r.quota;
    lines.push(
      `| \`${r.botId}\` | ${r.state} | ${r.enforcement} | ${q.cpuPercent > 0 ? `${q.cpuPercent}%` : '∞'} | ` +
        `${q.memoryBytes > 0 ? formatSandboxV6Bytes(q.memoryBytes) : '∞'} | ` +
        `${q.diskBytes > 0 ? formatSandboxV6Bytes(q.diskBytes) : '∞'} | ${r.execCount} | ${r.refusedCount} |`,
    );
  }
  const live = runtimes.filter((r) => r.state === 'running').length;
  const totalExecs = runtimes.reduce((sum, r) => sum + r.execCount, 0);
  const totalRefused = runtimes.reduce((sum, r) => sum + r.refusedCount, 0);
  lines.push('');
  lines.push(`- Runtimes: ${runtimes.length} (${live} running) — execs: ${totalExecs}, refused: ${totalRefused}`);
  return lines.join('\n');
}

/** Render a full runtime report as markdown. */
export function renderSandboxV6RuntimeReportMarkdown(report: SandboxV6RuntimeReport): string {
  const r = report.runtime;
  const lines: string[] = [];
  lines.push(`# Sandbox v6 runtime — bot \`${r.botId}\``);
  lines.push('');
  lines.push(`- Runtime: \`${r.id}\` (state: **${r.state}**${r.stopReason !== undefined ? `, ${r.stopReason}` : ''})`);
  lines.push(`- Enforcement: **${r.enforcement}**${r.enforcementReason !== undefined ? ` — ${r.enforcementReason}` : ''}`);
  lines.push(`- Workdir: \`${r.workdir}\`${r.cgroupName !== '' ? ` — cgroup \`${r.cgroupName}\`` : ''}`);
  lines.push(`- Created: ${new Date(r.createdAtMs).toISOString()} — deadline: ${r.deadlineMs > 0 ? new Date(r.deadlineMs).toISOString() : 'none'}`);
  lines.push(`- Last activity: ${new Date(r.lastActivityMs).toISOString()} — execs: ${r.execCount}, refused: ${r.refusedCount}`);
  lines.push('');
  lines.push('## Quota');
  const q = r.quota;
  lines.push(`- CPU: ${q.cpuPercent > 0 ? `${q.cpuPercent}% of one core` : 'unlimited'}`);
  lines.push(`- RAM: ${q.memoryBytes > 0 ? formatSandboxV6Bytes(q.memoryBytes) : 'unlimited'}`);
  lines.push(`- Disk: ${q.diskBytes > 0 ? formatSandboxV6Bytes(q.diskBytes) : 'unlimited'}`);
  lines.push(`- Processes: ${q.maxProcesses > 0 ? q.maxProcesses : 'unlimited'} — exec timeout: ${formatSandboxV6Duration(q.maxExecMs)}`);
  lines.push('');
  lines.push('## Live usage');
  lines.push(renderSandboxV6UsageMarkdown(report.usage, 0));
  lines.push(renderSandboxV6DiskMarkdown(report.disk, 0));
  const largest = largestWorkspaceFiles(r.workdir, 5);
  if (largest.length > 0) {
    lines.push('');
    lines.push('### Largest files');
    for (const f of largest) lines.push(`- \`${f.file}\` — ${formatSandboxV6Bytes(f.bytes)}`);
  }
  lines.push('');
  lines.push('## Audit');
  lines.push(renderSandboxV6AuditSummaryMarkdown(report.audit, 0));
  lines.push('');
  lines.push('## Secrets (metadata only)');
  if (report.secrets.length === 0) {
    lines.push('No secrets owned by this bot.');
  } else {
    for (const s of report.secrets) {
      lines.push(
        `- \`${s.name}\` — purposes: ${s.purposes.length > 0 ? s.purposes.join(', ') : '(any)'} — ` +
          `expires: ${s.expiresAtMs > 0 ? new Date(s.expiresAtMs).toISOString() : 'never'} — ` +
          `reads: ${s.readCount}, denied attempts: ${s.deniedCount}`,
      );
    }
  }
  return lines.join('\n');
}
