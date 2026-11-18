/**
 * Open-turn v20 (voice v20, v1.29 Team T5).
 *
 * The pipeline v20 turns on VAD speech-end + a fixed silence
 * delay — but real conversation is messier than that. People
 * pause mid-sentence to think, say "ừm" while they search for a
 * word, talk over the agent to correct it, and cut the agent off
 * mid-sentence expecting it to pick up the *rest* of the sentence
 * later. This module is the open-turn layer that handles those
 * cases, on top of barge-in v7 and the pipeline:
 *
 *   1. Silence classification. A gap after speech is not always
 *      the end of a turn: `thinking-pause` (short gap after a
 *      filler word or a conjunction, or mid-sentence with no
 *      terminal punctuation), `trailing-silence` (gap after a
 *      complete sentence — the turn really ended), and
 *      `listening-pause` (long gap while the user waits for the
 *      agent — the agent should nudge, not cut). The classifier
 *      reads gap length + the text so far, in Vietnamese and
 *      English, so "Tôi muốn đặt… ừm…" holds the turn while
 *      "Tôi muốn đặt vé. …" ends it.
 *   2. Barge-in scoring v8. Barge-in v7 scored a candidate from
 *      energy + sustain + transcript evidence; v8 adds the
 *      speaker-change hint (a new voice mid-reply is likelier a
 *      real interruption), a stronger echo discount inside the
 *      echo window after each TTS chunk starts, and a
 *      `backchannel` outcome — short, quiet bursts ("ừ", "ok",
 *      "yeah") while the agent speaks are acknowledged, not cut.
 *   3. Sentence interruption. When a cut lands mid-sentence,
 *      the reply is split at a word boundary into spoken prefix
 *      and remaining text, the cut word fragment is dropped (the
 *      listener never heard it whole), and the remaining text
 *      keeps its prosody plan — the pitch contour continues
 *      from where it was cut instead of restarting flat.
 *   4. Overlap arbitration. When both sides speak at once the
 *      arbitrator decides who keeps the floor: a confident user
 *      turn takes it from a low-priority agent chunk, a
 *      backchannel never does, and an agent mid-question holds
 *      it briefly so the question is not lost.
 *
 * Pure scoring + state, virtual clock, mock audio only. The
 * engine keeps the decision log so the eval harness can replay
 * every cut and check it against the labelled truth.
 */

import { pcm16RmsV20, type VoiceV20Frame } from './types';
import type { TtsV20Chunk, TtsV20ProsodyPlan } from './ttsProsodyV20';

export type SilenceV20Kind = 'thinking-pause' | 'trailing-silence' | 'listening-pause';

export interface SilenceV20Decision {
  kind: SilenceV20Kind;
  /** True when the turn should end now. */
  endTurn: boolean;
  /** True when the agent should nudge ("Bạn còn đó không?"). */
  nudge: boolean;
  confidence: number;
  reason: string;
}

export interface SilenceV20Options {
  /** Gap (ms) below which a pause is never a turn end. */
  minEndGapMs: number;
  /** Gap (ms) above which a thinking pause becomes trailing silence. */
  thinkingMaxMs: number;
  /** Gap (ms) above which the user is waiting and the agent nudges. */
  listeningNudgeMs: number;
  /** Gap (ms) above which the turn ends even mid-sentence. */
  forceEndMs: number;
}

export function defaultSilenceV20Options(): SilenceV20Options {
  return { minEndGapMs: 300, thinkingMaxMs: 1200, listeningNudgeMs: 4000, forceEndMs: 8000 };
}

export function validateSilenceV20Options(o: Partial<SilenceV20Options>): string[] {
  const e: string[] = [];
  if (o.minEndGapMs !== undefined && o.minEndGapMs < 0) e.push('minEndGapMs must be >= 0');
  if (o.thinkingMaxMs !== undefined && o.thinkingMaxMs < 0) e.push('thinkingMaxMs must be >= 0');
  if (o.listeningNudgeMs !== undefined && o.listeningNudgeMs < 0) e.push('listeningNudgeMs must be >= 0');
  if (o.forceEndMs !== undefined && o.forceEndMs < 0) e.push('forceEndMs must be >= 0');
  if (o.minEndGapMs !== undefined && o.thinkingMaxMs !== undefined && o.thinkingMaxMs < o.minEndGapMs) {
    e.push('thinkingMaxMs must be >= minEndGapMs');
  }
  if (o.listeningNudgeMs !== undefined && o.forceEndMs !== undefined && o.forceEndMs < o.listeningNudgeMs) {
    e.push('forceEndMs must be >= listeningNudgeMs');
  }
  return e;
}

/** Filler words that signal "I'm still thinking" (vi + en). */
export const FILLER_WORDS_V20: readonly string[] = [
  'ừm', 'ừ', 'à', 'à ừ', 'hmm', 'um', 'uh', 'er', 'ừm ừm', 'này', 'kiểu',
];

/** Conjunctions / continuers that signal the sentence is unfinished. */
export const CONTINUERS_V20: readonly string[] = [
  'và', 'nhưng', 'mà', 'thì', 'vì', 'nên', 'rồi', 'and', 'but', 'so', 'because', 'then',
];

/** Backchannel words: the user is listening, not interrupting. */
export const BACKCHANNEL_WORDS_V20: readonly string[] = [
  'ừ', 'uh-huh', 'ừ huh', 'ok', 'okay', 'yeah', 'yes', 'vâng', 'dạ', 'đúng rồi', 'ừ ừ',
];

function lastWordV20(text: string): string {
  const words = text.trim().split(/\s+/).filter((w) => w !== '');
  return words.length === 0 ? '' : words[words.length - 1]!.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

function endsWithTerminalV20(text: string): boolean {
  return /[.!?…]["')\]]*\s*$/.test(text.trim());
}

function endsWithFillerV20(text: string): boolean {
  const last = lastWordV20(text);
  return (FILLER_WORDS_V20 as readonly string[]).includes(last);
}

function endsWithContinuerV20(text: string): boolean {
  const last = lastWordV20(text);
  return (CONTINUERS_V20 as readonly string[]).includes(last);
}

/** Classify a silence gap after the given partial transcript. */
export function classifySilenceV20(
  textSoFar: string,
  gapMs: number,
  opts: Partial<SilenceV20Options> = {},
): SilenceV20Decision {
  const o = { ...defaultSilenceV20Options(), ...opts };
  const text = textSoFar.trim();
  if (text === '') {
    return {
      kind: 'listening-pause',
      endTurn: false,
      nudge: gapMs >= o.listeningNudgeMs,
      confidence: 0.9,
      reason: 'no speech yet — waiting for the user',
    };
  }
  if (gapMs >= o.forceEndMs) {
    return { kind: 'trailing-silence', endTurn: true, nudge: false, confidence: 0.95, reason: `gap ${gapMs}ms exceeds force-end ${o.forceEndMs}ms` };
  }
  if (gapMs >= o.listeningNudgeMs && endsWithTerminalV20(text)) {
    return { kind: 'listening-pause', endTurn: false, nudge: true, confidence: 0.8, reason: 'complete sentence, long wait — user may expect a nudge' };
  }
  if (gapMs < o.minEndGapMs) {
    return { kind: 'thinking-pause', endTurn: false, nudge: false, confidence: 0.9, reason: `gap ${gapMs}ms below min end gap ${o.minEndGapMs}ms` };
  }
  if (endsWithFillerV20(text) || endsWithContinuerV20(text)) {
    if (gapMs <= o.thinkingMaxMs) {
      return {
        kind: 'thinking-pause',
        endTurn: false,
        nudge: false,
        confidence: 0.85,
        reason: `ends with filler/continuer "${lastWordV20(text)}" — still thinking`,
      };
    }
    return { kind: 'trailing-silence', endTurn: true, nudge: false, confidence: 0.7, reason: 'filler, but gap outlasted the thinking window' };
  }
  if (!endsWithTerminalV20(text)) {
    if (gapMs <= o.thinkingMaxMs) {
      return { kind: 'thinking-pause', endTurn: false, nudge: false, confidence: 0.75, reason: 'no terminal punctuation — sentence unfinished' };
    }
    return { kind: 'trailing-silence', endTurn: true, nudge: false, confidence: 0.65, reason: 'unfinished sentence, but gap outlasted the thinking window' };
  }
  return { kind: 'trailing-silence', endTurn: true, nudge: false, confidence: 0.9, reason: 'complete sentence + gap past min end gap' };
}

export type BargeInV20Verdict = 'cut' | 'warn' | 'backchannel' | 'ignore';

export interface BargeInV20Score {
  verdict: BargeInV20Verdict;
  score: number;
  /** Score before the echo discount (for diagnostics). */
  rawScore: number;
  echoDiscounted: boolean;
  speakerChange: boolean;
  isBackchannel: boolean;
  reason: string;
}

export interface BargeInV20ScoreOptions {
  cutThreshold: number;
  warnThreshold: number;
  /** Extra score for a speaker-change hint (0..1). */
  speakerChangeBonus: number;
  /** Frames after a TTS chunk start count as echo window (ms). */
  echoWindowMs: number;
  /** Score multiplier inside the echo window (0..1). */
  echoMultiplier: number;
  /** Max words for a burst to count as backchannel. */
  backchannelMaxWords: number;
  /** Energy below this is never a cut (whisper / room noise). */
  minEnergyForCut: number;
}

export function defaultBargeInScoreV20Options(): BargeInV20ScoreOptions {
  return {
    cutThreshold: 0.75,
    warnThreshold: 0.45,
    speakerChangeBonus: 0.15,
    echoWindowMs: 120,
    echoMultiplier: 0.3,
    backchannelMaxWords: 2,
    minEnergyForCut: 0.15,
  };
}

export function validateBargeInScoreV20Options(o: Partial<BargeInV20ScoreOptions>): string[] {
  const e: string[] = [];
  const range = (v: number | undefined, name: string): void => {
    if (v !== undefined && (v < 0 || v > 1)) e.push(`${name} must be 0..1`);
  };
  range(o.cutThreshold, 'cutThreshold');
  range(o.warnThreshold, 'warnThreshold');
  range(o.speakerChangeBonus, 'speakerChangeBonus');
  range(o.echoMultiplier, 'echoMultiplier');
  range(o.minEnergyForCut, 'minEnergyForCut');
  if (o.cutThreshold !== undefined && o.warnThreshold !== undefined && o.warnThreshold >= o.cutThreshold) {
    e.push('warnThreshold must be < cutThreshold');
  }
  if (o.echoWindowMs !== undefined && o.echoWindowMs < 0) e.push('echoWindowMs must be >= 0');
  if (o.backchannelMaxWords !== undefined && o.backchannelMaxWords < 1) e.push('backchannelMaxWords must be >= 1');
  return e;
}

export interface BargeInV20CandidateInput {
  /** 0..1 speech energy of the burst. */
  energy: number;
  /** How long the burst has sustained, in ms. */
  sustainMs: number;
  /** Words recognised so far in this burst (mock STT). */
  transcriptWords: string[];
  /** Frame was flagged as agent echo. */
  echo: boolean;
  /** A new voice started mid-reply (VAD speaker-change hint). */
  speakerChange: boolean;
  /** ms since the current TTS chunk started. */
  msSinceChunkStart: number;
}

/** Is this burst a backchannel ("ừ", "ok") rather than an interruption? */
export function isBackchannelV20(words: readonly string[]): boolean {
  if (words.length === 0 || words.length > 2) return false;
  const joined = words.join(' ').toLowerCase().trim();
  return (BACKCHANNEL_WORDS_V20 as readonly string[]).includes(joined)
    || (words.length === 1 && (BACKCHANNEL_WORDS_V20 as readonly string[]).includes(words[0]!.toLowerCase()));
}

/** Score one barge-in candidate (v8 rules on top of v7 thresholds). */
export function scoreOpenTurnBargeInV20(
  input: BargeInV20CandidateInput,
  opts: Partial<BargeInV20ScoreOptions> = {},
): BargeInV20Score {
  const o = { ...defaultBargeInScoreV20Options(), ...opts };
  const backchannel = isBackchannelV20(input.transcriptWords);
  // Base score: energy 50% + sustain 30% + transcript evidence 20%.
  const sustainNorm = Math.min(1, input.sustainMs / 600);
  const transcriptNorm = Math.min(1, input.transcriptWords.length / 4);
  let raw = 0.5 * input.energy + 0.3 * sustainNorm + 0.2 * transcriptNorm;
  if (input.speakerChange) raw = Math.min(1, raw + o.speakerChangeBonus);
  let score = raw;
  let echoDiscounted = false;
  if (input.echo || input.msSinceChunkStart <= o.echoWindowMs) {
    score = raw * o.echoMultiplier;
    echoDiscounted = true;
  }
  if (backchannel) {
    return {
      verdict: 'backchannel',
      score,
      rawScore: Math.round(raw * 1000) / 1000,
      echoDiscounted,
      speakerChange: input.speakerChange,
      isBackchannel: true,
      reason: 'backchannel — acknowledged, floor stays with the agent',
    };
  }
  if (input.energy < o.minEnergyForCut) {
    return {
      verdict: 'ignore',
      score,
      rawScore: Math.round(raw * 1000) / 1000,
      echoDiscounted,
      speakerChange: input.speakerChange,
      isBackchannel: false,
      reason: `energy ${input.energy.toFixed(2)} below min ${o.minEnergyForCut} — room noise`,
    };
  }
  if (score >= o.cutThreshold) {
    return {
      verdict: 'cut',
      score: Math.round(score * 1000) / 1000,
      rawScore: Math.round(raw * 1000) / 1000,
      echoDiscounted,
      speakerChange: input.speakerChange,
      isBackchannel: false,
      reason: `score ${score.toFixed(2)} >= cut ${o.cutThreshold}`,
    };
  }
  if (score >= o.warnThreshold) {
    return {
      verdict: 'warn',
      score: Math.round(score * 1000) / 1000,
      rawScore: Math.round(raw * 1000) / 1000,
      echoDiscounted,
      speakerChange: input.speakerChange,
      isBackchannel: false,
      reason: `score ${score.toFixed(2)} >= warn ${o.warnThreshold} — early warning`,
    };
  }
  return {
    verdict: 'ignore',
    score: Math.round(score * 1000) / 1000,
    rawScore: Math.round(raw * 1000) / 1000,
    echoDiscounted,
    speakerChange: input.speakerChange,
    isBackchannel: false,
    reason: `score ${score.toFixed(2)} below warn ${o.warnThreshold}`,
  };
}

export interface SentenceCutV20 {
  /** Spoken prefix (whole words only — the cut fragment is dropped). */
  spokenPrefix: string;
  /** Remaining reply text, starting at a word boundary. */
  remainingText: string;
  /** Chars dropped as an unheard word fragment. */
  droppedChars: number;
  /** Index of the chunk the cut landed in. */
  chunkIndex: number;
  /** Chars spoken inside that chunk. */
  spokenInChunk: number;
}

/** Split a planned reply at a spoken-char offset (word boundary, fragment dropped). */
export function interruptSentenceV20(
  chunks: readonly TtsV20Chunk[],
  spokenChars: number,
): SentenceCutV20 {
  const full = chunks.filter((c) => c.kind === 'speech').map((c) => c.text).join(' ');
  if (spokenChars <= 0) {
    return { spokenPrefix: '', remainingText: full, droppedChars: 0, chunkIndex: 0, spokenInChunk: 0 };
  }
  if (spokenChars >= full.length) {
    return { spokenPrefix: full, remainingText: '', droppedChars: 0, chunkIndex: chunks.length - 1, spokenInChunk: 0 };
  }
  // Walk back to the previous word boundary so the listener never
  // hears half a word counted as spoken.
  let cut = spokenChars;
  while (cut > 0 && full[cut] !== ' ' && full[cut - 1] !== ' ') cut -= 1;
  const spokenPrefix = full.slice(0, cut).trimEnd();
  const remainingText = full.slice(cut).trimStart();
  // Which chunk held the cut point?
  let seen = 0;
  let chunkIndex = 0;
  let spokenInChunk = 0;
  const speech = chunks.filter((c) => c.kind === 'speech');
  for (let i = 0; i < speech.length; i += 1) {
    const len = speech[i]!.text.length + 1; // +1 for the joining space
    if (spokenChars < seen + len) {
      chunkIndex = i;
      spokenInChunk = Math.max(0, spokenChars - seen);
      break;
    }
    seen += len;
    chunkIndex = i;
    spokenInChunk = speech[i]!.text.length;
  }
  return {
    spokenPrefix,
    remainingText,
    droppedChars: spokenChars - spokenPrefix.length,
    chunkIndex,
    spokenInChunk,
  };
}

/** Continue the prosody plan across a cut (no flat restart). */
export function carryProsodyV20(
  lastPlan: TtsV20ProsodyPlan,
  remainingText: string,
): TtsV20ProsodyPlan {
  if (remainingText.trim() === '') return { ...lastPlan };
  // Keep the pitch the sentence was heading toward, ease the rate
  // back toward normal by half the distance (a cut reply resumes
  // slightly slower, then recovers — it never restarts flat).
  const rate = Math.round(((lastPlan.rate + 1) / 2) * 100) / 100;
  return { ...lastPlan, rate, pauseBeforeMs: 0 };
}

export type OverlapV20Decision = 'user-takes-floor' | 'agent-holds-floor' | 'backchannel-noted';

export interface OverlapV20Input {
  userConfidence: number;
  /** The agent's current chunk is a question (holds the floor briefly). */
  agentAskingQuestion: boolean;
  /** The agent's current chunk is low priority (background / filler). */
  agentChunkLowPriority: boolean;
  userIsBackchannel: boolean;
  /** ms the overlap has already lasted. */
  overlapMs: number;
}

/** Decide who keeps the floor when both sides speak at once. */
export function arbitrateOverlapV20(input: OverlapV20Input): { decision: OverlapV20Decision; reason: string } {
  if (input.userIsBackchannel) {
    return { decision: 'backchannel-noted', reason: 'backchannel — agent keeps the floor' };
  }
  if (input.agentAskingQuestion && input.overlapMs < 800 && input.userConfidence < 0.9) {
    return { decision: 'agent-holds-floor', reason: 'agent mid-question — holds the floor briefly' };
  }
  if (input.userConfidence >= 0.7 || input.agentChunkLowPriority) {
    return { decision: 'user-takes-floor', reason: input.agentChunkLowPriority ? 'agent chunk is low priority' : `user confidence ${input.userConfidence.toFixed(2)} >= 0.7` };
  }
  return { decision: 'agent-holds-floor', reason: `user confidence ${input.userConfidence.toFixed(2)} below 0.7` };
}

export interface OpenTurnV20Event {
  kind: 'silence' | 'barge-in-score' | 'sentence-cut' | 'overlap' | 'backchannel';
  atMs: number;
  detail: Record<string, unknown>;
}

export type OpenTurnV20EventSink = (event: OpenTurnV20Event) => void;

export interface OpenTurnV20Stats {
  silences: number;
  thinkingPauses: number;
  trailingSilences: number;
  nudges: number;
  bargeInScores: number;
  cuts: number;
  warnings: number;
  backchannels: number;
  ignored: number;
  sentenceCuts: number;
  overlaps: number;
  userTakesFloor: number;
}

/** Stateful open-turn engine: classifier + scorer + cutter + arbitrator. */
export class OpenTurnEngineV20 {
  private silenceOpts: SilenceV20Options;
  private bargeOpts: BargeInV20ScoreOptions;
  private sink?: OpenTurnV20EventSink;
  private events: OpenTurnV20Event[] = [];
  private stats: OpenTurnV20Stats = {
    silences: 0, thinkingPauses: 0, trailingSilences: 0, nudges: 0,
    bargeInScores: 0, cuts: 0, warnings: 0, backchannels: 0, ignored: 0,
    sentenceCuts: 0, overlaps: 0, userTakesFloor: 0,
  };

  constructor(
    silenceOpts: Partial<SilenceV20Options> = {},
    bargeOpts: Partial<BargeInV20ScoreOptions> = {},
    sink?: OpenTurnV20EventSink,
  ) {
    this.silenceOpts = { ...defaultSilenceV20Options(), ...silenceOpts };
    this.bargeOpts = { ...defaultBargeInScoreV20Options(), ...bargeOpts };
    this.sink = sink;
  }

  private emit(e: OpenTurnV20Event): void {
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    this.sink?.(e);
  }

  getEvents(): OpenTurnV20Event[] { return [...this.events]; }
  getStats(): OpenTurnV20Stats { return { ...this.stats }; }

  onSilence(textSoFar: string, gapMs: number, atMs: number): SilenceV20Decision {
    const d = classifySilenceV20(textSoFar, gapMs, this.silenceOpts);
    this.stats.silences += 1;
    if (d.kind === 'thinking-pause') this.stats.thinkingPauses += 1;
    if (d.kind === 'trailing-silence') this.stats.trailingSilences += 1;
    if (d.nudge) this.stats.nudges += 1;
    this.emit({ kind: 'silence', atMs, detail: { gapMs, kind: d.kind, endTurn: d.endTurn, reason: d.reason } });
    return d;
  }

  onBargeInCandidate(input: BargeInV20CandidateInput, atMs: number): BargeInV20Score {
    const s = scoreOpenTurnBargeInV20(input, this.bargeOpts);
    this.stats.bargeInScores += 1;
    if (s.verdict === 'cut') this.stats.cuts += 1;
    if (s.verdict === 'warn') this.stats.warnings += 1;
    if (s.verdict === 'backchannel') {
      this.stats.backchannels += 1;
      this.emit({ kind: 'backchannel', atMs, detail: { score: s.score } });
    }
    if (s.verdict === 'ignore') this.stats.ignored += 1;
    this.emit({ kind: 'barge-in-score', atMs, detail: { verdict: s.verdict, score: s.score, reason: s.reason } });
    return s;
  }

  onSentenceCut(chunks: readonly TtsV20Chunk[], spokenChars: number, atMs: number): SentenceCutV20 {
    const cut = interruptSentenceV20(chunks, spokenChars);
    this.stats.sentenceCuts += 1;
    this.emit({ kind: 'sentence-cut', atMs, detail: { spokenChars, remainingChars: cut.remainingText.length, droppedChars: cut.droppedChars } });
    return cut;
  }

  onOverlap(input: OverlapV20Input, atMs: number): { decision: OverlapV20Decision; reason: string } {
    const d = arbitrateOverlapV20(input);
    this.stats.overlaps += 1;
    if (d.decision === 'user-takes-floor') this.stats.userTakesFloor += 1;
    this.emit({ kind: 'overlap', atMs, detail: { decision: d.decision, reason: d.reason } });
    return d;
  }

  /** RMS energy of one frame (0..1-ish scale for the scorer). */
  frameEnergy(frame: VoiceV20Frame): number {
    return Math.min(1, pcm16RmsV20(frame.samples) / 32768);
  }

  summary(): string {
    const s = this.stats;
    return `Open-turn v20: ${s.silences} silences (${s.thinkingPauses} thinking, ${s.trailingSilences} trailing, ${s.nudges} nudges), ` +
      `${s.bargeInScores} barge-in scores (${s.cuts} cuts, ${s.warnings} warnings, ${s.backchannels} backchannels, ${s.ignored} ignored), ` +
      `${s.sentenceCuts} sentence cuts, ${s.overlaps} overlaps (${s.userTakesFloor} user took floor)`;
  }
}

export function createOpenTurnEngineV20(
  silenceOpts: Partial<SilenceV20Options> = {},
  bargeOpts: Partial<BargeInV20ScoreOptions> = {},
  sink?: OpenTurnV20EventSink,
): OpenTurnEngineV20 {
  return new OpenTurnEngineV20(silenceOpts, bargeOpts, sink);
}

export function openTurnV20Markdown(e: OpenTurnEngineV20): string {
  const s = e.getStats();
  return `# Open-turn v20\n\n- Silences: ${s.silences} (thinking ${s.thinkingPauses}, trailing ${s.trailingSilences}, nudges ${s.nudges})\n` +
    `- Barge-in scores: ${s.bargeInScores} (cuts ${s.cuts}, warnings ${s.warnings}, backchannels ${s.backchannels}, ignored ${s.ignored})\n` +
    `- Sentence cuts: ${s.sentenceCuts}\n- Overlaps: ${s.overlaps} (user took floor ${s.userTakesFloor})\n`;
}
