/**
 * Barge-in v11 (v1.12, Đội T5 — voice realtime v11).
 *
 * v9's controller decided "interrupt or not" but kept its state
 * implicit (a handful of booleans: speaking / thinking / ducked /
 * graceStartedAt). That made two questions unanswerable from the
 * outside: *which* state is the call in right now, and *was* a
 * transition legal? v11 makes the machine explicit:
 *
 *   idle ──▶ listening ──▶ thinking ──▶ speaking ──▶ listening
 *              ▲  │  ▲         │  ▲          │  ▲
 *              │  │  │         │  │          │  │
 *              │  └─ ducked ───┘  └─ ducked ─┘  │
 *              │     (user talks over the agent) │
 *              └── interrupted ──▶ cooldown ────┘
 *
 * Every transition goes through one guarded table
 * (`BARGE_IN_V11_TRANSITIONS`): an illegal move (e.g. interrupt
 * while idle, duck while listening) returns `{ ok: false }` and
 * is counted, never silently applied. The log keeps the last 200
 * transitions with `from → to`, the trigger and the virtual time,
 * so a "why did the call cut off?" question has an answer.
 *
 * Policies: `immediate` / `grace` / `confirm` (same meanings as
 * v9) plus `smart` — interrupt only when the user's speech is
 * confident (`confidence >= smartConfidence`, default 0.7) and
 * long enough (`speechMs >= smartMinSpeechMs`, default 200 ms);
 * a confident-but-short burst ducks instead of cutting; a
 * low-confidence burst is ignored as probable noise. Short
 * bursts below `minSpeechMs` never interrupt under any policy
 * (a cough is not a turn); echo-only frames never interrupt.
 *
 * The interrupt receipt is exact, like v9's: which word was cut,
 * played vs discarded milliseconds, words played vs discarded,
 * whether the agent was still thinking, and the barge-in latency
 * (VAD speech-start → interrupt, virtual ms) so the panel can
 * show "ngắt lời trong X ms".
 *
 * No audio device, no model: the controller only tracks words,
 * timers (caller-owned virtual clock) and decisions.
 */

/** Barge-in v11 policy names. */
export type BargeInV11Policy = 'immediate' | 'grace' | 'confirm' | 'smart';

/** Barge-in v11 states (the explicit call machine). */
export type BargeInV11State =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'ducked'
  | 'interrupted'
  | 'cooldown';

/** Options for `BargeInV11Controller`. */
export interface BargeInV11Options {
  /** Interruption policy (default `smart`). */
  policy?: BargeInV11Policy;
  /** Grace window before a speech-start becomes an interrupt (ms). */
  graceMs?: number;
  /** Cooldown after an interrupt during which new ones are ignored (ms). */
  cooldownMs?: number;
  /** Playback volume factor while ducked (0..1). */
  duckFactor?: number;
  /** Minimum speech duration that counts as an interruption attempt (ms). */
  minSpeechMs?: number;
  /** `smart` policy: confidence at/above which speech may interrupt (0..1). */
  smartConfidence?: number;
  /** `smart` policy: speech duration at/above which speech may interrupt (ms). */
  smartMinSpeechMs?: number;
  /** Max transitions kept in the log (default 200). */
  maxTransitions?: number;
}

/** One word in the playback queue. */
export interface BargeInV11Word {
  text: string;
  /** Duration of this word's audio (ms). */
  durationMs: number;
}

/** Why an interruption attempt was decided the way it was. */
export type BargeInV11DecisionReason =
  | 'speech-confirmed'
  | 'grace-expired'
  | 'smart-confirmed'
  | 'smart-duck'
  | 'policy-confirm'
  | 'ignored-cooldown'
  | 'ignored-echo'
  | 'ignored-too-short'
  | 'ignored-low-confidence'
  | 'not-speaking'
  | 'explicit';

/** The controller's decision for one speech event. */
export interface BargeInV11Decision {
  /** True when the reply should be cut now. */
  interrupt: boolean;
  /** True when playback should duck (user talks over the agent). */
  duck: boolean;
  reason: BargeInV11DecisionReason;
  /** Grace remaining when the decision was `grace-expired` (ms). */
  graceRemainingMs?: number;
  /** Cooldown remaining when the decision was `ignored-cooldown` (ms). */
  cooldownRemainingMs?: number;
}

/** Exact receipt of what an interrupt kept vs threw away. */
export interface BargeInV11InterruptResult {
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
  /** State the machine was in before the cut. */
  fromState: BargeInV11State;
  /** Barge-in latency: VAD speech-start → interrupt (ms, null when explicit). */
  latencyMs: number | null;
  atMs: number;
}

/** Counters for one controller. */
export interface BargeInV11Stats {
  attempts: number;
  interrupts: number;
  ignoredCooldown: number;
  ignoredEcho: number;
  ignoredTooShort: number;
  ignoredLowConfidence: number;
  ducks: number;
  resumes: number;
  illegalTransitions: number;
  lastInterruptAtMs: number | null;
  /** Mean barge-in latency over interrupts (ms, null when none). */
  meanLatencyMs: number | null;
  /** Slowest barge-in latency (ms, null when none). */
  maxLatencyMs: number | null;
  ducked: boolean;
  state: BargeInV11State;
}

/** One logged state transition. */
export interface BargeInV11Transition {
  from: BargeInV11State;
  to: BargeInV11State;
  trigger: string;
  atMs: number;
  ok: boolean;
  reason?: string;
}

/** Events emitted by the controller. */
export type BargeInV11Event =
  | { kind: 'transition'; transition: BargeInV11Transition }
  | { kind: 'interrupt'; result: BargeInV11InterruptResult }
  | { kind: 'duck'; atMs: number; factor: number }
  | { kind: 'resume'; atMs: number }
  | { kind: 'ignored'; decision: BargeInV11Decision; atMs: number };

export type BargeInV11EventSink = (event: BargeInV11Event) => void;

/**
 * Guarded transition table: `from → to` is legal only when listed.
 * `ducked` is a sub-state of speaking (the reply keeps playing at
 * reduced volume); `interrupted` is transient — `tick()` moves it
 * to `cooldown`, and `tick()` moves `cooldown` back to `listening`
 * when the cooldown expires.
 */
export const BARGE_IN_V11_TRANSITIONS: Record<BargeInV11State, BargeInV11State[]> = {
  idle: ['listening'],
  listening: ['thinking', 'speaking', 'idle'],
  thinking: ['speaking', 'interrupted', 'listening', 'idle'],
  speaking: ['ducked', 'interrupted', 'listening', 'idle'],
  ducked: ['speaking', 'interrupted', 'listening', 'idle'],
  interrupted: ['cooldown', 'listening', 'idle'],
  cooldown: ['listening', 'idle'],
};

export const BARGE_IN_V11_STATES = [
  'idle', 'listening', 'thinking', 'speaking', 'ducked', 'interrupted', 'cooldown',
] as const;

export function isBargeInV11Policy(value: unknown): value is BargeInV11Policy {
  return value === 'immediate' || value === 'grace' || value === 'confirm' || value === 'smart';
}

export function isBargeInV11State(value: unknown): value is BargeInV11State {
  return typeof value === 'string' && (BARGE_IN_V11_STATES as readonly string[]).includes(value);
}

export function defaultBargeInV11Options(): Required<BargeInV11Options> {
  return {
    policy: 'smart',
    graceMs: 300,
    cooldownMs: 1500,
    duckFactor: 0.35,
    minSpeechMs: 150,
    smartConfidence: 0.7,
    smartMinSpeechMs: 200,
    maxTransitions: 200,
  };
}

export function validateBargeInV11Options(options: BargeInV11Options): Required<BargeInV11Options> {
  const base = defaultBargeInV11Options();
  const policy = options.policy ?? base.policy;
  if (!isBargeInV11Policy(policy)) {
    throw new Error('Barge-in v11 policy must be "immediate", "grace", "confirm" or "smart".');
  }
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Barge-in v11 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    policy,
    graceMs: num(options.graceMs, base.graceMs, 'graceMs', 0, 10000),
    cooldownMs: num(options.cooldownMs, base.cooldownMs, 'cooldownMs', 0, 60000),
    duckFactor: num(options.duckFactor, base.duckFactor, 'duckFactor', 0, 1),
    minSpeechMs: num(options.minSpeechMs, base.minSpeechMs, 'minSpeechMs', 0, 5000),
    smartConfidence: num(options.smartConfidence, base.smartConfidence, 'smartConfidence', 0, 1),
    smartMinSpeechMs: num(options.smartMinSpeechMs, base.smartMinSpeechMs, 'smartMinSpeechMs', 0, 5000),
    maxTransitions: Math.floor(num(options.maxTransitions, base.maxTransitions, 'maxTransitions', 10, 10000)),
  };
}

/**
 * Split reply text into words with an even duration split.
 * Same contract as v9's `splitWordsV9`, kept local so v11 does
 * not depend on the v9 module's shape.
 */
export function splitWordsV11(text: string, totalMs: number): BargeInV11Word[] {
  const words = text.split(/\s+/).map((w) => w.trim()).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const each = Math.max(1, Math.floor(totalMs / words.length));
  return words.map((word, i) => ({
    text: word,
    durationMs: i === words.length - 1 ? Math.max(1, totalMs - each * (words.length - 1)) : each,
  }));
}

/**
 * Policy-driven barge-in state machine. The caller owns the clock:
 * pass `nowMs` explicitly so tests and the session share one
 * timeline; call `tick(nowMs)` to expire grace / cooldown.
 */
export class BargeInV11Controller {
  private options: Required<BargeInV11Options>;
  private readonly sink: BargeInV11EventSink | null;
  private state: BargeInV11State = 'idle';
  private queue: BargeInV11Word[] = [];
  private playedMs = 0;
  private graceStartedAtMs: number | null = null;
  private speechStartedAtMs: number | null = null;
  private cooldownUntilMs: number | null = null;
  private lastInterruptAtMs: number | null = null;
  private latencies: number[] = [];
  private transitions: BargeInV11Transition[] = [];
  private stats: Omit<BargeInV11Stats, 'ducked' | 'state'> & { illegalTransitions: number };

  constructor(options: BargeInV11Options = {}, sink: BargeInV11EventSink | null = null) {
    this.options = validateBargeInV11Options(options);
    this.sink = sink;
    this.stats = {
      attempts: 0, interrupts: 0, ignoredCooldown: 0, ignoredEcho: 0,
      ignoredTooShort: 0, ignoredLowConfidence: 0, ducks: 0, resumes: 0,
      illegalTransitions: 0, lastInterruptAtMs: null, meanLatencyMs: null, maxLatencyMs: null,
    };
  }

  getOptions(): Required<BargeInV11Options> {
    return { ...this.options };
  }

  reconfigure(options: BargeInV11Options): Required<BargeInV11Options> {
    this.options = validateBargeInV11Options({ ...this.options, ...options });
    return { ...this.options };
  }

  getState(): BargeInV11State {
    return this.state;
  }

  getStats(): BargeInV11Stats {
    return {
      ...this.stats,
      meanLatencyMs: this.latencies.length > 0
        ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length)
        : null,
      maxLatencyMs: this.latencies.length > 0 ? Math.max(...this.latencies) : null,
      ducked: this.state === 'ducked',
      state: this.state,
    };
  }

  isDucked(): boolean {
    return this.state === 'ducked';
  }

  /** Logged transitions (copies, oldest first). */
  getTransitions(): BargeInV11Transition[] {
    return this.transitions.map((t) => ({ ...t }));
  }

  /** Last transition, or null when none. */
  getLastTransition(): BargeInV11Transition | null {
    const t = this.transitions[this.transitions.length - 1];
    return t ? { ...t } : null;
  }

  /**
   * Attempt a state move through the guarded table. Returns false
   * (and counts + logs it) when the move is illegal. A move to
   * the current state is a no-op that returns true.
   */
  transitionTo(to: BargeInV11State, trigger: string, atMs: number): boolean {
    if (to === this.state) return true;
    const allowed = BARGE_IN_V11_TRANSITIONS[this.state] ?? [];
    if (!allowed.includes(to)) {
      this.stats.illegalTransitions += 1;
      this.logTransition(this.state, to, trigger, atMs, false, `illegal: ${this.state} -> ${to}`);
      return false;
    }
    this.logTransition(this.state, to, trigger, atMs, true);
    this.state = to;
    return true;
  }

  private logTransition(from: BargeInV11State, to: BargeInV11State, trigger: string, atMs: number, ok: boolean, reason?: string): void {
    const t: BargeInV11Transition = { from, to, trigger, atMs, ok, ...(reason ? { reason } : {}) };
    this.transitions.push(t);
    if (this.transitions.length > this.options.maxTransitions) {
      this.transitions.splice(0, this.transitions.length - this.options.maxTransitions);
    }
    this.sink?.({ kind: 'transition', transition: { ...t } });
  }

  /** The call starts: idle → listening. */
  startListening(nowMs: number): boolean {
    return this.transitionTo('listening', 'start', nowMs);
  }

  /** The agent starts thinking (reply pending, no audio yet). Only legal from `listening`. */
  beginThinking(nowMs: number): boolean {
    return this.transitionTo('thinking', 'begin-thinking', nowMs);
  }

  /** The agent starts speaking: load the playback queue. */
  beginSpeaking(words: BargeInV11Word[], nowMs: number): boolean {
    const from = this.state;
    if (from !== 'thinking' && from !== 'listening') {
      return this.transitionTo('speaking', 'begin-speaking', nowMs);
    }
    this.queue = [...words];
    this.playedMs = 0;
    this.graceStartedAtMs = null;
    return this.transitionTo('speaking', 'begin-speaking', nowMs);
  }

  /** Advance the playback clock (the session calls this per word / per tick). */
  advancePlayed(ms: number): void {
    if (this.state !== 'speaking' && this.state !== 'ducked') return;
    if (ms <= 0) return;
    this.playedMs += ms;
  }

  /** The reply finished on its own: speaking/ducked → listening. */
  finishSpeaking(nowMs: number): boolean {
    this.queue = [];
    this.playedMs = 0;
    this.graceStartedAtMs = null;
    return this.transitionTo('listening', 'reply-finished', nowMs);
  }

  /** The call ends: any state → idle. */
  endCall(nowMs: number): boolean {
    this.queue = [];
    this.playedMs = 0;
    this.graceStartedAtMs = null;
    this.speechStartedAtMs = null;
    this.cooldownUntilMs = null;
    if (this.state === 'idle') return true;
    this.logTransition(this.state, 'idle', 'end-call', nowMs, true);
    this.state = 'idle';
    return true;
  }

  /**
   * Advance timers: grace expiry does not interrupt by itself
   * (the next speech event re-decides); `interrupted` moves to
   * `cooldown`, and `cooldown` returns to `listening` when its
   * window expires. Returns the state after the tick.
   */
  tick(nowMs: number): BargeInV11State {
    if (this.state === 'interrupted') {
      this.transitionTo('cooldown', 'interrupt-settled', nowMs);
      // The cooldown window runs from the interrupt itself, not
      // from this tick — a big clock jump expires it in the same
      // call instead of stranding the machine in `cooldown`.
      this.cooldownUntilMs = (this.lastInterruptAtMs ?? nowMs) + this.options.cooldownMs;
    }
    if (this.state === 'cooldown' && this.cooldownUntilMs !== null && nowMs >= this.cooldownUntilMs) {
      this.cooldownUntilMs = null;
      this.transitionTo('listening', 'cooldown-expired', nowMs);
    }
    return this.state;
  }

  /**
   * Decide what a VAD speech-start means right now.
   * `speechMs` is how long the user has been speaking so far;
   * `confidence` is the VAD's smoothed speech probability (0..1);
   * `echoOnly` is true when the frame is known playback echo.
   */
  decideSpeechStart(input: { nowMs: number; speechMs: number; confidence?: number; echoOnly?: boolean }): BargeInV11Decision {
    const o = this.options;
    this.stats.attempts += 1;
    const confidence = input.confidence ?? 1;
    if (this.speechStartedAtMs === null) this.speechStartedAtMs = input.nowMs;
    const deny = (reason: BargeInV11DecisionReason, extra: Partial<BargeInV11Decision> = {}): BargeInV11Decision => {
      const d: BargeInV11Decision = { interrupt: false, duck: false, reason, ...extra };
      this.sink?.({ kind: 'ignored', decision: d, atMs: input.nowMs });
      return d;
    };
    if (input.echoOnly === true) {
      this.stats.ignoredEcho += 1;
      return deny('ignored-echo');
    }
    if (input.speechMs < o.minSpeechMs) {
      this.stats.ignoredTooShort += 1;
      return deny('ignored-too-short');
    }
    if (this.state !== 'speaking' && this.state !== 'ducked' && this.state !== 'thinking') {
      return deny('not-speaking');
    }
    if (this.lastInterruptAtMs !== null && input.nowMs - this.lastInterruptAtMs < o.cooldownMs) {
      this.stats.ignoredCooldown += 1;
      return deny('ignored-cooldown', { cooldownRemainingMs: o.cooldownMs - (input.nowMs - this.lastInterruptAtMs) });
    }
    if (o.policy === 'confirm') {
      return deny('policy-confirm');
    }
    if (o.policy === 'immediate') {
      return { interrupt: true, duck: false, reason: 'speech-confirmed' };
    }
    if (o.policy === 'smart') {
      if (confidence < o.smartConfidence) {
        // Low-confidence speech is probably noise — but if the
        // user keeps talking, ducking is still the safe move when
        // the agent is speaking.
        if (input.speechMs >= o.smartMinSpeechMs && (this.state === 'speaking' || this.state === 'ducked')) {
          this.stats.ignoredLowConfidence += 1;
          return { interrupt: false, duck: true, reason: 'ignored-low-confidence' };
        }
        this.stats.ignoredLowConfidence += 1;
        return deny('ignored-low-confidence');
      }
      if (input.speechMs >= o.smartMinSpeechMs) {
        return { interrupt: true, duck: false, reason: 'smart-confirmed' };
      }
      // Confident but short: duck, do not cut — it may be a
      // backchannel ("ừ", "vâng") rather than a real turn.
      return { interrupt: false, duck: true, reason: 'smart-duck' };
    }
    // Grace policy: first confirmed speech starts the grace clock.
    if (this.graceStartedAtMs === null) {
      this.graceStartedAtMs = input.nowMs;
      return { interrupt: false, duck: false, reason: 'grace-expired', graceRemainingMs: o.graceMs };
    }
    if (input.nowMs - this.graceStartedAtMs >= o.graceMs) {
      this.graceStartedAtMs = null;
      return { interrupt: true, duck: false, reason: 'grace-expired' };
    }
    return {
      interrupt: false,
      duck: false,
      reason: 'grace-expired',
      graceRemainingMs: o.graceMs - (input.nowMs - this.graceStartedAtMs),
    };
  }

  /** Duck playback while the user talks over the agent. */
  duck(nowMs: number): boolean {
    if (this.state !== 'speaking') return false;
    if (!this.transitionTo('ducked', 'duck', nowMs)) return false;
    this.stats.ducks += 1;
    this.sink?.({ kind: 'duck', atMs: nowMs, factor: this.options.duckFactor });
    return true;
  }

  /** Restore full playback volume after ducking. */
  resume(nowMs: number): boolean {
    if (this.state !== 'ducked') return false;
    if (!this.transitionTo('speaking', 'resume', nowMs)) return false;
    this.stats.resumes += 1;
    this.sink?.({ kind: 'resume', atMs: nowMs });
    return true;
  }

  /**
   * Cut the reply now (explicit call, or after `decideSpeechStart`
   * returned `interrupt: true`). Returns the exact receipt and
   * moves the machine to `interrupted` (the caller drives it to
   * `cooldown` with `tick()`).
   */
  interrupt(nowMs: number): BargeInV11InterruptResult {
    const fromState = this.state;
    const wasThinking = this.state === 'thinking';
    const wasSpeaking = this.state === 'speaking' || this.state === 'ducked';
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
    }
    const latencyMs = this.speechStartedAtMs !== null && (wasSpeaking || wasThinking)
      ? Math.max(0, nowMs - this.speechStartedAtMs)
      : null;
    const result: BargeInV11InterruptResult = {
      interrupted: wasSpeaking || wasThinking,
      cutWord,
      cutWordIndex,
      playedMs,
      discardedMs,
      wordsPlayed,
      wordsDiscarded,
      wasThinking,
      fromState,
      latencyMs,
      atMs: nowMs,
    };
    if (result.interrupted) {
      if (latencyMs !== null) this.latencies.push(latencyMs);
      this.lastInterruptAtMs = nowMs;
      this.stats.interrupts += 1;
      this.stats.lastInterruptAtMs = nowMs;
      this.queue = [];
      this.playedMs = 0;
      this.graceStartedAtMs = null;
      this.speechStartedAtMs = null;
      this.transitionTo('interrupted', 'interrupt', nowMs);
      this.sink?.({ kind: 'interrupt', result });
    }
    return result;
  }

  /** A VAD speech-start was observed (starts the latency clock). */
  noteSpeechStarted(nowMs: number): void {
    if (this.speechStartedAtMs === null) this.speechStartedAtMs = nowMs;
  }

  /** The user's turn ended (resets the latency clock). */
  noteSpeechEnded(): void {
    this.speechStartedAtMs = null;
  }

  /** Words still queued (for the panel / diagnostics). */
  getQueuedWords(): BargeInV11Word[] {
    return this.queue.map((w) => ({ ...w }));
  }

  /** Text the reply still owes (resume point after a cut). */
  getRemainingText(): string {
    return this.queue.map((w) => w.text).join(' ');
  }
}

/** One-line human summary of barge-in v11 stats. */
export function bargeInV11Summary(stats: BargeInV11Stats): string {
  return (
    `Barge-in v11: ${stats.state}, ${stats.interrupts} interrupts, ${stats.attempts} attempts ` +
    `(${stats.ignoredCooldown} cooldown, ${stats.ignoredEcho} echo, ${stats.ignoredTooShort} too short, ` +
    `${stats.ignoredLowConfidence} low-confidence), ${stats.ducks} ducks, ` +
    `mean latency ${stats.meanLatencyMs === null ? '-' : `${stats.meanLatencyMs} ms`}, ` +
    `${stats.illegalTransitions} illegal transitions`
  );
}

/** Barge-in v11 stats as Markdown (for the diagnostics panel). */
export function bargeInV11Markdown(stats: BargeInV11Stats): string {
  const lines = [
    '## Barge-in v11',
    '',
    `- state: ${stats.state}, ducked: ${stats.ducked ? 'yes' : 'no'}`,
    `- attempts: ${stats.attempts}, interrupts: ${stats.interrupts}`,
    `- ignored: cooldown ${stats.ignoredCooldown}, echo ${stats.ignoredEcho}, too short ${stats.ignoredTooShort}, low-confidence ${stats.ignoredLowConfidence}`,
    `- ducks: ${stats.ducks}, resumes: ${stats.resumes}`,
    `- mean latency: ${stats.meanLatencyMs === null ? '-' : `${stats.meanLatencyMs} ms`}, max latency: ${stats.maxLatencyMs === null ? '-' : `${stats.maxLatencyMs} ms`}`,
    `- last interrupt: ${stats.lastInterruptAtMs === null ? '-' : `${stats.lastInterruptAtMs} ms`}`,
    `- illegal transitions: ${stats.illegalTransitions}`,
  ];
  return lines.join('\n');
}
