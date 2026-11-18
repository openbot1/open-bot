/**
 * Protocols v5 — version matrix tests (v1.29, Team T2).
 *
 * Covers packages/core/src/protocolsV5/versions.ts: the v5 matrix
 * (ACP 2.0-draft current, A2A 1.1 final under the Linux
 * Foundation), negotiation (single + all families, removed
 * versions never picked), comparison, status, downgrade-to-v4
 * and the deprecation calendar.
 *
 * No network, no provider: everything runs in-process against
 * the built core dist.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v129-versions.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACP_V5_CURRENT_VERSION,
  A2A_V5_CURRENT_VERSION,
  MCP_V5_CURRENT_VERSION,
  PROTOCOL_V5_FAMILIES,
  compareProtocolV5Versions,
  negotiateAllProtocolsV5,
  negotiateProtocolV5Version,
  protocolV5DeprecationCalendar,
  protocolV5DowngradeToV4,
  protocolV5MatrixSummary,
  protocolV5VersionIsUnstable,
  protocolV5VersionStatus,
} from '../packages/core/dist/index.js';

test('v5 matrix has six families; ACP 2.0-draft and A2A 1.1 are current', () => {
  assert.deepEqual([...PROTOCOL_V5_FAMILIES], ['acp', 'poppy', 'mcp', 'a2a', 'agui', 'a2ui']);
  assert.equal(ACP_V5_CURRENT_VERSION, '2.0-draft');
  assert.equal(A2A_V5_CURRENT_VERSION, '1.1');
  assert.equal(MCP_V5_CURRENT_VERSION, '2026-07-28');
  assert.match(protocolV5MatrixSummary(), /acp 2\.0-draft/);
  assert.match(protocolV5MatrixSummary(), /a2a 1\.1/);
});

test('ACP 2.0-draft is unstable; A2A 1.1 is current, 1.1-rc legacy, 0.3 removed', () => {
  assert.equal(protocolV5VersionIsUnstable('acp', '2.0-draft'), true);
  assert.equal(protocolV5VersionIsUnstable('acp', '1.0'), false);
  assert.equal(protocolV5VersionStatus('a2a', '1.1'), 'current');
  assert.equal(protocolV5VersionStatus('a2a', '1.1-rc'), 'legacy');
  assert.equal(protocolV5VersionStatus('a2a', '0.3'), 'removed');
  assert.equal(protocolV5VersionStatus('a2a', '9.9'), 'unknown');
  assert.equal(protocolV5VersionStatus('acp', '2.0-draft'), 'current');
});

test('negotiation picks the highest common version and flags drafts', () => {
  const acp = negotiateProtocolV5Version('acp', ['1.0', '2.0-draft']);
  assert.equal(acp.negotiated, '2.0-draft');
  assert.equal(acp.unstable, true);
  assert.match(acp.note, /draft/);

  const a2a = negotiateProtocolV5Version('a2a', ['1.0', '1.1-rc']);
  assert.equal(a2a.negotiated, '1.1-rc');
  assert.equal(a2a.status, 'legacy');

  const none = negotiateProtocolV5Version('mcp', ['1900-01-01']);
  assert.equal(none.negotiated, null);
  assert.match(none.note, /No common/);

  const removedOnly = negotiateProtocolV5Version('a2a', ['0.3']);
  assert.equal(removedOnly.negotiated, null);
});

test('negotiate-all covers six families', () => {
  const all = negotiateAllProtocolsV5({
    acp: ['2.0-draft'],
    mcp: ['2026-07-28'],
    a2a: ['1.1'],
  });
  assert.equal(Object.keys(all).length, 6);
  assert.equal(all.acp.negotiated, '2.0-draft');
  assert.equal(all.a2a.negotiated, '1.1');
  assert.equal(all.poppy.negotiated, null);
});

test('compare orders draft below final and MCP dates chronologically', () => {
  assert.equal(compareProtocolV5Versions('acp', '2.0-draft', '1.0'), 1);
  assert.equal(compareProtocolV5Versions('acp', '2.0-draft', '2.0'), -1);
  assert.equal(compareProtocolV5Versions('acp', '2.0', '2.0-draft'), 1);
  assert.equal(compareProtocolV5Versions('a2a', '1.1-rc', '1.1'), -1);
  assert.equal(compareProtocolV5Versions('a2a', '1.1', '1.1-rc'), 1);
  assert.equal(compareProtocolV5Versions('a2a', '1.1', '1.1'), 0);
  assert.equal(compareProtocolV5Versions('mcp', '2025-11-25', '2026-07-28'), -1);
  assert.equal(compareProtocolV5Versions('mcp', '2026-07-28', '2026-07-28'), 0);
});

test('downgrade to v4: ACP is unavailable, A2A falls back to 1.1-rc, the rest negotiate', () => {
  const report = protocolV5DowngradeToV4();
  assert.equal(report.length, 6);
  const byFamily = Object.fromEntries(report.map((r) => [r.family, r]));
  assert.equal(byFamily.acp.compatible, false);
  assert.equal(byFamily.acp.v4Negotiated, null);
  assert.match(byFamily.acp.note, /new in v5/);
  assert.equal(byFamily.a2a.v4Negotiated, '1.1-rc');
  assert.equal(byFamily.a2a.compatible, true);
  assert.equal(byFamily.mcp.v4Negotiated, '2026-07-28');
  assert.equal(byFamily.agui.compatible, true);
});

test('deprecation calendar has one row per family with the MCP removal floor', () => {
  const calendar = protocolV5DeprecationCalendar();
  assert.equal(calendar.length, 6);
  const mcp = calendar.find((r) => r.family === 'mcp');
  assert.equal(mcp?.removalDate, '2027-07-28');
  assert.match(mcp?.note ?? '', /2027-07-28/);
  const acp = calendar.find((r) => r.family === 'acp');
  assert.equal(acp?.current, '2.0-draft');
  assert.match(acp?.note ?? '', /Linux Foundation/);
  const a2a = calendar.find((r) => r.family === 'a2a');
  assert.deepEqual([...(a2a?.removed ?? [])], ['0.3', '0.2']);
});
