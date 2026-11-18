/**
 * Agent Skills v14 — progressive-disclosure loader (v1.34, Team T1).
 *
 * Progressive disclosure is the core of the Agent Skills format: the
 * agent must NOT pay the context cost of every skill up front.
 *
 *   Tier 1 — headers only: `open()` scans the discovery roots and reads
 *   only each skill's frontmatter (`name` + `description` + a few header
 *   fields). The compact header index is what goes into context at
 *   session start (see `headersForContext()`).
 *   Tier 2 — body on activation: `activate(name)` reads the full
 *   `SKILL.md` body, and only for the skill the agent actually chose.
 *   Bodies are cached (LRU, bounded) so re-activation is free.
 *   Tier 3 — resources on demand: `loadResource(name, relPath)` reads
 *   one file from `scripts/` / `references/` / `assets/`, only when the
 *   skill body says it is needed. Paths are contained inside the skill
 *   directory — `..` and absolute paths are refused.
 *
 * Invalid skills are never fatal: a skill that fails strict v14
 * validation is listed in `errors` and skipped, while the healthy
 * skills keep loading. The loader is also the runtime hook: the agent
 * loop calls `skills_v14_list` (tier 1) at session start and
 * `skills_v14_activate` (tier 2) when it decides a skill applies —
 * see `packages/tools/src/skillsV14Tools.ts`.
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverSkillsV14 } from './discovery.js';
import { isProjectLocalV14 } from './discovery.js';
import { buildUsageEntryV14, recordActivationV14 } from './usage.js';
import {
  estimateTokensV14,
  splitSkillTextV14,
  validateSkillDirV14,
} from './validator.js';
import { SKILL_V14_FILE_NAME } from './types.js';
import type {
  DiscoveredSkillV14,
  SkillV14Activation,
  SkillV14Header,
  SkillV14LoaderOptions,
  SkillV14Resource,
  SkillV14Tier,
} from './types.js';

/** Maximum bodies kept in the activation cache (LRU eviction). */
export const SKILL_V14_BODY_CACHE_SIZE = 32;

/** Directories a tier-3 resource may come from. */
export const SKILL_V14_RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const;

/** One skill that failed to load, with the reason (header never loaded). */
export interface SkillV14LoadError {
  name: string;
  dir: string;
  error: string;
}

/** Result of opening a loader: headers ready, errors listed separately. */
export interface SkillV14OpenResult {
  headers: SkillV14Header[];
  errors: SkillV14LoadError[];
  scannedRoots: string[];
  missingRoots: string[];
}

/**
 * Resolve `relPath` inside `skillDir` and refuse anything that escapes
 * it (`..`, absolute paths, or symlinks pointing outside). Returns the
 * absolute path, or throws.
 */
export function resolveSkillResourcePathV14(skillDir: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`Resource path ${JSON.stringify(relPath)} must be relative to the skill directory.`);
  }
  const base = path.resolve(skillDir);
  const target = path.resolve(base, relPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Resource path ${JSON.stringify(relPath)} escapes the skill directory.`);
  }
  // Refuse symlinks that point outside the skill directory.
  let realBase: string = base;
  let realTarget: string = target;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    // Base missing — the caller reports the missing file instead.
  }
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    // Target missing — containment by lexical path already passed.
    return target;
  }
  if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
    throw new Error(`Resource path ${JSON.stringify(relPath)} resolves outside the skill directory (symlink).`);
  }
  return target;
}

/** Read one tier-1 header from a discovered skill directory. Throws on invalid skills. */
export function loadSkillHeaderV14(discovered: DiscoveredSkillV14, isEnabled: (name: string) => boolean): SkillV14Header {
  const validation = validateSkillDirV14(discovered.dir, { skipScriptScan: true });
  if (!validation.valid || validation.frontmatter === undefined) {
    const first = validation.errors[0];
    throw new Error(first ? `${first.code}: ${first.message}` : `Skill ${JSON.stringify(discovered.name)} failed validation.`);
  }
  const fm = validation.frontmatter;
  return {
    name: fm.name,
    description: fm.description,
    dir: discovered.dir,
    source: discovered.source,
    license: fm.license,
    compatibility: fm.compatibility,
    allowedTools: fm.allowedTools,
    headerTokens: validation.headerTokens,
    enabled: isEnabled(fm.name),
  };
}

/**
 * Progressive-disclosure loader: tier-1 headers at open, tier-2 bodies
 * on activation, tier-3 resources on demand.
 */
export class SkillV14Loader {
  private readonly opts: SkillV14LoaderOptions;
  private readonly isEnabledFn: (name: string) => boolean;
  private headersByName = new Map<string, SkillV14Header>();
  private bodyCache = new Map<string, SkillV14Activation>();
  /** Skills that failed validation at open (listed, never fatal). */
  errors: SkillV14LoadError[] = [];
  scannedRoots: string[] = [];
  missingRoots: string[] = [];

  constructor(opts: SkillV14LoaderOptions = {}) {
    this.opts = opts;
    this.isEnabledFn = opts.isEnabled ?? (() => true);
  }

  /** Scan the discovery roots and load tier-1 headers only. */
  open(): SkillV14OpenResult {
    this.headersByName.clear();
    this.bodyCache.clear();
    this.errors = [];
    const discovered = discoverSkillsV14(this.opts);
    this.scannedRoots = discovered.scannedRoots;
    this.missingRoots = discovered.missingRoots;
    const extra = this.opts.extraRoots ?? [];
    for (const root of extra) {
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        this.missingRoots.push(root);
        continue;
      }
      this.scannedRoots.push(root);
    }
    for (const skill of discovered.skills) {
      try {
        const header = loadSkillHeaderV14(skill, this.isEnabledFn);
        this.headersByName.set(header.name, header);
      } catch (e) {
        this.errors.push({ name: skill.name, dir: skill.dir, error: (e as Error).message });
      }
    }
    // Extra roots are lowest priority: only fill names not already present.
    for (const root of extra) {
      if (!fs.existsSync(root)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const dir = path.join(root, entry.name);
        if (!fs.existsSync(path.join(dir, SKILL_V14_FILE_NAME))) continue;
        if (this.headersByName.has(entry.name)) continue;
        try {
          const header = loadSkillHeaderV14(
            { name: entry.name, dir, source: 'global-agents', root, shadowed: false, shadowedDirs: [] },
            this.isEnabledFn,
          );
          this.headersByName.set(header.name, header);
        } catch (e) {
          this.errors.push({ name: entry.name, dir, error: (e as Error).message });
        }
      }
    }
    return { headers: this.headers, errors: this.errors, scannedRoots: this.scannedRoots, missingRoots: this.missingRoots };
  }

  /** Tier-1 headers, project-local first, then alphabetical. */
  get headers(): SkillV14Header[] {
    return [...this.headersByName.values()].sort((a, b) => {
      const aLocal = isProjectLocalV14(a.source) ? 0 : 1;
      const bLocal = isProjectLocalV14(b.source) ? 0 : 1;
      if (aLocal !== bLocal) return aLocal - bLocal;
      return a.name.localeCompare(b.name);
    });
  }

  /** Number of loadable skills (tier-1 headers). */
  get size(): number {
    return this.headersByName.size;
  }

  /** Total tier-1 token cost of the whole header index. */
  totalHeaderTokens(): number {
    return this.headers.reduce((sum, h) => sum + h.headerTokens, 0);
  }

  /** Tier-1 header for one skill, or `undefined` when unknown/disabled-by-load-error. */
  header(name: string): SkillV14Header | undefined {
    return this.headersByName.get(name);
  }

  /** Only the enabled skills' headers (disabled skills stay out of context). */
  enabledHeaders(): SkillV14Header[] {
    return this.headers.filter((h) => h.enabled);
  }

  /**
   * Tier 2 — activate a skill: read its full SKILL.md body. The body is
   * cached (LRU, 32 entries); re-activation does not re-read the disk.
   * Throws when the skill is unknown or its file cannot be read.
   */
  activate(name: string): SkillV14Activation {
    const cached = this.bodyCache.get(name);
    if (cached !== undefined) {
      // Refresh LRU position.
      this.bodyCache.delete(name);
      this.bodyCache.set(name, cached);
      return cached;
    }
    const header = this.headersByName.get(name);
    if (header === undefined) {
      throw new Error(`Unknown skill ${JSON.stringify(name)} — it is not in the v14 header index (run list first).`);
    }
    let text: string;
    try {
      text = fs.readFileSync(path.join(header.dir, SKILL_V14_FILE_NAME), 'utf8');
    } catch {
      throw new Error(`Cannot read ${SKILL_V14_FILE_NAME} for skill ${JSON.stringify(name)}.`);
    }
    const split = splitSkillTextV14(text);
    if (split === null) {
      throw new Error(`Skill ${JSON.stringify(name)} has no frontmatter fence — it should not have passed open().`);
    }
    const activation: SkillV14Activation = {
      ...header,
      body: split.body,
      bodyTokens: estimateTokensV14(split.body),
    };
    if (this.opts.usageLogFile !== undefined) {
      recordActivationV14(
        this.opts.usageLogFile,
        buildUsageEntryV14(activation.name, activation.bodyTokens, activation.source),
      );
    }
    this.bodyCache.set(name, activation);
    while (this.bodyCache.size > SKILL_V14_BODY_CACHE_SIZE) {
      const oldest = this.bodyCache.keys().next().value;
      if (oldest === undefined) break;
      this.bodyCache.delete(oldest);
    }
    return activation;
  }

  /** Is this skill's body currently cached (tier 2 already loaded)? */
  isBodyCached(name: string): boolean {
    return this.bodyCache.has(name);
  }

  /** Drop one cached body, or all of them. */
  evictBody(name?: string): void {
    if (name === undefined) this.bodyCache.clear();
    else this.bodyCache.delete(name);
  }

  /**
   * Tier 3 — load one resource file from `scripts/`, `references/` or
   * `assets/` on demand. The path must stay inside the skill directory.
   */
  loadResource(name: string, relPath: string): SkillV14Resource {
    const header = this.headersByName.get(name);
    if (header === undefined) {
      throw new Error(`Unknown skill ${JSON.stringify(name)} — it is not in the v14 header index.`);
    }
    // Resolve first: absolute paths and ".." escapes are refused here with
    // their own messages ("must be relative" / "escapes the skill directory")
    // before the tier-prefix check reports the wrong reason for them.
    const target = resolveSkillResourcePathV14(header.dir, relPath);
    const first = relPath.split('/')[0] ?? '';
    if (!(SKILL_V14_RESOURCE_DIRS as readonly string[]).includes(first)) {
      throw new Error(
        `Resource ${JSON.stringify(relPath)} must live under one of ${SKILL_V14_RESOURCE_DIRS.join(', ')} — tier-3 resources never come from the skill root.`,
      );
    }
    let content: string;
    let bytes: number;
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error('not a file');
      bytes = stat.size;
      content = fs.readFileSync(target, 'utf8');
    } catch {
      throw new Error(`Resource ${JSON.stringify(relPath)} not found in skill ${JSON.stringify(name)}.`);
    }
    return { name, relPath, content, bytes };
  }

  /** List tier-3 resources of a skill (names only — contents stay on disk until loaded). */
  listResources(name: string, tier: SkillV14Tier = 3): string[] {
    const header = this.headersByName.get(name);
    if (header === undefined) {
      throw new Error(`Unknown skill ${JSON.stringify(name)} — it is not in the v14 header index.`);
    }
    const out: string[] = [];
    for (const sub of SKILL_V14_RESOURCE_DIRS) {
      const dir = path.join(header.dir, sub);
      if (!fs.existsSync(dir)) continue;
      const walk = (current: string, relBase: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
          if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
          else if (entry.isFile()) out.push(`${sub}/${rel}`);
        }
      };
      walk(dir, '');
    }
    void tier;
    return out.sort();
  }

  /**
   * The compact text injected into context at session start: one line
   * per enabled skill — name + description only. Bodies and resources
   * are deliberately absent (tiers 2–3 load on activation, never here).
   */
  headersForContext(): string {
    const enabled = this.enabledHeaders();
    if (enabled.length === 0) return 'No v14 skills installed.';
    const lines: string[] = [
      `Available skills (v14, ${enabled.length} enabled, ~${enabled.reduce((s, h) => s + h.headerTokens, 0)} tokens):`,
    ];
    for (const h of enabled) {
      const tools = h.allowedTools !== undefined && h.allowedTools.length > 0 ? ` [tools: ${h.allowedTools.join(', ')}]` : '';
      lines.push(`- ${h.name}: ${h.description}${tools}`);
    }
    lines.push('Load a skill body only when its description matches the task (skills_v14_activate).');
    return lines.join('\n');
  }
}

/** Convenience: open a loader over the standard roots and return it. */
export function openSkillV14Loader(opts: SkillV14LoaderOptions = {}): SkillV14Loader {
  const loader = new SkillV14Loader(opts);
  loader.open();
  return loader;
}

/** Convenience: build the session-start header block without keeping a loader. */
export function v14HeadersForContext(opts: SkillV14LoaderOptions = {}): string {
  return openSkillV14Loader(opts).headersForContext();
}
