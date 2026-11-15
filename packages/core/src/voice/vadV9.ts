/**
 * Mock VAD v9 (v1.10, Đội T5 — voice realtime v5).
 *
 * A small, deterministic, energy-based voice activity detector for the
 * v9 realtime session. It is deliberately NOT the spectral v8 VAD:
 * v9 needs a cheap mock VAD whose behaviour a test can drive frame by
 * frame without FFT tables — energy (RMS) plus zero-crossing rate,
 * an adaptive noise floor, a hangover, and backchannel detection.
 *
 * Idea only, learned from the survey (docs/repo-survey-v110.md §2-§3
 * is about teams/memory; the VAD design here is open-bot's own):
 * turn-taking needs a fast speech-start, a forgiving speech-end
 * (hangover so pauses inside a sentence do not cut the turn), and a
 * way to tell a short "uh-huh" backchannel from a real turn.
 *
 * Behaviour:
 * - Frames are PCM16 mono at 16 kHz, 20 ms (320 samples) each.
 *   Anything else is rejected — the session validates before calling.
 * - The noise floor is an exponential moving average of the RMS of
 *   frames classified as silence; it adapts slowly so a fan turning
 *   on does not keep the detector stuck open.
 * - Speech starts when RMS stays above `floor * startRatio` for
 *   `minSpeechMs` (default 120 ms). A burst shorter than that is
 *   counted as a backchannel candidate, not a turn.
 * - Speech ends after `hangoverMs` (default 400 ms) of continuous
 *   silence. Dynamic hangover: a long confident turn gets a shorter
 *   hangover (ends fast), a short uncertain turn keeps the full one.
 * - Zero-crossing rate separates fricative-heavy speech from
 *   low-frequency hum: a frame above the energy threshold but with a
 *   very low ZCR while the floor is humming is treated as noise.
 * - Every decision is reported through events; stats count frames,
 *   speech time, false starts (speech that ended before
 *   `minTurnMs`), backchannels and floor adaptations.
 *
 * No audio device, no model, no network: pure arithmetic on frames.
 */

import { isValidPcm16Frame, pcm16Rms } from './audio';

/** VAD v9 preset names. */
export type VadV9PresetName = 'quiet' | 'office' | 'noisy';

/** Options for `MockVadV9`. */
export interface VadV9Options {
  /** Preset: quiet room, office, or noisy street/cafe. */
  preset?: VadV9PresetName;
  /** RMS ratio above the noise floor that counts as speech. */
  startRatio?: number;
  /** RMS ratio below which a frame counts as silence. */
  stopRatio?: number;
  /** Continuous speech needed before speech-start fires (ms). */
  minSpeechMs?: number;
  /** Silence needed before speech-end fires (ms). */
  hangoverMs?: number;
  /** Shortest speech burst that counts as a turn (ms); shorter is a backchannel. */
  minTurnMs?: number;
  /** Longest burst still counted as a backchannel (ms). */
  maxBackchannelMs?: number;
  /** Starting noise floor (RMS 0..1) before adaptation. */
  initialFloor?: number;
  /** EMA rate for the noise floor (0..1, higher = faster). */
  floorAdaptRate?: number;
  /** ZCR floor (crossings per frame) below which loud frames are treated as hum. */
  minZeroCrossings?: number;
}

/** Resolved preset values. */
export interface VadV9Preset {
  startRatio: number;
  stopRatio: number;
  minSpeechMs: number;
  hangoverMs: number;
  minTurnMs: number;
  maxBackchannelMs: number;
  initialFloor: number;
}

export const VAD_V9_PRESETS: Record<VadV9PresetName, VadV9Preset> = {
  quiet: { startRatio: 2.5, stopRatio: 1.6, minSpeechMs: 100, hangoverMs: 350, minTurnMs: 300, maxBackchannelMs: 600, initialFloor: 0.008 },
  office: { startRatio: 3.0, stopRatio: 1.8, minSpeechMs: 120, hangoverMs: 400, minTurnMs: 300, maxBackchannelMs: 600, initialFloor: 0.015 },
  noisy: { startRatio: 4.0, stopRatio: 2.2, minSpeechMs: 160, hangoverMs: 500, minTurnMs: 400, maxBackchannelMs: 700, initialFloor: 0.03 },
};

export const VAD_V9_PRESET_NAMES = ['quiet', 'office', 'noisy'] as const;

export function isVadV9PresetName(value: unknown): value is VadV9PresetName {
  return typeof value === 'string' && (VAD_V9_PRESET_NAMES as readonly string[]).includes(value);
}

export function defaultVadV9Options(): Required<VadV9Options> {
  const p = VAD_V9_PRESETS.office;
  return {
    preset: 'office',
    startRatio: p.startRatio,
    stopRatio: p.stopRatio,
    minSpeechMs: p.minSpeechMs,
    hangoverMs: p.hangoverMs,
    minTurnMs: p.minTurnMs,
    maxBackchannelMs: p.maxBackchannelMs,
    initialFloor: p.initialFloor,
    floorAdaptRate: 0.05,
    minZeroCrossings: 4,
  };
}

export function validateVadV9Options(options: VadV9Options): Required<VadV9Options> {
  const base = defaultVadV9Options();
  const preset = options.preset ?? base.preset;
  if (!isVadV9PresetName(preset)) throw new Error(`VAD v9 preset must be one of ${VAD_V9_PRESET_NAMES.join(', ')}.`);
  const p = VAD_V9_PRESETS[preset];
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`VAD v9 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    preset,
    startRatio: num(options.startRatio, p.startRatio, 'startRatio', 1.1, 20),
    stopRatio: num(options.stopRatio, p.stopRatio, 'stopRatio', 1.05, 20),
    minSpeechMs: num(options.minSpeechMs, p.minSpeechMs, 'minSpeechMs', 20, 2000),
    hangoverMs: num(options.hangoverMs, p.hangoverMs, 'hangoverMs', 0, 5000),
    minTurnMs: num(options.minTurnMs, p.minTurnMs, 'minTurnMs', 20, 5000),
    maxBackchannelMs: num(options.maxBackchannelMs, p.maxBackchannelMs, 'maxBackchannelMs', 20, 5000),
    initialFloor: num(options.initialFloor, p.initialFloor, 'initialFloor', 0.0001, 0.5),
    floorAdaptRate: num(options.floorAdaptRate, base.floorAdaptRate, 'floorAdaptRate', 0, 1),
    minZeroCrossings: num(options.minZeroCrossings, base.minZeroCrossings, 'minZeroCrossings', 0, 320),
  };
}

/** Events emitted by `MockVadV9`. */
export type VadV9Event =
  | { kind: 'speech-start'; atMs: number; rms: number; floor: number }
  | { kind: 'speech-end'; atMs: number; durationMs: number; rms: number }
  | { kind: 'backchannel'; atMs: number; durationMs: number }
  | { kind: 'false-start'; atMs: number; durationMs: number };

export type VadV9EventSink = (event: VadV9Event) => void;

/** Counters for one VAD instance. */
export interface VadV9Stats {
  frames: number;
  speechFrames: number;
  silenceFrames: number;
  speechMs: number;
  turns: number;
  backchannels: number;
  falseStarts: number;
  floorAdaptations: number;
  floor: number;
  speaking: boolean;
}

/** Frame duration the v9 VAD assumes (ms). */
export const VAD_V9_FRAME_MS = 20;
/** Samples per 20 ms frame at 16 kHz. */
export const VAD_V9_FRAME_SAMPLES = 320;

function zeroCrossings(frame: Uint8Array): number {
  let count = 0;
  let prev = 0;
  for (let i = 0; i + 1 < frame.length; i += 2) {
    const v = frame[i]! | (frame[i + 1]! << 8);
    const s = v >= 32768 ? v - 65536 : v;
    if (prev !== 0 && ((prev < 0 && s >= 0) || (prev >= 0 && s < 0))) count += 1;
    prev = s;
  }
  return count;
}

/**
 * Energy + zero-crossing VAD with an adaptive noise floor.
 * Feed 20 ms PCM16 frames with `feed()`; subscribe with `onEvent`.
 */
export class MockVadV9 {
  private options: Required<VadV9Options>;
  private readonly sink: VadV9EventSink | null;
  private floor: number;
  private speaking = false;
  private speechCandidateMs = 0;
  private silenceMs = 0;
  private speechStartedAtMs = 0;
  private speechMs = 0;
  private nowMs = 0;
  private stats: VadV9Stats;

  constructor(options: VadV9Options = {}, sink: VadV9EventSink | null = null) {
    this.options = validateVadV9Options(options);
    this.sink = sink;
    this.floor = this.options.initialFloor;
    this.stats = {
      frames: 0, speechFrames: 0, silenceFrames: 0, speechMs: 0,
      turns: 0, backchannels: 0, falseStarts: 0, floorAdaptations: 0,
      floor: this.floor, speaking: false,
    };
  }

  getOptions(): Required<VadV9Options> {
    return { ...this.options };
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  getFloor(): number {
    return this.floor;
  }

  getStats(): VadV9Stats {
    return { ...this.stats, floor: this.floor, speaking: this.speaking };
  }

  /** Reconfigure live (same validation as construction). Switching to
   * a different preset adopts that preset's values for every field
   * the caller does not set explicitly. */
  reconfigure(options: VadV9Options): Required<VadV9Options> {
    const next = options.preset !== undefined && options.preset !== this.options.preset
      ? validateVadV9Options(options)
      : validateVadV9Options({ ...this.options, ...options });
    this.options = next;
    return { ...next };
  }

  /** Reset all state (keeps options). */
  reset(): void {
    this.floor = this.options.initialFloor;
    this.speaking = false;
    this.speechCandidateMs = 0;
    this.silenceMs = 0;
    this.speechStartedAtMs = 0;
    this.speechMs = 0;
    this.nowMs = 0;
    this.stats = {
      frames: 0, speechFrames: 0, silenceFrames: 0, speechMs: 0,
      turns: 0, backchannels: 0, falseStarts: 0, floorAdaptations: 0,
      floor: this.floor, speaking: false,
    };
  }

  private emit(event: VadV9Event): void {
    this.sink?.(event);
  }

  /**
   * Feed one 20 ms PCM16 frame. Returns true when the frame is speech
   * (either a candidate or inside a turn).
   */
  feed(frame: Uint8Array): boolean {
    if (!isValidPcm16Frame(frame) || frame.length !== VAD_V9_FRAME_SAMPLES * 2) {
      throw new Error('VAD v9 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    const o = this.options;
    const rms = pcm16Rms(frame);
    const zcr = zeroCrossings(frame);
    const atMs = this.nowMs;
    this.nowMs += VAD_V9_FRAME_MS;
    this.stats.frames += 1;

    // Loud but almost no zero crossings = low-frequency hum, not speech.
    const isHum = rms > this.floor * o.startRatio && zcr < o.minZeroCrossings;
    const loud = rms > this.floor * o.startRatio && !isHum;
    const quiet = rms < this.floor * o.stopRatio;

    if (!this.speaking) {
      if (loud) {
        this.speechCandidateMs += VAD_V9_FRAME_MS;
        this.stats.speechFrames += 1;
        if (this.speechCandidateMs >= o.minSpeechMs) {
          this.speaking = true;
          this.speechStartedAtMs = atMs - this.speechCandidateMs + VAD_V9_FRAME_MS;
          this.speechMs = this.speechCandidateMs;
          this.stats.speechMs += this.speechCandidateMs;
          this.silenceMs = 0;
          this.stats.turns += 1;
          this.emit({ kind: 'speech-start', atMs: this.speechStartedAtMs, rms, floor: this.floor });
        }
        return true;
      }
      // Silence: adapt the floor slowly toward the observed RMS.
      this.stats.silenceFrames += 1;
      if (this.speechCandidateMs > 0) {
        // A burst that never reached minSpeechMs: backchannel or false start.
        const burstMs = this.speechCandidateMs;
        this.speechCandidateMs = 0;
        if (burstMs >= o.minTurnMs) {
          this.stats.falseStarts += 1;
          this.emit({ kind: 'false-start', atMs, durationMs: burstMs });
        } else if (burstMs >= 60) {
          this.stats.backchannels += 1;
          this.emit({ kind: 'backchannel', atMs, durationMs: burstMs });
        }
      }
      const next = this.floor + (rms - this.floor) * o.floorAdaptRate;
      if (next !== this.floor) this.stats.floorAdaptations += 1;
      this.floor = Math.max(0.0001, next);
      return false;
    }

    // Inside a turn.
    if (loud) {
      this.silenceMs = 0;
      this.speechMs += VAD_V9_FRAME_MS;
      this.stats.speechFrames += 1;
      this.stats.speechMs += VAD_V9_FRAME_MS;
      return true;
    }
    if (quiet) {
      this.silenceMs += VAD_V9_FRAME_MS;
      this.stats.silenceFrames += 1;
      // Dynamic hangover: long confident turns end faster.
      const hangover = this.speechMs >= 2000
        ? Math.max(120, Math.floor(o.hangoverMs * 0.6))
        : o.hangoverMs;
      if (this.silenceMs >= hangover) {
        const durationMs = this.speechMs;
        this.speaking = false;
        this.speechCandidateMs = 0;
        this.silenceMs = 0;
        this.speechMs = 0;
        if (durationMs < o.minTurnMs) {
          this.stats.falseStarts += 1;
          this.stats.turns -= 1;
          this.emit({ kind: 'false-start', atMs, durationMs });
        } else if (durationMs <= o.maxBackchannelMs && durationMs < o.minTurnMs * 2) {
          // Very short confirmed turn: still a backchannel, not a turn.
          this.stats.backchannels += 1;
          this.stats.turns -= 1;
          this.emit({ kind: 'backchannel', atMs, durationMs });
        } else {
          this.emit({ kind: 'speech-end', atMs, durationMs, rms });
        }
        return false;
      }
      return true; // still inside the hangover window
    }
    // In-between energy: hold the turn, do not reset the silence clock.
    this.stats.speechFrames += 1;
    return true;
  }
}

/** Create a v9 VAD with a preset name (convenience for tools/UI). */
export function createVadV9(preset: VadV9PresetName = 'office', sink: VadV9EventSink | null = null): MockVadV9 {
  return new MockVadV9({ preset }, sink);
}

/** One-line human summary of VAD v9 stats (for the session panel). */
export function vadV9Summary(stats: VadV9Stats): string {
  return (
    `VAD v9: ${stats.frames} frames, ${stats.turns} turns, ${stats.backchannels} backchannels, ` +
    `${stats.falseStarts} false starts, floor ${stats.floor.toFixed(4)}, ` +
    `${stats.speaking ? 'speaking' : 'silent'}`
  );
}
