/**
 * Test v1.04 (Đội T4): condenser v2 — 3 chiến lược + đo token saved thật.
 *
 * - summarize: tóm tắt trích xuất v1, tokensAfter < tokensBefore, saved > 0.
 * - truncate: giữ đầu + cuối nguyên văn, bỏ giữa (có ghi khoảng seq đã bỏ),
 *   keptTranscript chứa event đầu/cuối, dropped > 0.
 * - extract-keep: lỗi + file change + prompt giữ nguyên văn trong
 *   keptTranscript; phần còn lại tóm tắt.
 * - recommendStrategy: log nhiều lỗi → extract-keep; log rất dài ít lỗi →
 *   truncate; log vừa → summarize.
 * - compactRunV2: append marker run.compacted; fold đọc lại được compactions.
 * - condenseRunV2 trên run rỗng → ném lỗi.
 *
 * Chỉ test thuần (không mạng). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/condenser-v2-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import { foldEvents } from '../packages/core/dist/event-log/replay.js';
import {
  compactRunV2,
  condenseEventsV2,
  condenseRunV2,
  countErrorEvents,
  describeEventLine,
  estimateEventsTokens,
  recommendStrategy,
} from '../packages/core/dist/event-log/condenser-v2.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-condv2-v104-'));
}

function seedStore() {
  const dir = tmpDir();
  return new RunLogStore({ logDir: path.join(dir, 'run-logs') });
}

/** Ghi run mẫu: started + prompt + `steps` step, `errorEvery` step thì tool lỗi. */
function seedRun(store, runId, steps, errorEvery = 0) {
  store.append(runId, { type: 'run.started', payload: { botId: 'bot-1', title: 'demo' } });
  store.append(runId, { type: 'run.prompt', payload: { text: 'Nhiệm vụ dài cần nhiều bước xử lý dữ liệu' } });
  for (let step = 0; step < steps; step += 1) {
    const callId = `c${step}`;
    const isError = errorEvery > 0 && step % errorEvery === 0;
    store.append(runId, {
      type: 'model.response',
      payload: {
        step,
        text: `đang xử lý bước ${step} với dữ liệu mẫu dài dòng để tốn token thật sự trong log`,
        toolCalls: [{ callId, tool: 'read_file', argKeys: ['path'] }],
        inputTokens: 20,
        outputTokens: 10,
      },
    });
    store.append(runId, { type: 'tool.call', payload: { callId, tool: 'read_file', argKeys: ['path'], step } });
    store.append(runId, {
      type: 'tool.result',
      payload: {
        callId,
        tool: 'read_file',
        status: isError ? 'error' : 'ok',
        outputPreview: isError ? `lỗi đọc file ở bước ${step}: ENOENT file-${step}.txt không tồn tại` : `nội dung file bước ${step} dài dòng để tốn token`,
        durationMs: 15,
        step,
      },
    });
    if (step % 5 === 4) {
      store.append(runId, {
        type: 'file.change',
        payload: { kind: 'write', path: `out-${step}.txt`, tool: 'write_file', callId, bytes: 100 },
      });
    }
  }
  store.append(runId, {
    type: 'run.completed',
    payload: { finalText: 'hoàn tất nhiệm vụ dài', steps, toolCalls: steps, durationMs: 1000 },
  });
  return store.readRun(runId).events;
}

test('summarize: tokensAfter < tokensBefore, saved đo thật', () => {
  const store = seedStore();
  const events = seedRun(store, 'run-cv2-1', 20);
  const report = condenseEventsV2(events, { strategy: 'summarize' });
  assert.equal(report.strategy, 'summarize');
  assert.equal(report.eventsCovered, events.length);
  assert.equal(report.tokensBefore, estimateEventsTokens(events));
  assert.ok(report.tokensAfter < report.tokensBefore, `after ${report.tokensAfter} < before ${report.tokensBefore}`);
  assert.equal(report.tokensSaved, report.tokensBefore - report.tokensAfter);
  assert.ok(report.savedRatioPct > 0);
  assert.match(report.summary, /Prompt:/);
  assert.match(report.summary, /Tools:/);
});

test('truncate: giữ đầu + cuối, bỏ giữa, ghi rõ khoảng seq đã bỏ', () => {
  const store = seedStore();
  const events = seedRun(store, 'run-cv2-2', 20);
  const report = condenseEventsV2(events, { strategy: 'truncate', keepHeadEvents: 3, keepTailEvents: 5 });
  assert.equal(report.strategy, 'truncate');
  assert.equal(report.eventsKept, 8);
  assert.equal(report.eventsDropped, events.length - 8);
  assert.ok(report.keptTranscript !== undefined);
  assert.match(report.keptTranscript, /#1 run\.started/);
  assert.match(report.keptTranscript, /đã bỏ, seq/);
  // Event cuối (run.completed) còn trong phần giữ.
  assert.match(report.keptTranscript, /run\.completed/);
  assert.ok(report.tokensBefore > 0 && report.tokensAfter > 0);
  assert.equal(report.tokensSaved, report.tokensBefore - report.tokensAfter);
});

test('extract-keep: lỗi + file change giữ nguyên văn, phần còn lại tóm tắt', () => {
  const store = seedStore();
  // 10 step, lỗi mỗi 2 step → 5 lỗi (tỉ lệ cao).
  const events = seedRun(store, 'run-cv2-3', 10, 2);
  assert.ok(countErrorEvents(events) >= 5);
  const report = condenseEventsV2(events, { strategy: 'extract-keep' });
  assert.equal(report.strategy, 'extract-keep');
  assert.ok(report.keptTranscript !== undefined);
  // Lỗi đọc file giữ nguyên văn từng chữ trong keptTranscript.
  assert.match(report.keptTranscript, /lỗi đọc file ở bước 0/);
  assert.match(report.keptTranscript, /ENOENT file-0\.txt/);
  // File change cũng giữ.
  assert.match(report.keptTranscript, /file\.change/);
  // Prompt giữ.
  assert.match(report.keptTranscript, /run\.prompt/);
  assert.ok(report.tokensAfter < report.tokensBefore);
});

test('recommendStrategy: theo hình dạng log', () => {
  const store = seedStore();
  // Nhiều lỗi → extract-keep (10 lỗi / 35 event ≈ 29% >= 20%).
  const errorHeavy = seedRun(store, 'run-cv2-4', 10, 1);
  assert.equal(recommendStrategy(errorHeavy).strategy, 'extract-keep');
  // Rất dài, ít lỗi → truncate.
  const longClean = seedRun(store, 'run-cv2-5', 70);
  assert.equal(recommendStrategy(longClean).strategy, 'truncate');
  // Vừa, ít lỗi → summarize.
  const medium = seedRun(store, 'run-cv2-6', 10);
  assert.equal(recommendStrategy(medium).strategy, 'summarize');
  // Rỗng → summarize mặc định.
  assert.equal(recommendStrategy([]).strategy, 'summarize');
});

test('compactRunV2: append marker, fold đọc lại được compactions', () => {
  const store = seedStore();
  seedRun(store, 'run-cv2-7', 15);
  const result = compactRunV2(store, 'run-cv2-7', { strategy: 'summarize' });
  assert.ok(result.markerSeq > 0);
  assert.ok(result.tokensSaved > 0);
  const state = foldEvents('run-cv2-7', store.readRun('run-cv2-7').events);
  assert.equal(state.compactions?.length, 1);
  assert.equal(state.compactions?.[0]?.tokensBefore, result.tokensBefore);
  assert.equal(state.compactions?.[0]?.tokensAfter, result.tokensAfter);
  // Log gốc không mất event nào (chỉ thêm marker).
  assert.equal(store.readRun('run-cv2-7').events.length, result.eventsCovered + 1);
});

test('condenseRunV2: strategy mặc định lấy từ recommendStrategy', () => {
  const store = seedStore();
  seedRun(store, 'run-cv2-8', 10, 1);
  const report = condenseRunV2(store, 'run-cv2-8');
  assert.equal(report.strategy, 'extract-keep');
});

test('condenseRunV2: run rỗng thì ném lỗi; describeEventLine cắt dài', () => {
  const store = seedStore();
  assert.throws(() => condenseRunV2(store, 'run-khong-co'), /chưa có event/);
  const line = describeEventLine({
    seq: 1,
    runId: 'r',
    at: '2026-01-01T00:00:00.000Z',
    type: 'tool.result',
    payload: { callId: 'c1', tool: 'x', status: 'ok', outputPreview: 'a'.repeat(500), durationMs: 1, step: 0 },
    prevHash: '',
    hash: 'h',
  });
  assert.ok(line.length <= 260);
  assert.match(line, /tool\.result/);
});
