/**
 * @open-bot/core/voiceV25 — voice realtime v25 (v1.38, Đội T5).
 *
 * The conversation-flow layer on top of v24: barge-in /
 * interruption handling at turn level (the user cuts the
 * agent off mid-reply; the agent stops at a measured offset
 * and the transcript keeps only what was actually spoken),
 * turn-taking + silence detection (who holds the floor, when
 * a silence hands it over, silence statistics per turn),
 * real per-provider voice latency (TTFT / first-audio /
 * turn total, rolling p50/p95, latency-threshold fallback
 * to a faster provider), and per-voice-turn timers that
 * extend the v24 per-tool-call timers to whole turns
 * (listen / silence-wait / think / speak phases per turn,
 * per-session turn aggregates, slow-turn alerts, and a panel
 * row per turn).
 *
 * The burst-level interruption decision stays in v23 and
 * the frame-level endpointing stays in v23; the provider
 * catalogue, health scoring and model switching stay in
 * v24. v25 consumes those and owns the turn-level
 * consequences.
 *
 * All clocks virtual, all audio mock/synthetic, no network,
 * no key, no mic/sound card.
 */
export {
  clampV25,
  round2V25,
  round4V25,
  meanV25,
  percentileV25,
  formatDurationV25,
  formatDurationShortV25,
  durationBucketV25,
  isValidVoiceV25Id,
  turnChecksumV25,
  phaseDurationV25,
  isTurnActiveV25,
  VOICE_V25_SILENCE_DEFAULT_MS,
  VOICE_V25_SILENCE_YIELD_DEFAULT_MS,
  VOICE_V25_MIN_SPEECH_DEFAULT_MS,
  VOICE_V25_MAX_TURN_DEFAULT_MS,
  VOICE_V25_MAX_USER_TURN_DEFAULT_MS,
  VOICE_V25_BARGEIN_MIN_SPEECH_DEFAULT_MS,
  VOICE_V25_STOP_LATENCY_SLOW_DEFAULT_MS,
  VOICE_V25_SLOW_TURN_DEFAULT_MS,
  VOICE_V25_LONG_SILENCE_DEFAULT_MS,
  VOICE_V25_LATENCY_SLOW_DEFAULT_MS,
  VOICE_V25_LATENCY_P95_WINDOW,
  VOICE_V25_CONSECUTIVE_SLOW_DEFAULT,
  VOICE_V25_CONSECUTIVE_FAILURES_DEFAULT,
  VOICE_V25_FALLBACK_COOLDOWN_DEFAULT_MS,
} from './types';
export type {
  VoiceV25Clock,
  VoiceV25TurnPhase,
  VoiceV25TurnRole,
  VoiceV25TurnStatus,
  VoiceV25PhaseSpan,
  VoiceV25TurnRecord,
  VoiceV25SilenceState,
  VoiceV25SilenceGap,
  VoiceV25BargeInKind,
  VoiceV25BargeInDecision,
  VoiceV25ResumeStrategy,
  VoiceV25BargeInRecord,
  VoiceV25LatencyKind,
  VoiceV25LatencySample,
  VoiceV25LatencyStats,
  VoiceV25LatencyFallbackDecision,
  VoiceV25TurnAlertKind,
  VoiceV25TurnAlert,
  VoiceV25FloorHolder,
  VoiceV25TurnTakingState,
  VoiceV25DurationBucket,
} from './types';
export {
  SilenceDetectorV25,
  createSilenceDetectorV25,
  defaultSilenceDetectorV25Options,
  validateSilenceDetectorV25Options,
} from './silenceDetectionV25';
export type {
  SilenceDetectorV25Options,
  VoiceV25SilenceEventKind,
  VoiceV25SilenceEvent,
  VoiceV25SilenceStats,
} from './silenceDetectionV25';
export {
  BargeInManagerV25,
  createBargeInManagerV25,
  defaultBargeInV25Options,
  validateBargeInV25Options,
} from './bargeInV25';
export type {
  BargeInV25Options,
  VoiceV25DuckEvent,
  VoiceV25BargeInStats,
  VoiceV25BurstResult,
  VoiceV25StopResult,
} from './bargeInV25';
export {
  TurnTakingManagerV25,
  createTurnTakingManagerV25,
  defaultTurnTakingV25Options,
  validateTurnTakingV25Options,
} from './turnTakingV25';
export type {
  TurnTakingV25Options,
  VoiceV25Backchannel,
  VoiceV25TurnTakingStats,
  VoiceV25Transition,
} from './turnTakingV25';
export {
  ProviderLatencyTrackerV25,
  createProviderLatencyTrackerV25,
  defaultProviderLatencyV25Options,
  validateProviderLatencyV25Options,
} from './latencyProbeV25';
export type {
  ProviderLatencyV25Options,
  VoiceV25ProviderLatencyRank,
} from './latencyProbeV25';
export {
  TurnTimerRegistryV25,
  createTurnTimerRegistryV25,
  defaultTurnTimerV25Options,
  validateTurnTimerV25Options,
} from './turnTimersV25';
export type {
  TurnTimerV25Options,
  VoiceV25SessionTurnStats,
  VoiceV25RoleTurnStats,
  VoiceV25RunningTurn,
} from './turnTimersV25';
export {
  TurnPanelV25,
  createTurnPanelV25,
  defaultTurnPanelV25Options,
  validateTurnPanelV25Options,
  VOICE_V25_PANEL_I18N_KEYS,
} from './turnPanelV25';
export type {
  TurnPanelV25Options,
  VoiceV25PanelTurnRow,
  VoiceV25PanelSnapshot,
} from './turnPanelV25';
export {
  VoiceSessionV25,
  createVoiceSessionV25,
} from './voiceSessionV25';
export type {
  VoiceSessionV25Options,
  VoiceV25SessionPhase,
  VoiceV25SessionSnapshot,
} from './voiceSessionV25';
