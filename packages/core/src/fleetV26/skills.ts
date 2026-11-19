/**
 * Skills v26 — a skill pack shared by the whole fleet (v1.39, Team T6).
 *
 * Idea (from the v139 survey §2, Claude Code Agent Skills, open
 * standard): a skill is a FOLDER + a `SKILL.md` (+ optional scripts /
 * assets). One skill is written once; EVERY bot in the fleet can use
 * it — the pack is the fleet's shared muscle memory.
 *
 * Progressive disclosure, 3 tiers (the whole point — the fleet must
 * not load hundreds of skill bodies into every bot's context):
 * - Tier 1 — metadata: name + description only, ~100 tokens/skill,
 *   loaded at startup. `listMetadata()` is all a bot ever sees until
 *   it needs a skill.
 * - Tier 2 — body: the `SKILL.md` body (< 5k tokens), loaded ONLY
 *   when the skill triggers. `loadBody(name)` is the trigger path.
 * - Tier 3 — scripts/assets: loaded ONLY when the body says the task
 *   needs them. `loadAsset(name, path)` is the lazy path.
 *
 * Token estimates use chars/4 (the repo's usual rough estimate — it
 * is a BUDGET guard, not a billing meter). A skill whose metadata
 * exceeds ~100 tokens or whose body exceeds 5k tokens is refused at
 * install with a clear reason: a bloated skill defeats the pack.
 *
 * Matching is keyword-based on the metadata (name + description +
 * declared trigger words) — the model picks from tier-1 metadata,
 * never from bodies. `allowedTools` constrains which tools the skill
 * may invoke; the host enforces it, this module just records it.
 *
 * Skills are DATA here (plain objects the host persists); the pack
 * never executes a script — execution is the host's job, behind the
 * deterministic hooks in `hooks.ts`.
 */

import { createHash } from 'node:crypto';

/** One file inside a skill (script or asset), loaded lazily (tier 3). */
export interface FleetV26SkillFile {
  /** Relative path inside the skill folder, e.g. `scripts/run.sh`. */
  path: string;
  /** File contents (kept in memory by the host; never executed here). */
  content: string;
}

/** A skill definition (one folder + SKILL.md, as data). */
export interface FleetV26Skill {
  /** kebab-case id, e.g. `code-review`. */
  name: string;
  /** One-line description (tier 1 — this is what bots see at startup). */
  description: string;
  /** SKILL.md body (tier 2 — loaded on trigger). */
  body: string;
  /** Trigger words the matcher scores (lowercase). */
  triggers: string[];
  /** Tools the skill may invoke (empty = no restriction recorded). */
  allowedTools: string[];
  /** Argument hint shown to the caller, e.g. `<file> [--fix]`. */
  argumentHint: string | null;
  /** Semantic version of the skill. */
  version: string;
  /** Author / source (pack id or "local"). */
  author: string;
  /** Tier-3 files (scripts/assets), loaded on demand only. */
  files: FleetV26SkillFile[];
  installedAtMs: number;
}

/** Tier-1 metadata only (what startup loads). */
export interface FleetV26SkillMetadata {
  name: string;
  description: string;
  /** Rough token estimate of the metadata (~100 target). */
  metadataTokens: number;
  version: string;
  triggers: string[];
  allowedTools: string[];
  argumentHint: string | null;
  /** True when the body is within the 5k budget (always true post-install). */
  bodyWithinBudget: boolean;
}

/** Result of installing / loading a skill. */
export interface FleetV26SkillOp {
  ok: boolean;
  name: string;
  message: string;
  metadataTokens?: number;
  bodyTokens?: number;
}

/** Token budgets (chars/4 rough estimate). */
export const FLEET_V26_SKILL_METADATA_TOKEN_TARGET = 100;
export const FLEET_V26_SKILL_METADATA_TOKEN_MAX = 200;
export const FLEET_V26_SKILL_BODY_TOKEN_MAX = 5000;
export const FLEET_V26_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A skill body must contain at least this much to be useful. */
export const FLEET_V26_SKILL_BODY_MIN_CHARS = 40;

/** Rough token estimate (chars / 4, rounded up). */
export function estimateFleetV26Tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Checksum of a skill's canonical content (for pack integrity). */
export function checksumFleetV26Skill(skill: Omit<FleetV26Skill, 'installedAtMs' | 'files'> & { files?: FleetV26SkillFile[] }): string {
  const canonical = JSON.stringify({
    name: skill.name,
    description: skill.description,
    body: skill.body,
    triggers: [...skill.triggers].sort(),
    allowedTools: [...skill.allowedTools].sort(),
    argumentHint: skill.argumentHint,
    version: skill.version,
    files: (skill.files ?? []).map((f) => ({ path: f.path, sha: createHash('sha256').update(f.content).digest('hex') })).sort((a, b) => a.path.localeCompare(b.path)),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Parse a SKILL.md document: optional `---` frontmatter (name,
 * description, allowed-tools, argument-hint, version, triggers) +
 * body. Frontmatter is a tiny `key: value` parser (no YAML dep) —
 * values may be a plain string or `[a, b]` list.
 */
export function parseFleetV26SkillMd(
  md: string,
  fallbackName: string,
): { ok: true; skill: Omit<FleetV26Skill, 'files' | 'installedAtMs'> } | { ok: false; message: string } {
  const text = md.replace(/\r\n/g, '\n');
  let front: Record<string, string> = {};
  let body = text;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end === -1) return { ok: false, message: 'SKILL.md frontmatter is not closed (missing second ---).' };
    const raw = text.slice(4, end);
    body = text.slice(end + 4).replace(/^\n+/, '');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (m) front[m[1].toLowerCase()] = m[2].trim();
    }
  }
  const name = (front['name'] ?? fallbackName).trim();
  const description = (front['description'] ?? '').trim();
  if (!FLEET_V26_SKILL_NAME_RE.test(name)) {
    return { ok: false, message: `Skill name "${name}" must be kebab-case (lowercase letters, digits, "-").` };
  }
  if (!description) return { ok: false, message: `Skill "${name}" needs a description in frontmatter.` };
  if (body.trim().length < FLEET_V26_SKILL_BODY_MIN_CHARS) {
    return { ok: false, message: `Skill "${name}" body is too short (needs ${FLEET_V26_SKILL_BODY_MIN_CHARS}+ chars of instructions).` };
  }
  const listOf = (v: string | undefined): string[] => {
    if (!v) return [];
    const inner = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
    return inner.split(',').map((s) => s.trim()).filter(Boolean);
  };
  return {
    ok: true,
    skill: {
      name,
      description,
      body: body.trim(),
      triggers: listOf(front['triggers']).map((t) => t.toLowerCase()),
      allowedTools: listOf(front['allowed-tools'] ?? front['allowed_tools']),
      argumentHint: front['argument-hint'] ?? front['argument'] ?? null,
      version: (front['version'] ?? '1.0.0').trim(),
      author: (front['author'] ?? 'local').trim(),
    },
  };
}

/** The fleet-wide skill pack (one registry, every bot reads it). */
export class FleetV26SkillPack {
  private skills = new Map<string, FleetV26Skill>();
  /** Bodies loaded this session (tier-2 cache; metadata is always cheap). */
  private loadedBodies = new Set<string>();

  /** Install a skill (validates budgets; refuses duplicates + bloated skills). */
  install(
    skill: Omit<FleetV26Skill, 'installedAtMs'>,
    opts: { overwrite?: boolean } = {},
    nowMs: number = Date.now(),
  ): FleetV26SkillOp {
    if (!FLEET_V26_SKILL_NAME_RE.test(skill.name)) {
      return { ok: false, name: skill.name, message: `Skill name "${skill.name}" must be kebab-case.` };
    }
    if (!skill.description.trim()) {
      return { ok: false, name: skill.name, message: `Skill "${skill.name}" needs a description.` };
    }
    if (skill.body.trim().length < FLEET_V26_SKILL_BODY_MIN_CHARS) {
      return { ok: false, name: skill.name, message: `Skill "${skill.name}" body is too short.` };
    }
    const metadataTokens = estimateFleetV26Tokens(`${skill.name} ${skill.description}`);
    if (metadataTokens > FLEET_V26_SKILL_METADATA_TOKEN_MAX) {
      return {
        ok: false,
        name: skill.name,
        message:
          `Skill "${skill.name}" metadata is ~${metadataTokens} tokens (max ${FLEET_V26_SKILL_METADATA_TOKEN_MAX}) — ` +
          `shorten the description so startup stays cheap.`,
        metadataTokens,
      };
    }
    const bodyTokens = estimateFleetV26Tokens(skill.body);
    if (bodyTokens > FLEET_V26_SKILL_BODY_TOKEN_MAX) {
      return {
        ok: false,
        name: skill.name,
        message:
          `Skill "${skill.name}" body is ~${bodyTokens} tokens (max ${FLEET_V26_SKILL_BODY_TOKEN_MAX}) — ` +
          `split it or move detail into tier-3 files.`,
        metadataTokens,
        bodyTokens,
      };
    }
    if (this.skills.has(skill.name) && !opts.overwrite) {
      return { ok: false, name: skill.name, message: `Skill "${skill.name}" is already installed (pass overwrite to replace).`, metadataTokens, bodyTokens };
    }
    this.skills.set(skill.name, {
      ...skill,
      triggers: [...new Set(skill.triggers.map((t) => t.toLowerCase()))].sort(),
      allowedTools: [...new Set(skill.allowedTools)].sort(),
      files: skill.files.map((f) => ({ ...f })),
      installedAtMs: nowMs,
    });
    return { ok: true, name: skill.name, message: `Skill "${skill.name}" installed (~${metadataTokens} metadata tokens, ~${bodyTokens} body tokens).`, metadataTokens, bodyTokens };
  }

  /** Install from a SKILL.md document (+ optional tier-3 files). */
  installFromMd(
    md: string,
    fallbackName: string,
    files: FleetV26SkillFile[] = [],
    opts: { overwrite?: boolean } = {},
    nowMs: number = Date.now(),
  ): FleetV26SkillOp {
    const parsed = parseFleetV26SkillMd(md, fallbackName);
    if (!parsed.ok) return { ok: false, name: fallbackName, message: parsed.message };
    return this.install({ ...parsed.skill, files }, opts, nowMs);
  }

  /** Tier 1 — metadata for every skill (cheap; this is the startup load). */
  listMetadata(): FleetV26SkillMetadata[] {
    return [...this.skills.values()]
      .map((s) => ({
        name: s.name,
        description: s.description,
        metadataTokens: estimateFleetV26Tokens(`${s.name} ${s.description}`),
        version: s.version,
        triggers: [...s.triggers],
        allowedTools: [...s.allowedTools],
        argumentHint: s.argumentHint,
        bodyWithinBudget: estimateFleetV26Tokens(s.body) <= FLEET_V26_SKILL_BODY_TOKEN_MAX,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Total tier-1 tokens if every metadata entry were loaded. */
  totalMetadataTokens(): number {
    return this.listMetadata().reduce((sum, m) => sum + m.metadataTokens, 0);
  }

  /** Tier 2 — load one skill body (the trigger path). */
  loadBody(name: string): { ok: boolean; body: string | null; bodyTokens: number; message: string } {
    const s = this.skills.get(name);
    if (!s) return { ok: false, body: null, bodyTokens: 0, message: `Skill "${name}" is not installed.` };
    this.loadedBodies.add(name);
    return { ok: true, body: s.body, bodyTokens: estimateFleetV26Tokens(s.body), message: `Skill "${name}" body loaded.` };
  }

  /** Tier 3 — load one lazy file (script/asset) of a skill. */
  loadAsset(name: string, path: string): { ok: boolean; content: string | null; message: string } {
    const s = this.skills.get(name);
    if (!s) return { ok: false, content: null, message: `Skill "${name}" is not installed.` };
    const file = s.files.find((f) => f.path === path);
    if (!file) return { ok: false, content: null, message: `Skill "${name}" has no file "${path}".` };
    return { ok: true, content: file.content, message: `Asset "${path}" of skill "${name}" loaded.` };
  }

  /** Files a skill carries (paths only — contents stay lazy). */
  listFiles(name: string): string[] {
    const s = this.skills.get(name);
    return s ? s.files.map((f) => f.path).sort() : [];
  }

  /** One skill (copy) or undefined. */
  get(name: string): FleetV26Skill | undefined {
    const s = this.skills.get(name);
    return s ? { ...s, triggers: [...s.triggers], allowedTools: [...s.allowedTools], files: s.files.map((f) => ({ ...f })) } : undefined;
  }

  /** Remove a skill (frees its metadata + body + files). */
  remove(name: string): boolean {
    this.loadedBodies.delete(name);
    return this.skills.delete(name);
  }

  /** Bodies loaded this session (tier-2 cache keys). */
  loadedBodyNames(): string[] {
    return [...this.loadedBodies].sort();
  }

  /**
   * Match a user request against tier-1 metadata only: score = trigger
   * hits (3 pts each) + name/description word hits (1 pt each).
   * Returns skills scoring > 0, best first. Bodies are never read.
   */
  match(request: string, limit = 5): Array<{ name: string; score: number; description: string }> {
    const words = request.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
    if (words.length === 0) return [];
    const scored: Array<{ name: string; score: number; description: string }> = [];
    for (const s of this.skills.values()) {
      let score = 0;
      for (const w of words) {
        if (s.triggers.includes(w)) score += 3;
        if (s.name.includes(w)) score += 1;
        if (s.description.toLowerCase().includes(w)) score += 1;
      }
      if (score > 0) scored.push({ name: s.name, score, description: s.description });
    }
    return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  }

  /** Counts for the panel. */
  counts(): { skills: number; metadataTokens: number; bodiesLoaded: number; files: number } {
    let files = 0;
    for (const s of this.skills.values()) files += s.files.length;
    return {
      skills: this.skills.size,
      metadataTokens: this.totalMetadataTokens(),
      bodiesLoaded: this.loadedBodies.size,
      files,
    };
  }

  /** JSON round-trip. */
  toJSON(): { skills: FleetV26Skill[] } {
    return { skills: [...this.skills.values()].map((s) => this.get(s.name) as FleetV26Skill) };
  }

  static fromJSON(data: { skills?: FleetV26Skill[] }): FleetV26SkillPack {
    const pack = new FleetV26SkillPack();
    for (const s of data.skills ?? []) {
      if (s && FLEET_V26_SKILL_NAME_RE.test(s.name)) {
        pack.skills.set(s.name, {
          ...s,
          triggers: [...(s.triggers ?? [])],
          allowedTools: [...(s.allowedTools ?? [])],
          files: (s.files ?? []).map((f) => ({ ...f })),
        });
      }
    }
    return pack;
  }
}

/** One-line summary for the skill-pack panel. */
export function summarizeFleetV26SkillPack(pack: FleetV26SkillPack): string {
  const c = pack.counts();
  return (
    `${c.skills} skill(s) in the pack, ~${c.metadataTokens} metadata tokens at startup, ` +
    `${c.bodiesLoaded} bod(ies) loaded on demand, ${c.files} lazy file(s)`
  );
}
