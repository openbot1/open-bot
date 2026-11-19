/**
 * @open-bot/core/voiceV30 — voice full-duplex v30 (v1.44, Team T4).
 *
 * The second full-duplex generation after v29, hardening the
 * five places where v29 was naive:
 *
 *   - turn detection v2: dual-threshold hysteresis, a pre-turn
 *     confirmation buffer (bursts never open a turn), an
 *     adaptive silence timeout learned from turn cadence,
 *     single-frame spike rejection, a per-turn confidence
 *     score, and an echo guard for agent audio;
 *   - full-duplex v2: two independent lanes (inbound user,
 *     outbound agent) running at the same time, a jitter
 *     buffer, bounded queues with backpressure, a degraded
 *     half-duplex mode under overload, crosstalk detection,
 *     and per-turn latency SLOs;
 *   - barge-in v2: soft (pause + resume) vs hard (cancel)
 *     interruptions, confidence from sustained speech plus
 *     the energy slope, resume from a sentence boundary, a
 *     cooldown after each barge-in, and false-positive
 *     learning;
 *   - proactive audio v2: a priority queue (critical
 *     pre-empts), token-bucket rate limiting per kind plus
 *     globally, deduplication by key, TTL expiry,
 *     presence / DND / quiet-hours gating, and a text
 *     fallback when audio is suppressed;
 *   - cost ledger v2: a minute + token hybrid (audio minutes
 *     plus LLM text tokens), per-kind breakdown, day / week /
 *     month rollups, budget envelopes (soft warn + hard cap
 *     per session, day and month), run-rate forecasts, and
 *     itemised statements (Markdown / CSV / JSON);
 *   - a session that ties all five together, with a
 *     `degraded` state and explicit recovery.
 *
 * Ideas only, from the v1.44 survey. No code, text or assets
 * from any surveyed project. Mock-only: no provider is
 * dialled, no key is read, no live API is called, all
 * clocks are virtual. v29 is never modified by v30.
 */
export {
  clampV30,
  round2V30,
  round4V30,
  round6V30,
  meanV30,
  percentileV30,
  estimateTokensV30,
  cutAtSentenceBoundaryV30,
  formatDurationV30,
  formatUsdV30,
  dayKeyV30,
  weekKeyV30,
  monthKeyV30,
  isKnownModelV30,
  modelInfoV30,
  rateForModelV30,
  costForMinutesV30,
  costForTokensV30,
  costForSliceV30,
  defaultTurnDetectorConfigV30,
  defaultBargeInConfigV30,
  validateTurnDetectorConfigV30,
  validateBargeInConfigV30,
  VOICE_V30_RATE_TABLE_DEFAULT,
  VOICE_V30_MODEL_CATALOG,
  VOICE_V30_TURN_HIGH_THRESHOLD_DEFAULT,
  VOICE_V30_TURN_LOW_THRESHOLD_DEFAULT,
  VOICE_V30_TURN_SILENCE_TIMEOUT_DEFAULT_MS,
  VOICE_V30_TURN_HANGOVER_DEFAULT_MS,
  VOICE_V30_TURN_CONFIRM_DEFAULT_MS,
  VOICE_V30_TURN_MIN_SPEECH_DEFAULT_MS,
  VOICE_V30_TURN_BACKCHANNEL_MAX_DEFAULT_MS,
  VOICE_V30_TURN_BACKCHANNEL_MAX_ENERGY_DEFAULT,
  VOICE_V30_TURN_NOISE_FLOOR_DEFAULT,
  VOICE_V30_TURN_NOISE_FLOOR_LEARN_RATE,
  VOICE_V30_TURN_MAX_DEFAULT_MS,
  VOICE_V30_TURN_FRAME_MS_DEFAULT,
  VOICE_V30_TURN_SPIKE_THRESHOLD_DEFAULT,
  VOICE_V30_TURN_MIN_CONFIDENCE_DEFAULT,
  VOICE_V30_TURN_ADAPTIVE_SILENCE_MIN_MS,
  VOICE_V30_TURN_ADAPTIVE_SILENCE_MAX_MS,
  VOICE_V30_BARGE_IN_GRACE_DEFAULT_MS,
  VOICE_V30_BARGE_IN_COOLDOWN_DEFAULT_MS,
  VOICE_V30_BARGE_IN_MIN_SPEECH_DEFAULT_MS,
  VOICE_V30_BARGE_IN_MIN_ENERGY_DEFAULT,
  VOICE_V30_BARGE_IN_SOFT_CONFIDENCE_DEFAULT,
  VOICE_V30_BARGE_IN_HARD_CONFIDENCE_DEFAULT,
  VOICE_V30_BARGE_IN_SENSITIVITY_DEFAULT,
  VOICE_V30_BARGE_IN_ADAPT_STEP_DEFAULT,
  VOICE_V30_BARGE_IN_ADAPT_DOWN_STEP_DEFAULT,
  VOICE_V30_DUPLEX_INBOUND_QUEUE_MAX_DEFAULT,
  VOICE_V30_DUPLEX_OUTBOUND_QUEUE_MAX_DEFAULT,
  VOICE_V30_DUPLEX_JITTER_BUFFER_MS_DEFAULT,
  VOICE_V30_DUPLEX_FIRST_BYTE_SLO_MS_DEFAULT,
  VOICE_V30_DUPLEX_TOTAL_SLO_MS_DEFAULT,
  VOICE_V30_DUPLEX_CROSSTALK_WINDOW_MS_DEFAULT,
  VOICE_V30_DUPLEX_MAX_TURNS_DEFAULT,
  VOICE_V30_PROACTIVE_IDLE_NUDGE_DEFAULT_MS,
  VOICE_V30_PROACTIVE_COOLDOWN_DEFAULT_MS,
  VOICE_V30_PROACTIVE_MAX_TRIGGERS_DEFAULT,
  VOICE_V30_PROACTIVE_BUCKET_CAPACITY_DEFAULT,
  VOICE_V30_PROACTIVE_BUCKET_REFILL_PER_MIN_DEFAULT,
  VOICE_V30_PROACTIVE_DEDUPE_WINDOW_DEFAULT_MS,
  VOICE_V30_PROACTIVE_TTL_DEFAULT_MS,
  VOICE_V30_COST_SESSION_WARN_DEFAULT_USD,
  VOICE_V30_COST_SESSION_CAP_DEFAULT_USD,
  VOICE_V30_COST_DAILY_WARN_DEFAULT_USD,
  VOICE_V30_COST_DAILY_CAP_DEFAULT_USD,
  VOICE_V30_COST_MONTHLY_WARN_DEFAULT_USD,
  VOICE_V30_COST_MONTHLY_CAP_DEFAULT_USD,
  VOICE_V30_MAX_TURNS_DEFAULT,
  VOICE_V30_MAX_LOG_EVENTS_DEFAULT,
} from './types';
export type {
  VoiceV30ModelId,
  VoiceV30SessionState,
  VoiceV30FloorHolder,
  VoiceV30TurnEndReason,
  VoiceV30ProactiveKind,
  VoiceV30ProactivePriority,
  VoiceV30ProactiveOutcome,
  VoiceV30PipelineMode,
  VoiceV30Lane,
  VoiceV30LaneState,
  VoiceV30DegradationReason,
  VoiceV30InterruptLevel,
  VoiceV30InterruptRequester,
  VoiceV30InterruptVerdict,
  VoiceV30ResponseState,
  VoiceV30CostAlertLevel,
  VoiceV30CostKind,
  VoiceV30AudioFrame,
  VoiceV30TurnDetectorConfig,
  VoiceV30Turn,
  VoiceV30TurnFrameResult,
  VoiceV30BargeInConfig,
  VoiceV30ServerResponse,
  VoiceV30InterruptDecision,
  VoiceV30BargeInEvent,
  VoiceV30ProactiveTrigger,
  VoiceV30ProactiveEvent,
  VoiceV30LaneFrame,
  VoiceV30DuplexTurn,
  VoiceV30RateEntry,
  VoiceV30CostEntry,
  VoiceV30CostAlert,
  VoiceV30Budget,
  VoiceV30SessionSnapshot,
  VoiceV30SessionLogEvent,
  VoiceV30ModelInfo,
} from './types';
export {
  AudioTurnDetectorV30,
  createAudioTurnDetectorV30,
  defaultAudioTurnDetectorV30Options,
  VOICE_V30_TURN_PRESETS,
} from './turnDetectorV30';
export type {
  AudioTurnDetectorV30Options,
  VoiceV30TurnDetectorStats,
  VoiceV30TurnPresetName,
} from './turnDetectorV30';
export {
  FullDuplexEngineV30,
  createFullDuplexEngineV30,
  defaultFullDuplexEngineV30Options,
} from './fullDuplexV30';
export type {
  FullDuplexEngineV30Options,
  VoiceV30DuplexStats,
  VoiceV30DuplexReport,
} from './fullDuplexV30';
export {
  BargeInEngineV30,
  createBargeInEngineV30,
  defaultBargeInEngineV30Options,
} from './bargeInV30';
export type {
  BargeInEngineV30Options,
  VoiceV30BargeInStats,
} from './bargeInV30';
export {
  ProactiveAudioV30,
  createProactiveAudioV30,
  defaultProactiveAudioV30Options,
  VOICE_V30_PROACTIVE_PRIORITY_RANK,
  VOICE_V30_PROACTIVE_KIND_PRIORITY,
} from './proactiveAudioV30';
export type {
  ProactiveAudioV30Options,
  VoiceV30ProactiveStats,
  VoiceV30QuietHours,
} from './proactiveAudioV30';
export {
  CostLedgerV30,
  createCostLedgerV30,
  defaultCostLedgerV30Options,
} from './costLedgerV30';
export type {
  CostLedgerV30Options,
  VoiceV30CostSessionMeter,
  VoiceV30CostReport,
  VoiceV30CostEstimate,
  VoiceV30CostForecast,
} from './costLedgerV30';
export {
  FullDuplexSessionV30,
  createFullDuplexSessionV30,
  defaultFullDuplexSessionV30Options,
} from './sessionV30';
export type {
  FullDuplexSessionV30Options,
  VoiceV30SessionStats,
} from './sessionV30';

/** i18n keys owned by voice v30 (all 6 locales, sorted files). */
export const VOICE_V30_I18N_KEYS = [
  'voice.v30.bargein.cooldown',
  'voice.v30.bargein.confidence',
  'voice.v30.bargein.falsePositive',
  'voice.v30.bargein.hard',
  'voice.v30.bargein.ignored',
  'voice.v30.bargein.interrupted',
  'voice.v30.bargein.resume',
  'voice.v30.bargein.sensitivity',
  'voice.v30.bargein.soft',
  'voice.v30.bargein.title',
  'voice.v30.cost.byKind',
  'voice.v30.cost.capReached',
  'voice.v30.cost.estimated',
  'voice.v30.cost.forecast',
  'voice.v30.cost.perMinute',
  'voice.v30.cost.perToken',
  'voice.v30.cost.title',
  'voice.v30.cost.tokens',
  'voice.v30.cost.total',
  'voice.v30.cost.warning',
  'voice.v30.duplex.backpressure',
  'voice.v30.duplex.crosstalk',
  'voice.v30.duplex.degraded',
  'voice.v30.duplex.latency',
  'voice.v30.duplex.recovered',
  'voice.v30.duplex.title',
  'voice.v30.panel.cost',
  'voice.v30.panel.degraded',
  'voice.v30.panel.ended',
  'voice.v30.panel.floor',
  'voice.v30.panel.interruptions',
  'voice.v30.panel.latency',
  'voice.v30.panel.listening',
  'voice.v30.panel.model',
  'voice.v30.panel.paused',
  'voice.v30.panel.speaking',
  'voice.v30.panel.state',
  'voice.v30.panel.thinking',
  'voice.v30.panel.title',
  'voice.v30.panel.turns',
  'voice.v30.proactive.alert',
  'voice.v30.proactive.deduplicated',
  'voice.v30.proactive.expired',
  'voice.v30.proactive.greeting',
  'voice.v30.proactive.idleNudge',
  'voice.v30.proactive.quietHours',
  'voice.v30.proactive.rateLimited',
  'voice.v30.proactive.reminder',
  'voice.v30.proactive.taskComplete',
  'voice.v30.proactive.textFallback',
  'voice.v30.proactive.title',
  'voice.v30.turn.backchannel',
  'voice.v30.turn.confidence',
  'voice.v30.turn.echo',
  'voice.v30.turn.ended',
  'voice.v30.turn.maxDuration',
  'voice.v30.turn.noiseRejected',
  'voice.v30.turn.silenceTimeout',
  'voice.v30.turn.spikeRejected',
  'voice.v30.turn.started',
  'voice.v30.turn.threshold',
  'voice.v30.turn.title',
] as const;
