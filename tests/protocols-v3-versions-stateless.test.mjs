/**
 * Tests for v1.19 (Team T3) — protocols v3, part 1:
 * packages/core/src/protocolsV3/versions.ts
 * packages/core/src/protocolsV3/mcpStatelessV3.ts
 *
 * Covers:
 *  - Version matrix: current / legacy / removed / unknown status per
 *    family, semver + date-version parsing and comparison, capability
 *    matching, extension labels.
 *  - Unified negotiation: newest common version, no-overlap fallback
 *    (empty server list), throwing variant, negotiate-all-families.
 *  - MCP stateless header negotiation: parse (case-insensitive,
 *    array value, empty, unknown), build request headers, legacy
 *    session-header detection, strict vs lenient mismatch.
 *  - Negotiated stateless request: _meta + headers together,
 *    unknown version refused, legacy session header refused;
 *    incoming _meta validation (good / malformed / unknown version).
 *  - Extension registry: default set (Tasks / Apps / Skills /
 *    Elicitation), negotiate from server/discover (id + capability
 *    key both required), per-method gate, unknown ids ignored.
 *  - Deprecated-feature gate: warn records a notice, block refuses
 *    before any transport, allow is silent, non-deprecated methods
 *    pass through, policy change at runtime.
 *  - Migration advisor: modern server is stateless-ready, legacy
 *    server with sampling/roots needs the shim and must replace
 *    deprecated areas, next steps are produced.
 *
 * No network, no model. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v3-versions-stateless.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  A2A_V3_CURRENT_VERSION,
  A2A_V3_REMOVED_VERSIONS,
  AGUI_V3_CURRENT_VERSION,
  A2UI_V3_CURRENT_VERSION,
  MCP_V3_CURRENT_VERSION,
  MCP_V3_EXTENSION_IDS,
  MCP_V3_EXTENSION_ID_LIST,
  MCP_V3_LEGACY_REMOVAL_DATE,
  PROTOCOL_V3_CURRENT_VERSIONS,
  PROTOCOL_V3_FAMILIES,
  PROTOCOL_V3_KNOWN_CAPABILITIES,
  PROTOCOL_V3_VERSION_MATRIX,
  ProtocolV3VersionError,
  compareProtocolV3Versions,
  isKnownMcpV3Extension,
  isLegacyProtocolV3Version,
  isSupportedProtocolV3Version,
  matchCapabilitiesV3,
  mcpV3ExtensionLabel,
  mcpV3LegacyRemovalInDays,
  negotiateAllProtocolsV3,
  negotiateProtocolV3Version,
  negotiateProtocolV3VersionOrThrow,
  parseMcpV3DateVersion,
  parseProtocolV3Semver,
  protocolV3VersionStatus,
} from '../packages/core/dist/protocolsV3/versions.js';
import {
  DeprecatedFeatureGate,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_SESSION_ID_HEADER,
  McpStatelessV3Error,
  McpV3ExtensionRegistry,
  assessStatelessReadiness,
  buildNegotiatedStatelessRequest,
  buildStatelessRequestHeaders,
  defaultMcpV3Extensions,
  deprecatedMethodArea,
  hasLegacySessionHeader,
  negotiateProtocolVersionHeaders,
  parseProtocolVersionHeader,
  validateIncomingStatelessMeta,
} from '../packages/core/dist/protocolsV3/mcpStatelessV3.js';

// ---------------------------------------------------------------------------
// versions: matrix + status
// ---------------------------------------------------------------------------

test('v3 versions: current versions and families are pinned', () => {
  assert.deepEqual([...PROTOCOL_V3_FAMILIES], ['mcp', 'a2a', 'agui', 'a2ui']);
  assert.equal(MCP_V3_CURRENT_VERSION, '2026-07-28');
  assert.equal(A2A_V3_CURRENT_VERSION, '1.1');
  assert.equal(AGUI_V3_CURRENT_VERSION, '1.0');
  assert.equal(A2UI_V3_CURRENT_VERSION, '1.0');
  assert.deepEqual(PROTOCOL_V3_CURRENT_VERSIONS, {
    mcp: '2026-07-28',
    a2a: '1.1',
    agui: '1.0',
    a2ui: '1.0',
  });
  assert.equal(MCP_V3_LEGACY_REMOVAL_DATE, '2027-07-28');
  assert.ok(PROTOCOL_V3_VERSION_MATRIX.mcp.includes('2024-11-05'));
  assert.ok(PROTOCOL_V3_VERSION_MATRIX.a2a.includes('0.2'));
  assert.ok(PROTOCOL_V3_KNOWN_CAPABILITIES.mcp.includes('stateless'));
  assert.ok(PROTOCOL_V3_KNOWN_CAPABILITIES.a2a.includes('twoWayStreaming'));
});

test('v3 versions: status per family (current / legacy / removed / unknown)', () => {
  assert.equal(protocolV3VersionStatus('mcp', '2026-07-28'), 'current');
  assert.equal(protocolV3VersionStatus('mcp', '2025-03-26'), 'legacy');
  assert.equal(protocolV3VersionStatus('mcp', '1999-01-01'), 'unknown');
  assert.equal(protocolV3VersionStatus('a2a', '1.1'), 'current');
  assert.equal(protocolV3VersionStatus('a2a', '1.0'), 'legacy');
  for (const removed of A2A_V3_REMOVED_VERSIONS) {
    assert.equal(protocolV3VersionStatus('a2a', removed), 'removed');
    assert.equal(isSupportedProtocolV3Version('a2a', removed), false);
  }
  assert.equal(protocolV3VersionStatus('agui', '0.0.1'), 'legacy');
  assert.equal(protocolV3VersionStatus('a2ui', '0.1'), 'legacy');
  assert.equal(protocolV3VersionStatus('agui', '9.9'), 'unknown');
  assert.equal(isSupportedProtocolV3Version('mcp', '2025-11-25'), true);
  assert.equal(isSupportedProtocolV3Version('mcp', '1999-01-01'), false);
  assert.equal(isLegacyProtocolV3Version('mcp', '2024-11-05'), true);
  assert.equal(isLegacyProtocolV3Version('mcp', '2026-07-28'), false);
});

test('v3 versions: parsing and comparison', () => {
  assert.deepEqual(parseProtocolV3Semver('1.1'), [1, 1]);
  assert.deepEqual(parseProtocolV3Semver('1.0.3'), [1, 0]);
  assert.equal(parseProtocolV3Semver('x'), null);
  assert.equal(parseProtocolV3Semver(''), null);
  assert.equal(parseMcpV3DateVersion('2026-07-28'), 20260728);
  assert.equal(parseMcpV3DateVersion('2025-03-26'), 20250326);
  assert.equal(parseMcpV3DateVersion('not-a-date'), null);
  assert.equal(compareProtocolV3Versions('mcp', '2025-03-26', '2026-07-28'), -1);
  assert.equal(compareProtocolV3Versions('mcp', '2026-07-28', '2026-07-28'), 0);
  assert.equal(compareProtocolV3Versions('mcp', '2026-07-28', '2025-03-26'), 1);
  assert.equal(compareProtocolV3Versions('a2a', '1.0', '1.1'), -1);
  assert.equal(compareProtocolV3Versions('a2a', '1.1', '1.0'), 1);
  assert.equal(compareProtocolV3Versions('agui', '0.0.1', '1.0'), -1);
});

test('v3 versions: legacy removal countdown', () => {
  assert.equal(mcpV3LegacyRemovalInDays(new Date('2027-07-27T00:00:00.000Z')), 1);
  assert.equal(mcpV3LegacyRemovalInDays(new Date('2027-07-28T00:00:00.000Z')), 0);
  // Past the removal date the countdown floors at 0, never negative.
  assert.equal(mcpV3LegacyRemovalInDays(new Date('2028-01-01T00:00:00.000Z')), 0);
  assert.ok(mcpV3LegacyRemovalInDays(new Date('2026-11-16T00:00:00.000Z')) > 200);
});

test('v3 versions: capability matching and extension labels', () => {
  assert.deepEqual(matchCapabilitiesV3(['tools', 'tasks'], ['tools']), {
    matched: ['tools'],
    missing: ['tasks'],
    extra: [],
  });
  assert.deepEqual(matchCapabilitiesV3(['tools'], ['tools', 'apps']), {
    matched: ['tools'],
    missing: [],
    extra: ['apps'],
  });
  assert.equal(MCP_V3_EXTENSION_ID_LIST.length, 4);
  assert.ok(isKnownMcpV3Extension(MCP_V3_EXTENSION_IDS.tasks));
  assert.ok(isKnownMcpV3Extension('io.modelcontextprotocol/apps'));
  assert.equal(isKnownMcpV3Extension('io.modelcontextprotocol/nope'), false);
  assert.equal(mcpV3ExtensionLabel(MCP_V3_EXTENSION_IDS.tasks), 'Tasks');
  assert.equal(mcpV3ExtensionLabel(MCP_V3_EXTENSION_IDS.skills), 'Skills over MCP');
  assert.equal(mcpV3ExtensionLabel('io.example/unknown'), 'io.example/unknown');
});

// ---------------------------------------------------------------------------
// versions: negotiation
// ---------------------------------------------------------------------------

test('v3 negotiate: newest common version wins, legacy is reported', () => {
  const out = negotiateProtocolV3Version(
    'mcp',
    ['2026-07-28', '2025-11-25', '2025-03-26'],
    ['2025-11-25', '2025-03-26'],
  );
  assert.equal(out.version, '2025-11-25');
  assert.equal(out.status, 'legacy');
  assert.equal(out.family, 'mcp');

  const current = negotiateProtocolV3Version('a2a', ['1.1', '1.0'], ['1.1', '1.0']);
  assert.equal(current.version, '1.1');
  assert.equal(current.status, 'current');
});

test('v3 negotiate: no overlap returns null; empty server list falls back to client newest', () => {
  const none = negotiateProtocolV3Version('a2a', ['1.1', '1.0'], ['0.2', '0.3']);
  assert.equal(none.version, null);
  assert.equal(none.status, 'unknown');

  // A server that lists nothing at all: the client may still speak
  // its newest offered version (pre-discovery servers).
  const fallback = negotiateProtocolV3Version('mcp', ['2026-07-28', '2025-11-25'], []);
  assert.equal(fallback.version, '2026-07-28');
  assert.equal(fallback.status, 'current');
  const fallbackUndefined = negotiateProtocolV3Version('agui', ['1.0'], undefined);
  assert.equal(fallbackUndefined.version, '1.0');
});

test('v3 negotiate: throwing variant reports both sides', () => {
  const ok = negotiateProtocolV3VersionOrThrow('a2a', ['1.1'], ['1.1', '1.0']);
  assert.equal(ok.version, '1.1');
  assert.throws(
    () => negotiateProtocolV3VersionOrThrow('a2a', ['1.1'], ['0.2']),
    (err) => err instanceof ProtocolV3VersionError && err.code === 'NO_COMMON_VERSION'
      && err.family === 'a2a' && /No common a2a version/.test(err.message),
  );
});

test('v3 negotiate: negotiateAllProtocolsV3 covers all four families', () => {
  const all = negotiateAllProtocolsV3({
    mcp: ['2026-07-28'],
    a2a: ['1.1'],
    agui: ['1.0'],
    a2ui: ['1.0'],
  });
  for (const family of PROTOCOL_V3_FAMILIES) {
    assert.equal(all[family].status, 'current', family);
    assert.equal(all[family].version, PROTOCOL_V3_CURRENT_VERSIONS[family], family);
  }
  // No server info at all: every family falls back to its current version.
  const empty = negotiateAllProtocolsV3({});
  for (const family of PROTOCOL_V3_FAMILIES) {
    assert.equal(empty[family].version, PROTOCOL_V3_CURRENT_VERSIONS[family], family);
  }
  // Mixed: legacy MCP + removed A2A.
  const mixed = negotiateAllProtocolsV3({ mcp: ['2025-06-18'], a2a: ['0.3'] });
  assert.equal(mixed.mcp.version, '2025-06-18');
  assert.equal(mixed.mcp.status, 'legacy');
  assert.equal(mixed.a2a.version, null);
});

// ---------------------------------------------------------------------------
// stateless: header negotiation
// ---------------------------------------------------------------------------

test('v3 stateless: parse protocol version header (case-insensitive, array, empty, unknown)', () => {
  assert.equal(MCP_PROTOCOL_VERSION_HEADER, 'MCP-Protocol-Version');
  assert.equal(MCP_SESSION_ID_HEADER, 'Mcp-Session-Id');

  const parsed = parseProtocolVersionHeader({ 'MCP-Protocol-Version': '2026-07-28' });
  assert.deepEqual(parsed, { raw: '2026-07-28', version: '2026-07-28', known: true });

  const lower = parseProtocolVersionHeader({ 'mcp-protocol-version': ' 2025-11-25 ' });
  assert.equal(lower.version, '2025-11-25');
  assert.equal(lower.known, true);

  const array = parseProtocolVersionHeader({ 'MCP-Protocol-Version': ['2026-07-28', '2025-03-26'] });
  assert.equal(array.version, '2026-07-28');

  assert.equal(parseProtocolVersionHeader({}), null);
  assert.equal(parseProtocolVersionHeader({ 'Content-Type': 'application/json' }), null);

  const empty = parseProtocolVersionHeader({ 'MCP-Protocol-Version': '   ' });
  assert.deepEqual(empty, { raw: '', version: null, known: false });

  const unknown = parseProtocolVersionHeader({ 'MCP-Protocol-Version': '1999-01-01' });
  assert.equal(unknown.version, null);
  assert.equal(unknown.known, false);
});

test('v3 stateless: build request headers + legacy session header detection', () => {
  assert.deepEqual(buildStatelessRequestHeaders(), { 'MCP-Protocol-Version': '2026-07-28' });
  assert.deepEqual(
    buildStatelessRequestHeaders('2025-11-25', { 'X-Test': '1' }),
    { 'MCP-Protocol-Version': '2025-11-25', 'X-Test': '1' },
  );
  assert.equal(hasLegacySessionHeader({ 'Mcp-Session-Id': 'abc' }), true);
  assert.equal(hasLegacySessionHeader({ 'mcp-session-id': 'abc' }), true);
  assert.equal(hasLegacySessionHeader({ 'MCP-Protocol-Version': '2026-07-28' }), false);
  assert.equal(hasLegacySessionHeader({}), false);
});

test('v3 stateless: header negotiation — no header, agree, lenient + strict mismatch', () => {
  const noHeader = negotiateProtocolVersionHeaders('2026-07-28', {});
  assert.equal(noHeader.responded, null);
  assert.equal(noHeader.agreed, true);
  assert.equal(noHeader.negotiated, '2026-07-28');

  const agree = negotiateProtocolVersionHeaders('2026-07-28', { 'MCP-Protocol-Version': '2026-07-28' });
  assert.equal(agree.agreed, true);
  assert.equal(agree.negotiated, '2026-07-28');
  assert.match(agree.note, /Both sides speak/);

  const lenient = negotiateProtocolVersionHeaders('2026-07-28', { 'MCP-Protocol-Version': '2025-11-25' });
  assert.equal(lenient.agreed, false);
  assert.equal(lenient.responded, '2025-11-25');
  assert.equal(lenient.negotiated, '2025-11-25');

  assert.throws(
    () => negotiateProtocolVersionHeaders('2026-07-28', { 'MCP-Protocol-Version': '2025-11-25' }, { strict: true }),
    (err) => err instanceof McpStatelessV3Error && err.code === 'VERSION_MISMATCH',
  );
});

// ---------------------------------------------------------------------------
// stateless: negotiated request + incoming _meta
// ---------------------------------------------------------------------------

test('v3 stateless: build negotiated request (meta + headers together)', () => {
  const req = buildNegotiatedStatelessRequest({
    clientInfo: { name: 'open-bot', version: '1.19.0' },
  });
  assert.equal(req.protocolVersion, '2026-07-28');
  assert.equal(req.headers['MCP-Protocol-Version'], '2026-07-28');
  assert.equal(req.meta.protocolVersion, '2026-07-28');
  assert.equal(req.meta.clientInfo.name, 'open-bot');
  assert.deepEqual(req.extensions, []);

  const withExt = buildNegotiatedStatelessRequest({
    protocolVersion: '2025-11-25',
    extensions: [MCP_V3_EXTENSION_IDS.tasks],
  });
  assert.equal(withExt.protocolVersion, '2025-11-25');
  assert.deepEqual(withExt.extensions, [MCP_V3_EXTENSION_IDS.tasks]);

  assert.throws(
    () => buildNegotiatedStatelessRequest({ protocolVersion: '1999-01-01' }),
    (err) => err instanceof McpStatelessV3Error && err.code === 'UNKNOWN_VERSION',
  );
  assert.throws(
    () => buildNegotiatedStatelessRequest({ extraHeaders: { 'Mcp-Session-Id': 'x' } }),
    (err) => err instanceof McpStatelessV3Error && err.code === 'LEGACY_SESSION_HEADER',
  );
});

test('v3 stateless: validate incoming _meta', () => {
  const good = buildNegotiatedStatelessRequest();
  const ok = validateIncomingStatelessMeta(good.meta);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.meta.protocolVersion, '2026-07-28');

  assert.deepEqual(validateIncomingStatelessMeta({}), { ok: false, reason: 'Missing or malformed _meta envelope (stateless request required)' });
  assert.equal(validateIncomingStatelessMeta(null).ok, false);
  assert.equal(validateIncomingStatelessMeta('nope').ok, false);
  const unknown = validateIncomingStatelessMeta({ protocolVersion: '1999-01-01' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /Unknown protocol version/);
});

// ---------------------------------------------------------------------------
// stateless: extension registry
// ---------------------------------------------------------------------------

test('v3 stateless: default extensions (Tasks / Apps / Skills / Elicitation)', () => {
  const exts = defaultMcpV3Extensions();
  assert.equal(exts.length, 4);
  const byId = new Map(exts.map((e) => [e.id, e]));
  assert.ok(byId.get(MCP_V3_EXTENSION_IDS.tasks).methods.includes('tasks/create'));
  assert.ok(byId.get(MCP_V3_EXTENSION_IDS.apps).methods.includes('apps/list'));
  assert.ok(byId.get(MCP_V3_EXTENSION_IDS.skills).methods.includes('skills/list'));
  assert.ok(byId.get(MCP_V3_EXTENSION_IDS.elicitation).methods.includes('elicitation/create'));
  for (const ext of exts) assert.equal(ext.minCoreVersion, '2026-07-28');
});

function discoverFixture(extensions, capabilities) {
  return {
    protocolVersion: '2026-07-28',
    supportedVersions: ['2026-07-28'],
    capabilities,
    serverInfo: { name: 'fixture', version: '1.0.0' },
    extensions,
  };
}

test('v3 stateless: registry negotiates only id + capability together', () => {
  const registry = new McpV3ExtensionRegistry();
  assert.equal(registry.list().length, 4);
  assert.equal(registry.get(MCP_V3_EXTENSION_IDS.tasks).capabilityKey, 'tasks');

  // Tasks: id listed AND capability advertised -> negotiated.
  // Apps: id listed but capability missing -> NOT negotiated.
  // Skills: capability advertised but id missing -> NOT negotiated.
  const negotiated = registry.negotiateFromDiscover(discoverFixture(
    [MCP_V3_EXTENSION_IDS.tasks, MCP_V3_EXTENSION_IDS.apps],
    { tools: {}, tasks: {}, skills: {} },
  ));
  assert.deepEqual(negotiated, [MCP_V3_EXTENSION_IDS.tasks]);
  assert.equal(registry.isNegotiated(MCP_V3_EXTENSION_IDS.tasks), true);
  assert.equal(registry.isNegotiated(MCP_V3_EXTENSION_IDS.apps), false);
  assert.equal(registry.isNegotiated(MCP_V3_EXTENSION_IDS.skills), false);

  // Unknown ids in the discover document are ignored.
  const registry2 = new McpV3ExtensionRegistry();
  assert.deepEqual(
    registry2.negotiateFromDiscover(discoverFixture(['io.example/unknown'], { tools: {} })),
    [],
  );
  assert.equal(registry2.isKnownExtension('io.example/unknown'), false);
  assert.equal(registry2.isKnownExtension(MCP_V3_EXTENSION_IDS.apps), true);
});

test('v3 stateless: registry method gate refuses unnegotiated extensions locally', () => {
  const registry = new McpV3ExtensionRegistry();
  registry.negotiateFromDiscover(discoverFixture(
    [MCP_V3_EXTENSION_IDS.tasks],
    { tools: {}, tasks: {} },
  ));
  assert.deepEqual(registry.checkMethod('tasks/create'), { ok: true });
  // A core method (no extension owns it) always passes.
  assert.deepEqual(registry.checkMethod('tools/call'), { ok: true });
  const refused = registry.checkMethod('apps/list');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /not negotiated/);
  assert.equal(registry.extensionForMethod('skills/get').id, MCP_V3_EXTENSION_IDS.skills);
  assert.equal(registry.extensionForMethod('tools/call'), null);

  // Registering a custom extension works; re-negotiation clears the old set.
  registry.register({
    id: 'io.example/custom',
    minCoreVersion: '2026-07-28',
    capabilityKey: 'tasks',
    methods: ['custom/run'],
    description: 'Custom.',
  });
  assert.equal(registry.get('io.example/custom').description, 'Custom.');
  registry.negotiateFromDiscover(discoverFixture([], { tools: {} }));
  assert.deepEqual(registry.negotiatedIds(), []);
});

// ---------------------------------------------------------------------------
// stateless: deprecated-feature gate
// ---------------------------------------------------------------------------

test('v3 stateless: deprecated gate — warn records, block refuses, allow is silent', () => {
  assert.equal(deprecatedMethodArea({ method: 'sampling/createMessage' }), 'sampling');
  assert.equal(deprecatedMethodArea({ method: 'roots/list' }), 'roots');
  assert.equal(deprecatedMethodArea({ method: 'logging/setLevel' }), 'logging');

  const gate = new DeprecatedFeatureGate();
  assert.equal(gate.policyFor('sampling'), 'warn');
  const warned = gate.check('sampling/createMessage');
  assert.equal(warned.ok, true);
  assert.ok(warned.notice);
  assert.equal(warned.notice.method, 'sampling/createMessage');
  assert.equal(warned.notice.area, 'sampling');
  assert.equal(gate.getNotices().length, 1);

  // A non-deprecated method passes with no notice.
  assert.deepEqual(gate.check('tools/call'), { ok: true });
  assert.equal(gate.getNotices().length, 1);

  // Block: refused, and nothing is recorded.
  const blocking = new DeprecatedFeatureGate({ sampling: 'block' });
  const blocked = blocking.check('sampling/createMessage');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /blocked by policy/);
  assert.equal(blocking.getNotices().length, 0);

  // Allow: passes with no notice.
  const allowing = new DeprecatedFeatureGate({ roots: 'allow' });
  assert.deepEqual(allowing.check('roots/list'), { ok: true });
  assert.equal(allowing.getNotices().length, 0);

  // Policy can change at runtime (Settings UI).
  gate.setPolicy('sampling', 'block');
  assert.equal(gate.policyFor('sampling'), 'block');
  assert.equal(gate.check('sampling/createMessage').ok, false);
  gate.clearNotices();
  assert.equal(gate.getNotices().length, 0);
});

// ---------------------------------------------------------------------------
// stateless: migration advisor
// ---------------------------------------------------------------------------

test('v3 stateless: migration advisor — modern server is ready', () => {
  const report = assessStatelessReadiness(
    'modern',
    '2026-07-28',
    { tools: {}, resources: {}, prompts: {} },
    discoverFixture([MCP_V3_EXTENSION_IDS.tasks], { tools: {}, tasks: {} }),
  );
  assert.equal(report.serverName, 'modern');
  assert.equal(report.negotiatedVersion, '2026-07-28');
  assert.equal(report.statelessReady, true);
  assert.equal(report.items.find((i) => i.area === 'stateless-core').status, 'ready');
  assert.equal(report.items.find((i) => i.area === 'server/discover').status, 'ready');
  assert.equal(report.items.find((i) => i.area === 'extensions').status, 'ready');
  assert.deepEqual(report.nextSteps, []);
});

test('v3 stateless: migration advisor — legacy server with deprecated areas', () => {
  const report = assessStatelessReadiness(
    'legacy',
    '2025-03-26',
    { tools: {}, sampling: {}, roots: {} },
    null,
  );
  assert.equal(report.statelessReady, false);
  // negotiatedVersion is the version the CLIENT would speak: with no
  // overlap the v1 negotiate degrades to the client preferred version
  // (2026-07-28). The readiness verdict itself must still be
  // needs-shim — that is what the advisor fix guarantees.
  assert.equal(report.negotiatedVersion, '2026-07-28');
  assert.equal(report.items.find((i) => i.area === 'stateless-core').status, 'needs-shim');
  assert.match(
    report.items.find((i) => i.area === 'stateless-core').detail,
    /Server speaks 2025-03-26/,
  );
  assert.equal(report.items.find((i) => i.area === 'server/discover').status, 'needs-shim');
  assert.equal(report.items.find((i) => i.area === 'sampling').status, 'must-replace');
  assert.equal(report.items.find((i) => i.area === 'roots').status, 'must-replace');
  assert.equal(report.items.find((i) => i.area === 'extensions').status, 'info');
  assert.ok(report.nextSteps.length >= 3);
  assert.ok(report.nextSteps.some((s) => /shim/.test(s)));
  assert.ok(report.nextSteps.some((s) => /server\/discover/.test(s)));
});

// ---------------------------------------------------------------------------
// i18n: protocols.v119.* keys in all 6 locales
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');

test('v3 i18n: protocols.v119.* keys exist in all 6 locales, non-empty, same count', () => {
  const counts = {};
  for (const locale of ['vi', 'en', 'es', 'fr', 'ja', 'zh']) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('protocols.v119'));
    counts[locale] = keys.length;
    assert.ok(keys.length >= 25, `${locale} has only ${keys.length} v119 keys`);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} is not a string`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} is empty`);
    }
  }
  const unique = new Set(Object.values(counts));
  assert.equal(unique.size, 1, `v119 key counts differ across locales: ${JSON.stringify(counts)}`);
});
