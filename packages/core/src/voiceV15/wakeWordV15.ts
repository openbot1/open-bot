/**
 * Wake word detection v3 (v1.16, Đội T5 — voice v15).
 *
 * The bot should wake when the user calls it — and *only* then.
 * A false accept in a meeting ("hey, did you see the *open bot*…")
 * is embarrassing; a false reject ("hey bot… hey bot… HEY BOT")
 * is infuriating. v14 added per-word configs, pending-confirm and
 * per-word cooldowns. v15 adds the guards that decide whether a
 * match is real:
 *
 *   - multi-word registry: several wake words per bot ("hey bot",
 *     "này bot", "open bot", a custom name), each with its own
 *     sensitivity, language and cooldown;
 *   - sensitivity presets (`low` / `balanced` / `high`) that map to
 *     a match threshold: `high` accepts near-misses (one edit away),
 *     `low` demands an exact phrase;
 *   - near-miss suppression: a transcript that is one edit away
 *     from a wake word *and* below the word's sensitivity is
 *     suppressed, not activated;
 *   - energy gate: a match in a near-silent frame (a transcript
 *     hallucinated from noise) is suppressed;
 *   - confirmation window: after a match, the detector waits
 *     `confirmMs` for continued speech (the user actually talking
 *     to the bot, not just mentioning it); if nothing follows, the
 *     activation expires instead of waking the bot;
 *   - per-word cooldown + global cooldown: one activation cannot
 *     re-trigger itself from its own echo;
 *   - labelled test-set evaluation: TP / FP / FN / TN, false-accept
 *     rate and false-reject rate, so a sensitivity change can be
 *     measured instead of guessed.
 *
 * Input is transcript text + frame energy (the STT layer's job);
 * there is no audio model here, so the detector is pure text +
 * numbers and fully testable with scripted transcripts.
 */

export type WakeWordV15Sensitivity = 'low' | 'balanced' | 'high';
export const WAKE_WORD_V15_SENSITIVITIES: readonly WakeWordV15Sensitivity[] = ['low', 'balanced', 'high'];

export interface WakeWordV15Config {
  word: string;
  language: string;
  sensitivity: WakeWordV15Sensitivity;
  /** Minimum frame RMS for a match to count (noise-hallucination guard). */
  minEnergy: number;
  /** ms after an activation before the same word may fire again. */
  cooldownMs: number;
  /** ms to wait for follow-up speech before the activation expires. */
  confirmMs: number;
  enabled: boolean;
}

export const WAKE_WORD_V15_DEFAULT_WORDS: readonly string[] = ['hey bot', 'này bot', 'open bot'];

export function defaultWakeWordV15Config(word: string): WakeWordV15Config {
  return {
    word,
    language: 'vi',
    sensitivity: 'balanced',
    minEnergy: 0.01,
    cooldownMs: 3000,
    confirmMs: 5000,
    enabled: true,
  };
}

export function sensitivityThresholdV15(sensitivity: WakeWordV15Sensitivity): number {
  switch (sensitivity) {
    case 'low': return 1.0;
    case 'balanced': return 0.8;
    case 'high': return 0.6;
  }
}

export function validateWakeWordV15Config(config: WakeWordV15Config): string[] {
  const errors: string[] = [];
  if (!config.word.trim()) errors.push('word must not be empty');
  if (config.word.trim().length > 40) errors.push('word must be at most 40 characters');
  if (!WAKE_WORD_V15_SENSITIVITIES.includes(config.sensitivity)) errors.push(`unknown sensitivity: ${config.sensitivity}`);
  if (config.minEnergy < 0 || config.minEnergy > 1) errors.push('minEnergy must be 0..1');
  if (config.cooldownMs < 0 || config.cooldownMs > 60000) errors.push('cooldownMs must be 0..60000');
  if (config.confirmMs < 0 || config.confirmMs > 30000) errors.push('confirmMs must be 0..30000');
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(config.language)) errors.push(`language must look like a BCP-47 tag, got ${config.language}`);
  return errors;
}

/** Levenshtein distance (small strings only — wake words are short). */
export function levenshteinV15(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const temp = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = temp;
    }
  }
  return row[n];
}

function normaliseV15(text: string): string {
  return text.toLowerCase().replace(/[.,!?;:…]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Similarity 0..1 of a transcript window against a wake word. */
export function wakeWordSimilarityV15(transcript: string, word: string): number {
  const hay = normaliseV15(transcript);
  const needle = normaliseV15(word);
  if (needle.length === 0) return 0;
  if (hay.includes(needle)) return 1;
  // Best window: slide a needle-length window over the transcript.
  let best = 0;
  const words = hay.split(' ');
  const needleWords = needle.split(' ');
  for (let i = 0; i <= Math.max(0, words.length - needleWords.length); i += 1) {
    const window = words.slice(i, i + needleWords.length).join(' ');
    const dist = levenshteinV15(window, needle);
    const sim = 1 - dist / Math.max(window.length, needle.length);
    if (sim > best) best = sim;
  }
  // Also try the whole (short) transcript.
  if (words.length <= needleWords.length + 1) {
    const dist = levenshteinV15(hay, needle);
    const sim = 1 - dist / Math.max(hay.length, needle.length);
    if (sim > best) best = sim;
  }
  return Math.max(0, best);
}

export type WakeWordV15EventKind = 'activated' | 'suppressed' | 'confirmed' | 'expired';
export type WakeWordV15SuppressReason =
  | 'near-miss'
  | 'low-energy'
  | 'cooldown'
  | 'disabled'
  | 'no-follow-up';

export interface WakeWordV15Event {
  kind: WakeWordV15EventKind;
  atMs: number;
  word: string;
  similarity: number;
  reason?: WakeWordV15SuppressReason;
  transcript?: string;
}

export type WakeWordV15Sink = (event: WakeWordV15Event) => void;

export interface WakeWordV15TestSample {
  transcript: string;
  /** True when the sample really contains a wake word. */
  containsWakeWord: boolean;
  energy?: number;
  word?: string;
}

export interface WakeWordV15Evaluation {
  total: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  falseAcceptRate: number;
  falseRejectRate: number;
  accuracy: number;
}

export interface WakeWordV15Stats {
  activations: number;
  confirmations: number;
  expirations: number;
  suppressions: Partial<Record<WakeWordV15SuppressReason, number>>;
  totalSuppressions: number;
  words: number;
  enabledWords: number;
}

interface PendingActivationV15 {
  word: string;
  atMs: number;
  confirmByMs: number;
}

/**
 * Multi-word detector. `feedTranscript()` is called with each STT
 * final (or confident partial); `tick()` expires pending activations
 * whose confirmation window elapsed without follow-up speech.
 * The bot is *awake* between `activated` and `expired`/sleep; the
 * session decides what "awake" means (open the mic, start a turn).
 */
export class WakeWordDetectorV15 {
  private readonly words = new Map<string, WakeWordV15Config>();
  private readonly sink: WakeWordV15Sink | undefined;
  private readonly lastFired = new Map<string, number>();
  private pending: PendingActivationV15 | undefined;
  private awake = false;
  private activations = 0;
  private confirmations = 0;
  private expirations = 0;
  private readonly suppressions = new Map<WakeWordV15SuppressReason, number>();

  constructor(words: WakeWordV15Config[] = WAKE_WORD_V15_DEFAULT_WORDS.map((w) => defaultWakeWordV15Config(w)), sink?: WakeWordV15Sink) {
    this.sink = sink;
    for (const word of words) this.setWord(word);
  }

  setWord(config: WakeWordV15Config): void {
    const errors = validateWakeWordV15Config(config);
    if (errors.length > 0) throw new Error(`invalid wake-word config: ${errors.join('; ')}`);
    this.words.set(normaliseV15(config.word), { ...config });
  }

  removeWord(word: string): boolean {
    return this.words.delete(normaliseV15(word));
  }

  setWords(configs: WakeWordV15Config[]): void {
    this.words.clear();
    for (const config of configs) this.setWord(config);
  }

  listWords(): WakeWordV15Config[] {
    return [...this.words.values()].sort((a, b) => a.word.localeCompare(b.word));
  }

  isAwake(): boolean {
    return this.awake;
  }

  pendingWord(): string | undefined {
    return this.pending?.word;
  }

  sleep(atMs: number): void {
    this.awake = false;
    this.pending = undefined;
    void atMs;
  }

  /**
   * Feed one transcript. `energy` is the frame RMS (default 1 =
   * "loud enough", i.e. no energy gate). Returns the event fired.
   */
  feedTranscript(transcript: string, atMs: number, energy = 1): WakeWordV15Event | undefined {
    const text = normaliseV15(transcript);
    if (text.length === 0) return undefined;
    // Follow-up speech while a pending activation waits → confirm.
    if (this.pending && !this.isWakeWordOnly(text)) {
      const word = this.pending.word;
      this.pending = undefined;
      this.awake = true;
      this.confirmations += 1;
      const event: WakeWordV15Event = { kind: 'confirmed', atMs, word, similarity: 1, transcript };
      this.sink?.(event);
      return event;
    }
    let best: { config: WakeWordV15Config; similarity: number } | undefined;
    for (const config of this.words.values()) {
      const similarity = wakeWordSimilarityV15(text, config.word);
      if (!best || similarity > best.similarity) best = { config, similarity };
    }
    if (!best || best.similarity < 0.5) return undefined;
    const { config, similarity } = best;
    if (!config.enabled) return this.suppress('disabled', atMs, config.word, similarity, transcript);
    if (energy < config.minEnergy) return this.suppress('low-energy', atMs, config.word, similarity, transcript);
    const threshold = sensitivityThresholdV15(config.sensitivity);
    if (similarity < threshold) return this.suppress('near-miss', atMs, config.word, similarity, transcript);
    const last = this.lastFired.get(normaliseV15(config.word));
    if (last !== undefined && atMs - last < config.cooldownMs) {
      return this.suppress('cooldown', atMs, config.word, similarity, transcript);
    }
    this.lastFired.set(normaliseV15(config.word), atMs);
    this.activations += 1;
    this.pending = { word: config.word, atMs, confirmByMs: atMs + config.confirmMs };
    const event: WakeWordV15Event = { kind: 'activated', atMs, word: config.word, similarity, transcript };
    this.sink?.(event);
    return event;
  }

  /** Advance the clock; expire pending activations with no follow-up. */
  tick(atMs: number): WakeWordV15Event | undefined {
    if (!this.pending) return undefined;
    if (atMs < this.pending.confirmByMs) return undefined;
    const word = this.pending.word;
    this.pending = undefined;
    this.expirations += 1;
    this.suppressions.set('no-follow-up', (this.suppressions.get('no-follow-up') ?? 0) + 1);
    const event: WakeWordV15Event = { kind: 'expired', atMs, word, similarity: 1, reason: 'no-follow-up' };
    this.sink?.(event);
    return event;
  }

  /** Run a labelled test set through the detector (fresh state). */
  evaluate(samples: WakeWordV15TestSample[]): WakeWordV15Evaluation {
    const fresh = new WakeWordDetectorV15(this.listWords());
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    let atMs = 0;
    for (const sample of samples) {
      atMs += 10000; // past every cooldown, so each sample is independent.
      fresh.sleep(atMs);
      const event = fresh.feedTranscript(sample.transcript, atMs, sample.energy ?? 1);
      const fired = event !== undefined && event.kind === 'activated';
      if (sample.containsWakeWord && fired) tp += 1;
      else if (sample.containsWakeWord && !fired) fn += 1;
      else if (!sample.containsWakeWord && fired) fp += 1;
      else tn += 1;
    }
    const total = samples.length;
    return {
      total,
      truePositives: tp,
      falsePositives: fp,
      trueNegatives: tn,
      falseNegatives: fn,
      falseAcceptRate: fp + tn > 0 ? fp / (fp + tn) : 0,
      falseRejectRate: fn + tp > 0 ? fn / (fn + tp) : 0,
      accuracy: total > 0 ? (tp + tn) / total : 1,
    };
  }

  stats(): WakeWordV15Stats {
    const suppressions: Partial<Record<WakeWordV15SuppressReason, number>> = {};
    let total = 0;
    for (const [reason, count] of this.suppressions) {
      suppressions[reason] = count;
      total += count;
    }
    return {
      activations: this.activations,
      confirmations: this.confirmations,
      expirations: this.expirations,
      suppressions,
      totalSuppressions: total,
      words: this.words.size,
      enabledWords: [...this.words.values()].filter((w) => w.enabled).length,
    };
  }

  summary(): string {
    const s = this.stats();
    return `wake-word v15: ${s.activations} activations, ${s.confirmations} confirmed, ${s.expirations} expired, ` +
      `${s.totalSuppressions} suppressed, ${s.enabledWords}/${s.words} words enabled`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Wake word v15',
      '',
      `- Words: ${s.enabledWords}/${s.words} enabled`,
      `- Activations: ${s.activations}; confirmed: ${s.confirmations}; expired (no follow-up): ${s.expirations}`,
      `- Suppressions: ${s.totalSuppressions}`,
      '',
      '| Word | Sensitivity | Cooldown | Confirm window | Enabled |',
      '| --- | --- | ---: | ---: | ---: |',
    ];
    for (const w of this.listWords()) {
      lines.push(`| ${w.word} | ${w.sensitivity} | ${w.cooldownMs} ms | ${w.confirmMs} ms | ${w.enabled ? 'yes' : 'no'} |`);
    }
    lines.push('');
    lines.push('| Suppress reason | Count |');
    lines.push('| --- | ---: |');
    const reasons: WakeWordV15SuppressReason[] = ['near-miss', 'low-energy', 'cooldown', 'disabled', 'no-follow-up'];
    for (const reason of reasons) {
      lines.push(`| ${reason} | ${s.suppressions[reason] ?? 0} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private isWakeWordOnly(text: string): boolean {
    for (const config of this.words.values()) {
      if (text === normaliseV15(config.word)) return true;
    }
    return false;
  }

  private suppress(
    reason: WakeWordV15SuppressReason,
    atMs: number,
    word: string,
    similarity: number,
    transcript: string,
  ): WakeWordV15Event {
    this.suppressions.set(reason, (this.suppressions.get(reason) ?? 0) + 1);
    const event: WakeWordV15Event = { kind: 'suppressed', atMs, word, similarity, reason, transcript };
    this.sink?.(event);
    return event;
  }
}

export function createWakeWordDetectorV15(
  words?: WakeWordV15Config[],
  sink?: WakeWordV15Sink,
): WakeWordDetectorV15 {
  return new WakeWordDetectorV15(words, sink);
}

export function wakeWordV15Summary(detector: WakeWordDetectorV15): string {
  return detector.summary();
}

export function wakeWordV15Markdown(detector: WakeWordDetectorV15): string {
  return detector.markdown();
}

export function wakeWordV15EvaluationMarkdown(evaluation: WakeWordV15Evaluation): string {
  return [
    '## Wake-word evaluation v15',
    '',
    `- Samples: ${evaluation.total}; TP ${evaluation.truePositives}, FP ${evaluation.falsePositives}, ` +
      `TN ${evaluation.trueNegatives}, FN ${evaluation.falseNegatives}`,
    `- False-accept rate: ${(evaluation.falseAcceptRate * 100).toFixed(1)}%; ` +
      `false-reject rate: ${(evaluation.falseRejectRate * 100).toFixed(1)}%`,
    `- Accuracy: ${(evaluation.accuracy * 100).toFixed(1)}%`,
    '',
  ].join('\n');
}
