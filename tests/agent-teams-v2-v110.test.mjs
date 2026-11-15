/**
 * Test Agent Teams v2 (v1.10, Đội T3): file-locked claiming
 * (lock + lease + heartbeat + requeue), disk mailbox theo tên
 * (inbox/outbox bền vững + xác nhận đã đọc), lead/worker
 * (spawn/giao task/tổng hợp, session riêng), fork subagent
 * (độ sâu + song song + merge), hook TaskCompleted (exit 2 =
 * giữ task mở kèm feedback), team 3–5 + cảnh báo chi phí token,
 * dashboard, và 18 tool teams_v2-*, mailbox_v2-*, fork_v2-*.
 *
 * Chỉ test local: không mạng, không key thật, hook giả hoặc lệnh
 * shell `echo`/`exit` cục bộ, store trong thư mục tạm.
 *
 * Build core + tools trước khi chạy:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * rồi: node --test tests/agent-teams-v2-v110.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CLAIM_LEASE_MS,
  RECOMMENDED_MAX_TEAMMATES,
  TeamServiceV2,
  acquireClaimLock,
  checkTeamSize,
  estimateTeamTokens,
  getClaimLock,
  heartbeatClaimLock,
  releaseClaimLock,
} from '../packages/core/dist/teams/index.js';
import {
  ALL_TOOLS,
  TEAM_V2_TOOL_NAMES,
  createAgentTeamsV2Tools,
  createDefaultTools,
} from '../packages/tools/dist/index.js';

const tmpDir = () => mkdtempSync(join(tmpdir(), 'teams-v2-'));
const T0 = 1_800_000_000_000;

function makeTeamV2(dir, v2config = {}) {
  const created = TeamServiceV2.create(dir, {
    name: 'Team Alpha',
    goal: 'Xây tính năng X',
    leadName: 'lead',
    v2config,
  });
  assert.ok(created.ok, created.error);
  const svc = created.value;
  svc.save();
  return svc;
}

function addWorker(svc, name, now = T0) {
  const spawned = svc.spawnTeammate({ name }, now);
  assert.ok(spawned.ok, spawned.error);
  return spawned.value.mate;
}

function addTask(svc, title, now = T0) {
  const added = svc.addTask({ title }, now);
  assert.ok(added.ok, added.error);
  return added.value;
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `thiếu tool ${name}`);
  return tool;
}

async function runTool(tools, name, args) {
  const out = await toolByName(tools, name).execute(args);
  assert.equal(typeof out, 'string');
  return out;
}

// ---------------------------------------------------------------------------
// Claim lock trên disk: nguyên tử, lease, heartbeat, thu hồi
// ---------------------------------------------------------------------------

test('claim lock: 2 agent không giành cùng việc (wx nguyên tử)', () => {
  const dir = tmpDir();
  const first = acquireClaimLock(dir, 'team-1', 'task-1', 'mate-a', 'An', 60_000, T0);
  assert.ok(first.ok, first.error);
  assert.equal(first.value.ownerName, 'An');
  assert.equal(first.value.leaseUntil, T0 + 60_000);
  // Agent thứ 2 (process khác) giành cùng task → lỗi, nêu rõ owner + lease.
  const second = acquireClaimLock(dir, 'team-1', 'task-1', 'mate-b', 'Bình', 60_000, T0 + 1000);
  assert.equal(second.ok, false);
  assert.match(second.error, /Bình|An/);
  assert.match(second.error, /lease còn/);
  // Lock file thật sự nằm trên disk.
  assert.ok(existsSync(join(dir, 'teams-v2', 'team-1', 'locks', 'task-1.lock.json')));
  // Owner đọc lại được lock của mình.
  const read = getClaimLock(dir, 'team-1', 'task-1');
  assert.equal(read?.ownerId, 'mate-a');
});

test('claim lock: heartbeat gia hạn lease, hết lease thì người khác lấy được', () => {
  const dir = tmpDir();
  const first = acquireClaimLock(dir, 'team-1', 'task-1', 'mate-a', 'An', 5000, T0);
  assert.ok(first.ok);
  // Heartbeat trước khi hết lease → lease mới.
  const beat = heartbeatClaimLock(dir, 'team-1', 'task-1', 'mate-a', 5000, T0 + 4000);
  assert.ok(beat.ok, beat.error);
  assert.equal(beat.value.leaseUntil, T0 + 9000);
  // Heartbeat của người khác → lỗi.
  const otherBeat = heartbeatClaimLock(dir, 'team-1', 'task-1', 'mate-b', 5000, T0 + 4000);
  assert.equal(otherBeat.ok, false);
  assert.match(otherBeat.error, /thuộc về/);
  // Quá lease mới (T0+9000) → agent khác lấy được (thu hồi lock treo).
  const late = acquireClaimLock(dir, 'team-1', 'task-1', 'mate-b', 'Bình', 5000, T0 + 9001);
  assert.ok(late.ok, late.error);
  assert.equal(late.value.ownerId, 'mate-b');
  // Heartbeat sau khi mất lock → lỗi (lock đã sang chủ mới).
  const staleBeat = heartbeatClaimLock(dir, 'team-1', 'task-1', 'mate-a', 5000, T0 + 9100);
  assert.equal(staleBeat.ok, false);
});

test('claim lock: nhả lock chỉ owner được nhả, nhả 2 lần vẫn ok', () => {
  const dir = tmpDir();
  acquireClaimLock(dir, 'team-1', 'task-1', 'mate-a', 'An', 60_000, T0);
  const wrongOwner = releaseClaimLock(dir, 'team-1', 'task-1', 'mate-b');
  assert.equal(wrongOwner.ok, false);
  assert.match(wrongOwner.error, /thuộc về/);
  const released = releaseClaimLock(dir, 'team-1', 'task-1', 'mate-a');
  assert.ok(released.ok, released.error);
  assert.equal(getClaimLock(dir, 'team-1', 'task-1'), null);
  // Nhả lock không tồn tại = ok (idempotent).
  const again = releaseClaimLock(dir, 'team-1', 'task-1', 'mate-a');
  assert.ok(again.ok);
});

// ---------------------------------------------------------------------------
// Service v2: claim 2 lớp + assign + requeue teammate chết
// ---------------------------------------------------------------------------

test('service v2: claim cần disk lock, worker khác không claim task đã giao', () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir);
  const coder = addWorker(svc, 'coder');
  const reviewer = addWorker(svc, 'reviewer');
  const task = addTask(svc, 'Viết parser');
  // Lead giao task cho coder → reviewer không claim được.
  const assigned = svc.assignTask(task.id, coder.id);
  assert.ok(assigned.ok, assigned.error);
  const denied = svc.claimTask(task.id, reviewer.id);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /coder/);
  // Coder claim được: v1 claim + disk lock.
  const claimed = svc.claimTask(task.id, coder.id, T0);
  assert.ok(claimed.ok, claimed.error);
  assert.equal(claimed.value.leaseUntil, T0 + DEFAULT_CLAIM_LEASE_MS);
  const lock = svc.claimLockOf(task.id);
  assert.equal(lock?.ownerId, coder.id);
  // Claim lại cùng task → lỗi (v1: task không còn pending).
  const twice = svc.claimTask(task.id, coder.id);
  assert.equal(twice.ok, false);
  // Heartbeat ok, release nhả cả v1 claim lẫn lock.
  const beat = svc.heartbeat(task.id, coder.id);
  assert.ok(beat.ok, beat.error);
  const released = svc.releaseTask(task.id, coder.id);
  assert.ok(released.ok, released.error);
  assert.equal(svc.claimLockOf(task.id), null);
  assert.equal(svc.findTask(task.id)?.status, 'pending');
});

test('service v2: teammate chết (hết lease, không heartbeat) → task requeue', () => {
  const dir = tmpDir();
  // Lease ngắn 1s để test nhanh (dùng now giả).
  const svc = makeTeamV2(dir, { claimLeaseMs: 1000 });
  const coder = addWorker(svc, 'coder');
  const reviewer = addWorker(svc, 'reviewer');
  const task = addTask(svc, 'Viết parser');
  const claimed = svc.claimTask(task.id, coder.id, T0);
  assert.ok(claimed.ok, claimed.error);
  assert.equal(claimed.value.leaseUntil, T0 + 1000);
  // Chưa hết lease → sweep không requeue.
  assert.deepEqual(svc.requeueStale(T0 + 500).requeued, []);
  // Hết lease, coder không heartbeat → sweep requeue task về pending.
  const swept = svc.requeueStale(T0 + 2000);
  assert.equal(swept.requeued.length, 1);
  assert.equal(swept.requeued[0].taskId, task.id);
  assert.equal(swept.requeued[0].ownerName, 'coder');
  assert.equal(svc.findTask(task.id)?.status, 'pending');
  assert.equal(svc.claimLockOf(task.id), null);
  // Reviewer claim lại được ngay.
  const reclaimed = svc.claimTask(task.id, reviewer.id, T0 + 2000);
  assert.ok(reclaimed.ok, reclaimed.error);
});

test('service v2: spawn teammate tạo session riêng, remove đóng session', () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir);
  const coder = addWorker(svc, 'coder');
  const sessionPath = join(dir, 'teams-v2', svc.snapshot.id, 'sessions', `${coder.id}.json`);
  assert.ok(existsSync(sessionPath), 'thiếu session file của teammate');
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  assert.equal(session.name, 'coder');
  assert.equal(session.teamGoal, 'Xây tính năng X');
  assert.deepEqual(session.contextNotes, []);
  // Lead cũng có session riêng.
  const leadSessionPath = join(dir, 'teams-v2', svc.snapshot.id, 'sessions', `${svc.lead.id}.json`);
  assert.ok(existsSync(leadSessionPath));
  // Xóa teammate → session đóng (closedAt), file giữ lại.
  const removed = svc.removeTeammate(coder.id);
  assert.ok(removed.ok, removed.error);
  const closed = JSON.parse(readFileSync(sessionPath, 'utf8'));
  assert.ok(typeof closed.closedAt === 'number');
});

// ---------------------------------------------------------------------------
// Disk mailbox theo tên
// ---------------------------------------------------------------------------

test('disk mailbox: gửi theo tên, inbox/outbox là file trên disk, xác nhận đã đọc', () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir);
  const coder = addWorker(svc, 'coder');
  addWorker(svc, 'reviewer');
  const sent = svc.sendDiskMessage({
    fromName: 'lead',
    toName: 'coder',
    kind: 'request',
    body: 'Làm parser trước nhé',
  });
  assert.ok(sent.ok, sent.error);
  assert.equal(sent.value.fromName, 'lead');
  assert.equal(sent.value.toName, 'coder');
  assert.equal(sent.value.read, false);
  // File inbox của coder + outbox của lead tồn tại trên disk.
  const teamDir = join(dir, 'teams-v2', svc.snapshot.id, 'mailbox');
  const inboxFiles = readdirSync(join(teamDir, 'coder', 'inbox'));
  const outboxFiles = readdirSync(join(teamDir, 'lead', 'outbox'));
  assert.equal(inboxFiles.length, 1);
  assert.equal(outboxFiles.length, 1);
  assert.equal(inboxFiles[0], `${sent.value.id}.json`);
  // Đọc inbox: 1 tin chưa đọc.
  const box = svc.diskMailboxBox('coder');
  assert.equal(box.inbox.length, 1);
  assert.equal(box.unreadCount, 1);
  assert.equal(box.outbox.length, 0);
  // Đánh dấu đã đọc → readAt + readBy ghi vào file inbox.
  const marked = svc.markDiskRead('coder', sent.value.id, T0 + 5000);
  assert.ok(marked.ok, marked.error);
  assert.equal(marked.value.read, true);
  assert.equal(marked.value.readAt, T0 + 5000);
  assert.equal(marked.value.readBy, 'coder');
  const after = svc.diskMailboxBox('coder');
  assert.equal(after.unreadCount, 0);
  // Người khác đánh dấu hộ → lỗi.
  const wrong = svc.markDiskRead('reviewer', sent.value.id);
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /Không tìm thấy tin/);
});

test('disk mailbox: broadcast tới mọi teammate trừ người gửi; gửi sai tên/không phải lead thì lỗi', () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir);
  addWorker(svc, 'coder');
  addWorker(svc, 'reviewer');
  const cast = svc.sendDiskMessage({
    fromName: 'lead',
    toName: '*',
    kind: 'broadcast',
    body: 'Cả team họp 15h',
  });
  assert.ok(cast.ok, cast.error);
  assert.equal(svc.diskInbox('coder').length, 1);
  assert.equal(svc.diskInbox('reviewer').length, 1);
  assert.equal(svc.diskInbox('lead').length, 0, 'người gửi không nhận broadcast của mình');
  assert.equal(svc.diskOutbox('lead').length, 1);
  // Worker broadcast → lỗi (chỉ lead).
  const notLead = svc.sendDiskMessage({ fromName: 'coder', toName: '*', kind: 'broadcast', body: 'hi' });
  assert.equal(notLead.ok, false);
  assert.match(notLead.error, /Chỉ lead/);
  // Gửi cho tên không tồn tại → lỗi.
  const unknown = svc.sendDiskMessage({ fromName: 'lead', toName: 'ghost', kind: 'request', body: 'hi' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /ghost/);
  // Question gửi cho worker (không phải lead) → lỗi.
  const badQuestion = svc.sendDiskMessage({ fromName: 'coder', toName: 'reviewer', kind: 'question', body: 'bí rồi' });
  assert.equal(badQuestion.ok, false);
  assert.match(badQuestion.error, /Question chỉ gửi cho lead/);
  // Result thiếu taskId → lỗi.
  const badResult = svc.sendDiskMessage({ fromName: 'coder', toName: 'lead', kind: 'result', body: 'xong' });
  assert.equal(badResult.ok, false);
  assert.match(badResult.error, /taskId/);
});

// ---------------------------------------------------------------------------
// Lead/worker: giao việc + tổng hợp
// ---------------------------------------------------------------------------

test('lead/worker: chỉ lead được giao task; aggregate gom kết quả theo teammate', async () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir);
  const coder = addWorker(svc, 'coder');
  const t1 = addTask(svc, 'Task 1');
  const t2 = addTask(svc, 'Task 2');
  // Giao qua service (lead): ok.
  assert.ok(svc.assignTask(t1.id, coder.id).ok);
  // Giao lại task đã có người giữ → lỗi (task không còn pending).
  svc.claimTask(t1.id, coder.id);
  assert.equal(svc.assignTask(t1.id, coder.id).ok, false);
  // Hoàn thành 1 task rồi aggregate.
  const done = await svc.completeTask(t1.id, coder.id, 'Xong parser');
  assert.ok(done.ok, done.error);
  const report = svc.aggregateResults();
  assert.equal(report.tasksDone, 1);
  assert.equal(report.tasksPending, 1);
  const coderRow = report.byTeammate.find((r) => r.teammateName === 'coder');
  assert.equal(coderRow?.done, 1);
  assert.equal(coderRow?.summaries[0]?.summary, 'Xong parser');
  assert.match(report.reportText, /Task 1/);
  assert.match(report.reportText, /Xong parser/);
  void t2;
});

// ---------------------------------------------------------------------------
// Fork subagent
// ---------------------------------------------------------------------------

test('fork: giới hạn độ sâu 3, song song 5, merge 1 lần', () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir);
  const coder = addWorker(svc, 'coder');
  const task = addTask(svc, 'Task cha');
  const f1 = svc.spawnFork({ parentTaskId: task.id, name: 'research', task: 'Tìm hiểu API', spawnedById: coder.id });
  assert.ok(f1.ok, f1.error);
  assert.equal(f1.value.depth, 1);
  const f2 = svc.spawnFork({ parentTaskId: task.id, parentForkId: f1.value.id, name: 'chi-tiet', task: 'Đọc doc', spawnedById: coder.id });
  assert.ok(f2.ok, f2.error);
  assert.equal(f2.value.depth, 2);
  const f3 = svc.spawnFork({ parentTaskId: task.id, parentForkId: f2.value.id, name: 'sau-hon', task: 'So sánh', spawnedById: coder.id });
  assert.ok(f3.ok, f3.error);
  assert.equal(f3.value.depth, 3);
  // Tầng 4 vượt giới hạn.
  const f4 = svc.spawnFork({ parentTaskId: task.id, parentForkId: f3.value.id, name: 'qua-sau', task: 'Thêm', spawnedById: coder.id });
  assert.equal(f4.ok, false);
  assert.match(f4.error, /độ sâu fork tối đa 3/);
  // Fork cha không tồn tại → lỗi.
  const ghost = svc.spawnFork({ parentTaskId: task.id, parentForkId: 'fork-khong-co', name: 'x', task: 'y', spawnedById: coder.id });
  assert.equal(ghost.ok, false);
  // Complete + merge: merge 2 lần thì lỗi.
  const done = svc.completeFork(f1.value.id, 'API có 3 endpoint', ['docs/api.md'], 1200);
  assert.ok(done.ok, done.error);
  assert.equal(done.value.status, 'done');
  assert.deepEqual(done.value.artifacts, ['docs/api.md']);
  const merged = svc.mergeFork(f1.value.id);
  assert.ok(merged.ok, merged.error);
  assert.match(merged.value.mergedSummary, /research/);
  assert.match(merged.value.mergedSummary, /API có 3 endpoint/);
  assert.match(merged.value.mergedSummary, /docs\/api\.md/);
  assert.equal(svc.mergeFork(f1.value.id).ok, false);
});

test('fork: vượt 5 fork song song thì chặn', () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir);
  const coder = addWorker(svc, 'coder');
  const task = addTask(svc, 'Task cha');
  for (let i = 0; i < 5; i++) {
    const f = svc.spawnFork({ parentTaskId: task.id, name: `fork-${i}`, task: `việc ${i}`, spawnedById: coder.id });
    assert.ok(f.ok, f.error);
  }
  const sixth = svc.spawnFork({ parentTaskId: task.id, name: 'fork-5', task: 'việc 5', spawnedById: coder.id });
  assert.equal(sixth.ok, false);
  assert.match(sixth.error, /5\/5 fork song song/);
  // Một fork xong → spawn tiếp được.
  const forks = svc.forks();
  assert.ok(svc.completeFork(forks[0].id, 'xong').ok);
  const again = svc.spawnFork({ parentTaskId: task.id, name: 'fork-5', task: 'việc 5', spawnedById: coder.id });
  assert.ok(again.ok, again.error);
});

// ---------------------------------------------------------------------------
// Chi phí token + cỡ team 3–5
// ---------------------------------------------------------------------------

test('cost: ước tính token theo công thức, mức ok/warn/over', () => {
  const est = estimateTeamTokens({ teammates: 3, tasks: 10, messages: 20, forks: 2 });
  // 3*8000 + 10*4000 + 20*300 + 2*6000 = 82000.
  assert.equal(est.estimatedTokens, 82_000);
  assert.equal(est.byTeammate, 24_000);
  assert.equal(est.byTask, 40_000);
  assert.equal(est.byMessage, 6_000);
  assert.equal(est.byFork, 12_000);
  assert.equal(est.level, 'ok');
  assert.deepEqual(est.warnings, []);
  const warn = estimateTeamTokens({ teammates: 3, tasks: 34, messages: 0, forks: 0 });
  assert.equal(warn.estimatedTokens, 160_000);
  assert.equal(warn.level, 'warn');
  assert.equal(warn.warnings.length, 1);
  assert.match(warn.warnings[0], /80%/);
  const over = estimateTeamTokens({ teammates: 30, tasks: 0, messages: 0, forks: 0 });
  assert.equal(over.level, 'over');
  assert.match(over.warnings[0], /VƯỢT ngân sách/);
});

test('cost: team 3–5 — dưới 3 cảnh báo, trên 5 chặn trừ khi override', () => {
  const small = checkTeamSize(2);
  assert.equal(small.allowed, true);
  assert.equal(small.warnings.length, 1);
  assert.match(small.warnings[0], /tối thiểu 3/);
  const okSize = checkTeamSize(4);
  assert.equal(okSize.allowed, true);
  assert.deepEqual(okSize.warnings, []);
  const big = checkTeamSize(6);
  assert.equal(big.allowed, false);
  assert.match(big.error ?? '', /tối đa 5/);
  const bigOverride = checkTeamSize(6, { allowOverRecommended: true });
  assert.equal(bigOverride.allowed, true);
  assert.match(bigOverride.warnings[0], /vượt khuyến nghị/);
});

// ---------------------------------------------------------------------------
// Hook TaskCompleted
// ---------------------------------------------------------------------------

function fakeRunner(exitCode, stdout = '', stderr = '') {
  return async () => ({
    exitCode,
    signal: null,
    stdout,
    stderr,
    timedOut: false,
    durationMs: 5,
  });
}

test('hook TaskCompleted: exit 0 chấp nhận, exit 2 giữ task mở kèm feedback', async () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir, { taskCompletedHookCommand: 'review-task.sh' });
  const coder = addWorker(svc, 'coder');
  const task = addTask(svc, 'Viết parser');
  const task2 = addTask(svc, 'Viết test');
  svc.assignTask(task.id, coder.id);
  svc.claimTask(task.id, coder.id);
  // Exit 0: task done bình thường.
  const okRun = await svc.completeTask(task.id, coder.id, 'Parser xong', { hookRunner: fakeRunner(0, 'ok\n') });
  assert.ok(okRun.ok, okRun.error);
  assert.equal(okRun.value.heldOpen, false);
  assert.equal(okRun.value.hookRan, true);
  assert.equal(okRun.value.hook?.exitCode, 0);
  assert.equal(svc.findTask(task.id)?.status, 'done');
  assert.equal(svc.claimLockOf(task.id), null);

  // Exit 2: task về pending kèm feedback, giao lại cho đúng worker.
  svc.assignTask(task2.id, coder.id);
  svc.claimTask(task2.id, coder.id);
  const held = await svc.completeTask(task2.id, coder.id, 'Test xong', {
    hookRunner: fakeRunner(2, 'thiếu test biên\n'),
  });
  assert.ok(held.ok, held.error);
  assert.equal(held.value.heldOpen, true);
  assert.equal(held.value.feedback, 'thiếu test biên');
  assert.equal(held.value.hook?.exitCode, 2);
  assert.equal(svc.findTask(task2.id)?.status, 'pending');
  // Feedback lưu v2 state + gửi mailbox cho worker.
  assert.equal(svc.v2snapshot.reviewFeedback.length, 1);
  assert.equal(svc.v2snapshot.reviewFeedback[0].feedback, 'thiếu test biên');
  const inbox = svc.snapshot.messages.filter((m) => m.toId === coder.id && m.kind === 'request');
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].body, /thiếu test biên/);
  // Worker claim lại được (task đã giao lại cho coder).
  const reclaim = svc.claimTask(task2.id, coder.id);
  assert.ok(reclaim.ok, reclaim.error);
});

test('hook TaskCompleted: exit 1 (lỗi hạ tầng) task vẫn done + ghi lỗi; không cấu hình hook thì không chạy', async () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir, { taskCompletedHookCommand: 'review-task.sh' });
  const coder = addWorker(svc, 'coder');
  const task = addTask(svc, 'Viết parser');
  svc.claimTask(task.id, coder.id);
  const errored = await svc.completeTask(task.id, coder.id, 'xong', { hookRunner: fakeRunner(1, '', 'boom\n') });
  assert.ok(errored.ok, errored.error);
  assert.equal(errored.value.heldOpen, false);
  assert.equal(svc.findTask(task.id)?.status, 'done');
  assert.match(errored.value.hook?.hookError ?? '', /exit code 1/);
  assert.match(errored.value.hook?.hookError ?? '', /boom/);

  // Team không cấu hình hook: complete không chạy hook.
  const svc2 = makeTeamV2(tmpDir());
  const coder2 = addWorker(svc2, 'coder');
  const task2 = addTask(svc2, 'Task khác');
  svc2.claimTask(task2.id, coder2.id);
  let runnerCalled = false;
  const spy = async () => {
    runnerCalled = true;
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
  };
  const noHook = await svc2.completeTask(task2.id, coder2.id, 'xong', { hookRunner: spy });
  assert.equal(noHook.value.hookRan, false);
  assert.equal(runnerCalled, false);
});

test('hook TaskCompleted: complete task merge fork done vào resultSummary', async () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir);
  const coder = addWorker(svc, 'coder');
  const task = addTask(svc, 'Task cha');
  const fork = svc.spawnFork({ parentTaskId: task.id, name: 'research', task: 'Tìm hiểu', spawnedById: coder.id });
  assert.ok(fork.ok);
  assert.ok(svc.completeFork(fork.value.id, 'Tìm được 3 endpoint').ok);
  svc.claimTask(task.id, coder.id);
  const done = await svc.completeTask(task.id, coder.id, 'Task cha xong');
  assert.ok(done.ok, done.error);
  assert.match(svc.findTask(task.id)?.resultSummary ?? '', /Task cha xong/);
  assert.match(svc.findTask(task.id)?.resultSummary ?? '', /\[fork research\] Tìm được 3 endpoint/);
  assert.equal(svc.forks()[0].status, 'merged');
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

test('dashboard: gom lock, mailbox, fork, chi phí, cỡ team, feedback, log', () => {
  const dir = tmpDir();
  const svc = makeTeamV2(dir);
  const coder = addWorker(svc, 'coder');
  const task = addTask(svc, 'Task cha');
  svc.assignTask(task.id, coder.id);
  svc.claimTask(task.id, coder.id);
  svc.sendDiskMessage({ fromName: 'lead', toName: 'coder', kind: 'request', body: 'nhớ test' });
  const fork = svc.spawnFork({ parentTaskId: task.id, name: 'research', task: 'Tìm hiểu', spawnedById: coder.id });
  assert.ok(fork.ok);
  const d = svc.dashboard();
  assert.equal(d.teamName, 'Team Alpha');
  assert.equal(d.leadName, 'lead');
  assert.equal(d.teammates.length, 2);
  assert.equal(d.teammates.find((m) => m.name === 'coder')?.status, 'working');
  assert.equal(d.teammates.find((m) => m.name === 'coder')?.sessionOpen, true);
  assert.equal(d.locks.length, 1);
  assert.equal(d.locks[0].ownerName, 'coder');
  assert.equal(d.locks[0].stale, false);
  assert.equal(d.mailboxUnreadByName.coder, 1);
  assert.equal(d.recentMessages.length, 1);
  assert.equal(d.forks.length, 1);
  assert.equal(d.cost.teammates, 2);
  assert.equal(d.cost.level, 'ok');
  assert.equal(d.sizeCheck.allowed, true);
  assert.equal(d.sizeCheck.warnings.length, 1, 'team 2 người → cảnh báo dưới tối thiểu 3');
  assert.ok(d.events.length > 0);
  assert.ok(d.tasks.length === 1);
});

// ---------------------------------------------------------------------------
// Tools: 18 tool v2 end-to-end qua execute()
// ---------------------------------------------------------------------------

async function makeToolsTeam(dir) {
  const svc = makeTeamV2(dir);
  const coder = addWorker(svc, 'coder');
  const task = addTask(svc, 'Viết parser');
  svc.save();
  const tools = createAgentTeamsV2Tools(() => dir);
  return { svc, coder, task, tools, teamId: svc.snapshot.id };
}

test('tools: đủ 18 tool v2, không trùng tên, ALL_TOOLS chứa đủ, binding giữ nguyên số lượng', async () => {
  assert.equal(TEAM_V2_TOOL_NAMES.length, 18);
  assert.equal(new Set(TEAM_V2_TOOL_NAMES).size, 18);
  for (const name of TEAM_V2_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `ALL_TOOLS thiếu ${name}`);
  }
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  const dir = tmpDir();
  const bound = createDefaultTools({ getAgentTeamsV109BaseDir: () => dir });
  assert.equal(bound.length, ALL_TOOLS.length);
  for (const name of TEAM_V2_TOOL_NAMES) {
    assert.equal(bound.filter((t) => t.definition.name === name).length, 1, `${name} bị trùng sau binding`);
  }
  const unbound = createAgentTeamsV2Tools();
  assert.equal(unbound.length, 18);
  const unboundCost = unbound.find((t) => t.definition.name === 'teams_v2_cost');
  assert.match(await unboundCost.execute({ teamId: 'team-x' }), /chưa được cấu hình/);
});

test('tools: claim → heartbeat → mailbox theo tên → fork → complete → dashboard', async () => {
  const dir = tmpDir();
  const { coder, task, tools, teamId } = await makeToolsTeam(dir);
  // Spawn thêm 1 teammate qua tool (team sẽ có 3 người → hết cảnh báo dưới 3).
  const spawned = await runTool(tools, 'teams_v2_spawn', { teamId, name: 'reviewer' });
  assert.match(spawned, /Đã spawn teammate "reviewer"/);
  const reviewer = JSON.parse(readFileSync(join(dir, 'agent-teams-v109.json'), 'utf8')).teams[0].teammates.find(
    (m) => m.name === 'reviewer',
  );
  assert.ok(reviewer);
  // Assign + claim qua tool.
  const assigned = await runTool(tools, 'teams_v2_assign', { teamId, taskId: task.id, teammateId: coder.id });
  assert.match(assigned, /chỉ teammate này claim được/);
  const denied = await runTool(tools, 'teams_v2_claim', { teamId, taskId: task.id, teammateId: reviewer.id });
  assert.match(denied, /^Error:/);
  const claimed = await runTool(tools, 'teams_v2_claim', { teamId, taskId: task.id, teammateId: coder.id });
  assert.match(claimed, /disk lock/);
  assert.match(claimed, /lease tới/);
  const beat = await runTool(tools, 'teams_v2_heartbeat', { teamId, taskId: task.id, teammateId: coder.id });
  assert.match(beat, /Đã gia hạn lease/);
  // Mailbox theo tên qua tool.
  const sent = await runTool(tools, 'mailbox_v2_send', {
    teamId, fromName: 'coder', toName: 'reviewer', kind: 'request', taskId: task.id, body: 'Review giúp parser',
  });
  assert.match(sent, /Đã gửi tin request/);
  assert.match(sent, /lưu disk/);
  const inbox = await runTool(tools, 'mailbox_v2_inbox', { teamId, teammateName: 'reviewer' });
  assert.match(inbox, /Review giúp parser/);
  assert.match(inbox, /1 chưa đọc/);
  const read = await runTool(tools, 'mailbox_v2_inbox', { teamId, teammateName: 'reviewer', markRead: true });
  assert.match(read, /Đã đánh dấu 1 tin là đã đọc/);
  const outbox = await runTool(tools, 'mailbox_v2_outbox', { teamId, teammateName: 'coder' });
  assert.match(outbox, /Review giúp parser/);
  // Fork qua tool.
  const forked = await runTool(tools, 'fork_v2_spawn', {
    teamId, parentTaskId: task.id, name: 'research', task: 'Tìm hiểu API', spawnedById: coder.id,
  });
  assert.match(forked, /Đã spawn fork "research"/);
  const forkId = forked.match(/\((fork-[0-9a-f-]+),/)?.[1];
  assert.ok(forkId, `không parse được fork id từ: ${forked}`);
  const forkDone = await runTool(tools, 'fork_v2_complete', {
    teamId, forkId, resultSummary: 'API có 3 endpoint', artifacts: ['docs/api.md'],
  });
  assert.match(forkDone, /Fork "research" xong/);
  const merged = await runTool(tools, 'fork_v2_merge', { teamId, forkId });
  assert.match(merged, /Đã merge fork "research"/);
  const forkStatus = await runTool(tools, 'fork_v2_status', { teamId });
  assert.match(forkStatus, /đã merge/);
  // Cost + aggregate + dashboard qua tool.
  const cost = await runTool(tools, 'teams_v2_cost', { teamId });
  assert.match(cost, /Chi phí token ước tính/);
  const agg = await runTool(tools, 'teams_v2_aggregate', { teamId });
  assert.match(agg, /Báo cáo team/);
  const dash = await runTool(tools, 'teams_v2_dashboard', { teamId });
  assert.match(dash, /Team "Team Alpha"/);
  assert.match(dash, /Lock đang giữ/);
  assert.match(dash, /coder/);
  // Complete task qua tool (không hook) → done.
  const done = await runTool(tools, 'teams_v2_complete', {
    teamId, taskId: task.id, teammateId: coder.id, resultSummary: 'Parser xong',
  });
  assert.match(done, /Task "Viết parser" xong/);
});

test('tools: hook TaskCompleted thật (shell exit 2) giữ task mở kèm feedback', async () => {
  const dir = tmpDir();
  const { coder, task, tools, teamId } = await makeToolsTeam(dir);
  // Cấu hình hook qua tool: echo feedback rồi exit 2.
  const configured = await runTool(tools, 'teams_v2_config', {
    teamId, taskCompletedHookCommand: 'echo "thieu test bien"; exit 2',
  });
  assert.match(configured, /hook TaskCompleted: echo "thieu test bien"; exit 2/);
  await runTool(tools, 'teams_v2_assign', { teamId, taskId: task.id, teammateId: coder.id });
  await runTool(tools, 'teams_v2_claim', { teamId, taskId: task.id, teammateId: coder.id });
  const done = await runTool(tools, 'teams_v2_complete', {
    teamId, taskId: task.id, teammateId: coder.id, resultSummary: 'Parser xong',
  });
  assert.match(done, /GIỮ task "Viết parser" MỞ \(exit 2\)/);
  assert.match(done, /thieu test bien/);
  // Task về pending thật trên disk.
  const { service } = TeamServiceV2.load(dir, teamId);
  assert.ok(service);
  assert.equal(service.findTask(task.id)?.status, 'pending');
  assert.equal(service.v2snapshot.reviewFeedback[0]?.feedback, 'thieu test bien');
  // Config xem lại: hook vẫn còn đó.
  const viewed = await runTool(tools, 'teams_v2_config', { teamId });
  assert.match(viewed, /hook TaskCompleted: echo "thieu test bien"; exit 2/);
});

test('tools: team quá 5 teammate thì spawn chặn; requeue stale qua tool', async () => {
  const dir = tmpDir();
  const { tools, teamId } = await makeToolsTeam(dir);
  // Team đã có lead + coder = 2. Spawn thêm 3 → 5 người ok.
  for (const name of ['w1', 'w2', 'w3']) {
    const out = await runTool(tools, 'teams_v2_spawn', { teamId, name });
    assert.match(out, new RegExp(`Đã spawn teammate "${name}"`));
  }
  // Người thứ 6 → chặn (vượt khuyến nghị 5, không override).
  const sixth = await runTool(tools, 'teams_v2_spawn', { teamId, name: 'w4' });
  assert.match(sixth, /^Error:/);
  assert.match(sixth, /tối đa 5/);
  // Requeue khi chưa có lock treo → 0 task.
  const requeue = await runTool(tools, 'teams_v2_requeue_stale', { teamId });
  assert.match(requeue, /0 task requeue/);
  // Team không tồn tại → lỗi rõ ràng.
  const missing = await runTool(tools, 'teams_v2_cost', { teamId: 'team-khong-co' });
  assert.match(missing, /^Error: Không tìm thấy team/);
});
