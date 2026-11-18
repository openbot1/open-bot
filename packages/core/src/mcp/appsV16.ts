/**
 * MCP Apps v16 — MCP 2026-07-28, extension `io.modelcontextprotocol/ui`
 * (v1.36, Đội T3).
 *
 * Sóng trước đã có host Apps đầy đủ (v15: manifest validate, bridge
 * postMessage, consent, visualiser, skill). V16 xây pipeline khai
 * báo-trước mà spec MCP 2026-07-28 yêu cầu cho Apps ổn định: tool
 * phải khai báo UI template TRƯỚC để host prefetch / cache /
 * security-review trước khi render, thay vì render HTML tới đâu mới
 * kiểm tra tới đó:
 *
 *   1. Template pre-declaration: manifest v15 được validate rồi lưu
 *      ở trạng thái `declared`; HTML chỉ được prefetch sau khi đã
 *      declare; security review (approve/reject + ghi chú) là bước
 *      bắt buộc trước khi mở — app chưa review thì host chỉ render
 *      text fallback.
 *   2. Integrity: HTML prefetch được hash sha256; khi mở, host kiểm
 *      tra lại hash — HTML bị đổi sau prefetch thì từ chối mở.
 *   3. Sandbox policy builder v16: từ sandbox profile + CSP profile
 *      của manifest sinh ra iframe `sandbox` attribute và header
 *      Content-Security-Policy cụ thể; profile `privileged` cần
 *      review phê duyệt tường minh (không tự động).
 *   4. Extension gate: mở app yêu cầu extension Apps đã được
 *      thương lượng bật (mặc định tắt — xem `extensionsV16.ts`);
 *      chưa negotiate thì mở bị chặn với lỗi rõ ràng.
 *   5. Display-mode negotiation: client xin inline/fullscreen/pip,
 *      host chốt theo khả năng + profile (display-only không được
 *      fullscreen tương tác); text-only luôn là fallback cuối.
 *   6. Cache có giới hạn: tối đa số template + tổng bytes; vượt thì
 *      evict template ít dùng nhất (LRU).
 *
 * Module này không render HTML, không chạm mạng: coordinator nối
 * fetcher HTML thật vào. Ideas only — không copy code/text/tài sản
 * của bất kỳ repo nào, của xAI/Cursor.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  UI_V15_CSP_PROFILES,
  UI_V15_SANDBOX_PROFILES,
  validateAppManifestV15,
  type AppManifestV15,
  type UiV15CspProfile,
  type UiV15SandboxProfile,
} from './appsUiV15';
import {
  EXTENSION_APPS_ID,
  requireExtension,
  type ExtensionNegotiationResult,
} from './extensionsV16';

/** HTML tối đa cho một template prefetch (512 KiB). */
export const APPS_V16_MAX_TEMPLATE_BYTES = 512 * 1024;

/** Số template tối đa trong cache (mặc định 50). */
export const APPS_V16_MAX_TEMPLATES = 50;

/** Tổng bytes tối đa trong cache (mặc định 8 MiB). */
export const APPS_V16_MAX_CACHE_BYTES = 8 * 1024 * 1024;

/** Lỗi Apps v16. */
export class AppsV16Error extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'AppsV16Error';
    if (code) this.code = code;
  }
}

/** Display mode host v16 hỗ trợ. */
export type AppsV16DisplayMode = 'inline' | 'fullscreen' | 'pip' | 'text-only';

/** Trạng thái pipeline của một template đã khai báo. */
export type AppsV16TemplateStatus =
  | 'declared'
  | 'prefetched'
  | 'review-approved'
  | 'review-rejected'
  | 'ready';

/** Kết quả security review của một template. */
export interface AppsV16Review {
  decision: 'approved' | 'rejected';
  reviewer: string;
  note?: string;
  atMs: number;
}

/** Một template app trong pipeline v16. */
export interface AppsV16Template {
  manifest: AppManifestV15;
  status: AppsV16TemplateStatus;
  /** sha256 hex của HTML đã prefetch (khi có). */
  htmlSha256?: string;
  /** Số byte HTML đã prefetch. */
  htmlBytes?: number;
  review?: AppsV16Review;
  declaredAtMs: number;
  lastUsedAtMs: number;
  openCount: number;
}

/** Sandbox policy sinh ra cho một iframe app. */
export interface AppsV16SandboxPolicy {
  /** Giá trị attribute `sandbox` của iframe. */
  sandboxAttribute: string;
  /** Header Content-Security-Policy đầy đủ. */
  cspHeader: string;
  /** Profile đã dùng. */
  sandboxProfile: UiV15SandboxProfile;
  cspProfile: UiV15CspProfile;
  /** Cảnh báo (vd privileged cần review tường minh). */
  warnings: string[];
}

/** Một phiên app đang mở. */
export interface AppsV16Session {
  id: string;
  appName: string;
  server: string;
  displayMode: AppsV16DisplayMode;
  sandboxPolicy: AppsV16SandboxPolicy;
  /** sha256 của HTML đang render (để client đối chiếu). */
  htmlSha256: string;
  openedAtMs: number;
}

/** Tuỳ chọn cho AppsHostV16. */
export interface AppsHostV16Options {
  maxTemplates?: number;
  maxCacheBytes?: number;
  now?: () => number;
}

/** SHA-256 hex của một chuỗi UTF-8. */
export function sha256HexV16(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Dựng sandbox policy v16 từ profile của manifest.
 *
 *   - display-only: sandbox rỗng + CSP strict nhất (không script).
 *   - interactive: cho script + same-origin để app tương tác, CSP
 *     strict (không connect ra ngoài).
 *   - privileged: như interactive + CSP media/network theo cspProfile;
 *     luôn kèm cảnh báo — chỉ host review tường minh mới được mở.
 */
export function buildSandboxPolicyV16(
  sandboxProfile: UiV15SandboxProfile,
  cspProfile: UiV15CspProfile,
): AppsV16SandboxPolicy {
  if (!UI_V15_SANDBOX_PROFILES.includes(sandboxProfile)) {
    throw new AppsV16Error(`Sandbox profile không rõ: "${sandboxProfile}".`, 'bad-sandbox-profile');
  }
  if (!UI_V15_CSP_PROFILES.includes(cspProfile)) {
    throw new AppsV16Error(`CSP profile không rõ: "${cspProfile}".`, 'bad-csp-profile');
  }
  const warnings: string[] = [];
  let sandboxAttribute = '';
  let cspHeader = '';
  if (sandboxProfile === 'display-only') {
    sandboxAttribute = '';
    cspHeader = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;";
  } else if (sandboxProfile === 'interactive') {
    sandboxAttribute = 'allow-scripts allow-same-origin';
    cspHeader = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:;";
  } else {
    sandboxAttribute = 'allow-scripts allow-same-origin allow-forms allow-popups';
    warnings.push('Profile privileged xin quyền mở rộng (forms/popups) — cần security review tường minh.');
    if (cspProfile === 'network') {
      cspHeader = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src https:; font-src data:;";
      warnings.push('CSP network cho phép app kết nối ra ngoài (https) — chỉ dùng cho app đã review kỹ.');
    } else if (cspProfile === 'media') {
      cspHeader = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; media-src https: data:; font-src data:;";
    } else {
      cspHeader = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:;";
    }
  }
  return { sandboxAttribute, cspHeader, sandboxProfile, cspProfile, warnings };
}

/**
 * Thương lượng display mode: client xin một mode, host chốt theo
 * profile + khả năng. display-only không được fullscreen tương tác
 * (chỉ inline hoặc text-only); mode lạ → text-only. Trả về mode đã
 * chốt + lý do khi bị hạ cấp.
 */
export function negotiateDisplayModeV16(
  requested: string | undefined,
  sandboxProfile: UiV15SandboxProfile,
  hostSupports: AppsV16DisplayMode[] = ['inline', 'fullscreen', 'pip', 'text-only'],
): { mode: AppsV16DisplayMode; downgraded: boolean; reason?: string } {
  const want = (requested ?? 'inline') as AppsV16DisplayMode;
  if (want === 'text-only' || !hostSupports.includes(want)) {
    return {
      mode: 'text-only',
      downgraded: want !== 'text-only',
      reason:
        want === 'text-only'
          ? 'Client xin text-only.'
          : `Host không hỗ trợ display mode "${requested}".`,
    };
  }
  if (sandboxProfile === 'display-only' && want === 'fullscreen') {
    return {
      mode: 'inline',
      downgraded: true,
      reason: 'App display-only không được mở fullscreen tương tác — hạ xuống inline.',
    };
  }
  return { mode: want, downgraded: false };
}

/**
 * Host Apps v16: pipeline declare → prefetch → review → open,
 * cache LRU có giới hạn, session đang mở.
 */
export class AppsHostV16 {
  private readonly templates = new Map<string, AppsV16Template>();
  private readonly sessions = new Map<string, AppsV16Session>();
  private readonly maxTemplates: number;
  private readonly maxCacheBytes: number;
  private readonly now: () => number;

  constructor(options: AppsHostV16Options = {}) {
    this.maxTemplates = options.maxTemplates ?? APPS_V16_MAX_TEMPLATES;
    this.maxCacheBytes = options.maxCacheBytes ?? APPS_V16_MAX_CACHE_BYTES;
    this.now = options.now ?? Date.now;
  }

  /** Số template đang giữ. */
  templateCount(): number {
    return this.templates.size;
  }

  /** Số session đang mở. */
  openSessionCount(): number {
    return this.sessions.size;
  }

  /** Tổng bytes HTML đã cache. */
  cachedBytes(): number {
    let total = 0;
    for (const template of this.templates.values()) total += template.htmlBytes ?? 0;
    return total;
  }

  /**
   * Khai báo UI template trước (bước 1): validate manifest v15 rồi
   * lưu ở trạng thái declared. Khai báo lại cùng tên + version thì
   * ghi đè (template mới nhất thắng); khác version thì phải dùng
   * tên khác hoặc gỡ trước.
   */
  declareTemplate(manifestInput: unknown): AppsV16Template {
    const { manifest, warnings } = validateAppManifestV15(manifestInput);
    void warnings;
    const existing = this.templates.get(manifest.name);
    if (existing && existing.manifest.version !== manifest.version) {
      throw new AppsV16Error(
        `App "${manifest.name}" đã khai báo version ${existing.manifest.version}, muốn đổi sang ${manifest.version} thì gỡ template cũ trước.`,
        'version-conflict',
      );
    }
    const nowMs = this.now();
    const template: AppsV16Template = {
      manifest,
      status: 'declared',
      declaredAtMs: nowMs,
      lastUsedAtMs: nowMs,
      openCount: 0,
    };
    this.templates.set(manifest.name, template);
    return this.copyTemplate(template);
  }

  /** Gỡ một template đã khai báo (kèm session đang mở của nó). */
  removeTemplate(name: string): boolean {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.appName === name) this.sessions.delete(sessionId);
    }
    return this.templates.delete(name);
  }

  /** Lấy một template (bản sao), hoặc undefined. */
  getTemplate(name: string): AppsV16Template | undefined {
    const template = this.templates.get(name);
    return template ? this.copyTemplate(template) : undefined;
  }

  /**
   * Prefetch HTML cho template đã declare (bước 2): lưu HTML +
   * sha256, trạng thái → prefetched. HTML quá lớn thì từ chối.
   * Prefetch lại sau khi đã review thì reset review (HTML mới phải
   * review lại).
   */
  prefetchTemplate(name: string, html: string): AppsV16Template {
    const template = this.templates.get(name);
    if (!template) {
      throw new AppsV16Error(`Chưa khai báo template "${name}" — phải declare trước khi prefetch.`, 'not-declared');
    }
    const bytes = new TextEncoder().encode(html).length;
    if (bytes > APPS_V16_MAX_TEMPLATE_BYTES) {
      throw new AppsV16Error(
        `HTML template "${name}" dài ${bytes} bytes, vượt giới hạn ${APPS_V16_MAX_TEMPLATE_BYTES}.`,
        'template-too-large',
      );
    }
    if (/<script[^>]*src\s*=\s*["']https?:/i.test(html)) {
      throw new AppsV16Error(
        `HTML template "${name}" load script từ URL ngoài — bị cấm (chỉ inline script).`,
        'external-script',
      );
    }
    template.htmlSha256 = sha256HexV16(html);
    template.htmlBytes = bytes;
    template.status = 'prefetched';
    template.review = undefined;
    template.lastUsedAtMs = this.now();
    this.evictIfNeeded(name);
    return this.copyTemplate(template);
  }

  /**
   * Security review template đã prefetch (bước 3): approve →
   * ready, reject → review-rejected (không mở được cho tới khi
   * prefetch lại + review lại).
   */
  reviewTemplate(
    name: string,
    decision: 'approved' | 'rejected',
    reviewer: string,
    note?: string,
  ): AppsV16Template {
    const template = this.templates.get(name);
    if (!template) {
      throw new AppsV16Error(`Chưa khai báo template "${name}".`, 'not-declared');
    }
    if (template.status !== 'prefetched' && template.status !== 'review-rejected') {
      throw new AppsV16Error(
        `Template "${name}" đang ở trạng thái ${template.status} — chỉ review được template đã prefetch.`,
        'not-prefetched',
      );
    }
    if (typeof reviewer !== 'string' || reviewer.length === 0) {
      throw new AppsV16Error('Review cần tên reviewer.', 'missing-reviewer');
    }
    template.review = { decision, reviewer, ...(note ? { note } : {}), atMs: this.now() };
    template.status = decision === 'approved' ? 'ready' : 'review-rejected';
    template.lastUsedAtMs = this.now();
    return this.copyTemplate(template);
  }

  /**
   * Mở app (bước 4): yêu cầu extension Apps đã negotiate bật,
   * template ở trạng thái ready, HTML khớp hash đã prefetch.
   * `html` là HTML thực tế host sẽ render — host hash lại và so
   * với hash lúc prefetch; khác nhau thì từ chối (HTML bị đổi sau
   * prefetch/review).
   */
  openApp(input: {
    name: string;
    html: string;
    negotiation: ExtensionNegotiationResult;
    requestedDisplayMode?: string;
    hostSupports?: AppsV16DisplayMode[];
  }): AppsV16Session {
    requireExtension(input.negotiation, EXTENSION_APPS_ID, `mở app "${input.name}"`);
    const template = this.templates.get(input.name);
    if (!template) {
      throw new AppsV16Error(`Chưa khai báo template "${input.name}".`, 'not-declared');
    }
    if (template.status !== 'ready') {
      throw new AppsV16Error(
        `Template "${input.name}" chưa sẵn sàng mở (trạng thái ${template.status}) — cần declare → prefetch → review approve.`,
        'not-ready',
      );
    }
    const htmlHash = sha256HexV16(input.html);
    if (htmlHash !== template.htmlSha256) {
      throw new AppsV16Error(
        `HTML app "${input.name}" không khớp hash lúc prefetch — có thể đã bị đổi sau review, từ chối mở.`,
        'integrity-mismatch',
      );
    }
    const policy = buildSandboxPolicyV16(
      template.manifest.sandboxProfile,
      template.manifest.cspProfile,
    );
    if (template.manifest.sandboxProfile === 'privileged') {
      const note = (template.review?.note ?? '').toLowerCase();
      if (!note.includes('privileged')) {
        throw new AppsV16Error(
          `App "${input.name}" dùng profile privileged — review phải ghi chú tường minh "privileged" mới được mở.`,
          'privileged-needs-explicit-review',
        );
      }
    }
    const negotiated = negotiateDisplayModeV16(
      input.requestedDisplayMode,
      template.manifest.sandboxProfile,
      input.hostSupports,
    );
    const session: AppsV16Session = {
      id: randomUUID(),
      appName: input.name,
      server: template.manifest.server,
      displayMode: negotiated.mode,
      sandboxPolicy: policy,
      htmlSha256: htmlHash,
      openedAtMs: this.now(),
    };
    this.sessions.set(session.id, session);
    template.openCount += 1;
    template.lastUsedAtMs = this.now();
    return { ...session, sandboxPolicy: { ...policy, warnings: [...policy.warnings] } };
  }

  /** Đóng một session đang mở. */
  closeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Lấy session đang mở (bản sao), hoặc undefined. */
  getSession(sessionId: string): AppsV16Session | undefined {
    const session = this.sessions.get(sessionId);
    return session
      ? { ...session, sandboxPolicy: { ...session.sandboxPolicy, warnings: [...session.sandboxPolicy.warnings] } }
      : undefined;
  }

  /** Liệt kê template theo trạng thái (để UI gallery / audit). */
  listTemplates(status?: AppsV16TemplateStatus): AppsV16Template[] {
    return [...this.templates.values()]
      .filter((t) => !status || t.status === status)
      .map((t) => this.copyTemplate(t));
  }

  /** Liệt kê session đang mở (bản sao). */
  listSessions(): AppsV16Session[] {
    return [...this.sessions.values()].map((s) => this.copySession(s));
  }

  /** Thống kê nhanh cho UI / tool list (số template theo trạng thái, session, bytes). */
  stats(): {
    templates: number;
    byStatus: Record<AppsV16TemplateStatus, number>;
    openSessions: number;
    cachedBytes: number;
  } {
    const byStatus: Record<AppsV16TemplateStatus, number> = {
      declared: 0,
      prefetched: 0,
      'review-approved': 0,
      'review-rejected': 0,
      ready: 0,
    };
    for (const template of this.templates.values()) {
      byStatus[template.status] += 1;
    }
    return {
      templates: this.templates.size,
      byStatus,
      openSessions: this.sessions.size,
      cachedBytes: this.cachedBytes(),
    };
  }

  private copySession(session: AppsV16Session): AppsV16Session {
    return {
      ...session,
      sandboxPolicy: { ...session.sandboxPolicy, warnings: [...session.sandboxPolicy.warnings] },
    };
  }

  private copyTemplate(template: AppsV16Template): AppsV16Template {
    return {
      manifest: { ...template.manifest, capabilities: [...template.manifest.capabilities] },
      status: template.status,
      ...(template.htmlSha256 ? { htmlSha256: template.htmlSha256 } : {}),
      ...(template.htmlBytes !== undefined ? { htmlBytes: template.htmlBytes } : {}),
      ...(template.review ? { review: { ...template.review } } : {}),
      declaredAtMs: template.declaredAtMs,
      lastUsedAtMs: template.lastUsedAtMs,
      openCount: template.openCount,
    };
  }

  /** Evict LRU khi vượt giới hạn số lượng hoặc tổng bytes. */
  private evictIfNeeded(keepName: string): void {
    while (
      this.templates.size > this.maxTemplates ||
      this.cachedBytes() > this.maxCacheBytes
    ) {
      const candidates = [...this.templates.values()]
        .filter((t) => t.manifest.name !== keepName)
        .sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs);
      const victim = candidates[0];
      if (!victim) break;
      this.templates.delete(victim.manifest.name);
    }
  }
}
