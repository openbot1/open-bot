/**
 * Tests cho coding agent v9 (v1.17, Đội T4): AST-aware edit (thay
 * function/class/import theo vị trí AST, fallback search-replace),
 * sandbox execution loop (edit → test → fix, tối đa N vòng), git-first
 * atomic commit + message tự sinh + draft-PR description, eval
 * harness kiểu SWE-bench (task mẫu, pass@k, lưu/so sánh báo cáo),
 * và agent v9 pipeline nối 4 lớp.
 *
 * Chạy thật (không mock git/node): git thật, `node` thật, file thật
 * trong thư mục tạm; eval mẫu chạy harness v5 thật trên repo tạm.
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v9-v117.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CodingAgentV9,
  applyV9AstEdit,
  applyV9AstEdits,
  applyV9EditAndCommit,
  commitV9Atomic,
  compareV9EvalReports,
  generateV9CommitMessage,
  generateV9DraftPrDescription,
  listV9EvalReports,
  loadV9EvalReport,
  previewV9AstEdit,
  renderV9EvalComparison,
  renderV9EvalReport,
  runV9Command,
  runV9EvalSuite,
  runV9EvalTask,
  runV9SandboxLoop,
  saveV9EvalReport,
  scriptedV9Agent,
  v9CheckAllowList,
  v9CheckDenyList,
  v9CheckMinimalDiff,
  v9CommitLogSince,
  v9CountLineChanges,
  v9DiffLineOps,
  v9EnsureGitRepo,
  v9EstimateTokens,
  v9FindBlock,
  v9FindScopeEndLine,
  v9FindSymbol,
  v9GitStatus,
  v9GroupHunks,
  v9LocateSymbol,
  v9RenameInContent,
  v9ResolveSymbolRange,
  v9RollbackFiles,
  v9UnifiedDiff,
  V9_EVAL_SAMPLE_TASKS,
  V9_SAMPLE_PATCH_ADD,
} from '../packages/core/dist/codingV9/index.js';
import { v8ParseFile } from '../packages/core/dist/codingV8/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-coding-v9-v117-'));
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

const SAMPLE_TS = `import { readFile } from './util';
import * as fs from 'node:fs';

/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a - b;
}

export function greet(name: string): string {
  return 'hello';
}

export class Calc {
  /** Sums a range. */
  sum(n: number): number {
    return this.addOne(n) + add(n, 1);
  }

  addOne(x: number): number {
    return x + 1;
  }
}

export interface Options {
  verbose: boolean;
}
`;

// ---------------------------------------------------------------------------
// diffUtil
// ---------------------------------------------------------------------------

test('v9 diff: unified diff counts lines, groups hunks, renders @@ header', () => {
  const oldC = 'a\nb\nc\nd\ne\nf\ng\nh\n';
  const newC = 'a\nB\nc\nd\ne\nf\nG\nh\n';
  const diff = v9UnifiedDiff(oldC, newC, 'x.ts');
  assert.equal(diff.linesAdded, 2);
  assert.equal(diff.linesRemoved, 2);
  assert.equal(diff.hunks.length, 1);
  assert.match(diff.text, /^--- a\/x\.ts\n\+\+\+ b\/x\.ts\n@@/);
  assert.match(diff.text, /-b\n\+B/);
  const same = v9UnifiedDiff(oldC, oldC, 'x.ts');
  assert.equal(same.text, '');
  assert.equal(same.hunks.length, 0);
  const counts = v9CountLineChanges(oldC, newC);
  assert.deepEqual(counts, { added: 2, removed: 2 });
});

test('v9 diff: hunks far apart stay separate; minimal-diff check flags overflow', () => {
  const ops = v9DiffLineOps(['a', 'X', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'Y'], ['a', 'x', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'y']);
  const hunks = v9GroupHunks(ops, 1);
  assert.equal(hunks.length, 2);
  assert.equal(v9CheckMinimalDiff(2, 2, 10), null);
  assert.match(v9CheckMinimalDiff(6, 5, 10) ?? '', /over the minimal-diff limit/);
});

test('v9 diff: empty vs content is a pure-add diff', () => {
  const diff = v9UnifiedDiff('', 'one\ntwo\n', 'new.ts');
  assert.equal(diff.linesAdded, 2);
  assert.equal(diff.linesRemoved, 0);
  assert.equal(diff.hunks.length, 1);
});

// ---------------------------------------------------------------------------
// astEdit: locate / replace / insert / rename / fallback
// ---------------------------------------------------------------------------

test('v9 ast: locate symbol resolves range; ambiguous short name throws', () => {
  const parsed = v8ParseFile('sample.ts', SAMPLE_TS);
  const located = v9LocateSymbol(parsed, SAMPLE_TS, 'add');
  assert.ok(located);
  assert.equal(located.symbol.name, 'add');
  assert.equal(located.startLine, 5);
  assert.ok(located.endLine >= 7);
  const method = v9LocateSymbol(parsed, SAMPLE_TS, 'sum', { qualifiedName: 'Calc.sum' });
  assert.ok(method);
  assert.equal(method.symbol.kind, 'method');
  // addOne exists once as a method; qualified lookup works:
  const one = v9FindSymbol(parsed, 'addOne', { qualifiedName: 'Calc.addOne' });
  assert.ok(one);
  assert.equal(one.line, 19);
});

test('v9 ast: brace-matching finds scope end when parser endLine is 0', () => {
  const masked = ['export function f() {', '  return 1;', '}'];
  assert.equal(v9FindScopeEndLine(masked, 1), 3);
  const parsed = v8ParseFile('s.ts', 'export function f() {\n  return 1;\n}\n');
  const sym = parsed.symbols.find((s) => s.name === 'f');
  assert.ok(sym);
  const range = v9ResolveSymbolRange(sym, masked, ['export function f() {', '  return 1;', '}']);
  assert.equal(range.endLine, 3);
});

test('v9 ast: replace-symbol swaps only the target function body', () => {
  const dir = tmpDir();
  writeFile(dir, 'sample.ts', SAMPLE_TS);
  const res = applyV9AstEdit(
    {
      kind: 'replace-symbol',
      path: 'sample.ts',
      symbolName: 'add',
      newText: 'export function add(a: number, b: number): number {\n  return a + b;\n}',
    },
    { workingDir: dir },
  );
  assert.equal(res.ok, true);
  assert.equal(res.usedFallback, false);
  assert.equal(res.appliedKind, 'replace-symbol');
  assert.equal(res.linesRemoved, 1); // only the `return a - b;` line changed
  assert.equal(res.linesAdded, 1);
  const after = fs.readFileSync(path.join(dir, 'sample.ts'), 'utf8');
  assert.match(after, /return a \+ b;/);
  assert.match(after, /return 'hello';/); // greet untouched
  assert.match(after, /addOne\(n\)/); // class untouched
  assert.match(res.diff, /-  return a - b;/);
});

test('v9 ast: replace method by qualifiedName leaves the other class alone', () => {
  const dir = tmpDir();
  const src = `export class A {\n  value() {\n    return 1;\n  }\n}\n\nexport class B {\n  value() {\n    return 2;\n  }\n}\n`;
  writeFile(dir, 'two.ts', src);
  const res = applyV9AstEdit(
    { kind: 'replace-symbol', path: 'two.ts', symbolName: 'value', qualifiedName: 'B.value', newText: '  value() {\n    return 20;\n  }' },
    { workingDir: dir },
  );
  assert.equal(res.ok, true);
  const after = fs.readFileSync(path.join(dir, 'two.ts'), 'utf8');
  assert.match(after, /return 1;/);
  assert.match(after, /return 20;/);
  assert.doesNotMatch(after, /return 2;/);
  // Ambiguous short name without qualifier must throw, not guess.
  assert.throws(
    () => applyV9AstEdit({ kind: 'replace-symbol', path: 'two.ts', symbolName: 'value', newText: 'x' }, { workingDir: dir }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'ambiguous-symbol');
      return true;
    },
  );
});

test('v9 ast: replace-import swaps specifier; insert-after adds a symbol', () => {
  const dir = tmpDir();
  writeFile(dir, 'sample.ts', SAMPLE_TS);
  const imp = applyV9AstEdit(
    { kind: 'replace-import', path: 'sample.ts', symbolName: './util', newSpecifier: './util-v2' },
    { workingDir: dir },
  );
  assert.equal(imp.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'sample.ts'), 'utf8'), /from '\.\/util-v2'/);
  const ins = applyV9AstEdit(
    {
      kind: 'insert-after',
      path: 'sample.ts',
      symbolName: 'greet',
      newText: 'export function farewell(name: string): string {\n  return `bye ${name}`;\n}',
    },
    { workingDir: dir },
  );
  assert.equal(ins.ok, true);
  const after = fs.readFileSync(path.join(dir, 'sample.ts'), 'utf8');
  assert.match(after, /farewell/);
  assert.ok(after.indexOf('farewell') > after.indexOf("return 'hello'"));
});

test('v9 ast: rename-symbol renames only in file, skips strings/comments', () => {
  const dir = tmpDir();
  const src = `export function greet(name: string): string {\n  return 'greet ' + name; // greet\n}\n\nexport function useIt() {\n  return greet('x');\n}\n`;
  writeFile(dir, 'r.ts', src);
  const parsed = v8ParseFile('r.ts', src);
  const { newContent, replaced } = v9RenameInContent(src, parsed, 'greet', 'sayHello');
  assert.ok(replaced >= 2);
  assert.match(newContent, /sayHello\('x'\)/);
  assert.match(newContent, /'greet ' \+ name/); // string literal untouched
  const res = applyV9AstEdit(
    { kind: 'rename-symbol', path: 'r.ts', symbolName: 'greet', newName: 'sayHello' },
    { workingDir: dir },
  );
  assert.equal(res.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'r.ts'), 'utf8'), /function sayHello/);
});

test('v9 ast: search-replace fallback needs unique match; preview does not write', () => {
  const dir = tmpDir();
  writeFile(dir, 'sample.ts', SAMPLE_TS);
  const preview = previewV9AstEdit(
    { kind: 'search-replace', path: 'sample.ts', oldBlock: "  return a - b;", newBlock: '  return a + b;' },
    { workingDir: dir },
  );
  assert.equal(preview.ok, true);
  assert.equal(preview.appliedKind, 'search-replace');
  assert.match(fs.readFileSync(path.join(dir, 'sample.ts'), 'utf8'), /return a - b;/); // not written
  const applied = applyV9AstEdit(
    { kind: 'search-replace', path: 'sample.ts', oldBlock: "  return a - b;", newBlock: '  return a + b;' },
    { workingDir: dir },
  );
  assert.equal(applied.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'sample.ts'), 'utf8'), /return a \+ b;/);
  // Missing block -> clear error.
  assert.throws(
    () => applyV9AstEdit({ kind: 'search-replace', path: 'sample.ts', oldBlock: 'no such line;', newBlock: 'x' }, { workingDir: dir }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'block-not-found');
      return true;
    },
  );
  // Ambiguous block without context -> error, not a guess.
  writeFile(dir, 'dup.ts', 'x = 1;\nx = 1;\n');
  assert.throws(
    () => v9FindBlock(['x = 1;', 'x = 1;'], 'x = 1;'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'block-ambiguous');
      return true;
    },
  );
  const found = v9FindBlock(['a', 'x = 1;', 'x = 1;'], 'x = 1;', 'a');
  assert.equal(found.startLine, 2);
});

test('v9 ast: replace-symbol falls back to search-replace when AST misses, and rejects oversized edits', () => {
  const dir = tmpDir();
  // Unparseable-ish file for the v8 parser (unknown extension content still text).
  writeFile(dir, 'notes.txt', 'TODO: fix this\nline two\n');
  const res = applyV9AstEdit(
    {
      kind: 'replace-symbol',
      path: 'notes.txt',
      symbolName: 'missing',
      newText: 'replaced',
      oldBlock: 'TODO: fix this',
      newBlock: 'TODO: fixed',
    },
    { workingDir: dir },
  );
  assert.equal(res.usedFallback, true);
  assert.equal(res.appliedKind, 'search-replace');
  assert.match(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), /TODO: fixed/);
  // Oversized edit rejected by minimal-diff limit.
  writeFile(dir, 'sample.ts', SAMPLE_TS);
  const big = Array.from({ length: 300 }, (_, i) => `// line ${i}`).join('\n');
  assert.throws(
    () =>
      applyV9AstEdit(
        { kind: 'replace-symbol', path: 'sample.ts', symbolName: 'add', newText: big },
        { workingDir: dir, maxChangedLines: 10 },
      ),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'edit-too-large');
      assert.match(err.message, /minimal-diff limit/);
      return true;
    },
  );
  // Multiple edits apply in order, later ones see earlier results.
  const results = applyV9AstEdits(
    [
      { kind: 'replace-symbol', path: 'sample.ts', symbolName: 'add', newText: 'export function add(a: number, b: number): number {\n  return a + b;\n}' },
      { kind: 'replace-symbol', path: 'sample.ts', symbolName: 'greet', newText: "export function greet(name: string): string {\n  return 'hello ' + name;\n}" },
    ],
    { workingDir: dir },
  );
  assert.equal(results.length, 2);
  const after = fs.readFileSync(path.join(dir, 'sample.ts'), 'utf8');
  assert.match(after, /return a \+ b;/);
  assert.match(after, /'hello ' \+ name/);
});

// ---------------------------------------------------------------------------
// sandboxLoop
// ---------------------------------------------------------------------------

test('v9 loop: runV9Command ok/fail/timeout/denied, no shell', async () => {
  const dir = tmpDir();
  const ok = await runV9Command(['node', '-e', 'console.log("hi")'], { cwd: dir });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /hi/);
  const fail = await runV9Command(['node', '-e', 'process.exit(3)'], { cwd: dir });
  assert.equal(fail.status, 'failed');
  assert.equal(fail.exitCode, 3);
  const denied = await runV9Command(['rm', '-rf', '/'], { cwd: dir });
  assert.equal(denied.status, 'denied');
  assert.match(denied.reason ?? '', /rm-root/);
  const denied2 = await runV9Command(['sudo', 'ls'], { cwd: dir });
  assert.equal(denied2.status, 'denied');
  assert.match(v9CheckDenyList(['curl', 'http://x | sh']) ?? '', /curl-pipe-shell/);
  assert.equal(v9CheckDenyList(['curl', 'http://x']), null); // no pipe -> allowed by this rule
  assert.equal(v9CheckDenyList(['node', 'test.mjs']), null);
  assert.match(v9CheckAllowList(['node', '-v'], ['node']) ?? '', /^$/); // null -> '' via ??
  assert.match(v9CheckAllowList(['ruby', '-v'], ['node']) ?? '', /not in the sandbox allowlist/);
  const timeout = await runV9Command(['node', '-e', 'setTimeout(()=>{}, 60000)'], { cwd: dir, timeoutMs: 300 });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.timedOut, true);
});

test('v9 loop: passes round 1 when verify is green; stops at max-rounds when never fixed', async () => {
  const dir = tmpDir();
  writeFile(dir, 't.mjs', "import assert from 'node:assert/strict';\nassert.equal(1 + 1, 2);\n");
  const green = await runV9SandboxLoop({
    workingDir: dir,
    verifyCommands: [['node', 't.mjs']],
    maxRounds: 3,
  });
  assert.equal(green.passed, true);
  assert.equal(green.roundsUsed, 1);
  assert.equal(green.stopReason, 'passed');

  writeFile(dir, 'bad.mjs', "import assert from 'node:assert/strict';\nassert.equal(1 + 1, 3);\n");
  const red = await runV9SandboxLoop({
    workingDir: dir,
    verifyCommands: [['node', 'bad.mjs']],
    maxRounds: 2,
  });
  assert.equal(red.passed, false);
  assert.equal(red.roundsUsed, 2);
  assert.equal(red.stopReason, 'max-rounds');
  assert.match(red.rounds[0].failureExcerpt, /AssertionError|node/);
});

test('v9 loop: fixProvider repairs the failure and round 2 goes green', async () => {
  const dir = tmpDir();
  writeFile(dir, 'util.mjs', "export function add(a, b) {\n  return a - b;\n}\n");
  writeFile(dir, 'test.mjs', "import { add } from './util.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(add(2, 3), 5);\n");
  let fixCalls = 0;
  const result = await runV9SandboxLoop({
    workingDir: dir,
    verifyCommands: [['node', 'test.mjs']],
    maxRounds: 3,
    fixProvider: async (round, failure) => {
      fixCalls += 1;
      assert.match(failure, /AssertionError/);
      applyV9AstEdit(
        { kind: 'replace-symbol', path: 'util.mjs', symbolName: 'add', newText: 'export function add(a, b) {\n  return a + b;\n}' },
        { workingDir: dir },
      );
      return `round ${round}: fixed add() to a + b`;
    },
  });
  assert.equal(fixCalls, 1);
  assert.equal(result.passed, true);
  assert.equal(result.roundsUsed, 2);
  assert.equal(result.stopReason, 'passed');
  assert.equal(result.rounds[1].note, 'round 1: fixed add() to a + b');
  assert.match(fs.readFileSync(path.join(dir, 'util.mjs'), 'utf8'), /a \+ b/);
});

// ---------------------------------------------------------------------------
// gitAtomic
// ---------------------------------------------------------------------------

test('v9 git: ensure repo, atomic commit, status, message generation', async () => {
  const dir = tmpDir();
  assert.equal(await v9EnsureGitRepo({ workingDir: dir }), true);
  assert.equal(await v9EnsureGitRepo({ workingDir: dir }), false);
  writeFile(dir, 'a.txt', 'hello\n');
  const commit = await commitV9Atomic({
    workingDir: dir,
    files: ['a.txt'],
    summary: 'add greeting file',
    task: 'add a greeting',
    roundsUsed: 2,
  });
  assert.match(commit.sha, /^[0-9a-f]{40}$/);
  assert.equal(commit.shortSha.length, 7);
  assert.match(commit.message, /v117-coding: add greeting file \(a\.txt, \+1\/-0\)/);
  assert.match(commit.message, /Task: add a greeting/);
  assert.match(commit.message, /Sandbox loop: 2 round/);
  assert.equal(commit.totalAdded, 1);
  const status = await v9GitStatus({ workingDir: dir });
  assert.equal(status.clean, true);
  assert.equal(status.branch, 'master');
  writeFile(dir, 'a.txt', 'hello world\n');
  const status2 = await v9GitStatus({ workingDir: dir });
  assert.equal(status2.clean, false);
  assert.deepEqual(status2.modified, ['a.txt']);
  // Message generator alone (no git).
  const msg = generateV9CommitMessage({
    summary: 'fix add',
    stats: [
      { path: 'src/util.ts', added: 5, removed: 2 },
      { path: 'src/other.ts', added: 1, removed: 1 },
    ],
  });
  assert.match(msg, /fix add \(src\/util\.ts, \+6\/-3\)/);
  assert.match(msg, /- src\/util\.ts: \+5 -2/);
});

test('v9 git: rollback restores HEAD; edit-and-commit commits on verify ok, rolls back on fail', async () => {
  const dir = tmpDir();
  await v9EnsureGitRepo({ workingDir: dir });
  writeFile(dir, 'util.mjs', "export function add(a, b) {\n  return a - b;\n}\n");
  await commitV9Atomic({ workingDir: dir, files: ['util.mjs'], summary: 'base util' });
  const { edit, commit } = await applyV9EditAndCommit({
    workingDir: dir,
    edit: () =>
      applyV9AstEdit(
        { kind: 'replace-symbol', path: 'util.mjs', symbolName: 'add', newText: 'export function add(a, b) {\n  return a + b;\n}' },
        { workingDir: dir },
      ),
    verify: () => ({ ok: true, output: 'verify ok' }),
    summary: 'fix add',
    task: 'fix add',
  });
  assert.equal(edit.ok, true);
  assert.ok(commit.sha);
  assert.match(fs.readFileSync(path.join(dir, 'util.mjs'), 'utf8'), /a \+ b/);

  // Verify fail -> rollback, no new commit.
  await assert.rejects(
    () =>
      applyV9EditAndCommit({
        workingDir: dir,
        edit: () =>
          applyV9AstEdit(
            { kind: 'replace-symbol', path: 'util.mjs', symbolName: 'add', newText: 'export function add(a, b) {\n  return a * b;\n}' },
            { workingDir: dir },
          ),
        verify: () => ({ ok: false, output: 'test failed: add(2,3) != 6' }),
        summary: 'bad fix',
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'verify-failed');
      assert.match(err.message, /rolled back/);
      return true;
    },
  );
  assert.match(fs.readFileSync(path.join(dir, 'util.mjs'), 'utf8'), /a \+ b/);
  const log = await v9CommitLogSince(dir, '');
  assert.equal(log.length, 2);
  assert.equal(log[0].subject.includes('fix add'), true);
  // Rollback helper directly.
  writeFile(dir, 'util.mjs', "export function add(a, b) {\n  return 0;\n}\n");
  await v9RollbackFiles(dir, ['util.mjs']);
  assert.match(fs.readFileSync(path.join(dir, 'util.mjs'), 'utf8'), /a \+ b/);
});

test('v9 git: draft-PR description lists commits and totals', async () => {
  const dir = tmpDir();
  await v9EnsureGitRepo({ workingDir: dir });
  writeFile(dir, 'a.txt', 'one\n');
  await commitV9Atomic({ workingDir: dir, files: ['a.txt'], summary: 'base commit' });
  const base = (await v9CommitLogSince(dir, ''))[0];
  writeFile(dir, 'a.txt', 'one\ntwo\n');
  await commitV9Atomic({ workingDir: dir, files: ['a.txt'], summary: 'add second line' });
  const commits = await v9CommitLogSince(dir, base.sha);
  assert.equal(commits.length, 1);
  const pr = generateV9DraftPrDescription({
    commits,
    headBranch: 'v117-coding',
    baseBranch: 'main',
    summary: 'Add second line',
    testSummary: 'Sandbox loop: passed after 1 round(s).',
  });
  assert.equal(pr.title, 'Add second line');
  assert.equal(pr.commitCount, 1);
  assert.match(pr.body, /## Commits/);
  assert.match(pr.body, /add second line/);
  assert.match(pr.body, /## Tests/);
  assert.match(pr.body, /Sandbox loop: passed/);
});

// ---------------------------------------------------------------------------
// evalHarness
// ---------------------------------------------------------------------------

test('v9 eval: scripted agent scores 2/3 tasks, pass@k and token estimates recorded', async () => {
  const summary = await runV9EvalTask(V9_EVAL_SAMPLE_TASKS[0], scriptedV9Agent, { attemptsPerTask: 2 });
  assert.equal(summary.taskId, 'v9-eval-add');
  assert.equal(summary.anyPass, true);
  assert.equal(summary.passCount, 2);
  assert.equal(summary.attempts[0].status, 'pass');
  assert.equal(summary.attempts[0].tokensEstimated, true); // scripted agent reports no tokens
  assert.ok(summary.attempts[0].tokensIn > 0);
  assert.equal(summary.attempts[0].model, 'scripted-v9');

  const failing = await runV9EvalTask(V9_EVAL_SAMPLE_TASKS[2], scriptedV9Agent, { attemptsPerTask: 2 });
  assert.equal(failing.anyPass, false);
  assert.equal(failing.passCount, 0);
  assert.equal(failing.attempts[0].status, 'fail');
}, { timeout: 120_000 });

test('v9 eval: suite report, save/load/compare round-trip', async () => {
  const report = await runV9EvalSuite(V9_EVAL_SAMPLE_TASKS, scriptedV9Agent, {
    attemptsPerTask: 2,
    suiteName: 'coding-v9-sample-test',
  });
  assert.equal(report.taskCount, 3);
  assert.equal(report.tasksPassed, 2);
  assert.ok(Math.abs(report.passAtK - 2 / 3) < 1e-9);
  assert.ok(report.attemptPassRate > 0 && report.attemptPassRate < 1);
  assert.ok(report.avgRounds > 0);
  assert.ok(report.avgTokens > 0);
  assert.ok(report.totalDurationMs > 0);
  const rendered = renderV9EvalReport(report);
  assert.match(rendered, /pass@2: 2\/3/);
  assert.match(rendered, /v9-eval-sort/);

  const dir = tmpDir();
  const file = saveV9EvalReport(report, dir);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(listV9EvalReports(dir), [file]);
  const loaded = loadV9EvalReport(file);
  assert.equal(loaded.passAtK, report.passAtK);
  assert.equal(loaded.tasksPassed, 2);

  // Compare identical reports -> zero deltas; compare vs a worse run -> negative delta.
  const same = compareV9EvalReports(report, loaded, file, file);
  assert.equal(same.passAtKDelta, 0);
  assert.equal(same.changedTasks.length, 0);
  const worse = { ...report, passAtK: 0, attemptPassRate: 0, avgRounds: 0, avgTokens: 0, tasksPassed: 0, tasks: report.tasks.map((t) => ({ ...t, anyPass: false, passCount: 0 })) };
  const cmp = compareV9EvalReports(worse, report, 'old.json', 'new.json');
  assert.ok(cmp.passAtKDelta > 0);
  assert.equal(cmp.changedTasks.length, 2);
  assert.match(renderV9EvalComparison(cmp), /pass@k delta: \+/);
  assert.throws(() => loadV9EvalReport(path.join(dir, 'nope.json')), /ENOENT/);
}, { timeout: 180_000 });

test('v9 eval: empty patch is an error attempt; agent throwing is an error attempt', async () => {
  const empty = await runV9EvalTask(V9_EVAL_SAMPLE_TASKS[0], () => ({ patch: '   ' }), { attemptsPerTask: 1 });
  assert.equal(empty.attempts[0].status, 'error');
  assert.match(empty.attempts[0].reason, /empty patch/);
  const throwing = await runV9EvalTask(V9_EVAL_SAMPLE_TASKS[0], () => { throw new Error('boom'); }, { attemptsPerTask: 1 });
  assert.equal(throwing.attempts[0].status, 'error');
  assert.match(throwing.attempts[0].reason, /boom/);
  assert.equal(v9EstimateTokens('abcd'), 1);
  assert.equal(v9EstimateTokens(''), 0);
}, { timeout: 60_000 });

// ---------------------------------------------------------------------------
// agent v9 end-to-end
// ---------------------------------------------------------------------------

test('v9 agent: plan -> AST edit -> verify -> atomic commit -> draft PR', async () => {
  const dir = tmpDir();
  await v9EnsureGitRepo({ workingDir: dir });
  writeFile(dir, 'util.mjs', "export function greet(name) {\n  return 'hello';\n}\n");
  writeFile(dir, 'test.mjs', "import { greet } from './util.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(greet('An'), 'hello An');\n");
  await commitV9Atomic({ workingDir: dir, files: ['util.mjs', 'test.mjs'], summary: 'base greet' });
  const baseSha = (await v9CommitLogSince(dir, ''))[0].sha;

  const agent = new CodingAgentV9({
    workingDir: dir,
    planProvider: () => [
      { kind: 'replace-symbol', path: 'util.mjs', symbolName: 'greet', newText: "export function greet(name) {\n  return 'hello ' + name;\n}" },
    ],
    verifyCommands: [['node', 'test.mjs']],
    maxRounds: 3,
    autoCommit: true,
    draftPr: true,
    baseRef: baseSha,
    baseBranch: 'main',
    summary: 'Fix greet() to include the name',
  });
  const report = await agent.runTask('Fix greet', "greet('An') should return 'hello An'.");
  assert.equal(report.ok, true);
  assert.equal(report.edits.length, 1);
  assert.equal(report.loop?.passed, true);
  assert.ok(report.commit?.sha);
  assert.equal(report.draftPr?.commitCount, 1);
  assert.equal(report.draftPr?.title, 'Fix greet() to include the name');
  assert.match(report.combinedDiff, /hello ' \+ name/);
  assert.ok(report.steps.some((s) => s.name === 'plan' && s.status === 'ok'));
  assert.ok(report.steps.some((s) => s.name === 'commit' && s.status === 'ok'));
  assert.ok(report.steps.some((s) => s.name === 'draft-pr' && s.status === 'ok'));
  const status = await v9GitStatus({ workingDir: dir });
  assert.equal(status.clean, true);
}, { timeout: 120_000 });

test('v9 agent: failing verify means no commit; empty plan means nothing to do', async () => {
  const dir = tmpDir();
  await v9EnsureGitRepo({ workingDir: dir });
  writeFile(dir, 'util.mjs', "export function greet(name) {\n  return 'hello';\n}\n");
  writeFile(dir, 'test.mjs', "import { greet } from './util.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(greet('An'), 'hello An');\n");
  await commitV9Atomic({ workingDir: dir, files: ['util.mjs', 'test.mjs'], summary: 'base' });

  const failing = new CodingAgentV9({
    workingDir: dir,
    planProvider: () => [
      { kind: 'replace-symbol', path: 'util.mjs', symbolName: 'greet', newText: "export function greet(name) {\n  return 'bye';\n}" },
    ],
    verifyCommands: [['node', 'test.mjs']],
    maxRounds: 1,
  });
  const badReport = await failing.runTask('Bad greet', 'change greet to bye');
  assert.equal(badReport.ok, false);
  assert.equal(badReport.commit, undefined);
  assert.equal(badReport.loop?.passed, false);
  // File still has the (bad) edit on disk — agent does not auto-rollback (host decides).
  assert.match(fs.readFileSync(path.join(dir, 'util.mjs'), 'utf8'), /'bye'/);

  const empty = new CodingAgentV9({
    workingDir: dir,
    planProvider: () => [],
  });
  const emptyReport = await empty.runTask('Nothing', 'no-op task');
  assert.equal(emptyReport.ok, true);
  assert.equal(emptyReport.edits.length, 0);
}, { timeout: 120_000 });

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

test('v9 report: duration/percent formatting and edit summary', async () => {
  const { v9FormatDuration, v9FormatPercent, v9SummarizeEdit } = await import(
    '../packages/core/dist/codingV9/index.js'
  );
  assert.equal(v9FormatDuration(500), '500ms');
  assert.equal(v9FormatDuration(1500), '1.5s');
  assert.equal(v9FormatDuration(125000), '2m 05s');
  assert.equal(v9FormatPercent(2 / 3), '66.7%');
  assert.equal(v9FormatPercent(0), '0.0%');
  assert.equal(
    v9SummarizeEdit({
      ok: true, appliedKind: 'replace-symbol', usedFallback: false, path: 'a.ts',
      symbolName: 'add', startLine: 1, endLine: 3, linesAdded: 1, linesRemoved: 1,
      diff: '', verifyNote: '',
    }),
    'replace-symbol a.ts:add (+1/-1, lines 1-3)',
  );
});

test('v9 report: agent report renders steps, edits, loop, commit and draft PR', async () => {
  const { renderV9AgentReport, renderV9LoopReport, v9SummarizeEvalReport } = await import(
    '../packages/core/dist/codingV9/index.js'
  );
  const loop = await runV9SandboxLoop({
    workingDir: tmpDir(),
    verifyCommands: [['node', '-e', 'console.log("ok")']],
    maxRounds: 2,
  });
  assert.equal(loop.passed, true);
  const md = renderV9LoopReport(loop);
  assert.match(md, /## Sandbox loop/);
  assert.match(md, /passed.*after 1\/2 round/);

  const report = await runV9EvalSuite([V9_EVAL_SAMPLE_TASKS[0]], scriptedV9Agent, { attemptsPerTask: 1 });
  const oneLine = v9SummarizeEvalReport(report);
  assert.match(oneLine, /pass@1 1\/1 \(100\.0%\)/);

  const agentReport = {
    title: 'Demo task',
    task: 'demo',
    ok: true,
    steps: [{ name: 'plan', status: 'ok', detail: '1 edit', durationMs: 5 }],
    edits: [{
      ok: true, appliedKind: 'replace-symbol', usedFallback: true, path: 'x.ts',
      symbolName: 'f', startLine: 2, endLine: 4, linesAdded: 2, linesRemoved: 1,
      diff: '--- a/x.ts\n+++ b/x.ts\n', verifyNote: 'ok',
    }],
    loop,
    commit: {
      sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: 'v117-coding: demo (x.ts, +2/-1)',
      files: ['x.ts'], stats: [{ path: 'x.ts', added: 2, removed: 1 }], totalAdded: 2, totalRemoved: 1,
    },
    draftPr: {
      title: 'Demo PR', body: '## Summary\n\nDemo.\n', headBranch: 'v117-coding',
      baseBranch: 'main', commitCount: 1, filesChanged: 1, totalAdded: 2, totalRemoved: 1,
    },
    combinedDiff: '--- a/x.ts\n+++ b/x.ts\n',
    totalDurationMs: 1234,
  };
  const full = renderV9AgentReport(agentReport);
  assert.match(full, /# Coding agent v9: Demo task/);
  assert.match(full, /\*\*done\*\* in 1\.2s/);
  assert.match(full, /fallback search-replace/);
  assert.match(full, /Commit `aaaaaaa`/);
  assert.match(full, /# Demo PR/);
  assert.match(full, /```diff/);
}, { timeout: 60_000 });
