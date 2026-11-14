/**
 * Tests for the SWE-bench-style local eval (packages/core/src/observability/sweBenchEval.ts).
 *
 * Covers task validation, baseline checking (fail-to-pass must fail
 * before the solver runs), resolve/not-resolved via REAL test commands
 * run in a temp workspace, solver errors/timeouts, the suite report,
 * Markdown rendering, and report saving.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/swebench-eval-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  runSweBenchSuite,
  runSweBenchTask,
  runTestCommand,
  saveSweBenchReport,
  sweBenchReportToMarkdown,
  validateSweBenchTask,
  validateSweTestCommand,
} from '../packages/core/dist/observability/sweBenchEval.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-swe-'));
}

// Buggy add(): returns a - b. The test fails before the fix, passes after.
const BUGGY_CALC = 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n';
const FIXED_CALC = 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n';
const TEST_JS = "const { add } = require('./calc.js');\nif (add(2, 3) !== 5) { console.error('add(2,3) should be 5, got ' + add(2, 3)); process.exit(1); }\nconsole.log('add ok');\n";
const SMOKE_JS = "console.log('smoke ok');\n";

function addTask(overrides = {}) {
  return {
    id: 'swe-add-001',
    title: 'Fix add() to sum instead of subtract',
    problemStatement: 'add(2, 3) should return 5 but returns -1.',
    setupFiles: { 'calc.js': BUGGY_CALC, 'test.js': TEST_JS, 'smoke.js': SMOKE_JS },
    failToPass: [{ name: 'test-add', argv: ['node', 'test.js'] }],
    passToPass: [{ name: 'smoke', argv: ['node', 'smoke.js'] }],
    ...overrides,
  };
}

/** Solver that fixes calc.js (the "agent" under test). */
async function fixingSolver(workspaceDir) {
  fs.writeFileSync(path.join(workspaceDir, 'calc.js'), FIXED_CALC, 'utf8');
}

/** Solver that does nothing (the bug stays). */
async function noopSolver() {
  // Intentionally leaves the bug in place.
}

// --- validation ---------------------------------------------------------------

test('swe-bench eval: validateSweTestCommand / validateSweBenchTask reject bad input', () => {
  assert.throws(() => validateSweTestCommand({}), /name/);
  assert.throws(() => validateSweTestCommand({ name: 'x', argv: [] }), /argv/);
  assert.throws(() => validateSweTestCommand({ name: 'x', argv: ['node'], expectExitCode: 999 }), /expectExitCode/);
  assert.throws(() => validateSweBenchTask({}), /id/);
  assert.throws(() => validateSweBenchTask(addTask({ failToPass: [] })), /at least one failToPass/);
  assert.throws(() => validateSweBenchTask(addTask({ setupFiles: { '../escape.js': 'x' } })), /relative path/);
  assert.throws(() => validateSweBenchTask(addTask({ testTimeoutMs: 0 })), /testTimeoutMs/);
});

// --- command runner -------------------------------------------------------------

test('swe-bench eval: runTestCommand runs a real command with exit code + timeout', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ok.js'), "console.log('hi');", 'utf8');
  const pass = await runTestCommand({ name: 'ok', argv: ['node', 'ok.js'] }, dir, 5000);
  assert.equal(pass.passed, true);
  assert.equal(pass.exitCode, 0);
  assert.equal(pass.timedOut, false);
  assert.match(pass.output, /hi/);
  const fail = await runTestCommand({ name: 'missing', argv: ['node', 'nope.js'] }, dir, 5000);
  assert.equal(fail.passed, false);
  assert.notEqual(fail.exitCode, 0);
  const wrongCode = await runTestCommand({ name: 'ok-expect-3', argv: ['node', 'ok.js'], expectExitCode: 3 }, dir, 5000);
  assert.equal(wrongCode.passed, false);
  // A command that never exits is killed by the timeout (not a pass).
  const slow = await runTestCommand({ name: 'slow', argv: ['node', '-e', 'setTimeout(()=>{}, 60000)'] }, dir, 300);
  assert.equal(slow.timedOut, true);
  assert.equal(slow.passed, false);
});

// --- task runs -------------------------------------------------------------------

test('swe-bench eval: fixing solver resolves the task (baseline fails, final passes)', async () => {
  const result = await runSweBenchTask(addTask(), fixingSolver, { workspacesDir: tmpDir() });
  assert.equal(result.status, 'resolved');
  assert.equal(result.resolved, true);
  assert.equal(result.baselineFailToPass[0].passed, false, 'fail-to-pass must FAIL at baseline');
  assert.equal(result.baselinePassToPass[0].passed, true, 'pass-to-pass must PASS at baseline');
  assert.equal(result.finalFailToPass[0].passed, true);
  assert.equal(result.finalPassToPass[0].passed, true);
  assert.ok(result.durationMs >= 0);
});

test('swe-bench eval: noop solver leaves the task not-resolved', async () => {
  const result = await runSweBenchTask(addTask(), noopSolver, { workspacesDir: tmpDir() });
  assert.equal(result.status, 'not-resolved');
  assert.equal(result.resolved, false);
  assert.equal(result.finalFailToPass[0].passed, false);
  assert.equal(result.finalPassToPass[0].passed, true, 'regression guard still passes');
});

test('swe-bench eval: task whose fail-to-pass already passes is invalid-baseline (solver never runs)', async () => {
  let solverRan = false;
  const task = addTask({ setupFiles: { 'calc.js': FIXED_CALC, 'test.js': TEST_JS, 'smoke.js': SMOKE_JS } });
  const result = await runSweBenchTask(task, async () => { solverRan = true; }, { workspacesDir: tmpDir() });
  assert.equal(result.status, 'invalid-baseline');
  assert.equal(result.resolved, false);
  assert.equal(solverRan, false, 'solver must not run on an invalid baseline');
  assert.equal(result.finalFailToPass.length, 0);
  assert.match(result.solverError ?? '', /baseline invalid/);
});

test('swe-bench eval: task whose pass-to-pass already fails is invalid-baseline', async () => {
  const task = addTask({
    setupFiles: { 'calc.js': BUGGY_CALC, 'test.js': TEST_JS, 'smoke.js': "process.exit(1);\n" },
  });
  const result = await runSweBenchTask(task, fixingSolver, { workspacesDir: tmpDir() });
  assert.equal(result.status, 'invalid-baseline');
});

test('swe-bench eval: solver error and solver timeout are reported, not thrown', async () => {
  const errResult = await runSweBenchTask(addTask(), async () => { throw new Error('solver exploded'); }, { workspacesDir: tmpDir() });
  assert.equal(errResult.status, 'solver-error');
  assert.equal(errResult.resolved, false);
  assert.match(errResult.solverError ?? '', /solver exploded/);
  const timeoutResult = await runSweBenchTask(
    addTask({ solverTimeoutMs: 200 }),
    async () => { await new Promise((r) => setTimeout(r, 5000)); },
    { workspacesDir: tmpDir() },
  );
  assert.equal(timeoutResult.status, 'solver-timeout');
  assert.match(timeoutResult.solverError ?? '', /timed out/);
});

test('swe-bench eval: keepWorkspaces keeps the temp dir, otherwise it is removed', async () => {
  const parent = tmpDir();
  const kept = await runSweBenchTask(addTask(), fixingSolver, { workspacesDir: parent, keepWorkspaces: true });
  assert.ok(kept.workspaceDir);
  assert.equal(fs.existsSync(kept.workspaceDir), true);
  assert.equal(fs.readFileSync(path.join(kept.workspaceDir, 'calc.js'), 'utf8'), FIXED_CALC);
  const removed = await runSweBenchTask(addTask(), fixingSolver, { workspacesDir: parent });
  assert.equal(removed.workspaceDir, undefined);
});

// --- suite ---------------------------------------------------------------------

test('swe-bench eval: suite aggregates resolve rate and renders Markdown', async () => {
  const tasks = [addTask(), addTask({ id: 'swe-add-002', title: 'Same bug, second instance' })];
  const report = await runSweBenchSuite(tasks, fixingSolver, { workspacesDir: tmpDir() });
  assert.equal(report.totalTasks, 2);
  assert.equal(report.validTasks, 2);
  assert.equal(report.resolvedTasks, 2);
  assert.equal(report.resolveRate, 1);
  assert.equal(report.invalidBaselineTasks, 0);
  assert.equal(report.solverErrorTasks, 0);
  const md = sweBenchReportToMarkdown(report);
  assert.match(md, /Resolved: 2\/2 \(100\.0%\)/);
  assert.match(md, /swe-add-001 \| resolved/);
  const filePath = path.join(tmpDir(), 'report.json');
  assert.equal(saveSweBenchReport(report, filePath), filePath);
  const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(loaded.resolvedTasks, 2);
  // Mixed suite: one resolved, one invalid baseline → resolve rate counts valid only.
  const mixed = await runSweBenchSuite(
    [addTask(), addTask({ id: 'swe-bad', setupFiles: { 'calc.js': FIXED_CALC, 'test.js': TEST_JS, 'smoke.js': SMOKE_JS } })],
    fixingSolver,
    { workspacesDir: tmpDir() },
  );
  assert.equal(mixed.totalTasks, 2);
  assert.equal(mixed.validTasks, 1);
  assert.equal(mixed.resolveRate, 1);
  assert.equal(mixed.invalidBaselineTasks, 1);
});
