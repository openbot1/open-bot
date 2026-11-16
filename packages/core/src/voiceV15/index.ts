/**
 * @open-bot/core/voiceV15 — voice realtime v15 (v1.16, Đội T5).
 *
 * Speech-to-speech path (mock-first OpenAI Realtime / Gemini Live
 * adapters + reconnect state machine + pipeline fallback), latency
 * pipeline v3 with per-stage budgets and auto-degradation, barge-in
 * v3 (energy gate + cough/breath/noise rejection + cancel scope),
 * semantic turn-taking v3 (vi + en, thinking-pause vs done),
 * TTS streaming v3 with per-bot voice profiles, wake word v3
 * (multi-word, sensitivity, false-positive guards), provider
 * registry v2 (plugin interface for STT/TTS/S2S), and the v15
 * session that wires them together. No network, no sound card,
 * no key — every audio path is mock / synthetic.
 */
export {
  S2SAdapterV15,
  MockS2STransportV15,
  createS2SAdapterV15,
  isS2SProviderKindV15,
  s2sReconnectDelayV15,
  defaultS2SAdapterOptionsV15,
  validateS2SAdapterOptionsV15,
  s2sV15Summary,
  s2sV15Markdown,
  S2S_V15_SAMPLE_RATE_HZ,
  S2S_V15_FRAME_MS,
  S2S_V15_FRAME_SAMPLES,
  S2S_V15_MAX_RECONNECT_ATTEMPTS,
  S2S_V15_BASE_RECONNECT_DELAY_MS,
  S2S_V15_MAX_RECONNECT_DELAY_MS,
  S2S_V15_RECONNECT_BACKOFF_MULTIPLIER,
  S2S_V15_PROVIDER_KINDS,
  S2S_V15_STATES,
} from './s2sV15';
export type {
  S2SProviderKindV15,
  S2SStateV15,
  S2SEventKindV15,
  S2SFunctionCallV15,
  S2SEventV15,
  S2SEventSinkV15,
  MockS2SScriptEventV15,
  MockS2STransportOptionsV15,
  S2STransportV15,
  S2SAdapterOptionsV15,
  S2SFunctionHandlerV15,
  S2SAdapterStatsV15,
} from './s2sV15';

export {
  LatencyPipelineV15,
  createLatencyPipelineV15,
  defaultPipelineBudgetsV15,
  validatePipelineBudgetsV15,
  defaultLatencyPipelineOptionsV15,
  percentileV15,
  pipelineQualityStepDownV15,
  pipelineQualityStepUpV15,
  pipelineQualityPolicyV15,
  latencyPipelineV15Summary,
  latencyPipelineV15Markdown,
  PIPELINE_V15_STAGES,
  PIPELINE_V15_QUALITIES,
} from './pipelineV15';
export type {
  PipelineStageV15,
  PipelineQualityV15,
  PipelineAlertLevelV15,
  PipelineBudgetsV15,
  PipelineStageSampleV15,
  PipelineTurnSampleV15,
  PipelineAlertV15,
  PipelineStageStatsV15,
  PipelineSessionReportV15,
  PipelineQualityStepV15,
  LatencyPipelineOptionsV15,
  LatencyPipelineDefaultsV15,
  PipelineEventSinkV15,
} from './pipelineV15';

export {
  BargeInDetectorV15,
  BargeInEngineV15,
  createBargeInEngineV15,
  defaultBargeInV15Options,
  validateBargeInV15Options,
  frameRmsV15,
  syntheticFrameV15,
  bargeInV15Summary,
  bargeInV15Markdown,
} from './bargeInV15';
export type {
  BargeInV15Options,
  BargeInV15RejectionReason,
  BargeInV15Frame,
  BargeInV15EventKind,
  BargeInV15Event,
  BargeInV15EventSink,
  BargeInV15CancelScope,
  BargeInV15CutReceipt,
  BargeInV15Stats,
  BargeInEngineV15Options,
} from './bargeInV15';

export {
  SmartTurnDetectorV15,
  createSmartTurnDetectorV15,
  scoreTurnCompletenessV15,
  splitClausesV15,
  detectSmartTurnLanguageV15,
  sensitivityPresetV15,
  defaultSmartTurnV15Options,
  validateSmartTurnV15Options,
  smartTurnV15Summary,
  smartTurnV15Markdown,
  SMART_TURN_V15_SENSITIVITIES,
  SMART_TURN_V15_TERMINAL_PUNCT,
  SMART_TURN_V15_CLAUSE_SPLITTERS,
  SMART_TURN_V15_VI_TRAILING_CONJUNCTIONS,
  SMART_TURN_V15_EN_TRAILING_CONJUNCTIONS,
  SMART_TURN_V15_VI_OPEN_QUESTION_WORDS,
  SMART_TURN_V15_EN_OPEN_QUESTION_WORDS,
  SMART_TURN_V15_VI_CLOSED_ENDINGS,
  SMART_TURN_V15_EN_CLOSED_ENDINGS,
  SMART_TURN_V15_VI_FILLERS,
  SMART_TURN_V15_EN_FILLERS,
  SMART_TURN_V15_VI_ACK_WORDS,
  SMART_TURN_V15_EN_ACK_WORDS,
  SMART_TURN_V15_VI_CONTINUE_WORDS,
  SMART_TURN_V15_EN_CONTINUE_WORDS,
  SMART_TURN_V15_VI_FINAL_MARKERS,
  SMART_TURN_V15_EN_FINAL_MARKERS,
} from './smartTurnV15';
export type {
  SmartTurnV15Language,
  SmartTurnV15Sensitivity,
  SmartTurnV15Decision,
  SmartTurnV15Class,
  SmartTurnV15Options,
  SmartTurnV15Signals,
  SmartTurnV15Score,
  SmartTurnV15DetectorEvent,
  SmartTurnV15DetectorSink,
  SmartTurnV15DetectorStats,
} from './smartTurnV15';

export {
  TtsStreamV15,
  VoiceProfileStoreV15,
  createTtsStreamV15,
  defaultVoiceProfileV15,
  validateVoiceProfileV15,
  voiceProfileStepDownV15,
  voiceProfileStepUpV15,
  chunkTtsTextV15,
  mockTtsSynthV15,
  ttsV15Summary,
  ttsV15Markdown,
  TTS_V15_QUALITIES,
} from './ttsStreamV15';
export type {
  TtsQualityV15,
  VoiceProfileV15,
  TtsChunkV15,
  TtsAudioChunkV15,
  TtsSynthV15,
  TtsStreamStateV15,
  TtsStreamEventV15,
  TtsStreamSinkV15,
  TtsStreamStatsV15,
} from './ttsStreamV15';

export {
  WakeWordDetectorV15,
  createWakeWordDetectorV15,
  defaultWakeWordV15Config,
  sensitivityThresholdV15,
  validateWakeWordV15Config,
  levenshteinV15,
  wakeWordSimilarityV15,
  wakeWordV15Summary,
  wakeWordV15Markdown,
  wakeWordV15EvaluationMarkdown,
  WAKE_WORD_V15_SENSITIVITIES,
  WAKE_WORD_V15_DEFAULT_WORDS,
} from './wakeWordV15';
export type {
  WakeWordV15Sensitivity,
  WakeWordV15Config,
  WakeWordV15EventKind,
  WakeWordV15SuppressReason,
  WakeWordV15Event,
  WakeWordV15Sink,
  WakeWordV15TestSample,
  WakeWordV15Evaluation,
  WakeWordV15Stats,
} from './wakeWordV15';

export {
  VoiceProviderRegistryV15,
  createVoiceProviderRegistryV15,
  isVoiceProviderKindV15,
  isVoiceProviderGoalV15,
  validateVoiceProviderPluginV15,
  goalWeightsV15,
  scoreVoiceProviderV15,
  mockSttPluginV15,
  mockTtsPluginV15,
  mockS2SPluginV15,
  estimateVoiceProviderHourlyCostV15,
  voiceProviderRegistryV15Summary,
  voiceProviderRegistryV15Markdown,
  VOICE_PROVIDER_V15_KINDS,
  VOICE_PROVIDER_V15_GOALS,
} from './providerRegistryV15';
export type {
  VoiceProviderKindV15,
  VoiceProviderGoalV15,
  VoiceProviderPluginV15,
  VoiceProviderScoreV15,
  VoiceProviderPickOptionsV15,
  VoiceProviderPairV15,
} from './providerRegistryV15';

export {
  VoiceSessionV15,
  VoiceSessionManagerV15,
  createVoiceSessionV15,
  createVoiceSessionManagerV15,
  defaultVoiceSessionV15Options,
  voiceSessionV15Summary,
  voiceSessionV15Markdown,
} from './sessionV15';
export type {
  VoiceSessionV15Mode,
  VoiceSessionV15State,
  VoiceSessionV15EventKind,
  VoiceSessionV15Event,
  VoiceSessionV15Sink,
  VoiceSessionV15Options,
  VoiceSessionV15Turn,
  VoiceSessionV15Stats,
} from './sessionV15';
