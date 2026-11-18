/**
 * MCP Apps consent v15 — consent bắt buộc cho action do UI khởi xướng
 * (SEP-1865 stable 2026-01-26, ideas only — không copy code/text/tài
 * sản của bất kỳ repo nào).
 *
 * Nguyên tắc nền tảng: UI là code KHÔNG TIN CẬY. App trong iframe
 * sandboxed không bao giờ được tự ý gọi tool có tác dụng phụ — mọi
 * action từ UI đều phải qua host, và host chỉ thực thi khi:
 *
 *   - action là read-only (đọc/liệt kê/tìm kiếm) VÀ app được
 *     allowlist cho tool đó → auto-approve (không làm phiền user),
 *   - action có tác dụng phụ (tạo/sửa/xoá/gửi) → BẮT BUỘC user
 *     duyệt qua consent request (kể cả khi app đã được cấp quyền
 *     trước đó — quyền cũ không tự động áp cho action mới),
 *   - action nhạy cảm (thanh toán, quản trị, secret, xoá hàng loạt)
 *     → BẮT BUỘC user duyệt, không có auto-approve, và consent chỉ
 *     có hiệu lực cho ĐÚNG MỘT lần gọi (one-shot).
 *
 * Consent request có hạn (mặc định 5 phút): user không quyết kịp →
 * expired, app phải xin lại. Mọi quyết định (approve/deny/expire)
 * đều ghi audit kèm hash chain nhẹ (prevHash) để panel kiểm chứng.
 *
 * Module này thuần (không DOM, không network). Host bridge v15 gọi
 * `requestConsent` trước khi chạy tools/call; renderer hiện consent
 * request cho user và gọi `decide`.
 */

export const MCP_APPS_V15_CONSENT_VERSION = '15.0.0';
/** Consent mặc định hết hạn sau 5 phút. */
export const UI_V15_CONSENT_DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Consent tối đa hết hạn sau 30 phút (host không cho lâu hơn). */
export const UI_V15_CONSENT_MAX_TTL_MS = 30 * 60 * 1000;
/** Số consent đang chờ tối đa (mỗi app). */
export const UI_V15_MAX_PENDING_CONSENTS_PER_APP = 16;
/** Số consent đang chờ tối đa toàn host. */
export const UI_V15_MAX_PENDING_CONSENTS = 64;
/** Số audit entry tối đa giữ trong bộ nhớ. */
export const UI_V15_MAX_CONSENT_AUDIT = 2_000;
/** Tóm tắt args tối đa (ký tự) trong consent request — chống leak. */
export const UI_V15_CONSENT_ARG_SUMMARY_MAX_CHARS = 2_000;
/** Một arg string dài hơn mức này thì cắt + đánh dấu. */
export const UI_V15_CONSENT_ARG_VALUE_MAX_CHARS = 500;

/** Phân loại tác dụng phụ của một tool call. */
export type UiV15ActionKind = 'read-only' | 'side-effect' | 'sensitive';

/** Trạng thái của một consent request. */
export type UiV15ConsentStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** Quyết định của user trên một consent request. */
export type UiV15ConsentDecision = 'approved' | 'denied';

/** Chính sách consent của một app (host cấu hình tường minh). */
export interface UiV15AppConsentPolicy {
  /** App resourceUri. */
  appUri: string;
  /** Tool được auto-approve khi là read-only (mặc định: rỗng = không auto). */
  autoApproveReadOnlyTools: string[];
  /** Tool bị cấm hẳn — app xin là từ chối ngay, không hiện consent. */
  deniedTools: string[];
  /** Tool luôn cần consent dù là read-only (vd tool đọc dữ liệu nhạy cảm). */
  alwaysRequireConsentTools: string[];
  /** Cho phép one-shot consent (mặc định true). */
  allowOneShot: boolean;
}

export class McpAppsConsentV15Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpAppsConsentV15Error';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Tiền tố tên tool thường là read-only (đọc/liệt kê/tìm kiếm). */
export const UI_V15_READ_ONLY_TOOL_PREFIXES = [
  'get',
  'list',
  'read',
  'search',
  'fetch',
  'show',
  'view',
  'describe',
  'check',
  'count',
  'find',
  'query',
  'preview',
] as const;

/** Tiền tố tên tool là tác dụng phụ (tạo/sửa/xoá/gửi). */
export const UI_V15_SIDE_EFFECT_TOOL_PREFIXES = [
  'create',
  'update',
  'delete',
  'remove',
  'send',
  'post',
  'write',
  'set',
  'add',
  'run',
  'execute',
  'publish',
  'upload',
  'install',
  'uninstall',
  'approve',
  'revoke',
  'grant',
  'move',
  'rename',
  'merge',
  'deploy',
  'restart',
  'stop',
  'start',
  'cancel',
] as const;

/** Từ khoá trong tên tool / args khiến action thành nhạy cảm. */
export const UI_V15_SENSITIVE_KEYWORDS = [
  'payment',
  'pay',
  'charge',
  'refund',
  'billing',
  'secret',
  'password',
  'token',
  'credential',
  'admin',
  'sudo',
  'root',
  'delete-all',
  'purge',
  'wipe',
  'transfer',
  'withdraw',
] as const;

/**
 * Phân loại một tool call theo tên tool (+ args gợi ý).
 *
 * Thứ tự (fail-closed):
 *   1. Tên hoặc args chứa từ khoá nhạy cảm → sensitive.
 *   2. Tên bắt đầu bằng tiền tố tác dụng phụ → side-effect.
 *   3. Tên bắt đầu bằng tiền tố read-only → read-only.
 *   4. Không rõ → side-effect (mặc định cần consent — không đoán
 *      tool lạ là an toàn).
 */
export function classifyToolCallV15(
  toolName: string,
  args: Record<string, unknown> = {},
): { kind: UiV15ActionKind; reason: string } {
  const name = toolName.trim();
  const lower = name.toLowerCase();
  const argText = JSON.stringify(args).toLowerCase();
  for (const keyword of UI_V15_SENSITIVE_KEYWORDS) {
    if (lower.includes(keyword) || argText.includes(keyword)) {
      return {
        kind: 'sensitive',
        reason: `Tool "${name}" chứa từ khoá nhạy cảm "${keyword}" — luôn cần user duyệt một lần.`,
      };
    }
  }
  for (const prefix of UI_V15_SIDE_EFFECT_TOOL_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}_`) || lower.startsWith(`${prefix}-`)) {
      return {
        kind: 'side-effect',
        reason: `Tool "${name}" có tác dụng phụ (tiền tố "${prefix}") — cần user duyệt.`,
      };
    }
  }
  for (const prefix of UI_V15_READ_ONLY_TOOL_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}_`) || lower.startsWith(`${prefix}-`)) {
      return {
        kind: 'read-only',
        reason: `Tool "${name}" chỉ đọc dữ liệu (tiền tố "${prefix}").`,
      };
    }
  }
  return {
    kind: 'side-effect',
    reason: `Tool "${name}" không rõ tác dụng — mặc định coi là có tác dụng phụ, cần user duyệt.`,
  };
}

/** Key trông như chứa secret — giá trị bị che khi tóm tắt args. */
const SECRET_ARG_KEY_RE = /(password|passwd|secret|token|api[_-]?key|auth|credential|private[_-]?key|bearer)/i;

/**
 * Tóm tắt args cho consent request: che giá trị của key nhạy cảm,
 * cắt string dài, giới hạn tổng độ dài. User thấy ĐỦ để quyết định
 * mà không bị rò rỉ secret vào log/panel.
 */
export function summarizeArgsForConsentV15(args: Record<string, unknown>): string {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SECRET_ARG_KEY_RE.test(key)) {
      redacted[key] = '*** (đã che)';
      continue;
    }
    if (typeof value === 'string' && value.length > UI_V15_CONSENT_ARG_VALUE_MAX_CHARS) {
      redacted[key] = `${value.slice(0, UI_V15_CONSENT_ARG_VALUE_MAX_CHARS)}…(đã cắt, còn ${value.length - UI_V15_CONSENT_ARG_VALUE_MAX_CHARS} ký tự)`;
      continue;
    }
    if (Array.isArray(value) && value.length > 20) {
      redacted[key] = `[mảng ${value.length} phần tử — hiển thị 20 đầu]`;
      redacted[`${key}__first20`] = value.slice(0, 20);
      continue;
    }
    redacted[key] = value;
  }
  let text = JSON.stringify(redacted, null, 2);
  if (text.length > UI_V15_CONSENT_ARG_SUMMARY_MAX_CHARS) {
    text = `${text.slice(0, UI_V15_CONSENT_ARG_SUMMARY_MAX_CHARS)}\n…(đã cắt bớt)`;
  }
  return text;
}

/** Một consent request đang chờ / đã quyết. */
export interface UiV15ConsentRequest {
  id: string;
  sessionId: string;
  appUri: string;
  serverName: string;
  toolName: string;
  /** Phân loại tác dụng phụ. */
  kind: UiV15ActionKind;
  /** Tóm tắt args đã che secret. */
  argsSummary: string;
  /** Lý do phân loại (hiển thị cho user). */
  reason: string;
  status: UiV15ConsentStatus;
  /** Request JSON-RPC id mà consent này gắn vào (để bridge trả response). */
  bridgeRequestId?: string | number;
  createdAtMs: number;
  expiresAtMs: number;
  decidedAtMs?: number;
  decidedBy?: 'user' | 'auto' | 'system';
  /** Ghi chú quyết định (vd "auto-approve read-only"). */
  decisionNote?: string;
}

/** Một dòng audit consent (hash chain nhẹ). */
export interface UiV15ConsentAuditEntry {
  seq: number;
  atMs: number;
  consentId: string;
  appUri: string;
  toolName: string;
  kind: UiV15ActionKind;
  action: 'requested' | 'approved' | 'denied' | 'expired' | 'auto-approved';
  decidedBy?: 'user' | 'auto' | 'system';
  prevHash: string;
  hash: string;
}

export interface UiConsentManagerV15Options {
  now?: () => number;
  /** TTL mặc định của consent (ms). */
  defaultTtlMs?: number;
}

/** Thống kê consent manager. */
export interface UiConsentManagerV15Stats {
  pending: number;
  approved: number;
  denied: number;
  expired: number;
  autoApproved: number;
  auditEntries: number;
  policies: number;
}

/**
 * Consent manager v15 — tạo / quyết định / hết hạn consent request
 * cho action do UI khởi xướng, kèm policy theo app và audit hash
 * chain. Mọi quyết định auto đều có lý do ghi rõ — không có
 * auto-approve âm thầm cho action có tác dụng phụ.
 */
export class UiConsentManagerV15 {
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly requests = new Map<string, UiV15ConsentRequest>();
  private readonly policies = new Map<string, UiV15AppConsentPolicy>();
  private readonly audit: UiV15ConsentAuditEntry[] = [];
  private counter = 0;
  private auditSeq = 0;
  private lastHash = 'genesis';
  private approvedCount = 0;
  private deniedCount = 0;
  private expiredCount = 0;
  private autoApprovedCount = 0;

  constructor(options: UiConsentManagerV15Options = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = Math.min(
      Math.max(1_000, options.defaultTtlMs ?? UI_V15_CONSENT_DEFAULT_TTL_MS),
      UI_V15_CONSENT_MAX_TTL_MS,
    );
  }

  /** Số consent đang chờ. */
  get pendingCount(): number {
    return [...this.requests.values()].filter((r) => r.status === 'pending').length;
  }

  // -- policy ---------------------------------------------------------------

  /** Đặt chính sách consent cho một app (ghi đè policy cũ). */
  setPolicy(policy: UiV15AppConsentPolicy): UiV15AppConsentPolicy {
    if (!policy.appUri.startsWith('ui://')) {
      throw new McpAppsConsentV15Error(
        `Policy consent: appUri phải bắt đầu bằng "ui://" — nhận "${policy.appUri}".`,
        'ui-v15-bad-policy-uri',
      );
    }
    const normalized: UiV15AppConsentPolicy = {
      appUri: policy.appUri,
      autoApproveReadOnlyTools: [...new Set(policy.autoApproveReadOnlyTools)],
      deniedTools: [...new Set(policy.deniedTools)],
      alwaysRequireConsentTools: [...new Set(policy.alwaysRequireConsentTools)],
      allowOneShot: policy.allowOneShot,
    };
    this.policies.set(policy.appUri, normalized);
    return normalized;
  }

  getPolicy(appUri: string): UiV15AppConsentPolicy | undefined {
    return this.policies.get(appUri);
  }

  removePolicy(appUri: string): boolean {
    return this.policies.delete(appUri);
  }

  listPolicies(): UiV15AppConsentPolicy[] {
    return [...this.policies.values()].sort((a, b) => a.appUri.localeCompare(b.appUri));
  }

  /** Policy mặc định cho app chưa cấu hình: không auto-approve gì cả. */
  defaultPolicy(appUri: string): UiV15AppConsentPolicy {
    return {
      appUri,
      autoApproveReadOnlyTools: [],
      deniedTools: [],
      alwaysRequireConsentTools: [],
      allowOneShot: true,
    };
  }

  // -- request --------------------------------------------------------------

  /**
   * Xin consent cho một action do UI khởi xướng. Trả request đã tạo
   * (status pending), HOẶC request auto-approved (read-only trong
   * allowlist), HOẶC ném lỗi khi tool bị policy cấm hẳn.
   *
   * Quy tắc:
   *   - tool trong deniedTools → ném (không tạo request, không hiện UI).
   *   - sensitive → luôn pending, không auto-approve.
   *   - read-only + trong autoApproveReadOnlyTools + không nằm trong
   *     alwaysRequireConsentTools → auto-approved ngay.
   *   - còn lại → pending, chờ user quyết.
   */
  requestConsent(input: {
    sessionId: string;
    appUri: string;
    serverName: string;
    toolName: string;
    args?: Record<string, unknown>;
    bridgeRequestId?: string | number;
    ttlMs?: number;
  }): UiV15ConsentRequest {
    const sessionId = asNonEmptyString(input.sessionId);
    const appUri = asNonEmptyString(input.appUri);
    const toolName = asNonEmptyString(input.toolName);
    if (!sessionId || !appUri || !toolName) {
      throw new McpAppsConsentV15Error(
        'requestConsent thiếu sessionId / appUri / toolName.',
        'ui-v15-bad-consent-input',
      );
    }
    if (!appUri.startsWith('ui://')) {
      throw new McpAppsConsentV15Error(
        `appUri phải bắt đầu bằng "ui://" — nhận "${appUri}".`,
        'ui-v15-bad-consent-uri',
      );
    }
    const policy = this.policies.get(appUri) ?? this.defaultPolicy(appUri);
    if (policy.deniedTools.includes(toolName)) {
      throw new McpAppsConsentV15Error(
        `Tool "${toolName}" bị cấm với app ${appUri} theo chính sách consent — không hiện hộp thoại, từ chối ngay.`,
        'ui-v15-tool-denied-by-policy',
      );
    }
    const pendingForApp = [...this.requests.values()].filter(
      (r) => r.appUri === appUri && r.status === 'pending',
    ).length;
    if (pendingForApp >= UI_V15_MAX_PENDING_CONSENTS_PER_APP) {
      throw new McpAppsConsentV15Error(
        `App ${appUri} đã có ${pendingForApp} consent đang chờ (tối đa ${UI_V15_MAX_PENDING_CONSENTS_PER_APP}) — user quyết xong mới xin thêm.`,
        'ui-v15-too-many-pending',
      );
    }
    if (this.pendingCount >= UI_V15_MAX_PENDING_CONSENTS) {
      throw new McpAppsConsentV15Error(
        `Host đã có ${UI_V15_MAX_PENDING_CONSENTS} consent đang chờ — user quyết xong mới xin thêm.`,
        'ui-v15-too-many-pending',
      );
    }
    const classification = classifyToolCallV15(toolName, input.args ?? {});
    const nowMs = this.now();
    const ttlMs = Math.min(
      Math.max(1_000, input.ttlMs ?? this.defaultTtlMs),
      UI_V15_CONSENT_MAX_TTL_MS,
    );
    this.counter += 1;
    const id = `consent-v15-${nowMs}-${this.counter}`;
    const base: UiV15ConsentRequest = {
      id,
      sessionId,
      appUri,
      serverName: input.serverName,
      toolName,
      kind: classification.kind,
      argsSummary: summarizeArgsForConsentV15(input.args ?? {}),
      reason: classification.reason,
      status: 'pending',
      ...(input.bridgeRequestId !== undefined ? { bridgeRequestId: input.bridgeRequestId } : {}),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };
    // Auto-approve: chỉ read-only + allowlist + không bị ép consent.
    const autoOk =
      classification.kind === 'read-only' &&
      policy.autoApproveReadOnlyTools.includes(toolName) &&
      !policy.alwaysRequireConsentTools.includes(toolName);
    if (autoOk) {
      const approved: UiV15ConsentRequest = {
        ...base,
        status: 'approved',
        decidedAtMs: nowMs,
        decidedBy: 'auto',
        decisionNote: `Auto-approve: tool read-only "${toolName}" nằm trong allowlist của app.`,
      };
      this.requests.set(id, approved);
      this.autoApprovedCount += 1;
      this.approvedCount += 1;
      this.appendAudit(approved, 'auto-approved', 'auto');
      return approved;
    }
    this.requests.set(id, base);
    this.appendAudit(base, 'requested');
    return base;
  }

  /** Lấy một consent request theo id (undefined khi không có). */
  get(id: string): UiV15ConsentRequest | undefined {
    return this.requests.get(id);
  }

  /** Liệt kê consent đang chờ (lọc theo app/session khi cần). */
  listPending(filter: { appUri?: string; sessionId?: string } = {}): UiV15ConsentRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.status === 'pending')
      .filter((r) => filter.appUri === undefined || r.appUri === filter.appUri)
      .filter((r) => filter.sessionId === undefined || r.sessionId === filter.sessionId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /** Liệt kê toàn bộ consent (kèm đã quyết) — mới nhất cuối. */
  listAll(filter: { appUri?: string; status?: UiV15ConsentStatus } = {}): UiV15ConsentRequest[] {
    return [...this.requests.values()]
      .filter((r) => filter.appUri === undefined || r.appUri === filter.appUri)
      .filter((r) => filter.status === undefined || r.status === filter.status)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /**
   * User quyết định một consent đang pending. Ném khi: không có
   * request, request đã quyết, hoặc đã hết hạn (gọi expireSweep
   * trước khi decide để trạng thái đúng). Consent đã duyệt chỉ có
   * hiệu lực cho ĐÚNG MỘT lần gọi — bridge phải xoá sau khi dùng.
   */
  decide(id: string, decision: UiV15ConsentDecision, decidedBy: 'user' | 'system' = 'user'): UiV15ConsentRequest {
    const req = this.requests.get(id);
    if (!req) {
      throw new McpAppsConsentV15Error(
        `Consent ${id} không tồn tại.`,
        'ui-v15-consent-not-found',
      );
    }
    if (req.status !== 'pending') {
      throw new McpAppsConsentV15Error(
        `Consent ${id} đã ${req.status} — không quyết lại được.`,
        'ui-v15-consent-already-decided',
      );
    }
    const nowMs = this.now();
    if (nowMs > req.expiresAtMs) {
      req.status = 'expired';
      req.decidedAtMs = nowMs;
      req.decidedBy = 'system';
      req.decisionNote = 'Hết hạn trước khi user quyết.';
      this.expiredCount += 1;
      this.appendAudit(req, 'expired', 'system');
      throw new McpAppsConsentV15Error(
        `Consent ${id} đã hết hạn lúc ${new Date(req.expiresAtMs).toISOString()} — app phải xin lại.`,
        'ui-v15-consent-expired',
      );
    }
    req.status = decision;
    req.decidedAtMs = nowMs;
    req.decidedBy = decidedBy;
    req.decisionNote =
      decision === 'approved'
        ? req.kind === 'sensitive'
          ? 'User duyệt — chỉ có hiệu lực cho đúng một lần gọi này.'
          : 'User duyệt.'
        : 'User từ chối.';
    if (decision === 'approved') this.approvedCount += 1;
    else this.deniedCount += 1;
    this.appendAudit(req, decision, decidedBy);
    return req;
  }

  /** Quét + đánh dấu expired cho consent quá hạn. Trả số đã hết hạn. */
  expireSweep(): number {
    const nowMs = this.now();
    let expired = 0;
    for (const req of this.requests.values()) {
      if (req.status === 'pending' && nowMs > req.expiresAtMs) {
        req.status = 'expired';
        req.decidedAtMs = nowMs;
        req.decidedBy = 'system';
        req.decisionNote = 'Hết hạn trước khi user quyết.';
        this.expiredCount += 1;
        expired += 1;
        this.appendAudit(req, 'expired', 'system');
      }
    }
    return expired;
  }

  /**
   * Kiểm tra một consent đã duyệt có còn dùng được cho một lần gọi
   * không (status approved + chưa hết hạn). Bridge gọi hàm này trước
   * khi thực thi, rồi gọi `consume` để vô hiệu hoá one-shot.
   */
  isUsable(id: string): boolean {
    const req = this.requests.get(id);
    if (!req || req.status !== 'approved') return false;
    return this.now() <= req.expiresAtMs;
  }

  /**
   * Vô hiệu hoá consent sau khi đã dùng cho một lần gọi (one-shot).
   * Consent nhạy cảm BẮT BUỘC consume; consent thường cũng nên
   * consume để không bị dùng lại. Trả false khi không có request.
   */
  consume(id: string): boolean {
    const req = this.requests.get(id);
    if (!req) return false;
    // Đánh dấu đã dùng bằng cách xoá khỏi map đang chờ quyết —
    // audit vẫn giữ bản ghi (appendAudit đã ghi lúc approve).
    return this.requests.delete(id);
  }

  /** Xoá các consent đã quyết xong (giữ lại pending). Trả số đã xoá. */
  pruneDecided(): number {
    let removed = 0;
    for (const [id, req] of [...this.requests]) {
      if (req.status !== 'pending') {
        this.requests.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  // -- audit ----------------------------------------------------------------

  private appendAudit(
    req: UiV15ConsentRequest,
    action: UiV15ConsentAuditEntry['action'],
    decidedBy?: 'user' | 'auto' | 'system',
  ): void {
    this.auditSeq += 1;
    const prevHash = this.lastHash;
    // Lấy now() MỘT lần: hash và atMs lưu phải dùng cùng timestamp,
    // không thì verifyAuditChain tính lại từ atMs sẽ không bao giờ khớp
    // khi đồng hồ thật nhảy 1ms giữa 2 lần gọi.
    const atMs = this.now();
    const hash = simpleHash(
      `${this.auditSeq}|${req.id}|${req.toolName}|${action}|${atMs}|${prevHash}`,
    );
    this.audit.push({
      seq: this.auditSeq,
      atMs,
      consentId: req.id,
      appUri: req.appUri,
      toolName: req.toolName,
      kind: req.kind,
      action,
      ...(decidedBy ? { decidedBy } : {}),
      prevHash,
      hash,
    });
    this.lastHash = hash;
    if (this.audit.length > UI_V15_MAX_CONSENT_AUDIT) {
      this.audit.splice(0, this.audit.length - UI_V15_MAX_CONSENT_AUDIT);
    }
  }

  /** Audit log consent (mới nhất cuối). */
  auditLog(): UiV15ConsentAuditEntry[] {
    return [...this.audit];
  }

  /** Kiểm chứng hash chain của audit: true khi chuỗi còn nguyên vẹn. */
  verifyAuditChain(): { ok: boolean; brokenAtSeq?: number } {
    let prev = 'genesis';
    for (const entry of this.audit) {
      if (entry.prevHash !== prev) return { ok: false, brokenAtSeq: entry.seq };
      const expect = simpleHash(
        `${entry.seq}|${entry.consentId}|${entry.toolName}|${entry.action}|${entry.atMs}|${entry.prevHash}`,
      );
      if (entry.hash !== expect) return { ok: false, brokenAtSeq: entry.seq };
      prev = entry.hash;
    }
    return { ok: true };
  }

  stats(): UiConsentManagerV15Stats {
    return {
      pending: this.pendingCount,
      approved: this.approvedCount,
      denied: this.deniedCount,
      expired: this.expiredCount,
      autoApproved: this.autoApprovedCount,
      auditEntries: this.audit.length,
      policies: this.policies.size,
    };
  }
}

/** Hash FNV-1a 32-bit (hex) — đủ cho audit chain nhẹ trong bộ nhớ. */
export function simpleHashV15(text: string): string {
  return simpleHash(text);
}

function simpleHash(text: string): string {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
