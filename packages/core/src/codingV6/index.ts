/**
 * Coding agent v6 (v1.14, Đội T3) — public exports.
 *
 * Học ý tưởng OpenHands V1 SDK (survey v1.14 §2), nối coding agent
 * v5 git-native + eval (v1.13) và event-sourced (v1.12). Xem từng
 * module để biết thiết kế đầy đủ.
 */

export * from './types';
export {
  CodingV6Log,
  V6_GENESIS_PREV_HASH,
  V6_LOG_TEXT_LIMIT,
  clipV6Text,
  emptyV6State,
  foldV6Event,
  foldV6Events,
  hashV6Event,
  verifyV6Chain,
} from './conversationLog';
export type { V6ChainVerification } from './conversationLog';
export {
  V6ActionValidationError,
  V6_MAX_ACTIONS_PER_TURN,
  V6_MAX_ACTION_TEXT_CHARS,
  executeV6CodeAction,
  observationForNonCodeAction,
  parseV6ActionFromJsonText,
  parseV6ActionFromObject,
  parseV6ActionsFromText,
  renderV6ObservationText,
  v6ActionSignature,
  validateV6Action,
} from './codeactV2';
export type { V6ExecuteResult, V6ParseResult } from './codeactV2';
export {
  V6ApprovalGate,
  V6SecurityAnalyzer,
  V6_TOOL_NAME_BY_KIND,
  assessV6Action,
  v6ActionToToolCall,
} from './security';
export type { V6ApprovalDecision, V6PendingApproval, V6SecurityVerdict } from './security';
export {
  applyV6Condensation,
  condenseV6Log,
  condenseV6Messages,
  estimateV6EventTokens,
  extractOpenQuestions,
  shouldCondenseV6Log,
} from './condenserV2';
export type { V6ChatMessage, V6CondenseCheck, V6CondenseOptions, V6Condensation } from './condenserV2';
export { analyzeV6Stuck, buildV6EscapeSuggestions, extractFailingTestName, normalizeV6ErrorText } from './stuckV6';
export type {
  V6EscapeKind,
  V6EscapeSuggestion,
  V6StuckOptions,
  V6StuckReport,
  V6StuckSignal,
  V6StuckSignalKind,
} from './stuckV6';
export {
  V6DelegateError,
  V6DelegateTracker,
  V6_DELEGATE_DEFAULT_MAX_STEPS,
  V6_DELEGATE_DEFAULT_MAX_TOKENS,
  V6_DELEGATE_DEFAULT_TIMEOUT_MS,
  V6_DELEGATE_MAX_CHILDREN,
  V6_DELEGATE_MAX_DEPTH,
  extractV6DelegateVerdict,
  fingerprintV6DelegateTask,
  mergeV6DelegateResults,
  normalizeDelegateAction,
  runV6DelegateChild,
  runV6Delegation,
} from './delegate';
export type { V6DelegateChildInput, V6DelegateMergeStrategy } from './delegate';
export {
  DEFAULT_ROUTER_LLM_MODELS,
  ROUTER_LLM_EASY_KEYWORDS,
  ROUTER_LLM_HARD_KEYWORDS,
  RouterLlm,
  V6_TIER_ORDER,
  scoreRouterLlmContext,
  tierForRouterLlmScore,
} from './routerLlm';
export type { RouterLlmContext, RouterLlmDecision, RouterLlmModels, RouterLlmRules } from './routerLlm';
export { CodingAgentV6, V6_DEFAULT_MAX_STEPS, suggestV6CommitSubject } from './agent';
export type { CodingAgentV6Options, V6ModelGenerator, V6TurnResult } from './agent';
