/**
 * Tests for v1.39 (Team T2) — protocols v8 NANDA-style discovery +
 * self-signed identity, local-first sketch:
 * packages/core/src/protocolsV8/nandaV8.ts
 *
 * Covers:
 *  - identity creation (Ed25519 keypair, fingerprint, did:openbot id)
 *  - document verification (ok, tampered name fails, wrong
 *    fingerprint fails, expired fails)
 *  - registry: announce / announceDocument / get / discover by
 *    capability / name / tenant / TTL expiry + sweep / remove
 *  - trust store: pin / unpin / revoke / unrevoke / trust check
 *    (pinned + verifies + not revoked)
 *  - Server Cards: build from an entry + validate
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v8-nanda.test.mjs
 *
 * No network, no model. Keys are generated locally and never leave memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV8NandaIdentity,
  McpV8NandaRegistry,
  McpV8NandaTrustStore,
  buildMcpV8ServerCard,
  mcpV8NandaDocumentIsValid,
  mcpV8NandaFingerprint,
  mcpV8NandaIdentityId,
  validateMcpV8NandaIdentityInput,
  validateMcpV8ServerCard,
  verifyMcpV8NandaDocument,
  NANDA_V8_DEFAULT_TTL_MS,
} from '../packages/core/dist/index.js';

function makeIdentity(name = 'worker-bot') {
  return McpV8NandaIdentity.create(
    name,
    'A local worker bot.',
    ['http://127.0.0.1:4317/mcp'],
    ['summarize', 'search'],
  );
}

test('identity: create gives did:openbot id, fingerprint, verifiable document', () => {
  const identity = makeIdentity();
  assert.match(identity.id(), /^did:openbot:[0-9a-f]{64}$/);
  assert.equal(identity.fingerprint().length, 64);
  assert.equal(identity.id(), mcpV8NandaIdentityId(identity.fingerprint()));
  assert.equal(identity.name(), 'worker-bot');
  assert.match(identity.publicKey(), /BEGIN PUBLIC KEY/);
  const doc = identity.document();
  assert.equal(doc.id, identity.id());
  assert.equal(doc.fingerprint, identity.fingerprint());
  assert.deepEqual(doc.capabilities, ['summarize', 'search']);
  assert.deepEqual(doc.endpoints, ['http://127.0.0.1:4317/mcp']);
  assert.equal(typeof doc.signature, 'string');
  assert.ok(doc.signature.length > 0);
  assert.deepEqual(verifyMcpV8NandaDocument(doc), []);
  assert.equal(mcpV8NandaDocumentIsValid(doc), true);
  // Two identities are distinct.
  const other = makeIdentity('other-bot');
  assert.notEqual(other.fingerprint(), identity.fingerprint());
  assert.notEqual(other.id(), identity.id());
  // Signing bytes is deterministic per key (Ed25519) and verifiable via the document path.
  const sig1 = identity.signBytes(Buffer.from('hello', 'utf-8'));
  const sig2 = identity.signBytes(Buffer.from('hello', 'utf-8'));
  assert.equal(sig1, sig2);
  assert.notEqual(sig1, identity.signBytes(Buffer.from('other', 'utf-8')));
});

test('identity input validation: empty name, bad endpoint, too many capabilities', () => {
  assert.ok(validateMcpV8NandaIdentityInput('', 'd', ['http://127.0.0.1:1/x'], []).some((p) => p.includes('name')));
  assert.ok(validateMcpV8NandaIdentityInput('n', '', ['http://127.0.0.1:1/x'], []).some((p) => p.includes('description')));
  assert.ok(validateMcpV8NandaIdentityInput('n', 'd', [], []).some((p) => p.includes('at least one endpoint')));
  assert.ok(validateMcpV8NandaIdentityInput('n', 'd', ['ftp://x/y'], []).some((p) => p.includes('http(s)')));
  assert.ok(validateMcpV8NandaIdentityInput('n', 'd', ['not-a-url'], []).some((p) => p.includes('valid absolute URL')));
  assert.ok(validateMcpV8NandaIdentityInput('n', 'd', ['http://127.0.0.1:1/x'], Array.from({ length: 33 }, (_, i) => `c${i}`)).some((p) => p.includes('32')));
  assert.throws(() => McpV8NandaIdentity.create('', 'd', ['http://127.0.0.1:1/x'], []), /Invalid identity/);
});

test('document verification: tamper, wrong fingerprint, expiry all fail', () => {
  const identity = makeIdentity();
  const doc = identity.document();
  const tampered = { ...doc, name: 'impostor-bot' };
  assert.ok(verifyMcpV8NandaDocument(tampered).some((p) => p.includes('Signature does not verify')));
  assert.equal(mcpV8NandaDocumentIsValid(tampered), false);
  const wrongFp = { ...doc, fingerprint: '0'.repeat(64) };
  const fpProblems = verifyMcpV8NandaDocument(wrongFp);
  assert.ok(fpProblems.some((p) => p.includes('Fingerprint does not match')));
  // Wrong fingerprint AND matching id: the id no longer matches the key.
  const wrongBoth = { ...doc, fingerprint: '0'.repeat(64), id: `did:openbot:${'0'.repeat(64)}` };
  assert.ok(verifyMcpV8NandaDocument(wrongBoth).some((p) => p.includes('Identity id does not match')));
  const badId = { ...doc, id: 'did:example:1234' };
  assert.ok(verifyMcpV8NandaDocument(badId).some((p) => p.includes('did:openbot:')));
  const expiredIdentity = McpV8NandaIdentity.create('short-lived', 'd', ['http://127.0.0.1:1/x'], [], { expiresInMs: 1000 });
  const expiredDoc = expiredIdentity.document();
  assert.ok(verifyMcpV8NandaDocument(expiredDoc, Date.now() + 2000).some((p) => p.includes('expired')));
  const noSig = { ...doc, signature: '' };
  assert.ok(verifyMcpV8NandaDocument(noSig).some((p) => p.includes('needs a signature')));
  assert.equal(mcpV8NandaFingerprint(Buffer.from('abc')).length, 64);
});

test('registry: announce + discover by capability/name/tenant, TTL expiry, remove', () => {
  let now = 5_000_000;
  const registry = new McpV8NandaRegistry({ nowMs: () => now, defaultTtlMs: 1000 });
  assert.equal(NANDA_V8_DEFAULT_TTL_MS, 60 * 60 * 1000);
  const a = makeIdentity('alpha-bot');
  const b = makeIdentity('beta-bot');
  registry.announceDocument(a.document(), 'team-a');
  registry.announceDocument(b.document(), 'team-b');
  assert.equal(registry.size(), 2);
  assert.equal(registry.get(a.id())?.name, 'alpha-bot');
  assert.deepEqual(registry.discoverByCapability(['summarize']).map((e) => e.name).sort(), ['alpha-bot', 'beta-bot']);
  assert.deepEqual(registry.discoverByCapability(['summarize'], 'team-a').map((e) => e.name), ['alpha-bot']);
  assert.deepEqual(registry.discoverByCapability(['no-such-cap']).map((e) => e.name), []);
  assert.deepEqual(registry.discoverByName('ALPHA').map((e) => e.name), ['alpha-bot']);
  assert.deepEqual(registry.discoverByTenant('team-b').map((e) => e.name), ['beta-bot']);
  assert.deepEqual(registry.all().map((e) => e.name), ['alpha-bot', 'beta-bot']);

  // Re-announce refreshes the TTL.
  now += 900;
  registry.announceDocument(a.document(), 'team-a');
  now += 900;
  assert.notEqual(registry.get(a.id()), undefined);
  assert.equal(registry.get(b.id()), undefined);
  assert.equal(registry.size(), 1);

  // Sweep removes the rest once expired.
  now += 2000;
  assert.deepEqual(registry.sweepExpired(), [a.id()]);
  assert.equal(registry.size(), 0);

  // Announce with a bad document is refused.
  const badDoc = { ...b.document(), name: 'tampered' };
  assert.throws(() => registry.announceDocument(badDoc), /does not verify/);
  assert.throws(
    () => registry.announce({ id: 'http://x', name: 'n', description: 'd', endpoints: ['http://127.0.0.1:1/x'], capabilities: [], fingerprint: 'abc' }),
    /did:openbot:/,
  );

  // Plain announce (no document) works when the id/fingerprint shape is right.
  const entry = registry.announce({
    id: a.id(), name: 'alpha-bot', description: 'd', endpoints: ['http://127.0.0.1:1/x'],
    capabilities: ['summarize'], fingerprint: a.fingerprint(), tenant: 'team-a',
  });
  assert.equal(entry.id, a.id());
  assert.equal(registry.remove(a.id()), true);
  assert.equal(registry.remove(a.id()), false);
});

test('trust store: pin + verify + revoke; trust needs all three', () => {
  const trust = new McpV8NandaTrustStore();
  const identity = makeIdentity();
  const doc = identity.document();
  // Not pinned yet: untrusted.
  assert.equal(trust.isTrusted(doc), false);
  assert.ok(trust.checkDocument(doc).some((p) => p.includes('not pinned')));
  trust.pin(doc.fingerprint, 'approved by Huy');
  assert.equal(trust.isPinned(doc.fingerprint), true);
  assert.deepEqual(trust.pinnedFingerprints(), [doc.fingerprint]);
  assert.equal(trust.isTrusted(doc), true);
  assert.deepEqual(trust.checkDocument(doc), []);

  // Revoked: untrusted even when pinned.
  trust.revoke(doc.fingerprint, 'key leaked');
  assert.equal(trust.isRevoked(doc.fingerprint), true);
  assert.equal(trust.isTrusted(doc), false);
  assert.ok(trust.checkDocument(doc).some((p) => p.includes('revoked')));
  assert.equal(trust.unrevoke(doc.fingerprint), true);
  assert.equal(trust.isTrusted(doc), true);

  // Unpin: untrusted again.
  assert.equal(trust.unpin(doc.fingerprint), true);
  assert.equal(trust.isTrusted(doc), false);
  assert.throws(() => trust.pin('', 'x'), /non-empty string/);
  assert.throws(() => trust.revoke('', 'x'), /non-empty string/);
});

test('server cards: build from an entry, validate shape', () => {
  const registry = new McpV8NandaRegistry();
  const identity = makeIdentity('card-bot');
  const entry = registry.announceDocument(identity.document(), 'default');
  const card = buildMcpV8ServerCard(entry, { extensions: ['io.modelcontextprotocol/tasks'] });
  assert.equal(card.cardVersion, '1.0');
  assert.equal(card.name, 'card-bot');
  assert.equal(card.protocolVersion, '2026-07-28');
  assert.deepEqual(card.extensions, ['io.modelcontextprotocol/tasks']);
  assert.equal(card.identityId, identity.id());
  assert.equal(card.fingerprint, identity.fingerprint());
  assert.deepEqual(validateMcpV8ServerCard(card), []);
  assert.ok(validateMcpV8ServerCard({ ...card, cardVersion: '2.0' }).some((p) => p.includes('"1.0"')));
  assert.ok(validateMcpV8ServerCard({ ...card, name: '' }).some((p) => p.includes('name')));
  assert.ok(validateMcpV8ServerCard({ ...card, endpoints: [] }).some((p) => p.includes('endpoint')));
  const noIdentity = buildMcpV8ServerCard({ ...entry, document: undefined });
  assert.equal(noIdentity.identityId, undefined);
});
