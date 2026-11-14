/**
 * Test v1.04 (Đội T4): event-log snapshot.
 *
 * - createRunSnapshot: fold prefix, digest khớp fold toàn bộ prefix,
 *   file ghi đúng tên/thư mục.
 * - restoreRunState: snapshot giữa log + fold tail → digest KHỚP fold
 *   toàn bộ (verifyRestoredState true); tailEvents đếm đúng.
 * - mergeReplayedStates: gộp trực tiếp snapshot state + tail fold →
 *   digest khớp fold toàn bộ (kể cả khi tail có run.completed mang
 *   tokensUsed tổng — không cộng dồn sai).
 * - loadRunSnapshot: snapshot bị sửa tay (digest sai) thì ném lỗi;
 *   snapshot không tồn tại thì ném lỗi.
 * - list/prune/delete snapshot.
 * - Snapshot rỗng (upToSeq 0) + restore từ đó vẫn khớp fold toàn bộ.
 *
 * Chỉ test thuần (không mạng). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eventlog-snapshot-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import { foldEvents } from '../packages/core/dist/event-log/replay.js';
import {
  createRunSnapshot,
  deleteRunSnapshot,
  listRunSnapshots,
  loadRunSnapshot,
  mergeReplayedStates,
  pruneRunSnapshots,
  restoreRunState,
  snapshotFilePath,
  tailMergeHints,
  verifyRestoredState,
} from '../packages/core/dist/event-log/snapshot.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-snapshot-v104-'));
}

function seedStore() {
  const dir = tmpDir();
  return { dir, store: new RunLogStore({ logDir: path.join(dir, 'run-logs') }) };
}

/** Ghi một run mẫu: started, prompt, 3 step (response+call+result), file.change, compile.error. */
function seedRun(store, runId) {
  store.append(runId, { type: 'run.started', payload: { botId: 'bot-1', title: 'demo' } });
  store.append(runId, { type: 'run.prompt', payload: { text: 'Làm giúp tôi việc X' } });
  for (let step = 0; step < 3; step += 1) {
    const callId = `c${step}`;
    store.append(runId, {
      type: 'model.response',
      payload: { step, text: `suy nghĩ ${step}`, toolCalls: [{ callId, tool: 'read_file', argKeys: ['path'] }], inputTokens: 10, outputTokens: 5 },
    });
    store.append(runId, { type: 'tool.call', payload: { callId, tool: 'read_file', argKeys: ['path'], step } });
    store.append(runId, {
      type: 'tool.result',
      payload: { callId, tool: 'read_file', status: 'ok', outputPreview: `nội dung ${step}`, durationMs: 12, step },
    });
  }
  store.append(runId, {
    type: 'file.change',
    payload: { kind: 'write', path: 'a.txt', tool: 'write_file', callId: 'c2', bytes: 10 },
  });
  store.append(runId, {
    type: 'compile.error',
    payload: { command: 'tsc', tool: 'run_shell', callId: 'c2', firstError: 'TS2304: lỗi mẫu' },
  });
  return store.readRun(runId).events;
}

test('createRunSnapshot: digest khớp fold prefix, file đúng chỗ', () => {
  const { store } = seedStore();
  const runId = 'run-snap-1';
  const events = seedRun(store, runId);
  const { snapshot, filePath } = createRunSnapshot(store, runId);
  assert.equal(snapshot.runId, runId);
  assert.equal(snapshot.upToSeq, events.length);
  assert.equal(snapshot.eventCount, events.length);
  assert.equal(filePath, snapshotFilePath(store, runId, events.length));
  assert.ok(fs.existsSync(filePath));
  const folded = foldEvents(runId, events);
  assert.equal(snapshot.digest, folded.digest);
  assert.equal(snapshot.state.prompt, 'Làm giúp tôi việc X');
  assert.equal(snapshot.state.toolCalls.length, 3);
  assert.equal(snapshot.state.compileErrors.length, 1);
});

test('restoreRunState: snapshot giữa log + tail → digest khớp fold toàn bộ', () => {
  const { store } = seedStore();
  const runId = 'run-snap-2';
  seedRun(store, runId);
  const midSeq = 5;
  createRunSnapshot(store, runId, { upToSeq: midSeq });
  // Append thêm event sau snapshot: 1 step nữa + completed mang tokensUsed TỔNG.
  store.append(runId, {
    type: 'model.response',
    payload: { step: 3, text: 'xong', toolCalls: [], inputTokens: 4, outputTokens: 3 },
  });
  store.append(runId, {
    type: 'run.completed',
    payload: { finalText: 'hoàn tất', steps: 4, toolCalls: 3, tokensUsed: 52, durationMs: 100 },
  });
  const restored = restoreRunState(store, runId);
  assert.equal(restored.snapshot.upToSeq, midSeq);
  assert.equal(restored.tailEvents, 10); // event 6..13 gốc + 2 event mới sau snapshot
  assert.equal(restored.state.status, 'completed');
  assert.equal(restored.state.steps, 4);
  // tokensUsed tổng = 52 (không cộng dồn sai: 45 + 52 = 97 là sai).
  assert.equal(restored.state.tokensUsed, 52);
  assert.equal(verifyRestoredState(store, runId, restored.state), true);
  assert.equal(restored.digest, foldEvents(runId, store.readRun(runId).events).digest);
});

test('mergeReplayedStates: gộp tay snapshot + tail fold → digest khớp', () => {
  const { store } = seedStore();
  const runId = 'run-snap-3';
  const events = seedRun(store, runId);
  const { snapshot } = createRunSnapshot(store, runId, { upToSeq: 6 });
  const tail = events.filter((e) => e.seq > 6);
  const merged = mergeReplayedStates(snapshot.state, foldEvents(runId, tail), tailMergeHints(tail));
  assert.equal(merged.digest, foldEvents(runId, events).digest);
  assert.equal(merged.toolCalls.length, 3);
  assert.equal(merged.fileChanges.length, 1);
  assert.equal(merged.compileErrors.length, 1);
});

test('loadRunSnapshot: snapshot bị sửa tay thì từ chối (digest sai)', () => {
  const { store } = seedStore();
  const runId = 'run-snap-4';
  seedRun(store, runId);
  const { filePath } = createRunSnapshot(store, runId);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  parsed.state.prompt = 'đã bị sửa';
  fs.writeFileSync(filePath, JSON.stringify(parsed), 'utf8');
  assert.throws(() => loadRunSnapshot(store, runId), /không hợp lệ/);
});

test('loadRunSnapshot: không có snapshot thì ném lỗi rõ', () => {
  const { store } = seedStore();
  assert.throws(() => loadRunSnapshot(store, 'run-khong-co'), /Không có snapshot/);
});

test('list/prune/delete snapshot', () => {
  const { store } = seedStore();
  const runId = 'run-snap-5';
  seedRun(store, runId);
  createRunSnapshot(store, runId, { upToSeq: 3 });
  createRunSnapshot(store, runId, { upToSeq: 6 });
  createRunSnapshot(store, runId, { upToSeq: 9 });
  assert.deepEqual(listRunSnapshots(store, runId).map((m) => m.upToSeq), [3, 6, 9]);
  assert.equal(pruneRunSnapshots(store, runId, 1), 2);
  assert.deepEqual(listRunSnapshots(store, runId).map((m) => m.upToSeq), [9]);
  assert.equal(deleteRunSnapshot(store, runId, 9), true);
  assert.deepEqual(listRunSnapshots(store, runId), []);
});

test('snapshot rỗng (upToSeq 0) + restore vẫn khớp fold toàn bộ', () => {
  const { store } = seedStore();
  const runId = 'run-snap-6';
  seedRun(store, runId);
  createRunSnapshot(store, runId, { upToSeq: 0 });
  const restored = restoreRunState(store, runId, { upToSeq: 0 });
  assert.equal(restored.snapshot.upToSeq, 0);
  assert.equal(verifyRestoredState(store, runId, restored.state), true);
  assert.equal(restored.state.prompt, 'Làm giúp tôi việc X');
});

test('createRunSnapshot: upToSeq ngoài khoảng thì ném lỗi', () => {
  const { store } = seedStore();
  const runId = 'run-snap-7';
  seedRun(store, runId);
  assert.throws(() => createRunSnapshot(store, runId, { upToSeq: 999 }), /ngoài khoảng/);
});
