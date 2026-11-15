/**
 * Tests for Harbor-format eval tasks (packages/core/src/eval/harborTask.ts
 * + harborLibrary.ts) — v1.11, Đội T2.
 *
 * Covers: meta/instruction/test-script/environment validation, the
 * load → write → load round-trip on disk, test.sh output parsing,
 * weighted scoring (reward), and the 4 built-in sample tasks (all
 * valid, all materialize + reload cleanly).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-v111-harbor-task.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BUILTIN_HARBOR_TASK_IDS,
  builtinHarborTasks,
  getBuiltinHarborTask,
  materializeBuiltinHarborTasks,
} from '../packages/core/dist/eval/harborLibrary.js';
import {
  HarborTaskError,
  defaultHarborTaskMeta,
  isSafeRelativePath,
  loadHarborTaskFromDir,
  loadHarborTasksFromDir,
  parseHarborTestOutput,
  scoreHarborTests,
  validateHarborTask,
  validateHarborTaskMeta,
  validateHarborTestScript,
  writeHarborTaskToDir,
} from '../packages/core/dist/eval/harborTask.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-harbor-task-'));
}

function validMeta() {
  return {
    ...defaultHarborTaskMeta('hello-file'),
    name: 'Hello file',
    kind: 'general',
    description: 'Tạo file greeting.txt.',
    version: 1,
    testWeights: { 'file-exists': 1, 'exact-content': 2 },
    tags: ['file-io'],
  };
}

test('validateHarborTaskMeta: valid meta has no issues; bad fields are all reported', () => {
  assert.deepEqual(validateHarborTaskMeta(validMeta()), []);
  const bad = {
    id: 'Bad ID!',
    name: '',
    kind: 'nope',
    description: '',
    version: 0,
    timeoutMs: 100,
    maxTurns: 0,
    testWeights: { 'a b': 0, good: -1 },
    tags: ['ok', ''],
  };
  const issues = validateHarborTaskMeta(bad);
  const fields = issues.map((i) => i.field);
  for (const field of ['task.json:id', 'task.json:name', 'task.json:kind', 'task.json:description', 'task.json:version', 'task.json:timeoutMs', 'task.json:maxTurns', 'task.json:tags']) {
    assert.ok(fields.includes(field), `expected issue for ${field}, got ${fields.join(', ')}`);
  }
  assert.ok(issues.filter((i) => i.field === 'task.json:testWeights').length >= 2);
});

test('validateHarborTaskMeta: empty testWeights and timeout bounds are rejected', () => {
  assert.ok(validateHarborTaskMeta({ ...validMeta(), testWeights: {} }).length > 0);
  assert.ok(validateHarborTaskMeta({ ...validMeta(), timeoutMs: 4_999 }).length > 0);
  assert.ok(validateHarborTaskMeta({ ...validMeta(), timeoutMs: 1_800_001 }).length > 0);
  assert.deepEqual(validateHarborTaskMeta({ ...validMeta(), timeoutMs: 5_000 }), []);
  assert.deepEqual(validateHarborTaskMeta({ ...validMeta(), timeoutMs: 1_800_000 }), []);
});

test('isSafeRelativePath: rejects absolute paths, .. escapes and empty strings', () => {
  assert.equal(isSafeRelativePath('data/numbers.csv'), true);
  assert.equal(isSafeRelativePath('calc.py'), true);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('../escape.txt'), false);
  assert.equal(isSafeRelativePath('a/../../escape.txt'), false);
  assert.equal(isSafeRelativePath(''), false);
  assert.equal(isSafeRelativePath('a//b.txt'), true);
});

test('validateHarborTestScript: forbids destructive patterns, allows normal scripts', () => {
  assert.deepEqual(validateHarborTestScript('#!/bin/sh\necho "PASS a"\n'), []);
  assert.ok(validateHarborTestScript('rm -rf / --no-preserve-root').length > 0);
  assert.ok(validateHarborTestScript('mkfs.ext4 /dev/sda1').length > 0);
  assert.ok(validateHarborTestScript('dd if=/dev/zero of=/dev/sda').length > 0);
  assert.ok(validateHarborTestScript('').length > 0);
});

test('parseHarborTestOutput: PASS/FAIL lines parsed, last verdict wins, other lines kept', () => {
  const parsed = parseHarborTestOutput('setup done\nPASS a\nFAIL b\nPASS a\nFAIL a\nsome log\n');
  assert.deepEqual(parsed.passed, []);
  assert.deepEqual(parsed.failed, ['a', 'b']);
  assert.ok(parsed.otherLines.includes('setup done'));
  const parsed2 = parseHarborTestOutput('PASS x\nPASS y\n');
  assert.deepEqual(parsed2.passed, ['x', 'y']);
  assert.deepEqual(parsed2.failed, []);
});

test('scoreHarborTests: weighted reward, unmentioned tests count as FAIL', () => {
  const scored = scoreHarborTests({ a: 1, b: 2, c: 1 }, { passed: ['a'], failed: ['b'], otherLines: [] });
  assert.equal(scored.totalWeight, 4);
  assert.equal(scored.passedWeight, 1);
  assert.equal(scored.reward, 0.25);
  assert.deepEqual(scored.perTest.map((t) => t.passed), [true, false, false]);
  const full = scoreHarborTests({ a: 1, b: 2 }, { passed: ['a', 'b'], failed: [], otherLines: [] });
  assert.equal(full.reward, 1);
  const empty = scoreHarborTests({}, { passed: [], failed: [], otherLines: [] });
  assert.equal(empty.reward, 0);
});

test('builtin tasks: 4 tasks, all valid, ids stable', () => {
  const tasks = builtinHarborTasks();
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.map((t) => t.meta.id), [...BUILTIN_HARBOR_TASK_IDS]);
  for (const task of tasks) {
    const result = validateHarborTask(task);
    assert.equal(result.valid, true, `${task.meta.id}: ${JSON.stringify(result.issues)}`);
    assert.ok(task.instruction.trim().length >= 20);
    assert.ok(task.testScript.includes('PASS '));
  }
  assert.equal(getBuiltinHarborTask('sum-csv')?.meta.kind, 'coding');
  assert.equal(getBuiltinHarborTask('nope'), undefined);
});

test('materialize + load round-trip: builtin tasks survive disk and reload identically', () => {
  const dir = tmpDir();
  const dirs = materializeBuiltinHarborTasks(dir);
  assert.equal(dirs.length, 4);
  const { tasks, skipped } = loadHarborTasksFromDir(dir);
  assert.equal(skipped.length, 0);
  assert.equal(tasks.length, 4);
  const original = builtinHarborTasks();
  for (const task of original) {
    const reloaded = tasks.find((t) => t.meta.id === task.meta.id);
    assert.ok(reloaded, task.meta.id);
    assert.deepEqual(reloaded.meta, task.meta);
    assert.equal(reloaded.instruction, task.instruction);
    assert.equal(reloaded.testScript, task.testScript);
    assert.deepEqual(reloaded.environment, task.environment);
    // test.sh is executable on POSIX after materialize.
    assert.ok((fs.statSync(path.join(dir, task.meta.id, 'tests', 'test.sh')).mode & 0o111) !== 0);
  }
});

test('loadHarborTaskFromDir: missing files and invalid tasks throw HarborTaskError with issues', () => {
  const dir = tmpDir();
  assert.throws(() => loadHarborTaskFromDir(dir), (err) => err instanceof HarborTaskError && err.issues.length >= 3);
  const taskDir = path.join(dir, 'bad');
  const bad = getBuiltinHarborTask('hello-file');
  assert.ok(bad);
  // writeHarborTaskToDir validates first, so write the bad files by hand instead.
  fs.rmSync(taskDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(taskDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ ...validMeta(), testWeights: {} }), 'utf-8');
  fs.writeFileSync(path.join(taskDir, 'instruction.md'), 'Do the thing, please, in detail.', 'utf-8');
  fs.writeFileSync(path.join(taskDir, 'tests', 'test.sh'), '#!/bin/sh\necho "PASS x"\n', 'utf-8');
  assert.throws(() => loadHarborTaskFromDir(taskDir), (err) => err instanceof HarborTaskError && err.issues.some((i) => i.field === 'task.json:testWeights'));
});

test('loadHarborTasksFromDir: invalid task dirs are skipped, not fatal', () => {
  const dir = tmpDir();
  materializeBuiltinHarborTasks(dir);
  const badDir = path.join(dir, 'broken-task');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'task.json'), '{not json', 'utf-8');
  const { tasks, skipped } = loadHarborTasksFromDir(dir);
  assert.equal(tasks.length, 4);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].dir, badDir);
  assert.ok(skipped[0].issues.length > 0);
});

test('writeHarborTaskToDir: refuses to write an invalid task', () => {
  const dir = tmpDir();
  const bad = getBuiltinHarborTask('hello-file');
  assert.ok(bad);
  assert.throws(
    () => writeHarborTaskToDir({ ...bad, instruction: '' }, path.join(dir, 'x')),
    (err) => err instanceof HarborTaskError,
  );
});
