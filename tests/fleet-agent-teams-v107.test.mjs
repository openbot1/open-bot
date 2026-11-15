/**
 * Tests for Agent Teams (packages/core/src/fleet/agentTeams.ts).
 *
 * Covers team creation + validation (coordinator role, unique
 * members, owner must exist, one slice per member), disjoint-slice
 * overlap detection (exact / prefix / abstract key), persistence
 * (save/load round-trip + corrupt file throws), topological waves
 * (dependency ordering + cycle detection), parallel runs with a mock
 * runner (concurrency, failed member does not kill the team,
 * dependent workstream skipped with reason), and the coordinator
 * merge report.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-agent-teams-v107.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createAgentTeam,
  findOverlappingWorkstreams,
  loadAgentTeams,
  mergeTeamResults,
  ownedSlicesOverlap,
  planTeamWaves,
  runAgentTeam,
  saveAgentTeams,
  summarizeAgentTeam,
  validateAgentTeam,
} from '../packages/core/dist/fleet/agentTeams.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-teams-v107-'));
}

function makeTeamInput(overrides = {}) {
  return {
    name: 'Alpha',
    goal: 'Xây memory v8',
    coordinatorName: 'Lan',
    members: [
      { name: 'Lan', role: 'coordinator' },
      { name: 'Minh', role: 'researcher' },
      { name: 'Hoa', role: 'implementer' },
    ],
    workstreams: [
      { id: 'research', title: 'Research', brief: 'Nghiên cứu Mem0 v3.', ownerName: 'Minh', owns: ['docs/memory/'] },
      { id: 'impl', title: 'Implement', brief: 'Cài memory v8.', ownerName: 'Hoa', owns: ['packages/core/src/memory/'], dependsOn: ['research'] },
    ],
    ...overrides,
  };
}

function mockRunner(results) {
  return async (member, workstream) => {
    const r = results[workstream.id] ?? { status: 'done', summary: `Xong ${workstream.id}.`, artifacts: [], toolCallCount: 3 };
    return {
      workstreamId: workstream.id,
      memberId: member.id,
      status: r.status,
      summary: r.summary,
      artifacts: r.artifacts ?? [],
      toolCallCount: r.toolCallCount ?? 1,
      durationMs: 10,
      ...(r.error ? { error: r.error } : {}),
    };
  };
}

test('teams: tạo team hợp lệ, điều phối viên + member + workstream gắn đúng', () => {
  const team = createAgentTeam(makeTeamInput());
  assert.match(team.id, /^team-/);
  assert.equal(team.name, 'Alpha');
  assert.equal(team.status, 'active');
  assert.equal(team.members.length, 3);
  const coord = team.members.find((m) => m.id === team.coordinatorId);
  assert.equal(coord?.name, 'Lan');
  assert.equal(coord?.role, 'coordinator');
  const impl = team.workstreams.find((w) => w.id === 'impl');
  assert.equal(impl?.dependsOn[0], 'research');
  assert.equal(team.events[0]?.type, 'created');
});

test('teams: coordinator không có role coordinator → throw', () => {
  assert.throws(
    () => createAgentTeam(makeTeamInput({ coordinatorName: 'Minh' })),
    /phải có role coordinator/,
  );
});

test('teams: workstream owner không tồn tại → throw', () => {
  assert.throws(
    () =>
      createAgentTeam(
        makeTeamInput({
          workstreams: [{ id: 'x', title: 'X', brief: 'B.', ownerName: 'KhôngAi', owns: [] }],
        }),
      ),
    /không có trong members/,
  );
});

test('teams: một member sở hữu 2 workstream → throw (tránh nút thắt)', () => {
  assert.throws(
    () =>
      createAgentTeam(
        makeTeamInput({
          workstreams: [
            { id: 'a', title: 'A', brief: 'B.', ownerName: 'Minh', owns: ['docs/a/'] },
            { id: 'b', title: 'B', brief: 'B.', ownerName: 'Minh', owns: ['docs/b/'] },
          ],
        }),
      ),
    /chỉ sở hữu một lát cắt/,
  );
});

test('teams: chồng slice — bằng nhau, tiền tố, key trừu tượng đều bắt được', () => {
  assert.equal(ownedSlicesOverlap('packages/core/src/memory/', 'packages/core/src/memory/'), true);
  assert.equal(ownedSlicesOverlap('packages/core/src/memory/', 'packages/core/src/memory/tiers.ts'), true);
  assert.equal(ownedSlicesOverlap('packages/core/src/memory/tiers.ts', 'packages/core/src/memory/'), true);
  assert.equal(ownedSlicesOverlap('docs:memory', 'docs:memory'), true);
  assert.equal(ownedSlicesOverlap('packages/core/src/memory/', 'packages/core/src/router/'), false);
  assert.equal(ownedSlicesOverlap('docs/memory/', 'docs/router/'), false);
  assert.equal(ownedSlicesOverlap('', 'packages/core/'), false);
});

test('teams: tạo team với workstream chồng slice → throw, nêu rõ cặp chồng', () => {
  assert.throws(
    () =>
      createAgentTeam(
        makeTeamInput({
          workstreams: [
            { id: 'a', title: 'A', brief: 'B.', ownerName: 'Minh', owns: ['packages/core/src/memory/'] },
            { id: 'b', title: 'B', brief: 'B.', ownerName: 'Hoa', owns: ['packages/core/src/memory/tiers.ts'] },
          ],
        }),
      ),
    /chồng slice sở hữu/,
  );
});

test('teams: findOverlappingWorkstreams liệt kê đủ cặp chồng', () => {
  const team = createAgentTeam(makeTeamInput());
  const bad = {
    ...team,
    workstreams: [
      { ...team.workstreams[0], owns: ['packages/core/src/memory/'] },
      { ...team.workstreams[1], owns: ['packages/core/src/memory/'] },
    ],
  };
  const overlaps = findOverlappingWorkstreams(bad.workstreams);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0]?.a, 'research');
  assert.equal(overlaps[0]?.b, 'impl');
  assert.throws(() => validateAgentTeam(bad), /chồng slice/);
});

test('teams: sóng topo xếp theo dependsOn, chu trình → throw', () => {
  const team = createAgentTeam(makeTeamInput());
  const waves = planTeamWaves(team.workstreams);
  assert.equal(waves.length, 2);
  assert.deepEqual(waves[0]?.map((w) => w.id), ['research']);
  assert.deepEqual(waves[1]?.map((w) => w.id), ['impl']);
  const cyclic = [
    { id: 'a', title: 'A', brief: 'B', ownerId: 'x', owns: [], dependsOn: ['b'], status: 'pending' },
    { id: 'b', title: 'B', brief: 'B', ownerId: 'x', owns: [], dependsOn: ['a'], status: 'pending' },
  ];
  assert.throws(() => planTeamWaves(cyclic), /chu trình phụ thuộc/);
});

test('teams: chạy team song song — sóng sau chờ sóng trước, báo cáo gộp đủ mục', async () => {
  const team = createAgentTeam(makeTeamInput());
  const order = [];
  const runner = async (member, workstream) => {
    order.push(workstream.id);
    return {
      workstreamId: workstream.id,
      memberId: member.id,
      status: 'done',
      summary: `Xong ${workstream.title} với kết quả rõ ràng.`,
      artifacts: [`${workstream.id}.md`],
      toolCallCount: 5,
      durationMs: 1,
    };
  };
  const { team: next, report } = await runAgentTeam(team, runner, { concurrency: 2, now: () => 1000 });
  assert.deepEqual(order, ['research', 'impl']);
  assert.equal(next.status, 'completed');
  assert.equal(report.done, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.skipped, 0);
  assert.equal(report.waves, 2);
  assert.equal(report.totalToolCalls, 10);
  assert.match(report.summary, /Team "Alpha"/);
  assert.match(report.summary, /Điều phối: Lan/);
  assert.match(report.summary, /research\.md/);
  assert.equal(summarizeAgentTeam(next).done, 2);
});

test('teams: member lỗi không kéo sập team — workstream phụ thuộc bị skip có lý do', async () => {
  const team = createAgentTeam(makeTeamInput());
  const runner = mockRunner({
    research: { status: 'failed', summary: '', error: 'Research timeout sau 30s.' },
  });
  const { team: next, report } = await runAgentTeam(team, runner, { now: () => 2000 });
  assert.equal(report.done, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.skipped, 1);
  assert.equal(next.workstreams.find((w) => w.id === 'impl')?.status, 'skipped');
  assert.match(next.workstreams.find((w) => w.id === 'impl')?.lastSummary ?? '', /phụ thuộc "research" đã thất bại/);
  assert.match(report.summary, /BỎ QUA/);
  assert.match(report.summary, /Research timeout/);
});

test('teams: runner throw → workstream failed, team vẫn gộp phần còn lại', async () => {
  const team = createAgentTeam(makeTeamInput());
  const runner = async (member, workstream) => {
    if (workstream.id === 'research') throw new Error('Runner sập.');
    return { workstreamId: workstream.id, memberId: member.id, status: 'done', summary: 'Impl xong.', artifacts: [], toolCallCount: 2, durationMs: 1 };
  };
  const { report } = await runAgentTeam(team, runner, { now: () => 3000 });
  assert.equal(report.failed, 1);
  assert.equal(report.done, 0);
  assert.equal(report.skipped, 1);
});

test('teams: team paused → chạy throw; concurrency <= 0 → throw', async () => {
  const team = createAgentTeam(makeTeamInput());
  const paused = { ...team, status: 'paused' };
  await assert.rejects(() => runAgentTeam(paused, mockRunner({})), /đang paused/);
  await assert.rejects(() => runAgentTeam(team, mockRunner({}), { concurrency: 0 }), /concurrency > 0/);
});

test('teams: mergeTeamResults thuần — tóm tắt có đủ workstream + lỗi', () => {
  const team = createAgentTeam(makeTeamInput());
  const report = mergeTeamResults(
    { ...team, workstreams: team.workstreams.map((w) => ({ ...w, status: w.id === 'research' ? 'done' : 'skipped' })) },
    [
      { workstreamId: 'research', memberId: team.members[1].id, status: 'done', summary: 'Tìm thấy 3 nguồn.', artifacts: ['notes.md'], toolCallCount: 7, durationMs: 50 },
    ],
    { startedAt: 100, finishedAt: 250, waves: 2 },
  );
  assert.equal(report.durationMs, 150);
  assert.match(report.summary, /Tìm thấy 3 nguồn/);
  assert.match(report.summary, /notes\.md/);
  assert.match(report.summary, /BỎ QUA/);
});

test('teams: save/load round-trip; file chưa có → []; JSON hỏng → throw', () => {
  const dir = tmpDir();
  const fleetRoot = path.join(dir, 'fleet');
  assert.deepEqual(loadAgentTeams(fleetRoot), []);
  const team = createAgentTeam(makeTeamInput());
  saveAgentTeams(fleetRoot, [team]);
  const loaded = loadAgentTeams(fleetRoot);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.name, 'Alpha');
  assert.equal(loaded[0]?.workstreams.length, 2);
  fs.writeFileSync(path.join(fleetRoot, 'agent-teams-v107.json'), '{ hỏng', 'utf8');
  assert.throws(() => loadAgentTeams(fleetRoot), /không phải JSON hợp lệ/);
});
