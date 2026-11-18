/**
 * Tests cho coding agent v9 tools (v1.17, Đội T4): 6 tool
 * coding_v9_* (ast-edit / loop / commit / pr / eval / agent) +
 * đăng ký trong ALL_TOOLS (đủ 6 tên, không trùng, binding giữ
 * nguyên số lượng).
 *
 * Chạy thật: git thật, `node` thật, file thật trong thư mục tạm;
 * tool eval chạy eval mẫu thật (scripted agent).
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/coding-v9-tools-v117.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_TOOLS,
  CODING_V9_TOOLS,
  CODING_V9_TOOL_NAMES,
  createCodingV9Tools,
  createDefaultTools,
  isCodingV9ToolName,
} from '../packages/tools/dist/index.js';
import { commitV9Atomic, runV9Git, v9EnsureGitRepo } from '../packages/core/dist/codingV9/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-coding-v9-tools-v117-'));
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function getTool(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} missing`);
  return tool;
}

const CTX = { workspaceDir: '' };

test('v9 tools: ALL_TOOLS contains all 6 coding_v9_* tools, no duplicates', () => {
  for (const name of CODING_V9_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), name);
    assert.ok(isCodingV9ToolName(name));
  }
  assert.equal(isCodingV9ToolName('coding_v7_step'), false);
  assert.equal(isCodingV9ToolName('nope'), false);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(CODING_V9_TOOLS.length, 6);
  const bound = createDefaultTools({ getCodingV9BaseDir: () => tmpDir() });
  assert.equal(bound.length, ALL_TOOLS.length);
  for (const name of CODING_V9_TOOL_NAMES) {
    assert.ok(bound.some((t) => t.definition.name === name), name);
  }
});

test('v9 tools: ast-edit applies an AST edit and dry-run previews without writing', async () => {
  const dir = tmpDir();
  const base = tmpDir();
  writeFile(dir, 'util.mjs', "export function greet(name) {\n  return 'hello';\n}\n");
  const tools = createCodingV9Tools(() => base);
  const edit = getTool(tools, 'coding_v9_ast_edit');
  const ctx = { ...CTX, workspaceDir: dir };

  const preview = JSON.parse(await edit.execute({
    path: 'util.mjs', kind: 'replace-symbol', symbolName: 'greet',
    newText: "export function greet(name) {\n  return 'hello ' + name;\n}",
    dryRun: true,
  }, ctx));
  assert.equal(preview.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'util.mjs'), 'utf8'), /return 'hello';/);

  const applied = JSON.parse(await edit.execute({
    path: 'util.mjs', kind: 'replace-symbol', symbolName: 'greet',
    newText: "export function greet(name) {\n  return 'hello ' + name;\n}",
  }, ctx));
  assert.equal(applied.ok, true);
  assert.equal(applied.usedFallback, false);
  assert.match(fs.readFileSync(path.join(dir, 'util.mjs'), 'utf8'), /'hello ' \+ name/);

  const missing = await edit.execute({ path: 'nope.mjs', kind: 'replace-symbol', symbolName: 'x', newText: 'y' }, ctx);
  assert.match(missing, /^Error: /);
});

test('v9 tools: loop verifies green, commit is atomic, pr describes the range', async () => {
  const dir = tmpDir();
  const base = tmpDir();
  await v9EnsureGitRepo({ workingDir: dir });
  writeFile(dir, 'util.mjs', "export function add(a, b) {\n  return a - b;\n}\n");
  writeFile(dir, 'test.mjs', "import { add } from './util.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(add(2, 3), 5);\n");
  await commitV9Atomic({ workingDir: dir, files: ['util.mjs', 'test.mjs'], summary: 'base' });
  const baseSha = (await runV9Git(['rev-parse', 'HEAD'], { workingDir: dir })).stdout.trim();
  const tools = createCodingV9Tools(() => base);
  const ctx = { ...CTX, workspaceDir: dir };

  const edit = getTool(tools, 'coding_v9_ast_edit');
  await edit.execute({
    path: 'util.mjs', kind: 'replace-symbol', symbolName: 'add',
    newText: 'export function add(a, b) {\n  return a + b;\n}',
  }, ctx);

  const loop = getTool(tools, 'coding_v9_loop');
  const loopRes = JSON.parse(await loop.execute({
    verifyCommandsJson: JSON.stringify([['node', 'test.mjs']]),
    maxRounds: 2,
  }, ctx));
  assert.equal(loopRes.passed, true);
  assert.equal(loopRes.roundsUsed, 1);

  const commit = getTool(tools, 'coding_v9_commit');
  const commitRes = JSON.parse(await commit.execute({
    filesJson: JSON.stringify(['util.mjs']),
    summary: 'fix add',
    task: 'fix add to return a + b',
  }, ctx));
  assert.match(commitRes.sha, /^[0-9a-f]{40}$/);
  assert.equal(commitRes.totalAdded, 1);
  assert.equal(commitRes.totalRemoved, 1);

  const pr = getTool(tools, 'coding_v9_pr');
  const prRes = JSON.parse(await pr.execute({
    baseRef: baseSha, headBranch: 'v117-coding', baseBranch: 'main',
    summary: 'Fix add()', testSummary: 'Sandbox loop: passed after 1 round(s).',
  }, ctx));
  assert.equal(prRes.title, 'Fix add()');
  assert.equal(prRes.commitCount, 1);
  assert.match(prRes.body, /fix add/);
}, { timeout: 60_000 });

test('v9 tools: eval runs the sample suite (pass@k 2/3); agent runs a plan end-to-end', async () => {
  const base = tmpDir();
  const tools = createCodingV9Tools(() => base);
  const evalTool = getTool(tools, 'coding_v9_eval');
  const report = JSON.parse(await evalTool.execute({ attemptsPerTask: 1 }, { ...CTX }));
  assert.equal(report.taskCount, 3);
  assert.equal(report.tasksPassed, 2);
  assert.ok(Math.abs(report.passAtK - 2 / 3) < 1e-9);

  const dir = tmpDir();
  await v9EnsureGitRepo({ workingDir: dir });
  writeFile(dir, 'util.mjs', "export function greet(name) {\n  return 'hello';\n}\n");
  writeFile(dir, 'test.mjs', "import { greet } from './util.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(greet('An'), 'hello An');\n");
  await commitV9Atomic({ workingDir: dir, files: ['util.mjs', 'test.mjs'], summary: 'base' });
  const agent = getTool(tools, 'coding_v9_agent');
  const agentRes = JSON.parse(await agent.execute({
    title: 'Fix greet',
    task: "greet('An') should return 'hello An'.",
    planJson: JSON.stringify([
      { kind: 'replace-symbol', path: 'util.mjs', symbolName: 'greet', newText: "export function greet(name) {\n  return 'hello ' + name;\n}" },
    ]),
    verifyCommandsJson: JSON.stringify([['node', 'test.mjs']]),
    maxRounds: 2,
    autoCommit: true,
  }, { ...CTX, workspaceDir: dir }));
  assert.equal(agentRes.ok, true);
  assert.ok(agentRes.commit?.sha);
  assert.equal(agentRes.loop?.passed, true);
}, { timeout: 180_000 });

test('v9 tools: eval without a bound base dir returns NOT_WIRED', async () => {
  const tools = createCodingV9Tools();
  const evalTool = getTool(tools, 'coding_v9_eval');
  const res = await evalTool.execute({}, { ...CTX });
  assert.match(res, /not configured/);
});
