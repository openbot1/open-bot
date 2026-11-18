/**
 * @open-bot/core/voiceV22 — voice realtime v22 (v1.35, Đội T5).
 *
 * Durable realtime voice sessions: a session that survives a
 * dropped transport, resumes from a checkpoint, keeps the
 * half-heard transcript and the cut reply, arbitrates the
 * floor between user and agent, and speaks in the voice
 * profile the user picked. All clocks virtual, all audio
 * mock/synthetic, no network, no key, no mic/sound card.
 *
 * v22 builds on v21 without touching it: v21 owns the
 * single-connection realtime loop (intent → tool call → TTS);
 * v22 owns durability around that loop — the journalled
 * store, the resume engine, the recovery loop, the voice
 * profiles, the two-depth barge-in with a resume queue, the
 * floor-arbitrating turn machine, and the durability monitor
 * panel.
 */
export {
  syntheticFrameV22,
  silentFrameV22,
  pcm16RmsV22,
  normaliseSpeechV22,
  speechWordsV22,
  clampV22,
  round2V22,
  round4V22,
  zeroCountersV22,
  resumeTokenV22,
  VOICE_V22_FRAME_MS,
  VOICE_V22_FRAME_SAMPLES,
  VOICE_V22_SAMPLE_RATE,
  VOICE_V22_CHECKPOINT_VERSION,
} from './types';
export type {
  VoiceV22Clock,
  VoiceV22DurabilityPhase,
  VoiceV22TurnState,
  VoiceV22TurnRole,
  VoiceV22FloorHolder,
  VoiceV22TurnRecord,
  VoiceV22Frame,
  VoiceV22TranscriptStatus,
  VoiceV22TranscriptSegment,
  VoiceV22BargeInDecision,
  VoiceV22ResumeDisposition,
  VoiceV22ReplyCut,
  VoiceV22JournalKind,
  VoiceV22JournalEntry,
  VoiceV22Checkpoint,
  VoiceV22SessionCounters,
  VoiceV22FailureKind,
  VoiceV22Failure,
  VoiceV22EventKind,
  VoiceV22Event,
  VoiceV22EventSink,
} from './types';
export {
  DurableSessionStoreV22,
  createDurableSessionStoreV22,
  checkpointChecksumV22,
  validateCheckpointV22,
  checkpointIsCorruptV22,
  defaultSessionStoreV22Options,
  validateSessionStoreV22Options,
  emptyCheckpointCountersV22,
} from './sessionStoreV22';
export type {
  VoiceV22StoreOptions,
  VoiceV22StoreSnapshot,
  VoiceV22StoreStats,
} from './sessionStoreV22';
export {
  ResumeEngineV22,
  createResumeEngineV22,
  parseResumeTokenV22,
  validateResumeTokenV22,
  findJournalGapsV22,
  mergeTranscriptSegmentV22,
  defaultResumeV22Options,
  validateResumeV22Options,
} from './resumeV22';
export type {
  VoiceV22ResumeOptions,
  VoiceV22ResumeOutcome,
  VoiceV22ResumeReport,
  VoiceV22RebuiltState,
  VoiceV22ResumeStats,
} from './resumeV22';
export {
  BargeInEngineV22,
  PartialTranscriptKeeperV22,
  createBargeInEngineV22,
  scoreBargeInV22,
  decideBargeInV22,
  evaluateBargeInBurstV22,
  splitReplyAtCutV22,
  isBackchannelBurstV22,
  realWordsInBurstV22,
  defaultBargeInV22Options,
  validateBargeInV22Options,
  VOICE_V22_BACKCHANNEL_WORDS,
} from './bargeInV22';
export type {
  VoiceV22BargeInCandidate,
  VoiceV22BargeInScoreBreakdown,
  VoiceV22BargeInOptions,
  VoiceV22QueuedReply,
  VoiceV22PartialTranscript,
  VoiceV22BargeInRecord,
  VoiceV22BargeInStats,
} from './bargeInV22';
export {
  TurnTakingMachineV22,
  createTurnTakingMachineV22,
  defaultTurnTakingV22Options,
  validateTurnTakingV22Options,
  floorPriorityRankV22,
} from './turnTakingV22';
export type {
  VoiceV22TurnEventKind,
  VoiceV22TurnTransition,
  VoiceV22OverlapRecord,
  VoiceV22FloorRequester,
  VoiceV22FloorPriority,
  VoiceV22FloorRequest,
  VoiceV22TurnTakingOptions,
  VoiceV22TurnTakingStats,
} from './turnTakingV22';
export {
  VoiceProfileRegistryV22,
  createVoiceProfileRegistryV22,
  builtinProfilesV22,
  clampProsodyV22,
  validateProfileV22,
  defaultVoiceProfilesV22Options,
  validateVoiceProfilesV22Options,
  profileCharsPerSecondV22,
  VOICE_V22_PROSODY_LIMITS,
} from './voiceProfilesV22';
export type {
  VoiceV22Prosody,
  VoiceV22Profile,
  VoiceV22ProfileOptions,
  VoiceV22SwitchTiming,
  VoiceV22PendingSwitch,
  VoiceV22ProfileStats,
} from './voiceProfilesV22';
export {
  RecoveryEngineV22,
  MockTransportV22,
  createRecoveryEngineV22,
  backoffDelayV22,
  isRecoverableFailureV22,
  makeFailureV22,
  defaultRecoveryV22Options,
  validateRecoveryV22Options,
  defaultMockTransportV22Options,
  VOICE_V22_UNRECOVERABLE_FAILURES,
} from './recoveryV22';
export type {
  VoiceV22RecoveryOptions,
  VoiceV22DegradationStep,
  VoiceV22Heartbeat,
  VoiceV22ReconnectAttempt,
  VoiceV22RecoveryStats,
  VoiceV22MockTransportOptions,
} from './recoveryV22';
export {
  MonitorPanelV22,
  createMonitorPanelV22,
  durabilityScoreV22,
  defaultMonitorPanelV22Options,
  validateMonitorPanelV22Options,
  VOICE_V22_PANEL_I18N_KEYS,
} from './monitorPanelV22';
export type {
  VoiceV22PanelDurabilityView,
  VoiceV22PanelRecoveryView,
  VoiceV22PanelQueuedReplyView,
  VoiceV22MonitorSnapshot,
  VoiceV22MonitorPanelOptions,
} from './monitorPanelV22';
export {
  VoiceSessionV22,
  createVoiceSessionV22,
  VOICE_V22_SCRIPTED_REPLIES,
} from './sessionV22';
export type {
  VoiceV22ModelReply,
  VoiceV22TtsChunk,
  VoiceV22SessionOptions,
  VoiceV22RealtimeSessionStats,
  VoiceV22DurabilityReport,
} from './sessionV22';
