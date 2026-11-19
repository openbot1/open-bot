/**
 * Silence detection for voice v25 (v1.38, Team T5).
 *
 * The turn-taking layer needs to know, in ms, when the user
 * is silent and for how long — not just that an utterance
 * ended. This detector sits above the frame-level endpointing
 * of v23 (which decides when one *utterance* ends) and answers
 * the turn-level questions:
 *
 *   - is the channel silent right now, and for how long?
 *   - has this silence run long enough to hand the floor over
 *     (`yieldThresholdMs` — the agent may start speaking)?
 *   - how much silence did this turn contain in total, and
 *     what was its longest single gap?
 *
 * Input is caller-supplied: either per-frame energies
 * (0..1 RMS, mock/synthetic — never real audio here) or
 * boolean speech flags from the host's own VAD. The energy
 * threshold follows a measured noise floor (exponential
 * moving average of the quiet frames), so the same detector
 * works in a quiet room and a noisy office without retuning
 * by hand. Short blips never flip the state: speech needs
 * `minSpeechMs` of continuous energy, silence needs
 * `silenceThresholdMs` of continuous quiet.
 *
 * All clocks virtual (the caller passes `atMs`); nothing here
 * touches audio hardware, a network or a provider.
 */
import {
  clampV25,
  formatDurationV25,
  isValidVoiceV25Id,
  round2V25,
  round4V25,
  VOICE_V25_MIN_SPEECH_DEFAULT_MS,
  VOICE_V25_SILENCE_DEFAULT_MS,
  VOICE_V25_SILENCE_YIELD_DEFAULT_MS,
  type VoiceV25SilenceGap,
  type VoiceV25SilenceState,
} from './types';

export interface SilenceDetectorV25Options {
  /** Continuous quiet ms before the state flips to silence (default 700). */
  silenceThresholdMs: number;
  /** Silence ms after which the floor is yielded (default 1200). */
  yieldThresholdMs: number;
  /** Continuous speech ms before the state flips to speech (default 150). */
  minSpeechMs: number;
  /** Starting noise-floor energy 0..1 (default 0.02). */
  initialNoiseFloor: number;
  /** Energy above noiseFloor * thresholdFactor counts as speech (default 3). */
  thresholdFactor: number;
  /** EMA rate for the noise floor (0..1, default 0.05). */
  adaptRate: number;
  /** Max silence gaps kept per detector (oldest dropped, default 1000). */
  maxGaps: number;
}

export function defaultSilenceDetectorV25Options(): SilenceDetectorV25Options {
  return {
    silenceThresholdMs: VOICE_V25_SILENCE_DEFAULT_MS,
    yieldThresholdMs: VOICE_V25_SILENCE_YIELD_DEFAULT_MS,
    minSpeechMs: VOICE_V25_MIN_SPEECH_DEFAULT_MS,
    initialNoiseFloor: 0.02,
    thresholdFactor: 3,
    adaptRate: 0.05,
    maxGaps: 1000,
  };
}

export function validateSilenceDetectorV25Options(
  o: Partial<SilenceDetectorV25Options>,
): string[] {
  const errors: string[] = [];
  if (o.silenceThresholdMs !== undefined && !(o.silenceThresholdMs >= 50 && o.silenceThresholdMs <= 10000)) {
    errors.push('silenceThresholdMs must be 50..10000');
  }
  if (o.yieldThresholdMs !== undefined && !(o.yieldThresholdMs >= 100 && o.yieldThresholdMs <= 30000)) {
    errors.push('yieldThresholdMs must be 100..30000');
  }
  if (
    o.silenceThresholdMs !== undefined &&
    o.yieldThresholdMs !== undefined &&
    o.yieldThresholdMs < o.silenceThresholdMs
  ) {
    errors.push('yieldThresholdMs must be >= silenceThresholdMs');
  }
  if (o.minSpeechMs !== undefined && !(o.minSpeechMs >= 20 && o.minSpeechMs <= 5000)) {
    errors.push('minSpeechMs must be 20..5000');
  }
  if (o.initialNoiseFloor !== undefined && !(o.initialNoiseFloor >= 0 && o.initialNoiseFloor <= 0.5)) {
    errors.push('initialNoiseFloor must be 0..0.5');
  }
  if (o.thresholdFactor !== undefined && !(o.thresholdFactor >= 1 && o.thresholdFactor <= 20)) {
    errors.push('thresholdFactor must be 1..20');
  }
  if (o.adaptRate !== undefined && !(o.adaptRate >= 0 && o.adaptRate <= 1)) {
    errors.push('adaptRate must be 0..1');
  }
  if (o.maxGaps !== undefined && (!Number.isInteger(o.maxGaps) || o.maxGaps < 10 || o.maxGaps > 100000)) {
    errors.push('maxGaps must be an integer 10..100000');
  }
  return errors;
}

/** One event the detector emits while frames flow in. */
export type VoiceV25SilenceEventKind =
  | 'speech-start'
  | 'speech-end'
  | 'silence-start'
  | 'silence-end'
  | 'yield';

export interface VoiceV25SilenceEvent {
  kind: VoiceV25SilenceEventKind;
  sessionId: string;
  turnId: string | null;
  atMs: number;
  /** Duration of the run that just ended (speech run or silence gap), ms. */
  durationMs: number;
  /** Gap id for silence-start / silence-end / yield. */
  gapId: string | null;
  /** Current noise floor estimate at event time. */
  noiseFloor: number;
}

/** Silence statistics for one turn (or the whole session). */
export interface VoiceV25SilenceStats {
  sessionId: string;
  turnId: string | null;
  gaps: number;
  /** Total silence ms across finished gaps. */
  totalSilenceMs: number;
  longestSilenceMs: number;
  meanSilenceMs: number;
  /** Gaps that ran past the yield threshold. */
  yieldedGaps: number;
  /** Silence ms still open right now (0 when speaking). */
  currentSilenceMs: number;
  state: VoiceV25SilenceState;
}

export function createSilenceDetectorV25(
  sessionId: string,
  opts: Partial<SilenceDetectorV25Options> = {},
): SilenceDetectorV25 {
  return new SilenceDetectorV25(sessionId, opts);
}

export class SilenceDetectorV25 {
  readonly sessionId: string;
  private readonly opts: SilenceDetectorV25Options;
  private state: VoiceV25SilenceState = 'unknown';
  /** Start of the current candidate run (speech or silence), ms. */
  private runStartedAtMs: number | null = null;
  /** Energy-class of the current candidate run. */
  private runIsSpeech: boolean | null = null;
  private noiseFloor: number;
  private readonly gaps = new Map<string, VoiceV25SilenceGap>();
  private readonly gapOrder: string[] = [];
  private openGapId: string | null = null;
  private gapSeq = 0;
  private lastAtMs: number | null = null;
  private yieldedGapIds = new Set<string>();

  constructor(sessionId: string, opts: Partial<SilenceDetectorV25Options> = {}) {
    if (!isValidVoiceV25Id(sessionId)) throw new Error(`Invalid sessionId "${sessionId}"`);
    const errors = validateSilenceDetectorV25Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid SilenceDetectorV25 options: ${errors.join('; ')}`);
    }
    const merged = { ...defaultSilenceDetectorV25Options(), ...opts };
    if (merged.yieldThresholdMs < merged.silenceThresholdMs) {
      throw new Error('Invalid SilenceDetectorV25 options: yieldThresholdMs must be >= silenceThresholdMs');
    }
    this.sessionId = sessionId;
    this.opts = merged;
    this.noiseFloor = merged.initialNoiseFloor;
  }

  options(): SilenceDetectorV25Options {
    return { ...this.opts };
  }

  stateOf(): VoiceV25SilenceState {
    return this.state;
  }

  noiseFloorOf(): number {
    return round4V25(this.noiseFloor);
  }

  /** Set the noise floor directly (host measured the room). */
  setNoiseFloor(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 0.5) {
      throw new Error('noise floor must be a finite number 0..0.5');
    }
    this.noiseFloor = value;
  }

  /** Energy above the adaptive threshold counts as speech. */
  thresholdOf(): number {
    return this.noiseFloor * this.opts.thresholdFactor;
  }

  /**
   * Feed one frame's energy (0..1 RMS) at `atMs`. Returns the
   * events the frame caused (usually none — state flips only
   * after the debounce thresholds are met).
   */
  feedEnergy(energy: number, atMs: number, turnId: string | null = null): VoiceV25SilenceEvent[] {
    if (!Number.isFinite(energy) || energy < 0 || energy > 1) {
      throw new Error('energy must be a finite number 0..1');
    }
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    if (this.lastAtMs !== null && atMs < this.lastAtMs) {
      throw new Error(`atMs ${atMs} is before previous frame ${this.lastAtMs}`);
    }
    this.lastAtMs = atMs;
    const isSpeech = energy >= this.thresholdOf();
    // Quiet frames pull the floor down slowly; loud frames never do.
    if (!isSpeech) {
      this.noiseFloor = this.noiseFloor * (1 - this.opts.adaptRate) + energy * this.opts.adaptRate;
    }
    return this.feedClassified(isSpeech, atMs, turnId);
  }

  /**
   * Feed one boolean frame from the host's own VAD
   * (true = speech). Same debouncing and gap tracking as
   * `feedEnergy`, without the noise-floor adaptation.
   */
  feedSpeech(isSpeech: boolean, atMs: number, turnId: string | null = null): VoiceV25SilenceEvent[] {
    if (typeof isSpeech !== 'boolean') throw new Error('isSpeech must be a boolean');
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    if (this.lastAtMs !== null && atMs < this.lastAtMs) {
      throw new Error(`atMs ${atMs} is before previous frame ${this.lastAtMs}`);
    }
    this.lastAtMs = atMs;
    return this.feedClassified(isSpeech, atMs, turnId);
  }

  private feedClassified(
    isSpeech: boolean,
    atMs: number,
    turnId: string | null,
  ): VoiceV25SilenceEvent[] {
    const events: VoiceV25SilenceEvent[] = [];
    if (this.runIsSpeech === null) {
      // First frame: start a candidate run, state still unknown.
      this.runIsSpeech = isSpeech;
      this.runStartedAtMs = atMs;
      return events;
    }
    if (isSpeech === this.runIsSpeech) {
      // Same class continues — check whether the run is now long
      // enough to flip the confirmed state.
      const runMs = atMs - (this.runStartedAtMs ?? atMs);
      if (isSpeech && this.state !== 'speech' && runMs >= this.opts.minSpeechMs) {
        events.push(...this.enterSpeech(atMs, runMs, turnId));
      } else if (!isSpeech && this.state !== 'silence' && runMs >= this.opts.silenceThresholdMs) {
        events.push(...this.enterSilence(atMs, runMs, turnId));
      } else if (!isSpeech && this.state === 'silence') {
        // Silence continues — check the yield line.
        const gap = this.openGapId === null ? undefined : this.gaps.get(this.openGapId);
        if (gap !== undefined && !gap.yielded && atMs - gap.startedAtMs >= this.opts.yieldThresholdMs) {
          gap.yielded = true;
          this.yieldedGapIds.add(gap.id);
          events.push({
            kind: 'yield',
            sessionId: this.sessionId,
            turnId,
            atMs,
            durationMs: atMs - gap.startedAtMs,
            gapId: gap.id,
            noiseFloor: round4V25(this.noiseFloor),
          });
        }
      }
      return events;
    }
    // Class flipped: the old run ends, a new candidate run starts.
    const runMs = atMs - (this.runStartedAtMs ?? atMs);
    if (this.runIsSpeech && this.state === 'speech') {
      events.push({
        kind: 'speech-end',
        sessionId: this.sessionId,
        turnId,
        atMs,
        durationMs: runMs,
        gapId: null,
        noiseFloor: round4V25(this.noiseFloor),
      });
    }
    this.runIsSpeech = isSpeech;
    this.runStartedAtMs = atMs;
    // A fresh speech run after silence closes the open gap.
    if (isSpeech && this.state === 'silence') {
      events.push(...this.closeGap(atMs, true, turnId));
    }
    return events;
  }

  private enterSpeech(atMs: number, runMs: number, turnId: string | null): VoiceV25SilenceEvent[] {
    this.state = 'speech';
    return [{
      kind: 'speech-start',
      sessionId: this.sessionId,
      turnId,
      atMs,
      durationMs: runMs,
      gapId: null,
      noiseFloor: round4V25(this.noiseFloor),
    }];
  }

  private enterSilence(atMs: number, runMs: number, turnId: string | null): VoiceV25SilenceEvent[] {
    this.state = 'silence';
    this.gapSeq += 1;
    const gap: VoiceV25SilenceGap = {
      id: `gap-${this.gapSeq}`,
      sessionId: this.sessionId,
      turnId,
      startedAtMs: atMs - runMs,
      endedAtMs: null,
      durationMs: null,
      endedBySpeech: false,
      yielded: false,
    };
    this.gaps.set(gap.id, gap);
    this.gapOrder.push(gap.id);
    this.openGapId = gap.id;
    this.prune();
    return [{
      kind: 'silence-start',
      sessionId: this.sessionId,
      turnId,
      atMs,
      durationMs: runMs,
      gapId: gap.id,
      noiseFloor: round4V25(this.noiseFloor),
    }];
  }

  private closeGap(atMs: number, endedBySpeech: boolean, turnId: string | null): VoiceV25SilenceEvent[] {
    const events: VoiceV25SilenceEvent[] = [];
    if (this.openGapId === null) return events;
    const gap = this.gaps.get(this.openGapId);
    this.openGapId = null;
    if (gap === undefined) return events;
    gap.endedAtMs = atMs;
    gap.durationMs = atMs - gap.startedAtMs;
    gap.endedBySpeech = endedBySpeech;
    // The gap is over, but the new speech run is not confirmed
    // yet (it still needs minSpeechMs): the confirmed state
    // goes back to 'unknown' so the speech-start event fires
    // when the run is confirmed, instead of being swallowed.
    this.state = 'unknown';
    events.push({
      kind: 'silence-end',
      sessionId: this.sessionId,
      turnId: turnId ?? gap.turnId,
      atMs,
      durationMs: gap.durationMs,
      gapId: gap.id,
      noiseFloor: round4V25(this.noiseFloor),
    });
    return events;
  }

  /**
   * Close the open gap because the turn/session ended (not
   * because speech resumed). The gap is kept with
   * `endedBySpeech: false`.
   */
  endTurn(atMs: number, turnId: string | null = null): VoiceV25SilenceEvent[] {
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    const events: VoiceV25SilenceEvent[] = [];
    if (this.openGapId !== null) {
      const gap = this.gaps.get(this.openGapId);
      this.openGapId = null;
      if (gap !== undefined) {
        gap.endedAtMs = atMs;
        gap.durationMs = atMs - gap.startedAtMs;
        gap.endedBySpeech = false;
        events.push({
          kind: 'silence-end',
          sessionId: this.sessionId,
          turnId: turnId ?? gap.turnId,
          atMs,
          durationMs: gap.durationMs,
          gapId: gap.id,
          noiseFloor: round4V25(this.noiseFloor),
        });
      }
    }
    this.state = 'unknown';
    this.runIsSpeech = null;
    this.runStartedAtMs = null;
    return events;
  }

  /** Current silence run length in ms (0 while speaking/unknown). */
  currentSilenceMs(atMs: number): number {
    if (this.state !== 'silence' || this.openGapId === null) return 0;
    const gap = this.gaps.get(this.openGapId);
    if (gap === undefined) return 0;
    return Math.max(0, atMs - gap.startedAtMs);
  }

  /** True once the current silence has run past the yield line. */
  shouldYield(atMs: number): boolean {
    return this.currentSilenceMs(atMs) >= this.opts.yieldThresholdMs;
  }

  gapsList(turnId?: string | null): VoiceV25SilenceGap[] {
    const out: VoiceV25SilenceGap[] = [];
    for (const id of this.gapOrder) {
      const gap = this.gaps.get(id);
      if (gap === undefined) continue;
      if (turnId !== undefined && gap.turnId !== turnId) continue;
      out.push({ ...gap });
    }
    return out;
  }

  stats(turnId?: string | null, atMs = 0): VoiceV25SilenceStats {
    const gaps = this.gapsList(turnId).filter((g) => g.durationMs !== null);
    const durations = gaps.map((g) => g.durationMs as number);
    const total = durations.reduce((a, b) => a + b, 0);
    return {
      sessionId: this.sessionId,
      turnId: turnId ?? null,
      gaps: gaps.length,
      totalSilenceMs: total,
      longestSilenceMs: durations.length === 0 ? 0 : Math.max(...durations),
      meanSilenceMs: durations.length === 0 ? 0 : round2V25(total / durations.length),
      yieldedGaps: gaps.filter((g) => g.yielded).length,
      currentSilenceMs: turnId === undefined ? this.currentSilenceMs(atMs) : 0,
      state: this.state,
    };
  }

  count(): number {
    return this.gaps.size;
  }

  reset(): void {
    this.state = 'unknown';
    this.runStartedAtMs = null;
    this.runIsSpeech = null;
    this.noiseFloor = this.opts.initialNoiseFloor;
    this.gaps.clear();
    this.gapOrder.length = 0;
    this.openGapId = null;
    this.gapSeq = 0;
    this.lastAtMs = null;
    this.yieldedGapIds.clear();
  }

  private prune(): void {
    while (this.gapOrder.length > this.opts.maxGaps) {
      const oldestId = this.gapOrder[0];
      const oldest = this.gaps.get(oldestId);
      if (oldest !== undefined && this.openGapId === oldestId) {
        // Never prune the open gap: drop the oldest *finished* one.
        const finishedIdx = this.gapOrder.findIndex(
          (id) => this.gaps.get(id)?.endedAtMs !== null,
        );
        if (finishedIdx === -1) return;
        const dropId = this.gapOrder[finishedIdx];
        this.gapOrder.splice(finishedIdx, 1);
        this.gaps.delete(dropId);
      } else {
        this.gapOrder.shift();
        this.gaps.delete(oldestId);
      }
    }
  }

  summary(turnId?: string | null, atMs = 0): string {
    const s = this.stats(turnId, atMs);
    const scope = turnId === undefined || turnId === null ? `Session ${this.sessionId}` : `Turn ${turnId}`;
    return (
      `${scope}: ${s.gaps} silence gaps, ${formatDurationV25(s.totalSilenceMs)} total silence, ` +
      `longest ${formatDurationV25(s.longestSilenceMs)}, ${s.yieldedGaps} yielded the floor, ` +
      `state ${s.state}, noise floor ${this.noiseFloorOf()}.`
    );
  }

  markdown(turnId?: string | null, atMs = 0): string {
    const s = this.stats(turnId, atMs);
    const title = turnId === undefined || turnId === null
      ? `# Voice v25 silence — session ${this.sessionId}`
      : `# Voice v25 silence — turn ${turnId}`;
    const lines: string[] = [title, ''];
    lines.push(`Gaps: ${s.gaps}; total silence: ${formatDurationV25(s.totalSilenceMs)}; longest: ${formatDurationV25(s.longestSilenceMs)}; mean: ${formatDurationV25(s.meanSilenceMs)}.`);
    lines.push(`Yielded gaps: ${s.yieldedGaps}; current state: ${s.state}; noise floor: ${this.noiseFloorOf()}.`);
    const gaps = this.gapsList(turnId);
    if (gaps.length > 0) {
      lines.push('', '| Gap | Started | Duration | Yielded | Ended by |');
      lines.push('| --- | ---: | ---: | ---: | --- |');
      for (const g of gaps) {
        lines.push(
          `| ${g.id} | ${g.startedAtMs}ms | ${g.durationMs === null ? 'open' : formatDurationV25(g.durationMs)} | ${g.yielded ? 'yes' : 'no'} | ${g.endedAtMs === null ? 'open' : g.endedBySpeech ? 'speech' : 'turn end'} |`,
        );
      }
    }
    return lines.join('\n');
  }
}

/** Clamp helper re-exported for callers that only import this module. */
export { clampV25 };
