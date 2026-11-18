/**
 * Tests cho Sandbox v3 — tools (v1.35, Đội T2).
 *
 * Run sau khi build tools + core:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/sandbox-v3-tools.test.mjs
 *
 * Tools chia sẻ một runner: session tạo bởi create_session thì
 * pause / report / snapshot đọc được ngay trong cùng process.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SANDBOX_V3_TOOLS,
  createSandboxV3Tools,
  isSandboxV3ToolName,
} from '../packages/tools/dist/sandboxV3Tools.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v3-tools-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function toolByName(tools, name) {
  const found = tools.find((tool) => tool.definition.name === name);
  assert.ok(found, `tool ${name} must exist`);
  return found;
}

test('tools: 15 tools, unique names, correct approval flags', () => {
  assert.equal(SANDBOX_V3_TOOLS.length, 15);
  const names = SANDBOX_V3_TOOLS.map((tool) => tool.definition.name);
  assert.equal(new Set(names).size, 15);
  for (const name of names) {
    assert.ok(name.startsWith('sandbox_v3_'), name);
    assert.equal(isSandboxV3ToolName(name), true);
  }
  assert.equal(isSandboxV3ToolName('sandbox_v2_run'), false);
  assert.equal(isSandboxV3ToolName('nope'), false);
  const needsApproval = Object.fromEntries(
    SANDBOX_V3_TOOLS.map((tool) => [tool.definition.name, tool.needsApproval]),
  );
  assert.equal(needsApproval.sandbox_v3_list_policies, false);
  assert.equal(needsApproval.sandbox_v3_policy_validate, false);
  assert.equal(needsApproval.sandbox_v3_list_sessions, false);
  assert.equal(needsApproval.sandbox_v3_report, false);
  assert.equal(needsApproval.sandbox_v3_pause, false);
  assert.equal(needsApproval.sandbox_v3_resume, false);
  assert.equal(needsApproval.sandbox_v3_egress_check, false);
  assert.equal(needsApproval.sandbox_v3_syscall_check, false);
  assert.equal(needsApproval.sandbox_v3_create_session, true);
  assert.equal(needsApproval.sandbox_v3_run_command, true);
  assert.equal(needsApproval.sandbox_v3_run_step, true);
  assert.equal(needsApproval.sandbox_v3_stop, true);
  assert.equal(needsApproval.sandbox_v3_snapshot_restore, true);
  assert.equal(needsApproval.sandbox_v3_hook_register, true);
});

test('tools: list + validate policies (read-only)', async () => {
  const tools = createSandboxV3Tools(() => makeTempDir());
  const list = JSON.parse(await toolByName(tools, 'sandbox_v3_list_policies').execute({}));
  assert.equal(list.policies.length, 5);
  assert.ok(list.policies.some((p) => p.id === 'hostile' && p.minTier === 'microvm'));

  const validate = toolByName(tools, 'sandbox_v3_policy_validate');
  const good = JSON.parse(
    await validate.execute({
      policyJson: JSON.stringify(list.policies.find((p) => p.id === 'standard') && {
        id: 'standard',
        name: 'Standard',
        description: 'd',
        schemaVersion: 1,
        version: 1,
        trust: 'standard',
        minTier: 'bwrap',
        minTierLevel: 1,
        syscallMode: 'standard',
        syscalls: { allow: [], deny: [], logOnlyDeny: false },
        files: { readPrefixes: [], writePrefixes: [], denyPrefixes: [] },
        egress: {
          enabled: false,
          schemes: ['https'],
          allowedHosts: [],
          blockedHosts: [],
          allowedPorts: [],
          maxRequests: 0,
          maxBytes: 0,
          allowPrivateTargets: false,
        },
        lifetime: { maxLifetimeMs: 1800000, graceMs: 10000, idleTimeoutMs: 600000, maxPauseMs: 900000 },
        caps: { maxSteps: 500, maxSnapshots: 10, maxWriteBytes: 100, maxOutputChars: 1000 },
        hooks: [],
        commands: [],
        shellEnabled: true,
        updatedAt: new Date().toISOString(),
      }),
    }),
  );
  assert.equal(good.valid, true);
  const badJson = await validate.execute({ policyJson: '{bad' });
  assert.match(badJson, /not valid JSON/);
  const missing = await validate.execute({});
  assert.match(missing, /Missing required argument/);
});

test('tools: session lifecycle — create, step, pause, resume, snapshot, report, stop', async () => {
  const tools = createSandboxV3Tools(() => makeTempDir());
  const create = toolByName(tools, 'sandbox_v3_create_session');
  const created = JSON.parse(await create.execute({ trust: 'standard' }));
  const sessionId = created.session.id;
  assert.equal(created.session.state, 'running');

  const list = JSON.parse(await toolByName(tools, 'sandbox_v3_list_sessions').execute({}));
  assert.equal(list.sessions.length, 1);
  const filtered = JSON.parse(
    await toolByName(tools, 'sandbox_v3_list_sessions').execute({ state: 'paused' }),
  );
  assert.equal(filtered.sessions.length, 0);

  const runStep = toolByName(tools, 'sandbox_v3_run_step');
  const step = JSON.parse(
    await runStep.execute({ sessionId, tool: 'read_file', args: { path: 'a.txt' } }),
  );
  assert.equal(step.step.status, 'ok');
  assert.match(step.step.summary, /read_file/);

  const denied = JSON.parse(
    await runStep.execute({ sessionId, tool: 'evil', syscalls: ['ptrace'] }),
  );
  assert.equal(denied.step.status, 'denied');

  const pause = toolByName(tools, 'sandbox_v3_pause');
  const paused = JSON.parse(await pause.execute({ sessionId, reason: 'test pause' }));
  assert.equal(paused.paused, true);
  assert.equal(paused.session.state, 'paused');
  const skipped = JSON.parse(await runStep.execute({ sessionId, tool: 'read_file' }));
  assert.equal(skipped.step.status, 'skipped-paused');
  const resume = toolByName(tools, 'sandbox_v3_resume');
  const resumed = JSON.parse(await resume.execute({ sessionId }));
  assert.equal(resumed.resumed, true);

  const snapshot = toolByName(tools, 'sandbox_v3_snapshot');
  const snap = JSON.parse(await snapshot.execute({ sessionId, label: 'before-test' }));
  assert.equal(snap.snapshot.label, 'before-test');
  const restore = toolByName(tools, 'sandbox_v3_snapshot_restore');
  const restored = JSON.parse(
    await restore.execute({ sessionId, snapshotId: snap.snapshot.id }),
  );
  assert.equal(restored.result.snapshotId, snap.snapshot.id);

  const report = toolByName(tools, 'sandbox_v3_report');
  const json = JSON.parse(await report.execute({ sessionId }));
  assert.ok(json.summary.includes(sessionId));
  assert.ok(json.report.steps.length >= 3);
  const markdown = await report.execute({ sessionId, format: 'markdown' });
  assert.match(markdown, /Sandbox v3 report/);
  const unknown = await report.execute({ sessionId: 'no-such' });
  assert.match(unknown, /Unknown sandbox v3 session/);

  const stop = toolByName(tools, 'sandbox_v3_stop');
  const stopped = JSON.parse(await stop.execute({ sessionId, reason: 'test done' }));
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.session.state, 'stopped');
});

test('tools: egress + syscall checks (read-only, standalone or per-session)', async () => {
  const tools = createSandboxV3Tools(() => makeTempDir());
  const egress = toolByName(tools, 'sandbox_v3_egress_check');
  const standalone = JSON.parse(
    await egress.execute({
      egressPolicyJson: JSON.stringify({
        enabled: true,
        schemes: ['https'],
        allowedHosts: ['*.example.com'],
        blockedHosts: [],
        allowedPorts: [],
        maxRequests: 10,
        maxBytes: 0,
        allowPrivateTargets: false,
      }),
      url: 'https://api.example.com/x',
    }),
  );
  assert.equal(standalone.check.verdict, 'allow');
  const denied = JSON.parse(
    await egress.execute({
      egressPolicyJson: JSON.stringify({
        enabled: true,
        schemes: ['https'],
        allowedHosts: ['*.example.com'],
        blockedHosts: [],
        allowedPorts: [],
        maxRequests: 10,
        maxBytes: 0,
        allowPrivateTargets: false,
      }),
      url: 'https://evil.com/',
    }),
  );
  assert.equal(denied.check.verdict, 'deny');
  const missing = await egress.execute({ url: 'https://example.com/' });
  assert.match(missing, /Provide sessionId or egressPolicyJson/);

  const syscall = toolByName(tools, 'sandbox_v3_syscall_check');
  const checks = JSON.parse(
    await syscall.execute({ syscallMode: 'strict', syscalls: ['read', 'socket', 'ptrace'] }),
  );
  assert.equal(checks.checks[0].verdict, 'allow');
  assert.equal(checks.checks[1].verdict, 'deny');
  assert.equal(checks.checks[2].verdict, 'deny');
  assert.equal(checks.checks[2].hardDenied, true);
  const empty = await syscall.execute({ syscalls: [] });
  assert.match(empty, /must not be empty/);
});

test('tools: hook register blocks a step through the shared runner', async () => {
  const tools = createSandboxV3Tools(() => makeTempDir());
  const created = JSON.parse(
    await toolByName(tools, 'sandbox_v3_create_session').execute({ trust: 'standard' }),
  );
  const sessionId = created.session.id;
  const hook = toolByName(tools, 'sandbox_v3_hook_register');
  const registered = JSON.parse(
    await hook.execute({
      sessionId,
      name: 'block-shell',
      timing: 'pre',
      toolPattern: 'shell_*',
      decision: 'deny',
      message: 'No shell in this session.',
    }),
  );
  assert.equal(registered.name, 'block-shell');
  assert.ok(registered.hookId.length > 0);
  const blocked = JSON.parse(
    await toolByName(tools, 'sandbox_v3_run_step').execute({ sessionId, tool: 'shell_exec' }),
  );
  assert.equal(blocked.step.status, 'denied');
  const badTiming = await hook.execute({
    sessionId,
    name: 'x',
    timing: 'during',
    decision: 'deny',
  });
  assert.match(badTiming, /timing must be pre \| post/);
  const badDecision = await hook.execute({
    sessionId,
    name: 'x',
    timing: 'pre',
    decision: 'maybe',
  });
  assert.match(badDecision, /decision must be/);
});

test('tools: run_command gates the command list and reports errors as strings', async () => {
  const tools = createSandboxV3Tools(() => makeTempDir());
  const created = JSON.parse(
    await toolByName(tools, 'sandbox_v3_create_session').execute({ trust: 'standard' }),
  );
  const sessionId = created.session.id;
  const run = toolByName(tools, 'sandbox_v3_run_command');
  const step = JSON.parse(await run.execute({ sessionId, command: 'echo hello' }));
  assert.equal(step.step.status, 'ok');
  assert.match(step.step.summary, /hello/);
  const unknown = await run.execute({ sessionId: 'no-such', command: 'echo hi' });
  assert.match(unknown, /Unknown sandbox v3 session/);
  const missing = await run.execute({ sessionId });
  assert.match(missing, /Missing required argument/);
});
