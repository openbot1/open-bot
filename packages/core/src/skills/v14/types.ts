/**
 * Agent Skills v14 — shared types + spec constants (v1.34, Team T1).
 *
 * Encodes the open Agent Skills format as standardised by the Agentic AI
 * Foundation (AAIF, 22/10/2026; format unchanged from the Claude Code
 * original): a skill is a directory holding a mandatory `SKILL.md` plus
 * optional `scripts/`, `references/` and `assets/` subdirectories.
 *
 * Front matter has exactly six fields — required `name` and
 * `description`, optional `license`, `compatibility`, `metadata` and
 * `allowed-tools`. Everything in this subsystem is original open-bot
 * code; only the spec rules (field list, character caps, progressive
 * disclosure) come from the public spec (agentskills.io).
 */

// --- Spec caps (agentskills.io) -------------------------------------------

/** `name`: at most 64 characters. */
export const SKILL_V14_NAME_MAX_LENGTH = 64;
/** `description`: at most 1.024 characters. */
export const SKILL_V14_DESCRIPTION_MAX_LENGTH = 1024;
/** `compatibility` (string form, or joined list form): at most 500 chars. */
export const SKILL_V14_COMPATIBILITY_MAX_LENGTH = 500;
/** `license`: at most 200 characters (kept from the v13 strict layer). */
export const SKILL_V14_LICENSE_MAX_LENGTH = 200;
/** `metadata` serialised: at most 4.096 characters (it is copied into the index). */
export const SKILL_V14_METADATA_MAX_CHARS = 4096;
/** Skill body (SKILL.md after the frontmatter fence): hard cap 20.000 chars. */
export const SKILL_V14_BODY_MAX_CHARS = 20_000;
/** Skill body guidance: warn past 500 lines / 5.000 chars. */
export const SKILL_V14_BODY_GUIDANCE_LINES = 500;
export const SKILL_V14_BODY_GUIDANCE_CHARS = 5_000;
/** A single script file is scanned fully up to this size; larger files are reported, not skipped silently. */
export const SKILL_V14_MAX_SCRIPT_BYTES = 1_000_000;
/** Bundle manifest file written by export / read by import. */
export const SKILL_V14_BUNDLE_MANIFEST = 'skill-bundle.json';
/** Format version stamped into every v14 bundle manifest. */
export const SKILL_V14_BUNDLE_FORMAT = 'openbot-skills-v14-bundle/1';

/**
 * `name`: lowercase letters, digits and `-` only, starting with a letter
 * or digit. Stricter than the lenient loader (`SKILL_NAME_RE` also allows
 * `_`): the AAIF spec allows lowercase + `-` only, and v14 enforces it
 * for every NEW skill.
 */
export const SKILL_V14_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The six frontmatter fields the AAIF spec allows — nothing else. */
export const SKILL_V14_ALLOWED_FIELDS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
] as const;

/** The two required frontmatter fields. */
export const SKILL_V14_REQUIRED_FIELDS = ['name', 'description'] as const;

/** Tool-name shape for `allowed-tools` entries. */
export const SKILL_V14_TOOL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** File that must exist at the root of every skill directory. */
export const SKILL_V14_FILE_NAME = 'SKILL.md';

/** Optional subdirectories of a skill directory. */
export const SKILL_V14_OPTIONAL_DIRS = ['scripts', 'references', 'assets'] as const;

/** Words that suggest a description says WHEN to use the skill (not just what it is). */
export const SKILL_V14_WHEN_CUES = [
  'when',
  'whenever',
  'if ',
  'use ',
  'use when',
  'use this',
  'khi ',
  'khi nào',
  'dùng ',
  'dùng khi',
  'sử dụng ',
  'sử dụng khi',
  'cuando',
  'quand',
  'wenn',
  'ときに',
  '当',
] as const;

// --- Frontmatter ------------------------------------------------------------

/** The six-field AAIF frontmatter, as parsed by the v14 validator. */
export interface SkillV14Frontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string | string[];
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
}

/** One validation finding, with a stable machine-readable code. */
export interface SkillV14Finding {
  /** Stable code, e.g. `V14-NAME-MISMATCH`. */
  code: string;
  /** `error` blocks install/import/activation; `warning` does not. */
  severity: 'error' | 'warning';
  /** Human-readable message (never echoes secret-looking text). */
  message: string;
  /** Frontmatter field the finding is about, when applicable. */
  field?: string;
  /** File the finding is about, relative to the skill directory. */
  file?: string;
  /** 1-based line number inside `file`, when known. */
  line?: number;
}

/** Result of validating one skill (text, file or directory). */
export interface SkillV14Validation {
  /** Directory name the skill was validated as ('' when validating raw text). */
  dirName: string;
  /** Parsed frontmatter when the frontmatter fence could be parsed at all. */
  frontmatter?: SkillV14Frontmatter;
  /** `true` when there are no errors (warnings may still exist). */
  valid: boolean;
  errors: SkillV14Finding[];
  warnings: SkillV14Finding[];
  /** 0–100 quality score: 100 = clean, −15 per error, −3 per warning, floored at 0. */
  qualityScore: number;
  /** Rough token cost of the header (name + description) at session start. */
  headerTokens: number;
  /** Rough token cost of the full body, when the body was available. */
  bodyTokens?: number;
}

export interface ValidateSkillV14Options {
  /**
   * Extra tool names the caller knows about. An `allowed-tools` entry
   * naming an unknown tool is only a warning — a skill may target
   * tools from another host — and passing the list lets the validator
   * name the known ones precisely.
   */
  knownTools?: string[];
  /** Skip the script-security scan (default: scan when a `scripts/` dir exists). */
  skipScriptScan?: boolean;
}

// --- Discovery --------------------------------------------------------------

/** Where a skill was found. Project-local roots outrank global ones. */
export type SkillV14SourceKind =
  | 'project-agents'
  | 'project-claude'
  | 'global-claude'
  | 'global-agents';

/** One discovered skill directory (header not loaded yet). */
export interface DiscoveredSkillV14 {
  /** Skill name = directory name. */
  name: string;
  /** Absolute path of the skill directory. */
  dir: string;
  /** Which discovery root it came from. */
  source: SkillV14SourceKind;
  /** The discovery root it was found under. */
  root: string;
  /** `true` when the same name was also found in a lower-priority root. */
  shadowed: boolean;
  /** Lower-priority directories with the same name that lost the dedupe. */
  shadowedDirs: string[];
}

/** Result of scanning discovery roots. */
export interface DiscoveryV14Result {
  /** Deduplicated skills, project-local first, then alphabetical. */
  skills: DiscoveredSkillV14[];
  /** Roots that were scanned (existing ones only). */
  scannedRoots: string[];
  /** Roots that did not exist and were skipped. */
  missingRoots: string[];
  /** Directories skipped because they hold no `SKILL.md`. */
  skippedDirs: string[];
}

export interface DiscoverSkillsV14Options {
  /** Project root to scan `.agents/skills/` + `.claude/skills/` under. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Home directory for the global roots. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Skip the global roots (project-only discovery). */
  projectOnly?: boolean;
}

// --- Progressive-disclosure loader ------------------------------------------

/** Tier of content: 1 = header only, 2 = + body, 3 = + scripts/references. */
export type SkillV14Tier = 1 | 2 | 3;

/** Tier-1 header entry: the only thing loaded into context at session start. */
export interface SkillV14Header {
  name: string;
  description: string;
  /** Absolute skill directory. */
  dir: string;
  source: SkillV14SourceKind;
  version?: string;
  license?: string;
  compatibility?: string | string[];
  allowedTools?: string[];
  /** Tier-1 token estimate (name + description). */
  headerTokens: number;
  /** Whether the skill is enabled in the marketplace tier state. */
  enabled: boolean;
}

/** Tier-2 activation: header + full SKILL.md body. */
export interface SkillV14Activation extends SkillV14Header {
  /** SKILL.md body (frontmatter stripped). */
  body: string;
  /** Tier-2 token estimate (header + body). */
  bodyTokens: number;
}

/** Tier-3 on-demand resource: one file from `scripts/` / `references/` / `assets/`. */
export interface SkillV14Resource {
  name: string;
  /** Path relative to the skill directory, e.g. `scripts/run.sh`. */
  relPath: string;
  /** File contents. */
  content: string;
  /** Size in bytes. */
  bytes: number;
}

export interface SkillV14LoaderOptions extends DiscoverSkillsV14Options {
  /** Extra roots to scan after the standard four (lowest priority). */
  extraRoots?: string[];
  /** Function deciding whether a skill is enabled; defaults to "all enabled". */
  isEnabled?: (name: string) => boolean;
  /**
   * When set, each (non-cached) activation is appended to this JSONL
   * usage-log file (see usage.ts). Cached re-activations are not
   * re-recorded — the body was already paid for once.
   */
  usageLogFile?: string;
}

// --- Local marketplace index (read-only) ------------------------------------

/** One entry of the local skill index. */
export interface SkillV14MarketplaceEntry {
  name: string;
  description: string;
  dir: string;
  source: SkillV14SourceKind;
  version?: string;
  license?: string;
  allowedTools?: string[];
  /** Enabled/disabled tier state (persisted in the tier state file, never inside the skill). */
  enabled: boolean;
  headerTokens: number;
}

export interface SkillV14MarketplaceOptions {
  /** Where the enable/disable tier state file lives. Defaults to `<indexDir>/.openbot-skills-v14.json`. */
  stateFile?: string;
}

/** A keyword search hit, ranked. */
export interface SkillV14SearchHit {
  entry: SkillV14MarketplaceEntry;
  /** Higher = better match (name hit beats description hit). */
  score: number;
  /** Which field matched: `name`, `description`, or `both`. */
  matchedIn: 'name' | 'description' | 'both';
}

// --- Portable import / export -----------------------------------------------

/** One file entry of a bundle manifest, with its checksum. */
export interface SkillV14BundleFile {
  /** Path relative to the skill directory, POSIX-style. */
  path: string;
  /** Size in bytes. */
  bytes: number;
  /** Lowercase hex SHA-256 of the file bytes. */
  sha256: string;
}

/** Manifest written into every exported bundle. */
export interface SkillV14BundleManifest {
  format: typeof SKILL_V14_BUNDLE_FORMAT;
  name: string;
  description: string;
  version?: string;
  exportedAt: string;
  exportedBy: string;
  files: SkillV14BundleFile[];
}

export interface ExportSkillV14Options {
  /** Directory to write the bundle into. Defaults to `<cwd>/<name>.skill-v14`. */
  outDir?: string;
}

export interface ExportSkillV14Result {
  /** Absolute bundle directory. */
  bundleDir: string;
  manifest: SkillV14BundleManifest;
  /** Number of files copied (including the manifest). */
  fileCount: number;
}

export interface ImportSkillV14Options {
  /** Directory holding the skill(s) to import into. */
  targetDir: string;
  /** When `true`, overwrite an existing skill of the same name. Default: `false`. */
  overwrite?: boolean;
}

export interface ImportSkillV14Result {
  /** Absolute directory the skill was imported into. */
  dir: string;
  name: string;
  /** `true` when an existing skill was replaced. */
  overwritten: boolean;
  /** Validation of the imported skill (always clean — import refuses invalid skills). */
  validation: SkillV14Validation;
}

/**
 * Returned instead of throwing when the target already holds a skill of
 * the same name and `overwrite` was not passed: the caller (UI/agent)
 * must confirm before the import proceeds.
 */
export interface SkillV14OverwriteNeeded {
  needsOverwriteConfirm: true;
  name: string;
  existingDir: string;
  bundleDir: string;
}
