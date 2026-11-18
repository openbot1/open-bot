/**
 * MCP Apps host v14 — iframe sandbox + CSP nghiêm + allow-list +
 * panel xem trước app + audit log (SEP-1865 stable 2026-01-26,
 * ideas only — không copy code/text/tài sản của bất kỳ repo nào).
 *
 * Mô hình bảo mật của v14:
 *
 *   - Iframe CHỈ có `sandbox="allow-scripts"`: app được chạy
 *     script của chính nó, nhưng KHÔNG `allow-same-origin` (nên
 *     origin luôn mờ `"null"`), KHÔNG `allow-top-navigation`,
 *     KHÔNG `allow-popups`, KHÔNG `allow-forms` (form submit qua
 *     bridge `tools/call`, không POST đi đâu), KHÔNG truy cập
 *     parent DOM — thoát sandbox là bị chặn ở cả 2 lớp.
 *   - CSP nghiêm nhúng vào srcdoc: `default-src 'none'` rồi mở
 *     từng directive theo allow-list host cấu hình. Mặc định:
 *     không host ngoài nào, không kết nối mạng, không frame con,
 *     không form-action, không base-uri.
 *   - Chỉ cho HTML document ở v1: app phải là tài liệu HTML đầy
 *     đủ (`<!doctype html><html>…`), KHÔNG được nhúng website
 *     ngoài (`<iframe src="https://…">`, `<embed>`, `<object>`).
 *     Host không review được website ngoài nên từ chối thẳng.
 *   - Quét thoát sandbox: HTML chứa pattern truy cập parent/top,
 *     storage, service worker, `eval`, `postMessage('*')`, form
 *     POST ra ngoài… thì bị chặn trước khi render, kèm lý do.
 *   - Panel xem trước: liệt kê app đã đăng ký, build frame config
 *     sandbox cho từng app, hiện audit log các action từ UI và
 *     consent đang chờ — để user review trước khi cho app chạy.
 *
 * Module thuần (không DOM, không network): panel trả object để
 * renderer mount iframe thật.
 */

import { validateAppHtml, type AppFrameConfig } from './apps';
import type { McpAppsUiRegistryV14, ToolUiSnapshotV14 } from './appsUiV14';
import type { UiBridgeHostV14, UiV14ActionLogEntry, UiV14ConsentRequest } from './appsBridgeV14';
import { MCP_APPS_V14_VERSION } from './appsUiV14';

/** Giá trị thuộc tính sandbox của iframe v14 — CHỈ allow-scripts. */
export const UI_V14_IFRAME_SANDBOX = 'allow-scripts';
/** Kích thước HTML tối đa cho một app preview (bytes). */
export const UI_V14_PREVIEW_MAX_HTML_BYTES = 2 * 1024 * 1024;

/** Allow-list host cho từng loại tài nguyên trong CSP. */
export interface V14SandboxAllowList {
  /** Host được load script (`script-src`), vd ['cdn.example.com']. */
  scriptHosts?: string[];
  /** Host được load stylesheet (`style-src`). */
  styleHosts?: string[];
  /** Host được load ảnh (`img-src`). */
  imageHosts?: string[];
  /** Host được load media (`media-src`). */
  mediaHosts?: string[];
  /** Host được load font (`font-src`). */
  fontHosts?: string[];
  /** Host được kết nối (fetch/XHR/`connect-src`) — mặc định cấm hết. */
  connectHosts?: string[];
}

export class McpAppsPreviewV14Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpAppsPreviewV14Error';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate một hostname trong allow-list: tên miền thường hoặc
 * `*.example.com`. Từ chối scheme, path, port, wildcard `*` trần,
 * khoảng trắng và ký tự lạ.
 */
export function isValidAllowListHost(host: unknown): boolean {
  if (typeof host !== 'string' || host.trim() === '' || host.length > 253) return false;
  const value = host.trim().toLowerCase();
  if (value === '*' || value.includes('/') || value.includes(':') || /\s/.test(value)) return false;
  const bare = value.startsWith('*.') ? value.slice(2) : value;
  if (bare === '' || bare.startsWith('.') || bare.endsWith('.') || bare.includes('..')) return false;
  if (!/^[a-z0-9.-]+$/.test(bare)) return false;
  return bare.split('.').every((part) => part.length > 0 && part.length <= 63);
}

/**
 * Validate toàn bộ allow-list. Ném `McpAppsPreviewV14Error` khi có
 * host sai — allow-list sai không được lặng lẽ bỏ qua (fail-closed).
 */
export function validateSandboxAllowList(allowList: V14SandboxAllowList): V14SandboxAllowList {
  const out: V14SandboxAllowList = {};
  const fields = [
    'scriptHosts',
    'styleHosts',
    'imageHosts',
    'mediaHosts',
    'fontHosts',
    'connectHosts',
  ] as const;
  for (const field of fields) {
    const hosts = allowList[field];
    if (hosts === undefined) continue;
    if (!Array.isArray(hosts) || hosts.some((h) => typeof h !== 'string')) {
      throw new McpAppsPreviewV14Error(
        `Allow-list ${field} phải là mảng chuỗi hostname.`,
        'ui-v14-bad-allow-list',
      );
    }
    for (const host of hosts) {
      if (!isValidAllowListHost(host)) {
        throw new McpAppsPreviewV14Error(
          `Hostname không hợp lệ trong allow-list ${field}: "${host}".`,
          'ui-v14-bad-allow-list',
        );
      }
    }
    const deduped = [...new Set(hosts.map((h) => h.trim().toLowerCase()))].sort();
    if (deduped.length > 0) out[field] = deduped;
  }
  return out;
}

/**
 * Build chuỗi CSP nghiêm cho app v14 từ allow-list.
 * Mặc định (không allow-list): không script ngoài, không style
 * ngoài, không ảnh ngoài (trừ `data:`), không kết nối, không frame,
 * không form, không base. Script inline của chính app vẫn chạy
 * (cần `'unsafe-inline'` vì app là srcdoc tự chứa — sandbox
 * `allow-scripts` không có `allow-same-origin` vẫn chặn app chạm
 * parent nên inline script không mở đường thoát).
 */
export function buildStrictCspV14(allowList: V14SandboxAllowList = {}): string {
  const allowed = validateSandboxAllowList(allowList);
  const hosts = (list: string[] | undefined): string =>
    (list ?? []).map((h) => `https://${h}`).join(' ');
  const directives: string[] = [
    "default-src 'none'",
    `script-src 'unsafe-inline'${hosts(allowed.scriptHosts) ? ` ${hosts(allowed.scriptHosts)}` : ''}`,
    `style-src 'unsafe-inline'${hosts(allowed.styleHosts) ? ` ${hosts(allowed.styleHosts)}` : ''}`,
    `img-src data:${hosts(allowed.imageHosts) ? ` ${hosts(allowed.imageHosts)}` : ''}`,
    `media-src${hosts(allowed.mediaHosts) ? ` ${hosts(allowed.mediaHosts)}` : ''}`,
    `font-src data:${hosts(allowed.fontHosts) ? ` ${hosts(allowed.fontHosts)}` : ''}`,
    `connect-src${hosts(allowed.connectHosts) ? ` ${hosts(allowed.connectHosts)}` : " 'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "worker-src 'none'",
  ];
  return directives.join('; ');
}

/** Một phát hiện quét thoát sandbox trong HTML. */
export interface SandboxEscapeFinding {
  /** Mức độ: blocking = từ chối render, warning = ghi log, vẫn render. */
  severity: 'blocking' | 'warning';
  /** Mã ổn định cho test + i18n. */
  code: string;
  message: string;
}

/** Các pattern truy cập/chiếm quyền ngoài sandbox (quét theo regex). */
const SANDBOX_ESCAPE_PATTERNS: { code: string; pattern: RegExp; message: string; severity: 'blocking' | 'warning' }[] = [
  {
    code: 'escape-parent-access',
    pattern: /\b(window\s*\.\s*parent|window\s*\.\s*top|parent\s*\.\s*document|top\s*\.\s*document|parent\s*\.\s*location|top\s*\.\s*location)\b/,
    message: 'HTML truy cập parent/top (window.parent, top.location, …) — thoát sandbox.',
    severity: 'blocking',
  },
  {
    code: 'escape-top-navigation',
    pattern: /target\s*=\s*["']_top["']|target\s*=\s*["']_parent["']/i,
    message: 'Link/form target _top/_parent — điều hướng cửa sổ chính.',
    severity: 'blocking',
  },
  {
    code: 'escape-same-origin',
    pattern: /allow-same-origin/i,
    message: 'HTML tự khai sandbox allow-same-origin — host không cho phép.',
    severity: 'blocking',
  },
  {
    code: 'escape-postmessage-star',
    pattern: /postMessage\s*\([^,]+,\s*['"]\*['"]\s*\)/,
    message: "postMessage với targetOrigin '*' — gửi dữ liệu cho bất kỳ origin nào.",
    severity: 'blocking',
  },
  {
    code: 'escape-eval',
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    message: 'Dùng eval()/new Function() — thực thi code động, khó review.',
    severity: 'blocking',
  },
  {
    code: 'escape-storage',
    pattern: /\b(localStorage|sessionStorage|indexedDB)\b/,
    message: 'Truy cập storage (localStorage/sessionStorage/indexedDB) — app iframe sandbox không được lưu trữ.',
    severity: 'blocking',
  },
  {
    code: 'escape-service-worker',
    pattern: /serviceWorker|navigator\s*\.\s*register/i,
    message: 'Đăng ký service worker — chạy code nền ngoài vòng đời app.',
    severity: 'blocking',
  },
  {
    code: 'escape-external-form',
    pattern: /<form[^>]*\baction\s*=\s*["']https?:\/\//i,
    message: 'Form POST ra URL ngoài — dữ liệu thoát khỏi host.',
    severity: 'blocking',
  },
  {
    code: 'escape-document-domain',
    pattern: /document\s*\.\s*domain\s*=/,
    message: 'Gán document.domain — nới lỏng same-origin policy.',
    severity: 'blocking',
  },
  {
    code: 'escape-external-frame',
    pattern: /<(iframe|embed|object)[^>]*\bsrc\s*=\s*["']https?:\/\//i,
    message: 'Nhúng website/frame ngoài — v1 chỉ cho HTML document tự chứa.',
    severity: 'blocking',
  },
  {
    code: 'warn-cookie-access',
    pattern: /\bdocument\s*\.\s*cookie\b/,
    message: 'Truy cập document.cookie (trong sandbox srcdoc cookie vốn đã bị chặn, ghi warning để review).',
    severity: 'warning',
  },
  {
    code: 'warn-window-open',
    pattern: /\bwindow\s*\.\s*open\s*\(/,
    message: 'Gọi window.open() — popup bị sandbox chặn, ghi warning để review.',
    severity: 'warning',
  },
];

/**
 * Quét HTML tìm dấu hiệu thoát sandbox. Trả danh sách finding
 * (rỗng = sạch). Chỉ quét text — không thực thi HTML.
 */
export function detectSandboxEscapeAttempts(html: string): SandboxEscapeFinding[] {
  const findings: SandboxEscapeFinding[] = [];
  for (const rule of SANDBOX_ESCAPE_PATTERNS) {
    if (rule.pattern.test(html)) {
      findings.push({ severity: rule.severity, code: rule.code, message: rule.message });
    }
  }
  return findings;
}

/** Kết quả validate HTML document của app v14. */
export interface V14HtmlValidation {
  valid: boolean;
  /** true khi HTML là tài liệu đầy đủ (doctype + <html>). */
  isFullDocument: boolean;
  findings: SandboxEscapeFinding[];
  /** Lý do chặn đầu tiên (khi valid=false). */
  blockedReason?: string;
}

/**
 * Validate HTML document cho v14:
 *   1. Phải là tài liệu HTML đầy đủ (doctype + `<html>`) — đoạn
 *      HTML lẻ và website ngoài đều bị từ chối ở v1.
 *   2. Không nhúng frame/website ngoài.
 *   3. Quét thoát sandbox (blocking → từ chối).
 *   4. Chạy tiếp `validateAppHtml` của v0.98 (script/style/host
 *      ngoài, storage, parent access…) — mọi finding blocking của
 *      nó cũng chặn ở đây.
 */
export function validateHtmlDocumentV14(
  html: string,
  options: { allowedHosts?: string[] } = {},
): V14HtmlValidation {
  const findings: SandboxEscapeFinding[] = [];
  const isFullDocument = /<!doctype html>/i.test(html) && /<html[\s>]/i.test(html);
  if (!isFullDocument) {
    return {
      valid: false,
      isFullDocument,
      findings: [
        {
          severity: 'blocking',
          code: 'not-full-document',
          message: 'App v14 phải là HTML document đầy đủ (<!doctype html><html>…) — v1 không nhận đoạn HTML lẻ hay website nhúng ngoài.',
        },
      ],
      blockedReason: 'App phải là HTML document đầy đủ.',
    };
  }
  for (const finding of detectSandboxEscapeAttempts(html)) {
    findings.push(finding);
  }
  const base = validateAppHtml(html, { allowedHosts: options.allowedHosts ?? [] });
  if (!base.valid) {
    for (const f of base.findings) {
      if (f.severity === 'blocking') {
        findings.push({
          severity: 'blocking',
          code: f.code ?? 'app-invalid',
          message: f.message,
        });
      }
    }
  }
  const blocking = findings.find((f) => f.severity === 'blocking');
  return {
    valid: blocking === undefined,
    isFullDocument,
    findings,
    ...(blocking ? { blockedReason: blocking.message } : {}),
  };
}

/** Frame config v14 cho renderer mount iframe. */
export interface V14FrameConfig extends AppFrameConfig {
  /** URI ui:// của app. */
  uri: string;
  /** CSP nghiêm đã áp (để panel/debug hiện). */
  strictCsp: string;
  /** Allow-list đã chuẩn hoá áp cho app này. */
  allowList: V14SandboxAllowList;
  /** Origin kỳ vọng cho postMessage (thường là "null" với srcdoc). */
  expectedOrigin: string;
}

/**
 * Build frame config v14 từ HTML đã validate: chèn CSP nghiêm +
 * title vào `<head>`, trả srcdoc để renderer gán vào iframe với
 * `sandbox="allow-scripts"`. Ném lỗi khi HTML chưa qua validate.
 */
export function buildV14FrameConfig(
  app: { uri: string; title: string; html: string },
  allowList: V14SandboxAllowList = {},
): V14FrameConfig {
  const validation = validateHtmlDocumentV14(app.html, {
    allowedHosts: [
      ...(allowList.scriptHosts ?? []),
      ...(allowList.styleHosts ?? []),
      ...(allowList.imageHosts ?? []),
      ...(allowList.mediaHosts ?? []),
      ...(allowList.fontHosts ?? []),
      ...(allowList.connectHosts ?? []),
    ],
  });
  if (!validation.valid) {
    throw new McpAppsPreviewV14Error(
      `App ${app.uri} bị chặn: ${validation.blockedReason ?? 'validation failed.'}`,
      'ui-v14-preview-blocked',
    );
  }
  const strictCsp = buildStrictCspV14(allowList);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(strictCsp)}">`;
  const title = `<title>${escapeHtml(app.title || 'MCP App')}</title>`;
  let srcdoc: string;
  if (/<head[\s>]/i.test(app.html)) {
    srcdoc = app.html.replace(/<head[\s>]/i, (m) => `${m}${meta}${title}`);
  } else {
    srcdoc = app.html.replace(/<html[\s>]/i, (m) => `${m}<head>${meta}${title}</head>`);
  }
  return {
    sandbox: UI_V14_IFRAME_SANDBOX,
    csp: strictCsp,
    srcdoc,
    uri: app.uri,
    strictCsp,
    allowList: validateSandboxAllowList(allowList),
    expectedOrigin: 'null',
  };
}

// ---------------------------------------------------------------------------
// Panel xem trước app + audit log
// ---------------------------------------------------------------------------

/** Một app trong panel xem trước (không kèm HTML). */
export interface V14AppPreview {
  uri: string;
  serverName: string;
  toolName?: string;
  title: string;
  mimeType: string;
  version: number;
  sizeBytes: number;
  hits: number;
  updatedAtMs: number;
  /** Tool nào khai báo UI cho app này (nếu có). */
  declaredByTool?: string;
  /** App có text fallback cho tool của nó không. */
  hasTextFallback: boolean;
  /** Frame config sandbox sẵn sàng mount (chỉ khi preview). */
  frameConfig?: V14FrameConfig;
  /** Số action từ UI đã audit cho app này. */
  auditActionCount: number;
  /** Số consent đang chờ cho app này. */
  pendingConsents: number;
}

export interface McpAppsPreviewPanelV14Options {
  now?: () => number;
  registry: McpAppsUiRegistryV14;
  bridge?: UiBridgeHostV14;
  /** Giới hạn số app panel liệt kê một lần (mặc định 100). */
  maxListed?: number;
}

/**
 * Panel xem trước app v14 — model cho UI "MCP Apps" trong renderer:
 * liệt kê app đã đăng ký (kèm trạng thái khai báo/fallback),
 * build preview sandbox cho từng app, hiện audit log + consent
 * đang chờ. Không chạm DOM — renderer tự mount frameConfig.
 */
export class McpAppsPreviewPanelV14 {
  private readonly now: () => number;
  private readonly registry: McpAppsUiRegistryV14;
  private readonly bridge?: UiBridgeHostV14;
  private readonly maxListed: number;

  constructor(options: McpAppsPreviewPanelV14Options) {
    this.now = options.now ?? Date.now;
    this.registry = options.registry;
    this.bridge = options.bridge;
    this.maxListed = Math.max(1, options.maxListed ?? 100);
  }

  /** Danh sách app đã đăng ký để panel hiển thị. */
  listPreviews(filter: { serverName?: string; toolName?: string } = {}): V14AppPreview[] {
    const resources = this.registry.listResources(filter);
    const uiTools = this.registry.listUiTools();
    const byUri = new Map<string, ToolUiSnapshotV14>();
    for (const t of uiTools) byUri.set(t.resourceUri, t);
    const actions = this.bridge?.listActions({ limit: 500 }) ?? [];
    const actionCount = new Map<string, number>();
    for (const a of actions) {
      actionCount.set(a.appUri, (actionCount.get(a.appUri) ?? 0) + 1);
    }
    const pending = this.bridge?.listPendingConsents() ?? [];
    const pendingCount = new Map<string, number>();
    for (const c of pending) {
      pendingCount.set(c.appUri, (pendingCount.get(c.appUri) ?? 0) + 1);
    }
    return resources.slice(0, this.maxListed).map((r) => {
      const declared = byUri.get(r.uri);
      return {
        uri: r.uri,
        serverName: r.serverName,
        ...(r.toolName ? { toolName: r.toolName } : {}),
        title: r.title,
        mimeType: r.mimeType,
        version: r.version,
        sizeBytes: r.sizeBytes,
        hits: r.hits,
        updatedAtMs: r.updatedAtMs,
        ...(declared ? { declaredByTool: declared.toolName } : {}),
        hasTextFallback: declared?.hasTextFallback ?? false,
        auditActionCount: actionCount.get(r.uri) ?? 0,
        pendingConsents: pendingCount.get(r.uri) ?? 0,
      };
    });
  }

  /**
   * Xem trước một app: resolve resource, build frame config
   * sandbox (CSP nghiêm + allow-list), kèm audit + consent của
   * app đó. Ném lỗi khi URI chưa đăng ký hoặc HTML bị chặn.
   */
  previewApp(
    uri: string,
    allowList: V14SandboxAllowList = {},
  ): V14AppPreview & { frameConfig: V14FrameConfig; audit: UiV14ActionLogEntry[]; consents: UiV14ConsentRequest[] } {
    const entry = this.registry.resolveResource(uri);
    if (!entry) {
      throw new McpAppsPreviewV14Error(
        `Không có app nào đăng ký cho "${uri}".`,
        'ui-v14-preview-not-registered',
      );
    }
    if (entry.sizeBytes > UI_V14_PREVIEW_MAX_HTML_BYTES) {
      throw new McpAppsPreviewV14Error(
        `App ${uri} quá lớn để xem trước (${entry.sizeBytes} bytes).`,
        'ui-v14-preview-too-large',
      );
    }
    const frameConfig = buildV14FrameConfig(
      { uri: entry.uri, title: entry.title, html: entry.html },
      allowList,
    );
    const [base] = this.listPreviews().filter((p) => p.uri === entry.uri);
    const preview: V14AppPreview = base ?? {
      uri: entry.uri,
      serverName: entry.serverName,
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      title: entry.title,
      mimeType: entry.mimeType,
      version: entry.version,
      sizeBytes: entry.sizeBytes,
      hits: entry.hits,
      updatedAtMs: entry.updatedAtMs,
      hasTextFallback: false,
      auditActionCount: 0,
      pendingConsents: 0,
    };
    return {
      ...preview,
      frameConfig,
      audit: this.bridge?.listActions({ appUri: entry.uri, limit: 100 }) ?? [],
      consents: this.bridge?.listPendingConsents().filter((c) => c.appUri === entry.uri) ?? [],
    };
  }

  /** Audit log các action từ UI (mới nhất trước). */
  listAudit(filter: {
    appUri?: string;
    sessionId?: string;
    outcome?: UiV14ActionLogEntry['outcome'];
    limit?: number;
  } = {}): UiV14ActionLogEntry[] {
    return this.bridge?.listActions(filter) ?? [];
  }

  /** Consent đang chờ cho một app (hoặc toàn bộ). */
  listPendingConsents(appUri?: string): UiV14ConsentRequest[] {
    const all = this.bridge?.listPendingConsents() ?? [];
    return appUri === undefined ? all : all.filter((c) => c.appUri === appUri);
  }

  /** Thống kê panel. */
  stats(): {
    version: string;
    appsRegistered: number;
    uiTools: number;
    bridgeSessions: number;
    pendingConsents: number;
    auditActions: number;
    nowMs: number;
  } {
    return {
      version: MCP_APPS_V14_VERSION,
      appsRegistered: this.registry.inner.size,
      uiTools: this.registry.size,
      bridgeSessions: this.bridge?.size ?? 0,
      pendingConsents: this.bridge?.listPendingConsents().length ?? 0,
      auditActions: this.bridge?.listActions({ limit: 500 }).length ?? 0,
      nowMs: this.now(),
    };
  }
}
