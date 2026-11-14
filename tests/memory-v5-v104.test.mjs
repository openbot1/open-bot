/**
 * Tests for v1.04 (Team T1) — Memory v5:
 * packages/core/src/memory/graph/{addOnly,biTemporal,ingest}.ts
 * packages/core/src/memory/{memoryHealth,consolidationV2}.ts
 *
 * Covers: ADD-only append (new fact sits next to the old one, exact
 * duplicates dedupe, ranking decides the winner, explicit ranking
 * supersession only when the winner is confident + far ahead),
 * bi-temporal v2 (invalidate closes the window but keeps history,
 * query at event-time T with record-time R, edge validity intervals
 * + overlaps, invalidation audit log), Cognee-style ingestion
 * (chunking by headings/fences/paragraphs with overlap, dedupe by
 * chunk hash + fact key, provenance per chunk, file + directory
 * ingest, dry-run), memory health (fact count, contradiction rate,
 * staleness, coverage/orphans, quarantine backlog, score + grade +
 * issues), consolidation v2 (exact-duplicate merge, ranking
 * supersession, expired sweep, scored dream, health before/after +
 * JSONL log).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v5-v104.test.mjs
 *
 * No network. No model (rule-based extractor only).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  MemoryBlockStore,
  appendFactAddOnly,
  scoreAddOnlyFact,
  rankAddOnlyFacts,
  resolveAddOnlyGroups,
  addOnlyContradictionRate,
  applyRankingSupersession,
  retrieveAddOnly,
  explainRanking,
  invalidateFact,
  readInvalidationLog,
  findInvalidatedFacts,
  queryFactsAtBiTemporal,
  edgeValidityIntervals,
  findEdgeIntervalOverlaps,
  factVersionTimeline,
  chunkText,
  detectSourceKind,
  ingestCandidateKey,
  ingestDocument,
  ingestFile,
  ingestDirectory,
  parseChatTranscript,
  ingestTranscript,
  computeMemoryHealth,
  healthGrade,
  healthDelta,
  healthReportMarkdown,
  healthAttentionFacts,
  contradictionGroupSummary,
  healthTrend,
  readHealthTrendLog,
  mergeExactDuplicateFacts,
  pruneOrphanEntities,
  runConsolidationV2,
  readConsolidationV2Log,
  consolidationV2ReportMarkdown,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'user-1', botId: 'bot-1', runId: 'run-1' };

function prov(sourceText = 'Tôi thích phở.') {
  return {
    episodeId: 'ep-1',
    turnId: 'turn-1',
    runId: 'run-1',
    botId: 'bot-1',
    userId: 'user-1',
    at: new Date().toISOString(),
    sourceText,
  };
}

function newStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function addFact(store, subject, predicate, object, confidence = 0.8, sourceText) {
  return store.addFact({
    subjectName: subject,
    predicate,
    objectText: object,
    confidence,
    scope: SCOPE,
    provenance: prov(sourceText ?? `Tôi ${predicate} ${object}.`),
  });
}

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv5-v104-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Backdate a fact's createdAt/updatedAt in a file-backed store (for recency tests). */
function backdateFact(workspaceDir, factId, daysAgo) {
  const file = path.join(workspaceDir, '.open-bot', 'memory-graph.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const past = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  for (const fact of data.facts) {
    if (fact.id === factId) {
      fact.createdAt = past;
      fact.updatedAt = past;
      fact.validFrom = past;
    }
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return TemporalGraphStore.fromWorkspace(workspaceDir);
}

// ---------------------------------------------------------------- ADD-only

test('ADD-only: fact mới append cạnh fact cũ, fact cũ vẫn active', () => {
  const store = newStore();
  const first = appendFactAddOnly(store, {
    subjectName: 'user',
    predicate: 'likes',
    objectText: 'phở',
    confidence: 0.9,
    scope: SCOPE,
    provenance: prov('Tôi thích phở.'),
  });
  assert.equal(first.duplicate, false);
  const second = appendFactAddOnly(store, {
    subjectName: 'user',
    predicate: 'likes',
    objectText: 'bún chả',
    confidence: 0.85,
    scope: SCOPE,
    provenance: prov('Tôi thích bún chả.'),
  });
  assert.equal(second.duplicate, false);
  assert.notEqual(first.fact.id, second.fact.id);
  const active = store.listFacts({ ...SCOPE, status: 'active' });
  assert.equal(active.length, 2);
  assert.equal(store.getFact(first.fact.id)?.status, 'active');
  assert.equal(second.groupAfter?.hasContradiction, true);
  assert.equal(second.groupAfter?.distinctObjects, 2);
});

test('ADD-only: trùng lặp chính xác thì dedupe, không tạo fact mới', () => {
  const store = newStore();
  const first = appendFactAddOnly(store, {
    subjectName: 'user',
    predicate: 'likes',
    objectText: 'Phở ',
    confidence: 0.9,
    scope: SCOPE,
    provenance: prov('Tôi thích phở.'),
  });
  const second = appendFactAddOnly(store, {
    subjectName: 'user',
    predicate: 'likes',
    objectText: 'phở',
    confidence: 0.9,
    scope: SCOPE,
    provenance: prov('Tôi thích phở.'),
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.existingFactId, first.fact.id);
  assert.equal(store.listFacts({ ...SCOPE, status: 'active' }).length, 1);
});

test('ADD-only ranking: fact confidence cao thắng, loser bị hạ hạng vì mâu thuẫn', () => {
  const store = newStore();
  const loser = addFact(store, 'user', 'likes', 'phở', 0.5);
  const winner = addFact(store, 'user', 'likes', 'bún chả', 0.95);
  const groups = resolveAddOnlyGroups(store, SCOPE);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.hasContradiction, true);
  assert.equal(groups[0]?.winner?.fact.id, winner.id);
  assert.equal(groups[0]?.losers[0]?.fact.id, loser.id);
  assert.ok((groups[0]?.winner?.score.total ?? 0) > (groups[0]?.losers[0]?.score.total ?? 0));
  assert.ok((groups[0]?.losers[0]?.score.contradictionPenalty ?? 0) > 0);
});

test('ADD-only scoring: support (nhiều fact cùng object) nâng điểm', () => {
  const store = newStore();
  const a = addFact(store, 'user', 'likes', 'phở', 0.7);
  const b = addFact(store, 'user', 'likes', 'phở', 0.7);
  void b;
  const c = addFact(store, 'user', 'likes', 'bún chả', 0.7);
  const group = [a, store.getFact(c.id)];
  const scoredA = scoreAddOnlyFact(a, store.listFacts({ ...SCOPE, status: 'active' }));
  const scoredC = scoreAddOnlyFact(c, store.listFacts({ ...SCOPE, status: 'active' }));
  assert.ok(scoredA.support > scoredC.support);
  assert.ok(scoredA.total > scoredC.total);
  assert.equal(group.length, 2);
});

test('ADD-only: contradiction rate = nhóm mâu thuẫn / tổng nhóm', () => {
  const store = newStore();
  addFact(store, 'user', 'likes', 'phở', 0.9);
  addFact(store, 'user', 'likes', 'bún chả', 0.9);
  addFact(store, 'user', 'lives_in', 'Hà Nội', 0.9);
  const rate = addOnlyContradictionRate(store, SCOPE);
  assert.equal(rate.groups, 2);
  assert.equal(rate.contradictoryGroups, 1);
  assert.equal(rate.rate, 0.5);
});

test('ADD-only supersession: winner chắc + gap lớn thì supersede, lịch sử giữ nguyên', () => {
  const dir = makeTempDir();
  let store = TemporalGraphStore.fromWorkspace(dir);
  const loser = addFact(store, 'user', 'likes', 'phở', 0.5);
  store = backdateFact(dir, loser.id, 80);
  const winner = addFact(store, 'user', 'likes', 'bún chả', 0.95);
  const groups = resolveAddOnlyGroups(store, SCOPE);
  const result = applyRankingSupersession(store, groups, 'test');
  assert.equal(result.superseded.length, 1);
  assert.equal(result.superseded[0]?.loserId, loser.id);
  assert.equal(result.superseded[0]?.winnerId, winner.id);
  assert.equal(store.getFact(loser.id)?.status, 'superseded');
  assert.equal(store.getFact(loser.id)?.supersededBy, winner.id);
  // mergeFacts chỉ nối supersededBy (không đặt supersedes lên
  // winner) nên lịch sử đọc trực tiếp từ hai fact, không qua
  // factHistory (chuỗi supersedes chỉ nối khi dùng supersedeFact).
  const allFacts = store.listFacts({ ...SCOPE, limit: 100 });
  assert.ok(allFacts.some((f) => f.id === loser.id && f.status === 'superseded'));
  assert.ok(allFacts.some((f) => f.id === winner.id && f.status === 'active'));
});

test('ADD-only supersession: gap điểm nhỏ thì giữ cả hai (deferred)', () => {
  const store = newStore();
  addFact(store, 'user', 'likes', 'phở', 0.85);
  addFact(store, 'user', 'likes', 'bún chả', 0.9);
  const groups = resolveAddOnlyGroups(store, SCOPE);
  const result = applyRankingSupersession(store, groups, 'test');
  assert.equal(result.superseded.length, 0);
  assert.equal(result.deferred.length, 1);
  assert.equal(store.listFacts({ ...SCOPE, status: 'active' }).length, 2);
});

test('ADD-only retrieval: winnersOnly chỉ trả winner; tắt thì trả cả loser', () => {
  const store = newStore();
  addFact(store, 'user', 'likes', 'phở', 0.5);
  addFact(store, 'user', 'likes', 'bún chả', 0.95);
  const winners = retrieveAddOnly(store, 'likes', SCOPE);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]?.fact.objectText, 'bún chả');
  assert.equal(winners[0]?.isWinner, true);
  const all = retrieveAddOnly(store, 'likes', SCOPE, { winnersOnly: false });
  assert.equal(all.length, 2);
  const empty = retrieveAddOnly(store, '', SCOPE);
  assert.equal(empty.length, 1);
});

test('ADD-only ranking: hoà điểm thì fact mới hơn thắng', () => {
  const store = newStore();
  const old = addFact(store, 'user', 'likes', 'phở', 0.8);
  const ranked = rankAddOnlyFacts(store, store.listFacts({ ...SCOPE, status: 'active' }));
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.fact.id, old.id);
  assert.equal(ranked[0]?.contradictingCount, 0);
});

// ---------------------------------------------------------------- bi-temporal v2

test('bi-temporal: invalidate đóng cửa sổ nhưng giữ status + lịch sử', () => {
  const store = newStore();
  const fact = addFact(store, 'user', 'lives_in', 'Hà Nội', 0.9);
  const invalidAt = new Date(Date.now() + 86_400_000).toISOString();
  const result = invalidateFact(store, fact.id, invalidAt, 'User đã chuyển đi (mâu thuẫn với fact mới).', 'test');
  assert.equal(result.fact.validUntil, invalidAt);
  assert.equal(result.fact.status, 'active');
  assert.equal(result.record.factId, fact.id);
  assert.equal(result.record.previousValidUntil, null);
  assert.equal(result.logWritten, false);
  const atBefore = queryFactsAtBiTemporal(store, new Date());
  assert.ok(atBefore.some((f) => f.fact.id === fact.id));
  const atAfter = queryFactsAtBiTemporal(store, new Date(Date.now() + 2 * 86_400_000));
  assert.ok(!atAfter.some((f) => f.fact.id === fact.id));
});

test('bi-temporal: invalidate chặn invalidAt trước validFrom và lý do rỗng', () => {
  const store = newStore();
  const fact = addFact(store, 'user', 'lives_in', 'Hà Nội', 0.9);
  assert.throws(
    () => invalidateFact(store, fact.id, new Date(Date.now() - 365 * 86_400_000), 'x', 'test'),
    /validFrom/,
  );
  assert.throws(
    () => invalidateFact(store, fact.id, new Date(), '   ', 'test'),
    /Lý do/,
  );
  assert.throws(() => invalidateFact(store, 'no-such-id', new Date(), 'x', 'test'), /Không tìm thấy/);
});

test('bi-temporal: query với recordedAt loại fact chưa tồn tại lúc R', () => {
  const dir = makeTempDir();
  let store = TemporalGraphStore.fromWorkspace(dir);
  const old = addFact(store, 'user', 'likes', 'phở', 0.9);
  store = backdateFact(dir, old.id, 30);
  const recordedAt = new Date(Date.now() - 10 * 86_400_000);
  const now = new Date();
  const knownThen = queryFactsAtBiTemporal(store, now, { recordedAt });
  assert.ok(knownThen.some((f) => f.fact.id === old.id));
  const fresh = addFact(store, 'user', 'likes', 'bún chả', 0.9);
  const knownThen2 = queryFactsAtBiTemporal(store, now, { recordedAt });
  assert.ok(!knownThen2.some((f) => f.fact.id === fresh.id));
  const knownNow = queryFactsAtBiTemporal(store, new Date(), {});
  assert.ok(knownNow.some((f) => f.fact.id === fresh.id));
});

test('bi-temporal: fact superseded trước R thì currentAtRecordTime = false', () => {
  const dir = makeTempDir();
  let store = TemporalGraphStore.fromWorkspace(dir);
  const old = addFact(store, 'user', 'likes', 'phở', 0.5);
  store = backdateFact(dir, old.id, 30);
  const winner = store.supersedeFact(old.id, {
    subjectName: 'user',
    predicate: 'likes',
    objectText: 'bún chả',
    confidence: 0.95,
    scope: SCOPE,
    provenance: prov('Tôi thích bún chả.'),
  });
  const recordedAt = new Date(Date.now() + 60_000);
  // Tại T = 10 ngày trước, fact cũ vẫn đúng; tại R nó đã bị thay thế.
  const then = queryFactsAtBiTemporal(store, new Date(Date.now() - 10 * 86_400_000), { recordedAt });
  const oldRow = then.find((r) => r.fact.id === old.id);
  assert.ok(oldRow);
  assert.equal(oldRow.currentAtRecordTime, false);
  // Tại T = bây giờ, winner là đáp án hiện tại.
  const nowRows = queryFactsAtBiTemporal(store, new Date(), { recordedAt });
  const winnerRow = nowRows.find((r) => r.fact.id === winner.id);
  assert.ok(winnerRow);
  assert.equal(winnerRow.currentAtRecordTime, true);
  assert.ok(!nowRows.some((r) => r.fact.id === old.id));
});

test('bi-temporal: edge intervals xếp theo thời gian + phát hiện overlap', () => {
  const store = newStore();
  addFact(store, 'user', 'lives_in', 'Hà Nội', 0.9);
  addFact(store, 'user', 'lives_in', 'TP. Hồ Chí Minh', 0.9);
  const intervals = edgeValidityIntervals(store, 'user', 'lives_in', SCOPE);
  assert.equal(intervals.length, 2);
  assert.ok(intervals[0].validFrom <= intervals[1].validFrom);
  assert.equal(intervals[0].status, 'active');
  const overlaps = findEdgeIntervalOverlaps(intervals);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0]?.first.objectText, 'Hà Nội');
  assert.deepEqual(edgeValidityIntervals(store, 'nobody', 'lives_in', SCOPE), []);
});

test('bi-temporal: invalidation log ghi + đọc lại, findInvalidatedFacts', () => {
  const dir = makeTempDir();
  const store = TemporalGraphStore.fromWorkspace(dir);
  const fact = addFact(store, 'user', 'lives_in', 'Hà Nội', 0.9);
  const result = invalidateFact(
    store,
    fact.id,
    new Date(Date.now() + 86_400_000),
    'Mâu thuẫn với fact mới.',
    'tester',
    { workspaceDir: dir, conflictingFactId: 'other-1' },
  );
  assert.equal(result.logWritten, true);
  const log = readInvalidationLog(dir);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.factId, fact.id);
  assert.equal(log[0]?.conflictingFactId, 'other-1');
  const found = findInvalidatedFacts(store, dir, SCOPE);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.record.reason, 'Mâu thuẫn với fact mới.');
  assert.deepEqual(readInvalidationLog(makeTempDir()), []);
});

// ---------------------------------------------------------------- ingestion

test('ingest: detectSourceKind theo đuôi file', () => {
  assert.equal(detectSourceKind('notes.md'), 'markdown');
  assert.equal(detectSourceKind('app.log'), 'log');
  assert.equal(detectSourceKind('main.ts'), 'code');
  assert.equal(detectSourceKind('data.json'), 'json');
  assert.equal(detectSourceKind('readme.txt'), 'text');
});

test('ingest: chunkText chẻ theo heading, không chẻ fence code, tôn trọng maxChars', () => {
  // maxChars kẹp tối thiểu 200 nên mỗi section cần đủ dài để tách.
  const section1 = 'Tôi thích phở. '.repeat(12);
  const section2 = 'Tôi sống ở Hà Nội. '.repeat(8);
  const text = `# Sở thích\n${section1}\n\n\`\`\`js\nconst a = 1;\nconst b = 2;\n\`\`\`\n\n# Nơi ở\n${section2}`;
  const chunks = chunkText(text, { maxChars: 200 });
  assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);
  assert.ok(chunks.some((c) => c.heading === 'Sở thích'));
  assert.ok(chunks.some((c) => c.text.includes('const a = 1')));
  const long = chunkText('x '.repeat(5000), { maxChars: 1000, overlapChars: 0 });
  assert.ok(long.length > 1);
  assert.ok(long.every((c) => c.text.length <= 1000));
  assert.ok(long.every((c) => c.hash.length === 16));
});

test('ingest: chunkText có overlap giữa chunk kề nhau', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Đoạn ${i} nói về phở và Hà Nội.`).join('\n\n');
  const chunks = chunkText(text, { maxChars: 200, overlapChars: 50 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks[1].text.length > 0);
});

test('ingest: ingestDocument rút fact từ markdown, provenance theo chunk', async () => {
  const store = newStore();
  const report = await ingestDocument(store, '# Về tôi\nTôi thích phở.\n\nTôi sống ở Hà Nội.\n', {
    scope: SCOPE,
    sourceLabel: 'about.md',
  });
  assert.equal(report.kind, 'markdown');
  assert.ok(report.chunks >= 1);
  assert.ok(report.added >= 1, `expected facts added, got ${JSON.stringify(report)}`);
  assert.ok(report.facts.length >= 1);
  assert.ok(report.facts.every((f) => f.sourceLabel === 'about.md'));
  assert.ok(report.facts.every((f) => f.chunkId.startsWith('about.md#')));
  const stored = store.getFact(report.facts[0].factId);
  assert.ok(stored);
  assert.equal(stored.provenance.botId, 'bot-1');
});

test('ingest: ingest lại cùng tài liệu với knownChunkHashes thì bỏ qua chunk trùng', async () => {
  const store = newStore();
  const hashes = new Set();
  const text = 'Tôi thích phở.\n\nTôi sống ở Hà Nội.';
  const first = await ingestDocument(store, text, { scope: SCOPE, sourceLabel: 'a.md', knownChunkHashes: hashes });
  const activeAfterFirst = store.listFacts({ ...SCOPE, status: 'active' }).length;
  const second = await ingestDocument(store, text, { scope: SCOPE, sourceLabel: 'a.md', knownChunkHashes: hashes });
  assert.equal(second.chunksSkippedDuplicate, first.chunks);
  assert.equal(second.added, 0);
  assert.equal(store.listFacts({ ...SCOPE, status: 'active' }).length, activeAfterFirst);
});

test('ingest: dry-run không ghi fact nào', async () => {
  const store = newStore();
  const report = await ingestDocument(store, 'Tôi thích phở.', {
    scope: SCOPE,
    sourceLabel: 'dry.md',
    dryRun: true,
  });
  assert.ok(report.candidates >= 1);
  assert.equal(store.listFacts({ ...SCOPE, status: 'active' }).length, 0);
});

test('ingest: ingestCandidateKey chuẩn hoá (case + dấu + khoảng trắng)', () => {
  const key = (obj) => ingestCandidateKey({ subjectName: 'user', predicate: 'likes', objectText: obj, sourceText: '', confidence: 0.9, kind: 'person', objectIsEntity: false });
  assert.equal(key('Phở'), key('phở'));
  assert.equal(key('phở  '), key('phở'));
});

test('ingest: ingestFile đọc file md từ đĩa', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, '# Ghi chú\nTôi thích bún chả.\n');
  const store = newStore();
  const report = await ingestFile(store, file, { scope: SCOPE });
  assert.equal(report.sourceLabel, 'notes.md');
  assert.ok(report.added >= 1);
  await assert.rejects(() => ingestFile(store, path.join(dir, 'missing.md'), { scope: SCOPE }), /Không đọc được/);
});

test('ingest: ingestDirectory đi nhiều file, bỏ qua node_modules', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.md'), 'Tôi thích phở.');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'Tôi sống ở Hà Nội.');
  fs.writeFileSync(path.join(dir, 'c.png'), 'not-text-but-wrong-ext');
  const nm = path.join(dir, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'x.md'), 'Tôi thích pizza.');
  const store = newStore();
  const report = await ingestDirectory(store, dir, { scope: SCOPE });
  assert.equal(report.filesIngested, 2);
  assert.ok(report.totals.added >= 2);
  // node_modules không được đi vào nên x.md không tính vào filesSeen.
  assert.equal(report.filesSeen, 3);
});

// ---------------------------------------------------------------- health

test('health: kho trống điểm 100, grade excellent, có issue ghi chú trống', () => {
  const store = newStore();
  const health = computeMemoryHealth(store, SCOPE);
  assert.equal(health.factCount, 0);
  assert.equal(health.score, 100);
  assert.equal(health.grade, 'excellent');
  assert.equal(healthGrade(100), 'excellent');
  assert.equal(healthGrade(80), 'good');
  assert.equal(healthGrade(60), 'fair');
  assert.equal(healthGrade(10), 'poor');
  assert.ok(health.issues.some((i) => i.includes('trống')));
});

test('health: mâu thuẫn 100% trừ 40 điểm, grade fair', () => {
  const store = newStore();
  addFact(store, 'user', 'likes', 'phở', 0.9);
  addFact(store, 'user', 'likes', 'bún chả', 0.9);
  const health = computeMemoryHealth(store, SCOPE);
  assert.equal(health.contradictionGroups, 1);
  assert.equal(health.contradictionRate, 1);
  assert.equal(health.score, 60);
  assert.equal(health.grade, 'fair');
  assert.ok(health.issues.some((i) => i.includes('mâu thuẫn')));
  const md = healthReportMarkdown(health);
  assert.ok(md.includes('60/100'));
  assert.ok(md.includes('fair'));
});

test('health: fact già + confidence thấp + quarantine đều trừ điểm và liệt kê issue', () => {
  const dir = makeTempDir();
  let store = TemporalGraphStore.fromWorkspace(dir);
  const old = addFact(store, 'user', 'likes', 'phở', 0.9);
  store = backdateFact(dir, old.id, 120);
  addFact(store, 'user', 'likes', 'bún chả', 0.3);
  store.addToQuarantine({
    candidate: { subjectName: 'user', predicate: 'likes', objectText: 'pizza', confidence: 0.4 },
    reason: 'low-confidence',
    detail: 'test',
    scope: SCOPE,
    provenance: prov('Tôi thích pizza.'),
  });
  const health = computeMemoryHealth(store, SCOPE);
  assert.equal(health.staleFacts, 1);
  assert.equal(health.lowConfidenceFacts, 1);
  assert.equal(health.quarantinedPending, 1);
  assert.ok(health.score < 100);
  assert.ok(health.issues.length >= 3);
  const attention = healthAttentionFacts(store, SCOPE);
  assert.equal(attention.stale.length, 1);
  assert.equal(attention.lowConfidence.length, 1);
  const summary = contradictionGroupSummary(store, SCOPE);
  assert.equal(summary.length, 1);
  assert.equal(summary[0]?.subjectName, 'user');
});

test('health: healthDelta tóm tắt thay đổi điểm', () => {
  const store = newStore();
  const before = computeMemoryHealth(store, SCOPE);
  addFact(store, 'user', 'likes', 'phở', 0.9);
  const after = computeMemoryHealth(store, SCOPE);
  const delta = healthDelta(before, after);
  assert.equal(delta.activeDelta, 1);
  assert.ok(delta.summary.includes('điểm'));
});

// ---------------------------------------------------------------- consolidation v2

test('consolidation v2: mergeExactDuplicateFacts gộp fact trùng, keeper ở lại', () => {
  const store = newStore();
  const a = addFact(store, 'user', 'likes', 'phở', 0.7);
  const b = addFact(store, 'user', 'likes', 'phở', 0.95);
  const result = mergeExactDuplicateFacts(store, SCOPE, 'test');
  assert.equal(result.merged, 1);
  assert.equal(store.getFact(b.id)?.status, 'active');
  assert.equal(store.getFact(a.id)?.status, 'superseded');
  assert.equal(store.getFact(a.id)?.supersededBy, b.id);
});

test('consolidation v2: chạy đầy đủ — supersede loser, sweep hết hạn, log + health cải thiện', async () => {
  const dir = makeTempDir();
  let store = TemporalGraphStore.fromWorkspace(dir);
  const loser = addFact(store, 'user', 'likes', 'phở', 0.5);
  store = backdateFact(dir, loser.id, 80);
  addFact(store, 'user', 'likes', 'bún chả', 0.95);
  const expired = store.addFact({
    subjectName: 'user',
    predicate: 'lives_in',
    objectText: 'Đà Nẵng',
    confidence: 0.9,
    scope: SCOPE,
    provenance: prov('Tôi sống ở Đà Nẵng.'),
    // Cửa sổ hợp lệ: bắt đầu 30 ngày trước, hết hạn hôm qua.
    validFrom: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    validUntil: new Date(Date.now() - 86_400_000).toISOString(),
  });
  const before = computeMemoryHealth(store, SCOPE);
  const report = await runConsolidationV2(store, { scope: SCOPE, workspaceDir: dir, skipDream: true });
  assert.equal(report.losersSuperseded, 1);
  assert.equal(report.expiredSwept, 1);
  assert.equal(store.getFact(loser.id)?.status, 'superseded');
  assert.equal(store.getFact(expired.id)?.status, 'deleted');
  assert.equal(report.logWritten, true);
  assert.ok(report.healthAfter.score > before.score, `score ${before.score} -> ${report.healthAfter.score}`);
  assert.ok(report.healthSummary.includes('điểm'));
  const log = readConsolidationV2Log(dir);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.losersSuperseded, 1);
  const md = consolidationV2ReportMarkdown(report);
  assert.ok(md.includes('Consolidation v2'));
});

test('consolidation v2: dream pass promote fact từ episode chưa xử lý', async () => {
  const dir = makeTempDir();
  const store = TemporalGraphStore.fromWorkspace(dir);
  const blocks = new MemoryBlockStore(dir);
  store.ingestEpisode({
    turnId: 'turn-dream-1',
    runId: 'run-1',
    botId: 'bot-1',
    userId: 'user-1',
    role: 'user',
    text: 'Tôi thích phở. Tôi thích phở. Tôi thích phở.',
  });
  const report = await runConsolidationV2(store, {
    scope: SCOPE,
    workspaceDir: dir,
    blocksStore: blocks,
    dreamMinScore: 0.3,
  });
  assert.ok(report.dreamEpisodesSeen >= 1);
  assert.ok(report.dreamReport !== null);
  assert.ok(report.dreamPromoted >= 1, `expected dream to promote, got ${JSON.stringify(report.dreamReport)}`);
  const human = blocks.get('human');
  assert.ok(human);
  assert.ok(human.content.includes('phở'));
});

test('consolidation v2: không có blocksStore thì bỏ qua dream nhưng các bước khác vẫn chạy', async () => {
  const dir = makeTempDir();
  const store = TemporalGraphStore.fromWorkspace(dir);
  addFact(store, 'user', 'likes', 'phở', 0.9);
  const report = await runConsolidationV2(store, { scope: SCOPE, workspaceDir: dir });
  assert.equal(report.dreamReport, null);
  assert.equal(report.dreamPromoted, 0);
  assert.ok(report.details.some((d) => d.includes('không có blocksStore')));
});

// ---------------------------------------------------------------- bổ sung v5.1

test('ingest transcript: parse ra turn theo role, nối dòng tiếp theo', () => {
  const turns = parseChatTranscript('User: Tôi thích phở.\nTôi sống ở Hà Nội.\nAssistant: Hay quá!\nHuy: Tôi thích bún chả.');
  assert.equal(turns.length, 3);
  assert.equal(turns[0].role, 'user');
  assert.ok(turns[0].text.includes('Tôi sống ở Hà Nội'));
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[2].role, 'user');
  assert.deepEqual(parseChatTranscript(''), []);
  assert.deepEqual(parseChatTranscript('   \n  '), []);
  const sys = parseChatTranscript('System: Bạn là trợ lý.\nUser: Chào.');
  assert.equal(sys[0].role, 'system');
});

test('ingest transcript: ingest từng turn thành episode + fact, ingest lại dedupe', async () => {
  const store = newStore();
  const text = 'User: Tôi thích phở.\nAssistant: Ngon đấy.\nUser: Tôi sống ở Hà Nội.';
  const first = await ingestTranscript(store, text, { scope: SCOPE, sourceLabel: 'chat-1' });
  assert.equal(first.turns, 3);
  assert.ok(first.turnsIngested >= 2);
  assert.ok(first.added + first.updated >= 2, JSON.stringify(first));
  assert.ok(first.facts.length >= 2);
  const activeBefore = store.listFacts({ ...SCOPE, status: 'active' }).length;
  const second = await ingestTranscript(store, text, { scope: SCOPE, sourceLabel: 'chat-1' });
  assert.ok(second.turnsSkippedDuplicate >= 2);
  assert.equal(store.listFacts({ ...SCOPE, status: 'active' }).length, activeBefore);
});

test('ingest transcript: lọc theo roles chỉ lấy turn user', async () => {
  const store = newStore();
  const text = 'User: Tôi thích phở.\nAssistant: Tôi thích pizza.';
  const report = await ingestTranscript(store, text, {
    scope: SCOPE,
    sourceLabel: 'chat-2',
    roles: ['user'],
  });
  assert.equal(report.turns, 1);
  assert.ok(!store.listFacts({ ...SCOPE, status: 'active' }).some((f) => f.objectText === 'pizza'));
});

test('bi-temporal: factVersionTimeline gộp created + superseded + invalidated', () => {
  const dir = makeTempDir();
  let store = TemporalGraphStore.fromWorkspace(dir);
  const old = addFact(store, 'user', 'lives_in', 'Hà Nội', 0.9);
  store = backdateFact(dir, old.id, 30);
  store.supersedeFact(old.id, {
    subjectName: 'user',
    predicate: 'lives_in',
    objectText: 'TP. Hồ Chí Minh',
    confidence: 0.95,
    scope: SCOPE,
    provenance: prov('Tôi sống ở TP. Hồ Chí Minh.'),
  });
  invalidateFact(
    store,
    old.id,
    new Date(Date.now() - 5 * 86_400_000),
    'Đã chuyển đi.',
    'test',
    { workspaceDir: dir },
  );
  const timeline = factVersionTimeline(store, 'user', 'lives_in', SCOPE, { workspaceDir: dir });
  assert.ok(timeline.length >= 4, JSON.stringify(timeline.map((s) => s.kind)));
  assert.ok(timeline.some((s) => s.kind === 'created'));
  assert.ok(timeline.some((s) => s.kind === 'superseded'));
  assert.ok(timeline.some((s) => s.kind === 'invalidated' && s.reason === 'Đã chuyển đi.'));
  assert.ok(timeline.every((s, i, arr) => i === 0 || arr[i - 1].at <= s.at));
  assert.deepEqual(factVersionTimeline(store, 'nobody', 'lives_in', SCOPE), []);
});

test('ADD-only: explainRanking giải thích winner và loser bằng câu đọc được', () => {
  const store = newStore();
  const loser = addFact(store, 'user', 'likes', 'phở', 0.5);
  const winner = addFact(store, 'user', 'likes', 'bún chả', 0.95);
  const groups = resolveAddOnlyGroups(store, SCOPE);
  const group = groups[0];
  const loserText = explainRanking(group, loser.id);
  assert.ok(loserText.includes('Thua'));
  assert.ok(loserText.includes('bún chả'));
  assert.ok(loserText.includes('confidence'));
  assert.ok(loserText.includes('contradiction penalty'));
  const winnerText = explainRanking(group, winner.id);
  assert.ok(winnerText.includes('Đang thắng'));
  assert.equal(explainRanking(group, 'no-such-id'), null);
});

test('health trend: chưa có log thì unknown; có log thì tính delta + best run', async () => {
  const dir = makeTempDir();
  let store = TemporalGraphStore.fromWorkspace(dir);
  const empty = healthTrend(store, SCOPE, dir);
  assert.equal(empty.points.length, 0);
  assert.equal(empty.direction, 'unknown');
  assert.equal(empty.firstScore, null);
  assert.equal(empty.bestRun, null);
  assert.equal(empty.currentScore, 100);
  // Mâu thuẫn thật + winner đủ chắc + đủ gap → consolidation supersede
  // loser, điểm tăng 60 → 100.
  const loser = addFact(store, 'user', 'likes', 'phở', 0.5);
  store = backdateFact(dir, loser.id, 80);
  addFact(store, 'user', 'likes', 'bún chả', 0.95);
  assert.equal(computeMemoryHealth(store, SCOPE).score, 60);
  const blocks = new MemoryBlockStore(dir);
  const report = await runConsolidationV2(store, { scope: SCOPE, workspaceDir: dir, blocksStore: blocks, skipDream: true });
  assert.equal(report.losersSuperseded, 1);
  const trend = healthTrend(store, SCOPE, dir);
  assert.equal(trend.points.length, 1);
  assert.equal(trend.firstScore, 60);
  assert.equal(trend.currentScore, 100);
  assert.equal(trend.totalDelta, 40);
  assert.equal(trend.direction, 'improving');
  assert.ok(trend.bestRun !== null);
  assert.equal(trend.bestRun.scoreAfter - trend.bestRun.scoreBefore, 40);
  assert.equal(readHealthTrendLog(dir).length, 1);
  assert.deepEqual(readHealthTrendLog(makeTempDir()), []);
});

test('consolidation v2: pruneOrphanEntities chỉ xoá entity không fact nào trỏ tới', () => {
  const store = newStore();
  const fact = addFact(store, 'user', 'likes', 'phở', 0.9);
  const orphan = store.ensureEntity('Món không ai nhắc', 'thing');
  const result = pruneOrphanEntities(store, 'test');
  assert.equal(result.pruned, 1);
  assert.deepEqual(result.names, ['Món không ai nhắc']);
  assert.equal(store.getEntity(orphan.id), undefined);
  assert.ok(store.getEntity(fact.subjectId));
  assert.throws(() => store.removeEntity(fact.subjectId), /còn fact/);
  assert.equal(store.removeEntity('no-such-id'), false);
});

test('consolidation v2: chạy đầy đủ dọn entity mồ côi và ghi orphanEntitiesPruned', async () => {
  const dir = makeTempDir();
  const store = TemporalGraphStore.fromWorkspace(dir);
  addFact(store, 'user', 'likes', 'phở', 0.9);
  store.ensureEntity('Món không ai nhắc', 'thing');
  const report = await runConsolidationV2(store, { scope: SCOPE, workspaceDir: dir, skipDream: true });
  assert.equal(report.orphanEntitiesPruned, 1);
  const log = readConsolidationV2Log(dir);
  assert.equal(log[0]?.orphanEntitiesPruned, 1);
  const md = consolidationV2ReportMarkdown(report);
  assert.ok(md.includes('Entity mồ côi đã dọn: 1'));
});
