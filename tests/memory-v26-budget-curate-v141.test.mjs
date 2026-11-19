/**
 * Tests for memory v26 — budget + summarise + curate (v1.41, Doi T1).
 * packages/core/src/memory/v26/{budget,store}.ts
 *
 * Run after building core (incremental):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v26-budget-curate-v141.test.mjs
 * No network. No model. Pure in-memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V26BudgetManager,
  V26Store,
  estimateTokensV26,
  planCurateV26,
  renderPromptWithBudgetV26,
  summariseV26,
} from '../packages/core/dist/memory/v26/index.js';

const LONG_TEXT = [
  '# Du an Alpha',
  'Muc tieu cua du an Alpha la giao hang dung han cho khach hang lon.',
  'Deadline quan trong nhat la ngay 30 thang 11 nam 2026.',
  'Deadline ngay 30 thang 11 nam 2026 khong duoc tre vi hop dong phat.',
  '- Nguoi phu trach chinh la Lan, lien he qua email lan@example.com.',
  '- Ngan sach du an la 500 trieu, da dung 200 trieu.',
  'Thoi tiet hom nay dep, khong lien quan gi toi du an.',
  'Ghi chu linh tinh ve ca phe sang nay, khong quan trong.',
  '## Tien do',
  'Da xong phan thiet ke, dang lam phan trien khai.',
  'Phan trien khai du kien xong truoc deadline ngay 30 thang 11 nam 2026.',
  'Can hop voi doi backend vao thu tu tuan sau.',
].join('\n');

test('v26 tokens: estimate = ceil(chars/4), rong = 0', () => {
  assert.equal(estimateTokensV26(''), 0);
  assert.equal(estimateTokensV26('abcd'), 1);
  assert.equal(estimateTokensV26('abcde'), 2);
  assert.equal(estimateTokensV26('a'.repeat(400)), 100);
});

test('v26 summarise: khong vuot target, giu heading, giu tu khoa quan trong', () => {
  const res = summariseV26(LONG_TEXT, 60);
  assert.ok(res.summaryTokens <= 60, `summary ${res.summaryTokens} token vuot target 60`);
  assert.ok(res.summaryTokens < res.originalTokens);
  assert.ok(res.summary.includes('# Du an Alpha'), 'mat heading chinh');
  assert.ok(res.summary.includes('## Tien do'), 'mat heading Tien do');
  assert.ok(res.summary.includes('30 thang 11'), 'mat deadline quan trong');
  assert.ok(res.itemsKept < res.itemsTotal);
  assert.ok(res.itemsKept > 0);
  // Thu tu y trong summary = thu tu goc.
  const keptTexts = res.items.filter((i) => i.kept).map((i) => i.text);
  let pos = -1;
  for (const text of keptTexts) {
    const idx = res.summary.indexOf(text);
    assert.ok(idx > pos, 'thu tu y bi dao');
    pos = idx;
  }
});

test('v26 summarise: text rong -> rong; target nho -> giu 1 y roi cat', () => {
  const empty = summariseV26('', 100);
  assert.equal(empty.summary, '');
  assert.equal(empty.itemsTotal, 0);
  const tiny = summariseV26('Mot cau rat dai '.repeat(30), 5);
  assert.ok(tiny.summaryTokens <= 5 || tiny.summary.length > 0);
  assert.equal(tiny.itemsKept, 1);
});

test('v26 budget: status ok/warn/over/unlimited + needsCurate chi khi onExceed=curate', () => {
  const mgr = new V26BudgetManager();
  const set = mgr.setBudget({
    blockId: 'blk1', label: 'b1', maxTokens: 100, warnRatio: 0.8,
    onExceed: 'curate', curateTargetTokens: 50,
  });
  assert.equal(set.ok, true);
  assert.equal(mgr.status('blk1', 'b1', 'x'.repeat(200)).status, 'ok'); // 50 token
  assert.equal(mgr.status('blk1', 'b1', 'x'.repeat(320)).status, 'warn'); // 80 token
  const over = mgr.status('blk1', 'b1', 'x'.repeat(500));
  assert.equal(over.status, 'over');
  assert.equal(over.needsCurate, true);
  assert.equal(over.overByTokens, 25);
  // Khong dat budget -> unlimited.
  const unlimited = mgr.status('blk2', 'b2', 'x'.repeat(100000));
  assert.equal(unlimited.status, 'unlimited');
  assert.equal(unlimited.needsCurate, false);
  // onExceed=warn thi khong needsCurate.
  mgr.setBudget({ blockId: 'blk3', label: 'b3', maxTokens: 10, warnRatio: 0.8, onExceed: 'warn', curateTargetTokens: 5 });
  assert.equal(mgr.status('blk3', 'b3', 'x'.repeat(100)).needsCurate, false);
  // Budget sai thi loi.
  assert.equal(mgr.setBudget({ blockId: 'blk4', label: 'b4', maxTokens: -1, warnRatio: 0.8, onExceed: 'warn', curateTargetTokens: 5 }).ok, false);
  assert.equal(mgr.setBudget({ blockId: 'blk4', label: 'b4', maxTokens: 100, warnRatio: 0.8, onExceed: 'warn', curateTargetTokens: 100 }).ok, false);
});

test('v26 budget: goi y budget theo kind', () => {
  const mgr = new V26BudgetManager();
  assert.equal(mgr.suggestedBudgetForKind('human'), 2000);
  assert.equal(mgr.suggestedBudgetForKind('persona'), 1500);
  assert.equal(mgr.suggestedBudgetForKind('project'), 4000);
  assert.equal(mgr.suggestedBudgetForKind('custom'), 0);
});

test('v26 curate: vuot budget thi tom tat, luu tru version cu + phan bi loai', () => {
  const store = new V26Store();
  const created = store.registry.create({
    label: 'project-big', value: LONG_TEXT, ownerBotId: 'bot-a', kind: 'project',
  });
  assert.equal(created.ok, true);
  const id = created.value.block.id;
  const originalTokens = estimateTokensV26(LONG_TEXT);
  store.budgets.setBudget({
    blockId: id, label: 'project-big', maxTokens: 40, warnRatio: 0.8,
    onExceed: 'curate', curateTargetTokens: 25,
  });
  const cur = store.curateBlock(id, 'bot-a');
  assert.equal(cur.ok, true, cur.ok ? '' : cur.error);
  assert.equal(cur.value.applied, true);
  assert.ok(cur.value.tokensSaved > 0);
  assert.equal(cur.value.fromVersion, 1);
  assert.equal(cur.value.toVersion, 2);
  // Block moi ngan hon, van giu heading + deadline.
  const block = store.registry.blocks.get(id);
  assert.ok(estimateTokensV26(block.value) < originalTokens);
  assert.ok(block.value.includes('# Du an Alpha'));
  // Version cu da luu tru + phan bi loai da luu tru.
  const archived = store.archive.list({ sourceBlockId: id });
  assert.ok(archived.some((e) => e.kind === 'block-version' && e.version === 1));
  assert.ok(archived.some((e) => e.kind === 'curated-out'));
  // Audit co muc curate.
  assert.equal(store.registry.listAudit({ action: 'curate' }).length, 1);
  // Curate lan 2 khi da gon thi khong ghi.
  const again = store.curateBlock(id, 'bot-a');
  assert.equal(again.ok, true);
  assert.equal(again.value.applied, false);
  assert.equal(store.registry.blocks.get(id).version, 2);
});

test('v26 curate: chua dat budget thi loi ro rang; onExceed=warn thi khong tu curate', () => {
  const store = new V26Store();
  const created = store.registry.create({ label: 't1', value: 'x'.repeat(1000), ownerBotId: 'bot-a', kind: 'task' });
  const id = created.value.block.id;
  assert.equal(store.curateBlock(id, 'bot-a').ok, false);
  store.budgets.setBudget({ blockId: id, label: 't1', maxTokens: 10, warnRatio: 0.8, onExceed: 'warn', curateTargetTokens: 5 });
  const res = store.curateBlock(id, 'bot-a');
  assert.equal(res.ok, false);
  assert.match(res.error, /onExceed='warn'/);
});

test('v26 planCurate: bao cao dung (tokensSaved, items, toVersion)', () => {
  const { report, summary, dropped } = planCurateV26('blk', 'b', LONG_TEXT, 3, {
    blockId: 'blk', label: 'b', maxTokens: 40, warnRatio: 0.8, onExceed: 'curate', curateTargetTokens: 25,
  }, 'bot-a', Date.parse('2026-11-18T10:00:00.000Z'));
  assert.equal(report.applied, true);
  assert.equal(report.fromVersion, 3);
  assert.equal(report.toVersion, 4);
  assert.equal(report.tokensSaved, report.originalTokens - report.summaryTokens);
  assert.ok(dropped.length > 0);
  assert.ok(summary.summary.length > 0);
});

test('v26 prompt budget: human/persona uu tien, block thua bi cat ngan thay vi bo', () => {
  const snap = renderPromptWithBudgetV26([
    { label: 'custom-z', kind: 'custom', value: 'z'.repeat(400), updatedAt: '2026-11-18T10:00:00.000Z' },
    { label: 'human', kind: 'human', value: 'h'.repeat(200), updatedAt: '2026-11-18T09:00:00.000Z' },
    { label: 'persona', kind: 'persona', value: 'p'.repeat(200), updatedAt: '2026-11-18T09:00:00.000Z' },
  ], 120);
  // human 50 + persona 50 = 100, con 20 token cho custom-z -> cat ngan.
  assert.equal(snap.blocksRendered, 3);
  assert.equal(snap.blocksSkipped, 0);
  assert.deepEqual(snap.blocksTruncated, ['custom-z']);
  assert.equal(snap.blocks[0].label, 'human');
  assert.equal(snap.blocks[1].label, 'persona');
  assert.ok(snap.text.includes('<memory_blocks>'));
  assert.ok(snap.tokens <= 120);
  // Budget 0 -> khong render block nao.
  const empty = renderPromptWithBudgetV26([
    { label: 'human', kind: 'human', value: 'hello', updatedAt: '2026-11-18T10:00:00.000Z' },
  ], 0);
  assert.equal(empty.blocksRendered, 0);
  assert.equal(empty.text, '');
});
