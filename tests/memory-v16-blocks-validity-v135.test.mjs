/**
 * Tests for v1.35 (Team T1) — memory v16:
 * packages/core/src/memoryV16/{blocks,temporalKg}.ts
 *
 * Covers:
 *  - Self-managed core blocks: ensureCoreBlocks (idempotent, 3 core);
 *    core_memory_replace exact-match (ok / 0 match / multi match);
 *    pin blocks normal edits, allows force+reason; pinVersion +
 *    restorePinnedVersion; kind char budget + total budget report;
 *    compileBlocksM16 pinned-first ordering; JSON round-trip
 *    (skips broken blocks, keeps pin state).
 *  - Sleep reorganizer v16: refuses when not idle, runs when forced;
 *    NEVER touches pinned blocks (protect count + log); merges small
 *    unpinned same-kind blocks; truncates over-limit unpinned blocks.
 *  - Temporal validity v2: status active/not_yet/expired/invalidated/
 *    superseded/deleted; ledger override narrows the window; set /
 *    expire / extend; factsValidAt; expiry sweep; replaceFact with
 *    window history; validity timeline; supersession chain.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v16-blocks-validity-v135.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  M16BlockStore,
  M16_MAX_BLOCK_CHARS,
  M16_MAX_BLOCKS,
  M16_KIND_CHAR_BUDGET,
  M16_TOTAL_CHAR_BUDGET,
  isValidBlockLabelM16,
  validateBlockContentM16,
  coreMemoryReplaceM16,
  previewReplaceM16,
  applyBlockEditM16,
  compileBlocksM16,
  exportAuditM16,
  searchBlocksM16,
  runSleepReorganizeM16,
  splitSentencesM16,
  summarizeBlockExtractiveM16,
  truncateBlockM16,
  M16ValidityLedger,
  effectiveWindowM16,
  validityStatusM16,
  isFactValidAtM16,
  windowsOverlapM16,
  factsValidAtM16,
  factsExpiringSoonM16,
  expiredFactsM16,
  sweepExpiredM16,
  replaceFactM16,
  factValidityTimelineM16,
  formatValidityTimelineM16,
  validityReportM16,
  formatValidityReportM16,
  supersessionChainM16,
  validateWindowM16,
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
    scope: SCOPE,
    provenance: prov(`${subject} ${predicate} ${objectText}`),
    ...(opts.validFrom ? { validFrom: opts.validFrom } : {}),
    ...(opts.validUntil !== undefined ? { validUntil: opts.validUntil } : {}),
  });
}

// ---------------------------------------------------------------------------
// Labels + content validation
// ---------------------------------------------------------------------------

test('M16 labels: valid/invalid + normalize', () => {
  assert.equal(isValidBlockLabelM16('persona'), true);
  assert.equal(isValidBlockLabelM16('my notes-2'), true);
  assert.equal(isValidBlockLabelM16(''), false);
  assert.equal(isValidBlockLabelM16('1abc'), false);
  assert.equal(isValidBlockLabelM16('a'.repeat(65)), false);
  assert.equal(isValidBlockLabelM16('has space ok'), true);
});

test('M16 content validation: empty / oversize / <memory_blocks> / control chars', () => {
  assert.equal(validateBlockContentM16('').ok, false);
  assert.equal(validateBlockContentM16('   ').ok, false);
  assert.equal(validateBlockContentM16('x'.repeat(M16_MAX_BLOCK_CHARS + 1)).ok, false);
  assert.equal(validateBlockContentM16('hello <memory_blocks> x').ok, false);
  assert.equal(validateBlockContentM16('hello </memory_blocks>').ok, false);
  assert.equal(validateBlockContentM16('bad \u0007 char').ok, false);
  assert.equal(validateBlockContentM16('ok\nwith\ttabs').ok, true);
});

// ---------------------------------------------------------------------------
// Core blocks + ensureCoreBlocks
// ---------------------------------------------------------------------------

test('M16 ensureCoreBlocks creates 3 core blocks once (idempotent)', () => {
  const s = new M16BlockStore();
  const created = s.ensureCoreBlocks('system');
  assert.equal(created.length, 3);
  assert.deepEqual(
    created.map((b) => b.label).sort(),
    ['human', 'persona', 'task'],
  );
  assert.equal(created.every((b) => b.core), true);
  assert.equal(s.listCore().length, 3);
  const again = s.ensureCoreBlocks('system');
  assert.equal(again.length, 0);
  assert.equal(s.size, 3);
});

test('M16 create: duplicate label, bad kind, block limit, kind budget', () => {
  const s = new M16BlockStore();
  s.create('notes', 'custom', 'hello', 'user');
  assert.throws(() => s.create('NOTES', 'custom', 'dup', 'user'), /da ton tai/);
  assert.throws(() => s.create('x', 'weird', 'c', 'user'), /Kind block khong hop le/);
  assert.throws(
    () => s.create('big', 'persona', 'x'.repeat(M16_KIND_CHAR_BUDGET.persona + 1), 'user'),
    /budget kind persona/,
  );
  // Block limit: fill to 32 then one more fails.
  const s2 = new M16BlockStore();
  for (let i = 0; i < M16_MAX_BLOCKS; i++) s2.create(`b${i}`, 'custom', 'x', 'user');
  assert.equal(s2.size, M16_MAX_BLOCKS);
  assert.throws(() => s2.create('overflow', 'custom', 'x', 'user'), /gioi han 32 block/);
});

test('M16 replace/append/insert/delete_range bump version + keep history', () => {
  const s = new M16BlockStore();
  s.create('human', 'human', 'A B C.', 'user');
  const r1 = s.replace('human', 'A B C D.', 'agent', 'add D');
  assert.equal(r1.version, 2);
  assert.equal(r1.history.length, 1);
  assert.equal(r1.history[0].content, 'A B C.');
  const r2 = s.append('human', 'E.', 'agent');
  assert.equal(r2.version, 3);
  assert.match(r2.content, /E\.$/);
  const r3 = s.insert('human', 0, 'Start. ', 'agent');
  assert.equal(r3.version, 4);
  assert.ok(r3.content.startsWith('Start. '));
  const r4 = s.deleteRange('human', 0, 7, 'agent');
  assert.equal(r4.version, 5);
  assert.ok(!r4.content.startsWith('Start. '));
  assert.throws(() => s.deleteRange('human', 5, 2, 'agent'), /Khoang xoa khong hop le/);
  assert.throws(() => s.insert('human', 9999, 'x', 'agent'), /Vi tri chen khong hop le/);
});

test('M16 rollback restores old content and bumps version', () => {
  const s = new M16BlockStore();
  s.create('human', 'human', 'v1.', 'user');
  s.replace('human', 'v2.', 'user');
  s.replace('human', 'v3.', 'user');
  const out = s.rollback('human', 1, 'user');
  assert.equal(out.content, 'v1.');
  assert.equal(out.version, 4);
  assert.equal(out.history.length, 3);
  assert.throws(() => s.rollback('human', 99, 'user'), /khong co version 99/);
  assert.throws(() => s.rollback('missing', 1, 'user'), /Khong tim thay block/);
});

test('M16 delete removes block; pinned delete needs force', () => {
  const s = new M16BlockStore();
  s.create('a', 'custom', 'x', 'user');
  s.create('b', 'custom', 'y', 'user');
  s.pin('b', 'user');
  assert.equal(s.delete('a'), true);
  assert.equal(s.delete('missing'), false);
  assert.throws(() => s.delete('b'), /dang PIN/);
  assert.equal(s.delete('b', true), true);
  assert.equal(s.size, 0);
});

// ---------------------------------------------------------------------------
// core_memory_replace (exact match)
// ---------------------------------------------------------------------------

test('M16 core_memory_replace: exact single match replaces + bumps version', () => {
  const s = new M16BlockStore();
  s.create('human', 'human', 'User thich ca phe. User song o Ha Noi.', 'user');
  const out = coreMemoryReplaceM16(s, 'human', 'ca phe', 'tra da', 'agent');
  assert.equal(out.content, 'User thich tra da. User song o Ha Noi.');
  assert.equal(out.version, 2);
  assert.equal(out.history[0].reason, 'core_memory_replace');
});

test('M16 core_memory_replace: 0 matches fails with hint, block unchanged', () => {
  const s = new M16BlockStore();
  s.create('human', 'human', 'User thich ca phe.', 'user');
  assert.throws(() => coreMemoryReplaceM16(s, 'human', 'tra sua', 'tra da', 'agent'), /0 lan/);
  assert.equal(s.get('human').content, 'User thich ca phe.');
  assert.equal(s.get('human').version, 1);
});

test('M16 core_memory_replace: multiple matches fails with occurrence count', () => {
  const s = new M16BlockStore();
  s.create('human', 'human', 'A va A va A.', 'user');
  assert.throws(() => coreMemoryReplaceM16(s, 'human', 'A', 'B', 'agent'), /3 lan/);
  assert.throws(() => coreMemoryReplaceM16(s, 'human', '', 'B', 'agent'), /oldText/);
  assert.throws(() => coreMemoryReplaceM16(s, 'missing', 'A', 'B', 'agent'), /Khong tim thay block/);
});

test('M16 previewReplaceM16 counts occurrences + context', () => {
  const preview = previewReplaceM16('alpha beta alpha gamma', 'alpha');
  assert.equal(preview.occurrences, 2);
  assert.match(preview.context, /alpha beta alpha/);
  assert.equal(previewReplaceM16('hello', 'zzz').occurrences, 0);
  assert.equal(previewReplaceM16('hello', 'zzz').context, '');
});

test('M16 applyBlockEditM16 covers all actions incl. pin/unpin + bad op', () => {
  const s = new M16BlockStore();
  const created = applyBlockEditM16(s, { action: 'create', label: 'task', kind: 'task', content: 'Lam X.' }, 'agent');
  assert.equal(created.block.version, 1);
  const pinned = applyBlockEditM16(s, { action: 'pin', label: 'task' }, 'agent');
  assert.equal(pinned.block.pinned, true);
  const unpinned = applyBlockEditM16(s, { action: 'unpin', label: 'task' }, 'agent');
  assert.equal(unpinned.block.pinned, false);
  const replaced = applyBlockEditM16(s, { action: 'core_memory_replace', label: 'task', oldText: 'Lam X.', newText: 'Lam Y.' }, 'agent');
  assert.equal(replaced.block.content, 'Lam Y.');
  const deleted = applyBlockEditM16(s, { action: 'delete', label: 'task' }, 'agent');
  assert.equal(deleted.deleted, true);
  assert.throws(() => applyBlockEditM16(s, { action: 'create', label: 'bad label!' }), /Label block khong hop le/);
  assert.throws(() => applyBlockEditM16(s, { action: 'replace', label: 'task' }), /can co content/);
  assert.throws(() => applyBlockEditM16(s, { action: 'nope', label: 'task' }), /Action block khong hop le/);
});

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

test('M16 pin: blocks normal edits, allows force+reason, delete blocked', () => {
  const s = new M16BlockStore();
  s.create('persona', 'persona', 'Ban la tro ly.', 'user');
  const pinned = s.pin('persona', 'user', 'khoa persona');
  assert.equal(pinned.pinned, true);
  assert.ok(pinned.pinnedAt);
  assert.equal(pinned.pinnedBy, 'user');
  assert.throws(() => s.pin('persona', 'user'), /da duoc pin/);
  assert.throws(() => s.replace('persona', 'Doi.', 'agent'), /dang PIN/);
  assert.throws(() => s.append('persona', 'them', 'agent'), /dang PIN/);
  assert.throws(() => s.replace('persona', 'Doi.', 'agent', '', true), /can co ly do/);
  const forced = s.replace('persona', 'Ban la tro ly moi.', 'agent', 'cap nhat co phep', true);
  assert.equal(forced.content, 'Ban la tro ly moi.');
  assert.equal(forced.pinned, true);
  const unpinned = s.unpin('persona', 'user', 'mo khoa');
  assert.equal(unpinned.pinned, false);
  assert.equal(unpinned.pinnedAt, null);
  assert.throws(() => s.unpin('persona', 'user'), /chua duoc pin/);
});

test('M16 pinVersion freezes a version; restore brings it back', () => {
  const s = new M16BlockStore();
  s.create('task', 'task', 'Viec 1.', 'user');
  s.replace('task', 'Viec 1 + viec 2.', 'user');
  const pinned = s.pinVersion('task', 1, 'user', 'giu ban dau');
  assert.equal(pinned.pinnedSnapshot.version, 1);
  assert.equal(pinned.pinnedSnapshot.content, 'Viec 1.');
  assert.throws(() => s.pinVersion('task', 99, 'user'), /khong co version 99/);
  s.replace('task', 'Viec 3.', 'user');
  const restored = s.restorePinnedVersion('task', 'user');
  assert.equal(restored.content, 'Viec 1.');
  assert.equal(restored.version, 4);
  // Snapshot survives restore — can restore again.
  const restored2 = s.restorePinnedVersion('task', 'user');
  assert.equal(restored2.content, 'Viec 1.');
  const cleared = s.unpinVersion('task', 'user');
  assert.equal(cleared.pinnedSnapshot, null);
  assert.throws(() => s.restorePinnedVersion('task', 'user'), /khong co snapshot/);
  assert.throws(() => s.unpinVersion('task', 'user'), /khong co snapshot/);
});

test('M16 pinVersion of current version + restore on pinned block needs force', () => {
  const s = new M16BlockStore();
  s.create('human', 'human', 'Hien tai.', 'user');
  s.pinVersion('human', 1, 'user');
  s.pin('human', 'user');
  assert.throws(() => s.restorePinnedVersion('human', 'user'), /dang PIN/);
  const out = s.restorePinnedVersion('human', 'user', true);
  assert.equal(out.content, 'Hien tai.');
});

// ---------------------------------------------------------------------------
// Budget + compile
// ---------------------------------------------------------------------------

test('M16 budgetReport: per-kind + total, flags over-budget', () => {
  const s = new M16BlockStore();
  s.create('persona', 'persona', 'x'.repeat(100), 'user');
  s.create('human', 'human', 'y'.repeat(200), 'user');
  const report = s.budgetReport();
  assert.equal(report.totalChars, 300);
  assert.equal(report.totalBudget, M16_TOTAL_CHAR_BUDGET);
  assert.equal(report.totalOver, false);
  const persona = report.perKind.find((p) => p.kind === 'persona');
  assert.equal(persona.chars, 100);
  assert.equal(persona.budget, M16_KIND_CHAR_BUDGET.persona);
  assert.equal(persona.over, false);
  assert.equal(s.kindChars('persona'), 100);
  assert.equal(s.totalChars(), 300);
});

test('M16 compileBlocksM16: pinned first, then kind priority', () => {
  const s = new M16BlockStore();
  s.create('human', 'human', 'Ve user.', 'user');
  s.create('persona', 'persona', 'Ve bot.', 'user');
  s.create('notes', 'custom', 'Ghi chu.', 'user');
  s.pin('notes', 'user');
  const compiled = compileBlocksM16(s);
  assert.ok(compiled.startsWith('<memory_blocks>'));
  assert.ok(compiled.endsWith('</memory_blocks>'));
  const idxNotes = compiled.indexOf('[custom:notes]');
  const idxPersona = compiled.indexOf('[persona:persona]');
  const idxHuman = compiled.indexOf('[human:human]');
  assert.ok(idxNotes < idxPersona && idxPersona < idxHuman, 'pinned truoc, roi persona, roi human');
  assert.match(compiled, /📌pinned/);
  assert.equal(compileBlocksM16(new M16BlockStore()), '');
  const coreOnly = compileBlocksM16(s, { coreOnly: true });
  assert.ok(!coreOnly.includes('[custom:notes]'));
  assert.ok(coreOnly.includes('[persona:persona]'));
});

// ---------------------------------------------------------------------------
// JSON round-trip
// ---------------------------------------------------------------------------

test('M16 BlockStore JSON round-trip keeps pin + snapshot, skips broken', () => {
  const s = new M16BlockStore();
  s.create('persona', 'persona', 'Ban la tro ly.', 'user');
  s.pin('persona', 'user');
  s.pinVersion('persona', 1, 'user', 'giu');
  s.create('human', 'human', 'Ve user.', 'user');
  const { store, skipped } = M16BlockStore.fromJSON({
    version: 1,
    blocks: [
      ...s.toJSON().blocks,
      { id: 'bad1', label: 'bad label!', kind: 'human', content: 'x', version: 1 },
      { id: 'bad2', label: 'ok', kind: 'weird', content: 'x', version: 1 },
      { id: 'bad3', label: 'ok2', kind: 'human', content: 'has <memory_blocks> tag', version: 1 },
    ],
  });
  assert.equal(skipped, 3);
  assert.equal(store.size, 2);
  assert.equal(store.get('persona').pinned, true);
  assert.equal(store.get('persona').pinnedSnapshot.version, 1);
  assert.equal(store.get('persona').pinnedSnapshot.content, 'Ban la tro ly.');
  const empty = M16BlockStore.fromJSON(null);
  assert.equal(empty.store.size, 0);
  assert.equal(empty.skipped, 0);
});

// ---------------------------------------------------------------------------
// Sleep reorganizer v16
// ---------------------------------------------------------------------------

test('M16 sleep reorganizer refuses when not idle, runs when forced', () => {
  const s = new M16BlockStore();
  s.create('a', 'custom', 'nho', 'user');
  const refused = runSleepReorganizeM16(s, { idleMs: 1000 });
  assert.equal(refused.ran, false);
  assert.match(refused.reason, /Chua idle/);
  const ran = runSleepReorganizeM16(s, { force: true });
  assert.equal(ran.ran, true);
});

test('M16 sleep reorganizer never touches pinned blocks', () => {
  const s = new M16BlockStore();
  const long = 'Cau dai de test sleep. '.repeat(250);
  s.create('big', 'custom', long, 'user');
  s.pin('big', 'user');
  const report = runSleepReorganizeM16(s, { force: true });
  assert.equal(report.protectedPinned, 1);
  assert.equal(report.summarized, 0);
  assert.equal(s.get('big').content, long);
  assert.equal(s.get('big').version, 1);
  assert.ok(report.actions.some((a) => a.action === 'protect' && a.label === 'big'));
});

test('M16 sleep reorganizer merges small unpinned same-kind blocks', () => {
  const s = new M16BlockStore();
  s.create('n1', 'custom', 'mot', 'user');
  s.create('n2', 'custom', 'hai', 'user');
  s.create('n3', 'custom', 'ba', 'user');
  const report = runSleepReorganizeM16(s, { force: true });
  assert.equal(report.merged, 2);
  assert.equal(s.size, 1);
  assert.match(s.list()[0].content, /mot\nhai\nba/);
});

test('M16 sleep reorganizer truncates over-limit unpinned blocks', () => {
  const s = new M16BlockStore();
  const over = 'z'.repeat(M16_MAX_BLOCK_CHARS + 500);
  // Tao bang fromJSON de vuot gioi han (create chan) — mo phong du lieu cu.
  const { store } = M16BlockStore.fromJSON({
    version: 1,
    blocks: [{ id: 'x1', label: 'big', kind: 'custom', content: over, version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', history: [] }],
  });
  assert.equal(store.size, 1);
  const report = runSleepReorganizeM16(store, { force: true });
  assert.equal(report.truncated, 1);
  assert.ok(store.get('big').content.length <= M16_MAX_BLOCK_CHARS);
  assert.match(store.get('big').content, /sleep-time truncate v16/);
});

test('M16 sentence utils: split + extractive summarize + truncate', () => {
  const text = 'Cau mot. Cau hai! Cau ba? Cau bon. Cau nam. Cau sau.';
  const sentences = splitSentencesM16(text);
  assert.equal(sentences.length, 6);
  const summarized = summarizeBlockExtractiveM16(text.repeat(200), 4000);
  assert.ok(summarized.length < text.repeat(200).length);
  assert.match(summarized, /sleep-time summary v16/);
  assert.equal(summarizeBlockExtractiveM16('Ngan.', 4000), 'Ngan.');
  const truncated = truncateBlockM16('x'.repeat(1000), 500);
  assert.ok(truncated.length <= 560);
  assert.match(truncated, /sleep-time truncate v16/);
  assert.equal(truncateBlockM16('ngan', 500), 'ngan');
});

// ---------------------------------------------------------------------------
// Temporal validity v2
// ---------------------------------------------------------------------------

test('M16 validityStatus: active / not_yet / expired', () => {
  const store = freshStore();
  const fact = seedFact(store, 'user', 'works_at', 'Acme', {
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-06-01T00:00:00.000Z',
  });
  assert.equal(validityStatusM16(fact, '2026-03-01T00:00:00.000Z'), 'active');
  assert.equal(validityStatusM16(fact, '2025-12-01T00:00:00.000Z'), 'not_yet');
  assert.equal(validityStatusM16(fact, '2026-07-01T00:00:00.000Z'), 'expired');
  assert.equal(isFactValidAtM16(fact, '2026-03-01T00:00:00.000Z'), true);
  assert.equal(isFactValidAtM16(fact, '2026-07-01T00:00:00.000Z'), false);
  assert.throws(() => validityStatusM16(fact, 'not-a-date'), /Thoi gian khong hop le/);
});

test('M16 validityStatus: invalidated / superseded / deleted', () => {
  const store = freshStore();
  // validFrom phai truoc invalidAt: old store invariant — khong the
  // invalidate mot fact tai thoi diem truoc khi no bat dau dung.
  const f1 = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z' });
  store.markFactInvalidated(f1.id, { invalidAt: '2026-02-01T00:00:00.000Z', actor: 'user', reason: 'sai roi' });
  assert.equal(validityStatusM16(store.getFact(f1.id)), 'invalidated');
  const f2 = seedFact(store, 'user', 'likes', 'ca phe');
  store.supersedeFact(f2.id, {
    subjectName: 'user', predicate: 'likes', objectText: 'tra da', scope: SCOPE,
    provenance: prov('doi'),
  });
  assert.equal(validityStatusM16(store.getFact(f2.id)), 'superseded');
  const f3 = seedFact(store, 'user', 'owns', 'xe dap');
  store.deleteFact(f3.id, 'user');
  assert.equal(validityStatusM16(store.getFact(f3.id)), 'deleted');
});

test('M16 validateWindowM16 rejects empty window + bad ISO', () => {
  assert.equal(validateWindowM16({ validFrom: '2026-01-01T00:00:00.000Z', validUntil: null }).ok, true);
  assert.equal(validateWindowM16({ validFrom: '2026-06-01T00:00:00.000Z', validUntil: '2026-01-01T00:00:00.000Z' }).ok, false);
  assert.equal(validateWindowM16({ validFrom: 'nope', validUntil: null }).ok, false);
});

test('M16 ledger: set/expire/extend + history + JSON round-trip', () => {
  const ledger = new M16ValidityLedger();
  const r1 = ledger.set('f1', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: null }, 'system', 'bat dau');
  assert.equal(r1.validUntil, null);
  assert.equal(r1.history.length, 0);
  const r2 = ledger.expire('f1', '2026-03-01T00:00:00.000Z', 'system', 'het han');
  assert.equal(r2.validUntil, '2026-03-01T00:00:00.000Z');
  assert.equal(r2.history.length, 1);
  assert.equal(r2.history[0].validUntil, null);
  assert.throws(() => ledger.expire('f1', '2026-02-01T00:00:00.000Z'), /da het hieu luc/);
  const r3 = ledger.extend('f1', null, 'user', 'gia han vo han');
  assert.equal(r3.validUntil, null);
  assert.throws(() => ledger.extend('missing', null), /chua co ban ghi/);
  assert.throws(() => ledger.set('f2', { validFrom: '2026-06-01T00:00:00.000Z', validUntil: '2026-01-01T00:00:00.000Z' }, 'system'), /cua so hieu luc rong/);
  assert.equal(ledger.remove('f1'), true);
  assert.equal(ledger.has('f1'), false);
  ledger.set('f9', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: null }, 'system');
  const { ledger: restored, skipped } = M16ValidityLedger.fromJSON({
    version: 1,
    records: [...ledger.toJSON().records, { factId: 123 }],
  });
  assert.equal(skipped, 1);
  assert.equal(restored.size, 1);
  assert.equal(restored.get('f9').validFrom, '2026-01-01T00:00:00.000Z');
});

test('M16 effectiveWindowM16: ledger narrows the fact window', () => {
  const store = freshStore();
  const ledger = new M16ValidityLedger();
  const fact = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z' });
  const base = effectiveWindowM16(fact);
  assert.equal(base.validUntil, null);
  ledger.set(fact.id, { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' }, 'system', 'hop dong het');
  const narrowed = effectiveWindowM16(fact, ledger);
  assert.equal(narrowed.validUntil, '2026-02-01T00:00:00.000Z');
  assert.equal(validityStatusM16(fact, '2026-03-01T00:00:00.000Z', ledger), 'expired');
  assert.equal(validityStatusM16(fact, '2026-01-15T00:00:00.000Z', ledger), 'active');
});

test('M16 windowsOverlapM16: overlap / touch / disjoint', () => {
  const w1 = { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-06-01T00:00:00.000Z' };
  const w2 = { validFrom: '2026-03-01T00:00:00.000Z', validUntil: null };
  const w3 = { validFrom: '2026-07-01T00:00:00.000Z', validUntil: null };
  assert.equal(windowsOverlapM16(w1, w2), true);
  assert.equal(windowsOverlapM16(w1, w3), false);
  assert.equal(windowsOverlapM16(w1, { validFrom: '2026-06-01T00:00:00.000Z', validUntil: null }), false);
});

test('M16 factsValidAtM16 returns only facts valid at T', () => {
  const store = freshStore();
  seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' });
  seedFact(store, 'user', 'likes', 'ca phe', { validFrom: '2026-01-01T00:00:00.000Z' });
  const result = factsValidAtM16(store, '2026-06-01T00:00:00.000Z');
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].fact.predicate, 'likes');
  const any = factsValidAtM16(store, '2026-06-01T00:00:00.000Z', { status: 'any' });
  assert.equal(any.facts.length, 2);
  const expiredOnly = factsValidAtM16(store, '2026-06-01T00:00:00.000Z', { status: 'expired' });
  assert.equal(expiredOnly.facts.length, 1);
});

test('M16 factsExpiringSoonM16 + expiredFactsM16 + sweepExpiredM16', () => {
  const store = freshStore();
  seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-01-10T00:00:00.000Z' });
  seedFact(store, 'user', 'likes', 'tra da', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-01-20T00:00:00.000Z' });
  seedFact(store, 'user', 'owns', 'xe dap', { validFrom: '2026-01-01T00:00:00.000Z' });
  const now = new Date('2026-01-15T00:00:00.000Z');
  const soon = factsExpiringSoonM16(store, 30 * 24 * 60 * 60 * 1000, now);
  assert.equal(soon.length, 1);
  assert.equal(soon[0].fact.predicate, 'likes');
  assert.ok(soon[0].msLeft > 0);
  const expired = expiredFactsM16(store, now);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].fact.predicate, 'works_at');
  const sweep = sweepExpiredM16(store, { withinMs: 30 * 24 * 60 * 60 * 1000, now });
  assert.equal(sweep.scanned, 3);
  assert.equal(sweep.expired, 1);
  assert.equal(sweep.expiringSoon, 1);
  assert.equal(sweep.expiredIds.length, 1);
  assert.throws(() => factsExpiringSoonM16(store, -1, now), /withinMs phai la so/);
});

test('M16 replaceFactM16 supersedes old + new window + ledger', () => {
  const store = freshStore();
  const ledger = new M16ValidityLedger();
  const old = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z' });
  const result = replaceFactM16(
    store,
    old.id,
    { subjectName: 'user', predicate: 'works_at', objectText: 'Beta', scope: SCOPE, sourceText: 'doi viec' },
    { ledger, now: new Date('2026-05-01T00:00:00.000Z') },
  );
  assert.equal(result.newFact.objectText, 'Beta');
  assert.equal(result.newFact.supersedes, old.id);
  assert.equal(result.oldFact.status, 'superseded');
  assert.equal(result.oldFact.supersededBy, result.newFact.id);
  assert.equal(result.newWindow.validFrom, '2026-05-01T00:00:00.000Z');
  assert.equal(ledger.get(result.newFact.id).validFrom, '2026-05-01T00:00:00.000Z');
  assert.throws(
    () => replaceFactM16(store, 'missing-id', { subjectName: 'user', predicate: 'x', objectText: 'y', scope: SCOPE, sourceText: '' }),
    /Khong tim thay fact/,
  );
});

test('M16 factValidityTimelineM16 + format + supersessionChainM16', () => {
  const store = freshStore();
  const ledger = new M16ValidityLedger();
  const f1 = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z' });
  ledger.set(f1.id, { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' }, 'system', 'het han');
  const steps = factValidityTimelineM16(f1, ledger, new Date('2026-03-01T00:00:00.000Z'));
  const kinds = steps.map((s) => s.kind);
  assert.ok(kinds.includes('created'));
  assert.ok(kinds.includes('window_change'));
  assert.ok(kinds.includes('expired'));
  const text = formatValidityTimelineM16(f1, ledger, new Date('2026-03-01T00:00:00.000Z'));
  assert.match(text, /Timeline validity/);
  assert.match(text, /expired/);

  const a = seedFact(store, 'user', 'lives_in', 'Ha Noi');
  const b = store.supersedeFact(a.id, {
    subjectName: 'user', predicate: 'lives_in', objectText: 'Da Nang', scope: SCOPE,
    provenance: prov('doi 1'),
  });
  const c = store.supersedeFact(b.id, {
    subjectName: 'user', predicate: 'lives_in', objectText: 'TP. HCM', scope: SCOPE,
    provenance: prov('doi 2'),
  });
  assert.deepEqual(supersessionChainM16(store, c.id), [a.id, b.id, c.id]);
  assert.deepEqual(supersessionChainM16(store, b.id), [a.id, b.id, c.id]);
  assert.deepEqual(supersessionChainM16(store, a.id), [a.id, b.id, c.id]);
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

test('M16 audit trail: every mutation logged, filterable, exportable', () => {
  const s = new M16BlockStore();
  s.create('human', 'human', 'Ban dau.', 'user');
  s.replace('human', 'Sau 1.', 'agent', 'cap nhat');
  s.append('human', 'Them.', 'agent');
  s.pin('human', 'user', 'khoa');
  s.create('notes', 'custom', 'Ghi chu.', 'user');
  assert.equal(s.auditLog.length, 5);
  assert.equal(s.auditTrail('human').length, 4);
  assert.equal(s.auditTrail('notes').length, 1);
  assert.equal(s.auditTrail().length, 5);
  const summary = s.auditSummary();
  assert.equal(summary.total, 5);
  assert.equal(summary.byAction.create, 2);
  assert.equal(summary.byAction.edit, 2);
  assert.equal(summary.byAction.pin, 1);
  assert.equal(summary.byActor.user, 3);
  assert.equal(summary.byActor.agent, 2);
  const text = exportAuditM16(s, 'human');
  assert.match(text, /Audit trail v16 — block "human": 4 muc/);
  assert.match(text, /pin "human" boi user -> v3/);
  const all = exportAuditM16(s);
  assert.match(all, /toan bo store: 5 muc/);
  // Rollback + delete also audited (rollback on a PINNED block needs force).
  s.rollback('human', 1, 'user', true);
  s.delete('notes');
  assert.equal(s.auditLog.length, 7);
  assert.equal(s.auditLog[6].action, 'delete');
  assert.equal(s.auditLog[6].versionAfter, 0);
});

test('M16 audit trail survives JSON round-trip', () => {
  const s = new M16BlockStore();
  s.create('human', 'human', 'Ban dau.', 'user');
  s.replace('human', 'Sau 1.', 'agent');
  const { store } = M16BlockStore.fromJSON(s.toJSON());
  assert.equal(store.auditLog.length, 2);
  assert.equal(store.auditTrail('human')[1].action, 'edit');
});

// ---------------------------------------------------------------------------
// Validity report
// ---------------------------------------------------------------------------

test('M16 validityReportM16 counts by status + open/ledger + lists', () => {
  const store = freshStore();
  const ledger = new M16ValidityLedger();
  const f1 = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' });
  seedFact(store, 'user', 'likes', 'cà phê', { validFrom: '2026-01-01T00:00:00.000Z' });
  const f3 = seedFact(store, 'user', 'owns', 'xe dap', { validFrom: '2026-01-01T00:00:00.000Z' });
  store.markFactInvalidated(f3.id, { invalidAt: '2026-01-15T00:00:00.000Z', actor: 'user', reason: 'ban roi' });
  ledger.set(f1.id, { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' }, 'system', 'het han');
  const now = new Date('2026-06-01T00:00:00.000Z');
  const report = validityReportM16(store, { now, ledger });
  assert.equal(report.scanned, 3);
  assert.equal(report.byStatus.expired, 1);
  assert.equal(report.byStatus.active, 1);
  assert.equal(report.byStatus.invalidated, 1);
  assert.equal(report.openEnded, 1);
  assert.equal(report.ledgerOverridden, 1);
  assert.equal(report.expired.length, 1);
  const text = formatValidityReportM16(report);
  assert.match(text, /Validity report v16/);
  assert.match(text, /expired 1/);
  assert.match(text, /HET HAN: works_at = Acme/);
});

test('M16 rename: doi ten giu nguyen id/version/history + audit', () => {
  const s = new M16BlockStore();
  const created = s.create('notes', 'custom', 'Ghi chu.', 'user');
  s.replace('notes', 'Ghi chu 2.', 'user');
  const renamed = s.rename('notes', 'my notes', 'user', 'ten ro hon');
  assert.equal(renamed.label, 'my notes');
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.version, 2);
  assert.equal(renamed.history.length, 1);
  assert.equal(s.get('notes'), undefined);
  assert.equal(s.get('my notes').content, 'Ghi chu 2.');
  assert.equal(s.auditTrail('my notes').some((e) => e.action === 'rename'), true);
  assert.throws(() => s.rename('my notes', 'bad label!'), /Label block moi khong hop le/);
  s.create('other', 'custom', 'x', 'user');
  assert.throws(() => s.rename('my notes', 'other'), /da ton tai/);
  const same = s.rename('my notes', 'my notes', 'user');
  assert.equal(same.label, 'my notes');
  assert.throws(() => s.rename('missing', 'x', 'user'), /Khong tim thay block/);
});

test('M16 searchBlocksM16: label match ranks above content match', () => {
  const s = new M16BlockStore();
  s.create('coffee notes', 'custom', 'Ve tra da.', 'user');
  s.create('other', 'custom', 'User thich ca phe moi sang.', 'user');
  s.create('unrelated', 'custom', 'Khong lien quan.', 'user');
  const hits = searchBlocksM16(s, 'ca phe');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].block.label, 'other');
  assert.equal(hits[0].matchedIn, 'content');
  const labelHits = searchBlocksM16(s, 'coffee');
  assert.equal(labelHits.length, 1);
  assert.equal(labelHits[0].matchedIn, 'label');
  assert.ok(labelHits[0].score >= 2);
  const all = searchBlocksM16(s, '');
  assert.equal(all.length, 3);
  assert.equal(searchBlocksM16(s, 'zzz-no-match').length, 0);
  assert.equal(searchBlocksM16(s, 'ca phe', 0).length, 0);
});
