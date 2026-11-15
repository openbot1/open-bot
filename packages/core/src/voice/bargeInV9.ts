/**
 * Barge-in v9 (v1.10, Đội T5 — voice realtime v5).
 *
 * Full-duplex interruption for the v9 session: while the agent is
 * speaking (or thinking), the user may cut in. This controller decides
 * whether a VAD speech-start is a real interruption, and if so, what
 * the playback queue keeps and what it throws away.
 *
 * Design (open-bot's own, same idea family as the v7/v8 controllers
 * but simpler and policy-driven so the UI can explain every decision):
 *
 * - Policies: `immediate` (cut the reply as soon as speech is
 *   confirmed), `grace` (wait `graceMs` so a cough or a one-word
 *   backchannel does not kill a sentence), `confirm` (never interrupt
 *   automatically; only an explicit `interrupt()` call cuts in).
 * - A cooldown after each interrupt (`cooldownMs`) stops the user
 *   from machine-gunning the reply: a second speech-start inside the
 *   cooldown is logged as `ignored-cooldown`, not acted on.
 * - Echo guard: frames flagged as echo-only by the caller (the app
 *   knows what it just played) never trigger an interrupt.
 * - The playback queue is words with durations. `interrupt()` cuts
 *   it and returns an exact receipt: which word was cut, how many
 *   milliseconds of audio were played vs discarded, and how many
 *   words survived. The session keeps the receipt as the cut point
 *   so a resume can continue mid-sentence instead of restarting.
 * - Ducking: while the user speaks over the agent, playback volume
 *   drops to `duckFactor` instead of stopping outright; the caller
 *   restores it with `resume()`.
 * - Interrupt-while-thinking: if the agent has not started speaking
 *   yet, the interrupt cancels the pending reply before any audio
 *   is queued (receipt: zero played, everything discarded).
 *
 * No audio device, no model: the controller only tracks words,
 * timers (injected clock) and decisions. All timings are virtual
 * milliseconds so tests can drive it deterministically.
 */

/** Barge-in policy names. */
export type BargeInV9Policy = 'immediate' | 'grace' | 'confirm';

/** Options for `BargeInV9Controller`. */
export interface BargeInV9Options {
  /** Interruption policy (default `grace`). */
  policy?: BargeInV9Policy;
  /** Grace window before a speech-start becomes an interrupt (ms). */
  graceMs?: number;
  /** Cooldown after an interrupt during which new ones are ignored (ms). */
  cooldownMs?: number;
  /** Playback volume factor while ducked (0..1). */
  duckFactor?: number;
  /** Minimum speech duration that counts as an interruption attempt (ms). */
  minSpeechMs?: number;
}

/** One word in the playback queue. */
export interface BargeInV9Word {
  text: string;
  /** Duration of this word's audio (ms). */
  durationMs: number;
}

/** Why an interruption attempt was decided the way it was. */
export type BargeInV9DecisionReason =
  | 'speech-confirmed'
  | 'grace-expired'
  | 'policy-confirm'
  | 'ignored-cooldown'
  | 'ignored-echo'
  | 'ignored-too-short'
  | 'not-speaking'
  | 'explicit';

/** The controller's decision for one speech event. */
export interface BargeInV9Decision {
  /** True when the reply should be cut now. */
  interrupt: boolean;
  reason: BargeInV9DecisionReason;
  /** Grace remaining when the decision was `grace-expired` (ms). */
  graceRemainingMs?: number;
  /** Cooldown remaining when the decision was `ignored-cooldown` (ms). */
  cooldownRemainingMs?: number;
}

/** Exact receipt of what an interrupt kept vs threw away. */
export interface BargeInV9InterruptResult {
  /** True when something was actually playing / pending. */
  interrupted: boolean;
  /** The word being spoken when the cut happened ('' when thinking). */
  cutWord: string;
  /** Index of the cut word in the queue (-1 when thinking). */
  cutWordIndex: number;
  /** Audio milliseconds already played before the cut. */
  playedMs: number;
  /** Audio milliseconds discarded by the cut. */
  discardedMs: number;
  /** Words fully played before the cut. */
  wordsPlayed: string[];
  /** Words discarded by the cut (including the cut word). */
  wordsDiscarded: string[];
  /** Whether the agent was still thinking (no audio yet). */
  wasThinking: boolean;
  atMs: number;
}

/** Counters for one controller. */
export interface BargeInV9Stats {
  attempts: number;
  interrupts: number;
  ignoredCooldown: number;
  ignoredEcho: number;
  ignoredTooShort: number;
  ducks: number;
  resumes: number;
  lastInterruptAtMs: number | null;
  ducked: boolean;
}

/** Events emitted by the controller. */
export type BargeInV9Event =
  | { kind: 'interrupt'; result: BargeInV9InterruptResult }
  | { kind: 'duck'; atMs: number; factor: number }
  | { kind: 'resume'; atMs: number }
  | { kind: 'ignored'; decision: BargeInV9Decision; atMs: number };

export type BargeInV9EventSink = (event: BargeInV9Event) => void;

export function isBargeInV9Policy(value: unknown): value is BargeInV9Policy {
  return value === 'immediate' || value === 'grace' || value === 'confirm';
}

export function defaultBargeInV9Options(): Required<BargeInV9Options> {
  return {
    policy: 'grace',
    graceMs: 300,
    cooldownMs: 1500,
    duckFactor: 0.35,
    minSpeechMs: 150,
  };
}

export function validateBargeInV9Options(options: BargeInV9Options): Required<BargeInV9Options> {
  const base = defaultBargeInV9Options();
  const policy = options.policy ?? base.policy;
  if (!isBargeInV9Policy(policy)) throw new Error('Barge-in v9 policy must be "immediate", "grace" or "confirm".');
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Barge-in v9 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    policy,
    graceMs: num(options.graceMs, base.graceMs, 'graceMs', 0, 10000),
    cooldownMs: num(options.cooldownMs, base.cooldownMs, 'cooldownMs', 0, 60000),
    duckFactor: num(options.duckFactor, base.duckFactor, 'duckFactor', 0, 1),
    minSpeechMs: num(options.minSpeechMs, base.minSpeechMs, 'minSpeechMs', 0, 5000),
  };
}

/**
 * Split reply text into words with an even duration split.
 * Used by the session to build the playback queue from mock TTS text.
 */
export function splitWordsV9(text: string, totalMs: number): BargeInV9Word[] {
  const words = text.split(/\s+/).map((w) => w.trim()).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const each = Math.max(1, Math.floor(totalMs / words.length));
  return words.map((word, i) => ({
    text: word,
    durationMs: i === words.length - 1 ? Math.max(1, totalMs - each * (words.length - 1)) : each,
  }));
}

/**
 * Policy-driven barge-in controller. The caller owns the clock: pass
 * `nowMs` explicitly so tests and the session share one timeline.
 */
export class BargeInV9Controller {
  private options: Required<BargeInV9Options>;
  private readonly sink: BargeInV9EventSink | null;
  private queue: BargeInV9Word[] = [];
  private playedMs = 0;
  private thinking = false;
  private speaking = false;
  private ducked = false;
  private graceStartedAtMs: number | null = null;
  private lastInterruptAtMs: number | null = null;
  private stats: BargeInV9Stats;

  constructor(options: BargeInV9Options = {}, sink: BargeInV9EventSink | null = null) {
    this.options = validateBargeInV9Options(options);
    this.sink = sink;
    this.stats = {
      attempts: 0, interrupts: 0, ignoredCooldown: 0, ignoredEcho: 0,
      ignoredTooShort: 0, ducks: 0, resumes: 0, lastInterruptAtMs: null, ducked: false,
    };
  }

  getOptions(): Required<BargeInV9Options> {
    return { ...this.options };
  }

  reconfigure(options: BargeInV9Options): Required<BargeInV9Options> {
    this.options = validateBargeInV9Options({ ...this.options, ...options });
    return { ...this.options };
  }

  getStats(): BargeInV9Stats {
    return { ...this.stats, lastInterruptAtMs: this.lastInterruptAtMs, ducked: this.ducked };
  }

  isDucked(): boolean {
    return this.ducked;
  }

  /** The agent starts thinking (reply pending, no audio yet). */
  beginThinking(): void {
    this.thinking = true;
    this.speaking = false;
    this.queue = [];
    this.playedMs = 0;
  }

  /** The agent starts speaking: load the playback queue. */
  beginSpeaking(words: BargeInV9Word[]): void {
    this.thinking = false;
    this.speaking = true;
    this.queue = [...words];
    this.playedMs = 0;
    this.graceStartedAtMs = null;
  }

  /** Advance the playback clock (the session calls this per word / per tick). */
  advancePlayed(ms: number): void {
    if (!this.speaking || ms <= 0) return;
    this.playedMs += ms;
  }

  /** The reply finished on its own. */
  finishSpeaking(): void {
    this.speaking = false;
    this.thinking = false;
    this.queue = [];
    this.playedMs = 0;
    this.graceStartedAtMs = null;
    if (this.ducked) {
      this.ducked = false;
    }
  }

  /**
   * Decide what a VAD speech-start means right now.
   * `speechMs` is how long the user has been speaking so far;
   * `echoOnly` is true when the frame is known playback echo.
   */
  decideSpeechStart(input: { nowMs: number; speechMs: number; echoOnly?: boolean }): BargeInV9Decision {
    const o = this.options;
    this.stats.attempts += 1;
    if (input.echoOnly === true) {
      this.stats.ignoredEcho += 1;
      const d: BargeInV9Decision = { interrupt: false, reason: 'ignored-echo' };
      this.sink?.({ kind: 'ignored', decision: d, atMs: input.nowMs });
      return d;
    }
    if (input.speechMs < o.minSpeechMs) {
      this.stats.ignoredTooShort += 1;
      const d: BargeInV9Decision = { interrupt: false, reason: 'ignored-too-short' };
      this.sink?.({ kind: 'ignored', decision: d, atMs: input.nowMs });
      return d;
    }
    if (!this.speaking && !this.thinking) {
      const d: BargeInV9Decision = { interrupt: false, reason: 'not-speaking' };
      this.sink?.({ kind: 'ignored', decision: d, atMs: input.nowMs });
      return d;
    }
    if (this.lastInterruptAtMs !== null && input.nowMs - this.lastInterruptAtMs < o.cooldownMs) {
      this.stats.ignoredCooldown += 1;
      const d: BargeInV9Decision = {
        interrupt: false,
        reason: 'ignored-cooldown',
        cooldownRemainingMs: o.cooldownMs - (input.nowMs - this.lastInterruptAtMs),
      };
      this.sink?.({ kind: 'ignored', decision: d, atMs: input.nowMs });
      return d;
    }
    if (o.policy === 'confirm') {
      const d: BargeInV9Decision = { interrupt: false, reason: 'policy-confirm' };
      this.sink?.({ kind: 'ignored', decision: d, atMs: input.nowMs });
      return d;
    }
    if (o.policy === 'immediate') {
      return { interrupt: true, reason: 'speech-confirmed' };
    }
    // Grace policy: first confirmed speech starts the grace clock.
    if (this.graceStartedAtMs === null) {
      this.graceStartedAtMs = input.nowMs;
      return { interrupt: false, reason: 'grace-expired', graceRemainingMs: o.graceMs };
    }
    if (input.nowMs - this.graceStartedAtMs >= o.graceMs) {
      this.graceStartedAtMs = null;
      return { interrupt: true, reason: 'grace-expired' };
    }
    return {
      interrupt: false,
      reason: 'grace-expired',
      graceRemainingMs: o.graceMs - (input.nowMs - this.graceStartedAtMs),
    };
  }

  /** Duck playback while the user talks over the agent. */
  duck(nowMs: number): boolean {
    if (!this.speaking || this.ducked) return false;
    this.ducked = true;
    this.stats.ducks += 1;
    this.sink?.({ kind: 'duck', atMs: nowMs, factor: this.options.duckFactor });
    return true;
  }

  /** Restore full playback volume after ducking. */
  resume(nowMs: number): boolean {
    if (!this.ducked) return false;
    this.ducked = false;
    this.stats.resumes += 1;
    this.sink?.({ kind: 'resume', atMs: nowMs });
    return true;
  }

  /**
   * Cut the reply now (explicit call, or after `decideSpeechStart`
   * returned `interrupt: true`). Returns the exact receipt.
   */
  interrupt(nowMs: number): BargeInV9InterruptResult {
    const wasThinking = this.thinking && !this.speaking;
    const wasSpeaking = this.speaking;
    let cutWord = '';
    let cutWordIndex = -1;
    let playedMs = 0;
    let discardedMs = 0;
    const wordsPlayed: string[] = [];
    const wordsDiscarded: string[] = [];
    if (wasSpeaking) {
      let elapsed = 0;
      for (let i = 0; i < this.queue.length; i += 1) {
        const word = this.queue[i]!;
        if (elapsed + word.durationMs <= this.playedMs) {
          wordsPlayed.push(word.text);
          playedMs += word.durationMs;
          elapsed += word.durationMs;
          continue;
        }
        if (cutWordIndex === -1) {
          cutWordIndex = i;
          cutWord = word.text;
          playedMs += Math.max(0, this.playedMs - elapsed);
        }
        wordsDiscarded.push(word.text);
        discardedMs += word.durationMs - (i === cutWordIndex ? Math.max(0, this.playedMs - elapsed) : 0);
        elapsed += word.durationMs;
      }
    } else if (wasThinking) {
      discardedMs = 0;
    }
    const result: BargeInV9InterruptResult = {
      interrupted: wasSpeaking || wasThinking,
      cutWord,
      cutWordIndex,
      playedMs,
      discardedMs,
      wordsPlayed,
      wordsDiscarded,
      wasThinking,
      atMs: nowMs,
    };
    if (result.interrupted) {
      this.lastInterruptAtMs = nowMs;
      this.stats.interrupts += 1;
      this.stats.lastInterruptAtMs = nowMs;
      this.speaking = false;
      this.thinking = false;
      this.queue = [];
      this.playedMs = 0;
      this.graceStartedAtMs = null;
      if (this.ducked) this.ducked = false;
      this.sink?.({ kind: 'interrupt', result });
    }
    return result;
  }
}

/** One-line human summary of barge-in v9 stats. */
export function bargeInV9Summary(stats: BargeInV9Stats): string {
  return (
    `Barge-in v9: ${stats.interrupts} interrupts, ${stats.attempts} attempts ` +
    `(${stats.ignoredCooldown} cooldown, ${stats.ignoredEcho} echo, ${stats.ignoredTooShort} too short), ` +
    `${stats.ducks} ducks, ${stats.ducked ? 'ducked' : 'full volume'}`
  );
}
