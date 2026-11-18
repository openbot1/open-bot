/**
 * Automatic calibration for voice v23 (v1.36, Team T5).
 *
 * v22 fixed its thresholds in options; v23 measures the room
 * and fits them. The engine consumes RMS samples (0..1) taken
 * while the user is *not* speaking — the noise floor — plus
 * RMS samples of the user's speech, and derives:
 *
 *   - noise floor: a robust percentile of the noise samples
 *     (p90, so a single door slam does not move it);
 *   - speech threshold: floor * factor + margin, clamped, so
 *     endpointing triggers on speech, not on the room;
 *   - gain: the multiplier that would bring the speech RMS to
 *     the target, clamped to a safe range — a quiet mic gets
 *     boosted, a hot mic gets turned down;
 *   - environment class: quiet / office / noisy / very-noisy,
 *     from the floor, so the panel can say *why* the
 *     thresholds are what they are;
 *   - confidence: 0..1 from the sample count (few samples =
 *     a guess, many samples = a measurement).
 *
 * Everything is pure numbers — no mic is opened. The caller
 * supplies the samples; the engine only does the maths.
 * Results apply to a device profile through `applyToProfile`
 * in deviceProfilesV23.
 */
import type { VoiceV23Environment } from './types';
import { clampV23, meanV23, percentileV23, round2V23, round4V23 } from './types';

export interface CalibrationV23Options {
  /** Percentile of the noise samples taken as the floor (default 90). */
  noisePercentile: number;
  /** Threshold = floor * factor + margin (default 3). */
  thresholdFactor: number;
  /** Absolute margin added to the threshold (default 0.02). */
  thresholdMargin: number;
  /** Minimum speech threshold (default 0.05). */
  minThreshold: number;
  /** Maximum speech threshold (default 0.9). */
  maxThreshold: number;
  /** Target speech RMS the gain aims at (default 0.3). */
  targetSpeechRms: number;
  /** Minimum gain multiplier (default 0.5). */
  minGain: number;
  /** Maximum gain multiplier (default 4). */
  maxGain: number;
  /** Noise samples needed for full confidence (default 100). */
  fullConfidenceSamples: number;
}

export function defaultCalibrationV23Options(): CalibrationV23Options {
  return {
    noisePercentile: 90,
    thresholdFactor: 3,
    thresholdMargin: 0.02,
    minThreshold: 0.05,
    maxThreshold: 0.9,
    targetSpeechRms: 0.3,
    minGain: 0.5,
    maxGain: 4,
    fullConfidenceSamples: 100,
  };
}

export function validateCalibrationV23Options(o: Partial<CalibrationV23Options>): string[] {
  const errors: string[] = [];
  const check = (name: keyof CalibrationV23Options, min: number, max: number): void => {
    const v = o[name];
    if (v !== undefined && !(v >= min && v <= max)) errors.push(`${name} must be ${min}..${max}`);
  };
  check('noisePercentile', 50, 99);
  check('thresholdFactor', 1, 10);
  check('thresholdMargin', 0, 0.5);
  check('minThreshold', 0.01, 0.9);
  check('maxThreshold', 0.01, 1);
  check('targetSpeechRms', 0.05, 0.9);
  check('minGain', 0.1, 2);
  check('maxGain', 1, 10);
  check('fullConfidenceSamples', 10, 10000);
  if (o.minThreshold !== undefined && o.maxThreshold !== undefined && o.minThreshold > o.maxThreshold) {
    errors.push('minThreshold must not exceed maxThreshold');
  }
  if (o.minGain !== undefined && o.maxGain !== undefined && o.minGain > o.maxGain) {
    errors.push('minGain must not exceed maxGain');
  }
  return errors;
}

/** Environment thresholds on the noise floor (RMS 0..1). */
export const VOICE_V23_ENVIRONMENT_FLOORS: Record<VoiceV23Environment, { max: number }> = {
  quiet: { max: 0.02 },
  office: { max: 0.08 },
  noisy: { max: 0.2 },
  'very-noisy': { max: 1 },
};

/** Classify a room from its noise floor. */
export function classifyEnvironmentV23(noiseFloor: number): VoiceV23Environment {
  const floor = clampV23(noiseFloor, 0, 1);
  if (floor <= VOICE_V23_ENVIRONMENT_FLOORS.quiet.max) return 'quiet';
  if (floor <= VOICE_V23_ENVIRONMENT_FLOORS.office.max) return 'office';
  if (floor <= VOICE_V23_ENVIRONMENT_FLOORS.noisy.max) return 'noisy';
  return 'very-noisy';
}

export interface VoiceV23CalibrationInput {
  /** RMS samples of room noise (user silent). */
  noiseSamples: readonly number[];
  /** RMS samples of user speech. */
  speechSamples: readonly number[];
}

export interface VoiceV23CalibrationResult {
  noiseFloor: number;
  meanNoiseRms: number;
  meanSpeechRms: number;
  /** Estimated signal-to-noise ratio, dB (Infinity-safe: capped at 60). */
  snrDb: number;
  speechThreshold: number;
  /** Gain multiplier to reach the target speech RMS. */
  gain: number;
  gainDb: number;
  environment: VoiceV23Environment;
  /** 0..1: how much to trust this result (sample count). */
  confidence: number;
  noiseSamples: number;
  speechSamples: number;
  /** Human-readable explanation of the fit. */
  explanation: string;
}

/** Signal-to-noise ratio in dB, capped at 60 dB. */
export function snrDbV23(speechRms: number, noiseRms: number): number {
  if (noiseRms <= 0) return 60;
  if (speechRms <= 0) return 0;
  return round2V23(Math.min(60, 20 * Math.log10(speechRms / noiseRms)));
}

export class CalibrationEngineV23 {
  private readonly opts: CalibrationV23Options;

  constructor(opts: Partial<CalibrationV23Options> = {}) {
    const errors = validateCalibrationV23Options(opts);
    if (errors.length > 0) throw new Error(`Invalid CalibrationV23 options: ${errors.join('; ')}`);
    this.opts = { ...defaultCalibrationV23Options(), ...opts };
  }

  options(): CalibrationV23Options {
    return { ...this.opts };
  }

  /**
   * Fit thresholds + gain from noise and speech samples.
   * Empty noise samples -> floor 0 (quiet assumption, low
   * confidence); empty speech samples -> gain 1 (no basis to
   * change it).
   */
  calibrate(input: VoiceV23CalibrationInput): VoiceV23CalibrationResult {
    const noise = input.noiseSamples.filter((v) => Number.isFinite(v) && v >= 0 && v <= 1);
    const speech = input.speechSamples.filter((v) => Number.isFinite(v) && v >= 0 && v <= 1);
    const noiseFloor = noise.length === 0 ? 0 : round4V23(percentileV23(noise, this.opts.noisePercentile));
    const meanNoise = round4V23(meanV23(noise));
    const meanSpeech = round4V23(meanV23(speech));
    const threshold = round4V23(
      clampV23(noiseFloor * this.opts.thresholdFactor + this.opts.thresholdMargin, this.opts.minThreshold, this.opts.maxThreshold),
    );
    const gain =
      meanSpeech <= 0 ? 1 : round2V23(clampV23(this.opts.targetSpeechRms / meanSpeech, this.opts.minGain, this.opts.maxGain));
    const gainDb = round2V23(20 * Math.log10(gain));
    const environment = classifyEnvironmentV23(noiseFloor);
    const totalSamples = noise.length + speech.length;
    const confidence = round2V23(clampV23(totalSamples / this.opts.fullConfidenceSamples, 0, 1));
    const snrDb = snrDbV23(meanSpeech, Math.max(meanNoise, noiseFloor));
    const explanation =
      noise.length === 0
        ? 'no noise samples: floor assumed 0 (quiet), confidence low — collect room-noise samples first'
        : speech.length === 0
          ? `noise floor ${noiseFloor} (${environment}), no speech samples: gain left at 1x`
          : `noise floor ${noiseFloor} (${environment}), speech RMS ${meanSpeech}, SNR ${snrDb}dB — threshold ${threshold}, gain ${gain}x (${gainDb}dB)`;
    return {
      noiseFloor,
      meanNoiseRms: meanNoise,
      meanSpeechRms: meanSpeech,
      snrDb,
      speechThreshold: threshold,
      gain,
      gainDb,
      environment,
      confidence,
      noiseSamples: noise.length,
      speechSamples: speech.length,
      explanation,
    };
  }

  /** Re-fit from a previous result plus fresh samples (running calibration). */
  recalibrate(
    previous: VoiceV23CalibrationResult,
    extraNoise: readonly number[],
    extraSpeech: readonly number[],
  ): VoiceV23CalibrationResult {
    // Re-running from the summary alone would lose the
    // distribution, so recalibration requires the raw
    // samples to be kept by the caller; this overload exists
    // for the common case where the caller kept only counts.
    // It blends the old floor with the new samples' floor.
    const fresh = this.calibrate({ noiseSamples: extraNoise, speechSamples: extraSpeech });
    const totalNoise = previous.noiseSamples + fresh.noiseSamples;
    const blendedFloor = round4V23(
      totalNoise === 0 ? 0 : (previous.noiseFloor * previous.noiseSamples + fresh.noiseFloor * fresh.noiseSamples) / totalNoise,
    );
    const threshold = round4V23(
      clampV23(blendedFloor * this.opts.thresholdFactor + this.opts.thresholdMargin, this.opts.minThreshold, this.opts.maxThreshold),
    );
    return {
      ...fresh,
      noiseFloor: blendedFloor,
      speechThreshold: threshold,
      environment: classifyEnvironmentV23(blendedFloor),
      noiseSamples: totalNoise,
      speechSamples: previous.speechSamples + fresh.speechSamples,
      confidence: round2V23(clampV23((totalNoise + previous.speechSamples + fresh.speechSamples) / this.opts.fullConfidenceSamples, 0, 1)),
      explanation: `blended with previous calibration (${previous.noiseSamples} noise samples): floor ${blendedFloor}`,
    };
  }
}

export function createCalibrationEngineV23(opts: Partial<CalibrationV23Options> = {}): CalibrationEngineV23 {
  return new CalibrationEngineV23(opts);
}

export function calibrationV23Summary(r: VoiceV23CalibrationResult): string {
  return `calibration: ${r.environment} room, floor ${r.noiseFloor}, threshold ${r.speechThreshold}, gain ${r.gain}x, SNR ${r.snrDb}dB, confidence ${r.confidence}`;
}
