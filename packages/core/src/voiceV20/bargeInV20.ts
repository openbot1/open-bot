/**
 * Barge-in v7 (voice v20, v1.28 Team T5).
 *
 * On top of v18's barge-in: every candidate interruption is scored
 * (speech energy, VAD confidence, sustained duration, echo
 * discount, transcript evidence) and only a score above threshold
 * cuts the agent's speech. A weak candidate raises an early
 * warning instead of cutting, so a cough or a door slam never
 * kills a sentence. When a cut happens the engine records the
 * exact cut point — how much of the agent's reply was already
 * spoken, what remains, and the turn context — so the reply can
 * be resumed, restarted, or dropped deliberately. Echo frames
 * (the agent hearing itself) are discounted, never trusted.
 *
 * Pure scoring + state machine, virtual clock, mock audio only.
 */
import { pcm16RmsV20, VOICE_V20_FRAME_SAMPLES, type VoiceV20Frame } from './types';

export type BargeInV20Decision = 'ignore' | 'warn' | 'cut';
export type BargeInV20ResumeMode = 'resume' | 'restart' | 'drop';
export type BargeInV20EventKind = 'warning' | 'cut' | 'ignored' | 'restored' | 'echo-suppressed';
export type BargeInV20Event = {
  kind: BargeInV20EventKind;
  atMs: number;
  detail?: Record<string, unknown>;
};
export type BargeInV20EventSink = (event: BargeInV20Event) => void;

export interface BargeInV20Options {
  /** Score >= this cuts the agent's speech. */
  cutThreshold: number;
  /** Score >= this (but < cut) raises an early warning. */
  warnThreshold: number;
  /** Speech must sustain this long before it can cut. */
  minSustainMs: number;
  /** Weight of frame energy in the score (0..1). */
  energyWeight: number;
  /** Weight of sustained speech in the score (0..1). */
  sustainWeight: number;
  /** Weight of transcript evidence in the score (0..1). */
  transcriptWeight: number;
  /** How much echo frames discount the score (0..1). */
  echoDiscount: number;
  /** After a cut, ignore new candidates for this long. */
  refractoryMs: number;
  /** Max warning events before one is forced to a decision. */
  maxWarningsBeforeCut: number;
}

export function defaultBargeInV20Options(): BargeInV20Options {
  return {
    cutThreshold: 0.75,
    warnThreshold: 0.45,
    minSustainMs: 180,
    energyWeight: 0.45,
    sustainWeight: 0.35,
    transcriptWeight: 0.2,
    echoDiscount: 0.7,
    refractoryMs: 800,
    maxWarningsBeforeCut: 3,
  };
}

export function validateBargeInV20Options(o: Partial<BargeInV20Options>): string[] {
  const e: string[] = [];
  const range = (v: number | undefined, name: string): void => {
    if (v !== undefined && (v < 0 || v > 1)) e.push(`${name} must be 0..1`);
  };
  range(o.cutThreshold, 'cutThreshold');
  range(o.warnThreshold, 'warnThreshold');
  range(o.energyWeight, 'energyWeight');
  range(o.sustainWeight, 'sustainWeight');
  range(o.transcriptWeight, 'transcriptWeight');
  range(o.echoDiscount, 'echoDiscount');
  if (o.cutThreshold !== undefined && o.warnThreshold !== undefined && o.warnThreshold >= o.cutThreshold) {
    e.push('warnThreshold must be < cutThreshold');
  }
  if (o.minSustainMs !== undefined && o.minSustainMs < 0) e.push('minSustainMs must be >= 0');
  if (o.refractoryMs !== undefined && o.refractoryMs < 0) e.push('refractoryMs must be >= 0');
  if (o.maxWarningsBeforeCut !== undefined && o.maxWarningsBeforeCut < 1) e.push('maxWarningsBeforeCut must be >= 1');
  return e;
}

export interface BargeInV20Candidate {
  atMs: number;
  energy: number;
  sustainMs: number;
  transcriptWords: number;
  echo: boolean;
  score: number;
}

export interface BargeInV20CutRecord {
  atMs: number;
  /** Agent reply text that was being spoken. */
  replyText: string;
  /** Chars already spoken when the cut landed. */
  spokenChars: number;
  /** Remaining reply text after the cut point. */
  remainingText: string;
  /** Score of the candidate that cut. */
  score: number;
  /** Turn id the cut belongs to. */
  turnId: string;
  /** User words captured before the cut, if any. */
  userPrefix: string;
  resumeMode: BargeInV20ResumeMode;
}

export interface BargeInV20Stats {
  candidates: number;
  warnings: number;
  cuts: number;
  ignored: number;
  echoSuppressed: number;
  meanCutScore: number;
  meanCutLatencyMs: number;
  lastCutScore: number | null;
}

export interface BargeInV20ScoreBreakdown {
  energyPart: number;
  sustainPart: number;
  transcriptPart: number;
  echoMultiplier: number;
  score: number;
}

/** Score one candidate from its raw evidence. Pure function, testable alone. */
export function scoreBargeInV20(
  o: BargeInV20Options,
  energy: number,
  sustainMs: number,
  transcriptWords: number,
  echo: boolean,
): BargeInV20ScoreBreakdown {
  const energyPart = Math.min(1, energy) * o.energyWeight;
  const sustainPart = Math.min(1, sustainMs / 600) * o.sustainWeight;
  const transcriptPart = Math.min(1, transcriptWords / 4) * o.transcriptWeight;
  const echoMultiplier = echo ? 1 - o.echoDiscount : 1;
  const score = Math.min(1, (energyPart + sustainPart + transcriptPart) * echoMultiplier);
  return { energyPart, sustainPart, transcriptPart, echoMultiplier, score };
}

/** Decide from a score: ignore / warn / cut. */
export function decideBargeInV20(o: BargeInV20Options, score: number): BargeInV20Decision {
  if (score >= o.cutThreshold) return 'cut';
  if (score >= o.warnThreshold) return 'warn';
  return 'ignore';
}

/**
 * Split an agent reply at the spoken-char cut point.
 * Returns the spoken prefix and the remaining text (leading
 * whitespace trimmed, sentence boundary preferred).
 */
export function splitReplyAtCutV20(replyText: string, spokenChars: number): { spoken: string; remaining: string } {
  const cut = Math.max(0, Math.min(replyText.length, spokenChars));
  const spoken = replyText.slice(0, cut);
  let remaining = replyText.slice(cut).trimStart();
  // Prefer resuming at a sentence boundary just after the cut.
  const boundary = remaining.search(/[.!?]\s/);
  if (boundary >= 0 && boundary < 40) remaining = remaining.slice(boundary + 2).trimStart();
  return { spoken, remaining };
}

export class BargeInEngineV20 {
  private opts: BargeInV20Options;
  private sink?: BargeInV20EventSink;
  private agentSpeaking = false;
  private agentReply = '';
  private agentTurnId = '';
  private spokenChars = 0;
  private candidateStartMs: number | null = null;
  private lastCandidateEnergy = 0;
  private lastTranscriptWords = 0;
  private warningsInRow = 0;
  private lastCutAtMs: number | null = null;
  private cuts: BargeInV20CutRecord[] = [];
  private cutScores: number[] = [];
  private cutLatencies: number[] = [];
  private stats: BargeInV20Stats = {
    candidates: 0, warnings: 0, cuts: 0, ignored: 0, echoSuppressed: 0,
    meanCutScore: 0, meanCutLatencyMs: 0, lastCutScore: null,
  };

  constructor(opts: Partial<BargeInV20Options> = {}, sink?: BargeInV20EventSink) {
    this.opts = { ...defaultBargeInV20Options(), ...opts };
    this.sink = sink;
  }

  get options(): BargeInV20Options { return { ...this.opts }; }
  get isAgentSpeaking(): boolean { return this.agentSpeaking; }
  getStats(): BargeInV20Stats { return { ...this.stats }; }
  getCuts(): BargeInV20CutRecord[] { return [...this.cuts]; }
  get lastCut(): BargeInV20CutRecord | null { return this.cuts.length > 0 ? this.cuts[this.cuts.length - 1] : null; }

  /** The agent starts speaking a reply (mock TTS drives spokenChars via advanceSpoken). */
  agentStart(replyText: string, turnId: string, atMs: number): void {
    this.agentSpeaking = true;
    this.agentReply = replyText;
    this.agentTurnId = turnId;
    this.spokenChars = 0;
    this.candidateStartMs = null;
    this.warningsInRow = 0;
    void atMs;
  }

  /** Advance the spoken-char cursor as mock TTS emits chunks. */
  advanceSpoken(chars: number): void {
    this.spokenChars = Math.min(this.agentReply.length, this.spokenChars + Math.max(0, chars));
  }

  agentStop(): void {
    this.agentSpeaking = false;
    this.agentReply = '';
    this.spokenChars = 0;
    this.candidateStartMs = null;
  }

  /** Transcript evidence for the current candidate (mock STT partial word count). */
  noteTranscriptWords(words: number): void {
    this.lastTranscriptWords = Math.max(this.lastTranscriptWords, words);
  }

  /**
   * Feed one user-side frame while the agent speaks. Returns the
   * decision; a 'cut' also ends the agent's speech and records it.
   */
  feed(frame: VoiceV20Frame, rmsOverride?: number): BargeInV20Decision {
    if (!this.agentSpeaking) return 'ignore';
    const nowMs = frame.atMs;
    if (this.lastCutAtMs !== null && nowMs - this.lastCutAtMs < this.opts.refractoryMs) return 'ignore';
    const rms = rmsOverride ?? pcm16RmsV20(frame.samples);
    const energy = Math.min(1, rms / 12000);
    const frameMs = (frame.samples.length / VOICE_V20_FRAME_SAMPLES) * 20;
    if (energy < 0.08 && !frame.echo) {
      // Quiet frame: candidate decays.
      this.candidateStartMs = null;
      this.lastTranscriptWords = 0;
      return 'ignore';
    }
    if (frame.echo) {
      this.stats.echoSuppressed += 1;
      this.sink?.({ kind: 'echo-suppressed', atMs: nowMs, detail: { energy } });
      return 'ignore';
    }
    if (this.candidateStartMs === null) this.candidateStartMs = nowMs;
    const sustainMs = nowMs - this.candidateStartMs + frameMs;
    this.lastCandidateEnergy = Math.max(this.lastCandidateEnergy, energy);
    this.stats.candidates += 1;
    const breakdown = scoreBargeInV20(this.opts, this.lastCandidateEnergy, sustainMs, this.lastTranscriptWords, false);
    let decision = decideBargeInV20(this.opts, breakdown.score);
    if (decision === 'cut' && sustainMs < this.opts.minSustainMs) decision = 'warn';
    if (decision === 'warn') {
      this.warningsInRow += 1;
      this.stats.warnings += 1;
      this.sink?.({ kind: 'warning', atMs: nowMs, detail: { score: breakdown.score, sustainMs } });
      if (this.warningsInRow >= this.opts.maxWarningsBeforeCut && sustainMs >= this.opts.minSustainMs) {
        decision = 'cut';
      } else {
        return 'warn';
      }
    }
    if (decision === 'ignore') {
      this.stats.ignored += 1;
      this.sink?.({ kind: 'ignored', atMs: nowMs, detail: { score: breakdown.score } });
      return 'ignore';
    }
    // Cut.
    const { spoken, remaining } = splitReplyAtCutV20(this.agentReply, this.spokenChars);
    const record: BargeInV20CutRecord = {
      atMs: nowMs,
      replyText: this.agentReply,
      spokenChars: this.spokenChars,
      remainingText: remaining,
      score: breakdown.score,
      turnId: this.agentTurnId,
      userPrefix: '',
      resumeMode: remaining.length > 0 ? 'resume' : 'drop',
    };
    this.cuts.push(record);
    this.cutScores.push(breakdown.score);
    if (this.candidateStartMs !== null) this.cutLatencies.push(nowMs - this.candidateStartMs);
    this.stats.cuts += 1;
    this.stats.lastCutScore = breakdown.score;
    this.stats.meanCutScore = this.cutScores.reduce((a, b) => a + b, 0) / this.cutScores.length;
    this.stats.meanCutLatencyMs = this.cutLatencies.length > 0
      ? this.cutLatencies.reduce((a, b) => a + b, 0) / this.cutLatencies.length : 0;
    this.lastCutAtMs = nowMs;
    this.agentSpeaking = false;
    this.warningsInRow = 0;
    this.candidateStartMs = null;
    this.lastTranscriptWords = 0;
    this.sink?.({ kind: 'cut', atMs: nowMs, detail: { score: breakdown.score, spokenChars: this.spokenChars, remaining: remaining.length, turnId: this.agentTurnId } });
    void spoken;
    return 'cut';
  }

  /** Attach the user's words captured at the cut, for the resume context. */
  attachUserPrefix(cutAtMs: number, userPrefix: string): void {
    const cut = [...this.cuts].reverse().find((c) => c.atMs === cutAtMs);
    if (cut) cut.userPrefix = userPrefix;
  }

  /** Choose how the cut reply continues; 'resume' keeps the remainder, 'restart' replays all, 'drop' abandons it. */
  chooseResume(mode: BargeInV20ResumeMode, atMs: number): string {
    const cut = this.lastCut;
    if (!cut) return '';
    cut.resumeMode = mode;
    this.sink?.({ kind: 'restored', atMs, detail: { mode, turnId: cut.turnId } });
    if (mode === 'resume') return cut.remainingText;
    if (mode === 'restart') return cut.replyText;
    return '';
  }

  reset(): void {
    this.agentSpeaking = false;
    this.agentReply = '';
    this.spokenChars = 0;
    this.candidateStartMs = null;
    this.warningsInRow = 0;
    this.cuts = [];
  }
}

export function createBargeInEngineV20(
  opts: Partial<BargeInV20Options> = {},
  sink?: BargeInV20EventSink,
): BargeInEngineV20 {
  return new BargeInEngineV20(opts, sink);
}

export function bargeInV20Summary(e: BargeInEngineV20): string {
  const s = e.getStats();
  return `Barge-in v7: ${s.cuts} cuts, ${s.warnings} warnings, ${s.ignored} ignored, ` +
    `${s.echoSuppressed} echo-suppressed, mean cut score ${s.meanCutScore.toFixed(2)}, ` +
    `mean cut latency ${Math.round(s.meanCutLatencyMs)}ms`;
}

export function bargeInV20Markdown(e: BargeInEngineV20): string {
  const s = e.getStats();
  return `# Barge-in v7\n\n- Candidates: ${s.candidates}\n- Warnings: ${s.warnings}\n- Cuts: ${s.cuts}\n` +
    `- Ignored: ${s.ignored}\n- Echo suppressed: ${s.echoSuppressed}\n` +
    `- Mean cut score: ${s.meanCutScore.toFixed(2)}\n- Mean cut latency: ${Math.round(s.meanCutLatencyMs)}ms\n`;
}
