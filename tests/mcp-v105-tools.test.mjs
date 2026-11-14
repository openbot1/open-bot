/**
 * Test v1.05 T2: mcp_v2_* agent tools (node:test, không mạng live).
 *
 * Covers packages/tools/src/mcpV2Tools.ts:
 *  - 7 tools, đúng tên + approval flags
 *  - registry: không trùng tên với mcp2_* / tools khác
 *  - execute với workspace giả: server không cấu hình -> lỗi rõ ràng
 *  - mcp_v2_app_prefetch chạy được offline với ui:// resource
 *    (fetcher báo app-local, không gọi mạng)
 *
 * Build core + tools trước:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-v105-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createMcpV2Tools, MCP_V2_TOOLS } from '../packages/tools/dist/mcpV2Tools.js';
import { createMcpV097Tools } from '../packages/tools/dist/mcpV097Tools.js';
import { ALL_TOOLS } from '../packages/tools/dist/index.js';

const EXPECTED = [
  'mcp_v2_app_prefetch',
  'mcp_v2_discover_server',
  'mcp_v2_elicitation_respond',
  'mcp_v2_stateless_call',
  'mcp_v2_task_cancel',
  'mcp_v2_task_create',
  'mcp_v2_task_get',
];

function toolByName(tools, name) {
  return tools.find((t) => t.definition.name === name);
}

function emptyWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-v2-tools-'));
  return dir;
}

test('mcp_v2_* tools: 7 tools, correct names, approval flags, valid schemas', () => {
  const tools = createMcpV2Tools();
  assert.equal(tools.length, 7);
  const names = tools.map((t) => t.definition.name).sort();
  assert.deepEqual(names, EXPECTED);
  // No duplicate names.
  assert.equal(new Set(names).size, names.length);
  // Every tool has a non-empty description + object params.
  for (const tool of tools) {
    assert.ok(tool.definition.description.length > 20, tool.definition.name);
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(Array.isArray(tool.definition.parameters.required));
  }
  // Approval: calls that can act outside the machine need approval.
  assert.equal(toolByName(tools, 'mcp_v2_discover_server').needsApproval, false);
  assert.equal(toolByName(tools, 'mcp_v2_stateless_call').needsApproval, true);
  assert.equal(toolByName(tools, 'mcp_v2_elicitation_respond').needsApproval, true);
  assert.equal(toolByName(tools, 'mcp_v2_task_create').needsApproval, true);
  assert.equal(toolByName(tools, 'mcp_v2_task_get').needsApproval, false);
  assert.equal(toolByName(tools, 'mcp_v2_task_cancel').needsApproval, false);
  assert.equal(toolByName(tools, 'mcp_v2_app_prefetch').needsApproval, false);
  // MCP_V2_TOOLS matches the factory output.
  assert.deepEqual(
    MCP_V2_TOOLS.map((t) => t.definition.name).sort(),
    EXPECTED,
  );
});

test('registry: mcp_v2_* names do not collide with mcp2_* or ALL_TOOLS', () => {
  const v097 = createMcpV097Tools().map((t) => t.definition.name);
  for (const name of EXPECTED) {
    assert.ok(!v097.includes(name), `${name} collides with mcp2_*`);
  }
  // mcp_v2_* tools register through the coordinator's toolsMod
  // (createMcpV2Tools), like mcp2_* — they are NOT in ALL_TOOLS.
  // They must still not collide with any ALL_TOOLS name.
  const allNames = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of EXPECTED) {
    assert.ok(!allNames.includes(name), `${name} collides with ALL_TOOLS`);
  }
  const counts = new Map();
  for (const name of allNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const [, count] of counts) assert.equal(count, 1, 'ALL_TOOLS has a duplicate name');
});

test('mcp_v2_discover_server: unknown server -> clear error, no invented command', async () => {
  const dir = emptyWorkspace();
  const ctx = { workspaceDir: dir };
  const tool = toolByName(createMcpV2Tools(), 'mcp_v2_discover_server');
  await assert.rejects(
    () => tool.execute({ server: 'no-such-server' }, ctx),
    /is not configured/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mcp_v2_stateless_call / task tools: unknown server -> clear error', async () => {
  const dir = emptyWorkspace();
  const ctx = { workspaceDir: dir };
  const tools = createMcpV2Tools();
  for (const name of ['mcp_v2_stateless_call', 'mcp_v2_task_create', 'mcp_v2_task_get', 'mcp_v2_task_cancel', 'mcp_v2_elicitation_respond']) {
    const tool = toolByName(tools, name);
    const args = { server: 'no-such-server', method: 'tools/list', tool: 'x', taskId: 't-1' };
    await assert.rejects(() => tool.execute(args, ctx), /is not configured/, name);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mcp_v2_elicitation_respond: bad action rejected before connecting', async () => {
  const dir = emptyWorkspace();
  const ctx = { workspaceDir: dir };
  const tool = toolByName(createMcpV2Tools(), 'mcp_v2_elicitation_respond');
  await assert.rejects(
    () => tool.execute({ server: 's', tool: 't', action: 'maybe' }, ctx),
    /must be accept, decline, or cancel/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mcp_v2_app_prefetch: ui:// template runs offline, reports review + sandbox v2', async () => {
  const tools = createMcpV2Tools();
  const tool = toolByName(tools, 'mcp_v2_app_prefetch');
  const out = await tool.execute(
    {
      version: '1.0.0',
      template: {
        id: 'demo-card',
        serverName: 'demo',
        title: 'Demo card',
        prefetch: [{ uri: 'ui://demo/style.css', purpose: 'style' }],
        cache: { maxAgeSec: 600 },
        allowedActions: ['link-open'],
        allowedHosts: [],
      },
    },
    { workspaceDir: '/tmp' },
  );
  assert.match(out, /Demo card.*demo-card/s);
  assert.match(out, /fingerprint: [0-9a-f]{12}/);
  assert.match(out, /review: unreviewed/);
  assert.match(out, /prefetch: 0 fetched, 0 cached, 1 failed/);
  assert.match(out, /ui:\/\/demo\/style\.css.*app-local/);
  assert.match(out, /security review: risk=medium/);
  assert.match(out, /run policy: allowed \(needs user confirmation\)/);
  assert.match(out, /sandbox v2: default-src 'none'; script-src 'none'/);
});

test('mcp_v2_app_prefetch: bad declaration rejected', async () => {
  const tool = toolByName(createMcpV2Tools(), 'mcp_v2_app_prefetch');
  await assert.rejects(
    () => tool.execute({ version: '1.0.0', template: { serverName: 'x', title: 't' } }, { workspaceDir: '/tmp' }),
    /thiếu "id"/,
  );
  await assert.rejects(
    () => tool.execute({ version: '1.0.0', template: 'not-an-object' }, { workspaceDir: '/tmp' }),
    /phải là một object/,
  );
});

test('mcp_v2_app_prefetch: render-only unreviewed template reports medium risk + no network', async () => {
  // Note: declareAppTemplate always starts unreviewed, so even a
  // render-only template is medium risk (unreviewed) until reviewed.
  const tool = toolByName(createMcpV2Tools(), 'mcp_v2_app_prefetch');
  const out = await tool.execute(
    {
      version: '2.0.0',
      template: {
        id: 'static-card',
        serverName: 'demo',
        title: 'Static card',
        prefetch: [],
        cache: { maxAgeSec: 0 },
        allowedActions: [],
        allowedHosts: [],
      },
    },
    { workspaceDir: '/tmp' },
  );
  assert.match(out, /prefetch: 0 fetched, 0 cached, 0 failed/);
  assert.match(out, /security review: risk=medium, requiresWarning=true/);
  assert.match(out, /run policy: allowed \(needs user confirmation\) — App "static-card" chưa review/);
  assert.match(out, /chặn toàn bộ network \(connect-src none\)/);
});
