/**
 * Voice session v9 view models (v1.10, Đội T5 — voice v5 + UI).
 *
 * Renderer-local mirror of the core v9 session shapes (the
 * BudgetMeter pattern): the renderer must NOT value-import from
 * `@open-bot/core` — the core bundles are CJS and vite inlines
 * them verbatim, which throws `ReferenceError: exports is not
 * defined` at startup and leaves a blank screen. This module
 * owns the view contract instead: defensive parsing of the IPC
 * payloads (`voice-v9:*` returns plain JSON), the four-state
 * session status (idle / listening / speaking / processing), the
 * waveform bars from mic RMS levels, the streaming transcript
 * rows (interim + committed turns), the barge-in receipt view and
 * the push-to-talk state machine. Pure functions, no React, no
 * DOM, no IPC — unit-tested with plain node --test (see
 * tests/voice-v110.test.mjs).
 */

/** UI status of a v9 voice session (what the panel renders). */
export type VoiceSessionV9StatusView = 'idle' | 'listening' | 'speaking' | 'processing';

/** Input mode. */
export type VoiceSessionV9InputModeView = 'auto' | 'push-to-talk';

/** One row in the voice session list (as the IPC returns it). */
export interface VoiceSessionV9RowView {
  id: string;
  status: VoiceSessionV9StatusView;
  inputMode: VoiceSessionV9InputModeView;
  pttPressed: boolean;
  botId: string;
  language: string;
  voice: string;
  connected: boolean;
  durationMs: number;
  userTurns: number;
  agentTurns: number;
  turns: number;
  partials: number;
  toolCalls: number;
  interrupts: number;
  ducks: number;
  pttPresses: number;
  vadPreset: string;
  vadFloor: number;
  vadSpeaking: boolean;
  vadTurns: number;
  vadBackchannels: number;
  vadFalseStarts: number;
  bargeInPolicy: string;
  bargeInDucked: boolean;
  level: number;
  liveAvailable: boolean | null;
}

/** VAD v9 status for the panel. */
export interface VoiceV9VadView {
  preset: string;
  startRatio: number;
  stopRatio: number;
  hangoverMs: number;
  floor: number;
  level: number;
  speaking: boolean;
  turns: number;
  backchannels: number;
  falseStarts: number;
  speechMs: number;
}

/** Barge-in v9 status for the panel (policy + cut receipt). */
export interface VoiceV9BargeInView {
  policy: string;
  graceMs: number;
  cooldownMs: number;
  duckFactor: number;
  ducked: boolean;
  attempts: number;
  interrupts: number;
  ignoredCooldown: number;
  ignoredEcho: number;
  ignoredTooShort: number;
  ducks: number;
  resumes: number;
  lastInterruptAtMs: number | null;
  lastCutWord: string | null;
  lastPlayedMs: number | null;
  lastDiscardedMs: number | null;
}

/** One transcript row for the panel (committed turn or live interim). */
export interface VoiceV9TranscriptRowView {
  id: string;
  speakerId: string;
  text: string;
  interim: boolean;
  startedAtMs: number;
  endedAtMs: number | null;
  toolCalls: { name: string; ok: boolean }[];
}

/** One waveform bar (the panel renders these as vertical bars). */
export interface WaveformBarView {
  /** Bar index (0 = oldest). */
  index: number;
  /** Normalised level 0..1. */
  level: number;
}

/** i18n key for a v9 session status. */
export function voiceV9StatusLabelKey(status: VoiceSessionV9StatusView): string {
  return `voice.v9.status.${status}`;
}

/** i18n key for a v9 input mode. */
export function voiceV9InputModeLabelKey(mode: VoiceSessionV9InputModeView): string {
  return `voice.v9.inputMode.${mode}`;
}

/** i18n key for the PTT button label in its current state. */
export function voiceV9PttLabelKey(inputMode: VoiceSessionV9InputModeView, pressed: boolean): string {
  if (inputMode !== 'push-to-talk') return 'voice.v9.ptt.auto';
  return pressed ? 'voice.v9.ptt.release' : 'voice.v9.ptt.press';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStatus(value: unknown): VoiceSessionV9StatusView {
  return value === 'listening' || value === 'speaking' || value === 'processing' ? value : 'idle';
}

function parseInputMode(value: unknown): VoiceSessionV9InputModeView {
  return value === 'push-to-talk' ? 'push-to-talk' : 'auto';
}

/** Parse one session row from an IPC payload (defensive: missing fields fall back). */
export function toVoiceSessionV9RowView(payload: unknown): VoiceSessionV9RowView | null {
  if (!isRecord(payload)) return null;
  const id = asString(payload['sessionId'] ?? payload['id']);
  if (id.length === 0) return null;
  const vad = isRecord(payload['vad']) ? payload['vad'] : {};
  const bargeIn = isRecord(payload['bargeIn']) ? payload['bargeIn'] : {};
  return {
    id,
    status: parseStatus(payload['status']),
    inputMode: parseInputMode(payload['inputMode']),
    pttPressed: asBoolean(payload['pttPressed']),
    botId: asString(payload['botId'], 'default'),
    language: asString(payload['language'], 'en'),
    voice: asString(payload['voice'], 'default'),
    connected: asBoolean(payload['connected'], parseStatus(payload['status']) !== 'idle'),
    durationMs: asNumber(payload['connectedMs'] ?? payload['durationMs']),
    userTurns: asNumber(payload['userTurns']),
    agentTurns: asNumber(payload['agentTurns']),
    turns: asNumber(payload['turns']),
    partials: asNumber(payload['partials']),
    toolCalls: asNumber(payload['toolCalls']),
    interrupts: asNumber(payload['interrupts']),
    ducks: asNumber(payload['ducks']),
    pttPresses: asNumber(payload['pttPresses']),
    vadPreset: asString(vad['preset'], 'office'),
    vadFloor: asNumber(vad['floor']),
    vadSpeaking: asBoolean(vad['speaking']),
    vadTurns: asNumber(vad['turns']),
    vadBackchannels: asNumber(vad['backchannels']),
    vadFalseStarts: asNumber(vad['falseStarts']),
    bargeInPolicy: asString(bargeIn['policy'], 'grace'),
    bargeInDucked: asBoolean(bargeIn['ducked']),
    level: Math.min(1, Math.max(0, asNumber(payload['level']))),
    liveAvailable: typeof payload['liveAvailable'] === 'boolean' ? payload['liveAvailable'] : null,
  };
}

/** Parse many session rows (skips unparseable entries). */
export function toVoiceSessionV9RowViews(payload: unknown): VoiceSessionV9RowView[] {
  if (!Array.isArray(payload)) return [];
  const rows: VoiceSessionV9RowView[] = [];
  for (const item of payload) {
    const row = toVoiceSessionV9RowView(item);
    if (row) rows.push(row);
  }
  return rows;
}

/** Parse a VAD v9 status payload for the panel. */
export function toVoiceV9VadView(payload: unknown): VoiceV9VadView | null {
  if (!isRecord(payload)) return null;
  return {
    preset: asString(payload['preset'], 'office'),
    startRatio: asNumber(payload['startRatio'], 3),
    stopRatio: asNumber(payload['stopRatio'], 1.8),
    hangoverMs: asNumber(payload['hangoverMs'], 400),
    floor: asNumber(payload['floor']),
    level: Math.min(1, Math.max(0, asNumber(payload['level']))),
    speaking: asBoolean(payload['speaking']),
    turns: asNumber(payload['turns']),
    backchannels: asNumber(payload['backchannels']),
    falseStarts: asNumber(payload['falseStarts']),
    speechMs: asNumber(payload['speechMs']),
  };
}

/** Parse a barge-in v9 status payload for the panel. */
export function toVoiceV9BargeInView(payload: unknown): VoiceV9BargeInView | null {
  if (!isRecord(payload)) return null;
  const receipt = isRecord(payload['lastInterrupt']) ? payload['lastInterrupt'] : {};
  return {
    policy: asString(payload['policy'], 'grace'),
    graceMs: asNumber(payload['graceMs'], 300),
    cooldownMs: asNumber(payload['cooldownMs'], 1500),
    duckFactor: asNumber(payload['duckFactor'], 0.35),
    ducked: asBoolean(payload['ducked']),
    attempts: asNumber(payload['attempts']),
    interrupts: asNumber(payload['interrupts']),
    ignoredCooldown: asNumber(payload['ignoredCooldown']),
    ignoredEcho: asNumber(payload['ignoredEcho']),
    ignoredTooShort: asNumber(payload['ignoredTooShort']),
    ducks: asNumber(payload['ducks']),
    resumes: asNumber(payload['resumes']),
    lastInterruptAtMs: typeof payload['lastInterruptAtMs'] === 'number' ? payload['lastInterruptAtMs'] : null,
    lastCutWord: typeof receipt['cutWord'] === 'string' && receipt['cutWord'].length > 0 ? receipt['cutWord'] : null,
    lastPlayedMs: typeof receipt['playedMs'] === 'number' ? receipt['playedMs'] : null,
    lastDiscardedMs: typeof receipt['discardedMs'] === 'number' ? receipt['discardedMs'] : null,
  };
}

/** Parse transcript rows (committed turns + optional live interim). */
export function toVoiceV9TranscriptRows(payload: unknown): VoiceV9TranscriptRowView[] {
  if (!isRecord(payload)) return [];
  const rows: VoiceV9TranscriptRowView[] = [];
  const turns = Array.isArray(payload['turns']) ? payload['turns'] : [];
  for (const item of turns) {
    if (!isRecord(item)) continue;
    const id = asString(item['id']);
    if (id.length === 0) continue;
    const toolCalls = Array.isArray(item['toolCalls'])
      ? item['toolCalls'].filter(isRecord).map((c) => ({ name: asString(c['name']), ok: asBoolean(c['ok']) }))
      : [];
    rows.push({
      id,
      speakerId: asString(item['speakerId'], 'user'),
      text: asString(item['text']),
      interim: false,
      startedAtMs: asNumber(item['startedAtMs']),
      endedAtMs: typeof item['endedAtMs'] === 'number' ? item['endedAtMs'] : null,
      toolCalls,
    });
  }
  const interim = isRecord(payload['interim']) ? payload['interim'] : null;
  if (interim && asString(interim['text']).trim().length > 0) {
    rows.push({
      id: 'interim',
      speakerId: asString(interim['speakerId'], 'user'),
      text: asString(interim['text']),
      interim: true,
      startedAtMs: asNumber(interim['startedAtMs']),
      endedAtMs: null,
      toolCalls: [],
    });
  }
  return rows;
}

/** Build waveform bars from a list of mic RMS levels (0..1). */
export function waveformBarsV9(levels: number[], bars = 24): WaveformBarView[] {
  const count = Math.max(1, Math.floor(bars));
  const out: WaveformBarView[] = [];
  const window = Math.max(1, Math.ceil(levels.length / count));
  for (let i = 0; i < count; i += 1) {
    const slice = levels.slice(i * window, (i + 1) * window);
    const level = slice.length === 0 ? 0 : Math.min(1, Math.max(0, Math.max(...slice)));
    out.push({ index: i, level });
  }
  return out;
}

/** Append one level to a rolling level list (bounded). */
export function appendWaveformLevelV9(levels: number[], level: number, max = 240): number[] {
  const next = [...levels, Math.min(1, Math.max(0, level))];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** PTT view: what the button shows and whether it is held. */
export function pttViewV9(inputMode: VoiceSessionV9InputModeView, pressed: boolean): {
  visible: boolean;
  pressed: boolean;
  labelKey: string;
} {
  return {
    visible: inputMode === 'push-to-talk',
    pressed,
    labelKey: voiceV9PttLabelKey(inputMode, pressed),
  };
}

/** One-line status summary for a session row (for the list + a11y). */
export function voiceV9StatusSummary(row: VoiceSessionV9RowView): string {
  return `${row.id}: ${row.status}, ${row.turns} turns, ${row.interrupts} interrupts, ${row.toolCalls} tool calls`;
}

/** Format a duration in ms as `m:ss` (for the session panel). */
export function formatVoiceV9Duration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Format audio milliseconds as `1.2s` (for the cut receipt). */
export function formatVoiceV9AudioMs(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}
