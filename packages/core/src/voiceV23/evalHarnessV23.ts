/**
 * Extended eval harness for voice v23 (v1.36, Team T5).
 *
 * v20's harness scored transcripts/prosody and drove scripted
 * dialogues; v23 runs the whole expanded corpus in one place
 * and answers the question the task asks for: is v23 actually
 * better than v22, and by how much on each axis?
 *
 *   - runPair / runTranscriptCorpus: WER per pair, per locale,
 *     per condition, with ceiling verdicts;
 *   - runLatencySuite: mean / p50 / p95 / max first-token and
 *     total latency, jitter, over-budget count;
 *   - runMosSuite: MOS-proxy per labelled case + proxy error
 *     (MAE / signed / worst) against the human labels;
 *   - runInterruptionSuite / runEndpointSuite: policy accuracy
 *     against the corpus ground truth (delegates the policy to
 *     the caller's scorer so the harness stays engine-free);
 *   - compareWithBaselineV23: v22 numbers vs v23 numbers with
 *     per-metric deltas and a regression list past tolerance.
 *
 * Everything is pure computation over supplied data — no
 * audio, no network, no clock. Engines are scored through
 * callbacks so the harness never imports them.
 */
import type {
  VoiceV23Baseline,
  VoiceV23BaselineDelta,
  VoiceV23Condition,
  VoiceV23EvalPair,
  VoiceV23LatencyAggregate,
  VoiceV23LatencySample,
  VoiceV23MosSample,
  VoiceV23WerResult,
} from './types';
import { aggregateLatencyV23, meanV23, percentileV23, round2V23, round4V23, werV23 } from './types';
import {
  EVAL_CORPUS_V23_INTERRUPTIONS,
  EVAL_CORPUS_V23_LATENCY,
  EVAL_CORPUS_V23_MOS,
  EVAL_CORPUS_V23_TRANSCRIPTS,
  type VoiceV23EndpointCase,
  type VoiceV23InterruptionCase,
} from './evalCorpusV23';
import { EVAL_CORPUS_V23_ENDPOINTS } from './evalCorpusV23';
import { mosProxyErrorV23, mosProxyV23 } from './mosProxyV23';

export interface EvalHarnessV23Options {
  /** WER budget for the corpus mean (default 0.15). */
  werBudget: number;
  /** First-token latency budget, ms (default 800). */
  latencyBudgetMs: number;
  /** MOS-proxy floor for the corpus mean (default 3.0 = "fair"). */
  mosFloor: number;
  /** Barge-in latency budget, ms (default 400). */
  bargeInLatencyBudgetMs: number;
  /** Regression tolerance: WER delta above this is a regression (default 0.02). */
  werRegressionTol: number;
  /** Regression tolerance: latency delta above this, ms (default 50). */
  latencyRegressionTolMs: number;
  /** Regression tolerance: MOS delta below this is a regression (default -0.1). */
  mosRegressionTol: number;
}

export function defaultEvalHarnessV23Options(): EvalHarnessV23Options {
  return {
    werBudget: 0.15,
    latencyBudgetMs: 800,
    mosFloor: 3.0,
    bargeInLatencyBudgetMs: 400,
    werRegressionTol: 0.02,
    latencyRegressionTolMs: 50,
    mosRegressionTol: -0.1,
  };
}

export function validateEvalHarnessV23Options(o: Partial<EvalHarnessV23Options>): string[] {
  const errors: string[] = [];
  const check = (name: keyof EvalHarnessV23Options, min: number, max: number): void => {
    const v = o[name];
    if (v !== undefined && !(v >= min && v <= max)) errors.push(`${name} must be ${min}..${max}`);
  };
  check('werBudget', 0, 1);
  check('latencyBudgetMs', 0, 10000);
  check('mosFloor', 1, 5);
  check('bargeInLatencyBudgetMs', 0, 5000);
  check('werRegressionTol', 0, 1);
  check('latencyRegressionTolMs', 0, 5000);
  check('mosRegressionTol', -5, 0);
  return errors;
}

export interface VoiceV23PairResult extends VoiceV23WerResult {
  id: string;
  locale: string;
  condition: VoiceV23Condition;
  ceiling: number;
}

export interface VoiceV23TranscriptReport {
  n: number;
  passed: number;
  failed: number;
  meanWer: number;
  p95Wer: number;
  maxWer: number;
  byLocale: Record<string, { n: number; meanWer: number; passed: number }>;
  byCondition: Record<VoiceV23Condition, { n: number; meanWer: number; passed: number }>;
  pairs: VoiceV23PairResult[];
}

export interface VoiceV23MosSuiteReport {
  n: number;
  meanMos: number;
  minMos: number;
  meanAbsoluteError: number;
  meanSignedError: number;
  worstError: number;
  belowFloor: number;
}

export interface VoiceV23InterruptionSuiteReport {
  n: number;
  correct: number;
  accuracy: number;
  wrong: { id: string; expected: string; got: string }[];
}

export interface VoiceV23EndpointSuiteReport {
  n: number;
  correct: number;
  accuracy: number;
  wrong: { id: string; expected: number; got: number }[];
}

export interface EvalHarnessV23Report {
  atMs: number;
  transcript: VoiceV23TranscriptReport;
  latency: VoiceV23LatencyAggregate;
  mos: VoiceV23MosSuiteReport;
  interruption: VoiceV23InterruptionSuiteReport;
  endpoint: VoiceV23EndpointSuiteReport;
  /** True when every suite meets its budget. */
  passes: boolean;
  failures: string[];
  summary: string;
}

/** Score one pair against its own ceiling. */
export function runEvalPairV23(pair: VoiceV23EvalPair): VoiceV23PairResult {
  const scored = werV23(pair.reference, pair.hypothesis, pair.werCeiling);
  return {
    ...scored,
    id: pair.id,
    locale: pair.locale,
    condition: pair.condition,
    ceiling: pair.werCeiling,
  };
}

/** Run the whole transcript corpus, grouped by locale and condition. */
export function runTranscriptCorpusV23(pairs: readonly VoiceV23EvalPair[] = EVAL_CORPUS_V23_TRANSCRIPTS): VoiceV23TranscriptReport {
  const scored = pairs.map(runEvalPairV23);
  const wers = scored.map((s) => s.wer);
  const byLocale: VoiceV23TranscriptReport['byLocale'] = {};
  const byCondition: VoiceV23TranscriptReport['byCondition'] = {
    clean: { n: 0, meanWer: 0, passed: 0 },
    noisy: { n: 0, meanWer: 0, passed: 0 },
    'far-field': { n: 0, meanWer: 0, passed: 0 },
    echoey: { n: 0, meanWer: 0, passed: 0 },
    'fast-speech': { n: 0, meanWer: 0, passed: 0 },
  };
  for (const s of scored) {
    const loc = byLocale[s.locale] ?? { n: 0, meanWer: 0, passed: 0 };
    loc.n += 1;
    loc.meanWer += s.wer;
    if (s.passes) loc.passed += 1;
    byLocale[s.locale] = loc;
    const cond = byCondition[s.condition];
    cond.n += 1;
    cond.meanWer += s.wer;
    if (s.passes) cond.passed += 1;
  }
  for (const loc of Object.values(byLocale)) loc.meanWer = round4V23(loc.meanWer / Math.max(1, loc.n));
  for (const cond of Object.values(byCondition)) cond.meanWer = cond.n === 0 ? 0 : round4V23(cond.meanWer / cond.n);
  return {
    n: scored.length,
    passed: scored.filter((s) => s.passes).length,
    failed: scored.filter((s) => !s.passes).length,
    meanWer: round4V23(meanV23(wers)),
    p95Wer: round4V23(percentileV23(wers, 95)),
    maxWer: wers.length === 0 ? 0 : round4V23(Math.max(...wers)),
    byLocale,
    byCondition,
    pairs: scored,
  };
}

/** Run the MOS-proxy suite against the labelled cases. */
export function runMosSuiteV23(
  samples: readonly VoiceV23MosSample[] = EVAL_CORPUS_V23_MOS,
  opts: Partial<EvalHarnessV23Options> = {},
): VoiceV23MosSuiteReport {
  const o = { ...defaultEvalHarnessV23Options(), ...opts };
  const scores = samples.map((s) => mosProxyV23(s.features).score);
  const err = mosProxyErrorV23(samples);
  return {
    n: samples.length,
    meanMos: round2V23(meanV23(scores)),
    minMos: scores.length === 0 ? 0 : Math.min(...scores),
    meanAbsoluteError: err.meanAbsoluteError,
    meanSignedError: err.meanSignedError,
    worstError: err.worst,
    belowFloor: scores.filter((s) => s < o.mosFloor).length,
  };
}

/**
 * Compare a baseline (v22) against the current run (v23).
 * Lower WER / latency is better; higher MOS is better.
 */
export function compareWithBaselineV23(
  baseline: VoiceV23Baseline,
  current: VoiceV23Baseline,
  opts: Partial<EvalHarnessV23Options> = {},
): VoiceV23BaselineDelta {
  const o = { ...defaultEvalHarnessV23Options(), ...opts };
  const werDelta = round4V23(current.meanWer - baseline.meanWer);
  const latencyDeltaMs = Math.round(current.p95LatencyMs - baseline.p95LatencyMs);
  const mosDelta = round2V23(current.meanMos - baseline.meanMos);
  const bargeInLatencyDeltaMs = Math.round(current.bargeInLatencyMs - baseline.bargeInLatencyMs);
  const regressions: string[] = [];
  const improved: string[] = [];
  if (werDelta > o.werRegressionTol) regressions.push(`WER regressed +${werDelta}`);
  else if (werDelta < -o.werRegressionTol) improved.push(`WER improved ${werDelta}`);
  if (latencyDeltaMs > o.latencyRegressionTolMs) regressions.push(`p95 latency regressed +${latencyDeltaMs}ms`);
  else if (latencyDeltaMs < -o.latencyRegressionTolMs) improved.push(`p95 latency improved ${latencyDeltaMs}ms`);
  if (mosDelta < o.mosRegressionTol) regressions.push(`MOS regressed ${mosDelta}`);
  else if (mosDelta > -o.mosRegressionTol) improved.push(`MOS improved +${mosDelta}`);
  if (bargeInLatencyDeltaMs > o.latencyRegressionTolMs) regressions.push(`barge-in latency regressed +${bargeInLatencyDeltaMs}ms`);
  else if (bargeInLatencyDeltaMs < -o.latencyRegressionTolMs) improved.push(`barge-in latency improved ${bargeInLatencyDeltaMs}ms`);
  return {
    werDelta,
    werDeltaPct: baseline.meanWer === 0 ? 0 : round2V23((werDelta / baseline.meanWer) * 100),
    latencyDeltaMs,
    latencyDeltaPct: baseline.p95LatencyMs === 0 ? 0 : round2V23((latencyDeltaMs / baseline.p95LatencyMs) * 100),
    mosDelta,
    bargeInLatencyDeltaMs,
    regressed: regressions.length > 0,
    regressions,
    improved,
  };
}

export class EvalHarnessV23 {
  private readonly opts: EvalHarnessV23Options;

  constructor(opts: Partial<EvalHarnessV23Options> = {}) {
    const errors = validateEvalHarnessV23Options(opts);
    if (errors.length > 0) throw new Error(`Invalid EvalHarnessV23 options: ${errors.join('; ')}`);
    this.opts = { ...defaultEvalHarnessV23Options(), ...opts };
  }

  options(): EvalHarnessV23Options {
    return { ...this.opts };
  }

  runPair(pair: VoiceV23EvalPair): VoiceV23PairResult {
    return runEvalPairV23(pair);
  }

  runTranscriptCorpus(pairs: readonly VoiceV23EvalPair[] = EVAL_CORPUS_V23_TRANSCRIPTS): VoiceV23TranscriptReport {
    return runTranscriptCorpusV23(pairs);
  }

  runLatencySuite(samples: readonly VoiceV23LatencySample[] = EVAL_CORPUS_V23_LATENCY): VoiceV23LatencyAggregate {
    return aggregateLatencyV23(samples, this.opts.latencyBudgetMs);
  }

  runMosSuite(samples: readonly VoiceV23MosSample[] = EVAL_CORPUS_V23_MOS): VoiceV23MosSuiteReport {
    return runMosSuiteV23(samples, this.opts);
  }

  runInterruptionSuite(
    cases: readonly VoiceV23InterruptionCase[] = EVAL_CORPUS_V23_INTERRUPTIONS,
    decide: (c: VoiceV23InterruptionCase) => string,
  ): VoiceV23InterruptionSuiteReport {
    const wrong: VoiceV23InterruptionSuiteReport['wrong'] = [];
    let correct = 0;
    for (const c of cases) {
      const got = decide(c);
      if (got === c.expected) correct += 1;
      else wrong.push({ id: c.id, expected: c.expected, got });
    }
    return { n: cases.length, correct, accuracy: cases.length === 0 ? 0 : round4V23(correct / cases.length), wrong };
  }

  runEndpointSuite(
    cases: readonly VoiceV23EndpointCase[] = EVAL_CORPUS_V23_ENDPOINTS,
    endpoint: (c: VoiceV23EndpointCase) => number,
  ): VoiceV23EndpointSuiteReport {
    const wrong: VoiceV23EndpointSuiteReport['wrong'] = [];
    let correct = 0;
    for (const c of cases) {
      const got = endpoint(c);
      if (got === c.expectedEndFrame) correct += 1;
      else wrong.push({ id: c.id, expected: c.expectedEndFrame, got });
    }
    return { n: cases.length, correct, accuracy: cases.length === 0 ? 0 : round4V23(correct / cases.length), wrong };
  }

  /** Run every suite and collect the pass/fail verdict. */
  runAll(atMs = 0): EvalHarnessV23Report {
    const transcript = this.runTranscriptCorpus();
    const latency = this.runLatencySuite();
    const mos = this.runMosSuite();
    // Suites that need an engine are run by the caller through the
    // dedicated methods; runAll reports them as not-run (n 0) so a
    // bare harness run stays honest about what it measured.
    const interruption: VoiceV23InterruptionSuiteReport = { n: 0, correct: 0, accuracy: 0, wrong: [] };
    const endpoint: VoiceV23EndpointSuiteReport = { n: 0, correct: 0, accuracy: 0, wrong: [] };
    const failures: string[] = [];
    if (transcript.meanWer > this.opts.werBudget) failures.push(`mean WER ${transcript.meanWer} over budget ${this.opts.werBudget}`);
    if (transcript.failed > 0) failures.push(`${transcript.failed}/${transcript.n} transcript pairs over ceiling`);
    if (latency.p95FirstTokenMs > this.opts.latencyBudgetMs) failures.push(`p95 first-token ${latency.p95FirstTokenMs}ms over budget ${this.opts.latencyBudgetMs}ms`);
    if (mos.meanMos < this.opts.mosFloor) failures.push(`mean MOS-proxy ${mos.meanMos} below floor ${this.opts.mosFloor}`);
    const summary = [
      `voice v23 eval: WER mean ${transcript.meanWer} (${transcript.passed}/${transcript.n} pairs pass)`,
      `p95 first-token ${latency.p95FirstTokenMs}ms, MOS-proxy mean ${mos.meanMos}`,
      failures.length === 0 ? 'PASS' : `FAIL: ${failures.join('; ')}`,
    ].join(' · ');
    return { atMs, transcript, latency, mos, interruption, endpoint, passes: failures.length === 0, failures, summary };
  }

  compare(baseline: VoiceV23Baseline, current: VoiceV23Baseline): VoiceV23BaselineDelta {
    return compareWithBaselineV23(baseline, current, this.opts);
  }
}

export function createEvalHarnessV23(opts: Partial<EvalHarnessV23Options> = {}): EvalHarnessV23 {
  return new EvalHarnessV23(opts);
}

export function evalHarnessV23Summary(r: EvalHarnessV23Report): string {
  return r.summary;
}

export function evalHarnessV23Markdown(r: EvalHarnessV23Report): string {
  const t = r.transcript;
  const lines = [
    '# Voice v23 eval report',
    '',
    `- Transcript: ${t.passed}/${t.n} pairs pass · mean WER ${t.meanWer} · p95 ${t.p95Wer} · max ${t.maxWer}`,
    `- Latency: mean first-token ${r.latency.meanFirstTokenMs}ms · p50 ${r.latency.p50FirstTokenMs}ms · p95 ${r.latency.p95FirstTokenMs}ms · max ${r.latency.maxFirstTokenMs}ms · over budget ${r.latency.overBudget}`,
    `- MOS-proxy: mean ${r.mos.meanMos} · min ${r.mos.minMos} · MAE vs labels ${r.mos.meanAbsoluteError} · below floor ${r.mos.belowFloor}`,
  ];
  for (const [locale, v] of Object.entries(t.byLocale)) {
    lines.push(`- WER ${locale}: ${v.meanWer} (${v.passed}/${v.n} pass)`);
  }
  for (const [cond, v] of Object.entries(t.byCondition)) {
    lines.push(`- WER ${cond}: ${v.meanWer} (${v.passed}/${v.n} pass)`);
  }
  if (r.interruption.n > 0) lines.push(`- Interruption policy: ${r.interruption.correct}/${r.interruption.n} correct (${r.interruption.accuracy})`);
  if (r.endpoint.n > 0) lines.push(`- Endpointing: ${r.endpoint.correct}/${r.endpoint.n} correct (${r.endpoint.accuracy})`);
  lines.push('', `Verdict: **${r.passes ? 'PASS' : 'FAIL'}**${r.failures.length > 0 ? ` — ${r.failures.join('; ')}` : ''}`, '');
  return lines.join('\n');
}
