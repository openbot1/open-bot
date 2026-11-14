/**
 * Tests for v1.05 (Team T1) — memory v6:
 * packages/core/src/memory/v3/{types,temporal,store,versioning,
 * scopes,tfidf,fused,blocks,sleep,migration}.ts.
 *
 * Covers: add-only append + exact dedupe, version chains (supersede /
 * retire / quarantine / restore via events only), temporal buckets +
 * recency decay, multi-scope resolve (run > agent > user > app,
 * configurable priority), TF-IDF + BM25 + entity match, fused
 * retrieval with score breakdown (TF-IDF fallback + mock embedder),
 * shared blocks (ACL, versions, sync events), sleep-time compute
 * (dedupe / summarize / quarantine / budgets), migration from
 * long-term + graph v5 (idempotent).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v6-v105.test.mjs
 *
 * No network. No model (semantic source is TF-IDF unless a mock
 * embedder is injected).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LongTermMemory } from '../packages/core/dist/memory/longterm.js';
import {
  V6RecordStore,
  SharedBlockStore,
  V6StoreError,
  ageInDays,
  bucketForAgeDays,
  recencyDecay,
  classifyTemporal,
  groupByBucket,
  deriveEffectiveStatus,
  supersedeRecord,
  retireRecord,
  quarantineRecord,
  restoreRecord,
  recordHistory,
  validateVersionChain,
  scopeLevelOf,
  scopeVisible,
  resolveScopedKey,
  setScopedMemory,
  getScopedMemory,
  effectiveScopedMemories,
  runScope,
  agentScope,
  userScope,
  tokenizeV6,
  TfIdfIndex,
  jaccardSimilarity,
  V6Bm25Index,
  entityMatchScore,
  normalizeFusedWeights,
  fusedRetrieve,
  explainFusedHit,
  SleepV6Scheduler,
  runConsolidation,
  readSleepV6Log,
  migrateLongTermMemory,
  migrateGraphFacts,
  migrationReportMarkdown,
  normalizeV6Text,
  DEFAULT_V6_FUSED_WEIGHTS,
} from '../packages/core/dist/memory/v3/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv6-v105-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const USER = 'user-1';
const BOT = 'bot-main';
const BOT2 = 'bot-other';
const APP = 'open-bot';

function userMemory(text, extra = {}) {
  return {
    text,
    scope: { userId: USER, agentId: '', runId: '', appId: APP },
    source: { type: 'tool', ref: 'test' },
    ...extra,
  };
}

/** Ghi đè createdAt của một bản ghi trong file store (để test bucket/sleep). */
function backdateRecord(dir, recordId, iso) {
  const filePath = path.join(dir, '.open-bot', 'memory-v6.json');
  const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const record = file.records.find((r) => r.id === recordId);
  assert.ok(record, `record ${recordId} must exist in file`);
  record.createdAt = iso;
  record.updatedAt = iso;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2));
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------- store ---
test('v6 store: append trả về version 1 active, file được tạo', () => {
  const dir = makeTempDir();
  const store = V6RecordStore.fromWorkspace(dir);
  const view = store.append(userMemory('User thích phở bò.'));
  assert.equal(view.version, 1);
  assert.equal(view.status, 'active');
  assert.equal(store.count(), 1);
  assert.ok(fs.existsSync(path.join(dir, '.open-bot', 'memory-v6.json')));
  assert.equal(store.getById(view.id)?.text, 'User thích phở bò.');
});

test('v6 store: text rỗng / quá dài thì throw lỗi tiếng Việt', () => {
  const store = V6RecordStore.inMemory();
  assert.throws(() => store.append(userMemory('   ')), /rỗng/);
  assert.throws(() => store.append(userMemory('x'.repeat(8001))), /quá dài/);
  assert.equal(store.count(), 0);
});

test('v6 store: exact dedupe — ghi trùng trả về bản cũ, không tăng count', () => {
  const store = V6RecordStore.inMemory();
  const first = store.append(userMemory('User thích phở bò.'));
  const second = store.append(userMemory('  user THÍCH phở bò. '));
  assert.equal(second.id, first.id);
  assert.equal(store.count(), 1);
  // Scope khác thì không dedupe.
  const other = store.append({
    text: 'User thích phở bò.',
    scope: { userId: USER, agentId: BOT, runId: '', appId: APP },
    source: { type: 'tool', ref: 'test' },
  });
  assert.notEqual(other.id, first.id);
  assert.equal(store.count(), 2);
});

test('v6 store: append với supersedes tạo version 2, bản cũ superseded', () => {
  const store = V6RecordStore.inMemory();
  const v1 = store.append(userMemory('User sống ở Hà Nội.', { key: 'home_city' }));
  const v2 = store.append(userMemory('User sống ở Đà Nẵng.', { key: 'home_city', supersedes: v1.id }));
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedes, v1.id);
  assert.equal(store.getById(v1.id)?.status, 'superseded');
  assert.equal(store.getById(v1.id)?.supersededBy, v2.id);
  assert.equal(store.getById(v2.id)?.status, 'active');
  assert.equal(store.listActive().length, 1);
});

test('v6 store: supersedes id không tồn tại thì throw', () => {
  const store = V6RecordStore.inMemory();
  assert.throws(
    () => store.append(userMemory('x', { supersedes: 'no-such-id' })),
    /Không tìm thấy bản ghi/,
  );
});

test('v6 store: file-backed reload giữ nguyên records + events', () => {
  const dir = makeTempDir();
  const a = V6RecordStore.fromWorkspace(dir);
  const v1 = a.append(userMemory('User thích trà đá.'));
  retireRecord(a, v1.id, 'test', 'Không thích nữa.');
  const b = V6RecordStore.fromWorkspace(dir);
  assert.equal(b.count(), 1);
  assert.equal(b.getById(v1.id)?.status, 'retired');
  assert.equal(b.eventCount(), 1);
  assert.equal(b.stats().retiredRecords, 1);
});

// ------------------------------------------------------------- versioning ---
test('v6 versioning: retire cần lý do, restore về active, lịch sử còn nguyên', () => {
  const store = V6RecordStore.inMemory();
  const view = store.append(userMemory('User ghét ớt.'));
  assert.throws(() => retireRecord(store, view.id, 'test', '  '), /lý do/);
  retireRecord(store, view.id, 'user', 'User đổi ý.');
  assert.equal(store.getById(view.id)?.status, 'retired');
  assert.equal(store.listAll().length, 1, 'retire không xoá bản ghi');
  restoreRecord(store, view.id, 'user', 'Nhầm, vẫn ghét ớt.');
  assert.equal(store.getById(view.id)?.status, 'active');
  assert.equal(store.listEvents().length, 2);
});

test('v6 versioning: quarantine + supersede tường minh + recordHistory', () => {
  const store = V6RecordStore.inMemory();
  const v1 = store.append(userMemory('User sống ở Hà Nội.', { key: 'home_city' }));
  const v2 = store.append(userMemory('User sống ở Đà Nẵng.', { key: 'home_city' }));
  quarantineRecord(store, v1.id, 'sleep:v6', 'Mâu thuẫn key home_city.');
  assert.equal(store.getById(v1.id)?.status, 'quarantined');
  supersedeRecord(store, v1.id, v2.id, 'user', 'Đà Nẵng mới đúng.');
  assert.equal(store.getById(v1.id)?.status, 'superseded');
  assert.equal(store.getById(v1.id)?.supersededBy, v2.id);
  const history = recordHistory(store, v2.id);
  assert.equal(history.length, 1, 'v1/v2 không nối chuỗi supersedes nên history chỉ có v2');
  const chained = store.append(
    userMemory('User sống ở Huế.', { key: 'home_city', supersedes: v2.id }),
  );
  const chain = recordHistory(store, chained.id);
  assert.deepEqual(
    chain.map((l) => l.record.version),
    [1, 2],
    'chuỗi supersedes nối v2 -> v3 (v1 không nối vì ghi riêng)',
  );
  assert.deepEqual(validateVersionChain(store), []);
});

test('v6 versioning: deriveEffectiveStatus — event gần nhất thắng', () => {
  const record = {
    id: 'r1', version: 1, kind: 'fact', text: 'x', entities: [], tags: [],
    confidence: 0.8, scope: { userId: '', agentId: '', runId: '', appId: '' },
    source: { type: 'tool', ref: 't' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const events = [
    { seq: 1, type: 'retire', targetId: 'r1', reason: 'a', actor: 'u', at: new Date().toISOString() },
    { seq: 2, type: 'restore', targetId: 'r1', reason: 'b', actor: 'u', at: new Date().toISOString() },
  ];
  assert.equal(deriveEffectiveStatus(record, events).status, 'active');
  const events2 = [...events, { seq: 3, type: 'quarantine', targetId: 'r1', reason: 'c', actor: 'u', at: new Date().toISOString() }];
  assert.equal(deriveEffectiveStatus(record, events2).status, 'quarantined');
});

test('v6 store: stats đếm đúng theo kind/bucket/scope/status', () => {
  const dir = makeTempDir();
  const store = V6RecordStore.fromWorkspace(dir);
  const a = store.append(userMemory('A thích phở.', { kind: 'fact' }));
  store.append(userMemory('B thích bún.', { kind: 'preference', entities: ['bún'] }));
  backdateRecord(dir, a.id, daysAgo(40));
  const fresh = V6RecordStore.fromWorkspace(dir);
  const stats = fresh.stats();
  assert.equal(stats.totalRecords, 2);
  assert.equal(stats.activeRecords, 2);
  assert.equal(stats.byKind.fact, 1);
  assert.equal(stats.byKind.preference, 1);
  assert.equal(stats.byBucket.older, 1);
  assert.equal(stats.byBucket.today, 1);
  assert.equal(stats.byScopeLevel.user, 2);
  assert.equal(stats.totalEvents, 0);
});

// -------------------------------------------------------------- temporal ---
test('v6 temporal: bucket theo tuổi + decay hàm mũ', () => {
  assert.equal(bucketForAgeDays(0.2), 'today');
  assert.equal(bucketForAgeDays(3), 'this_week');
  assert.equal(bucketForAgeDays(15), 'this_month');
  assert.equal(bucketForAgeDays(60), 'older');
  assert.equal(bucketForAgeDays(Number.POSITIVE_INFINITY), 'older');
  assert.equal(recencyDecay(0), 1);
  assert.equal(recencyDecay(30, 30), 0.5);
  assert.ok(Math.abs(recencyDecay(60, 30) - 0.25) < 1e-9);
  assert.equal(recencyDecay(100, 0), 1, 'halfLife <= 0 thì không decay');
  assert.equal(recencyDecay(Number.POSITIVE_INFINITY), 0);
});

test('v6 temporal: classify + groupByBucket', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const rec = { createdAt: '2026-11-14T10:00:00Z' };
  const cls = classifyTemporal(rec, now, 30);
  assert.equal(cls.bucket, 'today');
  assert.ok(cls.ageDays > 0 && cls.ageDays < 1);
  assert.ok(cls.recencyDecay > 0.99);
  const grouped = groupByBucket(
    [
      { createdAt: '2026-11-14T10:00:00Z' },
      { createdAt: '2026-11-01T10:00:00Z' },
      { createdAt: '2026-09-01T10:00:00Z' },
    ],
    now,
  );
  assert.equal(grouped.today.length, 1);
  assert.equal(grouped.this_month.length, 1);
  assert.equal(grouped.older.length, 1);
  assert.equal(ageInDays('not-a-date', now), Number.POSITIVE_INFINITY);
});

// ---------------------------------------------------------------- scopes ---
test('v6 scopes: scopeLevelOf + scopeVisible', () => {
  assert.equal(scopeLevelOf(runScope(USER, BOT, 'run-1')), 'run');
  assert.equal(scopeLevelOf(agentScope(USER, BOT)), 'agent');
  assert.equal(scopeLevelOf(userScope(USER)), 'user');
  assert.equal(scopeLevelOf({ userId: '', agentId: '', runId: '', appId: APP }), 'app');
  assert.equal(scopeVisible(runScope(USER, BOT, 'run-1'), { runId: 'run-1' }), true);
  assert.equal(scopeVisible(runScope(USER, BOT, 'run-1'), { runId: 'run-2' }), false);
  assert.equal(scopeVisible(runScope(USER, BOT, 'run-1'), {}), false);
  assert.equal(scopeVisible(agentScope(USER, BOT), { agentId: BOT }), true);
  assert.equal(scopeVisible(agentScope(USER, BOT), { agentId: BOT2 }), false);
  assert.equal(scopeVisible(userScope(USER), { userId: USER }), true);
  assert.equal(scopeVisible({ userId: '', agentId: '', runId: '', appId: APP }, { appId: APP }), true);
  assert.equal(scopeVisible({ userId: '', agentId: '', runId: '', appId: '' }, {}), true);
});

test('v6 scopes: resolve key — mức hẹp thắng, custom priority đổi người thắng', () => {
  const store = V6RecordStore.inMemory();
  setScopedMemory(store, { userId: USER, appId: APP }, { kind: 'fact', key: 'drink', text: 'User thích trà.', source: { type: 'tool', ref: 't' } });
  setScopedMemory(store, { userId: USER, agentId: BOT, appId: APP }, { kind: 'fact', key: 'drink', text: 'Bot này: user thích cà phê.', source: { type: 'tool', ref: 't' } });
  const query = { userId: USER, agentId: BOT, appId: APP };
  const resolved = resolveScopedKey(store, query, 'drink');
  assert.equal(resolved.winner?.text, 'Bot này: user thích cà phê.');
  assert.equal(resolved.winnerLevel, 'agent');
  assert.equal(resolved.candidates.length, 2);
  const flipped = resolveScopedKey(store, query, 'drink', ['user', 'agent', 'run', 'app']);
  assert.equal(flipped.winner?.text, 'User thích trà.');
  assert.equal(flipped.winnerLevel, 'user');
  assert.equal(getScopedMemory(store, query, 'missing'), undefined);
});

test('v6 scopes: get/set + effectiveScopedMemories gom theo key', () => {
  const store = V6RecordStore.inMemory();
  setScopedMemory(store, { userId: USER, appId: APP }, { kind: 'fact', key: 'city', text: 'User ở Hà Nội.', source: { type: 'tool', ref: 't' } });
  setScopedMemory(store, { userId: USER, agentId: BOT, appId: APP }, { kind: 'fact', key: 'city', text: 'User ở Đà Nẵng.', source: { type: 'tool', ref: 't' } });
  setScopedMemory(store, { userId: USER, appId: APP }, { kind: 'fact', key: 'food', text: 'User thích phở.', source: { type: 'tool', ref: 't' } });
  const effective = effectiveScopedMemories(store, { userId: USER, agentId: BOT, appId: APP });
  assert.equal(effective.length, 2, 'mỗi key chỉ giữ bản thắng');
  assert.equal(effective.find((r) => r.key === 'city')?.text, 'User ở Đà Nẵng.');
});

// ------------------------------------------------------------ tfidf/bm25 ---
test('v6 tfidf: tokenize bỏ stopword + TfIdfIndex xếp hạng đúng', () => {
  assert.deepEqual(tokenizeV6('Tôi thích ăn phở bò và uống trà đá'), ['thích', 'ăn', 'phở', 'bò', 'uống', 'trà', 'đá']);
  const index = new TfIdfIndex([
    'User thích phở bò Hà Nội',
    'User thích bóng đá cuối tuần',
    'Thời tiết hôm nay mưa to',
  ]);
  const ranked = index.rank('phở bò');
  assert.equal(ranked[0].doc, 0);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.equal(index.similarity('xyzzy', 0), 0);
  assert.equal(index.size, 3);
});

test('v6 tfidf: jaccardSimilarity', () => {
  assert.equal(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccardSimilarity(new Set(['a']), new Set(['b'])), 0);
  assert.equal(jaccardSimilarity(new Set(), new Set()), 1);
});

test('v6 bm25: khớp từ khoá cho điểm > 0, không khớp = 0', () => {
  const index = new V6Bm25Index([
    'User thích phở bò Hà Nội',
    'User thích bóng đá cuối tuần',
  ]);
  assert.ok(index.score('phở', 0) > 0);
  assert.equal(index.score('phở', 1), 0);
  assert.equal(index.score('', 0), 0);
  assert.equal(index.size, 2);
});

test('v6 entity: entityMatchScore khớp chuỗi con + token', () => {
  assert.equal(entityMatchScore('User sống ở Hà Nội từ 2020', ['hà nội']), 1);
  assert.equal(entityMatchScore('User sống ở Hà Nội', ['hà nội', 'đà nẵng']), 0.5);
  assert.equal(entityMatchScore('không liên quan', ['hà nội']), 0);
  assert.equal(entityMatchScore('query', []), 0);
});

test('v6 fused: normalizeFusedWeights chuẩn hoá về tổng 1', () => {
  const w = normalizeFusedWeights({ semantic: 2, bm25: 1, entity: 1 });
  assert.ok(Math.abs(w.semantic + w.bm25 + w.entity - 1) < 1e-9);
  assert.ok(Math.abs(w.semantic - 0.5) < 1e-9);
  assert.deepEqual(normalizeFusedWeights({ semantic: 0, bm25: 0, entity: 0 }), DEFAULT_V6_FUSED_WEIGHTS);
});

// ----------------------------------------------------------------- fused ---
test('v6 fused: TF-IDF fallback, breakdown khớp công thức, sắp theo điểm cuối', async () => {
  const store = V6RecordStore.inMemory();
  store.append(userMemory('User thích phở bò Hà Nội.', { entities: ['phở', 'hà nội'] }));
  store.append(userMemory('User thích bóng đá cuối tuần.', { entities: ['bóng đá'] }));
  store.append(userMemory('Thời tiết hôm nay mưa to.', { entities: ['mưa'] }));
  const hits = await fusedRetrieve(store, 'phở bò Hà Nội', {
    scope: { userId: USER, appId: APP },
  });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].record.text, 'User thích phở bò Hà Nội.');
  assert.equal(hits[0].breakdown.semanticSource, 'tfidf');
  assert.equal(hits[0].scopeLevel, 'user');
  assert.equal(hits[0].temporal.bucket, 'today');
  const b = hits[0].breakdown;
  const fused = 0.45 * b.semantic + 0.35 * b.bm25 + 0.2 * b.entity;
  assert.ok(Math.abs(b.final - fused * b.scopeBoost * b.recencyDecay) < 1e-9);
  assert.ok(explainFusedHit(hits[0]).includes('final'));
});

test('v6 fused: mock embedder -> semanticSource embedding; scope filter chặn run khác', async () => {
  const store = V6RecordStore.inMemory();
  store.append({
    text: 'Bí mật của run một.',
    scope: runScope(USER, BOT, 'run-1', APP),
    source: { type: 'tool', ref: 't' },
  });
  store.append({
    text: 'User thích phở.',
    scope: userScope(USER, APP),
    source: { type: 'tool', ref: 't' },
  });
  const mockEmbedder = {
    async embed(text) {
      return text.includes('phở') ? [1, 0] : [0, 1];
    },
    async isAvailable() {
      return true;
    },
  };
  const hits = await fusedRetrieve(store, 'phở', {
    scope: { userId: USER, agentId: BOT, runId: 'run-2', appId: APP },
    embedder: mockEmbedder,
  });
  assert.equal(hits.length, 1, 'run-1 record must not leak into run-2 query');
  assert.equal(hits[0].record.text, 'User thích phở.');
  assert.equal(hits[0].breakdown.semanticSource, 'embedding');
  assert.equal(await fusedRetrieve(store, '   ', { scope: {} }).then((h) => h.length), 0);
});

test('v6 fused: embedder lỗi thì fail-open về TF-IDF (không throw)', async () => {
  const store = V6RecordStore.inMemory();
  store.append(userMemory('User thích phở bò.'));
  const broken = {
    async embed() {
      throw new Error('Ollama down');
    },
    async isAvailable() {
      return true;
    },
  };
  const hits = await fusedRetrieve(store, 'phở', { scope: { userId: USER }, embedder: broken });
  assert.equal(hits.length, 1, 'TF-IDF fallback vẫn tìm thấy khi embedding lỗi');
  assert.equal(hits[0].breakdown.semanticSource, 'tfidf');
  assert.ok(hits[0].breakdown.semantic > 0, 'TF-IDF cho điểm semantic > 0');
  await assert.rejects(
    fusedRetrieve(store, 'phở', { scope: { userId: USER }, embedder: broken, skipSemanticOnError: false }),
    /Nguồn semantic lỗi/,
  );
});

// ---------------------------------------------------------------- blocks ---
test('v6 blocks: create/update/share/unshare + ACL chặn ghi', () => {
  const blocks = SharedBlockStore.inMemory();
  const block = blocks.createBlock(BOT, 'team-preferences', 'Team thích họp sáng thứ 2.');
  assert.equal(block.version, 1);
  assert.equal(block.history.length, 1);
  assert.throws(() => blocks.createBlock(BOT, 'team-preferences', 'khác'), /Đã có block/);
  assert.throws(() => blocks.createBlock(BOT, '  ', 'x'), /rỗng/);
  const updated = blocks.updateBlock(BOT, block.id, 'Team thích họp sáng thứ 3.', 'Đổi lịch.');
  assert.equal(updated.version, 2);
  assert.equal(updated.history.length, 2);
  assert.equal(updated.history[0].content, 'Team thích họp sáng thứ 2.');
  assert.throws(() => blocks.updateBlock(BOT2, block.id, 'hack'), /không có quyền ghi/);
  assert.throws(() => blocks.shareBlock(BOT2, block.id, BOT, 'read'), /Chỉ owner/);
  blocks.shareBlock(BOT, block.id, BOT2, 'read');
  assert.equal(blocks.permissionFor(blocks.getBlock(block.id), BOT2), 'read');
  assert.throws(() => blocks.updateBlock(BOT2, block.id, 'hack'), /không có quyền ghi/);
  blocks.shareBlock(BOT, block.id, BOT2, 'write');
  blocks.updateBlock(BOT2, block.id, 'Bot2 sửa được rồi.');
  assert.equal(blocks.getBlock(block.id).version, 3);
  blocks.unshareBlock(BOT, block.id, BOT2);
  assert.equal(blocks.permissionFor(blocks.getBlock(block.id), BOT2), undefined);
  assert.equal(blocks.listBlocksFor(BOT2).length, 0);
  assert.equal(blocks.listBlocksFor(BOT).length, 1);
});

test('v6 blocks: subscribe nhận event, unsubscribe dừng; event log persist', () => {
  const dir = makeTempDir();
  const blocks = SharedBlockStore.fromWorkspace(dir);
  const seen = [];
  const unsubscribe = blocks.subscribe((event) => seen.push(event));
  const block = blocks.createBlock(BOT, 'shared-notes', 'Ghi chú chung.');
  blocks.shareBlock(BOT, block.id, BOT2, 'read');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].type, 'created');
  assert.equal(seen[1].type, 'shared');
  assert.equal(seen[1].targetBotId, BOT2);
  unsubscribe();
  blocks.updateBlock(BOT, block.id, 'Mới.');
  assert.equal(seen.length, 2, 'unsubscribe rồi thì không nhận nữa');
  const reloaded = SharedBlockStore.fromWorkspace(dir);
  assert.equal(reloaded.getBlock(block.id).version, 2);
  const log = reloaded.readEventLog();
  assert.equal(log.length, 3);
  assert.equal(log[2].type, 'updated');
  assert.equal(reloaded.subscriberCount, 0);
});

test('v6 blocks: delete chỉ owner, block khác vẫn còn', () => {
  const blocks = SharedBlockStore.inMemory();
  const a = blocks.createBlock(BOT, 'a', 'A');
  const b = blocks.createBlock(BOT, 'b', 'B');
  assert.throws(() => blocks.deleteBlock(BOT2, a.id), /Chỉ owner/);
  assert.equal(blocks.deleteBlock(BOT, a.id), true);
  assert.equal(blocks.getBlock(a.id), undefined);
  assert.equal(blocks.getBlock(b.id)?.name, 'b');
});

// ------------------------------------------------------------------ sleep ---
test('v6 sleep: exact + near-dup dedupe, giữ bản confidence cao', () => {
  const dir = makeTempDir();
  const store = V6RecordStore.fromWorkspace(dir);
  const first = store.append(userMemory('User thích phở bò.'));
  // append() đã dedupe lúc ghi, nên bản trùng chính xác phải được tạo
  // bằng cách sửa file trực tiếp (mô phỏng kho cũ / migrate lỗi).
  const filePath = path.join(dir, '.open-bot', 'memory-v6.json');
  const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const clone = { ...file.records[0], id: 'dup-exact-1' };
  file.records.push(clone);
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2));
  const fresh = V6RecordStore.fromWorkspace(dir);
  assert.equal(fresh.count(), 2);
  const low = fresh.append(userMemory('User rất thích ăn phở bò Hà Nội ngon.', { confidence: 0.5 }));
  const high = fresh.append(userMemory('User rất thích ăn phở bò Hà Nội rất ngon.', { confidence: 0.9 }));
  const report = runConsolidation(fresh, { config: { minClusterSize: 99 } });
  assert.equal(report.dedupedExact, 1);
  assert.equal(report.dedupedNear, 1);
  assert.equal(fresh.listActive().length, 2);
  assert.equal(fresh.getById(high.id)?.status, 'active');
  assert.equal(fresh.getById(low.id)?.status, 'retired');
  assert.equal(report.stoppedByBudget, false);
  void first;
});

test('v6 sleep: tóm tắt cụm cũ thành summary, bản gốc superseded', () => {
  const dir = makeTempDir();
  const store = V6RecordStore.fromWorkspace(dir);
  const ids = [];
  for (const dish of ['phở bò', 'phở gà', 'phở tái']) {
    const v = store.append(userMemory(`User thích ${dish} Hà Nội.`, { entities: ['phở'] }));
    ids.push(v.id);
  }
  // Backdate TẤT CẢ sau khi append xong (append save lại toàn bộ file
  // từ bộ nhớ nên backdate giữa chừng sẽ bị ghi đè).
  for (const id of ids) backdateRecord(dir, id, daysAgo(40));
  const fresh = V6RecordStore.fromWorkspace(dir);
  const report = runConsolidation(fresh, {
    config: { summarizeOlderThanDays: 30, minClusterSize: 3 },
  });
  assert.equal(report.summarizedClusters, 1);
  assert.equal(report.summaryRecords, 1);
  assert.equal(report.superseded, 3);
  const summaries = fresh.listActive().filter((r) => r.kind === 'summary');
  assert.equal(summaries.length, 1);
  assert.match(summaries[0].text, /Tóm tắt 3 bản ghi cũ/);
  for (const id of ids) assert.equal(fresh.getById(id)?.status, 'superseded');
});

test('v6 sleep: quarantine mâu thuẫn cùng key, giữ bản mạnh nhất', () => {
  const store = V6RecordStore.inMemory();
  const weak = store.append(userMemory('User sống ở Hà Nội.', { key: 'home_city', confidence: 0.6 }));
  const strong = store.append(userMemory('User sống ở Đà Nẵng.', { key: 'home_city', confidence: 0.95 }));
  const report = runConsolidation(store, { config: { minClusterSize: 99 } });
  assert.equal(report.quarantined, 1);
  assert.equal(store.getById(weak.id)?.status, 'quarantined');
  assert.equal(store.getById(strong.id)?.status, 'active');
});

test('v6 sleep: maxRecordsPerRun giới hạn examined; scheduler bật/tắt + log', async () => {
  const dir = makeTempDir();
  const store = V6RecordStore.fromWorkspace(dir);
  for (let i = 0; i < 5; i += 1) {
    store.append(userMemory(`Memory số ${i} khác nhau hoàn toàn ${'x'.repeat(i)}.`));
  }
  const report = runConsolidation(store, { config: { maxRecordsPerRun: 2, minClusterSize: 99 } });
  assert.equal(report.examined, 2);

  const scheduler = new SleepV6Scheduler({ store, workspaceDir: dir, config: { enabled: false } });
  assert.equal(scheduler.enabled, false);
  assert.equal(await scheduler.tick(), null, 'tắt thì tick không chạy');
  scheduler.setEnabled(true);
  scheduler.markActivity();
  assert.equal(await scheduler.tick(), null, 'vừa có hoạt động thì chưa rảnh');
  const ran = await scheduler.runNow();
  assert.ok(ran);
  assert.equal(scheduler.totalRuns, 1);
  assert.equal(scheduler.lastReport?.runId, ran.runId);
  assert.equal(readSleepV6Log(dir).length, 1);
  scheduler.start();
  assert.equal(scheduler.started, true);
  scheduler.start();
  scheduler.stop();
  assert.equal(scheduler.started, false);
});

// -------------------------------------------------------------- migration ---
test('v6 migration: long-term -> v6, idempotent lần 2', () => {
  const dir = makeTempDir();
  const longTerm = new LongTermMemory(dir);
  longTerm.remember({ key: 'home_city', value: 'Hà Nội', tags: ['city'], botId: BOT, userId: USER });
  longTerm.remember({ key: 'food', value: 'phở', botId: BOT, userId: USER });
  const store = V6RecordStore.inMemory();
  const first = migrateLongTermMemory(longTerm, store, { appId: APP });
  assert.equal(first.source, 'longterm');
  assert.equal(first.read, 2);
  assert.equal(first.migrated, 2);
  assert.equal(store.count(), 2);
  const second = migrateLongTermMemory(longTerm, store, { appId: APP });
  assert.equal(second.migrated, 0);
  assert.equal(second.skippedDuplicate, 2);
  assert.equal(store.count(), 2);
  const winner = getScopedMemory(store, { userId: USER, agentId: BOT, appId: APP }, 'home_city');
  assert.equal(winner?.text, 'home_city: Hà Nội');
});

test('v6 migration: graph facts -> v6, giữ chuỗi supersession', () => {
  const store = V6RecordStore.inMemory();
  const now = new Date().toISOString();
  const oldFact = {
    id: 'fact-old', subjectId: 'ent-user', predicate: 'lives_in', objectText: 'Hà Nội',
    validFrom: now, validUntil: null, supersededBy: 'fact-new', confidence: 0.9,
    status: 'superseded',
    scope: { userId: USER, botId: BOT, runId: '' },
    provenance: { episodeId: 'ep1', turnId: 't1', runId: '', botId: BOT, userId: USER, at: now, sourceText: 'User sống ở Hà Nội.' },
    createdAt: now, updatedAt: now,
  };
  const newFact = {
    ...oldFact, id: 'fact-new', objectText: 'Đà Nẵng', supersededBy: undefined, status: 'active',
    provenance: { ...oldFact.provenance, sourceText: 'User sống ở Đà Nẵng.' },
  };
  const report = migrateGraphFacts([oldFact, newFact], store, {
    appId: APP,
    resolveName: (id) => (id === 'ent-user' ? 'user' : undefined),
  });
  assert.equal(report.migrated, 2);
  assert.equal(report.errors.length, 0);
  const oldView = store.listAll().find((r) => r.source.ref === 'graph:fact-old');
  const newView = store.listAll().find((r) => r.source.ref === 'graph:fact-new');
  assert.ok(oldView && newView);
  assert.equal(oldView.text, 'user lives_in Hà Nội');
  assert.equal(oldView.status, 'superseded');
  assert.equal(oldView.supersededBy, newView.id);
  assert.equal(newView.status, 'active');
  const md = migrationReportMarkdown([report]);
  assert.match(md, /graph.*migrate 2/);
});

test('v6 migration: fact text rỗng thì skippedInvalid', () => {
  const store = V6RecordStore.inMemory();
  const now = new Date().toISOString();
  const emptyFact = {
    id: 'fact-empty', subjectId: '', predicate: '', objectText: '',
    validFrom: now, validUntil: null, confidence: 0.5, status: 'active',
    scope: { userId: USER, botId: BOT, runId: '' },
    provenance: { episodeId: 'ep1', turnId: 't1', runId: '', botId: BOT, userId: USER, at: now, sourceText: '' },
    createdAt: now, updatedAt: now,
  };
  const report = migrateGraphFacts([emptyFact], store, {});
  assert.equal(report.skippedInvalid, 1);
  assert.equal(report.migrated, 0);
});

test('v6 misc: normalizeV6Text', () => {
  assert.equal(normalizeV6Text('  Hà   Nội  '), 'hà nội');
});
