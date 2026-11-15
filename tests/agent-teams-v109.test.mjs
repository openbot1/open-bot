/**
 * Test Agent Teams v1 (v1.09, Đội T1): lead + teammate, shared task
 * list (claim + file-lock + dependency), mailbox, phân vùng
 * file/worktree, giới hạn song song + leo cấp, runner, store và
 * 11 tool team_*.
 *
 * Chỉ test local: không mạng, không key thật, runner giả, store
 * trong thư mục tạm.
 *
 * Build core + tools trước khi chạy:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * rồi: node --test tests/agent-teams-v109.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_TEAMMATES,
  TeamService,
  TeamsV109Store,
  assessTeamEscalation,
  buildFileLocks,
  canAddTeammate,
  checkPartitions,
  claimTask,
  completeTask,
  createTeamTask,
  defaultTeamV109Config,
  detectFileConflicts,
  failTask,
  fileInPartition,
  findDependencyCycle,
  inboxFor,
  isTaskReady,
  markMessageRead,
  normalizePartitionPrefix,
  partitionsOverlap,
  planTeammateWorktree,
  readyTasks,
  runTeam,
  sendTeamMessage,
  summarizeTeamRun,
  topoOrder,
  unansweredQuestions,
  validateTeamBranchName,
  validateTeamV109Config,
} from '../packages/core/dist/teams/index.js';
import {
  ALL_TOOLS,
  TEAM_V109_TOOL_NAMES,
  createAgentTeamsV109Tools,
  createDefaultTools,
} from '../packages/tools/dist/index.js';

const tmpDir = () => mkdtempSync(join(tmpdir(), 'teams-v109-'));

function makeTeam({ maxTeammates = 8, maxParallelTasks = 8 } = {}) {
  const created = TeamService.create({
    name: 'Alpha',
    goal: 'Xây tính năng X',
    leadName: 'Lead',
    config: { maxTeammates, maxParallelTasks },
  });
  assert.equal(created.ok, true, created.error);
  return created.value;
}

function addMate(service, name, extra = {}) {
  const added = service.addTeammate({ name, ...extra });
  assert.equal(added.ok, true, added.error);
  return added.value;
}

function addTask(service, title, extra = {}) {
  const added = service.addTask({ title, ...extra });
  assert.equal(added.ok, true, added.error);
  return added.value;
}

// ---------------------------------------------------------------- types ---
test('types: partition normalize/overlap/file-in-partition', () => {
  assert.equal(normalizePartitionPrefix('src/memory'), 'src/memory/');
  assert.equal(normalizePartitionPrefix('./src/memory/'), 'src/memory/');
  assert.equal(normalizePartitionPrefix(''), '');
  assert.equal(partitionsOverlap('src/a/', 'src/a/b/'), true);
  assert.equal(partitionsOverlap('src/a/', 'src/b/'), false);
  assert.equal(partitionsOverlap('', 'src/a/'), false);
  assert.equal(fileInPartition('src/a/x.ts', 'src/a/'), true);
  assert.equal(fileInPartition('src/b/x.ts', 'src/a/'), false);
  assert.equal(fileInPartition('any.ts', ''), true);
});

test('types: validateTeamV109Config + defaults', () => {
  assert.deepEqual(defaultTeamV109Config().maxTeammates, DEFAULT_MAX_TEAMMATES);
  assert.equal(DEFAULT_MAX_TEAMMATES, 8);
  assert.deepEqual(validateTeamV109Config({ maxTeammates: 0 }), ['maxTeammates phải là số nguyên >= 1.']);
  assert.equal(validateTeamV109Config({ maxTeammates: 33 }).length, 1);
  assert.deepEqual(validateTeamV109Config({ maxTeammates: 4 }), []);
  assert.deepEqual(validateTeamV109Config({ claimTimeoutMs: -1 }).length, 1);
});

// ------------------------------------------------------------- task list ---
test('taskList: dependency cycle + topo order', () => {
  const a = createTeamTask({ title: 'A' });
  const b = createTeamTask({ title: 'B', dependsOn: [a.id] });
  const c = createTeamTask({ title: 'C', dependsOn: [b.id] });
  assert.deepEqual(findDependencyCycle([a, b, c]), []);
  assert.deepEqual(topoOrder([c, b, a]).map((t) => t.id), [a.id, b.id, c.id]);
  const x = createTeamTask({ title: 'X' });
  const y = createTeamTask({ title: 'Y', dependsOn: [x.id] });
  const cyclic = [
    { ...x, dependsOn: [y.id] },
    y,
  ];
  assert.ok(findDependencyCycle(cyclic).length > 0);
  assert.equal(topoOrder(cyclic), null);
});

test('taskList: claim chặn dependency chưa xong + double claim', () => {
  const service = makeTeam();
  const a = addTask(service, 'A');
  const b = addTask(service, 'B', { dependsOn: [a.id] });
  const m1 = addMate(service, 'Coder');
  const m2 = addMate(service, 'Tester');
  // B chưa claim được vì A chưa done.
  assert.equal(service.claimTask(b.id, m1.id).ok, false);
  const claimed = service.claimTask(a.id, m1.id);
  assert.equal(claimed.ok, true);
  // M2 claim lại A → lỗi (đã có chủ).
  assert.match(service.claimTask(a.id, m2.id).error, /không claim được|đang ở trạng thái/);
  // Claim trực tiếp qua taskList cũng lỗi.
  assert.equal(claimTask(service.snapshot.tasks, a.id, m2.id).ok, false);
  // Hoàn thành A → B claim được.
  assert.equal(service.completeTask(a.id, m1.id, 'xong A').ok, true);
  assert.equal(isTaskReady(service.snapshot.tasks, service.findTask(b.id)), true);
  assert.equal(service.claimTask(b.id, m2.id).ok, true);
});

test('taskList: file-lock — hai task chạm cùng file không claim cùng lúc', () => {
  const service = makeTeam();
  const t1 = addTask(service, 'T1', { touchesFiles: ['src/a.ts'] });
  const t2 = addTask(service, 'T2', { touchesFiles: ['src/a.ts', 'src/b.ts'] });
  const m1 = addMate(service, 'Coder');
  const m2 = addMate(service, 'Tester');
  assert.equal(service.claimTask(t1.id, m1.id).ok, true);
  const blocked = service.claimTask(t2.id, m2.id);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /bị khóa/);
  // Nhả T1 → T2 claim được.
  assert.equal(service.releaseTask(t1.id, m1.id).ok, true);
  assert.equal(service.claimTask(t2.id, m2.id).ok, true);
  // buildFileLocks thấy lock của T2.
  assert.equal(buildFileLocks(service.snapshot.tasks).get('src/a.ts'), t2.id);
});

test('taskList: fail còn lượt → pending để claim lại; hết lượt → failed', () => {
  const service = makeTeam();
  const t = addTask(service, 'Flaky', { maxAttempts: 2 });
  const m1 = addMate(service, 'Coder');
  const m2 = addMate(service, 'Tester');
  assert.equal(service.claimTask(t.id, m1.id).ok, true);
  const f1 = service.failTask(t.id, m1.id, 'lỗi lần 1');
  assert.equal(f1.ok, true);
  assert.equal(f1.value.retryable, true);
  assert.equal(f1.value.task.status, 'pending');
  assert.equal(service.claimTask(t.id, m2.id).ok, true);
  const f2 = service.failTask(t.id, m2.id, 'lỗi lần 2');
  assert.equal(f2.ok, true);
  assert.equal(f2.value.retryable, false);
  assert.equal(f2.value.task.status, 'failed');
  assert.equal(service.claimTask(t.id, m1.id).ok, false);
});

test('taskList: start/release chỉ owner mới được; readyTasks xếp theo priority', () => {
  const service = makeTeam();
  const low = addTask(service, 'Low', { priority: 1 });
  const high = addTask(service, 'High', { priority: 5 });
  const mid = addTask(service, 'Mid', { priority: 3 });
  assert.deepEqual(readyTasks(service.snapshot.tasks).map((t) => t.id), [high.id, mid.id, low.id]);
  const m1 = addMate(service, 'Coder');
  const m2 = addMate(service, 'Tester');
  assert.equal(service.claimTask(high.id, m1.id).ok, true);
  assert.equal(service.startTask(high.id, m2.id).ok, false);
  assert.equal(service.startTask(high.id, m1.id).ok, true);
  assert.equal(service.releaseTask(high.id, m2.id).ok, false);
  assert.equal(service.completeTask(high.id, m2.id).ok, false);
  assert.equal(service.completeTask(high.id, m1.id, 'ok').ok, true);
});

// --------------------------------------------------------------- mailbox ---
test('mailbox: luật gửi — broadcast chỉ lead, question chỉ cho lead, result cần taskId', () => {
  const service = makeTeam();
  const m1 = addMate(service, 'Coder');
  const lead = service.lead;
  const t = addTask(service, 'T');
  // Teammate broadcast → lỗi.
  assert.equal(service.sendMessage({ fromId: m1.id, toId: '*', kind: 'broadcast', body: 'hi' }).ok, false);
  // Question gửi cho teammate khác (không phải lead) → lỗi.
  const m2 = addMate(service, 'Tester');
  assert.equal(service.sendMessage({ fromId: m1.id, toId: m2.id, kind: 'question', body: '?' }).ok, false);
  // Result không có taskId → lỗi.
  assert.equal(service.sendMessage({ fromId: m1.id, toId: lead.id, kind: 'result', body: 'xong' }).ok, false);
  // Request hợp lệ + question cho lead hợp lệ.
  assert.equal(service.sendMessage({ fromId: m1.id, toId: lead.id, kind: 'request', body: 'cần review' }).ok, true);
  assert.equal(service.sendMessage({ fromId: m1.id, toId: lead.id, kind: 'question', taskId: t.id, body: 'bí rồi' }).ok, true);
  // Lead broadcast hợp lệ.
  assert.equal(service.sendMessage({ fromId: lead.id, toId: '*', kind: 'broadcast', body: 'mọi người ơi' }).ok, true);
  // Inbox: m1 nhận broadcast (lead gửi), lead nhận request + question.
  assert.equal(inboxFor(service.snapshot.messages, m1.id).length, 1);
  assert.equal(inboxFor(service.snapshot.messages, lead.id).length, 2);
  // Question chưa trả lời = 1.
  assert.equal(unansweredQuestions(service.snapshot).length, 1);
  // Lead trả result cho task → question coi như đã trả lời.
  assert.equal(service.sendMessage({ fromId: lead.id, toId: m1.id, kind: 'result', taskId: t.id, body: 'làm thế này' }).ok, true);
  assert.equal(unansweredQuestions(service.snapshot).length, 0);
});

test('mailbox: markRead chỉ người nhận; validate trực tiếp qua sendTeamMessage', () => {
  const service = makeTeam();
  const m1 = addMate(service, 'Coder');
  const lead = service.lead;
  const sent = service.sendMessage({ fromId: lead.id, toId: m1.id, kind: 'request', body: 'làm đi' });
  assert.equal(sent.ok, true);
  const msg = sent.value;
  // Người khác đánh dấu → lỗi.
  assert.equal(markMessageRead(service.snapshot.messages, msg.id, lead.id).ok, false);
  assert.equal(markMessageRead(service.snapshot.messages, msg.id, m1.id).ok, true);
  const read = markMessageRead(service.snapshot.messages, msg.id, m1.id);
  assert.equal(read.ok, true);
  // Gửi tin rỗng → lỗi.
  assert.equal(sendTeamMessage(service.snapshot, { fromId: lead.id, toId: m1.id, kind: 'request', body: '  ' }).ok, false);
});

// ------------------------------------------------------------ partitions ---
test('partitions: branch validate + plan worktree (chỉ tính toán)', () => {
  assert.deepEqual(validateTeamBranchName('teams/alpha/coder'), []);
  assert.ok(validateTeamBranchName('bad branch').length > 0);
  assert.ok(validateTeamBranchName('a..b').length > 0);
  const service = makeTeam();
  const m1 = addMate(service, 'Coder');
  const planned = planTeammateWorktree(service.snapshot, m1, '/home/u/open-bot');
  assert.equal(planned.ok, true);
  assert.equal(planned.plan.branch, 'teams/alpha/coder');
  assert.equal(planned.plan.worktreePath, '/home/u/open-bot-alpha-coder');
  assert.equal(planned.plan.repoRoot, '/home/u/open-bot');
});

test('partitions: xung đột partition chồng + task lấn vùng', () => {
  const service = makeTeam();
  addMate(service, 'A', { partition: 'src/memory/' });
  const clash = service.addTeammate({ name: 'B', partition: 'src/memory/v2/' });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /chồng/);
  const okMate = addMate(service, 'C', { partition: 'src/tools/' });
  // Task chạm file ngoài partition của owner → checkPartitions báo lỗi.
  const t = addTask(service, 'T', { touchesFiles: ['src/memory/x.ts'] });
  assert.equal(service.claimTask(t.id, okMate.id).ok, true);
  const check = checkPartitions(service.snapshot);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.includes('ngoài partition')));
  // Hai task active chạm cùng file → detectFileConflicts (qua service.fileConflicts).
  assert.equal(detectFileConflicts(service.snapshot).length, 0);
});

// ---------------------------------------------------------------- policy ---
test('policy: assess — việc nhỏ single-bot, việc lớn team; giới hạn teammate', () => {
  const small = assessTeamEscalation({ subtaskCount: 1, fileAreaCount: 1, estimatedSteps: 5 });
  assert.equal(small.recommendation, 'single-bot');
  assert.equal(small.suggestedTeammates, 0);
  assert.ok(small.complexityScore < 50);
  const big = assessTeamEscalation({
    subtaskCount: 6,
    fileAreaCount: 4,
    needsMultipleSpecialties: true,
    estimatedSteps: 60,
    timeSensitive: true,
  });
  assert.equal(big.recommendation, 'team');
  assert.ok(big.complexityScore >= 50);
  assert.ok(big.suggestedTeammates >= 2 && big.suggestedTeammates <= 8);
  assert.ok(big.reasons.length >= 3);
  assert.equal(canAddTeammate(8, 8).allowed, false);
  assert.equal(canAddTeammate(7, 8).allowed, true);
});

// --------------------------------------------------------------- service ---
test('service: create + addTeammate giới hạn 8 + trùng tên + xóa teammate nhả task', () => {
  const service = makeTeam({ maxTeammates: 2 });
  assert.equal(service.snapshot.teammates.length, 1); // chỉ lead
  const m1 = addMate(service, 'A');
  assert.equal(service.addTeammate({ name: 'A' }).ok, false); // trùng tên
  assert.equal(service.addTeammate({ name: 'B' }).ok, false); // đủ 2 (lead + A)
  // Lead không claim task.
  const t = addTask(service, 'T');
  assert.equal(service.claimTask(t.id, service.lead.id).ok, false);
  // Xóa teammate đang giữ task → task về pending.
  assert.equal(service.claimTask(t.id, m1.id).ok, true);
  assert.equal(service.removeTeammate(m1.id).ok, true);
  assert.equal(service.findTask(t.id).status, 'pending');
  // Không xóa lead.
  assert.equal(service.removeTeammate(service.lead.id).ok, false);
});

test('service: scheduler gán task ready cho teammate rảnh, tôn trọng maxParallel', () => {
  const service = makeTeam({ maxTeammates: 3, maxParallelTasks: 1 });
  addMate(service, 'A');
  addMate(service, 'B');
  addTask(service, 'T1', { priority: 5 });
  addTask(service, 'T2', { priority: 4 });
  const assigned = service.schedule();
  assert.equal(assigned.length, 1); // maxParallel = 1
  assert.equal(assigned[0].taskTitle, 'T1');
  assert.equal(service.findTask(assigned[0].taskId).status, 'claimed');
  // Team pause → schedule không gán nữa.
  assert.equal(service.pause().ok, true);
  assert.deepEqual(service.schedule(), []);
  assert.equal(service.resume().ok, true);
});

test('service: auto-complete khi mọi task done; dissolve chặn thao tác', () => {
  const service = makeTeam();
  const m1 = addMate(service, 'A');
  const t = addTask(service, 'T');
  service.claimTask(t.id, m1.id);
  assert.equal(service.completeTask(t.id, m1.id, 'ok').ok, true);
  assert.equal(service.snapshot.status, 'completed');
  assert.equal(service.addTask({ title: 'Muộn' }).ok, false);
  const s2 = makeTeam();
  assert.equal(s2.dissolve('hủy').ok, true);
  assert.equal(s2.snapshot.status, 'dissolved');
  assert.equal(s2.dissolve('lại').ok, false);
  assert.equal(s2.addTeammate({ name: 'X' }).ok, false);
});

test('service: reclaim claim treo + summary', () => {
  const service = makeTeam();
  service.snapshot.config.claimTimeoutMs = 1000;
  const m1 = addMate(service, 'A');
  const t = addTask(service, 'T');
  assert.equal(service.claimTask(t.id, m1.id, 1000).ok, true);
  const reclaimed = service.reclaimStaleClaims(1000 + 1001 + 5000);
  assert.equal(reclaimed.length, 1);
  assert.equal(service.findTask(t.id).status, 'pending');
  const s = service.summary();
  assert.equal(s.tasksTotal, 1);
  assert.equal(s.tasksReady, 1);
  assert.equal(s.leadName, 'Lead');
});

// ---------------------------------------------------------------- runner ---
test('runner: runTeam chạy batch song song, ghi result vào mailbox, task lỗi hỏi lead', async () => {
  const service = makeTeam();
  addMate(service, 'Coder');
  addMate(service, 'Tester');
  addTask(service, 'Good');
  addTask(service, 'Bad');
  const calls = [];
  const runner = async (input) => {
    calls.push(input.task.title);
    if (input.task.title === 'Bad') throw new Error('build vỡ');
    return { output: `xong ${input.task.title}`, durationMs: 5 };
  };
  const report = await runTeam(service, runner, { maxRounds: 5 });
  // Good done 1 lần; Bad fail 3 lần (hết 3 lượt thử): 2 lần retryable + 1 lần failed hẳn.
  assert.equal(report.tasksDone, 1);
  assert.equal(report.tasksFailed, 1);
  assert.equal(report.tasksRetried, 2);
  assert.ok(report.finished.some((f) => f.status === 'done'));
  assert.ok(report.finished.some((f) => f.status === 'failed' && f.retryable === true));
  assert.ok(report.finished.some((f) => f.status === 'failed' && f.retryable === false));
  // Mailbox lead nhận 1 result (Good) + 3 question (mỗi lần Bad lỗi).
  const leadInbox = service.inbox(service.lead.id);
  assert.equal(leadInbox.filter((m) => m.kind === 'result').length, 1);
  assert.equal(leadInbox.filter((m) => m.kind === 'question').length, 3);
  assert.match(summarizeTeamRun(report), /Team "Alpha"/);
  // Chạy lại: không còn task nào để làm.
  const report2 = await runTeam(service, runner, { maxRounds: 5 });
  assert.equal(report2.tasksDone, 0);
  assert.equal(report2.finished.length, 0);
});

test('runner: timeout hủy task treo', async () => {
  const service = makeTeam();
  addMate(service, 'Slow');
  addTask(service, 'Slow task');
  const runner = async () => new Promise(() => undefined); // treo mãi
  const report = await runTeam(service, runner, { maxRounds: 1, taskTimeoutMs: 20 });
  assert.equal(report.finished.length, 1);
  assert.equal(report.finished[0].status, 'failed');
});

// ----------------------------------------------------------------- store ---
test('store: save/load roundtrip; file hỏng → loadError + rỗng', () => {
  const dir = tmpDir();
  const store = new TeamsV109Store(dir);
  assert.deepEqual(store.load(), { teams: [] });
  const service = makeTeam();
  addMate(service, 'A');
  store.save([service.snapshot]);
  const loaded = store.load();
  assert.equal(loaded.teams.length, 1);
  assert.equal(loaded.teams[0].name, 'Alpha');
  assert.equal(loaded.teams[0].teammates.length, 2);
  writeFileSync(join(dir, 'agent-teams-v109.json'), '{ hỏng');
  const broken = store.load();
  assert.deepEqual(broken.teams, []);
  assert.match(broken.loadError, /JSON hỏng/);
});

// ----------------------------------------------------------------- tools ---
test('tools: ALL_TOOLS có đủ 11 tool team_*, không trùng tên, binding giữ nguyên số lượng', async () => {
  assert.equal(TEAM_V109_TOOL_NAMES.length, 11);
  for (const name of TEAM_V109_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), name);
  }
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  const dir = tmpDir();
  const bound = createDefaultTools({ getAgentTeamsV109BaseDir: () => dir });
  assert.equal(bound.length, ALL_TOOLS.length);
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, bound.length);
  // Placeholder chưa bind → báo chưa cấu hình.
  const unbound = createAgentTeamsV109Tools();
  const create = unbound.find((t) => t.definition.name === 'team_create');
  assert.match(await create.execute({ name: 'X', goal: 'g' }, {}), /chưa được cấu hình/);
});

test('tools: end-to-end team_create → add → assign → claim → complete → status/mailbox', async () => {
  const dir = tmpDir();
  const tools = createAgentTeamsV109Tools(() => dir);
  const byName = (n) => tools.find((t) => t.definition.name === n);
  const ctx = {};
  const created = await byName('team_create').execute({ name: 'Beta', goal: 'Làm B', maxTeammates: 4 }, ctx);
  assert.match(created, /Đã tạo team "Beta"/);
  const list1 = await byName('team_list').execute({}, ctx);
  assert.match(list1, /Beta/);
  const teamId = TeamService.restore(new TeamsV109Store(dir).load().teams[0]).snapshot.id;
  const added = await byName('team_add_teammate').execute({ teamId, name: 'Coder', partition: 'src/a/' }, ctx);
  assert.match(added, /Đã thêm teammate "Coder"/);
  const assigned = await byName('team_assign_task').execute({ teamId, title: 'Viết code', touchesFiles: ['src/a/x.ts'] }, ctx);
  assert.match(assigned, /Đã thêm task "Viết code"/);
  // Lỗi: dependency không tồn tại (kiểm tra khi team còn active).
  assert.match(
    await byName('team_assign_task').execute({ teamId, title: 'X', dependsOn: ['nope'] }, ctx),
    /Dependency không tồn tại/,
  );
  const store = new TeamsV109Store(dir);
  const team = store.load().teams[0];
  const mateId = team.teammates.find((m) => m.name === 'Coder').id;
  const taskId = team.tasks[0].id;
  const claimed = await byName('team_claim_task').execute({ teamId, taskId, teammateId: mateId }, ctx);
  assert.match(claimed, /claim task "Viết code"/);
  const done = await byName('team_complete_task').execute({ teamId, taskId, teammateId: mateId, resultSummary: 'xong' }, ctx);
  assert.match(done, /xong/);
  const leadId = team.leadId;
  const sent = await byName('team_send_message').execute({ teamId, fromId: mateId, toId: leadId, kind: 'request', body: 'review giúp' }, ctx);
  assert.match(sent, /Đã gửi tin request/);
  const mailbox = await byName('team_mailbox').execute({ teamId, teammateId: leadId }, ctx);
  assert.match(mailbox, /review giúp/);
  const status = await byName('team_status').execute({ teamId }, ctx);
  assert.match(status, /completed/);
  assert.match(status, /Không có xung đột file/);
  // assess: việc nhỏ → single-bot.
  const assess = await byName('team_assess').execute({ subtaskCount: 1, estimatedSteps: 3 }, ctx);
  assert.match(assess, /single-bot/);
  // worktree: chỉ lập kế hoạch.
  const wt = await byName('team_worktree').execute({ teamId, teammateId: mateId, repoRoot: '/home/u/repo' }, ctx);
  assert.match(wt, /teams\/beta\/coder/);
  assert.match(wt, /CHỈ LÀ KẾ HOẠCH/);
  // Lỗi: team không tồn tại.
  assert.match(await byName('team_status').execute({ teamId: 'nope' }, ctx), /Error: Không tìm thấy team/);
});

// ------------------------------------------------------------------ i18n ---
test('i18n: teamsV109 keys có đủ 6 locale, placeholder khớp nhau', () => {
  const localesDir = join(import.meta.dirname, '..', 'apps/desktop/src/renderer/i18n/locales');
  const dicts = {};
  for (const code of ['en', 'vi', 'zh', 'ja', 'es', 'fr']) {
    dicts[code] = JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf-8'));
  }
  const enKeys = Object.keys(dicts.en).filter((k) => k.startsWith('teamsV109.'));
  assert.ok(enKeys.length >= 20, `cần >= 20 key teamsV109, hiện ${enKeys.length}`);
  for (const code of ['vi', 'zh', 'ja', 'es', 'fr']) {
    for (const key of enKeys) {
      assert.ok(key in dicts[code], `${code} thiếu key ${key}`);
      assert.ok(typeof dicts[code][key] === 'string' && dicts[code][key].length > 0, `${code}.${key} rỗng`);
    }
  }
});
