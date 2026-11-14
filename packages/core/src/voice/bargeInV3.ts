/**
 * Barge-in v3 (v1.03, Team T5 — realtime voice v3).
 *
 * v2 decides interrupt-or-ignore per speech event. v3 asks a
 * kinder question first — *what kind* of speech is this?
 *
 *   - Backchannel: "uh-huh", "yeah", "ừ", "đúng rồi" — the user
 *     is listening, not interrupting. v2 cancelled the reply for
 *     these; v3 notes them and lets the model keep talking.
 *   - Soft interrupt (duck): when the user starts talking over
 *     the model, v3 first *ducks* — it signals the playback to
 *     lower/pause and waits `confirmMs`. If the user keeps
 *     talking, the interrupt is confirmed; if they stop, playback
 *     resumes and nothing was cancelled. A half-second "wait—"
 *     no longer kills a reply the user wanted to hear.
 *   - Adaptive grace: the grace window learns from the user. When
 *     speech ignored inside the grace window is followed within
 *     2 s by a real interrupt of the same reply (the user had to
 *     repeat themselves because the grace was too long), the grace
 *     shrinks by 100 ms (floor 200 ms). Three repeats trigger one
 *     step; the adaptation is reported, never silent.
 *   - Resume-from-cut: when a reply IS cut, v3 builds the
 *     "continue from here" prompt from the partial text, so the
 *     next turn can resume the cut reply instead of restarting it.
 *
 * The v2 `BargeInController` still owns the timing (the v0.98
 * `TurnTakingMeter`, 500 ms budget) and the partial turns — v3
 * wraps it and only adds the *decision* layer. Soft mode is
 * opt-in (`softInterrupt: true`); with it off, v3 behaves exactly
 * like v2. Ducking itself is a signal: the controller emits the
 * duck, and the caller lowers the audio (the local TTS queue is
 * stopped here; provider audio is ducked by main on the 'ducked'
 * event — this module has no sink to turn down).
 */
import {
  BargeInController,
  type BargeInResumePolicy,
  type BargeInV2Decision,
  type BargeInV2Reason,
  type PartialModelTurn,
  BARGE_IN_V2_DEFAULT_GRACE_MS,
  BARGE_IN_V2_DEFAULT_MIN_SPEECH_MS,
} from './bargeInV2';
import type { BargeInSource } from './turnTaking';

/** Default ms to wait after ducking before confirming the interrupt. */
export const BARGE_IN_V3_DEFAULT_CONFIRM_MS = 400;
/** Default ms a backchannel may last and still count as one. */
export const BARGE_IN_V3_DEFAULT_BACKCHANNEL_MAX_MS = 1_200;
/** Grace shrinks by this much per adaptation step. */
export const BARGE_IN_V3_GRACE_STEP_MS = 100;
/** Grace never shrinks below this. */
export const BARGE_IN_V3_GRACE_MIN_MS = 200;
/** A grace-ignore followed by an interrupt within this long means
 *  the grace was too long (the user had to repeat themselves). */
export const BARGE_IN_V3_REPEAT_WINDOW_MS = 2_000;
/** Repeats needed to trigger one grace step. */
export const BARGE_IN_V3_REPEATS_PER_STEP = 3;

/** What v3 decided about one speech event. */
export type BargeInV3Action = 'interrupt' | 'ignore' | 'backchannel' | 'duck';

/** Why v3 decided what it did (v2 reasons, plus v3's own). */
export type BargeInV3Reason =
  | BargeInV2Reason
  | 'backchannel'
  | 'ducked'
  | 'duck-confirmed'
  | 'duck-cancelled';

/** One v3 decision. */
export interface BargeInV3Decision {
  action: BargeInV3Action;
  reason: BargeInV3Reason;
  source: BargeInSource;
  /** ms into the current model reply when speech was heard. */
  speechAtMs: number | null;
  /** The v2 decision underneath (null for backchannel/duck). */
  v2: BargeInV2Decision | null;
  /** Resume policy that applies when action is `interrupt`. */
  resumePolicy: BargeInResumePolicy;
  /** Current grace window (ms) — moves as it adapts. */
  graceMs: number;
  /** When the decision was made (clock ms). */
  at: number;
}

/** Stats for the panel / diagnostics. */
export interface BargeInV3Stats {
  interrupts: number;
  backchannels: number;
  ducks: number;
  duckConfirmed: number;
  duckCancelled: number;
  graceMs: number;
  graceAdaptations: number;
  /** Grace-ignores followed by a repeat interrupt (pending). */
  repeatAfterGrace: number;
  ignored: Record<BargeInV2Reason, number>;
}

/** Short affirmations (en + vi) that count as backchannels. A
 *  transcript counts when it is at most 3 words and every word is
 *  in this set. */
export const BACKCHANNEL_WORDS: ReadonlySet<string> = new Set([
  'uh-huh', 'uh', 'huh', 'mm-hm', 'mm', 'hm', 'hmm',
  'yeah', 'yep', 'yes', 'yup', 'right', 'okay', 'ok', 'sure',
  'i', 'see', 'uh-huh.',
  'ừ', 'ừm', 'ừm.', 'ờ', 'ờ.', 'vâng', 'dạ', 'đúng', 'rồi',
  'đúng rồi', 'ok', 'ok.', 'ừ nhỉ',
]);

/** True when the transcript is a short affirmation, not a real
 *  interruption. Pure and deterministic, so tests can assert on it
 *  exactly. */
export function isBackchannelTranscript(transcript: string | undefined): boolean {
  if (!transcript) return false;
  const clean = transcript
    .toLowerCase()
    .replace(/[.,!?…]+$/g, '')
    .trim();
  if (!clean) return false;
  const words = clean.split(/\s+/);
  if (words.length === 0 || words.length > 3) return false;
  return words.every((w) => BACKCHANNEL_WORDS.has(w));
}

export interface BargeInV3Options {
  /** Grace window (ms). Default 800 (v2 default). */
  graceMs?: number;
  /** Minimum speech length (ms). Default 150 (v2 default). */
  minSpeechMs?: number;
  /** Resume policy after an interrupt. Default 'restart'. */
  resumePolicy?: BargeInResumePolicy;
  /** Two-phase interrupts: duck first, confirm if speech
   *  continues. Default false (v2 behaviour). */
  softInterrupt?: boolean;
  /** ms to wait after ducking before the caller must confirm or
   *  cancel. Default 400. */
  confirmMs?: number;
  /** Max speech length (ms) that still counts as a backchannel.
   *  Default 1200. */
  backchannelMaxMs?: number;
  /** Adapt the grace window from repeat interrupts. Default true. */
  adaptiveGrace?: boolean;
  /** The v2 controller to wrap (a fresh one by default). */
  controller?: BargeInController;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * Decides *what kind* of speech the user just made, then acts.
 * The model-speech lifecycle (`modelSpeechStarted` /
 * `noteModelTranscript` / `modelSpeechEnded`) delegates straight
 * to the v2 controller so partials and timing stay in one place.
 */
export class BargeInV3Controller {
  private readonly controller: BargeInController;
  private readonly resumePolicy: BargeInResumePolicy;
  private readonly softInterrupt: boolean;
  private readonly confirmMs: number;
  private readonly backchannelMaxMs: number;
  private readonly adaptiveGrace: boolean;
  private readonly clock: () => number;
  private graceMs: number;
  private readonly minSpeechMs: number;
  private backchannels = 0;
  private ducks = 0;
  private duckConfirmed = 0;
  private duckCancelled = 0;
  private graceAdaptations = 0;
  private repeatAfterGrace = 0;
  private lastGraceIgnoreAt: number | null = null;
  private repeatsSinceStep = 0;
  /** A duck is waiting for confirmation (started at this time). */
  private duckPendingAt: number | null = null;
  private duckPendingSource: BargeInSource | null = null;
  private duckPendingV2: BargeInV2Decision | null = null;

  constructor(options: BargeInV3Options = {}) {
    this.graceMs = Math.max(
      BARGE_IN_V3_GRACE_MIN_MS,
      options.graceMs ?? BARGE_IN_V2_DEFAULT_GRACE_MS,
    );
    this.minSpeechMs = Math.max(0, options.minSpeechMs ?? BARGE_IN_V2_DEFAULT_MIN_SPEECH_MS);
    this.resumePolicy = options.resumePolicy ?? 'restart';
    this.softInterrupt = options.softInterrupt ?? false;
    this.confirmMs = Math.max(0, options.confirmMs ?? BARGE_IN_V3_DEFAULT_CONFIRM_MS);
    this.backchannelMaxMs =
      options.backchannelMaxMs ?? BARGE_IN_V3_DEFAULT_BACKCHANNEL_MAX_MS;
    this.adaptiveGrace = options.adaptiveGrace ?? true;
    this.clock = options.clock ?? Date.now;
    this.controller =
      options.controller ??
      new BargeInController({
        graceMs: this.graceMs,
        minSpeechMs: this.minSpeechMs,
        resumePolicy: this.resumePolicy,
        clock: this.clock,
      });
  }

  /** The wrapped v2 controller (partials, measurements). */
  getV2(): BargeInController {
    return this.controller;
  }

  getGraceMs(): number {
    return this.graceMs;
  }

  getConfirmMs(): number {
    return this.confirmMs;
  }

  /** True while a duck is waiting for confirmation. */
  isDuckPending(): boolean {
    return this.duckPendingAt !== null;
  }

  getStats(): BargeInV3Stats {
    return {
      interrupts: this.controller.getInterruptCount(),
      backchannels: this.backchannels,
      ducks: this.ducks,
      duckConfirmed: this.duckConfirmed,
      duckCancelled: this.duckCancelled,
      graceMs: this.graceMs,
      graceAdaptations: this.graceAdaptations,
      repeatAfterGrace: this.repeatAfterGrace,
      ignored: this.controller.getIgnoredCounts(),
    };
  }

  getPartialTurns(): PartialModelTurn[] {
    return this.controller.getPartialTurns();
  }

  isModelSpeaking(): boolean {
    return this.controller.isModelSpeaking();
  }

  isInterrupting(): boolean {
    return this.controller.isInterrupting();
  }

  modelSpeechStarted(now?: number): void {
    this.controller.modelSpeechStarted(now);
    this.duckPendingAt = null;
    this.duckPendingSource = null;
    this.duckPendingV2 = null;
  }

  noteModelTranscript(text: string, isFinal: boolean): void {
    this.controller.noteModelTranscript(text, isFinal);
  }

  modelSpeechEnded(): void {
    this.controller.modelSpeechEnded();
    this.duckPendingAt = null;
    this.duckPendingSource = null;
    this.duckPendingV2 = null;
  }

  /**
   * User speech was heard. `transcript` is the interim text when
   * the caller has it (local STT / provider input transcription);
   * without it, backchannel detection cannot run and the speech
   * goes through the v2 path. `speechMs` is how long the user has
   * been speaking so far.
   */
  noteSpeech(
    source: BargeInSource,
    opts: { speechMs?: number; transcript?: string; now?: number } = {},
  ): BargeInV3Decision {
    const now = opts.now ?? this.clock();
    const base = {
      source,
      resumePolicy: this.resumePolicy,
      graceMs: this.graceMs,
      at: now,
    };
    // A duck is already pending: more speech confirms it.
    if (this.duckPendingAt !== null) {
      return this.confirmDuck(true, source, now);
    }
    if (!this.controller.isModelSpeaking()) {
      const v2 = this.controller.noteSpeech(source, { speechMs: opts.speechMs, now });
      return {
        ...base,
        action: 'ignore',
        reason: v2.reason,
        speechAtMs: v2.speechAtMs,
        v2,
      };
    }
    const speechMs = opts.speechMs ?? Number.POSITIVE_INFINITY;
    // Backchannel: short + an affirmation transcript. The model
    // keeps talking; the "yeah" is counted, not acted on.
    if (
      speechMs <= this.backchannelMaxMs &&
      isBackchannelTranscript(opts.transcript)
    ) {
      this.backchannels += 1;
      return {
        ...base,
        action: 'backchannel',
        reason: 'backchannel',
        speechAtMs: null,
        v2: null,
      };
    }
    const v2 = this.controller.noteSpeech(source, { speechMs: opts.speechMs, now });
    if (v2.action === 'ignore') {
      if (v2.reason === 'grace') this.lastGraceIgnoreAt = now;
      return {
        ...base,
        action: 'ignore',
        reason: v2.reason,
        speechAtMs: v2.speechAtMs,
        v2,
      };
    }
    // A real interrupt, right after a grace-ignore of the same
    // reply: the user had to repeat themselves — the grace was
    // too long. Count it; three in a row shrink the grace.
    if (this.adaptiveGrace && this.lastGraceIgnoreAt !== null) {
      if (now - this.lastGraceIgnoreAt <= BARGE_IN_V3_REPEAT_WINDOW_MS) {
        this.repeatAfterGrace += 1;
        this.repeatsSinceStep += 1;
        if (this.repeatsSinceStep >= BARGE_IN_V3_REPEATS_PER_STEP) {
          this.graceMs = Math.max(
            BARGE_IN_V3_GRACE_MIN_MS,
            this.graceMs - BARGE_IN_V3_GRACE_STEP_MS,
          );
          this.graceAdaptations += 1;
          this.repeatsSinceStep = 0;
        }
      }
      this.lastGraceIgnoreAt = null;
    }
    if (this.softInterrupt) {
      this.ducks += 1;
      this.duckPendingAt = now;
      this.duckPendingSource = source;
      this.duckPendingV2 = v2;
      return {
        ...base,
        action: 'duck',
        reason: 'ducked',
        speechAtMs: v2.speechAtMs,
        v2,
      };
    }
    return {
      ...base,
      action: 'interrupt',
      reason: v2.reason,
      speechAtMs: v2.speechAtMs,
      v2,
    };
  }

  /**
   * Resolve a pending duck. `continued: true` (the user kept
   * talking past `confirmMs`) confirms the interrupt — the caller
   * then cancels the response exactly as for a v2 interrupt.
   * `continued: false` (the user stopped) cancels the duck and
   * playback resumes; the v2 interrupt that was already decided
   * is rolled back so the meter does not record a phantom
   * barge-in. Returns the decision the caller should act on.
   */
  confirmDuck(
    continued: boolean,
    source?: BargeInSource,
    now?: number,
  ): BargeInV3Decision {
    const at = now ?? this.clock();
    const pending = this.duckPendingV2;
    const pendingSource = this.duckPendingSource ?? source ?? 'local_vad';
    const wasPending = this.duckPendingAt !== null;
    this.duckPendingAt = null;
    this.duckPendingSource = null;
    this.duckPendingV2 = null;
    if (!wasPending || !pending) {
      return {
        action: 'ignore',
        reason: 'not-speaking',
        source: pendingSource,
        speechAtMs: null,
        v2: null,
        resumePolicy: this.resumePolicy,
        graceMs: this.graceMs,
        at,
      };
    }
    if (continued) {
      this.duckConfirmed += 1;
      return {
        action: 'interrupt',
        reason: 'duck-confirmed',
        source: pendingSource,
        speechAtMs: pending.speechAtMs,
        v2: pending,
        resumePolicy: this.resumePolicy,
        graceMs: this.graceMs,
        at,
      };
    }
    // Roll back the v2 interrupt: the meter began, but the cancel
    // was never sent and the model never stopped — unwind it so
    // the meter records no phantom barge-in and the model keeps
    // speaking from where it was.
    this.duckCancelled += 1;
    this.controller.cancelPendingInterrupt();
    return {
      action: 'ignore',
      reason: 'duck-cancelled',
      source: pendingSource,
      speechAtMs: pending.speechAtMs,
      v2: null,
      resumePolicy: this.resumePolicy,
      graceMs: this.graceMs,
      at,
    };
  }

  /** The caller sent the cancel to the transport. */
  cancelSent(): void {
    this.controller.cancelSent();
  }

  /** Playback was flushed (sink emptied / TTS stopped). */
  playbackFlushed(): void {
    this.controller.playbackFlushed();
  }

  /**
   * The session is listening again: finish the measurement, keep
   * the cut-off reply as a partial turn. Delegates to v2.
   */
  backToListening(): ReturnType<BargeInController['backToListening']> {
    return this.controller.backToListening();
  }

  /** Keep the cut-off reply when the interruption was decided
   *  elsewhere (the session's own server-VAD barge-in). */
  takeExternalPartial(source: BargeInSource): PartialModelTurn | null {
    return this.controller.takeExternalPartial(source);
  }

  /** Reset all state (new call). Measurements are dropped too. */
  reset(): void {
    this.controller.reset();
    this.backchannels = 0;
    this.ducks = 0;
    this.duckConfirmed = 0;
    this.duckCancelled = 0;
    this.graceAdaptations = 0;
    this.repeatAfterGrace = 0;
    this.lastGraceIgnoreAt = null;
    this.repeatsSinceStep = 0;
    this.duckPendingAt = null;
    this.duckPendingSource = null;
    this.duckPendingV2 = null;
  }

}

/**
 * The "continue from here" prompt for the turn after a cut-off
 * reply. `resume` asks the model to continue the partial text
 * where it stopped; `restart` tells it the cut reply is dropped
 * and it should wait for the user instead of repeating itself.
 * Empty partial text degrades to a plain "continue" note.
 */
export function buildResumePrompt(
  partialText: string,
  policy: BargeInResumePolicy,
): string {
  const cut = String(partialText ?? '').trim().slice(0, 500);
  if (policy === 'resume' && cut) {
    return (
      `Your last reply was cut off after you said: "${cut}". ` +
      `Continue from exactly where you stopped — do not restart the reply and do not repeat what you already said.`
    );
  }
  if (policy === 'resume') {
    return 'Your last reply was cut off before you said anything audible. Continue it from the start.';
  }
  if (cut) {
    return (
      `Your last reply was cut off after you said: "${cut}". ` +
      `Do not repeat it — wait for the user to say what they want instead.`
    );
  }
  return 'Your last reply was cut off. Do not repeat it — wait for the user to say what they want instead.';
}
