/**
 * Test v1.14 T2: MCP Apps v2 — gallery/template + CSP bundler +
 * permissions mic/camera + component kit v2 (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v2-gallery-bundle-permissions.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findGalleryTemplate,
  listGalleryTemplates,
  renderGalleryTemplate,
  summarizeGallery,
  validateGalleryInput,
  GalleryTemplateError,
  MCP_APP_GALLERY_TEMPLATES,
} from '../packages/core/dist/mcp/appsGalleryV2.js';
import { renderAppComponents } from '../packages/core/dist/mcp/appsComponents.js';
import {
  bundleMcpApp,
  buildCspForApp,
  buildPermissionsPolicyHeader,
  normalizeAllowedConnectHost,
  stripExternalReferences,
  AppBundleError,
} from '../packages/core/dist/mcp/appsBundlerV2.js';
import {
  describePermissionDecision,
  McpAppPermissionsV2,
  parseUiPermissions,
} from '../packages/core/dist/mcp/appsPermissionsV2.js';
import {
  assertValidAppComponentV2,
  renderAppComponentV2,
  renderAppComponentsV2,
  validateAppComponentV2,
  AppComponentV2Error,
} from '../packages/core/dist/mcp/appsComponentsV2.js';

// ---------------------------------------------------------------------------
// Gallery + templates
// ---------------------------------------------------------------------------

test('gallery: 4 templates, one per kind', () => {
  assert.equal(MCP_APP_GALLERY_TEMPLATES.length, 4);
  assert.deepEqual(
    MCP_APP_GALLERY_TEMPLATES.map((t) => t.kind),
    ['dashboard', 'form', 'chart', 'wizard'],
  );
  assert.equal(summarizeGallery().length, 4);
  assert.equal(listGalleryTemplates('chart').length, 1);
  assert.equal(listGalleryTemplates('chart')[0].id, 'chart');
  for (const template of MCP_APP_GALLERY_TEMPLATES) {
    assert.equal(validateGalleryInput(template, template.exampleInput).length, 0);
  }
});

test('gallery: validate rejects bad input with clear errors', () => {
  const template = findGalleryTemplate('chart');
  assert.ok(template);
  const errors = validateGalleryInput(template, { title: 'x' });
  assert.ok(errors.some((e) => e.startsWith('labels:')));
  assert.ok(errors.some((e) => e.startsWith('values:')));
  const badKind = validateGalleryInput(template, {
    title: 'x',
    kind: 'pie',
    labels: ['a'],
    values: [1],
  });
  assert.ok(badKind.some((e) => e.includes('bar, line')));
  assert.throws(
    () => renderGalleryTemplate('nope', {}),
    (err) => err instanceof GalleryTemplateError,
  );
  assert.throws(() => renderGalleryTemplate('chart', { title: 'x' }), /không hợp lệ/);
});

test('gallery: dashboard renders metrics + chart + table', () => {
  const { components } = renderGalleryTemplate(
    'dashboard',
    findGalleryTemplate('dashboard').exampleInput,
  );
  const html = renderAppComponents(components);
  assert.ok(html.includes('Task hoàn thành'));
  assert.ok(html.includes('Đồng bộ Gmail'));
  assert.equal(components[0].type, 'grid');
});

test('gallery: form renders a form component for the declared tool', () => {
  const { components } = renderGalleryTemplate('form', findGalleryTemplate('form').exampleInput);
  assert.equal(components.length, 1);
  assert.equal(components[0].type, 'form');
  assert.equal(components[0].tool, 'mcp_tasks_v2_poll');
  assert.equal(components[0].fields.length, 3);
});

test('gallery: chart renders chart + data table with matching rows', () => {
  const { components } = renderGalleryTemplate('chart', findGalleryTemplate('chart').exampleInput);
  assert.equal(components[0].type, 'chart-placeholder');
  assert.equal(components[0].kind, 'line');
  assert.equal(components[1].type, 'table');
  assert.equal(components[1].rows.length, 6);
  assert.equal(components[1].rows[0][0], '00:00');
});

test('gallery: wizard renders current step form + progress card', () => {
  const example = findGalleryTemplate('wizard').exampleInput;
  const first = renderGalleryTemplate('wizard', example);
  assert.equal(first.components[0].type, 'card');
  assert.match(first.components[0].title, /bước 1\/3/);
  assert.equal(first.components[1].type, 'form');
  assert.equal(first.components[1].title, 'Bước 1 — Thông tin server');
  assert.equal(first.components[1].submitLabel, 'Tiếp tục');
  const last = renderGalleryTemplate('wizard', { ...example, currentStep: 2 });
  assert.equal(last.components[1].submitLabel, 'Hoàn tất');
  // currentStep vượt quá -> kẹp về bước cuối.
  const clamped = renderGalleryTemplate('wizard', { ...example, currentStep: 99 });
  assert.equal(clamped.components[1].submitLabel, 'Hoàn tất');
});

// ---------------------------------------------------------------------------
// CSP builder + single-file bundler
// ---------------------------------------------------------------------------

test('bundler: CSP deny-by-default, network closed without permission', () => {
  const csp = buildCspForApp({}, []);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  const open = buildCspForApp({ network: true }, ['api.example.com', '*.cdn.example.com']);
  assert.match(open, /connect-src https:\/\/api\.example\.com https:\/\/\*\.cdn\.example\.com/);
  // Host không hợp lệ bị bỏ qua.
  const cleaned = buildCspForApp({ network: true }, ['not a host', 'ok.example.com']);
  assert.match(cleaned, /connect-src https:\/\/ok\.example\.com/);
  assert.equal(normalizeAllowedConnectHost('Example.COM'), 'example.com');
  assert.equal(normalizeAllowedConnectHost('a/b'), undefined);
});

test('bundler: Permissions-Policy follows granted mic/camera only', () => {
  const none = buildPermissionsPolicyHeader({});
  assert.match(none, /microphone=\(\)/);
  assert.match(none, /camera=\(\)/);
  const both = buildPermissionsPolicyHeader({ microphone: true, camera: true });
  assert.match(both, /microphone=\(self\)/);
  assert.match(both, /camera=\(self\)/);
});

test('bundler: strips external refs and inlines css/js into one file', () => {
  const bundle = bundleMcpApp({
    html: '<!doctype html><html><head><script src="https://evil.example.com/x.js"></script><link href="https://cdn.example.com/a.css"></head><body><img src="https://img.example.com/a.png"><h1>Hi</h1></body></html>',
    css: ['h1{color:red}'],
    js: ['document.title="x";'],
    permissions: { network: false },
  });
  assert.ok(!bundle.html.includes('evil.example.com'));
  assert.ok(!bundle.html.includes('cdn.example.com'));
  assert.ok(!bundle.html.includes('img.example.com'));
  assert.ok(bundle.html.includes('h1{color:red}'));
  assert.ok(bundle.html.includes('document.title'));
  assert.ok(bundle.html.includes('Content-Security-Policy'));
  assert.ok(bundle.warnings.length >= 3);
  assert.ok(bundle.sizeBytes > 0);
  assert.match(bundle.csp, /connect-src 'none'/);
});

test('bundler: bare fragment gets a shell; oversize bundle throws', () => {
  const bundle = bundleMcpApp({ html: '<p>hello</p>' });
  assert.ok(bundle.html.includes('<!doctype html>'));
  assert.ok(bundle.html.includes('<p>hello</p>'));
  assert.throws(
    () => bundleMcpApp({ html: `<p>${'x'.repeat(600 * 1024)}</p>` }),
    (err) => err instanceof AppBundleError,
  );
  assert.throws(() => bundleMcpApp({ html: '' }), /bắt buộc/);
  assert.throws(
    () => bundleMcpApp({ html: '<p>x</p>', allowedConnectHosts: ['bad host'] }),
    /không hợp lệ/,
  );
});

test('bundler: stripExternalReferences reports what it removed', () => {
  const { html, warnings } = stripExternalReferences(
    '<style>@import url("https://fonts.example.com/x.css"); a{background:url(https://i.example.com/a.png)}</style><p>ok</p>',
  );
  assert.ok(!html.includes('fonts.example.com'));
  assert.ok(warnings.some((w) => w.includes('@import')));
  assert.ok(warnings.some((w) => w.includes('url(http')));
});

// ---------------------------------------------------------------------------
// Permissions mic/camera per app
// ---------------------------------------------------------------------------

const APP_URI = 'ui://demo-server/dashboard';

test('permissions: default is prompt; grant/deny remembered or session-only', () => {
  const store = new McpAppPermissionsV2();
  assert.equal(store.check(APP_URI, 'microphone'), 'prompt');
  assert.equal(store.requestPermission(APP_URI, 'camera').decision, 'prompt');
  store.setDecision(APP_URI, 'microphone', 'granted', { remember: true });
  assert.equal(store.check(APP_URI, 'microphone'), 'granted');
  assert.deepEqual(store.grantedPermissions(APP_URI), ['microphone']);
  // Session-only grant: có hiệu lực nhưng không lưu bền.
  store.setDecision(APP_URI, 'camera', 'denied');
  assert.equal(store.check(APP_URI, 'camera'), 'denied');
  assert.equal(store.rememberedCount, 1);
  assert.equal(store.permissionsForApp(APP_URI).length, 2);
});

test('permissions: revoke one kind or all; invalid uri throws', () => {
  const store = new McpAppPermissionsV2();
  store.setDecision(APP_URI, 'microphone', 'granted', { remember: true });
  store.setDecision(APP_URI, 'camera', 'granted', { remember: true });
  assert.equal(store.revoke(APP_URI, 'microphone'), 1);
  assert.equal(store.check(APP_URI, 'microphone'), 'prompt');
  assert.equal(store.check(APP_URI, 'camera'), 'granted');
  assert.equal(store.revoke(APP_URI), 1);
  assert.equal(store.check(APP_URI, 'camera'), 'prompt');
  assert.throws(() => store.check('https://example.com/x', 'microphone'), /không hợp lệ/);
});

test('permissions: remembered decisions persist to disk and reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-perms-v2-'));
  try {
    const first = new McpAppPermissionsV2({ userDataDir: dir });
    first.setDecision(APP_URI, 'camera', 'granted', { remember: true });
    first.setDecision(APP_URI, 'microphone', 'denied', { remember: true });
    const second = new McpAppPermissionsV2({ userDataDir: dir });
    assert.equal(second.check(APP_URI, 'camera'), 'granted');
    assert.equal(second.check(APP_URI, 'microphone'), 'denied');
    assert.equal(second.rememberedCount, 2);
    second.clearAll();
    const third = new McpAppPermissionsV2({ userDataDir: dir });
    assert.equal(third.check(APP_URI, 'camera'), 'prompt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('permissions: parse _meta.ui.permissions + describe decisions', () => {
  assert.deepEqual(parseUiPermissions(['microphone', 'camera', 'geolocation']), [
    'microphone',
    'camera',
  ]);
  assert.deepEqual(parseUiPermissions('microphone'), []);
  assert.equal(describePermissionDecision('microphone', 'granted'), 'Đã cho phép dùng microphone.');
  assert.equal(describePermissionDecision('camera', 'denied'), 'Đã từ chối dùng camera.');
  assert.match(describePermissionDecision('camera', 'prompt'), /Chưa quyết định/);
});

// ---------------------------------------------------------------------------
// Component kit v2
// ---------------------------------------------------------------------------

test('components v2: validate every type + render escapes user text', () => {
  const samples = [
    { type: 'button', label: 'Gửi', action: { label: 'Gửi', tool: 'demo_tool' }, variant: 'primary' },
    { type: 'textInput', name: 'q', label: 'Tìm kiếm', placeholder: 'gõ…' },
    { type: 'select', name: 'p', label: 'Ưu tiên', options: [{ value: 'low', label: 'Thấp' }, { value: 'high', label: 'Cao' }], selected: 'high' },
    { type: 'toggle', name: 'net', label: 'Mạng', checked: true, description: 'Cho phép mạng' },
    { type: 'progressBar', label: 'Tiến độ', value: 3, max: 4, showPercent: true },
    { type: 'badge', text: 'Mới', tone: 'success' },
    { type: 'modal', id: 'm1', title: 'Xác nhận', body: 'Chắc chắn?', actions: [{ label: 'OK', tool: 'demo_tool' }] },
    { type: 'toast', message: 'Đã lưu', tone: 'success', durationMs: 3000 },
    { type: 'tabs', tabs: [{ id: 'a', label: 'A', content: 'Nội dung A' }, { id: 'b', label: 'B', content: 'Nội dung B' }], activeTab: 'b' },
  ];
  for (const sample of samples) {
    assert.deepEqual(validateAppComponentV2(sample), [], JSON.stringify(sample));
    const html = renderAppComponentV2(sample);
    assert.ok(html.length > 0);
  }
  // XSS: text user nhập được escape.
  const evil = renderAppComponentV2({ type: 'badge', text: '<script>alert(1)</script>' });
  assert.ok(!evil.includes('<script>alert'));
  assert.ok(evil.includes('&lt;script&gt;'));
  const evilToast = renderAppComponentV2({ type: 'toast', message: '<img src=x onerror=alert(1)>' });
  assert.ok(!evilToast.includes('<img'));
});

test('components v2: validation errors are specific', () => {
  assert.ok(validateAppComponentV2({ type: 'button' }).some((e) => e.includes('label')));
  assert.ok(validateAppComponentV2({ type: 'button', label: 'x' }).some((e) => e.includes('action')));
  assert.ok(
    validateAppComponentV2({ type: 'progressBar', label: 'x', value: 5, max: 4 }).some((e) =>
      e.includes('vượt max'),
    ),
  );
  assert.ok(
    validateAppComponentV2({ type: 'select', name: 's', label: 'S', options: [], selected: 'z' }).length >= 1,
  );
  assert.ok(
    validateAppComponentV2({ type: 'tabs', tabs: [{ id: 'a', label: 'A', content: 'x' }], activeTab: 'nope' }).some((e) =>
      e.includes('activeTab'),
    ),
  );
  assert.ok(validateAppComponentV2({ type: 'nope' }).some((e) => e.includes('không hỗ trợ')));
  assert.throws(
    () => assertValidAppComponentV2({ type: 'toast' }),
    (err) => err instanceof AppComponentV2Error,
  );
});

test('components v2: render list includes kit CSS unless disabled; cap enforced', () => {
  const html = renderAppComponentsV2([
    { type: 'button', label: 'A', action: { label: 'A', tool: 't' } },
    { type: 'badge', text: 'B' },
  ]);
  assert.ok(html.includes('.ob-btn'));
  assert.ok(html.includes('>A<'));
  const noCss = renderAppComponentsV2(
    [{ type: 'badge', text: 'B' }],
    { includeCss: false },
  );
  assert.ok(!noCss.includes('.ob-btn'));
  const tooMany = Array.from({ length: 101 }, (_, i) => ({
    type: 'badge',
    text: `b${i}`,
  }));
  assert.throws(() => renderAppComponentsV2(tooMany), /Tối đa 100/);
});
