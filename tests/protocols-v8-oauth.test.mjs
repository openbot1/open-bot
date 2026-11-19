/**
 * Tests for v1.39 (Team T2) — protocols v8 OAuth 2.1 / OIDC:
 * packages/core/src/protocolsV8/oauthV8.ts
 *
 * Covers:
 *  - PKCE: verifier generation (length + alphabet), S256 challenge
 *    (checked against node:crypto), verify ok / wrong verifier /
 *    plain method refused
 *  - redirect URIs: https ok, loopback http ok, public http refused,
 *    fragment / userinfo / wildcard refused, exact match only
 *    (no prefix, no trailing-slash games)
 *  - authorization request: response_type code only, PKCE mandatory,
 *    state length, scope allow-list, enterprise-managed never prompts
 *  - authorization URL serialisation
 *  - token exchange: code + redirect + PKCE must all match
 *  - Client Credentials: confidential only, scope allow-list
 *  - token info: shape, expiry, 1h lifetime guidance
 *  - OIDC discovery: https endpoints, issuer host match, S256 + code
 *  - Enterprise Managed Authorization: grant validation + scope check
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v8-oauth.test.mjs
 *
 * No network, no model, no secrets stored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildMcpV8AuthorizationUrl,
  generateMcpV8PkceVerifier,
  mcpV8IsLoopbackHost,
  mcpV8ManagedScopeAllowed,
  mcpV8PkceChallengeS256,
  mcpV8TokenIsExpired,
  matchMcpV8RedirectUri,
  validateMcpV8AuthorizationRequest,
  validateMcpV8ClientCredentials,
  validateMcpV8ManagedAuthorization,
  validateMcpV8OidcDiscovery,
  validateMcpV8PkceVerifier,
  validateMcpV8RedirectUriShape,
  validateMcpV8TokenInfo,
  validateMcpV8TokenRequest,
  verifyMcpV8Pkce,
  MCP_V8_PKCE_VERIFIER_MAX,
  MCP_V8_PKCE_VERIFIER_MIN,
} from '../packages/core/dist/index.js';

const CLIENT = {
  clientId: 'open-bot-desktop',
  redirectUris: ['https://localhost:4317/callback', 'http://127.0.0.1:4317/callback'],
  confidential: false,
  enterpriseManaged: false,
  allowedScopes: ['mcp:tools', 'mcp:resources'],
};

function authRequest(overrides = {}) {
  const verifier = generateMcpV8PkceVerifier(64);
  return {
    request: {
      clientId: 'open-bot-desktop',
      redirectUri: 'https://localhost:4317/callback',
      scope: ['mcp:tools'],
      responseType: 'code',
      codeChallenge: mcpV8PkceChallengeS256(verifier),
      codeChallengeMethod: 'S256',
      state: 'state-value-123456',
      ...overrides,
    },
    verifier,
  };
}

test('PKCE: verifier shape, S256 challenge matches node:crypto, verify round-trips', () => {
  const verifier = generateMcpV8PkceVerifier();
  assert.equal(verifier.length, 64);
  assert.deepEqual(validateMcpV8PkceVerifier(verifier), []);
  const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  assert.equal(mcpV8PkceChallengeS256(verifier), expected);
  assert.equal(verifyMcpV8Pkce(verifier, expected, 'S256').ok, true);
  assert.equal(verifyMcpV8Pkce(verifier, expected, 'plain').ok, false);
  assert.ok(verifyMcpV8Pkce(verifier, expected, 'plain').problems.some((p) => p.includes('"S256"')));
  assert.equal(verifyMcpV8Pkce(`${verifier.slice(0, -1)}x`, expected, 'S256').ok, false);
  assert.equal(verifyMcpV8Pkce(verifier, 'wrong-challenge', 'S256').ok, false);
  assert.throws(() => generateMcpV8PkceVerifier(10), /43–128/);
  assert.throws(() => generateMcpV8PkceVerifier(200), /43–128/);
  assert.equal(generateMcpV8PkceVerifier(MCP_V8_PKCE_VERIFIER_MIN).length, MCP_V8_PKCE_VERIFIER_MIN);
  assert.equal(generateMcpV8PkceVerifier(MCP_V8_PKCE_VERIFIER_MAX).length, MCP_V8_PKCE_VERIFIER_MAX);
  assert.ok(validateMcpV8PkceVerifier('short').length > 0);
  assert.ok(validateMcpV8PkceVerifier('x'.repeat(129)).length > 0);
  assert.ok(validateMcpV8PkceVerifier('has space in it and is long enough to pass length!!').length > 0);
});

test('redirect URIs: https ok, loopback http ok, public http / fragment / userinfo / wildcard refused', () => {
  assert.deepEqual(validateMcpV8RedirectUriShape('https://app.example.com/callback'), []);
  assert.deepEqual(validateMcpV8RedirectUriShape('http://127.0.0.1:4317/callback'), []);
  assert.deepEqual(validateMcpV8RedirectUriShape('http://localhost:4317/callback'), []);
  assert.deepEqual(validateMcpV8RedirectUriShape('http://[::1]:4317/callback'), []);
  assert.ok(validateMcpV8RedirectUriShape('http://app.example.com/callback').some((p) => p.includes('https')));
  assert.ok(validateMcpV8RedirectUriShape('https://app.example.com/callback#frag').some((p) => p.includes('fragment')));
  assert.ok(validateMcpV8RedirectUriShape('https://user:pass@app.example.com/callback').some((p) => p.includes('userinfo')));
  assert.ok(validateMcpV8RedirectUriShape('https://*.example.com/callback').some((p) => p.includes('wildcard')));
  assert.ok(validateMcpV8RedirectUriShape('not-a-url').some((p) => p.includes('valid absolute URL')));
  assert.ok(validateMcpV8RedirectUriShape('').some((p) => p.includes('non-empty')));
  assert.equal(mcpV8IsLoopbackHost('127.0.0.1'), true);
  assert.equal(mcpV8IsLoopbackHost('localhost'), true);
  assert.equal(mcpV8IsLoopbackHost('example.com'), false);
});

test('redirect exact match: string equality only, no prefix or trailing-slash games', () => {
  const registered = ['https://localhost:4317/callback'];
  assert.equal(matchMcpV8RedirectUri('https://localhost:4317/callback', registered), 'https://localhost:4317/callback');
  assert.equal(matchMcpV8RedirectUri('https://localhost:4317/callback/', registered), undefined);
  assert.equal(matchMcpV8RedirectUri('https://localhost:4317/callback?x=1', registered), undefined);
  assert.equal(matchMcpV8RedirectUri('https://localhost:4317/callbackx', registered), undefined);
  assert.equal(matchMcpV8RedirectUri('https://localhost:4317/CALLBACK', registered), undefined);
  assert.equal(matchMcpV8RedirectUri('https://localhost:4317/callback', []), undefined);
});

test('authorization request: valid passes; implicit flow, missing PKCE, bad scope, short state refused', () => {
  const { request } = authRequest();
  assert.deepEqual(validateMcpV8AuthorizationRequest(request, CLIENT), []);

  const implicit = authRequest({ responseType: 'token' }).request;
  assert.ok(validateMcpV8AuthorizationRequest(implicit, CLIENT).some((p) => p.includes('Implicit flow')));

  const noPkce = authRequest({ codeChallenge: '', codeChallengeMethod: '' }).request;
  const noPkceProblems = validateMcpV8AuthorizationRequest(noPkce, CLIENT);
  assert.ok(noPkceProblems.some((p) => p.includes('code_challenge is required')));
  assert.ok(noPkceProblems.some((p) => p.includes('"S256"')));

  const badScope = authRequest({ scope: ['mcp:tools', 'admin:everything'] }).request;
  assert.ok(validateMcpV8AuthorizationRequest(badScope, CLIENT).some((p) => p.includes('admin:everything')));

  const shortState = authRequest({ state: 'abc' }).request;
  assert.ok(validateMcpV8AuthorizationRequest(shortState, CLIENT).some((p) => p.includes('state')));

  const unregistered = authRequest({ redirectUri: 'https://evil.example.com/callback' }).request;
  assert.ok(validateMcpV8AuthorizationRequest(unregistered, CLIENT).some((p) => p.includes('not registered')));

  const unknownClient = authRequest({ clientId: 'someone-else' }).request;
  assert.ok(validateMcpV8AuthorizationRequest(unknownClient, CLIENT).some((p) => p.includes('Unknown client_id')));

  const managed = validateMcpV8AuthorizationRequest(request, { ...CLIENT, enterpriseManaged: true });
  assert.ok(managed.some((p) => p.includes('enterprise-managed') && p.includes('must not be prompted')));
});

test('authorization URL serialises the request (no secrets in the URL beyond the challenge)', () => {
  const { request } = authRequest();
  const url = buildMcpV8AuthorizationUrl('https://auth.example.com/authorize', request);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://auth.example.com/authorize');
  assert.equal(parsed.searchParams.get('client_id'), 'open-bot-desktop');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('code_challenge'), request.codeChallenge);
  assert.equal(parsed.searchParams.get('scope'), 'mcp:tools');
  assert.doesNotMatch(url, /code_verifier/);
});

test('token exchange: code + redirect + PKCE must all match', () => {
  const { request, verifier } = authRequest();
  const expected = {
    code: 'auth-code-123',
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    clientId: 'open-bot-desktop',
  };
  const good = {
    grantType: 'authorization_code',
    code: 'auth-code-123',
    redirectUri: request.redirectUri,
    codeVerifier: verifier,
    clientId: 'open-bot-desktop',
  };
  assert.deepEqual(validateMcpV8TokenRequest(good, expected), []);
  assert.ok(validateMcpV8TokenRequest({ ...good, code: 'wrong-code' }, expected).some((p) => p.includes('code does not match')));
  assert.ok(validateMcpV8TokenRequest({ ...good, redirectUri: 'https://other.example.com/cb' }, expected).some((p) => p.includes('identical')));
  assert.ok(validateMcpV8TokenRequest({ ...good, codeVerifier: 'x'.repeat(64) }, expected).some((p) => p.includes('does not match')));
  const { codeVerifier, ...noVerifier } = good;
  assert.ok(validateMcpV8TokenRequest(noVerifier, expected).some((p) => p.includes('code_verifier is required')));
  assert.ok(validateMcpV8TokenRequest({ ...good, grantType: 'client_credentials' }, expected).some((p) => p.includes('authorization_code')));
});

test('Client Credentials: confidential only, scope allow-list, at least one scope', () => {
  const confidential = { ...CLIENT, confidential: true };
  const good = {
    grantType: 'client_credentials',
    clientId: 'open-bot-desktop',
    scope: ['mcp:tools'],
    clientAuth: 'client_secret',
  };
  assert.deepEqual(validateMcpV8ClientCredentials(good, confidential), []);
  assert.ok(validateMcpV8ClientCredentials(good, CLIENT).some((p) => p.includes('confidential client')));
  assert.ok(validateMcpV8ClientCredentials({ ...good, scope: ['admin'] }, confidential).some((p) => p.includes('not allowed')));
  assert.ok(validateMcpV8ClientCredentials({ ...good, scope: [] }, confidential).some((p) => p.includes('at least one scope')));
  assert.ok(validateMcpV8ClientCredentials({ ...good, clientId: 'nope' }, confidential).some((p) => p.includes('Unknown client_id')));
});

test('token info: shape, expiry, 1h lifetime guidance', () => {
  const now = 1_800_000_000_000;
  const good = {
    tokenType: 'Bearer',
    scope: ['mcp:tools'],
    expiresIn: 3600,
    issuedAtMs: now,
    clientId: 'open-bot-desktop',
    enterpriseManaged: false,
  };
  assert.deepEqual(validateMcpV8TokenInfo(good, now), []);
  assert.equal(mcpV8TokenIsExpired(good, now + 3599 * 1000), false);
  assert.equal(mcpV8TokenIsExpired(good, now + 3600 * 1000), true);
  assert.ok(validateMcpV8TokenInfo(good, now + 3600 * 1000).some((p) => p.includes('expired')));
  assert.ok(validateMcpV8TokenInfo({ ...good, expiresIn: 7200 }, now).some((p) => p.includes('at most 3600s')));
  assert.ok(validateMcpV8TokenInfo({ ...good, tokenType: 'MAC' }, now).some((p) => p.includes('"Bearer"')));
  assert.ok(validateMcpV8TokenInfo({ ...good, scope: [] }, now).some((p) => p.includes('at least one scope')));
});

test('OIDC discovery: https endpoints, issuer host match, S256 + code required', () => {
  const good = {
    issuer: 'https://auth.example.com',
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    codeChallengeMethodsSupported: ['S256'],
    responseTypesSupported: ['code'],
  };
  assert.deepEqual(validateMcpV8OidcDiscovery(good), []);
  assert.ok(validateMcpV8OidcDiscovery({ ...good, issuer: 'http://auth.example.com' }).some((p) => p.includes('https')));
  assert.ok(validateMcpV8OidcDiscovery({ ...good, authorizationEndpoint: 'https://other.example.com/authorize' }).some((p) => p.includes('does not match the issuer')));
  assert.ok(validateMcpV8OidcDiscovery({ ...good, codeChallengeMethodsSupported: ['plain'] }).some((p) => p.includes('S256')));
  assert.ok(validateMcpV8OidcDiscovery({ ...good, responseTypesSupported: ['token'] }).some((p) => p.includes('"code"')));
  const { jwksUri, ...noJwks } = good;
  assert.ok(validateMcpV8OidcDiscovery(noJwks).some((p) => p.includes('jwks_uri')));
});

test('Enterprise Managed Authorization: grant validation + scope containment', () => {
  const now = 1_800_000_000_000;
  const grant = {
    clientId: 'open-bot-desktop',
    managedBy: 'acme-corp',
    grantedScopes: ['mcp:tools', 'mcp:resources'],
    expiresAtMs: now + 3600 * 1000,
  };
  assert.deepEqual(validateMcpV8ManagedAuthorization(grant, now), []);
  assert.ok(validateMcpV8ManagedAuthorization(grant, now + 3601 * 1000).some((p) => p.includes('expired')));
  assert.ok(validateMcpV8ManagedAuthorization({ ...grant, grantedScopes: [] }, now).some((p) => p.includes('at least one granted scope')));
  assert.equal(mcpV8ManagedScopeAllowed(grant, ['mcp:tools']), true);
  assert.equal(mcpV8ManagedScopeAllowed(grant, ['mcp:tools', 'mcp:resources']), true);
  assert.equal(mcpV8ManagedScopeAllowed(grant, ['mcp:tools', 'admin']), false);
});
