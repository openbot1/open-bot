/**
 * @open-bot/core/voiceV23 — voice realtime v23 (v1.36, Đội T5).
 *
 * Evaluation, streaming, interruption, session management and
 * calibration on top of the durable v22 session: an expanded
 * eval corpus + harness with a v22 -> v23 baseline comparison,
 * a MOS-proxy estimator, an adaptive jitter buffer + frame
 * pacer, endpointing v2, an interruption policy v2 with a
 * ledger, a realtime session manager v2 (reconnect + resume
 * + handover), automatic calibration and per-device profiles,
 * and a monitor panel that shows all of it at a glance.
 *
 * All clocks virtual, all audio mock/synthetic, no network,
 * no key, no mic/sound card.
 */
export {
  clampV23,
  round2V23,
  round4V23,
  meanV23,
  percentileV23,
  levenshteinWordsV23,
  werV23,
  aggregateLatencyV23,
  VOICE_V23_FRAME_MS,
  VOICE_V23_FRAME_SAMPLES,
  VOICE_V23_SAMPLE_RATE,
} from './types';
export type {
  VoiceV23Clock,
  VoiceV23Locale,
  VoiceV23Condition,
  VoiceV23EvalPair,
  VoiceV23WerResult,
  VoiceV23LatencySample,
  VoiceV23LatencyAggregate,
  VoiceV23MosFeatures,
  VoiceV23MosGrade,
  VoiceV23MosResult,
  VoiceV23MosSample,
  VoiceV23Baseline,
  VoiceV23BaselineDelta,
  VoiceV23StreamFrame,
  VoiceV23EndpointState,
  VoiceV23Environment,
  VoiceV23DeviceKind,
  VoiceV23InterruptStrategy,
  VoiceV23ManagedPhase,
} from './types';
export {
  EVAL_CORPUS_V23_TRANSCRIPTS,
  EVAL_CORPUS_V23_LATENCY,
  EVAL_CORPUS_V23_MOS,
  EVAL_CORPUS_V23_INTERRUPTIONS,
  EVAL_CORPUS_V23_ENDPOINTS,
  evalCorpusV23Counts,
  validateEvalCorpusV23,
  evalCorpusV23Summary,
} from './evalCorpusV23';
export type { VoiceV23InterruptionCase, VoiceV23EndpointCase } from './evalCorpusV23';
export {
  mosProxyV23,
  mosGradeV23,
  mosProxyErrorV23,
  calibrateMosV23,
  mosProxyV23Summary,
  mosProxyV23Markdown,
  defaultMosV23Options,
  validateMosV23Options,
} from './mosProxyV23';
export type { VoiceV23MosOptions } from './mosProxyV23';
export {
  EvalHarnessV23,
  createEvalHarnessV23,
  runEvalPairV23,
  runTranscriptCorpusV23,
  runMosSuiteV23,
  compareWithBaselineV23,
  defaultEvalHarnessV23Options,
  validateEvalHarnessV23Options,
  evalHarnessV23Summary,
  evalHarnessV23Markdown,
} from './evalHarnessV23';
export type {
  EvalHarnessV23Options,
  VoiceV23PairResult,
  VoiceV23TranscriptReport,
  VoiceV23MosSuiteReport,
  VoiceV23InterruptionSuiteReport,
  VoiceV23EndpointSuiteReport,
  EvalHarnessV23Report,
} from './evalHarnessV23';
export {
  AdaptiveJitterBufferV23,
  FramePacerV23,
  recommendBufferTargetV23,
  traceJitterV23,
  defaultAdaptiveBufferV23Options,
  validateAdaptiveBufferV23Options,
} from './streamingV23';
export type {
  AdaptiveBufferV23Options,
  VoiceV23BufferStats,
  VoiceV23BufferAdaptation,
  VoiceV23PlayoutSlot,
} from './streamingV23';
export {
  EndpointingEngineV23,
  defaultEndpointingV23Options,
  validateEndpointingV23Options,
} from './endpointingV23';
export type {
  EndpointingV23Options,
  VoiceV23EndpointEventKind,
  VoiceV23EndpointEvent,
  VoiceV23EndpointStats,
} from './endpointingV23';
export {
  InterruptionPolicyV23,
  InterruptionLedgerV23,
  createInterruptionPolicyV23,
  rollbackForCutV23,
  strategyForCutV23,
  VOICE_V23_REPHRASE_WORDS,
  defaultInterruptionV23Options,
  validateInterruptionV23Options,
} from './interruptionV23';
export type {
  InterruptionV23Options,
  VoiceV23InterruptionCandidate,
  VoiceV23InterruptionDecision,
  VoiceV23Rollback,
  VoiceV23InterruptionRecord,
  VoiceV23InterruptionStats,
} from './interruptionV23';
export {
  RealtimeSessionManagerV23,
  createRealtimeSessionManagerV23,
  rekeySnapshotV23,
  defaultSessionManagerV23Options,
  validateSessionManagerV23Options,
} from './sessionManagerV23';
export type {
  SessionManagerV23Options,
  VoiceV23ReconnectAttempt,
  VoiceV23ManagedSession,
  VoiceV23SessionManagerStats,
} from './sessionManagerV23';
export {
  CalibrationEngineV23,
  createCalibrationEngineV23,
  classifyEnvironmentV23,
  snrDbV23,
  calibrationV23Summary,
  defaultCalibrationV23Options,
  validateCalibrationV23Options,
  VOICE_V23_ENVIRONMENT_FLOORS,
} from './calibrationV23';
export type {
  CalibrationV23Options,
  VoiceV23CalibrationInput,
  VoiceV23CalibrationResult,
} from './calibrationV23';
export {
  DeviceProfileRegistryV23,
  createDeviceProfileRegistryV23,
  builtinDeviceProfilesV23,
  clampDeviceProfileV23,
  validateDeviceProfileV23,
} from './deviceProfilesV23';
export type {
  VoiceV23DeviceProfile,
  VoiceV23DeviceFingerprint,
  VoiceV23DeviceProfileStats,
} from './deviceProfilesV23';
export {
  MonitorPanelV23,
  createMonitorPanelV23,
  defaultMonitorPanelV23Options,
  validateMonitorPanelV23Options,
  VOICE_V23_PANEL_I18N_KEYS,
} from './monitorPanelV23';
export type { VoiceV23MonitorPanelOptions, VoiceV23MonitorSnapshot } from './monitorPanelV23';
export {
  RealtimeLoopV23,
  createRealtimeLoopV23,
} from './realtimeLoopV23';
export type {
  RealtimeLoopV23Options,
  VoiceV23LoopTurn,
  VoiceV23LoopInterruption,
  VoiceV23LoopStats,
} from './realtimeLoopV23';
export {
  QualityReportV23,
  createQualityReportV23,
  scoreQualityV23,
  qualityGradeV23,
  werSubscoreV23,
  latencySubscoreV23,
  mosSubscoreV23,
  streamingSubscoreV23,
  interruptionSubscoreV23,
  calibrationSubscoreV23,
  qualityV23Summary,
  defaultQualityV23Options,
  validateQualityV23Options,
} from './qualityReportV23';
export type {
  VoiceV23QualityOptions,
  VoiceV23QualityGrade,
  VoiceV23QualitySubscores,
  VoiceV23QualityScore,
  VoiceV23QualityInputs,
} from './qualityReportV23';
export {
  QualityTrendV23,
  createQualityTrendV23,
  trendSlopePerMinuteV23,
  qualityTrendV23,
  meanSubscoresV23,
  worstSubscoreV23,
  qualityTrendV23Summary,
  defaultQualityTrendV23Options,
  validateQualityTrendV23Options,
} from './qualityTrendV23';
export type {
  VoiceV23QualityPoint,
  QualityTrendV23Options,
  VoiceV23QualityTrend,
} from './qualityTrendV23';
