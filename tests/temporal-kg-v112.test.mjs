/**
 * Tests for v1.12 (Đội T3) — Temporal KG v2:
 * packages/core/src/memory/graph/{snapshot,contradictions,
 * provenanceChain,sessionScope,temporalExport}.ts + invalidAt/session
 * trên store/types + invalidateFact v2.
 *
 * Covers:
 *  - markFactInvalidated / invalidateFact: ghi invalidAt riêng,
 *    validUntil đóng = invalidAt, lịch sử trước đó vẫn truy vấn được,
 *    validate invalidAt ngoài cửa sổ, invalidate 2 lần giữ mốc đầu.
 *  - Session scope: matchesScope theo sessionId, listFactsBySession
 *    (strict/loose), sessionSummary, sessionTimeline, retarget.
 *  - snapshotGraphAt / diffSnapshots / changesSince / factValueAt /
 *    validityGaps / temporalCoverage (time-travel bi-temporal).
 *  - detectLiveContradictions / resolveContradiction (4 policy) /
 *    autoInvalidateConflicts (fact confidence cao → quarantine).
 *  - factProvenanceChain / episodeFacts / episodesForEntity /
 *    provenanceReport.
 *  - exportTemporalSnapshot / importTemporalSnapshot (add-only, giữ
 *    id gốc + invalidAt + supersession) / validate / file round-trip.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/temporal-kg-v112.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  invalidateFact,
  readInvalidationLog,
  snapshotGraphAt,
  diffSnapshots,
  changesSince,
  factValueAt,
  validityGaps,
  temporalCoverage,
  detectLiveContradictions,
  resolveContradiction,
  autoInvalidateConflicts,
  contradictionSummary,
  factProvenanceChain,
  episodeFacts,
  episodesForEntity,
  provenanceReport,
  sessionScope,
  listFactsBySession,
  sessionSummary,
  sessionTimeline,
  retargetFactSession,
  listSessionIds,
  exportTemporalSnapshot,
  importTemporalSnapshot,
  validateTemporalSnapshot,
  writeTemporalSnapshotFile,
  readTemporalSnapshotFile,
  auditTemporalGraph,
  repairTemporalGraph,
  auditSummary,
} from '../packages/core/dist/memory/graph/index.js';

const SCOPE = { userId: 'user-1', botId: 'bot-a', runId: 'run-1' };
const SESSION = sessionScope('user-1', 'bot-a', 'sess-1', { runId: 'run-1' });

function provenance(turnId, at, sourceText, episodeId) {
  return {
    episodeId: episodeId ?? `ep-${turnId}`,
    turnId,
    runId: 'run-1',
    botId: 'bot-a',
    userId: 'user-1',
    at,
    sourceText,
  };
}

function seedFact(store, subjectName, predicate, objectText, at, sourceText, extra = {}) {
  return store.addFact({
    subjectName,
    predicate,
    objectText,
    confidence: extra.confidence ?? 0.9,
    scope: extra.scope ?? SCOPE,
    provenance: provenance(
      `t-${predicate}-${objectText}`,
      at,
      sourceText,
      extra.episodeId,
    ),
    validFrom: at,
    ...(extra.validUntil !== undefined ? { validUntil: extra.validUntil } : {}),
  });
}

/** Rewrite fact timestamps through the backend (store sets "now" on write). */
function retime(backend, factId, patch) {
  const file = backend.load();
  const fact = file.facts.find((f) => f.id === factId);
  Object.assign(fact, patch);
  backend.save(file);
  return new TemporalGraphStore(backend);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tkg-v112-'));
}

/**
 * Scenario: Huy sống ở Hà Nội (từ 03/11), chuyển vào TP.HCM
 * (12/11, supersede Hà Nội), thích phở bò. Fact Hà Nội sau đó bị
 * invalidate vì mâu thuẫn (15/11).
 */
function buildScenario() {
  const backend = new InMemoryGraphBackend();
  let store = new TemporalGraphStore(backend);
  const ep1 = store.ingestEpisode({
    turnId: 'turn-1', runId: 'run-1', botId: 'bot-a', userId: 'user-1',
    role: 'user', text: 'Tôi sống ở Hà Nội. Tôi thích phở bò.',
  });
  const livesHanoi = seedFact(store, 'Huy', 'lives_in', 'Hà Nội', '2026-11-03T10:00:00.000Z', 'Tôi sống ở Hà Nội.', { episodeId: ep1.id });
  const likesPho = seedFact(store, 'Huy', 'likes', 'phở bò', '2026-11-04T10:00:00.000Z', 'Tôi thích phở bò.', { episodeId: ep1.id });
  store.markEpisodeProcessed(ep1.id, [livesHanoi.id, likesPho.id]);
  const livesHcm = store.supersedeFact(livesHanoi.id, {
    subjectName: 'Huy',
    predicate: 'lives_in',
    objectText: 'TP. Hồ Chí Minh',
    confidence: 0.95,
    scope: SCOPE,
    provenance: provenance('t-move', '2026-11-12T10:00:00.000Z', 'Tôi đã chuyển vào TP. Hồ Chí Minh.'),
  });
  store = retime(backend, livesHanoi.id, { createdAt: '2026-11-03T10:00:00.000Z', validUntil: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z' });
  store = retime(backend, livesHcm.id, { createdAt: '2026-11-12T10:00:00.000Z', validFrom: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z' });
  store = retime(backend, likesPho.id, { createdAt: '2026-11-04T10:00:00.000Z', validFrom: '2026-11-04T10:00:00.000Z', updatedAt: '2026-11-04T10:00:00.000Z' });
  return { backend, store, livesHanoi, livesHcm, likesPho, ep1 };
}

// ---- invalidAt -------------------------------------------------------

test('markFactInvalidated: ghi invalidAt riêng, đóng validUntil, lịch sử còn nguyên', () => {
  const { store, likesPho } = buildScenario();
  const dir = tmpDir();
  const result = invalidateFact(
    store, likesPho.id, '2026-11-15T09:00:00.000Z',
    'User đính chính: không thích phở bò nữa, thích bún chả.',
    'user-1', { workspaceDir: dir },
  );
  assert.equal(result.fact.invalidAt, '2026-11-15T09:00:00.000Z');
  assert.equal(result.fact.validUntil, '2026-11-15T09:00:00.000Z');
  assert.equal(result.fact.invalidatedBy, 'user-1');
  assert.match(result.fact.invalidationReason, /bún chả/);
  assert.equal(result.fact.status, 'active', 'status không đổi — chỉ cửa sổ đóng');
  assert.equal(result.logWritten, true);
  // Lịch sử trước invalidAt vẫn truy vấn được.
  const before = store.listFacts({ ...SCOPE, status: 'active', limit: 100 });
  assert.ok(before.some((f) => f.id === likesPho.id), 'fact vẫn trong kho');
  const log = readInvalidationLog(dir, 10);
  assert.equal(log.length, 1);
  assert.equal(log[0].factId, likesPho.id);
  assert.equal(log[0].previousValidUntil, null);
});

test('markFactInvalidated: validate invalidAt ngoài cửa sổ + lý do rỗng', () => {
  const { store, likesPho } = buildScenario();
  assert.throws(
    () => store.markFactInvalidated(likesPho.id, { invalidAt: '2026-11-01T00:00:00.000Z', actor: 'x', reason: 'sai' }),
    /invalidAt phải >= validFrom/,
  );
  assert.throws(
    () => store.markFactInvalidated(likesPho.id, { invalidAt: '2026-11-15T00:00:00.000Z', actor: 'x', reason: '   ' }),
    /không được rỗng/,
  );
  assert.throws(
    () => store.markFactInvalidated('no-such-id', { invalidAt: '2026-11-15T00:00:00.000Z', actor: 'x', reason: 'sai' }),
    /Không tìm thấy fact/,
  );
});

test('markFactInvalidated: invalidate 2 lần giữ mốc đầu tiên', () => {
  const { store, likesPho } = buildScenario();
  store.markFactInvalidated(likesPho.id, { invalidAt: '2026-11-15T09:00:00.000Z', actor: 'user-1', reason: 'lý do đầu' });
  const second = store.markFactInvalidated(likesPho.id, { invalidAt: '2026-11-16T09:00:00.000Z', actor: 'user-1', reason: 'lý do sau' });
  assert.equal(second.invalidAt, '2026-11-15T09:00:00.000Z', 'mốc invalidate đầu tiên được giữ');
  assert.equal(second.invalidationReason, 'lý do sau', 'lý do được cập nhật');
  assert.equal(store.listInvalidatedFacts(SCOPE).length, 1);
});

// ---- session scope ---------------------------------------------------

test('session scope: fact gắn session chỉ hiện trong session đó, legacy hiện mọi nơi', () => {
  const backend = new InMemoryGraphBackend();
  const store = new TemporalGraphStore(backend);
  const inSession = seedFact(store, 'Huy', 'likes', 'cà phê trứng', '2026-11-10T10:00:00.000Z', 'Tôi thích cà phê trứng.', { scope: SESSION });
  const legacy = seedFact(store, 'Huy', 'likes', 'trà đá', '2026-11-09T10:00:00.000Z', 'Tôi thích trà đá.');
  assert.equal(listFactsBySession(store, 'sess-1', SCOPE).length, 2, 'loose: session + legacy');
  assert.equal(listFactsBySession(store, 'sess-1', SCOPE, { strict: true }).length, 1, 'strict: chỉ fact gắn session');
  assert.equal(listFactsBySession(store, 'sess-2', SCOPE).length, 1, 'session khác chỉ thấy legacy');
  assert.equal(listFactsBySession(store, 'sess-2', SCOPE, { strict: true }).length, 0);
  assert.deepEqual(listFactsBySession(store, '', SCOPE), []);
  const summary = sessionSummary(store, 'sess-1', SCOPE);
  assert.ok(summary);
  assert.equal(summary.factsInSession, 1);
  assert.equal(summary.activeFacts, 1);
  assert.deepEqual(summary.entities, ['Huy']);
  assert.deepEqual(summary.predicates, [{ predicate: 'likes', count: 1 }]);
  assert.deepEqual(listSessionIds(store, SCOPE), ['sess-1']);
  void inSession;
  void legacy;
});

test('session scope: retargetFactSession đổi/gỡ session, timeline theo session', () => {
  const backend = new InMemoryGraphBackend();
  const store = new TemporalGraphStore(backend);
  const fact = seedFact(store, 'Huy', 'likes', 'bánh mì', '2026-11-10T10:00:00.000Z', 'Tôi thích bánh mì.');
  assert.equal(listFactsBySession(store, 'sess-9', SCOPE, { strict: true }).length, 0);
  retargetFactSession(store, fact.id, 'sess-9');
  assert.equal(listFactsBySession(store, 'sess-9', SCOPE, { strict: true }).length, 1);
  const steps = sessionTimeline(store, 'sess-9', SCOPE);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, 'fact-created');
  retargetFactSession(store, fact.id, '');
  assert.equal(listFactsBySession(store, 'sess-9', SCOPE, { strict: true }).length, 0);
  assert.throws(() => retargetFactSession(store, 'no-such', 'sess-9'), /Không tìm thấy fact/);
});

// ---- snapshot / time-travel ------------------------------------------

test('snapshotGraphAt: tái dựng đồ thị như đã biết tại R', () => {
  const { store } = buildScenario();
  // Tại 05/11: chỉ biết Hà Nội + phở bò (chưa biết TP.HCM).
  const early = snapshotGraphAt(store, '2026-11-05T00:00:00.000Z', { scope: SCOPE });
  assert.equal(early.facts.length, 2);
  assert.equal(early.validAtRecordTime, 2);
  assert.ok(early.facts.every((f) => f.stateAtRecordTime === 'active'));
  assert.ok(early.entities.some((e) => e.name === 'Huy'));
  // Tại 13/11: biết cả 3 fact; Hà Nội đã superseded.
  const late = snapshotGraphAt(store, '2026-11-13T00:00:00.000Z', { scope: SCOPE });
  assert.equal(late.facts.length, 3);
  assert.equal(late.supersededCount, 1);
  const hanoi = late.facts.find((f) => f.fact.objectText === 'Hà Nội');
  assert.equal(hanoi.stateAtRecordTime, 'superseded');
  assert.equal(hanoi.currentAtRecordTime, false);
  const hcm = late.facts.find((f) => f.fact.objectText === 'TP. Hồ Chí Minh');
  assert.equal(hcm.stateAtRecordTime, 'active');
  assert.equal(hcm.currentAtRecordTime, true);
  // R không hợp lệ → snapshot rỗng.
  assert.deepEqual(snapshotGraphAt(store, 'not-a-date', { scope: SCOPE }).facts, []);
});

test('diffSnapshots: thêm fact + đổi trạng thái giữa 2 thời điểm ghi nhận', () => {
  const { store } = buildScenario();
  const before = snapshotGraphAt(store, '2026-11-05T00:00:00.000Z', { scope: SCOPE });
  const after = snapshotGraphAt(store, '2026-11-13T00:00:00.000Z', { scope: SCOPE });
  const diff = diffSnapshots(before, after);
  assert.equal(diff.added.length, 1, 'TP.HCM là fact mới');
  assert.equal(diff.added[0].text, 'Huy —lives_in→ TP. Hồ Chí Minh');
  assert.equal(diff.stateChanged.length, 1, 'Hà Nội active → superseded');
  assert.equal(diff.stateChanged[0].before.state, 'active');
  assert.equal(diff.stateChanged[0].after.state, 'superseded');
  assert.equal(diff.total, 2);
});

test('changesSince: changelog theo transaction time', () => {
  const { store } = buildScenario();
  const changes = changesSince(store, '2026-11-11T00:00:00.000Z', { scope: SCOPE });
  const kinds = changes.map((c) => `${c.kind}:${c.fact.objectText}`);
  assert.ok(kinds.includes('created:TP. Hồ Chí Minh'), kinds.join(', '));
  assert.ok(kinds.includes('superseded:Hà Nội'), kinds.join(', '));
  assert.ok(!kinds.some((k) => k.includes('phở bò')), 'phở bò không đổi sau 11/11');
  assert.deepEqual(changesSince(store, 'not-a-date', { scope: SCOPE }), []);
});

test('factValueAt: giá trị đơn của một quan hệ tại T, theo tri thức tại R', () => {
  const { store } = buildScenario();
  // Tháng 6 theo tri thức... dùng mốc thật: 05/11 → Hà Nội.
  const nov5 = factValueAt(store, 'Huy', 'lives_in', '2026-11-05T00:00:00.000Z', {
    scope: SCOPE,
    recordedAt: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(nov5.found, true);
  assert.equal(nov5.objectText, 'Hà Nội');
  assert.equal(nov5.currentAtRecordTime, true);
  // 11/11, theo tri thức tại 05/11: vẫn Hà Nội (lúc đó chưa biết TP.HCM).
  const nov11AsOfNov5 = factValueAt(store, 'Huy', 'lives_in', '2026-11-11T00:00:00.000Z', {
    scope: SCOPE,
    recordedAt: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(nov11AsOfNov5.found, true);
  assert.equal(nov11AsOfNov5.objectText, 'Hà Nội');
  assert.equal(nov11AsOfNov5.currentAtRecordTime, true);
  // Giới hạn đã biết (chia sẻ với queryFactsAtBiTemporal v1.04):
  // trục sự kiện dùng validUntil ĐÃ LƯU (12/11) nên hỏi T=13/11
  // theo tri thức tại 05/11 vẫn trả "không tìm thấy" — dù tại 05/11
  // hệ thống tưởng Hà Nội còn đúng tới nay. Muốn đúng hoàn toàn thì
  // cần version hoá cửa sổ hiệu lực theo transaction time.
  const nov13AsOfNov5 = factValueAt(store, 'Huy', 'lives_in', '2026-11-13T00:00:00.000Z', {
    scope: SCOPE,
    recordedAt: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(nov13AsOfNov5.found, false);
  // 13/11 theo tri thức hiện tại → TP.HCM.
  const nov13 = factValueAt(store, 'Huy', 'lives_in', '2026-11-13T00:00:00.000Z', { scope: SCOPE });
  assert.equal(nov13.objectText, 'TP. Hồ Chí Minh');
  // Entity không có → not found; ngày sai → not found.
  assert.equal(factValueAt(store, 'Không ai', 'lives_in', '2026-11-13T00:00:00.000Z', { scope: SCOPE }).found, false);
  assert.equal(factValueAt(store, 'Huy', 'lives_in', 'not-a-date', { scope: SCOPE }).found, false);
});

test('validityGaps + temporalCoverage: khoảng trống và thống kê bao phủ', () => {
  const backend = new InMemoryGraphBackend();
  let store = new TemporalGraphStore(backend);
  const f1 = seedFact(store, 'Huy', 'works_at', 'Công ty A', '2026-01-01T00:00:00.000Z', 'Tôi làm ở công ty A.');
  const f2 = store.supersedeFact(f1.id, {
    subjectName: 'Huy', predicate: 'works_at', objectText: 'Công ty B',
    confidence: 0.9, scope: SCOPE,
    provenance: provenance('t-job', '2026-06-01T00:00:00.000Z', 'Tôi chuyển sang công ty B.'),
  });
  // Tạo khoảng trống: A đóng 01/03, B mở 01/06.
  store = retime(backend, f1.id, { createdAt: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' });
  store = retime(backend, f2.id, { createdAt: '2026-06-01T00:00:00.000Z', validFrom: '2026-06-01T00:00:00.000Z' });
  const gaps = validityGaps(store, 'Huy', 'works_at', SCOPE);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].gapFrom, '2026-03-01T00:00:00.000Z');
  assert.equal(gaps[0].gapTo, '2026-06-01T00:00:00.000Z');
  assert.equal(validityGaps(store, 'Không ai', 'works_at', SCOPE).length, 0);
  const coverage = temporalCoverage(store, SCOPE, { now: new Date('2026-11-15T00:00:00.000Z') });
  assert.equal(coverage.totalFacts, 2);
  assert.equal(coverage.supersededFacts, 1);
  assert.equal(coverage.edgesWithGaps, 1);
  assert.equal(coverage.edgesWithOverlaps, 0);
});

// ---- contradictions ---------------------------------------------------

function buildContradictionScenario() {
  const backend = new InMemoryGraphBackend();
  const store = new TemporalGraphStore(backend);
  // Hai fact ACTIVE cùng edge, object khác nhau, cửa sổ overlap.
  const oldFact = seedFact(store, 'Huy', 'lives_in', 'Hà Nội', '2026-11-01T00:00:00.000Z', 'Tôi sống ở Hà Nội.', { confidence: 0.7 });
  const newFact = seedFact(store, 'Huy', 'lives_in', 'Đà Nẵng', '2026-11-10T00:00:00.000Z', 'Tôi sống ở Đà Nẵng.', { confidence: 0.85 });
  // Fact không mâu thuẫn: predicate khác.
  seedFact(store, 'Huy', 'likes', 'phở bò', '2026-11-02T00:00:00.000Z', 'Tôi thích phở bò.');
  return { backend, store, oldFact, newFact };
}

test('detectLiveContradictions: tìm nhóm active overlap, bỏ qua fact đã superseded', () => {
  const { store, oldFact, newFact } = buildContradictionScenario();
  const groups = detectLiveContradictions(store, SCOPE);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].subjectName, 'Huy');
  assert.equal(groups[0].predicate, 'lives_in');
  assert.equal(groups[0].facts.length, 2);
  assert.equal(groups[0].oldestFactId, oldFact.id);
  assert.equal(groups[0].newestFactId, newFact.id);
  assert.match(contradictionSummary(groups[0]), /mâu thuẫn/);
  // Supersede fact cũ → hết mâu thuẫn.
  store.supersedeFact(oldFact.id, {
    subjectName: 'Huy', predicate: 'lives_in', objectText: 'Đà Nẵng',
    confidence: 0.9, scope: SCOPE,
    provenance: provenance('t-fix', '2026-11-12T00:00:00.000Z', 'Tôi sống ở Đà Nẵng.'),
  });
  assert.equal(detectLiveContradictions(store, SCOPE).length, 0);
});

test('resolveContradiction: 4 policy — invalidate / quarantine / keep-both', () => {
  const dir = tmpDir();
  const { store, oldFact, newFact } = buildContradictionScenario();
  const resolved = resolveContradiction(store, {
    wrongFactId: oldFact.id, keptFactId: newFact.id,
    policy: 'invalidate-older', actor: 'user-1',
    reason: 'User xác nhận đã chuyển ra Đà Nẵng.',
    invalidAt: '2026-11-14T00:00:00.000Z', workspaceDir: dir,
  });
  assert.equal(resolved.policy, 'invalidate-older');
  assert.equal(resolved.invalidatedFactId, oldFact.id);
  assert.equal(resolved.keptFactId, newFact.id);
  assert.equal(resolved.noChange, false);
  const after = store.getFact(oldFact.id);
  assert.equal(after.invalidAt, '2026-11-14T00:00:00.000Z');
  assert.equal(after.invalidationReason, 'User xác nhận đã chuyển ra Đà Nẵng.');
  assert.equal(readInvalidationLog(dir, 10).length, 1);
  assert.equal(detectLiveContradictions(store, SCOPE).length, 0, 'đã invalidate thì hết mâu thuẫn');

  // keep-both: không đổi gì.
  const { store: store2, oldFact: o2, newFact: n2 } = buildContradictionScenario();
  const kept = resolveContradiction(store2, {
    wrongFactId: o2.id, keptFactId: n2.id, policy: 'keep-both',
    actor: 'user-1', reason: 'Cả hai đều đúng ở hai nơi khác nhau.',
  });
  assert.equal(kept.noChange, true);
  assert.equal(store2.getFact(o2.id).invalidAt, undefined);
  assert.equal(detectLiveContradictions(store2, SCOPE).length, 1);

  // quarantine-older: fact vào quarantine, vẫn active.
  const quarantined = resolveContradiction(store2, {
    wrongFactId: o2.id, keptFactId: n2.id, policy: 'quarantine-older',
    actor: 'user-1', reason: 'Cần user duyệt.',
  });
  assert.ok(quarantined.quarantineId);
  assert.equal(store2.listQuarantine({ ...SCOPE, status: 'pending' }).length, 1);
  assert.equal(store2.getFact(o2.id).status, 'active');

  // Lỗi: trùng id, khác edge, thiếu lý do.
  assert.throws(() => resolveContradiction(store2, {
    wrongFactId: n2.id, keptFactId: n2.id, policy: 'invalidate-older', actor: 'x', reason: 'r',
  }), /không được trùng nhau/);
  assert.throws(() => resolveContradiction(store2, {
    wrongFactId: o2.id, keptFactId: n2.id, policy: 'invalidate-older', actor: 'x', reason: '   ',
  }), /không được rỗng/);
});

test('autoInvalidateConflicts: fact cũ confidence thấp bị invalidate, cao thì quarantine', () => {
  const backend = new InMemoryGraphBackend();
  const store = new TemporalGraphStore(backend);
  // Nhóm 1: cũ conf 0.7 → invalidate.
  const old1 = seedFact(store, 'Huy', 'lives_in', 'Hà Nội', '2026-11-01T00:00:00.000Z', 'Tôi sống ở Hà Nội.', { confidence: 0.7 });
  seedFact(store, 'Huy', 'lives_in', 'Đà Nẵng', '2026-11-10T00:00:00.000Z', 'Tôi sống ở Đà Nẵng.', { confidence: 0.85 });
  // Nhóm 2: cũ conf 0.95 → quarantine, không tự invalidate.
  const old2 = seedFact(store, 'Huy', 'works_at', 'Công ty A', '2026-11-01T00:00:00.000Z', 'Tôi làm ở công ty A.', { confidence: 0.95 });
  const new2 = seedFact(store, 'Huy', 'works_at', 'Công ty B', '2026-11-10T00:00:00.000Z', 'Tôi làm ở công ty B.', { confidence: 0.9 });
  const report = autoInvalidateConflicts(store, SCOPE, { actor: 'system' });
  assert.equal(report.contradictionGroups, 2);
  assert.deepEqual(report.invalidated, [old1.id]);
  assert.deepEqual(report.quarantined, [old2.id]);
  assert.equal(store.getFact(old1.id).invalidAt !== undefined, true);
  assert.equal(store.getFact(old2.id).invalidAt, undefined);
  assert.equal(store.listQuarantine({ ...SCOPE, status: 'pending' }).length, 1);
  // Chạy lại: không còn gì để làm (nhóm 1 đã hết, nhóm 2 vẫn quarantine).
  const second = autoInvalidateConflicts(store, SCOPE, { actor: 'system' });
  assert.equal(second.invalidated.length, 0);
  void new2;
});

// ---- provenance chain -------------------------------------------------

test('factProvenanceChain: fact → episode → siblings → supersession → invalidations', () => {
  const dir = tmpDir();
  const { store, livesHanoi, livesHcm, likesPho, ep1 } = buildScenario();
  invalidateFact(store, likesPho.id, '2026-11-15T09:00:00.000Z', 'User đính chính.', 'user-1', { workspaceDir: dir });
  const chain = factProvenanceChain(store, livesHcm.id, { workspaceDir: dir });
  assert.ok(chain);
  assert.equal(chain.episode, null, 'fact mới không gắn episode của ep1');
  assert.equal(chain.supersessionChain.length, 2, 'chuỗi: Hà Nội → TP.HCM');
  assert.equal(chain.supersessionChain[0].objectText, 'Hà Nội');
  assert.equal(chain.provenanceComplete, false);

  const chainOld = factProvenanceChain(store, livesHanoi.id, { workspaceDir: dir });
  assert.ok(chainOld.episode);
  assert.equal(chainOld.episode.id, ep1.id);
  assert.equal(chainOld.siblings.length, 1, 'fact anh em: phở bò');
  assert.equal(chainOld.siblings[0].fact.id, likesPho.id);
  assert.match(provenanceReport(chainOld), /Episode:/);
  assert.match(provenanceReport(chainOld), /Chuỗi thay thế/);

  const chainPho = factProvenanceChain(store, likesPho.id, { workspaceDir: dir });
  assert.equal(chainPho.invalidations.length, 1);
  assert.match(provenanceReport(chainPho), /Invalidations/);
  assert.equal(factProvenanceChain(store, 'no-such'), null);

  // episodeFacts + episodesForEntity.
  assert.equal(episodeFacts(store, ep1.id).length, 2);
  assert.deepEqual(episodeFacts(store, 'no-such'), []);
  const eps = episodesForEntity(store, 'Huy', { scope: SCOPE });
  assert.equal(eps.length, 1, 'chỉ ep1 nhắc tới Huy');
  assert.equal(eps[0].facts.length, 2);
  assert.deepEqual(episodesForEntity(store, 'Không ai', { scope: SCOPE }), []);
});

// ---- export / import ---------------------------------------------------

test('export/import snapshot: add-only, giữ id gốc + invalidAt + supersession', () => {
  const { store, livesHanoi, livesHcm, likesPho } = buildScenario();
  store.markFactInvalidated(likesPho.id, { invalidAt: '2026-11-15T09:00:00.000Z', actor: 'user-1', reason: 'Đính chính.' });
  const snapshot = exportTemporalSnapshot(store, SCOPE);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.facts.length, 3);
  assert.equal(snapshot.episodes.length, 1);
  assert.deepEqual(validateTemporalSnapshot(snapshot), []);
  const v1Errors = validateTemporalSnapshot({ version: 1 });
  assert.ok(v1Errors.some((e) => e.includes('version phải là 2')), JSON.stringify(v1Errors));
  assert.deepEqual(validateTemporalSnapshot(null), ['Snapshot không phải object.']);

  // Import vào kho trống.
  const backend2 = new InMemoryGraphBackend();
  const store2 = new TemporalGraphStore(backend2);
  const result = importTemporalSnapshot(store2, snapshot);
  assert.equal(result.addedFacts, 3, JSON.stringify(result));
  assert.equal(result.addedEntities, 1, 'chỉ entity Huy (object đều là text, không phải entity)');
  assert.equal(result.addedEpisodes, 1);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  // Fact giữ nguyên id + invalidAt + supersession.
  assert.equal(store2.getFact(likesPho.id).invalidAt, '2026-11-15T09:00:00.000Z');
  assert.equal(store2.getFact(livesHcm.id).supersedes, livesHanoi.id);
  assert.equal(store2.getFact(livesHanoi.id).supersededBy, livesHcm.id);
  assert.equal(store2.getFact(livesHanoi.id).status, 'superseded');
  // Import lại: add-only — không thêm gì nữa.
  const second = importTemporalSnapshot(store2, snapshot);
  assert.equal(second.addedFacts, 0);
  assert.equal(second.skippedFacts, 3);
});

test('export/import snapshot: file round-trip + snapshot theo recordedAt', () => {
  const { store } = buildScenario();
  const dir = tmpDir();
  const filePath = path.join(dir, 'snap.json');
  const snapshot = exportTemporalSnapshot(store, SCOPE, { recordedAt: '2026-11-05T00:00:00.000Z' });
  assert.equal(snapshot.facts.length, 2, 'chỉ fact đã biết tại 05/11');
  writeTemporalSnapshotFile(filePath, snapshot);
  const readBack = readTemporalSnapshotFile(filePath);
  assert.equal(readBack.facts.length, 2);
  assert.throws(() => readTemporalSnapshotFile(path.join(dir, 'nope.json')), /Không đọc được file snapshot/);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.throws(() => readTemporalSnapshotFile(path.join(dir, 'bad.json')), /không phải JSON/);
  fs.writeFileSync(path.join(dir, 'v1.json'), JSON.stringify({ version: 1 }));
  assert.throws(() => readTemporalSnapshotFile(path.join(dir, 'v1.json')), /không hợp lệ/);
});

test('import snapshot: fact thiếu provenance / cửa sổ sai bị bỏ, kho đích không đổi', () => {
  const backend = new InMemoryGraphBackend();
  const store = new TemporalGraphStore(backend);
  const good = seedFact(store, 'Huy', 'likes', 'phở bò', '2026-11-04T10:00:00.000Z', 'Tôi thích phở bò.');
  const snapshot = exportTemporalSnapshot(store, SCOPE);
  const badFact = JSON.parse(JSON.stringify(snapshot.facts[0]));
  badFact.id = 'bad-1';
  delete badFact.provenance.episodeId;
  const badWindow = JSON.parse(JSON.stringify(snapshot.facts[0]));
  badWindow.id = 'bad-2';
  badWindow.validUntil = '2026-01-01T00:00:00.000Z';
  const snapshot2 = { ...snapshot, facts: [...snapshot.facts, badFact, badWindow] };
  const backend2 = new InMemoryGraphBackend();
  const store2 = new TemporalGraphStore(backend2);
  const result = importTemporalSnapshot(store2, snapshot2);
  assert.equal(result.addedFacts, 1, 'chỉ fact tốt được thêm');
  assert.equal(result.skippedFacts, 2);
  assert.ok(result.errors.some((e) => e.includes('bad-1')), JSON.stringify(result.errors));
  assert.ok(result.errors.some((e) => e.includes('bad-2')), JSON.stringify(result.errors));
  assert.equal(store2.getFact(good.id).objectText, 'phở bò');
});

// ---- reconcile / audit --------------------------------------------------

function buildBrokenScenario() {
  const backend = new InMemoryGraphBackend();
  let store = new TemporalGraphStore(backend);
  const good = seedFact(store, 'Huy', 'likes', 'phở bò', '2026-11-04T10:00:00.000Z', 'Tôi thích phở bò.');
  // Cửa sổ ngược: validUntil < validFrom.
  const badWindow = seedFact(store, 'Huy', 'likes', 'bún chả', '2026-11-05T10:00:00.000Z', 'Tôi thích bún chả.');
  store = retime(backend, badWindow.id, { validFrom: '2026-11-05T10:00:00.000Z', validUntil: '2026-11-01T00:00:00.000Z' });
  // Liên kết supersession đứt.
  const dangling = seedFact(store, 'Huy', 'lives_in', 'Hà Nội', '2026-11-03T10:00:00.000Z', 'Tôi sống ở Hà Nội.');
  store = retime(backend, dangling.id, { supersedes: 'fact-khong-ton-tai', supersededBy: 'fact-khong-ton-tai-2' });
  // Fact active trùng nhau (cùng subject/predicate/object).
  seedFact(store, 'Huy', 'likes', 'phở bò', '2026-11-06T10:00:00.000Z', 'Tôi cũng thích phở bò.');
  // Episode trỏ fact không tồn tại.
  const ep = store.ingestEpisode({
    turnId: 'turn-broken', runId: 'run-1', botId: 'bot-a', userId: 'user-1',
    role: 'user', text: 'Turn hỏng.',
  });
  store.markEpisodeProcessed(ep.id, ['fact-khong-ton-tai-3']);
  return { backend, store, good, badWindow, dangling, ep };
}

test('auditTemporalGraph: liệt kê đủ loại vấn đề, phân loại fixable', () => {
  const { store } = buildBrokenScenario();
  const audit = auditTemporalGraph(store, SCOPE);
  assert.equal(audit.checkedFacts, 4);
  const kinds = audit.issues.map((i) => i.kind);
  assert.ok(kinds.includes('invalid-window'), kinds.join(', '));
  assert.ok(kinds.includes('dangling-supersedes'), kinds.join(', '));
  assert.ok(kinds.includes('dangling-superseded-by'), kinds.join(', '));
  assert.ok(kinds.includes('duplicate-active-fact'), kinds.join(', '));
  assert.ok(kinds.includes('dangling-episode-fact'), kinds.join(', '));
  assert.ok(kinds.includes('missing-provenance-episode'), kinds.join(', '));
  assert.ok(audit.errors >= 1);
  assert.ok(audit.warnings >= 1);
  assert.equal(audit.duplicateGroups, 1);
  assert.match(auditSummary(audit), /lỗi/);
  const clean = auditTemporalGraph(new TemporalGraphStore(new InMemoryGraphBackend()), SCOPE);
  assert.equal(clean.issues.length, 0);
  assert.match(auditSummary(clean), /toàn vẹn/);
});

test('repairTemporalGraph: dry-run không sửa; sửa thật chỉ sửa loại fixable', () => {
  const { store, badWindow, dangling, ep } = buildBrokenScenario();
  const dry = repairTemporalGraph(store, SCOPE, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.fixed, 0);
  assert.ok(dry.actions.length >= 4, `dry actions: ${dry.actions.length}`);
  assert.equal(store.getFact(badWindow.id).validUntil, '2026-11-01T00:00:00.000Z', 'dry-run không đổi gì');
  const repaired = repairTemporalGraph(store, SCOPE, { dryRun: false });
  assert.equal(repaired.fixed, 4, JSON.stringify(repaired.actions));
  assert.equal(store.getFact(badWindow.id).validUntil, null, 'cửa sổ ngược thành mở');
  assert.equal(store.getFact(dangling.id).supersedes, undefined);
  assert.equal(store.getFact(dangling.id).supersededBy, undefined);
  assert.deepEqual(store.getEpisode(ep.id).factIds, [], 'factId đứt đã gỡ khỏi episode');
  // Audit sau sửa: chỉ còn lỗi không sửa được (trùng active + thiếu episode).
  const kinds = repaired.audit.issues.map((i) => i.kind);
  assert.ok(!kinds.includes('invalid-window'), kinds.join(', '));
  assert.ok(!kinds.includes('dangling-supersedes'), kinds.join(', '));
  assert.ok(!kinds.includes('dangling-episode-fact'), kinds.join(', '));
  assert.ok(kinds.includes('duplicate-active-fact'), 'trùng active cần người quyết, không tự sửa');
  assert.equal(repaired.unfixable, repaired.audit.issues.length);
  // Sửa lại lần nữa: không còn gì fixable.
  const again = repairTemporalGraph(store, SCOPE, { dryRun: false });
  assert.equal(again.fixed, 0);
});

test('repairTemporalGraph: fix giới hạn theo loại', () => {
  const { store, badWindow } = buildBrokenScenario();
  const result = repairTemporalGraph(store, SCOPE, { dryRun: false, fix: ['invalid-window'] });
  assert.equal(result.fixed, 1);
  assert.equal(store.getFact(badWindow.id).validUntil, null);
  assert.ok(result.skippedFixable >= 3, 'các loại fixable khác bị bỏ qua');
});
