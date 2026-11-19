/**
 * Tests for memory v25 — shared memory blocks (v1.40, Doi T1).
 * packages/core/src/memory/v25/sharedBlocks.ts (+ types.ts)
 *
 * Run after building core (memory/v25 only):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v25-blocks-v140.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V25SharedBlockStore,
  blockReadableByV25,
  blockWritableByV25,
} from '../packages/core/dist/memory/v25/index.js';

function freshStore() {
  return new V25SharedBlockStore();
}

function makeBlock(store, over = {}) {
  const res = store.create({
    label: over.label ?? 'human',
    description: over.description ?? 'Ve user',
    value: over.value ?? 'Ten la Huy.',
    ownerBotId: over.ownerBotId ?? 'bot-a',
    readOnly: over.readOnly ?? false,
    ...(over.maxChars !== undefined ? { maxChars: over.maxChars } : {}),
    ...(over.attachBotIds ? { attachBotIds: over.attachBotIds } : {}),
  });
  assert.equal(res.ok, true, res.error);
  return res.value;
}

test('v25 blocks: create tao block v1, owner auto-attach', () => {
  const store = freshStore();
  const block = makeBlock(store);
  assert.equal(block.version, 1);
  assert.equal(block.label, 'human');
  assert.equal(block.ownerBotId, 'bot-a');
  assert.deepEqual(block.attachedBotIds, ['bot-a']);
  assert.equal(block.readOnly, false);
  assert.equal(block.history.length, 1);
  assert.equal(block.history[0].version, 1);
});

test('v25 blocks: create tu choi label sai / owner rong / value rong / trung label', () => {
  const store = freshStore();
  assert.equal(store.create({ label: 'Human Name', value: 'x', ownerBotId: 'a' }).ok, false);
  assert.equal(store.create({ label: 'human!', value: 'x', ownerBotId: 'a' }).ok, false);
  assert.equal(store.create({ label: '-bad', value: 'x', ownerBotId: 'a' }).ok, false);
  // Label hoa duoc chuan hoa ve chu thuong (case-insensitive).
  assert.equal(store.create({ label: 'UPPER', value: 'x', ownerBotId: 'a' }).ok, true);
  assert.equal(store.getByLabel('upper', { userId: '', agentId: '', runId: '', appId: '' }).label, 'upper');
  assert.equal(store.create({ label: 'human', value: 'x', ownerBotId: '' }).ok, false);
  assert.equal(store.create({ label: 'human', value: '', ownerBotId: 'a' }).ok, false);
  makeBlock(store);
  assert.equal(store.create({ label: 'human', value: 'y', ownerBotId: 'b' }).ok, false);
  // Label khac nhau thi duoc.
  assert.equal(store.create({ label: 'persona', value: 'y', ownerBotId: 'b' }).ok, true);
});

test('v25 blocks: create tu choi value vuot maxChars', () => {
  const store = freshStore();
  assert.equal(
    store.create({ label: 'human', value: '1234567890', ownerBotId: 'a', maxChars: 5 }).ok,
    false,
  );
});

test('v25 blocks: attach/detach; owner khong duoc tu detach', () => {
  const store = freshStore();
  const block = makeBlock(store);
  assert.equal(store.attach(block.id, 'bot-b').ok, true);
  assert.deepEqual(store.get(block.id).attachedBotIds, ['bot-a', 'bot-b']);
  // Attach lai khong trung lap.
  assert.equal(store.attach(block.id, 'bot-b').ok, true);
  assert.equal(store.get(block.id).attachedBotIds.length, 2);
  assert.equal(store.detach(block.id, 'bot-b').ok, true);
  assert.deepEqual(store.get(block.id).attachedBotIds, ['bot-a']);
  // Detach bot chua attach loi.
  assert.equal(store.detach(block.id, 'bot-b').ok, false);
  // Owner tu detach bi chan.
  assert.equal(store.detach(block.id, 'bot-a').ok, false);
  // Attach block khong co loi.
  assert.equal(store.attach('blk_khong-co', 'bot-b').ok, false);
});

test('v25 blocks: transferOwnership — chi owner cu, owner moi auto-attach', () => {
  const store = freshStore();
  const block = makeBlock(store);
  assert.equal(store.transferOwnership(block.id, 'bot-b', 'bot-c').ok, false);
  const res = store.transferOwnership(block.id, 'bot-a', 'bot-c');
  assert.equal(res.ok, true);
  assert.equal(res.value.ownerBotId, 'bot-c');
  assert.ok(res.value.attachedBotIds.includes('bot-c'));
  // Owner cu detach duoc sau khi chuyen.
  assert.equal(store.detach(block.id, 'bot-a').ok, true);
});

test('v25 blocks: read-only — bot khac chi doc, owner van ghi duoc', () => {
  const store = freshStore();
  const block = makeBlock(store, { readOnly: true, attachBotIds: ['bot-b'] });
  assert.equal(blockWritableByV25(block, 'bot-a'), true);
  assert.equal(blockWritableByV25(block, 'bot-b'), false);
  assert.equal(blockReadableByV25(block, 'bot-b'), true);
  assert.equal(blockReadableByV25(block, 'bot-c'), false);
  // Bot-b ghi bi chan.
  const denied = store.write(block.id, 'gia tri moi', 'bot-b', { reason: 'test' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /read-only/);
  // Owner ghi duoc.
  const allowed = store.write(block.id, 'gia tri moi', 'bot-a', { reason: 'test' });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.value.version, 2);
});

test('v25 blocks: setReadOnly chi owner; bot chua attach khong ghi duoc', () => {
  const store = freshStore();
  const block = makeBlock(store, { attachBotIds: ['bot-b'] });
  assert.equal(store.setReadOnly(block.id, true, 'bot-b').ok, false);
  assert.equal(store.setReadOnly(block.id, true, 'bot-a').ok, true);
  assert.equal(store.get(block.id).readOnly, true);
  assert.equal(store.setReadOnly(block.id, false, 'bot-a').ok, true);
  // Bot chua attach ghi bi chan (khong read-only).
  assert.equal(store.write(block.id, 'x', 'bot-c').ok, false);
  // Bot attach ghi duoc khi khong read-only.
  assert.equal(store.write(block.id, 'x', 'bot-b').ok, true);
});

test('v25 blocks: write tang version + lich su; expectedVersion chong ghi de', () => {
  const store = freshStore();
  const block = makeBlock(store);
  const w1 = store.write(block.id, 'v2', 'bot-a', { reason: 'cap nhat' });
  assert.equal(w1.ok, true);
  assert.equal(w1.value.version, 2);
  assert.equal(w1.value.history.length, 2);
  assert.equal(w1.value.history[1].reason, 'cap nhat');
  // expectedVersion sai bi chan.
  assert.equal(store.write(block.id, 'v3', 'bot-a', { expectedVersion: 1 }).ok, false);
  assert.equal(store.write(block.id, 'v3', 'bot-a', { expectedVersion: 2 }).ok, true);
  assert.equal(store.get(block.id).version, 3);
  // Vuot maxChars bi chan.
  const limited = makeBlock(store, { label: 'short', value: 'v1', maxChars: 5 });
  assert.equal(store.write(limited.id, '123456', 'bot-a').ok, false);
});

test('v25 blocks: revert tao version moi mang gia tri cu, lich su khong mat', () => {
  const store = freshStore();
  const block = makeBlock(store, { value: 'v1' });
  store.write(block.id, 'v2', 'bot-a');
  store.write(block.id, 'v3', 'bot-a');
  const reverted = store.revert(block.id, 1, 'bot-a', { reason: 'sai, quay lai' });
  assert.equal(reverted.ok, true);
  assert.equal(reverted.value.value, 'v1');
  assert.equal(reverted.value.version, 4);
  assert.equal(reverted.value.history.length, 4);
  // Revert ve version khong co loi; revert ve version hien tai khong doi.
  assert.equal(store.revert(block.id, 99, 'bot-a').ok, false);
  assert.equal(store.revert(block.id, 4, 'bot-a').value.version, 4);
});

test('v25 blocks: readForBot chi owner + attached; list loc theo bot/readOnly', () => {
  const store = freshStore();
  const block = makeBlock(store, { readOnly: true, attachBotIds: ['bot-b'] });
  makeBlock(store, { label: 'persona', ownerBotId: 'bot-b' });
  assert.equal(store.readForBot(block.id, 'bot-b').ok, true);
  assert.equal(store.readForBot(block.id, 'bot-c').ok, false);
  assert.equal(store.readForBot('blk_khong-co', 'bot-a').ok, false);
  assert.equal(store.list({ botId: 'bot-a' }).length, 1);
  assert.equal(store.list({ botId: 'bot-b' }).length, 2);
  assert.equal(store.list({ readOnly: true }).length, 1);
  assert.equal(store.list({ readOnly: false }).length, 1);
  assert.equal(store.getByLabel('human', { userId: '', agentId: '', runId: '', appId: '' }).id, block.id);
});

test('v25 blocks: history + setDescription chi owner', () => {
  const store = freshStore();
  const block = makeBlock(store);
  store.write(block.id, 'v2', 'bot-a');
  const history = store.history(block.id);
  assert.equal(history.ok, true);
  assert.equal(history.value.length, 2);
  assert.equal(store.history('blk_khong-co').ok, false);
  assert.equal(store.setDescription(block.id, 'mo ta moi', 'bot-b').ok, false);
  assert.equal(store.setDescription(block.id, 'mo ta moi', 'bot-a').ok, true);
  assert.equal(store.get(block.id).description, 'mo ta moi');
});

test('v25 blocks: renderForPrompt chi render block bot duoc doc, escape XML', () => {
  const store = freshStore();
  const ro = makeBlock(store, { label: 'human', readOnly: true, attachBotIds: ['bot-b'] });
  const open = makeBlock(store, { label: 'notes', value: 'a <b> & "c"', ownerBotId: 'bot-a', attachBotIds: ['bot-b'] });
  const rendered = store.renderForPrompt([ro, open], 'bot-b');
  assert.ok(rendered.includes('<memory_blocks>'));
  assert.ok(rendered.includes('label="human"'));
  assert.ok(rendered.includes('read_only="true"'));
  assert.ok(rendered.includes('&lt;b&gt;'));
  assert.ok(rendered.includes('&amp;'));
  assert.ok(rendered.includes('</memory_blocks>'));
  // Bot khong attach thi render rong.
  assert.equal(store.renderForPrompt([ro, open], 'bot-z'), '');
  void ro;
  void open;
});

test('v25 blocks: toJSON/fromJSON giu nguyen block + lich su', () => {
  const store = freshStore();
  const block = makeBlock(store, { readOnly: true });
  store.write(block.id, 'v2', 'bot-a');
  const restored = V25SharedBlockStore.fromJSON(store.toJSON());
  assert.equal(restored.size, 1);
  const got = restored.get(block.id);
  assert.equal(got.version, 2);
  assert.equal(got.readOnly, true);
  assert.equal(got.history.length, 2);
  assert.deepEqual(V25SharedBlockStore.fromJSON(null).size, 0);
});
