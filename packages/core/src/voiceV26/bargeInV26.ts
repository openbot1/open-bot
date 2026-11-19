/**
 * Frame-level barge-in detection for voice v26 (v1.39, Team T5).
 *
 * v25 owns the turn-level consequences of a barge-in (stop at a
 * measured offset, keep the spoken prefix, queue the interrupting
 * turn). v23 owns the burst-level decision (grace window,
 * backchannel, echo). v26 owns the *frame-level* detector that
 * feeds both: energy frames arrive while the agent speaks, and
 * this detector decides, frame by frame, whether the user is
 * really cutting in.
 *
 * Two-stage decision:
 *   1. suspect — user energy stays above an adaptive threshold
 *      (noise floor + margin, the floor tracked by an exponential
 *      moving average of quiet frames) for `duckAfterMs`;
 *      the TTS is ducked (gain lowered) but keeps speaking.
 *   2. confirmed — speech sustains for `confirmAfterMs`; the
 *      TTS must stop. `stop()` finalises the cut: measured stop
 *      latency, spoken prefix cut at a word boundary, remainder
 *      kept, resume strategy picked from how much was spoken.
 *
 * Discrimination:
 *   - echo: while the agent speaks, frames that track the TTS
 *     envelope (caller marks them, or energy below the raised
 *     while-speaking threshold) never confirm;
 *   - backchannel: short bursts (under `backchannelMaxMs`) are
 *     noted and never change the state — the agent keeps
 *     speaking;
 *   - noise: a single loud frame never confirms; speech must
 *     sustain;
 *   - grace window: speech in the first `graceAfterReplyStartMs`
 *     of a reply is treated as overlap noise, not a barge-in,
 *     unless it sustains well past the grace window.
 *
 * All clocks virtual; audio is caller-supplied frame energy.
 * No mic, no sound card, no network.
 */
import {
  VOICE_V26_BACKCHANNEL_MAX_MS_DEFAULT,
  VOICE_V26_CONFIRM_AFTER_MS_DEFAULT,
  VOICE_V26_DUCK_AFTER_MS_DEFAULT,
  VOICE_V26_GRACE_AFTER_REPLY_START_MS_DEFAULT,
  VOICE_V26_MAX_RECORDS_DEFAULT,
  VOICE_V26_MIN_SPEECH_DEFAULT_MS,
  VOICE_V26_NOISE_FLOOR_DEFAULT,
  VOICE_V26_STOP_LATENCY_SLOW_DEFAULT_MS,
  VOICE_V26_THRESHOLD_MARGIN_DEFAULT,
  clampV26,
  cutAtWordBoundaryV26,
  round2V26,
  strategyForSpokenFractionV26,
  type VoiceV26AudioFrame,
  type VoiceV26BargeInKind,
  type VoiceV26BargeInRecord,
  type VoiceV26BargeInStage,
  type VoiceV26FrameResult,
  type VoiceV26ResumeContext,
  type VoiceV26ResumeStrategy,
  type VoiceV26StopResult,
} from './types';

export interface BargeInV26Options {
  /** Starting noise-floor estimate, 0..1 (default 0.08). */
  noiseFloor: number;
  /** Margin above the floor that counts as speech, 0..1 (default 0.12). */
  thresholdMargin: number;
  /** Extra threshold while the agent speaks (echo guard), 0..1 (default 0.10). */
  speakingMargin: number;
  /** ms of sustained speech before ducking (default 120). */
  duckAfterMs: number;
  /** ms of sustained speech before confirming (default 350). */
  confirmAfterMs: number;
  /** Min sustained speech ms to count at all (default 250). */
  minSpeechMs: number;
  /** Grace ms after a reply starts (default 600). */
  graceAfterReplyStartMs: number;
  /** Bursts shorter than this are backchannels (default 400). */
  backchannelMaxMs: number;
  /** Stop latency above this is "slow" (default 300). */
  stopLatencySlowMs: number;
  /** Max records kept (default 1000). */
  maxRecords: number;
  /** EMA alpha for the noise floor (default 0.05). */
  noiseFloorAlpha: number;
}

export function defaultBargeInV26Options(): BargeInV26Options {
  return {
    noiseFloor: VOICE_V26_NOISE_FLOOR_DEFAULT,
    thresholdMargin: VOICE_V26_THRESHOLD_MARGIN_DEFAULT,
    speakingMargin: 0.1,
    duckAfterMs: VOICE_V26_DUCK_AFTER_MS_DEFAULT,
    confirmAfterMs: VOICE_V26_CONFIRM_AFTER_MS_DEFAULT,
    minSpeechMs: VOICE_V26_MIN_SPEECH_DEFAULT_MS,
    graceAfterReplyStartMs: VOICE_V26_GRACE_AFTER_REPLY_START_MS_DEFAULT,
    backchannelMaxMs: VOICE_V26_BACKCHANNEL_MAX_MS_DEFAULT,
    stopLatencySlowMs: VOICE_V26_STOP_LATENCY_SLOW_DEFAULT_MS,
    maxRecords: VOICE_V26_MAX_RECORDS_DEFAULT,
    noiseFloorAlpha: 0.05,
  };
}

export function validateBargeInV26Options(o: Partial<BargeInV26Options>): string[] {
  const errors: string[] = [];
  const range = (v: number | undefined, lo: number, hi: number, name: string): void => {
    if (v !== undefined && !(v >= lo && v <= hi)) errors.push(`${name} must be ${lo}..${hi}`);
  };
  range(o.noiseFloor, 0, 0.9, 'noiseFloor');
  range(o.thresholdMargin, 0.01, 0.9, 'thresholdMargin');
  range(o.speakingMargin, 0, 0.9, 'speakingMargin');
  range(o.noiseFloorAlpha, 0.001, 0.5, 'noiseFloorAlpha');
  if (o.duckAfterMs !== undefined && !(o.duckAfterMs >= 0 && o.duckAfterMs <= 5000)) {
    errors.push('duckAfterMs must be 0..5000');
  }
  if (o.confirmAfterMs !== undefined && !(o.confirmAfterMs >= 50 && o.confirmAfterMs <= 10000)) {
    errors.push('confirmAfterMs must be 50..10000');
  }
  if (o.minSpeechMs !== undefined && !(o.minSpeechMs >= 0 && o.minSpeechMs <= 5000)) {
    errors.push('minSpeechMs must be 0..5000');
  }
  if (o.graceAfterReplyStartMs !== undefined && !(o.graceAfterReplyStartMs >= 0 && o.graceAfterReplyStartMs <= 10000)) {
    errors.push('graceAfterReplyStartMs must be 0..10000');
  }
  if (o.backchannelMaxMs !== undefined && !(o.backchannelMaxMs >= 0 && o.backchannelMaxMs <= 5000)) {
    errors.push('backchannelMaxMs must be 0..5000');
  }
  if (o.stopLatencySlowMs !== undefined && !(o.stopLatencySlowMs >= 50 && o.stopLatencySlowMs <= 10000)) {
    errors.push('stopLatencySlowMs must be 50..10000');
  }
  if (o.maxRecords !== undefined && (!Number.isInteger(o.maxRecords) || o.maxRecords < 10 || o.maxRecords > 100000)) {
    errors.push('maxRecords must be an integer 10..100000');
  }
  if (
    o.duckAfterMs !== undefined && o.confirmAfterMs !== undefined &&
    o.duckAfterMs > o.confirmAfterMs
  ) {
    errors.push('duckAfterMs must not exceed confirmAfterMs');
  }
  return errors;
}

/** Aggregate barge-in statistics for a session. */
export interface VoiceV26BargeInStats {
  sessionId: string;
  total: number;
  confirmed: number;
  stopped: number;
  falsePositives: number;
  backchannels: number;
  echoes: number;
  ducked: number;
  meanDecisionMs: number;
  meanStopLatencyMs: number;
  slowStops: number;
  /** Resume strategies chosen, by strategy. */
  strategies: Record<VoiceV26ResumeStrategy, number>;
}

export interface VoiceV26BackchannelNote {
  atMs: number;
  durationMs: number;
  peakEnergy: number;
  text: string | null;
}

/** One duck event (TTS gain lowered while a suspect burst runs). */
export interface VoiceV26DuckEvent {
  bargeInId: string;
  atMs: number;
  /** Gain applied to the TTS while ducking, 0..1. */
  gain: number;
}

export function createBargeInDetectorV26(
  sessionId: string,
  opts: Partial<BargeInV26Options> = {},
): BargeInDetectorV26 {
  return new BargeInDetectorV26(sessionId, opts);
}

export class BargeInDetectorV26 {
  private readonly sessionId: string;
  private readonly opts: BargeInV26Options;
  private noiseFloor: number;
  private stage: VoiceV26BargeInStage = 'none';
  private current: VoiceV26BargeInRecord | null = null;
  private speechStartMs: number | null = null;
  private lastFrameMs: number | null = null;
  private peakEnergy = 0;
  private ducked = false;
  private seq = 0;
  private agentSpeaking = false;
  private replyStartedAtMs: number | null = null;
  private replyText = '';
  private replyTurnId: string | null = null;
  private replyTurnIndex: number | null = null;
  private spokenChars = 0;
  private readonly records: VoiceV26BargeInRecord[] = [];
  private readonly ducks: VoiceV26DuckEvent[] = [];
  private readonly backchannels: VoiceV26BackchannelNote[] = [];
  private echoes = 0;
  private slowStops = 0;

  constructor(sessionId: string, opts: Partial<BargeInV26Options> = {}) {
    const errors = validateBargeInV26Options(opts);
    if (errors.length > 0) throw new Error(`Invalid BargeInV26Options: ${errors.join('; ')}`);
    this.sessionId = sessionId;
    this.opts = { ...defaultBargeInV26Options(), ...opts };
    this.noiseFloor = this.opts.noiseFloor;
  }

  options(): BargeInV26Options {
    return { ...this.opts };
  }

  noiseFloorEstimate(): number {
    return round2V26(this.noiseFloor);
  }

  /** Current adaptive threshold (higher while the agent speaks). */
  threshold(): number {
    const margin = this.opts.thresholdMargin + (this.agentSpeaking ? this.opts.speakingMargin : 0);
    return clampV26(this.noiseFloor + margin, 0, 0.99);
  }

  isAgentSpeaking(): boolean {
    return this.agentSpeaking;
  }

  isDucking(): boolean {
    return this.stage === 'ducking';
  }

  currentStage(): VoiceV26BargeInStage {
    return this.stage;
  }

  currentRecord(): VoiceV26BargeInRecord | null {
    return this.current ? { ...this.current, } : null;
  }

  /** The agent started speaking a reply (arms the grace window). */
  agentStartedSpeaking(input: {
    turnId: string;
    turnIndex: number;
    replyText: string;
    atMs: number;
  }): void {
    this.agentSpeaking = true;
    this.replyStartedAtMs = input.atMs;
    this.replyText = input.replyText;
    this.replyTurnId = input.turnId;
    this.replyTurnIndex = input.turnIndex;
    this.spokenChars = 0;
  }

  /** TTS progress: how many chars have actually been spoken. */
  agentSpeechProgress(atMs: number, spokenChars: number): void {
    void atMs;
    if (spokenChars >= 0) this.spokenChars = Math.min(spokenChars, this.replyText.length);
  }

  /** The agent finished speaking normally (no barge-in). */
  agentStoppedSpeaking(atMs: number): void {
    void atMs;
    this.agentSpeaking = false;
    this.replyStartedAtMs = null;
    this.replyText = '';
    this.replyTurnId = null;
    this.replyTurnIndex = null;
    this.spokenChars = 0;
    if (this.stage === 'suspect' || this.stage === 'ducking') {
      this.finishBurstAsBackchannelOrNoise();
    }
  }

  /**
   * Feed one audio frame. Returns what the frame decided.
   * `echo: true` marks a frame the caller knows is TTS echo.
   */
  feedFrame(frame: VoiceV26AudioFrame & { echo?: boolean; userText?: string | null }): VoiceV26FrameResult {
    const threshold = this.threshold();
    const energy = clampV26(frame.energy, 0, 1);
    const atMs = frame.atMs;
    const base: VoiceV26FrameResult = {
      stage: this.stage,
      confirmed: false,
      ducking: false,
      backchannel: false,
      echo: false,
      threshold: round2V26(threshold),
      noiseFloor: round2V26(this.noiseFloor),
      bargeInId: this.current ? this.current.id : null,
    };
    // Track the noise floor from quiet frames only.
    if (energy < this.noiseFloor + 0.02) {
      this.noiseFloor =
        this.noiseFloor * (1 - this.opts.noiseFloorAlpha) + energy * this.opts.noiseFloorAlpha;
    }
    if (frame.echo === true) {
      this.echoes += 1;
      base.echo = true;
      return base;
    }
    const isSpeech = frame.isSpeech === true || energy >= threshold;
    if (!isSpeech) {
      // Silence ends a suspect burst: short bursts are backchannels.
      if (this.stage === 'suspect' || this.stage === 'ducking') {
        const speechMs = this.speechStartMs === null ? 0 : atMs - this.speechStartMs;
        if (speechMs < this.opts.backchannelMaxMs && speechMs >= this.opts.minSpeechMs) {
          this.backchannels.push({
            atMs,
            durationMs: speechMs,
            peakEnergy: round2V26(this.peakEnergy),
            text: frame.userText ?? null,
          });
          base.backchannel = true;
        }
        this.resetBurst();
        base.stage = this.stage;
      }
      this.lastFrameMs = atMs;
      return base;
    }
    // Speech frame.
    if (this.speechStartMs === null) {
      this.speechStartMs = atMs;
      this.peakEnergy = energy;
    } else {
      this.peakEnergy = Math.max(this.peakEnergy, energy);
    }
    this.lastFrameMs = atMs;
    const speechMs = atMs - this.speechStartMs;
    // Grace window: speech right after a reply starts is overlap noise
    // unless it sustains well past the grace window.
    const inGrace =
      this.replyStartedAtMs !== null && atMs - this.replyStartedAtMs < this.opts.graceAfterReplyStartMs;
    const effectiveSpeechMs = inGrace ? Math.max(0, speechMs - this.opts.graceAfterReplyStartMs) : speechMs;
    if (this.stage === 'none' && effectiveSpeechMs >= 0 && speechMs >= 0) {
      // Open a suspect burst as soon as speech is seen.
      this.stage = 'suspect';
      this.seq += 1;
      this.current = {
        id: `bi26-${this.seq}`,
        sessionId: this.sessionId,
        turnId: this.replyTurnId,
        turnIndex: this.replyTurnIndex,
        kind: 'speech',
        stage: 'suspect',
        speechMs: 0,
        peakEnergy: round2V26(energy),
        thresholdAtConfirm: round2V26(threshold),
        ducked: false,
        decisionMs: null,
        stopLatencyMs: null,
        spokenChars: null,
        spokenText: null,
        remainingText: null,
        resumeStrategy: null,
        userText: frame.userText ?? null,
        startedAtMs: this.speechStartMs,
        confirmedAtMs: null,
        stoppedAtMs: null,
        falsePositive: false,
      };
      base.stage = 'suspect';
      base.bargeInId = this.current.id;
    }
    if (this.current) {
      this.current.speechMs = speechMs;
      this.current.peakEnergy = round2V26(this.peakEnergy);
      if (frame.userText) this.current.userText = frame.userText;
    }
    if (this.stage === 'suspect' && speechMs >= this.opts.duckAfterMs && !this.ducked) {
      this.stage = 'ducking';
      this.ducked = true;
      if (this.current) {
        this.current.stage = 'ducking';
        this.current.ducked = true;
      }
      this.ducks.push({ bargeInId: this.current ? this.current.id : '', atMs, gain: 0.25 });
      base.stage = 'ducking';
      base.ducking = true;
    }
    if (
      (this.stage === 'suspect' || this.stage === 'ducking') &&
      speechMs >= this.opts.confirmAfterMs &&
      speechMs >= this.opts.minSpeechMs
    ) {
      this.stage = 'confirmed';
      if (this.current) {
        this.current.stage = 'confirmed';
        this.current.confirmedAtMs = atMs;
        this.current.decisionMs = atMs - this.current.startedAtMs;
        this.current.thresholdAtConfirm = round2V26(threshold);
      }
      base.stage = 'confirmed';
      base.confirmed = true;
    }
    // Once confirmed, every later frame of the same burst keeps
    // reporting confirmed (the state persists until stop()).
    if (this.stage === 'confirmed') base.confirmed = true;
    return base;
  }

  /**
   * Stop the TTS after a confirmed barge-in. Keeps the spoken
   * prefix (word boundary) and the remainder, and picks a resume
   * strategy from how much of the reply was spoken.
   */
  stop(input: {
    atMs: number;
    spokenChars?: number;
    userText?: string | null;
  }): VoiceV26StopResult | null {
    if (this.stage !== 'confirmed' || !this.current) return null;
    const record = this.current;
    const spoken = input.spokenChars !== undefined
      ? Math.min(Math.max(0, input.spokenChars), this.replyText.length)
      : this.spokenChars;
    const spokenText = cutAtWordBoundaryV26(this.replyText, spoken);
    const remainingText = this.replyText.slice(spokenText.length).trimStart();
    const spokenFraction = this.replyText.length === 0 ? 1 : spokenText.length / this.replyText.length;
    const userText = input.userText ?? record.userText;
    const strategy = strategyForSpokenFractionV26(spokenFraction, userText);
    const stopLatencyMs = input.atMs - (record.confirmedAtMs ?? input.atMs);
    if (stopLatencyMs > this.opts.stopLatencySlowMs) this.slowStops += 1;
    record.stage = 'stopped';
    record.stoppedAtMs = input.atMs;
    record.stopLatencyMs = stopLatencyMs;
    record.spokenChars = spokenText.length;
    record.spokenText = spokenText;
    record.remainingText = remainingText;
    record.resumeStrategy = strategy;
    record.userText = userText;
    this.records.push({ ...record });
    if (this.records.length > this.opts.maxRecords) this.records.shift();
    this.agentSpeaking = false;
    const context: VoiceV26ResumeContext = {
      turnId: record.turnId,
      turnIndex: record.turnIndex,
      replyText: this.replyText,
      spokenText,
      remainingText,
      spokenChars: spokenText.length,
      remainingChars: remainingText.length,
      spokenFraction: round2V26(spokenFraction),
      strategy,
      userText,
      atMs: input.atMs,
    };
    const result: VoiceV26StopResult = {
      bargeInId: record.id,
      stoppedAtMs: input.atMs,
      stopLatencyMs,
      spokenChars: spokenText.length,
      spokenText,
      remainingText,
      resumeStrategy: strategy,
      context,
    };
    this.stage = 'none';
    this.current = null;
    this.resetBurstState();
    return result;
  }

  /** Mark a record as a false positive (it was not a real barge-in). */
  markFalsePositive(bargeInId: string): boolean {
    const record = this.records.find((r) => r.id === bargeInId);
    if (!record) return false;
    record.falsePositive = true;
    return true;
  }

  get(id: string): VoiceV26BargeInRecord | null {
    const found = this.records.find((r) => r.id === id);
    return found ? { ...found } : null;
  }

  list(filter: { kind?: VoiceV26BargeInKind; falsePositive?: boolean } = {}): VoiceV26BargeInRecord[] {
    return this.records
      .filter((r) => (filter.kind === undefined || r.kind === filter.kind))
      .filter((r) => (filter.falsePositive === undefined || r.falsePositive === filter.falsePositive))
      .map((r) => ({ ...r }));
  }

  ducksList(): VoiceV26DuckEvent[] {
    return this.ducks.map((d) => ({ ...d }));
  }

  backchannelsList(): VoiceV26BackchannelNote[] {
    return this.backchannels.map((b) => ({ ...b }));
  }

  count(): number {
    return this.records.length;
  }

  stats(): VoiceV26BargeInStats {
    const decisions = this.records
      .map((r) => r.decisionMs)
      .filter((v): v is number => v !== null);
    const stops = this.records
      .map((r) => r.stopLatencyMs)
      .filter((v): v is number => v !== null);
    const strategies: Record<VoiceV26ResumeStrategy, number> = {
      'resume-remaining': 0,
      'summarise-remainder': 0,
      'drop-remainder': 0,
      'ask-clarify': 0,
    };
    for (const r of this.records) {
      if (r.resumeStrategy) strategies[r.resumeStrategy] += 1;
    }
    return {
      sessionId: this.sessionId,
      total: this.records.length,
      confirmed: this.records.filter((r) => r.confirmedAtMs !== null).length,
      stopped: this.records.filter((r) => r.stoppedAtMs !== null).length,
      falsePositives: this.records.filter((r) => r.falsePositive).length,
      backchannels: this.backchannels.length,
      echoes: this.echoes,
      ducked: this.records.filter((r) => r.ducked).length,
      meanDecisionMs: decisions.length === 0 ? 0 : round2V26(decisions.reduce((a, b) => a + b, 0) / decisions.length),
      meanStopLatencyMs: stops.length === 0 ? 0 : round2V26(stops.reduce((a, b) => a + b, 0) / stops.length),
      slowStops: this.slowStops,
      strategies,
    };
  }

  reset(): void {
    this.records.length = 0;
    this.ducks.length = 0;
    this.backchannels.length = 0;
    this.echoes = 0;
    this.slowStops = 0;
    this.stage = 'none';
    this.current = null;
    this.resetBurstState();
    this.agentSpeaking = false;
    this.replyStartedAtMs = null;
    this.replyText = '';
    this.replyTurnId = null;
    this.replyTurnIndex = null;
    this.spokenChars = 0;
  }

  summary(): string {
    const s = this.stats();
    return (
      `barge-in v26 ${this.sessionId}: ${s.total} barge-ins ` +
      `(${s.stopped} stopped, ${s.falsePositives} false positives, ` +
      `${s.backchannels} backchannels, ${s.echoes} echo frames), ` +
      `mean decision ${s.meanDecisionMs}ms, mean stop ${s.meanStopLatencyMs}ms, ` +
      `${s.slowStops} slow stops`
    );
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '# Barge-in v26',
      '',
      `Session: \`${this.sessionId}\``,
      '',
      `- Total: ${s.total}`,
      `- Stopped: ${s.stopped}`,
      `- False positives: ${s.falsePositives}`,
      `- Backchannels: ${s.backchannels}`,
      `- Echo frames ignored: ${s.echoes}`,
      `- Ducked: ${s.ducked}`,
      `- Mean decision: ${s.meanDecisionMs}ms`,
      `- Mean stop latency: ${s.meanStopLatencyMs}ms`,
      `- Slow stops (>${this.opts.stopLatencySlowMs}ms): ${s.slowStops}`,
      '',
      '## Records',
      '',
      '| id | kind | speech ms | decision ms | stop ms | spoken | strategy |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const r of this.records) {
      lines.push(
        `| ${r.id} | ${r.kind} | ${r.speechMs} | ${r.decisionMs ?? '-'} | ` +
        `${r.stopLatencyMs ?? '-'} | ${r.spokenChars ?? '-'} | ${r.resumeStrategy ?? '-'} |`,
      );
    }
    return lines.join('\n');
  }

  private finishBurstAsBackchannelOrNoise(): void {
    if (this.current && this.speechStartMs !== null && this.lastFrameMs !== null) {
      const speechMs = this.lastFrameMs - this.speechStartMs;
      if (speechMs >= this.opts.minSpeechMs && speechMs < this.opts.backchannelMaxMs) {
        this.backchannels.push({
          atMs: this.lastFrameMs,
          durationMs: speechMs,
          peakEnergy: round2V26(this.peakEnergy),
          text: this.current.userText,
        });
      }
    }
    this.resetBurst();
  }

  private resetBurst(): void {
    this.stage = 'none';
    this.current = null;
    this.resetBurstState();
  }

  private resetBurstState(): void {
    this.speechStartMs = null;
    this.lastFrameMs = null;
    this.peakEnergy = 0;
    this.ducked = false;
  }
}
