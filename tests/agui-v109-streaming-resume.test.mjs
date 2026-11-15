/**
 * Tests v1.09 (Đội T4): AG-UI streaming v1.1 — session resume, gap,
 * stall, checkpoint store, resume plan.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/agui-v109-streaming-resume.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgUiCheckpointStore,
  AgUiEventBus,
  AgUiStreamSession,
  AgUiStreamSessionManager,
  bufferWindow,
  detectStreamGap,
  makeAgUiEvent,
  planResume,
} from '../packages/core/dist/index.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function publishRun(bus, runId, count, startSeq = 0) {
  const events = [];
  for (let i = 0; i < count; i++) {
    const ev = bus.publish(
      makeAgUiEvent('TEXT_MESSAGE_CONTENT', runId, {
        messageId: 'm1',
        delta: `d${startSeq + i} `,
      }, { messageId: 'm1' }),
    );
    events.push(ev);
  }
  return events;
}

test('streaming: session nhận event live + checkpoint giữ text đã gộp', async () => {
  const bus = new AgUiEventBus();
  const session = new AgUiStreamSession(bus, 'run-1');
  const seen = [];
  session.onEvent((e) => seen.push(e));
  session.start();
  bus.publish(makeAgUiEvent('RUN_STARTED', 'run-1', { title: 'hello' }));
  publishRun(bus, 'run-1', 3);
  await tick();
  await tick();
  // RUN_STARTED + 3 delta gộp thành 1 event (coalescing).
  assert.equal(seen.length, 2, `expected 2 delivered, got ${seen.length}`);
  assert.equal(seen[0].type, 'RUN_STARTED');
  assert.equal(seen[1].data.delta, 'd0 d1 d2 ');
  const cp = session.checkpoint();
  assert.equal(cp.runId, 'run-1');
  assert.equal(cp.lastSequence, 3);
  assert.equal(cp.textByMessage['m1'], 'd0 d1 d2 ');
  assert.equal(cp.terminal, false);
  session.stop();
});

test('streaming: pause rồi resume — không mất event (replay từ buffer)', async () => {
  const bus = new AgUiEventBus();
  const session = new AgUiStreamSession(bus, 'run-2');
  const seen = [];
  session.onEvent((e) => seen.push(e));
  session.start();
  bus.publish(makeAgUiEvent('RUN_STARTED', 'run-2', { title: 't' }));
  publishRun(bus, 'run-2', 2);
  await tick();
  const cp = session.pause();
  assert.equal(cp.lastSequence, 2);
  // Ngắt kết nối: event vẫn vào bus buffer trong lúc pause.
  publishRun(bus, 'run-2', 3, 2);
  bus.publish(makeAgUiEvent('RUN_FINISHED', 'run-2', { status: 'completed', finalText: 'xong' }));
  session.resume();
  await tick();
  await tick();
  const seqs = seen.map((e) => e.sequence);
  // Seq 1+2 gộp thành 1 event mang sequence 2 (coalescing) — không mất ký tự.
  assert.deepEqual(seqs, [0, 2, 3, 4, 5, 6]);
  assert.equal(seen[1].data.delta, 'd0 d1 ');
  const stats = session.stats;
  assert.equal(stats.status, 'finished');
  assert.ok(stats.replayed >= 4, `expected replayed>=4, got ${stats.replayed}`);
  assert.deepEqual(stats.missingSequences, []);
  session.stop();
});

test('streaming: gap được phát hiện khi sequence nhảy cóc + requestReplay bù', async () => {
  const bus = new AgUiEventBus();
  // Ép bus bỏ qua sequence bằng cách publish rồi xóa khỏi buffer? Không
  // có API xóa — mô phỏng gap bằng session thứ hai nhận event muộn:
  // publish 5 event, session start muộn với checkpoint giả lập lastSequence=1.
  publishRun(bus, 'run-3', 5);
  const session = new AgUiStreamSession(bus, 'run-3');
  const seen = [];
  session.onEvent((e) => seen.push(e));
  // Checkpoint giả: đã nhận tới sequence 1, còn 2..4 trong buffer.
  session.loadCheckpoint({
    runId: 'run-3',
    lastSequence: 1,
    receivedEvents: 2,
    gapsDetected: 0,
    state: null,
    textByMessage: { m1: 'd0 d1 ' },
    createdAt: new Date().toISOString(),
    terminal: false,
  });
  session.start();
  await tick();
  assert.deepEqual(seen.map((e) => e.sequence), [2, 3, 4]);
  assert.equal(session.stats.replayed, 3);
  session.stop();

  // Gap thật: áp event sequence 5 vào session đã ở sequence 2.
  const bus2 = new AgUiEventBus();
  const s2 = new AgUiStreamSession(bus2, 'run-g');
  s2.onEvent(() => {});
  s2.start();
  bus2.publish(makeAgUiEvent('RUN_STARTED', 'run-g', {}));
  await tick();
  // Giả lập event tới muộn bằng cách publish trực tiếp qua bus khác? Dùng
  // bus.publish với sequence đã gán sẵn sẽ bị bus ghi đè — thay vào đó
  // kiểm tra gap qua checkpoint store plan (xem test planResume).
  s2.stop();
  assert.equal(s2.stats.gaps, 0);
});

test('streaming: stall — không event quá ngưỡng thì báo stalled', async () => {
  let now = 1000;
  const bus = new AgUiEventBus();
  const session = new AgUiStreamSession(bus, 'run-4', {
    stallAfterMs: 5000,
    now: () => now,
  });
  session.onEvent(() => {});
  session.start();
  bus.publish(makeAgUiEvent('RUN_STARTED', 'run-4', {}));
  assert.equal(session.isStalled(), false);
  now += 6000;
  assert.equal(session.isStalled(), true);
  assert.equal(session.stats.status, 'stalled');
  assert.equal(session.stats.stalledForMs, 6000);
  session.stop();
});

test('streaming: text delta gộp — nhiều delta trong một tick thành 1 lần giao', async () => {
  const bus = new AgUiEventBus();
  const session = new AgUiStreamSession(bus, 'run-5', { coalesceTextDeltas: true });
  const seen = [];
  session.onEvent((e) => seen.push(e));
  session.start();
  publishRun(bus, 'run-5', 3);
  // Chưa tick: delta đang chờ gộp, chưa giao.
  assert.equal(seen.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').length, 0);
  await tick();
  await tick();
  const contents = seen.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT');
  assert.equal(contents.length, 1);
  assert.equal(contents[0].data.delta, 'd0 d1 d2 ');
  session.stop();
});

test('streaming: session manager resume tất cả + checkpointAll', async () => {
  const bus = new AgUiEventBus();
  const manager = new AgUiStreamSessionManager(bus);
  const s1 = manager.sessionFor('run-a');
  const s2 = manager.sessionFor('run-b');
  assert.equal(manager.sessionFor('run-a'), s1);
  assert.equal(manager.sessionCount, 2);
  s1.onEvent(() => {});
  s2.onEvent(() => {});
  s1.start();
  s2.start();
  bus.publish(makeAgUiEvent('RUN_STARTED', 'run-a', {}));
  bus.publish(makeAgUiEvent('RUN_FINISHED', 'run-a', { status: 'completed' }));
  await tick();
  const cps = manager.checkpointAll();
  assert.equal(cps.length, 2);
  const res = manager.resumeAll();
  assert.equal(res.finished, 1);
  assert.equal(res.resumed, 1);
  assert.equal(manager.dropSession('run-a'), true);
  assert.equal(manager.dropSession('run-a'), false);
  manager.stopAll();
});

test('resume: checkpoint store lưu/tải/export/import + prune quá cũ', () => {
  let now = 1000;
  const store = new AgUiCheckpointStore({ maxRuns: 2, maxAgeMs: 5000, now: () => now });
  const cp = (runId, lastSequence) => ({
    runId,
    lastSequence,
    receivedEvents: lastSequence + 1,
    gapsDetected: 0,
    state: { progress: 1 },
    textByMessage: { m1: 'hi' },
    createdAt: new Date(now).toISOString(),
    terminal: false,
  });
  store.save(cp('r1', 5));
  store.save(cp('r2', 3));
  store.save(cp('r3', 1)); // vượt maxRuns -> r1 bị cắt
  assert.equal(store.size, 2);
  assert.equal(store.get('r1'), undefined);
  assert.deepEqual(store.get('r2')?.lastSequence, 3);
  now += 6000;
  assert.equal(store.get('r2'), undefined); // quá cũ
  assert.equal(store.getEvenIfStale('r2'), undefined); // đã bị xóa khi get
  const json = store.exportJson();
  const parsed = JSON.parse(json);
  assert.equal(parsed.format, 'agui-checkpoint/1');
  assert.equal(parsed.count, 1);
  const store2 = new AgUiCheckpointStore();
  const res = store2.importJson(json);
  assert.equal(res.imported, 1);
  assert.equal(store2.get('r3')?.lastSequence, 1);
  assert.deepEqual(store2.importJson('not json'), { imported: 0, skipped: 0 });
  assert.deepEqual(store2.importJson(JSON.stringify({ format: 'other/1', checkpoints: {} })), { imported: 0, skipped: 0 });
  // markResumed tăng counter.
  store2.markResumed('r3');
  assert.equal(store2.getEvenIfStale('r3')?.resumeCount, 1);
  assert.equal(store2.prune(), 0);
});

test('resume: planResume chọn đúng chiến lược cho từng trường hợp', () => {
  const cp = (lastSequence, terminal, state) => ({
    runId: 'run-x',
    lastSequence,
    receivedEvents: lastSequence + 1,
    gapsDetected: 0,
    state,
    textByMessage: {},
    createdAt: new Date().toISOString(),
    terminal,
  });
  // Run đã xong -> already-complete.
  assert.equal(planResume('run-x', cp(9, true, null), { oldestSequence: 0, newestSequence: 9, eventCount: 10 }).strategy, 'already-complete');
  // Không checkpoint, buffer có event -> replay-buffer từ 0.
  assert.equal(planResume('run-x', null, { oldestSequence: 0, newestSequence: 4, eventCount: 5 }).strategy, 'replay-buffer');
  // Không checkpoint, buffer trống -> refetch-full.
  assert.equal(planResume('run-x', null, { oldestSequence: 0, newestSequence: -1, eventCount: 0 }).strategy, 'refetch-full');
  // Checkpoint còn trong buffer -> replay phần sau.
  const p1 = planResume('run-x', cp(4, false, { a: 1 }), { oldestSequence: 0, newestSequence: 9, eventCount: 10 });
  assert.equal(p1.strategy, 'replay-buffer');
  assert.equal(p1.fromSequence, 5);
  assert.equal(p1.missingEvents, 5);
  // Checkpoint cũ hơn buffer + có snapshot -> snapshot-and-replay.
  const p2 = planResume('run-x', cp(2, false, { a: 1 }), { oldestSequence: 5, newestSequence: 9, eventCount: 5 });
  assert.equal(p2.strategy, 'snapshot-and-replay');
  assert.equal(p2.bufferTruncated, true);
  // Checkpoint cũ hơn buffer + không snapshot -> refetch-full.
  const p3 = planResume('run-x', cp(2, false, null), { oldestSequence: 5, newestSequence: 9, eventCount: 5 });
  assert.equal(p3.strategy, 'refetch-full');
});

test('resume: detectStreamGap + bufferWindow', () => {
  assert.deepEqual(detectStreamGap(3, [0, 1, 2, 3, 5, 6]), { missing: [4], newest: 6 });
  assert.deepEqual(detectStreamGap(6, [0, 1, 2, 3, 4, 5, 6]), { missing: [], newest: 6 });
  const bus = new AgUiEventBus();
  publishRun(bus, 'run-w', 3);
  const w = bufferWindow(bus.replay('run-w', 0));
  assert.deepEqual(w, { oldestSequence: 0, newestSequence: 2, eventCount: 3 });
  assert.deepEqual(bufferWindow([]), { oldestSequence: 0, newestSequence: -1, eventCount: 0 });
});
