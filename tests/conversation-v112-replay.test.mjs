/**
 * Tests cho v1.12 (Đội T2): replay + session + branch + snapshot +
 * compact + export/import của conversation log.
 *
 * - Fold: user/agent message, tool call pending → done, codeact
 *   pending → done, skill nạp (không trùng), branch, ended.
 * - Replay hai lần cho cùng state (determinism).
 * - Session: record message/tool/skill, redact secret trong log,
 *   cắt text dài, reopen từ đĩa cho đúng state.
 * - Branch: con sao chép tới fromSeq, state con đúng, cha ghi
 *   branched, sửa con không ảnh hưởng cha.
 * - Snapshot: file + hash đúng; restore = snapshot + fold tiếp.
 * - Compact: log ngắn lại, verify chain vẫn ok, replay từ snapshot
 *   cho đủ message (log-only fold thì thiếu — hành vi có chủ ý).
 * - Export/import: file JSONL đúng chain; import vào id mới ok;
 *   file bị sửa → import từ chối; import vào id đã có → từ chối.
 *
 * Không Electron, không mạng, không key. Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/conversation-v112-replay.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ConversationLogStore,
  ConversationV112Session,
  branchConversation,
  compactConversation,
  createConversationSnapshot,
  diffConversationStates,
  exportConversationToFile,
  foldConversationEvents,
  importConversationFromFile,
  listConversationBranches,
  parseConversationExportJsonl,
  readConversationSnapshot,
  replayDeterministicallyV112,
  replayFromSnapshot,
  stateAtSeq,
  summarizeConversationState,
  timeTravelConversation,
} from '../packages/core/dist/conversationV112/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-conv-v112-replay-'));
}

function makeStore(dir) {
  return new ConversationLogStore({ dataDir: path.join(dir, 'logs') });
}

function seedConversation(store, id = 'conv-main') {
  const session = ConversationV112Session.open(store, { botId: 'bot-1', conversationId: id, title: 'test' });
  session.recordUserMessage('xin chào bot');
  session.recordAgentMessage('chào bạn, tôi giúp gì?', [{ callId: 'c1', tool: 'read_file', argKeys: ['path'] }]);
  session.recordToolCall('c1', 'read_file', ['path']);
  session.recordToolResult('c1', 'read_file', 'ok', 'nội dung file', 12);
  session.recordUserMessage('cảm ơn');
  session.recordAgentMessage('không có gì');
  return session;
}

test('replay: fold đúng state — messages, tool pending→done, counts', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  const { events } = store.readAll('conv-main');
  const state = foldConversationEvents(events, 'conv-main');
  assert.equal(state.messages.length, 4);
  assert.deepEqual(state.messages.map((m) => m.role), ['user', 'agent', 'user', 'agent']);
  assert.equal(state.pendingToolCalls.length, 0);
  assert.equal(state.toolCallsCompleted, 1);
  assert.equal(state.status, 'active');
  assert.equal(state.lastSeq, 7);
  assert.equal(state.botId, 'bot-1');
  assert.equal(state.title, 'test');
  assert.equal(state.eventCounts['user.message'], 2);
  assert.equal(state.eventCounts['agent.message'], 2);
});

test('replay: pending tool call còn treo khi chưa có observation', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  const session = ConversationV112Session.open(store, { botId: 'bot-1', conversationId: 'conv-p' });
  session.recordAgentMessage('đang đọc file', [{ callId: 'c9', tool: 'read_file', argKeys: ['path'] }]);
  const state = session.getState();
  assert.equal(state.pendingToolCalls.length, 1);
  assert.equal(state.pendingToolCalls[0].callId, 'c9');
  session.recordToolResult('c9', 'read_file', 'error', 'không tìm thấy file', 5);
  assert.equal(session.getState().pendingToolCalls.length, 0);
  assert.equal(session.getState().toolCallsCompleted, 1);
});

test('replay: determinism — fold hai lần cho cùng state', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  const { events } = store.readAll('conv-main');
  const { state, deterministic } = replayDeterministicallyV112(events, 'conv-main');
  assert.equal(deterministic, true);
  assert.equal(state.messages.length, 4);
  // Đổi thứ tự hai user message → state khác (fold phụ thuộc thứ tự
  // log) — chứng minh replay giữ đúng thứ tự event, không tự sắp xếp.
  const shuffled = [events[0], events[5], events[2], events[3], events[4], events[1], events[6]];
  const other = foldConversationEvents(shuffled, 'conv-main');
  assert.notDeepEqual(other.messages, state.messages);
  assert.equal(other.messages[0].text, 'cảm ơn');
});

test('session: reopen từ đĩa cho đúng state; end() ghi ended', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  const session = seedConversation(store);
  const before = session.getState();
  const reopened = ConversationV112Session.open(store, { botId: 'bot-1', conversationId: 'conv-main' });
  assert.deepEqual(reopened.getState(), before);
  reopened.end('user-closed');
  assert.equal(reopened.getState().status, 'ended');
  assert.match(summarizeConversationState(reopened.getState()), /ended/);
});

test('session: secret trong message bị redact trước khi lưu xuống đĩa', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  const session = ConversationV112Session.open(store, { botId: 'bot-1', conversationId: 'conv-secret' });
  session.recordUserMessage('key của tôi là sk-abcdefghij1234567890 nhớ nhé');
  const raw = fs.readFileSync(store.filePath('conv-secret'), 'utf8');
  assert.ok(!raw.includes('sk-abcdefghij1234567890'), 'secret không được nằm trong file log');
  assert.ok(raw.includes('[REDACTED]'));
  session.recordUserMessage('mật khẩu: password=hunter2secret');
  const raw2 = fs.readFileSync(store.filePath('conv-secret'), 'utf8');
  assert.ok(!raw2.includes('hunter2secret'));
});

test('session: text dài bị cắt ở giới hạn, state giữ text đã cắt', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  const session = ConversationV112Session.open(store, {
    botId: 'bot-1',
    conversationId: 'conv-long',
    maxMessageChars: 20,
  });
  session.recordUserMessage('a'.repeat(100));
  const state = session.getState();
  assert.equal(state.messages[0].text.length, 20);
  const { events } = store.readAll('conv-long');
  assert.equal(events[1].payload.originalChars, 100);
});

test('branch: con sao chép tới fromSeq, sửa con không ảnh hưởng cha', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  const result = branchConversation(store, 'conv-main', 3, { reason: 'thử hướng khác' });
  assert.equal(result.fromSeq, 3);
  assert.equal(result.copiedEvents, 3);
  const child = ConversationV112Session.open(store, { botId: 'bot-1', conversationId: result.childConversationId });
  const childState = child.getState();
  assert.equal(childState.messages.length, 2);
  assert.equal(childState.messages[0].text, 'xin chào bot');
  assert.equal(childState.messages[1].text, 'chào bạn, tôi giúp gì?');
  assert.equal(childState.parentConversationId, 'conv-main');
  assert.equal(childState.branchedFromSeq, 3);
  // Cha ghi branched, status branched.
  const parentState = ConversationV112Session.open(store, { botId: 'bot-1', conversationId: 'conv-main' }).getState();
  assert.equal(parentState.status, 'branched');
  assert.equal(parentState.branches.length, 1);
  assert.deepEqual(listConversationBranches(store, 'conv-main').map((b) => b.childConversationId), [result.childConversationId]);
  // Ghi thêm vào con không ảnh hưởng cha.
  child.recordUserMessage('nhánh riêng');
  assert.equal(store.count('conv-main'), 8); // 7 + 1 branched event
  assert.equal(store.verify(result.childConversationId).ok, true);
  assert.equal(store.verify('conv-main').ok, true);
});

test('branch: fromSeq ngoài khoảng → throw', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  assert.throws(() => branchConversation(store, 'conv-main', 99), /vượt quá/);
  assert.throws(() => branchConversation(store, 'conv-main', 0), /số nguyên >= 1/);
  assert.throws(() => branchConversation(store, 'conv-khong-co', 1), /chưa có event/);
});

test('snapshot: tạo + đọc lại đúng state; sửa file snapshot → đọc báo lỗi', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  const snap = createConversationSnapshot(store, 'conv-main');
  assert.equal(snap.throughSeq, 7);
  assert.equal(snap.messageCount, 4);
  assert.equal(snap.sha256.length, 64);
  const read = readConversationSnapshot(store, 'conv-main');
  assert.equal(read.throughSeq, 7);
  assert.equal(read.state.messages.length, 4);
  // Sửa file snapshot → hash không khớp log → đọc throw.
  const snapPath = path.join(path.dirname(store.filePath('conv-main')), 'conv-main.snapshot-7.json');
  const content = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  content.state.messages[0].text = 'đã sửa';
  fs.writeFileSync(snapPath, JSON.stringify(content, null, 2));
  assert.throws(() => readConversationSnapshot(store, 'conv-main'), /đã bị sửa/);
});

test('compact: log ngắn lại, chain ok, replay từ snapshot đủ message', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  const result = compactConversation(store, 'conv-main', 5);
  assert.equal(result.throughSeq, 5);
  assert.equal(result.removedEvents, 5);
  assert.ok(result.remainingEvents < 7);
  assert.equal(store.verify('conv-main').ok, true);
  // Replay từ snapshot cho đủ 4 message.
  const { state, foldedAfterSnapshot } = replayFromSnapshot(store, 'conv-main');
  assert.equal(state.messages.length, 4);
  assert.equal(state.toolCallsCompleted, 1);
  assert.ok(foldedAfterSnapshot >= 1);
  // Log-only fold thì thiếu (hành vi có chủ ý sau compact).
  const { events } = store.readAll('conv-main');
  const logOnly = foldConversationEvents(events, 'conv-main');
  assert.ok(logOnly.messages.length < 4);
  // Ghi tiếp sau compact vẫn append đúng.
  const session = ConversationV112Session.open(store, { botId: 'bot-1', conversationId: 'conv-main' });
  session.recordUserMessage('sau compact');
  assert.equal(store.verify('conv-main').ok, true);
  assert.equal(replayFromSnapshot(store, 'conv-main').state.messages.length, 5);
});

test('compact: throughSeq là event cuối → throw (phải để lại ít nhất 1 event)', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  assert.throws(() => compactConversation(store, 'conv-main', 7), /ít nhất 1 event/);
});

test('timetravel: state tại seq + diff tới hiện tại', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  const past = stateAtSeq(store, 'conv-main', 3);
  assert.equal(past.messages.length, 2);
  assert.equal(past.toolCallsCompleted, 0);
  assert.equal(past.lastSeq, 3);
  const present = stateAtSeq(store, 'conv-main', 7);
  assert.equal(present.messages.length, 4);
  const diff = diffConversationStates(past, present);
  assert.equal(diff.addedMessages.length, 2);
  assert.equal(diff.toolCallsCompletedDelta, 1);
  assert.equal(diff.statusChanged, false);
  const travel = timeTravelConversation(store, 'conv-main', 3);
  assert.equal(travel.atSeq, 3);
  assert.equal(travel.futureEvents, 4);
  assert.equal(travel.diffToPresent.addedMessages.length, 2);
  assert.throws(() => timeTravelConversation(store, 'conv-main', 0), /ngoài khoảng/);
  assert.throws(() => timeTravelConversation(store, 'conv-main', 99), /ngoài khoảng/);
});

test('timetravel: sau compact vẫn quay được về seq trong log mới', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  compactConversation(store, 'conv-main', 5);
  // Log mới: anchor seq 1 (snapshot through 5) + event cũ 6,7 + compacted.
  const travel = timeTravelConversation(store, 'conv-main', 2);
  assert.equal(travel.state.messages.length, 3); // 2 trong snapshot + 1 sau anchor
  assert.equal(travel.futureEvents, 2);
  const atEnd = stateAtSeq(store, 'conv-main', 4);
  assert.equal(atEnd.messages.length, 4);
});

test('timetravel: state tại seq trước snapshot (chưa compact) fold từ đầu', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  createConversationSnapshot(store, 'conv-main', 7);
  const past = stateAtSeq(store, 'conv-main', 3);
  assert.equal(past.messages.length, 2);
  assert.equal(past.lastSeq, 3);
  assert.equal(past.latestSnapshot, undefined); // snapshot tại 7 chưa "xảy ra" ở seq 3
});

test('export/import: round-trip đúng chain; file sửa → từ chối; id đã có → từ chối', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedConversation(store);
  const outDir = path.join(dir, 'exports');
  const exported = exportConversationToFile(store, 'conv-main', outDir);
  assert.equal(exported.eventCount, 7);
  assert.ok(fs.existsSync(exported.file));
  const parsed = parseConversationExportJsonl(fs.readFileSync(exported.file, 'utf8'));
  assert.equal(parsed.events.length, 7);
  assert.equal(parsed.header.conversationId, 'conv-main');
  // Import vào id mới.
  const imported = importConversationFromFile(store, exported.file, { conversationId: 'conv-imported' });
  assert.equal(imported.importedEvents, 7);
  assert.equal(store.verify('conv-imported').ok, true);
  const importedState = foldConversationEvents(store.readAll('conv-imported').events, 'conv-imported');
  assert.equal(importedState.messages.length, 4);
  // Import lại vào id đã có → từ chối.
  assert.throws(() => importConversationFromFile(store, exported.file), /đã có log/);
  // Sửa 1 event trong file export → parse từ chối.
  const badText = fs.readFileSync(exported.file, 'utf8').replace('xin chào bot', 'đã sửa lén');
  const badFile = path.join(outDir, 'bad.jsonl');
  fs.writeFileSync(badFile, badText);
  assert.throws(() => parseConversationExportJsonl(badText), /hỏng/);
  assert.throws(() => importConversationFromFile(store, badFile, { conversationId: 'conv-bad' }), /hỏng/);
});
