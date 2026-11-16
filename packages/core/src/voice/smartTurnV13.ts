/**
 * Smart-Turn-style end-of-turn v13 (v1.14, Đội T5 — voice
 * realtime v13).
 *
 * v12's end-of-turn detector watches the clock: a turn ends
 * when trailing silence lasts `trailingSilenceMs` after enough
 * speech. That mistakes a thinking pause for a finished turn
 * ("Tôi muốn đặt lịch… [pause] …vào thứ sáu") and waits out the
 * full silence on a turn that is obviously done ("Mấy giờ họp?").
 * v13 reads the *words* as well as the silence — the Smart Turn
 * idea: decide the user has finished from the content of what
 * they said, not only from how long they have been quiet.
 *
 * Signals (each weighted, all configurable):
 * - terminal punctuation (`?` / `.` / `!`) — the turn is
 *   grammatically closed;
 * - question shape — starts with a question word (`mấy`, `ai`,
 *   `sao`, `what`, `when`, …) or ends with `?` / `không` / `à`;
 * - trailing conjunction / preposition (`và`, `nhưng`, `thì`,
 *   `là`, `của`, `để`, `and`, `so`, …) — the sentence is
 *   mid-thought, the turn is NOT over;
 * - filler-only burst (`ừ`, `vâng`, `uh`, `hmm`) — a
 *   backchannel, not a turn;
 * - incomplete shape — ends mid-phrase, no verb, very short;
 * - silence: trailing silence still matters, but a complete
 *   turn needs less of it than an incomplete one.
 *
 * `scoreTurnCompletenessV13` is pure (text in, score + signals
 * out); `SmartTurnDetectorV13` drives it on the virtual clock,
 * combining the semantic score with VAD silence. A decision
 * carries its confidence and the signals behind it, so the
 * panel can show *why* the turn ended.
 *
 * No audio device, no network, no model: the scoring is a
 * deterministic heuristic over the partial transcript. A real
 * trained turn model can replace `scoreTurnCompletenessV13`
 * behind the same `decide` shape later.
 */

/** One scored signal behind a completeness score. */
export interface SmartTurnV13Signal {
  name: string;
  /** Weight contribution (-1..1). */
  weight: number;
  /** Human-readable note (Vietnamese/English mix, for the panel). */
  detail: string;
}

/** Result of scoring one (partial) user utterance. */
export interface SmartTurnV13Score {
  /** Completeness 0..1 (1 = clearly finished). */
  score: number;
  /** True when the text alone says the turn is finished. */
  complete: boolean;
  signals: SmartTurnV13Signal[];
  /** Normalised text that was scored. */
  text: string;
}

/** Options for the scorer and the detector. */
export interface SmartTurnV13Options {
  /** Score at/above this ends the turn on content alone (default 0.6). */
  completenessThreshold?: number;
  /** Score below this is treated as mid-thought even with silence (default 0.3). */
  incompleteThreshold?: number;
  /** Trailing silence (ms) needed when the text scores complete (default 300). */
  silenceCompleteMs?: number;
  /** Trailing silence (ms) needed when the text is undecided (default 700). */
  silenceUndecidedMs?: number;
  /** Trailing silence (ms) needed when the text scores incomplete (default 1500). */
  silenceIncompleteMs?: number;
  /** Minimum speech (ms) before any end-of-turn decision (default 300). */
  minSpeechMs?: number;
  /** Max turn (ms) before a forced end (default 30000). */
  maxTurnMs?: number;
  /** Weight of the terminal-punctuation signal (default 0.35). */
  terminalWeight?: number;
  /** Weight of the question-shape signal (default 0.25). */
  questionWeight?: number;
  /** Weight of the trailing-conjunction penalty (default -0.5). */
  trailingConjunctionWeight?: number;
  /** Weight of the filler-only penalty (default -0.4). */
  fillerWeight?: number;
}

/** A decision: is the user turn over? */
export interface SmartTurnV13Decision {
  ended: boolean;
  /** Confidence 0..1 in the decision. */
  confidence: number;
  /** Why (machine-readable). */
  reason:
    | 'complete-with-silence'
    | 'complete-immediate'
    | 'undecided-silence'
    | 'incomplete-silence'
    | 'turn-timeout'
    | 'not-yet'
    | 'backchannel';
  /** The semantic score behind the decision. */
  score: SmartTurnV13Score;
  /** Trailing silence observed (ms). */
  silenceMs: number;
  /** Speech observed in this turn (ms). */
  speechMs: number;
  atMs: number;
}

/** Counters for one detector. */
export interface SmartTurnV13Stats {
  turns: number;
  endedByContent: number;
  endedBySilence: number;
  endedByTimeout: number;
  backchannels: number;
  decisions: number;
  /** Mean completeness score of ended turns (0 when none). */
  meanScore: number;
  /** Mean confidence of ended turns (0 when none). */
  meanConfidence: number;
}

/** Events emitted by the detector. */
export type SmartTurnV13Event =
  | { kind: 'decision'; decision: SmartTurnV13Decision }
  | { kind: 'turn-ended'; decision: SmartTurnV13Decision }
  | { kind: 'backchannel'; atMs: number; text: string };

export type SmartTurnV13EventSink = (event: SmartTurnV13Event) => void;

/** Question words (Vietnamese + English) that open a question turn. */
export const SMART_TURN_V13_QUESTION_WORDS = new Set([
  'mấy', 'ai', 'gì', 'sao', 'tại', 'khi', 'nào', 'đâu', 'bao', 'có',
  'what', 'when', 'where', 'who', 'why', 'how', 'which', 'is', 'are', 'can', 'could', 'do', 'does',
]);

/** Words that leave a sentence mid-thought when they end it. */
export const SMART_TURN_V13_TRAILING_WORDS = new Set([
  'và', 'nhưng', 'mà', 'thì', 'là', 'của', 'để', 'với', 'cho', 'rồi', 'nên', 'nếu', 'khi', 'vì',
  'and', 'but', 'so', 'then', 'that', 'with', 'for', 'to', 'of', 'the', 'a', 'is', 'are',
]);

/** Filler / backchannel words: the user is reacting, not taking a turn. */
export const SMART_TURN_V13_FILLERS = new Set([
  'ừ', 'ừm', 'vâng', 'dạ', 'à', 'ờ', 'uh', 'um', 'hmm', 'yeah', 'ok', 'okay', 'ừm ừm',
]);

/** Words that close a yes/no question in Vietnamese. */
export const SMART_TURN_V13_QUESTION_ENDINGS = new Set(['không', 'à', 'hả', 'nhỉ', 'chưa', 'đúng']);

export function defaultSmartTurnV13Options(): Required<SmartTurnV13Options> {
  return {
    completenessThreshold: 0.6,
    incompleteThreshold: 0.3,
    silenceCompleteMs: 300,
    silenceUndecidedMs: 700,
    silenceIncompleteMs: 1500,
    minSpeechMs: 300,
    maxTurnMs: 30000,
    terminalWeight: 0.35,
    questionWeight: 0.25,
    trailingConjunctionWeight: -0.5,
    fillerWeight: -0.4,
  };
}

export function validateSmartTurnV13Options(options: SmartTurnV13Options): Required<SmartTurnV13Options> {
  const base = defaultSmartTurnV13Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Smart Turn v13 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  const completenessThreshold = num(options.completenessThreshold, base.completenessThreshold, 'completenessThreshold', 0, 1);
  const incompleteThreshold = num(options.incompleteThreshold, base.incompleteThreshold, 'incompleteThreshold', 0, 1);
  if (incompleteThreshold > completenessThreshold) {
    throw new Error(`Smart Turn v13 incompleteThreshold (${incompleteThreshold}) must be <= completenessThreshold (${completenessThreshold}).`);
  }
  return {
    completenessThreshold,
    incompleteThreshold,
    silenceCompleteMs: Math.floor(num(options.silenceCompleteMs, base.silenceCompleteMs, 'silenceCompleteMs', 0, 60000)),
    silenceUndecidedMs: Math.floor(num(options.silenceUndecidedMs, base.silenceUndecidedMs, 'silenceUndecidedMs', 0, 60000)),
    silenceIncompleteMs: Math.floor(num(options.silenceIncompleteMs, base.silenceIncompleteMs, 'silenceIncompleteMs', 0, 60000)),
    minSpeechMs: Math.floor(num(options.minSpeechMs, base.minSpeechMs, 'minSpeechMs', 0, 60000)),
    maxTurnMs: Math.floor(num(options.maxTurnMs, base.maxTurnMs, 'maxTurnMs', 1000, 600000)),
    terminalWeight: num(options.terminalWeight, base.terminalWeight, 'terminalWeight', 0, 1),
    questionWeight: num(options.questionWeight, base.questionWeight, 'questionWeight', 0, 1),
    trailingConjunctionWeight: num(options.trailingConjunctionWeight, base.trailingConjunctionWeight, 'trailingConjunctionWeight', -1, 0),
    fillerWeight: num(options.fillerWeight, base.fillerWeight, 'fillerWeight', -1, 0),
  };
}

function normaliseTextV13(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function lastWordOf(text: string): string {
  const words = text.split(' ').filter((w) => w.length > 0);
  return (words[words.length - 1] ?? '').toLowerCase().replace(/[?!.,…]+$/, '');
}

function firstWordOf(text: string): string {
  const words = text.split(' ').filter((w) => w.length > 0);
  return (words[0] ?? '').toLowerCase().replace(/[?!.,…]+$/, '');
}

/**
 * Score one (partial) utterance for turn completeness. Pure —
 * the detector and the tests share it. The score starts at a
 * 0.4 prior (a multi-word utterance is more likely finished
 * than not) and the signals move it.
 */
export function scoreTurnCompletenessV13(text: string, options: SmartTurnV13Options = {}): SmartTurnV13Score {
  const opts = validateSmartTurnV13Options(options);
  const clean = normaliseTextV13(text);
  const signals: SmartTurnV13Signal[] = [];
  if (!clean) {
    return { score: 0, complete: false, signals: [{ name: 'empty', weight: -0.4, detail: 'no text yet' }], text: clean };
  }
  const words = clean.split(' ').filter((w) => w.length > 0);
  const last = lastWordOf(clean);
  const first = firstWordOf(clean);
  let score = 0.4;
  // Filler-only burst: a backchannel, not a turn.
  if (words.length <= 2 && words.every((w) => SMART_TURN_V13_FILLERS.has(w.toLowerCase().replace(/[?!.,…]+$/, '')))) {
    signals.push({ name: 'filler-only', weight: opts.fillerWeight, detail: `"${clean}" is a backchannel, not a turn` });
    score += opts.fillerWeight;
  }
  // Terminal punctuation closes the turn.
  if (/[.!?…]\s*$/.test(clean)) {
    signals.push({ name: 'terminal-punct', weight: opts.terminalWeight, detail: `ends with "${clean.slice(-1)}"` });
    score += opts.terminalWeight;
  }
  // Question shape: question word first, or a yes/no ending.
  if (SMART_TURN_V13_QUESTION_WORDS.has(first) || SMART_TURN_V13_QUESTION_ENDINGS.has(last)) {
    signals.push({ name: 'question-shape', weight: opts.questionWeight, detail: `question shape ("${first}" / "…${last}")` });
    score += opts.questionWeight;
  }
  // Trailing conjunction / preposition: mid-thought.
  if (SMART_TURN_V13_TRAILING_WORDS.has(last)) {
    signals.push({ name: 'trailing-conjunction', weight: opts.trailingConjunctionWeight, detail: `ends mid-thought on "${last}"` });
    score += opts.trailingConjunctionWeight;
  }
  // Very short, no verb-like length: probably a false start.
  if (words.length === 1 && !/[.!?…]\s*$/.test(clean)) {
    signals.push({ name: 'single-word', weight: -0.15, detail: 'single word without terminator' });
    score -= 0.15;
  }
  // A longer utterance with no trailing word is more likely complete.
  if (words.length >= 6 && !SMART_TURN_V13_TRAILING_WORDS.has(last)) {
    signals.push({ name: 'long-utterance', weight: 0.1, detail: `${words.length} words, no trailing conjunction` });
    score += 0.1;
  }
  const clamped = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  return { score: clamped, complete: clamped >= opts.completenessThreshold, signals, text: clean };
}

/**
 * Smart Turn detector: combines the semantic score with VAD
 * silence on one virtual clock. Feed partial transcripts as
 * they arrive (`notePartialText`) and silence observations
 * (`noteSilence` / `noteSpeech`); call `decide(atMs)` whenever
 * the caller wants a verdict (typically on every VAD event).
 * A decision that ends the turn resets the detector for the
 * next turn.
 */
export class SmartTurnDetectorV13 {
  private readonly options: Required<SmartTurnV13Options>;
  private readonly sink: SmartTurnV13EventSink | null;
  private text = '';
  private turnStartedAtMs: number | null = null;
  private speechMs = 0;
  private silenceMs = 0;
  private turns = 0;
  private endedByContent = 0;
  private endedBySilence = 0;
  private endedByTimeout = 0;
  private backchannels = 0;
  private decisions = 0;
  private endedScores: number[] = [];
  private endedConfidences: number[] = [];

  constructor(options: SmartTurnV13Options = {}, sink: SmartTurnV13EventSink | null = null) {
    this.options = validateSmartTurnV13Options(options);
    this.sink = sink;
  }

  getOptions(): Required<SmartTurnV13Options> {
    return { ...this.options };
  }

  /** Current partial transcript for this turn. */
  getText(): string {
    return this.text;
  }

  getSpeechMs(): number {
    return this.speechMs;
  }

  getSilenceMs(): number {
    return this.silenceMs;
  }

  /**
   * Feed a partial transcript (the host's STT output). Replaces
   * the turn text — callers pass the full partial text each
   * time, not deltas.
   */
  notePartialText(text: string, atMs: number): void {
    if (this.turnStartedAtMs === null) this.turnStartedAtMs = atMs;
    this.text = normaliseTextV13(text);
    this.silenceMs = 0;
  }

  /** Note `ms` of speech in this turn (from the VAD). */
  noteSpeech(ms: number, atMs: number): void {
    if (this.turnStartedAtMs === null) this.turnStartedAtMs = atMs;
    if (ms > 0) this.speechMs += ms;
    this.silenceMs = 0;
  }

  /** Note `ms` of trailing silence after speech. */
  noteSilence(ms: number): void {
    if (ms > 0) this.silenceMs += ms;
  }

  /**
   * Decide whether the turn is over, right now. Pure verdict
   * except for the counters: an `ended` decision resets the
   * turn state (text, speech, silence) for the next turn.
   */
  decide(atMs: number): SmartTurnV13Decision {
    this.decisions += 1;
    const score = scoreTurnCompletenessV13(this.text, this.options);
    const speechMs = this.speechMs;
    const silenceMs = this.silenceMs;
    const turnAgeMs = this.turnStartedAtMs === null ? 0 : atMs - this.turnStartedAtMs;
    const base: Omit<SmartTurnV13Decision, 'ended' | 'confidence' | 'reason'> = { score, silenceMs, speechMs, atMs };

    const finish = (ended: boolean, confidence: number, reason: SmartTurnV13Decision['reason']): SmartTurnV13Decision => {
      const decision: SmartTurnV13Decision = { ...base, ended, confidence, reason };
      this.sink?.({ kind: 'decision', decision });
      if (!ended) return decision;
      this.turns += 1;
      this.endedScores.push(score.score);
      this.endedConfidences.push(confidence);
      if (reason === 'turn-timeout') this.endedByTimeout += 1;
      else if (reason === 'complete-immediate' || reason === 'complete-with-silence') this.endedByContent += 1;
      else this.endedBySilence += 1;
      this.sink?.({ kind: 'turn-ended', decision });
      this.text = '';
      this.turnStartedAtMs = null;
      this.speechMs = 0;
      this.silenceMs = 0;
      return decision;
    };

    // Filler-only burst with a little silence: a backchannel, not a turn.
    if (score.signals.some((s) => s.name === 'filler-only') && silenceMs >= 150 && speechMs <= 1200) {
      this.backchannels += 1;
      this.sink?.({ kind: 'backchannel', atMs, text: this.text });
      this.text = '';
      this.turnStartedAtMs = null;
      this.speechMs = 0;
      this.silenceMs = 0;
      return { ...base, ended: false, confidence: 0.8, reason: 'backchannel' };
    }
    if (turnAgeMs >= this.options.maxTurnMs) {
      return finish(true, 0.9, 'turn-timeout');
    }
    if (speechMs < this.options.minSpeechMs) {
      return finish(false, 0.3, 'not-yet');
    }
    if (score.complete && silenceMs >= this.options.silenceCompleteMs) {
      return finish(true, Math.min(0.95, 0.6 + score.score * 0.35), 'complete-with-silence');
    }
    if (score.complete && /[?]\s*$/.test(this.text) && silenceMs >= 100) {
      // A question mark is decisive: even a short pause ends the turn.
      return finish(true, 0.9, 'complete-immediate');
    }
    if (score.score >= this.options.incompleteThreshold && silenceMs >= this.options.silenceUndecidedMs) {
      return finish(true, 0.5 + score.score * 0.3, 'undecided-silence');
    }
    if (score.score < this.options.incompleteThreshold && silenceMs >= this.options.silenceIncompleteMs) {
      return finish(true, 0.5, 'incomplete-silence');
    }
    return finish(false, 0.4, 'not-yet');
  }

  getStats(): SmartTurnV13Stats {
    const mean = (xs: number[]): number => (xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100);
    return {
      turns: this.turns,
      endedByContent: this.endedByContent,
      endedBySilence: this.endedBySilence,
      endedByTimeout: this.endedByTimeout,
      backchannels: this.backchannels,
      decisions: this.decisions,
      meanScore: mean(this.endedScores),
      meanConfidence: mean(this.endedConfidences),
    };
  }

  reset(): void {
    this.text = '';
    this.turnStartedAtMs = null;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.turns = 0;
    this.endedByContent = 0;
    this.endedBySilence = 0;
    this.endedByTimeout = 0;
    this.backchannels = 0;
    this.decisions = 0;
    this.endedScores = [];
    this.endedConfidences = [];
  }
}

/** Create a Smart Turn detector (factory). */
export function createSmartTurnDetectorV13(options: SmartTurnV13Options = {}, sink: SmartTurnV13EventSink | null = null): SmartTurnDetectorV13 {
  return new SmartTurnDetectorV13(options, sink);
}

/** One-line summary of Smart Turn stats. */
export function smartTurnV13Summary(stats: SmartTurnV13Stats): string {
  return (
    `Smart Turn v13: ${stats.turns} turns ended ` +
    `(content ${stats.endedByContent}, silence ${stats.endedBySilence}, timeout ${stats.endedByTimeout}), ` +
    `${stats.backchannels} backchannels, mean score ${stats.meanScore}, mean confidence ${stats.meanConfidence}`
  );
}

/** Smart Turn stats as Markdown (for the diagnostics panel). */
export function smartTurnV13Markdown(stats: SmartTurnV13Stats): string {
  const lines = [
    '## Smart Turn v13 (end-of-turn)',
    '',
    `- turns ended: ${stats.turns} (by content ${stats.endedByContent}, by silence ${stats.endedBySilence}, by timeout ${stats.endedByTimeout})`,
    `- backchannels: ${stats.backchannels}, decisions: ${stats.decisions}`,
    `- mean completeness score: ${stats.meanScore}, mean confidence: ${stats.meanConfidence}`,
  ];
  return lines.join('\n');
}
