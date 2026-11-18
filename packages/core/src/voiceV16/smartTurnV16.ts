/**
 * Semantic turn-taking v4 (v1.17, Đội T5 — voice v16).
 *
 * v15 scored *how complete* a sentence sounds (vi + en rules:
 * trailing conjunctions, open vs closed questions, fillers,
 * backchannels, final markers) and held or released the turn.
 * v16 decides *when the agent may speak* — a different question,
 * because a complete sentence is not always a finished turn and
 * an incomplete one is not always worth waiting for:
 *
 *   - Semantic completeness (v15 score, reused as the core) +
 *     a silence gap: the agent speaks only when the sentence is
 *     complete *and* the user has been quiet for the required
 *     gap. A complete sentence with no silence yet is a *hold*,
 *     not an end — the user may be catching their breath.
 *   - Never cut a sentence mid-thought: a trailing conjunction,
 *     an open question, a list in progress ("thứ nhất…", "first…")
 *     or high filler density all *extend* the silence gap the
 *     detector waits for, so the user gets their full chance to
 *     continue. They are not a veto: once the user has been quiet
 *     for the whole extended gap, the turn ends — holding an open
 *     question forever would never let the agent speak. A sentence
 *     that is still semantically incomplete (low score, no final
 *     marker) keeps holding until the timeout. The hold *reason*
 *     is reported, so the session can show why it is waiting
 *     instead of looking stuck.
 *   - Maximum wait timeout (`maxWaitMs`): the user cannot hold
 *     the floor forever. When the timeout fires the detector ends
 *     the turn with reason `timeout` (or, if the sentence is
 *     still clearly incomplete, emits a `prompt` event — the
 *     session may nudge with "bạn còn muốn nói thêm không?" —
 *     and waits one more bounded window before ending).
 *   - Speech rate + history: a fast speaker gets a longer gap
 *     (they pause between clauses, not between turns); when the
 *     agent's last turn was a question, the detector waits
 *     longer for the answer (`questionWaitBoostMs`); a lone
 *     backchannel ("ừ", "yeah") ends immediately — there is
 *     nothing more coming.
 *   - State machine: `idle → listening → holding → ended`, plus
 *     `timed-out` and `prompted`. Every transition is an event
 *     with the text, the score and the reason, so the session can
 *     prove *why* it spoke when it did.
 *
 * Pure text + numbers on a virtual clock; the v15 scorer still
 * owns the language rules. No mic, no model.
 */

import { scoreTurnCompletenessV15, detectSmartTurnLanguageV15 } from '../voiceV15/smartTurnV15';
import type { SmartTurnV15Options, SmartTurnV15Score } from '../voiceV15/smartTurnV15';

export type SmartTurnV16State = 'idle' | 'listening' | 'holding' | 'ended' | 'timed-out' | 'prompted';
export type SmartTurnV16Decision = 'end' | 'hold' | 'prompt' | 'wait';
export type SmartTurnV16HoldReason =
  | 'trailing-conjunction'
  | 'open-question'
  | 'list-in-progress'
  | 'thinking-pause'
  | 'incomplete-sentence'
  | 'no-silence-yet'
  | 'awaiting-answer';

export interface SmartTurnV16Options extends SmartTurnV15Options {
  /** Max ms to wait for the user to continue before forcing a decision (default 8000). */
  maxWaitMs?: number;
  /** Extra ms waited after a prompt before ending anyway (default 4000). */
  promptWaitMs?: number;
  /** Silence (ms) that counts as a gap for a complete sentence (default 450). */
  silenceGapMs?: number;
  /** Extra wait when the agent's last turn was a question (default 1200). */
  questionWaitBoostMs?: number;
  /** Words/sec above this counts as a fast speaker (default 3.5). */
  fastSpeechRateWps?: number;
  /** Extra gap (ms) for a fast speaker (default 300). */
  fastSpeakerExtraMs?: number;
  /** Minimum turn length (ms) before the speech-rate signal counts (default 2000). */
  fastSpeakerMinSampleMs?: number;
}

export function defaultSmartTurnV16Options(): Required<SmartTurnV16Options> {
  return {
    language: 'auto',
    sensitivity: 'balanced',
    endThreshold: 0.6,
    floorThreshold: 0.3,
    baseSilenceMs: 450,
    openQuestionExtraMs: 500,
    thinkingExtraMs: 600,
    maxWaitMs: 8000,
    promptWaitMs: 4000,
    silenceGapMs: 450,
    questionWaitBoostMs: 1200,
    fastSpeechRateWps: 3.5,
    fastSpeakerExtraMs: 300,
    fastSpeakerMinSampleMs: 2000,
  };
}

export function validateSmartTurnV16Options(options: SmartTurnV16Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof SmartTurnV16Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('maxWaitMs', options.maxWaitMs, 1000, 60000);
  check('promptWaitMs', options.promptWaitMs, 500, 30000);
  check('silenceGapMs', options.silenceGapMs, 50, 5000);
  check('questionWaitBoostMs', options.questionWaitBoostMs, 0, 10000);
  check('fastSpeechRateWps', options.fastSpeechRateWps, 0.5, 20);
  check('fastSpeakerExtraMs', options.fastSpeakerExtraMs, 0, 5000);
  check('fastSpeakerMinSampleMs', options.fastSpeakerMinSampleMs, 0, 30000);
  if (options.endThreshold !== undefined && options.floorThreshold !== undefined && options.floorThreshold >= options.endThreshold) {
    errors.push('floorThreshold must be smaller than endThreshold');
  }
  return errors;
}

const SMART_TURN_V16_VI_LIST_MARKERS = ['thứ nhất', 'thứ hai', 'thứ ba', 'đầu tiên', 'tiếp theo là', 'một là', 'hai là'];
const SMART_TURN_V16_EN_LIST_MARKERS = ['first', 'second', 'third', 'firstly', 'secondly', 'one is', 'another is'];

/** Words per second over the words heard so far in this turn. */
export function speechRateWpsV16(wordCount: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || wordCount === 0) return 0;
  return wordCount / (elapsedMs / 1000);
}

/** True when the text looks like a list whose items are still coming. */
export function isListInProgressV16(text: string): boolean {
  const lower = text.toLowerCase();
  const markers = [...SMART_TURN_V16_VI_LIST_MARKERS, ...SMART_TURN_V16_EN_LIST_MARKERS];
  const hits = markers.filter((m) => lower.includes(m)).length;
  if (hits === 0) return false;
  // A list with only its first item named and no closing marker.
  const closers = ['hết rồi', 'thế thôi', 'that is all', "that's all", 'finally', 'cuối cùng'];
  return !closers.some((c) => lower.includes(c));
}

export interface SmartTurnV16DecisionInput {
  text: string;
  silenceMs: number;
  elapsedMs: number;
  /** True when the agent's previous turn asked the user a question. */
  awaitingAnswer?: boolean;
  /** True when the detector already prompted once this turn. */
  prompted?: boolean;
}

export interface SmartTurnV16DecisionOutput {
  decision: SmartTurnV16Decision;
  score: SmartTurnV15Score;
  requiredSilenceMs: number;
  holdReasons: SmartTurnV16HoldReason[];
  /** ms until the max-wait timeout fires (0 when already past). */
  msUntilTimeout: number;
  speechRateWps: number;
}

/**
 * Pure decision: semantic score + silence + timeout + history.
 * The detector below is this function plus a state machine.
 */
export function decideSmartTurnV16(
  input: SmartTurnV16DecisionInput,
  options: SmartTurnV16Options = {},
): SmartTurnV16DecisionOutput {
  const opts = { ...defaultSmartTurnV16Options(), ...options };
  const score = scoreTurnCompletenessV15(input.text, opts);
  const words = input.text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  const rate = speechRateWpsV16(words, input.elapsedMs);
  const holdReasons: SmartTurnV16HoldReason[] = [];
  let requiredSilence = opts.silenceGapMs;
  if (score.signals.trailingConjunction) holdReasons.push('trailing-conjunction');
  if (score.signals.isOpenQuestion) {
    holdReasons.push('open-question');
    requiredSilence += opts.openQuestionExtraMs;
  }
  if (isListInProgressV16(input.text)) holdReasons.push('list-in-progress');
  if (score.signals.fillerDensity > 0.3) {
    holdReasons.push('thinking-pause');
    requiredSilence += opts.thinkingExtraMs;
  }
  if (input.awaitingAnswer) {
    holdReasons.push('awaiting-answer');
    requiredSilence += opts.questionWaitBoostMs;
  }
  if (rate >= opts.fastSpeechRateWps && input.elapsedMs >= opts.fastSpeakerMinSampleMs) {
    // Only trust the rate once the turn is long enough to measure:
    // a whole sentence arriving in one partial would otherwise look
    // like impossibly fast speech and demand an endless gap.
    requiredSilence += opts.fastSpeakerExtraMs;
  }
  if (score.score < opts.endThreshold && !score.signals.hasFinalMarker) {
    if (!holdReasons.includes('incomplete-sentence')) holdReasons.push('incomplete-sentence');
  }
  const msUntilTimeout = Math.max(0, opts.maxWaitMs - input.elapsedMs);
  const silenceEnough = input.silenceMs >= requiredSilence;
  const completeEnough = score.score >= opts.endThreshold || score.signals.hasFinalMarker;
  const backchannel = score.signals.backchannel === 'ack' && words <= 3;
  if (backchannel) {
    return { decision: 'end', score, requiredSilenceMs: requiredSilence, holdReasons: [], msUntilTimeout, speechRateWps: rate };
  }
  // A hold reason (open question, trailing conjunction, list in
  // progress) only *extends* the required silence — it is the
  // reason we waited longer, not a veto. Once the user has been
  // quiet for the full (extended) gap, the turn ends: holding an
  // open question forever would never let the agent speak.
  if (completeEnough && silenceEnough) {
    return { decision: 'end', score, requiredSilenceMs: requiredSilence, holdReasons, msUntilTimeout, speechRateWps: rate };
  }
  if (msUntilTimeout <= 0) {
    if (!completeEnough && !input.prompted) {
      return { decision: 'prompt', score, requiredSilenceMs: requiredSilence, holdReasons, msUntilTimeout, speechRateWps: rate };
    }
    return { decision: 'end', score, requiredSilenceMs: requiredSilence, holdReasons, msUntilTimeout, speechRateWps: rate };
  }
  if (completeEnough && !silenceEnough) holdReasons.push('no-silence-yet');
  return { decision: 'hold', score, requiredSilenceMs: requiredSilence, holdReasons, msUntilTimeout, speechRateWps: rate };
}

export type SmartTurnV16EventKind = 'hold' | 'end' | 'prompt' | 'timeout';

export interface SmartTurnV16Event {
  kind: SmartTurnV16EventKind;
  atMs: number;
  text: string;
  decision: SmartTurnV16Decision;
  score: number;
  holdReasons: SmartTurnV16HoldReason[];
  requiredSilenceMs: number;
}

export type SmartTurnV16Sink = (event: SmartTurnV16Event) => void;

export interface SmartTurnV16Stats {
  turns: number;
  ends: number;
  holds: number;
  prompts: number;
  timeouts: number;
  falseEndSaves: number;
  averageWaitMs: number;
  averageScoreAtEnd: number;
  state: SmartTurnV16State;
}

/**
 * Stateful detector: feed partials + silence, get hold/end/prompt
 * events. `tick(ms)` advances the max-wait clock. `noteAgentQuestion()`
 * tells the next turn the agent asked something (longer wait).
 */
export class SmartTurnDetectorV16 {
  private readonly options: Required<SmartTurnV16Options>;
  private readonly sink: SmartTurnV16Sink | undefined;
  private state: SmartTurnV16State = 'idle';
  private text = '';
  private turnStartedAtMs = 0;
  private lastSpeechAtMs = 0;
  private lastDecisionAtMs = 0;
  private awaitingAnswer = false;
  private prompted = false;
  private promptDeadlineMs: number | undefined;
  private turns = 0;
  private ends = 0;
  private holds = 0;
  private prompts = 0;
  private timeouts = 0;
  private falseEndSaves = 0;
  private readonly waitSamples: number[] = [];
  private readonly endScores: number[] = [];

  constructor(options: SmartTurnV16Options = {}, sink?: SmartTurnV16Sink) {
    const merged = { ...defaultSmartTurnV16Options(), ...options };
    const errors = validateSmartTurnV16Options(merged);
    if (errors.length > 0) throw new Error(`invalid smart-turn v16 options: ${errors.join('; ')}`);
    this.options = merged;
    this.sink = sink;
  }

  getState(): SmartTurnV16State {
    return this.state;
  }

  /** The agent just asked the user a question — wait longer next turn. */
  noteAgentQuestion(): void {
    this.awaitingAnswer = true;
  }

  /** Feed an STT partial. Returns the decision made, if any. */
  feedPartial(text: string, atMs: number): SmartTurnV16DecisionOutput | undefined {
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    if (this.state === 'idle' || this.state === 'ended' || this.state === 'timed-out') {
      this.text = '';
      this.turnStartedAtMs = atMs;
      this.turns += 1;
      this.prompted = false;
      this.promptDeadlineMs = undefined;
      this.state = 'listening';
    }
    this.text = trimmed;
    this.lastSpeechAtMs = atMs;
    return this.evaluate(atMs, 0);
  }

  /** Feed silence (ms). Returns the decision made, if any. */
  feedSilence(ms: number, atMs: number): SmartTurnV16DecisionOutput | undefined {
    if (this.state !== 'listening' && this.state !== 'holding' && this.state !== 'prompted') return undefined;
    const silenceMs = atMs - this.lastSpeechAtMs;
    void ms;
    return this.evaluate(atMs, silenceMs);
  }

  /** Advance the clock; fires the max-wait timeout when it lapses. */
  tick(atMs: number): SmartTurnV16DecisionOutput | undefined {
    if (this.state !== 'listening' && this.state !== 'holding' && this.state !== 'prompted') return undefined;
    const elapsed = atMs - this.turnStartedAtMs;
    if (this.state === 'prompted' && this.promptDeadlineMs !== undefined && atMs >= this.promptDeadlineMs) {
      // Prompt window elapsed with no more speech: end by timeout.
      const out = decideSmartTurnV16(
        { text: this.text, silenceMs: atMs - this.lastSpeechAtMs, elapsedMs: atMs - this.turnStartedAtMs, awaitingAnswer: this.awaitingAnswer, prompted: true },
        this.options,
      );
      this.endTurn(atMs, 'timeout', out);
      return out;
    }
    if (elapsed >= this.options.maxWaitMs) {
      const out = this.evaluate(atMs, atMs - this.lastSpeechAtMs);
      return out;
    }
    return undefined;
  }

  /** Force the turn to end now (caller-driven, e.g. explicit final). */
  forceEnd(atMs: number): SmartTurnV16Event {
    return this.endTurn(atMs, 'end');
  }

  reset(): void {
    this.state = 'idle';
    this.text = '';
    this.awaitingAnswer = false;
    this.prompted = false;
    this.promptDeadlineMs = undefined;
  }

  currentText(): string {
    return this.text;
  }

  language(): 'vi' | 'en' {
    return detectSmartTurnLanguageV15(this.text || 'hello');
  }

  stats(): SmartTurnV16Stats {
    return {
      turns: this.turns,
      ends: this.ends,
      holds: this.holds,
      prompts: this.prompts,
      timeouts: this.timeouts,
      falseEndSaves: this.falseEndSaves,
      averageWaitMs: this.waitSamples.length > 0
        ? Math.round(this.waitSamples.reduce((a, b) => a + b, 0) / this.waitSamples.length)
        : 0,
      averageScoreAtEnd: this.endScores.length > 0
        ? Math.round((this.endScores.reduce((a, b) => a + b, 0) / this.endScores.length) * 100) / 100
        : 0,
      state: this.state,
    };
  }

  summary(): string {
    const s = this.stats();
    return `smart turn v16: ${s.turns} turns, ${s.ends} ends (${s.timeouts} by timeout, ${s.prompts} prompted), ` +
      `${s.holds} holds, ${s.falseEndSaves} false-end saves, avg wait ${s.averageWaitMs} ms`;
  }

  markdown(): string {
    const s = this.stats();
    return [
      '## Semantic turn-taking v16',
      '',
      `- Turns: ${s.turns}; ends: ${s.ends} (timeouts ${s.timeouts}, prompts ${s.prompts}); holds: ${s.holds}`,
      `- False-end saves (holds on incomplete sentences): ${s.falseEndSaves}`,
      `- Average wait before end: ${s.averageWaitMs} ms; average completeness at end: ${s.averageScoreAtEnd}`,
      `- State: \`${s.state}\``,
      '',
    ].join('\n');
  }

  private evaluate(atMs: number, silenceMs: number): SmartTurnV16DecisionOutput {
    const elapsed = atMs - this.turnStartedAtMs;
    const out = decideSmartTurnV16(
      { text: this.text, silenceMs, elapsedMs: elapsed, awaitingAnswer: this.awaitingAnswer, prompted: this.prompted },
      this.options,
    );
    this.lastDecisionAtMs = atMs;
    switch (out.decision) {
      case 'end': {
        this.endTurn(atMs, 'end', out);
        break;
      }
      case 'prompt': {
        this.prompts += 1;
        this.prompted = true;
        this.promptDeadlineMs = atMs + this.options.promptWaitMs;
        this.state = 'prompted';
        this.sink?.({ kind: 'prompt', atMs, text: this.text, decision: 'prompt', score: out.score.score, holdReasons: out.holdReasons, requiredSilenceMs: out.requiredSilenceMs });
        break;
      }
      case 'hold': {
        this.holds += 1;
        if (out.holdReasons.includes('trailing-conjunction') || out.holdReasons.includes('open-question') || out.holdReasons.includes('list-in-progress')) {
          this.falseEndSaves += 1;
        }
        this.state = 'holding';
        this.sink?.({ kind: 'hold', atMs, text: this.text, decision: 'hold', score: out.score.score, holdReasons: out.holdReasons, requiredSilenceMs: out.requiredSilenceMs });
        break;
      }
      case 'wait':
        this.state = 'listening';
        break;
    }
    return out;
  }

  private endTurn(atMs: number, kind: 'end' | 'timeout', out?: SmartTurnV16DecisionOutput): SmartTurnV16Event {
    const score = out?.score.score ?? scoreTurnCompletenessV15(this.text, this.options).score;
    this.ends += 1;
    if (kind === 'timeout') this.timeouts += 1;
    this.waitSamples.push(atMs - this.turnStartedAtMs);
    this.endScores.push(score);
    this.state = kind === 'timeout' ? 'timed-out' : 'ended';
    this.awaitingAnswer = false;
    const event: SmartTurnV16Event = {
      kind: kind === 'timeout' ? 'timeout' : 'end',
      atMs,
      text: this.text,
      decision: 'end',
      score,
      holdReasons: out?.holdReasons ?? [],
      requiredSilenceMs: out?.requiredSilenceMs ?? this.options.silenceGapMs,
    };
    this.sink?.(event);
    return event;
  }
}

export function createSmartTurnDetectorV16(options: SmartTurnV16Options = {}, sink?: SmartTurnV16Sink): SmartTurnDetectorV16 {
  return new SmartTurnDetectorV16(options, sink);
}

export function smartTurnV16Summary(detector: SmartTurnDetectorV16): string {
  return detector.summary();
}

export function smartTurnV16Markdown(detector: SmartTurnDetectorV16): string {
  return detector.markdown();
}
