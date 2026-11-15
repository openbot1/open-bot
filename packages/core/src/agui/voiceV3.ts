/**
 * AG-UI voice events v3 (v1.11, Đội T5 — voice realtime v2 + AG-UI v3).
 *
 * The 16 standard AG-UI event types (see `types.ts`) cover runs,
 * text, tool calls, state and generative UI — but a voice call is
 * none of those: the UI needs to know the mic is live, the agent
 * is speaking, a partial transcript just grew by one word, the
 * audio level moved, and the realtime socket fell back to batch.
 * v3 adds seven voice event types that travel the same bus, SSE and
 * IPC paths as the standard ones:
 *
 *   VOICE_STARTED          — a voice session opened (mode + voice)
 *   VOICE_STOPPED          — a voice session closed (reason + turns)
 *   VOICE_TRANSCRIPT_PARTIAL — a streaming interim hypothesis
 *   VOICE_TRANSCRIPT_FINAL — a committed turn (user or agent)
 *   VOICE_AUDIO_LEVEL      — mic / playback level, smoothed
 *   VOICE_STATE            — full voice state sync (the panel's
 *                            single source of truth)
 *   VOICE_FALLBACK         — realtime dropped, batch took over
 *
 * Compatibility: the 16 standard types are untouched (their tests
 * pin the count at 16), so voice events are a separate list
 * (`AG_UI_VOICE_EVENT_TYPES`) with their own union type. A voice
 * event bridges onto the standard bus as a `CUSTOM` event in the
 * `open-bot.voice` namespace (`voiceEventToCustom()`), so existing
 * consumers (bus, SSE, IPC validators) carry it unchanged — the
 * voice payload rides under `value.voice`, and `voiceEventFromCustom()`
 * recovers it on the other side. A consumer that only understands
 * the 16 standard types still sees a valid CUSTOM event; a consumer
 * that understands v3 reads the voice type directly.
 *
 * State sync: `VOICE_STATE` carries a `VoiceV3StateSnapshot` — the
 * panel applies it wholesale (no merge logic, no stale fields), and
 * the sequence number on the bus envelope lets the panel detect a
 * gap and ask for a fresh snapshot. Audio levels are smoothed
 * (EMA + peak hold) before they are emitted, so the waveform does
 * not jitter on every 20 ms frame.
 *
 * Every event is a plain JSON object (no functions, no class
 * instances) so it can travel over the harness bus, NDJSON logs,
 * IPC, WebSocket and SSE unchanged. Payloads are already
 * sanitised by the emitter: transcript text is capped, level is a
 * 0..1 number, no key material ever appears.
 */

import { AG_UI_PROTOCOL_VERSION, makeAgUiEvent, type AgUiEvent, type AgUiEventType } from './types';

/** Protocol marker for the voice extension (same version line as AG-UI). */
export const AG_UI_VOICE_PROTOCOL_VERSION = 'agui-voice/3.0';
/** CUSTOM namespace voice events bridge onto. */
export const AG_UI_VOICE_CUSTOM_NAMESPACE = 'open-bot.voice';

/** The 7 AG-UI voice event types (v3). */
export const AG_UI_VOICE_EVENT_TYPES = [
  'VOICE_STARTED',
  'VOICE_STOPPED',
  'VOICE_TRANSCRIPT_PARTIAL',
  'VOICE_TRANSCRIPT_FINAL',
  'VOICE_AUDIO_LEVEL',
  'VOICE_STATE',
  'VOICE_FALLBACK',
] as const;

export type AgUiVoiceEventType = (typeof AG_UI_VOICE_EVENT_TYPES)[number];

/** True when `value` is one of the 7 voice event types. */
export function isAgUiVoiceEventType(value: unknown): value is AgUiVoiceEventType {
  return (
    typeof value === 'string' &&
    (AG_UI_VOICE_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** Voice session mode reported by VOICE_STARTED / VOICE_STATE. */
export type AgUiVoiceMode = 'realtime' | 'batch';
/** Voice session status reported by VOICE_STATE. */
export type AgUiVoiceStatus = 'idle' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'degraded' | 'closed';
/** Why a voice session stopped. */
export type AgUiVoiceStopReason = 'user' | 'error' | 'timeout' | 'superseded';

/** Max chars of transcript text carried in one voice event. */
export const AG_UI_VOICE_MAX_TEXT_CHARS = 4000;
/** Max audio-level events kept in the log per run (bounded memory). */
export const AG_UI_VOICE_MAX_LOG_EVENTS = 500;

/** Payload of VOICE_STARTED. */
export interface AgUiVoiceStartedData {
  sessionId: string;
  mode: AgUiVoiceMode;
  provider: string;
  voice: string;
  language: string;
}

/** Payload of VOICE_STOPPED. */
export interface AgUiVoiceStoppedData {
  sessionId: string;
  reason: AgUiVoiceStopReason;
  turns: number;
  durationMs: number;
}

/** Payload of VOICE_TRANSCRIPT_PARTIAL. */
export interface AgUiVoiceTranscriptPartialData {
  sessionId: string;
  speakerId: string;
  text: string;
  /** True when the same hypothesis repeated (stable). */
  stable: boolean;
  /** ms from the first partial of this turn (null = first partial). */
  latencyMs: number | null;
}

/** Payload of VOICE_TRANSCRIPT_FINAL. */
export interface AgUiVoiceTranscriptFinalData {
  sessionId: string;
  speakerId: string;
  text: string;
  turnId?: string;
}

/** Payload of VOICE_AUDIO_LEVEL. */
export interface AgUiVoiceAudioLevelData {
  sessionId: string;
  /** Which side the level belongs to. */
  source: 'mic' | 'playback';
  /** Smoothed level 0..1. */
  level: number;
  /** Raw peak since the last emitted level (0..1). */
  peak: number;
}

/** Full voice state, carried by VOICE_STATE (panel source of truth). */
export interface AgUiVoiceStateSnapshot {
  sessionId: string;
  status: AgUiVoiceStatus;
  mode: AgUiVoiceMode;
  provider: string;
  voice: string;
  language: string;
  level: number;
  speaking: boolean;
  ducked: boolean;
  turns: number;
  userTurns: number;
  agentTurns: number;
  partials: number;
  fallbacks: number;
  interrupts: number;
  /** Live interim hypothesis (empty when none). */
  interimText: string;
  /** Last committed turn text (empty when none). */
  lastTurnText: string;
}

/** Payload of VOICE_STATE. */
export interface AgUiVoiceStateData {
  snapshot: AgUiVoiceStateSnapshot;
}

/** Payload of VOICE_FALLBACK. */
export interface AgUiVoiceFallbackData {
  sessionId: string;
  reason: string;
  detail: string;
  /** True when an automatic realtime retry is scheduled. */
  willRetry: boolean;
}

/** Payload of any voice event, keyed by type. */
export type AgUiVoiceEventData =
  | AgUiVoiceStartedData
  | AgUiVoiceStoppedData
  | AgUiVoiceTranscriptPartialData
  | AgUiVoiceTranscriptFinalData
  | AgUiVoiceAudioLevelData
  | AgUiVoiceStateData
  | AgUiVoiceFallbackData;

/** One AG-UI voice event (same envelope shape as `AgUiEvent`). */
export interface AgUiVoiceEvent {
  /** Protocol marker, always `agui-voice/3.0`. */
  protocol: typeof AG_UI_VOICE_PROTOCOL_VERSION;
  type: AgUiVoiceEventType;
  runId: string;
  botId?: string;
  threadId?: string;
  sessionId: string;
  /** Per-run monotonic sequence (0-based, assigned by the emitter). */
  sequence?: number;
  /** ISO-8601 timestamp, assigned by the emitter. */
  timestamp: string;
  data: AgUiVoiceEventData;
}

function capText(text: string): string {
  return text.slice(0, AG_UI_VOICE_MAX_TEXT_CHARS);
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.min(1, Math.max(0, level));
}

/** Build a minimal voice event; the emitter fills `sequence`. */
export function makeAgUiVoiceEvent(
  type: AgUiVoiceEventType,
  runId: string,
  sessionId: string,
  data: AgUiVoiceEventData,
  opts?: { botId?: string; threadId?: string; timestamp?: string },
): AgUiVoiceEvent {
  return {
    protocol: AG_UI_VOICE_PROTOCOL_VERSION,
    type,
    runId,
    ...(opts?.botId !== undefined ? { botId: opts.botId } : {}),
    ...(opts?.threadId !== undefined ? { threadId: opts.threadId } : {}),
    sessionId,
    timestamp: opts?.timestamp ?? new Date().toISOString(),
    data,
  };
}

/** Validate a voice event's shape (fail-closed, like `validate.ts`). */
export function validateAgUiVoiceEvent(event: unknown): { ok: true; event: AgUiVoiceEvent } | { ok: false; error: string } {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, error: 'voice event must be an object.' };
  }
  const e = event as Record<string, unknown>;
  if (e.protocol !== AG_UI_VOICE_PROTOCOL_VERSION) {
    return { ok: false, error: `voice event protocol must be "${AG_UI_VOICE_PROTOCOL_VERSION}".` };
  }
  if (!isAgUiVoiceEventType(e.type)) {
    return { ok: false, error: `unknown voice event type ${JSON.stringify(e.type)}.` };
  }
  if (typeof e.runId !== 'string' || e.runId.length === 0) {
    return { ok: false, error: 'voice event runId must be a non-empty string.' };
  }
  if (typeof e.sessionId !== 'string' || e.sessionId.length === 0) {
    return { ok: false, error: 'voice event sessionId must be a non-empty string.' };
  }
  if (typeof e.timestamp !== 'string' || e.timestamp.length === 0) {
    return { ok: false, error: 'voice event timestamp must be a non-empty string.' };
  }
  if (e.sequence !== undefined && (!Number.isInteger(e.sequence) || (e.sequence as number) < 0)) {
    return { ok: false, error: 'voice event sequence must be a non-negative integer.' };
  }
  if (e.data === null || typeof e.data !== 'object' || Array.isArray(e.data)) {
    return { ok: false, error: 'voice event data must be an object.' };
  }
  return { ok: true, event: event as AgUiVoiceEvent };
}

/**
 * Bridge a voice event onto the standard AG-UI bus as a CUSTOM
 * event in the `open-bot.voice` namespace. The voice type rides
 * under `value.voiceType` so a v3-aware consumer can recover it.
 */
export function voiceEventToCustom(event: AgUiVoiceEvent): AgUiEvent {
  return makeAgUiEvent(
    'CUSTOM' as AgUiEventType,
    event.runId,
    {
      name: AG_UI_VOICE_CUSTOM_NAMESPACE,
      value: { voiceType: event.type, sessionId: event.sessionId, ...(event.data as unknown as Record<string, unknown>) },
    },
    { botId: event.botId, threadId: event.threadId, timestamp: event.timestamp },
  );
}

/**
 * Recover a voice event from a CUSTOM event, or null when the event
 * is not a bridged voice event. Returns the event without a
 * sequence (the bus assigns its own sequence to the CUSTOM envelope).
 */
export function voiceEventFromCustom(event: AgUiEvent): AgUiVoiceEvent | null {
  if (event.type !== 'CUSTOM') return null;
  const data = event.data as { name?: unknown; value?: unknown };
  if (data.name !== AG_UI_VOICE_CUSTOM_NAMESPACE) return null;
  const value = data.value as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object') return null;
  if (!isAgUiVoiceEventType(value.voiceType)) return null;
  const sessionId = value.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const { voiceType, sessionId: _sid, ...rest } = value;
  void _sid;
  return {
    protocol: AG_UI_VOICE_PROTOCOL_VERSION,
    type: voiceType,
    runId: event.runId,
    ...(event.botId !== undefined ? { botId: event.botId } : {}),
    ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
    sessionId,
    timestamp: event.timestamp,
    data: rest as unknown as AgUiVoiceEventData,
  };
}

/** Build a VOICE_STARTED event. */
export function voiceStartedEvent(runId: string, data: AgUiVoiceStartedData, opts?: { botId?: string; threadId?: string }): AgUiVoiceEvent {
  return makeAgUiVoiceEvent('VOICE_STARTED', runId, data.sessionId, data, opts);
}

/** Build a VOICE_STOPPED event. */
export function voiceStoppedEvent(runId: string, data: AgUiVoiceStoppedData, opts?: { botId?: string; threadId?: string }): AgUiVoiceEvent {
  return makeAgUiVoiceEvent('VOICE_STOPPED', runId, data.sessionId, data, opts);
}

/** Build a VOICE_TRANSCRIPT_PARTIAL event (text capped). */
export function voicePartialEvent(
  runId: string,
  data: AgUiVoiceTranscriptPartialData,
  opts?: { botId?: string; threadId?: string },
): AgUiVoiceEvent {
  return makeAgUiVoiceEvent('VOICE_TRANSCRIPT_PARTIAL', runId, data.sessionId, { ...data, text: capText(data.text) }, opts);
}

/** Build a VOICE_TRANSCRIPT_FINAL event (text capped). */
export function voiceFinalEvent(
  runId: string,
  data: AgUiVoiceTranscriptFinalData,
  opts?: { botId?: string; threadId?: string },
): AgUiVoiceEvent {
  return makeAgUiVoiceEvent('VOICE_TRANSCRIPT_FINAL', runId, data.sessionId, { ...data, text: capText(data.text) }, opts);
}

/** Build a VOICE_AUDIO_LEVEL event (level clamped to 0..1). */
export function voiceAudioLevelEvent(
  runId: string,
  data: AgUiVoiceAudioLevelData,
  opts?: { botId?: string; threadId?: string },
): AgUiVoiceEvent {
  return makeAgUiVoiceEvent(
    'VOICE_AUDIO_LEVEL',
    runId,
    data.sessionId,
    { ...data, level: clampLevel(data.level), peak: clampLevel(data.peak) },
    opts,
  );
}

/** Build a VOICE_STATE event. */
export function voiceStateEvent(runId: string, data: AgUiVoiceStateData, opts?: { botId?: string; threadId?: string }): AgUiVoiceEvent {
  return makeAgUiVoiceEvent('VOICE_STATE', runId, data.snapshot.sessionId, data, opts);
}

/** Build a VOICE_FALLBACK event. */
export function voiceFallbackEvent(runId: string, data: AgUiVoiceFallbackData, opts?: { botId?: string; threadId?: string }): AgUiVoiceEvent {
  return makeAgUiVoiceEvent('VOICE_FALLBACK', runId, data.sessionId, data, opts);
}

/**
 * Audio-level smoother: EMA over raw levels plus a peak hold that
 * decays slowly, so the waveform the UI draws does not jitter on
 * every 20 ms frame. Pure data — the pipeline feeds raw RMS, the
 * panel reads `level` (smooth) and `peak` (hold).
 */
export class VoiceAudioLevelSmoother {
  private level = 0;
  private peak = 0;
  private readonly attack: number;
  private readonly release: number;
  private readonly peakDecay: number;

  constructor(input: { attack?: number; release?: number; peakDecay?: number } = {}) {
    this.attack = input.attack ?? 0.5;
    this.release = input.release ?? 0.08;
    this.peakDecay = input.peakDecay ?? 0.94;
    for (const [name, value] of [['attack', this.attack], ['release', this.release], ['peakDecay', this.peakDecay]] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`Voice audio level smoother ${name} must be a finite number in 0..1.`);
      }
    }
  }

  /** Feed one raw level (0..1, typically frame RMS). */
  push(rawLevel: number): { level: number; peak: number } {
    const raw = clampLevel(rawLevel);
    const rate = raw > this.level ? this.attack : this.release;
    this.level += (raw - this.level) * rate;
    this.peak = Math.max(this.peak * this.peakDecay, raw);
    return { level: this.level, peak: this.peak };
  }

  getLevel(): { level: number; peak: number } {
    return { level: this.level, peak: this.peak };
  }

  reset(): void {
    this.level = 0;
    this.peak = 0;
  }
}

/**
 * Bounded per-run log of voice events with gap detection: the panel
 * subscribes, and when a sequence number jumps it knows it missed
 * events and should ask for a fresh VOICE_STATE snapshot.
 */
export class VoiceV3EventLog {
  private readonly events: AgUiVoiceEvent[] = [];
  private nextSequence = 0;
  private gaps = 0;

  /** Append an event (assigns the next sequence). Returns the stored event. */
  append(event: AgUiVoiceEvent): AgUiVoiceEvent {
    const stored: AgUiVoiceEvent = { ...event, sequence: this.nextSequence };
    this.nextSequence += 1;
    this.events.push(stored);
    while (this.events.length > AG_UI_VOICE_MAX_LOG_EVENTS) this.events.shift();
    return stored;
  }

  /** Record that a gap was observed (sequence jump on the bus). */
  noteGap(missed: number): void {
    if (missed > 0) this.gaps += missed;
  }

  list(): AgUiVoiceEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  ofType(type: AgUiVoiceEventType): AgUiVoiceEvent[] {
    return this.list().filter((e) => e.type === type);
  }

  getGaps(): number {
    return this.gaps;
  }

  getNextSequence(): number {
    return this.nextSequence;
  }

  clear(): void {
    this.events.length = 0;
    this.nextSequence = 0;
    this.gaps = 0;
  }
}

/** Build a VOICE_STATE snapshot from pipeline-shaped stats. */
export function buildVoiceStateSnapshot(input: {
  sessionId: string;
  status: AgUiVoiceStatus;
  mode: AgUiVoiceMode;
  provider: string;
  voice: string;
  language: string;
  level: number;
  speaking: boolean;
  ducked: boolean;
  turns: number;
  userTurns: number;
  agentTurns: number;
  partials: number;
  fallbacks: number;
  interrupts: number;
  interimText: string;
  lastTurnText: string;
}): AgUiVoiceStateSnapshot {
  return {
    ...input,
    level: clampLevel(input.level),
    interimText: capText(input.interimText),
    lastTurnText: capText(input.lastTurnText),
  };
}
