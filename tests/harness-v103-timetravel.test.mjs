/**
 * Test v1.03 (Đội T1): time-travel / fork tại seq + redaction.
 *
 * - replayUpTo fold prefix tới đúng seq: trạng thái tại điểm cũ có
 *   ít step/token/tool hơn trạng thái đầy đủ; atSeq 0 → trạng thái rỗng.
 * - Hai lần time-travel cùng điểm → cùng digest (xác định).
 * - forkRunAt: trạng thái run con tại điểm fork có cùng digest với
 *   trạng thái cha tại cùng điểm; listChildRuns tìm thấy nhánh.
 * - compareRunStates: diff giữa hai thời điểm đúng số học.
 * - redactEvent: che model.response → text thành '[redacted]' khi
 *   fold; che prompt → prompt thành '[redacted]'; che tool.result lỗi
 *   → outputPreview che + chuỗi lỗi biến mất khỏi errors; marker
 *   không sửa event gốc trên đĩa (hash chain vẫn verify được).
 * - redactEvent từ chối seq không có, loại event không che được, lý
 *   do rỗng. findEventsContaining tìm đúng seq chứa secret.
 *
 * Chỉ test thuần (không mạng). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/harness-v103-timetravel.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import { foldEvents, REDACTED_TEXT } from '../packages/core/dist/event-log/replay.js';
import { compareRunStates, forkRunAt, listChildRuns, replayUpTo } from '../packages/core/dist/event-log/timeTravel.js';
import { findEventsContaining, redactEvent, redactedSeqs } from '../packages/core/dist/event-log/redaction.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-harness-v103-tt-'));
}

/** Seed một run 8 event: started, prompt, 2 step tool, completed. */
function seedRun() {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const runId = 'run-1';
  store.append(runId, { type: 'run.started', payload: { botId: 'bot-1', model: 'm', maxSteps: 10 } }); // 1
  store.append(runId, { type: 'run.prompt', payload: { text: 'viết file hello.txt rồi build' } }); // 2
  store.append(runId, {
    type: 'model.response',
    payload: { step: 0, text: 'Tôi sẽ tạo file.', toolCalls: [{ callId: 'c1', tool: 'write_file', argKeys: ['path'] }], inputTokens: 100, outputTokens: 20 },
  }); // 3
  store.append(runId, { type: 'tool.call', payload: { callId: 'c1', tool: 'write_file', argKeys: ['path'], step: 0, path: 'hello.txt' } }); // 4
  store.append(runId, {
    type: 'tool.result',
    payload: { callId: 'c1', tool: 'write_file', status: 'ok', outputPreview: 'Wrote hello.txt', durationMs: 12, step: 0 },
  }); // 5
  store.append(runId, { type: 'file.change', payload: { kind: 'write', path: 'hello.txt', tool: 'write_file', callId: 'c1' } }); // 6
  store.append(runId, {
    type: 'model.response',
    payload: { step: 1, text: 'Xong rồi, secret-key-abc123 nằm trong file.', toolCalls: [], inputTokens: 50, outputTokens: 10 },
  }); // 7
  store.append(runId, { type: 'run.completed', payload: { finalText: 'Xong rồi.', steps: 2, toolCalls: 1, tokensUsed: 180, durationMs: 100 } }); // 8
  return { store, runId, dir };
}

test('time-travel: replayUpTo trả trạng thái đúng tại từng điểm', () => {
  const { store, runId } = seedRun();
  const at3 = replayUpTo(store, runId, 3);
  assert.equal(at3.atSeq, 3);
  assert.equal(at3.totalSeq, 8);
  assert.equal(at3.eventsUsed, 3);
  assert.equal(at3.state.status, 'running');
  assert.equal(at3.state.prompt, 'viết file hello.txt rồi build');
  assert.equal(at3.state.steps, 1);
  assert.equal(at3.state.toolCalls.length, 1);

  const at0 = replayUpTo(store, runId, 0);
  assert.equal(at0.eventsUsed, 0);
  assert.equal(at0.state.status, 'running');
  assert.equal(at0.state.prompt, '');
  assert.equal(at0.state.steps, 0);

  const full = replayUpTo(store, runId, 8);
  assert.equal(full.state.status, 'completed');
  assert.equal(full.state.steps, 2);
  assert.equal(full.state.fileChanges.length, 1);

  // Hai lần time-travel cùng điểm → cùng digest.
  assert.equal(replayUpTo(store, runId, 5).state.digest, replayUpTo(store, runId, 5).state.digest);
  assert.notEqual(at3.state.digest, full.state.digest);
});

test('time-travel: atSeq ngoài khoảng / run rỗng ném lỗi', () => {
  const { store, runId } = seedRun();
  assert.throws(() => replayUpTo(store, runId, 9), /ngoài khoảng/);
  assert.throws(() => replayUpTo(store, runId, -1), /ngoài khoảng/);
  assert.throws(() => replayUpTo(store, 'run-khong-co', 1), /chưa có event/);
});

test('fork: forkRunAt cho digest bằng cha tại điểm fork; listChildRuns thấy nhánh', () => {
  const { store, runId } = seedRun();
  const parentAt5 = replayUpTo(store, runId, 5).state;
  const fork = forkRunAt(store, runId, 5, { childRunId: 'run-1-fork' });
  assert.equal(fork.parentRunId, runId);
  assert.equal(fork.childRunId, 'run-1-fork');
  assert.equal(fork.forkFromSeq, 5);
  assert.equal(fork.copiedEvents, 4); // prefix 1..5 trừ run.started của cha
  // Trạng thái con tại điểm fork bằng trạng thái cha tại cùng điểm —
  // trừ startedAt (con có event run.started riêng, ghi lúc fork) nên
  // digest khác nhau ở đúng field đó; các field nội dung phải bằng.
  assert.equal(fork.childStateAtFork.status, parentAt5.status);
  assert.equal(fork.childStateAtFork.prompt, parentAt5.prompt);
  assert.equal(fork.childStateAtFork.steps, parentAt5.steps);
  assert.equal(fork.childStateAtFork.tokensUsed, parentAt5.tokensUsed);
  assert.equal(fork.childStateAtFork.toolCalls.length, parentAt5.toolCalls.length);
  assert.deepEqual(fork.childStateAtFork.transcript, parentAt5.transcript);
  assert.notEqual(fork.childStateAtFork.startedAt, parentAt5.startedAt);

  const branches = listChildRuns(store, runId);
  assert.equal(branches.length, 1);
  assert.equal(branches[0].runId, 'run-1-fork');
  assert.equal(branches[0].forkFromSeq, 5);

  // Run cha không đổi: vẫn 8 event, digest đầy đủ như cũ.
  assert.equal(store.readRun(runId).events.length, 9); // +1 run.forked
  assert.equal(replayUpTo(store, runId, 8).state.status, 'completed');
  // Fork lại cùng childRunId bị từ chối (không ghi đè log).
  assert.throws(() => forkRunAt(store, runId, 5, { childRunId: 'run-1-fork' }), /đã tồn tại/);
});

test('compareRunStates: diff giữa hai thời điểm đúng số học', () => {
  const { store, runId } = seedRun();
  const early = replayUpTo(store, runId, 3).state;
  const full = foldEvents(runId, store.readRun(runId).events);
  const diff = compareRunStates(early, full);
  assert.equal(diff.stepsDelta, 1);
  assert.equal(diff.tokensDelta, 60);
  assert.equal(diff.fileChangesDelta, 1);
  assert.equal(diff.statusChanged, true);
  assert.match(diff.summary, /status running → completed/);
  assert.equal(compareRunStates(full, full).summary, 'identical');
});

test('redaction: che model.response che text + tool result của nó', () => {
  const { store, runId } = seedRun();
  // seq 3 là model.response step 0 (text + tool call c1).
  const res = redactEvent(store, runId, 3, 'secret-leaked', 'user-1');
  assert.equal(res.redactedSeq, 3);
  assert.ok(res.markerSeq > 8);
  const state = foldEvents(runId, store.readRun(runId).events);
  assert.deepEqual(state.redactedSeqs, [3]);
  assert.equal(state.transcript[0].text, REDACTED_TEXT);
  // tool result của c1 (seq 5) cũng bị che vì thuộc response seq 3.
  const toolResult = state.transcript.find((e) => e.kind === 'tool_result');
  assert.equal(toolResult.outputPreview, REDACTED_TEXT);
  assert.equal(state.toolCalls[0].outputPreview, REDACTED_TEXT);
  // Log gốc trên đĩa vẫn còn nguyên + hash chain verify được.
  const raw = store.readRun(runId).events.find((e) => e.seq === 3);
  assert.equal(raw.payload.text, 'Tôi sẽ tạo file.');
  assert.equal(store.verify(runId).ok, true);
});

test('redaction: che prompt + tool.result lỗi gỡ cả chuỗi lỗi', () => {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  store.append('run-2', { type: 'run.started', payload: { botId: 'bot-1' } });
  store.append('run-2', { type: 'run.prompt', payload: { text: 'mật khẩu là hunter2' } });
  store.append('run-2', {
    type: 'model.response',
    payload: { step: 0, text: '', toolCalls: [{ callId: 'c1', tool: 'run_command', argKeys: ['command'] }] },
  });
  store.append('run-2', {
    type: 'tool.result',
    payload: { callId: 'c1', tool: 'run_command', status: 'error', outputPreview: 'hunter2 leaked', durationMs: 3, step: 0 },
  });
  store.append('run-2', { type: 'run.failed', payload: { message: 'fail', steps: 1, toolCalls: 1, durationMs: 5 } });

  redactEvent(store, 'run-2', 2, 'pii');
  redactEvent(store, 'run-2', 4, 'secret-leaked');
  const state = foldEvents('run-2', store.readRun('run-2').events);
  assert.equal(state.prompt, REDACTED_TEXT);
  assert.deepEqual(state.redactedSeqs, [2, 4]);
  assert.deepEqual(state.errors, ['fail']); // chuỗi lỗi tool đã gỡ
  assert.equal(state.toolCalls[0].outputPreview, REDACTED_TEXT);
});

test('redaction: từ chối seq không có, loại không che được, lý do rỗng', () => {
  const { store, runId } = seedRun();
  assert.throws(() => redactEvent(store, runId, 99, 'x'), /không có event/);
  assert.throws(() => redactEvent(store, runId, 0, 'x'), /không hợp lệ/);
  assert.throws(() => redactEvent(store, runId, 1, 'x'), /không có nội dung text/); // run.started
  assert.throws(() => redactEvent(store, runId, 3, '   '), /cần ghi lý do/);
});

test('redaction: findEventsContaining tìm đúng seq chứa secret', () => {
  const { store, runId } = seedRun();
  const hits = findEventsContaining(store, runId, 'secret-key-abc123');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].seq, 7);
  assert.equal(hits[0].type, 'model.response');
  assert.deepEqual(findEventsContaining(store, runId, '   '), []);
  assert.deepEqual(findEventsContaining(store, runId, 'khong-co-chuoi-nay'), []);
  // redactedSeqs đọc marker từ dãy event.
  redactEvent(store, runId, 7, 'secret-leaked');
  assert.deepEqual(redactedSeqs(store.readRun(runId).events), [7]);
});
