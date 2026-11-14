/**
 * Voice eval, internal only (v1.05, Team T5 — voice eval).
 *
 * The voice path had latency numbers but no *score*: was the
 * transcript right, and did the barge-in actually beat its
 * budget? This module answers both without calling anything
 * outside the machine:
 *
 *   - WER: each case pairs a ground-truth fixture sentence with
 *     the transcript the (mock) STT produced; `wordErrorRate`
 *     from the v0.96 STT pipeline does the scoring, so the WER
 *     here means exactly what the pipeline's WER means.
 *   - Barge-in latency: measured stop latencies are scored
 *     against the 50 ms v4 budget (p50 / p95 / breaches /
 *     within-budget rate).
 *   - Per-session report: one `VoiceEvalReport` per eval run —
 *     cases, mean/median WER, pass rate at the threshold, the
 *     barge-in numbers, and a markdown rendering for the panel
 *     and the session log.
 *
 * Nothing here dials a provider: the hypotheses come from the
 * caller (mock STT in tests, local engines in the app). A case
 * with no hypothesis is a failure, not a skip — silence is a
 * wrong transcript.
 */
import { wordErrorRate, type WordErrorRate } from './sttPipeline';
import { LatencyHistogram, type LatencyHistogramSummary } from './latencyPipeline';

/** One eval case: what was said vs what the STT heard. */
export interface VoiceEvalCase {
  /** Stable id (shown in the report). */
  id: string;
  /** Ground-truth sentence (the fixture). */
  reference: string;
  /** Transcript the STT produced (mock in tests). */
  hypothesis: string;
  /** Measured barge-in stop latency for this case (ms, optional). */
  bargeInStopMs?: number;
  /** Language of the case (informational). */
  lang?: string;
}

/** One case scored. */
export interface VoiceEvalCaseResult {
  id: string;
  lang: string;
  wer: WordErrorRate;
  /** True when the WER is at or below the threshold. */
  passed: boolean;
  bargeInStopMs: number | null;
}

/** Barge-in latency scored against the 50 ms budget. */
export interface VoiceEvalBargeInReport {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** Stops that missed the budget. */
  breaches: number;
  /** Fraction of stops inside the budget (0..1). */
  withinBudgetRate: number;
  histogram: LatencyHistogramSummary | null;
}

/** One eval run, as the panel / session log renders it. */
export interface VoiceEvalReport {
  sessionId: string;
  ranAt: number;
  cases: number;
  passed: number;
  passRate: number;
  meanWer: number;
  medianWer: number;
  maxWer: number;
  /** WER bar a case must beat to pass. */
  werThreshold: number;
  /** Barge-in stop budget (ms). */
  stopBudgetMs: number;
  bargeIn: VoiceEvalBargeInReport;
  /** Per-language breakdown ('' = no lang given). */
  byLang: Record<string, { cases: number; passed: number; meanWer: number }>;
  results: VoiceEvalCaseResult[];
}

export interface VoiceEvalOptions {
  /** WER at or below this passes a case. Default 0.2. */
  werThreshold?: number;
  /** Barge-in stop budget (ms). Default 50. */
  stopBudgetMs?: number;
  /** Session the run belongs to (shown in the report). */
  sessionId?: string;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

/** Default WER bar: a case passes at 20% word error or better. */
export const VOICE_EVAL_DEFAULT_WER_THRESHOLD = 0.2;
/** Default barge-in stop budget (ms) — same as v4's. */
export const VOICE_EVAL_DEFAULT_STOP_BUDGET_MS = 50;

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return Math.round((((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2) * 1000) / 1000;
}

/**
 * Score barge-in stop latencies against a budget. Pure — the
 * samples come from the caller (mock in tests, the v4 controller
 * in the app).
 */
export function scoreBargeInLatency(
  samples: number[],
  stopBudgetMs: number = VOICE_EVAL_DEFAULT_STOP_BUDGET_MS,
): VoiceEvalBargeInReport {
  const valid = samples.filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  const histogram = new LatencyHistogram();
  for (const ms of valid) histogram.record(ms);
  const summary = histogram.summary();
  const breaches = valid.filter((ms) => ms > stopBudgetMs).length;
  return {
    samples: valid.length,
    p50Ms: summary ? summary.p50Ms : null,
    p95Ms: summary ? summary.p95Ms : null,
    maxMs: summary ? summary.maxMs : null,
    breaches,
    withinBudgetRate: valid.length === 0 ? 0 : Math.round(((valid.length - breaches) / valid.length) * 1000) / 1000,
    histogram: summary,
  };
}

/**
 * Run the eval over a set of fixture cases. Every case is
 * scored — an empty hypothesis scores WER 1 (all words deleted),
 * never a skip.
 */
export function runVoiceEval(cases: VoiceEvalCase[], options: VoiceEvalOptions = {}): VoiceEvalReport {
  const threshold = options.werThreshold ?? VOICE_EVAL_DEFAULT_WER_THRESHOLD;
  const stopBudgetMs = options.stopBudgetMs ?? VOICE_EVAL_DEFAULT_STOP_BUDGET_MS;
  const clock = options.clock ?? Date.now;
  const stopSamples: number[] = [];
  const results: VoiceEvalCaseResult[] = cases.map((c) => {
    const wer = wordErrorRate(c.reference, c.hypothesis);
    if (typeof c.bargeInStopMs === 'number') stopSamples.push(c.bargeInStopMs);
    return {
      id: c.id,
      lang: c.lang ?? '',
      wer,
      passed: wer.wer <= threshold,
      bargeInStopMs: typeof c.bargeInStopMs === 'number' ? c.bargeInStopMs : null,
    };
  });
  const wers = results.map((r) => r.wer.wer);
  const passed = results.filter((r) => r.passed).length;
  const byLang: Record<string, { cases: number; passed: number; meanWer: number }> = {};
  for (const r of results) {
    const entry = byLang[r.lang] ?? { cases: 0, passed: 0, meanWer: 0 };
    entry.cases += 1;
    if (r.passed) entry.passed += 1;
    entry.meanWer = Math.round(((entry.meanWer * (entry.cases - 1) + r.wer.wer) / entry.cases) * 1000) / 1000;
    byLang[r.lang] = entry;
  }
  return {
    sessionId: options.sessionId ?? '',
    ranAt: clock(),
    cases: results.length,
    passed,
    passRate: results.length === 0 ? 0 : Math.round((passed / results.length) * 1000) / 1000,
    meanWer:
      wers.length === 0 ? 0 : Math.round((wers.reduce((n, v) => n + v, 0) / wers.length) * 1000) / 1000,
    medianWer: medianOf(wers),
    maxWer: wers.length === 0 ? 0 : Math.max(...wers),
    werThreshold: threshold,
    stopBudgetMs,
    bargeIn: scoreBargeInLatency(stopSamples, stopBudgetMs),
    byLang,
    results,
  };
}

/** Markdown rendering of one eval report (panel + session log). */
export function voiceEvalReportMarkdown(report: VoiceEvalReport): string {
  const lines = [
    `# Voice eval — session ${report.sessionId || '(no session)'}`,
    '',
    `- Cases: ${report.cases}, passed: ${report.passed} (${Math.round(report.passRate * 100)}% at WER ≤ ${report.werThreshold})`,
    `- WER: mean ${report.meanWer}, median ${report.medianWer}, max ${report.maxWer}`,
    `- Barge-in stops: ${report.bargeIn.samples} samples, p50 ${report.bargeIn.p50Ms ?? '—'}ms, p95 ${report.bargeIn.p95Ms ?? '—'}ms, breaches ${report.bargeIn.breaches} (budget ${report.stopBudgetMs}ms)`,
    '',
    ...Object.entries(report.byLang).map(
      ([lang, b]) => `- ${lang || '(no lang)'}: ${b.passed}/${b.cases} passed, mean WER ${b.meanWer}`,
    ),
    '',
    '| Case | WER | Passed | Stop ms |',
    '|---|---|---|---|',
  ];
  for (const r of report.results) {
    lines.push(
      `| ${r.id} | ${r.wer.wer} | ${r.passed ? 'yes' : 'no'} | ${r.bargeInStopMs === null ? '—' : String(r.bargeInStopMs)} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Fixture cases for the built-in eval (en + vi, short sentences
 * the mock STT can reproduce exactly). The app runs these after
 * a voice session to smoke-test the path; tests use them too.
 */
export const VOICE_EVAL_FIXTURE_CASES: readonly VoiceEvalCase[] = [
  { id: 'eval-en-1', reference: 'hello, how can I help you today', hypothesis: 'hello, how can I help you today', lang: 'en' },
  { id: 'eval-en-2', reference: 'the meeting starts at three o clock', hypothesis: 'the meeting starts at three', lang: 'en' },
  { id: 'eval-vi-1', reference: 'xin chào, bạn cần giúp gì hôm nay', hypothesis: 'xin chào, bạn cần giúp gì hôm nay', lang: 'vi' },
  { id: 'eval-vi-2', reference: 'cuộc họp bắt đầu lúc ba giờ', hypothesis: 'cuộc họp bắt đầu lúc ba giờ chiều', lang: 'vi' },
];
