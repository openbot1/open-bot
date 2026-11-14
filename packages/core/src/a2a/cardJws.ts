/**
 * Agent Card ký bằng JWS compact (RFC 7515 + RFC 8785), v1.07 Đội T3.
 *
 * A2A v1.0 ký Agent Card để client ngoài xác minh danh tính agent
 * xuyên tổ chức. open-bot trước đây chỉ có chữ ký Ed25519 "nội bộ"
 * gắn trong card (`card.signature`, xem `signing.ts` — ký canonical
 * JSON rồi nhúng `value` base64 vào card). Module này thêm dạng
 * CHUẨN JWS compact serialization:
 *
 *   BASE64URL(header) "." BASE64URL(payload) "." BASE64URL(signature)
 *
 *  - header: `{ "alg": "EdDSA", "typ": "agent-card+jwt", "kid": <keyId> }`
 *  - payload: TOÀN BỘ Agent Card (không gồm `signature` — tránh ký
 *    lồng nhau) + claim `iat` (issued-at, giây) và `exp` (hết hạn,
 *    giây; mặc định iat + 24h). Payload được serialize bằng JCS
 *    RFC 8785 (`canonical.ts`) trước khi base64url — cả hai phía
 *    tính cùng một chuỗi byte.
 *  - signature: Ed25519 trên `header.payload` (UTF-8), Node stdlib.
 *
 * Server phục vụ token này tại `/.well-known/agent-card.jws`
 * (Content-Type `application/jwt`); client đọc bằng
 * `fetchAgentCardJws` (xem `client.ts`) rồi verify trước khi tin.
 * Dạng `card.signature` cũ vẫn được giữ nguyên (backward-compat) —
 * hai dạng ký cùng một key, cùng một card.
 *
 * Trust model giống `signing.ts`: verify ở đây chỉ chứng minh card
 * khớp key đã ký (kid = fingerprint SHA-256 của public key SPKI DER).
 * Key thuộc về ai là quyết định trust-on-first-use của caller.
 */

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalizeJson } from './canonical';
import { fingerprintPublicKeyDer, type A2aSigningKeyPair } from './signing';
import type { A2aAgentCard } from './types';
import { validateAgentCard } from './card';

/** JWS header cho Agent Card đã ký. */
export interface AgentCardJwsHeader {
  alg: 'EdDSA';
  typ: 'agent-card+jwt';
  /** Fingerprint SHA-256 hex của public key (khớp `card.signature.keyId`). */
  kid: string;
}

/** Payload JWS của Agent Card: card + claim thời gian. */
export type AgentCardJwsPayload = Record<string, unknown> & {
  iat: number;
  exp: number;
};

/** Kết quả verify một JWS Agent Card. */
export interface AgentCardJwsVerification {
  ok: boolean;
  /** Agent Card đã trích từ payload (undefined khi verify lỗi). */
  card?: A2aAgentCard;
  /** Fingerprint key đã ký (kid trong header). */
  keyId: string | null;
  /** Lý do khi ok=false. */
  reason?: string;
  /** true khi token đã hết hạn (exp đã qua). */
  expired?: boolean;
}

/** Thời hạn mặc định của một JWS Agent Card: 24 giờ. */
export const AGENT_CARD_JWS_TTL_SECONDS = 24 * 60 * 60;

/** Media type phục vụ JWS Agent Card qua HTTP. */
export const AGENT_CARD_JWS_MEDIA_TYPE = 'application/jwt';

/** Well-known path phục vụ JWS Agent Card. */
export const A2A_WELL_KNOWN_CARD_JWS_PATH = '/.well-known/agent-card.jws';

function base64urlEncode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

function base64urlDecode(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

/**
 * Ký một Agent Card thành JWS compact token. Card đầu vào KHÔNG được
 * sửa; field `signature` (nếu có) bị bỏ trước khi ký để tránh ký
 * lồng. `nowSeconds` / `ttlSeconds` cho phép test ép thời gian.
 */
export function signAgentCardJws(
  card: A2aAgentCard,
  keyPair: A2aSigningKeyPair,
  options: { ttlSeconds?: number; nowSeconds?: number } = {},
): string {
  const problems = validateAgentCard(card);
  if (problems.length > 0) {
    throw new Error(`Cannot sign an invalid Agent Card: ${problems.join('; ')}`);
  }
  const ttl = options.ttlSeconds ?? AGENT_CARD_JWS_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error('Agent Card JWS ttlSeconds must be a positive number.');
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const { signature: _ignored, ...unsigned } = card as A2aAgentCard & {
    signature?: unknown;
  };
  const payload: AgentCardJwsPayload = { ...unsigned, iat: now, exp: now + ttl };
  const header: AgentCardJwsHeader = { alg: 'EdDSA', typ: 'agent-card+jwt', kid: keyPair.keyId };
  const encodedHeader = base64urlEncode(canonicalizeJson(header));
  const encodedPayload = base64urlEncode(canonicalizeJson(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const privateKey = createPrivateKey(keyPair.privateKeyPem);
  const signature = sign(null, Buffer.from(signingInput, 'utf8'), privateKey);
  return `${signingInput}.${base64urlEncode(signature)}`;
}

/**
 * Verify một JWS Agent Card bằng public key DER base64 (lấy từ
 * `card.signature.publicKey` hoặc từ key đã trust trước). Trả card
 * đã trích khi ok. Kiểm tra: đủ 3 phần, header alg/typ đúng,
 * kid khớp fingerprint của public key đưa vào, chữ ký khớp payload
 * canonical (JCS), `exp` chưa qua, card trong payload hợp lệ.
 */
export function verifyAgentCardJws(
  token: string,
  publicKeyBase64: string,
  options: { nowSeconds?: number } = {},
): AgentCardJwsVerification {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, keyId: null, reason: 'JWS Agent Card must have 3 parts.' };
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: AgentCardJwsHeader;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64urlDecode(encodedHeader).toString('utf8')) as AgentCardJwsHeader;
    payload = JSON.parse(base64urlDecode(encodedPayload).toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, keyId: null, reason: 'JWS header or payload is not valid JSON.' };
  }
  if (header.alg !== 'EdDSA' || header.typ !== 'agent-card+jwt') {
    return {
      ok: false,
      keyId: typeof header.kid === 'string' ? header.kid : null,
      reason: `Unsupported JWS Agent Card header (alg=${String(header.alg)}, typ=${String(header.typ)}).`,
    };
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    return { ok: false, keyId: null, reason: 'JWS Agent Card header is missing kid.' };
  }
  let publicDer: Buffer;
  try {
    publicDer = Buffer.from(publicKeyBase64, 'base64');
    if (publicDer.length === 0) throw new Error('empty');
  } catch {
    return { ok: false, keyId: header.kid, reason: 'Public key is not valid base64.' };
  }
  if (fingerprintPublicKeyDer(publicDer) !== header.kid) {
    return { ok: false, keyId: header.kid, reason: 'kid does not match the fingerprint of the public key.' };
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
  } catch {
    return { ok: false, keyId: header.kid, reason: 'Public key is not a valid Ed25519 key.' };
  }
  let signature: Buffer;
  try {
    signature = base64urlDecode(encodedSignature);
  } catch {
    return { ok: false, keyId: header.kid, reason: 'JWS signature is not valid base64url.' };
  }
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  let valid = false;
  try {
    valid = verify(null, Buffer.from(signingInput, 'utf8'), publicKey, signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, keyId: header.kid, reason: 'JWS signature does not match the Agent Card payload.' };
  }
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
    return { ok: false, keyId: header.kid, reason: 'JWS Agent Card payload is missing iat/exp.' };
  }
  if (payload.exp <= now) {
    return { ok: false, keyId: header.kid, expired: true, reason: 'JWS Agent Card is expired.' };
  }
  if (payload.iat > now + 300) {
    return { ok: false, keyId: header.kid, reason: 'JWS Agent Card iat is in the future (clock skew?).' };
  }
  const { iat: _iat, exp: _exp, ...card } = payload;
  const problems = validateAgentCard(card);
  if (problems.length > 0) {
    return { ok: false, keyId: header.kid, reason: `Card inside JWS is invalid: ${problems.join('; ')}` };
  }
  return { ok: true, card: card as unknown as A2aAgentCard, keyId: header.kid };
}

/**
 * Verify một JWS Agent Card bằng public key lấy NGAY TRONG token
 * không làm được (JWS không mang key) — helper này verify bằng key
 * của một card đã ký kiểu cũ (`card.signature.publicKey`) để hai
 * dạng ký đối chiếu nhau. Trả lỗi rõ ràng khi card cũ không có key.
 */
export function verifyAgentCardJwsWithCardKey(
  token: string,
  signedCard: Record<string, unknown>,
  options: { nowSeconds?: number } = {},
): AgentCardJwsVerification {
  const sig = signedCard['signature'] as Record<string, unknown> | undefined;
  if (!sig || typeof sig['publicKey'] !== 'string') {
    return { ok: false, keyId: null, reason: 'Signed card has no publicKey to verify the JWS with.' };
  }
  return verifyAgentCardJws(token, sig['publicKey'] as string, options);
}

/** Decode JWS Agent Card KHÔNG verify (chỉ để debug/hiển thị — không tin). */
export function decodeAgentCardJwsUnverified(token: string): {
  header: AgentCardJwsHeader;
  payload: AgentCardJwsPayload;
} {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWS Agent Card must have 3 parts.');
  return {
    header: JSON.parse(base64urlDecode(parts[0]).toString('utf8')) as AgentCardJwsHeader,
    payload: JSON.parse(base64urlDecode(parts[1]).toString('utf8')) as AgentCardJwsPayload,
  };
}
