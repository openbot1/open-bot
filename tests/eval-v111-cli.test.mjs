/**
 * Tests for the Harbor eval CLI (`open-bot eval harbor ...`,
 * apps/cli/src/cli.ts — cmdEvalHarbor) — v1.11, Đội T2.
 *
 * Runs the real built CLI (node apps/cli/dist/cli.js) with a temp
 * OPENBOT_DATA_DIR. Covers: list, validate, run (noop baseline
 * exit 1 + scripted agent exit 0), suite, export (rollout + sft),
 * profiles, profile-for-kind, report, and the unknown-subcommand
 * error. No API key, no network — the CLI never calls a model.
 *
 * Run after building core + tools + cli:
 *   npm run build --workspace=@open-bot/cli
 *   node --test tests/eval-v111-cli.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const cliPath = path.join(repo, 'apps', 'cli', 'dist', 'cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-v111-cli-'));
}

/** Run the CLI with a fresh data dir; returns { status, stdout, stderr }. */
function runCli(dataDir, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, OPENBOT_DATA_DIR: dataDir },
    timeout: 120_000,
  });
}

function runCliOk(dataDir, args) {
  const result = runCli(dataDir, args);
  assert.equal(result.status, 0, `open-bot ${args.join(' ')} failed (status ${result.status}): ${result.stderr}`);
  return result.stdout;
}

test('eval harbor list: 4 sample tasks, exit 0', () => {
  const dataDir = tmpDir();
  const out = runCliOk(dataDir, ['eval', 'harbor', 'list']);
  for (const id of ['hello-file', 'sum-csv', 'fix-add', 'markdown-table']) {
    assert.ok(out.includes(id), `list should include ${id}`);
  }
  const json = runCliOk(dataDir, ['eval', 'harbor', 'list', '--json']);
  const parsed = JSON.parse(json);
  assert.equal(parsed.tasks.length, 4);
  assert.equal(parsed.tasks.find((t) => t.id === 'sum-csv').totalWeight, 4);
});

test('eval harbor validate: valid task exit 0, unknown task exit 1', () => {
  const dataDir = tmpDir();
  const out = runCliOk(dataDir, ['eval', 'harbor', 'validate', 'sum-csv']);
  assert.ok(out.includes('hợp lệ'));
  const bad = runCli(dataDir, ['eval', 'harbor', 'validate', 'nope']);
  assert.notEqual(bad.status, 0);
  assert.ok((bad.stderr + bad.stdout).includes('nope'));
});

test('eval harbor run: noop baseline exits 1 (reward 0); scripted agent exits 0 (reward 1)', () => {
  const dataDir = tmpDir();
  const noop = runCli(dataDir, ['eval', 'harbor', 'run', 'hello-file']);
  assert.equal(noop.status, 1, `noop run should exit 1, got ${noop.status}: ${noop.stdout} ${noop.stderr}`);
  assert.ok(noop.stdout.includes('reward=0.000'));
  const agentFiles = path.join(dataDir, 'agent-files.json');
  fs.writeFileSync(agentFiles, JSON.stringify({ 'greeting.txt': 'Hello, open-bot!\n' }), 'utf-8');
  const scripted = runCliOk(dataDir, ['eval', 'harbor', 'run', 'hello-file', '--agent-files', agentFiles]);
  assert.ok(scripted.includes('reward=1.000'));
  const json = runCliOk(dataDir, ['eval', 'harbor', 'run', 'hello-file', '--agent-files', agentFiles, '--json']);
  const parsed = JSON.parse(json);
  assert.equal(parsed.passed, true);
  assert.equal(parsed.executor, 'scripted');
  assert.ok(fs.existsSync(parsed.reportPath));
  assert.ok(fs.existsSync(path.join(dataDir, 'eval-harbor', 'rollouts.jsonl')));
});

test('eval harbor suite: all 4 tasks pass with scripted agents, exit 0; report + export work', () => {
  const dataDir = tmpDir();
  const byTask = path.join(dataDir, 'by-task.json');
  fs.writeFileSync(byTask, JSON.stringify({
    'hello-file': { 'greeting.txt': 'Hello, open-bot!\n' },
    'sum-csv': { 'result.txt': '50\n' },
    'fix-add': { 'calc.py': 'def add(a, b):\n    return a + b\n' },
    'markdown-table': { 'report.md': '# R\n\n| A | B |\n|---|---|\n| Bánh mì | 15000 |\n| Cà phê | 20000 |\n| Trà sữa | 30000 |\n\n65000\n' },
  }), 'utf-8');
  const out = runCliOk(dataDir, ['eval', 'harbor', 'suite', '--agent-files-by-task', byTask]);
  assert.ok(out.includes('4/4 passed'));
  assert.ok(out.includes('# Harbor eval report'));
  const exported = runCliOk(dataDir, ['eval', 'harbor', 'export', '--format', 'sft']);
  assert.ok(exported.includes('Rollouts: 4'));
  assert.ok(fs.existsSync(path.join(dataDir, 'eval-harbor', 'rollouts-sft.jsonl')));
  const report = runCliOk(dataDir, ['eval', 'harbor', 'report']);
  assert.ok(report.includes('Pass rate: 100.0%'));
  const reportJson = JSON.parse(runCliOk(dataDir, ['eval', 'harbor', 'report', '--json']));
  assert.equal(reportJson.runs, 4);
  assert.equal(reportJson.passRate, 1);
});

test('eval harbor profiles + profile: list 6 profiles, pick coding profile', () => {
  const dataDir = tmpDir();
  const out = runCliOk(dataDir, ['eval', 'harbor', 'profiles']);
  for (const id of ['coding', 'research', 'writing', 'review', 'general', 'data']) {
    assert.ok(out.includes(id), `profiles should include ${id}`);
  }
  const picked = JSON.parse(runCliOk(dataDir, ['eval', 'harbor', 'profile', 'coding', '--json']));
  assert.equal(picked.profileId, 'coding');
  assert.equal(picked.provider, 'ollama');
  assert.equal(picked.modelResolved, false);
  const bad = runCli(dataDir, ['eval', 'harbor', 'profile', 'nope']);
  assert.notEqual(bad.status, 0);
});

test('eval harbor: unknown subcommand exits 1 with usage hint', () => {
  const dataDir = tmpDir();
  const result = runCli(dataDir, ['eval', 'harbor', 'nope']);
  assert.notEqual(result.status, 0);
  assert.ok((result.stderr + result.stdout).includes('list | validate | run | suite | export | profiles | profile | report'));
  const empty = runCli(dataDir, ['eval', 'harbor']);
  assert.notEqual(empty.status, 0);
});

test('eval harbor export with no rollouts reports zero and exits 0', () => {
  const dataDir = tmpDir();
  const out = runCliOk(dataDir, ['eval', 'harbor', 'export']);
  assert.ok(out.includes('Chưa có rollout'));
  const report = runCliOk(dataDir, ['eval', 'harbor', 'report']);
  assert.ok(report.includes('Chưa có lần chạy'));
});
