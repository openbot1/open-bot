/**
 * Tests cho coding agent v10 tools (v1.18, Đội T2): 7 tool
 * coding_v10_* (session / codeact / repomap / edit / eval / agent /
 * snapshot) + đăng ký trong ALL_TOOLS (đủ 7 tên, không trùng,
 * binding giữ nguyên số lượng).
 *
 * Chạy thật: git thật, `node` thật, file thật trong thư mục tạm;
 * tool eval chạy eval mẫu thật (scripted agent).
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/coding-v10-tools-v118.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_TOOLS,
  CODING_V10_TOOLS,
  CODING_V10_TOOL_NAMES,
  createCodingV10Tools,
  createDefaultTools,
  isCodingV10ToolName,
} from '../packages/tools/dist/index.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

test('v10 tools: ALL_TOOLS contains all 7 coding_v10_* tools, no duplicates', () => {
  for (const name of CODING_V10_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), name);
    assert.ok(isCodingV10ToolName(name));
  }
  assert.equal(isCodingV10ToolName('coding_v9_agent'), false);
  assert.equal(isCodingV10ToolName('nope'), false);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(CODING_V10_TOOLS.length, 7);
  const bound = createDefaultTools({ getCodingV10BaseDir: () => tmpDir('v10-tools-bind-') });
  assert.equal(bound.length, ALL_TOOLS.length);
  for (const name of CODING_V10_TOOL_NAMES) {
    assert.ok(bound.some((t) => t.definition.name === name), name);
  }
  const names2 = bound.map((t) => t.definition.name);
  assert.equal(new Set(names2).size, names2.length);
});

test('v10 tools: unbound session tool refuses without a base dir', async () => {
  const tools = createCodingV10Tools();
  const tool = getTool(tools, 'coding_v10_session');
  const out = await tool.execute({ action: 'list' }, CTX);
  assert.match(out, /not configured/);
});

test('v10 tools: session start/status/pause/resume/replay via bound tools', async () => {
  const base = tmpDir('v10-tools-session-');
  const tools = createCodingV10Tools(() => base);
  const sessionTool = getTool(tools, 'coding_v10_session');
  const workspaceDir = tmpDir('v10-tools-session-ws-');
  const ctx = { workspaceDir };
  const started = JSON.parse(await sessionTool.execute({ action: 'start', title: 'tool session' }, ctx));
  assert.ok(started.sessionId);
  const status = JSON.parse(await sessionTool.execute({ action: 'status', sessionId: started.sessionId }, ctx));
  assert.equal(status.status, 'running');
  const paused = JSON.parse(await sessionTool.execute({ action: 'pause', sessionId: started.sessionId, reason: 'test' }, ctx));
  assert.equal(paused.status, 'paused');
  const resumed = JSON.parse(await sessionTool.execute({ action: 'resume', sessionId: started.sessionId }, ctx));
  assert.equal(resumed.status, 'running');
  const replayed = JSON.parse(await sessionTool.execute({ action: 'replay', sessionId: started.sessionId }, ctx));
  assert.equal(replayed.verification.ok, true);
  const listed = JSON.parse(await sessionTool.execute({ action: 'list' }, ctx));
  assert.ok(listed.sessions.includes(started.sessionId));
});

test('v10 tools: codeact runs node + records into session', async () => {
  const base = tmpDir('v10-tools-codeact-');
  const tools = createCodingV10Tools(() => base);
  const workspaceDir = tmpDir('v10-tools-codeact-ws-');
  const ctx = { workspaceDir };
  const sessionTool = getTool(tools, 'coding_v10_session');
  const started = JSON.parse(await sessionTool.execute({ action: 'start', title: 'codeact session' }, ctx));
  const codeactTool = getTool(tools, 'coding_v10_codeact');
  const out = JSON.parse(
    await codeactTool.execute({ kind: 'node', code: 'console.log(6 * 7);', sessionId: started.sessionId }, ctx),
  );
  assert.equal(out.status, 'ok');
  assert.match(out.stdout, /42/);
  const denied = JSON.parse(await codeactTool.execute({ kind: 'bash', code: 'rm -rf /' }, ctx));
  assert.equal(denied.status, 'denied');
  const status = JSON.parse(await sessionTool.execute({ action: 'status', sessionId: started.sessionId }, ctx));
  assert.equal(status.codeActRuns, 1);
  assert.equal(status.codeActPassed, 1);
});

test('v10 tools: repomap build/render/symbol + edit dry-run + apply', async () => {
  const base = tmpDir('v10-tools-repomap-');
  const tools = createCodingV10Tools(() => base);
  const workspaceDir = tmpDir('v10-tools-repomap-ws-');
  writeFile(workspaceDir, 'src/util.ts', `export function greet(name: string): string {\n  return 'hello';\n}\n`);
  const ctx = { workspaceDir };
  const repomapTool = getTool(tools, 'coding_v10_repomap');
  const built = JSON.parse(await repomapTool.execute({ action: 'build' }, ctx));
  assert.equal(built.fileCount, 1);
  const rendered = JSON.parse(await repomapTool.execute({ action: 'render', budget: 4000 }, ctx));
  assert.equal(rendered.filesKept, 1);
  const found = JSON.parse(await repomapTool.execute({ action: 'symbol', query: 'greet' }, ctx));
  assert.equal(found.hits[0].qualifiedName, 'greet');

  const editTool = getTool(tools, 'coding_v10_edit');
  const preview = JSON.parse(
    await editTool.execute(
      {
        path: 'src/util.ts',
        kind: 'replace-symbol',
        symbolName: 'greet',
        newText: `export function greet(name: string): string {\n  return 'hello ' + name;\n}`,
        dryRun: true,
      },
      ctx,
    ),
  );
  assert.equal(preview.dryRun, true);
  assert.ok(preview.candidates.some((c) => c.strategy === 'ast' && c.applicable));
  const applied = JSON.parse(
    await editTool.execute(
      {
        path: 'src/util.ts',
        kind: 'replace-symbol',
        symbolName: 'greet',
        newText: `export function greet(name: string): string {\n  return 'hello ' + name;\n}`,
      },
      ctx,
    ),
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.strategy, 'ast');
  assert.match(fs.readFileSync(path.join(workspaceDir, 'src/util.ts'), 'utf8'), /hello ' \+ name/);
});

test('v10 tools: eval run stores versioned report + table lists it', async () => {
  const base = tmpDir('v10-tools-eval-');
  const tools = createCodingV10Tools(() => base);
  const evalTool = getTool(tools, 'coding_v10_eval');
  const run = JSON.parse(await evalTool.execute({ action: 'run', agentVersion: 'v10', attemptsPerTask: 1 }, CTX));
  assert.equal(run.summary.passAtK, 5 / 6);
  assert.equal(run.summary.tasksPassed, 5);
  const table = JSON.parse(await evalTool.execute({ action: 'table' }, CTX));
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].agentVersion, 'v10');
  assert.equal(table.rows[0].best, true);
}, { timeout: 120000 });

test('v10 tools: agent runs a plan end-to-end with snapshot', async () => {
  const base = tmpDir('v10-tools-agent-');
  const tools = createCodingV10Tools(() => base);
  const workspaceDir = tmpDir('v10-tools-agent-ws-');
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email "v10-test@open-bot.local"', { cwd: workspaceDir });
  execSync('git config user.name "v10-test"', { cwd: workspaceDir });
  writeFile(workspaceDir, 'util.mjs', `export function greet(name) {\n  return 'hello';\n}\n`);
  writeFile(workspaceDir, 'test.mjs', `import { greet } from './util.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(greet('An'), 'hello An');\n`);
  execSync('git add -A && git commit -qm "init"', { cwd: workspaceDir });
  const ctx = { workspaceDir };
  const agentTool = getTool(tools, 'coding_v10_agent');
  const plan = [
    {
      operation: {
        kind: 'replace-symbol',
        path: 'util.mjs',
        symbolName: 'greet',
        newText: `export function greet(name) {\n  return 'hello ' + name;\n}`,
      },
    },
  ];
  const out = JSON.parse(
    await agentTool.execute(
      {
        title: 'fix greet',
        task: 'greet should include the name',
        planJson: JSON.stringify(plan),
        verifyCommandsJson: JSON.stringify([['node', 'test.mjs']]),
      },
      ctx,
    ),
  );
  assert.equal(out.ok, true);
  assert.ok(out.sessionId);
  assert.ok(out.snapshot);
  const snapshotTool = getTool(tools, 'coding_v10_snapshot');
  const snap = JSON.parse(await snapshotTool.execute({ action: 'read', sessionId: out.sessionId }, ctx));
  assert.equal(snap.sessionId, out.sessionId);
  assert.ok(snap.stateDigest);
}, { timeout: 120000 });
