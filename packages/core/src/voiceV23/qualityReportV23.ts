/**
 * Voice quality report for voice v23 (v1.36, Team T5).
 *
 * The eval harness answers "how good is the transcript?",
 * the panel answers "what is happening now?". The quality
 * report answers "how healthy is voice overall?" — one
 * 0..100 score with a grade, built from everything v23
 * measures, with every sub-score visible so a bad total can
 * be traced to its cause:
 *
 *   - WER (25%): mean WER against the harness budget;
 *   - latency (25%): p95 first-token against its budget;
 *   - MOS-proxy (20%): mean proxy mapped 1..5 -> 0..100;
 *   - streaming (10%): buffer underruns / overruns / jitter;
 *   - interruptions (10%): false positives + stop latency;
 *   - calibration (10%): confidence when calibrated, 50
 *     ("unknown") when no calibration has ever run.
 *
 * Grades: A >= 90, B >= 80, C >= 70, D >= 60, else F.
 * Every sub-score below 70 produces a recommendation in
 * plain language, so the report is actionable, not just a
 * number. The score is a weighted mean of measured inputs —
 * it is labelled a health score, never a MOS.
 */
import type { EvalHarnessV23Report } from './evalHarnessV23';
import type { VoiceV23BufferStats } from './streamingV23';
import type { VoiceV23InterruptionStats } from './interruptionV23';
import type { VoiceV23SessionManagerStats } from './sessionManagerV23';
import type { VoiceV23CalibrationResult } from './calibrationV23';
import { clampV23, round2V23 } from './types';

export interface VoiceV23QualityOptions {
  /** WER budget the WER sub-score is measured against (default 0.15). */
  werBudget: number;
  /** p95 first-token budget, ms (default 800). */
  latencyBudgetMs: number;
  /** Weight of each sub-score; must sum to 1 (defaults below). */
  weights: {
    wer: number;
    latency: number;
    mos: number;
    streaming: number;
    interruptions: number;
    calibration: number;
  };
}

export function defaultQualityV23Options(): VoiceV23QualityOptions {
  return {
    werBudget: 0.15,
    latencyBudgetMs: 800,
    weights: { wer: 0.25, latency: 0.25, mos: 0.2, streaming: 0.1, interruptions: 0.1, calibration: 0.1 },
  };
}

export function validateQualityV23Options(o: Partial<VoiceV23QualityOptions>): string[] {
  const errors: string[] = [];
  if (o.werBudget !== undefined && !(o.werBudget > 0 && o.werBudget <= 1)) errors.push('werBudget must be 0..1');
  if (o.latencyBudgetMs !== undefined && !(o.latencyBudgetMs > 0 && o.latencyBudgetMs <= 10000)) {
    errors.push('latencyBudgetMs must be 0..10000');
  }
  if (o.weights !== undefined) {
    for (const [k, v] of Object.entries(o.weights)) {
      if (!(v >= 0 && v <= 1)) errors.push(`weights.${k} must be 0..1`);
    }
    const sum = Object.values(o.weights).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.001) errors.push(`weights must sum to 1 (got ${sum})`);
  }
  return errors;
}

export type VoiceV23QualityGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export function qualityGradeV23(total: number): VoiceV23QualityGrade {
  if (total >= 90) return 'A';
  if (total >= 80) return 'B';
  if (total >= 70) return 'C';
  if (total >= 60) return 'D';
  return 'F';
}

export interface VoiceV23QualitySubscores {
  wer: number;
  latency: number;
  mos: number;
  streaming: number;
  interruptions: number;
  calibration: number;
}

export interface VoiceV23QualityScore {
  total: number;
  grade: VoiceV23QualityGrade;
  subscores: VoiceV23QualitySubscores;
  recommendations: string[];
}

export interface VoiceV23QualityInputs {
  eval: EvalHarnessV23Report | null;
  streaming: VoiceV23BufferStats | null;
  interruptions: VoiceV23InterruptionStats | null;
  sessions: VoiceV23SessionManagerStats | null;
  calibration: VoiceV23CalibrationResult | null;
}

/** WER sub-score: 100 at 0 WER, 0 at or above the budget. */
export function werSubscoreV23(meanWer: number, werBudget = 0.15): number {
  return round2V23(clampV23(100 * (1 - meanWer / Math.max(0.001, werBudget)), 0, 100));
}

/** Latency sub-score: 100 at 0 ms, 0 at or above the budget. */
export function latencySubscoreV23(p95FirstTokenMs: number, latencyBudgetMs = 800): number {
  return round2V23(clampV23(100 * (1 - p95FirstTokenMs / Math.max(1, latencyBudgetMs)), 0, 100));
}

/** MOS-proxy sub-score: 1..5 mapped linearly to 0..100. */
export function mosSubscoreV23(meanMos: number): number {
  return round2V23(clampV23(((meanMos - 1) / 4) * 100, 0, 100));
}

/** Streaming sub-score: underruns/overruns/jitter eat the score. */
export function streamingSubscoreV23(stats: VoiceV23BufferStats): number {
  const penalty = stats.underruns * 8 + stats.overruns * 4 + Math.min(20, stats.jitterP95Ms / 2);
  return round2V23(clampV23(100 - penalty, 0, 100));
}

/** Interruption sub-score: false positives + slow stops eat the score. */
export function interruptionSubscoreV23(stats: VoiceV23InterruptionStats): number {
  const falsePenalty = stats.falsePositives * 10;
  const stopPenalty = Math.min(30, stats.meanStopLatencyMs / 20);
  return round2V23(clampV23(100 - falsePenalty - stopPenalty, 0, 100));
}

/** Calibration sub-score: confidence when calibrated, 50 when unknown. */
export function calibrationSubscoreV23(result: VoiceV23CalibrationResult | null): number {
  if (result === null) return 50;
  return round2V23(clampV23(result.confidence * 100, 0, 100));
}

/** Score quality from measured inputs (missing inputs score neutral). */
export function scoreQualityV23(
  inputs: VoiceV23QualityInputs,
  opts: Partial<VoiceV23QualityOptions> = {},
): VoiceV23QualityScore {
  const o = {
    ...defaultQualityV23Options(),
    ...opts,
    weights: { ...defaultQualityV23Options().weights, ...(opts.weights ?? {}) },
  };
  const subscores: VoiceV23QualitySubscores = {
    wer: inputs.eval === null ? 50 : werSubscoreV23(inputs.eval.transcript.meanWer, o.werBudget),
    latency: inputs.eval === null ? 50 : latencySubscoreV23(inputs.eval.latency.p95FirstTokenMs, o.latencyBudgetMs),
    mos: inputs.eval === null ? 50 : mosSubscoreV23(inputs.eval.mos.meanMos),
    streaming: inputs.streaming === null ? 50 : streamingSubscoreV23(inputs.streaming),
    interruptions: inputs.interruptions === null ? 50 : interruptionSubscoreV23(inputs.interruptions),
    calibration: calibrationSubscoreV23(inputs.calibration),
  };
  const w = o.weights;
  const total = round2V23(
    subscores.wer * w.wer +
      subscores.latency * w.latency +
      subscores.mos * w.mos +
      subscores.streaming * w.streaming +
      subscores.interruptions * w.interruptions +
      subscores.calibration * w.calibration,
  );
  const recommendations: string[] = [];
  if (subscores.wer < 70) recommendations.push(`WER ${inputs.eval?.transcript.meanWer} is close to the ${o.werBudget} budget — check the noisy / far-field pairs in the eval report`);
  if (subscores.latency < 70) recommendations.push(`p95 first-token ${inputs.eval?.latency.p95FirstTokenMs}ms is close to the ${o.latencyBudgetMs}ms budget — grow the adaptive buffer target or check the provider`);
  if (subscores.mos < 70) recommendations.push(`mean MOS-proxy ${inputs.eval?.mos.meanMos} is low — look at the MOS penalty breakdown for the biggest cost`);
  if (subscores.streaming < 70) recommendations.push(`streaming is unhealthy (${inputs.streaming?.underruns} underruns, ${inputs.streaming?.overruns} overruns) — raise the minimum buffer target`);
  if (subscores.interruptions < 70) recommendations.push(`${inputs.interruptions?.falsePositives} false-positive interruption(s) — raise the grace window or the interrupt threshold`);
  if (subscores.calibration < 70) recommendations.push('no fresh calibration — run voice_v23_calibrate with room-noise + speech samples for this device');
  if (inputs.sessions !== null && inputs.sessions.failed > 0) recommendations.push(`${inputs.sessions.failed} managed session(s) failed — check the reconnect schedule and the resume tokens`);
  return { total, grade: qualityGradeV23(total), subscores, recommendations };
}

export class QualityReportV23 {
  private readonly opts: VoiceV23QualityOptions;
  private inputs: VoiceV23QualityInputs = {
    eval: null,
    streaming: null,
    interruptions: null,
    sessions: null,
    calibration: null,
  };
  private updatedAtMs = 0;

  constructor(opts: Partial<VoiceV23QualityOptions> = {}) {
    const errors = validateQualityV23Options(opts);
    if (errors.length > 0) throw new Error(`Invalid QualityV23 options: ${errors.join('; ')}`);
    this.opts = {
      ...defaultQualityV23Options(),
      ...opts,
      weights: { ...defaultQualityV23Options().weights, ...(opts.weights ?? {}) },
    };
  }

  options(): VoiceV23QualityOptions {
    return { ...this.opts, weights: { ...this.opts.weights } };
  }

  setEval(report: EvalHarnessV23Report, atMs: number): void {
    this.inputs.eval = report;
    this.updatedAtMs = atMs;
  }

  setStreaming(stats: VoiceV23BufferStats, atMs: number): void {
    this.inputs.streaming = { ...stats };
    this.updatedAtMs = atMs;
  }

  setInterruptions(stats: VoiceV23InterruptionStats, atMs: number): void {
    this.inputs.interruptions = { ...stats };
    this.updatedAtMs = atMs;
  }

  setSessions(stats: VoiceV23SessionManagerStats, atMs: number): void {
    this.inputs.sessions = { ...stats };
    this.updatedAtMs = atMs;
  }

  setCalibration(result: VoiceV23CalibrationResult, atMs: number): void {
    this.inputs.calibration = { ...result };
    this.updatedAtMs = atMs;
  }

  score(): VoiceV23QualityScore {
    return scoreQualityV23(this.inputs, this.opts);
  }

  markdown(atMs: number): string {
    const s = this.score();
    const lines = [
      '# Voice v23 quality report',
      '',
      `- Health score: **${s.total} / 100** — grade ${s.grade}`,
      `- WER ${s.subscores.wer} · latency ${s.subscores.latency} · MOS-proxy ${s.subscores.mos} · streaming ${s.subscores.streaming} · interruptions ${s.subscores.interruptions} · calibration ${s.subscores.calibration}`,
    ];
    if (s.recommendations.length === 0) lines.push('- Recommendations: none — voice is healthy');
    else for (const r of s.recommendations) lines.push(`- Recommendation: ${r}`);
    lines.push('');
    void atMs;
    return lines.join('\n');
  }

  summary(): string {
    const s = this.score();
    return `voice v23 quality: ${s.total}/100 (grade ${s.grade}), ${s.recommendations.length} recommendation(s)`;
  }

  updatedAt(): number {
    return this.updatedAtMs;
  }
}

export function createQualityReportV23(opts: Partial<VoiceV23QualityOptions> = {}): QualityReportV23 {
  return new QualityReportV23(opts);
}

export function qualityV23Summary(score: VoiceV23QualityScore): string {
  return `voice quality ${score.total}/100 (grade ${score.grade})`;
}
