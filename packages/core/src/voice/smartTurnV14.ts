/**
 * Semantic turn-taking v2 (v1.15, Đội T5 — voice realtime v14).
 *
 * v13 scores a turn from terminal punctuation, question shape,
 * trailing conjunctions and filler-only bursts. It cannot tell
 * a *clause boundary* from a turn boundary ("Tôi muốn đặt lịch
 * vào thứ sáu, và nhắc tôi…" — the comma is a pause, not an
 * end), an *open* question from a *closed* one ("Bạn nghĩ sao
 * về kế hoạch này?" expects a long answer; "Bạn đi không?"
 * expects yes/no — the first tolerates a longer pause before
 * the user continues, the second does not), a mid-turn filler
 * ("à thì…", "ừm, để tôi nghĩ…") from a real backchannel, or
 * a backchannel that *acknowledges* ("ừ, đúng rồi") from one
 * that *continues* the turn ("ừ, rồi sao nữa?").
 *
 * v14 adds, on top of the v13 scorer (which it reuses — a v14
 * score always contains the v13 score and signals, so panels
 * built on v13 keep working):
 *
 *   - clause boundaries: split the utterance into clauses at
 *     commas / semicolons / colons / conjunctions; a turn
 *     that ends *inside* a clause is incomplete even with
 *     silence, a turn that ends *at* a clause boundary with a
 *     complete clause is much closer to done;
 *   - open vs closed questions: open questions (wh-words,
 *     "nghĩ sao", "thế nào") vs closed ones (yes/no shape,
 *     "không", "à", "đúng không"); the detector waits longer
 *     after an open question;
 *   - filler detection: mid-turn fillers ("à", "ừm", "thì",
 *     "kiểu", "ý là") counted per utterance; a filler *density*
 *     above the threshold says the user is still thinking;
 *   - backchannel classification: `ack` (acknowledgement —
 *     the user is listening), `continue` (the user wants the
 *     floor back), `filler` (thinking noise), `none`;
 *   - sensitivity presets: `low` (patient — waits longer,
 *     fewer false ends), `balanced`, `high` (eager — ends
 *     fast, more false ends), each a full option set.
 *
 * Pure scoring + a detector that wraps `SmartTurnDetectorV13`
 * and adds the v14 signals to its decisions. No audio device,
 * no network, no model: deterministic heuristics over the
 * partial transcript, same as v13.
 */

import {
  SmartTurnDetectorV13,
  scoreTurnCompletenessV13,
  type SmartTurnV13Options,
  type SmartTurnV13Score,
  type SmartTurnV13Signal,
  type SmartTurnV13Decision,
  type SmartTurnV13Stats,
  type SmartTurnV13Event,
} from './smartTurnV13';

/** One clause of an utterance. */
export interface SmartTurnV14Clause {
  text: string;
  /** 0-based index in the utterance. */
  index: number;
  /** True when the clause ends at a boundary (comma / semicolon / colon / conjunction / terminal). */
  endsAtBoundary: boolean;
  /** Words in the clause. */
  words: number;
}

/** Open vs closed question. */
export type SmartTurnV14QuestionKind = 'open' | 'closed' | 'none';

/** Backchannel class. */
export type SmartTurnV14BackchannelKind = 'ack' | 'continue' | 'filler' | 'none';

/** Sensitivity preset. */
export type SmartTurnV14Sensitivity = 'low' | 'balanced' | 'high';

export const SMART_TURN_V14_SENSITIVITIES: readonly SmartTurnV14Sensitivity[] = ['low', 'balanced', 'high'];

export function isSmartTurnV14Sensitivity(value: unknown): value is SmartTurnV14Sensitivity {
  return typeof value === 'string' && (SMART_TURN_V14_SENSITIVITIES as readonly string[]).includes(value);
}

/** Words that open an open question (wh-words + opinion prompts). */
export const SMART_TURN_V14_OPEN_QUESTION_WORDS = new Set([
  'mấy', 'ai', 'gì', 'sao', 'tại', 'khi', 'nào', 'đâu', 'bao',
  'what', 'when', 'where', 'who', 'why', 'how', 'which',
  'nghĩ', 'thế', 'ra',
]);

/** Phrases that mark an open question even mid-sentence. */
export const SMART_TURN_V14_OPEN_QUESTION_PHRASES = [
  'nghĩ sao', 'thế nào', 'ra sao', 'như thế nào', 'ý kiến', 'what do you think', 'how do you',
];

/** Words that close a yes/no (closed) question. */
export const SMART_TURN_V14_CLOSED_QUESTION_ENDINGS = new Set([
  'không', 'à', 'hả', 'nhỉ', 'chưa', 'đúng', 'phải', 'không nhỉ', 'đúng không',
]);

/** Mid-turn fillers: thinking noise inside a turn. */
export const SMART_TURN_V14_MID_FILLERS = new Set([
  'à', 'ừm', 'ừ', 'ờ', 'thì', 'kiểu', 'ý', 'là', 'này', 'um', 'uh', 'hmm', 'like', 'you', 'know',
]);

/** Acknowledgement backchannels (the user is listening). */
export const SMART_TURN_V14_ACK_WORDS = new Set([
  'ừ', 'vâng', 'dạ', 'đúng', 'rồi', 'ok', 'okay', 'yeah', 'yes', 'uh-huh', 'ừm ừm',
]);

/** Continuation backchannels (the user wants the floor back). */
export const SMART_TURN_V14_CONTINUE_WORDS = new Set([
  'rồi', 'sao', 'nữa', 'tiếp', 'thế', 'rồi sao', 'nữa không', 'and', 'then', 'so',
]);

/** Clause-boundary conjunctions (Vietnamese + English). */
export const SMART_TURN_V14_CLAUSE_CONJUNCTIONS = new Set([
  'và', 'nhưng', 'mà', 'thì', 'nên', 'vì', 'nếu', 'khi', 'rồi', 'and', 'but', 'so', 'then', 'because', 'when', 'if',
]);

/** Result of the v14 analysis of one (partial) utterance. */
export interface SmartTurnV14Score {
  /** The v13 score (reused: same completeness + signals). */
  v13: SmartTurnV13Score;
  /** Completeness 0..1 after the v14 signals are applied. */
  score: number;
  complete: boolean;
  /** Clauses of the utterance. */
  clauses: SmartTurnV14Clause[];
  /** True when the utterance ends at a clause boundary. */
  endsAtClauseBoundary: boolean;
  questionKind: SmartTurnV14QuestionKind;
  /** Filler words found mid-turn. */
  fillers: string[];
  /** Filler density 0..1 (filler words / all words). */
  fillerDensity: number;
  backchannel: SmartTurnV14BackchannelKind;
  /** Extra v14 signals (on top of the v13 ones). */
  signals: SmartTurnV13Signal[];
  text: string;
}

/** Options for the v14 scorer and detector (extends v13's). */
export interface SmartTurnV14Options extends SmartTurnV13Options {
  /** Sensitivity preset (default 'balanced'); overrides the thresholds below when given. */
  sensitivity?: SmartTurnV14Sensitivity;
  /** Filler density at/above which the user is still thinking (default 0.25). */
  fillerDensityThreshold?: number;
  /** Extra silence (ms) waited after an open question (default 400). */
  openQuestionExtraSilenceMs?: number;
  /** Weight of ending at a clause boundary (default 0.15). */
  clauseBoundaryWeight?: number;
  /** Weight of ending mid-clause (default -0.25). */
  midClauseWeight?: number;
  /** Weight of an open question (default -0.1 — open questions tolerate pauses). */
  openQuestionWeight?: number;
}

/** A v14 decision (a v13 decision + the v14 analysis). */
export interface SmartTurnV14Decision {
  v13: SmartTurnV13Decision;
  analysis: SmartTurnV14Score;
  ended: boolean;
  confidence: number;
  reason: SmartTurnV13Decision['reason'] | 'open-question-wait' | 'mid-clause-wait' | 'filler-thinking';
  silenceMs: number;
  speechMs: number;
  atMs: number;
}

/** Counters for one v14 detector. */
export interface SmartTurnV14Stats extends SmartTurnV13Stats {
  clauseBoundaries: number;
  midClauseWaits: number;
  openQuestionWaits: number;
  fillerThinking: number;
  backchannelAck: number;
  backchannelContinue: number;
  openQuestions: number;
  closedQuestions: number;
}

/** Events emitted by the v14 detector. */
export type SmartTurnV14Event =
  | { kind: 'decision'; decision: SmartTurnV14Decision }
  | { kind: 'turn-ended'; decision: SmartTurnV14Decision }
  | { kind: 'backchannel'; atMs: number; text: string; backchannel: SmartTurnV14BackchannelKind }
  | { kind: 'v13'; event: SmartTurnV13Event };

export type SmartTurnV14EventSink = (event: SmartTurnV14Event) => void;

function normaliseV14(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function wordsOf(text: string): string[] {
  return text.split(' ').filter((w) => w.length > 0);
}

function stripPunct(word: string): string {
  return word.toLowerCase().replace(/[?!.,…:;]+$/, '');
}

/**
 * Split an utterance into clauses at commas, semicolons,
 * colons and clause conjunctions. Pure. A clause that ends
 * with terminal punctuation also ends at a boundary.
 */
export function splitClausesV14(text: string): SmartTurnV14Clause[] {
  const clean = normaliseV14(text);
  if (!clean) return [];
  const clauses: SmartTurnV14Clause[] = [];
  let current: string[] = [];
  const flush = (endsAtBoundary: boolean): void => {
    const joined = current.join(' ').trim();
    if (joined) {
      clauses.push({ text: joined, index: clauses.length, endsAtBoundary, words: wordsOf(joined).length });
    }
    current = [];
  };
  for (const word of wordsOf(clean)) {
    const bare = stripPunct(word);
    const endsWithComma = /[,;:]$/.test(word);
    const endsWithTerminal = /[.!?…]$/.test(word);
    current.push(word);
    if (endsWithTerminal) {
      flush(true);
    } else if (endsWithComma) {
      flush(true);
    } else if (SMART_TURN_V14_CLAUSE_CONJUNCTIONS.has(bare) && current.length > 2) {
      // A conjunction mid-sentence starts a new clause only
      // when it follows a completed phrase; a leading
      // conjunction ("và tôi…") stays with its clause.
      flush(true);
    }
  }
  flush(false);
  // The last clause ends at a boundary when the text ends with
  // terminal punctuation (already flushed) — otherwise not.
  return clauses;
}

/** Classify a question as open, closed or none. Pure. */
export function classifyQuestionV14(text: string): SmartTurnV14QuestionKind {
  const clean = normaliseV14(text);
  if (!clean) return 'none';
  const lower = clean.toLowerCase();
  const words = wordsOf(clean);
  const first = stripPunct(words[0] ?? '');
  const last = stripPunct(words[words.length - 1] ?? '');
  if (SMART_TURN_V14_OPEN_QUESTION_PHRASES.some((p) => lower.includes(p))) return 'open';
  if (SMART_TURN_V14_OPEN_QUESTION_WORDS.has(first) && !/[?]$/.test(clean)) {
    // A wh-word opener without a question mark is still an
    // open question in progress ("mấy giờ họp…").
    return 'open';
  }
  if (SMART_TURN_V14_OPEN_QUESTION_WORDS.has(first)) return 'open';
  if (SMART_TURN_V14_CLOSED_QUESTION_ENDINGS.has(last)) return 'closed';
  if (/[?]\s*$/.test(clean) && words.length <= 5) return 'closed';
  if (/[?]\s*$/.test(clean)) return 'open';
  return 'none';
}

/** Find mid-turn fillers in an utterance. Pure. */
export function findFillersV14(text: string): string[] {
  const found: string[] = [];
  for (const word of wordsOf(normaliseV14(text))) {
    const bare = stripPunct(word);
    if (SMART_TURN_V14_MID_FILLERS.has(bare)) found.push(bare);
  }
  return found;
}

/** Classify a short utterance as a backchannel (or none). Pure. */
export function classifyBackchannelV14(text: string): SmartTurnV14BackchannelKind {
  const clean = normaliseV14(text);
  const words = wordsOf(clean).map((w) => stripPunct(w));
  if (words.length === 0 || words.length > 3) return 'none';
  const joined = words.join(' ');
  if (SMART_TURN_V14_CONTINUE_WORDS.has(joined) || SMART_TURN_V14_CONTINUE_WORDS.has(words[words.length - 1] as string)) {
    // "rồi sao nữa?" wants the floor; "ừ, rồi" only acks.
    if (words.includes('sao') || words.includes('nữa') || words.includes('tiếp')) return 'continue';
  }
  if (words.every((w) => SMART_TURN_V14_ACK_WORDS.has(w))) return 'ack';
  if (words.every((w) => SMART_TURN_V14_MID_FILLERS.has(w))) return 'filler';
  return 'none';
}

/** Sensitivity preset → threshold overrides. */
export function sensitivityPresetV14(sensitivity: SmartTurnV14Sensitivity): {
  completenessThreshold: number;
  incompleteThreshold: number;
  silenceCompleteMs: number;
  silenceUndecidedMs: number;
  silenceIncompleteMs: number;
} {
  switch (sensitivity) {
    case 'low':
      return { completenessThreshold: 0.7, incompleteThreshold: 0.4, silenceCompleteMs: 500, silenceUndecidedMs: 1100, silenceIncompleteMs: 2200 };
    case 'high':
      return { completenessThreshold: 0.5, incompleteThreshold: 0.2, silenceCompleteMs: 180, silenceUndecidedMs: 450, silenceIncompleteMs: 1000 };
    case 'balanced':
    default:
      return { completenessThreshold: 0.6, incompleteThreshold: 0.3, silenceCompleteMs: 300, silenceUndecidedMs: 700, silenceIncompleteMs: 1500 };
  }
}

export function defaultSmartTurnV14Options(): Required<SmartTurnV14Options> {
  const preset = sensitivityPresetV14('balanced');
  return {
    completenessThreshold: preset.completenessThreshold,
    incompleteThreshold: preset.incompleteThreshold,
    silenceCompleteMs: preset.silenceCompleteMs,
    silenceUndecidedMs: preset.silenceUndecidedMs,
    silenceIncompleteMs: preset.silenceIncompleteMs,
    minSpeechMs: 300,
    maxTurnMs: 30000,
    terminalWeight: 0.35,
    questionWeight: 0.25,
    trailingConjunctionWeight: -0.5,
    fillerWeight: -0.4,
    sensitivity: 'balanced',
    fillerDensityThreshold: 0.25,
    openQuestionExtraSilenceMs: 400,
    clauseBoundaryWeight: 0.15,
    midClauseWeight: -0.25,
    openQuestionWeight: -0.1,
  };
}

export function validateSmartTurnV14Options(options: SmartTurnV14Options): Required<SmartTurnV14Options> {
  const base = defaultSmartTurnV14Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Smart Turn v14 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  // A sensitivity preset overrides the silence/threshold
  // options unless the caller set them explicitly.
  const preset = options.sensitivity !== undefined
    ? sensitivityPresetV14(options.sensitivity)
    : null;
  if (options.sensitivity !== undefined && !isSmartTurnV14Sensitivity(options.sensitivity)) {
    throw new Error(`Smart Turn v14 sensitivity must be one of ${SMART_TURN_V14_SENSITIVITIES.join(', ')}.`);
  }
  const completenessThreshold = num(
    options.completenessThreshold ?? preset?.completenessThreshold, base.completenessThreshold,
    'completenessThreshold', 0, 1,
  );
  const incompleteThreshold = num(
    options.incompleteThreshold ?? preset?.incompleteThreshold, base.incompleteThreshold,
    'incompleteThreshold', 0, 1,
  );
  if (incompleteThreshold > completenessThreshold) {
    throw new Error(`Smart Turn v14 incompleteThreshold (${incompleteThreshold}) must be <= completenessThreshold (${completenessThreshold}).`);
  }
  return {
    completenessThreshold,
    incompleteThreshold,
    silenceCompleteMs: Math.floor(num(options.silenceCompleteMs ?? preset?.silenceCompleteMs, base.silenceCompleteMs, 'silenceCompleteMs', 0, 60000)),
    silenceUndecidedMs: Math.floor(num(options.silenceUndecidedMs ?? preset?.silenceUndecidedMs, base.silenceUndecidedMs, 'silenceUndecidedMs', 0, 60000)),
    silenceIncompleteMs: Math.floor(num(options.silenceIncompleteMs ?? preset?.silenceIncompleteMs, base.silenceIncompleteMs, 'silenceIncompleteMs', 0, 60000)),
    minSpeechMs: Math.floor(num(options.minSpeechMs, base.minSpeechMs, 'minSpeechMs', 0, 60000)),
    maxTurnMs: Math.floor(num(options.maxTurnMs, base.maxTurnMs, 'maxTurnMs', 1000, 600000)),
    terminalWeight: num(options.terminalWeight, base.terminalWeight, 'terminalWeight', 0, 1),
    questionWeight: num(options.questionWeight, base.questionWeight, 'questionWeight', 0, 1),
    trailingConjunctionWeight: num(options.trailingConjunctionWeight, base.trailingConjunctionWeight, 'trailingConjunctionWeight', -1, 0),
    fillerWeight: num(options.fillerWeight, base.fillerWeight, 'fillerWeight', -1, 0),
    sensitivity: options.sensitivity ?? base.sensitivity,
    fillerDensityThreshold: num(options.fillerDensityThreshold, base.fillerDensityThreshold, 'fillerDensityThreshold', 0, 1),
    openQuestionExtraSilenceMs: Math.floor(num(options.openQuestionExtraSilenceMs, base.openQuestionExtraSilenceMs, 'openQuestionExtraSilenceMs', 0, 60000)),
    clauseBoundaryWeight: num(options.clauseBoundaryWeight, base.clauseBoundaryWeight, 'clauseBoundaryWeight', 0, 1),
    midClauseWeight: num(options.midClauseWeight, base.midClauseWeight, 'midClauseWeight', -1, 0),
    openQuestionWeight: num(options.openQuestionWeight, base.openQuestionWeight, 'openQuestionWeight', -1, 0),
  };
}

/**
 * Analyse one (partial) utterance for turn completeness, v14
 * style: the v13 score plus clause boundaries, question kind,
 * fillers and backchannel class. Pure.
 */
export function scoreTurnCompletenessV14(text: string, options: SmartTurnV14Options = {}): SmartTurnV14Score {
  const opts = validateSmartTurnV14Options(options);
  const v13 = scoreTurnCompletenessV13(text, opts);
  const clean = normaliseV14(text);
  const signals: SmartTurnV13Signal[] = [];
  const clauses = splitClausesV14(clean);
  const lastClause = clauses[clauses.length - 1];
  const endsAtClauseBoundary = clauses.length > 0 && (lastClause?.endsAtBoundary ?? false);
  let score = v13.score;
  if (clean && endsAtClauseBoundary && clauses.length >= 1) {
    signals.push({ name: 'clause-boundary', weight: opts.clauseBoundaryWeight, detail: `ends at a clause boundary (${clauses.length} clause(s))` });
    score += opts.clauseBoundaryWeight;
  }
  if (clean && !endsAtClauseBoundary && clauses.length >= 1 && wordsOf(clean).length >= 4) {
    signals.push({ name: 'mid-clause', weight: opts.midClauseWeight, detail: 'ends mid-clause — the sentence is unfinished' });
    score += opts.midClauseWeight;
  }
  const questionKind = classifyQuestionV14(clean);
  if (questionKind === 'open') {
    signals.push({ name: 'open-question', weight: opts.openQuestionWeight, detail: 'open question — the user may keep talking' });
    score += opts.openQuestionWeight;
  }
  const fillers = findFillersV14(clean);
  const words = wordsOf(clean);
  const fillerDensity = words.length === 0 ? 0 : Math.round((fillers.length / words.length) * 100) / 100;
  if (fillers.length > 0 && fillerDensity >= opts.fillerDensityThreshold) {
    signals.push({ name: 'filler-thinking', weight: -0.2, detail: `${fillers.length} filler(s), density ${fillerDensity} — still thinking` });
    score -= 0.2;
  }
  const backchannel = classifyBackchannelV14(clean);
  if (backchannel !== 'none') {
    signals.push({ name: `backchannel-${backchannel}`, weight: -0.3, detail: `backchannel (${backchannel}): "${clean}"` });
    score -= 0.3;
  }
  const clamped = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  return {
    v13,
    score: clamped,
    complete: clamped >= opts.completenessThreshold,
    clauses,
    endsAtClauseBoundary,
    questionKind,
    fillers,
    fillerDensity,
    backchannel,
    signals,
    text: clean,
  };
}

/**
 * Smart Turn detector v2: a v13 detector plus the v14
 * analysis. The v13 detector still owns the clock, silence
 * and reset behaviour; v14 *holds back* an end decision when
 * the utterance ends mid-clause, is an open question still
 * within its extra silence, or is filler-heavy — and reports
 * the hold-back reason so the panel can show *why* the turn
 * did not end yet. Backchannels are classified (ack /
 * continue / filler) instead of only counted.
 */
export class SmartTurnDetectorV14 {
  private readonly options: Required<SmartTurnV14Options>;
  private readonly sink: SmartTurnV14EventSink | null;
  private readonly inner: SmartTurnDetectorV13;
  private clauseBoundaries = 0;
  private midClauseWaits = 0;
  private openQuestionWaits = 0;
  private fillerThinking = 0;
  private backchannelAck = 0;
  private backchannelContinue = 0;
  private openQuestions = 0;
  private closedQuestions = 0;
  private turnStartedAtMs: number | null = null;

  constructor(options: SmartTurnV14Options = {}, sink: SmartTurnV14EventSink | null = null) {
    this.options = validateSmartTurnV14Options(options);
    this.sink = sink;
    const v13Options: SmartTurnV13Options = {
      completenessThreshold: this.options.completenessThreshold,
      incompleteThreshold: this.options.incompleteThreshold,
      silenceCompleteMs: this.options.silenceCompleteMs,
      silenceUndecidedMs: this.options.silenceUndecidedMs,
      silenceIncompleteMs: this.options.silenceIncompleteMs,
      minSpeechMs: this.options.minSpeechMs,
      maxTurnMs: this.options.maxTurnMs,
      terminalWeight: this.options.terminalWeight,
      questionWeight: this.options.questionWeight,
      trailingConjunctionWeight: this.options.trailingConjunctionWeight,
      fillerWeight: this.options.fillerWeight,
    };
    this.inner = new SmartTurnDetectorV13(v13Options, (event) => {
      this.sink?.({ kind: 'v13', event });
    });
  }

  getOptions(): Required<SmartTurnV14Options> {
    return { ...this.options };
  }

  /** The wrapped v13 detector (for v13-shaped callers). */
  getV13(): SmartTurnDetectorV13 {
    return this.inner;
  }

  getText(): string {
    return this.inner.getText();
  }

  getSpeechMs(): number {
    return this.inner.getSpeechMs();
  }

  getSilenceMs(): number {
    return this.inner.getSilenceMs();
  }

  notePartialText(text: string, atMs: number): void {
    if (this.turnStartedAtMs === null) this.turnStartedAtMs = atMs;
    this.inner.notePartialText(text, atMs);
  }

  noteSpeech(ms: number, atMs: number): void {
    if (this.turnStartedAtMs === null) this.turnStartedAtMs = atMs;
    this.inner.noteSpeech(ms, atMs);
  }

  noteSilence(ms: number): void {
    this.inner.noteSilence(ms);
  }

  /**
   * Decide whether the turn is over. The v13 verdict is
   * honoured unless a v14 hold-back applies; a hold-back never
   * extends past `maxTurnMs` (the inner detector's timeout
   * still ends the turn). Hold-backs are checked *before* the
   * inner detector decides: once it ends a turn it resets its
   * state and counts the turn, so a hold-back after the fact
   * would double-count.
   */
  decide(atMs: number): SmartTurnV14Decision {
    const analysis = scoreTurnCompletenessV14(this.inner.getText(), this.options);
    const silenceMs = this.inner.getSilenceMs();
    const speechMs = this.inner.getSpeechMs();
    const base = { analysis, silenceMs, speechMs, atMs };

    const holdBack = (reason: SmartTurnV14Decision['reason'], confidence: number): SmartTurnV14Decision => {
      const decision: SmartTurnV14Decision = {
        ...base,
        v13: {
          ended: false, confidence, reason: 'not-yet', score: analysis.v13,
          silenceMs, speechMs, atMs,
        },
        ended: false,
        confidence,
        reason,
      };
      this.sink?.({ kind: 'decision', decision });
      return decision;
    };

    // Backchannel classification (short utterances only).
    if (analysis.backchannel !== 'none' && analysis.text && wordsOf(analysis.text).length <= 3 && silenceMs >= 150) {
      if (analysis.backchannel === 'ack') this.backchannelAck += 1;
      if (analysis.backchannel === 'continue') this.backchannelContinue += 1;
      this.sink?.({ kind: 'backchannel', atMs, text: analysis.text, backchannel: analysis.backchannel });
      // An ack backchannel never ends a turn; a `continue`
      // backchannel means the user wants the floor — the inner
      // detector's own filler path also treats it as no turn,
      // so report it as a hold-back and let the host listen on.
      return holdBack('filler-thinking', 0.8);
    }
    // Filler-heavy: the user is still thinking.
    if (analysis.fillerDensity >= this.options.fillerDensityThreshold && analysis.fillers.length >= 2 && silenceMs < this.options.silenceIncompleteMs) {
      this.fillerThinking += 1;
      return holdBack('filler-thinking', 0.7);
    }
    // Would the v13 detector end the turn right now? Mirror
    // its decision conditions (complete + silence, question
    // mark, undecided / incomplete silence) so a hold-back can
    // run before it commits and resets.
    const turnAgeMs = this.turnStartedAtMs === null ? 0 : atMs - this.turnStartedAtMs;
    const wouldTimeout = turnAgeMs >= this.options.maxTurnMs;
    const wouldEndBySilence =
      !wouldTimeout &&
      speechMs >= this.options.minSpeechMs &&
      ((analysis.v13.complete && silenceMs >= this.options.silenceCompleteMs) ||
        (analysis.v13.complete && /[?]\s*$/.test(analysis.text) && silenceMs >= 100) ||
        (analysis.v13.score >= this.options.incompleteThreshold && silenceMs >= this.options.silenceUndecidedMs) ||
        (analysis.v13.score < this.options.incompleteThreshold && silenceMs >= this.options.silenceIncompleteMs));
    if (wouldEndBySilence) {
      if (analysis.questionKind === 'open' && silenceMs < this.options.silenceCompleteMs + this.options.openQuestionExtraSilenceMs) {
        this.openQuestionWaits += 1;
        return holdBack('open-question-wait', 0.65);
      }
      if (!analysis.endsAtClauseBoundary && wordsOf(analysis.text).length >= 4 && !/[.!?…]\s*$/.test(analysis.text) && silenceMs < this.options.silenceIncompleteMs) {
        // Hold back only while the silence is still short: a
        // user who stopped mid-sentence and stays silent past
        // the incomplete threshold has still ended the turn.
        this.midClauseWaits += 1;
        return holdBack('mid-clause-wait', 0.65);
      }
    }
    const v13Decision = this.inner.decide(atMs);
    if (!v13Decision.ended) {
      return {
        ...base, v13: v13Decision, ended: false,
        confidence: v13Decision.confidence, reason: v13Decision.reason,
        silenceMs, speechMs, atMs,
      };
    }
    if (analysis.endsAtClauseBoundary) this.clauseBoundaries += 1;
    if (analysis.questionKind === 'open') this.openQuestions += 1;
    if (analysis.questionKind === 'closed') this.closedQuestions += 1;
    this.turnStartedAtMs = null;
    const decision: SmartTurnV14Decision = {
      ...base,
      v13: v13Decision,
      ended: true,
      confidence: v13Decision.confidence,
      reason: v13Decision.reason,
      silenceMs,
      speechMs,
      atMs,
    };
    this.sink?.({ kind: 'decision', decision });
    this.sink?.({ kind: 'turn-ended', decision });
    return decision;
  }

  getStats(): SmartTurnV14Stats {
    const v13 = this.inner.getStats();
    return {
      ...v13,
      clauseBoundaries: this.clauseBoundaries,
      midClauseWaits: this.midClauseWaits,
      openQuestionWaits: this.openQuestionWaits,
      fillerThinking: this.fillerThinking,
      backchannelAck: this.backchannelAck,
      backchannelContinue: this.backchannelContinue,
      openQuestions: this.openQuestions,
      closedQuestions: this.closedQuestions,
    };
  }

  reset(): void {
    this.inner.reset();
    this.clauseBoundaries = 0;
    this.midClauseWaits = 0;
    this.openQuestionWaits = 0;
    this.fillerThinking = 0;
    this.backchannelAck = 0;
    this.backchannelContinue = 0;
    this.openQuestions = 0;
    this.closedQuestions = 0;
    this.turnStartedAtMs = null;
  }
}

/** Create a Smart Turn detector v2 (factory). */
export function createSmartTurnDetectorV14(
  options: SmartTurnV14Options = {},
  sink: SmartTurnV14EventSink | null = null,
): SmartTurnDetectorV14 {
  return new SmartTurnDetectorV14(options, sink);
}

/** One-line summary of v14 Smart Turn stats. */
export function smartTurnV14Summary(stats: SmartTurnV14Stats): string {
  return (
    `Smart Turn v14: ${stats.turns} turns ended ` +
    `(content ${stats.endedByContent}, silence ${stats.endedBySilence}, timeout ${stats.endedByTimeout}), ` +
    `${stats.backchannels} backchannels (ack ${stats.backchannelAck}, continue ${stats.backchannelContinue}), ` +
    `open questions ${stats.openQuestions}, closed ${stats.closedQuestions}, ` +
    `clause boundaries ${stats.clauseBoundaries}, mid-clause waits ${stats.midClauseWaits}, ` +
    `open-question waits ${stats.openQuestionWaits}, filler-thinking ${stats.fillerThinking}`
  );
}

/** Smart Turn v14 stats as Markdown (for the diagnostics panel). */
export function smartTurnV14Markdown(stats: SmartTurnV14Stats): string {
  const lines = [
    '## Smart Turn v14 (end-of-turn v2)',
    '',
    `- turns ended: ${stats.turns} (by content ${stats.endedByContent}, by silence ${stats.endedBySilence}, by timeout ${stats.endedByTimeout})`,
    `- backchannels: ${stats.backchannels} (ack ${stats.backchannelAck}, continue ${stats.backchannelContinue}), decisions: ${stats.decisions}`,
    `- questions: open ${stats.openQuestions}, closed ${stats.closedQuestions}`,
    `- clause boundaries: ${stats.clauseBoundaries}, mid-clause waits: ${stats.midClauseWaits}, open-question waits: ${stats.openQuestionWaits}, filler-thinking: ${stats.fillerThinking}`,
    `- mean completeness score: ${stats.meanScore}, mean confidence: ${stats.meanConfidence}`,
  ];
  return lines.join('\n');
}
