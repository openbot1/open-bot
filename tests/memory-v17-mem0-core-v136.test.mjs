/**
 * Tests for v1.36 (Team T1) — memory v17 mem0-style core:
 * packages/core/src/memoryV17/{types,extraction,entities,conflicts,
 * biTemporal,fusion,scope,store,eval}.ts
 *
 * Covers:
 *  - extraction: single-pass ADD-only (rule VI+EN, noise filtered,
 *    negation -> dislikes, validity window parsed, dedupe in-pass,
 *    LLM called at most once per pass, userTurnsOnly).
 *  - entities: <name>_entities collection, getOrCreate + alias index,
 *    typed edge dedupe, merge (aliases/edges move, source kept merged),
 *    suggest (exact/prefix/substring), orphan prune, scope enforcement.
 *  - conflicts: single-valued conflict, multi-valued no conflict,
 *    duplicate, negation vs positive, auto overwrite only when old is
 *    weak, merge blocked for single-valued, overwrite needs reason,
 *    queue enqueue/resolve/audit.
 *  - biTemporal: queryAt (valid time), asKnownAt (transaction time),
 *    invalidate keeps the row, supersede closes validTo + points at
 *    the new fact, timeline steps, supersession chain.
 *  - fusion: entity query ranks the matching fact first, BM25 rare
 *    keyword wins, time-aware prefers the newer fact, score breakdown
 *    in [0,1], cross-scope facts never leak, empty query rejected.
 *  - scope: strict matcher (empty is NOT a wildcard), cross-scope read
 *    denied + violation logged, grant opens read, expired grant does
 *    not, leak scan finds invalid scopes.
 *  - store: ingest end-to-end (extract -> conflict -> add -> link),
 *    duplicate bumps confidence, pending overwrite resolved by user,
 *    serialize/deserialize round-trip, stats.
 *  - eval: 40 cases run, all pass, thresholds met.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v17-mem0-core-v136.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  M17BiTemporalStore,
  M17ConflictQueue,
  M17EntityStore,
  M17ScopeGuard,
  M17Store,
  autoResolveStrategyM17,
  buildM17EvalDataset,
  checkReadAccessM17,
  classifyTurnNoiseM17,
  detectConflictsM17,
  detectNegationM17,
  entityCollectionNameM17,
  extractTurnsSinglePassM17,
  formatLeakReportM17,
  fusionSearchM17,
  hashEmbeddingM17,
  cosineSimilarityM17,
  mergeObjectsM17,
  parseValidityWindowM17,
  runM17Eval,
  scanForScopeLeaksM17,
  scopeKeyM17,
  scopesEqualM17,
  validateResolutionM17,
  validateScopeM17,
} from '../packages/core/dist/index.js';

const SCOPE_A = { tenantId: '', userId: 'user-a', botId: 'bot-1', conversationId: 'conv-1' };
const SCOPE_B = { tenantId: '', userId: 'user-b', botId: 'bot-1', conversationId: 'conv-1' };

function provenanceFor(scope) {
  return {
    episodeId: 'eval-ep',
    turnId: 'eval-turn',
    runId: 'eval-run',
    botId: scope.botId,
    userId: scope.userId,
    sourceText: 'test',
  };
}

function candidate(edge, object, confidence = 0.85, extra = {}) {
  return {
    subject: 'user',
    edge,
    object,
    confidence,
    isNegation: false,
    validFrom: null,
    validTo: null,
    mentionedEntities: [{ name: object, kind: 'other' }],
    sourceText: `Tôi ${edge} ${object}.`,
    ...extra,
  };
}

// ---------- types / scope helpers ----------

test('types: entity collection name + scope key + strict equality', () => {
  assert.equal(entityCollectionNameM17('memory_v17'), 'memory_v17_entities');
  assert.equal(scopeKeyM17(SCOPE_A), '/user-a/bot-1/conv-1');
  assert.equal(scopesEqualM17(SCOPE_A, { ...SCOPE_A }), true);
  assert.equal(scopesEqualM17(SCOPE_A, SCOPE_B), false);
  assert.equal(validateScopeM17(SCOPE_A), null);
  assert.equal(validateScopeM17({ tenantId: '', userId: '', botId: '', conversationId: '' }) !== null, true);
});

test('types: scope with dangerous chars rejected', () => {
  const bad = { tenantId: 'a/b', userId: 'u', botId: '', conversationId: '' };
  assert.notEqual(validateScopeM17(bad), null);
});

// ---------- extraction ----------

test('extraction: prefers + lives_in + works_at (VI + EN)', async () => {
  const res = await extractTurnsSinglePassM17([
    { role: 'user', text: 'Tôi rất thích ăn phở bò.', episodeId: 'e1', turnId: 't1' },
    { role: 'user', text: 'Tôi đang sống ở Đà Nẵng.', episodeId: 'e1', turnId: 't2' },
    { role: 'user', text: 'I work at Acme Corp.', episodeId: 'e1', turnId: 't3' },
  ]);
  assert.equal(res.llmCalls, 0);
  assert.equal(res.noiseTurns, 0);
  assert.ok(res.candidates.some((c) => c.edge === 'prefers' && c.object.includes('phở')));
  assert.ok(res.candidates.some((c) => c.edge === 'lives_in' && c.object.includes('Đà Nẵng')));
  assert.ok(res.candidates.some((c) => c.edge === 'works_at' && c.object.includes('Acme')));
});

test('extraction: noise filtered, assistant turns skipped', async () => {
  const res = await extractTurnsSinglePassM17([
    { role: 'user', text: 'Xin chào bạn!', episodeId: 'e1', turnId: 't1' },
    { role: 'user', text: 'Hôm nay trời thế nào?', episodeId: 'e1', turnId: 't2' },
    { role: 'assistant', text: 'Tôi thích ăn phở bò.', episodeId: 'e1', turnId: 't3' },
    { role: 'user', text: 'Cảm ơn bạn.', episodeId: 'e1', turnId: 't4' },
  ]);
  assert.equal(res.candidates.length, 0);
  assert.ok(res.noiseTurns >= 3);
});

test('extraction: negation, validity window, dedupe in pass', async () => {
  assert.equal(detectNegationM17('Tôi không còn thích ăn phở bò nữa.'), true);
  assert.equal(detectNegationM17('Tôi thích ăn phở bò.'), false);
  const win = parseValidityWindowM17('Từ tháng 3/2026 tôi sống ở Đà Nẵng.');
  assert.ok(win?.validFrom?.startsWith('2026-03-01'));
  const res = await extractTurnsSinglePassM17([
    { role: 'user', text: 'Tôi không còn thích ăn phở bò nữa.', episodeId: 'e1', turnId: 't1' },
    { role: 'user', text: 'Tôi thích ăn phở bò. Tôi thích ăn phở bò.', episodeId: 'e1', turnId: 't2' },
  ]);
  assert.ok(res.candidates.some((c) => c.edge === 'dislikes'));
  assert.equal(res.dedupedWithinPass, 1);
});

test('extraction: LLM called at most once per pass; failure does not break pass', async () => {
  let calls = 0;
  const res = await extractTurnsSinglePassM17(
    [
      { role: 'user', text: 'Tôi thích ăn phở bò.', episodeId: 'e1', turnId: 't1' },
      { role: 'user', text: 'Tôi sống ở Hà Nội.', episodeId: 'e1', turnId: 't2' },
    ],
    {
      llmExtract: async () => {
        calls += 1;
        return [candidate('owns', 'xe máy Honda')];
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(res.llmCalls, 1);
  assert.ok(res.candidates.some((c) => c.object.includes('Honda')));

  const failing = await extractTurnsSinglePassM17(
    [{ role: 'user', text: 'Tôi thích ăn phở bò.', episodeId: 'e1', turnId: 't1' }],
    {
      llmExtract: async () => {
        throw new Error('llm down');
      },
    },
  );
  assert.ok(failing.candidates.some((c) => c.edge === 'prefers'));
});

test('extraction: classifyTurnNoise + low confidence filtered', async () => {
  assert.equal(classifyTurnNoiseM17('Xin chào'), 'greeting');
  assert.equal(classifyTurnNoiseM17('Cảm ơn'), 'filler');
  assert.equal(classifyTurnNoiseM17('Tôi thích ăn phở bò.'), null);
  const res = await extractTurnsSinglePassM17(
    [{ role: 'user', text: 'Tôi thích ăn phở bò.', episodeId: 'e1', turnId: 't1' }],
    { minConfidence: 0.99 },
  );
  assert.equal(res.candidates.length, 0);
  assert.ok(res.belowThreshold >= 1);
});

// ---------- entities ----------

test('entities: getOrCreate + alias index + typed edge dedupe', () => {
  const store = new M17EntityStore({ factCollection: 'memory_v17' });
  assert.equal(store.entityCollection, 'memory_v17_entities');
  const now = '2026-11-18T00:00:00.000Z';
  const a = store.getOrCreate('Đà Nẵng', 'place', SCOPE_A, now);
  assert.equal(a.created, true);
  const b = store.getOrCreate('Đà Nẵng', 'place', SCOPE_A, now);
  assert.equal(b.created, false);
  assert.equal(b.entity.id, a.entity.id);
  store.addAlias(a.entity.id, 'DN', SCOPE_A);
  const found = store.findByName('dn', SCOPE_A);
  assert.equal(found?.id, a.entity.id);
  // Other scope cannot see it.
  assert.equal(store.findByName('Đà Nẵng', SCOPE_B), null);
  // Edge dedupe.
  const user = store.getOrCreate('user:user-a', 'person', SCOPE_A, now);
  const e1 = store.getOrCreateEdge(user.entity.id, a.entity.id, 'lives_in', SCOPE_A, null, 0.9, now);
  const e2 = store.getOrCreateEdge(user.entity.id, a.entity.id, 'lives_in', SCOPE_A, null, 0.9, now);
  assert.equal(e1.created, true);
  assert.equal(e2.created, false);
  assert.equal(e1.edge.id, e2.edge.id);
});

test('entities: linkFact creates subject/object entities + edge', () => {
  const store = new M17EntityStore();
  const now = '2026-11-18T00:00:00.000Z';
  const link = store.linkFact(candidate('lives_in', 'Hà Nội'), SCOPE_A, now, 'fact-1');
  assert.equal(link.createdSubject, true);
  assert.equal(link.createdObject, true);
  assert.equal(link.createdEdge, true);
  assert.equal(link.edge.edge, 'lives_in');
  assert.equal(link.objectEntity.factCount, 1);
  const again = store.linkFact(candidate('lives_in', 'Hà Nội'), SCOPE_A, now, 'fact-2');
  assert.equal(again.createdSubject, false);
  assert.equal(again.createdEdge, false);
  assert.equal(again.objectEntity.factCount, 2);
});

test('entities: suggest exact/prefix/substring; merge moves aliases+edges', () => {
  const store = new M17EntityStore();
  const now = '2026-11-18T00:00:00.000Z';
  const hanoi = store.getOrCreate('Hà Nội', 'place', SCOPE_A, now).entity;
  store.getOrCreate('Hải Phòng', 'place', SCOPE_A, now);
  const suggestions = store.suggestEntities('Hà', SCOPE_A);
  assert.ok(suggestions.some((s) => s.entity.id === hanoi.id && s.score >= 0.6));
  const capital = store.getOrCreate('Thu do Ha Noi', 'place', SCOPE_A, now).entity;
  store.addAlias(capital.id, 'HN', SCOPE_A);
  const merged = store.mergeEntities(capital.id, hanoi.id, SCOPE_A, 'Cung mot thanh pho.');
  assert.equal(merged.survivor.id, hanoi.id);
  assert.equal(merged.merged.status, 'merged');
  assert.equal(merged.merged.mergedIntoId, hanoi.id);
  assert.ok(merged.aliasesMoved >= 1);
  assert.equal(store.findByName('HN', SCOPE_A)?.id, hanoi.id);
});

test('entities: alias clash + cross-scope merge rejected; orphan prune', () => {
  const store = new M17EntityStore();
  const now = '2026-11-18T00:00:00.000Z';
  const a = store.getOrCreate('Hà Nội', 'place', SCOPE_A, now).entity;
  const b = store.getOrCreate('Đà Nẵng', 'place', SCOPE_A, now).entity;
  assert.throws(() => store.addAlias(b.id, 'Hà Nội', SCOPE_A), /thuoc entity khac/);
  const c = store.getOrCreate('Huế', 'place', SCOPE_B, now).entity;
  assert.throws(() => store.mergeEntities(a.id, c.id, SCOPE_A, 'x'), /cung scope/);
  assert.throws(() => store.mergeEntities(a.id, a.id, SCOPE_A, 'x'), /chinh no/);
  // Orphans: both a and b have factCount 0.
  assert.equal(store.orphanEntities(SCOPE_A).length, 2);
  assert.equal(store.pruneOrphans(SCOPE_A), 2);
  assert.equal(store.entityCount, 1); // only SCOPE_B entity remains
});

// ---------- conflicts ----------

test('conflicts: single-valued conflict, multi-valued none, duplicate', () => {
  const store = new M17BiTemporalStore();
  const old = store.addFact(candidate('lives_in', 'Hà Nội', 0.9), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-01-01T00:00:00.000Z',
  });
  const oldPref = store.addFact(candidate('prefers', 'phở bò', 0.9), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-01-01T00:00:00.000Z',
  });
  const now = '2026-11-18T00:00:00.000Z';
  const conflict = detectConflictsM17(candidate('lives_in', 'Đà Nẵng'), [old], SCOPE_A, now);
  assert.equal(conflict.length, 1);
  assert.notEqual(conflict[0].kind, 'duplicate');
  assert.equal(detectConflictsM17(candidate('prefers', 'bún chả'), [oldPref], SCOPE_A, now).length, 0);
  const dup = detectConflictsM17(candidate('prefers', 'phở bò'), [oldPref], SCOPE_A, now);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].kind, 'duplicate');
  assert.ok(dup[0].severity < 0.5);
});

test('conflicts: auto strategy — weak old overwritten, strong old pending', () => {
  const store = new M17BiTemporalStore();
  const weak = store.addFact(candidate('lives_in', 'Hà Nội', 0.5), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-01-01T00:00:00.000Z',
  });
  const strong = store.addFact(candidate('works_at', 'Acme', 0.95), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-01-01T00:00:00.000Z',
  });
  const now = '2026-11-18T00:00:00.000Z';
  const cWeak = detectConflictsM17(candidate('lives_in', 'Đà Nẵng', 0.9), [weak], SCOPE_A, now)[0];
  assert.equal(autoResolveStrategyM17(cWeak, 0.5, 0.9), 'overwrite');
  const cStrong = detectConflictsM17(candidate('works_at', 'Beta', 0.9), [strong], SCOPE_A, now)[0];
  assert.equal(autoResolveStrategyM17(cStrong, 0.95, 0.9), 'pending');
});

test('conflicts: validateResolution blocks merge on single-valued + overwrite without reason', () => {
  const store = new M17BiTemporalStore();
  const old = store.addFact(candidate('lives_in', 'Hà Nội', 0.9), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-01-01T00:00:00.000Z',
  });
  const conflict = detectConflictsM17(candidate('lives_in', 'Đà Nẵng'), [old], SCOPE_A, '2026-11-18T00:00:00.000Z')[0];
  assert.notEqual(validateResolutionM17('merge', conflict, 'gop'), null);
  assert.notEqual(validateResolutionM17('overwrite', conflict, ''), null);
  assert.equal(validateResolutionM17('overwrite', conflict, 'User chuyen nha.'), null);
  assert.equal(mergeObjectsM17('phở bò', 'bún chả'), 'phở bò, bún chả');
  assert.equal(mergeObjectsM17('phở bò', 'phở bò'), 'phở bò');
});

test('conflicts: queue enqueue dedupe + resolve + audit', () => {
  const queue = new M17ConflictQueue();
  const store = new M17BiTemporalStore();
  const old = store.addFact(candidate('lives_in', 'Hà Nội', 0.95), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-01-01T00:00:00.000Z',
  });
  const conflict = detectConflictsM17(candidate('lives_in', 'Đà Nẵng'), [old], SCOPE_A, '2026-11-18T00:00:00.000Z')[0];
  assert.equal(queue.enqueue(conflict), true);
  assert.equal(queue.enqueue(conflict), false); // dedupe
  assert.equal(queue.pendingCount, 1);
  const resolution = queue.resolve(conflict.id, 'keep_both', 'user', 'Giu ca hai.', '2026-11-18T00:00:00.000Z');
  assert.equal(resolution.strategy, 'keep_both');
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.resolvedCount, 1);
  assert.equal(queue.listAudit().length, 1);
  assert.throws(
    () => queue.resolve(conflict.id, 'overwrite', 'user', 'x', '2026-11-18T00:00:00.000Z'),
    /Khong tim thay conflict/,
  );
});

// ---------- bi-temporal ----------

test('biTemporal: queryAt valid time + asKnownAt transaction time', () => {
  const store = new M17BiTemporalStore();
  const fact = candidate('lives_in', 'Hà Nội');
  fact.validFrom = '2020-01-01T00:00:00.000Z';
  fact.validTo = '2026-06-01T00:00:00.000Z';
  store.addFact(fact, SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(store.factsValidAt(SCOPE_A, '2024-05-01T00:00:00.000Z').facts.length, 1);
  assert.equal(store.factsValidAt(SCOPE_A, '2027-01-01T00:00:00.000Z').facts.length, 0);
  assert.equal(store.factsAsKnownAt(SCOPE_A, '2025-12-01T00:00:00.000Z').facts.length, 0);
  assert.equal(store.factsAsKnownAt(SCOPE_A, '2026-02-01T00:00:00.000Z').facts.length, 1);
});

test('biTemporal: invalidate keeps row; supersede closes window + chain', () => {
  const store = new M17BiTemporalStore();
  const f1 = store.addFact(candidate('prefers', 'phở bò'), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-01-01T00:00:00.000Z',
  });
  store.invalidateFact(f1.id, SCOPE_A, 'User bao sai.', '2026-11-18T00:00:00.000Z');
  const kept = store.getFact(f1.id);
  assert.equal(kept?.status, 'invalidated');
  assert.equal(store.totalFacts, 1);
  assert.equal(store.listActive(SCOPE_A).total, 0);
  assert.throws(
    () => store.invalidateFact(f1.id, SCOPE_B, 'x', '2026-11-18T00:00:00.000Z'),
    /khong thuoc scope/,
  );

  const old = store.addFact(candidate('lives_in', 'Hà Nội'), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-01-01T00:00:00.000Z',
  });
  const next = store.addFact(candidate('lives_in', 'Đà Nẵng'), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-11-18T00:00:00.000Z',
  });
  store.supersedeFact(old.id, next.id, SCOPE_A, 'Chuyen nha.', '2026-11-18T00:00:00.000Z');
  const oldAfter = store.getFact(old.id);
  assert.equal(oldAfter?.status, 'superseded');
  assert.equal(oldAfter?.supersededById, next.id);
  assert.equal(oldAfter?.validTo, '2026-11-18T00:00:00.000Z');
  const chain = store.supersessionChain(next.id, SCOPE_A);
  assert.equal(chain.length, 2);
  const steps = store.factTimeline(old.id, SCOPE_A);
  assert.ok(steps.some((s) => s.kind === 'learned'));
  assert.ok(steps.some((s) => s.kind === 'superseded'));
  // Restore works.
  const restored = store.restoreFact(old.id, SCOPE_A, 'Nhap nham.', '2026-11-19T00:00:00.000Z');
  assert.equal(restored.fact.status, 'active');
});

test('biTemporal: serialize/deserialize round-trip preserves history', () => {
  const store = new M17BiTemporalStore();
  const fact = store.addFact(candidate('prefers', 'phở bò'), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-11-01T00:00:00.000Z',
  });
  store.invalidateFact(fact.id, SCOPE_A, 'Sai.', '2026-11-18T00:00:00.000Z');
  const json = store.serialize();
  const store2 = new M17BiTemporalStore();
  store2.deserialize(json);
  assert.equal(store2.totalFacts, 1);
  assert.equal(store2.getFact(fact.id)?.status, 'invalidated');
  assert.equal(store2.factTimeline(fact.id, SCOPE_A).length, 2);
});

// ---------- fusion ----------

test('fusion: hashed embedding deterministic, cosine 1 for identical text', () => {
  const a = hashEmbeddingM17('Tôi thích ăn phở bò');
  const b = hashEmbeddingM17('Tôi thích ăn phở bò');
  assert.equal(cosineSimilarityM17(a, b), 1);
  const c = hashEmbeddingM17('thời tiết hôm nay mưa to');
  assert.ok(cosineSimilarityM17(a, c) < cosineSimilarityM17(a, b));
});

test('fusion: entity query ranks matching fact first; BM25 rare keyword wins', () => {
  const store = new M17BiTemporalStore();
  store.addFact(candidate('prefers', 'phở bò'), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-11-01T00:00:00.000Z',
  });
  store.addFact(candidate('prefers', 'bún chả'), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-11-01T00:00:00.000Z',
  });
  store.addFact(candidate('uses', 'Obsidian'), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-11-01T00:00:00.000Z',
  });
  const facts = store.listActive(SCOPE_A, { limit: 100 }).facts;
  const res = fusionSearchM17('phở bò', facts, SCOPE_A, { atIso: '2026-11-18T00:00:00.000Z' });
  assert.ok(res.hits.length > 0);
  assert.ok(res.hits[0].fact.object.includes('phở'));
  const s = res.hits[0].score;
  for (const v of [s.semantic, s.keyword, s.entity, s.time, s.total]) {
    assert.ok(v >= 0 && v <= 1, `score out of range: ${v}`);
  }
  const rare = fusionSearchM17('Obsidian', facts, SCOPE_A, {
    weights: { keyword: 0.8, semantic: 0.1, entity: 0.05, time: 0.05 },
  });
  assert.equal(rare.hits[0].fact.object, 'Obsidian');
});

test('fusion: time-aware prefers newer fact; cross-scope never leaks', () => {
  const store = new M17BiTemporalStore();
  store.addFact(candidate('prefers', 'phở bò'), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2025-01-01T00:00:00.000Z',
  });
  store.addFact(candidate('prefers', 'phở gà'), SCOPE_A, {
    provenance: provenanceFor(SCOPE_A),
    learnedAt: '2026-11-17T00:00:00.000Z',
  });
  store.addFact(candidate('prefers', 'phở bò'), SCOPE_B, {
    provenance: provenanceFor(SCOPE_B),
    learnedAt: '2026-11-17T00:00:00.000Z',
  });
  const factsA = store.listActive(SCOPE_A, { limit: 100 }).facts;
  const res = fusionSearchM17('phở', factsA, SCOPE_A, {
    weights: { semantic: 0.1, keyword: 0.1, entity: 0.1, time: 0.7 },
  });
  assert.equal(res.considered, 2);
  assert.ok(res.hits[0].fact.object.includes('gà'));
  assert.throws(() => fusionSearchM17('', factsA, SCOPE_A), /Query rong/);
});

// ---------- scope ----------

test('scope: strict matcher — empty field is NOT a wildcard', () => {
  const guard = new M17ScopeGuard();
  // Same scope allowed.
  assert.equal(guard.guardRead(SCOPE_A, SCOPE_A, 'read', '2026-11-18T00:00:00.000Z').allowed, true);
  // Different user denied + violation logged.
  const denied = guard.guardRead(SCOPE_A, SCOPE_B, 'read', '2026-11-18T00:00:00.000Z');
  assert.equal(denied.allowed, false);
  assert.equal(guard.violationCount, 1);
  // checkReadAccessM17 direct: different conversation denied.
  const otherConv = { ...SCOPE_A, conversationId: 'conv-2' };
  assert.equal(checkReadAccessM17(SCOPE_A, otherConv, [], '2026-11-18T00:00:00.000Z').allowed, false);
});

test('scope: grant opens read; expired grant does not; revoke closes', () => {
  const guard = new M17ScopeGuard();
  const grant = guard.grantRead(SCOPE_A, SCOPE_B, 'user-a', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
  assert.equal(guard.grantCount, 1);
  const check = guard.guardRead(SCOPE_A, SCOPE_B, 'read', '2026-11-18T00:00:00.000Z');
  assert.equal(check.allowed, true);
  assert.equal(check.viaGrant, true);
  assert.equal(check.grantId, grant.id);
  // Expired grant.
  const guard2 = new M17ScopeGuard();
  guard2.grantRead(SCOPE_A, SCOPE_B, 'user-a', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
  assert.equal(guard2.guardRead(SCOPE_A, SCOPE_B, 'read', '2026-11-18T00:00:00.000Z').allowed, false);
  // Revoke.
  assert.equal(guard.revokeGrant(grant.id), true);
  assert.equal(guard.guardRead(SCOPE_A, SCOPE_B, 'read', '2026-11-18T00:00:00.000Z').allowed, false);
  assert.throws(() => guard.grantRead(SCOPE_A, SCOPE_A, 'user-a', '2026-11-18T00:00:00.000Z'), /cung scope/);
});

test('scope: leak scan finds invalid scopes; report formats', () => {
  const guard = new M17ScopeGuard();
  const badFact = {
    id: 'fact-bad',
    subject: 'user',
    edge: 'prefers',
    object: 'phở',
    validFrom: null,
    validTo: null,
    learnedAt: '2026-11-18T00:00:00.000Z',
    invalidatedAt: null,
    invalidReason: null,
    supersedesId: null,
    supersededById: null,
    mergedFromIds: [],
    confidence: 0.9,
    status: 'active',
    scope: { tenantId: '', userId: '', botId: '', conversationId: '' },
    provenance: {
      episodeId: 'e', turnId: 't', runId: 'r', botId: '', userId: '',
      at: '2026-11-18T00:00:00.000Z', sourceText: 'x', method: 'rule', extractor: 'm17',
    },
    note: '',
  };
  const report = scanForScopeLeaksM17([badFact], [], [], guard);
  assert.equal(report.scanned, 1);
  assert.equal(report.invalidScope.length, 1);
  assert.equal(report.hasLeak, true);
  assert.ok(formatLeakReportM17(report).includes('CO VAN DE'));
  const clean = scanForScopeLeaksM17([], [], [], guard);
  assert.equal(clean.hasLeak, false);
});

// ---------- store ----------

test('store: ingest end-to-end — extract, add, link, duplicate bump', async () => {
  const store = new M17Store();
  const r1 = await store.ingestTurns(
    [
      { role: 'user', text: 'Tôi rất thích ăn phở bò.', episodeId: 'e1', turnId: 't1' },
      { role: 'user', text: 'Tôi đang sống ở Đà Nẵng.', episodeId: 'e1', turnId: 't2' },
    ],
    SCOPE_A,
  );
  assert.equal(r1.factsAdded, 2);
  assert.equal(r1.entitiesCreated, 3); // user + phở bò + Đà Nẵng (user shared)
  assert.equal(r1.edgesCreated, 2);
  assert.equal(r1.conflictsFound, 0);
  const r2 = await store.ingestTurns(
    [{ role: 'user', text: 'Tôi rất thích ăn phở bò.', episodeId: 'e2', turnId: 't1' }],
    SCOPE_A,
  );
  assert.equal(r2.duplicates, 1);
  assert.equal(r2.factsAdded, 0);
  const search = store.search('phở bò', SCOPE_A);
  assert.ok(search.hits.length > 0);
  const stats = store.stats(SCOPE_A);
  assert.equal(stats.facts.active, 2);
  assert.equal(stats.pendingConflicts, 0);
});

test('store: strong conflict queues; user overwrite supersedes old', async () => {
  const store = new M17Store({ autoResolve: false });
  await store.ingestTurns(
    [{ role: 'user', text: 'Tôi đang sống ở Hà Nội.', episodeId: 'e1', turnId: 't1' }],
    SCOPE_A,
  );
  const r2 = await store.ingestTurns(
    [{ role: 'user', text: 'Tôi đang sống ở Đà Nẵng.', episodeId: 'e2', turnId: 't1' }],
    SCOPE_A,
  );
  assert.equal(r2.queued, 1);
  assert.equal(r2.factsAdded, 0);
  const pending = store.conflicts.listPending()[0];
  const { resultingFact } = store.resolvePendingConflict(
    pending.id, 'overwrite', 'user', 'User da chuyen nha.', SCOPE_A,
  );
  assert.ok(resultingFact);
  assert.equal(store.graph.getFact(pending.existingFactId)?.status, 'superseded');
  assert.equal(store.graph.getFact(resultingFact.id)?.status, 'active');
  // stateAt now: chi fact moi con active; fact cu da superseded.
  const nowState = store.stateAt(SCOPE_A, new Date().toISOString());
  assert.ok(nowState.facts.some((f) => f.object.includes('Đà Nẵng')));
  assert.ok(!nowState.facts.some((f) => f.object.includes('Hà Nội')));
  // Chuoi supersession truy vet duoc ca 2.
  const chain = store.graph.supersessionChain(resultingFact.id, SCOPE_A);
  assert.equal(chain.length, 2);
  assert.ok(chain[0].object.includes('Hà Nội'));
});

test('store: serialize/deserialize round-trip keeps facts + conflicts + grants', async () => {
  const store = new M17Store({ autoResolve: false });
  await store.ingestTurns(
    [{ role: 'user', text: 'Tôi thích ăn phở bò.', episodeId: 'e1', turnId: 't1' }],
    SCOPE_A,
  );
  store.guard.grantRead(SCOPE_A, SCOPE_B, 'user-a', '2026-11-18T00:00:00.000Z');
  const json = store.serialize();
  const store2 = new M17Store();
  store2.deserialize(json);
  assert.equal(store2.graph.totalFacts, 1);
  assert.equal(store2.guard.grantCount, 1);
  assert.ok(store2.search('phở', SCOPE_A).hits.length > 0);
  assert.equal(store2.search('phở', SCOPE_B).hits.length, 0); // guard: no grant in search path? search uses scope filter
});

test('store: scanLeaks clean on normal store', async () => {
  const store = new M17Store();
  await store.ingestTurns(
    [{ role: 'user', text: 'Tôi thích ăn phở bò.', episodeId: 'e1', turnId: 't1' }],
    SCOPE_A,
  );
  const report = store.scanLeaks();
  assert.equal(report.hasLeak, false);
});

// ---------- eval ----------

test('eval: dataset has 40 cases across 5 categories', () => {
  const dataset = buildM17EvalDataset();
  assert.equal(dataset.length, 40);
  const categories = new Set(dataset.map((c) => c.category));
  assert.equal(categories.size, 5);
});

test('eval: full run passes all 40 cases', async () => {
  const result = await runM17Eval();
  assert.equal(result.total, 40);
  assert.equal(result.failed, 0, JSON.stringify(result.cases.filter((c) => !c.passed)));
  assert.equal(result.passedOverall, true);
  assert.ok(result.rate >= 0.9);
});
