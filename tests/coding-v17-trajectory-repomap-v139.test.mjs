/**
 * Tests cho coding agent v17 — trajectory log + repo map PageRank v+1
 * (v1.39, Đội T4).
 *
 * Chạy thật: trajectory log thật trên tmpdir (append/verify/replay/
 * recover/corrupt/compaction), repo map thật trên graph file mẫu
 * (không gọi model/mạng, không cần bwrap).
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v17-trajectory-repomap-v139.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TrajectoryLog,
  renderV17Trajectory,
  v17BuildRepoMap,
  v17CompactTrajectory,
  v17EventHash,
  v17EventsFromJsonl,
  v17EventToJsonl,
  v17ListOpenSessions,
  v17ListSessions,
  v17PruneSessions,
  v17QueryRepoMap,
  v17RecoverEvents,
  v17ReplayEvents,
  v17SessionSummary,
  v17UpdateRepoMap,
  v17ValidateRepoMapWeights,
  v17VerifyEvents,
} from '../packages/core/dist/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v17-traj-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Không chặn test.
  }
}

function sampleEvents(sessionId = 's1') {
  const dir = tmpDir();
  const log = new TrajectoryLog(sessionId, path.join(dir, 'traj.jsonl'));
  log.append('session_start', { task: 'fix bug' }, 1000);
  log.append('prompt', { text: 'fix the bug' }, 1001);
  log.append('bash', { command: 'npm test' }, 1002);
  log.append('bash_output', { exitCode: 0, stdout: 'ok' }, 1003);
  log.append('file_write', { path: 'src/a.ts', content: 'export const a = 1;\n' }, 1004);
  log.append('test_result', {
    result: { testId: 't1', passed: true, exitCode: 0, stdout: '', stderr: '', durationMs: 5, timedOut: false },
  }, 1005);
  log.append('session_end', { reason: 'done' }, 1006);
  return { dir, log };
}

test('trajectory: append hash-chained, verify OK, replay tái tạo trạng thái', () => {
  const { dir, log } = sampleEvents();
  try {
    assert.equal(log.length, 7);
    const verification = log.verify();
    assert.equal(verification.ok, true);
    assert.equal(verification.eventsChecked, 7);
    const state = log.replay();
    assert.equal(state.eventsReplayed, 7);
    assert.equal(state.files['src/a.ts'], 'export const a = 1;\n');
    assert.deepEqual(state.bashCommands, ['npm test']);
    assert.equal(state.lastTestResult?.passed, true);
    assert.equal(state.ended, true);
    assert.equal(state.endReason, 'done');
    // Hash chain: event sau trỏ prevHash = hash event trước.
    const events = log.all();
    for (let i = 1; i < events.length; i += 1) {
      assert.equal(events[i].prevHash, events[i - 1].hash);
      assert.equal(events[i].seq, i);
    }
    assert.equal(events[0].prevHash, '');
    // Render có đủ dòng.
    assert.match(renderV17Trajectory(events), /Trajectory \(7 events\)/);
  } finally {
    cleanup(dir);
  }
});

test('trajectory: cùng log replay 2 lần cho cùng trạng thái (deterministic)', () => {
  const { dir, log } = sampleEvents();
  try {
    const first = log.replay();
    const second = v17ReplayEvents(log.all(), 's1');
    assert.deepEqual(second, first);
  } finally {
    cleanup(dir);
  }
});

test('trajectory: sửa 1 event giữa log -> verify fail đúng seq; recover cắt đuôi hỏng', () => {
  const { dir, log } = sampleEvents();
  try {
    const file = path.join(dir, 'traj.jsonl');
    const events = log.all();
    const tampered = { ...events[3], payload: { exitCode: 1, stdout: 'tampered' } };
    const lines = events.map((e, i) => v17EventToJsonl(i === 3 ? tampered : e));
    fs.writeFileSync(file, lines.join(''), 'utf8');
    const reloaded = new TrajectoryLog('s1', file);
    const loaded = reloaded.load();
    assert.equal(loaded.length, 7);
    const verification = reloaded.verify();
    assert.equal(verification.ok, false);
    assert.equal(verification.firstBadSeq, 3);
    assert.match(verification.reason ?? '', /hash/);
    const recovery = v17RecoverEvents(loaded, 's1');
    assert.equal(recovery.keptEvents, 3);
    assert.equal(recovery.droppedEvents, 4);
    assert.equal(recovery.firstBadSeq, 3);
    assert.equal(recovery.state.eventsReplayed, 3);
    assert.equal(recovery.state.files['src/a.ts'], undefined);
    // recover() trên log: ghi đè file bằng prefix + event recovery.
    const recovered = reloaded.recover();
    assert.equal(recovered.droppedEvents, 4);
    const after = new TrajectoryLog('s1', file);
    after.load();
    assert.equal(after.verify().ok, true);
    assert.equal(after.byKind('recovery').length, 1);
  } finally {
    cleanup(dir);
  }
});

test('trajectory: seq gap -> verify fail; payload không JSON -> append throw', () => {
  const events = v17EventsFromJsonl(
    '{"seq":0,"sessionId":"s","kind":"prompt","at":1,"payload":{},"hash":"' +
      'a'.repeat(64) +
      '","prevHash":""}\n',
  );
  assert.equal(events.length, 1);
  // Seq gap: hash đúng nhưng seq nhảy 0 -> 2 -> verify fail đúng lý do seq.
  const h0 = v17EventHash(0, 's', 'prompt', 1, {}, '');
  const h2 = v17EventHash(2, 's', 'prompt', 2, {}, h0);
  const gapCheck = v17VerifyEvents([
    { seq: 0, sessionId: 's', kind: 'prompt', at: 1, payload: {}, hash: h0, prevHash: '' },
    { seq: 2, sessionId: 's', kind: 'prompt', at: 2, payload: {}, hash: h2, prevHash: h0 },
  ]);
  assert.equal(gapCheck.ok, false);
  assert.equal(gapCheck.firstBadSeq, 2);
  assert.match(gapCheck.reason ?? '', /seq không liên tục/);
  const dir = tmpDir();
  try {
    const log = new TrajectoryLog('s', path.join(dir, 't.jsonl'));
    assert.throws(() => log.append('prompt', { circular: BigInt(1) }), /JSON-serializable/);
  } finally {
    cleanup(dir);
  }
});

test('trajectory: compaction snapshot giữ trạng thái, từ chối compact log hỏng', () => {
  const { dir, log } = sampleEvents();
  try {
    const { compaction, newEvents } = v17CompactTrajectory(log.all(), 's1');
    assert.equal(compaction.atSeq, 7);
    assert.equal(compaction.compactedEvents, 7);
    assert.equal(compaction.remainingEvents, 1);
    assert.equal(compaction.state.files['src/a.ts'], 'export const a = 1;\n');
    assert.equal(newEvents.length, 1);
    assert.equal(newEvents[0].kind, 'snapshot');
    assert.equal(newEvents[0].seq, 0);
    assert.equal(v17VerifyEvents(newEvents).ok, true);
    const tampered = log.all().map((e, i) => (i === 2 ? { ...e, payload: { command: 'rm -rf /' } } : e));
    assert.throws(() => v17CompactTrajectory(tampered, 's1'), /recover trước/);
  } finally {
    cleanup(dir);
  }
});

function repoFiles() {
  return new Map([
    ['src/index.ts', "import { run } from './agent';\nimport { helper } from './util';\nexport function main() { run(); helper(); }\n"],
    ['src/agent.ts', "import { helper } from './util';\nexport function run() { helper(); }\n"],
    ['src/util.ts', 'export function helper() { return 1; }\n'],
    ['src/unused.ts', 'export function lonely() { return 2; }\n'],
  ]);
}

test('repomap: build PageRank — file được import nhiều xếp cao hơn file cô lập', () => {
  const map = v17BuildRepoMap('repo', repoFiles(), { nowMs: 10_000, mtimes: new Map([
    ['src/index.ts', 9000], ['src/agent.ts', 9000], ['src/util.ts', 9000], ['src/unused.ts', 9000],
  ]) });
  assert.equal(map.version, 'v17');
  assert.equal(map.nodes.length, 4);
  assert.ok(map.edges.length >= 3);
  assert.ok(map.iterations >= 1);
  const rankByPath = new Map(map.ranks.map((r) => [r.path, r]));
  // util được cả index + agent import -> rank cao nhất.
  assert.equal(map.ranks[0].path, 'src/util.ts');
  assert.ok((rankByPath.get('src/util.ts').score ?? 0) > (rankByPath.get('src/unused.ts').score ?? 0));
  // Tổng PageRank = 1 (chuẩn hoá).
  const prTotal = map.ranks.reduce((a, r) => a + r.pageRank, 0);
  assert.ok(Math.abs(prTotal - 1) < 1e-6);
  // Weights sai -> throw.
  assert.throws(() => v17ValidateRepoMapWeights({ pageRank: 0.5, reference: 0.5, freshness: 0.5 }), /tổng weights/);
});

test('repomap: seed personalization kéo file seed lên cao; query theo task', () => {
  const plain = v17BuildRepoMap('repo', repoFiles(), { nowMs: 10_000 });
  const seeded = v17BuildRepoMap('repo', repoFiles(), { nowMs: 10_000, seeds: ['src/unused.ts'] });
  const plainRank = new Map(plain.ranks.map((r) => [r.path, r.score]));
  const seededRank = new Map(seeded.ranks.map((r) => [r.path, r.score]));
  assert.ok((seededRank.get('src/unused.ts') ?? 0) > (plainRank.get('src/unused.ts') ?? 0));
  const top = v17QueryRepoMap(seeded, 'agent run', 2);
  assert.equal(top.length, 2);
  assert.ok(top.some((r) => r.path === 'src/agent.ts'));
  assert.throws(() => v17QueryRepoMap(seeded, 'agent', 0), /topK/);
  assert.throws(() => v17BuildRepoMap('repo', new Map()), /không có file/);
});

test('repomap: cập nhật tăng dần — đổi 1 file chỉ tính lại subgraph ảnh hưởng', () => {
  const first = v17BuildRepoMap('repo', repoFiles(), { nowMs: 10_000 });
  const changed = new Map(repoFiles());
  changed.set('src/util.ts', 'export function helper() { return 42; }\nexport function extra() { return 3; }\n');
  const update = v17UpdateRepoMap(first, changed, { nowMs: 20_000 });
  assert.deepEqual(update.changedFiles, ['src/util.ts']);
  // util đổi -> index + agent (import util) bị ảnh hưởng; unused không.
  assert.ok(update.affectedFiles.includes('src/util.ts'));
  assert.ok(update.affectedFiles.includes('src/index.ts'));
  assert.ok(update.affectedFiles.includes('src/agent.ts'));
  assert.ok(!update.affectedFiles.includes('src/unused.ts'));
  assert.equal(update.reusedFiles, 1);
  assert.equal(update.map.nodes.length, 4);
  // Không đổi gì -> update trả lại map cũ, reused hết.
  const noop = v17UpdateRepoMap(update.map, changed, { nowMs: 30_000 });
  assert.deepEqual(noop.changedFiles, []);
  assert.equal(noop.reusedFiles, 4);
  assert.equal(noop.map, update.map);
});

test('repomap: freshness — file mới sửa được cộng điểm hơn file cũ', () => {
  const files = repoFiles();
  const map = v17BuildRepoMap('repo', files, {
    nowMs: 100_000,
    mtimes: new Map([
      ['src/index.ts', 100_000],
      ['src/agent.ts', 100_000],
      ['src/util.ts', 100_000],
      ['src/unused.ts', 100_000 - 30 * 24 * 60 * 60 * 1000],
    ]),
  });
  const byPath = new Map(map.ranks.map((r) => [r.path, r]));
  assert.ok((byPath.get('src/index.ts').freshnessScore ?? 0) > (byPath.get('src/unused.ts').freshnessScore ?? 0));
});

test('sessions: liệt kê + tóm tắt + prune (dry-run không xoá, thật thì xoá cũ nhất)', () => {
  const dir = tmpDir();
  try {
    const dataDir = path.join(dir, 'data');
    // Tạo 3 session: 2 đã kết thúc, 1 đang mở (thời gian tăng dần).
    const fixtures = [
      ['s-old', true, 1000],
      ['s-mid', true, 2000],
      ['s-new', false, 3000],
    ];
    for (const [id, ended, at] of fixtures) {
      const log = new TrajectoryLog(id, path.join(dataDir, 'trajectories', `${id}.jsonl`));
      log.append('session_start', { task: id }, at);
      log.append('bash', { command: 'echo hi' }, at + 1);
      if (ended) log.append('session_end', { reason: 'done' }, at + 2);
    }
    const listed = v17ListSessions(dataDir);
    assert.equal(listed.length, 3);
    assert.equal(listed[0].sessionId, 's-new');
    assert.deepEqual(v17ListOpenSessions(dataDir).map((s) => s.sessionId), ['s-new']);
    const sum = v17SessionSummary(dataDir, 's-old');
    assert.equal(sum.events, 3);
    assert.equal(sum.ended, true);
    assert.equal(sum.bashCommands, 1);
    assert.equal(sum.chainOk, true);
    assert.throws(() => v17SessionSummary(dataDir, 'nope'), /không có trajectory log/);
    // Dry-run: báo sẽ xoá nhưng không xoá.
    const dry = v17PruneSessions(dataDir, 2, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.deleted, 0);
    assert.deepEqual(dry.deletedSessions, ['s-old']);
    assert.equal(v17ListSessions(dataDir).length, 3);
    // Prune thật: chỉ giữ 2 mới nhất.
    const pruned = v17PruneSessions(dataDir, 2, false);
    assert.equal(pruned.deleted, 1);
    assert.deepEqual(pruned.deletedSessions, ['s-old']);
    assert.equal(pruned.kept, 2);
    assert.equal(v17ListSessions(dataDir).length, 2);
    assert.throws(() => v17PruneSessions(dataDir, -1), /keepNewest/);
    assert.deepEqual(v17ListSessions(path.join(dir, 'empty')), []);
  } finally {
    cleanup(dir);
  }
});
