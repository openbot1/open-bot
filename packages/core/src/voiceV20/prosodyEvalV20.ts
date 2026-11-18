/**
 * Prosody eval v20 (voice v20, v1.29 Team T5).
 *
 * TTS prosody v5 (v1.28) plans pitch, rate, emphasis and pauses
 * deterministically from text — but nothing ever checked whether
 * the plan it produced was the *right* plan. This module scores
 * a rendered plan against an expected script, offline and without
 * audio: the script says which sentences are questions (pitch
 * must rise), which words carry emphasis, and where pauses must
 * fall; the scorer compares the actual `TtsV20Chunk[]` from
 * `ProsodyTtsV20.plan()` against those expectations.
 *
 * Four sub-scores, each 0..1, averaged into one prosody score:
 *
 *   1. Contour — per-sentence pitch direction: questions must
 *      rise above the statement baseline, exclamations must lift
 *      volume, statements must stay near neutral. A question
 *      spoken flat (pitchSt ≈ 0) scores 0 for that sentence.
 *   2. Emphasis — expected emphasized words must appear in a
 *      chunk planned with matching emphasis (strong beats mild,
 *      mild beats none). Missing emphasis and emphasis on the
 *      wrong word both cost.
 *   3. Pause placement — expected pause positions (after a given
 *      sentence, or an explicit [pause] marker) must appear as
 *      pause chunks or pauseBeforeMs on the following chunk,
 *      within a tolerance; extra pauses cost half as much as
 *      missing ones (a pause too many is less bad than a pause
 *      too few).
 *   4. Rate — long sentences must slow toward the end and strong
 *      emphasis must slow its chunk; a plan that rushes every
 *      sentence at rate 1.0 scores low on rate even when the
 *      words are right.
 *
 * The report also keeps the per-sentence breakdown so a failing
 * eval points at the exact sentence that sounded wrong. All
 * scoring is pure and deterministic; no audio is generated.
 */
import {
  ProsodyTtsV20,
  detectContourV20,
  type TtsV20Chunk,
  type TtsV20Contour,
  type TtsV20Emphasis,
} from './ttsProsodyV20';

export interface ProsodyV20ExpectedSentence {
  /** Sentence text (matched by normalised text, punctuation ignored). */
  text: string;
  contour: TtsV20Contour;
  /** Words that must carry emphasis in this sentence. */
  emphasisWords: string[];
  /** Strong emphasis required (default: any emphasis counts). */
  strongEmphasis?: boolean;
  /** A pause must follow this sentence (ms, 0 = any pause counts). */
  pauseAfterMs?: number;
}

export interface ProsodyV20Script {
  id: string;
  /** What the script is for (shown in reports). */
  label: string;
  sentences: ProsodyV20ExpectedSentence[];
}

export interface ProsodyV20SentenceScore {
  sentenceIndex: number;
  text: string;
  expectedContour: TtsV20Contour;
  actualContour: TtsV20Contour;
  contourScore: number;
  emphasisScore: number;
  pauseScore: number;
  rateScore: number;
  sentenceScore: number;
  notes: string[];
}

export interface ProsodyV20Report {
  scriptId: string;
  label: string;
  /** Overall prosody score, 0..1. */
  score: number;
  contour: number;
  emphasis: number;
  pause: number;
  rate: number;
  sentences: ProsodyV20SentenceScore[];
  /** True when every sub-score meets its floor. */
  pass: boolean;
}

export interface ProsodyV20EvalOptions {
  /** Floor for the overall score (default 0.7). */
  scoreFloor: number;
  /** Floor for each sub-score (default 0.5). */
  dimensionFloor: number;
  /** Pause within this many ms of the expected value counts (default 150). */
  pauseToleranceMs: number;
  /** Pitch rise (semitones) that counts as a question rise (default 1.5). */
  questionRiseSt: number;
}

export function defaultProsodyEvalV20Options(): ProsodyV20EvalOptions {
  return { scoreFloor: 0.7, dimensionFloor: 0.5, pauseToleranceMs: 150, questionRiseSt: 1.5 };
}

export function validateProsodyEvalV20Options(o: Partial<ProsodyV20EvalOptions>): string[] {
  const e: string[] = [];
  if (o.scoreFloor !== undefined && (o.scoreFloor < 0 || o.scoreFloor > 1)) e.push('scoreFloor must be 0..1');
  if (o.dimensionFloor !== undefined && (o.dimensionFloor < 0 || o.dimensionFloor > 1)) e.push('dimensionFloor must be 0..1');
  if (o.pauseToleranceMs !== undefined && o.pauseToleranceMs < 0) e.push('pauseToleranceMs must be >= 0');
  if (o.questionRiseSt !== undefined && o.questionRiseSt < 0) e.push('questionRiseSt must be >= 0');
  return e;
}

function normaliseSentenceV20(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function meanV20(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10000) / 10000;
}

function scoreContourV20(
  expected: TtsV20Contour,
  chunk: TtsV20Chunk | undefined,
  opts: ProsodyV20EvalOptions,
): { score: number; actual: TtsV20Contour; notes: string[] } {
  const notes: string[] = [];
  if (!chunk) return { score: 0, actual: 'neutral', notes: ['no chunk rendered for this sentence'] };
  const actual = chunk.prosody.contour;
  const pitch = chunk.prosody.pitchSt;
  const volume = chunk.prosody.volume;
  if (expected === actual) {
    if (expected === 'question' && pitch < opts.questionRiseSt) {
      notes.push(`question contour but pitch rose only ${pitch}st`);
      return { score: 0.5, actual, notes };
    }
    if (expected === 'exclamation' && volume <= 1) {
      notes.push('exclamation contour but no volume lift');
      return { score: 0.6, actual, notes };
    }
    return { score: 1, actual, notes };
  }
  if (expected === 'neutral' || actual === 'neutral') {
    notes.push(`expected ${expected}, got ${actual}`);
    return { score: 0.4, actual, notes };
  }
  notes.push(`expected ${expected}, got ${actual}`);
  return { score: 0, actual, notes };
}

function scoreEmphasisV20(
  expected: ProsodyV20ExpectedSentence,
  chunks: TtsV20Chunk[],
): { score: number; notes: string[] } {
  const notes: string[] = [];
  if (expected.emphasisWords.length === 0) return { score: 1, notes };
  const sentenceChunks = chunks.filter((c) => c.kind === 'speech');
  let hit = 0;
  for (const word of expected.emphasisWords) {
    const w = word.toLowerCase();
    const chunk = sentenceChunks.find((c) => normaliseSentenceV20(c.text).includes(w));
    if (!chunk) {
      notes.push(`emphasis word "${word}" not found in rendered chunks`);
      continue;
    }
    const level: TtsV20Emphasis = chunk.prosody.emphasis;
    if (expected.strongEmphasis && level !== 'strong') {
      notes.push(`"${word}" needs strong emphasis, got ${level}`);
      hit += 0.5;
    } else if (level === 'none') {
      notes.push(`"${word}" has no emphasis`);
    } else {
      hit += 1;
    }
  }
  return { score: Math.round((hit / expected.emphasisWords.length) * 100) / 100, notes };
}

function scorePauseV20(
  expected: ProsodyV20ExpectedSentence,
  chunks: TtsV20Chunk[],
  sentenceIndex: number,
  totalSentences: number,
  opts: ProsodyV20EvalOptions,
): { score: number; notes: string[] } {
  const notes: string[] = [];
  if (expected.pauseAfterMs === undefined) return { score: 1, notes };
  const isLast = sentenceIndex >= totalSentences - 1;
  // A pause after this sentence is either a pause chunk with this
  // sentenceIndex, or pauseBeforeMs on the next sentence's chunk.
  const pauseChunks = chunks.filter((c) => c.kind === 'pause' && c.sentenceIndex === sentenceIndex);
  const nextChunks = chunks.filter((c) => c.kind === 'speech' && c.sentenceIndex === sentenceIndex + 1);
  const actualMs = pauseChunks.length > 0
    ? pauseChunks.reduce((s, c) => s + c.estDurationMs, 0)
    : nextChunks.length > 0
      ? nextChunks[0]!.prosody.pauseBeforeMs
      : 0;
  if (actualMs <= 0) {
    if (isLast) {
      notes.push('expected a trailing pause, none rendered');
      return { score: 0.5, notes };
    }
    notes.push(`expected a pause after this sentence (~${expected.pauseAfterMs}ms), none found`);
    return { score: 0, notes };
  }
  if (expected.pauseAfterMs === 0) return { score: 1, notes };
  const diff = Math.abs(actualMs - expected.pauseAfterMs);
  if (diff <= opts.pauseToleranceMs) return { score: 1, notes };
  notes.push(`pause ${actualMs}ms, expected ~${expected.pauseAfterMs}ms (off by ${diff}ms)`);
  return { score: Math.max(0, Math.round((1 - diff / (expected.pauseAfterMs + opts.pauseToleranceMs)) * 100) / 100), notes };
}

function scoreRateV20(
  expected: ProsodyV20ExpectedSentence,
  chunks: TtsV20Chunk[],
  sentenceIndex: number,
  totalSentences: number,
): { score: number; notes: string[] } {
  const notes: string[] = [];
  const speech = chunks.filter((c) => c.kind === 'speech');
  if (speech.length === 0) return { score: 0, notes: ['no speech chunks'] };
  const rates = speech.map((c) => c.prosody.rate);
  const minRate = Math.min(...rates);
  const chars = speech.reduce((s, c) => s + c.text.length, 0);
  // Long sentences should slow down; strong emphasis must slow its chunk.
  let score = 1;
  if (chars > 120 && minRate >= 1) {
    notes.push(`long sentence (${chars} chars) never slowed below rate 1.0`);
    score -= 0.5;
  }
  if (expected.strongEmphasis && minRate >= 1) {
    notes.push('strong emphasis expected but no chunk slowed down');
    score -= 0.5;
  }
  if (totalSentences > 3 && sentenceIndex >= totalSentences - 1 && minRate >= 1) {
    notes.push('final sentence of a long reply never slowed');
    score -= 0.25;
  }
  return { score: Math.max(0, Math.round(score * 100) / 100), notes };
}

/** Score a rendered plan against one script. */
export function scoreProsodyV20(
  script: ProsodyV20Script,
  chunks: TtsV20Chunk[],
  opts: Partial<ProsodyV20EvalOptions> = {},
): ProsodyV20Report {
  const o = { ...defaultProsodyEvalV20Options(), ...opts };
  const sentences: ProsodyV20SentenceScore[] = script.sentences.map((expected, i) => {
    const sentenceChunks = chunks.filter(
      (c) => c.sentenceIndex === i || normaliseSentenceV20(c.text) === normaliseSentenceV20(expected.text),
    );
    const firstSpeech = sentenceChunks.find((c) => c.kind === 'speech');
    const contour = scoreContourV20(expected.contour, firstSpeech, o);
    const emphasis = scoreEmphasisV20(expected, sentenceChunks);
    const pause = scorePauseV20(expected, chunks, i, script.sentences.length, o);
    const rate = scoreRateV20(expected, sentenceChunks, i, script.sentences.length);
    const sentenceScore = Math.round(
      ((contour.score + emphasis.score + pause.score + rate.score) / 4) * 100,
    ) / 100;
    return {
      sentenceIndex: i,
      text: expected.text,
      expectedContour: expected.contour,
      actualContour: contour.actual,
      contourScore: contour.score,
      emphasisScore: emphasis.score,
      pauseScore: pause.score,
      rateScore: rate.score,
      sentenceScore,
      notes: [...contour.notes, ...emphasis.notes, ...pause.notes, ...rate.notes],
    };
  });
  const contour = meanV20(sentences.map((s) => s.contourScore));
  const emphasis = meanV20(sentences.map((s) => s.emphasisScore));
  const pause = meanV20(sentences.map((s) => s.pauseScore));
  const rate = meanV20(sentences.map((s) => s.rateScore));
  const score = Math.round(((contour + emphasis + pause + rate) / 4) * 10000) / 10000;
  return {
    scriptId: script.id,
    label: script.label,
    score,
    contour,
    emphasis,
    pause,
    rate,
    sentences,
    pass: score >= o.scoreFloor
      && contour >= o.dimensionFloor
      && emphasis >= o.dimensionFloor
      && pause >= o.dimensionFloor
      && rate >= o.dimensionFloor,
  };
}

/** Plan a script's reply text with ProsodyTtsV20 and score the plan. */
export function evalProsodyScriptV20(
  script: ProsodyV20Script,
  replyText: string,
  opts: Partial<ProsodyV20EvalOptions> = {},
): ProsodyV20Report {
  const tts = new ProsodyTtsV20();
  const chunks = tts.plan(replyText);
  return scoreProsodyV20(script, chunks, opts);
}

/**
 * Render the reply text a brain would emit for a script: emphasis
 * words wrapped in `**...**` (strong) and explicit `[pause:N]`
 * markers after sentences that must pause. Feeding this text to
 * `ProsodyTtsV20.plan()` must reproduce the script's expectations
 * — that round-trip is what the harness scores.
 */
export function renderScriptReplyV20(script: ProsodyV20Script): string {
  return script.sentences.map((s) => {
    let text = s.text;
    for (const word of s.emphasisWords) {
      const re = new RegExp(`\\b(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i');
      text = text.replace(re, '**$1**');
    }
    if (s.pauseAfterMs !== undefined && s.pauseAfterMs > 0) {
      text = `${text} [pause:${s.pauseAfterMs}]`;
    }
    return text;
  }).join(' ');
}

/** Detect the contour the planner would assign (test helper). */
export function expectedContourOfV20(sentence: string): TtsV20Contour {
  return detectContourV20(sentence);
}

export function prosodyEvalV20Summary(r: ProsodyV20Report): string {
  return `Prosody ${r.scriptId}: score ${(r.score * 100).toFixed(0)}% ` +
    `(contour ${(r.contour * 100).toFixed(0)}%, emphasis ${(r.emphasis * 100).toFixed(0)}%, ` +
    `pause ${(r.pause * 100).toFixed(0)}%, rate ${(r.rate * 100).toFixed(0)}%) — ${r.pass ? 'PASS' : 'FAIL'}`;
}

export function prosodyEvalV20Markdown(r: ProsodyV20Report): string {
  const lines = [
    `# Prosody eval — ${r.label} (${r.scriptId})`, '',
    `- Overall: ${(r.score * 100).toFixed(1)}% — ${r.pass ? 'PASS' : 'FAIL'}`,
    `- Contour: ${(r.contour * 100).toFixed(1)}%`,
    `- Emphasis: ${(r.emphasis * 100).toFixed(1)}%`,
    `- Pause: ${(r.pause * 100).toFixed(1)}%`,
    `- Rate: ${(r.rate * 100).toFixed(1)}%`,
    '',
  ];
  for (const s of r.sentences) {
    lines.push(`## Sentence ${s.sentenceIndex + 1}: ${(s.sentenceScore * 100).toFixed(0)}%`);
    lines.push(`> ${s.text}`);
    lines.push(`- Contour: expected ${s.expectedContour}, got ${s.actualContour} (${(s.contourScore * 100).toFixed(0)}%)`);
    lines.push(`- Emphasis ${(s.emphasisScore * 100).toFixed(0)}%, pause ${(s.pauseScore * 100).toFixed(0)}%, rate ${(s.rateScore * 100).toFixed(0)}%`);
    for (const n of s.notes) lines.push(`- Note: ${n}`);
    lines.push('');
  }
  return lines.join('\n');
}
