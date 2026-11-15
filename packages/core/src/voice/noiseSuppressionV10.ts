/**
 * Noise suppression v10 (v1.11, Đội T5 — voice realtime v2).
 *
 * The VAD decides *when* someone speaks; this module decides *how
 * loud the room is* and cleans the frame before it reaches the
 * recogniser. It is a deliberately small, deterministic estimator —
 * no model, no FFT tables, no audio device — built from the same
 * first-difference band split as `vadV10.ts`:
 *
 * - A noise profile is learned from frames the VAD (or the caller)
 *   classifies as silence: per-band RMS floors, tracked with a slow
 *   EMA, plus a running estimate of the noise's high/low balance.
 *   The profile is frozen while speech is live so the speaker's own
 *   voice never becomes "noise".
 * - Each frame gets a Wiener-style gain: `gain = max(1 - k * noise /
 *   signal, floor)`, computed per band and combined into one scalar
 *   gain for the whole frame (a scalar keeps the waveform shape and
 *   avoids the musical-noise artefacts a per-sample gain would add).
 *   The gain is smoothed over time (attack fast, release slow) so
 *   the volume does not pump between frames.
 * - Suppression levels: `off` (pass-through, still measures), `light`
 *   (gentle, keeps quiet consonants), `moderate` (default, the
 *   room's steady hum/hiss is pushed down), `aggressive` (for a
 *   street or a cafe — also eats quiet speech, so the caller is
 *   warned in stats).
 * - A frame is never silenced outright: the gain floor (default
 *   0.15) keeps a faint copy of the original, so a downstream
 *   recogniser still hears *something* instead of digital silence
 *   and the VAD behind it does not see a cliff.
 * - Stats report the estimated suppression in dB, how many frames
 *   were heavily suppressed, and whether the profile looks stale
 *   (learned long ago in a different room).
 *
 * The suppressor owns no clock: the caller passes `atMs` (the
 * session's virtual clock) so tests stay deterministic. All levels
 * and gains are validated fail-closed — a bad level is rejected,
 * never silently clamped.
 */

import { isValidPcm16Frame, pcm16Rms } from './audio';
import { VAD_V10_FRAME_SAMPLES } from './vadV10';

/** Noise suppression strength. */
export type NoiseSuppressionLevel = 'off' | 'light' | 'moderate' | 'aggressive';

export const NOISE_SUPPRESSION_LEVELS = ['off', 'light', 'moderate', 'aggressive'] as const;

export function isNoiseSuppressionLevel(value: unknown): value is NoiseSuppressionLevel {
  return typeof value === 'string' && (NOISE_SUPPRESSION_LEVELS as readonly string[]).includes(value);
}

/** Options for `NoiseSuppressorV10`. */
export interface NoiseSuppressionV10Options {
  /** Strength (default `moderate`). */
  level?: NoiseSuppressionLevel;
  /** Wiener aggressiveness `k` (0..1, higher = more suppression). */
  suppressionStrength?: number;
  /** Lowest gain ever applied (0..1); 0.15 keeps a faint original. */
  minGain?: number;
  /** EMA rate for the noise profile (0..1, higher = faster learning). */
  profileAdaptRate?: number;
  /** Gain smoothing attack rate (0..1) — how fast gain drops. */
  attackRate?: number;
  /** Gain smoothing release rate (0..1) — how fast gain recovers. */
  releaseRate?: number;
  /** Frames of silence needed before the profile starts learning. */
  warmupFrames?: number;
}

/** Resolved per-level defaults. */
export interface NoiseSuppressionLevelPreset {
  suppressionStrength: number;
  minGain: number;
}

export const NOISE_SUPPRESSION_LEVEL_PRESETS: Record<NoiseSuppressionLevel, NoiseSuppressionLevelPreset> = {
  off: { suppressionStrength: 0, minGain: 1 },
  light: { suppressionStrength: 0.35, minGain: 0.4 },
  moderate: { suppressionStrength: 0.6, minGain: 0.15 },
  aggressive: { suppressionStrength: 0.85, minGain: 0.08 },
};

export function defaultNoiseSuppressionV10Options(): Required<NoiseSuppressionV10Options> {
  const p = NOISE_SUPPRESSION_LEVEL_PRESETS.moderate;
  return {
    level: 'moderate',
    suppressionStrength: p.suppressionStrength,
    minGain: p.minGain,
    profileAdaptRate: 0.08,
    attackRate: 0.5,
    releaseRate: 0.08,
    warmupFrames: 10,
  };
}

export function validateNoiseSuppressionV10Options(
  options: NoiseSuppressionV10Options,
): Required<NoiseSuppressionV10Options> {
  const base = defaultNoiseSuppressionV10Options();
  const level = options.level ?? base.level;
  if (!isNoiseSuppressionLevel(level)) {
    throw new Error(`Noise suppression level must be one of ${NOISE_SUPPRESSION_LEVELS.join(', ')}.`);
  }
  const preset = NOISE_SUPPRESSION_LEVEL_PRESETS[level];
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Noise suppression ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    level,
    suppressionStrength: num(options.suppressionStrength, preset.suppressionStrength, 'suppressionStrength', 0, 1),
    minGain: num(options.minGain, preset.minGain, 'minGain', 0, 1),
    profileAdaptRate: num(options.profileAdaptRate, base.profileAdaptRate, 'profileAdaptRate', 0, 1),
    attackRate: num(options.attackRate, base.attackRate, 'attackRate', 0, 1),
    releaseRate: num(options.releaseRate, base.releaseRate, 'releaseRate', 0, 1),
    warmupFrames: num(options.warmupFrames, base.warmupFrames, 'warmupFrames', 0, 500),
  };
}

/** One processed frame: the cleaned audio + what was done to it. */
export interface SuppressedFrameV10 {
  /** Cleaned PCM16 frame (same length as the input). */
  frame: Uint8Array;
  /** Gain applied to this frame (0..1). */
  gain: number;
  /** Estimated suppression for this frame (dB, >= 0). */
  suppressionDb: number;
  /** True when the noise profile was warm enough to suppress. */
  profileReady: boolean;
  /** Input RMS before suppression. */
  inputRms: number;
  /** Output RMS after suppression. */
  outputRms: number;
}

/** Counters for one suppressor. */
export interface NoiseSuppressionV10Stats {
  frames: number;
  suppressedFrames: number;
  heavyFrames: number;
  profileFrames: number;
  profileReady: boolean;
  meanSuppressionDb: number;
  lastGain: number;
  noiseLowFloor: number;
  noiseHighFloor: number;
  /** ms since the profile was last updated (virtual clock). */
  profileAgeMs: number;
  /** True when the profile is older than the stale threshold. */
  profileStale: boolean;
}

/** After this long without a silence update the profile is stale. */
export const NOISE_PROFILE_STALE_MS = 30_000;

/**
 * Learn a noise profile from silence frames, then apply a smoothed
 * Wiener-style gain to every frame. The caller tells the suppressor
 * which frames are silence (`learn(frame, atMs)`) and which frames
 * need cleaning (`process(frame, atMs)`); a session usually learns
 * from the VAD's silence frames and processes everything.
 */
export class NoiseSuppressorV10 {
  private options: Required<NoiseSuppressionV10Options>;
  private lowFloor = 0;
  private highFloor = 0;
  private profileFrames = 0;
  private smoothedGain = 1;
  private lastProfileAtMs: number | null = null;
  private nowMs = 0;
  private suppressionDbSum = 0;
  private stats: Omit<NoiseSuppressionV10Stats, 'profileAgeMs' | 'profileStale' | 'meanSuppressionDb'> & {
    meanSuppressionDb: number;
  };

  constructor(options: NoiseSuppressionV10Options = {}) {
    this.options = validateNoiseSuppressionV10Options(options);
    this.stats = {
      frames: 0, suppressedFrames: 0, heavyFrames: 0, profileFrames: 0,
      profileReady: false, meanSuppressionDb: 0, lastGain: 1,
      noiseLowFloor: 0, noiseHighFloor: 0,
    };
  }

  getOptions(): Required<NoiseSuppressionV10Options> {
    return { ...this.options };
  }

  isProfileReady(): boolean {
    return this.profileFrames >= this.options.warmupFrames;
  }

  getNoiseFloors(): { low: number; high: number } {
    return { low: this.lowFloor, high: this.highFloor };
  }

  getStats(atMs?: number): NoiseSuppressionV10Stats {
    const now = atMs ?? this.nowMs;
    const age = this.lastProfileAtMs === null ? Number.POSITIVE_INFINITY : now - this.lastProfileAtMs;
    return {
      ...this.stats,
      noiseLowFloor: this.lowFloor,
      noiseHighFloor: this.highFloor,
      profileReady: this.isProfileReady(),
      profileFrames: this.profileFrames,
      meanSuppressionDb: this.stats.frames > 0 ? this.suppressionDbSum / this.stats.frames : 0,
      profileAgeMs: age,
      profileStale: age > NOISE_PROFILE_STALE_MS,
    };
  }

  /** Switch level live (same validation as construction). */
  setLevel(level: NoiseSuppressionLevel): Required<NoiseSuppressionV10Options> {
    const preset = NOISE_SUPPRESSION_LEVEL_PRESETS[level];
    this.options = validateNoiseSuppressionV10Options({
      ...this.options,
      level,
      suppressionStrength: preset.suppressionStrength,
      minGain: preset.minGain,
    });
    return { ...this.options };
  }

  /** Reconfigure live (a level change adopts that level's defaults
   * for every field the caller does not set explicitly). */
  reconfigure(options: NoiseSuppressionV10Options): Required<NoiseSuppressionV10Options> {
    const next = options.level !== undefined && options.level !== this.options.level
      ? validateNoiseSuppressionV10Options(options)
      : validateNoiseSuppressionV10Options({ ...this.options, ...options });
    this.options = next;
    return { ...next };
  }

  /** Reset the profile and counters (keeps options). */
  reset(): void {
    this.lowFloor = 0;
    this.highFloor = 0;
    this.profileFrames = 0;
    this.smoothedGain = 1;
    this.lastProfileAtMs = null;
    this.nowMs = 0;
    this.suppressionDbSum = 0;
    this.stats = {
      frames: 0, suppressedFrames: 0, heavyFrames: 0, profileFrames: 0,
      profileReady: false, meanSuppressionDb: 0, lastGain: 1,
      noiseLowFloor: 0, noiseHighFloor: 0,
    };
  }

  /**
   * Learn from one silence frame. Call only for frames the VAD (or
   * the caller) is confident are silence — learning on speech would
   * teach the suppressor to eat the speaker.
   */
  learn(frame: Uint8Array, atMs: number): void {
    if (!isValidPcm16Frame(frame) || frame.length !== VAD_V10_FRAME_SAMPLES * 2) {
      throw new Error('Noise suppression expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < 0) {
      throw new Error('Noise suppression learn() needs a finite atMs >= 0.');
    }
    const { low, high } = bandRms(frame);
    const rate = this.options.profileAdaptRate;
    this.lowFloor = this.profileFrames === 0 ? low : this.lowFloor + (low - this.lowFloor) * rate;
    this.highFloor = this.profileFrames === 0 ? high : this.highFloor + (high - this.highFloor) * rate;
    this.profileFrames += 1;
    this.lastProfileAtMs = atMs;
    this.nowMs = Math.max(this.nowMs, atMs);
  }

  /**
   * Clean one frame. Returns the cleaned frame plus the gain that
   * was applied. The input frame is never mutated — the output is a
   * new buffer.
   */
  process(frame: Uint8Array, atMs: number): SuppressedFrameV10 {
    if (!isValidPcm16Frame(frame) || frame.length !== VAD_V10_FRAME_SAMPLES * 2) {
      throw new Error('Noise suppression expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < 0) {
      throw new Error('Noise suppression process() needs a finite atMs >= 0.');
    }
    const o = this.options;
    this.nowMs = Math.max(this.nowMs, atMs);
    this.stats.frames += 1;
    const inputRms = pcm16Rms(frame);
    const ready = this.isProfileReady() && o.level !== 'off';
    let targetGain = 1;
    if (ready) {
      const { low, high } = bandRms(frame);
      const noise = (this.lowFloor + this.highFloor) / 2;
      const signal = (low + high) / 2;
      // Wiener-style gain: when the signal is barely above the
      // noise, push it down hard; when it towers over the noise,
      // leave it alone. The minGain floor keeps a faint original.
      const ratio = noise <= 0 ? 1 : Math.max(0, 1 - o.suppressionStrength * (noise / Math.max(signal, 1e-6)));
      targetGain = Math.max(o.minGain, Math.min(1, ratio));
    }
    // Smooth the gain: drop fast (attack) so a noise burst is cut
    // at once, recover slowly (release) so the volume never pumps.
    const rate = targetGain < this.smoothedGain ? o.attackRate : o.releaseRate;
    this.smoothedGain += (targetGain - this.smoothedGain) * rate;
    const gain = o.level === 'off' ? 1 : this.smoothedGain;
    const out = new Uint8Array(frame.length);
    for (let i = 0; i + 1 < frame.length; i += 2) {
      const raw = frame[i]! | (frame[i + 1]! << 8);
      const s = raw >= 32768 ? raw - 65536 : raw;
      let v = Math.round(s * gain);
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;
      const u = v < 0 ? v + 65536 : v;
      out[i] = u & 0xff;
      out[i + 1] = (u >> 8) & 0xff;
    }
    const outputRms = pcm16Rms(out);
    const suppressionDb = gain >= 1 ? 0 : -20 * Math.log10(Math.max(gain, 1e-6));
    this.suppressionDbSum += suppressionDb;
    if (ready && gain < 0.99) this.stats.suppressedFrames += 1;
    if (ready && gain < 0.5) this.stats.heavyFrames += 1;
    this.stats.lastGain = gain;
    return { frame: out, gain, suppressionDb, profileReady: ready, inputRms, outputRms };
  }
}

/** Low (raw) + high (first-difference) band RMS of one frame. */
function bandRms(frame: Uint8Array): { low: number; high: number } {
  let lowSum = 0;
  let highSum = 0;
  const n = frame.length / 2;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const raw = frame[i * 2]! | (frame[i * 2 + 1]! << 8);
    const s = raw >= 32768 ? raw - 65536 : raw;
    const v = s / 32768;
    lowSum += v * v;
    const diff = i === 0 ? 0 : v - prev;
    highSum += diff * diff;
    prev = v;
  }
  return { low: Math.sqrt(lowSum / n), high: Math.sqrt(highSum / n) * 2 };
}

/** One-line summary of a suppressor's counters. */
export function noiseSuppressionV10Summary(stats: NoiseSuppressionV10Stats): string {
  return (
    `Noise suppression v10: ${stats.frames} frames, ${stats.suppressedFrames} suppressed, ` +
    `${stats.heavyFrames} heavy, mean ${stats.meanSuppressionDb.toFixed(1)} dB, ` +
    `profile ${stats.profileReady ? 'ready' : 'warming up'} (${stats.profileFrames} frames)` +
    (stats.profileStale ? ', profile STALE' : '')
  );
}

/** Suppressor stats as Markdown (for the diagnostics panel). */
export function noiseSuppressionV10Markdown(stats: NoiseSuppressionV10Stats): string {
  const lines = [
    '## Noise suppression v10',
    '',
    `- frames: ${stats.frames}, suppressed: ${stats.suppressedFrames}, heavy: ${stats.heavyFrames}`,
    `- mean suppression: ${stats.meanSuppressionDb.toFixed(1)} dB, last gain: ${stats.lastGain.toFixed(2)}`,
    `- noise floors: low=${stats.noiseLowFloor.toFixed(4)}, high=${stats.noiseHighFloor.toFixed(4)}`,
    `- profile: ${stats.profileReady ? 'ready' : 'warming up'} (${stats.profileFrames} frames, age ${Number.isFinite(stats.profileAgeMs) ? `${Math.round(stats.profileAgeMs)} ms` : 'never'})`,
    `- profile stale: ${stats.profileStale ? 'yes — relearn in this room' : 'no'}`,
  ];
  return lines.join('\n');
}
