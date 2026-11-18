/**
 * Shared types for voice realtime v23 (v1.36, Team T5).
 *
 * v23 continues v22 without touching it: v22 owns the durable
 * session (journal, checkpoint, resume, recovery, profiles,
 * floor turn-taking, two-depth barge-in). v23 owns what v22
 * measures and adapts around that session:
 *
 *   - deeper quality evaluation: WER / latency / MOS-proxy on
 *     an expanded test-pair corpus, with a v22 -> v23 baseline
 *     comparison so regressions are visible, not guessed;
 *   - realtime streaming v2: an adaptive jitter buffer, frame
 *     pacing and endpointing that follow the measured network
 *     and noise instead of fixed constants;
 *   - interruption handling v2: grace windows, partial-word
 *     rollback and a resume ledger on top of the v22 decision;
 *   - a realtime session manager v2: reconnect + resume
 *     orchestration across many v22 sessions, with handover;
 *   - automatic calibration: gain / noise threshold fitted to
 *     the room, stored per device as a preset.
 *
 * All clocks virtual, all audio mock/synthetic, no network,
 * no key, no mic/sound card. TTS engines are mocked: this VM
 * has no Windows TTS engine and no sound card.
 */
import { clampV22, speechWordsV22 } from '../voiceV22/types';

export type VoiceV23Clock = { nowMs: number };

/** Locales the v23 eval corpus covers. */
export type VoiceV23Locale = 'vi' | 'en' | 'other';

/** Acoustic condition a test pair was recorded under (synthetic label). */
export type VoiceV23Condition = 'clean' | 'noisy' | 'far-field' | 'echoey' | 'fast-speech';

/** One reference/hypothesis pair for transcript evaluation. */
export interface VoiceV23EvalPair {
  id: string;
  locale: VoiceV23Locale;
  condition: VoiceV23Condition;
  reference: string;
  hypothesis: string;
  /** Expected WER ceiling for this pair (0..1). */
  werCeiling: number;
}

/** Word-level edit distance result between reference and hypothesis. */
export interface VoiceV23WerResult {
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  refWords: number;
  hypWords: number;
  /** 0..1 when the pair passes its ceiling. */
  passes: boolean;
}

/** One latency observation (ms) from a realtime turn. */
export interface VoiceV23LatencySample {
  id: string;
  /** ms from end of user speech to first agent audio. */
  firstTokenMs: number;
  /** ms from end of user speech to end of agent reply. */
  totalMs: number;
  /** Inter-arrival jitter of the audio frames, ms. */
  jitterMs: number;
}

/** Latency aggregate: mean / p50 / p95 / max, plus budget verdict. */
export interface VoiceV23LatencyAggregate {
  n: number;
  meanFirstTokenMs: number;
  p50FirstTokenMs: number;
  p95FirstTokenMs: number;
  maxFirstTokenMs: number;
  meanTotalMs: number;
  p95TotalMs: number;
  meanJitterMs: number;
  p95JitterMs: number;
  overBudget: number;
}

/** Features feeding the MOS-proxy estimator. */
export interface VoiceV23MosFeatures {
  /** Word error rate 0..1. */
  wer: number;
  /** ms to first agent audio. */
  latencyMs: number;
  /** Frame jitter, ms. */
  jitterMs: number;
  /** ms from barge-in burst to agent silence (0 when no barge-in). */
  bargeInLatencyMs: number;
  /** 0..1 prosody naturalness (rate/pitch/volume fit). */
  prosodyNaturalness: number;
  /** 0..1 signal clarity (SNR-derived). */
  clarity: number;
  /** Barge-ins that were false positives in this turn. */
  falseBargeIns: number;
}

export type VoiceV23MosGrade = 'excellent' | 'good' | 'fair' | 'poor' | 'bad';

/** MOS-proxy result: a 1..5 score with its penalty breakdown. */
export interface VoiceV23MosResult {
  score: number;
  grade: VoiceV23MosGrade;
  penalties: {
    wer: number;
    latency: number;
    jitter: number;
    bargeIn: number;
    prosody: number;
    clarity: number;
    falseBargeIns: number;
  };
}

/** A labelled MOS sample used to calibrate the proxy. */
export interface VoiceV23MosSample {
  features: VoiceV23MosFeatures;
  /** Human-labelled MOS 1..5. */
  labelledMos: number;
}

/** One side of a baseline comparison (v22 numbers vs v23 numbers). */
export interface VoiceV23Baseline {
  version: string;
  meanWer: number;
  p95LatencyMs: number;
  meanMos: number;
  bargeInLatencyMs: number;
  evaluatedAtMs: number;
  pairs: number;
}

/** Delta between a baseline and the current run. Negative WER / latency is better. */
export interface VoiceV23BaselineDelta {
  werDelta: number;
  werDeltaPct: number;
  latencyDeltaMs: number;
  latencyDeltaPct: number;
  mosDelta: number;
  bargeInLatencyDeltaMs: number;
  /** True when any metric regressed past its tolerance. */
  regressed: boolean;
  regressions: string[];
  improved: string[];
}

/** Streaming frame (20 ms @ 16 kHz, PCM16) — same shape as v22 frames. */
export interface VoiceV23StreamFrame {
  seq: number;
  atMs: number;
  samples: Int16Array;
  energy?: number;
  echo?: boolean;
}

/** Endpointing state of one utterance. */
export type VoiceV23EndpointState = 'idle' | 'speech' | 'hangover' | 'ended';

/** Acoustic environment class, from the measured noise floor. */
export type VoiceV23Environment = 'quiet' | 'office' | 'noisy' | 'very-noisy';

/** Device kind a calibration preset belongs to. */
export type VoiceV23DeviceKind =
  | 'laptop'
  | 'desktop'
  | 'phone'
  | 'headset'
  | 'speaker'
  | 'car'
  | 'unknown';

/** Interruption resume strategy (extends the v22 disposition). */
export type VoiceV23InterruptStrategy = 'resume' | 'drop' | 'summarise' | 'rephrase';

/** Session-manager phase for one managed v22 session. */
export type VoiceV23ManagedPhase =
  | 'live'
  | 'reconnecting'
  | 'resuming'
  | 'handed-over'
  | 'closed'
  | 'failed';

export const VOICE_V23_FRAME_MS = 20;
export const VOICE_V23_FRAME_SAMPLES = 320;
export const VOICE_V23_SAMPLE_RATE = 16000;

/** Clamp a number into [min, max]; NaN becomes min. */
export function clampV23(value: number, min: number, max: number): number {
  return clampV22(value, min, max);
}

/** Round to 2 decimals for display (latency, rates). */
export function round2V23(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round to 4 decimals for display (rates, scores). */
export function round4V23(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Mean of a list (0 when empty). */
export function meanV23(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Percentile of a list (linear interpolation, 0 when empty). p in 0..100. */
export function percentileV23(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (clampV23(p, 0, 100) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * Word-level Levenshtein distance. Returns substitutions /
 * deletions / insertions separately so the caller can tell a
 * dropped word from a misheard one.
 */
export function levenshteinWordsV23(ref: readonly string[], hyp: readonly string[]): {
  distance: number;
  substitutions: number;
  deletions: number;
  insertions: number;
} {
  const n = ref.length;
  const m = hyp.length;
  // dp[i][j] = distance between ref[:i] and hyp[:j].
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) {
    dp.push(new Array<number>(m + 1).fill(0));
    dp[i][0] = i;
  }
  for (let j = 0; j <= m; j += 1) dp[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  // Walk back to split the distance into sub/del/ins.
  let i = n;
  let j = m;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1]) {
      i -= 1;
      j -= 1;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      deletions += 1;
      i -= 1;
    } else {
      insertions += 1;
      j -= 1;
    }
  }
  return { distance: dp[n][m], substitutions, deletions, insertions };
}

/** Score one reference/hypothesis pair: WER + edit breakdown. */
export function werV23(reference: string, hypothesis: string, werCeiling = 1): VoiceV23WerResult {
  const refWords = speechWordsV22(reference);
  const hypWords = speechWordsV22(hypothesis);
  if (refWords.length === 0) {
    return {
      wer: hypWords.length === 0 ? 0 : 1,
      substitutions: 0,
      deletions: 0,
      insertions: hypWords.length,
      refWords: 0,
      hypWords: hypWords.length,
      passes: hypWords.length === 0,
    };
  }
  const { substitutions, deletions, insertions } = levenshteinWordsV23(refWords, hypWords);
  const wer = (substitutions + deletions + insertions) / refWords.length;
  return {
    wer: round4V23(wer),
    substitutions,
    deletions,
    insertions,
    refWords: refWords.length,
    hypWords: hypWords.length,
    passes: wer <= werCeiling,
  };
}

/** Aggregate latency samples: mean / p50 / p95 / max + budget verdict. */
export function aggregateLatencyV23(
  samples: readonly VoiceV23LatencySample[],
  firstTokenBudgetMs = 800,
): VoiceV23LatencyAggregate {
  const first = samples.map((s) => s.firstTokenMs);
  const total = samples.map((s) => s.totalMs);
  const jitter = samples.map((s) => s.jitterMs);
  return {
    n: samples.length,
    meanFirstTokenMs: round2V23(meanV23(first)),
    p50FirstTokenMs: round2V23(percentileV23(first, 50)),
    p95FirstTokenMs: round2V23(percentileV23(first, 95)),
    maxFirstTokenMs: first.length === 0 ? 0 : Math.max(...first),
    meanTotalMs: round2V23(meanV23(total)),
    p95TotalMs: round2V23(percentileV23(total, 95)),
    meanJitterMs: round2V23(meanV23(jitter)),
    p95JitterMs: round2V23(percentileV23(jitter, 95)),
    overBudget: first.filter((v) => v > firstTokenBudgetMs).length,
  };
}
