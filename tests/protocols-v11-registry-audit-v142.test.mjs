/**
 * Tests for v1.42 (Team T2) — protocols v11 server registry + audit:
 * packages/core/src/protocols/v11/serverRegistryV11.ts
 * packages/core/src/protocols/v11/auditV11.ts
 * packages/core/src/protocols/v11/statelessV11.ts (audit wiring)
 * packages/tools/src/protocolsV11Tools.ts (registry tool actions)
 *
 * Covers:
 *  - registry: register from discover, get/require/list, routing
 *    key resolution (ok / unknown key / down server / degraded
 *    warning), health updates, version + extension filters,
 *    interop per server, legacy servers, counts, snapshot/restore
 *  - audit log: record, bounded ring buffer (old entries drop),
 *    byRequestId / byMethod / byServer / errors, counts, method
 *    stats, clear
 *  - server dispatch audits every request (ok + refusals land in
 *    the log with the routing request id)
 *  - registry tool: servers-register/list/get/resolve/health/counts
 *    + audit-list/counts/errors/stats through the tool layer
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/protocols-v11-registry-audit-v142.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV11AuditLog,
  McpV11ServerRegistry,
  McpV11StatelessServer,
  buildMcpV11RequestMeta,
  mcpV11AuditTimer,
} from '../packages/core/dist/index.js';
import { createProtocolV119Tools } from '../packages/tools/dist/protocolsV11Tools.js';

function discoverDoc(name, version = '2026-07-28') {
  return {
    protocolVersion: version,
    serverInfo: { name, version: '1.42.0' },
    extensions: ['io.modelcontextprotocol/tasks', 'io.modelcontextprotocol/ui'],
    capabilities: {
      multiRoundTrip: true,
      tasks: true,
      apps: true,
      cacheableLists: true,
      routing: true,
    },
    routing: { [name]: `route:${name}` },
    cacheableLists: ['tools', 'resources', 'prompts'],
  };
}

test('server registry: register/get/list, routing resolution, health, filters', () => {
  const registry = new McpV11ServerRegistry();
  const alpha = registry.register(discoverDoc('alpha'), 'loopback:alpha');
  assert.equal(alpha.id, 'alpha');
  assert.equal(alpha.routingKey, 'route:alpha');
  assert.equal(alpha.health, 'ok');
  assert.deepEqual(alpha.cacheableLists, ['tools', 'resources', 'prompts']);
  registry.register(discoverDoc('beta', '2025-11-25'), 'loopback:beta');
  assert.deepEqual(registry.list().map((s) => s.id), ['alpha', 'beta']);
  assert.equal(registry.get('alpha').endpoint, 'loopback:alpha');
  assert.equal(registry.get('nope'), undefined);
  assert.throws(() => registry.require('nope'), /No registered server/);
  assert.throws(() => registry.register(discoverDoc('x'), ''), /endpoint is required/);
  // Routing resolution.
  const resolved = registry.resolveRoutingKey('route:alpha');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.server.id, 'alpha');
  const unknown = registry.resolveRoutingKey('route:nope');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown-routing-key');
  // Degraded resolves with a warning; down does not resolve.
  registry.setHealth('alpha', 'degraded', 'slow responses');
  const degraded = registry.resolveRoutingKey('route:alpha');
  assert.equal(degraded.ok, true);
  assert.match(degraded.warning, /degraded/);
  registry.setHealth('alpha', 'down', 'crashed');
  const down = registry.resolveRoutingKey('route:alpha');
  assert.equal(down.ok, false);
  assert.equal(down.code, 'server-unavailable');
  assert.match(down.message, /crashed/);
  registry.setHealth('alpha', 'ok');
  assert.equal(registry.resolveRoutingKey('route:alpha').ok, true);
  assert.throws(() => registry.setHealth('alpha', 'gone'), /Unknown health|invalid/i);
  // Filters + interop + counts.
  assert.deepEqual(registry.listByVersion('2026-07-28').map((s) => s.id), ['alpha']);
  assert.deepEqual(registry.listByExtension('io.modelcontextprotocol/tasks').map((s) => s.id), ['alpha', 'beta']);
  assert.deepEqual(registry.legacyServers().map((s) => s.id), ['beta']);
  assert.deepEqual(registry.interopFor('alpha'), { mode: 'stateless', handshakeRequired: false });
  assert.deepEqual(registry.interopFor('beta'), { mode: 'handshake-fallback', handshakeRequired: true });
  assert.deepEqual(registry.counts(), { total: 2, ok: 2, degraded: 0, down: 0, stateless: 1, legacy: 1 });
  assert.equal(registry.remove('beta'), true);
  assert.equal(registry.remove('beta'), false);
  assert.equal(registry.counts().total, 1);
  // Snapshot / restore.
  const snap = registry.snapshot();
  const restored = new McpV11ServerRegistry();
  assert.equal(restored.restore(snap), 1);
  assert.equal(restored.get('alpha').routingKey, 'route:alpha');
});

test('audit log: record, ring buffer bound, queries, counts, method stats', () => {
  const log = new McpV11AuditLog(3);
  log.record({ requestId: 'r1', method: 'tools/list', outcome: 'ok', durationMs: 5 });
  log.record({ requestId: 'r2', method: 'tools/call', outcome: 'ok', durationMs: 20 });
  log.record({ requestId: 'r3', method: 'tools/call', outcome: 'failed', errorCode: 'tool-error', durationMs: 30 });
  assert.equal(log.size, 3);
  assert.equal(log.byRequestId('r2').method, 'tools/call');
  assert.equal(log.byMethod('tools/call').length, 2);
  assert.deepEqual(log.counts(), { total: 3, ok: 2, refused: 0, failed: 1 });
  assert.equal(log.errors().length, 1);
  const stats = log.methodStats();
  assert.deepEqual(stats.map((s) => s.method), ['tools/call', 'tools/list']);
  assert.equal(stats.find((s) => s.method === 'tools/call').avgDurationMs, 25);
  assert.equal(stats.find((s) => s.method === 'tools/call').maxDurationMs, 30);
  // Fourth record evicts the oldest (ring buffer).
  log.record({ requestId: 'r4', method: 'server/discover', outcome: 'ok', durationMs: 1 });
  assert.equal(log.size, 3);
  assert.equal(log.byRequestId('r1'), undefined);
  assert.equal(log.byRequestId('r4').method, 'server/discover');
  // Timer helper records with measured duration.
  const finish = mcpV11AuditTimer(log, { requestId: 'r5', method: 'tools/call', server: 'alpha' });
  const entry = finish('ok');
  assert.equal(entry.requestId, 'r5');
  assert.ok(entry.durationMs >= 0);
  assert.equal(log.byServer('alpha').length, 1);
  log.clear();
  assert.equal(log.size, 0);
  assert.deepEqual(log.counts(), { total: 0, ok: 0, refused: 0, failed: 0 });
});

test('server dispatch audits every request, ok and refused alike', async () => {
  const server = new McpV11StatelessServer({
    tools: [{ name: 'echo', description: 'Echo.', handler: (args) => ({ echoed: args }) }],
  });
  const meta = buildMcpV11RequestMeta();
  await server.dispatch(
    { jsonrpc: '2.0', method: 'server/discover', params: {}, id: 1 },
    { 'mcp-request-id': 'req-discover', 'mcp-protocol-version': '2026-07-28' },
  );
  await server.dispatch(
    { jsonrpc: '2.0', method: 'tools/call', params: { _meta: meta, name: 'echo', arguments: {} }, id: 2 },
    { 'mcp-request-id': 'req-call', 'mcp-routing-key': 'route:demo' },
  );
  await server.dispatch(
    { jsonrpc: '2.0', method: 'initialize', params: { _meta: meta }, id: 3 },
    { 'mcp-request-id': 'req-refused' },
  );
  assert.equal(server.audit.size, 3);
  assert.deepEqual(server.audit.counts(), { total: 3, ok: 2, refused: 1, failed: 0 });
  const call = server.audit.byRequestId('req-call');
  assert.equal(call.method, 'tools/call');
  assert.equal(call.routingKey, 'route:demo');
  assert.equal(call.outcome, 'ok');
  const refused = server.audit.byRequestId('req-refused');
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.errorCode, 'session-only-method');
  assert.equal(server.audit.errors().length, 1);
  // No tool arguments are stored in the audit log.
  assert.equal('arguments' in call, false);
});

test('registry tool: servers + audit actions through the tool layer', async () => {
  const tools = createProtocolV119Tools();
  const find = (name) => tools.find((t) => t.definition.name === name);
  const registryTool = find('protocol_v11_registry');
  assert.ok(registryTool, 'registry tool exists');
  const tools2 = createProtocolV119Tools();
  const run2 = async (name, args) => {
    const t = tools2.find((x) => x.definition.name === name);
    const result = await t.execute(args, { workspaceDir: '/tmp', botId: 'test-bot' });
    if (result.startsWith('Error:')) throw new Error(result);
    return JSON.parse(result);
  };
  const disc = await run2('protocol_v11_discover', { action: 'discover' });
  const registered = await run2('protocol_v11_registry', {
    action: 'servers-register',
    discover: disc,
    endpoint: 'loopback:open-bot-mcp-v11',
  });
  assert.equal(registered.id, 'open-bot-mcp-v11');
  assert.equal(registered.routingKey, 'route:open-bot-mcp-v11');
  const listed = await run2('protocol_v11_registry', { action: 'servers-list' });
  assert.equal(listed.servers.length, 1);
  const resolved = await run2('protocol_v11_registry', { action: 'servers-resolve', routingKey: 'route:open-bot-mcp-v11' });
  assert.equal(resolved.ok, true);
  const unknown = await run2('protocol_v11_registry', { action: 'servers-resolve', routingKey: 'route:nope' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown-routing-key');
  const health = await run2('protocol_v11_registry', { action: 'servers-health', id: 'open-bot-mcp-v11', health: 'degraded', reason: 'test' });
  assert.equal(health.health, 'degraded');
  const counts = await run2('protocol_v11_registry', { action: 'servers-counts' });
  assert.deepEqual(counts, { total: 1, ok: 0, degraded: 1, down: 0, stateless: 1, legacy: 0 });
  // Drive some traffic through the shared loopback server, then audit it.
  await run2('protocol_v11_stateless', { action: 'list-tools' });
  await run2('protocol_v11_stateless', { action: 'refuse-check', method: 'initialize' });
  const auditCounts = await run2('protocol_v11_registry', { action: 'audit-counts' });
  assert.ok(auditCounts.total >= 2);
  assert.ok(auditCounts.refused >= 1);
  const auditErrors = await run2('protocol_v11_registry', { action: 'audit-errors' });
  assert.ok(auditErrors.entries.length >= 1);
  assert.equal(auditErrors.entries[0].errorCode, 'session-only-method');
  const auditStats = await run2('protocol_v11_registry', { action: 'audit-stats' });
  assert.ok(auditStats.methods.some((m) => m.method === 'tools/list'));
  const snap = await run2('protocol_v11_registry', { action: 'servers-snapshot' });
  assert.equal(snap.servers.length, 1);
  await run2('protocol_v11_registry', { action: 'servers-remove', id: 'open-bot-mcp-v11' });
  const restored = await run2('protocol_v11_registry', { action: 'servers-restore', snapshot: { servers: snap.servers } });
  assert.equal(restored.restored, 1);
  const finalCounts = await run2('protocol_v11_registry', { action: 'counts' });
  assert.equal(finalCounts.servers.total, 1);
  assert.ok(finalCounts.audit.total >= 2);
});
