/**
 * @open-bot/core/voiceV16 — voice realtime v16 (v1.17, Đội T5).
 *
 * Realtime v4 on top of voice v15: a complete speech-to-speech
 * path (mic → streaming STT → agent → streaming TTS → speaker)
 * with backpressure at every stage boundary and reconnect with
 * turn resume, barge-in v4 (immediate TTS stop, spoken prefix +
 * turn context kept, echo-aware while the bot speaks, the
 * interruption captured as the next turn), semantic turn-taking
 * v4 (completeness + silence gap, never cut mid-sentence, max-wait
 * timeout with a prompt), wake-word v4 (many configurable words,
 * wake + command in one breath, auto-sleep after silence,
 * wake-storm guard), TTS streaming v2 (small chunks, first chunk
 * plays at once, gapless joins with underrun recovery), and the
 * v16 session that wires them together. No network, no sound card,
 * no key — every audio path is mock / synthetic.
 */
export {
  StreamingSttV16,
  BoundedQueueV16,
  SpeechToSpeechPipelineV16,
  createStreamingSttV16,
  createS2SPipelineV16,
  defaultStreamingSttV16Options,
  validateStreamingSttV16Options,
  defaultS2SPipelineOptionsV16,
  validateS2SPipelineOptionsV16,
  s2sV16Summary,
  s2sV16Markdown,
  S2S_V16_SAMPLE_RATE_HZ,
  S2S_V16_FRAME_MS,
  S2S_V16_FRAME_SAMPLES,
  S2S_V16_DEFAULT_MAX_QUEUED_FRAMES,
  S2S_V16_DEFAULT_MAX_QUEUED_REPLY_CHUNKS,
  S2S_V16_DEFAULT_MAX_QUEUED_AUDIO_CHUNKS,
} from './s2sV16';
export type {
  SttWordScheduleV16,
  SttV16EventKind,
  SttV16Event,
  SttV16Sink,
  StreamingSttV16Options,
  BackpressureStateV16,
  BoundedQueueStatsV16,
  S2SResumeTokenV16,
  S2SPipelineModeV16,
  S2SPipelineStateV16,
  S2SPipelineEventKindV16,
  S2SPipelineEventV16,
  S2SPipelineSinkV16,
  S2SPipelineOptionsV16,
  S2SPipelineStatsV16,
} from './s2sV16';

export {
  BargeInEngineV16,
  createBargeInEngineV16,
  defaultBargeInV16Options,
  validateBargeInV16Options,
  bargeInV16Summary,
  bargeInV16Markdown,
} from './bargeInV16';
export type {
  BargeInV16Options,
  BargeInV16CutKind,
  BargeInV16TurnContext,
  BargeInV16CutReceipt,
  BargeInV16EventKind,
  BargeInV16Event,
  BargeInV16EventSink,
  BargeInV16Stats,
  BargeInV16Hooks,
} from './bargeInV16';

export {
  SmartTurnDetectorV16,
  createSmartTurnDetectorV16,
  decideSmartTurnV16,
  speechRateWpsV16,
  isListInProgressV16,
  defaultSmartTurnV16Options,
  validateSmartTurnV16Options,
  smartTurnV16Summary,
  smartTurnV16Markdown,
} from './smartTurnV16';
export type {
  SmartTurnV16State,
  SmartTurnV16Decision,
  SmartTurnV16HoldReason,
  SmartTurnV16Options,
  SmartTurnV16DecisionInput,
  SmartTurnV16DecisionOutput,
  SmartTurnV16EventKind,
  SmartTurnV16Event,
  SmartTurnV16Sink,
  SmartTurnV16Stats,
} from './smartTurnV16';

export {
  WakeWordDetectorV16,
  createWakeWordDetectorV16,
  defaultWakeWordV16Config,
  validateWakeWordV16Config,
  defaultWakeWordV16Options,
  validateWakeWordV16Options,
  extractWakeCommandV16,
  wakeWordV16Summary,
  wakeWordV16Markdown,
  wakeWordSimilarityV15,
  WAKE_WORD_V16_DEFAULT_WORDS,
} from './wakeWordV16';
export type {
  WakeWordV16Config,
  WakeWordV16Options,
  WakeWordV16EventKind,
  WakeWordV16Event,
  WakeWordV16Sink,
  WakeWordV16Stats,
} from './wakeWordV16';

export {
  TtsStreamV16,
  createTtsStreamV16,
  defaultTtsStreamV16Options,
  validateTtsStreamV16Options,
  ttsChunkDurationMsV16,
  ttsV16Summary,
  ttsV16Markdown,
  TTS_V16_SAMPLE_RATE_HZ,
  TTS_V16_DEFAULT_MAX_CHUNK_CHARS,
  TTS_V16_DEFAULT_CROSSFADE_MS,
  TTS_V16_DEFAULT_UNDERRUN_PAD_MS,
} from './ttsStreamV16';
export type {
  TtsStreamV16Options,
  TtsPlayItemV16,
  TtsStreamV16State,
  TtsStreamV16EventKind,
  TtsStreamV16Event,
  TtsStreamV16Sink,
  TtsStreamV16Stats,
} from './ttsStreamV16';

export {
  VoiceSessionV16,
  VoiceSessionManagerV16,
  createVoiceSessionV16,
  createVoiceSessionManagerV16,
  defaultVoiceSessionV16Options,
  voiceSessionV16Summary,
  voiceSessionV16Markdown,
} from './sessionV16';
export type {
  VoiceSessionV16Mode,
  VoiceSessionV16State,
  VoiceSessionV16EventKind,
  VoiceSessionV16Event,
  VoiceSessionV16Sink,
  VoiceSessionV16Options,
  VoiceSessionV16Turn,
  VoiceSessionV16Stats,
} from './sessionV16';
