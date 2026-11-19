/**
 * Tests cho Sandbox v6 — per-bot runtime manager (v1.38, Đội T3).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v6-runtime.test.mjs
 *
 * Exec tests run real commands through the BotBox (plain /
 * prlimit backend on this VM — no bwrap needed). The cgroup
 * assertions run against a fake cgroup root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SANDBOX_V6_DEFAULT_QUOTA,
  SANDBOX_V6_QUOTA_PRESETS,
  SandboxV6Service,
  checkSandboxV6Admission,
  formatSandboxV6Bytes,
  formatSandboxV6Duration,
  probeSandboxV6HostCapacity,
  resolveSandboxV6Quota,
  suggestSandboxV6FairShare,
} from '../packages/core/dist/sandboxV6/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v6-runtime-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeCgroupRoot(controllers = 'cpu memory pids io') {
  const root = makeTempDir();
  fs.writeFileSync(path.join(root, 'cgroup.controllers'), controllers, 'utf8');
  return root;
}

test.afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeService(opts = {}) {
  const baseDir = makeTempDir();
  const cgroupRoot = makeFakeCgroupRoot();
  const service = new SandboxV6Service({ baseDir, cgroupRoot, allowOvercommit: true, ...opts });
  return { baseDir, cgroupRoot, service };
}

test('resolveSandboxV6Quota: defaults, presets, validation', () => {
  assert.deepEqual(resolveSandboxV6Quota({}), SANDBOX_V6_DEFAULT_QUOTA);
  assert.equal(resolveSandboxV6Quota({ cpuPercent: 0 }).cpuPercent, 0);
  assert.equal(resolveSandboxV6Quota({ memoryBytes: 0 }).memoryBytes, 0);
  assert.deepEqual(resolveSandboxV6Quota({ cpuPercent: 25 }), { ...SANDBOX_V6_DEFAULT_QUOTA, cpuPercent: 25 });
  assert.throws(() => resolveSandboxV6Quota({ cpuPercent: -5 }), /Invalid quota cpuPercent/);
  assert.throws(() => resolveSandboxV6Quota({ memoryBytes: 100 }), /below the minimum/);
  assert.throws(() => resolveSandboxV6Quota({ maxProcesses: 2 }), /below the minimum/);
  assert.throws(() => resolveSandboxV6Quota({ maxExecMs: 10 }), /Invalid quota maxExecMs/);
  assert.equal(SANDBOX_V6_QUOTA_PRESETS.tiny.cpuPercent, 10);
  assert.equal(SANDBOX_V6_QUOTA_PRESETS.unlimited.cpuPercent, 0);
  assert.equal(formatSandboxV6Bytes(1536), '1.5 KiB');
  assert.equal(formatSandboxV6Bytes(1024 * 1024), '1 MiB');
  assert.equal(formatSandboxV6Duration(1500), '1.5s');
  assert.equal(formatSandboxV6Duration(90_000), '1m 30s');
});

test('create: one live runtime per bot, idempotent, quota + enforcement recorded', () => {
  const { service, cgroupRoot } = makeService();
  const r1 = service.createRuntime('bot-a', { preset: 'small' });
  assert.equal(r1.botId, 'bot-a');
  assert.equal(r1.state, 'running');
  assert.equal(r1.quota.cpuPercent, 25);
  assert.equal(r1.enforcement, 'cgroup');
  assert.ok(r1.cgroupName.startsWith('open-bot-v6-bot-a-'));
  assert.ok(fs.existsSync(path.join(cgroupRoot, r1.cgroupName)));
  // Second create returns the same live runtime (no duplicate cgroup).
  const r2 = service.createRuntime('bot-a', { preset: 'large' });
  assert.equal(r2.id, r1.id);
  assert.equal(r2.quota.cpuPercent, 25);
  assert.equal(fs.readdirSync(cgroupRoot).filter((n) => n.startsWith('open-bot-v6-')).length, 1);
  assert.throws(() => service.createRuntime('bad id!'), /Invalid botId/);
});

test('create without cgroup delegation degrades to prlimit and says so', () => {
  const baseDir = makeTempDir();
  const emptyRoot = makeFakeCgroupRoot('');
  const service = new SandboxV6Service({ baseDir, cgroupRoot: emptyRoot, allowOvercommit: true });
  const runtime = service.createRuntime('bot-a');
  assert.equal(runtime.enforcement, 'prlimit');
  assert.match(runtime.enforcementReason ?? '', /No usable controller/);
  assert.equal(runtime.cgroupName, '');
});

test('exec runs a real command, audits start+finish, reports usage', async () => {
  const { service } = makeService();
  service.createRuntime('bot-a');
  const result = await service.execRaw('bot-a', '/bin/echo', ['hello', 'v5']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello v5/);
  assert.equal(result.timedOut, false);
  assert.equal(result.botId, 'bot-a');
  assert.ok(result.durationMs >= 0);
  assert.ok(result.auditId.length > 0);
  const runtime = service.getRuntime('bot-a');
  assert.equal(runtime.execCount, 1);
  assert.equal(runtime.refusedCount, 0);
  const entries = service.queryAudit('bot-a', {});
  assert.ok(entries.some((e) => e.kind === 'exec-start'));
  assert.ok(entries.some((e) => e.kind === 'exec-finish' && e.exitCode === 0));
  const summary = service.auditSummary('bot-a');
  assert.equal(summary.execStarts, 1);
  assert.equal(summary.execFinishes, 1);
  assert.equal(summary.chainOk, true);
  const usage = service.getUsage('bot-a');
  assert.equal(typeof usage.diskBytes, 'number');
  assert.ok(usage.diskFiles >= 0);
});

test('exec exit code is recorded; failing command is not an error', async () => {
  const { service } = makeService();
  service.createRuntime('bot-a');
  const result = await service.execRaw('bot-a', '/bin/false', []);
  assert.equal(result.exitCode, 1);
  const summary = service.auditSummary('bot-a');
  assert.deepEqual(summary.exitCodes, { 1: 1 });
});

test('exec with a bot secret: value reaches the process, never the audit log', async () => {
  const { service } = makeService();
  service.createRuntime('bot-a');
  const secretValue = 'sk-test-9f8e7d6c5b4a';
  service.putSecret('bot-a', 'api-key', secretValue, { purposes: ['shell'] });
  const result = await service.exec('bot-a', '/bin/sh', ['-c', 'echo $OPENBOT_SECRET_API_KEY'], {
    secrets: [{ name: 'api-key', purpose: 'shell' }],
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(secretValue));
  // The audit log must not contain the value anywhere.
  const entries = service.queryAudit('bot-a', { limit: 100 });
  assert.ok(entries.length > 0);
  assert.equal(JSON.stringify(entries).includes(secretValue), false);
  // A secret the bot does not own aborts the exec before spawn.
  service.createRuntime('bot-b');
  await assert.rejects(
    () => service.exec('bot-b', '/bin/echo', ['x'], { secrets: [{ name: 'api-key' }] }),
    /secret "api-key" unavailable/,
  );
  assert.equal(service.getRuntime('bot-b').execCount, 0);
});

test('exec refused when paused / stopped, and when the disk quota is blown', async () => {
  const { service } = makeService();
  service.createRuntime('bot-a', { quota: { diskBytes: 1024 * 1024 } });
  service.pauseRuntime('bot-a');
  const paused = await service.execRaw('bot-a', '/bin/echo', ['x']);
  assert.equal(paused.exitCode, null);
  assert.equal(service.getRuntime('bot-a').refusedCount, 1);
  service.resumeRuntime('bot-a');
  const ok = await service.execRaw('bot-a', '/bin/echo', ['x']);
  assert.equal(ok.exitCode, 0);
  // Fill the workspace past the quota, then exec is refused.
  const workdir = service.getRuntime('bot-a').workdir;
  fs.writeFileSync(path.join(workdir, 'big.bin'), 'x'.repeat(2 * 1024 * 1024));
  const refused = await service.execRaw('bot-a', '/bin/echo', ['x']);
  assert.equal(refused.exitCode, null);
  assert.equal(service.getRuntime('bot-a').refusedCount, 2);
  const entries = service.queryAudit('bot-a', { kind: 'exec-refused' });
  assert.ok(entries.length >= 2);
  assert.ok(entries.some((e) => e.detail.includes('Disk quota')));
  // Stop refuses too.
  service.stopRuntime('bot-a');
  const stopped = await service.execRaw('bot-a', '/bin/echo', ['x']);
  assert.equal(stopped.exitCode, null);
});

test('setQuota rewrites the cgroup live and is audited; invalid quota rejected', () => {
  const { service, cgroupRoot } = makeService();
  const runtime = service.createRuntime('bot-a');
  const updated = service.setQuota('bot-a', { ...runtime.quota, cpuPercent: 10 });
  assert.equal(updated.quota.cpuPercent, 10);
  assert.equal(
    fs.readFileSync(path.join(cgroupRoot, runtime.cgroupName, 'cpu.max'), 'utf8'),
    '10000 100000',
  );
  const entries = service.queryAudit('bot-a', { kind: 'quota-changed' });
  assert.equal(entries.length, 1);
  assert.match(entries[0].detail, /CPU 50% -> 10%/);
  assert.throws(() => service.setQuota('bot-a', { cpuPercent: -1 }), /Invalid quota/);
  assert.throws(() => service.setQuota('bot-nope', { cpuPercent: 10 }), /Unknown bot runtime/);
});

test('secret scoping through the service: cross-bot read denied + audited', () => {
  const { service } = makeService();
  service.createRuntime('bot-a');
  service.createRuntime('bot-b');
  service.putSecret('bot-a', 'token', 'tok-abc-123');
  const denied = service.getSecret('bot-b', 'bot-a', 'token');
  assert.equal(denied.allowed, false);
  assert.equal(denied.value, undefined);
  const own = service.getSecret('bot-a', 'bot-a', 'token');
  assert.equal(own.allowed, true);
  assert.equal(own.value, 'tok-abc-123');
  const entries = service.queryAudit('bot-a', { kind: 'secret-access-denied' });
  assert.ok(entries.length >= 1);
  assert.equal(JSON.stringify(service.listSecrets('bot-a')).includes('tok-abc-123'), false);
  // Grant a purpose, then purpose-gated read works.
  service.grantSecretPurpose('bot-a', 'token', 'github');
  assert.equal(service.getSecret('bot-a', 'bot-a', 'token', 'github').allowed, true);
  assert.equal(service.getSecret('bot-a', 'bot-a', 'token', 'slack').allowed, false);
  assert.equal(service.revokeSecret('bot-a', 'token'), true);
  assert.equal(service.getSecret('bot-a', 'bot-a', 'token').allowed, false);
});

test('destroy removes box + cgroup + secrets but keeps the audit log', async () => {
  const { service, baseDir, cgroupRoot } = makeService();
  const runtime = service.createRuntime('bot-a');
  service.putSecret('bot-a', 'token', 'tok-xyz');
  await service.execRaw('bot-a', '/bin/echo', ['hi']);
  const destroyed = service.destroyRuntime('bot-a');
  assert.equal(destroyed.state, 'destroyed');
  assert.ok(!fs.existsSync(path.join(cgroupRoot, runtime.cgroupName)));
  assert.ok(!fs.existsSync(runtime.workdir));
  // Secrets are gone (fresh store would be empty) — the runtime is gone too.
  assert.equal(service.getRuntime('bot-a').state, 'destroyed');
  // But the audit log survives on disk.
  const auditFile = path.join(baseDir, 'bots', 'bot-a', 'audit', 'audit.jsonl');
  assert.ok(fs.existsSync(auditFile));
  assert.ok(fs.readFileSync(auditFile, 'utf8').includes('runtime-destroyed'));
  // Re-creating the bot starts fresh (new runtime id, audit continues on the same file).
  const recreated = service.createRuntime('bot-a');
  assert.notEqual(recreated.id, runtime.id);
  assert.equal(recreated.state, 'running');
});

test('sweepIdle stops idle runtimes; heartbeat prevents it', () => {
  let now = 10_000_000;
  const { service } = makeService({ nowMs: () => now, idleTimeoutMs: 1000 });
  service.createRuntime('bot-a');
  service.createRuntime('bot-b');
  now += 500;
  service.heartbeat('bot-a');
  now += 600; // bot-a idle 600ms, bot-b idle 1100ms
  const swept = service.sweepIdle();
  assert.deepEqual(swept.stopped, ['bot-b']);
  assert.equal(service.getRuntime('bot-a').state, 'running');
  assert.equal(service.getRuntime('bot-b').state, 'stopped');
});

test('verifyEnforcement detects drift after an external edit', async () => {
  const { service, cgroupRoot } = makeService();
  const runtime = service.createRuntime('bot-a');
  // Run one exec so the spawn hook creates cgroup.procs (a real
  // cgroup always has it; the fake tree needs it written once).
  await service.execRaw('bot-a', '/bin/echo', ['hi']);
  const ok = service.verifyEnforcement('bot-a');
  assert.equal(ok.verified, true);
  fs.writeFileSync(path.join(cgroupRoot, runtime.cgroupName, 'memory.max'), 'max', 'utf8');
  const drifted = service.verifyEnforcement('bot-a');
  assert.equal(drifted.verified, false);
  assert.equal(drifted.drift[0].file, 'memory.max');
  const all = service.verifyAllEnforcement();
  assert.equal(all.length, 1);
  assert.equal(all[0].verified, false);
});

test('admission: a quota the host cannot hold is refused (service level)', () => {
  const { service } = makeService({ allowOvercommit: false });
  assert.throws(
    () => service.createRuntime('bot-huge', { quota: { memoryBytes: 1024 * 1024 * 1024 * 1024 } }),
    /host admission/,
  );
  // Direct check with an explicit tiny capacity (256 MiB RAM,
  // so the 512 MiB default quota does not fit, but 64 MiB does).
  const tiny = { cpuCores: 1, memoryBytes: 256 * 1024 * 1024, diskFreeBytes: 0, source: 'test' };
  const refused = checkSandboxV6Admission([], SANDBOX_V6_DEFAULT_QUOTA, tiny);
  assert.equal(refused.admitted, false);
  assert.ok(refused.reasons.some((r) => r.startsWith('RAM:')));
  const admitted = checkSandboxV6Admission([], { ...SANDBOX_V6_DEFAULT_QUOTA, memoryBytes: 64 * 1024 * 1024 }, tiny);
  assert.equal(admitted.admitted, true);
});

test('host capacity probe + fair share are sane on this machine', () => {
  const capacity = probeSandboxV6HostCapacity();
  assert.ok(capacity.cpuCores >= 1);
  assert.ok(capacity.memoryBytes > 0);
  const share = suggestSandboxV6FairShare(4, capacity);
  assert.ok(share.cpuPercent > 0);
  assert.ok(share.memoryBytes > 0);
  assert.ok(share.memoryBytes <= capacity.memoryBytes);
});

test('report + export + reclaim flow end to end', async () => {
  const { service } = makeService();
  service.createRuntime('bot-a');
  await service.execRaw('bot-a', '/bin/echo', ['hi']);
  const report = service.report('bot-a');
  assert.equal(report.runtime.botId, 'bot-a');
  assert.equal(report.audit.execFinishes, 1);
  assert.deepEqual(report.secrets, []);
  const bundle = service.exportAudit('bot-a');
  assert.equal(bundle.botId, 'bot-a');
  assert.ok(bundle.entries.length >= 2);
  assert.equal(bundle.chainOk, true);
  const reclaim = service.reclaimDisk('bot-a', { quotaBytes: report.runtime.quota.diskBytes });
  assert.equal(reclaim.dryRun, true);
  assert.equal(reclaim.fitsQuota, true);
  // Unknown bot errors are clear, not crashes.
  assert.throws(() => service.report('bot-nope'), /Unknown bot runtime/);
  assert.throws(() => service.exportAudit('bot-nope'), /Unknown bot runtime/);
});
