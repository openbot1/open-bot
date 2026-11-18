/**
 * Tests cho Sandbox v4 — tools (v1.36, Đội T4).
 *
 * Run sau khi build tools + core:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/sandbox-v4-tools.test.mjs
 *
 * Tools chia sẻ một service: runtime tạo bởi runtime_create thì
 * budget_status / profile_set / secret_list đọc được ngay trong
 * cùng process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SANDBOX_V4_TOOLS,
  createSandboxV4Tools,
  isSandboxV4ToolName,
} from '../packages/tools/dist/sandboxV4Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v4-tools-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
}

function toolByName(tools, name) {
  const found = tools.find((tool) => tool.definition.name === name);
  assert.ok(found, `tool ${name} must exist`);
  return found;
}

async function call(tools, name, args) {
  const result = await toolByName(tools, name).execute(args);
  assert.equal(typeof result, 'string');
  return result;
}

function callJson(tools, name, args) {
  return call(tools, name, args).then((text) => {
    assert.ok(!text.startsWith('Error:'), `${name} failed: ${text}`);
    return JSON.parse(text);
  });
}

test('tools: 19 tools, unique names, correct approval flags', () => {
  assert.equal(SANDBOX_V4_TOOLS.length, 19);
  const names = SANDBOX_V4_TOOLS.map((tool) => tool.definition.name);
  assert.equal(new Set(names).size, 19);
  for (const name of names) {
    assert.ok(name.startsWith('sandbox_v4_'), name);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(name), `tool name ${name} must match [A-Za-z0-9_-]`);
    assert.equal(isSandboxV4ToolName(name), true);
  }
  assert.equal(isSandboxV4ToolName('sandbox_v3_create_session'), false);
  assert.equal(isSandboxV4ToolName('nope'), false);
  const needsApproval = Object.fromEntries(
    SANDBOX_V4_TOOLS.map((tool) => [tool.definition.name, tool.needsApproval]),
  );
  assert.equal(needsApproval.sandbox_v4_runtime_create, true);
  assert.equal(needsApproval.sandbox_v4_runtime_list, false);
  assert.equal(needsApproval.sandbox_v4_runtime_report, false);
  assert.equal(needsApproval.sandbox_v4_runtime_stop, false);
  assert.equal(needsApproval.sandbox_v4_runtime_cleanup, true);
  assert.equal(needsApproval.sandbox_v4_profile_list, false);
  assert.equal(needsApproval.sandbox_v4_profile_validate, false);
  assert.equal(needsApproval.sandbox_v4_profile_create, true);
  assert.equal(needsApproval.sandbox_v4_profile_set, false);
  assert.equal(needsApproval.sandbox_v4_budget_status, false);
  assert.equal(needsApproval.sandbox_v4_budget_set_limits, true);
  assert.equal(needsApproval.sandbox_v4_budget_record, false);
  assert.equal(needsApproval.sandbox_v4_secret_request, false);
  assert.equal(needsApproval.sandbox_v4_secret_approve, true);
  assert.equal(needsApproval.sandbox_v4_secret_deny, false);
  assert.equal(needsApproval.sandbox_v4_secret_list, false);
  assert.equal(needsApproval.sandbox_v4_depmap_build, false);
  assert.equal(needsApproval.sandbox_v4_depmap_order, false);
  assert.equal(needsApproval.sandbox_v4_depmap_conflicts, false);
});

test('tools: ALL_TOOLS contains all 19 v4 tools, total 825, no duplicates', () => {
  for (const name of SANDBOX_V4_TOOLS.map((t) => t.definition.name)) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `ALL_TOOLS missing ${name}`);
  }
  assert.equal(ALL_TOOLS.length, 899); // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
});

test('tools: createDefaultTools binds v4 tools without duplicating names', () => {
  const dir = makeTempDir();
  try {
    const bound = createDefaultTools({ getSandboxV4BaseDir: () => dir });
    assert.equal(bound.length, ALL_TOOLS.length);
    for (const name of SANDBOX_V4_TOOLS.map((t) => t.definition.name)) {
      assert.equal(bound.filter((t) => t.definition.name === name).length, 1, `${name} duplicated after binding`);
    }
    const unbound = createSandboxV4Tools();
    assert.equal(unbound.length, 19);
  } finally {
    cleanupTempDirs();
  }
});

test('tools: runtime lifecycle end-to-end (create/list/report/stop/cleanup)', async () => {
  const dir = makeTempDir();
  try {
    const tools = createSandboxV4Tools(() => dir);
    const created = await callJson(tools, 'sandbox_v4_runtime_create', {
      conversationId: 'conv-tools',
      profileId: 'coder',
      budgetMaxCostUsd: 0.01,
    });
    assert.equal(created.runtime.conversationId, 'conv-tools');
    assert.equal(created.runtime.state, 'running');
    assert.equal(created.runtime.profileId, 'coder');
    assert.ok(fs.existsSync(created.runtime.workdir));

    const duplicate = await call(tools, 'sandbox_v4_runtime_create', { conversationId: 'conv-tools' });
    assert.match(duplicate, /already has a live runtime/);

    const listed = await callJson(tools, 'sandbox_v4_runtime_list', {});
    assert.equal(listed.runtimes.length, 1);

    const md = await call(tools, 'sandbox_v4_runtime_report', { conversationId: 'conv-tools', format: 'markdown' });
    assert.match(md, /# Sandbox v4 runtime — conv-tools/);
    assert.match(md, /## Budget/);

    const stopped = await callJson(tools, 'sandbox_v4_runtime_stop', { conversationId: 'conv-tools', reason: 'test done' });
    assert.equal(stopped.stopped, true);
    const afterStop = await callJson(tools, 'sandbox_v4_runtime_report', { conversationId: 'conv-tools' });
    assert.equal(afterStop.runtime.state, 'stopped');

    const cleaned = await callJson(tools, 'sandbox_v4_runtime_cleanup', { conversationId: 'conv-tools' });
    assert.equal(cleaned.cleaned, true);
    assert.equal(fs.existsSync(created.runtime.workdir), false);

    const unknown = await call(tools, 'sandbox_v4_runtime_report', { conversationId: 'nope' });
    assert.match(unknown, /No sandbox v4 runtime/);
    const badId = await call(tools, 'sandbox_v4_runtime_create', { conversationId: '../escape' });
    assert.match(badId, /Invalid conversationId/);
  } finally {
    cleanupTempDirs();
  }
});

test('tools: profiles end-to-end (list/validate/create/set)', async () => {
  const dir = makeTempDir();
  try {
    const tools = createSandboxV4Tools(() => dir);
    const listed = await callJson(tools, 'sandbox_v4_profile_list', {});
    assert.equal(listed.profiles.length, 5);
    assert.ok(listed.profiles.some((p) => p.id === 'coder'));

    const good = JSON.stringify({
      id: 'tools-tester',
      name: 'Tools Tester',
      persona: 'You test things.',
      instructions: 'Test everything twice.',
      skillIds: ['code-read', 'code-test'],
      llm: { model: 'gpt-4o', temperature: 0.2, maxTokens: 1024, topP: 1, timeoutMs: 60000 },
    });
    const valid = await callJson(tools, 'sandbox_v4_profile_validate', { profileJson: good });
    assert.equal(valid.valid, true);
    assert.deepEqual(valid.problems, []);
    const invalid = await callJson(tools, 'sandbox_v4_profile_validate', {
      profileJson: JSON.stringify({ id: 'x', skillIds: ['nope'] }),
    });
    assert.equal(invalid.valid, false);
    assert.ok(invalid.problems.length > 0);
    const badJson = await call(tools, 'sandbox_v4_profile_validate', { profileJson: '{oops' });
    assert.match(badJson, /not valid JSON/);

    const created = await callJson(tools, 'sandbox_v4_profile_create', { profileJson: good });
    assert.equal(created.profile.id, 'tools-tester');
    const listed2 = await callJson(tools, 'sandbox_v4_profile_list', {});
    assert.equal(listed2.profiles.length, 6);

    await callJson(tools, 'sandbox_v4_runtime_create', { conversationId: 'conv-prof' });
    const set = await callJson(tools, 'sandbox_v4_profile_set', { conversationId: 'conv-prof', profileId: 'tools-tester' });
    assert.equal(set.runtime.profileId, 'tools-tester');
    assert.match(set.systemPrompt, /You test things/);
    const unknownProfile = await call(tools, 'sandbox_v4_profile_set', { conversationId: 'conv-prof', profileId: 'nope' });
    assert.match(unknownProfile, /Unknown agent profile/);
  } finally {
    cleanupTempDirs();
  }
});

test('tools: budget end-to-end (record → warning/blocked → raise limits)', async () => {
  const dir = makeTempDir();
  try {
    const tools = createSandboxV4Tools(() => dir);
    await callJson(tools, 'sandbox_v4_runtime_create', {
      conversationId: 'conv-budget',
      budgetMaxCostUsd: 0.01,
    });
    const ok = await callJson(tools, 'sandbox_v4_budget_record', {
      conversationId: 'conv-budget',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 10,
    });
    assert.equal(ok.status, 'ok');
    const blocked = await callJson(tools, 'sandbox_v4_budget_record', {
      conversationId: 'conv-budget',
      model: 'gpt-4o',
      inputTokens: 100000,
      outputTokens: 0,
    });
    assert.equal(blocked.status, 'soft-blocked');
    assert.deepEqual(blocked.blockedDimensions, ['costUsd']);
    const status = await callJson(tools, 'sandbox_v4_budget_status', { conversationId: 'conv-budget' });
    assert.equal(status.status, 'soft-blocked');
    const md = await call(tools, 'sandbox_v4_budget_status', { conversationId: 'conv-budget', format: 'markdown' });
    assert.match(md, /soft-blocked/);
    const raised = await callJson(tools, 'sandbox_v4_budget_set_limits', {
      conversationId: 'conv-budget',
      maxCostUsd: 10,
    });
    assert.equal(raised.state.status, 'ok');
    const badLimits = await call(tools, 'sandbox_v4_budget_set_limits', {
      conversationId: 'conv-budget',
      maxCostUsd: -1,
    });
    assert.match(badLimits, /Invalid budget limits/);
  } finally {
    cleanupTempDirs();
  }
});

test('tools: secrets end-to-end — value never appears in any tool result', async () => {
  const dir = makeTempDir();
  const SECRET = 'ghp_TOOL_SECRET_XYZ_789';
  try {
    const tools = createSandboxV4Tools(() => dir);
    await callJson(tools, 'sandbox_v4_runtime_create', { conversationId: 'conv-secret' });
    const requested = await callJson(tools, 'sandbox_v4_secret_request', {
      conversationId: 'conv-secret',
      name: 'GITHUB_TOKEN',
      purpose: 'Push a branch.',
    });
    const requestId = requested.request.id;
    assert.equal(requested.request.status, 'pending');
    assert.ok(!JSON.stringify(requested).includes(SECRET));

    const approved = await callJson(tools, 'sandbox_v4_secret_approve', { requestId, value: SECRET });
    assert.equal(approved.request.status, 'fulfilled');
    assert.ok(!JSON.stringify(approved).includes(SECRET), 'approve result must never echo the value');

    const listed = await callJson(tools, 'sandbox_v4_secret_list', { conversationId: 'conv-secret' });
    assert.equal(listed.requests.length, 1);
    assert.equal(listed.requests[0].status, 'fulfilled');
    assert.equal(listed.liveValues, 1);
    assert.ok(!JSON.stringify(listed).includes(SECRET), 'list result must never carry the value');

    const deniedReq = await callJson(tools, 'sandbox_v4_secret_request', {
      conversationId: 'conv-secret',
      name: 'OTHER_KEY',
      purpose: 'Nope.',
    });
    const denied = await callJson(tools, 'sandbox_v4_secret_deny', { requestId: deniedReq.request.id, note: 'Not needed.' });
    assert.equal(denied.request.status, 'denied');
    const pending = await callJson(tools, 'sandbox_v4_secret_list', { conversationId: 'conv-secret', pendingOnly: true });
    assert.equal(pending.requests.length, 0);

    const doubleApprove = await call(tools, 'sandbox_v4_secret_approve', { requestId, value: SECRET });
    assert.match(doubleApprove, /not pending/);
    const unknown = await call(tools, 'sandbox_v4_secret_approve', { requestId: 'nope', value: 'x' });
    assert.match(unknown, /Unknown secret request/);
  } finally {
    cleanupTempDirs();
  }
});

test('tools: depmap end-to-end (build/order/conflicts)', async () => {
  const dir = makeTempDir();
  const tree = makeTempDir('open-bot-sandbox-v4-tree-');
  try {
    fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'src', 'c.ts'), 'export const c = 1;\n');
    fs.writeFileSync(path.join(tree, 'src', 'b.ts'), "import { c } from './c';\nexport const b = c;\n");
    fs.writeFileSync(path.join(tree, 'src', 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
    const tools = createSandboxV4Tools(() => dir);

    const built = await callJson(tools, 'sandbox_v4_depmap_build', { rootDir: tree });
    assert.equal(built.map.fileCount, 3);
    assert.equal(built.map.edgeCount, 2);
    assert.deepEqual(built.map.cycles, []);
    const md = await call(tools, 'sandbox_v4_depmap_build', { rootDir: tree, format: 'markdown' });
    assert.match(md, /# Dependency map/);

    const ordered = await callJson(tools, 'sandbox_v4_depmap_order', {
      rootDir: tree,
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    assert.deepEqual(ordered.plan.waves, [['src/c.ts'], ['src/b.ts'], ['src/a.ts']]);

    const conflicts = await callJson(tools, 'sandbox_v4_depmap_conflicts', {
      rootDir: tree,
      changeSetsJson: JSON.stringify([
        { agentId: 'agent-1', files: ['src/b.ts'], description: 'edit b' },
        { agentId: 'agent-2', files: ['src/b.ts'], description: 'also edit b' },
      ]),
    });
    assert.equal(conflicts.conflictCount, 1);
    assert.equal(conflicts.conflicts[0].kind, 'same-file');

    const impact = await callJson(tools, 'sandbox_v4_depmap_conflicts', {
      rootDir: tree,
      changeSetsJson: JSON.stringify([
        { agentId: 'agent-1', files: ['src/c.ts'], description: 'edit c' },
        { agentId: 'agent-2', files: ['src/a.ts'], description: 'edit a' },
      ]),
    });
    // c is a dependency of a: agent-2's file is inside agent-1's impact set.
    assert.equal(impact.conflictCount, 1);
    assert.equal(impact.conflicts[0].kind, 'overlapping-impact');

    const badJson = await call(tools, 'sandbox_v4_depmap_conflicts', { rootDir: tree, changeSetsJson: '{oops' });
    assert.match(badJson, /not valid JSON/);
    const missingRoot = await call(tools, 'sandbox_v4_depmap_build', { rootDir: path.join(tree, 'nope') });
    assert.match(missingRoot, /not a directory/);
  } finally {
    cleanupTempDirs();
  }
});
