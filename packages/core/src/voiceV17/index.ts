/**
 * @open-bot/core/voiceV17 — voice realtime v17 (v1.18, Đội T5).
 *
 * Realtime v5 on top of voice v16: a complete speech-to-speech
 * path with the turn, not just the audio, owned end to end —
 * VAD v5 (speech / silence / noise, debounced, with segments and
 * noise bursts on top of the v11 probability detector), barge-in
 * v5 (immediate cut + resume policy: resume / restart / summarise
 * / drop, interruption classification, repeated-cut escalation),
 * TTS streaming v3 (sentence-by-sentence as the reply arrives,
 * priority chunk queue with urgent preemption, cancel-unplayed
 * for barge-in, first-chunk latency with average + p95),
 * turn-taking v5 (listening / thinking / speaking / interrupted /
 * idle / closed as an explicit event-driven machine with per-state
 * timeouts and stuck-state recovery), multi-voice profiles v2
 * (per-user + per-bot + per-context resolution with a fallback
 * chain, JSON persistence, built-in presets), and the v17 session
 * that wires them together. No network, no sound card, no key —
 * every audio path is mock / synthetic.
 */
export {
  VadV17,
  createVadV17,
  defaultVadV17Options,
  validateVadV17Options,
  vadV17FrameFeatures,
  classifyVadFrameV17,
  pcm16ToBytesV17,
  vadV17Summary,
  vadV17Markdown,
  VAD_V17_FRAME_MS,
  VAD_V17_FRAME_SAMPLES,
} from './vadV17';
export type {
  VadV17FrameClass,
  VadV17Options,
  VadV17FrameFeatures,
  VadV17Segment,
  VadV17EventKind,
  VadV17Event,
  VadV17EventSink,
  VadV17Stats,
} from './vadV17';

export {
  BargeInEngineV17,
  createBargeInEngineV17,
  defaultBargeInV17Options,
  validateBargeInV17Options,
  classifyInterruptionV17,
  decideBargeInResumeV17,
  bargeInV17Summary,
  bargeInV17Markdown,
} from './bargeInV17';
export type {
  BargeInV17ResumeAction,
  BargeInV17InterruptionKind,
  BargeInV17Options,
  BargeInV17ResumePlan,
  BargeInV17EventKind,
  BargeInV17Event,
  BargeInV17EventSink,
  BargeInV17Stats,
  BargeInV17CutRecord,
} from './bargeInV17';

export {
  TtsStreamV17,
  createTtsStreamV17,
  defaultTtsStreamV17Options,
  validateTtsStreamV17Options,
  splitSentencesV17,
  percentileV17,
  ttsV17Summary,
  ttsV17Markdown,
  TTS_V17_SAMPLE_RATE_HZ,
  TTS_V17_DEFAULT_MAX_CHUNK_CHARS,
} from './ttsStreamV17';
export type {
  TtsV17ChunkPriority,
  TtsStreamV17Options,
  TtsPlayItemV17,
  TtsStreamV17State,
  TtsStreamV17EventKind,
  TtsStreamV17Event,
  TtsStreamV17Sink,
  TtsStreamV17Stats,
} from './ttsStreamV17';

export {
  TurnTakingMachineV17,
  createTurnTakingMachineV17,
  defaultTurnTakingV17Options,
  validateTurnTakingV17Options,
  isTurnTakingV17Live,
  isTurnTakingV17UserTurn,
  isTurnTakingV17ModelSpeaking,
  turnTakingV17Summary,
  turnTakingV17Markdown,
  TURN_TAKING_V17_STATES,
  TURN_TAKING_V17_TRANSITIONS,
} from './turnTakingV17';
export type {
  TurnTakingV17State,
  TurnTakingV17EventKind,
  TurnTakingV17EventInput,
  TurnTakingV17Transition,
  TurnTakingV17MachineEvent,
  TurnTakingV17EventSink,
  TurnTakingV17TransitionResult,
  TurnTakingV17Options,
  TurnTakingV17Stats,
} from './turnTakingV17';

export {
  VoiceProfileStoreV17,
  createVoiceProfileStoreV17,
  defaultVoiceProfileV17,
  validateVoiceProfileV17,
  presetVoiceProfilesV17,
  isVoiceProfileV17Context,
  voiceProfilesV17Summary,
  voiceProfilesV17Markdown,
  VOICE_V17_CONTEXTS,
} from './voiceProfilesV17';
export type {
  VoiceProfileV17Context,
  VoiceProfileV17,
  VoiceProfileV17ResolveVia,
  VoiceProfileV17ResolveInput,
  VoiceProfileV17ResolveResult,
  VoiceProfileV17Stats,
} from './voiceProfilesV17';

export {
  VoiceSessionV17,
  VoiceSessionManagerV17,
  createVoiceSessionV17,
  createVoiceSessionManagerV17,
  defaultVoiceSessionV17Options,
  voiceSessionV17Summary,
  voiceSessionV17Markdown,
} from './sessionV17';
export type {
  VoiceSessionV17State,
  VoiceSessionV17EventKind,
  VoiceSessionV17Event,
  VoiceSessionV17Sink,
  VoiceSessionV17Options,
  VoiceSessionV17Turn,
  VoiceSessionV17Stats,
} from './sessionV17';
