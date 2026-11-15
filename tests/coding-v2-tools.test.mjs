/**
 * Tests for coding agent v2 — tools (v1.08, Đội T2):
 * `packages/tools/src/codingV2Tools.ts` + `codingV2RepoMap.ts`
 * (the 10 coding_v2_* tools end to end, the incremental disk-cache
 * build, registry wiring: ALL_TOOLS 202, coordinator registry 500
 * is covered by the updated pins in coordinator/wiring tests).
 *
 * Real tree-sitter parse + real git in temp dirs — no network, no
 * live services. Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/coding-v2-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODING_V2_TOOLS,
  CODING_V2_TOOL_NAMES,
  createCodingV2Tools,
  isCodingV2ToolName,
} from '../packages/tools/dist/codingV2Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { CodingV2RepoMapStore } from '../packages/tools/dist/codingV2RepoMap.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (tools, name) => tools.find((t) => t.definition.name === name);
const call = (tools, name, args, ctx) => tool(tools, name).execute(args, ctx);

function tmpDir(t, prefix = 'coding-v2-tools-') {
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
}

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

function initGitRepo(t) {
  const dir = tmpDir(t, 'coding-v2-git-tools-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  return dir;
}

// --- Tool surface -------------------------------------------------------------

test('tool surface: 10 coding_v2_* tools, names match, approval flags split', () => {
  assert.equal(CODING_V2_TOOLS.length, 10);
  assert.deepEqual(
    CODING_V2_TOOLS.map((t) => t.definition.name).sort(),
    [...CODING_V2_TOOL_NAMES].sort(),
  );
  assert.ok(CODING_V2_TOOL_NAMES.every((n) => n.startsWith('coding_v2_')));
  assert.equal(isCodingV2ToolName('coding_v2_git_commit'), true);
  assert.equal(isCodingV2ToolName('coding_v2_nope'), false);
  const reads = ['coding_v2_repo_map_build', 'coding_v2_repo_map_query', 'coding_v2_repo_map_symbol', 'coding_v2_architect_plan', 'coding_v2_architect_status', 'coding_v2_git_diff'];
  const writes = ['coding_v2_architect_execute', 'coding_v2_git_commit', 'coding_v2_git_revert', 'coding_v2_git_squash'];
  for (const name of reads) assert.equal(tool(CODING_V2_TOOLS, name).needsApproval, false, name);
  for (const name of writes) assert.equal(tool(CODING_V2_TOOLS, name).needsApproval, true, name);
  for (const t of CODING_V2_TOOLS) {
    assert.ok(t.definition.description.length > 20, t.definition.name);
    assert.equal(typeof t.execute, 'function');
  }
});

test('registry wiring: ALL_TOOLS holds the 10 tools (298), binding keeps 359', (t) => {
  const dir = tmpDir(t);
  assert.equal(ALL_TOOLS.length, 359); // v1.10 merge: 236 + 9 memory_v10 + 18 teams_v2 + 12 coding_v3 + 14 fleet_v7 = 289; v1.11 merge: 289 + 70 = 359
  for (const name of CODING_V2_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((x) => x.definition.name === name), name);
  }
  assert.equal(new Set(ALL_TOOLS.map((x) => x.definition.name)).size, ALL_TOOLS.length);
  const bound = createDefaultTools({ getCodingV2WorkspaceDir: () => dir });
  assert.equal(bound.length, 359);
  assert.equal(new Set(bound.map((x) => x.definition.name)).size, 359);
});

test('placeholder: unbound tools refuse without a workspace', async () => {
  const result = await tool(CODING_V2_TOOLS, 'coding_v2_repo_map_build').execute(
    {},
    { botId: 'test-bot' },
  );
  assert.match(result, /^Error: workspaceDir is required/);
});

// --- Repo map tools -------------------------------------------------------------

test('repo map build: first build parses all, second reuses cache, edit re-parses one', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const tools = createCodingV2Tools({ workspaceDir: dir });
  const ctx = CTX(dir);

  const first = await call(tools, 'coding_v2_repo_map_build', {}, ctx);
  assert.match(first, /Files: 3, symbols: 5, edges: \d+/);
  assert.match(first, /re-parsed 3, reused from cache 0/);
  const cachePath = path.join(dir, '.open-bot', 'coding-v2', 'repo-map-v2.json');
  assert.equal(fs.existsSync(cachePath), true, 'disk cache must exist after build');
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cache.version, 2);
  assert.equal(Object.keys(cache.files).length, 3);

  const second = await call(tools, 'coding_v2_repo_map_build', {}, ctx);
  assert.match(second, /re-parsed 0, reused from cache 3/);
  assert.match(second, /already fresh/);

  // Touch one file (content + mtime bump) -> only it is re-parsed.
  write(dir, 'src/c.ts', 'export function delta() {\n  return 3;\n}\n\nexport function epsilon() {\n  return 4;\n}\n');
  fs.utimesSync(path.join(dir, 'src/c.ts'), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
  const third = await call(tools, 'coding_v2_repo_map_build', {}, ctx);
  assert.match(third, /re-parsed 1, reused from cache 2/);

  // Delete a file -> reported as removed.
  fs.rmSync(path.join(dir, 'src/c.ts'));
  const fourth = await call(tools, 'coding_v2_repo_map_build', {}, ctx);
  assert.match(fourth, /removed 1/);
  assert.match(fourth, /Files: 2/);
});

test('repo map build: force rebuild ignores the cache', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const tools = createCodingV2Tools({ workspaceDir: dir });
  const ctx = CTX(dir);
  await call(tools, 'coding_v2_repo_map_build', {}, ctx);
  const forced = await call(tools, 'coding_v2_repo_map_build', { force: true }, ctx);
  assert.match(forced, /re-parsed 3, reused from cache 0/);
});

test('repo map query: alpha seeds a.ts, gamma seeds b.ts, unknown falls back', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const tools = createCodingV2Tools({ workspaceDir: dir });
  const ctx = CTX(dir);
  await call(tools, 'coding_v2_repo_map_build', {}, ctx);

  const alpha = await call(tools, 'coding_v2_repo_map_query', { query: 'alpha' }, ctx);
  assert.ok(alpha.indexOf('#1 src/a.ts') !== -1, alpha);
  assert.ok(alpha.includes('(score'), alpha);
  assert.ok(alpha.includes('seed'), alpha);

  const gamma = await call(tools, 'coding_v2_repo_map_query', { query: 'gamma' }, ctx);
  assert.ok(gamma.indexOf('#1 src/b.ts') !== -1, gamma);

  const unknown = await call(tools, 'coding_v2_repo_map_query', { query: 'zzzzqqq' }, ctx);
  assert.match(unknown, /No seed match — showing the global PageRank ranking/);
  assert.ok(unknown.indexOf('#1 src/a.ts') !== -1, unknown);
});

test('repo map query: builds the map automatically when never built', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const tools = createCodingV2Tools({ workspaceDir: dir });
  const out = await call(tools, 'coding_v2_repo_map_query', { query: 'alpha' }, CTX(dir));
  assert.ok(out.indexOf('#1 src/a.ts') !== -1, out);
});

test('repo map symbol: alpha defined in a.ts, referenced by b.ts', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const tools = createCodingV2Tools({ workspaceDir: dir });
  const ctx = CTX(dir);
  await call(tools, 'coding_v2_repo_map_build', {}, ctx);
  const out = await call(tools, 'coding_v2_repo_map_symbol', { name: 'alpha' }, ctx);
  assert.match(out, /function alpha — src\/a\.ts:1/);
  assert.match(out, /Referenced by: src\/b\.ts/);
  const missing = await call(tools, 'coding_v2_repo_map_symbol', { name: 'nope' }, ctx);
  assert.match(missing, /not found in the repo map v2/);
});

test('repo map store: custom cachePath is actually used for load/save', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const store = new CodingV2RepoMapStore(dir);
  const customRel = 'my-cache/repo-map.json';
  const first = await store.build({ cachePath: customRel });
  assert.equal(first.cachePath, path.join(dir, customRel));
  assert.equal(fs.existsSync(path.join(dir, customRel)), true, 'custom cache file must exist');
  assert.equal(
    fs.existsSync(path.join(dir, '.open-bot', 'coding-v2', 'repo-map-v2.json')),
    false,
    'default cache file must NOT be written when a custom path is given',
  );
  const second = await store.build({ cachePath: customRel });
  assert.equal(second.reparsed, 0, 'second build with the same custom cache must reuse all files');
  assert.equal(second.reused, 3);
});

test('repo map store: stats before/after build; rank helpers', async (t) => {
  const dir = tmpDir(t);
  fixtureRepo(dir);
  const store = new CodingV2RepoMapStore(dir);
  assert.equal(store.stats().built, false);
  assert.equal(store.isBuilt, false);
  const result = await store.build();
  assert.equal(result.files, 3);
  assert.equal(result.symbols, 5);
  assert.ok(result.edges > 0);
  assert.equal(store.stats().built, true);
  assert.equal(store.rankFiles(1)[0].relPath, 'src/a.ts');
  assert.ok(store.rankSymbols(1)[0].symbol === 'alpha' || store.rankSymbols(1)[0].score > 0);
});

// --- Architect tools ------------------------------------------------------------

test('architect tools: plan -> execute -> status, deviation blocks', async (t) => {
  const dir = tmpDir(t);
  const tools = createCodingV2Tools({ workspaceDir: dir });
  const ctx = CTX(dir);

  const planOut = await call(
    tools,
    'coding_v2_architect_plan',
    {
      task: 'Add a greeting',
      steps: [
        { kind: 'implement', description: 'Create greet.ts', files: ['src/greet.ts'] },
        { kind: 'finish', description: 'Done', files: [] },
      ],
    },
    ctx,
  );
  const planId = /Architect plan created: (\S+)/.exec(planOut)?.[1];
  assert.ok(planId, planOut);
  const stepId = /\[([0-9a-f-]{36})\] implement/.exec(planOut)?.[1];
  assert.ok(stepId, planOut);

  const execOut = await call(
    tools,
    'coding_v2_architect_execute',
    {
      planId,
      stepId,
      edits: [{ path: 'src/greet.ts', kind: 'create', content: 'export const greet = "hi";\n' }],
    },
    ctx,
  );
  assert.match(execOut, /xong, planner duyệt diff OK/);
  assert.match(execOut, /Review verdict: approved/);
  assert.equal(fs.readFileSync(path.join(dir, 'src/greet.ts'), 'utf8'), 'export const greet = "hi";\n');

  const status = await call(tools, 'coding_v2_architect_status', { planId }, ctx);
  assert.match(status, /1\/2 steps done/);
  assert.match(status, /Review .* approved/);

  // Second step (finish) declares no files — editing one deviates.
  const finishId = /\[([0-9a-f-]{36})\] finish/.exec(planOut)?.[1];
  const bad = await call(
    tools,
    'coding_v2_architect_execute',
    {
      planId,
      stepId: finishId,
      edits: [{ path: 'src/greet.ts', kind: 'edit', oldText: '"hi"', newText: '"hello"' }],
    },
    ctx,
  );
  assert.match(bad, /LỆCH KẾ HOẠCH/);
  assert.match(bad, /Plan status: blocked/);

  const statusAfter = await call(tools, 'coding_v2_architect_status', { planId }, ctx);
  assert.match(statusAfter, /blocked/);
});

test('architect tools: bad plan input returns Error, unknown plan returns Error', async (t) => {
  const dir = tmpDir(t);
  const tools = createCodingV2Tools({ workspaceDir: dir });
  const ctx = CTX(dir);
  const badPlan = await call(
    tools,
    'coding_v2_architect_plan',
    { task: 'x', steps: [{ kind: 'implement', description: 'no files', files: [] }] },
    ctx,
  );
  assert.match(badPlan, /^Error: .*ít nhất 1 file/);
  const badExec = await call(
    tools,
    'coding_v2_architect_execute',
    { planId: 'nope', stepId: 'nope', edits: [{ path: 'a.txt', kind: 'create', content: 'x' }] },
    ctx,
  );
  assert.match(badExec, /^Error: Không tìm thấy plan/);
  const empty = await call(tools, 'coding_v2_architect_status', {}, ctx);
  assert.match(empty, /No architect plans/);
});

// --- Git tools --------------------------------------------------------------------

test('git tools: commit -> diff -> revert -> squash end to end', async (t) => {
  const dir = initGitRepo(t);
  const tools = createCodingV2Tools({ workspaceDir: dir });
  const ctx = CTX(dir);

  write(dir, 'a.txt', 'v1\n');
  const committed = await call(
    tools,
    'coding_v2_git_commit',
    { files: ['a.txt'], message: 'add a', planId: 'p1', stepId: 's1' },
    ctx,
  );
  assert.match(committed, /Committed [0-9a-f]{7} \([0-9a-f]{40}\): \[coding-v2\] plan p1 step s1: add a/);
  const sha1 = /Committed [0-9a-f]{7} \(([0-9a-f]{40})\)/.exec(committed)[1];

  write(dir, 'a.txt', 'v1\nv2\n');
  const diff = await call(tools, 'coding_v2_git_diff', {}, ctx);
  assert.match(diff, /Diff \(worktree\)/);
  assert.ok(diff.includes('+v2'));

  const commitDiff = await call(tools, 'coding_v2_git_diff', { commit: sha1 }, ctx);
  assert.ok(commitDiff.includes('+v1'), 'commit diff must show the added line');

  const c2 = await call(tools, 'coding_v2_git_commit', { files: ['a.txt'], message: 'v2' }, ctx);
  const sha2 = /Committed [0-9a-f]{7} \(([0-9a-f]{40})\)/.exec(c2)[1];
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v1\nv2\n');
  const reverted = await call(tools, 'coding_v2_git_revert', { sha: sha2 }, ctx);
  assert.match(reverted, new RegExp(`Reverted ${sha2.slice(0, 7)} with new commit`));
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v1\n');

  // Two more commits, then squash them (base = revert commit).
  write(dir, 'a.txt', 'v1\nx\n');
  await call(tools, 'coding_v2_git_commit', { files: ['a.txt'], message: 'x' }, ctx);
  write(dir, 'b.txt', 'b\n');
  await call(tools, 'coding_v2_git_commit', { files: ['b.txt'], message: 'y' }, ctx);
  const headSha = git(dir, 'rev-parse', 'HEAD~2').trim();
  const squashed = await call(
    tools,
    'coding_v2_git_squash',
    { base: headSha, message: 'feature' },
    ctx,
  );
  assert.match(squashed, /Squashed 2 commit\(s\) into [0-9a-f]{7}/);
  assert.match(squashed, /\[coding-v2\] squash: feature/);
});

test('git tools: non-repo fails clearly; repoDir escaping the workspace refused', async (t) => {
  const dir = tmpDir(t);
  const tools = createCodingV2Tools({ workspaceDir: dir });
  const ctx = CTX(dir);
  const out = await call(tools, 'coding_v2_git_commit', { files: ['a.txt'], message: 'x' }, ctx);
  assert.match(out, /^Error: .*không phải git repo/);
  const escaped = await call(
    tools,
    'coding_v2_git_diff',
    { repoDir: '..' },
    ctx,
  );
  assert.match(escaped, /^Error: .*escapes the workspace root/);
  const badSha = await call(tools, 'coding_v2_git_revert', { sha: 'xyz' }, ctx);
  assert.match(badSha, /^Error: /);
});
