/**
 * Streaming transcript v7 (v1.08, Đội T5 — voice realtime v7).
 *
 * v6's transcript is a finished-lines list: a line appears when
 * the turn is over. A live call needs to see the words *as they
 * arrive* — the user watching the panel should read the sentence
 * while it is still being spoken, and know who is speaking and
 * whether the model is still thinking. This module is the
 * word-by-word transcript:
 *
 *   - Word streaming: `appendWords(speaker, words)` adds words to
 *     the current interim line (same speaker, still open) or
 *     opens a new one; `finalizeLine()` closes it. An interim line
 *     is revised in place (same id, new text) so the UI can render
 *     it with an ellipsis instead of flashing a new row per word.
 *   - Speakers: `user | agent`, kept apart in the line list and
 *     in the stats — the panel renders user lines on one side and
 *     agent lines on the other, like a chat.
 *   - Phase: `idle | listening | thinking | speaking`. The
 *     session drives it: user speech starts → `listening`; user
 *     turn finalized → `thinking` (the model is generating);
 *     agent words start → `speaking`; agent line finalized →
 *     `listening`. The panel shows the phase as a badge, never
 *     guessing from the last line.
 *   - Per-word confidence + timestamps: every word carries its
 *     confidence (STT / TTS word timing when the provider gives
 *     it, 1.0 for scripted mock words) and its arrival time, so
 *     the UI can dim low-confidence words.
 *   - Token estimate: chars / 4 per line, split user (input) vs
 *     agent (output) — the session stats and the panel's token
 *     counter read it from here, not from a second estimate.
 *   - Interruptions: `interruptLine()` marks the open agent line
 *     `interrupted` and keeps the cut text — a cut reply stays
 *     visible as a cut reply, it does not vanish or pretend it
 *     finished.
 *   - Bounded: `maxLines` (default 200) drops the oldest *final*
 *     lines first so a long call cannot grow the list without
 *     bound; the open interim line is never dropped.
 *
 * Pure data shaping, no React, no DOM, no IPC — the session owns
 * the side effects, this owns the transcript so it can be
 * unit-tested with plain node --test.
 */

/** Who spoke a transcript line. */
export type TranscriptV7Speaker = 'user' | 'agent';

/** What the call is doing right now (what the panel badge shows). */
export type TranscriptV7Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

/** One streamed word (confidence 0..1, 1 = scripted / certain). */
export interface TranscriptV7Word {
  text: string;
  confidence: number;
  /** ms since the stream started (injected clock). */
  atMs: number;
}

/** One transcript line (a turn fragment, interim until finalized). */
export interface TranscriptV7Line {
  id: string;
  speaker: TranscriptV7Speaker;
  words: TranscriptV7Word[];
  /** Joined words (single spaces). */
  text: string;
  /** False while the speaker is still revising this line. */
  isFinal: boolean;
  /** Mean word confidence (0..1). */
  confidence: number;
  startedAtMs: number;
  endedAtMs: number | null;
  /** True when the line was cut by a barge-in. */
  interrupted: boolean;
  /** Rough token estimate (chars / 4, rounded up). */
  tokensEstimate: number;
}

/** One transcript event emitted through the sink. */
export type TranscriptV7Event =
  | { kind: 'line-updated'; line: TranscriptV7Line }
  | { kind: 'line-finalized'; line: TranscriptV7Line }
  | { kind: 'phase-changed'; phase: TranscriptV7Phase; atMs: number }
  | { kind: 'cleared'; atMs: number };

/** Sink receiving transcript events. */
export type TranscriptV7EventSink = (event: TranscriptV7Event) => void;

/** Live statistics for the panel / session stats. */
export interface TranscriptV7Stats {
  phase: TranscriptV7Phase;
  lines: number;
  finalLines: number;
  interimLines: number;
  userLines: number;
  agentLines: number;
  userWords: number;
  agentWords: number;
  /** Rough input tokens (user words, chars / 4). */
  inputTokens: number;
  /** Rough output tokens (agent words, chars / 4). */
  outputTokens: number;
  interruptedLines: number;
  /** Words in the open interim line (0 when none open). */
  openWords: number;
}

/** Options for `TranscriptStreamV7`. */
export interface TranscriptStreamV7Options {
  /** Max lines kept (oldest final lines drop first). Default 200. */
  maxLines?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink. */
  onEvent?: TranscriptV7EventSink;
}

/** Default max transcript lines kept per session. */
export const TRANSCRIPT_V7_DEFAULT_MAX_LINES = 200;
/** Rough chars per token for the estimate. */
export const TRANSCRIPT_V7_CHARS_PER_TOKEN = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Rough token estimate for text (chars / 4, rounded up). */
export function estimateTranscriptV7Tokens(text: string): number {
  const chars = (text ?? '').length;
  if (chars === 0) return 0;
  return Math.max(1, Math.ceil(chars / TRANSCRIPT_V7_CHARS_PER_TOKEN));
}

function meanConfidence(words: TranscriptV7Word[]): number {
  if (words.length === 0) return 1;
  let sum = 0;
  for (const word of words) sum += word.confidence;
  return sum / words.length;
}

function lineText(words: TranscriptV7Word[]): string {
  return words.map((w) => w.text).join(' ');
}

/**
 * Word-by-word streaming transcript. Append words as they arrive;
 * finalize when the turn ends. Lines are plain data — the panel
 * renders them, the session stats count them.
 */
export class TranscriptStreamV7 {
  private readonly maxLines: number;
  private readonly clock: () => number;
  private readonly onEvent?: TranscriptV7EventSink;
  private readonly lines: TranscriptV7Line[] = [];
  private phase: TranscriptV7Phase = 'idle';
  private seq = 0;

  constructor(options: TranscriptStreamV7Options = {}) {
    this.maxLines = Math.max(10, Math.floor(options.maxLines ?? TRANSCRIPT_V7_DEFAULT_MAX_LINES));
    this.clock = options.clock ?? Date.now;
    this.onEvent = options.onEvent;
  }

  /** Current phase (what the panel badge shows). */
  getPhase(): TranscriptV7Phase {
    return this.phase;
  }

  /** Set the phase (emits `phase-changed` when it moves). */
  setPhase(phase: TranscriptV7Phase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.emit({ kind: 'phase-changed', phase, atMs: this.clock() });
  }

  /** All lines, oldest first (copies — the caller cannot mutate the stream). */
  getLines(): TranscriptV7Line[] {
    return this.lines.map((line) => ({ ...line, words: line.words.map((w) => ({ ...w })) }));
  }

  /** The open interim line (null when the last line is final or there is none). */
  getOpenLine(): TranscriptV7Line | null {
    const last = this.lines[this.lines.length - 1];
    if (!last || last.isFinal) return null;
    return { ...last, words: last.words.map((w) => ({ ...w })) };
  }

  /** Lines for one speaker only (oldest first). */
  getLinesBySpeaker(speaker: TranscriptV7Speaker): TranscriptV7Line[] {
    return this.getLines().filter((line) => line.speaker === speaker);
  }

  /**
   * Append words to the open line when it belongs to the same
   * speaker and is still interim; otherwise open a new interim
   * line. Words are `{text, confidence?}` (confidence defaults
   * to 1 — scripted / certain). Returns the updated line.
   */
  appendWords(
    speaker: TranscriptV7Speaker,
    words: Array<string | { text: string; confidence?: number }>,
    atMs?: number,
  ): TranscriptV7Line {
    const at = atMs ?? this.clock();
    const clean: TranscriptV7Word[] = [];
    for (const word of words) {
      const text = typeof word === 'string' ? word : word.text;
      if (typeof text !== 'string' || text.trim() === '') continue;
      const confidence = typeof word === 'string' ? 1 : clamp(word.confidence ?? 1, 0, 1);
      clean.push({ text: text.trim(), confidence, atMs: at });
    }
    if (clean.length === 0) {
      const open = this.getOpenLine();
      if (open) return open;
      return this.openLine(speaker, at);
    }
    const last = this.lines[this.lines.length - 1];
    let line: TranscriptV7Line;
    if (last && !last.isFinal && last.speaker === speaker) {
      last.words.push(...clean);
      last.text = lineText(last.words);
      last.confidence = meanConfidence(last.words);
      last.tokensEstimate = estimateTranscriptV7Tokens(last.text);
      line = last;
    } else {
      line = this.openLine(speaker, at);
      line.words.push(...clean);
      line.text = lineText(line.words);
      line.confidence = meanConfidence(line.words);
      line.tokensEstimate = estimateTranscriptV7Tokens(line.text);
    }
    this.prune();
    this.emit({ kind: 'line-updated', line: this.copyLine(line) });
    return this.copyLine(line);
  }

  /**
   * Append whole text (split on whitespace) — the convenience
   * path for scripted mock replies and finalized user turns.
   * `final` closes the line at once (a finished user turn);
   * otherwise the line stays interim (a model still speaking).
   */
  appendText(speaker: TranscriptV7Speaker, text: string, options: { final?: boolean; confidence?: number; atMs?: number } = {}): TranscriptV7Line {
    const line = this.appendWords(
      speaker,
      (text ?? '').split(/\s+/).filter((w) => w.length > 0).map((w) => ({ text: w, confidence: options.confidence ?? 1 })),
      options.atMs,
    );
    if (options.final === true) return this.finalizeLine(line.id);
    return line;
  }

  /** Close the open line (or the named line) — it stops revising. Returns the finalized line. */
  finalizeLine(lineId?: string): TranscriptV7Line {
    const line = lineId !== undefined
      ? this.lines.find((l) => l.id === lineId)
      : this.lines[this.lines.length - 1];
    if (!line) {
      // Nothing to finalize — return an empty final line so the
      // caller never has to null-check a "no line yet" case.
      return this.openLine('agent', this.clock());
    }
    if (!line.isFinal) {
      line.isFinal = true;
      line.endedAtMs = this.clock();
      this.emit({ kind: 'line-finalized', line: this.copyLine(line) });
    }
    return this.copyLine(line);
  }

  /**
   * Mark the open line `interrupted` (barge-in cut the reply) and
   * close it. Returns the cut line, or null when nothing was open.
   * The cut text is kept — the panel shows it as interrupted.
   */
  interruptLine(speaker: TranscriptV7Speaker = 'agent'): TranscriptV7Line | null {
    const last = this.lines[this.lines.length - 1];
    if (!last || last.isFinal || last.speaker !== speaker) return null;
    last.interrupted = true;
    last.isFinal = true;
    last.endedAtMs = this.clock();
    this.emit({ kind: 'line-finalized', line: this.copyLine(last) });
    return this.copyLine(last);
  }

  /** Full transcript as plain text (one line per row, oldest first). */
  getTranscriptText(): string {
    return this.lines.map((line) => `${line.speaker === 'user' ? 'User' : 'Agent'}: ${line.text}`).join('\n');
  }

  /** Transcript as Markdown (interim lines marked, cut lines marked). */
  toMarkdown(): string {
    const out: string[] = ['# Voice transcript', ''];
    for (const line of this.lines) {
      const who = line.speaker === 'user' ? 'User' : 'Agent';
      const marks: string[] = [];
      if (!line.isFinal) marks.push('interim');
      if (line.interrupted) marks.push('interrupted');
      out.push(`- **${who}**: ${line.text}${marks.length > 0 ? ` *(${marks.join(', ')})*` : ''}`);
    }
    return out.join('\n');
  }

  getStats(): TranscriptV7Stats {
    let userWords = 0;
    let agentWords = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let finalLines = 0;
    let userLines = 0;
    let agentLines = 0;
    let interruptedLines = 0;
    for (const line of this.lines) {
      if (line.isFinal) finalLines += 1;
      if (line.speaker === 'user') {
        userLines += 1;
        userWords += line.words.length;
        inputTokens += line.tokensEstimate;
      } else {
        agentLines += 1;
        agentWords += line.words.length;
        outputTokens += line.tokensEstimate;
      }
      if (line.interrupted) interruptedLines += 1;
    }
    const open = this.getOpenLine();
    return {
      phase: this.phase,
      lines: this.lines.length,
      finalLines,
      interimLines: this.lines.length - finalLines,
      userLines,
      agentLines,
      userWords,
      agentWords,
      inputTokens,
      outputTokens,
      interruptedLines,
      openWords: open ? open.words.length : 0,
    };
  }

  /** Drop all lines (new session / new call). */
  clear(): void {
    this.lines.length = 0;
    this.phase = 'idle';
    this.emit({ kind: 'cleared', atMs: this.clock() });
  }

  private openLine(speaker: TranscriptV7Speaker, atMs: number): TranscriptV7Line {
    this.seq += 1;
    const line: TranscriptV7Line = {
      id: `v7-line-${this.seq}`,
      speaker,
      words: [],
      text: '',
      isFinal: false,
      confidence: 1,
      startedAtMs: atMs,
      endedAtMs: null,
      interrupted: false,
      tokensEstimate: 0,
    };
    this.lines.push(line);
    return line;
  }

  private copyLine(line: TranscriptV7Line): TranscriptV7Line {
    return { ...line, words: line.words.map((w) => ({ ...w })) };
  }

  /** Drop the oldest final lines past the cap (the open interim line is never dropped). */
  private prune(): void {
    while (this.lines.length > this.maxLines) {
      const idx = this.lines.findIndex((line) => line.isFinal);
      if (idx === -1) break;
      this.lines.splice(idx, 1);
    }
  }

  private emit(event: TranscriptV7Event): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the transcript.
    }
  }
}
