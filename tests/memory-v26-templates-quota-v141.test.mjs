/**
 * Tests for memory v26 — templates + quota + panel view + store
 * persistence (v1.41, Doi T1).
 * packages/core/src/memory/v26/{templates,quota,panel,store}.ts
 *
 * Run after building core (incremental):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v26-templates-quota-v141.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  V26Pipeline,
  V26QuotaManager,
  V26Store,
  V26TemplateRegistry,
  buildMemoryV26PanelView,
  checkRequiredFieldsV26,
  demoMemoryV26PanelView,
  loadV26StoreFromDir,
} from '../packages/core/dist/memory/v26/index.js';

test('v26 templates: 4 built-in (human/persona/task/project) + khoi tao + kiem tra truong', () => {
  const reg = new V26TemplateRegistry();
  assert.equal(reg.size, 4);
  const human = reg.get('human');
  assert.equal(human.kind, 'human');
  assert.deepEqual(human.requiredFields, ['Ten', 'Muc tieu']);
  assert.ok(human.defaultValue.includes('## Ten'));
  assert.ok(human.defaultValue.includes('## Muc tieu'));
  const persona = reg.get('persona');
  assert.ok(persona.defaultValue.includes('## Vai tro'));
  const project = reg.get('project');
  assert.ok(project.defaultValue.includes('## Tien do'));
  assert.ok(project.defaultValue.includes('## Quyet dinh'));
  // Khoi tao: placeholder duoc thay, truong bat buoc du.
  const inst = reg.instantiate('human', { Ten: 'Huy' });
  assert.equal(inst.ok, true);
  assert.ok(inst.value.value.includes('Huy'));
  assert.deepEqual(inst.value.missingRequired, []);
  // Value thieu heading bat buoc thi bao thieu.
  assert.deepEqual(checkRequiredFieldsV26('## Ten\nHuy', ['Ten', 'Muc tieu']), ['Muc tieu']);
  assert.deepEqual(checkRequiredFieldsV26('## Ten\nHuy\n## Muc tieu\nX', ['Ten', 'Muc tieu']), []);
});

test('v26 templates: dang ky tu tao + khong ghi de built-in + khong xoa built-in', () => {
  const reg = new V26TemplateRegistry();
  const created = reg.register({
    id: 'onboarding', kind: 'task', name: 'Onboarding',
    description: 'Mau onboarding', requiredFields: ['Muc tieu'],
    defaultValue: '## Muc tieu\n{{Muc tieu}}',
    suggestedBudgetTokens: 500,
  });
  assert.equal(created.ok, true);
  assert.equal(created.value.builtin, false);
  assert.equal(reg.size, 5);
  const inst = reg.instantiate('onboarding', { 'Muc tieu': 'Lam quen he thong' });
  assert.equal(inst.ok, true);
  assert.ok(inst.value.value.includes('Lam quen he thong'));
  // Dang ky trung id -> loi; ghi de built-in -> loi.
  assert.equal(reg.register({ id: 'onboarding', kind: 'task', name: 'X', defaultValue: '## Muc tieu\nx' }).ok, false);
  assert.equal(reg.register({ id: 'human', kind: 'human', name: 'X', defaultValue: '## Ten\nx' }).ok, false);
  // Xoa tu tao duoc, xoa built-in khong duoc.
  assert.equal(reg.remove('onboarding').ok, true);
  assert.equal(reg.size, 4);
  assert.equal(reg.remove('human').ok, false);
  assert.equal(reg.get('unknown-template'), undefined);
});

test('v26 pipeline: createBlockFromTemplate dat budget goi y + bao truong thieu', () => {
  const pipeline = new V26Pipeline();
  const res = pipeline.createBlockFromTemplate('persona', {
    label: 'persona-main', ownerBotId: 'bot-a',
  });
  assert.equal(res.ok, true, res.ok ? '' : res.error);
  assert.equal(res.value.entry.kind, 'persona');
  assert.equal(res.value.entry.templateId, 'persona');
  assert.deepEqual(res.value.missingRequired, []);
  assert.equal(res.value.block.value.includes('## Vai tro'), true);
  // Budget goi y cua template da dat.
  const budget = pipeline.store.budgets.getBudget(res.value.block.id);
  assert.equal(budget.maxTokens, 1500);
  // Template khong co thi loi.
  assert.equal(pipeline.createBlockFromTemplate('khong-co', { label: 'x', ownerBotId: 'bot-a' }).ok, false);
});

test('v26 quota: mac dinh + usage + chan tao/attach/ghi khi vuot', () => {
  const mgr = new V26QuotaManager();
  assert.deepEqual(mgr.getQuota(), {
    maxOwnedBlocks: 50, maxAttachedBlocks: 200, maxOwnedTokens: 50000, maxOwnedChars: 200000,
  });
  const blocks = [
    { id: 'b1', ownerBotId: 'bot-a', attachedBotIds: ['bot-a', 'bot-b'], value: 'x'.repeat(400) },
    { id: 'b2', ownerBotId: 'bot-a', attachedBotIds: ['bot-a'], value: 'y'.repeat(800) },
    { id: 'b3', ownerBotId: 'bot-b', attachedBotIds: ['bot-b', 'bot-a'], value: 'z'.repeat(40) },
  ];
  const usage = mgr.usage('bot-a', blocks);
  assert.equal(usage.ownedBlocks, 2);
  assert.equal(usage.attachedBlocks, 3);
  assert.equal(usage.ownedTokens, 300); // (400+800)/4
  assert.equal(usage.ownedChars, 1200);
  assert.deepEqual(usage.over, []);
  // Dat quota nho lai: tao them bi chan, ghi lam vuot token bi chan.
  mgr.setQuota({ maxOwnedBlocks: 2, maxOwnedTokens: 300 });
  assert.equal(mgr.checkCreate('bot-a', blocks).ok, false);
  assert.match(mgr.checkCreate('bot-a', blocks).error, /khong tao them/);
  assert.equal(mgr.checkWrite('bot-a', blocks, 'b1', 'x'.repeat(800)).ok, false);
  assert.match(mgr.checkWrite('bot-a', blocks, 'b1', 'x'.repeat(800)).error, /vuot quota token/);
  // Ghi vua trong quota thi duoc.
  assert.equal(mgr.checkWrite('bot-a', blocks, 'b1', 'x'.repeat(400)).ok, true);
  // Attach vuot gioi han bi chan.
  mgr.setQuota({ maxAttachedBlocks: 3 });
  assert.equal(mgr.checkAttach('bot-a', blocks).ok, false);
  // Set quota sai thi loi, quota cu giu nguyen.
  assert.equal(mgr.setQuota({ maxOwnedBlocks: 0 }).ok, false);
  assert.equal(mgr.getQuota().maxOwnedBlocks, 2);
});

test('v26 store: stats + health + export/import block (doi label khi trung)', () => {
  const store = new V26Store();
  const c1 = store.registry.create({ label: 'human', value: '## Ten\nHuy', ownerBotId: 'bot-a', kind: 'human' });
  assert.equal(c1.ok, true);
  store.budgets.setBudget({ blockId: c1.value.block.id, label: 'human', maxTokens: 10, warnRatio: 0.8, onExceed: 'warn', curateTargetTokens: 5 });
  const stats = store.stats();
  assert.equal(stats.blocksTotal, 1);
  assert.equal(stats.blocksByKind.human, 1);
  assert.equal(stats.templatesTotal, 4);
  assert.equal(stats.templatesBuiltin, 4);
  // Health: block vuot budget (value ~10 ky tu = 3 token? tinh lai: '## Ten\nHuy' = 10 ky tu -> 3 token < 10) -> khong over.
  // Dat budget 2 token de vuot that.
  store.budgets.setBudget({ blockId: c1.value.block.id, label: 'human', maxTokens: 2, warnRatio: 0.8, onExceed: 'warn', curateTargetTokens: 1 });
  const health = store.health();
  assert.ok(health.some((h) => h.code === 'over-budget'));
  // Export + import (label trung -> doi ten).
  const exported = store.exportBlock(c1.value.block.id);
  assert.equal(exported.ok, true);
  assert.match(exported.value, /open-bot-memory-v26-block/);
  const imported = store.importBlock(exported.value, 'bot-b');
  assert.equal(imported.ok, true, imported.ok ? '' : imported.error);
  assert.equal(imported.value.label, 'human-import-1');
  assert.equal(imported.value.ownerBotId, 'bot-b');
  assert.equal(store.stats().blocksTotal, 2);
  // Import JSON hong / sai format thi loi.
  assert.equal(store.importBlock('khong phai json', 'bot-b').ok, false);
  assert.equal(store.importBlock('{"format":"sai"}', 'bot-b').ok, false);
});

test('v26 store: save/load round-trip giu nguyen block + registry + audit + archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openbot-v26-store-'));
  try {
    const store = new V26Store();
    const created = store.registry.create({ label: 'human', value: '## Ten\nHuy', ownerBotId: 'bot-a', kind: 'human', tokenBudget: 100 });
    assert.equal(created.ok, true);
    store.registry.write(created.value.block.id, '## Ten\nHuy Nguyen', 'bot-a');
    store.archive.add({ kind: 'note', content: 'ghi chu ngay 18', at: '2026-11-18T10:00:00.000Z' });
    const saved = store.saveToDir(dir);
    assert.equal(saved.ok, true);
    const loaded = loadV26StoreFromDir(dir);
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.error);
    const s2 = loaded.value;
    assert.equal(s2.stats().blocksTotal, 1);
    assert.equal(s2.stats().archivedTotal, 1);
    assert.equal(s2.registry.blocks.get(created.value.block.id).value, '## Ten\nHuy Nguyen');
    assert.equal(s2.registry.blocks.get(created.value.block.id).version, 2);
    assert.equal(s2.registry.getEntry(created.value.block.id).kind, 'human');
    assert.equal(s2.registry.auditForBlock(created.value.block.id).length, 2);
    // Load dir rong -> store rong, khong loi.
    const emptyDir = mkdtempSync(join(tmpdir(), 'openbot-v26-empty-'));
    try {
      const empty = loadV26StoreFromDir(emptyDir);
      assert.equal(empty.ok, true);
      assert.equal(empty.value.stats().blocksTotal, 0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v26 panel: build view ton trong quyen doc + canh bao vuot budget/xung dot', () => {
  const store = new V26Store();
  const human = store.registry.create({ label: 'human', value: '## Ten\nHuy', ownerBotId: 'bot-a', kind: 'human', attachBotIds: ['bot-b'] });
  const secret = store.registry.create({ label: 'secret', value: 'bi mat', ownerBotId: 'bot-a', kind: 'custom' });
  assert.equal(human.ok, true);
  assert.equal(secret.ok, true);
  store.budgets.setBudget({ blockId: secret.value.block.id, label: 'secret', maxTokens: 2, warnRatio: 0.8, onExceed: 'warn', curateTargetTokens: 1 });
  const viewB = buildMemoryV26PanelView(store, 'bot-b');
  assert.equal(viewB.blocksTotal, 2);
  assert.equal(viewB.rows.length, 1);
  assert.equal(viewB.rows[0].label, 'human');
  assert.equal(viewB.hiddenBlocks, 1);
  assert.ok(viewB.summary.includes('2 block'));
  // Admin (botId rong) thay tat ca + thay canh bao vuot budget.
  const viewAdmin = buildMemoryV26PanelView(store, '');
  assert.equal(viewAdmin.rows.length, 2);
  assert.equal(viewAdmin.blocksOverBudget, 1);
  assert.ok(viewAdmin.alerts.some((a) => a.includes('secret')));
  assert.ok(viewAdmin.quotaSummary.includes('admin'));
  // Demo view dung dinh dang.
  const demo = demoMemoryV26PanelView();
  assert.equal(demo.rows.length, 2);
  assert.equal(demo.openConflicts.length, 1);
  assert.ok(demo.alerts.length >= 1);
});
