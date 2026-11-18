/**
 * TTS streaming v3 (v1.18, Đội T5 — voice v17).
 *
 * v16 streamed one finished reply: small chunks, first chunk at
 * once, gapless joins, underrun recovery. That is right when the
 * whole reply exists — but a realtime agent does not have the whole
 * reply. The model produces it sentence by sentence, and waiting
 * for the last sentence before speaking the first one throws away
 * the latency the streaming pipeline was built to save.
 *
 * v17 speaks *while the reply is still arriving*:
 *
 *   1. Sentence streaming. `beginUtterance()` opens an utterance;
 *      `feedSentence()` appends one sentence at a time (the shape
 *      an LLM token stream arrives in); `endUtterance()` closes
 *      it. Chunks of the first sentence are synthesised and played
 *      while later sentences are still being generated — the
 *      first-chunk latency is measured from the first sentence's
 *      arrival, not from the end of the reply.
 *   2. Priority chunk queue. Every sentence carries a priority:
 *      `urgent` (a short acknowledgement, a correction, a "let me
 *      stop you there") jumps ahead of queued `normal` chunks that
 *      have not played yet; `background` (a recap, a footnote)
 *      waits behind everything. Preemption is counted and reported
 *      — an urgent sentence that never jumps the queue is a bug,
 *      not a feature.
 *   3. Cancel the unplayed, keep the spoken. `cancelUnplayed()`
 *      (the barge-in path) drops every queued chunk, reports the
 *      cancelled text + chars, and leaves the utterance open so a
 *      resume can feed the remaining sentences into the same
 *      utterance — the spoken prefix is never re-spoken.
 *   4. First-chunk latency, honestly measured. Time from the first
 *      sentence fed to the first chunk played, per utterance, with
 *      average and p95 across utterances — the number the panel
 *      shows, not a single lucky sample.
 *   5. The v16 guarantees carry over: gapless joins (crossfade
 *      overlap, measured gaps), underrun detection + silence pad +
 *      resume, pause/resume shifting the timeline, rate-adjusted
 *      chunk durations from the voice profile.
 *
 * The synth is injected (mock in tests, a real provider adapter in
 * production); the scheduler only ever sees ready-times and
 * durations. Virtual clock, no sound card.
 */

import { chunkTtsTextV15, mockTtsSynthV15 } from '../voiceV15/ttsStreamV15';
import type { TtsChunkV15, TtsSynthV15, VoiceProfileV15 } from '../voiceV15/ttsStreamV15';
import { ttsChunkDurationMsV16, TTS_V16_DEFAULT_CROSSFADE_MS, TTS_V16_DEFAULT_UNDERRUN_PAD_MS } from '../voiceV16/ttsStreamV16';

export const TTS_V17_SAMPLE_RATE_HZ = 24000;
export const TTS_V17_DEFAULT_MAX_CHUNK_CHARS = 60;

/** Priority of one sentence (and of every chunk it produces). */
export type TtsV17ChunkPriority = 'urgent' | 'normal' | 'background';

const PRIORITY_ORDER: Record<TtsV17ChunkPriority, number> = { urgent: 0, normal: 1, background: 2 };

export interface TtsStreamV17Options {
  /** Max characters per streamed chunk (default 60). */
  maxChunkChars?: number;
  /** Overlap (ms) scheduled between consecutive chunks (default 15). */
  crossfadeMs?: number;
  /** Silence pad (ms) inserted on an underrun (default 40). */
  underrunPadMs?: number;
  /** Jitter buffer: ms of audio to hold before starting playout (default 0). */
  playoutDelayMs?: number;
  /** Max chunks queued behind the playing one (default 64). */
  maxQueuedChunks?: number;
}

export function defaultTtsStreamV17Options(): Required<TtsStreamV17Options> {
  return {
    maxChunkChars: TTS_V17_DEFAULT_MAX_CHUNK_CHARS,
    crossfadeMs: TTS_V16_DEFAULT_CROSSFADE_MS,
    underrunPadMs: TTS_V16_DEFAULT_UNDERRUN_PAD_MS,
    playoutDelayMs: 0,
    maxQueuedChunks: 64,
  };
}

export function validateTtsStreamV17Options(options: TtsStreamV17Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof TtsStreamV17Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('maxChunkChars', options.maxChunkChars, 10, 500);
  check('crossfadeMs', options.crossfadeMs, 0, 200);
  check('underrunPadMs', options.underrunPadMs, 0, 1000);
  check('playoutDelayMs', options.playoutDelayMs, 0, 2000);
  check('maxQueuedChunks', options.maxQueuedChunks, 1, 1000);
  return errors;
}

/** Split reply text into sentences at sentence ends (keeps the punctuation). */
export function splitSentencesV17(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/(?<=[.!?…。])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** p-th percentile of a sample (linear interpolation); 0 when empty. */
export function percentileV17(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low] as number;
  const frac = rank - low;
  return Math.round((sorted[low] as number) * (1 - frac) + (sorted[high] as number) * frac);
}

/** One scheduled chunk on the playout timeline. */
export interface TtsPlayItemV17 {
  index: number;
  sentenceIndex: number;
  text: string;
  audio: Int16Array;
  synthMs: number;
  priority: TtsV17ChunkPriority;
  sentenceEnd: boolean;
  readyAtMs: number;
  playAtMs: number;
  durationMs: number;
}

export type TtsStreamV17State = 'idle' | 'speaking' | 'paused' | 'cancelled' | 'done';

export type TtsStreamV17EventKind =
  | 'started'
  | 'sentence-queued'
  | 'first-audio'
  | 'audio'
  | 'chunk-done'
  | 'preempted'
  | 'underrun'
  | 'paused'
  | 'resumed'
  | 'chunk-cancelled'
  | 'cancelled'
  | 'done';

export interface TtsStreamV17Event {
  kind: TtsStreamV17EventKind;
  atMs: number;
  sentenceIndex?: number;
  priority?: TtsV17ChunkPriority;
  chunk?: { index: number; text: string; audio: Int16Array; atMs: number; synthMs: number };
  gapMs?: number;
  spokenChars?: number;
  cancelledChunks?: number;
  /** First-chunk latency (ms) from the first sentence fed to first audio. */
  firstChunkLatencyMs?: number;
  preemptedChunks?: number;
}

export type TtsStreamV17Sink = (event: TtsStreamV17Event) => void;

export interface TtsStreamV17Stats {
  utterances: number;
  sentences: number;
  chunksSpoken: number;
  chunksCancelled: number;
  chunksPreempted: number;
  charactersSpoken: number;
  cancellations: number;
  firstChunkLatencyMs: number | undefined;
  averageFirstChunkLatencyMs: number;
  p95FirstChunkLatencyMs: number;
  gapsMs: number[];
  maxGapMs: number | undefined;
  averageGapMs: number;
  underruns: number;
  pauses: number;
  queuedChunks: number;
  bufferedMs: number;
}

/**
 * One utterance, streamed sentence by sentence through a
 * priority-aware gapless playout scheduler. `beginUtterance()` opens
 * it, `feedSentence()` appends sentences as they arrive,
 * `endUtterance()` closes it; `tick(ms)` plays whatever is due.
 * `cancelUnplayed()` drops the queue for a barge-in cut and leaves
 * the utterance open for a resume.
 */
export class TtsStreamV17 {
  private readonly synth: TtsSynthV15;
  private readonly options: Required<TtsStreamV17Options>;
  private readonly sink: TtsStreamV17Sink | undefined;
  private state: TtsStreamV17State = 'idle';
  private nowMs = 0;
  private profile: VoiceProfileV15 | undefined;
  private timeline: TtsPlayItemV17[] = [];
  private playCursor = 0;
  private playingUntilMs = 0;
  private lastChunkEndMs: number | undefined;
  private currentText = '';
  private spokenChars = 0;
  private firstAudioAtMs: number | undefined;
  private firstSentenceAtMs: number | undefined;
  private utteranceStartedAtMs = 0;
  private utteranceEnded = false;
  private sentenceCounter = 0;
  private chunkCounter = 0;
  private synthCursorMs = 0;
  private utterances = 0;
  private sentences = 0;
  private chunksSpoken = 0;
  private chunksCancelled = 0;
  private chunksPreempted = 0;
  private charactersSpoken = 0;
  private cancellations = 0;
  private pauses = 0;
  private readonly firstChunkLatencies: number[] = [];
  private readonly gapsMs: number[] = [];
  private underruns = 0;
  private pausedAtMs: number | undefined;

  constructor(synth: TtsSynthV15 = mockTtsSynthV15, options: TtsStreamV17Options = {}, sink?: TtsStreamV17Sink) {
    const merged = { ...defaultTtsStreamV17Options(), ...options };
    const errors = validateTtsStreamV17Options(merged);
    if (errors.length > 0) throw new Error(`invalid TTS stream v17 options: ${errors.join('; ')}`);
    this.synth = synth;
    this.options = merged;
    this.sink = sink;
  }

  getState(): TtsStreamV17State {
    return this.state;
  }

  isSpeaking(): boolean {
    return this.state === 'speaking';
  }

  isPaused(): boolean {
    return this.state === 'paused';
  }

  /** Open a new utterance with `profile`. */
  beginUtterance(profile: VoiceProfileV15, atMs?: number): void {
    if (this.state === 'speaking' || this.state === 'paused') {
      throw new Error('TTS stream v17 is already speaking; cancel it first');
    }
    if (atMs !== undefined) this.nowMs = atMs;
    this.profile = profile;
    this.timeline = [];
    this.playCursor = 0;
    this.playingUntilMs = 0;
    this.lastChunkEndMs = undefined;
    this.currentText = '';
    this.spokenChars = 0;
    this.firstAudioAtMs = undefined;
    this.firstSentenceAtMs = undefined;
    this.utteranceStartedAtMs = this.nowMs;
    this.utteranceEnded = false;
    this.sentenceCounter = 0;
    this.chunkCounter = 0;
    this.synthCursorMs = this.nowMs;
    this.pausedAtMs = undefined;
    this.state = 'speaking';
    this.utterances += 1;
    this.sink?.({ kind: 'started', atMs: this.nowMs });
  }

  /**
   * Append one sentence (as it arrives from the model). Urgent
   * sentences jump ahead of queued normal/background chunks that
   * have not played yet; the playout timeline is re-laid from the
   * insertion point. Returns the chunks created.
   */
  feedSentence(text: string, priority: TtsV17ChunkPriority = 'normal', atMs?: number): TtsChunkV15[] {
    if (this.state !== 'speaking') {
      throw new Error('TTS stream v17 has no open utterance; call beginUtterance first');
    }
    if (atMs !== undefined) this.nowMs = atMs;
    const profile = this.profile as VoiceProfileV15;
    const chunks = chunkTtsTextV15(text, Math.min(profile.maxChunkChars, this.options.maxChunkChars));
    if (chunks.length === 0) return [];
    if (this.firstSentenceAtMs === undefined) this.firstSentenceAtMs = this.nowMs;
    const sentenceIndex = this.sentenceCounter;
    this.sentenceCounter += 1;
    this.sentences += 1;
    this.currentText = this.currentText.length === 0 ? text : `${this.currentText} ${text}`;
    const items: TtsPlayItemV17[] = chunks.map((chunk) => {
      const { audio, synthMs } = this.synth(chunk, profile);
      this.synthCursorMs += synthMs;
      return {
        index: this.chunkCounter,
        sentenceIndex,
        text: chunk.text,
        audio,
        synthMs,
        priority,
        sentenceEnd: chunk.sentenceEnd,
        readyAtMs: this.synthCursorMs,
        playAtMs: 0,
        durationMs: ttsChunkDurationMsV16(audio, profile.rate),
      };
    });
    this.chunkCounter += chunks.length;

    // Queue depth guard: refuse to grow without bound when the
    // producer outruns the speaker (a stuck playout must not eat
    // memory sentence by sentence).
    const queued = this.timeline.length - this.playCursor;
    if (queued + items.length > this.options.maxQueuedChunks) {
      throw new Error(
        `TTS stream v17 queue full: ${queued} queued + ${items.length} new > max ${this.options.maxQueuedChunks}`,
      );
    }

    // Insert: urgent goes before the first pending chunk whose
    // priority is lower; anything else appends at the end.
    let insertAt = this.timeline.length;
    if (priority === 'urgent') {
      for (let i = this.playCursor; i < this.timeline.length; i += 1) {
        if (PRIORITY_ORDER[(this.timeline[i] as TtsPlayItemV17).priority] > PRIORITY_ORDER.urgent) {
          insertAt = i;
          break;
        }
      }
    }
    const preempted = this.timeline.length - insertAt;
    this.timeline.splice(insertAt, 0, ...items);
    if (preempted > 0) {
      this.chunksPreempted += preempted;
      this.sink?.({ kind: 'preempted', atMs: this.nowMs, sentenceIndex, priority, preemptedChunks: preempted });
    }
    this.relayout(insertAt);
    this.sink?.({ kind: 'sentence-queued', atMs: this.nowMs, sentenceIndex, priority });
    return chunks;
  }

  /** One-shot convenience: open, feed the whole text, close. */
  speak(text: string, profile: VoiceProfileV15, atMs?: number): TtsChunkV15[] {
    this.beginUtterance(profile, atMs);
    const chunks: TtsChunkV15[] = [];
    for (const sentence of splitSentencesV17(text)) {
      chunks.push(...this.feedSentence(sentence, 'normal'));
    }
    if (chunks.length === 0) {
      // No sentence boundary (one fragment): feed it as-is.
      chunks.push(...this.feedSentence(text, 'normal'));
    }
    this.endUtterance();
    return chunks;
  }

  /** No more sentences will arrive; the stream drains, then finishes. */
  endUtterance(): void {
    if (this.state !== 'speaking') return;
    this.utteranceEnded = true;
    this.finishIfDone();
  }

  tick(ms: number): void {
    this.nowMs += ms;
    if (this.state !== 'speaking') return;
    while (this.playCursor < this.timeline.length) {
      const item = this.timeline[this.playCursor] as TtsPlayItemV17;
      if (this.nowMs < item.playAtMs) return;
      if (this.nowMs < item.readyAtMs) {
        const shift = item.readyAtMs - item.playAtMs + (this.playCursor > 0 ? this.options.underrunPadMs : 0);
        if (this.playCursor > 0) {
          this.underruns += 1;
          this.sink?.({ kind: 'underrun', atMs: this.nowMs, chunk: { index: item.index, text: item.text, audio: item.audio, atMs: this.nowMs, synthMs: item.synthMs } });
        }
        for (let i = this.playCursor; i < this.timeline.length; i += 1) {
          (this.timeline[i] as TtsPlayItemV17).playAtMs += shift;
        }
        return;
      }
      const gapMs = this.lastChunkEndMs !== undefined ? item.playAtMs - this.lastChunkEndMs : 0;
      if (this.playCursor > 0) this.gapsMs.push(gapMs);
      if (this.firstAudioAtMs === undefined) {
        this.firstAudioAtMs = this.nowMs - this.utteranceStartedAtMs;
        const latency = this.firstSentenceAtMs !== undefined
          ? this.nowMs - this.firstSentenceAtMs
          : this.firstAudioAtMs;
        this.firstChunkLatencies.push(latency);
        this.sink?.({
          kind: 'first-audio',
          atMs: this.nowMs,
          chunk: { index: item.index, text: item.text, audio: item.audio, atMs: this.nowMs, synthMs: item.synthMs },
          gapMs,
          firstChunkLatencyMs: latency,
        });
      }
      this.chunksSpoken += 1;
      this.charactersSpoken += item.text.length;
      this.spokenChars += item.text.length;
      this.playingUntilMs = item.playAtMs + item.durationMs;
      this.lastChunkEndMs = item.playAtMs + item.durationMs;
      this.playCursor += 1;
      this.sink?.({
        kind: 'audio',
        atMs: this.nowMs,
        chunk: { index: item.index, text: item.text, audio: item.audio, atMs: this.nowMs, synthMs: item.synthMs },
        gapMs,
      });
      this.sink?.({ kind: 'chunk-done', atMs: this.nowMs, spokenChars: this.spokenChars });
    }
    this.finishIfDone();
  }

  /** Freeze the playout clock; the remaining timeline shifts. */
  pause(atMs?: number): void {
    if (this.state !== 'speaking') return;
    if (atMs !== undefined) this.nowMs = atMs;
    this.pausedAtMs = this.nowMs;
    this.state = 'paused';
    this.pauses += 1;
    this.sink?.({ kind: 'paused', atMs: this.nowMs, spokenChars: this.spokenChars });
  }

  /** Continue from the same chunk after a pause. */
  resume(atMs?: number): void {
    if (this.state !== 'paused' || this.pausedAtMs === undefined) return;
    if (atMs !== undefined) this.nowMs = atMs;
    const pausedFor = this.nowMs - this.pausedAtMs;
    for (const item of this.timeline) {
      item.playAtMs += pausedFor;
      item.readyAtMs += pausedFor;
    }
    if (this.lastChunkEndMs !== undefined) this.lastChunkEndMs += pausedFor;
    this.playingUntilMs += pausedFor;
    this.synthCursorMs += pausedFor;
    this.pausedAtMs = undefined;
    this.state = 'speaking';
    this.sink?.({ kind: 'resumed', atMs: this.nowMs, spokenChars: this.spokenChars });
  }

  /**
   * Drop every queued (unplayed) chunk — the barge-in path.
   * The utterance stays open so a resume can feed the remaining
   * sentences into it. Returns what was spoken and what was cut.
   */
  cancelUnplayed(atMs?: number): { spokenChars: number; cancelledChunks: number; cancelledChars: number; cancelledText: string } {
    if (atMs !== undefined) this.nowMs = atMs;
    const remaining = this.timeline.slice(this.playCursor);
    const cancelledText = remaining.map((item) => item.text).join(' ');
    const cancelledChars = remaining.reduce((sum, item) => sum + item.text.length, 0);
    const cancelledChunks = remaining.length;
    this.timeline = this.timeline.slice(0, this.playCursor);
    this.chunksCancelled += cancelledChunks;
    this.sink?.({ kind: 'chunk-cancelled', atMs: this.nowMs, spokenChars: this.spokenChars, cancelledChunks });
    return { spokenChars: this.spokenChars, cancelledChunks, cancelledChars, cancelledText };
  }

  /** Cancel the whole utterance (stops after the current chunk). */
  cancel(atMs?: number): { spokenChars: number; cancelledChunks: number; remainingText: string } {
    const cut = this.cancelUnplayed(atMs);
    if (this.state === 'speaking' || this.state === 'paused') {
      this.state = 'cancelled';
      this.cancellations += 1;
    }
    this.sink?.({ kind: 'cancelled', atMs: this.nowMs, spokenChars: this.spokenChars, cancelledChunks: cut.cancelledChunks });
    return { spokenChars: cut.spokenChars, cancelledChunks: cut.cancelledChunks, remainingText: cut.cancelledText };
  }

  /** Text not yet spoken (for resume after a barge-in cut). */
  remainingText(): string {
    return this.timeline.slice(this.playCursor).map((item) => item.text).join(' ');
  }

  spokenText(): string {
    return this.currentText.slice(0, this.spokenChars);
  }

  /** Scheduled play times (for tests / diagnostics). */
  schedule(): { index: number; sentenceIndex: number; text: string; priority: TtsV17ChunkPriority; playAtMs: number; durationMs: number; readyAtMs: number }[] {
    return this.timeline.map((item) => ({
      index: item.index,
      sentenceIndex: item.sentenceIndex,
      text: item.text,
      priority: item.priority,
      playAtMs: item.playAtMs,
      durationMs: item.durationMs,
      readyAtMs: item.readyAtMs,
    }));
  }

  stats(): TtsStreamV17Stats {
    const bufferedMs = this.timeline.slice(this.playCursor).reduce((sum, item) => sum + item.durationMs, 0);
    return {
      utterances: this.utterances,
      sentences: this.sentences,
      chunksSpoken: this.chunksSpoken,
      chunksCancelled: this.chunksCancelled,
      chunksPreempted: this.chunksPreempted,
      charactersSpoken: this.charactersSpoken,
      cancellations: this.cancellations,
      firstChunkLatencyMs: this.firstChunkLatencies.length > 0
        ? this.firstChunkLatencies[this.firstChunkLatencies.length - 1]
        : undefined,
      averageFirstChunkLatencyMs: this.firstChunkLatencies.length > 0
        ? Math.round(this.firstChunkLatencies.reduce((a, b) => a + b, 0) / this.firstChunkLatencies.length)
        : 0,
      p95FirstChunkLatencyMs: percentileV17(this.firstChunkLatencies, 95),
      gapsMs: [...this.gapsMs],
      maxGapMs: this.gapsMs.length > 0 ? Math.max(...this.gapsMs) : undefined,
      averageGapMs: this.gapsMs.length > 0
        ? Math.round(this.gapsMs.reduce((a, b) => a + b, 0) / this.gapsMs.length)
        : 0,
      underruns: this.underruns,
      pauses: this.pauses,
      queuedChunks: this.timeline.length - this.playCursor,
      bufferedMs,
    };
  }

  summary(): string {
    const s = this.stats();
    return `tts v17: ${s.utterances} utterances, ${s.sentences} sentences, ${s.chunksSpoken} chunks spoken, ` +
      `${s.chunksCancelled} cancelled, ${s.chunksPreempted} preempted, ${s.charactersSpoken} chars, ` +
      `avg first-chunk ${s.averageFirstChunkLatencyMs} ms (p95 ${s.p95FirstChunkLatencyMs} ms), ` +
      `max gap ${s.maxGapMs !== undefined ? `${s.maxGapMs} ms` : 'n/a'}, ${s.underruns} underruns`;
  }

  markdown(): string {
    const s = this.stats();
    return [
      '## TTS streaming v17',
      '',
      `- Utterances: ${s.utterances}; sentences: ${s.sentences}; chunks spoken: ${s.chunksSpoken}; chunks cancelled: ${s.chunksCancelled}; chunks preempted: ${s.chunksPreempted}`,
      `- Characters spoken: ${s.charactersSpoken}; cancellations: ${s.cancellations}`,
      `- First-chunk latency: average ${s.averageFirstChunkLatencyMs} ms, p95 ${s.p95FirstChunkLatencyMs} ms`,
      `- Join gaps between chunks: max ${s.maxGapMs !== undefined ? `${s.maxGapMs} ms` : 'n/a'}, average ${s.averageGapMs} ms (negative = crossfade overlap)`,
      `- Underruns: ${s.underruns}; pauses: ${s.pauses}; queued chunks: ${s.queuedChunks}; buffered audio: ${s.bufferedMs} ms`,
      '',
    ].join('\n');
  }

  /** Re-lay play times from `fromIndex` onward (after an insert). */
  private relayout(fromIndex: number): void {
    let startAtMs: number;
    if (fromIndex === 0) {
      startAtMs = this.nowMs + this.options.playoutDelayMs;
    } else {
      const prev = this.timeline[fromIndex - 1] as TtsPlayItemV17;
      startAtMs = prev.playAtMs + prev.durationMs - this.options.crossfadeMs;
    }
    // Never schedule a pending chunk in the past: if the previous
    // chunk already ended, the next one plays now.
    if (fromIndex >= this.playCursor) startAtMs = Math.max(startAtMs, this.nowMs);
    for (let i = fromIndex; i < this.timeline.length; i += 1) {
      const item = this.timeline[i] as TtsPlayItemV17;
      item.playAtMs = startAtMs;
      startAtMs = item.playAtMs + item.durationMs - this.options.crossfadeMs;
    }
  }

  private finishIfDone(): void {
    if (this.state !== 'speaking') return;
    if (!this.utteranceEnded) return;
    if (this.playCursor < this.timeline.length) return;
    if (this.nowMs < this.playingUntilMs) return;
    this.state = 'done';
    this.sink?.({ kind: 'done', atMs: this.nowMs, spokenChars: this.spokenChars });
  }
}

export function createTtsStreamV17(
  synth?: TtsSynthV15,
  options?: TtsStreamV17Options,
  sink?: TtsStreamV17Sink,
): TtsStreamV17 {
  return new TtsStreamV17(synth, options, sink);
}

export function ttsV17Summary(stream: TtsStreamV17): string {
  return stream.summary();
}

export function ttsV17Markdown(stream: TtsStreamV17): string {
  return stream.markdown();
}
