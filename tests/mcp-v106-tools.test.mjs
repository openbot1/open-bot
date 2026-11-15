/**
 * Test v1.06 T2: MCP v106 agent tools (node:test).
 * Local only: the pure tools need no server; no live network.
 *
 * Build core + tools first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-v106-tools.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMcpV106Tools,
  MCP_V106_TOOLS,
} from '../packages/tools/dist/mcpV106Tools.js';

const ctx = { workspaceDir: '/tmp/open-bot-v106-test' };

function tool(name) {
  const found = MCP_V106_TOOLS.find((t) => t.definition.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

test('mcp v106 tools: factory returns 6 tools, names + approval flags', () => {
  assert.equal(createMcpV106Tools().length, 6);
  assert.equal(MCP_V106_TOOLS.length, 6);
  const names = MCP_V106_TOOLS.map((t) => t.definition.name);
  assert.deepEqual(names, [
    'mcp2_version_features',
    'mcp2_server_age',
    'mcp2_check_elicitation_schema',
    'mcp2_task_update',
    'mcp2_list_deprecated',
    'mcp2_probe_stateless',
  ]);
  assert.equal(tool('mcp2_task_update').needsApproval, true);
  assert.equal(tool('mcp2_version_features').needsApproval, false);
  assert.equal(tool('mcp2_check_elicitation_schema').needsApproval, false);
  assert.equal(tool('mcp2_list_deprecated').needsApproval, false);
  for (const t of MCP_V106_TOOLS) {
    assert.equal(t.definition.parameters.additionalProperties, false);
  }
});

test('mcp v106 tools: mcp2_version_features reports supported vs missing', async () => {
  const modern = await tool('mcp2_version_features').execute({ version: '2026-07-28' }, ctx);
  assert.match(modern, /2026-07-28/);
  assert.match(modern, /stateless/);
  assert.match(modern, /MRTR/);
  const legacy = await tool('mcp2_version_features').execute({ version: '2024-11-05' }, ctx);
  assert.match(legacy, /2024-11-05/);
  assert.match(legacy, /thiếu/);
  await assert.rejects(tool('mcp2_version_features').execute({}, ctx), /version/);
});

test('mcp v106 tools: mcp2_check_elicitation_schema refuses secrets, clears safe schemas', async () => {
  const refused = await tool('mcp2_check_elicitation_schema').execute(
    {
      schema: {
        type: 'object',
        properties: {
          nickname: { type: 'string' },
          apiKey: { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
    ctx,
  );
  assert.match(refused, /REFUSE/);
  assert.match(refused, /apiKey/);
  assert.match(refused, /password/);
  assert.match(refused, /URL-mode/);
  const safe = await tool('mcp2_check_elicitation_schema').execute(
    {
      schema: {
        type: 'object',
        properties: { nickname: { type: 'string' }, age: { type: 'integer' } },
      },
    },
    ctx,
  );
  assert.match(safe, /safe for form-mode/);
  const empty = await tool('mcp2_check_elicitation_schema').execute({ schema: {} }, ctx);
  assert.match(empty, /safe for form-mode/);
});

test('mcp v106 tools: mcp2_list_deprecated lists Roots/Sampling/Logging + replacements', async () => {
  const out = await tool('mcp2_list_deprecated').execute({}, ctx);
  assert.match(out, /2027-07-28/);
  assert.match(out, /sampling\/createMessage/);
  assert.match(out, /roots\/list/);
  assert.match(out, /notifications\/message/);
  assert.match(out, /logging\/setLevel/);
  assert.match(out, /MRTR/);
});

test('mcp v106 tools: live tools fail clearly with an unknown server (no invented server)', async () => {
  await assert.rejects(
    tool('mcp2_server_age').execute({ server: 'no-such-server' }, ctx),
    /not configured/,
  );
  await assert.rejects(
    tool('mcp2_task_update').execute({ server: 'no-such-server', taskId: 't', input: {} }, ctx),
    /not configured/,
  );
  await assert.rejects(
    tool('mcp2_probe_stateless').execute({ server: 'no-such-server' }, ctx),
    /not configured/,
  );
});
