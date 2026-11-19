/**
 * Shared types for voice full-duplex v29 (v1.42, Team T4).
 *
 * v29 is the full-duplex generation after v28. v28 owns the
 * mock realtime transport, the VAD hook, the realtime session,
 * memory-block voice style, voice command routing, transcript
 * and multi-voice casting. v29 owns the things that make that
 * session feel like a real two-way conversation instead of a
 * walkie-talkie:
 *
 *   - an audio turn detector: VAD-driven turn boundaries with
 *     backchannel filtering (short "mm-hmm" bursts are not
 *     turns), adaptive thresholds and turn history;
 *   - barge-in: the user interrupting the agent mid-sentence.
 *     Responses are server-driven — only the server creates or
 *     cancels a response; the client can only *request* an
 *     interruption and the engine decides (sustained speech,
 *     grace window, adaptive sensitivity);
 *   - append-only context: the conversation log only ever
 *     grows. Nothing is edited or deleted in place; compaction
 *     appends a summary item and marks older items superseded
 *     (the originals stay, for provenance and time-travel);
 *   - delegated tool calls: a voice turn never blocks on a
 *     tool. Calls are handed to a separate text model
 *     (async function calling by default), run with a timeout
 *     and retry budget, and their results flow back into the
 *     append-only context when ready;
 *   - proactive audio: the agent may speak first — a greeting
 *     on join, an idle nudge, a scheduled reminder — gated by
 *     consent, cooldowns and quiet hours, never while the user
 *     is speaking;
 *   - a cascaded STT -> LLM -> TTS pipeline with a measured
 *     latency budget per stage (target < 800 ms end to end)
 *     plus a direct speech-to-speech path (~300 ms target);
 *   - per-minute cost accounting: every session is metered
 *     against a configurable per-model rate table, with caps
 *     and alerts.
 *
 * Ideas only, learned from the v1.42 survey
 * (docs/repo-survey-v142.md §4): OpenAI gpt-realtime-2.1 /
 * GPT-Live full-duplex (server-driven, barge-in decided by
 * the server, append-only context, tool calls delegated to
 * a separate Responses model), Gemini 3.8 Live (async
 * function calling by default, proactive audio), LiveKit
 * Agents 1.0 (audio turn detector, adaptive interruption).
 * No code, text or assets from any of those projects are
 * used here; the design, the numbers and the code are ours.
 *
 * All clocks virtual (the caller passes `atMs`); all audio
 * is mock/synthetic frame energy; no provider is ever
 * dialled, no key is read or stored, no live API is called.
 * v28 is reused only by import (its transport class) and is
 * never modified by v29.
 */

/** The three voice architectures (survey §4). */
export type VoiceV29Architecture = 'cascaded' | 'turn-based-realtime' | 'full-duplex';

/** Realtime model ids v29 knows about (metadata/config only). */
export type VoiceV29ModelId =
  | 'gpt-realtime-2.1'
  | 'gpt-realtime-2.1-mini'
  | 'gpt-live'
  | 'gemini-3.8-live'
  | 'livekit-agents-1.0'
  | 'mock-cascaded';

/** Lifecycle of a full-duplex v29 session. */
export type VoiceV29SessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'ended';

/** Who holds the conversation floor right now. */
export type VoiceV29FloorHolder = 'none' | 'user' | 'agent';

/** Why a turn ended. */
export type VoiceV29TurnEndReason =
  | 'silence'
  | 'barge-in'
  | 'keyword'
  | 'timeout'
  | 'max-duration'
  | 'explicit'
  | 'abandoned';

/** Why a server response ended. */
export type VoiceV29ResponseEndReason =
  | 'completed'
  | 'cancelled-barge-in'
  | 'cancelled-server'
  | 'cancelled-user-request'
  | 'error'
  | 'timeout';

/** State of one server-driven response. */
export type VoiceV29ResponseState = 'active' | 'completed' | 'cancelled';

/** Who asked for an interruption (a request is not a decision). */
export type VoiceV29InterruptRequester = 'user-speech' | 'user-button' | 'server' | 'system';

/** Verdict of the barge-in engine on an interruption request. */
export type VoiceV29InterruptVerdict = 'interrupt' | 'ignore-grace' | 'ignore-too-short' | 'ignore-backchannel' | 'ignore-no-response' | 'ignore-disabled';

/** Kind of an append-only context item. */
export type VoiceV29ContextItemKind =
  | 'user-turn'
  | 'agent-turn'
  | 'tool-call'
  | 'tool-result'
  | 'system-note'
  | 'summary'
  | 'proactive'
  | 'supersede-marker';

/** Lifecycle of a delegated (async) tool call. */
export type VoiceV29DelegatedCallState =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'done'
  | 'failed'
  | 'timed-out'
  | 'rejected';

/** How a delegated call is executed. */
export type VoiceV29DelegatedCallMode = 'async' | 'sync';

/** Kind of proactive audio trigger. */
export type VoiceV29ProactiveKind =
  | 'greeting'
  | 'idle-nudge'
  | 'scheduled-reminder'
  | 'event-announcement'
  | 'follow-up';

/** Pipeline stage of the cascaded path. */
export type VoiceV29PipelineStage = 'stt' | 'llm' | 'tts' | 's2s-direct';

/** Pipeline mode for one turn. */
export type VoiceV29PipelineMode = 'cascaded' | 'speech-to-speech';

/** Cost alert severity. */
export type VoiceV29CostAlertLevel = 'info' | 'warning' | 'cap-reached';

/** One per-minute rate entry (configurable default, USD). */
export interface VoiceV29RateEntry {
  /** Model id this rate applies to. */
  modelId: VoiceV29ModelId;
  /** USD per minute of session time (audio in + out). */
  usdPerMinute: number;
  /** USD per minute of audio input only (null = same as usdPerMinute). */
  usdPerMinuteInput: number | null;
  /** USD per minute of audio output only (null = same as usdPerMinute). */
  usdPerMinuteOutput: number | null;
  /** Where the number came from (survey note, vendor page, override). */
  source: string;
  /** True when the rate is a local override, not a survey default. */
  overridden: boolean;
}

/**
 * Default per-minute rate table (USD). These are *config*
 * defaults for local cost accounting, not live quotes: the
 * GPT-Live figure ($0.05/min) comes from the v1.42 survey;
 * the others are planning defaults the host is expected to
 * override with its own contract rates via
 * `overrideRateV29`. Nothing here dials a provider.
 */
export const VOICE_V29_RATE_TABLE_DEFAULT: readonly VoiceV29RateEntry[] = [
  { modelId: 'gpt-live', usdPerMinute: 0.05, usdPerMinuteInput: null, usdPerMinuteOutput: null, source: 'survey v1.42 §4: GPT-Live GA $0.05/min', overridden: false },
  { modelId: 'gpt-realtime-2.1', usdPerMinute: 0.08, usdPerMinuteInput: 0.04, usdPerMinuteOutput: 0.12, source: 'survey v1.42 §4: planning default — override with contract rate', overridden: false },
  { modelId: 'gpt-realtime-2.1-mini', usdPerMinute: 0.03, usdPerMinuteInput: 0.015, usdPerMinuteOutput: 0.045, source: 'survey v1.42 §4: planning default — override with contract rate', overridden: false },
  { modelId: 'gemini-3.8-live', usdPerMinute: 0.05, usdPerMinuteInput: null, usdPerMinuteOutput: null, source: 'survey v1.42 §4: planning default — override with contract rate', overridden: false },
  { modelId: 'livekit-agents-1.0', usdPerMinute: 0, usdPerMinuteInput: null, usdPerMinuteOutput: null, source: 'survey v1.42 §4: self-hosted — infra cost is billed separately', overridden: false },
  { modelId: 'mock-cascaded', usdPerMinute: 0, usdPerMinuteInput: null, usdPerMinuteOutput: null, source: 'local mock — no provider cost', overridden: false },
];

/** Model metadata v29 carries for routing / display (no live calls). */
export interface VoiceV29ModelInfo {
  modelId: VoiceV29ModelId;
  displayName: string;
  architecture: VoiceV29Architecture;
  /** Context window in tokens (survey figures). */
  contextTokens: number;
  /** Max output tokens per response (survey figures). */
  maxOutputTokens: number;
  /** True when the model decides barge-in itself (server-driven). */
  serverDrivenBargeIn: boolean;
  /** True when tool calls are delegated to a separate text model. */
  delegatesToolCalls: boolean;
  /** True when async function calling is the default. */
  asyncFunctionCallingDefault: boolean;
  /** True when proactive audio is available. */
  proactiveAudio: boolean;
}

export const VOICE_V29_MODEL_CATALOG: readonly VoiceV29ModelInfo[] = [
  { modelId: 'gpt-realtime-2.1', displayName: 'GPT Realtime 2.1', architecture: 'turn-based-realtime', contextTokens: 128000, maxOutputTokens: 32000, serverDrivenBargeIn: false, delegatesToolCalls: false, asyncFunctionCallingDefault: false, proactiveAudio: false },
  { modelId: 'gpt-realtime-2.1-mini', displayName: 'GPT Realtime 2.1 mini', architecture: 'turn-based-realtime', contextTokens: 128000, maxOutputTokens: 32000, serverDrivenBargeIn: false, delegatesToolCalls: false, asyncFunctionCallingDefault: false, proactiveAudio: false },
  { modelId: 'gpt-live', displayName: 'GPT-Live (full-duplex)', architecture: 'full-duplex', contextTokens: 128000, maxOutputTokens: 32000, serverDrivenBargeIn: true, delegatesToolCalls: true, asyncFunctionCallingDefault: false, proactiveAudio: false },
  { modelId: 'gemini-3.8-live', displayName: 'Gemini 3.8 Live', architecture: 'full-duplex', contextTokens: 131000, maxOutputTokens: 32000, serverDrivenBargeIn: true, delegatesToolCalls: true, asyncFunctionCallingDefault: true, proactiveAudio: true },
  { modelId: 'livekit-agents-1.0', displayName: 'LiveKit Agents 1.0', architecture: 'full-duplex', contextTokens: 0, maxOutputTokens: 0, serverDrivenBargeIn: true, delegatesToolCalls: false, asyncFunctionCallingDefault: false, proactiveAudio: false },
  { modelId: 'mock-cascaded', displayName: 'Mock cascaded (local)', architecture: 'cascaded', contextTokens: 0, maxOutputTokens: 0, serverDrivenBargeIn: false, delegatesToolCalls: true, asyncFunctionCallingDefault: true, proactiveAudio: true },
];

/** Look a model up in the catalog (null when unknown). */
export function modelInfoV29(modelId: string): VoiceV29ModelInfo | null {
  return VOICE_V29_MODEL_CATALOG.find((m) => m.modelId === modelId) ?? null;
}

/** Look a rate up in a table (null when the model has no entry). */
export function rateForModelV29(
  table: readonly VoiceV29RateEntry[],
  modelId: VoiceV29ModelId,
): VoiceV29RateEntry | null {
  return table.find((r) => r.modelId === modelId) ?? null;
}

/** Cost of `minutes` at `rate` USD/min, rounded to 4 decimals. */
export function costForMinutesV29(minutes: number, usdPerMinute: number): number {
  if (!Number.isFinite(minutes) || !Number.isFinite(usdPerMinute) || minutes <= 0 || usdPerMinute <= 0) return 0;
  return round4V29(minutes * usdPerMinute);
}

/** Cost of a session slice: input minutes + output minutes at split rates. */
export function costForSliceV29(
  inputMinutes: number,
  outputMinutes: number,
  entry: VoiceV29RateEntry,
): number {
  const inRate = entry.usdPerMinuteInput ?? entry.usdPerMinute;
  const outRate = entry.usdPerMinuteOutput ?? entry.usdPerMinute;
  return round4V29(costForMinutesV29(inputMinutes, inRate) + costForMinutesV29(outputMinutes, outRate));
}

/** One audio frame fed to the turn detector / barge-in engine. */
export interface VoiceV29AudioFrame {
  atMs: number;
  /** Normalised frame energy 0..1. */
  energy: number;
  /** Optional caller-supplied VAD verdict for this frame. */
  isSpeech?: boolean;
  /** Optional transcript fragment (keyword end detection). */
  text?: string | null;
}

/** Tunables for the audio turn detector. */
export interface VoiceV29TurnDetectorConfig {
  /** Energy above this counts as speech (0..1). */
  threshold: number;
  /** ms of silence after speech before the turn ends. */
  silenceTimeoutMs: number;
  /** Extra ms of speech kept after the level drops. */
  hangoverMs: number;
  /** Speech shorter than this is treated as noise (ms). */
  minSpeechMs: number;
  /** Bursts at most this long + this quiet are backchannels, not turns (ms). */
  backchannelMaxMs: number;
  /** Energy below this is a backchannel even if it is speech (0..1). */
  backchannelMaxEnergy: number;
  /** Learned background level, 0..1 (adaptive when enabled). */
  noiseFloor: number;
  /** Learn the noise floor from observed silence frames. */
  adaptive: boolean;
  /** Max turn length before a forced end (ms, 0 = unlimited). */
  maxTurnMs: number;
  /** Keyword that ends a turn immediately (null = none). */
  endKeyword: string | null;
}

export const VOICE_V29_TURN_THRESHOLD_DEFAULT = 0.18;
export const VOICE_V29_TURN_SILENCE_TIMEOUT_DEFAULT_MS = 700;
export const VOICE_V29_TURN_HANGOVER_DEFAULT_MS = 120;
export const VOICE_V29_TURN_MIN_SPEECH_DEFAULT_MS = 200;
export const VOICE_V29_TURN_BACKCHANNEL_MAX_DEFAULT_MS = 600;
export const VOICE_V29_TURN_BACKCHANNEL_MAX_ENERGY_DEFAULT = 0.35;
export const VOICE_V29_TURN_NOISE_FLOOR_DEFAULT = 0.05;
export const VOICE_V29_TURN_NOISE_FLOOR_LEARN_RATE = 0.08;
export const VOICE_V29_TURN_MAX_DEFAULT_MS = 120_000;
export const VOICE_V29_TURN_FRAME_MS_DEFAULT = 50;

/** What the turn detector classified one frame as. */
export type VoiceV29TurnFrameKind = 'speech' | 'silence' | 'noise' | 'backchannel';

/** Result of feeding one frame to the turn detector. */
export interface VoiceV29TurnFrameResult {
  kind: VoiceV29TurnFrameKind;
  threshold: number;
  noiseFloor: number;
  speechMs: number;
  silenceMs: number;
  turnStarted: boolean;
  turnEnded: boolean;
  endReason: VoiceV29TurnEndReason | null;
  backchannel: boolean;
  noiseRejected: boolean;
}

/** One completed user turn found by the detector. */
export interface VoiceV29Turn {
  id: string;
  index: number;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  peakEnergy: number;
  frames: number;
  endReason: VoiceV29TurnEndReason;
  /** True when the turn was only a backchannel burst. */
  backchannel: boolean;
  /** Transcript fragment attached to the turn ('' when none). */
  text: string;
}

/** Barge-in policy tunables. */
export interface VoiceV29BargeInConfig {
  /** Master switch: false = the user can never interrupt. */
  enabled: boolean;
  /** Ignore user bursts this soon after the agent starts speaking (ms). */
  graceMs: number;
  /** Minimum sustained user speech to count as an interruption (ms). */
  minSpeechMs: number;
  /** Minimum user energy to count as an interruption (0..1). */
  minEnergy: number;
  /** Sensitivity 0..1: higher = easier to interrupt (adaptive baseline). */
  sensitivity: number;
  /** True when sensitivity adapts to the user's interruption history. */
  adaptive: boolean;
  /** How much one successful interruption raises sensitivity (0..0.2). */
  adaptStep: number;
  /** How much one ignored burst lowers sensitivity (0..0.2). */
  adaptDownStep: number;
  /** True when a button / explicit request always interrupts (bypasses grace). */
  explicitAlwaysInterrupts: boolean;
}

/** One server-driven response (only the server creates/cancels it). */
export interface VoiceV29ServerResponse {
  id: string;
  sessionId: string;
  createdAtMs: number;
  /** Full reply text the server committed to. */
  text: string;
  /** How much of the text was actually spoken before it ended. */
  spokenText: string;
  /** Unspoken remainder ('' when fully spoken). */
  remainingText: string;
  state: VoiceV29ResponseState;
  endedAtMs: number | null;
  endReason: VoiceV29ResponseEndReason | null;
  /** Turn index this response belongs to. */
  turnIndex: number;
}

/** Result of asking the barge-in engine about an interruption. */
export interface VoiceV29InterruptDecision {
  atMs: number;
  requester: VoiceV29InterruptRequester;
  verdict: VoiceV29InterruptVerdict;
  /** Response that was interrupted (null when none was active). */
  responseId: string | null;
  /** Unspoken remainder kept for a possible resume ('' when none). */
  remainingText: string;
  /** Confidence 0..1 that the user really meant to interrupt. */
  confidence: number;
  /** Sensitivity in force at decision time. */
  sensitivity: number;
  reason: string;
}

/** One barge-in event (audit log). */
export interface VoiceV29BargeInEvent {
  atMs: number;
  kind: 'requested' | 'interrupted' | 'ignored' | 'resumed' | 'discarded';
  responseId: string | null;
  verdict: VoiceV29InterruptVerdict | null;
  detail: string;
}

/** One append-only context item. */
export interface VoiceV29ContextItem {
  /** Monotonic sequence number (never reused). */
  seq: number;
  kind: VoiceV29ContextItemKind;
  atMs: number;
  /** Who produced the item. */
  speaker: 'user' | 'agent' | 'system' | 'tool';
  text: string;
  /** Rough token estimate (4 chars/token, mock). */
  tokens: number;
  /** Turn index the item belongs to (-1 = session-level). */
  turnIndex: number;
  /** True when a later summary superseded this item (original kept). */
  superseded: boolean;
  /** seq of the summary that superseded this item (null = live). */
  supersededBySeq: number | null;
  /** Free-form metadata (tool name, model id, ...). */
  meta: Record<string, string>;
}

/** One delegated (async) tool call. */
export interface VoiceV29DelegatedCall {
  id: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  mode: VoiceV29DelegatedCallMode;
  state: VoiceV29DelegatedCallState;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  /** Attempts used (1 = first try). */
  attempts: number;
  /** Max attempts allowed. */
  maxAttempts: number;
  /** Timeout per attempt (ms). */
  timeoutMs: number;
  /** Result JSON (null until done). */
  result: string | null;
  /** Error message (null when no error). */
  error: string | null;
  /** True when the call needs a human yes/no first. */
  needsApproval: boolean;
  /** Turn index that requested the call. */
  turnIndex: number;
}

/** A tool the delegated runner may call (mock executor). */
export interface VoiceV29DelegatedToolDef {
  name: string;
  description: string;
  /** True when the tool needs human approval before running. */
  sensitive: boolean;
  /** Mock executor: receives args, returns a JSON string. */
  execute: (args: Record<string, unknown>) => string | Promise<string>;
}

/** One proactive audio trigger. */
export interface VoiceV29ProactiveTrigger {
  id: string;
  kind: VoiceV29ProactiveKind;
  /** Text to speak when the trigger fires. */
  text: string;
  /** When the trigger becomes due (ms, virtual clock). */
  dueAtMs: number;
  /** Priority: higher fires first when several are due. */
  priority: number;
  /** Cooldown after firing before the same kind may fire again (ms). */
  cooldownMs: number;
  /** True when the trigger already fired (one-shot). */
  fired: boolean;
  firedAtMs: number | null;
  /** True when the trigger repeats after firing (reschedules). */
  repeat: boolean;
  /** Reschedule gap for repeating triggers (ms). */
  repeatMs: number;
  createdAtMs: number;
}

/** Per-stage latency budget for the cascaded pipeline. */
export interface VoiceV29StageBudget {
  stage: VoiceV29PipelineStage;
  /** Budget for one turn through this stage (ms). */
  budgetMs: number;
  /** Measured durations for this stage (ms, most recent last). */
  samples: number[];
}

/** One measured pipeline turn. */
export interface VoiceV29PipelineTurn {
  id: string;
  mode: VoiceV29PipelineMode;
  startedAtMs: number;
  endedAtMs: number;
  /** Measured ms per stage (missing stage = not run). */
  stageMs: Partial<Record<VoiceV29PipelineStage, number>>;
  /** Total end-to-end ms. */
  totalMs: number;
  /** True when the total stayed inside the budget. */
  withinBudget: boolean;
  /** Stages that blew their budget. */
  overBudgetStages: VoiceV29PipelineStage[];
  /** True when degraded mode was active for this turn. */
  degraded: boolean;
  inputText: string;
  outputText: string;
}

/** One cost ledger entry (one metered slice of a session). */
export interface VoiceV29CostEntry {
  sessionId: string;
  modelId: VoiceV29ModelId;
  startedAtMs: number;
  endedAtMs: number;
  /** Billable minutes of audio in (user speaking). */
  inputMinutes: number;
  /** Billable minutes of audio out (agent speaking). */
  outputMinutes: number;
  usd: number;
}

/** One cost alert fired by the ledger. */
export interface VoiceV29CostAlert {
  atMs: number;
  sessionId: string;
  level: VoiceV29CostAlertLevel;
  message: string;
  usdSoFar: number;
}

/** One proactive event (audit log). */
export interface VoiceV29ProactiveEvent {
  atMs: number;
  kind: 'scheduled' | 'fired' | 'suppressed-speaking' | 'suppressed-cooldown' | 'suppressed-consent' | 'suppressed-quiet-hours' | 'cancelled';
  triggerId: string;
  detail: string;
}

/** One event in a full-duplex session log. */
export interface VoiceV29SessionLogEvent {
  atMs: number;
  kind:
    | 'start'
    | 'connect'
    | 'listen'
    | 'think'
    | 'speak'
    | 'user-turn-start'
    | 'user-turn-end'
    | 'server-response-start'
    | 'server-response-done'
    | 'barge-in-request'
    | 'barge-in'
    | 'barge-in-ignored'
    | 'response-resume'
    | 'tool-delegated'
    | 'tool-result'
    | 'proactive'
    | 'pipeline'
    | 'cost-alert'
    | 'pause'
    | 'resume'
    | 'stop';
  detail: string;
}

/** Plain-JSON snapshot of a whole v29 session. */
export interface VoiceV29SessionSnapshot {
  sessionId: string;
  botId: string | null;
  modelId: VoiceV29ModelId;
  architecture: VoiceV29Architecture;
  state: VoiceV29SessionState;
  floor: VoiceV29FloorHolder;
  turnIndex: number;
  turns: number;
  backchannels: number;
  interruptions: number;
  ignoredInterruptions: number;
  activeResponseId: string | null;
  activeResponseRemainingChars: number;
  contextItems: number;
  contextTokens: number;
  delegatedCalls: number;
  delegatedDone: number;
  delegatedFailed: number;
  proactiveFired: number;
  pipelineTurns: number;
  pipelineP95Ms: number;
  pipelineWithinBudgetPct: number;
  costUsd: number;
  minutesBilled: number;
  startedAtMs: number | null;
  updatedAtMs: number;
  endedAtMs: number | null;
  events: number;
}

/** Allowed state transitions for the full-duplex session machine. */
export const VOICE_V29_STATE_TRANSITIONS: Record<
  VoiceV29SessionState,
  readonly VoiceV29SessionState[]
> = {
  idle: ['connecting', 'ended'],
  connecting: ['listening', 'ended'],
  listening: ['thinking', 'speaking', 'paused', 'ended'],
  thinking: ['speaking', 'listening', 'paused', 'ended'],
  speaking: ['listening', 'thinking', 'paused', 'ended'],
  paused: ['listening', 'speaking', 'ended'],
  ended: [],
};

/** Latency budget targets (ms) — survey §4: cascaded 500–800, s2s ~300. */
export const VOICE_V29_CASCADED_BUDGET_TOTAL_MS = 800;
export const VOICE_V29_CASCADED_BUDGET_STT_MS = 250;
export const VOICE_V29_CASCADED_BUDGET_LLM_MS = 350;
export const VOICE_V29_CASCADED_BUDGET_TTS_MS = 200;
export const VOICE_V29_S2S_BUDGET_TOTAL_MS = 300;
export const VOICE_V29_PIPELINE_DEGRADED_THRESHOLD_MS = 800;

/** Barge-in defaults (survey: server decides; grace + sustained speech). */
export const VOICE_V29_BARGE_IN_GRACE_DEFAULT_MS = 300;
export const VOICE_V29_BARGE_IN_MIN_SPEECH_DEFAULT_MS = 250;
export const VOICE_V29_BARGE_IN_MIN_ENERGY_DEFAULT = 0.3;
export const VOICE_V29_BARGE_IN_SENSITIVITY_DEFAULT = 0.5;
export const VOICE_V29_BARGE_IN_ADAPT_STEP_DEFAULT = 0.05;
export const VOICE_V29_BARGE_IN_ADAPT_DOWN_STEP_DEFAULT = 0.02;

/** Delegation defaults (async by default, like Gemini 3.8 Live). */
export const VOICE_V29_DELEGATE_TIMEOUT_DEFAULT_MS = 30_000;
export const VOICE_V29_DELEGATE_MAX_ATTEMPTS_DEFAULT = 3;
export const VOICE_V29_DELEGATE_MAX_CONCURRENT_DEFAULT = 4;
export const VOICE_V29_DELEGATE_RETRY_BASE_MS = 500;

/** Proactive audio defaults. */
export const VOICE_V29_PROACTIVE_IDLE_NUDGE_DEFAULT_MS = 60_000;
export const VOICE_V29_PROACTIVE_COOLDOWN_DEFAULT_MS = 30_000;
export const VOICE_V29_PROACTIVE_MAX_TRIGGERS_DEFAULT = 50;

/** Context / session caps. */
export const VOICE_V29_MAX_CONTEXT_ITEMS_DEFAULT = 2000;
export const VOICE_V29_MAX_CONTEXT_TOKENS_DEFAULT = 100_000;
export const VOICE_V29_MAX_LOG_EVENTS_DEFAULT = 1000;
export const VOICE_V29_MAX_TURNS_DEFAULT = 1000;
export const VOICE_V29_MAX_DELEGATED_CALLS_DEFAULT = 500;
export const VOICE_V29_COST_CAP_DEFAULT_USD = 5;
export const VOICE_V29_COST_WARN_DEFAULT_USD = 1;

/** Default turn detector config (balanced). */
export function defaultTurnDetectorConfigV29(): VoiceV29TurnDetectorConfig {
  return {
    threshold: VOICE_V29_TURN_THRESHOLD_DEFAULT,
    silenceTimeoutMs: VOICE_V29_TURN_SILENCE_TIMEOUT_DEFAULT_MS,
    hangoverMs: VOICE_V29_TURN_HANGOVER_DEFAULT_MS,
    minSpeechMs: VOICE_V29_TURN_MIN_SPEECH_DEFAULT_MS,
    backchannelMaxMs: VOICE_V29_TURN_BACKCHANNEL_MAX_DEFAULT_MS,
    backchannelMaxEnergy: VOICE_V29_TURN_BACKCHANNEL_MAX_ENERGY_DEFAULT,
    noiseFloor: VOICE_V29_TURN_NOISE_FLOOR_DEFAULT,
    adaptive: true,
    maxTurnMs: VOICE_V29_TURN_MAX_DEFAULT_MS,
    endKeyword: null,
  };
}

/** Default barge-in config (balanced). */
export function defaultBargeInConfigV29(): VoiceV29BargeInConfig {
  return {
    enabled: true,
    graceMs: VOICE_V29_BARGE_IN_GRACE_DEFAULT_MS,
    minSpeechMs: VOICE_V29_BARGE_IN_MIN_SPEECH_DEFAULT_MS,
    minEnergy: VOICE_V29_BARGE_IN_MIN_ENERGY_DEFAULT,
    sensitivity: VOICE_V29_BARGE_IN_SENSITIVITY_DEFAULT,
    adaptive: true,
    adaptStep: VOICE_V29_BARGE_IN_ADAPT_STEP_DEFAULT,
    adaptDownStep: VOICE_V29_BARGE_IN_ADAPT_DOWN_STEP_DEFAULT,
    explicitAlwaysInterrupts: true,
  };
}

/** Clamp a number into [min, max] (non-finite -> min). */
export function clampV29(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round2V29(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round4V29(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function meanV29(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentileV29(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Rough token estimate for text (4 chars/token, mock accounting). */
export function estimateTokensV29(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Count words (whitespace split, empty-safe). */
export function countWordsV29(text: string): number {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/** Cut text at a word boundary at or before `chars` (never mid-word). */
export function cutAtWordBoundaryV29(text: string, chars: number): string {
  if (chars <= 0) return '';
  if (chars >= text.length) return text;
  const cut = text.slice(0, chars);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace <= 0) return cut;
  return cut.slice(0, lastSpace);
}

/** Format a duration for display (ms / s / min). */
export function formatDurationV29(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${round2V29(ms / 1000)}s`;
  return `${round2V29(ms / 60_000)}min`;
}

/** Format USD for display (4 decimals, trims trailing zeros). */
export function formatUsdV29(usd: number): string {
  return `$${round4V29(usd).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0')}`;
}

/** Effective VAD threshold for a config (never below noise floor + 0.02). */
export function effectiveThresholdV29(config: VoiceV29TurnDetectorConfig): number {
  return round4V29(Math.max(config.noiseFloor + 0.02, config.threshold));
}

/** Is this model id one v29 knows about? */
export function isKnownModelV29(modelId: string): boolean {
  return VOICE_V29_MODEL_CATALOG.some((m) => m.modelId === modelId);
}

/** Is this architecture one v29 supports? */
export function isVoiceV29Architecture(value: string): value is VoiceV29Architecture {
  return value === 'cascaded' || value === 'turn-based-realtime' || value === 'full-duplex';
}

/** Validate a turn detector config, returning human errors (empty = ok). */
export function validateTurnDetectorConfigV29(config: VoiceV29TurnDetectorConfig): string[] {
  const errors: string[] = [];
  if (!(config.threshold > 0 && config.threshold < 1)) errors.push('threshold must be in (0, 1)');
  if (config.silenceTimeoutMs < 0) errors.push('silenceTimeoutMs must be >= 0');
  if (config.hangoverMs < 0) errors.push('hangoverMs must be >= 0');
  if (config.minSpeechMs < 0) errors.push('minSpeechMs must be >= 0');
  if (config.backchannelMaxMs < 0) errors.push('backchannelMaxMs must be >= 0');
  if (!(config.backchannelMaxEnergy >= 0 && config.backchannelMaxEnergy <= 1)) errors.push('backchannelMaxEnergy must be in [0, 1]');
  if (!(config.noiseFloor >= 0 && config.noiseFloor < 1)) errors.push('noiseFloor must be in [0, 1)');
  if (config.maxTurnMs < 0) errors.push('maxTurnMs must be >= 0');
  if (config.backchannelMaxMs > 0 && config.backchannelMaxMs < config.minSpeechMs) errors.push('backchannelMaxMs should be >= minSpeechMs');
  return errors;
}

/** Validate a barge-in config, returning human errors (empty = ok). */
export function validateBargeInConfigV29(config: VoiceV29BargeInConfig): string[] {
  const errors: string[] = [];
  if (config.graceMs < 0) errors.push('graceMs must be >= 0');
  if (config.minSpeechMs < 0) errors.push('minSpeechMs must be >= 0');
  if (!(config.minEnergy >= 0 && config.minEnergy <= 1)) errors.push('minEnergy must be in [0, 1]');
  if (!(config.sensitivity >= 0 && config.sensitivity <= 1)) errors.push('sensitivity must be in [0, 1]');
  if (!(config.adaptStep >= 0 && config.adaptStep <= 0.2)) errors.push('adaptStep must be in [0, 0.2]');
  if (!(config.adaptDownStep >= 0 && config.adaptDownStep <= 0.2)) errors.push('adaptDownStep must be in [0, 0.2]');
  return errors;
}
