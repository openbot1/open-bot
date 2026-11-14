/**
 * Barge-in v4 (v1.05, Team T5 — barge-in v2).
 *
 * v3 decided *what kind* of speech interrupted the model
 * (backchannel / duck / interrupt). v4 makes the *detection*
 * itself trustworthy, on the local path where the app hears the
 * user before the provider does:
 *
 *   - Energy gate: a frame only counts when its RMS is above a
 *     threshold — quiet room noise and echo residue never start
 *     an interrupt.
 *   - VAD + debounce: the VAD must say "speech" AND enough
 *     consecutive loud frames must arrive inside a window, so a
 *     single cough or a door slam does not kill a reply.
 *   - State machine: `idle` (model silent) → `listening` (model
 *     speaking, watching) → `interrupted` (cancel sent, waiting
 *     for the resume) — the panel shows the state, not a guess.
 *   - TTS cancel under 50 ms: `interrupt()` measures the stop
 *     itself (the caller passes the stop function; the mock
 *     transport stops instantly and the measurement proves it).
 *     Every stop over budget is a breach, counted and reported.
 *   - Resume partial utterance: the cut reply's spoken text is
 *     kept, and `buildResumeUtterance()` turns it into the
 *     "continue from here" prompt — the model resumes the
 *     sentence instead of restarting it.
 *
 * The v3 controller still owns backchannel / duck decisions on
 * the paths that have transcripts; v4 owns the *signal* path
 * (frames + energy + VAD). Both feed the same session interrupt.
 */
import { LatencyHistogram, type LatencyHistogramSummary } from './latencyPipeline';

/** Barge-in v4 state, as the panel renders it. */
export type BargeInV4State = 'idle' | 'listening' | 'interrupted';

/** Why one audio frame (or speech event) did not interrupt. */
export type BargeInV4IgnoreReason =
  | 'not-speaking'
  | 'below-energy'
  | 'no-vad'
  | 'debouncing';

/** What v4 decided about one audio frame. */
export type BargeInV4Action = 'interrupt' | 'ignore';

export interface BargeInV4Decision {
  action: BargeInV4Action;
  reason: BargeInV4IgnoreReason | 'confirmed';
  /** Consecutive loud+VAD frames seen (debounce progress). */
  frames: number;
  /** Frames still needed before an interrupt fires. */
  framesNeeded: number;
  /** RMS of the frame that produced this decision. */
  rms: number;
  /** State after this decision. */
  state: BargeInV4State;
  at: number;
}

/** Result of cancelling the TTS playback. */
export interface BargeInV4InterruptResult {
  /** True when the cancel was actually sent. */
  stopped: boolean;
  /** Wall time of the stop (ms) — measured, not estimated. */
  stopLatencyMs: number | null;
  /** True when the stop beat the 50 ms budget. */
  withinBudget: boolean;
  /** Text the model had spoken before being cut ('' when none). */
  partialText: string;
  at: number;
}

/** The cut reply, kept so the next turn can resume it. */
export interface BargeInV4PartialUtterance {
  text: string;
  /** ms into the model reply when the cut happened. */
  cutAtMs: number | null;
  /** Stop latency of the cancel that cut it (ms). */
  stopLatencyMs: number | null;
  at: number;
}

export interface BargeInV4Stats {
  state: BargeInV4State;
  interrupts: number;
  ignored: Record<BargeInV4IgnoreReason, number>;
  stopLatency: LatencyHistogramSummary | null;
  /** Stops that missed the 50 ms budget. */
  stopBreaches: number;
  /** Partials kept for resume (newest last). */
  partials: number;
  /** Last partial text ('' when none). */
  lastPartialText: string;
}

/** Default RMS above which a frame counts as user speech. */
export const BARGE_IN_V4_DEFAULT_ENERGY_THRESHOLD = 0.02;
/** Default consecutive loud+VAD frames needed to interrupt. */
export const BARGE_IN_V4_DEFAULT_DEBOUNCE_FRAMES = 3;
/** Default window (ms) the debounce frames must arrive inside. */
export const BARGE_IN_V4_DEFAULT_DEBOUNCE_WINDOW_MS = 500;
/** Barge-in stop budget: TTS must die within this long (ms). */
export const BARGE_IN_V4_STOP_BUDGET_MS = 50;
/** Partial text kept past this long is trimmed (chars). */
export const BARGE_IN_V4_MAX_PARTIAL_CHARS = 500;

export interface BargeInV4Options {
  /** RMS threshold for a frame to count. Default 0.02. */
  energyThreshold?: number;
  /** Consecutive frames needed. Default 3. */
  debounceFrames?: number;
  /** Window (ms) the frames must arrive inside. Default 500. */
  debounceWindowMs?: number;
  /** Require the VAD to say "speech" (default true). When false,
   *  energy alone can interrupt — only for tests / no-VAD rigs. */
  vadRequired?: boolean;
  /** Stop budget (ms). Default 50. */
  stopBudgetMs?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * Frame-level barge-in detector. The caller feeds PCM frames
 * (`noteAudioFrame`) while the model speaks; when the energy
 * gate, the VAD, and the debounce all agree, the decision is
 * `interrupt` — and only then should the caller call
 * `interrupt()` to cancel the TTS and keep the partial.
 */
export class BargeInV4Controller {
  private readonly energyThreshold: number;
  private readonly debounceFrames: number;
  private readonly debounceWindowMs: number;
  private readonly vadRequired: boolean;
  private readonly stopBudgetMs: number;
  private readonly clock: () => number;
  private readonly stopLatency = new LatencyHistogram();
  private state: BargeInV4State = 'idle';
  private modelSpeechStartedAt: number | null = null;
  private modelPartialText = '';
  private consecutiveFrames = 0;
  private firstFrameAt: number | null = null;
  private interrupts = 0;
  private stopBreaches = 0;
  private readonly ignored: Record<BargeInV4IgnoreReason, number> = {
    'not-speaking': 0,
    'below-energy': 0,
    'no-vad': 0,
    debouncing: 0,
  };
  private readonly partials: BargeInV4PartialUtterance[] = [];

  constructor(options: BargeInV4Options = {}) {
    this.energyThreshold = Math.max(0, options.energyThreshold ?? BARGE_IN_V4_DEFAULT_ENERGY_THRESHOLD);
    this.debounceFrames = Math.max(1, Math.floor(options.debounceFrames ?? BARGE_IN_V4_DEFAULT_DEBOUNCE_FRAMES));
    this.debounceWindowMs = Math.max(1, options.debounceWindowMs ?? BARGE_IN_V4_DEFAULT_DEBOUNCE_WINDOW_MS);
    this.vadRequired = options.vadRequired ?? true;
    this.stopBudgetMs = Math.max(1, options.stopBudgetMs ?? BARGE_IN_V4_STOP_BUDGET_MS);
    this.clock = options.clock ?? Date.now;
  }

  getState(): BargeInV4State {
    return this.state;
  }

  isModelSpeaking(): boolean {
    return this.state === 'listening';
  }

  getStopBudgetMs(): number {
    return this.stopBudgetMs;
  }

  /** The model started a reply: start watching for barge-in. */
  modelSpeechStarted(partialText = ''): void {
    this.state = 'listening';
    this.modelSpeechStartedAt = this.clock();
    this.modelPartialText = partialText;
    this.consecutiveFrames = 0;
    this.firstFrameAt = null;
  }

  /** The model finished a reply on its own: stop watching. */
  modelSpeechEnded(): void {
    this.state = 'idle';
    this.modelSpeechStartedAt = null;
    this.modelPartialText = '';
    this.consecutiveFrames = 0;
    this.firstFrameAt = null;
  }

  /** Note the text the model has spoken so far (for the partial). */
  noteModelText(text: string): void {
    if (typeof text === 'string' && text) this.modelPartialText = text;
  }

  /**
   * One mic frame while the model may be speaking. Returns the
   * decision: `interrupt` only when the model is speaking AND
   * the frame is loud AND the VAD agrees AND the debounce is
   * satisfied. Everything else is an `ignore` with the reason.
   */
  noteAudioFrame(input: { rms: number; vadActive?: boolean; at?: number }): BargeInV4Decision {
    const at = input.at ?? this.clock();
    const rms = input.rms;
    const base = {
      rms,
      frames: this.consecutiveFrames,
      framesNeeded: Math.max(0, this.debounceFrames - this.consecutiveFrames),
      state: this.state,
      at,
    };
    if (this.state !== 'listening') {
      this.ignored['not-speaking'] += 1;
      return { ...base, action: 'ignore', reason: 'not-speaking' };
    }
    if (!(rms >= this.energyThreshold)) {
      this.consecutiveFrames = 0;
      this.firstFrameAt = null;
      this.ignored['below-energy'] += 1;
      return { ...base, action: 'ignore', reason: 'below-energy', frames: 0, framesNeeded: this.debounceFrames };
    }
    if (this.vadRequired && input.vadActive !== true) {
      this.consecutiveFrames = 0;
      this.firstFrameAt = null;
      this.ignored['no-vad'] += 1;
      return { ...base, action: 'ignore', reason: 'no-vad', frames: 0, framesNeeded: this.debounceFrames };
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
   * Cancel the TTS playback now. `stopTts` is the caller's stop
   * (sync ms, or an async stop that resolves with its own ms);
   * the latency is measured with the injected clock around the
   * call so a fake clock makes the measurement exact in tests.
   * Returns the measured stop latency and the partial kept.
   */
  async interrupt(
    stopTts?: () => number | Promise<number> | void | Promise<void>,
  ): Promise<BargeInV4InterruptResult> {
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
    const partialText = this.modelPartialText.slice(0, BARGE_IN_V4_MAX_PARTIAL_CHARS);
    const cutAtMs =
      this.modelSpeechStartedAt === null ? null : Math.max(0, at - this.modelSpeechStartedAt);
    this.partials.push({ text: partialText, cutAtMs, stopLatencyMs: stopMs, at });
    this.state = 'interrupted';
    this.consecutiveFrames = 0;
    this.firstFrameAt = null;
    return { stopped: true, stopLatencyMs: stopMs, withinBudget, partialText, at };
  }

  /**
   * Resume the cut reply: returns the partial kept by the last
   * interrupt plus the prompt the next turn should use, and the
   * state goes back to `listening` (the model is speaking again).
   * Returns null when nothing was cut.
   */
  resumePartial(): { partial: BargeInV4PartialUtterance; resumePrompt: string } | null {
    const partial = this.partials[this.partials.length - 1];
    if (!partial || !partial.text.trim()) return null;
    this.state = 'listening';
    this.modelSpeechStartedAt = this.clock();
    this.modelPartialText = partial.text;
    return { partial: { ...partial }, resumePrompt: buildResumeUtterance(partial.text) };
  }

  getPartials(): BargeInV4PartialUtterance[] {
    return this.partials.map((p) => ({ ...p }));
  }

  getLastPartialText(): string {
    return this.partials[this.partials.length - 1]?.text ?? '';
  }

  getStats(): BargeInV4Stats {
    return {
      state: this.state,
      interrupts: this.interrupts,
      ignored: { ...this.ignored },
      stopLatency: this.stopLatency.summary(),
      stopBreaches: this.stopBreaches,
      partials: this.partials.length,
      lastPartialText: this.getLastPartialText(),
    };
  }

  reset(): void {
    this.state = 'idle';
    this.modelSpeechStartedAt = null;
    this.modelPartialText = '';
    this.consecutiveFrames = 0;
    this.firstFrameAt = null;
    this.interrupts = 0;
    this.stopBreaches = 0;
    this.partials.length = 0;
    this.stopLatency.clear();
    for (const key of Object.keys(this.ignored) as BargeInV4IgnoreReason[]) {
      this.ignored[key] = 0;
    }
  }
}

/**
 * "Continue from here" prompt for the turn after a cut reply.
 * The model resumes the sentence it was cut off in, instead of
 * restarting the answer.
 */
export function buildResumeUtterance(partialText: string): string {
  const text = (partialText ?? '').trim().slice(0, BARGE_IN_V4_MAX_PARTIAL_CHARS);
  if (!text) return 'The previous reply was interrupted before it started. Please answer the user again, briefly.';
  return (
    'Your previous reply was interrupted mid-sentence. Continue exactly where you left off, ' +
    `without restarting or repeating the introduction. What you had said so far: "${text}"`
  );
}
