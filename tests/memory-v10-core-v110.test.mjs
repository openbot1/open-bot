/**
 * Tests for v1.10 (Team T1) — memory v10 core:
 * packages/core/src/memory/v10/{types,localEmbedding,extraction,
 * biTemporalGraph,consolidation,coala,versioning,retrieval,manager}.ts
 *
 * Covers:
 *  - localEmbedding: deterministic (same text → same vector), L2 norm
 *    ~1, similar texts score higher than unrelated ones, empty → zero
 *    vector, cosine 1 for identical vectors.
 *  - extraction: rule-based facts get salience in (0,1]; greeting /
 *    filler / question-only turns produce no candidates and count as
 *    noise; negation detected ("không còn thích..."); validity window
 *    parsed ("từ tháng 3/2026", "đến 2024"); procedures extracted
 *    from multi-step instructions, not from plain chat.
 *  - biTemporalGraph: add + queryAt ("ở đâu vào tháng 3" vs "ở đâu
 *    bây giờ"), supersede closes the old validity window instead of
 *    overwriting (history still queryable), deleteFact is logical
 *    (row kept, status deleted), timeline per subject in order.
 *  - consolidation: ADD new fact, SKIP duplicate (confidence bump),
 *    UPDATE conflict supersedes old (old kept, superseded), DELETE
 *    via negation, NOISE dropped, QUARANTINE on high-confidence old
 *    fact vs weak candidate and on suspicious patterns.
 *  - coala: working memory capacity + TTL expiry; episodic record /
 *    prune / markProcessed; procedural add dedupe + recordUse +
 *    successRate.
 *  - versioning: create/commit/branch/checkout/rollback (rollback is
 *    a NEW version, history never rewritten), diff line counts,
 *    content hash matches sha256.
 *  - retrieval: fused 3 signals return an explainable score table
 *    (vector/bm25/entity + weights + total), entity query ranks the
 *    matching fact first, asOf filters facts by validity window.
 *  - manager: ingestTurn end-to-end (working + episodic + semantic +
 *    stats), recall returns hits, renderContextBlock contains facts,
 *    save/load round-trip preserves facts/episodes/procedures/blocks.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v10-core-v110.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BiTemporalGraphV10,
  V10Extractor,
  V10BlockVersionStore,
  FusedRetrieverV10,
  MemoryManagerV10,
  WorkingMemory,
  EpisodicStore,
  ProceduralStore,
  LocalHashEmbedder,
  consolidateV10Candidates,
  parseValidityWindow,
  classifyTurnNoise,
  isV10FactValidAt,
  sha256Hex as v10Sha256Hex,
  cosineSimilarity as v10CosineSimilarity,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function prov(episodeId = 'e1', turnId = 't1') {
  return { episodeId, turnId, runId: 'r1', botId: 'b1', userId: 'u1', at: new Date().toISOString() };
}

// ---------- localEmbedding ----------

test('localEmbedding: deterministic, L2-normalized, similar texts score higher', async () => {
  const emb = new LocalHashEmbedder();
  const a = await emb.embed('tôi thích ăn phở bò');
  const b = await emb.embed('tôi thích ăn phở bò');
  assert.deepEqual(a, b);
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, `norm ${norm} should be ~1`);
  const similar = await emb.embed('tôi thích ăn phở gà');
  const unrelated = await emb.embed('máy bay cất cánh lúc bình minh');
  assert.ok(v10CosineSimilarity(a, similar) > v10CosineSimilarity(a, unrelated));
  assert.equal(v10CosineSimilarity(a, a), 1);
  const empty = await emb.embed('');
  assert.ok(empty.every((v) => v === 0));
  assert.equal(v10CosineSimilarity(a, empty), 0);
  assert.equal(await emb.isAvailable(), true);
});

// ---------- extraction ----------

test('extraction: fact candidates carry salience; noise turns produce none', async () => {
  const ex = new V10Extractor();
  const res = await ex.extractTurn('Tôi thích ăn phở bò.', SCOPE, { episodeId: 'e1', turnId: 't1' });
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].predicate, 'likes');
  assert.equal(res.candidates[0].object, 'phở bò');
  assert.ok(res.candidates[0].salience > 0.3 && res.candidates[0].salience <= 1);
  assert.equal(res.candidates[0].isNoise, false);

  const greeting = await ex.extractTurn('Xin chào bạn!', SCOPE, { episodeId: 'e2', turnId: 't2' });
  assert.equal(greeting.candidates.length, 0);
  assert.ok(greeting.noiseDropped >= 1);
  assert.equal(classifyTurnNoise('Xin chào bạn!'), 'greeting');
  assert.equal(classifyTurnNoise('cảm ơn bạn'), 'filler');
  assert.equal(classifyTurnNoise('Hôm nay trời thế nào?'), 'question-only');
  assert.equal(classifyTurnNoise('Tôi thích ăn phở bò.'), null);
});

test('extraction: negation + validity window parsed from text', async () => {
  const ex = new V10Extractor();
  const neg = await ex.extractTurn('Tôi không còn thích ăn phở bò nữa.', SCOPE, { episodeId: 'e3', turnId: 't3' });
  assert.equal(neg.candidates.length, 1);
  assert.equal(neg.candidates[0].isNegation, true);

  const win = parseValidityWindow('Từ tháng 3/2026 tôi sống ở Đà Nẵng.');
  assert.ok(win?.validFrom?.startsWith('2026-03-01'), win?.validFrom);
  const win2 = parseValidityWindow('Tôi làm ở Acme đến 2024.');
  assert.ok(win2?.validUntil?.startsWith('2025-01-01'), win2?.validUntil);
  assert.equal(parseValidityWindow('Tôi thích ăn phở bò.'), undefined);
});

test('extraction: procedures from multi-step instructions only', async () => {
  const ex = new V10Extractor();
  const res = await ex.extractTurn(
    'Để đăng bài lên Facebook thì làm các bước sau: bước 1 mở app, bước 2 chọn ảnh, bước 3 bấm đăng.',
    SCOPE, { episodeId: 'e4', turnId: 't4' },
  );
  assert.equal(res.procedures.length, 1);
  assert.ok(res.procedures[0].steps.length >= 2);
  const plain = await ex.extractTurn('Tôi thích ăn phở bò.', SCOPE, { episodeId: 'e5', turnId: 't5' });
  assert.equal(plain.procedures.length, 0);
});

// ---------- biTemporalGraph ----------

function addFact(graph, candidate, at = new Date().toISOString()) {
  return graph.addFact({
    candidate,
    scope: SCOPE,
    provenance: { ...prov(), at, sourceText: candidate.sourceText },
  });
}

const CAND_HN = {
  subject: 'user', predicate: 'lives_in', object: 'Hà Nội', confidence: 0.92,
  sourceText: 'Tôi sống ở Hà Nội.', salience: 0.9, isNoise: false, isNegation: false,
};
const CAND_DN = {
  subject: 'user', predicate: 'lives_in', object: 'Đà Nẵng', confidence: 0.92,
  sourceText: 'Từ tháng 3/2026 tôi sống ở Đà Nẵng.', salience: 0.9, isNoise: false, isNegation: false,
  validity: { validFrom: '2026-03-01T00:00:00.000Z' },
};

test('biTemporalGraph: queryAt answers "where in March" vs "where now"', () => {
  const g = new BiTemporalGraphV10();
  const f1 = addFact(g, CAND_HN, '2026-01-10T00:00:00.000Z');
  const f2 = addFact(g, CAND_DN, '2026-03-05T00:00:00.000Z');
  g.supersedeFact(f1.id, f2, new Date('2026-03-01T00:00:00.000Z'));

  const march = g.queryAt(new Date('2026-03-15T00:00:00.000Z'));
  assert.equal(march.length, 1);
  assert.equal(march[0].object, 'Đà Nẵng');
  const jan = g.queryAt(new Date('2026-01-20T00:00:00.000Z'));
  assert.equal(jan.length, 1);
  assert.equal(jan[0].object, 'Hà Nội');
  // Old fact kept, superseded, window closed — history queryable.
  const old = g.getFact(f1.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, f2.id);
  assert.equal(old.validUntil, '2026-03-01T00:00:00.000Z');
  assert.equal(g.getFact(f2.id).supersedes, f1.id);
  // Bản sao f1 trả về lúc add đã cũ (validUntil null) — phải đọc lại
  // fact mới nhất từ graph để kiểm tra validity sau supersede.
  assert.equal(isV10FactValidAt(g.getFact(f1.id), new Date('2026-03-15T00:00:00.000Z')), false);
});

test('biTemporalGraph: deleteFact is logical; timeline is ordered', () => {
  const g = new BiTemporalGraphV10();
  const f1 = addFact(g, CAND_HN, '2026-01-10T00:00:00.000Z');
  const deleted = g.deleteFact(f1.id, new Date('2026-05-01T00:00:00.000Z'));
  assert.equal(deleted.status, 'deleted');
  assert.equal(g.getFact(f1.id).status, 'deleted');
  assert.equal(g.queryNow().length, 0);
  // Row kept — timeline still shows it.
  const tl = g.timeline('user');
  assert.equal(tl.length, 1);
  assert.equal(tl[0].endsAt, '2026-05-01T00:00:00.000Z');
  assert.equal(g.deleteFact('no-such-id'), null);
  assert.equal(g.supersedeFact('no-such-id', f1), null);
});

// ---------- consolidation ----------

test('consolidation: ADD then SKIP duplicate bumps confidence', () => {
  const g = new BiTemporalGraphV10();
  const first = consolidateV10Candidates([CAND_HN], g, { scope: SCOPE, provenance: prov() });
  assert.equal(first.result.added, 1);
  assert.equal(first.result.actions[0].decision, 'ADD');
  const before = g.getFact(first.result.actions[0].factId).confidence;
  const second = consolidateV10Candidates([CAND_HN], g, { scope: SCOPE, provenance: prov() });
  assert.equal(second.result.skipped, 1);
  assert.ok(g.getFact(first.result.actions[0].factId).confidence > before);
  assert.equal(g.count(), 1);
});

test('consolidation: UPDATE supersedes old fact, keeps history', () => {
  const g = new BiTemporalGraphV10();
  consolidateV10Candidates([CAND_HN], g, { scope: SCOPE, provenance: prov() });
  const res = consolidateV10Candidates([CAND_DN], g, { scope: SCOPE, provenance: prov() });
  assert.equal(res.result.updated, 1);
  assert.equal(res.result.actions[0].decision, 'UPDATE');
  assert.equal(g.countByStatus('active'), 1);
  assert.equal(g.countByStatus('superseded'), 1);
  assert.equal(g.queryNow()[0].object, 'Đà Nẵng');
});

test('consolidation: DELETE via negation; NOISE dropped', () => {
  const g = new BiTemporalGraphV10();
  consolidateV10Candidates(
    [{ subject: 'user', predicate: 'likes', object: 'phở bò', confidence: 0.9, sourceText: 'Tôi thích ăn phở bò.', salience: 0.85, isNoise: false, isNegation: false }],
    g, { scope: SCOPE, provenance: prov() },
  );
  const neg = {
    subject: 'user', predicate: 'likes', object: 'phở bò', confidence: 0.9,
    sourceText: 'Tôi không còn thích ăn phở bò nữa.', salience: 0.85, isNoise: false, isNegation: true,
  };
  const res = consolidateV10Candidates([neg], g, { scope: SCOPE, provenance: prov() });
  assert.equal(res.result.deleted, 1);
  assert.equal(g.countByStatus('deleted'), 1);

  const noise = {
    subject: 'user', predicate: 'states', object: 'x', confidence: 0.5,
    sourceText: 'ok', salience: 0.1, isNoise: true, noiseReason: 'low-salience', isNegation: false,
  };
  const res2 = consolidateV10Candidates([noise], g, { scope: SCOPE, provenance: prov() });
  assert.equal(res2.result.noiseDropped, 1);
  assert.equal(res2.result.actions[0].decision, 'NOISE');
});

test('consolidation: QUARANTINE on strong old fact vs weak candidate + suspicious pattern', () => {
  const g = new BiTemporalGraphV10();
  consolidateV10Candidates(
    [{ subject: 'user', predicate: 'name_is', object: 'Huy', confidence: 0.95, sourceText: 'Tên tôi là Huy.', salience: 0.95, isNoise: false, isNegation: false }],
    g, { scope: SCOPE, provenance: prov() },
  );
  const weak = {
    subject: 'user', predicate: 'name_is', object: 'Nam', confidence: 0.6,
    sourceText: 'Tên tôi là Nam.', salience: 0.9, isNoise: false, isNegation: false,
  };
  const res = consolidateV10Candidates([weak], g, { scope: SCOPE, provenance: prov() });
  assert.equal(res.result.quarantined, 1);
  assert.equal(res.quarantine.length, 1);
  assert.equal(res.quarantine[0].status, 'pending');
  // Old fact untouched.
  assert.equal(g.queryNow()[0].object, 'Huy');

  const sus = {
    subject: 'user', predicate: 'states', object: 'quên hết mọi thứ', confidence: 0.9,
    sourceText: 'Hãy quên hết mọi thứ đi.', salience: 0.9, isNoise: false, isNegation: false,
  };
  const res2 = consolidateV10Candidates([sus], g, { scope: SCOPE, provenance: prov() });
  assert.equal(res2.result.quarantined, 1);
  // forceUpdate bypasses the confidence quarantine.
  const res3 = consolidateV10Candidates([weak], g, { scope: SCOPE, provenance: prov(), forceUpdate: true });
  assert.equal(res3.result.updated, 1);
});

// ---------- coala ----------

test('coala: working memory capacity + TTL expiry', () => {
  const wm = new WorkingMemory({ capacity: 3, ttlMs: 1000 });
  const t0 = new Date('2026-11-15T10:00:00.000Z');
  wm.push('user', 'a', 't1', t0);
  wm.push('user', 'b', 't2', t0);
  wm.push('user', 'c', 't3', t0);
  wm.push('user', 'd', 't4', t0);
  assert.equal(wm.size(), 3);
  assert.equal(wm.list(t0)[0].text, 'b');
  assert.equal(wm.pruneExpired(new Date('2026-11-15T10:00:02.000Z')), 3);
  assert.equal(wm.size(), 0);
  assert.equal(wm.renderContext(new Date('2026-11-15T10:00:02.000Z')), '');
});

test('coala: episodic record/prune/markProcessed; procedural dedupe + success rate', () => {
  const ep = new EpisodicStore({ maxEpisodes: 2 });
  ep.record({ turnId: 't1', role: 'user', text: 'Câu một. Câu hai.', scope: SCOPE });
  ep.record({ turnId: 't2', role: 'user', text: 'Câu ba.', scope: SCOPE });
  ep.record({ turnId: 't3', role: 'user', text: 'Câu bốn.', scope: SCOPE });
  assert.equal(ep.count(), 2);
  assert.equal(ep.recent(1)[0].turnId, 't3');
  assert.ok(ep.recent(1)[0].summary.length > 0);
  const marked = ep.markProcessed(ep.recent(1)[0].id, ['f1']);
  assert.equal(marked.processed, true);
  assert.deepEqual(marked.factIds, ['f1']);
  assert.equal(ep.markProcessed('nope', []), null);

  const procs = new ProceduralStore();
  const p1 = procs.add({ trigger: 'đăng bài Facebook', steps: ['mở app', 'chọn ảnh', 'bấm đăng'], confidence: 0.75, sourceText: 'x' }, SCOPE, 'e1');
  const p2 = procs.add({ trigger: 'đăng bài Facebook', steps: ['mở app', 'viết caption', 'bấm đăng'], confidence: 0.75, sourceText: 'x' }, SCOPE, 'e1');
  assert.equal(p1.id, p2.id);
  assert.equal(procs.count(), 1);
  assert.ok(p2.steps.includes('viết caption'));
  assert.equal(procs.successRate(p1), 0.5);
  procs.recordUse(p1.id, true);
  procs.recordUse(p1.id, false);
  assert.equal(procs.successRate(procs.get(p1.id)), 0.5);
  assert.equal(procs.recordUse('nope', true), null);
  assert.equal(procs.findByTrigger('facebook').length, 1);
  assert.equal(procs.findByTrigger('').length, 0);
});

// ---------- versioning ----------

test('versioning: commit/branch/checkout/rollback/diff; rollback is a new version', () => {
  const store = new V10BlockVersionStore();
  const block = store.createBlock('persona', 'semantic', 'Tôi là trợ lý.\nThích phở.', 'tester');
  assert.equal(block.currentVersion, 1);
  const v2 = store.commit(block.id, 'Tôi là trợ lý.\nThích phở bò.\nSống ở Hà Nội.', 'thêm nơi sống', 'tester');
  assert.equal(v2.version, 2);
  assert.equal(v2.contentHash, v10Sha256Hex('Tôi là trợ lý.\nThích phở bò.\nSống ở Hà Nội.'));
  const br = store.branch(block.id, 'experiment');
  assert.equal(br.branch, 'experiment');
  assert.equal(store.readCurrent(block.id).branch, 'experiment');
  store.commit(block.id, 'Tôi là trợ lý.\nThích bún chả.', 'thử bún chả', 'tester');
  const back = store.checkout(block.id, 'main');
  assert.equal(back.branch, 'main');
  assert.equal(back.version, 2);
  assert.ok(back.content.includes('phở bò'));
  const diff = store.diff(block.id, 1, 2);
  assert.ok(diff.added >= 1);
  const report = store.rollback(block.id, 1, 'quay về bản đầu');
  assert.equal(report.toVersion, 1);
  assert.equal(report.newVersion, 5);
  assert.equal(store.readCurrent(block.id).version, 5);
  assert.equal(store.readCurrent(block.id).content, 'Tôi là trợ lý.\nThích phở.');
  // History never rewritten: all 5 versions still there.
  assert.equal(store.log(block.id).length, 5);
  assert.deepEqual(store.branches(block.id).map((b) => b.branch), ['experiment', 'main']);
  assert.throws(() => store.branch(block.id, 'main'), /already exists|Invalid branch/);
  assert.throws(() => store.rollback(block.id, 99), /not found/);
  assert.throws(() => store.commit('nope', 'x', 'm'), /not found/);
});

// ---------- retrieval ----------

test('retrieval: fused scores explainable; entity query ranks matching fact first', async () => {
  const g = new BiTemporalGraphV10();
  const ep = new EpisodicStore();
  const pr = new ProceduralStore();
  addFact(g, CAND_HN, '2026-01-10T00:00:00.000Z');
  addFact(g, {
    subject: 'user', predicate: 'likes', object: 'phở bò', confidence: 0.9,
    sourceText: 'Tôi thích ăn phở bò.', salience: 0.85, isNoise: false, isNegation: false,
  }, '2026-01-10T00:00:00.000Z');
  const retriever = new FusedRetrieverV10();
  const res = await retriever.retrieve('Hà Nội', g, ep, pr, { topK: 5 });
  assert.ok(res.hits.length >= 1);
  assert.equal(res.hits[0].fact?.object, 'Hà Nội');
  assert.equal(res.candidatesScored, 2);
  const top = res.hits[0];
  assert.ok(top.scores.vector >= 0 && top.scores.vector <= 1);
  assert.ok(top.scores.bm25 >= 0 && top.scores.bm25 <= 1);
  assert.ok(top.scores.entity > 0);
  assert.ok(top.scores.total >= 0 && top.scores.total <= 1);
  assert.deepEqual(top.scores.weights, { vector: 0.45, bm25: 0.35, entity: 0.2 });
  assert.ok(top.reasons.length >= 3);
  assert.ok(top.reasons.join(' ').includes('entity'));
});

test('retrieval: asOf filters by validity window; empty store returns no hits', async () => {
  const g = new BiTemporalGraphV10();
  const ep = new EpisodicStore();
  const pr = new ProceduralStore();
  const f1 = addFact(g, CAND_HN, '2026-01-10T00:00:00.000Z');
  const f2 = addFact(g, CAND_DN, '2026-03-05T00:00:00.000Z');
  g.supersedeFact(f1.id, f2, new Date('2026-03-01T00:00:00.000Z'));
  const retriever = new FusedRetrieverV10();
  const jan = await retriever.retrieve('sống ở đâu', g, ep, pr, { asOf: new Date('2026-01-20T00:00:00.000Z') });
  assert.equal(jan.hits.length, 1);
  assert.equal(jan.hits[0].fact?.object, 'Hà Nội');
  const mar = await retriever.retrieve('sống ở đâu', g, ep, pr, { asOf: new Date('2026-03-15T00:00:00.000Z') });
  assert.equal(mar.hits[0].fact?.object, 'Đà Nẵng');
  const empty = await retriever.retrieve('x', new BiTemporalGraphV10(), new EpisodicStore(), new ProceduralStore());
  assert.equal(empty.hits.length, 0);
  assert.equal(empty.candidatesScored, 0);
});

// ---------- manager ----------

test('manager: ingestTurn end-to-end + recall + context block', async () => {
  const mgr = new MemoryManagerV10({ scope: SCOPE });
  const r1 = await mgr.ingestTurn({ role: 'user', text: 'Tôi thích ăn phở bò.', turnId: 't1' });
  assert.equal(r1.consolidation.added, 1);
  assert.equal(r1.extraction.candidates.length, 1);
  const r2 = await mgr.ingestTurn({ role: 'user', text: 'Từ tháng 3/2026 tôi sống ở Đà Nẵng.', turnId: 't2' });
  assert.equal(r2.consolidation.added, 1);
  const stats = mgr.stats();
  assert.equal(stats.episodes, 2);
  assert.equal(stats.factsActive, 2);
  assert.equal(stats.workingItems, 2);
  const recalled = await mgr.recall('phở bò');
  assert.ok(recalled.hits.some((h) => h.fact?.object === 'phở bò'));
  const ctx = await mgr.renderContextBlock('phở bò');
  assert.ok(ctx.includes('phở bò'));
  const tl = mgr.timeline('user');
  assert.ok(tl.length >= 2);
  const march = mgr.factsAt(new Date('2026-03-15T00:00:00.000Z'));
  assert.ok(march.some((f) => f.object === 'Đà Nẵng'));
});

test('manager: save/load round-trip preserves facts, episodes, procedures, blocks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v10-mgr-'));
  try {
    const mgr = new MemoryManagerV10({ scope: SCOPE, dir });
    await mgr.ingestTurn({ role: 'user', text: 'Tôi thích ăn phở bò.', turnId: 't1' });
    await mgr.ingestTurn({
      role: 'user',
      text: 'Để đăng bài lên Facebook thì làm các bước sau: bước 1 mở app, bước 2 chọn ảnh, bước 3 bấm đăng.',
      turnId: 't2',
    });
    mgr.blocks.createBlock('persona', 'semantic', 'Tôi là trợ lý.', 'tester');
    mgr.save();
    assert.ok(fs.existsSync(path.join(dir, 'memory-v10.json')));

    const mgr2 = new MemoryManagerV10({ scope: SCOPE, dir });
    const stats = mgr2.stats();
    assert.equal(stats.factsActive, 1);
    assert.equal(stats.episodes, 2);
    assert.equal(stats.procedures, 1);
    assert.equal(stats.blocks, 1);
    const recalled = await mgr2.recall('phở bò');
    assert.ok(recalled.hits.some((h) => h.fact?.object === 'phở bò'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manager: greeting turn is noise — no fact, stats stay clean', async () => {
  const mgr = new MemoryManagerV10({ scope: SCOPE });
  const r = await mgr.ingestTurn({ role: 'user', text: 'Xin chào bạn!', turnId: 't1' });
  assert.equal(r.consolidation.added, 0);
  assert.equal(mgr.stats().factsActive, 0);
  assert.equal(mgr.stats().episodes, 1);
});
