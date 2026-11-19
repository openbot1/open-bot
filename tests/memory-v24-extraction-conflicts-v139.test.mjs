/**
 * Tests for memory v24 — extraction ADD-only + conflicts (v1.39, Doi T1).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v24-extraction-conflicts-v139.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V24Store,
  buildResolutionV24,
  classifyConflictV24,
  decideResolutionV24,
  detectConflictsV24,
  extractEntitiesV24,
  extractFromSentenceV24,
  extractV24Candidates,
  inferValidTimeV24,
  isNoiseSentenceV24,
  makeV24Scope,
  resolveConflictAutoV24,
} from '../packages/core/dist/memory/v24/index.js';

const NOW = 1794000000000;
const SCOPE = makeV24Scope({ userId: 'u1', agentId: 'bot-a' });

function provenance() {
  return {
    episodeId: 'ep1',
    turnId: 't1',
    runId: '',
    botId: 'bot-a',
    userId: 'u1',
    sourceText: 'test',
    method: 'rule',
    extractor: 'v24-rule-v1',
  };
}

function store() {
  return new V24Store({ now: () => NOW });
}

// --- Extraction ---

test('v24 extract: preference + decision + procedure + fact duoc phan loai', () => {
  const res = extractV24Candidates([
    { role: 'user', text: 'Tôi thích cà phê đen, không đường. Chúng ta đã quyết định dùng Postgres cho dự án mới.' },
    { role: 'user', text: 'Cách làm: bước 1 mở file config, bước 2 sửa port thành 8080.' },
    { role: 'user', text: 'Tôi sống ở Hà Nội.' },
  ], { nowMs: NOW });
  const kinds = res.candidates.map((c) => c.kind);
  assert.ok(kinds.includes('preference'), `thieu preference: ${kinds}`);
  assert.ok(kinds.includes('decision'), `thieu decision: ${kinds}`);
  assert.ok(kinds.includes('procedure'), `thieu procedure: ${kinds}`);
  assert.ok(kinds.includes('fact'), `thieu fact: ${kinds}`);
  const pref = res.candidates.find((c) => c.kind === 'preference');
  assert.equal(pref.edge, 'prefers');
  assert.ok(pref.object.includes('cà phê'));
  for (const c of res.candidates) assert.ok(c.confidence >= 0.3 && c.confidence <= 0.95);
});

test('v24 extract: noise bi loai, trung lap trong pass bi dedupe', () => {
  const res = extractV24Candidates([
    { role: 'user', text: 'Xin chào! Cảm ơn bạn nhé.' },
    { role: 'user', text: 'Tôi thích cà phê đen. Tôi thích cà phê đen.' },
  ], { nowMs: NOW });
  assert.ok(res.noiseTurns >= 1, `noiseTurns=${res.noiseTurns}`);
  assert.equal(res.candidates.length, 1, `chi 1 candidate sau dedupe, duoc ${res.candidates.length}`);
  assert.ok(res.dedupedWithinPass >= 1);
});

test('v24 extract: negation + valid-time + entity', () => {
  const neg = extractFromSentenceV24('Tôi không còn thích trà sữa.', NOW);
  assert.ok(neg, 'phai trich duoc cau phu dinh');
  assert.equal(neg.isNegation, true);
  assert.equal(neg.edge, 'prefers');
  const enNeg = extractFromSentenceV24('I no longer like black coffee.', NOW);
  assert.ok(enNeg && enNeg.isNegation, 'phai trich duoc "no longer like"');
  const timed = extractFromSentenceV24('Tôi sống ở Hà Nội từ nay.', NOW);
  assert.ok(timed.validFrom, 'phai suy ra validFrom tu "từ nay"');
  assert.equal(new Date(timed.validFrom).getTime(), NOW);
  const dated = inferValidTimeV24('Hợp đồng từ 2026-01-15.', NOW);
  assert.equal(dated.validFrom, '2026-01-15T00:00:00.000Z');
  assert.deepEqual(extractEntitiesV24('Tôi làm việc ở FPT tại Hà Nội.').sort(), ['FPT', 'Hà Nội'].sort());
  assert.equal(isNoiseSentenceV24('Xin chào!'), true);
  assert.equal(isNoiseSentenceV24('Tôi thích cà phê đen.'), false);
});

// --- Conflicts ---

test('v24 conflict: classify + detect + auto-resolve supersede', () => {
  const s = store();
  const put = s.putFact(
    { subject: 'user', edge: 'lives_in', object: 'Hà Nội', kind: 'fact', confidence: 0.9, isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi sống ở Hà Nội.', reason: 'test' },
    { scope: SCOPE, provenance: provenance() },
  );
  assert.equal(put.ok, true);
  const incoming = {
    subject: 'user', edge: 'lives_in', object: 'TP.HCM', kind: 'fact', confidence: 0.9,
    isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi sống ở TP.HCM.', reason: 'test',
  };
  assert.equal(classifyConflictV24(incoming, put.value), 'same_edge_different_object');
  const found = detectConflictsV24(incoming, [put.value], SCOPE, { nowMs: NOW });
  assert.equal(found.length, 1);
  assert.ok(found[0].severity >= 0.7);
  const { strategy, resolution } = resolveConflictAutoV24(found[0], put.value, { nowMs: NOW });
  assert.equal(strategy, 'supersede');
  assert.equal(resolution.decidedBy, 'auto');
  assert.ok(resolution.reason.length > 0);
});

test('v24 conflict: fact cu tin cay cao -> keep_both; trung lap -> merge', () => {
  const s = store();
  const put = s.putFact(
    { subject: 'user', edge: 'prefers', object: 'cà phê đen', kind: 'preference', confidence: 0.95, isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi thích cà phê đen.', reason: 'test' },
    { scope: SCOPE, provenance: provenance() },
  );
  const weakIncoming = {
    subject: 'user', edge: 'prefers', object: 'trà sữa', kind: 'preference', confidence: 0.6,
    isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi thích trà sữa.', reason: 'test',
  };
  // prefers KHONG phai single-valued -> khong conflict (duoc phep nhieu so thich).
  assert.equal(classifyConflictV24(weakIncoming, put.value), null);

  const put2 = s.putFact(
    { subject: 'user', edge: 'lives_in', object: 'Hà Nội', kind: 'fact', confidence: 0.95, isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi sống ở Hà Nội.', reason: 'test' },
    { scope: SCOPE, provenance: provenance() },
  );
  const weakMove = {
    subject: 'user', edge: 'lives_in', object: 'Đà Nẵng', kind: 'fact', confidence: 0.6,
    isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi sống ở Đà Nẵng.', reason: 'test',
  };
  const decided = decideResolutionV24(
    detectConflictsV24(weakMove, [put2.value], SCOPE, { nowMs: NOW })[0], put2.value,
  );
  assert.equal(decided.strategy, 'keep_both');

  const dup = {
    subject: 'user', edge: 'lives_in', object: 'Hà Nội', kind: 'fact', confidence: 0.9,
    isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi sống ở Hà Nội.', reason: 'test',
  };
  assert.equal(classifyConflictV24(dup, put2.value), 'duplicate');
  const dupConflict = detectConflictsV24(dup, [put2.value], SCOPE, { nowMs: NOW })[0];
  assert.equal(decideResolutionV24(dupConflict, put2.value).strategy, 'merge');
});

test('v24 conflict: negation tin cay cao -> supersede; resolution co provenance', () => {
  const s = store();
  const put = s.putFact(
    { subject: 'user', edge: 'prefers', object: 'trà sữa', kind: 'preference', confidence: 0.8, isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi thích trà sữa.', reason: 'test' },
    { scope: SCOPE, provenance: provenance() },
  );
  const neg = {
    subject: 'user', edge: 'prefers', object: 'trà sữa', kind: 'preference', confidence: 0.85,
    isNegation: true, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi không còn thích trà sữa.', reason: 'test',
  };
  // Cung object + negation: classify theo rule hien tai -> duplicate truoc (cung triple).
  // De test negation_vs_positive dung object khac + isNegation.
  const negOther = { ...neg, object: 'cà phê' };
  assert.equal(classifyConflictV24(negOther, put.value), 'negation_vs_positive');
  const conflict = detectConflictsV24(negOther, [put.value], SCOPE, { nowMs: NOW })[0];
  const decided = decideResolutionV24(conflict, put.value);
  assert.equal(decided.strategy, 'supersede');
  const resolution = buildResolutionV24(conflict, 'supersede', {
    decidedBy: 'user', reason: 'User xac nhan khong thich nua.', resultingFactId: 'f_new', nowMs: NOW,
  });
  assert.equal(resolution.decidedBy, 'user');
  assert.equal(resolution.resultingFactId, 'f_new');
  assert.equal(resolution.affectedFactId, put.value.id);
  assert.equal(resolution.decidedAt, new Date(NOW).toISOString());
});

test('v24 store applyResolution: supersede doi status fact cu, khong xoa', () => {
  const s = store();
  const put = s.putFact(
    { subject: 'user', edge: 'lives_in', object: 'Hà Nội', kind: 'fact', confidence: 0.9, isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi sống ở Hà Nội.', reason: 'test' },
    { scope: SCOPE, provenance: provenance() },
  );
  const incoming = {
    subject: 'user', edge: 'lives_in', object: 'TP.HCM', kind: 'fact', confidence: 0.9,
    isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi sống ở TP.HCM.', reason: 'test',
  };
  const conflict = s.detectConflicts(incoming, SCOPE)[0];
  const applied = s.applyResolution(conflict, 'supersede', {
    scope: SCOPE, provenance: provenance(), decidedBy: 'auto', reason: 'test supersede',
  });
  assert.equal(applied.ok, true);
  assert.ok(applied.value.resultingFactId);
  const oldFact = s.getFact(put.value.id);
  assert.equal(oldFact.status, 'superseded');
  assert.equal(oldFact.supersededById, applied.value.resultingFactId);
  assert.ok(oldFact.invalidatedAt);
  const newFact = s.getFact(applied.value.resultingFactId);
  assert.equal(newFact.supersedesId, put.value.id);
  assert.equal(newFact.object, 'TP.HCM');
  assert.equal(s.listConflicts({ openOnly: true }).length, 0);
  assert.equal(s.listResolutions().length, 1);
});
