/**
 * Wake word v2 (v1.15, Đội T5 — voice realtime v14).
 *
 * v13 listens for one keyword list with one shared threshold
 * and one shared cooldown, and a match wakes the session
 * immediately. Two gaps remain:
 *
 *   1. False positives: a transcript that *sounds like* the
 *      keyword ("hey bot" inside "they bought a boat") wakes
 *      the session even though nobody spoke to it. v14 adds
 *      false-positive suppression: a keyword hit only becomes
 *      an activation after a *VAD confirmation* — real speech
 *      continuing after the wake word within a confirmation
 *      window — plus a near-miss list (phrases that look like
 *      the keyword but are not) and a per-word minimum
 *      confidence.
 *   2. One size fits all: "hey bot" (short, easy to confuse)
 *      and "này open bot ơi" (long, distinctive) need
 *      different thresholds and cooldowns. v14 gives every
 *      wake word its own config: threshold, cooldown,
 *      confirmation window, and whether it needs VAD
 *      confirmation at all.
 *
 * State machine per detector:
 *
 *   asleep ──▶ keyword hit ──▶ pending-confirm (waiting for
 *              VAD speech within `confirmWindowMs`)
 *              ├─ speech arrives ──▶ active (activation)
 *              └─ window expires ──▶ asleep (suppressed:
 *                 counted as a false positive, not a wake)
 *
 * The detector still works on the host's partial transcript
 * (same as v13) and reuses the v13 mock engine per keyword
 * set; the host feeds VAD speech with `noteVadSpeech()`.
 *
 * Test-set evaluation: `evaluateWakeWordV14` runs the
 * detector over labelled samples
 * (`{ transcript, expectedKeyword | null, vadSpeechMs }`) and
 * reports TP / FP / FN / TN plus the false-accept rate (FP /
 * all non-wake samples) and false-reject rate (FN / all wake
 * samples), per keyword and overall — the number the panel
 * shows for "how often does it wake by mistake".
 */

import {
  MockWakeWordEngineV13,
  foldDiacriticsV13,
  type WakeWordV13Activation,
} from './wakeWordV13';

/** Per-wake-word config. */
export interface WakeWordV14WordConfig {
  /** The keyword phrase (e.g. 'hey bot'). */
  keyword: string;
  /** Minimum confidence to accept a hit (default 0.5). */
  minConfidence?: number;
  /** Cooldown (ms) after an activation of this word (default 3000). */
  cooldownMs?: number;
  /** True when a VAD confirmation is required after the hit (default true). */
  requireVadConfirm?: boolean;
  /** Window (ms) the VAD confirmation must arrive in (default 2000). */
  confirmWindowMs?: number;
}

/** A validated per-word config (all fields filled). */
export type WakeWordV14WordConfigResolved = Required<WakeWordV14WordConfig>;

/** Phrases that sound like a keyword but are not a wake. */
export interface WakeWordV14NearMiss {
  phrase: string;
  /** The keyword this phrase is confused with. */
  confusedWith: string;
}

/** Options for `WakeWordDetectorV14`. */
export interface WakeWordV14Options {
  /** Wake words with per-word config (default [{ keyword: 'hey bot' }]). */
  words?: WakeWordV14WordConfig[];
  /** Fold Vietnamese diacritics before matching (default true). */
  foldDiacritics?: boolean;
  /** Require word boundaries around a keyword (default true). */
  requireWordBoundary?: boolean;
  /** Sleep again after this long without user speech (ms, default 60000; 0 = never). */
  autoSleepMs?: number;
  /** Start asleep (default true). */
  startAsleep?: boolean;
  /** Near-miss phrases that suppress a wake (default []). */
  nearMisses?: WakeWordV14NearMiss[];
  /** Default confirmation window (ms) when a word config omits it (default 2000). */
  defaultConfirmWindowMs?: number;
}

/** Detector state. */
export type WakeWordV14State = 'asleep' | 'pending-confirm' | 'active' | 'cooldown';

/** One activation (extends the v13 activation with the word config + confirmation). */
export interface WakeWordV14Activation extends WakeWordV13Activation {
  /** Ms between the keyword hit and the VAD confirmation (0 when no confirmation was required). */
  confirmMs: number;
  /** True when the activation needed (and got) a VAD confirmation. */
  vadConfirmed: boolean;
}

/** One suppressed (false-positive) hit. */
export interface WakeWordV14Suppressed {
  keyword: string;
  confidence: number;
  atMs: number;
  transcript: string;
  /** Why it was suppressed. */
  reason: 'no-vad-confirmation' | 'near-miss' | 'low-confidence' | 'cooldown';
}

/** Counters for one detector. */
export interface WakeWordV14Stats {
  state: WakeWordV14State;
  activations: number;
  /** Keyword hits suppressed as false positives. */
  suppressed: number;
  /** Hits refused by cooldown. */
  refused: number;
  checked: number;
  /** Activations that needed a VAD confirmation. */
  vadConfirmedActivations: number;
  /** Per-keyword activations. */
  byKeyword: Record<string, number>;
  /** Per-keyword suppressions. */
  suppressedByKeyword: Record<string, number>;
  lastActivation: WakeWordV14Activation | null;
  words: string[];
  history: number;
}

/** Events emitted by the detector. */
export type WakeWordV14Event =
  | { kind: 'activated'; activation: WakeWordV14Activation }
  | { kind: 'pending-confirm'; atMs: number; keyword: string; confidence: number }
  | { kind: 'suppressed'; suppressed: WakeWordV14Suppressed }
  | { kind: 'refused'; atMs: number; keyword: string; confidence: number; reason: string }
  | { kind: 'slept'; atMs: number; reason: string }
  | { kind: 'words-changed'; words: string[]; atMs: number };

export type WakeWordV14EventSink = (event: WakeWordV14Event) => void;

/** One labelled sample for the test-set evaluator. */
export interface WakeWordV14TestSample {
  /** Transcript to feed. */
  transcript: string;
  /** Keyword expected to wake, or null when the sample must NOT wake. */
  expectedKeyword: string | null;
  /** VAD speech ms after the transcript (0 = no speech follows). */
  vadSpeechMs?: number;
  /** Virtual time (ms) of the sample. */
  atMs: number;
}

/** Evaluation result for one keyword (or overall). */
export interface WakeWordV14EvalResult {
  keyword: string;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** False-accept rate: FP / (FP + TN), 0 when no non-wake samples. */
  falseAcceptRate: number;
  /** False-reject rate: FN / (FN + TP), 0 when no wake samples. */
  falseRejectRate: number;
  /** Accuracy: (TP + TN) / all. */
  accuracy: number;
  samples: number;
}

/** Full test-set evaluation. */
export interface WakeWordV14Evaluation {
  overall: WakeWordV14EvalResult;
  perKeyword: WakeWordV14EvalResult[];
  samples: number;
}

export const WAKE_WORD_V14_DEFAULT_WORDS: readonly WakeWordV14WordConfig[] = [
  { keyword: 'hey bot' },
];

export function defaultWakeWordV14WordConfig(keyword: string): WakeWordV14WordConfigResolved {
  return {
    keyword,
    minConfidence: 0.5,
    cooldownMs: 3000,
    requireVadConfirm: true,
    confirmWindowMs: 2000,
  };
}

export function defaultWakeWordV14Options(): Required<Omit<WakeWordV14Options, 'words' | 'nearMisses'>> & {
  words: WakeWordV14WordConfig[];
  nearMisses: WakeWordV14NearMiss[];
} {
  return {
    words: WAKE_WORD_V14_DEFAULT_WORDS.map((w) => ({ ...w })),
    foldDiacritics: true,
    requireWordBoundary: true,
    autoSleepMs: 60000,
    startAsleep: true,
    nearMisses: [],
    defaultConfirmWindowMs: 2000,
  };
}

export function validateWakeWordV14WordConfig(
  word: WakeWordV14WordConfig,
  defaultConfirmWindowMs = 2000,
): WakeWordV14WordConfigResolved {
  if (typeof word.keyword !== 'string' || !word.keyword.trim()) {
    throw new Error('Wake word v14 keyword must be a non-empty string.');
  }
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Wake word v14 ${name} for "${word.keyword}" must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    keyword: word.keyword.trim(),
    minConfidence: num(word.minConfidence, 0.5, 'minConfidence', 0, 1),
    cooldownMs: Math.floor(num(word.cooldownMs, 3000, 'cooldownMs', 0, 600000)),
    requireVadConfirm: word.requireVadConfirm ?? true,
    confirmWindowMs: Math.floor(num(word.confirmWindowMs, defaultConfirmWindowMs, 'confirmWindowMs', 0, 60000)),
  };
}

export function validateWakeWordV14Options(options: WakeWordV14Options): Required<Omit<WakeWordV14Options, 'words' | 'nearMisses'>> & {
  words: WakeWordV14WordConfigResolved[];
  nearMisses: WakeWordV14NearMiss[];
} {
  const base = defaultWakeWordV14Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Wake word v14 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  const defaultConfirmWindowMs = Math.floor(num(options.defaultConfirmWindowMs, base.defaultConfirmWindowMs, 'defaultConfirmWindowMs', 0, 60000));
  let words: WakeWordV14WordConfigResolved[] = base.words.map((w) => validateWakeWordV14WordConfig(w, defaultConfirmWindowMs));
  if (options.words !== undefined) {
    if (!Array.isArray(options.words) || options.words.length === 0) {
      throw new Error('Wake word v14 words must be a non-empty array of word configs.');
    }
    words = options.words.map((w) => validateWakeWordV14WordConfig(w, defaultConfirmWindowMs));
    const lowered = words.map((w) => w.keyword.toLowerCase());
    if (new Set(lowered).size !== lowered.length) {
      throw new Error('Wake word v14 keywords must be unique (case-insensitive).');
    }
  }
  let nearMisses: WakeWordV14NearMiss[] = [];
  if (options.nearMisses !== undefined) {
    if (!Array.isArray(options.nearMisses)) {
      throw new Error('Wake word v14 nearMisses must be an array.');
    }
    nearMisses = options.nearMisses.map((n) => {
      if (typeof n.phrase !== 'string' || !n.phrase.trim() || typeof n.confusedWith !== 'string' || !n.confusedWith.trim()) {
        throw new Error('Wake word v14 near-miss needs a non-empty phrase and confusedWith.');
      }
      return { phrase: n.phrase.trim(), confusedWith: n.confusedWith.trim() };
    });
  }
  return {
    words,
    foldDiacritics: options.foldDiacritics ?? base.foldDiacritics,
    requireWordBoundary: options.requireWordBoundary ?? base.requireWordBoundary,
    autoSleepMs: Math.floor(num(options.autoSleepMs, base.autoSleepMs, 'autoSleepMs', 0, 3600000)),
    startAsleep: options.startAsleep ?? base.startAsleep,
    nearMisses,
    defaultConfirmWindowMs,
  };
}

function normaliseForNearMissV14(text: string, fold: boolean): string {
  const lowered = text.trim().replace(/\s+/g, ' ');
  return fold ? foldDiacriticsV13(lowered) : lowered.toLowerCase();
}

/**
 * Wake-word detector v2: per-word config, VAD confirmation
 * and near-miss suppression. The host feeds partial
 * transcripts (`noteTranscript`) and VAD speech
 * (`noteVadSpeech`); `tick(atMs)` expires pending
 * confirmations and applies auto-sleep.
 */
export class WakeWordDetectorV14 {
  private readonly options: Required<Omit<WakeWordV14Options, 'words' | 'nearMisses'>> & {
    words: WakeWordV14WordConfigResolved[];
    nearMisses: WakeWordV14NearMiss[];
  };
  private readonly sink: WakeWordV14EventSink | null;
  private readonly engine: MockWakeWordEngineV13;
  private words: WakeWordV14WordConfigResolved[];
  private state: WakeWordV14State;
  private pending: { word: WakeWordV14WordConfigResolved; confidence: number; atMs: number; transcript: string } | null = null;
  private lastActivationAtMs: number | null = null;
  private lastActivationWord: string | null = null;
  private lastSpeechAtMs: number | null = null;
  private nextId = 1;
  private history: WakeWordV14Activation[] = [];
  private suppressedList: WakeWordV14Suppressed[] = [];
  private checked = 0;
  private refused = 0;
  private vadConfirmedActivations = 0;

  constructor(options: WakeWordV14Options = {}, sink: WakeWordV14EventSink | null = null) {
    this.options = validateWakeWordV14Options(options);
    this.sink = sink;
    this.words = [...this.options.words];
    this.engine = new MockWakeWordEngineV13({
      keywords: this.words.map((w) => w.keyword),
      foldDiacritics: this.options.foldDiacritics,
      requireWordBoundary: this.options.requireWordBoundary,
    });
    this.state = this.options.startAsleep ? 'asleep' : 'active';
  }

  getState(): WakeWordV14State {
    return this.state;
  }

  isActive(): boolean {
    return this.state === 'active';
  }

  getWords(): WakeWordV14WordConfigResolved[] {
    return this.words.map((w) => ({ ...w }));
  }

  getKeywords(): string[] {
    return this.words.map((w) => w.keyword);
  }

  /** Replace the word list (per-word configs). */
  setWords(words: WakeWordV14WordConfig[], atMs = 0): void {
    const validated = validateWakeWordV14Options({ ...this.options, words });
    this.words = [...validated.words];
    this.engine.setKeywords(this.words.map((w) => w.keyword));
    this.pending = null;
    if (this.state === 'pending-confirm') this.state = 'asleep';
    this.sink?.({ kind: 'words-changed', words: this.getKeywords(), atMs });
  }

  /** Change one word's config (by keyword). Returns false when the word is unknown. */
  setWordConfig(keyword: string, patch: Omit<WakeWordV14WordConfig, 'keyword'>, atMs = 0): boolean {
    const index = this.words.findIndex((w) => w.keyword.toLowerCase() === keyword.toLowerCase());
    if (index === -1) return false;
    const merged = validateWakeWordV14WordConfig(
      { ...(this.words[index] as WakeWordV14WordConfigResolved), ...patch },
      this.options.defaultConfirmWindowMs,
    );
    this.words[index] = merged;
    this.sink?.({ kind: 'words-changed', words: this.getKeywords(), atMs });
    return true;
  }

  private wordConfig(keyword: string): WakeWordV14WordConfigResolved | undefined {
    return this.words.find((w) => w.keyword.toLowerCase() === keyword.toLowerCase());
  }

  private isNearMiss(transcript: string, keyword: string): boolean {
    const haystack = normaliseForNearMissV14(transcript, this.options.foldDiacritics);
    for (const miss of this.options.nearMisses) {
      if (miss.confusedWith.toLowerCase() !== keyword.toLowerCase()) continue;
      const needle = normaliseForNearMissV14(miss.phrase, this.options.foldDiacritics);
      if (needle && haystack.includes(needle)) return true;
    }
    return false;
  }

  private suppress(keyword: string, confidence: number, atMs: number, transcript: string, reason: WakeWordV14Suppressed['reason']): void {
    const entry: WakeWordV14Suppressed = { keyword, confidence, atMs, transcript: transcript.trim(), reason };
    this.suppressedList.push(entry);
    if (this.suppressedList.length > 100) this.suppressedList.splice(0, this.suppressedList.length - 100);
    this.sink?.({ kind: 'suppressed', suppressed: { ...entry } });
  }

  private activate(word: WakeWordV14WordConfigResolved, confidence: number, atMs: number, transcript: string, confirmMs: number, vadConfirmed: boolean): WakeWordV14Activation {
    const activation: WakeWordV14Activation = {
      id: this.nextId,
      keyword: word.keyword,
      confidence,
      atMs,
      transcript: transcript.trim(),
      confirmMs,
      vadConfirmed,
    };
    this.nextId += 1;
    this.history.push(activation);
    if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
    this.lastActivationAtMs = atMs;
    this.lastActivationWord = word.keyword;
    if (vadConfirmed) this.vadConfirmedActivations += 1;
    this.state = 'active';
    this.pending = null;
    this.sink?.({ kind: 'activated', activation: { ...activation } });
    return { ...activation };
  }

  /**
   * Feed a partial transcript. Returns the activation when a
   * keyword hit wakes the detector (immediately, or after a
   * VAD confirmation arrives via `noteVadSpeech`), or null.
   * While `active`, transcripts never re-trigger; while
   * `pending-confirm`, a second keyword hit refreshes the
   * pending word instead of stacking.
   */
  noteTranscript(transcript: string, atMs: number): WakeWordV14Activation | null {
    this.checked += 1;
    if (typeof transcript === 'string' && transcript.trim()) this.lastSpeechAtMs = atMs;
    if (this.state === 'active') return null;
    if (!this.engine.isReady()) return null;
    const match = this.engine.detect(transcript, atMs);
    if (!match.matched) return null;
    const word = this.wordConfig(match.keyword);
    if (!word) return null;
    if (this.isNearMiss(transcript, match.keyword)) {
      this.suppress(match.keyword, match.confidence, atMs, transcript, 'near-miss');
      return null;
    }
    if (match.confidence < word.minConfidence) {
      this.suppress(match.keyword, match.confidence, atMs, transcript, 'low-confidence');
      return null;
    }
    if (
      this.lastActivationAtMs !== null &&
      this.lastActivationWord?.toLowerCase() === match.keyword.toLowerCase() &&
      atMs - this.lastActivationAtMs < word.cooldownMs
    ) {
      this.refused += 1;
      this.sink?.({ kind: 'refused', atMs, keyword: match.keyword, confidence: match.confidence, reason: `in cooldown (${atMs - this.lastActivationAtMs} ms since the last "${match.keyword}" activation)` });
      return null;
    }
    if (!word.requireVadConfirm) {
      return this.activate(word, match.confidence, atMs, transcript, 0, false);
    }
    // Wait for VAD confirmation: real speech after the wake word.
    this.pending = { word, confidence: match.confidence, atMs, transcript };
    this.state = 'pending-confirm';
    this.sink?.({ kind: 'pending-confirm', atMs, keyword: match.keyword, confidence: match.confidence });
    return null;
  }

  /**
   * Feed VAD speech (ms of speech heard at `atMs`). When a
   * confirmation is pending and the speech arrives inside the
   * window, the pending hit becomes an activation.
   */
  noteVadSpeech(ms: number, atMs: number): WakeWordV14Activation | null {
    if (ms > 0) this.lastSpeechAtMs = atMs;
    if (this.state !== 'pending-confirm' || !this.pending) return null;
    if (ms <= 0) return null;
    const pending = this.pending;
    if (atMs - pending.atMs > pending.word.confirmWindowMs) {
      // Too late: the window already expired (tick() would
      // have suppressed it — suppress here for determinism).
      this.suppress(pending.word.keyword, pending.confidence, atMs, pending.transcript, 'no-vad-confirmation');
      this.pending = null;
      this.state = 'asleep';
      return null;
    }
    return this.activate(pending.word, pending.confidence, atMs, pending.transcript, atMs - pending.atMs, true);
  }

  /** Put the detector back to sleep (explicit). */
  sleep(atMs: number, reason = 'explicit'): void {
    if (this.state === 'asleep') return;
    this.pending = null;
    this.state = 'asleep';
    this.sink?.({ kind: 'slept', atMs, reason });
  }

  /** Enter cooldown explicitly (used after an activation the host handled). */
  enterCooldown(atMs: number): void {
    this.state = 'cooldown';
    this.lastActivationAtMs = atMs;
  }

  /**
   * Advance the clock: expire a pending confirmation (the hit
   * becomes a suppressed false positive), end the cooldown,
   * and auto-sleep after `autoSleepMs` without user speech.
   */
  tick(atMs: number): void {
    if (this.state === 'pending-confirm' && this.pending && atMs - this.pending.atMs > this.pending.word.confirmWindowMs) {
      this.suppress(this.pending.word.keyword, this.pending.confidence, atMs, this.pending.transcript, 'no-vad-confirmation');
      this.pending = null;
      this.state = 'asleep';
    }
    if (this.state === 'cooldown' && this.lastActivationAtMs !== null && this.lastActivationWord !== null) {
      const word = this.wordConfig(this.lastActivationWord);
      const cooldownMs = word ? word.cooldownMs : 3000;
      if (atMs - this.lastActivationAtMs >= cooldownMs) this.state = 'asleep';
    }
    if (this.state === 'active' && this.options.autoSleepMs > 0 && this.lastSpeechAtMs !== null && atMs - this.lastSpeechAtMs >= this.options.autoSleepMs) {
      this.sleep(atMs, 'auto-sleep: no user speech');
    }
  }

  /** Activation history, oldest first (copies). */
  getHistory(): WakeWordV14Activation[] {
    return this.history.map((a) => ({ ...a }));
  }

  /** Suppressed (false-positive) hits, oldest first (copies). */
  getSuppressed(): WakeWordV14Suppressed[] {
    return this.suppressedList.map((s) => ({ ...s }));
  }

  getStats(): WakeWordV14Stats {
    const byKeyword: Record<string, number> = {};
    const suppressedByKeyword: Record<string, number> = {};
    for (const word of this.words) {
      byKeyword[word.keyword] = 0;
      suppressedByKeyword[word.keyword] = 0;
    }
    for (const a of this.history) byKeyword[a.keyword] = (byKeyword[a.keyword] ?? 0) + 1;
    for (const s of this.suppressedList) suppressedByKeyword[s.keyword] = (suppressedByKeyword[s.keyword] ?? 0) + 1;
    return {
      state: this.state,
      activations: this.history.length,
      suppressed: this.suppressedList.length,
      refused: this.refused,
      checked: this.checked,
      vadConfirmedActivations: this.vadConfirmedActivations,
      byKeyword,
      suppressedByKeyword,
      lastActivation: this.history.length > 0 ? { ...(this.history[this.history.length - 1] as WakeWordV14Activation) } : null,
      words: this.getKeywords(),
      history: this.history.length,
    };
  }

  reset(): void {
    this.state = this.options.startAsleep ? 'asleep' : 'active';
    this.pending = null;
    this.lastActivationAtMs = null;
    this.lastActivationWord = null;
    this.lastSpeechAtMs = null;
    this.nextId = 1;
    this.history = [];
    this.suppressedList = [];
    this.checked = 0;
    this.refused = 0;
    this.vadConfirmedActivations = 0;
  }
}

/** Create a wake-word detector v2 (factory). */
export function createWakeWordDetectorV14(
  options: WakeWordV14Options = {},
  sink: WakeWordV14EventSink | null = null,
): WakeWordDetectorV14 {
  return new WakeWordDetectorV14(options, sink);
}

function evalResultV14(keyword: string, tp: number, fp: number, fn: number, tn: number): WakeWordV14EvalResult {
  const total = tp + fp + fn + tn;
  return {
    keyword,
    tp,
    fp,
    fn,
    tn,
    falseAcceptRate: fp + tn === 0 ? 0 : Math.round((fp / (fp + tn)) * 1000) / 1000,
    falseRejectRate: fn + tp === 0 ? 0 : Math.round((fn / (fn + tp)) * 1000) / 1000,
    accuracy: total === 0 ? 0 : Math.round(((tp + tn) / total) * 1000) / 1000,
    samples: total,
  };
}

/**
 * Evaluate a wake-word detector over a labelled test set.
 * Each sample runs on a fresh detector (same options), so
 * samples are independent: the transcript is fed, then VAD
 * speech (`vadSpeechMs`) is fed 300 ms later when given.
 * Returns overall + per-keyword TP/FP/FN/TN, false-accept
 * rate and false-reject rate. Pure w.r.t. the caller (the
 * detector under test is created inside).
 */
export function evaluateWakeWordV14(
  options: WakeWordV14Options,
  samples: WakeWordV14TestSample[],
): WakeWordV14Evaluation {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('Wake word v14 evaluation needs a non-empty array of test samples.');
  }
  const keywords = (options.words ?? WAKE_WORD_V14_DEFAULT_WORDS).map((w) => w.keyword);
  const perKeyword = new Map<string, { tp: number; fp: number; fn: number; tn: number }>();
  for (const keyword of keywords) perKeyword.set(keyword, { tp: 0, fp: 0, fn: 0, tn: 0 });
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const sample of samples) {
    const detector = new WakeWordDetectorV14({ ...options, startAsleep: true });
    const activation = detector.noteTranscript(sample.transcript, sample.atMs);
    let final: WakeWordV14Activation | null = activation;
    if (!final && sample.vadSpeechMs !== undefined && sample.vadSpeechMs > 0) {
      final = detector.noteVadSpeech(sample.vadSpeechMs, sample.atMs + 300);
    }
    const expected = sample.expectedKeyword;
    if (expected === null) {
      if (final) {
        fp += 1;
        const bucket = perKeyword.get(final.keyword);
        if (bucket) bucket.fp += 1;
      } else {
        tn += 1;
      }
    } else {
      const bucket = perKeyword.get(expected) ?? { tp: 0, fp: 0, fn: 0, tn: 0 };
      perKeyword.set(expected, bucket);
      if (final && final.keyword.toLowerCase() === expected.toLowerCase()) {
        tp += 1;
        bucket.tp += 1;
      } else {
        fn += 1;
        bucket.fn += 1;
        if (final) {
          // Woke on the wrong word: a false accept for that word.
          const wrong = perKeyword.get(final.keyword);
          if (wrong) wrong.fp += 1;
        }
      }
      // Non-wake keywords get a true negative for this sample
      // only when nothing woke; counted in the overall TN path
      // above, not per keyword (keeps per-keyword FAR honest).
    }
  }
  // Per-keyword TN: samples that expected another keyword (or
  // none) and did not wake on this keyword.
  for (const [keyword, bucket] of perKeyword) {
    const nonWakeSamples = samples.filter((s) => s.expectedKeyword?.toLowerCase() !== keyword.toLowerCase()).length;
    const fpForKeyword = bucket.fp;
    bucket.tn = Math.max(0, nonWakeSamples - fpForKeyword);
  }
  return {
    overall: evalResultV14('overall', tp, fp, fn, tn),
    perKeyword: [...perKeyword.entries()].map(([keyword, b]) => evalResultV14(keyword, b.tp, b.fp, b.fn, b.tn)),
    samples: samples.length,
  };
}

/** One-line summary of wake-word v2 stats. */
export function wakeWordV14Summary(stats: WakeWordV14Stats): string {
  return (
    `Wake word v14: ${stats.state}, ${stats.activations} activations ` +
    `(${stats.vadConfirmedActivations} VAD-confirmed), ${stats.suppressed} suppressed false positives, ` +
    `${stats.refused} refused, ${stats.checked} transcripts checked, ` +
    `words: ${stats.words.join(', ')}`
  );
}

/** Wake-word v2 stats as Markdown (for the diagnostics panel). */
export function wakeWordV14Markdown(stats: WakeWordV14Stats): string {
  const lines = [
    '## Wake word v14 (multi-word + false-positive suppression)',
    '',
    `- state: ${stats.state}, words: ${stats.words.join(', ')}`,
    `- activations: ${stats.activations} (${stats.vadConfirmedActivations} VAD-confirmed), suppressed: ${stats.suppressed}, refused: ${stats.refused}, checked: ${stats.checked}`,
    `- by keyword: ${Object.entries(stats.byKeyword).map(([k, v]) => `"${k}": ${v}`).join(', ')}`,
    `- suppressed by keyword: ${Object.entries(stats.suppressedByKeyword).map(([k, v]) => `"${k}": ${v}`).join(', ')}`,
    `- last activation: ${stats.lastActivation ? `"${stats.lastActivation.keyword}" at ${stats.lastActivation.atMs} ms (confidence ${stats.lastActivation.confidence}, confirm ${stats.lastActivation.confirmMs} ms)` : '-'}`,
  ];
  return lines.join('\n');
}

/** Evaluation as Markdown (for the diagnostics panel). */
export function wakeWordV14EvaluationMarkdown(evaluation: WakeWordV14Evaluation): string {
  const lines = [
    '## Wake word v14 evaluation',
    '',
    `- samples: ${evaluation.samples}, accuracy: ${evaluation.overall.accuracy}, ` +
      `false-accept rate: ${evaluation.overall.falseAcceptRate}, false-reject rate: ${evaluation.overall.falseRejectRate}`,
    `- TP ${evaluation.overall.tp}, FP ${evaluation.overall.fp}, FN ${evaluation.overall.fn}, TN ${evaluation.overall.tn}`,
    '',
    '| keyword | TP | FP | FN | TN | false-accept | false-reject | accuracy |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of evaluation.perKeyword) {
    lines.push(
      `| ${r.keyword} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.tn} | ${r.falseAcceptRate} | ${r.falseRejectRate} | ${r.accuracy} |`,
    );
  }
  return lines.join('\n');
}
