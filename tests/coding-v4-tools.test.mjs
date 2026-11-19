/**
 * Tests for coding agent v4 — tools (v1.11, Doi T4):
 * `packages/tools/src/codingV4Tools.ts` + `codingV4RepoMap.ts`
 * (the 14 coding-v4 tools end to end, the v4 disk-cache build +
 * invalidation, sub-agent trees, model switching, coding profiles,
 * registry wiring).
 *
 * Real tree-sitter parse + real temp-dir files — no network, no live
 * services. Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/coding-v4-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODING_V4_TOOLS,
  CODING_V4_TOOL_NAMES,
  createCodingV4Tools,
  isCodingV4ToolName,
} from '../packages/tools/dist/codingV4Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { CodingV4RepoMapStore } from '../packages/tools/dist/codingV4RepoMap.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (tools, name) => tools.find((t) => t.definition.name === name);
const call = (tools, name, args, ctx) => tool(tools, name).execute(args, ctx);

function tmpDir(t, prefix = 'coding-v4-tools-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function fixtureRepo(dir) {
  write(dir, 'src/a.ts', 'export function alpha() {\n  return 1;\n}\n\nexport class Beta {\n  save() {\n    return true;\n  }\n}\n');
  write(dir, 'src/b.ts', "import { alpha } from './a';\nimport { Beta } from './a';\n\nexport function gamma() {\n  return alpha();\n}\n\nexport const b = new Beta();\n");
  write(dir, 'src/c.ts', 'export function delta() {\n  return 2;\n}\n');
  write(dir, 'lib/d.ts', "import { gamma } from '../src/b';\n\nexport function run() {\n  return gamma();\n}\n");
}

// --- Tool surface -------------------------------------------------------------

test('tool surface: 14 coding-v4 tools, names match, none needs approval', () => {
  assert.equal(CODING_V4_TOOLS.length, 14);
  assert.deepEqual(
    CODING_V4_TOOLS.map((t) => t.definition.name).sort(),
    [...CODING_V4_TOOL_NAMES].sort(),
  );
  assert.ok(CODING_V4_TOOL_NAMES.every((n) => n.startsWith('repomap_v4_') || n.startsWith('coding_v4_')));
  assert.equal(isCodingV4ToolName('repomap_v4_build'), true);
  assert.equal(isCodingV4ToolName('coding_v4_nope'), false);
  for (const t of CODING_V4_TOOLS) {
    assert.equal(t.needsApproval, false, t.definition.name);
    assert.ok(t.definition.description.length > 20, t.definition.name);
    assert.equal(typeof t.execute, 'function');
  }
});

test('registry wiring: ALL_TOOLS holds the 14 tools (491), binding keeps 491', () => {
  for (const name of CODING_V4_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((x) => x.definition.name === name), name);
  }
  // v1.11 (Doi T4): 289 + 14 coding v4 = 303. The coordinator re-pins
  // this number when merging the other v1.11 teams.
  assert.ok(ALL_TOOLS.length >= 1078); // v1.38 re-pin: 899 + 179 = 1078.
  assert.equal(new Set(ALL_TOOLS.map((x) => x.definition.name)).size, ALL_TOOLS.length);
  const bound = createDefaultTools({ getCodingV4WorkspaceDir: () => '/tmp/no-such-dir' });
  assert.equal(bound.length, ALL_TOOLS.length);
  for (const name of CODING_V4_TOOL_NAMES) {
    assert.ok(bound.some((x) => x.definition.name === name), name);
  }
});

// --- Repo map v4 ---------------------------------------------------------------

test('repomap_v4_build + rank + budget_map + invalidate end to end', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const tools = createCodingV4Tools({ workspaceDir: dir });
  const ctx = CTX(dir);

  const built = await call(tools, 'repomap_v4_build', {}, ctx);
  assert.match(built, /Repo map v4 built/);
  assert.match(built, /PageRank v2 weights/);
  assert.match(built, /top file: src\/a\.ts/);
  assert.match(built, /Cache v4: .*written/);

  const ranked = await call(tools, 'repomap_v4_rank', { limit: 3 }, ctx);
  assert.match(ranked, /#1 src\/a\.ts/);
  assert.match(ranked, /v4 .* = pr .* ref .* fresh/);

  const custom = await call(tools, 'repomap_v4_rank', {
    limit: 2,
    weightPageRank: 0,
    weightReferences: 0,
    weightFreshness: 1,
  }, ctx);
  assert.match(custom, /custom weights/);

  const budget = await call(tools, 'repomap_v4_budget_map', { budgetTokens: 2000 }, ctx);
  assert.match(budget, /Budget map v4:/);
  assert.match(budget, /src\/a\.ts/);

  const query = await call(tools, 'repomap_v4_budget_map', { query: 'alpha', budgetTokens: 2000 }, ctx);
  assert.match(query, /Seed files: src\/a\.ts/);

  const fresh = await call(tools, 'repomap_v4_invalidate', {}, ctx);
  assert.match(fresh, /Cache is fresh/);

  // Touch one file: invalidation must report it as changed.
  await new Promise((r) => setTimeout(r, 5));
  write(dir, 'src/c.ts', 'export function delta() {\n  return 3;\n}\n// changed\n');
  const stale = await call(tools, 'repomap_v4_invalidate', {}, ctx);
  assert.match(stale, /changed: 1/);
  assert.match(stale, /src\/c\.ts/);
  assert.match(stale, /Rebuild needed/);

  // The store itself keeps the v4 cache on disk.
  const store = new CodingV4RepoMapStore(dir);
  const stats = store.stats();
  assert.equal(stats.v4CacheVersion, 4);
  assert.ok(stats.v4CachePath.endsWith('repo-map-v4.json'));
});

// --- Sub-agent visualizer ------------------------------------------------------

test('subagent start/update/tree/detail: live tree with progress and log', async (t) => {
  const dir = tmpDir(t);
  const tools = createCodingV4Tools({ workspaceDir: dir });
  const ctx = CTX(dir);

  const missing = await call(tools, 'coding_v4_subagent_tree', { sessionId: 's1' }, ctx);
  assert.match(missing, /Error: Chua co cay task/);

  const started = await call(tools, 'coding_v4_subagent_start', { sessionId: 's1', title: 'Build feature' }, ctx);
  assert.match(started, /Task tree started/);
  assert.match(started, /Build feature/);

  const again = await call(tools, 'coding_v4_subagent_start', { sessionId: 's1', title: 'Again' }, ctx);
  assert.match(again, /Error: Session "s1" da co cay task/);

  const added = await call(tools, 'coding_v4_subagent_update', {
    sessionId: 's1',
    nodeId: 'root',
    action: 'add-child',
    title: 'Write handler',
    model: 'ollama/qwen2.5-coder:7b',
  }, ctx);
  assert.match(added, /Added child task "Write handler"/);
  const childId = /id "(task-\d+)"/.exec(added)[1];

  const updated = await call(tools, 'coding_v4_subagent_update', {
    sessionId: 's1',
    nodeId: childId,
    action: 'update',
    status: 'running',
    progress: 60,
    logLine: 'editing src/handler.ts',
    tokensUsed: 1200,
  }, ctx);
  assert.match(updated, /overall 60%/);
  assert.match(updated, /editing src\/handler\.ts/);

  const tree = await call(tools, 'coding_v4_subagent_tree', { sessionId: 's1' }, ctx);
  assert.match(tree, /2 tasks, overall 60%/);
  assert.match(tree, /pending 0, running 2/); // root (started) + child both running

  const detail = await call(tools, 'coding_v4_subagent_detail', { sessionId: 's1', nodeId: childId }, ctx);
  assert.match(detail, /Write handler/);
  assert.match(detail, /Model: ollama\/qwen2\.5-coder:7b/);
  assert.match(detail, /Tokens used: 1200/);
  assert.match(detail, /editing src\/handler\.ts/);

  const done = await call(tools, 'coding_v4_subagent_update', {
    sessionId: 's1',
    nodeId: childId,
    action: 'complete',
    logLine: 'handler done',
  }, ctx);
  assert.match(done, /done/);
  const tree2 = await call(tools, 'coding_v4_subagent_tree', { sessionId: 's1' }, ctx);
  assert.match(tree2, /overall 100%/);

  const badStatus = await call(tools, 'coding_v4_subagent_update', {
    sessionId: 's1',
    nodeId: childId,
    status: 'weird',
  }, ctx);
  assert.match(badStatus, /Error: status "weird" khong hop le/);
  const badAction = await call(tools, 'coding_v4_subagent_update', {
    sessionId: 's1',
    nodeId: childId,
    action: 'explode',
  }, ctx);
  assert.match(badAction, /Error: action "explode" khong hop le/);
});

// --- ACP-style model switching ---------------------------------------------------

test('model switch/history/status: transcript kept across switches', async (t) => {
  const dir = tmpDir(t);
  const tools = createCodingV4Tools({
    workspaceDir: dir,
    modelCatalog: ['ollama/qwen2.5-coder:7b', 'gemini-2.5-flash'],
  });
  const ctx = CTX(dir);

  const before = await call(tools, 'coding_v4_session_status', { sessionId: 's2' }, ctx);
  assert.match(before, /model ollama\/qwen2\.5-coder:7b/);
  assert.match(before, /Messages: 0/);

  const switched = await call(tools, 'coding_v4_model_switch', {
    sessionId: 's2',
    toModel: 'gemini-2.5-flash',
    reason: 'need a bigger model',
    message: 'fix the login bug',
    messageRole: 'user',
  }, ctx);
  assert.match(switched, /ollama\/qwen2\.5-coder:7b -> gemini-2\.5-flash/);
  assert.match(switched, /Transcript kept: 1 message/);

  const history = await call(tools, 'coding_v4_model_history', { sessionId: 's2' }, ctx);
  assert.match(history, /gemini-2\.5-flash/);
  assert.match(history, /need a bigger model/);
  assert.match(history, /giu 1 message/);

  const after = await call(tools, 'coding_v4_session_status', { sessionId: 's2' }, ctx);
  assert.match(after, /model gemini-2\.5-flash/);
  assert.match(after, /Messages: 1/);
  assert.match(after, /switches: 1/);

  const same = await call(tools, 'coding_v4_model_switch', {
    sessionId: 's2',
    toModel: 'gemini-2.5-flash',
    reason: 'no-op',
  }, ctx);
  assert.match(same, /Error: .*dang la model hien tai/);
  const unknown = await call(tools, 'coding_v4_model_switch', {
    sessionId: 's2',
    toModel: 'gpt-99',
    reason: 'not in catalog',
  }, ctx);
  assert.match(unknown, /Error: .*khong co trong catalog/);
});

// --- Coding profiles -------------------------------------------------------------

test('profile list/get/apply: kinds, task-type mapping, overrides', async (t) => {
  const dir = tmpDir(t);
  const tools = createCodingV4Tools({ workspaceDir: dir, knownToolNames: ['repomap_v4_rank', 'read_file'] });
  const ctx = CTX(dir);

  const list = await call(tools, 'coding_v4_profile_list', {}, ctx);
  for (const kind of ['coding-debug', 'coding-refactor', 'coding-feature', 'coding-review', 'coding-test', 'coding-explore']) {
    assert.match(list, new RegExp(kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const debug = await call(tools, 'coding_v4_profile_get', { kind: 'debug' }, ctx);
  assert.match(debug, /Profile coding-debug/);
  assert.match(debug, /Allowed tools/);
  assert.match(debug, /Reproduce the bug first/);

  const missing = await call(tools, 'coding_v4_profile_get', { kind: 'nope' }, ctx);
  assert.match(missing, /Error: Khong co coding profile/);

  // taskType "fix" maps to the debug profile; unknown tools are dropped.
  const applied = await call(tools, 'coding_v4_profile_apply', { taskType: 'fix' }, ctx);
  assert.match(applied, /Profile applied: coding-debug \(debug\) for task type "fix"/);
  assert.match(applied, /Allowed tools \(2\): repomap_v4_rank, read_file/);
  assert.match(applied, /Warning: Tool "repomap_v4_budget_map" khong co trong registry/);

  const overridden = await call(tools, 'coding_v4_profile_apply', {
    kind: 'test',
    modelId: 'my-model',
    maxSteps: 3,
  }, ctx);
  assert.match(overridden, /Profile applied: coding-test/);
  assert.match(overridden, /Model: my-model/);
  assert.match(overridden, /Max steps: 3/);

  const neither = await call(tools, 'coding_v4_profile_apply', {}, ctx);
  assert.match(neither, /Error: .*can kind hoac taskType/);
});
