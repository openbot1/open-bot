/**
 * Context engineering — public surface of `packages/core/src/context/`.
 *
 * Pure, model-free helpers the agent loop uses to stay inside the
 * model window: token estimation, budget measurement, pruning with
 * extractive summaries, prompt-cache hints, compaction history,
 * lead-agent delegation, long-task bookkeeping, task checkpoints, a
 * scoped virtual computer, and long-run compaction.
 */
export {
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  ESTIMATED_CHARS_PER_TOKEN,
  KNOWN_MODEL_CONTEXT_LIMITS,
  MESSAGE_OVERHEAD_TOKENS,
  SMALL_CONTEXT_THRESHOLD_TOKENS,
  SmallModelContextError,
  effectiveContextLimit,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  inferContextLimitFromModelName,
  isSmallContextModel,
} from './estimator';
export {
  DEFAULT_RESERVE_TOKENS,
  assertBudgetFits,
  formatBudgetSummary,
  measureContextBudget,
} from './budget';
export type { ContextBudgetInput, ContextBudgetSnapshot } from './budget';
export { buildExtractiveSummary, pruneLowRelevanceTurns, relevanceScore } from './pruning';
export type { PrunableMessage, PruneResult } from './pruning';
export { PROMPT_CACHE_PROVIDERS, PromptCacheTracker, cacheSupportForProvider } from './cacheHints';
export type { CacheObservation } from './cacheHints';
export { CompactionHistory } from './compactionStore';
export type { CompactionRecord } from './compactionStore';
export { LeadAgent } from './leadAgent';
export type { LeadDelegate, LeadRunResult, LeadSubtask, LeadSubtaskResult } from './leadAgent';
export { LONG_TASK_STALE_MS, LongTask } from './longTask';
export type { LongTaskSnapshot, LongTaskStatus } from './longTask';
export { TaskCheckpointStore } from './taskCheckpoints';
export type { TaskCheckpoint, TaskCheckpointStoreOptions } from './taskCheckpoints';
export { VirtualComputer } from './virtualComputer';
export type { VirtualComputerOptions, VirtualComputerRunResult } from './virtualComputer';
export { LongRunCompaction } from './longRunCompaction';
export type { LongRunCompactionOptions, LongRunCompactionResult } from './longRunCompaction';
// --- v1.05 (Đội T4): context engineering v2 — tiered compaction,
// verified summaries, 1M-token window manager, disk spill, per-bot
// policies, inspector + snapshots, session runtime. ---
export {
  DEFAULT_TIER_RETENTION,
  TieredCompactor,
  groupSummariesByTopic,
  topicLabelFor,
} from './tieredCompaction';
export type {
  CompactableTurn,
  CompactionTier,
  TieredCompactionResult,
  TierRetentionPolicy,
  TierSummary,
} from './tieredCompaction';
export {
  classifyAnchorLine,
  countAnchorsByKind,
  extractAnchors,
  filterAnchors,
  formatAnchors,
} from './anchors';
export type { Anchor, AnchorKind, AnchorSourceMessage } from './anchors';
export {
  buildVerifiedSummary,
  claimsFromText,
  salientTokensOf,
  verifyClaim,
  verifySummary,
  verifiedSummaryMarkdown,
  auditVerifiedSummaries,
} from './verifiedSummary';
export type {
  AuditedSummary,
  ClaimStatus,
  SummaryClaim,
  VerifiedClaim,
  VerifiedSummary,
  VerificationSource,
} from './verifiedSummary';
export {
  ContextWindowManager,
  WINDOW_THRESHOLDS,
} from './windowManager';
export type {
  ContextSegment,
  SegmentKind,
  ThresholdAlert,
  ThresholdName,
  WindowManagerOptions,
  WindowStats,
} from './windowManager';
export { SpillStore } from './spillStore';
export type { SpilledSegment } from './spillStore';
export {
  COMPACTION_POLICY_PRESETS,
  CompactionPolicyStore,
  defaultCompactionPolicy,
  estimateSavings,
  presetCompactionPolicy,
  validatePolicy,
} from './compactionPolicy';
export type {
  CompactionFrequency,
  CompactionPolicy,
  SavingsEstimate,
} from './compactionPolicy';
export {
  exportSnapshot,
  importSnapshot,
  inspectWindow,
  snapshotToMarkdown,
  validateSnapshot,
  exportContextBundle,
} from './contextInspector';
export type {
  AnchorLike,
  ContextSnapshot,
  ContextTree,
  InspectorNode,
  TierSummaryLike,
} from './contextInspector';
export { ContextV2Runtime } from './contextV2Runtime';
export type { CompactTurnsResult, ContextV2RuntimeOptions } from './contextV2Runtime';
export {
  HOURLY_COMPACTION_INTERVAL_MS,
  CompactionScheduler,
} from './compactionScheduler';
export type { BotScheduleStatus, ScheduleDecision } from './compactionScheduler';
export { TierStore, emptyStoredTiers, searchStoredAnchors } from './tierStore';
export type { StoredAnchorHit, StoredTiers } from './tierStore';
export {
  assemblePrompt,
  assemblyManifest,
  estimateAssemblyTokens,
} from './contextAssembly';
export type { AssembledMessage, AssembleOptions, AssemblyResult } from './contextAssembly';
export {
  buildCompactionReport,
  compactionReportMarkdown,
} from './compactionReport';
export type { CompactionReport } from './compactionReport';
