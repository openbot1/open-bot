/**
 * Agent Skills v14 — dual-path discovery (v1.34, Team T1).
 *
 * Two project-local roots plus two global roots, in priority order:
 *
 *   1. `<project>/.agents/skills/`   (project-local, cross-platform canonical)
 *   2. `<project>/.claude/skills/`   (project-local, Claude Code)
 *   3. `~/.claude/skills/`          (global, Claude Code)
 *   4. `~/.agents/skills/`          (global, Codex / Cursor / Copilot / Gemini CLI …)
 *
 * A skill is a directory holding a `SKILL.md`; directories without one
 * are skipped (and reported in `skippedDirs`). When the same name shows
 * up in several roots, the highest-priority copy wins and the losers are
 * listed as `shadowedDirs` on the winner — project-local always beats
 * global, so a project skill can intentionally override a global one
 * of the same name. The scan reads directory names only: no SKILL.md
 * body is ever opened here (progressive disclosure — see loader.ts).
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SKILL_V14_FILE_NAME } from './types.js';
import type {
  DiscoveredSkillV14,
  DiscoverSkillsV14Options,
  DiscoveryV14Result,
  SkillV14SourceKind,
} from './types.js';

/** The four discovery roots in priority order, as (kind, root) pairs. */
export function discoveryRootsV14(opts: DiscoverSkillsV14Options = {}): Array<{ kind: SkillV14SourceKind; root: string }> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const roots: Array<{ kind: SkillV14SourceKind; root: string }> = [
    { kind: 'project-agents', root: path.join(projectRoot, '.agents', 'skills') },
    { kind: 'project-claude', root: path.join(projectRoot, '.claude', 'skills') },
  ];
  if (!opts.projectOnly) {
    roots.push(
      { kind: 'global-claude', root: path.join(homeDir, '.claude', 'skills') },
      { kind: 'global-agents', root: path.join(homeDir, '.agents', 'skills') },
    );
  }
  return roots;
}

/** Human label for a discovery root kind (used in listings). */
export function describeSourceKindV14(kind: SkillV14SourceKind): string {
  switch (kind) {
    case 'project-agents':
      return 'project .agents/skills/';
    case 'project-claude':
      return 'project .claude/skills/';
    case 'global-claude':
      return 'global ~/.claude/skills/';
    case 'global-agents':
      return 'global ~/.agents/skills/';
  }
}

/** `true` when the root is project-local (outranks every global root). */
export function isProjectLocalV14(kind: SkillV14SourceKind): boolean {
  return kind === 'project-agents' || kind === 'project-claude';
}

function listSkillDirsInRoot(root: string): { found: string[]; skipped: string[] } {
  const found: string[] = [];
  const skipped: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { found, skipped };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    if (fs.existsSync(path.join(dir, SKILL_V14_FILE_NAME))) found.push(dir);
    else skipped.push(dir);
  }
  return { found, skipped };
}

/**
 * Scan the four discovery roots and return deduplicated skills.
 * Only directory names are read — no SKILL.md is opened.
 */
export function discoverSkillsV14(opts: DiscoverSkillsV14Options = {}): DiscoveryV14Result {
  const roots = discoveryRootsV14(opts);
  const scannedRoots: string[] = [];
  const missingRoots: string[] = [];
  const skippedDirs: string[] = [];
  const byName = new Map<string, DiscoveredSkillV14>();

  for (const { kind, root } of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      missingRoots.push(root);
      continue;
    }
    scannedRoots.push(root);
    const { found, skipped } = listSkillDirsInRoot(root);
    skippedDirs.push(...skipped);
    for (const dir of found) {
      const name = path.basename(dir);
      const existing = byName.get(name);
      if (existing === undefined) {
        byName.set(name, { name, dir, source: kind, root, shadowed: false, shadowedDirs: [] });
      } else {
        // Lower-priority copy of a name we already have: record it as shadowed.
        existing.shadowed = true;
        existing.shadowedDirs.push(dir);
      }
    }
  }

  const skills = [...byName.values()].sort((a, b) => {
    const aLocal = isProjectLocalV14(a.source) ? 0 : 1;
    const bLocal = isProjectLocalV14(b.source) ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    return a.name.localeCompare(b.name);
  });
  return { skills, scannedRoots, missingRoots, skippedDirs };
}

/**
 * Scan ONE root (any directory holding `<name>/SKILL.md` subdirectories)
 * and return its skills without deduping against other roots. Used by
 * the marketplace index and the tools layer for a single install dir.
 */
export function discoverSkillsInDirV14(dir: string, source: SkillV14SourceKind): DiscoveredSkillV14[] {
  const { found } = listSkillDirsInRoot(dir);
  return found
    .map((skillDir) => ({
      name: path.basename(skillDir),
      dir: skillDir,
      source,
      root: dir,
      shadowed: false,
      shadowedDirs: [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One-line summary of a discovery result, for logs and tool output. */
export function formatDiscoverySummaryV14(result: DiscoveryV14Result): string {
  const lines: string[] = [
    `Found ${result.skills.length} skill(s) in ${result.scannedRoots.length} root(s)` +
      (result.missingRoots.length > 0 ? ` (${result.missingRoots.length} root(s) missing)` : '') +
      (result.skippedDirs.length > 0 ? `, ${result.skippedDirs.length} director(ies) skipped (no SKILL.md)` : '') +
      '.',
  ];
  for (const skill of result.skills) {
    lines.push(
      `- ${skill.name} [${describeSourceKindV14(skill.source)}] ${skill.dir}` +
        (skill.shadowed ? ` (shadows ${skill.shadowedDirs.length} lower-priority copy/copies)` : ''),
    );
  }
  return lines.join('\n');
}
