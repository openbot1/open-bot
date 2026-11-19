/**
 * Tests for v1.41 (Team T2) — protocols v10 version matrix:
 * packages/core/src/protocolsV10/versionsV10.ts
 *
 * Covers:
 *  - current versions per family (a2a 1.1 implemented + 1.0
 *    handshake track, mcp 2026-07-28, acp draft, ucp read-only)
 *  - matrix summary + negotiation (newest common version
 *    wins; unknown peer versions never win; no overlap ->
 *    agreed undefined)
 *  - negotiate-all across families
 *  - changes since v9 + downgrade to v9
 *  - feature flags: loopbackOnly must stay true
 *  - deprecation policy constants (12 months / 90 days)
 *  - task state machine (legal transitions, terminal states)
 *  - ACP session terminal states
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v10-versions.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2A_V10_CURRENT_VERSION,
  A2A_V10_HANDSHAKE_VERSION,
  A2A_V10_IMPLEMENTED_VERSION,
  ACP_V10_CURRENT_VERSION,
  ACP_V10_IMPLEMENTATION_VERSION,
  ACP_V10_KNOWN_AGENTS,
  MCP_V10_CURRENT_VERSION,
  MCP_V10_DEPRECATION_MONTHS,
  MCP_V10_DEPRECATION_SECURITY_DAYS,
  MCP_V10_DISCOVER_METHOD,
  MCP_V10_SUBSCRIPTIONS_METHOD,
  PROTOCOL_V10_CURRENT_VERSIONS,
  PROTOCOL_V10_DEFAULT_FEATURES,
  PROTOCOL_V10_FAMILIES,
  PROTOCOL_V10_VERSION_MATRIX,
  isA2aV10TaskTerminal,
  isA2aV10TaskTransitionLegal,
  isAcpV10SessionTerminal,
  negotiateAllProtocolsV10,
  negotiateProtocolV10Version,
  protocolV10ChangesSinceV9,
  protocolV10DowngradeToV9,
  protocolV10MatrixSummary,
  validateProtocolV10Features,
} from '../packages/core/dist/index.js';

test('current versions: a2a 1.1 implemented + 1.0 handshake, mcp 2026-07-28, acp draft', () => {
  assert.equal(A2A_V10_CURRENT_VERSION, '1.1');
  assert.equal(A2A_V10_IMPLEMENTED_VERSION, '1.1');
  assert.equal(A2A_V10_HANDSHAKE_VERSION, '1.0');
  assert.equal(MCP_V10_CURRENT_VERSION, '2026-07-28');
  assert.equal(ACP_V10_CURRENT_VERSION, 'draft');
  assert.equal(ACP_V10_IMPLEMENTATION_VERSION, '10.0');
  assert.equal(PROTOCOL_V10_CURRENT_VERSIONS.a2a, '1.1');
  assert.equal(PROTOCOL_V10_CURRENT_VERSIONS.mcp, '2026-07-28');
  assert.equal(PROTOCOL_V10_CURRENT_VERSIONS.ucp, '2026-08-25');
  assert.equal(PROTOCOL_V10_CURRENT_VERSIONS.gov, '1.0');
  assert.equal(PROTOCOL_V10_CURRENT_VERSIONS.nanda, '0.1-local');
  assert.deepEqual(ACP_V10_KNOWN_AGENTS, ['claude', 'codex', 'gemini']);
  for (const family of PROTOCOL_V10_FAMILIES) {
    assert.ok(PROTOCOL_V10_VERSION_MATRIX[family].includes(PROTOCOL_V10_CURRENT_VERSIONS[family]));
  }
  assert.match(protocolV10MatrixSummary(), /a2a 1\.1/);
  assert.match(protocolV10MatrixSummary(), /mcp 2026-07-28/);
});

test('negotiation picks the newest common version; unknown versions never win', () => {
  const n1 = negotiateProtocolV10Version('a2a', ['1.0', '1.1']);
  assert.equal(n1.agreed, '1.1');
  assert.equal(n1.peerHasCurrent, true);
  const n2 = negotiateProtocolV10Version('a2a', ['1.0']);
  assert.equal(n2.agreed, '1.0');
  assert.equal(n2.peerHasCurrent, false);
  assert.deepEqual(n2.peerOnly, []);
  const n3 = negotiateProtocolV10Version('mcp', ['2099-01-01']);
  assert.equal(n3.agreed, undefined);
  assert.deepEqual(n3.peerOnly, ['2099-01-01']);
  assert.ok(n3.localOnly.length > 0);
  const n4 = negotiateProtocolV10Version('acp', ['draft']);
  assert.equal(n4.agreed, 'draft');
  const n5 = negotiateProtocolV10Version('mcp', []);
  assert.equal(n5.agreed, undefined);
});

test('negotiate-all covers every family; missing families have no agreement', () => {
  const all = negotiateAllProtocolsV10({ mcp: ['2026-07-28'], a2a: ['1.0'] });
  assert.equal(all.mcp.agreed, '2026-07-28');
  assert.equal(all.a2a.agreed, '1.0');
  assert.equal(all.ucp.agreed, undefined);
  assert.equal(all.gov.agreed, undefined);
  for (const family of PROTOCOL_V10_FAMILIES) {
    assert.equal(all[family].family, family);
  }
});

test('changes since v9 mention every v10 subsystem; downgrade to v9 lists the losses', () => {
  const changes = protocolV10ChangesSinceV9();
  assert.ok(changes.length >= 8);
  assert.ok(changes.some((c) => c.includes('stateless v10')));
  assert.ok(changes.some((c) => c.includes('OAuth v10')));
  assert.ok(changes.some((c) => c.includes('tool search')));
  assert.ok(changes.some((c) => c.includes('Tasks extension v10')));
  assert.ok(changes.some((c) => c.includes('Apps v10')));
  assert.ok(changes.some((c) => c.includes('multi round-trip v10')));
  assert.ok(changes.some((c) => c.includes('1.0 handshake')));
  assert.ok(changes.some((c) => c.includes('deprecation registry')));
  const down = protocolV10DowngradeToV9();
  assert.match(down.mcp, /[Ss]tateless v10/);
  assert.match(down.a2a, /1\.0 minimal handshake/);
  assert.equal(down.ucp, 'unchanged (2026-08-25 read-only).');
});

test('feature flags: loopbackOnly must stay true', () => {
  assert.deepEqual(validateProtocolV10Features(PROTOCOL_V10_DEFAULT_FEATURES), []);
  const off = validateProtocolV10Features({ ...PROTOCOL_V10_DEFAULT_FEATURES, loopbackOnly: false });
  assert.equal(off.length, 1);
  assert.match(off[0], /loopbackOnly must stay true/);
  assert.equal(PROTOCOL_V10_DEFAULT_FEATURES.mcpStatelessV10, true);
  assert.equal(PROTOCOL_V10_DEFAULT_FEATURES.toolSearch, true);
  assert.equal(PROTOCOL_V10_DEFAULT_FEATURES.mcpAppsV10, true);
});

test('deprecation policy constants: 12 months, 90 days for security', () => {
  assert.equal(MCP_V10_DEPRECATION_MONTHS, 12);
  assert.equal(MCP_V10_DEPRECATION_SECURITY_DAYS, 90);
  assert.equal(MCP_V10_DISCOVER_METHOD, 'server/discover');
  assert.equal(MCP_V10_SUBSCRIPTIONS_METHOD, 'subscriptions/listen');
});

test('A2A v10 task state machine: legal transitions, terminal states never move', () => {
  assert.equal(isA2aV10TaskTerminal('completed'), true);
  assert.equal(isA2aV10TaskTerminal('failed'), true);
  assert.equal(isA2aV10TaskTerminal('canceled'), true);
  assert.equal(isA2aV10TaskTerminal('rejected'), true);
  assert.equal(isA2aV10TaskTerminal('working'), false);
  assert.equal(isA2aV10TaskTransitionLegal('submitted', 'working'), true);
  assert.equal(isA2aV10TaskTransitionLegal('working', 'completed'), true);
  assert.equal(isA2aV10TaskTransitionLegal('input-required', 'working'), true);
  assert.equal(isA2aV10TaskTransitionLegal('completed', 'working'), false);
  assert.equal(isA2aV10TaskTransitionLegal('failed', 'submitted'), false);
  assert.equal(isA2aV10TaskTransitionLegal('submitted', 'completed'), false);
});

test('ACP v10 session terminal states', () => {
  assert.equal(isAcpV10SessionTerminal('cancelled'), true);
  assert.equal(isAcpV10SessionTerminal('completed'), true);
  assert.equal(isAcpV10SessionTerminal('failed'), true);
  assert.equal(isAcpV10SessionTerminal('active'), false);
  assert.equal(isAcpV10SessionTerminal('suspended'), false);
});
