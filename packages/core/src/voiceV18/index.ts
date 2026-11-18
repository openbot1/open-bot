/**
 * @open-bot/core/voiceV18 — voice realtime v18 (v1.19, Đội T5).
 *
 * Realtime v6 on top of voice v17: the same turn flow (VAD →
 * Smart Turn → reply → TTS, barge-in cuts mid-speech), plus the
 * layers a long call needs —
 * VAD v6 (adaptive thresholds that follow the room, false-trigger
 * guard that rejects coughs and claps, hangover, noise-burst veto),
 * noise suppression v18 (estimator + gate + Wiener suppressor
 * sitting *in front of* the VAD), barge-in v6 (early warning
 * before the cut, echo suppression window, full turn context at
 * cut time), TTS streaming v4 (long-sentence clause splitting,
 * priority queue with aging, flow control into the stream),
 * multi-voice profiles v3 (per-context tuning, switch policy +
 * cooldown + deferral, per-profile usage, switch history), the
 * realtime v3 session (explicit connection lifecycle, numbered
 * checkpoints, drop → reconnect → resume from the cut point,
 * resume tokens), and voice eval v18 (turn-taking latency,
 * barge-in precision/recall/F1, mock TTS quality, one aggregate
 * report). No network, no sound card, no key — every audio path
 * is mock / synthetic, every clock virtual.
 */
export {
  AdaptiveVadV18,
  createVadV18,
  defaultVadV18Options,
  validateVadV18Options,
  pcm16RmsV18,
  vadV18Summary,
  vadV18Markdown,
  VAD_V18_FRAME_MS,
  VAD_V18_FRAME_SAMPLES,
} from './vadV18';
export type {
  VadV18Options,
  VadV18FalseTrigger,
  VadV18EventKind,
  VadV18Event,
  VadV18EventSink,
  VadV18Stats,
} from './vadV18';

export {
  NoiseEstimatorV18,
  NoiseGateV18,
  NoiseSuppressorV18,
  NoiseChainV18,
  createNoiseChainV18,
  defaultNoiseEstimatorV18Options,
  validateNoiseEstimatorV18Options,
  defaultNoiseGateV18Options,
  validateNoiseGateV18Options,
  defaultNoiseSuppressorV18Options,
  validateNoiseSuppressorV18Options,
  noiseBandRmsV18,
  linearToDbV18,
  attenuateFrameV18,
  isNoiseSuppressionV18Level,
  noiseChainV18Summary,
  noiseChainV18Markdown,
  NOISE_SUPPRESSION_V18_LEVELS,
} from './noiseSuppressionV18';
export type {
  NoiseSuppressionV18Level,
  NoiseBandRmsV18,
  NoiseEstimatorV18Options,
  NoiseEstimatorV18Stats,
  NoiseGateV18Options,
  NoiseGateV18Stats,
  NoiseSuppressorV18Options,
  NoiseSuppressorV18Stats,
  NoiseChainV18Options,
  NoiseChainV18FrameResult,
  NoiseChainV18Stats,
} from './noiseSuppressionV18';

export {
  BargeInEngineV18,
  createBargeInEngineV18,
  defaultBargeInV18Options,
  validateBargeInV18Options,
  bargeInV18Summary,
  bargeInV18Markdown,
} from './bargeInV18';
export type {
  BargeInV18Burst,
  BargeInV18CutRecord,
  BargeInV18EventKind,
  BargeInV18Event,
  BargeInV18EventSink,
  BargeInV18Options,
  BargeInV18Stats,
} from './bargeInV18';

export {
  TtsStreamV18,
  createTtsStreamV18,
  defaultTtsStreamV18Options,
  validateTtsStreamV18Options,
  splitLongSentenceV18,
  downgradeQualityV18,
  ttsV18Summary,
  ttsV18Markdown,
  TTS_V18_DEFAULT_MAX_CHUNK_CHARS,
} from './ttsStreamV18';
export type {
  TtsV18Quality,
  TtsV18QueuedSentence,
  TtsStreamV18Options,
  TtsStreamV18Stats,
} from './ttsStreamV18';

export {
  VoiceProfileStoreV18,
  createVoiceProfileStoreV18,
  defaultVoiceProfileV18,
  defaultVoiceProfileV18Options,
  validateVoiceProfileV18,
  applyContextTuningV18,
  presetVoiceProfilesV18,
  isVoiceSwitchPolicyV18,
  voiceProfilesV18Summary,
  voiceProfilesV18Markdown,
  VOICE_SWITCH_POLICIES_V18,
} from './voiceProfilesV18';
export type {
  VoiceSwitchPolicyV18,
  VoiceContextTuningV18,
  VoiceProfileV18,
  VoiceSwitchRecordV18,
  VoiceProfileV18ResolveResult,
  VoiceProfileV18Options,
} from './voiceProfilesV18';

export {
  RealtimeSessionV18,
  RealtimeSessionManagerV18,
  createRealtimeSessionV18,
  createRealtimeSessionManagerV18,
  defaultRealtimeV18Options,
  syntheticFrameV18,
  realtimeV18Summary,
  realtimeV18Markdown,
} from './realtimeV18';
export type {
  RealtimeV18ConnectionState,
  VoiceSessionV18State,
  RealtimeV18EventKind,
  RealtimeV18Event,
  RealtimeV18Sink,
  RealtimeV18Checkpoint,
  RealtimeV18Turn,
  RealtimeV18Options,
  RealtimeV18Stats,
} from './realtimeV18';

export {
  VoiceEvalV18,
  createVoiceEvalV18,
  defaultVoiceEvalV18Options,
  validateVoiceEvalV18Options,
  defaultVoiceEvalV18Scenarios,
  runDefaultVoiceEvalV18,
  meanV18,
  percentileOfV18,
  voiceEvalV18Summary,
} from './voiceEvalV18';
export type {
  VoiceEvalV18TurnScenario,
  VoiceEvalV18BargeInScenario,
  VoiceEvalV18TtsScenario,
  VoiceEvalV18Options,
  VoiceEvalV18TurnResult,
  VoiceEvalV18BargeInResult,
  VoiceEvalV18TtsResult,
  VoiceEvalV18Report,
} from './voiceEvalV18';

export {
  TurnTakingMachineV18,
  createTurnTakingMachineV18,
  defaultTurnTakingV18Options,
  validateTurnTakingV18Options,
  detectTurnEndV18,
  decideOverlapV18,
  turnTakingV18Summary,
  turnTakingV18Markdown,
} from './turnTakingV18';
export type {
  TurnEndV18Reason,
  OverlapV18Decision,
  TurnTakingV18Options,
  TurnTakingV18EventKind,
  TurnTakingV18Event,
  TurnTakingV18EventSink,
  TurnTakingV18Stats,
} from './turnTakingV18';

export {
  VoiceBudgetMeterV18,
  createVoiceBudgetMeterV18,
  defaultVoiceBudgetV18Options,
  validateVoiceBudgetV18Options,
  estimateTtsTokensV18,
  estimateSttTokensV18,
  estimateTtsSecondsV18,
  voiceBudgetDayKeyV18,
  voiceBudgetV18Summary,
  voiceBudgetV18Markdown,
  VOICE_BUDGET_V18_TTS_CHARS_PER_TOKEN,
  VOICE_BUDGET_V18_STT_TOKENS_PER_SECOND,
  VOICE_BUDGET_V18_TTS_CHARS_PER_SECOND,
  VOICE_BUDGET_V18_METERS,
} from './voiceBudgetV18';
export type {
  VoiceBudgetV18MeterId,
  VoiceBudgetV18Level,
  VoiceBudgetV18Budgets,
  VoiceBudgetV18Options,
  VoiceBudgetV18MeterState,
  VoiceBudgetV18EventKind,
  VoiceBudgetV18Event,
  VoiceBudgetV18EventSink,
  VoiceBudgetV18SessionRecord,
  VoiceBudgetV18Stats,
} from './voiceBudgetV18';
