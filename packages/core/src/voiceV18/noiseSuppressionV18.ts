/**
 * Noise suppression v18 (v1.19, Đội T5 — voice v18).
 *
 * v10 estimated a noise profile from silence frames and applied a
 * Wiener-style gain per band, but it ran *after* the VAD had
 * already decided: a loud room still tripped the detector before
 * the suppressor ever saw the frame, and its profile never
 * reported *how loud the room is* in a form the session could act
 * on. v18 sits *in front of* the VAD:
 *
 *   1. Noise estimation. `NoiseEstimatorV18` learns the room from
 *      frames the caller marks as non-speech (silence / noise):
 *      per-band RMS floors (low band = the raw samples, high band
 *      = the first difference) tracked with a slow EMA, plus a
 *      running signal-to-noise estimate. The profile freezes while
 *      speech is live so the speaker's own voice never becomes
 *      "noise", and goes stale after `staleAfterMs` without a
 *      learning frame — a profile learned in another room is
 *      reported, not trusted.
 *   2. Spectral gate. `NoiseGateV18` opens only when the frame's
 *      speech-band energy clears the noise floor by
 *      `openThresholdDb` and closes after `closeDelayMs` of
 *      sub-threshold frames (attack fast, release slow, so the
 *      gate does not chatter on a breath). While closed the frame
 *      is attenuated to the `closedGain` floor — never silenced
 *      outright, so a downstream recogniser still hears something
 *      instead of digital silence.
 *   3. Wiener suppression. `NoiseSuppressorV18` applies a
 *      per-band Wiener-style gain (`gain = max(1 − k × noise /
 *      signal, minGain)`), smoothed over time (fast attack, slow
 *      release) so the volume does not pump between frames, and
 *      reports the suppression in dB per frame. Suppression levels
 *      are `off` | `light` | `moderate` | `aggressive`, validated
 *      fail-closed — a bad level is rejected, never clamped.
 *   4. The chain. `NoiseChainV18` wires estimator → gate →
 *      suppressor in the order a frame flows: learn (when the
 *      caller says the frame is not speech), gate, suppress, and
 *      hand the cleaned frame to the VAD. `process()` returns the
 *      cleaned frame plus the gate state and the suppression
 *      applied, so the session can log "room got loud" or raise
 *      the VAD floors instead of cutting a turn short.
 *
 * Frames are PCM16 mono Int16Array, 20 ms (320 samples at 16 kHz).
 * No model, no FFT tables, no audio device — deterministic DSP
 * only. All clocks are virtual (`atMs` passed by the caller).
 */

import { pcm16RmsV18, VAD_V18_FRAME_SAMPLES } from './vadV18';

/** Suppression strength. */
export type NoiseSuppressionV18Level = 'off' | 'light' | 'moderate' | 'aggressive';

export const NOISE_SUPPRESSION_V18_LEVELS = ['off', 'light', 'moderate', 'aggressive'] as const;

export function isNoiseSuppressionV18Level(value: unknown): value is NoiseSuppressionV18Level {
  return typeof value === 'string' && (NOISE_SUPPRESSION_V18_LEVELS as readonly string[]).includes(value);
}

/** Per-band (low / high) RMS split of one frame. */
export interface NoiseBandRmsV18 {
  low: number;
  high: number;
}

/** Split a frame into low/high band RMS via the first difference. */
export function noiseBandRmsV18(frame: Int16Array): NoiseBandRmsV18 {
  if (frame.length === 0) return { low: 0, high: 0 };
  let lowSum = 0;
  let highSum = 0;
  let prev = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] / 32768;
    lowSum += v * v;
    const diff = v - prev;
    highSum += diff * diff;
    prev = v;
  }
  return { low: Math.sqrt(lowSum / frame.length), high: Math.sqrt(highSum / frame.length) };
}

/** dB from a linear gain/ratio (floored so silence is −96 dB, not −∞). */
export function linearToDbV18(value: number): number {
  if (value <= 0) return -96;
  return 20 * Math.log10(value);
}

/** Options for `NoiseEstimatorV18`. */
export interface NoiseEstimatorV18Options {
  /** EMA rate for the noise profile (0..1, higher = faster, default 0.05). */
  learnRate?: number;
  /** Starting low-band floor (RMS 0..1, default 0.01). */
  initialLowFloor?: number;
  /** Starting high-band floor (RMS 0..1, default 0.005). */
  initialHighFloor?: number;
  /** Profile goes stale after this long without a learning frame (ms, default 30000). */
  staleAfterMs?: number;
}

export function defaultNoiseEstimatorV18Options(): Required<NoiseEstimatorV18Options> {
  return { learnRate: 0.05, initialLowFloor: 0.01, initialHighFloor: 0.005, staleAfterMs: 30000 };
}

export function validateNoiseEstimatorV18Options(options: NoiseEstimatorV18Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof NoiseEstimatorV18Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('learnRate', options.learnRate, 0.001, 1);
  check('initialLowFloor', options.initialLowFloor, 0, 1);
  check('initialHighFloor', options.initialHighFloor, 0, 1);
  check('staleAfterMs', options.staleAfterMs, 1000, 600000);
  return errors;
}

export interface NoiseEstimatorV18Stats {
  lowFloor: number;
  highFloor: number;
  /** Estimated noise level in dB (from the low floor). */
  noiseLevelDb: number;
  /** Frames learned from. */
  learnedFrames: number;
  /** True when no learning frame arrived within `staleAfterMs`. */
  stale: boolean;
  /** ms since the last learning frame (undefined = never learned). */
  msSinceLearn: number | undefined;
}

/**
 * Learns the room's noise profile from non-speech frames. Frozen
 * while speech is live — the caller only calls `learn()` for
 * frames it knows are not speech.
 */
export class NoiseEstimatorV18 {
  private readonly options: Required<NoiseEstimatorV18Options>;
  private lowFloor: number;
  private highFloor: number;
  private learnedFrames = 0;
  private lastLearnMs: number | undefined;

  constructor(options: NoiseEstimatorV18Options = {}) {
    const errors = validateNoiseEstimatorV18Options(options);
    if (errors.length > 0) throw new Error(`invalid noise estimator v18 options: ${errors.join('; ')}`);
    this.options = { ...defaultNoiseEstimatorV18Options(), ...options };
    this.lowFloor = this.options.initialLowFloor;
    this.highFloor = this.options.initialHighFloor;
  }

  /** Learn from one non-speech frame (no-op when called with speech — the caller decides). */
  learn(frame: Int16Array, atMs: number): void {
    const bands = noiseBandRmsV18(frame);
    const rate = this.options.learnRate;
    this.lowFloor = this.lowFloor * (1 - rate) + bands.low * rate;
    this.highFloor = this.highFloor * (1 - rate) + bands.high * rate;
    this.learnedFrames += 1;
    this.lastLearnMs = atMs;
  }

  getLowFloor(): number {
    return this.lowFloor;
  }

  getHighFloor(): number {
    return this.highFloor;
  }

  /** Signal-to-noise ratio (dB) of a frame against the learned floors. */
  snrDb(frame: Int16Array): number {
    const bands = noiseBandRmsV18(frame);
    const signal = Math.max(bands.low, 0.0001);
    const noise = Math.max(this.lowFloor, 0.0001);
    return linearToDbV18(signal / noise);
  }

  isStale(atMs: number): boolean {
    if (this.lastLearnMs === undefined) return this.learnedFrames === 0;
    return atMs - this.lastLearnMs > this.options.staleAfterMs;
  }

  reset(): void {
    this.lowFloor = this.options.initialLowFloor;
    this.highFloor = this.options.initialHighFloor;
    this.learnedFrames = 0;
    this.lastLearnMs = undefined;
  }

  stats(atMs: number): NoiseEstimatorV18Stats {
    return {
      lowFloor: this.lowFloor,
      highFloor: this.highFloor,
      noiseLevelDb: linearToDbV18(Math.max(this.lowFloor, 0.0001)),
      learnedFrames: this.learnedFrames,
      stale: this.isStale(atMs),
      msSinceLearn: this.lastLearnMs === undefined ? undefined : atMs - this.lastLearnMs,
    };
  }
}

/** Options for `NoiseGateV18`. */
export interface NoiseGateV18Options {
  /** Frame must clear the floor by this many dB to open the gate (default 6). */
  openThresholdDb?: number;
  /** Sub-threshold time before the gate closes (ms, default 200). */
  closeDelayMs?: number;
  /** Gain applied while the gate is closed (0..1, default 0.1). */
  closedGain?: number;
  /** Gain while the gate is open (0..1, default 1). */
  openGain?: number;
}

export function defaultNoiseGateV18Options(): Required<NoiseGateV18Options> {
  return { openThresholdDb: 6, closeDelayMs: 200, closedGain: 0.1, openGain: 1 };
}

export function validateNoiseGateV18Options(options: NoiseGateV18Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof NoiseGateV18Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('openThresholdDb', options.openThresholdDb, 0, 60);
  check('closeDelayMs', options.closeDelayMs, 0, 10000);
  check('closedGain', options.closedGain, 0, 1);
  check('openGain', options.openGain, 0, 1);
  if (
    options.closedGain !== undefined &&
    options.openGain !== undefined &&
    options.closedGain > options.openGain
  ) {
    errors.push('closedGain must not exceed openGain');
  }
  return errors;
}

export interface NoiseGateV18Stats {
  open: boolean;
  opens: number;
  closes: number;
  gatedFrames: number;
  passedFrames: number;
  /** Fraction of frames the gate closed (0..1). */
  gatedRate: number;
}

/**
 * A noise gate: loud-enough frames pass untouched, quiet frames are
 * attenuated to `closedGain`. Attack is immediate (the first
 * above-threshold frame opens the gate); release is slow
 * (`closeDelayMs`) so the gate does not chatter on a breath.
 */
export class NoiseGateV18 {
  private readonly options: Required<NoiseGateV18Options>;
  private readonly estimator: NoiseEstimatorV18;
  private open = false;
  private belowSinceMs: number | undefined;
  private opens = 0;
  private closes = 0;
  private gatedFrames = 0;
  private passedFrames = 0;

  constructor(estimator: NoiseEstimatorV18, options: NoiseGateV18Options = {}) {
    const errors = validateNoiseGateV18Options(options);
    if (errors.length > 0) throw new Error(`invalid noise gate v18 options: ${errors.join('; ')}`);
    this.estimator = estimator;
    this.options = { ...defaultNoiseGateV18Options(), ...options };
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Apply the gate to one frame; returns the (possibly attenuated) frame. */
  apply(frame: Int16Array, atMs: number): Int16Array {
    const snr = this.estimator.snrDb(frame);
    const above = snr >= this.options.openThresholdDb;
    if (above) {
      if (!this.open) {
        this.open = true;
        this.opens += 1;
      }
      this.belowSinceMs = undefined;
      this.passedFrames += 1;
      return frame;
    }
    if (this.open) {
      if (this.belowSinceMs === undefined) this.belowSinceMs = atMs;
      if (atMs - this.belowSinceMs >= this.options.closeDelayMs) {
        this.open = false;
        this.closes += 1;
        this.belowSinceMs = undefined;
      } else {
        this.passedFrames += 1;
        return frame;
      }
    }
    this.gatedFrames += 1;
    return attenuateFrameV18(frame, this.options.closedGain);
  }

  reset(): void {
    this.open = false;
    this.belowSinceMs = undefined;
    this.opens = 0;
    this.closes = 0;
    this.gatedFrames = 0;
    this.passedFrames = 0;
  }

  stats(): NoiseGateV18Stats {
    const total = this.gatedFrames + this.passedFrames;
    return {
      open: this.open,
      opens: this.opens,
      closes: this.closes,
      gatedFrames: this.gatedFrames,
      passedFrames: this.passedFrames,
      gatedRate: total === 0 ? 0 : this.gatedFrames / total,
    };
  }
}

/** Attenuate a frame by a scalar gain (clamped to PCM16 range). */
export function attenuateFrameV18(frame: Int16Array, gain: number): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    const v = Math.round(frame[i] * gain);
    out[i] = Math.max(-32768, Math.min(32767, v));
  }
  return out;
}

/** Options for `NoiseSuppressorV18`. */
export interface NoiseSuppressorV18Options {
  /** Strength (default `moderate`). */
  level?: NoiseSuppressionV18Level;
  /** Wiener aggressiveness `k` (0..1, higher = more suppression, default per level). */
  suppressionStrength?: number;
  /** Lowest gain ever applied (0..1, default 0.15). */
  minGain?: number;
  /** Smoothing rate when the gain falls (attack, default 0.5). */
  attackRate?: number;
  /** Smoothing rate when the gain rises (release, default 0.1). */
  releaseRate?: number;
}

const LEVEL_STRENGTH: Record<NoiseSuppressionV18Level, number> = {
  off: 0,
  light: 0.35,
  moderate: 0.6,
  aggressive: 0.85,
};

export function defaultNoiseSuppressorV18Options(): Required<NoiseSuppressorV18Options> {
  return { level: 'moderate', suppressionStrength: LEVEL_STRENGTH.moderate, minGain: 0.15, attackRate: 0.5, releaseRate: 0.1 };
}

export function validateNoiseSuppressorV18Options(options: NoiseSuppressorV18Options): string[] {
  const errors: string[] = [];
  if (options.level !== undefined && !isNoiseSuppressionV18Level(options.level)) {
    errors.push(`unknown noise suppression level: ${options.level}`);
  }
  const check = (name: keyof NoiseSuppressorV18Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('suppressionStrength', options.suppressionStrength, 0, 1);
  check('minGain', options.minGain, 0, 1);
  check('attackRate', options.attackRate, 0.01, 1);
  check('releaseRate', options.releaseRate, 0.01, 1);
  return errors;
}

export interface NoiseSuppressorV18Stats {
  level: NoiseSuppressionV18Level;
  frames: number;
  /** Mean suppression applied, in dB (0 = nothing suppressed). */
  averageSuppressionDb: number;
  /** Frames suppressed by more than 6 dB. */
  heavilySuppressedFrames: number;
  /** Last gain applied (0..1). */
  lastGain: number;
  /** Whether the estimator profile looks stale. */
  profileStale: boolean;
}

/**
 * Wiener-style suppressor: per-band gain from the learned noise
 * floors, combined into one scalar gain per frame (a scalar keeps
 * the waveform shape and avoids musical-noise artefacts), smoothed
 * over time (fast attack, slow release).
 */
export class NoiseSuppressorV18 {
  private readonly options: Required<NoiseSuppressorV18Options>;
  private readonly estimator: NoiseEstimatorV18;
  private smoothedGain = 1;
  private frames = 0;
  private suppressionDbSum = 0;
  private heavilySuppressedFrames = 0;

  constructor(estimator: NoiseEstimatorV18, options: NoiseSuppressorV18Options = {}) {
    const errors = validateNoiseSuppressorV18Options(options);
    if (errors.length > 0) throw new Error(`invalid noise suppressor v18 options: ${errors.join('; ')}`);
    this.estimator = estimator;
    const merged = { ...defaultNoiseSuppressorV18Options(), ...options };
    if (options.suppressionStrength === undefined && options.level !== undefined) {
      merged.suppressionStrength = LEVEL_STRENGTH[options.level];
    }
    this.options = merged;
  }

  getLevel(): NoiseSuppressionV18Level {
    return this.options.level;
  }

  /** Suppress one frame; returns the cleaned frame. */
  suppress(frame: Int16Array, atMs: number): Int16Array {
    this.frames += 1;
    if (this.options.level === 'off') {
      this.suppressionDbSum += 0;
      return frame;
    }
    const bands = noiseBandRmsV18(frame);
    const k = this.options.suppressionStrength;
    const lowGain = Math.max(1 - (k * this.estimator.getLowFloor()) / Math.max(bands.low, 0.0001), this.options.minGain);
    const highGain = Math.max(1 - (k * this.estimator.getHighFloor()) / Math.max(bands.high, 0.0001), this.options.minGain);
    const targetGain = Math.min(1, Math.max(this.options.minGain, (lowGain + highGain) / 2));
    const rate = targetGain < this.smoothedGain ? this.options.attackRate : this.options.releaseRate;
    this.smoothedGain = this.smoothedGain * (1 - rate) + targetGain * rate;
    const suppressionDb = -linearToDbV18(Math.max(this.smoothedGain, 0.0001));
    this.suppressionDbSum += suppressionDb;
    if (suppressionDb > 6) this.heavilySuppressedFrames += 1;
    return attenuateFrameV18(frame, this.smoothedGain);
  }

  reset(): void {
    this.smoothedGain = 1;
    this.frames = 0;
    this.suppressionDbSum = 0;
    this.heavilySuppressedFrames = 0;
  }

  stats(atMs: number): NoiseSuppressorV18Stats {
    return {
      level: this.options.level,
      frames: this.frames,
      averageSuppressionDb: this.frames === 0 ? 0 : this.suppressionDbSum / this.frames,
      heavilySuppressedFrames: this.heavilySuppressedFrames,
      lastGain: this.smoothedGain,
      profileStale: this.estimator.isStale(atMs),
    };
  }
}

/** Options for the full `NoiseChainV18` (estimator + gate + suppressor). */
export interface NoiseChainV18Options {
  estimator?: NoiseEstimatorV18Options;
  gate?: NoiseGateV18Options;
  suppressor?: NoiseSuppressorV18Options;
}

export interface NoiseChainV18FrameResult {
  /** The cleaned frame (gate + suppression applied). */
  frame: Int16Array;
  /** RMS before cleaning. */
  inputRms: number;
  /** RMS after cleaning. */
  outputRms: number;
  /** Suppression applied to this frame, in dB. */
  suppressionDb: number;
  /** Whether the gate was open for this frame. */
  gateOpen: boolean;
  /** SNR of the input frame against the learned floors. */
  snrDb: number;
}

export interface NoiseChainV18Stats {
  estimator: NoiseEstimatorV18Stats;
  gate: NoiseGateV18Stats;
  suppressor: NoiseSuppressorV18Stats;
  frames: number;
  /** Mean input RMS across frames. */
  averageInputRms: number;
  /** Mean output RMS across frames. */
  averageOutputRms: number;
}

/**
 * The full front-of-VAD chain: estimator → gate → suppressor.
 * `process(frame, atMs, isSpeech)` learns from non-speech frames,
 * gates, suppresses, and returns the cleaned frame the VAD should
 * see. The caller decides `isSpeech` (from the previous VAD
 * verdict); when in doubt pass `false` — learning from a speech
 * frame only raises the floor a little, while *not* learning from
 * silence leaves the room unmodelled.
 */
export class NoiseChainV18 {
  readonly estimator: NoiseEstimatorV18;
  readonly gate: NoiseGateV18;
  readonly suppressor: NoiseSuppressorV18;
  private frames = 0;
  private inputRmsSum = 0;
  private outputRmsSum = 0;

  constructor(options: NoiseChainV18Options = {}) {
    this.estimator = new NoiseEstimatorV18(options.estimator);
    this.gate = new NoiseGateV18(this.estimator, options.gate);
    this.suppressor = new NoiseSuppressorV18(this.estimator, options.suppressor);
  }

  process(frame: Int16Array, atMs: number, isSpeech: boolean): NoiseChainV18FrameResult {
    if (!(frame instanceof Int16Array) || frame.length !== VAD_V18_FRAME_SAMPLES) {
      throw new Error('Noise chain v18 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    if (!isSpeech) this.estimator.learn(frame, atMs);
    const inputRms = pcm16RmsV18(frame);
    const gated = this.gate.apply(frame, atMs);
    const cleaned = this.suppressor.suppress(gated, atMs);
    const outputRms = pcm16RmsV18(cleaned);
    this.frames += 1;
    this.inputRmsSum += inputRms;
    this.outputRmsSum += outputRms;
    return {
      frame: cleaned,
      inputRms,
      outputRms,
      suppressionDb: -linearToDbV18(Math.max(outputRms / Math.max(inputRms, 0.0001), 0.0001)),
      gateOpen: this.gate.isOpen(),
      snrDb: this.estimator.snrDb(frame),
    };
  }

  reset(): void {
    this.estimator.reset();
    this.gate.reset();
    this.suppressor.reset();
    this.frames = 0;
    this.inputRmsSum = 0;
    this.outputRmsSum = 0;
  }

  stats(atMs: number): NoiseChainV18Stats {
    return {
      estimator: this.estimator.stats(atMs),
      gate: this.gate.stats(),
      suppressor: this.suppressor.stats(atMs),
      frames: this.frames,
      averageInputRms: this.frames === 0 ? 0 : this.inputRmsSum / this.frames,
      averageOutputRms: this.frames === 0 ? 0 : this.outputRmsSum / this.frames,
    };
  }

  summary(atMs: number): string {
    const s = this.stats(atMs);
    return (
      `Noise chain v18: ${s.frames} frames, input RMS ${s.averageInputRms.toFixed(4)} → ` +
      `output ${s.averageOutputRms.toFixed(4)}, suppression ${s.suppressor.averageSuppressionDb.toFixed(1)} dB, ` +
      `gate closed ${s.gate.gatedFrames} frames, noise floor ${s.estimator.lowFloor.toFixed(4)}` +
      `${s.estimator.stale ? ' (stale)' : ''}`
    );
  }

  markdown(atMs: number): string {
    const s = this.stats(atMs);
    return [
      '# Noise chain v18',
      '',
      `- Frames: ${s.frames}`,
      `- Input RMS: ${s.averageInputRms.toFixed(4)} → output RMS: ${s.averageOutputRms.toFixed(4)}`,
      `- Average suppression: ${s.suppressor.averageSuppressionDb.toFixed(1)} dB (heavily suppressed frames: ${s.suppressor.heavilySuppressedFrames})`,
      `- Gate: ${s.gate.opens} opens / ${s.gate.closes} closes, gated ${s.gate.gatedFrames} frames (${(s.gate.gatedRate * 100).toFixed(1)}%)`,
      `- Noise floor: low ${s.estimator.lowFloor.toFixed(4)}, high ${s.estimator.highFloor.toFixed(4)} (${s.estimator.noiseLevelDb.toFixed(1)} dB, learned from ${s.estimator.learnedFrames} frames${s.estimator.stale ? ', STALE' : ''})`,
      '',
    ].join('\n');
  }
}

export function createNoiseChainV18(options: NoiseChainV18Options = {}): NoiseChainV18 {
  return new NoiseChainV18(options);
}

export function noiseChainV18Summary(chain: NoiseChainV18, atMs: number): string {
  return chain.summary(atMs);
}

export function noiseChainV18Markdown(chain: NoiseChainV18, atMs: number): string {
  return chain.markdown(atMs);
}
