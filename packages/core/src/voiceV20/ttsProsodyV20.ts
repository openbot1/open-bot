/**
 * Prosody-aware TTS v5 (voice v20, v1.28 Team T5).
 *
 * On top of v18's TTS streaming: the reply text is parsed for
 * prosody cues before it is chunked — emphasis markers, explicit
 * pauses, question/exclamation contours, numbers and dates read
 * as words, and per-sentence rate/pitch shaping (questions rise,
 * long sentences slow down at the end, lists pause between
 * items). Chunks carry their prosody plan so a mock TTS (or a
 * real provider later) can render them, and the plan is fully
 * deterministic from the text: the same reply always sounds the
 * same. No audio is generated here — chunks are text + plan only.
 */
export type TtsV20Contour = 'statement' | 'question' | 'exclamation' | 'list-item' | 'neutral';
export type TtsV20Emphasis = 'none' | 'mild' | 'strong';
export type TtsV20ChunkKind = 'speech' | 'pause';

export interface TtsV20ProsodyPlan {
  /** Relative speech rate, 1.0 = normal. */
  rate: number;
  /** Relative pitch offset in semitones. */
  pitchSt: number;
  /** Relative volume, 1.0 = normal. */
  volume: number;
  emphasis: TtsV20Emphasis;
  contour: TtsV20Contour;
  /** Pause before this chunk, in ms. */
  pauseBeforeMs: number;
}

export interface TtsV20Chunk {
  id: string;
  kind: TtsV20ChunkKind;
  /** Spoken text (markers stripped). Empty for pure pauses. */
  text: string;
  prosody: TtsV20ProsodyPlan;
  /** Estimated spoken duration at the planned rate, in ms. */
  estDurationMs: number;
  /** Index of the sentence this chunk belongs to. */
  sentenceIndex: number;
}

export interface TtsV20Options {
  /** Base chars spoken per second at rate 1.0. */
  baseCharsPerSecond: number;
  /** Max chars per speech chunk. */
  maxChunkChars: number;
  /** Default pause between sentences, in ms. */
  sentencePauseMs: number;
  /** Default pause after a comma, in ms. */
  commaPauseMs: number;
  /** Pause inserted for an explicit [pause] marker, in ms. */
  markerPauseMs: number;
  /** Question contours rise by this many semitones. */
  questionPitchSt: number;
  /** Exclamations get this volume boost. */
  exclamationVolume: number;
  /** Strong emphasis slows the chunk by this factor. */
  strongEmphasisRate: number;
}

export function defaultTtsV20Options(): TtsV20Options {
  return {
    baseCharsPerSecond: 15,
    maxChunkChars: 220,
    sentencePauseMs: 320,
    commaPauseMs: 140,
    markerPauseMs: 600,
    questionPitchSt: 2.5,
    exclamationVolume: 1.15,
    strongEmphasisRate: 0.85,
  };
}

export function validateTtsV20Options(o: Partial<TtsV20Options>): string[] {
  const e: string[] = [];
  if (o.baseCharsPerSecond !== undefined && o.baseCharsPerSecond <= 0) e.push('baseCharsPerSecond must be > 0');
  if (o.maxChunkChars !== undefined && o.maxChunkChars < 20) e.push('maxChunkChars must be >= 20');
  if (o.sentencePauseMs !== undefined && o.sentencePauseMs < 0) e.push('sentencePauseMs must be >= 0');
  if (o.commaPauseMs !== undefined && o.commaPauseMs < 0) e.push('commaPauseMs must be >= 0');
  if (o.markerPauseMs !== undefined && o.markerPauseMs < 0) e.push('markerPauseMs must be >= 0');
  if (o.questionPitchSt !== undefined && o.questionPitchSt < 0) e.push('questionPitchSt must be >= 0');
  if (o.exclamationVolume !== undefined && o.exclamationVolume <= 0) e.push('exclamationVolume must be > 0');
  if (o.strongEmphasisRate !== undefined && (o.strongEmphasisRate <= 0 || o.strongEmphasisRate > 1)) e.push('strongEmphasisRate must be 0..1');
  return e;
}

/** Detect the contour of a sentence from its final punctuation. */
export function detectContourV20(sentence: string): TtsV20Contour {
  const t = sentence.trim();
  if (t.endsWith('?')) return 'question';
  if (t.endsWith('!')) return 'exclamation';
  if (/^\s*(\d+[.)]|[-•])\s/.test(t)) return 'list-item';
  if (t === '') return 'neutral';
  return 'statement';
}

/** Split text into sentences on . ! ? followed by space or end. */
export function splitSentencesV20(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g;
  const matches = text.match(re);
  if (!matches) return [];
  for (const m of matches) {
    const t = m.trim();
    if (t !== '') out.push(t);
  }
  // A numbered-list marker ("1.", "2)") is not a sentence on its own:
  // the regex above splits "1. Vé máy bay." into "1." + "Vé máy bay.",
  // which loses the list-item contour (detectContourV20 needs the marker
  // attached to its sentence). Merge a bare marker chunk back into the
  // following sentence. A real sentence ending in a number ("He scored
  // 3.") is never a bare marker, so it is never merged.
  const merged: string[] = [];
  for (let i = 0; i < out.length; i += 1) {
    const chunk = out[i]!;
    if (/^\d+[.)]$/.test(chunk) && i + 1 < out.length) {
      merged.push(`${chunk} ${out[i + 1]!}`);
      i += 1;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

/** Strip emphasis markers (*word*, **word**, _word_) and report the strongest level found. */
export function stripEmphasisMarkersV20(text: string): { text: string; emphasis: TtsV20Emphasis } {
  let emphasis: TtsV20Emphasis = 'none';
  let out = text;
  if (/\*\*[^*]+\*\*/.test(out)) emphasis = 'strong';
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  if (emphasis === 'none' && /\*[^*]+\*/.test(out)) emphasis = 'mild';
  out = out.replace(/\*([^*]+)\*/g, '$1');
  if (emphasis === 'none' && /_[^_]+_/.test(out)) emphasis = 'mild';
  out = out.replace(/_([^_]+)_/g, '$1');
  return { text: out.trim(), emphasis };
}

/** Count explicit [pause] / [pause:800] markers and remove them. */
export function extractPausesV20(text: string): { text: string; pauses: number[] } {
  const pauses: number[] = [];
  const out = text.replace(/\[pause(?::(\d+))?\]/gi, (_m, ms: string | undefined) => {
    pauses.push(ms ? Number(ms) : 0);
    return ' ';
  });
  return { text: out.replace(/\s+/g, ' ').trim(), pauses };
}

const NUMBER_WORDS_V20: Record<string, string> = {
  '0': 'không', '1': 'một', '2': 'hai', '3': 'ba', '4': 'bốn',
  '5': 'năm', '6': 'sáu', '7': 'bảy', '8': 'tám', '9': 'chín',
};

/** Read small integers as Vietnamese words (mock TTS number reading). */
export function readNumbersAsWordsV20(text: string): string {
  return text.replace(/\b(\d)\b/g, (_m, d: string) => NUMBER_WORDS_V20[d] ?? d);
}

/** Expand common abbreviations so the mock TTS reads them naturally. */
export function expandAbbreviationsV20(text: string): string {
  return text
    .replace(/\bVD\b/g, 'ví dụ')
    .replace(/\bTP\.? ?HCM\b/gi, 'Thành phố Hồ Chí Minh')
    .replace(/\bMr\./g, 'ông')
    .replace(/\bMs\./g, 'bà');
}

export interface TtsV20Stats {
  sentences: number;
  chunks: number;
  pauses: number;
  totalEstMs: number;
  questions: number;
  exclamations: number;
  strongEmphasis: number;
  chars: number;
}

/** Build the prosody plan for one sentence. */
export function planProsodyV20(
  o: TtsV20Options,
  sentence: string,
  emphasis: TtsV20Emphasis,
  sentenceIndex: number,
  totalSentences: number,
): TtsV20ProsodyPlan {
  const contour = detectContourV20(sentence);
  let rate = 1;
  let pitchSt = 0;
  let volume = 1;
  if (contour === 'question') pitchSt += o.questionPitchSt;
  if (contour === 'exclamation') volume *= o.exclamationVolume;
  if (contour === 'list-item') rate *= 0.95;
  if (emphasis === 'strong') rate *= o.strongEmphasisRate;
  if (emphasis === 'mild') rate *= 0.95;
  // Long replies slow down slightly toward the end (listener fatigue).
  if (totalSentences > 3 && sentenceIndex >= totalSentences - 1) rate *= 0.95;
  return {
    rate: Math.round(rate * 100) / 100,
    pitchSt: Math.round(pitchSt * 10) / 10,
    volume: Math.round(volume * 100) / 100,
    emphasis,
    contour,
    pauseBeforeMs: sentenceIndex === 0 ? 0 : o.sentencePauseMs,
  };
}

/** Estimate spoken duration of a chunk at its planned rate. */
export function estimateChunkMsV20(o: TtsV20Options, text: string, rate: number): number {
  if (text.trim() === '') return 0;
  return Math.round((text.length / o.baseCharsPerSecond / Math.max(0.1, rate)) * 1000);
}

export class ProsodyTtsV20 {
  private opts: TtsV20Options;
  private stats: TtsV20Stats = {
    sentences: 0, chunks: 0, pauses: 0, totalEstMs: 0,
    questions: 0, exclamations: 0, strongEmphasis: 0, chars: 0,
  };

  constructor(opts: Partial<TtsV20Options> = {}) {
    this.opts = { ...defaultTtsV20Options(), ...opts };
  }

  get options(): TtsV20Options { return { ...this.opts }; }
  getStats(): TtsV20Stats { return { ...this.stats }; }

  /** Parse a reply into prosody-planned chunks. Deterministic. */
  plan(text: string): TtsV20Chunk[] {
    const chunks: TtsV20Chunk[] = [];
    const { text: noPauses, pauses } = extractPausesV20(text);
    const sentences = splitSentencesV20(noPauses);
    let pauseIdx = 0;
    sentences.forEach((raw, i) => {
      // Detect the contour from the sentence BEFORE numbers are read as
      // words: readNumbersAsWordsV20 turns a list marker "1." into "một.",
      // which detectContourV20 no longer recognises as a list item. The
      // spoken text still gets the number reading; only the contour probe
      // uses the unexpanded text (emphasis markers stripped so a trailing
      // "!" still reads as an exclamation).
      const { text: contourText, emphasis } = stripEmphasisMarkersV20(raw);
      const expanded = expandAbbreviationsV20(readNumbersAsWordsV20(contourText));
      const clean = expanded.trim();
      if (clean === '') return;
      const prosody = planProsodyV20(this.opts, contourText, emphasis, i, sentences.length);
      const contour = prosody.contour;
      if (contour === 'question') this.stats.questions += 1;
      if (contour === 'exclamation') this.stats.exclamations += 1;
      if (emphasis === 'strong') this.stats.strongEmphasis += 1;
      this.stats.sentences += 1;
      this.stats.chars += clean.length;
      // Split long sentences on commas into sub-chunks with a comma pause.
      const parts = clean.length > this.opts.maxChunkChars
        ? this.splitLongSentence(clean)
        : [clean];
      parts.forEach((part, pi) => {
        const partProsody: TtsV20ProsodyPlan = {
          ...prosody,
          pauseBeforeMs: pi === 0 ? prosody.pauseBeforeMs : this.opts.commaPauseMs,
        };
        const chunk: TtsV20Chunk = {
          id: `v20-${i}-${pi}`,
          kind: 'speech',
          text: part,
          prosody: partProsody,
          estDurationMs: estimateChunkMsV20(this.opts, part, partProsody.rate),
          sentenceIndex: i,
        };
        chunks.push(chunk);
        this.stats.chunks += 1;
        this.stats.totalEstMs += chunk.estDurationMs;
        // Explicit [pause] markers become pause chunks after this sentence.
        if (pi === parts.length - 1 && pauseIdx < pauses.length) {
          const pauseMs = pauses[pauseIdx] > 0 ? pauses[pauseIdx] : this.opts.markerPauseMs;
          pauseIdx += 1;
          chunks.push({
            id: `v20-${i}-pause`,
            kind: 'pause',
            text: '',
            prosody: { ...prosody, pauseBeforeMs: 0 },
            estDurationMs: pauseMs,
            sentenceIndex: i,
          });
          this.stats.pauses += 1;
          this.stats.totalEstMs += pauseMs;
        }
      });
    });
    return chunks;
  }

  private splitLongSentence(sentence: string): string[] {
    const parts: string[] = [];
    let rest = sentence;
    while (rest.length > this.opts.maxChunkChars) {
      // Prefer a comma or conjunction break near the limit.
      let cut = rest.lastIndexOf(',', this.opts.maxChunkChars);
      if (cut < this.opts.maxChunkChars * 0.5) cut = rest.lastIndexOf(' ', this.opts.maxChunkChars);
      if (cut <= 0) cut = this.opts.maxChunkChars;
      parts.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest !== '') parts.push(rest);
    return parts;
  }

  /** Total estimated duration of a planned reply, in ms. */
  totalMs(chunks: TtsV20Chunk[]): number {
    return chunks.reduce((a, c) => a + c.estDurationMs + (c.kind === 'speech' ? c.prosody.pauseBeforeMs : 0), 0);
  }

  /** Render a plan as a readable script (for logs and the UI preview). */
  renderScript(chunks: TtsV20Chunk[]): string {
    return chunks.map((c) => {
      if (c.kind === 'pause') return `[pause ${c.estDurationMs}ms]`;
      const p = c.prosody;
      return `[${p.contour}${p.emphasis !== 'none' ? ` ${p.emphasis}` : ''} rate=${p.rate} pitch=${p.pitchSt}st] ${c.text}`;
    }).join('\n');
  }

  reset(): void {
    this.stats = {
      sentences: 0, chunks: 0, pauses: 0, totalEstMs: 0,
      questions: 0, exclamations: 0, strongEmphasis: 0, chars: 0,
    };
  }
}

export function createProsodyTtsV20(opts: Partial<TtsV20Options> = {}): ProsodyTtsV20 {
  return new ProsodyTtsV20(opts);
}

export function ttsProsodyV20Summary(t: ProsodyTtsV20): string {
  const s = t.getStats();
  return `Prosody TTS v5: ${s.sentences} sentences, ${s.chunks} chunks, ${s.pauses} pauses, ` +
    `${s.questions} questions, ${s.exclamations} exclamations, ${s.strongEmphasis} strong emphasis, ` +
    `~${Math.round(s.totalEstMs / 1000)}s estimated`;
}

export function ttsProsodyV20Markdown(t: ProsodyTtsV20): string {
  const s = t.getStats();
  return `# Prosody TTS v5\n\n- Sentences: ${s.sentences}\n- Chunks: ${s.chunks}\n- Pauses: ${s.pauses}\n` +
    `- Questions: ${s.questions}\n- Exclamations: ${s.exclamations}\n- Strong emphasis: ${s.strongEmphasis}\n` +
    `- Characters: ${s.chars}\n- Estimated duration: ${s.totalEstMs}ms\n`;
}
