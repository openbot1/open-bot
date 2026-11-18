/**
 * Agent Skills v15 — platform table + compatibility parsing (v1.36, Team T2).
 *
 * Five host platforms, one canonical root. The platform table is the
 * single source of truth for every other v15 module: the multi-platform
 * exporter mirrors into these roots, the validator checks skills
 * against them, and the registry filters by them.
 *
 * Compatibility parsing: the AAIF `compatibility` frontmatter field is
 * free-form (a string or a list of strings). v15 parses each entry
 * into either a platform verdict ("claude", "not supported on codex",
 * "opencode: supported") or a free-text requirement ("Requires git").
 * Matching is deliberately conservative: an entry only counts as a
 * platform verdict when it names a known platform id or a well-known
 * host alias (claude-code, copilot, github-copilot, codex, opencode,
 * open-bot); everything else stays a requirement, never silently
 * dropped. Platform names are matched case-insensitively; a leading
 * "not supported", "unsupported", "no " or "does not support" flips
 * the verdict to unsupported.
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SKILL_V15_GLOBAL_ROOTS,
  SKILL_V15_HOST_READ_ROOTS,
  SKILL_V15_PLATFORMS,
  SKILL_V15_PROJECT_ROOTS,
} from './types.js';
import type {
  SkillV15Compatibility,
  SkillV15CompatibilityEntry,
  SkillV15PlatformCheck,
  SkillV15PlatformId,
} from './types.js';

/** Human label for a platform (used in listings and tool output). */
export function describePlatformV15(platform: SkillV15PlatformId): string {
  switch (platform) {
    case 'openbot':
      return 'open-bot (canonical .agents/skills/)';
    case 'claude':
      return 'Claude Code (.claude/skills/)';
    case 'github':
      return 'GitHub Copilot (.github/skills/)';
    case 'codex':
      return 'Codex (.codex/skills/)';
    case 'opencode':
      return 'OpenCode (.opencode/skills/)';
  }
}

/** `true` when `value` names one of the five platforms. */
export function isPlatformIdV15(value: string): value is SkillV15PlatformId {
  return (SKILL_V15_PLATFORMS as readonly string[]).includes(value);
}

/** Parse a platform id, accepting common host aliases (case-insensitive). */
export function parsePlatformIdV15(value: string): SkillV15PlatformId | null {
  const norm = value.trim().toLowerCase();
  switch (norm) {
    case 'openbot':
    case 'open-bot':
    case 'agents':
    case '.agents':
      return 'openbot';
    case 'claude':
    case 'claude-code':
    case 'claudecode':
      return 'claude';
    case 'github':
    case 'copilot':
    case 'github-copilot':
    case 'githubcopilot':
      return 'github';
    case 'codex':
      return 'codex';
    case 'opencode':
    case 'open-code':
      return 'opencode';
    default:
      return null;
  }
}

/**
 * Project-local root for one platform, e.g. `<project>/.claude/skills/`.
 * Pass `global: true` for the home-dir root instead.
 */
export function platformRootV15(
  platform: SkillV15PlatformId,
  opts: { projectRoot?: string; homeDir?: string; global?: boolean } = {},
): string {
  if (opts.global) {
    return path.join(opts.homeDir ?? os.homedir(), SKILL_V15_GLOBAL_ROOTS[platform]);
  }
  return path.join(opts.projectRoot ?? process.cwd(), SKILL_V15_PROJECT_ROOTS[platform]);
}

/** All five project-local roots in platform order. */
export function allPlatformRootsV15(
  opts: { projectRoot?: string; homeDir?: string; global?: boolean } = {},
): Array<{ platform: SkillV15PlatformId; root: string }> {
  return SKILL_V15_PLATFORMS.map((platform) => ({ platform, root: platformRootV15(platform, opts) }));
}

/** Which platform roots a host scans (its own root first, then the ones it also reads). */
export function hostReadRootsV15(platform: SkillV15PlatformId): readonly SkillV15PlatformId[] {
  return SKILL_V15_HOST_READ_ROOTS[platform];
}

/** `true` when `host` would see a skill installed only under `installedOn`. */
export function hostSeesSkillV15(host: SkillV15PlatformId, installedOn: SkillV15PlatformId): boolean {
  return hostReadRootsV15(host).includes(installedOn);
}

/** One-line table of the five platforms and their roots (logs / tool output). */
export function formatPlatformsV15(opts: { projectRoot?: string; homeDir?: string; global?: boolean } = {}): string {
  const lines = ['Agent Skills v15 platforms (canonical .agents/skills/ first):'];
  for (const { platform, root } of allPlatformRootsV15(opts)) {
    const reads = hostReadRootsV15(platform)
      .map((p) => `.${p === 'openbot' ? 'agents' : p}/skills/`)
      .join(', ');
    const exists = fs.existsSync(root) && fs.statSync(root).isDirectory();
    lines.push(`- ${platform} — ${describePlatformV15(platform)}: ${root}${exists ? '' : ' (missing)'}; reads ${reads}`);
  }
  return lines.join('\n');
}

// --- Compatibility parsing --------------------------------------------------

const UNSUPPORTED_PREFIXES = [
  'not supported on ',
  'not supported in ',
  'not supported ',
  'unsupported on ',
  'unsupported in ',
  'unsupported ',
  'no support on ',
  'no support in ',
  'does not support ',
  'doesn\'t support ',
  'not available on ',
  'not available in ',
] as const;

const SUPPORTED_PREFIXES = [
  'supported on ',
  'supported in ',
  'supported ',
  'works on ',
  'works in ',
  'works with ',
  'available on ',
  'available in ',
] as const;

/**
 * Parse one raw compatibility entry into a platform verdict or a
 * free-text requirement. Returns `null` for blank entries.
 *
 * Examples (all from the spec's free-form field, not from any real skill):
 * - `"claude"` → platform claude, supported
 * - `"not supported on codex"` → platform codex, unsupported
 * - `"Requires git + a code search tool"` → requirement
 * - `"opencode: supported"` → platform opencode, supported
 */
export function parseCompatibilityEntryV15(raw: string): SkillV15CompatibilityEntry | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // `platform: ...` form — the part before the colon names the platform.
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const head = trimmed.slice(0, colon).trim();
    const tail = trimmed.slice(colon + 1).trim().toLowerCase();
    const platform = parsePlatformIdV15(head);
    if (platform !== null) {
      const unsupported =
        UNSUPPORTED_PREFIXES.some((p) => tail.startsWith(p)) ||
        tail === 'no' ||
        tail === 'unsupported' ||
        tail === 'not supported';
      return { kind: 'platform', platform, supported: !unsupported };
    }
  }
  const lower = trimmed.toLowerCase();
  for (const prefix of UNSUPPORTED_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).trim();
      const platform = parsePlatformIdV15(rest.replace(/[,;]$/, '').trim());
      if (platform !== null) return { kind: 'platform', platform, supported: false };
      return { kind: 'requirement', text: trimmed };
    }
  }
  for (const prefix of SUPPORTED_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).trim();
      const platform = parsePlatformIdV15(rest.replace(/[,;]$/, '').trim());
      if (platform !== null) return { kind: 'platform', platform, supported: true };
      return { kind: 'requirement', text: trimmed };
    }
  }
  const bare = parsePlatformIdV15(trimmed.replace(/[,;]$/, '').trim());
  if (bare !== null) return { kind: 'platform', platform: bare, supported: true };
  return { kind: 'requirement', text: trimmed };
}

/**
 * Parse the raw `compatibility` frontmatter value (string or list)
 * into structured compatibility. A string is split on newlines first,
 * then on `;` — a single string may carry several entries
 * ("claude; codex; Requires git"). Later entries for the same platform
 * win (a skill may correct itself: "claude, not supported on claude"
 * ends unsupported). Duplicate platform entries are collapsed.
 */
export function parseCompatibilityV15(raw: string | string[] | undefined): SkillV15Compatibility {
  if (raw === undefined) {
    return { raw, unknown: true, supported: [], unsupported: [], requirements: [], entries: [] };
  }
  const parts: string[] = [];
  const pushParts = (text: string): void => {
    for (const line of text.split(/\r?\n/)) {
      for (const chunk of line.split(';')) {
        if (chunk.trim() !== '') parts.push(chunk.trim());
      }
    }
  };
  if (typeof raw === 'string') pushParts(raw);
  else for (const item of raw) if (typeof item === 'string') pushParts(item);

  const entries: SkillV15CompatibilityEntry[] = [];
  const verdictByPlatform = new Map<SkillV15PlatformId, boolean>();
  const requirements: string[] = [];
  for (const part of parts) {
    const parsed = parseCompatibilityEntryV15(part);
    if (parsed === null) continue;
    entries.push(parsed);
    if (parsed.kind === 'platform') verdictByPlatform.set(parsed.platform, parsed.supported);
    else if (!requirements.includes(parsed.text)) requirements.push(parsed.text);
  }
  const supported: SkillV15PlatformId[] = [];
  const unsupported: SkillV15PlatformId[] = [];
  for (const platform of SKILL_V15_PLATFORMS) {
    const verdict = verdictByPlatform.get(platform);
    if (verdict === true) supported.push(platform);
    else if (verdict === false) unsupported.push(platform);
  }
  return { raw, unknown: false, supported, unsupported, requirements, entries };
}

/** Check one skill's compatibility against one platform. */
export function checkCompatibilityV15(
  skillName: string,
  compatibility: SkillV15Compatibility,
  platform: SkillV15PlatformId,
): SkillV15PlatformCheck {
  if (compatibility.unknown) {
    return {
      skill: skillName,
      platform,
      verdict: 'unknown',
      reason: `Skill "${skillName}" states no compatibility — portability on ${describePlatformV15(platform)} is unconfirmed, treat as installable but unverified.`,
      requirements: [],
    };
  }
  if (compatibility.unsupported.includes(platform)) {
    return {
      skill: skillName,
      platform,
      verdict: 'unsupported',
      reason: `Skill "${skillName}" explicitly says it is not supported on ${describePlatformV15(platform)}.`,
      requirements: compatibility.requirements,
    };
  }
  if (compatibility.supported.includes(platform)) {
    return {
      skill: skillName,
      platform,
      verdict: 'supported',
      reason: `Skill "${skillName}" declares support for ${describePlatformV15(platform)}.`,
      requirements: compatibility.requirements,
    };
  }
  // The skill names other platforms but not this one: neither a promise
  // nor a refusal — unknown, with the declared list as context.
  if (compatibility.supported.length > 0) {
    return {
      skill: skillName,
      platform,
      verdict: 'unknown',
      reason:
        `Skill "${skillName}" declares support for ${compatibility.supported.join(', ')} ` +
        `but says nothing about ${describePlatformV15(platform)}.`,
      requirements: compatibility.requirements,
    };
  }
  return {
    skill: skillName,
    platform,
    verdict: 'unknown',
    reason: `Skill "${skillName}" states only free-text requirements — no platform verdict for ${describePlatformV15(platform)}.`,
    requirements: compatibility.requirements,
  };
}

/** Check one skill against every platform (matrix row input). */
export function checkAllPlatformsV15(
  skillName: string,
  compatibility: SkillV15Compatibility,
): SkillV15PlatformCheck[] {
  return SKILL_V15_PLATFORMS.map((platform) => checkCompatibilityV15(skillName, compatibility, platform));
}

/** Format one platform check as a single line (tool output). */
export function formatPlatformCheckV15(check: SkillV15PlatformCheck): string {
  const req =
    check.requirements.length > 0 ? ` (requires: ${check.requirements.join('; ')})` : '';
  return `- ${check.platform}: ${check.verdict} — ${check.reason}${req}`;
}

/** `true` when the skill is supported on every one of the five platforms. */
export function isPortableV15(compatibility: SkillV15Compatibility): boolean {
  if (compatibility.unknown) return false;
  return SKILL_V15_PLATFORMS.every((p) => compatibility.supported.includes(p));
}
