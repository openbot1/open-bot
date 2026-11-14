/**
 * MCP OAuth — bắt buộc validate `iss` (issuer) (v1.05, sóng T2).
 *
 * MCP spec 2026-07-28 yêu cầu client validate issuer của token:
 * access token (JWT) hoặc `id_token` phải mang claim `iss` khớp
 * đúng issuer của authorization server đã discovery (RFC 8414 /
 * OIDC Discovery) — nếu không, token có thể là token của một
 * issuer khác bị lừa đưa vào (token substitution / confused
 * deputy). Trước v1.05, `oauth.ts` lưu và dùng token mà không
 * kiểm tra `iss` bao giờ.
 *
 * Module này:
 *   - `decodeJwtPayload`: giải mã phần payload của JWT (base64url,
 *     KHÔNG verify signature — verify signature là việc của IdP /
 *     resource server; ở đây chỉ kiểm tra claim `iss`/`exp`/`aud`
 *     để client từ chối token sai issuer trước khi gửi đi).
 *   - `validateTokenIssuer`: kiểm tra `iss` của access token
 *     (khi là JWT) hoặc `id_token` khớp đúng `expectedIssuer`
 *     (so sánh chuẩn hoá: bỏ trailing slash, lowercase scheme+
 *     host). Token opaque (không phải JWT) → không kiểm tra được
 *     `iss` từ token: khi đó bắt buộc phải có `id_token` kèm theo
 *     hoặc `expectedIssuer` phải khớp issuer đã discovery ở bước
 *     token exchange — nếu không có gì để kiểm tra, hàm ném lỗi
 *     thay vì cho qua (fail closed).
 *   - `assertIssuerMatches`: so sánh issuer chuẩn hoá, ném
 *     `OAuthIssuerError` khi khác.
 *   - `validateStoredTokenIssuer`: kiểm tra một token đã lưu
 *     (`McpOAuthToken` + `idToken` khi có) trước khi dùng — dùng
 *     trong `getValidAccessToken` (xem oauth.ts: `ValidTokenOptions`
 *     có `expectedIssuer`).
 *
 * Không log token, không gửi token đi đâu. Không copy code từ
 * SDK OAuth nào.
 */

export class OAuthIssuerError extends Error {
  readonly expectedIssuer?: string;
  readonly actualIssuer?: string;
  constructor(message: string, expectedIssuer?: string, actualIssuer?: string) {
    super(message);
    this.name = 'OAuthIssuerError';
    if (expectedIssuer) this.expectedIssuer = expectedIssuer;
    if (actualIssuer) this.actualIssuer = actualIssuer;
  }
}

/** Kết quả validate issuer. */
export interface IssuerValidationResult {
  /** True khi token qua kiểm tra. */
  valid: true;
  /** Issuer đã kiểm tra (chuẩn hoá). */
  issuer: string;
  /** Nguồn claim iss: access token JWT hay id_token. */
  source: 'access_token' | 'id_token';
}

/**
 * Chuẩn hoá issuer để so sánh: trim, bỏ trailing slash, lowercase
 * scheme + host (path giữ nguyên case — OIDC issuer so sánh
 * case-sensitive ở path, nhưng scheme/host thì không).
 * Trả null khi không phải URL hợp lệ.
 */
export function normalizeIssuer(issuer: string): string | null {
  if (typeof issuer !== 'string') return null;
  const trimmed = issuer.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.host.toLowerCase();
  return `${parsed.protocol}//${host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * So sánh hai issuer sau chuẩn hoá. Ném `OAuthIssuerError` khi
 * khác nhau (kèm cả hai phía để log/debug — issuer không phải
 * secret).
 */
export function assertIssuerMatches(actual: string, expected: string): void {
  const actualNorm = normalizeIssuer(actual);
  const expectedNorm = normalizeIssuer(expected);
  if (actualNorm === null) {
    throw new OAuthIssuerError(
      `OAuth iss không phải URL hợp lệ: ${JSON.stringify(actual)}`,
      expected,
      actual,
    );
  }
  if (expectedNorm === null) {
    throw new OAuthIssuerError(
      `OAuth expected issuer không phải URL hợp lệ: ${JSON.stringify(expected)}`,
      expected,
      actual,
    );
  }
  if (actualNorm !== expectedNorm) {
    throw new OAuthIssuerError(
      `OAuth token iss không khớp issuer: token iss "${actual}" (chuẩn hoá: "${actualNorm}") ` +
        `khác expected issuer "${expected}" (chuẩn hoá: "${expectedNorm}") — từ chối token.`,
      expected,
      actual,
    );
  }
}

/** True khi hai issuer khớp sau chuẩn hoá (không ném). */
export function issuersMatch(actual: string, expected: string): boolean {
  try {
    assertIssuerMatches(actual, expected);
    return true;
  } catch {
    return false;
  }
}

/**
 * Giải mã base64url (JWT dùng base64url không padding). Trả null
 * khi chuỗi không decode được.
 */
export function decodeBase64Url(input: string): Buffer | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  try {
    return Buffer.from(padded + '='.repeat(padLength), 'base64');
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Giải mã payload của một JWT (3 phần `header.payload.signature`).
 * Trả null khi không phải JWT / payload không phải JSON object.
 * KHÔNG verify signature — chỉ đọc claim.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payloadBuf = decodeBase64Url(parts[1] as string);
  if (!payloadBuf) return null;
  try {
    const parsed: unknown = JSON.parse(payloadBuf.toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** True khi chuỗi có dạng JWT (3 phần base64url). */
export function isJwt(token: string): boolean {
  return decodeJwtPayload(token) !== null;
}

/**
 * Lấy claim `iss` từ JWT. Trả null khi token không phải JWT hoặc
 * không có claim `iss` là chuỗi.
 */
export function jwtIssuer(token: string): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return typeof payload['iss'] === 'string' ? (payload['iss'] as string) : null;
}

/**
 * Lấy claim `exp` (epoch giây) từ JWT. Trả null khi không có /
 * không phải số.
 */
export function jwtExpiry(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return typeof payload['exp'] === 'number' ? (payload['exp'] as number) : null;
}

/**
 * Kiểm tra token có hết hạn theo claim `exp` không (khi là JWT
 * và có exp). Trả null khi không kiểm tra được (không phải JWT /
 * không có exp) — caller dùng `isTokenExpired` của oauth.ts cho
 * trường hợp đó.
 */
export function isJwtExpired(token: string, nowMs: number = Date.now()): boolean | null {
  const exp = jwtExpiry(token);
  if (exp === null) return null;
  return exp * 1000 <= nowMs;
}

/**
 * Validate issuer của token — hàm chính, bắt buộc dùng trước khi
 * gửi access token đi (fail closed):
 *
 *   1. `expectedIssuer` rỗng → ném (không có gì để đối chiếu thì
 *      không được cho qua).
 *   2. Access token là JWT có `iss` → so sánh với expected.
 *   3. Access token là JWT nhưng không có `iss` → thử `idToken`
 *      (khi caller đưa); không có id_token → ném.
 *   4. Access token opaque (không phải JWT) → bắt buộc `idToken`
 *      có `iss` khớp; không có id_token → ném (không thể kiểm
 *      tra issuer của opaque token từ token).
 *   5. (Tuỳ chọn) `expectedAudience`: kiểm tra claim `aud` chứa
 *      audience mong đợi (chuỗi hoặc mảng chứa chuỗi).
 */
export function validateTokenIssuer(
  accessToken: string,
  expectedIssuer: string,
  options: {
    /** id_token kèm theo (OIDC) — dùng khi access token không mang iss. */
    idToken?: string;
    /** Audience mong đợi (client_id) — kiểm tra claim aud khi có. */
    expectedAudience?: string;
    /** Clock cho kiểm tra exp (mặc định Date.now). */
    nowMs?: number;
  } = {},
): IssuerValidationResult {
  if (typeof expectedIssuer !== 'string' || expectedIssuer.trim().length === 0) {
    throw new OAuthIssuerError(
      'OAuth iss validation: thiếu expectedIssuer — không thể kiểm tra issuer của token (fail closed).',
    );
  }
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new OAuthIssuerError('OAuth iss validation: access token rỗng.', expectedIssuer);
  }
  const nowMs = options.nowMs ?? Date.now();

  const checkExpiry = (token: string, what: string): void => {
    const expired = isJwtExpired(token, nowMs);
    if (expired === true) {
      throw new OAuthIssuerError(
        `OAuth ${what} đã hết hạn theo claim exp — từ chối token.`,
        expectedIssuer,
      );
    }
  };
  const checkAudience = (payload: Record<string, unknown>, what: string): void => {
    if (!options.expectedAudience) return;
    const aud = payload['aud'];
    const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
    if (!audiences.includes(options.expectedAudience)) {
      throw new OAuthIssuerError(
        `OAuth ${what} aud không khớp: mong đợi "${options.expectedAudience}", nhận được ${JSON.stringify(aud)} — từ chối token.`,
        expectedIssuer,
      );
    }
  };

  const accessPayload = decodeJwtPayload(accessToken);
  if (accessPayload) {
    checkExpiry(accessToken, 'access token');
    const iss = accessPayload['iss'];
    if (typeof iss === 'string') {
      assertIssuerMatches(iss, expectedIssuer);
      checkAudience(accessPayload, 'access token');
      return { valid: true, issuer: normalizeIssuer(iss) as string, source: 'access_token' };
    }
    // JWT nhưng không có iss → thử id_token.
  }

  if (options.idToken) {
    const idPayload = decodeJwtPayload(options.idToken);
    if (!idPayload) {
      throw new OAuthIssuerError(
        'OAuth iss validation: id_token không phải JWT hợp lệ — từ chối token.',
        expectedIssuer,
      );
    }
    checkExpiry(options.idToken, 'id_token');
    const iss = idPayload['iss'];
    if (typeof iss !== 'string') {
      throw new OAuthIssuerError(
        'OAuth iss validation: id_token không có claim iss — từ chối token.',
        expectedIssuer,
      );
    }
    assertIssuerMatches(iss, expectedIssuer);
    checkAudience(idPayload, 'id_token');
    return { valid: true, issuer: normalizeIssuer(iss) as string, source: 'id_token' };
  }

  if (accessPayload) {
    throw new OAuthIssuerError(
      'OAuth iss validation: access token (JWT) không có claim iss và không có id_token kèm theo — từ chối token.',
      expectedIssuer,
    );
  }
  throw new OAuthIssuerError(
    'OAuth iss validation: access token là opaque token (không phải JWT) và không có id_token kèm theo — ' +
      'không kiểm tra được issuer (fail closed). Cần id_token hoặc token JWT có claim iss.',
    expectedIssuer,
  );
}

/**
 * Validate issuer cho một token đã lưu (`McpOAuthToken` shape tối
 * thiểu: accessToken + idToken khi có). Dùng trong
 * `getValidAccessToken` (oauth.ts) trước khi trả token cho caller.
 * Token không có accessToken → ném. Trả `IssuerValidationResult`
 * khi qua.
 */
export function validateStoredTokenIssuer(
  token: { accessToken: string; idToken?: string },
  expectedIssuer: string,
  options: { expectedAudience?: string; nowMs?: number } = {},
): IssuerValidationResult {
  return validateTokenIssuer(token.accessToken, expectedIssuer, {
    ...(token.idToken ? { idToken: token.idToken } : {}),
    ...(options.expectedAudience ? { expectedAudience: options.expectedAudience } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
}

/**
 * Kiểm tra issuer của authorization server metadata khớp origin
 * của URL discovery không (RFC 8414 §3.2: issuer phải khớp).
 * Dùng ở bước discovery trong oauth.ts. Ném OAuthIssuerError khi
 * khác.
 */
export function validateDiscoveryIssuer(issuer: string, discoveryUrl: string): void {
  let origin: string;
  try {
    origin = new URL(discoveryUrl).origin;
  } catch {
    throw new OAuthIssuerError(
      `OAuth discovery URL không hợp lệ: ${JSON.stringify(discoveryUrl)}`,
      issuer,
    );
  }
  const issuerNorm = normalizeIssuer(issuer);
  const originNorm = normalizeIssuer(origin);
  if (issuerNorm === null || originNorm === null || issuerNorm !== originNorm) {
    throw new OAuthIssuerError(
      `OAuth discovery issuer không khớp URL discovery: issuer "${issuer}" khác origin "${origin}" — từ chối metadata.`,
      origin,
      issuer,
    );
  }
}

/** Mô tả ngắn kết quả validate (log — không chứa token). */
export function describeIssuerValidation(result: IssuerValidationResult): string {
  return `OAuth iss OK: issuer "${result.issuer}" (từ ${result.source === 'access_token' ? 'access token' : 'id_token'}).`;
}
