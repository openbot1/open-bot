/**
 * Voice activity detection v10 (v1.11, Đội T5 — voice realtime v2).
 *
 * v9 was one energy band + zero-crossing rate. It works in a quiet
 * room, but three real rooms break it: a humming fan (low-frequency
 * energy that looks like speech), a hissing air conditioner (broadband
 * noise that lifts the single floor until real speech is missed), and
 * double-talk (the agent's own playback leaking into the mic while
 * the user speaks). v10 adds the cheapest fixes that stay pure
 * arithmetic on PCM16 frames — no model, no FFT tables, no audio
 * device, no network:
 *
 * - Two bands from one pass: the low band is the raw sample energy,
 *   the high band is the first-difference energy (a cheap high-pass
 *   proxy). Speech carries both bands; a 50 Hz hum carries almost
 *   only the low band; broadband hiss carries mostly the high band.
 *   A frame counts as a speech candidate only when BOTH bands clear
 *   their own adaptive floor by their own ratio.
 * - Per-band adaptive noise floors (EMA over silence frames), so a
 *   fan turning on lifts the low floor without touching the high
 *   one, and the detector does not get stuck open.
 * - Spectral-flatness proxy: zero-crossing rate plus the high/low
 *   energy ratio. A loud frame with a very low ZCR and a collapsed
 *   high/low ratio is hum, not speech; a frame with an extreme ZCR
 *   and a blown-out high/low ratio is hiss, not speech.
 * - Double-talk flag: the caller marks frames that overlap agent
 *   playback (`echo: true` — the app knows what it just played).
 *   Echo-only frames never start a turn, and a speech-start that
 *   arrives while echo is active is reported as `double-talk`
 *   instead of a clean turn, so the session can duck instead of
 *   cutting the reply.
 * - Dynamic hangover (same idea as v9, kept): a long confident turn
 *   ends fast, a short uncertain turn keeps the full hangover, so
 *   pauses inside a sentence do not split the turn.
 * - Noise-floor-shift events: when either floor moves a lot in a
 *   short window (a door slams, a fan switches on), the session is
 *   told so it can show "noisy room" instead of silently missing
 *   the next turn.
 *
 * Behaviour:
 * - Frames are PCM16 mono at 16 kHz, 20 ms (320 samples) each.
 *   Anything else is rejected — the caller validates before calling.
 * - Speech starts when both bands stay above `floor * startRatio`
 *   for `minSpeechMs` (default 120 ms). A burst shorter than that
 *   is counted as a backchannel candidate, not a turn.
 * - Speech ends after `hangoverMs` (default 400 ms) of continuous
 *   silence. A burst that ends before `minTurnMs` is a backchannel
 *   when it is at least `minBackchannelMs`, otherwise a false start.
 * - Every decision is reported through events; stats count frames,
 *   speech time, false starts, backchannels, double-talk frames,
 *   hum/hiss rejections and floor adaptations.
 *
 * Idea only, open-bot's own design: the two-band split, the
 * flatness proxy and the double-talk flag are written from the
 * general turn-taking literature, not copied from any repo.
 */

import { isValidPcm16Frame } from './audio';

/** VAD v10 preset names. */
export type VadV10PresetName = 'quiet' | 'office' | 'noisy' | 'street';

/** Options for `VadV10`. */
export interface VadV10Options {
  /** Preset: quiet room, office, noisy cafe, or street. */
  preset?: VadV10PresetName;
  /** Low-band RMS ratio above the floor that counts as speech. */
  lowStartRatio?: number;
  /** High-band RMS ratio above the floor that counts as speech. */
  highStartRatio?: number;
  /** Low-band ratio below which a frame counts as silence. */
  lowStopRatio?: number;
  /** High-band ratio below which a frame counts as silence. */
  highStopRatio?: number;
  /** Continuous speech needed before speech-start fires (ms). */
  minSpeechMs?: number;
  /** Silence needed before speech-end fires (ms). */
  hangoverMs?: number;
  /** Shortest speech burst that counts as a turn (ms); shorter is a backchannel. */
  minTurnMs?: number;
  /** Shortest burst still counted as a backchannel (ms). */
  minBackchannelMs?: number;
  /** Longest burst still counted as a backchannel (ms). */
  maxBackchannelMs?: number;
  /** Starting low-band noise floor (RMS 0..1) before adaptation. */
  initialLowFloor?: number;
  /** Starting high-band noise floor (RMS 0..1) before adaptation. */
  initialHighFloor?: number;
  /** EMA rate for the noise floors (0..1, higher = faster). */
  floorAdaptRate?: number;
  /** ZCR (crossings per frame) below which loud frames are treated as hum. */
  minZeroCrossings?: number;
  /** ZCR above which loud frames are treated as hiss. */
  maxZeroCrossings?: number;
  /** High/low energy ratio below which a frame looks like hum. */
  minHighLowRatio?: number;
  /** High/low energy ratio above which a frame looks like hiss. */
  maxHighLowRatio?: number;
}

/** Resolved preset values. */
export interface VadV10Preset {
  lowStartRatio: number;
  highStartRatio: number;
  lowStopRatio: number;
  highStopRatio: number;
  minSpeechMs: number;
  hangoverMs: number;
  minTurnMs: number;
  minBackchannelMs: number;
  maxBackchannelMs: number;
  initialLowFloor: number;
  initialHighFloor: number;
}

export const VAD_V10_PRESETS: Record<VadV10PresetName, VadV10Preset> = {
  quiet: { lowStartRatio: 2.2, highStartRatio: 2.0, lowStopRatio: 1.5, highStopRatio: 1.4, minSpeechMs: 100, hangoverMs: 350, minTurnMs: 300, minBackchannelMs: 80, maxBackchannelMs: 600, initialLowFloor: 0.008, initialHighFloor: 0.004 },
  office: { lowStartRatio: 2.8, highStartRatio: 2.5, lowStopRatio: 1.7, highStopRatio: 1.5, minSpeechMs: 120, hangoverMs: 400, minTurnMs: 300, minBackchannelMs: 80, maxBackchannelMs: 600, initialLowFloor: 0.015, initialHighFloor: 0.007 },
  noisy: { lowStartRatio: 3.8, highStartRatio: 3.2, lowStopRatio: 2.1, highStopRatio: 1.8, minSpeechMs: 160, hangoverMs: 500, minTurnMs: 400, minBackchannelMs: 100, maxBackchannelMs: 700, initialLowFloor: 0.03, initialHighFloor: 0.014 },
  street: { lowStartRatio: 4.5, highStartRatio: 4.0, lowStopRatio: 2.4, highStopRatio: 2.0, minSpeechMs: 200, hangoverMs: 600, minTurnMs: 400, minBackchannelMs: 100, maxBackchannelMs: 800, initialLowFloor: 0.05, initialHighFloor: 0.022 },
};

export const VAD_V10_PRESET_NAMES = ['quiet', 'office', 'noisy', 'street'] as const;

export function isVadV10PresetName(value: unknown): value is VadV10PresetName {
  return typeof value === 'string' && (VAD_V10_PRESET_NAMES as readonly string[]).includes(value);
}

export function defaultVadV10Options(): Required<VadV10Options> {
  const p = VAD_V10_PRESETS.office;
  return {
    preset: 'office',
    lowStartRatio: p.lowStartRatio,
    highStartRatio: p.highStartRatio,
    lowStopRatio: p.lowStopRatio,
    highStopRatio: p.highStopRatio,
    minSpeechMs: p.minSpeechMs,
    hangoverMs: p.hangoverMs,
    minTurnMs: p.minTurnMs,
    minBackchannelMs: p.minBackchannelMs,
    maxBackchannelMs: p.maxBackchannelMs,
    initialLowFloor: p.initialLowFloor,
    initialHighFloor: p.initialHighFloor,
    floorAdaptRate: 0.05,
    minZeroCrossings: 4,
    maxZeroCrossings: 220,
    minHighLowRatio: 0.08,
    maxHighLowRatio: 2.5,
  };
}

export function validateVadV10Options(options: VadV10Options): Required<VadV10Options> {
  const base = defaultVadV10Options();
  const preset = options.preset ?? base.preset;
  if (!isVadV10PresetName(preset)) throw new Error(`VAD v10 preset must be one of ${VAD_V10_PRESET_NAMES.join(', ')}.`);
  const p = VAD_V10_PRESETS[preset];
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`VAD v10 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    preset,
    lowStartRatio: num(options.lowStartRatio, p.lowStartRatio, 'lowStartRatio', 1.1, 20),
    highStartRatio: num(options.highStartRatio, p.highStartRatio, 'highStartRatio', 1.1, 20),
    lowStopRatio: num(options.lowStopRatio, p.lowStopRatio, 'lowStopRatio', 1.05, 20),
    highStopRatio: num(options.highStopRatio, p.highStopRatio, 'highStopRatio', 1.05, 20),
    minSpeechMs: num(options.minSpeechMs, p.minSpeechMs, 'minSpeechMs', 20, 2000),
    hangoverMs: num(options.hangoverMs, p.hangoverMs, 'hangoverMs', 0, 5000),
    minTurnMs: num(options.minTurnMs, p.minTurnMs, 'minTurnMs', 20, 5000),
    minBackchannelMs: num(options.minBackchannelMs, p.minBackchannelMs, 'minBackchannelMs', 20, 5000),
    maxBackchannelMs: num(options.maxBackchannelMs, p.maxBackchannelMs, 'maxBackchannelMs', 20, 5000),
    initialLowFloor: num(options.initialLowFloor, p.initialLowFloor, 'initialLowFloor', 0.0001, 0.5),
    initialHighFloor: num(options.initialHighFloor, p.initialHighFloor, 'initialHighFloor', 0.0001, 0.5),
    floorAdaptRate: num(options.floorAdaptRate, base.floorAdaptRate, 'floorAdaptRate', 0, 1),
    minZeroCrossings: num(options.minZeroCrossings, base.minZeroCrossings, 'minZeroCrossings', 0, 320),
    maxZeroCrossings: num(options.maxZeroCrossings, base.maxZeroCrossings, 'maxZeroCrossings', 0, 320),
    minHighLowRatio: num(options.minHighLowRatio, base.minHighLowRatio, 'minHighLowRatio', 0.001, 1),
    maxHighLowRatio: num(options.maxHighLowRatio, base.maxHighLowRatio, 'maxHighLowRatio', 1, 100),
  };
}

/** Events emitted by `VadV10`. */
export type VadV10Event =
  | { kind: 'speech-start'; atMs: number; lowRms: number; highRms: number; lowFloor: number; highFloor: number }
  | { kind: 'speech-end'; atMs: number; durationMs: number; lowRms: number }
  | { kind: 'backchannel'; atMs: number; durationMs: number }
  | { kind: 'false-start'; atMs: number; durationMs: number }
  | { kind: 'double-talk'; atMs: number; durationMs: number }
  | { kind: 'noise-floor-shift'; atMs: number; band: 'low' | 'high'; from: number; to: number };

export type VadV10EventSink = (event: VadV10Event) => void;

/** Counters for one VAD instance. */
export interface VadV10Stats {
  frames: number;
  speechFrames: number;
  silenceFrames: number;
  speechMs: number;
  turns: number;
  backchannels: number;
  falseStarts: number;
  doubleTalkFrames: number;
  humRejections: number;
  hissRejections: number;
  echoRejections: number;
  floorAdaptations: number;
  floorShifts: number;
  lowFloor: number;
  highFloor: number;
  speaking: boolean;
}

/** Frame duration the v10 VAD assumes (ms). */
export const VAD_V10_FRAME_MS = 20;
/** Samples per 20 ms frame at 16 kHz. */
export const VAD_V10_FRAME_SAMPLES = 320;

/** Band energies of one frame: raw RMS (low) + first-difference RMS (high). */
export interface VadV10FrameFeatures {
  lowRms: number;
  highRms: number;
  zcr: number;
  highLowRatio: number;
}

function frameFeatures(frame: Uint8Array): VadV10FrameFeatures {
  let lowSum = 0;
  let highSum = 0;
  let crossings = 0;
  let prev = 0;
  const n = frame.length / 2;
  for (let i = 0; i < n; i++) {
    const raw = frame[i * 2]! | (frame[i * 2 + 1]! << 8);
    const s = raw >= 32768 ? raw - 65536 : raw;
    const v = s / 32768;
    lowSum += v * v;
    const diff = i === 0 ? 0 : v - prev;
    highSum += diff * diff;
    if (prev !== 0 && ((prev < 0 && s >= 0) || (prev >= 0 && s < 0))) crossings += 1;
    prev = v;
  }
  const lowRms = Math.sqrt(lowSum / n);
  // First difference halves the energy of a slow signal; scale by 2 so
  // the high band sits on the same order as the low band for speech.
  const highRms = Math.sqrt(highSum / n) * 2;
  return { lowRms, highRms, zcr: crossings, highLowRatio: lowRms > 0 ? highRms / lowRms : 0 };
}

export function vadV10FrameFeatures(frame: Uint8Array): VadV10FrameFeatures {
  if (!isValidPcm16Frame(frame) || frame.length !== VAD_V10_FRAME_SAMPLES * 2) {
    throw new Error('VAD v10 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
  }
  return frameFeatures(frame);
}

/**
 * Two-band energy VAD with per-band adaptive floors, hum/hiss
 * rejection and double-talk awareness. Feed 20 ms PCM16 frames
 * with `feed()`; subscribe with `onEvent`.
 */
export class VadV10 {
  private options: Required<VadV10Options>;
  private readonly sink: VadV10EventSink | null;
  private lowFloor: number;
  private highFloor: number;
  private speaking = false;
  private speechCandidateMs = 0;
  private silenceMs = 0;
  private speechStartedAtMs = 0;
  private speechMs = 0;
  private speechPeakLow = 0;
  private nowMs = 0;
  private stats: VadV10Stats;
  /** Frames since the last floor-shift event (rate-limits the event). */
  private framesSinceShift = 0;

  constructor(options: VadV10Options = {}, sink: VadV10EventSink | null = null) {
    this.options = validateVadV10Options(options);
    this.sink = sink;
    this.lowFloor = this.options.initialLowFloor;
    this.highFloor = this.options.initialHighFloor;
    this.stats = {
      frames: 0, speechFrames: 0, silenceFrames: 0, speechMs: 0,
      turns: 0, backchannels: 0, falseStarts: 0, doubleTalkFrames: 0,
      humRejections: 0, hissRejections: 0, echoRejections: 0,
      floorAdaptations: 0, floorShifts: 0,
      lowFloor: this.lowFloor, highFloor: this.highFloor, speaking: false,
    };
  }

  getOptions(): Required<VadV10Options> {
    return { ...this.options };
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  getLowFloor(): number {
    return this.lowFloor;
  }

  getHighFloor(): number {
    return this.highFloor;
  }

  getStats(): VadV10Stats {
    return { ...this.stats, lowFloor: this.lowFloor, highFloor: this.highFloor, speaking: this.speaking, speechMs: this.speechMs };
  }

  /** Reconfigure live (same validation as construction). Switching to
   * a different preset adopts that preset's values for every field
   * the caller does not set explicitly. */
  reconfigure(options: VadV10Options): Required<VadV10Options> {
    const next = options.preset !== undefined && options.preset !== this.options.preset
      ? validateVadV10Options(options)
      : validateVadV10Options({ ...this.options, ...options });
    this.options = next;
    return { ...next };
  }

  /** Reset all state (keeps options). */
  reset(): void {
    this.lowFloor = this.options.initialLowFloor;
    this.highFloor = this.options.initialHighFloor;
    this.speaking = false;
    this.speechCandidateMs = 0;
    this.silenceMs = 0;
    this.speechStartedAtMs = 0;
    this.speechMs = 0;
    this.speechPeakLow = 0;
    this.nowMs = 0;
    this.framesSinceShift = 0;
    this.stats = {
      frames: 0, speechFrames: 0, silenceFrames: 0, speechMs: 0,
      turns: 0, backchannels: 0, falseStarts: 0, doubleTalkFrames: 0,
      humRejections: 0, hissRejections: 0, echoRejections: 0,
      floorAdaptations: 0, floorShifts: 0,
      lowFloor: this.lowFloor, highFloor: this.highFloor, speaking: false,
    };
  }

  private emit(event: VadV10Event): void {
    this.sink?.(event);
  }

  /**
   * Feed one 20 ms PCM16 frame. `echo` marks frames that overlap
   * agent playback (the app knows what it just played). Returns
   * true when the frame is speech (candidate or inside a turn).
   */
  feed(frame: Uint8Array, input: { echo?: boolean } = {}): boolean {
    if (!isValidPcm16Frame(frame) || frame.length !== VAD_V10_FRAME_SAMPLES * 2) {
      throw new Error('VAD v10 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    const o = this.options;
    const { lowRms, highRms, zcr, highLowRatio } = frameFeatures(frame);
    const atMs = this.nowMs;
    this.nowMs += VAD_V10_FRAME_MS;
    this.stats.frames += 1;
    this.framesSinceShift += 1;

    const lowAbove = lowRms > this.lowFloor * o.lowStartRatio;
    const highAbove = highRms > this.highFloor * o.highStartRatio;
    const lowQuiet = lowRms < this.lowFloor * o.lowStopRatio;
    const highQuiet = highRms < this.highFloor * o.highStopRatio;
    // A loud frame that fails the flatness proxy is hum or hiss, not
    // speech — even when both bands clear their floors.
    const looksHum = lowAbove && zcr < o.minZeroCrossings && highLowRatio < o.minHighLowRatio;
    const looksHiss = lowAbove && zcr > o.maxZeroCrossings && highLowRatio > o.maxHighLowRatio;
    if (looksHum) this.stats.humRejections += 1;
    if (looksHiss) this.stats.hissRejections += 1;
    const isCandidate = lowAbove && highAbove && !looksHum && !looksHiss;
    const isSilence = lowQuiet && highQuiet;

    // Echo-only frames never start a turn. When the detector is
    // already speaking and echo arrives on top, count it as
    // double-talk instead of letting it stretch the turn.
    if (input.echo === true) {
      if (this.speaking) {
        this.stats.doubleTalkFrames += 1;
      } else {
        this.stats.echoRejections += 1;
      }
    }

    if (!this.speaking) {
      if (isCandidate && input.echo !== true) {
        this.speechCandidateMs += VAD_V10_FRAME_MS;
        this.stats.speechFrames += 1;
        if (this.speechCandidateMs >= o.minSpeechMs) {
          this.speaking = true;
          this.speechStartedAtMs = atMs - this.speechCandidateMs + VAD_V10_FRAME_MS;
          this.speechMs = this.speechCandidateMs;
          this.silenceMs = 0;
          this.speechPeakLow = lowRms;
          this.stats.turns += 1;
          this.emit({ kind: 'speech-start', atMs: this.speechStartedAtMs, lowRms, highRms, lowFloor: this.lowFloor, highFloor: this.highFloor });
          return true;
        }
        return true;
      }
      // Not a candidate: decay the candidate and adapt both floors
      // on silence frames (slow EMA, so a fan turning on is learned).
      this.speechCandidateMs = 0;
      this.stats.silenceFrames += 1;
      this.adaptFloors(lowRms, highRms, atMs, isSilence);
      return false;
    }

    // Inside a turn.
    this.stats.speechFrames += 1;
    this.speechMs += VAD_V10_FRAME_MS;
    if (lowRms > this.speechPeakLow) this.speechPeakLow = lowRms;
    if (isSilence) {
      this.silenceMs += VAD_V10_FRAME_MS;
      // Dynamic hangover: a long confident turn ends fast, a short
      // uncertain turn keeps the full hangover.
      const confidence = Math.min(1, this.speechPeakLow / (this.lowFloor * o.lowStartRatio * 2));
      const hangover = Math.round(o.hangoverMs * (1 - 0.5 * confidence));
      if (this.silenceMs >= hangover) {
        const durationMs = this.speechMs - this.silenceMs;
        const endedAt = atMs;
        this.speaking = false;
        this.silenceMs = 0;
        this.speechCandidateMs = 0;
        if (durationMs < o.minTurnMs) {
          if (durationMs >= o.minBackchannelMs && durationMs <= o.maxBackchannelMs) {
            this.stats.backchannels += 1;
            this.emit({ kind: 'backchannel', atMs: endedAt, durationMs });
          } else {
            this.stats.falseStarts += 1;
            this.emit({ kind: 'false-start', atMs: endedAt, durationMs });
          }
        } else {
          this.emit({ kind: 'speech-end', atMs: endedAt, durationMs, lowRms });
        }
        return false;
      }
      return true;
    }
    this.silenceMs = 0;
    return true;
  }

  private adaptFloors(lowRms: number, highRms: number, atMs: number, isSilence: boolean): void {
    const o = this.options;
    if (!isSilence) return;
    const rate = o.floorAdaptRate;
    const nextLow = this.lowFloor + (lowRms - this.lowFloor) * rate;
    const nextHigh = this.highFloor + (highRms - this.highFloor) * rate;
    // A floor that jumps a lot in one step means the room changed
    // (fan on, door slammed) — report it, rate-limited to one
    // event per 50 frames so the log is not flooded.
    const lowJump = Math.abs(nextLow - this.lowFloor) > this.lowFloor * 0.5 && this.framesSinceShift >= 50;
    const highJump = Math.abs(nextHigh - this.highFloor) > this.highFloor * 0.5 && this.framesSinceShift >= 50;
    if (lowJump || highJump) {
      const band = lowJump ? 'low' : 'high';
      const from = lowJump ? this.lowFloor : this.highFloor;
      const to = lowJump ? nextLow : nextHigh;
      this.lowFloor = nextLow;
      this.highFloor = nextHigh;
      this.stats.floorAdaptations += 1;
      this.stats.floorShifts += 1;
      this.framesSinceShift = 0;
      this.emit({ kind: 'noise-floor-shift', atMs, band, from, to });
      return;
    }
    this.lowFloor = nextLow;
    this.highFloor = nextHigh;
    this.stats.floorAdaptations += 1;
  }
}

/** Create a v10 VAD (factory, mirrors `createVadV9`). */
export function createVadV10(options: VadV10Options = {}, sink: VadV10EventSink | null = null): VadV10 {
  return new VadV10(options, sink);
}

/** One-line summary of a v10 VAD's counters. */
export function vadV10Summary(stats: VadV10Stats): string {
  return (
    `VAD v10: ${stats.frames} frames, ${stats.turns} turns, ${stats.backchannels} backchannels, ` +
    `${stats.falseStarts} false starts, ${stats.doubleTalkFrames} double-talk frames, ` +
    `${stats.humRejections} hum + ${stats.hissRejections} hiss rejections, ` +
    `floors low=${stats.lowFloor.toFixed(4)} high=${stats.highFloor.toFixed(4)}`
  );
}

/** VAD v10 stats as Markdown (for the diagnostics panel). */
export function vadV10Markdown(stats: VadV10Stats): string {
  const lines = [
    '## VAD v10',
    '',
    `- frames: ${stats.frames} (speech ${stats.speechFrames}, silence ${stats.silenceFrames})`,
    `- turns: ${stats.turns}, backchannels: ${stats.backchannels}, false starts: ${stats.falseStarts}`,
    `- double-talk frames: ${stats.doubleTalkFrames}, echo rejections: ${stats.echoRejections}`,
    `- hum rejections: ${stats.humRejections}, hiss rejections: ${stats.hissRejections}`,
    `- floor adaptations: ${stats.floorAdaptations}, floor shifts: ${stats.floorShifts}`,
    `- low floor: ${stats.lowFloor.toFixed(4)}, high floor: ${stats.highFloor.toFixed(4)}`,
    `- speaking: ${stats.speaking ? 'yes' : 'no'}`,
  ];
  return lines.join('\n');
}
