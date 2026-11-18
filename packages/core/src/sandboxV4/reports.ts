/**
 * Sandbox v4 — markdown reports (v1.36, Team T4).
 *
 * Human-readable reports for the runtime, the budget meter,
 * the dependency map and agent profiles. Reports carry metadata
 * only: no secret values ever appear here (the secret manager
 * has no read path into a report), and budget numbers are
 * labelled as estimates where they are estimates.
 */

import type { SandboxV4DependencyMap } from './types';
import type { SandboxV4BudgetState } from './types';
import type { SandboxV4AgentProfile } from './types';
import type { SandboxV4RuntimeReport } from './conversationRuntime';
import { affectedSetSandboxV4DepMap, topoOrderSandboxV4DepMap } from './dependencyMap';

/** Render a full runtime report as markdown. */
export function renderSandboxV4RuntimeReportMarkdown(report: SandboxV4RuntimeReport): string {
  const lines: string[] = [];
  const r = report.runtime;
  lines.push(`# Sandbox v4 runtime — ${r.conversationId}`);
  lines.push('');
  lines.push(`- Runtime: \`${r.id}\` (state: **${r.state}**, profile: \`${r.profileId || '(none)'}\`)`);
  lines.push(`- Conversation: \`${r.conversationId}\` — v3 session \`${r.sessionId}\` (tier \`${r.tier}\`, trust \`${r.trust}\`)`);
  lines.push(`- Workdir: \`${r.workdir}\` (exists: ${report.workdirExists ? 'yes' : 'no'})`);
  lines.push(`- Created: ${new Date(r.createdAtMs).toISOString()} — deadline: ${r.deadlineMs > 0 ? new Date(r.deadlineMs).toISOString() : 'none'}`);
  if (r.endReason !== undefined) lines.push(`- Ended: ${r.endReason} at ${new Date(r.endedAtMs).toISOString()}`);
  lines.push(`- May run a new step: ${report.mayRunStep ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Budget');
  lines.push(renderSandboxV4BudgetMarkdown(report.budget, 0));
  lines.push('');
  lines.push('## Processes');
  if (report.processes.length === 0) {
    lines.push('No processes registered.');
  } else {
    lines.push('| pid | label | command | started | ended | exit |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const p of report.processes) {
      lines.push(
        `| ${p.pid} | ${p.label} | \`${p.command}\` | ${new Date(p.startedAtMs).toISOString()} | ` +
          `${p.endedAtMs > 0 ? new Date(p.endedAtMs).toISOString() : 'running'} | ${p.exitCode ?? '—'} |`,
      );
    }
  }
  if (report.session) {
    lines.push('');
    lines.push('## Sandbox v3 session');
    lines.push(`- State: ${report.session.state} — steps: ${report.session.steps}, blocked events: ${report.session.blocked}, snapshots: ${report.session.snapshots}`);
    lines.push(`- Egress: ${report.session.egressRequestsUsed} requests, ${report.session.egressBytesUsed} bytes`);
  }
  return lines.join('\n');
}

/** Render a budget state as markdown (indented by `indent` spaces when nested). */
export function renderSandboxV4BudgetMarkdown(state: SandboxV4BudgetState, indent = 0): string {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  const fmtLimit = (used: number, limit: number): string => (limit <= 0 ? `${used} / ∞` : `${used} / ${limit}`);
  lines.push(`${pad}- Status: **${state.status}**`);
  lines.push(`${pad}- Input tokens: ${fmtLimit(state.usage.inputTokens, state.limits.maxInputTokens)} (${Math.round(state.ratios.inputTokens * 100)}%)`);
  lines.push(`${pad}- Output tokens: ${fmtLimit(state.usage.outputTokens, state.limits.maxOutputTokens)} (${Math.round(state.ratios.outputTokens * 100)}%)`);
  lines.push(`${pad}- Cost: $${state.usage.costUsd.toFixed(4)} / ${state.limits.maxCostUsd > 0 ? `$${state.limits.maxCostUsd}` : '∞'} (${Math.round(state.ratios.costUsd * 100)}%) — estimated from the model price table, not a bill`);
  lines.push(`${pad}- Wall time: ${fmtLimit(state.usage.wallMs, state.limits.maxWallMs)} ms (${Math.round(state.ratios.wallMs * 100)}%)`);
  lines.push(`${pad}- Steps recorded: ${state.usage.steps} (warning at ${Math.round(state.limits.warnAtRatio * 100)}% of any limit)`);
  if (state.warningDimensions.length > 0) {
    lines.push(`${pad}- Warning dimensions: ${state.warningDimensions.join(', ')}`);
  }
  if (state.blockedDimensions.length > 0) {
    lines.push(`${pad}- Blocked dimensions: ${state.blockedDimensions.join(', ')} — new steps are soft-blocked until limits are raised or the meter is reset`);
  }
  return lines.join('\n');
}

/** Render a dependency map summary as markdown. */
export function renderSandboxV4DepMapMarkdown(map: SandboxV4DependencyMap): string {
  const lines: string[] = [];
  lines.push(`# Dependency map — ${map.rootDir}`);
  lines.push('');
  lines.push(`- Files: ${map.fileCount} — import edges: ${map.edgeCount} — built: ${new Date(map.builtAtMs).toISOString()}`);
  lines.push(`- Cycles: ${map.cycles.length}`);
  if (map.cycles.length > 0) {
    for (const cycle of map.cycles) {
      lines.push(`  - cycle: ${cycle.files.join(' → ')} → ${cycle.files[0]}`);
    }
  }
  const { order, unordered } = topoOrderSandboxV4DepMap(map);
  lines.push(`- Topological order: ${order.length} files ordered, ${unordered.length} unordered (in cycles)`);
  if (unordered.length > 0) {
    lines.push(`  - unordered: ${unordered.join(', ')}`);
  }
  lines.push('');
  lines.push('## Most-imported files (top 10)');
  const byImporters = [...Object.values(map.nodes)].sort((a, b) => b.importedBy.length - a.importedBy.length).slice(0, 10);
  if (byImporters.length === 0) {
    lines.push('No files.');
  } else {
    for (const node of byImporters) {
      lines.push(`- \`${node.path}\` — imported by ${node.importedBy.length} file(s), imports ${node.imports.length}`);
    }
  }
  return lines.join('\n');
}

/** Render the impact set of a change as markdown. */
export function renderSandboxV4ImpactMarkdown(map: SandboxV4DependencyMap, files: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`# Impact of changing ${files.map((f) => `\`${f}\``).join(', ')}`);
  lines.push('');
  const affected = affectedSetSandboxV4DepMap(map, files);
  lines.push(`- Changed files: ${files.length}`);
  lines.push(`- Affected files (changed + everything that transitively imports them): ${affected.length}`);
  if (affected.length > 0) {
    for (const file of affected) lines.push(`- \`${file}\``);
  }
  return lines.join('\n');
}

/** Render one agent profile as markdown. */
export function renderSandboxV4ProfileMarkdown(profile: SandboxV4AgentProfile): string {
  const lines: string[] = [];
  lines.push(`# Profile — ${profile.name} (\`${profile.id}\`)`);
  lines.push('');
  lines.push(`- Builtin: ${profile.builtin ? 'yes' : 'no'} — version: ${profile.version}`);
  lines.push(`- Model: \`${profile.llm.model}\` — temperature ${profile.llm.temperature}, max ${profile.llm.maxTokens} tokens, topP ${profile.llm.topP}, timeout ${profile.llm.timeoutMs} ms`);
  lines.push(`- Skills (${profile.skillIds.length}): ${profile.skillIds.join(', ')}`);
  lines.push('');
  lines.push('## Persona');
  lines.push(profile.persona);
  lines.push('');
  lines.push('## Instructions');
  lines.push(profile.instructions);
  return lines.join('\n');
}
