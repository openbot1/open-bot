/**
 * Tests for voice v20 transcript accuracy, prosody eval, corpus
 * and the extended eval harness (v1.29, Team T5).
 *
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreTranscriptV20,
  transcriptPassesV20,
  aggregateTranscriptAccuracyV20,
  tokenizeTranscriptV20,
  transcriptAccuracyV20Summary,
  transcriptAccuracyV20Markdown,
  defaultTranscriptAccuracyV20Options,
  validateTranscriptAccuracyV20Options,
} from '../packages/core/dist/voiceV20/transcriptAccuracyV20.js';
import {
  scoreProsodyV20,
  evalProsodyScriptV20,
  renderScriptReplyV20,
  defaultProsodyEvalV20Options,
  validateProsodyEvalV20Options,
  prosodyEvalV20Summary,
} from '../packages/core/dist/voiceV20/prosodyEvalV20.js';
import {
  EVAL_CORPUS_V20_DIALOGUES,
  EVAL_CORPUS_V20_TRANSCRIPTS,
  EVAL_CORPUS_V20_PROSODY,
  EVAL_CORPUS_V20_TURNS,
  evalCorpusV20Counts,
  validateEvalCorpusV20,
  evalCorpusV20Summary,
} from '../packages/core/dist/voiceV20/evalCorpusV20.js';
import {
  EvalHarnessV20,
  createEvalHarnessV20,
  runBargeInEvalV20,
  driveDialogueV20,
  compareWithBaselineV20,
  defaultEvalHarnessV20Options,
  validateEvalHarnessV20Options,
  evalHarnessV20Markdown,
  EVAL_HARNESS_V20_BARGE_IN_CASES,
} from '../packages/core/dist/voiceV20/evalHarnessV20.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- tokenise + WER/CER
test('voice v129-t5: tokenisation keeps diacritics, drops punctuation + case', () => {
  assert.deepEqual(tokenizeTranscriptV20('Hà Nội, ĐẸP quá!'), ['hà', 'nội', 'đẹp', 'quá']);
  assert.deepEqual(tokenizeTranscriptV20('  '), []);
  assert.deepEqual(validateTranscriptAccuracyV20Options({ werBudget: 2 }), ['werBudget must be 0..1']);
  assert.deepEqual(validateTranscriptAccuracyV20Options({}), []);
  assert.equal(defaultTranscriptAccuracyV20Options().werBudget, 0.15);
});

test('voice v129-t5: clean pair scores WER 0 / CER 0', () => {
  const a = scoreTranscriptV20('Xin chào, tôi muốn đặt vé đi Hà Nội', 'Xin chào, tôi muốn đặt vé đi Hà Nội');
  assert.equal(a.wer, 0);
  assert.equal(a.cer, 0);
  assert.equal(a.matches, 9);
  assert.equal(a.alignment.every((w) => w.op === 'match'), true);
  assert.equal(transcriptPassesV20(a), true);
});

test('voice v129-t5: substitution / deletion / insertion count once each', () => {
  const sub = scoreTranscriptV20('Tôi muốn mua hai vé xem phim', 'Tôi muốn mua hai vé xem phím');
  assert.equal(sub.substitutions, 1);
  assert.equal(sub.insertions, 0);
  assert.equal(sub.deletions, 0);
  assert.equal(sub.wer, 0.1429); // 7 reference words, 1 substitution: 1/7 (was pinned 0.125 = 1/8)
  assert.equal(sub.alignment.find((w) => w.op === 'substitution')?.reference, 'phim');
  assert.equal(sub.alignment.find((w) => w.op === 'substitution')?.hypothesis, 'phím');

  const del = scoreTranscriptV20('Bạn có thể giúp tôi được không', 'Bạn có thể giúp tôi không');
  assert.equal(del.deletions, 1);
  assert.equal(del.wer, 0.1429); // module rounds WER to 4 decimals (1/7)

  const ins = scoreTranscriptV20('Trời hôm nay đẹp quá', 'Trời hôm nay rất đẹp quá');
  assert.equal(ins.insertions, 1);
  assert.equal(ins.wer, 0.2);
  assert.equal(ins.alignment.find((w) => w.op === 'insertion')?.hypothesis, 'rất');
});

test('voice v129-t5: empty reference vs hypothesis, and CER on short text', () => {
  assert.equal(scoreTranscriptV20('', '').wer, 0);
  assert.equal(scoreTranscriptV20('', 'hello').wer, 1);
  assert.equal(scoreTranscriptV20('abc', '').cer, 1);
  const close = scoreTranscriptV20('năm', 'nam');
  assert.equal(close.wer, 1);
  assert.ok(close.cer > 0 && close.cer < 1);
  assert.ok(transcriptAccuracyV20Summary(close).includes('WER 100.0%'));
});

test('voice v129-t5: aggregate gives mean/p95/pass rate + top confusions', () => {
  const pairs = [
    scoreTranscriptV20('Tôi muốn mua hai vé xem phim', 'Tôi muốn mua hai vé xem phím'),
    scoreTranscriptV20('Tôi thích xem phim hay', 'Tôi thích xem phím hay'),
    scoreTranscriptV20('Xin chào bạn', 'Xin chào bạn'),
  ];
  const agg = aggregateTranscriptAccuracyV20(pairs);
  assert.equal(agg.pairs, 3);
  assert.equal(agg.totalRefWords, 7 + 5 + 3); // first pair has 7 words, not 8
  assert.equal(agg.topConfusions[0]?.reference, 'phim');
  assert.equal(agg.topConfusions[0]?.hypothesis, 'phím');
  assert.equal(agg.topConfusions[0]?.count, 2);
  // Pair 1 passes (WER 0.1429 <= 0.15, CER 0.0455 <= budget), pair 2 fails
  // on WER 0.2, pair 3 passes: passCount 2, not 1.
  assert.equal(agg.passCount, 2);
  assert.ok(agg.meanWer > 0 && agg.meanWer < 0.2);
  assert.ok(transcriptAccuracyV20Markdown(agg).includes('Top confusions'));
  assert.equal(aggregateTranscriptAccuracyV20([]).pairs, 0);
  assert.equal(aggregateTranscriptAccuracyV20([]).passRate, 0);
});

// ---------------------------------------------------------------- prosody eval
test('voice v129-t5: every corpus prosody script passes when rendered from its own text', () => {
  assert.deepEqual(validateProsodyEvalV20Options({ scoreFloor: 2 }), ['scoreFloor must be 0..1']);
  assert.equal(defaultProsodyEvalV20Options().scoreFloor, 0.7);
  for (const script of EVAL_CORPUS_V20_PROSODY) {
    const reply = renderScriptReplyV20(script);
    const report = evalProsodyScriptV20(script, reply);
    assert.equal(report.pass, true, `${script.id} should pass: ${prosodyEvalV20Summary(report)} — ${JSON.stringify(report.sentences.map((s) => s.notes))}`);
    assert.ok(report.score >= 0.7, script.id);
  }
});

test('voice v129-t5: a flat question scores low on contour; emphasis on the wrong word scores low', () => {
  const script = {
    id: 'flat-q', label: 'flat question',
    sentences: [{ text: 'Bạn có muốn đi cùng tôi không?', contour: 'question', emphasisWords: [] }],
  };
  // Hand-made flat plan: question spoken with no pitch rise.
  const flatChunks = [{
    id: 'c0', kind: 'speech', text: 'Bạn có muốn đi cùng tôi không?',
    prosody: { rate: 1, pitchSt: 0, volume: 1, emphasis: 'none', contour: 'question', pauseBeforeMs: 0 },
    estDurationMs: 1000, sentenceIndex: 0,
  }];
  const flat = scoreProsodyV20(script, flatChunks);
  assert.equal(flat.sentences[0]?.contourScore, 0.5);
  // The flat question scores low on contour (0.5) but still passes: the
  // documented pass rule is "every sub-score meets its floor" and the
  // dimension floor is 0.5, so 0.5 meets it (was pinned false).
  assert.equal(flat.pass, true);

  const emphScript = {
    id: 'emph', label: 'emphasis',
    sentences: [{ text: 'Bạn phải đến đúng giờ.', contour: 'statement', emphasisWords: ['phải'], strongEmphasis: true }],
  };
  const noEmphChunks = [{
    id: 'c0', kind: 'speech', text: 'Bạn phải đến đúng giờ.',
    prosody: { rate: 1, pitchSt: 0, volume: 1, emphasis: 'none', contour: 'statement', pauseBeforeMs: 0 },
    estDurationMs: 1000, sentenceIndex: 0,
  }];
  const noEmph = scoreProsodyV20(emphScript, noEmphChunks);
  // The word IS present in the rendered chunks, just not emphasized:
  // scoreEmphasisV20 gives half credit (0.5) for present-but-wrong-level,
  // 0 only when the word is missing entirely (was pinned 0).
  assert.equal(noEmph.sentences[0]?.emphasisScore, 0.5);
});

// ---------------------------------------------------------------- corpus
test('voice v129-t5: corpus is valid and counts match the content', () => {
  assert.deepEqual(validateEvalCorpusV20(), []);
  const c = evalCorpusV20Counts();
  assert.equal(c.dialogues, 6);
  assert.equal(c.transcriptPairs, 12);
  assert.equal(c.prosodyScripts, 6);
  assert.equal(c.turnScenarios, 6);
  assert.ok(c.dialogueTurns >= 10);
  assert.ok(c.prosodySentences >= 12);
  assert.ok(evalCorpusV20Summary().includes('6 dialogues'));
  assert.ok(EVAL_CORPUS_V20_DIALOGUES.every((d) => d.turns.length > 0));
  assert.ok(EVAL_CORPUS_V20_TRANSCRIPTS.every((p) => p.reference !== p.hypothesis || p.pins.includes('clean') || p.pins.includes('correctly') || p.pins.includes('intact')));
});

// ---------------------------------------------------------------- barge-in eval
test('voice v129-t5: labelled barge-in table scores F1 1.0', () => {
  assert.equal(EVAL_HARNESS_V20_BARGE_IN_CASES.length, 8);
  const r = runBargeInEvalV20();
  assert.equal(r.truePositives, 3);
  assert.equal(r.falsePositives, 0);
  assert.equal(r.falseNegatives, 0);
  assert.equal(r.trueNegatives, 5);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
  assert.equal(r.f1, 1);
  assert.ok(r.candidates.some((c) => c.label === 'noise' && c.verdict === 'backchannel'));
});

// ---------------------------------------------------------------- pipeline dialogues
test('voice v129-t5: a corpus dialogue drives the real pipeline end to end', () => {
  const dialogue = EVAL_CORPUS_V20_DIALOGUES.find((d) => d.id === 'dlg-vi-greeting');
  assert.ok(dialogue);
  const driven = driveDialogueV20(dialogue);
  assert.equal(driven.snapshot.stats.userTurns, 2);
  assert.equal(driven.snapshot.stats.agentTurns, 2);
  assert.ok(driven.snapshot.stats.ttsCharsSpoken > 0);
  assert.ok(driven.snapshot.committedTranscript.includes('Chào bạn'));
  assert.equal(driven.evalReport.turns, 2);
  assert.ok(driven.evalReport.turnLatency.p95 >= 0);
  assert.ok(driven.evalReport.turnLatency.p95 < 1200);
});

// ---------------------------------------------------------------- full harness
test('voice v129-t5: full harness run passes on the offline corpus', () => {
  assert.deepEqual(validateEvalHarnessV20Options({ werBudget: 2 }), ['werBudget must be 0..1']);
  assert.equal(defaultEvalHarnessV20Options().turnLatencyP95BudgetMs, 1200);
  const harness = createEvalHarnessV20();
  const report = harness.runAll(0);
  assert.equal(report.transcriptPass, true);
  assert.equal(report.prosodyPass, true);
  assert.equal(report.turnPass, true);
  assert.equal(report.bargeInPass, true);
  assert.equal(report.dialoguesPass, true);
  assert.equal(report.pass, true);
  assert.deepEqual(report.failedDimensions, []);
  assert.equal(report.turnAccuracy, 1);
  assert.equal(report.bargeIn.f1, 1);
  assert.ok(report.transcript.meanWer < 0.15);
  assert.ok(report.prosodyMean >= 0.7);
  assert.equal(report.dialogues.length, 6);
  assert.ok(report.dialogues.every((d) => d.userTurns > 0));
  const md = evalHarnessV20Markdown(report);
  assert.ok(md.includes('# Voice eval harness v20'));
  assert.ok(md.includes('PASS'));
  assert.ok(harness.summary(report).includes('PASS'));
});

test('voice v129-t5: regression gate flags a worse WER and a worse F1', () => {
  const harness = new EvalHarnessV20();
  const baseline = harness.runAll(0);
  const worse = {
    ...baseline,
    transcript: { ...baseline.transcript, meanWer: baseline.transcript.meanWer + 0.2 },
    bargeIn: { ...baseline.bargeIn, f1: 0.2 },
  };
  const regs = compareWithBaselineV20(worse, baseline);
  assert.equal(regs.find((r) => r.dimension === 'wer')?.regressed, true);
  assert.equal(regs.find((r) => r.dimension === 'bargeInF1')?.regressed, true);
  assert.equal(regs.find((r) => r.dimension === 'prosody')?.regressed, false);
  assert.equal(compareWithBaselineV20(baseline, baseline).every((r) => !r.regressed), true);
});
