/**
 * Adaptive voice activity detection v7 (v1.08, Đội T5 — voice realtime v7).
 *
 * v5 is a good energy VAD (adaptive threshold + hysteresis +
 * hangover + backchannels), but it still hears things that are not
 * speech: a fan, a hum, a door slam, a cough — anything loud enough
 * crosses the energy line. v7 keeps the v5 skeleton (adaptive noise
 * floor, hysteresis, hangover, sample-derived clock, no model, no
 * native dependency, no microphone) and adds the two things that
 * cut false positives:
 *
 *   - Joint energy + zero-crossing-rate (ZCR) decision: voiced
 *     speech lives in a ZCR band (roughly 0.02–0.5 crossings per
 *     sample); steady hum/fan noise sits below the band and white
 *     noise / clicks sit above it. A window only counts as
 *     speech-likely when its energy AND its ZCR both agree.
 *   - Confidence per window (0..1): energy margin above the
 *     threshold blended with how far inside the ZCR band the
 *     window sits. A burst needs `debounceFrames` consecutive
 *     confident windows before it becomes a turn, and a burst that
 *     dies early is classified honestly: below-confidence bursts
 *     are `false-positive` events (counted by reason), short
 *     confident bursts are `backchannel`s — the caller can tell a
 *     cough apart from an "ừ".
 *
 *   - Presets: `quiet | office | noisy | very-noisy` — named
 *     threshold profiles so the panel can offer "noisy room" as
 *     one tap instead of six numbers. Every preset is still fully
 *     overridable live (`updateOptions` / `setPreset`), and the
 *     effective config is always readable (`getOptions`).
 *
 *   - Calibration: `startCalibration()` learns the noise floor
 *     fast (high learning rate) for a short window — point the mic
 *     at the room for a second and the floor is set, instead of
 *     waiting for the slow EMA to converge.
 *
 * Timing is derived from the samples fed (sample rate), never from
 * the wall clock, so tests are deterministic: feed 20 ms windows
 * of sine / silence / noise and the events land on exact
 * millisecond boundaries.
 */

import { isValidPcm16Frame, pcm16Rms, pcm16Sample } from './audio';
import { REALTIME_MIC_SAMPLE_RATE_HZ } from './types';

/** Named VAD profiles (room presets). */
export type VadV7PresetName = 'quiet' | 'office' | 'noisy' | 'very-noisy';

/** VAD state. */
export type VadV7State = 'idle' | 'maybe-speech' | 'speaking' | 'ending';

/** Why a burst was rejected as not-speech. */
export type VadV7FalsePositiveReason = 'low-energy' | 'low-confidence' | 'zcr-out-of-band' | 'too-short';

/** One VAD v7 event emitted through the sink. */
export interface VadV7Event {
  kind: 'speech-start' | 'speech-end' | 'backchannel' | 'false-positive';
  /** ms since the VAD started (sample-derived clock). */
  atMs: number;
  /** Turn / burst start (ms). */
  startedAtMs: number;
  /** Turn / burst end (speech-end / backchannel / false-positive only). */
  endedAtMs?: number;
  /** Turn / burst duration (ms). */
  durationMs?: number;
  /** Peak RMS inside the turn / burst. */
  peakRms: number;
  /** Peak confidence inside the turn / burst (0..1). */
  peakConfidence: number;
  /** Frames analysed inside the turn / burst. */
  frames: number;
  /** Why a burst was rejected (false-positive only). */
  reason?: VadV7FalsePositiveReason;
}

/** Sink receiving VAD v7 events. */
export type VadV7EventSink = (event: VadV7Event) => void;

/** Live statistics for the UI / diagnostics. */
export interface VadV7Stats {
  state: VadV7State;
  preset: VadV7PresetName;
  /** Current adaptive threshold (RMS). */
  threshold: number;
  /** Tracked noise floor (RMS). */
  noiseFloor: number;
  /** RMS of the most recent window. */
  level: number;
  /** ZCR of the most recent window (0..1). */
  zcr: number;
  /** Confidence of the most recent window (0..1). */
  confidence: number;
  /** True while calibrating (fast floor learning). */
  calibrating: boolean;
  turns: number;
  backchannels: number;
  falsePositives: number;
  falsePositivesByReason: Record<VadV7FalsePositiveReason, number>;
  totalSpeechMs: number;
  /** ms of speech in the current turn (0 when idle). */
  currentTurnMs: number;
  /** ms of quiet in the current turn (0 when idle). */
  currentGapMs: number;
}

/** Full VAD v7 configuration (what the tools / panel read + write). */
export interface VadV7Config {
  preset: VadV7PresetName;
  sampleRateHz: number;
  windowMs: number;
  baseThreshold: number;
  adaptive: boolean;
  noiseLearnMs: number;
  thresholdMultiplier: number;
  hangoverMs: number;
  maxGapMs: number;
  minTurnMs: number;
  backchannelMaxMs: number;
  /** Consecutive confident windows before a turn starts. */
  debounceFrames: number;
  /** Minimum window confidence to count as speech-likely. */
  minConfidence: number;
  /** ZCR band: speech must stay inside [minZcr, maxZcr]. */
  minZcr: number;
  maxZcr: number;
}

/** Options for `AdaptiveVadV7` (everything optional). */
export interface AdaptiveVadV7Options {
  sampleRateHz?: number;
  windowMs?: number;
  /** Named preset (defaults are the 'office' profile). */
  preset?: VadV7PresetName;
  baseThreshold?: number;
  adaptive?: boolean;
  noiseLearnMs?: number;
  thresholdMultiplier?: number;
  hangoverMs?: number;
  maxGapMs?: number;
  minTurnMs?: number;
  backchannelMaxMs?: number;
  debounceFrames?: number;
  minConfidence?: number;
  minZcr?: number;
  maxZcr?: number;
  sink?: VadV7EventSink;
}

/** Default VAD v7 base threshold (RMS 0..1). */
export const VAD_V7_DEFAULT_THRESHOLD = 0.02;
/** Default hangover before a turn ends (ms). */
export const VAD_V7_DEFAULT_HANGOVER_MS = 350;
/** Default window analysed per step (ms). */
export const VAD_V7_DEFAULT_WINDOW_MS = 20;
/** Default noise-floor learning time constant (ms). */
export const VAD_V7_DEFAULT_NOISE_LEARN_MS = 2000;
/** Default multiplier: threshold = noiseFloor * this (when adaptive). */
export const VAD_V7_DEFAULT_THRESHOLD_MULTIPLIER = 4;
/** Default minimum turn length (ms). */
export const VAD_V7_DEFAULT_MIN_TURN_MS = 200;
/** Default backchannel ceiling (ms). */
export const VAD_V7_DEFAULT_BACKCHANNEL_MAX_MS = 250;
/** Default max quiet gap forgiven inside a turn (ms). */
export const VAD_V7_DEFAULT_MAX_GAP_MS = 400;
/** Default consecutive confident windows before a turn starts. */
export const VAD_V7_DEFAULT_DEBOUNCE_FRAMES = 2;
/** Default minimum window confidence (0..1). */
export const VAD_V7_DEFAULT_MIN_CONFIDENCE = 0.55;
/** Default ZCR band for speech (crossings per sample). */
export const VAD_V7_DEFAULT_MIN_ZCR = 0.02;
export const VAD_V7_DEFAULT_MAX_ZCR = 0.5;
/** Absolute threshold ceiling — the adaptive threshold never exceeds this. */
export const VAD_V7_MAX_THRESHOLD = 0.25;
/** Absolute threshold floor — the adaptive threshold never goes below this. */
export const VAD_V7_MIN_THRESHOLD = 0.005;
/** Calibration learning rate (fraction of the way to the window RMS per step). */
export const VAD_V7_CALIBRATION_ALPHA = 0.25;
/** Default calibration length (ms of room tone to learn from). */
export const VAD_V7_DEFAULT_CALIBRATION_MS = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Named presets: one tap in the panel instead of six numbers. */
export const VAD_V7_PRESETS: Record<VadV7PresetName, Omit<VadV7Config, 'preset' | 'sampleRateHz' | 'windowMs'>> = {
  quiet: {
    baseThreshold: 0.015,
    adaptive: true,
    noiseLearnMs: 2000,
    thresholdMultiplier: 3,
    hangoverMs: 300,
    maxGapMs: 400,
    minTurnMs: 200,
    backchannelMaxMs: 250,
    debounceFrames: 2,
    minConfidence: 0.5,
    minZcr: 0.02,
    maxZcr: 0.5,
  },
  office: {
    baseThreshold: 0.02,
    adaptive: true,
    noiseLearnMs: 2000,
    thresholdMultiplier: 4,
    hangoverMs: 350,
    maxGapMs: 400,
    minTurnMs: 200,
    backchannelMaxMs: 250,
    debounceFrames: 2,
    minConfidence: 0.55,
    minZcr: 0.02,
    maxZcr: 0.5,
  },
  noisy: {
    baseThreshold: 0.03,
    adaptive: true,
    noiseLearnMs: 1500,
    thresholdMultiplier: 5,
    hangoverMs: 400,
    maxGapMs: 500,
    minTurnMs: 250,
    backchannelMaxMs: 250,
    debounceFrames: 3,
    minConfidence: 0.6,
    minZcr: 0.03,
    maxZcr: 0.45,
  },
  'very-noisy': {
    baseThreshold: 0.045,
    adaptive: true,
    noiseLearnMs: 1200,
    thresholdMultiplier: 6,
    hangoverMs: 450,
    maxGapMs: 500,
    minTurnMs: 300,
    backchannelMaxMs: 200,
    debounceFrames: 3,
    minConfidence: 0.65,
    minZcr: 0.05,
    maxZcr: 0.4,
  },
};

/** The preset names, in panel order. */
export const VAD_V7_PRESET_NAMES: VadV7PresetName[] = ['quiet', 'office', 'noisy', 'very-noisy'];

/** True when the name is one of the VAD v7 presets. */
export function isVadV7PresetName(name: string): name is VadV7PresetName {
  return (VAD_V7_PRESET_NAMES as readonly string[]).includes(name);
}

/**
 * Zero-crossing rate of a PCM16 frame (0..1 crossings per sample).
 * Voiced speech sits roughly 0.02–0.3; a steady hum sits near 0
 * (one crossing per cycle of a low tone is still low at 16 kHz)
 * and white noise / clicks sit near 0.5. Exported for tests.
 */
export function pcm16ZeroCrossingRate(frame: Uint8Array): number {
  const samples = Math.floor(frame.length / 2);
  if (samples < 2) return 0;
  let crossings = 0;
  let prev = pcm16Sample(frame, 0);
  for (let i = 1; i < samples; i++) {
    const cur = pcm16Sample(frame, i);
    if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) crossings += 1;
    prev = cur;
  }
  return crossings / (samples - 1);
}

/** Default VAD v7 config (the 'office' preset). */
export function defaultVadV7Options(): VadV7Config {
  return {
    preset: 'office',
    sampleRateHz: REALTIME_MIC_SAMPLE_RATE_HZ,
    windowMs: VAD_V7_DEFAULT_WINDOW_MS,
    ...VAD_V7_PRESETS.office,
  };
}

/**
 * Adaptive energy + ZCR VAD. Feed PCM16 frames of any length;
 * windows are analysed in order and events fire through `sink`.
 * `nowMs` is a sample-derived clock (ms since the first frame).
 */
export class AdaptiveVadV7 {
  private readonly sampleRateHz: number;
  private readonly windowSamples: number;
  private readonly windowMs: number;
  private preset: VadV7PresetName;
  private baseThreshold: number;
  private adaptive: boolean;
  private noiseAlpha: number;
  private thresholdMultiplier: number;
  private hangoverMs: number;
  private maxGapMs: number;
  private minTurnMs: number;
  private backchannelMaxMs: number;
  private debounceFrames: number;
  private minConfidence: number;
  private minZcr: number;
  private maxZcr: number;
  private readonly sink?: VadV7EventSink;

  private state: VadV7State = 'idle';
  private noiseFloor = 0.001;
  private leftover = new Uint8Array(0);
  private lastLevel = 0;
  private lastZcr = 0;
  private lastConfidence = 0;
  private clockMs = 0;
  private turnStartMs = 0;
  private turnPeakRms = 0;
  private turnPeakConfidence = 0;
  private turnFrames = 0;
  private turnSpeechMs = 0;
  private gapMs = 0;
  private quietMs = 0;
  private turns = 0;
  private backchannels = 0;
  private totalSpeechMs = 0;
  private maybeStartMs = 0;
  private maybePeakRms = 0;
  private maybePeakConfidence = 0;
  private maybeFrames = 0;
  private maybeConfidentFrames = 0;
  private maybeRejectReason: VadV7FalsePositiveReason | null = null;
  private readonly falsePositives: Record<VadV7FalsePositiveReason, number> = {
    'low-energy': 0,
    'low-confidence': 0,
    'zcr-out-of-band': 0,
    'too-short': 0,
  };
  private calibrating = false;
  private calibrationEndsAtMs = 0;
  private calibrationFrames = 0;

  constructor(options: AdaptiveVadV7Options = {}) {
    this.sampleRateHz = options.sampleRateHz ?? REALTIME_MIC_SAMPLE_RATE_HZ;
    const windowMs = options.windowMs ?? VAD_V7_DEFAULT_WINDOW_MS;
    this.windowMs = windowMs;
    this.windowSamples = Math.max(1, Math.round((this.sampleRateHz * windowMs) / 1000));
    this.preset = options.preset ?? 'office';
    const preset = VAD_V7_PRESETS[this.preset];
    this.baseThreshold = options.baseThreshold ?? preset.baseThreshold;
    this.adaptive = options.adaptive ?? preset.adaptive;
    const learnMs = options.noiseLearnMs ?? preset.noiseLearnMs;
    this.noiseAlpha = clamp(windowMs / Math.max(windowMs, learnMs), 0.001, 1);
    this.thresholdMultiplier = options.thresholdMultiplier ?? preset.thresholdMultiplier;
    this.hangoverMs = options.hangoverMs ?? preset.hangoverMs;
    this.maxGapMs = options.maxGapMs ?? preset.maxGapMs;
    this.minTurnMs = options.minTurnMs ?? preset.minTurnMs;
    this.backchannelMaxMs = options.backchannelMaxMs ?? preset.backchannelMaxMs;
    this.debounceFrames = options.debounceFrames ?? preset.debounceFrames;
    this.minConfidence = options.minConfidence ?? preset.minConfidence;
    this.minZcr = options.minZcr ?? preset.minZcr;
    this.maxZcr = options.maxZcr ?? preset.maxZcr;
    this.sink = options.sink;
  }

  /** Effective config (current values after any live update). */
  getOptions(): VadV7Config {
    return {
      preset: this.preset,
      sampleRateHz: this.sampleRateHz,
      windowMs: this.windowMs,
      baseThreshold: this.baseThreshold,
      adaptive: this.adaptive,
      noiseLearnMs: Math.round(this.windowMs / Math.max(0.001, this.noiseAlpha)),
      thresholdMultiplier: this.thresholdMultiplier,
      hangoverMs: this.hangoverMs,
      maxGapMs: this.maxGapMs,
      minTurnMs: this.minTurnMs,
      backchannelMaxMs: this.backchannelMaxMs,
      debounceFrames: this.debounceFrames,
      minConfidence: this.minConfidence,
      minZcr: this.minZcr,
      maxZcr: this.maxZcr,
    };
  }

  getPreset(): VadV7PresetName {
    return this.preset;
  }

  /** Current state. */
  getState(): VadV7State {
    return this.state;
  }

  /** True while a turn is in progress (maybe-speech counts as no). */
  isSpeaking(): boolean {
    return this.state === 'speaking' || this.state === 'ending';
  }

  /** Current adaptive threshold (RMS). */
  getThreshold(): number {
    if (!this.adaptive) return this.baseThreshold;
    return clamp(
      Math.max(this.baseThreshold, this.noiseFloor * this.thresholdMultiplier),
      VAD_V7_MIN_THRESHOLD,
      VAD_V7_MAX_THRESHOLD,
    );
  }

  /** Tracked noise floor (RMS). */
  getNoiseFloor(): number {
    return this.noiseFloor;
  }

  /** RMS of the most recent window. */
  get level(): number {
    return this.lastLevel;
  }

  /** ZCR of the most recent window. */
  get zcr(): number {
    return this.lastZcr;
  }

  /** Confidence of the most recent window. */
  get confidence(): number {
    return this.lastConfidence;
  }

  /** Sample-derived clock (ms since start). */
  get nowMs(): number {
    return this.clockMs;
  }

  getStats(): VadV7Stats {
    return {
      state: this.state,
      preset: this.preset,
      threshold: this.getThreshold(),
      noiseFloor: this.noiseFloor,
      level: this.lastLevel,
      zcr: this.lastZcr,
      confidence: this.lastConfidence,
      calibrating: this.calibrating,
      turns: this.turns,
      backchannels: this.backchannels,
      falsePositives: this.falsePositives['low-energy'] + this.falsePositives['low-confidence'] + this.falsePositives['zcr-out-of-band'] + this.falsePositives['too-short'],
      falsePositivesByReason: { ...this.falsePositives },
      totalSpeechMs: this.totalSpeechMs,
      currentTurnMs: this.state === 'speaking' || this.state === 'ending' ? this.turnSpeechMs : 0,
      currentGapMs: this.state === 'speaking' || this.state === 'ending' ? this.gapMs : 0,
    };
  }

  /**
   * Switch to a named preset (live: applies from the next window;
   * the noise floor and the current turn are kept). Returns the
   * effective config. Throws on an unknown preset.
   */
  setPreset(name: VadV7PresetName): VadV7Config {
    if (!isVadV7PresetName(name)) throw new Error(`Unknown VAD v7 preset "${name}".`);
    this.preset = name;
    const preset = VAD_V7_PRESETS[name];
    this.baseThreshold = preset.baseThreshold;
    this.adaptive = preset.adaptive;
    this.noiseAlpha = clamp(this.windowMs / Math.max(this.windowMs, preset.noiseLearnMs), 0.001, 1);
    this.thresholdMultiplier = preset.thresholdMultiplier;
    this.hangoverMs = preset.hangoverMs;
    this.maxGapMs = preset.maxGapMs;
    this.minTurnMs = preset.minTurnMs;
    this.backchannelMaxMs = preset.backchannelMaxMs;
    this.debounceFrames = preset.debounceFrames;
    this.minConfidence = preset.minConfidence;
    this.minZcr = preset.minZcr;
    this.maxZcr = preset.maxZcr;
    return this.getOptions();
  }

  /**
   * Reconfigure live (a new threshold / hangover / preset applies
   * from the next window; the noise floor and the current turn are
   * kept). Throws on an invalid patch. Returns the effective config.
   */
  updateOptions(patch: Omit<AdaptiveVadV7Options, 'sampleRateHz' | 'sink' | 'windowMs'>): VadV7Config {
    const errors = validateVadV7Options(patch);
    if (errors.length > 0) {
      throw new Error(`Invalid VAD v7 options: ${errors.join(' ')}`);
    }
    if (patch.preset !== undefined) {
      // A preset resets the tunable numbers to the profile, then
      // the explicit overrides below win over it.
      this.setPreset(patch.preset);
    }
    if (patch.baseThreshold !== undefined) this.baseThreshold = patch.baseThreshold;
    if (patch.adaptive !== undefined) this.adaptive = patch.adaptive;
    if (patch.thresholdMultiplier !== undefined) this.thresholdMultiplier = patch.thresholdMultiplier;
    if (patch.hangoverMs !== undefined) this.hangoverMs = patch.hangoverMs;
    if (patch.maxGapMs !== undefined) this.maxGapMs = patch.maxGapMs;
    if (patch.minTurnMs !== undefined) this.minTurnMs = patch.minTurnMs;
    if (patch.backchannelMaxMs !== undefined) this.backchannelMaxMs = patch.backchannelMaxMs;
    if (patch.debounceFrames !== undefined) this.debounceFrames = patch.debounceFrames;
    if (patch.minConfidence !== undefined) this.minConfidence = patch.minConfidence;
    if (patch.minZcr !== undefined) this.minZcr = patch.minZcr;
    if (patch.maxZcr !== undefined) this.maxZcr = patch.maxZcr;
    if (patch.noiseLearnMs !== undefined) {
      this.noiseAlpha = clamp(this.windowMs / Math.max(this.windowMs, patch.noiseLearnMs), 0.001, 1);
    }
    return this.getOptions();
  }

  /**
   * Learn the noise floor fast: for `durationMs` the floor tracks
   * each window aggressively (alpha 0.25) instead of the slow EMA.
   * Point the mic at the room, not at the speaker. While
   * calibrating, speech detection still runs — a loud window just
   * does not drag the floor up with it (the floor only learns
   * from quiet windows, as usual).
   */
  startCalibration(durationMs = VAD_V7_DEFAULT_CALIBRATION_MS): void {
    this.calibrating = true;
    this.calibrationEndsAtMs = this.clockMs + Math.max(50, durationMs);
    this.calibrationFrames = 0;
  }

  /** Stop calibrating early (the floor learned so far is kept). */
  stopCalibration(): void {
    this.calibrating = false;
    this.calibrationEndsAtMs = 0;
  }

  /** Feed PCM16 audio (any length). Throws on invalid frames. */
  feed(frame: Uint8Array): void {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('AdaptiveVadV7: frame must be a non-empty even-length PCM16 buffer.');
    }
    const joined = new Uint8Array(this.leftover.length + frame.length);
    joined.set(this.leftover, 0);
    joined.set(frame, this.leftover.length);
    const windowBytes = this.windowSamples * 2;
    let offset = 0;
    while (joined.length - offset >= windowBytes) {
      this.analyseWindow(joined.slice(offset, offset + windowBytes));
      offset += windowBytes;
    }
    this.leftover = joined.slice(offset);
  }

  /** End the current turn immediately (flush at session end). */
  flush(): VadV7Event | null {
    if (this.state === 'speaking' || this.state === 'ending') {
      return this.commitTurn(this.clockMs, true);
    }
    if (this.state === 'maybe-speech') {
      this.classifyMaybeBurst(this.clockMs, 'too-short');
      this.state = 'idle';
      return null;
    }
    return null;
  }

  /** Reset all state (new session). Keeps the learned noise floor. */
  reset(): void {
    this.state = 'idle';
    this.leftover = new Uint8Array(0);
    this.lastLevel = 0;
    this.lastZcr = 0;
    this.lastConfidence = 0;
    this.turnStartMs = 0;
    this.turnPeakRms = 0;
    this.turnPeakConfidence = 0;
    this.turnFrames = 0;
    this.turnSpeechMs = 0;
    this.gapMs = 0;
    this.quietMs = 0;
    this.turns = 0;
    this.backchannels = 0;
    this.totalSpeechMs = 0;
    this.maybeStartMs = 0;
    this.maybePeakRms = 0;
    this.maybePeakConfidence = 0;
    this.maybeFrames = 0;
    this.maybeConfidentFrames = 0;
    this.maybeRejectReason = null;
    this.calibrating = false;
    this.calibrationEndsAtMs = 0;
    this.calibrationFrames = 0;
    for (const key of Object.keys(this.falsePositives) as VadV7FalsePositiveReason[]) {
      this.falsePositives[key] = 0;
    }
  }

  private emit(event: VadV7Event): void {
    try {
      this.sink?.(event);
    } catch {
      // A throwing sink must not break detection.
    }
  }

  /**
   * Confidence of one window (0..1): half energy margin above the
   * start threshold, half how far inside the ZCR band the window
   * sits. A loud window with speech-like ZCR scores near 1; a loud
   * window with out-of-band ZCR (hum, click, white noise) scores
   * low even though it is loud.
   */
  private windowConfidence(rms: number, zcr: number, startThreshold: number): number {
    const energyScore = clamp((rms - startThreshold) / Math.max(0.001, startThreshold), 0, 1);
    let zcrScore: number;
    if (zcr < this.minZcr || zcr > this.maxZcr) {
      zcrScore = 0;
    } else if (zcr <= (this.minZcr + this.maxZcr) / 2) {
      zcrScore = (zcr - this.minZcr) / Math.max(0.001, (this.maxZcr - this.minZcr) / 2);
    } else {
      zcrScore = (this.maxZcr - zcr) / Math.max(0.001, (this.maxZcr - this.minZcr) / 2);
    }
    return clamp(0.5 * energyScore + 0.5 * clamp(zcrScore, 0, 1), 0, 1);
  }

  private analyseWindow(window: Uint8Array): void {
    const rms = pcm16Rms(window);
    const zcr = pcm16ZeroCrossingRate(window);
    this.lastLevel = rms;
    this.lastZcr = zcr;
    this.clockMs += this.windowMs;
    if (this.calibrating && this.clockMs >= this.calibrationEndsAtMs) {
      this.calibrating = false;
      this.calibrationEndsAtMs = 0;
    }
    const startThreshold = this.getThreshold();
    // End threshold is lower (hysteresis): speech wobbling around
    // the start line does not flutter the state.
    const endThreshold = startThreshold * 0.6;
    const confidence = this.windowConfidence(rms, zcr, startThreshold);
    this.lastConfidence = confidence;
    const isLoud = rms >= startThreshold;
    const isQuiet = rms < endThreshold;
    const zcrInBand = zcr >= this.minZcr && zcr <= this.maxZcr;
    const speechLikely = isLoud && zcrInBand && confidence >= this.minConfidence;

    // Noise floor only learns while nothing is happening; while
    // calibrating it learns fast (alpha 0.25 per window).
    if (this.state === 'idle' && !isLoud) {
      const alpha = this.calibrating ? VAD_V7_CALIBRATION_ALPHA : this.noiseAlpha;
      this.noiseFloor += (rms - this.noiseFloor) * alpha;
      if (this.noiseFloor < 0.0001) this.noiseFloor = 0.0001;
      if (this.calibrating) this.calibrationFrames += 1;
    }

    switch (this.state) {
      case 'idle': {
        if (isLoud) {
          this.state = 'maybe-speech';
          this.maybeStartMs = this.clockMs - this.windowMs;
          this.maybePeakRms = rms;
          this.maybePeakConfidence = confidence;
          this.maybeFrames = 1;
          this.maybeConfidentFrames = speechLikely ? 1 : 0;
          // Remember WHY this burst looks suspicious, so a burst
          // that dies early can be classified honestly instead of
          // silently vanishing: ZCR out of band beats low
          // confidence (the energy was there, the shape was not).
          this.maybeRejectReason = !zcrInBand
            ? 'zcr-out-of-band'
            : confidence < this.minConfidence
              ? 'low-confidence'
              : null;
        }
        break;
      }
      case 'maybe-speech': {
        if (speechLikely) {
          this.maybePeakRms = Math.max(this.maybePeakRms, rms);
          this.maybePeakConfidence = Math.max(this.maybePeakConfidence, confidence);
          this.maybeFrames += 1;
          this.maybeConfidentFrames += 1;
          if (this.maybeConfidentFrames >= this.debounceFrames) {
            const elapsed = this.clockMs - this.maybeStartMs;
            if (elapsed >= this.minTurnMs) {
              this.state = 'speaking';
              this.turnStartMs = this.maybeStartMs;
              this.turnPeakRms = this.maybePeakRms;
              this.turnPeakConfidence = this.maybePeakConfidence;
              this.turnFrames = this.maybeFrames;
              this.turnSpeechMs = elapsed;
              this.gapMs = 0;
              this.quietMs = 0;
              this.emit({
                kind: 'speech-start',
                atMs: this.clockMs,
                startedAtMs: this.turnStartMs,
                peakRms: this.turnPeakRms,
                peakConfidence: this.turnPeakConfidence,
                frames: this.turnFrames,
              });
            }
            // Debounced but still below minTurnMs: stay in
            // maybe-speech until the turn is long enough to be
            // real (a 40 ms "yeah" must not open a turn).
          }
        } else if (isQuiet) {
          // Burst ended before it became a turn — classify it:
          // a confident-enough burst is a backchannel ("ừ",
          // "yeah", a cough the VAD still believes); anything
          // else is a false positive (noise that crossed the
          // energy line but failed the shape test).
          this.classifyMaybeBurst(this.clockMs, null);
          this.state = 'idle';
          this.maybeFrames = 0;
          this.maybeConfidentFrames = 0;
        } else {
          // Mid-level energy, or loud but not speech-likely:
          // keep watching, remember the shape failure.
          this.maybeFrames += 1;
          if (isLoud) {
            this.maybePeakRms = Math.max(this.maybePeakRms, rms);
            this.maybePeakConfidence = Math.max(this.maybePeakConfidence, confidence);
            if (!zcrInBand) this.maybeRejectReason = 'zcr-out-of-band';
            else if (confidence < this.minConfidence && this.maybeRejectReason === null) {
              this.maybeRejectReason = 'low-confidence';
            }
          }
        }
        break;
      }
      case 'speaking': {
        if (isLoud) {
          this.turnPeakRms = Math.max(this.turnPeakRms, rms);
          this.turnPeakConfidence = Math.max(this.turnPeakConfidence, confidence);
          this.turnFrames += 1;
          this.turnSpeechMs += this.windowMs;
          this.gapMs = 0;
          this.quietMs = 0;
        } else if (isQuiet) {
          this.gapMs += this.windowMs;
          this.quietMs += this.windowMs;
          if (this.gapMs <= this.maxGapMs) {
            this.turnFrames += 1;
          } else if (this.quietMs >= this.hangoverMs) {
            this.commitTurn(this.clockMs, false);
          } else {
            this.state = 'ending';
            this.turnFrames += 1;
          }
        } else {
          this.turnFrames += 1;
          this.quietMs = 0;
        }
        break;
      }
      case 'ending': {
        if (isLoud) {
          this.state = 'speaking';
          this.turnPeakRms = Math.max(this.turnPeakRms, rms);
          this.turnPeakConfidence = Math.max(this.turnPeakConfidence, confidence);
          this.turnFrames += 1;
          this.turnSpeechMs += this.windowMs;
          this.gapMs = 0;
          this.quietMs = 0;
        } else if (isQuiet) {
          this.quietMs += this.windowMs;
          this.gapMs += this.windowMs;
          this.turnFrames += 1;
          if (this.quietMs >= this.hangoverMs) {
            this.commitTurn(this.clockMs, false);
          }
        } else {
          this.state = 'speaking';
          this.turnFrames += 1;
          this.quietMs = 0;
          this.gapMs = 0;
        }
        break;
      }
    }
  }

  /**
   * Classify a maybe-speech burst that ended before becoming a
   * turn. `forcedReason` overrides the remembered shape failure
   * (flush uses 'too-short'). Confident bursts are backchannels;
   * the rest are false positives, counted by reason.
   */
  private classifyMaybeBurst(atMs: number, forcedReason: VadV7FalsePositiveReason | null): void {
    const durationMs = Math.max(0, atMs - this.maybeStartMs);
    const confident = this.maybePeakConfidence >= this.minConfidence && this.maybeConfidentFrames > 0;
    if (confident && durationMs <= this.backchannelMaxMs && this.maybeFrames > 0) {
      this.backchannels += 1;
      this.emit({
        kind: 'backchannel',
        atMs,
        startedAtMs: this.maybeStartMs,
        endedAtMs: atMs,
        durationMs,
        peakRms: this.maybePeakRms,
        peakConfidence: this.maybePeakConfidence,
        frames: this.maybeFrames,
      });
      return;
    }
    const reason: VadV7FalsePositiveReason =
      forcedReason ?? this.maybeRejectReason ?? (durationMs < this.minTurnMs ? 'too-short' : 'low-confidence');
    this.falsePositives[reason] += 1;
    this.emit({
      kind: 'false-positive',
      atMs,
      startedAtMs: this.maybeStartMs,
      endedAtMs: atMs,
      durationMs,
      peakRms: this.maybePeakRms,
      peakConfidence: this.maybePeakConfidence,
      frames: this.maybeFrames,
      reason,
    });
  }

  private commitTurn(atMs: number, forced: boolean): VadV7Event {
    const endedAtMs = atMs;
    const durationMs = Math.max(0, endedAtMs - this.turnStartMs);
    const event: VadV7Event = {
      kind: 'speech-end',
      atMs,
      startedAtMs: this.turnStartMs,
      endedAtMs,
      durationMs,
      peakRms: this.turnPeakRms,
      peakConfidence: this.turnPeakConfidence,
      frames: this.turnFrames,
    };
    void forced;
    this.turns += 1;
    this.totalSpeechMs += durationMs;
    this.state = 'idle';
    this.turnSpeechMs = 0;
    this.gapMs = 0;
    this.quietMs = 0;
    this.turnFrames = 0;
    this.turnPeakRms = 0;
    this.turnPeakConfidence = 0;
    this.emit(event);
    return event;
  }
}

/** Validate a VAD v7 options patch; returns error strings (empty = ok). */
export function validateVadV7Options(patch: Partial<AdaptiveVadV7Options>): string[] {
  const errors: string[] = [];
  const num = (name: string, value: number | undefined, min: number, max: number): void => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push(`${name} must be a finite number ${min}..${max}.`);
    }
  };
  num('baseThreshold', patch.baseThreshold, VAD_V7_MIN_THRESHOLD, VAD_V7_MAX_THRESHOLD);
  num('thresholdMultiplier', patch.thresholdMultiplier, 1, 20);
  num('hangoverMs', patch.hangoverMs, 50, 5000);
  num('maxGapMs', patch.maxGapMs, 0, 2000);
  num('minTurnMs', patch.minTurnMs, 0, 2000);
  num('backchannelMaxMs', patch.backchannelMaxMs, 0, 2000);
  num('noiseLearnMs', patch.noiseLearnMs, 100, 30000);
  num('windowMs', patch.windowMs, 10, 100);
  num('debounceFrames', patch.debounceFrames, 1, 10);
  num('minConfidence', patch.minConfidence, 0, 1);
  num('minZcr', patch.minZcr, 0, 0.9);
  num('maxZcr', patch.maxZcr, 0.05, 1);
  if (patch.sampleRateHz !== undefined && (!Number.isInteger(patch.sampleRateHz) || patch.sampleRateHz <= 0)) {
    errors.push('sampleRateHz must be a positive integer.');
  }
  if (patch.minTurnMs !== undefined && patch.backchannelMaxMs !== undefined && patch.minTurnMs > patch.backchannelMaxMs) {
    errors.push('minTurnMs must not exceed backchannelMaxMs (a burst cannot be both a turn and a backchannel).');
  }
  if (patch.minZcr !== undefined && patch.maxZcr !== undefined && patch.minZcr >= patch.maxZcr) {
    errors.push('minZcr must be below maxZcr.');
  }
  if (patch.preset !== undefined && !isVadV7PresetName(patch.preset)) {
    errors.push(`preset must be one of ${VAD_V7_PRESET_NAMES.join(', ')}.`);
  }
  return errors;
}
