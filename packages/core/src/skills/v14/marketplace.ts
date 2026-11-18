/**
 * Agent Skills v14 — local skill index, marketplace-style (v1.34, Team T1).
 *
 * A read-only index over the skills already installed on this machine:
 * browse what is installed, search by keyword, and flip each skill's
 * enabled tier — without ever installing, downloading or modifying a
 * skill itself.
 *
 * - `browseLocalSkillIndexV14`: list every installed skill (tier-1
 *   headers only) from the discovery roots, with its enabled state.
 * - `searchLocalSkillsV14`: keyword search over name + description
 *   (the body is deliberately NOT searched — progressive disclosure:
 *   the body is not in context, so it is not in the search index
 *   either). Name hits outrank description hits.
 * - Enable/disable is a per-skill tier stored in ONE small JSON state
 *   file (default `<indexDir>/.openbot-skills-v14.json`, `{"disabled":
 *   ["name", …]}`); the skill directories themselves are untouched, so
 *   disabling a skill never deletes or edits it, and a fresh checkout
 *   starts with everything enabled. The loader reads the same state
 *   through its `isEnabled` option, so a disabled skill stays out of
 *   the session-start context.
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverSkillsV14 } from './discovery.js';
import { loadSkillHeaderV14 } from './loader.js';
import { validateSkillDirV14 } from './validator.js';
import type {
  DiscoverSkillsV14Options,
  SkillV14MarketplaceEntry,
  SkillV14MarketplaceOptions,
  SkillV14SearchHit,
} from './types.js';

/** Name of the tier-state file (written next to the index directory). */
export const SKILL_V14_TIER_STATE_FILE = '.openbot-skills-v14.json';

/** Parsed shape of the tier-state file. */
export interface SkillV14TierState {
  /** Names of disabled skills. Everything not listed is enabled. */
  disabled: string[];
  /** Schema version of the state file. */
  version: 1;
}

export function defaultTierStateFileV14(indexDir: string): string {
  return path.join(indexDir, SKILL_V14_TIER_STATE_FILE);
}

/** Read the tier state (missing or corrupt file = everything enabled). */
export function readTierStateV14(stateFile: string): SkillV14TierState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>;
      const disabled = raw['disabled'];
      if (Array.isArray(disabled) && disabled.every((d) => typeof d === 'string')) {
        return { disabled: [...disabled], version: 1 };
      }
    }
  } catch {
    // Missing/corrupt state = all enabled; never fail a read-only listing.
  }
  return { disabled: [], version: 1 };
}

/** Persist the tier state (creates parent directories as needed). */
export function writeTierStateV14(stateFile: string, state: SkillV14TierState): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Build the `isEnabled` predicate the loader accepts from a state file. */
export function isEnabledFromStateFileV14(stateFile: string): (name: string) => boolean {
  const state = readTierStateV14(stateFile);
  const disabled = new Set(state.disabled);
  return (name: string) => !disabled.has(name);
}

/**
 * Browse the local index: every installed skill (discovery roots),
 * invalid skills skipped and reported separately. Read-only — nothing
 * is installed, downloaded or modified.
 */
export function browseLocalSkillIndexV14(
  opts: DiscoverSkillsV14Options & SkillV14MarketplaceOptions = {},
): { entries: SkillV14MarketplaceEntry[]; errors: Array<{ name: string; dir: string; error: string }>; scannedRoots: string[] } {
  const indexDir = opts.projectRoot ?? process.cwd();
  const stateFile = opts.stateFile ?? defaultTierStateFileV14(indexDir);
  const isEnabled = isEnabledFromStateFileV14(stateFile);
  const discovered = discoverSkillsV14(opts);
  const entries: SkillV14MarketplaceEntry[] = [];
  const errors: Array<{ name: string; dir: string; error: string }> = [];
  for (const skill of discovered.skills) {
    try {
      const header = loadSkillHeaderV14(skill, isEnabled);
      entries.push({
        name: header.name,
        description: header.description,
        dir: header.dir,
        source: header.source,
        license: header.license,
        allowedTools: header.allowedTools,
        enabled: header.enabled,
        headerTokens: header.headerTokens,
      });
    } catch (e) {
      errors.push({ name: skill.name, dir: skill.dir, error: (e as Error).message });
    }
  }
  return { entries, errors, scannedRoots: discovered.scannedRoots };
}

/** Score one entry against one keyword: name hit = 10, description hit = 4, both = 14. */
function scoreKeywordV14(entry: SkillV14MarketplaceEntry, keyword: string): { score: number; matchedIn: 'name' | 'description' | 'both' } | null {
  const kw = keyword.toLowerCase();
  const inName = entry.name.toLowerCase().includes(kw);
  const inDescription = entry.description.toLowerCase().includes(kw);
  if (!inName && !inDescription) return null;
  if (inName && inDescription) return { score: 14, matchedIn: 'both' };
  if (inName) return { score: 10, matchedIn: 'name' };
  return { score: 4, matchedIn: 'description' };
}

/**
 * Keyword search over the local index (name + description only — the
 * body is never searched, per progressive disclosure). Multi-word
 * queries score per word and sum; results are ranked best-first.
 * Pass `entries` from `browseLocalSkillIndexV14` to search without
 * re-scanning the disk.
 */
export function searchLocalSkillsV14(
  entries: SkillV14MarketplaceEntry[],
  query: string,
): SkillV14SearchHit[] {
  const keywords = query
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((w) => w.trim())
    .filter((w) => w !== '');
  if (keywords.length === 0) return [];
  const hits: SkillV14SearchHit[] = [];
  for (const entry of entries) {
    let score = 0;
    let matchedIn: 'name' | 'description' | 'both' = 'description';
    let matched = false;
    for (const kw of keywords) {
      const hit = scoreKeywordV14(entry, kw);
      if (hit === null) continue;
      matched = true;
      score += hit.score;
      if (hit.matchedIn === 'both') matchedIn = 'both';
      else if (hit.matchedIn === 'name' && matchedIn !== 'both') matchedIn = 'name';
    }
    if (matched) hits.push({ entry, score, matchedIn });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return hits;
}

/** Search the local index in one call (browse + search). */
export function searchInstalledSkillsV14(
  query: string,
  opts: DiscoverSkillsV14Options & SkillV14MarketplaceOptions = {},
): SkillV14SearchHit[] {
  const { entries } = browseLocalSkillIndexV14(opts);
  return searchLocalSkillsV14(entries, query);
}

/**
 * Enable or disable one installed skill (writes only the tier-state
 * file — the skill directory itself is never touched). Returns the new
 * enabled state. Throws when the skill is not installed.
 */
export function setSkillEnabledV14(
  name: string,
  enabled: boolean,
  opts: DiscoverSkillsV14Options & SkillV14MarketplaceOptions = {},
): boolean {
  const indexDir = opts.projectRoot ?? process.cwd();
  const stateFile = opts.stateFile ?? defaultTierStateFileV14(indexDir);
  const { entries } = browseLocalSkillIndexV14({ ...opts, stateFile });
  if (!entries.some((e) => e.name === name)) {
    throw new Error(`Cannot ${enabled ? 'enable' : 'disable'} unknown skill ${JSON.stringify(name)} — it is not installed.`);
  }
  const state = readTierStateV14(stateFile);
  const disabled = new Set(state.disabled);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  writeTierStateV14(stateFile, { disabled: [...disabled].sort(), version: 1 });
  return enabled;
}

/** Enable one installed skill. */
export function enableSkillV14(
  name: string,
  opts: DiscoverSkillsV14Options & SkillV14MarketplaceOptions = {},
): boolean {
  return setSkillEnabledV14(name, true, opts);
}

/** Disable one installed skill (it stays installed, just out of context). */
export function disableSkillV14(
  name: string,
  opts: DiscoverSkillsV14Options & SkillV14MarketplaceOptions = {},
): boolean {
  return setSkillEnabledV14(name, false, opts);
}

/** Is this installed skill currently enabled? */
export function isSkillEnabledV14(
  name: string,
  opts: DiscoverSkillsV14Options & SkillV14MarketplaceOptions = {},
): boolean {
  const indexDir = opts.projectRoot ?? process.cwd();
  const stateFile = opts.stateFile ?? defaultTierStateFileV14(indexDir);
  return isEnabledFromStateFileV14(stateFile)(name);
}

/** Validate one installed skill directory strictly (frontmatter + body + scripts). */
export function validateInstalledSkillV14(
  dir: string,
  opts: { knownTools?: string[] } = {},
): ReturnType<typeof validateSkillDirV14> {
  return validateSkillDirV14(dir, opts);
}

/** One-line-per-entry human listing of the local index. */
export function formatMarketplaceEntriesV14(entries: SkillV14MarketplaceEntry[]): string {
  if (entries.length === 0) return 'No v14 skills installed.';
  const lines: string[] = [`Installed skills (v14): ${entries.length}`];
  for (const entry of entries) {
    const tools = entry.allowedTools !== undefined && entry.allowedTools.length > 0 ? ` [tools: ${entry.allowedTools.join(', ')}]` : '';
    lines.push(`- ${entry.name} [${entry.enabled ? 'enabled' : 'disabled'}] (${entry.source}): ${entry.description}${tools}`);
  }
  return lines.join('\n');
}
