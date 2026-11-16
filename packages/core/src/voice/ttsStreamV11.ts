/**
 * TTS streaming v11 (v1.12, Đội T5 — voice realtime v11).
 *
 * v0.96's `TtsQueue` speaks whole sentences through a system
 * engine; a realtime reply cannot wait for the full text before
 * it starts talking. v11 streams: text arrives in deltas (the
 * model is still generating), and audio starts as soon as the
 * first speakable chunk is complete.
 *
 *   feedTextDelta("Xin chào") ──▶ buffer
 *   feedTextDelta(" bạn, hôm nay…") ──▶ sentence boundary found
 *        ──▶ chunk #1 "Xin chào bạn." ──▶ synth ──▶ PCM16 frames
 *        ──▶ queue ──▶ play (virtual clock) ──▶ chunk-done
 *   feedTextDelta("", { final: true }) ──▶ flush remainder
 *
 * Rules:
 * - Chunking: a chunk closes at a sentence boundary (`. ! ? …`
 *   or a newline) once it holds at least `minChunkChars`
 *   (default 8); a chunk longer than `maxChunkChars` (default
 *   160) also splits at `, ; :` so a pause lands regularly.
 *   Abbreviations (`Dr.`, `Mr.`, `e.g.`, `v.v.`) never split —
 *   same allow-list idea as the v0.96 queue, reimplemented here.
 * - Synthesis is injected (`TtsStreamSynth`): the default mock
 *   synth renders deterministic PCM16 — a sine whose pitch is
 *   derived from the chunk text (so every chunk sounds different
 *   but the same text always renders the same frames) at
 *   `msPerChar` (default 55 ms/char, ~18 chars/s, a calm speaking
 *   pace). A live host replaces the synth with a real engine; the
 *   stream never dials anything itself.
 * - Playback runs on the caller-owned virtual clock (`tick(ms)`):
 *   the playing chunk advances one 20 ms frame at a time; when
 *   it drains, the next queued chunk starts. `pause()` /
 *   `resume()` freeze and continue playback; `cancelPending()`
 *   (the barge-in path) drops every queued chunk and cuts the
 *   playing chunk mid-frame, returning an exact receipt
 *   (chunks cancelled, chars discarded, ms played vs discarded);
 *   `stopAll()` cancels everything including the playing chunk.
 * - Backpressure: at most `maxQueuedChunks` (default 8) chunks
 *   may wait; further text is buffered, not dropped — the
 *   chunker only emits when a slot frees — and `droppedChars`
 *   stays 0 unless the text buffer itself exceeds `maxBufferChars`
 *   (default 4000), in which case the oldest buffered text is
 *   discarded and counted. Nothing is silently lost.
 * - Latency: first-chunk latency (first delta → first chunk
 *   ready) and per-chunk ready times are measured on the virtual
 *   clock and reported in stats.
 *
 * No sound card, no network, no key. The mock synth's frames are
 * real PCM16 buffers (the session can count / hash them); they
 * are never sent to a speaker here.
 */

import { MOCK_AUDIO_FRAME_SAMPLES } from './audioMockV11';

/** One speakable chunk of streamed text. */
export interface TtsStreamChunkV11 {
  id: number;
  text: string;
  /** queued | playing | done | cancelled | paused (queued but stream paused). */
  status: 'queued' | 'playing' | 'done' | 'cancelled';
  /** Estimated speaking time (ms). */
  estDurationMs: number;
  /** Mock PCM16 frames (20 ms each) rendered for this chunk. */
  frames: Uint8Array[];
  /** Frames already played (0 while queued). */
  playedFrames: number;
  /** Virtual time the chunk became ready (ms). */
  readyAtMs: number;
  /** Virtual time playback started (ms, null while queued). */
  startedAtMs: number | null;
  /** Virtual time playback finished / was cut (ms, null while open). */
  finishedAtMs: number | null;
}

/** Result of cancelling the pending queue (barge-in receipt). */
export interface TtsStreamCancelResult {
  /** True when something was playing or queued. */
  cancelled: boolean;
  /** Queued chunks dropped. */
  chunksCancelled: number;
  /** Chars discarded from the queued chunks. */
  charsDiscarded: number;
  /** True when the playing chunk was cut mid-way. */
  cutPlaying: boolean;
  /** Text of the chunk cut mid-way ('' when none was playing). */
  cutChunkText: string;
  /** Ms of the playing chunk already spoken before the cut. */
  playedMs: number;
  /** Ms of the playing chunk discarded by the cut. */
  discardedMs: number;
  atMs: number;
}

/** What `feedTextDelta` returns. */
export interface TtsStreamFeedResult {
  /** Chunks that became ready from this delta. */
  chunksReady: number;
  /** Chars currently buffered (not yet chunked). */
  bufferedChars: number;
  /** Chunks currently queued (not counting the playing one). */
  queuedChunks: number;
  /** Chars dropped by buffer overflow (0 unless the buffer capped). */
  droppedChars: number;
}

/** A synthesiser: text → PCM16 frames (20 ms each). */
export type TtsStreamSynth = (text: string, input: { chunkId: number; atMs: number }) => Uint8Array[];

/** Options for `TtsStreamV11`. */
export interface TtsStreamV11Options {
  /** Synthesiser (default: deterministic mock sine synth). */
  synth?: TtsStreamSynth;
  /** Minimum chars before a sentence boundary closes a chunk. */
  minChunkChars?: number;
  /** Maximum chars per chunk (splits long sentences at commas). */
  maxChunkChars?: number;
  /** Speaking pace for the mock synth (ms per char). */
  msPerChar?: number;
  /** Max chunks waiting in the queue (backpressure). */
  maxQueuedChunks?: number;
  /** Max chars buffered before the oldest text is dropped. */
  maxBufferChars?: number;
}

/** Counters for one stream. */
export interface TtsStreamV11Stats {
  chunks: number;
  chunksDone: number;
  chunksCancelled: number;
  chars: number;
  charsPlayed: number;
  charsDiscarded: number;
  droppedChars: number;
  playedMs: number;
  /** First-delta → first-chunk-ready latency (ms, null when none). */
  firstChunkLatencyMs: number | null;
  /** Mean chunk ready latency (ms, 0 when none). */
  meanChunkLatencyMs: number;
  queuedChunks: number;
  playing: boolean;
  paused: boolean;
  drained: boolean;
}

/** Events emitted by the stream. */
export type TtsStreamV11Event =
  | { kind: 'chunk-ready'; chunk: TtsStreamChunkV11 }
  | { kind: 'chunk-start'; chunk: TtsStreamChunkV11 }
  | { kind: 'chunk-done'; chunk: TtsStreamChunkV11 }
  | { kind: 'chunk-cancelled'; chunk: TtsStreamChunkV11 }
  | { kind: 'cancelled'; result: TtsStreamCancelResult }
  | { kind: 'drained'; atMs: number }
  | { kind: 'backpressure'; atMs: number; queuedChunks: number; bufferedChars: number };

export type TtsStreamV11EventSink = (event: TtsStreamV11Event) => void;

/** Abbreviations that must NOT end a sentence. */
export const TTS_STREAM_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'e.g', 'i.e', 'etc', 'no', 'v.v', 'vd', 'tp', 'p',
]);

export function defaultTtsStreamV11Options(): Required<Omit<TtsStreamV11Options, 'synth'>> {
  return {
    minChunkChars: 8,
    maxChunkChars: 160,
    msPerChar: 55,
    maxQueuedChunks: 8,
    maxBufferChars: 4000,
  };
}

export function validateTtsStreamV11Options(options: TtsStreamV11Options): Required<Omit<TtsStreamV11Options, 'synth'>> {
  const base = defaultTtsStreamV11Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`TTS stream v11 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  const minChunkChars = Math.floor(num(options.minChunkChars, base.minChunkChars, 'minChunkChars', 1, 1000));
  const maxChunkChars = Math.floor(num(options.maxChunkChars, base.maxChunkChars, 'maxChunkChars', 1, 5000));
  if (maxChunkChars < minChunkChars) {
    throw new Error(`TTS stream v11 maxChunkChars (${maxChunkChars}) must be >= minChunkChars (${minChunkChars}).`);
  }
  return {
    minChunkChars,
    maxChunkChars,
    msPerChar: num(options.msPerChar, base.msPerChar, 'msPerChar', 1, 1000),
    maxQueuedChunks: Math.floor(num(options.maxQueuedChunks, base.maxQueuedChunks, 'maxQueuedChunks', 1, 100)),
    maxBufferChars: Math.floor(num(options.maxBufferChars, base.maxBufferChars, 'maxBufferChars', 100, 100000)),
  };
}

const ABBR_DOT = '\uE001';

/** Protect abbreviation periods so they never split a sentence. */
function protectAbbreviations(text: string): string {
  return text.replace(
    new RegExp(`\\b(${[...TTS_STREAM_ABBREVIATIONS].map((a) => a.replace(/\./g, '\\.')).join('|')})\\.`, 'gi'),
    `$1${ABBR_DOT}`,
  );
}

/**
 * Split buffered text into complete chunks. Returns the chunks
 * plus the leftover text that has no sentence boundary yet.
 * Pure — the stream and the tests share it.
 */
export function splitTtsStreamChunks(
  text: string,
  options: { minChunkChars: number; maxChunkChars: number },
): { chunks: string[]; leftover: string } {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return { chunks: [], leftover: '' };
  const protectedText = protectAbbreviations(clean);
  const chunks: string[] = [];
  const re = /[^.!?…\n]+(?:[.!?…]+["'”’)]?|\n|$)/g;
  let m: RegExpExecArray | null;
  let consumedEnd = 0;
  // Short terminated sentences accumulate until the pending chunk
  // reaches minChunkChars ("Ừ." + " Vâng." become one chunk).
  let pending = '';
  while ((m = re.exec(protectedText)) !== null) {
    const raw = m[0].replaceAll(ABBR_DOT, '.').trim();
    if (!raw) {
      consumedEnd = m.index + m[0].length;
      continue;
    }
    const terminated = /[.!?…]["'”’)]?\s*$/.test(raw) || /\n\s*$/.test(m[0]);
    if (!terminated) {
      // No sentence boundary yet: keep the tail as leftover —
      // unless it is already very long, in which case split it at
      // commas and keep only the last part buffered.
      if (raw.length < options.maxChunkChars) break;
      const parts = raw.split(/(?<=[,;:])\s+/);
      if (parts.length <= 1) break;
      let cursor = 0;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = (parts[i] as string).trim();
        if (part) chunks.push(part);
        cursor = m[0].indexOf(parts[i] as string, cursor) + (parts[i] as string).length;
      }
      while (cursor < m[0].length && /\s/.test(m[0][cursor] as string)) cursor += 1;
      consumedEnd = m.index + cursor;
      break;
    }
    pending = pending ? `${pending} ${raw}` : raw;
    if (pending.length >= options.minChunkChars) {
      chunks.push(pending);
      pending = '';
      consumedEnd = m.index + m[0].length;
    }
    // Otherwise the short sentence stays pending: consumedEnd
    // does not advance, so it comes back as leftover.
  }
  // Long chunks split at commas / semicolons / colons.
  const out: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= options.maxChunkChars) {
      out.push(chunk);
      continue;
    }
    const parts = chunk.split(/(?<=[,;:])\s+/);
    let acc = '';
    for (const part of parts) {
      if (!acc) {
        acc = part;
        continue;
      }
      if ((acc + ' ' + part).length > options.maxChunkChars) {
        out.push(acc.trim());
        acc = part;
      } else {
        acc = `${acc} ${part}`;
      }
    }
    if (acc.trim()) out.push(acc.trim());
  }
  // Leftover: everything after the last complete chunk.
  const leftover = protectedText.slice(consumedEnd).replaceAll(ABBR_DOT, '.').trim();
  return { chunks: out, leftover };
}

/**
 * Default mock synthesiser: a sine whose pitch is derived from
 * the chunk text (hash → 140–320 Hz) so every chunk renders
 * distinct but deterministic frames. Frame count follows the
 * estimated duration (one 20 ms frame per 20 ms of speech).
 */
export function mockTtsSynthV11(msPerChar: number): TtsStreamSynth {
  return (text: string, input: { chunkId: number; atMs: number }): Uint8Array[] => {
    void input;
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const freq = 140 + (Math.abs(hash) % 180);
    const estMs = Math.max(20, text.length * msPerChar);
    const frames = Math.max(1, Math.ceil(estMs / 20));
    const out: Uint8Array[] = [];
    for (let f = 0; f < frames; f += 1) {
      const frame = new Uint8Array(MOCK_AUDIO_FRAME_SAMPLES * 2);
      for (let i = 0; i < MOCK_AUDIO_FRAME_SAMPLES; i += 1) {
        const t = (f * MOCK_AUDIO_FRAME_SAMPLES + i) / 16000;
        const v = 0.22 * Math.sin(2 * Math.PI * freq * t) + 0.06 * Math.sin(2 * Math.PI * freq * 2 * t);
        const s = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
        const vv = s < 0 ? s + 65536 : s;
        frame[i * 2] = vv & 0xff;
        frame[i * 2 + 1] = (vv >> 8) & 0xff;
      }
      out.push(frame);
    }
    return out;
  };
}

/**
 * Streaming TTS: text deltas in, PCM16 chunk frames out, on a
 * caller-owned virtual clock. `tick(ms)` drives playback.
 */
export class TtsStreamV11 {
  private readonly options: Required<Omit<TtsStreamV11Options, 'synth'>>;
  private readonly synth: TtsStreamSynth;
  private readonly sink: TtsStreamV11EventSink | null;
  private buffer = '';
  private queue: TtsStreamChunkV11[] = [];
  private playing: TtsStreamChunkV11 | null = null;
  private nextChunkId = 1;
  private nowMs = 0;
  private paused = false;
  private frameDebtMs = 0;
  private firstDeltaAtMs: number | null = null;
  private firstChunkLatencyMs: number | null = null;
  private chunkLatencies: number[] = [];
  private chunks = 0;
  private chunksDone = 0;
  private chunksCancelled = 0;
  private chars = 0;
  private charsPlayed = 0;
  private charsDiscarded = 0;
  private droppedChars = 0;
  private playedMs = 0;
  private drainedEmitted = true;

  constructor(options: TtsStreamV11Options = {}, sink: TtsStreamV11EventSink | null = null) {
    this.options = validateTtsStreamV11Options(options);
    this.synth = options.synth ?? mockTtsSynthV11(this.options.msPerChar);
    this.sink = sink;
  }

  getOptions(): Required<Omit<TtsStreamV11Options, 'synth'>> {
    return { ...this.options };
  }

  getNowMs(): number {
    return this.nowMs;
  }

  isPlaying(): boolean {
    return this.playing !== null;
  }

  isPaused(): boolean {
    return this.paused;
  }

  isDrained(): boolean {
    return this.playing === null && this.queue.length === 0 && this.buffer.trim().length === 0;
  }

  getQueuedChunks(): TtsStreamChunkV11[] {
    return this.queue.map((c) => ({ ...c, frames: c.frames }));
  }

  getPlayingChunk(): TtsStreamChunkV11 | null {
    return this.playing ? { ...this.playing, frames: this.playing.frames } : null;
  }

  getBufferedChars(): number {
    return this.buffer.length;
  }

  getStats(): TtsStreamV11Stats {
    return {
      chunks: this.chunks,
      chunksDone: this.chunksDone,
      chunksCancelled: this.chunksCancelled,
      chars: this.chars,
      charsPlayed: this.charsPlayed,
      charsDiscarded: this.charsDiscarded,
      droppedChars: this.droppedChars,
      playedMs: this.playedMs,
      firstChunkLatencyMs: this.firstChunkLatencyMs,
      meanChunkLatencyMs: this.chunkLatencies.length > 0
        ? Math.round(this.chunkLatencies.reduce((a, b) => a + b, 0) / this.chunkLatencies.length)
        : 0,
      queuedChunks: this.queue.length,
      playing: this.playing !== null,
      paused: this.paused,
      drained: this.isDrained(),
    };
  }

  /**
   * Feed one text delta. `final: true` flushes the remaining
   * buffer as a last chunk even without a sentence boundary.
   * Returns how many chunks became ready.
   */
  feedTextDelta(delta: string, input: { final?: boolean } = {}): TtsStreamFeedResult {
    if (typeof delta !== 'string') throw new Error('TTS stream v11 delta must be a string.');
    if (this.firstDeltaAtMs === null && delta.length > 0) this.firstDeltaAtMs = this.nowMs;
    let droppedChars = 0;
    this.buffer += delta;
    if (this.buffer.length > this.options.maxBufferChars) {
      const overflow = this.buffer.length - this.options.maxBufferChars;
      this.buffer = this.buffer.slice(overflow);
      this.droppedChars += overflow;
      droppedChars = overflow;
    }
    let chunksReady = 0;
    const { chunks, leftover } = splitTtsStreamChunks(this.buffer, this.options);
    this.buffer = leftover;
    for (const text of chunks) {
      this.enqueueChunk(text);
      chunksReady += 1;
    }
    if (input.final === true && this.buffer.trim().length > 0) {
      // Flush: the tail has no sentence boundary yet — speak it as
      // one last chunk instead of leaving it buffered forever.
      const tail = this.buffer.trim();
      this.buffer = '';
      this.enqueueChunk(tail);
      chunksReady += 1;
    }
    if (this.queue.length > this.options.maxQueuedChunks) {
      this.sink?.({
        kind: 'backpressure',
        atMs: this.nowMs,
        queuedChunks: this.queue.length,
        bufferedChars: this.buffer.length,
      });
    }
    return {
      chunksReady,
      bufferedChars: this.buffer.length,
      queuedChunks: this.queue.length,
      droppedChars,
    };
  }

  /** Advance the virtual clock; drives chunk playback. */
  tick(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) {
      throw new Error('TTS stream v11 tick(ms) must be a finite number in 0..60000.');
    }
    this.nowMs += ms;
    if (this.paused) return;
    if (this.playing === null) this.startNextChunk();
    if (this.playing === null) {
      this.maybeEmitDrained();
      return;
    }
    this.frameDebtMs += ms;
    while (this.frameDebtMs >= 20 && this.playing !== null) {
      this.frameDebtMs -= 20;
      this.playing.playedFrames += 1;
      this.playedMs += 20;
      if (this.playing.playedFrames >= this.playing.frames.length) {
        this.finishPlayingChunk();
        this.startNextChunk();
      }
    }
    this.maybeEmitDrained();
  }

  /** Freeze playback (keeps the queue and the playing chunk). */
  pause(): boolean {
    if (this.paused) return false;
    this.paused = true;
    return true;
  }

  /** Continue playback after a pause. */
  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    return true;
  }

  /**
   * Barge-in: drop every queued chunk and cut the playing chunk
   * mid-way. Returns the exact receipt.
   */
  cancelPending(): TtsStreamCancelResult {
    const queued = this.queue.splice(0, this.queue.length);
    let charsDiscarded = 0;
    for (const chunk of queued) {
      chunk.status = 'cancelled';
      chunk.finishedAtMs = this.nowMs;
      charsDiscarded += chunk.text.length;
      this.chunksCancelled += 1;
      this.sink?.({ kind: 'chunk-cancelled', chunk: { ...chunk, frames: chunk.frames } });
    }
    // The un-chunked buffer is also discarded: the reply is cut,
    // its not-yet-spoken tail must not leak out later.
    const bufferedDiscarded = this.buffer.length;
    this.buffer = '';
    charsDiscarded += bufferedDiscarded;
    let cutPlaying = false;
    let cutChunkText = '';
    let playedMs = 0;
    let discardedMs = 0;
    if (this.playing !== null) {
      const chunk = this.playing;
      cutPlaying = true;
      cutChunkText = chunk.text;
      playedMs = chunk.playedFrames * 20;
      discardedMs = Math.max(0, chunk.estDurationMs - playedMs);
      // Only the not-yet-spoken tail of the cut chunk is
      // discarded; the spoken head was already heard.
      const playedChars = Math.min(chunk.text.length, Math.floor(playedMs / this.options.msPerChar));
      charsDiscarded += chunk.text.length - playedChars;
      chunk.status = 'cancelled';
      chunk.finishedAtMs = this.nowMs;
      this.chunksCancelled += 1;
      this.playing = null;
      this.frameDebtMs = 0;
      this.sink?.({ kind: 'chunk-cancelled', chunk: { ...chunk, frames: chunk.frames } });
    }
    this.charsDiscarded += charsDiscarded;
    const result: TtsStreamCancelResult = {
      cancelled: queued.length > 0 || cutPlaying || bufferedDiscarded > 0,
      chunksCancelled: queued.length + (cutPlaying ? 1 : 0),
      charsDiscarded,
      cutPlaying,
      cutChunkText,
      playedMs,
      discardedMs,
      atMs: this.nowMs,
    };
    this.sink?.({ kind: 'cancelled', result });
    this.maybeEmitDrained();
    return result;
  }

  /** Stop everything (alias of `cancelPending` for the session). */
  stopAll(): TtsStreamCancelResult {
    return this.cancelPending();
  }

  /** Wait until drained — synchronous in the virtual clock: the caller ticks. */
  reset(): void {
    this.buffer = '';
    this.queue = [];
    this.playing = null;
    this.nextChunkId = 1;
    this.nowMs = 0;
    this.paused = false;
    this.frameDebtMs = 0;
    this.firstDeltaAtMs = null;
    this.firstChunkLatencyMs = null;
    this.chunkLatencies = [];
    this.chunks = 0;
    this.chunksDone = 0;
    this.chunksCancelled = 0;
    this.chars = 0;
    this.charsPlayed = 0;
    this.charsDiscarded = 0;
    this.droppedChars = 0;
    this.playedMs = 0;
    this.drainedEmitted = true;
  }

  private enqueueChunk(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const frames = this.synth(trimmed, { chunkId: this.nextChunkId, atMs: this.nowMs });
    const chunk: TtsStreamChunkV11 = {
      id: this.nextChunkId,
      text: trimmed,
      status: 'queued',
      estDurationMs: Math.max(20, trimmed.length * this.options.msPerChar),
      frames,
      playedFrames: 0,
      readyAtMs: this.nowMs,
      startedAtMs: null,
      finishedAtMs: null,
    };
    this.nextChunkId += 1;
    this.chunks += 1;
    this.chars += trimmed.length;
    this.queue.push(chunk);
    if (this.firstChunkLatencyMs === null && this.firstDeltaAtMs !== null) {
      this.firstChunkLatencyMs = this.nowMs - this.firstDeltaAtMs;
    }
    if (this.firstDeltaAtMs !== null) {
      this.chunkLatencies.push(this.nowMs - this.firstDeltaAtMs);
    }
    this.drainedEmitted = false;
    this.sink?.({ kind: 'chunk-ready', chunk: { ...chunk, frames: chunk.frames } });
  }

  private startNextChunk(): void {
    if (this.paused) return;
    const next = this.queue.shift();
    if (!next) {
      this.playing = null;
      return;
    }
    next.status = 'playing';
    next.startedAtMs = this.nowMs;
    this.playing = next;
    this.sink?.({ kind: 'chunk-start', chunk: { ...next, frames: next.frames } });
  }

  private finishPlayingChunk(): void {
    const chunk = this.playing;
    if (!chunk) return;
    chunk.status = 'done';
    chunk.finishedAtMs = this.nowMs;
    this.playing = null;
    this.chunksDone += 1;
    this.charsPlayed += chunk.text.length;
    this.sink?.({ kind: 'chunk-done', chunk: { ...chunk, frames: chunk.frames } });
  }

  private maybeEmitDrained(): void {
    if (this.isDrained() && !this.drainedEmitted) {
      this.drainedEmitted = true;
      this.sink?.({ kind: 'drained', atMs: this.nowMs });
    }
  }
}

/** Create a v11 TTS stream (factory). */
export function createTtsStreamV11(options: TtsStreamV11Options = {}, sink: TtsStreamV11EventSink | null = null): TtsStreamV11 {
  return new TtsStreamV11(options, sink);
}

/** One-line summary of a v11 TTS stream's counters. */
export function ttsStreamV11Summary(stats: TtsStreamV11Stats): string {
  return (
    `TTS stream v11: ${stats.chunks} chunks (${stats.chunksDone} done, ${stats.chunksCancelled} cancelled), ` +
    `${stats.chars} chars (${stats.charsPlayed} played, ${stats.charsDiscarded} discarded, ${stats.droppedChars} dropped), ` +
    `${stats.playedMs} ms played, first-chunk ${stats.firstChunkLatencyMs === null ? '-' : `${stats.firstChunkLatencyMs} ms`}, ` +
    `queued ${stats.queuedChunks}${stats.playing ? ', playing' : ''}${stats.paused ? ', paused' : ''}`
  );
}

/** TTS stream v11 stats as Markdown (for the diagnostics panel). */
export function ttsStreamV11Markdown(stats: TtsStreamV11Stats): string {
  const lines = [
    '## TTS stream v11',
    '',
    `- chunks: ${stats.chunks} (done ${stats.chunksDone}, cancelled ${stats.chunksCancelled})`,
    `- chars: ${stats.chars} (played ${stats.charsPlayed}, discarded ${stats.charsDiscarded}, dropped ${stats.droppedChars})`,
    `- played: ${stats.playedMs} ms`,
    `- first-chunk latency: ${stats.firstChunkLatencyMs === null ? '-' : `${stats.firstChunkLatencyMs} ms`}, mean chunk latency: ${stats.meanChunkLatencyMs} ms`,
    `- queued: ${stats.queuedChunks}, playing: ${stats.playing ? 'yes' : 'no'}, paused: ${stats.paused ? 'yes' : 'no'}, drained: ${stats.drained ? 'yes' : 'no'}`,
  ];
  return lines.join('\n');
}
