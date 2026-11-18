/**
 * Voice quality trend for voice v23 (v1.36, Team T5).
 *
 * One quality score is a snapshot; a trend is the story.
 * This module records quality scores over time (from the
 * monitor tool's `quality` action or any caller) and
 * answers: is voice getting better or worse, which
 * sub-score is dragging the average down, and what the
 * rolling mean is over the recent window.
 *
 * Trend is a least-squares slope over (time, total) in
 * points per minute: > +1 improving, < -1 degrading,
 * otherwise stable. Two points are the minimum for a
 * trend; fewer than that, the trend is `unknown`.
 * Points are capped (default 1000, oldest dropped first)
 * so a long-lived process cannot grow the history
 * without bound.
 */
import type { VoiceV23QualityScore, VoiceV23QualitySubscores } from './qualityReportV23';
import { clampV23, round2V23 } from './types';

export interface VoiceV23QualityPoint {
  atMs: number;
  total: number;
  grade: string;
  subscores: VoiceV23QualitySubscores;
}

export interface QualityTrendV23Options {
  /** Maximum points kept (default 1000). */
  maxPoints: number;
  /** Points-per-minute slope above which the trend counts as improving (default 1). */
  improvePerMinute: number;
  /** Points-per-minute slope below which the trend counts as degrading (default -1). */
  degradePerMinute: number;
}

export function defaultQualityTrendV23Options(): QualityTrendV23Options {
  return { maxPoints: 1000, improvePerMinute: 1, degradePerMinute: -1 };
}

export function validateQualityTrendV23Options(o: Partial<QualityTrendV23Options>): string[] {
  const errors: string[] = [];
  if (o.maxPoints !== undefined && !(Number.isInteger(o.maxPoints) && o.maxPoints >= 2 && o.maxPoints <= 100000)) {
    errors.push('maxPoints must be an integer 2..100000');
  }
  if (o.improvePerMinute !== undefined && !(o.improvePerMinute > 0 && o.improvePerMinute <= 100)) {
    errors.push('improvePerMinute must be 0..100');
  }
  if (o.degradePerMinute !== undefined && !(o.degradePerMinute < 0 && o.degradePerMinute >= -100)) {
    errors.push('degradePerMinute must be -100..0');
  }
  return errors;
}

export type VoiceV23QualityTrend = 'improving' | 'stable' | 'degrading' | 'unknown';

/**
 * Least-squares slope of total vs time, in points per minute.
 * Returns null when fewer than 2 points or all times equal.
 */
export function trendSlopePerMinuteV23(points: VoiceV23QualityPoint[]): number | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.atMs - b.atMs);
  const n = sorted.length;
  const meanX = sorted.reduce((a, p) => a + p.atMs, 0) / n;
  const meanY = sorted.reduce((a, p) => a + p.total, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of sorted) {
    num += (p.atMs - meanX) * (p.total - meanY);
    den += (p.atMs - meanX) ** 2;
  }
  if (den === 0) return null;
  return round2V23((num / den) * 60000);
}

export function qualityTrendV23(
  points: VoiceV23QualityPoint[],
  opts: Partial<QualityTrendV23Options> = {},
): VoiceV23QualityTrend {
  const slope = trendSlopePerMinuteV23(points);
  if (slope === null) return 'unknown';
  const o = { ...defaultQualityTrendV23Options(), ...opts };
  if (slope > o.improvePerMinute) return 'improving';
  if (slope < o.degradePerMinute) return 'degrading';
  return 'stable';
}

/** Mean of each sub-score across the points (null when empty). */
export function meanSubscoresV23(points: VoiceV23QualityPoint[]): VoiceV23QualitySubscores | null {
  if (points.length === 0) return null;
  const keys = ['wer', 'latency', 'mos', 'streaming', 'interruptions', 'calibration'] as const;
  const out = {} as VoiceV23QualitySubscores;
  for (const k of keys) {
    out[k] = round2V23(points.reduce((a, p) => a + p.subscores[k], 0) / points.length);
  }
  return out;
}

export function worstSubscoreV23(points: VoiceV23QualityPoint[]): { name: keyof VoiceV23QualitySubscores; mean: number } | null {
  const means = meanSubscoresV23(points);
  if (means === null) return null;
  let worst: keyof VoiceV23QualitySubscores = 'wer';
  for (const k of Object.keys(means) as (keyof VoiceV23QualitySubscores)[]) {
    if (means[k] < means[worst]) worst = k;
  }
  return { name: worst, mean: means[worst] };
}

export class QualityTrendV23 {
  private readonly opts: QualityTrendV23Options;
  private points: VoiceV23QualityPoint[] = [];

  constructor(opts: Partial<QualityTrendV23Options> = {}) {
    const errors = validateQualityTrendV23Options(opts);
    if (errors.length > 0) throw new Error(`Invalid QualityTrendV23 options: ${errors.join('; ')}`);
    this.opts = { ...defaultQualityTrendV23Options(), ...opts };
  }

  options(): QualityTrendV23Options {
    return { ...this.opts };
  }

  record(score: VoiceV23QualityScore, atMs: number): VoiceV23QualityPoint {
    const point: VoiceV23QualityPoint = {
      atMs,
      total: score.total,
      grade: score.grade,
      subscores: { ...score.subscores },
    };
    this.points.push(point);
    while (this.points.length > this.opts.maxPoints) this.points.shift();
    return { ...point, subscores: { ...point.subscores } };
  }

  count(): number {
    return this.points.length;
  }

  history(): VoiceV23QualityPoint[] {
    return this.points.map((p) => ({ ...p, subscores: { ...p.subscores } }));
  }

  clear(): void {
    this.points = [];
  }

  latest(): VoiceV23QualityPoint | null {
    if (this.points.length === 0) return null;
    const p = this.points[this.points.length - 1];
    return { ...p, subscores: { ...p.subscores } };
  }

  slopePerMinute(): number | null {
    return trendSlopePerMinuteV23(this.points);
  }

  trend(): VoiceV23QualityTrend {
    return qualityTrendV23(this.points, this.opts);
  }

  meanTotal(): number | null {
    if (this.points.length === 0) return null;
    return round2V23(this.points.reduce((a, p) => a + p.total, 0) / this.points.length);
  }

  rollingMean(n: number): number | null {
    if (this.points.length === 0 || n <= 0) return null;
    const tail = this.points.slice(-n);
    return round2V23(tail.reduce((a, p) => a + p.total, 0) / tail.length);
  }

  bestTotal(): number | null {
    if (this.points.length === 0) return null;
    return Math.max(...this.points.map((p) => p.total));
  }

  worstTotal(): number | null {
    if (this.points.length === 0) return null;
    return Math.min(...this.points.map((p) => p.total));
  }

  meanSubscores(): VoiceV23QualitySubscores | null {
    return meanSubscoresV23(this.points);
  }

  worstSubscore(): { name: keyof VoiceV23QualitySubscores; mean: number } | null {
    return worstSubscoreV23(this.points);
  }

  /** Points per minute of the recording window (null when < 2 points). */
  coverageMinutes(): number | null {
    if (this.points.length < 2) return null;
    const sorted = [...this.points].sort((a, b) => a.atMs - b.atMs);
    return round2V23((sorted[sorted.length - 1].atMs - sorted[0].atMs) / 60000);
  }

  summary(): string {
    if (this.points.length === 0) return 'voice quality trend: no scores recorded yet';
    const mean = this.meanTotal();
    const worst = this.worstSubscore();
    const trend = this.trend();
    const slope = this.slopePerMinute();
    const worstPart = worst === null ? '' : `, weakest sub-score ${worst.name} (${worst.mean})`;
    const slopePart = slope === null ? '' : ` (${slope > 0 ? '+' : ''}${slope}/min)`;
    return `voice quality trend: ${this.points.length} score(s), mean ${mean}/100, ${trend}${slopePart}${worstPart}`;
  }

  markdown(): string {
    const lines = ['# Voice v23 quality trend', ''];
    if (this.points.length === 0) {
      lines.push('No quality scores recorded yet.');
      return lines.join('\n');
    }
    lines.push(`- Scores: ${this.points.length}`);
    lines.push(`- Mean: ${this.meanTotal()}/100 · best ${this.bestTotal()} · worst ${this.worstTotal()}`);
    lines.push(`- Trend: ${this.trend()} (${this.slopePerMinute() ?? 'n/a'} points/min)`);
    const worst = this.worstSubscore();
    if (worst !== null) lines.push(`- Weakest sub-score: ${worst.name} (mean ${worst.mean})`);
    const means = this.meanSubscores();
    if (means !== null) {
      lines.push(`- Mean sub-scores: WER ${means.wer} · latency ${means.latency} · MOS ${means.mos} · streaming ${means.streaming} · interruptions ${means.interruptions} · calibration ${means.calibration}`);
    }
    lines.push('');
    lines.push('## Recent scores');
    for (const p of this.points.slice(-10)) {
      lines.push(`- ${p.atMs}ms: ${p.total}/100 (grade ${p.grade})`);
    }
    return lines.join('\n');
  }
}

export function createQualityTrendV23(opts: Partial<QualityTrendV23Options> = {}): QualityTrendV23 {
  return new QualityTrendV23(opts);
}

export function qualityTrendV23Summary(trend: QualityTrendV23): string {
  return trend.summary();
}
