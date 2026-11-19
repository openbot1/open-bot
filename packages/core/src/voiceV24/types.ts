/**
 * Shared types for voice realtime v24 (v1.37, Team T5).
 *
 * v24 continues v23 without touching it: v23 owns what v22
 * measures (eval harness, MOS-proxy, streaming v2,
 * endpointing v2, interruption v2, session manager v2,
 * calibration, device profiles, monitor). v24 owns what the
 * operator sees *while a bot is running a voice session*:
 *
 *   - per-tool-call timers: every tool call the bot makes
 *     inside a voice session gets its own start / end /
 *     duration, with per-tool and per-session aggregates and
 *     alerts when a call runs past its threshold;
 *   - a dynamic provider/model picker: the picker lists
 *     whatever providers and models are actually available
 *     at the moment it opens (never a hard-coded list),
 *     with a live status per provider (online / offline /
 *     unconfigured / degraded / unknown);
 *   - mid-session model switching: change the model in the
 *     middle of a voice session while the transcript and
 *     the session state stay exactly where they were, with
 *     a switch history and a rollback to the previous model.
 *
 * All clocks virtual, all audio mock/synthetic, no network,
 * no key, no mic/sound card. Provider availability is
 * caller-supplied (probe results the host measured); this
 * module never dials a provider itself and never reads a key.
 */
import { clampV22 } from '../voiceV22/types';

export type VoiceV24Clock = { nowMs: number };

/** Live status of one provider, as shown in the picker. */
export type VoiceV24ProviderStatus =
  | 'online'
  | 'offline'
  | 'unconfigured'
  | 'degraded'
  | 'unknown';

/** Where a provider's model comes from. */
export type VoiceV24ProviderKind = 'subscription' | 'api' | 'custom' | 'local';

/** One model inside a provider's catalogue. */
export interface VoiceV24ModelInfo {
  /** Model id as the provider names it (e.g. "gpt-5.2"). */
  id: string;
  /** Human label shown in the picker; defaults to `id`. */
  label?: string;
  /** Context window in tokens, when the provider reports one. */
  contextWindow?: number;
  /** True when the provider reports this model usable for voice. */
  supportsVoice?: boolean;
  /** True when the provider marks the model deprecated. */
  deprecated?: boolean;
}

/** A provider + model pair, the unit the picker selects. */
export interface VoiceV24ModelRef {
  providerId: string;
  model: string;
}

/** Lifecycle of one tool call inside a voice session. */
export type VoiceV24ToolCallStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

/** One timed tool call inside a voice session. */
export interface VoiceV24ToolCallRecord {
  id: string;
  sessionId: string;
  toolName: string;
  /** Index of the turn the call belongs to (0-based). */
  turnIndex: number;
  startedAtMs: number;
  endedAtMs: number | null;
  /** ms, null while running. */
  durationMs: number | null;
  status: VoiceV24ToolCallStatus;
  /** Error text when status is 'failed'. */
  error?: string;
}

/** Why a timer alert fired. */
export type VoiceV24TimerAlertKind = 'slow' | 'timeout' | 'error-burst';

/** One threshold alert raised by a tool-call timer. */
export interface VoiceV24TimerAlert {
  id: string;
  callId: string;
  sessionId: string;
  toolName: string;
  kind: VoiceV24TimerAlertKind;
  /** Threshold the call crossed, ms. */
  thresholdMs: number;
  /** Actual duration (or error count for error-burst), ms. */
  durationMs: number;
  atMs: number;
  message: string;
}

/** Duration bucket used by the panel to colour a call. */
export type VoiceV24DurationBucket = 'fast' | 'normal' | 'slow' | 'very-slow';

/** One transcript turn, preserved across model switches. */
export interface VoiceV24TranscriptTurn {
  role: 'user' | 'assistant' | 'system';
  text: string;
  atMs: number;
}

/** One recorded model switch inside a voice session. */
export interface VoiceV24ModelSwitchEvent {
  id: string;
  sessionId: string;
  from: VoiceV24ModelRef;
  to: VoiceV24ModelRef;
  atMs: number;
  /** Transcript turns at switch time (must equal before/after). */
  transcriptTurns: number;
  /** True when the transcript checksum matched before/after. */
  transcriptPreserved: boolean;
  /** True when this switch was later rolled back. */
  rolledBack: boolean;
}

/** One provider probe observation (host-measured, passed in). */
export interface VoiceV24ProbeObservation {
  providerId: string;
  atMs: number;
  ok: boolean;
  /** Round-trip of the probe, ms (0 when the probe failed). */
  latencyMs: number;
  error?: string;
}

export const VOICE_V24_SLOW_DEFAULT_MS = 5000;
export const VOICE_V24_TIMEOUT_DEFAULT_MS = 30000;
export const VOICE_V24_STALE_AFTER_DEFAULT_MS = 60000;
export const VOICE_V24_DEGRADED_LATENCY_DEFAULT_MS = 2000;

/** Clamp a number into [min, max]; NaN becomes min. */
export function clampV24(value: number, min: number, max: number): number {
  return clampV22(value, min, max);
}

/** Round to 2 decimals for display (durations, rates). */
export function round2V24(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round to 4 decimals for display (rates, scores). */
export function round4V24(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Mean of a list (0 when empty). */
export function meanV24(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Percentile of a list (linear interpolation, 0 when empty). p in 0..100. */
export function percentileV24(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (clampV24(p, 0, 100) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * Format a duration for the timer UI: under 1s as "850ms",
 * under a minute as "1.23s", otherwise "2m 03s". Negative
 * input is clamped to 0; non-finite input renders as "—".
 */
export function formatDurationV24(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  if (clamped < 60000) return `${(clamped / 1000).toFixed(2)}s`;
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Short form used in dense timer rows: "850ms", "1.2s", "2m03s". */
export function formatDurationShortV24(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  if (clamped < 60000) return `${(clamped / 1000).toFixed(1)}s`;
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * Bucket a finished call duration against the slow/timeout
 * thresholds so the panel can colour it without re-deriving
 * the rule in two places.
 */
export function durationBucketV24(
  durationMs: number,
  slowThresholdMs: number,
  timeoutMs: number,
): VoiceV24DurationBucket {
  if (durationMs >= timeoutMs) return 'very-slow';
  if (durationMs >= slowThresholdMs) return 'slow';
  if (durationMs >= slowThresholdMs / 5) return 'normal';
  return 'fast';
}

/** True for a non-empty id with no whitespace or dots (tool/session ids). */
export function isValidVoiceV24Id(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
}

/**
 * Cheap transcript checksum (FNV-1a over role+text) so a
 * model switch can prove the transcript survived untouched:
 * the checksum before and after the switch must match.
 * This is an integrity check, not a security hash.
 */
export function transcriptChecksumV24(turns: readonly VoiceV24TranscriptTurn[]): string {
  let hash = 0x811c9dc5;
  for (const turn of turns) {
    const text = `${turn.role}:${turn.text}\n`;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

/** Derive a provider status from its raw probe state. */
export function deriveProviderStatusV24(input: {
  configured: boolean;
  everProbed: boolean;
  lastProbeOk: boolean;
  lastProbeAtMs: number | null;
  lastProbeLatencyMs: number | null;
  nowMs: number;
  staleAfterMs: number;
  degradedLatencyMs: number;
}): VoiceV24ProviderStatus {
  if (!input.configured) return 'unconfigured';
  if (!input.everProbed || input.lastProbeAtMs === null) return 'unknown';
  if (input.nowMs - input.lastProbeAtMs > input.staleAfterMs) return 'unknown';
  if (!input.lastProbeOk) return 'offline';
  if (
    input.lastProbeLatencyMs !== null &&
    input.lastProbeLatencyMs > input.degradedLatencyMs
  ) {
    return 'degraded';
  }
  return 'online';
}
