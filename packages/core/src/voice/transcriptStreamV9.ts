/**
 * Streaming transcript v9 (v1.10, Đội T5 — voice realtime v5).
 *
 * A realtime call does not produce text in one lump: the recogniser
 * emits partial hypotheses ("xin", "xin chào", "xin chào bạn") that
 * the UI streams live, then a final text when the turn ends. This
 * module owns that lifecycle for the v9 session:
 *
 * - `pushPartial(text, { speakerId, atMs })` replaces the current
 *   interim hypothesis for a speaker (partials are cumulative, not
 *   appended — the recogniser re-emits the whole sentence so far).
 * - `commit({ speakerId, atMs })` finalises the interim into a turn
 *   with its full partial history (so the UI can show how the
 *   hypothesis evolved) and clears the interim slot.
 * - `noteFinal(text, ...)` records a turn directly when the caller
 *   already has final text (scripted mock turns, PTT turns).
 * - Turns carry speaker, timing and a `toolCalls` list: when the
 *   agent calls a tool mid-reply, the call is attached to the turn
 *   it interrupted instead of floating in a separate log.
 * - `getLiveText()` returns what the panel should show right now:
 *   committed turns plus the live interim, so the transcript never
 *   flickers between "nothing" and "everything".
 * - The stream is bounded: `maxTurns` caps memory on long calls;
 *   the oldest committed turns are dropped first, and the drop is
 *   counted in stats (never silent).
 *
 * Pure data, no audio, no network. Deterministic: the caller owns
 * the clock and passes `atMs` explicitly.
 */

/** Who spoke a turn: the user, the agent, or a named speaker. */
export type TranscriptV9Speaker = 'user' | 'agent' | string;

/** One tool call made while a turn was being spoken. */
export interface TranscriptV9ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  ok: boolean;
  atMs: number;
}

/** One committed transcript turn. */
export interface TranscriptV9Turn {
  id: string;
  speakerId: TranscriptV9Speaker;
  text: string;
  startedAtMs: number;
  endedAtMs: number;
  /** Every interim hypothesis that led to this text (in order). */
  partials: string[];
  /** Tool calls made while this turn was live. */
  toolCalls: TranscriptV9ToolCall[];
  /** True when the text came from a final source, not a partial. */
  final: boolean;
}

/** Counters for one stream. */
export interface TranscriptV9Stats {
  turns: number;
  partials: number;
  commits: number;
  toolCalls: number;
  droppedTurns: number;
  liveInterimChars: number;
}

export interface TranscriptV9Options {
  /** Max committed turns kept (default 200). */
  maxTurns?: number;
  /** Max chars kept in one interim hypothesis (default 4000). */
  maxPartialChars?: number;
}

export const TRANSCRIPT_V9_DEFAULT_MAX_TURNS = 200;
export const TRANSCRIPT_V9_DEFAULT_MAX_PARTIAL_CHARS = 4000;

export function validateTranscriptV9Options(options: TranscriptV9Options): Required<TranscriptV9Options> {
  const maxTurns = options.maxTurns ?? TRANSCRIPT_V9_DEFAULT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 5000) {
    throw new Error('Transcript v9 maxTurns must be an integer in [1, 5000].');
  }
  const maxPartialChars = options.maxPartialChars ?? TRANSCRIPT_V9_DEFAULT_MAX_PARTIAL_CHARS;
  if (!Number.isInteger(maxPartialChars) || maxPartialChars < 16 || maxPartialChars > 20000) {
    throw new Error('Transcript v9 maxPartialChars must be an integer in [16, 20000].');
  }
  return { maxTurns, maxPartialChars };
}

let transcriptV9Seq = 0;

function nextTurnId(): string {
  transcriptV9Seq += 1;
  return `turn-v9-${transcriptV9Seq}`;
}

/**
 * Streaming transcript: interim hypotheses + committed turns.
 * One instance per session; the session passes its own clock.
 */
export class TranscriptStreamV9 {
  private readonly options: Required<TranscriptV9Options>;
  private turns: TranscriptV9Turn[] = [];
  private interim: { speakerId: TranscriptV9Speaker; text: string; startedAtMs: number; partials: string[] } | null = null;
  /** Tool calls made while the interim is live (flushed into the turn on commit). */
  private pendingToolCalls: TranscriptV9ToolCall[] = [];
  private stats: TranscriptV9Stats = {
    turns: 0, partials: 0, commits: 0, toolCalls: 0, droppedTurns: 0, liveInterimChars: 0,
  };

  constructor(options: TranscriptV9Options = {}) {
    this.options = validateTranscriptV9Options(options);
  }

  getStats(): TranscriptV9Stats {
    return { ...this.stats, liveInterimChars: this.interim?.text.length ?? 0 };
  }

  getTurns(): TranscriptV9Turn[] {
    return this.turns.map((t) => ({ ...t, partials: [...t.partials], toolCalls: [...t.toolCalls] }));
  }

  getTurn(id: string): TranscriptV9Turn | undefined {
    const found = this.turns.find((t) => t.id === id);
    return found ? { ...found, partials: [...found.partials], toolCalls: [...found.toolCalls] } : undefined;
  }

  /** Current interim hypothesis, if any. */
  getInterim(): { speakerId: TranscriptV9Speaker; text: string; startedAtMs: number } | null {
    return this.interim ? { speakerId: this.interim.speakerId, text: this.interim.text, startedAtMs: this.interim.startedAtMs } : null;
  }

  /** True when an interim hypothesis is live. */
  hasInterim(): boolean {
    return this.interim !== null;
  }

  /**
   * Replace the interim hypothesis for `speakerId`. A partial from a
   * different speaker commits the previous interim first (a speaker
   * change finalises the previous speaker's text).
   */
  pushPartial(text: string, input: { speakerId?: TranscriptV9Speaker; atMs: number }): string {
    if (typeof text !== 'string') throw new Error('Transcript v9 partial must be a string.');
    const speakerId = input.speakerId ?? 'user';
    const capped = text.slice(0, this.options.maxPartialChars);
    if (this.interim && this.interim.speakerId !== speakerId) {
      this.commit({ atMs: input.atMs });
    }
    if (!this.interim) {
      this.interim = { speakerId, text: '', startedAtMs: input.atMs, partials: [] };
    }
    this.interim.text = capped;
    this.interim.partials.push(capped);
    this.stats.partials += 1;
    return capped;
  }

  /**
   * Finalise the interim into a committed turn. Returns the turn, or
   * null when there was no interim (or it was empty).
   */
  commit(input: { atMs: number; speakerId?: TranscriptV9Speaker }): TranscriptV9Turn | null {
    if (!this.interim) return null;
    const speakerId = input.speakerId ?? this.interim.speakerId;
    const text = this.interim.text.trim();
    const partials = [...this.interim.partials];
    const startedAtMs = this.interim.startedAtMs;
    this.interim = null;
    if (text.length === 0) return null;
    const turn: TranscriptV9Turn = {
      id: nextTurnId(),
      speakerId,
      text,
      startedAtMs,
      endedAtMs: input.atMs,
      partials,
      toolCalls: [...this.pendingToolCalls],
      final: true,
    };
    this.pendingToolCalls = [];
    this.appendTurn(turn);
    this.stats.commits += 1;
    return { ...turn, partials: [...turn.partials], toolCalls: [...turn.toolCalls] };
  }

  /** Record a turn directly from final text (no interim involved).
   * When an interim is live (speaker change), it is committed first
   * so no text — and no pending tool call — is lost. */
  noteFinal(text: string, input: { speakerId?: TranscriptV9Speaker; atMs: number; startedAtMs?: number }): TranscriptV9Turn {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Transcript v9 final text must be a non-empty string.');
    }
    if (this.interim) this.commit({ atMs: input.atMs });
    const turn: TranscriptV9Turn = {
      id: nextTurnId(),
      speakerId: input.speakerId ?? 'user',
      text: text.trim(),
      startedAtMs: input.startedAtMs ?? input.atMs,
      endedAtMs: input.atMs,
      partials: [text.trim()],
      toolCalls: [],
      final: true,
    };
    this.appendTurn(turn);
    return { ...turn, partials: [...turn.partials], toolCalls: [] };
  }

  /**
   * Attach a tool call to the live turn: the interim when one is
   * streaming (flushed into the turn on commit), otherwise the
   * latest committed turn. Returns false when there is no turn yet.
   */
  attachToolCall(call: TranscriptV9ToolCall): boolean {
    const entry = { ...call, args: { ...call.args } };
    if (this.interim) {
      this.pendingToolCalls.push(entry);
      this.stats.toolCalls += 1;
      return true;
    }
    const latest = this.turns[this.turns.length - 1];
    if (!latest) return false;
    latest.toolCalls.push(entry);
    this.stats.toolCalls += 1;
    return true;
  }

  /** Clear everything (new call on the same session object). */
  clear(): void {
    this.turns = [];
    this.interim = null;
    this.pendingToolCalls = [];
    this.stats = { turns: 0, partials: 0, commits: 0, toolCalls: 0, droppedTurns: 0, liveInterimChars: 0 };
  }

  private appendTurn(turn: TranscriptV9Turn): void {
    this.turns.push(turn);
    this.stats.turns += 1;
    while (this.turns.length > this.options.maxTurns) {
      this.turns.shift();
      this.stats.droppedTurns += 1;
    }
  }
}

/** What the transcript panel shows right now (committed + live interim). */
export function transcriptV9LiveText(stream: TranscriptStreamV9): string {
  const lines = stream.getTurns().map((t) => `${t.speakerId}: ${t.text}`);
  const interim = stream.getInterim();
  if (interim && interim.text.trim().length > 0) {
    lines.push(`${interim.speakerId}: ${interim.text} …`);
  }
  return lines.join('\n');
}

/** Transcript as Markdown (committed turns only). */
export function transcriptV9Markdown(stream: TranscriptStreamV9): string {
  const turns = stream.getTurns();
  if (turns.length === 0) return '_No transcript yet._';
  return turns
    .map((t) => {
      const tools = t.toolCalls.length > 0
        ? `\n  - tools: ${t.toolCalls.map((c) => `${c.name} (${c.ok ? 'ok' : 'error'})`).join(', ')}`
        : '';
      return `- **${t.speakerId}** (${t.startedAtMs}–${t.endedAtMs} ms): ${t.text}${tools}`;
    })
    .join('\n');
}

/** One-line summary of a transcript stream. */
export function transcriptV9Summary(stats: TranscriptV9Stats): string {
  return (
    `Transcript v9: ${stats.turns} turns, ${stats.partials} partials, ${stats.commits} commits, ` +
    `${stats.toolCalls} tool calls, ${stats.droppedTurns} dropped`
  );
}
