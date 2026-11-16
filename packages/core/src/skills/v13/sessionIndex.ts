/**
 * Agent Skills loader v13 — session header index (v1.13, Team T1).
 *
 * Progressive disclosure, session-scoped:
 *
 *   Tier 1 (session open) — `SkillSessionIndex.open(roots)` walks every
 *   skill directory under each root and reads ONLY the frontmatter of
 *   each SKILL.md (via `loadSkillDir`, tier 1). The body is never read.
 *   The result is the session index: one `SkillSessionEntry` per skill
 *   with name, description, flags, resource listing and a header-token
 *   estimate. This is what goes into the startup prompt.
 *
 *   Tier 2 (on demand) — `ensureBody(name)` reads the body of exactly
 *   one skill, caches it, and returns it. Bodies are cached in an
 *   insertion-ordered map capped by `maxCachedBodies` (default 8);
 *   loading a ninth body evicts the least-recently-used one. The
 *   cache keeps repeated activations of the same skill in one session
 *   cheap without letting a long session pin every body in memory.
 *
 *   Tier 3 (on demand) — `readResource(name, relPath)` reads one
 *   `scripts/` / `references/` / `assets/` file, also through the
 *   existing loader guards (no traversal, must stay inside the skill).
 *
 * Why a separate index instead of reusing `SkillRegistry`? The
 * registry owns the long-lived, multi-source skill set (built-ins +
 * user + plugins) with enable/disable persistence. The session index
 * is deliberately smaller and throwaway: it answers "what skills are
 * visible in THIS session, from THESE roots, and what do they cost?"
 * — including skills the registry never sees (a project's
 * `.claude/skills/`, an imported Codex pack, a local-marketplace
 * folder). A session creates one, uses it, drops it. The registry
 * stays the owner of record; the index is a read lens over disk.
 *
 * Costs: every entry carries `headerTokens` (name + description) and,
 * once loaded, `bodyTokens`. `totalHeaderTokens()` is the exact price
 * of putting the whole index in the startup prompt, so the caller can
 * decide to trim (e.g. drop `disable-model-invocation` skills from the
 * index text) before it exceeds its budget.
 *
 * Errors never abort the open: a broken skill is recorded in
 * `errors` (file + message) and skipped, exactly like
 * `loadSkillsFromDir`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateTokens } from '../registry';
import {
  extractSkillBody,
  loadSkillDir,
  loadSkillFileMetadata,
  MAX_SKILL_BODY_CHARS,
  readSkillResource,
  resolveSkillResourcePath,
  SKILL_FILE_NAME,
} from '../loader';
import type { Skill, SkillIndexEntry, SkillResources, SkillSource } from '../types';
import { emptySkillResources } from '../types';

/** One skill as the session sees it after tier-1 loading. */
export interface SkillSessionEntry {
  /** Skill name (== its directory name for standard-layout skills). */
  name: string;
  description: string;
  version: string;
  /** `fork` skills run in a subagent; the index marks them so. */
  context?: 'fork';
  allowedTools: string[];
  license?: string;
  compatibility?: string | string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  /** Tier-3 listing (paths only — contents are not loaded). */
  resources: SkillResources;
  /** Which root this skill was found under (for diagnostics). */
  rootDir: string;
  /** Absolute path of SKILL.md / the loose .md file. */
  filePath?: string;
  /** Absolute skill directory (undefined for loose files). */
  skillDir?: string;
  /** Estimated tokens of the `name — description` index line. */
  headerTokens: number;
  /** Estimated body tokens — known only after tier-2 load (0 before). */
  bodyTokens: number;
  /** Tier 2 done for this skill in this session. */
  bodyLoaded: boolean;
  /** True when this entry came from a loose `<name>.md` file. */
  looseFile: boolean;
}

export interface SkillSessionIndexOptions {
  /**
   * Max skill bodies cached at once (default 8). Loading one more
   * evicts the least-recently-used body (its entry stays, with
   * `bodyLoaded` reset to false — it can be re-loaded later).
   */
  maxCachedBodies?: number;
  /**
   * When true, a later root OVERRIDES an earlier root on name clash
   * (default true — mirrors the registry's built-in < user < plugin
   * order: pass roots in priority order, lowest first).
   */
  laterRootsOverride?: boolean;
  /**
   * Maximum SKILL.md bytes read for a tier-2 body load (default
   * 200.000 — same cap as the loader's `MAX_SKILL_TEXT_CHARS`).
   * A larger file fails the body load instead of being read unbounded.
   */
  maxBodyChars?: number;
}

export interface SkillSessionOpenResult {
  index: SkillSessionIndex;
  /** Skills that failed tier-1 parsing (file + message); loading continued. */
  errors: Array<{ file: string; error: string }>;
}

/** A loaded body, as returned by `ensureBody`. */
export interface SkillSessionBody {
  name: string;
  /** Full body text (not truncated — truncation is the caller's job). */
  body: string;
  /** Estimated tokens of the body. */
  bodyTokens: number;
  /** True when this call loaded the body from disk (false = cache hit). */
  fromCache: boolean;
  /** True when the body was truncated to `MAX_SKILL_BODY_CHARS`. */
  truncated: boolean;
}

export class SkillSessionIndex {
  /** Entries in name order. */
  readonly entries: SkillSessionEntry[] = [];
  /** Per-file tier-1 errors collected during `open()`. */
  readonly errors: Array<{ file: string; error: string }> = [];
  /** Roots this index was opened over (in the order given). */
  readonly roots: string[];

  private readonly maxCachedBodies: number;
  private readonly maxBodyChars: number;
  /** name -> body text, insertion-ordered (LRU via delete+re-set). */
  private readonly bodyCache = new Map<string, string>();
  /** name -> entry, for O(1) lookup. */
  private readonly byName = new Map<string, SkillSessionEntry>();

  private constructor(
    entries: SkillSessionEntry[],
    errors: Array<{ file: string; error: string }>,
    roots: string[],
    opts: SkillSessionIndexOptions,
  ) {
    this.roots = [...roots];
    this.maxCachedBodies = opts.maxCachedBodies ?? 8;
    this.maxBodyChars = opts.maxBodyChars ?? 200_000;
    for (const entry of entries) {
      this.entries.push(entry);
      this.byName.set(entry.name, entry);
    }
    this.errors.push(...errors);
  }

  /**
   * Open a session index over one or more skill roots. Each root is a
   * directory holding loose `*.md` skills and/or `<name>/SKILL.md`
   * skill directories (the same layout `loadSkillsFromDir` accepts).
   * Only frontmatter is read. A missing root is not an error.
   */
  static open(roots: string[], opts: SkillSessionIndexOptions = {}): SkillSessionIndex {
    const laterRootsOverride = opts.laterRootsOverride ?? true;
    const entries: SkillSessionEntry[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    const byName = new Map<string, SkillSessionEntry>();

    const upsert = (entry: SkillSessionEntry): void => {
      const existing = byName.get(entry.name);
      if (existing) {
        if (!laterRootsOverride) return;
        const at = entries.indexOf(existing);
        entries[at] = entry;
        byName.set(entry.name, entry);
        return;
      }
      entries.push(entry);
      byName.set(entry.name, entry);
    };

    for (const root of roots) {
      let dirEntries: string[];
      try {
        dirEntries = fs.readdirSync(root).sort();
      } catch {
        continue; // Missing root: not an error.
      }
      for (const name of dirEntries) {
        const full = path.join(root, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        try {
          if (stat.isDirectory()) {
            let isSkill = false;
            try {
              isSkill = fs.statSync(path.join(full, SKILL_FILE_NAME)).isFile();
            } catch {
              isSkill = false;
            }
            if (!isSkill) continue;
            const skill = loadSkillDir(full, 'user');
            upsert(toEntry(skill, root, false));
          } else if (stat.isFile() && name.endsWith('.md')) {
            const skill = loadSkillFileMetadata(full, 'user');
            upsert(toEntry(skill, root, true));
          }
        } catch (err) {
          errors.push({ file: full, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    return new SkillSessionIndex(entries, errors, roots, opts);
  }

  /** Number of skills in the index. */
  get size(): number {
    return this.entries.length;
  }

  /** Names in the index, sorted. */
  get names(): string[] {
    return this.entries.map((e) => e.name);
  }

  /** Find one entry by name (tier 1 only — no body read). */
  get(name: string): SkillSessionEntry | undefined {
    return this.byName.get(name);
  }

  /** True when the index contains a skill of this name. */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Tier-1 index entries (`name` + `description` + flags) for the prompt. */
  toIndexEntries(): SkillIndexEntry[] {
    return this.entries.map((e) => ({
      name: e.name,
      description: e.description,
      context: e.context,
      allowedTools: [...e.allowedTools],
    }));
  }

  /**
   * Render the session-start index: one `name — description` line per
   * skill the model may invoke. Skills with
   * `disable-model-invocation` are listed under a separate heading so
   * the model knows they exist but must not trigger them itself.
   * `userInvocable: false` skills are omitted entirely (hidden from
   * the `/` menu AND from the model).
   */
  formatIndex(): string {
    const invocable = this.entries.filter((e) => e.userInvocable && !e.disableModelInvocation);
    const userOnly = this.entries.filter((e) => e.userInvocable && e.disableModelInvocation);
    const lines: string[] = ['Available skills (use one when its description matches the task):'];
    for (const e of invocable) {
      const tools = e.allowedTools.length > 0 ? ` [tools: ${e.allowedTools.join(', ')}]` : '';
      const fork = e.context === 'fork' ? ' (runs in a subagent)' : '';
      lines.push(`- ${e.name}: ${e.description}${tools}${fork}`);
    }
    if (userOnly.length > 0) {
      lines.push('User-invoked only (never trigger these yourself — only the user may ask for them):');
      for (const e of userOnly) lines.push(`- ${e.name}: ${e.description}`);
    }
    return lines.join('\n');
  }

  /** Total header tokens of the whole index (the startup-prompt price). */
  totalHeaderTokens(): number {
    return this.entries.reduce((sum, e) => sum + e.headerTokens, 0);
  }

  /** Total body tokens of the bodies currently cached. */
  cachedBodyTokens(): number {
    let sum = 0;
    for (const name of this.bodyCache.keys()) {
      const entry = this.byName.get(name);
      if (entry) sum += entry.bodyTokens;
    }
    return sum;
  }

  /** Names whose bodies are currently cached, LRU order (oldest first). */
  cachedBodyNames(): string[] {
    return [...this.bodyCache.keys()];
  }

  /**
   * Tier 2: load one skill's body (cache hit when already loaded).
   * Returns the body + token estimate. Throws when the skill is
   * unknown, its file is unreadable, or the file exceeds the cap.
   * The cached body is the RAW body (untruncated); callers that inject
   * it into a prompt should truncate with `truncateSkillBody`.
   */
  ensureBody(name: string): SkillSessionBody {
    const entry = this.byName.get(name);
    if (!entry) throw new Error(`No skill named ${JSON.stringify(name)} in this session index.`);
    const cached = this.bodyCache.get(name);
    if (cached !== undefined) {
      // Refresh LRU position.
      this.bodyCache.delete(name);
      this.bodyCache.set(name, cached);
      return { name, body: cached, bodyTokens: entry.bodyTokens, fromCache: true, truncated: false };
    }
    if (!entry.filePath) throw new Error(`Skill "${name}" has no file to load a body from.`);
    let text: string;
    try {
      text = fs.readFileSync(entry.filePath, 'utf8');
    } catch {
      throw new Error(`Cannot read skill file "${entry.filePath}".`);
    }
    if (text.length > this.maxBodyChars) {
      throw new Error(
        `Skill "${name}" file is ${text.length} chars — over the ${this.maxBodyChars}-char session cap.`,
      );
    }
    const body = extractSkillBody(text, entry.filePath);
    const bodyTokens = estimateTokens(body);
    const truncated = body.length > MAX_SKILL_BODY_CHARS;
    const stored = truncated ? body.slice(0, MAX_SKILL_BODY_CHARS) : body;
    // Evict LRU bodies until there is room.
    while (this.bodyCache.size >= this.maxCachedBodies && this.bodyCache.size > 0) {
      const oldest = this.bodyCache.keys().next().value as string;
      this.bodyCache.delete(oldest);
      const evicted = this.byName.get(oldest);
      if (evicted) {
        evicted.bodyLoaded = false;
        evicted.bodyTokens = 0;
      }
    }
    this.bodyCache.set(name, stored);
    entry.bodyLoaded = true;
    entry.bodyTokens = estimateTokens(stored);
    return { name, body: stored, bodyTokens: entry.bodyTokens, fromCache: false, truncated };
  }

  /**
   * Drop one cached body (frees memory; the entry stays and can be
   * re-loaded). Returns true when a body was cached.
   */
  dropBody(name: string): boolean {
    const dropped = this.bodyCache.delete(name);
    const entry = this.byName.get(name);
    if (entry) {
      entry.bodyLoaded = false;
      entry.bodyTokens = 0;
    }
    return dropped;
  }

  /** Drop every cached body. */
  clearBodies(): void {
    for (const name of [...this.bodyCache.keys()]) this.dropBody(name);
  }

  /**
   * Tier 3: read one resource file of a skill (`scripts/…`,
   * `references/…`, `assets/…`). Only reads — never executes.
   * Throws when the skill is unknown or the path is invalid.
   */
  readResource(name: string, relPath: string): string {
    const entry = this.byName.get(name);
    if (!entry) throw new Error(`No skill named ${JSON.stringify(name)} in this session index.`);
    if (!entry.skillDir) {
      throw new Error(`Skill "${name}" is a loose file and has no resources directory.`);
    }
    const skill: Skill = {
      name: entry.name,
      description: entry.description,
      version: entry.version,
      whenToUse: '',
      tools: entry.allowedTools,
      allowedTools: entry.allowedTools,
      license: entry.license,
      compatibility: entry.compatibility,
      context: entry.context,
      disableModelInvocation: entry.disableModelInvocation,
      userInvocable: entry.userInvocable,
      body: '',
      bodyLoaded: false,
      skillDir: entry.skillDir,
      resources: entry.resources,
      source: 'user',
      filePath: entry.filePath,
      enabled: true,
    };
    return readSkillResource(skill, relPath);
  }

  /**
   * Resolve a resource path for execution by the caller (tier 3).
   * Returns the absolute path, or undefined when invalid — the index
   * itself never executes anything.
   */
  resourcePath(name: string, relPath: string): string | undefined {
    const entry = this.byName.get(name);
    if (!entry || !entry.skillDir) return undefined;
    const skill: Skill = {
      name: entry.name,
      description: entry.description,
      version: entry.version,
      whenToUse: '',
      tools: entry.allowedTools,
      allowedTools: entry.allowedTools,
      disableModelInvocation: entry.disableModelInvocation,
      userInvocable: entry.userInvocable,
      body: '',
      bodyLoaded: false,
      skillDir: entry.skillDir,
      resources: entry.resources,
      source: 'user',
      filePath: entry.filePath,
      enabled: true,
    };
    return resolveSkillResourcePath(skill, relPath);
  }

  /** Session stats for logs: counts + token costs. */
  stats(): {
    skills: number;
    errors: number;
    headerTokens: number;
    cachedBodies: number;
    cachedBodyTokens: number;
    userOnly: number;
    fork: number;
  } {
    return {
      skills: this.entries.length,
      errors: this.errors.length,
      headerTokens: this.totalHeaderTokens(),
      cachedBodies: this.bodyCache.size,
      cachedBodyTokens: this.cachedBodyTokens(),
      userOnly: this.entries.filter((e) => e.disableModelInvocation).length,
      fork: this.entries.filter((e) => e.context === 'fork').length,
    };
  }
}

function toEntry(skill: Skill, rootDir: string, looseFile: boolean): SkillSessionEntry {
  const headerTokens = estimateTokens(`${skill.name} — ${skill.description}`);
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    context: skill.context,
    allowedTools: [...skill.allowedTools],
    license: skill.license,
    compatibility: skill.compatibility,
    disableModelInvocation: skill.disableModelInvocation,
    userInvocable: skill.userInvocable,
    resources: skill.resources ?? emptySkillResources(),
    rootDir,
    filePath: skill.filePath,
    skillDir: skill.skillDir,
    headerTokens,
    bodyTokens: 0,
    bodyLoaded: false,
    looseFile,
  };
}

/**
 * Open a session index over roots and return `{ index, errors }`
 * (same shape as `loadSkillsFromDir`'s result, for callers that
 * already handle that pair). Prefer `SkillSessionIndex.open` directly.
 */
export function openSkillSessionIndex(
  roots: string[],
  opts: SkillSessionIndexOptions = {},
): SkillSessionOpenResult {
  const index = SkillSessionIndex.open(roots, opts);
  return { index, errors: [...index.errors] };
}
