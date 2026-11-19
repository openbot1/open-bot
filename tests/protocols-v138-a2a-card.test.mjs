/**
 * Protocols v7 — A2A v1.0.1 Agent Card tests (v1.38, Team T2).
 *
 * Covers packages/core/src/protocolsV7/a2aCardV7.ts:
 * card build/validate, JWS sign/verify (Ed25519), tamper +
 * expiry + wrong-key failures, issuer key rotation/revocation,
 * multi-tenant registry (register/get/list/find/revoke/prune),
 * trust store (pin / allowlist / TOFU).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v138-a2a-card.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2aV7CardIssuer,
  A2aV7CardRegistry,
  A2aV7TrustStore,
  buildA2aV7AgentCard,
  decodeA2aV7AgentCardUnverified,
  generateA2aV7CardKeyPair,
  signA2aV7AgentCard,
  verifyA2aV7AgentCard,
} from '../packages/core/dist/index.js';

function demoCard(overrides = {}) {
  return buildA2aV7AgentCard({
    name: 'coder',
    description: 'Writes code fast.',
    version: '1.38.0',
    url: 'https://agent.example.com',
    capabilities: ['coding', 'research'],
    skills: [{ id: 'write-code', name: 'Write code', description: 'Writes code.' }],
    authSchemes: ['bearer'],
    tenant: 'default',
    ...overrides,
  });
}

test('build validates cards: bad url / empty capabilities / duplicate skills fail', () => {
  assert.throws(() => demoCard({ url: 'ftp://x.example.com' }), /url must be https/);
  assert.throws(() => demoCard({ url: 'http://agent.example.com' }), /loopback/);
  assert.throws(() => demoCard({ capabilities: [] }), /capabilities/);
  assert.throws(() => demoCard({
    skills: [
      { id: 'dup', name: 'A', description: 'a' },
      { id: 'dup', name: 'B', description: 'b' },
    ],
  }), /unique/);
  // Loopback http is fine.
  const loopback = demoCard({ url: 'http://localhost:8080' });
  assert.equal(loopback.url, 'http://localhost:8080');
  // Tenant defaults to `default`.
  const noTenant = buildA2aV7AgentCard({
    name: 'x', description: 'd', version: '0.1', url: 'https://a.example.com',
    capabilities: ['c'], skills: [], authSchemes: ['none'],
  });
  assert.equal(noTenant.tenant, 'default');
});

test('JWS sign/verify round-trips; tampered payload fails', () => {
  const { publicKeyPem, privateKeyPem, keyId } = generateA2aV7CardKeyPair();
  const card = demoCard();
  const jws = signA2aV7AgentCard(card, privateKeyPem);
  assert.equal(jws.split('.').length, 3);
  const ok = verifyA2aV7AgentCard(jws, publicKeyPem);
  assert.equal(ok.ok, true);
  assert.equal(ok.card.name, 'coder');
  assert.equal(ok.keyId, keyId);
  assert.equal(ok.tenant, 'default');
  // Tamper with the payload: same header, changed card name.
  const parts = jws.split('.');
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
  payload.name = 'impostor';
  const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const bad = verifyA2aV7AgentCard(`${parts[0]}.${tamperedPayload}.${parts[2]}`, publicKeyPem);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /Signature/);
});

test('verify fails closed: wrong key, expired token, malformed token, bad alg', () => {
  const pairA = generateA2aV7CardKeyPair();
  const pairB = generateA2aV7CardKeyPair();
  const card = demoCard();
  const jws = signA2aV7AgentCard(card, pairA.privateKeyPem);
  const wrongKey = verifyA2aV7AgentCard(jws, pairB.publicKeyPem);
  assert.equal(wrongKey.ok, false);
  assert.match(wrongKey.reason, /does not match/);
  const expired = signA2aV7AgentCard(card, pairA.privateKeyPem, {
    ttlSeconds: 60,
    issuedAtSeconds: Math.floor(Date.now() / 1000) - 3600,
  });
  const expiredCheck = verifyA2aV7AgentCard(expired, pairA.publicKeyPem);
  assert.equal(expiredCheck.ok, false);
  assert.equal(expiredCheck.expired, true);
  assert.equal(verifyA2aV7AgentCard('not-a-jws', pairA.publicKeyPem).ok, false);
  assert.equal(verifyA2aV7AgentCard('', pairA.publicKeyPem).ok, false);
  assert.equal(verifyA2aV7AgentCard(42, pairA.publicKeyPem).ok, false);
  // TTL over the max is refused at signing.
  assert.throws(() => signA2aV7AgentCard(card, pairA.privateKeyPem, { ttlSeconds: 8 * 24 * 60 * 60 }), /TTL/);
  // Non-Ed25519 key is refused at signing.
  assert.throws(() => signA2aV7AgentCard(card, 'not-a-key'), /valid private key/);
});

test('verify enforces tenant allowlist + required protocol versions', () => {
  const { publicKeyPem, privateKeyPem } = generateA2aV7CardKeyPair();
  const card = demoCard({ tenant: 'acme' });
  const jws = signA2aV7AgentCard(card, privateKeyPem);
  assert.equal(verifyA2aV7AgentCard(jws, publicKeyPem, { allowedTenants: ['acme'] }).ok, true);
  assert.equal(verifyA2aV7AgentCard(jws, publicKeyPem, { allowedTenants: ['other'] }).ok, false);
  assert.equal(verifyA2aV7AgentCard(jws, publicKeyPem, { requiredProtocolVersions: ['1.0.1'] }).ok, true);
  assert.equal(verifyA2aV7AgentCard(jws, publicKeyPem, { requiredProtocolVersions: ['9.9'] }).ok, false);
});

test('decode-unverified never trusts: returns the payload for diagnostics only', () => {
  const { privateKeyPem } = generateA2aV7CardKeyPair();
  const jws = signA2aV7AgentCard(demoCard(), privateKeyPem);
  const decoded = decodeA2aV7AgentCardUnverified(jws);
  assert.equal(decoded.header.alg, 'EdDSA');
  assert.equal(decoded.payload.name, 'coder');
  assert.equal(decodeA2aV7AgentCardUnverified('garbage'), null);
});

test('issuer: generate / issue / rotate keeps old cards verifiable / revoke refuses', () => {
  const issuer = new A2aV7CardIssuer();
  const first = issuer.activeKey();
  assert.ok(first);
  const card = demoCard();
  const issued1 = issuer.issue(card);
  assert.equal(issuer.verifyOwn(issued1.jws).ok, true);
  const second = issuer.rotate();
  assert.notEqual(second.keyId, first.keyId);
  assert.equal(issuer.activeKey().keyId, second.keyId);
  // Old key is rotated (not revoked): its card still verifies.
  assert.equal(issuer.verifyOwn(issued1.jws).ok, true);
  assert.equal(issuer.listKeys().find((k) => k.keyId === first.keyId).status, 'rotated');
  // New key issues new cards.
  const issued2 = issuer.issue(card);
  assert.equal(issuer.verifyOwn(issued2.jws).ok, true);
  assert.notEqual(issued1.jws, issued2.jws);
  // Revoke the new key: its cards stop verifying, old cards still verify.
  assert.equal(issuer.revokeKey(second.keyId), true);
  assert.equal(issuer.verifyOwn(issued2.jws).ok, false);
  assert.equal(issuer.verifyOwn(issued1.jws).ok, true);
  assert.equal(issuer.revokeKey(second.keyId), false);
  assert.equal(issuer.revokeKey('no-such-key'), false);
  // Issuing with no active key throws.
  const empty = new A2aV7CardIssuer(false);
  assert.throws(() => empty.issue(card), /no active key/);
});

test('registry: multi-tenant register/get/list/find/revoke/prune', () => {
  const issuer = new A2aV7CardIssuer();
  const registry = new A2aV7CardRegistry();
  const cardA = demoCard({ name: 'coder', tenant: 'acme' });
  const cardB = demoCard({ name: 'researcher', tenant: 'acme', capabilities: ['research'] });
  const cardC = demoCard({ name: 'coder', tenant: 'globex' });
  const pub = issuer.activeKey().publicKeyPem;
  const jwsA = issuer.issue(cardA).jws;
  const jwsB = issuer.issue(cardB).jws;
  const jwsC = issuer.issue(cardC).jws;
  registry.register(cardA, jwsA, pub);
  registry.register(cardB, jwsB, pub);
  registry.register(cardC, jwsC, pub);
  assert.equal(registry.size(), 3);
  assert.deepEqual(registry.tenants(), ['acme', 'globex']);
  // Same agent name in different tenants is independent.
  assert.equal(registry.get('acme', 'coder').card.tenant, 'acme');
  assert.equal(registry.get('globex', 'coder').card.tenant, 'globex');
  assert.equal(registry.get('acme', 'nope'), null);
  assert.equal(registry.list('acme').length, 2);
  assert.equal(registry.findByCapability('coding').length, 2);
  assert.equal(registry.findByCapability('coding', 'acme').length, 1);
  assert.equal(registry.findByCapability('research', 'acme').length, 2);
  // Registering an unverified card throws.
  assert.throws(() => registry.register(cardA, 'bad.jws.token', pub), /unverified/);
  // Revoke one card: it disappears, the others stay.
  assert.equal(registry.revoke('acme', 'coder', 'compromised'), true);
  assert.equal(registry.get('acme', 'coder'), null);
  assert.equal(registry.size(), 2);
  assert.equal(registry.revoke('acme', 'coder'), false);
  // Revoke by key kills every card from that key.
  assert.equal(registry.revokeByKey(issuer.activeKey().keyId), 2);
  assert.equal(registry.size(), 0);
  // Expired cards are refused at registration (correct) — so to
  // test pruning, register a live card and prune it in the future.
  const short = new A2aV7CardIssuer();
  const shortPub = short.activeKey().publicKeyPem;
  const expiring = demoCard({ name: 'temp' });
  const expJws = short.issue(expiring, { ttlSeconds: 60 }).jws;
  registry.register(expiring, expJws, shortPub);
  assert.equal(registry.get('default', 'temp').card.name, 'temp');
  assert.equal(registry.get('default', 'temp', Date.now() + 120_000), null);
  assert.equal(registry.pruneExpired(Date.now() + 120_000), 1);
  assert.equal(registry.get('default', 'temp'), null);
  // And an already-expired token is refused at registration.
  const staleJws = short.issue(expiring, { ttlSeconds: 1, issuedAtSeconds: Math.floor(Date.now() / 1000) - 10 }).jws;
  assert.throws(() => registry.register(expiring, staleJws, shortPub), /expired/);
});

test('trust store: pin mode, allowlist mode, TOFU pinning + key-change refusal', () => {
  const pairA = generateA2aV7CardKeyPair();
  const pairB = generateA2aV7CardKeyPair();
  const card = demoCard();
  const pin = new A2aV7TrustStore('pin');
  assert.equal(pin.decide(card, pairA.keyId).trusted, false);
  pin.pinKey(pairA.keyId);
  assert.equal(pin.decide(card, pairA.keyId).trusted, true);
  assert.equal(pin.decide(card, pairB.keyId).trusted, false);
  assert.equal(pin.unpinKey(pairA.keyId), true);
  assert.equal(pin.decide(card, pairA.keyId).trusted, false);

  const allow = new A2aV7TrustStore('allowlist');
  assert.equal(allow.decide(card, pairA.keyId).trusted, false);
  allow.allowTenant('default');
  assert.equal(allow.decide(card, pairA.keyId).trusted, true);
  assert.equal(allow.decide(demoCard({ tenant: 'other' }), pairA.keyId).trusted, false);
  allow.pinKey(pairB.keyId);
  assert.equal(allow.decide(demoCard({ tenant: 'other' }), pairB.keyId).trusted, true);

  const tofu = new A2aV7TrustStore('tofu');
  assert.equal(tofu.decide(card, pairA.keyId).trusted, true);
  assert.equal(tofu.decide(card, pairA.keyId).trusted, true);
  const changed = tofu.decide(card, pairB.keyId);
  assert.equal(changed.trusted, false);
  assert.match(changed.reason, /TOFU pin mismatch/);
  assert.equal(tofu.forgetTofu('coder'), true);
  assert.equal(tofu.decide(card, pairB.keyId).trusted, true);
  assert.equal(tofu.summary().tofuPins, 1);
});
