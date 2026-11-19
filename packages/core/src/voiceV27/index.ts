/**
 * @open-bot/core/voiceV27 — voice realtime v27 (v1.40, Team T5).
 *
 * Realtime v2 on top of v26: barge-in v2 (interrupt policy +
 * event log), turn-taking v2 + VAD tuning (presets, calibration,
 * short-noise rejection, turn history), multi-voice personas
 * (builtin + custom, per-bot memory, mid-session switching,
 * mock preview, fallback), and durable session state (JSON
 * file per session, atomic saves, state confirmation before
 * every operation, crash recovery).
 *
 * v26 stays untouched: v27 consumes nothing from v26 at runtime
 * and only reuses its vocabulary (floor states, word-boundary
 * cuts) through its own types. All clocks virtual, all audio
 * mock/synthetic, no network, no key, no mic/sound card.
 */
export {
  clampV27,
  round2V27,
  round4V27,
  meanV27,
  percentileV27,
  isValidVoiceV27Id,
  cutAtWordBoundaryV27,
  formatDurationV27,
  durationBucketV27,
  effectiveThresholdV27,
  defaultVadConfigV27,
  resumeDecisionForSpokenFractionV27,
  VOICE_V27_SILENCE_THRESHOLD_DEFAULT,
  VOICE_V27_SENSITIVITY_DEFAULT,
  VOICE_V27_MIN_SPEECH_DEFAULT_MS,
  VOICE_V27_END_SILENCE_DEFAULT_MS,
  VOICE_V27_HANGOVER_DEFAULT_MS,
  VOICE_V27_NOISE_FLOOR_DEFAULT,
  VOICE_V27_NOISE_FLOOR_LEARN_RATE,
  VOICE_V27_FRAME_MS_DEFAULT,
  VOICE_V27_MAX_VAD_SAMPLES_DEFAULT,
  VOICE_V27_MAX_TURNS_DEFAULT,
  VOICE_V27_MAX_TURN_DEFAULT_MS,
  VOICE_V27_MAX_LISTENING_DEFAULT_MS,
  VOICE_V27_MAX_THINKING_DEFAULT_MS,
  VOICE_V27_MAX_SPEAKING_DEFAULT_MS,
  VOICE_V27_VAD_PRESETS,
  VOICE_V27_GRACE_AFTER_REPLY_START_DEFAULT_MS,
  VOICE_V27_INTERRUPT_COOLDOWN_DEFAULT_MS,
  VOICE_V27_MIN_INTERRUPT_SPEECH_DEFAULT_MS,
  VOICE_V27_STORM_WINDOW_DEFAULT_MS,
  VOICE_V27_STORM_THRESHOLD_DEFAULT,
  VOICE_V27_STORM_COOLDOWN_DEFAULT_MS,
  VOICE_V27_MAX_INTERRUPT_EVENTS_DEFAULT,
  VOICE_V27_BACKCHANNEL_MAX_DEFAULT_MS,
  VOICE_V27_STOP_LATENCY_SLOW_DEFAULT_MS,
  VOICE_V27_SESSION_TTL_DEFAULT_MS,
  VOICE_V27_MAX_CHECKPOINTS_DEFAULT,
  VOICE_V27_STATE_TRANSITIONS,
  VOICE_V27_BUILTIN_PERSONAS,
} from './types';
export type {
  VoiceV27Clock,
  VoiceV27SessionState,
  VoiceV27FloorHolder,
  VoiceV27InterruptMode,
  VoiceV27ResumeDecision,
  VoiceV27InterruptKind,
  VoiceV27InterruptDecision,
  VoiceV27InterruptIgnoreReason,
  VoiceV27VadPreset,
  VoiceV27FrameKind,
  VoiceV27TurnEndReason,
  VoiceV27TurnStatus,
  VoiceV27PersonaStyle,
  VoiceV27VadFrame,
  VoiceV27VadConfig,
  VoiceV27InterruptEvent,
  VoiceV27InterruptFeedResult,
  VoiceV27InterruptStopResult,
  VoiceV27VadFrameResult,
  VoiceV27TurnRecord,
  VoiceV27PersonaDef,
  VoiceV27PersonaAssignment,
  VoiceV27PersonaPreview,
  VoiceV27DurableSession,
} from './types';
export {
  InterruptPolicyV27,
  createInterruptPolicyV27,
  defaultInterruptPolicyV27Options,
  validateInterruptPolicyV27Options,
} from './interruptV27';
export type {
  InterruptPolicyV27Options,
  VoiceV27InterruptStats,
  VoiceV27ArmedReply,
} from './interruptV27';
export {
  VadTunerV27,
  createVadTunerV27,
  defaultVadTunerV27Options,
  validateVadConfigV27,
  TurnManagerV27,
  createTurnManagerV27,
  defaultTurnManagerV27Options,
  validateTurnManagerV27Options,
} from './vadV27';
export type {
  VadTunerV27Options,
  VoiceV27VadStats,
  VoiceV27Calibration,
  TurnManagerV27Options,
  VoiceV27TurnManagerStats,
} from './vadV27';
export {
  PersonaRegistryV27,
  createPersonaRegistryV27,
  defaultPersonaRegistryV27Options,
  validatePersonaDefV27,
} from './personasV27';
export type {
  PersonaRegistryV27Options,
  VoiceV27PersonaStats,
  VoiceV27PersonaSwitchResult,
} from './personasV27';
export {
  DurableSessionStoreV27,
  createDurableSessionStoreV27,
  defaultDurableSessionStoreV27Options,
} from './sessionStoreV27';
export type {
  DurableSessionStoreV27Options,
  VoiceV27StateGuard,
  VoiceV27StoreVerifyResult,
  VoiceV27StoreStats,
} from './sessionStoreV27';
export {
  VoiceSessionV27,
  createVoiceSessionV27,
} from './sessionV27';
export type {
  VoiceSessionV27Options,
  VoiceV27SessionEvent,
  VoiceV27SessionSnapshot,
} from './sessionV27';

/** i18n keys owned by voice v27 (all 6 locales, sorted files). */
export const VOICE_V27_I18N_KEYS = [
  'voice.v27.interrupt.confirmed',
  'voice.v27.interrupt.cooldown',
  'voice.v27.interrupt.criticalProtected',
  'voice.v27.interrupt.dropRemainder',
  'voice.v27.interrupt.eventLog',
  'voice.v27.interrupt.falsePositive',
  'voice.v27.interrupt.gracePeriod',
  'voice.v27.interrupt.keywordOnly',
  'voice.v27.interrupt.policy',
  'voice.v27.interrupt.resumeRemaining',
  'voice.v27.interrupt.stopLatency',
  'voice.v27.interrupt.stopped',
  'voice.v27.interrupt.storm',
  'voice.v27.interrupt.title',
  'voice.v27.personas.current',
  'voice.v27.personas.custom',
  'voice.v27.personas.fallback',
  'voice.v27.personas.language',
  'voice.v27.personas.perBot',
  'voice.v27.personas.pitch',
  'voice.v27.personas.preview',
  'voice.v27.personas.rate',
  'voice.v27.personas.select',
  'voice.v27.personas.style',
  'voice.v27.personas.switch',
  'voice.v27.personas.title',
  'voice.v27.report.interrupts',
  'voice.v27.report.personas',
  'voice.v27.report.sessions',
  'voice.v27.report.title',
  'voice.v27.report.turns',
  'voice.v27.session.checkpoint',
  'voice.v27.session.ended',
  'voice.v27.session.expired',
  'voice.v27.session.invalidTransition',
  'voice.v27.session.open',
  'voice.v27.session.paused',
  'voice.v27.session.recovered',
  'voice.v27.session.restored',
  'voice.v27.session.saved',
  'voice.v27.session.stateConfirmed',
  'voice.v27.session.title',
  'voice.v27.state.corrupt',
  'voice.v27.state.loaded',
  'voice.v27.state.missing',
  'voice.v27.state.saved',
  'voice.v27.state.title',
  'voice.v27.state.verified',
  'voice.v27.vad.calibrated',
  'voice.v27.vad.endSilence',
  'voice.v27.vad.hangover',
  'voice.v27.vad.minSpeech',
  'voice.v27.vad.noiseFloor',
  'voice.v27.vad.preset',
  'voice.v27.vad.presetBalanced',
  'voice.v27.vad.presetSensitive',
  'voice.v27.vad.presetStrict',
  'voice.v27.vad.sensitivity',
  'voice.v27.vad.shortNoiseIgnored',
  'voice.v27.vad.silenceThreshold',
  'voice.v27.vad.title',
  'voice.v27.vad.turnEnded',
  'voice.v27.vad.turnTimeout',
] as const;
