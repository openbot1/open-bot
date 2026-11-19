/**
 * Protocols v6 — version matrix + negotiation tests (v1.37, Team T2).
 *
 * Covers packages/core/src/protocolsV6/versions.ts:
 * matrix currents, Poppy watch-only (never implemented), version
 * comparison / status / unstable flags, single + all-family
 * negotiation (incl. no-overlap and removed versions never
 * picked), capability advertisement + intersection, downgrade
 * to v5, deprecation calendar, changes since v5.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v137-versions.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACP_V6_CURRENT_VERSION,
  A2A_V6_CURRENT_VERSION,
  MCP_V6_CURRENT_VERSION,
  POPPY_V6_CURRENT_VERSION,
  POPPY_V6_IMPLEMENTATION_STATUS,
  PROTOCOL_V6_CURRENT_VERSIONS,
  compareProtocolV6Versions,
  defaultProtocolV6Capabilities,
  negotiateAllProtocolsV6,
  negotiateProtocolV6Capabilities,
  negotiateProtocolV6Version,
  protocolV6ChangesSinceV5,
  protocolV6DeprecationCalendar,
  protocolV6DowngradeToV5,
  protocolV6IsImplemented,
  protocolV6MatrixSummary,
  protocolV6VersionIsUnstable,
  protocolV6VersionStatus,
} from '../packages/core/dist/index.js';

test('v6 currents: ACP 2.0-draft, A2A 1.1, MCP 2026-07-28', () => {
  assert.equal(ACP_V6_CURRENT_VERSION, '2.0-draft');
  assert.equal(A2A_V6_CURRENT_VERSION, '1.1');
  assert.equal(MCP_V6_CURRENT_VERSION, '2026-07-28');
  assert.equal(PROTOCOL_V6_CURRENT_VERSIONS.acp, '2.0-draft');
  assert.equal(PROTOCOL_V6_CURRENT_VERSIONS.a2a, '1.1');
  assert.equal(PROTOCOL_V6_CURRENT_VERSIONS.mcp, '2026-07-28');
  assert.equal(PROTOCOL_V6_CURRENT_VERSIONS.agui, '1.0');
  assert.equal(PROTOCOL_V6_CURRENT_VERSIONS.a2ui, '1.0');
  assert.match(protocolV6MatrixSummary(), /acp 2\.0-draft/);
  assert.match(protocolV6MatrixSummary(), /a2a 1\.1/);
});

test('Poppy is watch-only: listed in the matrix, never implemented', () => {
  assert.equal(POPPY_V6_CURRENT_VERSION, '1.0');
  assert.equal(POPPY_V6_IMPLEMENTATION_STATUS, 'watch-only');
  assert.equal(protocolV6IsImplemented('poppy'), false);
  assert.equal(protocolV6IsImplemented('poppy', '1.0'), false);
  assert.equal(protocolV6IsImplemented('acp'), true);
  assert.equal(protocolV6IsImplemented('acp', '2.0-draft'), true);
  assert.equal(protocolV6IsImplemented('a2a', '0.3'), false);
});

test('version status: current / legacy / removed / unknown', () => {
  assert.equal(protocolV6VersionStatus('acp', '2.0-draft'), 'current');
  assert.equal(protocolV6VersionStatus('acp', '1.0'), 'legacy');
  assert.equal(protocolV6VersionStatus('a2a', '1.1'), 'current');
  assert.equal(protocolV6VersionStatus('a2a', '1.1-rc'), 'legacy');
  assert.equal(protocolV6VersionStatus('a2a', '0.3'), 'removed');
  assert.equal(protocolV6VersionStatus('a2a', '9.9'), 'unknown');
  assert.equal(protocolV6VersionStatus('mcp', '2026-07-28'), 'current');
  assert.equal(protocolV6VersionStatus('mcp', '2024-11-05'), 'legacy');
});

test('draft / RC versions are unstable, finals are not', () => {
  assert.equal(protocolV6VersionIsUnstable('acp', '2.0-draft'), true);
  assert.equal(protocolV6VersionIsUnstable('acp', '1.0'), false);
  assert.equal(protocolV6VersionIsUnstable('a2a', '1.1-rc'), true);
  assert.equal(protocolV6VersionIsUnstable('a2a', '1.1'), false);
  assert.equal(protocolV6VersionIsUnstable('poppy', '0.2'), true);
  assert.equal(protocolV6VersionIsUnstable('poppy', '1.0'), false);
});

test('compare: draft sorts below its final, MCP dates sort numerically', () => {
  assert.ok(compareProtocolV6Versions('acp', '1.0', '2.0-draft') < 0);
  assert.ok(compareProtocolV6Versions('acp', '2.0-draft', '2.0') < 0);
  assert.ok(compareProtocolV6Versions('a2a', '1.1-rc', '1.1') < 0);
  assert.equal(compareProtocolV6Versions('a2a', '1.1', '1.1'), 0);
  assert.ok(compareProtocolV6Versions('mcp', '2025-06-18', '2026-07-28') < 0);
  assert.ok(compareProtocolV6Versions('mcp', '2026-07-28', '2025-11-25') > 0);
});

test('negotiation picks the highest common version; removed versions are never picked', () => {
  const acp = negotiateProtocolV6Version('acp', ['1.0', '2.0-draft']);
  assert.equal(acp.negotiated, '2.0-draft');
  assert.equal(acp.status, 'current');
  assert.equal(acp.unstable, true);
  assert.equal(acp.implemented, true);

  const a2a = negotiateProtocolV6Version('a2a', ['0.3', '0.2', '1.0']);
  assert.equal(a2a.negotiated, '1.0');
  assert.equal(a2a.status, 'legacy');

  const removedOnly = negotiateProtocolV6Version('a2a', ['0.3', '0.2']);
  assert.equal(removedOnly.negotiated, null);

  const none = negotiateProtocolV6Version('mcp', ['1999-01-01']);
  assert.equal(none.negotiated, null);
  assert.equal(none.status, 'unknown');
  assert.match(none.note, /No common mcp version/);
});

test('Poppy negotiation marks implemented:false with a watch-only note', () => {
  const poppy = negotiateProtocolV6Version('poppy', ['1.0']);
  assert.equal(poppy.negotiated, '1.0');
  assert.equal(poppy.implemented, false);
  assert.match(poppy.note, /watch-only/);
});

test('all-family negotiation covers all six families', () => {
  const all = negotiateAllProtocolsV6({
    acp: ['2.0-draft'],
    poppy: ['1.0'],
    mcp: ['2026-07-28'],
    a2a: ['1.1'],
    agui: ['1.0'],
    a2ui: ['1.0'],
  });
  assert.equal(Object.keys(all).length, 6);
  assert.equal(all.acp?.negotiated, '2.0-draft');
  assert.equal(all.a2a?.negotiated, '1.1');
  assert.equal(all.poppy?.implemented, false);
  const empty = negotiateAllProtocolsV6({});
  assert.equal(empty.acp?.negotiated, null);
});

test('capability advertisement: default is full, intersection is the overlap', () => {
  const defaults = defaultProtocolV6Capabilities();
  assert.deepEqual(defaults.elicitationModes, ['form', 'url']);
  assert.equal(defaults.a2aTwoWayStreaming, true);
  assert.equal(defaults.acpStructuredFileChanges, true);
  assert.equal(defaults.acpOutOfTurnUpdates, true);
  assert.equal(defaults.acpPromptMessageIds, true);
  assert.equal(defaults.acpV1Parallel, true);

  const partial = negotiateProtocolV6Capabilities({
    elicitationModes: ['form'],
    a2aTwoWayStreaming: true,
    acpStructuredFileChanges: false,
    acpOutOfTurnUpdates: true,
    acpPromptMessageIds: false,
    acpV1Parallel: true,
  });
  assert.deepEqual(partial.elicitationModes, ['form']);
  assert.equal(partial.a2aTwoWayStreaming, true);
  assert.equal(partial.acpStructuredFileChanges, false);
  assert.equal(partial.acpPromptMessageIds, false);

  const none = negotiateProtocolV6Capabilities(undefined);
  assert.deepEqual(none.elicitationModes, []);
  assert.equal(none.a2aTwoWayStreaming, false);
});

test('downgrade to v5: same currents everywhere, Poppy still watch-only', () => {
  const report = protocolV6DowngradeToV5();
  assert.equal(report.length, 6);
  const acp = report.find((r) => r.family === 'acp');
  assert.equal(acp?.v6Current, '2.0-draft');
  assert.equal(acp?.v5Negotiated, '2.0-draft');
  assert.equal(acp?.compatible, true);
  const poppy = report.find((r) => r.family === 'poppy');
  assert.equal(poppy?.implemented, false);
  assert.match(poppy?.note ?? '', /watch-only/);
});

test('deprecation calendar: six rows, MCP removal date, Poppy watch note', () => {
  const calendar = protocolV6DeprecationCalendar();
  assert.equal(calendar.length, 6);
  const mcp = calendar.find((r) => r.family === 'mcp');
  assert.equal(mcp?.removalDate, '2027-07-28');
  assert.match(mcp?.note ?? '', /Elicitation is stable/);
  const poppy = calendar.find((r) => r.family === 'poppy');
  assert.match(poppy?.note ?? '', /watch-only/);
  const acp = calendar.find((r) => r.family === 'acp');
  assert.match(acp?.note ?? '', /in parallel/);
});

test('changes since v5 name the v6-only capabilities', () => {
  const changes = protocolV6ChangesSinceV5();
  assert.ok(changes.length >= 5);
  assert.ok(changes.some((c) => c.includes('structured file changes')));
  assert.ok(changes.some((c) => c.includes('Elicitation is stable')));
  assert.ok(changes.some((c) => c.includes('two-way streaming')));
  assert.ok(changes.some((c) => c.includes('Poppy')));
  assert.ok(changes.some((c) => c.includes('IETF')));
});
