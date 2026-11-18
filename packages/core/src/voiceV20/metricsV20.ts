/**
 * Voice eval + metrics v20 (voice v20, v1.28 Team T5).
 *
 * A realtime voice pipeline is only as good as its numbers, and the
 * numbers a mock can honestly produce are timing and decision
 * numbers: how fast the turn flips (speech-end → first TTS chunk),
 * how precisely barge-in cuts real interruptions without cutting
 * coughs, how much of the audio survives the jitter buffer, and how
 * long a session stays healthy. This module collects those events
 * as they happen (the pipeline feeds it; it never pulls) and
 * reduces them to percentiles, rates and one aggregate report.
 *
 * No audio quality scoring is faked here: MOS-style scores are
 * explicitly labelled *mock* and derived only from measurable
 * pipeline facts (gap rate, concealment rate, cut latency), never
 * presented as listening-test results. Pure bookkeeping, virtual
 * clock.
 */

export interface TurnLatencyV20Sample {
  turnId: string;
  speechEndMs: number;
  firstChunkMs: number;
  latencyMs: number;
}

export interface BargeInV20LabelledEvent {
  atMs: number;
  /** The engine's decision at the time. */
  decision: 'cut' | 'warn' | 'ignore';
  /** Ground truth supplied by the test harness (mock). */
  truth: 'interruption' | 'non-interruption';
}

export interface SessionHealthV20Sample {
  atMs: number;
  /** Frames released by the jitter buffer in this window. */
  released: number;
  /** Concealed frames in this window. */
  concealed: number;
  /** Gaps in this window. */
  gaps: number;
  /** Barge-in cuts in this window. */
  cuts: number;
  /** Errors in this window. */
  errors: number;
}

export interface PercentilesV20 {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  count: number;
}

/** Percentiles of a sample set. Empty input yields all zeros. */
export function percentilesV20(values: number[]): PercentilesV20 {
  if (values.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0, count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx];
  };
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    p50: at(0.5), p90: at(0.9), p95: at(0.95), p99: at(0.99),
    mean: Math.round(mean * 10) / 10,
    min: sorted[0], max: sorted[sorted.length - 1], count: sorted.length,
  };
}

export interface BargeInV20Scores {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** Warnings that correctly anticipated a real interruption. */
  warningHitRate: number;
}

/**
 * Precision / recall / F1 for barge-in decisions against labelled
 * ground truth. A 'warn' on a real interruption counts as a
 * warning hit (it did not cut, but it noticed); a 'warn' on a
 * non-interruption counts as a false positive only if it later
 * escalated — here it is recorded as a warning, not a cut.
 */
export function scoreBargeInDecisionsV20(events: BargeInV20LabelledEvent[]): BargeInV20Scores {
  let tp = 0; let fp = 0; let tn = 0; let fn = 0;
  let warnHits = 0; let warnTotal = 0;
  for (const e of events) {
    if (e.decision === 'cut') {
      if (e.truth === 'interruption') tp += 1; else fp += 1;
    } else if (e.decision === 'warn') {
      warnTotal += 1;
      if (e.truth === 'interruption') warnHits += 1;
      // A warning never cuts: it is neither a false positive cut
      // nor a missed cut — it stays out of the cut confusion matrix
      // except that a warned-then-missed interruption still counts
      // as a false negative if no later cut fired for it.
      if (e.truth === 'interruption') fn += 1; else tn += 1;
    } else {
      if (e.truth === 'interruption') fn += 1; else tn += 1;
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    warningHitRate: warnTotal === 0 ? 1 : Math.round((warnHits / warnTotal) * 1000) / 1000,
  };
}

export interface MockQualityV20 {
  /** 1..5, labelled mock: derived from gap/concealment rates only. */
  mockMos: number;
  /** Share of released frames that were concealed, 0..1. */
  concealmentRate: number;
  /** Gaps per minute of audio. */
  gapsPerMinute: number;
  /** Share of frames that arrived too late or duplicated, 0..1. */
  lossRate: number;
}

/**
 * Mock quality estimate. The formula is public and boring on
 * purpose: start at 4.5, lose up to 1.5 for concealment, up to 1.0
 * for gaps, up to 1.0 for loss, floor at 1.0. It is a *pipeline
 * health* number, not a listening score.
 */
export function mockQualityV20(
  released: number,
  concealed: number,
  gaps: number,
  lost: number,
  audioMinutes: number,
): MockQualityV20 {
  const total = Math.max(1, released + lost);
  const concealmentRate = concealed / total;
  const lossRate = lost / total;
  const gapsPerMinute = audioMinutes > 0 ? gaps / audioMinutes : gaps;
  let mos = 4.5;
  mos -= Math.min(1.5, concealmentRate * 15);
  mos -= Math.min(1.0, gapsPerMinute / 10);
  mos -= Math.min(1.0, lossRate * 10);
  mos = Math.max(1, Math.min(5, Math.round(mos * 10) / 10));
  return { mockMos: mos, concealmentRate: Math.round(concealmentRate * 1000) / 1000, gapsPerMinute: Math.round(gapsPerMinute * 10) / 10, lossRate: Math.round(lossRate * 1000) / 1000 };
}

export interface VoiceEvalV20Options {
  /** Max latency samples kept (oldest dropped). */
  maxLatencySamples: number;
  /** Max labelled barge-in events kept. */
  maxBargeInEvents: number;
  /** Max health windows kept. */
  maxHealthWindows: number;
  /** Latency above this (ms) counts as a slow turn. */
  slowTurnThresholdMs: number;
}

export function defaultVoiceEvalV20Options(): VoiceEvalV20Options {
  return {
    maxLatencySamples: 500,
    maxBargeInEvents: 500,
    maxHealthWindows: 120,
    slowTurnThresholdMs: 800,
  };
}

export function validateVoiceEvalV20Options(o: Partial<VoiceEvalV20Options>): string[] {
  const e: string[] = [];
  if (o.maxLatencySamples !== undefined && o.maxLatencySamples < 1) e.push('maxLatencySamples must be >= 1');
  if (o.maxBargeInEvents !== undefined && o.maxBargeInEvents < 1) e.push('maxBargeInEvents must be >= 1');
  if (o.maxHealthWindows !== undefined && o.maxHealthWindows < 1) e.push('maxHealthWindows must be >= 1');
  if (o.slowTurnThresholdMs !== undefined && o.slowTurnThresholdMs <= 0) e.push('slowTurnThresholdMs must be > 0');
  return e;
}

export interface VoiceEvalV20Report {
  turns: number;
  turnLatency: PercentilesV20;
  slowTurns: number;
  slowTurnRate: number;
  bargeIn: BargeInV20Scores;
  bargeInEvents: number;
  quality: MockQualityV20;
  totalReleased: number;
  totalConcealed: number;
  totalGaps: number;
  totalCuts: number;
  totalErrors: number;
  uptimeMs: number;
  /** Overall verdict from the numbers alone. */
  verdict: 'healthy' | 'degraded' | 'poor';
}

/**
 * The collector. The pipeline calls `noteTurnLatency`,
 * `noteBargeIn`, `noteHealthWindow` as events happen; `report()`
 * reduces everything. Windowed: old samples are dropped so a
 * long session's report reflects recent behaviour.
 */
export class VoiceEvalV20 {
  private opts: VoiceEvalV20Options;
  private latencies: TurnLatencyV20Sample[] = [];
  private bargeInEvents: BargeInV20LabelledEvent[] = [];
  private healthWindows: SessionHealthV20Sample[] = [];
  private startedAtMs: number | null = null;
  private lastAtMs: number | null = null;
  private slowTurns = 0;

  constructor(opts: Partial<VoiceEvalV20Options> = {}) {
    this.opts = { ...defaultVoiceEvalV20Options(), ...opts };
  }

  get options(): VoiceEvalV20Options { return { ...this.opts }; }

  get turnCount(): number { return this.latencies.length; }
  get bargeInEventCount(): number { return this.bargeInEvents.length; }

  noteTurnLatency(turnId: string, speechEndMs: number, firstChunkMs: number): void {
    const latencyMs = Math.max(0, firstChunkMs - speechEndMs);
    if (this.startedAtMs === null) this.startedAtMs = speechEndMs;
    this.lastAtMs = firstChunkMs;
    this.latencies.push({ turnId, speechEndMs, firstChunkMs, latencyMs });
    if (latencyMs > this.opts.slowTurnThresholdMs) this.slowTurns += 1;
    if (this.latencies.length > this.opts.maxLatencySamples) this.latencies.shift();
  }

  noteBargeIn(e: BargeInV20LabelledEvent): void {
    if (this.startedAtMs === null) this.startedAtMs = e.atMs;
    this.lastAtMs = e.atMs;
    this.bargeInEvents.push({ ...e });
    if (this.bargeInEvents.length > this.opts.maxBargeInEvents) this.bargeInEvents.shift();
  }

  noteHealthWindow(w: SessionHealthV20Sample): void {
    if (this.startedAtMs === null) this.startedAtMs = w.atMs;
    this.lastAtMs = w.atMs;
    this.healthWindows.push({ ...w });
    if (this.healthWindows.length > this.opts.maxHealthWindows) this.healthWindows.shift();
  }

  /** Latency percentiles over the kept samples. */
  latencyPercentiles(): PercentilesV20 {
    return percentilesV20(this.latencies.map((l) => l.latencyMs));
  }

  bargeInScores(): BargeInV20Scores {
    return scoreBargeInDecisionsV20(this.bargeInEvents);
  }

  totals(): { released: number; concealed: number; gaps: number; cuts: number; errors: number } {
    let released = 0; let concealed = 0; let gaps = 0; let cuts = 0; let errors = 0;
    for (const w of this.healthWindows) {
      released += w.released;
      concealed += w.concealed;
      gaps += w.gaps;
      cuts += w.cuts;
      errors += w.errors;
    }
    return { released, concealed, gaps, cuts, errors };
  }

  report(): VoiceEvalV20Report {
    const t = this.totals();
    const latency = this.latencyPercentiles();
    const bargeIn = this.bargeInScores();
    const uptimeMs = this.startedAtMs !== null && this.lastAtMs !== null
      ? Math.max(0, this.lastAtMs - this.startedAtMs) : 0;
    const audioMinutes = Math.max(1 / 60, uptimeMs / 60000);
    const quality = mockQualityV20(t.released, t.concealed, t.gaps, t.concealed, audioMinutes);
    const slowTurnRate = this.latencies.length === 0 ? 0
      : Math.round((this.slowTurns / this.latencies.length) * 1000) / 1000;
    let verdict: VoiceEvalV20Report['verdict'] = 'healthy';
    if (quality.mockMos < 3 || slowTurnRate > 0.25 || bargeIn.f1 < 0.6) verdict = 'poor';
    else if (quality.mockMos < 4 || slowTurnRate > 0.1 || bargeIn.f1 < 0.8) verdict = 'degraded';
    return {
      turns: this.latencies.length,
      turnLatency: latency,
      slowTurns: this.slowTurns,
      slowTurnRate,
      bargeIn,
      bargeInEvents: this.bargeInEvents.length,
      quality,
      totalReleased: t.released,
      totalConcealed: t.concealed,
      totalGaps: t.gaps,
      totalCuts: t.cuts,
      totalErrors: t.errors,
      uptimeMs,
      verdict,
    };
  }

  /** One-line verdict for logs. */
  summary(): string {
    const r = this.report();
    return `Eval v20: ${r.verdict} — ${r.turns} turns, p50 ${r.turnLatency.p50}ms / p90 ${r.turnLatency.p90}ms, ` +
      `barge-in F1 ${r.bargeIn.f1}, mock MOS ${r.quality.mockMos}, ${r.totalGaps} gaps, ${r.totalErrors} errors`;
  }

  reset(): void {
    this.latencies = [];
    this.bargeInEvents = [];
    this.healthWindows = [];
    this.startedAtMs = null;
    this.lastAtMs = null;
    this.slowTurns = 0;
  }
}

export function createVoiceEvalV20(opts: Partial<VoiceEvalV20Options> = {}): VoiceEvalV20 {
  return new VoiceEvalV20(opts);
}

export function voiceEvalV20Markdown(v: VoiceEvalV20): string {
  const r = v.report();
  return `# Voice Eval v20\n\n` +
    `- Verdict: ${r.verdict}\n` +
    `- Turns: ${r.turns} (slow: ${r.slowTurns}, rate ${r.slowTurnRate})\n` +
    `- Turn latency: p50 ${r.turnLatency.p50}ms, p90 ${r.turnLatency.p90}ms, p95 ${r.turnLatency.p95}ms, mean ${r.turnLatency.mean}ms\n` +
    `- Barge-in: P ${r.bargeIn.precision}, R ${r.bargeIn.recall}, F1 ${r.bargeIn.f1} ` +
    `(TP ${r.bargeIn.truePositives}, FP ${r.bargeIn.falsePositives}, FN ${r.bargeIn.falseNegatives})\n` +
    `- Mock MOS: ${r.quality.mockMos} (concealment ${r.quality.concealmentRate}, gaps/min ${r.quality.gapsPerMinute})\n` +
    `- Released: ${r.totalReleased}, concealed: ${r.totalConcealed}, gaps: ${r.totalGaps}, cuts: ${r.totalCuts}, errors: ${r.totalErrors}\n` +
    `- Uptime: ${r.uptimeMs}ms\n`;
}
