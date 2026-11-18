/**
 * Voice activity detection v5 (v1.18, Đội T5 — voice v17).
 *
 * v11 decided speech-or-silence through a fitted probability
 * (energy + ZCR + high/low ratio) with hysteresis, calibration,
 * pause merging and a max-turn guard — but it only ever answered
 * "speaking or not". A realtime turn-taker needs a third answer:
 * *noise*. A loud fan, a passing truck, a keyboard burst all carry
 * energy, and an energy-only gate (or a probability that is merely
 * "not high enough") cannot tell the session whether the user is
 * talking, the room is loud, or nothing is happening — and each
 * case wants a different reaction (listen / ignore-and-stay /
 * stay-silent).
 *
 * v17 wraps the v11 detector and adds the missing layer on top of
 * it, without touching its internals:
 *
 *   1. Three-way frame classification. Every 20 ms frame is
 *      `speech` | `silence` | `noise`: speech when the v11
 *      smoothed probability is at/above the start threshold;
 *      noise when the frame is loud (RMS above the adaptive low
 *      floor × `noiseRmsMultiplier`) *but* its speech probability
 *      stays below `noiseProbabilityCeiling` (loud, yet not
 *      speech-shaped — hum, hiss, rumble); silence otherwise.
 *      Echo frames (the bot's own playback leaking into the mic)
 *      are always silence — they are the bot, not the room.
 *   2. Debounce. The raw class must hold for `debounceMs`
 *      (default 40 ms = 2 frames) before the reported class
 *      changes, so a single odd frame never flips the turn-taker.
 *   3. Noise bursts. Noise that sustains for `noiseMinMs`
 *      (default 300 ms) fires one `noise-burst` event and, when it
 *      ends, one `noise-end` — the session can log "room got loud"
 *      or raise the VAD floors instead of cutting a turn short.
 *   4. Segments. Consecutive frames of one class form a segment
 *      (speech or noise; silence is not recorded) with start/end,
 *      frame count, peak RMS and mean probability, emitted as a
 *      `segment` event when it closes — the turn history reads
 *      this, not a guess.
 *   5. Live reconfiguration. `reconfigure()` passes new thresholds
 *      (preset or explicit values) down to v11 and re-validates
 *      the v17 layer, so a session can switch from `quiet` to
 *      `noisy` mid-call when the room changes.
 *
 * Frames are PCM16 mono Int16Array, 20 ms (320 samples at 16 kHz)
 * — the same shape `syntheticFrameV15(rms, 320)` produces and the
 * barge-in engines consume. Nothing here touches a sound card, a
 * network socket or a key: mock audio only.
 */

import {
  VadV11,
  validateVadV11Options,
  vadV11FrameFeatures,
  VAD_V11_FRAME_MS,
  VAD_V11_FRAME_SAMPLES,
  type VadV11Event,
  type VadV11Options,
  type VadV11PresetName,
} from '../voice/vadV11';

/** One frame's verdict: user speech, room noise, or nothing. */
export type VadV17FrameClass = 'speech' | 'silence' | 'noise';

/** Frame duration the v17 VAD assumes (ms). */
export const VAD_V17_FRAME_MS = VAD_V11_FRAME_MS;
/** Samples per 20 ms frame at 16 kHz. */
export const VAD_V17_FRAME_SAMPLES = VAD_V11_FRAME_SAMPLES;

export interface VadV17Options extends VadV11Options {
  /** RMS above lowFloor × this + low probability counts as noise (default 3). */
  noiseRmsMultiplier?: number;
  /** Probability below this + loud RMS counts as noise (default 0.45). */
  noiseProbabilityCeiling?: number;
  /** Sustained noise before one `noise-burst` fires (ms, default 300). */
  noiseMinMs?: number;
  /** Raw class must hold this long before the reported class changes (ms, default 40). */
  debounceMs?: number;
}

export function defaultVadV17Options(): Required<VadV17Options> {
  const base = validateVadV11Options({ preset: 'office', calibrationFrames: 0 });
  return {
    ...base,
    noiseRmsMultiplier: 3,
    noiseProbabilityCeiling: 0.45,
    noiseMinMs: 300,
    debounceMs: 40,
  };
}

export function validateVadV17Options(options: VadV17Options): string[] {
  const errors: string[] = [];
  try {
    validateVadV11Options(options);
  } catch (err) {
    errors.push((err as Error).message);
  }
  const check = (name: keyof VadV17Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('noiseRmsMultiplier', options.noiseRmsMultiplier, 1, 50);
  check('noiseProbabilityCeiling', options.noiseProbabilityCeiling, 0.05, 0.95);
  check('noiseMinMs', options.noiseMinMs, 0, 10000);
  check('debounceMs', options.debounceMs, 0, 1000);
  if (
    options.noiseProbabilityCeiling !== undefined &&
    options.startThreshold !== undefined &&
    options.noiseProbabilityCeiling >= options.startThreshold
  ) {
    errors.push('noiseProbabilityCeiling must be below startThreshold (noise is loud-but-not-speech)');
  }
  return errors;
}

/** Band energies + flatness of one frame (same shape as v11). */
export interface VadV17FrameFeatures {
  rms: number;
  highRms: number;
  zcr: number;
  highLowRatio: number;
  /** Raw speech probability of this frame (0..1), before smoothing. */
  probability: number;
  /** Smoothed probability (EMA) the start/stop decisions use. */
  smoothedProbability: number;
}

/** PCM16 Int16Array → little-endian bytes for the v11 detector. */
export function pcm16ToBytesV17(frame: Int16Array): Uint8Array {
  const bytes = new Uint8Array(frame.length * 2);
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] ?? 0;
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return bytes;
}

/**
 * Pure per-frame features: RMS, zero-crossing rate, high-band
 * (first-difference) RMS, high/low ratio and the v11 speech
 * probability — no state, no clock. Throws on a frame that is not
 * 320 PCM16 samples.
 */
export function vadV17FrameFeatures(frame: Int16Array, options: VadV17Options = {}): VadV17FrameFeatures {
  if (!(frame instanceof Int16Array) || frame.length !== VAD_V17_FRAME_SAMPLES) {
    throw new Error('VAD v17 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
  }
  const f = vadV11FrameFeatures(pcm16ToBytesV17(frame), options);
  return {
    rms: f.lowRms,
    highRms: f.highRms,
    zcr: f.zcr,
    highLowRatio: f.highLowRatio,
    probability: f.probability,
    smoothedProbability: f.smoothedProbability,
  };
}

/** Classify one frame's features without any detector state. */
export function classifyVadFrameV17(
  features: VadV17FrameFeatures,
  options: VadV17Options = {},
): VadV17FrameClass {
  const merged = { ...defaultVadV17Options(), ...options };
  const lowFloor = merged.initialLowFloor;
  if (features.probability >= merged.startThreshold) return 'speech';
  if (features.rms >= lowFloor * merged.noiseRmsMultiplier && features.probability < merged.noiseProbabilityCeiling) {
    return 'noise';
  }
  return 'silence';
}

/** One recorded speech/noise segment (silence is not recorded). */
export interface VadV17Segment {
  id: string;
  class: 'speech' | 'noise';
  startMs: number;
  endMs: number;
  durationMs: number;
  frames: number;
  peakRms: number;
  meanProbability: number;
  mergedPauses: number;
}

export type VadV17EventKind =
  | 'calibration-done'
  | 'speech-start'
  | 'speech-end'
  | 'turn-merged'
  | 'backchannel'
  | 'max-turn'
  | 'noise-burst'
  | 'noise-end'
  | 'segment'
  | 'class-changed';

export interface VadV17Event {
  kind: VadV17EventKind;
  atMs: number;
  class?: VadV17FrameClass;
  durationMs?: number;
  confidence?: number;
  rms?: number;
  probability?: number;
  segment?: VadV17Segment;
  lowFloor?: number;
  highFloor?: number;
}

export type VadV17EventSink = (event: VadV17Event) => void;

export interface VadV17Stats {
  frames: number;
  speechFrames: number;
  silenceFrames: number;
  noiseFrames: number;
  segments: number;
  speechSegments: number;
  noiseBursts: number;
  backchannels: number;
  falseStarts: number;
  maxTurns: number;
  mergedPauses: number;
  calibrated: boolean;
  lowFloor: number;
  highFloor: number;
  probability: number;
  speaking: boolean;
  currentClass: VadV17FrameClass;
}

/**
 * Three-way VAD: the v11 probability detector underneath, the
 * speech/silence/noise layer, debounce and segments on top.
 * Feed 20 ms PCM16 frames with `feed()`; `atMs` is the caller's
 * virtual clock (frames are 20 ms apart by construction).
 */
export class VadV17 {
  readonly vad: VadV11;
  private readonly options: Required<VadV17Options>;
  private readonly sink: VadV17EventSink | undefined;
  private currentClass: VadV17FrameClass = 'silence';
  private pendingClass: VadV17FrameClass = 'silence';
  private pendingSinceMs = 0;
  private frames = 0;
  private speechFrames = 0;
  private silenceFrames = 0;
  private noiseFrames = 0;
  private noiseBursts = 0;
  private noiseBurstActive = false;
  private noiseSinceMs = 0;
  private segmentCounter = 0;
  private openSegment: VadV17Segment | undefined;
  private probabilitySum = 0;
  private readonly segments: VadV17Segment[] = [];

  constructor(options: VadV17Options = {}, sink?: VadV17EventSink) {
    const merged = { ...defaultVadV17Options(), ...options };
    const errors = validateVadV17Options(merged);
    if (errors.length > 0) throw new Error(`invalid VAD v17 options: ${errors.join('; ')}`);
    this.options = merged;
    this.sink = sink;
    this.vad = new VadV11(
      { ...merged, calibrationFrames: merged.calibrationFrames },
      (event: VadV11Event) => this.forwardVadEvent(event),
    );
  }

  getOptions(): Required<VadV17Options> {
    return { ...this.options };
  }

  getClass(): VadV17FrameClass {
    return this.currentClass;
  }

  isSpeaking(): boolean {
    return this.vad.isSpeaking();
  }

  isCalibrated(): boolean {
    return this.vad.isCalibrated();
  }

  getProbability(): number {
    return this.vad.getProbability();
  }

  getLowFloor(): number {
    return this.vad.getLowFloor();
  }

  getHighFloor(): number {
    return this.vad.getHighFloor();
  }

  /** Reconfigure live (same validation as construction). */
  reconfigure(options: VadV17Options): Required<VadV17Options> {
    const next = { ...this.options, ...options };
    const errors = validateVadV17Options(next);
    if (errors.length > 0) throw new Error(`invalid VAD v17 options: ${errors.join('; ')}`);
    this.vad.reconfigure(options);
    (this as unknown as { options: Required<VadV17Options> }).options = next;
    return { ...next };
  }

  /** Reset all state (keeps options, re-runs calibration when configured). */
  reset(): void {
    this.vad.reset();
    this.currentClass = 'silence';
    this.pendingClass = 'silence';
    this.pendingSinceMs = 0;
    this.frames = 0;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.noiseFrames = 0;
    this.noiseBursts = 0;
    this.noiseBurstActive = false;
    this.noiseSinceMs = 0;
    this.segmentCounter = 0;
    this.openSegment = undefined;
    this.probabilitySum = 0;
    this.segments.length = 0;
  }

  /**
   * Feed one 20 ms PCM16 frame. `echo` marks frames that overlap
   * agent playback (never user speech). Returns the event fired,
   * if any.
   */
  feed(frame: Int16Array, atMs: number, echo = false): VadV17Event | undefined {
    if (!(frame instanceof Int16Array) || frame.length !== VAD_V17_FRAME_SAMPLES) {
      throw new Error('VAD v17 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    const features = vadV17FrameFeatures(frame, this.options);
    this.vad.feed(pcm16ToBytesV17(frame), { echo });
    this.frames += 1;
    const probability = this.vad.getProbability();

    // Raw class: echo is never the user; otherwise the probability
    // decides speech, and loud-but-not-speech-shaped is noise.
    let raw: VadV17FrameClass;
    if (echo) {
      raw = 'silence';
    } else if (this.vad.isSpeaking() || probability >= this.options.startThreshold) {
      raw = 'speech';
    } else if (
      features.rms >= this.vad.getLowFloor() * this.options.noiseRmsMultiplier &&
      probability < this.options.noiseProbabilityCeiling
    ) {
      raw = 'noise';
    } else {
      raw = 'silence';
    }
    if (raw === 'speech') this.speechFrames += 1;
    else if (raw === 'noise') this.noiseFrames += 1;
    else this.silenceFrames += 1;

    // Debounce: the raw class must hold for debounceMs before the
    // reported class changes.
    if (raw !== this.pendingClass) {
      this.pendingClass = raw;
      this.pendingSinceMs = atMs;
    }
    let fired: VadV17Event | undefined;
    if (raw !== this.currentClass && atMs - this.pendingSinceMs >= this.options.debounceMs) {
      fired = this.applyClass(raw, atMs, features, probability);
    }
    // Track the open segment (speech or noise) frame by frame.
    if (this.openSegment) {
      this.openSegment.frames += 1;
      this.openSegment.peakRms = Math.max(this.openSegment.peakRms, features.rms);
      this.probabilitySum += probability;
    }
    // Sustained noise fires exactly one burst per noise run.
    if (this.currentClass === 'noise' && !this.noiseBurstActive) {
      if (this.noiseSinceMs === 0) this.noiseSinceMs = atMs;
      if (atMs - this.noiseSinceMs >= this.options.noiseMinMs) {
        this.noiseBurstActive = true;
        this.noiseBursts += 1;
        const event: VadV17Event = {
          kind: 'noise-burst',
          atMs,
          class: 'noise',
          rms: features.rms,
          probability,
          durationMs: atMs - this.noiseSinceMs,
        };
        this.sink?.(event);
        fired ??= event;
      }
    }
    return fired;
  }

  segmentsList(): VadV17Segment[] {
    return this.segments.map((s) => ({ ...s }));
  }

  openSegmentSnapshot(): VadV17Segment | undefined {
    return this.openSegment ? { ...this.openSegment } : undefined;
  }

  stats(): VadV17Stats {
    const v11 = this.vad.getStats();
    return {
      frames: this.frames,
      speechFrames: this.speechFrames,
      silenceFrames: this.silenceFrames,
      noiseFrames: this.noiseFrames,
      segments: this.segments.length,
      speechSegments: this.segments.filter((s) => s.class === 'speech').length,
      noiseBursts: this.noiseBursts,
      backchannels: v11.backchannels,
      falseStarts: v11.falseStarts,
      maxTurns: v11.maxTurns,
      mergedPauses: v11.mergedPauses,
      calibrated: this.vad.isCalibrated(),
      lowFloor: this.vad.getLowFloor(),
      highFloor: this.vad.getHighFloor(),
      probability: this.vad.getProbability(),
      speaking: this.vad.isSpeaking(),
      currentClass: this.currentClass,
    };
  }

  summary(): string {
    const s = this.stats();
    return `vad v17: ${s.frames} frames (${s.speechFrames} speech, ${s.noiseFrames} noise, ${s.silenceFrames} silence), ` +
      `${s.segments} segments (${s.speechSegments} speech), ${s.noiseBursts} noise bursts, ` +
      `class=${s.currentClass}, floors low=${s.lowFloor.toFixed(4)} high=${s.highFloor.toFixed(4)}`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## VAD v17',
      '',
      `- Frames: ${s.frames} (speech ${s.speechFrames}, noise ${s.noiseFrames}, silence ${s.silenceFrames})`,
      `- Segments: ${s.segments} (${s.speechSegments} speech); noise bursts: ${s.noiseBursts}`,
      `- Backchannels: ${s.backchannels}; false starts: ${s.falseStarts}; max turns: ${s.maxTurns}; merged pauses: ${s.mergedPauses}`,
      `- Calibrated: ${s.calibrated}; low floor ${s.lowFloor.toFixed(4)}; high floor ${s.highFloor.toFixed(4)}; probability ${s.probability.toFixed(2)}`,
      `- Current class: ${s.currentClass}; speaking: ${s.speaking}`,
      '',
      '| Segment | Class | Start | Duration | Frames | Peak RMS |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
    ];
    for (const seg of this.segments) {
      lines.push(`| ${seg.id} | ${seg.class} | ${seg.startMs} ms | ${seg.durationMs} ms | ${seg.frames} | ${seg.peakRms.toFixed(3)} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private applyClass(next: VadV17FrameClass, atMs: number, features: VadV17FrameFeatures, probability: number): VadV17Event {
    const previous = this.currentClass;
    // Close the open segment (speech/noise only).
    let closed: VadV17Segment | undefined;
    if (this.openSegment) {
      closed = this.closeSegment(atMs);
    }
    this.currentClass = next;
    if (next === 'noise') {
      this.noiseSinceMs = atMs;
      this.noiseBurstActive = false;
    } else if (this.noiseBurstActive) {
      // Noise run ended: exactly one noise-end per burst.
      this.noiseBurstActive = false;
      this.sink?.({ kind: 'noise-end', atMs, class: 'noise', durationMs: atMs - this.noiseSinceMs });
      this.noiseSinceMs = 0;
    } else {
      this.noiseSinceMs = 0;
    }
    if (next === 'speech' || next === 'noise') {
      this.segmentCounter += 1;
      this.openSegment = {
        id: `seg-${this.segmentCounter}`,
        class: next,
        startMs: atMs,
        endMs: atMs,
        durationMs: 0,
        frames: 0,
        peakRms: 0,
        meanProbability: probability,
        mergedPauses: 0,
      };
      this.probabilitySum = 0;
    }
    const event: VadV17Event = {
      kind: 'class-changed',
      atMs,
      class: next,
      rms: features.rms,
      probability,
    };
    this.sink?.(event);
    if (closed) {
      this.sink?.({ kind: 'segment', atMs, class: closed.class, durationMs: closed.durationMs, segment: { ...closed } });
    }
    void previous;
    return event;
  }

  private closeSegment(atMs: number): VadV17Segment {
    const seg = this.openSegment as VadV17Segment;
    seg.endMs = atMs;
    seg.durationMs = Math.max(0, atMs - seg.startMs);
    seg.meanProbability = seg.frames > 0 ? this.probabilitySum / seg.frames : 0;
    this.segments.push({ ...seg });
    this.openSegment = undefined;
    this.probabilitySum = 0;
    return seg;
  }

  private forwardVadEvent(event: VadV11Event): void {
    switch (event.kind) {
      case 'calibration-done':
        this.sink?.({ kind: 'calibration-done', atMs: event.atMs, lowFloor: event.lowFloor, highFloor: event.highFloor });
        break;
      case 'speech-start':
        this.sink?.({ kind: 'speech-start', atMs: event.atMs, confidence: event.confidence, rms: event.lowRms, probability: event.confidence });
        break;
      case 'speech-end':
        this.sink?.({ kind: 'speech-end', atMs: event.atMs, durationMs: event.durationMs });
        break;
      case 'turn-merged':
        if (this.openSegment) this.openSegment.mergedPauses += 1;
        this.sink?.({ kind: 'turn-merged', atMs: event.atMs, durationMs: event.durationMs });
        break;
      case 'backchannel':
        this.sink?.({ kind: 'backchannel', atMs: event.atMs, durationMs: event.durationMs });
        break;
      case 'max-turn':
        this.sink?.({ kind: 'max-turn', atMs: event.atMs, durationMs: event.durationMs });
        break;
      default:
        break;
    }
  }
}

export function createVadV17(options: VadV17Options = {}, sink?: VadV17EventSink): VadV17 {
  return new VadV17(options, sink);
}

export function vadV17Summary(vad: VadV17): string {
  return vad.summary();
}

export function vadV17Markdown(vad: VadV17): string {
  return vad.markdown();
}
