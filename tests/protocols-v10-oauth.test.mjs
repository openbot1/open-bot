/**
 * Tests for v1.41 (Team T2) — OAuth v10:
 * packages/core/src/protocolsV10/oauthV10.ts
 *
 * Covers:
 *  - issuer normalisation + structural validation (https
 *    only, loopback http allowed, no userinfo/fragment/query)
 *  - token issuer validation (RFC 9207: exact match after
 *    normalisation; trailing-slash and case games do not
 *    make different issuers equal)
 *  - token validation for a server (issuer + audience +
 *    scopes + expiry; token value stays opaque)
 *  - token binding fingerprint (same token -> same
 *    fingerprint; different issuer/audience -> different;
 *    replay at another server refused)
 *  - explicit client validation (redirect URIs exact,
 *    wildcard-free; grant types required)
 *  - Client ID Metadata Documents (clientId must equal the
 *    document URL; URL must be https)
 *  - DCR gate (refused by default, allowed only in
 *    migration mode, every attempt logged)
 *  - auth-server metadata validation (https endpoints,
 *    PKCE S256 required, DCR endpoint flagged)
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v10-oauth.test.mjs
 *
 * No network, no model, no real tokens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV10DcrGate,
  checkMcpV10TokenBinding,
  mcpV10TokenBindingFingerprint,
  normalizeMcpV10Issuer,
  validateMcpV10AuthServerMetadata,
  validateMcpV10ClientIdMetadataDocument,
  validateMcpV10ExplicitClient,
  validateMcpV10IssuerUrl,
  validateMcpV10TokenForServer,
  validateMcpV10TokenIssuer,
} from '../packages/core/dist/index.js';

const ISSUER = 'https://auth.example.com';
const TOKEN = {
  value: 'opaque-token-value',
  issuer: ISSUER,
  audience: 'https://mcp.example.com',
  tokenId: 'tok-1',
  expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
  scope: 'tools:read tools:call',
};
const SERVER = {
  issuer: ISSUER,
  audience: 'https://mcp.example.com',
  requiredScopes: ['tools:call'],
};

test('issuer normalisation: case-insensitive host, trailing slash ignored, path kept', () => {
  assert.equal(normalizeMcpV10Issuer('https://AUTH.example.com/'), 'https://auth.example.com');
  assert.equal(normalizeMcpV10Issuer('https://auth.example.com/tenant/'), 'https://auth.example.com/tenant');
  assert.equal(normalizeMcpV10Issuer('https://auth.example.com/tenant'), 'https://auth.example.com/tenant');
  assert.notEqual(normalizeMcpV10Issuer('https://auth.example.com/a'), normalizeMcpV10Issuer('https://auth.example.com/b'));
  assert.equal(normalizeMcpV10Issuer('not a url'), undefined);
  assert.equal(normalizeMcpV10Issuer('https://user@auth.example.com'), undefined);
});

test('issuer URL validation: https only, loopback http allowed', () => {
  assert.deepEqual(validateMcpV10IssuerUrl('https://auth.example.com'), []);
  assert.deepEqual(validateMcpV10IssuerUrl('http://127.0.0.1:8080'), []);
  assert.ok(validateMcpV10IssuerUrl('http://auth.example.com').some((p) => p.includes('https')));
  assert.ok(validateMcpV10IssuerUrl('https://auth.example.com/x?y=1').some((p) => p.includes('query')));
  assert.ok(validateMcpV10IssuerUrl('https://auth.example.com/#frag').some((p) => p.includes('fragment')));
  assert.ok(validateMcpV10IssuerUrl('').length > 0);
  assert.ok(validateMcpV10IssuerUrl(42).length > 0);
});

test('token issuer validation (RFC 9207): exact match wins, near-misses fail', () => {
  assert.deepEqual(validateMcpV10TokenIssuer(ISSUER, ISSUER).problems, []);
  assert.equal(validateMcpV10TokenIssuer(ISSUER, ISSUER).ok, true);
  // Trailing slash / host case do not break the match.
  assert.equal(validateMcpV10TokenIssuer('https://auth.example.com/', ISSUER).ok, true);
  assert.equal(validateMcpV10TokenIssuer('https://AUTH.example.com', ISSUER).ok, true);
  // A different host, a different path, or a subdomain are all refused.
  assert.equal(validateMcpV10TokenIssuer('https://evil.example.com', ISSUER).ok, false);
  assert.equal(validateMcpV10TokenIssuer('https://auth.example.com.evil.com', ISSUER).ok, false);
  assert.equal(validateMcpV10TokenIssuer('https://auth.example.com/tenant', ISSUER).ok, false);
  assert.equal(validateMcpV10TokenIssuer('', ISSUER).ok, false);
  assert.equal(validateMcpV10TokenIssuer('http://auth.example.com', ISSUER).ok, false);
});

test('token validation for a server: audience, scopes, expiry', () => {
  const good = validateMcpV10TokenForServer(TOKEN, SERVER);
  assert.equal(good.ok, true);
  assert.equal(typeof good.fingerprint, 'string');
  assert.equal(good.fingerprint.length, 32);
  // Wrong audience = replay at another server.
  assert.equal(validateMcpV10TokenForServer(TOKEN, { ...SERVER, audience: 'https://other.example.com' }).ok, false);
  // Missing scope.
  assert.equal(
    validateMcpV10TokenForServer(TOKEN, { ...SERVER, requiredScopes: ['admin'] }).ok,
    false,
  );
  // Expired.
  assert.equal(
    validateMcpV10TokenForServer({ ...TOKEN, expiresAtSec: Math.floor(Date.now() / 1000) - 10 }, SERVER).ok,
    false,
  );
  // Empty token value.
  assert.equal(validateMcpV10TokenForServer({ ...TOKEN, value: '' }, SERVER).ok, false);
  // Audience as an array works.
  assert.equal(
    validateMcpV10TokenForServer({ ...TOKEN, audience: ['https://a.example.com', 'https://mcp.example.com'] }, SERVER).ok,
    true,
  );
});

test('token binding: fingerprint is stable, replay elsewhere is refused', () => {
  const fp = mcpV10TokenBindingFingerprint(TOKEN);
  assert.equal(mcpV10TokenBindingFingerprint(TOKEN), fp);
  assert.notEqual(mcpV10TokenBindingFingerprint({ ...TOKEN, issuer: 'https://other.example.com' }), fp);
  assert.notEqual(mcpV10TokenBindingFingerprint({ ...TOKEN, audience: 'https://other.example.com' }), fp);
  assert.deepEqual(checkMcpV10TokenBinding(TOKEN, fp), { ok: true, problems: [] });
  const moved = checkMcpV10TokenBinding({ ...TOKEN, audience: 'https://other.example.com' }, fp);
  assert.equal(moved.ok, false);
  assert.match(moved.problems[0], /different server/);
});

test('explicit client validation: exact redirect URIs, no wildcards', () => {
  const good = {
    clientId: 'open-bot',
    method: 'explicit',
    redirectUris: ['https://app.example.com/callback', 'http://127.0.0.1:9000/callback'],
    grantTypes: ['authorization_code'],
    scopes: ['tools:read'],
  };
  assert.deepEqual(validateMcpV10ExplicitClient(good), []);
  assert.ok(validateMcpV10ExplicitClient({ ...good, method: 'dynamic' }).length > 0);
  assert.ok(validateMcpV10ExplicitClient({ ...good, redirectUris: ['https://*.example.com/cb'] }).length > 0);
  assert.ok(validateMcpV10ExplicitClient({ ...good, redirectUris: ['https://app.example.com/cb#frag'] }).length > 0);
  assert.ok(validateMcpV10ExplicitClient({ ...good, redirectUris: [] }).length > 0);
  assert.ok(validateMcpV10ExplicitClient({ ...good, grantTypes: [] }).length > 0);
  assert.ok(validateMcpV10ExplicitClient(null).length > 0);
});

test('Client ID Metadata Document: clientId must equal the document URL', () => {
  const doc = {
    clientId: 'https://client.example.com/metadata.json',
    clientIdDocumentUrl: 'https://client.example.com/metadata.json',
    redirectUris: ['https://client.example.com/callback'],
    grantTypes: ['authorization_code'],
    scopes: ['tools:read'],
  };
  assert.deepEqual(validateMcpV10ClientIdMetadataDocument(doc), []);
  assert.ok(validateMcpV10ClientIdMetadataDocument({ ...doc, clientId: 'other-id' }).length > 0);
  assert.ok(validateMcpV10ClientIdMetadataDocument({ ...doc, clientIdDocumentUrl: 'http://client.example.com/metadata.json' }).length > 0);
  assert.ok(validateMcpV10ClientIdMetadataDocument({ ...doc, tokenEndpointAuthMethod: 'weird' }).length > 0);
  assert.deepEqual(
    validateMcpV10ClientIdMetadataDocument({ ...doc, tokenEndpointAuthMethod: 'private_key_jwt' }),
    [],
  );
});

test('DCR gate: refused by default, logged either way', () => {
  const gate = new McpV10DcrGate();
  assert.equal(gate.allowsDcr, false);
  const refused = gate.attemptDynamicRegistration('client-x');
  assert.equal(refused.allowed, false);
  assert.match(refused.problems[0], /deprecated/);
  assert.equal(gate.useCount, 1);
  assert.equal(gate.listUses()[0].clientId, 'client-x');
  const migration = new McpV10DcrGate(true);
  assert.equal(migration.attemptDynamicRegistration().allowed, true);
  assert.equal(migration.useCount, 1);
});

test('auth-server metadata: https endpoints, PKCE S256 required, DCR endpoint flagged', () => {
  const meta = {
    issuer: ISSUER,
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
    codeChallengeMethodsSupported: ['S256'],
  };
  assert.deepEqual(validateMcpV10AuthServerMetadata(meta), []);
  assert.ok(validateMcpV10AuthServerMetadata({ ...meta, tokenEndpoint: 'http://auth.example.com/token' }).length > 0);
  assert.ok(validateMcpV10AuthServerMetadata({ ...meta, codeChallengeMethodsSupported: ['plain'] }).length > 0);
  const withDcr = validateMcpV10AuthServerMetadata({ ...meta, registrationEndpoint: 'https://auth.example.com/register' });
  assert.equal(withDcr.length, 1);
  assert.match(withDcr[0], /Dynamic Client Registration/);
  assert.ok(validateMcpV10AuthServerMetadata({ ...meta, issuer: 'http://auth.example.com' }).length > 0);
});
