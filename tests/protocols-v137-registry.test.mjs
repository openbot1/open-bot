/**
 * Protocols v6 — registry tests (v1.37, Team T2).
 *
 * Covers packages/core/src/protocolsV6/registryV6.ts: the
 * Poppy watch-only entry (never implementable), the IETF ACP-WG
 * watch entry, requireImplemented refusals, the dated
 * "tested with" table (add / list / remove / latest per
 * family), JSON round-trip, and the compatibility report.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v137-registry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtocolV6Registry,
  ietfAcpWgV6WatchEntry,
  poppyV6WatchEntry,
  protocolV6CompatibilityReport,
  protocolV6RegistrySummary,
} from '../packages/core/dist/index.js';

test('default registry seeds Poppy + IETF ACP-WG as watch-only', () => {
  const registry = new ProtocolV6Registry();
  const entries = registry.listWatchEntries();
  assert.equal(entries.length, 2);
  const poppy = registry.poppyStatus();
  assert.equal(poppy.id, 'poppy');
  assert.equal(poppy.status, 'watch-only');
  assert.match(poppy.note, /watch-only, not implemented/);
  assert.equal(poppy.version, '1.0');
  assert.equal(registry.isImplemented('poppy'), false);
  assert.equal(registry.isImplemented('ietf-acp-wg'), false);
  const ietf = registry.getWatchEntry('ietf-acp-wg');
  assert.equal(ietf?.status, 'watch-only');
  assert.match(ietf?.note ?? '', /IETF working group/);
});

test('watch entry factories carry dated review stamps', () => {
  const poppy = poppyV6WatchEntry('2026-11-18');
  assert.equal(poppy.lastReviewed, '2026-11-18');
  assert.equal(poppy.source, 'docs/repo-survey-v137.md');
  const ietf = ietfAcpWgV6WatchEntry('2026-11-18');
  assert.equal(ietf.version, 'charter-2026-10');
});

test('Poppy can never be marked implemented; bad dates are refused', () => {
  const registry = new ProtocolV6Registry();
  assert.throws(
    () => registry.upsertWatchEntry({ ...poppyV6WatchEntry(), status: 'implemented' }),
    /watch-only/,
  );
  assert.throws(
    () => registry.upsertWatchEntry({
      id: 'x', name: 'X', version: '1.0', status: 'watch-only', note: '', lastReviewed: '18/11/2026', source: 'test',
    }),
    /not a YYYY-MM-DD/,
  );
  // A new watch-only entry works, and requireImplemented refuses it.
  registry.upsertWatchEntry({
    id: 'future-proto', name: 'Future', version: '0.1', status: 'watch-only',
    note: 'Not yet.', lastReviewed: '2026-11-18', source: 'test',
  });
  assert.throws(() => registry.requireImplemented('future-proto'), /watch-only/);
  assert.throws(() => registry.requireImplemented('poppy'), /watch-only/);
  // An implemented entry passes the guard.
  registry.upsertWatchEntry({
    id: 'acp', name: 'ACP', version: '2.0-draft', status: 'implemented',
    note: 'Spoken.', lastReviewed: '2026-11-18', source: 'test',
  });
  registry.requireImplemented('acp');
  assert.equal(registry.isImplemented('acp'), true);
  assert.equal(registry.listWatchEntries('implemented').length, 1);
  assert.equal(registry.listWatchEntries('watch-only').length, 3);
});

test('tested-with table: add, list, filter, latest per family, remove', () => {
  const registry = new ProtocolV6Registry();
  const row = registry.addTestedWith({
    peer: 'loopback-client',
    family: 'acp',
    version: '2.0-draft',
    testedOn: '2026-11-18',
    result: 'pass',
    coverage: 'session/prompt returns message id',
  });
  assert.match(row.rowId, /^tested6-/);
  registry.addTestedWith({
    peer: 'loopback-client', family: 'a2a', version: '1.1', testedOn: '2026-11-17',
    result: 'partial', coverage: 'two-way streaming, no resume yet',
  });
  registry.addTestedWith({
    peer: 'other-client', family: 'acp', version: '1.0', testedOn: '2026-11-16',
    result: 'pass', coverage: 'v1 parallel session',
  });
  assert.equal(registry.listTestedWith().length, 3);
  assert.equal(registry.listTestedWith({ family: 'acp' }).length, 2);
  assert.equal(registry.listTestedWith({ result: 'partial' }).length, 1);
  assert.equal(registry.listTestedWith({ peer: 'other-client' }).length, 1);
  const latest = registry.latestTestPerFamily();
  assert.equal(latest.acp?.testedOn, '2026-11-18');
  assert.equal(latest.a2a?.testedOn, '2026-11-17');
  assert.equal(latest.mcp, undefined);
  assert.equal(registry.removeTestedWith(row.rowId), true);
  assert.equal(registry.removeTestedWith(row.rowId), false);
  assert.equal(registry.listTestedWith({ family: 'acp' }).length, 1);
  assert.throws(
    () => registry.addTestedWith({
      peer: 'x', family: 'acp', version: '2.0-draft', testedOn: '18-11-2026', result: 'pass', coverage: 'x',
    }),
    /not a YYYY-MM-DD/,
  );
  assert.throws(
    () => registry.addTestedWith({
      peer: 'x', family: 'acp', version: '9.9', testedOn: '2026-11-18', result: 'pass', coverage: 'x',
    }),
    /Unknown acp version/,
  );
});

test('JSON round-trip keeps watch entries, rows and capabilities', () => {
  const registry = new ProtocolV6Registry();
  registry.addTestedWith({
    peer: 'loopback', family: 'mcp', version: '2026-07-28', testedOn: '2026-11-18',
    result: 'pass', coverage: 'elicitation form',
  });
  const json = registry.toJSON();
  assert.equal(json.watchEntries.length, 2);
  assert.equal(json.testedWith.length, 1);
  assert.deepEqual(json.capabilities.elicitationModes, ['form', 'url']);
  const restored = ProtocolV6Registry.fromJSON(json);
  assert.equal(restored.listWatchEntries().length, 2);
  assert.equal(restored.listTestedWith().length, 1);
  assert.equal(restored.poppyStatus().status, 'watch-only');
  // Bad JSON never breaks the registry.
  assert.equal(ProtocolV6Registry.fromJSON(null).listWatchEntries().length, 2);
  assert.equal(ProtocolV6Registry.fromJSON({ watchEntries: [{ id: 'poppy', name: 'P', version: '1.0', status: 'implemented' }] }).poppyStatus().status, 'watch-only');
});

test('compatibility report: six families, Poppy never implemented', () => {
  const report = protocolV6CompatibilityReport();
  assert.equal(report.length, 6);
  const poppy = report.find((r) => r.family === 'poppy');
  assert.equal(poppy?.implemented, false);
  assert.match(poppy?.note ?? '', /watch-only/);
  const acp = report.find((r) => r.family === 'acp');
  assert.equal(acp?.implemented, true);
  assert.equal(acp?.v5Compatible, true);
  assert.equal(acp?.v4Compatible, false); // v4 has no ACP
  const a2a = report.find((r) => r.family === 'a2a');
  assert.equal(a2a?.v5Compatible, true);
  assert.equal(a2a?.v4Compatible, false);
  const mcp = report.find((r) => r.family === 'mcp');
  assert.equal(mcp?.v5Compatible, true);
  assert.equal(mcp?.v4Compatible, true);
});

test('registry summary counts and one-line summary', () => {
  const registry = new ProtocolV6Registry();
  registry.addTestedWith({
    peer: 'loopback', family: 'acp', version: '2.0-draft', testedOn: '2026-11-18',
    result: 'pass', coverage: 'structured file changes',
  });
  const summary = registry.summary();
  assert.deepEqual(summary, { watchEntries: 2, watchOnly: 2, implemented: 0, testedWithRows: 1, testedFamilies: 1 });
  assert.match(protocolV6RegistrySummary(registry), /Poppy watch-only/);
  assert.match(protocolV6RegistrySummary(registry), /1 tested-with row/);
});
