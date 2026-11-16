/**
 * Barge-in v12 (v1.13, Đội T5 — voice realtime v12).
 *
 * v11's barge-in controller answers "cut or not?" and hands back an
 * exact receipt (cut word, played vs discarded ms). What it throws
 * away is the *context* of the cut: the sentence the agent was
 * mid-way through, the words the user spoke to interrupt, and what
 * the agent should do with the unfinished reply next. v12 keeps
 * that context instead of discarding it:
 *
 *   agent reply: "Để tôi kiểm tra lịch của bạn hôm nay, bạn có ba
 *                 cuộc họp, đầu tiên là lúc chín giờ…"
 *   user (interrupting): "Khoan, chỉ họp với Lan thôi"
 *   ──▶ InterruptContextV12.recordInterrupt(receipt, …)
 *   ──▶ InterruptedUtteranceV12 {
 *         playedText: "Để tôi kiểm tra lịch của bạn hôm nay,",
 *         remainingText: "bạn có ba cuộc họp, đầu tiên là lúc chín giờ…",
 *         cutWord: "ba", cutWordIndex: 9,
 *         userInterruption: { text: "Khoan, chỉ họp với Lan thôi" },
 *         resumeStrategy: "drop",   // the user asked something new:
 *                                    // answer them instead of finishing
 *         resumeText: "",
 *         resumePrompt: "…",
 *       }
 *
 * Resume strategies (chosen by `chooseResumeStrategy`, overridable
 * per record):
 * - `continue` — re-speak the remaining text from the cut word
 *   (short remainder, nothing new asked).
 * - `restart` — re-speak the whole reply (the agent was still
 *   thinking, or the cut happened on the first words).
 * - `summarize` — compress a long remainder into one short
 *   sentence before speaking it (the tail is long and the user
 *   probably does not want the full monologue back).
 * - `drop` — abandon the reply: the interruption carried a new
 *   question / instruction, so the next turn answers the user.
 *
 * The user interruption transcript is fed word by word
 * (`noteUserWord`) as partial STT arrives — the same words the
 * VAD heard — so the record knows *why* the user cut in, not
 * just *that* they did. `buildResumePrompt` turns a record into
 * a short system-prompt paragraph the model can use to continue
 * coherently instead of restarting from scratch.
 *
 * No audio device, no network, no model: this module only tracks
 * words, receipts and decisions on the caller-owned virtual clock.
 */

import type { BargeInV11InterruptResult } from './bargeInV11';
import type { TtsStreamCancelResult } from './ttsStreamV11';

/** What to do with an interrupted reply. */
export type BargeInV12ResumeStrategy = 'continue' | 'restart' | 'summarize' | 'drop';

/** Options for `InterruptContextV12`. */
export interface BargeInV12Options {
  /** Remainder at/below this length (chars) resumes with `continue` (default 40). */
  continueMaxChars?: number;
  /** Remainder at/above this length (chars) resumes with `summarize` (default 200). */
  summarizeMinChars?: number;
  /** Cut at/below this word index resumes with `restart` (default 2). */
  restartMaxCutIndex?: number;
  /** Max interrupted utterances kept in history (default 50). */
  maxHistory?: number;
}

/** Words the user spoke while interrupting (partial STT). */
export interface BargeInV12UserInterruption {
  words: string[];
  /** Joined words. */
  text: string;
  /** Mean word confidence (0..1, 1 when unknown). */
  confidence: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
}

/** One interrupted utterance: everything the cut left behind. */
export interface InterruptedUtteranceV12 {
  id: number;
  atMs: number;
  /** Full agent reply text the cut came from. */
  replyText: string;
  /** The word being spoken when the cut happened. */
  cutWord: string;
  cutWordIndex: number;
  /** Words fully spoken before the cut. */
  wordsPlayed: string[];
  /** Words discarded by the cut (including the cut word). */
  wordsDiscarded: string[];
  /** Text already heard by the user. */
  playedText: string;
  /** Text the user never heard (the unfinished sentence). */
  remainingText: string;
  /** Audio ms already played / discarded. */
  playedMs: number;
  discardedMs: number;
  /** True when the agent was still thinking (no audio yet). */
  wasThinking: boolean;
  /** Barge-in latency: VAD speech-start → interrupt (ms, null when explicit). */
  latencyMs: number | null;
  /** What the user said to interrupt (may be empty when unknown). */
  userInterruption: BargeInV12UserInterruption;
  /** Chosen resume strategy. */
  resumeStrategy: BargeInV12ResumeStrategy;
  /** Why that strategy was chosen. */
  resumeReason: string;
  /** Text to speak if the reply is resumed ('' for `drop`). */
  resumeText: string;
  /** System-prompt paragraph for the model ('' when nothing to resume). */
  resumePrompt: string;
  /** TTS chunks cancelled by the cut. */
  ttsChunksCancelled: number;
  /** TTS chars discarded by the cut. */
  ttsCharsDiscarded: number;
}

/** Counters for one context tracker. */
export interface BargeInV12Stats {
  interrupts: number;
  byStrategy: Record<BargeInV12ResumeStrategy, number>;
  /** Mean remaining (unheard) chars per interrupt (0 when none). */
  meanRemainingChars: number;
  /** Mean played chars per interrupt (0 when none). */
  meanPlayedChars: number;
  /** Mean barge-in latency (ms, null when none). */
  meanLatencyMs: number | null;
  /** Slowest barge-in latency (ms, null when none). */
  maxLatencyMs: number | null;
  /** Interrupts whose user words were captured. */
  withUserWords: number;
  history: number;
}

/** Events emitted by the tracker. */
export type BargeInV12Event =
  | { kind: 'interrupt-recorded'; record: InterruptedUtteranceV12 }
  | { kind: 'user-word'; word: string; atMs: number; confidence: number }
  | { kind: 'strategy-changed'; id: number; strategy: BargeInV12ResumeStrategy; atMs: number };

export type BargeInV12EventSink = (event: BargeInV12Event) => void;

export const BARGE_IN_V12_STRATEGIES = ['continue', 'restart', 'summarize', 'drop'] as const;

export function isBargeInV12ResumeStrategy(value: unknown): value is BargeInV12ResumeStrategy {
  return typeof value === 'string' && (BARGE_IN_V12_STRATEGIES as readonly string[]).includes(value);
}

export function defaultBargeInV12Options(): Required<BargeInV12Options> {
  return {
    continueMaxChars: 40,
    summarizeMinChars: 200,
    restartMaxCutIndex: 2,
    maxHistory: 50,
  };
}

export function validateBargeInV12Options(options: BargeInV12Options): Required<BargeInV12Options> {
  const base = defaultBargeInV12Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Barge-in v12 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  const continueMaxChars = Math.floor(num(options.continueMaxChars, base.continueMaxChars, 'continueMaxChars', 0, 10000));
  const summarizeMinChars = Math.floor(num(options.summarizeMinChars, base.summarizeMinChars, 'summarizeMinChars', 0, 100000));
  if (summarizeMinChars < continueMaxChars) {
    throw new Error(`Barge-in v12 summarizeMinChars (${summarizeMinChars}) must be >= continueMaxChars (${continueMaxChars}).`);
  }
  return {
    continueMaxChars,
    summarizeMinChars,
    restartMaxCutIndex: Math.floor(num(options.restartMaxCutIndex, base.restartMaxCutIndex, 'restartMaxCutIndex', 0, 1000)),
    maxHistory: Math.floor(num(options.maxHistory, base.maxHistory, 'maxHistory', 1, 1000)),
  };
}

/** Words that usually open a new question / instruction (drop the old reply). */
export const BARGE_IN_V12_NEW_TURN_WORDS = new Set([
  'khoan', 'đợi', 'dừng', 'thôi', 'không', 'wait', 'stop', 'hold', 'actually',
  'nhưng', 'mà', 'hỏi', 'sao', 'tại', 'why', 'what', 'how', 'khi', 'nào',
]);

/**
 * Pick a resume strategy for an interrupted reply. Pure — the
 * tracker and the tests share it.
 *
 * - The user asked something new (interruption starts with a
 *   new-turn word, or ends with `?`) → `drop`: answer them.
 * - The agent was still thinking → `restart`: nothing was heard.
 * - Cut in the first words → `restart`: re-speaking from the
 *   middle would confuse.
 * - Short remainder → `continue`: finish the sentence.
 * - Long remainder → `summarize`: compress the tail.
 * - Otherwise (mid-length remainder) → `continue`.
 */
export function chooseResumeStrategyV12(input: {
  wasThinking: boolean;
  cutWordIndex: number;
  remainingText: string;
  userText: string;
  options: Required<BargeInV12Options>;
}): { strategy: BargeInV12ResumeStrategy; reason: string } {
  const userFirst = input.userText.trim().split(/\s+/)[0]?.toLowerCase().replace(/[?!.,]+$/, '') ?? '';
  if (input.userText.trim().length > 0 && (BARGE_IN_V12_NEW_TURN_WORDS.has(userFirst) || /\?\s*$/.test(input.userText.trim()))) {
    return { strategy: 'drop', reason: 'user asked something new — answer them instead of finishing the old reply' };
  }
  if (input.wasThinking) {
    return { strategy: 'restart', reason: 'agent was still thinking — nothing was spoken yet' };
  }
  if (input.cutWordIndex >= 0 && input.cutWordIndex <= input.options.restartMaxCutIndex) {
    return { strategy: 'restart', reason: `cut at word ${input.cutWordIndex} — too early to resume mid-sentence` };
  }
  const remaining = input.remainingText.trim();
  if (remaining.length === 0) {
    return { strategy: 'drop', reason: 'nothing left to say — the reply had finished' };
  }
  if (remaining.length <= input.options.continueMaxChars) {
    return { strategy: 'continue', reason: `only ${remaining.length} chars left — finish the sentence` };
  }
  if (remaining.length >= input.options.summarizeMinChars) {
    return { strategy: 'summarize', reason: `${remaining.length} chars left — compress the tail before re-speaking` };
  }
  return { strategy: 'continue', reason: `${remaining.length} chars left — finish the sentence` };
}

/**
 * Compress a long remainder into one short sentence: keep the
 * first sentence (or the first 120 chars at a word boundary) and
 * mark it as a summary. Deterministic, no model — the live model
 * re-summarizes properly from `resumePrompt` when it resumes.
 */
export function summarizeRemainderV12(remainingText: string): string {
  const text = remainingText.trim();
  if (!text) return '';
  const firstSentence = text.match(/^[^.!?…]+[.!?…]/);
  if (firstSentence && firstSentence[0].length >= 20) return firstSentence[0].trim();
  if (text.length <= 120) return text;
  const cut = text.slice(0, 120);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/**
 * Build the resume prompt for the model: what the agent was
 * saying, where it was cut, what the user said instead, and what
 * to do next. Returns '' when there is nothing to resume
 * (`drop` with no user text is still explained, so the model
 * knows the reply was abandoned).
 */
export function buildResumePromptV12(record: InterruptedUtteranceV12): string {
  const lines = [
    '[Interrupted reply — barge-in v12]',
    `You were saying: "${record.replyText}"`,
    record.wasThinking
      ? 'You were cut off while still thinking — the user heard nothing.'
      : `The user heard: "${record.playedText}" and was cut off at the word "${record.cutWord}".`,
    record.remainingText
      ? `Unfinished part the user never heard: "${record.remainingText}"`
      : 'There was nothing left unheard.',
  ];
  if (record.userInterruption.text) {
    lines.push(`The user interrupted saying: "${record.userInterruption.text}"`);
  }
  lines.push(
    record.resumeStrategy === 'continue'
      ? `Resume by speaking the unfinished part: "${record.resumeText}"`
      : record.resumeStrategy === 'restart'
        ? 'Start the reply again from the beginning.'
        : record.resumeStrategy === 'summarize'
          ? `Summarize the unfinished part briefly, then speak it: "${record.resumeText}"`
          : 'Drop this reply and answer what the user just said instead.',
  );
  return lines.join('\n');
}

/**
 * Interrupt context tracker: records every cut with its full
 * context and decides how (or whether) to resume. The caller
 * feeds user words as partial STT arrives and calls
 * `recordInterrupt` with the v11 receipt + the TTS cancel
 * receipt when the session cuts a reply.
 */
export class InterruptContextV12 {
  private readonly options: Required<BargeInV12Options>;
  private readonly sink: BargeInV12EventSink | null;
  private history: InterruptedUtteranceV12[] = [];
  private nextId = 1;
  private pendingUserWords: { word: string; confidence: number; atMs: number }[] = [];
  private latencies: number[] = [];
  private byStrategy: Record<BargeInV12ResumeStrategy, number> = {
    continue: 0, restart: 0, summarize: 0, drop: 0,
  };

  constructor(options: BargeInV12Options = {}, sink: BargeInV12EventSink | null = null) {
    this.options = validateBargeInV12Options(options);
    this.sink = sink;
  }

  getOptions(): Required<BargeInV12Options> {
    return { ...this.options };
  }

  /** Interrupted utterances, oldest first (copies). */
  getHistory(): InterruptedUtteranceV12[] {
    return this.history.map((r) => ({ ...r, wordsPlayed: [...r.wordsPlayed], wordsDiscarded: [...r.wordsDiscarded], userInterruption: { ...r.userInterruption, words: [...r.userInterruption.words] } }));
  }

  /** Latest interrupted utterance, or null when none. */
  getLast(): InterruptedUtteranceV12 | null {
    const r = this.history[this.history.length - 1];
    return r ? this.getHistory()[this.history.length - 1] as InterruptedUtteranceV12 : null;
  }

  getStats(): BargeInV12Stats {
    const remaining = this.history.map((r) => r.remainingText.length);
    const played = this.history.map((r) => r.playedText.length);
    const mean = (xs: number[]): number => (xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));
    return {
      interrupts: this.history.length,
      byStrategy: { ...this.byStrategy },
      meanRemainingChars: mean(remaining),
      meanPlayedChars: mean(played),
      meanLatencyMs: this.latencies.length > 0 ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) : null,
      maxLatencyMs: this.latencies.length > 0 ? Math.max(...this.latencies) : null,
      withUserWords: this.history.filter((r) => r.userInterruption.words.length > 0).length,
      history: this.history.length,
    };
  }

  /**
   * Feed one partial-STT word the user spoke while interrupting.
   * Words accumulate until `recordInterrupt` consumes them (or
   * `clearPendingUserWords` drops them).
   */
  noteUserWord(word: string, atMs: number, confidence = 1): void {
    const clean = word.trim();
    if (!clean) return;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('Barge-in v12 word confidence must be a number in 0..1.');
    }
    this.pendingUserWords.push({ word: clean, confidence, atMs });
    this.sink?.({ kind: 'user-word', word: clean, atMs, confidence });
  }

  /** Drop the pending interruption words without recording them. */
  clearPendingUserWords(): void {
    this.pendingUserWords = [];
  }

  /** Words currently pending (copies). */
  getPendingUserWords(): { word: string; confidence: number; atMs: number }[] {
    return this.pendingUserWords.map((w) => ({ ...w }));
  }

  /**
   * Record a cut. `replyText` is the full agent reply the cut
   * came from; the v11 receipt supplies the exact cut point and
   * the TTS receipt supplies the cancelled chunks. Consumes the
   * pending user words as the interruption transcript.
   */
  recordInterrupt(input: {
    receipt: BargeInV11InterruptResult;
    tts: TtsStreamCancelResult;
    replyText: string;
    strategy?: BargeInV12ResumeStrategy;
  }): InterruptedUtteranceV12 {
    const { receipt, tts } = input;
    const replyText = input.replyText.trim();
    const remainingText = receipt.wordsDiscarded.join(' ');
    const playedText = receipt.wordsPlayed.join(' ');
    const userWords = this.pendingUserWords.splice(0, this.pendingUserWords.length);
    const userConfidence = userWords.length > 0
      ? Math.round((userWords.reduce((a, w) => a + w.confidence, 0) / userWords.length) * 100) / 100
      : 1;
    const userInterruption: BargeInV12UserInterruption = {
      words: userWords.map((w) => w.word),
      text: userWords.map((w) => w.word).join(' '),
      confidence: userConfidence,
      startedAtMs: userWords.length > 0 ? (userWords[0] as { atMs: number }).atMs : null,
      endedAtMs: userWords.length > 0 ? (userWords[userWords.length - 1] as { atMs: number }).atMs : null,
    };
    const chosen = input.strategy ?? chooseResumeStrategyV12({
      wasThinking: receipt.wasThinking,
      cutWordIndex: receipt.cutWordIndex,
      remainingText,
      userText: userInterruption.text,
      options: this.options,
    }).strategy;
    const reason = input.strategy
      ? 'strategy overridden by the caller'
      : chooseResumeStrategyV12({
        wasThinking: receipt.wasThinking,
        cutWordIndex: receipt.cutWordIndex,
        remainingText,
        userText: userInterruption.text,
        options: this.options,
      }).reason;
    const resumeText = chosen === 'continue'
      ? remainingText
      : chosen === 'restart'
        ? replyText
        : chosen === 'summarize'
          ? summarizeRemainderV12(remainingText)
          : '';
    const record: InterruptedUtteranceV12 = {
      id: this.nextId,
      atMs: receipt.atMs,
      replyText,
      cutWord: receipt.cutWord,
      cutWordIndex: receipt.cutWordIndex,
      wordsPlayed: [...receipt.wordsPlayed],
      wordsDiscarded: [...receipt.wordsDiscarded],
      playedText,
      remainingText,
      playedMs: receipt.playedMs,
      discardedMs: receipt.discardedMs,
      wasThinking: receipt.wasThinking,
      latencyMs: receipt.latencyMs,
      userInterruption,
      resumeStrategy: chosen,
      resumeReason: reason,
      resumeText,
      resumePrompt: '',
      ttsChunksCancelled: tts.chunksCancelled,
      ttsCharsDiscarded: tts.charsDiscarded,
    };
    record.resumePrompt = buildResumePromptV12(record);
    this.nextId += 1;
    if (receipt.latencyMs !== null) this.latencies.push(receipt.latencyMs);
    this.byStrategy[chosen] += 1;
    this.history.push(record);
    if (this.history.length > this.options.maxHistory) {
      this.history.splice(0, this.history.length - this.options.maxHistory);
    }
    this.sink?.({ kind: 'interrupt-recorded', record: { ...record } });
    return { ...record, wordsPlayed: [...record.wordsPlayed], wordsDiscarded: [...record.wordsDiscarded] };
  }

  /**
   * Change the resume strategy of a recorded interruption
   * (e.g. the user / agent picks a different recovery).
   * Rebuilds `resumeText` and `resumePrompt` for the new
   * strategy. Returns the updated record, or null when unknown.
   */
  setStrategy(id: number, strategy: BargeInV12ResumeStrategy, atMs: number): InterruptedUtteranceV12 | null {
    if (!isBargeInV12ResumeStrategy(strategy)) {
      throw new Error('Barge-in v12 strategy must be "continue", "restart", "summarize" or "drop".');
    }
    const record = this.history.find((r) => r.id === id);
    if (!record) return null;
    this.byStrategy[record.resumeStrategy] -= 1;
    this.byStrategy[strategy] += 1;
    record.resumeStrategy = strategy;
    record.resumeReason = 'strategy changed by the caller';
    record.resumeText = strategy === 'continue'
      ? record.remainingText
      : strategy === 'restart'
        ? record.replyText
        : strategy === 'summarize'
          ? summarizeRemainderV12(record.remainingText)
          : '';
    record.resumePrompt = buildResumePromptV12(record);
    this.sink?.({ kind: 'strategy-changed', id, strategy, atMs });
    return { ...record, wordsPlayed: [...record.wordsPlayed], wordsDiscarded: [...record.wordsDiscarded] };
  }

  /** Reset all history and counters. */
  reset(): void {
    this.history = [];
    this.nextId = 1;
    this.pendingUserWords = [];
    this.latencies = [];
    this.byStrategy = { continue: 0, restart: 0, summarize: 0, drop: 0 };
  }
}

/** Create an interrupt-context tracker (factory). */
export function createInterruptContextV12(options: BargeInV12Options = {}, sink: BargeInV12EventSink | null = null): InterruptContextV12 {
  return new InterruptContextV12(options, sink);
}

/** One-line summary of interrupt-context stats. */
export function bargeInV12Summary(stats: BargeInV12Stats): string {
  return (
    `Barge-in v12: ${stats.interrupts} interrupts ` +
    `(continue ${stats.byStrategy.continue}, restart ${stats.byStrategy.restart}, ` +
    `summarize ${stats.byStrategy.summarize}, drop ${stats.byStrategy.drop}), ` +
    `mean remaining ${stats.meanRemainingChars} chars, mean played ${stats.meanPlayedChars} chars, ` +
    `${stats.withUserWords} with user words, mean latency ${stats.meanLatencyMs === null ? '-' : `${stats.meanLatencyMs} ms`}`
  );
}

/** Interrupt-context stats as Markdown (for the diagnostics panel). */
export function bargeInV12Markdown(stats: BargeInV12Stats): string {
  const lines = [
    '## Barge-in v12 (interrupt context)',
    '',
    `- interrupts: ${stats.interrupts}`,
    `- resume: continue ${stats.byStrategy.continue}, restart ${stats.byStrategy.restart}, summarize ${stats.byStrategy.summarize}, drop ${stats.byStrategy.drop}`,
    `- mean remaining: ${stats.meanRemainingChars} chars, mean played: ${stats.meanPlayedChars} chars`,
    `- mean latency: ${stats.meanLatencyMs === null ? '-' : `${stats.meanLatencyMs} ms`}, max latency: ${stats.maxLatencyMs === null ? '-' : `${stats.maxLatencyMs} ms`}`,
    `- with user words: ${stats.withUserWords}, history: ${stats.history}`,
  ];
  return lines.join('\n');
}
