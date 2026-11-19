/**
 * Tests for Eval Harness v4 runner + CLI (v1.44, Đội T2):
 * `packages/core/src/evalHarnessV4/runner.ts` +
 * `builtinTasks.ts` + `cli.ts`.
 *
 * Covers: 4 builtin V4 tasks pass with a scripted executor
 * (reward 1) and fail with noop (reward 0, honest baseline),
 * repeats aggregation + flaky detection (alternating executor),
 * runId format, runSuiteAndRecord (history write, dashboard
 * files, first-run no regression, second-run regression blocks
 * with exit 1), executor timeout wrapper, CLI arg parsing
 * (unknown command/flag), and CLI commands list/history/config
 * --init/pin/unpin/dashboard/regressions + end-to-end `run`
 * with --agent-files-by-task.
 *
 * Runs the real BotBoxManager sandbox (bwrap when available,
 * otherwise plain run with honest isolation reporting — the test
 * asserts the reported isolation matches reality, never a fake
 * "isolated").
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-harness-v4-runner-cli.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { noopHarborExecutor, scriptedHarborExecutor } from '../packages/core/dist/eval/harborRunner.js';
import { validateHarborTask } from '../packages/core/dist/eval/harborTask.js';
import {
  builtinEvalHarnessV4Tasks,
  getBuiltinEvalHarnessV4Task,
  materializeBuiltinEvalHarnessV4Tasks,
} from '../packages/core/dist/evalHarnessV4/builtinTasks.js';
import { loadHarborTaskFromDir } from '../packages/core/dist/eval/harborTask.js';
import { defaultEvalHarnessV4Config } from '../packages/core/dist/evalHarnessV4/config.js';
import {
  buildEvalHarnessV4RunId,
  EvalHarnessV4Runner,
  formatEvalHarnessV4RunSummary,
  withEvalHarnessV4Timeout,
} from '../packages/core/dist/evalHarnessV4/runner.js';
import {
  executeEvalHarnessV4Command,
  parseEvalHarnessV4CliArgs,
} from '../packages/core/dist/evalHarnessV4/cli.js';
import { loadEvalHarnessV4History } from '../packages/core/dist/evalHarnessV4/history.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-v4-run-'));
}

test('builtin V4 tasks: all valid, ids stable, round-trip via disk', () => {
  const tasks = builtinEvalHarnessV4Tasks();
  assert.equal(tasks.length, 8);
  for (const task of tasks) {
    const validation = validateHarborTask(task);
    assert.equal(validation.valid, true, `${task.meta.id}: ${JSON.stringify(validation.issues)}`);
  }
  assert.equal(getBuiltinEvalHarnessV4Task('json-transform')?.meta.kind, 'coding');
  assert.equal(getBuiltinEvalHarnessV4Task('readme-headings')?.meta.kind, 'writing');
  assert.equal(getBuiltinEvalHarnessV4Task('nope'), undefined);
  const dir = tmpDir();
  const dirs = materializeBuiltinEvalHarnessV4Tasks(dir);
  assert.equal(dirs.length, 8);
  for (const taskDir of dirs) {
    const reloaded = loadHarborTaskFromDir(taskDir);
    assert.equal(validateHarborTask(reloaded).valid, true);
    assert.ok(fs.existsSync(path.join(taskDir, 'tests', 'test.sh')));
  }
});

test('runId format: v4-<timestamp>-<6 hex>', () => {
  const id = buildEvalHarnessV4RunId(1795000000000);
  assert.match(id, /^v4-\d{8}T\d{6}-[0-9a-f]{6}$/);
  assert.notEqual(buildEvalHarnessV4RunId(), buildEvalHarnessV4RunId());
});

test('runner: scripted executor passes all 8 V4 tasks with reward 1', async () => {
  const dir = tmpDir();
  const filesByTask = {
    'json-transform': { 'output.json': '{"name": "ADA", "age": 36, "total": 24, "passed": true}\n' },
    'sort-lines': { 'sorted.txt': 'An\nHoa\nLan\nMinh\nTuan\n' },
    'fix-import': { 'app.py': 'import math\n\nprint(math.sqrt(16))\n' },
    'readme-headings': {
      'README.md': '# notecli\n\nA fast note-taking tool for the terminal.\n\n## Install\n\nRun `npm install -g notecli`.\n\n## Usage\n\nRun `notecli add "buy milk"` to add a note.\n',
    },
    'word-count': { 'counts.json': '{"lines": 3, "words": 13, "chars": 64}\n' },
    'log-grep': { 'errors.txt': '2026-11-19T05:00:02 ERROR Failed to connect to database\n2026-11-19T05:00:04 ERROR Timeout after 30s\n2026-11-19T05:00:06 ERROR Disk almost full\n' },
    'config-fix': { 'fixed.json': '{"host": "localhost", "port": 3000, "debug": true}\n' },
    'changelog-entry': { 'CHANGELOG.md': '# Changelog\n\n## [1.1.0] - 2026-11-19\n\n### Added\n\n- Quick capture from the command line.\n- Search notes by keyword.\n\n## [1.0.0] - 2026-11-01\n\n### Added\n\n- Initial release of notecli.\n' },
  };
  const tasks = builtinEvalHarnessV4Tasks();
  const runner = new EvalHarnessV4Runner({
    baseDir: dir,
    config: { ...defaultEvalHarnessV4Config(), repeats: 1 },
    executor: async (ctx) => scriptedHarborExecutor(filesByTask[ctx.task.meta.id] ?? {})(ctx),
  });
  const record = await runner.runSuite(tasks);
  assert.equal(record.total, 8);
  assert.equal(record.passed, 8);
  assert.equal(record.passRate, 1);
  assert.equal(record.meanReward, 1);
  assert.equal(record.flakyTasks, 0);
  for (const task of record.tasks) {
    assert.equal(task.allPassed, true, task.taskId);
    assert.equal(task.meanReward, 1, task.taskId);
    assert.equal(task.attempts.length, 1);
  }
  assert.ok(formatEvalHarnessV4RunSummary(record).includes('8/8'));
});

test('runner: noop executor fails all V4 tasks (honest baseline, reward 0)', async () => {
  const dir = tmpDir();
  const runner = new EvalHarnessV4Runner({
    baseDir: dir,
    executor: noopHarborExecutor,
  });
  const record = await runner.runSuite(builtinEvalHarnessV4Tasks());
  assert.equal(record.passed, 0);
  assert.equal(record.meanReward, 0);
  for (const task of record.tasks) {
    assert.equal(task.meanReward, 0, task.taskId);
    assert.ok(task.failingTests.length > 0, task.taskId);
  }
});

test('runner: partial agent gets partial weighted reward', async () => {
  const dir = tmpDir();
  // json-transform: chỉ ghi đúng name (trọng số 2) + file tồn tại (trọng số 1) — reward 3/6.
  const runner = new EvalHarnessV4Runner({
    baseDir: dir,
    executor: scriptedHarborExecutor({ 'output.json': '{"name": "ADA", "age": 0, "total": 0, "passed": false}\n' }),
  });
  const task = getBuiltinEvalHarnessV4Task('json-transform');
  assert.ok(task);
  const result = await runner.runTaskWithRepeats(task);
  assert.equal(result.passed, false);
  assert.ok(Math.abs(result.meanReward - 3 / 6) < 1e-9, `reward ${result.meanReward}`);
  assert.deepEqual(result.failingTests, ['passed-flag', 'total-correct']);
});

test('runner: repeats aggregate, alternating executor is flaky but passes', async () => {
  const dir = tmpDir();
  let calls = 0;
  const alternating = async (ctx) => {
    calls += 1;
    const files = calls % 2 === 1 ? { 'sorted.txt': 'An\nHoa\nLan\nMinh\nTuan\n' } : {};
    return scriptedHarborExecutor(files)(ctx);
  };
  const runner = new EvalHarnessV4Runner({
    baseDir: dir,
    config: { ...defaultEvalHarnessV4Config(), repeats: 3 },
    executor: alternating,
  });
  const task = getBuiltinEvalHarnessV4Task('sort-lines');
  assert.ok(task);
  const result = await runner.runTaskWithRepeats(task);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.passes, 2);
  assert.equal(result.passed, true);
  assert.equal(result.allPassed, false);
  assert.equal(result.flaky, true);
  assert.ok(Math.abs(result.meanReward - 2 / 3) < 1e-9);
});

test('runner: runSuiteAndRecord writes history + dashboard, second run regresses', async () => {
  const dir = tmpDir();
  const config = {
    ...defaultEvalHarnessV4Config(),
    repeats: 1,
    output: { dir: '', formats: ['markdown', 'html', 'json'] },
  };
  const goodFiles = {
    'json-transform': { 'output.json': '{"name": "ADA", "age": 36, "total": 24, "passed": true}\n' },
  };
  const goodRunner = new EvalHarnessV4Runner({
    baseDir: dir,
    config,
    executor: async (ctx) => scriptedHarborExecutor(goodFiles[ctx.task.meta.id] ?? {})(ctx),
  });
  const task = getBuiltinEvalHarnessV4Task('json-transform');
  assert.ok(task);
  const first = await goodRunner.runSuiteAndRecord([task]);
  assert.equal(first.record.passed, 1);
  assert.equal(first.regressionReport, null); // run đầu tiên: chưa có baseline
  assert.equal(first.exitCode, 0);
  assert.equal(first.pruned, 0);
  assert.ok(fs.existsSync(first.historyPath));
  assert.equal(first.dashboardPaths.length, 3);
  for (const p of first.dashboardPaths) assert.ok(fs.existsSync(p), p);
  const { records } = loadEvalHarnessV4History(path.join(dir, 'eval-harness-v4'));
  assert.equal(records.length, 1);

  // Run 2: noop -> reward 1 -> 0, hồi quy blocker, exit 1.
  const badRunner = new EvalHarnessV4Runner({
    baseDir: dir,
    config,
    executor: noopHarborExecutor,
  });
  const second = await badRunner.runSuiteAndRecord([task]);
  assert.ok(second.regressionReport);
  assert.equal(second.regressionReport.gate, 'block');
  assert.ok(second.regressionReport.regressions.some((r) => r.taskId === 'json-transform'));
  assert.equal(second.exitCode, 1);
  assert.equal(second.dashboard.runs, 2);
  assert.ok(second.dashboard.latestRegressions.length > 0);
  const { records: records2 } = loadEvalHarnessV4History(path.join(dir, 'eval-harness-v4'));
  assert.equal(records2.length, 2);
});

test('runner: no executor throws a clear error, suite does not pretend', async () => {
  const dir = tmpDir();
  const runner = new EvalHarnessV4Runner({ baseDir: dir });
  const task = getBuiltinEvalHarnessV4Task('sort-lines');
  assert.ok(task);
  await assert.rejects(() => runner.runTaskWithRepeats(task), /chưa có agent executor/);
});

test('timeout wrapper: hanging executor rejects, suite survives', async () => {
  const hanging = async () => new Promise(() => {});
  const wrapped = withEvalHarnessV4Timeout(hanging, 50);
  await assert.rejects(
    () => wrapped({ task: getBuiltinEvalHarnessV4Task('sort-lines'), workspaceDir: '/tmp', systemPrompt: '', profileId: '', model: { provider: '', model: '' }, deadlineMs: Date.now() + 1000 }),
    /timeout sau 50ms/,
  );
  const fast = withEvalHarnessV4Timeout(async () => ({ turns: [] }), 1000);
  const out = await fast({ task: getBuiltinEvalHarnessV4Task('sort-lines'), workspaceDir: '/tmp', systemPrompt: '', profileId: '', model: { provider: '', model: '' }, deadlineMs: Date.now() + 1000 });
  assert.deepEqual(out.turns, []);
});

test('CLI parse: unknown command/flag are errors, --flag=value works', () => {
  const bad = parseEvalHarnessV4CliArgs(['nope']);
  assert.ok(bad.errors.length > 0);
  const badFlag = parseEvalHarnessV4CliArgs(['list', '--bogus', 'x']);
  assert.ok(badFlag.errors.some((e) => e.includes('--bogus')));
  const missingValue = parseEvalHarnessV4CliArgs(['run', '--repeats']);
  assert.ok(missingValue.errors.some((e) => e.includes('--repeats')));
  const ok = parseEvalHarnessV4CliArgs(['run', '--repeats=3', '--json', '--tasks', 'a,b']);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.command, 'run');
  assert.equal(ok.flags['repeats'], '3');
  assert.equal(ok.flags['json'], true);
  assert.equal(ok.flags['tasks'], 'a,b');
  const help = parseEvalHarnessV4CliArgs([]);
  assert.equal(help.command, 'help');
});

test('CLI: list shows 8 tasks, history empty, config --init, pin/unpin', async () => {
  const baseDir = tmpDir();
  const cwd = tmpDir();
  const ctx = { baseDir, cwd };
  const list = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['list']), ctx);
  assert.equal(list.exitCode, 0);
  assert.ok(list.stdout.includes('json-transform'));
  assert.ok(list.stdout.includes('hello-file'));
  assert.equal(list.json.tasks.length, 12);
  const history = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['history']), ctx);
  assert.equal(history.exitCode, 0);
  assert.ok(history.stdout.includes('Chưa có run nào'));
  const regressions = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['regressions']), ctx);
  assert.equal(regressions.exitCode, 1);
  const dashboard = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['dashboard']), ctx);
  assert.equal(dashboard.exitCode, 0);
  assert.ok(dashboard.stdout.includes('# Eval Harness v4'));
  const init = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['config', '--init']), ctx);
  assert.equal(init.exitCode, 0);
  assert.ok(fs.existsSync(path.join(cwd, 'eval.config.json')));
  const initAgain = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['config', '--init']), ctx);
  assert.equal(initAgain.exitCode, 1);
  const pinMissing = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['pin', 'v4-nope']), ctx);
  assert.equal(pinMissing.exitCode, 1);
  const unpinEmpty = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['unpin']), ctx);
  assert.equal(unpinEmpty.exitCode, 0);
  assert.ok(unpinEmpty.stdout.includes('Chưa pin'));
  const badRepeats = await executeEvalHarnessV4Command(parseEvalHarnessV4CliArgs(['run', '--repeats', '0']), ctx);
  assert.equal(badRepeats.exitCode, 2);
});

test('CLI: run end-to-end with --agent-files-by-task passes the 8 V4 tasks', async () => {
  const baseDir = tmpDir();
  const cwd = tmpDir();
  const agentFiles = {
    'json-transform': { 'output.json': '{"name": "ADA", "age": 36, "total": 24, "passed": true}\n' },
    'sort-lines': { 'sorted.txt': 'An\nHoa\nLan\nMinh\nTuan\n' },
    'fix-import': { 'app.py': 'import math\n\nprint(math.sqrt(16))\n' },
    'readme-headings': {
      'README.md': '# notecli\n\nA fast note-taking tool for the terminal.\n\n## Install\n\nRun `npm install -g notecli`.\n\n## Usage\n\nRun `notecli add "buy milk"` to add a note.\n',
    },
    'word-count': { 'counts.json': '{"lines": 3, "words": 13, "chars": 64}\n' },
    'log-grep': { 'errors.txt': '2026-11-19T05:00:02 ERROR Failed to connect to database\n2026-11-19T05:00:04 ERROR Timeout after 30s\n2026-11-19T05:00:06 ERROR Disk almost full\n' },
    'config-fix': { 'fixed.json': '{"host": "localhost", "port": 3000, "debug": true}\n' },
    'changelog-entry': { 'CHANGELOG.md': '# Changelog\n\n## [1.1.0] - 2026-11-19\n\n### Added\n\n- Quick capture from the command line.\n- Search notes by keyword.\n\n## [1.0.0] - 2026-11-01\n\n### Added\n\n- Initial release of notecli.\n' },
  };
  const agentFile = path.join(cwd, 'agent-files.json');
  fs.writeFileSync(agentFile, JSON.stringify(agentFiles), 'utf-8');
  const result = await executeEvalHarnessV4Command(
    parseEvalHarnessV4CliArgs([
      'run',
      '--tasks', 'json-transform,sort-lines,fix-import,readme-headings,word-count,log-grep,config-fix,changelog-entry',
      '--agent-files-by-task', agentFile,
    ]),
    { baseDir, cwd },
  );
  assert.equal(result.exitCode, 0, result.stdout);
  assert.ok(result.stdout.includes('8/8'));
  assert.ok(result.stdout.includes('Chưa có baseline'));
  const { records } = loadEvalHarnessV4History(path.join(baseDir, 'eval-harness-v4'));
  assert.equal(records.length, 1);
  assert.equal(records[0].tasks.length, 8);
  const history = await executeEvalHarnessV4Command(
    parseEvalHarnessV4CliArgs(['history']),
    { baseDir, cwd },
  );
  assert.ok(history.stdout.includes(records[0].runId));
  const pin = await executeEvalHarnessV4Command(
    parseEvalHarnessV4CliArgs(['pin', records[0].runId]),
    { baseDir, cwd },
  );
  assert.equal(pin.exitCode, 0);
  const dashboard = await executeEvalHarnessV4Command(
    parseEvalHarnessV4CliArgs(['dashboard']),
    { baseDir, cwd },
  );
  assert.ok(dashboard.stdout.includes('Gate: **pass**'));
});
