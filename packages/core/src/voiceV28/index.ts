/**
 * @open-bot/core/voiceV28 — voice realtime v28 (v1.41, Team T5).
 *
 * Realtime v3 on top of v27: a mock realtime transport
 * (streaming audio chunks in/out, jitter buffer, drop
 * policy, latency stats), a VAD hook (silence timeout,
 * hangover, adaptive floor, callbacks), a realtime session
 * (start / pause / resume / stop, barge-in that stops
 * playback and keeps the context, floor control, session
 * log), memory-block voice style (persona/human blocks
 * drive rate / pitch / style / greeting, live refresh +
 * subscribe, fallback preset), voice command routing
 * (transcript -> tool, English + Vietnamese), transcript +
 * summary (turns, top phrases, key sentences, JSON /
 * Markdown export), and multi-voice casting (one voice
 * per role per bot, fallback chains, mid-session switch).
 *
 * v27 stays untouched: v28 consumes nothing from v27 at
 * runtime and only reuses its vocabulary (floor states,
 * word-boundary cuts) through its own types. All clocks
 * virtual, all audio mock/synthetic, no network, no key,
 * no mic/sound card.
 */
export {
  clampV28,
  round2V28,
  round4V28,
  meanV28,
  percentileV28,
  isValidVoiceV28Id,
  cutAtWordBoundaryV28,
  countWordsV28,
  splitSentencesV28,
  effectiveThresholdV28,
  formatDurationV28,
  estimateSpeechDurationMsV28,
  defaultVoiceConfigV28,
  defaultTransportConfigV28,
  defaultVadHookConfigV28,
  stylePresetV28,
  greetingTemplateV28,
  renderGreetingV28,
  VOICE_V28_SAMPLE_RATE_DEFAULT,
  VOICE_V28_CHUNK_SAMPLES_DEFAULT,
  VOICE_V28_CHANNELS_DEFAULT,
  VOICE_V28_MAX_BUFFERED_CHUNKS_DEFAULT,
  VOICE_V28_SIMULATED_LATENCY_DEFAULT_MS,
  VOICE_V28_MAX_CHUNKS_PER_SESSION_DEFAULT,
  VOICE_V28_MAX_TRANSPORT_EVENTS_DEFAULT,
  VOICE_V28_JITTER_BUFFER_TARGET_DEFAULT_MS,
  VOICE_V28_VAD_THRESHOLD_DEFAULT,
  VOICE_V28_VAD_SILENCE_TIMEOUT_DEFAULT_MS,
  VOICE_V28_VAD_HANGOVER_DEFAULT_MS,
  VOICE_V28_VAD_MIN_SPEECH_DEFAULT_MS,
  VOICE_V28_VAD_NOISE_FLOOR_DEFAULT,
  VOICE_V28_VAD_NOISE_FLOOR_LEARN_RATE,
  VOICE_V28_VAD_FRAME_MS_DEFAULT,
  VOICE_V28_VAD_MAX_SEGMENTS_DEFAULT,
  VOICE_V28_STYLE_PRESETS,
  VOICE_V28_STYLE_GREETINGS_VI,
  VOICE_V28_STYLE_GREETINGS_EN,
  VOICE_V28_STATE_TRANSITIONS,
  VOICE_V28_MAX_LOG_EVENTS_DEFAULT,
  VOICE_V28_MAX_TRANSCRIPT_TURNS_DEFAULT,
  VOICE_V28_MAX_TOP_PHRASES_DEFAULT,
  VOICE_V28_MAX_COMMAND_LOG_DEFAULT,
  VOICE_V28_MAX_CAST_EVENTS_DEFAULT,
  VOICE_V28_IDLE_TIMEOUT_DEFAULT_MS,
  VOICE_V28_MAX_SESSION_DEFAULT_MS,
  VOICE_V28_BARGE_IN_GRACE_DEFAULT_MS,
  VOICE_V28_BARGE_IN_MIN_SPEECH_DEFAULT_MS,
} from './types';
export type {
  VoiceV28Clock,
  VoiceV28SessionState,
  VoiceV28FloorHolder,
  VoiceV28ChunkSource,
  VoiceV28StopReason,
  VoiceV28TurnEndReason,
  VoiceV28SpeakingStyle,
  VoiceV28CastRole,
  VoiceV28CommandKind,
  VoiceV28CommandExecution,
  VoiceV28TurnSpeaker,
  VoiceV28AudioChunk,
  VoiceV28DropPolicy,
  VoiceV28TransportConfig,
  VoiceV28VadFrame,
  VoiceV28VadHookConfig,
  VoiceV28VadFrameKind,
  VoiceV28VadHookFrameResult,
  VoiceV28SpeechSegment,
  VoiceV28VoiceConfig,
  VoiceV28StylePreset,
  VoiceV28MemoryBlockView,
  VoiceV28BlockSource,
  VoiceV28BlockChange,
  VoiceV28StyleRefreshResult,
  VoiceV28CommandMatch,
  VoiceV28TranscriptTurn,
  VoiceV28SessionSummary,
  VoiceV28CastAssignment,
  VoiceV28CastSwitchEvent,
  VoiceV28SessionLogEvent,
  VoiceV28SessionSnapshot,
} from './types';
export {
  MockRealtimeTransportV28,
  createMockRealtimeTransportV28,
  defaultMockRealtimeTransportV28Options,
  jitterForSeqV28,
  synthToneChunkV28,
  synthSilenceChunkV28,
  chunkEnergyV28,
  validateAudioChunkV28,
} from './transportV28';
export type {
  MockRealtimeTransportV28Options,
  VoiceV28TransportEvent,
  VoiceV28TransportStats,
} from './transportV28';
export {
  VadHookV28,
  createVadHookV28,
  defaultVadHookV28Options,
  validateVadHookConfigV28,
  VOICE_V28_VAD_HOOK_PRESETS,
} from './vadHookV28';
export type {
  VadHookV28Options,
  VadHookV28Callbacks,
  VoiceV28VadHookStats,
  VoiceV28VadHookPresetName,
} from './vadHookV28';
export {
  MemoryVoiceStyleBridgeV28,
  createMemoryVoiceStyleBridgeV28,
  createInMemoryBlockSourceV28,
  detectStyleFromPersonaV28,
  detectLanguageV28,
  parseRateHintV28,
  parsePitchHintV28,
  parseVoiceHintV28,
  detectAddressFormV28,
  detectUserNameV28,
  deriveVoiceConfigV28,
  diffVoiceConfigV28,
  VOICE_V28_ADDRESS_FORMS_VI,
} from './styleV28';
export type {
  MemoryVoiceStyleBridgeV28Options,
  VoiceV28StyleListener,
} from './styleV28';
export {
  VoiceCommandRouterV28,
  createVoiceCommandRouterV28,
  defaultVoiceCommandRouterV28Options,
  normalizeTranscriptV28,
  detectCommandLanguageV28,
} from './commandsV28';
export type {
  VoiceCommandRouterV28Options,
  VoiceV28CommandLogEntry,
} from './commandsV28';
export {
  TranscriptRecorderV28,
  createTranscriptRecorderV28,
  topPhrasesV28,
  keySentencesV28,
  VOICE_V28_STOPWORDS_EN,
  VOICE_V28_STOPWORDS_VI,
} from './transcriptV28';
export type {
  TranscriptRecorderV28Options,
  VoiceV28TranscriptExport,
} from './transcriptV28';
export {
  VoiceCastingV28,
  createVoiceCastingV28,
  defaultVoiceCastingV28Options,
  clampRateV28,
  VOICE_V28_CAST_DEFAULT_VOICES,
  VOICE_V28_CAST_FALLBACK_CHAINS,
  VOICE_V28_CAST_ROLES,
} from './castingV28';
export type {
  VoiceCastingV28Options,
  VoiceV28CastSnapshot,
  VoiceV28CastResolve,
} from './castingV28';
export {
  VoiceSessionRegistryV28,
  createVoiceSessionRegistryV28,
  rollupSessionV28,
} from './reportV28';
export type {
  VoiceV28SessionRollup,
  VoiceV28AggregateReport,
} from './reportV28';
export {
  RealtimeVoiceSessionV28,
  createRealtimeVoiceSessionV28,
} from './sessionV28';
export type {
  RealtimeVoiceSessionV28Options,
  VoiceV28AgentReply,
  VoiceV28BargeInResult,
  VoiceV28SessionStats,
} from './sessionV28';

/** i18n keys owned by voice v28 (all 6 locales, sorted files). */
export const VOICE_V28_I18N_KEYS = [
  'voice.v28.casting.alert',
  'voice.v28.casting.announcer',
  'voice.v28.casting.assigned',
  'voice.v28.casting.assistant',
  'voice.v28.casting.fallbackUsed',
  'voice.v28.casting.narrator',
  'voice.v28.casting.role',
  'voice.v28.casting.switch',
  'voice.v28.casting.title',
  'voice.v28.casting.unassigned',
  'voice.v28.commands.confirmStop',
  'voice.v28.commands.matched',
  'voice.v28.commands.repeatLast',
  'voice.v28.commands.route',
  'voice.v28.commands.speakFaster',
  'voice.v28.commands.speakLouder',
  'voice.v28.commands.speakSlower',
  'voice.v28.commands.speakSofter',
  'voice.v28.commands.switchStyle',
  'voice.v28.commands.switchVoice',
  'voice.v28.commands.title',
  'voice.v28.commands.unknown',
  'voice.v28.commands.unknownVoice',
  'voice.v28.panel.bargeIn',
  'voice.v28.panel.chunks',
  'voice.v28.panel.connecting',
  'voice.v28.panel.dropped',
  'voice.v28.panel.ended',
  'voice.v28.panel.floor',
  'voice.v28.panel.greeting',
  'voice.v28.panel.idle',
  'voice.v28.panel.latency',
  'voice.v28.panel.listening',
  'voice.v28.panel.paused',
  'voice.v28.panel.speaking',
  'voice.v28.panel.state',
  'voice.v28.panel.style',
  'voice.v28.panel.thinking',
  'voice.v28.panel.title',
  'voice.v28.panel.turns',
  'voice.v28.panel.voice',
  'voice.v28.session.closed',
  'voice.v28.session.connected',
  'voice.v28.session.ended',
  'voice.v28.session.invalidTransition',
  'voice.v28.session.log',
  'voice.v28.session.open',
  'voice.v28.session.paused',
  'voice.v28.session.resumed',
  'voice.v28.session.started',
  'voice.v28.session.stopped',
  'voice.v28.session.title',
  'voice.v28.style.addressForm',
  'voice.v28.style.applyPreset',
  'voice.v28.style.concise',
  'voice.v28.style.default',
  'voice.v28.style.fallback',
  'voice.v28.style.formal',
  'voice.v28.style.fromMemory',
  'voice.v28.style.greeting',
  'voice.v28.style.intimate',
  'voice.v28.style.language',
  'voice.v28.style.pitch',
  'voice.v28.style.rate',
  'voice.v28.style.refreshed',
  'voice.v28.style.storyteller',
  'voice.v28.style.title',
  'voice.v28.transcript.export',
  'voice.v28.transcript.interrupted',
  'voice.v28.transcript.keySentences',
  'voice.v28.transcript.summary',
  'voice.v28.transcript.title',
  'voice.v28.transcript.topPhrases',
  'voice.v28.transcript.turns',
  'voice.v28.transport.backpressure',
  'voice.v28.transport.closed',
  'voice.v28.transport.dropped',
  'voice.v28.transport.flushed',
  'voice.v28.transport.jitter',
  'voice.v28.transport.latency',
  'voice.v28.transport.title',
  'voice.v28.transport.underrun',
  'voice.v28.vad.calibrated',
  'voice.v28.vad.hangover',
  'voice.v28.vad.noiseFloor',
  'voice.v28.vad.silenceTimeout',
  'voice.v28.vad.speechEnd',
  'voice.v28.vad.speechStart',
  'voice.v28.vad.threshold',
  'voice.v28.vad.title',
] as const;
