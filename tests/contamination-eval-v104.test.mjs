/**
 * Tests for the contamination-free eval runner (packages/core/src/observability/contamination.ts).
 *
 * Covers n-gram tokenisation, scan verdicts (clean/suspect/
 * contaminated), multi-context scans, the hash registry (register /
 * leak check / JSON round-trip without storing eval text), and
 * redaction of eval material from a context.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/contamination-eval-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EvalHashRegistry,
  contaminationTaskReport,
  ngramsOf,
  normalizeTextForContamination,
  scanContamination,
  scanContaminationMany,
  sha256Hex,
  stripEvalMaterial,
  tokenizeForContamination,
} from '../packages/core/dist/observability/contamination.js';

const EVAL = 'the quick brown fox jumps over the lazy dog near the river bank at dawn';
const EVAL_COPY = 'Some notes here. the quick brown fox jumps over the lazy dog near the river bank at dawn. End of notes.';
const EVAL_PARTIAL = 'the quick brown fox jumps over the lazy dog';
const UNRELATED = 'quantum entanglement violates local realism in bell test experiments today';

test('contamination: tokenize + normalize + ngrams', () => {
  assert.equal(normalizeTextForContamination('  Hello,   WORLD!  '), 'hello world');
  assert.deepEqual(tokenizeForContamination('one two  three'), ['one', 'two', 'three']);
  assert.deepEqual(tokenizeForContamination(''), []);
  const grams = ngramsOf('a b c d e', 2);
  assert.deepEqual([...grams].sort(), ['a b', 'b c', 'c d', 'd e']);
  assert.equal(ngramsOf('a b', 8).size, 0, 'text shorter than n yields no n-grams');
  assert.throws(() => ngramsOf('a b c', 0), /positive integer/);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('contamination: clean context scores 0 overlap, verbatim copy is contaminated', () => {
  const clean = scanContamination(EVAL, UNRELATED);
  assert.equal(clean.verdict, 'clean');
  assert.equal(clean.overlapRatio, 0);
  assert.equal(clean.matchedNgramCount, 0);
  const copy = scanContamination(EVAL, EVAL_COPY);
  assert.equal(copy.verdict, 'contaminated');
  assert.equal(copy.overlapRatio, 1);
  assert.ok(copy.matchedNgrams.length > 0);
  assert.match(copy.matchedNgrams[0], /quick brown fox/);
});

test('contamination: partial overlap lands on suspect between the thresholds', () => {
  // EVAL has 8 tokens of n=8? Count: EVAL is 15 words → 8 n-grams of size 8.
  // EVAL_PARTIAL (9 words) shares the first 2 n-grams → 2/8 = 0.25 → contaminated at default.
  const partial = scanContamination(EVAL, EVAL_PARTIAL);
  assert.equal(partial.evalNgramCount, 8);
  assert.equal(partial.matchedNgramCount, 2);
  assert.equal(partial.overlapRatio, 0.25);
  assert.equal(partial.verdict, 'contaminated');
  // With a higher contaminated threshold the same overlap is only suspect.
  const suspect = scanContamination(EVAL, EVAL_PARTIAL, { contaminatedThreshold: 0.5 });
  assert.equal(suspect.verdict, 'suspect');
  // With a tiny overlap it is clean: EVAL_PARTIAL shares 2 of 8 n-grams
  // (0.25), below a custom suspect threshold of 0.3.
  const tiny = scanContamination(EVAL, EVAL_PARTIAL, {
    suspectThreshold: 0.3,
    contaminatedThreshold: 0.6,
  });
  assert.equal(tiny.verdict, 'clean');
  assert.throws(() => scanContamination(EVAL, UNRELATED, { suspectThreshold: 2 }), /between 0 and 1/);
  assert.throws(() => scanContamination(EVAL, UNRELATED, { suspectThreshold: 0.5, contaminatedThreshold: 0.1 }), />= suspectThreshold/);
});

test('contamination: scanContaminationMany reports the worst verdict', () => {
  const result = scanContaminationMany(EVAL, [
    { id: 'clean-doc', text: UNRELATED },
    { id: 'copy-doc', text: EVAL_COPY },
  ]);
  assert.equal(result.worst, 'contaminated');
  assert.equal(result.worstOverlapRatio, 1);
  assert.equal(result.perContext[0].result.verdict, 'clean');
  assert.equal(result.perContext[1].result.verdict, 'contaminated');
});

test('contamination: EvalHashRegistry detects leaks without storing eval text', () => {
  const registry = new EvalHashRegistry(8);
  assert.equal(registry.size, 0);
  const added = registry.register(EVAL);
  assert.equal(added, 8);
  assert.equal(registry.size, 8);
  // Registering the same material again adds nothing.
  assert.equal(registry.register(EVAL), 0);
  // The registry JSON contains only hashes, never the eval text.
  const json = registry.toJSON();
  assert.equal(json.ngramSize, 8);
  assert.equal(json.hashes.length, 8);
  assert.ok(json.hashes.every((h) => /^[0-9a-f]{64}$/.test(h)));
  assert.ok(!JSON.stringify(json).includes('quick brown fox'));
  // Leak check: verbatim copy leaks, unrelated text does not.
  const leak = registry.checkLeak(EVAL_COPY);
  assert.equal(leak.leaked, true);
  assert.ok(leak.matchedNgramCount > 0);
  const noLeak = registry.checkLeak(UNRELATED);
  assert.equal(noLeak.leaked, false);
  assert.equal(noLeak.matchedNgramCount, 0);
  // JSON round-trip preserves the registry.
  const restored = EvalHashRegistry.fromJSON(json);
  assert.equal(restored.size, 8);
  assert.equal(restored.checkLeak(EVAL_COPY).leaked, true);
  assert.throws(() => EvalHashRegistry.fromJSON({ ngramSize: 8, hashes: ['not-a-hash'] }), /SHA-256/);
  assert.throws(() => new EvalHashRegistry(0), /positive integer/);
});

test('contamination: stripEvalMaterial redacts only matching lines', () => {
  const context = [
    'line one is innocent',
    'the quick brown fox jumps over the lazy dog near the river bank at dawn',
    'line three is innocent too',
  ].join('\n');
  const { redacted, redactedLines, matchedNgramCount } = stripEvalMaterial(context, [EVAL]);
  const lines = redacted.split('\n');
  assert.equal(lines[0], 'line one is innocent');
  assert.equal(lines[1], '[EVAL MATERIAL REDACTED]');
  assert.equal(lines[2], 'line three is innocent too');
  assert.equal(redactedLines, 1);
  assert.ok(matchedNgramCount > 0);
  // Nothing to redact when there is no overlap.
  const clean = stripEvalMaterial(context, [UNRELATED]);
  assert.equal(clean.redactedLines, 0);
  assert.equal(clean.redacted, context);
  // Custom placeholder.
  const custom = stripEvalMaterial(context, [EVAL], { placeholder: '***' });
  assert.equal(custom.redacted.split('\n')[1], '***');
});

test('contamination: contaminationTaskReport states the method honestly', () => {
  const scan = scanContamination(EVAL, EVAL_COPY);
  const report = contaminationTaskReport('task-1', scan);
  assert.equal(report.taskId, 'task-1');
  assert.equal(report.verdict, 'contaminated');
  assert.equal(report.overlapRatio, 1);
  assert.match(report.method, /8-gram/);
  assert.match(report.method, /paraphrase/);
});
