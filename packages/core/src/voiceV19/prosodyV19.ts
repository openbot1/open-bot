/**
 * Prosody control v19 (v1.27, Đội T5 — voice v19).
 *
 * v18 streamed TTS with one flat voice: every sentence left at the
 * same rate, pitch and pause, whatever the moment called for. A
 * warning read at bedtime speed and a bedtime story read at alarm
 * speed both sound wrong — and wrong-sounding speech is what the
 * v19 eval measures as low naturalness. v19 gives the voice a
 * prosody layer before the TTS stream:
 *
 *   1. Emotion contexts. Eight emotions (`neutral`, `happy`,
 *      `calm`, `urgent`, `empathetic`, `formal`, `excited`,
 *      `apologetic`), each a preset of rate / pitch / pauses /
 *      emphasis. A voice *context* from v17 (`chat`,
 *      `announcement`, `alert`, `narration`, `whisper`) maps to
 *      a default emotion, so existing callers get sensible
 *      prosody without changing a call.
 *   2. Overrides. Per-utterance partial overrides (rate only,
 *      pitch only, ...) clamp into the safe range instead of
 *      throwing — a bad override degrades to the preset, never
 *      to a broken stream.
 *   3. Clause segmentation. `applyProsodyToText()` splits an
 *      utterance into clauses at sentence and long-clause
 *      boundaries, attaches a pause before/after each clause,
 *      and estimates speaking time from characters-per-second
 *      at the resolved rate — the TTS stream and the eval both
 *      read the same segments.
 *   4. SSML. `prosodySsmlV19()` renders the same segments as
 *      plain SSML (`<prosody rate pitch>` + `<break>`). It is a
 *      pure string builder: no provider parses it here, the
 *      mock engine just speaks the plain text, but a real engine
 *      bound later can take the SSML verbatim.
 *
 * Everything is local and deterministic; no audio is produced
 * here, only the instructions for how the mock TTS should sound.
 */

import type { VoiceProfileV17Context } from '../voiceV17/voiceProfilesV17';
import { VOICE_V17_CONTEXTS } from '../voiceV17/voiceProfilesV17';

/** The eight emotion contexts prosody can express. */
export type ProsodyV19Emotion =
  | 'neutral'
  | 'happy'
  | 'calm'
  | 'urgent'
  | 'empathetic'
  | 'formal'
  | 'excited'
  | 'apologetic';

export const PROSODY_V19_EMOTIONS: readonly ProsodyV19Emotion[] = [
  'neutral',
  'happy',
  'calm',
  'urgent',
  'empathetic',
  'formal',
  'excited',
  'apologetic',
];

export function isProsodyV19Emotion(value: unknown): value is ProsodyV19Emotion {
  return (
    typeof value === 'string' &&
    (PROSODY_V19_EMOTIONS as readonly string[]).includes(value)
  );
}

export type ProsodyV19Emphasis = 'none' | 'moderate' | 'strong';

export const PROSODY_V19_EMPHASES: readonly ProsodyV19Emphasis[] = [
  'none',
  'moderate',
  'strong',
];

export function isProsodyV19Emphasis(value: unknown): value is ProsodyV19Emphasis {
  return (
    typeof value === 'string' &&
    (PROSODY_V19_EMPHASES as readonly string[]).includes(value)
  );
}

/** One resolved prosody setting: everything the TTS needs. */
export interface ProsodyV19Settings {
  /** Speaking rate multiplier (0.5 = half speed, 2.0 = double). */
  rate: number;
  /** Pitch shift in semitones (-12..+12). */
  pitchSt: number;
  /** Pause before the utterance (ms). */
  pauseBeforeMs: number;
  /** Pause after the utterance (ms). */
  pauseAfterMs: number;
  /** Pause between clauses inside the utterance (ms). */
  clausePauseMs: number;
  emphasis: ProsodyV19Emphasis;
  /** Volume trim in dB (-12..+6). */
  volumeDb: number;
}

export type ProsodyV19Override = Partial<ProsodyV19Settings>;

export const PROSODY_V19_RATE_MIN = 0.5;
export const PROSODY_V19_RATE_MAX = 2.0;
export const PROSODY_V19_PITCH_MIN_ST = -12;
export const PROSODY_V19_PITCH_MAX_ST = 12;
export const PROSODY_V19_PAUSE_MIN_MS = 0;
export const PROSODY_V19_PAUSE_MAX_MS = 5_000;
export const PROSODY_V19_VOLUME_MIN_DB = -12;
export const PROSODY_V19_VOLUME_MAX_DB = 6;
/** Mock speaking speed at rate 1.0 (chars per second, Vietnamese/English mix). */
export const PROSODY_V19_BASE_CHARS_PER_SECOND = 14;

export function defaultProsodyV19Settings(): ProsodyV19Settings {
  return {
    rate: 1.0,
    pitchSt: 0,
    pauseBeforeMs: 120,
    pauseAfterMs: 250,
    clausePauseMs: 180,
    emphasis: 'none',
    volumeDb: 0,
  };
}

/** The emotion presets (rate, pitch, pauses, emphasis, volume). */
export function presetProsodyV19Settings(emotion: ProsodyV19Emotion): ProsodyV19Settings {
  const base = defaultProsodyV19Settings();
  switch (emotion) {
    case 'happy':
      return { ...base, rate: 1.12, pitchSt: 3, pauseBeforeMs: 100, pauseAfterMs: 220, clausePauseMs: 150, emphasis: 'moderate', volumeDb: 1 };
    case 'calm':
      return { ...base, rate: 0.88, pitchSt: -2, pauseBeforeMs: 200, pauseAfterMs: 420, clausePauseMs: 320, emphasis: 'none', volumeDb: -1 };
    case 'urgent':
      return { ...base, rate: 1.28, pitchSt: 4, pauseBeforeMs: 40, pauseAfterMs: 120, clausePauseMs: 90, emphasis: 'strong', volumeDb: 2 };
    case 'empathetic':
      return { ...base, rate: 0.9, pitchSt: -1, pauseBeforeMs: 220, pauseAfterMs: 450, clausePauseMs: 300, emphasis: 'moderate', volumeDb: -1 };
    case 'formal':
      return { ...base, rate: 0.97, pitchSt: 0, pauseBeforeMs: 150, pauseAfterMs: 300, clausePauseMs: 220, emphasis: 'none', volumeDb: 0 };
    case 'excited':
      return { ...base, rate: 1.22, pitchSt: 5, pauseBeforeMs: 60, pauseAfterMs: 180, clausePauseMs: 120, emphasis: 'strong', volumeDb: 2 };
    case 'apologetic':
      return { ...base, rate: 0.86, pitchSt: -3, pauseBeforeMs: 260, pauseAfterMs: 480, clausePauseMs: 340, emphasis: 'moderate', volumeDb: -2 };
    case 'neutral':
    default:
      return base;
  }
}

/** Default emotion for a v17 voice context (existing callers change nothing). */
export function defaultEmotionForContextV19(context: VoiceProfileV17Context): ProsodyV19Emotion {
  switch (context) {
    case 'alert':
      return 'urgent';
    case 'announcement':
      return 'formal';
    case 'narration':
      return 'calm';
    case 'whisper':
      return 'calm';
    case 'chat':
    default:
      return 'neutral';
  }
}

export function validateProsodyV19Settings(settings: ProsodyV19Settings): string[] {
  const errors: string[] = [];
  const num = (name: string, value: unknown, min: number, max: number): void => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${name} must be a finite number, got ${String(value)}`);
    } else if (value < min || value > max) {
      errors.push(`${name} must be ${min}..${max}, got ${value}`);
    }
  };
  num('rate', settings.rate, PROSODY_V19_RATE_MIN, PROSODY_V19_RATE_MAX);
  num('pitchSt', settings.pitchSt, PROSODY_V19_PITCH_MIN_ST, PROSODY_V19_PITCH_MAX_ST);
  num('pauseBeforeMs', settings.pauseBeforeMs, PROSODY_V19_PAUSE_MIN_MS, PROSODY_V19_PAUSE_MAX_MS);
  num('pauseAfterMs', settings.pauseAfterMs, PROSODY_V19_PAUSE_MIN_MS, PROSODY_V19_PAUSE_MAX_MS);
  num('clausePauseMs', settings.clausePauseMs, PROSODY_V19_PAUSE_MIN_MS, PROSODY_V19_PAUSE_MAX_MS);
  num('volumeDb', settings.volumeDb, PROSODY_V19_VOLUME_MIN_DB, PROSODY_V19_VOLUME_MAX_DB);
  if (!isProsodyV19Emphasis(settings.emphasis)) {
    errors.push(`emphasis must be one of ${PROSODY_V19_EMPHASES.join(', ')}, got ${String(settings.emphasis)}`);
  }
  return errors;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Clamp a setting into the safe range (a bad override degrades, never throws). */
export function clampProsodyV19Settings(settings: ProsodyV19Settings): ProsodyV19Settings {
  return {
    rate: clamp(settings.rate, PROSODY_V19_RATE_MIN, PROSODY_V19_RATE_MAX),
    pitchSt: clamp(settings.pitchSt, PROSODY_V19_PITCH_MIN_ST, PROSODY_V19_PITCH_MAX_ST),
    pauseBeforeMs: clamp(Math.floor(settings.pauseBeforeMs), PROSODY_V19_PAUSE_MIN_MS, PROSODY_V19_PAUSE_MAX_MS),
    pauseAfterMs: clamp(Math.floor(settings.pauseAfterMs), PROSODY_V19_PAUSE_MIN_MS, PROSODY_V19_PAUSE_MAX_MS),
    clausePauseMs: clamp(Math.floor(settings.clausePauseMs), PROSODY_V19_PAUSE_MIN_MS, PROSODY_V19_PAUSE_MAX_MS),
    emphasis: isProsodyV19Emphasis(settings.emphasis) ? settings.emphasis : 'none',
    volumeDb: clamp(settings.volumeDb, PROSODY_V19_VOLUME_MIN_DB, PROSODY_V19_VOLUME_MAX_DB),
  };
}

/** Merge a partial override onto a base setting, then clamp. */
export function applyProsodyV19Override(
  base: ProsodyV19Settings,
  override: ProsodyV19Override,
): ProsodyV19Settings {
  return clampProsodyV19Settings({ ...base, ...override });
}

/** One clause of an utterance, with its own prosody. */
export interface ProsodyV19Segment {
  index: number;
  text: string;
  /** Pause before this clause (ms). */
  pauseBeforeMs: number;
  /** Pause after this clause (ms). */
  pauseAfterMs: number;
  rate: number;
  pitchSt: number;
  emphasis: ProsodyV19Emphasis;
  /** Estimated speaking time for this clause (ms, mock model). */
  estimatedMs: number;
}

/** Estimated speaking time for `chars` characters at `rate`. */
export function estimateProsodyV19Ms(chars: number, rate: number): number {
  if (chars <= 0) return 0;
  const safeRate = clamp(rate, PROSODY_V19_RATE_MIN, PROSODY_V19_RATE_MAX);
  return Math.round((chars / (PROSODY_V19_BASE_CHARS_PER_SECOND * safeRate)) * 1000);
}

const SENTENCE_END_RE = /[.!?…]+["')\]]?\s+/g;
const LONG_CLAUSE_CHARS = 90;

/**
 * Split text into clauses: hard splits at sentence ends, soft splits
 * at commas/semicolons inside sentences longer than 90 chars. Empty
 * input yields no segments; whitespace-only yields none either.
 */
export function splitProsodyV19Clauses(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const sentences: string[] = [];
  let last = 0;
  for (const match of trimmed.matchAll(SENTENCE_END_RE)) {
    const end = (match.index ?? 0) + match[0].length;
    sentences.push(trimmed.slice(last, end).trim());
    last = end;
  }
  if (last < trimmed.length) sentences.push(trimmed.slice(last).trim());
  const clauses: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= LONG_CLAUSE_CHARS || !sentence.includes(',')) {
      clauses.push(sentence);
      continue;
    }
    // Long sentence: split at commas, keeping the comma on the left.
    const parts = sentence.split(/(?<=,)\s+/);
    let current = '';
    for (const part of parts) {
      const joined = current ? `${current} ${part}` : part;
      if (joined.length > LONG_CLAUSE_CHARS && current) {
        clauses.push(current.trim());
        current = part;
      } else {
        current = joined;
      }
    }
    if (current.trim()) clauses.push(current.trim());
  }
  return clauses.filter((c) => c.length > 0);
}

/**
 * Apply prosody to an utterance: segment it, attach pauses, estimate
 * timing. The first clause carries `pauseBeforeMs`, the last carries
 * `pauseAfterMs`; inner boundaries carry `clausePauseMs`.
 */
export function applyProsodyToTextV19(
  text: string,
  settings: ProsodyV19Settings,
): ProsodyV19Segment[] {
  const safe = clampProsodyV19Settings(settings);
  const clauses = splitProsodyV19Clauses(text);
  return clauses.map((clause, index) => {
    const isFirst = index === 0;
    const isLast = index === clauses.length - 1;
    return {
      index,
      text: clause,
      pauseBeforeMs: isFirst ? safe.pauseBeforeMs : safe.clausePauseMs,
      pauseAfterMs: isLast ? safe.pauseAfterMs : safe.clausePauseMs,
      rate: safe.rate,
      pitchSt: safe.pitchSt,
      emphasis: safe.emphasis,
      estimatedMs: estimateProsodyV19Ms(clause.length, safe.rate),
    };
  });
}

function escapeSsmlV19(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rateSsmlV19(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function pitchSsmlV19(pitchSt: number): string {
  const rounded = Math.round(pitchSt * 10) / 10;
  return `${rounded >= 0 ? '+' : ''}${rounded}st`;
}

/**
 * Render an utterance as SSML: one `<prosody>` per clause (rate +
 * pitch), `<break>` pauses between clauses, `<emphasis>` when the
 * setting asks for it. Pure string building — no provider call.
 */
export function prosodySsmlV19(text: string, settings: ProsodyV19Settings): string {
  const safe = clampProsodyV19Settings(settings);
  const segments = applyProsodyToTextV19(text, safe);
  if (segments.length === 0) return '<speak></speak>';
  const parts: string[] = ['<speak>'];
  for (const segment of segments) {
    if (segment.pauseBeforeMs > 0) {
      parts.push(`<break time="${segment.pauseBeforeMs}ms"/>`);
    }
    const inner = escapeSsmlV19(segment.text);
    const prosody =
      `<prosody rate="${rateSsmlV19(segment.rate)}" pitch="${pitchSsmlV19(segment.pitchSt)}">` +
      (segment.emphasis === 'none'
        ? inner
        : `<emphasis level="${segment.emphasis}">${inner}</emphasis>`) +
      '</prosody>';
    parts.push(prosody);
    if (segment.pauseAfterMs > 0) {
      parts.push(`<break time="${segment.pauseAfterMs}ms"/>`);
    }
  }
  parts.push('</speak>');
  return parts.join('');
}

/** Per-clause timing roll-up, for the eval and the panel. */
export interface ProsodyV19PlanStats {
  segments: number;
  chars: number;
  estimatedSpeechMs: number;
  estimatedPauseMs: number;
  estimatedTotalMs: number;
  /** Mean absolute deviation of per-clause rates (0 when uniform). */
  rateDeviation: number;
}

export function prosodyPlanStatsV19(segments: ProsodyV19Segment[]): ProsodyV19PlanStats {
  if (segments.length === 0) {
    return {
      segments: 0,
      chars: 0,
      estimatedSpeechMs: 0,
      estimatedPauseMs: 0,
      estimatedTotalMs: 0,
      rateDeviation: 0,
    };
  }
  const chars = segments.reduce((sum, s) => sum + s.text.length, 0);
  const estimatedSpeechMs = segments.reduce((sum, s) => sum + s.estimatedMs, 0);
  const estimatedPauseMs = segments.reduce(
    (sum, s) => sum + s.pauseBeforeMs + s.pauseAfterMs,
    0,
  );
  const meanRate = segments.reduce((sum, s) => sum + s.rate, 0) / segments.length;
  const rateDeviation =
    segments.reduce((sum, s) => sum + Math.abs(s.rate - meanRate), 0) / segments.length;
  return {
    segments: segments.length,
    chars,
    estimatedSpeechMs,
    estimatedPauseMs,
    estimatedTotalMs: estimatedSpeechMs + estimatedPauseMs,
    rateDeviation: Math.round(rateDeviation * 1000) / 1000,
  };
}

export interface ProsodyV19ControllerOptions {
  emotion?: ProsodyV19Emotion;
  context?: VoiceProfileV17Context;
  override?: ProsodyV19Override;
}

/**
 * Holds the current emotion + context + override and resolves the
 * effective setting for each utterance. History is bounded (last
 * 50 resolutions) so the panel can show "why does it sound like
 * this right now".
 */
export class ProsodyControllerV19 {
  private emotion: ProsodyV19Emotion;
  private context: VoiceProfileV17Context;
  private override: ProsodyV19Override;
  private readonly history: { atMs: number; emotion: ProsodyV19Emotion; settings: ProsodyV19Settings }[] = [];
  private nowMs = 0;

  constructor(options: ProsodyV19ControllerOptions = {}) {
    this.context = options.context ?? 'chat';
    this.emotion = options.emotion ?? defaultEmotionForContextV19(this.context);
    this.override = options.override ?? {};
  }

  setEmotion(emotion: ProsodyV19Emotion): void {
    if (!isProsodyV19Emotion(emotion)) throw new Error(`Unknown prosody emotion "${String(emotion)}".`);
    this.emotion = emotion;
  }

  setContext(context: VoiceProfileV17Context): void {
    if (!VOICE_V17_CONTEXTS.includes(context)) {
      throw new Error(`Unknown voice context "${String(context)}".`);
    }
    this.context = context;
    // A context change re-seeds the emotion only when the caller has
    // not explicitly picked one since the last context change — the
    // simple rule here: always follow the context default.
    this.emotion = defaultEmotionForContextV19(context);
  }

  setOverride(override: ProsodyV19Override): void {
    this.override = { ...override };
  }

  clearOverride(): void {
    this.override = {};
  }

  getEmotion(): ProsodyV19Emotion {
    return this.emotion;
  }

  getContext(): VoiceProfileV17Context {
    return this.context;
  }

  getOverride(): ProsodyV19Override {
    return { ...this.override };
  }

  tick(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.nowMs += Math.floor(ms);
  }

  /** Resolve the effective setting for the current emotion/context/override. */
  resolve(): ProsodyV19Settings {
    const settings = applyProsodyV19Override(
      presetProsodyV19Settings(this.emotion),
      this.override,
    );
    this.history.push({ atMs: this.nowMs, emotion: this.emotion, settings });
    while (this.history.length > 50) this.history.shift();
    return settings;
  }

  /** Segment + time one utterance with the resolved setting. */
  plan(text: string): { settings: ProsodyV19Settings; segments: ProsodyV19Segment[]; stats: ProsodyV19PlanStats } {
    const settings = this.resolve();
    const segments = applyProsodyToTextV19(text, settings);
    return { settings, segments, stats: prosodyPlanStatsV19(segments) };
  }

  /** SSML for one utterance with the resolved setting. */
  ssml(text: string): string {
    return prosodySsmlV19(text, this.resolve());
  }

  historyList(): { atMs: number; emotion: ProsodyV19Emotion; settings: ProsodyV19Settings }[] {
    return this.history.map((h) => ({ ...h, settings: { ...h.settings } }));
  }

  summary(): string {
    const settings = this.resolve();
    return (
      `prosody v19: ${this.emotion} (${this.context}) — rate ${settings.rate}x, ` +
      `pitch ${settings.pitchSt >= 0 ? '+' : ''}${settings.pitchSt}st, ` +
      `pauses ${settings.pauseBeforeMs}/${settings.clausePauseMs}/${settings.pauseAfterMs} ms, ` +
      `emphasis ${settings.emphasis}`
    );
  }

  markdown(): string {
    const settings = this.resolve();
    const lines = [
      '## Prosody v19',
      '',
      `- Emotion: ${this.emotion} (context ${this.context}).`,
      `- Rate ${settings.rate}x, pitch ${settings.pitchSt >= 0 ? '+' : ''}${settings.pitchSt}st, volume ${settings.volumeDb} dB.`,
      `- Pauses: before ${settings.pauseBeforeMs} ms, clause ${settings.clausePauseMs} ms, after ${settings.pauseAfterMs} ms.`,
      `- Emphasis: ${settings.emphasis}.`,
      `- History: ${this.history.length} resolution(s) kept (max 50).`,
    ];
    return lines.join('\n');
  }
}

export function createProsodyControllerV19(
  options: ProsodyV19ControllerOptions = {},
): ProsodyControllerV19 {
  return new ProsodyControllerV19(options);
}

export function prosodyV19Summary(settings: ProsodyV19Settings): string {
  const safe = clampProsodyV19Settings(settings);
  return (
    `rate ${safe.rate}x, pitch ${safe.pitchSt >= 0 ? '+' : ''}${safe.pitchSt}st, ` +
    `pauses ${safe.pauseBeforeMs}/${safe.clausePauseMs}/${safe.pauseAfterMs} ms, ` +
    `emphasis ${safe.emphasis}, volume ${safe.volumeDb} dB`
  );
}
