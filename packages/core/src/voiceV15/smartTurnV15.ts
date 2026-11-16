/**
 * Semantic turn-taking v3 (v1.16, Đội T5 — voice v15).
 *
 * VAD alone ends a turn on silence, and silence is ambiguous: the
 * user may be done, or may be thinking mid-sentence ("Tôi muốn đặt
 * lịch vào thứ sáu, và… [pause] nhắc tôi lúc 9 giờ"). Pure-VAD
 * systems cut those pauses and the agent answers half a question.
 * Semantic turn detection (LiveKit adaptive turn model, Pipecat
 * Smart Turn v3.1) cuts false end-of-turns by an order of magnitude
 * by reading the *words*, not just the silence.
 *
 * v15 scores a partial transcript with a weighted, rule-based
 * classifier — no model call, so it runs in microseconds on every
 * partial, in Vietnamese and English:
 *
 *   Positive (done): terminal punctuation (. ? !), a complete clause
 *     at a clause boundary, a closed question ("…không?", yes/no
 *     shape), a final discourse marker ("thế thôi", "that's it"),
 *     a backchannel acknowledgement ("ừ, đúng rồi" — the user is
 *     yielding the floor).
 *   Negative (not done): trailing conjunction ("và", "nhưng", "and",
 *     "so"), an open clause (ends inside a clause), an open question
 *     ("bạn nghĩ sao…?" — expects a long answer, the user may keep
 *     talking), filler density above threshold ("ừm… à thì…", the
 *     user is still thinking), a mid-turn filler, a continuing
 *     backchannel ("ừ, rồi sao nữa?").
 *
 * The classifier returns a 0..1 completeness score, a decision
 * (`end` / `wait` / `continue`) and a recommended extra wait.
 * `SmartTurnDetectorV15` wraps it with hysteresis over silence:
 * it holds the turn while the score says "thinking", releases it
 * when the score says "done" *and* silence has passed the
 * (score-dependent) threshold, and never releases a turn whose
 * score is below the floor no matter how long the silence lasts
 * (the user may just be breathing).
 *
 * Both languages share the scorer; the word lists are per-language
 * and the detector auto-detects vi vs en from the transcript
 * (Vietnamese diacritics / function words win over the English
 * lists). Everything is pure text — no audio, no model.
 */

export type SmartTurnV15Language = 'vi' | 'en' | 'auto';
export type SmartTurnV15Sensitivity = 'low' | 'balanced' | 'high';
export const SMART_TURN_V15_SENSITIVITIES: readonly SmartTurnV15Sensitivity[] = ['low', 'balanced', 'high'];

export type SmartTurnV15Decision = 'end' | 'wait' | 'continue';
export type SmartTurnV15Class =
  | 'complete'
  | 'thinking-pause'
  | 'incomplete'
  | 'backchannel-ack'
  | 'backchannel-continue'
  | 'filler-only';

export const SMART_TURN_V15_TERMINAL_PUNCT = ['.', '?', '!', '…'];
export const SMART_TURN_V15_CLAUSE_SPLITTERS = [',', ';', ':', '—', '–'];

export const SMART_TURN_V15_VI_TRAILING_CONJUNCTIONS = [
  'và', 'nhưng', 'mà', 'thì', 'nên', 'vì', 'nếu', 'khi', 'rồi', 'với', 'của', 'để', 'hay', 'hoặc',
];
export const SMART_TURN_V15_EN_TRAILING_CONJUNCTIONS = [
  'and', 'but', 'so', 'because', 'if', 'when', 'then', 'with', 'or', 'that', 'which', 'to',
];
export const SMART_TURN_V15_VI_OPEN_QUESTION_WORDS = [
  'sao', 'thế nào', 'như thế nào', 'tại sao', 'vì sao', 'bao giờ', 'khi nào', 'ở đâu', 'cái gì', 'ai',
];
export const SMART_TURN_V15_EN_OPEN_QUESTION_WORDS = [
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'tell me', 'explain',
];
export const SMART_TURN_V15_VI_CLOSED_ENDINGS = ['không', 'à', 'hả', 'nhé', 'đúng không', 'phải không', 'chưa'];
export const SMART_TURN_V15_EN_CLOSED_ENDINGS = ['right', 'okay', 'yes or no', 'isn\'t it', 'don\'t you'];
export const SMART_TURN_V15_VI_FILLERS = [
  'ừm', 'ừ', 'à', 'ờ', 'thì', 'kiểu', 'ý là', 'hmm', 'ơ', 'à thì',
];
export const SMART_TURN_V15_EN_FILLERS = [
  'um', 'uh', 'hmm', 'like', 'you know', 'i mean', 'well', 'so', 'actually', 'er',
];
export const SMART_TURN_V15_VI_ACK_WORDS = ['ừ', 'đúng rồi', 'ok', 'okay', 'được', 'ừ đúng', 'vâng', 'dạ'];
export const SMART_TURN_V15_EN_ACK_WORDS = ['yeah', 'yes', 'right', 'ok', 'okay', 'uh-huh', 'mm-hmm', 'got it'];
export const SMART_TURN_V15_VI_CONTINUE_WORDS = ['rồi sao', 'sau đó', 'tiếp theo', 'còn', 'nữa'];
export const SMART_TURN_V15_EN_CONTINUE_WORDS = ['and then', 'what else', 'go on', 'continue', 'also'];
export const SMART_TURN_V15_VI_FINAL_MARKERS = ['thế thôi', 'hết rồi', 'xong rồi', 'đó là tất cả', 'chỉ vậy thôi'];
export const SMART_TURN_V15_EN_FINAL_MARKERS = ['that\'s it', 'that\'s all', 'done', 'that is all', 'nothing else'];

export interface SmartTurnV15Options {
  language?: SmartTurnV15Language;
  sensitivity?: SmartTurnV15Sensitivity;
  /** Score at/above this ends the turn (with enough silence). */
  endThreshold?: number;
  /** Score below this never ends the turn, however long the silence. */
  floorThreshold?: number;
  /** Base silence (ms) that ends a high-score turn. */
  baseSilenceMs?: number;
  /** Extra silence (ms) waited for an open question. */
  openQuestionExtraMs?: number;
  /** Extra silence (ms) waited while filler density is high. */
  thinkingExtraMs?: number;
}

export function defaultSmartTurnV15Options(): Required<SmartTurnV15Options> {
  return {
    language: 'auto',
    sensitivity: 'balanced',
    endThreshold: 0.6,
    floorThreshold: 0.3,
    baseSilenceMs: 450,
    openQuestionExtraMs: 500,
    thinkingExtraMs: 600,
  };
}

export function sensitivityPresetV15(sensitivity: SmartTurnV15Sensitivity): Required<SmartTurnV15Options> {
  const base = defaultSmartTurnV15Options();
  switch (sensitivity) {
    case 'low':
      return { ...base, sensitivity, endThreshold: 0.75, baseSilenceMs: 700, openQuestionExtraMs: 800, thinkingExtraMs: 900 };
    case 'high':
      return { ...base, sensitivity, endThreshold: 0.45, baseSilenceMs: 250, openQuestionExtraMs: 300, thinkingExtraMs: 350 };
    case 'balanced':
    default:
      return { ...base, sensitivity };
  }
}

export function validateSmartTurnV15Options(options: SmartTurnV15Options): string[] {
  const errors: string[] = [];
  if (options.endThreshold !== undefined && (options.endThreshold < 0 || options.endThreshold > 1)) {
    errors.push('endThreshold must be 0..1');
  }
  if (options.floorThreshold !== undefined && (options.floorThreshold < 0 || options.floorThreshold > 1)) {
    errors.push('floorThreshold must be 0..1');
  }
  if (options.endThreshold !== undefined && options.floorThreshold !== undefined && options.floorThreshold >= options.endThreshold) {
    errors.push('floorThreshold must be smaller than endThreshold');
  }
  if (options.baseSilenceMs !== undefined && (options.baseSilenceMs < 50 || options.baseSilenceMs > 5000)) {
    errors.push('baseSilenceMs must be 50..5000');
  }
  if (options.language !== undefined && !['vi', 'en', 'auto'].includes(options.language)) {
    errors.push(`unknown language: ${options.language}`);
  }
  if (options.sensitivity !== undefined && !SMART_TURN_V15_SENSITIVITIES.includes(options.sensitivity)) {
    errors.push(`unknown sensitivity: ${options.sensitivity}`);
  }
  return errors;
}

export interface SmartTurnV15Signals {
  language: 'vi' | 'en';
  words: number;
  hasTerminalPunct: boolean;
  endsAtClauseBoundary: boolean;
  trailingConjunction: string | undefined;
  isQuestion: boolean;
  isOpenQuestion: boolean;
  isClosedQuestion: boolean;
  hasFinalMarker: boolean;
  fillerCount: number;
  fillerDensity: number;
  backchannel: 'ack' | 'continue' | 'none';
  isFillerOnly: boolean;
}

export interface SmartTurnV15Score {
  text: string;
  score: number;
  decision: SmartTurnV15Decision;
  classification: SmartTurnV15Class;
  recommendedWaitMs: number;
  signals: SmartTurnV15Signals;
  reasons: string[];
}

function tokenizeV15(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.,!?;:…—–"“”'']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Detect Vietnamese from diacritics / function words; default English. */
export function detectSmartTurnLanguageV15(text: string): 'vi' | 'en' {
  const lower = text.toLowerCase();
  if (/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/.test(lower)) return 'vi';
  const viWords = ['tôi', 'bạn', 'của', 'là', 'không', 'và', 'cái', 'này', 'đó', 'muốn', 'hãy', 'cho', 'với', 'nhé'];
  const hits = viWords.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)).length;
  return hits >= 2 ? 'vi' : 'en';
}

function endsWithWordV15(text: string, words: string[]): string | undefined {
  const lower = text.toLowerCase().trim().replace(/[.?!…]+$/, '');
  for (const word of words) {
    if (lower === word || lower.endsWith(` ${word}`) || lower.endsWith(word)) return word;
  }
  return undefined;
}

function containsPhraseV15(text: string, phrases: string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((p) => lower.includes(p));
}

export function splitClausesV15(text: string): string[] {
  return text
    .split(/[,;:—–]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

export function scoreTurnCompletenessV15(
  partial: string,
  options: SmartTurnV15Options = {},
): SmartTurnV15Score {
  const opts = { ...defaultSmartTurnV15Options(), ...options };
  const text = partial.trim();
  const language = opts.language === 'auto' ? detectSmartTurnLanguageV15(text) : opts.language;
  const words = tokenizeV15(text);
  const fillers = language === 'vi' ? SMART_TURN_V15_VI_FILLERS : SMART_TURN_V15_EN_FILLERS;
  const trailing = language === 'vi' ? SMART_TURN_V15_VI_TRAILING_CONJUNCTIONS : SMART_TURN_V15_EN_TRAILING_CONJUNCTIONS;
  const openWords = language === 'vi' ? SMART_TURN_V15_VI_OPEN_QUESTION_WORDS : SMART_TURN_V15_EN_OPEN_QUESTION_WORDS;
  const closedEndings = language === 'vi' ? SMART_TURN_V15_VI_CLOSED_ENDINGS : SMART_TURN_V15_EN_CLOSED_ENDINGS;
  const ackWords = language === 'vi' ? SMART_TURN_V15_VI_ACK_WORDS : SMART_TURN_V15_EN_ACK_WORDS;
  const continueWords = language === 'vi' ? SMART_TURN_V15_VI_CONTINUE_WORDS : SMART_TURN_V15_EN_CONTINUE_WORDS;
  const finalMarkers = language === 'vi' ? SMART_TURN_V15_VI_FINAL_MARKERS : SMART_TURN_V15_EN_FINAL_MARKERS;

  const lastChar = text.length > 0 ? text[text.length - 1] : '';
  const hasTerminalPunct = SMART_TURN_V15_TERMINAL_PUNCT.includes(lastChar);
  const clauses = splitClausesV15(text);
  const lastClause = clauses.length > 0 ? clauses[clauses.length - 1] : '';
  const lastClauseWords = tokenizeV15(lastClause);
  const endsAtClauseBoundary = clauses.length >= 1 && lastClauseWords.length >= 2 && !hasTerminalPunct
    ? false
    : hasTerminalPunct;
  const trailingConjunction = endsWithWordV15(text, trailing);
  const isQuestion = text.endsWith('?') || containsPhraseV15(text, openWords);
  const isOpenQuestion = containsPhraseV15(text, openWords);
  const isClosedQuestion = isQuestion && !isOpenQuestion && endsWithWordV15(text, closedEndings) !== undefined;
  const hasFinalMarker = containsPhraseV15(text, finalMarkers);
  const fillerCount = words.filter((w) => fillers.includes(w)).length
    + (language === 'vi' ? (text.toLowerCase().match(/ừm|à thì|ý là/g) ?? []).length : 0);
  const fillerDensity = words.length > 0 ? fillerCount / words.length : 0;
  const isFillerOnly = words.length > 0 && words.every((w) => fillers.includes(w));
  let backchannel: SmartTurnV15Signals['backchannel'] = 'none';
  if (words.length <= 4 && containsPhraseV15(text, ackWords)) backchannel = 'ack';
  else if (containsPhraseV15(text, continueWords)) backchannel = 'continue';

  const reasons: string[] = [];
  let score = 0.35; // prior: a bare utterance is more likely unfinished than done.
  if (text.length === 0) {
    return {
      text,
      score: 0,
      decision: 'continue',
      classification: 'incomplete',
      recommendedWaitMs: opts.baseSilenceMs,
      signals: {
        language, words: 0, hasTerminalPunct: false, endsAtClauseBoundary: false,
        trailingConjunction: undefined, isQuestion: false, isOpenQuestion: false,
        isClosedQuestion: false, hasFinalMarker: false, fillerCount: 0, fillerDensity: 0,
        backchannel: 'none', isFillerOnly: false,
      },
      reasons: ['empty transcript'],
    };
  }
  if (hasTerminalPunct) { score += 0.35; reasons.push('terminal punctuation'); }
  if (words.length >= 4) { score += 0.1; reasons.push('enough words for a complete turn'); }
  if (hasFinalMarker) { score += 0.25; reasons.push('final marker'); }
  if (isClosedQuestion) { score += 0.15; reasons.push('closed question'); }
  if (backchannel === 'ack') { score += 0.2; reasons.push('acknowledging backchannel'); }
  if (trailingConjunction) { score -= 0.4; reasons.push(`trailing conjunction "${trailingConjunction}"`); }
  if (isOpenQuestion) { score -= 0.15; reasons.push('open question — user may keep talking'); }
  if (backchannel === 'continue') { score -= 0.25; reasons.push('continuing backchannel'); }
  if (fillerDensity >= 0.3) { score -= 0.25; reasons.push(`high filler density ${fillerDensity.toFixed(2)}`); }
  else if (fillerCount > 0) { score -= 0.08; reasons.push('some filler'); }
  if (isFillerOnly) { score -= 0.3; reasons.push('filler only'); }
  if (!hasTerminalPunct && clauses.length > 1 && lastClauseWords.length < 2) {
    score -= 0.15; reasons.push('ends inside a clause');
  }
  if (words.length <= 2 && !hasTerminalPunct && backchannel === 'none') {
    score -= 0.1; reasons.push('very short, no punctuation');
  }
  score = Math.max(0, Math.min(1, score));

  let classification: SmartTurnV15Class;
  let decision: SmartTurnV15Decision;
  let recommendedWaitMs = opts.baseSilenceMs;
  if (isFillerOnly) {
    classification = 'filler-only';
    decision = 'continue';
    recommendedWaitMs = opts.baseSilenceMs + opts.thinkingExtraMs;
  } else if (backchannel === 'ack' && score >= opts.endThreshold) {
    classification = 'backchannel-ack';
    decision = 'end';
  } else if (backchannel === 'continue') {
    classification = 'backchannel-continue';
    decision = 'continue';
    recommendedWaitMs = opts.baseSilenceMs + opts.thinkingExtraMs;
  } else if (score >= opts.endThreshold) {
    classification = 'complete';
    decision = 'end';
    if (isOpenQuestion) recommendedWaitMs = opts.baseSilenceMs + opts.openQuestionExtraMs;
  } else if (score < opts.floorThreshold) {
    classification = 'incomplete';
    decision = 'continue';
    recommendedWaitMs = opts.baseSilenceMs + opts.thinkingExtraMs;
  } else {
    classification = 'thinking-pause';
    decision = 'wait';
    recommendedWaitMs = opts.baseSilenceMs + opts.thinkingExtraMs;
    if (isOpenQuestion) recommendedWaitMs += opts.openQuestionExtraMs;
  }

  return {
    text,
    score,
    decision,
    classification,
    recommendedWaitMs,
    signals: {
      language,
      words: words.length,
      hasTerminalPunct,
      endsAtClauseBoundary,
      trailingConjunction,
      isQuestion,
      isOpenQuestion,
      isClosedQuestion,
      hasFinalMarker,
      fillerCount,
      fillerDensity,
      backchannel,
      isFillerOnly,
    },
    reasons,
  };
}

export interface SmartTurnV15DetectorEvent {
  kind: 'end' | 'wait' | 'continue';
  atMs: number;
  text: string;
  score: number;
  classification: SmartTurnV15Class;
}

export type SmartTurnV15DetectorSink = (event: SmartTurnV15DetectorEvent) => void;

export interface SmartTurnV15DetectorStats {
  partials: number;
  ends: number;
  waits: number;
  continues: number;
  falseEndSaves: number;
  lastScore: number;
}

/**
 * Stateful detector: feed partial transcripts + silence durations;
 * it releases the turn only when the score says "done" *and* the
 * silence has passed the score-dependent wait. A "thinking-pause"
 * (score in the middle band) extends the wait instead of ending.
 * `falseEndSaves` counts turns where silence alone would have ended
 * the turn but the score held it — the metric that proves semantic
 * detection is doing its job.
 */
export class SmartTurnDetectorV15 {
  private readonly options: Required<SmartTurnV15Options>;
  private readonly sink: SmartTurnV15DetectorSink | undefined;
  private currentText = '';
  private lastScore: SmartTurnV15Score | undefined;
  private silenceMs = 0;
  private ended = false;
  private partials = 0;
  private ends = 0;
  private waits = 0;
  private continues = 0;
  private falseEndSaves = 0;

  constructor(options: SmartTurnV15Options = {}, sink?: SmartTurnV15DetectorSink) {
    const merged = options.sensitivity !== undefined && options.endThreshold === undefined
      ? { ...sensitivityPresetV15(options.sensitivity), ...options }
      : { ...defaultSmartTurnV15Options(), ...options };
    const errors = validateSmartTurnV15Options(merged);
    if (errors.length > 0) throw new Error(`invalid smart-turn options: ${errors.join('; ')}`);
    this.options = merged as Required<SmartTurnV15Options>;
    this.sink = sink;
  }

  feedPartial(text: string, atMs: number): SmartTurnV15Score {
    this.currentText = text;
    this.silenceMs = 0;
    this.partials += 1;
    const score = scoreTurnCompletenessV15(text, this.options);
    this.lastScore = score;
    if (score.decision === 'wait') this.waits += 1;
    if (score.decision === 'continue') this.continues += 1;
    return score;
  }

  /**
   * Feed `ms` of silence. Returns the event when the turn ends, or
   * undefined while the detector is still holding / waiting.
   */
  feedSilence(ms: number, atMs: number): SmartTurnV15DetectorEvent | undefined {
    if (this.ended || !this.lastScore) return undefined;
    this.silenceMs += ms;
    const score = this.lastScore;
    if (score.decision === 'continue' || score.score < this.options.floorThreshold) {
      // Silence alone never ends a turn the words say is unfinished.
      if (this.silenceMs >= this.options.baseSilenceMs) this.falseEndSaves += 1;
      return undefined;
    }
    if (this.silenceMs >= score.recommendedWaitMs) {
      this.ended = true;
      this.ends += 1;
      const event: SmartTurnV15DetectorEvent = {
        kind: 'end', atMs, text: this.currentText, score: score.score, classification: score.classification,
      };
      this.sink?.(event);
      return event;
    }
    return undefined;
  }

  /** Force-end (push-to-talk / explicit submit). */
  forceEnd(atMs: number): SmartTurnV15DetectorEvent | undefined {
    if (this.ended || !this.lastScore) return undefined;
    this.ended = true;
    this.ends += 1;
    const event: SmartTurnV15DetectorEvent = {
      kind: 'end', atMs, text: this.currentText, score: this.lastScore.score, classification: this.lastScore.classification,
    };
    this.sink?.(event);
    return event;
  }

  reset(): void {
    this.currentText = '';
    this.lastScore = undefined;
    this.silenceMs = 0;
    this.ended = false;
  }

  isEnded(): boolean {
    return this.ended;
  }

  stats(): SmartTurnV15DetectorStats {
    return {
      partials: this.partials,
      ends: this.ends,
      waits: this.waits,
      continues: this.continues,
      falseEndSaves: this.falseEndSaves,
      lastScore: this.lastScore?.score ?? 0,
    };
  }

  summary(): string {
    const s = this.stats();
    return `smart-turn v15: ${s.partials} partials, ${s.ends} ends, ${s.waits} waits, ${s.continues} continues, ${s.falseEndSaves} false-end saves`;
  }

  markdown(): string {
    const s = this.stats();
    return [
      '## Semantic turn-taking v15',
      '',
      `- Partials scored: ${s.partials}; turns ended: ${s.ends}`,
      `- Waits (thinking-pause): ${s.waits}; continues: ${s.continues}`,
      `- False-end saves (silence alone would have cut, words held the turn): ${s.falseEndSaves}`,
      `- Last score: ${s.lastScore.toFixed(2)} (end ≥ ${this.options.endThreshold}, floor ${this.options.floorThreshold})`,
      `- Sensitivity: \`${this.options.sensitivity}\`, language: \`${this.options.language}\``,
      '',
    ].join('\n');
  }
}

export function createSmartTurnDetectorV15(
  options: SmartTurnV15Options = {},
  sink?: SmartTurnV15DetectorSink,
): SmartTurnDetectorV15 {
  return new SmartTurnDetectorV15(options, sink);
}

export function smartTurnV15Summary(detector: SmartTurnDetectorV15): string {
  return detector.summary();
}

export function smartTurnV15Markdown(detector: SmartTurnDetectorV15): string {
  return detector.markdown();
}
