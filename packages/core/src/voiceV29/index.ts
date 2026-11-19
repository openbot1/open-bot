/**
 * @open-bot/core/voiceV29 — voice full-duplex v29 (v1.42, Team T4).
 *
 * The full-duplex generation after v28: an audio turn
 * detector (VAD + backchannel filter), a barge-in engine
 * (server-driven responses, adaptive interruption), an
 * append-only conversation context (compaction adds a
 * summary, never edits), delegated async tool calling
 * (a separate text model runs the tools, results flow
 * back into the context), proactive audio (greeting /
 * idle nudge / reminder, gated by consent, cooldowns and
 * quiet hours), a cascaded STT -> LLM -> TTS pipeline
 * with a measured latency budget plus a direct
 * speech-to-speech path, per-minute cost accounting, and
 * a full-duplex session that ties it all together on top
 * of v28's mock transport (reused by import; v28 is
 * untouched).
 *
 * Ideas only, from the v1.42 survey (gpt-realtime-2.1,
 * GPT-Live full-duplex, Gemini 3.8 Live, LiveKit Agents
 * 1.0). No code, text or assets from those projects.
 * Mock-only: no provider is dialled, no key is read,
 * no live API is called, all clocks are virtual.
 */
export {
  clampV29,
  round2V29,
  round4V29,
  meanV29,
  percentileV29,
  estimateTokensV29,
  countWordsV29,
  cutAtWordBoundaryV29,
  formatDurationV29,
  formatUsdV29,
  effectiveThresholdV29,
  isKnownModelV29,
  isVoiceV29Architecture,
  validateTurnDetectorConfigV29,
  validateBargeInConfigV29,
  modelInfoV29,
  rateForModelV29,
  costForMinutesV29,
  costForSliceV29,
  defaultTurnDetectorConfigV29,
  defaultBargeInConfigV29,
  VOICE_V29_RATE_TABLE_DEFAULT,
  VOICE_V29_MODEL_CATALOG,
  VOICE_V29_STATE_TRANSITIONS,
  VOICE_V29_CASCADED_BUDGET_TOTAL_MS,
  VOICE_V29_CASCADED_BUDGET_STT_MS,
  VOICE_V29_CASCADED_BUDGET_LLM_MS,
  VOICE_V29_CASCADED_BUDGET_TTS_MS,
  VOICE_V29_S2S_BUDGET_TOTAL_MS,
  VOICE_V29_PIPELINE_DEGRADED_THRESHOLD_MS,
  VOICE_V29_BARGE_IN_GRACE_DEFAULT_MS,
  VOICE_V29_BARGE_IN_MIN_SPEECH_DEFAULT_MS,
  VOICE_V29_BARGE_IN_MIN_ENERGY_DEFAULT,
  VOICE_V29_BARGE_IN_SENSITIVITY_DEFAULT,
  VOICE_V29_BARGE_IN_ADAPT_STEP_DEFAULT,
  VOICE_V29_BARGE_IN_ADAPT_DOWN_STEP_DEFAULT,
  VOICE_V29_DELEGATE_TIMEOUT_DEFAULT_MS,
  VOICE_V29_DELEGATE_MAX_ATTEMPTS_DEFAULT,
  VOICE_V29_DELEGATE_MAX_CONCURRENT_DEFAULT,
  VOICE_V29_DELEGATE_RETRY_BASE_MS,
  VOICE_V29_PROACTIVE_IDLE_NUDGE_DEFAULT_MS,
  VOICE_V29_PROACTIVE_COOLDOWN_DEFAULT_MS,
  VOICE_V29_PROACTIVE_MAX_TRIGGERS_DEFAULT,
  VOICE_V29_MAX_CONTEXT_ITEMS_DEFAULT,
  VOICE_V29_MAX_CONTEXT_TOKENS_DEFAULT,
  VOICE_V29_MAX_LOG_EVENTS_DEFAULT,
  VOICE_V29_MAX_TURNS_DEFAULT,
  VOICE_V29_MAX_DELEGATED_CALLS_DEFAULT,
  VOICE_V29_COST_CAP_DEFAULT_USD,
  VOICE_V29_COST_WARN_DEFAULT_USD,
  VOICE_V29_TURN_THRESHOLD_DEFAULT,
  VOICE_V29_TURN_SILENCE_TIMEOUT_DEFAULT_MS,
  VOICE_V29_TURN_HANGOVER_DEFAULT_MS,
  VOICE_V29_TURN_MIN_SPEECH_DEFAULT_MS,
  VOICE_V29_TURN_BACKCHANNEL_MAX_DEFAULT_MS,
  VOICE_V29_TURN_BACKCHANNEL_MAX_ENERGY_DEFAULT,
  VOICE_V29_TURN_NOISE_FLOOR_DEFAULT,
  VOICE_V29_TURN_NOISE_FLOOR_LEARN_RATE,
  VOICE_V29_TURN_MAX_DEFAULT_MS,
  VOICE_V29_TURN_FRAME_MS_DEFAULT,
} from './types';
export type {
  VoiceV29Architecture,
  VoiceV29ModelId,
  VoiceV29SessionState,
  VoiceV29FloorHolder,
  VoiceV29TurnEndReason,
  VoiceV29ResponseEndReason,
  VoiceV29ResponseState,
  VoiceV29InterruptRequester,
  VoiceV29InterruptVerdict,
  VoiceV29ContextItemKind,
  VoiceV29DelegatedCallState,
  VoiceV29DelegatedCallMode,
  VoiceV29ProactiveKind,
  VoiceV29PipelineStage,
  VoiceV29PipelineMode,
  VoiceV29CostAlertLevel,
  VoiceV29RateEntry,
  VoiceV29ModelInfo,
  VoiceV29AudioFrame,
  VoiceV29TurnDetectorConfig,
  VoiceV29TurnFrameKind,
  VoiceV29TurnFrameResult,
  VoiceV29Turn,
  VoiceV29BargeInConfig,
  VoiceV29ServerResponse,
  VoiceV29InterruptDecision,
  VoiceV29BargeInEvent,
  VoiceV29ContextItem,
  VoiceV29DelegatedCall,
  VoiceV29DelegatedToolDef,
  VoiceV29ProactiveTrigger,
  VoiceV29StageBudget,
  VoiceV29PipelineTurn,
  VoiceV29CostEntry,
  VoiceV29CostAlert,
  VoiceV29ProactiveEvent,
  VoiceV29SessionLogEvent,
  VoiceV29SessionSnapshot,
} from './types';
export {
  AudioTurnDetectorV29,
  createAudioTurnDetectorV29,
  defaultAudioTurnDetectorV29Options,
  VOICE_V29_TURN_PRESETS,
} from './turnDetectorV29';
export type {
  AudioTurnDetectorV29Options,
  VoiceV29TurnDetectorStats,
  VoiceV29TurnPresetName,
} from './turnDetectorV29';
export {
  BargeInEngineV29,
  createBargeInEngineV29,
  defaultBargeInEngineV29Options,
} from './bargeInV29';
export type {
  BargeInEngineV29Options,
  VoiceV29BargeInStats,
} from './bargeInV29';
export {
  AppendOnlyContextV29,
  createAppendOnlyContextV29,
  defaultAppendOnlyContextV29Options,
} from './appendOnlyContextV29';
export type {
  AppendOnlyContextV29Options,
  VoiceV29ContextStats,
  VoiceV29CompactionResult,
} from './appendOnlyContextV29';
export {
  DelegatedToolRunnerV29,
  createDelegatedToolRunnerV29,
  defaultDelegatedToolRunnerV29Options,
} from './delegatedToolsV29';
export type {
  DelegatedToolRunnerV29Options,
  VoiceV29DelegatedStats,
} from './delegatedToolsV29';
export {
  ProactiveAudioV29,
  createProactiveAudioV29,
  defaultProactiveAudioV29Options,
} from './proactiveAudioV29';
export type {
  ProactiveAudioV29Options,
  VoiceV29ProactiveStats,
  VoiceV29QuietHours,
} from './proactiveAudioV29';
export {
  CascadedPipelineV29,
  createCascadedPipelineV29,
  defaultCascadedPipelineV29Options,
} from './cascadedPipelineV29';
export type {
  CascadedPipelineV29Options,
  VoiceV29PipelineStats,
  VoiceV29PipelineReport,
  VoiceV29MeasuredStages,
} from './cascadedPipelineV29';
export {
  CostLedgerV29,
  createCostLedgerV29,
  defaultCostLedgerV29Options,
  dayKey,
} from './costAccountingV29';
export type {
  CostLedgerV29Options,
  VoiceV29CostSessionMeter,
  VoiceV29CostReport,
  VoiceV29CostEstimate,
} from './costAccountingV29';
export {
  FullDuplexSessionV29,
  createFullDuplexSessionV29,
  defaultFullDuplexSessionV29Options,
} from './sessionV29';
export type {
  FullDuplexSessionV29Options,
  VoiceV29SessionStats,
} from './sessionV29';

/** i18n keys owned by voice v29 (all 6 locales, sorted files). */
export const VOICE_V29_I18N_KEYS = [
  'voice.v29.bargein.confidence',
  'voice.v29.bargein.discard',
  'voice.v29.bargein.grace',
  'voice.v29.bargein.ignored',
  'voice.v29.bargein.interrupted',
  'voice.v29.bargein.resume',
  'voice.v29.bargein.sensitivity',
  'voice.v29.bargein.title',
  'voice.v29.context.compact',
  'voice.v29.context.items',
  'voice.v29.context.search',
  'voice.v29.context.superseded',
  'voice.v29.context.title',
  'voice.v29.context.tokens',
  'voice.v29.cost.capReached',
  'voice.v29.cost.estimated',
  'voice.v29.cost.perMinute',
  'voice.v29.cost.title',
  'voice.v29.cost.total',
  'voice.v29.cost.warning',
  'voice.v29.delegate.awaitingApproval',
  'voice.v29.delegate.done',
  'voice.v29.delegate.failed',
  'voice.v29.delegate.queued',
  'voice.v29.delegate.running',
  'voice.v29.delegate.title',
  'voice.v29.panel.architecture',
  'voice.v29.panel.connecting',
  'voice.v29.panel.cost',
  'voice.v29.panel.ended',
  'voice.v29.panel.floor',
  'voice.v29.panel.idle',
  'voice.v29.panel.interruptions',
  'voice.v29.panel.latency',
  'voice.v29.panel.listening',
  'voice.v29.panel.model',
  'voice.v29.panel.paused',
  'voice.v29.panel.speaking',
  'voice.v29.panel.state',
  'voice.v29.panel.thinking',
  'voice.v29.panel.title',
  'voice.v29.panel.turns',
  'voice.v29.pipeline.cascaded',
  'voice.v29.pipeline.overBudget',
  'voice.v29.pipeline.speechToSpeech',
  'voice.v29.pipeline.title',
  'voice.v29.pipeline.withinBudget',
  'voice.v29.proactive.greeting',
  'voice.v29.proactive.idleNudge',
  'voice.v29.proactive.quietHours',
  'voice.v29.proactive.reminder',
  'voice.v29.proactive.title',
  'voice.v29.turn.backchannel',
  'voice.v29.turn.ended',
  'voice.v29.turn.maxDuration',
  'voice.v29.turn.noiseRejected',
  'voice.v29.turn.silenceTimeout',
  'voice.v29.turn.started',
  'voice.v29.turn.threshold',
  'voice.v29.turn.title',
] as const;
