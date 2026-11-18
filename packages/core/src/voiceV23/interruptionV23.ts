/**
 * Interruption handling v2 for voice v23 (v1.36, Team T5).
 *
 * v22 scores a barge-in burst and cuts the reply; v23 decides
 * *whether the burst should even count* and what happens next:
 *
 *   1. Grace window — a burst inside the first `graceMs` of an
 *      agent reply is the tail of the previous turn (or echo),
 *      not an interruption. v22 had no such window.
 *   2. Backchannel rule — a pure backchannel burst ("ừm", "ok",
 *      "yeah") is ignored, unless it sustains long enough
 *      (>= `backchannelDuckMs`) to mean "slow down", in which
 *      case it ducks soft instead of interrupting.
 *   3. Echo / not-speaking — delegated to v22 (score 0).
 *   4. Otherwise the v22 score + thresholds decide.
 *
 * After an interrupt the policy also answers the two
 * questions v22 left to the caller: how much of the cut reply
 * must be re-spoken (partial-word rollback — the word the
 * agent was mid-way through is re-spoken from its start) and
 * which resume strategy fits (resume / drop / summarise /
 * rephrase). Every decision lands in the ledger with its
 * stop latency, so false positives are countable.
 */
import type { VoiceV22BargeInDecision, VoiceV22ReplyCut } from '../voiceV22/types';
import {
  decideBargeInV22,
  isBackchannelBurstV22,
  scoreBargeInV22,
  splitReplyAtCutV22,
  type VoiceV22BargeInOptions,
} from '../voiceV22/bargeInV22';
import type { VoiceV23InterruptStrategy } from './types';
import { meanV23, round2V23 } from './types';

export interface InterruptionV23Options {
  /** v22 scoring/threshold options, passed through. */
  bargeIn?: Partial<VoiceV22BargeInOptions>;
  /** Bursts inside the first N ms of a reply are ignored (default 300). */
  graceMs: number;
  /** A sustained backchannel (>= N ms) ducks soft instead of ignored (default 400). */
  backchannelDuckMs: number;
  /** Remaining chars above this -> summarise instead of resume (default 400). */
  summariseRemainingChars: number;
}

export function defaultInterruptionV23Options(): InterruptionV23Options {
  return {
    bargeIn: {},
    graceMs: 300,
    backchannelDuckMs: 400,
    summariseRemainingChars: 400,
  };
}

export function validateInterruptionV23Options(o: Partial<InterruptionV23Options>): string[] {
  const errors: string[] = [];
  if (o.graceMs !== undefined && !(o.graceMs >= 0 && o.graceMs <= 5000)) errors.push('graceMs must be 0..5000');
  if (o.backchannelDuckMs !== undefined && !(o.backchannelDuckMs >= 0 && o.backchannelDuckMs <= 5000)) {
    errors.push('backchannelDuckMs must be 0..5000');
  }
  if (o.summariseRemainingChars !== undefined && !(o.summariseRemainingChars >= 0 && o.summariseRemainingChars <= 5000)) {
    errors.push('summariseRemainingChars must be 0..5000');
  }
  return errors;
}

/** One burst presented to the policy. */
export interface VoiceV23InterruptionCandidate {
  atMs: number;
  /** ms into the current agent reply (0 when the agent is not speaking). */
  atMsIntoReply: number;
  energy: number;
  sustainMs: number;
  words: string[];
  echo?: boolean;
  agentSpeaking: boolean;
  confidence?: number;
}

export interface VoiceV23InterruptionDecision {
  decision: VoiceV22BargeInDecision;
  /** v22 score total (0 when the policy short-circuited). */
  scoreTotal: number;
  /** Which rule produced the decision. */
  rule: 'echo' | 'not-speaking' | 'grace-window' | 'backchannel' | 'backchannel-duck' | 'v22-score';
  /** True when the burst was a pure backchannel. */
  backchannel: boolean;
}

export interface VoiceV23Rollback {
  /** Re-speak from this char offset (start of the partial word). */
  reSpeakFromChar: number;
  /** Chars rolled back (the partial word fragment). */
  rolledBackChars: number;
  /** Text to re-speak (partial word + remainder). */
  reSpeakText: string;
}

/** Words that ask the agent to say it again, differently. */
export const VOICE_V23_REPHRASE_WORDS = ['lại', 'again', 'repeat', 'nói-lại', 'repeat-that'] as const;

/**
 * Roll the cut point back to the start of the word the agent
 * was mid-way through, so a resumed reply never restarts
 * mid-word. `spokenChars` may land inside a word; the rollback
 * returns the word-start offset.
 */
export function rollbackForCutV23(replyText: string, spokenChars: number): VoiceV23Rollback {
  const cut = splitReplyAtCutV22(replyText, spokenChars);
  const spoken = cut.spoken;
  // Walk back from the end of the spoken part to the previous space.
  let start = spoken.length;
  while (start > 0 && spoken[start - 1] !== ' ') start -= 1;
  const rolledBackChars = spoken.length - start;
  return {
    reSpeakFromChar: start,
    rolledBackChars,
    reSpeakText: replyText.slice(start),
  };
}

/** Pick a resume strategy for a cut reply + the user's interrupting words. */
export function strategyForCutV23(
  cut: VoiceV22ReplyCut,
  userWords: readonly string[],
  opts: Partial<InterruptionV23Options> = {},
): VoiceV23InterruptStrategy {
  const o = { ...defaultInterruptionV23Options(), ...opts };
  if (cut.remainingChars <= 0) return 'drop';
  const lower = userWords.map((w) => w.toLowerCase());
  if (lower.some((w) => (VOICE_V23_REPHRASE_WORDS as readonly string[]).includes(w))) return 'rephrase';
  if (cut.remainingChars > o.summariseRemainingChars) return 'summarise';
  return 'resume';
}

export class InterruptionPolicyV23 {
  private readonly opts: InterruptionV23Options;

  constructor(opts: Partial<InterruptionV23Options> = {}) {
    const errors = validateInterruptionV23Options(opts);
    if (errors.length > 0) throw new Error(`Invalid InterruptionV23 options: ${errors.join('; ')}`);
    this.opts = { ...defaultInterruptionV23Options(), ...opts, bargeIn: { ...(opts.bargeIn ?? {}) } };
  }

  options(): InterruptionV23Options {
    return { ...this.opts, bargeIn: { ...this.opts.bargeIn } };
  }

  decide(candidate: VoiceV23InterruptionCandidate): VoiceV23InterruptionDecision {
    if (candidate.echo === true) {
      return { decision: 'ignore', scoreTotal: 0, rule: 'echo', backchannel: false };
    }
    if (!candidate.agentSpeaking) {
      return { decision: 'ignore', scoreTotal: 0, rule: 'not-speaking', backchannel: false };
    }
    if (candidate.atMsIntoReply < this.opts.graceMs) {
      return { decision: 'ignore', scoreTotal: 0, rule: 'grace-window', backchannel: false };
    }
    const backchannel = isBackchannelBurstV22(candidate.words);
    if (backchannel) {
      if (candidate.sustainMs >= this.opts.backchannelDuckMs) {
        return { decision: 'duck-soft', scoreTotal: 0, rule: 'backchannel-duck', backchannel: true };
      }
      return { decision: 'ignore', scoreTotal: 0, rule: 'backchannel', backchannel: true };
    }
    const score = scoreBargeInV22(
      {
        atMs: candidate.atMs,
        energy: candidate.energy,
        sustainMs: candidate.sustainMs,
        words: candidate.words,
        echo: candidate.echo,
        agentSpeaking: candidate.agentSpeaking,
        confidence: candidate.confidence,
      },
      this.opts.bargeIn,
    );
    return { decision: decideBargeInV22(score, this.opts.bargeIn), scoreTotal: score.total, rule: 'v22-score', backchannel: false };
  }

  rollback(replyText: string, spokenChars: number): VoiceV23Rollback {
    return rollbackForCutV23(replyText, spokenChars);
  }

  strategy(cut: VoiceV22ReplyCut, userWords: readonly string[]): VoiceV23InterruptStrategy {
    return strategyForCutV23(cut, userWords, this.opts);
  }
}

export function createInterruptionPolicyV23(opts: Partial<InterruptionV23Options> = {}): InterruptionPolicyV23 {
  return new InterruptionPolicyV23(opts);
}

/** One ledger entry: a decided interruption and its outcome. */
export interface VoiceV23InterruptionRecord {
  id: string;
  atMs: number;
  decision: VoiceV22BargeInDecision;
  rule: VoiceV23InterruptionDecision['rule'];
  /** ms from burst to agent silence (0 when not an interrupt). */
  stopLatencyMs: number;
  strategy: VoiceV23InterruptStrategy | null;
  /** True when the decision was later judged wrong. */
  falsePositive: boolean;
}

export interface VoiceV23InterruptionStats {
  total: number;
  interrupts: number;
  duckHard: number;
  duckSoft: number;
  ignored: number;
  falsePositives: number;
  meanStopLatencyMs: number;
  p95StopLatencyMs: number;
  resumed: number;
  dropped: number;
  summarised: number;
  rephrased: number;
}

/** Ledger: every interruption decision, countable and auditable. */
export class InterruptionLedgerV23 {
  private readonly records: VoiceV23InterruptionRecord[] = [];
  private counter = 0;

  record(
    decision: VoiceV23InterruptionDecision,
    atMs: number,
    stopLatencyMs = 0,
    strategy: VoiceV23InterruptStrategy | null = null,
  ): VoiceV23InterruptionRecord {
    this.counter += 1;
    const entry: VoiceV23InterruptionRecord = {
      id: `v23-int-${this.counter}`,
      atMs,
      decision: decision.decision,
      rule: decision.rule,
      stopLatencyMs: Math.max(0, stopLatencyMs),
      strategy,
      falsePositive: false,
    };
    this.records.push(entry);
    return entry;
  }

  /** Mark a past decision as a false positive (e.g. it was echo after all). */
  markFalsePositive(id: string): boolean {
    const entry = this.records.find((r) => r.id === id);
    if (entry === undefined) return false;
    entry.falsePositive = true;
    return true;
  }

  history(): VoiceV23InterruptionRecord[] {
    return [...this.records];
  }

  stats(): VoiceV23InterruptionStats {
    const stopLatencies = this.records
      .filter((r) => r.decision === 'interrupt')
      .map((r) => r.stopLatencyMs)
      .sort((a, b) => a - b);
    const p95 = stopLatencies.length === 0 ? 0 : stopLatencies[Math.min(stopLatencies.length - 1, Math.floor(0.95 * stopLatencies.length))];
    return {
      total: this.records.length,
      interrupts: this.records.filter((r) => r.decision === 'interrupt').length,
      duckHard: this.records.filter((r) => r.decision === 'duck-hard').length,
      duckSoft: this.records.filter((r) => r.decision === 'duck-soft').length,
      ignored: this.records.filter((r) => r.decision === 'ignore').length,
      falsePositives: this.records.filter((r) => r.falsePositive).length,
      meanStopLatencyMs: round2V23(meanV23(stopLatencies)),
      p95StopLatencyMs: p95,
      resumed: this.records.filter((r) => r.strategy === 'resume').length,
      dropped: this.records.filter((r) => r.strategy === 'drop').length,
      summarised: this.records.filter((r) => r.strategy === 'summarise').length,
      rephrased: this.records.filter((r) => r.strategy === 'rephrase').length,
    };
  }

  summary(): string {
    const s = this.stats();
    return `interruptions: ${s.total} decided (${s.interrupts} interrupt, ${s.duckHard} duck-hard, ${s.duckSoft} duck-soft, ${s.ignored} ignored), ${s.falsePositives} false positives, mean stop ${s.meanStopLatencyMs}ms`;
  }

  reset(): void {
    this.records.length = 0;
    this.counter = 0;
  }
}
