/**
 * Fleet v8 tools tests (v1.11, Đội T6 — node:test, no network).
 *
 * Covers:
 *  - Registry: all 13 fleet v8 tools in ALL_TOOLS (302 total), unique
 *    names, no duplicates; createDefaultTools({ getFleetV8BaseDir })
 *    binds them without duplicating (same 13 names, same total)
 *  - Unbound file tools answer NOT_WIRED; the 8 pure tools (node
 *    probe/health/rebalance, mock toolkit list/execute, poll policy,
 *    SambaNova models) work unbound
 *  - Bound end-to-end flow on a tmp userData dir: dashboard →
 *    incident record/list → connection disconnect/reconnect/list,
 *    with state persisted to fleet-incidents-v111.jsonl and
 *    composio-connections-v111.json
 *  - Tool arg validation: missing args / bad enum / unknown toolkit
 *    return Error strings, never throw
 *  - Mock toolkit tools: list returns 6 mock toolkits; execute runs
 *    mock data; unknown slug returns an Error string
 *  - provider_sambanova_models returns baseUrl/default/known models
 *  - Approval flags: writes need approval, reads do not
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v111-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { FLEET_V8_TOOLS, createFleetV8Tools } from '../packages/tools/dist/fleetV8Tools.js';

const V8_NAMES = [
  'fleet_node_probe',
  'fleet_node_health',
  'fleet_node_rebalance',
  'fleet_dashboard',
  'fleet_incident_list',
  'fleet_incident_record',
  'composio_mock_toolkit_list_v111',
  'composio_mock_toolkit_execute_v111',
  'composio_connection_list',
  'composio_connection_disconnect',
  'composio_connection_reconnect',
  'composio_poll_policy',
  'provider_sambanova_models',
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v111-tools-'));
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tools, name, args) {
  return toolByName(tools, name).execute(args, {});
}

function toolNames(tools) {
  return tools.map((t) => t.definition.name);
}

test('fleet v111 tools: 13 tools in ALL_TOOLS (491), unique names', () => {
  assert.equal(FLEET_V8_TOOLS.length, 13);
  assert.deepEqual(
    FLEET_V8_TOOLS.map((t) => t.definition.name),
    V8_NAMES,
  );
  for (const name of V8_NAMES) {
    assert.equal(
      ALL_TOOLS.filter((t) => t.definition.name === name).length,
      1,
      `${name} must appear exactly once in ALL_TOOLS`,
    );
  }
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  assert.ok(ALL_TOOLS.length >= 1078); // v1.14 merge: 453 + 38 = 500; v1.13: 402 + 51 = 453; v1.11 merge: 289 + 70 v1.11 = 359 // v1.38 re-pin: 899 + 179 = 1078.
});

test('fleet v111 tools: createDefaultTools binds without duplicating', () => {
  const base = tmpDir();
  const bound = createDefaultTools({ getFleetV8BaseDir: () => base });
  assert.equal(bound.length, ALL_TOOLS.length);
  for (const name of V8_NAMES) {
    assert.equal(
      bound.filter((t) => t.definition.name === name).length,
      1,
      `${name} duplicated after binding`,
    );
  }
  // Bound tools sit where the placeholders were (order preserved).
  assert.deepEqual(
    bound.map((t) => t.definition.name).filter((n) => V8_NAMES.includes(n)),
    V8_NAMES,
  );
});

test('fleet v111 tools: unbound file tools say NOT_WIRED, pure tools work', async () => {
  const unbound = createFleetV8Tools();
  assert.match(await run(unbound, 'fleet_dashboard', {}), /^Error:.*not wired/);
  assert.match(await run(unbound, 'fleet_incident_list', {}), /^Error:.*not wired/);
  assert.match(
    await run(unbound, 'fleet_incident_record', { kind: 'node-down', nodeId: 'n1', message: 'x' }),
    /^Error:.*not wired/,
  );
  assert.match(await run(unbound, 'composio_connection_list', {}), /^Error:.*not wired/);

  const probe = JSON.parse(await run(unbound, 'fleet_node_probe', {}));
  assert.ok(probe.cpuCores >= 1);
  assert.ok(probe.ramTotalBytes > 0);

  const health = JSON.parse(
    await run(unbound, 'fleet_node_health', {
      nodeId: 'n1',
      cpuCores: 4,
      cpuLoad1m: 1,
      ramTotalBytes: 16 * 1024 ** 3,
      ramFreeBytes: 8 * 1024 ** 3,
      heartbeatAgeMs: 1000,
      runningBots: 1,
      maxBots: 4,
    }),
  );
  assert.equal(health.status, 'healthy');

  const plan = JSON.parse(
    await run(unbound, 'fleet_node_rebalance', {
      nodes: [
        { nodeId: 'n-bad', status: 'down', loopback: false, maxBots: 2, freeFraction: 0.9 },
        { nodeId: 'n-ok', status: 'healthy', loopback: true, maxBots: 2, freeFraction: 0.5 },
      ],
      bots: [{ botId: 'b1', nodeId: 'n-bad' }],
    }),
  );
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].toNodeId, 'n-ok');

  const mockList = JSON.parse(await run(unbound, 'composio_mock_toolkit_list_v111', {}));
  assert.equal(mockList.mock, true);
  assert.equal(mockList.live, false);
  assert.equal(mockList.totalToolkits, 6);
  assert.equal(mockList.totalSlugs, 60);
  assert.deepEqual(
    mockList.toolkits.map((t) => t.slug),
    ['sentry', 'datadog', 'posthog', 'snowflake', 'amplitude', 'mixpanel'],
  );
  assert.ok(mockList.toolkits.every((t) => t.mockOnly === true && t.liveVerified === false));

  const mockExec = JSON.parse(
    await run(unbound, 'composio_mock_toolkit_execute_v111', { toolkit: 'sentry', slug: 'SENTRY_LIST_ISSUES', args: {} }),
  );
  assert.equal(mockExec.mock, true);
  assert.equal(mockExec.live, false);
  assert.ok(Array.isArray(mockExec.data.issues));

  const poll = JSON.parse(
    await run(unbound, 'composio_poll_policy', { name: 'gmail-new-mail', outcome: 'hit', noJitter: true }),
  );
  assert.equal(poll.nextIntervalMs, 7.5 * 60 * 1000);
  assert.equal(poll.catchUp.missedPolls, 0);
  assert.ok(poll.summary.includes('gmail-new-mail'));

  const sambanova = JSON.parse(await run(unbound, 'provider_sambanova_models', {}));
  assert.equal(sambanova.id, 'sambanova');
  assert.equal(sambanova.baseUrl, 'https://api.sambanova.ai/v1');
  assert.equal(sambanova.defaultModel, 'Meta-Llama-3.3-70B-Instruct');
  assert.ok(sambanova.knownModels.includes('Llama-4-Maverick-17B-128E-Instruct'));
  assert.deepEqual(sambanova.vaultNamespace, ['provider', 'sambanova']);
});

test('fleet v111 tools: bound flow dashboard → incident → connection lifecycle', async () => {
  const base = tmpDir();
  const bound = createFleetV8Tools(() => base);

  const dash = JSON.parse(await run(bound, 'fleet_dashboard', {}));
  assert.equal(dash.nodeRows.length, 1, 'empty fleet: only the local node');
  assert.equal(dash.nodeRows[0].nodeId, 'local');
  assert.ok(dash.summary.includes('1 node'));

  const recorded = JSON.parse(
    await run(bound, 'fleet_incident_record', { kind: 'node-down', nodeId: 'n-1', message: 'lost heartbeat' }),
  );
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.incident.kind, 'node-down');
  const incidents = JSON.parse(await run(bound, 'fleet_incident_list', {}));
  assert.equal(incidents.total, 1);
  assert.equal(incidents.incidents[0].message, 'lost heartbeat');
  // Persisted to the v111 JSONL file.
  assert.ok(fs.existsSync(path.join(base, 'fleet', 'fleet-incidents-v111.jsonl')));

  const conns = JSON.parse(await run(bound, 'composio_connection_list', {}));
  assert.equal(conns.summary.total, 0);
  assert.deepEqual(conns.entries, []);

  const disc = JSON.parse(await run(bound, 'composio_connection_disconnect', { toolkit: 'github', reason: 'user off' }));
  assert.equal(disc.disconnected, true);
  assert.equal(disc.entry.status, 'disconnected');
  assert.equal(disc.entry.disconnectedByUser, true);
  const afterDisc = JSON.parse(await run(bound, 'composio_connection_list', {}));
  assert.equal(afterDisc.summary.disconnected, 1);
  assert.equal(afterDisc.audit.length, 1);
  assert.equal(afterDisc.audit[0].action, 'disconnect');

  const recon = JSON.parse(await run(bound, 'composio_connection_reconnect', { toolkit: 'github' }));
  assert.equal(recon.reconnected, true);
  assert.equal(recon.entry.status, 'reconnecting');
  assert.equal(recon.autoReconnectDecision.allowed, false, 'reconnecting needs no auto-reconnect');
  // Persisted to the v111 connections file.
  assert.ok(fs.existsSync(path.join(base, 'composio', 'composio-connections-v111.json')));
  assert.ok(fs.existsSync(path.join(base, 'composio', 'composio-connection-audit-v111.jsonl')));
});

test('fleet v111 tools: arg validation returns Error strings, never throws', async () => {
  const unbound = createFleetV8Tools();
  assert.match(await run(unbound, 'fleet_node_health', {}), /^Error:.*nodeId/);
  assert.match(
    await run(unbound, 'fleet_node_rebalance', { nodes: [], bots: [] }),
    /^Error:.*non-empty/,
  );
  assert.match(
    await run(unbound, 'fleet_node_rebalance', {
      nodes: [{ nodeId: 'n1', status: 'bogus' }],
      bots: [{ botId: 'b1', nodeId: 'n1' }],
    }),
    /^Error:.*status must be one of/,
  );
  assert.match(
    await run(unbound, 'composio_mock_toolkit_execute_v111', { toolkit: 'sentry', slug: 'SENTRY_NOPE' }),
    /^Error:.*not a candidate tool/,
  );
  assert.match(
    await run(unbound, 'composio_mock_toolkit_execute_v111', { toolkit: 'github', slug: 'GITHUB_LIST_REPOS' }),
    /^Error:.*Unknown mock toolkit/,
  );
  assert.match(await run(unbound, 'composio_poll_policy', { name: 'x', outcome: 'bogus' }), /^Error:.*outcome must be one of/);
  const bound = createFleetV8Tools(() => tmpDir());
  assert.match(
    await run(bound, 'fleet_incident_record', { kind: 'bogus', nodeId: 'n1', message: 'x' }),
    /^Error:.*kind must be one of/,
  );
  assert.match(
    await run(bound, 'composio_connection_disconnect', { toolkit: 'not-a-toolkit' }),
    /^Error:.*Unknown Composio toolkit/,
  );
  assert.match(await run(bound, 'composio_connection_reconnect', { toolkit: 'not-a-toolkit' }), /^Error:.*Unknown Composio toolkit/);
});

test('fleet v111 tools: approval flags — writes need approval, reads do not', () => {
  const writes = ['fleet_incident_record', 'composio_connection_disconnect', 'composio_connection_reconnect'];
  const reads = [
    'fleet_node_probe',
    'fleet_node_health',
    'fleet_node_rebalance',
    'fleet_dashboard',
    'fleet_incident_list',
    'composio_mock_toolkit_list_v111',
    'composio_mock_toolkit_execute_v111',
    'composio_connection_list',
    'composio_poll_policy',
    'provider_sambanova_models',
  ];
  for (const name of writes) assert.equal(toolByName(FLEET_V8_TOOLS, name).needsApproval, true, `${name} must need approval`);
  for (const name of reads) assert.equal(toolByName(FLEET_V8_TOOLS, name).needsApproval, false, `${name} must not need approval`);
});
