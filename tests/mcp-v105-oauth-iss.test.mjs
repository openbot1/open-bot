/**
 * Test v1.05 T2: OAuth iss validation bắt buộc (node:test, không mạng).
 *
 * Covers:
 *  - packages/core/src/mcp/oauthIssuer.ts: JWT decode, iss/aud/exp,
 *    fail-closed cho opaque token, discovery issuer check
 *  - packages/core/src/mcp/oauth.ts: getValidAccessToken với
 *    expectedIssuer (token sai iss bị từ chối, đúng iss thì qua),
 *    id_token capture trong parseTokenResponse
 *
 * Build core trước:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v105-oauth-iss.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OAuthIssuerError,
  assertIssuerMatches,
  decodeBase64Url,
  decodeJwtPayload,
  isJwt,
  issuersMatch,
  jwtExpiry,
  jwtIssuer,
  normalizeIssuer,
  validateDiscoveryIssuer,
  validateStoredTokenIssuer,
  validateTokenIssuer,
} from '../packages/core/dist/mcp/oauthIssuer.js';
import {
  getValidAccessToken,
  loadOAuthToken,
  saveOAuthToken,
} from '../packages/core/dist/mcp/oauth.js';

/** Craft a fake JWT (header.payload.signature) — signature is never verified here. */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function fakeJwt(payload) {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`;
}

const ISSUER = 'https://auth.example.com';
const OTHER_ISSUER = 'https://evil.example.com';

test('normalizeIssuer: trailing slash + case-insensitive host', () => {
  assert.equal(normalizeIssuer('https://auth.example.com/'), 'https://auth.example.com/');
  assert.equal(normalizeIssuer('HTTPS://AUTH.EXAMPLE.COM'), 'https://auth.example.com/');
  assert.equal(normalizeIssuer('https://auth.example.com/realms/x'), 'https://auth.example.com/realms/x');
  assert.equal(normalizeIssuer('not a url'), null);
  assert.equal(normalizeIssuer('ftp://auth.example.com'), null);
  assert.equal(normalizeIssuer(''), null);
});

test('assertIssuerMatches / issuersMatch', () => {
  assertIssuerMatches('https://auth.example.com/', ISSUER);
  assertIssuerMatches('https://auth.example.com', 'https://auth.example.com/');
  assert.equal(issuersMatch(ISSUER, 'https://auth.example.com/'), true);
  assert.equal(issuersMatch(ISSUER, OTHER_ISSUER), false);
  assert.throws(
    () => assertIssuerMatches(OTHER_ISSUER, ISSUER),
    (err) => err instanceof OAuthIssuerError && /không khớp issuer/.test(err.message),
  );
});

test('decodeJwtPayload / isJwt / jwtIssuer / jwtExpiry', () => {
  const token = fakeJwt({ iss: ISSUER, aud: 'open-bot', exp: 9_999_999_999, sub: 'u1' });
  assert.equal(isJwt(token), true);
  assert.equal(jwtIssuer(token), ISSUER);
  assert.equal(jwtExpiry(token), 9_999_999_999);
  assert.deepEqual(decodeJwtPayload(token).aud, 'open-bot');
  assert.equal(isJwt('opaque-token-123'), false);
  assert.equal(decodeJwtPayload('opaque-token-123'), null);
  assert.equal(decodeJwtPayload('a.b'), null);
  assert.equal(decodeJwtPayload('a.!!!.c'), null);
  assert.equal(decodeBase64Url(''), null);
  assert.equal(decodeBase64Url('@@@'), null);
});

test('validateTokenIssuer: access JWT with matching iss passes', () => {
  const token = fakeJwt({ iss: ISSUER, aud: 'open-bot', exp: 9_999_999_999 });
  const result = validateTokenIssuer(token, ISSUER, { expectedAudience: 'open-bot' });
  assert.equal(result.valid, true);
  assert.equal(result.issuer, 'https://auth.example.com/');
  assert.equal(result.source, 'access_token');
});

test('validateTokenIssuer: wrong iss rejected (fail closed)', () => {
  const token = fakeJwt({ iss: OTHER_ISSUER, exp: 9_999_999_999 });
  assert.throws(
    () => validateTokenIssuer(token, ISSUER),
    (err) => err instanceof OAuthIssuerError && /không khớp issuer/.test(err.message),
  );
});

test('validateTokenIssuer: expired JWT rejected', () => {
  const token = fakeJwt({ iss: ISSUER, exp: 1 });
  assert.throws(() => validateTokenIssuer(token, ISSUER), /hết hạn/);
});

test('validateTokenIssuer: wrong aud rejected', () => {
  const token = fakeJwt({ iss: ISSUER, aud: 'someone-else', exp: 9_999_999_999 });
  assert.throws(
    () => validateTokenIssuer(token, ISSUER, { expectedAudience: 'open-bot' }),
    /aud không khớp/,
  );
});

test('validateTokenIssuer: JWT without iss falls back to id_token', () => {
  const access = fakeJwt({ sub: 'u1', exp: 9_999_999_999 });
  const idToken = fakeJwt({ iss: ISSUER, aud: 'open-bot', exp: 9_999_999_999 });
  const result = validateTokenIssuer(access, ISSUER, { idToken });
  assert.equal(result.valid, true);
  assert.equal(result.source, 'id_token');
  // id_token with the wrong issuer is still rejected.
  const badId = fakeJwt({ iss: OTHER_ISSUER, exp: 9_999_999_999 });
  assert.throws(() => validateTokenIssuer(access, ISSUER, { idToken: badId }), /không khớp issuer/);
  // No iss anywhere -> rejected.
  assert.throws(() => validateTokenIssuer(access, ISSUER), /không có claim iss/);
});

test('validateTokenIssuer: opaque token without id_token is rejected (fail closed)', () => {
  assert.throws(
    () => validateTokenIssuer('opaque-token-123', ISSUER),
    /opaque token.*không có id_token/,
  );
  // With a matching id_token it passes.
  const idToken = fakeJwt({ iss: ISSUER, exp: 9_999_999_999 });
  const result = validateTokenIssuer('opaque-token-123', ISSUER, { idToken });
  assert.equal(result.valid, true);
  assert.equal(result.source, 'id_token');
});

test('validateTokenIssuer: missing expectedIssuer is rejected, not passed through', () => {
  const token = fakeJwt({ iss: ISSUER, exp: 9_999_999_999 });
  assert.throws(() => validateTokenIssuer(token, ''), /thiếu expectedIssuer/);
  assert.throws(() => validateTokenIssuer(token, '   '), /thiếu expectedIssuer/);
});

test('validateStoredTokenIssuer: stored token shape', () => {
  const token = fakeJwt({ iss: ISSUER, exp: 9_999_999_999 });
  const result = validateStoredTokenIssuer({ accessToken: token }, ISSUER);
  assert.equal(result.valid, true);
  assert.throws(
    () => validateStoredTokenIssuer({ accessToken: token }, OTHER_ISSUER),
    /không khớp issuer/,
  );
});

test('validateDiscoveryIssuer: issuer must match discovery URL origin', () => {
  validateDiscoveryIssuer('https://auth.example.com', 'https://auth.example.com/.well-known/oauth-authorization-server');
  validateDiscoveryIssuer('https://auth.example.com/', 'https://auth.example.com/.well-known/openid-configuration');
  assert.throws(
    () => validateDiscoveryIssuer(OTHER_ISSUER, 'https://auth.example.com/.well-known/oauth-authorization-server'),
    /không khớp URL discovery/,
  );
});

function memoryStore() {
  const map = new Map();
  return {
    async get(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    async delete(k) {
      map.delete(k);
    },
  };
}

test('getValidAccessToken: validates iss when expectedIssuer is given', async () => {
  const store = memoryStore();
  const good = fakeJwt({ iss: ISSUER, exp: 9_999_999_999 });
  await saveOAuthToken(store, 'srv-good', {
    accessToken: good,
    tokenType: 'Bearer',
    obtainedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
  });
  const loaded = await getValidAccessToken(store, 'srv-good', {
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'open-bot',
    expectedIssuer: ISSUER,
  });
  assert.equal(loaded.accessToken, good);

  // Stored id_token is kept and used for opaque access tokens.
  await saveOAuthToken(store, 'srv-opaque', {
    accessToken: 'opaque-123',
    tokenType: 'Bearer',
    obtainedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    idToken: fakeJwt({ iss: ISSUER, exp: 9_999_999_999 }),
  });
  const opaqueLoaded = await loadOAuthToken(store, 'srv-opaque');
  assert.equal(opaqueLoaded.idToken !== undefined, true);
  const opaqueValid = await getValidAccessToken(store, 'srv-opaque', {
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'open-bot',
    expectedIssuer: ISSUER,
  });
  assert.equal(opaqueValid.accessToken, 'opaque-123');
});

test('getValidAccessToken: wrong-iss token is refused, never returned', async () => {
  const store = memoryStore();
  const bad = fakeJwt({ iss: OTHER_ISSUER, exp: 9_999_999_999 });
  await saveOAuthToken(store, 'srv-bad', {
    accessToken: bad,
    tokenType: 'Bearer',
    obtainedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
  });
  await assert.rejects(
    () =>
      getValidAccessToken(store, 'srv-bad', {
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'open-bot',
        expectedIssuer: ISSUER,
      }),
    /bị từ chối/,
  );
  // Without expectedIssuer (old callers) the token still loads — compat.
  const compat = await getValidAccessToken(store, 'srv-bad', {
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'open-bot',
  });
  assert.equal(compat.accessToken, bad);
});
