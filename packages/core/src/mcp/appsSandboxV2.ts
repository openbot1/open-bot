/**
 * MCP Apps — sandbox policy v2 (v1.05, sóng T2).
 *
 * Apps v1 (`apps.ts`) build iframe descriptor với CSP cơ bản; Apps
 * v2 (`appsV2.ts`) khai declaration + review trước khi render.
 * Module này là policy sandbox v2 — lớp quyết định app ĐƯỢC LÀM
 * GÌ trong iframe, dựa trên declaration + review status:
 *
 *   - `buildSandboxPolicyV2(template, options)`: ra
 *     `SandboxPolicyV2` — CSP đầy đủ (default-src 'none',
 *     script/style/img/media/connect chỉ từ host cho phép,
 *     `unsafe-inline`/`unsafe-eval` luôn cấm, script chỉ chạy khi
 *     template đã reviewed/approved HOẶC host bật
 *     `allowScriptsForUnreviewed` một cách tường minh), sandbox
 *     flags (`allow-scripts` chỉ khi được chạy script,
 *     `allow-same-origin` KHÔNG BAO GIỜ — app không được chung
 *     origin với host), và danh sách host được phép.
 *   - `validateSandboxPolicy(policy)`: kiểm tra policy tự viết
 *     (vd từ config) có vi phạm nguyên tắc cứng không (cấm eval,
 *     cấm same-origin, connect-src phải subset của allowedHosts).
 *   - `sandboxFlagsFor(template)`: flags rút gọn cho UI hiển thị.
 *   - `describeSandboxPolicy(policy)`: một dòng mô tả cho review UI.
 *
 * Policy v2 chặt hơn v1 ở hai điểm: (1) script mặc định TẮT với
 * app chưa review (v1 cho chạy kèm cảnh báo); (2) network mặc
 * định CHẶN hoàn toàn trừ host khai trong declaration (v1 chỉ
 * chặn host lạ ở fetch, không chặn ở CSP). App cũ không khai
 * allowedHosts → chạy ở chế độ render-only, không mạng.
 *
 * Không chạm mạng, không copy code từ SDK MCP nào.
 */

import {
  appActionAllowed,
  type DeclaredAppTemplate,
} from './appsV2';

/** CSP directives của sandbox policy v2. */
export interface SandboxCspV2 {
  /** default-src — luôn 'none' ở v2. */
  defaultSrc: string;
  /** script-src — 'none' khi không cho chạy script. */
  scriptSrc: string;
  /** style-src. */
  styleSrc: string;
  /** img-src. */
  imgSrc: string;
  /** media-src. */
  mediaSrc: string;
  /** font-src. */
  fontSrc: string;
  /** connect-src (fetch/XHR/WebSocket) — chỉ host cho phép. */
  connectSrc: string;
  /** frame-src — luôn 'none' (app không được nhúng frame khác). */
  frameSrc: string;
  /** object-src — luôn 'none'. */
  objectSrc: string;
  /** base-uri — luôn 'none'. */
  baseUri: string;
  /** form-action — chỉ 'none' hoặc ui:// khi app được submit form. */
  formAction: string;
}

/** Sandbox policy v2 đầy đủ cho một app template. */
export interface SandboxPolicyV2 {
  /** Template id policy này áp cho. */
  templateId: string;
  /** App có được chạy script không. */
  allowScripts: boolean;
  /** App có được mở link ngoài (target _blank, rel noopener) không. */
  allowPopups: boolean;
  /** App có được submit form không (theo allowedActions). */
  allowForms: boolean;
  /** App có được gọi tool qua host bridge không. */
  allowToolCalls: boolean;
  /** Host được phép tải tài nguyên / kết nối (đã chuẩn hoá, không scheme). */
  allowedHosts: string[];
  /** CSP đầy đủ. */
  csp: SandboxCspV2;
  /** Chuỗi CSP để gắn vào iframe (header/meta). */
  cspString: string;
  /** Sandbox flags cho attribute `sandbox` của iframe. */
  sandboxFlags: string[];
  /** Lý do policy chặt/mở (để review UI hiển thị). */
  notes: string[];
}

export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxPolicyError';
  }
}

/** Host luôn được phép ở mức tối thiểu (app-local resources). */
export const SANDBOX_V2_APP_LOCAL_HOST = 'ui://';

/**
 * Chuẩn hoá một host cho phép: bỏ scheme, path, port mặc định;
 * lowercase. Host chứa ký tự lạ → ném SandboxPolicyError.
 */
export function normalizeAllowedHost(host: string): string {
  const clean = host.trim().toLowerCase();
  if (clean.length === 0) {
    throw new SandboxPolicyError('allowedHosts không được chứa host rỗng.');
  }
  const withoutScheme = clean.replace(/^https?:\/\//, '');
  if (withoutScheme.includes('/') || withoutScheme.includes('?') || withoutScheme.includes('#')) {
    throw new SandboxPolicyError(
      `allowedHosts không hợp lệ: ${JSON.stringify(host)} (chỉ hostname, không path/query).`,
    );
  }
  const withoutPort = withoutScheme.replace(/:(443|80)$/, '');
  if (!/^[a-z0-9._*-]+$/.test(withoutPort) || withoutPort.startsWith('.') || withoutPort.endsWith('.')) {
    throw new SandboxPolicyError(`allowedHosts không hợp lệ: ${JSON.stringify(host)}.`);
  }
  return withoutPort;
}

/**
 * Build CSP string từ directives (thứ tự cố định để test ổn định
 * và để hai policy giống nhau cho cùng một chuỗi).
 */
export function buildCspString(csp: SandboxCspV2): string {
  const parts: Array<[string, string]> = [
    ['default-src', csp.defaultSrc],
    ['script-src', csp.scriptSrc],
    ['style-src', csp.styleSrc],
    ['img-src', csp.imgSrc],
    ['media-src', csp.mediaSrc],
    ['font-src', csp.fontSrc],
    ['connect-src', csp.connectSrc],
    ['frame-src', csp.frameSrc],
    ['object-src', csp.objectSrc],
    ['base-uri', csp.baseUri],
    ['form-action', csp.formAction],
  ];
  return parts.map(([k, v]) => `${k} ${v}`).join('; ');
}

/**
 * Build sandbox policy v2 cho một template.
 *
 * Quy tắc:
 *  - Script: chỉ khi template đã `reviewed`/`approved`, HOẶC
 *    host bật `allowScriptsForUnreviewed` (mặc định false — app
 *    chưa review chạy render-only, không script).
 *  - Tool call: chỉ khi declaration cho `tool-call` VÀ template
 *    không bị `rejected`.
 *  - Form: chỉ khi declaration cho `form-submit`.
 *  - Popup/link: chỉ khi declaration cho `link-open`.
 *  - Network: chỉ host trong `allowedHosts` + host của prefetch
 *    URI (https). Không khai host nào → connect-src 'none'.
 *  - `allow-same-origin` KHÔNG BAO GIỜ có trong flags (app không
 *    chung origin với host, dù đã approved).
 */
export function buildSandboxPolicyV2(
  template: DeclaredAppTemplate,
  options: {
    /** Cho app chưa review chạy script (mặc định false — khuyến nghị giữ false). */
    allowScriptsForUnreviewed?: boolean;
    /** Host bổ sung host cho phép (vd CDN của host, ngoài declaration). */
    extraAllowedHosts?: string[];
  } = {},
): SandboxPolicyV2 {
  const notes: string[] = [];
  const isReviewed = template.review === 'reviewed' || template.review === 'approved';
  const allowScriptsForUnreviewed = options.allowScriptsForUnreviewed ?? false;

  let allowScripts = false;
  if (isReviewed) {
    allowScripts = true;
    notes.push(`App đã ${template.review} — cho chạy script.`);
  } else if (allowScriptsForUnreviewed) {
    allowScripts = true;
    notes.push('App chưa review nhưng host bật allowScriptsForUnreviewed — cho chạy script (rủi ro).');
  } else {
    notes.push('App chưa review — KHÔNG cho chạy script (render-only).');
  }
  if (template.review === 'rejected') {
    allowScripts = false;
    notes.push('App đã bị rejected — khoá script, chỉ render tĩnh.');
  }

  const allowToolCalls =
    appActionAllowed(template, 'tool-call') && template.review !== 'rejected';
  if (appActionAllowed(template, 'tool-call') && template.review === 'rejected') {
    notes.push('App bị rejected — khoá gọi tool dù declaration cho phép.');
  }
  const allowForms = appActionAllowed(template, 'form-submit') && template.review !== 'rejected';
  const allowPopups = appActionAllowed(template, 'link-open');

  const hostSet = new Set<string>();
  for (const host of template.allowedHosts) hostSet.add(normalizeAllowedHost(host));
  for (const extra of options.extraAllowedHosts ?? []) hostSet.add(normalizeAllowedHost(extra));
  for (const resource of template.prefetch) {
    if (resource.uri.startsWith('https://')) {
      try {
        hostSet.add(new URL(resource.uri).hostname.toLowerCase());
      } catch {
        // URI prefetch đã validate ở declareAppTemplate — bỏ qua nếu lạ.
      }
    }
  }
  const allowedHosts = [...hostSet].sort();
  if (allowedHosts.length === 0) {
    notes.push('App không khai host nào — chặn toàn bộ network (connect-src none).');
  }

  const hostSources = allowedHosts.map((h) => `https://${h}`).join(' ');
  const csp: SandboxCspV2 = {
    defaultSrc: "'none'",
    scriptSrc: allowScripts ? `'self' ${hostSources}`.trim() : "'none'",
    styleSrc: `'self' 'unsafe-inline'`,
    imgSrc: `'self' data: ${hostSources}`.trim(),
    mediaSrc: `'self' ${hostSources}`.trim(),
    fontSrc: `'self' ${hostSources}`.trim(),
    connectSrc: allowedHosts.length > 0 ? `'self' ${hostSources}` : "'none'",
    frameSrc: "'none'",
    objectSrc: "'none'",
    baseUri: "'none'",
    formAction: allowForms ? `'self' ${hostSources}`.trim() : "'none'",
  };
  // script-src 'self' khi không có host: chỉ app-local.
  if (allowScripts && allowedHosts.length === 0) csp.scriptSrc = "'self'";

  const sandboxFlags: string[] = [];
  if (allowScripts) sandboxFlags.push('allow-scripts');
  if (allowForms) sandboxFlags.push('allow-forms');
  if (allowPopups) sandboxFlags.push('allow-popups', 'allow-popups-to-escape-sandbox');
  // KHÔNG BAO GIỜ thêm allow-same-origin — xem doc ở đầu file.
  sandboxFlags.push('allow-modals');

  return {
    templateId: template.id,
    allowScripts,
    allowPopups,
    allowForms,
    allowToolCalls,
    allowedHosts,
    csp,
    cspString: buildCspString(csp),
    sandboxFlags,
    notes,
  };
}

/**
 * Validate một policy (tự build hoặc từ config): các nguyên tắc
 * cứng của sandbox v2. Trả danh sách lỗi (rỗng = hợp lệ).
 *  - script-src không được chứa 'unsafe-eval' / 'unsafe-inline'.
 *  - sandbox flags không được chứa 'allow-same-origin'.
 *  - connect-src host phải nằm trong allowedHosts.
 *  - default-src phải là 'none'.
 */
export function validateSandboxPolicy(policy: SandboxPolicyV2): string[] {
  const errors: string[] = [];
  if (policy.csp.defaultSrc !== "'none'") {
    errors.push('Sandbox v2: default-src phải là \'none\'.');
  }
  if (/unsafe-eval|unsafe-inline/.test(policy.csp.scriptSrc)) {
    errors.push('Sandbox v2: script-src không được chứa unsafe-eval / unsafe-inline.');
  }
  if (policy.sandboxFlags.includes('allow-same-origin')) {
    errors.push('Sandbox v2: cấm allow-same-origin — app không được chung origin với host.');
  }
  if (policy.sandboxFlags.includes('allow-top-navigation')) {
    errors.push('Sandbox v2: cấm allow-top-navigation — app không được điều hướng cửa sổ host.');
  }
  const connectHosts = policy.csp.connectSrc
    .split(/\s+/)
    .filter((s) => s.startsWith('https://'))
    .map((s) => s.slice('https://'.length).toLowerCase());
  for (const host of connectHosts) {
    if (!policy.allowedHosts.includes(host)) {
      errors.push(`Sandbox v2: connect-src chứa host "${host}" không nằm trong allowedHosts.`);
    }
  }
  if (policy.allowScripts && policy.csp.scriptSrc === "'none'") {
    errors.push('Sandbox v2: allowScripts=true nhưng script-src là \'none\' (mâu thuẫn).');
  }
  if (!policy.allowScripts && policy.csp.scriptSrc !== "'none'") {
    errors.push('Sandbox v2: allowScripts=false nhưng script-src cho chạy script (mâu thuẫn).');
  }
  return errors;
}

/** True khi policy hợp lệ theo `validateSandboxPolicy`. */
export function isValidSandboxPolicy(policy: SandboxPolicyV2): boolean {
  return validateSandboxPolicy(policy).length === 0;
}

/**
 * Flags rút gọn cho UI: mỗi flag một dòng giải thích ngắn.
 * Dùng trong security review UI (component McpAppSecurityReview).
 */
export function sandboxFlagsFor(policy: SandboxPolicyV2): { flag: string; meaning: string }[] {
  const meanings: Record<string, string> = {
    'allow-scripts': 'Được chạy JavaScript',
    'allow-forms': 'Được submit form',
    'allow-popups': 'Được mở link cửa sổ mới',
    'allow-popups-to-escape-sandbox': 'Popup thoát sandbox',
    'allow-modals': 'Được mở hộp thoại (alert/confirm)',
  };
  return policy.sandboxFlags.map((flag) => ({
    flag,
    meaning: meanings[flag] ?? flag,
  }));
}

/** Một dòng mô tả policy (log / review UI). */
export function describeSandboxPolicy(policy: SandboxPolicyV2): string {
  const parts: string[] = [
    `script: ${policy.allowScripts ? 'cho phép' : 'chặn'}`,
    `tool: ${policy.allowToolCalls ? 'cho phép' : 'chặn'}`,
    `form: ${policy.allowForms ? 'cho phép' : 'chặn'}`,
    `network: ${policy.allowedHosts.length > 0 ? policy.allowedHosts.join(', ') : 'chặn hết'}`,
  ];
  return `Sandbox v2 cho "${policy.templateId}": ${parts.join(' · ')}.`;
}

/**
 * So sánh hai policy: trả danh sách khác biệt (để host phát hiện
 * policy đổi khi template re-declare — vd app xin thêm host).
 */
export function diffSandboxPolicies(
  before: SandboxPolicyV2,
  after: SandboxPolicyV2,
): string[] {
  const diffs: string[] = [];
  if (before.allowScripts !== after.allowScripts) {
    diffs.push(
      `script: ${before.allowScripts ? 'cho phép' : 'chặn'} → ${after.allowScripts ? 'cho phép' : 'chặn'}`,
    );
  }
  if (before.allowToolCalls !== after.allowToolCalls) {
    diffs.push(
      `tool: ${before.allowToolCalls ? 'cho phép' : 'chặn'} → ${after.allowToolCalls ? 'cho phép' : 'chặn'}`,
    );
  }
  if (before.allowForms !== after.allowForms) {
    diffs.push(
      `form: ${before.allowForms ? 'cho phép' : 'chặn'} → ${after.allowForms ? 'cho phép' : 'chặn'}`,
    );
  }
  const beforeHosts = new Set(before.allowedHosts);
  const afterHosts = new Set(after.allowedHosts);
  for (const host of after.allowedHosts) {
    if (!beforeHosts.has(host)) diffs.push(`network: thêm host "${host}"`);
  }
  for (const host of before.allowedHosts) {
    if (!afterHosts.has(host)) diffs.push(`network: bỏ host "${host}"`);
  }
  if (before.cspString !== after.cspString && diffs.length === 0) {
    diffs.push('CSP đổi (chi tiết khác).');
  }
  return diffs;
}
