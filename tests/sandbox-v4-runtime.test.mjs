/**
 * Tests cho Sandbox v4 — per-conversation runtime (v1.36, Đội T4).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v4-runtime.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import {
  SandboxV4RuntimeManager,
  SandboxV4Service,
  defaultSandboxV4BaseDir,
  isSandboxV4RuntimeLive,
  isSandboxV4RuntimeTerminal,
} from '../packages/core/dist/sandboxV4/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v4-runtime-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
}

test('runtime: create/list/get — one live runtime per conversation, isolated workdirs', () => {
  const dir = makeTempDir();
  try {
    const manager = new SandboxV4RuntimeManager({ baseDir: dir });
    const a = manager.create('conv-alpha');
    assert.equal(a.conversationId, 'conv-alpha');
    assert.equal(a.state, 'running');
    assert.equal(a.profileId, '');
    assert.equal(a.trust, 'standard');
    assert.ok(a.sessionId.length > 0);
    assert.ok(a.workdir.startsWith(path.join(dir, 'conversations', 'conv-alpha')));
    assert.ok(fs.existsSync(a.workdir));
    assert.ok(a.deadlineMs > Date.now());

    const b = manager.create('conv-beta', { trust: 'untrusted', profileId: 'coder' });
    assert.notEqual(b.sessionId, a.sessionId);
    assert.notEqual(b.workdir, a.workdir);
    assert.equal(b.trust, 'untrusted');

    assert.equal(manager.list().length, 2);
    assert.equal(manager.getByConversation('conv-alpha')?.id, a.id);
    assert.equal(manager.get('nope'), undefined);
    assert.equal(manager.getByConversation('nope'), undefined);

    // Second live runtime for the same conversation is refused.
    assert.throws(() => manager.create('conv-alpha'), /already has a live runtime/);
    // Invalid conversation ids never become paths.
    assert.throws(() => manager.create('../escape'), /Invalid conversationId/);
    assert.throws(() => manager.create('a/b'), /Invalid conversationId/);
    assert.throws(() => manager.create(''), /Invalid conversationId/);
  } finally {
    cleanupTempDirs();
  }
});

test('runtime: pause/resume/stop — state mirrors the v3 session', () => {
  const dir = makeTempDir();
  try {
    const manager = new SandboxV4RuntimeManager({ baseDir: dir });
    const runtime = manager.create('conv-pause');
    assert.equal(manager.pause(runtime.id), true);
    assert.equal(manager.get(runtime.id)?.state, 'paused');
    assert.equal(manager.mayRunStep(runtime.id), false);
    assert.equal(manager.pause(runtime.id), false, 'cannot pause twice');
    assert.equal(manager.resume(runtime.id), true);
    assert.equal(manager.get(runtime.id)?.state, 'running');
    assert.equal(manager.mayRunStep(runtime.id), true);
    assert.equal(manager.resume(runtime.id), false, 'cannot resume while running');
    assert.equal(manager.stop(runtime.id, 'done'), true);
    assert.equal(manager.get(runtime.id)?.state, 'stopped');
    assert.equal(manager.get(runtime.id)?.endReason, 'stopped-by-user');
    assert.equal(manager.stop(runtime.id), false, 'stop is terminal');
    assert.equal(manager.mayRunStep(runtime.id), false);
  } finally {
    cleanupTempDirs();
  }
});

test('runtime: process registry — register, mark ended, stop kills live processes', async () => {
  const dir = makeTempDir();
  try {
    const manager = new SandboxV4RuntimeManager({ baseDir: dir });
    const runtime = manager.create('conv-proc');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const pid = child.pid;
    assert.ok(typeof pid === 'number' && pid > 0);
    const proc = manager.registerProcess(runtime.id, { pid, label: 'sleeper', command: 'node -e setTimeout' });
    assert.equal(proc.pid, pid);
    assert.equal(proc.endKind, 'unknown');
    assert.equal(manager.liveProcesses(runtime.id).length, 1);
    assert.equal(manager.get(runtime.id)?.liveProcesses, 1);

    // A second child that exits on its own is marked exited.
    const quick = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
    await new Promise((resolve) => quick.on('exit', resolve));
    manager.registerProcess(runtime.id, { pid: quick.pid, label: 'quick', command: 'node -e exit' });
    assert.equal(manager.markProcessEnded(runtime.id, quick.pid, 3), true);
    assert.equal(manager.markProcessEnded(runtime.id, quick.pid, 3), false, 'already ended');
    assert.equal(manager.liveProcesses(runtime.id).length, 1);

    // Stopping the runtime kills the sleeper (SIGTERM).
    const exitPromise = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    assert.equal(manager.stop(runtime.id), true);
    assert.equal(manager.liveProcesses(runtime.id).length, 0);
    const exit = await exitPromise;
    assert.equal(exit.signal, 'SIGTERM');
    assert.throws(() => manager.registerProcess('nope', { pid: 1, label: 'x', command: 'y' }), /Unknown sandbox v4 runtime/);
    assert.throws(() => manager.registerProcess(runtime.id, { pid: -1, label: 'x', command: 'y' }), /non-negative integer/);
    assert.throws(() => manager.registerProcess(runtime.id, { pid: 1, label: '', command: 'y' }), /non-empty string/);
    child.kill('SIGKILL');
  } finally {
    cleanupTempDirs();
  }
});

test('runtime: cleanup removes the workspace and drops the conversation mapping', () => {
  const dir = makeTempDir();
  try {
    const manager = new SandboxV4RuntimeManager({ baseDir: dir });
    const runtime = manager.create('conv-clean');
    fs.writeFileSync(path.join(runtime.workdir, 'note.txt'), 'hello');
    assert.equal(manager.cleanup(runtime.id), true);
    const after = manager.get(runtime.id);
    assert.equal(after?.state, 'cleaned');
    assert.equal(fs.existsSync(runtime.workdir), false);
    assert.equal(manager.getByConversation('conv-clean'), undefined);
    // A new runtime for the same conversation can start after cleanup.
    const again = manager.create('conv-clean');
    assert.equal(again.state, 'running');
    assert.notEqual(again.id, runtime.id);
    assert.equal(manager.cleanup('nope'), false);
  } finally {
    cleanupTempDirs();
  }
});

test('runtime: sweepExpired — idle timeout and lifetime deadline', () => {
  const dir = makeTempDir();
  try {
    let now = 1_000_000;
    const manager = new SandboxV4RuntimeManager({
      baseDir: dir,
      nowMs: () => now,
      idleTimeoutMs: 1000,
      // v3 enforces a minimum 60s lifetime (clampLifetime), so the
      // shortest testable deadline is 60000ms from creation.
      defaultLifetimeMs: 60000,
    });
    const idle = manager.create('conv-idle');
    const busy = manager.create('conv-busy');
    now += 1500;
    manager.heartbeat(busy.id);
    const expired = manager.sweepExpired();
    assert.deepEqual(expired, [idle.id]);
    assert.equal(manager.get(idle.id)?.state, 'expired');
    assert.equal(manager.get(idle.id)?.endReason, 'idle-timeout');
    assert.equal(manager.get(busy.id)?.state, 'running');
    // 900ms more idle time is still under the 1000ms timeout.
    now += 900;
    assert.deepEqual(manager.sweepExpired(), []);
    // The lifetime deadline (60000ms from creation) expires it anyway.
    now = 1_000_000 + 60000;
    assert.deepEqual(manager.sweepExpired(), [busy.id]);
    assert.equal(manager.get(busy.id)?.endReason, 'lifetime-cap');
  } finally {
    cleanupTempDirs();
  }
});

test('runtime: budget soft-block stops new steps until limits are raised', () => {
  const dir = makeTempDir();
  try {
    const manager = new SandboxV4RuntimeManager({ baseDir: dir });
    const runtime = manager.create('conv-budget', {
      budgetLimits: { maxInputTokens: 100, maxOutputTokens: 100, maxCostUsd: 0, maxWallMs: 0, warnAtRatio: 0.8 },
    });
    assert.equal(manager.mayRunStep(runtime.id), true);
    const recorded = manager.recordUsage(runtime.id, { model: 'gpt-4o', inputTokens: 60, outputTokens: 10 });
    assert.equal(recorded.status, 'ok');
    assert.equal(manager.mayRunStep(runtime.id), true);
    const blocked = manager.recordUsage(runtime.id, { model: 'gpt-4o', inputTokens: 50, outputTokens: 10 });
    assert.equal(blocked.status, 'soft-blocked');
    assert.equal(blocked.newlyBlocked, true);
    assert.equal(manager.mayRunStep(runtime.id), false);
    // Raising the limit unblocks.
    const problems = manager.budgetFor(runtime.id).raiseLimit('inputTokens', 1000);
    assert.deepEqual(problems, []);
    assert.equal(manager.mayRunStep(runtime.id), true);
  } finally {
    cleanupTempDirs();
  }
});

test('runtime: state helpers + default base dir', () => {
  assert.equal(isSandboxV4RuntimeLive('running'), true);
  assert.equal(isSandboxV4RuntimeLive('created'), true);
  assert.equal(isSandboxV4RuntimeLive('stopped'), false);
  assert.equal(isSandboxV4RuntimeTerminal('stopped'), true);
  assert.equal(isSandboxV4RuntimeTerminal('expired'), true);
  assert.equal(isSandboxV4RuntimeTerminal('cleaned'), true);
  assert.equal(isSandboxV4RuntimeTerminal('running'), false);
  assert.ok(defaultSandboxV4BaseDir().endsWith('open-bot-sandbox-v4'));
});

test('service: create with unknown profile fails; set profile + system prompt round-trip', () => {
  const dir = makeTempDir();
  try {
    const service = new SandboxV4Service({ baseDir: dir });
    assert.throws(() => service.createRuntime('conv-x', { profileId: 'nope' }), /Unknown agent profile/);
    const runtime = service.createRuntime('conv-x');
    assert.throws(() => service.setRuntimeProfile(runtime.id, 'nope'), /Unknown agent profile/);
    assert.equal(service.systemPromptForRuntime(runtime.id), '');
    const updated = service.setRuntimeProfile(runtime.id, 'coder');
    assert.equal(updated.profileId, 'coder');
    const prompt = service.systemPromptForRuntime(runtime.id);
    assert.match(prompt, /expert software engineer/);
    assert.match(prompt, /code-read/);
    assert.match(prompt, /gpt-4o/);
    // Cleanup also drops the conversation's secret requests.
    const req = service.secretManager().request({ conversationId: 'conv-x', name: 'K', purpose: 'test' });
    assert.equal(service.secretManager().listForConversation('conv-x').length, 1);
    assert.equal(service.cleanupRuntime(runtime.id), true);
    assert.equal(service.secretManager().listForConversation('conv-x').length, 0);
    assert.equal(service.secretManager().describe(req.id), undefined);
    assert.equal(service.cleanupRuntime('nope'), false);
  } finally {
    cleanupTempDirs();
  }
});

test('service: report carries session, budget, processes and mayRunStep', () => {
  const dir = makeTempDir();
  try {
    const service = new SandboxV4Service({ baseDir: dir });
    const runtime = service.createRuntime('conv-report', { profileId: 'planner' });
    const report = service.reportRuntime(runtime.id);
    assert.equal(report.runtime.id, runtime.id);
    assert.equal(report.runtime.profileId, 'planner');
    assert.ok(report.session);
    assert.equal(report.session?.state, 'running');
    assert.equal(report.budget.conversationId, 'conv-report');
    assert.equal(report.budget.status, 'ok');
    assert.equal(report.mayRunStep, true);
    assert.equal(report.workdirExists, true);
    assert.deepEqual(report.processes, []);
    assert.throws(() => service.reportRuntime('nope'), /Unknown sandbox v4 runtime/);
  } finally {
    cleanupTempDirs();
  }
});
