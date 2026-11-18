/**
 * Voice eval v21 (voice v21, v1.34 Team T5).
 *
 * Measures the voice pipeline on a local sample set — no
 * provider, no audio, no key. Two dimensions:
 *
 *   - Accuracy: WER (word error rate) and CER (character error
 *     rate) of STT output against reference transcripts. Words
 *     align by a Levenshtein dynamic program over normalised
 *     tokens (case-insensitive, punctuation dropped, Vietnamese
 *     diacritics kept); the alignment also yields the confusion
 *     pairs ("năm" → "nam") so a systematic STT weakness shows
 *     up as a repeated pair instead of hiding in an average.
 *   - Latency: one sample per pipeline stage (VAD → STT →
 *     intent → model → tool → TTS) per turn, aggregated to
 *     mean / p95 / max per stage and end-to-end, checked against
 *     per-stage budgets. A stage that breaches its budget is
 *     flagged, so the report says *where* the pipeline is slow,
 *     not just that it is slow.
 *
 * A report carries a pass/fail verdict per dimension plus an
 * overall verdict, warning thresholds, and a markdown rendering
 * for the panel and the session log. The built-in sample set is
 * small, deterministic and offline; the host can add its own
 * samples (recorded sessions, harder accents) through `addPair`
 * and `addLatency`.
 */
import {
  round2V21,
  round4V21,
  type VoiceV21LatencySample,
  type VoiceV21LatencyStage,
} from './types';

export type VoiceV21AlignOp = 'match' | 'substitution' | 'insertion' | 'deletion';

export interface VoiceV21AlignedWord {
  op: VoiceV21AlignOp;
  reference: string;
  hypothesis: string;
  refIndex: number;
  hypIndex: number;
}

export interface VoiceV21PairScore {
  wer: number;
  cer: number;
  refWords: number;
  hypWords: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  matches: number;
  alignment: VoiceV21AlignedWord[];
  refTokens: string[];
  hypTokens: string[];
}

export interface VoiceV21EvalSample {
  id: string;
  reference: string;
  hypothesis: string;
  /** Optional per-turn latency samples attached to this pair. */
  latency?: VoiceV21LatencySample[];
}

export interface VoiceV21EvalOptions {
  /** WER at or below this passes (default 0.15). */
  werBudget: number;
  /** CER at or below this passes (default 0.08). */
  cerBudget: number;
  /** Per-stage latency budget in ms (defaults below). */
  stageBudgetsMs: Partial<Record<VoiceV21LatencyStage, number>>;
  /** End-to-end latency budget in ms (default 1500). */
  endToEndBudgetMs: number;
}

export const VOICE_V21_DEFAULT_STAGE_BUDGETS_MS: Record<VoiceV21LatencyStage, number> = {
  vad: 50,
  stt: 400,
  intent: 50,
  model: 800,
  tool: 500,
  tts: 300,
};

export function defaultVoiceEvalV21Options(): VoiceV21EvalOptions {
  return {
    werBudget: 0.15,
    cerBudget: 0.08,
    stageBudgetsMs: { ...VOICE_V21_DEFAULT_STAGE_BUDGETS_MS },
    endToEndBudgetMs: 1500,
  };
}

export function validateVoiceEvalV21Options(o: Partial<VoiceV21EvalOptions>): string[] {
  const e: string[] = [];
  if (o.werBudget !== undefined && (o.werBudget < 0 || o.werBudget > 1)) e.push('werBudget must be 0..1');
  if (o.cerBudget !== undefined && (o.cerBudget < 0 || o.cerBudget > 1)) e.push('cerBudget must be 0..1');
  if (o.endToEndBudgetMs !== undefined && o.endToEndBudgetMs <= 0) e.push('endToEndBudgetMs must be positive');
  for (const [stage, budget] of Object.entries(o.stageBudgetsMs ?? {})) {
    if (budget <= 0) e.push(`stageBudgetsMs.${stage} must be positive`);
  }
  return e;
}

/** Normalise text for comparison: lowercase, strip punctuation, keep letters/marks/digits. */
export function tokenizeEvalV21(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t !== '');
}

/** Normalised characters of a text (whitespace collapsed, no punctuation). */
export function evalCharsV21(text: string): string[] {
  return [...text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '')];
}

interface AlignCell {
  cost: number;
  op: VoiceV21AlignOp;
}

/**
 * Word/character alignment by Levenshtein DP. Backtracking
 * prefers match, then substitution, then deletion, then
 * insertion, so ties resolve deterministically.
 */
function alignTokensV21<T>(ref: readonly T[], hyp: readonly T[], equal: (a: T, b: T) => boolean): {
  substitutions: number;
  insertions: number;
  deletions: number;
  matches: number;
  ops: { op: VoiceV21AlignOp; refIndex: number; hypIndex: number }[];
} {
  const n = ref.length;
  const m = hyp.length;
  const dp: AlignCell[][] = [];
  for (let i = 0; i <= n; i += 1) {
    const row: AlignCell[] = [];
    for (let j = 0; j <= m; j += 1) {
      if (i === 0 && j === 0) row.push({ cost: 0, op: 'match' });
      else if (i === 0) row.push({ cost: j, op: 'insertion' });
      else if (j === 0) row.push({ cost: i, op: 'deletion' });
      else {
        const sub = (dp[i - 1]![j - 1]!.cost ?? 0) + (equal(ref[i - 1]!, hyp[j - 1]!) ? 0 : 1);
        const del = (dp[i - 1]![j]!.cost ?? 0) + 1;
        // NOTE: the current row is still being built (`dp.push(row)` runs
        // after this loop), so the insertion cost reads from `row`,
        // not `dp[i]` — `dp[i]` is undefined until the row is done.
        const ins = (row[j - 1]!.cost ?? 0) + 1;
        const min = Math.min(sub, del, ins);
        const op: VoiceV21AlignOp = min === sub
          ? (equal(ref[i - 1]!, hyp[j - 1]!) ? 'match' : 'substitution')
          : min === del ? 'deletion' : 'insertion';
        row.push({ cost: min, op });
      }
    }
    dp.push(row);
  }
  const ops: { op: VoiceV21AlignOp; refIndex: number; hypIndex: number }[] = [];
  let i = n;
  let j = m;
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  let matches = 0;
  while (i > 0 || j > 0) {
    const cell = dp[i]![j]!;
    if (cell.op === 'match' || cell.op === 'substitution') {
      if (cell.op === 'match') matches += 1; else substitutions += 1;
      ops.push({ op: cell.op, refIndex: i - 1, hypIndex: j - 1 });
      i -= 1; j -= 1;
    } else if (cell.op === 'deletion') {
      deletions += 1;
      ops.push({ op: 'deletion', refIndex: i - 1, hypIndex: j });
      i -= 1;
    } else {
      insertions += 1;
      ops.push({ op: 'insertion', refIndex: i, hypIndex: j - 1 });
      j -= 1;
    }
  }
  ops.reverse();
  return { substitutions, insertions, deletions, matches, ops };
}

/** Score one reference/hypothesis pair (word + char level). */
export function scorePairV21(reference: string, hypothesis: string): VoiceV21PairScore {
  const refTokens = tokenizeEvalV21(reference);
  const hypTokens = tokenizeEvalV21(hypothesis);
  const word = alignTokensV21(refTokens, hypTokens, (a, b) => a === b);
  const refChars = evalCharsV21(reference);
  const hypChars = evalCharsV21(hypothesis);
  const chars = alignTokensV21(refChars, hypChars, (a, b) => a === b);
  const wer = refTokens.length === 0
    ? (hypTokens.length === 0 ? 0 : 1)
    : (word.substitutions + word.insertions + word.deletions) / refTokens.length;
  const cer = refChars.length === 0
    ? (hypChars.length === 0 ? 0 : 1)
    : (chars.substitutions + chars.insertions + chars.deletions) / refChars.length;
  return {
    wer: round4V21(wer),
    cer: round4V21(cer),
    refWords: refTokens.length,
    hypWords: hypTokens.length,
    substitutions: word.substitutions,
    insertions: word.insertions,
    deletions: word.deletions,
    matches: word.matches,
    alignment: word.ops.map((a) => ({
      op: a.op,
      reference: a.op === 'insertion' ? '' : refTokens[a.refIndex] ?? '',
      hypothesis: a.op === 'deletion' ? '' : hypTokens[a.hypIndex] ?? '',
      refIndex: a.refIndex,
      hypIndex: a.hypIndex,
    })),
    refTokens,
    hypTokens,
  };
}

/** Does one scored pair pass the accuracy budgets? */
export function pairPassesV21(score: VoiceV21PairScore, opts: Partial<VoiceV21EvalOptions> = {}): boolean {
  const o = { ...defaultVoiceEvalV21Options(), ...opts };
  return score.wer <= o.werBudget && score.cer <= o.cerBudget;
}

export interface VoiceV21Confusion {
  reference: string;
  hypothesis: string;
  count: number;
}

export interface VoiceV21StageLatency {
  stage: VoiceV21LatencyStage;
  samples: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  budgetMs: number;
  breached: boolean;
}

export interface VoiceV21EvalReport {
  pairs: number;
  totalRefWords: number;
  meanWer: number;
  p95Wer: number;
  maxWer: number;
  meanCer: number;
  p95Cer: number;
  maxCer: number;
  passCount: number;
  passRate: number;
  topConfusions: VoiceV21Confusion[];
  stages: VoiceV21StageLatency[];
  endToEndMeanMs: number;
  endToEndP95Ms: number;
  endToEndBreached: boolean;
  accuracyPass: boolean;
  latencyPass: boolean;
  overallPass: boolean;
  warnings: string[];
}

function percentileSorted(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function meanOf(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Aggregate scored pairs + latency samples into one report. */
export function aggregateEvalV21(
  scores: readonly VoiceV21PairScore[],
  latency: readonly VoiceV21LatencySample[],
  opts: Partial<VoiceV21EvalOptions> = {},
): VoiceV21EvalReport {
  const o = { ...defaultVoiceEvalV21Options(), ...opts };
  const budgets = { ...VOICE_V21_DEFAULT_STAGE_BUDGETS_MS, ...(o.stageBudgetsMs ?? {}) };
  const wers = scores.map((s) => s.wer);
  const cers = scores.map((s) => s.cer);
  const confusionCounts = new Map<string, VoiceV21Confusion>();
  for (const s of scores) {
    for (const w of s.alignment) {
      if (w.op !== 'substitution') continue;
      const key = `${w.reference}→${w.hypothesis}`;
      const prev = confusionCounts.get(key);
      if (prev) prev.count += 1;
      else confusionCounts.set(key, { reference: w.reference, hypothesis: w.hypothesis, count: 1 });
    }
  }
  const topConfusions = [...confusionCounts.values()]
    .sort((a, b) => b.count - a.count || a.reference.localeCompare(b.reference))
    .slice(0, 10);
  const stages: VoiceV21StageLatency[] = (Object.keys(budgets) as VoiceV21LatencyStage[]).map((stage) => {
    const xs = latency.filter((s) => s.stage === stage).map((s) => s.durationMs);
    const p95 = percentileSorted(xs, 95);
    return {
      stage,
      samples: xs.length,
      meanMs: round2V21(meanOf(xs)),
      p95Ms: round2V21(p95),
      maxMs: xs.length === 0 ? 0 : Math.max(...xs),
      budgetMs: budgets[stage]!,
      breached: p95 > budgets[stage]!,
    };
  });
  // End-to-end: sum per-turn stage durations, grouped by turnId.
  const byTurn = new Map<string, number>();
  for (const s of latency) byTurn.set(s.turnId, (byTurn.get(s.turnId) ?? 0) + s.durationMs);
  const e2e = [...byTurn.values()];
  const e2eP95 = percentileSorted(e2e, 95);
  const passCount = scores.filter((s) => pairPassesV21(s, o)).length;
  const accuracyPass = scores.length === 0 ? true : passCount === scores.length;
  const latencyPass = stages.every((s) => !s.breached) && e2eP95 <= o.endToEndBudgetMs;
  const warnings: string[] = [];
  if (scores.length > 0 && passCount < scores.length) {
    const worstWer = Math.max(...wers);
    warnings.push(
      `${scores.length - passCount} of ${scores.length} pairs breach the per-pair WER/CER budget (worst WER ${(worstWer * 100).toFixed(1)}%).`,
    );
  }
  if (scores.length > 0 && meanOf(wers) > o.werBudget) {
    warnings.push(`Mean WER ${(meanOf(wers) * 100).toFixed(1)}% exceeds budget ${(o.werBudget * 100).toFixed(1)}%.`);
  }
  if (scores.length > 0 && meanOf(cers) > o.cerBudget) {
    warnings.push(`Mean CER ${(meanOf(cers) * 100).toFixed(1)}% exceeds budget ${(o.cerBudget * 100).toFixed(1)}%.`);
  }
  for (const s of stages) {
    if (s.breached) warnings.push(`Stage ${s.stage} p95 ${s.p95Ms} ms exceeds budget ${s.budgetMs} ms.`);
  }
  if (e2eP95 > o.endToEndBudgetMs) {
    warnings.push(`End-to-end p95 ${round2V21(e2eP95)} ms exceeds budget ${o.endToEndBudgetMs} ms.`);
  }
  return {
    pairs: scores.length,
    totalRefWords: scores.reduce((s, a) => s + a.refWords, 0),
    meanWer: round4V21(meanOf(wers)),
    p95Wer: round4V21(percentileSorted(wers, 95)),
    maxWer: wers.length === 0 ? 0 : Math.max(...wers),
    meanCer: round4V21(meanOf(cers)),
    p95Cer: round4V21(percentileSorted(cers, 95)),
    maxCer: cers.length === 0 ? 0 : Math.max(...cers),
    passCount,
    passRate: scores.length === 0 ? 0 : round4V21(passCount / scores.length),
    topConfusions,
    stages,
    endToEndMeanMs: round2V21(meanOf(e2e)),
    endToEndP95Ms: round2V21(e2eP95),
    endToEndBreached: e2eP95 > o.endToEndBudgetMs,
    accuracyPass,
    latencyPass,
    overallPass: accuracyPass && latencyPass,
    warnings,
  };
}

/** One-line summary of a single scored pair. */
export function pairScoreSummaryV21(score: VoiceV21PairScore): string {
  return `WER ${(score.wer * 100).toFixed(1)}% (S${score.substitutions}/I${score.insertions}/D${score.deletions} ` +
    `over ${score.refWords} words), CER ${(score.cer * 100).toFixed(1)}%`;
}

/** Markdown rendering of a full eval report. */
export function evalReportMarkdownV21(report: VoiceV21EvalReport): string {
  const lines = [
    '# Voice eval v21',
    '',
    `- Verdict: ${report.overallPass ? 'PASS' : 'FAIL'} (accuracy ${report.accuracyPass ? 'pass' : 'fail'}, latency ${report.latencyPass ? 'pass' : 'fail'})`,
    `- Pairs scored: ${report.pairs}, reference words: ${report.totalRefWords}`,
    `- Mean WER: ${(report.meanWer * 100).toFixed(1)}% (p95 ${(report.p95Wer * 100).toFixed(1)}%, max ${(report.maxWer * 100).toFixed(1)}%)`,
    `- Mean CER: ${(report.meanCer * 100).toFixed(1)}% (p95 ${(report.p95Cer * 100).toFixed(1)}%, max ${(report.maxCer * 100).toFixed(1)}%)`,
    `- Pass rate: ${(report.passRate * 100).toFixed(1)}% (${report.passCount}/${report.pairs})`,
    `- End-to-end latency: mean ${report.endToEndMeanMs} ms, p95 ${report.endToEndP95Ms} ms`,
    '',
    '## Stage latency',
    '',
    '| Stage | Samples | Mean (ms) | p95 (ms) | Max (ms) | Budget (ms) |',
    '|---|---|---|---|---|---|',
  ];
  for (const s of report.stages) {
    lines.push(`| ${s.stage} | ${s.samples} | ${s.meanMs} | ${s.p95Ms} | ${s.maxMs} | ${s.budgetMs}${s.breached ? ' ⚠' : ''} |`);
  }
  lines.push('');
  if (report.topConfusions.length > 0) {
    lines.push('## Top confusions', '');
    for (const c of report.topConfusions) lines.push(`- "${c.reference}" → "${c.hypothesis}" ×${c.count}`);
    lines.push('');
  }
  if (report.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Built-in offline sample set (deterministic, no audio). */
export const VOICE_V21_EVAL_SAMPLES: VoiceV21EvalSample[] = [
  { id: 'v21-s01', reference: 'Xin chào, hôm nay trời đẹp quá', hypothesis: 'Xin chào hôm nay trời đẹp quá' },
  { id: 'v21-s02', reference: 'Tìm kiếm quán cà phê gần đây', hypothesis: 'Tìm kiếm quán cà phê gần đây' },
  { id: 'v21-s03', reference: 'Nhắc tôi gọi cho mẹ lúc sáu giờ', hypothesis: 'Nhắc tôi gọi cho mẹ lúc sáu giờ' },
  { id: 'v21-s04', reference: 'Mở nhạc nhẹ nhàng cho tôi nghe', hypothesis: 'Mở nhạc nhẹ nhàng cho tôi nghe' },
  { id: 'v21-s05', reference: 'Hà Nội là thủ đô của Việt Nam', hypothesis: 'Hà Nội là thủ đô của Việt Nam' },
  { id: 'v21-s06', reference: 'What time is it now', hypothesis: 'What time is it now' },
  { id: 'v21-s07', reference: 'Search the web for cats in Hanoi', hypothesis: 'Search the web for cats in Hanoi' },
  { id: 'v21-s08', reference: 'Ghi chú mua sữa và bánh mì', hypothesis: 'Ghi chú mua sữa và bánh mì' },
  { id: 'v21-s09', reference: 'Đồng ý, làm đi', hypothesis: 'Đồng ý làm đi' },
  { id: 'v21-s10', reference: 'Không, hủy đi đừng gửi', hypothesis: 'Không hủy đi đừng gửi' },
  { id: 'v21-s11', reference: 'Đọc ghi chú của tôi', hypothesis: 'Đọc ghi chú của tôi' },
  { id: 'v21-s12', reference: 'Năm nay tôi ba mươi tuổi', hypothesis: 'Nam nay tôi ba mươi tuổi' },
];

export class VoiceEvalV21 {
  private readonly opts: VoiceV21EvalOptions;
  private readonly pairs: VoiceV21EvalSample[] = [];
  private readonly latency: VoiceV21LatencySample[] = [];

  constructor(opts: Partial<VoiceV21EvalOptions> = {}) {
    this.opts = { ...defaultVoiceEvalV21Options(), ...opts };
  }

  addPair(sample: VoiceV21EvalSample): void {
    this.pairs.push(sample);
    if (sample.latency !== undefined) this.latency.push(...sample.latency);
  }

  addLatency(sample: VoiceV21LatencySample): void {
    this.latency.push(sample);
  }

  addBuiltInSamples(): void {
    for (const s of VOICE_V21_EVAL_SAMPLES) this.addPair(s);
  }

  sampleCount(): number {
    return this.pairs.length;
  }

  latencyCount(): number {
    return this.latency.length;
  }

  /** Score every pair and aggregate with all latency samples. */
  run(): VoiceV21EvalReport {
    const scores = this.pairs.map((p) => scorePairV21(p.reference, p.hypothesis));
    return aggregateEvalV21(scores, this.latency, this.opts);
  }

  /** Score one pair against the budgets. */
  scoreOne(reference: string, hypothesis: string): { score: VoiceV21PairScore; pass: boolean } {
    const score = scorePairV21(reference, hypothesis);
    return { score, pass: pairPassesV21(score, this.opts) };
  }
}

export function createVoiceEvalV21(opts: Partial<VoiceV21EvalOptions> = {}): VoiceEvalV21 {
  return new VoiceEvalV21(opts);
}
