/**
 * MCP Apps v2 — CSP builder + single-file bundler (v1.14, Đội T2).
 *
 * Spec 2026-07-28: MCP App là một file HTML duy nhất chạy trong iframe
 * sandboxed, CSP deny-by-default. `appsSandboxV2.ts` đã có policy +
 * `buildCspString`, `apps.ts` đã có `validateAppHtml` + `buildAppCsp` —
 * nhưng chưa có BUNDLER: ghép HTML/CSS/JS rời thành một file an toàn,
 * và sinh CSP header tự động theo permissions của app. Module này là
 * bundler đó:
 *
 *   - `bundleMcpApp({ html, css, js, allowedConnectHosts, permissions })`
 *     -> file HTML duy nhất: CSS/JS inline vào `<style>` / `<script>`,
 *     mọi tham chiếu ngoài (`<script src>`, `<link href>`, `<img src=http>`,
 *     `@import`, `url(http...)`) bị gỡ và ghi vào `warnings` (không im lặng
 *     giữ lại — app chạy offline trong sandbox, link ngoài không có nghĩa).
 *   - `buildCspForApp()` — CSP deny-by-default: `default-src 'none'`,
 *     script/style inline, `img-src data:`, `connect-src` chỉ host trong
 *     allowlist khi app có quyền `network`, `frame-ancestors 'none'`.
 *   - `buildPermissionsPolicyHeader()` — mic/camera theo quyền đã cấp
 *     (xem `appsPermissionsV2.ts`): `(self)` khi được cấp, `()` khi chưa.
 *   - Giới hạn kích thước 512KB (khớp `MAX_APP_HTML_BYTES`); vượt là lỗi.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import { MAX_APP_HTML_BYTES } from './apps';

export class AppBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppBundleError';
  }
}

/** Quyền app dùng để sinh CSP / Permissions-Policy. */
export interface AppBundlePermissions {
  /** App được gọi mạng tới host trong allowlist. */
  network?: boolean;
  /** App được dùng microphone (đã được user cấp — xem appsPermissionsV2). */
  microphone?: boolean;
  /** App được dùng camera (đã được user cấp). */
  camera?: boolean;
  /** App được đọc clipboard. */
  clipboard?: boolean;
}

/** Input cho bundler. */
export interface BundleMcpAppInput {
  /** HTML gốc của app (có thể chưa có `<style>` / `<script>`). */
  html: string;
  /** CSS rời — sẽ inline thành `<style>` trong `<head>`. */
  css?: string[];
  /** JS rời — sẽ inline thành `<script>` cuối `<body>`. */
  js?: string[];
  /** Host app được phép gọi mạng tới (chỉ dùng khi `network: true`). */
  allowedConnectHosts?: string[];
  /** Quyền của app (quyết định CSP + Permissions-Policy). */
  permissions?: AppBundlePermissions;
}

/** Kết quả bundle. */
export interface BundledMcpApp {
  /** File HTML duy nhất (đã inline CSS/JS, đã gỡ tham chiếu ngoài). */
  html: string;
  /** CSP header sinh tự động theo permissions. */
  csp: string;
  /** Permissions-Policy header cho mic/camera. */
  permissionsPolicy: string;
  /** Kích thước file bundle (bytes UTF-8). */
  sizeBytes: number;
  /** Những gì đã bị gỡ / thay đổi khi bundle (để UI báo cho user). */
  warnings: string[];
}

const MAX_BUNDLE_CSS_BYTES = 128 * 1024;
const MAX_BUNDLE_JS_BYTES = 256 * 1024;

/** Host hợp lệ trong allowlist: `example.com` hoặc `*.example.com`. */
export function normalizeAllowedConnectHost(host: string): string | undefined {
  const trimmed = host.trim().toLowerCase();
  if (trimmed === '') return undefined;
  const bare = trimmed.startsWith('*.') ? trimmed.slice(2) : trimmed;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(bare)) return undefined;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes(':')) return undefined;
  return trimmed;
}

/**
 * Sinh CSP deny-by-default cho một app. `network: true` + allowlist thì
 * mở `connect-src` đúng các host đó (kèm `https:`); không có quyền network
 * thì `connect-src 'none'`.
 */
export function buildCspForApp(
  permissions: AppBundlePermissions = {},
  allowedConnectHosts: readonly string[] = [],
): string {
  const hosts = allowedConnectHosts
    .map((h) => normalizeAllowedConnectHost(h))
    .filter((h): h is string => h !== undefined);
  const connectSrc =
    permissions.network === true && hosts.length > 0
      ? hosts.map((h) => `https://${h}`).join(' ')
      : "'none'";
  const directives = [
    "default-src 'none'",
    // Single-file bundle: script/style đều inline nên cần 'unsafe-inline'.
    // Không có 'unsafe-eval', không load script/style ngoài.
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  return directives.join('; ');
}

/**
 * Sinh Permissions-Policy cho mic/camera: `(self)` khi quyền đã được cấp,
 * `()` khi chưa — app không được tự xin quyền ngoài luồng cấp quyền
 * của host (`appsPermissionsV2.ts`).
 */
export function buildPermissionsPolicyHeader(
  permissions: AppBundlePermissions = {},
): string {
  const mic = permissions.microphone === true ? '(self)' : '()';
  const cam = permissions.camera === true ? '(self)' : '()';
  const clipboard = permissions.clipboard === true ? '(self)' : '()';
  return `microphone=${mic}, camera=${cam}, clipboard-read=${clipboard}, clipboard-write=${clipboard}`;
}

/** Gỡ mọi tham chiếu tài nguyên ngoài khỏi HTML, trả HTML sạch + warnings. */
export function stripExternalReferences(html: string): { html: string; warnings: string[] } {
  const warnings: string[] = [];
  let out = html;
  const externalScript = /<script\b[^>]*\bsrc\s*=\s*("[^"]*"|'[^']*')[^>]*>\s*<\/script\s*>/gi;
  if (externalScript.test(out)) {
    warnings.push('Đã gỡ <script src="..."> ngoài — app single-file không load script ngoài.');
    out = out.replace(
      /<script\b[^>]*\bsrc\s*=\s*("[^"]*"|'[^']*')[^>]*>\s*<\/script\s*>/gi,
      '',
    );
  }
  const externalLink = /<link\b[^>]*\bhref\s*=\s*("[^"]*"|'[^']*')[^>]*>/gi;
  if (externalLink.test(out)) {
    warnings.push('Đã gỡ <link href="..."> ngoài — CSS phải inline trong file bundle.');
    out = out.replace(/<link\b[^>]*\bhref\s*=\s*("[^"]*"|'[^']*')[^>]*>/gi, '');
  }
  const externalImg = /<img\b[^>]*\bsrc\s*=\s*("(https?:)?\/\/[^"]*"|'(https?:)?\/\/[^']*')[^>]*>/gi;
  if (externalImg.test(out)) {
    warnings.push('Đã gỡ <img src="http(s)..."> ngoài — ảnh phải dùng data: URI hoặc bỏ.');
    out = out.replace(
      /<img\b[^>]*\bsrc\s*=\s*("(https?:)?\/\/[^"]*"|'(https?:)?\/\/[^']*')[^>]*>/gi,
      '',
    );
  }
  const cssImport = /@import\s+(url\([^)]*\)|"[^"]*"|'[^']*')\s*;/gi;
  if (cssImport.test(out)) {
    warnings.push('Đã gỡ @import trong CSS — CSS phải inline trong file bundle.');
    out = out.replace(/@import\s+(url\([^)]*\)|"[^"]*"|'[^']*')\s*;/gi, '');
  }
  const cssUrl = /url\(\s*["']?(https?:)?\/\/[^)"']+["']?\s*\)/gi;
  if (cssUrl.test(out)) {
    warnings.push('Đã gỡ url(http...) trong CSS — tài nguyên ngoài không được phép.');
    out = out.replace(/url\(\s*["']?(https?:)?\/\/[^)"']+["']?\s*\)/gi, 'url()');
  }
  return { html: out, warnings };
}

/** Kiểm tra CSS/JS rời trước khi inline (giới hạn kích thước + cấm import ngoài). */
export function validateBundleAssets(input: BundleMcpAppInput): string[] {
  const errors: string[] = [];
  if (typeof input.html !== 'string' || input.html.trim() === '') {
    errors.push('html: bắt buộc phải có nội dung HTML');
  }
  const cssBytes = (input.css ?? []).reduce(
    (sum, c) => sum + new TextEncoder().encode(c).length,
    0,
  );
  if (cssBytes > MAX_BUNDLE_CSS_BYTES) {
    errors.push(`css: tổng ${cssBytes} bytes vượt giới hạn ${MAX_BUNDLE_CSS_BYTES}`);
  }
  const jsBytes = (input.js ?? []).reduce(
    (sum, j) => sum + new TextEncoder().encode(j).length,
    0,
  );
  if (jsBytes > MAX_BUNDLE_JS_BYTES) {
    errors.push(`js: tổng ${jsBytes} bytes vượt giới hạn ${MAX_BUNDLE_JS_BYTES}`);
  }
  for (const host of input.allowedConnectHosts ?? []) {
    if (normalizeAllowedConnectHost(host) === undefined) {
      errors.push(`allowedConnectHosts: host không hợp lệ: "${host}"`);
    }
  }
  return errors;
}

function injectBefore(out: string, tag: string, snippet: string): string {
  const idx = out.toLowerCase().lastIndexOf(tag);
  if (idx === -1) return out + snippet;
  return out.slice(0, idx) + snippet + out.slice(idx);
}

function ensureHtmlShell(html: string): string {
  const lower = html.toLowerCase();
  if (!lower.includes('<html')) {
    return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  }
  let out = html;
  if (!lower.includes('<head')) {
    out = out.replace(/<html[^>]*>/i, (m) => `${m}<head><meta charset="utf-8"></head>`);
  }
  if (!lower.includes('<body')) {
    out = out.replace(/<\/html\s*>/i, '</body></html>');
  }
  return out;
}

/**
 * Ghép HTML/CSS/JS thành một file duy nhất an toàn + sinh CSP header
 * theo permissions. Ném `AppBundleError` khi input sai hoặc file vượt
 * 512KB.
 */
export function bundleMcpApp(input: BundleMcpAppInput): BundledMcpApp {
  const errors = validateBundleAssets(input);
  if (errors.length > 0) {
    throw new AppBundleError(`Bundle: ${errors.join('; ')}`);
  }
  const permissions = input.permissions ?? {};
  const warnings: string[] = [];
  const stripped = stripExternalReferences(input.html);
  warnings.push(...stripped.warnings);
  let out = ensureHtmlShell(stripped.html);
  const css = (input.css ?? []).filter((c) => c.trim() !== '');
  if (css.length > 0) {
    const styleBlock = `<style>\n${css.join('\n')}\n</style>`;
    if (out.toLowerCase().includes('</head>')) {
      out = out.replace(/<\/head\s*>/i, `${styleBlock}</head>`);
    } else {
      out = injectBefore(out, '</html>', styleBlock);
    }
  }
  const js = (input.js ?? []).filter((j) => j.trim() !== '');
  if (js.length > 0) {
    const scriptBlock = `<script>\n${js.join('\n')}\n</script>`;
    if (out.toLowerCase().includes('</body>')) {
      out = out.replace(/<\/body\s*>/i, `${scriptBlock}</body>`);
    } else {
      out = injectBefore(out, '</html>', scriptBlock);
    }
  }
  // CSP vào <meta> để file tự mang policy khi mở trực tiếp, kèm header
  // cho host dùng khi serve qua HTTP.
  const csp = buildCspForApp(permissions, input.allowedConnectHosts ?? []);
  const permissionsPolicy = buildPermissionsPolicyHeader(permissions);
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">`;
  if (out.toLowerCase().includes('<head')) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}${cspMeta}`);
  } else {
    out = cspMeta + out;
  }
  const sizeBytes = new TextEncoder().encode(out).length;
  if (sizeBytes > MAX_APP_HTML_BYTES) {
    throw new AppBundleError(
      `Bundle: file ${sizeBytes} bytes vượt giới hạn ${MAX_APP_HTML_BYTES} bytes — tách nhỏ app hoặc bỏ tài nguyên thừa`,
    );
  }
  return { html: out, csp, permissionsPolicy, sizeBytes, warnings };
}

/** Tóm tắt một bundle cho UI / log (không kèm HTML). */
export function summarizeBundle(bundle: BundledMcpApp): {
  sizeBytes: number;
  csp: string;
  permissionsPolicy: string;
  warningCount: number;
  warnings: string[];
} {
  return {
    sizeBytes: bundle.sizeBytes,
    csp: bundle.csp,
    permissionsPolicy: bundle.permissionsPolicy,
    warningCount: bundle.warnings.length,
    warnings: [...bundle.warnings],
  };
}
