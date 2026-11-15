/**
 * Tests for fleet campaign v5 (packages/core/src/fleet/fleetV5Campaign.ts).
 *
 * Covers campaign creation + validation, dedup fingerprint (same
 * repo + title + paths merges, different title/paths does not),
 * priority queue scoring + aging, claim rules (priority order,
 * dependsOn must be done, file conflict with a running task skips,
 * maxActivePerBot), complete/fail/requeue (maxAttempts), cancel,
 * campaign waves (topo order + cycle detection), the dependency
 * sweep (TS import / require / dynamic import / Python from-import,
 * extension + index resolution, unresolved list), conflict kinds
 * (same-file / path-overlap / dependency-order), and persistence
 * (save/load round-trip + corrupt file throws).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-v5-campaign-v108.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  addFleetV5Task,
  analyzeImportGraph,
  blockedFleetV5Tasks,
  campaignPathsOverlap,
  cancelFleetV5Task,
  claimNextFleetV5Task,
  completeFleetV5Task,
  createFleetV5Campaign,
  failFleetV5Task,
  findCampaignConflicts,
  findFleetV5Task,
  fleetV5QueueScore,
  loadFleetV5Campaigns,
  planCampaignWaves,
  saveFleetV5Campaigns,
  setFleetV5CampaignStatus,
  startFleetV5Task,
  summarizeFleetV5Campaign,
  taskFingerprint,
} from '../packages/core/dist/fleet/fleetV5Campaign.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v5-campaign-'));
}

const T0 = 1792000000000;

function makeCampaign(overrides = {}) {
  return createFleetV5Campaign(
    {
      goal: 'Nâng cấp fleet lên v5',
      repos: ['open-bot', 'open-bot-docs'],
      ...overrides,
    },
    T0,
  );
}

function addTask(campaign, overrides = {}) {
  const { task } = addFleetV5Task(
    campaign,
    {
      repo: 'open-bot',
      title: 'Viết budget v2',
      brief: 'Cài đặt budget soft + hard.',
      paths: ['packages/core/src/fleet/fleetV5Budget.ts'],
      ...overrides,
    },
    T0,
  );
  return task;
}

test('create: campaign mới rỗng, repos dedup + trim, goal rỗng bị từ chối', () => {
  const campaign = makeCampaign({ repos: [' open-bot ', 'open-bot', 'docs'] });
  assert.equal(campaign.status, 'active');
  assert.deepEqual(campaign.repos, ['open-bot', 'docs']);
  assert.equal(campaign.tasks.length, 0);
  assert.equal(campaign.dedupMerged, 0);
  assert.throws(() => createFleetV5Campaign({ goal: '  ', repos: ['x'] }, T0), /goal không rỗng/);
  assert.throws(() => createFleetV5Campaign({ goal: 'g', repos: [] }, T0), /ít nhất 1 repo/);
  assert.throws(() => createFleetV5Campaign({ goal: 'g', repos: ['  '] }, T0), /ít nhất 1 repo/);
});

test('fingerprint: chuẩn hoá title/repo/paths; pathsOverlap phát hiện thư mục cha', () => {
  assert.equal(
    taskFingerprint('Open-Bot', '  Viết   Budget v2 ', ['b.ts', 'a.ts']),
    taskFingerprint('open-bot', 'viết budget v2', ['a.ts', 'b.ts']),
  );
  assert.notEqual(
    taskFingerprint('open-bot', 'viết budget v2', ['a.ts']),
    taskFingerprint('open-bot', 'viết budget v2', ['a.ts', 'b.ts']),
  );
  assert.ok(campaignPathsOverlap('packages/core/src/fleet/', 'packages/core/src/fleet/quotas.ts'));
  assert.ok(campaignPathsOverlap('a/b.ts', 'a/b.ts'));
  assert.ok(!campaignPathsOverlap('a/b.ts', 'a/c.ts'));
  assert.ok(!campaignPathsOverlap('a/bc.ts', 'a/b.ts'));
});

test('dedup: task trùng repo+title+paths thì gộp, đếm dedupMerged, task khác thì tạo mới', () => {
  const campaign = makeCampaign();
  const first = addTask(campaign);
  assert.equal(campaign.tasks.length, 1);
  const dup = addFleetV5Task(campaign, {
    repo: 'OPEN-BOT',
    title: '  viết   budget v2 ',
    brief: 'Brief khác cũng vẫn là cùng việc.',
    paths: ['packages/core/src/fleet/fleetV5Budget.ts'],
  }, T0 + 1000);
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.existingTaskId, first.id);
  assert.equal(dup.task.id, first.id);
  assert.equal(campaign.tasks.length, 1);
  assert.equal(campaign.dedupMerged, 1);
  // Title khác -> task mới.
  const other = addFleetV5Task(campaign, {
    repo: 'open-bot',
    title: 'Viết health dashboard',
    brief: 'Dashboard.',
    paths: ['packages/core/src/fleet/fleetV5Health.ts'],
  }, T0 + 2000);
  assert.equal(other.deduplicated, false);
  assert.equal(campaign.tasks.length, 2);
  // Task đã cancelled thì không dedup nữa — tạo mới được.
  cancelFleetV5Task(campaign, first.id, T0 + 3000);
  const again = addFleetV5Task(campaign, {
    repo: 'open-bot',
    title: 'Viết budget v2',
    brief: 'Làm lại sau khi huỷ.',
    paths: ['packages/core/src/fleet/fleetV5Budget.ts'],
  }, T0 + 4000);
  assert.equal(again.deduplicated, false);
  assert.equal(campaign.tasks.length, 3);
});

test('add: dependsOn phải tồn tại, không tự phụ thuộc, id trùng bị từ chối', () => {
  const campaign = makeCampaign();
  const first = addTask(campaign);
  assert.throws(
    () => addFleetV5Task(campaign, { repo: 'open-bot', title: 'T2', brief: 'b', dependsOn: ['no-such-task'] }, T0),
    /không tồn tại/,
  );
  assert.throws(
    () => addFleetV5Task(campaign, { repo: 'open-bot', title: 'T2', brief: 'b', id: first.id }, T0),
    /đã có task id/,
  );
  const second = addFleetV5Task(campaign, {
    repo: 'open-bot',
    title: 'T2',
    brief: 'b',
    dependsOn: [first.id],
    paths: ['docs/x.md'],
  }, T0).task;
  assert.deepEqual(second.dependsOn, [first.id]);
  // Repo mới tự thêm vào campaign.repos.
  addFleetV5Task(campaign, { repo: 'other-repo', title: 'T3', brief: 'b' }, T0);
  assert.ok(campaign.repos.includes('other-repo'));
});

test('queue score: critical > high > medium > low; aging cộng điểm, tối đa +2', () => {
  const base = { repo: 'open-bot', title: 't', brief: 'b', paths: [] };
  const low = { ...base, priority: 'low', createdAt: T0, updatedAt: T0, id: 'a', campaignId: 'c', status: 'queued', dependsOn: [], assignedBotId: null, attempts: 0, fingerprint: 'f', history: [] };
  const critical = { ...low, priority: 'critical' };
  assert.ok(fleetV5QueueScore(critical, T0) > fleetV5QueueScore(low, T0));
  assert.equal(fleetV5QueueScore(low, T0), 1);
  // Chờ 30 phút -> +1; chờ 5 tiếng vẫn chỉ +2.
  assert.equal(fleetV5QueueScore(low, T0 + 30 * 60_000), 2);
  assert.equal(fleetV5QueueScore(low, T0 + 5 * 60 * 60_000), 3);
  // Low chờ lâu vẫn dưới critical mới.
  assert.ok(fleetV5QueueScore(low, T0 + 5 * 60 * 60_000) < fleetV5QueueScore(critical, T0));
});

test('claim: ưu tiên cao trước, dependsOn chưa xong thì bỏ qua, xung đột file thì bỏ qua', () => {
  const campaign = makeCampaign();
  const lowTask = addTask(campaign, { title: 'Low task', priority: 'low', paths: ['docs/a.md'] });
  const highTask = addTask(campaign, { title: 'High task', priority: 'high', paths: ['docs/b.md'] });
  const blockedTask = addTask(campaign, {
    title: 'Blocked task',
    priority: 'critical',
    paths: ['docs/c.md'],
    dependsOn: [highTask.id],
  });
  // Critical bị chặn bởi dependsOn -> claim được high trước.
  const first = claimNextFleetV5Task([campaign], 'bot-1', T0);
  assert.equal(first.task?.id, highTask.id);
  assert.equal(first.task?.status, 'assigned');
  assert.equal(first.task?.assignedBotId, 'bot-1');
  assert.equal(first.skipped, 1); // blockedTask
  // Bot đã giữ 1 task (maxActive mặc định 1) -> không claim thêm.
  const second = claimNextFleetV5Task([campaign], 'bot-1', T0);
  assert.equal(second.task, null);
  assert.match(second.reason ?? '', /đã giữ 1 task/);
  // Bot khác claim được low; blocked vẫn chưa xong dependsOn.
  const third = claimNextFleetV5Task([campaign], 'bot-2', T0);
  assert.equal(third.task?.id, lowTask.id);
  // Task xung đột file với task đang chạy của bot-2 thì bị bỏ qua.
  const conflictTask = addTask(campaign, { title: 'Conflict task', priority: 'critical', paths: ['docs/a.md'] });
  const fourth = claimNextFleetV5Task([campaign], 'bot-3', T0);
  assert.equal(fourth.task, null); // chỉ còn conflict + blocked
  assert.ok((fourth.skipped ?? 0) >= 1);
  // Hoàn thành high -> blocked claim được (critical).
  startFleetV5Task(campaign, highTask.id, T0 + 1000);
  completeFleetV5Task(campaign, highTask.id, T0 + 2000);
  const fifth = claimNextFleetV5Task([campaign], 'bot-3', T0 + 3000);
  assert.equal(fifth.task?.id, blockedTask.id);
  assert.ok(conflictTask.id !== fifth.task?.id);
});

test('claim: maxActivePerBot > 1 cho phép giữ nhiều task; campaign paused không claim được', () => {
  const campaign = makeCampaign();
  addTask(campaign, { title: 'T1', paths: ['a.md'] });
  addTask(campaign, { title: 'T2', paths: ['b.md'] });
  const a = claimNextFleetV5Task([campaign], 'bot-1', T0, { maxActivePerBot: 2 });
  const b = claimNextFleetV5Task([campaign], 'bot-1', T0, { maxActivePerBot: 2 });
  assert.ok(a.task !== null && b.task !== null && a.task.id !== b.task.id);
  setFleetV5CampaignStatus(campaign, 'paused', T0 + 1000);
  const c = claimNextFleetV5Task([campaign], 'bot-2', T0 + 2000);
  assert.equal(c.task, null);
});

test('complete/fail: fail còn lượt thì requeue, hết lượt thì failed; complete sai trạng thái bị từ chối', () => {
  const campaign = makeCampaign();
  const task = addTask(campaign);
  assert.throws(() => completeFleetV5Task(campaign, task.id, T0), /chỉ complete được/);
  claimNextFleetV5Task([campaign], 'bot-1', T0);
  const failedOnce = failFleetV5Task(campaign, task.id, 3, T0 + 1000, 'Lỗi mạng.');
  assert.equal(failedOnce.status, 'queued');
  assert.equal(failedOnce.attempts, 1);
  assert.equal(failedOnce.assignedBotId, null);
  claimNextFleetV5Task([campaign], 'bot-1', T0 + 2000);
  failFleetV5Task(campaign, task.id, 3, T0 + 3000);
  claimNextFleetV5Task([campaign], 'bot-1', T0 + 4000);
  const failedLast = failFleetV5Task(campaign, task.id, 3, T0 + 5000);
  assert.equal(failedLast.status, 'failed');
  assert.equal(failedLast.attempts, 3);
  assert.throws(() => completeFleetV5Task(campaign, task.id, T0 + 6000), /chỉ complete được/);
  assert.throws(() => cancelFleetV5Task(campaign, 'no-such', T0), /Không có task/);
});

test('cancel campaign: task chưa xong bị huỷ theo; campaign done/cancelled thì không đổi trạng thái được', () => {
  const campaign = makeCampaign();
  const t1 = addTask(campaign, { title: 'T1', paths: ['a.md'] });
  addTask(campaign, { title: 'T2', paths: ['b.md'] });
  claimNextFleetV5Task([campaign], 'bot-1', T0);
  completeFleetV5Task(campaign, t1.id, T0 + 1000);
  setFleetV5CampaignStatus(campaign, 'cancelled', T0 + 2000);
  assert.equal(campaign.status, 'cancelled');
  assert.ok(campaign.tasks.every((t) => t.status === 'done' || t.status === 'cancelled'));
  assert.throws(() => setFleetV5CampaignStatus(campaign, 'active', T0 + 3000), /không đổi trạng thái/);
  // Campaign còn task chưa xong thì không đánh done được.
  const campaign2 = makeCampaign();
  addTask(campaign2, { title: 'T1', paths: ['a.md'] });
  assert.throws(() => setFleetV5CampaignStatus(campaign2, 'done', T0), /còn task chưa xong/);
});

test('summarize: đếm đúng từng trạng thái + progress %; blocked tasks = dependsOn failed', () => {
  const campaign = makeCampaign();
  const t1 = addTask(campaign, { title: 'T1', paths: ['a.md'] });
  const t2 = addTask(campaign, { title: 'T2', paths: ['b.md'], dependsOn: [t1.id] });
  addTask(campaign, { title: 'T3', paths: ['c.md'] });
  claimNextFleetV5Task([campaign], 'bot-1', T0);
  completeFleetV5Task(campaign, t1.id, T0 + 1000);
  const summary = summarizeFleetV5Campaign(campaign);
  assert.equal(summary.totalTasks, 3);
  assert.equal(summary.done, 1);
  assert.equal(summary.queued, 2);
  assert.equal(summary.progressPercent, 33);
  assert.equal(blockedFleetV5Tasks(campaign).length, 0);
  // Fail t1 lần nữa không được (đã done); tạo campaign khác để test blocked.
  const campaign2 = makeCampaign();
  const a = addTask(campaign2, { title: 'A', paths: ['a.md'] });
  addTask(campaign2, { title: 'B', paths: ['b.md'], dependsOn: [a.id] });
  claimNextFleetV5Task([campaign2], 'bot-1', T0);
  failFleetV5Task(campaign2, a.id, 1, T0 + 1000); // maxAttempts=1 -> failed luôn
  assert.equal(blockedFleetV5Tasks(campaign2).length, 1);
  assert.equal(blockedFleetV5Tasks(campaign2)[0].dependsOn[0], a.id);
  void t2;
});

test('waves: topo theo dependsOn; chu trình bị phát hiện', () => {
  const campaign = makeCampaign();
  const a = addTask(campaign, { title: 'A', paths: ['a.md'] });
  const b = addTask(campaign, { title: 'B', paths: ['b.md'], dependsOn: [a.id] });
  const c = addTask(campaign, { title: 'C', paths: ['c.md'], dependsOn: [a.id] });
  const d = addTask(campaign, { title: 'D', paths: ['d.md'], dependsOn: [b.id, c.id] });
  const waves = planCampaignWaves(campaign);
  assert.deepEqual(waves, [[a.id], [b.id, c.id].sort(), [d.id]]);
  // Chu trình: sửa trực tiếp dependsOn rồi plan.
  const cyclic = makeCampaign();
  const x = addTask(cyclic, { title: 'X', paths: ['x.md'] });
  const y = addTask(cyclic, { title: 'Y', paths: ['y.md'], dependsOn: [x.id] });
  findFleetV5Task(cyclic, x.id).dependsOn = [y.id];
  assert.throws(() => planCampaignWaves(cyclic), /chu trình dependsOn/);
});

test('import graph: TS import/require/dynamic + Python; resolve đuôi + index; unresolved liệt kê', () => {
  const sweep = analyzeImportGraph([
    { path: 'src/a.ts', content: `import { b } from './b';\nimport './c';\nconst d = require('./sub/d');\nconst e = await import('./e');\nimport fs from 'node:fs';` },
    { path: 'src/b.ts', content: `export * from './c';` },
    { path: 'src/c.ts', content: `// no imports` },
    { path: 'src/sub/d.ts', content: `import { c } from '../c';` },
    { path: 'src/e/index.ts', content: `import { a } from '../a';` },
    { path: 'py/mod.py', content: `from .util import helper\nimport os\n` },
    { path: 'py/util.py', content: `# util` },
  ]);
  assert.deepEqual(sweep.files, ['py/mod.py', 'py/util.py', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/e/index.ts', 'src/sub/d.ts']);
  const edges = sweep.edges.map((e) => `${e.from}->${e.to}`);
  assert.ok(edges.includes('src/a.ts->src/b.ts'));
  assert.ok(edges.includes('src/a.ts->src/c.ts'));
  assert.ok(edges.includes('src/a.ts->src/sub/d.ts'));
  assert.ok(edges.includes('src/a.ts->src/e/index.ts'));
  assert.ok(edges.includes('src/b.ts->src/c.ts'));
  assert.ok(edges.includes('src/sub/d.ts->src/c.ts'));
  assert.ok(edges.includes('src/e/index.ts->src/a.ts'));
  assert.ok(edges.includes('py/mod.py->py/util.py'));
  assert.ok(!edges.some((e) => e.includes('node:fs'))); // package ngoài không phải cạnh
  assert.deepEqual(sweep.adjacency['src/a.ts'], ['src/b.ts', 'src/c.ts', 'src/e/index.ts', 'src/sub/d.ts']);
  // Import tới file không có trong tập -> unresolved.
  const sweep2 = analyzeImportGraph([
    { path: 'src/x.ts', content: `import { y } from './missing';` },
  ]);
  assert.deepEqual(sweep2.unresolved, [{ from: 'src/x.ts', specifier: './missing' }]);
  assert.throws(() => analyzeImportGraph([{ path: 'a.ts' }]), /cần \{ path/);
});

test('conflicts: same-file, path-overlap, dependency-order; task done thì không tính', () => {
  const campaign = makeCampaign();
  const t1 = addTask(campaign, { title: 'T1', paths: ['src/a.ts'] });
  const t2 = addTask(campaign, { title: 'T2', paths: ['src/a.ts'] });
  const t3 = addTask(campaign, { title: 'T3', paths: ['src/'] });
  const t4 = addTask(campaign, { title: 'T4', paths: ['src/b.ts'] });
  const sweep = analyzeImportGraph([
    { path: 'src/a.ts', content: `import { b } from './b';` },
    { path: 'src/b.ts', content: `// b` },
  ]);
  const conflicts = findCampaignConflicts(campaign.tasks, sweep);
  const kinds = conflicts.map((c) => c.kind);
  assert.ok(kinds.includes('same-file')); // T1 vs T2
  assert.ok(kinds.includes('path-overlap')); // T3 (src/) vs T1/T2/T4
  const order = conflicts.find((c) => c.kind === 'dependency-order' && c.taskBId === t4.id);
  assert.ok(order !== undefined);
  assert.equal(order.taskAId, t1.id); // T1 import file của T4 -> T4 xong trước
  // Task done thì loại khỏi conflict.
  claimNextFleetV5Task([campaign], 'bot-1', T0);
  completeFleetV5Task(campaign, t1.id, T0 + 1000);
  const after = findCampaignConflicts(campaign.tasks, sweep);
  assert.ok(!after.some((c) => c.kind === 'same-file' && (c.taskAId === t1.id || c.taskBId === t1.id)));
  // Không có sweep thì chỉ có same-file/path-overlap.
  const noSweep = findCampaignConflicts(campaign.tasks);
  assert.ok(!noSweep.some((c) => c.kind === 'dependency-order'));
  // Repo khác nhau thì không xung đột dù cùng path.
  const other = makeCampaign();
  addTask(other, { title: 'O1', repo: 'other-repo', paths: ['src/a.ts'] });
  assert.equal(findCampaignConflicts([...campaign.tasks, ...other.tasks]).filter((c) => c.kind === 'same-file').length, 0);
});

test('persistence: save/load round-trip giữ nguyên campaign + task; file hỏng thì throw', () => {
  const root = tmpDir();
  const campaign = makeCampaign();
  const task = addTask(campaign, { title: 'T1', priority: 'high', paths: ['a.md'] });
  claimNextFleetV5Task([campaign], 'bot-1', T0);
  saveFleetV5Campaigns(root, [campaign]);
  const loaded = loadFleetV5Campaigns(root);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, campaign.id);
  assert.equal(loaded[0].tasks.length, 1);
  assert.equal(loaded[0].tasks[0].id, task.id);
  assert.equal(loaded[0].tasks[0].status, 'assigned');
  assert.equal(loaded[0].tasks[0].assignedBotId, 'bot-1');
  // File chưa có -> [].
  assert.deepEqual(loadFleetV5Campaigns(tmpDir()), []);
  // File hỏng -> throw.
  const bad = tmpDir();
  fs.writeFileSync(path.join(bad, 'fleet-campaigns-v108.json'), '{not json', 'utf8');
  assert.throws(() => loadFleetV5Campaigns(bad), /not valid JSON/);
  const bad2 = tmpDir();
  fs.writeFileSync(path.join(bad2, 'fleet-campaigns-v108.json'), JSON.stringify([{ id: 'x' }]), 'utf8');
  assert.throws(() => loadFleetV5Campaigns(bad2), /corrupt at index 0/);
});
