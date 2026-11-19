/**
 * Tests for v1.42 (Team T2) — protocols v11 OAuth iss + interop:
 * packages/core/src/protocols/v11/oauthV11.ts
 * packages/core/src/protocols/v11/interopV11.ts
 * packages/core/src/protocols/v11/versionsV11.ts (interop half)
 *
 * Covers:
 *  - issuer URL validation (https only, no fragment/query/userinfo,
 *    no trailing slash) + normalisation
 *  - token iss validation: exact match passes; mismatch, missing
 *    iss, expired token, future iat and wrong audience all reject
 *  - auth-server metadata: issuer mismatch / missing endpoints reject
 *  - protected-resource metadata: expected issuer must be listed
 *  - token binding fingerprint: stable, issuer-scoped, check passes/fails
 *  - interop matrix: 2026-07-28 server -> stateless; every older
 *    server (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05) ->
 *    handshake-fallback with all v11 capabilities off; unknown
 *    version -> unsupported; negotiation picks the newest overlap
 *  - server detection: discover ok + 2026-07-28 -> stateless;
 *    discover -32601 -> legacy-handshake
 *  - legacy client end-to-end against the simulator: initialize
 *    stores a session id, list/call work with it, calls before
 *    initialize fail, a stateless server version refuses the
 *    fallback, deprecation warning fires
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v11-oauth-interop-v142.test.mjs
 *
 * No network, no model, no real credentials (test tokens are fake).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV11LegacyClient,
  McpV11LegacyServerSimulator,
  checkMcpV11TokenBinding,
  detectMcpV11ServerMode,
  mcpV11EarliestRemovalDate,
  mcpV11InteropMatrix,
  mcpV11InteropSummary,
  mcpV11LegacySummary,
  mcpV11NeedsHandshake,
  mcpV11TokenBindingFingerprint,
  mcpV11VersionRank,
  negotiateMcpV11Interop,
  negotiateMcpV11Version,
  normalizeMcpV11IssuerUrl,
  protocolV11ChangesSinceV10,
  protocolV11DowngradeToV10,
  validateMcpV11AuthServerMetadata,
  validateMcpV11IssuerUrl,
  validateMcpV11ProtectedResourceMetadata,
  validateMcpV11TokenIssuer,
} from '../packages/core/dist/index.js';

const ISSUER = 'https://auth.example.com';
const NOW = Math.floor(Date.now() / 1000);

test('issuer URL: https required, no fragment/query/userinfo/trailing slash', () => {
  assert.deepEqual(validateMcpV11IssuerUrl(ISSUER), []);
  assert.equal(normalizeMcpV11IssuerUrl('https://auth.example.com/'), ISSUER);
  assert.equal(normalizeMcpV11IssuerUrl('https://auth.example.com/realms/main'), 'https://auth.example.com/realms/main');
  assert.ok(validateMcpV11IssuerUrl('http://auth.example.com').some((p) => p.includes('https')));
  assert.ok(validateMcpV11IssuerUrl('https://auth.example.com/#frag').some((p) => p.includes('fragment')));
  assert.ok(validateMcpV11IssuerUrl('https://auth.example.com/?x=1').some((p) => p.includes('query')));
  assert.ok(validateMcpV11IssuerUrl('https://user:pass@auth.example.com').some((p) => p.includes('userinfo')));
  assert.ok(validateMcpV11IssuerUrl('https://auth.example.com/').some((p) => p.includes('trailing slash')));
  assert.ok(validateMcpV11IssuerUrl('not-a-url').length > 0);
  assert.ok(validateMcpV11IssuerUrl('').length > 0);
  assert.equal(normalizeMcpV11IssuerUrl('http://auth.example.com'), null);
});

test('token iss: exact match passes; mismatch / missing / expired / bad audience reject', () => {
  const good = validateMcpV11TokenIssuer(
    { value: 'tok-1', issuer: ISSUER, audience: 'open-bot', expiresAtSec: NOW + 3600, issuedAtSec: NOW - 10 },
    ISSUER,
    { expectedAudience: 'open-bot', nowSec: NOW },
  );
  assert.equal(good.valid, true);
  assert.deepEqual(good.problems, []);
  // Trailing-slash form of the same issuer normalises to a match.
  const slash = validateMcpV11TokenIssuer({ value: 'tok-1', issuer: ISSUER + '/', audience: 'open-bot' }, ISSUER, { nowSec: NOW });
  assert.equal(slash.valid, true);
  // Wrong issuer: hard reject.
  const wrong = validateMcpV11TokenIssuer({ value: 'tok-1', issuer: 'https://evil.example.com' }, ISSUER, { nowSec: NOW });
  assert.equal(wrong.valid, false);
  assert.ok(wrong.problems.some((p) => p.includes('does not match')));
  assert.ok(wrong.problems.some((p) => p.includes('RFC 9207')));
  // Missing iss.
  const missing = validateMcpV11TokenIssuer({ value: 'tok-1', issuer: '' }, ISSUER, { nowSec: NOW });
  assert.equal(missing.valid, false);
  assert.ok(missing.problems.some((p) => p.includes('iss is required')));
  // Expired token.
  const expired = validateMcpV11TokenIssuer(
    { value: 'tok-1', issuer: ISSUER, expiresAtSec: NOW - 3600 },
    ISSUER,
    { nowSec: NOW },
  );
  assert.equal(expired.valid, false);
  assert.ok(expired.problems.some((p) => p.includes('expired')));
  // iat in the future beyond skew.
  const future = validateMcpV11TokenIssuer(
    { value: 'tok-1', issuer: ISSUER, issuedAtSec: NOW + 3600 },
    ISSUER,
    { nowSec: NOW },
  );
  assert.equal(future.valid, false);
  assert.ok(future.problems.some((p) => p.includes('future')));
  // Wrong audience.
  const badAud = validateMcpV11TokenIssuer(
    { value: 'tok-1', issuer: ISSUER, audience: 'someone-else' },
    ISSUER,
    { expectedAudience: 'open-bot', nowSec: NOW },
  );
  assert.equal(badAud.valid, false);
  assert.ok(badAud.problems.some((p) => p.includes('audience')));
  // Bad expected issuer itself is reported, not silently accepted.
  const badExpected = validateMcpV11TokenIssuer({ value: 't', issuer: ISSUER }, 'http://bad.example.com', { nowSec: NOW });
  assert.equal(badExpected.valid, false);
  assert.ok(badExpected.problems.some((p) => p.includes('expected issuer is invalid')));
});

test('auth-server metadata: issuer must match, endpoints required, code flow required', () => {
  const good = {
    issuer: ISSUER,
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    response_types_supported: ['code'],
  };
  assert.deepEqual(validateMcpV11AuthServerMetadata(good, ISSUER), []);
  assert.ok(validateMcpV11AuthServerMetadata({ ...good, issuer: 'https://other.example.com' }, ISSUER).some((p) => p.includes('does not match')));
  assert.ok(validateMcpV11AuthServerMetadata({ issuer: ISSUER }, ISSUER).some((p) => p.includes('authorization_endpoint')));
  assert.ok(validateMcpV11AuthServerMetadata({ ...good, token_endpoint: 'http://auth.example.com/token' }, ISSUER).some((p) => p.includes('https')));
  assert.ok(validateMcpV11AuthServerMetadata({ ...good, response_types_supported: ['token'] }, ISSUER).some((p) => p.includes('"code"')));
  assert.ok(validateMcpV11AuthServerMetadata(null, ISSUER).length > 0);
});

test('protected-resource metadata: expected issuer must be listed', () => {
  assert.deepEqual(
    validateMcpV11ProtectedResourceMetadata({ resource: 'https://mcp.example.com', authorization_servers: [ISSUER] }, ISSUER),
    [],
  );
  const missing = validateMcpV11ProtectedResourceMetadata(
    { resource: 'https://mcp.example.com', authorization_servers: ['https://other.example.com'] },
    ISSUER,
  );
  assert.ok(missing.some((p) => p.includes('not listed')));
  assert.ok(validateMcpV11ProtectedResourceMetadata({ resource: 'https://mcp.example.com' }, ISSUER).some((p) => p.includes('authorization_servers')));
});

test('token binding: fingerprint is stable, issuer-scoped, and checks correctly', () => {
  const fp = mcpV11TokenBindingFingerprint(ISSUER, 'tok-abc');
  assert.equal(fp.length, 16);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(mcpV11TokenBindingFingerprint(ISSUER, 'tok-abc'), fp);
  assert.notEqual(mcpV11TokenBindingFingerprint('https://other.example.com', 'tok-abc'), fp);
  assert.notEqual(mcpV11TokenBindingFingerprint(ISSUER, 'tok-other'), fp);
  assert.equal(checkMcpV11TokenBinding(fp, ISSUER, 'tok-abc'), true);
  assert.equal(checkMcpV11TokenBinding(fp, ISSUER, 'tok-other'), false);
  assert.equal(checkMcpV11TokenBinding(fp, 'https://other.example.com', 'tok-abc'), false);
});

test('interop matrix: new server stateless, every old server handshake-fallback, unknown unsupported', () => {
  const matrix = mcpV11InteropMatrix();
  assert.equal(matrix.length, 5);
  const byVersion = Object.fromEntries(matrix.map((r) => [r.serverVersion, r]));
  assert.equal(byVersion['2026-07-28'].mode, 'stateless');
  assert.equal(byVersion['2026-07-28'].handshakeRequired, false);
  assert.deepEqual(byVersion['2026-07-28'].capabilities, {
    multiRoundTrip: true,
    tasks: true,
    apps: true,
    cacheableLists: true,
    routing: true,
  });
  for (const old of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
    assert.equal(byVersion[old].mode, 'handshake-fallback', old);
    assert.equal(byVersion[old].handshakeRequired, true, old);
    assert.deepEqual(byVersion[old].capabilities, {
      multiRoundTrip: false,
      tasks: false,
      apps: false,
      cacheableLists: false,
      routing: false,
    });
    assert.ok(byVersion[old].warnings.length > 0, old);
  }
  assert.equal(mcpV11NeedsHandshake('2025-11-25'), true);
  assert.equal(mcpV11NeedsHandshake('2026-07-28'), false);
  assert.equal(mcpV11NeedsHandshake('1999-01-01'), false);
  const unknown = negotiateMcpV11Interop('2026-07-28', '2030-01-01');
  assert.equal(unknown.mode, 'unsupported');
  assert.ok(unknown.warnings.some((w) => w.includes('Unknown server version')));
  const badClient = negotiateMcpV11Interop('1999-01-01', '2026-07-28');
  assert.equal(badClient.mode, 'unsupported');
  const fallback = negotiateMcpV11Interop('2026-07-28', '2025-06-18');
  assert.equal(fallback.mode, 'handshake-fallback');
  assert.equal(fallback.downgradeWarning, true);
  assert.match(mcpV11InteropSummary(), /2026-07-28 -> stateless/);
  assert.match(mcpV11InteropSummary(), /2025-11-25 -> handshake-fallback/);
  assert.match(mcpV11LegacySummary(), /no multi round-trip/i);
});

test('negotiation: newest overlap wins; no overlap -> undefined; ranks order versions', () => {
  assert.equal(negotiateMcpV11Version(['2025-06-18', '2026-07-28']), '2026-07-28');
  assert.equal(negotiateMcpV11Version(['2025-11-25']), '2025-11-25');
  assert.equal(negotiateMcpV11Version(['2030-01-01']), undefined);
  assert.equal(negotiateMcpV11Version([]), undefined);
  assert.ok(mcpV11VersionRank('2026-07-28') < mcpV11VersionRank('2025-11-25'));
  assert.ok(mcpV11VersionRank('2024-11-05') < mcpV11VersionRank('unknown-version'));
  assert.equal(mcpV11EarliestRemovalDate('2026-07-28'), '2027-07-28');
  assert.equal(mcpV11EarliestRemovalDate('2026-07-28', true), '2026-10-26');
  assert.ok(protocolV11ChangesSinceV10().length >= 8);
  assert.ok(protocolV11DowngradeToV10().lost.length >= 3);
});

test('server detection: discover ok -> stateless; discover -32601 -> legacy; other failures -> unknown', () => {
  assert.equal(detectMcpV11ServerMode({ discoverOk: true, protocolVersion: '2026-07-28' }), 'stateless-2026-07-28');
  assert.equal(detectMcpV11ServerMode({ discoverOk: false, discoverErrorCode: -32601 }), 'legacy-handshake');
  assert.equal(detectMcpV11ServerMode({ discoverOk: false, discoverErrorCode: -32000 }), 'unknown');
  assert.equal(detectMcpV11ServerMode({ discoverOk: true, protocolVersion: '2025-11-25' }), 'legacy-handshake');
  assert.equal(detectMcpV11ServerMode({ discoverOk: true, protocolVersion: '2030-01-01' }), 'unknown');
});

test('legacy client end-to-end: initialize, list, call; no session before initialize', async () => {
  const simulator = new McpV11LegacyServerSimulator('2025-11-25');
  const warnings = [];
  const client = new McpV11LegacyClient(simulator.sender(), {
    onDeprecatedUse: (m) => warnings.push(m),
  });
  assert.equal(client.session, null);
  await assert.rejects(() => client.listTools(), /initialize/);
  const handshake = await client.initialize('2025-11-25');
  assert.equal(handshake.serverInfo.name, 'legacy-mcp-server');
  assert.equal(handshake.protocolVersion, '2025-11-25');
  assert.equal(client.session, 'legacy-session-2025-11-25');
  assert.ok(warnings.length > 0);
  assert.match(warnings[0], /Handshake fallback/);
  // All v11 capabilities are off on the legacy path.
  assert.deepEqual(client.effectiveCapabilities, {
    multiRoundTrip: false,
    tasks: false,
    apps: false,
    cacheableLists: false,
    routing: false,
  });
  assert.deepEqual((await client.listTools()).sort(), ['add', 'echo']);
  const added = await client.callTool('add', { a: 4, b: 5 });
  assert.equal(added.sum, 9);
  const echoed = await client.callTool('echo', { hello: 'old-server' });
  assert.deepEqual(echoed.echoed, { hello: 'old-server' });
  await assert.rejects(() => client.callTool('nope', {}), /Unknown tool/);
});

test('legacy client: stateless server version refuses the fallback; old simulator refuses calls without session', async () => {
  const simulator = new McpV11LegacyServerSimulator('2025-06-18');
  const client = new McpV11LegacyClient(simulator.sender());
  await assert.rejects(() => client.initialize('2026-07-28'), /stateless MCP 2.0/);
  // Direct dispatch without initialize: refused.
  const raw = await simulator.dispatch({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }, {});
  assert.ok(raw.error);
  assert.match(raw.error.message, /initialize/);
  // Discover is unknown to the old server.
  const disc = await simulator.dispatch({ jsonrpc: '2.0', method: 'server/discover', params: {}, id: 1 }, {});
  assert.equal(disc.error.code, -32601);
  // A 2025-06-18 simulator works the same way as 2025-11-25.
  await client.initialize('2025-06-18');
  assert.equal(client.session, 'legacy-session-2025-06-18');
  assert.deepEqual((await client.listTools()).sort(), ['add', 'echo']);
});
