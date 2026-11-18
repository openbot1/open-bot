/**
 * @open-bot/core/voiceV21 — voice realtime v21 (v1.34, Đội T5).
 *
 * Voice-driven tool calls inside a realtime session: speech →
 * transcript → intent → a real open-bot tool call (via the tool
 * registry) → the result spoken back. Side-effecting tools need
 * a spoken confirmation first, under a per-tool allow/deny
 * policy. Turn-taking state machine + barge-in (stop TTS, keep
 * the half-heard transcript), WER/latency voice eval over a
 * local sample set, a streaming TTS cache (hash text+voice,
 * chunked stream, TTL + capacity), and a realtime monitor panel
 * view-model. All clocks virtual, all audio mock/synthetic, no
 * network, no key, no mic/sound card.
 */
export {
  syntheticFrameV21,
  silentFrameV21,
  pcm16RmsV21,
  normaliseSpeechV21,
  speechWordsV21,
  clampV21,
  round2V21,
  round4V21,
  VOICE_V21_FRAME_MS,
  VOICE_V21_FRAME_SAMPLES,
  VOICE_V21_SAMPLE_RATE,
} from './types';
export type {
  VoiceV21Clock,
  VoiceV21TurnState,
  VoiceV21TurnRole,
  VoiceV21TurnRecord,
  VoiceV21Frame,
  VoiceV21TranscriptStatus,
  VoiceV21TranscriptSegment,
  VoiceV21ToolEffect,
  VoiceV21ToolDescriptor,
  VoiceV21Intent,
  VoiceV21ToolCallStatus,
  VoiceV21ToolCallRecord,
  VoiceV21LatencyStage,
  VoiceV21LatencySample,
  VoiceV21EventKind,
  VoiceV21Event,
  VoiceV21EventSink,
} from './types';
export {
  parseVoiceIntentV21,
  extractFreeTextV21,
  extractArgsV21,
  quotedTokensV21,
  isVoiceConfirmationV21,
  isVoiceRefusalV21,
  defaultVoiceToolDescriptorsV21,
  defaultIntentParserV21Options,
  validateIntentParserV21Options,
  intentV21Summary,
  VOICE_V21_CONFIRM_WORDS,
  VOICE_V21_REFUSE_WORDS,
} from './intentParserV21';
export type {
  VoiceV21IntentParserOptions,
  VoiceV21TriggerScore,
} from './intentParserV21';
export {
  VoiceToolCallEngineV21,
  createVoiceToolCallEngineV21,
  createMockVoiceToolExecutorV21,
  decideVoiceToolPolicyV21,
  defaultVoiceToolPolicyV21,
  validateVoiceToolPolicyV21,
  defaultVoiceToolCallEngineOptions,
  validateVoiceToolCallEngineOptions,
  speakableResultV21,
} from './voiceToolCallV21';
export type {
  VoiceV21PolicyDecision,
  VoiceV21ToolExecutor,
  VoiceV21ToolPolicy,
  VoiceV21ToolCallEngineOptions,
  VoiceV21ToolCallStats,
} from './voiceToolCallV21';
export {
  TurnTakingMachineV21,
  createTurnTakingMachineV21,
  defaultTurnTakingV21Options,
  validateTurnTakingV21Options,
} from './turnTakingV21';
export type {
  VoiceV21TurnEventKind,
  VoiceV21TurnTransition,
  VoiceV21OverlapRecord,
  VoiceV21TurnTakingOptions,
  VoiceV21TurnTakingStats,
} from './turnTakingV21';
export {
  BargeInEngineV21,
  PartialTranscriptKeeperV21,
  createBargeInEngineV21,
  scoreBargeInV21,
  decideBargeInV21,
  evaluateBargeInBurstV21,
  splitReplyAtCutV21,
  isBackchannelBurstV21,
  realWordsInBurstV21,
  defaultBargeInV21Options,
  validateBargeInV21Options,
  VOICE_V21_BACKCHANNEL_WORDS,
} from './bargeInV21';
export type {
  VoiceV21BargeInDecision,
  VoiceV21BargeInCandidate,
  VoiceV21BargeInScoreBreakdown,
  VoiceV21BargeInOptions,
  VoiceV21ReplyCut,
  VoiceV21PartialTranscript,
  VoiceV21BargeInRecord,
  VoiceV21BargeInStats,
} from './bargeInV21';
export {
  VoiceEvalV21,
  createVoiceEvalV21,
  scorePairV21,
  pairPassesV21,
  aggregateEvalV21,
  tokenizeEvalV21,
  evalCharsV21,
  pairScoreSummaryV21,
  evalReportMarkdownV21,
  defaultVoiceEvalV21Options,
  validateVoiceEvalV21Options,
  VOICE_V21_DEFAULT_STAGE_BUDGETS_MS,
  VOICE_V21_EVAL_SAMPLES,
} from './evalV21';
export type {
  VoiceV21AlignOp,
  VoiceV21AlignedWord,
  VoiceV21PairScore,
  VoiceV21EvalSample,
  VoiceV21EvalOptions,
  VoiceV21Confusion,
  VoiceV21StageLatency,
  VoiceV21EvalReport,
} from './evalV21';
export {
  TtsCacheV21,
  createTtsCacheV21,
  mockSynthesizerV21,
  fnv1aV21,
  ttsCacheKeyV21,
  splitTtsTextV21,
  estimateTtsDurationMsV21,
  defaultTtsCacheV21Options,
  validateTtsCacheV21Options,
} from './ttsCacheV21';
export type {
  VoiceV21TtsChunk,
  VoiceV21TtsSynthesizer,
  VoiceV21TtsCacheOptions,
  VoiceV21TtsCacheEntry,
  VoiceV21TtsCacheStats,
  VoiceV21TtsStreamResult,
} from './ttsCacheV21';
export {
  MonitorPanelV21,
  createMonitorPanelV21,
  cacheHitRateV21,
  defaultMonitorPanelV21Options,
  validateMonitorPanelV21Options,
  VOICE_V21_PANEL_I18N_KEYS,
} from './monitorPanelV21';
export type {
  VoiceV21PanelToolCallView,
  VoiceV21PanelLatencyView,
  VoiceV21PanelCacheView,
  VoiceV21PanelEvalView,
  VoiceV21MonitorSnapshot,
  VoiceV21MonitorPanelOptions,
} from './monitorPanelV21';
export {
  VoiceSessionV21,
  createVoiceSessionV21,
  VOICE_V21_SCRIPTED_REPLIES,
} from './sessionV21';
export type {
  VoiceV21ModelReply,
  VoiceV21SessionOptions,
  VoiceV21SessionStats,
} from './sessionV21';
