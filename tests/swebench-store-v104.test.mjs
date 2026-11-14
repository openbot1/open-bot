/**
 * Tests for the SWE-bench task store (packages/core/src/observability/sweBenchStore.ts).
 *
 * Covers create/get/list/update/remove round-trips, duplicate-id and
 * validation rejections, corrupt-file handling, and running a stored
 * task through the real SWE-bench runner (store + runner compose).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/swebench-store-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createSweTask,
  getSweTask,
  listSweTasks,
  loadSweTasks,
  removeSweTask,
  updateSweTask,
  validateCreateSweTaskInput,
} from '../packages/core/dist/observability/sweBenchStore.js';
import { runSweBenchTask } from '../packages/core/dist/observability/sweBenchEval.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-swe-store-'));
}

const BUGGY_CALC = 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n';
const FIXED_CALC = 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n';
const TEST_JS = "const { add } = require('./calc.js');\nif (add(2, 3) !== 5) process.exit(1);\n";

function taskInput(overrides = {}) {
  return {
    id: 'swe-add-001',
    title: 'Fix add()',
    problemStatement: 'add(2, 3) should return 5.',
    setupFiles: { 'calc.js': BUGGY_CALC, 'test.js': TEST_JS },
    failToPass: [{ name: 'test-add', argv: ['node', 'test.js'] }],
    passToPass: [],
    ...overrides,
  };
}

test('swe-bench store: validateCreateSweTaskInput rejects bad input', () => {
  assert.throws(() => validateCreateSweTaskInput({}), /title/);
  assert.throws(() => validateCreateSweTaskInput(taskInput({ failToPass: [] })), /at least one failToPass/);
  assert.throws(() => validateCreateSweTaskInput(taskInput({ setupFiles: { '../x.js': 'y' } })), /relative path/);
});

test('swe-bench store: create / get / list / update / remove round-trip', () => {
  const dir = tmpDir();
  assert.deepEqual(loadSweTasks(dir), []);
  const created = createSweTask(dir, taskInput());
  assert.equal(created.id, 'swe-add-001');
  assert.equal(created.passToPass.length, 0);
  assert.ok(created.createdAt);
  assert.equal(created.updatedAt, created.createdAt);
  assert.equal(getSweTask(dir, 'swe-add-001')?.title, 'Fix add()');
  assert.equal(getSweTask(dir, 'nope'), null);
  assert.equal(listSweTasks(dir).length, 1);
  // Duplicate id rejected.
  assert.throws(() => createSweTask(dir, taskInput()), /already exists/);
  // Auto id when not given.
  const auto = createSweTask(dir, taskInput({ id: undefined, title: 'Second task' }));
  assert.ok(auto.id.startsWith('swe-'));
  assert.equal(listSweTasks(dir).length, 2);
  // Update title + failToPass; id and createdAt stay.
  const updated = updateSweTask(dir, 'swe-add-001', { title: 'Fix add() v2' });
  assert.equal(updated.title, 'Fix add() v2');
  assert.equal(updated.id, 'swe-add-001');
  assert.equal(updated.createdAt, created.createdAt);
  assert.notEqual(updated.updatedAt, created.updatedAt);
  assert.throws(() => updateSweTask(dir, 'nope', { title: 'x' }), /does not exist/);
  assert.throws(() => updateSweTask(dir, 'swe-add-001', { failToPass: [] }), /at least one failToPass/);
  const removed = removeSweTask(dir, 'swe-add-001');
  assert.equal(removed.id, 'swe-add-001');
  assert.equal(listSweTasks(dir).length, 1);
  assert.throws(() => removeSweTask(dir, 'swe-add-001'), /does not exist/);
});

test('swe-bench store: corrupt file throws instead of guessing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'swe-tasks.json'), '[{bad', 'utf8');
  assert.throws(() => loadSweTasks(dir), /not valid JSON/);
  fs.writeFileSync(path.join(dir, 'swe-tasks.json'), '{"a":1}', 'utf8');
  assert.throws(() => loadSweTasks(dir), /JSON array/);
});

test('swe-bench store: stored task runs through the real runner and resolves', async () => {
  const dir = tmpDir();
  const stored = createSweTask(dir, taskInput());
  const result = await runSweBenchTask(stored, async (workspaceDir) => {
    fs.writeFileSync(path.join(workspaceDir, 'calc.js'), FIXED_CALC, 'utf8');
  }, { workspacesDir: tmpDir() });
  assert.equal(result.status, 'resolved');
  assert.equal(result.taskId, stored.id);
});
