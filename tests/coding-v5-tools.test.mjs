/**
 * Tests for coding agent v5 — tools (v1.13, Doi T4):
 * `packages/tools/src/codingV5Tools.ts` (the 11 coding-v5 tools end
 * to end: patch preview/apply + commit, /add + /drop + /ls-files,
 * suggest via repo map, SWE sample suite, rollback, patch history).
 *
 * Real temp git repos + real repo-map build — no network, no live
 * services. Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/coding-v5-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// Runner git v5 chay `git commit`/`git revert` ke thua process.env —
// can identity (giong user da cau hinh git tren may).
process.env.GIT_AUTHOR_NAME ??= 'test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';

import {
  CODING_V5_TOOLS,
  CODING_V5_TOOL_NAMES,
  createCodingV5Tools,
  isCodingV5ToolName,
} from '../packages/tools/dist/codingV5Tools.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (tools, name) => tools.find((t) => t.definition.name === name);
const call = (tools, name, args, ctx) => tool(tools, name).execute(args, ctx);

function tmpDir(t, prefix = 'coding-v5-tools-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function gitRepo(t, files) {
  const dir = tmpDir(t);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args) => execFileSync('git', args, { cwd: dir, env }).toString();
  git(['init', '--quiet']);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'chore(repo): base']);
  return { dir, git };
}

// --- Tool surface ---------------------------------------------------------------

test('tool surface: 11 coding-v5 tools, names match, approval flags', () => {
  assert.equal(CODING_V5_TOOLS.length, 11);
  assert.deepEqual(
    CODING_V5_TOOLS.map((t) => t.definition.name).sort(),
    [...CODING_V5_TOOL_NAMES].sort(),
  );
  assert.ok(CODING_V5_TOOL_NAMES.every((n) => n.startsWith('coding_v5_')));
  assert.equal(isCodingV5ToolName('coding_v5_patch_preview'), true);
  assert.equal(isCodingV5ToolName('coding_v4_patch_preview'), false);
  const needsApproval = Object.fromEntries(
    CODING_V5_TOOLS.map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.equal(needsApproval.coding_v5_patch_apply, true);
  assert.equal(needsApproval.coding_v5_rollback, true);
  assert.equal(needsApproval.coding_v5_eval_run, true);
  assert.equal(needsApproval.coding_v5_patch_preview, false);
  assert.equal(needsApproval.coding_v5_ls_files, false);
  assert.equal(needsApproval.coding_v5_eval_suite, false);
});

// --- Patch preview / apply / commit message --------------------------------------

test('patch preview on a clean tree, then with changes; apply approved hunk + commit', async (t) => {
  const { dir, git } = gitRepo(t, {
    'src/a.ts':
      'export function alpha() {\n  return 1;\n}\n\nexport function fillerOne() {\n  return 1;\n}\n\nexport function fillerTwo() {\n  return 1;\n}\n\nexport function beta() {\n  return 1;\n}\n',
  });
  const tools = createCodingV5Tools();
  const clean = await call(tools, 'coding_v5_patch_preview', {}, CTX(dir));
  assert.match(clean, /Worktree sach/);

  write(
    dir,
    'src/a.ts',
    'export function alpha() {\n  return 2;\n}\n\nexport function fillerOne() {\n  return 1;\n}\n\nexport function fillerTwo() {\n  return 1;\n}\n\nexport function beta() {\n  return 9;\n}\n',
  );
  const preview = await call(tools, 'coding_v5_patch_preview', {}, CTX(dir));
  assert.match(preview, /1 file\(s\), 2 hunk\(s\)/);
  assert.match(preview, /Hunk ids.*0:0, 0:1/);

  const msg = await call(tools, 'coding_v5_commit_message', {}, CTX(dir));
  assert.match(msg, /Suggested commit message/);
  assert.match(msg, /chore\(src\): update 1 file \(\+2\/-2\)/);

  // Apply only hunk 0:0, with a commit + history record.
  // (Diff mo ta thay doi so voi base — phai revert worktree ve base
  // truoc khi apply, giong flow agent that.)
  const diff = git(['diff']);
  git(['checkout', '--', 'src/a.ts']);
  const applied = await call(
    tools,
    'coding_v5_patch_apply',
    {
      patch: diff,
      approvedHunkIds: ['0:0'],
      commitMessage: 'fix(src): bump alpha return value',
    },
    CTX(dir),
  );
  assert.match(applied, /Applied 1 approved hunk/);
  assert.match(applied, /Committed as/);
  assert.match(applied, /recorded in patch history/);
  const content = fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8');
  assert.match(content, /return 2;/);
  assert.match(content, /return 1;\n}/); // beta untouched (hunk rejected)
  const history = await call(tools, 'coding_v5_patch_history', {}, CTX(dir));
  assert.match(history, /fix\(src\): bump alpha return value/);
  assert.match(history, /active/);

  // Roll the commit back via the tool.
  const sha = git(['rev-parse', 'HEAD']).trim();
  const rolled = await call(tools, 'coding_v5_rollback', { commitSha: sha }, CTX(dir));
  assert.match(rolled, /Rolled back/);
  // Revert undoes the committed change: alpha is back to 1.
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8'), /return 2;/);
  const historyAfter = await call(tools, 'coding_v5_patch_history', { filter: 'rolled-back' }, CTX(dir));
  assert.match(historyAfter, /ROLLED BACK/);
});

test('patch apply without approvals errors; bad commit message skips commit', async (t) => {
  const { dir, git } = gitRepo(t, { 'a.ts': 'const x = 1;\n' });
  const tools = createCodingV5Tools();
  write(dir, 'a.ts', 'const x = 2;\n');
  const diff = git(['diff']);
  git(['checkout', '--', 'a.ts']); // ve base truoc khi apply (flow agent that)
  const noApproval = await call(tools, 'coding_v5_patch_apply', { patch: diff }, CTX(dir));
  assert.match(noApproval, /Error: Chua duyet hunk nao/);
  const badMsg = await call(
    tools,
    'coding_v5_patch_apply',
    { patch: diff, approveAll: true, commitMessage: 'no conventional format here' },
    CTX(dir),
  );
  assert.match(badMsg, /Applied 1 approved hunk/);
  assert.match(badMsg, /Commit SKIPPED/);
  assert.match(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8'), /const x = 2;/);
});

// --- File set ----------------------------------------------------------------------

test('add/drop/ls-files via tools, budget warning on tiny budget', async (t) => {
  const dir = tmpDir(t);
  write(dir, 'src/auth.ts', 'export function login() {\n  return true;\n}\n');
  write(dir, 'src/user.ts', 'export function me() {\n  return "me";\n}\n');
  const tools = createCodingV5Tools({ tokenBudget: 5 });
  const added = await call(tools, 'coding_v5_add', { command: '/add src/auth.ts src/user.ts' }, CTX(dir));
  assert.match(added, /Added 2 file\(s\)/);
  assert.match(added, /CANH BAO: tap file vuot ngan sach/);
  const listed = await call(tools, 'coding_v5_ls_files', {}, CTX(dir));
  assert.match(listed, /src\/auth\.ts/);
  assert.match(listed, /src\/user\.ts/);
  const dropped = await call(tools, 'coding_v5_drop', { paths: ['src/auth.ts'] }, CTX(dir));
  assert.match(dropped, /Dropped 1 file/);
  const missing = await call(tools, 'coding_v5_drop', { paths: ['src/nope.ts'] }, CTX(dir));
  assert.match(missing, /Khong co trong tap: src\/nope\.ts/);
  const badAdd = await call(tools, 'coding_v5_add', { paths: ['../escape.ts'] }, CTX(dir));
  assert.match(badAdd, /Skipped \.\.\/escape\.ts: .*thoat khoi repo/);
});

// --- Suggest -------------------------------------------------------------------------

test('suggest files via repo map ranks the matching file first', async (t) => {
  const dir = tmpDir(t);
  write(
    dir,
    'src/auth.ts',
    'export function login() {\n  return true;\n}\n\nexport function logout() {\n  return false;\n}\n',
  );
  write(
    dir,
    'src/user.ts',
    "import { login } from './auth';\n\nexport function currentUser() {\n  return login() ? 'me' : null;\n}\n",
  );
  write(dir, 'src/other.ts', 'export function unrelated() {\n  return 42;\n}\n');
  const tools = createCodingV5Tools();
  const suggested = await call(tools, 'coding_v5_suggest_files', { query: 'login auth', limit: 3 }, CTX(dir));
  assert.match(suggested, /Goi y/);
  assert.match(suggested, /src\/auth\.ts/);
  // auth.ts must come before other.ts in the suggestion list.
  assert.ok(suggested.indexOf('src/auth.ts') < suggested.indexOf('src/other.ts'));

  const added = await call(
    tools,
    'coding_v5_suggest_files',
    { query: 'login', limit: 1, addToSet: true },
    CTX(dir),
  );
  assert.match(added, /Added 1 suggested file/);
  assert.match(added, /src\/auth\.ts/);
});

// --- SWE eval --------------------------------------------------------------------------

test('eval suite tool runs the 3 sample tasks: 1/3 pass, report saved', async (t) => {
  const dir = tmpDir(t);
  const tools = createCodingV5Tools();
  const out = await call(tools, 'coding_v5_eval_suite', {}, CTX(dir));
  assert.match(out, /1\/3 task\(s\) pass/);
  assert.match(out, /Pass rate: 33\.3%/);
  assert.match(out, /Report JSON: .*swe-suite-.*\.json/);
  const resultsDir = path.join(dir, '.open-bot', 'coding-v5', 'eval-results');
  assert.ok(fs.existsSync(resultsDir));
  assert.equal(fs.readdirSync(resultsDir).length, 1);
});

test('eval run tool: correct fix passes, bad task errors cleanly', async (t) => {
  const dir = tmpDir(t);
  const tools = createCodingV5Tools();
  const goodTask = {
    id: 'tool-eval-good',
    title: 'fix add',
    issue: 'add returns a - b',
    fixtures: {
      'calc.js': 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n',
      'calc.test.js':
        "const assert = require('node:assert/strict');\nconst { add } = require('./calc');\nassert.equal(add(2, 3), 5);\n",
    },
    patch:
      'diff --git a/calc.js b/calc.js\n--- a/calc.js\n+++ b/calc.js\n@@ -1,3 +1,3 @@ function add(a, b) {\n function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n',
    testCommands: [{ name: 'calc-tests', argv: ['node', 'calc.test.js'] }],
    failToPass: ['calc-tests'],
    passToPass: [],
  };
  const out = await call(tools, 'coding_v5_eval_run', { task: goodTask }, CTX(dir));
  assert.match(out, /\[PASS\] tool-eval-good/);
  assert.match(out, /Result JSON:/);

  const bad = await call(
    tools,
    'coding_v5_eval_run',
    { task: { id: 'tool-eval-bad', title: 'bad', issue: 'x', patch: '', testCommands: [], failToPass: [], passToPass: [] } },
    CTX(dir),
  );
  assert.match(bad, /Error:/);
});
