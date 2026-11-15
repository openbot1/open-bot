/**
 * Voice session v8 view models (v1.09, Team T5 — voice v8 + UI).
 *
 * Renderer-local mirror of the core v8 session shapes (the
 * BudgetMeter pattern): the renderer must NOT value-import from
 * `@open-bot/core` — the core bundles are CJS and vite inlines
 * them verbatim, which throws `ReferenceError: exports is not
 * defined` at startup and leaves a blank screen. This module
 * owns the view contract instead: defensive parsing of the IPC
 * payloads (`voice-v8:*` returns plain JSON), the session status
 * (listening / speaking / reconnecting / disconnected), the
 * waveform bars from mic RMS levels, and the push-to-talk state
 * machine (press / release / auto). Pure functions, no React, no
 * DOM, no IPC — unit-tested with plain node --test (see
 * tests/voice-v109.test.mjs).
 */

/** UI status of a v8 voice session (what the panel renders). */
export type VoiceSessionV8StatusView =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'reconnecting'
  | 'disconnected';

/** Input mode. */
export type VoiceSessionV8InputModeView = 'auto' | 'push-to-talk';

/** One row in the voice session list (as the IPC returns it). */
export interface VoiceSessionV8RowView {
  id: string;
  status: VoiceSessionV8StatusView;
  inputMode: VoiceSessionV8InputModeView;
  pttPressed: boolean;
  callState: string;
  phase: string;
  provider: string;
  voiceId: string | null;
  voiceName: string | null;
  connected: boolean;
  startedAtMs: number | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  lines: number;
  turns: number;
  interrupts: number;
  thinkingInterrupts: number;
  ducks: number;
  echoOnlyFrames: number;
  reconnects: number;
  vadEngine: string;
  vadPreset: string;
  level: number;
  snapshotSaved: boolean;
  restoredFrom: boolean;
}

/** VAD v8 status for the panel (spectrum + noise + false positives). */
export interface VoiceV8VadView {
  engine: string;
  preset: string;
  threshold: number;
  noiseFloor: number;
  bandFloors: { low: number; mid: number; high: number };
  level: number;
  zcr: number;
  spectralFlatness: number;
  confidence: number;
  noiseKind: string;
  hangoverMs: number;
  calibrating: boolean;
  turns: number;
  backchannels: number;
  falsePositives: number;
  falsePositivesByReason: Record<string, number>;
  falsePositivesByNoise: Record<string, number>;
  meanEndLatencyMs: number | null;
  state: string;
}

/** Barge-in v8 status for the panel (AEC + queue receipt). */
export interface VoiceV8BargeInView {
  state: string;
  interrupts: number;
  thinkingInterrupts: number;
  ducks: number;
  ignored: number;
  echoOnlyFrames: number;
  meanResidualRatio: number | null;
  echoGain: number;
  totalAudioDiscardedMs: number;
  totalWordsDiscarded: number;
  interruptsLastMinute: number;
}

/** One waveform bar (the panel renders these as vertical bars). */
export interface WaveformBarView {
  /** Bar index (0 = oldest). */
  index: number;
  /** Normalised height 0..1. */
  height: number;
  /** True when this bar is the live (newest) one. */
  live: boolean;
}

/** Push-to-talk state machine (what the PTT button shows). */
export interface PttView {
  inputMode: VoiceSessionV8InputModeView;
  pressed: boolean;
  /** True when holding the button actually opens the mic. */
  micOpen: boolean;
  /** Button label key (i18n). */
  labelKey: string;
  /** True when the button is usable (push-to-talk mode + connected). */
  enabled: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

const V8_STATUSES: readonly string[] = ['idle', 'listening', 'thinking', 'speaking', 'reconnecting', 'disconnected'];

export function isVoiceSessionV8Status(value: string): value is VoiceSessionV8StatusView {
  return (V8_STATUSES as readonly string[]).includes(value);
}

/** i18n key for a session status (the panel translates it). */
export function voiceV8StatusLabelKey(status: VoiceSessionV8StatusView): string {
  return `voice.v8.status.${status}`;
}

/** i18n key for a VAD noise kind. */
export function voiceV8NoiseKindLabelKey(noiseKind: string): string {
  const known = ['silence', 'hum', 'fan', 'click', 'white', 'speech'];
  return `voice.v8.noise.${known.includes(noiseKind) ? noiseKind : 'unknown'}`;
}

/** i18n key for the input mode. */
export function voiceV8InputModeLabelKey(mode: VoiceSessionV8InputModeView): string {
  return `voice.v8.inputMode.${mode}`;
}

/**
 * Parse one session row from the IPC payload. Returns null when
 * the payload is not a session row at all (the panel then shows
 * "unavailable" instead of crashing on a malformed row).
 */
export function toVoiceSessionV8RowView(raw: unknown): VoiceSessionV8RowView | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asString(r['id']);
  if (id === '') return null;
  const statusRaw = asString(r['status'], 'idle');
  const status: VoiceSessionV8StatusView = isVoiceSessionV8Status(statusRaw) ? statusRaw : 'idle';
  const modeRaw = asString(r['inputMode'], 'auto');
  const inputMode: VoiceSessionV8InputModeView = modeRaw === 'push-to-talk' ? 'push-to-talk' : 'auto';
  return {
    id,
    status,
    inputMode,
    pttPressed: asBoolean(r['pttPressed'], false),
    callState: asString(r['callState'], 'idle'),
    phase: asString(r['phase'], 'idle'),
    provider: asString(r['provider'], 'openai'),
    voiceId: asNullableString(r['voiceId']),
    voiceName: asNullableString(r['voiceName']),
    connected: asBoolean(r['connected'], false),
    startedAtMs: asNullableNumber(r['startedAtMs']),
    durationMs: Math.max(0, asNumber(r['durationMs'], 0)),
    inputTokens: Math.max(0, asNumber(r['inputTokens'], 0)),
    outputTokens: Math.max(0, asNumber(r['outputTokens'], 0)),
    lines: Math.max(0, asNumber(r['lines'], 0)),
    turns: Math.max(0, asNumber(r['turns'], 0)),
    interrupts: Math.max(0, asNumber(r['interrupts'], 0)),
    thinkingInterrupts: Math.max(0, asNumber(r['thinkingInterrupts'], 0)),
    ducks: Math.max(0, asNumber(r['ducks'], 0)),
    echoOnlyFrames: Math.max(0, asNumber(r['echoOnlyFrames'], 0)),
    reconnects: Math.max(0, asNumber(r['reconnects'], 0)),
    vadEngine: asString(r['vadEngine'], 'auto'),
    vadPreset: asString(r['vadPreset'], 'office'),
    level: Math.min(1, Math.max(0, asNumber(r['level'], 0))),
    snapshotSaved: asBoolean(r['snapshotSaved'], false),
    restoredFrom: asBoolean(r['restoredFrom'], false),
  };
}

/** Parse a session list payload (rows that fail parsing are dropped). */
export function toVoiceSessionV8RowViews(raw: unknown): VoiceSessionV8RowView[] {
  if (!Array.isArray(raw)) return [];
  const out: VoiceSessionV8RowView[] = [];
  for (const item of raw) {
    const row = toVoiceSessionV8RowView(item);
    if (row) out.push(row);
  }
  return out;
}

/** Parse the VAD v8 stats payload for the panel. Null when malformed. */
export function toVoiceV8VadView(raw: unknown): VoiceV8VadView | null {
  const r = asRecord(raw);
  if (!r) return null;
  const floors = asRecord(r['bandFloors']);
  const byReason = asRecord(r['falsePositivesByReason']);
  const byNoise = asRecord(r['falsePositivesByNoise']);
  const reasonOut: Record<string, number> = {};
  if (byReason) for (const [k, v] of Object.entries(byReason)) reasonOut[k] = asNumber(v, 0);
  const noiseOut: Record<string, number> = {};
  if (byNoise) for (const [k, v] of Object.entries(byNoise)) noiseOut[k] = asNumber(v, 0);
  return {
    engine: asString(r['engine'], 'auto'),
    preset: asString(r['preset'], 'office'),
    threshold: asNumber(r['threshold'], 0),
    noiseFloor: asNumber(r['noiseFloor'], 0),
    bandFloors: {
      low: floors ? asNumber(floors['low'], 0) : 0,
      mid: floors ? asNumber(floors['mid'], 0) : 0,
      high: floors ? asNumber(floors['high'], 0) : 0,
    },
    level: asNumber(r['level'], 0),
    zcr: asNumber(r['zcr'], 0),
    spectralFlatness: asNumber(r['spectralFlatness'], 1),
    confidence: asNumber(r['confidence'], 0),
    noiseKind: asString(r['noiseKind'], 'silence'),
    hangoverMs: asNumber(r['hangoverMs'], 0),
    calibrating: asBoolean(r['calibrating'], false),
    turns: Math.max(0, asNumber(r['turns'], 0)),
    backchannels: Math.max(0, asNumber(r['backchannels'], 0)),
    falsePositives: Math.max(0, asNumber(r['falsePositives'], 0)),
    falsePositivesByReason: reasonOut,
    falsePositivesByNoise: noiseOut,
    meanEndLatencyMs: asNullableNumber(r['meanEndLatencyMs']),
    state: asString(r['state'], 'idle'),
  };
}

/** Parse the barge-in v8 stats payload for the panel. Null when malformed. */
export function toVoiceV8BargeInView(raw: unknown): VoiceV8BargeInView | null {
  const r = asRecord(raw);
  if (!r) return null;
  return {
    state: asString(r['state'], 'idle'),
    interrupts: Math.max(0, asNumber(r['interrupts'], 0)),
    thinkingInterrupts: Math.max(0, asNumber(r['thinkingInterrupts'], 0)),
    ducks: Math.max(0, asNumber(r['ducks'], 0)),
    ignored: Math.max(0, asNumber(r['ignored'], 0)),
    echoOnlyFrames: Math.max(0, asNumber(r['echoOnlyFrames'], 0)),
    meanResidualRatio: asNullableNumber(r['meanResidualRatio']),
    echoGain: Math.min(1, Math.max(0, asNumber(r['echoGain'], 0))),
    totalAudioDiscardedMs: Math.max(0, asNumber(r['totalAudioDiscardedMs'], 0)),
    totalWordsDiscarded: Math.max(0, asNumber(r['totalWordsDiscarded'], 0)),
    interruptsLastMinute: Math.max(0, asNumber(r['interruptsLastMinute'], 0)),
  };
}

/**
 * Build waveform bars from mic RMS levels (0..1 each). Keeps the
 * last `count` levels, newest last; the newest bar is marked live.
 * Levels are clamped to 0..1 and the bar height uses a sqrt curve
 * so quiet speech is still visible.
 */
export function waveformBars(levels: readonly number[], count = 24): WaveformBarView[] {
  const slice = levels.slice(Math.max(0, levels.length - Math.max(1, count)));
  return slice.map((level, i) => ({
    index: i,
    height: Math.min(1, Math.max(0, Math.sqrt(Math.min(1, Math.max(0, level))))),
    live: i === slice.length - 1,
  }));
}

/** Append one level to the waveform history (capped at `count`). Returns a new array. */
export function appendWaveformLevel(levels: readonly number[], level: number, count = 24): number[] {
  const next = [...levels, Math.min(1, Math.max(0, level))];
  return next.slice(Math.max(0, next.length - Math.max(1, count)));
}

/** Push-to-talk view: what the PTT button shows for a session row. */
export function pttView(row: VoiceSessionV8RowView): PttView {
  const isPtt = row.inputMode === 'push-to-talk';
  const enabled = isPtt && row.connected;
  return {
    inputMode: row.inputMode,
    pressed: row.pttPressed,
    micOpen: isPtt ? row.pttPressed : row.connected,
    labelKey: isPtt
      ? row.pttPressed
        ? 'voice.v8.ptt.release'
        : 'voice.v8.ptt.press'
      : 'voice.v8.ptt.auto',
    enabled,
  };
}

/** One-line status summary for the panel header (already translated parts come from the caller). */
export function voiceV8StatusSummary(row: VoiceSessionV8RowView): string {
  const base = `${row.status} · ${row.inputMode} · ${row.provider}`;
  const extra =
    row.status === 'reconnecting'
      ? ` · reconnect #${row.reconnects + 1}`
      : row.status === 'speaking'
        ? ` · ${row.interrupts} interrupts`
        : '';
  return base + extra;
}

/** Format a duration (ms) as m:ss for the panel. */
export function formatVoiceV8Duration(durationMs: number): string {
  const totalSec = Math.max(0, Math.floor(durationMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/** Format an audio amount (ms) as e.g. "1.2s" for the discarded-audio readout. */
export function formatVoiceV8AudioMs(audioMs: number): string {
  if (audioMs < 1000) return `${Math.round(audioMs)}ms`;
  return `${(audioMs / 1000).toFixed(1)}s`;
}
