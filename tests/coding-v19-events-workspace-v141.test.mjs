/**
 * Tests cho coding agent v19 — event log + workspace tách bạch
 * (v1.41, Đội T4).
 *
 * Chạy thật: append/validate/hash-chain/replay/compact/fork trên dữ
 * liệu thật, workspace thật trên tmpdir (ghi/đọc/sửa/xoá, snapshot/
 * rollback, diff), path traversal + symlink đều bị chặn. Không gọi
 * model/mạng, không cần bwrap.
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v19-events-workspace-v141.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  v19AppendEvent,
  v19CheckWorkspacePath,
  v19CompactEvents,
  v19CountEventsByKind,
  v19CreateConversationMeta,
  v19CreateSnapshot,
  v19DiffSnapshotToWorkspace,
  v19EndConversationEvents,
  v19EventFromJsonl,
  v19EventsFromJsonl,
  v19EventsToJsonl,
  v19ForkConversation,
  v19IsValidEventLog,
  v19ListSnapshots,
  v19LoadSnapshot,
  v19OpenConversationEvents,
  v19ReplayEvents,
  v19RollbackSnapshot,
  v19VerifyEventChain,
  v19WorkspaceDelete,
  v19WorkspaceEdit,
  v19WorkspaceList,
  v19WorkspaceManifest,
  v19WorkspaceRead,
  v19WorkspaceTree,
  v19WorkspaceWrite,
  renderV19ConversationState,
  renderV19EventLog,
  renderV19WorkspaceDiff,
  renderV19WorkspaceTree,
} from '../packages/core/dist/index.js';

const NOW = 1794000000000;

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v19-ew-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sampleEvents() {
  const convId = 'conv-test-1';
  let events = [];
  events = v19AppendEvent(events, convId, { kind: 'session_start', actor: 'system', at: NOW, payload: { text: 'start' } });
  events = v19AppendEvent(events, convId, { kind: 'user_message', actor: 'user', at: NOW + 1, payload: { text: 'Fix the bug' } });
  events = v19AppendEvent(events, convId, { kind: 'tool_call', actor: 'agent', at: NOW + 2, payload: { toolName: 'coding_v19_workspace', toolArgsJson: '{"action":"read"}' } });
  events = v19AppendEvent(events, convId, { kind: 'tool_result', actor: 'tool:coding_v19_workspace', at: NOW + 3, payload: { toolName: 'coding_v19_workspace', result: 'ok', ok: true } });
  events = v19AppendEvent(events, convId, { kind: 'file_edit', actor: 'agent', at: NOW + 4, payload: { filePath: 'src/a.ts', fileAction: 'edit', fileContent: 'export const a = 1;\n' } });
  events = v19AppendEvent(events, convId, { kind: 'checkpoint', actor: 'system', at: NOW + 5, payload: { checkpointId: 'ckpt-1', checkpointLabel: 'before-test' } });
  return { convId, events };
}

test('v19 event log: append sinh seq/hash-chain liên tục, validate pass', () => {
  const { convId, events } = sampleEvents();
  assert.equal(events.length, 6);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(events[0].prevHash, '');
  for (let i = 1; i < events.length; i += 1) {
    assert.equal(events[i].prevHash, events[i - 1].hash);
  }
  assert.equal(events[0].id, `ev-${convId}-1`);
  assert.equal(v19VerifyEventChain(events), '');
  assert.equal(v19IsValidEventLog(events), true);
});

test('v19 event log: payload thiếu field bắt buộc thì throw rõ ràng', () => {
  const convId = 'conv-test-2';
  assert.throws(() => v19AppendEvent([], convId, { kind: 'user_message', payload: {} }), /payload\.text không rỗng/);
  assert.throws(() => v19AppendEvent([], convId, { kind: 'tool_call', payload: {} }), /toolName/);
  assert.throws(() => v19AppendEvent([], convId, { kind: 'file_edit', payload: { filePath: 'a.ts' } }), /fileAction/);
  assert.throws(() => v19AppendEvent([], convId, { kind: 'checkpoint', payload: {} }), /checkpointId/);
  assert.throws(() => v19AppendEvent([], convId, { kind: 'nope-kind', payload: {} }), /không hợp lệ/);
  assert.throws(() => v19AppendEvent([], '', { kind: 'note', payload: { text: 'x' } }), /conversationId/);
});

test('v19 event log: sửa lén một event thì verify phát hiện (hash vỡ)', () => {
  const { events } = sampleEvents();
  const tampered = events.map((e) => ({ ...e }));
  tampered[1] = { ...tampered[1], payload: { text: 'HACKED — do something else' } };
  assert.match(v19VerifyEventChain(tampered), /hash vỡ tại seq 2/);
  assert.equal(v19IsValidEventLog(tampered), false);
  // Xoá một event giữa log: seq không liên tục + prevHash vỡ.
  const dropped = [events[0], events[1], events[3], events[4], events[5]].map((e) => ({ ...e }));
  assert.notEqual(v19VerifyEventChain(dropped), '');
});

test('v19 event log: JSONL round-trip giữ nguyên log + chain', () => {
  const { events } = sampleEvents();
  const jsonl = v19EventsToJsonl(events);
  assert.equal(jsonl.split('\n').filter(Boolean).length, 6);
  const parsed = v19EventsFromJsonl(jsonl);
  assert.deepEqual(parsed, events);
  assert.equal(v19EventsToJsonl([]), '');
  assert.deepEqual(v19EventsFromJsonl(''), []);
  assert.throws(() => v19EventFromJsonl('not json', 1), /không phải JSON/);
  assert.throws(() => v19EventsFromJsonl('{"seq": 9}\n'), /Dòng JSONL 1/);
});

test('v19 replay: khôi phục messages/tool call/file/checkpoint/preset/plugin', () => {
  const { convId, events } = sampleEvents();
  let withPreset = v19AppendEvent(events, convId, { kind: 'preset_applied', actor: 'system', at: NOW + 6, payload: { presetId: 'reviewer' } });
  withPreset = v19AppendEvent(withPreset, convId, { kind: 'plugin_change', actor: 'system', at: NOW + 7, payload: { pluginId: 'filesystem', pluginChange: 'load' } });
  withPreset = v19AppendEvent(withPreset, convId, { kind: 'plugin_change', actor: 'system', at: NOW + 8, payload: { pluginId: 'filesystem', pluginChange: 'disable' } });
  const state = v19ReplayEvents(convId, withPreset);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].role, 'user');
  assert.equal(state.messages[0].text, 'Fix the bug');
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].toolName, 'coding_v19_workspace');
  assert.equal(state.toolCalls[0].result, 'ok');
  assert.equal(state.toolCalls[0].ok, true);
  assert.deepEqual(state.filesChanged, [{ filePath: 'src/a.ts', action: 'edit', lastSeq: 5, at: NOW + 4 }]);
  assert.equal(state.checkpoints.length, 1);
  assert.equal(state.checkpoints[0].checkpointId, 'ckpt-1');
  assert.equal(state.presetId, 'reviewer');
  assert.equal(state.plugins.length, 1);
  assert.equal(state.plugins[0].loaded, true);
  assert.equal(state.plugins[0].enabled, false);
  assert.equal(state.ended, false);
  assert.equal(state.eventsReplayed, 9);
  assert.equal(state.lastSeq, 9);
  assert.deepEqual(v19CountEventsByKind(withPreset), {
    session_start: 1,
    user_message: 1,
    tool_call: 1,
    tool_result: 1,
    file_edit: 1,
    checkpoint: 1,
    preset_applied: 1,
    plugin_change: 2,
  });
  // Replay là hàm thuần: chạy 2 lần cho cùng state.
  assert.deepEqual(v19ReplayEvents(convId, withPreset), state);
  const rendered = renderV19ConversationState(state);
  assert.match(rendered, /9 event/);
  assert.match(rendered, /src\/a\.ts \(edit\)/);
  assert.match(renderV19EventLog(withPreset), /#2 user: Fix the bug/);
});

test('v19 replay: tool_result mồ côi vẫn ghi nhận, không mất thông tin', () => {
  const convId = 'conv-test-3';
  let events = [];
  events = v19AppendEvent(events, convId, { kind: 'tool_result', actor: 'tool:x', at: NOW, payload: { toolName: 'x', result: 'orphan', ok: false } });
  const state = v19ReplayEvents(convId, events);
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].result, 'orphan');
  assert.equal(state.toolCalls[0].ok, false);
});

test('v19 event log: không append sau session_end; end rồi replay ended=true', () => {
  const { convId, events } = sampleEvents();
  const ended = v19EndConversationEvents(events, convId, 'done', NOW + 10);
  assert.equal(v19ReplayEvents(convId, ended).ended, true);
  assert.equal(v19ReplayEvents(convId, ended).endReason, 'done');
  assert.throws(
    () => v19AppendEvent(ended, convId, { kind: 'note', payload: { text: 'too late' } }),
    /đã session_end/,
  );
});

test('v19 compact: cắt fileContent cũ, replay messages/tool calls vẫn đúng', () => {
  const convId = 'conv-test-4';
  let events = [];
  for (let i = 0; i < 60; i += 1) {
    events = v19AppendEvent(events, convId, {
      kind: i % 2 === 0 ? 'file_edit' : 'user_message',
      actor: 'agent',
      at: NOW + i,
      payload: i % 2 === 0
        ? { filePath: `f${i}.ts`, fileAction: 'create', fileContent: `content-${i}\n`.repeat(20) }
        : { text: `msg ${i}` },
    });
  }
  const compacted = v19CompactEvents(events, 50);
  assert.equal(compacted.length, 60);
  assert.equal(v19VerifyEventChain(compacted), '');
  const old = compacted.find((e) => e.seq === 1);
  assert.equal(old.payload.fileContent, '[compacted]');
  assert.equal(compacted.find((e) => e.seq === 60).payload.text, 'msg 59');
  const state = v19ReplayEvents(convId, compacted);
  assert.equal(state.messages.length, 30);
  assert.equal(state.filesChanged.length, 30);
});

test('v19 fork: branch copy event tới seq, giữ preset, log cha ghi branch', () => {
  const { convId, events } = sampleEvents();
  const parentMeta = v19CreateConversationMeta({ title: 'Parent', profileId: 'general', now: NOW });
  // Meta id khác convId của log mẫu: fork dùng meta + log cùng id nên tạo lại log theo meta.
  let parentEvents = [];
  parentEvents = v19OpenConversationEvents(parentMeta, NOW);
  parentEvents = v19AppendEvent(parentEvents, parentMeta.id, { kind: 'user_message', actor: 'user', at: NOW + 1, payload: { text: 'hello' } });
  parentEvents = v19AppendEvent(parentEvents, parentMeta.id, { kind: 'assistant_message', actor: 'agent', at: NOW + 2, payload: { text: 'hi' } });
  parentEvents = v19AppendEvent(parentEvents, parentMeta.id, { kind: 'user_message', actor: 'user', at: NOW + 3, payload: { text: 'more' } });
  void convId;
  void events;
  const { childMeta, childEvents, parentEvents: nextParent } = v19ForkConversation(
    parentMeta,
    parentEvents,
    4,
    'Branch thử',
    NOW + 10,
  );
  assert.notEqual(childMeta.id, parentMeta.id);
  assert.equal(childMeta.parentId, parentMeta.id);
  assert.equal(childMeta.branchedFromSeq, 4);
  assert.equal(childMeta.profileId, 'general');
  assert.equal(childMeta.status, 'active');
  // Con: 4 event copy + 1 branch marker; replay con thấy 2 tin nhắn.
  assert.equal(childEvents.length, 5);
  assert.equal(v19VerifyEventChain(childEvents), '');
  assert.equal(v19ReplayEvents(childMeta.id, childEvents).messages.length, 2);
  // Cha: thêm 1 event branch.
  assert.equal(nextParent.length, parentEvents.length + 1);
  assert.equal(nextParent[nextParent.length - 1].kind, 'branch');
  assert.equal(nextParent[nextParent.length - 1].payload.branchToConversationId, childMeta.id);
  // Fork sai seq thì throw.
  assert.throws(() => v19ForkConversation(parentMeta, parentEvents, 99, 'X', NOW), /Không fork được/);
  assert.throws(() => v19ForkConversation(parentMeta, parentEvents, 0, 'X', NOW), /Không fork được/);
});

test('v19 workspace: write/read/edit/delete/list thật trên đĩa', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  const written = v19WorkspaceWrite(root, 'src/a.ts', 'line1\nline2\n');
  assert.equal(written.relPath, 'src/a.ts');
  assert.equal(written.hash.length, 64);
  assert.equal(v19WorkspaceRead(root, 'src/a.ts').content, 'line1\nline2\n');
  const edited = v19WorkspaceEdit(root, 'src/a.ts', 'line2', 'line2-edited');
  assert.match(edited.content, /line2-edited/);
  assert.throws(() => v19WorkspaceEdit(root, 'src/a.ts', 'khong-co', 'x'), /Không tìm thấy oldText/);
  v19WorkspaceWrite(root, 'b.md', '# hi\n');
  const list = v19WorkspaceList(root);
  assert.deepEqual(list.map((f) => f.relPath), ['b.md', 'src/a.ts']);
  const deleted = v19WorkspaceDelete(root, 'b.md');
  assert.equal(deleted, 'b.md');
  assert.throws(() => v19WorkspaceRead(root, 'b.md'), /không có trong workspace/);
  assert.deepEqual(Object.keys(v19WorkspaceManifest(root)), ['src/a.ts']);
});

test('v19 workspace: path traversal bị chặn (../, tuyệt đối ngoài, .. lồng)', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  v19WorkspaceWrite(root, 'ok.ts', 'safe');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  for (const evil of ['../outside.txt', '../../etc/passwd', 'a/../../outside.txt', outside, '/etc/passwd']) {
    const check = v19CheckWorkspacePath(root, evil);
    assert.equal(check.inside, false, evil);
    assert.match(check.reason, /ngoài workspace/);
    assert.throws(() => v19WorkspaceWrite(root, evil, 'x'), /ngoài workspace/);
    assert.throws(() => v19WorkspaceRead(root, evil), /ngoài workspace/);
  }
  // Path hợp lệ vẫn qua: './', thư mục con, đường tuyệt đối TRONG workspace.
  assert.equal(v19CheckWorkspacePath(root, './ok.ts').inside, true);
  assert.equal(v19CheckWorkspacePath(root, 'sub/../ok.ts').relPath, 'ok.ts');
  assert.equal(v19CheckWorkspacePath(root, path.join(root, 'ok.ts')).inside, true);
});

test('v19 workspace: symlink trỏ ra ngoài bị chặn', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  const outside = path.join(dir, 'secret.txt');
  fs.writeFileSync(outside, 'top-secret');
  v19WorkspaceWrite(root, 'real.ts', 'real');
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'link.txt'));
  const check = v19CheckWorkspacePath(root, 'link.txt');
  assert.equal(check.inside, false);
  assert.match(check.reason, /symlink/);
  assert.throws(() => v19WorkspaceRead(root, 'link.txt'), /symlink/);
  // Symlink nội bộ (trỏ vào file trong workspace) vẫn được.
  fs.symlinkSync(path.join(root, 'real.ts'), path.join(root, 'inner-link.ts'));
  assert.equal(v19CheckWorkspacePath(root, 'inner-link.ts').inside, true);
});

test('v19 snapshot: checkpoint + rollback khôi phục file, xoá file sinh sau', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  const snapDir = path.join(dir, 'snaps');
  v19WorkspaceWrite(root, 'a.ts', 'v1\n');
  v19WorkspaceWrite(root, 'b.ts', 'keep\n');
  const snap = v19CreateSnapshot(root, snapDir, 'conv-snap', 'before', 5, NOW);
  assert.equal(Object.keys(snap.files).length, 2);
  assert.equal(snap.atSeq, 5);
  v19WorkspaceWrite(root, 'a.ts', 'v2-changed\n');
  v19WorkspaceWrite(root, 'c.ts', 'new-after-snapshot\n');
  v19WorkspaceDelete(root, 'b.ts');
  const loaded = v19LoadSnapshot(snapDir, snap.id);
  assert.equal(loaded.id, snap.id);
  assert.equal(v19LoadSnapshot(snapDir, 'ckpt-nope'), undefined);
  const result = v19RollbackSnapshot(root, snapDir, snap.id, NOW + 1);
  assert.deepEqual(result.restored.sort(), ['a.ts', 'b.ts']);
  assert.deepEqual(result.deleted, ['c.ts']);
  assert.equal(v19WorkspaceRead(root, 'a.ts').content, 'v1\n');
  assert.equal(v19WorkspaceRead(root, 'b.ts').content, 'keep\n');
  assert.throws(() => v19WorkspaceRead(root, 'c.ts'), /không có trong workspace/);
  assert.throws(() => v19RollbackSnapshot(root, snapDir, 'ckpt-nope', NOW), /Không có snapshot/);
  assert.equal(v19ListSnapshots(snapDir, 'conv-snap').length, 1);
  assert.equal(v19ListSnapshots(snapDir, 'conv-khac').length, 0);
});

test('v19 diff: snapshot -> workspace hiện tại (added/modified/deleted)', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  const snapDir = path.join(dir, 'snaps');
  v19WorkspaceWrite(root, 'same.ts', 'x\n');
  v19WorkspaceWrite(root, 'mod.ts', 'a\nb\nc\nd\n');
  v19WorkspaceWrite(root, 'gone.ts', 'old\n');
  const snap = v19CreateSnapshot(root, snapDir, 'conv-diff', 'base', 2, NOW);
  v19WorkspaceWrite(root, 'mod.ts', 'a\nB-changed\nc\nd\n');
  v19WorkspaceDelete(root, 'gone.ts');
  v19WorkspaceWrite(root, 'new.ts', 'fresh\n');
  const entries = v19DiffSnapshotToWorkspace(root, snapDir, snap.id);
  const byPath = new Map(entries.map((e) => [e.relPath, e]));
  assert.equal(byPath.get('same.ts').status, 'unchanged');
  assert.equal(byPath.get('mod.ts').status, 'modified');
  assert.equal(byPath.get('mod.ts').addedLines, 1);
  assert.equal(byPath.get('mod.ts').removedLines, 1);
  assert.equal(byPath.get('mod.ts').hunks.length, 1);
  assert.equal(byPath.get('gone.ts').status, 'deleted');
  assert.equal(byPath.get('new.ts').status, 'added');
  const rendered = renderV19WorkspaceDiff(entries);
  assert.match(rendered, /~ mod\.ts \(\+1\/-1 dòng\)/);
  assert.match(rendered, /\+ new\.ts/);
  assert.match(rendered, /- gone\.ts/);
  assert.equal(renderV19WorkspaceDiff(entries.filter((e) => e.status === 'unchanged')), 'Không có thay đổi.');
});

test('v19 workspace tree: cây thư mục lồng nhau, dir trước file, size cộng dồn', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  v19WorkspaceWrite(root, 'top.md', 'x\n');
  v19WorkspaceWrite(root, 'src/a.ts', 'aaa');
  v19WorkspaceWrite(root, 'src/deep/b.ts', 'bb');
  v19WorkspaceWrite(root, 'src/c.ts', 'c');
  const tree = v19WorkspaceTree(v19WorkspaceList(root));
  assert.equal(tree.length, 2);
  assert.equal(tree[0].kind, 'dir');
  assert.equal(tree[0].name, 'src');
  assert.equal(tree[0].size, 3 + 2 + 1);
  assert.equal(tree[1].kind, 'file');
  assert.equal(tree[1].name, 'top.md');
  const srcChildren = tree[0].children.map((c) => c.name);
  assert.deepEqual(srcChildren, ['deep', 'a.ts', 'c.ts']); // dir trước, rồi file theo tên
  assert.equal(tree[0].children[0].children[0].relPath, 'src/deep/b.ts');
  const rendered = renderV19WorkspaceTree(tree);
  assert.match(rendered, /\[dir\] src/);
  assert.match(rendered, /\[file\] b\.ts \(2 bytes\)/);
  assert.deepEqual(v19WorkspaceTree([]), []);
  assert.equal(renderV19WorkspaceTree([]), '');
});
