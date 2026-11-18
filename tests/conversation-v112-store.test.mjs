/**
 * Tests cho v1.12 (Đội T2): ConversationLogStore — append-only JSONL
 * + hash chain cho conversation log.
 *
 * - Append điền seq/prevHash/hash đúng, fsync xong mới trả về.
 * - readAll/readRange/tail phân trang đúng, không mất/không trùng.
 * - verify chain ok; sửa 1 byte payload → verify báo đúng seq hỏng.
 * - Dòng cuối bị cắt (crash khi ghi) → corruptTail true, event cũ còn nguyên.
 * - conversationId/branchId không hợp lệ → throw, không ghi file.
 * - File đầy (maxFileBytes) → append throw với thông báo snapshot+compact.
 * - rewrite chỉ nhận chain hợp lệ.
 *
 * Không Electron, không mạng, không key. Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/conversation-v112-store.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ConversationLogStore,
  ConversationStoreError,
  verifyConversationChain,
} from '../packages/core/dist/conversationV112/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-conv-v112-store-'));
}

function makeStore(dir, opts = {}) {
  return new ConversationLogStore({ dataDir: path.join(dir, 'logs'), ...opts });
}

test('store: append điền seq/hash nối chain, readAll trả đúng thứ tự', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  const e1 = store.append('conv-a', 'main', 'conversation.started', { botId: 'bot-1' });
  const e2 = store.append('conv-a', 'main', 'user.message', { text: 'xin chào' });
  const e3 = store.append('conv-a', 'main', 'agent.message', { text: 'chào bạn' });
  assert.equal(e1.seq, 1);
  assert.equal(e1.prevHash, '');
  assert.equal(e2.seq, 2);
  assert.equal(e2.prevHash, e1.hash);
  assert.equal(e3.prevHash, e2.hash);
  const { events, corruptTail } = store.readAll('conv-a', { verify: true });
  assert.equal(events.length, 3);
  assert.equal(corruptTail, false);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(store.count('conv-a'), 3);
  assert.equal(store.exists('conv-a'), true);
  assert.equal(store.exists('conv-chua-co'), false);
});

test('store: readRange/tail phân trang đúng, không mất không trùng', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  store.append('conv-b', 'main', 'conversation.started', { botId: 'bot-1' });
  for (let i = 0; i < 9; i++) {
    store.append('conv-b', 'main', 'user.message', { text: `msg ${i}` });
  }
  assert.equal(store.readRange('conv-b', 1, 5).events.length, 5);
  assert.equal(store.readRange('conv-b', 6).events.length, 5);
  assert.deepEqual(store.readRange('conv-b', 6).events.map((e) => e.seq), [6, 7, 8, 9, 10]);
  assert.deepEqual(store.tail('conv-b', 3).events.map((e) => e.seq), [8, 9, 10]);
  assert.deepEqual(store.tail('conv-b').events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('store: sửa 1 byte payload → verify báo đúng seq hỏng', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  store.append('conv-c', 'main', 'conversation.started', { botId: 'bot-1' });
  store.append('conv-c', 'main', 'user.message', { text: 'nguyên văn' });
  store.append('conv-c', 'main', 'agent.message', { text: 'trả lời' });
  const file = store.filePath('conv-c');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const tampered = JSON.parse(lines[1]);
  tampered.payload.text = 'đã sửa lén';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  store.invalidateCache();
  const check = store.verify('conv-c');
  assert.equal(check.ok, false);
  assert.equal(check.badSeq, 2);
  assert.throws(() => store.readAll('conv-c', { verify: true }), ConversationStoreError);
  // Chain trực tiếp cũng phát hiện.
  const { events } = store.readAll('conv-c');
  assert.equal(verifyConversationChain(events).ok, false);
});

test('store: dòng cuối bị cắt → corruptTail true, event cũ còn nguyên', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  store.append('conv-d', 'main', 'conversation.started', { botId: 'bot-1' });
  store.append('conv-d', 'main', 'user.message', { text: 'còn nguyên' });
  const file = store.filePath('conv-d');
  fs.appendFileSync(file, '{"seq":3,"conversationId":"conv-d","type":"user.mes');
  store.invalidateCache();
  const { events, corruptTail, totalInFile } = store.readAll('conv-d');
  assert.equal(corruptTail, true);
  assert.equal(events.length, 2);
  assert.equal(totalInFile, 2);
});

test('store: id không hợp lệ → throw, không tạo file', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  assert.throws(() => store.append('../escape', 'main', 'user.message', { text: 'x' }), ConversationStoreError);
  assert.throws(() => store.append('conv-e', 'bad/branch', 'user.message', { text: 'x' }), ConversationStoreError);
  assert.throws(() => store.append('', 'main', 'user.message', { text: 'x' }), ConversationStoreError);
  assert.equal(store.exists('../escape'), false);
});

test('store: file đầy → append throw, hướng dẫn snapshot+compact', () => {
  const dir = tmpDir();
  const store = makeStore(dir, { maxFileBytes: 10 });
  store.append('conv-f', 'main', 'conversation.started', { botId: 'bot-1' });
  assert.throws(
    () => store.append('conv-f', 'main', 'user.message', { text: 'thêm nữa' }),
    (err) => err instanceof ConversationStoreError && /snapshot \+ compact/.test(err.message),
  );
});

test('store: rewrite chỉ nhận chain hợp lệ; tail cache nạp lại từ đĩa', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  store.append('conv-g', 'main', 'conversation.started', { botId: 'bot-1' });
  store.append('conv-g', 'main', 'user.message', { text: 'một' });
  const { events } = store.readAll('conv-g');
  const bad = [...events];
  bad[1] = { ...bad[1], payload: { text: 'sửa' } };
  assert.throws(() => store.rewrite('conv-g', 'main', bad), ConversationStoreError);
  store.rewrite('conv-g', 'main', events);
  assert.equal(store.count('conv-g'), 2);
  // Store mới (cache trống) append tiếp nối đúng seq/hash từ đĩa.
  const store2 = makeStore(dir);
  const e3 = store2.append('conv-g', 'main', 'agent.message', { text: 'hai' });
  assert.equal(e3.seq, 3);
  assert.equal(e3.prevHash, events[1].hash);
  assert.equal(store2.verify('conv-g').ok, true);
});

test('store: conversation khác nhau dùng file riêng, không lẫn', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  store.append('conv-h1', 'main', 'conversation.started', { botId: 'bot-1' });
  store.append('conv-h2', 'main', 'conversation.started', { botId: 'bot-2' });
  assert.equal(store.readAll('conv-h1').events[0].payload.botId, 'bot-1');
  assert.equal(store.readAll('conv-h2').events[0].payload.botId, 'bot-2');
});
