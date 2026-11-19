/**
 * Tests for memory v25 — LLM judge ADD/UPDATE/DELETE/NOISE + extractor
 * (v1.40, Doi T1). packages/core/src/memory/v25/judge.ts
 *
 * Run after building core (memory/v25 only):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v25-judge-v140.test.mjs
 * No network. No model — rule judge chay local, xac dinh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V25FactEdgeStore,
  applyJudgeDecisionV25,
  createRuleJudgeV25,
  extractCandidateFactsV25,
  hasNegationV25,
  isNoiseTextV25,
  makeJudgeLogEntryV25,
} from '../packages/core/dist/memory/v25/index.js';

function seedStore() {
  const store = new V25FactEdgeStore();
  const added = store.add({ subject: 'Huy', predicate: 'is', object: 'engineer' });
  assert.equal(added.ok, true);
  return { store, existing: added.value };
}

test('v25 judge: ADD khi chua co fact nao cung subject+predicate', () => {
  const judge = createRuleJudgeV25();
  const verdict = judge({
    candidate: { subject: 'Lan', predicate: 'is', object: 'designer' },
    existing: [],
    source: 'test',
  });
  assert.equal(verdict.decision, 'ADD');
  assert.ok(verdict.confidence > 0);
  assert.equal(verdict.matchedFactId, null);
});

test('v25 judge: NOISE khi trung lap y het fact hien co', () => {
  const { existing } = seedStore();
  const judge = createRuleJudgeV25();
  const verdict = judge({
    candidate: { subject: 'Huy', predicate: 'is', object: 'engineer' },
    existing: [existing],
    source: 'test',
  });
  assert.equal(verdict.decision, 'NOISE');
  assert.equal(verdict.matchedFactId, existing.id);
});

test('v25 judge: UPDATE khi cung subject+predicate, object khac', () => {
  const { existing } = seedStore();
  const judge = createRuleJudgeV25();
  const verdict = judge({
    candidate: { subject: 'Huy', predicate: 'is', object: 'manager' },
    existing: [existing],
    source: 'test',
  });
  assert.equal(verdict.decision, 'UPDATE');
  assert.equal(verdict.matchedFactId, existing.id);
  assert.equal(verdict.suggestedObject, 'manager');
});

test('v25 judge: DELETE khi ung vien phu dinh fact hien co', () => {
  const { existing } = seedStore();
  const judge = createRuleJudgeV25();
  const verdict = judge({
    candidate: {
      subject: 'Huy',
      predicate: 'is',
      object: 'engineer',
      sourceText: 'Huy không còn là kỹ sư nữa.',
    },
    existing: [existing],
    source: 'test',
  });
  assert.equal(verdict.decision, 'DELETE');
  assert.equal(verdict.matchedFactId, existing.id);
  // Cung vay voi tieng Anh.
  const verdictEn = judge({
    candidate: {
      subject: 'Huy',
      predicate: 'is',
      object: 'engineer',
      sourceText: 'Huy is no longer an engineer.',
    },
    existing: [existing],
    source: 'test',
  });
  assert.equal(verdictEn.decision, 'DELETE');
});

test('v25 judge: NOISE khi ung vien thieu truong / text rong', () => {
  const judge = createRuleJudgeV25();
  assert.equal(
    judge({ candidate: { subject: '', predicate: 'is', object: 'x' }, existing: [], source: 't' }).decision,
    'NOISE',
  );
  assert.equal(
    judge({ candidate: { subject: 'A', predicate: 'is', object: '' }, existing: [], source: 't' }).decision,
    'NOISE',
  );
  assert.equal(isNoiseTextV25(''), true);
  assert.equal(isNoiseTextV25('hi'), true);
  assert.equal(isNoiseTextV25('Huy là kỹ sư phần mềm.'), false);
});

test('v25 judge: hasNegationV25 nhan dien dau hieu ket thuc', () => {
  assert.equal(hasNegationV25('Huy đã nghỉ việc ở công ty.'), true);
  assert.equal(hasNegationV25('Huy is no longer working there.'), true);
  assert.equal(hasNegationV25('Huy là kỹ sư phần mềm.'), false);
  assert.equal(hasNegationV25('Huy stopped drinking coffee.'), true);
});

test('v25 judge: apply ADD them edge moi', () => {
  const store = new V25FactEdgeStore();
  const res = applyJudgeDecisionV25(
    store,
    { subject: 'Lan', predicate: 'is', object: 'designer' },
    { decision: 'ADD', confidence: 0.8, reason: 'moi', matchedFactId: null, suggestedObject: null },
  );
  assert.equal(res.ok, true);
  assert.equal(res.value.decision, 'ADD');
  assert.ok(res.value.newEdge);
  assert.equal(res.value.closedEdge, null);
  assert.equal(store.size, 1);
});

test('v25 judge: apply UPDATE supersede cu + them moi', () => {
  const { store, existing } = seedStore();
  const res = applyJudgeDecisionV25(
    store,
    { subject: 'Huy', predicate: 'is', object: 'manager' },
    { decision: 'UPDATE', confidence: 0.8, reason: 'doi gia tri', matchedFactId: existing.id, suggestedObject: 'manager' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.value.decision, 'UPDATE');
  assert.ok(res.value.newEdge);
  assert.equal(res.value.closedEdge.id, existing.id);
  assert.equal(store.get(existing.id).status, 'superseded');
  assert.equal(store.queryCurrent().length, 1);
});

test('v25 judge: apply DELETE dong hieu luc, KHONG xoa, KHONG them moi', () => {
  const { store, existing } = seedStore();
  const res = applyJudgeDecisionV25(
    store,
    { subject: 'Huy', predicate: 'is', object: 'engineer', sourceText: 'Huy không còn là kỹ sư.' },
    { decision: 'DELETE', confidence: 0.75, reason: 'phu dinh', matchedFactId: existing.id, suggestedObject: null },
  );
  assert.equal(res.ok, true);
  assert.equal(res.value.decision, 'DELETE');
  assert.equal(res.value.newEdge, null);
  assert.equal(res.value.closedEdge.id, existing.id);
  // Edge van con — khong xoa vat ly.
  assert.ok(store.get(existing.id));
  assert.equal(store.get(existing.id).status, 'superseded');
  assert.equal(store.queryCurrent().length, 0);
  assert.equal(store.size, 1);
});

test('v25 judge: apply DELETE that bai khi khong co matchedFact / fact da dong', () => {
  const { store, existing } = seedStore();
  const noMatch = applyJudgeDecisionV25(
    store,
    { subject: 'Huy', predicate: 'is', object: 'engineer' },
    { decision: 'DELETE', confidence: 0.7, reason: 'x', matchedFactId: null, suggestedObject: null },
  );
  assert.equal(noMatch.ok, false);
  store.closeEdge(existing.id);
  const alreadyClosed = applyJudgeDecisionV25(
    store,
    { subject: 'Huy', predicate: 'is', object: 'engineer' },
    { decision: 'DELETE', confidence: 0.7, reason: 'x', matchedFactId: existing.id, suggestedObject: null },
  );
  assert.equal(alreadyClosed.ok, false);
});

test('v25 judge: apply NOISE khong ghi gi', () => {
  const { store } = seedStore();
  const res = applyJudgeDecisionV25(
    store,
    { subject: 'Huy', predicate: 'is', object: 'engineer' },
    { decision: 'NOISE', confidence: 0.9, reason: 'trung lap', matchedFactId: null, suggestedObject: null },
  );
  assert.equal(res.ok, true);
  assert.equal(res.value.newEdge, null);
  assert.equal(store.size, 1);
});

test('v25 judge: apply quyet dinh la loi', () => {
  const store = new V25FactEdgeStore();
  const res = applyJudgeDecisionV25(
    store,
    { subject: 'A', predicate: 'is', object: 'x' },
    { decision: 'MAYBE', confidence: 0.5, reason: '?', matchedFactId: null, suggestedObject: null },
  );
  assert.equal(res.ok, false);
});

test('v25 extractor: trich fact tu cau tieng Viet + tieng Anh', () => {
  const found = extractCandidateFactsV25(
    'Huy là kỹ sư phần mềm. Huy thích cà phê. Lan lives in Hanoi. Huy works as a manager.',
  );
  assert.ok(found.length >= 3, `ky vong >= 3, duoc ${found.length}`);
  const isFact = found.find((c) => c.predicate === 'is' && c.subject === 'Huy');
  assert.ok(isFact, 'thieu fact Huy is ...');
  assert.equal(isFact.object, 'kỹ sư phần mềm');
  const likes = found.find((c) => c.predicate === 'likes');
  assert.ok(likes);
  assert.equal(likes.object, 'cà phê');
  for (const c of found) {
    assert.ok(c.sentence.length > 0);
  }
});

test('v25 extractor: khong trich cau khong co pattern; gioi han maxCandidates', () => {
  assert.deepEqual(extractCandidateFactsV25('Chao ban! Hom nay troi dep qua.'), []);
  assert.deepEqual(extractCandidateFactsV25(''), []);
  const many = extractCandidateFactsV25('A is x. B is y. C is z. D is w.', { maxCandidates: 2 });
  assert.equal(many.length, 2);
});

test('v25 judge: makeJudgeLogEntryV25 ghi day du truong', () => {
  const entry = makeJudgeLogEntryV25(
    { subject: 'Huy', predicate: 'is', object: 'manager' },
    { decision: 'UPDATE', confidence: 0.8, reason: 'doi gia tri', matchedFactId: 'edge_x', suggestedObject: 'manager' },
    true,
    'UPDATE — them edge ...',
    'test',
    Date.parse('2026-11-18T00:00:00.000Z'),
  );
  assert.equal(entry.decision, 'UPDATE');
  assert.equal(entry.applied, true);
  assert.equal(entry.matchedFactId, 'edge_x');
  assert.equal(entry.at, '2026-11-18T00:00:00.000Z');
  assert.ok(entry.id.startsWith('judge_'));
});
