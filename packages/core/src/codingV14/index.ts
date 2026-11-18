/**
 * Coding agent v14 (v1.29, Đội T3) — public exports.
 *
 * OpenHands-style condenser tăng dần từ event stream, stuck detection
 * v2 + recovery (loop signature, oscillation, edit journal rollback),
 * reasoning-block persistence (thinking_blocks / reasoning_content
 * lưu sidecar JSONL hash-chained + digest event trong run log chung,
 * replay/resume được).
 *
 * Nối (không viết lại): condenser v1/v2 + stuck detector v1 của
 * event-log, RunLogStore, coding agent v12.
 */

export * from './types';
export {
  V14_REASONING_GENESIS,
  V14_REASONING_SUFFIX,
  V14_RESUME_RECENT_BLOCKS,
  V14ReasoningStore,
  isV14ReasoningBlock,
  renderV14ReasoningBlockSummary,
  v14BlockHashInput,
  v14EstimateTokens,
  v14HashBlock,
  v14NewBlockId,
  v14ReasoningFileName,
  v14RedactText,
  v14Sha256,
} from './reasoningBlocks';
export type { V14ReasoningStoreOptions } from './reasoningBlocks';
export {
  V14_CONDENSE_DEFAULTS,
  V14_CONDENSE_SUFFIX,
  v14ApplyCondensation,
  v14BuildContext,
  v14ClassifyRetention,
  v14CondenseFileName,
  v14CondenseIncremental,
  v14LastCompactedSeq,
  v14LoadCondensations,
  v14RenderKeptEvent,
  v14RenderTailEvent,
  v14SaveCondensation,
  v14ShouldCondense,
  v14UncondensedEvents,
  renderV14CondensationSummary,
} from './condenserV14';
export {
  V14_STUCK_DEFAULTS,
  V14EditJournal,
  detectOscillation,
  renderV14StuckReport,
  v14ActionSignature,
  v14DetectStuck,
  v14ExecuteRecovery,
  v14NormalizeArgs,
  v14NormalizeResultText,
  v14PlanRecovery,
  v14ResultSignature,
} from './stuckRecovery';
export type { V14FileApplier, V14RecoveryContext, V14RecoveryExecutors } from './stuckRecovery';
export {
  renderV14ReplayedState,
  v14AppendReasoningDigest,
  v14AppendRecoveryEvent,
  v14AppendStuckDetectedEvent,
  v14ReadReasoningDigests,
  v14ReadRecoveryEntries,
  v14ReplayState,
  v14VerifyDigests,
} from './eventLogAdapter';
export type { V14DigestVerification, V14ReasoningDigestEntry, V14RecoveryLogEntry, V14ReplayedState } from './eventLogAdapter';
export {
  CodingAgentV14,
  V14_CONTEXT_TAIL_EVENTS,
  V14_REASONING_SUBDIR,
  V14_RUN_LOG_SUBDIR,
  loopingV14Script,
  renderV14AgentReport,
  runV14Agent,
  scriptedV14Agent,
} from './agent';
export type { V14AgentState, V14ScriptedStep } from './agent';
