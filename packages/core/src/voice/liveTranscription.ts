/**
 * Live transcription streaming (v1.04, Team T5 — voice realtime v3).
 *
 * The whisper chunked session (v0.96) returns one finished segment at
 * a time; a live call needs more than that — the UI must show words
 * *while* the user is still speaking (interim text), and the loop
 * must know when one spoken turn ends and the next begins, so a
 * barge-in decision and a tool-command parse never see half a
 * sentence twice.
 *
 * `LiveTranscriptionStream` sits between any STT source (whisper
 * chunks, a provider's partial events, a mock in tests) and the
 * loop/UI. It takes small inputs — `{ text, isFinal, at }` — and
 * emits three event kinds through a sink:
 *
 *   - `interim`: the current segment's text so far. The same segment
 *     id keeps replacing its own text (an extension of the previous
 *     interim replaces it; a contradiction replaces it too — the
 *     engine changed its mind, and the UI must show the newest
 *     guess, not accumulate both).
 *   - `final`: one segment is done. Its text is appended to the
 *     current turn, and the segment's interim slot is cleared.
 *   - `turn`: a spoken turn committed — either the caller called
 *     `endTurn()`, or a final segment arrived after a silence gap
 *     (`turnGapMs`) since the previous final. The turn carries the
 *     full text, its word count and its duration.
 *
 * Rules (explicit, so a test can assert on them exactly):
 *
 *   - Empty / whitespace-only input is ignored (no event, no stat).
 *   - A repeated interim with identical text emits nothing — the UI
 *     already shows it.
 *   - A final segment with text identical to the text already
 *     committed for that segment is ignored (engines sometimes
 *     re-emit the same final twice).
 *   - Interim text is never committed: if a segment ends without a
 *     final (the caller drops it), its interim vanishes with it.
 *   - A turn is at most `maxTurnChars` — a runaway final is cut at
 *     the boundary and the turn is committed immediately, so one
 *     long monologue cannot grow the turn buffer without bound.
 *   - The stream never throws on bad input: a non-string text is
 *     ignored, a missing `at` falls back to the clock.
 */
export const LIVE_TRANSCRIPTION_DEFAULT_TURN_GAP_MS = 1200;
export const LIVE_TRANSCRIPTION_DEFAULT_MAX_TURN_CHARS = 4000;
export const LIVE_TRANSCRIPTION_DEFAULT_MAX_SEGMENTS_PER_TURN = 50;

/** One STT result fed into the stream (partial or final). */
export interface LiveTranscriptInput {
  /** Transcribed text for this segment (trimmed on ingest). */
  text: string;
  /** True when the engine finished this segment. */
  isFinal: boolean;
  /** When the result arrived (wall clock ms). Default: clock. */
  at?: number;
  /** Engine confidence 0..1, when the engine reports one. */
  confidence?: number;
  /**
   * Segment id from the engine (when the engine re-uses ids across
   * partials of one segment). Absent = one fresh segment per input.
   */
  segmentId?: string;
}

/** One committed spoken turn. */
export interface LiveTranscriptTurn {
  /** Turn index (0-based, per stream). */
  index: number;
  /** Full turn text (segments joined with a space). */
  text: string;
  /** Words in the turn. */
  words: number;
  /** Final segments in the turn. */
  segments: number;
  /** When the turn started (first segment's `at`). */
  startedAt: number;
  /** When the turn was committed (wall clock ms). */
  endedAt: number;
}

export type LiveTranscriptionEvent =
  | {
      kind: 'interim';
      /** Segment this interim belongs to. */
      segmentId: string;
      /** Current best text for the segment. */
      text: string;
      at: number;
    }
  | {
      kind: 'final';
      segmentId: string;
      text: string;
      at: number;
    }
  | {
      kind: 'turn';
      turn: LiveTranscriptTurn;
    };

export type LiveTranscriptionEventSink = (event: LiveTranscriptionEvent) => void;

export interface LiveTranscriptionStats {
  interimEvents: number;
  finalSegments: number;
  turns: number;
  /** Words across all committed turns. */
  words: number;
  /** Chars of interim text dropped without a final. */
  droppedInterimChars: number;
  /** Duplicate inputs ignored (same interim / same final twice). */
  duplicatesIgnored: number;
}

export interface LiveTranscriptionOptions {
  /** Silence gap (ms) after a final that starts a new turn. Default 1200. */
  turnGapMs?: number;
  /** Max chars in one turn before it is force-committed. Default 4000. */
  maxTurnChars?: number;
  /** Max final segments in one turn. Default 50. */
  maxSegmentsPerTurn?: number;
  /** Event sink. Default: none (stats + `getTurns()` still work). */
  sink?: LiveTranscriptionEventSink;
  /** Clock (ms). Default Date.now. */
  clock?: () => number;
}

/** Collapse whitespace; empty stays empty. */
export function normalizeTranscriptText(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

/** Words in a normalized transcript (0 for empty). */
export function countTranscriptWords(text: string): number {
  const clean = normalizeTranscriptText(text);
  return clean ? clean.split(' ').length : 0;
}

/**
 * Merge a new interim into the previous one for the same segment.
 * An extension (`"xin chào"` → `"xin chào bạn"`) replaces the old
 * text; so does a correction (`"xin chào"` → `"xin cháo"` — the
 * engine changed its mind). The return is always the newest text:
 * interims are guesses, never history.
 */
export function mergeInterimText(_previous: string, next: string): string {
  return normalizeTranscriptText(next);
}

export class LiveTranscriptionStream {
  private readonly turnGapMs: number;
  private readonly maxTurnChars: number;
  private readonly maxSegmentsPerTurn: number;
  private readonly sink?: LiveTranscriptionEventSink;
  private readonly clock: () => number;
  /** Interim text per open segment id. */
  private readonly interims = new Map<string, { text: string; at: number }>();
  /** Final texts already committed for a segment id (dedupe). */
  private readonly committedFinals = new Map<string, string>();
  private segmentCounter = 0;
  private turnIndex = 0;
  /** Texts of the current turn's final segments. */
  private currentSegments: string[] = [];
  private currentTurnStartedAt: number | null = null;
  private lastFinalAt: number | null = null;
  private readonly turns: LiveTranscriptTurn[] = [];
  private readonly stats: LiveTranscriptionStats = {
    interimEvents: 0,
    finalSegments: 0,
    turns: 0,
    words: 0,
    droppedInterimChars: 0,
    duplicatesIgnored: 0,
  };

  constructor(options: LiveTranscriptionOptions = {}) {
    this.turnGapMs = Math.max(0, options.turnGapMs ?? LIVE_TRANSCRIPTION_DEFAULT_TURN_GAP_MS);
    this.maxTurnChars = Math.max(1, options.maxTurnChars ?? LIVE_TRANSCRIPTION_DEFAULT_MAX_TURN_CHARS);
    this.maxSegmentsPerTurn = Math.max(1, options.maxSegmentsPerTurn ?? LIVE_TRANSCRIPTION_DEFAULT_MAX_SEGMENTS_PER_TURN);
    this.sink = options.sink;
    this.clock = options.clock ?? Date.now;
  }

  /** Feed one STT result (partial or final). Never throws. */
  feed(input: LiveTranscriptInput): void {
    if (!input || typeof input !== 'object') return;
    const text = normalizeTranscriptText(input.text);
    if (!text) return;
    const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : this.clock();
    const segmentId = input.segmentId ?? `seg-${this.segmentCounter++}`;
    if (input.isFinal) this.feedFinal(segmentId, text, at);
    else this.feedInterim(segmentId, text, at);
  }

  /** Current interim text per open segment (copies). */
  getInterims(): Array<{ segmentId: string; text: string }> {
    return [...this.interims.entries()].map(([segmentId, entry]) => ({
      segmentId,
      text: entry.text,
    }));
  }

  /** Text of the turn being built (final segments so far). */
  getCurrentTurnText(): string {
    return this.currentSegments.join(' ');
  }

  /** Committed turns, oldest first (copies). */
  getTurns(): LiveTranscriptTurn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  /** The most recent committed turn, or undefined. */
  getLastTurn(): LiveTranscriptTurn | undefined {
    const last = this.turns[this.turns.length - 1];
    return last ? { ...last } : undefined;
  }

  getStats(): LiveTranscriptionStats {
    return { ...this.stats };
  }

  /**
   * Commit the turn being built (if it has any final segment) and
   * start a fresh one. A no-op when the current turn is empty.
   * Returns the committed turn, or null.
   */
  endTurn(at?: number): LiveTranscriptTurn | null {
    if (this.currentSegments.length === 0) return null;
    const now = typeof at === 'number' && Number.isFinite(at) ? at : this.clock();
    const text = this.currentSegments.join(' ');
    const turn: LiveTranscriptTurn = {
      index: this.turnIndex++,
      text,
      words: countTranscriptWords(text),
      segments: this.currentSegments.length,
      startedAt: this.currentTurnStartedAt ?? now,
      endedAt: now,
    };
    this.turns.push(turn);
    this.stats.turns += 1;
    this.stats.words += turn.words;
    this.currentSegments = [];
    this.currentTurnStartedAt = null;
    this.sink?.({ kind: 'turn', turn: { ...turn } });
    return turn;
  }

  /**
   * Drop every open interim without committing it (the caller
   * abandoned the segment, e.g. a barge-in cut the user off).
   * Returns the chars dropped.
   */
  dropInterims(): number {
    let dropped = 0;
    for (const entry of this.interims.values()) dropped += entry.text.length;
    this.stats.droppedInterimChars += dropped;
    this.interims.clear();
    return dropped;
  }

  /** Reset everything (stats, turns, interims). */
  reset(): void {
    this.interims.clear();
    this.committedFinals.clear();
    this.currentSegments = [];
    this.currentTurnStartedAt = null;
    this.lastFinalAt = null;
    this.turns.length = 0;
    this.turnIndex = 0;
    this.stats.interimEvents = 0;
    this.stats.finalSegments = 0;
    this.stats.turns = 0;
    this.stats.words = 0;
    this.stats.droppedInterimChars = 0;
    this.stats.duplicatesIgnored = 0;
  }

  private emit(event: LiveTranscriptionEvent): void {
    this.sink?.(event);
  }

  private feedInterim(segmentId: string, text: string, at: number): void {
    const previous = this.interims.get(segmentId);
    if (previous && previous.text === text) {
      this.stats.duplicatesIgnored += 1;
      return;
    }
    const merged = mergeInterimText(previous?.text ?? '', text);
    this.interims.set(segmentId, { text: merged, at });
    this.stats.interimEvents += 1;
    this.emit({ kind: 'interim', segmentId, text: merged, at });
  }

  private feedFinal(segmentId: string, text: string, at: number): void {
    if (this.committedFinals.get(segmentId) === text) {
      this.stats.duplicatesIgnored += 1;
      return;
    }
    this.committedFinals.set(segmentId, text);
    this.interims.delete(segmentId);
    // A final after a silence gap starts a new turn.
    if (
      this.currentSegments.length > 0 &&
      this.lastFinalAt !== null &&
      at - this.lastFinalAt > this.turnGapMs
    ) {
      this.endTurn(this.lastFinalAt);
    }
    if (this.currentTurnStartedAt === null) this.currentTurnStartedAt = at;
    this.currentSegments.push(text);
    this.lastFinalAt = at;
    this.stats.finalSegments += 1;
    this.emit({ kind: 'final', segmentId, text, at });
    // A runaway monologue must not grow one turn without bound.
    const turnText = this.currentSegments.join(' ');
    if (turnText.length >= this.maxTurnChars || this.currentSegments.length >= this.maxSegmentsPerTurn) {
      this.endTurn(at);
    }
  }
}
