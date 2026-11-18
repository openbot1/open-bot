/**
 * MCP Apps Agent Skills v15 — Agent Skills tạo app mới (create / add /
 * migrate) cho MCP Apps host v15 (SEP-1865 stable 2026-01-26, ideas
 * only — không copy code/text/tài sản của bất kỳ repo nào).
 *
 * Một "App Skill" là một skill (theo chuẩn Agent Skills: SKILL.md +
 * metadata) chuyên tạo MCP App: nó biết scaffold app từ template,
 * thêm app vào skill đã có, và migrate app v13/v14 lên v15.
 *
 *   - `createAppSkill` — tạo skill mới từ tên + mô tả + template
 *     mặc định: sinh SKILL.md + manifest + app mẫu (HTML self-
 *     contained, MIME `text/html;profile=mcp-app`).
 *   - `scaffoldApp` — sinh một app từ template (dashboard / form /
 *     chart / wizard / blank) với tên + server cho trước: trả danh
 *     sách file (path + content) + manifest v15 + resourceUri.
 *   - `addAppToSkill` — thêm app mới vào skill đã có (kiểm tra trùng
 *     tên, cập nhật SKILL.md thêm mục app).
 *   - `migrateAppToV15` — migrate app v13/v14 lên v15: kiểm tra HTML
 *     (document đầy đủ, cấm base/form ra ngoài), thêm manifest v15,
 *     thêm bridge client snippet `ui/initialize`, liệt kê thay đổi.
 *   - `validateAppSkill` — validate skill (SKILL.md đủ dài, manifest
 *     đúng, app mẫu hợp lệ) trước khi đăng ký vào host.
 *
 * Module này thuần (không DOM, không network, không ghi file): mọi
 * hàm trả danh sách file `{ path, content }` để caller (tool / host)
 * tự ghi — nhờ vậy test được bằng node:test mà không chạm disk.
 * Skill tạo ra là ý tưởng/triển khai của open-bot, không copy
 * SKILL.md hay template của repo nào khác.
 */

import { validateAppManifestV15, type AppManifestV15 } from './appsUiV15';
import { validateAppHtmlV15 } from './appsUiV15';
import { MCP_APP_PROFILE_MIME_TYPE } from './appsUiMeta';

export const MCP_APPS_V15_SKILLS_VERSION = '15.0.0';
/** Tên skill tối đa (ký tự). */
export const UI_V15_SKILL_NAME_MAX_CHARS = 64;
/** Mô tả skill tối thiểu (ký tự) — skill không mô tả thì vô dụng. */
export const UI_V15_SKILL_DESCRIPTION_MIN_CHARS = 20;
/** SKILL.md tối thiểu (ký tự) sau khi sinh. */
export const UI_V15_SKILL_MD_MIN_CHARS = 200;
/** Số app tối đa trong một skill. */
export const UI_V15_SKILL_MAX_APPS = 20;
/** Số file tối đa một lần scaffold sinh ra. */
export const UI_V15_SCAFFOLD_MAX_FILES = 12;

/** Template app mà skill v15 hỗ trợ. */
export const UI_V15_APP_TEMPLATES = ['dashboard', 'form', 'chart', 'wizard', 'blank'] as const;
export type UiV15AppTemplate = (typeof UI_V15_APP_TEMPLATES)[number];

/** Mô tả ngắn từng template (hiện trong gallery + SKILL.md). */
export const UI_V15_TEMPLATE_DESCRIPTIONS: Record<UiV15AppTemplate, string> = {
  dashboard: 'Bảng tổng quan: thẻ số liệu + bảng + biểu đồ cột, cập nhật qua model context.',
  form: 'Biểu mẫu: nhập liệu rồi gửi về host qua tools/call (có consent).',
  chart: 'Biểu đồ: dữ liệu { label, value } vẽ bằng auto-visualiser của host.',
  wizard: 'Wizard nhiều bước: từng bước thu thập input, cuối cùng gửi kết quả về host.',
  blank: 'App trống: HTML document tối thiểu + bridge client ui/initialize.',
};

export class McpAppsSkillsV15Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpAppsSkillsV15Error';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Một file sinh ra bởi scaffold (path tương đối + nội dung). */
export interface ScaffoldedFile {
  path: string;
  content: string;
}

/** Manifest của một App Skill v15. */
export interface AppSkillManifestV15 {
  /** Tên skill (kebab-case). */
  name: string;
  /** Version semver của skill. */
  version: string;
  /** Mô tả skill (tối thiểu 20 ký tự). */
  description: string;
  /** Template mặc định của skill. */
  defaultTemplate: UiV15AppTemplate;
  /** Danh sách app thuộc skill (tên app). */
  apps: string[];
  /** Server mặc định app đăng ký vào. */
  defaultServer: string;
  /** Tác giả skill. */
  author?: string;
}

/** Một App Skill v15 đầy đủ (manifest + SKILL.md + file app mẫu). */
export interface AppSkillV15 {
  manifest: AppSkillManifestV15;
  skillMd: string;
  /** File app mẫu (HTML + manifest app). */
  files: ScaffoldedFile[];
}

/** Kết quả validate skill. */
export interface ValidateAppSkillResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Kết quả migrate app lên v15. */
export interface MigrateAppResult {
  /** HTML v15 (đã thêm bridge snippet + manifest). */
  html: string;
  /** Manifest v15 sinh ra. */
  manifest: AppManifestV15;
  /** File đi kèm (manifest JSON). */
  files: ScaffoldedFile[];
  /** Danh sách thay đổi đã làm (hiển thị cho user review). */
  changes: string[];
  warnings: string[];
}

/**
 * Validate tên skill/app (kebab-case). Ném lỗi khi sai.
 */
export function validateSkillNameV15(name: unknown, what = 'skill'): string {
  const value = asNonEmptyString(name);
  if (!value) {
    throw new McpAppsSkillsV15Error(`Tên ${what} rỗng.`, 'ui-v15-bad-skill-name');
  }
  if (value.length > UI_V15_SKILL_NAME_MAX_CHARS) {
    throw new McpAppsSkillsV15Error(
      `Tên ${what} tối đa ${UI_V15_SKILL_NAME_MAX_CHARS} ký tự.`,
      'ui-v15-bad-skill-name',
    );
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) || value.includes('--')) {
    throw new McpAppsSkillsV15Error(
      `Tên ${what} "${value}" không hợp lệ: phải là kebab-case (chữ thường, số, dấu gạch ngang).`,
      'ui-v15-bad-skill-name',
    );
  }
  return value;
}

/**
 * Validate version semver. Ném lỗi khi sai.
 */
export function validateSemverV15(version: unknown): string {
  const value = asNonEmptyString(version);
  if (!value || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new McpAppsSkillsV15Error(
      `Version "${String(version ?? '')}" không hợp lệ: phải là semver MAJOR.MINOR.PATCH.`,
      'ui-v15-bad-version',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Bridge client snippet (app dùng để nói chuyện với host)
// ---------------------------------------------------------------------------

/**
 * Đoạn JS client tối thiểu app nhúng để nói chuyện với host qua
 * postMessage JSON-RPC 2.0: `ui/initialize` → `tools/call` /
 * `ui/message` / `ui/open-link`. Không fetch ngoài, không eval —
 * chỉ `window.parent.postMessage` với origin `*` theo đúng SEP-1865
 * (host kiểm tra origin phía host, app srcdoc có origin "null").
 */
export const UI_V15_BRIDGE_CLIENT_SNIPPET = `<script>
(function () {
  var seq = 0;
  var pending = {};
  var sessionId = null;
  function send(method, params) {
    return new Promise(function (resolve, reject) {
      var id = 'app-' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params || {}, id: id }, '*');
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error('Timeout chờ host trả lời ' + method)); }
      }, 30000);
    });
  }
  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.jsonrpc !== '2.0' || !data.id) return;
    var entry = pending[data.id];
    if (!entry) return;
    delete pending[data.id];
    if (data.error) entry.reject(new Error(data.error.message || 'Lỗi host'));
    else entry.resolve(data.result);
  });
  window.McpAppBridge = {
    initialize: function (clientInfo) {
      return send('ui/initialize', { clientInfo: clientInfo || {} }).then(function (result) {
        sessionId = result.sessionId;
        return result;
      });
    },
    callTool: function (name, args) { return send('tools/call', { name: name, arguments: args || {} }); },
    listTools: function () { return send('tools/list', {}); },
    readResource: function (uri) { return send('resources/read', { uri: uri }); },
    postMessage: function (text) { return send('ui/post-message', { text: text }); },
    openLink: function (url) { return send('ui/open-link', { url: url }); },
    sendMessage: function (text, level) { return send('ui/message', { text: text, level: level || 'info' }); },
    updateModelContext: function (context) { return send('ui/update-model-context', { context: context }); },
    close: function () { return send('ui/close', {}); },
    getSessionId: function () { return sessionId; }
  };
})();
</script>`;

// ---------------------------------------------------------------------------
// Template HTML
// ---------------------------------------------------------------------------

/** HTML khung chung cho app v15 (document đầy đủ, self-contained). */
function appShellHtml(title: string, body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 16px; color: #111; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 8px 0; }
  button { padding: 8px 14px; border-radius: 6px; border: 1px solid #2563eb; background: #2563eb; color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  input, select, textarea { padding: 8px; border: 1px solid #ccc; border-radius: 6px; width: 100%; box-sizing: border-box; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  .muted { color: #666; font-size: 13px; }
  .error { color: #b91c1c; }
</style>
${extraHead}</head>
<body>
${body}
${UI_V15_BRIDGE_CLIENT_SNIPPET}
</body>
</html>`;
}

/** Nội dung body theo template. */
function templateBody(template: UiV15AppTemplate, appName: string): string {
  switch (template) {
    case 'dashboard':
      return `<h1>${appName} — Dashboard</h1>
<p class="muted">Số liệu cập nhật qua model context từ host.</p>
<div class="card"><strong>Tổng quan</strong><div id="stats">Đang tải…</div></div>
<div class="card"><strong>Hoạt động gần đây</strong><table><thead><tr><th>Thời gian</th><th>Sự kiện</th></tr></thead><tbody id="activity"><tr><td>—</td><td>Chưa có dữ liệu.</td></tr></tbody></table></div>
<script>
  window.addEventListener('load', function () {
    window.McpAppBridge.initialize({ name: '${appName}', version: '1.0.0' }).then(function (result) {
      document.getElementById('stats').textContent = 'Đã kết nối host v' + result.hostVersion + ' (session ' + result.sessionId + ').';
    }).catch(function (err) {
      document.getElementById('stats').innerHTML = '<span class="error">Không kết nối được host: ' + err.message + '</span>';
    });
  });
</script>`;
    case 'form':
      return `<h1>${appName} — Biểu mẫu</h1>
<p class="muted">Gửi qua host (tools/call, có consent của bạn trước khi chạy).</p>
<form id="app-form">
  <div class="card"><label>Tiêu đề<br><input name="title" required></label></div>
  <div class="card"><label>Ghi chú<br><textarea name="notes" rows="3"></textarea></label></div>
  <button type="submit">Gửi</button>
  <span id="form-status" class="muted"></span>
</form>
<script>
  document.getElementById('app-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var status = document.getElementById('form-status');
    status.textContent = 'Đang gửi…';
    var data = new FormData(event.target);
    window.McpAppBridge.initialize({ name: '${appName}', version: '1.0.0' }).then(function () {
      return window.McpAppBridge.callTool('submit-form', { title: data.get('title'), notes: data.get('notes') });
    }).then(function () { status.textContent = 'Đã gửi.'; })
      .catch(function (err) { status.innerHTML = '<span class="error">' + err.message + '</span>'; });
  });
</script>`;
    case 'chart':
      return `<h1>${appName} — Biểu đồ</h1>
<p class="muted">Host tự sinh biểu đồ từ dữ liệu bằng auto-visualiser.</p>
<div class="card" id="chart">Đang tải biểu đồ…</div>
<button id="refresh-chart">Làm mới</button>
<script>
  function loadChart() {
    window.McpAppBridge.initialize({ name: '${appName}', version: '1.0.0' }).then(function () {
      return window.McpAppBridge.callTool('get-chart-data', {});
    }).then(function (result) {
      document.getElementById('chart').textContent = JSON.stringify(result, null, 2);
    }).catch(function (err) {
      document.getElementById('chart').innerHTML = '<span class="error">' + err.message + '</span>';
    });
  }
  document.getElementById('refresh-chart').addEventListener('click', loadChart);
  window.addEventListener('load', loadChart);
</script>`;
    case 'wizard':
      return `<h1>${appName} — Wizard</h1>
<p class="muted">Bước <span id="step-num">1</span>/3 — hoàn thành từng bước, cuối cùng gửi về host.</p>
<div class="card" id="step-body"></div>
<button id="prev-step" disabled>Quay lại</button>
<button id="next-step">Tiếp tục</button>
<script>
  var steps = [
    { title: 'Bước 1: Thông tin chung', html: '<label>Tên<br><input id="w-name"></label>' },
    { title: 'Bước 2: Lựa chọn', html: '<label>Loại<br><select id="w-kind"><option>Chuẩn</option><option>Nâng cao</option></select></label>' },
    { title: 'Bước 3: Xác nhận', html: '<p>Kiểm tra lại rồi bấm Hoàn thành.</p>' }
  ];
  var current = 0;
  function renderStep() {
    document.getElementById('step-num').textContent = String(current + 1);
    document.getElementById('step-body').innerHTML = '<strong>' + steps[current].title + '</strong><br>' + steps[current].html;
    document.getElementById('prev-step').disabled = current === 0;
    document.getElementById('next-step').textContent = current === steps.length - 1 ? 'Hoàn thành' : 'Tiếp tục';
  }
  document.getElementById('prev-step').addEventListener('click', function () { if (current > 0) { current -= 1; renderStep(); } });
  document.getElementById('next-step').addEventListener('click', function () {
    if (current < steps.length - 1) { current += 1; renderStep(); return; }
    window.McpAppBridge.initialize({ name: '${appName}', version: '1.0.0' }).then(function () {
      return window.McpAppBridge.callTool('wizard-complete', { name: (document.getElementById('w-name') || {}).value || '' });
    }).then(function () { document.getElementById('step-body').textContent = 'Đã hoàn thành.'; })
      .catch(function (err) { document.getElementById('step-body').innerHTML = '<span class="error">' + err.message + '</span>'; });
  });
  renderStep();
</script>`;
    case 'blank':
    default:
      return `<h1>${appName}</h1>
<p class="muted">App trống — bắt đầu từ đây, thêm nội dung của bạn.</p>
<div class="card" id="status">Chưa kết nối host.</div>
<script>
  window.addEventListener('load', function () {
    window.McpAppBridge.initialize({ name: '${appName}', version: '1.0.0' }).then(function (result) {
      document.getElementById('status').textContent = 'Đã kết nối host v' + result.hostVersion + '.';
    });
  });
</script>`;
  }
}

/**
 * Sinh HTML app v15 từ template. HTML luôn là document đầy đủ,
 * self-contained, có bridge client snippet, MIME profile mcp-app.
 */
export function renderAppTemplateHtml(
  template: UiV15AppTemplate,
  appName: string,
  title?: string,
): string {
  const name = validateSkillNameV15(appName, 'app');
  if (!(UI_V15_APP_TEMPLATES as readonly string[]).includes(template)) {
    throw new McpAppsSkillsV15Error(
      `Template không rõ: "${template}" (phải là một trong: ${UI_V15_APP_TEMPLATES.join(', ')}).`,
      'ui-v15-bad-template',
    );
  }
  return appShellHtml(title ?? name, templateBody(template, name));
}

// ---------------------------------------------------------------------------
// Scaffold / create / add
// ---------------------------------------------------------------------------

/** Tuỳ chọn scaffold app. */
export interface ScaffoldAppOptions {
  appName: string;
  serverName: string;
  template?: UiV15AppTemplate;
  title?: string;
  description?: string;
  version?: string;
  capabilities?: AppManifestV15['capabilities'];
  sandboxProfile?: AppManifestV15['sandboxProfile'];
  cspProfile?: AppManifestV15['cspProfile'];
  toolName?: string;
  author?: string;
}

/** Kết quả scaffold app. */
export interface ScaffoldAppResult {
  appName: string;
  serverName: string;
  template: UiV15AppTemplate;
  resourceUri: string;
  mimeType: string;
  html: string;
  manifest: AppManifestV15;
  files: ScaffoldedFile[];
}

/**
 * Scaffold một app v15 từ template: sinh HTML + manifest v15 +
 * file manifest JSON. Không ghi disk — trả danh sách file.
 */
export function scaffoldApp(options: ScaffoldAppOptions): ScaffoldAppResult {
  const appName = validateSkillNameV15(options.appName, 'app');
  const server = asNonEmptyString(options.serverName);
  if (!server) {
    throw new McpAppsSkillsV15Error('serverName rỗng.', 'ui-v15-bad-server');
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(server)) {
    throw new McpAppsSkillsV15Error(
      `serverName "${server}" không hợp lệ: chỉ chữ thường, số, dấu chấm/gạch ngang/gạch dưới.`,
      'ui-v15-bad-server',
    );
  }
  const template = options.template ?? 'blank';
  const version = validateSemverV15(options.version ?? '1.0.0');
  const resourceUri = `ui://${server}/${appName}`;
  const html = renderAppTemplateHtml(template, appName, options.title);
  // Validate HTML + manifest ngay lúc scaffold để app sinh ra là
  // mở được, không phải sửa tay sau.
  validateAppHtmlV15(resourceUri, html);
  const { manifest } = validateAppManifestV15({
    name: appName,
    version,
    ...(options.description ? { description: options.description } : { description: UI_V15_TEMPLATE_DESCRIPTIONS[template] }),
    server,
    resourceUri,
    capabilities: options.capabilities ?? (template === 'form' || template === 'wizard' ? ['tools-call'] : []),
    sandboxProfile: options.sandboxProfile ?? (template === 'form' || template === 'wizard' ? 'interactive' : 'display-only'),
    cspProfile: options.cspProfile ?? 'strict',
    ...(options.toolName ? { toolName: options.toolName } : {}),
    ...(options.author ? { author: options.author } : {}),
  });
  const files: ScaffoldedFile[] = [
    { path: `apps/${appName}/app.html`, content: html },
    { path: `apps/${appName}/manifest.json`, content: `${JSON.stringify(manifest, null, 2)}\n` },
  ];
  return {
    appName,
    serverName: server,
    template,
    resourceUri,
    mimeType: MCP_APP_PROFILE_MIME_TYPE,
    html,
    manifest,
    files,
  };
}

/** Tuỳ chọn tạo skill mới. */
export interface CreateAppSkillOptions {
  name: string;
  description: string;
  version?: string;
  defaultTemplate?: UiV15AppTemplate;
  defaultServer?: string;
  author?: string;
  /** App mẫu đi kèm skill (mặc định: một app cùng tên skill). */
  sampleAppName?: string;
}

/**
 * Tạo App Skill v15 mới: manifest skill + SKILL.md + app mẫu.
 * SKILL.md mô tả rõ skill làm gì, khi nào dùng, cách scaffold /
 * migrate app, và quy tắc an toàn (consent bắt buộc, HTML
 * self-contained, MIME profile).
 */
export function createAppSkill(options: CreateAppSkillOptions): AppSkillV15 {
  const name = validateSkillNameV15(options.name, 'skill');
  const description = asNonEmptyString(options.description);
  if (!description || description.length < UI_V15_SKILL_DESCRIPTION_MIN_CHARS) {
    throw new McpAppsSkillsV15Error(
      `Mô tả skill tối thiểu ${UI_V15_SKILL_DESCRIPTION_MIN_CHARS} ký tự — mô tả rõ skill này tạo app gì, cho ai dùng.`,
      'ui-v15-skill-description-too-short',
    );
  }
  const version = validateSemverV15(options.version ?? '1.0.0');
  const defaultTemplate = options.defaultTemplate ?? 'dashboard';
  const defaultServer = asNonEmptyString(options.defaultServer) ?? 'local-apps';
  const sampleAppName = validateSkillNameV15(options.sampleAppName ?? name, 'app');
  const sample = scaffoldApp({
    appName: sampleAppName,
    serverName: defaultServer,
    template: defaultTemplate,
    description: `App mẫu của skill ${name}.`,
    version,
    ...(options.author ? { author: options.author } : {}),
  });
  const manifest: AppSkillManifestV15 = {
    name,
    version,
    description,
    defaultTemplate,
    apps: [sampleAppName],
    defaultServer,
    ...(options.author ? { author: options.author } : {}),
  };
  const skillMd = [
    `# ${name}`,
    '',
    description,
    '',
    '## Khi nào dùng skill này',
    '',
    `- Khi user muốn tạo một MCP App mới (dashboard, form, chart, wizard) chạy trong open-bot.`,
    `- Khi user muốn thêm app vào skill đã có, hoặc migrate app v13/v14 lên v15.`,
    '',
    '## Cách dùng',
    '',
    '1. Scaffold app từ template:',
    `   - Template mặc định: \`${defaultTemplate}\` — ${UI_V15_TEMPLATE_DESCRIPTIONS[defaultTemplate]}`,
    `   - Server mặc định: \`${defaultServer}\`, MIME: \`text/html;profile=mcp-app\`.`,
    '2. Đăng ký resource `ui://` rồi đăng ký manifest v15, sau đó khai báo `_meta.ui` cho tool.',
    '3. Mở app qua host v15 — bridge JSON-RPC 2.0 qua postMessage, mọi tools/call đều qua consent.',
    '',
    '## Quy tắc an toàn (bắt buộc)',
    '',
    '- App là code không tin cậy: HTML phải self-contained, không `<base href>` / `<form action>` ra ngoài.',
    '- Mọi action do UI khởi xướng (gọi tool có tác dụng phụ) đều cần user duyệt qua consent — không tự ý gọi.',
    '- Mọi app đều phải có text fallback đầy đủ cho client không render được.',
    '',
    '## App mẫu',
    '',
    `- \`${sampleAppName}\` (${defaultTemplate}) — xem \`apps/${sampleAppName}/app.html\`.`,
    '',
  ].join('\n');
  if (skillMd.length < UI_V15_SKILL_MD_MIN_CHARS) {
    throw new McpAppsSkillsV15Error('SKILL.md sinh ra quá ngắn — kiểm tra lại mô tả skill.', 'ui-v15-skill-md-too-short');
  }
  return {
    manifest,
    skillMd,
    files: [
      { path: 'SKILL.md', content: skillMd },
      { path: 'skill.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
      ...sample.files,
    ],
  };
}

/**
 * Thêm app mới vào skill đã có: scaffold app + cập nhật manifest
 * skill (thêm tên app) + thêm mục app vào SKILL.md. Ném lỗi khi
 * trùng tên app hoặc skill đã đủ số app tối đa.
 */
export function addAppToSkill(
  skill: AppSkillV15,
  options: ScaffoldAppOptions,
): { skill: AppSkillV15; app: ScaffoldAppResult } {
  const appName = validateSkillNameV15(options.appName, 'app');
  if (skill.manifest.apps.includes(appName)) {
    throw new McpAppsSkillsV15Error(
      `Skill "${skill.manifest.name}" đã có app "${appName}" — chọn tên khác hoặc migrate app cũ.`,
      'ui-v15-duplicate-app',
    );
  }
  if (skill.manifest.apps.length >= UI_V15_SKILL_MAX_APPS) {
    throw new McpAppsSkillsV15Error(
      `Skill "${skill.manifest.name}" đã đủ ${UI_V15_SKILL_MAX_APPS} app tối đa.`,
      'ui-v15-skill-full',
    );
  }
  const app = scaffoldApp({
    ...options,
    serverName: options.serverName ?? skill.manifest.defaultServer,
  });
  const manifest: AppSkillManifestV15 = {
    ...skill.manifest,
    apps: [...skill.manifest.apps, appName],
  };
  const appSection = [
    '',
    `## App: ${appName}`,
    '',
    `- Template: \`${app.template}\` — ${UI_V15_TEMPLATE_DESCRIPTIONS[app.template]}`,
    `- Resource: \`${app.resourceUri}\` (MIME \`${app.mimeType}\`)`,
    `- File: \`apps/${appName}/app.html\``,
    '',
  ].join('\n');
  const skillMd = `${skill.skillMd.trimEnd()}\n${appSection}`;
  const files: ScaffoldedFile[] = [
    { path: 'SKILL.md', content: skillMd },
    { path: 'skill.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...skill.files.filter((f) => f.path !== 'SKILL.md' && f.path !== 'skill.json'),
    ...app.files,
  ];
  if (files.length > UI_V15_SCAFFOLD_MAX_FILES * 2) {
    throw new McpAppsSkillsV15Error('Skill đã có quá nhiều file — tách skill mới.', 'ui-v15-skill-full');
  }
  return { skill: { manifest, skillMd, files }, app };
}

// ---------------------------------------------------------------------------
// Migrate v13/v14 → v15
// ---------------------------------------------------------------------------

/** Tuỳ chọn migrate app cũ lên v15. */
export interface MigrateAppOptions {
  /** HTML app cũ (v13/v14). */
  html: string;
  /** ResourceUri của app (giữ nguyên khi migrate). */
  resourceUri: string;
  serverName: string;
  /** Version v15 gán cho app (mặc định 1.0.0). */
  version?: string;
  /** Capability app xin host (mặc định suy ra từ HTML). */
  capabilities?: AppManifestV15['capabilities'];
  /** Tool tạo ra app (nếu biết). */
  toolName?: string;
  /** Phiên bản nguồn: '13' hoặc '14' (để ghi vào changes). */
  fromVersion?: '13' | '14';
}

/**
 * Migrate app v13/v14 lên v15:
 *   1. Validate HTML cũ (document đầy đủ, cấm base/form ra ngoài) —
 *      app không đạt thì từ chối, liệt kê rõ lý do để sửa.
 *   2. Thêm bridge client snippet nếu HTML chưa có `McpAppBridge`.
 *   3. Sinh manifest v15 (capabilities suy ra từ HTML: có
 *      `tools/call` → tools-call, có `open-link` → open-link...).
 *   4. Trả HTML mới + manifest + danh sách thay đổi để user review.
 */
export function migrateAppToV15(options: MigrateAppOptions): MigrateAppResult {
  const changes: string[] = [];
  const warnings: string[] = [];
  const fromVersion = options.fromVersion ?? '14';
  const resourceUri = asNonEmptyString(options.resourceUri);
  if (!resourceUri || !resourceUri.startsWith('ui://')) {
    throw new McpAppsSkillsV15Error(
      `resourceUri migrate phải bắt đầu bằng "ui://" — nhận "${String(options.resourceUri ?? '')}".`,
      'ui-v15-bad-resource-uri',
    );
  }
  const server = asNonEmptyString(options.serverName);
  if (!server) {
    throw new McpAppsSkillsV15Error('serverName rỗng khi migrate.', 'ui-v15-bad-server');
  }
  let html = options.html;
  if (typeof html !== 'string' || html.trim() === '') {
    throw new McpAppsSkillsV15Error('HTML app cũ rỗng — không có gì để migrate.', 'ui-v15-empty-html');
  }
  // Cửa 1: HTML cũ phải đạt chuẩn v15 (document đầy đủ + cấm thoát).
  validateAppHtmlV15(resourceUri, html);
  changes.push(`Đã kiểm tra HTML app v${fromVersion}: document đầy đủ, không có <base href>/<form action> ra ngoài.`);
  // Suy ra capabilities từ HTML cũ khi caller không chỉ định.
  const inferred: AppManifestV15['capabilities'] = [];
  if (/tools\/call|McpAppBridge\.callTool|callTool\(/.test(html)) inferred.push('tools-call');
  if (/ui\/open-link|openLink\(/.test(html)) inferred.push('open-link');
  if (/ui\/post-message|postMessage\(/.test(html)) inferred.push('post-message');
  if (/ui\/update-model-context|updateModelContext\(/.test(html)) inferred.push('model-context');
  if (/ui\/set-display-mode|setDisplayMode|display-mode/.test(html)) inferred.push('display-mode');
  if (/resources\/read|readResource\(/.test(html)) inferred.push('resources-read');
  const capabilities = options.capabilities ?? inferred;
  // Cửa 2: thêm bridge snippet v15 nếu app cũ chưa có.
  const hasBridge = /McpAppBridge|ui\/initialize/.test(html);
  if (!hasBridge) {
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `${UI_V15_BRIDGE_CLIENT_SNIPPET}\n</body>`);
    } else {
      html = `${html}\n${UI_V15_BRIDGE_CLIENT_SNIPPET}`;
    }
    changes.push('Đã thêm bridge client v15 (ui/initialize + tools/call + ui/message + ui/open-link qua postMessage JSON-RPC 2.0).');
  } else {
    changes.push('App đã có bridge client — giữ nguyên, không thêm lại.');
    warnings.push('App cũ đã có bridge client riêng — kiểm tra tay xem nó có nói đúng dialect ui/1.0 không.');
  }
  const appName = resourceUri.split('/').filter(Boolean).pop() ?? 'app';
  const version = validateSemverV15(options.version ?? '1.0.0');
  const sandboxProfile: AppManifestV15['sandboxProfile'] = capabilities.includes('tools-call')
    ? 'interactive'
    : 'display-only';
  const { manifest } = validateAppManifestV15({
    name: appName,
    version,
    description: `App migrate từ v${fromVersion} lên v15.`,
    server,
    resourceUri,
    capabilities,
    sandboxProfile,
    cspProfile: 'strict',
    ...(options.toolName ? { toolName: options.toolName } : {}),
  });
  changes.push(`Đã sinh manifest v15: sandbox "${sandboxProfile}", CSP "strict", capabilities [${capabilities.join(', ') || 'không có'}].`);
  changes.push(`MIME đăng ký: ${MCP_APP_PROFILE_MIME_TYPE}; text fallback bắt buộc giữ nguyên từ v${fromVersion}.`);
  if (capabilities.includes('tools-call')) {
    warnings.push('App gọi tool — sau khi migrate, mọi tools/call đều qua consent bắt buộc của host v15.');
  }
  const files: ScaffoldedFile[] = [
    { path: `apps/${appName}/app.html`, content: html },
    { path: `apps/${appName}/manifest.json`, content: `${JSON.stringify(manifest, null, 2)}\n` },
  ];
  return { html, manifest, files, changes, warnings };
}

// ---------------------------------------------------------------------------
// Validate skill + registry trong bộ nhớ
// ---------------------------------------------------------------------------

/**
 * Validate một App Skill v15 đầy đủ: manifest đúng, SKILL.md đủ
 * dài + nhắc tới app, app mẫu HTML đạt chuẩn + manifest app khớp.
 * Trả errors (chặn) + warnings (không chặn).
 */
export function validateAppSkill(skill: unknown): ValidateAppSkillResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(skill)) {
    return { ok: false, errors: ['Skill phải là object.'], warnings };
  }
  const manifestRaw = skill['manifest'];
  if (!isRecord(manifestRaw)) {
    return { ok: false, errors: ['Skill thiếu manifest.'], warnings };
  }
  try {
    validateSkillNameV15(manifestRaw['name'], 'skill');
    validateSemverV15(manifestRaw['version']);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const description = asNonEmptyString(manifestRaw['description']);
  if (!description || description.length < UI_V15_SKILL_DESCRIPTION_MIN_CHARS) {
    errors.push(`Mô tả skill tối thiểu ${UI_V15_SKILL_DESCRIPTION_MIN_CHARS} ký tự.`);
  }
  const apps = manifestRaw['apps'];
  if (!Array.isArray(apps) || apps.length === 0) {
    errors.push('Skill phải có ít nhất 1 app trong manifest.apps.');
  } else if (apps.length > UI_V15_SKILL_MAX_APPS) {
    errors.push(`Skill tối đa ${UI_V15_SKILL_MAX_APPS} app.`);
  }
  const skillMd = skill['skillMd'];
  if (typeof skillMd !== 'string' || skillMd.length < UI_V15_SKILL_MD_MIN_CHARS) {
    errors.push(`SKILL.md tối thiểu ${UI_V15_SKILL_MD_MIN_CHARS} ký tự.`);
  } else {
    if (!/consent/i.test(skillMd)) {
      warnings.push('SKILL.md không nhắc tới consent — nên ghi rõ quy tắc consent cho người dùng skill.');
    }
    if (Array.isArray(apps)) {
      for (const app of apps) {
        if (typeof app === 'string' && !skillMd.includes(app)) {
          warnings.push(`SKILL.md không nhắc tới app "${app}".`);
        }
      }
    }
  }
  const files = skill['files'];
  if (!Array.isArray(files) || files.length === 0) {
    errors.push('Skill thiếu files (cần SKILL.md + app mẫu).');
  } else {
    for (const file of files as unknown[]) {
      if (!isRecord(file) || typeof file['path'] !== 'string' || typeof file['content'] !== 'string') {
        errors.push('File trong skill phải có { path, content } là chuỗi.');
        break;
      }
    }
    const htmlFiles = (files as ScaffoldedFile[]).filter((f) => f.path.endsWith('.html'));
    if (htmlFiles.length === 0) {
      errors.push('Skill thiếu file app .html mẫu.');
    }
    for (const file of htmlFiles) {
      try {
        const uri = `ui://skill/${file.path.split('/')[1] ?? 'app'}`;
        validateAppHtmlV15(uri, file.content);
      } catch (err) {
        errors.push(`App mẫu ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Registry skill trong bộ nhớ: đăng ký / lấy / liệt kê skill đã
 * validate. Host v15 dùng registry này để agent gọi skill tạo app.
 */
export class McpAppSkillsRegistryV15 {
  private readonly skills = new Map<string, AppSkillV15>();

  /** Số skill đã đăng ký. */
  get size(): number {
    return this.skills.size;
  }

  /** Đăng ký skill (validate trước; ném lỗi khi skill không đạt). */
  register(skill: AppSkillV15): AppSkillV15 {
    const check = validateAppSkill(skill);
    if (!check.ok) {
      throw new McpAppsSkillsV15Error(
        `Skill "${skill.manifest.name}" không đạt validate: ${check.errors.join(' | ')}`,
        'ui-v15-invalid-skill',
      );
    }
    this.skills.set(skill.manifest.name, skill);
    return skill;
  }

  get(name: string): AppSkillV15 | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  unregister(name: string): boolean {
    return this.skills.delete(name);
  }

  list(): AppSkillManifestV15[] {
    return [...this.skills.values()]
      .map((s) => s.manifest)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Scaffold app bằng skill đã đăng ký (template mặc định của skill). */
  scaffoldWithSkill(
    skillName: string,
    options: Omit<ScaffoldAppOptions, 'template'> & { template?: UiV15AppTemplate },
  ): ScaffoldAppResult {
    const skill = this.skills.get(skillName);
    if (!skill) {
      throw new McpAppsSkillsV15Error(
        `Skill "${skillName}" chưa đăng ký — đăng ký skill trước rồi mới scaffold app.`,
        'ui-v15-skill-not-found',
      );
    }
    return scaffoldApp({
      ...options,
      template: options.template ?? skill.manifest.defaultTemplate,
      serverName: options.serverName ?? skill.manifest.defaultServer,
    });
  }
}
