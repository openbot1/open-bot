/**
 * Tests for coding agent v3 — tools (v1.10, Đội T4):
 * `packages/tools/src/codingV3Tools.ts` + `codingV3RepoMap.ts`
 * (the 12 coding-v3 tools end to end, the incremental disk-cache
 * build, registry wiring).
 *
 * Real tree-sitter parse + real temp-dir file edits + real eval runs
 * — no network, no live services. Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/coding-v3-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODING_V3_TOOLS,
  CODING_V3_TOOL_NAMES,
  createCodingV3Tools,
  isCodingV3ToolName,
} from '../packages/tools/dist/codingV3Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { CodingV3RepoMapStore } from '../packages/tools/dist/codingV3RepoMap.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (tools, name) => tools.find((t) => t.definition.name === name);
const call = (tools, name, args, ctx) => tool(tools, name).execute(args, ctx);

function tmpDir(t, prefix = 'coding-v3-tools-') {
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

test('tool surface: 12 coding-v3 tools, names match, approval flags split', () => {
  assert.equal(CODING_V3_TOOLS.length, 12);
  assert.deepEqual(
    CODING_V3_TOOLS.map((t) => t.definition.name).sort(),
    [...CODING_V3_TOOL_NAMES].sort(),
  );
  assert.ok(CODING_V3_TOOL_NAMES.every((n) => n.startsWith('repomap_v3_') || n.startsWith('coding_v3_') || n.startsWith('eval_v3_') || n.startsWith('router_v3_')));
  assert.equal(isCodingV3ToolName('repomap_v3_build'), true);
  assert.equal(isCodingV3ToolName('coding_v3_nope'), false);
  const writes = ['coding_v3_team_run'];
  for (const name of CODING_V3_TOOL_NAMES) {
    assert.equal(tool(CODING_V3_TOOLS, name).needsApproval, writes.includes(name), name);
  }
  for (const t of CODING_V3_TOOLS) {
    assert.ok(t.definition.description.length > 20, t.definition.name);
    assert.equal(typeof t.execute, 'function');
  }
});

test('registry wiring: ALL_TOOLS holds the 12 tools, binding keeps the count', () => {
  for (const name of CODING_V3_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((x) => x.definition.name === name), name);
  }
  assert.equal(new Set(ALL_TOOLS.map((x) => x.definition.name)).size, ALL_TOOLS.length);
  const bound = createDefaultTools({ getCodingV3WorkspaceDir: () => '/tmp/no-such-dir' });
  assert.equal(bound.length, ALL_TOOLS.length);
  for (const name of CODING_V3_TOOL_NAMES) {
    assert.ok(bound.some((x) => x.definition.name === name), name);
  }
});

test('unbound tools refuse without a workspaceDir', async () => {
  const result = await tool(CODING_V3_TOOLS, 'repomap_v3_build').execute({}, { workspaceDir: '' });
  assert.match(result, /^Error: workspaceDir is required/);
});

// --- Repo map store + tools ----------------------------------------------------

test('repomap_v3_build: real parse, call edges, modules, v3 cache; 2nd build reuses cache', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const tools = createCodingV3Tools({ workspaceDir: dir });
  const ctx = CTX(dir);

  const first = await call(tools, 'repomap_v3_build', {}, ctx);
  assert.match(first, /Files: 4, symbols: \d+, edges: \d+/);
  assert.match(first, /Call edges \(file->file\): [1-9]/);
  assert.match(first, /modules: 2/);
  assert.match(first, /top module: src/);
  assert.match(first, /re-parsed 4, reused from cache 0/);
  assert.match(first, /Cache v3: .* \(written\)/);
  assert.ok(fs.existsSync(path.join(dir, '.open-bot/coding-v3/repo-map-v3.json')));
  const v3Cache = JSON.parse(fs.readFileSync(path.join(dir, '.open-bot/coding-v3/repo-map-v3.json'), 'utf8'));
  assert.equal(v3Cache.version, 3);
  assert.equal(v3Cache.files, 4);

  const second = await call(tools, 'repomap_v3_build', {}, ctx);
  assert.match(second, /re-parsed 0, reused from cache 4/);
  assert.match(second, /already fresh/);
});

test('repomap_v3_modules / budget_map / calls read the built map', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const tools = createCodingV3Tools({ workspaceDir: dir });
  const ctx = CTX(dir);
  await call(tools, 'repomap_v3_build', {}, ctx);

  const modules = await call(tools, 'repomap_v3_modules', {}, ctx);
  assert.match(modules, /#1 src \(score/);
  assert.match(modules, /#2 lib \(score/);
  assert.match(modules, /Top \d+ call edge\(s\):/);
  assert.match(modules, /src\/b\.ts -> src\/a\.ts/);

  const budget = await call(tools, 'repomap_v3_budget_map', { budgetTokens: 2000 }, ctx);
  assert.match(budget, /Budget map: ~\d+ tokens \(budget 2000\), 4\/4 files included/);
  assert.match(budget, /src\/a\.ts \[score/);

  const tiny = await call(tools, 'repomap_v3_budget_map', { budgetTokens: 30 }, ctx);
  assert.match(tiny, /cut by budget/);

  const queried = await call(tools, 'repomap_v3_budget_map', { query: 'gamma', budgetTokens: 2000 }, ctx);
  assert.match(queried, /Seed files: src\/b\.ts/);

  const calls = await call(tools, 'repomap_v3_calls', { file: 'src/b.ts' }, ctx);
  assert.match(calls, /Calls \(1\):/);
  assert.match(calls, /-> src\/a\.ts/);
  assert.match(calls, /Called by \(1\):/);
  assert.match(calls, /<- lib\/d\.ts/);
});

test('CodingV3RepoMapStore directly: stats + topCallEdges + budgetMap', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const store = new CodingV3RepoMapStore(dir);
  const result = await store.build();
  assert.equal(result.files, 4);
  assert.equal(result.callEdges, 2, 'b->a and d->b are the only file->file call edges');
  assert.equal(result.modules, 2);
  assert.equal(store.isBuilt, true);
  const stats = store.stats();
  assert.equal(stats.built, true);
  assert.equal(stats.v3CacheVersion, 3);
  assert.ok(store.topCallEdges(2).length >= 1);
  const map = store.budgetMap(2000);
  assert.equal(map.includedFiles.length, 4);
  assert.equal(map.truncated, false);
});

// --- Team tools ----------------------------------------------------------------

test('coding_v3_team_run: patch executor edits files for real; team_status recalls the run', async (t) => {
  const dir = tmpDir(t);
  write(dir, 'src/a.ts', 'export const x = 1;\n');
  const tools = createCodingV3Tools({ workspaceDir: dir });
  const ctx = CTX(dir);

  const empty = await call(tools, 'coding_v3_team_status', {}, ctx);
  assert.match(empty, /No coding-v3 team run yet/);

  const result = await call(tools, 'coding_v3_team_run', {
    title: 'Add a helper file',
    spec: 'Create src/helper.ts',
    files: ['src/helper.ts'],
    maxConcurrentThreads: 2,
    edits: [{ path: 'src/helper.ts', kind: 'create', content: 'export const helper = 42;\n' }],
  }, ctx);
  assert.match(result, /1\/1 subtask\(s\) done, 0 failed/);
  assert.match(result, /status done/);
  assert.equal(fs.readFileSync(path.join(dir, 'src/helper.ts'), 'utf8'), 'export const helper = 42;\n');

  const status = await call(tools, 'coding_v3_team_status', {}, ctx);
  assert.match(status, /Team run .* — done \(/);
  assert.match(status, /max concurrency 1\/2/);
  assert.match(status, /src\/helper\.ts \(create/);
});

// --- Eval tools -----------------------------------------------------------------

test('eval_v3_list / eval_v3_suite: sample tasks listed and run for real (3 pass)', async () => {
  const tools = createCodingV3Tools({ workspaceDir: '/tmp' });
  const ctx = CTX('/tmp');
  const list = await call(tools, 'eval_v3_list', {}, ctx);
  assert.match(list, /sample-add: Viết hàm cộng/);
  assert.match(list, /sample-fix: Sửa hàm trừ/);
  assert.match(list, /sample-create: Tạo module greet/);
  const suite = await call(tools, 'eval_v3_suite', {}, ctx);
  assert.match(suite, /3\/3 task\(s\) pass \(0 fail, 0 error\)/);
  assert.match(suite, /sample-add/);
});

test('eval_v3_run: a failing task reports fail with the exit code', async () => {
  const tools = createCodingV3Tools({ workspaceDir: '/tmp' });
  const ctx = CTX('/tmp');
  const result = await call(tools, 'eval_v3_run', {
    task: {
      id: 'tool-fail',
      title: 'Fails on purpose',
      testCommands: [{ name: 'boom', argv: [process.execPath, '-e', 'process.exit(3);'] }],
    },
  }, ctx);
  assert.match(result, /FAIL/);
  assert.match(result, /exit 3/);
});

// --- Router tools -----------------------------------------------------------------

test('router_v3_pick / record_failure / catalog', async () => {
  const tools = createCodingV3Tools({ workspaceDir: '/tmp' });
  const ctx = CTX('/tmp');
  const catalog = await call(tools, 'router_v3_catalog', {}, ctx);
  assert.match(catalog, /Router catalog \(7 models\):/);
  assert.match(catalog, /ollama\/qwen2\.5-coder:7b/);

  const pick = await call(tools, 'router_v3_pick', { type: 'explore', difficulty: 2 }, ctx);
  assert.match(pick, /ollama\/qwen2\.5-coder:7b/);
  assert.match(pick, /Fallbacks \(in order\):/);
  assert.match(pick, /gemini-2\.5-flash/);

  const recorded = await call(tools, 'router_v3_record_failure', { modelId: 'ollama/qwen2.5-coder:7b', error: 'API 500' }, ctx);
  assert.match(recorded, /Recorded failure for ollama\/qwen2\.5-coder:7b/);
  const repick = await call(tools, 'router_v3_pick', { type: 'explore', difficulty: 2 }, ctx);
  assert.match(repick, /gemini-2\.5-flash/);
  assert.match(repick, /Excluded \(recent failure\): ollama\/qwen2\.5-coder:7b/);

  // Latency budget: only the fast cloud model qualifies; slow models are excluded by budget.
  // (qwen 7b was already excluded by the recorded failure above, so it shows under failures, not budget.)
  const fast = await call(tools, 'router_v3_pick', { type: 'explore', difficulty: 2, maxLatencyMs: 1300 }, ctx);
  assert.match(fast, /gemini-2\.5-flash/);
  assert.match(fast, /Excluded \(budget\): ollama\/qwen2\.5-coder:32b/);
  assert.match(fast, /gpt-5-mini \(độ trễ p50 1500ms vượt ngân sách 1300ms\)/);

  const bad = await call(tools, 'router_v3_pick', { type: 'nope' }, ctx);
  assert.match(bad, /^Error: type "nope" không hợp lệ/);
});
