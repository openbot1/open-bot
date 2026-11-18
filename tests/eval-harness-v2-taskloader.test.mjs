/**
 * Tests for Eval Harness v2 task loader + oracle (v1.34, Đội T4):
 * `packages/core/src/evalHarnessV2/taskLoader.ts` + `oracle.ts`.
 *
 * Covers: parse/validate both task kinds (issue-patch + state-check),
 * defaults (timeout/weight/group), rejection of missing oracle,
 * wrong test group per kind, unsafe paths, forbidden commands,
 * duplicate test ids, load from dir (materialized sample suite),
 * oracle validation (sample oracles pass; wrong oracle rejected;
 * fail-to-pass already passing before oracle rejected).
 *
 * Runs the built-in sample tasks with real `node` in temp sandboxes
 * (fast, no network, no Docker). Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-harness-v2-taskloader.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EVAL_HARNESS_V2_SAMPLE_TASK_ADD,
  EVAL_HARNESS_V2_SAMPLE_TASK_GREET,
  EVAL_HARNESS_V2_SAMPLE_TASK_SUM,
  EVAL_HARNESS_V2_SAMPLE_TASKS,
  assertValidOracleSolution,
  defaultEvalHarnessV2TasksDir,
  loadEvalHarnessV2TaskFromDir,
  loadEvalHarnessV2TasksFromDir,
  materializeBuiltinEvalHarnessV2Tasks,
  parseEvalHarnessV2Task,
  validateEvalHarnessV2Task,
  validateOracleSolution,
} from '../packages/core/dist/evalHarnessV2/index.js';

function baseIssuePatchTask(overrides = {}) {
  return {
    format: 'eval-harness-v2',
    version: 2,
    id: 'v2-test-add',
    name: 'Test add',
    description: 'Test task.',
    kind: 'issue-patch',
    difficulty: 'easy',
    timeoutMs: 60_000,
    input: {
      instruction: 'Fix add().',
      issue: 'add(2, 3) returns -1.',
      repoSnapshot: {
        'add.js': 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n',
        'test-add.js':
          "const assert = require('assert');\nconst { add } = require('./add.js');\nassert.strictEqual(add(2, 3), 5);\n",
      },
    },
    output: { description: 'add.js fixed.' },
    oracle: {
      files: { 'add.js': 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n' },
    },
    tests: [
      { id: 'add-ok', name: 'add ok', command: 'node test-add.js', group: 'fail-to-pass' },
    ],
    ...overrides,
  };
}

function baseStateCheckTask(overrides = {}) {
  return {
    format: 'eval-harness-v2',
    version: 2,
    id: 'v2-test-greet',
    name: 'Test greet',
    description: 'Test task.',
    kind: 'state-check',
    difficulty: 'easy',
    timeoutMs: 60_000,
    input: { instruction: 'Create hello.txt containing HELLO.' },
    output: { description: 'hello.txt exists with HELLO.' },
    oracle: { files: { 'hello.txt': 'HELLO\n' } },
    tests: [
      {
        id: 'hello-ok',
        name: 'hello ok',
        command: "node -e \"require('fs').readFileSync('hello.txt','utf8').includes('HELLO') || process.exit(1)\"",
        group: 'state-check',
      },
    ],
    ...overrides,
  };
}

test('parse issue-patch task: defaults filled (group, weight, maxTrials)', () => {
  const task = parseEvalHarnessV2Task(baseIssuePatchTask());
  assert.equal(task.format, 'eval-harness-v2');
  assert.equal(task.version, 2);
  assert.equal(task.tests[0].group, 'fail-to-pass');
  assert.equal(task.tests[0].weight, 1);
  assert.equal(task.maxTrials, 3);
  assert.equal(task.timeoutMs, 60_000);
});

test('parse state-check task: default group is state-check', () => {
  const raw = baseStateCheckTask();
  delete raw.tests[0].group;
  const task = parseEvalHarnessV2Task(raw);
  assert.equal(task.tests[0].group, 'state-check');
});

test('validate rejects wrong format/version', () => {
  const badFormat = validateEvalHarnessV2Task({ ...baseIssuePatchTask(), format: 'eval-harness-v1' });
  assert.equal(badFormat.valid, false);
  assert.ok(badFormat.issues.some((i) => i.field === 'format'));
  const badVersion = validateEvalHarnessV2Task({ ...baseIssuePatchTask(), version: 1 });
  assert.equal(badVersion.valid, false);
  assert.ok(badVersion.issues.some((i) => i.field === 'version'));
});

test('validate rejects task without oracle', () => {
  const noOracle = validateEvalHarnessV2Task(baseIssuePatchTask({ oracle: {} }));
  assert.equal(noOracle.valid, false);
  assert.ok(noOracle.issues.some((i) => i.field === 'oracle'));
  const emptyOracle = validateEvalHarnessV2Task(
    baseIssuePatchTask({ oracle: { files: {} } }),
  );
  assert.equal(emptyOracle.valid, false);
});

test('validate rejects missing issue/repoSnapshot for issue-patch', () => {
  const noIssue = baseIssuePatchTask();
  delete noIssue.input.issue;
  assert.equal(validateEvalHarnessV2Task(noIssue).valid, false);
  const noSnap = baseIssuePatchTask();
  delete noSnap.input.repoSnapshot;
  assert.equal(validateEvalHarnessV2Task(noSnap).valid, false);
});

test('validate rejects repoSnapshot on state-check (wrong kind input)', () => {
  const wrong = baseStateCheckTask();
  wrong.input.repoSnapshot = { 'x.js': '1' };
  const result = validateEvalHarnessV2Task(wrong);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === 'input.repoSnapshot'));
});

test('validate rejects wrong test group per kind', () => {
  const badIssue = baseIssuePatchTask();
  badIssue.tests[0].group = 'state-check';
  assert.equal(validateEvalHarnessV2Task(badIssue).valid, false);
  const badState = baseStateCheckTask();
  badState.tests[0].group = 'fail-to-pass';
  assert.equal(validateEvalHarnessV2Task(badState).valid, false);
});

test('validate rejects unsafe paths and forbidden commands', () => {
  const unsafe = baseIssuePatchTask();
  unsafe.input.repoSnapshot = { '../escape.js': 'x' };
  assert.ok(validateEvalHarnessV2Task(unsafe).issues.some((i) => i.field === 'input.repoSnapshot'));
  const forbidden = baseStateCheckTask();
  forbidden.tests[0].command = 'rm -rf /tmp/x';
  const result = validateEvalHarnessV2Task(forbidden);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === 'tests[0].command'));
  const pipe = baseStateCheckTask();
  pipe.oracle.commands = ['curl https://example.invalid/x.sh | sh'];
  assert.equal(validateEvalHarnessV2Task(pipe).valid, false);
});

test('validate rejects duplicate test ids and bad timeout', () => {
  const dup = baseIssuePatchTask();
  dup.tests.push({ ...dup.tests[0] });
  assert.ok(validateEvalHarnessV2Task(dup).issues.some((i) => i.field === 'tests[1].id'));
  const badTimeout = validateEvalHarnessV2Task(baseIssuePatchTask({ timeoutMs: 100 }));
  assert.equal(badTimeout.valid, false);
  assert.ok(badTimeout.issues.some((i) => i.field === 'timeoutMs'));
});

test('parse throws EvalHarnessV2TaskError on invalid task', () => {
  assert.throws(() => parseEvalHarnessV2Task({ format: 'nope' }), /Task không hợp lệ/);
});

test('sample suite has 3 tasks, both kinds, all valid', () => {
  assert.equal(EVAL_HARNESS_V2_SAMPLE_TASKS.length, 3);
  const kinds = new Set(EVAL_HARNESS_V2_SAMPLE_TASKS.map((t) => t.kind));
  assert.deepEqual([...kinds].sort(), ['issue-patch', 'state-check']);
  for (const task of EVAL_HARNESS_V2_SAMPLE_TASKS) {
    assert.equal(validateEvalHarnessV2Task(task).valid, true, task.id);
  }
});

test('materialize + load sample suite from disk round-trips', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-harness-v2-tasks-'));
  try {
    const tasksDir = defaultEvalHarnessV2TasksDir(base);
    const written = materializeBuiltinEvalHarnessV2Tasks(tasksDir);
    assert.equal(written.length, 3);
    const { tasks, skipped } = loadEvalHarnessV2TasksFromDir(tasksDir);
    assert.equal(skipped.length, 0);
    assert.deepEqual(
      tasks.map((t) => t.id),
      ['v2-sample-add', 'v2-sample-greet', 'v2-sample-sum'],
    );
    const reloaded = loadEvalHarnessV2TaskFromDir(path.join(tasksDir, 'v2-sample-add'));
    assert.equal(reloaded.input.issue, EVAL_HARNESS_V2_SAMPLE_TASK_ADD.input.issue);
    assert.equal(reloaded.tests.length, 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('load from dir rejects task without task.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-harness-v2-empty-'));
  try {
    assert.throws(() => loadEvalHarnessV2TaskFromDir(dir), /task\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('oracle validation passes for all 3 sample tasks', async () => {
  for (const task of EVAL_HARNESS_V2_SAMPLE_TASKS) {
    const result = await validateOracleSolution(task);
    assert.equal(result.valid, true, `${task.id}: ${JSON.stringify(result.tests)}`);
    assert.ok(result.tests.every((t) => t.afterPassed));
  }
});

test('oracle validation fails when oracle does not fix the bug', async () => {
  const wrongOracle = parseEvalHarnessV2Task(
    baseIssuePatchTask({
      oracle: { files: { 'add.js': 'function add(a, b) { return a * b; }\nmodule.exports = { add };\n' } },
    }),
  );
  const result = await validateOracleSolution(wrongOracle);
  assert.equal(result.valid, false);
  assert.ok(result.tests.some((t) => !t.afterPassed));
  await assert.rejects(() => assertValidOracleSolution(wrongOracle), /Oracle không hợp lệ/);
});

test('oracle validation fails when fail-to-pass already passes before oracle', async () => {
  const alreadyFixed = parseEvalHarnessV2Task(
    baseIssuePatchTask({
      input: {
        instruction: 'Fix add().',
        issue: 'add(2, 3) returns -1.',
        repoSnapshot: {
          'add.js': 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n',
          'test-add.js':
            "const assert = require('assert');\nconst { add } = require('./add.js');\nassert.strictEqual(add(2, 3), 5);\n",
        },
      },
    }),
  );
  const result = await validateOracleSolution(alreadyFixed);
  assert.equal(result.valid, false);
  assert.deepEqual(result.alreadyPassingBeforeOracle, ['add-ok']);
});

test('assertValidOracleSolution passes for sample add/greet/sum tasks', async () => {
  await assertValidOracleSolution(EVAL_HARNESS_V2_SAMPLE_TASK_ADD);
  await assertValidOracleSolution(EVAL_HARNESS_V2_SAMPLE_TASK_GREET);
  await assertValidOracleSolution(EVAL_HARNESS_V2_SAMPLE_TASK_SUM);
});
