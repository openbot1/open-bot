/**
 * Tests cho Sandbox v2 — runner + run report (v1.34, Đội T2).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v2-runner-report.test.mjs
 *
 * Chạy lệnh thật (`node -e ...`) trong thư mục tạm, KHÔNG mạng,
 * KHÔNG bwrap (host fake: không bwrap/unshare/KVM) nên mọi lần chạy
 * đều báo isolated=false một cách trung thực. Tier 3 chỉ dry-run.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SandboxV2RunReportBuilder,
  SandboxV2Runner,
  builtinPolicyForTrust,
  renderSandboxV2ReportMarkdown,
  serializeSandboxV2Report,
  summarizeSandboxV2Report,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v2-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Host without any isolation backend — forces honest un-isolated runs. */
const NO_ISOLATION_HOST = {
  platform: 'linux',
  bwrapAvailable: false,
  unshareAvailable: false,
  kvmAvailable: false,
  cpuCount: 2,
  totalMemoryBytes: 4 * 1024 * 1024 * 1024,
  firecrackerAvailable: false,
};

const KVM_HOST = { ...NO_ISOLATION_HOST, kvmAvailable: true, bwrapAvailable: true };

function runnerFor(host = NO_ISOLATION_HOST) {
  const baseDir = makeTempDir();
  return { runner: new SandboxV2Runner({ baseDir, hostCapabilities: host }), baseDir };
}

test('runner: a real command completes and the report records tier/policy/output', async () => {
  const { runner } = runnerFor();
  const report = await runner.run({
    runId: 'run-complete',
    label: 'echo test',
    trust: 'standard',
    command: 'node',
    args: ['-e', 'console.log("hello-v2")'],
  });
  assert.equal(report.runId, 'run-complete');
  assert.equal(report.endReason, 'completed');
  assert.equal(report.exitCode, 0);
  assert.equal(report.tier, 'syscall-policy');
  assert.equal(report.policyId, 'standard');
  assert.equal(report.trust, 'standard');
  assert.match(report.stdout, /hello-v2/);
  assert.equal(report.isolated, false);
  assert.equal(report.killSwitchFired, false);
  assert.equal(report.lifetimeCapHit, false);
  assert.deepEqual(report.blocked, []);
  assert.equal(report.durationMs >= 0, true);
  assert.equal(runner.getReport('run-complete').runId, 'run-complete');
  assert.equal(runner.listReports().length, 1);
});

test('runner: dry-run selects a tier and executes nothing', async () => {
  const { runner } = runnerFor();
  const report = await runner.run({
    runId: 'run-dry',
    trust: 'standard',
    command: 'node',
    args: ['-e', 'console.log("must-not-run")'],
    dryRun: true,
  });
  assert.equal(report.endReason, 'dry-run');
  assert.equal(report.exitCode, null);
  assert.equal(report.stdout, '');
  assert.match(report.endDetail ?? '', /Dry run/);
});

test('runner: a command outside the policy allow-list is denied before execution', async () => {
  const { runner } = runnerFor();
  const report = await runner.run({
    runId: 'run-denied',
    trust: 'standard',
    command: 'rm',
    args: ['-rf', '/'],
  });
  assert.equal(report.endReason, 'policy-denied');
  assert.equal(report.exitCode, null);
  assert.match(report.endDetail ?? '', /not in the allow-list/);
  assert.equal(report.blocked.length, 1);
  assert.equal(report.blocked[0].kind, 'exec');
});

test('runner: hostile code with no KVM host is refused with a policy-denied report', async () => {
  const { runner } = runnerFor();
  const report = await runner.run({
    runId: 'run-hostile-refused',
    trust: 'hostile',
    command: 'node',
    args: ['-e', 'console.log(1)'],
  });
  assert.equal(report.endReason, 'policy-denied');
  assert.match(report.endDetail ?? '', /Refusing hostile code/);
});

test('runner: tier 3 never executes — it returns a dry-run feasibility report', async () => {
  const { runner } = runnerFor(KVM_HOST);
  const report = await runner.run({
    runId: 'run-microvm',
    trust: 'hostile',
    requestedTier: 'microvm',
    command: 'node',
    args: ['-e', 'console.log(1)'],
  });
  assert.equal(report.tier, 'microvm');
  assert.equal(report.endReason, 'dry-run');
  assert.equal(report.exitCode, null);
  assert.ok(report.microvmFeasibility);
  // No kernel/rootfs spec was given, so the dry-run must be infeasible — honestly.
  assert.equal(report.microvmFeasibility.feasible, false);
  assert.ok(report.microvmFeasibility.blockers.length > 0);
  assert.match(report.endDetail ?? '', /cannot boot/);
});

test('runner: scopes issue a token that is revoked when the run finishes', async () => {
  const { runner } = runnerFor();
  const report = await runner.run({
    runId: 'run-token',
    trust: 'standard',
    command: 'node',
    args: ['-e', 'console.log("tok")'],
    scopes: ['fs:read'],
  });
  assert.equal(report.endReason, 'completed');
  assert.equal(report.tokensIssued.length, 1);
  assert.equal(report.tokensRevoked.length, 1);
  assert.equal(report.tokensRevoked[0].id, report.tokensIssued[0]);
  assert.equal(report.tokensRevoked[0].reason, 'task-done');
});

test('runner: killRun trips the switch and the run ends as kill-switch', async () => {
  const { runner } = runnerFor();
  const promise = runner.run({
    runId: 'run-kill',
    trust: 'standard',
    command: 'node',
    args: ['-e', 'setTimeout(() => {}, 30000)'],
    caps: { maxLifetimeMs: 60_000 },
  });
  // Let the child start, then kill from "the UI".
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(runner.listLiveRuns(), ['run-kill']);
  assert.equal(runner.killRun('run-kill', 'ui', 'user pressed kill in UI'), true);
  assert.equal(runner.killRun('run-nope', 'ui'), false);
  const report = await promise;
  assert.equal(report.endReason, 'kill-switch');
  assert.equal(report.killSwitchFired, true);
  assert.equal(report.killSwitchSource, 'ui');
  assert.match(report.endDetail ?? '', /user pressed kill/);
  assert.deepEqual(runner.listLiveRuns(), []);
});

test('runner: lifetime cap kills a runaway run', async () => {
  const { runner } = runnerFor();
  const report = await runner.run({
    runId: 'run-cap',
    trust: 'standard',
    command: 'node',
    args: ['-e', 'setTimeout(() => {}, 30000)'],
    caps: { maxLifetimeMs: 800 },
  });
  assert.equal(report.endReason, 'lifetime-cap');
  assert.equal(report.lifetimeCapHit, true);
  assert.equal(report.killSwitchFired, true);
  assert.equal(report.killSwitchSource, 'lifetime-cap');
});

test('runner: failing command ends as failed with its exit code', async () => {
  const { runner } = runnerFor();
  const report = await runner.run({
    runId: 'run-fail',
    trust: 'standard',
    command: 'node',
    args: ['-e', 'process.exit(3)'],
  });
  assert.equal(report.endReason, 'failed');
  assert.equal(report.exitCode, 3);
});

test('runner: preflight denies a dangerous syscall and an off-list host', () => {
  const { runner } = runnerFor();
  const policy = builtinPolicyForTrust('standard');
  const result = runner.preflight(policy, 'syscall-policy', {
    syscalls: ['read', 'ptrace'],
    fileReads: ['ok.txt'],
    network: [{ host: 'evil.example.com' }, { host: 'registry.npmjs.org', port: 443 }],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.denied.length, 2);
  assert.ok(result.denied.some((d) => d.kind === 'syscall' && d.target === 'ptrace'));
  assert.ok(result.denied.some((d) => d.kind === 'network' && d.target.startsWith('evil.example.com')));

  const clean = runner.preflight(policy, 'syscall-policy', {
    syscalls: ['read'],
    fileReads: ['ok.txt'],
    network: [{ host: 'registry.npmjs.org', port: 443 }],
  });
  assert.equal(clean.allowed, true);
  assert.deepEqual(clean.denied, []);
});

test('report: builder records blocked events + tokens, markdown renders every section', () => {
  const builder = new SandboxV2RunReportBuilder({
    runId: 'run-md',
    label: 'manual',
    tier: 'syscall-policy',
    policyId: 'standard',
    policyVersion: 1,
    trust: 'standard',
    lifetimeCapMs: 120_000,
    isolationDetail: 'policy engine (no bwrap on host)',
    isolated: false,
  });
  builder.addBlocked({
    seq: 1,
    at: new Date().toISOString(),
    kind: 'syscall',
    target: 'ptrace',
    reason: 'always-denied list',
    tier: 'syscall-policy',
    logOnly: false,
  });
  builder.addTokenIssued('sbv2_test_1');
  builder.addTokenRevoked('sbv2_test_1', 'task-done');
  builder.setOutput('out', 'err');
  builder.setExitCode(0);
  const report = builder.finish('completed');
  assert.equal(report.blockedCounts.syscall, 1);
  assert.deepEqual(report.tokensIssued, ['sbv2_test_1']);
  assert.match(summarizeSandboxV2Report(report), /run-md/);
  assert.match(summarizeSandboxV2Report(report), /1 blocked/);
  const md = renderSandboxV2ReportMarkdown(report);
  assert.match(md, /# Sandbox v2 run report — run-md/);
  assert.match(md, /## Blocked attempts \(1\)/);
  assert.match(md, /ptrace/);
  assert.match(md, /## Credentials \(1 issued, 1 revoked\)/);
  assert.match(md, /## Output/);
  const parsed = JSON.parse(serializeSandboxV2Report(report));
  assert.equal(parsed.runId, 'run-md');
  assert.equal(parsed.endReason, 'completed');
});
