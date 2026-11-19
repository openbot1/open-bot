/**
 * Tests for memory v26 — registry + audit + conflicts (v1.41, Doi T1).
 * packages/core/src/memory/v26/{registry,conflicts}.ts
 *
 * Run after building core (incremental):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v26-registry-v141.test.mjs
 * No network. No model. Pure in-memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V26BlockRegistry,
  V26ConflictStore,
  mergeLinesV26,
} from '../packages/core/dist/memory/v26/index.js';

function makeRegistry() {
  return new V26BlockRegistry();
}

test('v26 registry: create block + entry co kind/owner/attached/budget', () => {
  const reg = makeRegistry();
  const res = reg.create({
    label: 'human',
    description: 'Ve user',
    value: '## Ten\nHuy',
    ownerBotId: 'bot-a',
    kind: 'human',
    tokenBudget: 2000,
    attachBotIds: ['bot-b'],
  });
  assert.equal(res.ok, true, res.ok ? '' : res.error);
  assert.equal(res.value.block.label, 'human');
  assert.equal(res.value.block.version, 1);
  assert.equal(res.value.entry.kind, 'human');
  assert.equal(res.value.entry.ownerBotId, 'bot-a');
  assert.deepEqual([...res.value.entry.attachedBotIds].sort(), ['bot-a', 'bot-b']);
  assert.equal(res.value.entry.tokenBudget, 2000);
  assert.equal(res.value.audit.action, 'created');
  assert.equal(reg.size, 1);
});

test('v26 registry: tao block human thu 2 trong cung scope thi canh bao (khong chan)', () => {
  const reg = makeRegistry();
  reg.create({ label: 'human', value: '## Ten\nHuy', ownerBotId: 'bot-a', kind: 'human' });
  const second = reg.createWithWarnings({ label: 'human-2', value: '## Ten\nKhac', ownerBotId: 'bot-a', kind: 'human' });
  assert.equal(second.ok, true);
  assert.equal(second.value.duplicateStandardKind, true);
  assert.match(second.value.warning, /Da co 1 block "human"/);
});

test('v26 registry: 1 bot cap nhat thi bot khac doc thay ngay (shared state)', () => {
  const reg = makeRegistry();
  const created = reg.create({
    label: 'project-alpha', value: '## Tong quan\nBan dau', ownerBotId: 'bot-a',
    kind: 'project', attachBotIds: ['bot-b'],
  });
  assert.equal(created.ok, true);
  const id = created.value.block.id;
  const written = reg.write(id, '## Tong quan\nDa cap nhat boi bot-a', 'bot-a');
  assert.equal(written.ok, true);
  assert.equal(written.value.block.version, 2);
  // bot-b doc lai thay ngay gia tri moi, khong can sync.
  const read = reg.readForBot(id, 'bot-b');
  assert.equal(read.ok, true);
  assert.equal(read.value.value, '## Tong quan\nDa cap nhat boi bot-a');
  assert.equal(read.value.version, 2);
  // Bot chua attach thi khong doc duoc.
  const denied = reg.readForBot(id, 'bot-z');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /chua attach/);
});

test('v26 registry: attach/detach + owner khong duoc tu detach', () => {
  const reg = makeRegistry();
  const created = reg.create({ label: 'task-1', value: 'v1', ownerBotId: 'bot-a', kind: 'task' });
  const id = created.value.block.id;
  const attached = reg.attach(id, 'bot-c', 'bot-a');
  assert.equal(attached.ok, true);
  assert.ok(attached.value.attachedBotIds.includes('bot-c'));
  const ownerDetach = reg.detach(id, 'bot-a', 'bot-a');
  assert.equal(ownerDetach.ok, false);
  assert.match(ownerDetach.error, /Owner khong duoc detach/);
  const detached = reg.detach(id, 'bot-c', 'bot-a');
  assert.equal(detached.ok, true);
  assert.ok(!detached.value.attachedBotIds.includes('bot-c'));
});

test('v26 registry: read-only — bot khac owner chi doc, owner van ghi duoc', () => {
  const reg = makeRegistry();
  const created = reg.create({
    label: 'persona', value: '## Vai tro\nTro ly', ownerBotId: 'bot-a',
    kind: 'persona', attachBotIds: ['bot-b'],
  });
  const id = created.value.block.id;
  const ro = reg.setReadOnly(id, true, 'bot-a');
  assert.equal(ro.ok, true);
  const denied = reg.write(id, '## Vai tro\nDoi', 'bot-b');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /read-only/);
  const ownerWrite = reg.write(id, '## Vai tro\nOwner doi', 'bot-a');
  assert.equal(ownerWrite.ok, true);
  assert.equal(ownerWrite.value.block.version, 2);
});

test('v26 audit: moi lan doi deu ghi ai/khi nao/version cu-moi/noi dung cu-moi', () => {
  const reg = makeRegistry();
  // Pin "today" explicitly: create() defaults to Date.now(), so without
  // nowMs the 'created' audit entry lands on the run date, not 2026-11-18.
  const created = reg.create({ label: 'task-9', value: 'ban dau', ownerBotId: 'bot-a', kind: 'task' }, { nowMs: Date.parse('2026-11-18T09:59:00.000Z') });
  const id = created.value.block.id;
  reg.write(id, 'ban sau', 'bot-a', { reason: 'cap nhat tien do', nowMs: Date.parse('2026-11-18T10:00:00.000Z') });
  reg.attach(id, 'bot-b', 'bot-a', { nowMs: Date.parse('2026-11-18T10:01:00.000Z') });
  const audit = reg.auditForBlock(id);
  assert.equal(audit.length, 3);
  // Moi nhat truoc: attach, write, created.
  assert.equal(audit[0].action, 'attach');
  assert.equal(audit[1].action, 'write');
  assert.equal(audit[1].by, 'bot-a');
  assert.equal(audit[1].fromVersion, 1);
  assert.equal(audit[1].toVersion, 2);
  assert.equal(audit[1].oldValue, 'ban dau');
  assert.equal(audit[1].newValue, 'ban sau');
  assert.equal(audit[1].reason, 'cap nhat tien do');
  assert.equal(audit[2].action, 'created');
  // Audit append-only: list theo bot + theo ngay.
  assert.equal(reg.listAudit({ by: 'bot-a' }).length, 3);
  assert.equal(reg.listAudit({ fromDay: '2026-11-18', toDay: '2026-11-18' }).length, 3);
  assert.equal(reg.listAudit({ fromDay: '2026-11-19' }).length, 0);
});

test('v26 conflict: 2 agent sua cung block — ghi sau bi tu choi + tao conflict day du 3 phia', () => {
  const reg = makeRegistry();
  const created = reg.create({
    label: 'project-x', value: 'dong goc', ownerBotId: 'bot-a',
    kind: 'project', attachBotIds: ['bot-b'],
  });
  const id = created.value.block.id;
  // bot-a ghi truoc (doc v1, ghi len v2).
  const first = reg.write(id, 'dong cua bot-a', 'bot-a', { expectedVersion: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.value.block.version, 2);
  // bot-b van dua tren v1 -> bi tu choi, tao conflict.
  const second = reg.write(id, 'dong cua bot-b', 'bot-b', {
    expectedVersion: 1,
    baseValue: 'dong goc',
  });
  assert.equal(second.ok, false);
  assert.match(second.error, /CONFLICT:cf_/);
  const conflictId = second.error.split(':')[1];
  const conflict = reg.conflicts.get(conflictId);
  assert.ok(conflict);
  assert.equal(conflict.status, 'open');
  assert.equal(conflict.baseVersion, 1);
  assert.equal(conflict.currentVersion, 2);
  assert.equal(conflict.baseValue, 'dong goc');
  assert.equal(conflict.currentValue, 'dong cua bot-a');
  assert.equal(conflict.incomingValue, 'dong cua bot-b');
  assert.equal(conflict.by, 'bot-b');
  assert.equal(conflict.currentBy, 'bot-a');
  // Block khong doi (van gia tri cua bot-a).
  assert.equal(reg.blocks.get(id).value, 'dong cua bot-a');
  // Registry danh dau xung dot mo.
  const entry = reg.getEntry(id);
  assert.equal(entry.hasOpenConflict, true);
  assert.equal(entry.openConflictId, conflictId);
  // Audit co muc 'conflict'.
  assert.equal(reg.listAudit({ action: 'conflict' }).length, 1);
});

test('v26 conflict store: resolve keep-incoming + merge-lines + manual + reopen', () => {
  const store = new V26ConflictStore();
  const base = 'dong mot\ndong hai\ndong ba';
  const current = 'dong mot\ndong hai sua\ndong ba';
  const incoming = 'dong mot\ndong hai\ndong ba\nDong bon moi';
  const c1 = store.record({
    blockId: 'blk1', label: 'b1', baseVersion: 1, currentVersion: 2,
    baseValue: base, currentValue: current, incomingValue: incoming,
    by: 'bot-b', currentBy: 'bot-a',
  });
  const merged = store.resolve(c1.id, 'merge-lines', 'bot-a', { note: 'hop nhat' });
  assert.equal(merged.ok, true);
  assert.ok(merged.value.finalValue.includes('dong hai sua'));
  assert.ok(merged.value.finalValue.includes('Dong bon moi'));
  assert.equal(merged.value.conflict.status, 'resolved');
  assert.equal(merged.value.conflict.resolution, 'merge-lines');
  assert.equal(store.listOpen().length, 0);
  // Resolve lai thi loi (da resolve).
  assert.equal(store.resolve(c1.id, 'keep-current', 'bot-a').ok, false);
  // Reopen roi resolve keep-current.
  const reopened = store.reopen(c1.id, 'bot-a', { note: 'lam lai' });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.value.status, 'open');
  const kept = store.resolve(c1.id, 'keep-current', 'bot-a');
  assert.equal(kept.ok, true);
  assert.equal(kept.value.finalValue, current);
  // Manual can manualValue.
  const c2 = store.record({
    blockId: 'blk1', label: 'b1', baseVersion: 2, currentVersion: 3,
    baseValue: current, currentValue: `${current}\nthem`, incomingValue: 'khac',
    by: 'bot-b', currentBy: 'bot-a',
  });
  assert.equal(store.resolve(c2.id, 'manual', 'bot-a').ok, false);
  const manual = store.resolve(c2.id, 'manual', 'bot-a', { manualValue: 'gia tri tay' });
  assert.equal(manual.ok, true);
  assert.equal(manual.value.finalValue, 'gia tri tay');
  assert.deepEqual(store.countByStatus(), { open: 0, resolved: 2, total: 2 });
});

test('v26 mergeLines: dong chung giu 1 lan, dong rieng giu het, thu tu goc duoc bao toan', () => {
  const res = mergeLinesV26(
    'a\nb\nc',
    'a\nb2\nc\nd',
    'a\nb\nc\ne',
  );
  assert.ok(res.merged.includes('a'));
  assert.ok(res.merged.includes('b2'));
  assert.ok(res.merged.includes('d'));
  assert.ok(res.merged.includes('e'));
  assert.equal(res.common, 2); // a, c
  assert.equal(res.onlyCurrent, 2); // b2, d
  assert.equal(res.onlyIncoming, 2); // b (incoming giu dong goc), e
  // 'b' la dong goc ma current sua thanh 'b2' con incoming giu
  // nguyen — khong phai xung dot that (chi 1 ben sua), union
  // merge giu ca 2, khong danh dau.
  assert.equal(res.conflicts, 0);
  // Dong lap lai khong xuat hien 2 lan.
  const lines = res.merged.split('\n');
  assert.equal(new Set(lines).size, lines.length);
});

test('v26 mergeLines: 2 ben sua cung 1 dong goc khac nhau thi danh dau xung dot', () => {
  const res = mergeLinesV26(
    'dong mot\ndong hai\ndong ba',
    'dong mot\ndong hai sua\ndong ba',
    'dong mot\ndong hai moi\ndong ba',
  );
  assert.equal(res.conflicts, 1);
  assert.equal(res.conflictLines.length, 1);
  assert.match(res.conflictLines[0], /<< incoming/);
  assert.ok(res.merged.includes('dong hai sua'));
  assert.ok(res.merged.includes('dong hai moi'));
});

test('v26 registry: revert tao version moi, lich su khong mat', () => {
  const reg = makeRegistry();
  const created = reg.create({ label: 'note-1', value: 'v1', ownerBotId: 'bot-a', kind: 'custom' });
  const id = created.value.block.id;
  reg.write(id, 'v2', 'bot-a');
  reg.write(id, 'v3', 'bot-a');
  const reverted = reg.revert(id, 1, 'bot-a');
  assert.equal(reverted.ok, true);
  assert.equal(reverted.value.block.value, 'v1');
  assert.equal(reverted.value.block.version, 4);
  assert.equal(reverted.value.audit.action, 'revert');
  assert.equal(reg.blocks.history(id).value.length, 4);
});
