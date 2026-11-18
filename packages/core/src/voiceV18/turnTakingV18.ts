/**
 * Turn-taking v6 (v1.20, Đội T5 — voice v18).
 *
 * v17 owned the turn as an explicit state machine (listening /
 * thinking / speaking / interrupted / idle / closed, per-state
 * timeouts, stuck-state recovery) — but it only knew *that* a turn
 * changed, not *why the user stopped talking*. A turn ends for
 * three different reasons and each wants a different reaction:
 * the user finished a sentence (answer now), the user trailed off
 * mid-thought (wait a beat, then answer), or the user went silent
 * (nudge, then eventually close). v17 also had no answer for the
 * two awkward moments in a real conversation: a backchannel
 * ("ừ", "ok") while the agent is speaking — not an interruption,
 * just a nod — and both sides talking at once.
 *
 * v18 wraps the v17 machine and adds the turn *sense* on top:
 *
 *   1. End-of-turn detection. `feedTranscript(text, final)` runs
 *      the pure detector `detectTurnEndV18()`: a final transcript
 *      that ends on sentence punctuation (or an explicit end
 *      word) after `minTurnChars` is a `semantic` end; a VAD
 *      silence of `endSilenceMs` after speech is a `silence` end;
 *      a long silence with no speech at all is a `timeout` end.
 *      The reason is in the event and the stats, so the panel can
 *      show *why* the agent answered when it did.
 *   2. Backchannel. While the agent is speaking, a short user
 *      utterance (≤ `backchannelMaxChars`, in the backchannel
 *      word list, or a bare acknowledgement) fires `backchannel`
 *      and changes nothing — the agent keeps speaking. Longer
 *      speech while speaking is a real interruption and goes to
 *      the barge-in path instead.
 *   3. Overlap handling. When user speech starts while the agent
 *      is speaking and lasts longer than `overlapMs`, an
 *      `overlap` event fires with the pure yield decision
 *      `decideOverlapV18()`: the agent yields when the user keeps
 *      talking past `agentYieldMs` (the user has the floor), the
 *      user is asked to yield when the agent is mid-sentence and
 *      the overlap is brief, otherwise wait. Yields are counted.
 *   4. Silence timeout with nudges. While listening, silence
 *      longer than `silenceTimeoutMs` fires `silence-timeout` and
 *      a nudge (the machine's listening prompt); after
 *      `maxNudges` nudges with no answer, a `close-suggestion`
 *      fires and, when `autoCloseOnSilence` is set, the machine
 *      disconnects. The user is never left talking to a dead
 *      line, and never ambushed by a sudden hang-up either.
 *
 * Virtual clock, no mic, no sound card. The v17 machine still
 * owns the states and the transitions; v18 decides *when* to ask
 * it to move.
 */

import {
  TurnTakingMachineV17,
  createTurnTakingMachineV17,
  defaultTurnTakingV17Options,
  validateTurnTakingV17Options,
  isTurnTakingV17Live,
  isTurnTakingV17UserTurn,
  isTurnTakingV17ModelSpeaking,
  type TurnTakingV17EventInput,
  type TurnTakingV17MachineEvent,
  type TurnTakingV17Options,
  type TurnTakingV17State,
  type TurnTakingV17Stats,
  type TurnTakingV17Transition,
  type TurnTakingV17TransitionResult,
} from '../voiceV17/turnTakingV17';

/** Why a user turn ended. */
export type TurnEndV18Reason = 'semantic' | 'silence' | 'timeout' | 'backchannel' | 'interrupted';

/** Who should give way when both sides talk at once. */
export type OverlapV18Decision = 'agent-yields' | 'user-yields' | 'wait';

const BACKCHANNEL_WORDS = new Set([
  'ừ', 'ừm', 'ừ ừ', 'ok', 'okay', 'đúng', 'đúng rồi', 'rồi', 'vâng', 'dạ',
  'ừ đúng', 'ừ ha', 'à', 'à à', 'yes', 'yeah', 'uh-huh', 'mm-hmm', 'mhm', 'hmm',
]);

const END_WORDS = ['xong', 'hết rồi', 'thế thôi', 'đấy', 'nhé', 'nha', 'done', 'that is all', 'thats all'];

/**
 * Pure turn-end test for one transcript. A `semantic` end needs a
 * final transcript, a sentence-ending mark (or an end word) and at
 * least `minTurnChars` characters; anything shorter that looks
 * like a nod is a backchannel, not a turn.
 */
export function detectTurnEndV18(
  text: string,
  final: boolean,
  options: TurnTakingV18Options = {},
): { ended: boolean; reason: TurnEndV18Reason | undefined; backchannel: boolean } {
  const merged = { ...defaultTurnTakingV18Options(), ...options };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ended: false, reason: undefined, backchannel: false };
  const lower = trimmed.toLowerCase();
  // An exact backchannel word is a nod whatever follows it — but
  // the length test must come *after* the semantic test below:
  // end words ('xong', 'nhé', 'done', …) are all short, and
  // testing length first swallowed every one of them into
  // backchannel, leaving the END_WORDS list dead.
  if (BACKCHANNEL_WORDS.has(lower)) {
    return { ended: false, reason: undefined, backchannel: true };
  }
  if (!final) return { ended: false, reason: undefined, backchannel: false };
  if (trimmed.length < merged.minTurnChars) return { ended: false, reason: undefined, backchannel: false };
  if (/[.!?…。]$/.test(trimmed)) return { ended: true, reason: 'semantic', backchannel: false };
  for (const word of END_WORDS) {
    if (lower.endsWith(word)) return { ended: true, reason: 'semantic', backchannel: false };
  }
  if (trimmed.length <= merged.backchannelMaxChars) {
    return { ended: false, reason: undefined, backchannel: true };
  }
  return { ended: false, reason: undefined, backchannel: false };
}

/** Pure overlap decision: who gives way, from how long each side has held the floor. */
export function decideOverlapV18(
  overlapMs: number,
  agentSpeakingMs: number,
  userSpeakingMs: number,
  options: TurnTakingV18Options = {},
): OverlapV18Decision {
  const merged = { ...defaultTurnTakingV18Options(), ...options };
  if (overlapMs < merged.overlapMs) return 'wait';
  if (userSpeakingMs >= merged.agentYieldMs) return 'agent-yields';
  if (agentSpeakingMs >= merged.userYieldMs) return 'user-yields';
  return 'wait';
}

export interface TurnTakingV18Options extends TurnTakingV17Options {
  /** Silence after speech before a `silence` turn end (ms, default 800). */
  endSilenceMs?: number;
  /** Min chars for a final transcript to count as a turn (default 3). */
  minTurnChars?: number;
  /** Max chars that still counts as a backchannel (default 12). */
  backchannelMaxChars?: number;
  /** Overlap longer than this fires an `overlap` event (ms, default 300). */
  overlapMs?: number;
  /** User speaking this long wins the floor (ms, default 1200). */
  agentYieldMs?: number;
  /** Agent speaking this long asks the user to yield (ms, default 3000). */
  userYieldMs?: number;
  /** Silence in listening before a nudge (ms, default 15000). */
  silenceTimeoutMs?: number;
  /** Nudges before a close suggestion (default 2). */
  maxNudges?: number;
  /** Auto-disconnect after max nudges with no answer (default false). */
  autoCloseOnSilence?: boolean;
}

export function defaultTurnTakingV18Options(): Required<TurnTakingV18Options> {
  return {
    ...defaultTurnTakingV17Options(),
    endSilenceMs: 800,
    minTurnChars: 3,
    backchannelMaxChars: 12,
    overlapMs: 300,
    agentYieldMs: 1200,
    userYieldMs: 3000,
    silenceTimeoutMs: 15000,
    maxNudges: 2,
    autoCloseOnSilence: false,
  };
}

export function validateTurnTakingV18Options(options: TurnTakingV18Options): string[] {
  const errors = validateTurnTakingV17Options(options);
  const check = (name: keyof TurnTakingV18Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('endSilenceMs', options.endSilenceMs, 100, 10000);
  check('minTurnChars', options.minTurnChars, 1, 200);
  check('backchannelMaxChars', options.backchannelMaxChars, 1, 100);
  check('overlapMs', options.overlapMs, 50, 5000);
  check('agentYieldMs', options.agentYieldMs, 100, 30000);
  check('userYieldMs', options.userYieldMs, 100, 30000);
  check('silenceTimeoutMs', options.silenceTimeoutMs, 1000, 300000);
  check('maxNudges', options.maxNudges, 0, 10);
  return errors;
}

export type TurnTakingV18EventKind =
  | 'turn-state'
  | 'turn-state-rejected'
  | 'turn-timeout'
  | 'turn-prompt'
  | 'turn-recovered'
  | 'turn-ended'
  | 'backchannel'
  | 'overlap'
  | 'yield'
  | 'silence-timeout'
  | 'close-suggestion';

export interface TurnTakingV18Event {
  kind: TurnTakingV18EventKind;
  atMs: number;
  state?: TurnTakingV17State;
  transition?: TurnTakingV17Transition;
  reason?: string;
  turnEndReason?: TurnEndV18Reason;
  text?: string;
  overlapMs?: number;
  decision?: OverlapV18Decision;
  nudges?: number;
}

export type TurnTakingV18EventSink = (event: TurnTakingV18Event) => void;

export interface TurnTakingV18Stats extends TurnTakingV17Stats {
  turnEnds: Partial<Record<TurnEndV18Reason, number>>;
  backchannels: number;
  overlaps: number;
  yields: Partial<Record<OverlapV18Decision, number>>;
  silenceTimeouts: number;
  nudges: number;
  closeSuggestions: number;
}

/**
 * The v17 state machine underneath, turn-end / backchannel /
 * overlap / silence-nudge sensing on top. All times are the
 * caller's virtual clock (ms).
 */
export class TurnTakingMachineV18 {
  readonly machine: TurnTakingMachineV17;
  private readonly options: Required<TurnTakingV18Options>;
  private readonly sink: TurnTakingV18EventSink | undefined;
  private nowMs = 0;
  private lastUserSpeechAtMs = -1;
  private userSpeechSinceMs = 0;
  private agentSpeechSinceMs = 0;
  private overlapSinceMs = 0;
  private overlapFired = false;
  private silenceSinceMs = 0;
  private nudges = 0;
  private readonly turnEnds: Partial<Record<TurnEndV18Reason, number>> = {};
  private backchannels = 0;
  private overlaps = 0;
  private readonly yields: Partial<Record<OverlapV18Decision, number>> = {};
  private silenceTimeouts = 0;
  private closeSuggestions = 0;

  constructor(options: TurnTakingV18Options = {}, sink?: TurnTakingV18EventSink) {
    const merged = { ...defaultTurnTakingV18Options(), ...options };
    const errors = validateTurnTakingV18Options(merged);
    if (errors.length > 0) throw new Error(`invalid turn-taking v18 options: ${errors.join('; ')}`);
    this.options = merged;
    this.sink = sink;
    this.machine = new TurnTakingMachineV17(merged, (event: TurnTakingV17MachineEvent) => {
      this.sink?.({
        kind: event.kind,
        atMs: this.nowMs,
        state: 'state' in event ? event.state : this.machine.getState(),
        transition: 'transition' in event ? event.transition : undefined,
        reason: 'reason' in event ? event.reason : undefined,
      });
    });
  }

  getState(): TurnTakingV17State {
    return this.machine.getState();
  }

  now(): number {
    return this.nowMs;
  }

  isLive(): boolean {
    return isTurnTakingV17Live(this.getState());
  }

  isUserTurn(): boolean {
    return isTurnTakingV17UserTurn(this.getState());
  }

  isModelSpeaking(): boolean {
    return isTurnTakingV17ModelSpeaking(this.getState());
  }

  connect(atMs = 0): TurnTakingV17TransitionResult {
    this.nowMs = atMs;
    this.silenceSinceMs = atMs;
    return this.machine.handle({ kind: 'connect', atMs });
  }

  disconnect(atMs?: number): TurnTakingV17TransitionResult {
    if (atMs !== undefined) this.nowMs = atMs;
    return this.machine.handle({ kind: 'disconnect', atMs: this.nowMs });
  }

  /** User started speaking (VAD speech-start). */
  userSpeechStart(atMs: number): void {
    this.nowMs = atMs;
    this.userSpeechSinceMs = atMs;
    this.lastUserSpeechAtMs = atMs;
    this.silenceSinceMs = 0;
    if (this.getState() === 'speaking') {
      this.overlapSinceMs = atMs;
      this.overlapFired = false;
    }
    this.machine.handle({ kind: 'vad-speech-start', atMs });
  }

  /**
   * User stopped speaking (VAD speech-end). Only the silence is
   * recorded here — the machine stays in `listening` until `tick`
   * fires the `silence` turn end after `endSilenceMs` of quiet.
   * Forwarding `vad-speech-end` at once would move the machine to
   * `thinking` immediately and the silence window in `tick` could
   * never fire (and after `agentReplyDone` it would fire a bogus
   * turn end for speech that never happened).
   */
  userSpeechEnd(atMs: number): void {
    this.nowMs = atMs;
    this.silenceSinceMs = atMs;
    this.overlapSinceMs = 0;
  }

  /** Agent started a reply. */
  agentReplyStart(atMs: number): void {
    this.nowMs = atMs;
    this.agentSpeechSinceMs = atMs;
    this.machine.handle({ kind: 'reply-start', atMs });
  }

  /** Agent finished a reply. */
  agentReplyDone(atMs: number): void {
    this.nowMs = atMs;
    this.agentSpeechSinceMs = 0;
    this.silenceSinceMs = atMs;
    // No user speech since the reply: the `silence` turn end in
    // tick() must not fire for speech that never happened.
    this.lastUserSpeechAtMs = -1;
    this.machine.handle({ kind: 'reply-done', atMs });
  }

  /** The user cut in: hand the floor to the interruption path. */
  bargeIn(atMs: number): TurnTakingV17TransitionResult {
    this.nowMs = atMs;
    this.recordTurnEnd('interrupted', atMs);
    return this.machine.handle({ kind: 'barge-in', atMs });
  }

  /**
   * Feed a transcript (partial or final). A backchannel while the
   * agent speaks changes nothing; a semantic end moves the machine
   * to thinking; anything else is noted and left alone.
   */
  feedTranscript(text: string, final: boolean, atMs: number): { ended: boolean; reason: TurnEndV18Reason | undefined; backchannel: boolean } {
    this.nowMs = atMs;
    const verdict = detectTurnEndV18(text, final, this.options);
    if (verdict.backchannel) {
      this.backchannels += 1;
      this.sink?.({ kind: 'backchannel', atMs, state: this.getState(), text: text.trim() });
      return verdict;
    }
    if (verdict.ended && verdict.reason) {
      this.recordTurnEnd(verdict.reason, atMs, text.trim());
      this.machine.handle({ kind: 'vad-speech-end', atMs });
    }
    return verdict;
  }

  /**
   * Advance the virtual clock: silence ends (after `endSilenceMs`
   * of quiet following speech), overlap decisions, and listening
   * silence timeouts with nudges all fire here.
   */
  tick(atMs: number): void {
    this.nowMs = atMs;
    const state = this.getState();
    // Overlap: user speaking over the agent.
    if (state === 'speaking' && this.overlapSinceMs > 0 && !this.overlapFired) {
      const overlapMs = atMs - this.overlapSinceMs;
      if (overlapMs >= this.options.overlapMs) {
        this.overlapFired = true;
        this.overlaps += 1;
        const decision = decideOverlapV18(
          overlapMs,
          atMs - this.agentSpeechSinceMs,
          atMs - this.userSpeechSinceMs,
          this.options,
        );
        this.yields[decision] = (this.yields[decision] ?? 0) + 1;
        this.sink?.({ kind: 'overlap', atMs, state, overlapMs, decision });
        if (decision !== 'wait') {
          this.sink?.({ kind: 'yield', atMs, state, overlapMs, decision });
        }
      }
    }
    // Silence end of turn: speech ended, quiet long enough.
    if (
      state === 'listening' &&
      this.silenceSinceMs > 0 &&
      this.lastUserSpeechAtMs >= 0 &&
      atMs - this.silenceSinceMs >= this.options.endSilenceMs
    ) {
      this.recordTurnEnd('silence', atMs);
      this.silenceSinceMs = 0;
      this.lastUserSpeechAtMs = -1;
      this.machine.handle({ kind: 'vad-speech-end', atMs });
      return;
    }
    // Listening silence timeout: nudge, then suggest closing.
    if (state === 'listening' && this.silenceSinceMs > 0) {
      const silentMs = atMs - this.silenceSinceMs;
      if (silentMs >= this.options.silenceTimeoutMs) {
        this.silenceTimeouts += 1;
        this.nudges += 1;
        this.silenceSinceMs = atMs;
        this.sink?.({ kind: 'silence-timeout', atMs, state, nudges: this.nudges, reason: `silent for ${silentMs} ms while listening` });
        this.machine.tick(atMs);
        if (this.nudges > this.options.maxNudges) {
          this.closeSuggestions += 1;
          this.sink?.({ kind: 'close-suggestion', atMs, state, nudges: this.nudges, reason: `${this.nudges} nudges with no answer` });
          if (this.options.autoCloseOnSilence) this.machine.handle({ kind: 'disconnect', atMs });
        }
        return;
      }
    }
    this.machine.tick(atMs);
  }

  handle(event: TurnTakingV17EventInput): TurnTakingV17TransitionResult {
    return this.machine.handle(event);
  }

  reset(reason = 'reset', atMs?: number): TurnTakingV17TransitionResult {
    if (atMs !== undefined) this.nowMs = atMs;
    this.nudges = 0;
    this.overlapSinceMs = 0;
    this.silenceSinceMs = 0;
    this.lastUserSpeechAtMs = -1;
    return this.machine.reset(reason, this.nowMs);
  }

  stats(): TurnTakingV18Stats {
    const base = this.machine.getStats();
    return {
      ...base,
      turnEnds: { ...this.turnEnds },
      backchannels: this.backchannels,
      overlaps: this.overlaps,
      yields: { ...this.yields },
      silenceTimeouts: this.silenceTimeouts,
      nudges: this.nudges,
      closeSuggestions: this.closeSuggestions,
    };
  }

  summary(): string {
    const s = this.stats();
    const ends = Object.entries(s.turnEnds).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    return `turn-taking v18: state=${s.state}, ${s.transitions} transitions, turns completed ${s.turnsCompleted}, ` +
      `turn ends (${ends}), ${s.backchannels} backchannels, ${s.overlaps} overlaps, ` +
      `${s.silenceTimeouts} silence timeouts (${s.nudges} nudges, ${s.closeSuggestions} close suggestions)`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Turn-taking v18',
      '',
      `- State: ${s.state} (${s.msInState} ms in state); transitions: ${s.transitions}; rejected: ${s.rejected}; recoveries: ${s.recoveries}`,
      `- Turns completed: ${s.turnsCompleted}; sentences spoken: ${s.sentencesSpoken}`,
      `- Turn ends: ${Object.entries(s.turnEnds).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
      `- Backchannels: ${s.backchannels}; overlaps: ${s.overlaps}; yields: ${Object.entries(s.yields).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
      `- Silence timeouts: ${s.silenceTimeouts}; nudges: ${s.nudges}; close suggestions: ${s.closeSuggestions}`,
      '',
    ];
    return lines.join('\n');
  }

  private recordTurnEnd(reason: TurnEndV18Reason, atMs: number, text?: string): void {
    this.turnEnds[reason] = (this.turnEnds[reason] ?? 0) + 1;
    this.sink?.({ kind: 'turn-ended', atMs, state: this.getState(), turnEndReason: reason, text });
  }
}

export function createTurnTakingMachineV18(
  options?: TurnTakingV18Options,
  sink?: TurnTakingV18EventSink,
): TurnTakingMachineV18 {
  return new TurnTakingMachineV18(options, sink);
}

export function turnTakingV18Summary(machine: TurnTakingMachineV18): string {
  return machine.summary();
}

export function turnTakingV18Markdown(machine: TurnTakingMachineV18): string {
  return machine.markdown();
}
