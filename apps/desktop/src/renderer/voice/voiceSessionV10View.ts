/**
 * Voice session v10 view models (v1.11, Team T5 - voice v10 + UI).
 *
 * Renderer-local mirror of the core v10 session shapes (the
 * BudgetMeter pattern): the renderer must NOT value-import from
 * `@open-bot/core` — the core bundles are CJS and vite inlines
 * them verbatim, which throws `ReferenceError: exports is not
 * defined` at startup and leaves a blank screen. This module
 * owns the view contract instead: defensive parsing of the IPC
 * payloads (`voice-v10:*` returns plain JSON), the seven-state
 * realtime status (idle / connecting / listening / processing /
 * speaking / degraded / closed), the streaming partial transcript
 * with stability, the smoothed waveform bars from mic RMS levels,
 * the VAD v10 + noise suppression views, the AG-UI voice state
 * snapshot, the batch-fallback banner and the per-bot voice preset
 * picker. Pure functions, no React, no DOM, no IPC — unit-tested
 * with plain node --test (see tests/voice-v111.test.mjs).
 */

/** UI status of a v10 voice session (what the panel renders). */
export type VoiceSessionV10StatusView =
  | 'idle' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'degraded' | 'closed';

/** Pipeline mode. */
export type VoiceSessionV10ModeView = 'realtime' | 'batch';

/** One row in the voice session list (as the IPC returns it). */
export interface VoiceSessionV10RowView {
  id: string;
  status: VoiceSessionV10StatusView;
  mode: VoiceSessionV10ModeView;
  botId: string;
  language: string;
  voice: string;
  provider: string;
  connected: boolean;
  durationMs: number;
  turns: number;
  userTurns: number;
  agentTurns: number;
  partials: number;
  stablePartials: number;
  fallbacks: number;
  recoveries: number;
  interrupts: number;
  ducks: number;
  level: number;
  peak: number;
  liveAvailable: boolean | null;
}

/** VAD v10 status for the panel. */
export interface VoiceV10VadView {
  preset: string;
  lowFloor: number;
  highFloor: number;
  level: number;
  speaking: boolean;
  turns: number;
  backchannels: number;
  falseStarts: number;
  doubleTalkFrames: number;
  humRejections: number;
  hissRejections: number;
  echoRejections: number;
  floorShifts: number;
  speechMs: number;
}

/** Noise suppression status for the panel. */
export interface VoiceV10NoiseView {
  level: string;
  gain: number;
  suppressionDb: number;
  profileReady: boolean;
  profileStale: boolean;
  suppressedFrames: number;
  heavyFrames: number;
}

/** Latency view (first partial + turn latency). */
export interface VoiceV10LatencyView {
  firstPartialMs: number | null;
  turnMs: number | null;
  meanTurnMs: number | null;
}

/** One transcript row (committed turn or live interim). */
export interface VoiceV10TranscriptRowView {
  id: string;
  speakerId: string;
  text: string;
  interim: boolean;
  /** True when the interim hypothesis repeated (stable). */
  stable: boolean;
  startedAtMs: number;
  endedAtMs: number | null;
  toolCalls: { name: string; ok: boolean }[];
}

/** One waveform bar (the panel renders these as vertical bars). */
export interface VoiceV10WaveformBarView {
  index: number;
  level: number;
  peak: number;
}

/** AG-UI voice state snapshot for the panel. */
export interface VoiceV10AgUiStateView {
  sessionId: string;
  status: VoiceSessionV10StatusView;
  mode: VoiceSessionV10ModeView;
  provider: string;
  voice: string;
  language: string;
  level: number;
  speaking: boolean;
  ducked: boolean;
  turns: number;
  fallbacks: number;
  interrupts: number;
  interimText: string;
  lastTurnText: string;
}

/** Batch-fallback banner (shown when realtime dropped). */
export interface VoiceV10FallbackView {
  visible: boolean;
  reason: string;
  detail: string;
  willRetry: boolean;
}

/** One bot voice preset for the picker. */
export interface VoiceV10PresetRowView {
  id: string;
  botId: string;
  name: string;
  provider: string;
  voice: string | null;
  language: string;
  rate: number;
  noiseSuppression: string;
  vadPreset: string;
  active: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

const V10_STATUSES: readonly string[] = ['idle', 'connecting', 'listening', 'processing', 'speaking', 'degraded', 'closed'];

function asV10Status(value: unknown): VoiceSessionV10StatusView {
  return typeof value === 'string' && V10_STATUSES.includes(value)
    ? (value as VoiceSessionV10StatusView)
    : 'idle';
}

function asV10Mode(value: unknown): VoiceSessionV10ModeView {
  return value === 'batch' ? 'batch' : 'realtime';
}

/** Parse a v10 session row for the panel (defensive — bad IPC never throws). */
export function toVoiceV10RowView(payload: unknown): VoiceSessionV10RowView | null {
  if (!isRecord(payload)) return null;
  const settings = isRecord(payload['settings']) ? payload['settings'] : {};
  const stats = isRecord(payload['stats']) ? payload['stats'] : payload;
  return {
    id: asString(payload['sessionId'] ?? payload['id']),
    status: asV10Status(payload['status'] ?? stats['state']),
    mode: asV10Mode(payload['mode'] ?? stats['mode']),
    botId: asString(payload['botId'], 'default'),
    language: asString(settings['language'] ?? payload['language'], 'en'),
    voice: asString(settings['voice'] ?? payload['voice']),
    provider: asString(settings['provider'] ?? payload['provider'], 'system'),
    connected: asBoolean(payload['connected'], asV10Status(payload['status'] ?? stats['state']) !== 'idle'),
    durationMs: asNumber(payload['durationMs'] ?? stats['connectedMs']),
    turns: asNumber(stats['turns']),
    userTurns: asNumber(stats['userTurns']),
    agentTurns: asNumber(stats['agentTurns']),
    partials: asNumber(stats['partials']),
    stablePartials: asNumber(stats['stablePartials']),
    fallbacks: asNumber(stats['fallbacks']),
    recoveries: asNumber(stats['recoveries']),
    interrupts: asNumber(stats['interrupts']),
    ducks: asNumber(stats['ducks']),
    level: Math.min(1, Math.max(0, asNumber(payload['level']))),
    peak: Math.min(1, Math.max(0, asNumber(payload['peak']))),
    liveAvailable: typeof payload['liveAvailable'] === 'boolean' ? payload['liveAvailable'] : null,
  };
}

/** Parse a VAD v10 status payload for the panel. */
export function toVoiceV10VadView(payload: unknown): VoiceV10VadView | null {
  if (!isRecord(payload)) return null;
  return {
    preset: asString(payload['preset'], 'office'),
    lowFloor: asNumber(payload['lowFloor']),
    highFloor: asNumber(payload['highFloor']),
    level: Math.min(1, Math.max(0, asNumber(payload['level']))),
    speaking: asBoolean(payload['speaking']),
    turns: asNumber(payload['turns']),
    backchannels: asNumber(payload['backchannels']),
    falseStarts: asNumber(payload['falseStarts']),
    doubleTalkFrames: asNumber(payload['doubleTalkFrames']),
    humRejections: asNumber(payload['humRejections']),
    hissRejections: asNumber(payload['hissRejections']),
    echoRejections: asNumber(payload['echoRejections']),
    floorShifts: asNumber(payload['floorShifts']),
    speechMs: asNumber(payload['speechMs']),
  };
}

/** Parse a noise suppression status payload for the panel. */
export function toVoiceV10NoiseView(payload: unknown): VoiceV10NoiseView | null {
  if (!isRecord(payload)) return null;
  return {
    level: asString(payload['level'], 'moderate'),
    gain: Math.min(1, Math.max(0, asNumber(payload['lastGain'], 1))),
    suppressionDb: asNumber(payload['meanSuppressionDb']),
    profileReady: asBoolean(payload['profileReady']),
    profileStale: asBoolean(payload['profileStale']),
    suppressedFrames: asNumber(payload['suppressedFrames']),
    heavyFrames: asNumber(payload['heavyFrames']),
  };
}

/** Parse latency stats for the panel. */
export function toVoiceV10LatencyView(payload: unknown): VoiceV10LatencyView | null {
  if (!isRecord(payload)) return null;
  return {
    firstPartialMs: asNullableNumber(payload['firstPartialLatencyMs']),
    turnMs: asNullableNumber(payload['turnLatencyMs']),
    meanTurnMs: asNullableNumber(payload['meanTurnLatencyMs']),
  };
}

/** Parse transcript rows (committed turns + optional live interim with stability). */
export function toVoiceV10TranscriptRows(payload: unknown): VoiceV10TranscriptRowView[] {
  if (!isRecord(payload)) return [];
  const rows: VoiceV10TranscriptRowView[] = [];
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
      stable: true,
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
      stable: asBoolean(interim['stable']),
      startedAtMs: asNumber(interim['startedAtMs']),
      endedAtMs: null,
      toolCalls: [],
    });
  }
  return rows;
}

/** Parse an AG-UI voice state snapshot for the panel. */
export function toVoiceV10AgUiStateView(payload: unknown): VoiceV10AgUiStateView | null {
  const snapshot = isRecord(payload) && isRecord(payload['snapshot']) ? payload['snapshot'] : payload;
  if (!isRecord(snapshot)) return null;
  return {
    sessionId: asString(snapshot['sessionId']),
    status: asV10Status(snapshot['status']),
    mode: asV10Mode(snapshot['mode']),
    provider: asString(snapshot['provider'], 'system'),
    voice: asString(snapshot['voice']),
    language: asString(snapshot['language'], 'en'),
    level: Math.min(1, Math.max(0, asNumber(snapshot['level']))),
    speaking: asBoolean(snapshot['speaking']),
    ducked: asBoolean(snapshot['ducked']),
    turns: asNumber(snapshot['turns']),
    fallbacks: asNumber(snapshot['fallbacks']),
    interrupts: asNumber(snapshot['interrupts']),
    interimText: asString(snapshot['interimText']),
    lastTurnText: asString(snapshot['lastTurnText']),
  };
}

/** Build the fallback banner view from a VOICE_FALLBACK payload. */
export function toVoiceV10FallbackView(payload: unknown): VoiceV10FallbackView {
  if (!isRecord(payload)) return { visible: false, reason: '', detail: '', willRetry: false };
  return {
    visible: true,
    reason: asString(payload['reason']),
    detail: asString(payload['detail']),
    willRetry: asBoolean(payload['willRetry']),
  };
}

/** Parse bot voice preset rows for the picker (marks the active one). */
export function toVoiceV10PresetRows(payload: unknown, activeId?: string): VoiceV10PresetRowView[] {
  if (!isRecord(payload)) return [];
  const presets = Array.isArray(payload['presets']) ? payload['presets'] : [];
  const active = isRecord(payload['active']) ? asString(payload['active']['id']) : activeId ?? '';
  return presets.filter(isRecord).map((p) => ({
    id: asString(p['id']),
    botId: asString(p['botId'], 'default'),
    name: asString(p['name'], asString(p['id'])),
    provider: asString(p['provider'], 'system'),
    voice: typeof p['voice'] === 'string' ? p['voice'] : null,
    language: asString(p['language'], 'en'),
    rate: asNumber(p['rate'], 1),
    noiseSuppression: asString(p['noiseSuppression'], 'moderate'),
    vadPreset: asString(p['vadPreset'], 'office'),
    active: asString(p['id']) === active,
  }));
}

/**
 * Build waveform bars from a list of mic levels (0..1) and their
 * peaks. Each bar takes the max level in its window, so a short
 * loud burst stays visible; the peak rides above the level.
 */
export function waveformBarsV10(
  levels: number[],
  peaks: number[] = [],
  bars = 32,
): VoiceV10WaveformBarView[] {
  const count = Math.max(1, Math.floor(bars));
  const out: VoiceV10WaveformBarView[] = [];
  const window = Math.max(1, Math.ceil(levels.length / count));
  for (let i = 0; i < count; i += 1) {
    const slice = levels.slice(i * window, (i + 1) * window);
    const peakSlice = peaks.slice(i * window, (i + 1) * window);
    const level = slice.length === 0 ? 0 : Math.min(1, Math.max(0, Math.max(...slice)));
    const peak = peakSlice.length === 0 ? level : Math.min(1, Math.max(0, Math.max(...peakSlice, level)));
    out.push({ index: i, level, peak });
  }
  return out;
}

/** Append one level (and its peak) to rolling level lists (bounded). */
export function appendWaveformLevelV10(
  levels: number[],
  peaks: number[],
  level: number,
  peak: number,
  max = 240,
): { levels: number[]; peaks: number[] } {
  const nextLevels = [...levels, Math.min(1, Math.max(0, level))];
  const nextPeaks = [...peaks, Math.min(1, Math.max(0, peak))];
  return {
    levels: nextLevels.length > max ? nextLevels.slice(nextLevels.length - max) : nextLevels,
    peaks: nextPeaks.length > max ? nextPeaks.slice(nextPeaks.length - max) : nextPeaks,
  };
}

/** i18n key for the session status label (the component translates it). */
export function voiceV10StatusLabelKey(status: VoiceSessionV10StatusView): string {
  return `voice.realtime.v10.status.${status}`;
}

/** i18n key for the mode label. */
export function voiceV10ModeLabelKey(mode: VoiceSessionV10ModeView): string {
  return `voice.realtime.v10.mode.${mode}`;
}

/** One-line status summary for a session row (for the list + a11y). */
export function voiceV10StatusSummary(row: VoiceSessionV10RowView): string {
  return `${row.id}: ${row.status} (${row.mode}), ${row.turns} turns, ${row.fallbacks} fallbacks, ${row.interrupts} interrupts`;
}

/** Format a duration in ms as `m:ss` (for the session panel). */
export function formatVoiceV10Duration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Format latency in ms as `123ms` or `—` when unknown (for the panel). */
export function formatVoiceV10Latency(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms)}ms`;
}
