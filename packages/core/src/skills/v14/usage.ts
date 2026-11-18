/**
 * Agent Skills v14 — activation usage log (v1.34, Team T1).
 *
 * Every tier-2 activation is a context spend the user pays for, so the
 * loader can record it: one JSON line per activation (`skill`, `at`,
 * `bodyTokens`, `source`). The log is append-only, local, and tiny —
 * it exists so the user (or an audit) can answer "which skills actually
 * get used, and how much context did they cost?" without guessing.
 *
 * - `recordActivationV14(file, entry)` — append one line (creates
 *   parent directories; never throws on I/O failure — a broken log
 *   must not break activation).
 * - `readUsageV14(file)` — read the log back, skipping corrupt lines
 *   (and reporting how many were skipped).
 * - `summarizeUsageV14(entries)` — per-skill totals: activations,
 *   body tokens, first/last use, ranked by total tokens.
 * - `formatUsageSummaryV14(summary)` — one-line-per-skill human report.
 *
 * The loader wires this in through its `usageLogFile` option: when set,
 * `activate()` records each (non-cached) activation automatically.
 * Cached re-activations are not re-recorded — the body was already paid
 * for once.
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** One activation record. */
export interface SkillV14UsageEntry {
  /** Skill name. */
  skill: string;
  /** ISO timestamp of the activation. */
  at: string;
  /** Tier-2 body tokens spent on this activation. */
  bodyTokens: number;
  /** Where the skill came from (e.g. `project-agents`). */
  source: string;
}

/** Result of reading a usage log file. */
export interface SkillV14UsageRead {
  entries: SkillV14UsageEntry[];
  /** Lines that were not valid usage JSON and were skipped. */
  skippedLines: number;
}

/** Per-skill usage totals, ranked by total body tokens (highest first). */
export interface SkillV14UsageSummary {
  skill: string;
  activations: number;
  totalBodyTokens: number;
  firstAt: string;
  lastAt: string;
}

/** Default usage-log file name (written next to the project root). */
export const SKILL_V14_USAGE_LOG_FILE = '.openbot-skills-v14-usage.jsonl';

/** Build one usage entry for an activation happening right now. */
export function buildUsageEntryV14(
  skill: string,
  bodyTokens: number,
  source: string,
  at: Date = new Date(),
): SkillV14UsageEntry {
  return { skill, bodyTokens, source, at: at.toISOString() };
}

/**
 * Append one activation to the log. Never throws: a broken log file
 * must not break skill activation.
 */
export function recordActivationV14(file: string, entry: SkillV14UsageEntry): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Read a usage log back. Missing file = empty log; corrupt lines are skipped and counted. */
export function readUsageV14(file: string): SkillV14UsageRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], skippedLines: 0 };
  }
  const entries: SkillV14UsageEntry[] = [];
  let skippedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      skippedLines++;
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)['skill'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['at'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['bodyTokens'] === 'number' &&
      typeof (parsed as Record<string, unknown>)['source'] === 'string'
    ) {
      entries.push(parsed as unknown as SkillV14UsageEntry);
    } else {
      skippedLines++;
    }
  }
  return { entries, skippedLines };
}

/** Aggregate usage entries into per-skill totals, ranked by total tokens. */
export function summarizeUsageV14(entries: SkillV14UsageEntry[]): SkillV14UsageSummary[] {
  const bySkill = new Map<string, SkillV14UsageSummary>();
  for (const entry of entries) {
    const existing = bySkill.get(entry.skill);
    if (existing === undefined) {
      bySkill.set(entry.skill, {
        skill: entry.skill,
        activations: 1,
        totalBodyTokens: entry.bodyTokens,
        firstAt: entry.at,
        lastAt: entry.at,
      });
    } else {
      existing.activations++;
      existing.totalBodyTokens += entry.bodyTokens;
      if (entry.at < existing.firstAt) existing.firstAt = entry.at;
      if (entry.at > existing.lastAt) existing.lastAt = entry.at;
    }
  }
  return [...bySkill.values()].sort(
    (a, b) => b.totalBodyTokens - a.totalBodyTokens || b.activations - a.activations || a.skill.localeCompare(b.skill),
  );
}

/** One-line-per-skill human report of usage totals. */
export function formatUsageSummaryV14(summary: SkillV14UsageSummary[]): string {
  if (summary.length === 0) return 'No v14 skill activations recorded yet.';
  const totalActivations = summary.reduce((s, row) => s + row.activations, 0);
  const totalTokens = summary.reduce((s, row) => s + row.totalBodyTokens, 0);
  const lines: string[] = [
    `v14 skill usage: ${totalActivations} activation(s), ~${totalTokens} body tokens across ${summary.length} skill(s).`,
  ];
  for (const row of summary) {
    lines.push(
      `- ${row.skill}: ${row.activations} activation(s), ~${row.totalBodyTokens} tokens, first ${row.firstAt}, last ${row.lastAt}`,
    );
  }
  return lines.join('\n');
}

/** Total body tokens spent across a list of usage entries. */
export function totalUsageTokensV14(entries: SkillV14UsageEntry[]): number {
  return entries.reduce((sum, e) => sum + e.bodyTokens, 0);
}
