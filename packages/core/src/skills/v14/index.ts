/**
 * Agent Skills v14 — public surface (v1.34, Team T1).
 *
 * Strict AAIF (Agentic AI Foundation) Agent Skills support, six modules:
 *
 * - types.ts — shared types + spec constants (6 frontmatter fields, caps).
 * - validator.ts — strict validation (unknown fields rejected, name must
 *   match the directory, description <= 1.024 chars saying what AND
 *   when) + security scan of `scripts/`.
 * - discovery.ts — dual-path discovery (`.agents/skills/` +
 *   `.claude/skills/`, + global `~/.claude/skills/` and
 *   `~/.agents/skills/`), dedupe by name, project-local wins.
 * - loader.ts — progressive disclosure: tier-1 headers into context at
 *   session start, tier-2 body on activation, tier-3 scripts/references
 *   on demand; the runtime hook for the agent loop.
 * - marketplace.ts — read-only local skill index (browse/search) + a
 *   per-skill enable/disable tier kept in a state file, never in the
 *   skill itself.
 * - importExport.ts — portable bundles (whole skill dir + manifest with
 *   SHA-256 per file), checksum verification, overwrite confirmation.
 * - authoring.ts — scaffold a new skill that passes strict validation
 *   on the first try + render frontmatter/body back to SKILL.md text.
 */

export {
  SKILL_V14_ALLOWED_FIELDS,
  SKILL_V14_BODY_GUIDANCE_CHARS,
  SKILL_V14_BODY_GUIDANCE_LINES,
  SKILL_V14_BODY_MAX_CHARS,
  SKILL_V14_BUNDLE_FORMAT,
  SKILL_V14_BUNDLE_MANIFEST,
  SKILL_V14_COMPATIBILITY_MAX_LENGTH,
  SKILL_V14_DESCRIPTION_MAX_LENGTH,
  SKILL_V14_FILE_NAME,
  SKILL_V14_LICENSE_MAX_LENGTH,
  SKILL_V14_MAX_SCRIPT_BYTES,
  SKILL_V14_METADATA_MAX_CHARS,
  SKILL_V14_NAME_MAX_LENGTH,
  SKILL_V14_NAME_RE,
  SKILL_V14_OPTIONAL_DIRS,
  SKILL_V14_REQUIRED_FIELDS,
  SKILL_V14_TOOL_NAME_RE,
  SKILL_V14_WHEN_CUES,
} from './types';
export type {
  DiscoveredSkillV14,
  DiscoverSkillsV14Options,
  DiscoveryV14Result,
  ExportSkillV14Options,
  ExportSkillV14Result,
  ImportSkillV14Options,
  ImportSkillV14Result,
  SkillV14Activation,
  SkillV14BundleFile,
  SkillV14BundleManifest,
  SkillV14Finding,
  SkillV14Frontmatter,
  SkillV14Header,
  SkillV14LoaderOptions,
  SkillV14MarketplaceEntry,
  SkillV14MarketplaceOptions,
  SkillV14OverwriteNeeded,
  SkillV14Resource,
  SkillV14SearchHit,
  SkillV14SourceKind,
  SkillV14Tier,
  SkillV14Validation,
  ValidateSkillV14Options,
} from './types';

export {
  descriptionHasWhenCueV14,
  estimateTokensV14,
  formatValidationSummaryV14,
  parseFrontmatterRawV14,
  scanSkillScriptsV14,
  splitSkillTextV14,
  validateFrontmatterObjectV14,
  validateSkillDirV14,
  validateSkillFileV14,
  validateSkillTextV14,
} from './validator';

export {
  describeSourceKindV14,
  discoverSkillsInDirV14,
  discoverSkillsV14,
  discoveryRootsV14,
  formatDiscoverySummaryV14,
  isProjectLocalV14,
} from './discovery';

export {
  loadSkillHeaderV14,
  openSkillV14Loader,
  resolveSkillResourcePathV14,
  SkillV14Loader,
  v14HeadersForContext,
  SKILL_V14_BODY_CACHE_SIZE,
  SKILL_V14_RESOURCE_DIRS,
} from './loader';
export type { SkillV14LoadError, SkillV14OpenResult } from './loader';

export {
  browseLocalSkillIndexV14,
  defaultTierStateFileV14,
  disableSkillV14,
  enableSkillV14,
  formatMarketplaceEntriesV14,
  isEnabledFromStateFileV14,
  isSkillEnabledV14,
  readTierStateV14,
  searchInstalledSkillsV14,
  searchLocalSkillsV14,
  setSkillEnabledV14,
  validateInstalledSkillV14,
  writeTierStateV14,
  SKILL_V14_TIER_STATE_FILE,
} from './marketplace';
export type { SkillV14TierState } from './marketplace';

export {
  exportSkillV14,
  importSkillV14,
  isOverwriteNeededV14,
  listBundleFilesV14,
  readBundleManifestV14,
  sha256TextV14,
  validateBundleV14,
  verifyBundleChecksumsV14,
  SKILL_V14_BUNDLE_VERSION,
} from './importExport';

export {
  createSkillV14,
  renderSkillMarkdownV14,
  SKILL_V14_REFERENCE_STUB,
  SKILL_V14_SCRIPT_STUB,
  SKILL_V14_STARTER_BODY,
} from './authoring';
export type { CreateSkillV14Input, CreateSkillV14Options, CreateSkillV14Result } from './authoring';

export {
  buildUsageEntryV14,
  formatUsageSummaryV14,
  readUsageV14,
  recordActivationV14,
  summarizeUsageV14,
  totalUsageTokensV14,
  SKILL_V14_USAGE_LOG_FILE,
} from './usage';
export type { SkillV14UsageEntry, SkillV14UsageRead, SkillV14UsageSummary } from './usage';
