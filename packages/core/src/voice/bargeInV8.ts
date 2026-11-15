/**
 * Full-duplex barge-in v8 (v1.09, Đội T5 — voice realtime v8).
 *
 * v7 grades the interruption (duck vs interrupt) and keeps the cut
 * word — but it hears the speaker's own voice bleeding back into
 * the mic as if it were the user (the classic self-interrupt), and
 * when it cancels the TTS it does not account for *what* was left
 * in the playback queue: how many words / ms of audio were
 * discarded, and where the reply stopped. v8 closes both gaps:
 *
 *   - AEC-lite: the session feeds the controller the playback
 *     reference (`notePlaybackFrame`) alongside each mic frame.
 *     The controller keeps a short ring of recent playback
 *     frames, estimates the echo in the mic signal (scaled
 *     playback, gain learned from quiet moments when the user
 *     is not speaking), subtracts it, and decides on the
 *     *residual* RMS — the user's voice after the speaker's echo
 *     is removed. Echo-heavy frames are down-weighted instead of
 *     firing an interrupt. No native dependency: the estimate is
 *     a per-frame scalar gain + sample subtraction on 20 ms
 *     windows, good enough to kill the self-interrupt without a
 *     real AEC library.
 *   - Playback queue with exact cancel accounting:
 *     `PlaybackQueueV8` holds the model's reply as words with
 *     per-word audio durations. `cancelFrom(wordIndex)` drops
 *     everything from the cut word on and returns the receipt:
 *     words played, words discarded, audio ms played, audio ms
 *     discarded, the remaining text, and the exact resume point
 *     (word index + audio offset ms). The session can re-queue
 *     the remainder later instead of re-generating it.
 *   - Interrupt while thinking: v7 only interrupts while the
 *     model speaks. v8 also accepts an interrupt while the model
 *     is *thinking* (generating, no audio yet) — the pending
 *     reply is discarded before a single word is spoken, and the
 *     user's new line becomes the turn. The state machine knows
 *     `thinking` as a separate interruptible phase.
 *   - Sensitivity + debounce stay configurable (same shape as
 *     v7: energy threshold, debounce frames, grace window, echo
 *     window, cooldown), plus `echoGain` / `echoLearnRate` for
 *     the AEC and `maxResidualRatio` — the residual must be this
 *     much of the raw mic energy before it counts, so a frame
 *     that is *mostly* echo never interrupts.
 *
 * The v7 controller still owns the graded policy where it is used;
 * v8 is the full-duplex layer above it (the session feeds v8, v8
 * decides interrupt / duck / ignore on residual audio, the session
 * cancels the TTS queue and keeps the receipt).
 */
import { LatencyHistogram, type LatencyHistogramSummary } from './latencyPipeline';
import { isValidPcm16Frame, pcm16Rms, pcm16Sample } from './audio';

/** Barge-in v8 state, as the panel renders it. */
export type BargeInV8State = 'idle' | 'listening' | 'thinking' | 'speaking' | 'ducked' | 'interrupted' | 'cooldown';

/** Why one audio frame (or speech event) did not interrupt. */
export type BargeInV8IgnoreReason =
  | 'not-speaking'
  | 'below-energy'
  | 'echo-only'
  | 'no-vad'
  | 'debouncing'
  | 'grace'
  | 'echo-window'
  | 'cooldown';

/** What v8 decided about one audio frame. */
export type BargeInV8Action = 'interrupt' | 'duck' | 'ignore';

/** Phase the model is in when the frame arrives. */
export type BargeInV8ModelPhase = 'idle' | 'thinking' | 'speaking';

/** One decision, with the AEC numbers attached so the panel can show *why*. */
export interface BargeInV8Decision {
  action: BargeInV8Action;
  reason: BargeInV8IgnoreReason | 'confirmed' | 'confirmed-duck' | 'confirmed-thinking';
  /** Consecutive loud+VAD frames seen (debounce progress). */
  frames: number;
  /** Frames still needed before an interrupt fires. */
  framesNeeded: number;
  /** Raw mic RMS of the frame. */
  rms: number;
  /** Residual RMS after echo subtraction. */
  residualRms: number;
  /** Estimated echo RMS in this frame. */
  echoRms: number;
  /** Residual share of the raw energy (0..1). */
  residualRatio: number;
  /** Confidence of the frame (0..1, from the VAD when given). */
  confidence: number;
  /** Model phase when decided. */
  phase: BargeInV8ModelPhase;
  /** State after this decision. */
  state: BargeInV8State;
  at: number;
}

/** Receipt for cancelling the playback queue. */
export interface BargeInV8InterruptResult {
  /** True when the cancel was actually sent. */
  stopped: boolean;
  /** Wall time of the stop (ms) — measured, not estimated. */
  stopLatencyMs: number | null;
  /** True when the stop beat the 50 ms budget. */
  withinBudget: boolean;
  /** Words already spoken before the cut. */
  wordsPlayed: number;
  /** Words discarded (never spoken). */
  wordsDiscarded: number;
  /** Audio ms already played before the cut. */
  audioPlayedMs: number;
  /** Audio ms discarded from the queue. */
  audioDiscardedMs: number;
  /** Text the model had spoken before being cut ('' when none). */
  spokenText: string;
  /** Text that was queued but never spoken. */
  remainingText: string;
  /** Word index where the reply was cut. */
  cutWordIndex: number;
  /** Audio offset (ms) where the reply was cut. */
  cutAudioOffsetMs: number;
}

/** One queued reply word with its audio duration. */
export interface PlaybackWordV8 {
  word: string;
  /** Audio duration of this word (ms). */
  durationMs: number;
  /** True once the word has been spoken. */
  played: boolean;
}

/** Stats for the panel / diagnostics / tools. */
export interface BargeInV8Stats {
  state: BargeInV8State;
  interrupts: number;
  thinkingInterrupts: number;
  ducks: number;
  ignored: number;
  ignoredByReason: Record<BargeInV8IgnoreReason, number>;
  /** Echo-only frames rejected by the AEC (would have interrupted in v7). */
  echoOnlyFrames: number;
  /** Mean residual ratio of interrupted frames (0..1). */
  meanResidualRatio: number | null;
  /** Current learned echo gain (0..1). */
  echoGain: number;
  /** Total audio ms discarded by interrupts. */
  totalAudioDiscardedMs: number;
  /** Total words discarded by interrupts. */
  totalWordsDiscarded: number;
  stopLatency: LatencyHistogramSummary | null;
  /** Interrupts in the last minute (rate guard). */
  interruptsLastMinute: number;
}

/** Caller-supplied options (all optional). */
export interface BargeInV8Options {
  /** RMS above which a frame is loud enough to consider (default 0.03). */
  energyThreshold?: number;
  /** Consecutive loud+VAD frames before an interrupt (default 2). */
  debounceFrames?: number;
  /** Debounce window (ms) — frames older than this reset the count (default 500). */
  debounceWindowMs?: number;
  /** VAD must confirm speech (default true). */
  vadRequired?: boolean;
  /** Stop-budget for the TTS cancel (ms, default 50). */
  stopBudgetMs?: number;
  /** First ms of a reply are uninterruptible (default 300). */
  graceMs?: number;
  /** Frames arriving within this window of speech start are echo-suspect (default 400). */
  echoWindowMs?: number;
  /** In the echo window, the frame must be this much louder than the echo estimate (default 2). */
  echoMultiplier?: number;
  /** Duck lasts this long (ms, default 1200). */
  duckMs?: number;
  /** After an interrupt, refuse new ones for this long (ms, default 800). */
  cooldownMs?: number;
  /** Minimum VAD confidence for an interrupt (default 0.5). */
  minConfidence?: number;
  /** Energy threshold for a duck (below the interrupt threshold, default 0.02). */
  duckThreshold?: number;
  /** Initial echo gain (0..1, default 0.4). */
  echoGain?: number;
  /** Learning rate for the echo gain in quiet moments (default 0.05). */
  echoLearnRate?: number;
  /** Residual must be at least this share of raw energy (default 0.35). */
  maxResidualRatio?: number;
  /** How many playback frames the AEC ring keeps (default 25 = 500 ms at 20 ms). */
  echoRingFrames?: number;
  /** Inject the clock (tests). Defaults to Date.now. */
  clock?: () => number;
}

export const BARGE_IN_V8_DEFAULT_ENERGY_THRESHOLD = 0.03;
export const BARGE_IN_V8_DEFAULT_DEBOUNCE_FRAMES = 2;
export const BARGE_IN_V8_DEFAULT_DEBOUNCE_WINDOW_MS = 500;
export const BARGE_IN_V8_DEFAULT_STOP_BUDGET_MS = 50;
export const BARGE_IN_V8_DEFAULT_GRACE_MS = 300;
export const BARGE_IN_V8_DEFAULT_ECHO_WINDOW_MS = 400;
export const BARGE_IN_V8_DEFAULT_ECHO_MULTIPLIER = 2;
export const BARGE_IN_V8_DEFAULT_DUCK_MS = 1200;
export const BARGE_IN_V8_DEFAULT_COOLDOWN_MS = 800;
export const BARGE_IN_V8_DEFAULT_MIN_CONFIDENCE = 0.5;
export const BARGE_IN_V8_DEFAULT_DUCK_THRESHOLD = 0.02;
export const BARGE_IN_V8_DEFAULT_ECHO_GAIN = 0.4;
export const BARGE_IN_V8_DEFAULT_ECHO_LEARN_RATE = 0.05;
export const BARGE_IN_V8_DEFAULT_MAX_RESIDUAL_RATIO = 0.35;
export const BARGE_IN_V8_DEFAULT_ECHO_RING_FRAMES = 25;
/** Default per-word audio duration when the caller gives no timing (ms). */
export const BARGE_IN_V8_DEFAULT_WORD_MS = 300;

export function defaultBargeInV8Options(): Required<Omit<BargeInV8Options, 'clock'>> {
  return {
    energyThreshold: BARGE_IN_V8_DEFAULT_ENERGY_THRESHOLD,
    debounceFrames: BARGE_IN_V8_DEFAULT_DEBOUNCE_FRAMES,
    debounceWindowMs: BARGE_IN_V8_DEFAULT_DEBOUNCE_WINDOW_MS,
    vadRequired: true,
    stopBudgetMs: BARGE_IN_V8_DEFAULT_STOP_BUDGET_MS,
    graceMs: BARGE_IN_V8_DEFAULT_GRACE_MS,
    echoWindowMs: BARGE_IN_V8_DEFAULT_ECHO_WINDOW_MS,
    echoMultiplier: BARGE_IN_V8_DEFAULT_ECHO_MULTIPLIER,
    duckMs: BARGE_IN_V8_DEFAULT_DUCK_MS,
    cooldownMs: BARGE_IN_V8_DEFAULT_COOLDOWN_MS,
    minConfidence: BARGE_IN_V8_DEFAULT_MIN_CONFIDENCE,
    duckThreshold: BARGE_IN_V8_DEFAULT_DUCK_THRESHOLD,
    echoGain: BARGE_IN_V8_DEFAULT_ECHO_GAIN,
    echoLearnRate: BARGE_IN_V8_DEFAULT_ECHO_LEARN_RATE,
    maxResidualRatio: BARGE_IN_V8_DEFAULT_MAX_RESIDUAL_RATIO,
    echoRingFrames: BARGE_IN_V8_DEFAULT_ECHO_RING_FRAMES,
  };
}

/** Validate options; returns human-readable problems (empty = valid). */
export function validateBargeInV8Options(options: BargeInV8Options): string[] {
  const problems: string[] = [];
  const num = (name: keyof BargeInV8Options, min: number, max: number): void => {
    const v = options[name];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)) {
      problems.push(`${String(name)} must be a number in [${min}, ${max}]`);
    }
  };
  num('energyThreshold', 0.001, 0.5);
  num('debounceFrames', 1, 20);
  num('debounceWindowMs', 50, 5000);
  num('stopBudgetMs', 1, 5000);
  num('graceMs', 0, 5000);
  num('echoWindowMs', 0, 5000);
  num('echoMultiplier', 1, 10);
  num('duckMs', 0, 10000);
  num('cooldownMs', 0, 10000);
  num('minConfidence', 0, 1);
  num('duckThreshold', 0.001, 0.5);
  num('echoGain', 0, 1);
  num('echoLearnRate', 0, 1);
  num('maxResidualRatio', 0, 1);
  num('echoRingFrames', 1, 200);
  if (
    options.duckThreshold !== undefined &&
    options.energyThreshold !== undefined &&
    options.duckThreshold >= options.energyThreshold
  ) {
    problems.push('duckThreshold must be below energyThreshold');
  }
  return problems;
}

/** Split text into words (same shape as v7's splitWords, kept local so v8 stands alone). */
export function splitWordsV8(text: string): string[] {
  return String(text ?? '')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/**
 * Playback queue: the model's reply as words with per-word audio
 * durations. The session enqueues the reply, marks words played
 * as the TTS speaks them, and `cancelFrom` drops the remainder
 * with an exact receipt. Re-queueing the remainder later resumes
 * the reply from the cut word instead of re-generating it.
 */
export class PlaybackQueueV8 {
  private words: PlaybackWordV8[] = [];
  private playedMs = 0;
  private discardedMs = 0;
  private discardedWords = 0;

  /** Enqueue a reply (replaces any queued remainder). */
  enqueue(text: string, wordMs?: number | number[]): PlaybackWordV8[] {
    const list = splitWordsV8(text);
    this.words = list.map((word, i) => ({
      word,
      durationMs:
        Array.isArray(wordMs) && typeof wordMs[i] === 'number'
          ? Math.max(0, wordMs[i] as number)
          : typeof wordMs === 'number'
            ? Math.max(0, wordMs)
            : BARGE_IN_V8_DEFAULT_WORD_MS,
      played: false,
    }));
    this.playedMs = 0;
    return this.words.map((w) => ({ ...w }));
  }

  /** Mark words up to (exclusive) `wordIndex` as played. */
  markPlayedUpTo(wordIndex: number): void {
    for (let i = 0; i < Math.min(wordIndex, this.words.length); i += 1) {
      const w = this.words[i];
      if (w && !w.played) {
        w.played = true;
        this.playedMs += w.durationMs;
      }
    }
  }

  /** Mark one word played (the TTS just spoke it). */
  markWordPlayed(wordIndex: number): void {
    const w = this.words[wordIndex];
    if (w && !w.played) {
      w.played = true;
      this.playedMs += w.durationMs;
    }
  }

  getWords(): PlaybackWordV8[] {
    return this.words.map((w) => ({ ...w }));
  }

  getPlayedCount(): number {
    return this.words.filter((w) => w.played).length;
  }

  getQueuedCount(): number {
    return this.words.filter((w) => !w.played).length;
  }

  getPlayedMs(): number {
    return this.playedMs;
  }

  getRemainingMs(): number {
    return this.words.filter((w) => !w.played).reduce((a, w) => a + w.durationMs, 0);
  }

  getSpokenText(): string {
    return this.words.filter((w) => w.played).map((w) => w.word).join(' ');
  }

  getRemainingText(): string {
    return this.words.filter((w) => !w.played).map((w) => w.word).join(' ');
  }

  /**
   * Drop everything from `wordIndex` on. Returns the receipt and
   * leaves the played prefix in place (the queue is now empty of
   * unplayed words). Idempotent: a second cancel returns zeros.
   */
  cancelFrom(wordIndex: number): {
    wordsPlayed: number;
    wordsDiscarded: number;
    audioPlayedMs: number;
    audioDiscardedMs: number;
    spokenText: string;
    remainingText: string;
    cutWordIndex: number;
    cutAudioOffsetMs: number;
  } {
    const cut = Math.max(0, Math.min(wordIndex, this.words.length));
    const played = this.words.slice(0, cut);
    const discarded = this.words.slice(cut).filter((w) => !w.played);
    const audioDiscardedMs = discarded.reduce((a, w) => a + w.durationMs, 0);
    const audioPlayedMs = played.reduce((a, w) => a + w.durationMs, 0);
    const spokenText = played.map((w) => w.word).join(' ');
    const remainingText = discarded.map((w) => w.word).join(' ');
    this.discardedMs += audioDiscardedMs;
    this.discardedWords += discarded.length;
    this.words = played;
    this.playedMs = audioPlayedMs;
    return {
      wordsPlayed: played.length,
      wordsDiscarded: discarded.length,
      audioPlayedMs,
      audioDiscardedMs,
      spokenText,
      remainingText,
      cutWordIndex: cut,
      cutAudioOffsetMs: audioPlayedMs,
    };
  }

  /** Discard the whole queue (hang-up / new turn). */
  clear(): { wordsDiscarded: number; audioDiscardedMs: number } {
    const remaining = this.words.filter((w) => !w.played);
    const out = {
      wordsDiscarded: remaining.length,
      audioDiscardedMs: remaining.reduce((a, w) => a + w.durationMs, 0),
    };
    this.discardedMs += out.audioDiscardedMs;
    this.discardedWords += out.wordsDiscarded;
    this.words = [];
    this.playedMs = 0;
    return out;
  }

  getTotals(): { totalAudioDiscardedMs: number; totalWordsDiscarded: number } {
    return { totalAudioDiscardedMs: this.discardedMs, totalWordsDiscarded: this.discardedWords };
  }

  isEmpty(): boolean {
    return this.words.length === 0;
  }
}

/** One AEC frame: residual after subtracting the scaled playback reference. */
export function aecResidualFrame(
  mic: Uint8Array,
  playback: Uint8Array | null,
  echoGain: number,
): { residual: Float32Array; residualRms: number; echoRms: number } {
  const n = Math.floor(mic.length / 2);
  const residual = new Float32Array(n);
  let echoSq = 0;
  let resSq = 0;
  const m = playback ? Math.floor(playback.length / 2) : 0;
  for (let i = 0; i < n; i += 1) {
    const micSample = pcm16Sample(mic, i);
    const playSample = i < m ? pcm16Sample(playback as Uint8Array, i) : 0;
    const echo = playSample * echoGain;
    const res = micSample - echo;
    residual[i] = res;
    echoSq += echo * echo;
    resSq += res * res;
  }
  return {
    residual,
    residualRms: n === 0 ? 0 : Math.sqrt(resSq / n),
    echoRms: n === 0 ? 0 : Math.sqrt(echoSq / n),
  };
}

/**
 * Full-duplex barge-in controller v8. The session feeds it the mic
 * frame, the playback reference frame, the VAD confidence, and the
 * model phase; it decides interrupt / duck / ignore on the AEC
 * residual. `requestInterrupt()` performs the cancel (through the
 * injected stop callback) and returns the exact receipt.
 */
export class BargeInV8Controller {
  private readonly energyThreshold: number;
  private readonly duckThreshold: number;
  private readonly debounceFrames: number;
  private readonly debounceWindowMs: number;
  private readonly vadRequired: boolean;
  private readonly stopBudgetMs: number;
  private readonly graceMs: number;
  private readonly echoWindowMs: number;
  private readonly echoMultiplier: number;
  private readonly duckMs: number;
  private readonly cooldownMs: number;
  private readonly minConfidence: number;
  private readonly echoLearnRate: number;
  private readonly maxResidualRatio: number;
  private readonly echoRingFrames: number;
  private readonly clock: () => number;
  private readonly stopLatency = new LatencyHistogram();
  private echoGain: number;
  private state: BargeInV8State = 'idle';
  private phase: BargeInV8ModelPhase = 'idle';
  private modelSpeechStartedAt: number | null = null;
  private thinkingStartedAt: number | null = null;
  private consecutiveFrames = 0;
  private firstFrameAt = 0;
  private lastDecisionAt = 0;
  private cooldownUntil = 0;
  private duckUntil = 0;
  private interrupts = 0;
  private thinkingInterrupts = 0;
  private ducks = 0;
  private ignored = 0;
  private ignoredByReason: Record<BargeInV8IgnoreReason, number> = {
    'not-speaking': 0,
    'below-energy': 0,
    'echo-only': 0,
    'no-vad': 0,
    debouncing: 0,
    grace: 0,
    'echo-window': 0,
    cooldown: 0,
  };
  private echoOnlyFrames = 0;
  private residualRatios: number[] = [];
  private interruptTimes: number[] = [];
  private readonly queue = new PlaybackQueueV8();
  private playbackRing: Uint8Array[] = [];
  /** Text cut by the last interrupt, kept for resume (cancelFrom drops it from the queue). */
  private pendingResumeText = '';
  /** Per-word audio ms of the pending resume text. */
  private pendingResumeWordMs = BARGE_IN_V8_DEFAULT_WORD_MS;

  constructor(options: BargeInV8Options = {}) {
    const problems = validateBargeInV8Options(options);
    if (problems.length > 0) {
      throw new Error(`Invalid BargeInV8 options: ${problems.join('; ')}`);
    }
    const d = defaultBargeInV8Options();
    this.energyThreshold = options.energyThreshold ?? d.energyThreshold;
    this.duckThreshold = options.duckThreshold ?? d.duckThreshold;
    this.debounceFrames = options.debounceFrames ?? d.debounceFrames;
    this.debounceWindowMs = options.debounceWindowMs ?? d.debounceWindowMs;
    this.vadRequired = options.vadRequired ?? d.vadRequired;
    this.stopBudgetMs = options.stopBudgetMs ?? d.stopBudgetMs;
    this.graceMs = options.graceMs ?? d.graceMs;
    this.echoWindowMs = options.echoWindowMs ?? d.echoWindowMs;
    this.echoMultiplier = options.echoMultiplier ?? d.echoMultiplier;
    this.duckMs = options.duckMs ?? d.duckMs;
    this.cooldownMs = options.cooldownMs ?? d.cooldownMs;
    this.minConfidence = options.minConfidence ?? d.minConfidence;
    this.echoGain = options.echoGain ?? d.echoGain;
    this.echoLearnRate = options.echoLearnRate ?? d.echoLearnRate;
    this.maxResidualRatio = options.maxResidualRatio ?? d.maxResidualRatio;
    this.echoRingFrames = options.echoRingFrames ?? d.echoRingFrames;
    this.clock = options.clock ?? Date.now;
  }

  // -- read-only state ------------------------------------------------------

  getState(): BargeInV8State {
    return this.state;
  }

  getPhase(): BargeInV8ModelPhase {
    return this.phase;
  }

  isModelSpeaking(): boolean {
    return this.phase === 'speaking';
  }

  isModelThinking(): boolean {
    return this.phase === 'thinking';
  }

  getEchoGain(): number {
    return this.echoGain;
  }

  /** Energy threshold for an interrupt (sensitivity = 1 - threshold/0.1, clamped). */
  getEnergyThreshold(): number {
    return this.energyThreshold;
  }

  /** Barge-in sensitivity 0..1 (higher = easier to interrupt). */
  getSensitivity(): number {
    return Math.min(1, Math.max(0, 1 - this.energyThreshold / 0.1));
  }

  getQueue(): PlaybackQueueV8 {
    return this.queue;
  }

  getStats(): BargeInV8Stats {
    const now = this.clock();
    const recent = this.interruptTimes.filter((t) => now - t <= 60_000).length;
    const meanResidual =
      this.residualRatios.length === 0
        ? null
        : this.residualRatios.reduce((a, b) => a + b, 0) / this.residualRatios.length;
    const totals = this.queue.getTotals();
    return {
      state: this.state,
      interrupts: this.interrupts,
      thinkingInterrupts: this.thinkingInterrupts,
      ducks: this.ducks,
      ignored: this.ignored,
      ignoredByReason: { ...this.ignoredByReason },
      echoOnlyFrames: this.echoOnlyFrames,
      meanResidualRatio: meanResidual,
      echoGain: this.echoGain,
      totalAudioDiscardedMs: totals.totalAudioDiscardedMs,
      totalWordsDiscarded: totals.totalWordsDiscarded,
      stopLatency: this.stopLatency.summary(),
      interruptsLastMinute: recent,
    };
  }

  // -- model phase ----------------------------------------------------------

  /** The model started thinking (generating, no audio yet) — interruptible. */
  noteThinkingStarted(): void {
    this.phase = 'thinking';
    this.thinkingStartedAt = this.clock();
    if (this.state === 'idle') this.state = 'thinking';
  }

  /** The model started speaking; `replyText` seeds the playback queue. */
  noteModelSpeechStarted(replyText = '', wordMs?: number | number[]): void {
    this.phase = 'speaking';
    this.modelSpeechStartedAt = this.clock();
    this.state = 'speaking';
    this.consecutiveFrames = 0;
    this.pendingResumeText = '';
    if (replyText) this.queue.enqueue(replyText, wordMs);
  }

  /** The model finished speaking on its own. */
  noteModelSpeechEnded(): void {
    this.phase = 'idle';
    this.modelSpeechStartedAt = null;
    this.thinkingStartedAt = null;
    if (this.state === 'speaking' || this.state === 'ducked') this.state = 'idle';
    this.consecutiveFrames = 0;
    this.queue.clear();
  }

  /** The TTS just spoke word `wordIndex` (advances the played prefix). */
  noteWordPlayed(wordIndex: number): void {
    this.queue.markWordPlayed(wordIndex);
  }

  /** Feed the playback reference (what the speaker is playing right now). */
  notePlaybackFrame(frame: Uint8Array): void {
    if (!isValidPcm16Frame(frame)) return;
    this.playbackRing.push(new Uint8Array(frame));
    if (this.playbackRing.length > this.echoRingFrames) this.playbackRing.shift();
  }

  /** Latest playback reference frame (null when the speaker is silent). */
  private latestPlaybackFrame(): Uint8Array | null {
    return this.playbackRing.length > 0 ? (this.playbackRing[this.playbackRing.length - 1] as Uint8Array) : null;
  }

  /**
   * Learn the echo gain from a quiet moment: when the user is not
   * speaking and the VAD is quiet, mic energy ≈ echo, so the gain
   * converges on micRMS / playbackRMS. Called on every frame;
   * only moves when the frame is quiet.
   */
  private learnEchoGain(micRms: number, playbackRms: number, vadActive: boolean): void {
    if (vadActive) return;
    if (playbackRms < 0.005 || micRms < 0.001) return;
    const observed = Math.min(1, micRms / playbackRms);
    this.echoGain += (observed - this.echoGain) * this.echoLearnRate;
    if (this.echoGain < 0) this.echoGain = 0;
    if (this.echoGain > 1) this.echoGain = 1;
  }

  // -- the decision ---------------------------------------------------------

  /**
   * One mic frame. Returns the decision; the session acts on
   * `interrupt` (call `requestInterrupt`) or `duck` (call `duck`).
   * `vadActive` / `confidence` come from the VAD v8; when the VAD
   * is absent pass `vadActive: false, confidence: 0` and set
   * `vadRequired: false`.
   */
  noteAudioFrame(input: {
    frame: Uint8Array;
    vadActive: boolean;
    confidence?: number;
  }): BargeInV8Decision {
    const now = this.clock();
    const frame = input.frame;
    if (!isValidPcm16Frame(frame)) {
      throw new Error('BargeInV8: frame must be a non-empty even-length PCM16 buffer.');
    }
    const rms = pcm16Rms(frame);
    const confidence = input.confidence ?? 0;
    const playback = this.latestPlaybackFrame();
    const playbackRms = playback ? pcm16Rms(playback) : 0;
    this.learnEchoGain(rms, playbackRms, input.vadActive);
    const { residualRms, echoRms } = aecResidualFrame(frame, playback, this.echoGain);
    const residualRatio = rms <= 0 ? 0 : residualRms / rms;
    const base: Omit<BargeInV8Decision, 'action' | 'reason'> = {
      frames: this.consecutiveFrames,
      framesNeeded: this.debounceFrames,
      rms,
      residualRms,
      echoRms,
      residualRatio,
      confidence,
      phase: this.phase,
      state: this.state,
      at: now,
    };
    const ignore = (reason: BargeInV8IgnoreReason): BargeInV8Decision => {
      this.ignored += 1;
      this.ignoredByReason[reason] += 1;
      if (reason === 'echo-only') this.echoOnlyFrames += 1;
      return { ...base, action: 'ignore', reason, frames: this.consecutiveFrames, state: this.state };
    };
    // Duck expiry / cooldown expiry roll the state forward.
    if (this.state === 'ducked' && now >= this.duckUntil && this.phase === 'speaking') this.state = 'speaking';
    if (this.state === 'cooldown' && now >= this.cooldownUntil) this.state = this.phase === 'speaking' ? 'speaking' : 'idle';
    if (this.phase === 'idle') {
      this.consecutiveFrames = 0;
      return ignore('not-speaking');
    }
    if (now < this.cooldownUntil) return ignore('cooldown');
    // Grace window: the model gets its first words out.
    if (
      this.phase === 'speaking' &&
      this.modelSpeechStartedAt !== null &&
      now - this.modelSpeechStartedAt < this.graceMs
    ) {
      this.consecutiveFrames = 0;
      return ignore('grace');
    }
    // Echo window: right after speech starts, the frame must be
    // much louder than the echo estimate or it is the speaker.
    if (
      this.phase === 'speaking' &&
      this.modelSpeechStartedAt !== null &&
      now - this.modelSpeechStartedAt < this.echoWindowMs &&
      residualRms < echoRms * this.echoMultiplier &&
      residualRms < this.energyThreshold
    ) {
      this.consecutiveFrames = 0;
      return ignore('echo-window');
    }
    // AEC gate: a frame that is mostly echo never interrupts, even
    // if it is loud — the residual is what the user actually said.
    if (playbackRms > 0.005 && residualRatio < this.maxResidualRatio && residualRms < this.energyThreshold) {
      this.consecutiveFrames = 0;
      return ignore('echo-only');
    }
    if (residualRms < this.energyThreshold && rms < this.energyThreshold) {
      // Below the energy line — but loud enough to duck?
      if (rms >= this.duckThreshold && this.phase === 'speaking' && this.state !== 'ducked') {
        return this.makeDuck({ ...base, frames: this.consecutiveFrames });
      }
      this.consecutiveFrames = 0;
      return ignore('below-energy');
    }
    if (this.vadRequired && !input.vadActive) {
      this.consecutiveFrames = 0;
      return ignore('no-vad');
    }
    if (confidence < this.minConfidence && this.vadRequired) {
      this.consecutiveFrames = 0;
      return ignore('no-vad');
    }
    // Debounce: count consecutive confirming frames inside the window.
    if (this.consecutiveFrames === 0 || now - this.firstFrameAt > this.debounceWindowMs) {
      this.consecutiveFrames = 1;
      this.firstFrameAt = now;
    } else {
      this.consecutiveFrames += 1;
    }
    if (this.consecutiveFrames < this.debounceFrames) {
      this.ignored += 1;
      this.ignoredByReason.debouncing += 1;
      return {
        ...base,
        action: 'ignore',
        reason: 'debouncing',
        frames: this.consecutiveFrames,
        framesNeeded: Math.max(0, this.debounceFrames - this.consecutiveFrames),
        state: this.state,
      };
    }
    // Confirmed.
    this.residualRatios.push(residualRatio);
    if (this.residualRatios.length > 100) this.residualRatios.shift();
    const confirmedReason = this.phase === 'thinking' ? 'confirmed-thinking' : 'confirmed';
    return {
      ...base,
      action: 'interrupt',
      reason: confirmedReason,
      frames: this.consecutiveFrames,
      framesNeeded: 0,
      state: this.phase === 'thinking' ? 'interrupted' : this.state,
    };
  }

  private makeDuck(base: Omit<BargeInV8Decision, 'action' | 'reason'>): BargeInV8Decision {
    const now = this.clock();
    this.ducks += 1;
    this.state = 'ducked';
    this.duckUntil = now + this.duckMs;
    return { ...base, action: 'duck', reason: 'confirmed-duck', frames: this.consecutiveFrames, framesNeeded: 0, state: 'ducked' };
  }

  /** Record a duck without a frame (the panel / tool asked for one). */
  duck(): { ducked: boolean; untilMs: number } {
    const now = this.clock();
    if (this.phase !== 'speaking') return { ducked: false, untilMs: now };
    this.ducks += 1;
    this.state = 'ducked';
    this.duckUntil = now + this.duckMs;
    return { ducked: true, untilMs: this.duckUntil };
  }

  /**
   * Perform the interrupt: stop the TTS (through `stop`, timed
   * against the stop budget), cancel the playback queue from the
   * cut word, and return the exact receipt. `stop` defaults to a
   * no-op (mock sessions have nothing to stop).
   */
  async requestInterrupt(options: {
    stop?: () => void | Promise<void>;
    cutWordIndex?: number;
  } = {}): Promise<BargeInV8InterruptResult> {
    const started = this.clock();
    const wasThinking = this.phase === 'thinking';
    let stopped = false;
    try {
      await (options.stop?.() ?? Promise.resolve());
      stopped = true;
    } catch {
      stopped = false;
    }
    const stopLatencyMs = this.clock() - started;
    this.stopLatency.record(Math.max(0, stopLatencyMs));
    const cutWordIndex =
      options.cutWordIndex ?? (wasThinking ? 0 : this.queue.getPlayedCount());
    const receipt = this.queue.cancelFrom(cutWordIndex);
    // Keep the cut remainder for resume: cancelFrom drops it from
    // the queue, so the controller holds it until resumeRemaining.
    this.pendingResumeText = receipt.remainingText;
    this.pendingResumeWordMs =
      receipt.wordsDiscarded > 0
        ? Math.max(0, receipt.audioDiscardedMs / receipt.wordsDiscarded)
        : BARGE_IN_V8_DEFAULT_WORD_MS;
    this.interrupts += 1;
    if (wasThinking) this.thinkingInterrupts += 1;
    this.interruptTimes.push(this.clock());
    this.phase = 'idle';
    this.modelSpeechStartedAt = null;
    this.thinkingStartedAt = null;
    this.state = 'interrupted';
    this.cooldownUntil = this.clock() + this.cooldownMs;
    this.consecutiveFrames = 0;
    return {
      stopped,
      stopLatencyMs,
      withinBudget: stopLatencyMs <= this.stopBudgetMs,
      wordsPlayed: receipt.wordsPlayed,
      wordsDiscarded: receipt.wordsDiscarded,
      audioPlayedMs: receipt.audioPlayedMs,
      audioDiscardedMs: receipt.audioDiscardedMs,
      spokenText: receipt.spokenText,
      remainingText: receipt.remainingText,
      cutWordIndex: receipt.cutWordIndex,
      cutAudioOffsetMs: receipt.cutAudioOffsetMs,
    };
  }

  /** Resume the cut reply: re-queue the remaining text from the cut word. */
  resumeRemaining(): { resumed: boolean; text: string; words: number } {
    const remaining = this.pendingResumeText;
    if (!remaining) return { resumed: false, text: '', words: 0 };
    const words = splitWordsV8(remaining);
    this.queue.enqueue(remaining, this.pendingResumeWordMs);
    this.pendingResumeText = '';
    this.phase = 'speaking';
    this.modelSpeechStartedAt = this.clock();
    this.state = 'speaking';
    return { resumed: true, text: remaining, words: words.length };
  }

  /** Reset after the cooldown / new turn. */
  reset(): void {
    this.state = 'idle';
    this.phase = 'idle';
    this.modelSpeechStartedAt = null;
    this.thinkingStartedAt = null;
    this.consecutiveFrames = 0;
    this.cooldownUntil = 0;
    this.duckUntil = 0;
    this.pendingResumeText = '';
    this.queue.clear();
    this.playbackRing = [];
  }
}

/** One-line summary for diagnostics / the panel. */
export function bargeInV8Summary(stats: BargeInV8Stats): string {
  const stop = stats.stopLatency ? `stop p95 ${Math.round(stats.stopLatency.p95Ms)}ms` : 'stop n/a';
  return (
    `Barge-in v8 ${stats.state} interrupts ${stats.interrupts} ` +
    `(thinking ${stats.thinkingInterrupts}) ducks ${stats.ducks} ` +
    `echo-only ${stats.echoOnlyFrames} discarded ${stats.totalAudioDiscardedMs}ms/${stats.totalWordsDiscarded}w ${stop}`
  );
}
