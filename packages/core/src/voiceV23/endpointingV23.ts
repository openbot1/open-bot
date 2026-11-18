/**
 * Endpointing v2 for voice v23 (v1.36, Team T5).
 *
 * v22 never decided when an utterance ends — it consumed
 * whatever transcript arrived. v23 adds the decision: a
 * voice-activity endpointing engine over 20 ms frames.
 *
 *   - an utterance starts after `minSpeechFrames` consecutive
 *     speech frames (short blips never start one);
 *   - it ends after `hangoverFrames` consecutive silence frames
 *     (a brief pause inside a sentence does not end it);
 *   - it is cut at `maxUtteranceFrames` so a monologue cannot
 *     run forever;
 *   - the energy threshold follows the measured noise floor
 *     (`setNoiseFloor`), so the same engine works in a quiet
 *     room and a noisy office without retuning by hand.
 *
 * Frames are booleans (speech / silence) or raw energies —
 * the engine never sees real audio. All counts are in frames;
 * `endFrame` is the number of frames consumed when the end
 * fired, which is what the v23 corpus asserts.
 */
import type { VoiceV23EndpointState } from './types';
import { clampV23, round4V23 } from './types';

export interface EndpointingV23Options {
  /** Consecutive speech frames needed to start an utterance (default 8 = 160 ms). */
  minSpeechFrames: number;
  /** Consecutive silence frames needed to end an utterance (default 15 = 300 ms). */
  hangoverFrames: number;
  /** Max speech frames in one utterance before a forced cut (default 500 = 10 s). */
  maxUtteranceFrames: number;
  /** Energy at/above this is speech (default 0.25). Overridden by setNoiseFloor. */
  energyThreshold: number;
  /** Noise-floor multiplier for the adaptive threshold (default 3). */
  noiseFloorFactor: number;
}

export function defaultEndpointingV23Options(): EndpointingV23Options {
  return {
    minSpeechFrames: 8,
    hangoverFrames: 15,
    maxUtteranceFrames: 500,
    energyThreshold: 0.25,
    noiseFloorFactor: 3,
  };
}

export function validateEndpointingV23Options(o: Partial<EndpointingV23Options>): string[] {
  const errors: string[] = [];
  const check = (name: keyof EndpointingV23Options, min: number, max: number): void => {
    const v = o[name];
    if (v !== undefined && !(v >= min && v <= max)) errors.push(`${name} must be ${min}..${max}`);
  };
  check('minSpeechFrames', 1, 100);
  check('hangoverFrames', 1, 100);
  check('maxUtteranceFrames', 10, 10000);
  check('energyThreshold', 0.01, 1);
  check('noiseFloorFactor', 1, 10);
  return errors;
}

export type VoiceV23EndpointEventKind = 'speech-start' | 'speech-end' | 'max-length-cut';

export interface VoiceV23EndpointEvent {
  kind: VoiceV23EndpointEventKind;
  /** Frames consumed when the event fired. */
  frame: number;
  atMs: number;
}

export interface VoiceV23EndpointStats {
  state: VoiceV23EndpointState;
  framesSeen: number;
  utterances: number;
  cutsByMaxLength: number;
  ignoredBlips: number;
  currentSpeechFrames: number;
  currentSilenceFrames: number;
  energyThreshold: number;
  noiseFloor: number | null;
  lastEndFrame: number | null;
}

export class EndpointingEngineV23 {
  private readonly opts: EndpointingV23Options;
  private state: VoiceV23EndpointState = 'idle';
  private framesSeen = 0;
  private speechRun = 0;
  private silenceRun = 0;
  private utteranceFrames = 0;
  private utteranceStartFrameValue: number | null = null;
  private utterances = 0;
  private cutsByMaxLength = 0;
  private ignoredBlips = 0;
  private noiseFloor: number | null = null;
  private lastEndFrameValue: number | null = null;
  private readonly events: VoiceV23EndpointEvent[] = [];

  constructor(opts: Partial<EndpointingV23Options> = {}) {
    const errors = validateEndpointingV23Options(opts);
    if (errors.length > 0) throw new Error(`Invalid EndpointingV23 options: ${errors.join('; ')}`);
    this.opts = { ...defaultEndpointingV23Options(), ...opts };
  }

  options(): EndpointingV23Options {
    return { ...this.opts };
  }

  currentState(): VoiceV23EndpointState {
    if (this.state === 'speech' && this.silenceRun > 0) return 'hangover';
    return this.state;
  }

  energyThreshold(): number {
    return this.opts.energyThreshold;
  }

  /**
   * Fit the threshold to a measured noise floor (RMS 0..1).
   * The threshold becomes floor * factor, clamped to 0.05..0.9,
   * so quiet rooms stay sensitive and noisy rooms stop
   * triggering on the room itself.
   */
  setNoiseFloor(rms: number): { noiseFloor: number; energyThreshold: number } {
    const floor = clampV23(rms, 0, 1);
    this.noiseFloor = floor;
    this.opts.energyThreshold = round4V23(clampV23(floor * this.opts.noiseFloorFactor, 0.05, 0.9));
    return { noiseFloor: floor, energyThreshold: this.opts.energyThreshold };
  }

  /** Feed one frame's speech flag. Returns events fired by this frame. */
  feedSpeech(isSpeech: boolean, atMs: number): VoiceV23EndpointEvent[] {
    this.framesSeen += 1;
    const fired: VoiceV23EndpointEvent[] = [];
    if (this.state === 'ended') return fired;
    if (isSpeech) {
      this.silenceRun = 0;
      this.speechRun += 1;
      if (this.state === 'idle') {
        if (this.speechRun >= this.opts.minSpeechFrames) {
          this.state = 'speech';
          this.utteranceFrames = this.speechRun;
          this.utteranceStartFrameValue = this.framesSeen - this.speechRun;
          const event: VoiceV23EndpointEvent = { kind: 'speech-start', frame: this.framesSeen, atMs };
          this.events.push(event);
          fired.push(event);
        }
      } else {
        this.utteranceFrames += 1;
      }
      if (this.state === 'speech' && this.utteranceFrames >= this.opts.maxUtteranceFrames) {
        this.state = 'ended';
        this.cutsByMaxLength += 1;
        this.utterances += 1;
        this.lastEndFrameValue = this.framesSeen;
        const event: VoiceV23EndpointEvent = { kind: 'max-length-cut', frame: this.framesSeen, atMs };
        this.events.push(event);
        fired.push(event);
      }
      return fired;
    }
    // Silence frame.
    if (this.state === 'idle' && this.speechRun > 0) {
      // A blip too short to start an utterance dies silently.
      this.ignoredBlips += 1;
    }
    this.speechRun = 0;
    if (this.state === 'idle') {
      return fired;
    }
    this.silenceRun += 1;
    if (this.silenceRun >= this.opts.hangoverFrames) {
      this.state = 'ended';
      this.utterances += 1;
      this.lastEndFrameValue = this.framesSeen;
      const event: VoiceV23EndpointEvent = { kind: 'speech-end', frame: this.framesSeen, atMs };
      this.events.push(event);
      fired.push(event);
    }
    return fired;
  }

  /** Feed one frame's raw energy (0..1); speech = energy >= threshold. */
  feedEnergy(energy: number, atMs: number): VoiceV23EndpointEvent[] {
    return this.feedSpeech(energy >= this.opts.energyThreshold, atMs);
  }

  /** Feed a whole boolean trace; returns the end frame (-1 when no utterance ended). */
  runTrace(frames: readonly boolean[], startAtMs = 0): number {
    for (let i = 0; i < frames.length; i += 1) {
      this.feedSpeech(frames[i], startAtMs + i * 20);
      if (this.state === 'ended') return this.framesSeen;
    }
    return -1;
  }

  /** Start a fresh utterance after the previous one ended. */
  nextUtterance(): void {
    if (this.state !== 'ended') return;
    this.state = 'idle';
    this.speechRun = 0;
    this.silenceRun = 0;
    this.utteranceFrames = 0;
    this.utteranceStartFrameValue = null;
  }

  eventsHistory(): VoiceV23EndpointEvent[] {
    return [...this.events];
  }

  utteranceStartFrame(): number | null {
    return this.utteranceStartFrameValue;
  }

  lastEndFrame(): number | null {
    return this.lastEndFrameValue;
  }

  stats(): VoiceV23EndpointStats {
    return {
      state: this.currentState(),
      framesSeen: this.framesSeen,
      utterances: this.utterances,
      cutsByMaxLength: this.cutsByMaxLength,
      ignoredBlips: this.ignoredBlips,
      currentSpeechFrames: this.utteranceFrames,
      currentSilenceFrames: this.silenceRun,
      energyThreshold: this.opts.energyThreshold,
      noiseFloor: this.noiseFloor,
      lastEndFrame: this.lastEndFrameValue,
    };
  }

  summary(): string {
    return `endpointing: state ${this.currentState()}, ${this.utterances} utterances (${this.cutsByMaxLength} cut by max length), threshold ${this.opts.energyThreshold}`;
  }

  reset(): void {
    this.state = 'idle';
    this.framesSeen = 0;
    this.speechRun = 0;
    this.silenceRun = 0;
    this.utteranceFrames = 0;
    this.utteranceStartFrameValue = null;
    this.utterances = 0;
    this.cutsByMaxLength = 0;
    this.ignoredBlips = 0;
    this.noiseFloor = null;
    this.lastEndFrameValue = null;
    this.events.length = 0;
  }
}
