/**
 * Audio turn detector v29 (v1.42, Team T4).
 *
 * The turn detector decides where one user turn starts and
 * ends from a stream of audio frames (energy 0..1, or a
 * caller-supplied speech verdict). Idea: LiveKit Agents 1.0
 * audio turn detection (survey §4) — the implementation is
 * ours: an energy VAD with silence timeout, hangover, an
 * adaptive noise floor, and a backchannel filter.
 *
 * Backchannels ("mm-hmm", "uh-huh", a short laugh) are real
 * speech, but they are not turns: a burst that is short
 * enough *and* quiet enough is reported as a backchannel and
 * never opens a turn. A short loud burst is still a turn
 * (e.g. "Stop!"), and a long quiet burst is still a turn
 * (e.g. a whispered sentence) — both conditions must hold
 * for the backchannel label.
 *
 * All clocks virtual (the caller passes `atMs`); no audio
 * is recorded, no mic is opened, frames are energy numbers.
 */

import {
  VOICE_V29_TURN_FRAME_MS_DEFAULT,
  VOICE_V29_TURN_NOISE_FLOOR_LEARN_RATE,
  clampV29,
  defaultTurnDetectorConfigV29,
  effectiveThresholdV29,
  round4V29,
  validateTurnDetectorConfigV29,
  type VoiceV29AudioFrame,
  type VoiceV29Turn,
  type VoiceV29TurnDetectorConfig,
  type VoiceV29TurnEndReason,
  type VoiceV29TurnFrameResult,
} from './types';

export interface AudioTurnDetectorV29Options {
  config?: Partial<VoiceV29TurnDetectorConfig>;
  /** Max turns kept in history (oldest dropped first). */
  maxTurns?: number;
  /** Called when a turn starts. */
  onTurnStart?: (turn: VoiceV29Turn) => void;
  /** Called when a turn ends. */
  onTurnEnd?: (turn: VoiceV29Turn) => void;
  /** Called when a backchannel burst is detected. */
  onBackchannel?: (atMs: number, durationMs: number, peakEnergy: number) => void;
}

export interface VoiceV29TurnDetectorStats {
  turns: number;
  backchannels: number;
  noiseRejected: number;
  currentTurnMs: number;
  speaking: boolean;
  noiseFloor: number;
  threshold: number;
  avgTurnMs: number;
  longestTurnMs: number;
}

/** Preset names for the turn detector. */
export type VoiceV29TurnPresetName = 'sensitive' | 'balanced' | 'relaxed' | 'push-to-talk';

/** Named presets: sensitivity is folded into threshold / timeouts. */
export const VOICE_V29_TURN_PRESETS: Record<
  VoiceV29TurnPresetName,
  Partial<VoiceV29TurnDetectorConfig>
> = {
  sensitive: {
    threshold: 0.12,
    silenceTimeoutMs: 500,
    hangoverMs: 100,
    minSpeechMs: 150,
    backchannelMaxMs: 500,
    backchannelMaxEnergy: 0.3,
  },
  balanced: {},
  relaxed: {
    threshold: 0.25,
    silenceTimeoutMs: 1000,
    hangoverMs: 200,
    minSpeechMs: 300,
    backchannelMaxMs: 800,
    backchannelMaxEnergy: 0.4,
  },
  'push-to-talk': {
    threshold: 0.1,
    silenceTimeoutMs: 300,
    hangoverMs: 50,
    minSpeechMs: 100,
    backchannelMaxMs: 0,
    backchannelMaxEnergy: 0,
    endKeyword: null,
  },
};

export function defaultAudioTurnDetectorV29Options(): AudioTurnDetectorV29Options {
  return { config: defaultTurnDetectorConfigV29(), maxTurns: 1000 };
}

export class AudioTurnDetectorV29 {
  private config: VoiceV29TurnDetectorConfig;
  private readonly maxTurns: number;
  private readonly onTurnStart?: (turn: VoiceV29Turn) => void;
  private readonly onTurnEnd?: (turn: VoiceV29Turn) => void;
  private readonly onBackchannel?: (atMs: number, durationMs: number, peakEnergy: number) => void;

  private noiseFloor: number;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private hangoverLeftMs = 0;
  private turnStartMs: number | null = null;
  private turnPeakEnergy = 0;
  private turnFrames = 0;
  private turnTextParts: string[] = [];
  private turnCount = 0;
  private backchannels = 0;
  private noiseRejected = 0;
  private lastEndWasNoise = false;
  private lastFrameAtMs: number | null = null;
  private readonly turns: VoiceV29Turn[] = [];
  private lastBackchannelAtMs: number | null = null;

  constructor(opts: AudioTurnDetectorV29Options = {}) {
    const merged: VoiceV29TurnDetectorConfig = {
      ...defaultTurnDetectorConfigV29(),
      ...(opts.config ?? {}),
    };
    const errors = validateTurnDetectorConfigV29(merged);
    if (errors.length > 0) throw new Error(`Invalid turn detector config: ${errors.join('; ')}`);
    this.config = merged;
    this.maxTurns = opts.maxTurns ?? 1000;
    this.onTurnStart = opts.onTurnStart;
    this.onTurnEnd = opts.onTurnEnd;
    this.onBackchannel = opts.onBackchannel;
    this.noiseFloor = merged.noiseFloor;
  }

  getConfig(): VoiceV29TurnDetectorConfig {
    return { ...this.config };
  }

  /** Replace the config (validated); keeps history and noise floor. */
  setConfig(patch: Partial<VoiceV29TurnDetectorConfig>): VoiceV29TurnDetectorConfig {
    const merged = { ...this.config, ...patch };
    const errors = validateTurnDetectorConfigV29(merged);
    if (errors.length > 0) throw new Error(`Invalid turn detector config: ${errors.join('; ')}`);
    this.config = merged;
    return this.getConfig();
  }

  /** Apply a named preset on top of the current config. */
  applyPreset(name: VoiceV29TurnPresetName): VoiceV29TurnDetectorConfig {
    const preset = VOICE_V29_TURN_PRESETS[name];
    if (!preset) throw new Error(`Unknown turn preset: ${name}`);
    return this.setConfig(preset);
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  currentTurnMs(atMs: number): number {
    if (this.turnStartMs === null) return 0;
    return Math.max(0, atMs - this.turnStartMs);
  }

  turnsSoFar(): VoiceV29Turn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  lastTurn(): VoiceV29Turn | null {
    const last = this.turns[this.turns.length - 1];
    return last ? { ...last } : null;
  }

  /** Feed one frame; returns what the detector decided for it. */
  feed(frame: VoiceV29AudioFrame): VoiceV29TurnFrameResult {
    const atMs = frame.atMs;
    const dt = this.frameDeltaMs(atMs);
    this.lastFrameAtMs = atMs;
    const threshold = effectiveThresholdV29(this.config);
    const isSpeech = frame.isSpeech ?? frame.energy >= threshold;

    if (!isSpeech && this.config.adaptive) {
      // Learn the floor from silence: slow drift toward observed energy.
      this.noiseFloor = round4V29(
        clampV29(
          this.noiseFloor +
            (frame.energy - this.noiseFloor) * VOICE_V29_TURN_NOISE_FLOOR_LEARN_RATE,
          0,
          0.9,
        ),
      );
    }

    let turnStarted = false;
    let turnEnded = false;
    let endReason: VoiceV29TurnEndReason | null = null;
    let backchannel = false;
    let noiseRejected = false;
    let kind: VoiceV29TurnFrameResult['kind'] = 'silence';

    if (isSpeech) {
      this.silenceMs = 0;
      this.speechMs += dt;
      this.hangoverLeftMs = this.config.hangoverMs;
      if (!this.speaking) {
        this.speaking = true;
        this.turnStartMs = atMs;
        this.turnPeakEnergy = frame.energy;
        this.turnFrames = 0;
        this.turnTextParts = [];
        turnStarted = true;
        this.onTurnStart?.({
          id: `turn-${this.turnCount + 1}`,
          index: this.turnCount,
          startedAtMs: atMs,
          endedAtMs: atMs,
          durationMs: 0,
          peakEnergy: round4V29(frame.energy),
          frames: 0,
          endReason: 'silence',
          backchannel: false,
          text: '',
        });
      }
      this.turnPeakEnergy = Math.max(this.turnPeakEnergy, frame.energy);
      this.turnFrames += 1;
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
    } else {
      // Silence (or noise): hangover keeps the turn alive briefly.
      if (this.speaking) {
        if (this.hangoverLeftMs > 0) {
          this.hangoverLeftMs = Math.max(0, this.hangoverLeftMs - dt);
          kind = 'speech';
        } else {
          this.silenceMs += dt;
          this.speechMs = 0;
          kind = 'silence';
          if (this.silenceMs >= this.config.silenceTimeoutMs) {
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

    // A burst too short to be speech is noise, not a turn.
    // endTurn() already counted it and dropped it from history;
    // surface that here so the caller can tell noise from a turn.
    if (turnEnded || this.lastEndWasNoise) {
      noiseRejected = this.lastEndWasNoise;
      if (noiseRejected) turnEnded = false;
    }
    this.lastEndWasNoise = false;

    return {
      kind: backchannel ? 'backchannel' : noiseRejected ? 'noise' : kind,
      threshold,
      noiseFloor: this.noiseFloor,
      speechMs: this.speechMs,
      silenceMs: this.silenceMs,
      turnStarted,
      turnEnded,
      endReason,
      backchannel,
      noiseRejected,
    };
  }

  /** End the current turn now (explicit end, e.g. user pressed stop). */
  endNow(atMs: number, reason: VoiceV29TurnEndReason = 'explicit'): VoiceV29Turn | null {
    if (!this.speaking || this.turnStartMs === null) return null;
    return this.endTurn(atMs, reason);
  }

  /** Abandon the current turn without recording it (false start). */
  abandon(atMs: number): boolean {
    if (!this.speaking || this.turnStartMs === null) return false;
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.turnStartMs = null;
    this.turnTextParts = [];
    this.lastFrameAtMs = atMs;
    return true;
  }

  stats(): VoiceV29TurnDetectorStats {
    const durations = this.turns.filter((t) => !t.backchannel).map((t) => t.durationMs);
    return {
      turns: this.turns.filter((t) => !t.backchannel).length,
      backchannels: this.backchannels,
      noiseRejected: this.noiseRejected,
      currentTurnMs: this.turnStartMs === null || this.lastFrameAtMs === null ? 0 : Math.max(0, this.lastFrameAtMs - this.turnStartMs),
      speaking: this.speaking,
      noiseFloor: this.noiseFloor,
      threshold: effectiveThresholdV29(this.config),
      avgTurnMs: durations.length === 0 ? 0 : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      longestTurnMs: durations.length === 0 ? 0 : Math.max(...durations),
    };
  }

  /** Reset everything (history, counters, noise floor). */
  reset(): void {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.hangoverLeftMs = 0;
    this.turnStartMs = null;
    this.turnPeakEnergy = 0;
    this.turnFrames = 0;
    this.turnTextParts = [];
    this.turnCount = 0;
    this.backchannels = 0;
    this.noiseRejected = 0;
    this.lastEndWasNoise = false;
    this.lastFrameAtMs = null;
    this.turns.length = 0;
    this.lastBackchannelAtMs = null;
    this.noiseFloor = this.config.noiseFloor;
  }

  private frameDeltaMs(atMs: number): number {
    if (this.lastFrameAtMs === null) return VOICE_V29_TURN_FRAME_MS_DEFAULT;
    const dt = atMs - this.lastFrameAtMs;
    if (!Number.isFinite(dt) || dt <= 0) return VOICE_V29_TURN_FRAME_MS_DEFAULT;
    return Math.min(dt, 1000);
  }

  private endTurn(atMs: number, reason: VoiceV29TurnEndReason): VoiceV29Turn | null {
    if (this.turnStartMs === null) return null;
    const start = this.turnStartMs;
    const durationMs = Math.max(0, atMs - start);
    const text = this.turnTextParts.join(' ').trim();
    const isBackchannel =
      this.config.backchannelMaxMs > 0 &&
      durationMs <= this.config.backchannelMaxMs &&
      this.turnPeakEnergy <= this.config.backchannelMaxEnergy;
    const turn: VoiceV29Turn = {
      id: `turn-${this.turnCount + 1}`,
      index: this.turnCount,
      startedAtMs: start,
      endedAtMs: atMs,
      durationMs,
      peakEnergy: round4V29(this.turnPeakEnergy),
      frames: this.turnFrames,
      endReason: reason,
      backchannel: isBackchannel,
      text,
    };
    // Too short to be speech (and not a backchannel): noise, not a turn.
    // The burst is dropped from history and counted, not recorded.
    if (!isBackchannel && durationMs < this.config.minSpeechMs) {
      this.noiseRejected += 1;
      this.lastEndWasNoise = true;
      this.speaking = false;
      this.speechMs = 0;
      this.silenceMs = 0;
      this.hangoverLeftMs = 0;
      this.turnStartMs = null;
      this.turnTextParts = [];
      return null;
    }
    this.lastEndWasNoise = false;
    this.turnCount += 1;
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) this.turns.splice(0, this.turns.length - this.maxTurns);
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.hangoverLeftMs = 0;
    this.turnStartMs = null;
    this.turnTextParts = [];
    if (isBackchannel) {
      this.backchannels += 1;
      this.lastBackchannelAtMs = atMs;
      this.onBackchannel?.(atMs, durationMs, turn.peakEnergy);
    } else {
      this.onTurnEnd?.(turn);
    }
    return turn;
  }
}

export function createAudioTurnDetectorV29(opts: AudioTurnDetectorV29Options = {}): AudioTurnDetectorV29 {
  return new AudioTurnDetectorV29(opts);
}
