/**
 * Tests for v1.40 (Team T2) — protocols v9 version matrix:
 * packages/core/src/protocolsV9/versionsV9.ts
 *
 * Covers:
 *  - current versions per family (a2a 1.1 implemented, mcp
 *    2026-07-28, acp draft, ucp read-only, gov 1.0)
 *  - matrix summary + negotiation (newest common version
 *    wins; unknown peer versions never win; no overlap ->
 *    agreed undefined)
 *  - negotiate-all across families
 *  - changes since v8 + downgrade to v8 (a2a/mcp/acp lose
 *    the v9 additions)
 *  - feature flags: loopbackOnly must stay true
 *  - task state machine (legal transitions, terminal states)
 *  - ACP session terminal states
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v9-versions.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2A_V9_CURRENT_VERSION,
  A2A_V9_IMPLEMENTED_VERSION,
  ACP_V9_CURRENT_VERSION,
  ACP_V9_IMPLEMENTATION_VERSION,
  ACP_V9_KNOWN_AGENTS,
  MCP_V9_CURRENT_VERSION,
  PROTOCOL_V9_CURRENT_VERSIONS,
  PROTOCOL_V9_DEFAULT_FEATURES,
  PROTOCOL_V9_FAMILIES,
  PROTOCOL_V9_VERSION_MATRIX,
  isA2aV9TaskTerminal,
  isA2aV9TaskTransitionLegal,
  isAcpV9SessionTerminal,
  negotiateAllProtocolsV9,
  negotiateProtocolV9Version,
  protocolV9ChangesSinceV8,
  protocolV9DowngradeToV8,
  protocolV9MatrixSummary,
  validateProtocolV9Features,
} from '../packages/core/dist/index.js';

test('current versions: a2a 1.1 implemented, mcp 2026-07-28, acp draft', () => {
  assert.equal(A2A_V9_CURRENT_VERSION, '1.1');
  assert.equal(A2A_V9_IMPLEMENTED_VERSION, '1.1');
  assert.equal(MCP_V9_CURRENT_VERSION, '2026-07-28');
  assert.equal(ACP_V9_CURRENT_VERSION, 'draft');
  assert.equal(ACP_V9_IMPLEMENTATION_VERSION, '9.0');
  assert.equal(PROTOCOL_V9_CURRENT_VERSIONS.a2a, '1.1');
  assert.equal(PROTOCOL_V9_CURRENT_VERSIONS.mcp, '2026-07-28');
  assert.equal(PROTOCOL_V9_CURRENT_VERSIONS.ucp, '2026-08-25');
  assert.equal(PROTOCOL_V9_CURRENT_VERSIONS.gov, '1.0');
  assert.equal(PROTOCOL_V9_CURRENT_VERSIONS.nanda, '0.1-local');
  assert.deepEqual(ACP_V9_KNOWN_AGENTS, ['claude', 'codex', 'gemini']);
  for (const family of PROTOCOL_V9_FAMILIES) {
    assert.ok(PROTOCOL_V9_VERSION_MATRIX[family].includes(PROTOCOL_V9_CURRENT_VERSIONS[family]));
  }
  assert.match(protocolV9MatrixSummary(), /a2a 1\.1/);
  assert.match(protocolV9MatrixSummary(), /mcp 2026-07-28/);
});

test('negotiation picks the newest common version; unknown versions never win', () => {
  const n1 = negotiateProtocolV9Version('a2a', ['1.0', '1.1']);
  assert.equal(n1.agreed, '1.1');
  assert.equal(n1.peerHasCurrent, true);
  const n2 = negotiateProtocolV9Version('a2a', ['1.0.1']);
  assert.equal(n2.agreed, '1.0.1');
  assert.equal(n2.peerHasCurrent, false);
  assert.deepEqual(n2.peerOnly, []);
  const n3 = negotiateProtocolV9Version('mcp', ['2099-01-01']);
  assert.equal(n3.agreed, undefined);
  assert.deepEqual(n3.peerOnly, ['2099-01-01']);
  assert.ok(n3.localOnly.length > 0);
  const n4 = negotiateProtocolV9Version('acp', ['draft']);
  assert.equal(n4.agreed, 'draft');
  // The merged IBM/BeeAI ACP is never a version to negotiate.
  const n5 = negotiateProtocolV9Version('acp', ['merged']);
  assert.equal(n5.agreed, undefined);
});

test('negotiate-all covers every family', () => {
  const all = negotiateAllProtocolsV9({ a2a: ['1.1'], mcp: ['2026-07-28'] });
  assert.deepEqual(Object.keys(all).sort(), [...PROTOCOL_V9_FAMILIES].sort());
  assert.equal(all.a2a.agreed, '1.1');
  assert.equal(all.mcp.agreed, '2026-07-28');
  assert.equal(all.ucp.agreed, undefined);
});

test('changes since v8 and downgrade to v8 name the v9 additions', () => {
  const changes = protocolV9ChangesSinceV8();
  assert.ok(changes.some((c) => c.includes('1.1')));
  assert.ok(changes.some((c) => c.includes('Apps v2')));
  assert.ok(changes.some((c) => c.includes('Agent Client Protocol')));
  assert.ok(changes.some((c) => c.includes('loopback')));
  const down = protocolV9DowngradeToV8();
  assert.match(down.a2a, /1\.1 -> 1\.0\.1/);
  assert.match(down.mcp, /Apps v2 lifecycle/);
  assert.match(down.acp, /v9-only/);
  assert.match(down.ucp, /unchanged/);
});

test('feature flags: loopbackOnly must stay true', () => {
  assert.deepEqual(validateProtocolV9Features(PROTOCOL_V9_DEFAULT_FEATURES), []);
  assert.equal(PROTOCOL_V9_DEFAULT_FEATURES.loopbackOnly, true);
  const problems = validateProtocolV9Features({ ...PROTOCOL_V9_DEFAULT_FEATURES, loopbackOnly: false });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /loopbackOnly must stay true/);
});

test('A2A task state machine: legal transitions and terminal states', () => {
  assert.equal(isA2aV9TaskTransitionLegal('submitted', 'working'), true);
  assert.equal(isA2aV9TaskTransitionLegal('submitted', 'completed'), false);
  assert.equal(isA2aV9TaskTransitionLegal('working', 'completed'), true);
  assert.equal(isA2aV9TaskTransitionLegal('working', 'input-required'), true);
  assert.equal(isA2aV9TaskTransitionLegal('input-required', 'working'), true);
  assert.equal(isA2aV9TaskTransitionLegal('input-required', 'completed'), false);
  assert.equal(isA2aV9TaskTransitionLegal('completed', 'working'), false);
  assert.equal(isA2aV9TaskTerminal('completed'), true);
  assert.equal(isA2aV9TaskTerminal('failed'), true);
  assert.equal(isA2aV9TaskTerminal('canceled'), true);
  assert.equal(isA2aV9TaskTerminal('rejected'), true);
  assert.equal(isA2aV9TaskTerminal('working'), false);
  assert.equal(isA2aV9TaskTerminal('submitted'), false);
});

test('ACP session terminal states', () => {
  assert.equal(isAcpV9SessionTerminal('cancelled'), true);
  assert.equal(isAcpV9SessionTerminal('completed'), true);
  assert.equal(isAcpV9SessionTerminal('failed'), true);
  assert.equal(isAcpV9SessionTerminal('active'), false);
  assert.equal(isAcpV9SessionTerminal('suspended'), false);
});
