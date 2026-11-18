/**
 * Tests for v1.17 (Team T1) — memory v16 eval:
 * packages/core/src/memory/v16/eval.ts
 *
 * Covers:
 *  - buildV16EvalDataset: 8 consolidation + 8 linking + 6 validity
 *    + 6 gate cases (28 total).
 *  - runV16Eval on a fresh InMemory store: all categories pass,
 *    overall 28/28, allPassed true, report formats.
 *  - runV16Eval detects a real regression: thresholds + a dataset
 *    with a deliberately wrong expectation fails that category.
 *  - seedV16EvalFact writes a fact the validity query can find.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v16-eval-v117.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  buildV16EvalDataset,
  seedV16EvalFact,
  runV16Eval,
  formatV16EvalReport,
  V16_EVAL_THRESHOLDS,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'eval-user', botId: 'eval-bot', runId: 'eval-run' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

test('v16 eval dataset: 28 case, 4 nhom', () => {
  const dataset = buildV16EvalDataset();
  assert.equal(dataset.consolidation.length, 8);
  assert.equal(dataset.linking.length, 8);
  assert.equal(dataset.validity.length, 6);
  assert.equal(dataset.gate.length, 6);
  assert.deepEqual(V16_EVAL_THRESHOLDS, {
    consolidation: 0.9,
    'entity-linking': 0.9,
    validity: 0.9,
    gate: 0.9,
  });
});

test('v16 eval run: 28/28 dung, moi nhom dat nguong, allPassed', () => {
  const store = freshStore();
  const result = runV16Eval(store, buildV16EvalDataset(), { scope: SCOPE });
  assert.equal(result.total, 28);
  assert.equal(result.passed, 28);
  assert.equal(result.overallScore, 1);
  assert.equal(result.allPassed, true);
  for (const category of ['consolidation', 'entity-linking', 'validity', 'gate']) {
    assert.equal(result.categories[category].score, 1);
    assert.deepEqual(result.categories[category].failures, []);
  }
  const report = formatV16EvalReport(result);
  assert.ok(report.includes('28/28'));
  assert.ok(report.includes('DAT'));
  assert.ok(report.includes('consolidation: 8/8'));
  assert.ok(report.includes('entity-linking: 8/8'));
  assert.ok(report.includes('validity: 6/6'));
  assert.ok(report.includes('gate: 6/6'));
});

test('v16 eval run: ky vong sai co chu y thi nhom do fail va liet ke case', () => {
  const store = freshStore();
  const dataset = buildV16EvalDataset();
  dataset.consolidation[0].expectedOp = 'delete';
  const result = runV16Eval(store, dataset, { scope: SCOPE });
  assert.equal(result.allPassed, false);
  assert.equal(result.passed, 27);
  assert.equal(result.categories.consolidation.score, 7 / 8);
  assert.equal(result.categories.consolidation.failures.length, 1);
  assert.equal(result.categories.consolidation.failures[0].id, 'c01-add-new');
  const report = formatV16EvalReport(result);
  assert.ok(report.includes('CHUA DAT'));
  assert.ok(report.includes('c01-add-new'));
});

test('v16 eval run: nguong cao hon thi allPassed false du van dung het', () => {
  const store = freshStore();
  const result = runV16Eval(store, buildV16EvalDataset(), {
    scope: SCOPE,
    thresholds: { gate: 1.01 },
  });
  assert.equal(result.passed, 28);
  assert.equal(result.allPassed, false);
});

test('v16 eval seed: fact seed vao store, query thay duoc', () => {
  const store = freshStore();
  const fact = seedV16EvalFact(store, SCOPE, {
    subject: 'An',
    predicate: 'likes',
    objectText: 'phở bò',
  });
  assert.equal(fact.objectText, 'phở bò');
  assert.equal(fact.status, 'active');
  assert.equal(store.getFact(fact.id)?.id, fact.id);
});
