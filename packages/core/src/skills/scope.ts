/**
 * Directory-scoped skills — progressive disclosure by working directory
 * (v1.07, Team T4).
 *
 * Idea learned from Claude Code (public docs, 2026): not every skill
 * needs to be present in every session — a skill only activates when
 * the agent works in a directory the skill is relevant to, so the
 * startup prompt stays small and the model is never offered a skill
 * it cannot use where it is working.
 *
 * How it works in open-bot:
 * - A skill may declare a `scope` frontmatter field: a list of
 *   directory patterns, relative to the workspace root (e.g.
 *   `scope: [src/server, docs/**]`) or absolute. A skill WITHOUT
 *   `scope` is global (backward-compatible: every existing skill
 *   keeps working exactly as before).
 * - A scoped skill is only *visible* (tier-1 index), *matchable* and
 *   *applicable* while the agent's working directory is inside one of
 *   its scoped directories. Outside, the skill is hidden from the
 *   prompt entirely — not just deprioritised.
 * - Pattern syntax is deliberately small (no dependency, no full
 *   glob engine):
 *     `src/server`      — the directory itself and everything under it
 *     `docs/**`         — same as `docs` (trailing `/**` is redundant)
 *     `apps/*\/client`  — one segment wildcard (`*` = any chars except `/`)
 *     `**\/migrations` — any depth (`**` = zero or more segments)
 *   A pattern never matches outside the workspace root: relative
 *   patterns containing `..` are rejected at load time, and a working
 *   directory outside the workspace only sees global skills (absolute
 *   scope patterns still match by absolute path).
 *
 * This module is pure (no I/O): the registry calls it with the skills
 * it already loaded. Tier-2/3 loading is unchanged — scope only gates
 * which skills are *offered*, never how their bodies load.
 */

import * as path from 'node:path';
import { SkillLoadError } from './types';
import type { Skill, SkillIndexEntry } from './types';

/** Hard limits for the `scope` frontmatter field. */
export const MAX_SKILL_SCOPE_ENTRIES = 32;
export const MAX_SKILL_SCOPE_PATTERN_CHARS = 256;

/** Where the agent is working, for scope decisions. */
export interface SkillDirectoryContext {
  /** Workspace root the relative scope patterns resolve against. */
  workspaceDir: string;
  /** Directory the agent is currently working in. */
  workingDir: string;
}

/** Outcome of building the tier-1 index for one working directory. */
export interface DirectorySkillIndex {
  /** Tier-1 entries (name + description) of the in-scope skills. */
  entries: SkillIndexEntry[];
  /** How many enabled skills the registry holds in total. */
  totalSkills: number;
  /** How many of them are in scope for this directory. */
  inScope: number;
  /** How many were hidden by scope (progressive disclosure at work). */
  hiddenByScope: number;
  /** Names hidden by scope (for logs / UI — never injected into the prompt). */
  hiddenNames: string[];
  /** Estimated tokens of the formatted index (chars/4, same rule as v0.10). */
  estimatedTokens: number;
}

/**
 * Normalise a raw `scope` frontmatter value into a clean pattern list.
 * Accepts a string (`"src/server, docs/**"`), a list of strings, or
 * nothing (undefined/null → undefined = global skill). Throws
 * SkillLoadError on a wrong type, too many entries, an over-long
 * pattern, or a relative pattern that escapes the workspace (`..`).
 * Empty entries are dropped; duplicates are removed (first wins).
 */
export function normalizeSkillScope(raw: unknown, skillName?: string): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  const label = skillName ? `Skill "${skillName}"` : 'Skill';
  let items: string[];
  if (typeof raw === 'string') {
    items = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else if (Array.isArray(raw)) {
    items = raw.map((item) => {
      if (typeof item !== 'string') {
        throw new SkillLoadError(
          `${label} field "scope" must be a string or a list of strings.`,
        );
      }
      return item.trim();
    });
  } else {
    throw new SkillLoadError(`${label} field "scope" must be a string or a list of strings.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (item.length === 0) continue;
    if (item.length > MAX_SKILL_SCOPE_PATTERN_CHARS) {
      throw new SkillLoadError(
        `${label} scope pattern ${JSON.stringify(item)} is ${item.length} chars — the limit is ${MAX_SKILL_SCOPE_PATTERN_CHARS}.`,
      );
    }
    // A relative pattern must not escape the workspace root.
    if (!path.isAbsolute(item)) {
      const segments = item.split('/').filter((s) => s.length > 0);
      if (segments.includes('..')) {
        throw new SkillLoadError(
          `${label} scope pattern ${JSON.stringify(item)} must not contain ".." — scope patterns stay inside the workspace.`,
        );
      }
    }
    const normalized = normalizeScopePattern(item);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  if (out.length > MAX_SKILL_SCOPE_ENTRIES) {
    throw new SkillLoadError(
      `${label} declares ${out.length} scope patterns — the limit is ${MAX_SKILL_SCOPE_ENTRIES}.`,
    );
  }
  return out.length === 0 ? undefined : out;
}

/**
 * Canonical form of one scope pattern: forward slashes only, no
 * trailing slash, no trailing `/**` (it adds nothing — a bare
 * directory already matches its whole subtree), no `.` segments.
 * Absolute patterns keep their leading `/` (or Windows drive).
 */
export function normalizeScopePattern(pattern: string): string {
  let p = pattern.trim().replace(/\\/g, '/');
  // Collapse duplicate slashes (but keep a leading `//` out — not valid here).
  p = p.replace(/\/{2,}/g, '/');
  const segments = p.split('/').filter((s) => s.length > 0 && s !== '.');
  const rejoined = segments.join('/');
  // Trailing `/**` is redundant: `docs` already covers `docs/**`.
  const withoutGlobTail = rejoined.endsWith('/**')
    ? rejoined.slice(0, -3)
    : rejoined;
  if (path.isAbsolute(pattern)) {
    // Keep the absolute anchor (`/` or `C:/`).
    const anchor = pattern.startsWith('/') ? '/' : /^[A-Za-z]:\//.test(p) ? p.slice(0, 3) : '/';
    return anchor + withoutGlobTail;
  }
  return withoutGlobTail;
}

/** Split a POSIX path into segments, ignoring empty pieces. */
function splitPosix(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

/** One segment matches when `*`/`?` wildcards line up (`*` never crosses `/`). */
function matchSegment(patternSeg: string, valueSeg: string): boolean {
  // Fast paths: exact match, or a lone `*`.
  if (patternSeg === valueSeg) return true;
  if (patternSeg === '*') return true;
  if (!patternSeg.includes('*') && !patternSeg.includes('?')) return false;
  // Small glob-to-regexp for one segment (`*` → `[^/]*`, `?` → `[^/]`).
  let re = '^';
  for (const ch of patternSeg) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  return new RegExp(re).test(valueSeg);
}

/**
 * Match a scope pattern's segments against a path's segments.
 * `**` consumes zero or more segments; a pattern without wildcards
 * matches the directory itself AND everything under it (prefix
 * semantics) — so `src/server` matches `src/server`, `src/server/a`
 * and `src/server/a/b/c.ts`. A pattern WITH wildcards must match the
 * whole relative path (a trailing `/**` is already normalised away).
 */
function matchSegments(patternSegs: string[], pathSegs: string[]): boolean {
  const hasWildcard = patternSegs.some((s) => s === '**' || s.includes('*') || s.includes('?'));
  if (!hasWildcard) {
    // Prefix semantics: every pattern segment must equal the path's
    // first segments (the path may continue deeper).
    if (patternSegs.length > pathSegs.length) return false;
    for (let i = 0; i < patternSegs.length; i++) {
      if (patternSegs[i] !== pathSegs[i]) return false;
    }
    return true;
  }
  // Wildcard matching over segments (`**` = zero+ segments).
  return matchWildcardSegments(patternSegs, pathSegs);
}

function matchWildcardSegments(patternSegs: string[], pathSegs: string[]): boolean {
  // Recursive with memoisation on (pi, si) — patterns are short.
  const memo = new Map<string, boolean>();
  const rec = (pi: number, si: number): boolean => {
    const key = `${pi}:${si}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (pi === patternSegs.length) {
      // Pattern exhausted: match when the path is also exhausted, OR
      // when the last pattern segment was `**` (it swallows the rest).
      result = si === pathSegs.length || patternSegs[pi - 1] === '**';
    } else if (patternSegs[pi] === '**') {
      // `**` matches zero segments (skip it) or one+ (consume a path segment).
      result = rec(pi + 1, si) || (si < pathSegs.length && rec(pi, si + 1));
    } else if (si >= pathSegs.length) {
      result = false;
    } else if (!matchSegment(patternSegs[pi]!, pathSegs[si]!)) {
      result = false;
    } else {
      result = rec(pi + 1, si + 1);
    }
    memo.set(key, result);
    return result;
  };
  return rec(0, 0);
}

/**
 * Does one scope pattern match a working directory?
 * - Absolute pattern: matched against the absolute working directory.
 * - Relative pattern: matched against the working directory relative
 *   to the workspace root. A working directory OUTSIDE the workspace
 *   never matches a relative pattern (only global skills apply there).
 */
export function matchScopePattern(
  pattern: string,
  workingDir: string,
  workspaceDir: string,
): boolean {
  const normalized = normalizeScopePattern(pattern);
  const absWorking = path.resolve(workingDir);
  if (path.isAbsolute(pattern)) {
    const patternSegs = splitPosix(normalized.replace(/\\/g, '/'));
    const pathSegs = splitPosix(absWorking.replace(/\\/g, '/'));
    return matchSegments(patternSegs, pathSegs);
  }
  const absWorkspace = path.resolve(workspaceDir);
  const rel = path.relative(absWorkspace, absWorking);
  // `..` (or an absolute result) means "outside the workspace".
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  const relPosix = rel === '' ? '' : rel.split(path.sep).join('/');
  const patternSegs = splitPosix(normalized);
  // The workspace root itself (`rel === ''`) matches only the empty
  // pattern (a skill scoped to `.`); any real scope needs a subdir.
  if (relPosix === '') return patternSegs.length === 0;
  return matchSegments(patternSegs, splitPosix(relPosix));
}

/**
 * Is this skill in scope for a working directory? A skill with no
 * `scope` (or an empty one) is global and always in scope. A scoped
 * skill is in scope when ANY of its patterns matches.
 */
export function isSkillInScope(
  skill: Pick<Skill, 'scope'>,
  workingDir: string,
  workspaceDir: string,
): boolean {
  const scope = skill.scope;
  if (!scope || scope.length === 0) return true;
  return scope.some((pattern) => matchScopePattern(pattern, workingDir, workspaceDir));
}

/**
 * Keep only the skills in scope for a working directory, in registry
 * order. Global skills always survive; scoped skills survive only
 * when a pattern matches. Pure — the input list is never mutated.
 */
export function filterSkillsByDirectory<T extends Pick<Skill, 'scope'>>(
  skills: readonly T[],
  workingDir: string,
  workspaceDir: string,
): T[] {
  return skills.filter((skill) => isSkillInScope(skill, workingDir, workspaceDir));
}

/** Human-readable scope for logs / UI: `Global` or `Chỉ trong: a, b`. */
export function describeSkillScope(
  skill: Pick<Skill, 'name' | 'scope'>,
): string {
  const scope = skill.scope;
  if (!scope || scope.length === 0) return 'Global';
  return `Chỉ trong: ${scope.join(', ')}`;
}

/**
 * Build the tier-1 index for one working directory: only in-scope,
 * enabled, model-invocable skills appear (same exclusions as
 * `SkillRegistry.skillIndex`, plus the scope gate). Bodies stay
 * unloaded — this is still tier 1, just directory-aware.
 *
 * `ctx.workingDir` must be ABSOLUTE (or already resolved against the
 * workspace): a relative workingDir is resolved against the PROCESS
 * cwd by `path.resolve`, which silently hides every scoped skill.
 * Callers that take a user-supplied directory must run it through
 * `resolveWorkingDir` first (the registry methods do).
 */
export function buildDirectorySkillIndex(
  skills: readonly Skill[],
  ctx: SkillDirectoryContext,
  exclude?: Iterable<string>,
): DirectorySkillIndex {
  const excluded = new Set(exclude ?? []);
  const enabled = skills.filter((s) => s.enabled);
  const inScope = filterSkillsByDirectory(enabled, ctx.workingDir, ctx.workspaceDir);
  const entries: SkillIndexEntry[] = inScope
    .filter((s) => !s.disableModelInvocation && !excluded.has(s.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      name: s.name,
      description: s.description,
      context: s.context,
      allowedTools: [...s.allowedTools],
    }));
  const hiddenNames = enabled
    .filter((s) => !isSkillInScope(s, ctx.workingDir, ctx.workspaceDir))
    .map((s) => s.name)
    .sort();
  const text = formatDirectorySkillIndexEntries(entries, ctx);
  return {
    entries,
    totalSkills: enabled.length,
    inScope: inScope.length,
    hiddenByScope: hiddenNames.length,
    hiddenNames,
    estimatedTokens: Math.ceil(text.length / 4),
  };
}

/** The tier-1 index as compact prompt text, annotated with the directory it was built for. */
export function formatDirectorySkillIndexEntries(
  entries: readonly SkillIndexEntry[],
  ctx: SkillDirectoryContext,
): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e) => {
    const fork = e.context === 'fork' ? ' [runs in a subagent]' : '';
    const tools = e.allowedTools.length > 0 ? ` (tools: ${e.allowedTools.join(', ')})` : '';
    return `- ${e.name}: ${e.description}${fork}${tools}`;
  });
  const dirLabel = path.relative(path.resolve(ctx.workspaceDir), path.resolve(ctx.workingDir)) || '.';
  return (
    `Available skills for this directory (${dirLabel}) — invoke by name when the task matches; ` +
    `the full instructions load only then:\n${lines.join('\n')}`
  );
}

/**
 * Resolve the working directory for a scope check: an empty/relative
 * `workingDir` resolves against the workspace root; an absolute one
 * is used as-is. Never throws — an unusable value falls back to the
 * workspace root (global skills only, scoped skills stay hidden
 * rather than crashing the run).
 */
export function resolveWorkingDir(workingDir: string | undefined, workspaceDir: string): string {
  if (!workingDir || typeof workingDir !== 'string' || workingDir.trim() === '') {
    return path.resolve(workspaceDir);
  }
  return path.resolve(workspaceDir, workingDir);
}
