/**
 * Tests for memory v22 — scheduler / snapshot + audit / dreamer end-to-end
 * (v1.37, Doi T1).
 * packages/core/src/memory/v22/{scheduler,snapshot,dreamer}.ts
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v22-scheduler-snapshot-v137.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V22AuditLog,
  V22DreamError,
  V22DreamScheduler,
  V22Dreamer,
  V22DreamStore,
  V22SnapshotStore,
  dreamFactToV21RecordV22,
  hashSnapshotContentV22,
  resolveDreamConfigV22,
  v21RecordToDreamInputV22,
  validateDreamConfigV22,
  verifySnapshotV22,
} from '../packages/core/dist/memory/v22/index.js';
import { V20CoreBlockStore } from '../packages/core/dist/memory/v20/index.js';

const NOW = 1794000000000;
const DAY = 86_400_000;

function add(store, text, extra = {}) {
  const res = store.addFact({ text, ...extra }, NOW);
  assert.ok(res.ok, `addFact that bai: ${res.error}`);
  return res.data;
}

// --- scheduler -----------------------------------------------------------

test('v22 scheduler: lich / buoc / compaction — uu tien compaction > steps > lich', () => {
  const s = new V22DreamScheduler();
  assert.equal(s.getConfig().enabled, true);
  assert.equal(s.getConfig().stepsThreshold, 50);
  // Chua chay lan nao -> toi luc theo lich.
  assert.equal(s.checkDue(NOW), 'scheduled');
  // Gia lap da chay xong: het toi lich, chua du buoc.
  s.markRunStarted();
  assert.equal(s.checkDue(NOW), null); // dang chay thi khong toi luc
  s.markRunFinished({
    jobId: 'job-1', trigger: 'scheduled', startedAt: NOW, finishedAt: NOW,
    durationMs: 0, dryRun: false, rolledBack: false, factsBefore: 0, factsAfter: 0,
    duplicatesMerged: 0, factsSuperseded: 0, factsExpired: 0, patternsCreated: 0,
    patternsUpdated: 0, wikiPages: 0,
    budgetBefore: { chars: 0, estimatedTokens: 0, factCount: 0, budgetChars: 4000, withinBudget: true, overByChars: 0, includedIds: [], excludedIds: [] },
    budgetAfter: { chars: 0, estimatedTokens: 0, factCount: 0, budgetChars: 4000, withinBudget: true, overByChars: 0, includedIds: [], excludedIds: [] },
    changes: [], errors: [], skipped: [],
  });
  assert.equal(s.getStepsSinceRun(), 0);
  assert.equal(s.checkDue(NOW), null);
  assert.equal(s.noteStep(49), 49);
  assert.equal(s.checkDue(NOW), null);
  assert.equal(s.noteStep(1), 50);
  assert.equal(s.checkDue(NOW), 'steps');
  // Compaction uu tien hon steps.
  s.noteCompaction();
  assert.equal(s.checkDue(NOW), 'compaction');
  // Co compaction da duoc "an"; lan sau chi con steps.
  assert.equal(s.checkDue(NOW), 'steps');
  const state = s.getState(NOW);
  assert.equal(state.status, 'done');
  assert.equal(state.stepsSinceRun, 50);
  assert.equal(state.lastTrigger, 'scheduled');
  assert.equal(state.nextDueAt, NOW + 6 * 60 * 60 * 1000);
});

test('v22 scheduler: tat thi khong bao gio toi luc; config sai thi throw', () => {
  const s = new V22DreamScheduler({ enabled: false });
  s.noteStep(1000);
  s.noteCompaction();
  assert.equal(s.checkDue(NOW), null);
  assert.equal(s.nextDueAt(NOW), undefined);
  assert.throws(() => new V22DreamScheduler({ stepsThreshold: 0 }), V22DreamError);
  assert.throws(() => new V22DreamScheduler({ intervalMs: -1 }), V22DreamError);
  assert.throws(() => new V22DreamScheduler({ dedupeThreshold: 1.5 }), V22DreamError);
  assert.throws(() => validateDreamConfigV22({ ...resolveDreamConfigV22(), maxCharsAlwaysLoaded: 0 }), V22DreamError);
  assert.throws(() => s.noteStep(-1), V22DreamError);
  const ok = resolveDreamConfigV22({ stepsThreshold: 10 });
  assert.equal(ok.stepsThreshold, 10);
  assert.equal(ok.enabled, true);
});

test('v22 scheduler: ap luc bo nho vuot nguong -> trigger memory_pressure', () => {
  const s = new V22DreamScheduler({ memoryPressureThreshold: 0.85 });
  assert.equal(s.getConfig().memoryPressureThreshold, 0.85);
  assert.equal(s.getLastMemoryPressure(), undefined);
  s.noteMemoryPressure(0.5);
  assert.equal(s.getLastMemoryPressure(), 0.5);
  // Duoi nguong thi khong toi luc (van tra 'scheduled' lan dau — chua chay lan nao).
  assert.equal(s.checkDue(NOW), 'scheduled');
  // Ghi nhan ap luc cao: lan check ke tiep (sau khi het 'scheduled' lan dau
  // bang cach danh dau da chay) tra ve memory_pressure.
  s.markRunStarted();
  s.markRunFinished({
    jobId: 'job-1', trigger: 'scheduled', startedAt: NOW, finishedAt: NOW,
    durationMs: 0, dryRun: false, rolledBack: false, factsBefore: 0, factsAfter: 0,
    factsCollected: 0, duplicatesMerged: 0, factsSuperseded: 0, factsExpired: 0,
    patternsCreated: 0, patternsUpdated: 0, wikiPages: 0,
    budgetBefore: { chars: 0, estimatedTokens: 0, factCount: 0, budgetChars: 4000, withinBudget: true, overByChars: 0, includedIds: [], excludedIds: [] },
    budgetAfter: { chars: 0, estimatedTokens: 0, factCount: 0, budgetChars: 4000, withinBudget: true, overByChars: 0, includedIds: [], excludedIds: [] },
    changes: [], errors: [], skipped: [],
  });
  s.noteStep(10);
  s.noteMemoryPressure(0.9);
  assert.equal(s.checkDue(NOW), 'memory_pressure');
  // Co ap luc da duoc "an"; lan sau chi con steps? chua du 50 buoc nen null.
  assert.equal(s.checkDue(NOW), null);
  assert.equal(s.getLastMemoryPressure(), undefined);
  assert.throws(() => s.noteMemoryPressure(1.5), V22DreamError);
  assert.throws(() => new V22DreamScheduler({ memoryPressureThreshold: 2 }), V22DreamError);
});

test('v22 scheduler: timer start/stop (unref, khong giu process)', () => {
  const s = new V22DreamScheduler();
  assert.equal(s.isTimerRunning(), false);
  assert.equal(s.start(() => {}), true);
  assert.equal(s.isTimerRunning(), true);
  assert.equal(s.start(() => {}), false);
  assert.equal(s.stop(), true);
  assert.equal(s.stop(), false);
  assert.equal(s.isTimerRunning(), false);
});

// --- snapshot + audit ----------------------------------------------------

test('v22 snapshot: chup/khoi phuc dung trang thai; hash phat hien hong', () => {
  const store = new V22DreamStore();
  const f1 = add(store, 'User thich ca phe den.');
  const snaps = new V22SnapshotStore();
  const snap = snaps.create(store, { actor: 'tester', reason: 'truoc dream', now: NOW });
  assert.ok(snap.id.startsWith('snap-'));
  assert.equal(snap.facts.length, 1);
  assert.equal(verifySnapshotV22(snap), true);
  assert.equal(hashSnapshotContentV22(snap.facts, snap.wiki), snap.hash);
  // Sua store sau khi chup, roi khoi phuc -> dung trang thai luc chup.
  add(store, 'Fact moi sau snapshot.', {});
  store.setStatus(f1.id, 'expired');
  assert.equal(store.size(), 2);
  const restored = snaps.restore(store, snap.id);
  assert.equal(restored.ok, true);
  assert.equal(restored.restoredFacts, 1);
  assert.equal(store.size(), 1);
  assert.equal(store.get(f1.id).status, 'active');
  // Snapshot hong hash thi khong cho rollback.
  const tampered = snaps.get(snap.id);
  tampered.facts[0].text = 'Bi sua tay.';
  assert.equal(verifySnapshotV22(tampered), false);
  // Snapshot khong co -> loi co cau truc.
  assert.equal(snaps.restore(store, 'snap-khong-co').ok, false);
  assert.equal(snaps.get('snap-khong-co'), undefined);
});

test('v22 snapshot: export/import giu nguyen snapshot, hong hash thi bo qua', () => {
  const store = new V22DreamStore();
  add(store, 'User thich ca phe den.');
  const snaps = new V22SnapshotStore();
  const snap = snaps.create(store, { actor: 'tester', reason: 'test', now: NOW });
  const state = snaps.exportState();
  assert.equal(state.snapshots.length, 1);
  // Hong hash 1 ban sao -> import chi nhan ban lanh.
  const tampered = JSON.parse(JSON.stringify(state));
  tampered.snapshots[0].facts[0].text = 'Bi sua tay.';
  const snaps2 = new V22SnapshotStore();
  assert.deepEqual(snaps2.importState(tampered), { imported: 0, skipped: 1 });
  assert.equal(snaps2.size(), 0);
  const snaps3 = new V22SnapshotStore();
  assert.deepEqual(snaps3.importState(state), { imported: 1, skipped: 0 });
  assert.equal(snaps3.size(), 1);
  assert.equal(snaps3.get(snap.id).hash, snap.hash);
  // Khoi phuc tu snapshot da nap lai van dung.
  add(store, 'Fact moi se bien mat sau restore.');
  const restored = snaps3.restore(store, snap.id);
  assert.equal(restored.ok, true);
  assert.equal(store.size(), 1);
});

test('v22 snapshot: gioi han 50 snapshot (cu nhat tu roi)', () => {
  const store = new V22DreamStore();
  add(store, 'Fact duy nhat.');
  const snaps = new V22SnapshotStore();
  for (let i = 0; i < 55; i += 1) snaps.create(store, { now: NOW + i });
  assert.equal(snaps.size(), 50);
  assert.equal(snaps.droppedCount(), 5);
  assert.equal(snaps.list().length, 50);
});

test('v22 audit: append-only, loc theo actor/action/factId', () => {
  const log = new V22AuditLog();
  log.append({ actor: 'dream:v22', action: 'dream:done', factIds: ['a', 'b'], detail: 'xong', at: NOW });
  log.append({ actor: 'user', action: 'rollback', factIds: ['a'], snapshotId: 'snap-1', detail: 've snap', at: NOW + 1000 });
  log.append({ actor: 'dream:v22', action: 'dream:start', factIds: [], detail: 'bat dau', at: NOW + 2000 });
  assert.equal(log.size(), 3);
  assert.equal(log.list({ action: 'rollback' }).length, 1);
  assert.equal(log.list({ actor: 'dream:v22' }).length, 2);
  assert.equal(log.list({ factId: 'a' }).length, 2);
  assert.equal(log.list({ snapshotId: 'snap-1' }).length, 1);
  assert.equal(log.list({ limit: 1 }).length, 1);
  assert.equal(log.list({ limit: 1 })[0].action, 'dream:start'); // moi nhat truoc
  const exported = log.exportAll();
  const log2 = new V22AuditLog();
  assert.deepEqual(log2.importAll(exported), { imported: 3, skipped: 0 });
  assert.equal(log2.size(), 3);
});

// --- dreamer end-to-end --------------------------------------------------

function seedDreamer() {
  const dreamer = new V22Dreamer();
  const store = dreamer.store;
  // Cap trung (se gop).
  add(store, 'User thich ca phe den moi sang.', { confidence: 0.9, sessionIds: ['s1'] });
  add(store, 'User thich ca phe den moi sang khong duong.', { confidence: 0.7, sessionIds: ['s2'] });
  // Cap mau thuan (se supersede).
  add(store, 'User thich uong tra dao.', { topic: 'user|thich_uong', value: 'tra-dao', confidence: 0.6 });
  add(store, 'Do uong yeu thich cua user hien la ca phe den.', { topic: 'user|thich_uong', value: 'ca-phe-den', confidence: 0.9 });
  // Fact het han.
  add(store, 'User dang o Ha Noi den 20/11.', { validUntil: NOW - DAY });
  // Bo 3 quan sat lap lai (se tong hop pattern — chu y: 3 text giong
  // het nhau se bi dedupe gop truoc, keeper giu du 3 session).
  for (const s of ['s1', 's2', 's3']) {
    add(store, 'User tap the duc buoi sang.', { confidence: 0.8, sessionIds: [s] });
  }
  // Fact binh thuong (se vao always-loaded + wiki).
  add(store, 'User thich pho bo Ha Noi.', { topic: 'user|thich_an', value: 'pho-bo', confidence: 0.85 });
  return dreamer;
}

test('v22 dreamer: chay dream day du — gop/supersede/het han/pattern/wiki/budget co bang chung', () => {
  const dreamer = seedDreamer();
  const before = dreamer.store.activeCount();
  assert.equal(before, 9);
  const report = dreamer.runDream('manual', { now: NOW });
  assert.equal(report.dryRun, false);
  assert.equal(report.rolledBack, false);
  assert.equal(report.errors.length, 0);
  assert.ok(report.snapshotId);
  assert.equal(report.duplicatesMerged, 3); // 1 cap ca phe + 2 ban tap the duc
  assert.equal(report.factsSuperseded, 1);
  assert.equal(report.factsExpired, 1);
  assert.equal(report.patternsCreated, 1);
  assert.equal(report.patternsUpdated, 0);
  assert.ok(report.wikiPages >= 2);
  assert.equal(report.factsBefore, 9);
  // Sau dream: 9 - 3 gop - 1 supersede - 1 het han + 1 pattern = 5 active.
  assert.equal(report.factsAfter, 5);
  assert.equal(dreamer.store.activeCount(), 5);
  // Moi change deu co bang chung.
  for (const change of report.changes) {
    assert.ok(change.factIdsBefore.length > 0 || change.kind === 'wiki');
    assert.ok(change.factIdsAfter.length > 0);
    assert.ok(change.reason.length > 10);
    assert.ok(change.at > 0);
  }
  const kinds = report.changes.map((c) => c.kind);
  assert.ok(kinds.includes('merge'));
  assert.ok(kinds.includes('supersede'));
  assert.ok(kinds.includes('expire'));
  assert.ok(kinds.includes('pattern'));
  assert.ok(kinds.includes('wiki'));
  // Budget do truoc/sau; wiki co trang.
  assert.ok(report.budgetBefore.chars >= 0);
  assert.equal(report.budgetAfter.withinBudget, true);
  const wiki = dreamer.getWikiIndex();
  assert.ok(wiki);
  assert.equal(wiki.jobId, report.jobId);
  assert.ok(wiki.pages.some((p) => p.slug === 'user-thich-uong'));
  // Audit co dream:start + dream:done; scheduler ghi nhan lan chay.
  assert.equal(dreamer.audit.list({ action: 'dream:start' }).length, 1);
  assert.equal(dreamer.audit.list({ action: 'dream:done' }).length, 1);
  assert.equal(dreamer.scheduler.getState().lastTrigger, 'manual');
  assert.equal(dreamer.getLastReport().jobId, report.jobId);
  // Rollback ve snapshot -> dung trang thai truoc dream.
  const rolled = dreamer.rollbackToSnapshot(report.snapshotId);
  assert.equal(rolled.ok, true);
  assert.equal(rolled.restoredFacts, 9);
  assert.equal(dreamer.store.activeCount(), 9);
  assert.equal(dreamer.audit.list({ action: 'rollback' }).length, 1);
  assert.equal(dreamer.rollbackToSnapshot('snap-khong-co').ok, false);
});

test('v22 dreamer: dry-run khong ghi gi vao store, khong tao snapshot', () => {
  const dreamer = seedDreamer();
  const before = dreamer.store.exportState();
  const report = dreamer.runDream('manual', { now: NOW, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.snapshotId, undefined);
  assert.equal(report.duplicatesMerged, 3);
  assert.equal(report.factsSuperseded, 1);
  assert.equal(report.factsExpired, 1);
  assert.equal(report.patternsCreated, 1);
  // Store that khong doi (so fact + noi dung y het).
  const after = dreamer.store.exportState();
  assert.equal(after.facts.length, before.facts.length);
  assert.deepEqual(
    after.facts.map((f) => [f.id, f.status]).sort(),
    before.facts.map((f) => [f.id, f.status]).sort(),
  );
  assert.equal(dreamer.snapshots.size(), 0);
  assert.equal(dreamer.getWikiIndex(), undefined);
  assert.equal(dreamer.audit.size(), 0);
});

test('v22 dreamer: nhap tu record v21 + xuat lai record v21', () => {
  const dreamer = new V22Dreamer();
  const record = {
    id: 'user-thich-ca-phe',
    type: 'fact',
    title: 'User thich ca phe',
    body: 'User uong ca phe den moi sang.',
    tags: ['topic:user|thich_uong', 'ca-phe'],
    sources: ['chat:s1'],
    codeRefs: [],
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    staleAfter: '2020-01-01',
  };
  const input = v21RecordToDreamInputV22(record, NOW);
  assert.equal(input.topic, 'user|thich_uong');
  assert.ok(input.validUntil < NOW);
  const res = dreamer.importFromV21Records([record], { now: NOW });
  assert.deepEqual(res, { imported: 1, skipped: 0, errors: [] });
  assert.equal(dreamer.store.size(), 1);
  const out = dreamer.exportToV21Records('dream:test');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, dreamer.store.list()[0].id);
  assert.equal(out[0].type, 'fact');
  assert.ok(out[0].tags.includes('dream-consolidated'));
  assert.ok(out[0].sources.includes('dream:test'));
  assert.equal(out[0].staleAfter, '2020-01-01');
  // Record rong thi bi bo qua.
  const bad = dreamer.importFromV21Records([{ ...record, id: 'rong', body: '   ' }], { now: NOW });
  assert.equal(bad.imported, 0);
  assert.equal(bad.skipped, 1);
  // Chuyen doi truc tiep (khong qua store).
  const direct = dreamFactToV21RecordV22(dreamer.store.list()[0], 'dream:x');
  assert.equal(direct.type, 'fact');
  assert.equal(v21RecordToDreamInputV22({ ...record, body: '' }, NOW), null);
});

test('v22 dreamer: dong bo always-loaded vao block v20', () => {
  const dreamer = new V22Dreamer();
  add(dreamer.store, 'User thich ca phe den.', { confidence: 0.9 });
  const blocks = new V20CoreBlockStore();
  const res = dreamer.syncAlwaysLoadedToBlock(blocks, NOW);
  assert.equal(res.ok, true);
  assert.ok(res.blockId);
  assert.ok(res.blockVersion >= 2);
  assert.ok(res.charsWritten > 0);
  const block = blocks.getBlock('dreaming');
  assert.ok(block);
  assert.match(block.value, /User thich ca phe den/);
});

test('v22 dreamer: doi config (validate + dong bo scheduler)', () => {
  const dreamer = new V22Dreamer({ config: { enabled: false } });
  assert.equal(dreamer.getConfig().enabled, false);
  const next = dreamer.updateConfig({ enabled: true, stepsThreshold: 10 });
  assert.equal(next.enabled, true);
  assert.equal(next.stepsThreshold, 10);
  assert.throws(() => dreamer.updateConfig({ stepsThreshold: 0 }), V22DreamError);
});
