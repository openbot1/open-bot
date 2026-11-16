/**
 * @open-bot/core/voice — realtime voice calls + voice memos + dictation.
 * Public surface for the voice module (imported by the desktop main
 * process; NOT re-exported from the package root index).
 */
export {
  LongVoiceSession,
  extractiveSummary,
  LONG_SESSION_DEFAULT_BUDGET_CHARS,
  LONG_SESSION_DEFAULT_KEEP_TURNS,
  LONG_SESSION_SUMMARY_MAX_LINES,
  LONG_SESSION_SUMMARY_MAX_LINE_CHARS,
} from './longSession';
export type {
  VoiceTurn,
  VoiceSessionSummary,
  LongVoiceSessionEvent,
  LongVoiceSessionEventSink,
  VoiceSummarizer,
  LongVoiceSessionStats,
  LongVoiceSessionOptions,
} from './longSession';
export {
  BargeInController,
  BARGE_IN_V2_DEFAULT_GRACE_MS,
  BARGE_IN_V2_DEFAULT_MIN_SPEECH_MS,
  BARGE_IN_V2_MAX_PARTIAL_CHARS,
} from './bargeInV2';
export type {
  BargeInResumePolicy,
  BargeInV2Reason,
  BargeInV2Decision,
  PartialModelTurn,
  BargeInV2Options,
} from './bargeInV2';
export {
  VoiceMediaContext,
  MockMediaDescriber,
  VisionApiDescriber,
  mediaBytes,
  VOICE_MEDIA_VIDEO_MIME_TYPES,
  VOICE_MEDIA_MAX_ITEMS,
  VOICE_MEDIA_MAX_TOTAL_BYTES,
  VOICE_MEDIA_MAX_VIDEO_BYTES,
  VOICE_MEDIA_DESCRIBE_TIMEOUT_MS,
} from './mediaContext';
export type {
  VoiceMediaKind,
  VoiceMediaItem,
  VoiceMediaInput,
  MediaDescription,
  MediaDescriber,
  AttachMediaResult,
  MediaAnswer,
  RestorableMediaItem,
  VoiceMediaContextOptions,
} from './mediaContext';
export {
  LocalVoiceStack,
  createMockLocalVoiceStack,
} from './localVoiceStack';
export type {
  LocalVoiceStackMode,
  LocalVoiceStackStatus,
  LocalVoiceStackOptions,
} from './localVoiceStack';
export { VoiceSessionV2 } from './voiceSessionV2';
export type {
  VoiceSessionV2Event,
  VoiceSessionV2EventSink,
  VoiceSessionV2Options,
} from './voiceSessionV2';
export { VoiceSessionV3 } from './voiceSessionV3';
export type {
  VoiceSessionV3Event,
  VoiceSessionV3EventSink,
  VoiceSessionV3Options,
  VoiceSessionV3Stats,
} from './voiceSessionV3';
export {
  SessionCheckpointer,
  MemoryCheckpointStore,
  FileCheckpointStore,
  checkpointMediaItem,
  isVoiceSessionCheckpoint,
  defaultVoiceCheckpointsDir,
  VOICE_CHECKPOINT_VERSION,
  VOICE_CHECKPOINT_EVERY_TURNS,
  VOICE_CHECKPOINT_EVERY_MS,
  VOICE_CHECKPOINT_MAX_HISTORY,
  VOICE_CHECKPOINT_DEFAULT_MAX_AGE_MS,
  VOICE_CHECKPOINT_DEFAULT_MAX_FILES,
} from './sessionCheckpoint';
export type {
  VoiceCheckpointReason,
  CheckpointMediaItem,
  VoiceSessionCheckpoint,
  CheckpointStore,
  CheckpointSources,
  FileCheckpointStoreOptions,
  SessionCheckpointerOptions,
  SessionCheckpointerStats,
} from './sessionCheckpoint';
export {
  ReconnectController,
  ResilientDialer,
  buildResumeInstructions,
  RESILIENCE_DEFAULT_MAX_ATTEMPTS,
  RESILIENCE_DEFAULT_BASE_DELAY_MS,
  RESILIENCE_DEFAULT_MAX_DELAY_MS,
  RESILIENCE_GOAWAY_SOON_SEC,
  RESILIENCE_GOAWAY_SOON_DELAY_MS,
  RESILIENCE_GOAWAY_LATER_DELAY_MS,
} from './sessionResilience';
export type {
  ReconnectState,
  ReconnectEvent,
  ReconnectEventSink,
  ReconnectStats,
  ReconnectControllerOptions,
  ResilientDialerOptions,
  ResilientDialResult,
} from './sessionResilience';
export {
  MediaConversation,
  MockAudioTranscriber,
  LocalSttAudioTranscriber,
  createMockAudioTranscriber,
  audioMediaBytes,
  stripWavHeader,
  base64ToBytes,
  VOICE_AUDIO_MIME_TYPES,
  VOICE_AUDIO_MAX_BYTES,
  VOICE_VIDEO_MAX_FRAMES,
  MEDIA_CONVERSATION_DEFAULT_BUDGET_CHARS,
  MEDIA_CONVERSATION_MAX_ANSWERS_PER_ITEM,
} from './mediaConversation';
export type {
  VoiceAudioMediaItem,
  VoiceAudioMediaInput,
  VoiceVideoFrame,
  AudioTranscriber,
  AttachAudioResult,
  MediaReference,
  MediaReferenceMatch,
  MediaConversationOptions,
  MediaConversationSnapshot,
} from './mediaConversation';
export {
  LocalVoiceEngineRegistry,
  VoskSttEngine,
  PiperTtsEngine,
  CommandSttEngine,
  CommandTtsEngine,
  FallbackSttEngine,
  FallbackTtsEngine,
  createDefaultLocalVoiceRegistry,
  detectLocalVoiceEngines,
  findBinaryOnPath,
  probeBinaryEngine,
  defaultCommandRunner,
  LOCAL_VOICE_ENGINE_TIMEOUT_MS,
  LOCAL_VOICE_TTS_TIMEOUT_MS,
  PIPER_PLAYER_CANDIDATES,
  SYSTEM_TTS_ENGINE_IDS,
} from './localVoiceEngines';
export type {
  VoiceEngineKind,
  VoiceEngineProbe,
  VoiceEngineDescriptor,
  FallbackAttempt,
  CommandRunResult,
  CommandRunner,
  VoskSttEngineOptions,
  PiperTtsEngineOptions,
  CommandSttEngineOptions,
  CommandTtsEngineOptions,
  LocalVoiceEnginesReport,
} from './localVoiceEngines';
export {
  BargeInV3Controller,
  isBackchannelTranscript,
  buildResumePrompt,
  BACKCHANNEL_WORDS,
  BARGE_IN_V3_DEFAULT_CONFIRM_MS,
  BARGE_IN_V3_DEFAULT_BACKCHANNEL_MAX_MS,
  BARGE_IN_V3_GRACE_STEP_MS,
  BARGE_IN_V3_GRACE_MIN_MS,
  BARGE_IN_V3_REPEAT_WINDOW_MS,
  BARGE_IN_V3_REPEATS_PER_STEP,
} from './bargeInV3';
export type {
  BargeInV3Action,
  BargeInV3Reason,
  BargeInV3Decision,
  BargeInV3Stats,
  BargeInV3Options,
} from './bargeInV3';
export {
  RealtimeClient,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_DIAL_TIMEOUT_MS,
  DEFAULT_MAX_REDIAL_DELAY_MS,
  DEFAULT_MAX_SILENT_PATH_REDIALS,
} from './realtime';
export {
  RealtimeSession,
  REALTIME_SESSION_DEFAULT_MAX_RECONNECTS,
  REALTIME_SESSION_DEFAULT_RECONNECT_DELAY_MS,
  REALTIME_SESSION_DEFAULT_RECONNECT_MAX_DELAY_MS,
  REALTIME_PROVIDER_INPUT_RATES,
} from './realtimeSession';
export type {
  RealtimeSessionOptions,
  RealtimeTransportFactory,
} from './realtimeSession';
export {
  OpenAiRealtimeTransport,
  GeminiLiveTransport,
  createRealtimeTransport,
  buildOpenAiRealtimeUrl,
  buildGeminiLiveUrl,
  OPENAI_REALTIME_WS_URL,
  OPENAI_REALTIME_DEFAULT_MODEL,
  OPENAI_REALTIME_DEFAULT_VOICE,
  GEMINI_LIVE_WS_URL,
  GEMINI_LIVE_DEFAULT_MODEL,
  GEMINI_LIVE_DEFAULT_VOICE,
} from './adapters';
export type {
  RealtimeTransport,
  RealtimeTransportCallbacks,
  RealtimeTransportConfig,
} from './adapters';
export {
  LocalVad,
  Pcm16Chunker,
  MockAudioSource,
  MockAudioSink,
  isValidPcm16Frame,
  pcm16Rms,
  pcm16Sample,
  resamplePcm16,
  sinePcm16Frame,
  silencePcm16Frame,
  LOCAL_VAD_DEFAULT_THRESHOLD,
  LOCAL_VAD_DEFAULT_HANGOVER_MS,
  LOCAL_VAD_WINDOW_MS,
  PCM16_BYTES_PER_SAMPLE,
} from './audio';
export type { AudioSource, AudioSink, LocalVadCallbacks } from './audio';
export {
  WhisperCliSttEngine,
  MockLocalSttEngine,
  detectLocalStt,
  parseWhisperTimestamp,
  defaultWhisperThreads,
  WHISPER_BINARY_CANDIDATES,
  WHISPER_MODEL_CANDIDATES,
  LOCAL_STT_MAX_BYTES,
  LOCAL_STT_TIMEOUT_MS,
} from './localStt';
export type {
  LocalSttEngine,
  LocalSttStatus,
  LocalSttTranscribeOptions,
  WhisperRunner,
  WhisperSegment,
  WhisperDetailedResult,
} from './localStt';
export {
  ChunkedWhisperStt,
  ChunkedEngineAdapter,
  StreamingSttSession,
  splitAudioOnSilence,
  dedupeChunkOverlap,
  runWerBenchmark,
  WHISPER_CHUNK_MS,
  WHISPER_CHUNK_OVERLAP_MS,
  WHISPER_OVERLAP_MAX_WORDS,
} from './whisperStream';
export type {
  AudioSegment,
  SilenceSplitOptions,
  WhisperChunkResult,
  ChunkedWhisperResult,
  ChunkedWhisperOptions,
  WerBenchmarkCase,
  WerBenchmarkCaseResult,
  WerBenchmarkResult,
  StreamingSttResult,
  StreamingSttCallbacks,
  StreamingSttOptions,
  StreamingSttEvalReport,
} from './whisperStream';
export {
  TurnTakingMeter,
  summarizeBargeInMeasurements,
  emptyTurnTakingStats,
  defaultTurnTakingClock,
  runMockBargeInProbe,
  BARGE_IN_TOTAL_BUDGET_MS,
} from './turnTaking';
export type {
  BargeInMeasurement,
  BargeInSource,
  TurnTakingStats,
  TurnTakingClock,
  BargeInProbeSession,
  BargeInProbeOptions,
  BargeInProbeResult,
} from './turnTaking';
export {
  RealtimeKeyGate,
  decideRealtimeMode,
  resolveRealtimeKeyWithSource,
  assertLive,
  providerName,
  realtimeSettingsHint,
  isGeminiLiveModel,
  isOpenAiRealtimeModel,
  validateRealtimeModel,
  REALTIME_KEY_ENV_VARS,
  GEMINI_LIVE_MODEL_PATTERN,
  OPENAI_REALTIME_MODEL_PATTERN,
} from './keyGate';
export type {
  RealtimeKeySource,
  RealtimeMode,
  KeyGateDecision,
  KeyGateInput,
  RealtimeModelValidation,
  RealtimeKeyResolverMap,
} from './keyGate';
export {
  probeHttpsEndpoint,
  probeRealtimeEndpoints,
  parseGeminiListModels,
  probeGeminiConnectorModels,
  probeGeminiLiveReadiness,
  probeLocalProxy,
  LIVE_PROBE_TIMEOUT_MS,
  GEMINI_CONNECTOR_HELPER_RELATIVE,
  GEMINI_LOCAL_PROXY_PORT,
  GEMINI_ENDPOINT_PROBE_URL,
  OPENAI_ENDPOINT_PROBE_URL,
} from './liveProbe';
export type {
  EndpointProbeResult,
  FetchLike,
  GeminiConnectorModel,
  GeminiConnectorProbeResult,
  ConnectorRunner,
  GeminiLiveReadiness,
  LocalProxyProbeResult,
} from './liveProbe';
export {
  chooseRealtimeTransport,
  decideAndChooseRealtimeTransport,
  isMockFallbackChoice,
} from './realtimeFallback';
export type {
  RealtimeFallbackChoice,
  RealtimeFallbackOptions,
} from './realtimeFallback';
export {
  collectVoiceDiagnostics,
  voiceDiagnosticsVerdict,
} from './voiceDiagnostics';
export type {
  VoiceSubsystemReadiness,
  VoiceRealtimeDiagnostics,
  VoiceSttDiagnostics,
  VoiceDiagnosticsReport,
  VoiceDiagnosticsInput,
} from './voiceDiagnostics';
export {
  runVoiceLiveVerification,
  summarizeVoiceLiveVerification,
} from './liveVerify';
export type {
  VerificationSectionStatus,
  VerificationSection,
  VoiceLiveVerificationReport,
  VoiceLiveVerificationOptions,
} from './liveVerify';
export {
  listLocalWhisperModels,
  whisperModelSearchRoots,
  parseWhisperModelFileName,
  recommendWhisperModel,
  whisperModelDownloadCommand,
  expectedWhisperModelSizeMb,
  isCompleteWhisperModel,
  availableCpuCount,
  WHISPER_MODEL_SIZES_MB,
  WHISPER_MODEL_DOWNLOAD_BASE_URL,
} from './whisperModels';
export type { LocalWhisperModel } from './whisperModels';
export {
  LocalSttPipeline,
  wordErrorRate,
  normalizeTranscriptForWer,
  STT_PIPELINE_DEFAULT_MIN_SEGMENT_MS,
  STT_PIPELINE_DEFAULT_MAX_SEGMENT_MS,
  STT_PIPELINE_DEFAULT_SAMPLE_RATE_HZ,
} from './sttPipeline';
export type {
  SttSegmentResult,
  SttPipelineCallbacks,
  SttPipelineOptions,
  WordErrorRate,
} from './sttPipeline';
export {
  TtsQueue,
  splitIntoSentences,
  TTS_ABBREVIATIONS,
  TTS_BARGE_IN_BUDGET_MS,
} from './ttsQueue';
export type {
  QueuedSentence,
  TtsQueueStopResult,
  TtsQueueCallbacks,
  TtsQueueOptions,
} from './ttsQueue';
export {
  VoiceSessionStore,
  createVoiceSessionRecord,
  newVoiceSessionId,
  sanitizeVoiceSessionId,
  isVoiceSessionRecord,
  buildVoiceTranscriptEntry,
  defaultVoiceSessionsDir,
  VOICE_PERSIST_DEFAULT_MAX_TRANSCRIPT,
  VOICE_PERSIST_DEFAULT_MAX_AGE_MS,
  VOICE_PERSIST_DEFAULT_MAX_SESSIONS,
} from './voicePersistence';
export type {
  VoiceTranscriptEntry,
  PersistedVoiceProvider,
  VoiceSessionRecord,
  VoiceSessionStoreOptions,
} from './voicePersistence';
export {
  LatencyStats,
  Backoff,
  MissingRealtimeKeyError,
  isMissingRealtimeKeyError,
  realtimeKeyMissingMessage,
  deriveTransportHealth,
  REALTIME_KEY_SETTINGS_HINT,
  TRANSPORT_SLOW_CONNECT_MS,
  TRANSPORT_SLOW_FIRST_AUDIO_MS,
} from './transportHealth';
export type {
  LatencySample,
  LatencySummary,
  BackoffOptions,
  TransportHealthStatus,
  TransportHealth,
} from './transportHealth';
export {
  resolveRealtimeApiKey,
  hasRealtimeKeyFor,
} from './adapters';
export {
  MockRealtimeTransport,
  isMockRealtimeTransport,
  MOCK_REALTIME_DEFAULT_REPLY,
} from './mockTransport';
export type {
  MockRealtimeReply,
  MockRealtimeTransportOptions,
} from './mockTransport';
export { transcribeAudio, DEFAULT_TRANSCRIPTION_MODEL, DEFAULT_TRANSCRIPTION_TIMEOUT_MS } from './memo';
export {
  DictationSession,
  transcribeDictation,
  pcm16ToWav,
  DICTATION_SAMPLE_RATE_HZ,
  DICTATION_MAX_BYTES,
} from './dictation';
export {
  VoiceCallHarness,
} from './harness';
export type { VoiceCallHarnessOptions } from './harness';
export {
  MockTtsEngine,
  SystemTtsEngine,
  TtsHarness,
  stripMarkdownForSpeech,
  parseEspeakVoices,
  rateToWpm,
  rateToSpdSay,
  TTS_MAX_CHARS,
  TTS_SPEAK_TIMEOUT_MS,
} from './tts';
export type { TtsEngine, TtsEngineStatus, TtsSpeakOptions, TtsSpeakResult, TtsStopResult, TtsVoice } from './tts';
export {
  VoiceCallSession,
  truncateToolOutput,
} from './session';
export type {
  VoiceCallSessionOptions,
  VoiceRealtimeClient,
  VoiceRealtimeClientFactory,
  VoiceSessionEvent,
  VoiceSurfaceRegistration,
  VoiceSurfaceView,
} from './session';
export {
  createVoiceCallToolSet,
  getVoiceCallToolDefinition,
  isVoiceCallToolName,
  validateVoiceCallArgs,
  VOICE_CALL_TOOL_NAMES,
} from './callTools';
export type {
  VoiceCallToolHandlers,
  VoiceCallToolSet,
  VoiceCallValidationResult,
} from './callTools';
export {
  extractFileChanges,
  buildPeekChangesResult,
  PEEK_CHANGES_LIMIT,
} from './fileChanges';
export type {
  FileChangeEntry,
  FileChangeKind,
  FileChangeSourceRecord,
  PeekChangesResult,
} from './fileChanges';
export {
  VOICE_REDIAL_MAX_ATTEMPTS,
  VOICE_REDIAL_DIAL_TIMEOUT_MS,
  VOICE_REDIAL_INITIAL_DELAY_MS,
  VOICE_REDIAL_MAX_DELAY_MS,
  VOICE_REDIAL_MAX_SILENT_PATH_REDIALS,
  VOICE_CALL_POLICY_CLOSE_CODE,
  VOICE_CALL_SUPERSEDED_CLOSE_CODE,
  VOICE_SURFACES,
  VOICE_SURFACE_GUIDANCE,
  VOICE_SURFACE_MAX_REPLY_CHARS,
  VOICE_CALL_TOOL_DEFINITIONS,
  VOICE_CALL_REQUEST_CHAR_LIMIT,
  VOICE_CALL_SEARCH_HIT_LIMIT,
  VOICE_CALL_CHIME_NOTES,
  REALTIME_PROVIDERS,
  TURN_TAKING_MODES,
  REALTIME_MIC_SAMPLE_RATE_HZ,
  OPENAI_REALTIME_INPUT_SAMPLE_RATE_HZ,
  GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
  REALTIME_OUTPUT_SAMPLE_RATE_HZ,
  REALTIME_FRAME_MS,
  REALTIME_FRAME_BYTES_16K,
  REALTIME_FRAME_BYTES_24K,
  isVoiceSurface,
  isRealtimeProvider,
  isTurnTakingMode,
} from './types';
export type {
  AudioEvent,
  DictationOptions,
  RealtimeCallbacks,
  RealtimeConfig,
  RealtimeProvider,
  RealtimeSessionEvent,
  RealtimeSessionEventSink,
  RealtimeSessionState,
  RealtimeState,
  RealtimeToolCall,
  TranscriptionOptions,
  TranscriptEvent,
  TurnTakingMode,
  VoiceCallHarnessOutcome,
  VoiceCallHarnessOutcomeKind,
  VoiceCallToolDefinition,
  VoiceCallToolName,
  VoiceSurface,
  WebSocketFactory,
  WebSocketLike,
} from './types';
export {
  validateVoiceProfile,
  getBuiltinProfile,
  resolveProfileTtsOptions,
  resolveProfileSttLanguage,
  pickProfileForLang,
  MemoryVoiceProfileStore,
  FileVoiceProfileStore,
  defaultVoiceProfilesPath,
  DEFAULT_VOICE_PROFILES,
  VOICE_PROFILE_MIN_RATE,
  VOICE_PROFILE_MAX_RATE,
  VOICE_PROFILE_MIN_VOLUME,
  VOICE_PROFILE_MAX_VOLUME,
  VOICE_PROFILE_MIN_PITCH,
  VOICE_PROFILE_MAX_PITCH,
  VOICE_PROFILE_ID_RE,
  VOICE_PROFILE_LANG_RE,
  VOICE_PROFILE_MAX_PER_USER,
} from './voiceProfiles';
export type {
  VoiceProfile,
  VoiceProfileValidationResult,
  VoiceProfileStoreStats,
  FileVoiceProfileStoreOptions,
} from './voiceProfiles';
export {
  LiveTranscriptionStream,
  normalizeTranscriptText,
  countTranscriptWords,
  mergeInterimText,
  LIVE_TRANSCRIPTION_DEFAULT_TURN_GAP_MS,
  LIVE_TRANSCRIPTION_DEFAULT_MAX_TURN_CHARS,
  LIVE_TRANSCRIPTION_DEFAULT_MAX_SEGMENTS_PER_TURN,
} from './liveTranscription';
export type {
  LiveTranscriptInput,
  LiveTranscriptTurn,
  LiveTranscriptionEvent,
  LiveTranscriptionEventSink,
  LiveTranscriptionStats,
  LiveTranscriptionOptions,
} from './liveTranscription';
export {
  VoiceToolCommander,
  parseVoiceCommand,
  isBlockedVoiceIntent,
  describeVoiceCommand,
  buildConfirmationPrompt,
  parseConfirmationAnswer,
  classifyVoiceToolRisk,
  isVoiceCallableTool,
  getVoiceCallableTool,
  VOICE_TOOL_RISK,
  VOICE_BLOCKED_INTENT_RES,
  VOICE_COMMAND_PATTERNS,
  CONFIRM_YES_WORDS,
  CONFIRM_NO_WORDS,
  CONFIRM_HESITATION_PHRASES,
  VOICE_COMMANDER_DEFAULT_CONFIRM_TIMEOUT_MS,
  VOICE_COMMANDER_MAX_AUDIT_ENTRIES,
} from './voiceToolCommander';
export type {
  VoiceToolRisk,
  VoiceToolCommand,
  VoiceCommandOutcome,
  VoiceConfirmationOutcome,
  VoiceToolExecutionResult,
  VoiceToolExecutor,
  VoiceToolAuditEntry,
  VoiceToolCommanderOptions,
  VoiceToolCommanderStats,
} from './voiceToolCommander';
export {
  FullDuplexVoiceLoop,
  FULL_DUPLEX_DEFAULT_VAD_THRESHOLD,
  FULL_DUPLEX_DEFAULT_VAD_HANGOVER_MS,
  FULL_DUPLEX_DEFAULT_SAMPLE_RATE_HZ,
  FULL_DUPLEX_DEFAULT_BARGE_IN_ENERGY_THRESHOLD,
  FULL_DUPLEX_DEFAULT_MAX_USER_SPEECH_MS,
  FULL_DUPLEX_TOOL_SUMMARY_MAX_CHARS,
} from './fullDuplexLoop';
export type {
  VoiceLoopState,
  FullDuplexVoiceLoopEvent,
  FullDuplexVoiceLoopEventSink,
  FullDuplexVoiceLoopStats,
  FullDuplexVoiceLoopOptions,
} from './fullDuplexLoop';
export {
  VoiceLatencyPipeline,
  AdaptiveJitterBuffer,
  isVoiceLatencyMode,
  voiceLatencyReportMarkdown,
  VOICE_LATENCY_STAGES,
  VOICE_LATENCY_MODES,
  LATENCY_HISTOGRAM_EDGES_MS,
  LatencyHistogram,
} from './latencyPipeline';
export type {
  VoiceLatencyStage,
  VoiceLatencyMode,
  VoiceLatencyModeConfig,
  LatencyHistogramSummary,
  VoiceLatencyStageReport,
  VoiceLatencyReport,
  VoiceLatencyPipelineOptions,
  AdaptiveJitterBufferOptions,
} from './latencyPipeline';
export {
  BargeInV4Controller,
  buildResumeUtterance,
  BARGE_IN_V4_DEFAULT_ENERGY_THRESHOLD,
  BARGE_IN_V4_DEFAULT_DEBOUNCE_FRAMES,
  BARGE_IN_V4_DEFAULT_DEBOUNCE_WINDOW_MS,
  BARGE_IN_V4_STOP_BUDGET_MS,
  BARGE_IN_V4_MAX_PARTIAL_CHARS,
} from './bargeInV4';
export type {
  BargeInV4State,
  BargeInV4IgnoreReason,
  BargeInV4Action,
  BargeInV4Decision,
  BargeInV4InterruptResult,
  BargeInV4PartialUtterance,
  BargeInV4Stats,
  BargeInV4Options,
} from './bargeInV4';
export {
  VoiceSessionV4,
  createMockVoiceSessionV4,
  VOICE_V4_MOCK_REPLY_DELAY_MS,
} from './voiceSessionV4';
export type {
  VoiceV4TurnHistoryEntry,
  VoiceSessionV4Event,
  VoiceSessionV4EventSink,
  VoiceSessionV4Stats,
  VoiceSessionV4Options,
} from './voiceSessionV4';
export {
  VoiceSessionManagerV2,
  MemoryVoiceSessionLogStore,
  FileVoiceSessionLogStore,
  defaultVoiceSessionLogDir,
  VOICE_MANAGER_DEFAULT_MAX_CONCURRENT,
  VOICE_MANAGER_DEFAULT_MAX_RECONNECTS,
} from './voiceSessionManagerV2';
export type {
  ManagedVoiceSessionStatus,
  VoiceSessionLogKind,
  VoiceSessionLogEntry,
  VoiceSessionLogStore,
  ManagedVoiceSession,
  VoiceSessionManagerV2Options,
  VoiceSessionManagerEvent,
  ManagedVoiceSessionRecord,
  VoiceSessionManagerStats,
} from './voiceSessionManagerV2';
export {
  runVoiceEval,
  scoreBargeInLatency,
  voiceEvalReportMarkdown,
  VOICE_EVAL_FIXTURE_CASES,
  VOICE_EVAL_DEFAULT_WER_THRESHOLD,
  VOICE_EVAL_DEFAULT_STOP_BUDGET_MS,
} from './voiceEval';
export type {
  VoiceEvalCase,
  VoiceEvalCaseResult,
  VoiceEvalBargeInReport,
  VoiceEvalReport,
  VoiceEvalOptions,
} from './voiceEval';
// --- v1.06 (Đội T4): voice realtime v5 — multi-model router,
// adaptive VAD, speaker diarization, session v5 + manager.
export {
  VoiceRouterV5,
  VoiceModelHealth,
  routeVoiceRequest,
  scoreVoiceModel,
  languageFit,
  baseLanguage,
  findVoiceModel,
  isVoiceLatencyClass,
  validateVoiceBotRouterConfig,
  estimateVoiceCost,
  voiceRouteReportMarkdown,
  VOICE_V5_MODEL_CATALOG,
  VOICE_V5_LATENCY_CLASSES,
  VOICE_V5_HEALTH_BASE_COOLDOWN_MS,
  VOICE_V5_HEALTH_MAX_COOLDOWN_MS,
} from './voiceRouterV5';
export type {
  VoiceModelLane,
  VoiceLatencyClass,
  VoiceModelDescriptor,
  VoiceModelAvailability,
  VoiceRouteRequest,
  VoiceLaneRoute,
  VoiceRoute,
  VoiceBotRouterConfig,
  VoiceBotRouterConfigValidation,
  VoiceFallbackAttempt,
  VoiceRouterV5Options,
} from './voiceRouterV5';
export {
  AdaptiveVad,
  validateVadV5Options,
  defaultVadV5Options,
  VAD_V5_DEFAULT_THRESHOLD,
  VAD_V5_DEFAULT_HANGOVER_MS,
  VAD_V5_DEFAULT_WINDOW_MS,
  VAD_V5_DEFAULT_NOISE_LEARN_MS,
  VAD_V5_DEFAULT_THRESHOLD_MULTIPLIER,
  VAD_V5_DEFAULT_MIN_TURN_MS,
  VAD_V5_DEFAULT_BACKCHANNEL_MAX_MS,
  VAD_V5_DEFAULT_MAX_GAP_MS,
  VAD_V5_MAX_THRESHOLD,
  VAD_V5_MIN_THRESHOLD,
} from './vadV5';
export type {
  VadV5State,
  VadV5Event,
  VadV5EventSink,
  VadV5Stats,
  AdaptiveVadOptions,
} from './vadV5';
export {
  DiarizationSession,
  FileSpeakerProfileStore,
  extractVoiceEmbedding,
  embeddingDistance,
  diarizedTranscriptMarkdown,
  DIARIZATION_BAND_FREQUENCIES_HZ,
  DIARIZATION_EMBEDDING_SIZE,
  DIARIZATION_DEFAULT_MATCH_THRESHOLD,
  DIARIZATION_DEFAULT_MAX_SPEAKERS,
  DIARIZATION_DEFAULT_UPDATE_RATE,
  DIARIZATION_SPEAKER_PREFIX,
} from './diarization';
export type {
  SpeakerProfile,
  DiarizedTurn,
  SpeakerIdentification,
  DiarizationOptions,
} from './diarization';
export {
  VoiceSessionV5,
  VoiceV5Manager,
  FileVoiceSessionV5Store,
  validateVoiceV5VadPatch,
  VOICE_V5_DEFAULT_MAX_SEGMENT_MS,
  VOICE_V5_SESSION_ID_RE,
} from './voiceSessionV5';
export type {
  VoiceSessionV5Event,
  VoiceSessionV5EventSink,
  VoiceSessionV5Options,
  VoiceSessionV5Stats,
  VoiceSessionV5Snapshot,
  VoiceSessionV5SnapshotInfo,
  VoiceV5CreateSessionOptions,
  VoiceV5ManagerStats,
} from './voiceSessionV5';
// v1.07 (Team T5 — voice v4 + UI): explicit call state machine,
// mid-call voice switching, network-error guard, v6 session.
export {
  VoiceStateMachine,
  VOICE_CALL_STATES,
  VOICE_CALL_TRANSITIONS,
  isVoiceCallLive,
  isVoiceCallUserTurn,
  isVoiceCallModelSpeaking,
  voiceStateSummary,
} from './voiceStateMachine';
export type {
  VoiceCallState,
  VoiceStateTransition,
  VoiceStateMachineEvent,
  VoiceStateMachineEventSink,
  VoiceStateTransitionResult,
  VoiceStateMachineOptions,
  VoiceStateMachineStats,
} from './voiceStateMachine';
export {
  VoiceSwitchManager,
  voiceSwitchSummary,
  voiceSwitchHistoryMarkdown,
} from './voiceSwitch';
export type {
  VoiceSwitchApplyMode,
  VoiceSwitchRecord,
  VoiceSwitchResult,
  VoiceSwitchEvent,
  VoiceSwitchEventSink,
  VoiceSwitchManagerOptions,
  VoiceSwitchStats,
} from './voiceSwitch';
export {
  VoiceNetworkGuard,
  classifyVoiceNetworkError,
  voiceNetworkSummary,
  VOICE_NETWORK_DEFAULT_BASE_DELAY_MS,
  VOICE_NETWORK_DEFAULT_MAX_DELAY_MS,
  VOICE_NETWORK_DEFAULT_MAX_ATTEMPTS,
  VOICE_NETWORK_DEFAULT_DEGRADE_AFTER,
} from './voiceNetworkGuard';
export type {
  VoiceNetworkErrorKind,
  VoiceNetworkAction,
  VoiceNetworkErrorInfo,
  VoiceNetworkDecision,
  VoiceNetworkGuardEvent,
  VoiceNetworkGuardEventSink,
  VoiceNetworkGuardOptions,
  VoiceNetworkGuardStats,
} from './voiceNetworkGuard';
export {
  VoiceSessionV6,
  VoiceV6Manager,
  createMockVoiceSessionV6,
  VOICE_V6_SESSION_ID_RE,
  VOICE_V6_MOCK_REPLY_DELAY_MS,
} from './voiceSessionV6';
export type {
  VoiceSessionV6Event,
  VoiceSessionV6EventSink,
  VoiceSessionV6Stats,
  VoiceSessionV6Options,
} from './voiceSessionV6';
// v1.07 (Team T5): v6 snapshots + voice→budget link.
export {
  FileVoiceSessionV6Store,
  snapshotVoiceSessionV6,
  validateVoiceSessionV6Snapshot,
  restoreVoiceSessionV6,
  voiceSessionV6SnapshotSummary,
  voiceSessionV6SnapshotMarkdown,
  VOICE_V6_SNAPSHOT_DEFAULT_MAX_AGE_MS,
} from './voiceSessionV6Store';
export type {
  VoiceSessionV6Snapshot,
  VoiceSessionV6SnapshotInfo,
} from './voiceSessionV6Store';
// v1.08 (Đội T5 — voice v7 + UI): VAD v7 (energy + ZCR, presets,
// confidence, false positives), barge-in v7 (duck / interrupt,
// grace + echo windows, cooldown, word-level partials),
// streaming transcript v7 (word-by-word, speakers, phase),
// v7 session + snapshots.
export {
  AdaptiveVadV7,
  pcm16ZeroCrossingRate,
  defaultVadV7Options,
  validateVadV7Options,
  isVadV7PresetName,
  VAD_V7_PRESETS,
  VAD_V7_PRESET_NAMES,
  VAD_V7_DEFAULT_THRESHOLD,
  VAD_V7_DEFAULT_HANGOVER_MS,
  VAD_V7_DEFAULT_WINDOW_MS,
  VAD_V7_DEFAULT_NOISE_LEARN_MS,
  VAD_V7_DEFAULT_THRESHOLD_MULTIPLIER,
  VAD_V7_DEFAULT_MIN_TURN_MS,
  VAD_V7_DEFAULT_BACKCHANNEL_MAX_MS,
  VAD_V7_DEFAULT_MAX_GAP_MS,
  VAD_V7_DEFAULT_DEBOUNCE_FRAMES,
  VAD_V7_DEFAULT_MIN_CONFIDENCE,
  VAD_V7_DEFAULT_MIN_ZCR,
  VAD_V7_DEFAULT_MAX_ZCR,
  VAD_V7_MAX_THRESHOLD,
  VAD_V7_MIN_THRESHOLD,
  VAD_V7_CALIBRATION_ALPHA,
  VAD_V7_DEFAULT_CALIBRATION_MS,
} from './vadV7';
export type {
  VadV7PresetName,
  VadV7State,
  VadV7FalsePositiveReason,
  VadV7Event,
  VadV7EventSink,
  VadV7Stats,
  VadV7Config,
  AdaptiveVadV7Options,
} from './vadV7';
export {
  BargeInV7Controller,
  buildResumeUtteranceV7,
  splitWords,
  validateBargeInV7Options,
  BARGE_IN_V7_DEFAULT_ENERGY_THRESHOLD,
  BARGE_IN_V7_DEFAULT_DUCK_THRESHOLD,
  BARGE_IN_V7_DEFAULT_DEBOUNCE_FRAMES,
  BARGE_IN_V7_DEFAULT_DEBOUNCE_WINDOW_MS,
  BARGE_IN_V7_STOP_BUDGET_MS,
  BARGE_IN_V7_DEFAULT_GRACE_MS,
  BARGE_IN_V7_DEFAULT_ECHO_WINDOW_MS,
  BARGE_IN_V7_DEFAULT_ECHO_MULTIPLIER,
  BARGE_IN_V7_DEFAULT_DUCK_MS,
  BARGE_IN_V7_DEFAULT_COOLDOWN_MS,
  BARGE_IN_V7_DEFAULT_MIN_CONFIDENCE,
  BARGE_IN_V7_MAX_PARTIAL_CHARS,
  BARGE_IN_V7_MAX_PARTIAL_WORDS,
} from './bargeInV7';
export type {
  BargeInV7State,
  BargeInV7IgnoreReason,
  BargeInV7Action,
  BargeInV7Decision,
  BargeInV7InterruptResult,
  BargeInV7DuckResult,
  BargeInV7PartialUtterance,
  BargeInV7Stats,
  BargeInV7Options,
} from './bargeInV7';
export {
  TranscriptStreamV7,
  estimateTranscriptV7Tokens,
  TRANSCRIPT_V7_DEFAULT_MAX_LINES,
  TRANSCRIPT_V7_CHARS_PER_TOKEN,
} from './transcriptStreamV7';
export type {
  TranscriptV7Speaker,
  TranscriptV7Phase,
  TranscriptV7Word,
  TranscriptV7Line,
  TranscriptV7Event,
  TranscriptV7EventSink,
  TranscriptV7Stats,
  TranscriptStreamV7Options,
} from './transcriptStreamV7';
export {
  VoiceSessionV7,
  VoiceV7Manager,
  createMockVoiceSessionV7,
  VOICE_V7_SESSION_ID_RE,
  VOICE_V7_MOCK_REPLY_DELAY_MS,
  VOICE_V7_DEFAULT_MOCK_REPLY,
} from './voiceSessionV7';
export type {
  VoiceSessionV7Event,
  VoiceSessionV7EventSink,
  VoiceSessionV7Stats,
  VoiceSessionV7Summary,
  VoiceSessionV7Options,
} from './voiceSessionV7';
export {
  FileVoiceSessionV7Store,
  snapshotVoiceSessionV7,
  validateVoiceSessionV7Snapshot,
  restoreVoiceSessionV7,
  voiceSessionV7SnapshotSummary,
  voiceSessionV7SnapshotMarkdown,
  VOICE_V7_SNAPSHOT_DEFAULT_MAX_AGE_MS,
} from './voiceSessionV7Store';
export type {
  VoiceSessionV7Snapshot,
  VoiceSessionV7SnapshotInfo,
} from './voiceSessionV7Store';
// v1.09 (Đội T5 — voice v8): spectral VAD v8 (Goertzel bands +
// flatness + per-band floors + noise classification + dynamic
// hangover + simple fallback), full-duplex barge-in v8 (AEC-lite
// + playback-queue cancel receipt + interrupt while thinking),
// durable session store v8 (atomic + checksum + cut point),
// v8 session (PTT/auto + reconnect budget + resume from disk).
export {
  AdaptiveVadV8,
  SimpleEnergyVadV8,
  createVadV8,
  goertzelMagnitude,
  vadV8Spectrum,
  spectralFlatness,
  vadV8BandEnergies,
  classifyVadV8Noise,
  resolveVadV8Config,
  defaultVadV8Options,
  validateVadV8Options,
  isVadV8PresetName,
  isVadV8Engine,
  vadV8Summary,
  VAD_V8_PRESETS,
  VAD_V8_PRESET_NAMES,
  VAD_V8_ENGINE_NAMES,
  VAD_V8_GOERTZEL_FREQUENCIES_HZ,
  VAD_V8_BAND_SPLIT,
  VAD_V8_DEFAULT_THRESHOLD,
  VAD_V8_DEFAULT_HANGOVER_MS,
  VAD_V8_DEFAULT_MIN_HANGOVER_MS,
  VAD_V8_DEFAULT_MAX_HANGOVER_MS,
  VAD_V8_DEFAULT_WINDOW_MS,
  VAD_V8_DEFAULT_NOISE_LEARN_MS,
  VAD_V8_DEFAULT_THRESHOLD_MULTIPLIER,
  VAD_V8_DEFAULT_MIN_TURN_MS,
  VAD_V8_DEFAULT_BACKCHANNEL_MAX_MS,
  VAD_V8_DEFAULT_MAX_GAP_MS,
  VAD_V8_DEFAULT_DEBOUNCE_FRAMES,
  VAD_V8_DEFAULT_MIN_CONFIDENCE,
  VAD_V8_DEFAULT_MIN_ZCR,
  VAD_V8_DEFAULT_MAX_ZCR,
  VAD_V8_DEFAULT_MAX_FLATNESS,
  VAD_V8_DEFAULT_MIN_MID_BAND_MARGIN,
  VAD_V8_MAX_THRESHOLD,
  VAD_V8_MIN_THRESHOLD,
  VAD_V8_CALIBRATION_ALPHA,
  VAD_V8_DEFAULT_CALIBRATION_MS,
} from './vadV8';
export type {
  VadV8PresetName,
  VadV8Engine,
  VadV8State,
  VadV8NoiseKind,
  VadV8FalsePositiveReason,
  VadV8Event,
  VadV8EventSink,
  VadV8WindowFeatures,
  VadV8Stats,
  VadV8Config,
  AdaptiveVadV8Options,
} from './vadV8';
export {
  BargeInV8Controller,
  PlaybackQueueV8,
  aecResidualFrame,
  splitWordsV8,
  defaultBargeInV8Options,
  validateBargeInV8Options,
  bargeInV8Summary,
  BARGE_IN_V8_DEFAULT_ENERGY_THRESHOLD,
  BARGE_IN_V8_DEFAULT_DEBOUNCE_FRAMES,
  BARGE_IN_V8_DEFAULT_DEBOUNCE_WINDOW_MS,
  BARGE_IN_V8_DEFAULT_STOP_BUDGET_MS,
  BARGE_IN_V8_DEFAULT_GRACE_MS,
  BARGE_IN_V8_DEFAULT_ECHO_WINDOW_MS,
  BARGE_IN_V8_DEFAULT_ECHO_MULTIPLIER,
  BARGE_IN_V8_DEFAULT_DUCK_MS,
  BARGE_IN_V8_DEFAULT_COOLDOWN_MS,
  BARGE_IN_V8_DEFAULT_MIN_CONFIDENCE,
  BARGE_IN_V8_DEFAULT_DUCK_THRESHOLD,
  BARGE_IN_V8_DEFAULT_ECHO_GAIN,
  BARGE_IN_V8_DEFAULT_ECHO_LEARN_RATE,
  BARGE_IN_V8_DEFAULT_MAX_RESIDUAL_RATIO,
  BARGE_IN_V8_DEFAULT_ECHO_RING_FRAMES,
  BARGE_IN_V8_DEFAULT_WORD_MS,
} from './bargeInV8';
export type {
  BargeInV8State,
  BargeInV8IgnoreReason,
  BargeInV8Action,
  BargeInV8ModelPhase,
  BargeInV8Decision,
  BargeInV8InterruptResult,
  PlaybackWordV8,
  BargeInV8Stats,
  BargeInV8Options,
} from './bargeInV8';
export {
  VoiceSessionV8Store,
  voiceSessionV8SnapshotPath,
  createVoiceSessionV8Snapshot,
  validateVoiceSessionV8Snapshot,
  capVoiceSessionV8Turns,
  buildVoiceSessionV8ResumeInstructions,
  voiceSessionV8SnapshotMarkdown,
  VOICE_SESSION_V8_STORE_VERSION,
  VOICE_SESSION_V8_SNAPSHOT_EXT,
  VOICE_SESSION_V8_DEFAULT_MAX_TURNS,
  VOICE_SESSION_V8_DEFAULT_MAX_TURN_CHARS,
  VOICE_SESSION_V8_DEFAULT_MAX_AGE_MS,
} from './voiceSessionV8Store';
export type {
  VoiceSessionV8Turn,
  VoiceSessionV8CutPoint,
  VoiceSessionV8Snapshot,
  VoiceSessionV8Envelope,
  VoiceSessionV8LoadError,
  VoiceSessionV8LoadResult,
  VoiceSessionV8SaveResult,
  VoiceSessionV8StoreOptions,
} from './voiceSessionV8Store';
export {
  VoiceSessionV8,
  VoiceV8Manager,
  createMockVoiceSessionV8,
  VOICE_V8_SESSION_ID_RE,
  VOICE_V8_DEFAULT_MOCK_REPLY,
  VOICE_V8_DEFAULT_BASE_INSTRUCTIONS,
} from './voiceSessionV8';
export type {
  VoiceSessionV8Status,
  VoiceSessionV8InputMode,
  VoiceSessionV8Event,
  VoiceSessionV8EventSink,
  VoiceSessionV8Stats,
  VoiceSessionV8Summary,
  VoiceSessionV8Options,
} from './voiceSessionV8';
export {
  VoiceBudgetLink,
  voiceBudgetSummary,
} from './voiceBudgetLink';
export type {
  VoiceBudgetRecord,
  VoiceBudgetLinkOptions,
} from './voiceBudgetLink';
export {
  MockVadV9,
  createVadV9,
  defaultVadV9Options,
  validateVadV9Options,
  isVadV9PresetName,
  vadV9Summary,
  VAD_V9_PRESETS,
  VAD_V9_PRESET_NAMES,
  VAD_V9_FRAME_MS,
  VAD_V9_FRAME_SAMPLES,
} from './vadV9';
export type {
  VadV9PresetName,
  VadV9Options,
  VadV9Preset,
  VadV9Event,
  VadV9EventSink,
  VadV9Stats,
} from './vadV9';
export {
  BargeInV9Controller,
  splitWordsV9,
  defaultBargeInV9Options,
  validateBargeInV9Options,
  isBargeInV9Policy,
  bargeInV9Summary,
} from './bargeInV9';
export type {
  BargeInV9Policy,
  BargeInV9Options,
  BargeInV9Word,
  BargeInV9DecisionReason,
  BargeInV9Decision,
  BargeInV9InterruptResult,
  BargeInV9Stats,
  BargeInV9Event,
  BargeInV9EventSink,
} from './bargeInV9';
export {
  TranscriptStreamV9,
  validateTranscriptV9Options,
  transcriptV9LiveText,
  transcriptV9Markdown,
  transcriptV9Summary,
  TRANSCRIPT_V9_DEFAULT_MAX_TURNS,
  TRANSCRIPT_V9_DEFAULT_MAX_PARTIAL_CHARS,
} from './transcriptStreamV9';
export type {
  TranscriptV9Speaker,
  TranscriptV9ToolCall,
  TranscriptV9Turn,
  TranscriptV9Stats,
  TranscriptV9Options,
} from './transcriptStreamV9';
export {
  RealtimeVoiceSessionV9,
  VoiceV9Manager,
  createMockVoiceSessionV9,
  probeLiveVoiceV9Key,
  VOICE_V9_SESSION_ID_RE,
  VOICE_V9_DEFAULT_MOCK_REPLY,
} from './voiceSessionV9';
export type {
  VoiceSessionV9Status,
  VoiceSessionV9InputMode,
  VoiceV9ScriptedToolCall,
  VoiceV9ToolHandler,
  VoiceSessionV9Event,
  VoiceSessionV9EventSink,
  VoiceSessionV9Options,
  VoiceSessionV9Stats,
  VoiceV9LiveProbe,
  VoiceV9ManagerOptions,
} from './voiceSessionV9';
export {
  VoiceSessionV9Store,
  voiceSessionV9SnapshotPath,
  createVoiceSessionV9Snapshot,
  validateVoiceSessionV9Snapshot,
  buildVoiceSessionV9ResumeInstructions,
  voiceSessionV9SnapshotMarkdown,
  VOICE_SESSION_V9_STORE_VERSION,
  VOICE_SESSION_V9_MAX_TURNS,
  VOICE_SESSION_V9_MAX_FILES,
} from './voiceSessionV9Store';
export type {
  VoiceSessionV9CutPoint,
  VoiceSessionV9Snapshot,
  VoiceSessionV9StoreResult,
} from './voiceSessionV9Store';
export {
  VadV10,
  createVadV10,
  defaultVadV10Options,
  validateVadV10Options,
  isVadV10PresetName,
  vadV10Summary,
  vadV10Markdown,
  vadV10FrameFeatures,
  VAD_V10_PRESETS,
  VAD_V10_PRESET_NAMES,
  VAD_V10_FRAME_MS,
  VAD_V10_FRAME_SAMPLES,
} from './vadV10';
export type {
  VadV10PresetName,
  VadV10Options,
  VadV10Preset,
  VadV10Event,
  VadV10EventSink,
  VadV10Stats,
  VadV10FrameFeatures,
} from './vadV10';
export {
  NoiseSuppressorV10,
  defaultNoiseSuppressionV10Options,
  validateNoiseSuppressionV10Options,
  isNoiseSuppressionLevel,
  noiseSuppressionV10Summary,
  noiseSuppressionV10Markdown,
  NOISE_SUPPRESSION_LEVELS,
  NOISE_SUPPRESSION_LEVEL_PRESETS,
  NOISE_PROFILE_STALE_MS,
} from './noiseSuppressionV10';
export type {
  NoiseSuppressionLevel,
  NoiseSuppressionV10Options,
  NoiseSuppressionLevelPreset,
  SuppressedFrameV10,
  NoiseSuppressionV10Stats,
} from './noiseSuppressionV10';
export {
  RealtimeVoicePipelineV2,
  PartialTranscriptBufferV2,
  MockRealtimeV2Transport,
  createRealtimeVoicePipelineV2,
  realtimeV2Summary,
  realtimeV2Markdown,
  REALTIME_V2_SESSION_ID_RE,
  REALTIME_V2_DEFAULT_MOCK_REPLY,
} from './realtimeV2';
export type {
  RealtimeV2Mode,
  RealtimeV2State,
  RealtimeV2FallbackReason,
  RealtimeV2TransportMessage,
  RealtimeV2TransportSink,
  RealtimeV2Transport,
  RealtimeV2BatchStt,
  RealtimeV2BatchTts,
  RealtimeV2Options,
  RealtimeV2Event,
  RealtimeV2EventSink,
  RealtimeV2Stats,
} from './realtimeV2';
export {
  MemoryBotVoicePresetStore,
  FileBotVoicePresetStore,
  validateBotVoicePreset,
  getBuiltinBotVoicePreset,
  getVoiceV10ProviderCatalog,
  findVoiceV10CatalogVoice,
  voicesForLanguageV10,
  defaultVoiceForProviderV10,
  isVoiceV10ProviderId,
  isVoiceV10LanguageTag,
  pickPresetForLanguage,
  resolveEffectiveVoiceSettings,
  defaultEffectiveVoiceSettings,
  botVoicePresetStoreSummary,
  effectiveVoiceSettingsMarkdown,
  VOICE_V10_PROVIDER_CATALOG,
  VOICE_V10_PROVIDER_IDS,
  VOICE_V10_LANGUAGES,
  VOICE_V10_MIN_RATE,
  VOICE_V10_MAX_RATE,
  VOICE_V10_BOT_ID_RE,
  VOICE_V10_PRESET_ID_RE,
  VOICE_V10_MAX_PRESETS_PER_BOT,
  DEFAULT_BOT_VOICE_PRESETS,
} from './voiceSettingsV10';
export type {
  VoiceV10ProviderId,
  VoiceV10CatalogVoice,
  VoiceV10ProviderCatalog,
  VoiceV10Language,
  BotVoicePreset,
  BotVoicePresetValidationResult,
  EffectiveVoiceSettings,
  BotVoicePresetStoreStats,
} from './voiceSettingsV10';
export {
  RealtimeVoiceSessionV10,
  VoiceV10Manager,
  createMockVoiceSessionV10,
  probeLiveVoiceV10Key,
  VOICE_V10_SESSION_ID_RE,
  VOICE_V10_DEFAULT_MOCK_REPLY,
} from './voiceSessionV10';
export type {
  VoiceSessionV10Status,
  VoiceSessionV10Event,
  VoiceSessionV10EventSink,
  VoiceSessionV10Options,
  VoiceSessionV10Stats,
  VoiceV10LiveProbe,
  VoiceV10ManagerOptions,
} from './voiceSessionV10';
export {
  mulberry32,
  frameRms,
  frameZcr,
  silenceFrame,
  toneFrame,
  noiseFrame,
  speechLikeFrame,
  humFrame,
  hissFrame,
  echoFrame,
  buildMockAudioScript,
  mockFrameSummary,
  writeMockSample,
  readMockSample,
  MOCK_AUDIO_FRAME_SAMPLES,
  MOCK_AUDIO_SAMPLE_RATE_HZ,
  MOCK_AUDIO_FRAME_BYTES,
} from './audioMockV11';
export type {
  MockAudioSegment,
  MockAudioScriptFrame,
} from './audioMockV11';
export {
  VadV11,
  createVadV11,
  defaultVadV11Options,
  validateVadV11Options,
  isVadV11PresetName,
  vadV11Summary,
  vadV11Markdown,
  vadV11FrameFeatures,
  vadV11ZcrFit,
  vadV11RatioFit,
  VAD_V11_PRESETS,
  VAD_V11_PRESET_NAMES,
  VAD_V11_FRAME_MS,
  VAD_V11_FRAME_SAMPLES,
} from './vadV11';
export type {
  VadV11PresetName,
  VadV11Options,
  VadV11Preset,
  VadV11Event,
  VadV11EventSink,
  VadV11Stats,
  VadV11FrameFeatures,
} from './vadV11';
export {
  BargeInV11Controller,
  splitWordsV11,
  defaultBargeInV11Options,
  validateBargeInV11Options,
  isBargeInV11Policy,
  isBargeInV11State,
  bargeInV11Summary,
  bargeInV11Markdown,
  BARGE_IN_V11_TRANSITIONS,
  BARGE_IN_V11_STATES,
} from './bargeInV11';
export type {
  BargeInV11Policy,
  BargeInV11State,
  BargeInV11Options,
  BargeInV11Word,
  BargeInV11DecisionReason,
  BargeInV11Decision,
  BargeInV11InterruptResult,
  BargeInV11Stats,
  BargeInV11Transition,
  BargeInV11Event,
  BargeInV11EventSink,
} from './bargeInV11';
export {
  TurnTakingManagerV11,
  defaultTurnTakingV11Options,
  validateTurnTakingV11Options,
  turnTakingV11Summary,
  turnTakingV11Markdown,
} from './turnTakingV11';
export type {
  TurnTakingV11Floor,
  TurnTakingV11Options,
  TurnTakingV11Turn,
  TurnTakingV11Overlap,
  TurnTakingV11Event,
  TurnTakingV11EventSink,
  TurnTakingV11Stats,
} from './turnTakingV11';
export {
  TtsStreamV11,
  createTtsStreamV11,
  splitTtsStreamChunks,
  mockTtsSynthV11,
  defaultTtsStreamV11Options,
  validateTtsStreamV11Options,
  ttsStreamV11Summary,
  ttsStreamV11Markdown,
  TTS_STREAM_ABBREVIATIONS,
} from './ttsStreamV11';
export type {
  TtsStreamChunkV11,
  TtsStreamCancelResult,
  TtsStreamFeedResult,
  TtsStreamSynth,
  TtsStreamV11Options,
  TtsStreamV11Stats,
  TtsStreamV11Event,
  TtsStreamV11EventSink,
} from './ttsStreamV11';
export {
  RealtimeVoiceSessionV11,
  VoiceV11Manager,
  createMockVoiceSessionV11,
  voiceSessionV11Summary,
  voiceSessionV11Markdown,
  VOICE_V11_SESSION_ID_RE,
  VOICE_V11_DEFAULT_MOCK_REPLY,
} from './voiceSessionV11';
export type {
  VoiceSessionV11Status,
  VoiceSessionV11Event,
  VoiceSessionV11EventSink,
  VoiceSessionV11Options,
  VoiceSessionV11Stats,
  VoiceV11ManagerOptions,
} from './voiceSessionV11';
export {
  VoiceSessionV11Store,
  createVoiceSessionV11Snapshot,
  validateVoiceSessionV11Snapshot,
  voiceSessionV11SnapshotPath,
  buildVoiceSessionV11ResumeInstructions,
  voiceSessionV11SnapshotMarkdown,
  VOICE_SESSION_V11_STORE_VERSION,
  VOICE_SESSION_V11_MAX_TURNS,
  VOICE_SESSION_V11_MAX_FILES,
} from './voiceSessionV11Store';
export type {
  VoiceSessionV11CutPoint,
  VoiceSessionV11Snapshot,
  VoiceSessionV11StoreResult,
} from './voiceSessionV11Store';

// --- v1.13 (Đội T5): voice realtime v12 (interrupt context,
// planned TTS streaming, unified turn machine + end-of-turn
// detector, overlap tracker with ducking envelope, v12 session) ---
export {
  InterruptContextV12,
  createInterruptContextV12,
  chooseResumeStrategyV12,
  summarizeRemainderV12,
  buildResumePromptV12,
  bargeInV12Summary,
  bargeInV12Markdown,
  BARGE_IN_V12_STRATEGIES,
  BARGE_IN_V12_NEW_TURN_WORDS,
  defaultBargeInV12Options,
  validateBargeInV12Options,
  isBargeInV12ResumeStrategy,
} from './bargeInV12';
export type {
  BargeInV12ResumeStrategy,
  BargeInV12Options,
  BargeInV12UserInterruption,
  InterruptedUtteranceV12,
  BargeInV12Stats,
  BargeInV12Event,
  BargeInV12EventSink,
} from './bargeInV12';
export {
  TtsStreamV12,
  createTtsStreamV12,
  splitTtsStreamChunksV12,
  prosodyForChunkV12,
  wordTimingsV12,
  pacingFactorV12,
  defaultTtsStreamV12Options,
  validateTtsStreamV12Options,
  ttsStreamV12Summary,
  ttsStreamV12Markdown,
  TTS_STREAM_V12_ABBREVIATIONS,
} from './ttsStreamV12';
export type {
  TtsWordTimingV12,
  TtsProsodyPauseV12,
  TtsPlannedChunkV12,
  TtsStreamV12Options,
  TtsStreamV12Stats,
  TtsStreamV12Event,
  TtsStreamV12EventSink,
} from './ttsStreamV12';
export {
  TurnMachineV12,
  EndOfTurnDetectorV12,
  defaultTurnMachineV12Options,
  validateTurnMachineV12Options,
  turnMachineV12Summary,
  turnMachineV12Markdown,
  defaultEndOfTurnDetectorV12Options,
  validateEndOfTurnDetectorV12Options,
  endOfTurnDetectorV12Summary,
  TURN_V12_TRANSITIONS,
  TURN_V12_STATES,
  isTurnV12State,
} from './turnTakingV12';
export type {
  TurnV12State,
  TurnMachineV12Options,
  TurnV12Transition,
  TurnMachineV12Stats,
  TurnMachineV12Event,
  TurnMachineV12EventSink,
  TurnV12Turn,
  EndOfTurnDetectorV12Options,
  EndOfTurnV12Reason,
  EndOfTurnV12Decision,
  EndOfTurnDetectorV12Stats,
  EndOfTurnDetectorV12EventSink,
} from './turnTakingV12';
export {
  OverlapTrackerV12,
  DuckEnvelopeV12,
  createOverlapTrackerV12,
  defaultOverlapV12Options,
  validateOverlapV12Options,
  isOverlapV12Policy,
  overlapV12Summary,
  overlapV12Markdown,
  OVERLAP_V12_POLICIES,
} from './overlapV12';
export type {
  OverlapV12Policy,
  OverlapV12Winner,
  OverlapV12Options,
  OverlapV12Segment,
  OverlapV12Stats,
  OverlapV12Event,
  OverlapV12EventSink,
} from './overlapV12';
export {
  RealtimeVoiceSessionV12,
  VoiceV12Manager,
  createMockVoiceSessionV12,
  voiceSessionV12Summary,
  voiceSessionV12Markdown,
} from './voiceSessionV12';
export type {
  VoiceSessionV12Status,
  VoiceSessionV12Event,
  VoiceSessionV12EventSink,
  VoiceSessionV12Options,
  VoiceSessionV12Stats,
  VoiceV12ManagerOptions,
} from './voiceSessionV12';
// --- v1.14 (Đội T5): voice v13 — barge-in engine, clause TTS,
// Smart Turn, latency budget, wake word, pluggable providers. ---
export {
  CancelScopeV13,
  createCancelScopeV13,
  BargeInEngineV13,
  createBargeInEngineV13,
  defaultBargeInV13Options,
  validateBargeInV13Options,
  isBargeInV13Policy,
  bargeInV13Summary,
  bargeInV13Markdown,
  BARGE_IN_V13_POLICIES,
} from './bargeInV13';
export type {
  BargeInV13Policy,
  BargeInV13Options,
  CancelScopeV13Work,
  CancelScopeV13Receipt,
  CancelScopeV13Result,
  CancelScopeV13Stats,
  CancelScopeV13Event,
  CancelScopeV13EventSink,
  BargeInV13CutDecision,
  BargeInV13CutResult,
  BargeInV13Stats,
  BargeInV13Event,
  BargeInV13EventSink,
  BargeInV13TtsQueueLike,
} from './bargeInV13';
export {
  ClauseTtsStreamV13,
  createClauseTtsStreamV13,
  splitClausesV13,
  joinPauseForTerminatorV13,
  defaultTtsClauseV13Options,
  validateTtsClauseV13Options,
  ttsClauseV13Summary,
  ttsClauseV13Markdown,
} from './ttsClauseV13';
export type {
  TtsClauseV13,
  TtsClauseV13Options,
  TtsClauseV13Stats,
  TtsClauseV13Event,
  TtsClauseV13EventSink,
} from './ttsClauseV13';
export {
  SmartTurnDetectorV13,
  createSmartTurnDetectorV13,
  scoreTurnCompletenessV13,
  defaultSmartTurnV13Options,
  validateSmartTurnV13Options,
  smartTurnV13Summary,
  smartTurnV13Markdown,
  SMART_TURN_V13_QUESTION_WORDS,
  SMART_TURN_V13_TRAILING_WORDS,
  SMART_TURN_V13_FILLERS,
  SMART_TURN_V13_QUESTION_ENDINGS,
} from './smartTurnV13';
export type {
  SmartTurnV13Signal,
  SmartTurnV13Score,
  SmartTurnV13Options,
  SmartTurnV13Decision,
  SmartTurnV13Stats,
  SmartTurnV13Event,
  SmartTurnV13EventSink,
} from './smartTurnV13';
export {
  LatencyBudgetV13,
  createLatencyBudgetV13,
  defaultLatencyBudgetV13Budgets,
  defaultLatencyBudgetV13Options,
  validateLatencyBudgetV13Options,
  percentileV13,
  stageReportV13,
  latencyBudgetV13Summary,
  latencyBudgetV13Markdown,
  LATENCY_BUDGET_V13_STAGES,
} from './latencyBudgetV13';
export type {
  LatencyBudgetV13Stage,
  LatencyBudgetV13Budgets,
  LatencyBudgetV13Sample,
  LatencyBudgetV13StageReport,
  LatencyBudgetV13TurnReport,
  LatencyBudgetV13Alert,
  LatencyBudgetV13Options,
  LatencyBudgetV13Stats,
  LatencyBudgetV13Event,
  LatencyBudgetV13EventSink,
} from './latencyBudgetV13';
export {
  MockWakeWordEngineV13,
  WakeWordDetectorV13,
  createWakeWordDetectorV13,
  foldDiacriticsV13,
  defaultWakeWordV13Options,
  validateWakeWordV13Options,
  wakeWordV13Summary,
  wakeWordV13Markdown,
  WAKE_WORD_V13_DEFAULT_KEYWORDS,
} from './wakeWordV13';
export type {
  WakeWordV13Match,
  WakeWordEngineV13,
  MockWakeWordV13Options,
  WakeWordV13Options,
  WakeWordV13State,
  WakeWordV13Activation,
  WakeWordV13Stats,
  WakeWordV13Event,
  WakeWordV13EventSink,
} from './wakeWordV13';
export {
  MockVoiceProviderV13,
  EdgeTtsVoiceProviderV13,
  WhisperLocalVoiceProviderV13,
  RealtimeApiVoiceProviderV13,
  createVoiceProviderV13,
  VoiceProviderRegistryV13,
  createVoiceProviderRegistryV13,
  isVoiceProviderV13Kind,
  defaultVoiceProviderV13Options,
  validateVoiceProviderV13Options,
  voiceProviderV13Summary,
  voiceProviderRegistryV13Markdown,
  VOICE_PROVIDER_V13_KINDS,
} from './voiceProvidersV13';
export type {
  VoiceProviderV13Capabilities,
  VoiceProviderV13SttInput,
  VoiceProviderV13SttResult,
  VoiceProviderV13TtsInput,
  VoiceProviderV13TtsResult,
  VoiceProviderV13,
  VoiceProviderV13Kind,
  VoiceProviderV13Options,
} from './voiceProvidersV13';
export {
  RealtimeVoiceSessionV13,
  VoiceV13Manager,
  createRealtimeVoiceSessionV13,
  createVoiceV13Manager,
  voiceSessionV13Summary,
  voiceSessionV13Markdown,
} from './voiceSessionV13';
export type {
  VoiceSessionV13Status,
  VoiceSessionV13Event,
  VoiceSessionV13EventSink,
  VoiceSessionV13Options,
  VoiceSessionV13Stats,
  VoiceV13ManagerOptions,
} from './voiceSessionV13';
// --- v1.15 (Đội T5): voice v14 — latency budget v2, provider
// pluggable v2 (Deepgram/Cartesia/Whisper local/Pocket TTS),
// semantic turn-taking v2, wake word v2, barge-in v2. ---
export {
  LatencyBudgetV14,
  createLatencyBudgetV14,
  latencyBudgetV14ProfileBudgets,
  defaultLatencyBudgetV14Options,
  validateLatencyBudgetV14Options,
  sessionStageReportV14,
  isLatencyBudgetV14Profile,
  latencyBudgetV14Summary,
  latencyBudgetV14SessionMarkdown,
  LATENCY_BUDGET_V14_STAGES,
  LATENCY_BUDGET_V14_PROFILES,
} from './latencyBudgetV14';
export type {
  LatencyBudgetV14Stage,
  LatencyBudgetV14Budgets,
  LatencyBudgetV14Profile,
  LatencyBudgetV14AlertLevel,
  LatencyBudgetV14Sample,
  LatencyBudgetV14Alert,
  LatencyBudgetV14SessionStageReport,
  LatencyBudgetV14SessionReport,
  LatencyBudgetV14Stats,
  LatencyBudgetV14Options,
  LatencyBudgetV14Event,
  LatencyBudgetV14EventSink,
} from './latencyBudgetV14';
export {
  MockVoiceProviderV14,
  DeepgramVoiceProviderV14,
  CartesiaVoiceProviderV14,
  WhisperLocalVoiceProviderV14,
  PocketTtsVoiceProviderV14,
  RealtimeApiVoiceProviderV14,
  createVoiceProviderV14,
  wrapVoiceProviderV13,
  VoiceProviderRegistryV14,
  createVoiceProviderRegistryV14,
  scoreVoiceProviderV14,
  estimateVoiceProviderV14HourlyCost,
  isVoiceProviderV14Kind,
  defaultVoiceProviderV14Options,
  validateVoiceProviderV14Options,
  voiceProviderV14Summary,
  voiceProviderRegistryV14Markdown,
  VOICE_PROVIDER_V14_KINDS,
  WHISPER_V14_MODEL_SIZES,
  WHISPER_V14_LATENCY_MS_PER_SECOND,
} from './voiceProvidersV14';
export type {
  VoiceProviderV14Capabilities,
  VoiceProviderV14Profile,
  VoiceProviderV14SttPartial,
  VoiceProviderV14SttInput,
  VoiceProviderV14TtsInput,
  VoiceProviderV14TtsResult,
  SttProviderV14,
  TtsProviderV14,
  VoiceProviderV14,
  VoiceProviderV14Kind,
  WhisperV14ModelSize,
  VoiceProviderV14Options,
  VoiceProviderV14PickGoal,
  VoiceProviderV14PickOptions,
} from './voiceProvidersV14';
export {
  SmartTurnDetectorV14,
  createSmartTurnDetectorV14,
  scoreTurnCompletenessV14,
  splitClausesV14,
  classifyQuestionV14,
  findFillersV14,
  classifyBackchannelV14,
  sensitivityPresetV14,
  defaultSmartTurnV14Options,
  validateSmartTurnV14Options,
  isSmartTurnV14Sensitivity,
  smartTurnV14Summary,
  smartTurnV14Markdown,
  SMART_TURN_V14_SENSITIVITIES,
  SMART_TURN_V14_OPEN_QUESTION_WORDS,
  SMART_TURN_V14_OPEN_QUESTION_PHRASES,
  SMART_TURN_V14_CLOSED_QUESTION_ENDINGS,
  SMART_TURN_V14_MID_FILLERS,
  SMART_TURN_V14_ACK_WORDS,
  SMART_TURN_V14_CONTINUE_WORDS,
  SMART_TURN_V14_CLAUSE_CONJUNCTIONS,
} from './smartTurnV14';
export type {
  SmartTurnV14Clause,
  SmartTurnV14QuestionKind,
  SmartTurnV14BackchannelKind,
  SmartTurnV14Sensitivity,
  SmartTurnV14Score,
  SmartTurnV14Options,
  SmartTurnV14Decision,
  SmartTurnV14Stats,
  SmartTurnV14Event,
  SmartTurnV14EventSink,
} from './smartTurnV14';
export {
  WakeWordDetectorV14,
  createWakeWordDetectorV14,
  defaultWakeWordV14WordConfig,
  defaultWakeWordV14Options,
  validateWakeWordV14WordConfig,
  validateWakeWordV14Options,
  evaluateWakeWordV14,
  wakeWordV14Summary,
  wakeWordV14Markdown,
  wakeWordV14EvaluationMarkdown,
  WAKE_WORD_V14_DEFAULT_WORDS,
} from './wakeWordV14';
export type {
  WakeWordV14WordConfig,
  WakeWordV14WordConfigResolved,
  WakeWordV14NearMiss,
  WakeWordV14Options,
  WakeWordV14State,
  WakeWordV14Activation,
  WakeWordV14Suppressed,
  WakeWordV14Stats,
  WakeWordV14Event,
  WakeWordV14EventSink,
  WakeWordV14TestSample,
  WakeWordV14EvalResult,
  WakeWordV14Evaluation,
} from './wakeWordV14';
export {
  StageQueueV14,
  VoicePipelineV14,
  createVoicePipelineV14,
  cutMidSentenceV14,
  defaultDropPolicyV14,
  validateVoicePipelineV14QueueOptions,
  BargeInEngineV14,
  createBargeInEngineV14,
  bargeInV14Summary,
  bargeInV14Markdown,
  VOICE_PIPELINE_V14_STAGES,
} from './bargeInV14';
export type {
  VoicePipelineV14Stage,
  VoicePipelineV14DropPolicy,
  VoicePipelineV14Item,
  VoicePipelineV14EnqueueResult,
  VoicePipelineV14QueueStats,
  VoicePipelineV14QueueOptions,
  VoicePipelineV14Options,
  VoicePipelineV14Cut,
  VoicePipelineV14Stats,
  VoicePipelineV14Event,
  VoicePipelineV14EventSink,
  MidSentenceCutV14,
  BargeInV14Options,
  BargeInV14CutResult,
  BargeInV14Stats,
  BargeInV14Event,
  BargeInV14EventSink,
} from './bargeInV14';
export {
  RealtimeVoiceSessionV14,
  VoiceV14Manager,
  createRealtimeVoiceSessionV14,
  createVoiceV14Manager,
  voiceSessionV14Summary,
  voiceSessionV14Markdown,
} from './voiceSessionV14';
export type {
  VoiceSessionV14Status,
  VoiceSessionV14Event,
  VoiceSessionV14EventSink,
  VoiceSessionV14Options,
  VoiceSessionV14Stats,
  VoiceV14ManagerOptions,
} from './voiceSessionV14';
