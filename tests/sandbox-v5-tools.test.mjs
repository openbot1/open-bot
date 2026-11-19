/**
 * Tests cho Sandbox v5 — tools (v1.37, Đội T3).
 *
 * Run sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/sandbox-v5-tools.test.mjs
 *
 * Tools chạy trên service trong thư mục tạm — không chạy
 * backend thật, không chạm dữ liệu thật.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SANDBOX_V5_TOOLS,
  SANDBOX_V5_TOOL_NAMES,
  createSandboxV5Tools,
  isSandboxV5ToolName,
} from '../packages/tools/dist/sandboxV5Tools.js';
import { ALL_TOOLS } from '../packages/tools/dist/tools.js';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function toolByName(tools, name) {
  const tool = tools.find((entry) => entry.definition.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  return tool;
}

async function call(tool, args) {
  return tool.execute(args, {});
}

test('tools: 22 tools registered, names unique, in ALL_TOOLS', () => {
  assert.equal(SANDBOX_V5_TOOLS.length, 22);
  assert.equal(SANDBOX_V5_TOOL_NAMES.length, 22);
  assert.deepEqual(
    SANDBOX_V5_TOOLS.map((tool) => tool.definition.name).sort(),
    [...SANDBOX_V5_TOOL_NAMES].sort(),
  );
  assert.equal(isSandboxV5ToolName('sandbox_v5_switch'), true);
  assert.equal(isSandboxV5ToolName('sandbox_v4_switch'), false);
  const allNames = ALL_TOOLS.map((tool) => tool.definition.name);
  for (const name of SANDBOX_V5_TOOL_NAMES) {
    assert.equal(allNames.includes(name), true, `${name} must be in ALL_TOOLS`);
  }
  // No duplicate names inside the v5 set.
  assert.equal(new Set(SANDBOX_V5_TOOL_NAMES).size, 22);
});

test('tools: approval flags — mutating tools need approval, reads do not', () => {
  const needsApproval = new Map(
    SANDBOX_V5_TOOLS.map((tool) => [tool.definition.name, tool.needsApproval]),
  );
  for (const name of [
    'sandbox_v5_choice_set',
    'sandbox_v5_switch',
    'sandbox_v5_archive_create',
    'sandbox_v5_archive_restore',
    'sandbox_v5_archive_delete',
    'sandbox_v5_disk_reclaim',
    'sandbox_v5_secret_grant',
  ]) {
    assert.equal(needsApproval.get(name), true, `${name} must need approval`);
  }
  for (const name of [
    'sandbox_v5_tier_list',
    'sandbox_v5_choice_get',
    'sandbox_v5_choice_list',
    'sandbox_v5_runtime_list',
    'sandbox_v5_switch_plan',
    'sandbox_v5_archive_scan',
    'sandbox_v5_archive_list',
    'sandbox_v5_disk_status',
    'sandbox_v5_secret_list',
    'sandbox_v5_secret_audit',
  ]) {
    assert.equal(needsApproval.get(name), false, `${name} must not need approval`);
  }
});

test('tools: choice set/get/list round-trip + tier list', async (t) => {
  const base = tmpDir(t, 'sbv5-tools-');
  const tools = createSandboxV5Tools(() => base);
  const tiers = JSON.parse(await call(toolByName(tools, 'sandbox_v5_tier_list'), {}));
  assert.equal(tiers.tiers.length, 5);
  assert.equal(tiers.available.includes('local'), true);
  const set = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_choice_set'), {
      botId: 'bot-a',
      tier: 'bwrap',
      trust: 'standard',
      reason: 'test',
    }),
  );
  assert.equal(set.choice.tier, 'bwrap');
  const get = JSON.parse(await call(toolByName(tools, 'sandbox_v5_choice_get'), { botId: 'bot-a' }));
  assert.equal(get.choice.tier, 'bwrap');
  const list = JSON.parse(await call(toolByName(tools, 'sandbox_v5_choice_list'), {}));
  assert.equal(list.choices.length, 1);
  const missing = await call(toolByName(tools, 'sandbox_v5_choice_get'), { botId: 'bot-nope' });
  assert.equal(missing.startsWith('Error:'), true);
  const weak = await call(toolByName(tools, 'sandbox_v5_choice_set'), {
    botId: 'bot-b',
    tier: 'local',
    trust: 'standard',
  });
  assert.equal(weak.startsWith('Error:'), true);
});

test('tools: runtime register/list/stop + switch plan/switch end to end', async (t) => {
  const base = tmpDir(t, 'sbv5-tools-rt-');
  const tools = createSandboxV5Tools(() => base);
  const workdir = path.join(base, 'work-bot-a');
  fs.mkdirSync(workdir, { recursive: true });
  await call(toolByName(tools, 'sandbox_v5_choice_set'), { botId: 'bot-a', tier: 'bwrap' });
  const registered = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_runtime_register'), { botId: 'bot-a', workdir }),
  );
  assert.equal(registered.runtime.tier, 'bwrap');
  assert.equal(registered.runtime.state, 'created');
  const plan = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_switch_plan'), { botId: 'bot-a', tier: 'syscall-policy' }),
  );
  assert.equal(plan.plan.allowed, true);
  const stopped = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_runtime_stop'), { botId: 'bot-a', reason: 'idle' }),
  );
  assert.equal(stopped.runtime.state, 'stopped');
  const switched = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_switch'), {
      botId: 'bot-a',
      tier: 'syscall-policy',
      reason: 'needs syscall policy',
    }),
  );
  assert.equal(switched.result.switched, true);
  const listed = JSON.parse(await call(toolByName(tools, 'sandbox_v5_runtime_list'), {}));
  assert.equal(listed.runtimes[0].tier, 'syscall-policy');
  assert.equal(listed.runtimes[0].state, 'running');
});

test('tools: archive scan/create/list/restore/delete end to end', async (t) => {
  const base = tmpDir(t, 'sbv5-tools-arch-');
  const tools = createSandboxV5Tools(() => base);
  const workdir = path.join(base, 'work-bot-a');
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'notes.txt'), 'keep me', 'utf8');
  await call(toolByName(tools, 'sandbox_v5_runtime_register'), { botId: 'bot-a', workdir, tier: 'local' });
  await call(toolByName(tools, 'sandbox_v5_runtime_stop'), { botId: 'bot-a' });
  const scan = JSON.parse(await call(toolByName(tools, 'sandbox_v5_archive_scan'), { idleThresholdMs: 0 }));
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].archivable, true);
  const created = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_archive_create'), {
      botId: 'bot-a',
      idleThresholdMs: 0,
      reason: 'test',
    }),
  );
  assert.equal(created.liveRemoved, true);
  assert.equal(fs.existsSync(workdir), false);
  const listed = JSON.parse(await call(toolByName(tools, 'sandbox_v5_archive_list'), {}));
  assert.equal(listed.archives.length, 1);
  const dest = path.join(base, 'restored-bot-a');
  const restored = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_archive_restore'), {
      archiveId: listed.archives[0].id,
      destWorkdir: dest,
    }),
  );
  assert.equal(restored.result.hashVerified, true);
  assert.equal(fs.readFileSync(path.join(dest, 'notes.txt'), 'utf8'), 'keep me');
  const deleted = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_archive_delete'), { archiveId: listed.archives[0].id }),
  );
  assert.equal(deleted.deleted, true);
  assert.equal(JSON.parse(await call(toolByName(tools, 'sandbox_v5_archive_list'), {})).archives.length, 0);
});

test('tools: disk status + reclaim dry-run deletes nothing', async (t) => {
  const base = tmpDir(t, 'sbv5-tools-disk-');
  const cache = path.join(base, 'cache');
  fs.mkdirSync(path.join(cache, 'old'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'old', 'blob.bin'), 'x'.repeat(4000), 'utf8');
  const tools = createSandboxV5Tools(() => base, {
    diskBudgetBytes: 5000,
    diskHeadroomBytes: 1000,
    cacheRoots: [{ path: cache, kind: 'test-cache', policy: 'oldest-first' }],
    workspaceRoots: [],
  });
  const status = JSON.parse(await call(toolByName(tools, 'sandbox_v5_disk_status'), {}));
  assert.equal(status.status.overBudget, true);
  const dry = JSON.parse(await call(toolByName(tools, 'sandbox_v5_disk_reclaim'), { dryRun: true }));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.plan.items.length, 1);
  assert.equal(fs.existsSync(path.join(cache, 'old')), true);
  const executed = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_disk_reclaim'), { dryRun: false }),
  );
  assert.equal(executed.result.removed.length, 1);
  assert.equal(executed.result.backUnderBudget, true);
  assert.equal(fs.existsSync(path.join(cache, 'old')), false);
});

test('tools: secret grant/consume/list/end-run/audit end to end, values never leak', async (t) => {
  const base = tmpDir(t, 'sbv5-tools-sec-');
  const tools = createSandboxV5Tools(() => base);
  const secretValue = 'tool-test-secret-999';
  const granted = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_secret_grant'), {
      name: 'MY_TOKEN',
      value: secretValue,
      botId: 'bot-a',
      runId: 'run-1',
      profileId: 'coder',
      purpose: 'test',
    }),
  );
  // The grant result must not contain the value.
  assert.equal(JSON.stringify(granted).includes(secretValue), false);
  const grantId = granted.grant.id;
  const listed = JSON.parse(await call(toolByName(tools, 'sandbox_v5_secret_list'), { botId: 'bot-a' }));
  assert.equal(listed.grants.length, 1);
  assert.equal(JSON.stringify(listed).includes(secretValue), false);
  // Wrong scope denied.
  const wrong = await call(toolByName(tools, 'sandbox_v5_secret_consume'), {
    grantId,
    botId: 'bot-b',
    runId: 'run-1',
    profileId: 'coder',
  });
  assert.equal(wrong.startsWith('Error:'), true);
  // Right scope gets the value exactly once.
  const consumed = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_secret_consume'), {
      grantId,
      botId: 'bot-a',
      runId: 'run-1',
      profileId: 'coder',
    }),
  );
  assert.equal(consumed.result.value, secretValue);
  // End the run: a second grant of the same run is revoked with it.
  const granted2 = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_secret_grant'), {
      name: 'OTHER_TOKEN',
      value: 'other-secret',
      botId: 'bot-a',
      runId: 'run-1',
      profileId: 'coder',
    }),
  );
  const ended = JSON.parse(
    await call(toolByName(tools, 'sandbox_v5_secret_end_run'), { botId: 'bot-a', runId: 'run-1' }),
  );
  assert.deepEqual(ended.result.revokedGrantIds, [granted2.grant.id]);
  const audit = JSON.parse(await call(toolByName(tools, 'sandbox_v5_secret_audit'), {}));
  assert.equal(audit.chainOk, true);
  assert.equal(JSON.stringify(audit).includes(secretValue), false);
  assert.equal(JSON.stringify(audit).includes('other-secret'), false);
});
