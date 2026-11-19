/**
 * Audio turn detector v30 (v1.44, Team T4).
 *
 * What v29 got wrong and v30 fixes:
 *
 *   - One fixed threshold chattered at the boundary. v30 uses
 *     dual thresholds (high to open, low to sustain): once a
 *     turn is open, a dip below the high threshold no longer
 *     ends it — only a dip below the low threshold counts as
 *     silence. The gap is the hysteresis band.
 *   - A short noise burst opened a turn that was then dropped.
 *     v30 holds speech in a pre-turn confirmation buffer:
 *     energy must stay above the low threshold for
 *     `confirmMs` before the turn officially opens. Bursts
 *     that die before confirmation are counted as noise and
 *     never open a turn at all.
 *   - The silence timeout never adapted. v30 learns it from
 *     the user's recent turn cadence: a user whose turns run
 *     long gets a longer timeout (mid-thought pauses), a fast
 *     speaker gets a shorter one. Bounded to [400, 1500] ms.
 *   - A single loud frame (door slam, mic bump) could open a
 *     turn. v30 rejects single-frame spikes: a frame at or
 *     above `spikeThreshold` that follows silence is ignored
 *     unless the next frame sustains the energy.
 *   - v29 reported no quality signal. v30 scores every turn
 *     0..1 from duration, peak energy and speech stability,
 *     so the session can distrust (or the barge-in engine can
 *     ignore) low-confidence turns.
 *   - Agent audio leaking into the mic looked like user
 *     speech. Frames flagged `agentSpeaking` are echo: they
 *     never open or sustain a turn, and a turn that overlaps
 *     agent audio is marked `echoSuspect`.
 *
 * All clocks virtual (the caller passes `atMs`); no audio is
 * recorded, no mic is opened, frames are energy numbers.
 */

import {
  VOICE_V30_TURN_ADAPTIVE_SILENCE_MAX_MS,
  VOICE_V30_TURN_ADAPTIVE_SILENCE_MIN_MS,
  VOICE_V30_TURN_FRAME_MS_DEFAULT,
  VOICE_V30_TURN_NOISE_FLOOR_LEARN_RATE,
  clampV30,
  defaultTurnDetectorConfigV30,
  round4V30,
  validateTurnDetectorConfigV30,
  type VoiceV30AudioFrame,
  type VoiceV30Turn,
  type VoiceV30TurnDetectorConfig,
  type VoiceV30TurnEndReason,
  type VoiceV30TurnFrameResult,
} from './types';

export interface AudioTurnDetectorV30Options {
  config?: Partial<VoiceV30TurnDetectorConfig>;
  /** Max turns kept in history (oldest dropped first). */
  maxTurns?: number;
  /** Called when a turn starts (after confirmation). */
  onTurnStart?: (turn: VoiceV30Turn) => void;
  /** Called when a turn ends. */
  onTurnEnd?: (turn: VoiceV30Turn) => void;
  /** Called when a backchannel burst is detected. */
  onBackchannel?: (atMs: number, durationMs: number, peakEnergy: number) => void;
  /** Called when a single-frame spike is rejected. */
  onSpike?: (atMs: number, energy: number) => void;
}

export interface VoiceV30TurnDetectorStats {
  turns: number;
  backchannels: number;
  noiseRejected: number;
  spikesRejected: number;
  lowConfidenceTurns: number;
  echoFrames: number;
  currentTurnMs: number;
  speaking: boolean;
  confirming: boolean;
  noiseFloor: number;
  highThreshold: number;
  lowThreshold: number;
  effectiveSilenceTimeoutMs: number;
  avgTurnMs: number;
  longestTurnMs: number;
  avgConfidence: number;
}

/** Preset names for the turn detector. */
export type VoiceV30TurnPresetName = 'sensitive' | 'balanced' | 'relaxed' | 'push-to-talk' | 'noisy-room';

/** Named presets: sensitivity is folded into thresholds / timeouts. */
export const VOICE_V30_TURN_PRESETS: Record<
  VoiceV30TurnPresetName,
  Partial<VoiceV30TurnDetectorConfig>
> = {
  sensitive: {
    highThreshold: 0.16,
    lowThreshold: 0.08,
    silenceTimeoutMs: 500,
    hangoverMs: 100,
    confirmMs: 100,
    minSpeechMs: 150,
    backchannelMaxMs: 500,
    backchannelMaxEnergy: 0.3,
  },
  balanced: {},
  relaxed: {
    highThreshold: 0.3,
    lowThreshold: 0.16,
    silenceTimeoutMs: 1000,
    hangoverMs: 200,
    confirmMs: 200,
    minSpeechMs: 300,
    backchannelMaxMs: 800,
    backchannelMaxEnergy: 0.4,
  },
  'push-to-talk': {
    highThreshold: 0.12,
    lowThreshold: 0.06,
    silenceTimeoutMs: 300,
    hangoverMs: 50,
    confirmMs: 50,
    minSpeechMs: 100,
    backchannelMaxMs: 0,
    backchannelMaxEnergy: 0,
    endKeyword: null,
    adaptiveSilence: false,
  },
  'noisy-room': {
    highThreshold: 0.35,
    lowThreshold: 0.2,
    silenceTimeoutMs: 900,
    hangoverMs: 150,
    confirmMs: 250,
    minSpeechMs: 300,
    backchannelMaxMs: 500,
    backchannelMaxEnergy: 0.3,
    spikeThreshold: 0.9,
  },
};

export function defaultAudioTurnDetectorV30Options(): AudioTurnDetectorV30Options {
  return { config: defaultTurnDetectorConfigV30(), maxTurns: 1000 };
}

export class AudioTurnDetectorV30 {
  private config: VoiceV30TurnDetectorConfig;
  private readonly maxTurns: number;
  private readonly onTurnStart?: (turn: VoiceV30Turn) => void;
  private readonly onTurnEnd?: (turn: VoiceV30Turn) => void;
  private readonly onBackchannel?: (atMs: number, durationMs: number, peakEnergy: number) => void;
  private readonly onSpike?: (atMs: number, energy: number) => void;

  private noiseFloor: number;
  /** A turn is open (confirmed). */
  private speaking = false;
  /** Speech is being confirmed (pre-turn buffer). */
  private confirming = false;
  private confirmStartMs: number | null = null;
  private confirmPeakEnergy = 0;
  private confirmFrames = 0;
  private confirmTextParts: string[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private hangoverLeftMs = 0;
  private turnStartMs: number | null = null;
  private turnPeakEnergy = 0;
  private turnFrames = 0;
  private turnSpeechFrames = 0;
  private turnTextParts: string[] = [];
  private turnEchoSuspect = false;
  private turnCount = 0;
  private backchannels = 0;
  private noiseRejected = 0;
  private spikesRejected = 0;
  private echoFrames = 0;
  private lastFrameAtMs: number | null = null;
  private lastFrameEnergy = 0;
  private readonly turns: VoiceV30Turn[] = [];
  /** Recent turn durations (ms) — drives the adaptive silence timeout. */
  private readonly recentDurations: number[] = [];

  constructor(opts: AudioTurnDetectorV30Options = {}) {
    const merged: VoiceV30TurnDetectorConfig = {
      ...defaultTurnDetectorConfigV30(),
      ...(opts.config ?? {}),
    };
    const errors = validateTurnDetectorConfigV30(merged);
    if (errors.length > 0) throw new Error(`Invalid turn detector config: ${errors.join('; ')}`);
    this.config = merged;
    this.maxTurns = opts.maxTurns ?? 1000;
    this.onTurnStart = opts.onTurnStart;
    this.onTurnEnd = opts.onTurnEnd;
    this.onBackchannel = opts.onBackchannel;
    this.onSpike = opts.onSpike;
    this.noiseFloor = merged.noiseFloor;
  }

  getConfig(): VoiceV30TurnDetectorConfig {
    return { ...this.config };
  }

  /** Replace the config (validated); keeps history and noise floor. */
  setConfig(patch: Partial<VoiceV30TurnDetectorConfig>): VoiceV30TurnDetectorConfig {
    const merged = { ...this.config, ...patch };
    const errors = validateTurnDetectorConfigV30(merged);
    if (errors.length > 0) throw new Error(`Invalid turn detector config: ${errors.join('; ')}`);
    this.config = merged;
    return this.getConfig();
  }

  /** Apply a named preset on top of the current config. */
  applyPreset(name: VoiceV30TurnPresetName): VoiceV30TurnDetectorConfig {
    const preset = VOICE_V30_TURN_PRESETS[name];
    if (!preset) throw new Error(`Unknown turn preset: ${name}`);
    return this.setConfig(preset);
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  isConfirming(): boolean {
    return this.confirming;
  }

  currentTurnMs(atMs: number): number {
    if (this.turnStartMs === null) return 0;
    return Math.max(0, atMs - this.turnStartMs);
  }

  turnsSoFar(): VoiceV30Turn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  lastTurn(): VoiceV30Turn | null {
    const last = this.turns[this.turns.length - 1];
    return last ? { ...last } : null;
  }

  /**
   * Silence timeout in effect right now. Learned from the
   * user's recent turn cadence: long turns stretch it (the
   * user pauses mid-thought), short turns shrink it (a fast
   * speaker wants fast turn ends). Bounded to [400, 1500] ms.
   */
  effectiveSilenceTimeoutMs(): number {
    if (!this.config.adaptiveSilence || this.recentDurations.length === 0) {
      return this.config.silenceTimeoutMs;
    }
    const avg = this.recentDurations.reduce((a, b) => a + b, 0) / this.recentDurations.length;
    const factor = clampV30(avg / 3000, 0.6, 1.8);
    return Math.round(
      clampV30(
        this.config.silenceTimeoutMs * factor,
        VOICE_V30_TURN_ADAPTIVE_SILENCE_MIN_MS,
        VOICE_V30_TURN_ADAPTIVE_SILENCE_MAX_MS,
      ),
    );
  }

  /** Feed one frame; returns what the detector decided for it. */
  feed(frame: VoiceV30AudioFrame): VoiceV30TurnFrameResult {
    const atMs = frame.atMs;
    const dt = this.frameDeltaMs(atMs);
    const prevEnergy = this.lastFrameEnergy;
    this.lastFrameAtMs = atMs;
    this.lastFrameEnergy = frame.energy;

    // Echo guard: agent audio overlapping the mic is never user
    // speech. It neither opens, sustains nor ends a turn.
    if (frame.agentSpeaking) {
      this.echoFrames += 1;
      if (this.speaking) this.turnEchoSuspect = true;
      return {
        kind: 'echo',
        highThreshold: this.config.highThreshold,
        lowThreshold: this.config.lowThreshold,
        noiseFloor: this.noiseFloor,
        speechMs: this.speechMs,
        silenceMs: this.silenceMs,
        turnStarted: false,
        turnEnded: false,
        endReason: null,
        backchannel: false,
        noiseRejected: false,
        echoSuppressed: true,
        confidence: this.currentConfidence(),
      };
    }

    // Single-frame spike rejection: a very loud frame straight
    // out of silence (door slam, mic bump) is dropped unless
    // the *next* frame sustains the energy.
    const isSpike =
      frame.energy >= this.config.spikeThreshold &&
      prevEnergy < this.config.lowThreshold &&
      !this.speaking &&
      !this.confirming;
    if (isSpike) {
      this.spikesRejected += 1;
      this.onSpike?.(atMs, frame.energy);
      return {
        kind: 'noise',
        highThreshold: this.config.highThreshold,
        lowThreshold: this.config.lowThreshold,
        noiseFloor: this.noiseFloor,
        speechMs: this.speechMs,
        silenceMs: this.silenceMs,
        turnStarted: false,
        turnEnded: false,
        endReason: null,
        backchannel: false,
        noiseRejected: true,
        echoSuppressed: false,
        confidence: 0,
      };
    }

    // Hysteresis: the high threshold opens, the low sustains.
    const aboveHigh = frame.isSpeech ?? frame.energy >= this.config.highThreshold;
    const aboveLow = frame.isSpeech ?? frame.energy >= this.config.lowThreshold;
    const isSpeech = this.speaking ? aboveLow : aboveHigh;

    if (!isSpeech && this.config.adaptive) {
      // Learn the floor from silence: slow drift toward observed energy.
      this.noiseFloor = round4V30(
        clampV30(
          this.noiseFloor +
            (frame.energy - this.noiseFloor) * VOICE_V30_TURN_NOISE_FLOOR_LEARN_RATE,
          0,
          0.9,
        ),
      );
    }

    let turnStarted = false;
    let turnEnded = false;
    let endReason: VoiceV30TurnEndReason | null = null;
    let backchannel = false;
    let noiseRejected = false;
    let kind: VoiceV30TurnFrameResult['kind'] = 'silence';

    if (isSpeech) {
      this.silenceMs = 0;
      this.speechMs += dt;
      this.hangoverLeftMs = this.config.hangoverMs;

      if (!this.speaking && !this.confirming) {
        // Enter the confirmation buffer; the turn does not
        // exist yet. A burst that dies here is noise, not a
        // turn that must be dropped later.
        this.confirming = true;
        this.confirmStartMs = atMs;
        this.confirmPeakEnergy = frame.energy;
        this.confirmFrames = 0;
        this.confirmTextParts = [];
        kind = 'confirming';
      }
      if (this.confirming) {
        this.confirmPeakEnergy = Math.max(this.confirmPeakEnergy, frame.energy);
        this.confirmFrames += 1;
        if (frame.text) this.confirmTextParts.push(frame.text);
        kind = 'confirming';
        const confirmedMs = atMs - (this.confirmStartMs ?? atMs);
        if (confirmedMs >= this.config.confirmMs || this.config.confirmMs === 0) {
          // Confirmed: the turn officially opens, backdated to
          // the first speech frame.
          this.confirming = false;
          this.speaking = true;
          this.turnStartMs = this.confirmStartMs;
          this.turnPeakEnergy = this.confirmPeakEnergy;
          this.turnFrames = this.confirmFrames;
          this.turnSpeechFrames = this.confirmFrames;
          this.turnTextParts = [...this.confirmTextParts];
          this.turnEchoSuspect = false;
          turnStarted = true;
          this.onTurnStart?.({
            id: `turn-${this.turnCount + 1}`,
            index: this.turnCount,
            startedAtMs: this.confirmStartMs ?? atMs,
            endedAtMs: atMs,
            durationMs: 0,
            peakEnergy: round4V30(frame.energy),
            frames: 0,
            endReason: 'silence',
            backchannel: false,
            text: '',
            confidence: 0,
            echoSuspect: false,
            silenceTimeoutMs: this.effectiveSilenceTimeoutMs(),
          });
          kind = 'speech';
        }
      } else {
        // Confirmed turn in progress.
        this.turnPeakEnergy = Math.max(this.turnPeakEnergy, frame.energy);
        this.turnFrames += 1;
        this.turnSpeechFrames += 1;
        if (frame.text) this.turnTextParts.push(frame.text);
        kind = 'speech';

        // Keyword ends the turn immediately.
        if (this.config.endKeyword && frame.text) {
          const hit = frame.text.toLowerCase().includes(this.config.endKeyword.toLowerCase());
          if (hit) {
            const ended = this.endTurn(atMs, 'keyword');
            turnEnded = ended !== null;
            endReason = turnEnded ? 'keyword' : null;
            backchannel = ended?.backchannel ?? false;
          }
        }
        // Forced end at max turn length.
        if (!turnEnded && this.config.maxTurnMs > 0 && this.turnStartMs !== null && atMs - this.turnStartMs >= this.config.maxTurnMs) {
          const ended = this.endTurn(atMs, 'max-duration');
          turnEnded = ended !== null;
          endReason = turnEnded ? 'max-duration' : null;
          backchannel = ended?.backchannel ?? false;
        }
      }
    } else {
      // Silence (or noise below the low threshold).
      if (this.confirming) {
        // The burst died before confirmation: noise, not a turn.
        this.noiseRejected += 1;
        noiseRejected = true;
        this.confirming = false;
        this.confirmStartMs = null;
        this.confirmPeakEnergy = 0;
        this.confirmFrames = 0;
        this.confirmTextParts = [];
        this.speechMs = 0;
        kind = 'noise';
      } else if (this.speaking) {
        // Hangover keeps the turn alive briefly.
        if (this.hangoverLeftMs > 0) {
          this.hangoverLeftMs = Math.max(0, this.hangoverLeftMs - dt);
          kind = 'speech';
        } else {
          this.silenceMs += dt;
          this.speechMs = 0;
          kind = 'silence';
          if (this.silenceMs >= this.effectiveSilenceTimeoutMs()) {
            const ended = this.endTurn(atMs, 'silence');
            turnEnded = ended !== null;
            endReason = turnEnded ? 'silence' : null;
            backchannel = ended?.backchannel ?? false;
          }
        }
      } else {
        this.silenceMs += dt;
        this.speechMs = 0;
        kind = 'silence';
      }
    }

    return {
      kind: backchannel ? 'backchannel' : noiseRejected ? 'noise' : kind,
      highThreshold: this.config.highThreshold,
      lowThreshold: this.config.lowThreshold,
      noiseFloor: this.noiseFloor,
      speechMs: this.speechMs,
      silenceMs: this.silenceMs,
      turnStarted,
      turnEnded,
      endReason,
      backchannel,
      noiseRejected,
      echoSuppressed: false,
      confidence: this.currentConfidence(),
    };
  }

  /** End the current turn now (explicit end, e.g. user pressed stop). */
  endNow(atMs: number, reason: VoiceV30TurnEndReason = 'explicit'): VoiceV30Turn | null {
    if (!this.speaking || this.turnStartMs === null) {
      // A turn still in confirmation is abandoned as noise.
      if (this.confirming) {
        this.noiseRejected += 1;
        this.confirming = false;
        this.confirmStartMs = null;
        this.confirmTextParts = [];
      }
      return null;
    }
    return this.endTurn(atMs, reason);
  }

  /** Abandon the current turn without recording it (false start). */
  abandon(atMs: number): boolean {
    if ((!this.speaking && !this.confirming) || (this.speaking && this.turnStartMs === null)) return false;
    this.speaking = false;
    this.confirming = false;
    this.confirmStartMs = null;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.turnStartMs = null;
    this.turnTextParts = [];
    this.confirmTextParts = [];
    this.lastFrameAtMs = atMs;
    return true;
  }

  stats(): VoiceV30TurnDetectorStats {
    const realTurns = this.turns.filter((t) => !t.backchannel);
    const durations = realTurns.map((t) => t.durationMs);
    const confidences = realTurns.map((t) => t.confidence);
    return {
      turns: realTurns.length,
      backchannels: this.backchannels,
      noiseRejected: this.noiseRejected,
      spikesRejected: this.spikesRejected,
      lowConfidenceTurns: realTurns.filter((t) => t.confidence < this.config.minConfidence).length,
      echoFrames: this.echoFrames,
      currentTurnMs:
        this.turnStartMs === null || this.lastFrameAtMs === null
          ? 0
          : Math.max(0, this.lastFrameAtMs - this.turnStartMs),
      speaking: this.speaking,
      confirming: this.confirming,
      noiseFloor: this.noiseFloor,
      highThreshold: this.config.highThreshold,
      lowThreshold: this.config.lowThreshold,
      effectiveSilenceTimeoutMs: this.effectiveSilenceTimeoutMs(),
      avgTurnMs: durations.length === 0 ? 0 : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      longestTurnMs: durations.length === 0 ? 0 : Math.max(...durations),
      avgConfidence:
        confidences.length === 0 ? 0 : round4V30(confidences.reduce((a, b) => a + b, 0) / confidences.length),
    };
  }

  /** Reset everything (history, counters, noise floor, cadence). */
  reset(): void {
    this.speaking = false;
    this.confirming = false;
    this.confirmStartMs = null;
    this.confirmPeakEnergy = 0;
    this.confirmFrames = 0;
    this.confirmTextParts = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.hangoverLeftMs = 0;
    this.turnStartMs = null;
    this.turnPeakEnergy = 0;
    this.turnFrames = 0;
    this.turnSpeechFrames = 0;
    this.turnTextParts = [];
    this.turnEchoSuspect = false;
    this.turnCount = 0;
    this.backchannels = 0;
    this.noiseRejected = 0;
    this.spikesRejected = 0;
    this.echoFrames = 0;
    this.lastFrameAtMs = null;
    this.lastFrameEnergy = 0;
    this.turns.length = 0;
    this.recentDurations.length = 0;
    this.noiseFloor = this.config.noiseFloor;
  }

  private frameDeltaMs(atMs: number): number {
    if (this.lastFrameAtMs === null) return VOICE_V30_TURN_FRAME_MS_DEFAULT;
    const dt = atMs - this.lastFrameAtMs;
    if (!Number.isFinite(dt) || dt <= 0) return VOICE_V30_TURN_FRAME_MS_DEFAULT;
    return Math.min(dt, 1000);
  }

  /** Confidence of the in-progress turn so far (0 when idle). */
  private currentConfidence(): number {
    if (!this.speaking || this.turnStartMs === null || this.lastFrameAtMs === null) return 0;
    const durationMs = Math.max(0, this.lastFrameAtMs - this.turnStartMs);
    return this.confidenceFor(durationMs, this.turnPeakEnergy, this.turnSpeechFrames, this.turnFrames);
  }

  /**
   * Confidence 0..1: duration (a real turn lasts a while),
   * peak energy (a real turn is clearly above the floor),
   * stability (most frames in the turn are speech, not gaps).
   */
  private confidenceFor(durationMs: number, peakEnergy: number, speechFrames: number, frames: number): number {
    const durationScore = clampV30(durationMs / 2000, 0, 1);
    const energyScore = clampV30(peakEnergy, 0, 1);
    const stability = frames === 0 ? 0 : clampV30(speechFrames / frames, 0, 1);
    return round4V30(0.5 * durationScore + 0.3 * energyScore + 0.2 * stability);
  }

  private endTurn(atMs: number, reason: VoiceV30TurnEndReason): VoiceV30Turn | null {
    if (this.turnStartMs === null) return null;
    const start = this.turnStartMs;
    const durationMs = Math.max(0, atMs - start);
    const text = this.turnTextParts.join(' ').trim();
    const confidence = this.confidenceFor(durationMs, this.turnPeakEnergy, this.turnSpeechFrames, this.turnFrames);
    const isBackchannel =
      this.config.backchannelMaxMs > 0 &&
      durationMs <= this.config.backchannelMaxMs &&
      this.turnPeakEnergy <= this.config.backchannelMaxEnergy;
    const turn: VoiceV30Turn = {
      id: `turn-${this.turnCount + 1}`,
      index: this.turnCount,
      startedAtMs: start,
      endedAtMs: atMs,
      durationMs,
      peakEnergy: round4V30(this.turnPeakEnergy),
      frames: this.turnFrames,
      endReason: reason,
      backchannel: isBackchannel,
      text,
      confidence,
      echoSuspect: this.turnEchoSuspect,
      silenceTimeoutMs: this.effectiveSilenceTimeoutMs(),
    };
    // Too short to be speech (and not a backchannel): noise, not a turn.
    if (!isBackchannel && durationMs < this.config.minSpeechMs) {
      this.noiseRejected += 1;
      this.speaking = false;
      this.speechMs = 0;
      this.silenceMs = 0;
      this.hangoverLeftMs = 0;
      this.turnStartMs = null;
      this.turnTextParts = [];
      this.turnEchoSuspect = false;
      return null;
    }
    this.turnCount += 1;
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) this.turns.splice(0, this.turns.length - this.maxTurns);
    // Learn the cadence: remember the duration for the adaptive timeout.
    if (!isBackchannel) {
      this.recentDurations.push(durationMs);
      if (this.recentDurations.length > 5) this.recentDurations.shift();
    }
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.hangoverLeftMs = 0;
    this.turnStartMs = null;
    this.turnTextParts = [];
    this.turnEchoSuspect = false;
    if (isBackchannel) {
      this.backchannels += 1;
      this.onBackchannel?.(atMs, durationMs, turn.peakEnergy);
    } else {
      this.onTurnEnd?.(turn);
    }
    return turn;
  }
}

export function createAudioTurnDetectorV30(opts: AudioTurnDetectorV30Options = {}): AudioTurnDetectorV30 {
  return new AudioTurnDetectorV30(opts);
}
