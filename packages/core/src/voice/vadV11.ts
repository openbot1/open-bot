/**
 * Voice activity detection v11 (v1.12, Đội T5 — voice realtime v11).
 *
 * v10 was a two-band energy gate: a frame was speech or silence,
 * decided on the spot. That is right for a quiet room but it has
 * three sharp edges in a real call: a frame just above the gate
 * flickers on and off at a sentence boundary (no hysteresis), the
 * floors are learned only from silence frames so the first seconds
 * of a call are guessed (no calibration), and a short pause inside
 * one sentence splits it into two turns (no pause merging).
 *
 * v11 keeps v10's two bands (raw RMS = low, first-difference RMS
 * = high) and the hum/hiss flatness proxy, but decides through a
 * speech *probability* (0..1) instead of a hard gate:
 *
 * - Probability: three fitted components — low-band energy above
 *   the adaptive floor, high-band energy above its floor, and the
 *   flatness fit (zero-crossing rate inside the speech range and
 *   high/low ratio inside the speech range). A loud hum scores on
 *   energy but ~0 on flatness; broadband hiss scores on energy
 *   but ~0 on ZCR/ratio fit. Weights: energy 0.45, ZCR fit 0.25,
 *   ratio fit 0.30.
 * - Hysteresis: speech starts when the smoothed probability stays
 *   at/above `startThreshold` (default 0.6) for `minSpeechMs`, and
 *   ends only when it stays at/below `stopThreshold` (default 0.35)
 *   for `hangoverMs`. Between the two thresholds the detector
 *   holds its previous verdict, so boundary frames do not flicker.
 * - Calibration: the first `calibrationFrames` (default 25 = 500 ms)
 *   are treated as room noise and set both floors (mean + 2σ of
 *   the frame RMS), so the detector is tuned to the actual room
 *   before the first turn. Feeding speech during calibration is a
 *   caller error only in the sense that the floors come out high —
 *   the detector still works, just less sensitively — and the
 *   calibration event reports the floors so the panel can show
 *   "calibrated to this room".
 * - Pause merging: after speech ends, a silence gap shorter than
 *   `mergePauseMs` (default 250 ms) that is followed by speech
 *   again re-opens the *same* turn (`turn-merged` event) instead
 *   of closing one turn and opening another — "xin chào … bạn"
 *   stays one turn.
 * - Max turn: a turn longer than `maxTurnMs` (default 60 s) is
 *   force-ended (`max-turn` event) so a stuck-open detector cannot
 *   hold the floor forever; the caller can raise it for dictation.
 * - Echo: frames flagged `echo: true` (agent playback leaking
 *   into the mic) never start a turn and never extend one; they
 *   count as double-talk when they arrive mid-turn.
 *
 * Frames are PCM16 mono at 16 kHz, 20 ms (320 samples) each.
 * Nothing here touches a sound card, a network socket or a key —
 * mock audio comes from `audioMockV11.ts`.
 */

import { isValidPcm16Frame } from './audio';

/** VAD v11 preset names. */
export type VadV11PresetName = 'quiet' | 'office' | 'noisy' | 'street';

/** Options for `VadV11`. */
export interface VadV11Options {
  /** Preset: quiet room, office, noisy cafe, or street. */
  preset?: VadV11PresetName;
  /** Smoothed probability at/above which speech may start (0..1). */
  startThreshold?: number;
  /** Smoothed probability at/below which speech may end (0..1). */
  stopThreshold?: number;
  /** EMA rate for the smoothed probability (0..1, higher = faster). */
  smoothingAlpha?: number;
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
  /** Silence gap shorter than this re-opens the same turn (ms). */
  mergePauseMs?: number;
  /** Longest a turn may run before it is force-ended (ms). */
  maxTurnMs?: number;
  /** Frames treated as room noise at startup for calibration. */
  calibrationFrames?: number;
  /** Starting low-band noise floor (RMS 0..1) before calibration/adaptation. */
  initialLowFloor?: number;
  /** Starting high-band noise floor (RMS 0..1) before calibration/adaptation. */
  initialHighFloor?: number;
  /** EMA rate for the noise floors (0..1, higher = faster). */
  floorAdaptRate?: number;
  /** ZCR (crossings per frame) below which frames look like hum. */
  minZeroCrossings?: number;
  /** ZCR above which frames look like hiss. */
  maxZeroCrossings?: number;
  /** High/low energy ratio below which a frame looks like hum. */
  minHighLowRatio?: number;
  /** High/low energy ratio above which a frame looks like hiss. */
  maxHighLowRatio?: number;
}

/** Resolved preset values. */
export interface VadV11Preset {
  startThreshold: number;
  stopThreshold: number;
  minSpeechMs: number;
  hangoverMs: number;
  minTurnMs: number;
  mergePauseMs: number;
  maxTurnMs: number;
  initialLowFloor: number;
  initialHighFloor: number;
}

export const VAD_V11_PRESETS: Record<VadV11PresetName, VadV11Preset> = {
  quiet: { startThreshold: 0.55, stopThreshold: 0.3, minSpeechMs: 100, hangoverMs: 350, minTurnMs: 300, mergePauseMs: 300, maxTurnMs: 60000, initialLowFloor: 0.008, initialHighFloor: 0.004 },
  office: { startThreshold: 0.6, stopThreshold: 0.35, minSpeechMs: 120, hangoverMs: 400, minTurnMs: 300, mergePauseMs: 250, maxTurnMs: 60000, initialLowFloor: 0.015, initialHighFloor: 0.007 },
  noisy: { startThreshold: 0.65, stopThreshold: 0.4, minSpeechMs: 160, hangoverMs: 500, minTurnMs: 400, mergePauseMs: 200, maxTurnMs: 60000, initialLowFloor: 0.03, initialHighFloor: 0.014 },
  street: { startThreshold: 0.7, stopThreshold: 0.45, minSpeechMs: 200, hangoverMs: 600, minTurnMs: 400, mergePauseMs: 150, maxTurnMs: 60000, initialLowFloor: 0.05, initialHighFloor: 0.022 },
};

export const VAD_V11_PRESET_NAMES = ['quiet', 'office', 'noisy', 'street'] as const;

export function isVadV11PresetName(value: unknown): value is VadV11PresetName {
  return typeof value === 'string' && (VAD_V11_PRESET_NAMES as readonly string[]).includes(value);
}

export function defaultVadV11Options(): Required<VadV11Options> {
  const p = VAD_V11_PRESETS.office;
  return {
    preset: 'office',
    startThreshold: p.startThreshold,
    stopThreshold: p.stopThreshold,
    smoothingAlpha: 0.35,
    minSpeechMs: p.minSpeechMs,
    hangoverMs: p.hangoverMs,
    minTurnMs: p.minTurnMs,
    minBackchannelMs: 80,
    maxBackchannelMs: 600,
    mergePauseMs: p.mergePauseMs,
    maxTurnMs: p.maxTurnMs,
    calibrationFrames: 25,
    initialLowFloor: p.initialLowFloor,
    initialHighFloor: p.initialHighFloor,
    floorAdaptRate: 0.05,
    minZeroCrossings: 4,
    maxZeroCrossings: 160,
    minHighLowRatio: 0.08,
    maxHighLowRatio: 1.6,
  };
}

export function validateVadV11Options(options: VadV11Options): Required<VadV11Options> {
  const base = defaultVadV11Options();
  const preset = options.preset ?? base.preset;
  if (!isVadV11PresetName(preset)) throw new Error(`VAD v11 preset must be one of ${VAD_V11_PRESET_NAMES.join(', ')}.`);
  const p = VAD_V11_PRESETS[preset];
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`VAD v11 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  const startThreshold = num(options.startThreshold, p.startThreshold, 'startThreshold', 0.05, 0.99);
  const stopThreshold = num(options.stopThreshold, p.stopThreshold, 'stopThreshold', 0.01, 0.95);
  if (stopThreshold >= startThreshold) {
    throw new Error(`VAD v11 stopThreshold (${stopThreshold}) must be below startThreshold (${startThreshold}) — hysteresis needs a gap.`);
  }
  return {
    preset,
    startThreshold,
    stopThreshold,
    smoothingAlpha: num(options.smoothingAlpha, base.smoothingAlpha, 'smoothingAlpha', 0.01, 1),
    minSpeechMs: num(options.minSpeechMs, p.minSpeechMs, 'minSpeechMs', 20, 2000),
    hangoverMs: num(options.hangoverMs, p.hangoverMs, 'hangoverMs', 0, 5000),
    minTurnMs: num(options.minTurnMs, p.minTurnMs, 'minTurnMs', 20, 5000),
    minBackchannelMs: num(options.minBackchannelMs, base.minBackchannelMs, 'minBackchannelMs', 20, 5000),
    maxBackchannelMs: num(options.maxBackchannelMs, base.maxBackchannelMs, 'maxBackchannelMs', 20, 5000),
    mergePauseMs: num(options.mergePauseMs, p.mergePauseMs, 'mergePauseMs', 0, 5000),
    maxTurnMs: num(options.maxTurnMs, p.maxTurnMs, 'maxTurnMs', 1000, 600000),
    calibrationFrames: Math.floor(num(options.calibrationFrames, base.calibrationFrames, 'calibrationFrames', 0, 500)),
    initialLowFloor: num(options.initialLowFloor, p.initialLowFloor, 'initialLowFloor', 0.0001, 0.5),
    initialHighFloor: num(options.initialHighFloor, p.initialHighFloor, 'initialHighFloor', 0.0001, 0.5),
    floorAdaptRate: num(options.floorAdaptRate, base.floorAdaptRate, 'floorAdaptRate', 0, 1),
    minZeroCrossings: num(options.minZeroCrossings, base.minZeroCrossings, 'minZeroCrossings', 0, 320),
    maxZeroCrossings: num(options.maxZeroCrossings, base.maxZeroCrossings, 'maxZeroCrossings', 0, 320),
    minHighLowRatio: num(options.minHighLowRatio, base.minHighLowRatio, 'minHighLowRatio', 0.001, 1),
    maxHighLowRatio: num(options.maxHighLowRatio, base.maxHighLowRatio, 'maxHighLowRatio', 1, 100),
  };
}

/** Band energies + flatness of one frame. */
export interface VadV11FrameFeatures {
  lowRms: number;
  highRms: number;
  zcr: number;
  highLowRatio: number;
  /** Raw speech probability of this frame (0..1), before smoothing. */
  probability: number;
  /** Smoothed probability (EMA) the start/stop decisions use. */
  smoothedProbability: number;
}

/** Events emitted by `VadV11`. */
export type VadV11Event =
  | { kind: 'calibration-done'; atMs: number; frames: number; lowFloor: number; highFloor: number }
  | { kind: 'speech-start'; atMs: number; confidence: number; lowRms: number; highRms: number }
  | { kind: 'speech-end'; atMs: number; durationMs: number; mergedPauses: number }
  | { kind: 'turn-merged'; atMs: number; pauseMs: number; durationMs: number }
  | { kind: 'backchannel'; atMs: number; durationMs: number }
  | { kind: 'false-start'; atMs: number; durationMs: number }
  | { kind: 'max-turn'; atMs: number; durationMs: number }
  | { kind: 'double-talk'; atMs: number; durationMs: number }
  | { kind: 'noise-floor-shift'; atMs: number; band: 'low' | 'high'; from: number; to: number };

export type VadV11EventSink = (event: VadV11Event) => void;

/** Counters for one VAD instance. */
export interface VadV11Stats {
  frames: number;
  speechFrames: number;
  silenceFrames: number;
  speechMs: number;
  turns: number;
  backchannels: number;
  falseStarts: number;
  mergedPauses: number;
  maxTurns: number;
  doubleTalkFrames: number;
  humRejections: number;
  hissRejections: number;
  echoRejections: number;
  floorAdaptations: number;
  floorShifts: number;
  calibrated: boolean;
  lowFloor: number;
  highFloor: number;
  probability: number;
  speaking: boolean;
}

/** Frame duration the v11 VAD assumes (ms). */
export const VAD_V11_FRAME_MS = 20;
/** Samples per 20 ms frame at 16 kHz. */
export const VAD_V11_FRAME_SAMPLES = 320;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** ZCR fit: 1 inside the speech range, ramping to 0 outside it. */
export function vadV11ZcrFit(zcr: number, minZcr: number, maxZcr: number): number {
  if (zcr < minZcr) return clamp01(zcr / Math.max(1, minZcr));
  if (zcr <= maxZcr) return 1;
  // Above the speech range the fit falls linearly to 0 at 1.5x max.
  return clamp01(1 - (zcr - maxZcr) / Math.max(1, maxZcr * 0.5));
}

/** High/low ratio fit: 1 inside the speech range, 0 far outside. */
export function vadV11RatioFit(ratio: number, minRatio: number, maxRatio: number): number {
  if (ratio < minRatio) return clamp01(ratio / Math.max(0.001, minRatio));
  if (ratio <= maxRatio) return 1;
  return clamp01(1 - (ratio - maxRatio) / Math.max(0.5, maxRatio));
}

function frameFeatures(
  frame: Uint8Array,
  lowFloor: number,
  highFloor: number,
  o: Required<VadV11Options>,
): { lowRms: number; highRms: number; zcr: number; highLowRatio: number; probability: number } {
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
  const highRms = Math.sqrt(highSum / n) * 2;
  const highLowRatio = lowRms > 0 ? highRms / lowRms : 0;
  // Energy fit per band: 0 at the floor, 1 at 6x the floor (log scale
  // so a loud room does not saturate the score instantly).
  const lowFit = clamp01(Math.log10(Math.max(1, lowRms / Math.max(0.0001, lowFloor))) / Math.log10(6));
  const highFit = clamp01(Math.log10(Math.max(1, highRms / Math.max(0.0001, highFloor))) / Math.log10(6));
  const energyFit = (lowFit + highFit) / 2;
  const zcrFit = vadV11ZcrFit(crossings, o.minZeroCrossings, o.maxZeroCrossings);
  const ratioFit = vadV11RatioFit(highLowRatio, o.minHighLowRatio, o.maxHighLowRatio);
  const probability = clamp01(0.45 * energyFit + 0.25 * zcrFit + 0.3 * ratioFit);
  return { lowRms, highRms, zcr: crossings, highLowRatio, probability };
}

export function vadV11FrameFeatures(frame: Uint8Array, options: VadV11Options = {}): VadV11FrameFeatures {
  if (!isValidPcm16Frame(frame) || frame.length !== VAD_V11_FRAME_SAMPLES * 2) {
    throw new Error('VAD v11 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
  }
  const o = validateVadV11Options(options);
  const f = frameFeatures(frame, o.initialLowFloor, o.initialHighFloor, o);
  return { ...f, smoothedProbability: f.probability };
}

/**
 * Probability VAD with hysteresis, startup calibration, pause
 * merging and a max-turn guard. Feed 20 ms PCM16 frames with
 * `feed()`; subscribe with `onEvent`.
 */
export class VadV11 {
  private options: Required<VadV11Options>;
  private readonly sink: VadV11EventSink | null;
  private lowFloor: number;
  private highFloor: number;
  private speaking = false;
  private calibrated = false;
  private calibrationLow: number[] = [];
  private calibrationHigh: number[] = [];
  private smoothedProbability = 0;
  private speechCandidateMs = 0;
  private silenceMs = 0;
  private speechStartedAtMs = 0;
  private speechMs = 0;
  private mergedPauses = 0;
  private pendingEndAtMs: number | null = null;
  private pendingEndDurationMs = 0;
  private pendingEndKind: 'speech-end' | 'backchannel' | 'false-start' | null = null;
  private pendingEndMergedPauses = 0;
  private nowMs = 0;
  private framesSinceShift = 0;
  private stats: VadV11Stats;

  constructor(options: VadV11Options = {}, sink: VadV11EventSink | null = null) {
    this.options = validateVadV11Options(options);
    this.sink = sink;
    this.lowFloor = this.options.initialLowFloor;
    this.highFloor = this.options.initialHighFloor;
    // Zero calibration frames means "already calibrated".
    this.calibrated = this.options.calibrationFrames === 0;
    this.stats = this.freshStats();
  }

  private freshStats(): VadV11Stats {
    return {
      frames: 0, speechFrames: 0, silenceFrames: 0, speechMs: 0,
      turns: 0, backchannels: 0, falseStarts: 0, mergedPauses: 0, maxTurns: 0,
      doubleTalkFrames: 0, humRejections: 0, hissRejections: 0, echoRejections: 0,
      floorAdaptations: 0, floorShifts: 0,
      calibrated: this.calibrated, lowFloor: this.lowFloor, highFloor: this.highFloor,
      probability: 0, speaking: false,
    };
  }

  getOptions(): Required<VadV11Options> {
    return { ...this.options };
  }

  /** Virtual time of the VAD's own clock (ms, advances 20 ms per fed frame). */
  getNowMs(): number {
    return this.nowMs;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  isCalibrated(): boolean {
    return this.calibrated;
  }

  getProbability(): number {
    return this.smoothedProbability;
  }

  getLowFloor(): number {
    return this.lowFloor;
  }

  getHighFloor(): number {
    return this.highFloor;
  }

  getStats(): VadV11Stats {
    return {
      ...this.stats,
      calibrated: this.calibrated,
      lowFloor: this.lowFloor,
      highFloor: this.highFloor,
      probability: this.smoothedProbability,
      speaking: this.speaking,
      speechMs: this.speechMs,
    };
  }

  /** Reconfigure live (same validation as construction). */
  reconfigure(options: VadV11Options): Required<VadV11Options> {
    const next = options.preset !== undefined && options.preset !== this.options.preset
      ? validateVadV11Options(options)
      : validateVadV11Options({ ...this.options, ...options });
    this.options = next;
    return { ...next };
  }

  /** Reset all state (keeps options, re-runs calibration). */
  reset(): void {
    this.lowFloor = this.options.initialLowFloor;
    this.highFloor = this.options.initialHighFloor;
    this.speaking = false;
    this.calibrated = this.options.calibrationFrames === 0;
    this.calibrationLow = [];
    this.calibrationHigh = [];
    this.smoothedProbability = 0;
    this.speechCandidateMs = 0;
    this.silenceMs = 0;
    this.speechStartedAtMs = 0;
    this.speechMs = 0;
    this.mergedPauses = 0;
    this.pendingEndAtMs = null;
    this.pendingEndDurationMs = 0;
    this.pendingEndKind = null;
    this.pendingEndMergedPauses = 0;
    this.nowMs = 0;
    this.framesSinceShift = 0;
    this.stats = this.freshStats();
    this.stats.calibrated = this.calibrated;
  }

  private emit(event: VadV11Event): void {
    this.sink?.(event);
  }

  /**
   * Feed one 20 ms PCM16 frame. `echo` marks frames that overlap
   * agent playback. Returns the smoothed speech probability.
   */
  feed(frame: Uint8Array, input: { echo?: boolean } = {}): number {
    if (!isValidPcm16Frame(frame) || frame.length !== VAD_V11_FRAME_SAMPLES * 2) {
      throw new Error('VAD v11 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    const o = this.options;
    const { lowRms, highRms, zcr, highLowRatio, probability } = frameFeatures(frame, this.lowFloor, this.highFloor, o);
    const atMs = this.nowMs;
    this.nowMs += VAD_V11_FRAME_MS;
    this.stats.frames += 1;
    this.framesSinceShift += 1;

    // Calibration: collect room-noise frames, then set both floors
    // to mean + 2σ (clamped to a sane band so a loud calibration
    // cannot deafen the detector completely).
    if (!this.calibrated) {
      this.calibrationLow.push(lowRms);
      this.calibrationHigh.push(highRms);
      if (this.calibrationLow.length >= o.calibrationFrames) {
        this.finishCalibration(atMs);
      }
      this.stats.silenceFrames += 1;
      return this.smoothedProbability;
    }

    const alpha = o.smoothingAlpha;
    this.smoothedProbability = this.smoothedProbability + (probability - this.smoothedProbability) * alpha;
    const smoothed = this.smoothedProbability;

    const looksHum = lowRms > this.lowFloor * 2 && zcr < o.minZeroCrossings && highLowRatio < o.minHighLowRatio;
    const looksHiss = lowRms > this.lowFloor * 2 && zcr > o.maxZeroCrossings && highLowRatio > o.maxHighLowRatio;
    if (looksHum) this.stats.humRejections += 1;
    if (looksHiss) this.stats.hissRejections += 1;

    if (input.echo === true) {
      if (this.speaking) this.stats.doubleTalkFrames += 1;
      else this.stats.echoRejections += 1;
    }
    const echoOnly = input.echo === true;

    if (!this.speaking) {
      if (smoothed >= o.startThreshold && !echoOnly) {
        this.speechCandidateMs += VAD_V11_FRAME_MS;
        this.stats.speechFrames += 1;
        if (this.speechCandidateMs >= o.minSpeechMs) {
          // Pause merge: speech resumes shortly after a turn's
          // hangover expired — reopen the *same* turn instead of
          // starting a new one. The pending end never fired its
          // speech-end event (it is held until the merge window
          // passes), so no consumer saw the turn close.
          if (this.pendingEndAtMs !== null && atMs - this.pendingEndAtMs <= o.mergePauseMs) {
            const pauseMs = atMs - this.pendingEndAtMs;
            this.speaking = true;
            this.mergedPauses += 1;
            this.stats.mergedPauses += 1;
            this.speechMs = this.pendingEndDurationMs + this.speechCandidateMs;
            this.silenceMs = 0;
            this.pendingEndAtMs = null;
            this.pendingEndKind = null;
            this.emit({ kind: 'turn-merged', atMs, pauseMs, durationMs: this.speechMs });
            return smoothed;
          }
          // A pending end that outlived its merge window is closed
          // before the new turn starts (its event fires now, with
          // the original end time).
          this.flushPendingEnd();
          this.speaking = true;
          this.speechStartedAtMs = atMs - this.speechCandidateMs + VAD_V11_FRAME_MS;
          this.speechMs = this.speechCandidateMs;
          this.silenceMs = 0;
          this.mergedPauses = 0;
          this.pendingEndAtMs = null;
          this.stats.turns += 1;
          this.emit({ kind: 'speech-start', atMs: this.speechStartedAtMs, confidence: smoothed, lowRms, highRms });
          return smoothed;
        }
        return smoothed;
      }
      // Not speech: decay the candidate, adapt floors on quiet frames.
      this.speechCandidateMs = 0;
      this.stats.silenceFrames += 1;
      // The pending end fires once its merge window passes — the
      // turn is only then observable as closed.
      if (this.pendingEndAtMs !== null && atMs - this.pendingEndAtMs > o.mergePauseMs) {
        this.flushPendingEnd();
      }
      if (smoothed <= o.stopThreshold) this.adaptFloors(lowRms, highRms, atMs);
      return smoothed;
    }

    // Inside a turn.
    this.stats.speechFrames += 1;
    this.speechMs += VAD_V11_FRAME_MS;
    if (smoothed <= o.stopThreshold && !echoOnly) {
      this.silenceMs += VAD_V11_FRAME_MS;
      if (this.silenceMs >= o.hangoverMs) {
        // Hangover expired: hold the end as pending instead of
        // emitting it — a short pause may merge back into this
        // turn. The turn is closed (speaking=false) but its
        // speech-end event is deferred until the merge window
        // passes or speech resumes.
        const durationMs = this.speechMs - this.silenceMs;
        this.speaking = false;
        this.silenceMs = 0;
        this.speechCandidateMs = 0;
        this.pendingEndAtMs = atMs;
        this.pendingEndDurationMs = durationMs;
        this.pendingEndMergedPauses = this.mergedPauses;
        this.pendingEndKind =
          durationMs < o.minTurnMs
            ? durationMs >= o.minBackchannelMs && durationMs <= o.maxBackchannelMs
              ? 'backchannel'
              : 'false-start'
            : 'speech-end';
        return smoothed;
      }
      return smoothed;
    }
    this.silenceMs = 0;
    // Max turn guard: force-end a turn that runs far too long.
    if (this.speechMs >= o.maxTurnMs) {
      const durationMs = this.speechMs;
      this.speaking = false;
      this.silenceMs = 0;
      this.speechCandidateMs = 0;
      this.pendingEndAtMs = null;
      this.pendingEndKind = null;
      this.stats.maxTurns += 1;
      this.emit({ kind: 'max-turn', atMs, durationMs });
    }
    return smoothed;
  }

  /**
   * Emit the held end-of-turn event (speech-end / backchannel /
   * false-start) with its original end time, and count it. Called
   * when the merge window passes without resumed speech, or when a
   * new turn starts after the window.
   */
  private flushPendingEnd(): void {
    if (this.pendingEndAtMs === null || this.pendingEndKind === null) return;
    const atMs = this.pendingEndAtMs;
    const durationMs = this.pendingEndDurationMs;
    const kind = this.pendingEndKind;
    this.pendingEndAtMs = null;
    this.pendingEndKind = null;
    if (kind === 'speech-end') {
      this.emit({ kind: 'speech-end', atMs, durationMs, mergedPauses: this.pendingEndMergedPauses });
    } else if (kind === 'backchannel') {
      this.stats.backchannels += 1;
      this.emit({ kind: 'backchannel', atMs, durationMs });
    } else {
      this.stats.falseStarts += 1;
      this.emit({ kind: 'false-start', atMs, durationMs });
    }
  }

  private finishCalibration(atMs: number): void {
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const std = (xs: number[], m: number): number =>
      Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, xs.length));
    const lowMean = mean(this.calibrationLow);
    const lowStd = std(this.calibrationLow, lowMean);
    const highMean = mean(this.calibrationHigh);
    const highStd = std(this.calibrationHigh, highMean);
    // mean + 2σ, but never below the preset floor and never above
    // 10x it — a loud calibration room must not deafen the detector.
    this.lowFloor = Math.max(
      this.options.initialLowFloor,
      Math.min(this.options.initialLowFloor * 10, lowMean + 2 * lowStd),
    );
    this.highFloor = Math.max(
      this.options.initialHighFloor,
      Math.min(this.options.initialHighFloor * 10, highMean + 2 * highStd),
    );
    this.calibrated = true;
    this.stats.calibrated = true;
    this.emit({
      kind: 'calibration-done',
      atMs,
      frames: this.calibrationLow.length,
      lowFloor: this.lowFloor,
      highFloor: this.highFloor,
    });
  }

  private adaptFloors(lowRms: number, highRms: number, atMs: number): void {
    const o = this.options;
    // Only learn from frames that plausibly are room noise: both
    // bands within 3x of their floors. A loud hum or hiss is an
    // interferer, not the room — adapting to it would chase the
    // floors up until the detector goes deaf to real speech.
    if (lowRms > this.lowFloor * 3 || highRms > this.highFloor * 3) return;
    const rate = o.floorAdaptRate;
    const clampFloor = (next: number, initial: number): number =>
      Math.max(initial * 0.25, Math.min(initial * 10, next));
    const nextLow = clampFloor(this.lowFloor + (lowRms - this.lowFloor) * rate, o.initialLowFloor);
    const nextHigh = clampFloor(this.highFloor + (highRms - this.highFloor) * rate, o.initialHighFloor);
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

/** Create a v11 VAD (factory, mirrors `createVadV10`). */
export function createVadV11(options: VadV11Options = {}, sink: VadV11EventSink | null = null): VadV11 {
  return new VadV11(options, sink);
}

/** One-line summary of a v11 VAD's counters. */
export function vadV11Summary(stats: VadV11Stats): string {
  return (
    `VAD v11: ${stats.frames} frames, ${stats.turns} turns, ${stats.backchannels} backchannels, ` +
    `${stats.falseStarts} false starts, ${stats.mergedPauses} merged pauses, ${stats.maxTurns} max-turns, ` +
    `${stats.doubleTalkFrames} double-talk frames, ${stats.humRejections} hum + ${stats.hissRejections} hiss rejections, ` +
    `floors low=${stats.lowFloor.toFixed(4)} high=${stats.highFloor.toFixed(4)}, ` +
    `calibrated=${stats.calibrated ? 'yes' : 'no'}, p=${stats.probability.toFixed(2)}`
  );
}

/** VAD v11 stats as Markdown (for the diagnostics panel). */
export function vadV11Markdown(stats: VadV11Stats): string {
  const lines = [
    '## VAD v11',
    '',
    `- frames: ${stats.frames} (speech ${stats.speechFrames}, silence ${stats.silenceFrames})`,
    `- turns: ${stats.turns}, backchannels: ${stats.backchannels}, false starts: ${stats.falseStarts}`,
    `- merged pauses: ${stats.mergedPauses}, max-turns: ${stats.maxTurns}`,
    `- double-talk frames: ${stats.doubleTalkFrames}, echo rejections: ${stats.echoRejections}`,
    `- hum rejections: ${stats.humRejections}, hiss rejections: ${stats.hissRejections}`,
    `- floor adaptations: ${stats.floorAdaptations}, floor shifts: ${stats.floorShifts}`,
    `- calibrated: ${stats.calibrated ? 'yes' : 'no'}`,
    `- low floor: ${stats.lowFloor.toFixed(4)}, high floor: ${stats.highFloor.toFixed(4)}`,
    `- probability: ${stats.probability.toFixed(2)}, speaking: ${stats.speaking ? 'yes' : 'no'}`,
  ];
  return lines.join('\n');
}
