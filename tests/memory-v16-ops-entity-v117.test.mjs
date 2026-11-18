/**
 * Tests for v1.17 (Team T1) — memory v16:
 * packages/core/src/memory/v16/{entityLinking,consolidationOps}.ts
 *
 * Covers:
 *  - entity linking: normalize (bo dau / tien to dia danh), match
 *    scores (exact / alias / abbreviation / token / affix), linker
 *    resolve (link table -> exact -> scan -> create, alias ghi lai),
 *    scanDuplicateEntitiesV16 (cum trung lap, khong tu gop),
 *    mergeEntitiesV16 (doi fact, them alias, xoa entity thua,
 *    gop fact trung lap sinh ra sau khi gop).
 *  - consolidation 4 ops: ADD (fact moi), UPDATE (predicate don
 *    tri supersede, ban cu van truy van duoc), DELETE (retract),
 *    DROP (trung lap / noise / confidence thap); batch apply
 *    (ung vien sau thay ung vien truoc trong cung batch); dry-run
 *    (khong ghi); audit JSONL.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v16-ops-entity-v117.test.mjs
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
  normalizeEntityNameV16,
  entityMatchScoreV16,
  isAbbreviationOfV16,
  isSameEntityV16,
  V16EntityLinker,
  scanDuplicateEntitiesV16,
  mergeEntitiesV16,
  decideOpV16,
  applyConsolidationV16,
  applyOpV16,
  readV16ConsolidationAudit,
  appendV16ConsolidationAudit,
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

function candidate(subject, predicate, objectText, opts = {}) {
  return {
    subject,
    predicate,
    objectText,
    confidence: opts.confidence ?? 0.9,
    effectiveConfidence: opts.effectiveConfidence ?? opts.confidence ?? 0.9,
    sourceTrust: 1,
    sourceText: opts.sourceText ?? `${subject} ${predicate} ${objectText}.`,
    pattern: 'test',
    origin: 'rule',
    intent: opts.intent ?? 'assert',
    episodeId: 'e1',
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    at: '2026-01-01T00:00:00.000Z',
  };
}

// --- entity linking: normalize + match -------------------------------------

test('v16 entity normalize: bo dau tieng Viet va tien to dia danh', () => {
  assert.equal(normalizeEntityNameV16('Hà Nội'), 'ha noi');
  assert.equal(normalizeEntityNameV16('Thành phố Hồ Chí Minh'), 'ho chi minh');
  assert.equal(normalizeEntityNameV16('TP. Hà Nội'), 'ha noi');
  assert.equal(normalizeEntityNameV16('  Đà Nẵng '), 'da nang');
  assert.equal(normalizeEntityNameV16(''), '');
});

test('v16 entity match: exact / alias / abbreviation / token / affix / none', () => {
  assert.equal(entityMatchScoreV16('Hà Nội', 'Ha Noi').score, 1);
  assert.equal(entityMatchScoreV16('Hà Nội', 'Ha Noi').reason, 'exact');
  assert.equal(entityMatchScoreV16('HN', 'Hà Nội', ['HN']).score, 0.95);
  assert.equal(entityMatchScoreV16('HN', 'Hà Nội').reason, 'abbreviation');
  assert.equal(entityMatchScoreV16('HCM', 'Hồ Chí Minh').reason, 'abbreviation');
  assert.equal(isAbbreviationOfV16('hn', 'ha noi'), true);
  assert.equal(isAbbreviationOfV16('hx', 'ha noi'), false);
  assert.equal(isAbbreviationOfV16('h', 'ha noi'), false);
  const token = entityMatchScoreV16('phở bò tái', 'phở bò');
  assert.ok(token.score >= 0.5 && token.score < 1);
  assert.equal(entityMatchScoreV16('Hà Nội', 'Đà Nẵng').score < 0.5, true);
  assert.equal(isSameEntityV16('Hà Nội', 'Ha Noi'), true);
  assert.equal(isSameEntityV16('Hà Nội', 'Đà Nẵng'), false);
});

test('v16 linker resolve: tao moi, tim lai, ghi alias cho bien the', () => {
  const store = freshStore();
  const linker = new V16EntityLinker(store);
  const first = linker.resolve('Hà Nội', 'place');
  assert.equal(first.created, true);
  assert.equal(first.entity.name, 'Hà Nội');
  const second = linker.resolve('Ha Noi', 'place');
  assert.equal(second.created, false);
  assert.equal(second.entity.id, first.entity.id);
  assert.equal(second.reason, 'exact');
  assert.equal(linker.size, 1);
  const third = linker.resolve('HCM', 'place');
  assert.equal(third.created, true);
  const fourth = linker.resolve('Ho Chi Minh', 'place');
  assert.equal(fourth.created, false);
  assert.equal(fourth.entity.id, third.entity.id);
  assert.equal(fourth.reason, 'abbreviation');
  // Link table serialize / khoi phuc duoc.
  const json = linker.toJson();
  assert.equal(json.version, 1);
  assert.ok(json.links.length >= 3);
  const restored = V16EntityLinker.fromJson(store, json);
  assert.equal(restored.findLink('Ha Noi')?.canonicalId, first.entity.id);
});

test('v16 linker resolve: ten rong thi loi, manual link ghi de', () => {
  const store = freshStore();
  const linker = new V16EntityLinker(store);
  assert.throws(() => linker.resolve('   '), /rong/);
  const entity = linker.resolve('Phở Bò', 'thing').entity;
  const link = linker.addManualLink('pho bo ngon', entity.id);
  assert.equal(link.reason, 'manual');
  assert.equal(link.canonicalId, entity.id);
  assert.throws(() => linker.addManualLink('x', 'no-such-id'), /Khong tim thay/);
});

test('v16 scan duplicates: gom cum "Ha Noi"/"thanh pho Ha Noi"/"HN", khong tu gop', () => {
  const store = freshStore();
  seedFact(store, 'Hà Nội', 'likes', 'phở');
  // 'thanh pho Ha Noi' chuan hoa khac 'ha noi' nen store tao entity rieng.
  seedFact(store, 'thành phố Hà Nội', 'likes', 'bún chả');
  // 'HN' la viet tat — entity rieng, de mo phong du lieu cu.
  store.ensureEntity('HN', 'place');
  const clusters = scanDuplicateEntitiesV16(store);
  assert.ok(clusters.length >= 1);
  const cluster = clusters.find((c) => c.duplicates.length >= 1);
  assert.ok(cluster);
  assert.ok(
    cluster.duplicates.some((d) => d.name === 'thành phố Hà Nội' || d.name === 'HN'),
  );
  // Scan khong doi store: so entity giu nguyen.
  assert.equal(store.listEntities().length, 3);
});

test('v16 merge entities: doi fact, them alias, xoa thua, gop fact trung', () => {
  const store = freshStore();
  const keep = seedFact(store, 'Hà Nội', 'likes', 'phở');
  // 'HN' la entity rieng (viet tat) — dung lam ban thua de gop.
  const dup = seedFact(store, 'HN', 'likes', 'phở');
  const other = seedFact(store, 'HN', 'likes', 'bún chả');
  void keep;
  void other;
  const keepEntity = store.findEntityByName('Hà Nội');
  const dupEntity = store.findEntityByName('HN');
  assert.ok(keepEntity && dupEntity);
  const result = mergeEntitiesV16(store, keepEntity.id, [dupEntity.id], {
    mergeDuplicateFacts: true,
  });
  assert.equal(result.removedIds.length, 1);
  assert.ok(result.repointedFacts >= 2);
  assert.ok(result.aliasesAdded.includes('HN'));
  assert.equal(store.getEntity(dupEntity.id), undefined);
  // Fact trung lap (cung likes pho) da gop: mot trong hai ban tro
  // thanh superseded (ban giu la ban nao tuy thu tu sort cua store).
  assert.equal(result.mergedFactIds.length, 1);
  const mergedId = result.mergedFactIds[0];
  assert.ok(mergedId === dup.id || mergedId === keep.id);
  assert.equal(store.getFact(mergedId).status, 'superseded');
  const survivorId = mergedId === dup.id ? keep.id : dup.id;
  assert.equal(store.getFact(survivorId).status, 'active');
  // Fact khac object van active, gio tro ve entity giu.
  assert.equal(store.getFact(other.id).status, 'active');
  assert.equal(store.getFact(other.id).subjectId, keepEntity.id);
});

// --- consolidation 4 ops ---------------------------------------------------

test('v16 decide ADD: fact moi, predicate da tri cung object moi', () => {
  const store = freshStore();
  const d = decideOpV16(store, candidate('An', 'likes', 'phở bò'), SCOPE);
  assert.equal(d.op, 'add');
  const applied = applyConsolidationV16(store, [candidate('An', 'likes', 'phở bò')], SCOPE);
  assert.equal(applied.added, 1);
  assert.equal(applied.addedFactIds.length, 1);
  assert.equal(store.listFacts().length, 1);
});

test('v16 decide DROP: trung lap chinh xac, noise, confidence thap', () => {
  const store = freshStore();
  seedFact(store, 'An', 'likes', 'phở bò');
  const dup = decideOpV16(store, candidate('An', 'likes', 'phở bò'), SCOPE);
  assert.equal(dup.op, 'drop');
  assert.ok(dup.duplicateOf);
  const noise = decideOpV16(store, candidate('An', 'likes', 'x'), SCOPE);
  assert.equal(noise.op, 'drop');
  const low = decideOpV16(
    store,
    candidate('An', 'likes', 'bún chả', { effectiveConfidence: 0.1 }),
    SCOPE,
  );
  assert.equal(low.op, 'drop');
  const empty = decideOpV16(store, candidate('', 'likes', 'phở'), SCOPE);
  assert.equal(empty.op, 'drop');
});

test('v16 decide UPDATE: predicate don tri supersede, lich su van con', () => {
  const store = freshStore();
  const oldFact = seedFact(store, 'An', 'lives_in', 'Hà Nội');
  const decision = decideOpV16(store, candidate('An', 'lives_in', 'Đà Nẵng'), SCOPE);
  assert.equal(decision.op, 'update');
  assert.equal(decision.affectedFact?.id, oldFact.id);
  const applied = applyOpV16(store, decision, SCOPE);
  assert.equal(applied.op, 'update');
  assert.ok(applied.factId);
  assert.equal(store.getFact(oldFact.id).status, 'superseded');
  assert.equal(store.getFact(oldFact.id).supersededBy, applied.factId);
  const next = store.getFact(applied.factId);
  assert.equal(next.supersedes, oldFact.id);
  assert.equal(next.objectText, 'Đà Nẵng');
  // Lich su van truy van duoc: ban cu co validUntil.
  assert.ok(next.validFrom >= oldFact.validUntil);
  assert.equal(store.factHistory(applied.factId).length, 2);
});

test('v16 decide UPDATE: predicate da tri khong update (them gia tri moi)', () => {
  const store = freshStore();
  seedFact(store, 'An', 'likes', 'phở bò');
  const d = decideOpV16(store, candidate('An', 'likes', 'bún chả'), SCOPE);
  assert.equal(d.op, 'add');
});

test('v16 decide DELETE: retract xoa mem fact cu, khong tao fact moi', () => {
  const store = freshStore();
  const oldFact = seedFact(store, 'An', 'likes', 'phở bò');
  const decision = decideOpV16(
    store,
    candidate('An', 'likes', 'phở bò', { intent: 'retract' }),
    SCOPE,
  );
  assert.equal(decision.op, 'delete');
  const applied = applyOpV16(store, decision, SCOPE);
  assert.equal(applied.factId, oldFact.id);
  assert.equal(store.getFact(oldFact.id).status, 'deleted');
  assert.equal(store.listFacts({ status: 'active' }).length, 0);
  // Retract fact khong ton tai -> drop.
  const missing = decideOpV16(
    store,
    candidate('An', 'likes', 'bún chả', { intent: 'retract' }),
    SCOPE,
  );
  assert.equal(missing.op, 'drop');
});

test('v16 decide DELETE: retract khong khop object thi drop, khong xoa fact khac', () => {
  const store = freshStore();
  const kept = seedFact(store, 'An', 'likes', 'phở bò');
  const decision = decideOpV16(
    store,
    candidate('An', 'likes', 'bún chả', { intent: 'retract' }),
    SCOPE,
  );
  assert.equal(decision.op, 'drop');
  assert.equal(store.getFact(kept.id).status, 'active');
});

test('v16 batch: ung vien sau trong cung batch thay ung vien truoc', () => {
  const store = freshStore();
  const report = applyConsolidationV16(
    store,
    [
      candidate('An', 'lives_in', 'Hà Nội'),
      candidate('An', 'lives_in', 'Đà Nẵng'),
      candidate('An', 'lives_in', 'Đà Nẵng'),
    ],
    SCOPE,
  );
  assert.equal(report.total, 3);
  assert.equal(report.added, 1);
  assert.equal(report.updated, 1);
  assert.equal(report.dropped, 1);
  assert.equal(store.listFacts({ status: 'active' }).length, 1);
  assert.equal(store.listFacts({ status: 'active' })[0].objectText, 'Đà Nẵng');
});

test('v16 dry-run: tinh quyet dinh ma khong ghi vao store', () => {
  const store = freshStore();
  const report = applyConsolidationV16(store, [candidate('An', 'likes', 'phở bò')], SCOPE, {
    dryRun: true,
  });
  assert.equal(report.added, 1);
  assert.equal(store.listFacts().length, 0);
});

test('v16 audit: ghi va doc lai dong audit JSONL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v16-audit-'));
  appendV16ConsolidationAudit(dir, {
    at: '2026-11-16T00:00:00.000Z',
    actor: 'test',
    op: 'add',
    subject: 'An',
    predicate: 'likes',
    objectText: 'phở bò',
    confidence: 0.9,
    factId: 'f1',
    affectedFactId: null,
    reason: 'Fact moi.',
    dryRun: false,
  });
  const entries = readV16ConsolidationAudit(dir, 10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, 'add');
  assert.equal(entries[0].subject, 'An');
  // Thu muc khong co file -> danh sach rong, khong throw.
  assert.deepEqual(readV16ConsolidationAudit(path.join(dir, 'nope'), 10), []);
});

test('v16 entity linking trong consolidation: "Ha Noi" khong tao subject moi', () => {
  const store = freshStore();
  const linker = new V16EntityLinker(store);
  applyConsolidationV16(store, [candidate('An', 'lives_in', 'Hà Nội')], SCOPE, { linker });
  const decision = decideOpV16(store, candidate('An', 'lives_in', 'Đà Nẵng'), SCOPE, { linker });
  assert.equal(decision.op, 'update');
});
