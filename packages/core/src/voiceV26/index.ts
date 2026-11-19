/**
 * @open-bot/core/voiceV26 — voice realtime v26 (v1.39, Team T5).
 *
 * The realtime loop on top of v25: frame-level barge-in
 * detection (suspect -> duck -> confirm -> stop, spoken prefix
 * + resume context), a guarded turn-taking machine (anti-overlap
 * queue, per-phase timeouts), an end-to-end latency budget
 * (STT -> model -> TTS, breach alerts, degraded mode that trades
 * quality for latency), an expanded TTS/STT provider registry
 * (local + API-key via Vault refs, deterministic mocks), a
 * session orchestrating all four, and a live status panel
 * renderable as a desktop panel or an MCP Apps `ui://` resource.
 *
 * v25 stays untouched: v26 consumes its turn records only
 * through its own types and composes its own classes. All
 * clocks virtual, all audio mock/synthetic, no network, no
 * key, no mic/sound card.
 */
export {
  clampV26,
  round2V26,
  round4V26,
  meanV26,
  percentileV26,
  formatDurationV26,
  formatDurationShortV26,
  durationBucketV26,
  isValidVoiceV26Id,
  turnChecksumV26,
  cutAtWordBoundaryV26,
  floorHolderForStateV26,
  statusStateForFloorV26,
  strategyForSpokenFractionV26,
  VOICE_V26_NOISE_FLOOR_DEFAULT,
  VOICE_V26_THRESHOLD_MARGIN_DEFAULT,
  VOICE_V26_MIN_SPEECH_DEFAULT_MS,
  VOICE_V26_DUCK_AFTER_MS_DEFAULT,
  VOICE_V26_CONFIRM_AFTER_MS_DEFAULT,
  VOICE_V26_GRACE_AFTER_REPLY_START_MS_DEFAULT,
  VOICE_V26_BACKCHANNEL_MAX_MS_DEFAULT,
  VOICE_V26_MAX_TURN_DEFAULT_MS,
  VOICE_V26_MAX_USER_TURN_DEFAULT_MS,
  VOICE_V26_MAX_THINKING_DEFAULT_MS,
  VOICE_V26_MAX_LISTENING_DEFAULT_MS,
  VOICE_V26_MAX_SPEAKING_DEFAULT_MS,
  VOICE_V26_STOP_LATENCY_SLOW_DEFAULT_MS,
  VOICE_V26_LATENCY_P95_WINDOW,
  VOICE_V26_CONSECUTIVE_BREACHES_DEFAULT,
  VOICE_V26_CONSECUTIVE_CLEAN_DEFAULT,
  VOICE_V26_LEVEL_SMOOTHING_DEFAULT,
  VOICE_V26_PEAK_DECAY_PER_MS,
  VOICE_V26_MAX_TURNS_DEFAULT,
  VOICE_V26_MAX_RECORDS_DEFAULT,
  VOICE_V26_MAX_SAMPLES_DEFAULT,
  VOICE_V26_BUDGET_PROFILES,
  VOICE_V26_DEGRADED_POLICIES,
  VOICE_V26_MOCK_PROVIDERS,
} from './types';
export type {
  VoiceV26Clock,
  VoiceV26FloorState,
  VoiceV26FloorHolder,
  VoiceV26BargeInStage,
  VoiceV26ResumeStrategy,
  VoiceV26BargeInKind,
  VoiceV26LatencyStage,
  VoiceV26BudgetProfile,
  VoiceV26DegradedLevel,
  VoiceV26ProviderKind,
  VoiceV26ProviderOrigin,
  VoiceV26ProviderClass,
  VoiceV26StatusState,
  VoiceV26AudioFrame,
  VoiceV26BargeInRecord,
  VoiceV26FrameResult,
  VoiceV26StopResult,
  VoiceV26ResumeContext,
  VoiceV26PhaseSpan,
  VoiceV26TurnRecord,
  VoiceV26Transition,
  VoiceV26StageBudgets,
  VoiceV26LatencySample,
  VoiceV26StageStats,
  VoiceV26BudgetBreach,
  VoiceV26DegradedEvent,
  VoiceV26DegradedPolicy,
  VoiceV26ProviderDef,
  VoiceV26ProviderSelection,
  VoiceV26MockAudioResult,
  VoiceV26LevelSample,
  VoiceV26StatusSnapshot,
  VoiceV26UiResource,
} from './types';
export {
  BargeInDetectorV26,
  createBargeInDetectorV26,
  defaultBargeInV26Options,
  validateBargeInV26Options,
} from './bargeInV26';
export type {
  BargeInV26Options,
  VoiceV26BargeInStats,
  VoiceV26BackchannelNote,
  VoiceV26DuckEvent,
} from './bargeInV26';
export {
  TurnTakingMachineV26,
  createTurnTakingMachineV26,
  defaultTurnTakingV26Options,
  validateTurnTakingV26Options,
} from './turnTakingV26';
export type {
  TurnTakingV26Options,
  VoiceV26AgentStartResult,
  VoiceV26QueuedReply,
  VoiceV26TurnTakingStats,
  VoiceV26Backchannel,
} from './turnTakingV26';
export {
  LatencyBudgetV26,
  createLatencyBudgetV26,
  defaultLatencyBudgetV26Options,
  validateLatencyBudgetV26Options,
} from './latencyBudgetV26';
export type {
  LatencyBudgetV26Options,
  VoiceV26TurnLatency,
  VoiceV26LatencyBudgetStats,
} from './latencyBudgetV26';
export {
  ProviderRegistryV26,
  createProviderRegistryV26,
  defaultProviderRegistryV26Options,
  validateProviderRegistryV26Options,
  validateProviderDefV26,
} from './providersV26';
export type {
  ProviderRegistryV26Options,
  VoiceV26SelectPrefs,
  VoiceV26ProviderRank,
} from './providersV26';
export {
  VoiceSessionV26,
  createVoiceSessionV26,
} from './sessionV26';
export type {
  VoiceSessionV26Options,
  VoiceV26SessionEvent,
  VoiceV26SessionSnapshot,
} from './sessionV26';
export {
  StatusPanelV26,
  createStatusPanelV26,
  defaultStatusPanelV26Options,
  validateStatusPanelV26Options,
  buildStatusSnapshotV26,
  VOICE_V26_PANEL_I18N_KEYS,
  VOICE_V26_I18N_KEYS,
} from './statusPanelV26';
export type {
  StatusPanelV26Options,
  VoiceV26PanelRow,
} from './statusPanelV26';
