/**
 * Agent Skills loader v13 — public surface (v1.13, Team T1).
 *
 * Six modules, one idea: the Agent Skills spec (SKILL.md +
 * frontmatter + progressive disclosure) done strictly, with the
 * tooling around it that the v0.11a loader never got:
 *
 * - validation.ts — strict v13 checks (compatibility <= 500 chars,
 *   license, metadata cap, allowed-tools shape, trigger descriptions).
 * - sessionIndex.ts — session-scoped header index + load-on-demand
 *   bodies (tier 1/2/3) with an LRU body cache.
 * - internalRegistry.ts — open-bot's own skill catalog (11 built-ins
 *   + capability skills), search by description, context activation.
 * - interop.ts — import/export with Claude Code (.claude/skills/),
 *   Codex CLI (~/.agents/skills/) and Gemini CLI (~/.gemini/skills/).
 * - localMarketplace.ts — browse/install/uninstall/upgrade skills
 *   from a local directory, with `skill.json` manifest validation.
 * - audit.ts — tool-budget audit + context-tax audit + ranked waste
 *   report (mcode-stack style).
 */

export {
  compatibilityLength,
  descriptionHasTrigger,
  detectToolsFieldClash,
  formatDirValidationSummary,
  formatValidationSummary,
  longestCodeFenceLines,
  validateFrontmatterObjectV13,
  validateSkillDirV13,
  validateSkillFileTextV13,
  validateSkillHeaderV13,
  validateSkillTextV13,
  validateSkillV13,
  KNOWN_SPDX_LICENSES,
  DESCRIPTION_TRIGGER_WORDS,
  SKILL_V13_BODY_GUIDANCE_CHARS,
  SKILL_V13_BODY_GUIDANCE_LINES,
  SKILL_V13_BODY_MAX_CHARS,
  SKILL_V13_COMPATIBILITY_MAX_LENGTH,
  SKILL_V13_DESCRIPTION_MIN_LENGTH,
  SKILL_V13_DESCRIPTION_WARN_LENGTH,
  SKILL_V13_LICENSE_MAX_LENGTH,
  SKILL_V13_MAX_CODE_FENCE_LINES,
  SKILL_V13_METADATA_MAX_CHARS,
  SKILL_V13_TOOL_NAME_RE,
} from './validation';
export type { SkillDirValidation, SkillV13Finding, SkillV13Validation, ValidateSkillV13Options } from './validation';

export { SkillSessionIndex, openSkillSessionIndex } from './sessionIndex';
export type {
  SkillSessionBody,
  SkillSessionEntry,
  SkillSessionIndexOptions,
  SkillSessionOpenResult,
} from './sessionIndex';

export {
  clearInternalSkillOverlays,
  formatInternalCatalog,
  getInternalSkill,
  internalSkillNames,
  internalSkillsByCategory,
  isInternalSkill,
  listInternalSkills,
  registerInternalSkill,
  searchInternalSkills,
  skillsForContext,
  unregisterInternalSkill,
  INTERNAL_BUILTIN_SKILLS,
  INTERNAL_CAPABILITY_SKILLS,
  INTERNAL_SKILLS,
} from './internalRegistry';
export type {
  InternalSkillCategory,
  InternalSkillContext,
  InternalSkillEntry,
  InternalSkillMatch,
} from './internalRegistry';

export {
  defaultHostRoots,
  detectSkillFormat,
  exportSkillToHost,
  hostRootFor,
  importAllFromHost,
  importSkillFromHost,
  listHostSkills,
  renderSkillMarkdown,
} from './interop';
export type {
  DetectedSkillFormat,
  ExportSkillOptions,
  ExportSkillResult,
  HostSkillListing,
  ImportSkillOptions,
  ImportSkillResult,
  SkillHostFormat,
  SkillHostRoot,
} from './interop';

export {
  browseLocalMarketplace,
  checkLocalUpgrades,
  compareSemver,
  installLocalSkill,
  installedSkillVersion,
  parseSkillManifest,
  searchLocalMarketplace,
  uninstallLocalSkill,
  OPEN_BOT_VERSION,
  SKILL_MANIFEST_FILE,
} from './localMarketplace';
export type {
  BrowseMarketplaceOptions,
  BrowseMarketplaceResult,
  InstallLocalSkillOptions,
  InstallLocalSkillResult,
  LocalMarketplaceEntry,
  SkillManifest,
} from './localMarketplace';

export {
  auditContextTax,
  auditToolBudget,
  buildWasteReport,
  estimateTokensV13,
  formatWasteReport,
} from './audit';
export type {
  ContextTaxAudit,
  ContextTaxAuditOptions,
  SkillContextCost,
  SkillToolUsage,
  SkillWasteReport,
  ToolBudgetAudit,
  ToolBudgetAuditOptions,
  ToolCallRecord,
} from './audit';

export {
  bodyLineChanges,
  bodySimilarity,
  diffSkills,
  diffSkillTexts,
  formatSkillDiff,
} from './skillDiff';
export type { SkillChange, SkillDiff, SuggestedBump } from './skillDiff';
