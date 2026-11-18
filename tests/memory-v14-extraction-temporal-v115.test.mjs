/**
 * Tests for v1.15 (Team T1) — memory v14:
 * packages/core/src/memory/v14/{extraction,temporalKg}.ts
 *
 * Covers:
 *  - extraction v14: new rule predicates (has_pet / owns /
 *    allergic_to / plays / knows_skill / is_friend_of / visited /
 *    eats / studies_at / born_in / favorite); temporal hints
 *    ("tu 2020", "tu thang 3/2026", "den 2026", since/until);
 *    retract intents ("khong con thich X nua" / "no longer like
 *    X" never create a likes/dislikes fact); mock LLM extractor
 *    (catches "me ...", "go-to drink", "based in") and rule-wins
 *    merge; source-trust effective confidence; applyExtractionV14
 *    appends add-only, dedupes, SUPERSEDES single-valued conflicts
 *    (keeping history), does NOT supersede multi-valued predicates
 *    (likes), retracts by closing the validity window, and routes
 *    gated candidates to quarantine via the gate callback.
 *  - temporal KG v3: supersedeFactV14 with an explicit supersededAt
 *    (old window closes exactly there, new fact starts there);
 *    factsValidAt answers "true at T" including superseded history;
 *    factTimelineV14 orders versions; closeIntervalV14;
 *    overlappingIntervalsV14 flags double-valid windows.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v14-extraction-temporal-v115.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  extractFactsV14Sync,
  extractV14RuleCandidates,
  parseTemporalHint,
  effectiveConfidenceV14,
  V14MockLlmExtractor,
  mergeRuleAndLlmCandidates,
  extractFactsV14,
  applyExtractionV14,
  isSingleValuedPredicateV14,
  supersedeFactV14,
  closeIntervalV14,
  factsValidAt,
  factTimelineV14,
  formatTimelineV14,
  overlappingIntervalsV14,
  isFactValidAtV14,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function prov(sourceText, episodeId = 'e1') {
  return {
    episodeId,
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
    scope: SCOPE,
    provenance: prov(opts.sourceText ?? `${subject} ${predicate} ${objectText}.`),
    validFrom: opts.validFrom ?? '2025-01-01T00:00:00.000Z',
    ...(opts.validUntil ? { validUntil: opts.validUntil } : {}),
  });
}

// --- temporal hints -------------------------------------------------------

test('v14 parseTemporalHint: "tu 2020" / "tu thang 3/2026" / "den 2026" / since-until', () => {
  const a = parseTemporalHint('Tôi sống ở Hà Nội từ 2020.');
  assert.equal(a.validFrom, '2020-01-01T00:00:00.000Z');
  assert.equal(a.validUntil, undefined);
  const b = parseTemporalHint('Tôi làm ở đó từ tháng 3/2026 đến năm 2027.');
  assert.equal(b.validFrom, '2026-03-01T00:00:00.000Z');
  assert.equal(b.validUntil, '2027-01-01T00:00:00.000Z');
  const c = parseTemporalHint('I have lived here since 2019 until 2024.');
  assert.equal(c.validFrom, '2019-01-01T00:00:00.000Z');
  assert.equal(c.validUntil, '2024-01-01T00:00:00.000Z');
  const d = parseTemporalHint('Tôi thích phở bò.');
  assert.deepEqual(d, {});
  // Until truoc from -> bo validUntil (khong doan nguoc).
  const e = parseTemporalHint('Tôi ở đây từ 2026 đến 2020.');
  assert.equal(e.validFrom, '2026-01-01T00:00:00.000Z');
  assert.equal(e.validUntil, undefined);
});

// --- rule predicates moi --------------------------------------------------

test('v14 rule extraction: has_pet / allergic_to / visited / studies_at / born_in / favorite', () => {
  const found = (text, predicate) =>
    extractV14RuleCandidates(text).find((c) => c.predicate === predicate);
  assert.equal(found('Tôi đang nuôi một con chó.', 'has_pet')?.objectText, 'con chó');
  assert.equal(found('Tôi bị dị ứng với đậu phộng.', 'allergic_to')?.objectText, 'đậu phộng');
  assert.equal(found('I am allergic to peanuts.', 'allergic_to')?.objectText, 'peanuts');
  assert.equal(found('Tôi đã đi du lịch Đà Lạt.', 'visited')?.objectText, 'Đà Lạt');
  assert.equal(found('Tôi đang học ở Đại học Bách Khoa.', 'studies_at')?.objectText, 'Đại học Bách Khoa');
  assert.equal(found('Tôi sinh ra ở Huế.', 'born_in')?.objectText, 'Huế');
  assert.equal(found('Món yêu thích nhất của tôi là bún chả.', 'favorite')?.objectText, 'bún chả');
  assert.equal(found('Tôi chơi bóng đá.', 'plays')?.objectText, 'bóng đá');
  assert.equal(found('Tôi giỏi nấu ăn.', 'knows_skill')?.objectText, 'nấu ăn');
  assert.equal(found('Tôi là bạn thân của Lan.', 'is_friend_of')?.objectText, 'Lan');
  assert.equal(found('Tôi ăn chay.', 'eats')?.objectText, 'chay');
  assert.equal(found('Tôi có một xe đạp.', 'owns')?.objectText, 'xe đạp');
});

test('v14 rule extraction: retract intent — "khong con thich X nua" khong tao fact likes/dislikes', () => {
  const cands = extractV14RuleCandidates('Tôi không còn thích trà sữa nữa.');
  assert.equal(cands.length, 1);
  assert.equal(cands[0].intent, 'retract');
  assert.equal(cands[0].predicate, 'likes');
  assert.equal(cands[0].objectText, 'trà sữa');
  const en = extractV14RuleCandidates('I no longer like bubble tea.');
  assert.equal(en.length, 1);
  assert.equal(en[0].intent, 'retract');
  // Cau khang dinh binh thuong van la assert (qua pipeline day du v13+v14).
  const ok = extractFactsV14Sync('Tôi thích trà sữa.');
  assert.ok(ok.some((c) => c.intent === 'assert' && c.predicate === 'likes'));
});

test('v14 extraction ke thua v13: likes/lives_in/works_at van trich duoc qua extractFactsV14Sync', () => {
  const cands = extractFactsV14Sync('Tôi thích phở bò. Tôi sống ở Hà Nội từ 2020.');
  const likes = cands.find((c) => c.predicate === 'likes');
  assert.ok(likes);
  assert.equal(likes.objectText, 'phở bò');
  assert.equal(likes.validFrom, '2020-01-01T00:00:00.000Z');
  const lives = cands.find((c) => c.predicate === 'lives_in');
  assert.ok(lives);
  // Regex v13 ke thua lay ca cum thoi gian vao object ("Ha Noi tu
  // 2020") — goi y validFrom van rut dung tu cung cau do.
  assert.ok(lives.objectText.startsWith('Hà Nội'));
  assert.equal(lives.validFrom, '2020-01-01T00:00:00.000Z');
});

// --- source trust ---------------------------------------------------------

test('v14 effectiveConfidence: trust 1 giu nguyen, trust 0 giam mot nua, khong ve 0', () => {
  const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ~= ${b}`);
  approx(effectiveConfidenceV14(0.8, 1), 0.8);
  approx(effectiveConfidenceV14(0.8, 0), 0.4);
  approx(effectiveConfidenceV14(0.8, 0.5), 0.6);
  assert.equal(effectiveConfidenceV14(2, 1), 1);
  assert.equal(effectiveConfidenceV14(0.8, -1), 0.4);
});

// --- mock LLM -------------------------------------------------------------

test('v14 mock LLM: bat cach dien dat rule bo sot; rule thang khi trung lap', async () => {
  const llm = new V14MockLlmExtractor();
  assert.equal(llm.name, 'mock-llm-v14');
  const out = await llm.extract('Tôi mê cà phê sữa đá.');
  assert.equal(out.length, 1);
  assert.equal(out[0].predicate, 'likes');
  assert.equal(out[0].objectText, 'cà phê sữa đá');
  const based = await llm.extract('I am based in Da Nang.');
  assert.equal(based[0].predicate, 'lives_in');
  assert.equal(based[0].objectText, 'Da Nang');
  assert.deepEqual(await llm.extract(''), []);
  assert.deepEqual(await llm.extract('Xin chào, hôm nay trời đẹp.'), []);

  // Merge: LLM them fact moi, rule thang khi trung.
  const rule = extractFactsV14Sync('Tôi thích phở bò.');
  const merged = mergeRuleAndLlmCandidates(rule, await llm.extract('Tôi mê phở bò.'), {
    sourceTrust: 1,
    sourceText: 'Tôi mê phở bò.',
  });
  assert.equal(merged.filter((c) => c.predicate === 'likes').length, 1);
  assert.equal(merged[0].origin, 'rule');

  // extractFactsV14 voi LLM: ca rule lan LLM-only deu co mat.
  const both = await extractFactsV14('Tôi mê cà phê sữa đá. Tôi sống ở Hà Nội.', {
    llmExtractor: llm,
  });
  assert.ok(both.some((c) => c.origin === 'llm' && c.objectText === 'cà phê sữa đá'));
  assert.ok(both.some((c) => c.origin === 'rule' && c.predicate === 'lives_in'));
  // LLM hong thi khong lam hong extraction (fail-open).
  const broken = { name: 'broken', extract: async () => { throw new Error('boom'); } };
  const fallback = await extractFactsV14('Tôi thích phở bò.', { llmExtractor: broken });
  assert.ok(fallback.some((c) => c.predicate === 'likes'));
});

// --- single-valued ----------------------------------------------------------

test('v14 isSingleValuedPredicateV14: lives_in don tri, likes da tri', () => {
  assert.equal(isSingleValuedPredicateV14('lives_in'), true);
  assert.equal(isSingleValuedPredicateV14('works_at'), true);
  assert.equal(isSingleValuedPredicateV14('born_in'), true);
  assert.equal(isSingleValuedPredicateV14('likes'), false);
  assert.equal(isSingleValuedPredicateV14('speaks'), false);
  assert.equal(isSingleValuedPredicateV14('has_pet'), false);
});

// --- applyExtractionV14 -----------------------------------------------------

test('v14 applyExtraction: append add-only + dedupe + supersede don tri giu lich su', async () => {
  const store = freshStore();
  seedFact(store, 'Lan', 'lives_in', 'Ha Noi', { confidence: 0.9 });
  const report = await applyExtractionV14(
    store,
    [{ text: 'Lan sống ở Đà Nẵng.', userId: 'u1', botId: 'b1', runId: 'r1', at: '2026-03-01T00:00:00.000Z' }],
  );
  assert.equal(report.appended.length, 1);
  assert.equal(report.superseded.length, 1);
  const old = store.getFact(report.superseded[0].oldFact.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.validUntil, '2026-03-01T00:00:00.000Z');
  assert.equal(old.supersededBy, report.superseded[0].newFact.id);
  const created = store.getFact(report.superseded[0].newFact.id);
  assert.equal(created.validFrom, '2026-03-01T00:00:00.000Z');
  assert.equal(created.supersedes, old.id);
  // Ap lai turn giong het -> dedupe.
  const again = await applyExtractionV14(
    store,
    [{ text: 'Lan sống ở Đà Nẵng.', userId: 'u1', botId: 'b1', runId: 'r1' }],
  );
  assert.equal(again.duplicates.length, 1);
  assert.equal(again.appended.length, 0);
});

test('v14 applyExtraction: likes da tri — gia tri moi song song, khong supersede', async () => {
  const store = freshStore();
  seedFact(store, 'Lan', 'likes', 'pho bo', { confidence: 0.85 });
  const report = await applyExtractionV14(
    store,
    [{ text: 'Lan thích bún chả.', userId: 'u1', botId: 'b1', runId: 'r1' }],
  );
  assert.equal(report.appended.length, 1);
  assert.equal(report.superseded.length, 0);
  const active = store.listFacts({ status: 'active', predicate: 'likes' });
  assert.equal(active.length, 2);
});

test('v14 applyExtraction: retract dong cua so fact cu, lich su truoc moc van dung', async () => {
  const store = freshStore();
  const old = seedFact(store, 'user', 'likes', 'tra sua', {
    confidence: 0.85,
    validFrom: '2025-01-01T00:00:00.000Z',
  });
  const report = await applyExtractionV14(
    store,
    [{ text: 'Tôi không còn thích trà sữa nữa.', userId: 'u1', botId: 'b1', runId: 'r1', at: '2026-02-01T00:00:00.000Z' }],
  );
  assert.equal(report.retracted.length, 1);
  assert.equal(report.appended.length, 0);
  const closed = store.getFact(old.id);
  assert.equal(closed.validUntil, '2026-02-01T00:00:00.000Z');
  assert.equal(isFactValidAtV14(closed, '2026-01-15T00:00:00.000Z'), true);
  assert.equal(isFactValidAtV14(closed, '2026-02-15T00:00:00.000Z'), false);
});

test('v14 applyExtraction: fact yeu bi drop; gate chan thi vao gated (khong ghi)', async () => {
  const store = freshStore();
  // Nguon khong tin cay -> effective confidence giam mot nua.
  const low = await applyExtractionV14(
    store,
    [{ text: 'Tôi thích phở bò.', userId: 'u1', botId: 'b1', runId: 'r1', sourceTrust: 0 }],
    { minConfidence: 0.5 },
  );
  // likes conf 0.8 * 0.5 = 0.4 < 0.5 -> drop.
  assert.equal(low.dropped.length, 1);
  assert.equal(low.appended.length, 0);

  let gatedSeen = 0;
  const gated = await applyExtractionV14(
    store,
    [{ text: 'Tôi thích phở bò.', userId: 'u1', botId: 'b1', runId: 'r1' }],
    {
      gate: () => ({ decision: 'quarantine', reason: 'test gate' }),
      onGated: () => { gatedSeen += 1; },
    },
  );
  assert.equal(gated.gated.length, 1);
  assert.equal(gated.gated[0].decision, 'quarantine');
  assert.equal(gatedSeen, 1);
  assert.equal(store.stats().activeFacts, 0);
});

// --- temporal KG v3 ---------------------------------------------------------

test('v14 supersedeFactV14: moc thay the chinh xac, lich su giu nguyen', () => {
  const store = freshStore();
  const old = seedFact(store, 'Minh', 'works_at', 'Cong ty Xanh', {
    validFrom: '2024-01-01T00:00:00.000Z',
  });
  const created = supersedeFactV14(
    store,
    old.id,
    {
      subjectName: 'Minh',
      predicate: 'works_at',
      objectText: 'Cong ty Do',
      confidence: 0.9,
      scope: SCOPE,
      provenance: prov('Minh chuyen sang Cong ty Do.'),
    },
    { supersededAt: '2026-01-15T00:00:00.000Z' },
  );
  assert.equal(created.objectText, 'Cong ty Do');
  assert.equal(created.validFrom, '2026-01-15T00:00:00.000Z');
  const oldAfter = store.getFact(old.id);
  assert.equal(oldAfter.status, 'superseded');
  assert.equal(oldAfter.validUntil, '2026-01-15T00:00:00.000Z');
  assert.equal(oldAfter.supersededBy, created.id);
  assert.throws(
    () => supersedeFactV14(store, old.id, {
      subjectName: 'Minh', predicate: 'works_at', objectText: 'Cong ty Vang',
      confidence: 0.9, scope: SCOPE, provenance: prov('x'),
    }),
    /Chi thay the duoc fact dang active/,
  );
  assert.throws(
    () => supersedeFactV14(store, 'khong-co', {
      subjectName: 'Minh', predicate: 'works_at', objectText: 'Cong ty Vang',
      confidence: 0.9, scope: SCOPE, provenance: prov('x'),
    }),
    /Khong tim thay fact/,
  );
});

test('v14 factsValidAt: tra loi "dung tai T" ke ca fact da superseded', () => {
  const store = freshStore();
  seedFact(store, 'Lan', 'lives_in', 'Ha Noi', {
    validFrom: '2025-01-01T00:00:00.000Z',
    validUntil: '2026-03-01T00:00:00.000Z',
  });
  seedFact(store, 'Lan', 'lives_in', 'Da Nang', { validFrom: '2026-03-01T00:00:00.000Z' });
  const feb = factsValidAt(store, '2026-02-15T00:00:00.000Z', { subject: 'Lan', predicate: 'lives_in' });
  assert.equal(feb.totalValid, 1);
  assert.equal(feb.facts[0].objectText, 'Ha Noi');
  const apr = factsValidAt(store, '2026-04-15T00:00:00.000Z', { subject: 'Lan' });
  assert.equal(apr.facts.some((f) => f.objectText === 'Da Nang'), true);
  assert.equal(apr.facts.some((f) => f.objectText === 'Ha Noi'), false);
  assert.throws(() => factsValidAt(store, 'khong-phai-ngay'), /khong phai thoi gian hop le/);
});

test('v14 factTimelineV14: cac phien ban theo thu tu validFrom + format', () => {
  const store = freshStore();
  const old = seedFact(store, 'Lan', 'lives_in', 'Ha Noi', { validFrom: '2025-01-01T00:00:00.000Z' });
  supersedeFactV14(
    store,
    old.id,
    {
      subjectName: 'Lan', predicate: 'lives_in', objectText: 'Da Nang',
      confidence: 0.9, scope: SCOPE, provenance: prov('Lan chuyen ve Da Nang.'),
    },
    { supersededAt: '2026-03-01T00:00:00.000Z' },
  );
  const steps = factTimelineV14(store, 'Lan', 'lives_in');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].objectText, 'Ha Noi');
  assert.equal(steps[0].status, 'superseded');
  assert.equal(steps[1].objectText, 'Da Nang');
  assert.equal(steps[1].status, 'active');
  assert.equal(steps[1].supersedes, old.id);
  const text = formatTimelineV14(steps);
  assert.match(text, /Ha Noi/);
  assert.match(text, /Da Nang/);
  assert.deepEqual(factTimelineV14(store, 'KhongCo', 'lives_in'), []);
  assert.equal(formatTimelineV14([]), '(chua co lich su)');
  assert.throws(() => factTimelineV14(store, '', 'lives_in'), /Subject khong duoc rong/);
});

test('v14 closeIntervalV14 + overlappingIntervalsV14: dong cua so va phat hien chong nhau', () => {
  const store = freshStore();
  const f = seedFact(store, 'Hoa', 'likes', 'tra sua', { validFrom: '2025-01-01T00:00:00.000Z' });
  const closed = closeIntervalV14(store, f.id, '2026-02-01T00:00:00.000Z', 'doi mon');
  assert.equal(closed.validUntil, '2026-02-01T00:00:00.000Z');
  assert.throws(
    () => closeIntervalV14(store, f.id, '2026-03-01T00:00:00.000Z'),
    /da het hieu luc/,
  );

  // Hai fact cung (subject, predicate) chong cua so -> bao loi.
  const store2 = freshStore();
  seedFact(store2, 'Lan', 'lives_in', 'Ha Noi', {
    validFrom: '2025-01-01T00:00:00.000Z',
    validUntil: '2026-06-01T00:00:00.000Z',
  });
  seedFact(store2, 'Lan', 'lives_in', 'Da Nang', { validFrom: '2026-03-01T00:00:00.000Z' });
  const overlaps = overlappingIntervalsV14(store2);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].subject, 'lan');
  assert.equal(overlaps[0].predicate, 'lives_in');
  assert.equal(overlaps[0].overlapFrom, '2026-03-01T00:00:00.000Z');
  // Store sach thi khong co overlap.
  assert.deepEqual(overlappingIntervalsV14(store), []);
});
