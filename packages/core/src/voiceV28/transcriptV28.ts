/**
 * Transcript + session summary v28 (v1.41, Team T5).
 *
 * Records every turn of a realtime voice session (user and
 * agent, with timestamps, interruption flags and the voice /
 * cast role that spoke) and summarises the session when it
 * ends — or on demand mid-session.
 *
 * The summary is extractive and deterministic (no model,
 * no network):
 *   - counts: turns, user/agent turns, interruptions,
 *     words per side, duration;
 *   - top phrases: most frequent content words (lowercased,
 *     stopwords removed, English + Vietnamese lists);
 *   - key sentences: the first sentence of each turn that
 *     carries content (trimmed, capped), so a reader can
 *     scan the session in seconds.
 *
 * Export: plain JSON (the whole record) and Markdown (a
 * human-readable session note with a header, a stats table
 * and the turns in order). Everything is plain data — the
 * host decides where it is stored.
 */

import {
  countWordsV28,
  splitSentencesV28,
  type VoiceV28CastRole,
  type VoiceV28SessionSummary,
  type VoiceV28TranscriptTurn,
  type VoiceV28TurnSpeaker,
} from './types';

/** English stopwords removed from top-phrase counts. */
export const VOICE_V28_STOPWORDS_EN = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
  'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'to',
  'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
  'again', 'further', 'once', 'here', 'there', 'all', 'any', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can',
  'will', 'just', 'should', 'now', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'she', 'it', 'its', 'they', 'them', 'their',
  'this', 'that', 'these', 'those', 'am', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does',
  'did', 'doing', 'would', 'could', 'shall', 'may', 'might', 'must',
  'of', 'as', 'isn', 'aren', 'wasn', 'weren', 'hasn', 'haven', 'hadn',
  'doesn', 'didn', 'won', 'wouldn', 'shan', 'shouldn', 'can', 'cannot',
  'couldn', 'mustn', 'let', 'll', 're', 've', 'd', 's', 't', 'm',
  'hello', 'hi', 'hey', 'thanks', 'thank', 'please', 'ok', 'okay',
  'yes', 'no', 'yeah',
]);

/** Vietnamese stopwords removed from top-phrase counts. */
export const VOICE_V28_STOPWORDS_VI = new Set([
  'là', 'của', 'và', 'hoặc', 'nhưng', 'nếu', 'thì', 'khi', 'ở', 'tại',
  'bởi', 'cho', 'với', 'về', 'trong', 'ngoài', 'trên', 'dưới', 'trước',
  'sau', 'để', 'đã', 'đang', 'sẽ', 'có', 'không', 'chưa', 'rất', 'quá',
  'lắm', 'này', 'kia', 'đó', 'đây', 'ấy', 'tôi', 'bạn', 'anh', 'chị',
  'em', 'mình', 'chúng', 'ta', 'họ', 'nó', 'các', 'những', 'một',
  'hai', 'mấy', 'gì', 'nào', 'sao', 'thế', 'nào', 'ạ', 'nhé', 'nha',
  'ừ', 'vâng', 'dạ', 'ơi', 'à', 'hả', 'chào', 'cảm', 'ơn', 'xin',
  'được', 'bị', 'do', 'từ', 'đến', 'qua', 'lên', 'xuống', 'ra', 'vào',
  'lại', 'cũng', 'chỉ', 'mà', 'nên', 'vì', 'tại', 'như', 'càng',
]);

export interface TranscriptRecorderV28Options {
  sessionId: string;
  botId?: string | null;
  /** Max turns kept (oldest dropped first). */
  maxTurns?: number;
  /** Max top phrases in a summary. */
  maxTopPhrases?: number;
  /** Max key sentences in a summary. */
  maxKeySentences?: number;
}

export interface VoiceV28TranscriptExport {
  version: 28;
  sessionId: string;
  botId: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  turns: VoiceV28TranscriptTurn[];
  summary: VoiceV28SessionSummary;
}

export function createTranscriptRecorderV28(
  opts: TranscriptRecorderV28Options,
): TranscriptRecorderV28 {
  return new TranscriptRecorderV28(opts);
}

export class TranscriptRecorderV28 {
  readonly sessionId: string;
  readonly botId: string | null;
  private readonly maxTurns: number;
  private readonly maxTopPhrases: number;
  private readonly maxKeySentences: number;
  private turns: VoiceV28TranscriptTurn[] = [];
  private turnCounter = 0;
  private startedAtMs: number | null = null;
  private endedAtMs: number | null = null;
  private interruptions = 0;
  private openTurnRecord: VoiceV28TranscriptTurn | null = null;

  constructor(opts: TranscriptRecorderV28Options) {
    if (!opts || !opts.sessionId) throw new Error('TranscriptRecorderV28 needs a sessionId');
    this.sessionId = opts.sessionId;
    this.botId = opts.botId ?? null;
    this.maxTurns = Math.max(1, opts.maxTurns ?? 500);
    this.maxTopPhrases = Math.max(1, opts.maxTopPhrases ?? 10);
    this.maxKeySentences = Math.max(1, opts.maxKeySentences ?? 20);
  }

  /** Open a turn (closes any turn still open first). */
  openTurn(
    speaker: VoiceV28TurnSpeaker,
    atMs: number,
    opts: { voiceId?: string | null; castRole?: VoiceV28CastRole | null } = {},
  ): VoiceV28TranscriptTurn {
    if (this.openTurnRecord) this.closeTurn(this.openTurnRecord.endedAtMs ?? atMs, false);
    if (this.startedAtMs === null) this.startedAtMs = atMs;
    this.turnCounter += 1;
    const turn: VoiceV28TranscriptTurn = {
      id: `turn28-${this.turnCounter}`,
      sessionId: this.sessionId,
      index: this.turnCounter - 1,
      speaker,
      text: '',
      startedAtMs: atMs,
      endedAtMs: null,
      durationMs: null,
      interrupted: false,
      voiceId: opts.voiceId ?? null,
      castRole: opts.castRole ?? null,
    };
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) this.turns.shift();
    this.openTurnRecord = turn;
    return turn;
  }

  /** Append text to the currently open turn (opens a user turn if none is open). */
  appendText(text: string, atMs: number, speaker?: VoiceV28TurnSpeaker): VoiceV28TranscriptTurn {
    if (!this.openTurnRecord) this.openTurn(speaker ?? 'user', atMs);
    const turn = this.openTurnRecord!;
    if (speaker !== undefined && speaker !== turn.speaker) {
      this.closeTurn(atMs, false);
      return this.appendText(text, atMs, speaker);
    }
    turn.text = turn.text ? `${turn.text} ${text}` : text;
    return turn;
  }

  /** Close the open turn (marks it interrupted when cut by a barge-in). */
  closeTurn(atMs: number, interrupted = false): VoiceV28TranscriptTurn | null {
    if (!this.openTurnRecord) return null;
    const turn = this.openTurnRecord;
    turn.endedAtMs = atMs;
    turn.durationMs = Math.max(0, atMs - turn.startedAtMs);
    turn.interrupted = interrupted;
    if (interrupted) this.interruptions += 1;
    this.openTurnRecord = null;
    return turn;
  }

  /** Record one finished turn in a single call (no open/close dance). */
  recordTurn(
    speaker: VoiceV28TurnSpeaker,
    text: string,
    startedAtMs: number,
    endedAtMs: number,
    opts: { interrupted?: boolean; voiceId?: string | null; castRole?: VoiceV28CastRole | null } = {},
  ): VoiceV28TranscriptTurn {
    if (this.startedAtMs === null) this.startedAtMs = startedAtMs;
    this.turnCounter += 1;
    const turn: VoiceV28TranscriptTurn = {
      id: `turn28-${this.turnCounter}`,
      sessionId: this.sessionId,
      index: this.turnCounter - 1,
      speaker,
      text,
      startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      interrupted: opts.interrupted ?? false,
      voiceId: opts.voiceId ?? null,
      castRole: opts.castRole ?? null,
    };
    if (turn.interrupted) this.interruptions += 1;
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) this.turns.shift();
    return turn;
  }

  /** Mark the session ended (stops the summary clock). */
  endSession(atMs: number): void {
    if (this.openTurnRecord) this.closeTurn(atMs, false);
    if (this.endedAtMs === null) this.endedAtMs = atMs;
  }

  get open(): VoiceV28TranscriptTurn | null {
    return this.openTurnRecord;
  }

  get turnCount(): number {
    return this.turns.length;
  }

  get interruptionCount(): number {
    return this.interruptions;
  }

  allTurns(): VoiceV28TranscriptTurn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  turnsBySpeaker(speaker: VoiceV28TurnSpeaker): VoiceV28TranscriptTurn[] {
    return this.turns.filter((t) => t.speaker === speaker).map((t) => ({ ...t }));
  }

  /** Full text of the session (one line per turn). */
  fullText(): string {
    return this.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
  }

  /** Build the extractive summary. */
  summarise(
    atMs: number,
    opts: { style?: string; voiceId?: string | null } = {},
  ): VoiceV28SessionSummary {
    const userTurns = this.turns.filter((t) => t.speaker === 'user');
    const agentTurns = this.turns.filter((t) => t.speaker === 'agent');
    const words = this.turns.reduce((n, t) => n + countWordsV28(t.text), 0);
    const userWords = userTurns.reduce((n, t) => n + countWordsV28(t.text), 0);
    const agentWords = agentTurns.reduce((n, t) => n + countWordsV28(t.text), 0);
    const endedAtMs = this.endedAtMs ?? null;
    const durationMs =
      this.startedAtMs !== null ? Math.max(0, (endedAtMs ?? atMs) - this.startedAtMs) : null;
    return {
      sessionId: this.sessionId,
      botId: this.botId,
      startedAtMs: this.startedAtMs,
      endedAtMs,
      durationMs,
      turns: this.turns.length,
      userTurns: userTurns.length,
      agentTurns: agentTurns.length,
      interruptions: this.interruptions,
      words,
      userWords,
      agentWords,
      topPhrases: topPhrasesV28(this.turns, this.maxTopPhrases),
      keySentences: keySentencesV28(this.turns, this.maxKeySentences),
      style: (opts.style as VoiceV28SessionSummary['style']) ?? 'default',
      voiceId: opts.voiceId ?? null,
    };
  }

  /** Export the whole record (turns + summary) as plain JSON data. */
  exportJson(atMs: number, opts: { style?: string; voiceId?: string | null } = {}): VoiceV28TranscriptExport {
    return {
      version: 28,
      sessionId: this.sessionId,
      botId: this.botId,
      startedAtMs: this.startedAtMs,
      endedAtMs: this.endedAtMs,
      turns: this.allTurns(),
      summary: this.summarise(atMs, opts),
    };
  }

  /** Export the session as a human-readable Markdown note. */
  exportMarkdown(atMs: number, opts: { style?: string; voiceId?: string | null } = {}): string {
    const summary = this.summarise(atMs, opts);
    const lines: string[] = [
      `# Voice session ${this.sessionId}`,
      '',
      `- Bot: ${this.botId ?? '-'}`,
      `- Started: ${summary.startedAtMs ?? '-'}ms`,
      `- Ended: ${summary.endedAtMs ?? '-'}ms`,
      `- Duration: ${summary.durationMs ?? '-'}ms`,
      `- Turns: ${summary.turns} (user ${summary.userTurns}, agent ${summary.agentTurns})`,
      `- Interruptions: ${summary.interruptions}`,
      `- Words: ${summary.words} (user ${summary.userWords}, agent ${summary.agentWords})`,
      `- Style: ${summary.style}`,
      `- Voice: ${summary.voiceId ?? '-'}`,
      '',
      '## Key sentences',
      '',
    ];
    if (summary.keySentences.length === 0) lines.push('_No content yet._', '');
    else for (const s of summary.keySentences) lines.push(`- ${s}`, '');
    lines.push('## Top phrases', '');
    if (summary.topPhrases.length === 0) lines.push('_No content yet._', '');
    else {
      for (const p of summary.topPhrases) lines.push(`- ${p.phrase} (${p.count})`);
      lines.push('');
    }
    lines.push('## Turns', '');
    if (this.turns.length === 0) lines.push('_No turns yet._');
    else {
      for (const t of this.turns) {
        const flag = t.interrupted ? ' [interrupted]' : '';
        lines.push(`### ${t.index + 1}. ${t.speaker}${flag}`, '', t.text || '_[empty]_', '');
      }
    }
    return lines.join('\n');
  }
}

/** Most frequent content words across turns (lowercased, stopwords removed). */
export function topPhrasesV28(
  turns: readonly VoiceV28TranscriptTurn[],
  maxPhrases = 10,
): { phrase: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    for (const raw of turn.text.split(/\s+/)) {
      const word = raw
        .toLowerCase()
        .replace(/^[.,!?;:"'()[\]{}]+|[.,!?;:"'()[\]{}]+$/g, '')
        .trim();
      if (word.length < 2) continue;
      if (VOICE_V28_STOPWORDS_EN.has(word)) continue;
      if (VOICE_V28_STOPWORDS_VI.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase))
    .slice(0, Math.max(1, maxPhrases));
}

/** First content sentence of each turn (trimmed, capped). */
export function keySentencesV28(
  turns: readonly VoiceV28TranscriptTurn[],
  maxSentences = 20,
): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    const sentences = splitSentencesV28(turn.text);
    const first = sentences.find((s) => s.length >= 3);
    if (first) out.push(first.slice(0, 200));
    if (out.length >= Math.max(1, maxSentences)) break;
  }
  return out;
}
