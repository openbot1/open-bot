/**
 * Tests cho Sandbox v6 — tools (v1.38, Đội T3).
 *
 * Run sau khi build tools + core:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/sandbox-v6-tools.test.mjs
 *
 * Tools chia sẻ một service: runtime tạo bởi create thì exec /
 * report / audit đọc được ngay trong cùng process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SANDBOX_V6_TOOLS,
  createSandboxV6Tools,
  isSandboxV6ToolName,
} from '../packages/tools/dist/sandboxV6Tools.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v6-tools-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTools() {
  const baseDir = makeTempDir();
  const cgroupRoot = makeTempDir();
  fs.writeFileSync(path.join(cgroupRoot, 'cgroup.controllers'), 'cpu memory pids io', 'utf8');
  const tools = createSandboxV6Tools(() => baseDir, { cgroupRoot, allowOvercommit: true });
  return { baseDir, cgroupRoot, tools };
}

function toolByName(tools, name) {
  const found = tools.find((tool) => tool.definition.name === name);
  assert.ok(found, `tool ${name} must exist`);
  return found;
}

async function run(tools, name, args) {
  const tool = toolByName(tools, name);
  const raw = await tool.execute(args);
  if (raw.startsWith('Error:')) throw new Error(`tool ${name} failed: ${raw}`);
  return JSON.parse(raw);
}

async function runRaw(tools, name, args) {
  return toolByName(tools, name).execute(args);
}

test('tool registry: 22 tools, names + placeholders match SANDBOX_V6_TOOLS', () => {
  assert.equal(SANDBOX_V6_TOOLS.length, 22);
  const names = SANDBOX_V6_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, 22);
  for (const name of names) {
    assert.equal(isSandboxV6ToolName(name), true);
    assert.ok(name.startsWith('sandbox_v6_'));
  }
  assert.equal(isSandboxV6ToolName('sandbox_v4_runtime_create'), false);
  assert.equal(isSandboxV6ToolName('nope'), false);
  // Approval flags: mutating / secret tools need approval, reads do not.
  const needsApproval = new Set(
    SANDBOX_V6_TOOLS.filter((t) => t.needsApproval).map((t) => t.definition.name),
  );
  for (const name of [
    'sandbox_v6_runtime_create',
    'sandbox_v6_runtime_destroy',
    'sandbox_v6_quota_set',
    'sandbox_v6_exec',
    'sandbox_v6_secret_put',
    'sandbox_v6_secret_get',
    'sandbox_v6_secret_revoke',
    'sandbox_v6_secret_grant',
    'sandbox_v6_disk_reclaim',
  ]) {
    assert.ok(needsApproval.has(name), `${name} must need approval`);
  }
  for (const name of [
    'sandbox_v6_runtime_list',
    'sandbox_v6_runtime_report',
    'sandbox_v6_quota_get',
    'sandbox_v6_usage',
    'sandbox_v6_audit_query',
    'sandbox_v6_audit_summary',
    'sandbox_v6_secret_list',
  ]) {
    assert.ok(!needsApproval.has(name), `${name} must be read-only`);
  }
});

test('runtime create/list/report + quota get/set through tools', async () => {
  const { tools } = makeTools();
  const created = await run(tools, 'sandbox_v6_runtime_create', { botId: 'bot-a', preset: 'small' });
  assert.equal(created.runtime.botId, 'bot-a');
  assert.equal(created.runtime.state, 'running');
  assert.equal(created.runtime.enforcement, 'cgroup');
  const listed = await run(tools, 'sandbox_v6_runtime_list', {});
  assert.equal(listed.runtimes.length, 1);
  const quota = await run(tools, 'sandbox_v6_quota_get', { botId: 'bot-a' });
  assert.equal(quota.quota.cpuPercent, 25);
  assert.equal(typeof quota.usage.diskBytes, 'number');
  const updated = await run(tools, 'sandbox_v6_quota_set', { botId: 'bot-a', cpuPercent: 10 });
  assert.equal(updated.runtime.quota.cpuPercent, 10);
  const report = await run(tools, 'sandbox_v6_runtime_report', { botId: 'bot-a' });
  assert.equal(report.report.runtime.botId, 'bot-a');
  assert.equal(report.report.audit.totalEntries, 2); // runtime-created + quota-changed
  const md = await toolByName(tools, 'sandbox_v6_runtime_report').execute({ botId: 'bot-a', markdown: true });
  assert.match(md, /Sandbox v6 runtime/);
  assert.match(md, /bot-a/);
});

test('quota presets tool lists presets + fair share', async () => {
  const { tools } = makeTools();
  const out = await run(tools, 'sandbox_v6_quota_presets', { botCount: 2 });
  assert.ok(out.presets.tiny.includes('CPU 10%'));
  assert.ok(out.presets.unlimited.includes('CPU unlimited'));
  assert.ok(out.capacity.cpuCores >= 1);
  assert.ok(out.fairShare.cpuPercent > 0);
  assert.match(out.admission, /Admission:/);
});

test('exec + usage + audit query/summary/export through tools', async () => {
  const { tools } = makeTools();
  await run(tools, 'sandbox_v6_runtime_create', { botId: 'bot-a' });
  const exec = await run(tools, 'sandbox_v6_exec', { botId: 'bot-a', command: '/bin/echo', args: ['hi', 'tools'] });
  assert.equal(exec.result.exitCode, 0);
  assert.match(exec.result.stdout, /hi tools/);
  const usage = await run(tools, 'sandbox_v6_usage', { botId: 'bot-a' });
  assert.equal(typeof usage.usage.diskBytes, 'number');
  const query = await run(tools, 'sandbox_v6_audit_query', { botId: 'bot-a', kind: 'exec-finish' });
  assert.equal(query.entries.length, 1);
  assert.equal(query.entries[0].exitCode, 0);
  const summary = await run(tools, 'sandbox_v6_audit_summary', { botId: 'bot-a' });
  assert.equal(summary.summary.execFinishes, 1);
  assert.equal(summary.summary.chainOk, true);
  const exported = await run(tools, 'sandbox_v6_audit_export', { botId: 'bot-a' });
  assert.equal(exported.export.botId, 'bot-a');
  assert.equal(exported.export.chainOk, true);
  assert.ok(exported.export.entries.length >= 3);
  const verified = await run(tools, 'sandbox_v6_enforcement_verify', { botId: 'bot-a' });
  assert.equal(verified.enforcement.mode, 'cgroup');
  const verdict = await toolByName(tools, 'sandbox_v6_enforcement_verify').execute({ botId: 'bot-a', text: true });
  assert.match(verdict, /verified/);
});

test('exec refused for an unknown bot returns an error string, not a throw', async () => {
  const { tools } = makeTools();
  const raw = await runRaw(tools, 'sandbox_v6_exec', { botId: 'bot-nope', command: '/bin/echo', args: [] });
  assert.match(raw, /^Error: Unknown bot runtime/);
});

test('pause/resume/stop/destroy lifecycle through tools', async () => {
  const { tools } = makeTools();
  await run(tools, 'sandbox_v6_runtime_create', { botId: 'bot-a' });
  const paused = await run(tools, 'sandbox_v6_runtime_pause', { botId: 'bot-a' });
  assert.equal(paused.runtime.state, 'paused');
  const refused = await run(tools, 'sandbox_v6_exec', { botId: 'bot-a', command: '/bin/echo', args: [] });
  assert.equal(refused.result.exitCode, null);
  const resumed = await run(tools, 'sandbox_v6_runtime_resume', { botId: 'bot-a' });
  assert.equal(resumed.runtime.state, 'running');
  const stopped = await run(tools, 'sandbox_v6_runtime_stop', { botId: 'bot-a' });
  assert.equal(stopped.runtime.state, 'stopped');
  const destroyed = await run(tools, 'sandbox_v6_runtime_destroy', { botId: 'bot-a' });
  assert.equal(destroyed.runtime.state, 'destroyed');
  const listed = await run(tools, 'sandbox_v6_runtime_list', {});
  assert.equal(listed.runtimes[0].state, 'destroyed');
});

test('secret put/get/list/revoke/grant through tools, cross-bot denied', async () => {
  const { tools } = makeTools();
  await run(tools, 'sandbox_v6_runtime_create', { botId: 'bot-a' });
  await run(tools, 'sandbox_v6_runtime_create', { botId: 'bot-b' });
  const put = await run(tools, 'sandbox_v6_secret_put', {
    botId: 'bot-a', name: 'api-key', value: 'sk-tools-123', purposes: ['github'],
  });
  assert.equal(put.secret.name, 'api-key');
  assert.equal(put.secret.ownerBotId, 'bot-a');
  const list = await run(tools, 'sandbox_v6_secret_list', { botId: 'bot-a' });
  assert.equal(list.secrets.length, 1);
  assert.equal(JSON.stringify(list).includes('sk-tools-123'), false);
  const own = await run(tools, 'sandbox_v6_secret_get', { callerBotId: 'bot-a', ownerBotId: 'bot-a', name: 'api-key', purpose: 'github' });
  assert.equal(own.value, 'sk-tools-123');
  const wrongPurpose = await runRaw(tools, 'sandbox_v6_secret_get', { callerBotId: 'bot-a', ownerBotId: 'bot-a', name: 'api-key', purpose: 'slack' });
  assert.match(wrongPurpose, /^Error:/);
  const cross = await runRaw(tools, 'sandbox_v6_secret_get', { callerBotId: 'bot-b', ownerBotId: 'bot-a', name: 'api-key' });
  assert.match(cross, /^Error:/);
  assert.match(cross, /not the owner/);
  const granted = await run(tools, 'sandbox_v6_secret_grant', { botId: 'bot-a', name: 'api-key', purpose: 'slack' });
  assert.ok(granted.secret.purposes.includes('slack'));
  const revoked = await run(tools, 'sandbox_v6_secret_revoke', { botId: 'bot-a', name: 'api-key' });
  assert.equal(revoked.revoked, true);
  const gone = await runRaw(tools, 'sandbox_v6_secret_get', { callerBotId: 'bot-a', ownerBotId: 'bot-a', name: 'api-key' });
  assert.match(gone, /^Error:/);
});

test('exec with a named secret injects it as OPENBOT_SECRET_<NAME>', async () => {
  const { tools } = makeTools();
  await run(tools, 'sandbox_v6_runtime_create', { botId: 'bot-a' });
  await run(tools, 'sandbox_v6_secret_put', { botId: 'bot-a', name: 'api-key', value: 'sk-inject-1' });
  const exec = await run(tools, 'sandbox_v6_exec', {
    botId: 'bot-a', command: '/bin/sh', args: ['-c', 'echo $OPENBOT_SECRET_API_KEY'], secrets: ['api-key'],
  });
  assert.equal(exec.result.exitCode, 0);
  assert.match(exec.result.stdout, /sk-inject-1/);
  const query = await run(tools, 'sandbox_v6_audit_query', { botId: 'bot-a', limit: 100 });
  assert.equal(JSON.stringify(query).includes('sk-inject-1'), false);
});

test('disk reclaim dry-run through tools', async () => {
  const { tools } = makeTools();
  await run(tools, 'sandbox_v6_runtime_create', { botId: 'bot-a', quota: undefined, preset: 'tiny' });
  const reclaim = await run(tools, 'sandbox_v6_disk_reclaim', { botId: 'bot-a' });
  assert.equal(reclaim.reclaim.dryRun, true);
  assert.equal(reclaim.reclaim.fitsQuota, true);
});

test('invalid args return error strings', async () => {
  const { tools } = makeTools();
  assert.match(await runRaw(tools, 'sandbox_v6_runtime_create', { botId: 'bad id!' }), /^Error: Invalid botId/);
  assert.match(await runRaw(tools, 'sandbox_v6_runtime_create', { botId: 'bot-a', preset: 'huge' }), /^Error: Invalid preset/);
  assert.match(await runRaw(tools, 'sandbox_v6_quota_set', { botId: 'bot-a' }), /^Error: No quota field given/);
  assert.match(await runRaw(tools, 'sandbox_v6_secret_put', { botId: 'bot-a', name: 'Bad', value: 'x' }), /^Error:/);
});
