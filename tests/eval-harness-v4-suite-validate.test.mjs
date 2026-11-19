/**
 * Tests for Eval Harness v4 suites + validate + latest pointer
 * (v1.44, Đội T2): `packages/core/src/evalHarnessV4/suite.ts`,
 * `validate` CLI command, `latest.json` in `history.ts`.
 *
 * Covers: suite presets (ids, apply merges selection/thresholds
 * without mutating the base config, unknown suite returns null),
 * --suite via CLI (smoke selects 4 tasks, coding selects coding
 * tasks, unknown suite is an exit-2 config error), validate
 * command (valid builtin id, missing id, task dir on disk, empty
 * target), latest pointer (append writes latest.json, read
 * returns the newest run, missing history returns undefined).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-harness-v4-suite-validate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultEvalHarnessV4Config } from '../packages/core/dist/evalHarnessV4/config.js';
import {
  applyEvalHarnessV4Suite,
  formatEvalHarnessV4Suites,
  getEvalHarnessV4Suite,
  listEvalHarnessV4SuiteIds,
} from '../packages/core/dist/evalHarnessV4/suite.js';
import {
  appendEvalHarnessV4RunRecord,
  readEvalHarnessV4LatestRunId,
} from '../packages/core/dist/evalHarnessV4/history.js';
import {
  executeEvalHarnessV4Command,
  parseEvalHarnessV4CliArgs,
} from '../packages/core/dist/evalHarnessV4/cli.js';
import { materializeBuiltinEvalHarnessV4Task } from '../packages/core/dist/evalHarnessV4/builtinTasks.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-v4-suite-'));
}

test('suites: ids stable, get/apply, unknown returns null, base not mutated', () => {
  assert.deepEqual(listEvalHarnessV4SuiteIds(), ['smoke', 'nightly', 'full', 'coding']);
  assert.equal(getEvalHarnessV4Suite('smoke')?.name, 'Smoke');
  assert.equal(getEvalHarnessV4Suite('nope'), undefined);
  const base = defaultEvalHarnessV4Config();
  const { config, suite } = applyEvalHarnessV4Suite(base, 'smoke');
  assert.ok(suite);
  assert.equal(suite.id, 'smoke');
  assert.deepEqual(config.selection.includeIds, ['hello-file', 'sum-csv', 'fix-import', 'sort-lines']);
  assert.equal(config.repeats, 1);
  assert.equal(config.name, 'smoke');
  // Base không bị mutate.
  assert.deepEqual(base.selection.includeIds, []);
  assert.equal(base.name, 'default');
  const full = applyEvalHarnessV4Suite(base, 'full');
  assert.equal(full.config.repeats, 3);
  assert.equal(full.config.thresholds.minPassRate, 0.9);
  assert.equal(full.config.thresholds.maxRegressionDrop, 0.05); // field khác giữ nguyên
  const coding = applyEvalHarnessV4Suite(base, 'coding');
  assert.deepEqual(coding.config.selection.kinds, ['coding']);
  const unknown = applyEvalHarnessV4Suite(base, 'nope');
  assert.equal(unknown.suite, null);
  assert.equal(unknown.config, base);
  assert.ok(formatEvalHarnessV4Suites().includes('smoke —'));
});

test('CLI --suite: smoke selects 4 tasks, coding selects coding tasks, unknown is exit 2', async () => {
  const baseDir = tmpDir();
  const cwd = tmpDir();
  const ctx = { baseDir, cwd };
  const smoke = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['list', '--suite', 'smoke']), ctx);
  assert.equal(smoke.exitCode, 0, smoke.stdout);
  assert.equal(smoke.json.total, 4);
  assert.deepEqual(smoke.json.tasks.map((t) => t.id).sort(), ['fix-import', 'hello-file', 'sort-lines', 'sum-csv']);
  const coding = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['list', '--suite', 'coding']), ctx);
  assert.equal(coding.exitCode, 0);
  assert.equal(coding.json.total, 5);
  assert.ok(coding.json.tasks.every((t) => t.kind === 'coding'));
  const nightly = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['config', '--suite', 'nightly', '--json']), ctx);
  assert.equal(nightly.exitCode, 0);
  assert.equal(nightly.json.repeats, 2);
  const unknown = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['list', '--suite', 'nope']), ctx);
  assert.equal(unknown.exitCode, 2);
  assert.ok(unknown.stdout.includes('Không có suite'));
  // Cờ CLI thắng preset: --suite smoke + --repeats 3.
  const overridden = await executeEvalHarnessV4Command(
    parseEvalHarnessV4CliArgs(['config', '--suite', 'smoke', '--repeats', '3', '--json']),
    ctx,
  );
  assert.equal(overridden.exitCode, 0);
  assert.equal(overridden.json.repeats, 3);
  assert.deepEqual(overridden.json.selection.includeIds, ['hello-file', 'sum-csv', 'fix-import', 'sort-lines']);
});

test('CLI validate: valid id, missing id, task dir, empty target', async () => {
  const baseDir = tmpDir();
  const cwd = tmpDir();
  const ctx = { baseDir, cwd };
  const ok = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['validate', 'config-fix']), ctx);
  assert.equal(ok.exitCode, 0, ok.stdout);
  assert.ok(ok.stdout.includes('hợp lệ'));
  assert.equal(ok.json.valid, true);
  const missing = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['validate', 'no-such-task']), ctx);
  assert.equal(missing.exitCode, 1);
  assert.ok(missing.stdout.includes('Không có task'));
  const empty = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['validate']), ctx);
  assert.equal(empty.exitCode, 2);
  // Task dir trên đĩa: materialize rồi validate bằng đường dẫn.
  const taskDir = materializeBuiltinEvalHarnessV4Task('log-grep', tmpDir());
  const byDir = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['validate', taskDir]), ctx);
  assert.equal(byDir.exitCode, 0, byDir.stdout);
  assert.equal(byDir.json.taskId, 'log-grep');
  // Thư mục task hỏng: thiếu test.sh.
  const badDir = path.join(tmpDir(), 'broken-task');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'task.json'), JSON.stringify({ id: 'broken-task' }), 'utf-8');
  const bad = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['validate', badDir]), ctx);
  assert.equal(bad.exitCode, 1);
  assert.ok(bad.stdout.includes('không hợp lệ'));
});

test('latest pointer: append writes latest.json, read returns newest', async () => {
  const historyDir = path.join(tmpDir(), 'eval-harness-v4');
  assert.equal(readEvalHarnessV4LatestRunId(historyDir), undefined);
  const { defaultEvalHarnessV4Config: defConfig } = await import('../packages/core/dist/evalHarnessV4/config.js');
  const makeRecord = (runId, startedAt) => ({
    format: 'eval-harness-v4',
    runId,
    configName: 'test',
    startedAt,
    finishedAt: startedAt + 100,
    durationMs: 100,
    configSnapshot: defConfig(),
    tasks: [],
    skipped: [],
    passed: 0,
    failed: 0,
    total: 0,
    passRate: 0,
    meanReward: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    flakyTasks: 0,
    isolationModes: [],
    note: '',
  });
  appendEvalHarnessV4RunRecord(historyDir, makeRecord('v4-r1', 1000));
  assert.equal(readEvalHarnessV4LatestRunId(historyDir)?.runId, 'v4-r1');
  appendEvalHarnessV4RunRecord(historyDir, makeRecord('v4-r2', 2000));
  assert.equal(readEvalHarnessV4LatestRunId(historyDir)?.runId, 'v4-r2');
  assert.ok(fs.existsSync(path.join(historyDir, 'latest.json')));
});
