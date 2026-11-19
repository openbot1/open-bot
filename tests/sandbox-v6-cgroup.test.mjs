/**
 * Tests cho Sandbox v6 — cgroup v2 enforcer (v1.38, Đội T3).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v6-cgroup.test.mjs
 *
 * Mọi test chạy trên cgroup root GIẢ (thư mục tạm đóng vai
 * /sys/fs/cgroup) — không chạm cgroup thật, không cần quyền root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SANDBOX_V6_CPU_PERIOD_USEC,
  SandboxV6CgroupEnforcer,
  expectedSandboxV6CpuMax,
  expectedSandboxV6MemoryMax,
  expectedSandboxV6PidsMax,
  parseSandboxV6CpuStat,
  parseSandboxV6IoStat,
  probeSandboxV6Cgroup,
  sandboxV6CpuQuotaUsec,
  sandboxV6CgroupName,
  verifySandboxV6Enforcement,
} from '../packages/core/dist/sandboxV6/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v6-cgroup-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeCgroupRoot(controllers = 'cpu memory pids io') {
  const root = makeTempDir();
  fs.writeFileSync(path.join(root, 'cgroup.controllers'), controllers, 'utf8');
  return root;
}

const QUOTA = {
  cpuPercent: 50,
  memoryBytes: 256 * 1024 * 1024,
  diskBytes: 512 * 1024 * 1024,
  maxProcesses: 32,
  maxExecMs: 60_000,
  maxWriteBytes: 64 * 1024 * 1024,
};

test.afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test('cpu quota math: 50% = 50000us per 100ms period, 0 = unlimited, tiny clamped', () => {
  assert.equal(sandboxV6CpuQuotaUsec(50), 50_000);
  assert.equal(sandboxV6CpuQuotaUsec(100), 100_000);
  assert.equal(sandboxV6CpuQuotaUsec(0), 0);
  assert.equal(sandboxV6CpuQuotaUsec(1), 1000); // clamped to kernel minimum
  assert.equal(sandboxV6CpuQuotaUsec(250), 250_000);
  assert.equal(expectedSandboxV6CpuMax(50), `50000 ${SANDBOX_V6_CPU_PERIOD_USEC}`);
  assert.equal(expectedSandboxV6CpuMax(0), `max ${SANDBOX_V6_CPU_PERIOD_USEC}`);
  assert.equal(expectedSandboxV6MemoryMax(1024), '1024');
  assert.equal(expectedSandboxV6MemoryMax(0), 'max');
  assert.equal(expectedSandboxV6PidsMax(32), '32');
  assert.equal(expectedSandboxV6PidsMax(0), 'max');
});

test('cgroup name is namespaced per bot + runtime', () => {
  const name = sandboxV6CgroupName('bot-a', '12345678-aaaa-bbbb-cccc-dddddddddddd');
  assert.ok(name.startsWith('open-bot-v6-bot-a-12345678'));
});

test('probe on a fake root: all controllers delegated -> available', () => {
  const root = makeFakeCgroupRoot();
  const probe = probeSandboxV6Cgroup({ cgroupRoot: root });
  assert.equal(probe.available, true);
  assert.equal(probe.cpu, true);
  assert.equal(probe.memory, true);
  assert.equal(probe.pids, true);
  assert.equal(probe.io, true);
  // Probe cleans up after itself.
  assert.deepEqual(fs.readdirSync(root), ['cgroup.controllers']);
});

test('probe on a fake root without memory -> available (cpu+pids), memory=false', () => {
  const root = makeFakeCgroupRoot('cpu pids');
  const probe = probeSandboxV6Cgroup({ cgroupRoot: root });
  assert.equal(probe.available, true); // cpu+pids still usable
  assert.equal(probe.memory, false);
});

test('probe on a root with no controllers -> unavailable', () => {
  const root = makeFakeCgroupRoot('');
  const probe = probeSandboxV6Cgroup({ cgroupRoot: root });
  assert.equal(probe.available, false);
  assert.match(probe.reason ?? '', /No usable controller/);
});

test('probe on a missing root -> unavailable, never throws', () => {
  const probe = probeSandboxV6Cgroup({ cgroupRoot: path.join(makeTempDir(), 'nope') });
  assert.equal(probe.available, false);
  assert.match(probe.reason ?? '', /No cgroup directory/);
});

test('enforcer create writes cpu.max / memory.max / pids.max on the fake tree', () => {
  const root = makeFakeCgroupRoot();
  const enforcer = new SandboxV6CgroupEnforcer({ cgroupRoot: root, name: 'open-bot-v6-test-1' });
  const { applied, skipped } = enforcer.create(QUOTA);
  assert.equal(enforcer.created, true);
  assert.equal(fs.readFileSync(path.join(root, 'open-bot-v6-test-1', 'cpu.max'), 'utf8'), '50000 100000');
  assert.equal(fs.readFileSync(path.join(root, 'open-bot-v6-test-1', 'memory.max'), 'utf8'), String(QUOTA.memoryBytes));
  assert.equal(fs.readFileSync(path.join(root, 'open-bot-v6-test-1', 'pids.max'), 'utf8'), '32');
  assert.ok(applied.some((a) => a.startsWith('cpu.max=')));
  assert.ok(applied.some((a) => a.startsWith('memory.max=')));
  assert.ok(applied.some((a) => a.startsWith('pids.max=')));
  assert.ok(skipped.includes('io')); // no io.max file on the fake tree
});

test('enforcer create with unlimited quota writes "max"', () => {
  const root = makeFakeCgroupRoot();
  const enforcer = new SandboxV6CgroupEnforcer({ cgroupRoot: root, name: 'open-bot-v6-test-2' });
  enforcer.create({ ...QUOTA, cpuPercent: 0, memoryBytes: 0, maxProcesses: 0 });
  assert.equal(fs.readFileSync(path.join(root, 'open-bot-v6-test-2', 'cpu.max'), 'utf8'), 'max 100000');
  assert.equal(fs.readFileSync(path.join(root, 'open-bot-v6-test-2', 'memory.max'), 'utf8'), 'max');
  assert.equal(fs.readFileSync(path.join(root, 'open-bot-v6-test-2', 'pids.max'), 'utf8'), 'max');
});

test('enforcer rejects an invalid name and a too-small memory limit', () => {
  const root = makeFakeCgroupRoot();
  assert.throws(() => new SandboxV6CgroupEnforcer({ cgroupRoot: root, name: '../evil' }), /Invalid cgroup name/);
  const enforcer = new SandboxV6CgroupEnforcer({ cgroupRoot: root, name: 'open-bot-v6-test-3' });
  assert.throws(() => enforcer.create({ ...QUOTA, memoryBytes: 512 }), /Invalid memory limit/);
});

test('enforcer setQuota rewrites limits live', () => {
  const root = makeFakeCgroupRoot();
  const enforcer = new SandboxV6CgroupEnforcer({ cgroupRoot: root, name: 'open-bot-v6-test-4' });
  enforcer.create(QUOTA);
  enforcer.setQuota({ ...QUOTA, cpuPercent: 25, memoryBytes: 128 * 1024 * 1024 });
  assert.equal(fs.readFileSync(path.join(root, 'open-bot-v6-test-4', 'cpu.max'), 'utf8'), '25000 100000');
  assert.equal(fs.readFileSync(path.join(root, 'open-bot-v6-test-4', 'memory.max'), 'utf8'), String(128 * 1024 * 1024));
});

test('enforcer addPid + readUsage parse the fake files', () => {
  const root = makeFakeCgroupRoot();
  const dir = path.join(root, 'open-bot-v6-test-5');
  const enforcer = new SandboxV6CgroupEnforcer({ cgroupRoot: root, name: 'open-bot-v6-test-5' });
  enforcer.create(QUOTA);
  enforcer.addPid(process.pid);
  assert.equal(fs.readFileSync(path.join(dir, 'cgroup.procs'), 'utf8'), String(process.pid));
  fs.writeFileSync(path.join(dir, 'cpu.stat'), 'usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'memory.current'), '12345678', 'utf8');
  fs.writeFileSync(path.join(dir, 'memory.peak'), '23456789', 'utf8');
  fs.writeFileSync(path.join(dir, 'io.stat'), '8:0 rbytes=1000 wbytes=2000 rios=3 wios=4\n', 'utf8');
  const usage = enforcer.readUsage();
  assert.equal(usage.cpuTimeUsec, 123456);
  assert.equal(usage.memoryCurrentBytes, 12345678);
  assert.equal(usage.memoryPeakBytes, 23456789);
  assert.equal(usage.processCount, 1);
  assert.equal(usage.ioReadBytes, 1000);
  assert.equal(usage.ioWriteBytes, 2000);
});

test('enforcer readUsage on an empty fake cgroup returns nulls, never throws', () => {
  const root = makeFakeCgroupRoot();
  const enforcer = new SandboxV6CgroupEnforcer({ cgroupRoot: root, name: 'open-bot-v6-test-6' });
  enforcer.create(QUOTA);
  const usage = enforcer.readUsage();
  assert.equal(usage.cpuTimeUsec, null);
  assert.equal(usage.memoryCurrentBytes, null);
  assert.equal(usage.processCount, null);
});

test('enforcer destroy removes the fake cgroup dir', () => {
  const root = makeFakeCgroupRoot();
  const enforcer = new SandboxV6CgroupEnforcer({ cgroupRoot: root, name: 'open-bot-v6-test-7' });
  enforcer.create(QUOTA);
  assert.ok(fs.existsSync(path.join(root, 'open-bot-v6-test-7')));
  enforcer.destroy();
  assert.ok(!fs.existsSync(path.join(root, 'open-bot-v6-test-7')));
});

test('cpu.stat / io.stat parsers', () => {
  assert.equal(parseSandboxV6CpuStat('usage_usec 42\nuser_usec 10\n').get('usage_usec'), 42);
  assert.deepEqual(parseSandboxV6IoStat('8:0 rbytes=100 wbytes=200\n259:0 rbytes=50 wbytes=60\n'), { readBytes: 150, writeBytes: 260 });
  assert.deepEqual(parseSandboxV6IoStat(''), { readBytes: 0, writeBytes: 0 });
});

test('enforcement verify: matching files pass, tampered file is drift', () => {
  const root = makeFakeCgroupRoot();
  const enforcer = new SandboxV6CgroupEnforcer({ cgroupRoot: root, name: 'open-bot-v6-test-8' });
  enforcer.create(QUOTA);
  const dir = path.join(root, 'open-bot-v6-test-8');
  fs.writeFileSync(path.join(dir, 'cgroup.procs'), '', 'utf8');
  const ok = verifySandboxV6Enforcement('bot-a', 'runtime-1', 'cgroup', dir, QUOTA);
  assert.equal(ok.verified, true);
  assert.deepEqual(ok.drift, []);
  // Tamper with cpu.max outside the enforcer.
  fs.writeFileSync(path.join(dir, 'cpu.max'), 'max 100000', 'utf8');
  const drifted = verifySandboxV6Enforcement('bot-a', 'runtime-1', 'cgroup', dir, QUOTA);
  assert.equal(drifted.verified, false);
  assert.equal(drifted.drift.length, 1);
  assert.equal(drifted.drift[0].file, 'cpu.max');
  assert.equal(drifted.drift[0].expected, '50000 100000');
  assert.equal(drifted.drift[0].actual, 'max 100000');
});

test('enforcement verify: missing cgroup dir and prlimit mode never fake a pass', () => {
  const missing = verifySandboxV6Enforcement('bot-a', 'runtime-1', 'cgroup', path.join(makeTempDir(), 'gone'), QUOTA);
  assert.equal(missing.verified, false);
  assert.equal(missing.cgroupExists, false);
  const degraded = verifySandboxV6Enforcement('bot-a', 'runtime-1', 'prlimit', null, QUOTA);
  assert.equal(degraded.verified, false);
  assert.ok(degraded.unreadable[0].includes('prlimit'));
});
