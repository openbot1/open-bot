/**
 * Voice session v7 view models (v1.08, Team T5 — voice v7 + UI).
 *
 * Renderer-local mirror of the core v7 session shapes (the
 * BudgetMeter pattern): the renderer must NOT value-import from
 * `@open-bot/core` — the core bundles are CJS and vite inlines
 * them verbatim, which throws `ReferenceError: exports is not
 * defined` at startup and leaves a blank screen. This module
 * owns the view contract instead: defensive parsing of the IPC
 * payloads (`voice-v7:*` returns plain JSON), duration / token
 * formatting, and the transcript filtering the panel needs. Pure
 * functions, no React, no DOM, no IPC — unit-tested with plain
 * node --test (see tests/voice-v108.test.mjs).
 */

/** One row in the voice session list (as the IPC returns it). */
export interface VoiceSessionV7RowView {
  id: string;
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
  interrupts: number;
  ducks: number;
  restoredFrom: boolean;
}

/** One transcript line in the streaming view. */
export interface TranscriptV7LineView {
  id: string;
  speaker: 'user' | 'agent';
  text: string;
  isFinal: boolean;
  confidence: number;
  startedAtMs: number;
  endedAtMs: number | null;
  interrupted: boolean;
  tokensEstimate: number;
}

/** VAD status for the panel (thresholds + false positives). */
export interface VoiceV7VadView {
  preset: string;
  threshold: number;
  noiseFloor: number;
  level: number;
  zcr: number;
  confidence: number;
  turns: number;
  backchannels: number;
  falsePositives: number;
  state: string;
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

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parse one session row from the IPC payload. Returns null when
 * the payload is not a session row at all (the panel then shows
 * "unavailable" instead of crashing on a malformed row).
 */
export function toVoiceSessionV7RowView(raw: unknown): VoiceSessionV7RowView | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asString(r['id']);
  if (id === '') return null;
  return {
    id,
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
    interrupts: Math.max(0, asNumber(r['interrupts'], 0)),
    ducks: Math.max(0, asNumber(r['ducks'], 0)),
    restoredFrom: asBoolean(r['restoredFrom'], false),
  };
}

/** Parse a session list payload (rows that fail parsing are dropped). */
export function toVoiceSessionV7RowViews(raw: unknown): VoiceSessionV7RowView[] {
  if (!Array.isArray(raw)) return [];
  const out: VoiceSessionV7RowView[] = [];
  for (const item of raw) {
    const row = toVoiceSessionV7RowView(item);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Parse one transcript line from the IPC payload. Returns null
 * when the payload is not a line (empty text lines are kept —
 * they still carry timing — but a missing id/speaker is not).
 */
export function toTranscriptV7LineView(raw: unknown): TranscriptV7LineView | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asString(r['id']);
  const speaker = r['speaker'];
  if (id === '' || (speaker !== 'user' && speaker !== 'agent')) return null;
  return {
    id,
    speaker,
    text: asString(r['text']),
    isFinal: asBoolean(r['isFinal'], false),
    confidence: Math.max(0, Math.min(1, asNumber(r['confidence'], 1))),
    startedAtMs: asNumber(r['startedAtMs'], 0),
    endedAtMs: asNullableNumber(r['endedAtMs']),
    interrupted: asBoolean(r['interrupted'], false),
    tokensEstimate: Math.max(0, asNumber(r['tokensEstimate'], 0)),
  };
}

/** Parse a transcript payload (lines that fail parsing are dropped). */
export function toTranscriptV7LineViews(raw: unknown): TranscriptV7LineView[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptV7LineView[] = [];
  for (const item of raw) {
    const line = toTranscriptV7LineView(item);
    if (line) out.push(line);
  }
  return out;
}

/** Parse the VAD status payload (null when it is not VAD status). */
export function toVoiceV7VadView(raw: unknown): VoiceV7VadView | null {
  const r = asRecord(raw);
  if (!r) return null;
  const stats = asRecord(r['stats']) ?? r;
  return {
    preset: asString(asRecord(r['config'])?.['preset'] ?? stats['preset'], 'office'),
    threshold: asNumber(stats['threshold'], 0),
    noiseFloor: asNumber(stats['noiseFloor'], 0),
    level: asNumber(stats['level'], 0),
    zcr: asNumber(stats['zcr'], 0),
    confidence: Math.max(0, Math.min(1, asNumber(stats['confidence'], 0))),
    turns: Math.max(0, asNumber(stats['turns'], 0)),
    backchannels: Math.max(0, asNumber(stats['backchannels'], 0)),
    falsePositives: Math.max(0, asNumber(stats['falsePositives'], 0)),
    state: asString(stats['state'], 'idle'),
  };
}

/** Format a duration (ms) for the panel: "120ms" / "45s" / "1m 23s" / "1h 2m". */
export function formatVoiceV7Duration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  if (safe < 1_000) return `${safe}ms`;
  const totalSeconds = Math.floor(safe / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/** Format a token count with thousands separators (en-US, like BudgetMeter). */
export function formatVoiceV7Tokens(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString('en-US');
}

/** True when the session is live right now (connected, not ended). */
export function isVoiceV7SessionLive(row: VoiceSessionV7RowView): boolean {
  return row.connected && row.callState !== 'ended';
}

/** True when the session finished (disconnected after having run). */
export function isVoiceV7SessionFinished(row: VoiceSessionV7RowView): boolean {
  return !row.connected && row.startedAtMs !== null;
}

/** Split rows into running (live first) and finished, each newest first. */
export function splitVoiceV7Sessions(rows: readonly VoiceSessionV7RowView[]): {
  running: VoiceSessionV7RowView[];
  finished: VoiceSessionV7RowView[];
} {
  const running: VoiceSessionV7RowView[] = [];
  const finished: VoiceSessionV7RowView[] = [];
  for (const row of rows) {
    if (isVoiceV7SessionLive(row)) running.push(row);
    else finished.push(row);
  }
  const byStartDesc = (a: VoiceSessionV7RowView, b: VoiceSessionV7RowView): number =>
    (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0);
  running.sort(byStartDesc);
  finished.sort(byStartDesc);
  return { running, finished };
}

/** Filter transcript lines by speaker (undefined = all). */
export function filterTranscriptV7Lines(
  lines: readonly TranscriptV7LineView[],
  speaker?: 'user' | 'agent',
): TranscriptV7LineView[] {
  if (speaker === undefined) return [...lines];
  return lines.filter((line) => line.speaker === speaker);
}

/** The open interim line (the one still streaming), or null. */
export function openTranscriptV7Line(lines: readonly TranscriptV7LineView[]): TranscriptV7LineView | null {
  const last = lines[lines.length - 1];
  if (!last || last.isFinal) return null;
  return last;
}

/** One-line summary of a session row (logs / list subtitle). */
export function voiceV7SessionRowSummary(row: VoiceSessionV7RowView): string {
  const voice = row.voiceName ?? row.voiceId ?? 'no voice';
  return (
    `${row.id} (${row.provider}, ${voice}) — ${row.callState} / ${row.phase}, ` +
    `${formatVoiceV7Duration(row.durationMs)}, ` +
    `${formatVoiceV7Tokens(row.inputTokens)}+${formatVoiceV7Tokens(row.outputTokens)} tokens, ` +
    `${row.lines} line(s), ${row.interrupts} interrupt(s) / ${row.ducks} duck(s)`
  );
}

/** The transcript phases the panel badge can show. */
export const VOICE_V7_PHASES = ['idle', 'listening', 'thinking', 'speaking'] as const;

/** True when the phase is one of the transcript phases. */
export function isVoiceV7Phase(value: string): value is (typeof VOICE_V7_PHASES)[number] {
  return (VOICE_V7_PHASES as readonly string[]).includes(value);
}

/** The VAD presets the panel offers. */
export const VOICE_V7_VAD_PRESETS = ['quiet', 'office', 'noisy', 'very-noisy'] as const;

/** True when the name is a VAD preset the panel can offer. */
export function isVoiceV7VadPreset(value: string): value is (typeof VOICE_V7_VAD_PRESETS)[number] {
  return (VOICE_V7_VAD_PRESETS as readonly string[]).includes(value);
}
