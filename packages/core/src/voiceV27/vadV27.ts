/**
 * Turn-taking v2 + VAD tuning (voice v27).
 *
 * v26 owns the floor machine (who holds the floor, anti-overlap
 * queue, per-phase timeouts). v27 owns the *listening* side of
 * the loop — deciding, frame by frame, whether the user is
 * actually speaking, and when their turn is over:
 *
 *   - VadTunerV27: a tunable voice-activity detector. Energy
 *     frames are classified speech / silence / noise against an
 *     effective threshold (silence threshold pulled down by
 *     sensitivity, never below the learned noise floor + a
 *     margin). The noise floor is learned from observed silence
 *     frames when adaptive mode is on. Named presets
 *     (sensitive / balanced / strict) cover quiet rooms, normal
 *     rooms and noisy rooms; `calibrate` feeds a sample of
 *     real frame energies and suggests a config for the room.
 *     Short-noise rejection: a speech burst shorter than
 *     minSpeechMs that is followed by silence is a cough, a
 *     door slam, a chair scrape — counted as a rejected noise
 *     burst, never the start of a turn.
 *   - TurnManagerV27: turns driven by the VAD. A user turn
 *     opens on sustained speech, ends on end-of-turn silence,
 *     on the end keyword, on timeout, or on a barge-in; an
 *     agent turn opens when the model replies and ends when
 *     the reply finishes or is cut. Every turn keeps speech /
 *     silence totals and noise-rejection counts, per bot, with
 *     history and analytics (mean turn length, end reasons,
 *     timeouts) — the numbers a host needs to retune the VAD.
 *
 * Frames are caller-supplied energy samples; no mic is read.
 * All clocks virtual.
 */
import {
  clampV27,
  defaultVadConfigV27,
  durationBucketV27,
  effectiveThresholdV27,
  formatDurationV27,
  meanV27,
  percentileV27,
  round2V27,
  round4V27,
  VOICE_V27_END_SILENCE_DEFAULT_MS,
  VOICE_V27_FRAME_MS_DEFAULT,
  VOICE_V27_HANGOVER_DEFAULT_MS,
  VOICE_V27_MAX_LISTENING_DEFAULT_MS,
  VOICE_V27_MAX_SPEAKING_DEFAULT_MS,
  VOICE_V27_MAX_THINKING_DEFAULT_MS,
  VOICE_V27_MAX_TURN_DEFAULT_MS,
  VOICE_V27_MAX_TURNS_DEFAULT,
  VOICE_V27_MAX_VAD_SAMPLES_DEFAULT,
  VOICE_V27_MIN_SPEECH_DEFAULT_MS,
  VOICE_V27_NOISE_FLOOR_DEFAULT,
  VOICE_V27_NOISE_FLOOR_LEARN_RATE,
  VOICE_V27_SENSITIVITY_DEFAULT,
  VOICE_V27_SILENCE_THRESHOLD_DEFAULT,
  VOICE_V27_VAD_PRESETS,
  type VoiceV27FrameKind,
  type VoiceV27TurnEndReason,
  type VoiceV27TurnRecord,
  type VoiceV27TurnStatus,
  type VoiceV27VadConfig,
  type VoiceV27VadFrame,
  type VoiceV27VadFrameResult,
  type VoiceV27VadPreset,
} from './types';

export interface VadTunerV27Options {
  config: VoiceV27VadConfig;
  /** Preset the config started from (default 'balanced'). */
  preset: VoiceV27VadPreset;
  /** ms per frame when the caller omits it (default 50). */
  frameMs: number;
  /** Max frame samples kept for calibration (default 2000). */
  maxSamples: number;
}

export function defaultVadTunerV27Options(): VadTunerV27Options {
  return {
    config: defaultVadConfigV27(),
    preset: 'balanced',
    frameMs: VOICE_V27_FRAME_MS_DEFAULT,
    maxSamples: VOICE_V27_MAX_VAD_SAMPLES_DEFAULT,
  };
}

export function validateVadConfigV27(config: Partial<VoiceV27VadConfig>): string[] {
  const errors: string[] = [];
  const range = (name: string, v: number | undefined, min: number, max: number): void => {
    if (v === undefined) return;
    if (!Number.isFinite(v) || v < min || v > max) errors.push(`${name} must be ${min}..${max}`);
  };
  range('silenceThreshold', config.silenceThreshold, 0.01, 0.95);
  range('sensitivity', config.sensitivity, 0, 1);
  range('noiseFloor', config.noiseFloor, 0, 0.9);
  const ms = (name: string, v: number | undefined, min: number, max: number): void => {
    if (v === undefined) return;
    if (!Number.isFinite(v) || v < min || v > max) errors.push(`${name} must be ${min}..${max}ms`);
  };
  ms('minSpeechMs', config.minSpeechMs, 0, 5_000);
  ms('endSilenceMs', config.endSilenceMs, 100, 10_000);
  ms('hangoverMs', config.hangoverMs, 0, 2_000);
  if (config.endKeyword !== undefined && config.endKeyword !== null && typeof config.endKeyword !== 'string') {
    errors.push('endKeyword must be a string or null');
  }
  return errors;
}

export interface VoiceV27VadStats {
  frames: number;
  speechFrames: number;
  silenceFrames: number;
  noiseFrames: number;
  noiseRejections: number;
  turnsEnded: number;
  turnsEndedBySilence: number;
  turnsEndedByKeyword: number;
  meanSpeechBurstMs: number;
  p95SpeechBurstMs: number;
  noiseFloor: number;
  threshold: number;
  preset: VoiceV27VadPreset;
}

export interface VoiceV27Calibration {
  samples: number;
  silenceP50: number;
  silenceP95: number;
  speechP50: number;
  suggestedThreshold: number;
  suggestedEndSilenceMs: number;
  suggestedMinSpeechMs: number;
  suggestedPreset: VoiceV27VadPreset;
  applied: boolean;
}

export function createVadTunerV27(opts: Partial<VadTunerV27Options> = {}): VadTunerV27 {
  return new VadTunerV27(opts);
}

export class VadTunerV27 {
  private config: VoiceV27VadConfig;
  private preset: VoiceV27VadPreset;
  private readonly frameMs: number;
  private readonly maxSamples: number;
  private samples: number[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private speechBurstMs = 0;
  private bursts: number[] = [];
  private speechFrames = 0;
  private silenceFrames = 0;
  private noiseFrames = 0;
  private noiseRejections = 0;
  private turnsEnded = 0;
  private turnsEndedBySilence = 0;
  private turnsEndedByKeyword = 0;
  private pendingNoiseMs = 0;
  private speaking = false;

  constructor(opts: Partial<VadTunerV27Options> = {}) {
    const errors = validateVadConfigV27(opts.config ?? {});
    if (errors.length > 0) throw new Error(`Invalid VadTunerV27 config: ${errors.join('; ')}`);
    const defaults = defaultVadTunerV27Options();
    this.config = { ...defaults.config, ...(opts.config ?? {}) };
    this.preset = opts.preset ?? defaults.preset;
    this.frameMs = opts.frameMs ?? defaults.frameMs;
    this.maxSamples = opts.maxSamples ?? defaults.maxSamples;
  }

  configNow(): VoiceV27VadConfig {
    return { ...this.config };
  }

  presetNow(): VoiceV27VadPreset {
    return this.preset;
  }

  thresholdNow(): number {
    return effectiveThresholdV27(this.config);
  }

  noiseFloorNow(): number {
    return round4V27(this.config.noiseFloor);
  }

  configure(partial: Partial<VoiceV27VadConfig>): VoiceV27VadConfig {
    const errors = validateVadConfigV27(partial);
    if (errors.length > 0) throw new Error(`Invalid VadTunerV27 config: ${errors.join('; ')}`);
    this.config = { ...this.config, ...partial };
    this.preset = 'custom';
    return this.configNow();
  }

  applyPreset(preset: Exclude<VoiceV27VadPreset, 'custom'>): VoiceV27VadConfig {
    const base = VOICE_V27_VAD_PRESETS[preset];
    this.config = { ...this.config, ...base };
    this.preset = preset;
    return this.configNow();
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  speechMsNow(): number {
    return this.speechMs;
  }

  silenceMsNow(): number {
    return this.silenceMs;
  }

  /**
   * Classify one energy frame. `frameMs` overrides the tuner
   * default for this frame. Returns the classification plus
   * whether the frame ended the current turn.
   */
  classifyFrame(frame: VoiceV27VadFrame, frameMs?: number): VoiceV27VadFrameResult {
    const step = frameMs ?? this.frameMs;
    const energy = clampV27(frame.energy, 0, 1);
    const threshold = this.thresholdNow();
    this.samples.push(energy);
    while (this.samples.length > this.maxSamples) this.samples.shift();

    const callerSaysSpeech = frame.isSpeech;
    const above = callerSaysSpeech === true ? true : callerSaysSpeech === false ? false : energy >= threshold;
    let kind: VoiceV27FrameKind = above ? 'speech' : 'silence';
    let turnEnded = false;
    let endReason: VoiceV27TurnEndReason | null = null;
    let noiseRejected = false;

    // Learn the noise floor from silence frames (adaptive mode).
    if (!above && this.config.adaptive) {
      this.config.noiseFloor = round4V27(
        this.config.noiseFloor + (energy - this.config.noiseFloor) * VOICE_V27_NOISE_FLOOR_LEARN_RATE,
      );
    }

    if (above) {
      this.speechFrames += 1;
      this.speechMs += step;
      this.silenceMs = 0;
      this.speechBurstMs += step;
      if (!this.speaking) {
        // A burst too short to trust yet: hold it as pending noise.
        this.pendingNoiseMs = this.speechBurstMs;
        this.speaking = true;
      }
      // End-keyword check: the caller transcript ends the turn now.
      if (this.config.endKeyword !== null && frame.text) {
        if (frame.text.toLowerCase().includes(this.config.endKeyword.toLowerCase())) {
          turnEnded = true;
          endReason = 'keyword';
          this.turnsEnded += 1;
          this.turnsEndedByKeyword += 1;
          this.finishBurst();
        }
      }
    } else {
      this.silenceFrames += 1;
      this.silenceMs += step;
      // Hangover: keep the last bit of speech counted a little longer.
      if (this.speaking && this.silenceMs <= this.config.hangoverMs) {
        this.speechMs += 0;
      }
      if (this.speaking) {
        if (this.speechBurstMs < this.config.minSpeechMs) {
          // Short burst followed by silence: cough / knock / scrape.
          // Reject it as noise — it never opened a turn.
          noiseRejected = true;
          this.noiseRejections += 1;
          this.noiseFrames += 1;
          this.speaking = false;
          this.bursts.push(this.speechBurstMs);
          this.speechMs = Math.max(0, this.speechMs - this.speechBurstMs);
          this.speechBurstMs = 0;
          this.pendingNoiseMs = 0;
          kind = 'noise';
        } else if (this.silenceMs >= this.config.endSilenceMs) {
          turnEnded = true;
          endReason = 'silence';
          this.turnsEnded += 1;
          this.turnsEndedBySilence += 1;
          this.finishBurst();
        }
      }
    }
    void this.pendingNoiseMs;
    return {
      kind,
      threshold,
      noiseFloor: this.noiseFloorNow(),
      speechMs: this.speechMs,
      silenceMs: this.silenceMs,
      turnEnded,
      endReason,
      noiseRejected,
    };
  }

  private finishBurst(): void {
    if (this.speechBurstMs > 0) this.bursts.push(this.speechBurstMs);
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.speechBurstMs = 0;
    this.pendingNoiseMs = 0;
  }

  /** Reset the in-flight speech/silence counters (keeps the config). */
  resetCounters(): void {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.speechBurstMs = 0;
    this.pendingNoiseMs = 0;
  }

  /**
   * Calibrate from a sample of frame energies (silence + speech
   * mixed). The quietest 60% of samples estimate the room
   * (silence p50/p95); the loudest 20% estimate speech. Suggests
   * a threshold between the silence p95 and the speech median,
   * plus timings; applies it when `apply` is set.
   */
  calibrate(samples: readonly number[], apply = false): VoiceV27Calibration {
    const clean = samples.filter((v) => Number.isFinite(v)).map((v) => clampV27(v, 0, 1));
    if (clean.length < 10) throw new Error('calibrate needs at least 10 samples');
    const sorted = [...clean].sort((a, b) => a - b);
    const silencePart = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.6)));
    const speechPart = sorted.slice(Math.floor(sorted.length * 0.8));
    const silenceP50 = round4V27(percentileV27(silencePart, 50));
    const silenceP95 = round4V27(percentileV27(silencePart, 95));
    const speechP50 = round4V27(percentileV27(speechPart.length > 0 ? speechPart : sorted, 50));
    const suggestedThreshold = round4V27(clampV27((silenceP95 + speechP50) / 2, 0.05, 0.9));
    const noisy = silenceP95 > 0.25;
    const suggestedPreset: VoiceV27VadPreset = noisy ? 'strict' : silenceP95 < 0.08 ? 'sensitive' : 'balanced';
    const suggestedEndSilenceMs = noisy ? 500 : 800;
    const suggestedMinSpeechMs = noisy ? 350 : 200;
    if (apply) {
      this.config = {
        ...this.config,
        silenceThreshold: suggestedThreshold,
        noiseFloor: silenceP50,
        endSilenceMs: suggestedEndSilenceMs,
        minSpeechMs: suggestedMinSpeechMs,
      };
      this.preset = suggestedPreset;
    }
    return {
      samples: clean.length,
      silenceP50,
      silenceP95,
      speechP50,
      suggestedThreshold,
      suggestedEndSilenceMs,
      suggestedMinSpeechMs,
      suggestedPreset,
      applied: apply,
    };
  }

  stats(): VoiceV27VadStats {
    return {
      frames: this.speechFrames + this.silenceFrames + this.noiseFrames,
      speechFrames: this.speechFrames,
      silenceFrames: this.silenceFrames,
      noiseFrames: this.noiseFrames,
      noiseRejections: this.noiseRejections,
      turnsEnded: this.turnsEnded,
      turnsEndedBySilence: this.turnsEndedBySilence,
      turnsEndedByKeyword: this.turnsEndedByKeyword,
      meanSpeechBurstMs: round2V27(meanV27(this.bursts)),
      p95SpeechBurstMs: round2V27(percentileV27(this.bursts, 95)),
      noiseFloor: this.noiseFloorNow(),
      threshold: this.thresholdNow(),
      preset: this.preset,
    };
  }

  markdown(): string {
    const s = this.stats();
    const c = this.config;
    return [
      '# VAD tuning v27',
      '',
      `- Preset: ${s.preset} · threshold ${s.threshold} (base ${c.silenceThreshold}, sensitivity ${c.sensitivity}) · noise floor ${s.noiseFloor}`,
      `- Min speech ${c.minSpeechMs}ms · end silence ${c.endSilenceMs}ms · hangover ${c.hangoverMs}ms · adaptive ${c.adaptive} · end keyword ${c.endKeyword ?? '-'}`,
      `- Frames: ${s.frames} (${s.speechFrames} speech, ${s.silenceFrames} silence, ${s.noiseFrames} noise) · noise rejections: ${s.noiseRejections}`,
      `- Turns ended: ${s.turnsEnded} (${s.turnsEndedBySilence} by silence, ${s.turnsEndedByKeyword} by keyword)`,
      `- Mean speech burst: ${formatDurationV27(s.meanSpeechBurstMs)} · p95 ${formatDurationV27(s.p95SpeechBurstMs)}`,
      '',
    ].join('\n');
  }

  reset(): void {
    this.resetCounters();
    this.samples = [];
    this.bursts = [];
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.noiseFrames = 0;
    this.noiseRejections = 0;
    this.turnsEnded = 0;
    this.turnsEndedBySilence = 0;
    this.turnsEndedByKeyword = 0;
  }
}

export interface TurnManagerV27Options {
  /** VAD tuner options (a tuner is created per manager). */
  vad?: Partial<VadTunerV27Options>;
  /** Max ms a single turn may run before it times out. */
  maxTurnMs: number;
  /** Max ms the user may hold the listening phase. */
  maxListeningMs: number;
  /** Max ms the agent may hold the thinking phase. */
  maxThinkingMs: number;
  /** Max ms the agent may hold the speaking phase. */
  maxSpeakingMs: number;
  /** Max turns kept in history (oldest dropped). */
  maxTurns: number;
  /** Session id the manager belongs to. */
  sessionId: string;
  /** Bot id the turns belong to (null when unassigned). */
  botId: string | null;
}

export function defaultTurnManagerV27Options(sessionId = ''): TurnManagerV27Options {
  return {
    vad: {},
    maxTurnMs: VOICE_V27_MAX_TURN_DEFAULT_MS,
    maxListeningMs: VOICE_V27_MAX_LISTENING_DEFAULT_MS,
    maxThinkingMs: VOICE_V27_MAX_THINKING_DEFAULT_MS,
    maxSpeakingMs: VOICE_V27_MAX_SPEAKING_DEFAULT_MS,
    maxTurns: VOICE_V27_MAX_TURNS_DEFAULT,
    sessionId,
    botId: null,
  };
}

export function validateTurnManagerV27Options(opts: Partial<TurnManagerV27Options>): string[] {
  const errors: string[] = [];
  const ms = (name: string, v: number | undefined, min: number, max: number): void => {
    if (v === undefined) return;
    if (!Number.isFinite(v) || v < min || v > max) errors.push(`${name} must be ${min}..${max}ms`);
  };
  ms('maxTurnMs', opts.maxTurnMs, 1_000, 600_000);
  ms('maxListeningMs', opts.maxListeningMs, 1_000, 600_000);
  ms('maxThinkingMs', opts.maxThinkingMs, 1_000, 300_000);
  ms('maxSpeakingMs', opts.maxSpeakingMs, 1_000, 600_000);
  if (opts.maxTurns !== undefined && (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 10 || opts.maxTurns > 5_000)) {
    errors.push('maxTurns must be an integer 10..5000');
  }
  if (opts.vad?.config !== undefined) errors.push(...validateVadConfigV27(opts.vad.config));
  return errors;
}

export interface VoiceV27TurnManagerStats {
  sessionId: string;
  turns: number;
  userTurns: number;
  agentTurns: number;
  completed: number;
  interrupted: number;
  timeouts: number;
  abandoned: number;
  active: number;
  meanTurnMs: number;
  p95TurnMs: number;
  meanUserSpeechMs: number;
  noiseRejections: number;
  byEndReason: Partial<Record<VoiceV27TurnEndReason, number>>;
  byDurationBucket: Record<'short' | 'medium' | 'long', number>;
  vadPreset: VoiceV27VadPreset;
}

export function createTurnManagerV27(
  sessionId: string,
  opts: Partial<TurnManagerV27Options> = {},
): TurnManagerV27 {
  return new TurnManagerV27(sessionId, opts);
}

export class TurnManagerV27 {
  readonly sessionId: string;
  readonly vad: VadTunerV27;
  private opts: TurnManagerV27Options;
  private vadOpts: Partial<VadTunerV27Options>;
  private turns: VoiceV27TurnRecord[] = [];
  private seq = 0;
  private active: VoiceV27TurnRecord | null = null;
  private phaseStartedAtMs: number | null = null;

  constructor(sessionId: string, opts: Partial<TurnManagerV27Options> = {}) {
    const errors = validateTurnManagerV27Options(opts);
    if (errors.length > 0) throw new Error(`Invalid TurnManagerV27 options: ${errors.join('; ')}`);
    this.sessionId = sessionId;
    this.opts = { ...defaultTurnManagerV27Options(sessionId), ...opts, sessionId };
    this.vadOpts = opts.vad ?? {};
    this.vad = new VadTunerV27(opts.vad ?? {});
  }

  optionsNow(): TurnManagerV27Options {
    return { ...this.opts, vad: this.vadOpts };
  }

  private newTurn(role: 'user' | 'assistant', atMs: number, text: string): VoiceV27TurnRecord {
    this.seq += 1;
    const turn: VoiceV27TurnRecord = {
      id: `v27-turn-${this.seq}`,
      sessionId: this.sessionId,
      botId: this.opts.botId,
      index: this.seq - 1,
      role,
      startedAtMs: atMs,
      endedAtMs: null,
      durationMs: null,
      status: 'active',
      endReason: null,
      text,
      speechMs: 0,
      silenceMs: 0,
      noiseRejections: 0,
      spokenChars: null,
      plannedChars: null,
      interruptId: null,
      vadPreset: this.vad.presetNow(),
    };
    this.turns.push(turn);
    while (this.turns.length > this.opts.maxTurns) this.turns.shift();
    this.active = turn;
    this.phaseStartedAtMs = atMs;
    return turn;
  }

  private finishTurn(turn: VoiceV27TurnRecord, atMs: number, status: VoiceV27TurnStatus, reason: VoiceV27TurnEndReason): VoiceV27TurnRecord {
    turn.endedAtMs = atMs;
    turn.durationMs = Math.max(0, atMs - turn.startedAtMs);
    turn.status = status;
    turn.endReason = reason;
    if (this.active?.id === turn.id) this.active = null;
    this.phaseStartedAtMs = null;
    return { ...turn };
  }

  currentTurn(): VoiceV27TurnRecord | null {
    return this.active === null ? null : { ...this.active };
  }

  /** Open a user turn (called when sustained speech is detected). */
  userStart(atMs: number, text = ''): VoiceV27TurnRecord {
    if (this.active !== null && this.active.role === 'user') return { ...this.active };
    if (this.active !== null) this.finishTurn(this.active, atMs, 'abandoned', 'abandoned');
    return { ...this.newTurn('user', atMs, text) };
  }

  /**
   * Feed one VAD frame into the active user turn. Opens a user
   * turn on sustained speech; ends it on VAD turn-end. Returns
   * the frame result plus the turn it belongs to (if any).
   */
  userFrame(frame: VoiceV27VadFrame, frameMs?: number): {
    frame: VoiceV27VadFrameResult;
    turn: VoiceV27TurnRecord | null;
  } {
    const result = this.vad.classifyFrame(frame, frameMs);
    const step = frameMs ?? VOICE_V27_FRAME_MS_DEFAULT;
    if (result.kind === 'speech' && this.active === null) {
      this.newTurn('user', frame.atMs, frame.text ?? '');
    }
    if (this.active !== null && this.active.role === 'user') {
      if (result.kind === 'speech') this.active.speechMs += step;
      if (result.kind === 'silence') this.active.silenceMs += step;
      if (result.noiseRejected) {
        this.active.noiseRejections += 1;
        // The burst that opened this turn was too short to be
        // speech: it never was a turn — abandon the record so a
        // cough does not leave a phantom active turn behind.
        if (this.active.speechMs < this.vad.configNow().minSpeechMs) {
          const abandoned = this.finishTurn(this.active, frame.atMs, 'abandoned', 'abandoned');
          return { frame: result, turn: abandoned };
        }
      }
      if (frame.text) this.active.text = frame.text;
    }
    if (result.turnEnded && this.active !== null && this.active.role === 'user') {
      const ended = this.finishTurn(this.active, frame.atMs, 'completed', result.endReason ?? 'silence');
      return { frame: result, turn: ended };
    }
    return { frame: result, turn: this.active === null ? null : { ...this.active } };
  }

  /** End the active user turn explicitly (caller has the transcript). */
  userEnd(atMs: number, text?: string | null): VoiceV27TurnRecord | null {
    if (this.active === null || this.active.role !== 'user') return null;
    if (text !== undefined && text !== null) this.active.text = text;
    return this.finishTurn(this.active, atMs, 'completed', 'explicit');
  }

  /** Open an agent turn for a model reply. */
  agentStart(atMs: number, text: string): VoiceV27TurnRecord {
    if (this.active !== null) this.finishTurn(this.active, atMs, 'abandoned', 'abandoned');
    const turn = this.newTurn('assistant', atMs, text);
    turn.plannedChars = text.length;
    return { ...turn };
  }

  /** Finish the active agent turn (reply fully spoken). */
  agentDone(atMs: number, spokenChars?: number | null): VoiceV27TurnRecord | null {
    if (this.active === null || this.active.role !== 'assistant') return null;
    if (spokenChars !== undefined && spokenChars !== null) this.active.spokenChars = spokenChars;
    return this.finishTurn(this.active, atMs, 'completed', 'explicit');
  }

  /** Cut the active agent turn short: a barge-in stopped the reply. */
  agentInterrupted(atMs: number, interruptId: string, spokenChars?: number | null): VoiceV27TurnRecord | null {
    if (this.active === null || this.active.role !== 'assistant') return null;
    this.active.interruptId = interruptId;
    if (spokenChars !== undefined && spokenChars !== null) this.active.spokenChars = spokenChars;
    return this.finishTurn(this.active, atMs, 'interrupted', 'barge-in');
  }

  /** Abandon whatever turn is active (user walked away, error). */
  abandon(atMs: number): VoiceV27TurnRecord | null {
    if (this.active === null) return null;
    return this.finishTurn(this.active, atMs, 'abandoned', 'abandoned');
  }

  /**
   * Per-phase timeout check: a turn that runs past its phase
   * budget (listening / thinking / speaking) is timed out so no
   * phase can hold the conversation forever.
   */
  timeoutCheck(atMs: number): VoiceV27TurnRecord | null {
    if (this.active === null || this.phaseStartedAtMs === null) return null;
    const elapsed = atMs - this.phaseStartedAtMs;
    const budget = this.active.role === 'user'
      ? this.opts.maxListeningMs
      : this.opts.maxSpeakingMs;
    if (elapsed > Math.min(this.opts.maxTurnMs, budget)) {
      return this.finishTurn(this.active, atMs, 'timeout', 'timeout');
    }
    return null;
  }

  listTurns(): VoiceV27TurnRecord[] {
    return this.turns.map((t) => ({ ...t }));
  }

  getTurn(id: string): VoiceV27TurnRecord | null {
    const found = this.turns.find((t) => t.id === id);
    return found === undefined ? null : { ...found };
  }

  stats(): VoiceV27TurnManagerStats {
    const durations = this.turns.filter((t) => t.durationMs !== null).map((t) => t.durationMs as number);
    const userSpeech = this.turns.filter((t) => t.role === 'user').map((t) => t.speechMs);
    const byEndReason: Partial<Record<VoiceV27TurnEndReason, number>> = {};
    const byDurationBucket: Record<'short' | 'medium' | 'long', number> = { short: 0, medium: 0, long: 0 };
    for (const t of this.turns) {
      if (t.endReason !== null) byEndReason[t.endReason] = (byEndReason[t.endReason] ?? 0) + 1;
      if (t.durationMs !== null) byDurationBucket[durationBucketV27(t.durationMs)] += 1;
    }
    return {
      sessionId: this.sessionId,
      turns: this.turns.length,
      userTurns: this.turns.filter((t) => t.role === 'user').length,
      agentTurns: this.turns.filter((t) => t.role === 'assistant').length,
      completed: this.turns.filter((t) => t.status === 'completed').length,
      interrupted: this.turns.filter((t) => t.status === 'interrupted').length,
      timeouts: this.turns.filter((t) => t.status === 'timeout').length,
      abandoned: this.turns.filter((t) => t.status === 'abandoned').length,
      active: this.active === null ? 0 : 1,
      meanTurnMs: round2V27(meanV27(durations)),
      p95TurnMs: round2V27(percentileV27(durations, 95)),
      meanUserSpeechMs: round2V27(meanV27(userSpeech)),
      noiseRejections: this.turns.reduce((a, t) => a + t.noiseRejections, 0),
      byEndReason,
      byDurationBucket,
      vadPreset: this.vad.presetNow(),
    };
  }

  markdown(): string {
    const s = this.stats();
    const v = this.vad.stats();
    const lines = [
      '# Turn-taking v27',
      '',
      `- Session: ${this.sessionId} · bot ${this.opts.botId ?? '-'} · VAD preset ${s.vadPreset}`,
      `- Turns: ${s.turns} (${s.userTurns} user, ${s.agentTurns} agent) · completed ${s.completed} · interrupted ${s.interrupted} · timeouts ${s.timeouts} · abandoned ${s.abandoned}`,
      `- Mean turn: ${formatDurationV27(s.meanTurnMs)} · p95 ${formatDurationV27(s.p95TurnMs)} · mean user speech ${formatDurationV27(s.meanUserSpeechMs)}`,
      `- Noise rejections: ${s.noiseRejections} · VAD frames ${v.frames} (${v.speechFrames} speech / ${v.silenceFrames} silence / ${v.noiseFrames} noise)`,
      '',
      '| turn | role | status | end | duration | speech |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const t of this.turns.slice(-15)) {
      lines.push(`| ${t.id} | ${t.role} | ${t.status} | ${t.endReason ?? '-'} | ${formatDurationV27(t.durationMs)} | ${formatDurationV27(t.speechMs)} |`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.turns = [];
    this.seq = 0;
    this.active = null;
    this.phaseStartedAtMs = null;
    this.vad.reset();
  }
}
