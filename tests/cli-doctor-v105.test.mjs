/**
 * cli-doctor-v105.test.mjs — CLI v1.05 (Đội T3): doctor, team apply/export
 * YAML, headless start/stop/status, models refresh.
 * Chạy CLI thật đã build (apps/cli/dist/cli.js) với OPENBOT_DATA_DIR tạm.
 * Không gọi API ngoài: Ollama không chạy (refresh ollama phải lỗi rõ),
 * provider mock không dùng trong các lệnh này.
 * Run: build cli rồi `node --test tests/cli-doctor-v105.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'apps/cli/dist/cli.js');

function tmpDataDir() {
  // /tmp trên máy này là tmpfs nhỏ (512 MB) nên check đĩa của doctor
  // sẽ fail thật — dùng thư mục tạm trong repo (ổ đĩa lớn) rồi dọn.
  return fs.mkdtempSync(path.join(repo, '.tmp-cli-v105-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Bỏ qua lỗi dọn.
  }
}

async function runCli(args, dataDir, extraEnv = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd: repo,
      timeout: 60_000,
      env: { ...process.env, OPENBOT_DATA_DIR: dataDir, ...extraEnv },
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

const TEAM_YAML = `version: 1
team:
  id: team-cli
  name: Team CLI
members:
  - userId: local
    name: Huy
    role: admin
bots:
  - botId: assistant
    sharedBy: local
    computer:
      level: box
      cpuCores: 2
      memoryMb: 1024
`;

test('cli doctor: chạy thật, exit 0 khi không có fail, in đủ check', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const res = await runCli(['doctor'], dir);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Node\.js/);
  assert.match(res.stdout, /Ollama local/);
  assert.match(res.stdout, /OK/);
});

test('cli doctor: --json trả JSON parse được, ok=true khi không fail', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const res = await runCli(['doctor', '--json'], dir);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.summary.fail, 0);
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 8);
});

test('cli team: apply YAML + export round-trip', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'team.yaml');
  fs.writeFileSync(file, TEAM_YAML, 'utf8');
  const applied = await runCli(['team', 'apply', file], dir);
  assert.equal(applied.code, 0, `stderr: ${applied.stderr}`);
  assert.match(applied.stdout, /Team CLI/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'team.json'), 'utf8')).id, 'team-cli');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'team-computers.json'), 'utf8')).length, 1);

  const exported = await runCli(['team', 'export'], dir);
  assert.equal(exported.code, 0, `stderr: ${exported.stderr}`);
  assert.match(exported.stdout, /team-cli/);
  assert.match(exported.stdout, /assistant/);
  assert.match(exported.stdout, /cpuCores: 2/);

  const outFile = path.join(dir, 'out.yaml');
  const exportedFile = await runCli(['team', 'export', '--out', outFile], dir);
  assert.equal(exportedFile.code, 0, `stderr: ${exportedFile.stderr}`);
  assert.match(fs.readFileSync(outFile, 'utf8'), /team-cli/);
});

test('cli team: apply YAML --dry-run không ghi file', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'team.yaml');
  fs.writeFileSync(file, TEAM_YAML, 'utf8');
  const res = await runCli(['team', 'apply', file, '--dry-run'], dir);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Dry-run OK/);
  assert.equal(fs.existsSync(path.join(dir, 'team.json')), false);
});

test('cli team: apply YAML lỗi -> exit 1 + lỗi rõ', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'bad.yaml');
  fs.writeFileSync(file, 'version: 2\nteam:\n  id: x\n  name: y\n', 'utf8');
  const res = await runCli(['team', 'apply', file], dir);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /version/);
});

test('cli team: apply JSON cũ vẫn chạy (tương thích ngược)', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'team.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ id: 't-json', name: 'Team JSON', members: [], sharedBots: [] }),
    'utf8',
  );
  const res = await runCli(['team', 'apply', file, '--json'], dir);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.equal(JSON.parse(res.stdout).id, 't-json');
});

test('cli headless: start -> status -> stop, status sau stop báo không chạy', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const started = await runCli(['headless', 'start', '--port', '18799'], dir);
  assert.equal(started.code, 0, `stderr: ${started.stderr}`);
  assert.match(started.stdout, /127\.0\.0\.1:18799/);
  try {
    const status = await runCli(['headless', 'status', '--port', '18799', '--json'], dir);
    assert.equal(status.code, 0, `stderr: ${status.stderr}`);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.running, true);
    assert.equal(parsed.health.status, 'ok');
    const health = await fetch('http://127.0.0.1:18799/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
  } finally {
    const stopped = await runCli(['headless', 'stop'], dir);
    assert.equal(stopped.code, 0, `stderr: ${stopped.stderr}`);
    assert.match(stopped.stdout, /Đã dừng/);
  }
  const after = await runCli(['headless', 'status', '--port', '18799', '--json'], dir);
  assert.equal(after.code, 0);
  assert.equal(JSON.parse(after.stdout).running, false);
});

test('cli headless: stop khi không chạy -> exit 0, báo rõ', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const res = await runCli(['headless', 'stop'], dir);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /không chạy/);
});

test('cli headless: logs in N dòng cuối, --tail giới hạn', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const started = await runCli(['headless', 'start', '--port', '18798'], dir);
  assert.equal(started.code, 0, `stderr: ${started.stderr}`);
  try {
    const logs = await runCli(['headless', 'logs', '--tail', '5'], dir);
    assert.equal(logs.code, 0, `stderr: ${logs.stderr}`);
    assert.match(logs.stdout, /đang nghe http:\/\/127\.0\.0\.1:18798/);
    const logsJson = await runCli(['headless', 'logs', '--tail', '2', '--json'], dir);
    assert.equal(logsJson.code, 0);
    const parsed = JSON.parse(logsJson.stdout);
    assert.ok(Array.isArray(parsed.lines) && parsed.lines.length <= 2);
  } finally {
    await runCli(['headless', 'stop'], dir);
  }
});

test('cli headless: logs khi chưa chạy bao giờ -> exit 1 rõ', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const res = await runCli(['headless', 'logs'], dir);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Chưa có log/);
});

test('cli team: diff liệt kê thêm/bớt/đổi, diff giống hệt báo không đổi', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'team.yaml');
  fs.writeFileSync(file, TEAM_YAML, 'utf8');
  const applied = await runCli(['team', 'apply', file], dir);
  assert.equal(applied.code, 0, `stderr: ${applied.stderr}`);
  const same = await runCli(['team', 'diff', file], dir);
  assert.equal(same.code, 0, `stderr: ${same.stderr}`);
  assert.match(same.stdout, /giống hệt/);
  const changedYaml = TEAM_YAML.replace('memoryMb: 1024', 'memoryMb: 2048').replace(
    '    sharedBy: local\n',
    '    sharedBy: local\n  - botId: extra\n    sharedBy: local\n',
  );
  const changedFile = path.join(dir, 'team2.yaml');
  fs.writeFileSync(changedFile, changedYaml, 'utf8');
  const diffed = await runCli(['team', 'diff', changedFile], dir);
  assert.equal(diffed.code, 0, `stderr: ${diffed.stderr}`);
  assert.match(diffed.stdout, /\+ bot extra/);
  assert.match(diffed.stdout, /memoryMb/);
  const diffedJson = await runCli(['team', 'diff', changedFile, '--json'], dir);
  assert.equal(diffedJson.code, 0);
  assert.equal(JSON.parse(diffedJson.stdout).changed, true);
});

test('cli models refresh: ollama không chạy -> lỗi rõ, exit 1', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const res = await runCli(['models', 'refresh', '--provider', 'ollama'], dir);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /ollama/);
});

test('cli models refresh: provider không rõ -> exit 1', async (t) => {
  const dir = tmpDataDir();
  t.after(() => cleanup(dir));
  const res = await runCli(['models', 'refresh', '--provider', 'khong-co'], dir);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /không rõ/);
});
