/**
 * Test v1.03 (Đội T1): stuck detection + condenser.
 *
 * Stuck:
 * - Cùng tool call (tool + argKeys) lặp 3 lần → kẹt, kind
 *   repeat_tool_call, suggestionKey harness.v103.stuck.repeatTool.
 * - 2 lần lặp chưa đủ ngưỡng → không kẹt. Cùng tool nhưng khác
 *   argKeys → không tính là lặp. Cùng một lần gọi ghi ở cả
 *   model.response và tool.call → chỉ đếm 1 lần (không báo kẹt giả).
 * - Cùng tool lỗi 3 lần → repeat_tool_error; cùng compile error 3
 *   lần → repeat_compile_error; response rỗng kèm tool call 3 lần →
 *   empty_response_loop; nhiều step không tiến triển → no_progress;
 *   dùng >= 80% step budget → step_budget.
 * - recordStuckDetection append event stuck.detected; fold đọc lại
 *   được trong state.stuckDetections.
 *
 * Condenser:
 * - condenseEvents: summary chứa prompt, tool counts, file changes,
 *   outcome; tokensAfter < tokensBefore; upToSeq tôn trọng giới hạn.
 * - shouldCondense: vượt ngưỡng event/token thì needed, dưới thì không.
 * - compactRun: append marker run.compacted; fold đọc lại được trong
 *   state.compactions; log gốc không mất event nào.
 *
 * Chỉ test thuần (không mạng). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/harness-v103-stuck-condenser.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import { foldEvents } from '../packages/core/dist/event-log/replay.js';
import {
  STUCK_SUGGESTION_KEYS,
  detectStuck,
  detectStuckForRun,
  recordStuckDetection,
} from '../packages/core/dist/event-log/stuck.js';
import {
  compactRun,
  condenseEvents,
  estimateEventTokens,
  shouldCondense,
} from '../packages/core/dist/event-log/condenser.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-harness-v103-sc-'));
}

function seedStore() {
  const dir = tmpDir();
  return new RunLogStore({ logDir: path.join(dir, 'run-logs') });
}

/** Một step: response (text + 1 tool call) + tool.call + tool.result. */
function appendStep(store, runId, step, tool, argKeys, status, outputPreview, text = '') {
  const callId = `c${step}-${tool}`;
  store.append(runId, {
    type: 'model.response',
    payload: { step, text, toolCalls: [{ callId, tool, argKeys }], inputTokens: 10, outputTokens: 5 },
  });
  store.append(runId, { type: 'tool.call', payload: { callId, tool, argKeys, step } });
  store.append(runId, {
    type: 'tool.result',
    payload: { callId, tool, status, outputPreview, durationMs: 5, step },
  });
}

function seedLoopRun({ steps, tool, argKeys, status, outputPreview }) {
  const store = seedStore();
  const runId = 'run-loop';
  store.append(runId, { type: 'run.started', payload: { botId: 'bot-1', maxSteps: 10 } });
  store.append(runId, { type: 'run.prompt', payload: { text: 'làm đi' } });
  for (let s = 0; s < steps; s++) {
    appendStep(store, runId, s, tool, argKeys, status, outputPreview);
  }
  return { store, runId };
}

test('stuck: cùng tool call lặp 3 lần → kẹt repeat_tool_call', () => {
  const { store, runId } = seedLoopRun({
    steps: 3, tool: 'read_file', argKeys: ['path'], status: 'ok', outputPreview: 'same content',
  });
  const report = detectStuckForRun(store, runId);
  assert.equal(report.stuck, true);
  assert.equal(report.signals[0].kind, 'repeat_tool_call');
  assert.equal(report.signals[0].count, 3);
  assert.equal(report.suggestionKey, 'harness.v103.stuck.repeatTool');
  assert.equal(STUCK_SUGGESTION_KEYS.repeat_tool_call, 'harness.v103.stuck.repeatTool');
});

test('stuck: 2 lần lặp chưa kẹt; khác argKeys không tính lặp; trùng response+call đếm 1 lần', () => {
  const { store, runId } = seedLoopRun({
    steps: 2, tool: 'read_file', argKeys: ['path'], status: 'ok', outputPreview: 'x',
  });
  assert.equal(detectStuckForRun(store, runId).stuck, false);

  // Khác argKeys → không lặp (dù cùng tool, 3 lần). Text khác rỗng để
  // không kích hoạt empty_response_loop.
  const store2 = seedStore();
  store2.append('r2', { type: 'run.started', payload: { botId: 'b' } });
  store2.append('r2', { type: 'run.prompt', payload: { text: 'p' } });
  appendStep(store2, 'r2', 0, 'read_file', ['path'], 'ok', 'x', 'reading a');
  appendStep(store2, 'r2', 1, 'read_file', ['path', 'offset'], 'ok', 'x', 'reading b');
  appendStep(store2, 'r2', 2, 'read_file', ['path', 'limit'], 'ok', 'x', 'reading c');
  assert.equal(detectStuckForRun(store2, 'r2').stuck, false);

  // Một lần gọi duy nhất ghi ở cả response + tool.call → count 1, không kẹt.
  const store3 = seedStore();
  store3.append('r3', { type: 'run.started', payload: { botId: 'b' } });
  store3.append('r3', { type: 'run.prompt', payload: { text: 'p' } });
  appendStep(store3, 'r3', 0, 'write_file', ['path'], 'ok', 'wrote');
  const report3 = detectStuck('r3', store3.readRun('r3').events);
  assert.equal(report3.stuck, false);
  assert.deepEqual(report3.signals, []);
});

test('stuck: cùng tool lỗi 3 lần → repeat_tool_error; khác tool lỗi không tính', () => {
  const { store, runId } = seedLoopRun({
    steps: 3, tool: 'run_command', argKeys: ['command'], status: 'error', outputPreview: 'boom',
  });
  const report = detectStuckForRun(store, runId);
  assert.ok(report.signals.some((s) => s.kind === 'repeat_tool_error' && s.count === 3));
  assert.ok(report.signals.some((s) => s.kind === 'repeat_tool_call'));

  // Lỗi ở 3 tool khác nhau → không có repeat_tool_error.
  const store2 = seedStore();
  store2.append('r2', { type: 'run.started', payload: { botId: 'b' } });
  store2.append('r2', { type: 'run.prompt', payload: { text: 'p' } });
  appendStep(store2, 'r2', 0, 'tool_a', ['x'], 'error', 'e1');
  appendStep(store2, 'r2', 1, 'tool_b', ['x'], 'error', 'e2');
  appendStep(store2, 'r2', 2, 'tool_c', ['x'], 'error', 'e3');
  assert.equal(detectStuckForRun(store2, 'r2').signals.some((s) => s.kind === 'repeat_tool_error'), false);
});

test('stuck: compile error lặp + response rỗng lặp', () => {
  const store = seedStore();
  store.append('r', { type: 'run.started', payload: { botId: 'b' } });
  store.append('r', { type: 'run.prompt', payload: { text: 'build' } });
  for (let s = 0; s < 3; s++) {
    store.append('r', {
      type: 'model.response',
      payload: { step: s, text: '', toolCalls: [{ callId: `cc${s}`, tool: 'run_command', argKeys: ['command'] }] },
    });
    store.append('r', {
      type: 'tool.result',
      payload: { callId: `cc${s}`, tool: 'run_command', status: 'error', outputPreview: 'tsc fail', durationMs: 2, step: s },
    });
    store.append('r', {
      type: 'compile.error',
      payload: { command: 'tsc', tool: 'run_command', callId: `cc${s}`, firstError: 'error TS2322: Type string', errorCount: 1 },
    });
  }
  const report = detectStuckForRun(store, 'r');
  assert.equal(report.stuck, true);
  assert.ok(report.signals.some((s) => s.kind === 'repeat_compile_error' && s.count === 3));
  assert.ok(report.signals.some((s) => s.kind === 'empty_response_loop' && s.count === 3));
});

test('stuck: no_progress khi 8+ step không file change / tool ok; step_budget ở 80%', () => {
  // 9 step, tool khác nhau mỗi step, đều lỗi → không tiến triển.
  const store = seedStore();
  store.append('r', { type: 'run.started', payload: { botId: 'b', maxSteps: 100 } });
  store.append('r', { type: 'run.prompt', payload: { text: 'p' } });
  for (let s = 0; s < 9; s++) {
    appendStep(store, 'r', s, `tool_${s}`, ['x'], 'error', `err ${s}`);
  }
  const report = detectStuckForRun(store, 'r');
  const noProgress = report.signals.find((s) => s.kind === 'no_progress');
  assert.ok(noProgress, 'expected no_progress signal');
  assert.equal(noProgress.count, 9);

  // Step budget: maxSteps 5, đã dùng 4 step → cảnh báo.
  const store2 = seedStore();
  store2.append('r2', { type: 'run.started', payload: { botId: 'b', maxSteps: 5 } });
  store2.append('r2', { type: 'run.prompt', payload: { text: 'p' } });
  for (let s = 0; s < 4; s++) {
    appendStep(store2, 'r2', s, `tool_${s}`, ['x'], 'ok', 'ok');
  }
  const report2 = detectStuckForRun(store2, 'r2');
  assert.ok(report2.signals.some((s) => s.kind === 'step_budget'));
});

test('stuck: log rỗng không kẹt; recordStuckDetection ghi event audit', () => {
  assert.equal(detectStuck('r-empty', []).stuck, false);
  const { store, runId } = seedLoopRun({
    steps: 3, tool: 'read_file', argKeys: ['path'], status: 'ok', outputPreview: 'same',
  });
  const report = detectStuckForRun(store, runId);
  const markerSeq = recordStuckDetection(store, runId, report);
  assert.ok(markerSeq > 0);
  const state = foldEvents(runId, store.readRun(runId).events);
  assert.equal(state.stuckDetections.length, 1);
  assert.equal(state.stuckDetections[0].kind, 'repeat_tool_call');
  assert.equal(state.stuckDetections[0].suggestionKey, 'harness.v103.stuck.repeatTool');
  // Không kẹt → record trả 0, không ghi event.
  const store2 = seedStore();
  store2.append('ok-run', { type: 'run.started', payload: { botId: 'b' } });
  store2.append('ok-run', { type: 'run.prompt', payload: { text: 'p' } });
  assert.equal(recordStuckDetection(store2, 'ok-run', detectStuckForRun(store2, 'ok-run')), 0);
  assert.throws(() => detectStuckForRun(store2, 'run-khong-co'), /chưa có event/);
});

test('condenser: condenseEvents tóm tắt đúng + tiết kiệm token', () => {
  const store = seedStore();
  store.append('r', { type: 'run.started', payload: { botId: 'bot-1', maxSteps: 10 } });
  store.append('r', { type: 'run.prompt', payload: { text: 'viết file hello.txt rồi build thử' } });
  appendStep(store, 'r', 0, 'write_file', ['path'], 'ok', 'Wrote hello.txt');
  store.append('r', { type: 'file.change', payload: { kind: 'write', path: 'hello.txt', tool: 'write_file', callId: 'c0-write_file' } });
  appendStep(store, 'r', 1, 'run_command', ['command'], 'error', 'error TS2322');
  store.append('r', {
    type: 'compile.error',
    payload: { command: 'tsc', tool: 'run_command', callId: 'c1-run_command', firstError: 'error TS2322', errorCount: 1 },
  });
  store.append('r', { type: 'run.completed', payload: { finalText: 'Xong.', steps: 2, toolCalls: 2, tokensUsed: 100, durationMs: 50 } });
  const events = store.readRun('r').events;
  const c = condenseEvents(events);
  assert.equal(c.eventsCovered, events.length);
  assert.equal(c.upToSeq, events[events.length - 1].seq);
  assert.ok(c.summary.includes('viết file hello.txt'));
  assert.ok(c.summary.includes('write_file x1'));
  assert.ok(c.summary.includes('run_command x1 (1 errors)'));
  assert.ok(c.summary.includes('hello.txt'));
  assert.ok(c.summary.includes('error TS2322'));
  assert.ok(c.summary.includes('Xong.'));
  assert.ok(c.tokensAfter < c.tokensBefore, `${c.tokensAfter} < ${c.tokensBefore}`);
  assert.ok(c.summary.length <= 1500);
  // upToSeq giới hạn prefix.
  const partial = condenseEvents(events, { upToSeq: 3 });
  assert.equal(partial.eventsCovered, 3);
  assert.equal(partial.upToSeq, 3);
  // estimateEventTokens: event dài tốn nhiều token hơn event ngắn.
  assert.ok(estimateEventTokens(events[1]) > estimateEventTokens(events[0]));
  // Log rỗng → condensation rỗng.
  assert.deepEqual(condenseEvents([]), { upToSeq: 0, eventsCovered: 0, summary: '', tokensBefore: 0, tokensAfter: 0 });
});

test('condenser: shouldCondense theo ngưỡng; compactRun ghi marker, giữ nguyên log', () => {
  const store = seedStore();
  store.append('r', { type: 'run.started', payload: { botId: 'b' } });
  store.append('r', { type: 'run.prompt', payload: { text: 'p' } });
  const events = store.readRun('r').events;
  assert.equal(shouldCondense(events).needed, false);
  assert.equal(shouldCondense(events, { minEvents: 2 }).needed, true);
  assert.equal(shouldCondense(events, { minTokens: 1 }).needed, true);

  const before = store.readRun('r').events.length;
  const result = compactRun(store, 'r');
  assert.ok(result.markerSeq > 0);
  assert.equal(result.eventsCovered, before);
  assert.ok(result.summary.length > 0);
  const after = store.readRun('r').events;
  assert.equal(after.length, before + 1); // chỉ thêm marker, không xoá gì
  assert.equal(after[after.length - 1].type, 'run.compacted');
  const state = foldEvents('r', after);
  assert.equal(state.compactions.length, 1);
  assert.equal(state.compactions[0].upToSeq, before);
  assert.equal(store.verify('r').ok, true);
  assert.throws(() => compactRun(store, 'run-khong-co'), /chưa có event/);
});
