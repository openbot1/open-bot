/**
 * @open-bot/core/voiceV19 — voice realtime v19 (v1.27, Đội T5).
 *
 * NOTE ON NUMBERING: the wave brief asked for "voice realtime v24,
 * continuing v23", but the code on base merge/v126 tops out at
 * voice v18 — there is no v19–v24 in the tree. v19 is the correct
 * next number; the commit message says so too.
 *
 * On top of the v18 realtime session (VAD v6, noise chain,
 * barge-in v6, TTS streaming v4, profiles v3, checkpoints +
 * reconnect), v19 adds the three layers a long call needs next:
 * session management v5 (VoiceSessionManagerV19 — lifecycle,
 * duration limits + sweeper, UI snapshots + UI-sync events,
 * export/restore), prosody control (ProsodyControllerV19 —
 * emotion presets, per-utterance overrides, clause segmentation,
 * SSML rendering), voice eval v19 (naturalness + clarity mock
 * scores on top of the v18 latency/barge-in/TTS dimensions, with
 * a regression gate against a baseline report), and open-turn
 * resume (OpenTurnStoreV19 — partial transcript segments with
 * overlap-aware dedupe, interrupt → user confirmation → resume /
 * restart / summarise / drop). No network, no sound card, no key
 * — every audio path is mock / synthetic, every clock virtual.
 */
export {
  VoiceSessionManagerV19,
  createVoiceSessionManagerV19,
  defaultVoiceSessionV19Options,
  validateVoiceSessionV19Options,
  mapV18StateToV19,
  isVoiceSessionV19State,
  isVoiceSessionV19CloseReason,
  clampIntV19,
  VOICE_SESSION_V19_STATES,
  VOICE_SESSION_V19_CLOSE_REASONS,
} from './sessionV19';
export type {
  VoiceSessionV19State,
  VoiceSessionV19CloseReason,
  VoiceSessionV19Options,
  VoiceSessionV19UiEventKind,
  VoiceSessionV19UiEvent,
  VoiceSessionV19UiSink,
  VoiceSessionV19Record,
  VoiceSessionV19UiSnapshot,
  VoiceSessionV19SweepEntry,
  VoiceSessionV19SweepReport,
  VoiceSessionV19Stats,
  VoiceSessionV19Export,
} from './sessionV19';

export {
  ProsodyControllerV19,
  createProsodyControllerV19,
  defaultProsodyV19Settings,
  presetProsodyV19Settings,
  defaultEmotionForContextV19,
  validateProsodyV19Settings,
  clampProsodyV19Settings,
  applyProsodyV19Override,
  estimateProsodyV19Ms,
  splitProsodyV19Clauses,
  applyProsodyToTextV19,
  prosodySsmlV19,
  prosodyPlanStatsV19,
  isProsodyV19Emotion,
  isProsodyV19Emphasis,
  prosodyV19Summary,
  PROSODY_V19_EMOTIONS,
  PROSODY_V19_EMPHASES,
  PROSODY_V19_RATE_MIN,
  PROSODY_V19_RATE_MAX,
  PROSODY_V19_PITCH_MIN_ST,
  PROSODY_V19_PITCH_MAX_ST,
  PROSODY_V19_PAUSE_MIN_MS,
  PROSODY_V19_PAUSE_MAX_MS,
  PROSODY_V19_VOLUME_MIN_DB,
  PROSODY_V19_VOLUME_MAX_DB,
  PROSODY_V19_BASE_CHARS_PER_SECOND,
} from './prosodyV19';
export type {
  ProsodyV19Emotion,
  ProsodyV19Emphasis,
  ProsodyV19Settings,
  ProsodyV19Override,
  ProsodyV19Segment,
  ProsodyV19PlanStats,
  ProsodyV19ControllerOptions,
} from './prosodyV19';

export {
  OpenTurnStoreV19,
  createOpenTurnStoreV19,
  defaultTurnResumeV19Options,
  validateTurnResumeV19Options,
  textOverlapV19,
  mergeSegmentsV19,
  summariseSpokenV19,
  isTurnResumeV19State,
  isTurnResumeV19InterruptReason,
  isTurnResumeV19Action,
  TURN_RESUME_V19_STATES,
  TURN_RESUME_V19_INTERRUPT_REASONS,
  TURN_RESUME_V19_ACTIONS,
} from './turnResumeV19';
export type {
  TurnResumeV19Speaker,
  TurnResumeV19State,
  TurnResumeV19InterruptReason,
  TurnResumeV19Action,
  TurnResumeV19Segment,
  TurnResumeV19Turn,
  TurnResumeV19Confirmation,
  TurnResumeV19ResumePlan,
  TurnResumeV19StoreOptions,
  TurnResumeV19Stats,
} from './turnResumeV19';

export {
  VoiceEvalV19,
  createVoiceEvalV19,
  defaultVoiceEvalV19Options,
  validateVoiceEvalV19Options,
  defaultVoiceEvalV19Scenarios,
  runDefaultVoiceEvalV19,
  scoreNaturalnessV19,
  scoreClarityV19,
  meanV19,
  percentileOfV19,
  compareWithBaselineV19,
  voiceEvalV19Summary,
  voiceEvalV19Markdown,
} from './voiceEvalV19';
export type {
  VoiceEvalV19VoiceScenario,
  VoiceEvalV19TurnScenario,
  VoiceEvalV19BargeInScenario,
  VoiceEvalV19Options,
  VoiceEvalV19NaturalnessResult,
  VoiceEvalV19ClarityResult,
  VoiceEvalV19TurnResult,
  VoiceEvalV19BargeInResult,
  VoiceEvalV19TtsResult,
  VoiceEvalV19Dimension,
  VoiceEvalV19Report,
  VoiceEvalV19Regression,
} from './voiceEvalV19';
