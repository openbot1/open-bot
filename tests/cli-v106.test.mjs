/**
 * cli-v106.test.mjs — CLI v1.06 (Đội T3): doctor / team export /
 * driver / engine chạy CLI thật đã build (apps/cli/dist/cli.js).
 * Run: build core + tools + cli rồi `node --test tests/cli-v106.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'apps/cli/dist/cli.js');

async function runCli(args, dataDir) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args, '--data-dir', dataDir], {
      cwd: repo,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'open-bot-cli-v106-'));
}

test('cli doctor: --json trả report 20 check (11 v106 + 9 v105); exit 2 vì disk trên tmpfs fail thật', async () => {
  const res = await runCli(['doctor', '--json'], tmpDir());
  // dataDir test nằm trên /tmp (tmpfs ~512 MB) nên check disk fail thật → exit 2 theo thiết kế.
  assert.equal(res.code, 2, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.checks.length, 20);
  assert.equal(report.summary.total, 20);
  assert.ok(report.summary.fail >= 1);
  assert.equal(report.checks.find((c) => c.id === 'disk').status, 'fail');
});

test('cli doctor: text in checklist + --only lọc check (chỉ check pass → exit 0)', async () => {
  const dir = tmpDir();
  const res = await runCli(['doctor', '--only', 'os,node-version'], dir);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Hệ điều hành/);
  assert.match(res.stdout, /Phiên bản Node\.js/);
  assert.doesNotMatch(res.stdout, /Dung lượng đĩa/);
});

test('cli doctor: --port sai → exit 1 + lỗi rõ', async () => {
  const res = await runCli(['doctor', '--port', '99999'], tmpDir());
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--port/);
});

test('cli team: apply YAML rồi export ra YAML khớp nhau', async () => {
  const dir = tmpDir();
  const yamlPath = join(dir, 'team.yaml');
  writeFileSync(
    yamlPath,
    `team:
  name: "Đội CLI"
  bots:
    - id: cli-bot
      name: "Bot CLI"
      model: "mock"
      provider: mock
      computer: local
`,
    'utf8',
  );
  const applied = await runCli(['team', 'apply', yamlPath, '--json'], dir);
  assert.equal(applied.code, 0, `stderr: ${applied.stderr}`);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.created, 1);
  assert.equal(result.teamName, 'Đội CLI');
  const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf8'));
  assert.equal(bots[0].bot.id, 'cli-bot');
  const exported = await runCli(['team', 'export'], dir);
  assert.equal(exported.code, 0, `stderr: ${exported.stderr}`);
  assert.match(exported.stdout, /Đội CLI/);
  assert.match(exported.stdout, /id: cli-bot/);
});

test('cli team: apply YAML lỗi → exit 1 + báo dòng', async () => {
  const dir = tmpDir();
  const yamlPath = join(dir, 'bad.yaml');
  writeFileSync(yamlPath, 'team:\n  bots: []\n', 'utf8');
  const res = await runCli(['team', 'apply', yamlPath], dir);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Dòng 1/);
});

test('cli driver: register → list → test → disable → remove', async () => {
  const dir = tmpDir();
  const reg = await runCli(
    ['driver', 'register', '--id', 'node-cli', '--name', 'Node', '--provider', 'node-p', '--binary', process.execPath, '--format', 'json', '--json'],
    dir,
  );
  assert.equal(reg.code, 0, `stderr: ${reg.stderr}`);
  assert.equal(JSON.parse(reg.stdout).driver.id, 'node-cli');
  const list = await runCli(['driver', 'list'], dir);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /node-cli/);
  const tested = await runCli(['driver', 'test', 'node-cli', '--json'], dir);
  assert.equal(tested.code, 0, `stderr: ${tested.stderr}`);
  assert.equal(JSON.parse(tested.stdout).ok, true);
  const disabled = await runCli(['driver', 'disable', 'node-cli', '--json'], dir);
  assert.equal(JSON.parse(disabled.stdout).driver.enabled, false);
  const removed = await runCli(['driver', 'remove', 'node-cli', '--json'], dir);
  assert.equal(JSON.parse(removed.stdout).ok, true);
  const gone = await runCli(['driver', 'test', 'node-cli'], dir);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /không tồn tại/);
});

test('cli driver: register thiếu cờ → exit 1', async () => {
  const res = await runCli(['driver', 'register', '--id', 'x'], tmpDir());
  assert.equal(res.code, 1);
  assert.match(res.stderr, /driver register cần/);
});

test('cli engine: list có api:gemini; pick/current/unpick với bot mock', async () => {
  const dir = tmpDir();
  writeFileSync(
    join(dir, 'bots.json'),
    JSON.stringify([{ bot: { id: 'b1', name: 'B1', providerId: 'mock', model: 'mock', systemPrompt: '', workspaceDir: join(dir, 'w'), autoApprove: false }, provider: { id: 'mock', label: 'mock', defaultModel: 'mock' } }]),
    'utf8',
  );
  const list = await runCli(['engine', 'list', '--json'], dir);
  assert.equal(list.code, 0, `stderr: ${list.stderr}`);
  const engines = JSON.parse(list.stdout).engines;
  assert.ok(engines.some((e) => e.id === 'api:gemini'));
  const pick = await runCli(['engine', 'pick', '--bot', 'b1', '--engine', 'api:gemini', '--model', 'gemini-2.5-flash', '--json'], dir);
  assert.equal(pick.code, 0, `stderr: ${pick.stderr}`);
  assert.equal(JSON.parse(pick.stdout).pick.engineId, 'api:gemini');
  const current = await runCli(['engine', 'current', '--bot', 'b1', '--json'], dir);
  assert.equal(JSON.parse(current.stdout).fromPick, true);
  const unpick = await runCli(['engine', 'unpick', '--bot', 'b1', '--json'], dir);
  assert.equal(JSON.parse(unpick.stdout).ok, true);
  const current2 = await runCli(['engine', 'current', '--bot', 'b1', '--json'], dir);
  assert.equal(JSON.parse(current2.stdout).fromPick, false);
});

test('cli engine: pick bot không tồn tại → exit 1', async () => {
  const res = await runCli(['engine', 'pick', '--bot', 'ghost', '--engine', 'api:gemini', '--model', 'm'], tmpDir());
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Không thấy bot/);
});
