/**
 * Tests for v1.39 (Team T2) — protocols v8 versions + extensions:
 * packages/core/src/protocolsV8/versionsV8.ts
 *
 * Covers:
 *  - current versions per family (mcp 2026-07-28, a2a 1.0.1,
 *    nanda 0.1-local, acp merged, poppy watch-only)
 *  - extension registry (6 extensions, all implemented, ids + aliases)
 *  - extension negotiation (both-sides + implemented = active;
 *    unknown ids never activate; default off)
 *  - deprecation table (6 features, removal floor 2027-07-28)
 *  - version negotiation incl. nanda local sketch + acp merged
 *  - capabilities negotiation (intersection, missing peer = nothing)
 *  - downgrade to v7 (nanda lost, mcp still negotiates)
 *  - transport preference (streamable-http first, http-sse deprecated)
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v8-versions.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_V8_CURRENT_VERSION,
  MCP_V8_DEPRECATIONS,
  MCP_V8_EXTENSION_IDS,
  MCP_V8_EXTENSIONS,
  MCP_V8_LEGACY_REMOVAL_DATE,
  MCP_V8_TRANSPORT_PREFERENCE,
  NANDA_V8_CURRENT_VERSION,
  PROTOCOL_V8_CURRENT_VERSIONS,
  defaultMcpV8ExtensionOffer,
  defaultProtocolV8Capabilities,
  mcpV8DeprecationByFeature,
  mcpV8ExtensionById,
  mcpV8IsDeprecated,
  mcpV8IsDeprecatedTransport,
  mcpV8IsKnownExtension,
  mcpV8IsPreferredTransport,
  negotiateAllProtocolsV8,
  negotiateMcpV8Extensions,
  negotiateProtocolV8Capabilities,
  negotiateProtocolV8Version,
  protocolV8ChangesSinceV7,
  protocolV8DeprecationCalendar,
  protocolV8DowngradeToV7,
  protocolV8IsImplemented,
  protocolV8MatrixSummary,
  protocolV8VersionStatus,
} from '../packages/core/dist/index.js';

test('current versions: mcp 2026-07-28, a2a 1.0.1, nanda local sketch, acp merged', () => {
  assert.equal(MCP_V8_CURRENT_VERSION, '2026-07-28');
  assert.equal(PROTOCOL_V8_CURRENT_VERSIONS.mcp, '2026-07-28');
  assert.equal(PROTOCOL_V8_CURRENT_VERSIONS.a2a, '1.0.1');
  assert.equal(PROTOCOL_V8_CURRENT_VERSIONS.nanda, '0.1-local');
  assert.equal(NANDA_V8_CURRENT_VERSION, '0.1-local');
  assert.equal(PROTOCOL_V8_CURRENT_VERSIONS.acp, '');
  assert.equal(PROTOCOL_V8_CURRENT_VERSIONS.ucp, '2026-08-25');
  assert.equal(PROTOCOL_V8_CURRENT_VERSIONS.gov, '1.0');
  assert.equal(PROTOCOL_V8_CURRENT_VERSIONS.poppy, '1.0');
  assert.match(protocolV8MatrixSummary(), /mcp 2026-07-28/);
  assert.match(protocolV8MatrixSummary(), /nanda 0\.1-local/);
});

test('version status: current / legacy / removed / merged / watch-only / local-sketch / unknown', () => {
  assert.equal(protocolV8VersionStatus('mcp', '2026-07-28'), 'current');
  assert.equal(protocolV8VersionStatus('mcp', '2025-11-25'), 'legacy');
  assert.equal(protocolV8VersionStatus('a2a', '0.3'), 'removed');
  assert.equal(protocolV8VersionStatus('a2a', '1.1'), 'current');
  assert.equal(protocolV8VersionStatus('acp', '2.0'), 'merged');
  assert.equal(protocolV8VersionStatus('poppy', '1.0'), 'watch-only');
  assert.equal(protocolV8VersionStatus('nanda', '0.1-local'), 'local-sketch');
  assert.equal(protocolV8VersionStatus('nanda', '9.9'), 'unknown');
  assert.equal(protocolV8VersionStatus('mcp', '1999-01-01'), 'unknown');
  assert.equal(protocolV8IsImplemented('poppy', '1.0'), false);
  assert.equal(protocolV8IsImplemented('acp'), false);
  assert.equal(protocolV8IsImplemented('nanda', '0.1-local'), true);
  assert.equal(protocolV8IsImplemented('mcp', '2026-07-28'), true);
});

test('extension registry: 6 extensions, all official + implemented, aliases resolve', () => {
  assert.equal(MCP_V8_EXTENSIONS.length, 6);
  assert.deepEqual([...MCP_V8_EXTENSION_IDS].sort(), [
    'io.modelcontextprotocol/enterprise-managed-authorization',
    'io.modelcontextprotocol/oauth-client-credentials',
    'io.modelcontextprotocol/server-cards',
    'io.modelcontextprotocol/skills',
    'io.modelcontextprotocol/tasks',
    'io.modelcontextprotocol/ui',
  ]);
  for (const ext of MCP_V8_EXTENSIONS) {
    assert.equal(ext.status, 'official');
    assert.equal(ext.implemented, true);
    assert.equal(mcpV8IsKnownExtension(ext.id), true);
    assert.equal(mcpV8ExtensionById(ext.id)?.alias, ext.alias);
  }
  assert.equal(mcpV8ExtensionById('io.modelcontextprotocol/ui')?.alias, 'mcp-apps');
  assert.equal(mcpV8ExtensionById('io.modelcontextprotocol/tasks')?.alias, 'mcp-tasks');
  assert.equal(mcpV8ExtensionById('io.modelcontextprotocol/tasks')?.methods.length, 3);
  assert.equal(mcpV8IsKnownExtension('io.modelcontextprotocol/nope'), false);
  assert.equal(mcpV8ExtensionById('io.modelcontextprotocol/nope'), undefined);
  assert.deepEqual(defaultMcpV8ExtensionOffer().sort(), [...MCP_V8_EXTENSION_IDS].sort());
});

test('extension negotiation: active only when both sides offer + implemented; unknown never activates', () => {
  const both = negotiateMcpV8Extensions(
    ['io.modelcontextprotocol/ui', 'io.modelcontextprotocol/tasks'],
    ['io.modelcontextprotocol/tasks', 'io.modelcontextprotocol/skills'],
  );
  assert.deepEqual(both.active, ['io.modelcontextprotocol/tasks']);
  assert.equal(both.tasksActive, true);
  assert.equal(both.appsActive, false);
  assert.equal(both.skillsActive, false);
  assert.deepEqual(both.localOnly, ['io.modelcontextprotocol/ui']);
  assert.deepEqual(both.peerOnly, ['io.modelcontextprotocol/skills']);
  assert.deepEqual(both.unknown, []);

  const withUnknown = negotiateMcpV8Extensions(
    defaultMcpV8ExtensionOffer(),
    ['io.modelcontextprotocol/tasks', 'io.modelcontextprotocol/evil-extension', 'not-an-extension'],
  );
  assert.deepEqual(withUnknown.active, ['io.modelcontextprotocol/tasks']);
  assert.deepEqual(withUnknown.unknown.sort(), ['io.modelcontextprotocol/evil-extension', 'not-an-extension']);

  // Default off: no peer offer means nothing active.
  const none = negotiateMcpV8Extensions(defaultMcpV8ExtensionOffer(), []);
  assert.deepEqual(none.active, []);
  assert.equal(none.tasksActive, false);
  assert.equal(none.appsActive, false);
  const noLocal = negotiateMcpV8Extensions([], ['io.modelcontextprotocol/tasks']);
  assert.deepEqual(noLocal.active, []);
});

test('deprecation table: sampling/roots/logging/http-sse/initialize/session-id, floor 2027-07-28', () => {
  assert.equal(MCP_V8_LEGACY_REMOVAL_DATE, '2027-07-28');
  assert.equal(MCP_V8_DEPRECATIONS.length, 6);
  for (const d of MCP_V8_DEPRECATIONS) {
    assert.equal(d.earliestRemoval, '2027-07-28');
    assert.equal(d.stillRuns, true);
    assert.equal(d.adoptNew, false);
    assert.ok(d.replacement.length > 0);
    assert.equal(mcpV8IsDeprecated(d.feature), true);
    assert.equal(mcpV8DeprecationByFeature(d.feature)?.feature, d.feature);
  }
  assert.equal(mcpV8IsDeprecated('tools/call'), false);
  assert.equal(mcpV8DeprecationByFeature('tools/call'), undefined);
  assert.match(mcpV8DeprecationByFeature('sampling')?.replacement ?? '', /Elicitation/);
  assert.match(mcpV8DeprecationByFeature('http-sse-transport')?.replacement ?? '', /Streamable HTTP/);
});

test('negotiation: nanda local sketch, acp merged, poppy not implemented, no common = null', () => {
  const nanda = negotiateProtocolV8Version('nanda', ['0.1-local']);
  assert.equal(nanda.negotiated, '0.1-local');
  assert.equal(nanda.status, 'local-sketch');
  assert.equal(nanda.implemented, true);
  const nandaNone = negotiateProtocolV8Version('nanda', ['2.0']);
  assert.equal(nandaNone.negotiated, null);
  const acp = negotiateProtocolV8Version('acp', ['2.0', '1.0']);
  assert.equal(acp.negotiated, null);
  assert.equal(acp.status, 'merged');
  const poppy = negotiateProtocolV8Version('poppy', ['1.0']);
  assert.equal(poppy.negotiated, '1.0');
  assert.equal(poppy.implemented, false);
  const mcp = negotiateProtocolV8Version('mcp', ['2025-06-18', '2026-07-28']);
  assert.equal(mcp.negotiated, '2026-07-28');
  assert.equal(mcp.status, 'current');
  const a2aRemoved = negotiateProtocolV8Version('a2a', ['0.3']);
  assert.equal(a2aRemoved.negotiated, null);
  const none = negotiateProtocolV8Version('mcp', ['1999-01-01']);
  assert.equal(none.negotiated, null);

  const all = negotiateAllProtocolsV8({ mcp: ['2026-07-28'], nanda: ['0.1-local'], acp: [] });
  assert.equal(all.mcp.negotiated, '2026-07-28');
  assert.equal(all.nanda.negotiated, '0.1-local');
  assert.equal(all.acp.negotiated, null);
});

test('capabilities: intersection wins; missing peer means nothing beyond versions', () => {
  const local = defaultProtocolV8Capabilities();
  assert.equal(local.mcpStatelessHttp, true);
  assert.equal(local.mcpDiscover, true);
  assert.equal(local.nandaLocal, true);
  assert.deepEqual(local.elicitationModes, ['form', 'url']);
  const peer = { ...local, mcpDiscover: false, elicitationModes: ['form'] };
  const negotiated = negotiateProtocolV8Capabilities(peer);
  assert.equal(negotiated.mcpDiscover, false);
  assert.equal(negotiated.mcpStatelessHttp, true);
  assert.deepEqual(negotiated.elicitationModes, ['form']);
  const missing = negotiateProtocolV8Capabilities(undefined);
  assert.equal(missing.mcpStatelessHttp, false);
  assert.equal(missing.nandaLocal, false);
  assert.deepEqual(missing.elicitationModes, []);
});

test('downgrade to v7: nanda lost, mcp still negotiates, v8-only noted', () => {
  const report = protocolV8DowngradeToV7();
  assert.equal(report.length, 9);
  const nanda = report.find((r) => r.family === 'nanda');
  assert.equal(nanda?.compatible, false);
  assert.equal(nanda?.v7Negotiated, null);
  const mcp = report.find((r) => r.family === 'mcp');
  assert.equal(mcp?.compatible, true);
  assert.equal(mcp?.v7Negotiated, '2026-07-28');
  assert.match(mcp?.note ?? '', /v8-only/);
  const acp = report.find((r) => r.family === 'acp');
  assert.equal(acp?.compatible, false);
});

test('deprecation calendar + changes since v7 cover all v8 work', () => {
  const calendar = protocolV8DeprecationCalendar();
  assert.equal(calendar.length, 9);
  const mcpRow = calendar.find((r) => r.family === 'mcp');
  assert.equal(mcpRow?.removalDate, '2027-07-28');
  assert.match(mcpRow?.note ?? '', /Sampling/);
  const nandaRow = calendar.find((r) => r.family === 'nanda');
  assert.equal(nandaRow?.current, '0.1-local');
  const changes = protocolV8ChangesSinceV7();
  assert.ok(changes.length >= 8);
  assert.ok(changes.some((c) => c.includes('server/discover')));
  assert.ok(changes.some((c) => c.includes('MCP Apps')));
  assert.ok(changes.some((c) => c.includes('Tasks')));
  assert.ok(changes.some((c) => c.includes('OAuth 2.1')));
  assert.ok(changes.some((c) => c.includes('NANDA')));
  assert.ok(changes.some((c) => c.includes('Skills over MCP')));
});

test('transport preference: streamable-http first, http-sse deprecated', () => {
  assert.deepEqual([...MCP_V8_TRANSPORT_PREFERENCE], ['streamable-http', 'stdio', 'http-sse']);
  assert.equal(mcpV8IsPreferredTransport('streamable-http'), true);
  assert.equal(mcpV8IsPreferredTransport('http-sse'), false);
  assert.equal(mcpV8IsDeprecatedTransport('http-sse'), true);
  assert.equal(mcpV8IsDeprecatedTransport('streamable-http'), false);
});
