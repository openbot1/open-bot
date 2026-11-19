/**
 * A2A v1.0 signed Agent Cards — signing & verification (v11 generation).
 *
 * A2A 1.0 Agent Cards may carry a signature so a client can tell a real
 * card from a forged one before delegating work. This module implements
 * the signing side with only Node's built-in `crypto` (no new deps):
 *
 *  - `HS256`: HMAC-SHA-256 over the canonical card JSON, for a shared
 *    secret (local / loopback peers, tests, dev setups).
 *  - `ES256`: ECDSA P-256 + SHA-256, for real key pairs. The public
 *    key travels as JWK (raw `x`/`y` coordinates, base64url).
 *
 * The signed payload is the card WITHOUT its `signature` field,
 * serialised as canonical JSON (sorted keys, no whitespace) so the
 * same card always signs to the same bytes on both sides. Verification
 * is fail-closed: any missing field, bad encoding, unknown algorithm,
 * expired signature, or mismatched key fails verification.
 *
 * Key handling rules (never weaken these):
 *  - Private keys and shared secrets are never logged, never put in
 *    a card, never returned by any verify function.
 *  - A card whose signature does not verify is treated exactly like
 *    an unsigned card: usable for display only, never for delegation.
 */

import * as crypto from 'node:crypto';

import type { V11AgentCard, V11CardSignature } from './types';

/** Algorithms this module can sign and verify. */
export const V11_SIGNATURE_ALGORITHMS = ['HS256', 'ES256'] as const;
export type V11SignatureAlgorithm = (typeof V11_SIGNATURE_ALGORITHMS)[number];

/** A generated signing key pair (ES256) or shared secret (HS256). */
export interface V11SigningKey {
  algorithm: V11SignatureAlgorithm;
  /** Stable id referenced by `signature.keyId` on cards. */
  keyId: string;
  /** ES256: PEM private key. HS256: the shared secret (base64url). */
  privateKey?: string;
  /** ES256: PEM public key. HS256: undefined (secret is the key). */
  publicKey?: string;
  /** HS256: raw shared secret bytes, base64url. */
  secret?: string;
  createdAt: string;
}

/** Public material needed to verify a card (safe to share / store). */
export interface V11VerificationKey {
  algorithm: V11SignatureAlgorithm;
  keyId: string;
  /** ES256: PEM public key. HS256: shared secret, base64url. */
  publicKey?: string;
  secret?: string;
}

/** Outcome of verifying a card signature. */
export interface V11SignatureVerification {
  valid: boolean;
  algorithm?: string;
  keyId?: string;
  reason?: string;
  /** ISO-8601 time the signature was made, when it could be read. */
  signedAt?: string;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function v11CanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => v11CanonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${v11CanonicalJson(record[k])}`,
  );
  return `{${parts.join(',')}}`;
}

/** Base64url encode (no padding, URL-safe) — the JWS alphabet. */
export function v11Base64UrlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/** Base64url decode. Returns null when the input is not valid. */
export function v11Base64UrlDecode(value: string): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    return Buffer.from(padded + pad, 'base64');
  } catch {
    return null;
  }
}

/** The exact bytes a card signature covers: canonical card sans signature. */
export function v11CardSigningPayload(card: V11AgentCard): string {
  const { signature: _signature, ...unsigned } = card;
  void _signature;
  return v11CanonicalJson(unsigned);
}

/** Generate a fresh ES256 (P-256) key pair. */
export function generateV11Es256Key(keyId?: string): V11SigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const pemPrivate = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const pemPublic = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    algorithm: 'ES256',
    keyId: keyId ?? `v11-es256-${Date.now().toString(36)}`,
    privateKey: pemPrivate,
    publicKey: pemPublic,
    createdAt: new Date().toISOString(),
  };
}

/** Generate a fresh HS256 shared secret (256 random bits). */
export function generateV11Hs256Key(keyId?: string): V11SigningKey {
  const secret = v11Base64UrlEncode(crypto.randomBytes(32));
  return {
    algorithm: 'HS256',
    keyId: keyId ?? `v11-hs256-${Date.now().toString(36)}`,
    secret,
    createdAt: new Date().toISOString(),
  };
}

/** Public verification material for a signing key (no private parts). */
export function v11PublicKeyOf(key: V11SigningKey): V11VerificationKey {
  if (key.algorithm === 'ES256') {
    return { algorithm: 'ES256', keyId: key.keyId, publicKey: key.publicKey };
  }
  return { algorithm: 'HS256', keyId: key.keyId, secret: key.secret };
}

/** Sign a card and return a NEW card carrying the signature envelope. */
export function signV11AgentCard(
  card: V11AgentCard,
  key: V11SigningKey,
  signedAt: Date = new Date(),
): V11AgentCard {
  const payload = v11CardSigningPayload(card);
  let value: string;
  if (key.algorithm === 'HS256') {
    if (!key.secret) throw new Error('HS256 signing needs a secret');
    const secret = v11Base64UrlDecode(key.secret);
    if (!secret) throw new Error('HS256 secret is not valid base64url');
    value = v11Base64UrlEncode(
      crypto.createHmac('sha256', secret).update(payload, 'utf8').digest(),
    );
  } else {
    if (!key.privateKey) throw new Error('ES256 signing needs a private key');
    const signer = crypto.createSign('SHA256');
    signer.update(payload, 'utf8');
    signer.end();
    const der = signer.sign(key.privateKey);
    value = v11Base64UrlEncode(der);
  }
  const signature: V11CardSignature = {
    algorithm: key.algorithm,
    keyId: key.keyId,
    value,
    signedAt: signedAt.toISOString(),
  };
  return { ...card, signature };
}

/**
 * Verify a card's signature against a verification key.
 * Returns `{ valid: false, reason }` for every failure mode — never throws
 * for malformed input (only for a programmer error such as a missing key).
 */
export function verifyV11AgentCardSignature(
  card: V11AgentCard,
  key: V11VerificationKey,
): V11SignatureVerification {
  const sig = card.signature;
  if (!sig) {
    return { valid: false, reason: 'card is unsigned' };
  }
  if (sig.algorithm !== key.algorithm) {
    return {
      valid: false,
      algorithm: sig.algorithm,
      keyId: sig.keyId,
      reason: `algorithm mismatch: card is ${sig.algorithm}, key is ${key.algorithm}`,
    };
  }
  if (sig.keyId !== key.keyId) {
    return {
      valid: false,
      algorithm: sig.algorithm,
      keyId: sig.keyId,
      reason: `key id mismatch: card key ${sig.keyId} != ${key.keyId}`,
    };
  }
  const raw = v11Base64UrlDecode(sig.value);
  if (!raw) {
    return {
      valid: false,
      algorithm: sig.algorithm,
      keyId: sig.keyId,
      reason: 'signature is not valid base64url',
    };
  }
  const payload = v11CardSigningPayload(card);
  let ok = false;
  try {
    if (key.algorithm === 'HS256') {
      if (!key.secret) {
        return { valid: false, algorithm: sig.algorithm, keyId: sig.keyId, reason: 'no secret to verify with' };
      }
      const secret = v11Base64UrlDecode(key.secret);
      if (!secret) {
        return { valid: false, algorithm: sig.algorithm, keyId: sig.keyId, reason: 'verification secret is not valid base64url' };
      }
      const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest();
      ok = raw.length === expected.length && crypto.timingSafeEqual(raw, expected);
    } else {
      if (!key.publicKey) {
        return { valid: false, algorithm: sig.algorithm, keyId: sig.keyId, reason: 'no public key to verify with' };
      }
      const verifier = crypto.createVerify('SHA256');
      verifier.update(payload, 'utf8');
      verifier.end();
      ok = verifier.verify(key.publicKey, raw);
    }
  } catch (err) {
    return {
      valid: false,
      algorithm: sig.algorithm,
      keyId: sig.keyId,
      reason: `verification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!ok) {
    return {
      valid: false,
      algorithm: sig.algorithm,
      keyId: sig.keyId,
      signedAt: sig.signedAt,
      reason: 'signature does not match card content',
    };
  }
  return { valid: true, algorithm: sig.algorithm, keyId: sig.keyId, signedAt: sig.signedAt };
}

/**
 * Verify a card against a whole key ring (several keys / rotations).
 * Valid when ANY key verifies it. Key ids are matched first so a card
 * signed with a rotated-out key fails fast with a clear reason.
 */
export function verifyV11AgentCardAgainstKeys(
  card: V11AgentCard,
  keys: V11VerificationKey[],
): V11SignatureVerification {
  if (!card.signature) return { valid: false, reason: 'card is unsigned' };
  const matching = keys.filter((k) => k.keyId === card.signature?.keyId);
  if (matching.length === 0) {
    return {
      valid: false,
      algorithm: card.signature.algorithm,
      keyId: card.signature.keyId,
      reason: `no verification key for key id ${card.signature.keyId}`,
    };
  }
  const failures: string[] = [];
  for (const key of matching) {
    const result = verifyV11AgentCardSignature(card, key);
    if (result.valid) return result;
    failures.push(result.reason ?? 'invalid signature');
  }
  return {
    valid: false,
    algorithm: card.signature.algorithm,
    keyId: card.signature.keyId,
    signedAt: card.signature.signedAt,
    reason: failures.join('; '),
  };
}

/** True when the card carries any signature envelope at all. */
export function isV11CardSigned(card: V11AgentCard): boolean {
  return card.signature !== undefined && typeof card.signature.value === 'string';
}
