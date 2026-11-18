/**
 * Tests for v1.19 (Team T1-TEST, wave 4) — memory v18 LOCOMO-style eval:
 * packages/core/src/memory/v18/evalLocomo.ts
 *
 * Covers:
 *  - buildV18LocomoDataset (24 cases, 6 per category, 16 seed facts).
 *  - seedV18LocomoDataset (seeds 16 facts, returns key -> id map).
 *  - runV18LocomoEval (per-category scores; single/multi/temporal
 *    6/6; report format).
 *  - formatV18LocomoReport.
 *
 * KNOWN LIMIT (measured, not hidden): the bundled dataset scores
 * 23/24, not 24/24 — case ua-2 (unanswerable, query "so dien
 * thoai di dong") retrieves the unrelated fact "di ung lac"
 * because BM25 matches the token "di". overallPass is therefore
 * false and unanswerable is 5/6, below its 0.9 threshold. The
 * tests pin the measured 23/24 and name the failing case, so a
 * future dataset fix shows up as a change here.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v18-eval-locomo-v119.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  buildV18LocomoDataset,
  seedV18LocomoDataset,
  runV18LocomoEval,
  formatV18LocomoReport,
  V18LocomoEvalError,
  V18_LOCOMO_THRESHOLDS,
  V18_LOCOMO_DEFAULT_TOP_K,
  V18_LOCOMO_DEFAULT_MIN_SCORE,
} from '../packages/core/dist/index.js';

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function seededEval() {
  const store = freshStore();
  const dataset = buildV18LocomoDataset();
  const ids = seedV18LocomoDataset(store, dataset);
  return { store, dataset, ids };
}

test('v18 eval: constants + error name', () => {
  assert.deepEqual(V18_LOCOMO_THRESHOLDS, {
    'single-hop': 0.9,
    'multi-hop': 0.8,
    temporal: 0.8,
    unanswerable: 0.9,
  });
  assert.equal(V18_LOCOMO_DEFAULT_TOP_K, 5);
  assert.equal(V18_LOCOMO_DEFAULT_MIN_SCORE, 0.1);
  const err = new V18LocomoEvalError('boom');
  assert.equal(err.name, 'V18LocomoEvalError');
});

test('v18 eval: dataset has 24 cases (6 per category) + 16 seed facts', () => {
  const dataset = buildV18LocomoDataset();
  assert.equal(dataset.cases.length, 24);
  assert.equal(dataset.seedFacts.length, 16);
  const byCategory = {};
  for (const c of dataset.cases) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  assert.deepEqual(byCategory, {
    'single-hop': 6,
    'multi-hop': 6,
    temporal: 6,
    unanswerable: 6,
  });
  assert.deepEqual(dataset.scope, { userId: 'locomo-user', botId: 'locomo-bot', runId: 'locomo-run' });
  for (const c of dataset.cases) {
    assert.ok(c.id);
    assert.ok(c.question);
    assert.ok(c.queries.length >= 1);
    assert.ok(Array.isArray(c.expectedKeys));
  }
  assert.ok(dataset.seedFacts.every((f) => f.key && f.subjectName && f.predicate && f.objectText));
});

test('v18 eval: seed writes 16 facts and maps every key', () => {
  const { store, dataset, ids } = seededEval();
  assert.equal(ids.size, 16);
  for (const seed of dataset.seedFacts) {
    assert.ok(ids.get(seed.key), `missing id for ${seed.key}`);
    assert.ok(store.getFact(ids.get(seed.key)), `seed fact ${seed.key} not in store`);
  }
  assert.equal(store.listFacts(dataset.scope).length, 16);
});

test('v18 eval: single-hop + multi-hop + temporal all pass 6/6', () => {
  const { store, dataset, ids } = seededEval();
  const result = runV18LocomoEval(store, dataset, ids);
  assert.equal(result.total, 24);
  const scoreOf = (category) => result.byCategory.find((s) => s.category === category);
  assert.equal(scoreOf('single-hop').passed, 6);
  assert.equal(scoreOf('single-hop').rate, 1);
  assert.equal(scoreOf('multi-hop').passed, 6);
  assert.equal(scoreOf('multi-hop').rate, 1);
  assert.equal(scoreOf('temporal').passed, 6);
  assert.equal(scoreOf('temporal').rate, 1);
});

test('v18 eval: measured total is 23/24 — ua-2 fails (see file header)', () => {
  const { store, dataset, ids } = seededEval();
  const result = runV18LocomoEval(store, dataset, ids);
  assert.equal(result.passed, 23);
  assert.equal(result.total, 24);
  const ua = result.byCategory.find((s) => s.category === 'unanswerable');
  assert.equal(ua.passed, 5);
  assert.equal(ua.total, 6);
  assert.deepEqual(result.failingCategories, ['unanswerable']);
  assert.equal(result.overallPass, false);
  const failing = result.cases.filter((c) => !c.pass);
  assert.equal(failing.length, 1);
  assert.equal(failing[0].id, 'ua-2');
  assert.equal(failing[0].category, 'unanswerable');
});

test('v18 eval: case results carry missing keys + best hit count', () => {
  const { store, dataset, ids } = seededEval();
  const result = runV18LocomoEval(store, dataset, ids);
  const sh1 = result.cases.find((c) => c.id === 'sh-1');
  assert.equal(sh1.pass, true);
  assert.deepEqual(sh1.missingKeys, []);
  assert.ok(sh1.bestHitCount >= 1);
  const ua1 = result.cases.find((c) => c.id === 'ua-1');
  assert.equal(ua1.pass, true);
  assert.equal(ua1.bestHitCount, 0, 'unanswerable pass means no hit above minScore');
});

test('v18 eval: formatV18LocomoReport prints totals + failing cases', () => {
  const { store, dataset, ids } = seededEval();
  const result = runV18LocomoEval(store, dataset, ids);
  const text = formatV18LocomoReport(result);
  assert.match(text, /LOCOMO v18: 23\/24 pass \(96%\) — CHUA DAT/);
  assert.match(text, /single-hop: 6\/6 \(100%, nguong 90%\) OK/);
  assert.match(text, /unanswerable: 5\/6 \(83%, nguong 90%\) DUOI NGUONG/);
  assert.match(text, /FAIL ua-2 \[unanswerable\]/);
});

test('v18 eval: topK 1 still passes the single-hop cases it can reach', () => {
  const { store, dataset, ids } = seededEval();
  const result = runV18LocomoEval(store, dataset, ids, { topK: 1 });
  assert.equal(result.total, 24);
  const sh = result.byCategory.find((s) => s.category === 'single-hop');
  assert.ok(sh.passed >= 5, `topK 1 single-hop passed ${sh.passed}/6`);
});
