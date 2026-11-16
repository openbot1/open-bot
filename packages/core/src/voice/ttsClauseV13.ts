/**
 * Streaming TTS clause-by-clause v13 (v1.14, Đội T5 — voice
 * realtime v13).
 *
 * v12 plans whole sentences (with Vietnamese boundaries,
 * prosody and word timings) and feeds them to the v11 stream.
 * The user still waits for a full sentence before hearing
 * anything. v13 speaks *clauses*: as soon as the LLM has
 * produced a complete clause — "Để tôi kiểm tra lịch của bạn,"
 * — it goes to TTS immediately, while the model is still
 * writing the rest of the reply. Time-to-first-audio drops from
 * "one sentence" to "one clause".
 *
 *   LLM deltas ──▶ ClauseTtsStreamV13.feedTextDelta
 *                    ├─ buffer + splitClausesV13
 *                    │   (sentence ends close a clause;
 *                    │    `,` `;` `:` `—` close one too once
 *                    │    it is long enough; abbreviations
 *                    │    like `TS.` never split)
 *                    ├─ each completed clause ──▶ TtsStreamV12
 *                    │   (planned chunk: word timings + prosody,
 *                    │    so the panel highlights the spoken word)
 *                    └─ join pauses between clauses keep the
 *                        reply seamless (comma 120 ms, semicolon
 *                        180 ms, sentence 250 ms, em dash 300 ms)
 *
 * The stream wraps a `TtsStreamV12`, it does not replace it:
 * clause splitting is the new layer, sentence planning,
 * pacing and playback stay v12's. `flush()` speaks the
 * leftover tail (the last clause, which has no terminator
 * yet). First-clause latency is measured on the caller-owned
 * virtual clock (`atMs` on every feed).
 *
 * No sound card, no network, no key: the inner stream uses
 * the mock synth unless the host wires a live one.
 */

import {
  TtsStreamV12,
  TTS_STREAM_V12_ABBREVIATIONS,
  type TtsStreamV12Options,
  type TtsStreamV12Event,
  type TtsStreamV12Stats,
  type TtsPlannedChunkV12,
} from './ttsStreamV12';
import type { TtsStreamCancelResult, TtsStreamFeedResult } from './ttsStreamV11';

/** One clause ready for (or already sent to) TTS. */
export interface TtsClauseV13 {
  /** Clause number in this reply (1-based). */
  index: number;
  /** Clause text, terminator included. */
  text: string;
  /** What closed the clause. */
  terminator: ',' | ';' | ':' | '—' | '.' | '!' | '?' | '…' | 'end';
  /** True for the final tail clause (no terminator in the text). */
  isTail: boolean;
  /** Pause (ms) to leave before the next clause, so the join sounds seamless. */
  joinPauseMs: number;
  /** Virtual time the clause was completed (ms). */
  completedAtMs: number;
  /** Chars of the reply spoken so far (end of this clause). */
  endChar: number;
}

/** Options for `ClauseTtsStreamV13`. */
export interface TtsClauseV13Options {
  /** Clause closes at `,`/`;`/`:`/`—` once it reaches this length (chars, default 12). */
  minClauseChars?: number;
  /** Longest single clause (chars, default 220 — longer clauses are force-split at a space). */
  maxClauseChars?: number;
  /** TTS v12 options passed to the inner stream. */
  ttsV12?: TtsStreamV12Options;
}

/** Counters for one clause stream. */
export interface TtsClauseV13Stats extends TtsStreamV12Stats {
  clauses: number;
  /** Clauses closed by a sentence end (. ! ? …). */
  sentenceClauses: number;
  /** Clauses closed by a mid-sentence separator (, ; : —). */
  separatorClauses: number;
  /** Tail clauses (flushed without a terminator). */
  tailClauses: number;
  /** Ms from the first feed to the first completed clause (null when none yet). */
  firstClauseLatencyMs: number | null;
  /** Mean clause length (chars, 0 when none). */
  meanClauseChars: number;
  /** Buffered chars not yet emitted as a clause. */
  bufferedChars: number;
  /** Total join-pause ms scheduled between clauses. */
  totalJoinPauseMs: number;
}

/** Events emitted by the clause stream. */
export type TtsClauseV13Event =
  | { kind: 'v12'; event: TtsStreamV12Event }
  | { kind: 'clause-ready'; clause: TtsClauseV13 }
  | { kind: 'flushed'; atMs: number; clauses: number }
  | { kind: 'cancelled'; result: TtsStreamCancelResult };

export type TtsClauseV13EventSink = (event: TtsClauseV13Event) => void;

export function defaultTtsClauseV13Options(): Required<Omit<TtsClauseV13Options, 'ttsV12'>> & { ttsV12: TtsStreamV12Options } {
  return { minClauseChars: 12, maxClauseChars: 220, ttsV12: {} };
}

export function validateTtsClauseV13Options(options: TtsClauseV13Options): Required<Omit<TtsClauseV13Options, 'ttsV12'>> & { ttsV12: TtsStreamV12Options } {
  const base = defaultTtsClauseV13Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`TTS clause v13 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  const minClauseChars = Math.floor(num(options.minClauseChars, base.minClauseChars, 'minClauseChars', 1, 10000));
  const maxClauseChars = Math.floor(num(options.maxClauseChars, base.maxClauseChars, 'maxClauseChars', 1, 100000));
  if (maxClauseChars < minClauseChars) {
    throw new Error(`TTS clause v13 maxClauseChars (${maxClauseChars}) must be >= minClauseChars (${minClauseChars}).`);
  }
  if (options.ttsV12 !== undefined && (typeof options.ttsV12 !== 'object' || options.ttsV12 === null)) {
    throw new Error('TTS clause v13 ttsV12 must be an options object.');
  }
  return { minClauseChars, maxClauseChars, ttsV12: options.ttsV12 ?? {} };
}

/** Join pause (ms) after a clause, by what closed it. */
export function joinPauseForTerminatorV13(terminator: TtsClauseV13['terminator']): number {
  switch (terminator) {
    case ',': return 120;
    case ';':
    case ':': return 180;
    case '—': return 300;
    case '…': return 350;
    case 'end': return 0;
    default: return 250;
  }
}

function isSentenceEnd(ch: string): boolean {
  return ch === '.' || ch === '!' || ch === '?' || ch === '…';
}

function isSeparator(ch: string): boolean {
  return ch === ',' || ch === ';' || ch === ':' || ch === '—';
}

/**
 * Split buffered text into completed clauses plus the leftover
 * tail. Pure — the stream and the tests share it.
 *
 * Rules:
 * - A sentence end (`. ! ? …`) always closes a clause — unless
 *   the `.` belongs to a Vietnamese abbreviation (`TS.`, `BS.`,
 *   `vd.`, …) or a decimal (`3.5`).
 * - A separator (`, ; : —`) closes a clause once the clause is
 *   at least `minClauseChars` long.
 * - A clause longer than `maxClauseChars` is force-split at the
 *   last space before the limit (terminator `end`, marked as a
 *   forced split by the caller through `isTail === false` and a
 *   join pause of 0 — the text continues mid-clause).
 * - The tail (text after the last completed clause) is returned
 *   separately and is NOT a clause until `flush()` speaks it.
 */
export function splitClausesV13(
  text: string,
  options: Required<Omit<TtsClauseV13Options, 'ttsV12'>>,
): { clauses: { text: string; terminator: TtsClauseV13['terminator'] }[]; tail: string } {
  const clauses: { text: string; terminator: TtsClauseV13['terminator'] }[] = [];
  let start = 0;
  const pushClause = (endExclusive: number, terminator: TtsClauseV13['terminator']): void => {
    const raw = text.slice(start, endExclusive);
    if (raw.trim().length === 0) {
      start = endExclusive;
      return;
    }
    clauses.push({ text: raw, terminator });
    start = endExclusive;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const clauseLen = i - start + 1;
    if (isSentenceEnd(ch)) {
      // Abbreviation guard: "TS. Lan" must not split after "TS.".
      if (ch === '.') {
        const before = text.slice(start, i);
        const lastWord = before.split(/\s+/).pop() ?? '';
        const wordCore = lastWord.replace(/[^\p{L}]/gu, '').toLowerCase();
        const next = text[i + 1];
        const prev = text[i - 1];
        const isDecimal = prev !== undefined && /\d/.test(prev) && next !== undefined && /\d/.test(next);
        if (isDecimal || (wordCore.length > 0 && wordCore.length <= 5 && TTS_STREAM_V12_ABBREVIATIONS.has(wordCore))) {
          i += 1;
          continue;
        }
      }
      pushClause(i + 1, ch as TtsClauseV13['terminator']);
      i += 1;
      continue;
    }
    if (isSeparator(ch) && clauseLen >= options.minClauseChars) {
      pushClause(i + 1, ch as TtsClauseV13['terminator']);
      i += 1;
      continue;
    }
    if (clauseLen >= options.maxClauseChars) {
      // Force-split at the last space inside the clause.
      const slice = text.slice(start, i + 1);
      const lastSpace = slice.lastIndexOf(' ');
      if (lastSpace > options.minClauseChars) {
        pushClause(start + lastSpace + 1, 'end');
        i = start;
        continue;
      }
    }
    i += 1;
  }
  return { clauses, tail: text.slice(start) };
}

/**
 * Clause-by-clause TTS stream. Feed LLM text deltas as they
 * arrive; every completed clause is planned and spoken through
 * the inner v12 stream immediately. The caller advances the
 * inner stream with `tick(ms)` (same as v12) and calls
 * `flush()` when the reply is complete.
 */
export class ClauseTtsStreamV13 {
  private readonly options: Required<Omit<TtsClauseV13Options, 'ttsV12'>> & { ttsV12: TtsStreamV12Options };
  private readonly sink: TtsClauseV13EventSink | null;
  private readonly inner: TtsStreamV12;
  private buffer = '';
  private clauses: TtsClauseV13[] = [];
  private firstFeedAtMs: number | null = null;
  private firstClauseLatencyMs: number | null = null;
  private sentenceClauses = 0;
  private separatorClauses = 0;
  private tailClauses = 0;
  private totalJoinPauseMs = 0;

  constructor(options: TtsClauseV13Options = {}, sink: TtsClauseV13EventSink | null = null) {
    this.options = validateTtsClauseV13Options(options);
    this.sink = sink;
    this.inner = new TtsStreamV12(this.options.ttsV12, (event) => {
      this.sink?.({ kind: 'v12', event });
    });
  }

  getOptions(): Required<Omit<TtsClauseV13Options, 'ttsV12'>> & { ttsV12: TtsStreamV12Options } {
    return { ...this.options, ttsV12: { ...this.options.ttsV12 } };
  }

  getInner(): TtsStreamV12 {
    return this.inner;
  }

  /** Completed clauses, oldest first (copies). */
  getClauses(): TtsClauseV13[] {
    return this.clauses.map((c) => ({ ...c }));
  }

  /** Buffered text not yet emitted as a clause. */
  getBufferedText(): string {
    return this.buffer;
  }

  /** Planned v12 chunks for the current / last reply (for the panel). */
  getPlannedChunks(): TtsPlannedChunkV12[] {
    return this.inner.getPlannedChunks();
  }

  /**
   * Feed an LLM text delta. Completed clauses are emitted to
   * the inner stream at once; returns the clauses completed by
   * this feed. `atMs` is the caller-owned virtual clock.
   */
  feedTextDelta(delta: string, input: { final?: boolean; atMs?: number } = {}): { clauses: TtsClauseV13[]; feed: TtsStreamFeedResult } {
    const atMs = input.atMs ?? 0;
    if (this.firstFeedAtMs === null) this.firstFeedAtMs = atMs;
    this.buffer += delta;
    const emitted = this.emitCompletedClauses(atMs);
    if (input.final) {
      const flushed = this.flush(atMs);
      return { clauses: [...emitted.clauses, ...flushed], feed: emitted.feed };
    }
    return emitted;
  }

  private emitCompletedClauses(atMs: number): { clauses: TtsClauseV13[]; feed: TtsStreamFeedResult } {
    const { clauses, tail } = splitClausesV13(this.buffer, this.options);
    this.buffer = tail;
    const out: TtsClauseV13[] = [];
    let feed: TtsStreamFeedResult = { chunksReady: 0, bufferedChars: this.buffer.length, queuedChunks: 0, droppedChars: 0 };
    for (const raw of clauses) {
      const clause = this.recordClause(raw.text, raw.terminator, false, atMs);
      feed = this.inner.feedTextDelta(clause.text, { final: true });
      out.push(clause);
      this.sink?.({ kind: 'clause-ready', clause: { ...clause } });
    }
    return { clauses: out, feed };
  }

  private recordClause(text: string, terminator: TtsClauseV13['terminator'], isTail: boolean, atMs: number): TtsClauseV13 {
    const index = this.clauses.length + 1;
    const joinPauseMs = isTail ? 0 : joinPauseForTerminatorV13(terminator);
    const endChar = this.clauses.reduce((a, c) => a + c.text.length, 0) + text.length;
    const clause: TtsClauseV13 = { index, text, terminator, isTail, joinPauseMs, completedAtMs: atMs, endChar };
    this.clauses.push(clause);
    if (this.firstClauseLatencyMs === null && this.firstFeedAtMs !== null) {
      this.firstClauseLatencyMs = Math.max(0, atMs - this.firstFeedAtMs);
    }
    if (isTail) this.tailClauses += 1;
    else if (isSentenceEnd(terminator)) this.sentenceClauses += 1;
    else this.separatorClauses += 1;
    this.totalJoinPauseMs += joinPauseMs;
    return clause;
  }

  /**
   * Speak the leftover tail as the final clause (even without a
   * terminator). No-op when the buffer is empty. Returns the
   * tail clause, or null.
   */
  flush(atMs = 0): TtsClauseV13[] {
    const tail = this.buffer.trim();
    if (!tail) {
      this.buffer = '';
      this.sink?.({ kind: 'flushed', atMs, clauses: 0 });
      return [];
    }
    this.buffer = '';
    const clause = this.recordClause(tail, 'end', true, atMs);
    this.inner.feedTextDelta(clause.text, { final: true });
    this.sink?.({ kind: 'clause-ready', clause: { ...clause } });
    this.sink?.({ kind: 'flushed', atMs, clauses: 1 });
    return [clause];
  }

  /** Advance the inner stream clock (ms). */
  tick(ms: number): void {
    this.inner.tick(ms);
  }

  /** Cancel everything pending (flushes the queue like a barge-in). */
  cancelPending(): TtsStreamCancelResult {
    const result = this.inner.cancelPending();
    this.buffer = '';
    this.sink?.({ kind: 'cancelled', result });
    return result;
  }

  /** Stop all playback and clear the buffer. */
  stopAll(): TtsStreamCancelResult {
    const result = this.inner.stopAll();
    this.buffer = '';
    this.sink?.({ kind: 'cancelled', result });
    return result;
  }

  isPlaying(): boolean {
    return this.inner.isPlaying();
  }

  isDrained(): boolean {
    return this.inner.isDrained() && this.buffer.length === 0;
  }

  getStats(): TtsClauseV13Stats {
    const inner = this.inner.getStats();
    const chars = this.clauses.reduce((a, c) => a + c.text.length, 0);
    return {
      ...inner,
      clauses: this.clauses.length,
      sentenceClauses: this.sentenceClauses,
      separatorClauses: this.separatorClauses,
      tailClauses: this.tailClauses,
      firstClauseLatencyMs: this.firstClauseLatencyMs,
      meanClauseChars: this.clauses.length === 0 ? 0 : Math.round(chars / this.clauses.length),
      bufferedChars: this.buffer.length,
      totalJoinPauseMs: this.totalJoinPauseMs,
    };
  }

  reset(): void {
    this.inner.stopAll();
    this.buffer = '';
    this.clauses = [];
    this.firstFeedAtMs = null;
    this.firstClauseLatencyMs = null;
    this.sentenceClauses = 0;
    this.separatorClauses = 0;
    this.tailClauses = 0;
    this.totalJoinPauseMs = 0;
  }
}

/** Create a clause TTS stream (factory). */
export function createClauseTtsStreamV13(options: TtsClauseV13Options = {}, sink: TtsClauseV13EventSink | null = null): ClauseTtsStreamV13 {
  return new ClauseTtsStreamV13(options, sink);
}

/** One-line summary of clause-stream stats. */
export function ttsClauseV13Summary(stats: TtsClauseV13Stats): string {
  return (
    `TTS clause v13: ${stats.clauses} clauses ` +
    `(${stats.sentenceClauses} sentence, ${stats.separatorClauses} separator, ${stats.tailClauses} tail), ` +
    `mean ${stats.meanClauseChars} chars, first clause ${stats.firstClauseLatencyMs === null ? '-' : `${stats.firstClauseLatencyMs} ms`}, ` +
    `join pauses ${stats.totalJoinPauseMs} ms, buffered ${stats.bufferedChars} chars`
  );
}

/** Clause-stream stats as Markdown (for the diagnostics panel). */
export function ttsClauseV13Markdown(stats: TtsClauseV13Stats): string {
  const lines = [
    '## TTS clause v13 (streaming)',
    '',
    `- clauses: ${stats.clauses} (sentence ${stats.sentenceClauses}, separator ${stats.separatorClauses}, tail ${stats.tailClauses})`,
    `- mean clause: ${stats.meanClauseChars} chars, first-clause latency: ${stats.firstClauseLatencyMs === null ? '-' : `${stats.firstClauseLatencyMs} ms`}`,
    `- join pauses: ${stats.totalJoinPauseMs} ms, buffered: ${stats.bufferedChars} chars`,
    `- TTS chunks: ${stats.chunks}, chars played: ${stats.charsPlayed}`,
  ];
  return lines.join('\n');
}
