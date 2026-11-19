/**
 * Shared types for voice realtime v25 (v1.38, Team T5).
 *
 * v25 continues v24 without touching it. v24 owns what the
 * operator sees *while a bot runs a voice session* (per-tool-call
 * timers, the dynamic provider catalogue, health, mid-session
 * model switching). v25 owns what happens *between the turns*
 * of that session — the live conversation flow itself:
 *
 *   - barge-in / interruption handling (turn level): the user
 *     talks while the agent is speaking; the agent stops at a
 *     measured offset, the transcript keeps only what was
 *     actually spoken, and the interrupting turn is queued.
 *     The burst-level decision (grace window, backchannel,
 *     echo) stays in v23 — v25 consumes v23 decisions and
 *     owns the turn-level consequences;
 *   - turn-taking + silence detection: who holds the floor,
 *     when a silence hands it over, how long a silence may
 *     run before the turn is yielded, and silence statistics
 *     per turn. v23 endpointing decides when one *utterance*
 *     ends at frame level; v25 decides when the *floor*
 *     changes hands and measures silence in ms per turn;
 *   - real per-provider voice latency: time-to-first-token,
 *     time-to-first-audio and turn total, measured on real
 *     turns the host reports (caller-supplied samples), with
 *     rolling p50/p95 and a latency-threshold fallback that
 *     moves the session to a faster provider. v24 health
 *     scores probes ok/fail; v25 measures *how slow*;
 *   - per-voice-turn timers: the v24 per-tool-call timers
 *     extended to whole turns — listen / silence-wait /
 *     think / speak phase durations per turn, per-session
 *     turn aggregates, slow-turn alerts, and a panel row per
 *     turn so the operator sees "turn 3 took 4.2s: 0.8s
 *     listen, 1.1s think, 2.3s speak, interrupted at 1.4s".
 *
 * All clocks virtual (the caller passes `atMs`); all audio
 * mock/synthetic; no network, no key, no mic/sound card.
 * Latency samples and probe results are caller-supplied
 * measurements — this module never dials a provider itself.
 */
import { clampV24, meanV24, percentileV24, round2V24, round4V24 } from '../voiceV24/types';

export type VoiceV25Clock = { nowMs: number };

/** Phases inside one voice turn (a turn has at most one phase at a time). */
export type VoiceV25TurnPhase =
  | 'listening'
  | 'silence-wait'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'done';

/** Who speaks in a turn. */
export type VoiceV25TurnRole = 'user' | 'assistant';

/** Lifecycle of one voice turn. */
export type VoiceV25TurnStatus =
  | 'active'
  | 'completed'
  | 'interrupted'
  | 'abandoned'
  | 'timeout';

/** One phase span inside a turn. */
export interface VoiceV25PhaseSpan {
  phase: VoiceV25TurnPhase;
  startedAtMs: number;
  endedAtMs: number | null;
  /** ms, null while the phase is still open. */
  durationMs: number | null;
}

/** One voice turn: a user utterance + the agent reply that follows it. */
export interface VoiceV25TurnRecord {
  id: string;
  sessionId: string;
  /** 0-based turn index inside the session. */
  index: number;
  role: VoiceV25TurnRole;
  startedAtMs: number;
  endedAtMs: number | null;
  /** ms, null while active. */
  durationMs: number | null;
  status: VoiceV25TurnStatus;
  /** Phase spans in order; the last one is open while active. */
  phases: VoiceV25PhaseSpan[];
  /** Total ms of detected silence inside this turn. */
  silenceMs: number;
  /** Total ms of detected speech inside this turn. */
  speechMs: number;
  /** Longest single silence gap inside this turn, ms. */
  longestSilenceMs: number;
  /** Transcript text of the turn (user words, or agent reply). */
  text: string;
  /** For an assistant turn cut by a barge-in: chars actually spoken. */
  spokenChars: number | null;
  /** For an assistant turn: chars the reply planned to speak. */
  plannedChars: number | null;
  /** Barge-in id that interrupted this turn, if any. */
  bargeInId: string | null;
  /** ms the agent was speaking when interrupted (null if not interrupted). */
  interruptedAtMs: number | null;
  /** Provider + model that served this turn. */
  providerId: string | null;
  model: string | null;
}

/** Silence detector state at a point in time. */
export type VoiceV25SilenceState = 'speech' | 'silence' | 'unknown';

/** One measured silence gap (silence between two speech runs). */
export interface VoiceV25SilenceGap {
  id: string;
  sessionId: string;
  turnId: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  /** ms, null while the gap is still open. */
  durationMs: number | null;
  /** True when speech ended the gap; false when the turn/session ended it. */
  endedBySpeech: boolean;
  /** True when the gap ran past the yield threshold (floor handed over). */
  yielded: boolean;
}

/** What kind of user speech cut the agent off. */
export type VoiceV25BargeInKind = 'speech' | 'backchannel-sustained' | 'keyword' | 'unknown';

/** What the v23 burst decision said to do with the burst. */
export type VoiceV25BargeInDecision = 'interrupt' | 'duck' | 'ignore';

/** What happens to the cut agent reply after a barge-in. */
export type VoiceV25ResumeStrategy = 'resume' | 'drop' | 'summarise' | 'rephrase';

/** One barge-in: the user interrupted the agent mid-reply. */
export interface VoiceV25BargeInRecord {
  id: string;
  sessionId: string;
  /** Turn index of the assistant turn that was cut. */
  turnIndex: number;
  /** Turn id of the assistant turn that was cut. */
  turnId: string;
  atMs: number;
  kind: VoiceV25BargeInKind;
  /** What the burst-level decision (v23) said to do. */
  decision: VoiceV25BargeInDecision;
  /** ms of user speech that triggered the barge-in. */
  userSpeechMs: number;
  /** ms the agent had been speaking when cut. */
  agentSpokenMs: number;
  /** Chars the agent had spoken when cut. */
  agentSpokenChars: number;
  /** Chars the agent reply planned in total. */
  agentPlannedChars: number;
  /** ms from user-speech onset to the agent actually stopping. */
  stopLatencyMs: number;
  resumeStrategy: VoiceV25ResumeStrategy;
  /** Text the user said to interrupt (when the host supplies it). */
  userText: string | null;
  /** Turn id of the interrupting user turn, once created. */
  interruptingTurnId: string | null;
  /** True when the operator later marked this a false positive. */
  falsePositive: boolean;
}

/** Which latency of a voice turn a sample measures. */
export type VoiceV25LatencyKind = 'ttft' | 'first-audio' | 'total';

/** One host-measured voice latency sample for a provider. */
export interface VoiceV25LatencySample {
  providerId: string;
  model: string;
  sessionId: string;
  turnId: string | null;
  atMs: number;
  /** ms to first token (LLM), null when not measured. */
  ttftMs: number | null;
  /** ms to first audio frame (TTS), null when not measured. */
  firstAudioMs: number | null;
  /** ms for the whole turn, null when not measured. */
  totalMs: number | null;
  ok: boolean;
  error?: string;
}

/** Rolling latency statistics for one provider. */
export interface VoiceV25LatencyStats {
  providerId: string;
  samples: number;
  okSamples: number;
  failedSamples: number;
  ttftMeanMs: number;
  ttftP50Ms: number;
  ttftP95Ms: number;
  firstAudioMeanMs: number;
  firstAudioP50Ms: number;
  firstAudioP95Ms: number;
  totalMeanMs: number;
  totalP50Ms: number;
  totalP95Ms: number;
  totalMaxMs: number;
  /** Consecutive samples whose total exceeded the slow threshold. */
  consecutiveSlow: number;
  /** Consecutive failed samples. */
  consecutiveFailures: number;
  /** True when the provider is currently slow by the configured rule. */
  isSlow: boolean;
  /** True when the provider is currently failing by the configured rule. */
  isFailing: boolean;
  lastAtMs: number | null;
}

/** A latency-driven fallback decision: move the session to a faster provider. */
export interface VoiceV25LatencyFallbackDecision {
  id: string;
  sessionId: string;
  fromProviderId: string;
  toProviderId: string | null;
  reason: 'slow' | 'failing' | 'no-candidate';
  atMs: number;
  /** p95 total latency that triggered the decision, ms (0 for failing). */
  triggerP95Ms: number;
  /** Threshold the trigger crossed, ms. */
  thresholdMs: number;
  switched: boolean;
}

/** Why a turn-timer alert fired. */
export type VoiceV25TurnAlertKind =
  | 'slow-turn'
  | 'long-silence'
  | 'barge-in-burst'
  | 'slow-provider';

/** One threshold alert raised by the v25 turn stack. */
export interface VoiceV25TurnAlert {
  id: string;
  sessionId: string;
  turnId: string | null;
  kind: VoiceV25TurnAlertKind;
  /** Threshold the event crossed, ms. */
  thresholdMs: number;
  /** Actual duration (or count for barge-in-burst), ms. */
  durationMs: number;
  atMs: number;
  message: string;
}

/** Who holds the conversational floor right now. */
export type VoiceV25FloorHolder = 'user' | 'agent' | 'none';

/** Turn-taking state machine state. */
export type VoiceV25TurnTakingState =
  | 'idle'
  | 'user-speaking'
  | 'user-done'
  | 'agent-thinking'
  | 'agent-speaking'
  | 'interrupted';

export const VOICE_V25_SILENCE_DEFAULT_MS = 700;
export const VOICE_V25_SILENCE_YIELD_DEFAULT_MS = 1200;
export const VOICE_V25_MIN_SPEECH_DEFAULT_MS = 150;
export const VOICE_V25_MAX_TURN_DEFAULT_MS = 120000;
export const VOICE_V25_MAX_USER_TURN_DEFAULT_MS = 60000;
export const VOICE_V25_BARGEIN_MIN_SPEECH_DEFAULT_MS = 250;
export const VOICE_V25_STOP_LATENCY_SLOW_DEFAULT_MS = 500;
export const VOICE_V25_SLOW_TURN_DEFAULT_MS = 15000;
export const VOICE_V25_LONG_SILENCE_DEFAULT_MS = 5000;
export const VOICE_V25_LATENCY_SLOW_DEFAULT_MS = 3000;
export const VOICE_V25_LATENCY_P95_WINDOW = 20;
export const VOICE_V25_CONSECUTIVE_SLOW_DEFAULT = 3;
export const VOICE_V25_CONSECUTIVE_FAILURES_DEFAULT = 3;
export const VOICE_V25_FALLBACK_COOLDOWN_DEFAULT_MS = 30000;

/** Clamp a number into [min, max]; NaN becomes min. */
export function clampV25(value: number, min: number, max: number): number {
  return clampV24(value, min, max);
}

/** Round to 2 decimals for display (durations, rates). */
export function round2V25(value: number): number {
  return round2V24(value);
}

/** Round to 4 decimals for display (rates, scores). */
export function round4V25(value: number): number {
  return round4V24(value);
}

/** Mean of a list (0 when empty). */
export function meanV25(values: readonly number[]): number {
  return meanV24(values);
}

/** Percentile of a list (linear interpolation, 0 when empty). p in 0..100. */
export function percentileV25(values: readonly number[], p: number): number {
  return percentileV24(values, p);
}

/**
 * Format a duration for the turn UI: under 1s as "850ms",
 * under a minute as "1.23s", otherwise "2m 03s". Negative
 * input is clamped to 0; non-finite input renders as "—".
 */
export function formatDurationV25(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  if (clamped < 60000) return `${(clamped / 1000).toFixed(2)}s`;
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Short form used in dense turn rows: "850ms", "1.2s", "2m03s". */
export function formatDurationShortV25(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  if (clamped < 60000) return `${(clamped / 1000).toFixed(1)}s`;
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** Duration bucket used by the panel to colour a turn. */
export type VoiceV25DurationBucket = 'fast' | 'normal' | 'slow' | 'very-slow';

export function durationBucketV25(
  durationMs: number,
  slowThresholdMs: number,
  timeoutMs: number,
): VoiceV25DurationBucket {
  if (durationMs >= timeoutMs) return 'very-slow';
  if (durationMs >= slowThresholdMs) return 'slow';
  if (durationMs >= slowThresholdMs / 5) return 'normal';
  return 'fast';
}

/** True for a non-empty id with no whitespace or dots (tool/session/turn ids). */
export function isValidVoiceV25Id(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
}

/**
 * Cheap turn checksum (FNV-1a over role+text+status) so a
 * barge-in can prove the transcript kept only what was
 * actually spoken: the checksum of the truncated turn must
 * match the spoken prefix. Integrity check, not a security hash.
 */
export function turnChecksumV25(turns: readonly VoiceV25TurnRecord[]): string {
  let hash = 0x811c9dc5;
  for (const turn of turns) {
    const text = `${turn.role}:${turn.text}:${turn.status}\n`;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

/** Total ms of one phase across a turn's phase spans. */
export function phaseDurationV25(turn: VoiceV25TurnRecord, phase: VoiceV25TurnPhase): number {
  let total = 0;
  for (const span of turn.phases) {
    if (span.phase !== phase || span.durationMs === null) continue;
    total += span.durationMs;
  }
  return total;
}

/** True when a turn record is still open (no end yet). */
export function isTurnActiveV25(turn: VoiceV25TurnRecord): boolean {
  return turn.status === 'active';
}
