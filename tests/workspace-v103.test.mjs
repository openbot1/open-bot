/**
 * Tests cho workspace abstraction v3 (v1.03, Đội T4).
 *
 * Run sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/workspace-v103.test.mjs
 *
 * KHÔNG dùng Docker thật, KHÔNG gọi API ngoài: local backend chạy
 * /bin/echo, /bin/sh, /bin/ls trên thư mục tạm; container backend
 * chạy bằng runner giả (ghi lại argv docker) — máy này không có
 * Docker thật nên test container-thật được bỏ qua có ghi rõ (xem
 * test cuối file). Không đọc credential thật.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ContainerWorkspaceBackend,
  WorkspaceExecGuard,
  WorkspaceManager,
  WorkspacePathError,
  WorkspaceQuotaLedger,
  WorkspaceSnapshotStore,
  WorkspaceUsageWindow,
  defaultHostBudget,
  detectContainerRuntime,
  fakeMachineProfile,
  findDangerousCommand,
  getBuiltinSandboxProfile,
  hostBudgetFromProfile,
  isPathInsideRoot,
  resolveWithinRoot,
  resolveWorkspaceQuota,
  validateWorkspaceQuota,
} from '../packages/core/dist/index.js';
import { ALL_TOOLS, WORKSPACE_TOOLS } from '../packages/tools/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-ws103-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Host budget nhỏ, xác định — để test ledger từ chối khi hết chỗ. */
const TINY_BUDGET = { cpuCores: 0.5, ramBytes: 512 * 1024 * 1024, diskBytes: 512 * 1024 * 1024 };
/** Host budget rộng cho test vòng đời (không bị ledger chặn). */
const ROOMY_BUDGET = { cpuCores: 8, ramBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 };

function managerIn(root, budget = ROOMY_BUDGET, extra = {}) {
  return new WorkspaceManager({ rootDir: path.join(root, 'workspaces'), hostBudget: budget, ...extra });
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

test('quota: hostBudgetFromProfile chừa headroom cho host (cùng công thức planner)', () => {
  const profile = fakeMachineProfile({
    cpu: { logicalCores: 8 },
    memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 12 * 1024 ** 3 },
    disks: [{ mount: '/', totalBytes: 500 * 1024 ** 3, freeBytes: 200 * 1024 ** 3 }],
  });
  const budget = hostBudgetFromProfile(profile);
  // CPU: 8 core, chừa max(2, 25%) = 2 → còn 6.
  assert.equal(budget.cpuCores, 6);
  // RAM: chừa max(2GiB, 25% tổng 4GiB) = 4GiB trên RAM trống 12GiB → còn 8GiB.
  assert.equal(budget.ramBytes, 8 * 1024 ** 3);
  // Đĩa: 200GiB trống − 5GiB reserve = 195GiB.
  assert.equal(budget.diskBytes, 195 * 1024 ** 3);
});

test('quota: defaultHostBudget đo được thật trên máy này', () => {
  const budget = defaultHostBudget();
  assert.ok(budget.cpuCores >= 0, 'cpu budget >= 0');
  assert.ok(budget.ramBytes >= 0, 'ram budget >= 0');
  assert.ok(budget.diskBytes >= 0, 'disk budget >= 0');
});

test('quota: resolveWorkspaceQuota điền mặc định + sàn + kẹp theo ngân sách', () => {
  const resolved = resolveWorkspaceQuota({}, TINY_BUDGET);
  // Kẹp CPU về ngân sách 0.5 (mặc định 1 > 0.5), RAM/đĩa kẹp về 512MiB.
  assert.equal(resolved.cpuCores, 0.5);
  assert.equal(resolved.ramBytes, 512 * 1024 * 1024);
  assert.equal(resolved.diskBytes, 512 * 1024 * 1024);
  // Sàn: cpu 0.1 → nâng lên 0.25; timeout 1 → nâng lên 10_000.
  const floored = resolveWorkspaceQuota({ cpuCores: 0.1, timeoutMs: 1 });
  assert.equal(floored.cpuCores, 0.25);
  assert.equal(floored.timeoutMs, 10_000);
  // 0 = không giới hạn được giữ nguyên cho maxWriteBytes/maxWallMs.
  const unlimited = resolveWorkspaceQuota({ maxWriteBytes: 0, maxWallMs: 0 });
  assert.equal(unlimited.maxWriteBytes, 0);
  assert.equal(unlimited.maxWallMs, 0);
});

test('quota: validateWorkspaceQuota bắt giá trị sai', () => {
  const ok = resolveWorkspaceQuota({});
  assert.deepEqual(validateWorkspaceQuota(ok), []);
  assert.ok(validateWorkspaceQuota({ ...ok, cpuCores: 0 }).length > 0);
  assert.ok(validateWorkspaceQuota({ ...ok, timeoutMs: 0 }).length > 0);
  assert.ok(validateWorkspaceQuota({ ...ok, maxProcesses: -1 }).length > 0);
});

test('quota: ledger không cấp vượt ngân sách, release trả lại chỗ', () => {
  const ledger = new WorkspaceQuotaLedger(TINY_BUDGET);
  const q = resolveWorkspaceQuota({ cpuCores: 0.5, ramBytes: 256 * 1024 * 1024, diskBytes: 256 * 1024 * 1024 });
  ledger.allocate('ws-a', q);
  assert.equal(ledger.remaining.cpuCores, 0);
  // Workspace thứ hai cần 0.25 core nữa → bị từ chối kèm lý do.
  const check = ledger.check(resolveWorkspaceQuota({ cpuCores: 0.25 }));
  assert.equal(check.allowed, false);
  assert.match(check.reason ?? '', /CPU budget/);
  assert.throws(() => ledger.allocate('ws-b', resolveWorkspaceQuota({ cpuCores: 0.25 })), /quota denied/);
  ledger.release('ws-a');
  assert.equal(ledger.remaining.cpuCores, 0.5);
  ledger.allocate('ws-b', resolveWorkspaceQuota({ cpuCores: 0.25, ramBytes: 256 * 1024 * 1024, diskBytes: 256 * 1024 * 1024 }));
  assert.equal(ledger.allocated.workspaces, 1);
});

test('quota: usage window chặn run/ghi khi vượt cửa sổ, reset mở lại', () => {
  const quota = resolveWorkspaceQuota({ maxWriteBytes: 100, maxWallMs: 1000 });
  const window = new WorkspaceUsageWindow(quota);
  assert.deepEqual(window.checkRun(), { allowed: true });
  window.recordRun(60, 600);
  assert.deepEqual(window.checkRun(), { allowed: true });
  assert.equal(window.checkWrite(41).allowed, false);
  assert.match(window.checkWrite(41).reason ?? '', /write quota/);
  window.recordRun(40, 500);
  assert.equal(window.checkRun().allowed, false);
  assert.match(window.checkRun().reason ?? '', /wall-time quota/);
  window.reset();
  assert.deepEqual(window.checkRun(), { allowed: true });
  assert.equal(window.current.runs, 0);
});

test('quota: usage window rollover khi hết cửa sổ (windowMs nhỏ)', () => {
  const quota = resolveWorkspaceQuota({ maxWallMs: 1000 });
  const window = new WorkspaceUsageWindow(quota, undefined, 1);
  window.recordRun(0, 999);
  // Chờ >1ms rồi check — cửa sổ đã hết hạn nên rollover về 0.
  const start = Date.now();
  while (Date.now() - start < 5) {
    // busy-wait ngắn có chủ đích để cửa sổ 1ms hết hạn.
  }
  assert.equal(window.current.wallMs, 0);
  assert.deepEqual(window.checkRun(), { allowed: true });
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

test('paths: resolveWithinRoot cho phép trong workspace, chặn escape tuyệt đối/..', () => {
  const root = makeTempDir();
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'f.txt'), 'x');
  assert.equal(resolveWithinRoot(root, 'a/f.txt'), path.join(root, 'a', 'f.txt'));
  assert.equal(resolveWithinRoot(root, '.'), root);
  assert.throws(() => resolveWithinRoot(root, '../etc/passwd'), WorkspacePathError);
  assert.throws(() => resolveWithinRoot(root, 'a/../../etc/passwd'), WorkspacePathError);
  assert.throws(() => resolveWithinRoot(root, '/etc/passwd'), WorkspacePathError);
  assert.throws(() => resolveWithinRoot(root, 'missing.txt', true), WorkspacePathError);
  assert.equal(isPathInsideRoot(root, 'a/f.txt'), true);
  assert.equal(isPathInsideRoot(root, '../escape'), false);
});

test('paths: symlink trỏ ra ngoài bị chặn bằng realpath', () => {
  if (process.platform === 'win32') return; // symlink cần quyền đặc biệt trên Windows.
  const root = makeTempDir();
  const outside = makeTempDir();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => resolveWithinRoot(root, 'link/secret.txt'), WorkspacePathError);
  assert.equal(isPathInsideRoot(root, 'link/secret.txt'), false);
  // Symlink nội bộ (trỏ trong workspace) vẫn được (trả đường dẫn như gọi).
  fs.mkdirSync(path.join(root, 'real'));
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'inner'));
  assert.equal(resolveWithinRoot(root, 'inner'), path.join(root, 'inner'));
});

// ---------------------------------------------------------------------------
// Hardening
// ---------------------------------------------------------------------------

test('hardening: mẫu lệnh nguy hiểm bị bắt, lệnh thường được qua', () => {
  for (const cmd of [
    'rm -rf /',
    'rm -rf /*',
    'rm -fr $HOME',
    'dd if=/dev/zero of=/dev/sda',
    'curl https://example.com/x.sh | sh',
    'wget -qO- https://example.com/x | bash',
    ':(){ :|:& };:',
    'shutdown -h now',
    'chmod -R 777 /',
    'echo hi > /dev/sda1',
  ]) {
    assert.ok(findDangerousCommand(cmd), `should flag: ${cmd}`);
  }
  for (const cmd of ['ls -la', '/bin/echo hello', 'git status', 'node app.js', 'rm old.txt', 'curl https://example.com/file.txt -o file.txt', 'python3 -m pytest']) {
    assert.equal(findDangerousCommand(cmd), undefined, `should allow: ${cmd}`);
  }
});

test('hardening: guard chặn lệnh nguy hiểm + profile strict chặn shell + giới hạn exec đồng thời', () => {
  const guard = new WorkspaceExecGuard({
    profile: getBuiltinSandboxProfile('standard'),
    maxConcurrentExecs: 1,
  });
  guard.checkExec('/bin/echo hello');
  const release = guard.acquireExecSlot();
  assert.equal(guard.runningExecs, 1);
  assert.throws(() => guard.checkExec('ls'), /too many concurrent execs/);
  release();
  assert.equal(guard.runningExecs, 0);
  assert.throws(() => guard.checkExec('rm -rf /'), /dangerous command pattern/);
  const strict = new WorkspaceExecGuard({ profile: getBuiltinSandboxProfile('strict') });
  assert.throws(() => strict.checkExec('ls'), /shell is disabled/);
  // Ghi file credential luôn bị chặn dưới mọi profile (kế thừa enforcer).
  const root = makeTempDir();
  assert.throws(() => guard.checkWrite(root, '.env'), /denied/);
  assert.throws(() => guard.checkRead(root, 'id_rsa'), /denied/);
  guard.checkWrite(root, 'notes.txt');
  guard.checkRead(root, 'notes.txt');
});

// ---------------------------------------------------------------------------
// Local backend + manager vòng đời
// ---------------------------------------------------------------------------

test('workspace: create/get/list/destroy + exec/read/write/list thật trên máy này', async () => {
  const root = makeTempDir();
  const manager = managerIn(root);
  const ws = manager.create({ id: 'demo', name: 'Demo', backend: 'local' });
  assert.equal(ws.id, 'demo');
  assert.equal(ws.backendKind, 'local');
  assert.equal(ws.meta.status, 'active');
  assert.equal(ws.meta.quota.cpuCores, 1);
  assert.equal(ws.meta.profile, 'standard');

  ws.writeFile('hello.txt', 'hello workspace');
  assert.equal(ws.readFile('hello.txt'), 'hello workspace');
  const entries = ws.listFiles();
  assert.ok(entries.some((e) => e.relPath === 'hello.txt' && e.kind === 'file'));
  // Exec phải thấy cùng file mà writeFile đã ghi (cùng filesDir với box).
  const cat = await ws.exec('/bin/cat', ['hello.txt']);
  assert.equal(cat.exitCode, 0);
  assert.match(cat.stdout, /hello workspace/);

  const run = await ws.exec('/bin/echo', ['hello']);
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /hello/);
  assert.equal(run.quotaDenied, false);
  // Mức cách ly ghi đúng thực tế (không khẳng định bwrap có mặt).
  assert.equal(typeof run.isolation.isolated, 'boolean');
  assert.ok(run.workspaceBytes >= 0);
  assert.ok(run.durationMs >= 0);

  // Mở lại từ đĩa (manager mới) vẫn thấy workspace + usage đã ghi.
  const reopened = managerIn(root).get('demo');
  assert.equal(reopened.meta.usage.runs, 2); // cat + echo
  assert.ok(reopened.meta.usage.wallMs >= 0);

  const listed = manager.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'demo');
  const status = manager.status('demo');
  assert.equal(status.snapshotCount, 0);
  assert.equal(status.usage.runs, 2);

  assert.equal(manager.destroy('demo'), true);
  assert.equal(manager.list().length, 0);
  assert.throws(() => manager.get('demo'), /unknown workspace/);
  assert.equal(manager.destroy('demo'), false);
});

test('workspace: id xấu / trùng id / quota vượt ngân sách host bị từ chối', () => {
  const root = makeTempDir();
  const manager = managerIn(root, TINY_BUDGET);
  assert.throws(() => manager.create({ id: '../escape' }), /Invalid workspace id/);
  assert.throws(() => manager.create({ id: 'bad id!' }), /Invalid workspace id/);
  manager.create({ id: 'one' });
  assert.throws(() => manager.create({ id: 'one' }), /already exists/);
  // Ngân sách tiny chỉ còn 0 CPU sau workspace đầu (0.5 đã cấp hết).
  assert.throws(() => manager.create({ id: 'two' }), /quota denied|not enough CPU/);
  // Profile không tồn tại bị từ chối rõ ràng.
  assert.throws(() => manager.create({ id: 'p', profile: 'nope' }), /unknown sandbox profile/);
});

test('workspace: exec bị chặn trước khi spawn khi lệnh nguy hiểm / quota cửa sổ hết', async () => {
  const root = makeTempDir();
  const manager = managerIn(root);
  const ws = manager.create({ id: 'guard' });
  const denied = await ws.exec('rm', ['-rf', '/']);
  assert.equal(denied.quotaDenied, false);
  assert.equal(denied.exitCode, null);
  assert.match(denied.stderr, /sandbox denied exec/);
  assert.equal(ws.meta.usage.runs, 0, 'lệnh bị chặn không được tính là run');

  // Quota wall 1ms: run đầu (sleep 50ms) ghi nhận wallMs vượt 1ms,
  // run sau bị từ chối quota trước khi spawn.
  const tiny = manager.create({ id: 'tiny-wall', quota: { maxWallMs: 1 } });
  const first = await tiny.exec('/bin/sleep', ['0.05']);
  assert.equal(first.exitCode, 0);
  const second = await tiny.exec('/bin/echo', ['y']);
  assert.equal(second.quotaDenied, true);
  assert.match(second.stderr, /quota denied/);
});

test('workspace: ghi file vượt quota ghi / đọc file ngoài workspace bị chặn', () => {
  const root = makeTempDir();
  const manager = managerIn(root);
  const ws = manager.create({ id: 'q', quota: { maxWriteBytes: 10 } });
  assert.throws(() => ws.writeFile('big.txt', '0123456789ABCDEF'), /quota denied/);
  ws.writeFile('small.txt', '0123456789');
  assert.throws(() => ws.readFile('../escape.txt'), WorkspacePathError);
  assert.throws(() => ws.readFile('/etc/passwd'), WorkspacePathError);
  assert.throws(() => ws.writeFile('.env', 'KEY=x'), /denied/);
});

test('workspace: updateQuota đổi quota khi còn ngân sách, từ chối khi hết', () => {
  const root = makeTempDir();
  const manager = managerIn(root);
  manager.create({ id: 'a', quota: { cpuCores: 0.25 } });
  const updated = manager.updateQuota('a', { cpuCores: 2 });
  assert.equal(updated.quota.cpuCores, 2);

  const root2 = makeTempDir();
  const tiny = managerIn(root2, TINY_BUDGET);
  tiny.create({ id: 'a', quota: { cpuCores: 0.25, ramBytes: 256 * 1024 * 1024, diskBytes: 256 * 1024 * 1024 } });
  tiny.create({ id: 'b', quota: { cpuCores: 0.25, ramBytes: 256 * 1024 * 1024, diskBytes: 256 * 1024 * 1024 } });
  // Hết CPU (0.25 + 0.25 = ngân sách 0.5) — tăng quota của b bị từ chối, quota cũ giữ nguyên.
  assert.throws(() => tiny.updateQuota('b', { cpuCores: 0.5 }), /quota denied|not enough CPU/);
  assert.equal(tiny.get('b').meta.quota.cpuCores, 0.25);
});

// ---------------------------------------------------------------------------
// Snapshot / restore
// ---------------------------------------------------------------------------

test('snapshot: create/list/restore/verify/delete/prune + rollback khi snapshot hỏng', () => {
  const root = makeTempDir();
  const manager = managerIn(root);
  const ws = manager.create({ id: 'snap' });
  ws.writeFile('a.txt', 'version 1');
  ws.writeFile('sub/b.txt', 'nested');
  const snap = ws.createSnapshot('v1');
  assert.equal(snap.workspaceId, 'snap');
  assert.equal(snap.fileCount, 2);
  assert.ok(snap.totalBytes > 0);
  assert.equal(snap.manifestSha256.length, 64);
  assert.equal(ws.listSnapshots().length, 1);

  ws.writeFile('a.txt', 'version 2');
  ws.writeFile('c.txt', 'new file');
  assert.equal(ws.readFile('a.txt'), 'version 2');

  const verified = new WorkspaceSnapshotStore().verify(ws.meta, snap.id);
  assert.equal(verified.ok, true);

  const restored = ws.restoreSnapshot(snap.id);
  assert.equal(restored.id, snap.id);
  assert.equal(ws.readFile('a.txt'), 'version 1');
  assert.equal(ws.readFile('sub/b.txt'), 'nested');
  assert.throws(() => ws.readFile('c.txt'), /does not exist/);

  // Làm hỏng snapshot (sửa file trong bản snapshot, giữ nguyên độ dài
  // để lỗi là hash mismatch chứ không phải size mismatch) → verify/
  // restore từ chối, workspace nguyên vẹn.
  const snapFile = path.join(ws.meta.dir, 'snapshots', snap.id, 'files', 'a.txt');
  fs.writeFileSync(snapFile, 'version 9');
  const bad = new WorkspaceSnapshotStore().verify(ws.meta, snap.id);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes('hash mismatch')));
  assert.throws(() => ws.restoreSnapshot(snap.id), /corrupt/);
  assert.equal(ws.readFile('a.txt'), 'version 1');

  // Prune: tạo thêm 2 snapshot, giữ lại 1 mới nhất.
  ws.writeFile('a.txt', 'version 1');
  ws.createSnapshot('v2');
  ws.createSnapshot('v3');
  const store = new WorkspaceSnapshotStore();
  assert.equal(store.prune(ws.meta, 1), 2);
  assert.equal(ws.listSnapshots().length, 1);
  assert.equal(ws.deleteSnapshot('no-such-snap'), false);
  assert.throws(() => ws.restoreSnapshot('no-such-snap'), /unknown snapshot/);
});

// ---------------------------------------------------------------------------
// Container backend (runner giả — máy này không có Docker thật)
// ---------------------------------------------------------------------------

/** Runner giả ghi lại argv; script theo lệnh. */
class FakeContainerRunner {
  constructor(responses = {}) {
    this.responses = responses;
    this.calls = [];
    this.availableCommands = new Set(['docker']);
  }

  commandAvailable(command) {
    return this.availableCommands.has(command);
  }

  async run(command, args, _opts) {
    this.calls.push({ command, args: [...args] });
    const key = `${command} ${args[0] ?? ''}`;
    const scripted = this.responses[key] ?? this.responses['*'];
    if (scripted) return { exitCode: 0, stdout: scripted, stderr: '', timedOut: false };
    if (command === 'docker' && args[0] === 'ps') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    if (command === 'docker' && args[0] === 'run') return { exitCode: 0, stdout: 'deadbeef1234\n', stderr: '', timedOut: false };
    if (command === 'docker' && args[0] === 'exec') return { exitCode: 0, stdout: 'container-hello\n', stderr: '', timedOut: false };
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }
}

test('container: không có runtime → available=false; manager fallback local + degraded', async () => {
  const noRuntime = { commandAvailable: () => false, run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) };
  assert.equal(detectContainerRuntime(noRuntime), undefined);
  const backend = new ContainerWorkspaceBackend({ rootDir: makeTempDir(), runner: noRuntime });
  assert.equal(backend.available, false);
  assert.match(backend.unavailableReason ?? '', /docker\/podman/);
  assert.equal(backend.isolation.isolated, false);

  const root = makeTempDir();
  const manager = managerIn(root, ROOMY_BUDGET, { containerRunner: noRuntime });
  const ws = manager.create({ id: 'c1', backend: 'container' });
  // Fallback trung thực: chạy local thật, đánh dấu degraded + lý do.
  assert.equal(ws.meta.status, 'degraded');
  assert.equal(ws.meta.backend, 'local');
  assert.equal(ws.meta.requestedBackend, 'container');
  assert.match(ws.meta.degradedReason ?? '', /docker\/podman/);
  const run = await ws.exec('/bin/echo', ['fallback-works']);
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /fallback-works/);
});

test('container: runner giả có docker → exec qua docker exec, quota bằng --cpus/--memory', async () => {
  const runner = new FakeContainerRunner();
  assert.equal(detectContainerRuntime(runner), 'docker');
  const root = makeTempDir();
  const backend = new ContainerWorkspaceBackend({
    rootDir: path.join(root, 'workspaces'),
    runner,
  });
  assert.equal(backend.available, true);
  assert.equal(backend.isolation.isolated, true);

  const manager = managerIn(root, ROOMY_BUDGET, { containerRunner: runner });
  const ws = manager.create({ id: 'c2', backend: 'container', quota: { cpuCores: 2, ramBytes: 2 * 1024 ** 3 } });
  assert.equal(ws.meta.backend, 'container');
  assert.equal(ws.meta.status, 'active');
  const run = await ws.exec('/bin/echo', ['hi']);
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /container-hello/);
  assert.equal(run.isolation.isolated, true);
  assert.match(run.isolation.detail, /docker container/);

  const runCall = runner.calls.find((c) => c.args[0] === 'run');
  assert.ok(runCall, 'docker run should have been called');
  assert.ok(runCall.args.includes('--cpus') && runCall.args.includes('2'), 'quota CPU passed as --cpus 2');
  assert.ok(runCall.args.includes('--memory') && runCall.args.includes('2048m'), 'quota RAM passed as --memory 2048m');
  assert.ok(runCall.args.includes(`${ws.meta.filesDir}:/workspace`), 'files dir bind-mounted to /workspace');
  const execCall = runner.calls.find((c) => c.args[0] === 'exec');
  assert.ok(execCall, 'docker exec should have been called');
  assert.ok(execCall.args.includes('open-bot-ws-c2'), 'exec targets the workspace container');
  assert.ok(execCall.args.includes('/workspace'), 'exec runs with -w /workspace');
});

test('container: ensureContainer start lại container đã dừng, báo lỗi rõ khi docker run lỗi', async () => {
  const runner = new FakeContainerRunner({
    'docker ps': 'open-bot-ws-c3 Exited (0) 1 minute ago\n',
    'docker start': '',
  });
  const root = makeTempDir();
  const manager = managerIn(root, ROOMY_BUDGET, { containerRunner: runner });
  const ws = manager.create({ id: 'c3', backend: 'container' });
  const ok = await ws.exec('/bin/echo', ['x']);
  assert.equal(ok.exitCode, 0);
  assert.ok(runner.calls.some((c) => c.args[0] === 'start'), 'stopped container should be started, not recreated');

  const failing = new FakeContainerRunner();
  failing.run = async (command, args) => {
    if (command === 'docker' && args[0] === 'run') {
      return { exitCode: 1, stdout: '', stderr: 'Unable to find image', timedOut: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const root2 = makeTempDir();
  const manager2 = managerIn(root2, ROOMY_BUDGET, { containerRunner: failing });
  const ws2 = manager2.create({ id: 'c4', backend: 'container' });
  const failed = await ws2.exec('/bin/echo', ['x']);
  assert.equal(failed.exitCode, null);
  assert.match(failed.stderr, /could not start workspace container/);
});

// ---------------------------------------------------------------------------
// Tools (ALL_TOOLS)
// ---------------------------------------------------------------------------

test('tools: 7 workspace_* tools trong ALL_TOOLS đúng 1 lần (ALL_TOOLS = 82: 47 gốc + 5 harness v1.03 + 7 workspace + 4 fleet v1.03 + 8 openmausbot v105 + 11 eval/fleet v105)', () => {
  for (const name of ['workspace_create', 'workspace_exec', 'workspace_list', 'workspace_quota_status', 'workspace_snapshot_create', 'workspace_snapshot_list', 'workspace_snapshot_restore']) {
    assert.equal(ALL_TOOLS.filter((t) => t.definition.name === name).length, 1, name);
    assert.equal(WORKSPACE_TOOLS.filter((t) => t.definition.name === name).length, 1, name);
  }
  const names = ALL_TOOLS.map((t) => t.definition.name);
  // 345 là tổng registry agent (defaultToolFactory — xem
  // tests/rescue-v102-tools.test.mjs); ALL_TOOLS chỉ là tập tool gốc.
  assert.equal(names.length, 82, `expected 82 tools in ALL_TOOLS, got ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names');
  const create = ALL_TOOLS.find((t) => t.definition.name === 'workspace_create');
  assert.equal(create.needsApproval, true);
  const list = ALL_TOOLS.find((t) => t.definition.name === 'workspace_list');
  assert.equal(list.needsApproval, false);
});

test('tools: workspace_create/exec/list/quota/snapshot chạy end-to-end qua ToolContext', async () => {
  const wsDir = makeTempDir();
  const ctx = { workspaceDir: wsDir, botId: 'bot-1' };
  const byName = (name) => ALL_TOOLS.find((t) => t.definition.name === name);

  const created = await byName('workspace_create').execute({ id: 'tool-ws', backend: 'local' }, ctx);
  assert.match(created, /"id": "tool-ws"/);
  assert.match(created, /"backend": "local"/);

  const listed = await byName('workspace_list').execute({}, ctx);
  assert.match(listed, /tool-ws/);

  const quota = await byName('workspace_quota_status').execute({ workspaceId: 'tool-ws' }, ctx);
  assert.match(quota, /"runs": 0/);

  const execed = await byName('workspace_exec').execute({ workspaceId: 'tool-ws', command: '/bin/echo', args: ['from-tool'] }, ctx);
  assert.match(execed, /exitCode: 0/);
  assert.match(execed, /from-tool/);

  const snap = await byName('workspace_snapshot_create').execute({ workspaceId: 'tool-ws', name: 't1' }, ctx);
  const snapId = JSON.parse(snap).id;
  assert.ok(snapId.startsWith('snap-'));

  const snaps = await byName('workspace_snapshot_list').execute({ workspaceId: 'tool-ws' }, ctx);
  assert.match(snaps, new RegExp(snapId));

  const restored = await byName('workspace_snapshot_restore').execute({ workspaceId: 'tool-ws', snapshotId: snapId }, ctx);
  assert.match(restored, /Restored workspace "tool-ws"/);

  // Lỗi rõ ràng: workspace không tồn tại / lệnh nguy hiểm / arg thiếu.
  const missing = await byName('workspace_exec').execute({ workspaceId: 'nope', command: '/bin/echo' }, ctx);
  assert.match(missing, /^Error: unknown workspace/);
  const dangerous = await byName('workspace_exec').execute({ workspaceId: 'tool-ws', command: 'rm', args: ['-rf', '/'] }, ctx);
  assert.match(dangerous, /sandbox denied exec/);
  const badCreate = await byName('workspace_create').execute({ id: 'tool-ws' }, ctx);
  assert.match(badCreate, /already exists/);
});

test('tools: workspace_create backend container trên máy không Docker → degraded (nói rõ)', async () => {
  const wsDir = makeTempDir();
  const ctx = { workspaceDir: wsDir, botId: 'bot-1' };
  const create = ALL_TOOLS.find((t) => t.definition.name === 'workspace_create');
  const out = await create.execute({ id: 'tool-c', backend: 'container' }, ctx);
  assert.match(out, /"status": "degraded"/);
  assert.match(out, /docker\/podman/);
  assert.match(out, /"backend": "local"/);
});

// ---------------------------------------------------------------------------
// Ghi rõ giới hạn môi trường
// ---------------------------------------------------------------------------

test('note: container backend thật (docker/podman) chưa kiểm chứng trên máy này', () => {
  // Máy này không có Docker thật (xem container.ts) — test với runtime
  // thật được bỏ qua có chủ đích; FakeContainerRunner ở trên đã phủ
  // argv docker run/exec + fallback. Khi có Docker, chạy tay:
  //   docker run -d --name open-bot-ws-manual alpine:latest sleep infinity
  //   docker exec open-bot-ws-manual sh -c 'echo hi'
  const runner = { commandAvailable: () => false, run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) };
  assert.equal(detectContainerRuntime(runner), undefined);
  assert.ok(true, 'documented limitation, not a silent skip');
});
