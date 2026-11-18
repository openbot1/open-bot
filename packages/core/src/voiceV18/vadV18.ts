/**
 * Voice activity detection v6 (v1.19, Đội T5 — voice v18).
 *
 * v17 classified every 20 ms frame as speech / silence / noise and
 * debounced the class, but its thresholds were fixed once the
 * preset was chosen: a room that gets louder mid-call (a fan
 * starts, a window opens, a cafe fills up) keeps tripping the same
 * start threshold, and a single loud cough still counts as a speech
 * start until the turn-taker notices the turn is empty. v18 wraps
 * the v17 detector and adds the layer a long call actually needs:
 *
 *   1. Adaptive thresholds. The noise floor (RMS of non-speech
 *      frames, classified per-frame against the adapted
 *      threshold) is tracked with a slow EMA. When the
 *      floor rises, the v17 start threshold is raised with it
 *      (`startThreshold = base + floorGain × (floor − baseFloor)`,
 *      clamped to [`base`, `maxStartThreshold`]); when the room
 *      goes quiet again the threshold relaxes back down. The
 *      adaptation is rate-limited (at most one step per
 *      `adaptIntervalMs`) so the threshold never chases a single
 *      loud frame, and every change fires a `threshold-adapted`
 *      event the panel can show.
 *   2. False-trigger guard. A raw speech run shorter than
 *      `minConfirmedSpeechMs` (default 120 ms) is *not* a speech
 *      start: it is a `false-trigger` (cough, clap, door, keyboard
 *      burst) — counted, reported with its peak RMS and duration,
 *      and never handed to the turn-taker. Only a run that holds
 *      past the guard fires a confirmed `speech-start`. A run that
 *      ends inside the guard also resets the pending run, so a
 *      stutter of short bursts cannot accumulate into a fake turn.
 *   3. Hangover + hold. Once speech is confirmed, short silence
 *      gaps (up to `hangoverMs`) do not end it — the v17 detector
 *      already debounces, v18 adds its own hold so a breath inside
 *      a sentence never splits the turn. Speech ends only after
 *      `hangoverMs` of continuous non-speech, and the confirmed
 *      `speech-end` carries the confirmed duration (guard time
 *      excluded from the *reported* start, included in the span).
 *   4. Noise-burst veto. While a v17 `noise-burst` is open, a new
 *      speech run needs `minConfirmedSpeechMs + noiseExtraMs`
 *      before it confirms — a truck passing outside must not steal
 *      the floor while the room is loud.
 *   5. Live reconfiguration + presets. `reconfigure()` passes new
 *      values down to v17 and re-validates the v18 layer; presets
 *      (`quiet` / `office` / `noisy` / `street`, inherited from
 *      v11) set the base threshold, guard and hangover together.
 *
 * Frames are PCM16 mono Int16Array, 20 ms (320 samples at 16 kHz)
 * — the same shape `syntheticFrameV15(rms, 320)` produces. Nothing
 * here touches a sound card, a network socket or a key: mock audio
 * only. All clocks are virtual (`atMs` passed by the caller).
 */

import {
  VadV17,
  createVadV17,
  defaultVadV17Options,
  validateVadV17Options,
  vadV17FrameFeatures,
  classifyVadFrameV17,
  VAD_V17_FRAME_MS,
  VAD_V17_FRAME_SAMPLES,
  type VadV17Event,
  type VadV17FrameClass,
  type VadV17Options,
  type VadV17Stats,
} from '../voiceV17/vadV17';

/** Frame duration the v18 VAD assumes (ms). */
export const VAD_V18_FRAME_MS = VAD_V17_FRAME_MS;
/** Samples per 20 ms frame at 16 kHz. */
export const VAD_V18_FRAME_SAMPLES = VAD_V17_FRAME_SAMPLES;

/** RMS energy of a PCM16 frame, normalised to 0..1. */
export function pcm16RmsV18(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/** Options for `AdaptiveVadV18` (everything v17 takes, plus the v18 layer). */
export interface VadV18Options extends VadV17Options {
  /** Turn the adaptive threshold on/off (default true). */
  adaptiveThreshold?: boolean;
  /** EMA rate for the tracked noise floor (0..1, higher = faster, default 0.02). */
  floorEmaRate?: number;
  /** Threshold gain per unit of floor above the base floor (default 2.0). */
  floorGain?: number;
  /** Highest the adapted start threshold may go (default 0.85). */
  maxStartThreshold?: number;
  /** Lowest the adapted start threshold may go (default = base start threshold). */
  minStartThreshold?: number;
  /** Minimum ms between two threshold adaptations (default 1000). */
  adaptIntervalMs?: number;
  /** Speech run that must hold before a confirmed speech-start (ms, default 120). */
  minConfirmedSpeechMs?: number;
  /** Extra confirmation time while a noise burst is open (ms, default 120). */
  noiseExtraMs?: number;
  /** Silence gap that still holds confirmed speech (ms, default 300). */
  hangoverMs?: number;
}

export function defaultVadV18Options(): Required<VadV18Options> {
  const base = defaultVadV17Options();
  return {
    ...base,
    adaptiveThreshold: true,
    floorEmaRate: 0.02,
    floorGain: 2.0,
    maxStartThreshold: 0.85,
    minStartThreshold: base.startThreshold,
    adaptIntervalMs: 1000,
    minConfirmedSpeechMs: 120,
    noiseExtraMs: 120,
    hangoverMs: 300,
  };
}

export function validateVadV18Options(options: VadV18Options): string[] {
  const errors = validateVadV17Options(options);
  const check = (name: keyof VadV18Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('floorEmaRate', options.floorEmaRate, 0.001, 1);
  check('floorGain', options.floorGain, 0, 20);
  check('maxStartThreshold', options.maxStartThreshold, 0.05, 0.95);
  check('minStartThreshold', options.minStartThreshold, 0.05, 0.95);
  check('adaptIntervalMs', options.adaptIntervalMs, 0, 60000);
  check('minConfirmedSpeechMs', options.minConfirmedSpeechMs, 0, 5000);
  check('noiseExtraMs', options.noiseExtraMs, 0, 5000);
  check('hangoverMs', options.hangoverMs, 0, 10000);
  if (
    options.minStartThreshold !== undefined &&
    options.maxStartThreshold !== undefined &&
    options.minStartThreshold > options.maxStartThreshold
  ) {
    errors.push('minStartThreshold must not exceed maxStartThreshold');
  }
  if (
    options.startThreshold !== undefined &&
    options.maxStartThreshold !== undefined &&
    options.startThreshold > options.maxStartThreshold
  ) {
    errors.push('startThreshold must not exceed maxStartThreshold');
  }
  return errors;
}

/** A rejected short burst: what it was, how long, how loud. */
export interface VadV18FalseTrigger {
  id: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  peakRms: number;
  peakProbability: number;
}

/** Events emitted by `AdaptiveVadV18`. */
export type VadV18EventKind =
  | 'speech-start'
  | 'speech-end'
  | 'false-trigger'
  | 'threshold-adapted'
  | 'noise-burst'
  | 'noise-end'
  | 'calibration-done'
  | 'segment'
  | 'class-changed';

export interface VadV18Event {
  kind: VadV18EventKind;
  atMs: number;
  /** Confirmed speech duration (speech-end only). */
  durationMs?: number;
  /** Rejected burst (false-trigger only). */
  falseTrigger?: VadV18FalseTrigger;
  /** Previous / new start threshold (threshold-adapted only). */
  fromThreshold?: number;
  toThreshold?: number;
  /** Tracked noise floor at adaptation time. */
  noiseFloor?: number;
  /** The v17 event this v18 event was derived from, when any. */
  source?: VadV17Event;
}

export type VadV18EventSink = (event: VadV18Event) => void;

export interface VadV18Stats extends VadV17Stats {
  /** Current (possibly adapted) start threshold. */
  startThreshold: number;
  /** Base start threshold from the preset/options. */
  baseStartThreshold: number;
  /** Tracked RMS noise floor (EMA over silence frames). */
  noiseFloor: number;
  /** How many times the threshold was adapted. */
  adaptations: number;
  /** Short bursts rejected by the false-trigger guard. */
  falseTriggers: number;
  /** Confirmed speech starts (guard passed). */
  confirmedSpeechStarts: number;
  /** Confirmed speech ends. */
  confirmedSpeechEnds: number;
  /** False-trigger rate over all speech-ish runs (0..1). */
  falseTriggerRate: number;
  /** Whether a noise burst is currently open. */
  noiseBurstOpen: boolean;
  /** Whether speech is currently confirmed. */
  confirmedSpeaking: boolean;
}

/**
 * Adaptive VAD v6: a v17 detector plus an adaptive threshold and a
 * false-trigger guard. The inner detector still owns frame
 * classification, debounce, segments and noise bursts; v18 owns the
 * *decision to believe* a speech run.
 */
export class AdaptiveVadV18 {
  /** The wrapped v17 detector (frame classification lives here). */
  readonly vad: VadV17;
  private readonly options: Required<VadV18Options>;
  private readonly sink: VadV18EventSink | undefined;
  private noiseFloor: number;
  private readonly baseFloor: number;
  private readonly baseStartThreshold: number;
  private currentStartThreshold: number;
  private lastAdaptMs = -1;
  private adaptations = 0;
  private noiseBurstOpen = false;
  private pendingRunMs = 0;
  private pendingRunStartMs = 0;
  private pendingPeakRms = 0;
  private pendingPeakProbability = 0;
  private confirmedSpeaking = false;
  private confirmedStartMs = 0;
  private silenceRunMs = 0;
  private falseTriggers: VadV18FalseTrigger[] = [];
  private confirmedStarts = 0;
  private confirmedEnds = 0;
  private speechRuns = 0;
  private falseTriggerSeq = 0;

  constructor(options: VadV18Options = {}, sink?: VadV18EventSink) {
    const errors = validateVadV18Options(options);
    if (errors.length > 0) throw new Error(`invalid VAD v18 options: ${errors.join('; ')}`);
    const merged = { ...defaultVadV18Options(), ...options };
    this.options = merged;
    this.sink = sink;
    this.vad = createVadV17(merged);
    this.baseFloor = merged.initialLowFloor;
    this.noiseFloor = merged.initialLowFloor;
    this.baseStartThreshold = merged.startThreshold;
    this.currentStartThreshold = merged.startThreshold;
  }

  getOptions(): Required<VadV18Options> {
    return { ...this.options, startThreshold: this.currentStartThreshold };
  }

  getClass(): VadV17FrameClass {
    return this.vad.getClass();
  }

  isSpeaking(): boolean {
    return this.confirmedSpeaking;
  }

  isCalibrated(): boolean {
    return this.vad.isCalibrated();
  }

  getProbability(): number {
    return this.vad.getProbability();
  }

  getStartThreshold(): number {
    return this.currentStartThreshold;
  }

  getNoiseFloor(): number {
    return this.noiseFloor;
  }

  getLowFloor(): number {
    return this.vad.getLowFloor();
  }

  getHighFloor(): number {
    return this.vad.getHighFloor();
  }

  /** Reconfigure live: new values flow to v17, the v18 layer re-validates. */
  reconfigure(options: VadV18Options): Required<VadV18Options> {
    const errors = validateVadV18Options({ ...this.options, ...options });
    if (errors.length > 0) throw new Error(`invalid VAD v18 options: ${errors.join('; ')}`);
    const next = { ...this.options, ...options };
    if (options.startThreshold !== undefined) {
      this.currentStartThreshold = options.startThreshold;
    }
    this.vad.reconfigure({ ...next, startThreshold: this.currentStartThreshold });
    (this as unknown as { options: Required<VadV18Options> }).options = next;
    return this.getOptions();
  }

  reset(): void {
    this.vad.reset();
    this.noiseFloor = this.baseFloor;
    this.currentStartThreshold = this.baseStartThreshold;
    this.lastAdaptMs = -1;
    this.adaptations = 0;
    this.noiseBurstOpen = false;
    this.pendingRunMs = 0;
    this.pendingRunStartMs = 0;
    this.pendingPeakRms = 0;
    this.pendingPeakProbability = 0;
    this.confirmedSpeaking = false;
    this.confirmedStartMs = 0;
    this.silenceRunMs = 0;
    this.falseTriggers = [];
    this.confirmedStarts = 0;
    this.confirmedEnds = 0;
    this.speechRuns = 0;
    this.falseTriggerSeq = 0;
  }

  private emit(event: VadV18Event): void {
    if (this.sink) this.sink(event);
  }

  /** Adapt the start threshold from the tracked noise floor (rate-limited). */
  private maybeAdapt(atMs: number): void {
    if (!this.options.adaptiveThreshold) return;
    if (this.lastAdaptMs >= 0 && atMs - this.lastAdaptMs < this.options.adaptIntervalMs) return;
    const floorDelta = Math.max(0, this.noiseFloor - this.baseFloor);
    const target = Math.min(
      this.options.maxStartThreshold,
      Math.max(this.options.minStartThreshold, this.baseStartThreshold + this.options.floorGain * floorDelta),
    );
    if (Math.abs(target - this.currentStartThreshold) < 0.005) return;
    const from = this.currentStartThreshold;
    this.currentStartThreshold = target;
    this.lastAdaptMs = atMs;
    this.adaptations += 1;
    this.vad.reconfigure({ startThreshold: target });
    this.emit({ kind: 'threshold-adapted', atMs, fromThreshold: from, toThreshold: target, noiseFloor: this.noiseFloor });
  }

  private rejectPendingRun(endMs: number): void {
    if (this.pendingRunMs <= 0) return;
    this.falseTriggerSeq += 1;
    const trigger: VadV18FalseTrigger = {
      id: `ft-v18-${this.falseTriggerSeq}`,
      startMs: this.pendingRunStartMs,
      endMs,
      durationMs: this.pendingRunMs,
      peakRms: this.pendingPeakRms,
      peakProbability: this.pendingPeakProbability,
    };
    this.falseTriggers.push(trigger);
    this.pendingRunMs = 0;
    this.pendingPeakRms = 0;
    this.pendingPeakProbability = 0;
    this.emit({ kind: 'false-trigger', atMs: endMs, falseTrigger: trigger });
  }

  /**
   * Feed one 20 ms PCM16 frame. Returns the v18 event for this frame,
   * if any (confirmed speech-start/end, false-trigger, adaptation…).
   * Echo frames (the bot's own playback) never start a run.
   *
   * The guard/hangover logic reads the *raw* per-frame class
   * (single-frame features against the currently adapted
   * threshold), not the v17 debounced class: the v17 class rides
   * the v11 smoothed probability with hysteresis, so it can stay
   * "speech" for hundreds of milliseconds after the user stopped
   * talking — the v18 hangover must be measured from the frames
   * themselves, or a turn would never end on time.
   */
  feed(frame: Int16Array, atMs: number, echo = false): VadV18Event | undefined {
    if (!(frame instanceof Int16Array) || frame.length !== VAD_V18_FRAME_SAMPLES) {
      throw new Error('VAD v18 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    const features = vadV17FrameFeatures(frame, this.options);
    const innerEvent = this.vad.feed(frame, atMs, echo);
    // Raw per-frame class against the *adapted* threshold: in a loud
    // room the threshold has risen, so loud room noise stays silence.
    const rawClass = echo
      ? 'silence'
      : classifyVadFrameV17(features, { ...this.options, startThreshold: this.currentStartThreshold });
    const rms = pcm16RmsV18(frame);

    // Track the noise floor from non-speech frames (silence *and*
    // noise both describe the room, not the user).
    if (rawClass !== 'speech' && !echo) {
      const rate = this.options.floorEmaRate;
      this.noiseFloor = this.noiseFloor * (1 - rate) + rms * rate;
      this.maybeAdapt(atMs);
    }

    if (innerEvent?.kind === 'noise-burst') {
      this.noiseBurstOpen = true;
      this.emit({ kind: 'noise-burst', atMs, source: innerEvent });
    } else if (innerEvent?.kind === 'noise-end') {
      this.noiseBurstOpen = false;
      this.emit({ kind: 'noise-end', atMs, source: innerEvent });
    } else if (innerEvent?.kind === 'calibration-done') {
      this.emit({ kind: 'calibration-done', atMs, source: innerEvent });
    } else if (innerEvent?.kind === 'segment') {
      this.emit({ kind: 'segment', atMs, source: innerEvent });
    }

    const requiredRun = this.options.minConfirmedSpeechMs + (this.noiseBurstOpen ? this.options.noiseExtraMs : 0);

    if (rawClass === 'speech' && !echo) {
      this.silenceRunMs = 0;
      if (this.confirmedSpeaking) return undefined;
      if (this.pendingRunMs === 0) {
        this.pendingRunStartMs = atMs;
        this.pendingPeakRms = rms;
        this.pendingPeakProbability = features.smoothedProbability;
      }
      this.pendingRunMs += VAD_V18_FRAME_MS;
      if (rms > this.pendingPeakRms) this.pendingPeakRms = rms;
      if (features.smoothedProbability > this.pendingPeakProbability) {
        this.pendingPeakProbability = features.smoothedProbability;
      }
      if (this.pendingRunMs >= requiredRun) {
        this.confirmedSpeaking = true;
        this.confirmedStartMs = this.pendingRunStartMs;
        this.confirmedStarts += 1;
        this.speechRuns += 1;
        this.pendingRunMs = 0;
        this.pendingPeakRms = 0;
        this.pendingPeakProbability = 0;
        const event: VadV18Event = { kind: 'speech-start', atMs, source: innerEvent };
        this.emit(event);
        return event;
      }
      return undefined;
    }

    // Non-speech frame: a pending run that never confirmed is a false trigger.
    if (!this.confirmedSpeaking) {
      if (this.pendingRunMs > 0) {
        this.rejectPendingRun(atMs);
        return this.falseTriggers.length > 0
          ? { kind: 'false-trigger', atMs, falseTrigger: this.falseTriggers[this.falseTriggers.length - 1] }
          : undefined;
      }
      return undefined;
    }

    // Confirmed speech: hold through short silence gaps (hangover).
    this.silenceRunMs += VAD_V18_FRAME_MS;
    if (this.silenceRunMs >= this.options.hangoverMs) {
      this.confirmedSpeaking = false;
      this.confirmedEnds += 1;
      const durationMs = atMs - this.confirmedStartMs;
      this.silenceRunMs = 0;
      const event: VadV18Event = { kind: 'speech-end', atMs, durationMs, source: innerEvent };
      this.emit(event);
      return event;
    }
    return undefined;
  }

  falseTriggersList(): VadV18FalseTrigger[] {
    return [...this.falseTriggers];
  }

  segmentsList(): ReturnType<VadV17['segmentsList']> {
    return this.vad.segmentsList();
  }

  openSegmentSnapshot(): ReturnType<VadV17['openSegmentSnapshot']> {
    return this.vad.openSegmentSnapshot();
  }

  stats(): VadV18Stats {
    const inner = this.vad.stats();
    const runs = this.speechRuns + this.falseTriggers.length;
    return {
      ...inner,
      startThreshold: this.currentStartThreshold,
      baseStartThreshold: this.baseStartThreshold,
      noiseFloor: this.noiseFloor,
      adaptations: this.adaptations,
      falseTriggers: this.falseTriggers.length,
      confirmedSpeechStarts: this.confirmedStarts,
      confirmedSpeechEnds: this.confirmedEnds,
      falseTriggerRate: runs === 0 ? 0 : this.falseTriggers.length / runs,
      noiseBurstOpen: this.noiseBurstOpen,
      confirmedSpeaking: this.confirmedSpeaking,
    };
  }

  summary(): string {
    const s = this.stats();
    return (
      `VAD v18: ${s.frames} frames, ${s.confirmedSpeechStarts} confirmed starts, ` +
      `${s.falseTriggers} false triggers (${Math.round(s.falseTriggerRate * 100)}%), ` +
      `threshold ${s.startThreshold.toFixed(2)} (base ${s.baseStartThreshold.toFixed(2)}, ` +
      `${s.adaptations} adaptations), noise floor ${s.noiseFloor.toFixed(4)}, ` +
      `${s.noiseBursts} noise bursts`
    );
  }

  markdown(): string {
    const s = this.stats();
    const rows: string[] = [
      '# VAD v18',
      '',
      `- Frames: ${s.frames} (speech ${s.speechFrames}, silence ${s.silenceFrames}, noise ${s.noiseFrames})`,
      `- Confirmed speech starts: ${s.confirmedSpeechStarts} / ends: ${s.confirmedSpeechEnds}`,
      `- False triggers: ${s.falseTriggers} (rate ${(s.falseTriggerRate * 100).toFixed(1)}%)`,
      `- Start threshold: ${s.startThreshold.toFixed(2)} (base ${s.baseStartThreshold.toFixed(2)}, ${s.adaptations} adaptations)`,
      `- Noise floor: ${s.noiseFloor.toFixed(4)} (low ${s.lowFloor.toFixed(4)}, high ${s.highFloor.toFixed(4)})`,
      `- Noise bursts: ${s.noiseBursts}${s.noiseBurstOpen ? ' (one open)' : ''}`,
      `- Calibrated: ${s.calibrated ? 'yes' : 'no'}`,
      '',
    ];
    if (this.falseTriggers.length > 0) {
      rows.push('## False triggers');
      rows.push('');
      for (const ft of this.falseTriggers.slice(-10)) {
        rows.push(`- ${ft.id}: ${ft.durationMs} ms at ${ft.startMs} ms, peak RMS ${ft.peakRms.toFixed(3)}`);
      }
      rows.push('');
    }
    return rows.join('\n');
  }
}

export function createVadV18(options: VadV18Options = {}, sink?: VadV18EventSink): AdaptiveVadV18 {
  return new AdaptiveVadV18(options, sink);
}

/** One-line summary of a VAD v18 detector (panel / log). */
export function vadV18Summary(vad: AdaptiveVadV18): string {
  return vad.summary();
}

/** Markdown report of a VAD v18 detector. */
export function vadV18Markdown(vad: AdaptiveVadV18): string {
  return vad.markdown();
}
