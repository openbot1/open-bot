/**
 * URL-mode elicitation v16 — MCP 2026-07-28 (v1.36, Đội T3).
 *
 * Spec MCP 2026-07-28 cấm dùng form mode cho password / API key /
 * token / thông tin thanh toán: các trường đó CHỈ được thu thập qua
 * URL mode — mở một trang ngoài (OAuth sign-in, payment page) trong
 * trình duyệt, server nhận kết quả qua callback, client không bao
 * giờ thấy secret. Sóng trước (`elicitation.ts`) đã có
 * `isSensitiveElicitationField` + `ElicitationUrlTracker` cho luồng
 * URL cơ bản; v16 xây lớp quản lý phiên đầy đủ trên đó:
 *
 *   1. Form-mode guard: `assertFormModeAllowed()` quét schema của
 *      form và ném lỗi liệt kê từng trường nhạy cảm bị cấm — không
 *      một secret nào được đi qua form/context nữa.
 *   2. URL session: tạo phiên elicitation URL (mục đích oauth-signin
 *      / payment / credential-refresh / consent), URL đích phải https,
 *      host nằm trong allowlist, không chứa userinfo/credential,
 *      không dùng scheme javascript:/data:; phiên single-use, có hạn,
 *      hoàn thành qua callback token đã ký HMAC.
 *   3. State machine rõ ràng: pending → completed | expired |
 *      cancelled | failed; phiên hết hạn thì quét dọn, callback tới
 *      muộn bị từ chối.
 *   4. Không lưu secret: session chỉ giữ url + mục đích + metadata
 *      vô hại; kết quả callback chỉ giữ status + mã tham chiếu, không
 *      giữ token/code trả về (caller tự đổi code lấy token qua kênh
 *      an toàn của mình).
 *
 * Module này không mở trình duyệt, không gọi mạng: coordinator nối
 * `openUrl` của host vào. Ideas only — không copy code/text/tài
 * sản của bất kỳ repo nào, của xAI/Cursor.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isSensitiveElicitationField } from './elicitation';

/** Mục đích của một phiên elicitation URL. */
export type UrlElicitationPurpose =
  | 'oauth-signin'
  | 'payment'
  | 'credential-refresh'
  | 'consent';

/** Trạng thái của một phiên elicitation URL. */
export type UrlElicitationStatus =
  | 'pending'
  | 'completed'
  | 'expired'
  | 'cancelled'
  | 'failed';

/** Hạn dùng mặc định của một phiên URL (15 phút). */
export const URL_ELICITATION_TTL_MS = 15 * 60 * 1000;

/** Độ dài URL tối đa cho phép. */
export const URL_ELICITATION_MAX_URL_LENGTH = 2048;

/** Lỗi elicitation URL v16. */
export class ElicitationUrlV16Error extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ElicitationUrlV16Error';
    if (code) this.code = code;
  }
}

/** Một trường form cần kiểm tra trước khi cho phép form mode. */
export interface FormFieldToCheck {
  name: string;
  schema?: Record<string, unknown>;
}

/** Vi phạm form-mode: một trường nhạy cảm bị cấm dùng form. */
export interface FormModeViolation {
  field: string;
  reason: string;
  /** Chế độ phải dùng thay thế. */
  mustUse: 'url';
}

/** Kết quả kiểm tra form mode. */
export interface FormModeCheckResult {
  allowed: boolean;
  violations: FormModeViolation[];
}

/** Một phiên elicitation URL. */
export interface UrlElicitationSession {
  /** Id phiên (UUID). */
  id: string;
  purpose: UrlElicitationPurpose;
  /** URL đích (đã validate). */
  url: string;
  /** Host đích (đã trích từ URL). */
  host: string;
  /** Server / tool yêu cầu elicitation. */
  serverName: string;
  /** Mô tả hiển thị cho user. */
  prompt: string;
  status: UrlElicitationStatus;
  createdAtMs: number;
  expiresAtMs: number;
  /** Thời điểm hoàn thành / hết hạn / huỷ (khi có). */
  resolvedAtMs?: number;
  /** Mã tham chiếu kết quả (không phải secret). */
  reference?: string;
  /** Lý do thất bại / huỷ (khi có). */
  reason?: string;
}

/** Tuỳ chọn khi tạo UrlElicitationManagerV16. */
export interface UrlElicitationManagerOptions {
  /** Host được phép mở URL elicitation (bắt buộc, ít nhất 1). */
  allowedHosts: string[];
  /** Secret ký callback token (mặc định sinh ngẫu nhiên mỗi lần). */
  callbackSecret?: string;
  /** TTL phiên (ms, mặc định 15 phút). */
  ttlMs?: number;
  /** Đồng hồ (để test điều khiển thời gian). */
  now?: () => number;
}

/**
 * Validate một URL đích cho elicitation URL mode. Ném
 * ElicitationUrlV16Error khi vi phạm bất kỳ quy tắc nào:
 * https bắt buộc, host trong allowlist, không userinfo, không
 * scheme nguy hiểm, không quá dài.
 */
export function validateElicitationUrl(
  url: string,
  allowedHosts: readonly string[],
): { host: string } {
  if (typeof url !== 'string' || url.length === 0) {
    throw new ElicitationUrlV16Error('URL elicitation rỗng.', 'empty-url');
  }
  if (url.length > URL_ELICITATION_MAX_URL_LENGTH) {
    throw new ElicitationUrlV16Error(
      `URL elicitation dài ${url.length} ký tự, vượt giới hạn ${URL_ELICITATION_MAX_URL_LENGTH}.`,
      'url-too-long',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ElicitationUrlV16Error(`URL elicitation không hợp lệ: ${url}`, 'bad-url');
  }
  if (parsed.protocol !== 'https:') {
    throw new ElicitationUrlV16Error(
      `URL elicitation phải dùng https, nhận được "${parsed.protocol}".`,
      'not-https',
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ElicitationUrlV16Error(
      'URL elicitation không được chứa credential trong URL (userinfo).',
      'credential-in-url',
    );
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = allowedHosts.some((allowedHost) => {
    const h = allowedHost.toLowerCase();
    return host === h || host.endsWith(`.${h}`);
  });
  if (!allowed) {
    throw new ElicitationUrlV16Error(
      `Host "${host}" không nằm trong allowlist elicitation (${allowedHosts.join(', ')}).`,
      'host-not-allowed',
    );
  }
  return { host };
}

/**
 * Kiểm tra form mode có được phép cho danh sách trường này không.
 * Dùng `isSensitiveElicitationField` của sóng trước (tên trường +
 * `format: password`) cộng thêm quét schema lồng nhau: bất kỳ
 * trường nào nhạy cảm cũng là vi phạm — form mode bị cấm cho
 * secret, phải dùng URL mode.
 */
export function checkFormModeAllowed(fields: FormFieldToCheck[]): FormModeCheckResult {
  const violations: FormModeViolation[] = [];
  for (const field of fields) {
    const schema = field.schema ?? {};
    if (isSensitiveElicitationField(field.name, schema)) {
      violations.push({
        field: field.name,
        reason: 'Trường nhạy cảm (password / API key / token / thanh toán) bị cấm ở form mode.',
        mustUse: 'url',
      });
      continue;
    }
    // Quét schema lồng nhau (properties): một field con nhạy cảm
    // cũng đủ cấm cả form.
    const properties = schema['properties'];
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [childName, childSchema] of Object.entries(
        properties as Record<string, unknown>,
      )) {
        const childRecord =
          childSchema !== null && typeof childSchema === 'object' && !Array.isArray(childSchema)
            ? (childSchema as Record<string, unknown>)
            : {};
        if (isSensitiveElicitationField(childName, childRecord)) {
          violations.push({
            field: `${field.name}.${childName}`,
            reason: 'Trường con nhạy cảm bị cấm ở form mode.',
            mustUse: 'url',
          });
        }
      }
    }
  }
  return { allowed: violations.length === 0, violations };
}

/**
 * Ném khi form mode không được phép (tiện dùng ở đầu handler).
 * Thông báo liệt kê đủ các trường vi phạm để server sửa schema.
 */
export function assertFormModeAllowed(fields: FormFieldToCheck[]): void {
  const result = checkFormModeAllowed(fields);
  if (result.allowed) return;
  const listed = result.violations.map((v) => `"${v.field}" (${v.reason})`).join('; ');
  throw new ElicitationUrlV16Error(
    `Form mode bị cấm cho secret/credential — dùng URL mode thay thế. Vi phạm: ${listed}`,
    'form-mode-forbidden-for-secret',
  );
}

/** Gợi ý mục đích URL từ tên trường nhạy cảm (để server chọn đúng flow). */
export function suggestUrlPurpose(fieldName: string): UrlElicitationPurpose {
  const lower = fieldName.toLowerCase();
  if (/card|payment|pay|billing|checkout|cvv/.test(lower)) return 'payment';
  if (/refresh|renew|rotate|expired/.test(lower)) return 'credential-refresh';
  if (/consent|approve|permission|scope/.test(lower)) return 'consent';
  return 'oauth-signin';
}

function signCallback(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Quản lý phiên elicitation URL v16: tạo / hoàn thành / huỷ / quét
 * dọn phiên hết hạn. Callback token ký HMAC (`v16url.<payload>.<sig>`)
 * để chỉ callback thật mới hoàn thành được phiên, và mỗi token chỉ
 * dùng một lần.
 */
export class UrlElicitationManagerV16 {
  private readonly allowedHosts: string[];
  private readonly callbackSecret: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, UrlElicitationSession>();
  /** Callback token đã dùng (chống replay). */
  private readonly usedTokens = new Set<string>();

  constructor(options: UrlElicitationManagerOptions) {
    if (!Array.isArray(options.allowedHosts) || options.allowedHosts.length === 0) {
      throw new ElicitationUrlV16Error(
        'URL elicitation cần allowlist host (ít nhất 1 host).',
        'no-allowed-hosts',
      );
    }
    this.allowedHosts = [...options.allowedHosts];
    this.callbackSecret = options.callbackSecret ?? randomBytes(32).toString('base64url');
    this.ttlMs = options.ttlMs ?? URL_ELICITATION_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Host được phép (bản sao). */
  hosts(): string[] {
    return [...this.allowedHosts];
  }

  /** Số phiên đang giữ (kể cả đã resolve — để test / dọn dẹp). */
  size(): number {
    return this.sessions.size;
  }

  /** Tạo một phiên elicitation URL (validate URL trước). */
  createSession(input: {
    purpose: UrlElicitationPurpose;
    url: string;
    serverName: string;
    prompt: string;
  }): UrlElicitationSession {
    const { host } = validateElicitationUrl(input.url, this.allowedHosts);
    const nowMs = this.now();
    const session: UrlElicitationSession = {
      id: randomUUID(),
      purpose: input.purpose,
      url: input.url,
      host,
      serverName: input.serverName,
      prompt: input.prompt,
      status: 'pending',
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };
    this.sessions.set(session.id, session);
    return { ...session };
  }

  /** Lấy một phiên theo id (bản sao), hoặc undefined. */
  getSession(id: string): UrlElicitationSession | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session } : undefined;
  }

  /** Liệt kê phiên đang pending (chưa resolve, chưa hết hạn). */
  pendingSessions(): UrlElicitationSession[] {
    this.sweepExpired();
    return [...this.sessions.values()]
      .filter((s) => s.status === 'pending')
      .map((s) => ({ ...s }));
  }

  /** Ký callback token cho một phiên pending. */
  issueCallbackToken(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new ElicitationUrlV16Error(
        `Không tìm thấy phiên elicitation "${sessionId}".`,
        'session-not-found',
      );
    }
    if (session.status !== 'pending') {
      throw new ElicitationUrlV16Error(
        `Phiên "${sessionId}" đã ${session.status}, không cấp callback token.`,
        'session-not-pending',
      );
    }
    const payload = Buffer.from(
      JSON.stringify({ sid: sessionId, exp: session.expiresAtMs }),
      'utf8',
    ).toString('base64url');
    return `v16url.${payload}.${signCallback(this.callbackSecret, payload)}`;
  }

  /**
   * Hoàn thành một phiên bằng callback token. Token phải đúng chữ
   * ký, chưa dùng, phiên còn pending và chưa hết hạn. `reference`
   * là mã tham chiếu vô hại (vd mã giao dịch) — KHÔNG đưa secret
   * (token/code) vào đây.
   */
  completeByCallback(
    token: string,
    reference?: string,
  ): UrlElicitationSession {
    if (this.usedTokens.has(token)) {
      throw new ElicitationUrlV16Error('Callback token đã dùng — từ chối replay.', 'token-reused');
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v16url') {
      throw new ElicitationUrlV16Error('Callback token sai định dạng.', 'bad-token');
    }
    const [payload, sig] = [parts[1] as string, parts[2] as string];
    const expected = signCallback(this.callbackSecret, payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ElicitationUrlV16Error('Callback token sai chữ ký.', 'bad-signature');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    } catch {
      throw new ElicitationUrlV16Error('Callback token không giải mã được.', 'bad-token');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ElicitationUrlV16Error('Callback token không giải mã được.', 'bad-token');
    }
    const sid = (parsed as Record<string, unknown>)['sid'];
    const exp = (parsed as Record<string, unknown>)['exp'];
    if (typeof sid !== 'string' || typeof exp !== 'number') {
      throw new ElicitationUrlV16Error('Callback token thiếu sid/exp.', 'bad-token');
    }
    const session = this.sessions.get(sid);
    if (!session) {
      throw new ElicitationUrlV16Error(`Không tìm thấy phiên "${sid}".`, 'session-not-found');
    }
    if (session.status !== 'pending') {
      throw new ElicitationUrlV16Error(
        `Phiên "${sid}" đã ${session.status}.`,
        'session-not-pending',
      );
    }
    if (this.now() > session.expiresAtMs || this.now() > exp) {
      session.status = 'expired';
      session.resolvedAtMs = this.now();
      throw new ElicitationUrlV16Error(`Phiên "${sid}" đã hết hạn.`, 'session-expired');
    }
    this.usedTokens.add(token);
    session.status = 'completed';
    session.resolvedAtMs = this.now();
    if (typeof reference === 'string' && reference.length > 0) session.reference = reference;
    return { ...session };
  }

  /** Huỷ một phiên pending (user đóng trang / từ chối). */
  cancelSession(id: string, reason?: string): UrlElicitationSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new ElicitationUrlV16Error(`Không tìm thấy phiên "${id}".`, 'session-not-found');
    }
    if (session.status !== 'pending') {
      throw new ElicitationUrlV16Error(
        `Phiên "${id}" đã ${session.status}, không huỷ được.`,
        'session-not-pending',
      );
    }
    session.status = 'cancelled';
    session.resolvedAtMs = this.now();
    if (reason) session.reason = reason;
    return { ...session };
  }

  /** Đánh dấu một phiên pending thành failed (vd trang đích lỗi). */
  failSession(id: string, reason: string): UrlElicitationSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new ElicitationUrlV16Error(`Không tìm thấy phiên "${id}".`, 'session-not-found');
    }
    if (session.status !== 'pending') {
      throw new ElicitationUrlV16Error(
        `Phiên "${id}" đã ${session.status}.`,
        'session-not-pending',
      );
    }
    session.status = 'failed';
    session.resolvedAtMs = this.now();
    session.reason = reason;
    return { ...session };
  }

  /**
   * Quét dọn: phiên pending quá hạn → expired. Trả về số phiên
   * vừa chuyển trạng thái.
   */
  sweepExpired(nowMs?: number): number {
    const now = nowMs ?? this.now();
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === 'pending' && now > session.expiresAtMs) {
        session.status = 'expired';
        session.resolvedAtMs = now;
        count += 1;
      }
    }
    return count;
  }
}
