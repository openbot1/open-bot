/**
 * Tests for v1.35 (Team T1) — memory v16:
 * packages/core/src/memoryV16/{consolidation,hybridSearch}.ts
 *
 * Covers:
 *  - Extract/fuse da scope: rule extractor Viet/Anh (name, lives_in,
 *    works_at, likes, dislikes, prefers, speaks, has_pet, owns, goal,
 *    favorites) + retract patterns; fuse ADD/UPDATE/DELETE/IGNORE;
 *    single-valued vs multi-valued; near-duplicate; low confidence;
 *    scope isolation (user vs session); consolidateTurnsM16 report.
 *  - Sleep-time consolidation agent: idle gate, force run, queue
 *    drain, session -> user promote (2 sessions), durable fact ->
 *    core block promote (skips PINNED block).
 *  - Archival recall: archiveFact/archiveText, IDF text score,
 *    recency half-life, access boost, weighted + RRF ranking, asOf
 *    filter, predicate filter, recordAccess, setImportance,
 *    decayImportance, stats, JSON round-trip, archiveExpiredFacts,
 *    promoteArchivedToGraph.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v16-consolidation-archival-v135.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  M16BlockStore,
  M16ValidityLedger,
  M16ArchivalStore,
  M16ArchivalRetriever,
  M16SleepConsolidator,
  isSingleValuedPredicateM16,
  clamp01M16,
  extractFactsM16Sync,
  objectOverlapM16,
  planFuseM16,
  applyFuseM16,
  consolidateTurnsM16,
  factKeyM16,
  runSleepConsolidationM16,
  previewConsolidationM16,
  archivalTokensM16,
  archivalTextScoreM16,
  archivalRecencyScoreM16,
  archivalAccessScoreM16,
  archivalRecallM16,
  archivalImportanceTopM16,
  archivalDocFreqM16,
  archiveExpiredFactsM16,
  promoteArchivedToGraphM16,
  suggestArchivalCandidatesM16,
  normalizeArchivalWeightsM16,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function prov(sourceText) {
  return {
    episodeId: 'e1',
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    at: '2026-01-01T00:00:00.000Z',
    sourceText,
  };
}

function seedFact(store, subject, predicate, objectText, opts = {}) {
  return store.addFact({
    subjectName: subject,
    predicate,
    objectText,
    confidence: opts.confidence ?? 0.9,
    scope: opts.scope ?? SCOPE,
    provenance: prov(`${subject} ${predicate} ${objectText}`),
    ...(opts.validFrom ? { validFrom: opts.validFrom } : {}),
    ...(opts.validUntil !== undefined ? { validUntil: opts.validUntil } : {}),
  });
}

function candidate(overrides = {}) {
  return {
    subject: 'user',
    predicate: 'likes',
    objectText: 'cà phê',
    confidence: 0.9,
    sourceText: 'tôi thích cà phê',
    scope: 'user',
    intent: 'assert',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Extract (rule-based, Viet/Anh)
// ---------------------------------------------------------------------------

test('M16 extract: Vietnamese name/lives_in/works_at/likes in one turn', () => {
  const facts = extractFactsM16Sync('Tôi tên là Huy, tôi sống ở Hà Nội, tôi làm ở OpenBot, tôi thích cà phê.');
  const byPred = new Map(facts.map((f) => [f.predicate, f.objectText]));
  assert.equal(byPred.get('name'), 'Huy');
  assert.equal(byPred.get('lives_in'), 'Hà Nội');
  assert.equal(byPred.get('works_at'), 'OpenBot');
  assert.equal(byPred.get('likes'), 'cà phê');
  assert.ok(facts.every((f) => f.scope === 'user' && f.intent === 'assert'));
});

test('M16 extract: English patterns + dislikes/prefers/speaks/goal/favorites', () => {
  const en = extractFactsM16Sync('My name is Huy. I work at OpenBot. I like tea. I prefer green tea. I speak English. My goal is to ship v1.');
  const preds = en.map((f) => f.predicate);
  assert.ok(preds.includes('name'));
  assert.ok(preds.includes('works_at'));
  assert.ok(preds.includes('likes'));
  assert.ok(preds.includes('prefers'));
  assert.ok(preds.includes('speaks'));
  assert.ok(preds.includes('current_goal'));
  const vi = extractFactsM16Sync('Tôi không thích ồn ào. Tôi nuôi một con mèo. Màu yêu thích của tôi là xanh. Mục tiêu của tôi là ra mắt v1.');
  const viPreds = vi.map((f) => f.predicate);
  assert.ok(viPreds.includes('dislikes'));
  assert.ok(viPreds.includes('has_pet'));
  assert.ok(viPreds.includes('favorite_color'));
  assert.ok(viPreds.includes('current_goal'));
});

test('M16 extract: retract patterns produce intent=retract', () => {
  const facts = extractFactsM16Sync('Tôi không còn làm ở Acme nữa, tôi không còn thích cà phê.');
  assert.ok(facts.some((f) => f.predicate === 'works_at' && f.intent === 'retract'));
  assert.ok(facts.some((f) => f.predicate === 'likes' && f.intent === 'retract'));
});

test('M16 extract: empty text / no pattern / scope + trust options', () => {
  assert.deepEqual(extractFactsM16Sync(''), []);
  assert.deepEqual(extractFactsM16Sync('   '), []);
  assert.deepEqual(extractFactsM16Sync('Hôm nay trời đẹp quá.'), []);
  const scoped = extractFactsM16Sync('Tôi tên là Huy.', { scope: 'session', sourceTrust: 0.5, subject: 'user' });
  assert.equal(scoped[0].scope, 'session');
  assert.ok(scoped[0].confidence < 0.95 && scoped[0].confidence > 0);
  assert.equal(extractFactsM16Sync('Tôi tên là Huy.', { sourceTrust: 0 }).length, 1);
});

test('M16 helpers: single-valued predicates + clamp01 + objectOverlap + factKey', () => {
  assert.equal(isSingleValuedPredicateM16('lives_in'), true);
  assert.equal(isSingleValuedPredicateM16('name'), true);
  assert.equal(isSingleValuedPredicateM16('likes'), false);
  assert.equal(isSingleValuedPredicateM16('owns'), false);
  assert.equal(clamp01M16(2), 1);
  assert.equal(clamp01M16(-1), 0);
  assert.equal(clamp01M16(0.5), 0.5);
  assert.equal(clamp01M16(Number.NaN), 0);
  assert.equal(objectOverlapM16('cà phê trứng', 'cà phê trứng'), 1);
  assert.ok(objectOverlapM16('cà phê', 'trà đá') < 0.5);
  assert.equal(objectOverlapM16('', 'x'), 0);
  assert.equal(
    factKeyM16('user', 'likes', 'cà phê'),
    factKeyM16('user', 'likes', 'cà phê'),
  );
});

// ---------------------------------------------------------------------------
// Fuse planning (no writes)
// ---------------------------------------------------------------------------

test('M16 planFuse: ADD when nothing exists; IGNORE when duplicate', () => {
  const plan1 = planFuseM16([], candidate());
  assert.equal(plan1.decision, 'add');
  const store = freshStore();
  const existing = seedFact(store, 'user', 'likes', 'cà phê');
  const plan2 = planFuseM16([existing], candidate());
  assert.equal(plan2.decision, 'ignore');
  assert.match(plan2.reason, /trung/);
});

test('M16 planFuse: UPDATE single-valued on new object; ADD multi-valued', () => {
  const store = freshStore();
  const old = seedFact(store, 'user', 'lives_in', 'Hà Nội');
  const plan = planFuseM16([old], candidate({ predicate: 'lives_in', objectText: 'TP. HCM' }));
  assert.equal(plan.decision, 'update');
  assert.equal(plan.target.id, old.id);
  const multi = planFuseM16([seedFact(store, 'user', 'likes', 'cà phê')], candidate({ objectText: 'trà đá' }));
  assert.equal(multi.decision, 'add');
});

test('M16 planFuse: near-duplicate multi-valued -> IGNORE; retract -> DELETE/IGNORE', () => {
  const store = freshStore();
  const existing = seedFact(store, 'user', 'likes', 'cà phê trứng Hà Nội');
  const near = planFuseM16([existing], candidate({ objectText: 'cà phê trứng' }));
  assert.equal(near.decision, 'ignore');
  const del = planFuseM16([existing], candidate({ objectText: 'cà phê trứng Hà Nội', intent: 'retract' }));
  assert.equal(del.decision, 'delete');
  const delMiss = planFuseM16([existing], candidate({ objectText: 'trà đá', intent: 'retract' }));
  assert.equal(delMiss.decision, 'ignore');
});

test('M16 planFuse: low confidence -> IGNORE', () => {
  const plan = planFuseM16([], candidate({ confidence: 0.1 }));
  assert.equal(plan.decision, 'ignore');
  assert.match(plan.reason, /tin cay/);
});

// ---------------------------------------------------------------------------
// Fuse apply (writes)
// ---------------------------------------------------------------------------

test('M16 applyFuse: ADD writes fact with scope + provenance', () => {
  const store = freshStore();
  const result = applyFuseM16(store, candidate(), SCOPE);
  assert.equal(result.decision, 'add');
  assert.ok(result.fact);
  assert.equal(result.fact.objectText, 'cà phê');
  assert.equal(result.fact.scope.userId, 'u1');
  assert.equal(store.listFacts({ status: 'active' }).length, 1);
});

test('M16 applyFuse: UPDATE supersedes old fact (history kept)', () => {
  const store = freshStore();
  const old = seedFact(store, 'user', 'lives_in', 'Hà Nội');
  const result = applyFuseM16(store, candidate({ predicate: 'lives_in', objectText: 'TP. HCM' }), SCOPE);
  assert.equal(result.decision, 'update');
  const after = store.getFact(old.id);
  assert.equal(after.status, 'superseded');
  assert.equal(after.supersededBy, result.fact.id);
  assert.equal(result.fact.supersedes, old.id);
  assert.equal(result.fact.objectText, 'TP. HCM');
});

test('M16 applyFuse: DELETE invalidates retracted fact', () => {
  const store = freshStore();
  const old = seedFact(store, 'user', 'works_at', 'Acme');
  const result = applyFuseM16(
    store,
    candidate({ predicate: 'works_at', objectText: 'Acme', intent: 'retract', sourceText: 'không còn làm ở Acme' }),
    SCOPE,
  );
  assert.equal(result.decision, 'delete');
  const after = store.getFact(old.id);
  assert.ok(after.invalidAt);
  assert.match(after.invalidationReason, /rut lai/);
});

test('M16 applyFuse: shared scope clears user/bot; session scope keeps sessionId', () => {
  const store = freshStore();
  const shared = applyFuseM16(store, candidate({ scope: 'shared' }), { userId: 'u1', botId: 'b1', runId: 'r1' });
  assert.equal(shared.fact.scope.userId, '');
  assert.equal(shared.fact.scope.botId, '');
  const session = applyFuseM16(
    store,
    candidate({ predicate: 'likes', objectText: 'trà đá', scope: 'session' }),
    { userId: 'u1', botId: 'b1', runId: 'r1', sessionId: 's9' },
  );
  assert.equal(session.fact.scope.sessionId, 's9');
});

test('M16 consolidateTurnsM16: report counts per operation', () => {
  const store = freshStore();
  const report = consolidateTurnsM16(store, [
    { text: 'Tôi tên là Huy.', userId: 'u1', botId: 'b1', runId: 'r1' },
    { text: 'Tôi sống ở Hà Nội.', userId: 'u1', botId: 'b1', runId: 'r1' },
    { text: 'Tôi tên là Huy.', userId: 'u1', botId: 'b1', runId: 'r1' },
    { text: 'Hôm nay trời đẹp.', userId: 'u1', botId: 'b1', runId: 'r1' },
  ]);
  assert.equal(report.turns, 4);
  assert.equal(report.extracted, 3);
  assert.equal(report.added, 2);
  assert.equal(report.ignored, 1);
  assert.equal(report.updated, 0);
  assert.equal(report.deleted, 0);
});

test('M16 consolidateTurnsM16: scope isolation — same fact in 2 scopes adds twice', () => {
  const store = freshStore();
  const report = consolidateTurnsM16(store, [
    { text: 'Tôi thích cà phê.', scope: 'user', userId: 'u1', botId: 'b1', runId: 'r1' },
    { text: 'Tôi thích cà phê.', scope: 'session', userId: 'u1', botId: 'b1', runId: 'r1', sessionId: 's1' },
  ]);
  assert.equal(report.added, 2);
  assert.equal(store.listFacts({ status: 'active' }).length, 2);
});

// ---------------------------------------------------------------------------
// Sleep-time consolidation agent
// ---------------------------------------------------------------------------

test('M16 sleep consolidator: refuses when not idle, keeps queue', () => {
  const store = freshStore();
  const agent = new M16SleepConsolidator();
  agent.enqueue({ text: 'Tôi tên là Huy.', userId: 'u1', botId: 'b1', runId: 'r1' });
  const report = agent.run(store, { idleMs: 1000 });
  assert.equal(report.ran, false);
  assert.equal(agent.pendingTurns, 1);
  assert.equal(report.turnsProcessed, 0);
});

test('M16 sleep consolidator: force run drains queue + counts', () => {
  const store = freshStore();
  const agent = new M16SleepConsolidator();
  agent.enqueue({ text: 'Tôi tên là Huy.', userId: 'u1', botId: 'b1', runId: 'r1' });
  agent.enqueue({ text: 'Tôi sống ở Hà Nội.', userId: 'u1', botId: 'b1', runId: 'r1' });
  const report = agent.run(store, { force: true });
  assert.equal(report.ran, true);
  assert.equal(report.turnsProcessed, 2);
  assert.equal(report.added, 2);
  assert.equal(agent.pendingTurns, 0);
  assert.equal(agent.seenCountFor('user', 'name', 'Huy'), 1);
});

test('M16 sleep consolidator: session fact in 2 sessions promotes to user scope', () => {
  const store = freshStore();
  const agent = new M16SleepConsolidator();
  agent.enqueue({ text: 'Tôi thích trà đá.', scope: 'session', userId: 'u1', botId: 'b1', runId: 'r1', sessionId: 's1' });
  agent.run(store, { force: true });
  agent.enqueue({ text: 'Tôi thích trà đá.', scope: 'session', userId: 'u1', botId: 'b1', runId: 'r2', sessionId: 's2' });
  const report = agent.run(store, { force: true });
  assert.ok(report.sessionPromoted >= 1, `expected >=1 promote, got ${report.sessionPromoted}`);
  const userFacts = store.listFacts({ userId: 'u1', status: 'active' }).filter((f) => f.predicate === 'likes');
  assert.ok(userFacts.some((f) => (f.objectText ?? '').includes('trà đá')));
});

test('M16 sleep consolidator: durable fact promotes into human block (not pinned)', () => {
  const store = freshStore();
  const blocks = new M16BlockStore();
  blocks.ensureCoreBlocks('system');
  const agent = new M16SleepConsolidator();
  // Same fact twice -> seenCount 2 -> promote (thresholds: conf 0.85, repeats 2).
  agent.enqueue({ text: 'Tôi thích cà phê.', userId: 'u1', botId: 'b1', runId: 'r1' });
  agent.run(store, { force: true }, blocks);
  agent.enqueue({ text: 'Tôi thích cà phê.', userId: 'u1', botId: 'b1', runId: 'r2' });
  const report = agent.run(store, { force: true }, blocks);
  assert.ok(report.corePromoted >= 1, `expected core promote, got ${report.corePromoted}`);
  assert.match(blocks.get('human').content, /likes: cà phê/);
});

test('M16 sleep consolidator: pinned human block is never written by promote', () => {
  const store = freshStore();
  const blocks = new M16BlockStore();
  blocks.ensureCoreBlocks('system');
  blocks.pin('human', 'user', 'khoa');
  const agent = new M16SleepConsolidator();
  agent.enqueue({ text: 'Tôi thích cà phê.', userId: 'u1', botId: 'b1', runId: 'r1' });
  agent.run(store, { force: true }, blocks);
  agent.enqueue({ text: 'Tôi thích cà phê.', userId: 'u1', botId: 'b1', runId: 'r2' });
  const report = agent.run(store, { force: true }, blocks);
  assert.equal(report.corePromoted, 0);
  assert.ok(report.actions.some((a) => a.includes('PIN')));
  assert.ok(!blocks.get('human').content.includes('cà phê'));
});

test('M16 runSleepConsolidationM16 one-shot helper', () => {
  const store = freshStore();
  const report = runSleepConsolidationM16(store, [
    { text: 'Tôi tên là Huy.', userId: 'u1', botId: 'b1', runId: 'r1' },
  ]);
  assert.equal(report.ran, true);
  assert.equal(report.turnsProcessed, 1);
  assert.equal(report.added, 1);
});

// ---------------------------------------------------------------------------
// Archival store
// ---------------------------------------------------------------------------

test('M16 archival: archiveFact + archiveText + list/get/remove', () => {
  const store = freshStore();
  const arch = new M16ArchivalStore();
  const fact = seedFact(store, 'user', 'works_at', 'Acme');
  const rec = arch.archiveFact(fact, 'system', 'het han');
  assert.equal(rec.factId, fact.id);
  assert.equal(rec.predicate, 'works_at');
  assert.equal(rec.objectText, 'Acme');
  assert.equal(rec.importance, 0.9);
  const t2 = arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê', importance: 0.7 });
  assert.equal(arch.size, 2);
  assert.equal(arch.get(t2.id).objectText, 'cà phê');
  assert.equal(arch.list('likes').length, 1);
  assert.equal(arch.list().length, 2);
  assert.equal(arch.remove(t2.id), true);
  assert.equal(arch.size, 1);
  assert.equal(arch.remove('missing'), false);
  assert.throws(() => arch.archiveText({ subject: '', predicate: 'x', objectText: 'y' }), /subject/);
  assert.throws(() => arch.archiveText({ subject: 'u', predicate: '', objectText: 'y' }), /predicate/);
  assert.throws(() => arch.archiveText({ subject: 'u', predicate: 'x', objectText: '' }), /objectText/);
});

test('M16 archival scoring helpers: tokens, IDF text, recency, access', () => {
  // normalizeGraphText bo dau tieng Viet: 'cà phê' -> 'ca phe'.
  assert.deepEqual(archivalTokensM16('Tôi thích cà phê trứng'), ['toi', 'thich', 'ca', 'phe', 'trung']);
  const df = new Map([['ca', 1], ['phe', 1], ['tra', 5]]);
  const score = archivalTextScoreM16(['ca', 'phe'], ['ca', 'phe', 'trung'], df, 10);
  assert.ok(score > 0.9, `rare tokens should score high, got ${score}`);
  const low = archivalTextScoreM16(['tra'], ['ca', 'phe'], df, 10);
  assert.equal(low, 0);
  assert.equal(archivalTextScoreM16([], ['a'], df, 10), 0);
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  assert.equal(archivalRecencyScoreM16('2026-06-01T00:00:00.000Z', now, 180), 1);
  const half = archivalRecencyScoreM16('2025-12-03T00:00:00.000Z', now, 180);
  assert.ok(half > 0.4 && half < 0.6, `180d half-life, got ${half}`);
  assert.equal(archivalRecencyScoreM16(null, now, 180), 0.5);
  assert.equal(archivalAccessScoreM16(0), 0);
  assert.ok(archivalAccessScoreM16(1) > 0 && archivalAccessScoreM16(1) < 1);
  assert.equal(archivalAccessScoreM16(100000), 1);
});

test('M16 archival recall: weighted ranking puts exact match first', () => {
  const arch = new M16ArchivalStore();
  arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê trứng Hà Nội', importance: 0.1 });
  arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'trà đá vỉa hè', importance: 0.9 });
  const result = archivalRecallM16(arch, 'cà phê trứng Hà Nội');
  assert.equal(result.total, 2);
  assert.equal(result.hits[0].record.objectText, 'cà phê trứng Hà Nội');
  assert.equal(result.hits[0].rank, 1);
  assert.ok(result.hits[0].scores.text > result.hits[1].scores.text);
});

test('M16 archival recall: RRF mode + minScore + predicate filter + topK', () => {
  const arch = new M16ArchivalStore();
  arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê trứng', importance: 0.1 });
  arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'trà đá', importance: 0.9 });
  arch.archiveText({ subject: 'user', predicate: 'owns', objectText: 'xe đạp', importance: 0.9 });
  const rrf = archivalRecallM16(arch, 'cà phê trứng', { mode: 'rrf' });
  assert.equal(rrf.hits[0].record.objectText, 'cà phê trứng');
  const filtered = archivalRecallM16(arch, '', { predicate: 'owns' });
  assert.equal(filtered.hits.length, 1);
  assert.equal(filtered.hits[0].record.predicate, 'owns');
  const top1 = archivalRecallM16(arch, '', { topK: 1 });
  assert.equal(top1.hits.length, 1);
  const strict = archivalRecallM16(arch, 'zzz-no-match', { minScore: 0.99 });
  assert.equal(strict.hits.length, 0);
});

test('M16 archival recall: asOf filters out expired records', () => {
  const arch = new M16ArchivalStore();
  arch.archiveText({ subject: 'user', predicate: 'works_at', objectText: 'Acme', validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' });
  arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê', validFrom: '2026-01-01T00:00:00.000Z' });
  const result = archivalRecallM16(arch, '', { asOf: '2026-06-01T00:00:00.000Z' });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].record.predicate, 'likes');
});

test('M16 archival: recordAccess + setImportance + decayImportance + stats', () => {
  const arch = new M16ArchivalStore();
  const rec = arch.archiveText(
    { subject: 'user', predicate: 'likes', objectText: 'cà phê', importance: 0.8 },
    'system', '', new Date('2025-01-01T00:00:00.000Z'),
  );
  // Access tai thoi diem co dinh 2025-01-01 (cung ngay archive) de
  // giu timeline gia dinh: decay as-of 2026-01-01 = tron 1 half-life
  // (365 ngay) -> importance 0.3 -> 0.15. Dung new Date() that
  // (2026-11-17) se dat lastAccessedAt SAU as-of -> age am -> khong decay.
  const afterAccess = arch.recordAccess(rec.id, new Date('2025-01-01T00:00:00.000Z'));
  assert.equal(afterAccess.accessCount, 1);
  assert.ok(afterAccess.importance > 0.8);
  assert.ok(afterAccess.lastAccessedAt);
  assert.throws(() => arch.recordAccess('missing'), /Khong tim thay record/);
  const set = arch.setImportance(rec.id, 0.3);
  assert.equal(set.importance, 0.3);
  assert.throws(() => arch.setImportance(rec.id, 2), /Importance phai trong/);
  assert.throws(() => arch.setImportance('missing', 0.5), /Khong tim thay record/);
  const changed = arch.decayImportance(new Date('2026-01-01T00:00:00.000Z'));
  assert.ok(changed >= 1);
  assert.ok(arch.get(rec.id).importance < 0.3);
  const stats = arch.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.totalAccesses, 1);
  assert.equal(stats.byPredicate.likes, 1);
  assert.ok(stats.avgImportance >= 0 && stats.avgImportance <= 1);
});

test('M16 archival: JSON round-trip + docFreq', () => {
  const arch = new M16ArchivalStore();
  arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê', importance: 0.7 });
  arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'trà đá', importance: 0.4 });
  const { store, skipped } = M16ArchivalStore.fromJSON({
    version: 1,
    records: [...arch.toJSON().records, { id: 1 }],
  });
  assert.equal(skipped, 1);
  assert.equal(store.size, 2);
  const df = archivalDocFreqM16(store.list());
  assert.ok((df.get('ca') ?? 0) >= 1);
  const empty = M16ArchivalStore.fromJSON(null);
  assert.equal(empty.store.size, 0);
});

test('M16 archival: archiveExpiredFacts dedupes; promoteArchivedToGraph round-trips', () => {
  const store = freshStore();
  const arch = new M16ArchivalStore();
  const fact = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-01-10T00:00:00.000Z' });
  const first = archiveExpiredFactsM16(arch, [fact]);
  assert.equal(first.archived, 1);
  const second = archiveExpiredFactsM16(arch, [fact]);
  assert.equal(second.archived, 0);
  assert.equal(second.skipped, 1);
  const recordId = first.ids[0];
  const promoted = promoteArchivedToGraphM16(store, arch, recordId, 'user');
  assert.equal(promoted.objectText, 'Acme');
  assert.equal(promoted.predicate, 'works_at');
  assert.equal(arch.size, 0);
  assert.throws(() => promoteArchivedToGraphM16(store, arch, recordId, 'user'), /Khong tim thay record/);
});

test('M16 archival retriever: recall + recallAndTouch bumps access', () => {
  const arch = new M16ArchivalStore();
  arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê trứng', importance: 0.5 });
  const retriever = new M16ArchivalRetriever(arch);
  const r1 = retriever.recall('cà phê trứng');
  assert.equal(r1.hits.length, 1);
  const r2 = retriever.recallAndTouch('cà phê trứng');
  assert.equal(r2.hits.length, 1);
  assert.equal(arch.list()[0].accessCount, 1);
});

test('M16 normalizeArchivalWeightsM16 normalizes + falls back on zero total', () => {
  const w = normalizeArchivalWeightsM16({ text: 2, recency: 2, importance: 0, access: 0 });
  assert.ok(Math.abs(w.text + w.recency + w.importance + w.access - 1) < 1e-9);
  const fallback = normalizeArchivalWeightsM16({ text: 0, recency: 0, importance: 0, access: 0 });
  assert.equal(fallback.text, 0.5);
});

// ---------------------------------------------------------------------------
// Consolidation preview (dry-run)
// ---------------------------------------------------------------------------

test('M16 previewConsolidationM16: plans without writing', () => {
  const store = freshStore();
  seedFact(store, 'user', 'lives_in', 'Hà Nội');
  const preview = previewConsolidationM16(store, [
    { text: 'Tôi sống ở TP. HCM.', userId: 'u1', botId: 'b1', runId: 'r1' },
    { text: 'Tôi thích trà đá.', userId: 'u1', botId: 'b1', runId: 'r1' },
  ]);
  assert.equal(preview.turns, 2);
  assert.equal(preview.extracted, 2);
  assert.equal(preview.counts.update, 1);
  assert.equal(preview.counts.add, 1);
  assert.equal(preview.plans[0].decision, 'update');
  assert.equal(preview.plans[1].decision, 'add');
  // Store untouched by the preview.
  assert.equal(store.listFacts({ status: 'active' }).length, 1);
  assert.equal(store.listFacts({ status: 'active' })[0].objectText, 'Hà Nội');
  const empty = previewConsolidationM16(store, [{ text: 'Hôm nay trời đẹp.', userId: 'u1', botId: 'b1', runId: 'r1' }]);
  assert.equal(empty.extracted, 0);
  assert.equal(empty.plans.length, 0);
});

// ---------------------------------------------------------------------------
// Archival candidates
// ---------------------------------------------------------------------------

test('M16 suggestArchivalCandidatesM16: expired low-confidence first', () => {
  const store = freshStore();
  seedFact(store, 'user', 'works_at', 'OldCo', {
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-01-10T00:00:00.000Z',
    confidence: 0.6,
  });
  seedFact(store, 'user', 'likes', 'cà phê', { confidence: 0.95 });
  seedFact(store, 'user', 'owns', 'xe dap', {
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-01-10T00:00:00.000Z',
    confidence: 0.9,
  });
  const now = new Date('2026-06-01T00:00:00.000Z');
  const candidates = suggestArchivalCandidatesM16(store, { now });
  // Only OldCo: expired + confidence 0.6 <= 0.7. High-confidence xe dap excluded.
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].fact.predicate, 'works_at');
  assert.match(candidates[0].reason, /het hieu luc/);
  const strict = suggestArchivalCandidatesM16(store, { now, maxConfidence: 0.5 });
  assert.equal(strict.length, 0);
  const limited = suggestArchivalCandidatesM16(store, { now, limit: 0 });
  assert.equal(limited.length, 0);
});

test('M16 archivalImportanceTopM16: ranks by importance then accesses', () => {
  const arch = new M16ArchivalStore();
  arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê', importance: 0.3 });
  const mid = arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'trà đá', importance: 0.6 });
  arch.archiveText({ subject: 'user', predicate: 'owns', objectText: 'xe đạp', importance: 0.9 });
  arch.recordAccess(mid.id);
  const top = archivalImportanceTopM16(arch, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].objectText, 'xe đạp');
  assert.equal(top[1].objectText, 'trà đá');
  assert.equal(archivalImportanceTopM16(arch, 0).length, 0);
});
