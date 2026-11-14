/**
 * Event-sourced run log (v1.01, Đội T1) — public exports.
 *
 * Append-only log bất biến theo run (JSONL + hash chain SHA-256),
 * deterministic replay, pause/resume/fork, audit trail.
 * Xem `docs/survey-v101-t1-event-log.md` để biết thiết kế đầy đủ.
 */

export { GENESIS_PREV_HASH, digestReplayState, eventHashInput, hashRunEvent, verifyEventHash } from './canonical';
/** Alias riêng (tránh đụng `sha256Hex`/`stableStringify` đã có trong core index). */
export { sha256Hex as runLogSha256Hex, stableStringify as runLogStableStringify } from './canonical';
export {
  RunControlRegistry,
  RunGateAbortedError,
  RunPauseGate,
  forkRun,
  pauseRun,
  resumeRun,
} from './control';
export type { ForkRunResult, PauseResumeResult, RunPauseGateLike } from './control';
export { REDACTED_TEXT, foldEvents, replayDeterministically, replayMatches } from './replay';
export type { ReplayDriverHandlers } from './replay';
export { RunLogRecorder } from './recorder';
export type { LoopRunLogWiring, RunLogRecorderOptions, RunLogSink } from './recorder';
export {
  RUN_LOG_ARRAY_LIMIT,
  RUN_LOG_DEPTH_LIMIT,
  RUN_LOG_OUTPUT_LIMIT,
  RUN_LOG_STRING_LIMIT,
  extractFirstError,
  fileChangeKindForTool,
  isBuildToolCall,
  isFileWriteTool,
  sanitizeRunLogPayload,
  sanitizeRunLogString,
  toolArgKeys,
} from './sanitize';
export { RunLogStore, safeRunFileName } from './store';
export type { ReadRunResult, RunLogStoreOptions } from './store';
export { queryAudit, replayRunState, summarizeAudit, verifyAllRuns } from './audit';
export type {
  AuditEventEntry,
  AuditIntegrityReport,
  AuditQuery,
  AuditSummary,
} from './audit';
// v1.03 (Đội T1): time-travel / fork tại seq, redaction, stuck detection, condenser.
export { compactRun, condenseEvents, estimateEventTokens, shouldCondense } from './condenser';
export type { CompactRunResult, CondenseCheck, CondenseOptions, Condensation } from './condenser';
// v1.04 (Đội T4): snapshot trạng thái đã fold + condenser v2 (3 chiến lược).
export {
  RUN_SNAPSHOT_SUFFIX,
  RUN_SNAPSHOT_VERSION,
  RUN_SNAPSHOTS_DIR,
  createRunSnapshot,
  deleteRunSnapshot,
  listRunSnapshots,
  loadRunSnapshot,
  mergeReplayedStates,
  pruneRunSnapshots,
  restoreRunState,
  snapshotFileName,
  snapshotFilePath,
  snapshotsDirFor,
  tailMergeHints,
  verifyRestoredState,
  verifySnapshotObject,
} from './snapshot';
export type {
  CreateRunSnapshotResult,
  RestoreRunStateResult,
  RunSnapshot,
  RunSnapshotMeta,
  RunSnapshotOptions,
  TailMergeHints,
} from './snapshot';
export {
  EXTRACT_KEEP_TYPES,
  compactRunV2,
  condenseEventsV2,
  condenseRunV2,
  countErrorEvents,
  describeEventLine,
  estimateEventsTokens,
  recommendStrategy,
} from './condenser-v2';
export type {
  CompactRunV2Result,
  CondenseStrategyV2,
  CondenseV2Options,
  CondenserV2Report,
  StrategyRecommendation,
} from './condenser-v2';
export { findEventsContaining, redactEvent, redactedSeqs } from './redaction';
export type { RedactResult } from './redaction';
export { STUCK_SUGGESTION_KEYS, detectStuck, detectStuckForRun, recordStuckDetection } from './stuck';
export type { StuckOptions, StuckReport, StuckSignal, StuckSignalKind } from './stuck';export {
  compareRunStates,
  forkRunAt,
  listChildRuns,
  readRunEvents,
  replayUpTo,
  timeTravelTo,
} from './timeTravel';
export type { RunBranch, RunStateDiff, TimeTravelResult } from './timeTravel';
export type {
  AnyRunEvent,
  ApprovalPayload,
  CheckpointSavedPayload,
  CompileErrorPayload,
  DeterministicReplayResult,
  EventRedactedPayload,
  FileChangePayload,
  ModelResponsePayload,
  NewRunEvent,
  ReplayedRunState,
  ReplayedToolCall,
  ReplayedTranscriptEntry,
  RunCompactedPayload,
  RunCompactionInfo,
  RunEndPayload,
  RunEvent,
  RunEventPayloadMap,
  RunEventQuery,
  RunEventType,
  RunForkedPayload,
  RunLogMeta,
  RunLogVerification,
  RunPausePayload,
  RunPromptPayload,
  RunStartedPayload,
  RunStatus,
  StuckDetectedPayload,
  StuckDetectionInfo,
  ToolCallPayload,
  ToolResultPayload,
} from './types';
