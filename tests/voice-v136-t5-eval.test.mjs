/**
 * Tests for voice v23 eval: WER, expanded corpus, MOS-proxy,
 * eval harness + v22 -> v23 baseline compare (v1.36, Team T5).
 *
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  werV23,
  levenshteinWordsV23,
  meanV23,
  percentileV23,
  aggregateLatencyV23,
} from '../packages/core/dist/voiceV23/types.js';
import {
  EVAL_CORPUS_V23_TRANSCRIPTS,
  EVAL_CORPUS_V23_LATENCY,
  EVAL_CORPUS_V23_MOS,
  EVAL_CORPUS_V23_INTERRUPTIONS,
  EVAL_CORPUS_V23_ENDPOINTS,
  evalCorpusV23Counts,
  validateEvalCorpusV23,
  evalCorpusV23Summary,
} from '../packages/core/dist/voiceV23/evalCorpusV23.js';
import {
  mosProxyV23,
  mosGradeV23,
  mosProxyErrorV23,
  calibrateMosV23,
  defaultMosV23Options,
  validateMosV23Options,
} from '../packages/core/dist/voiceV23/mosProxyV23.js';
import {
  EvalHarnessV23,
  createEvalHarnessV23,
  runEvalPairV23,
  runTranscriptCorpusV23,
  runMosSuiteV23,
  compareWithBaselineV23,
  defaultEvalHarnessV23Options,
  validateEvalHarnessV23Options,
  evalHarnessV23Markdown,
} from '../packages/core/dist/voiceV23/evalHarnessV23.js';

// ---------------------------------------------------------------- WER
test('voice v136-t5: WER — identical is 0, one substitution / deletion counted', () => {
  assert.equal(werV23('Xin chào Hà Nội', 'Xin chào Hà Nội').wer, 0);
  assert.equal(werV23('Xin chào Hà Nội', 'Xin chào Hà Nội').passes, true);
  const sub = werV23('hai mươi tư độ', 'hai mươi bốn độ');
  assert.equal(sub.substitutions, 1);
  assert.equal(sub.deletions, 0);
  assert.equal(sub.insertions, 0);
  assert.equal(sub.wer, 0.25);
  const del = werV23('Gọi cho mẹ lúc bảy giờ tối', 'Gọi cho mẹ lúc bảy giờ');
  assert.equal(del.deletions, 1);
  assert.equal(del.wer, 0.1429);
  const ins = werV23('Stop', 'Stop now please');
  assert.equal(ins.insertions, 2);
  assert.equal(ins.wer, 2);
  // Empty reference: only an empty hypothesis scores 0.
  assert.equal(werV23('', '').wer, 0);
  assert.equal(werV23('', 'hello').wer, 1);
  assert.equal(werV23('a b c', 'a b c', 0.05).passes, true);
  assert.equal(werV23('a b c', 'a b d', 0.05).passes, false);
});

test('voice v136-t5: levenshtein word distance splits sub/del/ins', () => {
  const r = levenshteinWordsV23(['a', 'b', 'c', 'd'], ['a', 'x', 'c']);
  assert.equal(r.distance, 2);
  assert.equal(r.substitutions, 1);
  assert.equal(r.deletions, 1);
  assert.equal(r.insertions, 0);
  assert.deepEqual(levenshteinWordsV23([], []), { distance: 0, substitutions: 0, deletions: 0, insertions: 0 });
});

test('voice v136-t5: mean + percentile helpers', () => {
  assert.equal(meanV23([]), 0);
  assert.equal(meanV23([10, 20]), 15);
  assert.equal(percentileV23([], 95), 0);
  assert.equal(percentileV23([10, 20, 30, 40], 50), 25);
  assert.equal(percentileV23([5], 95), 5);
  assert.equal(percentileV23([0, 100], 0), 0);
  assert.equal(percentileV23([0, 100], 100), 100);
});

// ---------------------------------------------------------------- corpus
test('voice v136-t5: eval corpus validates clean + has the expected shape', () => {
  assert.deepEqual(validateEvalCorpusV23(), []);
  const counts = evalCorpusV23Counts();
  assert.equal(counts.transcripts, 26);
  assert.equal(counts.byLocale.vi, 14);
  assert.equal(counts.byLocale.en, 12);
  assert.equal(counts.byCondition.clean, 10);
  assert.equal(counts.byCondition.noisy, 9);
  assert.equal(counts.byCondition['far-field'], 3);
  assert.equal(counts.byCondition.echoey, 2);
  assert.equal(counts.byCondition['fast-speech'], 2);
  assert.equal(counts.latency, 12);
  assert.equal(counts.mos, 8);
  assert.equal(counts.interruptions, 12);
  assert.equal(counts.endpoints, 6);
  assert.match(evalCorpusV23Summary(), /26 transcript pairs/);
  const ids = new Set([
    ...EVAL_CORPUS_V23_TRANSCRIPTS.map((p) => p.id),
    ...EVAL_CORPUS_V23_LATENCY.map((p) => p.id),
    ...EVAL_CORPUS_V23_INTERRUPTIONS.map((p) => p.id),
    ...EVAL_CORPUS_V23_ENDPOINTS.map((p) => p.id),
  ]);
  assert.equal(ids.size, 26 + 12 + 12 + 6);
});

// ---------------------------------------------------------------- MOS proxy
test('voice v136-t5: MOS-proxy — perfect features score 5, bad features score low, grades ordered', () => {
  const perfect = mosProxyV23({ wer: 0, latencyMs: 200, jitterMs: 0, bargeInLatencyMs: 0, prosodyNaturalness: 1, clarity: 1, falseBargeIns: 0 });
  assert.equal(perfect.score, 5);
  assert.equal(perfect.grade, 'excellent');
  const bad = mosProxyV23({ wer: 0.5, latencyMs: 2000, jitterMs: 150, bargeInLatencyMs: 900, prosodyNaturalness: 0.3, clarity: 0.4, falseBargeIns: 3 });
  assert.ok(bad.score < 2, `bad features should score < 2, got ${bad.score}`);
  assert.equal(bad.grade, 'bad');
  assert.equal(mosGradeV23(4.8), 'excellent');
  assert.equal(mosGradeV23(4.2), 'good');
  assert.equal(mosGradeV23(3.5), 'fair');
  assert.equal(mosGradeV23(2.5), 'poor');
  assert.equal(mosGradeV23(1.2), 'bad');
  // Latency under the free allowance costs nothing.
  const fast = mosProxyV23({ wer: 0, latencyMs: 400, jitterMs: 0, bargeInLatencyMs: 0, prosodyNaturalness: 1, clarity: 1, falseBargeIns: 0 });
  assert.equal(fast.score, 5);
  const slow = mosProxyV23({ wer: 0, latencyMs: 1400, jitterMs: 0, bargeInLatencyMs: 0, prosodyNaturalness: 1, clarity: 1, falseBargeIns: 0 });
  assert.equal(slow.penalties.latency, 0.5);
  assert.equal(slow.score, 4.5);
  assert.deepEqual(validateMosV23Options({ werWeight: 99 }), ['werWeight must be 0..10']);
  assert.deepEqual(validateMosV23Options({}), []);
  assert.equal(defaultMosV23Options().baseScore, 5);
});

test('voice v136-t5: MOS-proxy tracks the labelled corpus (MAE < 0.35) and calibration removes bias', () => {
  const err = mosProxyErrorV23(EVAL_CORPUS_V23_MOS);
  assert.equal(err.n, 8);
  assert.ok(err.meanAbsoluteError < 0.35, `MAE ${err.meanAbsoluteError} should be < 0.35`);
  assert.ok(err.worst < 0.6, `worst error ${err.worst} should be < 0.6`);
  const { options, before, after } = calibrateMosV23(EVAL_CORPUS_V23_MOS);
  assert.ok(Math.abs(after.meanSignedError) < Math.abs(before.meanSignedError), 'calibration should shrink the signed bias');
  assert.ok(Math.abs(after.meanSignedError) <= 0.05, `calibrated bias ${after.meanSignedError} should be ~0`);
  assert.notEqual(options.interceptShift, 0);
  // A calibrated proxy still scores the perfect case at the top.
  const perfect = mosProxyV23({ wer: 0, latencyMs: 200, jitterMs: 0, bargeInLatencyMs: 0, prosodyNaturalness: 1, clarity: 1, falseBargeIns: 0 }, options);
  assert.ok(perfect.score >= 4.85, `calibrated perfect score ${perfect.score}`);
});

// ---------------------------------------------------------------- latency aggregate
test('voice v136-t5: latency aggregate — p50/p95/max + over-budget count on the corpus', () => {
  const agg = aggregateLatencyV23(EVAL_CORPUS_V23_LATENCY, 800);
  assert.equal(agg.n, 12);
  assert.equal(agg.meanFirstTokenMs, 554.17);
  assert.equal(agg.p50FirstTokenMs, 495);
  assert.equal(agg.p95FirstTokenMs, 1020.5);
  assert.equal(agg.maxFirstTokenMs, 1180);
  assert.equal(agg.overBudget, 2);
  assert.equal(agg.meanTotalMs, 4266.67);
  assert.equal(agg.p95TotalMs, 7880);
  assert.equal(agg.meanJitterMs, 32.83);
  const empty = aggregateLatencyV23([], 800);
  assert.equal(empty.n, 0);
  assert.equal(empty.p95FirstTokenMs, 0);
});

// ---------------------------------------------------------------- harness
test('voice v136-t5: harness transcript corpus — all 26 pairs pass their ceilings', () => {
  const report = runTranscriptCorpusV23();
  assert.equal(report.n, 26);
  assert.equal(report.passed, 26);
  assert.equal(report.failed, 0);
  assert.ok(report.meanWer < 0.05, `mean WER ${report.meanWer}`);
  assert.equal(report.maxWer, 0.1429);
  assert.equal(report.byLocale.vi.n, 14);
  assert.equal(report.byLocale.en.n, 12);
  assert.equal(report.byCondition.noisy.passed, report.byCondition.noisy.n);
  const pair = runEvalPairV23(EVAL_CORPUS_V23_TRANSCRIPTS[5]);
  assert.equal(pair.id, 'v23-tr-06');
  assert.equal(pair.wer, 0.1);
  assert.equal(pair.passes, true);
});

test('voice v136-t5: harness runAll flags the slow latency tail (honest FAIL), passes with a 1200ms budget', () => {
  const harness = createEvalHarnessV23();
  const report = harness.runAll(0);
  assert.equal(report.transcript.passed, 26);
  assert.ok(report.mos.meanMos >= 3.0, `mean MOS-proxy ${report.mos.meanMos} should clear the 3.0 floor`);
  assert.equal(report.passes, false, 'p95 first-token 1020.5ms must breach the 800ms budget');
  assert.ok(report.failures.some((f) => f.includes('p95 first-token')), `failures: ${report.failures.join('; ')}`);
  const loose = createEvalHarnessV23({ latencyBudgetMs: 1200 });
  assert.equal(loose.runAll(0).passes, true);
  const md = evalHarnessV23Markdown(report);
  assert.match(md, /Voice v23 eval report/);
  assert.match(md, /WER vi:/);
  assert.match(md, /Verdict: \*\*FAIL\*\*/);
  assert.deepEqual(validateEvalHarnessV23Options({ werBudget: 2 }), ['werBudget must be 0..1']);
  assert.deepEqual(validateEvalHarnessV23Options({}), []);
  assert.equal(defaultEvalHarnessV23Options().latencyBudgetMs, 800);
  assert.throws(() => new EvalHarnessV23({ werBudget: -1 }), /Invalid EvalHarnessV23 options/);
});

test('voice v136-t5: harness MOS suite — mean MOS-proxy + error vs labels', () => {
  const harness = createEvalHarnessV23();
  const mos = harness.runMosSuite();
  assert.equal(mos.n, 8);
  assert.ok(mos.meanMos >= 3.0 && mos.meanMos <= 4.0, `mean MOS ${mos.meanMos}`);
  assert.ok(mos.meanAbsoluteError < 0.35, `MAE ${mos.meanAbsoluteError}`);
  assert.equal(mos.belowFloor, 2); // the two worst labelled cases score under the 3.0 floor
  const empty = runMosSuiteV23([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.meanMos, 0);
});

// ---------------------------------------------------------------- baseline compare
test('voice v136-t5: baseline compare v22 -> v23 — improvements listed, regressions flagged', () => {
  const baseline = { version: 'v22', meanWer: 0.06, p95LatencyMs: 1150, meanMos: 3.2, bargeInLatencyMs: 420, evaluatedAtMs: 0, pairs: 26 };
  const current = { version: 'v23', meanWer: 0.0293, p95LatencyMs: 1020.5, meanMos: 3.66, bargeInLatencyMs: 260, evaluatedAtMs: 1000, pairs: 26 };
  const delta = compareWithBaselineV23(baseline, current);
  assert.ok(delta.werDelta < 0, 'WER should improve');
  assert.ok(delta.latencyDeltaMs < 0, 'p95 latency should improve');
  assert.ok(delta.mosDelta > 0, 'MOS should improve');
  assert.equal(delta.regressed, false);
  assert.ok(delta.improved.length >= 3, `improved: ${delta.improved.join('; ')}`);
  const worse = compareWithBaselineV23(baseline, { ...current, meanWer: 0.12, meanMos: 2.5 });
  assert.equal(worse.regressed, true);
  assert.ok(worse.regressions.some((r) => r.startsWith('WER regressed')));
  assert.ok(worse.regressions.some((r) => r.startsWith('MOS regressed')));
  // No change at all: no regressions, no improvements.
  const same = compareWithBaselineV23(baseline, baseline);
  assert.equal(same.regressed, false);
  assert.deepEqual(same.improved, []);
  // The harness exposes the same compare.
  assert.equal(createEvalHarnessV23().compare(baseline, current).werDelta, delta.werDelta);
});
