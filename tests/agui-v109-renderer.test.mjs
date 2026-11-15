/**
 * Tests v1.09 (Đội T4): AG-UI renderer — áp event vào view model thời gian thực.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/agui-v109-renderer.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgUiRenderer, makeAgUiEvent } from '../packages/core/dist/index.js';

function ev(type, runId, data, sequence, extra = {}) {
  return { ...makeAgUiEvent(type, runId, data, extra), sequence };
}

test('renderer: run lifecycle — started -> finished gộp final text + usage', () => {
  const r = new AgUiRenderer();
  assert.equal(r.apply(ev('RUN_STARTED', 'run-1', { title: 'Làm bài', providerId: 'openai', model: 'gpt-x', toolCount: 3 }, 0, { botId: 'bot-1' })), true);
  assert.equal(r.apply(ev('TEXT_MESSAGE_START', 'run-1', { messageId: 'm1', role: 'assistant' }, 1, { messageId: 'm1' })), true);
  assert.equal(r.apply(ev('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'Xin ' }, 2, { messageId: 'm1' })), true);
  assert.equal(r.apply(ev('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'chào' }, 3, { messageId: 'm1' })), true);
  assert.equal(r.apply(ev('TEXT_MESSAGE_END', 'run-1', { messageId: 'm1', fullText: 'Xin chào' }, 4, { messageId: 'm1' })), true);
  assert.equal(r.apply(ev('RUN_FINISHED', 'run-1', { status: 'completed', finalText: 'Xin chào', steps: 2, toolCalls: 0, tokensUsed: 42, durationMs: 1200 }, 5)), true);
  const view = r.getRun('run-1');
  assert.equal(view?.status, 'completed');
  assert.equal(view?.title, 'Làm bài');
  assert.equal(view?.providerId, 'openai');
  assert.equal(view?.tokensUsed, 42);
  assert.equal(view?.messages.length, 1);
  assert.equal(view?.messages[0].text, 'Xin chào');
  assert.equal(view?.messages[0].streaming, false);
  assert.equal(view?.lastSequence, 5);
  assert.equal(view?.appliedEvents, 6);
  assert.equal(r.totals.applied, 6);
});

test('renderer: tool call gộp START/ARGS/END/RESULT thành một item', () => {
  const r = new AgUiRenderer();
  r.apply(ev('RUN_STARTED', 'run-1', {}, 0));
  r.apply(ev('TOOL_CALL_START', 'run-1', { toolCallId: 'tc1', toolName: 'read_file', step: 0 }, 1, { toolCallId: 'tc1' }));
  r.apply(ev('TOOL_CALL_ARGS', 'run-1', { toolCallId: 'tc1', toolName: 'read_file', argKeys: ['path'], argsJson: '{"path":"a.txt"}', complete: true }, 2, { toolCallId: 'tc1' }));
  r.apply(ev('TOOL_CALL_END', 'run-1', { toolCallId: 'tc1', toolName: 'read_file', status: 'ok', durationMs: 15 }, 3, { toolCallId: 'tc1' }));
  r.apply(ev('TOOL_CALL_RESULT', 'run-1', { toolCallId: 'tc1', toolName: 'read_file', ok: true, outputPreview: 'hello' }, 4, { toolCallId: 'tc1' }));
  const view = r.getRun('run-1');
  assert.equal(view?.toolCallList.length, 1);
  const call = view?.toolCallList[0];
  assert.equal(call?.toolName, 'read_file');
  assert.equal(call?.status, 'ok');
  assert.deepEqual(call?.argKeys, ['path']);
  assert.equal(call?.argsJson, '{"path":"a.txt"}');
  assert.equal(call?.outputPreview, 'hello');
  assert.equal(call?.ok, true);
  assert.equal(call?.durationMs, 15);
  // RESULT về trước START (reorder) vẫn tạo placeholder rồi gộp.
  const r2 = new AgUiRenderer();
  r2.apply(ev('TOOL_CALL_RESULT', 'run-2', { toolCallId: 'tc9', toolName: 'search', ok: false, outputPreview: 'err' }, 0, { toolCallId: 'tc9' }));
  r2.apply(ev('TOOL_CALL_START', 'run-2', { toolCallId: 'tc9', toolName: 'search' }, 1, { toolCallId: 'tc9' }));
  assert.equal(r2.getRun('run-2')?.toolCallList.length, 1);
  assert.equal(r2.getRun('run-2')?.toolCallList[0].toolName, 'search');
});

test('renderer: state snapshot + delta, chống rewind + prototype pollution', () => {
  const r = new AgUiRenderer();
  r.apply(ev('STATE_SNAPSHOT', 'run-1', { state: { progress: { current: 1, total: 5 }, items: ['a'] } }, 0));
  r.apply(ev('STATE_DELTA', 'run-1', { operations: [{ op: 'set', path: 'progress.current', value: 3 }] }, 1));
  r.apply(ev('STATE_DELTA', 'run-1', { operations: [{ op: 'append', path: 'items', value: 'b' }] }, 2));
  let view = r.getRun('run-1');
  assert.deepEqual(view?.state, { progress: { current: 3, total: 5 }, items: ['a', 'b'] });
  // Snapshot cũ (sequence nhỏ hơn) bị bỏ — không rewind.
  r.apply(ev('STATE_SNAPSHOT', 'run-1', { state: { progress: { current: 0, total: 5 } } }, 1));
  view = r.getRun('run-1');
  assert.equal(view?.state.progress.current, 3);
  // Delta chạm __proto__ bị store từ chối (event bị bỏ, state không đổi).
  assert.equal(r.apply(ev('STATE_DELTA', 'run-1', { operations: [{ op: 'set', path: '__proto__.x', value: 1 }] }, 3)), false);
  assert.equal({}.x, undefined);
  assert.deepEqual(r.getRun('run-1')?.state.progress.current, 3);
});

test('renderer: generative UI mở -> trả lời; activity + custom event', () => {
  const r = new AgUiRenderer();
  r.apply(ev('GENERATIVE_UI', 'run-1', {
    componentId: 'c1', kind: 'confirm', title: 'Xóa file?', description: 'Không khôi phục được', props: {}, blocking: true,
  }, 0));
  r.apply(ev('ACTIVITY', 'run-1', { kind: 'thinking', label: 'Đang suy nghĩ' }, 1));
  let view = r.getRun('run-1');
  assert.equal(view?.components.length, 1);
  assert.equal(view?.components[0].answered, false);
  assert.equal(view?.components[0].blocking, true);
  assert.equal(view?.activity?.label, 'Đang suy nghĩ');
  r.apply(ev('GENERATIVE_UI_RESPONSE', 'run-1', { componentId: 'c1', response: { confirmed: true }, action: 'confirm' }, 2));
  r.apply(ev('CUSTOM', 'run-1', { name: 'open-bot.memory', value: { hits: 2 } }, 3));
  view = r.getRun('run-1');
  assert.equal(view?.components[0].answered, true);
  assert.equal(view?.components[0].action, 'confirm');
  assert.deepEqual(view?.custom['open-bot.memory'].value, { hits: 2 });
});

test('renderer: gap -> needsResync + missingSequences; event trùng bị bỏ; applyAll tự sắp xếp', () => {
  const r = new AgUiRenderer();
  r.apply(ev('RUN_STARTED', 'run-1', {}, 0));
  r.apply(ev('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'sau-gap' }, 5, { messageId: 'm1' }));
  let view = r.getRun('run-1');
  assert.equal(view?.gapsDetected, 1);
  assert.equal(view?.needsResync, true);
  assert.deepEqual(view?.missingSequences, [1, 2, 3, 4]);
  // Bù đủ event thiếu -> hết resync.
  r.apply(ev('TEXT_MESSAGE_START', 'run-1', { messageId: 'm1' }, 1, { messageId: 'm1' }));
  r.apply(ev('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'a' }, 2, { messageId: 'm1' }));
  r.apply(ev('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'b' }, 3, { messageId: 'm1' }));
  r.apply(ev('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'c' }, 4, { messageId: 'm1' }));
  view = r.getRun('run-1');
  assert.equal(view?.needsResync, false);
  assert.deepEqual(view?.missingSequences, []);
  // Text gộp theo thứ tự áp (event seq 5 về trước nên đứng đầu) — bù
  // gap không sắp lại text đã áp, chỉ đảm bảo không mất ký tự.
  assert.equal(view?.messages[0].text, 'sau-gapabc');
  // Event trùng sequence bị bỏ.
  assert.equal(r.apply(ev('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'dup' }, 4, { messageId: 'm1' })), false);
  assert.equal(r.getRun('run-1')?.messages[0].text, 'sau-gapabc');

  // applyAll sắp xếp theo sequence dù đưa vào lộn xộn.
  const r2 = new AgUiRenderer();
  const res = r2.applyAll([
    ev('RUN_FINISHED', 'run-2', { status: 'completed' }, 2),
    ev('RUN_STARTED', 'run-2', { title: 't' }, 0),
    ev('TEXT_MESSAGE_CONTENT', 'run-2', { messageId: 'm1', delta: 'hi' }, 1, { messageId: 'm1' }),
  ]);
  assert.deepEqual(res, { applied: 3, skipped: 0 });
  assert.equal(r2.getRun('run-2')?.status, 'completed');
  assert.equal(r2.getRun('run-2')?.messages[0].text, 'hi');
  assert.equal(r2.getRun('run-2')?.gapsDetected, 0);
});

test('renderer: RUN_ERROR, summaries, dropRun, event xấu không chết renderer', () => {
  const r = new AgUiRenderer();
  r.apply(ev('RUN_STARTED', 'run-1', {}, 0));
  r.apply(ev('RUN_ERROR', 'run-1', { message: 'Provider lỗi', code: 'E_PROVIDER' }, 1));
  assert.equal(r.getRun('run-1')?.status, 'failed');
  assert.equal(r.getRun('run-1')?.error, 'Provider lỗi');
  assert.equal(r.apply(null), false);
  assert.equal(r.apply({}), false);
  assert.equal(r.apply({ runId: '', type: 'RUN_STARTED', timestamp: '', data: {} }), false);
  const summaries = r.summaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].runId, 'run-1');
  assert.equal(r.dropRun('run-1'), true);
  assert.equal(r.getRun('run-1'), undefined);
  assert.equal(r.runCount, 0);
  r.clear();
});
