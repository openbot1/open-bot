/**
 * Barge-in v7 (v1.08, Đội T5 — voice realtime v7).
 *
 * v4 made the *detection* trustworthy (energy gate + VAD +
 * debounce + 50 ms TTS stop). v7 makes the *interruption itself*
 * graded and recoverable, because not every sound while the model
 * speaks deserves to kill the reply:
 *
 *   - Graded interruption: a short, low-confidence burst only
 *     *ducks* the TTS (the model keeps talking, quieter, for a
 *     moment); sustained confident speech *interrupts* it. The
 *     duck threshold sits below the interrupt threshold, so "ừ"
 *     over a reply ducks instead of cutting it.
 *   - Grace window: the first `graceMs` of a model reply are
 *     uninterruptible — the model gets one sentence out before
 *     the user can cut it, so a mic pop at the exact moment the
 *     reply starts cannot kill the whole answer.
 *   - Echo window: frames arriving within `echoWindowMs` of the
 *     model starting to speak are ignored unless they are much
 *     louder than the echo threshold (the speaker's own voice
 *     bleeding back into the mic right after TTS starts is the
 *     classic self-interrupt).
 *   - Cooldown: after an interrupt the controller refuses new
 *     interrupts for `cooldownMs` — the user is now speaking and
 *     the model must not restart mid-sentence, and a second mic
 *     pop cannot stack a second cut on the same reply.
 *   - Word-level partials: the controller tracks the model's
 *     spoken words (`noteModelWords`); an interrupt keeps the
 *     exact cut point (`cutWordIndex`, `remainingText`) so the
 *     next turn can resume from the cut word instead of
 *     restarting the sentence — and the resume prompt says so.
 *
 * The v4 controller still owns the frame-level signal path where
 * it is used; v7 is the policy layer above it (the session feeds
 * v7, v7 decides duck / interrupt / ignore, the session cancels
 * the TTS). Both feed the same session interrupt.
 */
import { LatencyHistogram, type LatencyHistogramSummary } from './latencyPipeline';

/** Barge-in v7 state, as the panel renders it. */
export type BargeInV7State = 'idle' | 'listening' | 'ducked' | 'interrupted' | 'cooldown';

/** Why one audio frame (or speech event) did not interrupt. */
export type BargeInV7IgnoreReason =
  | 'not-speaking'
  | 'below-energy'
  | 'no-vad'
  | 'debouncing'
  | 'grace'
  | 'echo'
  | 'cooldown';

/** What v7 decided about one audio frame. */
export type BargeInV7Action = 'interrupt' | 'duck' | 'ignore';

export interface BargeInV7Decision {
  action: BargeInV7Action;
  reason: BargeInV7IgnoreReason | 'confirmed' | 'confirmed-duck';
  /** Consecutive loud+VAD frames seen (debounce progress). */
  frames: number;
  /** Frames still needed before an interrupt fires. */
  framesNeeded: number;
  /** RMS of the frame that produced this decision. */
  rms: number;
  /** Confidence of the frame (0..1, from the VAD when given). */
  confidence: number;
  /** State after this decision. */
  state: BargeInV7State;
  at: number;
}

/** Result of cancelling the TTS playback. */
export interface BargeInV7InterruptResult {
  /** True when the cancel was actually sent. */
  stopped: boolean;
  /** Wall time of the stop (ms) — measured, not estimated. */
  stopLatencyMs: number | null;
  /** True when the stop beat the 50 ms budget. */
  withinBudget: boolean;
  /** Text the model had spoken before being cut ('' when none). */
  partialText: string;
  /** Words spoken before the cut. */
  spokenWords: string[];
  /** Index of the first word NOT spoken (cut point). */
  cutWordIndex: number;
  /** The rest of the reply, from the cut word on. */
  remainingText: string;
  at: number;
}

/** Result of ducking the TTS playback (quiet, not stopped). */
export interface BargeInV7DuckResult {
  ducked: boolean;
  /** ms the duck lasts before the volume restores itself. */
  duckMs: number;
  /** RMS that triggered the duck. */
  rms: number;
  at: number;
}

/** The cut reply, kept so the next turn can resume it. */
export interface BargeInV7PartialUtterance {
  text: string;
  spokenWords: string[];
  cutWordIndex: number;
  remainingText: string;
  /** ms into the model reply when the cut happened. */
  cutAtMs: number | null;
  /** Stop latency of the cancel that cut it (ms). */
  stopLatencyMs: number | null;
  at: number;
}

export interface BargeInV7Stats {
  state: BargeInV7State;
  interrupts: number;
  ducks: number;
  ignored: Record<BargeInV7IgnoreReason, number>;
  stopLatency: LatencyHistogramSummary | null;
  /** Stops that missed the 50 ms budget. */
  stopBreaches: number;
  /** Partials kept for resume (newest last). */
  partials: number;
  /** Last partial text ('' when none). */
  lastPartialText: string;
  /** Last cut word index (0 when no partial yet). */
  lastCutWordIndex: number;
  /** ms left in the cooldown (0 when not cooling down). */
  cooldownRemainingMs: number;
}

/** Default RMS above which a frame counts as user speech. */
export const BARGE_IN_V7_DEFAULT_ENERGY_THRESHOLD = 0.02;
/** Default RMS above which a frame ducks the TTS (below the interrupt line). */
export const BARGE_IN_V7_DEFAULT_DUCK_THRESHOLD = 0.012;
/** Default consecutive loud+VAD frames needed to interrupt. */
export const BARGE_IN_V7_DEFAULT_DEBOUNCE_FRAMES = 3;
/** Default window (ms) the debounce frames must arrive inside. */
export const BARGE_IN_V7_DEFAULT_DEBOUNCE_WINDOW_MS = 500;
/** Barge-in stop budget: TTS must die within this long (ms). */
export const BARGE_IN_V7_STOP_BUDGET_MS = 50;
/** Default grace at the start of a model reply (ms, uninterruptible). */
export const BARGE_IN_V7_DEFAULT_GRACE_MS = 300;
/** Default echo window after model speech starts (ms). */
export const BARGE_IN_V7_DEFAULT_ECHO_WINDOW_MS = 250;
/** Frames inside the echo window must beat threshold * this to count. */
export const BARGE_IN_V7_DEFAULT_ECHO_MULTIPLIER = 3;
/** Default duck length (ms). */
export const BARGE_IN_V7_DEFAULT_DUCK_MS = 800;
/** Default cooldown after an interrupt (ms). */
export const BARGE_IN_V7_DEFAULT_COOLDOWN_MS = 1200;
/** Default minimum confidence (0..1) for an interrupt. */
export const BARGE_IN_V7_DEFAULT_MIN_CONFIDENCE = 0.5;
/** Partial text kept past this long is trimmed (chars). */
export const BARGE_IN_V7_MAX_PARTIAL_CHARS = 500;
/** Spoken words kept per partial (oldest dropped past this). */
export const BARGE_IN_V7_MAX_PARTIAL_WORDS = 200;

export interface BargeInV7Options {
  /** RMS threshold for a frame to count. Default 0.02. */
  energyThreshold?: number;
  /** RMS threshold for a duck (below the interrupt line). Default 0.012. */
  duckThreshold?: number;
  /** Consecutive frames needed. Default 3. */
  debounceFrames?: number;
  /** Window (ms) the frames must arrive inside. Default 500. */
  debounceWindowMs?: number;
  /** Require the VAD to say "speech" (default true). When false,
   *  energy alone can interrupt — only for tests / no-VAD rigs. */
  vadRequired?: boolean;
  /** Stop budget (ms). Default 50. */
  stopBudgetMs?: number;
  /** Grace at the start of a reply (ms). Default 300. */
  graceMs?: number;
  /** Echo window after model speech starts (ms). Default 250. */
  echoWindowMs?: number;
  /** Echo multiplier on the energy threshold. Default 3. */
  echoMultiplier?: number;
  /** Duck length (ms). Default 800. */
  duckMs?: number;
  /** Cooldown after an interrupt (ms). Default 1200. */
  cooldownMs?: number;
  /** Minimum VAD confidence for an interrupt (0..1). Default 0.5. */
  minConfidence?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * Frame-level barge-in detector with graded interruption. The
 * caller feeds PCM frames (`noteAudioFrame`) while the model
 * speaks; when the energy gate, the VAD, the confidence and the
 * debounce all agree, the decision is `interrupt` (or `duck` for
 * a weaker burst) — and only then should the caller call
 * `interrupt()` / `duck()` to cancel / quiet the TTS and keep the
 * partial.
 */
export class BargeInV7Controller {
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
  private readonly clock: () => number;
  private readonly stopLatency = new LatencyHistogram();
  private state: BargeInV7State = 'idle';
  private modelSpeechStartedAt: number | null = null;
  private modelWords: string[] = [];
  private modelPartialText = '';
  /** Full planned reply (when the caller knows it): the words
   *  after the cut point become `remainingText` on interrupt. */
  private plannedReplyWords: string[] = [];
  private consecutiveFrames = 0;
  private firstFrameAt: number | null = null;
  private interrupts = 0;
  private ducks = 0;
  private stopBreaches = 0;
  private readonly ignored: Record<BargeInV7IgnoreReason, number> = {
    'not-speaking': 0,
    'below-energy': 0,
    'no-vad': 0,
    debouncing: 0,
    grace: 0,
    echo: 0,
    cooldown: 0,
  };
  private readonly partials: BargeInV7PartialUtterance[] = [];
  private cooldownUntilMs = 0;
  private duckUntilMs = 0;

  constructor(options: BargeInV7Options = {}) {
    this.energyThreshold = Math.max(0, options.energyThreshold ?? BARGE_IN_V7_DEFAULT_ENERGY_THRESHOLD);
    this.duckThreshold = Math.max(
      0,
      Math.min(
        this.energyThreshold,
        options.duckThreshold ?? BARGE_IN_V7_DEFAULT_DUCK_THRESHOLD,
      ),
    );
    this.debounceFrames = Math.max(1, Math.floor(options.debounceFrames ?? BARGE_IN_V7_DEFAULT_DEBOUNCE_FRAMES));
    this.debounceWindowMs = Math.max(1, options.debounceWindowMs ?? BARGE_IN_V7_DEFAULT_DEBOUNCE_WINDOW_MS);
    this.vadRequired = options.vadRequired ?? true;
    this.stopBudgetMs = Math.max(1, options.stopBudgetMs ?? BARGE_IN_V7_STOP_BUDGET_MS);
    this.graceMs = Math.max(0, options.graceMs ?? BARGE_IN_V7_DEFAULT_GRACE_MS);
    this.echoWindowMs = Math.max(0, options.echoWindowMs ?? BARGE_IN_V7_DEFAULT_ECHO_WINDOW_MS);
    this.echoMultiplier = Math.max(1, options.echoMultiplier ?? BARGE_IN_V7_DEFAULT_ECHO_MULTIPLIER);
    this.duckMs = Math.max(0, options.duckMs ?? BARGE_IN_V7_DEFAULT_DUCK_MS);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? BARGE_IN_V7_DEFAULT_COOLDOWN_MS);
    this.minConfidence = Math.max(0, Math.min(1, options.minConfidence ?? BARGE_IN_V7_DEFAULT_MIN_CONFIDENCE));
    this.clock = options.clock ?? Date.now;
  }

  getState(): BargeInV7State {
    const now = this.clock();
    if (this.state === 'ducked' && now >= this.duckUntilMs) {
      this.state = 'listening';
    }
    if (this.state === 'cooldown' && now >= this.cooldownUntilMs) {
      this.state = 'idle';
    }
    return this.state;
  }

  isModelSpeaking(): boolean {
    const state = this.getState();
    return state === 'listening' || state === 'ducked';
  }

  getStopBudgetMs(): number {
    return this.stopBudgetMs;
  }

  /** ms left in the cooldown (0 when not cooling down). */
  getCooldownRemainingMs(): number {
    if (this.getState() !== 'cooldown') return 0;
    return Math.max(0, this.cooldownUntilMs - this.clock());
  }

  /** The model started a reply: start watching for barge-in. */
  modelSpeechStarted(partialText = ''): void {
    this.state = 'listening';
    this.modelSpeechStartedAt = this.clock();
    this.modelWords = [];
    this.modelPartialText = partialText;
    this.plannedReplyWords = [];
    this.consecutiveFrames = 0;
    this.firstFrameAt = null;
    this.cooldownUntilMs = 0;
    this.duckUntilMs = 0;
  }

  /** The model finished a reply on its own: stop watching. */
  modelSpeechEnded(): void {
    this.state = 'idle';
    this.modelSpeechStartedAt = null;
    this.modelWords = [];
    this.modelPartialText = '';
    this.plannedReplyWords = [];
    this.consecutiveFrames = 0;
    this.firstFrameAt = null;
  }

  /** Note the text the model has spoken so far (for the partial). */
  noteModelText(text: string): void {
    if (typeof text === 'string' && text) this.modelPartialText = text;
  }

  /**
   * Note the full reply the model is about to speak (when the
   * caller knows it — e.g. a scripted mock reply). The words past
   * the cut point become the partial's `remainingText`, so the
   * resume can say what was left unsaid.
   */
  notePlannedReply(text: string): void {
    this.plannedReplyWords = typeof text === 'string' ? splitWords(text) : [];
  }

  /**
   * Note the model's spoken words so far (word-level cut
   * tracking). The partial keeps the exact cut word; the resume
   * prompt continues from there. Words past the cap are dropped
   * from the front (the tail is what the resume needs).
   */
  noteModelWords(words: string[]): void {
    if (!Array.isArray(words)) return;
    for (const word of words) {
      if (typeof word === 'string' && word.trim() !== '') this.modelWords.push(word);
    }
    if (this.modelWords.length > BARGE_IN_V7_MAX_PARTIAL_WORDS) {
      this.modelWords.splice(0, this.modelWords.length - BARGE_IN_V7_MAX_PARTIAL_WORDS);
    }
    this.modelPartialText = this.modelWords.join(' ');
  }

  /** Words spoken so far in this reply (copy). */
  getSpokenWords(): string[] {
    return [...this.modelWords];
  }

  /**
   * One mic frame while the model may be speaking. Returns the
   * decision: `interrupt` only when the model is speaking AND the
   * frame is loud AND the VAD agrees AND the confidence is high
   * AND the debounce is satisfied AND the grace / echo / cooldown
   * windows allow it; a weaker burst (above the duck line, below
   * the interrupt line) returns `duck`. Everything else is an
   * `ignore` with the reason.
   */
  noteAudioFrame(input: { rms: number; vadActive?: boolean; confidence?: number; at?: number }): BargeInV7Decision {
    const at = input.at ?? this.clock();
    const rms = input.rms;
    const confidence = typeof input.confidence === 'number' ? input.confidence : 1;
    const state = this.getState();
    const base = {
      rms,
      confidence,
      frames: this.consecutiveFrames,
      framesNeeded: Math.max(0, this.debounceFrames - this.consecutiveFrames),
      state,
      at,
    };
    if (state === 'cooldown') {
      this.ignored.cooldown += 1;
      return { ...base, action: 'ignore', reason: 'cooldown' };
    }
    if (state !== 'listening' && state !== 'ducked') {
      this.ignored['not-speaking'] += 1;
      return { ...base, action: 'ignore', reason: 'not-speaking' };
    }
    if (this.modelSpeechStartedAt !== null && at - this.modelSpeechStartedAt < this.graceMs) {
      this.ignored.grace += 1;
      return { ...base, action: 'ignore', reason: 'grace' };
    }
    // Echo window: right after the TTS starts, the mic hears the
    // speaker itself — a frame must beat threshold * multiplier to
    // count at all (quiet echo residue never interrupts, a real
    // loud voice still can).
    const inEchoWindow =
      this.modelSpeechStartedAt !== null && at - this.modelSpeechStartedAt < this.graceMs + this.echoWindowMs;
    const energyLine = inEchoWindow ? this.energyThreshold * this.echoMultiplier : this.energyThreshold;
    if (inEchoWindow && rms < energyLine) {
      this.ignored.echo += 1;
      return { ...base, action: 'ignore', reason: 'echo' };
    }
    if (rms < this.duckThreshold) {
      this.consecutiveFrames = 0;
      this.firstFrameAt = null;
      this.ignored['below-energy'] += 1;
      return { ...base, action: 'ignore', reason: 'below-energy', frames: 0, framesNeeded: this.debounceFrames };
    }
    if (rms < energyLine) {
      // Above the duck line, below the interrupt line: a quiet
      // "ừ" / backchannel — duck, do not cut. A duck needs the
      // VAD to agree too, or room noise would duck every reply.
      if (this.vadRequired && input.vadActive !== true) {
        this.ignored['no-vad'] += 1;
        return { ...base, action: 'ignore', reason: 'no-vad', frames: 0, framesNeeded: this.debounceFrames };
      }
      return { ...base, action: 'duck', reason: 'confirmed-duck', frames: this.consecutiveFrames, framesNeeded: 0 };
    }
    if (this.vadRequired && input.vadActive !== true) {
      this.consecutiveFrames = 0;
      this.firstFrameAt = null;
      this.ignored['no-vad'] += 1;
      return { ...base, action: 'ignore', reason: 'no-vad', frames: 0, framesNeeded: this.debounceFrames };
    }
    if (confidence < this.minConfidence) {
      this.consecutiveFrames = 0;
      this.firstFrameAt = null;
      // A low-confidence frame breaks the streak like any other
      // unconfirmed frame — counted as debouncing, not as a
      // confirmed ignore: the burst may still become real.
      this.ignored.debouncing += 1;
      return { ...base, action: 'ignore', reason: 'debouncing', frames: 0, framesNeeded: this.debounceFrames };
    }
    if (this.firstFrameAt === null) this.firstFrameAt = at;
    if (at - this.firstFrameAt > this.debounceWindowMs) {
      // Window expired — the streak restarts from this frame.
      this.consecutiveFrames = 1;
      this.firstFrameAt = at;
    } else {
      this.consecutiveFrames += 1;
    }
    if (this.consecutiveFrames < this.debounceFrames) {
      this.ignored.debouncing += 1;
      return {
        ...base,
        action: 'ignore',
        reason: 'debouncing',
        frames: this.consecutiveFrames,
        framesNeeded: this.debounceFrames - this.consecutiveFrames,
      };
    }
    return {
      ...base,
      action: 'interrupt',
      reason: 'confirmed',
      frames: this.consecutiveFrames,
      framesNeeded: 0,
    };
  }

  /**
   * Duck the TTS (quieter, not stopped) for `duckMs`. The caller
   * lowers the volume; the controller restores the state to
   * `listening` when the duck expires. Returns the duck record.
   */
  duck(rms: number): BargeInV7DuckResult {
    const at = this.clock();
    this.ducks += 1;
    this.duckUntilMs = at + this.duckMs;
    this.state = 'ducked';
    this.consecutiveFrames = 0;
    this.firstFrameAt = null;
    return { ducked: true, duckMs: this.duckMs, rms, at };
  }

  /**
   * Cancel the TTS playback now. `stopTts` is the caller's stop
   * (sync ms, or an async stop that resolves with its own ms);
   * the latency is measured with the injected clock around the
   * call so a fake clock makes the measurement exact in tests.
   * Returns the measured stop latency and the partial kept, with
   * the exact cut word.
   */
  async interrupt(
    stopTts?: () => number | Promise<number> | void | Promise<void>,
  ): Promise<BargeInV7InterruptResult> {
    const at = this.clock();
    const startedAt = at;
    let stopMs: number | null = null;
    if (stopTts) {
      const returned = await stopTts();
      if (typeof returned === 'number' && Number.isFinite(returned) && returned >= 0) {
        stopMs = returned;
      }
    }
    if (stopMs === null) stopMs = Math.max(0, this.clock() - startedAt);
    this.stopLatency.record(stopMs);
    const withinBudget = stopMs <= this.stopBudgetMs;
    if (!withinBudget) this.stopBreaches += 1;
    this.interrupts += 1;
    const spokenWords = [...this.modelWords];
    const partialText = this.modelPartialText.slice(0, BARGE_IN_V7_MAX_PARTIAL_CHARS);
    const cutWordIndex = spokenWords.length;
    // Remaining = planned words after the cut point ('' when the
    // caller never told us the full reply — the controller only
    // ever knows what was actually spoken).
    const remainingText = this.plannedReplyWords.slice(cutWordIndex).join(' ');
    const cutAtMs =
      this.modelSpeechStartedAt === null ? null : Math.max(0, at - this.modelSpeechStartedAt);
    this.partials.push({
      text: partialText,
      spokenWords,
      cutWordIndex,
      remainingText,
      cutAtMs,
      stopLatencyMs: stopMs,
      at,
    });
    this.state = this.cooldownMs > 0 ? 'cooldown' : 'interrupted';
    this.cooldownUntilMs = at + this.cooldownMs;
    this.consecutiveFrames = 0;
    this.firstFrameAt = null;
    return { stopped: true, stopLatencyMs: stopMs, withinBudget, partialText, spokenWords, cutWordIndex, remainingText, at };
  }

  /**
   * Resume the cut reply: returns the partial kept by the last
   * interrupt plus the prompt the next turn should use, and the
   * state goes back to `listening` (the model is speaking again).
   * Returns null when nothing was cut.
   */
  resumePartial(): { partial: BargeInV7PartialUtterance; resumePrompt: string } | null {
    const partial = this.partials[this.partials.length - 1];
    if (!partial || !partial.text.trim()) return null;
    this.state = 'listening';
    this.modelSpeechStartedAt = this.clock();
    this.modelWords = [...partial.spokenWords];
    this.modelPartialText = partial.text;
    return { partial: { ...partial, spokenWords: [...partial.spokenWords] }, resumePrompt: buildResumeUtteranceV7(partial) };
  }

  getPartials(): BargeInV7PartialUtterance[] {
    return this.partials.map((p) => ({ ...p, spokenWords: [...p.spokenWords] }));
  }

  getLastPartialText(): string {
    return this.partials[this.partials.length - 1]?.text ?? '';
  }

  getLastCutWordIndex(): number {
    return this.partials[this.partials.length - 1]?.cutWordIndex ?? 0;
  }

  getStats(): BargeInV7Stats {
    return {
      state: this.getState(),
      interrupts: this.interrupts,
      ducks: this.ducks,
      ignored: { ...this.ignored },
      stopLatency: this.stopLatency.summary(),
      stopBreaches: this.stopBreaches,
      partials: this.partials.length,
      lastPartialText: this.getLastPartialText(),
      lastCutWordIndex: this.getLastCutWordIndex(),
      cooldownRemainingMs: this.getCooldownRemainingMs(),
    };
  }

  reset(): void {
    this.state = 'idle';
    this.modelSpeechStartedAt = null;
    this.modelWords = [];
    this.modelPartialText = '';
    this.plannedReplyWords = [];
    this.consecutiveFrames = 0;
    this.firstFrameAt = null;
    this.interrupts = 0;
    this.ducks = 0;
    this.stopBreaches = 0;
    this.partials.length = 0;
    this.stopLatency.clear();
    this.cooldownUntilMs = 0;
    this.duckUntilMs = 0;
    for (const key of Object.keys(this.ignored) as BargeInV7IgnoreReason[]) {
      this.ignored[key] = 0;
    }
  }
}

/** Split text into words (whitespace split, no empties). Shared by the controller and the transcript stream. */
export function splitWords(text: string): string[] {
  return (text ?? '').split(/\s+/).filter((w) => w.length > 0);
}

/**
 * "Continue from here" prompt for the turn after a cut reply.
 * The model resumes from the exact cut word instead of restarting
 * the answer — the partial carries the words already spoken, so
 * the prompt can name them.
 */
export function buildResumeUtteranceV7(partial: BargeInV7PartialUtterance): string {
  const text = (partial.text ?? '').trim().slice(0, BARGE_IN_V7_MAX_PARTIAL_CHARS);
  if (!text) return 'The previous reply was interrupted before it started. Please answer the user again, briefly.';
  const cutWord = partial.spokenWords[partial.spokenWords.length - 1] ?? '';
  const where = cutWord
    ? `You were cut off right after the word "${cutWord}" (${partial.cutWordIndex} word(s) spoken).`
    : 'You were cut off mid-sentence.';
  return (
    'Your previous reply was interrupted mid-sentence. Continue exactly where you left off, ' +
    `without restarting or repeating the introduction. ${where} What you had said so far: "${text}"`
  );
}

/** Validate a barge-in v7 options patch; returns error strings (empty = ok). */
export function validateBargeInV7Options(patch: Partial<BargeInV7Options>): string[] {
  const errors: string[] = [];
  const num = (name: string, value: number | undefined, min: number, max: number): void => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push(`${name} must be a finite number ${min}..${max}.`);
    }
  };
  num('energyThreshold', patch.energyThreshold, 0, 1);
  num('duckThreshold', patch.duckThreshold, 0, 1);
  num('debounceFrames', patch.debounceFrames, 1, 20);
  num('debounceWindowMs', patch.debounceWindowMs, 50, 5000);
  num('stopBudgetMs', patch.stopBudgetMs, 1, 1000);
  num('graceMs', patch.graceMs, 0, 5000);
  num('echoWindowMs', patch.echoWindowMs, 0, 2000);
  num('echoMultiplier', patch.echoMultiplier, 1, 10);
  num('duckMs', patch.duckMs, 0, 5000);
  num('cooldownMs', patch.cooldownMs, 0, 10000);
  num('minConfidence', patch.minConfidence, 0, 1);
  if (
    patch.energyThreshold !== undefined &&
    patch.duckThreshold !== undefined &&
    patch.duckThreshold > patch.energyThreshold
  ) {
    errors.push('duckThreshold must not exceed energyThreshold (a duck is weaker than an interrupt).');
  }
  return errors;
}
