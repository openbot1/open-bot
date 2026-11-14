/**
 * Agent server v2 — auth loopback-only (v1.04, Đội T4).
 *
 * - Server chỉ bind loopback (kiểm tra ở `server.ts`); module này chỉ
 *   lo token: sinh token ngẫu nhiên, parse Bearer, so sánh constant-time.
 * - Token KHÔNG lưu đĩa: restart server là token mới, caller lấy từ
 *   handle trả về lúc `startAgentServerV2`. Không có user/pass, không
 *   có tài khoản — local-first.
 * - `/v2/health` là endpoint duy nhất không cần auth (để probe sống).
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Sinh Bearer token ngẫu nhiên (đủ dài, không đoán được). */
export function generateAgentServerToken(): string {
  return `${randomUUID()}-${randomBytes(24).toString('hex')}`;
}

/** Lấy token từ header `Authorization: Bearer <token>` (undefined khi thiếu/sai dạng). */
export function parseBearerToken(authorization: string | string[] | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/.exec(authorization.trim());
  return match?.[1];
}

/**
 * So sánh token constant-time (chống timing attack). Token rỗng hoặc
 * khác độ dài → false (không throw khi độ dài khác nhau).
 */
export function isAuthorizedToken(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || provided === '' || expected === '') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True khi địa chỉ là loopback (IPv4 127.x hoặc IPv6 ::1). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (address === '::1' || address === '::ffff:127.0.0.1') return true;
  return address.startsWith('127.');
}
