/**
 * Agent Skills v15 — compatibility-aware skill registry (v1.36, Team T2).
 *
 * The registry is a plain JSON index over the discovery roots. Each
 * entry carries the structured `compatibility` field v15 adds: which
 * platforms the skill supports, which it refuses, and the free-text
 * requirements from its frontmatter — parsed once at index time so
 * every consumer (tools, UI, export planner) reads the same verdicts
 * instead of re-parsing raw frontmatter.
 *
 * - `refresh()` rebuilds the index from the v14 loader (tier-1
 *   headers only — bodies are never read to build the index).
 * - `filter()` answers the questions the export planner asks: which
 *   skills run on `codex`? which are portable (all five platforms)?
 *   which state no compatibility at all?
 * - `compatibilityMatrix()` is the skill × platform table, one row
 *   per skill, for the UI and for `skills_v15_registry`.
 * - `save()` / `load()` persist the index as JSON; a corrupt or
 *   foreign index file is refused, never silently trusted.
 * - The registry never edits a skill: enabling/disabling stays in
 *   the v14 tier-state file, and the registry only records the
 *   `enabled` flag it observed.
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillV14Loader } from '../v14/loader.js';
import type { SkillV14Header } from '../v14/types.js';
import { SKILL_V15_PLATFORMS, SKILL_V15_REGISTRY_FILE } from './types.js';
import type {
  SkillV15Compatibility,
  SkillV15MatrixRow,
  SkillV15PlatformId,
  SkillV15RegistryEntry,
  SkillV15RegistryFilter,
  SkillV15RegistryOptions,
} from './types.js';
import { checkAllPlatformsV15, isPortableV15, parseCompatibilityV15 } from './platforms.js';

/** Registry index file format version. */
export const SKILL_V15_REGISTRY_FORMAT = 'openbot-skills-v15-registry/1';

export interface SkillV15RegistryFile {
  format: typeof SKILL_V15_REGISTRY_FORMAT;
  indexedAt: string;
  projectRoot: string;
  entries: SkillV15RegistryEntry[];
}

/** Default index file: `<projectRoot>/.agents/<file>`. */
export function defaultRegistryFileV15(projectRoot: string): string {
  return path.join(projectRoot, '.agents', SKILL_V15_REGISTRY_FILE);
}

/** Build one registry entry from a v14 tier-1 header. */
export function registryEntryFromHeaderV15(header: SkillV14Header, indexedAt: string): SkillV15RegistryEntry {
  const compatibility = parseCompatibilityV15(header.compatibility);
  return {
    name: header.name,
    description: header.description,
    dir: header.dir,
    source: header.source,
    version: header.version,
    license: header.license,
    allowedTools: header.allowedTools,
    compatibility,
    enabled: header.enabled,
    headerTokens: header.headerTokens,
    indexedAt,
  };
}

/** Filter entries (all filters combine with AND). */
export function filterRegistryEntriesV15(
  entries: SkillV15RegistryEntry[],
  filter: SkillV15RegistryFilter = {},
): SkillV15RegistryEntry[] {
  const query = filter.query?.trim().toLowerCase() ?? '';
  return entries.filter((entry) => {
    if (filter.platform !== undefined && !entry.compatibility.supported.includes(filter.platform)) return false;
    if (filter.unknownOnly === true && !entry.compatibility.unknown) return false;
    if (filter.portableOnly === true && !isPortableV15(entry.compatibility)) return false;
    if (filter.enabled !== undefined && entry.enabled !== filter.enabled) return false;
    if (query !== '') {
      const hay = `${entry.name} ${entry.description}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

/** One matrix row per entry (skill × platform verdicts). */
export function buildCompatibilityMatrixV15(entries: SkillV15RegistryEntry[]): SkillV15MatrixRow[] {
  return entries
    .map((entry) => {
      const checks = checkAllPlatformsV15(entry.name, entry.compatibility);
      const cells = {} as Record<SkillV15PlatformId, 'supported' | 'unsupported' | 'unknown'>;
      for (const check of checks) cells[check.platform] = check.verdict;
      const supportedCount = checks.filter((c) => c.verdict === 'supported').length;
      return {
        skill: entry.name,
        cells,
        supportedCount,
        portable: isPortableV15(entry.compatibility),
      };
    })
    .sort((a, b) => a.skill.localeCompare(b.skill));
}

/** Format the matrix as a text table (tool output). */
export function formatCompatibilityMatrixV15(rows: SkillV15MatrixRow[]): string {
  if (rows.length === 0) return 'No skills in the v15 registry.';
  const short = (v: 'supported' | 'unsupported' | 'unknown'): string =>
    v === 'supported' ? 'yes' : v === 'unsupported' ? 'no' : '?';
  const header = ['skill', ...SKILL_V15_PLATFORMS.map((p) => p.slice(0, 7)), 'portable'].join(' | ');
  const lines = [`Compatibility matrix (yes = supported, no = refused, ? = undeclared):`, header];
  for (const row of rows) {
    lines.push(
      [
        row.skill,
        ...SKILL_V15_PLATFORMS.map((p) => short(row.cells[p])),
        row.portable ? 'yes' : 'no',
      ].join(' | '),
    );
  }
  return lines.join('\n');
}

/** Format registry entries as a list (tool output). */
export function formatRegistryEntriesV15(entries: SkillV15RegistryEntry[]): string {
  if (entries.length === 0) return 'No skills in the v15 registry.';
  const lines = [`v15 registry: ${entries.length} skill(s).`];
  for (const entry of entries) {
    const compat = entry.compatibility.unknown
      ? 'compatibility undeclared'
      : `runs on: ${entry.compatibility.supported.join(', ') || '—'}` +
        (entry.compatibility.unsupported.length > 0
          ? `; refuses: ${entry.compatibility.unsupported.join(', ')}`
          : '');
    const flags = entry.enabled ? '' : ' [DISABLED]';
    lines.push(`- ${entry.name}${flags} [${entry.source}]: ${entry.description} (${compat}) [~${entry.headerTokens} tokens]`);
  }
  return lines.join('\n');
}

/**
 * The v15 registry: an in-memory index rebuilt from the discovery
 * roots, persisted as JSON. `refresh()` re-reads the roots; `load()`
 * reads the persisted file back (and validates its shape).
 */
export class SkillV15Registry {
  private readonly opts: SkillV15RegistryOptions;
  private entries: SkillV15RegistryEntry[] = [];
  private indexedAt = '';

  constructor(opts: SkillV15RegistryOptions = {}) {
    this.opts = opts;
  }

  get projectRoot(): string {
    return this.opts.projectRoot ?? process.cwd();
  }

  get indexFile(): string {
    return this.opts.indexFile ?? defaultRegistryFileV15(this.projectRoot);
  }

  /** Rebuild the index from the discovery roots (tier-1 headers only). */
  refresh(): SkillV15RegistryEntry[] {
    const indexedAt = new Date().toISOString();
    const loader = new SkillV14Loader({
      projectRoot: this.projectRoot,
      homeDir: this.opts.homeDir ?? os.homedir(),
      projectOnly: this.opts.projectOnly ?? false,
    });
    loader.open();
    this.entries = loader.headers.map((header) => registryEntryFromHeaderV15(header, indexedAt));
    this.indexedAt = indexedAt;
    return this.list();
  }

  /** All entries, alphabetical. */
  list(): SkillV15RegistryEntry[] {
    return [...this.entries].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Number of indexed skills. */
  get size(): number {
    return this.entries.length;
  }

  /** One entry by name, or `undefined`. */
  get(name: string): SkillV15RegistryEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  filter(filter: SkillV15RegistryFilter = {}): SkillV15RegistryEntry[] {
    return filterRegistryEntriesV15(this.list(), filter);
  }

  matrix(): SkillV15MatrixRow[] {
    return buildCompatibilityMatrixV15(this.list());
  }

  /** Skills supported on one platform. */
  supportedOn(platform: SkillV15PlatformId): SkillV15RegistryEntry[] {
    return this.filter({ platform });
  }

  /** Skills whose compatibility is unknown (undeclared). */
  unknownCompatibility(): SkillV15RegistryEntry[] {
    return this.filter({ unknownOnly: true });
  }

  /** Skills supported on all five platforms. */
  portable(): SkillV15RegistryEntry[] {
    return this.filter({ portableOnly: true });
  }

  /** Persist the current index as JSON (creates `.agents/` when needed). */
  save(): string {
    const file: SkillV15RegistryFile = {
      format: SKILL_V15_REGISTRY_FORMAT,
      indexedAt: this.indexedAt === '' ? new Date().toISOString() : this.indexedAt,
      projectRoot: this.projectRoot,
      entries: this.list(),
    };
    const target = this.indexFile;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    return target;
  }

  /** Load a persisted index (validates format + entry shape). */
  load(): SkillV15RegistryEntry[] {
    const target = this.indexFile;
    if (!fs.existsSync(target)) {
      throw new Error(`No v15 registry index at ${JSON.stringify(target)} — run refresh + save first.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
    } catch {
      throw new Error(`Registry index ${JSON.stringify(target)} is not valid JSON.`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Registry index must be a JSON object.');
    }
    const raw = parsed as Record<string, unknown>;
    if (raw['format'] !== SKILL_V15_REGISTRY_FORMAT) {
      throw new Error(
        `Registry index format ${JSON.stringify(raw['format'])} is not ${JSON.stringify(SKILL_V15_REGISTRY_FORMAT)} — refusing to load.`,
      );
    }
    if (!Array.isArray(raw['entries'])) {
      throw new Error('Registry index has no entries list.');
    }
    const entries: SkillV15RegistryEntry[] = [];
    for (const item of raw['entries'] as unknown[]) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Registry index entry must be an object.');
      }
      const e = item as Record<string, unknown>;
      if (typeof e['name'] !== 'string' || typeof e['description'] !== 'string' || typeof e['dir'] !== 'string') {
        throw new Error('Registry index entry needs "name", "description" and "dir".');
      }
      if (e['compatibility'] === null || typeof e['compatibility'] !== 'object' || Array.isArray(e['compatibility'])) {
        throw new Error(`Registry index entry ${JSON.stringify(e['name'])} has no structured compatibility — refusing to load.`);
      }
      const compat = e['compatibility'] as Record<string, unknown>;
      if (
        typeof compat['unknown'] !== 'boolean' ||
        !Array.isArray(compat['supported']) ||
        !Array.isArray(compat['unsupported']) ||
        !Array.isArray(compat['requirements']) ||
        !Array.isArray(compat['entries'])
      ) {
        throw new Error(`Registry index entry ${JSON.stringify(e['name'])} has a malformed compatibility field.`);
      }
      entries.push(item as unknown as SkillV15RegistryEntry);
    }
    this.entries = entries;
    this.indexedAt = typeof raw['indexedAt'] === 'string' ? raw['indexedAt'] : '';
    return this.list();
  }
}

/** Convenience: refresh a registry and return its entries. */
export function refreshRegistryV15(opts: SkillV15RegistryOptions = {}): SkillV15RegistryEntry[] {
  return new SkillV15Registry(opts).refresh();
}
