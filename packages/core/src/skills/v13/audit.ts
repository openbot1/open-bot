/**
 * Agent Skills loader v13 — audits, mcode-stack style (v1.13, Team T1).
 *
 * Two audits, one report:
 *
 * 1. Tool-budget audit — "which skills burn tool calls?"
 *    Input: a usage log — one record per tool call, naming the skill
 *    active when the call happened (the agent loop records this; see
 *    `ToolCallRecord`). The audit counts calls per skill and per tool,
 *    flags skills over their budget (`maxCallsPerSkill`, default 50),
 *    and flags single tools that dominate a skill's calls (one tool >
 *    80% of the skill's calls usually means the skill is a wrapper
 *    around one tool, not guidance).
 *
 * 2. Context-tax audit — "what do skills cost the prompt?"
 *    Input: the session index (or any list of skill headers + bodies).
 *    Every skill pays header tax (name + description, every session
 *    start) and, when activated, body tax. A skill that was never
 *    activated in the session paid header tax for nothing — that is
 *    waste. A skill whose body exceeds the guidance is waste of a
 *    different kind: tokens the model reads once and forgets.
 *
 * The combined `SkillWasteReport` ranks waste and ends with concrete
 * recommendations ("disable X", "split Y's body into references/",
 * "skill Z burned 120 shell calls — check its allowed-tools"). The
 * report renders as Markdown (`formatWasteReport`) for the UI and as
 * a plain object for tools/tests. Thresholds are configurable; the
 * defaults are deliberately strict so a clean report means something.
 *
 * Nothing here reads the network or the disk beyond what the caller
 * passes in — the audit is pure computation over records the host
 * already has, which also makes it trivially testable.
 */

import { estimateTokens } from '../registry';
import type { SkillSessionEntry } from './sessionIndex';

/** One tool call, as recorded by the agent loop. */
export interface ToolCallRecord {
  /** Skill active when the call happened ('(none)' when no skill was active). */
  skillName: string;
  /** Tool that was called. */
  toolName: string;
  /** ISO timestamp of the call (informational; audits do not sort on it). */
  at?: string;
  /** True when the call errored (errors count double toward waste). */
  error?: boolean;
}

export interface ToolBudgetAuditOptions {
  /** Max tool calls per skill before it is flagged (default 50). */
  maxCallsPerSkill?: number;
  /** Max calls of ONE tool inside one skill before it is flagged as dominant (default 40). */
  maxCallsPerToolInSkill?: number;
  /** A tool over this share of its skill's calls counts as dominant (default 0.8). */
  dominantToolShare?: number;
  /** Max error share before a skill is flagged as error-prone (default 0.25). */
  maxErrorShare?: number;
}

/** Per-skill tool usage. */
export interface SkillToolUsage {
  skillName: string;
  /** Total calls (errors included). */
  totalCalls: number;
  /** Calls that errored. */
  errorCalls: number;
  /** Calls per tool, best first. */
  byTool: Array<{ toolName: string; calls: number; errors: number }>;
  /** The skill's single most-called tool (undefined when no calls). */
  topTool?: { toolName: string; calls: number; share: number };
  /** True when `totalCalls` exceeds `maxCallsPerSkill`. */
  overBudget: boolean;
  /** True when one tool dominates the skill's calls. */
  hasDominantTool: boolean;
  /** True when the error share exceeds `maxErrorShare`. */
  errorProne: boolean;
}

export interface ToolBudgetAudit {
  totalCalls: number;
  totalErrors: number;
  /** Skills with at least one call, most calls first. */
  skills: SkillToolUsage[];
  /** Calls made with no skill active (the loop's baseline). */
  unskilledCalls: number;
  /** Skills over budget (subset of `skills`). */
  overBudget: string[];
  /** Skills with a dominant tool (subset of `skills`). */
  dominantToolSkills: string[];
  /** Error-prone skills (subset of `skills`). */
  errorProneSkills: string[];
}

/**
 * Audit tool-call usage per skill. Records for unknown skills are
 * still counted (a skill name the index never saw usually means the
 * log predates an uninstall — worth knowing, not worth crashing on).
 */
export function auditToolBudget(
  records: ToolCallRecord[],
  opts: ToolBudgetAuditOptions = {},
): ToolBudgetAudit {
  const maxCallsPerSkill = opts.maxCallsPerSkill ?? 50;
  const maxCallsPerToolInSkill = opts.maxCallsPerToolInSkill ?? 40;
  const dominantToolShare = opts.dominantToolShare ?? 0.8;
  const maxErrorShare = opts.maxErrorShare ?? 0.25;

  const perSkill = new Map<
    string,
    Map<string, { calls: number; errors: number }>
  >();
  let totalCalls = 0;
  let totalErrors = 0;
  let unskilledCalls = 0;
  for (const record of records) {
    totalCalls++;
    if (record.error) totalErrors++;
    const skillName = record.skillName || '(none)';
    if (skillName === '(none)') unskilledCalls++;
    let tools = perSkill.get(skillName);
    if (!tools) {
      tools = new Map();
      perSkill.set(skillName, tools);
    }
    const slot = tools.get(record.toolName) ?? { calls: 0, errors: 0 };
    slot.calls++;
    if (record.error) slot.errors++;
    tools.set(record.toolName, slot);
  }

  const skills: SkillToolUsage[] = [];
  for (const [skillName, tools] of [...perSkill.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (skillName === '(none)') continue;
    let total = 0;
    let errors = 0;
    const byTool: Array<{ toolName: string; calls: number; errors: number }> = [];
    for (const [toolName, slot] of tools) {
      total += slot.calls;
      errors += slot.errors;
      byTool.push({ toolName, calls: slot.calls, errors: slot.errors });
    }
    byTool.sort((a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName));
    const top = byTool[0];
    const topTool =
      top !== undefined
        ? { toolName: top.toolName, calls: top.calls, share: total > 0 ? top.calls / total : 0 }
        : undefined;
    const hasDominantTool =
      topTool !== undefined &&
      topTool.calls >= maxCallsPerToolInSkill &&
      topTool.share >= dominantToolShare;
    skills.push({
      skillName,
      totalCalls: total,
      errorCalls: errors,
      byTool,
      topTool,
      overBudget: total > maxCallsPerSkill,
      hasDominantTool,
      errorProne: total > 0 && errors / total > maxErrorShare,
    });
  }
  skills.sort((a, b) => b.totalCalls - a.totalCalls || a.skillName.localeCompare(b.skillName));
  return {
    totalCalls,
    totalErrors,
    skills,
    unskilledCalls,
    overBudget: skills.filter((s) => s.overBudget).map((s) => s.skillName),
    dominantToolSkills: skills.filter((s) => s.hasDominantTool).map((s) => s.skillName),
    errorProneSkills: skills.filter((s) => s.errorProne).map((s) => s.skillName),
  };
}

// ---------------------------------------------------------------------------
// Context-tax audit
// ---------------------------------------------------------------------------

export interface ContextTaxAuditOptions {
  /** Body tokens over this count as "body too big" (default 1250 ≈ 5.000 chars). */
  maxBodyTokens?: number;
  /** Header tokens over this count as "header too big" (default 250 ≈ 1.000 chars). */
  maxHeaderTokens?: number;
}

/** One skill's context cost. */
export interface SkillContextCost {
  name: string;
  headerTokens: number;
  /** 0 when the body was never loaded in this session. */
  bodyTokens: number;
  totalTokens: number;
  /** True when the body was loaded at least once this session. */
  activated: boolean;
  /** How many times the body was loaded (0 = never). */
  activations: number;
  headerTooBig: boolean;
  bodyTooBig: boolean;
  /** Header tax paid for nothing (never activated). */
  wastedHeaderTokens: number;
}

export interface ContextTaxAudit {
  skills: SkillContextCost[];
  totalHeaderTokens: number;
  totalBodyTokens: number;
  totalTokens: number;
  /** Header tokens of skills never activated (pure waste). */
  wastedHeaderTokens: number;
  /** Skills never activated, most expensive first. */
  neverActivated: string[];
  /** Skills whose body exceeds the guidance. */
  bodyTooBig: string[];
  /** Skills whose header exceeds the guidance. */
  headerTooBig: string[];
}

/**
 * Audit context tax. `activations` maps skill name -> number of times
 * its body was loaded this session (from the session index's cache
 * stats or the loop's own counters). Entries are `SkillSessionEntry`
 * values; bodies are estimated from `bodyTokens` when loaded — for a
 * body that was loaded and then evicted, `bodyTokens` is 0 in the
 * entry, so callers should pass `bodyTokensByName` when they have it
 * (the session index reports evicted bodies as 0; the audit trusts
 * the map first).
 */
export function auditContextTax(
  entries: SkillSessionEntry[],
  activations: Map<string, number> | Record<string, number> = {},
  bodyTokensByName: Map<string, number> | Record<string, number> = {},
  opts: ContextTaxAuditOptions = {},
): ContextTaxAudit {
  const maxBodyTokens = opts.maxBodyTokens ?? 1250;
  const maxHeaderTokens = opts.maxHeaderTokens ?? 250;
  const getActivations = (name: string): number =>
    activations instanceof Map ? activations.get(name) ?? 0 : activations[name] ?? 0;
  const getBodyTokens = (name: string, fallback: number): number => {
    const fromMap = bodyTokensByName instanceof Map ? bodyTokensByName.get(name) : bodyTokensByName[name];
    return fromMap !== undefined ? fromMap : fallback;
  };
  const skills: SkillContextCost[] = entries.map((entry) => {
    const count = getActivations(entry.name);
    const activated = count > 0;
    const bodyTokens = activated ? getBodyTokens(entry.name, entry.bodyTokens) : 0;
    const totalTokens = entry.headerTokens + bodyTokens;
    return {
      name: entry.name,
      headerTokens: entry.headerTokens,
      bodyTokens,
      totalTokens,
      activated,
      activations: count,
      headerTooBig: entry.headerTokens > maxHeaderTokens,
      bodyTooBig: bodyTokens > maxBodyTokens,
      wastedHeaderTokens: activated ? 0 : entry.headerTokens,
    };
  });
  skills.sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
  const totalHeaderTokens = skills.reduce((s, c) => s + c.headerTokens, 0);
  const totalBodyTokens = skills.reduce((s, c) => s + c.bodyTokens, 0);
  const wastedHeaderTokens = skills.reduce((s, c) => s + c.wastedHeaderTokens, 0);
  return {
    skills,
    totalHeaderTokens,
    totalBodyTokens,
    totalTokens: totalHeaderTokens + totalBodyTokens,
    wastedHeaderTokens,
    neverActivated: skills
      .filter((s) => !s.activated)
      .sort((a, b) => b.headerTokens - a.headerTokens)
      .map((s) => s.name),
    bodyTooBig: skills.filter((s) => s.bodyTooBig).map((s) => s.name),
    headerTooBig: skills.filter((s) => s.headerTooBig).map((s) => s.name),
  };
}

// ---------------------------------------------------------------------------
// Combined waste report
// ---------------------------------------------------------------------------

export interface SkillWasteReport {
  /** Session the report covers (for logs). */
  sessionLabel: string;
  toolBudget: ToolBudgetAudit;
  contextTax: ContextTaxAudit;
  /** Waste ranked: biggest token waste first, then biggest call waste. */
  rankedWaste: Array<{
    skillName: string;
    kind: 'never-activated' | 'body-too-big' | 'over-tool-budget' | 'dominant-tool' | 'error-prone';
    detail: string;
    tokensWasted: number;
    callsWasted: number;
  }>;
  /** Concrete next steps, in priority order. */
  recommendations: string[];
}

/**
 * Combine both audits into one ranked waste report. `bodyTokensByName`
 * is forwarded to the context-tax audit (see above).
 */
export function buildWasteReport(
  sessionLabel: string,
  records: ToolCallRecord[],
  entries: SkillSessionEntry[],
  activations: Map<string, number> | Record<string, number> = {},
  bodyTokensByName: Map<string, number> | Record<string, number> = {},
  toolOpts: ToolBudgetAuditOptions = {},
  taxOpts: ContextTaxAuditOptions = {},
): SkillWasteReport {
  const toolBudget = auditToolBudget(records, toolOpts);
  const contextTax = auditContextTax(entries, activations, bodyTokensByName, taxOpts);

  const rankedWaste: SkillWasteReport['rankedWaste'] = [];
  const callsBySkill = new Map(toolBudget.skills.map((s) => [s.skillName, s]));

  for (const cost of contextTax.skills) {
    const usage = callsBySkill.get(cost.name);
    if (!cost.activated) {
      rankedWaste.push({
        skillName: cost.name,
        kind: 'never-activated',
        detail: `Never activated this session — paid ${cost.headerTokens} header tokens for nothing.`,
        tokensWasted: cost.headerTokens,
        callsWasted: 0,
      });
    }
    if (cost.bodyTooBig) {
      rankedWaste.push({
        skillName: cost.name,
        kind: 'body-too-big',
        detail: `Body costs ${cost.bodyTokens} tokens (guidance ~${taxOpts.maxBodyTokens ?? 1250}) — split reference material into references/.`,
        tokensWasted: Math.max(0, cost.bodyTokens - (taxOpts.maxBodyTokens ?? 1250)),
        callsWasted: 0,
      });
    }
    if (usage) {
      if (usage.overBudget) {
        rankedWaste.push({
          skillName: cost.name,
          kind: 'over-tool-budget',
          detail: `Made ${usage.totalCalls} tool calls (budget ${toolOpts.maxCallsPerSkill ?? 50}) — check whether the skill keeps looping.`,
          tokensWasted: 0,
          callsWasted: usage.totalCalls - (toolOpts.maxCallsPerSkill ?? 50),
        });
      }
      if (usage.hasDominantTool && usage.topTool) {
        rankedWaste.push({
          skillName: cost.name,
          kind: 'dominant-tool',
          detail: `Tool "${usage.topTool.toolName}" is ${Math.round(usage.topTool.share * 100)}% of this skill's ${usage.totalCalls} calls — the skill may be a wrapper around one tool.`,
          tokensWasted: 0,
          callsWasted: usage.topTool.calls,
        });
      }
      if (usage.errorProne) {
        rankedWaste.push({
          skillName: cost.name,
          kind: 'error-prone',
          detail: `${usage.errorCalls} of ${usage.totalCalls} calls errored — check the skill's allowed-tools and instructions.`,
          tokensWasted: 0,
          callsWasted: usage.errorCalls,
        });
      }
    }
  }
  // Skills in the log but not in the index (uninstalled mid-session?).
  for (const usage of toolBudget.skills) {
    if (!contextTax.skills.some((c) => c.name === usage.skillName)) {
      rankedWaste.push({
        skillName: usage.skillName,
        kind: 'over-tool-budget',
        detail: `Made ${usage.totalCalls} tool calls but is not in the session index — the skill may have been removed mid-session.`,
        tokensWasted: 0,
        callsWasted: usage.totalCalls,
      });
    }
  }
  rankedWaste.sort(
    (a, b) => b.tokensWasted - a.tokensWasted || b.callsWasted - a.callsWasted || a.skillName.localeCompare(b.skillName),
  );

  const recommendations: string[] = [];
  if (contextTax.neverActivated.length > 0) {
    recommendations.push(
      `Disable or remove the ${contextTax.neverActivated.length} never-activated skill(s) to save ~${contextTax.wastedHeaderTokens} header tokens per session: ${contextTax.neverActivated.join(', ')}.`,
    );
  }
  if (contextTax.bodyTooBig.length > 0) {
    recommendations.push(
      `Split the body of ${contextTax.bodyTooBig.join(', ')} into references/ files (tier 3) so the model only reads them when needed.`,
    );
  }
  if (contextTax.headerTooBig.length > 0) {
    recommendations.push(
      `Shorten the description of ${contextTax.headerTooBig.join(', ')} — long descriptions tax every session start.`,
    );
  }
  if (toolBudget.overBudget.length > 0) {
    recommendations.push(
      `Investigate over-budget skills: ${toolBudget.overBudget.join(', ')} — look for loops or missing stop conditions.`,
    );
  }
  if (toolBudget.dominantToolSkills.length > 0) {
    recommendations.push(
      `Review dominant-tool skills: ${toolBudget.dominantToolSkills.join(', ')} — consider narrowing allowed-tools or folding the skill into the tool itself.`,
    );
  }
  if (toolBudget.errorProneSkills.length > 0) {
    recommendations.push(
      `Fix error-prone skills: ${toolBudget.errorProneSkills.join(', ')} — their instructions or allowed-tools are likely wrong.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('No waste found — tool budgets and context tax are within limits.');
  }

  return { sessionLabel, toolBudget, contextTax, rankedWaste, recommendations };
}

/** Render a waste report as Markdown (settings UI / CLI output). */
export function formatWasteReport(report: SkillWasteReport): string {
  const lines: string[] = [
    `# Skill waste report — ${report.sessionLabel}`,
    '',
    `Tool calls: ${report.toolBudget.totalCalls} total, ${report.toolBudget.totalErrors} errors, ` +
      `${report.toolBudget.unskilledCalls} with no skill active.`,
    `Context tax: ${report.contextTax.totalTokens} tokens ` +
      `(${report.contextTax.totalHeaderTokens} header + ${report.contextTax.totalBodyTokens} body), ` +
      `${report.contextTax.wastedHeaderTokens} header tokens wasted on never-activated skills.`,
    '',
  ];
  if (report.toolBudget.skills.length > 0) {
    lines.push('## Tool usage per skill', '');
    lines.push('| Skill | Calls | Errors | Top tool |');
    lines.push('| --- | ---: | ---: | --- |');
    for (const s of report.toolBudget.skills) {
      const top = s.topTool ? `${s.topTool.toolName} (${s.topTool.calls}, ${Math.round(s.topTool.share * 100)}%)` : '—';
      const flags = [
        s.overBudget ? 'OVER BUDGET' : '',
        s.hasDominantTool ? 'DOMINANT TOOL' : '',
        s.errorProne ? 'ERROR-PRONE' : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`| ${s.skillName}${flags ? ` ⚠ ${flags}` : ''} | ${s.totalCalls} | ${s.errorCalls} | ${top} |`);
    }
    lines.push('');
  }
  if (report.contextTax.skills.length > 0) {
    lines.push('## Context tax per skill', '');
    lines.push('| Skill | Header | Body | Activated |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const s of report.contextTax.skills) {
      lines.push(`| ${s.name} | ${s.headerTokens} | ${s.bodyTokens} | ${s.activations}× |`);
    }
    lines.push('');
  }
  if (report.rankedWaste.length > 0) {
    lines.push('## Waste, ranked', '');
    for (const w of report.rankedWaste) {
      lines.push(`- **${w.skillName}** [${w.kind}]: ${w.detail}`);
    }
    lines.push('');
  }
  lines.push('## Recommendations', '');
  for (const r of report.recommendations) lines.push(`- ${r}`);
  return lines.join('\n');
}

/** Estimate tokens for a raw text (same chars/4 heuristic as the registry). */
export function estimateTokensV13(text: string): number {
  return estimateTokens(text);
}
