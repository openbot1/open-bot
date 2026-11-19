/**
 * Voice-activity-detection hook v28 (v1.41, Team T5).
 *
 * A small, tunable VAD hook the realtime session wires into
 * turn-taking. The caller feeds energy frames (one per
 * ~50 ms, `atMs` virtual); the hook classifies each frame,
 * learns the background noise floor when `adaptive` is on,
 * rejects short bursts as noise, and fires three callbacks:
 *
 *   - onSpeechStart(atMs, frame) — sustained speech began
 *     (the burst already passed `minSpeechMs`);
 *   - onSpeechEnd(atMs, segment) — speech ended (level
 *     dropped + hangover elapsed);
 *   - onSilenceTimeout(atMs, silenceMs) — silence after
 *     speech lasted `silenceTimeoutMs`, i.e. the turn is over.
 *
 * Differences from the v27 VadTuner: v27 tunes a config and
 * manages turns; this hook owns the *live* frame-by-frame
 * state machine and the callback surface, including the
 * pending-speech buffer (frames are only confirmed as speech
 * after `minSpeechMs` of sustained energy, so a cough never
 * fires onSpeechStart), the hangover (speech is kept alive
 * briefly after the level drops, so pauses inside a sentence
 * do not end the turn), and keyword end detection
 * (`endKeyword` in the frame text ends the turn at once).
 * All clocks virtual, all frames caller-supplied energy —
 * no mic, no audio processing.
 */

import {
  clampV28,
  defaultVadHookConfigV28,
  effectiveThresholdV28,
  round4V28,
  type VoiceV28SpeechSegment,
  type VoiceV28TurnEndReason,
  type VoiceV28VadFrame,
  type VoiceV28VadHookConfig,
  type VoiceV28VadHookFrameResult,
} from './types';

export interface VadHookV28Options {
  config?: Partial<VoiceV28VadHookConfig>;
  /** Frame length the caller feeds (ms) — used to advance speech/silence clocks. */
  frameMs?: number;
  /** Max speech segments kept in history. */
  maxSegments?: number;
}

export interface VadHookV28Callbacks {
  onSpeechStart?: (atMs: number, frame: VoiceV28VadFrame) => void;
  onSpeechEnd?: (atMs: number, segment: VoiceV28SpeechSegment) => void;
  onSilenceTimeout?: (atMs: number, silenceMs: number) => void;
}

export interface VoiceV28VadHookStats {
  frames: number;
  speechFrames: number;
  silenceFrames: number;
  noiseRejections: number;
  speechStarts: number;
  speechEnds: number;
  silenceTimeouts: number;
  keywordEnds: number;
  segments: number;
  noiseFloor: number;
  threshold: number;
  speaking: boolean;
  speechMs: number;
  silenceMs: number;
}

export const VOICE_V28_VAD_HOOK_PRESETS = {
  sensitive: {
    threshold: 0.1,
    silenceTimeoutMs: 1000,
    hangoverMs: 200,
    minSpeechMs: 150,
  },
  balanced: {
    threshold: 0.18,
    silenceTimeoutMs: 800,
    hangoverMs: 150,
    minSpeechMs: 220,
  },
  strict: {
    threshold: 0.32,
    silenceTimeoutMs: 500,
    hangoverMs: 100,
    minSpeechMs: 350,
  },
} as const;

export type VoiceV28VadHookPresetName = keyof typeof VOICE_V28_VAD_HOOK_PRESETS;

/** Validate a VAD hook config (throws on the first problem). */
export function validateVadHookConfigV28(config: VoiceV28VadHookConfig): void {
  if (!Number.isFinite(config.threshold) || config.threshold <= 0 || config.threshold >= 1) {
    throw new Error('vad threshold must be in (0, 1)');
  }
  if (!Number.isFinite(config.silenceTimeoutMs) || config.silenceTimeoutMs < 100) {
    throw new Error('vad silenceTimeoutMs must be >= 100');
  }
  if (!Number.isFinite(config.hangoverMs) || config.hangoverMs < 0) {
    throw new Error('vad hangoverMs must be >= 0');
  }
  if (!Number.isFinite(config.minSpeechMs) || config.minSpeechMs < 0) {
    throw new Error('vad minSpeechMs must be >= 0');
  }
  if (!Number.isFinite(config.noiseFloor) || config.noiseFloor < 0 || config.noiseFloor >= 1) {
    throw new Error('vad noiseFloor must be in [0, 1)');
  }
  if (config.noiseFloor >= config.threshold) {
    throw new Error('vad noiseFloor must be below threshold');
  }
}

export function defaultVadHookV28Options(): VadHookV28Options {
  return { config: defaultVadHookConfigV28(), frameMs: 50, maxSegments: 500 };
}

export function createVadHookV28(
  opts: VadHookV28Options = {},
  callbacks: VadHookV28Callbacks = {},
): VadHookV28 {
  return new VadHookV28(opts, callbacks);
}

export class VadHookV28 {
  readonly config: VoiceV28VadHookConfig;
  private readonly frameMs: number;
  private readonly maxSegments: number;
  private readonly callbacks: VadHookV28Callbacks;
  private noiseFloor: number;
  private speaking = false;
  /** Speech that has not yet passed minSpeechMs (pending confirmation). */
  private pendingSpeechMs = 0;
  private pendingPeakEnergy = 0;
  private pendingStartedAtMs: number | null = null;
  private pendingFrames = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private hangoverRemainingMs = 0;
  private currentSegment: VoiceV28SpeechSegment | null = null;
  private segmentCounter = 0;
  private segmentHistory: VoiceV28SpeechSegment[] = [];
  private frames = 0;
  private speechFrames = 0;
  private silenceFrames = 0;
  private noiseRejections = 0;
  private speechStarts = 0;
  private speechEnds = 0;
  private silenceTimeouts = 0;
  private keywordEnds = 0;
  private lastFrameAtMs: number | null = null;
  private silenceTimeoutFiredForSegment = false;

  constructor(opts: VadHookV28Options = {}, callbacks: VadHookV28Callbacks = {}) {
    const merged: VoiceV28VadHookConfig = {
      ...defaultVadHookConfigV28(),
      ...(opts.config ?? {}),
    };
    validateVadHookConfigV28(merged);
    this.config = merged;
    this.frameMs = opts.frameMs ?? 50;
    if (!Number.isFinite(this.frameMs) || this.frameMs <= 0) {
      throw new Error('vad frameMs must be a positive finite number');
    }
    this.maxSegments = Math.max(1, opts.maxSegments ?? 500);
    this.callbacks = callbacks;
    this.noiseFloor = merged.noiseFloor;
  }

  /** Apply a named preset (keeps noiseFloor / adaptive / endKeyword). */
  applyPreset(name: VoiceV28VadHookPresetName): VoiceV28VadHookConfig {
    const preset = VOICE_V28_VAD_HOOK_PRESETS[name];
    if (!preset) throw new Error(`unknown VAD preset: ${name}`);
    this.config.threshold = preset.threshold;
    this.config.silenceTimeoutMs = preset.silenceTimeoutMs;
    this.config.hangoverMs = preset.hangoverMs;
    this.config.minSpeechMs = preset.minSpeechMs;
    return { ...this.config };
  }

  /** Replace part of the config (validated). */
  updateConfig(patch: Partial<VoiceV28VadHookConfig>): VoiceV28VadHookConfig {
    const next: VoiceV28VadHookConfig = { ...this.config, ...patch };
    validateVadHookConfigV28(next);
    Object.assign(this.config, next);
    return { ...this.config };
  }

  /** Effective threshold in force right now. */
  get threshold(): number {
    return effectiveThresholdV28(this.config);
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get currentSpeechMs(): number {
    return this.speechMs;
  }

  get currentSilenceMs(): number {
    return this.silenceMs;
  }

  /** Feed one frame; returns the classification + what fired. */
  feed(frame: VoiceV28VadFrame): VoiceV28VadHookFrameResult {
    if (!frame || typeof frame !== 'object') throw new Error('frame must be an object');
    if (!Number.isFinite(frame.atMs) || frame.atMs < 0) {
      throw new Error('frame.atMs must be a non-negative finite number');
    }
    if (!Number.isFinite(frame.energy) || frame.energy < 0 || frame.energy > 1) {
      throw new Error('frame.energy must be in [0, 1]');
    }
    if (this.lastFrameAtMs !== null && frame.atMs < this.lastFrameAtMs) {
      throw new Error('frame.atMs must not go backwards');
    }
    this.lastFrameAtMs = frame.atMs;
    this.frames += 1;

    const threshold = this.threshold;
    const callerSaysSpeech = frame.isSpeech;
    const isSpeechEnergy = callerSaysSpeech !== undefined ? callerSaysSpeech : frame.energy >= threshold;

    // Adaptive noise floor: learn only from frames that are clearly silent.
    if (this.config.adaptive && !isSpeechEnergy && frame.energy < threshold * 0.5) {
      this.noiseFloor = round4V28(
        this.noiseFloor + 0.08 * (frame.energy - this.noiseFloor),
      );
      if (this.noiseFloor >= this.config.threshold) {
        this.noiseFloor = round4V28(this.config.threshold - 0.02);
      }
    }

    let speechStarted = false;
    let speechEnded = false;
    let silenceTimedOut = false;
    let turnEnded = false;
    let endReason: VoiceV28TurnEndReason | null = null;
    let noiseRejected = false;
    let kind: 'speech' | 'silence' | 'noise' = 'silence';

    // Keyword end: an explicit end word ends the turn at once, whatever the energy.
    const text = (frame.text ?? '').toLowerCase();
    const keywordHit =
      this.config.endKeyword !== null &&
      this.config.endKeyword !== '' &&
      text.includes(this.config.endKeyword.toLowerCase());

    if (isSpeechEnergy) {
      this.silenceMs = 0;
      this.silenceTimeoutFiredForSegment = false;
      this.hangoverRemainingMs = this.config.hangoverMs;
      if (this.speaking) {
        this.speechMs += this.frameMs;
        this.speechFrames += 1;
        kind = 'speech';
        if (this.currentSegment) {
          this.currentSegment.peakEnergy = Math.max(this.currentSegment.peakEnergy, frame.energy);
          this.currentSegment.frames += 1;
        }
      } else {
        // Pending: accumulate until minSpeechMs, then confirm as speech.
        if (this.pendingStartedAtMs === null) {
          this.pendingStartedAtMs = frame.atMs;
          this.pendingPeakEnergy = frame.energy;
          this.pendingFrames = 0;
        }
        this.pendingSpeechMs += this.frameMs;
        this.pendingPeakEnergy = Math.max(this.pendingPeakEnergy, frame.energy);
        this.pendingFrames += 1;
        if (this.pendingSpeechMs >= this.config.minSpeechMs) {
          this.speaking = true;
          this.speechMs = this.pendingSpeechMs;
          this.speechFrames += this.pendingFrames;
          this.speechStarts += 1;
          speechStarted = true;
          kind = 'speech';
          this.segmentCounter += 1;
          this.currentSegment = {
            id: `seg28-${this.segmentCounter}`,
            startedAtMs: this.pendingStartedAtMs,
            endedAtMs: null,
            durationMs: null,
            peakEnergy: this.pendingPeakEnergy,
            frames: this.pendingFrames,
            rejectedAsNoise: false,
            endReason: null,
          };
          this.callbacks.onSpeechStart?.(frame.atMs, frame);
          this.pendingSpeechMs = 0;
          this.pendingFrames = 0;
          this.pendingStartedAtMs = null;
        } else {
          kind = 'speech';
        }
      }
    } else {
      // Silence / low-energy frame.
      this.silenceFrames += 1;
      if (this.speaking) {
        if (this.hangoverRemainingMs > 0) {
          // Hangover: still speech, the level just dipped.
          this.hangoverRemainingMs = Math.max(0, this.hangoverRemainingMs - this.frameMs);
          this.speechMs += this.frameMs;
          kind = 'speech';
        } else {
          // Real silence after speech: count it, and end the
          // segment (and the turn) only when the silence
          // timeout fires — a short pause inside a sentence
          // must not end the segment.
          this.silenceMs += this.frameMs;
          kind = 'silence';
          if (this.silenceMs >= this.config.silenceTimeoutMs && !this.silenceTimeoutFiredForSegment) {
            this.silenceTimeoutFiredForSegment = true;
            this.silenceTimeouts += 1;
            silenceTimedOut = true;
            turnEnded = true;
            endReason = keywordHit ? 'keyword' : 'silence';
            speechEnded = true;
            this.finishSegment(frame.atMs, endReason);
            this.callbacks.onSilenceTimeout?.(frame.atMs, this.silenceMs);
            this.callbacks.onSpeechEnd?.(frame.atMs, this.segmentHistory[this.segmentHistory.length - 1]);
          }
        }
      } else if (this.pendingStartedAtMs !== null) {
        // A pending burst died before minSpeechMs: noise.
        this.noiseRejections += 1;
        noiseRejected = true;
        kind = 'noise';
        this.segmentCounter += 1;
        this.segmentHistory.push({
          id: `seg28-${this.segmentCounter}`,
          startedAtMs: this.pendingStartedAtMs,
          endedAtMs: frame.atMs,
          durationMs: Math.max(0, frame.atMs - this.pendingStartedAtMs),
          peakEnergy: this.pendingPeakEnergy,
          frames: this.pendingFrames,
          rejectedAsNoise: true,
          endReason: null,
        });
        if (this.segmentHistory.length > this.maxSegments) this.segmentHistory.shift();
        this.pendingSpeechMs = 0;
        this.pendingFrames = 0;
        this.pendingStartedAtMs = null;
      } else {
        this.silenceMs += this.frameMs;
        kind = 'silence';
      }
    }

    // Keyword end beats everything when we are speaking.
    if (keywordHit && this.speaking) {
      this.keywordEnds += 1;
      if (!turnEnded) {
        turnEnded = true;
        endReason = 'keyword';
      }
      if (!speechEnded) {
        speechEnded = true;
        this.finishSegment(frame.atMs, 'keyword');
        this.callbacks.onSpeechEnd?.(frame.atMs, this.segmentHistory[this.segmentHistory.length - 1]);
      }
    }

    return {
      kind,
      threshold,
      noiseFloor: this.noiseFloor,
      speechMs: this.speechMs,
      silenceMs: this.silenceMs,
      speechStarted,
      speechEnded,
      silenceTimedOut,
      turnEnded,
      endReason,
      noiseRejected,
    };
  }

  /** Feed many frames in order; returns one result per frame. */
  feedMany(frames: readonly VoiceV28VadFrame[]): VoiceV28VadHookFrameResult[] {
    return frames.map((f) => this.feed(f));
  }

  /** Calibrate from raw samples: suggest threshold + noise floor. */
  calibrate(samples: readonly number[]): { threshold: number; noiseFloor: number; suggestedPreset: VoiceV28VadHookPresetName } {
    if (samples.length === 0) throw new Error('calibrate needs at least one sample');
    for (const s of samples) {
      if (!Number.isFinite(s) || s < 0 || s > 1) throw new Error('calibrate samples must be in [0, 1]');
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    const noiseFloor = round4V28(clampV28(median, 0, 0.5));
    const threshold = round4V28(clampV28(Math.max(p90 * 0.6, noiseFloor + 0.08), 0.05, 0.9));
    const suggestedPreset: VoiceV28VadHookPresetName =
      threshold < 0.14 ? 'sensitive' : threshold > 0.26 ? 'strict' : 'balanced';
    return { threshold, noiseFloor, suggestedPreset };
  }

  /** Reset all live state (keeps the config). */
  reset(): void {
    this.speaking = false;
    this.pendingSpeechMs = 0;
    this.pendingPeakEnergy = 0;
    this.pendingStartedAtMs = null;
    this.pendingFrames = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.hangoverRemainingMs = 0;
    this.currentSegment = null;
    this.lastFrameAtMs = null;
    this.silenceTimeoutFiredForSegment = false;
  }

  segments(): VoiceV28SpeechSegment[] {
    return [...this.segmentHistory];
  }

  stats(): VoiceV28VadHookStats {
    return {
      frames: this.frames,
      speechFrames: this.speechFrames,
      silenceFrames: this.silenceFrames,
      noiseRejections: this.noiseRejections,
      speechStarts: this.speechStarts,
      speechEnds: this.speechEnds,
      silenceTimeouts: this.silenceTimeouts,
      keywordEnds: this.keywordEnds,
      segments: this.segmentHistory.length,
      noiseFloor: this.noiseFloor,
      threshold: this.threshold,
      speaking: this.speaking,
      speechMs: this.speechMs,
      silenceMs: this.silenceMs,
    };
  }

  private finishSegment(atMs: number, reason: VoiceV28TurnEndReason): void {
    if (!this.currentSegment) {
      this.speaking = false;
      this.speechMs = 0;
      this.silenceMs = 0;
      return;
    }
    const seg = this.currentSegment;
    seg.endedAtMs = atMs;
    seg.durationMs = Math.max(0, atMs - seg.startedAtMs);
    seg.endReason = reason;
    this.segmentHistory.push(seg);
    if (this.segmentHistory.length > this.maxSegments) this.segmentHistory.shift();
    this.currentSegment = null;
    this.speaking = false;
    this.speechEnds += 1;
    this.speechMs = 0;
    // Keep silenceMs: the caller is mid-silence; the timeout
    // counts from when speech actually stopped.
  }
}
