/**
 * MOS-proxy estimator for voice v23 (v1.36, Team T5).
 *
 * A real MOS needs human listeners; the proxy is the honest
 * substitute used everywhere else in this repo (mock, offline,
 * deterministic): a 1..5 score built from measurable features
 * — WER, first-audio latency, jitter, barge-in latency,
 * prosody naturalness, signal clarity, false barge-ins — with
 * every penalty visible in the breakdown so a bad score can
 * be traced to its cause instead of argued about.
 *
 * The weights are calibrated against the labelled cases in
 * the v23 corpus (see `calibrateMosV23`): the intercept shift
 * is fitted so the mean signed error on the corpus is ~0.
 * The proxy is labelled "proxy" in every summary/markdown —
 * it never pretends to be a human MOS.
 */
import type { VoiceV23MosFeatures, VoiceV23MosGrade, VoiceV23MosResult, VoiceV23MosSample } from './types';
import { clampV23, meanV23, round2V23 } from './types';

export interface VoiceV23MosOptions {
  /** Starting score before penalties (default 5). */
  baseScore: number;
  /** WER penalty weight: score lost per 1.0 WER (default 3.0). */
  werWeight: number;
  /** Latency penalty: score lost per 1000 ms over the free allowance (default 0.8). */
  latencyWeight: number;
  /** Latency allowance with no penalty, ms (default 400). */
  latencyFreeMs: number;
  /** Jitter penalty: score lost per 100 ms of jitter (default 0.5). */
  jitterWeight: number;
  /** Barge-in latency penalty: score lost per 1000 ms (default 0.6). */
  bargeInWeight: number;
  /** Prosody penalty weight (default 0.8). */
  prosodyWeight: number;
  /** Clarity penalty weight (default 0.8). */
  clarityWeight: number;
  /** Score lost per false barge-in (default 0.25). */
  falseBargeInPenalty: number;
  /** Fitted intercept shift from calibration (default 0). */
  interceptShift: number;
}

export function defaultMosV23Options(): VoiceV23MosOptions {
  return {
    baseScore: 5,
    werWeight: 2.0,
    latencyWeight: 0.5,
    latencyFreeMs: 400,
    jitterWeight: 0.3,
    bargeInWeight: 0.4,
    prosodyWeight: 0.6,
    clarityWeight: 0.6,
    falseBargeInPenalty: 0.2,
    interceptShift: 0,
  };
}

export function validateMosV23Options(o: Partial<VoiceV23MosOptions>): string[] {
  const errors: string[] = [];
  const check = (name: keyof VoiceV23MosOptions, min: number, max: number): void => {
    const v = o[name];
    if (v !== undefined && !(v >= min && v <= max)) errors.push(`${name} must be ${min}..${max}`);
  };
  check('baseScore', 1, 5);
  check('werWeight', 0, 10);
  check('latencyWeight', 0, 5);
  check('latencyFreeMs', 0, 5000);
  check('jitterWeight', 0, 5);
  check('bargeInWeight', 0, 5);
  check('prosodyWeight', 0, 5);
  check('clarityWeight', 0, 5);
  check('falseBargeInPenalty', 0, 2);
  check('interceptShift', -2, 2);
  return errors;
}

export function mosGradeV23(score: number): VoiceV23MosGrade {
  if (score >= 4.5) return 'excellent';
  if (score >= 4.0) return 'good';
  if (score >= 3.0) return 'fair';
  if (score >= 2.0) return 'poor';
  return 'bad';
}

/** Estimate a MOS-proxy score from measured features. */
export function mosProxyV23(
  features: VoiceV23MosFeatures,
  opts: Partial<VoiceV23MosOptions> = {},
): VoiceV23MosResult {
  const o = { ...defaultMosV23Options(), ...opts };
  const wer = clampV23(features.wer, 0, 1);
  const latencyMs = Math.max(0, features.latencyMs);
  const jitterMs = Math.max(0, features.jitterMs);
  const bargeInMs = Math.max(0, features.bargeInLatencyMs);
  const prosody = clampV23(features.prosodyNaturalness, 0, 1);
  const clarity = clampV23(features.clarity, 0, 1);
  const falseBargeIns = Math.max(0, Math.floor(features.falseBargeIns));
  const penalties = {
    wer: round2V23(o.werWeight * wer),
    latency: round2V23((o.latencyWeight * Math.max(0, latencyMs - o.latencyFreeMs)) / 1000),
    jitter: round2V23((o.jitterWeight * jitterMs) / 100),
    bargeIn: round2V23((o.bargeInWeight * bargeInMs) / 1000),
    prosody: round2V23(o.prosodyWeight * (1 - prosody)),
    clarity: round2V23(o.clarityWeight * (1 - clarity)),
    falseBargeIns: round2V23(o.falseBargeInPenalty * falseBargeIns),
  };
  const total = Object.values(penalties).reduce((a, b) => a + b, 0);
  const score = round2V23(clampV23(o.baseScore - total + o.interceptShift, 1, 5));
  return { score, grade: mosGradeV23(score), penalties };
}

/** Mean absolute error of the proxy against labelled samples. */
export function mosProxyErrorV23(
  samples: readonly VoiceV23MosSample[],
  opts: Partial<VoiceV23MosOptions> = {},
): { meanAbsoluteError: number; meanSignedError: number; worst: number; n: number } {
  if (samples.length === 0) return { meanAbsoluteError: 0, meanSignedError: 0, worst: 0, n: 0 };
  const errors = samples.map((s) => mosProxyV23(s.features, opts).score - s.labelledMos);
  const abs = errors.map((e) => Math.abs(e));
  return {
    meanAbsoluteError: round2V23(meanV23(abs)),
    meanSignedError: round2V23(meanV23(errors)),
    worst: round2V23(Math.max(...abs)),
    n: samples.length,
  };
}

/**
 * Fit the intercept shift so the proxy is unbiased on the
 * labelled samples: shift = -mean(signed error). Returns new
 * options carrying the fitted shift (weights untouched).
 */
export function calibrateMosV23(
  samples: readonly VoiceV23MosSample[],
  opts: Partial<VoiceV23MosOptions> = {},
): { options: VoiceV23MosOptions; before: ReturnType<typeof mosProxyErrorV23>; after: ReturnType<typeof mosProxyErrorV23> } {
  const base = { ...defaultMosV23Options(), ...opts, interceptShift: 0 };
  const before = mosProxyErrorV23(samples, base);
  const shift = round2V23(clampV23(-before.meanSignedError, -2, 2));
  const options = { ...base, interceptShift: shift };
  const after = mosProxyErrorV23(samples, options);
  return { options, before, after };
}

/** One-line human summary of a MOS-proxy result (labelled as proxy). */
export function mosProxyV23Summary(result: VoiceV23MosResult): string {
  return `MOS-proxy ${result.score.toFixed(2)}/5 (${result.grade}; proxy, not human MOS)`;
}

export function mosProxyV23Markdown(result: VoiceV23MosResult, label = 'voice v23 MOS-proxy'): string {
  const p = result.penalties;
  return [
    `## ${label}`,
    '',
    `- Score (proxy): **${result.score.toFixed(2)} / 5** — ${result.grade}`,
    `- Penalties: WER ${p.wer}, latency ${p.latency}, jitter ${p.jitter}, barge-in ${p.bargeIn}, prosody ${p.prosody}, clarity ${p.clarity}, false barge-ins ${p.falseBargeIns}`,
    '',
    '> Proxy estimate from measured features, not a human MOS.',
    '',
  ].join('\n');
}
