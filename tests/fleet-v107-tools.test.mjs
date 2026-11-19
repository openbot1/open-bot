/**
 * Tests for the fleet v4 teams tools (packages/tools/src/fleetV4TeamsTools.ts).
 *
 * Covers registry membership (each of the 5 names exactly once in
 * ALL_TOOLS, no duplicates, no placeholders left unbound-checked),
 * the unbound behaviour (file-backed tools say "not wired", pure
 * tools still run), bound execution against a temp userData dir
 * (team create/status round-trip, overlapping slices rejected,
 * prompt-cache stats/invalidate/clear), and `createDefaultTools`
 * binding without duplicates.
 *
 * Run after building tools (which builds core first):
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/fleet-v107-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  FLEET_V4_TEAMS_TOOL_NAMES,
  FLEET_V4_TEAMS_TOOLS,
  createFleetV4TeamsTools,
} from '../packages/tools/dist/fleetV4TeamsTools.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-teams-tools-'));
}

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly one tool named ${name}, got ${found.length}`);
  return found[0];
}

function toolNames(tools) {
  return tools.map((t) => t.definition.name);
}

const CTX = { workspaceDir: '/tmp', signal: undefined };

function teamArgs(overrides = {}) {
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
      { id: 'research', title: 'Research', brief: 'Nghiên cứu.', ownerName: 'Minh', owns: ['docs/memory/'] },
      { id: 'impl', title: 'Implement', brief: 'Cài đặt.', ownerName: 'Hoa', owns: ['packages/core/src/memory/'], dependsOn: ['research'] },
    ],
    ...overrides,
  };
}

test('registry: all 5 fleet v4 teams tools in ALL_TOOLS exactly once', () => {
  for (const name of FLEET_V4_TEAMS_TOOL_NAMES) {
    assert.ok(toolNames(ALL_TOOLS).includes(name), `ALL_TOOLS missing ${name}`);
    assert.equal(toolNames(ALL_TOOLS).filter((n) => n === name).length, 1, `${name} duplicated`);
  }
  assert.equal(FLEET_V4_TEAMS_TOOLS.length, 5);
  assert.equal(new Set(toolNames(ALL_TOOLS)).size, toolNames(ALL_TOOLS).length, 'ALL_TOOLS has duplicate names');
  assert.ok(ALL_TOOLS.length >= 1078); // v1.14 merge: 453 + 38 = 500; v1.13: 402 + 51 = 453; v1.10 merge: 236 + 9 memory_v10 + 18 teams_v2 + 12 coding_v3 + 14 fleet_v7 = 289; v1.11 merge: 289 + 70 = 359 // v1.38 re-pin: 899 + 179 = 1078.
});

test('unbound: file-backed tools say not wired; pure tools still run', async () => {
  const create = toolByName(FLEET_V4_TEAMS_TOOLS, 'fleet_v4_team_create');
  assert.match(await create.execute(teamArgs(), CTX), /not wired/);
  const status = toolByName(FLEET_V4_TEAMS_TOOLS, 'fleet_v4_team_status');
  assert.match(await status.execute({}, CTX), /not wired/);
  const cache = toolByName(FLEET_V4_TEAMS_TOOLS, 'fleet_v4_prompt_cache');
  assert.match(await cache.execute({ action: 'stats' }, CTX), /not wired/);

  // Pure tools: worktree plan + context strategy run unbound.
  const worktree = toolByName(FLEET_V4_TEAMS_TOOLS, 'fleet_v4_team_worktree');
  const plan = JSON.parse(await worktree.execute({ repoRoot: '/home/hatch/workspace/open-bot', branch: 'v107-fleet' }, CTX));
  assert.equal(plan.plan.branch, 'v107-fleet');
  assert.equal(plan.plan.worktreePath, '/home/hatch/workspace/open-bot-v107-fleet');
  assert.equal(plan.sampleEnvelope.branch, 'v107-fleet');

  const strategy = toolByName(FLEET_V4_TEAMS_TOOLS, 'fleet_v4_context_strategy');
  const s = JSON.parse(await strategy.execute({ model: 'claude-sonnet-4-5', usedTokens: 10_000 }, CTX));
  assert.equal(s.windowTokens, 1_000_000);
  assert.equal(s.strategy, 'none');
  assert.equal(s.windowSource, 'exact-model');
});

test('bound: team_create + team_status round-trip; trùng tên team → lỗi', async () => {
  const dir = tmpDir();
  const tools = createFleetV4TeamsTools(() => dir);
  const create = toolByName(tools, 'fleet_v4_team_create');
  const created = JSON.parse(await create.execute(teamArgs(), CTX));
  assert.equal(created.team.name, 'Alpha');
  assert.equal(created.team.workstreams, 2);
  assert.equal(created.team.members, 3);
  assert.match(await create.execute(teamArgs(), CTX), /Đã có team tên/);

  const status = toolByName(tools, 'fleet_v4_team_status');
  const list = JSON.parse(await status.execute({}, CTX));
  assert.equal(list.count, 1);
  assert.equal(list.teams[0].name, 'Alpha');
  const one = JSON.parse(await status.execute({ teamId: created.team.id }, CTX));
  assert.equal(one.goal, 'Xây memory v8');
  assert.equal(one.workstreams.length, 2);
  assert.equal(one.members.length, 3);
  assert.match(await status.execute({ teamId: 'team-khong-co' }, CTX), /Không có team/);
  // File team đã ghi thật xuống đĩa.
  assert.ok(fs.existsSync(path.join(dir, 'fleet', 'agent-teams-v107.json')));
});

test('bound: team_create chồng slice → lỗi, team không được lưu', async () => {
  const dir = tmpDir();
  const tools = createFleetV4TeamsTools(() => dir);
  const create = toolByName(tools, 'fleet_v4_team_create');
  const out = await create.execute(
    teamArgs({
      workstreams: [
        { id: 'a', title: 'A', brief: 'B.', ownerName: 'Minh', owns: ['packages/core/src/memory/'] },
        { id: 'b', title: 'B', brief: 'B.', ownerName: 'Hoa', owns: ['packages/core/src/memory/tiers.ts'] },
      ],
    }),
    CTX,
  );
  assert.match(out, /chồng slice sở hữu/);
  assert.equal(fs.existsSync(path.join(dir, 'fleet', 'agent-teams-v107.json')), false);
});

test('bound: team_create role lạ / coordinator sai role → lỗi rõ ràng', async () => {
  const dir = tmpDir();
  const tools = createFleetV4TeamsTools(() => dir);
  const create = toolByName(tools, 'fleet_v4_team_create');
  assert.match(
    await create.execute(teamArgs({ members: [{ name: 'Lan', role: 'boss' }] }), CTX),
    /role phải là một trong/,
  );
  assert.match(
    await create.execute(teamArgs({ coordinatorName: 'Minh' }), CTX),
    /phải có role coordinator/,
  );
});

test('tool: fleet_v4_team_worktree branch sai luật → lỗi; repoRoot tương đối → lỗi', async () => {
  const worktree = toolByName(FLEET_V4_TEAMS_TOOLS, 'fleet_v4_team_worktree');
  assert.match(
    await worktree.execute({ repoRoot: '/repo/a', branch: 'bad..name' }, CTX),
    /tên branch/,
  );
  assert.match(
    await worktree.execute({ repoRoot: 'relative/path', branch: 'ok' }, CTX),
    /đường dẫn tuyệt đối/,
  );
});

test('tool: fleet_v4_context_strategy — gần đầy thì summarize, đầy thì truncate + gợi ý model lớn', async () => {
  const strategy = toolByName(FLEET_V4_TEAMS_TOOLS, 'fleet_v4_context_strategy');
  const warn = JSON.parse(
    await strategy.execute({ model: 'gpt-4o', usedTokens: 100_000 }, CTX),
  );
  assert.equal(warn.windowTokens, 128_000);
  assert.equal(warn.strategy, 'summarize-oldest');
  assert.equal(warn.budget.totalTokens, 128_000);

  const full = JSON.parse(
    await strategy.execute(
      {
        model: 'gpt-4o',
        usedTokens: 125_000,
        candidates: [{ id: 'big', providerId: 'anthropic', model: 'claude-sonnet-4-5', kind: 'api' }],
      },
      CTX,
    ),
  );
  assert.equal(full.strategy, 'truncate-hard');
  assert.equal(full.largerWindowSuggestion.targetId, 'big');
  assert.equal(full.largerWindowSuggestion.windowTokens, 1_000_000);

  assert.match(
    await strategy.execute({ model: 'gpt-4o', usedTokens: -1 }, CTX),
    /usedTokens must be >= 0/,
  );
});

test('bound: fleet_v4_prompt_cache stats/invalidate/clear trên file thật', async () => {
  const dir = tmpDir();
  const tools = createFleetV4TeamsTools(() => dir);
  const cacheTool = toolByName(tools, 'fleet_v4_prompt_cache');
  // Chưa có cache → stats rỗng.
  const empty = JSON.parse(await cacheTool.execute({ action: 'stats' }, CTX));
  assert.equal(empty.stats.compilations, 0);
  assert.equal(empty.stats.entries, 0);
  // Ghi cache giả bằng tay rồi đọc lại qua tool.
  const { CompiledPromptCache, savePromptCache } = await import('../packages/core/dist/context/promptCache.js');
  const cache = new CompiledPromptCache();
  cache.compile([
    { label: 'human', tier: 'semantic', scope: 'system', description: '', content: 'Tên tôi là Huy.', readOnly: false, version: 1, createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z' },
  ]);
  savePromptCache(path.join(dir, 'fleet'), cache);
  const stats = JSON.parse(await cacheTool.execute({ action: 'stats' }, CTX));
  assert.equal(stats.stats.compilations, 1);
  assert.equal(stats.stats.entries, 1);
  assert.notEqual(stats.promptHash, null);
  // Invalidate label → prompt cũ rơi, stats giữ nguyên compilations.
  const inv = JSON.parse(await cacheTool.execute({ action: 'invalidate', label: 'human' }, CTX));
  assert.equal(inv.label, 'human');
  assert.equal(inv.stats.entries, 0);
  // Clear → stats reset về 0 (file vẫn còn, rỗng).
  const cleared = JSON.parse(await cacheTool.execute({ action: 'clear' }, CTX));
  assert.equal(cleared.stats.compilations, 0);
  assert.match(await cacheTool.execute({ action: 'nope' }, CTX), /action must be one of/);
});

test('binding: createDefaultTools với getFleetV4TeamsBaseDir không trùng tool', () => {
  const dir = tmpDir();
  const bound = createDefaultTools({ getFleetV4TeamsBaseDir: () => dir });
  assert.equal(bound.length, ALL_TOOLS.length);
  assert.equal(new Set(toolNames(bound)).size, bound.length);
  for (const name of FLEET_V4_TEAMS_TOOL_NAMES) {
    assert.equal(toolNames(bound).filter((n) => n === name).length, 1, `${name} duplicated after binding`);
  }
  const plain = createDefaultTools();
  assert.equal(plain.length, ALL_TOOLS.length);
});
