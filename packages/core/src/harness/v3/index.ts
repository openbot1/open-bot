/**
 * Harness v3 (v1.07, Đội T2) — public surface of packages/core/src/harness/v3/.
 *
 * Vòng lặp Agent/Conversation/EventLog gọn theo ý tưởng OpenHands V1
 * SDK (survey v1.07 phần 1 — chỉ học ý tưởng, không copy code/text/
 * tài sản của repo nào):
 *
 *   V3Conversation  — vòng lặp turn + append-only EventLog (CHÍNH LÀ
 *                     vòng lặp; không có controller trung gian).
 *   TaskToolSet     — delegate task cho sub-agent, nhận kết quả nén.
 *   Critic          — check độc lập + render inline trong chat.
 *   V3BudgetMeter   — meter token/cost/thời gian + cảnh báo 70/90%.
 *   LlmProfileStore — profile LLM lưu sẵn (file JSON, không chứa key).
 *   /model          — lệnh chat liệt kê + đổi profile ngay.
 *
 * Xem docs/harness-v3-v107.md để biết quyết định kiến trúc, cách nối
 * vào LocalHarness (onEvent) và giới hạn còn lại.
 */

export { V3Conversation, DEFAULT_V3_MAX_STEPS, V3_EVENT_TEXT_LIMIT, V3_EVENT_OBSERVATION_LIMIT } from './conversation';
export type { V3ConversationOptions, V3TurnResultWithInline } from './conversation';

export {
  TaskToolSet,
  compressDelegatedResult,
  resolveTaskToolSetOptions,
  DEFAULT_DELEGATED_RESULT_MAX_CHARS,
  DEFAULT_DELEGATION_TIMEOUT_MS,
  DEFAULT_DELEGATED_RESULT_MAX_LINES_PER_SIDE,
} from './delegation';
export type {
  DelegationRecord,
  DelegationStatus,
  SubagentRawResult,
  SubagentRunner,
  TaskToolSetOptions,
  ResolvedTaskToolSetOptions,
} from './delegation';

export {
  runCritic,
  renderCriticInline,
  DEFAULT_CRITIC_CHECKS,
  CRITIC_CHECK_NON_EMPTY,
  CRITIC_CHECK_NO_ERROR_MARKER,
  CRITIC_CHECK_NO_TURN_ERROR,
  CRITIC_CHECK_LAST_OBSERVATION_OK,
} from './critic';
export type {
  CriticCheck,
  CriticCheckResult,
  CriticContext,
  CriticReport,
  CriticVerdict,
} from './critic';

export {
  V3BudgetMeter,
  formatBudgetMeterLine,
  formatDuration,
  V3_BUDGET_WARN_RATIO,
  V3_BUDGET_CRITICAL_RATIO,
} from './budget';
export type { V3BudgetMeterOptions, V3BudgetSnapshot, V3BudgetStatus } from './budget';

export {
  LlmProfileStore,
  LlmProfileError,
  LLM_PROFILES_FILE,
  LLM_PROFILE_ID_RE,
  MAX_LLM_PROFILE_NAME_CHARS,
  MAX_LLM_PROFILES,
} from './llmProfiles';
export type {
  LlmProfile,
  CreateLlmProfileInput,
  UpdateLlmProfileInput,
} from './llmProfiles';

export {
  handleModelCommand,
  parseModelCommand,
  registerModelSlashCommand,
} from './modelCommand';
export type { ModelCommandKind, ModelCommandResult, ParsedModelCommand } from './modelCommand';

export type {
  V3Action,
  V3ActionKind,
  V3Agent,
  V3AgentState,
  V3ConversationEvent,
  V3ConversationSnapshot,
  V3ConversationState,
  V3EventPayload,
  V3EventType,
  V3Observation,
  V3TurnFinishReason,
  V3TurnResult,
  V3Workspace,
} from './types';
