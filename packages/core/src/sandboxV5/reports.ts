/**
 * Sandbox v5 — markdown reports (v1.37, Team T3).
 *
 * Human-readable renderers for the v5 subsystems. Every
 * renderer works from metadata only — a report never contains
 * a secret value (grant listings show names and scopes, never
 * values; archive listings show file counts and hashes, never
 * file contents).
 */

import type {
  SandboxV5Archive,
  SandboxV5BotRuntimeSummary,
  SandboxV5DiskStatus,
  SandboxV5IdleCandidate,
  SandboxV5ReclaimPlan,
  SandboxV5ReclaimResult,
  SandboxV5RuntimeChoice,
  SandboxV5SecretAuditEntry,
  SandboxV5SecretGrantSummary,
  SandboxV5SwitchPlan,
  SandboxV5SwitchResult,
  SandboxV5TierInfo,
} from './types';

/** Bytes → human string (B / KiB / MiB / GiB). */
export function formatSandboxV5Bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

/** ms → human duration string. */
export function formatSandboxV5Duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function iso(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString() : '—';
}

/** Markdown table of the tier catalog. */
export function renderSandboxV5TierTable(tiers: SandboxV5TierInfo[]): string {
  const lines: string[] = [
    '# Sandbox v5 — runtime tiers',
    '',
    '| Tier | Isolates process | Confines fs | Confines net | Syscall policy | Startup | Overhead | Min trust |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const tier of tiers) {
    lines.push(
      `| ${tier.tier} | ${tier.isolatesProcess ? 'yes' : 'no'} | ${tier.confinesFilesystem ? 'yes' : 'no'} | ` +
        `${tier.confinesNetwork ? 'yes' : 'no'} | ${tier.syscallPolicy ? 'yes' : 'no'} | ` +
        `${tier.startupCost}/5 | ${tier.overhead}/5 | ${tier.minTrust} |`,
    );
  }
  lines.push('');
  for (const tier of tiers) {
    lines.push(`- **${tier.tier}** — ${tier.description}`);
  }
  return lines.join('\n');
}

/** Markdown report of one bot's runtime choice. */
export function renderSandboxV5ChoiceMarkdown(choice: SandboxV5RuntimeChoice): string {
  return [
    `# Sandbox v5 — runtime choice for bot "${choice.botId}"`,
    '',
    `- Tier: **${choice.tier}**`,
    `- Profile: ${choice.profileId === '' ? '(none)' : choice.profileId}`,
    `- Trust: ${choice.trust}`,
    `- Limits: maxWrite ${choice.limits.maxWriteBytes > 0 ? formatSandboxV5Bytes(choice.limits.maxWriteBytes) : 'default'}, ` +
      `timeout ${choice.limits.timeoutMs > 0 ? formatSandboxV5Duration(choice.limits.timeoutMs) : 'default'}, ` +
      `memory ${choice.limits.maxMemoryBytes > 0 ? formatSandboxV5Bytes(choice.limits.maxMemoryBytes) : 'none'}, ` +
      `cpu ${choice.limits.cpuSeconds > 0 ? `${choice.limits.cpuSeconds}s` : 'none'}`,
    `- Set by ${choice.setBy} at ${iso(choice.setAtMs)} (version ${choice.version})`,
    ...(choice.reason !== '' ? [`- Reason: ${choice.reason}`] : []),
  ].join('\n');
}

/** Markdown report of a tier-switch plan (dry-run). */
export function renderSandboxV5SwitchPlanMarkdown(plan: SandboxV5SwitchPlan): string {
  const lines: string[] = [
    `# Sandbox v5 — tier switch plan for bot "${plan.botId}"`,
    '',
    `- From: **${plan.fromTier}** → to: **${plan.toTier}**`,
    `- Runtime state: ${plan.runtimeState}`,
    `- Allowed: ${plan.allowed ? 'yes' : 'NO'}`,
    `- Needs drain first: ${plan.needsDrain ? 'yes (runtime is running)' : 'no'}`,
    '',
    '## Steps',
    '',
  ];
  plan.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  if (plan.warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }
  if (plan.blockers.length > 0) {
    lines.push('', '## Blockers', '');
    for (const blocker of plan.blockers) lines.push(`- ${blocker}`);
  }
  return lines.join('\n');
}

/** Markdown report of a completed tier switch. */
export function renderSandboxV5SwitchResultMarkdown(result: SandboxV5SwitchResult): string {
  const lines: string[] = [
    `# Sandbox v5 — tier switch for bot "${result.botId}"`,
    '',
    `- From: **${result.fromTier}** → to: **${result.toTier}**`,
    `- Switched: ${result.switched ? 'yes' : 'no'}`,
    `- Rolled back: ${result.rolledBack ? 'yes' : 'no'}`,
    `- Duration: ${formatSandboxV5Duration(result.durationMs)}`,
    `- Journal: ${result.journalId}`,
    `- ${result.detail}`,
    '',
    '## Steps',
    '',
    '| Step | OK | Duration | Detail |',
    '| --- | --- | --- | --- |',
  ];
  for (const step of result.steps) {
    lines.push(`| ${step.step} | ${step.ok ? 'yes' : 'NO'} | ${formatSandboxV5Duration(step.durationMs)} | ${step.detail} |`);
  }
  return lines.join('\n');
}

/** Markdown report of bot runtimes. */
export function renderSandboxV5RuntimesMarkdown(runtimes: SandboxV5BotRuntimeSummary[]): string {
  const lines: string[] = [
    '# Sandbox v5 — bot runtimes',
    '',
    '| Bot | Tier | Profile | State | Idle | Runs | Switches |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const runtime of runtimes) {
    lines.push(
      `| ${runtime.botId} | ${runtime.tier} | ${runtime.profileId === '' ? '—' : runtime.profileId} | ` +
        `${runtime.state} | ${formatSandboxV5Duration(runtime.idleMs)} | ${runtime.runCount} | ${runtime.switchCount} |`,
    );
  }
  if (runtimes.length === 0) lines.push('', '(no runtimes registered)');
  return lines.join('\n');
}

/** Markdown report of idle-archive candidates. */
export function renderSandboxV5IdleCandidatesMarkdown(candidates: SandboxV5IdleCandidate[]): string {
  const lines: string[] = [
    '# Sandbox v5 — idle runtimes',
    '',
    '| Bot | Runtime | State | Idle | Threshold | Workspace | Archivable |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const candidate of candidates) {
    lines.push(
      `| ${candidate.botId} | ${candidate.runtimeId.slice(0, 12)}… | ${candidate.state} | ` +
        `${formatSandboxV5Duration(candidate.idleMs)} | ${formatSandboxV5Duration(candidate.idleThresholdMs)} | ` +
        `${formatSandboxV5Bytes(candidate.workspaceBytes)} | ${candidate.archivable ? 'yes' : `no — ${candidate.reason}`} |`,
    );
  }
  if (candidates.length === 0) lines.push('', '(no runtimes to check)');
  return lines.join('\n');
}

/** Markdown report of archives. */
export function renderSandboxV5ArchivesMarkdown(archives: SandboxV5Archive[]): string {
  const lines: string[] = [
    '# Sandbox v5 — runtime archives',
    '',
    '| Archive | Bot | Tier | Format | Files | Size | State | Archived |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const archive of archives) {
    lines.push(
      `| ${archive.id} | ${archive.botId} | ${archive.tier} | ${archive.format} | ` +
        `${archive.fileCount} | ${formatSandboxV5Bytes(archive.workspaceBytes)} | ${archive.state} | ${iso(archive.archivedAtMs)} |`,
    );
  }
  if (archives.length === 0) lines.push('', '(no archives yet)');
  return lines.join('\n');
}

/** Markdown report of disk status. */
export function renderSandboxV5DiskStatusMarkdown(status: SandboxV5DiskStatus): string {
  const usable = status.budget.totalBudgetBytes - status.budget.headroomBytes;
  return [
    '# Sandbox v5 — disk status',
    '',
    `- Base dir: \`${status.baseDir}\``,
    `- Used: **${formatSandboxV5Bytes(status.usedBytes)}** of ${formatSandboxV5Bytes(status.budget.totalBudgetBytes)} budget ` +
      `(usable ${formatSandboxV5Bytes(usable)} after ${formatSandboxV5Bytes(status.budget.headroomBytes)} headroom)`,
    `- Caches: ${formatSandboxV5Bytes(status.cacheBytes)}`,
    `- Workspaces: ${formatSandboxV5Bytes(status.workspaceBytes)}`,
    `- Archives: ${formatSandboxV5Bytes(status.archiveBytes)}`,
    `- Over budget: ${status.overBudget ? `YES — ${formatSandboxV5Bytes(status.overBudgetBytes)} over` : 'no'}`,
    `- Remaining under usable budget: ${formatSandboxV5Bytes(status.remainingBytes)}`,
    `- Measured: ${iso(status.measuredAtMs)}`,
  ].join('\n');
}

/** Markdown report of a reclaim plan (dry-run). */
export function renderSandboxV5ReclaimPlanMarkdown(plan: SandboxV5ReclaimPlan): string {
  const lines: string[] = [
    '# Sandbox v5 — reclaim plan (dry-run)',
    '',
    `- Must free: ${formatSandboxV5Bytes(plan.needBytes)}`,
    `- Would free: ${formatSandboxV5Bytes(plan.wouldFreeBytes)}`,
    `- Enough: ${plan.enough ? 'yes' : `NO — still ${formatSandboxV5Bytes(plan.stillOverBytes)} over`}`,
    `- Planned: ${iso(plan.plannedAtMs)}`,
    '',
    '| Path | Kind | Size | Age | Reason |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const item of plan.items) {
    lines.push(`| \`${item.path}\` | ${item.kind} | ${formatSandboxV5Bytes(item.sizeBytes)} | ${formatSandboxV5Duration(item.ageMs)} | ${item.reason} |`);
  }
  if (plan.items.length === 0) lines.push('', '(nothing to reclaim)');
  return lines.join('\n');
}

/** Markdown report of a reclaim execution. */
export function renderSandboxV5ReclaimResultMarkdown(result: SandboxV5ReclaimResult): string {
  const lines: string[] = [
    '# Sandbox v5 — reclaim result',
    '',
    `- Freed: **${formatSandboxV5Bytes(result.freedBytes)}** (${result.removed.length} item(s) removed)`,
    `- Failed: ${result.failed.length}`,
    `- Back under budget: ${result.backUnderBudget ? 'yes' : `NO — still ${formatSandboxV5Bytes(result.stillOverBytes)} over`}`,
    `- Executed: ${iso(result.executedAtMs)}`,
    '',
    '## Removed',
    '',
  ];
  for (const item of result.removed) {
    lines.push(`- \`${item.path}\` (${formatSandboxV5Bytes(item.sizeBytes)}, ${item.reason})`);
  }
  if (result.removed.length === 0) lines.push('(nothing removed)');
  if (result.failed.length > 0) {
    lines.push('', '## Failed', '');
    for (const failure of result.failed) lines.push(`- \`${failure.path}\`: ${failure.reason}`);
  }
  return lines.join('\n');
}

/** Markdown report of secret grants (metadata only — never values). */
export function renderSandboxV5SecretGrantsMarkdown(grants: SandboxV5SecretGrantSummary[]): string {
  const lines: string[] = [
    '# Sandbox v5 — profile-scoped secret grants (metadata only)',
    '',
    '| Grant | Secret | Bot / Run / Profile | Status | Uses | Created | Expires |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const grant of grants) {
    lines.push(
      `| ${grant.id.slice(0, 14)}… | ${grant.name} | ${grant.botId} / ${grant.runId} / ${grant.profileId} | ` +
        `${grant.status} | ${grant.uses}/${grant.maxUses} | ${iso(grant.createdAtMs)} | ${iso(grant.expiresAtMs)} |`,
    );
  }
  if (grants.length === 0) lines.push('', '(no grants)');
  return lines.join('\n');
}

/** Markdown report of the secret audit log (metadata only). */
export function renderSandboxV5SecretAuditMarkdown(entries: SandboxV5SecretAuditEntry[]): string {
  const lines: string[] = [
    '# Sandbox v5 — secret audit log (metadata only, hash-chained)',
    '',
    '| Seq | When | Grant | Secret | Event | Actor | Detail |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of entries) {
    lines.push(
      `| ${entry.seq} | ${iso(entry.atMs)} | ${entry.grantId.slice(0, 14)}… | ${entry.name} | ` +
        `${entry.event} | ${entry.actor} | ${entry.detail} |`,
    );
  }
  if (entries.length === 0) lines.push('', '(no audit entries yet)');
  return lines.join('\n');
}
