/**
 * Agent Skills v15 — public surface (v1.36, Team T2).
 *
 * Multi-platform Agent Skills on the strict AAIF v14 base (see the
 * v136 survey, section 1 — agentskills.io / Agentic AI Foundation):
 *
 * - types.ts — shared types + constants (5 platforms, compatibility,
 *   budgets, registry entries, migration, sync).
 * - platforms.ts — platform table + `compatibility` parsing
 *   (platform verdicts vs free-text requirements, host read-roots).
 * - validator.ts — platform-aware validation on top of strict v14
 *   (unsupported target = error, `allowed-tools` experimental,
 *   dangling script/reference checks).
 * - multiPlatform.ts — canonical `.agents/skills/` + copy/symlink
 *   mirrors to `.claude/`, `.github/`, `.codex/`, `.opencode/` roots,
 *   per-platform install status, import from any platform root.
 * - disclosure.ts — budgeted progressive disclosure (tier-1 header
 *   cap, tier-2 body budget with LRU eviction, tier-3 resource cap,
 *   usage report).
 * - registry.ts — compatibility-aware registry (structured
 *   `compatibility` on every entry, platform filter, skill × platform
 *   matrix, persisted JSON index).
 * - migration.ts — pre-standard / v13 skills into the v15 layout
 *   (dir normalisation, `tools:` → `allowed-tools`, compatibility
 *   added, legacy fields recorded, never silently dropped).
 * - sync.ts — mirror drift detection + repair (canonical is the
 *   source of truth; hand-installed same-name dirs are never
 *   overwritten).
 * - audit.ts — project-wide skill audit (validation + install state
 *   + export readiness per platform, findings rollup).
 * - pack.ts — multi-skill distribution packs (create / verify /
 *   install a set of skills at once, with a checksummed manifest).
 */

export {
  SKILL_V15_BUNDLE_FORMAT,
  SKILL_V15_DEFAULT_MAX_BODY_TOKENS,
  SKILL_V15_DEFAULT_MAX_HEADERS,
  SKILL_V15_DEFAULT_MAX_HEADER_TOKENS,
  SKILL_V15_DEFAULT_MAX_RESOURCE_BYTES,
  SKILL_V15_GLOBAL_ROOTS,
  SKILL_V15_HOST_READ_ROOTS,
  SKILL_V15_MAX_RESOURCE_BYTES,
  SKILL_V15_PLATFORMS,
  SKILL_V15_PROJECT_ROOTS,
  SKILL_V15_REGISTRY_FILE,
} from './types';
export type {
  ExportMultiPlatformV15Options,
  ExportMultiPlatformV15Result,
  ImportFromPlatformV15Options,
  ImportFromPlatformV15Result,
  MigrateSkillV15Options,
  SkillV15Budget,
  SkillV15BudgetedActivation,
  SkillV15BudgetedResource,
  SkillV15Compatibility,
  SkillV15CompatibilityEntry,
  SkillV15DisclosureUsage,
  SkillV15Drift,
  SkillV15Finding,
  SkillV15InstallState,
  SkillV15MatrixRow,
  SkillV15MigrationChange,
  SkillV15MigrationResult,
  SkillV15MirrorMode,
  SkillV15MirrorResult,
  SkillV15MultiStatus,
  SkillV15OverwriteNeeded,
  SkillV15PlatformCheck,
  SkillV15PlatformId,
  SkillV15PlatformInstall,
  SkillV15PlatformValidation,
  SkillV15RegistryEntry,
  SkillV15RegistryFilter,
  SkillV15RegistryOptions,
  SkillV15SyncReport,
  ValidateForPlatformsV15Options,
} from './types';

export {
  allPlatformRootsV15,
  checkAllPlatformsV15,
  checkCompatibilityV15,
  describePlatformV15,
  formatPlatformCheckV15,
  formatPlatformsV15,
  hostReadRootsV15,
  hostSeesSkillV15,
  isPlatformIdV15,
  isPortableV15,
  parseCompatibilityEntryV15,
  parseCompatibilityV15,
  parsePlatformIdV15,
  platformRootV15,
} from './platforms';

export {
  estimateBodyTokensV15,
  blockingErrorsV15,
  formatPlatformValidationSummaryV15,
  isSkillPortableV15,
  validateSkillForPlatformsV15,
  validateSkillTextForPlatformsV15,
  SKILL_V15_UNMIRRORED_HOSTS,
} from './validator';

export {
  detectSourcePlatformV15,
  diffSkillDirsV15,
  exportSkillMultiPlatformV15,
  formatMultiStatusV15,
  importSkillFromPlatformV15,
  inspectPlatformInstallV15,
  isOverwriteNeededV15,
  listPlatformInstallsV15,
  listSkillFilesV15,
  multiPlatformStatusV15,
  platformRelRootV15,
  removeSkillFromPlatformV15,
} from './multiPlatform';

export {
  DisclosureSessionV15,
  formatDisclosureUsageV15,
  resolveBudgetV15,
  trimHeadersToBudgetV15,
  v15HeadersForContext,
} from './disclosure';
export type { DisclosureSessionV15Options, SkillV15ResolvedBudget } from './disclosure';

export {
  buildCompatibilityMatrixV15,
  defaultRegistryFileV15,
  filterRegistryEntriesV15,
  formatCompatibilityMatrixV15,
  formatRegistryEntriesV15,
  refreshRegistryV15,
  registryEntryFromHeaderV15,
  SkillV15Registry,
  SKILL_V15_REGISTRY_FORMAT,
} from './registry';
export type { SkillV15RegistryFile } from './registry';

export {
  formatMigrationReportV15,
  isSpecDirNameV15,
  migrateSkillV15,
  normaliseSkillDirNameV15,
} from './migration';

export {
  checkMirrorSyncV15,
  driftRepairPlanV15,
  formatSyncReportV15,
  isSkillDirV15,
  repairMirrorSyncV15,
} from './sync';
export type { CheckMirrorSyncV15Options } from './sync';

export {
  auditProjectSkillsV15,
  defaultAuditFileV15,
  exportReadinessV15,
  formatAuditReportV15,
  formatAuditSkillLineV15,
  isAuditCleanV15,
  saveAuditReportV15,
} from './audit';
export type {
  AuditProjectSkillsV15Options,
  SkillV15AuditFindingCount,
  SkillV15AuditPlatform,
  SkillV15AuditReport,
  SkillV15AuditSkill,
  SkillV15Readiness,
} from './audit';

export {
  createSkillPackV15,
  formatPackInstallResultV15,
  installSkillPackV15,
  isPackNameV15,
  listPackSkillsV15,
  readPackManifestV15,
  verifySkillPackV15,
  SKILL_V15_PACK_FORMAT,
  SKILL_V15_PACK_MANIFEST,
} from './pack';
export type {
  CreateSkillPackV15Options,
  CreateSkillPackV15Result,
  InstallSkillPackV15Options,
  InstallSkillPackV15Result,
  SkillV15PackInstallSkill,
  SkillV15PackManifest,
  SkillV15PackSkill,
} from './pack';

export {
  applyExportPlanV15,
  formatExportPlanV15,
  isPlanApplicableV15,
  planMultiPlatformExportV15,
} from './exportPlan';
export type {
  PlanMultiPlatformExportV15Options,
  SkillV15ExportPlan,
  SkillV15PlanAction,
  SkillV15PlanStep,
} from './exportPlan';
