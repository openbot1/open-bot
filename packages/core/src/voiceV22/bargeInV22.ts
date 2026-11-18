/**
 * Barge-in engine v22 (voice v22, v1.35 Team T5).
 *
 * v21 decided ignore / duck / interrupt from one weighted score.
 * v22 keeps that score and adds what a durable session needs
 * around it:
 *
 *   - Two duck depths. `duck-soft` (a backchannel, a breath) only
 *     dips the TTS volume; `duck-hard` (a short real phrase)
 *     pauses the TTS and holds the reply, ready to resume. Only
 *     a sustained interruption cuts the reply outright.
 *   - Cooldown. After an interrupt the engine refuses another
 *     one for a short window, so a stutter or a double trigger
 *     cannot chop the conversation into fragments.
 *   - Resume queue. A cut reply is not thrown away: it enters
 *     a queue with a disposition — resume it later, drop it, or
 *     summarise it into one short sentence. The session picks
 *     the disposition from how much of the reply was already
 *     spoken and how long the user has been talking since.
 *   - Echo guard. Frames flagged as agent echo score zero no
 *     matter how loud; a burst that arrives while the agent is
 *     not speaking is not a barge-in at all.
 *   - Partial transcript keeper (v22). Like v21, but a cut
 *     also snapshots which turn the words belong to, so a
 *     resume after a crash can re-attach them to the right turn.
 *
 * Scoring stays a deterministic weighted sum with every weight
 * exposed, so the panel can show *why* a burst did or did not
 * interrupt.
 */
import {
  clampV22,
  round2V22,
  round4V22,
  type VoiceV22BargeInDecision,
  type VoiceV22EventSink,
  type VoiceV22ReplyCut,
  type VoiceV22ResumeDisposition,
} from './types';

export interface VoiceV22BargeInCandidate {
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

export interface VoiceV22BargeInScoreBreakdown {
  energyScore: number;
  sustainScore: number;
  wordsScore: number;
  confidenceScore: number;
  /** Echo penalty applied (1 when echo, 0 otherwise). */
  echoPenalty: number;
  total: number;
}

export interface VoiceV22BargeInOptions {
  /** Score at or above this interrupts (default 0.65). */
  interruptThreshold: number;
  /** Score at or above this duck-hard (default 0.5). */
  duckHardThreshold: number;
  /** Score at or above this duck-soft (default 0.35). */
  duckSoftThreshold: number;
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
  /** Ms after an interrupt during which a new interrupt is refused (default 1500). */
  interruptCooldownMs: number;
  /** Max queued cut replies (default 5). */
  maxQueuedReplies: number;
  /** Spoken fraction above which a cut reply is dropped, not resumed (default 0.8). */
  dropSpokenFraction: number;
  /** Remaining chars below which a cut reply is resumed verbatim (default 40). */
  resumeShortRemainingChars: number;
}

export function defaultBargeInV22Options(): VoiceV22BargeInOptions {
  return {
    interruptThreshold: 0.65,
    duckHardThreshold: 0.5,
    duckSoftThreshold: 0.35,
    energyWeight: 0.35,
    sustainWeight: 0.3,
    wordsWeight: 0.2,
    confidenceWeight: 0.15,
    fullSustainMs: 600,
    fullWordCount: 4,
    interruptCooldownMs: 1500,
    maxQueuedReplies: 5,
    dropSpokenFraction: 0.8,
    resumeShortRemainingChars: 40,
  };
}

export function validateBargeInV22Options(o: Partial<VoiceV22BargeInOptions>): string[] {
  const e: string[] = [];
  for (const k of ['interruptThreshold', 'duckHardThreshold', 'duckSoftThreshold'] as const) {
    if (o[k] !== undefined && (o[k]! < 0 || o[k]! > 1)) e.push(`${k} must be 0..1`);
  }
  if (o.interruptThreshold !== undefined && o.duckHardThreshold !== undefined && o.duckHardThreshold >= o.interruptThreshold) {
    e.push('duckHardThreshold must be below interruptThreshold');
  }
  if (o.duckHardThreshold !== undefined && o.duckSoftThreshold !== undefined && o.duckSoftThreshold >= o.duckHardThreshold) {
    e.push('duckSoftThreshold must be below duckHardThreshold');
  }
  for (const k of ['energyWeight', 'sustainWeight', 'wordsWeight', 'confidenceWeight'] as const) {
    if (o[k] !== undefined && (o[k]! < 0 || o[k]! > 1)) e.push(`${k} must be 0..1`);
  }
  if (o.fullSustainMs !== undefined && o.fullSustainMs <= 0) e.push('fullSustainMs must be positive');
  if (o.fullWordCount !== undefined && (!Number.isInteger(o.fullWordCount) || o.fullWordCount < 1)) {
    e.push('fullWordCount must be a positive integer');
  }
  if (o.interruptCooldownMs !== undefined && (o.interruptCooldownMs < 0 || o.interruptCooldownMs > 10_000)) {
    e.push('interruptCooldownMs must be 0..10000');
  }
  if (o.maxQueuedReplies !== undefined && (!Number.isInteger(o.maxQueuedReplies) || o.maxQueuedReplies < 1)) {
    e.push('maxQueuedReplies must be a positive integer');
  }
  if (o.dropSpokenFraction !== undefined && (o.dropSpokenFraction < 0 || o.dropSpokenFraction > 1)) {
    e.push('dropSpokenFraction must be 0..1');
  }
  if (o.resumeShortRemainingChars !== undefined && (o.resumeShortRemainingChars < 0 || o.resumeShortRemainingChars > 1000)) {
    e.push('resumeShortRemainingChars must be 0..1000');
  }
  return e;
}

/** Backchannel words — real speech, but not an interruption. */
export const VOICE_V22_BACKCHANNEL_WORDS = [
  'ừ', 'ừm', 'ờ', 'à', 'uh', 'um', 'yeah', 'yep', 'mm', 'mm-hm', 'mhm', 'ok', 'okay', 'rồi', 'vâng',
] as const;

/** True when every word in the burst is a backchannel word. */
export function isBackchannelBurstV22(words: string[]): boolean {
  if (words.length === 0) return false;
  const set = new Set<string>(VOICE_V22_BACKCHANNEL_WORDS);
  return words.every((w) => set.has(w.toLowerCase()));
}

/** Score one barge-in candidate (0..1), with the breakdown. */
export function scoreBargeInV22(
  candidate: VoiceV22BargeInCandidate,
  opts: Partial<VoiceV22BargeInOptions> = {},
): VoiceV22BargeInScoreBreakdown {
  const o = { ...defaultBargeInV22Options(), ...opts };
  if (candidate.echo === true || !candidate.agentSpeaking) {
    return { energyScore: 0, sustainScore: 0, wordsScore: 0, confidenceScore: 0, echoPenalty: candidate.echo === true ? 1 : 0, total: 0 };
  }
  const energyScore = clampV22(candidate.energy, 0, 1);
  const sustainScore = clampV22(candidate.sustainMs / o.fullSustainMs, 0, 1);
  const realWords = candidate.words.filter((w) => !isBackchannelBurstV22([w]));
  const wordsScore = clampV22(realWords.length / o.fullWordCount, 0, 1);
  const confidenceScore = clampV22(candidate.confidence ?? 0.8, 0, 1);
  // A pure backchannel burst caps the word score at a whisper.
  const cappedWords = isBackchannelBurstV22(candidate.words) ? Math.min(wordsScore, 0.15) : wordsScore;
  const total = round4V22(
    o.energyWeight * energyScore
    + o.sustainWeight * sustainScore
    + o.wordsWeight * cappedWords
    + o.confidenceWeight * confidenceScore,
  );
  return { energyScore, sustainScore, wordsScore: cappedWords, confidenceScore, echoPenalty: 0, total };
}

/** Decide from a score: ignore / duck-soft / duck-hard / interrupt. */
export function decideBargeInV22(
  score: VoiceV22BargeInScoreBreakdown,
  opts: Partial<VoiceV22BargeInOptions> = {},
): VoiceV22BargeInDecision {
  const o = { ...defaultBargeInV22Options(), ...opts };
  if (score.total >= o.interruptThreshold) return 'interrupt';
  if (score.total >= o.duckHardThreshold) return 'duck-hard';
  if (score.total >= o.duckSoftThreshold) return 'duck-soft';
  return 'ignore';
}

/**
 * Cut an agent reply at the spoken character count, on a word
 * boundary, so the spoken part never ends mid-word and the
 * remaining part starts cleanly. The disposition is derived
 * from how much was already spoken: almost-done replies are
 * dropped, short remainders resume verbatim, the rest are
 * summarised into one short sentence by the session.
 */
export function splitReplyAtCutV22(
  replyText: string,
  spokenChars: number,
  opts: Partial<VoiceV22BargeInOptions> = {},
): VoiceV22ReplyCut {
  const o = { ...defaultBargeInV22Options(), ...opts };
  const clamped = clampV22(spokenChars, 0, replyText.length);
  if (clamped <= 0) {
    return { spoken: '', remaining: replyText, spokenChars: 0, remainingChars: replyText.length, disposition: 'resume' };
  }
  if (clamped >= replyText.length) {
    return { spoken: replyText, remaining: '', spokenChars: replyText.length, remainingChars: 0, disposition: 'drop' };
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
  const spokenFraction = replyText.length === 0 ? 0 : spoken.length / replyText.length;
  const disposition: VoiceV22ResumeDisposition = spokenFraction >= o.dropSpokenFraction
    ? 'drop'
    : remaining.length <= o.resumeShortRemainingChars
      ? 'resume'
      : 'summarise';
  return { spoken, remaining, spokenChars: spoken.length, remainingChars: remaining.length, disposition };
}

/** One queued cut reply, waiting for the floor to come back. */
export interface VoiceV22QueuedReply {
  id: string;
  turnId: string;
  cut: VoiceV22ReplyCut;
  queuedAtMs: number;
  /** Words the user has said since the cut (for summarise). */
  userWordsSinceCut: string[];
}

export interface VoiceV22PartialTranscript {
  turnId: string;
  text: string;
  atMs: number;
  finalised: boolean;
}

/**
 * Keeps partial STT segments for the turn in progress. A barge-in
 * mid-utterance must not lose the words already heard: they stay
 * here as unfinalised text until the STT confirms them. The v22
 * keeper also snapshots the turn id with each segment so a
 * resume after a crash can re-attach the words to the right turn.
 */
export class PartialTranscriptKeeperV22 {
  private segments: VoiceV22PartialTranscript[] = [];

  add(turnId: string, text: string, atMs: number): void {
    const existing = this.segments.find((s) => s.turnId === turnId && !s.finalised);
    if (existing !== undefined) {
      existing.text = text;
      existing.atMs = atMs;
    } else {
      this.segments.push({ turnId, text, atMs, finalised: false });
    }
  }

  finalise(turnId: string, text: string, atMs: number): VoiceV22PartialTranscript | null {
    const existing = this.segments.find((s) => s.turnId === turnId);
    if (existing === undefined) {
      const seg: VoiceV22PartialTranscript = { turnId, text, atMs, finalised: true };
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
  unfinalised(): VoiceV22PartialTranscript[] {
    return this.segments.filter((s) => !s.finalised).map((s) => ({ ...s }));
  }

  /** All segments, for checkpointing. */
  all(): VoiceV22PartialTranscript[] {
    return this.segments.map((s) => ({ ...s }));
  }

  clearTurn(turnId: string): void {
    this.segments = this.segments.filter((s) => s.turnId !== turnId);
  }

  clear(): void {
    this.segments = [];
  }
}

export interface VoiceV22BargeInRecord {
  atMs: number;
  decision: VoiceV22BargeInDecision;
  score: VoiceV22BargeInScoreBreakdown;
  words: string[];
  /** True when the decision was downgraded by the cooldown. */
  cooledDown?: boolean;
  /** Reply cut, when the decision was interrupt. */
  cut?: VoiceV22ReplyCut;
  /** Partial transcript preserved at the cut. */
  preservedTranscript?: string;
}

export interface VoiceV22BargeInStats {
  observed: number;
  ignored: number;
  duckedSoft: number;
  duckedHard: number;
  interrupted: number;
  cooledDown: number;
  queuedReplies: number;
  /** Mean score of interrupting bursts. */
  meanInterruptScore: number;
}

export class BargeInEngineV22 {
  private readonly opts: VoiceV22BargeInOptions;
  private readonly sink?: VoiceV22EventSink;
  private readonly sessionId: string;
  private readonly records: VoiceV22BargeInRecord[] = [];
  private readonly queue: VoiceV22QueuedReply[] = [];
  private lastInterruptAtMs: number | null = null;
  private queueCounter = 0;
  readonly keeper = new PartialTranscriptKeeperV22();

  constructor(sessionId: string, opts: Partial<VoiceV22BargeInOptions> = {}, sink?: VoiceV22EventSink) {
    this.sessionId = sessionId;
    this.opts = { ...defaultBargeInV22Options(), ...opts };
    this.sink = sink;
  }

  /** True when a new interrupt would be refused by the cooldown. */
  inCooldown(atMs: number): boolean {
    return this.lastInterruptAtMs !== null && atMs - this.lastInterruptAtMs < this.opts.interruptCooldownMs;
  }

  /** Ms left on the cooldown (0 when free). */
  cooldownRemainingMs(atMs: number): number {
    if (this.lastInterruptAtMs === null) return 0;
    return Math.max(0, this.opts.interruptCooldownMs - (atMs - this.lastInterruptAtMs));
  }

  /**
   * Observe one burst while the agent speaks. Returns the
   * decision; when it is `interrupt` the caller stops the TTS
   * and passes the reply text to `cutReply`. A would-be
   * interrupt inside the cooldown is downgraded to duck-hard
   * and recorded as cooled down — the user is heard, but the
   * reply is not chopped a second time in a row.
   */
  observe(candidate: VoiceV22BargeInCandidate): { decision: VoiceV22BargeInDecision; score: VoiceV22BargeInScoreBreakdown; cooledDown: boolean } {
    const score = scoreBargeInV22(candidate, this.opts);
    let decision = decideBargeInV22(score, this.opts);
    let cooledDown = false;
    if (decision === 'interrupt' && this.inCooldown(candidate.atMs)) {
      decision = 'duck-hard';
      cooledDown = true;
    }
    if (decision === 'interrupt') this.lastInterruptAtMs = candidate.atMs;
    const record: VoiceV22BargeInRecord = {
      atMs: candidate.atMs,
      decision,
      score,
      words: [...candidate.words],
      ...(cooledDown ? { cooledDown: true } : {}),
    };
    this.records.push(record);
    this.sink?.({
      kind: decision === 'interrupt' ? 'barge-in' : decision === 'ignore' ? 'barge-in' : 'duck',
      atMs: candidate.atMs,
      sessionId: this.sessionId,
      detail: { decision, score: score.total, words: candidate.words.join(' '), cooledDown },
    });
    return { decision, score, cooledDown };
  }

  /** Cut the agent reply at the spoken point; queues the remainder. */
  cutReply(replyText: string, spokenChars: number, atMs: number, turnId: string): VoiceV22ReplyCut {
    const cut = splitReplyAtCutV22(replyText, spokenChars, this.opts);
    const last = this.records[this.records.length - 1];
    if (last !== undefined && last.decision === 'interrupt') {
      last.cut = cut;
      last.preservedTranscript = this.keeper.heardSoFar(turnId);
    }
    if (cut.remaining !== '') {
      this.queue.push({
        id: `v22-queued-${++this.queueCounter}`,
        turnId,
        cut: { ...cut },
        queuedAtMs: atMs,
        userWordsSinceCut: [],
      });
      while (this.queue.length > this.opts.maxQueuedReplies) this.queue.shift();
    }
    return cut;
  }

  /** Record user words spoken after a cut (feeds the summarise disposition). */
  noteUserWords(words: string[]): void {
    for (const q of this.queue) q.userWordsSinceCut.push(...words);
  }

  /** Queued cut replies, oldest first. */
  queuedReplies(): VoiceV22QueuedReply[] {
    return this.queue.map((q) => ({ ...q, cut: { ...q.cut }, userWordsSinceCut: [...q.userWordsSinceCut] }));
  }

  /** Take the oldest queued reply (the session speaks it when the floor returns). */
  takeQueued(): VoiceV22QueuedReply | null {
    const next = this.queue.shift();
    return next === undefined ? null : { ...next, cut: { ...next.cut }, userWordsSinceCut: [...next.userWordsSinceCut] };
  }

  /** Drop a queued reply by id (the user moved on). */
  dropQueued(id: string): boolean {
    const idx = this.queue.findIndex((q) => q.id === id);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  /** One-sentence summary of a cut reply's remainder, for the summarise disposition. */
  summariseCut(cut: VoiceV22ReplyCut): string {
    if (cut.remaining === '') return '';
    const firstSentence = cut.remaining.split(/(?<=[.!?])\s/)[0] ?? cut.remaining;
    return firstSentence.length <= 120 ? firstSentence : `${firstSentence.slice(0, 117).trimEnd()}…`;
  }

  history(): VoiceV22BargeInRecord[] {
    return this.records.map((r) => ({ ...r, score: { ...r.score }, words: [...r.words], ...(r.cut !== undefined ? { cut: { ...r.cut } } : {}) }));
  }

  stats(): VoiceV22BargeInStats {
    const interrupted = this.records.filter((r) => r.decision === 'interrupt');
    return {
      observed: this.records.length,
      ignored: this.records.filter((r) => r.decision === 'ignore').length,
      duckedSoft: this.records.filter((r) => r.decision === 'duck-soft').length,
      duckedHard: this.records.filter((r) => r.decision === 'duck-hard').length,
      interrupted: interrupted.length,
      cooledDown: this.records.filter((r) => r.cooledDown === true).length,
      queuedReplies: this.queue.length,
      meanInterruptScore: interrupted.length === 0
        ? 0
        : round4V22(interrupted.reduce((s, r) => s + r.score.total, 0) / interrupted.length),
    };
  }

  summary(): string {
    const s = this.stats();
    return `barge-in v22: ${s.observed} bursts, ${s.interrupted} interrupts, ` +
      `${s.duckedHard} hard ducks, ${s.duckedSoft} soft ducks, ${s.ignored} ignored, ` +
      `${s.cooledDown} cooled down, ${s.queuedReplies} replies queued`;
  }
}

export function createBargeInEngineV22(
  sessionId: string,
  opts: Partial<VoiceV22BargeInOptions> = {},
  sink?: VoiceV22EventSink,
): BargeInEngineV22 {
  return new BargeInEngineV22(sessionId, opts, sink);
}

/** Convenience: score + decide in one call, for the tools layer. */
export function evaluateBargeInBurstV22(
  candidate: VoiceV22BargeInCandidate,
  opts: Partial<VoiceV22BargeInOptions> = {},
): { decision: VoiceV22BargeInDecision; score: VoiceV22BargeInScoreBreakdown } {
  const score = scoreBargeInV22(candidate, opts);
  return { decision: decideBargeInV22(score, opts), score };
}

/** Count real (non-backchannel) words in a burst. */
export function realWordsInBurstV22(words: string[]): number {
  return words.filter((w) => !isBackchannelBurstV22([w])).length;
}
