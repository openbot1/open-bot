/**
 * Tests cho Sandbox v3 — session runner (v1.35, Đội T2).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v3-runner.test.mjs
 *
 * Runner dùng đồng hồ giả (nowMs) nên lifetime / pause không phải
 * chờ thật. runCommand chạy lệnh `echo` thật trong thư mục tạm;
 * bwrap có hay không thì report vẫn nói thật isolated yes/no.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SandboxV3Runner,
  builtinPolicyV3ForTrust,
  createSandboxV3Policy,
  getBuiltinSandboxV3Policy,
  renderSandboxV3ReportMarkdown,
  summarizeSandboxV3Report,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v3-runner-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function fakeClock(startMs = 1_000_000) {
  const clock = { value: startMs };
  return { clock, nowMs: () => clock.value };
}

function makeRunner() {
  const baseDir = makeTempDir();
  const { clock, nowMs } = fakeClock();
  const runner = new SandboxV3Runner({ baseDir, nowMs });
  return { runner, baseDir, clock };
}

test('runner: create starts a running session under the builtin policy', () => {
  const { runner } = makeRunner();
  const session = runner.createSession({ trust: 'standard' });
  assert.equal(session.state, 'running');
  assert.equal(session.tier, 'bwrap');
  assert.equal(session.trust, 'standard');
  assert.equal(session.policyId, 'standard');
  assert.equal(session.deadlineMs, 1_000_000 + 30 * 60 * 1000);
  assert.equal(session.steps, 0);
  assert.equal(session.blocked, 0);
  assert.equal(runner.getSession(session.id)?.id, session.id);
  assert.equal(runner.listSessions().length, 1);
  assert.equal(runner.listSessionsByState('running').length, 1);
  assert.equal(runner.listSessionsByState('paused').length, 0);
  assert.equal(runner.getSession('no-such-id'), undefined);
  assert.equal(runner.getReport('no-such-id'), undefined);
});

test('runner: tier below the policy minimum is refused', () => {
  const { runner } = makeRunner();
  assert.throws(
    () => runner.createSession({ policyId: 'hostile', tier: 'bwrap' }),
    /below the policy minimum tier/,
  );
  assert.throws(() => runner.createSession({ policyId: 'no-such-policy' }), /Unknown sandbox v3 policy/);
  const hostile = runner.createSession({ policyId: 'hostile', tier: 'microvm' });
  assert.equal(hostile.tier, 'microvm');
});

test('runner: runStep executes through the gates and records the step', async () => {
  const { runner } = makeRunner();
  const session = runner.createSession({ trust: 'standard' });
  const step = await runner.runStep(
    session.id,
    { tool: 'read_file', args: { path: 'a.txt' }, toolCallId: 'call-1' },
    {
      syscalls: ['read', 'openat'],
      executor: async (call) => ({ output: `read ${call.args.path}`, exitCode: 0 }),
    },
  );
  assert.equal(step.status, 'ok');
  assert.equal(step.summary, 'read a.txt');
  assert.equal(step.tool, 'read_file');
  assert.ok(step.finishedAtMs >= step.startedAtMs);
  assert.equal(runner.getSession(session.id)?.steps, 1);
  const failed = await runner.runStep(
    session.id,
    { tool: 'boom', args: {} },
    { executor: async () => ({ output: 'kaboom', exitCode: 3 }) },
  );
  assert.equal(failed.status, 'error');
  assert.match(failed.summary, /exit code 3/);
  const throwing = await runner.runStep(
    session.id,
    { tool: 'boom', args: {} },
    {
      executor: async () => {
        throw new Error('executor exploded');
      },
    },
  );
  assert.equal(throwing.status, 'error');
  assert.match(throwing.summary, /executor exploded/);
});

test('runner: gates deny in order — syscall, egress, hook, pause, lifetime', async () => {
  const { runner, clock } = makeRunner();
  const strict = runner.createSession({ policyId: 'strict' });
  const badSyscall = await runner.runStep(
    strict.id,
    { tool: 'net', args: {} },
    { syscalls: ['socket'] },
  );
  assert.equal(badSyscall.status, 'denied');
  assert.match(badSyscall.summary, /socket/);
  const badEgress = await runner.runStep(
    strict.id,
    { tool: 'fetch', args: {} },
    { egress: [{ url: 'https://example.com/' }] },
  );
  assert.equal(badEgress.status, 'denied');
  assert.match(badEgress.summary, /Egress denied/);
  const dangerous = await runner.runStep(
    strict.id,
    { tool: 'evil', args: {} },
    { syscalls: ['ptrace'] },
  );
  assert.equal(dangerous.status, 'denied');
  const report = runner.getReport(strict.id);
  assert.ok(report.blockedEvents.length >= 3);
  assert.ok(report.session.blocked >= 3);

  // Hook deny beats the executor: the executor is never called.
  const { runner: runner2 } = makeRunner();
  const session2 = runner2.createSession({ trust: 'standard' });
  runner2.registerHook(session2.id, {
    name: 'block-write',
    timing: 'pre',
    matcher: { toolPattern: 'write_*' },
    decision: 'deny',
    message: 'Writes are blocked in this session.',
  });
  let called = false;
  const hooked = await runner2.runStep(
    session2.id,
    { tool: 'write_file', args: { path: 'x' } },
    {
      executor: async () => {
        called = true;
        return { output: 'written', exitCode: 0 };
      },
    },
  );
  assert.equal(hooked.status, 'denied');
  assert.equal(called, false);
  assert.match(hooked.summary, /Writes are blocked/);

  // Pause: steps are skipped, not denied; resume lets them run again.
  runner2.pauseSession(session2.id, 'coffee break');
  assert.equal(runner2.getSession(session2.id)?.state, 'paused');
  const skipped = await runner2.runStep(session2.id, { tool: 'read_file', args: {} });
  assert.equal(skipped.status, 'skipped-paused');
  assert.equal(runner2.resumeSession(session2.id), true);
  const afterResume = await runner2.runStep(
    session2.id,
    { tool: 'read_file', args: {} },
    { executor: async () => ({ output: 'ok', exitCode: 0 }) },
  );
  assert.equal(afterResume.status, 'ok');

  // Lifetime: advancing the clock past the deadline auto-stops the session.
  clock.value += 31 * 60 * 1000;
  const expired = await runner.runStep(strict.id, { tool: 'read_file', args: {} });
  assert.equal(expired.status, 'denied');
  assert.match(expired.summary, /auto-stopped/);
  const summary = runner.getSession(strict.id);
  assert.equal(summary.state, 'expired');
  assert.equal(summary.endReason, 'lifetime-cap');
});

test('runner: step budget, command list and shell-disabled policy', async () => {
  const { runner } = makeRunner();
  const tiny = createSandboxV3Policy({
    id: 'tiny', name: 'Tiny', description: 'd', trust: 'standard',
    caps: { maxSteps: 2 },
  });
  const session = runner.createSession({ policy: tiny });
  const exec = async () => ({ output: 'ok', exitCode: 0 });
  await runner.runStep(session.id, { tool: 'a', args: {} }, { executor: exec });
  await runner.runStep(session.id, { tool: 'b', args: {} }, { executor: exec });
  const over = await runner.runStep(session.id, { tool: 'c', args: {} }, { executor: exec });
  assert.equal(over.status, 'denied');
  assert.match(over.summary, /Step budget exceeded/);

  const listed = createSandboxV3Policy({
    id: 'listed', name: 'Listed', description: 'd', trust: 'standard',
    commands: ['echo'],
  });
  const session2 = runner.createSession({ policy: listed });
  const denied = await runner.runCommand(session2.id, 'rm -rf /tmp/x');
  assert.equal(denied.status, 'denied');
  assert.match(denied.summary, /not on the policy command list/);

  const hostile = runner.createSession({ policyId: 'hostile', tier: 'microvm' });
  const noShell = await runner.runCommand(hostile.id, 'echo hi');
  assert.equal(noShell.status, 'denied');
  assert.match(noShell.summary, /Shell is disabled/);
});

test('runner: runCommand runs a real command and reports isolation honestly', async () => {
  const { runner } = makeRunner();
  const session = runner.createSession({ trust: 'standard' });
  const step = await runner.runCommand(session.id, 'echo hello');
  assert.equal(step.status, 'ok');
  assert.match(step.summary, /hello/);
  const report = runner.getReport(session.id);
  assert.equal(typeof report.isolated, 'boolean');
  assert.ok(report.isolationDetail.length > 0);
  assert.match(summarizeSandboxV3Report(report), new RegExp(session.id));
  const markdown = renderSandboxV3ReportMarkdown(report);
  assert.match(markdown, /Sandbox v3 report/);
  assert.match(markdown, /echo/);
  const escaped = await runner.runCommand(session.id, 'echo hi', { cwd: '../../escape' });
  assert.equal(escaped.status, 'denied');
  assert.match(escaped.summary, /escapes the session workspace/);
  const empty = await runner.runCommand(session.id, '   ');
  assert.equal(empty.status, 'denied');
});

test('runner: snapshots capture and restore through the session', () => {
  const { runner, baseDir } = makeRunner();
  const session = runner.createSession({ trust: 'standard' });
  const workdir = path.join(baseDir, session.id);
  fs.writeFileSync(path.join(workdir, 'a.txt'), 'v1');
  const snap = runner.takeSnapshot(session.id, 'v1');
  assert.equal(snap.label, 'v1');
  assert.equal(snap.fileCount, 1);
  assert.equal(runner.listSnapshots(session.id).length, 1);
  fs.writeFileSync(path.join(workdir, 'a.txt'), 'v2');
  fs.writeFileSync(path.join(workdir, 'b.txt'), 'extra');
  const restored = runner.restoreSnapshot(session.id, snap.id);
  assert.equal(restored.restoredFiles, 1);
  assert.equal(restored.deletedFiles, 1);
  assert.equal(fs.readFileSync(path.join(workdir, 'a.txt'), 'utf8'), 'v1');
  assert.equal(fs.existsSync(path.join(workdir, 'b.txt')), false);
  assert.throws(() => runner.restoreSnapshot(session.id, 'no-such-snapshot'), /does not belong/);
  assert.throws(() => runner.takeSnapshot('no-such-session', 'x'), /Unknown sandbox v3 session/);
});

test('runner: stop, sweep, heartbeat and delete', async () => {
  const { runner, baseDir, clock } = makeRunner();
  const session = runner.createSession({ trust: 'standard' });
  assert.equal(runner.stopSession(session.id, 'operator stop'), true);
  assert.equal(runner.getSession(session.id)?.state, 'stopped');
  assert.equal(runner.getSession(session.id)?.endReason, 'killed');
  const afterStop = await runner.runStep(session.id, { tool: 'read_file', args: {} });
  assert.equal(afterStop.status, 'denied');

  const idle = runner.createSession({ trust: 'standard' });
  runner.heartbeat(idle.id);
  clock.value += 31 * 60 * 1000;
  const swept = runner.sweep();
  assert.ok(swept.includes(idle.id));
  assert.equal(runner.getSession(idle.id)?.state, 'expired');

  const workdir = path.join(baseDir, session.id);
  assert.equal(fs.existsSync(workdir), true);
  assert.equal(runner.deleteSession(session.id), true);
  assert.equal(fs.existsSync(workdir), false);
  assert.equal(runner.getSession(session.id), undefined);
  assert.equal(runner.deleteSession(session.id), false);
  assert.throws(() => runner.pauseSession('no-such', ''), /Unknown sandbox v3 session/);
});

test('runner: standalone egress / syscall checks and hook disable', () => {
  const { runner } = makeRunner();
  const session = runner.createSession({ policyId: 'trusted' });
  const allowed = runner.checkEgress(session.id, { url: 'https://registry.npmjs.org/x' });
  assert.equal(allowed.verdict, 'allow');
  assert.equal(runner.getSession(session.id)?.egressRequestsUsed, 1);
  const denied = runner.checkEgress(session.id, { url: 'https://evil.example/' });
  assert.equal(denied.verdict, 'deny');
  assert.equal(runner.checkSyscall(session.id, 'read').verdict, 'allow');
  assert.equal(runner.checkSyscall(session.id, 'ptrace').verdict, 'deny');
  const hookId = runner.registerHook(session.id, {
    name: 'block-everything',
    timing: 'pre',
    decision: 'deny',
    message: 'Blocked for the test.',
  });
  assert.equal(typeof hookId, 'string');
  assert.equal(runner.disableHook(session.id, hookId), true);
  assert.equal(runner.disableHook(session.id, 'no-such-hook'), false);
  assert.equal(getBuiltinSandboxV3Policy('trusted')?.id, 'trusted');
  assert.equal(builtinPolicyV3ForTrust('standard').id, 'standard');
});
