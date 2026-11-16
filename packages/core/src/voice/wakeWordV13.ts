/**
 * Wake word (local) v13 (v1.14, Đội T5 — voice realtime v13).
 *
 * A realtime voice session should not listen to everything in
 * the room: it sleeps until the user calls it, then wakes for
 * one conversation. v13 adds the wake-word gate:
 *
 *   asleep ──▶ noteTranscript("…hey bot…") ──▶ wake-word hit
 *              ──▶ active (the session listens + answers)
 *              ──▶ silence-timeout / explicit sleep ──▶ asleep
 *
 * The detector works on the host's partial transcript (the
 * same STT stream that feeds Smart Turn): a keyword hit is a
 * word-boundary match on normalised text, so "hey bot" fires
 * but "they bought" does not. Vietnamese keywords match
 * diacritics-insensitively when `foldDiacritics` is on, so
 * "này bot" also matches "nay bot" from a noisy transcript.
 *
 * The matching engine is pluggable: `WakeWordEngine` is the
 * interface a real on-device engine (porcupine-style keyword
 * spotter, or a tiny neural spotter) implements; the built-in
 * `MockWakeWordEngineV13` matches keywords in text and is what
 * the tests and the mock session use. A real engine that works
 * on raw audio frames implements the same `detect` shape over
 * transcripts the host derives from its own audio — the
 * detector never touches a microphone itself.
 *
 * Guards against false wakes: a minimum confidence, a
 * cooldown after each activation, and an optional
 * `requireWordBoundary` (off only when the host already
 * segments words). The detector never records audio and never
 * sends a transcript anywhere.
 */

/** Result of one wake-word match attempt. */
export interface WakeWordV13Match {
  matched: boolean;
  /** The keyword that matched ('' when none). */
  keyword: string;
  /** Confidence 0..1 (1 for an exact word-boundary match). */
  confidence: number;
  /** Char index of the match in the normalised text (-1 when none). */
  atChar: number;
}

/** A wake-word engine: text in, match out. Real on-device engines implement this. */
export interface WakeWordEngineV13 {
  /** Engine name (for the panel + diagnostics). */
  readonly name: string;
  /** True when the engine can run right now (model loaded / keywords set). */
  isReady(): boolean;
  /** Try to match a (partial) transcript. */
  detect(transcript: string, atMs: number): WakeWordV13Match;
}

/** Options for the mock engine. */
export interface MockWakeWordV13Options {
  /** Keywords to listen for (default ['hey bot']). */
  keywords?: string[];
  /** Fold Vietnamese diacritics before matching (default true). */
  foldDiacritics?: boolean;
  /** Require word boundaries around a keyword (default true). */
  requireWordBoundary?: boolean;
  /** Confidence reported for a match (default 0.95). */
  matchConfidence?: number;
}

/** Options for `WakeWordDetectorV13`. */
export interface WakeWordV13Options {
  /** Keywords to listen for (default ['hey bot']). */
  keywords?: string[];
  /** Fold Vietnamese diacritics before matching (default true). */
  foldDiacritics?: boolean;
  /** Require word boundaries around a keyword (default true). */
  requireWordBoundary?: boolean;
  /** Minimum confidence to accept a hit (default 0.5). */
  minConfidence?: number;
  /** Cooldown (ms) after an activation before the next hit counts (default 3000). */
  cooldownMs?: number;
  /** Sleep again after this long without user speech (ms, default 60000; 0 = never auto-sleep). */
  autoSleepMs?: number;
  /** Start asleep (default true — the session must be woken). */
  startAsleep?: boolean;
  /** A custom engine (default: the built-in mock engine over the keywords). */
  engine?: WakeWordEngineV13 | null;
}

/** Detector state. */
export type WakeWordV13State = 'asleep' | 'active' | 'cooldown';

/** One activation. */
export interface WakeWordV13Activation {
  id: number;
  keyword: string;
  confidence: number;
  atMs: number;
  /** Transcript the keyword was found in. */
  transcript: string;
}

/** Counters for one detector. */
export interface WakeWordV13Stats {
  state: WakeWordV13State;
  activations: number;
  /** Match attempts that hit a keyword but were refused (cooldown / low confidence). */
  refused: number;
  /** Transcripts checked. */
  checked: number;
  /** Last activation, or null when none. */
  lastActivation: WakeWordV13Activation | null;
  keywords: string[];
  history: number;
}

/** Events emitted by the detector. */
export type WakeWordV13Event =
  | { kind: 'activated'; activation: WakeWordV13Activation }
  | { kind: 'refused'; atMs: number; keyword: string; confidence: number; reason: string }
  | { kind: 'slept'; atMs: number; reason: string }
  | { kind: 'keywords-changed'; keywords: string[]; atMs: number };

export type WakeWordV13EventSink = (event: WakeWordV13Event) => void;

export const WAKE_WORD_V13_DEFAULT_KEYWORDS = ['hey bot'] as const;

/** Fold Vietnamese diacritics (and case) for tolerant matching. Pure. */
export function foldDiacriticsV13(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function defaultWakeWordV13Options(): Required<Omit<WakeWordV13Options, 'engine'>> & { engine: WakeWordEngineV13 | null } {
  return {
    keywords: [...WAKE_WORD_V13_DEFAULT_KEYWORDS],
    foldDiacritics: true,
    requireWordBoundary: true,
    minConfidence: 0.5,
    cooldownMs: 3000,
    autoSleepMs: 60000,
    startAsleep: true,
    engine: null,
  };
}

export function validateWakeWordV13Options(options: WakeWordV13Options): Required<Omit<WakeWordV13Options, 'engine'>> & { engine: WakeWordEngineV13 | null } {
  const base = defaultWakeWordV13Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Wake word v13 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  let keywords = base.keywords;
  if (options.keywords !== undefined) {
    if (!Array.isArray(options.keywords) || options.keywords.length === 0) {
      throw new Error('Wake word v13 keywords must be a non-empty array of strings.');
    }
    keywords = options.keywords.map((k) => {
      if (typeof k !== 'string' || !k.trim()) {
        throw new Error('Wake word v13 keyword must be a non-empty string.');
      }
      return k.trim();
    });
    if (new Set(keywords.map((k) => k.toLowerCase())).size !== keywords.length) {
      throw new Error('Wake word v13 keywords must be unique (case-insensitive).');
    }
  }
  if (options.engine !== undefined && options.engine !== null && typeof options.engine.detect !== 'function') {
    throw new Error('Wake word v13 engine must implement detect(transcript, atMs).');
  }
  return {
    keywords,
    foldDiacritics: options.foldDiacritics ?? base.foldDiacritics,
    requireWordBoundary: options.requireWordBoundary ?? base.requireWordBoundary,
    minConfidence: num(options.minConfidence, base.minConfidence, 'minConfidence', 0, 1),
    cooldownMs: Math.floor(num(options.cooldownMs, base.cooldownMs, 'cooldownMs', 0, 600000)),
    autoSleepMs: Math.floor(num(options.autoSleepMs, base.autoSleepMs, 'autoSleepMs', 0, 3600000)),
    startAsleep: options.startAsleep ?? base.startAsleep,
    engine: options.engine ?? null,
  };
}

function normaliseForMatchV13(text: string, fold: boolean): string {
  const lowered = text.trim().replace(/\s+/g, ' ');
  return fold ? foldDiacriticsV13(lowered) : lowered.toLowerCase();
}

/**
 * Mock wake-word engine: keyword matching over normalised
 * text. Word-boundary matching means "hey bot" matches "hey
 * bot, giúp tôi" but not "they bought". With `foldDiacritics`,
 * "này bot" also matches "nay bot".
 */
export class MockWakeWordEngineV13 implements WakeWordEngineV13 {
  readonly name = 'mock';
  private keywords: string[];
  private readonly fold: boolean;
  private readonly requireBoundary: boolean;
  private readonly matchConfidence: number;

  constructor(options: MockWakeWordV13Options = {}) {
    if (options.keywords !== undefined && (!Array.isArray(options.keywords) || options.keywords.length === 0)) {
      throw new Error('Wake word v13 mock engine keywords must be a non-empty array of strings.');
    }
    this.keywords = (options.keywords ?? [...WAKE_WORD_V13_DEFAULT_KEYWORDS]).map((k) => k.trim());
    this.fold = options.foldDiacritics ?? true;
    this.requireBoundary = options.requireWordBoundary ?? true;
    const confidence = options.matchConfidence ?? 0.95;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('Wake word v13 mock engine matchConfidence must be a number in 0..1.');
    }
    this.matchConfidence = confidence;
  }

  isReady(): boolean {
    return this.keywords.length > 0;
  }

  getKeywords(): string[] {
    return [...this.keywords];
  }

  setKeywords(keywords: string[]): void {
    if (!Array.isArray(keywords) || keywords.length === 0) {
      throw new Error('Wake word v13 mock engine keywords must be a non-empty array of strings.');
    }
    this.keywords = keywords.map((k) => k.trim());
  }

  detect(transcript: string, _atMs: number): WakeWordV13Match {
    const haystack = normaliseForMatchV13(transcript, this.fold);
    let best: WakeWordV13Match = { matched: false, keyword: '', confidence: 0, atChar: -1 };
    for (const keyword of this.keywords) {
      const needle = normaliseForMatchV13(keyword, this.fold);
      if (!needle) continue;
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) break;
        const beforeOk = !this.requireBoundary || at === 0 || /[\s.,!?…:;—-]/.test(haystack[at - 1] as string);
        const after = at + needle.length;
        const afterOk = !this.requireBoundary || after >= haystack.length || /[\s.,!?…:;—-]/.test(haystack[after] as string);
        if (beforeOk && afterOk) {
          if (!best.matched || at < best.atChar) {
            best = { matched: true, keyword, confidence: this.matchConfidence, atChar: at };
          }
          break;
        }
        from = at + 1;
      }
    }
    return best;
  }
}

/**
 * Wake-word detector: asleep until a keyword hit, active
 * afterwards, cooldown between activations. The host feeds
 * partial transcripts (`noteTranscript`); the detector decides.
 * `tick(atMs)` applies the auto-sleep timer. `sleep()` puts it
 * back to sleep explicitly (e.g. the user ended the call).
 */
export class WakeWordDetectorV13 {
  private readonly options: Required<Omit<WakeWordV13Options, 'engine'>> & { engine: WakeWordEngineV13 | null };
  private readonly sink: WakeWordV13EventSink | null;
  private readonly engine: WakeWordEngineV13;
  private state: WakeWordV13State;
  private keywords: string[];
  private lastActivationAtMs: number | null = null;
  private lastSpeechAtMs: number | null = null;
  private nextId = 1;
  private history: WakeWordV13Activation[] = [];
  private checked = 0;
  private refused = 0;

  constructor(options: WakeWordV13Options = {}, sink: WakeWordV13EventSink | null = null) {
    this.options = validateWakeWordV13Options(options);
    this.sink = sink;
    this.keywords = [...this.options.keywords];
    this.engine = this.options.engine ?? new MockWakeWordEngineV13({
      keywords: this.keywords,
      foldDiacritics: this.options.foldDiacritics,
      requireWordBoundary: this.options.requireWordBoundary,
    });
    this.state = this.options.startAsleep ? 'asleep' : 'active';
  }

  getState(): WakeWordV13State {
    return this.state;
  }

  isActive(): boolean {
    return this.state === 'active';
  }

  getEngine(): WakeWordEngineV13 {
    return this.engine;
  }

  getKeywords(): string[] {
    return [...this.keywords];
  }

  /** Change the keywords (also updates the built-in mock engine). */
  setKeywords(keywords: string[], atMs = 0): void {
    const validated = validateWakeWordV13Options({ ...this.options, keywords });
    this.keywords = [...validated.keywords];
    if (this.engine instanceof MockWakeWordEngineV13) this.engine.setKeywords(this.keywords);
    this.sink?.({ kind: 'keywords-changed', keywords: [...this.keywords], atMs });
  }

  /**
   * Feed a partial transcript. Returns the activation when a
   * keyword hit wakes the detector, or null. While `active`,
   * transcripts are counted but never re-trigger (the session
   * is already awake); keyword hits during `cooldown` are
   * refused and counted.
   */
  noteTranscript(transcript: string, atMs: number): WakeWordV13Activation | null {
    this.checked += 1;
    if (typeof transcript === 'string' && transcript.trim()) this.lastSpeechAtMs = atMs;
    if (this.state === 'active') return null;
    if (!this.engine.isReady()) return null;
    const match = this.engine.detect(transcript, atMs);
    if (!match.matched) return null;
    if (match.confidence < this.options.minConfidence) {
      this.refused += 1;
      this.sink?.({ kind: 'refused', atMs, keyword: match.keyword, confidence: match.confidence, reason: `confidence ${match.confidence} below minimum ${this.options.minConfidence}` });
      return null;
    }
    if (this.state === 'cooldown' && this.lastActivationAtMs !== null && atMs - this.lastActivationAtMs < this.options.cooldownMs) {
      this.refused += 1;
      this.sink?.({ kind: 'refused', atMs, keyword: match.keyword, confidence: match.confidence, reason: `in cooldown (${atMs - this.lastActivationAtMs} ms since the last activation)` });
      return null;
    }
    const activation: WakeWordV13Activation = {
      id: this.nextId,
      keyword: match.keyword,
      confidence: match.confidence,
      atMs,
      transcript: transcript.trim(),
    };
    this.nextId += 1;
    this.history.push(activation);
    if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
    this.lastActivationAtMs = atMs;
    this.state = 'active';
    this.sink?.({ kind: 'activated', activation: { ...activation } });
    return { ...activation };
  }

  /** Put the detector back to sleep (explicit). */
  sleep(atMs: number, reason = 'explicit'): void {
    if (this.state === 'asleep') return;
    this.state = 'asleep';
    this.sink?.({ kind: 'slept', atMs, reason });
  }

  /**
   * Advance the clock: auto-sleep after `autoSleepMs` without
   * user speech, and end the cooldown once it expires (the
   * detector returns to `asleep` so the next hit can wake it).
   */
  tick(atMs: number): void {
    if (this.state === 'cooldown' && this.lastActivationAtMs !== null && atMs - this.lastActivationAtMs >= this.options.cooldownMs) {
      this.state = 'asleep';
    }
    if (this.state === 'active' && this.options.autoSleepMs > 0 && this.lastSpeechAtMs !== null && atMs - this.lastSpeechAtMs >= this.options.autoSleepMs) {
      this.sleep(atMs, 'auto-sleep: no user speech');
    }
  }

  /** Enter cooldown explicitly (used after an activation the host handled). */
  enterCooldown(atMs: number): void {
    this.state = 'cooldown';
    this.lastActivationAtMs = atMs;
  }

  /** Activation history, oldest first (copies). */
  getHistory(): WakeWordV13Activation[] {
    return this.history.map((a) => ({ ...a }));
  }

  getStats(): WakeWordV13Stats {
    return {
      state: this.state,
      activations: this.history.length,
      refused: this.refused,
      checked: this.checked,
      lastActivation: this.history.length > 0 ? { ...(this.history[this.history.length - 1] as WakeWordV13Activation) } : null,
      keywords: [...this.keywords],
      history: this.history.length,
    };
  }

  reset(): void {
    this.state = this.options.startAsleep ? 'asleep' : 'active';
    this.lastActivationAtMs = null;
    this.lastSpeechAtMs = null;
    this.nextId = 1;
    this.history = [];
    this.checked = 0;
    this.refused = 0;
  }
}

/** Create a wake-word detector (factory). */
export function createWakeWordDetectorV13(options: WakeWordV13Options = {}, sink: WakeWordV13EventSink | null = null): WakeWordDetectorV13 {
  return new WakeWordDetectorV13(options, sink);
}

/** One-line summary of wake-word stats. */
export function wakeWordV13Summary(stats: WakeWordV13Stats): string {
  return (
    `Wake word v13: ${stats.state}, ${stats.activations} activations, ` +
    `${stats.refused} refused, ${stats.checked} transcripts checked, ` +
    `keywords: ${stats.keywords.join(', ')}`
  );
}

/** Wake-word stats as Markdown (for the diagnostics panel). */
export function wakeWordV13Markdown(stats: WakeWordV13Stats): string {
  const lines = [
    '## Wake word v13 (local)',
    '',
    `- state: ${stats.state}, keywords: ${stats.keywords.join(', ')}`,
    `- activations: ${stats.activations}, refused: ${stats.refused}, checked: ${stats.checked}`,
    `- last activation: ${stats.lastActivation ? `"${stats.lastActivation.keyword}" at ${stats.lastActivation.atMs} ms (confidence ${stats.lastActivation.confidence})` : '-'}`,
  ];
  return lines.join('\n');
}
