/**
 * Tests v1.07 (Đội T3): JCS RFC 8785, JWS Agent Card (RFC 7515),
 * khóa ký trong Vault.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/a2a-v107-canonical-jws.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AGENT_CARD_JWS_TTL_SECONDS,
  Vault,
  buildAgentCard,
  canonicalizeJson,
  canonicalizeJsonNumber,
  canonicalizeJsonString,
  canonicalJsonEquals,
  decodeAgentCardJwsUnverified,
  generateA2aSigningKey,
  hasVaultSigningKey,
  isCanonicalizableJson,
  loadOrCreateVaultSigningKey,
  loadVaultSigningKey,
  removeVaultSigningKey,
  rotateVaultSigningKey,
  signAgentCardJws,
  signJws,
  verifyAgentCardJws,
  verifyAgentCardJwsWithCardKey,
  verifyJws,
} from '../packages/core/dist/index.js';
import { signAgentCard, verifyAgentCardSignature } from '../packages/core/dist/a2a/signing.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-a2a-v107-jws-'));
}

// ---------------------------------------------------------------------------
// RFC 8785 (JCS)
// ---------------------------------------------------------------------------

test('jcs: key order does not matter; nested objects sort recursively', () => {
  assert.equal(
    canonicalizeJson({ b: 1, a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"b":1}',
  );
  assert.equal(canonicalizeJson({ z: [3, 2, 1], a: null }), '{"a":null,"z":[3,2,1]}');
  // Thứ tự chèn khác nhau → cùng chuỗi.
  assert.equal(canonicalizeJson({ a: 1, b: 2 }), canonicalizeJson({ b: 2, a: 1 }));
  assert.equal(canonicalJsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(canonicalJsonEquals({ a: 1 }, { a: 2 }), false);
});

test('jcs: numbers follow ECMAScript Number::toString; -0 becomes 0', () => {
  assert.equal(canonicalizeJsonNumber(0), '0');
  assert.equal(canonicalizeJsonNumber(-0), '0');
  assert.equal(canonicalizeJson(-0), '0');
  assert.equal(canonicalizeJsonNumber(1e21), '1e+21');
  assert.equal(canonicalizeJsonNumber(0.000001), '0.000001');
  assert.equal(canonicalizeJsonNumber(1.5), '1.5');
  assert.throws(() => canonicalizeJsonNumber(NaN), /non-finite/);
  assert.throws(() => canonicalizeJsonNumber(Infinity), /non-finite/);
  assert.throws(() => canonicalizeJson({ x: NaN }), /non-finite/);
});

test('jcs: strings escape control chars, quotes, lone surrogates', () => {
  assert.equal(canonicalizeJsonString('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(canonicalizeJsonString('a\nb\tc\rd'), '"a\\nb\\tc\\rd"');
  assert.equal(canonicalizeJsonString('a\x01b'), '"a\\u0001b"');
  assert.equal(canonicalizeJsonString('a\x1fb'), '"a\\u001fb"');
  // Lone surrogate → \udXXX (JSON.stringify để nguyên → ký khác nhau).
  assert.equal(canonicalizeJsonString('a\ud800b'), '"a\\ud800b"');
  assert.equal(canonicalizeJsonString('a\udc00b'), '"a\\udc00b"');
  // Surrogate pair hợp lệ giữ nguyên.
  assert.equal(canonicalizeJsonString('\uD83D\uDE00'), '"\uD83D\uDE00"');
  // Ký tự Unicode thường không escape.
  assert.equal(canonicalizeJsonString('xin chào'), '"xin chào"');
});

test('jcs: undefined/function/symbol/bigint/circular throw instead of silently dropping', () => {
  assert.throws(() => canonicalizeJson(undefined), /cannot canonicalize/);
  assert.throws(() => canonicalizeJson(() => 1), /cannot canonicalize/);
  assert.throws(() => canonicalizeJson(10n), /bigint/);
  const circular = { a: 1 };
  circular.self = circular;
  assert.throws(() => canonicalizeJson(circular), /circular/);
  assert.equal(isCanonicalizableJson({ a: 1 }), true);
  assert.equal(isCanonicalizableJson(circular), false);
  // Trong object: key undefined bị bỏ (như JSON.stringify); trong
  // array: undefined → null (như JSON.stringify).
  assert.equal(canonicalizeJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalizeJson([undefined, 1]), '[null,1]');
});

// ---------------------------------------------------------------------------
// JWS compact (RFC 7515) trên payload JCS
// ---------------------------------------------------------------------------

test('jws: sign + verify round-trips even when payload keys are reordered', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const tokenA = signJws({ b: 2, a: 1 }, privateKey);
  const tokenB = signJws({ a: 1, b: 2 }, privateKey);
  // Cùng nội dung → cùng token (JCS deterministic).
  assert.equal(tokenA, tokenB);
  assert.equal(verifyJws(tokenA, publicKey).payload.a, 1);
  // Header typ/kid đi kèm.
  const decoded = verifyJws(signJws({ x: 1 }, privateKey, { kid: 'abc' }), publicKey);
  assert.equal(decoded.header.kid, 'abc');
  assert.equal(decoded.header.alg, 'EdDSA');
  // Payload bị sửa → verify lỗi.
  const tampered = `${tokenA.split('.')[0]}.${Buffer.from(canonicalizeJson({ a: 999, b: 2 })).toString('base64url')}.${tokenA.split('.')[2]}`;
  assert.throws(() => verifyJws(tampered, publicKey), /signature/);
  // Hết hạn → verify lỗi.
  const expired = signJws({ sub: 'x', exp: Math.floor(Date.now() / 1000) - 10 }, privateKey);
  assert.throws(() => verifyJws(expired, publicKey), /expired/);
});

// ---------------------------------------------------------------------------
// JWS Agent Card
// ---------------------------------------------------------------------------

function makeCard() {
  return buildAgentCard({
    name: 'open-bot',
    description: 'A local-first agent.',
    url: 'http://127.0.0.1:8765',
    skills: [{ id: 'chat', name: 'Chat', description: 'Chat with the agent.' }],
  });
}

test('card jws: sign + verify round-trips; card inside matches the signed card', () => {
  const keyPair = generateA2aSigningKey();
  const card = makeCard();
  const token = signAgentCardJws(card, keyPair);
  assert.equal(token.split('.').length, 3);
  const { header, payload } = decodeAgentCardJwsUnverified(token);
  assert.equal(header.alg, 'EdDSA');
  assert.equal(header.typ, 'agent-card+jwt');
  assert.equal(header.kid, keyPair.keyId);
  assert.equal(payload.exp - payload.iat, AGENT_CARD_JWS_TTL_SECONDS);
  const result = verifyAgentCardJws(token, keyPair.publicKeyBase64);
  assert.equal(result.ok, true);
  assert.equal(result.keyId, keyPair.keyId);
  assert.equal(result.card.name, 'open-bot');
  assert.equal(result.card.url, 'http://127.0.0.1:8765');
  assert.equal(result.card.skills[0].id, 'chat');
});

test('card jws: tampered payload, wrong key, expired token are rejected', () => {
  const keyPair = generateA2aSigningKey();
  const other = generateA2aSigningKey();
  const token = signAgentCardJws(makeCard(), keyPair);
  const [h, p, s] = token.split('.');
  const tamperedPayload = Buffer.from(
    canonicalizeJson({ ...JSON.parse(Buffer.from(p, 'base64url').toString('utf8')), name: 'mallory-bot' }),
  ).toString('base64url');
  assert.equal(verifyAgentCardJws(`${h}.${tamperedPayload}.${s}`, keyPair.publicKeyBase64).ok, false);
  // Sai key (kid không khớp fingerprint).
  const wrongKey = verifyAgentCardJws(token, other.publicKeyBase64);
  assert.equal(wrongKey.ok, false);
  assert.match(wrongKey.reason, /kid does not match/);
  // Hết hạn.
  const now = Math.floor(Date.now() / 1000);
  const expired = signAgentCardJws(makeCard(), keyPair, { ttlSeconds: 60, nowSeconds: now - 120 });
  const expiredResult = verifyAgentCardJws(expired, keyPair.publicKeyBase64, { nowSeconds: now });
  assert.equal(expiredResult.ok, false);
  assert.equal(expiredResult.expired, true);
  // Token không đủ 3 phần.
  assert.equal(verifyAgentCardJws('only.two', keyPair.publicKeyBase64).ok, false);
});

test('card jws: cross-checks with the legacy embedded card.signature', () => {
  const keyPair = generateA2aSigningKey();
  const card = makeCard();
  const signedCard = signAgentCard(card, keyPair);
  assert.equal(verifyAgentCardSignature(signedCard).ok, true);
  const token = signAgentCardJws(card, keyPair);
  // Verify JWS bằng public key lấy từ card đã ký kiểu cũ.
  const result = verifyAgentCardJwsWithCardKey(token, signedCard);
  assert.equal(result.ok, true);
  assert.equal(result.keyId, keyPair.keyId);
  // Card không có signature → helper báo lỗi rõ ràng.
  assert.equal(verifyAgentCardJwsWithCardKey(token, card).ok, false);
  // Ký card không hợp lệ → throw.
  assert.throws(() => signAgentCardJws({ name: '', description: 'd', url: 'http://x' }, keyPair), /invalid Agent Card/);
});

// ---------------------------------------------------------------------------
// Vault signing key
// ---------------------------------------------------------------------------

test('vault signing key: create once, load again, rotate changes keyId, remove clears', () => {
  const dir = tmpDir();
  const vault = new Vault({ storePath: path.join(dir, 'vault.json') });
  assert.equal(hasVaultSigningKey(vault), false);
  assert.equal(loadVaultSigningKey(vault), null);
  const first = loadOrCreateVaultSigningKey(vault);
  assert.equal(first.created, true);
  assert.ok(first.keyPair.keyId.length === 64);
  assert.equal(hasVaultSigningKey(vault), true);
  // Mở Vault mới cùng file → đọc lại đúng key cũ.
  const vault2 = new Vault({ storePath: path.join(dir, 'vault.json') });
  const second = loadOrCreateVaultSigningKey(vault2);
  assert.equal(second.created, false);
  assert.equal(second.keyPair.keyId, first.keyPair.keyId);
  assert.equal(loadVaultSigningKey(vault2).keyId, first.keyPair.keyId);
  // Rotate → keyId đổi.
  const rotated = rotateVaultSigningKey(vault2);
  assert.notEqual(rotated.keyId, first.keyPair.keyId);
  assert.equal(loadVaultSigningKey(vault2).keyId, rotated.keyId);
  // Remove → hết key.
  assert.equal(removeVaultSigningKey(vault2), true);
  assert.equal(removeVaultSigningKey(vault2), false);
  assert.equal(hasVaultSigningKey(vault2), false);
  // Key ký từ Vault ký được card thật.
  const fresh = loadOrCreateVaultSigningKey(vault2);
  const token = signAgentCardJws(makeCard(), fresh.keyPair);
  assert.equal(verifyAgentCardJws(token, fresh.keyPair.publicKeyBase64).ok, true);
});

test('vault signing key: corrupted PEM in the vault throws instead of silently overwriting', () => {
  const dir = tmpDir();
  const vault = new Vault({ storePath: path.join(dir, 'vault.json') });
  vault.setSecret('a2a', 'signing-key', 'not-a-pem');
  assert.throws(() => loadOrCreateVaultSigningKey(vault), /hỏng/);
});
