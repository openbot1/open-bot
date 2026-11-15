/**
 * Adaptive voice activity detection (v1.06, Đội T4 — voice realtime v5).
 *
 * The v0.95 `LocalVad` is a fixed RMS threshold + hangover: it works
 * in a quiet room and chops sentences in a noisy one. This VAD
 * builds on the same PCM16 helpers (`pcm16Rms`, `isValidPcm16Frame`)
 * and adds what a real call needs:
 *
 *   - Adaptive threshold: a noise floor is tracked (exponential
 *     moving average of RMS while no speech is detected) and the
 *     speech threshold follows it — `max(baseThreshold,
 *     noiseFloor * multiplier)` — so a fan, street noise or a loud
 *     room does not read as constant speech, and a quiet room does
 *     not need the user to shout. The floor adapts slowly
 *     (`noiseLearnMs`) and only while silent, so speech never
 *     drags the floor up.
 *   - Hysteresis: speech starts above `startThreshold` and only
 *     ends below a lower `endThreshold`, so energy wobbling around
 *     one line does not flutter the state.
 *   - Anti-interruption: a turn only ends after `hangoverMs` of
 *     continuous quiet, brief dips shorter than `maxGapMs` inside
 *     a turn are forgiven, and a turn shorter than `minTurnMs`
 *     never ends early (the speaker is still going).
 *   - Backchannel suppression: bursts shorter than
 *     `backchannelMaxMs` ("ừ", "yeah", a cough) are reported as
 *     `backchannel` events, not turns — the loop can duck the TTS
 *     for them instead of treating them as an interruption.
 *
 * Timing is derived from the samples fed (sample rate), never from
 * the wall clock, so tests are deterministic: feed 20 ms windows
 * of sine / silence and the events land on exact millisecond
 * boundaries. No model, no native dependency, no microphone.
 */

import { isValidPcm16Frame, pcm16Rms } from './audio';
import { REALTIME_MIC_SAMPLE_RATE_HZ } from './types';

/** Default adaptive-VAD base threshold (RMS 0..1). */
export const VAD_V5_DEFAULT_THRESHOLD = 0.02;
/** Default hangover before a turn ends (ms). */
export const VAD_V5_DEFAULT_HANGOVER_MS = 350;
/** Default window analysed per step (ms). */
export const VAD_V5_DEFAULT_WINDOW_MS = 20;
/** Default noise-floor learning time constant (ms). */
export const VAD_V5_DEFAULT_NOISE_LEARN_MS = 2000;
/** Default multiplier: threshold = noiseFloor * this (when adaptive). */
export const VAD_V5_DEFAULT_THRESHOLD_MULTIPLIER = 4;
/** Default minimum turn length (ms) — shorter bursts are backchannels. */
export const VAD_V5_DEFAULT_MIN_TURN_MS = 200;
/** Default backchannel ceiling (ms). */
export const VAD_V5_DEFAULT_BACKCHANNEL_MAX_MS = 250;
/** Default max quiet gap forgiven inside a turn (ms). */
export const VAD_V5_DEFAULT_MAX_GAP_MS = 400;
/** Absolute threshold ceiling — the adaptive threshold never exceeds this. */
export const VAD_V5_MAX_THRESHOLD = 0.25;
/** Absolute threshold floor — the adaptive threshold never goes below this. */
export const VAD_V5_MIN_THRESHOLD = 0.005;

/** VAD state. */
export type VadV5State = 'idle' | 'maybe-speech' | 'speaking' | 'ending';

/** One VAD event emitted through the sink. */
export interface VadV5Event {
  kind: 'speech-start' | 'speech-end' | 'backchannel';
  /** ms since the VAD started (sample-derived clock). */
  atMs: number;
  /** Turn start (speech-start / speech-end / backchannel). */
  startedAtMs: number;
  /** Turn end (speech-end / backchannel only). */
  endedAtMs?: number;
  /** Turn / burst duration (ms). */
  durationMs?: number;
  /** Peak RMS inside the turn / burst. */
  peakRms: number;
  /** Frames analysed inside the turn / burst. */
  frames: number;
}

/** Sink receiving VAD events. */
export type VadV5EventSink = (event: VadV5Event) => void;

/** Live statistics for the UI / diagnostics. */
export interface VadV5Stats {
  state: VadV5State;
  /** Current adaptive threshold (RMS). */
  threshold: number;
  /** Tracked noise floor (RMS). */
  noiseFloor: number;
  /** RMS of the most recent window. */
  level: number;
  turns: number;
  backchannels: number;
  totalSpeechMs: number;
  /** ms of speech in the current turn (0 when idle). */
  currentTurnMs: number;
  /** ms of quiet in the current turn (0 when idle). */
  currentGapMs: number;
}

/** Options for `AdaptiveVad`. */
export interface AdaptiveVadOptions {
  sampleRateHz?: number;
  /** Analysis window (ms). Default 20. */
  windowMs?: number;
  /** Base threshold (RMS). Default 0.02. */
  baseThreshold?: number;
  /** Follow the noise floor. Default true. */
  adaptive?: boolean;
  /** Noise-floor learning time constant (ms). Default 2000. */
  noiseLearnMs?: number;
  /** Threshold = noiseFloor * this. Default 4. */
  thresholdMultiplier?: number;
  /** Quiet time before a turn ends (ms). Default 350. */
  hangoverMs?: number;
  /** Max quiet gap forgiven inside a turn (ms). Default 400. */
  maxGapMs?: number;
  /** Minimum turn length (ms). Default 200. */
  minTurnMs?: number;
  /** Bursts shorter than this are backchannels (ms). Default 250. */
  backchannelMaxMs?: number;
  sink?: VadV5EventSink;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Adaptive energy VAD. Feed PCM16 frames of any length; windows are
 * analysed in order and events fire through `sink`. `nowMs` is a
 * sample-derived clock (ms since the first frame).
 */
export class AdaptiveVad {
  private readonly sampleRateHz: number;
  private readonly windowSamples: number;
  private readonly windowMs: number;
  private baseThreshold: number;
  private adaptive: boolean;
  private noiseAlpha: number;
  private thresholdMultiplier: number;
  private hangoverMs: number;
  private maxGapMs: number;
  private minTurnMs: number;
  private backchannelMaxMs: number;
  private readonly sink?: VadV5EventSink;

  private state: VadV5State = 'idle';
  private noiseFloor = 0.001;
  private leftover = new Uint8Array(0);
  private lastLevel = 0;
  private clockMs = 0;
  private turnStartMs = 0;
  private turnPeakRms = 0;
  private turnFrames = 0;
  private turnSpeechMs = 0;
  private gapMs = 0;
  private quietMs = 0;
  private turns = 0;
  private backchannels = 0;
  private totalSpeechMs = 0;
  private maybeStartMs = 0;
  private maybePeakRms = 0;
  private maybeFrames = 0;

  constructor(options: AdaptiveVadOptions = {}) {
    this.sampleRateHz = options.sampleRateHz ?? REALTIME_MIC_SAMPLE_RATE_HZ;
    const windowMs = options.windowMs ?? VAD_V5_DEFAULT_WINDOW_MS;
    this.windowMs = windowMs;
    this.windowSamples = Math.max(1, Math.round((this.sampleRateHz * windowMs) / 1000));
    this.baseThreshold = options.baseThreshold ?? VAD_V5_DEFAULT_THRESHOLD;
    this.adaptive = options.adaptive ?? true;
    const learnMs = options.noiseLearnMs ?? VAD_V5_DEFAULT_NOISE_LEARN_MS;
    this.noiseAlpha = clamp(windowMs / Math.max(windowMs, learnMs), 0.001, 1);
    this.thresholdMultiplier = options.thresholdMultiplier ?? VAD_V5_DEFAULT_THRESHOLD_MULTIPLIER;
    this.hangoverMs = options.hangoverMs ?? VAD_V5_DEFAULT_HANGOVER_MS;
    this.maxGapMs = options.maxGapMs ?? VAD_V5_DEFAULT_MAX_GAP_MS;
    this.minTurnMs = options.minTurnMs ?? VAD_V5_DEFAULT_MIN_TURN_MS;
    this.backchannelMaxMs = options.backchannelMaxMs ?? VAD_V5_DEFAULT_BACKCHANNEL_MAX_MS;
    this.sink = options.sink;
  }

  /** Effective options (current values after any live update). */
  getOptions(): AdaptiveVadOptions {
    return {
      sampleRateHz: this.sampleRateHz,
      windowMs: this.windowMs,
      baseThreshold: this.baseThreshold,
      adaptive: this.adaptive,
      thresholdMultiplier: this.thresholdMultiplier,
      hangoverMs: this.hangoverMs,
      maxGapMs: this.maxGapMs,
      minTurnMs: this.minTurnMs,
      backchannelMaxMs: this.backchannelMaxMs,
    };
  }

  /** Current state. */
  getState(): VadV5State {
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
      VAD_V5_MIN_THRESHOLD,
      VAD_V5_MAX_THRESHOLD,
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

  /** Sample-derived clock (ms since start). */
  get nowMs(): number {
    return this.clockMs;
  }

  getStats(): VadV5Stats {
    return {
      state: this.state,
      threshold: this.getThreshold(),
      noiseFloor: this.noiseFloor,
      level: this.lastLevel,
      turns: this.turns,
      backchannels: this.backchannels,
      totalSpeechMs: this.totalSpeechMs,
      currentTurnMs: this.state === 'speaking' || this.state === 'ending' ? this.turnSpeechMs : 0,
      currentGapMs: this.state === 'speaking' || this.state === 'ending' ? this.gapMs : 0,
    };
  }

  /**
   * Reconfigure live (a new threshold / hangover / backchannel
   * ceiling applies from the next window; the noise floor and the
   * current turn are kept). Throws on an invalid patch. Returns
   * the effective config.
   */
  updateOptions(patch: Omit<AdaptiveVadOptions, 'sampleRateHz' | 'sink' | 'windowMs'>): AdaptiveVadOptions {
    const errors = validateVadV5Options(patch);
    if (errors.length > 0) {
      throw new Error(`Invalid VAD options: ${errors.join(' ')}`);
    }
    if (patch.baseThreshold !== undefined) this.baseThreshold = patch.baseThreshold;
    if (patch.adaptive !== undefined) this.adaptive = patch.adaptive;
    if (patch.thresholdMultiplier !== undefined) this.thresholdMultiplier = patch.thresholdMultiplier;
    if (patch.hangoverMs !== undefined) this.hangoverMs = patch.hangoverMs;
    if (patch.maxGapMs !== undefined) this.maxGapMs = patch.maxGapMs;
    if (patch.minTurnMs !== undefined) this.minTurnMs = patch.minTurnMs;
    if (patch.backchannelMaxMs !== undefined) this.backchannelMaxMs = patch.backchannelMaxMs;
    if (patch.noiseLearnMs !== undefined) {
      this.noiseAlpha = clamp(this.windowMs / Math.max(this.windowMs, patch.noiseLearnMs), 0.001, 1);
    }
    return {
      windowMs: this.windowMs,
      baseThreshold: this.baseThreshold,
      adaptive: this.adaptive,
      thresholdMultiplier: this.thresholdMultiplier,
      hangoverMs: this.hangoverMs,
      maxGapMs: this.maxGapMs,
      minTurnMs: this.minTurnMs,
      backchannelMaxMs: this.backchannelMaxMs,
    };
  }

  /** Feed PCM16 audio (any length). Throws on invalid frames. */
  feed(frame: Uint8Array): void {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('AdaptiveVad: frame must be a non-empty even-length PCM16 buffer.');
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
  flush(): VadV5Event | null {
    if (this.state === 'speaking' || this.state === 'ending') {
      return this.commitTurn(this.clockMs, true);
    }
    if (this.state === 'maybe-speech') {
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
    this.turnStartMs = 0;
    this.turnPeakRms = 0;
    this.turnFrames = 0;
    this.turnSpeechMs = 0;
    this.gapMs = 0;
    this.quietMs = 0;
    this.turns = 0;
    this.backchannels = 0;
    this.totalSpeechMs = 0;
    this.maybeStartMs = 0;
    this.maybePeakRms = 0;
    this.maybeFrames = 0;
  }

  private emit(event: VadV5Event): void {
    this.sink?.(event);
  }

  private analyseWindow(window: Uint8Array): void {
    const rms = pcm16Rms(window);
    this.lastLevel = rms;
    this.clockMs += this.windowMs;
    const startThreshold = this.getThreshold();
    // End threshold is lower (hysteresis): speech wobbling around
    // the start line does not flutter the state.
    const endThreshold = startThreshold * 0.6;
    const isLoud = rms >= startThreshold;
    const isQuiet = rms < endThreshold;

    // Noise floor only learns while nothing is happening.
    if (this.state === 'idle' && !isLoud) {
      this.noiseFloor += (rms - this.noiseFloor) * this.noiseAlpha;
      if (this.noiseFloor < 0.0001) this.noiseFloor = 0.0001;
    }

    switch (this.state) {
      case 'idle': {
        if (isLoud) {
          this.state = 'maybe-speech';
          this.maybeStartMs = this.clockMs - this.windowMs;
          this.maybePeakRms = rms;
          this.maybeFrames = 1;
        }
        break;
      }
      case 'maybe-speech': {
        if (isLoud) {
          this.maybePeakRms = Math.max(this.maybePeakRms, rms);
          this.maybeFrames += 1;
          const elapsed = this.clockMs - this.maybeStartMs;
          if (elapsed >= this.minTurnMs) {
            this.state = 'speaking';
            this.turnStartMs = this.maybeStartMs;
            this.turnPeakRms = this.maybePeakRms;
            this.turnFrames = this.maybeFrames;
            this.turnSpeechMs = elapsed;
            this.gapMs = 0;
            this.quietMs = 0;
            this.emit({
              kind: 'speech-start',
              atMs: this.clockMs,
              startedAtMs: this.turnStartMs,
              peakRms: this.turnPeakRms,
              frames: this.turnFrames,
            });
          }
        } else if (isQuiet) {
          // Burst ended before minTurnMs — a backchannel, not a turn.
          const durationMs = this.clockMs - this.maybeStartMs;
          if (durationMs <= this.backchannelMaxMs && this.maybeFrames > 0) {
            this.backchannels += 1;
            this.emit({
              kind: 'backchannel',
              atMs: this.clockMs,
              startedAtMs: this.maybeStartMs,
              endedAtMs: this.clockMs,
              durationMs,
              peakRms: this.maybePeakRms,
              frames: this.maybeFrames,
            });
          }
          this.state = 'idle';
          this.maybeFrames = 0;
        }
        // Mid-level energy: stay in maybe-speech, neither confirm
        // nor reject yet.
        break;
      }
      case 'speaking': {
        if (isLoud) {
          this.turnPeakRms = Math.max(this.turnPeakRms, rms);
          this.turnFrames += 1;
          this.turnSpeechMs += this.windowMs;
          this.gapMs = 0;
          this.quietMs = 0;
        } else if (isQuiet) {
          this.gapMs += this.windowMs;
          this.quietMs += this.windowMs;
          if (this.gapMs <= this.maxGapMs) {
            // Brief dip inside a sentence — forgiven, turn continues.
            this.turnFrames += 1;
          } else if (this.quietMs >= this.hangoverMs) {
            this.commitTurn(this.clockMs, false);
          } else {
            this.state = 'ending';
            this.turnFrames += 1;
          }
        } else {
          // Between the two thresholds: hold the turn, count it as
          // neither speech nor quiet (no gap accrual).
          this.turnFrames += 1;
          this.quietMs = 0;
        }
        break;
      }
      case 'ending': {
        if (isLoud) {
          // Speaker resumed before hangover elapsed — turn continues.
          this.state = 'speaking';
          this.turnPeakRms = Math.max(this.turnPeakRms, rms);
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

  private commitTurn(atMs: number, forced: boolean): VadV5Event {
    const endedAtMs = atMs;
    const durationMs = Math.max(0, endedAtMs - this.turnStartMs);
    const event: VadV5Event = {
      kind: 'speech-end',
      atMs,
      startedAtMs: this.turnStartMs,
      endedAtMs,
      durationMs,
      peakRms: this.turnPeakRms,
      frames: this.turnFrames,
    };
    // A forced flush of a sub-minimum turn is still a turn (the
    // caller asked for it); a natural end below minTurnMs cannot
    // happen — maybe-speech already filtered those.
    void forced;
    this.turns += 1;
    this.totalSpeechMs += durationMs;
    this.state = 'idle';
    this.turnSpeechMs = 0;
    this.gapMs = 0;
    this.quietMs = 0;
    this.turnFrames = 0;
    this.turnPeakRms = 0;
    this.emit(event);
    return event;
  }
}

/** Validate a VAD options patch; returns error strings (empty = ok). */
export function validateVadV5Options(patch: Partial<AdaptiveVadOptions>): string[] {
  const errors: string[] = [];
  const num = (name: string, value: number | undefined, min: number, max: number): void => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push(`${name} must be a finite number ${min}..${max}.`);
    }
  };
  num('baseThreshold', patch.baseThreshold, VAD_V5_MIN_THRESHOLD, VAD_V5_MAX_THRESHOLD);
  num('thresholdMultiplier', patch.thresholdMultiplier, 1, 20);
  num('hangoverMs', patch.hangoverMs, 50, 5000);
  num('maxGapMs', patch.maxGapMs, 0, 2000);
  num('minTurnMs', patch.minTurnMs, 0, 2000);
  num('backchannelMaxMs', patch.backchannelMaxMs, 0, 2000);
  num('noiseLearnMs', patch.noiseLearnMs, 100, 30000);
  num('windowMs', patch.windowMs, 10, 100);
  if (patch.sampleRateHz !== undefined && (!Number.isInteger(patch.sampleRateHz) || patch.sampleRateHz <= 0)) {
    errors.push('sampleRateHz must be a positive integer.');
  }
  if (patch.minTurnMs !== undefined && patch.backchannelMaxMs !== undefined && patch.minTurnMs > patch.backchannelMaxMs) {
    errors.push('minTurnMs must not exceed backchannelMaxMs (a burst cannot be both a turn and a backchannel).');
  }
  return errors;
}

/** Default VAD options (one object, for the session + tools). */
export function defaultVadV5Options(): Required<
  Omit<AdaptiveVadOptions, 'sink' | 'sampleRateHz'>
> & { sampleRateHz: number } {
  return {
    sampleRateHz: REALTIME_MIC_SAMPLE_RATE_HZ,
    windowMs: VAD_V5_DEFAULT_WINDOW_MS,
    baseThreshold: VAD_V5_DEFAULT_THRESHOLD,
    adaptive: true,
    noiseLearnMs: VAD_V5_DEFAULT_NOISE_LEARN_MS,
    thresholdMultiplier: VAD_V5_DEFAULT_THRESHOLD_MULTIPLIER,
    hangoverMs: VAD_V5_DEFAULT_HANGOVER_MS,
    maxGapMs: VAD_V5_DEFAULT_MAX_GAP_MS,
    minTurnMs: VAD_V5_DEFAULT_MIN_TURN_MS,
    backchannelMaxMs: VAD_V5_DEFAULT_BACKCHANNEL_MAX_MS,
  };
}
