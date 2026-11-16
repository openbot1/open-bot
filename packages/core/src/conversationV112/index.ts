/**
 * Event-sourced CONVERSATION log + CodeAct-lite (v1.12, Đội T2) —
 * public exports.
 *
 * Scope conversation (nhiều turn/branch), khác run log ở `event-log/`
 * (scope một run). Xem từng file để biết chi tiết.
 */

export {
  CONVERSATION_V112_GENESIS_PREV_HASH,
  hashConversationEvent,
  sha256HexV112,
  stableStringifyV112,
  verifyConversationChain,
  verifyConversationEventHash,
} from './canonical';

export { ConversationLogStore, ConversationStoreError } from './store';
export type { ConversationLogStoreOptions, ReadConversationResult } from './store';

export {
  CONVERSATION_V112_SECRET_PATTERNS,
  REDACTED_V112_TEXT,
  containsSecretV112,
  redactSecretsV112,
  sanitizeTextForLogV112,
  truncateV112,
} from './redact';
export type { RedactV112Result } from './redact';

export {
  conversationStatesEqual,
  foldConversationEvent,
  foldConversationEvents,
  isConversationTerminal,
  replayDeterministicallyV112,
  summarizeConversationState,
} from './replay';

export {
  branchConversation,
  conversationAncestors,
  isBranchEvent,
  listConversationBranches,
} from './branches';
export type { BranchConversationOptions, BranchConversationResult } from './branches';

export {
  compactConversation,
  createConversationSnapshot,
  foldStateAtSeq,
  readConversationSnapshot,
  replayFromSnapshot,
} from './snapshots';
export {
  diffConversationStates,
  stateAtSeq,
  timeTravelConversation,
} from './timetravel';
export type {
  ConversationStateDiff,
  ConversationTimeTravelResult,
} from './timetravel';
export type {
  CompactConversationResult,
  ConversationSnapshotFile,
  CreateSnapshotResult,
  RestoreFromSnapshotResult,
} from './snapshots';

export {
  CODEACT_LITE_BLOCKED_PATTERNS,
  CODEACT_LITE_PYTHON_BLOCKED_PATTERNS,
  DEFAULT_CODEACT_LITE_LIMITS,
  checkCodeActLitePolicy,
  codeActLiteBudgetExceeded,
} from './policy';
export type {
  CodeActLiteBlockRule,
  CodeActLiteLimits,
  CodeActLitePolicyCheck,
} from './policy';

export {
  CodeActLiteValidationError,
  codeActLiteActionCode,
  describeCodeActLiteRun,
  extractCodeBlocks,
  renderCodeActLiteRunsText,
  runCodeActLiteText,
} from './codeactLite';
export type {
  CodeActLiteRun,
  CodeActLiteRunnerOptions,
  ExtractedCodeBlock,
} from './codeactLite';

export {
  MAX_WORKSPACE_SKILLS,
  WORKSPACE_SKILLS_DIR,
  WorkspaceSkillError,
  findWorkspaceSkill,
  indexWorkspaceSkills,
  loadWorkspaceSkill,
  renderSkillForPrompt,
  suggestSkillsForText,
  validateWorkspaceSkillFile,
  workspaceSkillsDir,
} from './skillsOnDemand';
export type {
  SkillSuggestion,
  WorkspaceSkillIndex,
  WorkspaceSkillIndexEntry,
} from './skillsOnDemand';

export {
  buildConversationExportJsonl,
  ConversationExportError,
  exportConversationToFile,
  importConversationFromFile,
  parseConversationExportJsonl,
} from './exportImport';
export type {
  ConversationExportHeader,
  ExportConversationResult,
  ImportConversationResult,
} from './exportImport';

export { ConversationV112Session } from './session';
export type { ConversationV112SessionOptions } from './session';

export {
  argKeysFromJson,
  attachConversationV112ToRunner,
  ConversationLoopAdapter,
  toToolCallRecorder,
} from './loopAdapter';

export {
  CONVERSATION_V112_DEFAULTS,
  emptyConversationState,
  safeConversationFileName,
} from './types';
export type {
  AnyConversationEvent,
  ConversationBranchedPayload,
  ConversationCodeActActionPayload,
  ConversationCodeActObservationPayload,
  ConversationCompactedPayload,
  ConversationEndedPayload,
  ConversationEvent,
  ConversationEventPayload,
  ConversationEventType,
  ConversationMessage,
  ConversationMessagePayload,
  ConversationMessageRole,
  ConversationPayloadByType,
  ConversationSkillPayload,
  ConversationSnapshotPayload,
  ConversationStartedPayload,
  ConversationState,
  ConversationStatus,
  ConversationToolActionPayload,
  ConversationToolObservationPayload,
} from './types';
