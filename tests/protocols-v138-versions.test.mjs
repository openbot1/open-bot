/**
 * Protocols v7 — version matrix tests (v1.38, Team T2).
 *
 * Covers packages/core/src/protocolsV7/versions.ts:
 * version matrix + negotiation (A2A 1.0.1 current, ACP merged,
 * Poppy watch-only, UCP read-only, gov 1.0), capability
 * advertisement + negotiation, downgrade to v6, deprecation
 * calendar, changes since v6.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v138-versions.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2A_V7_CURRENT_VERSION,
  A2A_V7_METHODS,
  GOV_V7_CURRENT_VERSION,
  MCP_V7_CURRENT_VERSION,
  MCP_V7_STATELESS_METHODS,
  PROTOCOL_V7_FAMILIES,
  PROTOCOL_V7_CURRENT_VERSIONS,
  UCP_V7_CURRENT_VERSION,
  UCP_V7_REFUSED_OPERATIONS,
  defaultProtocolV7Capabilities,
  negotiateAllProtocolsV7,
  negotiateProtocolV7Capabilities,
  negotiateProtocolV7Version,
  protocolV7ChangesSinceV6,
  protocolV7DeprecationCalendar,
  protocolV7DowngradeToV6,
  protocolV7IsImplemented,
  protocolV7MatrixSummary,
  protocolV7VersionStatus,
} from '../packages/core/dist/index.js';

test('v7 matrix pins the right currents', () => {
  assert.equal(A2A_V7_CURRENT_VERSION, '1.0.1');
  assert.equal(MCP_V7_CURRENT_VERSION, '2026-07-28');
  assert.equal(UCP_V7_CURRENT_VERSION, '2026-08-25');
  assert.equal(GOV_V7_CURRENT_VERSION, '1.0');
  assert.equal(PROTOCOL_V7_CURRENT_VERSIONS.acp, '');
  assert.deepEqual([...PROTOCOL_V7_FAMILIES].sort(), ['a2a', 'a2ui', 'acp', 'agui', 'gov', 'mcp', 'poppy', 'ucp']);
});

test('A2A 1.0.1 method surface includes tasks/list + push configs', () => {
  for (const method of ['message/send', 'message/stream', 'tasks/get', 'tasks/cancel', 'tasks/list', 'tasks/resubscribe', 'tasks/pushNotificationConfig/set']) {
    assert.ok((A2A_V7_METHODS).includes(method), `missing ${method}`);
  }
  assert.ok(MCP_V7_STATELESS_METHODS.includes('tools/call'));
  assert.ok(!MCP_V7_STATELESS_METHODS.includes('initialize'));
});

test('UCP money operations are refused by construction', () => {
  for (const op of ['checkout/create', 'payment/capture', 'payment/refund', 'order/place']) {
    assert.ok(UCP_V7_REFUSED_OPERATIONS.includes(op), `missing refused ${op}`);
  }
});

test('negotiation picks the highest common version', () => {
  const a2a = negotiateProtocolV7Version('a2a', ['1.1', '1.0.1', '1.0']);
  assert.equal(a2a.negotiated, '1.1');
  assert.equal(a2a.implemented, true);
  const mcp = negotiateProtocolV7Version('mcp', ['2026-07-28']);
  assert.equal(mcp.negotiated, '2026-07-28');
  const ucp = negotiateProtocolV7Version('ucp', ['2026-08-25']);
  assert.equal(ucp.negotiated, '2026-08-25');
  assert.equal(ucp.implemented, true);
});

test('negotiation returns null when nothing overlaps', () => {
  const r = negotiateProtocolV7Version('a2a', ['9.9']);
  assert.equal(r.negotiated, null);
  assert.equal(r.implemented, false);
  assert.match(r.note, /No common/);
});

test('removed A2A versions are never picked', () => {
  const r = negotiateProtocolV7Version('a2a', ['0.3', '0.2']);
  assert.equal(r.negotiated, null);
  assert.equal(protocolV7VersionStatus('a2a', '0.3'), 'removed');
  assert.equal(protocolV7VersionStatus('a2a', '1.0'), 'legacy');
  assert.equal(protocolV7VersionStatus('a2a', '1.0.1'), 'current');
});

test('ACP always negotiates null (merged into A2A)', () => {
  const r = negotiateProtocolV7Version('acp', ['2.0-draft', '1.0']);
  assert.equal(r.negotiated, null);
  assert.equal(r.status, 'merged');
  assert.equal(r.implemented, false);
  assert.equal(protocolV7IsImplemented('acp'), false);
});

test('Poppy negotiates a version but is never implemented', () => {
  const r = negotiateProtocolV7Version('poppy', ['1.0']);
  assert.equal(r.negotiated, '1.0');
  assert.equal(r.status, 'watch-only');
  assert.equal(r.implemented, false);
  assert.equal(protocolV7IsImplemented('poppy'), false);
});

test('negotiate-all covers every family', () => {
  const all = negotiateAllProtocolsV7({
    a2a: ['1.0.1'],
    mcp: ['2026-07-28'],
    ucp: ['2026-08-25'],
    gov: ['1.0'],
    agui: ['1.0'],
    a2ui: ['1.0'],
    poppy: ['1.0'],
  });
  assert.equal(all.a2a.negotiated, '1.0.1');
  assert.equal(all.mcp.negotiated, '2026-07-28');
  assert.equal(all.ucp.negotiated, '2026-08-25');
  assert.equal(all.gov.negotiated, '1.0');
  assert.equal(all.acp.negotiated, null);
  assert.equal(all.poppy.implemented, false);
});

test('capability negotiation intersects with the peer', () => {
  const local = defaultProtocolV7Capabilities();
  assert.equal(local.a2aComplete101, true);
  assert.equal(local.mcpStatelessHttp, true);
  assert.equal(local.ucpReadOnly, true);
  assert.equal(local.governance, true);
  const none = negotiateProtocolV7Capabilities(undefined);
  assert.equal(none.a2aComplete101, false);
  assert.deepEqual(none.elicitationModes, []);
  const partial = negotiateProtocolV7Capabilities({ a2aComplete101: true, mcpStatelessHttp: false, elicitationModes: ['form'] });
  assert.equal(partial.a2aComplete101, true);
  assert.equal(partial.mcpStatelessHttp, false);
  assert.deepEqual(partial.elicitationModes, ['form']);
});

test('downgrade to v6: UCP and gov have nothing to negotiate', () => {
  const rows = protocolV7DowngradeToV6();
  assert.equal(rows.length, PROTOCOL_V7_FAMILIES.length);
  const byFamily = Object.fromEntries(rows.map((r) => [r.family, r]));
  assert.equal(byFamily.ucp.compatible, false);
  assert.equal(byFamily.gov.compatible, false);
  assert.equal(byFamily.acp.compatible, false);
  assert.equal(byFamily.a2a.compatible, true);
  assert.equal(byFamily.a2a.v6Negotiated, '1.1');
  assert.equal(byFamily.mcp.compatible, true);
});

test('deprecation calendar covers every family', () => {
  const rows = protocolV7DeprecationCalendar();
  assert.equal(rows.length, PROTOCOL_V7_FAMILIES.length);
  const acp = rows.find((r) => r.family === 'acp');
  assert.equal(acp.current, '');
  assert.match(acp.note, /merged/i);
  const ucp = rows.find((r) => r.family === 'ucp');
  assert.match(ucp.note, /refused/i);
});

test('changes since v6 + matrix summary', () => {
  const changes = protocolV7ChangesSinceV6();
  assert.ok(changes.length >= 5);
  assert.ok(changes.some((c) => c.includes('1.0.1')));
  assert.ok(changes.some((c) => c.includes('stateless')));
  assert.ok(changes.some((c) => c.includes('read-only')));
  assert.ok(changes.some((c) => c.includes('Governance')));
  const summary = protocolV7MatrixSummary();
  assert.match(summary, /a2a 1\.0\.1/);
  assert.match(summary, /mcp 2026-07-28/);
  assert.match(summary, /ucp 2026-08-25/);
  assert.match(summary, /acp merged/);
});
