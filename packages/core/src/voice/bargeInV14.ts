/**
 * Barge-in v2 (v1.15, Đội T5 — voice realtime v14).
 *
 * v13 owns the cut: policy gate → cancel scope → TTS flush →
 * v11 interrupt → v12 record. What it does not own is the
 * *pipeline the cut has to stop*: VAD, STT, LLM and TTS run in
 * one shared flow, so a barge-in while the LLM is still
 * generating can leak a half-generated reply into the TTS
 * queue after the user has already spoken, and a cut mid-
 * sentence has no measured latency (how long from the VAD
 * speech-start to the audio actually stopping?).
 *
 * v14 separates the four stages into bounded queues with
 * their own drop policies, and measures the cut:
 *
 *   VAD queue ──▶ STT queue ──▶ LLM queue ──▶ TTS queue
 *      │             │             │             │
 *      └────── barge-in ──▶ flush all four queues,
 *                           cancel the LLM scope, flush TTS,
 *                           record the cut + its latency
 *
 *   - `StageQueueV14`: a bounded FIFO per stage with a drop
 *     policy (`drop-oldest` for VAD frames, `drop-newest`
 *     for LLM tokens, `reject` for TTS chunks that must not
 *     be lost silently); every enqueue / dequeue / drop is
 *     counted, so the panel can see where work piles up.
 *   - `VoicePipelineV14`: the four queues plus the v13 cancel
 *     scope; `cut()` flushes all four, cancels the scope and
 *     returns a cut receipt with per-queue discards and the
 *     cut latency (VAD speech-start → audio stopped).
 *   - `BargeInEngineV14`: wraps `BargeInEngineV13` and adds
 *     the pipeline + a mid-sentence cut: `cutMidSentence`
 *     splits the reply at the played char count, keeps the
 *     played prefix in the transcript and hands the remainder
 *     to the v12 resume record — with a test that cuts the
 *     reply in the middle of a sentence and checks the split.
 *
 * No audio device, no network, no model: queues hold opaque
 * caller-owned items (frames, tokens, chunks); the engine
 * only counts and drops them on the virtual clock.
 */

import {
  BargeInEngineV13,
  CancelScopeV13,
  type BargeInV13Options,
  type BargeInV13Event,
  type BargeInV13Stats,
  type BargeInV13CutResult,
  type CancelScopeV13Event,
} from './bargeInV13';
import type { BargeInV11InterruptResult } from './bargeInV11';
import type { InterruptedUtteranceV12 } from './bargeInV12';

/** Pipeline stages (one queue each). */
export type VoicePipelineV14Stage = 'vad' | 'stt' | 'llm' | 'tts';

/** The pipeline stages, in flow order. */
export const VOICE_PIPELINE_V14_STAGES: readonly VoicePipelineV14Stage[] = ['vad', 'stt', 'llm', 'tts'];

/** What a full queue does with a new item. */
export type VoicePipelineV14DropPolicy = 'drop-oldest' | 'drop-newest' | 'reject';

/** One item in a stage queue (opaque payload + metadata). */
export interface VoicePipelineV14Item<T = unknown> {
  id: string;
  payload: T;
  atMs: number;
  /** Estimated cost of the item (ms of audio, tokens, chars — stage-defined). */
  cost: number;
}

/** Result of enqueueing one item. */
export type VoicePipelineV14EnqueueResult =
  | { accepted: true; dropped: VoicePipelineV14Item | null }
  | { accepted: false; dropped: null; reason: string };

/** Counters for one stage queue. */
export interface VoicePipelineV14QueueStats {
  stage: VoicePipelineV14Stage;
  enqueued: number;
  dequeued: number;
  dropped: number;
  rejected: number;
  flushed: number;
  depth: number;
  maxDepth: number;
  /** Total cost currently queued. */
  queuedCost: number;
}

/** Options for one stage queue. */
export interface VoicePipelineV14QueueOptions {
  /** Max items held (default 100). */
  capacity?: number;
  /** Drop policy when full (default per stage: vad drop-oldest, stt drop-oldest, llm drop-newest, tts reject). */
  dropPolicy?: VoicePipelineV14DropPolicy;
}

/** Default drop policy per stage. */
export function defaultDropPolicyV14(stage: VoicePipelineV14Stage): VoicePipelineV14DropPolicy {
  switch (stage) {
    case 'vad': return 'drop-oldest';
    case 'stt': return 'drop-oldest';
    case 'llm': return 'drop-newest';
    case 'tts': return 'reject';
    default: return 'drop-oldest';
  }
}

export function validateVoicePipelineV14QueueOptions(
  stage: VoicePipelineV14Stage,
  options: VoicePipelineV14QueueOptions,
): { capacity: number; dropPolicy: VoicePipelineV14DropPolicy } {
  const capacity = options.capacity ?? 100;
  if (!Number.isFinite(capacity) || capacity < 1 || capacity > 100000) {
    throw new Error(`Voice pipeline v14 queue (${stage}) capacity must be a finite number in [1, 100000].`);
  }
  const dropPolicy = options.dropPolicy ?? defaultDropPolicyV14(stage);
  if (!['drop-oldest', 'drop-newest', 'reject'].includes(dropPolicy)) {
    throw new Error(`Voice pipeline v14 queue (${stage}) dropPolicy must be "drop-oldest", "drop-newest" or "reject".`);
  }
  return { capacity: Math.floor(capacity), dropPolicy };
}

/**
 * One bounded stage queue. FIFO; when full, the drop policy
 * decides: `drop-oldest` removes the head to make room,
 * `drop-newest` discards the incoming item, `reject` refuses
 * it (the caller keeps the item). All three are counted.
 */
export class StageQueueV14<T = unknown> {
  readonly stage: VoicePipelineV14Stage;
  private readonly capacity: number;
  private readonly dropPolicy: VoicePipelineV14DropPolicy;
  private items: VoicePipelineV14Item<T>[] = [];
  private enqueued = 0;
  private dequeued = 0;
  private dropped = 0;
  private rejected = 0;
  private flushed = 0;
  private maxDepth = 0;

  constructor(stage: VoicePipelineV14Stage, options: VoicePipelineV14QueueOptions = {}) {
    const validated = validateVoicePipelineV14QueueOptions(stage, options);
    this.stage = stage;
    this.capacity = validated.capacity;
    this.dropPolicy = validated.dropPolicy;
  }

  getCapacity(): number {
    return this.capacity;
  }

  getDropPolicy(): VoicePipelineV14DropPolicy {
    return this.dropPolicy;
  }

  depth(): number {
    return this.items.length;
  }

  enqueue(item: VoicePipelineV14Item<T>): VoicePipelineV14EnqueueResult {
    if (!item.id.trim()) throw new Error(`Voice pipeline v14 queue (${this.stage}) item id must be a non-empty string.`);
    if (this.items.length >= this.capacity) {
      if (this.dropPolicy === 'reject') {
        this.rejected += 1;
        return { accepted: false, dropped: null, reason: `queue ${this.stage} is full (${this.capacity})` };
      }
      if (this.dropPolicy === 'drop-oldest') {
        const dropped = this.items.shift() as VoicePipelineV14Item<T>;
        this.dropped += 1;
        this.items.push(item);
        this.enqueued += 1;
        this.maxDepth = Math.max(this.maxDepth, this.items.length);
        return { accepted: true, dropped };
      }
      // drop-newest: the incoming item is discarded.
      this.dropped += 1;
      return { accepted: true, dropped: item };
    }
    this.items.push(item);
    this.enqueued += 1;
    this.maxDepth = Math.max(this.maxDepth, this.items.length);
    return { accepted: true, dropped: null };
  }

  /** Remove and return the head item, or null when empty. */
  dequeue(): VoicePipelineV14Item<T> | null {
    const item = this.items.shift();
    if (!item) return null;
    this.dequeued += 1;
    return item;
  }

  /** Peek at the head item without removing it. */
  peek(): VoicePipelineV14Item<T> | null {
    return this.items[0] ?? null;
  }

  /** Remove all items (a barge-in flush). Returns the discarded items. */
  flush(): VoicePipelineV14Item<T>[] {
    const discarded = this.items;
    this.items = [];
    this.flushed += discarded.length;
    return discarded;
  }

  /** Queued items, oldest first (copies of the wrappers, same payloads). */
  list(): VoicePipelineV14Item<T>[] {
    return [...this.items];
  }

  getStats(): VoicePipelineV14QueueStats {
    return {
      stage: this.stage,
      enqueued: this.enqueued,
      dequeued: this.dequeued,
      dropped: this.dropped,
      rejected: this.rejected,
      flushed: this.flushed,
      depth: this.items.length,
      maxDepth: this.maxDepth,
      queuedCost: this.items.reduce((a, i) => a + i.cost, 0),
    };
  }

  reset(): void {
    this.items = [];
    this.enqueued = 0;
    this.dequeued = 0;
    this.dropped = 0;
    this.rejected = 0;
    this.flushed = 0;
    this.maxDepth = 0;
  }
}

/** Options for the pipeline (per-stage queue options). */
export interface VoicePipelineV14Options {
  vad?: VoicePipelineV14QueueOptions;
  stt?: VoicePipelineV14QueueOptions;
  llm?: VoicePipelineV14QueueOptions;
  tts?: VoicePipelineV14QueueOptions;
}

/** One pipeline cut: per-queue discards + scope + latency. */
export interface VoicePipelineV14Cut {
  atMs: number;
  /** VAD speech-start that triggered the cut (ms). */
  vadStartedAtMs: number;
  /** Cut latency: VAD speech-start → audio stopped (ms). */
  cutLatencyMs: number;
  /** Items discarded per stage. */
  discarded: Record<VoicePipelineV14Stage, number>;
  /** Cost discarded per stage. */
  discardedCost: Record<VoicePipelineV14Stage, number>;
  /** Stale LLM work cancelled. */
  staleWorkCancelled: number;
  totalDiscarded: number;
}

/** Counters for one pipeline. */
export interface VoicePipelineV14Stats {
  queues: Record<VoicePipelineV14Stage, VoicePipelineV14QueueStats>;
  cuts: number;
  /** Total items discarded by cuts. */
  cutDiscarded: number;
  /** Mean cut latency (ms, 0 when no cuts). */
  meanCutLatencyMs: number;
  /** Max cut latency (ms, 0 when no cuts). */
  maxCutLatencyMs: number;
  scope: { registered: number; cancelled: number; alreadyDone: number; pending: number; cancels: number };
}

/** Events emitted by the pipeline. */
export type VoicePipelineV14Event =
  | { kind: 'cut'; cut: VoicePipelineV14Cut }
  | { kind: 'scope'; event: CancelScopeV13Event };

export type VoicePipelineV14EventSink = (event: VoicePipelineV14Event) => void;

/**
 * The four-stage pipeline: one bounded queue per stage plus
 * the v13 cancel scope for stale LLM work. `cut()` flushes
 * every queue, cancels the scope and measures the cut latency
 * from the VAD speech-start the caller passes in.
 */
export class VoicePipelineV14 {
  private readonly queues: Record<VoicePipelineV14Stage, StageQueueV14>;
  private readonly scope: CancelScopeV13;
  private readonly sink: VoicePipelineV14EventSink | null;
  private cuts = 0;
  private cutDiscarded = 0;
  private cutLatencies: number[] = [];

  constructor(options: VoicePipelineV14Options = {}, sink: VoicePipelineV14EventSink | null = null) {
    this.queues = {
      vad: new StageQueueV14('vad', options.vad ?? {}),
      stt: new StageQueueV14('stt', options.stt ?? {}),
      llm: new StageQueueV14('llm', options.llm ?? {}),
      tts: new StageQueueV14('tts', options.tts ?? {}),
    };
    this.sink = sink;
    this.scope = new CancelScopeV13((event) => this.sink?.({ kind: 'scope', event }));
  }

  getQueue(stage: VoicePipelineV14Stage): StageQueueV14 {
    return this.queues[stage];
  }

  getScope(): CancelScopeV13 {
    return this.scope;
  }

  enqueue(stage: VoicePipelineV14Stage, item: VoicePipelineV14Item): VoicePipelineV14EnqueueResult {
    return this.queues[stage].enqueue(item);
  }

  dequeue(stage: VoicePipelineV14Stage): VoicePipelineV14Item | null {
    return this.queues[stage].dequeue();
  }

  /** Total depth across all four queues. */
  totalDepth(): number {
    return VOICE_PIPELINE_V14_STAGES.reduce((a, s) => a + this.queues[s].depth(), 0);
  }

  /**
   * Cut the pipeline: flush all four queues and cancel the
   * stale LLM scope. `vadStartedAtMs` is when the VAD first
   * heard the interrupting speech; the cut latency is
   * `atMs - vadStartedAtMs`.
   */
  cut(atMs: number, vadStartedAtMs: number, reason = 'barge-in'): VoicePipelineV14Cut {
    const discarded: Record<VoicePipelineV14Stage, number> = { vad: 0, stt: 0, llm: 0, tts: 0 };
    const discardedCost: Record<VoicePipelineV14Stage, number> = { vad: 0, stt: 0, llm: 0, tts: 0 };
    for (const stage of VOICE_PIPELINE_V14_STAGES) {
      const items = this.queues[stage].flush();
      discarded[stage] = items.length;
      discardedCost[stage] = items.reduce((a, i) => a + i.cost, 0);
    }
    const scopeResult = this.scope.cancelAll(atMs, reason);
    const totalDiscarded = VOICE_PIPELINE_V14_STAGES.reduce((a, s) => a + discarded[s], 0);
    const cutLatencyMs = Math.max(0, atMs - vadStartedAtMs);
    this.cuts += 1;
    this.cutDiscarded += totalDiscarded;
    this.cutLatencies.push(cutLatencyMs);
    const cut: VoicePipelineV14Cut = {
      atMs,
      vadStartedAtMs,
      cutLatencyMs,
      discarded,
      discardedCost,
      staleWorkCancelled: scopeResult.cancelled,
      totalDiscarded,
    };
    this.sink?.({ kind: 'cut', cut });
    return cut;
  }

  getStats(): VoicePipelineV14Stats {
    const mean = this.cutLatencies.length === 0
      ? 0
      : Math.round(this.cutLatencies.reduce((a, b) => a + b, 0) / this.cutLatencies.length);
    return {
      queues: {
        vad: this.queues.vad.getStats(),
        stt: this.queues.stt.getStats(),
        llm: this.queues.llm.getStats(),
        tts: this.queues.tts.getStats(),
      },
      cuts: this.cuts,
      cutDiscarded: this.cutDiscarded,
      meanCutLatencyMs: mean,
      maxCutLatencyMs: this.cutLatencies.length === 0 ? 0 : Math.max(...this.cutLatencies),
      scope: this.scope.getStats(),
    };
  }

  reset(): void {
    for (const stage of VOICE_PIPELINE_V14_STAGES) this.queues[stage].reset();
    this.scope.reset();
    this.cuts = 0;
    this.cutDiscarded = 0;
    this.cutLatencies = [];
  }
}

/** Create a voice pipeline v14 (factory). */
export function createVoicePipelineV14(
  options: VoicePipelineV14Options = {},
  sink: VoicePipelineV14EventSink | null = null,
): VoicePipelineV14 {
  return new VoicePipelineV14(options, sink);
}

/** Result of cutting a reply mid-sentence. Pure. */
export interface MidSentenceCutV14 {
  /** Text the user actually heard (played prefix). */
  playedText: string;
  /** Text not yet played (the remainder). */
  remainderText: string;
  /** Chars played. */
  playedChars: number;
  /** Chars remaining. */
  remainderChars: number;
  /** True when the cut landed inside a sentence (not at a boundary). */
  midSentence: boolean;
  /** The word the cut landed in ('' when the cut is on a word boundary). */
  cutWord: string;
}

/**
 * Split a reply at a played char count. Pure: the played
 * prefix is trimmed to the last word boundary so the
 * transcript never ends mid-word, and the remainder starts
 * at the next word. A cut exactly on a boundary reports
 * `midSentence: false` when the played prefix ends with
 * terminal punctuation.
 */
export function cutMidSentenceV14(replyText: string, playedChars: number): MidSentenceCutV14 {
  const text = replyText;
  if (playedChars <= 0) {
    return { playedText: '', remainderText: text, playedChars: 0, remainderChars: text.length, midSentence: false, cutWord: '' };
  }
  if (playedChars >= text.length) {
    return { playedText: text, remainderText: '', playedChars: text.length, remainderChars: 0, midSentence: false, cutWord: '' };
  }
  // Find the last word boundary at or before the cut. A cut
  // is inside a word only when both neighbours are word
  // characters (letters/digits) — punctuation and spaces are
  // boundaries, so a cut just before '.' keeps the word.
  const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  let cutAt = playedChars;
  let cutWord = '';
  if (isWordChar(text[cutAt]) && isWordChar(text[cutAt - 1])) {
    // Inside a word: find the word the cut landed in.
    let start = cutAt;
    while (start > 0 && isWordChar(text[start - 1])) start -= 1;
    let end = cutAt;
    while (end < text.length && isWordChar(text[end])) end += 1;
    cutWord = text.slice(start, end);
    cutAt = start;
  }
  const playedText = text.slice(0, cutAt).trimEnd();
  const remainderText = text.slice(cutAt).trimStart();
  const midSentence = !/[.!?…]\s*$/.test(playedText) && remainderText.length > 0;
  return {
    playedText,
    remainderText,
    playedChars: playedText.length,
    remainderChars: remainderText.length,
    midSentence,
    cutWord,
  };
}

/** Options for `BargeInEngineV14`. */
export interface BargeInV14Options extends BargeInV13Options {
  pipeline?: VoicePipelineV14Options;
}

/** One v14 cut: the v13 cut + the pipeline cut + the mid-sentence split. */
export interface BargeInV14CutResult {
  v13: BargeInV13CutResult;
  pipeline: VoicePipelineV14Cut | null;
  midSentence: MidSentenceCutV14 | null;
  atMs: number;
}

/** Counters for one v14 engine. */
export interface BargeInV14Stats {
  v13: BargeInV13Stats;
  pipeline: VoicePipelineV14Stats;
  midSentenceCuts: number;
  /** Cuts that landed inside a sentence. */
  midSentenceInside: number;
}

/** Events emitted by the v14 engine. */
export type BargeInV14Event =
  | { kind: 'v13'; event: BargeInV13Event }
  | { kind: 'pipeline'; event: VoicePipelineV14Event }
  | { kind: 'cut'; result: BargeInV14CutResult };

export type BargeInV14EventSink = (event: BargeInV14Event) => void;

/**
 * Barge-in engine v2: a v13 engine plus the four-stage
 * pipeline. VAD speech-starts go through the v13 gate; a cut
 * flushes the pipeline (all four queues + the LLM scope)
 * before the v13 engine records the interrupt, so no stale
 * LLM token or TTS chunk can leak out after the user spoke.
 * `cutMidSentence` is the testable mid-sentence path: it cuts
 * the reply at a played char count and reports the split.
 */
export class BargeInEngineV14 {
  private readonly inner: BargeInEngineV13;
  private readonly pipeline: VoicePipelineV14;
  private readonly sink: BargeInV14EventSink | null;
  private midSentenceCuts = 0;
  private midSentenceInside = 0;
  private lastCut: BargeInV14CutResult | null = null;

  constructor(options: BargeInV14Options = {}, sink: BargeInV14EventSink | null = null) {
    this.sink = sink;
    this.pipeline = new VoicePipelineV14(options.pipeline ?? {}, (event) => {
      this.sink?.({ kind: 'pipeline', event });
    });
    this.inner = new BargeInEngineV13(options, (event) => {
      this.sink?.({ kind: 'v13', event });
    });
  }

  getV13(): BargeInEngineV13 {
    return this.inner;
  }

  getPipeline(): VoicePipelineV14 {
    return this.pipeline;
  }

  getScope(): CancelScopeV13 {
    return this.pipeline.getScope();
  }

  setTtsQueue(queue: { cancelPending(): { cancelled: boolean; chunksCancelled: number; charsDiscarded: number; cutPlaying: boolean; cutChunkText: string; playedMs: number; discardedMs: number; atMs: number } } | null): void {
    this.inner.setTtsQueue(queue);
  }

  beginThinking(atMs: number): void {
    this.inner.beginThinking(atMs);
  }

  beginSpeaking(replyText: string, atMs: number, msPerChar = 55): void {
    this.inner.beginSpeaking(replyText, atMs, msPerChar);
  }

  advancePlayed(ms: number): void {
    this.inner.advancePlayed(ms);
  }

  finishSpeaking(atMs: number): void {
    this.inner.finishSpeaking(atMs);
  }

  noteUserWord(word: string, atMs: number, confidence = 1): void {
    this.inner.noteUserWord(word, atMs, confidence);
  }

  getPlayedTranscript(): string {
    return this.inner.getPlayedTranscript();
  }

  getLastInterrupt(): InterruptedUtteranceV12 | null {
    return this.inner.getLastInterrupt();
  }

  getLastCut(): BargeInV14CutResult | null {
    return this.lastCut;
  }

  decideCut(input: { speechMs: number; confidence?: number; echoOnly?: boolean; atMs: number }): { cut: boolean; reason: string } {
    return this.inner.decideCut(input);
  }

  /**
   * Feed a VAD speech-start. When the gate allows a cut, the
   * pipeline is flushed first (queues + LLM scope), then the
   * v13 engine cuts and records. Returns null when gated.
   */
  onVadSpeechStart(input: { atMs: number; speechMs: number; confidence?: number; echoOnly?: boolean }): BargeInV14CutResult | null {
    const decision = this.inner.decideCut(input);
    if (!decision.cut) {
      // Still count the speech-start through the inner engine
      // so its gated / ignored stats stay truthful.
      this.inner.onVadSpeechStart(input);
      return null;
    }
    const pipelineCut = this.pipeline.cut(input.atMs, input.atMs - input.speechMs, 'vad-speech-start');
    const v13Cut = this.inner.onVadSpeechStart(input);
    if (!v13Cut) return null;
    const result: BargeInV14CutResult = { v13: v13Cut, pipeline: pipelineCut, midSentence: null, atMs: input.atMs };
    this.lastCut = result;
    this.sink?.({ kind: 'cut', result });
    return result;
  }

  /** Cut now, unconditionally (explicit path). */
  cutNow(atMs: number, reason = 'explicit', vadStartedAtMs?: number): BargeInV14CutResult | null {
    const v13Cut = this.inner.cutNow(atMs, reason);
    if (!v13Cut) return null;
    // The v13 engine cut: flush the pipeline now (queues +
    // LLM scope) so no stale token or TTS chunk leaks out
    // after the user spoke.
    const pipelineCut = this.pipeline.cut(atMs, vadStartedAtMs ?? atMs, reason);
    const result: BargeInV14CutResult = { v13: v13Cut, pipeline: pipelineCut, midSentence: null, atMs };
    this.lastCut = result;
    this.sink?.({ kind: 'cut', result });
    return result;
  }

  /**
   * Cut a reply mid-sentence at a played char count: split
   * the reply, cut the engine, and attach the split to the
   * result. The played prefix stays in the transcript; the
   * remainder is what a resume would continue from.
   */
  cutMidSentence(replyText: string, playedChars: number, atMs: number, vadStartedAtMs?: number): BargeInV14CutResult | null {
    const split = cutMidSentenceV14(replyText, playedChars);
    const result = this.cutNow(atMs, 'mid-sentence', vadStartedAtMs);
    if (!result) return null;
    this.midSentenceCuts += 1;
    if (split.midSentence) this.midSentenceInside += 1;
    const withSplit: BargeInV14CutResult = { ...result, midSentence: split };
    this.lastCut = withSplit;
    return withSplit;
  }

  getStats(): BargeInV14Stats {
    return {
      v13: this.inner.getStats(),
      pipeline: this.pipeline.getStats(),
      midSentenceCuts: this.midSentenceCuts,
      midSentenceInside: this.midSentenceInside,
    };
  }

  reset(): void {
    this.inner.reset();
    this.pipeline.reset();
    this.midSentenceCuts = 0;
    this.midSentenceInside = 0;
    this.lastCut = null;
  }
}

/** Create a barge-in engine v2 (factory). */
export function createBargeInEngineV14(
  options: BargeInV14Options = {},
  sink: BargeInV14EventSink | null = null,
): BargeInEngineV14 {
  return new BargeInEngineV14(options, sink);
}

/** One-line summary of v14 barge-in stats. */
export function bargeInV14Summary(stats: BargeInV14Stats): string {
  return (
    `Barge-in v14: ${stats.v13.cuts} cuts / ${stats.v13.speechStarts} speech-starts, ` +
    `pipeline discarded ${stats.pipeline.cutDiscarded} items in ${stats.pipeline.cuts} cuts ` +
    `(mean cut latency ${stats.pipeline.meanCutLatencyMs} ms, max ${stats.pipeline.maxCutLatencyMs} ms), ` +
    `mid-sentence cuts ${stats.midSentenceCuts} (${stats.midSentenceInside} inside a sentence), ` +
    `stale work cancelled ${stats.v13.staleWorkCancelled}`
  );
}

/** Barge-in v14 stats as Markdown (for the diagnostics panel). */
export function bargeInV14Markdown(stats: BargeInV14Stats): string {
  const lines = [
    '## Barge-in v14 (engine v2 + pipeline)',
    '',
    `- speech-starts: ${stats.v13.speechStarts}, cuts: ${stats.v13.cuts}, ignored: ${stats.v13.ignored}`,
    `- pipeline: ${stats.pipeline.cuts} cuts, ${stats.pipeline.cutDiscarded} items discarded, ` +
      `mean cut latency ${stats.pipeline.meanCutLatencyMs} ms, max ${stats.pipeline.maxCutLatencyMs} ms`,
    `- queues: ${VOICE_PIPELINE_V14_STAGES.map((s) => `${s} depth ${stats.pipeline.queues[s].depth} (dropped ${stats.pipeline.queues[s].dropped}, rejected ${stats.pipeline.queues[s].rejected})`).join(', ')}`,
    `- mid-sentence cuts: ${stats.midSentenceCuts} (${stats.midSentenceInside} inside a sentence)`,
    `- played kept: ${stats.v13.playedCharsKept} chars, TTS discarded: ${stats.v13.ttsCharsDiscarded} chars, stale work cancelled: ${stats.v13.staleWorkCancelled}`,
  ];
  return lines.join('\n');
}
