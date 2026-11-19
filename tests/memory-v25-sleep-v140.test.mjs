/**
 * Tests for memory v25 — sleep-time consolidation agent + pipeline + store
 * (v1.40, Doi T1). packages/core/src/memory/v25/sleep.ts, pipeline.ts, store.ts
 *
 * Run after building core (memory/v25 only):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v25-sleep-v140.test.mjs
 * No network. No model — rule judge chay local, xac dinh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  V25Pipeline,
  V25Store,
  loadV25StoreFromDir,
} from '../packages/core/dist/memory/v25/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v25-sleep-'));
}

function fresh() {
  const store = new V25Store();
  const pipeline = new V25Pipeline(store);
  return { store, pipeline };
}

test('v25 sleep: config mac dinh trigger 10, model local-rule-v1', () => {
  const { store } = fresh();
  const config = store.sleep.getConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.triggerSteps, 10);
  assert.equal(config.model, 'local-rule-v1');
  assert.equal(config.budget.maxFactsPerPass, 50);
  assert.deepEqual(config.blockTargets, []);
});

test('v25 sleep: updateConfig validate — sai tra loi, dung thi doi', () => {
  const { store } = fresh();
  assert.equal(store.sleep.updateConfig({ triggerSteps: 0 }).ok, false);
  assert.equal(store.sleep.updateConfig({ triggerSteps: 1001 }).ok, false);
  assert.equal(store.sleep.updateConfig({ triggerSteps: 2.5 }).ok, false);
  assert.equal(store.sleep.updateConfig({ model: '  ' }).ok, false);
  assert.equal(store.sleep.updateConfig({ budget: { maxFactsPerPass: 0 } }).ok, false);
  assert.equal(store.sleep.updateConfig({ blockTargets: ['Label Sai'] }).ok, false);
  const ok = store.sleep.updateConfig({ triggerSteps: 3, model: 'test-model', blockTargets: ['human'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.triggerSteps, 3);
  assert.equal(ok.value.model, 'test-model');
  assert.deepEqual(ok.value.blockTargets, ['human']);
});

test('v25 sleep: recordTurn chi buffer — primary agent KHONG sua core memory', async () => {
  const { store, pipeline } = fresh();
  store.sleep.updateConfig({ triggerSteps: 10 });
  const res = pipeline.addConversation([
    { role: 'user', text: 'Huy là kỹ sư phần mềm.', at: '2026-11-18T10:00:00.000Z' },
    { role: 'agent', text: 'Huy thích cà phê.', at: '2026-11-18T10:01:00.000Z' },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.value.buffered, 2);
  assert.equal(res.value.shouldRunSleep, false);
  // Core memory chua doi gi — chua co fact, chua co block.
  assert.equal(store.facts.size, 0);
  assert.equal(store.blocks.size, 0);
  assert.equal(store.sleep.getPendingTurnCount(), 2);
  assert.equal(store.sleep.getTurnsSinceLastPass(), 2);
});

test('v25 sleep: addConversation tu choi turn rong / role sai', () => {
  const { pipeline } = fresh();
  assert.equal(pipeline.addConversation([]).ok, false);
  assert.equal(pipeline.addConversation([{ role: 'user', text: '   ' }]).value.buffered, 0);
  assert.equal(
    pipeline.addConversation([{ role: 'bot', text: 'hello' }]).ok,
    false,
  );
});

test('v25 sleep: du trigger thi shouldRun, pass tong hop fact vao memory', async () => {
  const { store, pipeline } = fresh();
  store.sleep.updateConfig({ triggerSteps: 2 });
  pipeline.addConversation([
    { role: 'user', text: 'Huy là kỹ sư phần mềm.', at: '2026-11-18T10:00:00.000Z' },
    { role: 'user', text: 'Huy thích cà phê.', at: '2026-11-18T10:01:00.000Z' },
  ]);
  assert.equal(store.sleep.shouldRun(), true);
  const res = await pipeline.runSleepNow({ reason: 'test-trigger' });
  assert.equal(res.ok, true, res.error);
  const pass = res.value;
  assert.equal(pass.turnsScanned, 2);
  assert.ok(pass.factsExtracted >= 2, `ky vong >= 2 fact, duoc ${pass.factsExtracted}`);
  assert.equal(pass.added, pass.factsExtracted);
  assert.equal(pass.model, 'local-rule-v1');
  assert.equal(pass.reason, 'test-trigger');
  // Fact da vao store, buffer da don sach.
  assert.equal(store.facts.size, pass.added);
  assert.equal(store.sleep.getPendingTurnCount(), 0);
  assert.equal(store.sleep.getTurnsSinceLastPass(), 0);
  assert.equal(store.sleep.getTotalPasses(), 1);
  assert.equal(store.sleep.getLastPass().id, pass.id);
  // Judge log ghi lai.
  assert.ok(store.listJudgeLog({}).length >= 2);
  assert.equal(store.countJudgeByDecision().ADD, pass.added);
});

test('v25 sleep: pass thu 2 UPDATE fact cu (supersede), khong them trung', async () => {
  const { store, pipeline } = fresh();
  store.sleep.updateConfig({ triggerSteps: 1 });
  pipeline.addConversation([{ role: 'user', text: 'Huy là kỹ sư phần mềm.', at: '2026-11-18T10:00:00.000Z' }]);
  const p1 = await pipeline.runSleepNow({ reason: 'p1' });
  assert.equal(p1.ok, true);
  assert.equal(p1.value.added, 1);
  pipeline.addConversation([{ role: 'user', text: 'Huy là quản lý sản phẩm.', at: '2026-11-18T10:05:00.000Z' }]);
  const p2 = await pipeline.runSleepNow({ reason: 'p2' });
  assert.equal(p2.ok, true);
  assert.equal(p2.value.updated, 1);
  assert.equal(p2.value.closed, 1);
  // Chi 1 fact hien tai, fact cu van con trong lich su.
  assert.equal(store.facts.queryCurrent().length, 1);
  assert.equal(store.facts.queryCurrent()[0].object, 'quản lý sản phẩm');
  assert.equal(store.facts.size, 2);
  assert.equal(store.countJudgeByDecision().UPDATE, 1);
});

test('v25 sleep: runPass tren buffer rong loi; sleep tat thi can force', async () => {
  const { store, pipeline } = fresh();
  const empty = await store.sleep.runPass({ force: true });
  assert.equal(empty.ok, false);
  store.sleep.updateConfig({ enabled: false, triggerSteps: 1 });
  pipeline.addConversation([{ role: 'user', text: 'Huy là kỹ sư.', at: '2026-11-18T10:00:00.000Z' }]);
  assert.equal(store.sleep.shouldRun(), false);
  const off = await store.sleep.runPass({});
  assert.equal(off.ok, false);
  const forced = await store.sleep.runPass({ force: true, reason: 'manual' });
  assert.equal(forced.ok, true);
});

test('v25 sleep: budget het thi dung, turn thua o lai pass sau', async () => {
  const { store, pipeline } = fresh();
  const cfg = store.sleep.updateConfig({
    triggerSteps: 1,
    budget: { maxFactsPerPass: 50, maxTurnsPerPass: 20, maxCharsPerPass: 30 },
  });
  assert.equal(cfg.ok, true, cfg.error);
  assert.equal(cfg.value.budget.maxCharsPerPass, 30);
  pipeline.addConversation([
    { role: 'user', text: 'Huy là kỹ sư phần mềm.', at: '2026-11-18T10:00:00.000Z' },
    { role: 'user', text: 'Lan là nhà thiết kế đồ họa.', at: '2026-11-18T10:01:00.000Z' },
  ]);
  const res = await pipeline.runSleepNow({ reason: 'budget-test' });
  assert.equal(res.ok, true);
  assert.equal(res.value.budgetHit, true);
  assert.ok(res.value.turnsScanned < 2, 'phai dung truoc khi quet het');
  assert.ok(store.sleep.getPendingTurnCount() >= 1, 'turn thua phai o lai buffer');
  assert.ok(res.value.actions.some((a) => a.kind === 'budget'));
});

test('v25 sleep: cap nhat block dich ngoai vong lap chinh', async () => {
  const { store, pipeline } = fresh();
  store.sleep.updateConfig({ triggerSteps: 1, blockTargets: ['human'] });
  const created = store.blocks.create({
    label: 'human',
    description: 'Ve user',
    value: 'Ten la Huy.',
    ownerBotId: 'bot-a',
    attachBotIds: ['sleep-agent'],
  });
  assert.equal(created.ok, true);
  pipeline.addConversation([{ role: 'user', text: 'Huy là kỹ sư phần mềm.', at: '2026-11-18T10:00:00.000Z' }]);
  const res = await pipeline.runSleepNow({ reason: 'block-test' });
  assert.equal(res.ok, true);
  assert.equal(res.value.blocksUpdated, 1);
  const block = store.blocks.get(created.value.id);
  assert.equal(block.version, 2);
  assert.ok(block.value.includes('kỹ sư phần mềm'));
  assert.ok(block.history[1].updatedBy.includes('sleep-agent'));
});

test('v25 sleep: block dich read-only ma sleep-agent khong so huu thi bi bo qua', async () => {
  const { store, pipeline } = fresh();
  store.sleep.updateConfig({ triggerSteps: 1, blockTargets: ['human'] });
  const created = store.blocks.create({
    label: 'human',
    description: 'Ve user',
    value: 'Ten la Huy.',
    ownerBotId: 'bot-a',
    readOnly: true,
    attachBotIds: ['sleep-agent'],
  });
  assert.equal(created.ok, true);
  pipeline.addConversation([{ role: 'user', text: 'Huy là kỹ sư phần mềm.', at: '2026-11-18T10:00:00.000Z' }]);
  const res = await pipeline.runSleepNow({ reason: 'ro-test' });
  assert.equal(res.ok, true);
  // Fact van duoc ghi (judge pass chay), nhung block khong doi.
  assert.equal(res.value.added, 1);
  assert.equal(res.value.blocksUpdated, 0);
  assert.equal(store.blocks.get(created.value.id).version, 1);
  assert.ok(res.value.actions.some((a) => a.kind === 'skip'));
});

test('v25 sleep: block dich khong ton tai thi skip, pass van xong', async () => {
  const { store, pipeline } = fresh();
  store.sleep.updateConfig({ triggerSteps: 1, blockTargets: ['khong-co'] });
  pipeline.addConversation([{ role: 'user', text: 'Huy là kỹ sư.', at: '2026-11-18T10:00:00.000Z' }]);
  const res = await pipeline.runSleepNow({ reason: 'missing-block' });
  assert.equal(res.ok, true);
  assert.equal(res.value.blocksUpdated, 0);
});

test('v25 pipeline: judgeCandidate DELETE dong fact cu qua pipeline', async () => {
  const { store, pipeline } = fresh();
  store.sleep.updateConfig({ triggerSteps: 1 });
  pipeline.addConversation([{ role: 'user', text: 'Huy là kỹ sư phần mềm.', at: '2026-11-18T10:00:00.000Z' }]);
  await pipeline.runSleepNow({ reason: 'seed' });
  assert.equal(store.facts.queryCurrent().length, 1);
  const res = await pipeline.judgeCandidate(
    { subject: 'Huy', predicate: 'is', object: 'engineer', sourceText: 'Huy không còn là kỹ sư nữa.' },
    { source: 'test' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.value.verdict.decision, 'DELETE');
  assert.equal(store.facts.queryCurrent().length, 0);
  assert.equal(store.facts.size, 1);
  // Chi xem truoc (apply=false) thi khong doi gi.
  const preview = await pipeline.judgeCandidate(
    { subject: 'Lan', predicate: 'is', object: 'designer' },
    { apply: false, source: 'test' },
  );
  assert.equal(preview.ok, true);
  assert.equal(preview.value.verdict.decision, 'ADD');
  assert.equal(preview.value.applied, null);
  assert.equal(store.facts.size, 1);
});

test('v25 pipeline: previewExtraction khong ghi', () => {
  const { store, pipeline } = fresh();
  const res = pipeline.previewExtraction('Huy là kỹ sư. Lan thích trà.');
  assert.equal(res.ok, true);
  assert.ok(res.value.length >= 1);
  assert.equal(store.facts.size, 0);
  assert.equal(pipeline.previewExtraction('').ok, false);
});

test('v25 pipeline: search keyword + as-of + snapshot trong ngan sach', async () => {
  const { store, pipeline } = fresh();
  store.sleep.updateConfig({ triggerSteps: 1 });
  pipeline.addConversation([{ role: 'user', text: 'Huy là kỹ sư phần mềm.', at: '2026-11-18T10:00:00.000Z' }]);
  await pipeline.runSleepNow({ reason: 'seed' });
  const hits = pipeline.search('kỹ sư');
  assert.equal(hits.ok, true);
  assert.equal(hits.value.length, 1);
  assert.equal(hits.value[0].kind, 'fact');
  assert.ok(hits.value[0].score > 0);
  // As-of: fact co validAt cu the chi dung trong cua so valid.
  store.facts.add({
    subject: 'Lan',
    predicate: 'is',
    object: 'designer',
    validAt: '2026-11-01T00:00:00.000Z',
  });
  const past = pipeline.search('designer', { at: '2020-01-01T00:00:00.000Z' });
  assert.equal(past.ok, true);
  assert.equal(past.value.length, 0);
  const present = pipeline.search('designer', { at: '2026-11-10T00:00:00.000Z' });
  assert.equal(present.ok, true);
  assert.equal(present.value.length, 1);
  assert.equal(pipeline.search('').ok, false);
  // Snapshot: co fact, trong ngan sach.
  const snap = pipeline.snapshotForPrompt({ budgetChars: 8000, botId: 'bot-a' });
  assert.ok(snap.text.includes('kỹ sư phần mềm'));
  assert.ok(snap.text.includes('designer'));
  assert.ok(snap.chars <= 8000);
  assert.equal(snap.facts.length, 2);
  // Ngan sach nho qua thi cat.
  const tiny = pipeline.snapshotForPrompt({ budgetChars: 10, botId: 'bot-a' });
  assert.equal(tiny.truncated, true);
});

test('v25 store: save/load giu nguyen fact, block, judge log, sleep state', async () => {
  const dir = tmpDir();
  try {
    const { store, pipeline } = fresh();
    store.sleep.updateConfig({ triggerSteps: 1 });
    store.blocks.create({ label: 'human', value: 'Ten la Huy.', ownerBotId: 'bot-a' });
    pipeline.addConversation([{ role: 'user', text: 'Huy là kỹ sư phần mềm.', at: '2026-11-18T10:00:00.000Z' }]);
    await pipeline.runSleepNow({ reason: 'seed' });
    const saved = store.save(dir);
    assert.equal(saved.ok, true);
    const loaded = loadV25StoreFromDir(dir);
    assert.equal(loaded.ok, true, loaded.error);
    const s2 = loaded.value;
    assert.equal(s2.facts.size, 1);
    assert.equal(s2.blocks.size, 1);
    assert.equal(s2.listJudgeLog({}).length, 1);
    assert.equal(s2.sleep.getTotalPasses(), 1);
    assert.equal(s2.stats().factsActive, 1);
    // Load tu thu muc rong tra store rong.
    const emptyDir = tmpDir();
    const empty = loadV25StoreFromDir(emptyDir);
    assert.equal(empty.ok, true);
    assert.equal(empty.value.facts.size, 0);
    rmSync(emptyDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v25 store: stats + health phan anh dung trang thai', async () => {
  const { store, pipeline } = fresh();
  store.sleep.updateConfig({ triggerSteps: 1 });
  pipeline.addConversation([{ role: 'user', text: 'Huy là kỹ sư phần mềm.', at: '2026-11-18T10:00:00.000Z' }]);
  await pipeline.runSleepNow({ reason: 'seed' });
  const stats = store.stats();
  assert.equal(stats.factsTotal, 1);
  assert.equal(stats.factsActive, 1);
  assert.equal(stats.sleepPasses, 1);
  assert.equal(stats.turnsBuffered, 0);
  assert.equal(stats.judgeByDecision.ADD, 1);
  const health = store.health();
  assert.ok(health.length >= 1);
  assert.ok(health.some((h) => h.code === 'fact-window'));
});

test('v25 store: export/import snapshot JSON round-trip', async () => {
  const { store, pipeline } = fresh();
  store.sleep.updateConfig({ triggerSteps: 1 });
  pipeline.addConversation([{ role: 'user', text: 'Huy là kỹ sư.', at: '2026-11-18T10:00:00.000Z' }]);
  await pipeline.runSleepNow({ reason: 'seed' });
  const json = pipeline.exportSnapshot();
  const imported = V25Pipeline.importSnapshot(json);
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.value.facts.size, 1);
  assert.equal(V25Pipeline.importSnapshot('khong-phai-json').ok, false);
  assert.equal(V25Pipeline.importSnapshot('{"version": 24}').ok, false);
});
