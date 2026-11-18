/**
 * TTS streaming v4 (v1.19, Đội T5 — voice v18).
 *
 * v17 spoke while the reply was still arriving (sentence by
 * sentence, priority chunk queue, cancel-unplayed for barge-in),
 * but it trusted the sentence as the unit: a 400-character
 * sentence still waited for its own synthesis before the first
 * chunk could play, and a `background` sentence queued behind a
 * long `normal` one waited for the whole reply. v18 wraps the v17
 * stream and adds the scheduling layer a live reply needs:
 *
 *   1. Long-sentence splitting. A sentence longer than
 *      `maxChunkChars` is split at clause boundaries first
 *      (commas, semicolons, colons, dashes, and the conjunctions
 *      `and` / `but` / `so` / `và` / `nhưng` / `rồi` / `thì`), and
 *      only an overlong clause is hard-split at word boundaries —
 *      so a long answer starts speaking after the first clause,
 *      not after the last word. Every split is counted, so the
 *      panel can show how much of a reply was re-chunked.
 *   2. Priority queue with aging. Sentences wait in a v18 queue
 *      before entering the v17 stream: `urgent` first, then
 *      `normal`, then `background` — but a `normal` sentence that
 *      has waited longer than `ageThresholdMs` is promoted to
 *      urgent (a correction that waits forever is a bug, not a
 *      queue), and a `background` sentence that has waited longer
 *      than `backgroundAgeThresholdMs` is promoted to normal. The
 *      queue is bounded: over `maxQueuedSentences` the oldest
 *      `background` sentence is dropped first (and counted), then
 *      the oldest `normal` one — `urgent` is never dropped.
 *   3. Flow control. `pump()` moves sentences from the v18 queue
 *      into the v17 stream only while the stream has fewer than
 *      `maxBufferedSentences` scheduled — the synth is never asked
 *      to hold a whole reply, and an underrun is still the v17
 *      stream's job to report. Queue wait (enqueue → feed) is
 *      measured per sentence and reported as average + p95.
 *   4. The v17 guarantees carry over unchanged: first-chunk
 *      latency (average + p95), gapless joins, underrun detection
 *      + silence pad, pause/resume shifting the timeline,
 *      cancel-unplayed keeping the spoken prefix, rate-adjusted
 *      chunk durations from the voice profile.
 *
 * The synth is injected (mock in tests, a real provider adapter in
 * production); the scheduler only ever sees ready-times and
 * durations. Virtual clock, no sound card.
 */

import {
  TtsStreamV17,
  createTtsStreamV17,
  defaultTtsStreamV17Options,
  validateTtsStreamV17Options,
  splitSentencesV17,
  percentileV17,
  TTS_V17_DEFAULT_MAX_CHUNK_CHARS,
  type TtsStreamV17Options,
  type TtsStreamV17Sink,
  type TtsStreamV17Stats,
  type TtsV17ChunkPriority,
} from '../voiceV17/ttsStreamV17';
import { mockTtsSynthV15, type TtsSynthV15, type VoiceProfileV15 } from '../voiceV15/ttsStreamV15';

/**
 * TTS quality ladder (v1.20, Đội T5 — additive, voice budget v18).
 * The v18 stream itself has no quality setting; the ladder is the
 * shared vocabulary the voice budget meter uses to degrade
 * gracefully (high → standard → fast) when a budget is nearly
 * spent. Pure: one step down, `fast` stays `fast`.
 */
export type TtsV18Quality = 'high' | 'standard' | 'fast';

const TTS_V18_QUALITY_LADDER: TtsV18Quality[] = ['high', 'standard', 'fast'];

export function downgradeQualityV18(quality: TtsV18Quality): TtsV18Quality {
  const index = TTS_V18_QUALITY_LADDER.indexOf(quality);
  return TTS_V18_QUALITY_LADDER[Math.min(TTS_V18_QUALITY_LADDER.length - 1, index + 1)] as TtsV18Quality;
}

/** Clause boundaries a long sentence may split at (kept in order). */
const CLAUSE_SPLIT_RE = /([,;:—–-])\s+|\s+((?:and|but|so|or|và|nhưng|rồi|thì|nên|vì)\s+)/i;

/**
 * Split one long sentence into speakable clauses. Short sentences
 * pass through untouched; a long sentence splits at clause
 * boundaries first, and an overlong clause is hard-split at word
 * boundaries so no piece exceeds `maxChars`.
 */
export function splitLongSentenceV18(sentence: string, maxChars: number): string[] {
  const trimmed = sentence.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];
  const clauses: string[] = [];
  let rest = trimmed;
  while (rest.length > maxChars) {
    const head = rest.slice(0, maxChars + 1);
    const match = head.match(CLAUSE_SPLIT_RE);
    let cut = -1;
    if (match && match.index !== undefined) {
      // Cut after the boundary token (keep the punctuation / word).
      cut = match.index + match[0].length;
    }
    if (cut <= 0 || cut >= rest.length) {
      // No clause boundary in range: hard-split at the last space.
      const space = rest.lastIndexOf(' ', maxChars);
      cut = space > 0 ? space : maxChars;
    }
    clauses.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) clauses.push(rest);
  return clauses.filter((c) => c.length > 0);
}

/** One sentence waiting in the v18 queue. */
export interface TtsV18QueuedSentence {
  id: string;
  text: string;
  priority: TtsV17ChunkPriority;
  enqueuedAtMs: number;
  /** True once aging promoted this sentence. */
  promoted: boolean;
  /** True when this sentence came from splitting a long sentence. */
  fromLongSentence: boolean;
}

/** Options for `TtsStreamV18` (everything v17 takes, plus the v18 layer). */
export interface TtsStreamV18Options extends TtsStreamV17Options {
  /** Sentences waiting longer than this are promoted one priority step (ms, default 3000). */
  ageThresholdMs?: number;
  /** Background sentences wait this long before promotion to normal (ms, default 8000). */
  backgroundAgeThresholdMs?: number;
  /** Max sentences waiting in the v18 queue (default 32). */
  maxQueuedSentences?: number;
  /** Max sentences buffered inside the v17 stream before pump() pauses (default 4). */
  maxBufferedSentences?: number;
}

export function defaultTtsStreamV18Options(): Required<TtsStreamV18Options> {
  return {
    ...defaultTtsStreamV17Options(),
    ageThresholdMs: 3000,
    backgroundAgeThresholdMs: 8000,
    maxQueuedSentences: 32,
    maxBufferedSentences: 4,
  };
}

export function validateTtsStreamV18Options(options: TtsStreamV18Options): string[] {
  const errors = validateTtsStreamV17Options(options);
  const check = (name: keyof TtsStreamV18Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('ageThresholdMs', options.ageThresholdMs, 0, 60000);
  check('backgroundAgeThresholdMs', options.backgroundAgeThresholdMs, 0, 120000);
  check('maxQueuedSentences', options.maxQueuedSentences, 1, 500);
  check('maxBufferedSentences', options.maxBufferedSentences, 1, 64);
  if (
    options.ageThresholdMs !== undefined &&
    options.backgroundAgeThresholdMs !== undefined &&
    options.backgroundAgeThresholdMs < options.ageThresholdMs
  ) {
    errors.push('backgroundAgeThresholdMs must not be smaller than ageThresholdMs');
  }
  return errors;
}

export interface TtsStreamV18Stats extends TtsStreamV17Stats {
  queuedSentences: number;
  enqueuedSentences: number;
  droppedSentences: number;
  promotedSentences: number;
  longSentencesSplit: number;
  clausesProduced: number;
  averageQueueWaitMs: number;
  p95QueueWaitMs: number;
}

const PRIORITY_RANK: Record<TtsV17ChunkPriority, number> = { urgent: 0, normal: 1, background: 2 };

function promotePriority(p: TtsV17ChunkPriority): TtsV17ChunkPriority {
  if (p === 'background') return 'normal';
  if (p === 'normal') return 'urgent';
  return 'urgent';
}

/**
 * TTS streaming v4: a v17 stream plus a clause splitter, a
 * priority queue with aging, and flow control into the stream.
 */
export class TtsStreamV18 {
  /** The wrapped v17 stream (synthesis + playout timeline live here). */
  readonly stream: TtsStreamV17;
  private readonly options: Required<TtsStreamV18Options>;
  private queue: TtsV18QueuedSentence[] = [];
  private nowMs = 0;
  private utteranceOpen = false;
  private sentenceSeq = 0;
  private enqueuedSentences = 0;
  private droppedSentences = 0;
  private promotedSentences = 0;
  private longSentencesSplit = 0;
  private clausesProduced = 0;
  private queueWaitsMs: number[] = [];

  constructor(synth: TtsSynthV15 = mockTtsSynthV15, options: TtsStreamV18Options = {}, sink?: TtsStreamV17Sink) {
    const errors = validateTtsStreamV18Options(options);
    if (errors.length > 0) throw new Error(`invalid TTS stream v18 options: ${errors.join('; ')}`);
    this.options = { ...defaultTtsStreamV18Options(), ...options };
    this.stream = createTtsStreamV17(synth, this.options, sink);
  }

  now(): number {
    return this.nowMs;
  }

  getState(): ReturnType<TtsStreamV17['getState']> {
    return this.stream.getState();
  }

  isSpeaking(): boolean {
    return this.stream.isSpeaking();
  }

  isPaused(): boolean {
    return this.stream.isPaused();
  }

  beginUtterance(profile: VoiceProfileV15, atMs?: number): void {
    if (atMs !== undefined) this.nowMs = atMs;
    this.utteranceOpen = true;
    this.stream.beginUtterance(profile, this.nowMs);
  }

  /**
   * Enqueue reply text: split into sentences, split long sentences
   * into clauses, queue each piece with its priority. Nothing is
   * spoken until `pump()` moves pieces into the stream.
   */
  enqueue(text: string, priority: TtsV17ChunkPriority = 'normal', atMs?: number): TtsV18QueuedSentence[] {
    if (atMs !== undefined) this.nowMs = atMs;
    const sentences = splitSentencesV17(text);
    const added: TtsV18QueuedSentence[] = [];
    for (const sentence of sentences) {
      const pieces = splitLongSentenceV18(sentence, this.options.maxChunkChars);
      if (pieces.length > 1) {
        this.longSentencesSplit += 1;
        this.clausesProduced += pieces.length;
      }
      for (const piece of pieces) {
        this.sentenceSeq += 1;
        const item: TtsV18QueuedSentence = {
          id: `s-v18-${this.sentenceSeq}`,
          text: piece,
          priority,
          enqueuedAtMs: this.nowMs,
          promoted: false,
          fromLongSentence: pieces.length > 1,
        };
        this.queue.push(item);
        added.push(item);
        this.enqueuedSentences += 1;
      }
    }
    this.dropOverflow();
    return added;
  }

  /** Drop the oldest low-priority sentences while the queue is over capacity. */
  private dropOverflow(): void {
    while (this.queue.length > this.options.maxQueuedSentences) {
      const idx = this.queue.findIndex((q) => q.priority === 'background');
      const dropAt = idx >= 0 ? idx : this.queue.findIndex((q) => q.priority === 'normal');
      if (dropAt < 0) break; // only urgent sentences remain — never drop them
      this.queue.splice(dropAt, 1);
      this.droppedSentences += 1;
    }
  }

  /** Promote sentences that have waited too long (aging). Returns how many were promoted. */
  promoteAged(atMs?: number): number {
    if (atMs !== undefined) this.nowMs = atMs;
    let promoted = 0;
    for (const item of this.queue) {
      const waited = this.nowMs - item.enqueuedAtMs;
      const threshold = item.priority === 'background' ? this.options.backgroundAgeThresholdMs : this.options.ageThresholdMs;
      if (waited >= threshold && item.priority !== 'urgent') {
        item.priority = promotePriority(item.priority);
        item.promoted = true;
        promoted += 1;
        this.promotedSentences += 1;
      }
    }
    return promoted;
  }

  /** Pick the next sentence to speak: urgent first, then oldest of the highest priority. */
  private pickNext(): TtsV18QueuedSentence | undefined {
    if (this.queue.length === 0) return undefined;
    let bestIdx = 0;
    for (let i = 1; i < this.queue.length; i += 1) {
      const a = this.queue[i];
      const b = this.queue[bestIdx];
      if (PRIORITY_RANK[a.priority] < PRIORITY_RANK[b.priority]) bestIdx = i;
      else if (PRIORITY_RANK[a.priority] === PRIORITY_RANK[b.priority] && a.enqueuedAtMs < b.enqueuedAtMs) bestIdx = i;
    }
    return this.queue[bestIdx];
  }

  /**
   * Move queued sentences into the v17 stream while it has room.
   * Returns how many sentences were fed. Call after `enqueue()` and
   * after `tick()` (the stream drains as it plays).
   */
  pump(atMs?: number): number {
    if (atMs !== undefined) this.nowMs = atMs;
    this.promoteAged(this.nowMs);
    let fed = 0;
    while (this.queue.length > 0) {
      const scheduled = this.stream.schedule().length;
      if (scheduled >= this.options.maxBufferedSentences) break;
      const next = this.pickNext();
      if (!next) break;
      this.queue.splice(this.queue.indexOf(next), 1);
      this.queueWaitsMs.push(this.nowMs - next.enqueuedAtMs);
      this.stream.feedSentence(next.text, next.priority, this.nowMs);
      fed += 1;
    }
    return fed;
  }

  /** One-shot speak: open an utterance, enqueue, pump, close. */
  speak(text: string, profile: VoiceProfileV15, priority: TtsV17ChunkPriority = 'normal', atMs?: number): TtsV18QueuedSentence[] {
    if (atMs !== undefined) this.nowMs = atMs;
    this.beginUtterance(profile, this.nowMs);
    const added = this.enqueue(text, priority, this.nowMs);
    this.pump(this.nowMs);
    this.endUtterance();
    return added;
  }

  endUtterance(): void {
    this.utteranceOpen = false;
    this.stream.endUtterance();
  }

  isUtteranceOpen(): boolean {
    return this.utteranceOpen;
  }

  /** Advance the virtual clock (stream playout + queue aging). */
  tick(ms: number): void {
    this.nowMs += ms;
    this.stream.tick(ms);
    this.promoteAged(this.nowMs);
    this.pump(this.nowMs);
  }

  pause(atMs?: number): void {
    if (atMs !== undefined) this.nowMs = atMs;
    this.stream.pause(this.nowMs);
  }

  resume(atMs?: number): void {
    if (atMs !== undefined) this.nowMs = atMs;
    this.stream.resume(this.nowMs);
  }

  /** Cancel the unplayed (barge-in path): drops the queue and the stream's unplayed chunks. */
  cancelUnplayed(atMs?: number): { spokenChars: number; cancelledChunks: number; cancelledChars: number; cancelledText: string; droppedQueuedSentences: number } {
    if (atMs !== undefined) this.nowMs = atMs;
    const droppedQueued = this.queue.length;
    this.queue = [];
    const result = this.stream.cancelUnplayed(this.nowMs);
    return { ...result, droppedQueuedSentences: droppedQueued };
  }

  cancel(atMs?: number): { spokenChars: number; cancelledChunks: number; remainingText: string } {
    if (atMs !== undefined) this.nowMs = atMs;
    this.queue = [];
    return this.stream.cancel(this.nowMs);
  }

  remainingText(): string {
    const queued = this.queue.map((q) => q.text).join(' ');
    const streamed = this.stream.remainingText();
    return [streamed, queued].filter((t) => t.length > 0).join(' ');
  }

  spokenText(): string {
    return this.stream.spokenText();
  }

  schedule(): ReturnType<TtsStreamV17['schedule']> {
    return this.stream.schedule();
  }

  queuedSentences(): TtsV18QueuedSentence[] {
    return [...this.queue];
  }

  stats(): TtsStreamV18Stats {
    const inner = this.stream.stats();
    const waits = [...this.queueWaitsMs].sort((a, b) => a - b);
    return {
      ...inner,
      queuedSentences: this.queue.length,
      enqueuedSentences: this.enqueuedSentences,
      droppedSentences: this.droppedSentences,
      promotedSentences: this.promotedSentences,
      longSentencesSplit: this.longSentencesSplit,
      clausesProduced: this.clausesProduced,
      averageQueueWaitMs: waits.length === 0 ? 0 : waits.reduce((a, b) => a + b, 0) / waits.length,
      p95QueueWaitMs: waits.length === 0 ? 0 : percentileV17(waits, 95),
    };
  }

  summary(): string {
    const s = this.stats();
    return (
      `TTS v18: ${s.utterances} utterances, ${s.chunksSpoken} chunks spoken, ` +
      `first-chunk ${s.averageFirstChunkLatencyMs.toFixed(0)} ms avg / ${s.p95FirstChunkLatencyMs.toFixed(0)} ms p95, ` +
      `${s.longSentencesSplit} long sentences → ${s.clausesProduced} clauses, ` +
      `${s.promotedSentences} promoted, ${s.droppedSentences} dropped, ${s.underruns} underruns`
    );
  }

  markdown(): string {
    const s = this.stats();
    return [
      '# TTS streaming v18',
      '',
      `- Utterances: ${s.utterances}, sentences: ${s.sentences}, chunks spoken: ${s.chunksSpoken}`,
      `- First-chunk latency: ${s.averageFirstChunkLatencyMs.toFixed(0)} ms avg / ${s.p95FirstChunkLatencyMs.toFixed(0)} ms p95`,
      `- Queue wait: ${s.averageQueueWaitMs.toFixed(0)} ms avg / ${s.p95QueueWaitMs.toFixed(0)} ms p95 (queued now: ${s.queuedSentences})`,
      `- Long sentences split: ${s.longSentencesSplit} → ${s.clausesProduced} clauses`,
      `- Promoted by aging: ${s.promotedSentences}, dropped on overflow: ${s.droppedSentences}`,
      `- Preempted: ${s.chunksPreempted}, cancelled: ${s.chunksCancelled}, underruns: ${s.underruns}, pauses: ${s.pauses}`,
      `- Max gap: ${s.maxGapMs === undefined ? 'n/a' : `${s.maxGapMs} ms`} (avg ${s.averageGapMs.toFixed(1)} ms)`,
      '',
    ].join('\n');
  }
}

export function createTtsStreamV18(synth: TtsSynthV15 = mockTtsSynthV15, options: TtsStreamV18Options = {}, sink?: TtsStreamV17Sink): TtsStreamV18 {
  return new TtsStreamV18(synth, options, sink);
}

/** One-line summary of a TTS stream v18. */
export function ttsV18Summary(stream: TtsStreamV18): string {
  return stream.summary();
}

/** Markdown report of a TTS stream v18. */
export function ttsV18Markdown(stream: TtsStreamV18): string {
  return stream.markdown();
}

export { TTS_V17_DEFAULT_MAX_CHUNK_CHARS as TTS_V18_DEFAULT_MAX_CHUNK_CHARS };
