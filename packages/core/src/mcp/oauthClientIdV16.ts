/**
 * OAuth Client ID Metadata Documents v16 — MCP 2026-07-28, RFC 9207
 * (v1.36, Đội T3).
 *
 * MCP 2026-07-28 chuyển xác thực OAuth từ Dynamic Client
 * Registration (DCR) sang Client ID Metadata Documents: thay vì
 * client tự đăng ký động rồi giữ credential do server cấp (dễ bị
 * reuse credential sang server khác), client công bố một metadata
 * document tĩnh tại một URL, server lấy về và đối chiếu — cùng một
 * client_id mà xuất hiện với redirect_uri / jwks khác nhau ở hai
 * nơi thì đó là dấu hiệu reuse và phải bị chặn. Sóng trước
 * (`oauthIssuer.ts`) đã có `iss` validation bắt buộc theo RFC 9207
 * (so khớp `iss` của token với issuer mong đợi, kiểm tra exp/aud);
 * v16 xây lớp metadata document trên đó:
 *
 *   1. Parse + validate metadata document: client_id bắt buộc,
 *      redirect_uris bắt buộc (https, trừ loopback http cho app
 *      native; cấm wildcard, cấm fragment, cấm userinfo),
 *      token_endpoint_auth_method hợp lệ, jwks_uri https khi có.
 *   2. Fetch qua fetcher do coordinator chích vào (test dùng fake,
 *      không chạm mạng ở đây) + cache theo TTL + fingerprint
 *      (sha256 của JSON chuẩn hoá) để phát hiện document bị đổi.
 *   3. So sánh DCR vs metadata: cùng client_id nhưng redirect_uris
 *      / jwks_uri khác nhau → cảnh báo reuse credential, từ chối
 *      đăng ký.
 *   4. `iss` validation bắt buộc cho mọi token đi kèm metadata:
 *      issuer trong metadata phải khớp issuer của token (dùng lại
 *      `validateTokenIssuer`), thiếu issuer thì fail closed.
 *   5. Registry: đăng ký / tra cứu / thu hồi metadata document
 *      theo client_id.
 *
 * Module này không lưu secret: metadata document là dữ liệu công
 * khai của client (không chứa client_secret). Ideas only — không
 * copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
 */

import { createHash } from 'node:crypto';
import {
  OAuthIssuerError,
  normalizeIssuer,
  validateTokenIssuer,
  type IssuerValidationResult,
} from './oauthIssuer';

/** TTL cache mặc định cho metadata document đã fetch (1 giờ). */
export const CLIENT_METADATA_TTL_MS = 60 * 60 * 1000;

/** Lỗi Client ID Metadata v16. */
export class ClientMetadataV16Error extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ClientMetadataV16Error';
    if (code) this.code = code;
  }
}

/** Các phương thức xác thực ở token endpoint được chấp nhận. */
export const CLIENT_METADATA_AUTH_METHODS: readonly string[] = [
  'none',
  'client_secret_basic',
  'client_secret_post',
  'client_secret_jwt',
  'private_key_jwt',
];

/** Metadata document của một OAuth client. */
export interface ClientMetadataDocumentV16 {
  /** Client id (bắt buộc, duy nhất). */
  client_id: string;
  /** Tên hiển thị (tuỳ chọn). */
  client_name?: string;
  /** Redirect URI đã đăng ký (bắt buộc, ít nhất 1). */
  redirect_uris: string[];
  /** Grant type client dùng (mặc định authorization_code). */
  grant_types?: string[];
  /** Response type (mặc định code). */
  response_types?: string[];
  /** Cách xác thực ở token endpoint. */
  token_endpoint_auth_method?: string;
  /** URL JWKS công khai (khi dùng private_key_jwt / client_secret_jwt). */
  jwks_uri?: string;
  /** Scope yêu cầu (cách nhau bằng khoảng trắng). */
  scope?: string;
  /** Issuer OAuth mà client này tin tưởng (bắt buộc để validate iss). */
  issuer?: string;
  /** URL gốc nơi document này được công bố. */
  documentUrl?: string;
}

/** Bản ghi metadata đã đăng ký trong registry. */
export interface RegisteredClientMetadataV16 {
  document: ClientMetadataDocumentV16;
  /** Fingerprint sha256 của document chuẩn hoá. */
  fingerprint: string;
  /** Thời điểm đăng ký / fetch (ms epoch). */
  fetchedAtMs: number;
  /** Thời điểm hết hạn cache (ms epoch). */
  expiresAtMs: number;
  /** Document lấy từ DCR trước đây có cùng client_id không. */
  hadPriorDcrRegistration: boolean;
}

/** Cảnh báo reuse credential khi so sánh DCR vs metadata. */
export interface CredentialReuseAlertV16 {
  clientId: string;
  /** Trường nào khác nhau giữa hai bản đăng ký. */
  differingFields: string[];
  /** Chi tiết từng trường (cũ từ DCR vs mới từ metadata). */
  details: Record<string, { dcr: unknown; metadata: unknown }>;
}

/** Hàm fetch document (coordinator nối fetch thật; test dùng fake). */
export type ClientMetadataFetcherV16 = (url: string) => Promise<unknown>;

/** Tuỳ chọn cho ClientMetadataRegistryV16. */
export interface ClientMetadataRegistryOptions {
  /** TTL cache (ms, mặc định 1 giờ). */
  ttlMs?: number;
  /** Đồng hồ (để test điều khiển thời gian). */
  now?: () => number;
}

/** Chuẩn hoá JSON để hash: sort key đệ quy. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(rec[k])}`).join(',')}}`;
}

/** Fingerprint sha256 hex của một metadata document. */
export function fingerprintClientMetadata(document: ClientMetadataDocumentV16): string {
  return createHash('sha256').update(canonicalizeJson(document)).digest('hex');
}

/**
 * Validate một redirect URI: https bắt buộc, ngoại lệ duy nhất là
 * http loopback (127.0.0.1 / localhost) cho app native; cấm wildcard,
 * fragment, userinfo.
 */
export function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ClientMetadataV16Error(`Redirect URI không hợp lệ: ${uri}`, 'bad-redirect-uri');
  }
  if (parsed.protocol === 'https:') {
    // OK.
  } else if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
      throw new ClientMetadataV16Error(
        `Redirect URI "${uri}" dùng http ngoài loopback — bắt buộc https.`,
        'redirect-not-https',
      );
    }
  } else {
    throw new ClientMetadataV16Error(
      `Redirect URI "${uri}" dùng scheme "${parsed.protocol}" — chỉ https (hoặc http loopback) được phép.`,
      'redirect-bad-scheme',
    );
  }
  if (parsed.hash.length > 0) {
    throw new ClientMetadataV16Error(
      `Redirect URI "${uri}" chứa fragment — bị cấm.`,
      'redirect-has-fragment',
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ClientMetadataV16Error(
      `Redirect URI "${uri}" chứa credential trong URL — bị cấm.`,
      'redirect-has-credential',
    );
  }
  if (uri.includes('*')) {
    throw new ClientMetadataV16Error(
      `Redirect URI "${uri}" chứa wildcard — bị cấm.`,
      'redirect-has-wildcard',
    );
  }
}

/**
 * Parse + validate một metadata document thô. Ném
 * ClientMetadataV16Error liệt kê mọi vấn đề tìm thấy (không dừng
 * ở lỗi đầu tiên) để operator sửa một lần.
 */
export function parseClientMetadataDocument(value: unknown): ClientMetadataDocumentV16 {
  const problems: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClientMetadataV16Error('Client metadata document phải là object.', 'bad-document');
  }
  const rec = value as Record<string, unknown>;
  const clientId = rec['client_id'];
  if (typeof clientId !== 'string' || clientId.length === 0) {
    problems.push('thiếu client_id (bắt buộc, không rỗng)');
  }
  const redirectUris = rec['redirect_uris'];
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    problems.push('thiếu redirect_uris (bắt buộc, ít nhất 1 URI)');
  } else {
    for (const uri of redirectUris) {
      if (typeof uri !== 'string') {
        problems.push(`redirect_uris chứa giá trị không phải chuỗi: ${String(uri)}`);
        continue;
      }
      try {
        validateRedirectUri(uri);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  const authMethod = rec['token_endpoint_auth_method'];
  if (authMethod !== undefined) {
    if (typeof authMethod !== 'string' || !CLIENT_METADATA_AUTH_METHODS.includes(authMethod)) {
      problems.push(
        `token_endpoint_auth_method "${String(authMethod)}" không hợp lệ (chấp nhận: ${CLIENT_METADATA_AUTH_METHODS.join(', ')})`,
      );
    }
  }
  const jwksUri = rec['jwks_uri'];
  if (jwksUri !== undefined) {
    if (typeof jwksUri !== 'string' || !jwksUri.startsWith('https://')) {
      problems.push('jwks_uri phải là URL https');
    }
  }
  const issuer = rec['issuer'];
  if (issuer !== undefined && typeof issuer !== 'string') {
    problems.push('issuer phải là chuỗi');
  }
  if (issuer !== undefined && typeof issuer === 'string' && normalizeIssuer(issuer) === null) {
    problems.push(`issuer "${issuer}" không hợp lệ (phải là URL https không có fragment/query)`);
  }
  const grantTypes = rec['grant_types'];
  if (grantTypes !== undefined) {
    if (!Array.isArray(grantTypes) || grantTypes.some((g) => typeof g !== 'string')) {
      problems.push('grant_types phải là mảng chuỗi');
    }
  }
  if (problems.length > 0) {
    throw new ClientMetadataV16Error(
      `Client metadata document không hợp lệ: ${problems.join('; ')}`,
      'invalid-document',
    );
  }
  return {
    client_id: clientId as string,
    ...(typeof rec['client_name'] === 'string' ? { client_name: rec['client_name'] as string } : {}),
    redirect_uris: redirectUris as string[],
    ...(Array.isArray(grantTypes) ? { grant_types: grantTypes as string[] } : {}),
    ...(Array.isArray(rec['response_types'])
      ? { response_types: (rec['response_types'] as unknown[]).filter((r): r is string => typeof r === 'string') }
      : {}),
    ...(typeof authMethod === 'string' ? { token_endpoint_auth_method: authMethod as string } : {}),
    ...(typeof jwksUri === 'string' ? { jwks_uri: jwksUri as string } : {}),
    ...(typeof rec['scope'] === 'string' ? { scope: rec['scope'] as string } : {}),
    ...(typeof issuer === 'string' ? { issuer: issuer as string } : {}),
    ...(typeof rec['documentUrl'] === 'string' ? { documentUrl: rec['documentUrl'] as string } : {}),
  };
}

/**
 * So sánh một bản đăng ký DCR cũ với metadata document mới cùng
 * client_id. Trả về alert khi có trường khác nhau (dấu hiệu reuse
 * credential: cùng client_id nhưng redirect/jwks khác → credential
 * có thể đã bị mang sang server khác). Null khi khớp hoàn toàn.
 */
export function compareDcrWithMetadata(
  dcr: { client_id: string; redirect_uris?: string[]; jwks_uri?: string; token_endpoint_auth_method?: string },
  metadata: ClientMetadataDocumentV16,
): CredentialReuseAlertV16 | null {
  const differingFields: string[] = [];
  const details: Record<string, { dcr: unknown; metadata: unknown }> = {};
  const sorted = (uris: string[] | undefined): string[] => [...(uris ?? [])].sort();
  const dcrUris = sorted(dcr.redirect_uris);
  const metaUris = sorted(metadata.redirect_uris);
  if (JSON.stringify(dcrUris) !== JSON.stringify(metaUris)) {
    differingFields.push('redirect_uris');
    details['redirect_uris'] = { dcr: dcrUris, metadata: metaUris };
  }
  if ((dcr.jwks_uri ?? undefined) !== (metadata.jwks_uri ?? undefined)) {
    differingFields.push('jwks_uri');
    details['jwks_uri'] = { dcr: dcr.jwks_uri ?? null, metadata: metadata.jwks_uri ?? null };
  }
  if (
    (dcr.token_endpoint_auth_method ?? undefined) !==
    (metadata.token_endpoint_auth_method ?? undefined)
  ) {
    differingFields.push('token_endpoint_auth_method');
    details['token_endpoint_auth_method'] = {
      dcr: dcr.token_endpoint_auth_method ?? null,
      metadata: metadata.token_endpoint_auth_method ?? null,
    };
  }
  if (differingFields.length === 0) return null;
  return { clientId: metadata.client_id, differingFields, details };
}

/**
 * Registry Client ID Metadata Documents v16: fetch (qua fetcher
 * chích vào) + validate + cache + phát hiện reuse + validate iss.
 */
export class ClientMetadataRegistryV16 {
  private readonly fetcher?: ClientMetadataFetcherV16;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly registered = new Map<string, RegisteredClientMetadataV16>();
  /** Bản đăng ký DCR cũ đã biết (để so sánh reuse). */
  private readonly priorDcr = new Map<
    string,
    { redirect_uris?: string[]; jwks_uri?: string; token_endpoint_auth_method?: string }
  >();

  constructor(fetcher?: ClientMetadataFetcherV16, options: ClientMetadataRegistryOptions = {}) {
    this.fetcher = fetcher;
    this.ttlMs = options.ttlMs ?? CLIENT_METADATA_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Ghi nhận một bản đăng ký DCR cũ (để so sánh khi metadata về). */
  notePriorDcrRegistration(
    clientId: string,
    registration: { redirect_uris?: string[]; jwks_uri?: string; token_endpoint_auth_method?: string },
  ): void {
    this.priorDcr.set(clientId, { ...registration });
  }

  /** Đăng ký một metadata document đã parse (sau khi validate). */
  register(document: ClientMetadataDocumentV16): {
    registered: RegisteredClientMetadataV16;
    reuseAlert: CredentialReuseAlertV16 | null;
  } {
    const nowMs = this.now();
    const prior = this.priorDcr.get(document.client_id);
    const reuseAlert = prior
      ? compareDcrWithMetadata(
          { client_id: document.client_id, ...prior },
          document,
        )
      : null;
    const registered: RegisteredClientMetadataV16 = {
      document: { ...document, redirect_uris: [...document.redirect_uris] },
      fingerprint: fingerprintClientMetadata(document),
      fetchedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      hadPriorDcrRegistration: Boolean(prior),
    };
    this.registered.set(document.client_id, registered);
    return { registered, reuseAlert };
  }

  /** Tra cứu bản đăng ký theo client_id (bản sao), hoặc undefined. */
  lookup(clientId: string): RegisteredClientMetadataV16 | undefined {
    const found = this.registered.get(clientId);
    if (!found) return undefined;
    return {
      ...found,
      document: { ...found.document, redirect_uris: [...found.document.redirect_uris] },
    };
  }

  /** Thu hồi một client_id khỏi registry. */
  revoke(clientId: string): boolean {
    return this.registered.delete(clientId);
  }

  /** Số client đã đăng ký. */
  size(): number {
    return this.registered.size;
  }

  /**
   * Fetch metadata document từ URL rồi validate + đăng ký. Ném khi
   * không có fetcher, fetch lỗi, document không hợp lệ, hoặc phát
   * hiện reuse credential (fail closed — không đăng ký).
   */
  async fetchAndRegister(documentUrl: string): Promise<{
    registered: RegisteredClientMetadataV16;
    reuseAlert: CredentialReuseAlertV16 | null;
  }> {
    if (!this.fetcher) {
      throw new ClientMetadataV16Error(
        'Chưa cấu hình fetcher cho Client ID Metadata Documents.',
        'no-fetcher',
      );
    }
    if (typeof documentUrl !== 'string' || !documentUrl.startsWith('https://')) {
      throw new ClientMetadataV16Error(
        'URL metadata document phải là https.',
        'bad-document-url',
      );
    }
    const cached = [...this.registered.values()].find(
      (r) => r.document.documentUrl === documentUrl && this.now() < r.expiresAtMs,
    );
    if (cached) return { registered: this.lookup(cached.document.client_id) as RegisteredClientMetadataV16, reuseAlert: null };
    let raw: unknown;
    try {
      raw = await this.fetcher(documentUrl);
    } catch (err) {
      throw new ClientMetadataV16Error(
        `Fetch metadata document lỗi: ${err instanceof Error ? err.message : String(err)}`,
        'fetch-failed',
      );
    }
    const document = parseClientMetadataDocument(raw);
    document.documentUrl = documentUrl;
    const result = this.register(document);
    if (result.reuseAlert) {
      // Fail closed: phát hiện reuse thì gỡ ngay bản vừa đăng ký.
      this.registered.delete(document.client_id);
      throw new ClientMetadataV16Error(
        `Phát hiện reuse credential cho client "${document.client_id}": khác nhau ở ${result.reuseAlert.differingFields.join(', ')} so với bản đăng ký DCR trước đây — từ chối đăng ký.`,
        'credential-reuse',
      );
    }
    return result;
  }

  /**
   * Validate `iss` của một token theo metadata đã đăng ký: issuer
   * trong metadata là expectedIssuer bắt buộc; thiếu issuer trong
   * metadata thì fail closed (dùng lại `validateTokenIssuer`).
   */
  validateTokenForClient(
    clientId: string,
    accessToken: string,
    options: { idToken?: string; nowMs?: number } = {},
  ): IssuerValidationResult {
    const registered = this.registered.get(clientId);
    if (!registered) {
      throw new ClientMetadataV16Error(
        `Client "${clientId}" chưa đăng ký metadata document.`,
        'client-not-registered',
      );
    }
    const issuer = registered.document.issuer;
    if (typeof issuer !== 'string' || issuer.length === 0) {
      throw new OAuthIssuerError(
        `Client "${clientId}" không khai issuer trong metadata — iss validation bắt buộc, fail closed.`,
        issuer,
      );
    }
    return validateTokenIssuer(accessToken, issuer, {
      idToken: options.idToken,
      expectedAudience: clientId,
      nowMs: options.nowMs ?? this.now(),
    });
  }
}
