/**
 * Tests for Eval Harness v4 config + task set (v1.44, Đội T2):
 * `packages/core/src/evalHarnessV4/config.ts` + `taskSet.ts`.
 *
 * Covers: defaults, parse (valid + each invalid field), config
 * file load (missing file / bad JSON), CLI overrides (valid +
 * invalid), glob matching, selection filtering (include/exclude,
 * tags, kinds, globs), task collection from builtin + builtin-v4
 * + disk dirs (disk overrides builtin, missing dir skipped with
 * reason), task set resolution + description.
 *
 * Pure + disk reads only — no sandbox, no model.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-harness-v4-config-taskset.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyEvalHarnessV4CliOverrides,
  defaultEvalHarnessV4Config,
  defaultEvalHarnessV4Selection,
  defaultEvalHarnessV4Thresholds,
  findEvalHarnessV4ConfigFile,
  loadEvalHarnessV4ConfigFile,
  parseEvalHarnessV4Config,
  sampleEvalHarnessV4Config,
  serializeEvalHarnessV4Config,
} from '../packages/core/dist/evalHarnessV4/config.js';
import {
  BUILTIN_EVAL_HARNESS_V4_TASK_IDS,
  builtinEvalHarnessV4Tasks,
} from '../packages/core/dist/evalHarnessV4/builtinTasks.js';
import {
  collectEvalHarnessV4Tasks,
  describeEvalHarnessV4TaskSet,
  filterHarborTasksBySelection,
  loadEvalHarnessV4ResolvedTasks,
  matchEvalHarnessV4Glob,
  resolveEvalHarnessV4TaskSet,
} from '../packages/core/dist/evalHarnessV4/taskSet.js';
import { builtinHarborTasks } from '../packages/core/dist/eval/harborLibrary.js';
import { writeHarborTaskToDir } from '../packages/core/dist/eval/harborTask.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-v4-config-'));
}

test('defaults: 8 builtin tasks total, repeats 1, thresholds in [0,1]', () => {
  const config = defaultEvalHarnessV4Config();
  assert.equal(config.version, 4);
  assert.equal(config.repeats, 1);
  assert.equal(config.testTimeoutMs, 60_000);
  assert.equal(config.taskTimeoutMs, null);
  assert.equal(config.includeBuiltin, true);
  assert.equal(config.includeBuiltinV4, true);
  assert.equal(config.failOnRegression, true);
  assert.equal(builtinHarborTasks().length, 4);
  assert.equal(builtinEvalHarnessV4Tasks().length, 8);
  assert.deepEqual([...BUILTIN_EVAL_HARNESS_V4_TASK_IDS], ['json-transform', 'sort-lines', 'fix-import', 'readme-headings', 'word-count', 'log-grep', 'config-fix', 'changelog-entry']);
  const thresholds = defaultEvalHarnessV4Thresholds();
  assert.equal(thresholds.minReward, 1);
  assert.equal(thresholds.maxRegressionDrop, 0.05);
  assert.equal(thresholds.minPassRate, 0.8);
  assert.deepEqual(defaultEvalHarnessV4Selection(), {
    includeIds: [], excludeIds: [], tags: [], kinds: [], includeGlobs: [], excludeGlobs: [],
  });
});

test('parse: empty object is valid and fills defaults', () => {
  const { config, validation } = parseEvalHarnessV4Config({});
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.issues, []);
  assert.equal(config.name, 'default');
  assert.equal(config.repeats, 1);
});

test('parse: full valid config round-trips through serialize', () => {
  const { config, validation } = parseEvalHarnessV4Config({
    version: 4,
    name: 'nightly',
    taskDirs: ['./eval-tasks'],
    includeBuiltin: false,
    repeats: 3,
    taskTimeoutMs: 120_000,
    testTimeoutMs: 30_000,
    profileId: 'coding',
    model: { provider: 'ollama', model: 'llama3' },
    selection: { tags: ['coding'], excludeIds: ['fix-add'] },
    thresholds: { maxRegressionDrop: 0.1, minPassRate: 0.9, alwaysFailingRuns: 2 },
    history: { maxRuns: 50, maxAgeDays: 30 },
    output: { formats: ['markdown', 'html'] },
    baselineRunId: 'v4-abc',
    failOnRegression: false,
    sandbox: { mode: 'plain', keepWorkspace: true },
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(config.name, 'nightly');
  assert.equal(config.repeats, 3);
  assert.equal(config.thresholds.maxRegressionDrop, 0.1);
  assert.equal(config.thresholds.alwaysFailingRuns, 2);
  assert.equal(config.output.formats.length, 2);
  const reparsed = parseEvalHarnessV4Config(JSON.parse(serializeEvalHarnessV4Config(config)));
  assert.equal(reparsed.validation.valid, true);
  assert.equal(reparsed.config.name, 'nightly');
  assert.equal(reparsed.config.repeats, 3);
});

test('parse: every invalid field is reported, not thrown', () => {
  const { validation } = parseEvalHarnessV4Config({
    version: 3,
    name: '',
    taskDirs: 'not-an-array',
    includeBuiltin: 'yes',
    repeats: 0,
    taskTimeoutMs: 100,
    testTimeoutMs: 99999999,
    selection: { kinds: ['nope'], tags: [42] },
    thresholds: { minReward: 1.5, maxRegressionDrop: -1, alwaysFailingRuns: 0 },
    history: { maxRuns: -1 },
    output: { formats: ['pdf'] },
    sandbox: { mode: 'docker' },
    model: { provider: 1 },
  });
  assert.equal(validation.valid, false);
  const fields = validation.issues.map((i) => i.field);
  for (const expected of [
    'version', 'name', 'taskDirs', 'includeBuiltin', 'repeats', 'taskTimeoutMs',
    'testTimeoutMs', 'selection.kinds', 'selection.tags', 'thresholds.minReward',
    'thresholds.maxRegressionDrop', 'thresholds.alwaysFailingRuns',
    'history.maxRuns', 'output.formats', 'sandbox.mode', 'model',
  ]) {
    assert.ok(fields.includes(expected), `missing issue for ${expected} (got ${fields.join(', ')})`);
  }
});

test('parse: non-object config is invalid', () => {
  for (const bad of [null, 'x', 42, [1, 2]]) {
    const { validation } = parseEvalHarnessV4Config(bad);
    assert.equal(validation.valid, false);
  }
});

test('config file: load valid file, missing file throws, bad JSON throws', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'eval.config.json');
  fs.writeFileSync(file, JSON.stringify({ version: 4, name: 'file-test', repeats: 2 }), 'utf-8');
  const loaded = loadEvalHarnessV4ConfigFile(file);
  assert.equal(loaded.validation.valid, true);
  assert.equal(loaded.config.name, 'file-test');
  assert.equal(loaded.config.repeats, 2);
  assert.throws(() => loadEvalHarnessV4ConfigFile(path.join(dir, 'missing.json')), /Không đọc được config/);
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, '{not json', 'utf-8');
  assert.throws(() => loadEvalHarnessV4ConfigFile(badFile), /JSON lỗi/);
  // Thư mục trống (không có eval.config.json) thì find trả null.
  assert.equal(findEvalHarnessV4ConfigFile(undefined, tmpDir()), null);
  assert.equal(findEvalHarnessV4ConfigFile('eval.config.json', dir), file);
});

test('sample config is valid', () => {
  const { validation } = parseEvalHarnessV4Config(JSON.parse(serializeEvalHarnessV4Config(sampleEvalHarnessV4Config())));
  assert.equal(validation.valid, true);
});

test('CLI overrides: valid overrides apply, invalid ones are issues', () => {
  const base = defaultEvalHarnessV4Config();
  const { config, issues } = applyEvalHarnessV4CliOverrides(base, {
    repeats: 2,
    taskTimeoutMs: 90_000,
    includeIds: ['sum-csv'],
    tags: ['python'],
    baselineRunId: 'v4-x',
    failOnRegression: false,
  });
  assert.deepEqual(issues, []);
  assert.equal(config.repeats, 2);
  assert.equal(config.taskTimeoutMs, 90_000);
  assert.deepEqual(config.selection.includeIds, ['sum-csv']);
  assert.equal(config.baselineRunId, 'v4-x');
  assert.equal(config.failOnRegression, false);
  // Base không bị mutate.
  assert.equal(base.repeats, 1);
  const bad = applyEvalHarnessV4CliOverrides(base, { repeats: 0, kinds: ['nope'] });
  assert.equal(bad.issues.length, 2);
  assert.equal(bad.config.repeats, 1);
});

test('glob matching: * and ? only', () => {
  assert.equal(matchEvalHarnessV4Glob('fix-*', 'fix-add'), true);
  assert.equal(matchEvalHarnessV4Glob('fix-*', 'fix-import'), true);
  assert.equal(matchEvalHarnessV4Glob('fix-*', 'sum-csv'), false);
  assert.equal(matchEvalHarnessV4Glob('*-csv', 'sum-csv'), true);
  assert.equal(matchEvalHarnessV4Glob('sum-cs?', 'sum-csv'), true);
  assert.equal(matchEvalHarnessV4Glob('sum-cs?', 'sum-csvv'), false);
  assert.equal(matchEvalHarnessV4Glob('*', 'anything'), true);
  assert.equal(matchEvalHarnessV4Glob('', 'anything'), false);
  assert.equal(matchEvalHarnessV4Glob('fix-add', 'fix-add'), true);
  assert.equal(matchEvalHarnessV4Glob('fix.add', 'fix-add'), false);
});

test('selection filter: include, tags, kinds, globs, exclude (in order)', () => {
  const tasks = [...builtinHarborTasks(), ...builtinEvalHarnessV4Tasks()];
  const base = defaultEvalHarnessV4Selection();
  assert.equal(filterHarborTasksBySelection(tasks, base).kept.length, 12);
  assert.equal(filterHarborTasksBySelection(tasks, { ...base, tags: ['python'] }).kept.length, 3);
  assert.deepEqual(
    filterHarborTasksBySelection(tasks, { ...base, tags: ['python'] }).kept.map((t) => t.meta.id).sort(),
    ['fix-add', 'fix-import', 'sum-csv'],
  );
  assert.equal(filterHarborTasksBySelection(tasks, { ...base, kinds: ['writing'] }).kept.length, 3);
  assert.equal(filterHarborTasksBySelection(tasks, { ...base, includeGlobs: ['fix-*'] }).kept.length, 2);
  assert.equal(
    filterHarborTasksBySelection(tasks, { ...base, includeIds: ['sum-csv', 'json-transform'] }).kept.length,
    2,
  );
  assert.equal(
    filterHarborTasksBySelection(tasks, { ...base, excludeIds: ['sum-csv'] }).kept.length,
    11,
  );
  assert.equal(
    filterHarborTasksBySelection(tasks, { ...base, excludeGlobs: ['*-csv', 'hello-*'] }).kept.length,
    10,
  );
  // Exclude thắng include.
  assert.equal(
    filterHarborTasksBySelection(tasks, { ...base, includeIds: ['sum-csv'], excludeIds: ['sum-csv'] }).kept.length,
    0,
  );
  const { excluded } = filterHarborTasksBySelection(tasks, { ...base, tags: ['python'] });
  assert.equal(excluded.length, 9);
  assert.ok(excluded.every((e) => e.reason.length > 0));
});

test('collect: builtin + builtin-v4 + disk dir, disk overrides builtin, missing dir skipped', () => {
  const dir = tmpDir();
  const tasksDir = path.join(dir, 'my-tasks');
  const override = builtinHarborTasks()[0];
  const custom = {
    ...override,
    meta: { ...override.meta, name: 'Hello file (custom)', version: 2 },
  };
  writeHarborTaskToDir(custom, path.join(tasksDir, 'hello-file'));
  const config = { ...defaultEvalHarnessV4Config(), taskDirs: [tasksDir, path.join(dir, 'missing-dir')] };
  const { tasks, skipped } = collectEvalHarnessV4Tasks(config);
  assert.equal(tasks.length, 12);
  assert.equal(tasks.find((t) => t.meta.id === 'hello-file')?.meta.name, 'Hello file (custom)');
  assert.equal(tasks.find((t) => t.meta.id === 'hello-file')?.meta.version, 2);
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0].reason.includes('không tồn tại'));
});

test('resolve task set: excludes by selection and reports skipped', () => {
  const config = { ...defaultEvalHarnessV4Config() };
  config.selection = { ...defaultEvalHarnessV4Selection(), kinds: ['coding'] };
  const taskSet = resolveEvalHarnessV4TaskSet(config);
  assert.equal(taskSet.tasks.length, 5);
  assert.deepEqual(taskSet.tasks.map((t) => t.taskId).sort(), ['config-fix', 'fix-add', 'fix-import', 'json-transform', 'sum-csv']);
  assert.equal(taskSet.totalAvailable, 12);
  assert.equal(taskSet.skipped.length, 7);
  const byId = new Map(taskSet.tasks.map((t) => [t.taskId, t.source]));
  assert.equal(byId.get('fix-import'), 'builtin-v4');
  assert.equal(byId.get('fix-add'), 'builtin');
  const loaded = loadEvalHarnessV4ResolvedTasks(taskSet, config);
  assert.equal(loaded.tasks.length, 5);
  assert.deepEqual(loaded.skipped, []);
  const summary = describeEvalHarnessV4TaskSet(taskSet, loaded.tasks);
  assert.equal(summary.total, 5);
  assert.equal(summary.byKind.coding, 5);
  assert.equal(summary.bySource['builtin-v4'], 3);
  assert.ok(summary.tags.includes('python'));
});
