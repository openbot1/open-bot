/**
 * Tests cho v1.12 (Đội T2): loop adapter — nối conversation log vào
 * agent loop hiện có mà KHÔNG sửa loop.ts.
 *
 * - toToolCallRecorder: một record() ghi cặp action/observation
 *   (argKeys từ args_json, không ghi value); duration từ timing.
 * - Recorder nuốt lỗi ghi log (hợp đồng best-effort của loop) và
 *   đếm dropped.
 * - ConversationLoopAdapter: onUserMessage/onModelResponse ghi đúng;
 *   onAgentTextMaybeCodeAct chạy code block khi có, trả 0 khi không.
 * - attachConversationV112ToRunner trả về { toolCallRecorder } để
 *   spread vào AgentRunnerOptions.
 *
 * Không Electron, không mạng, không key. Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/conversation-v112-loop.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BotBoxManager } from '../packages/core/dist/sandbox/box.js';
import { CodeActExecutor } from '../packages/core/dist/codeact/index.js';
import {
  ConversationLogStore,
  ConversationLoopAdapter,
  ConversationV112Session,
  argKeysFromJson,
  attachConversationV112ToRunner,
  toToolCallRecorder,
} from '../packages/core/dist/conversationV112/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-conv-v112-loop-'));
}

function makeSession(dir, opts = {}) {
  const store = new ConversationLogStore({ dataDir: path.join(dir, 'logs') });
  return ConversationV112Session.open(store, {
    botId: 'bot-1',
    conversationId: 'conv-loop',
    ...opts,
  });
}

test('argKeysFromJson: lấy tên key, không ghi value; JSON hỏng → []', () => {
  assert.deepEqual(argKeysFromJson('{"path":"/tmp/secret.txt","x":1}'), ['path', 'x']);
  assert.deepEqual(argKeysFromJson('not json'), []);
  assert.deepEqual(argKeysFromJson('[1,2]'), []);
});

test('toToolCallRecorder: một record ghi cặp action/observation đúng', () => {
  const dir = tmpDir();
  const session = makeSession(dir);
  const recorder = toToolCallRecorder(session);
  recorder.record({
    tool_call_id: 'call-1',
    tool_name: 'read_file',
    args_json: '{"path":"/tmp/a.txt"}',
    started_at_ms: 1000,
    completed_at_ms: 1050,
    status: 'ok',
    result_preview: 'nội dung',
  });
  const state = session.getState();
  assert.equal(state.toolCallsCompleted, 1);
  assert.equal(state.pendingToolCalls.length, 0);
  assert.equal(state.eventCounts['action.tool'], 1);
  assert.equal(state.eventCounts['observation.tool'], 1);
  // Log trên đĩa chỉ có tên key, không có value path.
  const raw = fs.readFileSync(session.store.filePath('conv-loop'), 'utf8');
  assert.ok(raw.includes('"path"'), 'argKeys phải có tên key path');
  assert.ok(!raw.includes('/tmp/a.txt'), 'value của args không được ghi vào log');
  assert.equal(recorder.droppedCount, 0);
});

test('toToolCallRecorder: lỗi ghi log bị nuốt, dropped tăng (không throw vào run)', () => {
  const dir = tmpDir();
  const session = makeSession(dir);
  const recorder = toToolCallRecorder(session);
  // Làm hỏng store bằng cách xoá thư mục log rồi chặn tạo lại: thay
  // dataDir bằng một FILE (mkdirSync trong constructor đã chạy lúc
  // tạo store — ở đây ta phá bằng cách ghi đè file log thành thư mục).
  const file = session.store.filePath('conv-loop');
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  recorder.record({
    tool_call_id: 'call-2',
    tool_name: 'read_file',
    args_json: '{}',
    status: 'ok',
    result_preview: 'x',
  });
  assert.equal(recorder.droppedCount, 1);
});

test('ConversationLoopAdapter: ghi user/model message + codeact khi có code', async () => {
  const dir = tmpDir();
  const boxes = new BotBoxManager({ rootDir: path.join(dir, 'boxes') });
  const executor = new CodeActExecutor({ boxes, botId: 'bot-1' });
  const session = makeSession(dir, { codeActExecutor: executor });
  const adapter = new ConversationLoopAdapter(session);
  adapter.onUserMessage('tính giúp tôi');
  adapter.onModelResponse('đây là kết quả', [{ callId: 'c1', tool: 'read_file', argKeys: ['path'] }]);
  const runs = await adapter.onAgentTextMaybeCodeAct('```python\nprint(2 + 3)\n```');
  assert.equal(runs, 1);
  const none = await adapter.onAgentTextMaybeCodeAct('chỉ text, không code');
  assert.equal(none, 0);
  const state = session.getState();
  assert.equal(state.messages.length, 2);
  assert.equal(state.codeActRuns, 1);
  assert.equal(adapter.droppedCount, 0);
});

test('attachConversationV112ToRunner: trả { toolCallRecorder } dùng được cho AgentRunnerOptions', () => {
  const dir = tmpDir();
  const session = makeSession(dir);
  const opts = attachConversationV112ToRunner(session);
  assert.equal(typeof opts.toolCallRecorder.record, 'function');
  opts.toolCallRecorder.record({
    tool_call_id: 'c-x',
    tool_name: 'shell_exec',
    args_json: '{"command":"ls"}',
    status: 'ok',
    result_preview: 'ok',
  });
  assert.equal(session.getState().toolCallsCompleted, 1);
});
