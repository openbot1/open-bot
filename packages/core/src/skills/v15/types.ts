/**
 * Agent Skills v15 — shared types + multi-platform constants (v1.36, Team T2).
 *
 * v15 builds on the strict AAIF v14 base and adds the open-standard
 * multi-platform layer from the v136 survey (agentskills.io / AAIF):
 *
 * - One canonical skill directory (`.agents/skills/<name>/`) mirrored to
 *   the per-host roots every major host scans: Claude Code
 *   (`.claude/skills/`), GitHub Copilot (`.github/skills/`), Codex
 *   (`.codex/skills/`), OpenCode (`.opencode/skills/`). Mirrors are
 *   either real copies or symlinks back to the canonical dir.
 * - A structured `compatibility` field on every registry entry: which
 *   platforms a skill supports, which it does not, and the free-text
 *   requirements (tools, environment) the raw frontmatter states.
 * - Progressive disclosure with budgets: tier-1 headers, tier-2 bodies
 *   and tier-3 resources are all accounted against a session budget,
 *   with LRU eviction of activated bodies when the budget is exceeded.
 * - Migration of older (v13 / pre-standard) skills into the v15 layout:
 *   legacy `tools:` frontmatter becomes `allowed-tools`, the directory
 *   name is normalised, and a `compatibility` line is added.
 *
 * Everything in this subsystem is original open-bot code; only the
 * spec rules (the five host roots, the six frontmatter fields, the
 * three disclosure tiers) come from the public Agent Skills spec.
 */

import type { SkillV14Validation } from '../v14/types.js';

// --- Platforms --------------------------------------------------------------

/**
 * Host platforms a skill can be exported to. `openbot` is the
 * canonical open-bot root (`.agents/skills/` — the shared standard
 * location every host reads); the other four are the per-host roots.
 */
export type SkillV15PlatformId = 'openbot' | 'claude' | 'github' | 'codex' | 'opencode';

/** All five platform ids, canonical first. */
export const SKILL_V15_PLATFORMS: readonly SkillV15PlatformId[] = [
  'openbot',
  'claude',
  'github',
  'codex',
  'opencode',
] as const;

/** Where a platform keeps project-local skills, relative to the project root. */
export const SKILL_V15_PROJECT_ROOTS: Readonly<Record<SkillV15PlatformId, string>> = {
  openbot: '.agents/skills',
  claude: '.claude/skills',
  github: '.github/skills',
  codex: '.codex/skills',
  opencode: '.opencode/skills',
} as const;

/** Where a platform keeps global (per-user) skills, relative to the home dir. */
export const SKILL_V15_GLOBAL_ROOTS: Readonly<Record<SkillV15PlatformId, string>> = {
  openbot: '.agents/skills',
  claude: '.claude/skills',
  github: '.github/skills',
  codex: '.codex/skills',
  opencode: '.opencode/skills',
} as const;

/**
 * Which project-local roots each host actually scans (from the survey):
 * OpenCode also reads `.claude/skills/` and `.agents/skills/`; Codex
 * reads `.agents/skills/`; Copilot only its own `.github/skills/`.
 * `openbot` reads every root (it is the canonical superset).
 */
export const SKILL_V15_HOST_READ_ROOTS: Readonly<Record<SkillV15PlatformId, readonly SkillV15PlatformId[]>> = {
  openbot: ['openbot', 'claude', 'github', 'codex', 'opencode'],
  claude: ['claude', 'openbot'],
  github: ['github'],
  codex: ['codex', 'openbot'],
  opencode: ['opencode', 'claude', 'openbot'],
} as const;

/** How a mirror is materialised on disk. */
export type SkillV15MirrorMode = 'copy' | 'symlink';

/** Bundle manifest format stamped by v15 multi-platform exports. */
export const SKILL_V15_BUNDLE_FORMAT = 'openbot-skills-v15-bundle/1';
/** Registry index file written by the v15 registry (JSON). */
export const SKILL_V15_REGISTRY_FILE = 'skills-v15-registry.json';
/** Default disclosure budgets (see disclosure.ts). */
export const SKILL_V15_DEFAULT_MAX_HEADERS = 64;
export const SKILL_V15_DEFAULT_MAX_HEADER_TOKENS = 6_400;
export const SKILL_V15_DEFAULT_MAX_BODY_TOKENS = 24_000;
export const SKILL_V15_DEFAULT_MAX_RESOURCE_BYTES = 1_000_000;
/** A single tier-3 resource is never read past this size. */
export const SKILL_V15_MAX_RESOURCE_BYTES = 2_000_000;

// --- Compatibility ----------------------------------------------------------

/** One parsed compatibility entry: a platform, or a free-text requirement. */
export type SkillV15CompatibilityEntry =
  | { kind: 'platform'; platform: SkillV15PlatformId; supported: boolean }
  | { kind: 'requirement'; text: string };

/**
 * Structured `compatibility` for one skill: which platforms it
 * supports, which it explicitly does not, and the free-text
 * requirements carried over from the raw frontmatter (e.g.
 * "Requires git + a code search tool"). A skill with no `compatibility`
 * frontmatter at all is treated as "unknown — assumed portable":
 * `platforms` is empty and `unknown` is true.
 */
export interface SkillV15Compatibility {
  /** Raw frontmatter value, verbatim (string or list). */
  raw?: string | string[];
  /** `true` when the skill states no compatibility at all. */
  unknown: boolean;
  /** Platforms the skill claims to support. */
  supported: SkillV15PlatformId[];
  /** Platforms the skill explicitly says it does NOT support. */
  unsupported: SkillV15PlatformId[];
  /** Free-text requirements that name no known platform. */
  requirements: string[];
  /** Parsed entries, in frontmatter order (for reporting). */
  entries: SkillV15CompatibilityEntry[];
}

/** Result of checking one skill against one platform. */
export interface SkillV15PlatformCheck {
  skill: string;
  platform: SkillV15PlatformId;
  /** `supported` / `unsupported` / `unknown` (no compatibility stated). */
  verdict: 'supported' | 'unsupported' | 'unknown';
  /** Human-readable reason (never echoes secret-looking text). */
  reason: string;
  /** Free-text requirements that apply on this platform. */
  requirements: string[];
}

/** One row of the skill × platform compatibility matrix. */
export interface SkillV15MatrixRow {
  skill: string;
  /** Verdict per platform, in SKILL_V15_PLATFORMS order. */
  cells: Record<SkillV15PlatformId, 'supported' | 'unsupported' | 'unknown'>;
  /** Platforms the skill is known to support. */
  supportedCount: number;
  /** `true` when the skill is supported on every platform. */
  portable: boolean;
}

// --- Multi-platform import / export -----------------------------------------

/** Install state of one skill on one platform root. */
export type SkillV15InstallState =
  | 'missing'
  | 'copy'
  | 'symlink'
  | 'stale-copy'
  | 'broken-link'
  | 'invalid';

/** One platform's view of one skill. */
export interface SkillV15PlatformInstall {
  platform: SkillV15PlatformId;
  /** Absolute root that was inspected (`<project>/.claude/skills/` …). */
  root: string;
  /** Absolute skill directory on this platform ('' when missing). */
  dir: string;
  state: SkillV15InstallState;
  /** For `symlink`: where the link points. For `stale-copy`: the differing file. */
  detail: string;
  /** SHA-256 of the skill's SKILL.md when readable, else ''. */
  skillMdSha256: string;
}

/** Status of one skill across all five platforms. */
export interface SkillV15MultiStatus {
  name: string;
  /** Canonical (`.agents/skills/`) install, when present. */
  canonical: SkillV15PlatformInstall | null;
  installs: SkillV15PlatformInstall[];
  /** Platforms where the skill is present (copy or symlink). */
  installedOn: SkillV15PlatformId[];
  /** Platforms where the skill is missing entirely. */
  missingOn: SkillV15PlatformId[];
  /** Platforms whose copy drifted from the canonical dir. */
  staleOn: SkillV15PlatformId[];
}

/** One mirror written by a multi-platform export. */
export interface SkillV15MirrorResult {
  platform: SkillV15PlatformId;
  root: string;
  dir: string;
  mode: SkillV15MirrorMode;
  /** `true` when an older mirror was replaced. */
  replaced: boolean;
  /** Number of files written (copies) — 0 for a symlink mirror. */
  fileCount: number;
}

export interface ExportMultiPlatformV15Options {
  /** Platforms to mirror to (default: all except the canonical one). */
  platforms?: SkillV15PlatformId[];
  /** `copy` (default) or `symlink` back to the canonical dir. */
  mode?: SkillV15MirrorMode;
  /** Overwrite an existing mirror of the same skill. Default: `false`. */
  overwrite?: boolean;
  /** Global (home-dir) roots instead of project-local ones. Default: project-local. */
  global?: boolean;
  /** Home directory for global roots. Defaults to `os.homedir()`. */
  homeDir?: string;
}

export interface ExportMultiPlatformV15Result {
  name: string;
  canonicalDir: string;
  mirrors: SkillV15MirrorResult[];
  /** Platforms skipped because a mirror already existed and `overwrite` was false. */
  skipped: SkillV15PlatformId[];
  validationQuality: number;
}

export interface ImportFromPlatformV15Options {
  /** Overwrite the canonical skill when one already exists. Default: `false`. */
  overwrite?: boolean;
  /** Also mirror the imported skill to the other platforms. Default: `false`. */
  mirrorAfterImport?: boolean;
  mirrorMode?: SkillV15MirrorMode;
}

export interface ImportFromPlatformV15Result {
  name: string;
  fromPlatform: SkillV15PlatformId;
  fromDir: string;
  canonicalDir: string;
  overwritten: boolean;
  mirrors: SkillV15MirrorResult[];
  validationQuality: number;
}

/** Returned instead of throwing when the canonical skill already exists. */
export interface SkillV15OverwriteNeeded {
  needsOverwriteConfirm: true;
  name: string;
  existingDir: string;
  sourceDir: string;
  sourcePlatform: SkillV15PlatformId;
}

// --- Progressive disclosure with budgets ------------------------------------

/** Budget limits for one disclosure session. */
export interface SkillV15Budget {
  /** Max tier-1 headers kept in context. Default 64. */
  maxHeaders?: number;
  /** Max tier-1 header tokens. Default 6.400. */
  maxHeaderTokens?: number;
  /** Max tier-2 body tokens held at once (LRU eviction past this). Default 24.000. */
  maxBodyTokens?: number;
  /** Max bytes of one tier-3 resource. Default 1.000.000. */
  maxResourceBytes?: number;
}

/** What a disclosure session has loaded so far (for reporting). */
export interface SkillV15DisclosureUsage {
  headersLoaded: number;
  headerTokens: number;
  bodiesLoaded: number;
  bodyTokens: number;
  resourcesLoaded: number;
  resourceBytes: number;
  /** Names evicted from the tier-2 cache by LRU, in eviction order. */
  evicted: string[];
  /** Budget rejections (activation/resource refused, not thrown). */
  rejected: string[];
}

/** One activation inside a budgeted session. */
export interface SkillV15BudgetedActivation {
  name: string;
  body: string;
  bodyTokens: number;
  /** `true` when an older body was evicted to make room for this one. */
  evictedNames: string[];
}

/** One tier-3 resource read inside a budgeted session. */
export interface SkillV15BudgetedResource {
  name: string;
  relPath: string;
  content: string;
  bytes: number;
}

// --- Registry (v15, compatibility-aware) ------------------------------------

/**
 * One v15 registry entry: a v14 marketplace entry plus the structured
 * `compatibility` field the task requires. The registry is a plain
 * JSON index over the discovery roots — it never edits a skill.
 */
export interface SkillV15RegistryEntry {
  name: string;
  description: string;
  dir: string;
  source: string;
  version?: string;
  license?: string;
  allowedTools?: string[];
  /** Structured compatibility (see SkillV15Compatibility). */
  compatibility: SkillV15Compatibility;
  enabled: boolean;
  headerTokens: number;
  /** ISO timestamp of the last registry refresh for this entry. */
  indexedAt: string;
}

export interface SkillV15RegistryOptions {
  /** Project root to scan. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Home directory for the global roots. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Registry index file. Defaults to `<projectRoot>/.agents/<file>`. */
  indexFile?: string;
  /** Skip the global roots (project-only index). */
  projectOnly?: boolean;
}

export interface SkillV15RegistryFilter {
  /** Only skills supported on this platform. */
  platform?: SkillV15PlatformId;
  /** Only skills whose compatibility is unknown. */
  unknownOnly?: boolean;
  /** Only portable skills (supported on all five platforms). */
  portableOnly?: boolean;
  /** Only enabled / only disabled skills. */
  enabled?: boolean;
  /** Free-text match on name or description (case-insensitive). */
  query?: string;
}

// --- Validation (v15, platform-aware) ---------------------------------------

/** One v15 validation finding (extends the v14 finding shape). */
export interface SkillV15Finding {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  field?: string;
  file?: string;
  line?: number;
  /** Platform the finding applies to (absent = all platforms). */
  platform?: SkillV15PlatformId;
}

/** Result of validating one skill for one or more target platforms. */
export interface SkillV15PlatformValidation {
  dirName: string;
  /** The underlying strict v14 validation (unchanged). */
  base: SkillV14Validation;
  /** Structured compatibility parsed from the frontmatter. */
  compatibility: SkillV15Compatibility;
  /** Per-platform verdicts for the requested targets. */
  checks: SkillV15PlatformCheck[];
  /** Extra v15 findings (platform + allowed-tools + script refs). */
  findings: SkillV15Finding[];
  valid: boolean;
  errors: SkillV15Finding[];
  warnings: SkillV15Finding[];
  qualityScore: number;
}

export interface ValidateForPlatformsV15Options {
  /** Extra tool names the caller knows about (as in v14). */
  knownTools?: string[];
  /** Skip the script-security scan (default: scan when `scripts/` exists). */
  skipScriptScan?: boolean;
  /** Check that `scripts/` files referenced in the body exist. Default: true. */
  checkScriptRefs?: boolean;
}

// --- Migration (v13 / pre-standard → v15) -----------------------------------

/** One change a migration would make (or made). */
export interface SkillV15MigrationChange {
  kind: 'rename-dir' | 'frontmatter-field' | 'frontmatter-value' | 'add-compatibility' | 'add-field' | 'note';
  field?: string;
  from: string;
  to: string;
}

/** Result of migrating (or dry-running) one skill directory. */
export interface SkillV15MigrationResult {
  /** Original directory name. */
  fromName: string;
  /** Directory name after migration (same when no rename). */
  toName: string;
  /** Absolute directory of the migrated skill. */
  dir: string;
  changes: SkillV15MigrationChange[];
  /** Validation of the migrated skill (clean when the migration worked). */
  validationQuality: number;
  /** `true` in a dry run (nothing was written). */
  dryRun: boolean;
}

export interface MigrateSkillV15Options {
  /** `true` = report only, write nothing. Default: `false`. */
  dryRun?: boolean;
  /** Default compatibility to add when the skill states none. */
  defaultCompatibility?: string | string[];
  /** Overwrite the target dir when a rename collides. Default: `false`. */
  overwrite?: boolean;
}

// --- Sync / drift -----------------------------------------------------------

/** Drift state of one mirror against the canonical dir. */
export interface SkillV15Drift {
  skill: string;
  platform: SkillV15PlatformId;
  /** `in-sync` / `drifted` / `missing` / `broken-link` / `not-a-mirror`. */
  state: 'in-sync' | 'drifted' | 'missing' | 'broken-link' | 'not-a-mirror';
  /** Files that differ (for `drifted`), or the broken target (for `broken-link`). */
  detail: string;
  differingFiles: string[];
}

/** Result of checking (and optionally repairing) every mirror. */
export interface SkillV15SyncReport {
  projectRoot: string;
  checked: number;
  inSync: number;
  drifted: number;
  missing: number;
  brokenLinks: number;
  drifts: SkillV15Drift[];
  /** Mirrors repaired (only when `repair` was true). */
  repaired: string[];
}
