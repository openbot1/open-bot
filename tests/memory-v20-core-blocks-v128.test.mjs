/**
 * Tests for memory v20 — core blocks (v1.28, Doi T1).
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v20-core-blocks-v128.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  V20CoreBlockStore,
  getBlockVersionContentV20,
  diffBlockVersionsV20,
  listBlockVersionsV20,
  rollbackBlockV20,
  validateBlockLabelV20,
  normalizeBlockIdV20,
  versioningSummaryV20,
} from '../packages/core/dist/memory/v20/index.js';

test('v20 core blocks: create + replace + append + history', () => {
  const store = new V20CoreBlockStore();
  const created = store.createBlock({ label: 'persona', kind: 'persona', value: 'Ban la tro ly.', actor: 'agent-1' });
  assert.equal(created.ok, true);
  assert.equal(created.block.version, 1);
  const replaced = store.applyEdit({ blockId: 'persona', op: 'replace', actor: 'agent-1', actorKind: 'agent', newValue: 'Ban la tro ly tieng Viet.', reason: 'them ngon ngu' });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.block.version, 2);
  const appended = store.applyEdit({ blockId: 'persona', op: 'append', actor: 'agent-1', actorKind: 'agent', text: 'Tra loi ngan gon.', reason: 'them phong cach' });
  assert.equal(appended.ok, true);
  assert.match(appended.block.value, /Tra loi ngan gon/);
  assert.equal(store.getHistory('persona').length, 3);
});

test('v20 core blocks: guards — char limit, version conflict, readonly, empty reason', () => {
  const store = new V20CoreBlockStore();
  store.createBlock({ label: 'facts', kind: 'facts', value: 'x', actor: 'u', charLimit: 10, readonly: true });
  const over = store.applyEdit({ blockId: 'facts', op: 'replace', actor: 'a', actorKind: 'agent', newValue: '01234567890', reason: 'qua dai' });
  assert.equal(over.ok, false);
  assert.equal(over.errorCode, 'block_readonly');
  const conflict = store.applyEdit({ blockId: 'facts', op: 'replace', actor: 'u', actorKind: 'user', newValue: 'y', reason: 'sua', expectedVersion: 99 });
  assert.equal(conflict.errorCode, 'version_conflict');
  const noReason = store.applyEdit({ blockId: 'facts', op: 'replace', actor: 'u', actorKind: 'user', newValue: 'y', reason: '' });
  assert.equal(noReason.errorCode, 'empty_reason');
  assert.equal(validateBlockLabelV20(''), 'nhan block khong duoc de trong');
  assert.equal(normalizeBlockIdV20('My Facts!'), 'my-facts');
});

test('v20 core blocks: rollbackBlock (v21 fix) + versioning list/diff/summary', () => {
  const store = new V20CoreBlockStore();
  store.createBlock({ label: 'facts', kind: 'facts', value: 'Dong 1.\nDong 2.', actor: 'u' });
  store.applyEdit({ blockId: 'facts', op: 'replace', actor: 'u', actorKind: 'user', newValue: 'Dong 1.\nDong 2 sua.', reason: 'sua dong 2' });
  store.applyEdit({ blockId: 'facts', op: 'append', actor: 'u', actorKind: 'user', text: 'Dong 3.', reason: 'them dong 3' });
  // rollbackBlock truc tiep tren store (v21 bo sung — truoc day
  // blockVersioning goi ham nay nhung store chua co -> loi type).
  const rolled = store.rollbackBlock('facts', 1, 'u', 'sai noi dung');
  assert.equal(rolled.ok, true);
  assert.equal(rolled.block.version, 4);
  assert.equal(rolled.block.value, 'Dong 1.\nDong 2.');
  assert.equal(rolled.edit.op, 'rollback');
  assert.equal(store.getHistory('facts').length, 4);
  assert.equal(store.rollbackBlock('facts', 4, 'u', 'ly do').ok, false);
  assert.equal(store.rollbackBlock('facts', 99, 'u', 'ly do').errorCode, 'version_conflict');
  assert.equal(store.rollbackBlock('facts', 1, 'u', 'x').errorCode, 'empty_reason');
  assert.equal(store.rollbackBlock('khong-co', 1, 'u', 'ly do').errorCode, 'block_not_found');
  // rollbackBlockV20 di qua lop versioning, cung tao version moi.
  const viaVersioning = rollbackBlockV20(store, 'facts', 2, 'u', 've v2');
  assert.equal(viaVersioning.ok, true);
  assert.equal(viaVersioning.block.version, 5);
  assert.equal(viaVersioning.block.value, 'Dong 1.\nDong 2 sua.');
  assert.equal(rollbackBlockV20(store, 'facts', 5, 'u', 'ly do').ok, false);
  const versions = listBlockVersionsV20(store, 'facts');
  assert.equal(versions.length, 5);
  assert.equal(versions[0].version, 1);
  assert.equal(getBlockVersionContentV20(store, 'facts', 2).data.value, 'Dong 1.\nDong 2 sua.');
  assert.equal(getBlockVersionContentV20(store, 'facts', 99).ok, false);
  const diff = diffBlockVersionsV20(store, 'facts', 1, 2);
  assert.equal(diff.ok, true);
  assert.equal(diff.data.addedCount, 1);
  assert.equal(diff.data.removedCount, 1);
  assert.equal(diff.data.unchangedCount, 1);
  const summary = versioningSummaryV20(store, 'facts');
  assert.equal(summary.ok, true);
  assert.equal(summary.data.currentVersion, 5);
  assert.equal(summary.data.totalVersions, 5);
  assert.equal(summary.data.lastOp, 'rollback');
});
