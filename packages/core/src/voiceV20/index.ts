/**
 * @open-bot/core/voiceV20 — voice realtime v20 (v1.28, Đội T5;
 * extended in v1.29 by Đội T5 — session persistence/resume,
 * open-turn v8, transcript accuracy, prosody eval, extended
 * eval harness over an offline corpus).
 *
 * Realtime v4 — the "adaptive session fabric" on top of v18:
 * jitter-buffered frames, partial→final transcript reconciliation,
 * confidence-scored barge-in v7, prosody-aware TTS v5, mock
 * provider registry with failover, multi-session manager with
 * handoff, and long-session compaction. All clocks virtual,
 * all audio mock/synthetic, no network, no key.
 */
export {
  syntheticFrameV20,
  silentFrameV20,
  pcm16RmsV20,
  VOICE_V20_FRAME_MS,
  VOICE_V20_FRAME_SAMPLES,
  VOICE_V20_SAMPLE_RATE,
} from './types';
export type {
  VoiceV20Clock,
  VoiceV20Frame,
  VoiceV20TranscriptStatus,
  VoiceV20TranscriptSegment,
  VoiceV20TurnRole,
  VoiceV20TurnRecord,
  VoiceV20ProviderKind,
  VoiceV20ProviderHealth,
  VoiceV20EventKind,
  VoiceV20Event,
  VoiceV20EventSink,
} from './types';
export {
  AdaptiveVadV20,
  createVadV20,
  defaultVadV20Options,
  validateVadV20Options,
  vadV20BandRms,
  classifyVadFrameV20,
  vadV20Summary,
  vadV20Markdown,
} from './vadV20';
export type {
  VadV20Band,
  VadV20FrameClass,
  VadV20EventKind,
  VadV20Event,
  VadV20EventSink,
  VadV20Options,
  VadV20BandRms,
  VadV20Stats,
} from './vadV20';
export {
  JitterBufferV20,
  createJitterBufferV20,
  defaultJitterBufferV20Options,
  validateJitterBufferV20Options,
  jitterMsV20,
  isTooLateV20,
  jitterBufferV20Summary,
  jitterBufferV20Markdown,
} from './jitterBufferV20';
export type {
  JitterBufferV20Decision,
  JitterBufferV20Concealment,
  JitterBufferV20EventKind,
  JitterBufferV20Event,
  JitterBufferV20EventSink,
  JitterBufferV20Options,
  JitterBufferV20Stats,
  JitterBufferV20Release,
} from './jitterBufferV20';
export {
  TranscriptReconcilerV20,
  createTranscriptReconcilerV20,
  defaultTranscriptV20Options,
  validateTranscriptV20Options,
  countTranscriptWordsV20,
  transcriptStablePrefixWordsV20,
  isTranscriptExtensionV20,
  transcriptV20Summary,
  transcriptV20Markdown,
} from './transcriptV20';
export type {
  TranscriptV20EventKind,
  TranscriptV20Event,
  TranscriptV20EventSink,
  TranscriptV20Options,
  TranscriptV20Committed,
  TranscriptV20Stats,
  TranscriptV20LiveView,
} from './transcriptV20';
export {
  BargeInEngineV20,
  createBargeInEngineV20,
  defaultBargeInV20Options,
  validateBargeInV20Options,
  scoreBargeInV20,
  decideBargeInV20,
  splitReplyAtCutV20,
  bargeInV20Summary,
  bargeInV20Markdown,
} from './bargeInV20';
export type {
  BargeInV20Decision,
  BargeInV20ResumeMode,
  BargeInV20EventKind,
  BargeInV20Event,
  BargeInV20EventSink,
  BargeInV20Options,
  BargeInV20Candidate,
  BargeInV20CutRecord,
  BargeInV20Stats,
  BargeInV20ScoreBreakdown,
} from './bargeInV20';
export {
  ProsodyTtsV20,
  createProsodyTtsV20,
  defaultTtsV20Options,
  validateTtsV20Options,
  detectContourV20,
  splitSentencesV20,
  stripEmphasisMarkersV20,
  extractPausesV20,
  readNumbersAsWordsV20,
  expandAbbreviationsV20,
  planProsodyV20,
  estimateChunkMsV20,
  ttsProsodyV20Summary,
  ttsProsodyV20Markdown,
} from './ttsProsodyV20';
export type {
  TtsV20Contour,
  TtsV20Emphasis,
  TtsV20ChunkKind,
  TtsV20ProsodyPlan,
  TtsV20Chunk,
  TtsV20Options,
  TtsV20Stats,
} from './ttsProsodyV20';
export {
  MockProviderV20,
  createMockProviderV20,
  defaultMockProviderV20Config,
  validateMockProviderV20Config,
  ProviderRegistryV20,
  createProviderRegistryV20,
  defaultProviderRegistryV20Options,
  validateProviderRegistryV20Options,
  providerRegistryV20Summary,
  providerRegistryV20Markdown,
} from './providersV20';
export type {
  ProviderV20FailureMode,
  ProviderV20Capability,
  ProviderV20ScriptStep,
  MockProviderV20Config,
  ProviderV20CallResult,
  ProviderV20Stats,
  ProviderRegistryV20EventKind,
  ProviderRegistryV20Event,
  ProviderRegistryV20EventSink,
  ProviderRegistryV20Options,
  ProviderRegistryV20Stats,
} from './providersV20';
export {
  CircuitBreakerV20,
  ReconnectManagerV20,
  createReconnectManagerV20,
  defaultReconnectV20Options,
  validateReconnectV20Options,
  decideErrorActionV20,
  backoffDelayMsV20,
  errorKindFromFailureModeV20,
  makeVoiceV20Error,
  reconnectV20Summary,
  reconnectV20Markdown,
} from './reconnectV20';
export type {
  VoiceV20ErrorKind,
  VoiceV20ErrorAction,
  VoiceV20Error,
  ReconnectV20Options,
  CircuitBreakerV20State,
  CircuitBreakerV20Stats,
  ReconnectV20Phase,
  ReconnectV20Stats,
  ReconnectV20EventKind,
  ReconnectV20Event,
  ReconnectV20EventSink,
} from './reconnectV20';
export {
  VoiceEvalV20,
  createVoiceEvalV20,
  percentilesV20,
  scoreBargeInDecisionsV20,
  mockQualityV20,
  defaultVoiceEvalV20Options,
  validateVoiceEvalV20Options,
  voiceEvalV20Markdown,
} from './metricsV20';
export type {
  TurnLatencyV20Sample,
  BargeInV20LabelledEvent,
  SessionHealthV20Sample,
  PercentilesV20,
  BargeInV20Scores,
  MockQualityV20,
  VoiceEvalV20Options,
  VoiceEvalV20Report,
} from './metricsV20';
export {
  VoicePipelineV20,
  createVoicePipelineV20,
  defaultPipelineV20Options,
  validatePipelineV20Options,
  pipelineV20Markdown,
} from './pipelineV20';
export type {
  PipelineV20Phase,
  PipelineV20Options,
  PipelineV20Hooks,
  PipelineV20Stats,
  PipelineV20Snapshot,
} from './pipelineV20';
export {
  SessionManagerV20,
  createSessionManagerV20,
  defaultSessionV20Options,
  validateSessionV20Options,
  summariseTurnsV20,
  sessionManagerV20Markdown,
} from './sessionV20';
export type {
  SessionV20State,
  SessionV20Options,
  SessionV20Checkpoint,
  SessionV20Record,
  SessionV20Stats,
  SessionManagerV20EventKind,
  SessionManagerV20Event,
  SessionManagerV20EventSink,
} from './sessionV20';

// --- v1.29 (Đội T5): voice v20 extensions — durable session
// persistence, resume orchestration, open-turn v8, transcript
// accuracy, prosody eval, offline corpus, extended eval harness ---
export {
  SessionPersistenceStoreV20,
  createSessionPersistenceStoreV20,
  defaultSessionPersistenceV20Options,
  validateSessionPersistenceV20Options,
  isSafeSessionIdV20,
  stableStringifyV20,
  fnv1aV20,
  checkpointChecksumV20,
  sealCheckpointV20,
  parseCheckpointV20,
  payloadFromSnapshotV20,
  sessionPersistenceV20Markdown,
  SESSION_PERSISTENCE_V20_FORMAT,
  SESSION_PERSISTENCE_V20_MAX_BYTES_DEFAULT,
} from './sessionPersistenceV20';
export type {
  PersistedSessionV20Checkpoint,
  SessionPersistenceV20Options,
  CheckpointParseV20Result,
  SessionPersistenceV20Entry,
  SessionPersistenceV20Stats,
} from './sessionPersistenceV20';

export {
  ResumeOrchestratorV20,
  createResumeOrchestratorV20,
  defaultResumeV20Options,
  validateResumeV20Options,
  decideResumeV20,
  summariseRemainingV20,
  resumeV20Markdown,
} from './resumeV20';
export type {
  ResumeV20Action,
  ResumeV20Interrupt,
  ResumeV20Plan,
  ResumeV20Options,
  ResumeV20SessionState,
  ResumeV20Event,
  ResumeV20EventSink,
  ResumeV20Stats,
  ResumeV20DecisionInput,
} from './resumeV20';

export {
  OpenTurnEngineV20,
  createOpenTurnEngineV20,
  defaultSilenceV20Options,
  validateSilenceV20Options,
  classifySilenceV20,
  defaultBargeInScoreV20Options,
  validateBargeInScoreV20Options,
  isBackchannelV20,
  scoreOpenTurnBargeInV20,
  interruptSentenceV20,
  carryProsodyV20,
  arbitrateOverlapV20,
  openTurnV20Markdown,
  FILLER_WORDS_V20,
  CONTINUERS_V20,
  BACKCHANNEL_WORDS_V20,
} from './openTurnV20';
export type {
  SilenceV20Kind,
  SilenceV20Decision,
  SilenceV20Options,
  BargeInV20Verdict,
  BargeInV20Score,
  BargeInV20ScoreOptions,
  BargeInV20CandidateInput,
  SentenceCutV20,
  OverlapV20Decision,
  OverlapV20Input,
  OpenTurnV20Event,
  OpenTurnV20EventSink,
  OpenTurnV20Stats,
} from './openTurnV20';

export {
  scoreTranscriptV20,
  transcriptPassesV20,
  defaultTranscriptAccuracyV20Options,
  validateTranscriptAccuracyV20Options,
  tokenizeTranscriptV20,
  transcriptCharsV20,
  aggregateTranscriptAccuracyV20,
  transcriptAccuracyV20Summary,
  transcriptAccuracyV20Markdown,
} from './transcriptAccuracyV20';
export type {
  TranscriptV20AlignOp,
  TranscriptV20AlignedWord,
  TranscriptV20Accuracy,
  TranscriptV20AccuracyOptions,
  TranscriptV20Confusion,
  TranscriptV20Aggregate,
} from './transcriptAccuracyV20';

export {
  scoreProsodyV20,
  evalProsodyScriptV20,
  renderScriptReplyV20,
  expectedContourOfV20,
  defaultProsodyEvalV20Options,
  validateProsodyEvalV20Options,
  prosodyEvalV20Summary,
  prosodyEvalV20Markdown,
} from './prosodyEvalV20';
export type {
  ProsodyV20ExpectedSentence,
  ProsodyV20Script,
  ProsodyV20SentenceScore,
  ProsodyV20Report,
  ProsodyV20EvalOptions,
} from './prosodyEvalV20';

export {
  EVAL_CORPUS_V20_DIALOGUES,
  EVAL_CORPUS_V20_TRANSCRIPTS,
  EVAL_CORPUS_V20_PROSODY,
  EVAL_CORPUS_V20_TURNS,
  evalCorpusV20Counts,
  validateEvalCorpusV20,
  evalCorpusV20Summary,
} from './evalCorpusV20';
export type {
  EvalCorpusV20DialogueTurn,
  EvalCorpusV20Dialogue,
  EvalCorpusV20TranscriptPair,
  EvalCorpusV20TurnScenario,
  EvalCorpusV20Counts,
} from './evalCorpusV20';

export {
  EvalHarnessV20,
  createEvalHarnessV20,
  defaultEvalHarnessV20Options,
  validateEvalHarnessV20Options,
  runBargeInEvalV20,
  driveDialogueV20,
  compareWithBaselineV20,
  evalHarnessV20Summary,
  evalHarnessV20Markdown,
  EVAL_HARNESS_V20_BARGE_IN_CASES,
} from './evalHarnessV20';
export type {
  EvalHarnessV20Options,
  EvalHarnessV20TurnResult,
  EvalHarnessV20BargeInResult,
  EvalHarnessV20DialogueResult,
  EvalHarnessV20Report,
  EvalHarnessV20Regression,
  EvalHarnessV20BargeInCase,
  DialogueDriveV20Result,
} from './evalHarnessV20';
