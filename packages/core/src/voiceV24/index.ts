/**
 * @open-bot/core/voiceV24 — voice realtime v24 (v1.37, Đội T5).
 *
 * Per-tool-call timers in a running voice session (start /
 * end / duration per call, per-tool and per-session
 * aggregates, slow / timeout / error-burst alerts, live
 * running-call checks), a dynamic provider/model catalogue
 * (starts empty, host registers what it detected, live
 * status per provider), provider health scoring from probe
 * history, mid-session model switching that preserves the
 * transcript (with history + rollback), a session tying
 * them together, and a panel that shows all of it at a
 * glance.
 *
 * All clocks virtual, all audio mock/synthetic, no network,
 * no key, no mic/sound card.
 */
export {
  clampV24,
  round2V24,
  round4V24,
  meanV24,
  percentileV24,
  formatDurationV24,
  formatDurationShortV24,
  durationBucketV24,
  isValidVoiceV24Id,
  transcriptChecksumV24,
  deriveProviderStatusV24,
  VOICE_V24_SLOW_DEFAULT_MS,
  VOICE_V24_TIMEOUT_DEFAULT_MS,
  VOICE_V24_STALE_AFTER_DEFAULT_MS,
  VOICE_V24_DEGRADED_LATENCY_DEFAULT_MS,
} from './types';
export type {
  VoiceV24Clock,
  VoiceV24ProviderStatus,
  VoiceV24ProviderKind,
  VoiceV24ModelInfo,
  VoiceV24ModelRef,
  VoiceV24ToolCallStatus,
  VoiceV24ToolCallRecord,
  VoiceV24TimerAlertKind,
  VoiceV24TimerAlert,
  VoiceV24DurationBucket,
  VoiceV24TranscriptTurn,
  VoiceV24ModelSwitchEvent,
  VoiceV24ProbeObservation,
} from './types';
export {
  ToolCallTimerRegistryV24,
  createToolCallTimerRegistryV24,
  defaultToolCallTimerV24Options,
  validateToolCallTimerV24Options,
} from './toolCallTimersV24';
export type {
  ToolCallTimerV24Options,
  VoiceV24ToolStats,
  VoiceV24SessionTimerStats,
  VoiceV24RunningCall,
} from './toolCallTimersV24';
export {
  DynamicProviderCatalogV24,
  createDynamicProviderCatalogV24,
  providerDescriptorV24,
  validateProviderDescriptorV24,
  defaultDynamicProviderCatalogV24Options,
  validateDynamicProviderCatalogV24Options,
} from './providerCatalogV24';
export type {
  VoiceV24ProviderDescriptor,
  VoiceV24ProviderSnapshot,
  VoiceV24ProbeResult,
  DynamicProviderCatalogV24Options,
} from './providerCatalogV24';
export {
  ProviderHealthTrackerV24,
  createProviderHealthTrackerV24,
  healthGradeV24,
  defaultProviderHealthV24Options,
  validateProviderHealthV24Options,
} from './providerHealthV24';
export type {
  VoiceV24HealthGrade,
  ProviderHealthV24Options,
  VoiceV24ProviderHealth,
} from './providerHealthV24';
export {
  VoiceModelSwitcherV24,
  createModelSwitcherV24,
  defaultModelSwitchV24Options,
  validateModelSwitchV24Options,
} from './modelSwitchV24';
export type {
  ModelSwitchV24Options,
  VoiceV24SwitchResult,
} from './modelSwitchV24';
export {
  VoiceSessionV24,
  createVoiceSessionV24,
} from './voiceSessionV24';
export type {
  VoiceSessionV24Options,
  VoiceV24SessionPhase,
  VoiceV24SessionSnapshot,
} from './voiceSessionV24';
export {
  TimerPanelV24,
  createTimerPanelV24,
  defaultTimerPanelV24Options,
  validateTimerPanelV24Options,
  VOICE_V24_PANEL_I18N_KEYS,
} from './timerPanelV24';
export type {
  TimerPanelV24Options,
  VoiceV24PanelToolRow,
  VoiceV24PanelSnapshot,
} from './timerPanelV24';
export {
  ToolBudgetRegistryV24,
  createToolBudgetRegistryV24,
  defaultToolBudgetV24Options,
  validateToolBudgetV24Options,
} from './toolBudgetsV24';
export type {
  ToolBudgetV24Options,
  VoiceV24ToolBudget,
  VoiceV24BudgetBreachKind,
  VoiceV24BudgetBreach,
  VoiceV24BurnDown,
} from './toolBudgetsV24';
export {
  ModelFallbackChainV24,
  createModelFallbackChainV24,
  defaultModelFallbackV24Options,
  validateModelFallbackV24Options,
} from './modelFallbackV24';
export type {
  ModelFallbackV24Options,
  VoiceV24FallbackDecision,
  VoiceV24FallbackLink,
} from './modelFallbackV24';
export {
  ProviderRefreshSchedulerV24,
  createProviderRefreshSchedulerV24,
  defaultProviderRefreshV24Options,
  validateProviderRefreshV24Options,
} from './providerRefreshV24';
export type {
  ProviderRefreshV24Options,
  VoiceV24RefreshState,
  VoiceV24RefreshDue,
  VoiceV24RefreshRound,
} from './providerRefreshV24';
