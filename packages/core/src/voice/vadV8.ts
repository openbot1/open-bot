/**
 * Spectral voice activity detection v8 (v1.09, Đội T5 — voice realtime v8).
 *
 * v7 is a good energy+ZCR VAD, but it still hears things that are not
 * speech: a fan, a hum, a door slam, a cough — anything loud enough
 * crosses the energy line, and ZCR alone cannot tell a fan from a
 * vowel. v8 keeps the v7 skeleton (adaptive noise floor, hysteresis,
 * hangover, sample-derived clock, no model, no native dependency, no
 * microphone) and adds the spectral layer that cuts false positives:
 *
 *   - Goertzel magnitudes on a 100 Hz grid (100 Hz – 6 kHz, 60
 *     bins), grouped into low / mid / high bands. Voiced speech
 *     concentrates energy in the mid band (formants); hum lives
 *     in the low band, clicks and white noise in the high band.
 *     A dense grid matters: with a 20 ms window the bin spacing
 *     is 50 Hz, so a tone that falls *between* sparse bins leaks
 *     to zero at every measured bin — the grid must be dense
 *     enough that every speech frequency lands near a bin.
 *   - Spectral flatness (geometric / arithmetic mean of the bin
 *     magnitudes): tonal speech sits well below 1, fan / white
 *     noise sits near 1. Flatness is a third vote beside energy
 *     and ZCR, so a loud fan (high energy, in-band ZCR) is still
 *     rejected for being spectrally flat.
 *   - Per-band adaptive noise floors: each band learns its own
 *     floor (slow EMA in quiet, fast EMA while calibrating), so a
 *     room with a 120 Hz hum does not raise the mid-band floor
 *     and hide speech.
 *   - Noise-type classification per window: `hum | fan | click |
 *     white | speech | silence` — the panel can show *why* the
 *     mic is busy, and the stats count false positives by cause.
 *   - Dynamic hangover: the end-of-speech delay shrinks when the
 *     turn was confident (fast reply, low latency) and grows in
 *     noisy rooms (don't cut a sentence on one noisy gap), so
 *     `speech-end` lands closer to the real end of the sentence.
 *   - Fallback: `SimpleEnergyVadV8` — the v0.95 energy VAD shape
 *     (RMS threshold + hangover) behind the same event interface,
 *     used automatically when the caller asks for engine
 *     `'simple'` or when spectral analysis is unavailable
 *     (`createVadV8('auto')` picks spectral and falls back on
 *     bad frames). The session never loses VAD because an
 *     engine is missing.
 *
 * Timing is derived from the samples fed (sample rate), never from
 * the wall clock, so tests are deterministic: feed 20 ms windows
 * of sine / silence / noise and the events land on exact
 * millisecond boundaries.
 */

import { isValidPcm16Frame, pcm16Rms, pcm16Sample } from './audio';
import { pcm16ZeroCrossingRate } from './vadV7';
import { REALTIME_MIC_SAMPLE_RATE_HZ } from './types';

/** Named VAD profiles (room presets). Same names as v7. */
export type VadV8PresetName = 'quiet' | 'office' | 'noisy' | 'very-noisy';

/** Which engine backs the detector. */
export type VadV8Engine = 'spectral' | 'simple' | 'auto';

/** VAD state. */
export type VadV8State = 'idle' | 'maybe-speech' | 'speaking' | 'ending';

/** What the room sounds like in one window. */
export type VadV8NoiseKind = 'silence' | 'hum' | 'fan' | 'click' | 'white' | 'speech';

/** Why a burst was rejected as not-speech. */
export type VadV8FalsePositiveReason =
  | 'low-energy'
  | 'low-confidence'
  | 'zcr-out-of-band'
  | 'too-flat'
  | 'no-mid-band'
  | 'too-short';

/** One VAD v8 event emitted through the sink. */
export interface VadV8Event {
  kind: 'speech-start' | 'speech-end' | 'backchannel' | 'false-positive';
  /** ms since the VAD started (sample-derived clock). */
  atMs: number;
  /** Turn / burst start (ms). */
  startedAtMs: number;
  /** Turn / burst end (ms, speech-end only). */
  endedAtMs?: number;
  /** Turn / burst duration (ms, speech-end only). */
  durationMs?: number;
  /** Peak RMS inside the turn. */
  peakRms: number;
  /** Peak confidence inside the turn (0..1). */
  peakConfidence: number;
  /** Windows in the turn. */
  frames: number;
  /** Dominant noise kind seen during the burst. */
  noiseKind?: VadV8NoiseKind;
  /** Why the burst was rejected (false-positive only). */
  reason?: VadV8FalsePositiveReason;
  /** Hangover actually applied before this speech-end (ms). */
  hangoverAppliedMs?: number;
}

/** Event sink. */
export type VadV8EventSink = (event: VadV8Event) => void;

/** Per-window spectral features (what the panel / diagnostics read). */
export interface VadV8WindowFeatures {
  /** ms since the VAD started. */
  atMs: number;
  rms: number;
  zcr: number;
  /** 0..1 — 1 is perfectly flat (noise-like), 0 is tonal. */
  spectralFlatness: number;
  /** Energy per band, normalised to 0..1 (magnitude / max). */
  bandLow: number;
  bandMid: number;
  bandHigh: number;
  /** Mid-band energy above its adaptive floor (×). */
  midBandMargin: number;
  /** Classified noise kind for this window. */
  noiseKind: VadV8NoiseKind;
  /** Combined speech confidence (0..1). */
  confidence: number;
  /** True when this window votes "speech". */
  speechLikely: boolean;
}

/** Stats for the panel / diagnostics / tools. */
export interface VadV8Stats {
  state: VadV8State;
  engine: VadV8Engine;
  preset: VadV8PresetName;
  /** Effective RMS threshold (energy gate). */
  threshold: number;
  /** Current overall noise floor (RMS). */
  noiseFloor: number;
  /** Per-band noise floors (RMS-equivalent magnitudes). */
  bandFloors: { low: number; mid: number; high: number };
  /** RMS of the latest window. */
  level: number;
  /** ZCR of the latest window. */
  zcr: number;
  /** Spectral flatness of the latest window. */
  spectralFlatness: number;
  /** Confidence of the latest window (0..1). */
  confidence: number;
  /** Noise kind of the latest window. */
  noiseKind: VadV8NoiseKind;
  /** Hangover currently in effect (ms, dynamic). */
  hangoverMs: number;
  calibrating: boolean;
  turns: number;
  backchannels: number;
  falsePositives: number;
  /** False positives by cause. */
  falsePositivesByReason: Record<VadV8FalsePositiveReason, number>;
  /** False positives by noise kind. */
  falsePositivesByNoise: Record<VadV8NoiseKind, number>;
  /** Mean end-of-speech latency (ms from last speech frame to the event). */
  meanEndLatencyMs: number | null;
  /** Windows processed. */
  windows: number;
  /** Windows the fallback (simple) engine handled. */
  fallbackWindows: number;
}

/** Full effective config (always readable). */
export interface VadV8Config {
  preset: VadV8PresetName;
  engine: VadV8Engine;
  sampleRateHz: number;
  windowMs: number;
  threshold: number;
  thresholdMultiplier: number;
  noiseLearnMs: number;
  hangoverMs: number;
  /** Shortest hangover (confident turn, ms). */
  minHangoverMs: number;
  /** Longest hangover (noisy room, ms). */
  maxHangoverMs: number;
  minTurnMs: number;
  backchannelMaxMs: number;
  maxGapMs: number;
  debounceFrames: number;
  minConfidence: number;
  minZcr: number;
  maxZcr: number;
  /** Max spectral flatness that still counts as speech (0..1). */
  maxFlatness: number;
  /** Mid-band margin (× floor) needed for a speech vote. */
  minMidBandMargin: number;
}

/** Caller-supplied options (all optional). */
export interface AdaptiveVadV8Options {
  preset?: VadV8PresetName;
  engine?: VadV8Engine;
  sampleRateHz?: number;
  windowMs?: number;
  threshold?: number;
  thresholdMultiplier?: number;
  noiseLearnMs?: number;
  hangoverMs?: number;
  minHangoverMs?: number;
  maxHangoverMs?: number;
  minTurnMs?: number;
  backchannelMaxMs?: number;
  maxGapMs?: number;
  debounceFrames?: number;
  minConfidence?: number;
  minZcr?: number;
  maxZcr?: number;
  maxFlatness?: number;
  minMidBandMargin?: number;
  /** Initial noise floor (RMS). Default 0.005. */
  initialNoiseFloor?: number;
  /** Event sink. */
  sink?: VadV8EventSink;
}

export const VAD_V8_DEFAULT_THRESHOLD = 0.02;
export const VAD_V8_DEFAULT_HANGOVER_MS = 350;
export const VAD_V8_DEFAULT_MIN_HANGOVER_MS = 150;
export const VAD_V8_DEFAULT_MAX_HANGOVER_MS = 700;
export const VAD_V8_DEFAULT_WINDOW_MS = 20;
export const VAD_V8_DEFAULT_NOISE_LEARN_MS = 2000;
export const VAD_V8_DEFAULT_THRESHOLD_MULTIPLIER = 4;
export const VAD_V8_DEFAULT_MIN_TURN_MS = 200;
export const VAD_V8_DEFAULT_BACKCHANNEL_MAX_MS = 250;
export const VAD_V8_DEFAULT_MAX_GAP_MS = 400;
export const VAD_V8_DEFAULT_DEBOUNCE_FRAMES = 2;
export const VAD_V8_DEFAULT_MIN_CONFIDENCE = 0.55;
export const VAD_V8_DEFAULT_MIN_ZCR = 0.02;
export const VAD_V8_DEFAULT_MAX_ZCR = 0.5;
export const VAD_V8_DEFAULT_MAX_FLATNESS = 0.75;
export const VAD_V8_DEFAULT_MIN_MID_BAND_MARGIN = 2.5;
export const VAD_V8_MAX_THRESHOLD = 0.25;
export const VAD_V8_MIN_THRESHOLD = 0.005;
export const VAD_V8_CALIBRATION_ALPHA = 0.25;
export const VAD_V8_DEFAULT_CALIBRATION_MS = 1000;
/** Goertzel frequencies (Hz) — 100 Hz grid, 100 Hz to 6 kHz (60 bins). */
export const VAD_V8_GOERTZEL_FREQUENCIES_HZ: readonly number[] = Array.from(
  { length: 60 },
  (_, i) => 100 + i * 100,
);
/** Bins 0..6 are the low band (100–700 Hz), 7..19 the mid band (800–2000 Hz), 20..59 the high band (2100–6000 Hz). */
export const VAD_V8_BAND_SPLIT = { lowEnd: 7, midEnd: 20 } as const;

export const VAD_V8_PRESET_NAMES: VadV8PresetName[] = ['quiet', 'office', 'noisy', 'very-noisy'];
export const VAD_V8_ENGINE_NAMES: VadV8Engine[] = ['spectral', 'simple', 'auto'];

export function isVadV8PresetName(name: string): name is VadV8PresetName {
  return (VAD_V8_PRESET_NAMES as readonly string[]).includes(name);
}

export function isVadV8Engine(name: string): name is VadV8Engine {
  return (VAD_V8_ENGINE_NAMES as readonly string[]).includes(name);
}

/** Named threshold profiles — same room ladder as v7, retuned for the spectral vote. */
export const VAD_V8_PRESETS: Record<
  VadV8PresetName,
  Omit<VadV8Config, 'preset' | 'engine' | 'sampleRateHz' | 'windowMs'>
> = {
  quiet: {
    threshold: 0.012,
    thresholdMultiplier: 3,
    noiseLearnMs: 1500,
    hangoverMs: 300,
    minHangoverMs: 120,
    maxHangoverMs: 500,
    minTurnMs: 180,
    backchannelMaxMs: 250,
    maxGapMs: 400,
    debounceFrames: 2,
    minConfidence: 0.5,
    minZcr: 0.02,
    maxZcr: 0.5,
    maxFlatness: 0.8,
    minMidBandMargin: 2,
  },
  office: {
    threshold: 0.02,
    thresholdMultiplier: 4,
    noiseLearnMs: 2000,
    hangoverMs: 350,
    minHangoverMs: 150,
    maxHangoverMs: 700,
    minTurnMs: 200,
    backchannelMaxMs: 250,
    maxGapMs: 400,
    debounceFrames: 2,
    minConfidence: 0.55,
    minZcr: 0.02,
    maxZcr: 0.5,
    maxFlatness: 0.75,
    minMidBandMargin: 2.5,
  },
  noisy: {
    threshold: 0.035,
    thresholdMultiplier: 5,
    noiseLearnMs: 2500,
    hangoverMs: 450,
    minHangoverMs: 200,
    maxHangoverMs: 800,
    minTurnMs: 220,
    backchannelMaxMs: 250,
    maxGapMs: 350,
    debounceFrames: 3,
    minConfidence: 0.6,
    minZcr: 0.02,
    maxZcr: 0.5,
    maxFlatness: 0.7,
    minMidBandMargin: 3,
  },
  'very-noisy': {
    threshold: 0.05,
    thresholdMultiplier: 6,
    noiseLearnMs: 3000,
    hangoverMs: 550,
    minHangoverMs: 250,
    maxHangoverMs: 900,
    minTurnMs: 250,
    backchannelMaxMs: 200,
    maxGapMs: 300,
    debounceFrames: 3,
    minConfidence: 0.65,
    minZcr: 0.02,
    maxZcr: 0.5,
    maxFlatness: 0.65,
    minMidBandMargin: 3.5,
  },
};

export function defaultVadV8Options(): AdaptiveVadV8Options {
  return {
    preset: 'office',
    engine: 'auto',
    sampleRateHz: REALTIME_MIC_SAMPLE_RATE_HZ,
    windowMs: VAD_V8_DEFAULT_WINDOW_MS,
    threshold: VAD_V8_DEFAULT_THRESHOLD,
    thresholdMultiplier: VAD_V8_DEFAULT_THRESHOLD_MULTIPLIER,
    noiseLearnMs: VAD_V8_DEFAULT_NOISE_LEARN_MS,
    hangoverMs: VAD_V8_DEFAULT_HANGOVER_MS,
    minHangoverMs: VAD_V8_DEFAULT_MIN_HANGOVER_MS,
    maxHangoverMs: VAD_V8_DEFAULT_MAX_HANGOVER_MS,
    minTurnMs: VAD_V8_DEFAULT_MIN_TURN_MS,
    backchannelMaxMs: VAD_V8_DEFAULT_BACKCHANNEL_MAX_MS,
    maxGapMs: VAD_V8_DEFAULT_MAX_GAP_MS,
    debounceFrames: VAD_V8_DEFAULT_DEBOUNCE_FRAMES,
    minConfidence: VAD_V8_DEFAULT_MIN_CONFIDENCE,
    minZcr: VAD_V8_DEFAULT_MIN_ZCR,
    maxZcr: VAD_V8_DEFAULT_MAX_ZCR,
    maxFlatness: VAD_V8_DEFAULT_MAX_FLATNESS,
    minMidBandMargin: VAD_V8_DEFAULT_MIN_MID_BAND_MARGIN,
    initialNoiseFloor: 0.005,
  };
}

/** Validate options; returns human-readable problems (empty = valid). */
export function validateVadV8Options(options: AdaptiveVadV8Options): string[] {
  const problems: string[] = [];
  if (options.preset !== undefined && !isVadV8PresetName(options.preset)) {
    problems.push(`preset must be one of ${VAD_V8_PRESET_NAMES.join(', ')}`);
  }
  if (options.engine !== undefined && !isVadV8Engine(options.engine)) {
    problems.push(`engine must be one of ${VAD_V8_ENGINE_NAMES.join(', ')}`);
  }
  const num = (name: keyof AdaptiveVadV8Options, min: number, max: number): void => {
    const v = options[name];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)) {
      problems.push(`${String(name)} must be a number in [${min}, ${max}]`);
    }
  };
  num('sampleRateHz', 8000, 48000);
  num('windowMs', 10, 100);
  num('threshold', VAD_V8_MIN_THRESHOLD, VAD_V8_MAX_THRESHOLD);
  num('thresholdMultiplier', 1, 20);
  num('noiseLearnMs', 100, 30000);
  num('hangoverMs', 0, 5000);
  num('minHangoverMs', 0, 5000);
  num('maxHangoverMs', 0, 5000);
  num('minTurnMs', 0, 5000);
  num('backchannelMaxMs', 0, 5000);
  num('maxGapMs', 0, 5000);
  num('debounceFrames', 1, 20);
  num('minConfidence', 0, 1);
  num('minZcr', 0, 1);
  num('maxZcr', 0, 1);
  num('maxFlatness', 0, 1);
  num('minMidBandMargin', 1, 20);
  num('initialNoiseFloor', 0.0001, 0.2);
  if (
    options.minZcr !== undefined &&
    options.maxZcr !== undefined &&
    options.minZcr >= options.maxZcr
  ) {
    problems.push('minZcr must be below maxZcr');
  }
  if (
    options.minHangoverMs !== undefined &&
    options.maxHangoverMs !== undefined &&
    options.minHangoverMs > options.maxHangoverMs
  ) {
    problems.push('minHangoverMs must not exceed maxHangoverMs');
  }
  return problems;
}

/** Goertzel magnitude of one frequency in a PCM16 frame (Hann-windowed: without the window a tone falling exactly between grid bins is orthogonal to every bin and invisible). */
export function goertzelMagnitude(frame: Uint8Array, freqHz: number, sampleRateHz: number): number {
  const n = Math.floor(frame.length / 2);
  if (n <= 0) return 0;
  const k = Math.round((n * freqHz) / sampleRateHz);
  const w = (2 * Math.PI * k) / n;
  const cw = Math.cos(w);
  const coeff = 2 * cw;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, n - 1)));
    s0 = pcm16Sample(frame, i) * hann + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / n;
}

/** Magnitudes at all 8 Goertzel frequencies. */
export function vadV8Spectrum(frame: Uint8Array, sampleRateHz: number): number[] {
  return VAD_V8_GOERTZEL_FREQUENCIES_HZ.map((f) => goertzelMagnitude(frame, f, sampleRateHz));
}

/** Spectral flatness of bin magnitudes: 1 = perfectly flat (noise), ~0 = tonal. */
export function spectralFlatness(magnitudes: readonly number[]): number {
  if (magnitudes.length === 0) return 1;
  let sum = 0;
  let logSum = 0;
  let count = 0;
  for (const m of magnitudes) {
    const v = Math.max(m, 1e-9);
    sum += v;
    logSum += Math.log(v);
    count += 1;
  }
  const arith = sum / count;
  if (arith <= 0) return 1;
  const geo = Math.exp(logSum / count);
  return Math.min(1, Math.max(0, geo / arith));
}

/** Band energies (mean magnitude) from the 8-bin spectrum. */
export function vadV8BandEnergies(magnitudes: readonly number[]): { low: number; mid: number; high: number } {
  const avg = (from: number, to: number): number => {
    let s = 0;
    for (let i = from; i < to; i += 1) s += magnitudes[i] ?? 0;
    return s / Math.max(1, to - from);
  };
  return {
    low: avg(0, VAD_V8_BAND_SPLIT.lowEnd),
    mid: avg(VAD_V8_BAND_SPLIT.lowEnd, VAD_V8_BAND_SPLIT.midEnd),
    high: avg(VAD_V8_BAND_SPLIT.midEnd, magnitudes.length),
  };
}

/** Classify one window from its features. Order matters: silence first, then the loud non-speech kinds. */
export function classifyVadV8Noise(features: {
  rms: number;
  zcr: number;
  spectralFlatness: number;
  bandLow: number;
  bandMid: number;
  bandHigh: number;
  threshold: number;
}): VadV8NoiseKind {
  if (features.rms < features.threshold * 0.5) return 'silence';
  const total = features.bandLow + features.bandMid + features.bandHigh;
  if (total <= 0) return 'silence';
  const lowShare = features.bandLow / total;
  const midShare = features.bandMid / total;
  const highShare = features.bandHigh / total;
  // Low-frequency hum: energy bunched in the low band, low ZCR, tonal.
  if (lowShare > 0.55 && features.zcr < 0.08 && features.spectralFlatness < 0.5) return 'hum';
  // Click / transient: very high ZCR, energy bunched high, flat spectrum.
  if (features.zcr > 0.5 && highShare > 0.45) return 'click';
  // White noise: flat spectrum, high ZCR.
  if (features.spectralFlatness > 0.85 && features.zcr > 0.3) return 'white';
  // Fan / steady broadband noise: flat spectrum — checked before
  // speech, so loud flat noise is never called speech.
  if (features.spectralFlatness > 0.75) return 'fan';
  // Speech: mid-band carries the formants.
  if (midShare >= 0.3) return 'speech';
  if (lowShare > 0.5) return 'hum';
  return highShare > 0.5 ? 'white' : 'fan';
}

/** Resolve the effective config: preset defaults, then explicit overrides. */
export function resolveVadV8Config(options: AdaptiveVadV8Options): VadV8Config {
  const preset = options.preset ?? 'office';
  const base = VAD_V8_PRESETS[preset];
  const engine = options.engine ?? 'auto';
  return {
    preset,
    engine,
    sampleRateHz: options.sampleRateHz ?? REALTIME_MIC_SAMPLE_RATE_HZ,
    windowMs: options.windowMs ?? VAD_V8_DEFAULT_WINDOW_MS,
    threshold: options.threshold ?? base.threshold,
    thresholdMultiplier: options.thresholdMultiplier ?? base.thresholdMultiplier,
    noiseLearnMs: options.noiseLearnMs ?? base.noiseLearnMs,
    hangoverMs: options.hangoverMs ?? base.hangoverMs,
    minHangoverMs: options.minHangoverMs ?? base.minHangoverMs,
    maxHangoverMs: options.maxHangoverMs ?? base.maxHangoverMs,
    minTurnMs: options.minTurnMs ?? base.minTurnMs,
    backchannelMaxMs: options.backchannelMaxMs ?? base.backchannelMaxMs,
    maxGapMs: options.maxGapMs ?? base.maxGapMs,
    debounceFrames: options.debounceFrames ?? base.debounceFrames,
    minConfidence: options.minConfidence ?? base.minConfidence,
    minZcr: options.minZcr ?? base.minZcr,
    maxZcr: options.maxZcr ?? base.maxZcr,
    maxFlatness: options.maxFlatness ?? base.maxFlatness,
    minMidBandMargin: options.minMidBandMargin ?? base.minMidBandMargin,
  };
}

function emptyFalsePositiveReasons(): Record<VadV8FalsePositiveReason, number> {
  return {
    'low-energy': 0,
    'low-confidence': 0,
    'zcr-out-of-band': 0,
    'too-flat': 0,
    'no-mid-band': 0,
    'too-short': 0,
  };
}

function emptyFalsePositiveNoise(): Record<VadV8NoiseKind, number> {
  return { silence: 0, hum: 0, fan: 0, click: 0, white: 0, speech: 0 };
}

/**
 * Spectral VAD v8 — the detector. Feed 20 ms PCM16 windows;
 * speech-start / speech-end / backchannel / false-positive events
 * arrive on the sink. The clock is sample-derived: every window
 * advances `atMs` by `windowMs`.
 */
export class AdaptiveVadV8 {
  private readonly config: VadV8Config;
  private readonly sink: VadV8EventSink | undefined;
  private readonly initialNoiseFloor: number;
  private state: VadV8State = 'idle';
  private atMs = 0;
  private noiseFloor: number;
  private bandFloors: { low: number; mid: number; high: number };
  private level = 0;
  private zcr = 0;
  private flatness = 1;
  private confidence = 0;
  private noiseKind: VadV8NoiseKind = 'silence';
  private lastFeatures: VadV8WindowFeatures | null = null;
  private calibrating = false;
  private calibrationUntilMs = 0;
  private consecutiveSpeech = 0;
  private consecutiveQuiet = 0;
  private burstStartMs = 0;
  private burstFrames = 0;
  private burstPeakRms = 0;
  private burstPeakConfidence = 0;
  private burstNoise: Partial<Record<VadV8NoiseKind, number>> = {};
  private lastSpeechAtMs = 0;
  private endingSinceMs = 0;
  private hangoverMs: number;
  private turns = 0;
  private backchannels = 0;
  private falsePositives = 0;
  private falsePositivesByReason = emptyFalsePositiveReasons();
  private falsePositivesByNoise = emptyFalsePositiveNoise();
  private endLatencies: number[] = [];
  private windows = 0;
  private fallbackWindows = 0;

  constructor(options: AdaptiveVadV8Options = {}) {
    const problems = validateVadV8Options(options);
    if (problems.length > 0) {
      throw new Error(`Invalid AdaptiveVadV8 options: ${problems.join('; ')}`);
    }
    this.config = resolveVadV8Config(options);
    this.sink = options.sink;
    this.initialNoiseFloor = options.initialNoiseFloor ?? 0.005;
    this.noiseFloor = this.initialNoiseFloor;
    this.bandFloors = { low: 0.0005, mid: 0.0005, high: 0.0005 };
    this.hangoverMs = this.config.hangoverMs;
  }

  // -- read-only state ------------------------------------------------------

  getState(): VadV8State {
    return this.state;
  }

  getConfig(): VadV8Config {
    return { ...this.config };
  }

  getOptions(): VadV8Config {
    return this.getConfig();
  }

  get atMsNow(): number {
    return this.atMs;
  }

  /** Latest window confidence (0..1). */
  get currentConfidence(): number {
    return this.confidence;
  }

  /** True while a turn is open (maybe-speech / speaking / ending). */
  isSpeaking(): boolean {
    return this.state === 'speaking' || this.state === 'ending' || this.state === 'maybe-speech';
  }

  /** True while a confirmed turn is open. */
  isTurnOpen(): boolean {
    return this.state === 'speaking' || this.state === 'ending';
  }

  getLastFeatures(): VadV8WindowFeatures | null {
    return this.lastFeatures ? { ...this.lastFeatures } : null;
  }

  getStats(): VadV8Stats {
    const meanEnd =
      this.endLatencies.length === 0
        ? null
        : this.endLatencies.reduce((a, b) => a + b, 0) / this.endLatencies.length;
    return {
      state: this.state,
      engine: this.config.engine,
      preset: this.config.preset,
      threshold: this.effectiveThreshold(),
      noiseFloor: this.noiseFloor,
      bandFloors: { ...this.bandFloors },
      level: this.level,
      zcr: this.zcr,
      spectralFlatness: this.flatness,
      confidence: this.confidence,
      noiseKind: this.noiseKind,
      hangoverMs: this.hangoverMs,
      calibrating: this.calibrating,
      turns: this.turns,
      backchannels: this.backchannels,
      falsePositives: this.falsePositives,
      falsePositivesByReason: { ...this.falsePositivesByReason },
      falsePositivesByNoise: { ...this.falsePositivesByNoise },
      meanEndLatencyMs: meanEnd,
      windows: this.windows,
      fallbackWindows: this.fallbackWindows,
    };
  }

  /** Effective RMS threshold: max(fixed threshold, floor × multiplier). */
  effectiveThreshold(): number {
    return Math.max(this.config.threshold, this.noiseFloor * this.config.thresholdMultiplier);
  }

  // -- configuration --------------------------------------------------------

  /** Switch room preset live (keeps explicit overrides out — presets replace the profile). */
  setPreset(preset: VadV8PresetName): VadV8Config {
    if (!isVadV8PresetName(preset)) throw new Error(`Unknown VAD v8 preset "${preset}".`);
    const next = VAD_V8_PRESETS[preset];
    const cfg = this.config;
    cfg.preset = preset;
    cfg.threshold = next.threshold;
    cfg.thresholdMultiplier = next.thresholdMultiplier;
    cfg.noiseLearnMs = next.noiseLearnMs;
    cfg.hangoverMs = next.hangoverMs;
    cfg.minHangoverMs = next.minHangoverMs;
    cfg.maxHangoverMs = next.maxHangoverMs;
    cfg.minTurnMs = next.minTurnMs;
    cfg.backchannelMaxMs = next.backchannelMaxMs;
    cfg.maxGapMs = next.maxGapMs;
    cfg.debounceFrames = next.debounceFrames;
    cfg.minConfidence = next.minConfidence;
    cfg.minZcr = next.minZcr;
    cfg.maxZcr = next.maxZcr;
    cfg.maxFlatness = next.maxFlatness;
    cfg.minMidBandMargin = next.minMidBandMargin;
    this.hangoverMs = this.config.hangoverMs;
    return this.getConfig();
  }

  /** Patch thresholds live; returns the effective config. */
  updateOptions(patch: Partial<AdaptiveVadV8Options>): VadV8Config {
    const problems = validateVadV8Options(patch);
    if (problems.length > 0) {
      throw new Error(`Invalid AdaptiveVadV8 options: ${problems.join('; ')}`);
    }
    const cfg = this.config;
    if (patch.preset !== undefined) return this.setPreset(patch.preset);
    if (patch.engine !== undefined) cfg.engine = patch.engine;
    if (patch.threshold !== undefined) cfg.threshold = patch.threshold;
    if (patch.thresholdMultiplier !== undefined) cfg.thresholdMultiplier = patch.thresholdMultiplier;
    if (patch.noiseLearnMs !== undefined) cfg.noiseLearnMs = patch.noiseLearnMs;
    if (patch.hangoverMs !== undefined) {
      cfg.hangoverMs = patch.hangoverMs;
      this.hangoverMs = patch.hangoverMs;
    }
    if (patch.minHangoverMs !== undefined) cfg.minHangoverMs = patch.minHangoverMs;
    if (patch.maxHangoverMs !== undefined) cfg.maxHangoverMs = patch.maxHangoverMs;
    if (patch.minTurnMs !== undefined) cfg.minTurnMs = patch.minTurnMs;
    if (patch.backchannelMaxMs !== undefined) cfg.backchannelMaxMs = patch.backchannelMaxMs;
    if (patch.maxGapMs !== undefined) cfg.maxGapMs = patch.maxGapMs;
    if (patch.debounceFrames !== undefined) cfg.debounceFrames = patch.debounceFrames;
    if (patch.minConfidence !== undefined) cfg.minConfidence = patch.minConfidence;
    if (patch.minZcr !== undefined) cfg.minZcr = patch.minZcr;
    if (patch.maxZcr !== undefined) cfg.maxZcr = patch.maxZcr;
    if (patch.maxFlatness !== undefined) cfg.maxFlatness = patch.maxFlatness;
    if (patch.minMidBandMargin !== undefined) cfg.minMidBandMargin = patch.minMidBandMargin;
    return this.getConfig();
  }

  /** Learn the noise floor fast for `durationMs` (default 1000 ms). */
  startCalibration(durationMs: number = VAD_V8_DEFAULT_CALIBRATION_MS): void {
    this.calibrating = true;
    this.calibrationUntilMs = this.atMs + Math.max(100, durationMs);
  }

  /** Dynamic hangover for the current turn: confident turns end fast, noisy rooms linger. */
  computeHangoverMs(peakConfidence: number, noiseKind: VadV8NoiseKind): number {
    const cfg = this.config;
    // Confident speech → short hangover (fast reply); noisy room → long hangover.
    const noisy = noiseKind === 'fan' || noiseKind === 'white' || noiseKind === 'hum';
    const fromConfidence =
      cfg.maxHangoverMs - (cfg.maxHangoverMs - cfg.minHangoverMs) * Math.min(1, Math.max(0, peakConfidence));
    const hangover = noisy ? Math.max(fromConfidence, cfg.hangoverMs) : fromConfidence;
    return Math.min(cfg.maxHangoverMs, Math.max(cfg.minHangoverMs, Math.round(hangover)));
  }

  // -- the frame path -------------------------------------------------------

  /**
   * Analyse one PCM16 window and advance the state machine.
   * Returns the per-window features (the panel reads them live).
   * Throws on an invalid frame — the caller drops bad audio.
   */
  feed(frame: Uint8Array): VadV8WindowFeatures {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('AdaptiveVadV8: frame must be a non-empty even-length PCM16 buffer.');
    }
    this.atMs += this.config.windowMs;
    this.windows += 1;
    if (this.calibrating && this.atMs >= this.calibrationUntilMs) this.calibrating = false;
    const features = this.analyse(frame);
    this.lastFeatures = features;
    this.level = features.rms;
    this.zcr = features.zcr;
    this.flatness = features.spectralFlatness;
    this.confidence = features.confidence;
    this.noiseKind = features.noiseKind;
    this.learnNoise(features);
    this.step(features);
    return { ...features };
  }

  /** Analyse one window without advancing the state machine (diagnostics). */
  analyse(frame: Uint8Array): VadV8WindowFeatures {
    const rms = pcm16Rms(frame);
    const zcr = pcm16ZeroCrossingRate(frame);
    const useSpectral = this.config.engine !== 'simple';
    let flatness = 1;
    let bandLow = 0;
    let bandMid = 0;
    let bandHigh = 0;
    let midBandMargin = 0;
    let noiseKind: VadV8NoiseKind = 'silence';
    let confidence = 0;
    let speechLikely = false;
    if (useSpectral) {
      const spectrum = vadV8Spectrum(frame, this.config.sampleRateHz);
      flatness = spectralFlatness(spectrum);
      const bands = vadV8BandEnergies(spectrum);
      bandLow = bands.low;
      bandMid = bands.mid;
      bandHigh = bands.high;
      midBandMargin = bandMid / Math.max(1e-6, this.bandFloors.mid);
      noiseKind = classifyVadV8Noise({
        rms,
        zcr,
        spectralFlatness: flatness,
        bandLow,
        bandMid,
        bandHigh,
        threshold: this.effectiveThreshold(),
      });
      confidence = this.spectralConfidence(rms, zcr, flatness, midBandMargin, noiseKind);
      speechLikely = this.spectralVote(rms, zcr, flatness, midBandMargin, confidence, noiseKind);
    } else {
      this.fallbackWindows += 1;
      noiseKind = rms < this.effectiveThreshold() * 0.5 ? 'silence' : 'speech';
      confidence = rms >= this.effectiveThreshold() ? Math.min(1, rms / (this.effectiveThreshold() * 3)) : 0;
      speechLikely = rms >= this.effectiveThreshold() && confidence >= this.config.minConfidence;
    }
    return {
      atMs: this.atMs,
      rms,
      zcr,
      spectralFlatness: flatness,
      bandLow,
      bandMid,
      bandHigh,
      midBandMargin,
      noiseKind,
      confidence,
      speechLikely,
    };
  }

  /** Combined confidence (0..1) from the three votes. */
  spectralConfidence(
    rms: number,
    zcr: number,
    flatness: number,
    midBandMargin: number,
    noiseKind: VadV8NoiseKind,
  ): number {
    if (noiseKind === 'silence') return 0;
    const threshold = this.effectiveThreshold();
    const energyScore = Math.min(1, Math.max(0, (rms - threshold) / (threshold * 3)));
    const zcrInBand = zcr >= this.config.minZcr && zcr <= this.config.maxZcr;
    const zcrScore = zcrInBand
      ? 1 - Math.abs(zcr - (this.config.minZcr + this.config.maxZcr) / 2) / ((this.config.maxZcr - this.config.minZcr) / 2 + 1e-9) * 0.5
      : 0;
    const flatScore = Math.min(1, Math.max(0, (this.config.maxFlatness - flatness) / Math.max(0.05, this.config.maxFlatness)));
    const midScore = Math.min(1, Math.max(0, (midBandMargin - 1) / Math.max(1, this.config.minMidBandMargin)));
    // Energy 40%, ZCR 20%, flatness 15%, mid-band 25%.
    const blended = energyScore * 0.4 + zcrScore * 0.2 + flatScore * 0.15 + midScore * 0.25;
    // Non-speech noise kinds cap the confidence hard — a fan is loud but never speech.
    if (noiseKind === 'fan' || noiseKind === 'white') return Math.min(blended, 0.35);
    if (noiseKind === 'hum') return Math.min(blended, 0.3);
    if (noiseKind === 'click') return Math.min(blended, 0.4);
    return blended;
  }

  /** The triple vote: energy AND ZCR AND flatness AND mid-band must agree. */
  spectralVote(
    rms: number,
    zcr: number,
    flatness: number,
    midBandMargin: number,
    confidence: number,
    noiseKind: VadV8NoiseKind,
  ): boolean {
    if (rms < this.effectiveThreshold()) return false;
    if (zcr < this.config.minZcr || zcr > this.config.maxZcr) return false;
    if (flatness > this.config.maxFlatness) return false;
    if (midBandMargin < this.config.minMidBandMargin) return false;
    if (confidence < this.config.minConfidence) return false;
    if (noiseKind !== 'speech') return false;
    return true;
  }

  /** Adapt the noise floors from a window that is not speech. */
  private learnNoise(features: VadV8WindowFeatures): void {
    const alpha = this.calibrating
      ? VAD_V8_CALIBRATION_ALPHA
      : Math.min(0.05, this.config.windowMs / Math.max(100, this.config.noiseLearnMs));
    if (features.noiseKind === 'speech' && !this.calibrating) {
      // Speech windows barely move the floor — otherwise a long
      // sentence would raise the floor and swallow its own tail.
      const slow = alpha * 0.1;
      this.noiseFloor += (features.rms - this.noiseFloor) * slow;
      return;
    }
    this.noiseFloor += (features.rms - this.noiseFloor) * alpha;
    if (this.noiseFloor < 0.0005) this.noiseFloor = 0.0005;
    const bandAlpha = this.calibrating ? VAD_V8_CALIBRATION_ALPHA : alpha;
    this.bandFloors.low += (features.bandLow - this.bandFloors.low) * bandAlpha;
    this.bandFloors.mid += (features.bandMid - this.bandFloors.mid) * bandAlpha;
    this.bandFloors.high += (features.bandHigh - this.bandFloors.high) * bandAlpha;
    for (const key of ['low', 'mid', 'high'] as const) {
      if (this.bandFloors[key] < 0.0001) this.bandFloors[key] = 0.0001;
    }
  }

  /** State machine step for one analysed window. */
  private step(features: VadV8WindowFeatures): void {
    const speech = features.speechLikely;
    if (speech) {
      this.consecutiveQuiet = 0;
      this.consecutiveSpeech += 1;
      this.lastSpeechAtMs = this.atMs;
      if (this.state === 'idle') {
        this.state = 'maybe-speech';
        this.burstStartMs = this.atMs - this.config.windowMs;
        this.burstFrames = 0;
        this.burstPeakRms = 0;
        this.burstPeakConfidence = 0;
        this.burstNoise = {};
      }
      if (this.state === 'maybe-speech' || this.state === 'speaking' || this.state === 'ending') {
        this.burstFrames += 1;
        this.burstPeakRms = Math.max(this.burstPeakRms, features.rms);
        this.burstPeakConfidence = Math.max(this.burstPeakConfidence, features.confidence);
        this.burstNoise[features.noiseKind] = (this.burstNoise[features.noiseKind] ?? 0) + 1;
        if (this.state === 'maybe-speech' && this.consecutiveSpeech >= this.config.debounceFrames) {
          this.state = 'speaking';
          this.hangoverMs = this.computeHangoverMs(this.burstPeakConfidence, this.dominantBurstNoise());
          this.emit({ kind: 'speech-start', atMs: this.atMs, startedAtMs: this.burstStartMs, peakRms: this.burstPeakRms, peakConfidence: this.burstPeakConfidence, frames: this.burstFrames, noiseKind: this.dominantBurstNoise() });
        }
        if (this.state === 'ending') {
          // Speech resumed inside the hangover — the turn continues, no new start event.
          this.state = 'speaking';
          this.hangoverMs = this.computeHangoverMs(this.burstPeakConfidence, this.dominantBurstNoise());
        }
      }
      return;
    }
    // Not speech in this window.
    this.consecutiveSpeech = 0;
    if (this.state === 'maybe-speech') {
      // Burst died before debounce: classify honestly.
      this.consecutiveQuiet += 1;
      if (this.consecutiveQuiet * this.config.windowMs >= this.config.maxGapMs || this.burstFrames === 0) {
        this.closeBurstAsFalsePositive(this.falsePositiveReason(features));
      }
      return;
    }
    if (this.state === 'speaking') {
      this.state = 'ending';
      this.endingSinceMs = this.atMs;
      return;
    }
    if (this.state === 'ending') {
      this.consecutiveQuiet += 1;
      const quietMs = this.atMs - this.lastSpeechAtMs;
      if (quietMs >= this.hangoverMs) {
        this.closeTurn();
      }
      return;
    }
    // idle: nothing to do.
  }

  private dominantBurstNoise(): VadV8NoiseKind {
    let best: VadV8NoiseKind = 'speech';
    let bestCount = -1;
    for (const [kind, count] of Object.entries(this.burstNoise)) {
      if ((count ?? 0) > bestCount) {
        bestCount = count ?? 0;
        best = kind as VadV8NoiseKind;
      }
    }
    return best;
  }

  private falsePositiveReason(features: VadV8WindowFeatures): VadV8FalsePositiveReason {
    if (features.rms < this.effectiveThreshold()) return 'low-energy';
    if (features.zcr < this.config.minZcr || features.zcr > this.config.maxZcr) return 'zcr-out-of-band';
    if (features.spectralFlatness > this.config.maxFlatness) return 'too-flat';
    if (features.midBandMargin < this.config.minMidBandMargin) return 'no-mid-band';
    if (features.confidence < this.config.minConfidence) return 'low-confidence';
    return 'too-short';
  }

  private closeBurstAsFalsePositive(reason: VadV8FalsePositiveReason): void {
    const durationMs = this.atMs - this.burstStartMs;
    const noiseKind = this.dominantBurstNoise();
    this.falsePositives += 1;
    this.falsePositivesByReason[reason] += 1;
    this.falsePositivesByNoise[noiseKind] += 1;
    this.emit({
      kind: 'false-positive',
      atMs: this.atMs,
      startedAtMs: this.burstStartMs,
      durationMs,
      peakRms: this.burstPeakRms,
      peakConfidence: this.burstPeakConfidence,
      frames: Math.max(1, this.burstFrames),
      noiseKind,
      reason,
    });
    this.resetBurst();
  }

  private closeTurn(): void {
    const durationMs = this.lastSpeechAtMs - this.burstStartMs;
    const endLatencyMs = this.atMs - this.lastSpeechAtMs;
    this.endLatencies.push(endLatencyMs);
    if (this.endLatencies.length > 50) this.endLatencies.shift();
    const noiseKind = this.dominantBurstNoise();
    if (durationMs < this.config.minTurnMs) {
      if (durationMs <= this.config.backchannelMaxMs && this.burstPeakConfidence >= this.config.minConfidence) {
        this.backchannels += 1;
        this.emit({
          kind: 'backchannel',
          atMs: this.atMs,
          startedAtMs: this.burstStartMs,
          endedAtMs: this.lastSpeechAtMs,
          durationMs,
          peakRms: this.burstPeakRms,
          peakConfidence: this.burstPeakConfidence,
          frames: Math.max(1, this.burstFrames),
          noiseKind,
          hangoverAppliedMs: this.hangoverMs,
        });
      } else {
        this.falsePositives += 1;
        this.falsePositivesByReason['too-short'] += 1;
        this.falsePositivesByNoise[noiseKind] += 1;
        this.emit({
          kind: 'false-positive',
          atMs: this.atMs,
          startedAtMs: this.burstStartMs,
          durationMs,
          peakRms: this.burstPeakRms,
          peakConfidence: this.burstPeakConfidence,
          frames: Math.max(1, this.burstFrames),
          noiseKind,
          reason: 'too-short',
        });
      }
      this.resetBurst();
      return;
    }
    this.turns += 1;
    this.emit({
      kind: 'speech-end',
      atMs: this.atMs,
      startedAtMs: this.burstStartMs,
      endedAtMs: this.lastSpeechAtMs,
      durationMs,
      peakRms: this.burstPeakRms,
      peakConfidence: this.burstPeakConfidence,
      frames: Math.max(1, this.burstFrames),
      noiseKind,
      hangoverAppliedMs: this.hangoverMs,
    });
    this.resetBurst();
  }

  private resetBurst(): void {
    this.state = 'idle';
    this.consecutiveSpeech = 0;
    this.consecutiveQuiet = 0;
    this.burstFrames = 0;
    this.burstPeakRms = 0;
    this.burstPeakConfidence = 0;
    this.burstNoise = {};
    this.hangoverMs = this.config.hangoverMs;
  }

  /** End any open turn now (flush at disconnect): emits speech-end / false-positive as fits. */
  flush(): void {
    if (this.state === 'speaking' || this.state === 'ending') {
      this.lastSpeechAtMs = this.atMs;
      this.closeTurn();
      return;
    }
    if (this.state === 'maybe-speech') {
      this.closeBurstAsFalsePositive('too-short');
    }
  }

  /** Reset all counters and state (keeps the config). */
  reset(): void {
    this.resetBurst();
    this.atMs = 0;
    this.noiseFloor = this.initialNoiseFloor;
    this.bandFloors = { low: 0.0005, mid: 0.0005, high: 0.0005 };
    this.turns = 0;
    this.backchannels = 0;
    this.falsePositives = 0;
    this.falsePositivesByReason = emptyFalsePositiveReasons();
    this.falsePositivesByNoise = emptyFalsePositiveNoise();
    this.endLatencies = [];
    this.windows = 0;
    this.fallbackWindows = 0;
    this.lastFeatures = null;
  }

  private emit(event: VadV8Event): void {
    this.sink?.(event);
  }
}

/**
 * Fallback VAD — energy only (the v0.95 `LocalVad` shape), behind
 * the same event interface as `AdaptiveVadV8`. Used when the
 * caller asks for engine `'simple'`, or when spectral analysis
 * cannot run (no engine). Same sample-derived clock, same events.
 */
export class SimpleEnergyVadV8 {
  private readonly vad: AdaptiveVadV8;
  private readonly sink: VadV8EventSink | undefined;

  constructor(options: AdaptiveVadV8Options = {}) {
    this.sink = options.sink;
    this.vad = new AdaptiveVadV8({ ...options, engine: 'simple', sink: (e) => this.sink?.(e) });
  }

  feed(frame: Uint8Array): VadV8WindowFeatures {
    return this.vad.feed(frame);
  }

  analyse(frame: Uint8Array): VadV8WindowFeatures {
    return this.vad.analyse(frame);
  }

  getState(): VadV8State {
    return this.vad.getState();
  }

  isSpeaking(): boolean {
    return this.vad.isSpeaking();
  }

  getStats(): VadV8Stats {
    return this.vad.getStats();
  }

  getConfig(): VadV8Config {
    return this.vad.getConfig();
  }

  setPreset(preset: VadV8PresetName): VadV8Config {
    return this.vad.setPreset(preset);
  }

  updateOptions(patch: Partial<AdaptiveVadV8Options>): VadV8Config {
    return this.vad.updateOptions(patch);
  }

  startCalibration(durationMs?: number): void {
    this.vad.startCalibration(durationMs);
  }

  flush(): void {
    this.vad.flush();
  }

  reset(): void {
    this.vad.reset();
  }
}

/** Factory: `'spectral'` / `'simple'` / `'auto'` (spectral, simple fallback on bad frames). */
export function createVadV8(options: AdaptiveVadV8Options = {}): AdaptiveVadV8 | SimpleEnergyVadV8 {
  if (options.engine === 'simple') return new SimpleEnergyVadV8(options);
  return new AdaptiveVadV8(options);
}

/** One-line summary for diagnostics / the panel. */
export function vadV8Summary(stats: VadV8Stats): string {
  const end =
    stats.meanEndLatencyMs === null ? 'end-latency n/a' : `end-latency ${Math.round(stats.meanEndLatencyMs)}ms`;
  return (
    `VAD v8 (${stats.engine}/${stats.preset}) ${stats.state} ` +
    `level ${stats.level.toFixed(3)} thr ${stats.threshold.toFixed(3)} ` +
    `flat ${stats.spectralFlatness.toFixed(2)} ${stats.noiseKind} ` +
    `turns ${stats.turns} backchannels ${stats.backchannels} fp ${stats.falsePositives} ${end}`
  );
}
