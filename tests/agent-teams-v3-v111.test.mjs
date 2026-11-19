/**
 * Test Agent Teams v3 (v1.11, Đội T3): đúng 7 primitives
 * (TeamCreate/Task/SendMessage/lifecycle 3 trạng thái/file-lock/
 * dependency waves/lead control), shared task list + file-locked
 * claiming + dependency waves, teammate messaging trực tiếp +
 * challenge kết luận, lead delegate/implement mode, teammate pane
 * view kiểu tmux + agent-view background sessions, cảnh báo token
 * cost tuyến tính, giới hạn 1 team/session + cấm team con + 2
 * teammate không sửa cùng file, và 15 tool teams_v3_*.
 *
 * Chỉ test local: không mạng, không key thật, store trong thư mục tạm.
 *
 * Build core + tools trước khi chạy:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * rồi: node --test tests/agent-teams-v3-v111.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PANE_LOG_LINES,
  TEAM_V3_PRIMITIVES,
  TEAM_V3_PRIMITIVE_DESCRIPTIONS,
  TeamServiceV3,
  TeamV3Store,
  appendPaneLog,
  checkFileGuard,
  checkLeadClaim,
  computeWaves,
  estimateCostBeforeCreateV3,
  estimateTeamV3Cost,
  isValidV3Transition,
  linearCostWarning,
  listTeamSessions,
  openChallenge,
  renderPaneGrid,
  syncPanes,
  v3OutcomeOf,
  v3StateOf,
} from '../packages/core/dist/teams/index.js';
import {
  ALL_TOOLS,
  TEAM_V3_TOOL_NAMES,
  createAgentTeamsV3Tools,
  createDefaultTools,
} from '../packages/tools/dist/index.js';

const tmpDir = () => mkdtempSync(join(tmpdir(), 'teams-v3-'));
const T0 = 1_800_000_000_000;

function makeTeamV3(dir, sessionId = 'sess-1', v3config = {}) {
  const created = TeamServiceV3.create(dir, {
    name: 'Team Gamma',
    goal: 'Xây tính năng Y',
    leadName: 'lead',
    sessionId,
    v3config,
  }, T0);
  assert.ok(created.ok, created.error);
  const svc = created.value;
  svc.save();
  return svc;
}

function addWorker(svc, name, extra = {}, now = T0) {
  const spawned = svc.spawnTeammate({ name, ...extra }, now);
  assert.ok(spawned.ok, spawned.error);
  return spawned.value.mate;
}

function addTask(svc, title, extra = {}, now = T0) {
  const added = svc.addTask({ title, ...extra }, now);
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
// 7 primitives
// ---------------------------------------------------------------------------

test('primitives: đúng 7 primitives, đủ mô tả, đúng thứ tự survey', () => {
  assert.equal(TEAM_V3_PRIMITIVES.length, 7);
  assert.deepEqual([...TEAM_V3_PRIMITIVES], [
    'team-create',
    'task-spawn',
    'send-message',
    'task-lifecycle',
    'file-lock',
    'dependency-wave',
    'lead-control',
  ]);
  assert.equal(new Set(TEAM_V3_PRIMITIVES).size, 7);
  for (const p of TEAM_V3_PRIMITIVES) {
    assert.ok(TEAM_V3_PRIMITIVE_DESCRIPTIONS[p].length > 10, p);
  }
  assert.match(TEAM_V3_PRIMITIVE_DESCRIPTIONS['team-create'], /TeamCreate/);
  assert.match(TEAM_V3_PRIMITIVE_DESCRIPTIONS['task-spawn'], /Task/);
  assert.match(TEAM_V3_PRIMITIVE_DESCRIPTIONS['send-message'], /SendMessage/);
});

// ---------------------------------------------------------------------------
// Lifecycle 3 trạng thái
// ---------------------------------------------------------------------------

test('lifecycle: map 6 trạng thái v1 sang 3 trạng thái v3 + chuyển đổi một chiều', () => {
  const base = { id: 'task-1', title: 'T', dependsOn: [], priority: 3, touchesFiles: [], attempts: 0, maxAttempts: 3, createdAt: T0, updatedAt: T0 };
  assert.equal(v3StateOf({ ...base, status: 'pending' }), 'open');
  assert.equal(v3StateOf({ ...base, status: 'claimed' }), 'open');
  assert.equal(v3StateOf({ ...base, status: 'blocked' }), 'open');
  assert.equal(v3StateOf({ ...base, status: 'in-progress' }), 'in-progress');
  assert.equal(v3StateOf({ ...base, status: 'done' }), 'closed');
  assert.equal(v3StateOf({ ...base, status: 'failed' }), 'closed');
  assert.equal(v3OutcomeOf({ ...base, status: 'done' }), 'done');
  assert.equal(v3OutcomeOf({ ...base, status: 'failed' }), 'failed');
  assert.equal(v3OutcomeOf({ ...base, status: 'in-progress' }), undefined);
  assert.equal(isValidV3Transition('open', 'in-progress'), true);
  assert.equal(isValidV3Transition('in-progress', 'closed'), true);
  assert.equal(isValidV3Transition('open', 'closed'), false, 'không nhảy cóc open → closed');
  assert.equal(isValidV3Transition('closed', 'open'), false, 'không đi ngược');
  assert.equal(isValidV3Transition('in-progress', 'open'), false);
  assert.equal(isValidV3Transition('open', 'open'), false);
});

// ---------------------------------------------------------------------------
// Dependency waves
// ---------------------------------------------------------------------------

test('waves: chain tuyến tính A→B→C thành 3 wave, wave sau khóa claim', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const a = addTask(svc, 'A');
  const b = addTask(svc, 'B', { dependsOn: [a.id] });
  const c = addTask(svc, 'C', { dependsOn: [b.id] });
  const waves = svc.waves();
  assert.ok(waves.ok, waves.error);
  assert.equal(waves.value.length, 3);
  assert.deepEqual(waves.value[0].taskIds, [a.id]);
  assert.deepEqual(waves.value[1].taskIds, [b.id]);
  assert.deepEqual(waves.value[2].taskIds, [c.id]);
  assert.equal(waves.value[0].claimable, true);
  assert.equal(waves.value[1].claimable, false);
  assert.match(waves.value[1].blockedBy ?? '', /Wave 0 chưa xong/);
  assert.equal(waves.value[0].status, 'pending');
  assert.equal(svc.wavesSummary().includes('Wave 1/3'), true);
});

test('waves: diamond (A→B, A→C, B+C→D) thành 3 wave, task độc lập cùng wave 0', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const a = addTask(svc, 'A');
  const z = addTask(svc, 'Z độc lập');
  const b = addTask(svc, 'B', { dependsOn: [a.id] });
  const c = addTask(svc, 'C', { dependsOn: [a.id] });
  const d = addTask(svc, 'D', { dependsOn: [b.id, c.id] });
  const waves = svc.waves();
  assert.ok(waves.ok, waves.error);
  assert.equal(waves.value.length, 3);
  assert.deepEqual(new Set(waves.value[0].taskIds), new Set([a.id, z.id]));
  assert.deepEqual(new Set(waves.value[1].taskIds), new Set([b.id, c.id]));
  assert.deepEqual(waves.value[2].taskIds, [d.id]);
});

test('waves: dependency treo + chu trình đều lỗi', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  // Dependency treo: addTask v1 đã chặn, nhưng computeWaves trực tiếp vẫn lỗi.
  const fake = [
    { id: 't1', title: 'T1', status: 'pending', dependsOn: ['no-such'], priority: 3, touchesFiles: [], attempts: 0, maxAttempts: 3, createdAt: T0, updatedAt: T0 },
  ];
  const missing = computeWaves(fake);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /không tồn tại/);
  const cyclic = [
    { id: 't1', title: 'T1', status: 'pending', dependsOn: ['t2'], priority: 3, touchesFiles: [], attempts: 0, maxAttempts: 3, createdAt: T0, updatedAt: T0 },
    { id: 't2', title: 'T2', status: 'pending', dependsOn: ['t1'], priority: 3, touchesFiles: [], attempts: 0, maxAttempts: 3, createdAt: T0, updatedAt: T0 },
  ];
  const cycle = computeWaves(cyclic);
  assert.equal(cycle.ok, false);
  assert.match(cycle.error, /chu trình/);
});

test('waves: claim wave sau bị chặn, đóng xong wave trước thì mở wave sau', async () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const coder = addWorker(svc, 'coder');
  const reviewer = addWorker(svc, 'reviewer');
  const a = addTask(svc, 'A');
  const b = addTask(svc, 'B', { dependsOn: [a.id] });
  const blocked = svc.claimTask(b.id, coder.id, { now: T0 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Wave 0 chưa xong/);
  // Log hội thoại ghi lại lần chặn wave.
  assert.ok(svc.v3snapshot.conversation.some((e) => e.kind === 'wave-blocked'));
  const claimed = svc.claimTask(a.id, coder.id, { now: T0 });
  assert.ok(claimed.ok, claimed.error);
  assert.equal(claimed.value.waveIndex, 0);
  const started = svc.startTask(a.id, coder.id, T0 + 1000);
  assert.ok(started.ok, started.error);
  const closed = await svc.closeTask(a.id, coder.id, 'done', { summary: 'Xong A', now: T0 + 2000 });
  assert.ok(closed.ok, closed.error);
  assert.equal(closed.value.waveCompleted, 0, 'đóng A xong wave 0 → ghi waveCompleted');
  assert.ok(svc.v3snapshot.conversation.some((e) => e.kind === 'wave-advance'));
  const claimB = svc.claimTask(b.id, coder.id, { now: T0 + 3000 });
  assert.ok(claimB.ok, claimB.error);
  assert.equal(claimB.value.waveIndex, 1);
});

// ---------------------------------------------------------------------------
// File guard: 2 teammate không sửa cùng file
// ---------------------------------------------------------------------------

test('file guard: claim trùng file bị chặn, lead override có kiểm soát thì qua', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const coder = addWorker(svc, 'coder');
  const reviewer = addWorker(svc, 'reviewer');
  const x = addTask(svc, 'X', { touchesFiles: ['src/a.ts'] });
  const y = addTask(svc, 'Y', { touchesFiles: ['src/a.ts'] });
  const claimed = svc.claimTask(x.id, coder.id, { now: T0 });
  assert.ok(claimed.ok, claimed.error);
  // Reviewer claim Y trùng file → chặn, nêu rõ ai giữ.
  const denied = svc.claimTask(y.id, reviewer.id, { now: T0 + 1000 });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /src\/a\.ts/);
  assert.match(denied.error, /coder/);
  // Teammate thường override không có lead ủy quyền → lỗi (chỉ lead được override).
  const teammateOverride = svc.claimTask(y.id, reviewer.id, { allowOverride: true, now: T0 + 1000 });
  assert.equal(teammateOverride.ok, false);
  assert.match(teammateOverride.error, /Chỉ lead mới được override/);
  // Lead ủy quyền override cho reviewer: thu hồi X của coder rồi claim Y cho reviewer.
  const lead = svc.lead;
  const leadOverride = svc.claimTask(y.id, reviewer.id, { allowOverride: true, overrideById: lead.id, now: T0 + 2000 });
  assert.ok(leadOverride.ok, leadOverride.error);
  assert.equal(leadOverride.value.warnings.length, 1);
  assert.match(leadOverride.value.warnings[0], /OVERRIDE file guard/);
  assert.ok(svc.v3snapshot.conversation.some((e) => e.kind === 'file-override'));
  // Override thu hồi claim của coder: task X về pending, lock nhả.
  assert.equal(svc.findTask(x.id).status, 'pending');
  assert.equal(svc.findTask(x.id).claimedBy, undefined);
  assert.equal(svc.findTask(y.id).claimedBy, reviewer.id);
});

test('file guard: checkFileGuard thuần — không trùng thì allowed; partition chồng thì chặn hẳn (luật v1)', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const coder = addWorker(svc, 'coder', { partition: 'src/memory/' });
  const x = addTask(svc, 'X', { touchesFiles: ['src/a.ts'] });
  const team = svc.snapshot;
  const ok = checkFileGuard(team.tasks, team.teammates, x.id, coder.id);
  assert.equal(ok.allowed, true);
  assert.equal(ok.holds.length, 0);
  // Spawn teammate partition chồng → v1 chặn hẳn, v3 trả lỗi rõ ràng.
  const spawned = svc.spawnTeammate({ name: 'reviewer', partition: 'src/memory/deep/' });
  assert.equal(spawned.ok, false);
  assert.match(spawned.error, /chồng/);
  // Partition không chồng thì spawn được.
  const disjoint = svc.spawnTeammate({ name: 'reviewer', partition: 'src/voice/' });
  assert.ok(disjoint.ok, disjoint.error);
});

// ---------------------------------------------------------------------------
// Lead control: delegate vs implement
// ---------------------------------------------------------------------------

test('lead control: delegate mode chặn lead claim/start, implement mode cho phép qua worker seat (luật v1: lead không claim trực tiếp)', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  assert.equal(svc.leadMode, 'delegate');
  assert.equal(svc.v3snapshot.leadWorkerId, undefined, 'chưa có worker seat ở delegate mode');
  const task = addTask(svc, 'Làm việc lead');
  const lead = svc.lead;
  const denied = svc.claimTask(task.id, lead.id, { now: T0 });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /delegate mode/);
  const startDenied = svc.startTask(task.id, lead.id, T0);
  assert.equal(startDenied.ok, false);
  // checkLeadClaim thuần.
  assert.equal(checkLeadClaim('delegate', lead.id, lead.id).ok, false);
  assert.equal(checkLeadClaim('implement', lead.id, lead.id).ok, true);
  assert.equal(checkLeadClaim('delegate', 'mate-khac', lead.id).ok, true, 'teammate thường không bị chặn');
  // Chuyển mode giữa chừng → tạo worker seat cho lead + lịch sử mode.
  const switched = svc.setLeadMode('implement', T0 + 1000);
  assert.ok(switched.ok, switched.error);
  assert.equal(svc.leadMode, 'implement');
  assert.equal(svc.v3snapshot.leadModeHistory.length, 1);
  assert.equal(svc.v3snapshot.leadModeHistory[0].mode, 'implement');
  assert.ok(svc.v3snapshot.conversation.some((e) => e.kind === 'mode-switch'));
  const seatId = svc.v3snapshot.leadWorkerId;
  assert.ok(seatId, 'implement mode phải có worker seat');
  const seat = svc.findTeammate(seatId);
  assert.equal(seat.role, 'teammate', 'worker seat là teammate thường (v1 cho claim)');
  assert.equal(seat.specialty, 'lead-implementer');
  // Lead claim bằng id của mình → tự map sang worker seat.
  const allowed = svc.claimTask(task.id, lead.id, { now: T0 + 2000 });
  assert.ok(allowed.ok, allowed.error);
  assert.equal(allowed.value.claimedAsId, seatId);
  assert.equal(svc.findTask(task.id).claimedBy, seatId, 'task thuộc về worker seat, không phải lead');
  assert.notEqual(svc.findTask(task.id).claimedBy, lead.id, 'v1 cấm lead giữ task trực tiếp');
  // Lead start/close cũng qua seat.
  const started = svc.startTask(task.id, lead.id, T0 + 3000);
  assert.ok(started.ok, started.error);
  // Chuyển về cùng mode → lỗi.
  const same = svc.setLeadMode('implement', T0 + 4000);
  assert.equal(same.ok, false);
  assert.match(same.error, /đã ở implement mode/);
  // Về delegate mà seat đang giữ task dở → cảnh báo nhưng vẫn chuyển; seat không claim được nữa.
  const back = svc.setLeadMode('delegate', T0 + 5000);
  assert.ok(back.ok, back.error);
  assert.ok(back.value.warnings.length >= 1, 'cảnh báo seat giữ task dở');
  assert.match(back.value.warnings[0], /đang giữ/);
  const seatBlocked = svc.claimTask(addTask(svc, 'Task khác').id, seatId, { now: T0 + 6000 });
  assert.equal(seatBlocked.ok, false);
  assert.match(seatBlocked.error, /implement mode/);
});

test('lead control: lead board xem được trạng thái từng teammate', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const coder = addWorker(svc, 'coder', { specialty: 'coder' });
  addWorker(svc, 'reviewer');
  const task = addTask(svc, 'Viết parser');
  svc.claimTask(task.id, coder.id, { now: T0 });
  const board = svc.leadBoard();
  assert.equal(board.length, 3, 'lead + 2 teammate');
  const coderRow = board.find((b) => b.id === coder.id);
  assert.equal(coderRow.status, 'working');
  assert.equal(coderRow.currentTaskTitle, 'Viết parser');
  assert.equal(coderRow.specialty, 'coder');
  assert.equal(typeof coderRow.paneRow, 'number');
  assert.equal(typeof coderRow.paneCol, 'number');
  const leadRow = board.find((b) => b.role === 'lead');
  assert.ok(leadRow);
  assert.equal(leadRow.status, 'idle');
});

// ---------------------------------------------------------------------------
// Session registry: 1 team/session, cấm team con
// ---------------------------------------------------------------------------

test('session registry: 1 session chỉ 1 team, teammate không tạo team con, dissolve giải phóng', () => {
  const dir = tmpDir();
  const first = TeamServiceV3.create(dir, { name: 'Team 1', goal: 'G1', sessionId: 'sess-A' }, T0);
  assert.ok(first.ok, first.error);
  first.value.save();
  // Session đã có team → tạo team thứ 2 lỗi.
  const second = TeamServiceV3.create(dir, { name: 'Team 2', goal: 'G2', sessionId: 'sess-A' }, T0 + 1000);
  assert.equal(second.ok, false);
  assert.match(second.error, /1 session chỉ có 1 team/);
  assert.match(second.error, /Team 1/);
  // Session khác vẫn tạo được.
  const other = TeamServiceV3.create(dir, { name: 'Team 3', goal: 'G3', sessionId: 'sess-B' }, T0 + 1000);
  assert.ok(other.ok, other.error);
  other.value.save();
  // Teammate tạo team con → lỗi.
  const sub = TeamServiceV3.create(
    dir,
    { name: 'Team con', goal: 'Gx', sessionId: 'sess-C', actorIsTeammateOfTeamId: first.value.snapshot.id },
    T0 + 2000,
  );
  assert.equal(sub.ok, false);
  assert.match(sub.error, /không được tạo team con/);
  // SessionId rỗng → lỗi.
  const empty = TeamServiceV3.create(dir, { name: 'Team X', goal: 'Gx', sessionId: '  ' }, T0 + 2000);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /cần sessionId/);
  // Registry liệt kê 2 session; dissolve team 1 → session sess-A trống lại.
  assert.equal(listTeamSessions(dir).length, 2);
  const dissolved = first.value.dissolve('Xong việc', T0 + 3000);
  assert.ok(dissolved.ok, dissolved.error);
  assert.equal(listTeamSessions(dir).length, 1);
  const again = TeamServiceV3.create(dir, { name: 'Team 1b', goal: 'G1b', sessionId: 'sess-A' }, T0 + 4000);
  assert.ok(again.ok, again.error);
});

// ---------------------------------------------------------------------------
// Teammate messaging trực tiếp + challenge
// ---------------------------------------------------------------------------

test('sendMessage trực tiếp: teammate nhắn nhau không qua lead, broadcast chỉ lead', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const coder = addWorker(svc, 'coder');
  const reviewer = addWorker(svc, 'reviewer');
  const sent = svc.sendMessageDirect({ fromId: coder.id, toId: reviewer.id, kind: 'request', body: 'Review giúp parser' }, T0);
  assert.ok(sent.ok, sent.error);
  // Tin nằm trong mailbox v1 của người nhận + log hội thoại team.
  assert.equal(svc.snapshot.messages.length, 1);
  assert.equal(svc.snapshot.messages[0].body, 'Review giúp parser');
  assert.ok(svc.v3snapshot.conversation.some((e) => e.kind === 'message' && e.body.includes('coder')));
  // Tự nhắn mình → lỗi; nhắn người không tồn tại → lỗi.
  assert.equal(svc.sendMessageDirect({ fromId: coder.id, toId: coder.id, kind: 'request', body: 'x' }, T0).ok, false);
  assert.equal(svc.sendMessageDirect({ fromId: coder.id, toId: 'mate-nope', kind: 'request', body: 'x' }, T0).ok, false);
  // Teammate broadcast → lỗi (tool-level cũng chặn, service-level chặn qua broadcast riêng).
  const badBroadcast = svc.sendMessageDirect({ fromId: coder.id, toId: '*', kind: 'request', body: 'x' }, T0);
  assert.equal(badBroadcast.ok, false);
  assert.match(badBroadcast.error, /chỉ lead/);
  // Lead broadcast được.
  const cast = svc.broadcast('Mọi người họp 15h', undefined, T0 + 1000);
  assert.ok(cast.ok, cast.error);
  assert.equal(svc.snapshot.messages[1].toId, '*');
});

test('challenge: mở → trả lời → resolve, ghi log hội thoại; các chặn hợp lệ', async () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const coder = addWorker(svc, 'coder');
  const reviewer = addWorker(svc, 'reviewer');
  const task = addTask(svc, 'Viết parser');
  svc.claimTask(task.id, coder.id, { now: T0 });
  svc.startTask(task.id, coder.id, T0 + 1000);
  // Challenge task chưa done → lỗi.
  const early = svc.openChallenge({ taskId: task.id, challengerId: reviewer.id, body: 'Sai rồi?' }, T0 + 1500);
  assert.equal(early.ok, false);
  assert.match(early.error, /đã done/);
  const closed = await svc.closeTask(task.id, coder.id, 'done', { summary: 'Parser dùng regex', now: T0 + 2000 });
  assert.ok(closed.ok, closed.error);
  // Tự challenge kết luận của mình → lỗi.
  const self = svc.openChallenge({ taskId: task.id, challengerId: coder.id, body: 'Tự review' }, T0 + 3000);
  assert.equal(self.ok, false);
  assert.match(self.error, /chính mình/);
  // Reviewer challenge → ok; mailbox question gửi cho coder.
  const opened = svc.openChallenge({ taskId: task.id, challengerId: reviewer.id, body: 'Regex sẽ fail với input lồng nhau, nên dùng parser thật.' }, T0 + 3000);
  assert.ok(opened.ok, opened.error);
  assert.equal(opened.value.status, 'open');
  assert.equal(opened.value.conclusion, 'Parser dùng regex');
  assert.ok(svc.snapshot.messages.some((m) => m.kind === 'request' && m.toId === coder.id), 'challenge gửi mailbox request cho người bị thách thức');
  assert.ok(svc.v3snapshot.conversation.some((e) => e.kind === 'challenge'));
  // Challenge trùng đang mở → lỗi.
  const dup = svc.openChallenge({ taskId: task.id, challengerId: reviewer.id, body: 'Thêm ý nữa' }, T0 + 3100);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /đang mở/);
  // Người khác trả lời hộ → lỗi; coder trả lời → answered.
  const wrongAnswer = svc.answerChallenge(opened.value.id, reviewer.id, 'Tôi trả lời hộ', T0 + 4000);
  assert.equal(wrongAnswer.ok, false);
  const answered = svc.answerChallenge(opened.value.id, coder.id, 'Đồng ý, sẽ đổi sang parser đệ quy.', T0 + 4000);
  assert.ok(answered.ok, answered.error);
  assert.equal(answered.value.status, 'answered');
  assert.ok(svc.v3snapshot.conversation.some((e) => e.kind === 'challenge-answer'));
  // Resolve bởi lead → resolved; resolve lại → lỗi.
  const resolved = svc.resolveChallenge(opened.value.id, 'Chấp nhận: đổi sang parser đệ quy, coder làm lại task mới.', T0 + 5000);
  assert.ok(resolved.ok, resolved.error);
  assert.equal(resolved.value.status, 'resolved');
  assert.ok(svc.v3snapshot.conversation.some((e) => e.kind === 'challenge-resolved'));
  const again = svc.resolveChallenge(opened.value.id, 'Resolve lại', T0 + 6000);
  assert.equal(again.ok, false);
});

test('challenge: openChallenge thuần kiểm tra kết luận trống', () => {
  const team = {
    tasks: [
      { id: 't1', title: 'T1', status: 'done', dependsOn: [], priority: 3, touchesFiles: [], attempts: 0, maxAttempts: 3, createdAt: T0, updatedAt: T0 },
    ],
    teammates: [
      { id: 'm1', name: 'An', role: 'teammate', status: 'done', tasksDone: 1, tasksFailed: 0, createdAt: T0, updatedAt: T0 },
      { id: 'm2', name: 'Bình', role: 'teammate', status: 'idle', tasksDone: 0, tasksFailed: 0, createdAt: T0, updatedAt: T0 },
    ],
  };
  // Task done nhưng không có resultSummary → không challenge được.
  const res = openChallenge([], team.tasks, team.teammates, { taskId: 't1', challengerId: 'm2', body: 'Sai?' }, T0);
  assert.equal(res.ok, false);
  assert.match(res.error, /chưa có kết luận/);
});

// ---------------------------------------------------------------------------
// Panes tmux + agent view
// ---------------------------------------------------------------------------

test('panes: mỗi teammate một pane, vị trí lưới, log cắt 200 dòng, focus', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  addWorker(svc, 'coder');
  addWorker(svc, 'reviewer');
  const panes = svc.panes();
  assert.equal(panes.length, 3, 'lead + 2 teammate');
  assert.deepEqual(panes.map((p) => [p.row, p.col]), [[0, 0], [0, 1], [1, 0]], 'lưới 2 cột');
  assert.equal(panes[0].role, 'lead');
  // Append log + đọc lại qua service (pane đã có 1 dòng "Đã tham gia team" từ lúc spawn).
  const appended = svc.appendPaneLog(panes[1].teammateId, 'Đang viết parser...', T0);
  assert.ok(appended.ok, appended.error);
  assert.equal(appended.value.logLines.length, 2);
  assert.equal(appended.value.logLines[1].line, 'Đang viết parser...');
  // syncPanes thuần: teammate rời team thì pane biến mất.
  const synced = syncPanes(panes, { ...svc.snapshot, teammates: svc.snapshot.teammates.slice(0, 2) }, 2, T0);
  assert.equal(synced.length, 2);
  // appendPaneLog thuần cắt ở 200 dòng.
  let list = [panes[0]];
  for (let i = 0; i < MAX_PANE_LOG_LINES + 5; i += 1) {
    const r = appendPaneLog(list, panes[0].teammateId, `dòng ${i}`, T0 + i);
    assert.ok(r.ok, r.error);
    list = [r.value];
  }
  assert.equal(list[0].logLines.length, MAX_PANE_LOG_LINES);
  assert.equal(list[0].logLines[0].line, 'dòng 5');
  // Focus pane.
  const focused = svc.focusPane(panes[1].teammateId, T0);
  assert.ok(focused.ok, focused.error);
  assert.equal(focused.value.filter((p) => p.focused).length, 1);
  assert.equal(focused.value.find((p) => p.focused)?.teammateId, panes[1].teammateId);
  // Render lưới text.
  const grid = renderPaneGrid(svc.panes());
  assert.match(grid, /Lưới pane 2 hàng x 2 cột/);
  assert.match(grid, /coder/);
  // Focus pane không tồn tại → lỗi.
  assert.equal(svc.focusPane('mate-nope', T0).ok, false);
});

test('agent view: background sessions liệt kê mọi session đang có team', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir, 'sess-view');
  addWorker(svc, 'coder');
  svc.save();
  const sessions = svc.backgroundSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'sess-view');
  assert.equal(sessions[0].teamName, 'Team Gamma');
  assert.equal(sessions[0].teammateCount, 2);
  assert.equal(sessions[0].leadMode, 'delegate');
});

// ---------------------------------------------------------------------------
// Chi phí tuyến tính
// ---------------------------------------------------------------------------

test('cost: tuyến tính theo số teammate — multiplier 1+n, mỗi teammate +8000 token', () => {
  const c3 = estimateTeamV3Cost({ teammates: 3, tasks: 0, messages: 0, forks: 0 });
  assert.equal(c3.multiplier, 4);
  assert.equal(c3.estimatedTokens, 4000 + 3 * 8000);
  assert.equal(c3.baseTokens, 4000);
  assert.equal(c3.perTeammateBreakdown.length, 3);
  assert.equal(c3.perTeammateBreakdown[2].estimatedTokens, 4000 + 3 * 8000);
  const c4 = estimateTeamV3Cost({ teammates: 4, tasks: 0, messages: 0, forks: 0 });
  const c5 = estimateTeamV3Cost({ teammates: 5, tasks: 0, messages: 0, forks: 0 });
  assert.equal(c4.estimatedTokens - c3.estimatedTokens, 8000, 'tuyến tính: +1 teammate = +8000');
  assert.equal(c5.estimatedTokens - c4.estimatedTokens, 8000);
  assert.ok(c3.warnings.some((w) => w.includes('tuyến tính')));
  assert.ok(c5.warnings.length >= 1);
  // Vượt ngân sách → mức over.
  const over = estimateTeamV3Cost({ teammates: 30, tasks: 100, messages: 0, forks: 0 }, { tokenBudget: 10_000 });
  assert.equal(over.level, 'over');
  assert.ok(over.warnings.some((w) => w.includes('VƯỢT ngân sách')));
  // Pre-create + câu cảnh báo một dòng.
  const pre = estimateCostBeforeCreateV3(3, 5);
  assert.equal(pre.teammates, 3);
  assert.equal(pre.tasks, 5);
  assert.match(linearCostWarning(3), /x4 token/);
  assert.match(linearCostWarning(3), /tuyến tính/);
  assert.match(linearCostWarning(0), /1 session đơn/);
});

test('cost: service costEstimate khớp số teammate/task/tin thực tế', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const coder = addWorker(svc, 'coder');
  addTask(svc, 'A');
  svc.sendMessageDirect({ fromId: svc.lead.id, toId: coder.id, kind: 'request', body: 'Làm A đi' }, T0);
  const cost = svc.costEstimate();
  assert.equal(cost.teammates, 2);
  assert.equal(cost.tasks, 1);
  assert.equal(cost.messages, 1);
  assert.equal(cost.multiplier, 3);
  assert.equal(cost.estimatedTokens, 4000 + 2 * 8000 + 1 * 4000 + 1 * 300);
});

// ---------------------------------------------------------------------------
// Service end-to-end + persistence
// ---------------------------------------------------------------------------

test('service: dashboard v3 đầy đủ primitives/board/waves/panes/cost/sessions', () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir, 'sess-dash');
  const coder = addWorker(svc, 'coder');
  addTask(svc, 'A');
  const dash = svc.dashboard();
  assert.equal(dash.teamName, 'Team Gamma');
  assert.equal(dash.leadMode, 'delegate');
  assert.deepEqual(dash.primitives, [...TEAM_V3_PRIMITIVES]);
  assert.equal(dash.leadBoard.length, 2);
  assert.equal(dash.panes.length, 2);
  assert.equal(dash.paneGrid.cols, 2, 'config paneColumns mặc định = 2');
  assert.equal(dash.cost.multiplier, 3);
  assert.equal(dash.backgroundSessions.length, 1);
  assert.equal(dash.lifecycleCounts.open, 1);
  assert.equal(dash.lifecycleCounts.closed, 0);
  assert.equal(dash.fileHolds.length, 0);
  const md = svc.dashboardMarkdown();
  assert.match(md, /Team v3 "Team Gamma"/);
  assert.match(md, /Chi phí/);
  assert.ok(dash.challengeSummary.includes('Chưa có challenge'));
  void coder;
});

test('service: save/load round-trip giữ lead mode + challenge + conversation', async () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const coder = addWorker(svc, 'coder');
  const reviewer = addWorker(svc, 'reviewer');
  svc.setLeadMode('implement', T0 + 1000);
  const task = addTask(svc, 'Viết parser');
  svc.claimTask(task.id, coder.id, { now: T0 + 2000 });
  svc.startTask(task.id, coder.id, T0 + 3000);
  await svc.closeTask(task.id, coder.id, 'done', { summary: 'Xong', now: T0 + 4000 });
  svc.openChallenge({ taskId: task.id, challengerId: reviewer.id, body: 'Cần test thêm.' }, T0 + 5000);
  svc.save();
  const loaded = TeamServiceV3.load(dir, svc.snapshot.id);
  assert.ok(loaded.service, loaded.loadError);
  assert.equal(loaded.service.leadMode, 'implement');
  assert.equal(loaded.service.v3snapshot.challenges.length, 1);
  assert.ok(loaded.service.v3snapshot.conversation.length >= 4);
  assert.equal(loaded.service.snapshot.tasks[0].status, 'done');
  // Store v3 đọc trực tiếp.
  const store = new TeamV3Store(dir, svc.snapshot.id);
  const { state } = store.load();
  assert.equal(state.version, 3);
  assert.equal(state.leadMode, 'implement');
  assert.equal(state.sessionId, 'sess-1');
});

test('service: closeTask failed theo ngữ nghĩa v1 — còn lượt thì về pending (retry), hết lượt mới failed, wave mở khi hết lượt', async () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const coder = addWorker(svc, 'coder');
  const reviewer = addWorker(svc, 'reviewer');
  const a = addTask(svc, 'A');
  const b = addTask(svc, 'B', { dependsOn: [a.id] });
  // Vòng 1: fail → còn lượt (maxAttempts 3) → task về pending, wave chưa mở.
  svc.claimTask(a.id, coder.id, { now: T0 });
  svc.startTask(a.id, coder.id, T0 + 1000);
  const first = await svc.closeTask(a.id, coder.id, 'failed', { error: 'Hết quota API', now: T0 + 2000 });
  assert.ok(first.ok, first.error);
  assert.equal(first.value.outcome, 'failed');
  assert.equal(first.value.task.status, 'pending', 'v1 retry: còn lượt → pending');
  assert.equal(first.value.waveCompleted, undefined);
  const stillBlocked = svc.claimTask(b.id, coder.id, { now: T0 + 3000 });
  assert.equal(stillBlocked.ok, false, 'wave 0 chưa xong nên B vẫn bị chặn');
  // Vòng 2: fail tiếp → vẫn pending.
  svc.claimTask(a.id, coder.id, { now: T0 + 4000 });
  svc.startTask(a.id, coder.id, T0 + 5000);
  const second = await svc.closeTask(a.id, coder.id, 'failed', { error: 'Lỗi tiếp', now: T0 + 6000 });
  assert.ok(second.ok, second.error);
  assert.equal(second.value.task.status, 'pending');
  // Vòng 3: làm lại và đóng done → wave 0 xong → B mở.
  svc.claimTask(a.id, coder.id, { now: T0 + 7000 });
  svc.startTask(a.id, coder.id, T0 + 8000);
  const third = await svc.closeTask(a.id, coder.id, 'done', { summary: 'Xong A sau 2 lần lỗi', now: T0 + 9000 });
  assert.ok(third.ok, third.error);
  assert.equal(third.value.task.status, 'done');
  assert.equal(third.value.waveCompleted, 0, 'đóng done mới xong wave → wave sau mở');
  const claimB = svc.claimTask(b.id, coder.id, { now: T0 + 10000 });
  assert.ok(claimB.ok, claimB.error);
  // Close task không in-progress → lỗi.
  const bad = await svc.closeTask(b.id, coder.id, 'done', { now: T0 + 11000 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /in-progress/);
});

test('service: task failed hết lượt chặn wave sau (luật v1: dependency phải done mới claim được)', async () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const coder = addWorker(svc, 'coder');
  const reviewer = addWorker(svc, 'reviewer');
  const x = addTask(svc, 'X');
  const y = addTask(svc, 'Y', { dependsOn: [x.id] });
  // Fail X 3 lần (hết lượt) → X failed thật; coder bị đánh failed nên reviewer làm tiếp cũng không cứu được X.
  for (let round = 0; round < 3; round += 1) {
    const who = round === 0 ? coder : reviewer;
    const base = T0 + round * 3000;
    const claimed = svc.claimTask(x.id, who.id, { now: base });
    assert.ok(claimed.ok, claimed.error);
    svc.startTask(x.id, who.id, base + 1000);
    const closed = await svc.closeTask(x.id, who.id, 'failed', { error: `Lỗi lần ${round + 1}`, now: base + 2000 });
    assert.ok(closed.ok, closed.error);
  }
  assert.equal(svc.findTask(x.id).status, 'failed');
  // Wave 0 chưa done (X failed, không phải done) → Y vẫn bị chặn cả ở wave gate lẫn v1 dependency.
  const waves = svc.waves();
  assert.ok(waves.ok, waves.error);
  assert.equal(waves.value[0].status, 'active');
  assert.equal(waves.value[1].claimable, false);
  const claimY = svc.claimTask(y.id, reviewer.id, { now: T0 + 10000 });
  assert.equal(claimY.ok, false);
  assert.match(claimY.error, /Wave 0 chưa xong/);
});

test('service: updateV3Config validate + tắt challenge thì không mở được', async () => {
  const dir = tmpDir();
  const svc = makeTeamV3(dir);
  const bad = svc.updateV3Config({ leadMode: 'wrong' });
  assert.equal(bad.ok, false);
  const badCols = svc.updateV3Config({ paneColumns: 9 });
  assert.equal(badCols.ok, false);
  const ok = svc.updateV3Config({ allowChallenges: false });
  assert.ok(ok.ok, ok.error);
  assert.equal(svc.config.allowChallenges, false);
  const coder = addWorker(svc, 'coder');
  const reviewer = addWorker(svc, 'reviewer');
  const task = addTask(svc, 'A');
  svc.claimTask(task.id, coder.id, { now: T0 });
  svc.startTask(task.id, coder.id, T0 + 1000);
  await svc.closeTask(task.id, coder.id, 'done', { summary: 'X', now: T0 + 2000 });
  const ch = svc.openChallenge({ taskId: task.id, challengerId: reviewer.id, body: 'Sai?' }, T0 + 3000);
  assert.equal(ch.ok, false);
  assert.match(ch.error, /tắt challenge/);
});

// ---------------------------------------------------------------------------
// Tools: 15 tool v3 end-to-end qua execute()
// ---------------------------------------------------------------------------

test('tools: đủ 15 tool v3, không trùng tên, ALL_TOOLS chứa đủ, binding giữ nguyên số lượng', async () => {
  assert.equal(TEAM_V3_TOOL_NAMES.length, 15);
  assert.equal(new Set(TEAM_V3_TOOL_NAMES).size, 15);
  for (const name of TEAM_V3_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `ALL_TOOLS thiếu ${name}`);
  }
  assert.ok(ALL_TOOLS.length >= 1078, 'v1.14 merge: 453 + 38 = 500'); // v1.38 re-pin: 899 + 179 = 1078.
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  const dir = tmpDir();
  const bound = createDefaultTools({ getAgentTeamsV109BaseDir: () => dir });
  assert.equal(bound.length, ALL_TOOLS.length);
  for (const name of TEAM_V3_TOOL_NAMES) {
    assert.equal(bound.filter((t) => t.definition.name === name).length, 1, `${name} bị trùng sau binding`);
  }
  const unbound = createAgentTeamsV3Tools();
  assert.equal(unbound.length, 15);
  const unboundCreate = unbound.find((t) => t.definition.name === 'teams_v3_create');
  assert.match(await unboundCreate.execute({ name: 'X', goal: 'G', sessionId: 's' }), /chưa được cấu hình/);
});

test('tools: create → spawn → send → claim → start → close → waves → dashboard', async () => {
  const dir = tmpDir();
  const tools = createAgentTeamsV3Tools(() => dir);
  const created = await runTool(tools, 'teams_v3_create', {
    name: 'Team Tool', goal: 'Test tool', sessionId: 'sess-tool', teammateCount: 3, taskCount: 2,
  });
  assert.match(created, /Đã tạo team v3 "Team Tool"/);
  assert.match(created, /tuyến tính|Ước tính/);
  const teamId = created.match(/\(team-[0-9a-f-]+\)/)?.[0].slice(1, -1);
  assert.ok(teamId, 'không parse được teamId từ kết quả create');
  // Tạo team thứ 2 cùng session → lỗi 1 team/session.
  const dup = await runTool(tools, 'teams_v3_create', { name: 'Team 2', goal: 'G', sessionId: 'sess-tool' });
  assert.match(dup, /^Error:/);
  assert.match(dup, /1 session chỉ có 1 team/);
  // Spawn 2 teammate qua tool.
  const spawned = await runTool(tools, 'teams_v3_spawn', { teamId, name: 'coder' });
  assert.match(spawned, /Đã spawn teammate "coder"/);
  await runTool(tools, 'teams_v3_spawn', { teamId, name: 'reviewer' });
  const svc = TeamServiceV3.load(dir, teamId).service;
  const coder = svc.findTeammateByName('coder');
  const reviewer = svc.findTeammateByName('reviewer');
  // Thêm task qua service (tool v3 không có add-task riêng — dùng task list v1/v2).
  const a = svc.addTask({ title: 'A' }, T0).value;
  const b = svc.addTask({ title: 'B', dependsOn: [a.id] }, T0).value;
  svc.save();
  // Send trực tiếp coder → reviewer.
  const sent = await runTool(tools, 'teams_v3_send', {
    teamId, fromId: coder.id, toId: reviewer.id, kind: 'request', body: 'Review giúp A',
  });
  assert.match(sent, /trực tiếp coder → reviewer/);
  assert.match(sent, /không qua lead/);
  // Broadcast của teammate → lỗi; lead broadcast được.
  const badCast = await runTool(tools, 'teams_v3_send', {
    teamId, fromId: coder.id, toId: '*', kind: 'request', body: 'Hello all',
  });
  assert.match(badCast, /^Error:/);
  const cast = await runTool(tools, 'teams_v3_send', {
    teamId, fromId: svc.lead.id, toId: '*', kind: 'request', body: 'Họp 15h',
  });
  assert.match(cast, /broadcast tới toàn team/);
  // Claim B bị wave chặn; claim A → start → close done → wave mở.
  const blocked = await runTool(tools, 'teams_v3_claim', { teamId, taskId: b.id, teammateId: coder.id });
  assert.match(blocked, /^Error:/);
  assert.match(blocked, /Wave 0 chưa xong/);
  const claimed = await runTool(tools, 'teams_v3_claim', { teamId, taskId: a.id, teammateId: coder.id });
  assert.match(claimed, /wave 1/);
  assert.match(claimed, /lease tới/);
  const started = await runTool(tools, 'teams_v3_start', { teamId, taskId: a.id, teammateId: coder.id });
  assert.match(started, /in-progress/);
  const closed = await runTool(tools, 'teams_v3_close', {
    teamId, taskId: a.id, teammateId: coder.id, outcome: 'done', summary: 'Xong A',
  });
  assert.match(closed, /đã đóng/);
  assert.match(closed, /Wave 1 đã xong/);
  // Waves read-only.
  const waves = await runTool(tools, 'teams_v3_waves', { teamId });
  assert.match(waves, /Wave 2\/2/);
  assert.match(waves, /Wave 2: pending/);
  // Dashboard.
  const dash = await runTool(tools, 'teams_v3_dashboard', { teamId });
  assert.match(dash, /Team v3 "Team Tool"/);
  assert.match(dash, /Chi phí/);
});

test('tools: challenge flow + lead mode + panes + pane log + cost', async () => {
  const dir = tmpDir();
  const tools = createAgentTeamsV3Tools(() => dir);
  const created = await runTool(tools, 'teams_v3_create', {
    name: 'Team Challenge', goal: 'Test', sessionId: 'sess-ch', leadMode: 'delegate',
  });
  const teamId = created.match(/\(team-[0-9a-f-]+\)/)?.[0].slice(1, -1);
  assert.ok(teamId);
  const svc = TeamServiceV3.load(dir, teamId).service;
  const coder = svc.spawnTeammate({ name: 'coder' }, T0).value.mate;
  const reviewer = svc.spawnTeammate({ name: 'reviewer' }, T0).value.mate;
  const task = svc.addTask({ title: 'Parser' }, T0).value;
  // Thêm 1 task pending để team không auto-complete khi Parser xong (cần team active để chuyển mode sau đó).
  svc.addTask({ title: 'Parser 2' }, T0);
  svc.claimTask(task.id, coder.id, { now: T0 });
  svc.startTask(task.id, coder.id, T0 + 1000);
  await svc.closeTask(task.id, coder.id, 'done', { summary: 'Dùng regex', now: T0 + 2000 });
  svc.save();
  // Challenge qua tool.
  const opened = await runTool(tools, 'teams_v3_challenge', {
    teamId, taskId: task.id, challengerId: reviewer.id, body: 'Regex sẽ fail input lồng nhau.',
  });
  assert.match(opened, /Đã mở challenge/);
  const challengeId = opened.match(/challenge-[0-9a-f-]+/)?.[0];
  assert.ok(challengeId, 'không parse được challengeId');
  const answered = await runTool(tools, 'teams_v3_challenge_answer', {
    teamId, challengeId, answerById: coder.id, answer: 'Đồng ý, đổi parser.',
  });
  assert.match(answered, /answered/);
  const resolved = await runTool(tools, 'teams_v3_challenge_resolve', {
    teamId, challengeId, resolution: 'Chấp nhận đổi parser.',
  });
  assert.match(resolved, /resolved/);
  // Lead mode: đọc rồi chuyển.
  const modeRead = await runTool(tools, 'teams_v3_lead_mode', { teamId });
  assert.match(modeRead, /delegate/);
  assert.match(modeRead, /Lead status board/);
  const modeSet = await runTool(tools, 'teams_v3_lead_mode', { teamId, mode: 'implement' });
  assert.match(modeSet, /implement mode/);
  const badMode = await runTool(tools, 'teams_v3_lead_mode', { teamId, mode: 'wrong' });
  assert.match(badMode, /^Error:/);
  // Panes + pane log.
  const panes = await runTool(tools, 'teams_v3_panes', { teamId });
  assert.match(panes, /Lưới pane/);
  assert.match(panes, /coder/);
  const logged = await runTool(tools, 'teams_v3_pane_log', { teamId, teammateId: coder.id, line: 'Đang refactor parser' });
  assert.match(logged, /Đã thêm dòng log/);
  const read = await runTool(tools, 'teams_v3_pane_log', { teamId, teammateId: coder.id });
  assert.match(read, /Đang refactor parser/);
  // Cost: pre-create + live.
  const preCost = await runTool(tools, 'teams_v3_cost', { teammateCount: 5, taskCount: 10 });
  assert.match(preCost, /tuyến tính/);
  assert.match(preCost, /x6/);
  const liveCost = await runTool(tools, 'teams_v3_cost', { teamId });
  assert.match(liveCost, /Ước tính/);
  // 4 teammate (lead + coder + reviewer + worker seat của lead) → hệ số x5.
  assert.match(liveCost, /x5/);
});

// ---------------------------------------------------------------------------
// i18n: 40 key teamsV3 đủ 6 locale
// ---------------------------------------------------------------------------

test('i18n: 40 key teamsV3 (39 teamsV3.* + sidebar.agentTeamsV3) đủ 6 locale', () => {
  const expected = [
    'teamsV3.agentView', 'teamsV3.back', 'teamsV3.backgroundSessions', 'teamsV3.challenge',
    'teamsV3.challengeOpen', 'teamsV3.challengeResolved', 'teamsV3.challenges',
    'teamsV3.costEstimate', 'teamsV3.costLinear', 'teamsV3.costPerTeammate', 'teamsV3.costTotal',
    'teamsV3.costWarning', 'teamsV3.currentWave', 'teamsV3.delegateMode', 'teamsV3.empty',
    'teamsV3.emptyHint', 'teamsV3.fileConflict', 'teamsV3.fileOverride', 'teamsV3.implementMode',
    'teamsV3.leadMode', 'teamsV3.lifecycle', 'teamsV3.loadError', 'teamsV3.loading',
    'teamsV3.noSubTeams', 'teamsV3.oneTeamPerSession', 'teamsV3.pane', 'teamsV3.paneLog',
    'teamsV3.panes', 'teamsV3.refresh', 'teamsV3.session', 'teamsV3.switchModeHint',
    'teamsV3.teammateStatus', 'teamsV3.title', 'teamsV3.wave', 'teamsV3.waveBlocked',
    'teamsV3.waveDone', 'teamsV3.waveReady', 'teamsV3.waveStatus', 'teamsV3.waves',
    'sidebar.agentTeamsV3',
  ];
  assert.equal(expected.length, 40);
  for (const loc of ['vi', 'en', 'zh', 'ja', 'es', 'fr']) {
    const dict = JSON.parse(readFileSync(join('apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${loc}.json`), 'utf8'));
    assert.ok(Object.keys(dict).length >= 8072, `${loc} phải có >= 8072 key`); // v1.14 merge: 4983 + 35 mem v13 + 24 mcpAppsV2 + 39 codingV6 = 5081. // v1.38 re-pin: 8072.
    for (const key of expected) {
      assert.ok(key in dict, `key ${key} thiếu trong ${loc}`);
      assert.equal(typeof dict[key], 'string');
      assert.ok(dict[key].length > 0, `key ${key} rỗng trong ${loc}`);
    }
  }
});
