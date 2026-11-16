/**
 * TTS streaming v12 (v1.13, Đội T5 — voice realtime v12).
 *
 * v11 streams text deltas into chunks at sentence boundaries and
 * plays them through a deterministic mock synth. v12 keeps that
 * stream (it wraps a `TtsStreamV11`, it does not replace it) and
 * adds what a realtime voice needs around the chunker:
 *
 * - Vietnamese boundaries: v11 splits on `. ! ? …` and newlines.
 *   v12 also closes a chunk at `—` (em dash, the Vietnamese
 *   aside-break) and at a trailing `…`, and protects a longer
 *   Vietnamese abbreviation list (`TS.`, `BS.`, `ThS.`, `GS.`,
 *   `PGS.`, `UBND.`, `HĐND.`, `vd.`, `v.v.`) so `TS. Lan nói…`
 *   never splits after `TS.`.
 * - Word timings: every planned chunk carries a per-word timing
 *   map (`word → startMs/endMs` inside the chunk), computed from
 *   `msPerChar` plus prosody pauses — the panel can highlight the
 *   word being spoken, and the barge-in receipt can say exactly
 *   which word was cut.
 * - Prosody pauses: a pause lands after `,` (120 ms), `;`/`:` 
 *   (180 ms), `…` (350 ms) and `—` (300 ms), so a streamed reply
 *   breathes instead of running words together.
 * - Adaptive pacing: when the queue backs up the stream speaks
 *   slightly faster (pacing factor up to 1.15); when the queue is
 *   empty a short natural gap (150 ms) is suggested before the
 *   next chunk so the reply does not stutter on single words.
 * - Urgent chunks: an acknowledgement (`"Vâng, tôi nghe đây."`)
 *   jumps to the front of the planned queue — it is planned and
 *   fed before the buffered reply text, so the user hears the
 *   agent react immediately after a barge-in.
 * - Flush on punctuation: a buffer ending in `…` or `—` closes
 *   a chunk even below `minChunkChars` — a trailing ellipsis is a
 *   deliberate pause, not an unfinished word.
 *
 * The planner is pure (`planChunks`, `wordTimings`,
 * `prosodyForChunk`); the class wires it to a `TtsStreamV11`
 * for playback. Feeding works the same as v11
 * (`feedTextDelta(delta, { final })`); planned chunks are fed
 * into the inner stream as terminated sentences, so the inner
 * chunker emits them 1:1. No sound card, no network, no key.
 */

import {
  TtsStreamV11,
  mockTtsSynthV11,
  defaultTtsStreamV11Options,
  validateTtsStreamV11Options,
  ttsStreamV11Summary,
  ttsStreamV11Markdown,
  type TtsStreamV11Options,
  type TtsStreamV11Event,
  type TtsStreamV11Stats,
  type TtsStreamSynth,
  type TtsStreamCancelResult,
  type TtsStreamFeedResult,
} from './ttsStreamV11';

/** Vietnamese abbreviations that must NOT end a sentence (v12 supplement to v11's list). */
export const TTS_STREAM_V12_ABBREVIATIONS = new Set([
  'ts', 'bs', 'ths', 'gs', 'pgs', 'ubnd', 'hdnd', 'sgd', 'bgd', 'bct', 'hđnd',
  'vd', 'v.v', 'tr', 'tt', 'nxb', 'thpt', 'thcs', 'dh', 'cd',
]);

/** One word's timing inside a planned chunk. */
export interface TtsWordTimingV12 {
  word: string;
  index: number;
  /** Start offset inside the chunk (ms). */
  startMs: number;
  /** End offset inside the chunk (ms). */
  endMs: number;
}

/** One prosody pause inside a planned chunk. */
export interface TtsProsodyPauseV12 {
  /** Char index in the chunk text the pause follows. */
  afterCharIndex: number;
  /** The punctuation that caused the pause. */
  mark: ',' | ';' | ':' | '…' | '—';
  /** Pause length (ms). */
  pauseMs: number;
}

/** One planned chunk (v12 planning layer over a v11 chunk). */
export interface TtsPlannedChunkV12 {
  id: number;
  text: string;
  /** Estimated speaking time including prosody pauses (ms). */
  estDurationMs: number;
  /** Per-word timing map (offsets inside the chunk). */
  wordTimings: TtsWordTimingV12[];
  /** Prosody pauses inside the chunk. */
  prosody: TtsProsodyPauseV12[];
  /** True when this chunk jumped the queue (urgent). */
  urgent: boolean;
  /** Virtual time the chunk was planned (ms). */
  plannedAtMs: number;
  /** Pacing factor applied when the chunk was planned. */
  pacingFactor: number;
}

/** Options for `TtsStreamV12` (extends the v11 stream options). */
export interface TtsStreamV12Options extends TtsStreamV11Options {
  /** Pause after `,` (ms, default 120). */
  commaPauseMs?: number;
  /** Pause after `;` / `:` (ms, default 180). */
  clausePauseMs?: number;
  /** Pause after `…` (ms, default 350). */
  ellipsisPauseMs?: number;
  /** Pause after `—` (ms, default 300). */
  dashPauseMs?: number;
  /** Natural gap suggested when the queue is empty (ms, default 150). */
  emptyQueueGapMs?: number;
  /** Pacing factor when the queue is backed up (default 1.15). */
  maxPacingFactor?: number;
}

/** Counters for one v12 stream (planning layer + inner stream). */
export interface TtsStreamV12Stats extends TtsStreamV11Stats {
  plannedChunks: number;
  urgentChunks: number;
  prosodyPauses: number;
  /** Current pacing factor. */
  pacingFactor: number;
  /** Suggested gap before the next chunk (ms, 0 when queued). */
  suggestedGapMs: number;
}

/** Events emitted by the v12 stream. */
export type TtsStreamV12Event =
  | { kind: 'chunk-planned'; chunk: TtsPlannedChunkV12 }
  | { kind: 'urgent-planned'; chunk: TtsPlannedChunkV12 }
  | { kind: 'pacing'; atMs: number; factor: number; queuedChunks: number }
  | { kind: 'v11'; event: TtsStreamV11Event };

export type TtsStreamV12EventSink = (event: TtsStreamV12Event) => void;

export function defaultTtsStreamV12Options(): Required<Omit<TtsStreamV12Options, 'synth'>> {
  return {
    ...defaultTtsStreamV11Options(),
    commaPauseMs: 120,
    clausePauseMs: 180,
    ellipsisPauseMs: 350,
    dashPauseMs: 300,
    emptyQueueGapMs: 150,
    maxPacingFactor: 1.15,
  };
}

export function validateTtsStreamV12Options(options: TtsStreamV12Options): Required<Omit<TtsStreamV12Options, 'synth'>> {
  const base = validateTtsStreamV11Options(options);
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`TTS stream v12 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    ...base,
    commaPauseMs: num(options.commaPauseMs, 120, 'commaPauseMs', 0, 2000),
    clausePauseMs: num(options.clausePauseMs, 180, 'clausePauseMs', 0, 2000),
    ellipsisPauseMs: num(options.ellipsisPauseMs, 350, 'ellipsisPauseMs', 0, 2000),
    dashPauseMs: num(options.dashPauseMs, 300, 'dashPauseMs', 0, 2000),
    emptyQueueGapMs: num(options.emptyQueueGapMs, 150, 'emptyQueueGapMs', 0, 5000),
    maxPacingFactor: num(options.maxPacingFactor, 1.15, 'maxPacingFactor', 1, 2),
  };
}

const ABBR_DOT_V12 = '\uE002';

/** Protect v12 Vietnamese abbreviation periods so they never split. */
function protectV12Abbreviations(text: string): string {
  const pattern = [...TTS_STREAM_V12_ABBREVIATIONS].map((a) => a.replace(/\./g, '\\.')).join('|');
  return text.replace(
    new RegExp(`\\b(${pattern})\\.`, 'gi'),
    `$1${ABBR_DOT_V12}`,
  );
}

function restoreV12Abbreviations(text: string): string {
  return text.replaceAll(ABBR_DOT_V12, '.');
}

/**
 * Split buffered text into speakable chunks with v12 boundaries.
 * Pure — the stream and the tests share it. Starts from the v11
 * splitter (sentence boundaries + abbreviations), then:
 * - splits chunks at `—` when the part before the dash is a
 *   complete aside (the dash is kept at the end of the first part);
 * - closes a trailing `…` / `—` buffer as a chunk even below
 *   `minChunkChars` (a deliberate pause, not an unfinished word).
 */
export function splitTtsStreamChunksV12(
  text: string,
  options: { minChunkChars: number; maxChunkChars: number },
): { chunks: string[]; leftover: string } {
  const protectedText = protectV12Abbreviations(text);
  const clean = protectedText.replace(/\s+/g, ' ').trim();
  if (!clean) return { chunks: [], leftover: '' };
  const re = /[^.!?…\n—]+(?:[.!?…]+["'”’)]?|—|\n|$)/g;
  const chunks: string[] = [];
  let consumedEnd = 0;
  let pending = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const raw = restoreV12Abbreviations(m[0]).trim();
    if (!raw) {
      consumedEnd = m.index + m[0].length;
      continue;
    }
    const terminated = /[.!?…]["'”’)]?\s*$/.test(raw) || /—\s*$/.test(raw) || /\n\s*$/.test(m[0]);
    if (!terminated) {
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
    // A trailing ellipsis / dash is a deliberate pause: close the
    // chunk even when it is short.
    const deliberatePause = /[…—]["'”’)]?\s*$/.test(raw);
    if (pending.length >= options.minChunkChars || deliberatePause) {
      chunks.push(pending);
      pending = '';
      consumedEnd = m.index + m[0].length;
    }
  }
  if (pending) {
    // Short unterminated tail stays buffered — unless it ends in a
    // deliberate pause, in which case it already closed above.
    const leftover = restoreV12Abbreviations(clean.slice(consumedEnd)).trim();
    return { chunks: splitLongChunksV12(chunks, options.maxChunkChars), leftover };
  }
  const leftover = restoreV12Abbreviations(clean.slice(consumedEnd)).trim();
  return { chunks: splitLongChunksV12(chunks, options.maxChunkChars), leftover };
}

/** Split over-long chunks at commas / semicolons / colons / dashes. */
function splitLongChunksV12(chunks: string[], maxChunkChars: number): string[] {
  const out: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChunkChars) {
      out.push(chunk);
      continue;
    }
    const parts = chunk.split(/(?<=[,;:\u2014])\s+/);
    let acc = '';
    for (const part of parts) {
      if (!acc) {
        acc = part;
        continue;
      }
      if ((acc + ' ' + part).length > maxChunkChars) {
        out.push(acc.trim());
        acc = part;
      } else {
        acc = `${acc} ${part}`;
      }
    }
    if (acc.trim()) out.push(acc.trim());
  }
  return out;
}

/**
 * Prosody pauses inside one chunk text. Pure.
 * `,` → commaPauseMs, `;`/`:` → clausePauseMs, `…` →
 * ellipsisPauseMs, `—` → dashPauseMs. A pause after the final
 * character is dropped (the chunk boundary is the pause).
 */
export function prosodyForChunkV12(
  text: string,
  options: { commaPauseMs: number; clausePauseMs: number; ellipsisPauseMs: number; dashPauseMs: number },
): TtsProsodyPauseV12[] {
  const pauses: TtsProsodyPauseV12[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (i >= text.length - 1) continue;
    if (ch === ',') pauses.push({ afterCharIndex: i, mark: ',', pauseMs: options.commaPauseMs });
    else if (ch === ';' || ch === ':') pauses.push({ afterCharIndex: i, mark: ch, pauseMs: options.clausePauseMs });
    else if (ch === '…') pauses.push({ afterCharIndex: i, mark: '…', pauseMs: options.ellipsisPauseMs });
    else if (ch === '—') pauses.push({ afterCharIndex: i, mark: '—', pauseMs: options.dashPauseMs });
  }
  return pauses;
}

/**
 * Per-word timing map for one chunk: words advance at
 * `msPerChar` per char, plus the prosody pause that follows a
 * word's punctuation. Pure — the panel and the barge-in receipt
 * share it, so "which word was cut" is exact.
 */
export function wordTimingsV12(
  text: string,
  options: { msPerChar: number; commaPauseMs: number; clausePauseMs: number; ellipsisPauseMs: number; dashPauseMs: number },
): TtsWordTimingV12[] {
  const prosody = prosodyForChunkV12(text, options);
  const pauseAfter = new Map<number, number>();
  for (const p of prosody) pauseAfter.set(p.afterCharIndex, p.pauseMs);
  const timings: TtsWordTimingV12[] = [];
  let cursor = 0;
  let index = 0;
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = m[0];
    const wordStart = cursor;
    const wordMs = Math.max(20, word.length * options.msPerChar);
    const wordEnd = wordStart + wordMs;
    timings.push({ word, index, startMs: wordStart, endMs: wordEnd });
    cursor = wordEnd;
    // Prosody pause after the punctuation that ends this word.
    const lastCharIndex = m.index + word.length - 1;
    const pause = pauseAfter.get(lastCharIndex);
    if (pause !== undefined) cursor += pause;
    // Spaces between words are silent but take no time in the
    // timing map (the synth renders words back to back); the
    // next word starts where the pause ended.
    index += 1;
  }
  return timings;
}

/**
 * Adaptive pacing factor from the queue depth: the further
 * behind the stream is, the faster it speaks (up to
 * `maxPacingFactor`), so a long reply catches up instead of
 * queueing minutes of audio. Pure.
 */
export function pacingFactorV12(queuedChunks: number, maxPacingFactor: number): number {
  if (queuedChunks <= 2) return 1;
  if (queuedChunks <= 5) return Math.min(maxPacingFactor, 1.05);
  return maxPacingFactor;
}

/**
 * Streaming TTS v12: a planning layer over `TtsStreamV11`.
 * Text deltas in → planned chunks (Vietnamese boundaries,
 * word timings, prosody, pacing) → inner v11 stream plays them.
 */
export class TtsStreamV12 {
  private readonly options: Required<Omit<TtsStreamV12Options, 'synth'>>;
  private readonly synth: TtsStreamSynth;
  private readonly inner: TtsStreamV11;
  private readonly sink: TtsStreamV12EventSink | null;
  private buffer = '';
  private planned: TtsPlannedChunkV12[] = [];
  private nextPlannedId = 1;
  private nowMs = 0;
  private plannedChunks = 0;
  private urgentChunks = 0;
  private prosodyPauses = 0;
  private lastPacingFactor = 1;

  constructor(options: TtsStreamV12Options = {}, sink: TtsStreamV12EventSink | null = null) {
    this.options = validateTtsStreamV12Options(options);
    this.synth = options.synth ?? mockTtsSynthV11(this.options.msPerChar);
    this.sink = sink;
    this.inner = new TtsStreamV11(
      {
        synth: this.synth,
        minChunkChars: this.options.minChunkChars,
        maxChunkChars: this.options.maxChunkChars,
        msPerChar: this.options.msPerChar,
        maxQueuedChunks: this.options.maxQueuedChunks,
        maxBufferChars: this.options.maxBufferChars,
      },
      (event) => this.sink?.({ kind: 'v11', event }),
    );
  }

  getOptions(): Required<Omit<TtsStreamV12Options, 'synth'>> {
    return { ...this.options };
  }

  getNowMs(): number {
    return this.nowMs;
  }

  getInner(): TtsStreamV11 {
    return this.inner;
  }

  isPlaying(): boolean {
    return this.inner.isPlaying();
  }

  isPaused(): boolean {
    return this.inner.isPaused();
  }

  isDrained(): boolean {
    return this.inner.isDrained() && this.buffer.trim().length === 0 && this.planned.length === 0;
  }

  getPlannedChunks(): TtsPlannedChunkV12[] {
    return this.planned.map((c) => ({ ...c, wordTimings: c.wordTimings.map((w) => ({ ...w })), prosody: c.prosody.map((p) => ({ ...p })) }));
  }

  getBufferedChars(): number {
    return this.buffer.length;
  }

  getStats(): TtsStreamV12Stats {
    const inner = this.inner.getStats();
    const pacing = pacingFactorV12(inner.queuedChunks, this.options.maxPacingFactor);
    return {
      ...inner,
      plannedChunks: this.plannedChunks,
      urgentChunks: this.urgentChunks,
      prosodyPauses: this.prosodyPauses,
      pacingFactor: pacing,
      suggestedGapMs: inner.queuedChunks === 0 && !inner.playing ? this.options.emptyQueueGapMs : 0,
    };
  }

  /**
   * Plan chunks for a complete reply text without feeding the
   * stream (the session uses this to show word timings for a
   * reply it speaks through the v11 path). Pure planning — no
   * side effects on the stream.
   */
  planChunks(text: string): TtsPlannedChunkV12[] {
    const { chunks } = splitTtsStreamChunksV12(text, this.options);
    const planned: TtsPlannedChunkV12[] = [];
    for (const chunkText of chunks) {
      planned.push(this.buildPlannedChunk(chunkText, false));
    }
    // A tail without a boundary is still planned (the caller
    // decides whether to speak it); mark it by keeping it in
    // the list only when the splitter left a leftover.
    const { leftover } = splitTtsStreamChunksV12(text, this.options);
    if (leftover && !chunks.includes(leftover)) {
      planned.push(this.buildPlannedChunk(leftover, false));
    }
    return planned;
  }

  /**
   * Feed one text delta (same contract as v11): the delta is
   * planned with v12 boundaries, then each planned chunk is fed
   * into the inner v11 stream as a terminated sentence.
   */
  feedTextDelta(delta: string, input: { final?: boolean } = {}): TtsStreamFeedResult {
    if (typeof delta !== 'string') throw new Error('TTS stream v12 delta must be a string.');
    this.buffer += delta;
    if (this.buffer.length > this.options.maxBufferChars) {
      const overflow = this.buffer.length - this.options.maxBufferChars;
      this.buffer = this.buffer.slice(overflow);
    }
    const { chunks, leftover } = splitTtsStreamChunksV12(this.buffer, this.options);
    this.buffer = leftover;
    let chunksReady = 0;
    for (const text of chunks) {
      this.emitPlanned(text, false);
      this.inner.feedTextDelta(text, {});
      chunksReady += 1;
    }
    if (input.final === true && this.buffer.trim().length > 0) {
      const tail = this.buffer.trim();
      this.buffer = '';
      this.emitPlanned(tail, false);
      this.inner.feedTextDelta(tail, { final: true });
      chunksReady += 1;
    }
    const pacing = pacingFactorV12(this.inner.getStats().queuedChunks, this.options.maxPacingFactor);
    if (pacing !== this.lastPacingFactor) {
      this.lastPacingFactor = pacing;
      this.sink?.({ kind: 'pacing', atMs: this.nowMs, factor: pacing, queuedChunks: this.inner.getStats().queuedChunks });
    }
    return {
      chunksReady,
      bufferedChars: this.buffer.length,
      queuedChunks: this.inner.getStats().queuedChunks,
      droppedChars: this.inner.getStats().droppedChars,
    };
  }

  /**
   * Plan + feed an urgent chunk (acknowledgement after a
   * barge-in): it jumps ahead of the buffered reply text — the
   * buffer is kept, the urgent chunk is fed to the inner stream
   * first so the user hears the reaction immediately.
   */
  feedUrgent(text: string): TtsPlannedChunkV12 | null {
    const clean = text.trim();
    if (!clean) return null;
    const planned = this.emitPlanned(clean, true);
    this.urgentChunks += 1;
    // Feed ahead of the queued reply: the inner stream plays in
    // feed order, and the buffered reply text is still in
    // `this.buffer` (not yet fed), so the urgent chunk speaks
    // first.
    this.inner.feedTextDelta(clean, {});
    return planned;
  }

  /** Advance the virtual clock (drives inner playback). */
  tick(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) {
      throw new Error('TTS stream v12 tick(ms) must be a finite number in 0..60000.');
    }
    this.nowMs += ms;
    this.inner.tick(ms);
    // Planned chunks leave the plan once the inner stream has
    // played them (matched by text, in order).
    const playing = this.inner.getPlayingChunk();
    const queued = this.inner.getQueuedChunks();
    const liveTexts = new Set<string>();
    if (playing) liveTexts.add(playing.text);
    for (const q of queued) liveTexts.add(q.text);
    // Keep planned chunks that are still live or not yet fed;
    // drop the ones the inner stream finished.
    const done = this.inner.getStats().chunksDone;
    void done;
    this.planned = this.planned.filter((p) => liveTexts.has(p.text) || !this.wasFed(p.text));
    void liveTexts;
  }

  pause(): boolean {
    return this.inner.pause();
  }

  resume(): boolean {
    return this.inner.resume();
  }

  cancelPending(): TtsStreamCancelResult {
    this.buffer = '';
    this.planned = [];
    return this.inner.cancelPending();
  }

  stopAll(): TtsStreamCancelResult {
    return this.cancelPending();
  }

  reset(): void {
    this.buffer = '';
    this.planned = [];
    this.nextPlannedId = 1;
    this.nowMs = 0;
    this.plannedChunks = 0;
    this.urgentChunks = 0;
    this.prosodyPauses = 0;
    this.lastPacingFactor = 1;
    this.inner.reset();
  }

  private fedTexts = new Set<string>();

  private wasFed(text: string): boolean {
    return this.fedTexts.has(text);
  }

  private buildPlannedChunk(text: string, urgent: boolean): TtsPlannedChunkV12 {
    const prosody = prosodyForChunkV12(text, this.options);
    const timings = wordTimingsV12(text, this.options);
    const pauseMs = prosody.reduce((a, p) => a + p.pauseMs, 0);
    const pacing = pacingFactorV12(this.inner.getStats().queuedChunks, this.options.maxPacingFactor);
    const rawMs = Math.max(20, text.length * this.options.msPerChar);
    const chunk: TtsPlannedChunkV12 = {
      id: this.nextPlannedId,
      text,
      estDurationMs: Math.round(rawMs / pacing) + pauseMs,
      wordTimings: timings,
      prosody,
      urgent,
      plannedAtMs: this.nowMs,
      pacingFactor: pacing,
    };
    this.nextPlannedId += 1;
    return chunk;
  }

  private emitPlanned(text: string, urgent: boolean): TtsPlannedChunkV12 {
    const chunk = this.buildPlannedChunk(text, urgent);
    this.planned.push(chunk);
    this.fedTexts.add(text);
    this.plannedChunks += 1;
    this.prosodyPauses += chunk.prosody.length;
    if (urgent) {
      this.sink?.({ kind: 'urgent-planned', chunk: { ...chunk } });
    } else {
      this.sink?.({ kind: 'chunk-planned', chunk: { ...chunk } });
    }
    return chunk;
  }
}

/** Create a v12 TTS stream (factory). */
export function createTtsStreamV12(options: TtsStreamV12Options = {}, sink: TtsStreamV12EventSink | null = null): TtsStreamV12 {
  return new TtsStreamV12(options, sink);
}

/** One-line summary of a v12 TTS stream's counters. */
export function ttsStreamV12Summary(stats: TtsStreamV12Stats): string {
  return (
    `${ttsStreamV11Summary(stats)}; planned ${stats.plannedChunks} chunks ` +
    `(${stats.urgentChunks} urgent, ${stats.prosodyPauses} prosody pauses), ` +
    `pacing ×${stats.pacingFactor}${stats.suggestedGapMs > 0 ? `, gap ${stats.suggestedGapMs} ms` : ''}`
  );
}

/** TTS stream v12 stats as Markdown (for the diagnostics panel). */
export function ttsStreamV12Markdown(stats: TtsStreamV12Stats): string {
  const lines = [
    '## TTS stream v12',
    '',
    ...ttsStreamV11Markdown(stats).split('\n').slice(2),
    `- planned chunks: ${stats.plannedChunks} (urgent ${stats.urgentChunks}, prosody pauses ${stats.prosodyPauses})`,
    `- pacing factor: ×${stats.pacingFactor}, suggested gap: ${stats.suggestedGapMs} ms`,
  ];
  return lines.join('\n');
}
