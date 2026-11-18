/**
 * Tests for memory v21 — cross-session sleep consolidation (v1.29, Doi T1).
 * packages/core/src/memory/v21/sleepConsolidationV21.ts
 * (noi tiep V20SleepConsolidator — v20 test rieng o
 * tests/memory-v20-core-blocks-v128.test.mjs)
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v21-sleep-v129.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { V20CoreBlockStore } from '../packages/core/dist/memory/v20/index.js';
import {
  V21CrossSessionConsolidator,
  V21RecordStore,
  countDistinctSessionsV21,
  recordToOkfV21,
} from '../packages/core/dist/memory/v21/index.js';

const NOW = 1794000000000;

function fact(text, sessionId, confidence = 0.8, observedAt = Date.now()) {
  return { text, source: 'chat', confidence, observedAt, sessionId };
}

test('v21 sleep: fact gap o 2 session duoc boost + ledger ghi du session', () => {
  const c = new V21CrossSessionConsolidator();
  const res = c.addSessionFacts([
    { sessionId: 's1', facts: [fact('User thich ca phe den.', 's1')] },
    { sessionId: 's2', facts: [fact('User thich ca phe den.', 's2')] },
    { sessionId: 's3', facts: [fact('User thich tra dao chieu.', 's3')] },
  ]);
  assert.equal(res.received, 3);
  assert.equal(res.boosted, 1);
  assert.equal(c.sessionsSeen(), 3);
  // Ledger: fact ca phe gap o 2 session, fact tra chi 1.
  const coffeeKey = 'user-thich-ca-phe-den';
  const info = c.ledgerInfo(coffeeKey);
  assert.ok(info);
  assert.deepEqual(info.sessions, ['s1', 's2']);
  // Pool: fact trung trong batch bi dedupe o tang v20 (cung text).
  assert.equal(c.poolSize(), 2);
  const pooled = c.exportState().pool;
  const coffee = pooled.find((f) => f.text.includes('ca phe'));
  assert.ok(coffee.confidence > 0.8, 'confidence da duoc boost');
  assert.ok(coffee.confidence <= 0.95);
});

test('v21 sleep: runCrossSessionPass promote vao block + ghi portable store + stale', () => {
  const c = new V21CrossSessionConsolidator();
  const blocks = new V20CoreBlockStore();
  const portable = new V21RecordStore();
  // Record cu da qua stale_after -> se bi danh dau stale.
  portable.create(
    {
      id: 'old-note',
      type: 'note',
      title: 'Ghi chu cu',
      body: 'Noi dung cu.',
      tags: [],
      sources: [],
      codeRefs: [],
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      staleAfter: '2020-01-01',
    },
    'tester',
  );
  c.addSessionFacts([
    { sessionId: 's1', facts: [fact('User thich ca phe den moi sang.', 's1', 0.9)] },
    { sessionId: 's2', facts: [fact('User thich ca phe den moi sang.', 's2', 0.9)] },
  ]);
  const report = c.runCrossSessionPass(blocks, portable, { exportOkf: true, trigger: 'session_end' });
  assert.equal(report.trigger, 'session_end');
  assert.equal(report.sessionsSeen, 2);
  assert.equal(report.crossSessionFacts, 1);
  assert.equal(report.factsPromoted, 1);
  assert.ok(report.blocksUpdated.includes('facts'));
  assert.deepEqual(report.staleMarked, ['old-note']);
  assert.equal(report.errors.length, 0);
  // Fact da promote vao core block facts.
  const block = blocks.getBlock('facts');
  assert.ok(block);
  assert.match(block.value, /User thich ca phe den moi sang/);
  // Va co record sleep-promoted trong portable store.
  const promoted = portable.list().filter((r) => r.tags.includes('sleep-promoted'));
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].type, 'fact');
  assert.ok(promoted[0].sources.some((s) => s.startsWith('sleep:sleep-v21-')));
  assert.deepEqual(report.exportedOkfFiles, [`${promoted[0].id}.md`]);
  // Xuat OKF cua record da promote.
  const files = c.exportPromotedAsOkf(portable);
  assert.equal(files.length, 1);
  assert.match(files[0].content, /^---\ntype: fact\n/);
  assert.match(files[0].content, /User thich ca phe den moi sang/);
  assert.equal(c.getLastReport().jobId, report.jobId);
});

test('v21 sleep: exportState/importState giu ledger + pool qua restart', () => {
  const c1 = new V21CrossSessionConsolidator();
  c1.addSessionFacts([
    { sessionId: 's1', facts: [fact('User thich ca phe.', 's1')] },
    { sessionId: 's2', facts: [fact('User thich ca phe.', 's2')] },
  ]);
  const state = c1.exportState();
  assert.equal(state.sessions.length, 2);
  assert.equal(state.pool.length, 1);
  const c2 = new V21CrossSessionConsolidator();
  c2.importState(state);
  assert.equal(c2.sessionsSeen(), 2);
  assert.equal(c2.poolSize(), 1);
  assert.deepEqual(c2.ledgerInfo('user-thich-ca-phe').sessions, ['s1', 's2']);
  // Them session thu 3 cung fact -> van boost (ledger da co 2 session).
  const res = c2.addSessionFacts([{ sessionId: 's3', facts: [fact('User thich ca phe.', 's3')] }]);
  assert.equal(res.boosted, 1);
});

test('v21 sleep: countDistinctSessionsV21 + recordToOkfV21 export shape', () => {
  const facts = [
    fact('A.', 's1'),
    fact('B.', 's1'),
    fact('C.', 's2'),
    { text: 'D.', source: 'chat', confidence: 0.5, observedAt: NOW },
  ];
  assert.equal(countDistinctSessionsV21(facts), 3);
  const record = {
    id: 'x',
    type: 'fact',
    title: 'T',
    body: 'B.',
    tags: [],
    sources: [],
    codeRefs: [],
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  assert.match(recordToOkfV21(record), /^---\ntype: fact\ntitle: T\n---\n\nB\.\n$/);
});
