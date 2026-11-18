/**
 * Barge-in engine v21 (voice v21, v1.34 Team T5).
 *
 * The user interrupts while the agent is speaking. The engine
 * decides, from a burst of user audio, whether the agent should
 * keep talking, duck (keep talking quieter) or stop outright:
 *
 *   - ignore: too quiet, too short, or agent echo — the mic heard
 *     the speaker, not the user. Echo-flagged frames score zero.
 *   - duck: a real voice, but short or low-energy — probably a
 *     backchannel ("ừ", "yeah", "mm-hm"). The agent keeps its
 *     sentence, quieter, and the overlap is logged.
 *   - interrupt: sustained, energetic speech with real words.
 *     The TTS stops at once, the reply is cut at the spoken
 *     character, and the session flips back to listening.
 *
 * Two things must survive an interruption, and both live here:
 *
 *   - The cut reply. `splitReplyAtCut` divides the agent text
 *     into what was already spoken and what remains, on a word
 *     boundary, so a later resume can pick up mid-sentence
 *     instead of restarting or losing the rest.
 *   - The half-heard transcript. The user started talking while
 *     the agent was speaking, so the first words may only exist
 *     as partial STT segments. The partial-transcript keeper
 *     holds them until they finalise — a barge-in never throws
 *     away words the user already said.
 *
 * Scoring is a weighted sum, fully deterministic, with every
 * weight exposed in the options so the panel can show *why* a
 * burst did or did not interrupt.
 */
import {
  clampV21,
  round2V21,
  round4V21,
  type VoiceV21EventSink,
} from './types';

export type VoiceV21BargeInDecision = 'ignore' | 'duck' | 'interrupt';

export interface VoiceV21BargeInCandidate {
  atMs: number;
  /** 0..1 speech energy of the burst. */
  energy: number;
  /** How long the burst has been sustained, ms. */
  sustainMs: number;
  /** Words recognised so far in this burst (may be partial). */
  words: string[];
  /** True when the burst is known agent echo, not user speech. */
  echo?: boolean;
  /** 0..1 STT confidence of the burst words (default 0.8). */
  confidence?: number;
  /** Is the agent currently speaking (TTS active)? */
  agentSpeaking: boolean;
}

export interface VoiceV21BargeInScoreBreakdown {
  energyScore: number;
  sustainScore: number;
  wordsScore: number;
  confidenceScore: number;
  /** Echo penalty applied (1 when echo, 0 otherwise). */
  echoPenalty: number;
  total: number;
}

export interface VoiceV21BargeInOptions {
  /** Score at or above this interrupts (default 0.65). */
  interruptThreshold: number;
  /** Score at or above this ducks (default 0.35). */
  duckThreshold: number;
  /** Energy weight (default 0.35). */
  energyWeight: number;
  /** Sustain weight (default 0.3). */
  sustainWeight: number;
  /** Words weight (default 0.2). */
  wordsWeight: number;
  /** Confidence weight (default 0.15). */
  confidenceWeight: number;
  /** Sustain ms that counts as full (default 600). */
  fullSustainMs: number;
  /** Word count that counts as full (default 4). */
  fullWordCount: number;
}

export function defaultBargeInV21Options(): VoiceV21BargeInOptions {
  return {
    interruptThreshold: 0.65,
    duckThreshold: 0.35,
    energyWeight: 0.35,
    sustainWeight: 0.3,
    wordsWeight: 0.2,
    confidenceWeight: 0.15,
    fullSustainMs: 600,
    fullWordCount: 4,
  };
}

export function validateBargeInV21Options(o: Partial<VoiceV21BargeInOptions>): string[] {
  const e: string[] = [];
  if (o.interruptThreshold !== undefined && (o.interruptThreshold < 0 || o.interruptThreshold > 1)) {
    e.push('interruptThreshold must be 0..1');
  }
  if (o.duckThreshold !== undefined && (o.duckThreshold < 0 || o.duckThreshold > 1)) {
    e.push('duckThreshold must be 0..1');
  }
  if (o.interruptThreshold !== undefined && o.duckThreshold !== undefined && o.duckThreshold >= o.interruptThreshold) {
    e.push('duckThreshold must be below interruptThreshold');
  }
  for (const k of ['energyWeight', 'sustainWeight', 'wordsWeight', 'confidenceWeight'] as const) {
    if (o[k] !== undefined && (o[k]! < 0 || o[k]! > 1)) e.push(`${k} must be 0..1`);
  }
  if (o.fullSustainMs !== undefined && o.fullSustainMs <= 0) e.push('fullSustainMs must be positive');
  if (o.fullWordCount !== undefined && (!Number.isInteger(o.fullWordCount) || o.fullWordCount < 1)) {
    e.push('fullWordCount must be a positive integer');
  }
  return e;
}

/** Backchannel words — real speech, but not an interruption. */
export const VOICE_V21_BACKCHANNEL_WORDS = [
  'ừ', 'ừm', 'ờ', 'à', 'uh', 'um', 'yeah', 'yep', 'mm', 'mm-hm', 'mhm', 'ok', 'okay',
] as const;

/** True when every word in the burst is a backchannel word. */
export function isBackchannelBurstV21(words: string[]): boolean {
  if (words.length === 0) return false;
  const set = new Set<string>(VOICE_V21_BACKCHANNEL_WORDS);
  return words.every((w) => set.has(w.toLowerCase()));
}

/** Score one barge-in candidate (0..1), with the breakdown. */
export function scoreBargeInV21(
  candidate: VoiceV21BargeInCandidate,
  opts: Partial<VoiceV21BargeInOptions> = {},
): VoiceV21BargeInScoreBreakdown {
  const o = { ...defaultBargeInV21Options(), ...opts };
  if (candidate.echo === true || !candidate.agentSpeaking) {
    return { energyScore: 0, sustainScore: 0, wordsScore: 0, confidenceScore: 0, echoPenalty: candidate.echo === true ? 1 : 0, total: 0 };
  }
  const energyScore = clampV21(candidate.energy, 0, 1);
  const sustainScore = clampV21(candidate.sustainMs / o.fullSustainMs, 0, 1);
  const realWords = candidate.words.filter((w) => !isBackchannelBurstV21([w]));
  const wordsScore = clampV21(realWords.length / o.fullWordCount, 0, 1);
  const confidenceScore = clampV21(candidate.confidence ?? 0.8, 0, 1);
  // A pure backchannel burst caps the word score at a whisper.
  const cappedWords = isBackchannelBurstV21(candidate.words) ? Math.min(wordsScore, 0.15) : wordsScore;
  const rawTotal = round4V21(
    o.energyWeight * energyScore
    + o.sustainWeight * sustainScore
    + o.wordsWeight * cappedWords
    + o.confidenceWeight * confidenceScore,
  );
  // A pure backchannel burst ("ừ", "yeah") can duck at most — it never
  // interrupts, no matter how loud or sustained it is: energy + sustain +
  // confidence alone can clear the interrupt threshold, so cap the total
  // at the duck threshold.
  const total = isBackchannelBurstV21(candidate.words) ? Math.min(rawTotal, o.duckThreshold) : rawTotal;
  return { energyScore, sustainScore, wordsScore: cappedWords, confidenceScore, echoPenalty: 0, total };
}

/** Decide from a score: ignore / duck / interrupt. */
export function decideBargeInV21(
  score: VoiceV21BargeInScoreBreakdown,
  opts: Partial<VoiceV21BargeInOptions> = {},
): VoiceV21BargeInDecision {
  const o = { ...defaultBargeInV21Options(), ...opts };
  if (score.total >= o.interruptThreshold) return 'interrupt';
  if (score.total >= o.duckThreshold) return 'duck';
  return 'ignore';
}

export interface VoiceV21ReplyCut {
  /** Text already spoken (word-boundary cut). */
  spoken: string;
  /** Text not yet spoken. */
  remaining: string;
  /** Characters spoken. */
  spokenChars: number;
  /** Characters remaining. */
  remainingChars: number;
}

/**
 * Cut an agent reply at the spoken character count, on a word
 * boundary, so the spoken part never ends mid-word and the
 * remaining part starts cleanly.
 */
export function splitReplyAtCutV21(replyText: string, spokenChars: number): VoiceV21ReplyCut {
  const clamped = clampV21(spokenChars, 0, replyText.length);
  if (clamped <= 0) {
    return { spoken: '', remaining: replyText, spokenChars: 0, remainingChars: replyText.length };
  }
  if (clamped >= replyText.length) {
    return { spoken: replyText, remaining: '', spokenChars: replyText.length, remainingChars: 0 };
  }
  // Walk back to the previous space so we never cut a word in half;
  // if the cut is inside the first word, walk forward instead.
  let cut = clamped;
  while (cut > 0 && replyText[cut] !== ' ' && replyText[cut - 1] !== ' ') cut -= 1;
  if (cut === 0) {
    cut = clamped;
    while (cut < replyText.length && replyText[cut] !== ' ') cut += 1;
  }
  const spoken = replyText.slice(0, cut).trimEnd();
  const remaining = replyText.slice(cut).trimStart();
  return { spoken, remaining, spokenChars: spoken.length, remainingChars: remaining.length };
}

export interface VoiceV21PartialTranscript {
  turnId: string;
  text: string;
  atMs: number;
  finalised: boolean;
}

/**
 * Keeps partial STT segments for the turn in progress. A barge-in
 * mid-utterance must not lose the words already heard: they stay
 * here as unfinalised text until the STT confirms them.
 */
export class PartialTranscriptKeeperV21 {
  private segments: VoiceV21PartialTranscript[] = [];

  add(turnId: string, text: string, atMs: number): void {
    const existing = this.segments.find((s) => s.turnId === turnId && !s.finalised);
    if (existing !== undefined) {
      existing.text = text;
      existing.atMs = atMs;
    } else {
      this.segments.push({ turnId, text, atMs, finalised: false });
    }
  }

  finalise(turnId: string, text: string, atMs: number): VoiceV21PartialTranscript | null {
    const existing = this.segments.find((s) => s.turnId === turnId);
    if (existing === undefined) {
      const seg: VoiceV21PartialTranscript = { turnId, text, atMs, finalised: true };
      this.segments.push(seg);
      return seg;
    }
    existing.text = text;
    existing.atMs = atMs;
    existing.finalised = true;
    return existing;
  }

  /** Text heard so far for a turn, finalised or not. */
  heardSoFar(turnId: string): string {
    return this.segments.find((s) => s.turnId === turnId)?.text ?? '';
  }

  /** Unfinalised segments — the words a barge-in must preserve. */
  unfinalised(): VoiceV21PartialTranscript[] {
    return this.segments.filter((s) => !s.finalised).map((s) => ({ ...s }));
  }

  clearTurn(turnId: string): void {
    this.segments = this.segments.filter((s) => s.turnId !== turnId);
  }

  clear(): void {
    this.segments = [];
  }
}

export interface VoiceV21BargeInRecord {
  atMs: number;
  decision: VoiceV21BargeInDecision;
  score: VoiceV21BargeInScoreBreakdown;
  words: string[];
  /** Reply cut, when the decision was interrupt. */
  cut?: VoiceV21ReplyCut;
  /** Partial transcript preserved at the cut. */
  preservedTranscript?: string;
}

export interface VoiceV21BargeInStats {
  observed: number;
  ignored: number;
  ducked: number;
  interrupted: number;
  /** Mean score of interrupting bursts. */
  meanInterruptScore: number;
}

export class BargeInEngineV21 {
  private readonly opts: VoiceV21BargeInOptions;
  private readonly sink?: VoiceV21EventSink;
  private readonly sessionId: string;
  private readonly records: VoiceV21BargeInRecord[] = [];
  readonly keeper = new PartialTranscriptKeeperV21();

  constructor(sessionId: string, opts: Partial<VoiceV21BargeInOptions> = {}, sink?: VoiceV21EventSink) {
    this.sessionId = sessionId;
    this.opts = { ...defaultBargeInV21Options(), ...opts };
    this.sink = sink;
  }

  /**
   * Observe one burst while the agent speaks. Returns the
   * decision; when it is `interrupt` the caller stops the TTS
   * and passes the reply text to `cutReply`.
   */
  observe(candidate: VoiceV21BargeInCandidate): { decision: VoiceV21BargeInDecision; score: VoiceV21BargeInScoreBreakdown } {
    const score = scoreBargeInV21(candidate, this.opts);
    const decision = decideBargeInV21(score, this.opts);
    const record: VoiceV21BargeInRecord = {
      atMs: candidate.atMs,
      decision,
      score,
      words: [...candidate.words],
    };
    this.records.push(record);
    this.sink?.({
      kind: 'barge-in',
      atMs: candidate.atMs,
      sessionId: this.sessionId,
      detail: { decision, score: score.total, words: candidate.words.join(' ') },
    });
    return { decision, score };
  }

  /** Cut the agent reply at the spoken point; preserves the partial transcript. */
  cutReply(replyText: string, spokenChars: number, atMs: number, turnId: string): VoiceV21ReplyCut {
    const cut = splitReplyAtCutV21(replyText, spokenChars);
    const last = this.records[this.records.length - 1];
    if (last !== undefined && last.decision === 'interrupt') {
      last.cut = cut;
      last.preservedTranscript = this.keeper.heardSoFar(turnId);
    }
    return cut;
  }

  history(): VoiceV21BargeInRecord[] {
    return this.records.map((r) => ({ ...r, score: { ...r.score }, words: [...r.words] }));
  }

  stats(): VoiceV21BargeInStats {
    const interrupted = this.records.filter((r) => r.decision === 'interrupt');
    return {
      observed: this.records.length,
      ignored: this.records.filter((r) => r.decision === 'ignore').length,
      ducked: this.records.filter((r) => r.decision === 'duck').length,
      interrupted: interrupted.length,
      meanInterruptScore: interrupted.length === 0
        ? 0
        : round4V21(interrupted.reduce((s, r) => s + r.score.total, 0) / interrupted.length),
    };
  }

  summary(): string {
    const s = this.stats();
    return `barge-in: ${s.observed} bursts, ${s.interrupted} interrupts, ${s.ducked} ducks, ` +
      `${s.ignored} ignored, mean interrupt score ${round2V21(s.meanInterruptScore)}`;
  }
}

export function createBargeInEngineV21(
  sessionId: string,
  opts: Partial<VoiceV21BargeInOptions> = {},
  sink?: VoiceV21EventSink,
): BargeInEngineV21 {
  return new BargeInEngineV21(sessionId, opts, sink);
}

/** Convenience: score + decide in one call, for the tools layer. */
export function evaluateBargeInBurstV21(
  candidate: VoiceV21BargeInCandidate,
  opts: Partial<VoiceV21BargeInOptions> = {},
): { decision: VoiceV21BargeInDecision; score: VoiceV21BargeInScoreBreakdown } {
  const score = scoreBargeInV21(candidate, opts);
  return { decision: decideBargeInV21(score, opts), score };
}

/** Count real (non-backchannel) words in a burst. */
export function realWordsInBurstV21(words: string[]): number {
  return words.filter((w) => !isBackchannelBurstV21([w])).length;
}
