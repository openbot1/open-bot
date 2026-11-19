/**
 * Shared types for voice full-duplex v30 (v1.44, Team T4).
 *
 * v30 is the second full-duplex generation after v29. v29 proved
 * the shape (turn detector, server-driven barge-in, append-only
 * context, delegated tools, proactive audio, cascaded pipeline,
 * per-minute cost ledger, one session tying it together). v30
 * keeps every v29 idea and hardens the five places where v29
 * was naive:
 *
 *   1. Turn detection — v29 used one fixed threshold: a frame
 *      at the boundary chattered, a short noise burst opened a
 *      turn that was then dropped, and the silence timeout never
 *      adapted to how fast the user speaks. v30 uses dual
 *      thresholds (high to open, low to sustain — hysteresis),
 *      a pre-turn confirmation buffer (speech must persist
 *      before a turn officially opens, so bursts never open
 *      one at all), an adaptive silence timeout learned from
 *      the user's recent turn cadence, single-frame spike
 *      rejection, a per-turn confidence score, and an
 *      echo/overlap flag so agent audio is never mistaken for
 *      user speech.
 *   2. Full-duplex pipeline — v29 ran one turn at a time
 *      through the session. v30 runs two independent lanes
 *      (inbound user, outbound agent) at the same time, with
 *      a jitter buffer on the inbound lane, bounded queues
 *      with backpressure, a degraded half-duplex mode under
 *      overload, crosstalk detection, and per-turn latency
 *      SLOs (first-byte + total).
 *   3. Barge-in — v29 had one interruption kind and resumed
 *      the remainder mid-word. v30 distinguishes a soft
 *      interruption (pause, keep the remainder, resume after
 *      the user turn) from a hard one (cancel for good),
 *      scores interruption confidence from sustained speech
 *      plus the energy slope, resumes from a sentence
 *      boundary, enforces a cooldown after each barge-in,
 *      and learns from false positives.
 *   4. Proactive audio — v29 scheduled triggers and fired
 *      them when due. v30 adds a priority queue (critical
 *      pre-empts normal), a token-bucket rate limiter per
 *      kind plus a global bucket, deduplication by key,
 *      expiry (TTL), user-presence gating, and a text
 *      fallback when audio is suppressed (quiet hours, DND,
 *      rate limit) instead of silently dropping the event.
 *   5. Cost ledger — v29 billed audio minutes only. v30
 *      bills a minute + token hybrid (audio minutes plus
 *      text tokens for the LLM leg and proactive audio),
 *      breaks spend down per kind (input / output /
 *      proactive / tokens), rolls up per day / week /
 *      month, enforces budget envelopes (soft warn + hard
 *      cap per session, day and month), forecasts the
 *      run-rate for the rest of the day and month, and
 *      exports an itemised statement (Markdown / CSV /
 *      JSON).
 *
 * Ideas only, learned from the v1.44 survey (OpenHands SDK
 * 1.60 realtime patterns, Letta memory blocks, Mem0 v3 —
 * ideas only, see docs/repo-survey-v144.md). No code, text
 * or assets from any of those projects are used here; the
 * design, the numbers and the code are ours.
 *
 * All clocks virtual (the caller passes `atMs`); all audio
 * is mock/synthetic frame energy; no provider is ever
 * dialled, no key is read or stored, no live API is called.
 * v29 is reused only by import where v30 wraps it (never
 * modified by v30).
 */

/** Realtime model ids v30 knows about (metadata/config only). */
export type VoiceV30ModelId =
  | 'gpt-realtime-2.1'
  | 'gpt-realtime-2.1-mini'
  | 'gpt-live'
  | 'gemini-3.8-live'
  | 'livekit-agents-1.0'
  | 'mock-cascaded';

/** Lifecycle of a full-duplex v30 session (adds `degraded`). */
export type VoiceV30SessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'degraded'
  | 'ended';

/** Who holds the conversation floor right now. */
export type VoiceV30FloorHolder = 'none' | 'user' | 'agent' | 'both';

/** Why a user turn ended. */
export type VoiceV30TurnEndReason =
  | 'silence'
  | 'keyword'
  | 'max-duration'
  | 'explicit'
  | 'interrupted'
  | 'echo';

/** Kind of a proactive audio trigger (v30 adds task/alert kinds). */
export type VoiceV30ProactiveKind =
  | 'greeting'
  | 'idle-nudge'
  | 'scheduled-reminder'
  | 'event-announcement'
  | 'follow-up'
  | 'task-complete'
  | 'alert'
  | 'digest';

/** Priority of a proactive trigger (critical pre-empts lower). */
export type VoiceV30ProactivePriority = 'critical' | 'high' | 'normal' | 'low';

/** What happened to a proactive trigger. */
export type VoiceV30ProactiveOutcome =
  | 'spoken'
  | 'suppressed-quiet-hours'
  | 'suppressed-dnd'
  | 'suppressed-rate-limit'
  | 'suppressed-user-speaking'
  | 'suppressed-not-present'
  | 'expired'
  | 'deduplicated'
  | 'text-fallback'
  | 'cancelled';

/** Pipeline mode for one turn. */
export type VoiceV30PipelineMode = 'cascaded' | 'speech-to-speech';

/** Duplex lane direction. */
export type VoiceV30Lane = 'inbound' | 'outbound';

/** Duplex lane state. */
export type VoiceV30LaneState = 'idle' | 'active' | 'backpressured' | 'drained' | 'stalled';

/** How the duplex engine degraded under overload. */
export type VoiceV30DegradationReason =
  | 'queue-full'
  | 'latency-slo-breach'
  | 'crosstalk-storm'
  | 'manual';

/** Barge-in interruption level. */
export type VoiceV30InterruptLevel = 'soft' | 'hard';

/** Who asked for an interruption (a request is not a decision). */
export type VoiceV30InterruptRequester = 'user-speech' | 'user-button' | 'server' | 'system';

/** Verdict of the barge-in engine on an interruption request. */
export type VoiceV30InterruptVerdict =
  | 'interrupt-soft'
  | 'interrupt-hard'
  | 'ignore-grace'
  | 'ignore-cooldown'
  | 'ignore-too-short'
  | 'ignore-backchannel'
  | 'ignore-low-confidence'
  | 'ignore-no-response'
  | 'ignore-disabled';

/** State of one server-driven response. */
export type VoiceV30ResponseState = 'active' | 'paused' | 'completed' | 'cancelled';

/** Cost alert severity. */
export type VoiceV30CostAlertLevel = 'info' | 'warning' | 'cap-reached' | 'forecast';

/** What a cost slice bills. */
export type VoiceV30CostKind = 'input-audio' | 'output-audio' | 'proactive-audio' | 'text-tokens';

/** One audio frame fed to the detector / duplex lanes. */
export interface VoiceV30AudioFrame {
  atMs: number;
  /** Normalised frame energy 0..1. */
  energy: number;
  /** Optional caller-supplied VAD verdict for this frame. */
  isSpeech?: boolean;
  /** Optional transcript fragment (keyword end detection). */
  text?: string | null;
  /**
   * True while the agent is speaking: the frame overlaps agent
   * audio, so it must not count as user speech (echo guard).
   */
  agentSpeaking?: boolean;
}

/** Tunables for the audio turn detector v30. */
export interface VoiceV30TurnDetectorConfig {
  /**
   * High threshold: energy must reach this to *open* a turn.
   * Must be above `lowThreshold` (hysteresis gap).
   */
  highThreshold: number;
  /** Low threshold: energy must stay above this to *sustain* a turn. */
  lowThreshold: number;
  /** Silence (ms) with no speech before a turn ends (base value). */
  silenceTimeoutMs: number;
  /** Hangover (ms) after the last speech frame before silence counts. */
  hangoverMs: number;
  /** Speech must persist this long before a turn officially opens. */
  confirmMs: number;
  /** Minimum turn length (ms) to count as a turn (not noise). */
  minSpeechMs: number;
  /** Max length of a backchannel burst (ms). */
  backchannelMaxMs: number;
  /** Max peak energy of a backchannel burst. */
  backchannelMaxEnergy: number;
  /** Starting noise floor (learned upward/downward while silent). */
  noiseFloor: number;
  /** Max turn length (ms, 0 = unlimited). */
  maxTurnMs: number;
  /** Optional keyword that ends the turn immediately. */
  endKeyword: string | null;
  /** Single-frame energy spikes above this are ignored (door slam). */
  spikeThreshold: number;
  /** Learn the silence timeout from recent turn cadence. */
  adaptiveSilence: boolean;
  /** Learn the noise floor from silence. */
  adaptive: boolean;
  /**
   * Minimum confidence (0..1) for a turn to be reported as a
   * real turn instead of a low-confidence candidate.
   */
  minConfidence: number;
}

/** One detected user turn. */
export interface VoiceV30Turn {
  id: string;
  index: number;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  peakEnergy: number;
  frames: number;
  endReason: VoiceV30TurnEndReason;
  backchannel: boolean;
  text: string;
  /** Confidence 0..1 that this is a real user turn. */
  confidence: number;
  /** True when any frame overlapped agent audio (echo-suspect). */
  echoSuspect: boolean;
  /** Silence timeout (ms) in effect when the turn ended. */
  silenceTimeoutMs: number;
}

/** Per-frame decision of the turn detector. */
export interface VoiceV30TurnFrameResult {
  kind: 'speech' | 'silence' | 'backchannel' | 'noise' | 'echo' | 'confirming';
  highThreshold: number;
  lowThreshold: number;
  noiseFloor: number;
  speechMs: number;
  silenceMs: number;
  turnStarted: boolean;
  turnEnded: boolean;
  endReason: VoiceV30TurnEndReason | null;
  backchannel: boolean;
  noiseRejected: boolean;
  echoSuppressed: boolean;
  /** Confidence of the in-progress turn so far (0..1). */
  confidence: number;
}

/** Tunables for the barge-in engine v30. */
export interface VoiceV30BargeInConfig {
  /** Grace (ms) after a response starts during which interrupts are ignored. */
  graceMs: number;
  /** Cooldown (ms) after a barge-in during which new interrupts are ignored. */
  cooldownMs: number;
  /** Sustained user speech (ms) needed before an interrupt is accepted. */
  minSpeechMs: number;
  /** Minimum frame energy for an interrupt. */
  minEnergy: number;
  /** Minimum confidence (0..1) for a soft interrupt. */
  softConfidence: number;
  /** Minimum confidence (0..1) for a hard interrupt. */
  hardConfidence: number;
  /** Base sensitivity 0..1 (higher = interrupts more easily). */
  sensitivity: number;
  /** How much sensitivity rises after a confirmed interrupt. */
  adaptStep: number;
  /** How much sensitivity falls after a false positive. */
  adaptDownStep: number;
  /** Resume the remainder from the next sentence boundary. */
  resumeAtSentenceBoundary: boolean;
  /** A user-button interrupt is always hard. */
  buttonIsHard: boolean;
}

/** One server-driven agent response (v30 adds pause + resume point). */
export interface VoiceV30ServerResponse {
  id: string;
  sessionId: string;
  text: string;
  startedAtMs: number;
  state: VoiceV30ResponseState;
  /** Chars already spoken when interrupted/paused. */
  spokenChars: number;
  /** Chars remaining when interrupted/paused. */
  remainingChars: number;
  /** Where a resume would start (sentence boundary when enabled). */
  resumeAtChars: number;
  interruptedAtMs: number | null;
  completedAtMs: number | null;
  cancelledAtMs: number | null;
  interruptCount: number;
}

/** Decision of the barge-in engine for one request. */
export interface VoiceV30InterruptDecision {
  verdict: VoiceV30InterruptVerdict;
  level: VoiceV30InterruptLevel | null;
  responseId: string | null;
  confidence: number;
  reason: string;
  atMs: number;
}

/** One barge-in event (history). */
export interface VoiceV30BargeInEvent {
  atMs: number;
  requester: VoiceV30InterruptRequester;
  verdict: VoiceV30InterruptVerdict;
  level: VoiceV30InterruptLevel | null;
  responseId: string | null;
  confidence: number;
  spokenCharsAtInterrupt: number;
  remainingChars: number;
}

/** One proactive trigger (v30 adds priority, dedupe key, TTL). */
export interface VoiceV30ProactiveTrigger {
  id: string;
  kind: VoiceV30ProactiveKind;
  priority: VoiceV30ProactivePriority;
  text: string;
  scheduledAtMs: number;
  /** Expire undelivered triggers after this (ms, 0 = never). */
  ttlMs: number;
  /** Dedupe key: a second trigger with the same key inside the window is dropped. */
  dedupeKey: string | null;
  /** Optional event payload (task id, alert source, ...). */
  payload: Record<string, string>;
  /** True when the trigger may fall back to a text notification. */
  allowTextFallback: boolean;
  state: 'scheduled' | 'fired' | 'suppressed' | 'expired' | 'cancelled' | 'deduplicated';
  outcome: VoiceV30ProactiveOutcome | null;
  firedAtMs: number | null;
}

/** One proactive event (history). */
export interface VoiceV30ProactiveEvent {
  atMs: number;
  triggerId: string;
  kind: VoiceV30ProactiveKind;
  priority: VoiceV30ProactivePriority;
  outcome: VoiceV30ProactiveOutcome;
  detail: string;
}

/** One duplex lane frame (queued, ordered by atMs). */
export interface VoiceV30LaneFrame {
  atMs: number;
  energy: number;
  text: string | null;
  seq: number;
}

/** One measured pipeline turn (latency SLOs). */
export interface VoiceV30DuplexTurn {
  id: string;
  mode: VoiceV30PipelineMode;
  startedAtMs: number;
  firstByteAtMs: number | null;
  endedAtMs: number;
  firstByteLatencyMs: number | null;
  totalLatencyMs: number;
  withinFirstByteSlo: boolean;
  withinTotalSlo: boolean;
  crosstalk: boolean;
  droppedFrames: number;
}

/** One cost rate entry (minute + token hybrid). */
export interface VoiceV30RateEntry {
  modelId: VoiceV30ModelId;
  /** USD per minute of audio (in + out) when no split rate applies. */
  usdPerMinute: number;
  /** USD per minute of audio input only (null = usdPerMinute). */
  usdPerMinuteInput: number | null;
  /** USD per minute of audio output only (null = usdPerMinute). */
  usdPerMinuteOutput: number | null;
  /** USD per 1k text tokens (LLM leg), null = tokens not billed. */
  usdPerKiloToken: number | null;
  /** Where the number came from (survey note, vendor page, override). */
  source: string;
  /** True when the rate is a local override, not a survey default. */
  overridden: boolean;
}

/** One billed cost slice. */
export interface VoiceV30CostEntry {
  sessionId: string;
  modelId: VoiceV30ModelId;
  kind: VoiceV30CostKind;
  startedAtMs: number;
  endedAtMs: number;
  minutes: number;
  tokens: number;
  usd: number;
}

/** One cost alert. */
export interface VoiceV30CostAlert {
  atMs: number;
  sessionId: string;
  level: VoiceV30CostAlertLevel;
  message: string;
  usdSoFar: number;
}

/** Budget envelope: soft warn + hard cap (0 = unlimited). */
export interface VoiceV30Budget {
  warnAtUsd: number;
  capUsd: number;
}

/** One full-duplex session snapshot (v30). */
export interface VoiceV30SessionSnapshot {
  sessionId: string;
  modelId: VoiceV30ModelId;
  state: VoiceV30SessionState;
  floor: VoiceV30FloorHolder;
  startedAtMs: number | null;
  turns: number;
  interruptions: number;
  proactiveFired: number;
  costUsd: number;
  degraded: boolean;
  degradationReason: VoiceV30DegradationReason | null;
}

/** One session log event. */
export interface VoiceV30SessionLogEvent {
  atMs: number;
  kind: string;
  detail: string;
}

/** Model metadata v30 carries for routing / display. */
export interface VoiceV30ModelInfo {
  modelId: VoiceV30ModelId;
  displayName: string;
  architecture: 'cascaded' | 'turn-based-realtime' | 'full-duplex';
  contextTokens: number;
  maxOutputTokens: number;
  serverDrivenBargeIn: boolean;
  delegatesToolCalls: boolean;
  asyncFunctionCallingDefault: boolean;
  proactiveAudio: boolean;
  /** True when the model supports token-priced text legs. */
  tokenPricing: boolean;
}

export const VOICE_V30_MODEL_CATALOG: readonly VoiceV30ModelInfo[] = [
  { modelId: 'gpt-realtime-2.1', displayName: 'GPT Realtime 2.1', architecture: 'turn-based-realtime', contextTokens: 128000, maxOutputTokens: 32000, serverDrivenBargeIn: false, delegatesToolCalls: false, asyncFunctionCallingDefault: false, proactiveAudio: false, tokenPricing: true },
  { modelId: 'gpt-realtime-2.1-mini', displayName: 'GPT Realtime 2.1 mini', architecture: 'turn-based-realtime', contextTokens: 128000, maxOutputTokens: 32000, serverDrivenBargeIn: false, delegatesToolCalls: false, asyncFunctionCallingDefault: false, proactiveAudio: false, tokenPricing: true },
  { modelId: 'gpt-live', displayName: 'GPT-Live (full-duplex)', architecture: 'full-duplex', contextTokens: 128000, maxOutputTokens: 32000, serverDrivenBargeIn: true, delegatesToolCalls: true, asyncFunctionCallingDefault: false, proactiveAudio: false, tokenPricing: true },
  { modelId: 'gemini-3.8-live', displayName: 'Gemini 3.8 Live', architecture: 'full-duplex', contextTokens: 131000, maxOutputTokens: 32000, serverDrivenBargeIn: true, delegatesToolCalls: true, asyncFunctionCallingDefault: true, proactiveAudio: true, tokenPricing: true },
  { modelId: 'livekit-agents-1.0', displayName: 'LiveKit Agents 1.0', architecture: 'full-duplex', contextTokens: 0, maxOutputTokens: 0, serverDrivenBargeIn: true, delegatesToolCalls: false, asyncFunctionCallingDefault: false, proactiveAudio: false, tokenPricing: false },
  { modelId: 'mock-cascaded', displayName: 'Mock cascaded (local)', architecture: 'cascaded', contextTokens: 0, maxOutputTokens: 0, serverDrivenBargeIn: false, delegatesToolCalls: true, asyncFunctionCallingDefault: true, proactiveAudio: true, tokenPricing: false },
];

/**
 * Default rate table (USD). Planning defaults, not live quotes:
 * the GPT-Live $0.05/min figure comes from the v1.42 survey;
 * token rates are planning defaults the host must override
 * with its own contract rates. Nothing here dials a provider.
 */
export const VOICE_V30_RATE_TABLE_DEFAULT: readonly VoiceV30RateEntry[] = [
  { modelId: 'gpt-live', usdPerMinute: 0.05, usdPerMinuteInput: null, usdPerMinuteOutput: null, usdPerKiloToken: 0.01, source: 'survey v1.42 §4: GPT-Live GA $0.05/min; token rate planning default', overridden: false },
  { modelId: 'gpt-realtime-2.1', usdPerMinute: 0.08, usdPerMinuteInput: 0.04, usdPerMinuteOutput: 0.12, usdPerKiloToken: 0.012, source: 'survey v1.42 §4: planning default — override with contract rate', overridden: false },
  { modelId: 'gpt-realtime-2.1-mini', usdPerMinute: 0.03, usdPerMinuteInput: 0.015, usdPerMinuteOutput: 0.045, usdPerKiloToken: 0.004, source: 'survey v1.42 §4: planning default — override with contract rate', overridden: false },
  { modelId: 'gemini-3.8-live', usdPerMinute: 0.05, usdPerMinuteInput: null, usdPerMinuteOutput: null, usdPerKiloToken: 0.008, source: 'survey v1.42 §4: planning default — override with contract rate', overridden: false },
  { modelId: 'livekit-agents-1.0', usdPerMinute: 0, usdPerMinuteInput: null, usdPerMinuteOutput: null, usdPerKiloToken: null, source: 'survey v1.42 §4: self-hosted — infra cost is billed separately', overridden: false },
  { modelId: 'mock-cascaded', usdPerMinute: 0, usdPerMinuteInput: null, usdPerMinuteOutput: null, usdPerKiloToken: null, source: 'local mock — no provider cost', overridden: false },
];

/* ------------------------------------------------------------------ */
/* Small numeric helpers (shared by every v30 module).                 */
/* ------------------------------------------------------------------ */

/** Clamp `value` into [min, max]. */
export function clampV30(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Round to 2 decimals. */
export function round2V30(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round to 4 decimals (money). */
export function round4V30(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Round to 6 decimals (rates). */
export function round6V30(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Mean of a list (0 when empty). */
export function meanV30(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Percentile (linear interpolation, 0..100). */
export function percentileV30(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (clampV30(p, 0, 100) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Rough token estimate: ~4 chars per token for English text. */
export function estimateTokensV30(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Cut `text` at the next sentence boundary at or after `atChars`. */
export function cutAtSentenceBoundaryV30(text: string, atChars: number): number {
  if (atChars >= text.length) return text.length;
  if (atChars <= 0) return 0;
  for (let i = atChars; i < text.length; i += 1) {
    const ch = text[i];
    if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 >= text.length || text[i + 1] === ' ' || text[i + 1] === '\n')) {
      // Skip the whitespace after the sentence so the resumed
      // text starts at the next sentence, not at a space.
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\n')) j += 1;
      return j;
    }
  }
  // No sentence boundary ahead: fall back to the next word boundary.
  for (let i = atChars; i < text.length; i += 1) {
    if (text[i] === ' ') {
      let j = i + 1;
      while (j < text.length && text[j] === ' ') j += 1;
      return j;
    }
  }
  return text.length;
}

/** Format ms as `mm:ss` / `hh:mm:ss`. */
export function formatDurationV30(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Format USD with 4 decimals. */
export function formatUsdV30(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** UTC date key (YYYY-MM-DD). */
export function dayKeyV30(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** UTC week key (YYYY-Www, Monday-start ISO-ish week). */
export function weekKeyV30(atMs: number): string {
  const d = new Date(atMs);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return `${monday.getUTCFullYear()}-W${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
}

/** UTC month key (YYYY-MM). */
export function monthKeyV30(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Look a model up in the catalog (null when unknown). */
export function modelInfoV30(modelId: string): VoiceV30ModelInfo | null {
  return VOICE_V30_MODEL_CATALOG.find((m) => m.modelId === modelId) ?? null;
}

/** True when `modelId` is one v30 knows. */
export function isKnownModelV30(modelId: string): modelId is VoiceV30ModelId {
  return VOICE_V30_MODEL_CATALOG.some((m) => m.modelId === modelId);
}

/** Look a rate up in a table (null when the model has no entry). */
export function rateForModelV30(
  table: readonly VoiceV30RateEntry[],
  modelId: VoiceV30ModelId,
): VoiceV30RateEntry | null {
  return table.find((r) => r.modelId === modelId) ?? null;
}

/** Cost of `minutes` at `rate` USD/min, rounded to 4 decimals. */
export function costForMinutesV30(minutes: number, usdPerMinute: number): number {
  if (!Number.isFinite(minutes) || !Number.isFinite(usdPerMinute) || minutes <= 0 || usdPerMinute <= 0) return 0;
  return round4V30(minutes * usdPerMinute);
}

/** Cost of `tokens` at `usdPerKiloToken` USD per 1k tokens. */
export function costForTokensV30(tokens: number, usdPerKiloToken: number | null): number {
  if (!Number.isFinite(tokens) || tokens <= 0 || usdPerKiloToken === null || usdPerKiloToken <= 0) return 0;
  return round4V30((tokens / 1000) * usdPerKiloToken);
}

/** Cost of one audio slice (input + output minutes at split rates). */
export function costForSliceV30(
  inputMinutes: number,
  outputMinutes: number,
  entry: VoiceV30RateEntry,
): number {
  const inRate = entry.usdPerMinuteInput ?? entry.usdPerMinute;
  const outRate = entry.usdPerMinuteOutput ?? entry.usdPerMinute;
  return round4V30(costForMinutesV30(inputMinutes, inRate) + costForMinutesV30(outputMinutes, outRate));
}

/* ------------------------------------------------------------------ */
/* Defaults + validation.                                              */
/* ------------------------------------------------------------------ */

export const VOICE_V30_TURN_HIGH_THRESHOLD_DEFAULT = 0.22;
export const VOICE_V30_TURN_LOW_THRESHOLD_DEFAULT = 0.12;
export const VOICE_V30_TURN_SILENCE_TIMEOUT_DEFAULT_MS = 700;
export const VOICE_V30_TURN_HANGOVER_DEFAULT_MS = 120;
export const VOICE_V30_TURN_CONFIRM_DEFAULT_MS = 150;
export const VOICE_V30_TURN_MIN_SPEECH_DEFAULT_MS = 200;
export const VOICE_V30_TURN_BACKCHANNEL_MAX_DEFAULT_MS = 600;
export const VOICE_V30_TURN_BACKCHANNEL_MAX_ENERGY_DEFAULT = 0.35;
export const VOICE_V30_TURN_NOISE_FLOOR_DEFAULT = 0.05;
export const VOICE_V30_TURN_NOISE_FLOOR_LEARN_RATE = 0.08;
export const VOICE_V30_TURN_MAX_DEFAULT_MS = 120_000;
export const VOICE_V30_TURN_FRAME_MS_DEFAULT = 50;
export const VOICE_V30_TURN_SPIKE_THRESHOLD_DEFAULT = 0.95;
export const VOICE_V30_TURN_MIN_CONFIDENCE_DEFAULT = 0.5;
export const VOICE_V30_TURN_ADAPTIVE_SILENCE_MIN_MS = 400;
export const VOICE_V30_TURN_ADAPTIVE_SILENCE_MAX_MS = 1500;

export const VOICE_V30_BARGE_IN_GRACE_DEFAULT_MS = 300;
export const VOICE_V30_BARGE_IN_COOLDOWN_DEFAULT_MS = 800;
export const VOICE_V30_BARGE_IN_MIN_SPEECH_DEFAULT_MS = 250;
export const VOICE_V30_BARGE_IN_MIN_ENERGY_DEFAULT = 0.3;
export const VOICE_V30_BARGE_IN_SOFT_CONFIDENCE_DEFAULT = 0.55;
export const VOICE_V30_BARGE_IN_HARD_CONFIDENCE_DEFAULT = 0.8;
export const VOICE_V30_BARGE_IN_SENSITIVITY_DEFAULT = 0.5;
export const VOICE_V30_BARGE_IN_ADAPT_STEP_DEFAULT = 0.05;
export const VOICE_V30_BARGE_IN_ADAPT_DOWN_STEP_DEFAULT = 0.03;

export const VOICE_V30_DUPLEX_INBOUND_QUEUE_MAX_DEFAULT = 200;
export const VOICE_V30_DUPLEX_OUTBOUND_QUEUE_MAX_DEFAULT = 200;
export const VOICE_V30_DUPLEX_JITTER_BUFFER_MS_DEFAULT = 120;
export const VOICE_V30_DUPLEX_FIRST_BYTE_SLO_MS_DEFAULT = 500;
export const VOICE_V30_DUPLEX_TOTAL_SLO_MS_DEFAULT = 900;
export const VOICE_V30_DUPLEX_CROSSTALK_WINDOW_MS_DEFAULT = 300;
export const VOICE_V30_DUPLEX_MAX_TURNS_DEFAULT = 1000;

export const VOICE_V30_PROACTIVE_IDLE_NUDGE_DEFAULT_MS = 60_000;
export const VOICE_V30_PROACTIVE_COOLDOWN_DEFAULT_MS = 30_000;
export const VOICE_V30_PROACTIVE_MAX_TRIGGERS_DEFAULT = 50;
export const VOICE_V30_PROACTIVE_BUCKET_CAPACITY_DEFAULT = 5;
export const VOICE_V30_PROACTIVE_BUCKET_REFILL_PER_MIN_DEFAULT = 1;
export const VOICE_V30_PROACTIVE_DEDUPE_WINDOW_DEFAULT_MS = 60_000;
export const VOICE_V30_PROACTIVE_TTL_DEFAULT_MS = 300_000;

export const VOICE_V30_COST_SESSION_WARN_DEFAULT_USD = 1;
export const VOICE_V30_COST_SESSION_CAP_DEFAULT_USD = 5;
export const VOICE_V30_COST_DAILY_WARN_DEFAULT_USD = 5;
export const VOICE_V30_COST_DAILY_CAP_DEFAULT_USD = 20;
export const VOICE_V30_COST_MONTHLY_WARN_DEFAULT_USD = 50;
export const VOICE_V30_COST_MONTHLY_CAP_DEFAULT_USD = 200;
export const VOICE_V30_MAX_TURNS_DEFAULT = 1000;
export const VOICE_V30_MAX_LOG_EVENTS_DEFAULT = 1000;

/** Default turn detector config v30. */
export function defaultTurnDetectorConfigV30(): VoiceV30TurnDetectorConfig {
  return {
    highThreshold: VOICE_V30_TURN_HIGH_THRESHOLD_DEFAULT,
    lowThreshold: VOICE_V30_TURN_LOW_THRESHOLD_DEFAULT,
    silenceTimeoutMs: VOICE_V30_TURN_SILENCE_TIMEOUT_DEFAULT_MS,
    hangoverMs: VOICE_V30_TURN_HANGOVER_DEFAULT_MS,
    confirmMs: VOICE_V30_TURN_CONFIRM_DEFAULT_MS,
    minSpeechMs: VOICE_V30_TURN_MIN_SPEECH_DEFAULT_MS,
    backchannelMaxMs: VOICE_V30_TURN_BACKCHANNEL_MAX_DEFAULT_MS,
    backchannelMaxEnergy: VOICE_V30_TURN_BACKCHANNEL_MAX_ENERGY_DEFAULT,
    noiseFloor: VOICE_V30_TURN_NOISE_FLOOR_DEFAULT,
    maxTurnMs: VOICE_V30_TURN_MAX_DEFAULT_MS,
    endKeyword: null,
    spikeThreshold: VOICE_V30_TURN_SPIKE_THRESHOLD_DEFAULT,
    adaptiveSilence: true,
    adaptive: true,
    minConfidence: VOICE_V30_TURN_MIN_CONFIDENCE_DEFAULT,
  };
}

/** Default barge-in config v30. */
export function defaultBargeInConfigV30(): VoiceV30BargeInConfig {
  return {
    graceMs: VOICE_V30_BARGE_IN_GRACE_DEFAULT_MS,
    cooldownMs: VOICE_V30_BARGE_IN_COOLDOWN_DEFAULT_MS,
    minSpeechMs: VOICE_V30_BARGE_IN_MIN_SPEECH_DEFAULT_MS,
    minEnergy: VOICE_V30_BARGE_IN_MIN_ENERGY_DEFAULT,
    softConfidence: VOICE_V30_BARGE_IN_SOFT_CONFIDENCE_DEFAULT,
    hardConfidence: VOICE_V30_BARGE_IN_HARD_CONFIDENCE_DEFAULT,
    sensitivity: VOICE_V30_BARGE_IN_SENSITIVITY_DEFAULT,
    adaptStep: VOICE_V30_BARGE_IN_ADAPT_STEP_DEFAULT,
    adaptDownStep: VOICE_V30_BARGE_IN_ADAPT_DOWN_STEP_DEFAULT,
    resumeAtSentenceBoundary: true,
    buttonIsHard: true,
  };
}

/** Validate a turn detector config, returning human errors (empty = ok). */
export function validateTurnDetectorConfigV30(config: VoiceV30TurnDetectorConfig): string[] {
  const errors: string[] = [];
  if (!(config.highThreshold > 0 && config.highThreshold < 1)) errors.push('highThreshold must be in (0, 1)');
  if (!(config.lowThreshold > 0 && config.lowThreshold < 1)) errors.push('lowThreshold must be in (0, 1)');
  if (config.lowThreshold >= config.highThreshold) errors.push('lowThreshold must be below highThreshold (hysteresis gap)');
  if (config.silenceTimeoutMs < 0) errors.push('silenceTimeoutMs must be >= 0');
  if (config.hangoverMs < 0) errors.push('hangoverMs must be >= 0');
  if (config.confirmMs < 0) errors.push('confirmMs must be >= 0');
  if (config.minSpeechMs < 0) errors.push('minSpeechMs must be >= 0');
  if (config.backchannelMaxMs < 0) errors.push('backchannelMaxMs must be >= 0');
  if (!(config.backchannelMaxEnergy >= 0 && config.backchannelMaxEnergy <= 1)) errors.push('backchannelMaxEnergy must be in [0, 1]');
  if (!(config.noiseFloor >= 0 && config.noiseFloor < 1)) errors.push('noiseFloor must be in [0, 1)');
  if (config.maxTurnMs < 0) errors.push('maxTurnMs must be >= 0');
  if (!(config.spikeThreshold > 0 && config.spikeThreshold <= 1)) errors.push('spikeThreshold must be in (0, 1]');
  if (config.spikeThreshold <= config.highThreshold) errors.push('spikeThreshold must be above highThreshold');
  if (!(config.minConfidence >= 0 && config.minConfidence <= 1)) errors.push('minConfidence must be in [0, 1]');
  if (config.backchannelMaxMs > 0 && config.backchannelMaxMs < config.minSpeechMs) errors.push('backchannelMaxMs should be >= minSpeechMs');
  return errors;
}

/** Validate a barge-in config, returning human errors (empty = ok). */
export function validateBargeInConfigV30(config: VoiceV30BargeInConfig): string[] {
  const errors: string[] = [];
  if (config.graceMs < 0) errors.push('graceMs must be >= 0');
  if (config.cooldownMs < 0) errors.push('cooldownMs must be >= 0');
  if (config.minSpeechMs < 0) errors.push('minSpeechMs must be >= 0');
  if (!(config.minEnergy >= 0 && config.minEnergy <= 1)) errors.push('minEnergy must be in [0, 1]');
  if (!(config.softConfidence >= 0 && config.softConfidence <= 1)) errors.push('softConfidence must be in [0, 1]');
  if (!(config.hardConfidence >= 0 && config.hardConfidence <= 1)) errors.push('hardConfidence must be in [0, 1]');
  if (config.hardConfidence < config.softConfidence) errors.push('hardConfidence must be >= softConfidence');
  if (!(config.sensitivity >= 0 && config.sensitivity <= 1)) errors.push('sensitivity must be in [0, 1]');
  if (!(config.adaptStep >= 0 && config.adaptStep <= 0.2)) errors.push('adaptStep must be in [0, 0.2]');
  if (!(config.adaptDownStep >= 0 && config.adaptDownStep <= 0.2)) errors.push('adaptDownStep must be in [0, 0.2]');
  return errors;
}
